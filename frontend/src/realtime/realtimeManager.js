// RealtimeManager — único ponto do frontend que fala com a infraestrutura de
// Realtime (credencial, canais privados, renovação, reconexão). Nenhum outro
// módulo deve chamar `sb.channel(...)`/`sb.realtime.setAuth(...)` diretamente
// — quem quiser reagir a um evento usa `realtimeBus.registrarInteresse`
// (ver realtimeBus.js); quem quiser saber a taxonomia usa realtimeEvents.js.
//
// TROCA DE CONTEXTO — reaproveita `contextoEscopo.js`, não cria um segundo
// mecanismo de detecção (exigência explícita da aprovação da Etapa 1):
//   * `registrarResetDeContexto` é o MESMO funil que login, F5, troca de
//     unidade/empresa e impersonação já usam (chamado por app.js#mostrarApp,
//     depois que `state.sessao` já tem o contexto NOVO) — a cada disparo,
//     desliga a conexão anterior e conecta para o contexto atual.
//   * cada ciclo de conexão guarda a `geracaoContexto()` do momento em que
//     começou; toda continuação assíncrona (resposta da credencial, timer de
//     renovação, mensagem de canal) confere `contextoMudou(g)` antes de agir
//     — um evento ou uma renovação que chegue depois de outra troca de
//     contexto é descartado, nunca aplicado (mesma disciplina de
//     app.js#mostrarApp e sessao.js).
//
// LOGOUT / CONTEXTO INVÁLIDO — escuta os eventos DOM que sessao.js/app.js já
// disparam (app:logout, app:contexto-invalido) em vez de inventar um terceiro
// caminho de desligamento.
//
// RENOVAÇÃO E REVOGAÇÃO — o GRANT do backend dura pouco (config do backend,
// default 5 min). O RealtimeManager renova sozinho ~60s antes de expirar; se
// o backend recusar a renovação (contexto revogado/expirado/trocado do lado
// do servidor), desliga TUDO na hora — nunca fica tentando de novo sozinho
// nem mantém canais vivos além do que o grant atual autoriza.
//
// AUTENTICAÇÃO NO REALTIME — decisão final registrada (ver database/
// migrations/080_realtime_channel_grants.sql): o projeto usa JWT Signing
// Keys assimétricas no Supabase Auth, então NUNCA assinamos um token
// customizado. O cliente usa o MESMO JWT normal da sessão Supabase Auth
// (`tokenAtual()`) — `setAuth()` só repassa esse token pro socket do
// Realtime, nunca substitui nem interfere em `sb.auth`. A autorização por
// tópico vem de um GRANT que o backend grava em
// `public.realtime_channel_grants` (POST /api/v1/realtime/credencial,
// nome mantido — o que muda é o que ele devolve: `{topicos, expiraEm}`,
// nunca mais um `token`).
//
// Um gotcha documentado do supabase-js: o Realtime NÃO resincroniza sozinho
// quando a sessão Auth normal renova — por isso `iniciar()` também escuta
// `sb.auth.onAuthStateChange` e reaplica o token atual no Realtime a cada
// renovação, além de reaplicar em toda renovação de grant deste manager.
//
// Etapa 1: infraestrutura completa e testada. Nenhum módulo de tela ainda
// chama `registrarInteresse` — a ligação do Dashboard iFood é a Etapa 2.

import { state } from "../state.js";
import { http } from "../sessao.js";
import { getSupabase, tokenAtual } from "../supabaseClient.js";
import { registrarResetDeContexto, geracaoContexto, contextoMudou } from "../contextoEscopo.js";
import { receberEvento } from "./realtimeBus.js";
import { RESINCRONIZACAO } from "./realtimeEvents.js";

const DEV = typeof location !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
/** Log só em dev — produção não deve despejar tópico/status a cada evento. */
function log(...args) { if (DEV) console.debug("[Realtime]", ...args); }

async function solicitarCredencialReal() {
  try {
    const { data } = await http.post("/api/v1/realtime/credencial");
    return data; // { topicos, expiraEm, validadeS } — nunca mais um token
  } catch (e) {
    log("grant recusado:", e.message);
    return null;
  }
}

/** Dependências injetáveis SÓ para teste — produção sempre usa as reais. */
let deps = {
  obterCliente: getSupabase,
  solicitarCredencial: solicitarCredencialReal,
  obterTokenAuth: tokenAtual,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};
