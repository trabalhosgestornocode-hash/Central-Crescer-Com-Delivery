// MOTOR do Painel Administrativo — monitor Dashboard iFood (Fase E).
// PURO, sem rede, sem banco. Prova, acima de tudo, que NENHUMA projeção de
// status mascara uma pendência SEQUENCIAL (a regra de negócio confirmada:
// lançamento diário, obrigação = D-1, PENDENTE/BLOQUEADO do domínio).
//
// Rodar: node --test test/administrativo-status.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { STATUS_DIA, statusMes } from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";
import {
  STATUS_PAINEL, D1_CATEGORIA, ROLLUP,
  projetarDia, projetarMes, avaliarD1, conformidadeMes, pendenciasAcumuladas,
  rollupUnidade, avaliarUnidade, diasDoMes, prazoFinalHoje,
} from "../src/modules/administrativo/administrativo.status.js";
import {
  listarMonitores, acaoNecessariaHoje, conformidadeD1, consolidarOperacao, agruparPorEmpresa,
} from "../src/modules/administrativo/administrativo.monitores.js";

// ---------------------------------------------------------------------------
const HOJE = "2026-09-15";       // -> mês corrente = setembro/2026 (30 dias)
const D1 = "2026-09-14";         // diaAnterior(HOJE)

const fin = (over = {}) => ({ status: "finalizado", situacao: "normal", valor_vendas_ifood: 1000, ...over });
const rascunho = (over = {}) => ({ status: "rascunho", situacao: "normal", valor_vendas_ifood: null, ...over });
const semOp = () => ({ status: "finalizado", situacao: "sem_operacao", valor_vendas_ifood: 0 });
const zeroVendas = () => ({ status: "finalizado", situacao: "zero_vendas", valor_vendas_ifood: 0 });

/** Constrói os `dias` de um mês, com lançamentos por data. */
function mesDias(ano, mes, lancamentos = {}) {
  return diasDoMes(ano, mes).map((data) => ({ data, lancamento: lancamentos[data] ?? null }));
}
/** Preenche (finalizado) todos os dias de `de`..`ate` (inclusive), ISO AAAA-MM-DD do mesmo mês. */
function preencher(de, ate, fabrica = fin) {
  const out = {};
  const [y, m] = de.split("-").map(Number);
  const d0 = Number(de.slice(8, 10));
  const d1 = Number(ate.slice(8, 10));
  for (let d = d0; d <= d1; d++) out[`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`] = fabrica();
  return out;
}

// ===========================================================================
// 1. Projeção STATUS_DIA -> STATUS_PAINEL: explícita, nunca "sobe" severidade
// ===========================================================================
describe("projetarDia — projeção pura, um a um", () => {
  const proj = (status) => projetarDia({ data: "2026-09-10", status }, { hojeIso: HOJE });

  test("PREENCHIDO / SEM_OPERACAO / ZERO_VENDAS -> COMPLETO", () => {
    for (const s of [STATUS_DIA.PREENCHIDO, STATUS_DIA.SEM_OPERACAO, STATUS_DIA.ZERO_VENDAS]) {
      assert.equal(proj(s).painel, STATUS_PAINEL.COMPLETO, s);
    }
  });

  test("FINANCEIRO_PENDENTE -> INCOMPLETO (em preenchimento), NUNCA completo", () => {
    const r = proj(STATUS_DIA.FINANCEIRO_PENDENTE);
    assert.equal(r.painel, STATUS_PAINEL.INCOMPLETO);
    assert.equal(r.emPreenchimento, true);
    assert.notEqual(r.painel, STATUS_PAINEL.COMPLETO);
  });

  test("RASCUNHO -> INCOMPLETO", () => {
    assert.equal(proj(STATUS_DIA.RASCUNHO).painel, STATUS_PAINEL.INCOMPLETO);
  });

  test("PENDENTE -> NÃO LANÇADO", () => {
    assert.equal(proj(STATUS_DIA.PENDENTE).painel, STATUS_PAINEL.NAO_LANCADO);
  });

  test("BLOQUEADO -> NÃO LANÇADO + flag bloqueada (nunca COMPLETO/INCOMPLETO)", () => {
    const r = proj(STATUS_DIA.BLOQUEADO);
    assert.equal(r.painel, STATUS_PAINEL.NAO_LANCADO);
    assert.equal(r.bloqueada, true);
  });

  test("FUTURO -> NÃO APLICÁVEL", () => {
    assert.equal(proj(STATUS_DIA.FUTURO).painel, STATUS_PAINEL.NAO_APLICAVEL);
  });

  test("D+0 (hoje) -> NÃO APLICÁVEL 'hoje' — nunca crítico por não estar preenchido", () => {
    const r = projetarDia({ data: HOJE, status: STATUS_DIA.PENDENTE }, { hojeIso: HOJE });
    assert.equal(r.painel, STATUS_PAINEL.NAO_APLICAVEL);
    assert.equal(r.motivoNaoAplicavel, "hoje");
  });

  test("dia anterior à criação da unidade -> NÃO APLICÁVEL", () => {
    const r = projetarDia({ data: "2026-09-03", status: STATUS_DIA.PENDENTE }, { hojeIso: HOJE, unidadeCriadaEm: "2026-09-10T12:00:00Z" });
    assert.equal(r.painel, STATUS_PAINEL.NAO_APLICAVEL);
    assert.equal(r.motivoNaoAplicavel, "antes_da_criacao");
  });
});

