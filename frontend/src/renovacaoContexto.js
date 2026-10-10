// Renovação AUTOMÁTICA do contexto — só do perfil de exibição (computador da TV, expediente de ~17 h).
//
// O servidor decide TUDO (backend: POST /api/v1/sessao/renovar → sessao.renovacao.service.js): elegibilidade, janela,
// limite absoluto desde o LOGIN, revalidação de vínculos/permissões, concorrência e auditoria. Aqui só se AGENDA o
// pedido e se ADOTA a resposta sem atrapalhar a tela:
//
//   * preventiva: pede ~1 h antes do vencimento (com um espalhamento aleatório, para as TVs de uma rede não pedirem
//     juntas), medindo o tempo pelo RELÓGIO DO SERVIDOR (offset recebido com o prazo), não pelo do aparelho;
//   * adota o token novo SEM subir a "geração" do contexto: o Modo Televisão, o polling e a tela cheia seguem como
//     estão (ver sessao.js#aplicarRenovacao);
//   * falha de rede/servidor: tenta de novo com espera crescente enquanto o contexto atual ainda vale;
//   * 401 (login caiu / limite absoluto) e 409 (contexto caiu) seguem o caminho de sempre da Central (login /
//     reentrada) — aqui só se PARA de agendar;
//   * 403 (renovação não disponível para esta conta/autenticação): para de tentar; vale o comportamento antigo (8 h).
//
// O que está agendado vive só nesta aba; nada é persistido.
import { state } from "./state.js";
import { ehPerfilExibicao } from "./perfilExibicao.js";
import { renovarContextoNoServidor, aplicarRenovacao } from "./sessao.js";

/** Pede a renovação quando falta cerca de 1 h para o contexto vencer. */
export const ANTECEDENCIA_MS = 60 * 60_000;
/** Espalhamento (aleatório, para MENOS antecedência não: sempre ANTES) somado à antecedência. */
export const ESPALHAMENTO_MAX_MS = 5 * 60_000;
/** Esperas entre tentativas quando a renovação falha por rede/servidor. O último valor se repete. */
export const ESPERAS_MS = Object.freeze([30_000, 60_000, 2 * 60_000, 5 * 60_000]);
/** Se o servidor responder "cedo" (relógio diferente do esperado), não insiste antes disto. */
export const MINIMO_ENTRE_PEDIDOS_MS = 5 * 60_000;

/** Quanto esperar (ms, no relógio LOCAL) até pedir a renovação. 0 = já. Função pura. */
export function planejarRenovacao({ expiraEmMs, agoraLocalMs, offsetMs = 0, antecedenciaMs = ANTECEDENCIA_MS, espalhamentoMs = 0 }) {
  if (!Number.isFinite(expiraEmMs)) return null;
  const agoraServidor = agoraLocalMs + offsetMs;
  return Math.max(0, expiraEmMs - antecedenciaMs - espalhamentoMs - agoraServidor);
}

/** Espera (ms) antes da n-ésima tentativa depois de uma falha (n começa em 1). */
export const esperaDaTentativa = (falhas) => ESPERAS_MS[Math.min(Math.max(1, falhas), ESPERAS_MS.length) - 1];

/**
 * Controlador da renovação, com tudo o que é do mundo injetável (relógio, timers, chamadas) para testar uma jornada
 * de 17 h em milissegundos.
 * @param {{
 *   sessao: () => any, renovar: () => Promise<any>, aplicar: (dados: any) => void,
 *   agora?: () => number, setT?: Function, clearT?: Function, aleatorio?: () => number, log?: (m: string) => void,
 * }} deps
 */
