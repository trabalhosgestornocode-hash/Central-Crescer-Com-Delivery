// Abertura real em 09/2026 (corte 31/08/2026) e reconstrução de setembro, outubro e novembro — ENSAIO com dados SINTÉTICOS
// (nenhum valor real; doc 33). Mesmo caminho da tela (ESCRITAS da plataforma) e do núcleo. Roda em memória e, com
// FV2_REPOSITORIO=postgres, no banco isolado (RLS, histórico, travas reais).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ORG_A, UNI_A2, ctx, montar, rejeita } from "./helpers/cenario.js";
import { saiposVendas } from "./helpers/arquivos.js";

const RELOGIO = () => new Date("2026-11-16T15:00:00.000Z");
const c = ctx();
const ACEITE = { aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas no ensaio." };
const bruto = async (n, competencia, x = c) => (await n.apurarCompetencia(x, { competencia })).indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos;
const resultado = async (n, competencia) => (await n.apurarCompetencia(c, { competencia })).indicadores.RESULTADO_GERENCIAL.valorCentavos;
const saldoDe = async (n, id) => (await n.consultarContasAReceber(c, { tamanho: 100 })).itens.find((x) => x.id === id).saldoCentavos;

test("reconstrução 09→11/2026: abertura em 31/08, posições patrimoniais, vendas, recebimentos posteriores, estorno e reimportação sem duplicar", async () => {
  const { nucleo: n } = montar({ relogio: RELOGIO, plano: false });
  const W = async (caminho, corpo) => ESCRITAS[caminho].fazer(n, c, corpo);

  // 1–2. Plano ACAITERIA (modelo redigitado) e as duas contas da operação.
  const plano = await W("/configuracoes/implantar-plano", { modelo: "ACAITERIA", modeloConfirmado: "ACAITERIA" });
  for (const k of ["ACAI_DISTRIBUIDORA", "ALUGUEL", "ENTREGADORES_PROPRIOS", "TITULOS_ANTERIORES_A_ABERTURA"]) assert.ok(plano.criadas.includes(k), k);
  const banco = await W("/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Unicred" });
  const caixa = await W("/configuracoes/conta/criar", { tipo: "CAIXA_FISICO", nome: "Caixa da loja" });

  // 3. Abertura em 09/2026: corte 31/08, compatível (nenhum lançamento de resultado até o corte).
  const ab = (await W("/abertura/configurar", { competencia: "2026-09", observacao: "Ensaio sintético" })).abertura;
  assert.deepEqual([ab.competenciaInicio, ab.dataDeCorte, ab.situacao], ["2026-09", "2026-08-31", "CONFIGURADA"]);

  // 4–5. Posições em 31/08 (saldos, título anterior a pagar, recebíveis anteriores de iFood e Stone).
  const sb = (await W("/abertura/saldo", { conta: banco.id, valor: "5.000,00", origem: "Extrato sintético de 31/08" })).saldo;
  await W("/abertura/saldo", { conta: caixa.id, valor: "300,00", origem: "Contagem sintética de 31/08" });
  assert.deepEqual([sb.data, sb.referencia], ["2026-08-31", "FIM_DO_DIA"]);
  const nf = await W("/abertura/obrigacao-anterior", { fornecedorNovo: "Distribuidora Sintética", descricao: "NF 100", valor: "1.200,00", dataEmissao: "2026-08-20", vencimento: "2026-09-10", origem: "Lista sintética", identificador: "NF 100", chave: randomUUID() });
  assert.equal(nf.lancamento.competencia, "2026-09");
  const recIfood = (await W("/abertura/recebivel-anterior", { processador: "IFOOD", descricao: "Pedido iFood de 30/08", valor: "90,00", dataOrigem: "2026-08-30", vencimento: "2026-09-03", origem: "Demonstrativo sintético", identificador: "P-AGO1", chave: randomUUID() })).recebivel;
  const recStone = (await W("/abertura/recebivel-anterior", { processador: "STONE", descricao: "Agenda Stone de 31/08", valor: "250,00", dataOrigem: "2026-08-31", origem: "Agenda sintética", chave: randomUUID() })).recebivel;
  // Títulos da abertura nunca são receita nem despesa de setembro.
  assert.equal(await bruto(n, "2026-09"), null, "setembro sem venda continua sem registros");
  await W("/abertura/concluir", { justificativa: "Conferido pelo validador (sintético)." });

  // 6. Vendas de setembro importadas (SAIPOS) — inclui um pedido de 30/08 (antes do corte) que já é título de abertura.
  const periodo = { periodoInicio: "2026-08-30", periodoFim: "2026-09-30" };
  const arquivo = saiposVendas([
    { pedido: "P-AGO1", data: "30/08/2026 20:00", canal: "iFood", itens: 9000, forma: "Pago online" },
    { pedido: "P-SET1", data: "05/09/2026 12:00", canal: "Balcão", itens: 5000, forma: "Dinheiro" },
  ]);
  const r1 = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "application/octet-stream", conteudo: arquivo, ...periodo });
  const imp = (await n.confirmarImportacao(c, { importacaoId: r1.importacao.id, impressaoPrevia: r1.importacao.impressaoPrevia, ...(r1.previa.totalDivergencias ? ACEITE : {}) })).importacao;
  await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  const props = await n.listarPropostas(c, { operacao: "VENDA" });
  const prop = (id) => props.find((p) => p.comando.fonte.idExterno === id);
  assert.equal(prop("P-AGO1").correspondenciaAbertura.classificacao, "COBERTO_POR_TITULO_ANTERIOR");
  await rejeita(n.aprovarProposta(c, { propostaId: prop("P-AGO1").id, justificativa: "Tentativa (sintético)." }), CODIGO.OPERACAO_INVALIDA);
  await n.rejeitarProposta(c, { propostaId: prop("P-AGO1").id, justificativa: "Já é recebível da abertura (mesmo pedido)." });
  await n.aprovarProposta(c, { propostaId: prop("P-SET1").id });
  await n.aplicarProposta(c, { propostaId: prop("P-SET1").id });

  // Importação repetida: o mesmo arquivo devolve a mesma importação; gerar de novo não cria proposta nova.
  const r2 = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "application/octet-stream", conteudo: arquivo, ...periodo });
  assert.deepEqual([r2.repetido, r2.importacao.id], [true, imp.id]);
  await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  assert.equal((await n.listarPropostas(c, { operacao: "VENDA" })).length, 2);

  // Vendas de setembro com recebimento futuro: iFood (recebe em outubro) e Stone (recebe parte em setembro, parte em outubro).
  const vIfood = await n.registrarVenda(c, { canal: "IFOOD", dataVenda: "2026-09-30", brutoCentavos: 8000, fonte: { sistema: "MANUAL", idExterno: "P-SET2" }, composicao: { itensCentavos: 8000 }, pagamentos: [{ forma: "OUTRA", processador: "IFOOD", valorCentavos: 8000 }] });
  const vStone = await n.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: 10000, fonte: { sistema: "MANUAL", idExterno: "P-SET3" }, composicao: { itensCentavos: 10000 }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 10000 }] });
  // Despesas de setembro: aluguel pago só em novembro; e um boleto sem natureza comprovada (fora da DRE até classificar).
  const locador = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Locador Sintético" });
  const aluguel = (await n.registrarObrigacao(c, { contraparteId: locador.id, valorOriginalCentavos: 40000, categoria: "ALUGUEL", descricao: "Aluguel de setembro", competencia: "2026-09", dataEmissao: "2026-09-01", vencimento: "2026-11-05" })).obrigacoes[0];
  const duvida = (await n.registrarObrigacao(c, { contraparteId: locador.id, valorOriginalCentavos: 1500, categoria: "DESPESAS_A_CLASSIFICAR", descricao: "Boleto sem identificação", competencia: "2026-09", dataEmissao: "2026-09-15", vencimento: "2026-09-20" })).obrigacoes[0];

  const brutoSet = 5000 + 8000 + 10000;
  assert.equal(await bruto(n, "2026-09"), brutoSet);
  const resultadoSet = await resultado(n, "2026-09");
  assert.equal(resultadoSet, brutoSet - 40000, "aluguel pela competência; título anterior e boleto a classificar fora da DRE");

  // 7. Recebimentos e pagamentos posteriores (setembro → novembro).
  const entrada = async (data, valor, d) => (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: data, sentido: "ENTRADA", valorCentavos: valor, natureza: "RECEBIMENTO", descricao: d })).movimentacao;
  const liquidar = (mov, alvoId, valor) => n.registrarLiquidacao(c, { movimentacaoId: mov.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId, valorCentavos: valor }] });
  await liquidar(await entrada("2026-09-01", 25000, "Agenda Stone de 31/08 (sintético)"), recStone.id, 25000);
  await liquidar(await entrada("2026-09-03", 9000, "Repasse iFood P-AGO1 (sintético)"), recIfood.id, 9000);
  await n.pagarContaAPagar(c, { obrigacaoId: nf.obrigacoes[0].id, contaId: banco.id, dataEfetiva: "2026-09-10", valorCentavos: 120000 });
  const stoneParc1 = await entrada("2026-09-11", 6000, "Stone parcial (sintético)");
  await liquidar(stoneParc1, vStone.recebiveis[0].id, 6000);
  assert.equal(await saldoDe(n, vStone.recebiveis[0].id), 4000, "venda recebida parcialmente");
  await liquidar(await entrada("2026-10-07", 8000, "Repasse iFood P-SET2 (sintético)"), vIfood.recebiveis[0].id, 8000);
  const stoneParc2 = await entrada("2026-10-02", 4000, "Stone restante (sintético)");
  const { liquidacoes: [liqOut] } = await liquidar(stoneParc2, vStone.recebiveis[0].id, 4000);
  assert.equal(await saldoDe(n, vStone.recebiveis[0].id), 0);
  await n.pagarContaAPagar(c, { obrigacaoId: aluguel.id, contaId: banco.id, dataEfetiva: "2026-11-05", valorCentavos: 40000 });

  // Estorno posterior do vínculo de outubro: o recebível volta a dever; setembro não muda.
  const estorno = await n.estornarLiquidacao(c, { liquidacaoId: liqOut.id, justificativa: "Vínculo indevido (sintético)." });
  assert.equal(estorno.liquidacao.situacao, "ESTORNADA");
  assert.equal(await saldoDe(n, vStone.recebiveis[0].id), 4000, "o estorno devolve o saldo ao recebível");

  // Outubro e novembro: só as próprias vendas; recebimentos de setembro não viram receita.
  await n.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-10-15", brutoCentavos: 3000, fonte: { sistema: "MANUAL", idExterno: "P-OUT1" }, composicao: { itensCentavos: 3000 }, pagamentos: [{ forma: "PIX", valorCentavos: 3000, contaId: banco.id }] });
  await n.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-11-03", brutoCentavos: 2000, fonte: { sistema: "MANUAL", idExterno: "P-NOV1" }, composicao: { itensCentavos: 2000 }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 2000, contaId: caixa.id }] });

  // 9–11. DRE dos três meses: setembro intacto depois de todos os recebimentos, pagamentos e do estorno; nada duplicado.
  assert.equal(await bruto(n, "2026-09"), brutoSet);
  assert.equal(await resultado(n, "2026-09"), resultadoSet);
  assert.equal(await bruto(n, "2026-10"), 3000);
  assert.equal(await resultado(n, "2026-10"), 3000, "repasses de setembro recebidos em outubro não são receita de outubro");
  assert.equal(await bruto(n, "2026-11"), 2000);
  assert.equal(await resultado(n, "2026-11"), 2000, "aluguel de setembro pago em novembro não é despesa de novembro");
  assert.equal(await bruto(n, "2026-08"), null, "agosto (antes do corte) não é apurado");
  // Títulos: anterior quitado, recebíveis anteriores liquidados; o boleto sem natureza segue pendente de classificação.
  assert.equal(await saldoDe(n, recIfood.id), 0);
  assert.equal(await saldoDe(n, recStone.id), 0);
  assert.equal(await saldoDe(n, vIfood.recebiveis[0].id), 0);
  const pagar = await n.consultarContasAPagar(c, { tamanho: 100 });
  assert.equal(pagar.itens.find((x) => x.id === nf.obrigacoes[0].id).saldoCentavos, 0);
  assert.equal(pagar.itens.find((x) => x.id === duvida.id).saldoCentavos, 1500);

  assert.deepEqual(await n.verificarConservacao(c), [], "nenhum valor criado ou perdido entre títulos, liquidações e movimentações");

  // 12. Isolamento: a outra unidade não vê abertura, vendas nem resultado.
  const outra = ctx(ORG_A, UNI_A2);
  assert.equal((await n.consultarAbertura(outra)).abertura, null);
  assert.equal(await bruto(n, "2026-09", outra), null);
});

