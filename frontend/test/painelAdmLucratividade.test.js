// PAINEL ADMINISTRATIVO — área Relatórios: abas SEMANAIS Lucratividade e
// Rentabilidade.
//
// Regras que esta suíte protege:
//   * os rankings principais mostram TODAS as empresas — nunca Top 5/10;
//   * o Top 10 aparece só nos recortes "operações que exigem atenção";
//   * a eficiência de deduções é medida frente ao limite do modelo da loja;
//   * a aba Lucratividade não exibe métrica de rentabilidade;
//   * navegar entre semanas refaz a chamada; trocar de aba/filtro/ordem não.
//
// Rodar: node --test frontend/test/painelAdmLucratividade.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---- fake DOM mínimo (mesmo esqueleto de painelAdmRelatorios.test.js) ------
function attr(tag, nome) { const m = new RegExp(`${nome}="([^"]*)"`).exec(tag); return m ? m[1] : null; }
function fakeNode(tag) {
  return {
    _tag: tag, hidden: false, disabled: /\sdisabled/.test(tag), value: attr(tag, "value") ?? "",
    dataset: {
      padmAba: attr(tag, "data-padm-aba") ?? undefined,
      padmSemana: attr(tag, "data-padm-semana") ?? undefined,
      padmAcao: attr(tag, "data-padm-acao") ?? undefined,
      padmLucModelo: attr(tag, "data-padm-luc-modelo") ?? undefined,
      padmOrd: attr(tag, "data-padm-ord") ?? undefined,
    },
    id: attr(tag, "id") ?? "",
    _l: {},
    addEventListener(ev, fn) { (this._l[ev] ||= []).push(fn); },
    dispatch(ev, arg) { (this._l[ev] ?? []).forEach((f) => f(arg ?? { preventDefault() {}, target: this })); },
    focus() {}, setSelectionRange() {}, remove() {}, click() { this.dispatch("click"); }, closest() { return null; },
  };
}
let padmView;
function makeView() {
  const store = { abas: [], semana: [], acao: [], modelo: [], ord: [] };
  return {
    _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      for (const k of Object.keys(store)) store[k] = [];
      for (const t of this._html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
        const n = fakeNode(t);
        if (n.dataset.padmAba) store.abas.push(n);
        if (n.dataset.padmSemana) store.semana.push(n);
        if (n.dataset.padmAcao) store.acao.push(n);
        if (n.dataset.padmLucModelo) store.modelo.push(n);
        if (n.dataset.padmOrd) store.ord.push(n);
      }
    },
    _store: store,
  };
}
globalThis.document = {
  querySelector: (sel) => {
    if (sel === "#padm-view") return padmView;
    const a = /\[data-padm-acao="([^"]+)"\]/.exec(sel);
    if (a) return padmView._store.acao.find((n) => n.dataset.padmAcao === a[1]) ?? null;
    return null;
  },
  querySelectorAll: (sel) => {
    if (sel === "[data-padm-aba]") return padmView._store.abas;
    if (sel === "[data-padm-semana]") return padmView._store.semana;
    if (sel === "[data-padm-luc-modelo]") return padmView._store.modelo;
    if (sel === "[data-padm-ord]") return padmView._store.ord;
    return [];
  },
  createElement: () => fakeNode("<a>"),
  body: { appendChild() {}, classList: { toggle() {} } },
};
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.Blob = class { constructor(p, o) { this.partes = p; this.type = o?.type; } };
globalThis.URL = { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} };

const V = await import("../src/painelAdmViews.js");

// ---- fixtures -------------------------------------------------------------
const RELATORIO = { periodo: "2026-09", d1: "2026-09-15", faturamento: { total: 1 }, operacao: {}, conformidade: {}, rankings: {}, prioridades: {} };
const EVOLUCAO = { periodo: "2026-09", serie: [] };

