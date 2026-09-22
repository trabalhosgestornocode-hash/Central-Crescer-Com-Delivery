// MODELO LOGÍSTICO TEMPORAL — linha do tempo de vigências (Marketplace x Full Service).
//
// Cobre: consulta por data (Caso D), troca com vigência que NÃO reescreve o
// passado (Caso E), isolamento multi-tenant (Caso F), regras de validação e a
// tolerância a ambiente sem a migration 089.
//
// Parte pura: módulo dashboardExecutivo.modeloTemporal.js. Parte com banco:
// dashboardExecutivo.metas.service.js carregado com um supabase FAKE em memória
// (SourceTextModule — mesmo padrão de dashboard-executivo-rentabilidade-service.test.js).
//
// Rodar: node --experimental-vm-modules --test test/modelo-logistico-temporal.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule } from "node:vm";

import {
  montarLinhaDoTempo, modeloNaData, segmentosDoPeriodo, estadoDoPeriodo, validarNovaTroca, trocasDeLinhas,
  modelosDasDatas, descreverPeriodo, rotuloDoModelo,
} from "../src/modules/dashboard-executivo/dashboardExecutivo.modeloTemporal.js";

const HOJE = "2026-09-19";
// Unidade X: Marketplace até 12/09/2026, Full Service a partir de 13/09/2026.
const TROCA_X = { vigenciaInicio: "2026-09-13", modeloAnterior: "marketplace", modeloNovo: "full_service" };

describe("linha do tempo — períodos derivados dos pontos de troca", () => {
  test("sem troca datada: UM período aberto com o modelo atual (comportamento anterior)", () => {
    assert.deepEqual(montarLinhaDoTempo({ modeloAtual: "marketplace" }), [{ modelo: "marketplace", inicio: null, fim: null }]);
    assert.deepEqual(montarLinhaDoTempo({ modeloAtual: "full_service", trocas: [] }), [{ modelo: "full_service", inicio: null, fim: null }]);
  });

  test("Marketplace até 12/09, Full Service desde 13/09 (fim = véspera da troca)", () => {
    assert.deepEqual(montarLinhaDoTempo({ modeloAtual: "full_service", trocas: [TROCA_X] }), [
      { modelo: "marketplace", inicio: null, fim: "2026-09-12" },
      { modelo: "full_service", inicio: "2026-09-13", fim: null },
    ]);
  });

  test("duas trocas: sem sobreposição e sem buraco (cada fim é a véspera do início seguinte)", () => {
    const linha = montarLinhaDoTempo({
      modeloAtual: "marketplace",
      trocas: [TROCA_X, { vigenciaInicio: "2026-10-01", modeloAnterior: "full_service", modeloNovo: "marketplace" }],
    });
    assert.deepEqual(linha.map((p) => [p.modelo, p.inicio, p.fim]), [
      ["marketplace", null, "2026-09-12"],
      ["full_service", "2026-09-13", "2026-09-30"],
      ["marketplace", "2026-10-01", null],
    ]);
    // Para todo dia, exatamente UM período casa.
    for (const dia of ["2026-01-01", "2026-09-12", "2026-09-13", "2026-09-30", "2026-10-01", "2030-01-01"]) {
      const casam = linha.filter((p) => (p.inicio == null || p.inicio <= dia) && (p.fim == null || p.fim >= dia));
      assert.equal(casam.length, 1, `dia ${dia}`);
    }
  });

  test("trocasDeLinhas: descarta linhas de auditoria (sem vigência) e ordena", () => {
    const trocas = trocasDeLinhas([
      { vigencia_inicio: "2026-10-01", modelo_anterior: "full_service", modelo_novo: "marketplace" },
      { vigencia_inicio: null, modelo_anterior: "full_service", modelo_novo: "marketplace" },
      { vigencia_inicio: "2026-09-13", modelo_anterior: "marketplace", modelo_novo: "full_service" },
    ]);
    assert.deepEqual(trocas.map((t) => t.vigenciaInicio), ["2026-09-13", "2026-10-01"]);
  });
});