// ===========================================================================
// 2. GARANTIA CENTRAL: nenhuma projeção mascara pendência sequencial
// ===========================================================================
describe("nunca mascara pendência sequencial", () => {
  test("D-2 sem lançamento + D-1 sem lançamento -> statusMes marca D-1 BLOQUEADO -> painel NÃO LANÇADO", () => {
    // dias 1..12 ok; 13 (D-2) e 14 (D-1) vazios
    const dias = mesDias(2026, 9, preencher("2026-09-01", "2026-09-12"));
    const proj = projetarMes({ dias, hojeIso: HOJE });
    const d13 = proj.find((d) => d.data === "2026-09-13");
    const d14 = proj.find((d) => d.data === D1);
    assert.equal(d13.statusDia, STATUS_DIA.PENDENTE);
    assert.equal(d14.statusDia, STATUS_DIA.BLOQUEADO, "o domínio bloqueia o dia seguinte a um pendente");
    assert.equal(d14.painel, STATUS_PAINEL.NAO_LANCADO);
    assert.equal(d14.bloqueada, true);
    // e a unidade fica CRÍTICA
    const d1 = avaliarD1(proj, HOJE);
    const pend = pendenciasAcumuladas(proj, HOJE);
    assert.equal(rollupUnidade({ d1, pendenciasAcum: pend }).status, ROLLUP.CRITICO);
  });

  test("um RASCUNHO parado no meio do mês bloqueia a sequência até o D-1", () => {
    // dias 1..9 ok; 10 = rascunho (não elegível, não é D-1) -> RASCUNHO -> bloqueia 11+
    const lanc = { ...preencher("2026-09-01", "2026-09-09"), "2026-09-10": rascunho() };
    const proj = projetarMes({ dias: mesDias(2026, 9, lanc), hojeIso: HOJE });
    assert.equal(proj.find((d) => d.data === "2026-09-10").painel, STATUS_PAINEL.INCOMPLETO);
    assert.equal(proj.find((d) => d.data === "2026-09-11").statusDia, STATUS_DIA.BLOQUEADO);
    assert.equal(proj.find((d) => d.data === D1).painel, STATUS_PAINEL.NAO_LANCADO);
  });

  test("a projeção nunca eleva um STATUS_DIA para uma severidade menor", () => {
    // ordem de severidade (pior -> melhor): BLOQUEADO ~ PENDENTE > RASCUNHO ~ FIN_PEND > PREENCHIDO
    const severidade = {
      [STATUS_PAINEL.NAO_LANCADO]: 3, [STATUS_PAINEL.INCOMPLETO]: 2,
      [STATUS_PAINEL.COMPLETO]: 1, [STATUS_PAINEL.NAO_APLICAVEL]: 0,
    };
    const esperado = {
      [STATUS_DIA.BLOQUEADO]: STATUS_PAINEL.NAO_LANCADO,
      [STATUS_DIA.PENDENTE]: STATUS_PAINEL.NAO_LANCADO,
      [STATUS_DIA.RASCUNHO]: STATUS_PAINEL.INCOMPLETO,
      [STATUS_DIA.FINANCEIRO_PENDENTE]: STATUS_PAINEL.INCOMPLETO,
      [STATUS_DIA.PREENCHIDO]: STATUS_PAINEL.COMPLETO,
    };
    for (const [sd, sp] of Object.entries(esperado)) {
      const r = projetarDia({ data: "2026-09-10", status: sd }, { hojeIso: HOJE });
      assert.equal(r.painel, sp);
      assert.ok(severidade[r.painel] >= 1 || sd === STATUS_DIA.FUTURO);
    }
  });
});