// 12 unidades em 8 empresas — "Grupo JV" tem 3 unidades (o caso injusto do
// ranking consolidado). Cada unidade compete individualmente.
function unidade(nome, empresaNome, organizacaoId, faturamento, rentPct, modeloLogistico, i) {
  const receita = faturamento == null ? null : Math.round(faturamento * (rentPct / 100));
  const rot = modeloLogistico === "marketplace" ? "Marketplace" : modeloLogistico === "full_service" ? "Full Service" : null;
  const limite = modeloLogistico === "marketplace" ? 15 : modeloLogistico === "full_service" ? 25 : null;
  const deducoesPct = faturamento == null ? null : 100 - rentPct;
  const folga = limite == null || deducoesPct == null ? null : Math.round((limite - deducoesPct) * 10) / 10;
  const chave = limite == null ? "sem_dados" : folga >= 3 ? "dentro_da_meta" : folga >= 0 ? "dentro_do_limite" : "atencao";
  return {
    unidadeId: `u${i}`, nome, empresaNome, organizacaoId,
    modeloLogistico, modeloLogisticoRotulo: rot,
    faturamento, faturamentoAnterior: faturamento == null ? null : Math.round(faturamento * 0.95),
    variacaoFaturamento: faturamento == null ? null : 0.05,
    deducoes: faturamento == null ? null : faturamento - receita,
    deducoesPct,
    meta: limite == null ? null : { metaIdeal: limite - 3, limite },
    folgaLimitePp: folga,
    status: { chave, label: chave },
    receitaLiquida: receita, rentabilidadeReais: receita,
    rentabilidadePct: faturamento == null ? null : rentPct,
    rentabilidadePctAnterior: rentPct, variacaoRentabilidadePp: 0.5,
  };
}

function LUC() {
  const unidades = [];
  // 3 unidades do Grupo JV — a soma delas seria a maior, mas competem separadas
  unidades.push(unidade("JV Loja A", "Grupo JV", "jv", 6000, 95, "marketplace", 0));
  unidades.push(unidade("JV Loja B", "Grupo JV", "jv", 5500, 78, "marketplace", 1));
  unidades.push(unidade("JV Loja C", "Grupo JV", "jv", 5000, 71, "full_service", 2));
  // 9 unidades de 9 empresas distintas
  for (let i = 0; i < 9; i++) {
    unidades.push(unidade(`Unidade ${String(i).padStart(2, "0")}`, `Empresa ${String(i).padStart(2, "0")}`, `o${i}`,
      i === 8 ? null : 9000 - i * 800, 92 - i * 2, i % 2 ? "full_service" : "marketplace", 10 + i));
  }
  // ordenação de entrega: maior faturamento primeiro; sem dado por último
  unidades.sort((a, b) => (b.faturamento ?? -1) - (a.faturamento ?? -1));

  const comFat = unidades.filter((u) => u.faturamento != null);
  const menorFaturamento = [...comFat].sort((a, b) => a.faturamento - b.faturamento).slice(0, 10)
    .map((u) => ({ unidadeId: u.unidadeId, nome: u.nome, empresaNome: u.empresaNome, organizacaoId: u.organizacaoId, faturamento: u.faturamento, rentabilidadePct: u.rentabilidadePct, variacaoFaturamento: u.variacaoFaturamento, posicaoGeral: comFat.length }));
  const menorRentabilidade = [...comFat].sort((a, b) => a.rentabilidadePct - b.rentabilidadePct).slice(0, 10)
    .map((u) => ({ unidadeId: u.unidadeId, nome: u.nome, empresaNome: u.empresaNome, organizacaoId: u.organizacaoId, faturamento: u.faturamento, receitaLiquida: u.receitaLiquida, rentabilidadePct: u.rentabilidadePct, posicaoGeral: comFat.length }));

  const efic = unidades.filter((u) => u.folgaLimitePp != null);
  const ctx = (u) => ({ unidadeId: u.unidadeId, nome: u.nome, empresaNome: u.empresaNome, organizacaoId: u.organizacaoId });
  return {
    monitor: "dashboard_ifood",
    semana: { ano: 2026, mes: 9, indice: 2, inicio: "2026-09-08", fim: "2026-09-14", ateData: "2026-09-14", ehSemanaCorrente: false, anterior: { ano: 2026, mes: 9, indice: 1, inicio: "2026-09-01", fim: "2026-09-07" } },
    podeAvancar: true,
    rede: { empresasMonitoradas: 10, unidadesMonitoradas: 12, faturamento: 90000, faturamentoAnterior: 85000, variacaoFaturamento: 0.0588, deducoes: 15000, deducoesPct: 16.7, receitaLiquida: 75000, receitaLiquidaAnterior: 70000, variacaoReceitaLiquida: 0.071, rentabilidadeMediaRede: 83.3, rentabilidadeMediaRedeAnterior: 82, variacaoRentabilidadeMediaPp: 1.3 },
    unidades,
    destaques: {
      melhorEficiencia: { ...ctx(efic.reduce((m, u) => (u.folgaLimitePp > m.folgaLimitePp ? u : m))), modeloLogisticoRotulo: "Marketplace", deducoesPct: 10, meta: { metaIdeal: 12, limite: 15 }, folgaLimitePp: 5, status: { chave: "dentro_da_meta", label: "dentro_da_meta" } },
      piorEficiencia: { ...ctx(efic.reduce((m, u) => (u.folgaLimitePp < m.folgaLimitePp ? u : m))), modeloLogisticoRotulo: "Full Service", deducoesPct: 30, meta: { metaIdeal: 22, limite: 25 }, folgaLimitePp: -5, status: { chave: "atencao", label: "atencao" } },
      maiorRentabilidade: { ...ctx(comFat.reduce((m, u) => (u.rentabilidadePct > m.rentabilidadePct ? u : m))), modeloLogisticoRotulo: "Marketplace", rentabilidadePct: 92, rentabilidadeReais: 8280, faturamento: 9000 },
    },
    atencao: { menorFaturamento, menorRentabilidade },
  };
}

