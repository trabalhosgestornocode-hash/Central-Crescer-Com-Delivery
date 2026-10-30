// Dashboard Operacional 2.0 — AGENDADOR do fechamento diário (somente ambiente isolado nesta fase).
//
// NÃO É LIGADO NO server.js. Só roda quando alguém chama `criarAgendadorFechamento(...).iniciar()` (testes, script local) e,
// mesmo assim, exige DUAS travas no ambiente:
//   OPERACIONAL_FECHAMENTO_AGENDADO_ENABLED=true   e   OPERACIONAL_AMBIENTE_ISOLADO=true
// Sem as duas, `iniciar()` recusa (fail-closed). Ativar em produção é uma etapa futura com aprovação (docs/dashboard-operacional-2).
//
// O que faz a cada ciclo, para cada unidade da lista: gera o fechamento de ONTEM (origem "agendado"). É idempotente: o mesmo
// conteúdo não cria versão nova; um dia já consolidado só vira REVISADO se os dados mudarem. Uma unidade com erro nunca impede
// as outras. NUNCA envia WhatsApp (nem simulado): a simulação é um passo manual na tela.

import { gerarFechamento, resolverFuso } from "./checklistOperacional.operacional.service.js";
import { hojeNoFuso, somarDias } from "./checklistOperacional.periodos.js";

export const INTERVALO_PADRAO_MS = 15 * 60_000;

export function agendamentoPermitido(env = process.env) {
  return env.OPERACIONAL_FECHAMENTO_AGENDADO_ENABLED === "true" && env.OPERACIONAL_AMBIENTE_ISOLADO === "true";
}

/** Um ciclo: fechamento de ontem para cada unidade. @returns {Promise<Array<{unidadeId, resultado?, status?, versao?, erro?}>>} */
export async function executarCiclo({ unidades, agora = () => new Date(), gerar = gerarFechamento, deps = {} }) {
  const { fuso } = resolverFuso();
  const ontem = somarDias(hojeNoFuso(agora().getTime(), fuso), -1);
  const out = [];
  for (const u of unidades ?? []) {
    try {
      const r = await gerar({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, competencia: ontem, origem: "agendado", geradoPor: "agendador", agora, deps });
      out.push({ unidadeId: u.unidadeId, competencia: ontem, resultado: r.resultado, status: r.fechamento?.status, versao: r.fechamento?.versao });
    } catch (e) {
      out.push({ unidadeId: u.unidadeId, competencia: ontem, erro: String(e?.message ?? e).slice(0, 200) });
    }
  }
  return out;
}

/**
 * @param {{unidades: () => Promise<Array<{organizacaoId: string, unidadeId: string}>>|Array, intervaloMs?: number, env?: object,
 *          agora?: () => Date, gerar?: Function, deps?: object, aoTerminarCiclo?: Function, temporizador?: {set: Function, clear: Function}}} p
 */
export function criarAgendadorFechamento({ unidades, intervaloMs = INTERVALO_PADRAO_MS, env = process.env, agora = () => new Date(), gerar, deps, aoTerminarCiclo = () => {}, temporizador = { set: setTimeout, clear: clearTimeout } }) {
  let ativo = false;
  let pendente = null;
  let rodando = false;
  async function tique() {
    if (!ativo || rodando) return;
    rodando = true;
    try {
      const lista = typeof unidades === "function" ? await unidades() : unidades;
      aoTerminarCiclo(await executarCiclo({ unidades: lista, agora, gerar, deps }));
    } finally {
      rodando = false;
      if (ativo) pendente = temporizador.set(tique, intervaloMs);
    }
  }
  return {
    iniciar() {
      if (!agendamentoPermitido(env)) {
        const e = new Error("Agendamento do fechamento recusado: exige OPERACIONAL_FECHAMENTO_AGENDADO_ENABLED=true e OPERACIONAL_AMBIENTE_ISOLADO=true.");
        e.codigo = "AGENDAMENTO_NAO_PERMITIDO";
        throw e;
      }
      if (ativo) return;
      ativo = true;
      pendente = temporizador.set(tique, 0);
    },
    parar() { ativo = false; if (pendente) temporizador.clear(pendente); pendente = null; },
    get ativo() { return ativo; },
    tique,
  };
}