// ===========================================================================
// 3. avaliarD1 — o monitor diário principal
// ===========================================================================
describe("avaliarD1", () => {
  const projComD1 = (lancD1) => projetarMes({
    dias: mesDias(2026, 9, { ...preencher("2026-09-01", "2026-09-13"), ...(lancD1 ? { [D1]: lancD1 } : {}) }),
    hojeIso: HOJE,
  });

  test("D-1 finalizado -> concluido", () => {
    assert.equal(avaliarD1(projComD1(fin()), HOJE).categoria, D1_CATEGORIA.CONCLUIDO);
  });
  test("D-1 sem operação (finalizado) -> concluido", () => {
    assert.equal(avaliarD1(projComD1(semOp()), HOJE).categoria, D1_CATEGORIA.CONCLUIDO);
  });
  test("D-1 rascunho normal sem financeiro (FINANCEIRO_PENDENTE) -> em_preenchimento", () => {
    assert.equal(avaliarD1(projComD1(rascunho()), HOJE).categoria, D1_CATEGORIA.EM_PREENCHIMENTO);
  });
  test("D-1 sem lançamento, dias anteriores ok (PENDENTE isolado) -> nao_realizado", () => {
    assert.equal(avaliarD1(projComD1(null), HOJE).categoria, D1_CATEGORIA.NAO_REALIZADO);
  });
  test("D-1 bloqueado (dia anterior pendente) -> sequencia_bloqueada", () => {
    const proj = projetarMes({ dias: mesDias(2026, 9, preencher("2026-09-01", "2026-09-12")), hojeIso: HOJE });
    assert.equal(avaliarD1(proj, HOJE).categoria, D1_CATEGORIA.SEQUENCIA_BLOQUEADA);
  });
  test("unidade criada hoje -> D-1 não elegível (nunca conta contra)", () => {
    const proj = projetarMes({ dias: mesDias(2026, 9, {}), hojeIso: HOJE, unidadeCriadaEm: HOJE });
    const d1 = avaliarD1(proj, HOJE);
    assert.equal(d1.elegivel, false);
    assert.equal(d1.categoria, D1_CATEGORIA.NAO_APLICAVEL);
  });
});

// ===========================================================================
// 4. Conformidade
// ===========================================================================
describe("conformidadeMes", () => {
  test("mês em andamento: só dias vencidos contam (exclui hoje e futuro)", () => {
    // 1..14 ok (14 dias completos), 15 = hoje, 16..30 = futuro
    const proj = projetarMes({ dias: mesDias(2026, 9, preencher("2026-09-01", "2026-09-14")), hojeIso: HOJE });
    const c = conformidadeMes(proj);
    assert.equal(c.esperados, 14);
    assert.equal(c.completos, 14);
    assert.equal(c.taxa, 1);
  });

  test("com 2 dias não lançados: taxa = completos / esperados", () => {
    // 1..12 ok, 13 e 14 vazios -> 13 PENDENTE, 14 BLOQUEADO -> 12/14
    const proj = projetarMes({ dias: mesDias(2026, 9, preencher("2026-09-01", "2026-09-12")), hojeIso: HOJE });
    const c = conformidadeMes(proj);
    assert.equal(c.esperados, 14);
    assert.equal(c.completos, 12);
    assert.equal(c.naoLancados, 2);
    assert.ok(Math.abs(c.taxa - 12 / 14) < 1e-9);
  });

  test("sem dias esperados -> taxa null (nunca 0/0)", () => {
    const proj = projetarMes({ dias: mesDias(2026, 9, {}), hojeIso: "2026-09-01", unidadeCriadaEm: "2026-09-01" });
    assert.equal(conformidadeMes(proj).taxa, null);
  });

  test("FINANCEIRO_PENDENTE no D-1 REDUZ a conformidade (não é completo)", () => {
    const lanc = { ...preencher("2026-09-01", "2026-09-13"), [D1]: rascunho() };
    const proj = projetarMes({ dias: mesDias(2026, 9, lanc), hojeIso: HOJE });
    const c = conformidadeMes(proj);
    assert.equal(c.esperados, 14);
    assert.equal(c.completos, 13);
    assert.equal(c.incompletos, 1);
    assert.ok(c.taxa < 1);
  });
});

