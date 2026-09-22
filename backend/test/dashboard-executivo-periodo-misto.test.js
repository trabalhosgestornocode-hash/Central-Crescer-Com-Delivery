// PERÍODO MISTO (Marketplace + Full Service no mesmo mês) — Dashboard iFood.
//
// Parte 1 (pura): dashboardExecutivo.periodoMisto.js — divisão do Financeiro
// acumulado por delta de snapshots, consolidação em REAIS (nunca média de
// percentuais), composição de metas ponderada pelo faturamento.
// Parte 2 (service): obterMes / lançamento mensal, com banco e metas FAKE.
//
// Cenário-base (Unidade X, setembro/2026): Marketplace 01–12, Full Service 13–30.
//   Snapshot acumulado em 12/09 (fim do Marketplace):
//     faturamento 10.000 · taxas e comissões 1.300 (13%) · serviços 500 (5%) · entregadores 1.200 (12%)
//   Snapshot acumulado em 18/09 (mais recente):
//     faturamento 16.000 · taxas 2.530 · serviços 1.100 · entregadores 1.500
//   => Marketplace (01–12): 10.000 | taxas 1.300 | serv 500 | entreg 1.200 -> deduções 3.000 (30,00%)
//      Full Service (13–18): 6.000  | taxas 1.230 | serv 600 | entreg 300 (não se aplica) -> deduções 1.830 (30,50%)
//      Período: deduções 3.000 + 1.830 = 4.830 sobre 16.000 = 30,1875%   (média simples de % daria 30,25%)
//
// Rodar: node --experimental-vm-modules --test test/dashboard-executivo-periodo-misto.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule } from "node:vm";

import {
  dividirFinanceiroPorSegmento, consolidarSegmentos, comporMetas, MOTIVOS_DIVISAO_INDISPONIVEL,
} from "../src/modules/dashboard-executivo/dashboardExecutivo.periodoMisto.js";
import { montarLinhaDoTempo, segmentosDoPeriodo } from "../src/modules/dashboard-executivo/dashboardExecutivo.modeloTemporal.js";
import { metasComProtecaoPrecificacao, percentual } from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";

const TROCA_X = { vigenciaInicio: "2026-09-13", modeloAnterior: "marketplace", modeloNovo: "full_service" };
const LINHA_MISTA = montarLinhaDoTempo({ modeloAtual: "full_service", trocas: [TROCA_X] });
const SEGS = segmentosDoPeriodo(LINHA_MISTA, "2026-09-01", "2026-09-30");

const snap = (data, fat, tc, sp, te, extra = {}) => ({
  id: `l-${data}`, unidade_id: "u1", data_lancamento: data, situacao: "normal", status: "finalizado", origem_lancamento: "diario",
  valor_vendas_ifood: fat, taxas_comissoes: tc, servicos_promocoes: sp, taxas_entregadores: te,
  ajustes_favor_loja: 0, ajustes_contra_loja: 0, ...extra,
});
const LINHAS_BASE = [snap("2026-09-12", 10000, 1300, 500, 1200), snap("2026-09-18", 16000, 2530, 1100, 1500)];

const METAS = {
  marketplace: {
    taxas_comissoes: { metaIdeal: 13, limite: 13 }, servicos_promocoes: { metaIdeal: 5, limite: 7 },
    taxas_entregadores: { metaIdeal: 12, limite: 15 }, total_deducoes: { metaIdeal: 30, limite: 32 },
  },
  full_service: {
    taxas_comissoes: { metaIdeal: 20.5, limite: 20.5 }, servicos_promocoes: { metaIdeal: 10, limite: 14.5 },
    taxas_entregadores: { metaIdeal: 15, limite: 15 }, // linha existe no banco, mas NÃO se aplica ao Full Service
    total_deducoes: { metaIdeal: 30.5, limite: 32 },
  },
};

const perto = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `esperado ${b}, veio ${a}`);

