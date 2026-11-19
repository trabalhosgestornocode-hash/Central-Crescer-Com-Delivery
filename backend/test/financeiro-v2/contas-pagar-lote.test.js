// Contas a pagar em lote (Subway): prévia sem efeito, aplicação idempotente pelo registrarObrigacao, nunca baixa, DRE correta
// (patrimonial e pendente fora da DRE), calendário nas datas informadas. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { aplicarContasPagarLote, montarPreviaContasPagarLote, efeitoNaDre } from "../../src/modules/financeiro-v2/aplicacao/contasPagarLote.js";
import { MODELO_DE_PLANO } from "../../src/modules/financeiro-v2/dominio/planoDeContas.js";
import { ctx, montar } from "./helpers/cenario.js";

const c = ctx();
const AGORA = new Date("2026-11-20T15:00:00.000Z");
const LOTE = "teste-lote-1";
const L = (n, fornecedor, descricao, valorCentavos, vencimento, competencia, categoria, conferencia) =>
  ({ n, fornecedor, descricao, valorCentavos, vencimento, competencia, categoria, ...(conferencia ? { conferencia } : {}) });
const LINHAS = () => [
  L(1, "Fornecedor A", "Mercadorias sintéticas", 100000, "2026-11-10", "2026-11", "INSUMOS"),
  L(2, "Franqueadora", "Royalties sintéticos", 50000, "2026-11-11", "2026-10", "ROYALTIES"),
  L(3, "Folha", "VR sintético", 12000, "2026-11-17", "2026-11", "VALE_REFEICAO"),
  L(4, "Sócios", "Distribuição sintética", 30000, "2026-11-11", "2026-11", "DISTRIBUICAO_DE_LUCROS"),
  L(5, "Sócios", "Distribuição sintética", 30000, "2026-11-11", "2026-11", "DISTRIBUICAO_DE_LUCROS"),
  L(6, "Banco", "Parcela sintética", 80000, "2026-11-16", "2026-11", "EMPRESTIMOS_E_FINANCIAMENTOS"),
  L(7, "Prestador", "Natureza a confirmar", 7000, "2026-11-20", "2026-11", "DESPESAS_A_CLASSIFICAR", { codigo: "CLASSIFICACAO_PENDENTE", nota: "identificar" }),
];

test("modelo SUBWAY: franquia (royalties e AFSB) separada de comercial; lucros patrimonial; sem categorias de açaí", () => {
  const cod = new Set(MODELO_DE_PLANO.SUBWAY.map((d) => d.codigo));
  for (const k of ["DESPESAS_DE_FRANQUIA", "ROYALTIES", "FUNDO_DE_PUBLICIDADE_AFSB", "DISTRIBUICAO_DE_LUCROS", "VALE_REFEICAO", "VALE_TRANSPORTE", "INSUMOS", "COMISSOES_IFOOD"]) assert.ok(cod.has(k), k);
  for (const k of ["FRUTAS", "BROWNIES", "ACAI_DISTRIBUIDORA"]) assert.ok(!cod.has(k), k);
  assert.equal(MODELO_DE_PLANO.SUBWAY.find((d) => d.codigo === "ROYALTIES").pai, "DESPESAS_DE_FRANQUIA");
  assert.equal(efeitoNaDre("ROYALTIES"), "DRE");
  assert.equal(efeitoNaDre("DISTRIBUICAO_DE_LUCROS"), "FORA_DA_DRE_PATRIMONIAL");
  assert.equal(efeitoNaDre("EMPRESTIMOS_E_FINANCIAMENTOS"), "FORA_DA_DRE_PATRIMONIAL");
  assert.equal(efeitoNaDre("DESPESAS_A_CLASSIFICAR"), "PENDENTE_FORA_DA_DRE");
});

test("prévia: valida, não grava, resume por efeito; erro bloqueia; semelhante já existente bloqueia", () => {
  const p = montarPreviaContasPagarLote(LINHAS(), { lote: LOTE });
  assert.equal(p.apto, true);
  assert.equal(p.resumo.valorTotalCentavos, 309000);
  assert.deepEqual(p.resumo.porEfeito, { DRE: { quantidade: 2, valorCentavos: 112000 }, FORA_DA_DRE_PATRIMONIAL: { quantidade: 4, valorCentavos: 190000 }, PENDENTE_FORA_DA_DRE: { quantidade: 1, valorCentavos: 7000 } });
  // competência de outubro (linha 2) < início (2026-11): obrigação ANTERIOR, patrimonial, competência da abertura, emissão até o corte
  assert.deepEqual(p.resumo.anteriores, [2]);
  const l2 = p.itens.find((i) => i.n === 2);
  assert.deepEqual([l2.categoria, l2.competencia, l2.competenciaOriginal, l2.efeito, l2.dataEmissao, p.dataDeCorte], ["TITULOS_ANTERIORES_A_ABERTURA", "2026-11", "2026-10", "FORA_DA_DRE_PATRIMONIAL", "2026-10-31", "2026-10-31"]);
  assert.deepEqual(p.resumo.emConferencia, [{ n: 7, codigo: "CLASSIFICACAO_PENDENTE" }]);
  const ruim = montarPreviaContasPagarLote([...LINHAS(), L(8, "X", "Y", 0, "2026-02-30", "2026-11", "NAO_EXISTE")], { lote: LOTE });
  assert.equal(ruim.apto, false);
  assert.match(ruim.erros[0].motivo, /valor.*vencimento.*categoria/);
  const sem = montarPreviaContasPagarLote(LINHAS(), { lote: LOTE, existentes: [{ fornecedor: "fornecedor a", valorCentavos: 100000, vencimento: "2026-11-10", descricao: "MERCADORIAS SINTÉTICAS", fonte: null }] });
  assert.deepEqual(sem.resumo.possiveisDuplicidades, [1]);
  assert.equal(sem.apto, false);
});

