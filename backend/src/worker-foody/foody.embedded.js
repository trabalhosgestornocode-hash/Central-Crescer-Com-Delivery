// Agendador Foody EMBARCADO no Web Service — ponte entre o boot/shutdown de src/server.js e foody.agendador.js.
//
// Mesmo espírito dos outros laços embutidos (iFood Events, relatórios operacionais):
//   * flags desligadas (padrão) = "nada disso existe neste processo": agendador, repositório, cliente HTTP e Supabase só são
//     importados DEPOIS de FOODY_CENTRAL_ENABLED=true + FOODY_CENTRAL_AGENDADOR_ENABLED=true + allowlist não vazia;
//   * guarda de efeitos externos (PR Preview herdando variáveis, `.env` local apontando para produção) BLOQUEIA a coleta;
//   * segredo FOODY_CENTRAL_SECRET ausente/curto = não inicia (o token não poderia ser decifrado);
//   * primeiro ciclo só depois de ATRASO_INICIAL_MS (deploy sobreposto não dispara coleta em dobro no boot) e cada unidade
//     passa pela MESMA trava da sincronização manual (memória + EM_ANDAMENTO no banco);
//   * D-1..D-3 a cada 6 h; dias congelados só por reconciliação explícita; limites de páginas/pedidos iguais aos da tela;
//   * NUNCA envia mensagem e não alimenta indicador existente; logs só com contagens e códigos (nunca token, valores ou ids
//     de pedido);
//   * falhar aqui NUNCA derruba o backend; nunca registra handler de sinal: o shutdown é o do server.js.
import { agendamentoPermitido, lerFlagsFoody } from "../modules/foody/foody.flags.js";   // puro
import { avaliarEfeitosExternos } from "../ambiente/efeitosExternos.js";                 // puro

export const ATRASO_INICIAL_MS = 3 * 60_000;
/** < fallback de 10 s do server.js. Um dia em curso que passe disso é abandonado e a trava do banco cobre o próximo boot. */
export const PRAZO_PARADA_MS = 6_000;
export const LIMITES_AGENDADOR = Object.freeze({ maxPaginas: 10, maxPedidos: 4_000 });

let agendadorAtual = null;

/** Só contagens e códigos — nunca ids de pedido, valores, token. */
export function resumirCiclo(itens) {
  const r = { dias: 0, registrados: 0, semMudanca: 0, reconciliacoes: 0, erros: {} };
  for (const i of itens ?? []) {
    if (i.competencia) r.dias++;
    if (i.reconciliacao) r.reconciliacoes++;
    if (i.erro) r.erros[i.erro] = (r.erros[i.erro] ?? 0) + 1;
    else if (i.resultado === "SEM_MUDANCA") r.semMudanca++;
    else if (i.resultado) r.registrados++;
  }
  return r;
}

/**
 * Chamado uma vez, depois do `listen()`. Nunca rejeita.
 * @param {{ env?: object, log?: Function, montar?: (env) => Promise<{criarAgendadorFoody, repo, seguranca}> }} [p]
 *   `montar` é injetável SÓ para teste (sem Supabase nem Foody).
 */
export async function iniciarFoodyEmbutido({ env = process.env, log = () => {}, montar } = {}) {
  if (!agendamentoPermitido(env)) {
    log("info", "foody.agendador_not_started", { reason: "flags_desligadas" });
    return { habilitado: false, motivo: "FOODY_CENTRAL_ENABLED/FOODY_CENTRAL_AGENDADOR_ENABLED != true ou allowlist vazia" };
  }
  const efeitos = avaliarEfeitosExternos(env);
  if (!efeitos.permitido) {
    log("warn", "foody.agendador_not_started", { reason: "efeitos_externos_bloqueados", ambiente: efeitos.ambiente, motivo: efeitos.motivo });
    return { habilitado: false, motivo: `efeitos externos bloqueados (${efeitos.motivo})` };
  }
  if (agendadorAtual) return { habilitado: true, motivo: "já iniciado" };
  try {
    const m = await (montar ?? montarPadrao)(env);
    const allow = lerFlagsFoody(env).unidades;
    const ag = m.criarAgendadorFoody({
      env, atrasoInicialMs: m.atrasoInicialMs ?? ATRASO_INICIAL_MS, trava: true, temporizador: m.temporizador,
      deps: { repo: m.repo, seguranca: m.seguranca, limites: LIMITES_AGENDADOR, ...(m.criarCliente ? { criarCliente: m.criarCliente } : {}) },
      unidades: () => m.repo.listarConexoesAtivasDaAllowlist(allow),
      aoTerminarCiclo: (itens) => log("info", "foody.agendador_ciclo", resumirCiclo(itens)),
      aoFalharCiclo: (e) => log("error", "foody.agendador_ciclo_falhou", { codigo: String(e?.codigo ?? "ERRO_INTERNO").slice(0, 40) }),
    });
    ag.iniciar();
    agendadorAtual = ag;
    log("info", "foody.agendador_started", { unidades: allow.size, atrasoInicialMs: m.atrasoInicialMs ?? ATRASO_INICIAL_MS });
    return { habilitado: true };
  } catch (e) {
    log("error", "foody.agendador_start_failed", { codigo: String(e?.codigo ?? "ERRO_INTERNO").slice(0, 40) });
    return { habilitado: false, motivo: e?.codigo === "SEGREDO_AUSENTE" ? "FOODY_CENTRAL_SECRET ausente" : "falha ao iniciar" };
  }
}

async function montarPadrao(env) {
  const [{ criarAgendadorFoody }, { criarRepositorioFoody }, { criarSegurancaFoody }, { supabase }, { ENV_SEGREDO }] = await Promise.all([
    import("../modules/foody/foody.agendador.js"), import("../modules/foody/foody.repository.js"), import("../modules/foody/foody.seguranca.js"),
    import("../config/supabase.js"), import("../modules/foody/foody.constants.js"),
  ]);
  const seguranca = criarSegurancaFoody(env[ENV_SEGREDO]);   // lança SEGREDO_AUSENTE antes de qualquer timer
  return { criarAgendadorFoody, repo: criarRepositorioFoody(supabase), seguranca };
}

export async function pararFoodyEmbutido(_sinal) {
  const ag = agendadorAtual; agendadorAtual = null;
  if (!ag) return;                                                        // no-op quando nunca iniciou (flags desligadas)
  await Promise.race([Promise.resolve().then(() => ag.parar()).catch(() => {}), new Promise((r) => setTimeout(r, PRAZO_PARADA_MS).unref?.())]);
}

/** Só para teste: estado interno. */
export const _agendadorAtual = () => agendadorAtual;