const estadoLuc = () => ({ ...V.viewRelatorios, aba: "lucratividade" });
const estadoRent = () => ({ ...V.viewRelatorios, aba: "rentabilidade" });

beforeEach(() => { padmView = makeView(); V.resetFiltrosIdentificacao(); });

// ===========================================================================
describe("navegação de abas e período", () => {
  test("Lucratividade e Rentabilidade aparecem ao lado de Evolução", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoLuc(), LUC());
    const iEvo = h.indexOf('data-padm-aba="evolucao"');
    const iLuc = h.indexOf('data-padm-aba="lucratividade"');
    const iRent = h.indexOf('data-padm-aba="rentabilidade"');
    assert.ok(iEvo < iLuc && iLuc < iRent, "ordem: Evolução, Lucratividade, Rentabilidade");
  });

  test("o navegador de bloco substitui a faixa mensal e mostra Semana N + intervalo", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoLuc(), LUC());
    assert.match(h, /data-padm-semana="anterior"/);
    assert.match(h, /data-padm-semana="proxima"/);
    assert.match(h, /Semana 2 · 08\/09\s*–\s*14\/09\/2026/);
  });

  test("nas abas semanais não há botão de PDF (é o relatório mensal)", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoLuc(), LUC());
    assert.doesNotMatch(h, /data-padm-acao="pdf"/);
    assert.match(h, /data-padm-acao="csv"/);
  });

  test("sem pacote ainda -> esqueleto de carregamento", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoLuc(), null);
    assert.match(h, /padm-carregando/);
  });
});

describe("ranking POR UNIDADE (não consolida empresa)", () => {
  test("as 3 unidades do Grupo JV aparecem em linhas separadas, cada uma com a empresa como contexto", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoLuc(), LUC());
    for (const nome of ["JV Loja A", "JV Loja B", "JV Loja C"]) assert.ok(h.includes(nome), `${nome} no ranking`);
    // não existe uma linha "Grupo JV" consolidada, mas o nome aparece como contexto
    assert.doesNotMatch(h, /<b>Grupo JV<\/b>/);
    assert.match(h, /Grupo JV/);
  });

  test("nenhuma soma de unidades: a maior linha não é a soma do grupo (16.500)", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoLuc(), LUC());
    assert.doesNotMatch(h, /16\.500/);
  });
});