describe("dividirFinanceiroPorSegmento — delta de snapshots acumulados", () => {
  test("Caso C: Marketplace = acumulado em 12/09; Full Service = acumulado em 18/09 − acumulado em 12/09", () => {
    const d = dividirFinanceiroPorSegmento(LINHAS_BASE, SEGS);
    assert.equal(d.disponivel, true);
    assert.equal(d.fonte, "snapshot");
    const [mp, fs] = d.segmentos;
    assert.deepEqual([mp.modelo, mp.inicio, mp.fim], ["marketplace", "2026-09-01", "2026-09-12"]);
    assert.deepEqual(mp.valores, { valorVendasIfood: 10000, taxasComissoes: 1300, servicosPromocoes: 500, taxasEntregadores: 1200, ajustesFavorLoja: 0, ajustesContraLoja: 0 });
    assert.deepEqual([fs.modelo, fs.inicio, fs.fim], ["full_service", "2026-09-13", "2026-09-30"]);
    assert.deepEqual(fs.valores, { valorVendasIfood: 6000, taxasComissoes: 1230, servicosPromocoes: 600, taxasEntregadores: 300, ajustesFavorLoja: 0, ajustesContraLoja: 0 });
    // O acumulado do período é o snapshot mais recente (MP + FS, sem dupla contagem).
    assert.equal(d.acumulado.valorVendasIfood, 16000);
    assert.equal(mp.valores.valorVendasIfood + fs.valores.valorVendasIfood, d.acumulado.valorVendasIfood);
  });

  test("Marketplace usa SÓ os dados até 12/09: um snapshot posterior não vaza para o regime anterior", () => {
    const d = dividirFinanceiroPorSegmento(LINHAS_BASE, SEGS);
    assert.equal(d.segmentos[0].valores.valorVendasIfood, 10000);
  });

  test("virada SEM snapshot em 12/09 => indisponível, com a data necessária (nunca um palpite)", () => {
    const d = dividirFinanceiroPorSegmento([snap("2026-09-18", 16000, 2530, 1100, 1500)], SEGS);
    assert.equal(d.disponivel, false);
    assert.equal(d.motivo, MOTIVOS_DIVISAO_INDISPONIVEL.SNAPSHOT_DE_VIRADA_AUSENTE);
    assert.deepEqual(d.detalhe, { dataNecessaria: "2026-09-12", modelo: "marketplace" });
  });

  test("snapshot mais antigo que a virada só vale se os dias entre ele e a virada foram SEM OPERAÇÃO", () => {
    const semOp = (data) => snap(data, 0, 0, 0, 0, { situacao: "sem_operacao" });
    const ok = dividirFinanceiroPorSegmento(
      [snap("2026-09-10", 8000, 1040, 400, 960), semOp("2026-09-11"), semOp("2026-09-12"), snap("2026-09-18", 14000, 2270, 1000, 1260)], SEGS);
    assert.equal(ok.disponivel, true);
    assert.equal(ok.segmentos[0].valores.valorVendasIfood, 8000);
    assert.equal(ok.segmentos[1].valores.valorVendasIfood, 6000);

    // Dia 11 sem lançamento nenhum (pendente): não dá para saber se vendeu -> indisponível.
    const pendente = dividirFinanceiroPorSegmento(
      [snap("2026-09-10", 8000, 1040, 400, 960), semOp("2026-09-12"), snap("2026-09-18", 14000, 2270, 1000, 1260)], SEGS);
    assert.equal(pendente.disponivel, false);
  });

  test("acumulado que DIMINUI entre a virada e o fim é inconsistência declarada, não um número negativo", () => {
    const d = dividirFinanceiroPorSegmento([snap("2026-09-12", 10000, 1300, 500, 1200), snap("2026-09-18", 9000, 1200, 500, 1200)], SEGS);
    assert.equal(d.disponivel, false);
    assert.equal(d.motivo, MOTIVOS_DIVISAO_INDISPONIVEL.ACUMULADO_INCONSISTENTE);
  });

  test("sem snapshot no último regime: ele fica 'sem dado' e o período = só o Marketplace", () => {
    const d = dividirFinanceiroPorSegmento([snap("2026-09-12", 10000, 1300, 500, 1200)], SEGS);
    assert.equal(d.disponivel, true);
    assert.equal(d.segmentos[1].semDado, true);
    assert.equal(d.acumulado.valorVendasIfood, 10000);
  });

  test("sem nenhum dado no mês: todos os segmentos 'sem dado'", () => {
    const d = dividirFinanceiroPorSegmento([], SEGS);
    assert.equal(d.fonte, "sem_dado");
    assert.ok(d.segmentos.every((s) => s.semDado));
  });

  test("Caso G: Lançamento Mensal (fatias uniformes) que ATRAVESSA a troca é indisponível — sem quebra artificial", () => {
    const fatia = (data) => ({ data_lancamento: data, situacao: "normal", origem_lancamento: "distribuicao_mensal", valor_vendas_ifood: 500, taxas_comissoes: 60, servicos_promocoes: 20, taxas_entregadores: 50 });
    const dias = Array.from({ length: 18 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
    const d = dividirFinanceiroPorSegmento(dias.map(fatia), SEGS);
    assert.equal(d.disponivel, false);
    assert.equal(d.motivo, MOTIVOS_DIVISAO_INDISPONIVEL.LANCAMENTO_MENSAL_ATRAVESSA_TROCA);
  });

  test("Caso G: Lançamento Mensal que cai só num regime é atribuído inteiro a ele (as fatias são aditivas)", () => {
    const fatia = (data) => ({ data_lancamento: data, situacao: "normal", origem_lancamento: "distribuicao_mensal", valor_vendas_ifood: 500, taxas_comissoes: 60, servicos_promocoes: 20, taxas_entregadores: null });
    const dias = ["2026-09-13", "2026-09-14", "2026-09-15"];
    const d = dividirFinanceiroPorSegmento(dias.map(fatia), SEGS);
    assert.equal(d.disponivel, true);
    assert.equal(d.fonte, "lancamento_mensal");
    assert.equal(d.segmentos[0].semDado, true);
    assert.equal(d.segmentos[1].valores.valorVendasIfood, 1500);
  });
});

describe("consolidarSegmentos — valores em reais, nunca média de percentuais", () => {
  const d = dividirFinanceiroPorSegmento(LINHAS_BASE, SEGS);
  const c = consolidarSegmentos(d);

  test("Taxa dos Entregadores só onde aplicável: soma apenas o Marketplace (os 300 do Full Service não entram)", () => {
    assert.equal(c.cardValores.taxasEntregadores, 1200);
    assert.equal(c.baseEntregadores, 10000);
    perto(percentual(c.cardValores.taxasEntregadores, c.baseEntregadores), 12);
  });

  test("Total de Deduções = deduções Marketplace (com entregadores) + deduções Full Service (sem entregadores)", () => {
    assert.equal(c.totalDeducoes, 3000 + 1830);
    const pct = percentual(c.totalDeducoes, c.cardValores.valorVendasIfood);
    perto(pct, 30.1875);
  });

  test("NÃO é a média simples dos percentuais (30,00 e 30,50 -> 30,25)", () => {
    const pctMp = percentual(3000, 10000);
    const pctFs = percentual(1830, 6000);
    const mediaSimples = (pctMp + pctFs) / 2;
    perto(mediaSimples, 30.25);
    const pct = percentual(c.totalDeducoes, c.cardValores.valorVendasIfood);
    assert.notEqual(pct, mediaSimples);
  });

  test("NÃO é 'tudo Full Service' (3.630) nem 'tudo Marketplace' (5.130 — contaria os 300 de entregadores do FS)", () => {
    assert.notEqual(c.totalDeducoes, 2530 + 1100);
    assert.notEqual(c.totalDeducoes, 2530 + 1100 + 1500);
  });

  test("taxas e comissões e serviços e promoções = acumulado do período (ambos os modelos usam)", () => {
    assert.equal(c.cardValores.taxasComissoes, 2530);
    assert.equal(c.cardValores.servicosPromocoes, 1100);
    assert.equal(c.cardValores.valorVendasIfood, 16000);
  });

  test("período sem nenhum regime com entregadores (só Full Service): componente não aplicável e Total sem entregadores", () => {
    const fsPuro = segmentosDoPeriodo(montarLinhaDoTempo({ modeloAtual: "full_service" }), "2026-09-13", "2026-09-30");
    const dd = dividirFinanceiroPorSegmento([snap("2026-09-18", 6000, 1230, 600, 300)], fsPuro);
    const cc = consolidarSegmentos(dd);
    assert.equal(cc.cardValores.taxasEntregadores, null);
    assert.equal(cc.baseEntregadores, 0);
    assert.equal(cc.totalDeducoes, 1830);
  });
});

describe("comporMetas — média ponderada pelo faturamento de cada regime", () => {
  const partes = [
    { modelo: "marketplace", peso: 10000, metas: METAS.marketplace },
    { modelo: "full_service", peso: 6000, metas: METAS.full_service },
  ];
  const ind = ["taxas_comissoes", "servicos_promocoes", "taxas_entregadores", "total_deducoes"];
  const m = comporMetas(partes, ind);

  test("fórmula: meta = Σ(metaᵢ × faturamentoᵢ) / Σ faturamentoᵢ  (equivale a somar a meta em R$ e dividir pela base)", () => {
    perto(m.taxas_comissoes.metaIdeal, (13 * 10000 + 20.5 * 6000) / 16000); // 15,8125
    perto(m.servicos_promocoes.metaIdeal, (5 * 10000 + 10 * 6000) / 16000); // 6,875
    perto(m.servicos_promocoes.limite, (7 * 10000 + 14.5 * 6000) / 16000); // 9,8125
    perto(m.total_deducoes.metaIdeal, (30 * 10000 + 30.5 * 6000) / 16000); // 30,1875
    // Meta em R$ do período = soma das metas em R$ de cada regime.
    perto(m.total_deducoes.metaIdeal / 100 * 16000, 0.30 * 10000 + 0.305 * 6000);
  });

  test("Taxas de Entregadores: meta só do Marketplace (o Full Service não tem o componente, mesmo com a linha no banco)", () => {
    assert.deepEqual(m.taxas_entregadores, METAS.marketplace.taxas_entregadores);
  });

  test("não aplica a meta de um regime só ao mês inteiro", () => {
    assert.notEqual(m.total_deducoes.metaIdeal, METAS.marketplace.total_deducoes.metaIdeal);
    assert.notEqual(m.total_deducoes.metaIdeal, METAS.full_service.total_deducoes.metaIdeal);
    assert.notEqual(m.taxas_comissoes.metaIdeal, 13);
    assert.notEqual(m.taxas_comissoes.metaIdeal, 20.5);
  });

  test("sem faturamento em nenhum regime elegível: usa o último regime aplicável (não há resultado a avaliar)", () => {
    const vazio = comporMetas(partes.map((p) => ({ ...p, peso: 0 })), ind);
    assert.deepEqual(vazio.taxas_comissoes, METAS.full_service.taxas_comissoes);
    assert.deepEqual(vazio.taxas_entregadores, METAS.marketplace.taxas_entregadores);
  });
});

// ---------------------------------------------------------------------------
// PARTE 2 — service (obterMes / lançamento mensal) com banco e metas FAKE
// ---------------------------------------------------------------------------
const dirSrc = new URL("../src/modules/dashboard-executivo/", import.meta.url);

async function carregar(nome, mocks) {
  const url = new URL(nome, dirSrc);
  const m = new SourceTextModule(readFileSync(url, "utf8"), { identifier: url.href });
  await m.link(async (spec) => {
    const ns = mocks[spec] ?? await import(new URL(spec, url));
    return new SyntheticModule(Object.keys(ns), function () { for (const [k, v] of Object.entries(ns)) this.setExport(k, v); });
  });
  await m.evaluate();
  return m.namespace;
}

function banco({ lancamentos = [], lote = null }) {
  return {
    from(tabela) {
      const f = { eq: {}, gte: null, lte: null };
      let unico = false;
      const resposta = () => {
        if (tabela === "unidades") return { data: { id: f.eq.id ?? "u1", organizacao_id: "org", eh_teste: false }, error: null };
        if (tabela === "lancamentos_financeiros_distribuicao_mensal") return { data: unico ? lote : [], error: null };
        if (tabela === "lancamentos_financeiros_diarios") {
          const achadas = lancamentos.filter((r) =>
            (f.eq.unidade_id == null || r.unidade_id === f.eq.unidade_id)
            && (f.eq.distribuicao_mensal_id == null || r.distribuicao_mensal_id === f.eq.distribuicao_mensal_id)
            && (!f.gte || r.data_lancamento >= f.gte) && (!f.lte || r.data_lancamento <= f.lte));
          return { data: unico ? (achadas[0] ?? null) : achadas, error: null };
        }
        return { data: unico ? null : [], error: null };
      };
      const q = {
        select: () => q, order: () => q, limit: () => q, in: () => q,
        eq: (k, v) => ((f.eq[k] = v), q),
        gte: (k, v) => ((f.gte = v), q), lte: (k, v) => ((f.lte = v), q),
        maybeSingle: () => ((unico = true), Promise.resolve(resposta())),
        then: (a, b) => Promise.resolve(resposta()).then(a, b),
      };
      return q;
    },
  };
}

const PRECOS = {
  oficiais: { tabelaBalcao: "E", tabelaIfood: "Z4" }, tabelas: { balcao: "E", ifood: "Z4" },
  produto: { id: "p1", nome: "Churrasco 15cm" }, balcao: { preco: 24, custo: 6 }, ifood: { preco: 35, custo: 6 },
};

/** Service com a unidade `u1` numa linha do tempo e metas por modelo (resolverMetas respeita o modelo pedido). */
async function servico({ lancamentos = [], lote = null, trocas = [], modeloAtual }) {
  const linhaDoTempo = montarLinhaDoTempo({ modeloAtual, trocas });
  const modeloHoje = trocas.length ? trocas[trocas.length - 1].modeloNovo : modeloAtual;
  return carregar("dashboardExecutivo.service.js", {
    "../../config/supabase.js": { supabase: banco({ lancamentos, lote }) },
    "../../shared/desbloqueiosIfood.js": { carregarDatasLiberadas: async () => new Set() },
    "./dashboardExecutivo.precos.service.js": { carregarPrecosRentabilidade: async () => PRECOS },
    "./dashboardExecutivo.metas.service.js": {
      resolverMetas: async ({ modeloLogistico }) => structuredClone(METAS[modeloLogistico]),
      obterModeloLogistico: async () => ({
        unidadeId: "u1", modeloLogistico: modeloHoje, modeloLogisticoRotulo: modeloHoje === "marketplace" ? "Marketplace" : "Full Service",
        ehTeste: false, linhaDoTempo,
      }),
      definirModeloLogistico() {}, historicoModeloLogistico() {},
    },
  });
}
const PEDIDO_SET = { organizacaoId: "org", unidadeIdSessao: null, unidadeIdSolicitado: "u1", mes: 9, ano: 2026 };

describe("Caso A — 01–30 Marketplace: comportamento igual ao anterior", () => {
  test("indicadores, metas e aplicabilidade do Marketplace (nenhuma troca registrada)", async () => {
    const svc = await servico({ modeloAtual: "marketplace", lancamentos: [snap("2026-09-18", 16000, 2530, 1100, 1500)] });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.modeloLogistico, "marketplace");
    assert.equal(d.modeloPeriodo.misto, false);
    assert.equal(d.modeloPeriodo.divisaoDisponivel, true);
    assert.equal(d.cards.taxasEntregadores.naoAplicavel, false);
    assert.equal(d.cards.taxasEntregadores.valor, 1500);
    perto(d.cards.taxasEntregadores.percentual, 9.375); // 1.500 / 16.000
    assert.equal(d.cards.totalDeducoes.valor, 2530 + 1100 + 1500); // Marketplace inclui entregadores
    perto(d.cards.totalDeducoes.percentual, 32.0625);
    assert.equal(d.cards.totalDeducoes.status.chave, "atencao"); // 32,06% > limite 32%
    // metas do Marketplace, sem composição
    assert.equal(d.indicadoresRentabilidade.taxas_comissoes.metaIdeal, 13);
    assert.equal(d.indicadoresRentabilidade.taxas_entregadores.limite, 15);
    assert.equal(d.indicadoresRentabilidade.total_deducoes.limite, 32);
  });
});

describe("Caso B — 01–30 Full Service: comportamento igual ao anterior", () => {
  test("entregadores 'não se aplica' e Total de Deduções só com taxas + serviços", async () => {
    const svc = await servico({ modeloAtual: "full_service", lancamentos: [snap("2026-09-18", 16000, 2530, 1100, 1500)] });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.modeloLogistico, "full_service");
    assert.equal(d.modeloPeriodo.misto, false);
    assert.equal(d.cards.taxasEntregadores.naoAplicavel, true);
    assert.equal(d.indicadoresRentabilidade.taxas_entregadores.naoAplicavel, true);
    assert.equal(d.cards.totalDeducoes.valor, 2530 + 1100);
    perto(d.cards.totalDeducoes.percentual, 22.6875);
    assert.equal(d.indicadoresRentabilidade.taxas_comissoes.metaIdeal, 20.5);
    // A "Taxa dos Entregadores" informada continua no caixa real (Receita líquida), como sempre foi.
    assert.equal(d.cards.receitaLiquida.valor, 16000 - (2530 + 1100 + 1500));
  });
});