describe("Caso D — modelo NA DATA", () => {
  const linha = montarLinhaDoTempo({ modeloAtual: "full_service", trocas: [TROCA_X] });

  test("10/09 = Marketplace; 14/09 = Full Service — mesmo com unidades.modelo_logistico_ifood = full_service", () => {
    assert.equal(modeloNaData(linha, "2026-09-10"), "marketplace");
    assert.equal(modeloNaData(linha, "2026-09-14"), "full_service");
  });

  test("bordas: 12/09 é Marketplace (último dia); 13/09 é Full Service (primeiro dia)", () => {
    assert.equal(modeloNaData(linha, "2026-09-12"), "marketplace");
    assert.equal(modeloNaData(linha, "2026-09-13"), "full_service");
  });

  test("datas muito antigas herdam o modelo anterior à 1ª troca; futuras, o em aberto", () => {
    assert.equal(modeloNaData(linha, "2020-01-01"), "marketplace");
    assert.equal(modeloNaData(linha, "2027-05-05"), "full_service");
  });
});

describe("período consultado — segmentos e estado 'misto' (derivado, nunca persistido)", () => {
  const linha = montarLinhaDoTempo({ modeloAtual: "full_service", trocas: [TROCA_X] });

  test("setembro inteiro = misto, com os dois intervalos", () => {
    const segs = segmentosDoPeriodo(linha, "2026-09-01", "2026-09-30");
    assert.deepEqual(segs, [
      { modelo: "marketplace", inicio: "2026-09-01", fim: "2026-09-12" },
      { modelo: "full_service", inicio: "2026-09-13", fim: "2026-09-30" },
    ]);
    const est = estadoDoPeriodo(segs);
    assert.equal(est.misto, true);
    assert.equal(est.tipo, "misto");
    assert.equal(rotuloDoModelo(est.tipo), "Operação mista");
  });

  test("01–12 = só Marketplace; 13–30 = só Full Service (não misto)", () => {
    const a = estadoDoPeriodo(segmentosDoPeriodo(linha, "2026-09-01", "2026-09-12"));
    const b = estadoDoPeriodo(segmentosDoPeriodo(linha, "2026-09-13", "2026-09-30"));
    assert.deepEqual([a.tipo, a.misto], ["marketplace", false]);
    assert.deepEqual([b.tipo, b.misto], ["full_service", false]);
  });

  test("meses passados continuam no modelo da época; meses novos no atual", () => {
    assert.equal(estadoDoPeriodo(segmentosDoPeriodo(linha, "2026-08-01", "2026-08-31")).tipo, "marketplace");
    assert.equal(estadoDoPeriodo(segmentosDoPeriodo(linha, "2026-10-01", "2026-10-31")).tipo, "full_service");
  });

  test("unidade que nunca mudou: qualquer mês = o único modelo (Caso A/B de compatibilidade)", () => {
    const mp = montarLinhaDoTempo({ modeloAtual: "marketplace" });
    const fs = montarLinhaDoTempo({ modeloAtual: "full_service" });
    assert.equal(estadoDoPeriodo(segmentosDoPeriodo(mp, "2026-09-01", "2026-09-30")).tipo, "marketplace");
    assert.equal(estadoDoPeriodo(segmentosDoPeriodo(fs, "2026-09-01", "2026-09-30")).tipo, "full_service");
    assert.equal(segmentosDoPeriodo(mp, "2026-09-01", "2026-09-30").length, 1);
  });

  test("períodos vizinhos do MESMO modelo são fundidos (MP→FS→MP dentro do mês vira 3 segmentos; MP→MP, 1)", () => {
    const tresRegimes = montarLinhaDoTempo({
      modeloAtual: "marketplace",
      trocas: [TROCA_X, { vigenciaInicio: "2026-09-20", modeloAnterior: "full_service", modeloNovo: "marketplace" }],
    });
    assert.equal(segmentosDoPeriodo(tresRegimes, "2026-09-01", "2026-09-30").length, 3);
    assert.deepEqual(modelosDasDatas(tresRegimes, ["2026-09-01", "2026-09-15", "2026-09-25"]), ["marketplace", "full_service"]);
  });

  test("descreverPeriodo: rótulo, segmentos e 'emAberto' do último regime", () => {
    const segs = segmentosDoPeriodo(linha, "2026-09-01", "2026-09-30");
    const d = descreverPeriodo({ estado: estadoDoPeriodo(segs), segmentos: segs, linhaDoTempo: linha, divisao: null });
    assert.equal(d.misto, true);
    assert.equal(d.divisaoDisponivel, true);
    assert.deepEqual(d.segmentos.map((s) => [s.rotulo, s.emAberto]), [["Marketplace", false], ["Full Service", true]]);
  });
});

