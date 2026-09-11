// DESBLOQUEIO ADMINISTRATIVO de um dia do Dashboard iFood (migration 068).
//
// Cobre os 10 casos do pedido, nesta ordem:
//   1  fluxo normal            — D-1 continua disponível sem desbloqueio nenhum
//   2  dia bloqueado           — fora da sequência segue bloqueado sem exceção
//   3  desbloqueio             — libera EXCLUSIVAMENTE aquela data
//   4  isolamento por unidade  — liberar U1 não libera U2
//   5  isolamento por data     — liberar 02/09 não libera 03/09
//   6  isolamento por empresa  — liberação da Empresa A não toca a Empresa B
//   7  revogação               — antes do lançamento, o dia volta a travar
//   8  financeiro lançado      — o painel passa a mostrar REGULARIZADO
//   9  não conclui nada        — liberar não preenche e não tira da pendência
//   10 segurança               — usuário comum não alcança as rotas do painel
//
// COMPORTAMENTAL, sem rede: fake do Supabase com os verbos que o código usa
// (select/eq/in/gte/lte/insert/update/single/maybeSingle).
//
// Rodar: node --test test/administrativo-desbloqueio.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { statusMes, STATUS_DIA, diasDoMes } from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";
import {
  calendarioUnidade, desbloquearDia, revogarDesbloqueioDia, historicoDesbloqueios,
} from "../src/modules/administrativo/administrativo.service.js";
import { requirePainelAdministrativo } from "../src/middlewares/auth.js";
import { ApiError } from "../src/shared/ApiError.js";

const MOD = "ifood_dashboard";
const HOJE = "2026-09-15";          // D-1 = 14/09; setembro/2026 tem 30 dias
const D1 = "2026-09-14";
const TAB = "dashboard_ifood_desbloqueios";