describe("Caso C — 01–12 Marketplace, 13–30 Full Service (setembro inteiro)", () => {
  test("detecta 'operação mista' e devolve os dois intervalos", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_BASE });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.modeloLogistico, "misto", "estado derivado do período (nunca persistido)");
    assert.equal(d.modeloLogisticoRotulo, "Operação mista");
    assert.equal(d.modeloPeriodo.misto, true);
    assert.equal(d.modeloPeriodo.divisaoDisponivel, true);
    assert.deepEqual(d.modeloPeriodo.segmentos.map((s) => [s.modelo, s.inicio, s.fim, s.emAberto]), [
      ["marketplace", "2026-09-01", "2026-09-12", false],
      ["full_service", "2026-09-13", "2026-09-30", true],
    ]);
    // O modelo de HOJE continua Full Service (é o que o seletor de troca mostra).
    assert.equal(d.modeloAtual.modeloLogistico, "full_service");
  });

  test("todos os cards aparecem, inclusive Taxas de Entregadores (existiu Marketplace no período)", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_BASE });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.cards.taxasEntregadores.naoAplicavel, false);
    assert.equal(d.indicadoresRentabilidade.taxas_entregadores.naoAplicavel, false);
    assert.equal(d.cards.taxasEntregadores.valor, 1200, "só os entregadores dos dias de Marketplace");
    perto(d.cards.taxasEntregadores.percentual, 12, 1e-9); // 1.200 / 10.000 (faturamento do Marketplace)
    assert.equal(d.graficos.comparativoPercentuais.some((g) => g.indicador === "taxas_entregadores"), true);
  });

  test("Total de Deduções: soma em reais dos dois regimes sobre o faturamento do período — sem média de percentuais", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_BASE });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.cards.faturamento.valor, 16000);
    assert.equal(d.cards.totalDeducoes.valor, 4830);
    perto(d.cards.totalDeducoes.percentual, 30.1875);
    assert.notEqual(d.cards.totalDeducoes.percentual, 30.25);
    perto(d.cards.taxasComissoes.percentual, 15.8125);
    perto(d.cards.servicosPromocoes.percentual, 6.875);
  });

  test("Receita líquida usa o caixa REAL (inclui os 300 de entregadores lançados, mesmo em dia Full Service)", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_BASE });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.cards.receitaLiquida.valor, 16000 - (2530 + 1100 + 1500));
  });

  test("metas: composição ponderada, nunca a meta de um regime aplicada ao mês inteiro", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: LINHAS_BASE });
    const d = await svc.obterMes(PEDIDO_SET);
    const ind = d.indicadoresRentabilidade;
    perto(ind.taxas_comissoes.metaIdeal, (13 * 10000 + 20.5 * 6000) / 16000);
    perto(ind.taxas_comissoes.limite, (13 * 10000 + 20.5 * 6000) / 16000);
    // Entregadores: só a meta do Marketplace.
    assert.equal(ind.taxas_entregadores.metaIdeal, 12);
    assert.equal(ind.taxas_entregadores.limite, 15);
    // Serviços e Total: metas ideais derivadas (proteção da precificação) POR regime, depois compostas.
    const pct = d.protecaoPrecificacao.protecaoPrecificacaoPct;
    const mp = metasComProtecaoPrecificacao(METAS.marketplace, pct, "marketplace").metas;
    const fs = metasComProtecaoPrecificacao(METAS.full_service, pct, "full_service").metas;
    perto(ind.servicos_promocoes.metaIdeal, (mp.servicos_promocoes.metaIdeal * 10000 + fs.servicos_promocoes.metaIdeal * 6000) / 16000);
    perto(ind.total_deducoes.metaIdeal, (mp.total_deducoes.metaIdeal * 10000 + fs.total_deducoes.metaIdeal * 6000) / 16000);
    perto(ind.total_deducoes.limite, 32);
    assert.equal(ind.total_deducoes.status.chave, "dentro_da_meta"); // 30,19% <= ~31,43%
  });

  test("sem o snapshot da véspera da troca: aviso com a data necessária; indicadores dependentes do modelo ficam SEM dado", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: [snap("2026-09-18", 16000, 2530, 1100, 1500)] });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.modeloPeriodo.misto, true);
    assert.equal(d.modeloPeriodo.divisaoDisponivel, false);
    assert.equal(d.modeloPeriodo.divisaoMotivo, "snapshot_de_virada_ausente");
    assert.deepEqual(d.modeloPeriodo.divisaoDetalhe, { dataNecessaria: "2026-09-12", modelo: "marketplace" });
    // Nada é atribuído a um regime por palpite.
    assert.equal(d.cards.totalDeducoes.valor, null);
    assert.equal(d.cards.totalDeducoes.status.chave, "sem_dados");
    assert.equal(d.cards.taxasEntregadores.valor, null);
    assert.equal(d.cards.totalDeducoes.meta, null);
    // O que independe do modelo continua válido.
    assert.equal(d.cards.faturamento.valor, 16000);
    perto(d.cards.taxasComissoes.percentual, 15.8125);
    assert.equal(d.cards.taxasComissoes.meta, null, "sem meta única enganosa");
  });

  test("dashboard só 01–12 = Marketplace puro; só 13–30 = Full Service puro (não misto)", async () => {
    // Um mês inteiro em cada regime, com a MESMA linha do tempo: agosto (MP) e outubro (FS).
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: [] });
    const ago = await svc.obterMes({ ...PEDIDO_SET, mes: 8 });
    const out = await svc.obterMes({ ...PEDIDO_SET, mes: 10 });
    assert.equal(ago.modeloLogistico, "marketplace");
    assert.equal(ago.modeloPeriodo.misto, false);
    assert.equal(ago.cards.taxasEntregadores.naoAplicavel, false, "agosto ainda era Marketplace, mesmo hoje sendo Full Service");
    assert.equal(out.modeloLogistico, "full_service");
    assert.equal(out.cards.taxasEntregadores.naoAplicavel, true);
  });
});