describe("Caso E — registrar Full Service com vigência 13/09 não reescreve 01–12", () => {
  test("a troca cria o ponto 13/09; 01–12 continua Marketplace", () => {
    const antes = montarLinhaDoTempo({ modeloAtual: "marketplace" });
    const r = validarNovaTroca({ linhaDoTempo: antes, trocas: [], modeloNovo: "full_service", vigenciaInicio: "2026-09-13", hojeIso: HOJE });
    assert.deepEqual(r, { mudou: true, modeloAnterior: "marketplace", historica: false });

    const depois = montarLinhaDoTempo({
      modeloAtual: "full_service",
      trocas: [{ vigenciaInicio: "2026-09-13", modeloAnterior: r.modeloAnterior, modeloNovo: "full_service" }],
    });
    for (let d = 1; d <= 12; d += 1) {
      assert.equal(modeloNaData(depois, `2026-09-${String(d).padStart(2, "0")}`), "marketplace", `dia ${d}`);
    }
    for (let d = 13; d <= 30; d += 1) {
      assert.equal(modeloNaData(depois, `2026-09-${String(d).padStart(2, "0")}`), "full_service", `dia ${d}`);
    }
  });

  test("data futura é recusada (sem agendador); anterior à última troca é recusada; anterior ao mínimo é recusada", () => {
    const linha = montarLinhaDoTempo({ modeloAtual: "full_service", trocas: [TROCA_X] });
    assert.throws(() => validarNovaTroca({ linhaDoTempo: linha, trocas: [TROCA_X], modeloNovo: "marketplace", vigenciaInicio: "2026-09-20", hojeIso: HOJE }), /futura/);
    assert.throws(() => validarNovaTroca({ linhaDoTempo: linha, trocas: [TROCA_X], modeloNovo: "marketplace", vigenciaInicio: "2026-09-10", hojeIso: HOJE }), /depois da última troca/);
    assert.throws(() => validarNovaTroca({ linhaDoTempo: linha, trocas: [TROCA_X], modeloNovo: "marketplace", vigenciaInicio: "2026-09-13", hojeIso: HOJE }), /depois da última troca/);
    assert.throws(() => validarNovaTroca({ linhaDoTempo: linha, trocas: [TROCA_X], modeloNovo: "marketplace", vigenciaInicio: "2019-01-01", hojeIso: HOJE }), /anterior ao permitido/);
  });

  test("pedir o modelo que já vale não cria período (mudou=false)", () => {
    const linha = montarLinhaDoTempo({ modeloAtual: "full_service", trocas: [TROCA_X] });
    assert.deepEqual(
      validarNovaTroca({ linhaDoTempo: linha, trocas: [TROCA_X], modeloNovo: "full_service", vigenciaInicio: "2026-09-18", hojeIso: HOJE }),
      { mudou: false, modeloAnterior: "full_service", historica: false },
    );
  });

  test("uma segunda troca no futuro da primeira é aceita e encadeia (FS → MP em 01/10 não vale antes de hoje)", () => {
    const linha = montarLinhaDoTempo({ modeloAtual: "full_service", trocas: [TROCA_X] });
    const r = validarNovaTroca({ linhaDoTempo: linha, trocas: [TROCA_X], modeloNovo: "marketplace", vigenciaInicio: "2026-09-19", hojeIso: HOJE });
    assert.deepEqual(r, { mudou: true, modeloAnterior: "full_service", historica: false });
  });
});

