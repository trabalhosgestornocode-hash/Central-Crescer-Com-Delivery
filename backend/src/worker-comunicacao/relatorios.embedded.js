// Ponte entre o boot/shutdown do backend e o AGENDADOR dos relatórios operacionais (diário + semanal) — mesmo espírito do worker de comunicação
// embutido: flag DESLIGADA por padrão = "nada disso existe neste processo" (nem os módulos são carregados).
//   * NOTIFICACOES_RELATORIOS_AGENDADOR_HABILITADO=true liga o agendador (gera o fechamento de ontem, enfileira e despacha);
//   * o despacho em si ainda exige NOTIFICACOES_RELATORIOS_ENVIO_HABILITADO=true + lista de números (sem elas, o ciclo só gera e enfileira);
//   * a guarda de efeitos externos (PR Preview herdando variáveis, Render sem autorização do serviço, `.env` local apontando para produção)
//     BLOQUEIA o agendador igual bloqueia o worker de comunicação;
//   * falhar aqui NUNCA derruba o boot do backend; o D-1 de pendências (worker de comunicação) é outro laço e não é tocado.
import { avaliarEfeitosExternos } from "../ambiente/efeitosExternos.js";

const GRACE_MS = 6_000;
let agendadorAtual = null;

export const relatoriosAgendadorHabilitado = (env = process.env) => String(env?.NOTIFICACOES_RELATORIOS_AGENDADOR_HABILITADO ?? "").trim().toLowerCase() === "true";

/**
 * @param {{env?: object, log?: Function, criarAgendador?: Function}} [p]  `criarAgendador` é injetável só para teste.
 * @returns {Promise<{habilitado: boolean, motivo?: string}>}
 */
export async function iniciarRelatoriosOperacionaisEmbutido({ env = process.env, log = () => {}, criarAgendador: criarInjetado } = {}) {
  if (!relatoriosAgendadorHabilitado(env)) { log("info", "relatorios.agendador_not_started", { reason: "flag_desligada" }); return { habilitado: false, motivo: "NOTIFICACOES_RELATORIOS_AGENDADOR_HABILITADO != true" }; }
  const efeitos = avaliarEfeitosExternos(env);
  if (!efeitos.permitido) { log("warn", "relatorios.agendador_not_started", { reason: "efeitos_externos_bloqueados", ambiente: efeitos.ambiente, motivo: efeitos.motivo }); return { habilitado: false, motivo: `efeitos externos bloqueados (${efeitos.motivo})` }; }
  if (agendadorAtual) return { habilitado: true, motivo: "já iniciado" };
  try {
    const criar = criarInjetado ?? (await import("../modules/notificacoes/notificacoes.relatorios.agendador.js")).criarAgendadorRelatorios;
    const ag = criar({ env, aoTerminarCiclo: (r) => log(r?.erro ? "error" : "info", "relatorios.ciclo", resumoSeguro(r)) });
    ag.iniciar(); agendadorAtual = ag;
    log("info", "relatorios.agendador_started", {});
    return { habilitado: true };
  } catch (e) {
    log("error", "relatorios.agendador_start_failed", { erro: String(e?.message ?? e).slice(0, 200) });
    return { habilitado: false, motivo: "falha ao iniciar" };
  }
}

/** Só contagens e motivos — nunca telefone, texto de relatório nem ids de destinatário. */
function resumoSeguro(r) {
  if (!r || r.erro) return { erro: String(r?.erro ?? "").slice(0, 200) };
  return {
    recusadas: (r.recusadas ?? []).length, enfileirados: (r.enfileirados ?? []).filter((x) => !x.erro).length, erros: (r.enfileirados ?? []).filter((x) => x.erro).length,
    despacho: r.envio?.desligado ? (r.envio.motivo ?? "desligado") : (r.envio?.resultados ?? []).length,
  };
}

export async function pararRelatoriosOperacionaisEmbutido(_sinal) {
  const ag = agendadorAtual; agendadorAtual = null;
  if (!ag) return;                                                           // no-op quando nunca iniciou (flag desligada)
  await Promise.race([Promise.resolve().then(() => ag.parar()), new Promise((r) => setTimeout(r, GRACE_MS).unref?.())]);
}