describe("aba Lucratividade", () => {
  test("ranking de faturamento traz TODAS as 12 unidades (sem Top N)", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoLuc(), LUC());
    for (const u of LUC().unidades) assert.ok(h.includes(u.nome), `${u.nome} no ranking`);
  });

  test("não exibe métrica de rentabilidade (essa é a outra aba)", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoLuc(), LUC());
    assert.doesNotMatch(h, /Rentabilidade %/);
    assert.doesNotMatch(h, /Receita líquida/);
  });

  test("eficiência de deduções: status por unidade + destaques melhor/pior", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoLuc(), LUC());
    assert.match(h, /Melhor eficiência de deduções/);
    assert.match(h, /Pior eficiência de deduções/);
    assert.match(h, /Acima do limite/);
    assert.match(h, /Dentro do ideal/);
  });

  test("unidade sem dado permanece null/— e não some do ranking", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoLuc(), LUC());
    assert.match(h, /Unidade 08/);   // a que tem faturamento null
  });

  test("filtro Todos / Marketplace / Full Service presente", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoLuc(), LUC());
    assert.match(h, /data-padm-luc-modelo="marketplace"/);
    assert.match(h, /data-padm-luc-modelo="full_service"/);
  });

  test("recorte '10 menores faturamentos' — exatamente 10 linhas de unidade", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoLuc(), LUC());
    const secao = h.slice(h.indexOf("10 menores faturamentos"));
    const linhas = (secao.match(/<tr /g) ?? []).length;
    assert.equal(linhas, 10, `esperado 10 linhas de corpo, veio ${linhas}`);
  });
});

describe("aba Rentabilidade", () => {
  test("colunas do ranking na ordem pedida (Unidade primeiro, Variação no fim)", () => {
    const full = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoRent(), LUC());
    const ini = full.indexOf("Ranking de Rentabilidade");
    const h = full.slice(ini, full.indexOf("</thead>", ini));
    const ordem = ["Unidade / Empresa", "Modelo", "Faturamento", "Deduções R$", "Deduções %", "Receita líquida R$", "Rentabilidade %", "vs semana anterior"];
    let pos = -1;
    for (const c of ordem) { const p = h.indexOf(`>${c}`); assert.ok(p > pos, `${c} fora de ordem (pos ${p})`); pos = p; }
  });

  test("destaque 'Maior rentabilidade do período' aponta uma UNIDADE + empresa", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoRent(), LUC());
    assert.match(h, /Maior rentabilidade do período/);
    assert.match(h, /JV Loja A/);
    assert.match(h, /Empresa <b>Grupo JV<\/b>/);
  });

  test("dois recortes separados de 10, por unidade", () => {
    const h = V.htmlRelatorios(RELATORIO, EVOLUCAO, estadoRent(), LUC());
    assert.match(h, /10 menores em faturamento/);
    assert.match(h, /10 menores em rentabilidade/);
  });
});

describe("helpers de bloco semanal (fixo do mês)", () => {
  test("semanaDe: 01–07 / 08–14 / 15–21 / 22–fim, nunca Semana 5", () => {
    assert.deepEqual(V.semanaDe("2026-09-09"), { ano: 2026, mes: 9, indice: 2, inicio: "2026-09-08", fim: "2026-09-14" });
    assert.equal(V.semanaDe("2026-09-01").indice, 1);
    assert.equal(V.semanaDe("2026-09-29").indice, 4);
    assert.equal(V.semanaDe("2026-09-25").fim, "2026-09-30");
    assert.equal(V.semanaDe("2024-02-25").fim, "2024-02-29");
  });
  test("deslocarSemana: Semana 1 -> Semana 4 do mês anterior; Semana 4 -> Semana 1 do seguinte", () => {
    assert.equal(V.deslocarSemana("2026-09-01", -1), "2026-08-22");
    assert.equal(V.deslocarSemana("2026-09-22", 1), "2026-10-01");
    assert.equal(V.deslocarSemana("2026-01-03", -1), "2025-12-22");
  });
});