describe("Declaração histórica — unidade que JÁ opera no modelo atual e informa desde quando (ex.: Subway Feiraguay)", () => {
  // unidades.modelo_logistico_ifood = full_service, mas nunca houve data registrada da troca.
  const feira = montarLinhaDoTempo({ modeloAtual: "full_service" });

  test("'Full Service desde 13/09, antes Marketplace' cria o ponto sem mudar o modelo de hoje", () => {
    const r = validarNovaTroca({ linhaDoTempo: feira, trocas: [], modeloNovo: "full_service", modeloAnterior: "marketplace", vigenciaInicio: "2026-09-13", hojeIso: HOJE });
    assert.deepEqual(r, { mudou: true, modeloAnterior: "marketplace", historica: true });
    const linha = montarLinhaDoTempo({ modeloAtual: "full_service", trocas: [{ vigenciaInicio: "2026-09-13", modeloAnterior: "marketplace", modeloNovo: "full_service" }] });
    assert.equal(modeloNaData(linha, "2026-09-10"), "marketplace");
    assert.equal(modeloNaData(linha, "2026-09-14"), "full_service");
  });

  test("sem o modelo anterior explícito, pedir o modelo que já vale continua sendo 'nada a fazer' (nunca se infere)", () => {
    assert.equal(validarNovaTroca({ linhaDoTempo: feira, trocas: [], modeloNovo: "full_service", vigenciaInicio: "2026-09-13", hojeIso: HOJE }).mudou, false);
  });

  test("recusa: já existe troca datada (o passado está definido), anterior = novo, ou anterior incoerente", () => {
    const comTroca = montarLinhaDoTempo({ modeloAtual: "full_service", trocas: [TROCA_X] });
    assert.throws(() => validarNovaTroca({ linhaDoTempo: comTroca, trocas: [TROCA_X], modeloNovo: "full_service", modeloAnterior: "marketplace", vigenciaInicio: "2026-09-18", hojeIso: HOJE }), /não corresponde ao modelo vigente/);
    assert.throws(() => validarNovaTroca({ linhaDoTempo: feira, trocas: [], modeloNovo: "full_service", modeloAnterior: "full_service", vigenciaInicio: "2026-09-13", hojeIso: HOJE }), /diferente do novo/);
    assert.throws(() => validarNovaTroca({ linhaDoTempo: feira, trocas: [], modeloNovo: "marketplace", modeloAnterior: "marketplace", vigenciaInicio: "2026-09-13", hojeIso: HOJE }), /diferente do novo/);
    assert.throws(() => validarNovaTroca({ linhaDoTempo: feira, trocas: [], modeloNovo: "full_service", modeloAnterior: "xpto", vigenciaInicio: "2026-09-13", hojeIso: HOJE }), /Modelo anterior inválido/);
  });

  test("troca comum com o modelo anterior informado: tem de bater com o vigente", () => {
    const mp = montarLinhaDoTempo({ modeloAtual: "marketplace" });
    assert.deepEqual(
      validarNovaTroca({ linhaDoTempo: mp, trocas: [], modeloNovo: "full_service", modeloAnterior: "marketplace", vigenciaInicio: "2026-09-13", hojeIso: HOJE }),
      { mudou: true, modeloAnterior: "marketplace", historica: false },
    );
    // Simétrico: "Marketplace desde 13/09, antes Full Service" numa unidade hoje Marketplace, sem troca datada, é uma declaração histórica válida.
    assert.deepEqual(
      validarNovaTroca({ linhaDoTempo: mp, trocas: [], modeloNovo: "marketplace", modeloAnterior: "full_service", vigenciaInicio: "2026-09-13", hojeIso: HOJE }),
      { mudou: true, modeloAnterior: "full_service", historica: true },
    );
  });
});

// ---------------------------------------------------------------------------
// metas.service com banco FAKE em memória (Caso F — multi-tenant; e a 089 ausente)
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

