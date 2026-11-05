// PAINEL ADMINISTRATIVO — GET /unidades/:unidadeId/dashboard.
//
// Prova que o clique em uma unidade na Visão Geral da Rede chega ao MESMO
// motor do Dashboard iFood do tenant (`dashboardExecutivo.service.js#obterMes`),
// por chamada direta de função — nunca uma segunda implementação paralela de
// cards/Indicadores de Rentabilidade. `obterMes` em si (metas, status,
// saldoMeta) já é testado em dashboard-executivo-rentabilidade-service.test.js;
// aqui só provamos a COLAGEM administrativa: elegibilidade/escopo cross-tenant,
// período e os parâmetros exatos passados para `obterMes`.
//
// Rodar: node --test test/administrativo-dashboard-operacao-unidade.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { detalheOperacaoUnidade } from "../src/modules/administrativo/administrativo.service.js";

const MOD = "ifood_dashboard";
const HOJE = "2026-10-05";
const UUID = (l) => {
  const h = Buffer.from(String(l)).toString("hex").padEnd(32, "0").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function fakeDb(estado) {
  function from(tabela) {
    const ctx = { eq: [], inF: null };
    const casa = (r) => ctx.eq.every(([c, v]) => r[c] === v) && (!ctx.inF || ctx.inF.vals.includes(r[ctx.inF.col]));
    const run = (single) => {
      const achados = (estado[tabela] ?? []).filter(casa).map((r) => ({ ...r }));
      return Promise.resolve(single ? { data: achados[0] ?? null, error: null } : { data: achados, error: null });
    };
    const b = {
      select: () => b, eq: (c, v) => (ctx.eq.push([c, v]), b), in: (c, vals) => ((ctx.inF = { col: c, vals }), b),
      maybeSingle: () => run(true), then: (res, rej) => run(false).then(res, rej),
    };
    return b;
  }
  return { from };
}

const org = (id, nome) => ({ id, nome, status: "ativa", eh_modelo: false });
const uni = (id, orgId, nome, modelo) => ({ id, organizacao_id: orgId, nome, ativo: true, eh_teste: false, created_at: "2025-01-01T00:00:00Z", modelo_logistico_ifood: modelo });

function cenario() {
  return {
    organizacoes: [org(UUID("jv"), "Grupo JV")],
    unidades: [uni(UUID("a"), UUID("jv"), "JV Loja A", "marketplace")],
    organizacao_modulos: [{ organizacao_id: UUID("jv"), modulo_id: MOD }],
    unidade_modulos: [{ unidade_id: UUID("a"), modulo_id: MOD }],
  };
}

describe("detalheOperacaoUnidade — Dashboard iFood completo da unidade (admin)", () => {
  test("chama obterMes com organizacaoId/unidadeId explícitos e unidadeIdSessao null (sem req.tenant)", async () => {
    const chamadas = [];
    const dadosFicticios = { agregado: false, cards: { faturamento: { valor: 30000 } }, indicadoresRentabilidade: { taxas_comissoes: { atual: 7.5 } } };
    const r = await detalheOperacaoUnidade(
      { unidadeId: UUID("a"), mes: "2026-09", hojeIso: HOJE },
      {
        supabase: fakeDb(cenario()),
        obterMesDashboardExecutivo: async (params) => { chamadas.push(params); return dadosFicticios; },
      },
    );

    assert.equal(chamadas.length, 1);
    assert.deepEqual(chamadas[0], {
      organizacaoId: UUID("jv"), unidadeIdSessao: null, unidadeIdSolicitado: UUID("a"), mes: 9, ano: 2026,
    });
    // Nunca recalcula nada vindo de `obterMes` — devolve exatamente o que ele respondeu.
    assert.deepEqual(r.dashboard, dadosFicticios);
    assert.deepEqual(r.unidade, { unidadeId: UUID("a"), unidadeNome: "JV Loja A", organizacaoId: UUID("jv"), empresaNome: "Grupo JV" });
    assert.deepEqual(r.periodo, { mes: 9, ano: 2026, ym: "2026-09", mesCorrente: false });
  });

  test("404 quando a unidade não está no universo monitorado (fora do módulo ou de outra organização inexistente)", async () => {
    await assert.rejects(
      () => detalheOperacaoUnidade(
        { unidadeId: UUID("fantasma"), mes: "2026-09", hojeIso: HOJE },
        { supabase: fakeDb(cenario()), obterMesDashboardExecutivo: async () => ({}) },
      ),
      (e) => { assert.equal(e.statusCode, 404); return true; },
    );
  });

  test("sem `mes`, usa o mês corrente (hojeIso) — mesma regra de `alvoDoPeriodo`", async () => {
    const chamadas = [];
    await detalheOperacaoUnidade(
      { unidadeId: UUID("a"), hojeIso: HOJE },
      { supabase: fakeDb(cenario()), obterMesDashboardExecutivo: async (p) => { chamadas.push(p); return {}; } },
    );
    assert.equal(chamadas[0].mes, 10);
    assert.equal(chamadas[0].ano, 2026);
  });
});