test("abertura 09/2026: incompatível se houver venda até 31/08; despesa anterior ao corte só entra como título patrimonial", async () => {
  const { nucleo: n } = montar({ relogio: RELOGIO });
  const W = async (caminho, corpo) => ESCRITAS[caminho].fazer(n, c, corpo);
  await n.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-08-31", brutoCentavos: 1000, fonte: { sistema: "MANUAL", idExterno: "V-AGO" }, pagamentos: [{ forma: "PIX", valorCentavos: 1000 }] });
  await rejeita(W("/abertura/configurar", { competencia: "2026-09" }), CODIGO.OPERACAO_INVALIDA);

  const { nucleo: n2 } = montar({ relogio: RELOGIO });
  const W2 = async (caminho, corpo) => ESCRITAS[caminho].fazer(n2, c, corpo);
  await W2("/abertura/configurar", { competencia: "2026-09" });
  // Título com emissão DEPOIS do corte não é "anterior": recusado como posição de abertura.
  await rejeita(W2("/abertura/obrigacao-anterior", { fornecedorNovo: "F", descricao: "NF 1", valor: "1,00", dataEmissao: "2026-09-01", vencimento: "2026-09-10", origem: "Lista sintética", chave: randomUUID() }), CODIGO.DATA_INVALIDA);
  await rejeita(W2("/abertura/recebivel-anterior", { processador: "STONE", descricao: "Agenda", valor: "1,00", dataOrigem: "2026-09-01", origem: "Agenda sintética", chave: randomUUID() }), CODIGO.DATA_INVALIDA);
});