const UUID = (label) => {
  const hex = Buffer.from(String(label)).toString("hex").padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const O1 = UUID("orgA"), O2 = UUID("orgB");
const U1 = UUID("uniA1"), U2 = UUID("uniA2"), U3 = UUID("uniB1");
const AUTOR = { id: UUID("ator"), nome: "João Pedro", email: "joao@crescer.com" };

// ---------------------------------------------------------------------------
// Fake do Supabase — superset do fake de administrativo-frota.test.js, com as
// ESCRITAS que só o desbloqueio usa (insert/update). Guarda as linhas em
// memória para que leitura-após-escrita funcione como no banco real.
// ---------------------------------------------------------------------------
function fakeDb(estado) {
  let seq = 0;
  function from(tabela) {
    const ctx = { eq: [], inFiltro: null, gte: null, lte: null };
    const rows = () => (estado[tabela] ??= []);
    const casa = (r) =>
      ctx.eq.every(([c, v]) => r[c] === v) &&
      (!ctx.inFiltro || ctx.inFiltro.vals.includes(r[ctx.inFiltro.col])) &&
      (ctx.gte == null || r[ctx.gte.col] >= ctx.gte.v) &&
      (ctx.lte == null || r[ctx.lte.col] <= ctx.lte.v);

    let pendente = null;   // { tipo: "insert"|"update", payload }

    function aplicar() {
      if (pendente?.tipo === "insert") {
        const linha = { id: UUID(`row${++seq}`), criado_em: "2026-09-15T10:00:00Z", ...pendente.payload };
        // Índice parcial único da 068: um ATIVO por (org, unidade, data, tipo).
        const colide = rows().some((r) =>
          r.status === "ativo" && linha.status === "ativo" &&
          r.organizacao_id === linha.organizacao_id && r.unidade_id === linha.unidade_id &&
          r.data_referencia === linha.data_referencia && r.tipo === linha.tipo);
        if (colide) return { data: null, error: { message: "duplicate key value violates unique constraint" } };
        rows().push(linha);
        return { data: { ...linha }, error: null };
      }
      if (pendente?.tipo === "update") {
        const alvos = rows().filter(casa);
        for (const r of alvos) Object.assign(r, pendente.payload);
        return { data: alvos[0] ? { ...alvos[0] } : null, error: null };
      }
      const achados = rows().filter(casa).map((r) => ({ ...r }));
      return { data: achados, error: null };
    }

    const b = {
      select() { return b; },
      eq(c, v) { ctx.eq.push([c, v]); return b; },
      in(c, vals) { ctx.inFiltro = { col: c, vals }; return b; },
      gte(c, v) { ctx.gte = { col: c, v }; return b; },
      lte(c, v) { ctx.lte = { col: c, v }; return b; },
      insert(payload) { pendente = { tipo: "insert", payload }; return b; },
      update(payload) { pendente = { tipo: "update", payload }; return b; },
      order() { return b; },
      range(de, ate) { const r = aplicar(); return Promise.resolve(Array.isArray(r.data) ? { ...r, data: r.data.slice(de, ate + 1) } : r); },
      single() { const r = aplicar(); return Promise.resolve(Array.isArray(r.data) ? { data: r.data[0] ?? null, error: r.error } : r); },
      maybeSingle() { const r = aplicar(); return Promise.resolve(Array.isArray(r.data) ? { data: r.data[0] ?? null, error: r.error } : r); },
      then(res, rej) { return Promise.resolve(aplicar()).then(res, rej); },
    };
    return b;
  }
  return { from };
}

const org = (id, nome) => ({ id, nome, status: "ativa", eh_modelo: false, created_at: "2025-01-01T00:00:00Z" });
const uni = (id, orgId, nome) => ({ id, organizacao_id: orgId, nome, ativo: true, eh_teste: false, created_at: "2025-01-01T00:00:00Z" });
const finaliz = (u, data, over = {}) => ({ unidade_id: u, data_lancamento: data, status: "finalizado", situacao: "normal", valor_vendas_ifood: 1234, ...over });

/** Duas empresas: A com 2 unidades, B com 1. Todas com o módulo efetivo. */
function base() {
  return {
    organizacoes: [org(O1, "Empresa A"), org(O2, "Empresa B")],
    unidades: [uni(U1, O1, "A · Unidade 1"), uni(U2, O1, "A · Unidade 2"), uni(U3, O2, "B · Unidade 1")],
    organizacao_modulos: [O1, O2].map((organizacao_id) => ({ organizacao_id, modulo_id: MOD })),
    unidade_modulos: [U1, U2, U3].map((unidade_id) => ({ unidade_id, modulo_id: MOD })),
    lancamentos_financeiros_diarios: [],
    [TAB]: [],
  };
}

/** Preenche (finalizado) de..até inclusive, no mesmo mês. */
function preenche(u, de, ate) {
  const [y, m] = de.split("-").map(Number);
  const out = [];
  for (let d = Number(de.slice(8)); d <= Number(ate.slice(8)); d++) {
    out.push(finaliz(u, `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`));
  }
  return out;
}

/**
 * Cenário do pedido: agosto inteiro OK; em setembro a unidade lançou 01 e
 * parou. 02/09 fica PENDENTE (fora da janela D-1) e 03..14 ficam BLOQUEADOS
 * pela sequência. É o beco sem saída que a exceção existe para resolver.
 */
function comBuraco(st, unidade) {
  st.lancamentos_financeiros_diarios.push(
    ...preenche(unidade, "2026-08-01", "2026-08-31"),
    finaliz(unidade, "2026-09-01"),
  );
  return st;
}

const diaDe = (cal, data) => cal.dias.find((d) => d.data === data);
const deps = (st) => ({ supabase: fakeDb(st) });

// ===========================================================================
// CASO 1 — fluxo normal: sem desbloqueio, nada muda
// ===========================================================================
describe("Caso 1 — fluxo normal (D-1) continua valendo sem nenhum desbloqueio", () => {
  test("statusMes sem desbloqueios é idêntico a statusMes com Set vazio", () => {
    const dias = diasDoMes(2026, 9).map((data) => ({ data, lancamento: null }));
    const semArg = statusMes({ dias, hojeIso: HOJE });
    const setVazio = statusMes({ dias, hojeIso: HOJE, desbloqueios: new Set() });
    assert.deepEqual(setVazio, semArg);
  });

  test("D-1 é elegível para o Financeiro e NÃO é oferecido para desbloqueio", async () => {
    const st = comBuraco(base(), U1);
    const cal = await calendarioUnidade({ unidadeId: U1, hojeIso: HOJE }, deps(st));
    const d1 = diaDe(cal, D1);
    // Está bloqueado pela sequência (02/09 em diante travou), então AQUI o
    // desbloqueio faz sentido — o que a regra garante é que um D-1 livre não
    // precise de exceção; ver o teste seguinte.
    assert.equal(d1.bloqueada, true);

    const limpo = base();
    limpo.lancamentos_financeiros_diarios.push(
      ...preenche(U1, "2026-08-01", "2026-08-31"), ...preenche(U1, "2026-09-01", "2026-09-13"),
    );
    const calOk = await calendarioUnidade({ unidadeId: U1, hojeIso: HOJE }, deps(limpo));
    const d1Livre = diaDe(calOk, D1);
    assert.equal(d1Livre.bloqueada, false);
    assert.equal(d1Livre.podeDesbloquear, false, "D-1 disponível pela regra normal não precisa de exceção");
  });
});

// ===========================================================================
// CASO 2 — dia fora da sequência continua bloqueado
// ===========================================================================
describe("Caso 2 — sem desbloqueio, o dia fora da sequência segue bloqueado", () => {
  test("02/09 pendente e 03..14 bloqueados; nenhum deles é elegível ao Financeiro", async () => {
    const st = comBuraco(base(), U1);
    const cal = await calendarioUnidade({ unidadeId: U1, hojeIso: HOJE }, deps(st));

    assert.equal(diaDe(cal, "2026-09-02").statusDia, STATUS_DIA.PENDENTE);
    assert.equal(diaDe(cal, "2026-09-03").statusDia, STATUS_DIA.BLOQUEADO);
    assert.equal(diaDe(cal, "2026-09-10").statusDia, STATUS_DIA.BLOQUEADO);
    assert.equal(cal.sequenciaBloqueada, true);

    // E são candidatos a desbloqueio — é exatamente o beco sem saída.
    assert.equal(diaDe(cal, "2026-09-02").podeDesbloquear, true);
    assert.equal(diaDe(cal, "2026-09-03").podeDesbloquear, true);
  });

  test("statusMes puro: sem liberação, 03/09 é BLOQUEADO e não é elegível", () => {
    const dias = diasDoMes(2026, 9).map((data) => ({
      data, lancamento: data === "2026-09-01" ? { status: "finalizado", situacao: "normal", valor_vendas_ifood: 1 } : null,
    }));
    const r = statusMes({ dias, hojeIso: HOJE });
    const d3 = r.find((d) => d.data === "2026-09-03");
    assert.equal(d3.status, STATUS_DIA.BLOQUEADO);
    assert.equal(d3.elegivelFinanceiro, false);
    assert.equal(d3.desbloqueadoAdmin, false);
  });
});

// ===========================================================================
// CASO 3 — o desbloqueio libera EXCLUSIVAMENTE aquela data
// ===========================================================================
describe("Caso 3 — desbloqueio libera a data pedida", () => {
  test("após liberar 02/09, o dia sai de bloqueado e o Financeiro passa a ser oferecido", async () => {
    const st = comBuraco(base(), U1);
    const r = await desbloquearDia({
      unidadeId: U1, data: "2026-09-02", motivo: "dia_nao_lancado", hojeIso: HOJE, autor: AUTOR,
    }, deps(st));

    assert.equal(r.desbloqueio.data, "2026-09-02");
    assert.equal(r.desbloqueio.status, "ativo");
    assert.equal(r.desbloqueio.organizacaoId, O1, "organizacao_id vem da unidade, nunca do cliente");
    assert.equal(r.desbloqueio.criadoPorNome, "João Pedro");

    const cal = await calendarioUnidade({ unidadeId: U1, hojeIso: HOJE }, deps(st));
    const d2 = diaDe(cal, "2026-09-02");
    assert.equal(d2.desbloqueadoAdmin, true);
    assert.equal(d2.situacaoDesbloqueio, "aguardando_lancamento");
    assert.equal(d2.podeDesbloquear, false, "já liberado não oferece liberar de novo");
    assert.ok(d2.liberacaoAtiva, "o dia carrega a liberação ativa para o botão de revogar");
  });

  test("statusMes: a data liberada vira elegível ao Financeiro e deixa de bloquear", () => {
    const dias = diasDoMes(2026, 9).map((data) => ({
      data, lancamento: data === "2026-09-01" ? { status: "finalizado", situacao: "normal", valor_vendas_ifood: 1 } : null,
    }));
    const r = statusMes({ dias, hojeIso: HOJE, desbloqueios: new Set(["2026-09-03"]) });
    const d3 = r.find((d) => d.data === "2026-09-03");
    assert.equal(d3.status, STATUS_DIA.PENDENTE, "sai de BLOQUEADO");
    assert.equal(d3.elegivelFinanceiro, true);
    assert.equal(d3.desbloqueadoAdmin, true);
  });

  test("liberar o MESMO dia duas vezes é recusado com 409 (índice parcial da 068)", async () => {
    const st = comBuraco(base(), U1);
    const p = { unidadeId: U1, data: "2026-09-02", motivo: "falha_operacional", hojeIso: HOJE, autor: AUTOR };
    await desbloquearDia(p, deps(st));
    await assert.rejects(() => desbloquearDia(p, deps(st)), (e) => e instanceof ApiError && e.statusCode === 409);
  });

  test("recusa data futura, hoje, motivo inválido e \"outro\" sem observação", async () => {
    const st = comBuraco(base(), U1);
    const d = deps(st);
    const bad = (over) => desbloquearDia({ unidadeId: U1, data: "2026-09-02", motivo: "dia_nao_lancado", hojeIso: HOJE, autor: AUTOR, ...over }, d);

    await assert.rejects(() => bad({ data: "2026-09-20" }), /já encerrado/);
    await assert.rejects(() => bad({ data: HOJE }), /já encerrado/);
    await assert.rejects(() => bad({ motivo: "porque_sim" }), ApiError);
    await assert.rejects(() => bad({ motivo: "outro" }), /observação/i);
    // "outro" COM observação passa
    const ok = await bad({ motivo: "outro", observacao: "Extrato do iFood saiu com atraso." });
    assert.equal(ok.desbloqueio.motivo, "outro");
    assert.equal(ok.desbloqueio.observacao, "Extrato do iFood saiu com atraso.");
  });
});

// ===========================================================================
// CASOS 4, 5 e 6 — isolamento (unidade, data, empresa)
// ===========================================================================
describe("Casos 4/5/6 — isolamento total da liberação", () => {
  test("Caso 4 — liberar a Unidade 1 não libera a Unidade 2 da MESMA empresa", async () => {
    const st = base();
    comBuraco(st, U1);
    comBuraco(st, U2);
    await desbloquearDia({ unidadeId: U1, data: "2026-09-02", motivo: "dia_nao_lancado", hojeIso: HOJE, autor: AUTOR }, deps(st));

    const calU1 = await calendarioUnidade({ unidadeId: U1, hojeIso: HOJE }, deps(st));
    const calU2 = await calendarioUnidade({ unidadeId: U2, hojeIso: HOJE }, deps(st));
    assert.equal(diaDe(calU1, "2026-09-02").desbloqueadoAdmin, true);
    assert.equal(diaDe(calU2, "2026-09-02").desbloqueadoAdmin, false, "a unidade vizinha não foi tocada");
    assert.equal(diaDe(calU2, "2026-09-03").statusDia, STATUS_DIA.BLOQUEADO);
  });

  test("Caso 5 — liberar 02/09 não libera 03/09", async () => {
    const st = comBuraco(base(), U1);
    await desbloquearDia({ unidadeId: U1, data: "2026-09-02", motivo: "dia_nao_lancado", hojeIso: HOJE, autor: AUTOR }, deps(st));
    const cal = await calendarioUnidade({ unidadeId: U1, hojeIso: HOJE }, deps(st));

    assert.equal(diaDe(cal, "2026-09-02").desbloqueadoAdmin, true);
    assert.equal(diaDe(cal, "2026-09-03").desbloqueadoAdmin, false);
    // 03/09 continua sem lançamento; como 02/09 ainda não foi preenchido, ele
    // segue travado pela sequência — liberar um dia não solta a fila inteira.
    assert.equal(diaDe(cal, "2026-09-03").statusDia, STATUS_DIA.BLOQUEADO);
  });

  test("Caso 6 — liberação da Empresa A não afeta nenhuma unidade da Empresa B", async () => {
    const st = base();
    comBuraco(st, U1);
    comBuraco(st, U3);
    await desbloquearDia({ unidadeId: U1, data: "2026-09-02", motivo: "correcao_administrativa", hojeIso: HOJE, autor: AUTOR }, deps(st));

    const calB = await calendarioUnidade({ unidadeId: U3, hojeIso: HOJE }, deps(st));
    assert.equal(diaDe(calB, "2026-09-02").desbloqueadoAdmin, false);
    assert.equal(calB.liberacoes.total, 0);

    const histB = await historicoDesbloqueios({ unidadeId: U3, hojeIso: HOJE }, deps(st));
    assert.equal(histB.desbloqueios.length, 0, "o histórico da Empresa B está vazio");
  });

  test("revogar com o id de OUTRA unidade não encontra nada (404)", async () => {
    const st = base();
    comBuraco(st, U1);
    comBuraco(st, U2);
    const criado = await desbloquearDia({ unidadeId: U1, data: "2026-09-02", motivo: "dia_nao_lancado", hojeIso: HOJE, autor: AUTOR }, deps(st));
    await assert.rejects(
      () => revogarDesbloqueioDia({ unidadeId: U2, desbloqueioId: criado.desbloqueio.id, hojeIso: HOJE, autor: AUTOR }, deps(st)),
      (e) => e instanceof ApiError && e.statusCode === 404,
    );
  });
});

// ===========================================================================
// CASO 7 — revogação
// ===========================================================================
describe("Caso 7 — revogar antes do lançamento devolve o dia à regra normal", () => {
  test("após revogar, o dia volta a BLOQUEADO e o histórico permanece", async () => {
    const st = comBuraco(base(), U1);
    const criado = await desbloquearDia({ unidadeId: U1, data: "2026-09-03", motivo: "dia_nao_lancado", hojeIso: HOJE, autor: AUTOR }, deps(st));

    const rev = await revogarDesbloqueioDia({
      unidadeId: U1, desbloqueioId: criado.desbloqueio.id, hojeIso: HOJE,
      autor: { ...AUTOR, nome: "Revogador" },
    }, deps(st));
    assert.equal(rev.desbloqueio.status, "revogado");
    assert.equal(rev.desbloqueio.revogadoPorNome, "Revogador");
    assert.ok(rev.desbloqueio.revogadoEm);

    const cal = await calendarioUnidade({ unidadeId: U1, hojeIso: HOJE }, deps(st));
    assert.equal(diaDe(cal, "2026-09-03").desbloqueadoAdmin, false);
    assert.equal(diaDe(cal, "2026-09-03").statusDia, STATUS_DIA.BLOQUEADO, "voltou a obedecer só a regra normal");

    // Histórico preservado (item 6: não apagar o registro).
    const hist = await historicoDesbloqueios({ unidadeId: U1, hojeIso: HOJE }, deps(st));
    assert.equal(hist.desbloqueios.length, 1);
    assert.equal(hist.desbloqueios[0].status, "revogado");
  });

  test("revogar duas vezes: a segunda é 404 (não há ativo)", async () => {
    const st = comBuraco(base(), U1);
    const criado = await desbloquearDia({ unidadeId: U1, data: "2026-09-03", motivo: "dia_nao_lancado", hojeIso: HOJE, autor: AUTOR }, deps(st));
    const p = { unidadeId: U1, desbloqueioId: criado.desbloqueio.id, hojeIso: HOJE, autor: AUTOR };
    await revogarDesbloqueioDia(p, deps(st));
    await assert.rejects(() => revogarDesbloqueioDia(p, deps(st)), (e) => e instanceof ApiError && e.statusCode === 404);
  });

  test("depois de revogar, a MESMA data pode ser liberada de novo (índice é parcial)", async () => {
    const st = comBuraco(base(), U1);
    const criado = await desbloquearDia({ unidadeId: U1, data: "2026-09-02", motivo: "dia_nao_lancado", hojeIso: HOJE, autor: AUTOR }, deps(st));
    await revogarDesbloqueioDia({ unidadeId: U1, desbloqueioId: criado.desbloqueio.id, hojeIso: HOJE, autor: AUTOR }, deps(st));
    const denovo = await desbloquearDia({ unidadeId: U1, data: "2026-09-02", motivo: "falha_operacional", hojeIso: HOJE, autor: AUTOR }, deps(st));
    assert.equal(denovo.desbloqueio.status, "ativo");

    const hist = await historicoDesbloqueios({ unidadeId: U1, hojeIso: HOJE }, deps(st));
    assert.equal(hist.desbloqueios.length, 2, "as duas linhas coexistem — o histórico é o produto");
  });
});

// ===========================================================================
// CASO 8 — financeiro lançado -> painel mostra regularizado
// ===========================================================================
describe("Caso 8 — depois do lançamento, o painel mostra REGULARIZADO", () => {
  test("dia liberado + financeiro preenchido => situacaoDesbloqueio = regularizado", async () => {
    const st = comBuraco(base(), U1);
    await desbloquearDia({ unidadeId: U1, data: "2026-09-02", motivo: "dia_nao_lancado", hojeIso: HOJE, autor: AUTOR }, deps(st));

    // A unidade entra e preenche de verdade (é o único jeito de regularizar).
    st.lancamentos_financeiros_diarios.push(finaliz(U1, "2026-09-02"));

    const cal = await calendarioUnidade({ unidadeId: U1, hojeIso: HOJE }, deps(st));
    const d2 = diaDe(cal, "2026-09-02");
    assert.equal(d2.completo, true);
    assert.equal(d2.situacaoDesbloqueio, "regularizado");
    assert.equal(cal.liberacoes.total, 0, "não é mais uma liberação aguardando");
    assert.equal(cal.liberacoes.regularizados, 1);
  });

  test("revogar depois do lançamento é recusado (409) — não se desfaz dado gravado", async () => {
    const st = comBuraco(base(), U1);
    const criado = await desbloquearDia({ unidadeId: U1, data: "2026-09-02", motivo: "dia_nao_lancado", hojeIso: HOJE, autor: AUTOR }, deps(st));
    st.lancamentos_financeiros_diarios.push(finaliz(U1, "2026-09-02"));

    await assert.rejects(
      () => revogarDesbloqueioDia({ unidadeId: U1, desbloqueioId: criado.desbloqueio.id, hojeIso: HOJE, autor: AUTOR }, deps(st)),
      (e) => e instanceof ApiError && e.statusCode === 409,
    );
  });
});

// ===========================================================================
// CASO 9 — desbloquear NÃO conclui, NÃO preenche, NÃO tira da pendência
// ===========================================================================
describe("Caso 9 — liberar não é preencher", () => {
  test("nenhum lançamento é criado e o dia continua NÃO LANÇADO e pendente", async () => {
    const st = comBuraco(base(), U1);
    const antes = st.lancamentos_financeiros_diarios.length;

    await desbloquearDia({ unidadeId: U1, data: "2026-09-02", motivo: "dia_nao_lancado", hojeIso: HOJE, autor: AUTOR }, deps(st));

    assert.equal(st.lancamentos_financeiros_diarios.length, antes, "não criou lançamento nenhum");

    const cal = await calendarioUnidade({ unidadeId: U1, hojeIso: HOJE }, deps(st));
    const d2 = diaDe(cal, "2026-09-02");
    assert.equal(d2.completo, false);
    assert.equal(d2.painel, "NAO_LANCADO");
    assert.equal(d2.statusDia, STATUS_DIA.PENDENTE);
    assert.equal(cal.sequenciaBloqueada, true, "a unidade NÃO passou a parecer em dia");
  });

  test("destaque de risco: dias liberados e ainda vazios são contados (item 12)", async () => {
    const st = comBuraco(base(), U1);
    for (const data of ["2026-09-02", "2026-09-03"]) {
      await desbloquearDia({ unidadeId: U1, data, motivo: "dia_nao_lancado", hojeIso: HOJE, autor: AUTOR }, deps(st));
    }
    const cal = await calendarioUnidade({ unidadeId: U1, hojeIso: HOJE }, deps(st));
    assert.equal(cal.liberacoes.total, 2);
    assert.deepEqual(cal.liberacoes.dias, ["2026-09-02", "2026-09-03"]);
  });
});

// ===========================================================================
// CASO 10 — segurança
// ===========================================================================
describe("Caso 10 — só o Painel Administrativo alcança estas rotas", () => {
  const chamar = (user) => {
    let erro = null;
    requirePainelAdministrativo({ user }, null, (e) => { erro = e ?? null; });
    return erro;
  };

  test("usuário comum de empresa é barrado (403), mesmo chamando o endpoint direto", () => {
    const erro = chamar({ id: UUID("comum"), superadmin: false, painelAdministrativo: false });
    assert.ok(erro instanceof ApiError);
    assert.equal(erro.statusCode, 403);
  });

  test("usuário sem sessão nenhuma é barrado", () => {
    assert.ok(chamar(undefined) instanceof ApiError);
  });

  test("usuário do Painel Administrativo passa; SuperAdmin passa por bypass", () => {
    assert.equal(chamar({ id: UUID("padm"), painelAdministrativo: true }), null);
    assert.equal(chamar({ id: UUID("sa"), superadmin: true }), null);
  });

  test("unidade fora do monitoramento não pode ser liberada (404)", async () => {
    const st = base();
    st.unidade_modulos = st.unidade_modulos.filter((x) => x.unidade_id !== U1);
    await assert.rejects(
      () => desbloquearDia({ unidadeId: U1, data: "2026-09-02", motivo: "dia_nao_lancado", hojeIso: HOJE, autor: AUTOR }, deps(st)),
      (e) => e instanceof ApiError && e.statusCode === 404,
    );
  });
});

// ===========================================================================
// Banco sem a migration 068 — o sistema inteiro segue funcionando
// ===========================================================================
describe("Tolerância — banco sem a tabela 068", () => {
  test("o calendário responde normalmente (comportamento de antes da exceção)", async () => {
    const st = comBuraco(base(), U1);
    delete st[TAB];
    // O fake cria a tabela vazia sob demanda; simular ausência de verdade é
    // trabalho do banco. Aqui garantimos ao menos que zero liberações não
    // altera nada do resultado esperado.
    const cal = await calendarioUnidade({ unidadeId: U1, hojeIso: HOJE }, deps(st));
    assert.equal(diaDe(cal, "2026-09-03").statusDia, STATUS_DIA.BLOQUEADO);
    assert.equal(cal.liberacoes.total, 0);
  });
});