// ===========================================================================
// 5. Pendências acumuladas (atravessa a virada de mês)
// ===========================================================================
describe("pendenciasAcumuladas", () => {
  test("dias NÃO LANÇADO antes de D-1 são contados, com 'desde'", () => {
    const proj = projetarMes({ dias: mesDias(2026, 9, preencher("2026-09-01", "2026-09-10")), hojeIso: HOJE });
    const p = pendenciasAcumuladas(proj, HOJE);
    // 11,12,13,14 sem lançamento -> 11 PENDENTE, 12-14 BLOQUEADO; antes de D-1 (14): 11,12,13
    assert.deepEqual(p.dias, ["2026-09-11", "2026-09-12", "2026-09-13"]);
    assert.equal(p.total, 3);
    assert.equal(p.desde, "2026-09-11");
    assert.equal(p.sequenciaBloqueada, true);
  });

  test("cross-mês: pendência de agosto conta quando D-1 é 01/09", () => {
    const HOJE2 = "2026-09-02"; // D-1 = 2026-09-01
    const agosto = projetarMes({ dias: mesDias(2026, 8, preencher("2026-08-01", "2026-08-29")), hojeIso: HOJE2 }); // 30,31 pendentes
    const setembro = projetarMes({ dias: mesDias(2026, 9, {}), hojeIso: HOJE2 });
    const p = pendenciasAcumuladas([...agosto, ...setembro], HOJE2);
    assert.ok(p.dias.includes("2026-08-30"));
    assert.ok(p.dias.includes("2026-08-31"));
    assert.equal(p.desde, "2026-08-30");
  });

  test("sem pendência anterior -> total 0, sequenciaBloqueada false", () => {
    const proj = projetarMes({ dias: mesDias(2026, 9, preencher("2026-09-01", "2026-09-14")), hojeIso: HOJE });
    const p = pendenciasAcumuladas(proj, HOJE);
    assert.equal(p.total, 0);
    assert.equal(p.sequenciaBloqueada, false);
  });
});

// ===========================================================================
// 6. rollupUnidade — puramente sequencial, sem limiar
// ===========================================================================
describe("rollupUnidade", () => {
  const call = (d1cat, pendTotal = 0) => rollupUnidade({
    d1: { elegivel: true, categoria: d1cat },
    pendenciasAcum: { total: pendTotal, desde: pendTotal ? "2026-09-10" : null, sequenciaBloqueada: pendTotal > 0 },
  });

  test("pendência acumulada -> crítico", () => assert.equal(call(D1_CATEGORIA.NAO_REALIZADO, 3).status, ROLLUP.CRITICO));
  test("D-1 sequência bloqueada -> crítico", () => assert.equal(call(D1_CATEGORIA.SEQUENCIA_BLOQUEADA, 0).status, ROLLUP.CRITICO));
  test("D-1 não realizado (isolado) -> atenção", () => assert.equal(call(D1_CATEGORIA.NAO_REALIZADO, 0).status, ROLLUP.ATENCAO));
  test("D-1 em preenchimento -> atenção", () => assert.equal(call(D1_CATEGORIA.EM_PREENCHIMENTO, 0).status, ROLLUP.ATENCAO));
  test("D-1 concluído, nada antes -> em dia", () => assert.equal(call(D1_CATEGORIA.CONCLUIDO, 0).status, ROLLUP.EM_DIA));
  test("unidade nova (D-1 não aplicável), sem pendência -> em dia", () => {
    assert.equal(rollupUnidade({ d1: { elegivel: false, categoria: D1_CATEGORIA.NAO_APLICAVEL }, pendenciasAcum: { total: 0, sequenciaBloqueada: false } }).status, ROLLUP.EM_DIA);
  });
});

