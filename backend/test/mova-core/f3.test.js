// MOVA CORE — F3: análise parametrizada expandida (períodos relativos, participação, médias, tendência, cobertura e matriz de
// compatibilidade) e percentuais validados pelo backend. Porta de leitura SINTÉTICA com números conhecidos (contas, vendas,
// entregadores) por unidade e competência.
import assert from "node:assert/strict";
import test from "node:test";
import { FERRAMENTA_ANALISAR, MATRIZ_DE_COMPATIBILIDADE, METRICAS, competenciasDoPeriodo } from "../../src/modules/mova-core/analise.js";
import { verificarFidelidade } from "../../src/modules/mova-core/verificador.js";

const U1 = { id: "u1", nome: "Alfa Centro" }; const U2 = { id: "u2", nome: "Alfa Norte" };
const conta = (f, comp, valor, extra = {}) => ({ id: `${f}-${comp}-${valor}`, fornecedor: { nome: f }, descricao: "compra", categoria: { nome: extra.cat ?? "Insumos" }, competencia: comp, situacao: "EM_ABERTO", valorOriginalCentavos: valor, saldoCentavos: valor, pagoCentavos: 0, ...extra });
const DADOS = {
  u1: {
    contas: { "2026-09": [conta("Atacadão", "2026-09", 10000)], "2026-10": [conta("Atacadão", "2026-10", 20000), conta("Coca", "2026-10", 30000, { cat: "Bebidas" })], "2026-11": [conta("Atacadão", "2026-11", 40000), conta("Coca", "2026-11", 10000, { cat: "Bebidas" })] },
    vendas: { "2026-10": { brutoCentavos: 1_000_000, liquidoCentavos: 800_000, quantidade: 400 }, "2026-11": { brutoCentavos: 1_200_000, liquidoCentavos: 950_000, quantidade: 400 } },
    entregadores: { "2026-11": [{ nome: "Matheus Rocha", entregas: 40, totalCentavos: 44000 }, { nome: "João", entregas: 10, totalCentavos: 12000 }] },
  },
  u2: { contas: { "2026-11": [conta("Atacadão", "2026-11", 5000)] }, vendas: { "2026-11": { brutoCentavos: 600_000, liquidoCentavos: 500_000, quantidade: 300 } }, entregadores: {} },
};
function porta({ semPermissao = [], truncar = false } = {}) {
  const leituras = [];
  return {
    leituras,
    async permissoesDoUsuario(esc) { return semPermissao.includes(esc.unidadeId) ? [] : ["financeiro_v2.ver"]; },
    async ler(op, esc, e) {
      leituras.push({ op, unidadeId: esc.unidadeId, ...e });
      const d = DADOS[esc.unidadeId];
      if (op === "consultarContasAPagar") return { itens: d.contas[e.competencia] ?? [], paginacao: { paginas: truncar ? 99 : 1 } };
      if (op === "consultarVendas") return { resumo: d.vendas[e.competencia] ?? null };
      if (op === "consultarEntregadoresProprios") return { entregadores: d.entregadores[e.mes] ?? [] };
      throw new Error(op);
    },
  };
}
const sessao = (x = {}) => ({ unidadesPermitidas: [U1, U2], hoje: "2026-11-24", ...x });
const analisar = (args, { p = porta(), s = sessao() } = {}) => FERRAMENTA_ANALISAR.executar({ porta: p, escopo: { organizacaoId: "o", unidadeId: "u1" }, args, sessao: s });

test("AN-03 PERÍODOS RELATIVOS resolvidos pelo código a partir de HOJE (nunca do modelo); acima de 6 meses é recusado", async () => {
  assert.deepEqual(competenciasDoPeriodo("MES_ANTERIOR", "2026-01-10"), ["2025-12"]);
  assert.deepEqual(competenciasDoPeriodo("ULTIMOS_3_MESES", "2026-11-24"), ["2026-09", "2026-10", "2026-11"]);
  assert.equal(competenciasDoPeriodo("ANO_ATUAL", "2026-11-24").length, 11);
  const r = await analisar({ metrica: "DESPESAS", periodo: "MES_ANTERIOR" });
  assert.deepEqual(r.dados.competencias, ["2026-10"]);
  assert.equal(r.dados.linhas[0].porCompetencia["2026-10"], 50000);
  assert.equal((await analisar({ metrica: "DESPESAS", periodo: "ANO_ATUAL" })).erro, "ANALISE_GRANDE_DEMAIS");
  assert.equal((await analisar({ metrica: "DESPESAS", periodo: "MES_ATUAL" }, { s: sessao({ hoje: null }) })).erro, "ARGUMENTO_INVALIDO", "sem a data do servidor não chuta");
});

test("AN-04 PARTICIPAÇÃO no total e VARIAÇÃO % calculadas pelo código; percentual citado passa no verificador, inventado é reprovado", async () => {
  const r = await analisar({ metrica: "DESPESAS", agruparPor: "FORNECEDOR", competencias: ["2026-10", "2026-11"], ordem: "MAIOR_CRESCIMENTO" });
  const at = r.dados.linhas.find((l) => l.grupo === "Atacadão");
  assert.deepEqual([at.diferenca, at.variacaoPercentual, at.participacaoPercentual], [20000, 100, 80]);
  assert.equal(r.dados.linhas[0].grupo, "Atacadão", "maior crescimento primeiro");
  const ctx = { fatos: r.fatos, unidades: ["Alfa Centro", "Alfa Norte"] };
  assert.equal(verificarFidelidade("O Atacadão subiu 100% (de R$ 200,00 para R$ 400,00) e hoje é 80% das despesas.", ctx).ok, true);
  const errado = verificarFidelidade("O Atacadão subiu 120% e hoje é 80% das despesas.", ctx);
  assert.deepEqual(errado.violacoes.map((v) => v.tipo), ["PERCENTUAL_SEM_FONTE"]);
});