describe("CSV semanal (por unidade)", () => {
  test("Lucratividade: seções por unidade, com coluna Empresa", () => {
    const csv = V.csvDaLucratividade(LUC());
    assert.match(csv, /RANKING SEMANAL DE FATURAMENTO \(UNIDADES\)/);
    assert.match(csv, /EFICIÊNCIA DE DESCONTOS E DEDUÇÕES \(UNIDADES\)/);
    assert.match(csv, /10 MENORES FATURAMENTOS \(UNIDADES\)/);
    assert.match(csv, /Unidade;Empresa;Modelo/);
    assert.match(csv, /JV Loja A;Grupo JV/);
  });
  test("Rentabilidade: ranking + dois recortes, por unidade", () => {
    const csv = V.csvDaRentabilidade(LUC());
    assert.match(csv, /RANKING DE RENTABILIDADE \(UNIDADES\)/);
    assert.match(csv, /10 MENORES EM FATURAMENTO \(UNIDADES\)/);
    assert.match(csv, /10 MENORES EM RENTABILIDADE \(UNIDADES\)/);
  });
});

describe("integração: trocar de aba/semana", () => {
  test("entrar na aba Lucratividade dispara UMA chamada semanal; ir p/ Rentabilidade reaproveita o cache", async () => {
    let semanais = 0;
    V.ligarNavegacao({ abrirEmpresa() {}, abrirUnidade() {}, voltar() {}, irParaTela() {}, recarregar() {} });
    const api = {
      relatorioResumo: async () => RELATORIO,
      relatorioEvolucao: async () => EVOLUCAO,
      relatorioLucratividade: async () => { semanais++; return LUC(); },
    };
    await V.renderViewPadm({ tipo: "tela", id: "relatorios" }, { api, mes: "2026-09" });
    assert.equal(semanais, 0, "a área abre no Resumo, sem chamada semanal");

    padmView._store.abas.find((b) => b.dataset.padmAba === "lucratividade").dispatch("click");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(semanais, 1);

    padmView._store.abas.find((b) => b.dataset.padmAba === "rentabilidade").dispatch("click");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(semanais, 1, "mesma semana -> sem refetch");
  });

  // Regressão: um backend desatualizado servindo o contrato antigo
  // (`empresas`/`lojas`, sem `unidades`) fazia as tabelas renderizarem VAZIAS
  // em silêncio — o que escondeu o problema real (servidor stale).
  test("contrato antigo (sem `unidades`) -> erro explícito, nunca tabela vazia silenciosa", async () => {
    V.ligarNavegacao({ abrirEmpresa() {}, abrirUnidade() {}, voltar() {}, irParaTela() {}, recarregar() {}, aoAcessoRevogado() {} });
    const api = {
      relatorioResumo: async () => RELATORIO,
      relatorioEvolucao: async () => EVOLUCAO,
      // simula backend antigo: devolve empresas/lojas, sem `unidades`
      relatorioLucratividade: async () => ({ semana: { inicio: "2026-09-07", fim: "2026-09-13" }, rede: {}, empresas: [{ nome: "X" }], lojas: [{ nome: "Y" }], destaques: {}, atencao: {} }),
    };
    await V.renderViewPadm({ tipo: "tela", id: "relatorios" }, { api, mes: "2026-09" });
    padmView._store.abas.find((b) => b.dataset.padmAba === "lucratividade").dispatch("click");
    await new Promise((r) => setTimeout(r, 0));
    const html = padmView.innerHTML;
    assert.match(html, /Resposta inesperada|não foi poss[ií]vel carregar/i, "mostra erro, não vazio");
    assert.doesNotMatch(html, /Nenhuma unidade com faturamento/, "não cai no estado vazio silencioso");
  });
});