describe("Caso G — lançamento mensal atravessando a mudança de regime", () => {
  const dadosLote = { mes: 9, ano: 2026, valorTotalMensal: 20000, unidadeId: "u1" };
  const pedidoLote = { organizacaoId: "org", unidadeIdSessao: null, usuario: { id: "x" }, dados: dadosLote, confirmar: false };

  test("criar lote cujos dias atravessam a troca é BLOQUEADO (409), com orientação — sem gambiarra", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X] });
    await assert.rejects(svc.lancamentoMensal(pedidoLote), (e) => {
      assert.equal(e.status ?? e.statusCode, 409);
      assert.match(e.message, /atravessam a troca de modelo/);
      assert.equal(e.details?.atravessaTrocaDeModelo, true);
      return true;
    });
  });

  test("com os dias de Marketplace já lançados individualmente, o lote só cobre Full Service e é permitido", async () => {
    const individuais = Array.from({ length: 12 }, (_, i) => snap(`2026-09-${String(i + 1).padStart(2, "0")}`, (i + 1) * 800, 100, 40, 90));
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: individuais });
    const preview = await svc.lancamentoMensal(pedidoLote);
    assert.equal(preview.diasComLancamento, 12);
    assert.ok(preview.diasParaDistribuir >= 1);
  });

  test("unidade sem troca: o lote continua funcionando como antes (preview)", async () => {
    const svc = await servico({ modeloAtual: "marketplace" });
    const preview = await svc.lancamentoMensal(pedidoLote);
    assert.ok(preview.diasParaDistribuir >= 13);
  });

  const loteRow = { id: "lote1", unidade_id: "u1", mes: 9, ano: 2026, valor_total_centavos: 2000000, dias_distribuidos: 3, created_at: "2026-09-19T00:00:00Z" };
  const fatia = (data) => ({
    id: `f-${data}`, unidade_id: "u1", data_lancamento: data, situacao: "normal", origem_lancamento: "distribuicao_mensal", distribuicao_mensal_id: "lote1",
    valor_vendas_ifood: 100, taxas_entregadores: null,
  });

  test("resumo do lote: em dias Full Service, Taxas de Entregadores é 'não aplicável' (nunca pendência)", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lote: loteRow, lancamentos: ["2026-09-14", "2026-09-15", "2026-09-16"].map(fatia) });
    const r = await svc.obterLancamentoMensal({ organizacaoId: "org", unidadeIdSessao: null, unidadeIdSolicitado: "u1", mes: 9, ano: 2026 });
    assert.deepEqual(r.modelosDoLote, ["full_service"]);
    assert.equal(r.atravessaTrocaDeModelo, false);
    assert.ok(r.camposNaoAplicaveis.includes("taxasEntregadoresTotal"));
    assert.ok(!r.camposPendentes.includes("taxasEntregadoresTotal"));
  });

  test("resumo do lote: em dias Marketplace, Taxas de Entregadores continua sendo cobrada quando falta", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lote: loteRow, lancamentos: ["2026-09-03", "2026-09-04", "2026-09-05"].map(fatia) });
    const r = await svc.obterLancamentoMensal({ organizacaoId: "org", unidadeIdSessao: null, unidadeIdSolicitado: "u1", mes: 9, ano: 2026 });
    assert.deepEqual(r.modelosDoLote, ["marketplace"]);
    assert.ok(r.camposPendentes.includes("taxasEntregadoresTotal"));
    assert.ok(!r.camposNaoAplicaveis.includes("taxasEntregadoresTotal"));
  });

  test("lote LEGADO que já atravessa a troca é sinalizado (não classificado cegamente como um regime só)", async () => {
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lote: loteRow, lancamentos: ["2026-09-05", "2026-09-14"].map(fatia) });
    const r = await svc.obterLancamentoMensal({ organizacaoId: "org", unidadeIdSessao: null, unidadeIdSolicitado: "u1", mes: 9, ano: 2026 });
    assert.equal(r.atravessaTrocaDeModelo, true);
    assert.deepEqual(r.modelosDoLote, ["marketplace", "full_service"]);
    assert.ok(r.camposPendentes.includes("taxasEntregadoresTotal"), "existe nos dias Marketplace: não some");
  });

  test("Dashboard do mês com lote que atravessa a troca: divisão indisponível, motivo declarado", async () => {
    const dias = Array.from({ length: 18 }, (_, i) => fatia(`2026-09-${String(i + 1).padStart(2, "0")}`));
    const svc = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lote: loteRow, lancamentos: dias });
    const d = await svc.obterMes(PEDIDO_SET);
    assert.equal(d.modeloPeriodo.divisaoDisponivel, false);
    assert.equal(d.modeloPeriodo.divisaoMotivo, "lancamento_mensal_atravessa_troca");
    assert.equal(d.cards.totalDeducoes.valor, null);
  });
});