// ===========================================================================
// 7. avaliarUnidade — ponta a ponta
// ===========================================================================
describe("avaliarUnidade", () => {
  test("mês em dia: D-1 concluído, conformidade 100%, sem pendência", () => {
    const r = avaliarUnidade({ diasCorrente: mesDias(2026, 9, preencher("2026-09-01", "2026-09-14")), hojeIso: HOJE });
    assert.equal(r.d1.categoria, D1_CATEGORIA.CONCLUIDO);
    assert.equal(r.conformidade.taxa, 1);
    assert.equal(r.pendenciasAcum.total, 0);
    assert.equal(r.rollup.status, ROLLUP.EM_DIA);
  });

  test("D-1 não feito, resto ok -> atenção", () => {
    const r = avaliarUnidade({ diasCorrente: mesDias(2026, 9, preencher("2026-09-01", "2026-09-13")), hojeIso: HOJE });
    assert.equal(r.d1.categoria, D1_CATEGORIA.NAO_REALIZADO);
    assert.equal(r.rollup.status, ROLLUP.ATENCAO);
  });

  test("4 dias sem lançar -> crítico, sequência bloqueada", () => {
    const r = avaliarUnidade({ diasCorrente: mesDias(2026, 9, preencher("2026-09-01", "2026-09-10")), hojeIso: HOJE });
    assert.equal(r.d1.categoria, D1_CATEGORIA.SEQUENCIA_BLOQUEADA);
    assert.equal(r.pendenciasAcum.total, 3);
    assert.equal(r.rollup.status, ROLLUP.CRITICO);
  });
});

// ===========================================================================
// 8. Consolidação cross-unidade (Visão Geral + Ação Necessária Hoje)
// ===========================================================================
describe("consolidação cross-unidade", () => {
  const uni = (id, org, d1cat, rollupStatus, conf = { completos: 14, esperados: 14 }) => ({
    unidadeId: id, unidadeNome: `Unidade ${id}`, organizacaoId: org, empresaNome: `Empresa ${org}`,
    d1: { elegivel: d1cat !== D1_CATEGORIA.NAO_APLICAVEL, categoria: d1cat, data: D1 },
    conformidade: conf, pendenciasAcum: { total: rollupStatus === ROLLUP.CRITICO ? 2 : 0, desde: null },
    rollup: { status: rollupStatus },
  });

  const frota = [
    uni("a", "o1", D1_CATEGORIA.CONCLUIDO, ROLLUP.EM_DIA),
    uni("b", "o1", D1_CATEGORIA.EM_PREENCHIMENTO, ROLLUP.ATENCAO, { completos: 13, esperados: 14 }),
    uni("c", "o2", D1_CATEGORIA.NAO_REALIZADO, ROLLUP.ATENCAO, { completos: 12, esperados: 14 }),
    uni("d", "o2", D1_CATEGORIA.SEQUENCIA_BLOQUEADA, ROLLUP.CRITICO, { completos: 10, esperados: 14 }),
    uni("e", "o3", D1_CATEGORIA.NAO_APLICAVEL, ROLLUP.EM_DIA, { completos: 0, esperados: 0 }),
  ];

  test("acaoNecessariaHoje — agrupa por categoria de D-1, ignora não elegíveis", () => {
    const r = acaoNecessariaHoje(frota);
    assert.equal(r.total, 4); // 'e' não elegível fica de fora
    assert.equal(r.contadores.concluido, 1);
    assert.equal(r.contadores.em_preenchimento, 1);
    assert.equal(r.contadores.nao_realizado, 1);
    assert.equal(r.contadores.sequencia_bloqueada, 1);
    assert.equal(r.referencia, D1);
    assert.equal(r.grupos.sequencia_bloqueada[0].unidadeId, "d");
  });

  test("conformidadeD1 — headline: concluídas / elegíveis", () => {
    const c = conformidadeD1(frota);
    assert.equal(c.elegiveis, 4);
    assert.equal(c.concluidas, 1);
    assert.equal(c.taxa, 0.25);
    assert.equal(c.bloqueadas, 1);
  });

  test("consolidarOperacao — cards, conformidade mensal = Σnum/Σden (não média de %)", () => {
    const r = consolidarOperacao(frota);
    assert.equal(r.empresasMonitoradas, 3);
    assert.equal(r.unidadesMonitoradas, 5);
    assert.equal(r.emDia, 2);
    assert.equal(r.atencao, 2);
    assert.equal(r.criticas, 1);
    // Σcompletos = 14+13+12+10+0 = 49 ; Σesperados = 14+14+14+14+0 = 56
    assert.equal(r.conformidadeMes.completos, 49);
    assert.equal(r.conformidadeMes.esperados, 56);
    assert.ok(Math.abs(r.conformidadeMes.taxa - 49 / 56) < 1e-9);
  });

  test("agruparPorEmpresa — hierarquia empresa -> unidades", () => {
    const g = agruparPorEmpresa(frota);
    const o1 = g.find((x) => x.organizacaoId === "o1");
    assert.equal(o1.total, 2);
    assert.equal(o1.emDia, 1);
    assert.equal(o1.atencao, 1);
    const o2 = g.find((x) => x.organizacaoId === "o2");
    assert.equal(o2.criticas, 1);
  });
});