export function _injetarDependenciasParaTeste(overrides) { deps = { ...deps, ...overrides }; }
export function _restaurarDependenciasReais() {
  deps = {
    obterCliente: getSupabase, solicitarCredencial: solicitarCredencialReal, obterTokenAuth: tokenAtual,
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id),
  };
}

let iniciado = false;
/** @type {Map<string, {canal: object, jaSubscrito: boolean}>} tópico -> canal ativo */
let canais = new Map();
let timerRenovacao = null;
/** Geração de contexto (contextoEscopo.js) à qual a conexão ATUAL pertence, ou `null` se desconectado. */
let geracaoConectada = null;

function limparTimer() {
  if (timerRenovacao != null) { deps.clearTimeout(timerRenovacao); timerRenovacao = null; }
}

/**
 * Repassa o JWT normal da sessão Supabase Auth pro socket do Realtime.
 * Nunca lê/altera nada em `sb.auth` — só chama `sb.realtime.setAuth(token)`
 * com o access_token que já existe. Sem sessão (usuário deslogado no meio do
 * caminho), não faz nada — `desligarTudo()` é quem encerra os canais.
 */
async function aplicarAuthAtual(sb) {
  const token = await deps.obterTokenAuth();
  if (token) sb.realtime.setAuth(token);
}

function escopoDoTopico(topico, ctx) {
  return topico.startsWith("unidade:")
    ? { organizacaoId: ctx.organizacaoId, unidadeId: ctx.unidadeId }
    : { organizacaoId: ctx.organizacaoId, unidadeId: null };
}

function assinarCanal(sb, topico, g, ctx) {
  const canal = sb.channel(topico, { config: { private: true } });
  const entrada = { canal, jaSubscrito: false };

  canal.on("broadcast", { event: "evento_dominio" }, ({ payload }) => {
    if (contextoMudou(g)) return; // evento de um contexto que já não é o atual — descartado
    receberEvento(payload);
  });

  canal.subscribe((status) => {
    if (contextoMudou(g)) return;
    if (status === "SUBSCRIBED") {
      if (entrada.jaSubscrito) {
        // Reconexão de verdade (não a primeira vez neste ciclo) — Fase S/T:
        // nunca confiar que os broadcasts perdidos durante a queda chegaram.
        // Sinaliza resincronização; quem estiver interessado nesse escopo
        // trata como "refaça o fetch", igual a um evento de domínio real.
        const escopo = escopoDoTopico(topico, ctx);
        log("reconectado —", topico, "— resincronizando");
        receberEvento({ tipo: RESINCRONIZACAO, ...escopo });
      } else {
        log("subscrito —", topico);
      }
      entrada.jaSubscrito = true;
    } else {
      log("status do canal", topico, "=", status);
    }
  });

  canais.set(topico, entrada);
}

/** Encerra toda conexão Realtime atual — canais, timer de renovação, credencial. Idempotente; nunca lança. */
export async function desligarTudo() {
  limparTimer();
  geracaoConectada = null;
  if (!canais.size) return;
  try {
    const sb = await deps.obterCliente();
    for (const { canal } of canais.values()) {
      try { sb.removeChannel(canal); } catch (e) { log("falha ao remover canal (ignorando):", e.message); }
    }
  } catch (e) {
    log("falha ao obter cliente Realtime pra desligar (ignorando):", e.message);
  }
  canais.clear();
  log("desconectado");
}

function agendarRenovacao(g, validadeS) {
  limparTimer();
  // Renova ~60s antes de expirar; nunca antes de 30s (credenciais muito
  // curtas não podem virar um loop de renovação sem folga nenhuma).
  const atrasoS = Math.max(30, (Number(validadeS) || 300) - 60);
  timerRenovacao = deps.setTimeout(() => renovar(g), atrasoS * 1000);
}

