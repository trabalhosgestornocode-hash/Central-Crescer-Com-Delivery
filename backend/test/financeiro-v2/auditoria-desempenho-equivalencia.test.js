// Execução 07 — a otimização da apuração (carregar SÓ o mês, filtrado no banco) não muda nada: para cada competência de
// um cenário de vários meses, a apuração do núcleo é IDÊNTICA à apuração pura calculada sobre o histórico COMPLETO.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apurar } from "../../src/modules/financeiro-v2/index.js";
import { montarComCadastros, obrigacao, saida } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, saiposVendas } from "./helpers/arquivos.js";

const TIPOS = { lancamentos: "LANCAMENTO", categorias: "CATEGORIA", vendas: "VENDA", propostas: "PROPOSTA", obrigacoes: "OBRIGACAO", movimentacoes: "MOVIMENTACAO", recebiveis: "RECEBIVEL", ajustes: "AJUSTE", competencias: "COMPETENCIA" };
const semHora = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === "apuradoEm" ? undefined : x)));

test("apuração carregada só com o mês = apuração sobre o histórico completo (todas as competências)", async () => {
  const { nucleo: n, c, banco, caixa, fornecedor } = await montarComCadastros();
  let k = 0;
  for (const [mes, dia] of [["2026-06", "10"], ["2026-07", "12"], ["2026-08", "14"], ["2026-09", "03"]]) {
    const v = await n.registrarVenda(c, { canal: "BALCAO", dataVenda: `${mes}-${dia}`, brutoCentavos: 4000 + k, fonte: { sistema: "MANUAL", idExterno: `EQ-${(k += 1)}` }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 4000 + k - 1 }] });
    await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: v.recebiveis[0].id, valorCentavos: -100, motivo: "Taxa", categoria: "TAXAS_STONE" });
    await n.registrarVenda(c, { canal: "IFOOD", dataVenda: `${mes}-${dia}`, brutoCentavos: 2500, fonte: { sistema: "MANUAL", idExterno: `EQ-${(k += 1)}` }, composicao: { itensCentavos: 2500, descontos: [{ valorCentavos: 200, financiador: "PENDENTE" }] }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 2300, contaId: caixa.id }] });
    const o = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { competencia: mes, dataEmissao: `${mes}-02`, vencimento: `${mes}-20`, valorOriginalCentavos: 3000, parcelas: 2 }))).obrigacoes[0];
    const m = (await n.registrarMovimentacao(c, saida(banco.id, 1500, { dataEfetiva: `${mes}-20` }))).movimentacao;
    await n.registrarLiquidacao(c, { movimentacaoId: m.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: o.id, valorCentavos: 1500 }] });
    await n.registrarMovimentacao(c, saida(banco.id, 77, { dataEfetiva: `${mes}-25`, natureza: "OUTRA" }));
  }
  // Importação com propostas pendentes em setembro (entra como pendência da apuração).
  const r = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", ...PERIODO_SETEMBRO, conteudo: saiposVendas([{ pedido: "P-1", data: "05/09/2026 12:00", canal: "Balcão", itens: 3000, forma: "Dinheiro" }]) });
  const conf = await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia });
  await n.gerarPropostas(c, { importacaoId: conf.importacao.id, contaCaixaId: caixa.id });
  const tudo = {};
  for (const [chave, tipo] of Object.entries(TIPOS)) tudo[chave] = await n.consultarRegistros(c, { tipo });
  for (const competencia of ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]) {
    const doNucleo = await n.apurarCompetencia(c, { competencia });
    const completa = apurar(tudo, { competencia, escopo: { organizacaoId: c.organizacaoId, unidadeId: c.unidadeId }, apuradoEm: "x" });
    assert.deepEqual(semHora(doNucleo.entradas), semHora(completa.entradas), `${competencia}: entradas`);
    assert.deepEqual(semHora(doNucleo.dre), semHora(completa.dre), `${competencia}: DRE`);
    assert.deepEqual(semHora(doNucleo.indicadores), semHora(completa.indicadores), `${competencia}: indicadores`);
    assert.deepEqual(semHora(doNucleo.pendencias), semHora(completa.pendencias), `${competencia}: pendências`);
    assert.deepEqual(semHora(doNucleo.cadaCem), semHora(completa.cadaCem), `${competencia}: cada R$ 100`);
  }
});