export function criarRenovador({ sessao, renovar, aplicar, agora = () => Date.now(), setT = setTimeout, clearT = clearTimeout, aleatorio = Math.random, log = () => {} }) {
  let timer = null;
  let emVoo = false;
  let ativo = false;
  let falhas = 0;
  const contagem = { pedidos: 0, renovacoes: 0, cedo: 0, falhas: 0 };

  const prazo = () => {
    const s = sessao();
    return { expiraEmMs: Date.parse(s?.expiraEm), offsetMs: Number(s?.relogioOffsetMs) || 0 };
  };
  const limpar = () => { if (timer !== null) { clearT(timer); timer = null; } };
  const parar = () => { ativo = false; falhas = 0; limpar(); };

  function agendar({ emMsFixo = null } = {}) {
    limpar();
    if (!ativo || !ehPerfilExibicao(sessao())) return;
    const { expiraEmMs, offsetMs } = prazo();
    const plano = emMsFixo ?? planejarRenovacao({ expiraEmMs, agoraLocalMs: agora(), offsetMs, espalhamentoMs: aleatorio() * ESPALHAMENTO_MAX_MS });
    if (plano === null) return;
    timer = setT(() => { timer = null; void executar(); }, plano);
  }

  async function executar() {
    if (!ativo || emVoo) return;
    if (!ehPerfilExibicao(sessao())) return;
    emVoo = true; contagem.pedidos += 1;
    try {
      const dados = await renovar();
      if (!ativo) return;
      falhas = 0;
      if (dados?.renovado) {
        try { aplicar(dados); } catch (e) {               // troca token+prazo, sem fechar nada; identidade diferente = NÃO adota
          contagem.falhas += 1; log(`renovação não adotada: ${e?.message}`); parar(); return;
        }
        contagem.renovacoes += 1;
        agendar();
      } else {
        // "cedo": o servidor acha que ainda não é hora. Guarda o prazo/relógio que ele informou e não insiste já.
        contagem.cedo += 1;
        const s = sessao();
        if (dados?.expiraEm) s.expiraEm = dados.expiraEm;
        const servidor = Date.parse(dados?.servidorEm);
        if (Number.isFinite(servidor)) s.relogioOffsetMs = servidor - agora();
        const { expiraEmMs, offsetMs } = prazo();
        const plano = planejarRenovacao({ expiraEmMs, agoraLocalMs: agora(), offsetMs });
        agendar({ emMsFixo: Math.max(plano ?? 0, MINIMO_ENTRE_PEDIDOS_MS) });
      }
    } catch (e) {
      if (!ativo) return;
      contagem.falhas += 1;
      const status = e?.status;
      // 401/409 já dispararam os eventos da Central (login / reentrada); 403 = renovação indisponível para esta conta.
      if (status === 401 || status === 409 || status === 403 || e?.codigo === "MFA_REQUERIDA" || /Sessão expirada|Contexto/.test(e?.message ?? "")) {
        log(`renovação interrompida (${status ?? e?.message})`);
        parar();
        return;
      }
      // Falha de rede/servidor: tenta de novo enquanto o contexto atual ainda vale.
      falhas += 1;
      const { expiraEmMs, offsetMs } = prazo();
      const espera = esperaDaTentativa(falhas);
      if (Number.isFinite(expiraEmMs) && agora() + offsetMs + espera >= expiraEmMs) { log("renovação sem tempo: o fluxo normal assume"); parar(); return; }
      agendar({ emMsFixo: espera });
    } finally { emVoo = false; }
  }

  return {
    /** Começa (ou recomeça) a agendar com o prazo atual da sessão. */
    iniciar() { ativo = true; falhas = 0; agendar(); },
    parar,
    /** Chamado quando a aba volta a ficar visível/online: se já passou da hora, pede agora. */
    verificar() {
      if (!ativo || emVoo || !ehPerfilExibicao(sessao())) return;
      const { expiraEmMs, offsetMs } = prazo();
      const plano = planejarRenovacao({ expiraEmMs, agoraLocalMs: agora(), offsetMs });
      if (plano === 0) { limpar(); void executar(); }
    },
    get ativo() { return ativo; },
    get emVoo() { return emVoo; },
    get falhas() { return falhas; },
    get contagem() { return { ...contagem }; },
    get agendado() { return timer !== null; },
  };
}

// ---------------------------------------------------------------------------
// Instância da Central (uma por aba)
// ---------------------------------------------------------------------------

let instancia = null;

/** Liga a renovação automática da aba. Idempotente. Chamado uma vez, no boot (app.js). */
export function iniciarRenovacaoAutomatica() {
  if (instancia) return instancia;
  instancia = criarRenovador({
    sessao: () => state.sessao, renovar: renovarContextoNoServidor, aplicar: aplicarRenovacao,
    log: (m) => console.info(`[renovação] ${m}`),
  });
  // Contexto novo/restaurado: (re)agenda pelo prazo dele. Só tem efeito para o perfil de exibição.
  document.addEventListener("app:contexto-aplicado", () => { if (ehPerfilExibicao(state.sessao)) instancia.iniciar(); else instancia.parar(); });
  // Tudo o que derruba login/contexto: para de agendar (a Central segue o fluxo dela).
  for (const ev of ["app:logout", "app:sessao-expirada", "app:contexto-invalido", "app:mfa-requerida"]) document.addEventListener(ev, () => instancia.parar());
  // TV que acordou / voltou a ficar online: se passou da hora, pede já.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") instancia.verificar(); });
  window.addEventListener("online", () => instancia.verificar());
  return instancia;
}