// ===========================================================================
// 9. Registro de monitores — extensível, iFood é o primeiro
// ===========================================================================
describe("listarMonitores", () => {
  test("Dashboard iFood é o monitor pronto; a estrutura não é hardcoded a ele", () => {
    const m = listarMonitores();
    const ifood = m.find((x) => x.chave === "dashboard_ifood");
    assert.ok(ifood);
    assert.equal(ifood.pronto, true);
    assert.equal(ifood.modulo, "ifood_dashboard");
  });
});

// ===========================================================================
// 10. Coerência com o domínio — a projeção acompanha statusMes
// ===========================================================================
describe("projeção == statusMes (fonte única)", () => {
  test("cada dia projetado corresponde ao status do statusMes do mesmo input", () => {
    const dias = mesDias(2026, 9, {
      ...preencher("2026-09-01", "2026-09-08"),
      "2026-09-09": rascunho(),           // -> RASCUNHO (não elegível)
      // 10..14 vazios
    });
    const domMes = statusMes({ dias, hojeIso: HOJE });
    const proj = projetarMes({ dias, hojeIso: HOJE });
    for (let i = 0; i < domMes.length; i++) {
      assert.equal(proj[i].data, domMes[i].data);
      assert.equal(proj[i].statusDia, domMes[i].status, `dia ${domMes[i].data}`);
    }
  });
});

describe("prazoFinalHoje — Checkpoint H.4-A.4, item 3-4", () => {
  test("data_referencia === diaAnterior(hojeIso) -> true (o D-1 vivo de hoje)", () => {
    assert.equal(prazoFinalHoje("2026-09-21", "2026-09-22"), true);
  });

  test("data_referencia de uma semana atrás -> false (backlog antigo, não 'vence hoje')", () => {
    assert.equal(prazoFinalHoje("2026-09-15", "2026-09-22"), false);
  });

  test("data_referencia no futuro (nunca deveria acontecer, mas não é 'hoje') -> false", () => {
    assert.equal(prazoFinalHoje("2026-09-23", "2026-09-22"), false);
  });

  test("data_referencia ausente/null -> false, nunca lança", () => {
    assert.equal(prazoFinalHoje(null, "2026-09-22"), false);
    assert.equal(prazoFinalHoje(undefined, "2026-09-22"), false);
  });

  test("nunca infere só por diasPendentes > 0 — a função nem recebe esse parâmetro (item 4)", () => {
    // Prova estrutural: a assinatura só aceita (dataReferencia, hojeIso) — a
    // regra fica impossível de reimplementar acidentalmente via contagem.
    assert.equal(prazoFinalHoje.length, 2);
  });
});