test("aplicação: todas ABERTAS (sem baixa), calendário nas datas, DRE só das despesas classificadas, reaplicar não duplica", async () => {
  const { nucleo: n } = montar({ plano: "SUBWAY", relogio: () => AGORA });
  const p = montarPreviaContasPagarLote(LINHAS(), { lote: LOTE });
  await assert.rejects(aplicarContasPagarLote(n, c, p, { so: "ANTERIORES" }), /abertura/i, "anterior sem abertura configurada é recusada");
  await n.configurarAbertura(c, { competencia: "2026-11" });
  const ant = await aplicarContasPagarLote(n, c, p, { so: "ANTERIORES" });
  assert.deepEqual(ant.aplicadas, [2]);
  const r = await aplicarContasPagarLote(n, c, p, { so: "DO_PERIODO" });
  assert.deepEqual(r.aplicadas, [1, 3, 4, 5, 6, 7]);
  await n.concluirAbertura(c, { justificativa: "Conferida com o lote sintético." });
  const obr = await n.consultarRegistros(c, { tipo: "OBRIGACAO" });
  assert.equal(obr.length, 7);
  assert.ok(obr.every((o) => o.saldoCentavos === o.valorBaseCentavos && o.liquidadoCentavos === 0), "nenhuma baixa");
  assert.equal((await n.consultarRegistros(c, { tipo: "LIQUIDACAO" })).length, 0);
  assert.equal(obr.reduce((s, o) => s + o.valorBaseCentavos, 0), 309000);
  const cal = await CONSULTAS["/calendario"](n, c, { mes: "2026-11" });
  assert.match(JSON.stringify(cal), /2026-11-17/);
  // de novo: a prévia reconhece as já registradas e a aplicação não cria nada
  const existentes = obr.map((o) => ({ fornecedor: "", valorCentavos: o.valorBaseCentavos, vencimento: o.vencimento, descricao: o.descricao, fonte: o.fonte }));
  const p2 = montarPreviaContasPagarLote(LINHAS(), { lote: LOTE, existentes });
  assert.equal(p2.resumo.jaRegistradas, 7);
  const r2 = await aplicarContasPagarLote(n, c, p2);
  assert.deepEqual(r2.aplicadas, []);
  assert.equal((await n.consultarRegistros(c, { tipo: "OBRIGACAO" })).length, 7);
  // mesmo envio direto repetido: o núcleo devolve o registro (chave estável), sem duplicar
  const p3 = montarPreviaContasPagarLote(LINHAS(), { lote: LOTE });
  const r3 = await aplicarContasPagarLote(n, c, p3, { so: "DO_PERIODO" });
  assert.deepEqual([r3.aplicadas.length, r3.repetidas.length], [0, 6]);
  await assert.rejects(aplicarContasPagarLote(n, c, p3, { so: "ANTERIORES" }), /abertura/i, "abertura concluída: anterior não entra de novo (falha fechada)");
  assert.equal((await n.consultarRegistros(c, { tipo: "OBRIGACAO" })).length, 7);
  // DRE: lucros e empréstimo (patrimoniais) e a pendente não entram
  const lanc = (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((l) => l.situacao === "ATIVO");
  const naDre = lanc.filter((l) => l.natureza === "DESPESA" && l.categoria !== "DESPESAS_A_CLASSIFICAR");
  assert.deepEqual(naDre.map((l) => l.categoria).sort(), ["INSUMOS", "VALE_REFEICAO"], "royalties de outubro não é despesa de novembro");
  assert.ok(!lanc.some((l) => l.categoria === "ROYALTIES"));
  const pend = await CONSULTAS["/conferencias"](n, c, { competencia: "2026-11" });
  assert.equal(pend.pendencias.porGrupo.CLASSIFICACOES.abertas, 1, "a pendente aparece na Central de Conferências");
  assert.equal(pend.divergenciasRelevantes.find((d) => d.codigo === "CLASSIFICACAO_PROVISORIA").valorCentavos, 7000);
});