test("AN-05 MÉDIAS compostas: ticket médio e custo por entrega somam numerador e denominador (nunca média de médias)", async () => {
  const t = await analisar({ metrica: "TICKET_MEDIO", competencias: ["2026-10", "2026-11"] });
  assert.deepEqual(t.dados.linhas[0].porCompetencia, { "2026-10": 2500, "2026-11": 3000 });
  assert.equal(t.dados.linhas[0].mediaDoPeriodo, 2750, "2.200.000 ÷ 800, não (2500+3000)/2 por acaso igual");
  const u = await analisar({ metrica: "TICKET_MEDIO", agruparPor: "UNIDADE", competencias: ["2026-11"] });
  assert.deepEqual(u.dados.linhas.map((l) => [l.grupo, l.porCompetencia["2026-11"]]), [["Alfa Centro", 3000], ["Alfa Norte", 2000]]);
  const e = await analisar({ metrica: "CUSTO_POR_ENTREGA", agruparPor: "ENTREGADOR", competencias: ["2026-11"] });
  assert.deepEqual(e.dados.linhas.map((l) => [l.grupo, l.porCompetencia["2026-11"]]), [["João", 1200], ["Matheus Rocha", 1100]]);
  const geral = await analisar({ metrica: "CUSTO_POR_ENTREGA", competencias: ["2026-11"] });
  assert.equal(geral.dados.linhas[0].porCompetencia["2026-11"], 1120, "56.000 ÷ 50 entregas");
  assert.ok(verificarFidelidade("O custo médio por entrega foi R$ 11,20.", { fatos: geral.fatos.map((f) => ({ ...f, significado: f.significado })) }).ok);
  assert.equal((await analisar({ metrica: "ENTREGAS", competencias: ["2026-11"] })).dados.valoresEm, "quantidade", "quantidade de entregas ≠ custo das entregas");
});

test("AN-06 TENDÊNCIA com 3+ meses (inclinação relativa, não só 1º × último)", async () => {
  const r = await analisar({ metrica: "DESPESAS", agruparPor: "FORNECEDOR", termo: "atacadao", competencias: ["2026-09", "2026-10", "2026-11"] });
  assert.equal(r.dados.linhas[0].tendencia, "ALTA");
  const dois = await analisar({ metrica: "DESPESAS", competencias: ["2026-10", "2026-11"] });
  assert.equal(dois.dados.linhas[0].tendencia, undefined, "com 2 meses não há tendência, só variação");
});

test("AN-07 MATRIZ de compatibilidade: agrupamento sem significado é recusado com explicação; toda métrica tem linha na matriz", async () => {
  for (const k of Object.keys(METRICAS)) assert.ok(MATRIZ_DE_COMPATIBILIDADE[k].NENHUM, k);
  assert.equal(MATRIZ_DE_COMPATIBILIDADE.VENDAS_BRUTAS.FORNECEDOR, false);
  assert.equal(MATRIZ_DE_COMPATIBILIDADE.ENTREGAS.CATEGORIA, false);
  const r = await analisar({ metrica: "VENDAS_BRUTAS", agruparPor: "FORNECEDOR", competencias: ["2026-11"] });
  assert.equal(r.erro, "AGRUPAMENTO_NAO_SUPORTADO"); assert.match(r.dados.mensagem, /não tem significado/);
});

test("AN-08 COBERTURA: unidade sem permissão, leitura truncada e linhas omitidas ⇒ recorte parcial, nunca 'total consolidado'", async () => {
  const p = porta({ semPermissao: ["u2"] });
  const r = await analisar({ metrica: "DESPESAS", agruparPor: "UNIDADE", competencias: ["2026-11"] }, { p });
  assert.deepEqual([r.dados.cobertura.unidadesSemPermissao, r.dados.cobertura.completa], [["Alfa Norte"], false]);
  assert.ok(!p.leituras.some((x) => x.unidadeId === "u2"), "nada lido da unidade sem permissão");
  assert.equal(r.dados.totalDoUltimoMes, undefined); assert.equal(r.dados.totalDasLinhasMostradas, 50000);
  const tr = await analisar({ metrica: "DESPESAS", competencias: ["2026-11"] }, { p: porta({ truncar: true }) });
  assert.equal(tr.dados.cobertura.leituraTruncada, true); assert.match(tr.dados.cobertura.aviso, /RECORTE PARCIAL/);
  const lim = await analisar({ metrica: "DESPESAS", agruparPor: "FORNECEDOR", competencias: ["2026-11"], limite: 1 });
  assert.equal(lim.dados.cobertura.linhasOmitidas, 1);
  assert.ok(lim.dados.totalDasLinhasMostradas, "com linha omitida, o total é só das linhas mostradas");
  const ok = await analisar({ metrica: "DESPESAS", agruparPor: "UNIDADE", competencias: ["2026-11"] });
  assert.equal(ok.dados.cobertura.completa, true); assert.equal(ok.dados.totalDoUltimoMes, 55000);
  assert.deepEqual(ok.dados.linhas.map((l) => [l.grupo, l.participacaoPercentual]), [["Alfa Centro", 90.9], ["Alfa Norte", 9.1]], "participação ENTRE unidades");
});

test("AN-09 meses sem dado aparecem na cobertura (não viram zero silencioso)", async () => {
  const r = await analisar({ metrica: "VENDAS_BRUTAS", agruparPor: "UNIDADE", competencias: ["2026-10", "2026-11"] });
  assert.deepEqual(r.dados.cobertura.mesesSemDados, ["Alfa Norte 2026-10"]);
});