describe("Preservação do histórico — a troca não altera dados já lançados", () => {
  test("os MESMOS lançamentos, lidos antes e depois de registrar a troca, dão o mesmo resultado por regime", async () => {
    const antes = await servico({ modeloAtual: "marketplace", lancamentos: [snap("2026-09-12", 10000, 1300, 500, 1200)] });
    const depois = await servico({ modeloAtual: "full_service", trocas: [TROCA_X], lancamentos: [snap("2026-09-12", 10000, 1300, 500, 1200)] });
    // 01–12 lido isoladamente: a linha do tempo mista recorta o período 01–12 como Marketplace.
    const dAntes = await antes.obterMes(PEDIDO_SET);
    const dDepois = await depois.obterMes(PEDIDO_SET);
    // Mês só com dados até 12/09: o regime Full Service ainda não tem snapshot -> período = Marketplace do dia 1 ao 12.
    assert.equal(dDepois.cards.faturamento.valor, dAntes.cards.faturamento.valor);
    assert.equal(dDepois.cards.taxasEntregadores.valor, dAntes.cards.taxasEntregadores.valor);
    assert.equal(dDepois.cards.totalDeducoes.valor, dAntes.cards.totalDeducoes.valor);
    perto(dDepois.cards.totalDeducoes.percentual, dAntes.cards.totalDeducoes.percentual);
  });
});
