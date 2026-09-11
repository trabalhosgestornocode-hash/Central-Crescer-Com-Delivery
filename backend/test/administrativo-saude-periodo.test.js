// PAINEL ADMINISTRATIVO — SAÚDE DO PERÍODO × HISTÓRICO ANTERIOR.
//
// Regressão do caso "Pastel Di Féra Sim": setembro 100%, D-1 concluído, e a
// empresa aparecia como CRÍTICA com 1 unidade pendente — porque a
// classificação usava a leitura HISTÓRICA (uma pendência de 29/08).
//
// A regra: a classificação principal (crítico / atenção / em dia) e TODOS os
// contadores operacionais são DO PERÍODO SELECIONADO. Uma pendência anterior
// só pesa se produzir efeito dentro do período — dia pendente ou bloqueado no
// próprio mês. Sozinha, ela é contexto (`historicoAnterior`), nunca cor.
//
// Rodar: node --test test/administrativo-saude-periodo.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  visaoGeral, pendencias, empresas, detalheEmpresa, avaliarFrota,
  rankingDeConformidade,
} from "../src/modules/administrativo/administrativo.service.js";
import { D1_CATEGORIA, ROLLUP } from "../src/modules/administrativo/administrativo.status.js";

const MOD = "ifood_dashboard";
const UUID = (l) => {
  const h = Buffer.from(String(l)).toString("hex").padEnd(32, "0").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function fakeDb(estado) {
  function from(tabela) {
    const ctx = { eq: [], inF: null, gte: null, lte: null };
    const casa = (r) =>
      ctx.eq.every(([c, v]) => r[c] === v) &&
      (!ctx.inF || ctx.inF.vals.includes(r[ctx.inF.col])) &&
      (ctx.gte == null || r[ctx.gte.col] >= ctx.gte.v) &&
      (ctx.lte == null || r[ctx.lte.col] <= ctx.lte.v);
    const run = (single) => {
      const achados = (estado[tabela] ?? []).filter(casa).map((r) => ({ ...r }));
      return Promise.resolve(single ? { data: achados[0] ?? null, error: null } : { data: achados, error: null });
    };
    const b = {
      select: () => b, eq: (c, v) => (ctx.eq.push([c, v]), b), in: (c, vals) => ((ctx.inF = { col: c, vals }), b),
      gte: (c, v) => ((ctx.gte = { col: c, v }), b), lte: (c, v) => ((ctx.lte = { col: c, v }), b),
      order: () => b, range: (de, ate) => run(false).then((r) => ({ ...r, data: (r.data ?? []).slice(de, ate + 1) })),
      maybeSingle: () => run(true), then: (res, rej) => run(false).then(res, rej),
    };
    return b;
  }
  return { from };
}

const org = (id, nome) => ({ id, nome, status: "ativa", eh_modelo: false, created_at: "2025-01-01T00:00:00Z" });
const uni = (id, orgId, nome) => ({ id, organizacao_id: orgId, nome, ativo: true, eh_teste: false, created_at: "2025-01-01T00:00:00Z" });
const dia = (u, data) => ({
  unidade_id: u, data_lancamento: data, status: "finalizado", situacao: "normal",
  valor_vendas_ifood: 1000, origem_lancamento: "diario",
  taxas_comissoes: null, servicos_promocoes: null, taxas_entregadores: null, ajustes_favor_loja: null, ajustes_contra_loja: null,
});
function preenche(u, mes, de, ate) {
  const out = [];
  for (let d = de; d <= ate; d++) out.push(dia(u, `${mes}-${String(d).padStart(2, "0")}`));
  return out;
}

const O = UUID("pastel"), U = UUID("feira");

/**
 * O cenário real relatado.
 *   agosto   -> 01..28 lançado ; 29, 30, 31 EM BRANCO (a pendência antiga)
 *   setembro -> conforme `setAte` (01/09 lançado no caso A)
 * Hoje = 02/09/2026, D-1 = 01/09.
 */
function pastelDiFera({ setAte = 1 } = {}) {
  const st = {
    organizacoes: [org(O, "Pastel Di Féra Sim - Feira de Santana - BA")],
    unidades: [uni(U, O, "Feira de Santana")],
    organizacao_modulos: [{ organizacao_id: O, modulo_id: MOD }],
    unidade_modulos: [{ unidade_id: U, modulo_id: MOD }],
    // julho completo: sem isso, olhar AGOSTO acusaria julho como histórico
    // anterior — verdade, mas ruído para o que este cenário quer testar.
    lancamentos_financeiros_diarios: [...preenche(U, "2026-07", 1, 31), ...preenche(U, "2026-08", 1, 28)],
  };
  if (setAte >= 1) st.lancamentos_financeiros_diarios.push(...preenche(U, "2026-09", 1, setAte));
  return st;
}
const HOJE = "2026-09-02";
const uniDe = (r) => r.unidades[0];

// ===========================================================================
// CASO A — setembro 100% -> SAUDÁVEL, apesar do histórico de 29/08
// ===========================================================================
describe("CASO A) período correto -> saudável, mesmo com pendência histórica", () => {
  test("a unidade fica EM DIA e sem pendência no período", async () => {
    const r = await avaliarFrota({ hojeIso: HOJE }, { supabase: fakeDb(pastelDiFera()) });
    const u = uniDe(r);
    assert.equal(u.d1.categoria, D1_CATEGORIA.CONCLUIDO, "01/09 concluído");
    assert.equal(u.conformidade.taxa, 1, "conformidade de setembro = 100%");
    assert.equal(u.pendenciasPeriodo.total, 0);
    assert.equal(u.rollup.status, ROLLUP.EM_DIA);
  });

  test("o histórico de 29/08 continua visível — como contexto, não como status", async () => {
    const r = await avaliarFrota({ hojeIso: HOJE }, { supabase: fakeDb(pastelDiFera()) });
    const u = uniDe(r);
    assert.equal(u.historicoAnterior.existe, true);
    assert.equal(u.historicoAnterior.desde, "2026-08-29");
    assert.equal(u.historicoAnterior.total, 3, "29, 30 e 31/08");
    assert.equal(u.rollup.status, ROLLUP.EM_DIA, "o contexto não muda a classificação");
  });

  test("a EMPRESA fica saudável: 0 pendentes, 0 críticas, 0 atenção, 1 em dia", async () => {
    const r = await empresas({ hojeIso: HOJE }, { supabase: fakeDb(pastelDiFera()) });
    const e = r.empresas[0];
    assert.equal(e.unidadesMonitoradas, 1);
    assert.equal(e.unidadesPendentes, 0);
    assert.equal(e.criticas, 0);
    assert.equal(e.atencao, 0);
    assert.equal(e.emDia, 1);
    assert.equal(e.severidade, 2, "saudável");
    assert.equal(e.piorUnidade, null);
    assert.deepEqual(e.pendentes, []);
    assert.equal(e.d1Ok, true);
    assert.equal(e.conformidadeMes, 1);
  });

  test("a empresa carrega o histórico anterior como nota", async () => {
    const r = await empresas({ hojeIso: HOJE }, { supabase: fakeDb(pastelDiFera()) });
    const e = r.empresas[0];
    assert.equal(e.historicoAnterior.existe, true);
    assert.equal(e.historicoAnterior.desde, "2026-08-29");
    assert.equal(e.historicoAnterior.unidades, 1);
  });
});

// ===========================================================================
// CASO B — a pendência antiga causa efeito REAL em setembro
// ===========================================================================
describe("CASO B) efeito real dentro do período -> CRÍTICO", () => {
  test("01/09 em branco e D-1 = 04/09: setembro tem dia pendente -> crítico", async () => {
    // setembro sem nenhum lançamento; hoje 05/09 -> D-1 = 04/09
    const st = pastelDiFera({ setAte: 0 });
    const r = await avaliarFrota({ hojeIso: "2026-09-05" }, { supabase: fakeDb(st) });
    const u = uniDe(r);
    assert.ok(u.pendenciasPeriodo.total > 0, "01..03/09 pendentes DENTRO do mês");
    assert.equal(u.pendenciasPeriodo.desde, "2026-09-01");
    assert.equal(u.rollup.status, ROLLUP.CRITICO);
    assert.equal(u.historicoAnterior.existe, true, "o histórico continua registrado");
  });

  test("D-1 bloqueado pela sequência do próprio mês -> crítico", async () => {
    const st = pastelDiFera({ setAte: 0 });
    const r = await avaliarFrota({ hojeIso: "2026-09-05" }, { supabase: fakeDb(st) });
    const u = uniDe(r);
    assert.equal(u.d1.categoria, D1_CATEGORIA.SEQUENCIA_BLOQUEADA);
    assert.equal(u.rollup.status, ROLLUP.CRITICO);
  });

  test("D-1 apenas em aberto (sem dia anterior pendente no mês) -> ATENÇÃO", async () => {
    // setembro 01..02 lançado, hoje 04/09 -> D-1 = 03/09 pendente isolado
    const st = pastelDiFera({ setAte: 2 });
    const r = await avaliarFrota({ hojeIso: "2026-09-04" }, { supabase: fakeDb(st) });
    const u = uniDe(r);
    assert.equal(u.d1.categoria, D1_CATEGORIA.NAO_REALIZADO);
    assert.equal(u.pendenciasPeriodo.total, 0, "nada acumulado antes do D-1 no mês");
    assert.equal(u.rollup.status, ROLLUP.ATENCAO, "atenção, não crítico");
  });
});

// ===========================================================================
// CASO C — agosto selecionado: a pendência aparece normalmente
// ===========================================================================
describe("CASO C) com AGOSTO selecionado, 29/08 classifica normalmente", () => {
  test("agosto é o período -> crítico, com a pendência como métrica principal", async () => {
    const r = await avaliarFrota({ hojeIso: HOJE, dataAlvo: "2026-08-31" }, { supabase: fakeDb(pastelDiFera()) });
    const u = uniDe(r);
    assert.equal(u.inicioPeriodo, "2026-08-01");
    assert.equal(u.pendenciasPeriodo.desde, "2026-08-29");
    assert.equal(u.pendenciasPeriodo.total, 2, "29 e 30 (31 é o próprio alvo)");
    assert.equal(u.rollup.status, ROLLUP.CRITICO);
    assert.equal(u.historicoAnterior.existe, false, "não há nada antes de agosto");
  });

  test("a empresa em agosto aparece com 1 unidade pendente", async () => {
    const r = await empresas({ hojeIso: HOJE, mes: "2026-08" }, { supabase: fakeDb(pastelDiFera()) });
    const e = r.empresas[0];
    assert.equal(e.unidadesPendentes, 1);
    assert.equal(e.criticas, 1);
    assert.equal(e.severidade, 0);
    assert.equal(e.piorUnidade.unidadeNome, "Feira de Santana");
  });
});

// ===========================================================================
// CASO D — setembro: histórico é secundário, não contamina
// ===========================================================================
describe("CASO D) em setembro o histórico é secundário", () => {
  test("o detalhe da empresa separa: 0 pendentes, histórico presente", async () => {
    const r = await detalheEmpresa({ organizacaoId: O, hojeIso: HOJE }, { supabase: fakeDb(pastelDiFera()) });
    assert.equal(r.consolidado.criticas, 0);
    assert.equal(r.consolidado.atencao, 0);
    assert.equal(r.consolidado.emDia, 1);
    assert.equal(r.unidades[0].criticidade, ROLLUP.EM_DIA);
    assert.equal(r.unidades[0].diasPendentes, 0);
    assert.equal(r.unidades[0].historicoAnterior.existe, true);
    assert.deepEqual(r.pendencias, []);
  });

  test("o ranking de conformidade coloca a empresa em 100%", async () => {
    const r = await rankingDeConformidade({ hojeIso: HOJE }, { supabase: fakeDb(pastelDiFera()) });
    assert.equal(r.itens[0].conformidadeMes, 1);
  });
});

// ===========================================================================
// CASO E — contadores da Visão Geral
// ===========================================================================
describe("CASO E) contadores da Visão Geral não contam o histórico", () => {
  test("empresa saudável em setembro não entra em nenhum contador de pendência", async () => {
    const vg = await visaoGeral({ hojeIso: HOJE }, { supabase: fakeDb(pastelDiFera()) });
    assert.equal(vg.resumo.empresasComPendencia, 0);
    assert.equal(vg.resumo.unidadesComPendencia, 0);
    assert.equal(vg.resumo.criticas, 0);
    assert.equal(vg.resumo.atencao, 0);
    assert.equal(vg.resumo.emDia, 1, "conta como em dia");
    assert.equal(vg.resumo.empresasSaudaveis, 1);
    assert.equal(vg.resumo.conformidadeMes, 1);
  });

  test("nada em 'Ação necessária' — o D-1 foi concluído", async () => {
    const vg = await visaoGeral({ hojeIso: HOJE }, { supabase: fakeDb(pastelDiFera()) });
    assert.deepEqual(vg.acaoNecessariaHoje, []);
  });

  test("a fila de Pendências de setembro fica vazia", async () => {
    const p = await pendencias({ hojeIso: HOJE }, { supabase: fakeDb(pastelDiFera()) });
    assert.equal(p.total, 0);
    assert.equal(p.criticas, 0);
    assert.equal(p.atencao, 0);
    assert.deepEqual(p.unidades, []);
  });

  test("mudando para agosto, os MESMOS contadores acusam a pendência", async () => {
    const vg = await visaoGeral({ hojeIso: HOJE, mes: "2026-08" }, { supabase: fakeDb(pastelDiFera()) });
    assert.equal(vg.resumo.empresasComPendencia, 1);
    assert.equal(vg.resumo.unidadesComPendencia, 1);
    assert.equal(vg.resumo.criticas, 1);
    assert.equal(vg.resumo.emDia, 0);

    const p = await pendencias({ hojeIso: HOJE, mes: "2026-08" }, { supabase: fakeDb(pastelDiFera()) });
    assert.equal(p.total, 1);
    assert.equal(p.criticas, 1);
  });
});

// ===========================================================================
// Mistura: a frota separa saudável-com-histórico de realmente pendente
// ===========================================================================
describe("frota mista", () => {
  test("só a unidade com efeito no período entra nos contadores", async () => {
    const O2 = UUID("outra"), U2 = UUID("outraUni");
    const st = pastelDiFera();
    st.organizacoes.push(org(O2, "Rede Pendente"));
    st.unidades.push(uni(U2, O2, "Unidade Atrasada"));
    st.organizacao_modulos.push({ organizacao_id: O2, modulo_id: MOD });
    st.unidade_modulos.push({ unidade_id: U2, modulo_id: MOD });
    st.lancamentos_financeiros_diarios.push(...preenche(U2, "2026-08", 1, 31)); // agosto ok, setembro vazio

    const vg = await visaoGeral({ hojeIso: HOJE }, { supabase: fakeDb(st) });
    assert.equal(vg.resumo.unidadesMonitoradas, 2);
    assert.equal(vg.resumo.empresasComPendencia, 1, "só a Rede Pendente");
    assert.equal(vg.resumo.unidadesComPendencia, 1);
    assert.equal(vg.resumo.emDia, 1, "o Pastel Di Féra conta como em dia");

    const lista = vg.empresas;
    const pastel = lista.find((e) => e.empresaNome.startsWith("Pastel"));
    const pendente = lista.find((e) => e.empresaNome === "Rede Pendente");
    assert.equal(pastel.severidade, 2);
    assert.ok(pendente.severidade < 2);
    assert.ok(lista.indexOf(pendente) < lista.indexOf(pastel), "a com problema vem primeiro");
  });
});