/** Banco fake: tabelas em memória; suporta o subconjunto do supabase-js que metas.service usa. */
function bancoFake(estado, { semColunaVigencia = false } = {}) {
  let seq = 0;
  function from(tabela) {
    const ctx = { op: "select", eq: [], inF: null, notNulo: null, patch: null, row: null };
    const linhas = () => (estado[tabela] ??= []);
    const casa = (r) =>
      ctx.eq.every(([c, v]) => r[c] === v)
      && (!ctx.inF || ctx.inF.vals.includes(r[ctx.inF.col]))
      && (!ctx.notNulo || r[ctx.notNulo] != null);
    const executar = (single) => {
      if (semColunaVigencia && tabela === "unidade_modelo_logistico_historico" && (ctx.notNulo === "vigencia_inicio" || ctx.row?.vigencia_inicio !== undefined)) {
        return { data: null, error: { code: "42703", message: 'column "vigencia_inicio" does not exist' } };
      }
      if (ctx.op === "insert") {
        const novo = { id: `id-${(seq += 1)}`, created_at: "2026-09-19T12:00:00Z", ...ctx.row };
        // trigger 089 (emulado): cadeia estritamente crescente e encadeada por unidade.
        if (tabela === "unidade_modelo_logistico_historico" && novo.vigencia_inicio) {
          const ult = linhas().filter((r) => r.unidade_id === novo.unidade_id && r.vigencia_inicio)
            .sort((a, b) => (a.vigencia_inicio < b.vigencia_inicio ? 1 : -1))[0];
          if (ult && (novo.vigencia_inicio <= ult.vigencia_inicio || novo.modelo_anterior !== ult.modelo_novo)) {
            return { data: null, error: { code: "23514", message: "cadeia de vigência inválida" } };
          }
        }
        linhas().push(novo);
        return { data: single ? { id: novo.id } : [novo], error: null };
      }
      if (ctx.op === "update") { linhas().filter(casa).forEach((r) => Object.assign(r, ctx.patch)); return { data: null, error: null }; }
      if (ctx.op === "delete") { estado[tabela] = linhas().filter((r) => !casa(r)); return { data: null, error: null }; }
      const achadas = linhas().filter(casa).map((r) => ({ ...r }));
      return single ? { data: achadas[0] ?? null, error: null } : { data: achadas, error: null };
    };
    const b = {
      select: () => b,
      eq: (c, v) => (ctx.eq.push([c, v]), b),
      in: (c, vals) => ((ctx.inF = { col: c, vals }), b),
      not: (c) => ((ctx.notNulo = c), b),
      order: () => b, limit: () => b,
      insert: (row) => ((ctx.op = "insert"), (ctx.row = row), b),
      update: (patch) => ((ctx.op = "update"), (ctx.patch = patch), b),
      delete: () => ((ctx.op = "delete"), b),
      maybeSingle: () => Promise.resolve(executar(true)),
      single: () => Promise.resolve(executar(true)),
      then: (res, rej) => Promise.resolve(executar(false)).then(res, rej),
    };
    return b;
  }
  return { from };
}

const ORG_A = "org-a";
const ORG_B = "org-b";
const cenarioMultiTenant = () => ({
  unidades: [
    { id: "uni-a1", organizacao_id: ORG_A, nome: "A1", modelo_logistico_ifood: "marketplace", eh_teste: false },
    { id: "uni-a2", organizacao_id: ORG_A, nome: "A2", modelo_logistico_ifood: "marketplace", eh_teste: false },
    { id: "uni-b1", organizacao_id: ORG_B, nome: "B1", modelo_logistico_ifood: "marketplace", eh_teste: false },
  ],
  unidade_modelo_logistico_historico: [],
});
const usuario = { id: "u1", nome: "Admin", email: "a@x.com" };

async function metasService(estado, opcoes) {
  return carregar("dashboardExecutivo.metas.service.js", { "../../config/supabase.js": { supabase: bancoFake(estado, opcoes) } });
}