async function renovar(g) {
  if (contextoMudou(g)) return; // um novo ciclo de conexão já assumiu — este renovador está obsoleto
  const credencial = await deps.solicitarCredencial();
  if (contextoMudou(g)) return;

  if (!credencial) {
    // Backend recusou renovar -> requireContexto não validou mais este
    // contexto (revogado, expirado, empresa/unidade removida, perfil
    // trocado...). Não insiste sozinho: desliga tudo agora. Um contexto novo
    // só volta a existir via troca real (resetarEscopoDeContexto) ou login.
    log("renovação recusada — encerrando Realtime deste contexto");
    await desligarTudo();
    return;
  }

  let sb;
  try { sb = await deps.obterCliente(); } catch { return; }
  if (contextoMudou(g)) return;

  await aplicarAuthAtual(sb);
  if (contextoMudou(g)) return;
  agendarRenovacao(g, credencial.validadeS);
  log("grant renovado");
}

/**
 * Conecta (ou reconecta) para o contexto ATUAL de `state.sessao`. Sempre
 * desliga qualquer conexão anterior primeiro. Sem contexto (`empresa` nulo),
 * fica desconectado — Realtime é dispensável, o app funciona igual sem ele.
 * Nunca lança: qualquer falha de rede/credencial só deixa o app sem Realtime
 * (degrada, não quebra).
 */
export async function conectarParaContextoAtual() {
  const g = geracaoContexto();
  await desligarTudo();

  const { empresa, unidade } = state.sessao;
  if (!empresa?.id) { log("sem contexto — Realtime fica desconectado"); return; }

  const credencial = await deps.solicitarCredencial();
  if (contextoMudou(g)) { log("contexto mudou durante a solicitação do grant — descartado"); return; }
  if (!credencial) { log("sem grant — Realtime indisponível para este contexto agora"); return; }

  let sb;
  try { sb = await deps.obterCliente(); } catch (e) { log("falha ao obter cliente Realtime:", e.message); return; }
  if (contextoMudou(g)) return;

  await aplicarAuthAtual(sb);
  if (contextoMudou(g)) return;
  const ctx = { organizacaoId: empresa.id, unidadeId: unidade?.id ?? null };
  for (const topico of credencial.topicos ?? []) {
    assinarCanal(sb, topico, g, ctx);
  }
  geracaoConectada = g;
  agendarRenovacao(g, credencial.validadeS);
  log("conectado — tópicos:", credencial.topicos);
}

/**
 * Liga os gatilhos de troca de contexto/logout — chame UMA VEZ no boot do
 * app (idempotente). Não conecta nada sozinho: a primeira conexão acontece
 * quando `resetarEscopoDeContexto()` disparar pela primeira vez (login,
 * F5, impersonação — o funil já existente de app.js#mostrarApp).
 */
export function iniciar() {
  if (iniciado) return;
  iniciado = true;
  registrarResetDeContexto(() => { conectarParaContextoAtual(); });
  document.addEventListener("app:logout", () => { desligarTudo(); });
  document.addEventListener("app:contexto-invalido", () => { desligarTudo(); });

  // Gotcha conhecido do supabase-js: o Realtime não resincroniza sozinho
  // quando a sessão Auth normal renova — reaplica explicitamente. Só LÊ o
  // evento (nunca chama sb.auth.signOut/signIn/refresh) — não interfere no
  // fluxo normal de autenticação, só mantém o socket do Realtime a par do
  // token mais recente. Sem canal ativo (geracaoConectada nulo), não há o
  // que reaplicar — barato de checar, nunca conecta nada por conta própria.
  (async () => {
    try {
      const sb = await deps.obterCliente();
      sb.auth.onAuthStateChange((_evento, sessao) => {
        if (sessao?.access_token && geracaoConectada != null) {
          sb.realtime.setAuth(sessao.access_token);
          log("token de sessão renovado — reaplicado no Realtime");
        }
      });
    } catch (e) {
      log("falha ao observar renovação de sessão (ignorando):", e.message);
    }
  })();
}

/** Só para teste/depuração: tópicos com canal ativo agora. */
export function _topicosAtivos() {
  return [...canais.keys()];
}

/** Só para teste: a conexão atual pertence a esta geração de contexto (ou null se desconectado). */
export function _geracaoConectada() {
  return geracaoConectada;
}

/**
 * Só para teste: reseta o estado de CONEXÃO entre casos de teste (canais,
 * timer, geração). Nunca reseta `iniciado` — `contextoEscopo.js` não tem como
 * "desregistrar" um callback (registrarResetDeContexto só empilha), então
 * `iniciar()` deve ser chamado UMA vez por arquivo de teste, nunca por caso.
 */
export async function _resetParaTeste() {
  await desligarTudo();
}