describe("metas.service — troca com vigência (banco fake)", () => {
  test("Caso E (persistência): trocar hoje p/ Full Service com vigência 13/09 mantém 01–12 em Marketplace", async () => {
    const estado = cenarioMultiTenant();
    const svc = await metasService(estado);

    const r = await svc.definirModeloLogistico({
      unidadeId: "uni-a1", organizacaoId: ORG_A, modeloNovo: "full_service", vigenciaInicio: "2026-09-13", usuario, hojeIso: HOJE,
    });
    assert.equal(r.mudou, true);
    assert.equal(r.retroativa, true);
    assert.equal(r.vigenciaInicio, "2026-09-13");

    // O modelo "de hoje" acompanha; a história por data continua correta.
    assert.equal(estado.unidades.find((u) => u.id === "uni-a1").modelo_logistico_ifood, "full_service");
    const m = await svc.obterModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_A });
    assert.equal(m.modeloLogistico, "full_service");
    assert.equal(modeloNaData(m.linhaDoTempo, "2026-09-10"), "marketplace");
    assert.equal(modeloNaData(m.linhaDoTempo, "2026-09-14"), "full_service");
  });

  test("obterModeloLogisticoNaData: 10/09 -> marketplace, 14/09 -> full_service", async () => {
    const estado = cenarioMultiTenant();
    const svc = await metasService(estado);
    await svc.definirModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_A, modeloNovo: "full_service", vigenciaInicio: "2026-09-13", usuario, hojeIso: HOJE });
    const a = await svc.obterModeloLogisticoNaData({ unidadeId: "uni-a1", organizacaoId: ORG_A, data: "2026-09-10" });
    const b = await svc.obterModeloLogisticoNaData({ unidadeId: "uni-a1", organizacaoId: ORG_A, data: "2026-09-14" });
    assert.equal(a.modeloLogistico, "marketplace");
    assert.equal(b.modeloLogistico, "full_service");
    assert.equal(b.modeloLogisticoRotulo, "Full Service");
  });

  test("Feiraguay: unidade já em Full Service declara 'FS desde 13/09, antes Marketplace' — histórico datado, modelo de hoje intacto", async () => {
    const estado = cenarioMultiTenant();
    estado.unidades.find((u) => u.id === "uni-a1").modelo_logistico_ifood = "full_service"; // já trocou (sem data registrada)
    const svc = await metasService(estado);
    const r = await svc.definirModeloLogistico({
      unidadeId: "uni-a1", organizacaoId: ORG_A, modeloNovo: "full_service", modeloAnterior: "marketplace", vigenciaInicio: "2026-09-13", usuario, hojeIso: HOJE,
    });
    assert.equal(r.mudou, true);
    assert.equal(r.declaracaoHistorica, true);
    assert.equal(estado.unidades.find((u) => u.id === "uni-a1").modelo_logistico_ifood, "full_service");
    const a = await svc.obterModeloLogisticoNaData({ unidadeId: "uni-a1", organizacaoId: ORG_A, data: "2026-09-10" });
    const b = await svc.obterModeloLogisticoNaData({ unidadeId: "uni-a1", organizacaoId: ORG_A, data: "2026-09-14" });
    assert.deepEqual([a.modeloLogistico, b.modeloLogistico], ["marketplace", "full_service"]);
    // Outras unidades da mesma org não mudam.
    assert.equal((await svc.obterModeloLogisticoNaData({ unidadeId: "uni-a2", organizacaoId: ORG_A, data: "2026-09-10" })).modeloLogistico, "marketplace");
  });

  test("a data de vigência é OBRIGATÓRIA (nada de troca retroativa silenciosa)", async () => {
    const svc = await metasService(cenarioMultiTenant());
    await assert.rejects(
      svc.definirModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_A, modeloNovo: "full_service", usuario, hojeIso: HOJE }),
      /Informe a data/,
    );
  });

  test("Caso F — multi-tenant: mudar a Unidade A1 não afeta A2 (mesma org) nem B1 (outra org)", async () => {
    const estado = cenarioMultiTenant();
    const svc = await metasService(estado);
    await svc.definirModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_A, modeloNovo: "full_service", vigenciaInicio: "2026-09-13", usuario, hojeIso: HOJE });

    for (const [uni, org] of [["uni-a2", ORG_A], ["uni-b1", ORG_B]]) {
      const m = await svc.obterModeloLogistico({ unidadeId: uni, organizacaoId: org });
      assert.equal(m.modeloLogistico, "marketplace", `${uni} segue Marketplace`);
      assert.deepEqual(m.linhaDoTempo, [{ modelo: "marketplace", inicio: null, fim: null }], `${uni} sem períodos novos`);
      assert.equal(modeloNaData(m.linhaDoTempo, "2026-09-14"), "marketplace");
    }
    assert.equal(estado.unidade_modelo_logistico_historico.length, 1);
    assert.equal(estado.unidade_modelo_logistico_historico[0].unidade_id, "uni-a1");
  });

  test("Caso F — a troca não atravessa organizações: org B não consegue trocar nem ler a unidade da org A", async () => {
    const estado = cenarioMultiTenant();
    const svc = await metasService(estado);
    await assert.rejects(
      svc.definirModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_B, modeloNovo: "full_service", vigenciaInicio: "2026-09-13", usuario, hojeIso: HOJE }),
      /Unidade não encontrada/,
    );
    await assert.rejects(svc.obterModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_B }), /Unidade não encontrada/);
    assert.equal(estado.unidades.find((u) => u.id === "uni-a1").modelo_logistico_ifood, "marketplace");
    assert.equal(estado.unidade_modelo_logistico_historico.length, 0);
  });

  test("vigência anterior à última troca é recusada e nada é gravado", async () => {
    const estado = cenarioMultiTenant();
    const svc = await metasService(estado);
    await svc.definirModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_A, modeloNovo: "full_service", vigenciaInicio: "2026-09-13", usuario, hojeIso: HOJE });
    await assert.rejects(
      svc.definirModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_A, modeloNovo: "marketplace", vigenciaInicio: "2026-09-05", usuario, hojeIso: HOJE }),
      /depois da última troca/,
    );
    assert.equal(estado.unidade_modelo_logistico_historico.length, 1);
    assert.equal(estado.unidades.find((u) => u.id === "uni-a1").modelo_logistico_ifood, "full_service");
  });

  test("mesmo modelo: registra o pedido (auditoria sem vigência) e NÃO cria período", async () => {
    const estado = cenarioMultiTenant();
    const svc = await metasService(estado);
    const r = await svc.definirModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_A, modeloNovo: "marketplace", vigenciaInicio: "2026-09-13", usuario, hojeIso: HOJE });
    assert.equal(r.mudou, false);
    assert.equal(estado.unidade_modelo_logistico_historico.length, 1);
    assert.equal(estado.unidade_modelo_logistico_historico[0].vigencia_inicio, undefined);
    const m = await svc.obterModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_A });
    assert.equal(m.linhaDoTempo.length, 1);
  });

  test("linhas ANTIGAS (auditoria sem vigência) não definem período — o histórico existente não é reinterpretado", async () => {
    const estado = cenarioMultiTenant();
    estado.unidade_modelo_logistico_historico.push({
      id: "legado", unidade_id: "uni-a1", organizacao_id: ORG_A, modelo_anterior: "full_service", modelo_novo: "marketplace",
      vigencia_inicio: null, created_at: "2026-01-10T00:00:00Z",
    });
    const svc = await metasService(estado);
    const m = await svc.obterModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_A });
    assert.deepEqual(m.linhaDoTempo, [{ modelo: "marketplace", inicio: null, fim: null }]);
    assert.equal(modeloNaData(m.linhaDoTempo, "2026-01-05"), "marketplace", "mesmo comportamento de hoje: o modelo atual vale para tudo");
  });

  test("ambiente SEM a migration 089: leitura cai no modelo atual; gravação falha com mensagem clara", async () => {
    const estado = cenarioMultiTenant();
    const svc = await metasService(estado, { semColunaVigencia: true });
    const m = await svc.obterModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_A });
    assert.equal(m.modeloLogistico, "marketplace");
    assert.equal(m.linhaDoTempo.length, 1);
    await assert.rejects(
      svc.definirModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_A, modeloNovo: "full_service", vigenciaInicio: "2026-09-13", usuario, hojeIso: HOJE }),
      /migration 089/,
    );
    assert.equal(estado.unidades.find((u) => u.id === "uni-a1").modelo_logistico_ifood, "marketplace");
  });

  test("histórico devolve a vigência de cada troca", async () => {
    const estado = cenarioMultiTenant();
    const svc = await metasService(estado);
    await svc.definirModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_A, modeloNovo: "full_service", vigenciaInicio: "2026-09-13", usuario, motivo: "Migração", hojeIso: HOJE });
    const h = await svc.historicoModeloLogistico({ unidadeId: "uni-a1", organizacaoId: ORG_A });
    assert.equal(h.length, 1);
    assert.equal(h[0].vigenciaInicio, "2026-09-13");
    assert.equal(h[0].modeloAnteriorRotulo, "Marketplace");
    assert.equal(h[0].modeloNovoRotulo, "Full Service");
  });
});
