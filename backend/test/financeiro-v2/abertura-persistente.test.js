// Abertura PERSISTIDA por unidade (migração 0022, doc 32) e BARREIRA contra duplicação por importações posteriores.
// Dados SINTÉTICOS. Roda em memória e, com FV2_REPOSITORIO=postgres, no banco isolado (RLS, histórico, travas reais).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { CATEGORIA_TITULOS_ANTERIORES } from "../../src/modules/financeiro-v2/dominio/planoDeContas.js";
import { ORG_A, TODAS, UNI_A2, ctx, montar, rejeita } from "./helpers/cenario.js";
import { saiposVendas, texto } from "./helpers/arquivos.js";

const RELOGIO = () => new Date("2026-11-20T15:00:00.000Z");
const c = ctx();
const A = (nucleo, x = c) => async (caminho, corpo) => ESCRITAS[caminho].fazer(nucleo, x, corpo);
const ACEITE = { aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas no teste." };
const stoneCsv = (linhas) => texto(["STONE ID;DATA DA VENDA;PRODUTO;BANDEIRA;VALOR BRUTO;VALOR LIQUIDO;DESCONTO DE MDR;DESCONTO DE ANTECIPACAO;DESCONTO UNIFICADO;ULTIMO STATUS;CÓDIGO DE AUTORIZAÇÃO",
  ...linhas.map((l) => [l.id, l.quando, l.produto ?? "Credito", "Bandeira X", l.bruto, l.liquido, "0,000000", "0,000000", "0,000000", "Aprovada", l.aut ?? ""].join(";"))].join("\n"));
async function importar(n, fonte, tipoRelatorio, conteudo, periodo) {
  const r = await n.receberArquivoParaImportacao(c, { fonte, tipoRelatorio, tipoMime: "application/octet-stream", conteudo, ...periodo });
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(r.previa.erros));
  return (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? ACEITE : {}) })).importacao;
}

test("abertura persistida: configurar é idempotente, auditável e a competência vem dela (nunca do formulário)", async () => {
  const { nucleo } = montar({ relogio: RELOGIO });
  const W = A(nucleo);
  const banco = await W("/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Unicred" });
  // Sem abertura: nenhuma posição de abertura entra.
  await rejeita(W("/abertura/saldo", { conta: banco.id, valor: "10,00", origem: "Extrato sintético" }), CODIGO.OPERACAO_INVALIDA);
  await rejeita(W("/abertura/obrigacao-anterior", { fornecedorNovo: "F", descricao: "NF", valor: "1,00", dataEmissao: "2026-10-01", vencimento: "2026-11-05", origem: "Lista sintética" }), CODIGO.OPERACAO_INVALIDA);
  assert.deepEqual(await nucleo.consultarAbertura(c), { abertura: null, posicoes: null });
  // Corte precisa ser dia encerrado; a 1ª configuração não exige justificativa.
  await rejeita(W("/abertura/configurar", { competencia: "2026-12" }), CODIGO.DATA_INVALIDA);
  const a = (await W("/abertura/configurar", { competencia: "2026-11", observacao: "Proposta (sintética)" })).abertura;
  assert.deepEqual([a.competenciaInicio, a.dataDeCorte, a.situacao, a.versao], ["2026-11", "2026-10-31", "CONFIGURADA", 1]);
  assert.equal((await W("/abertura/configurar", { competencia: "2026-11" })).repetido, true);
  const simultaneas = await Promise.all([W("/abertura/configurar", { competencia: "2026-11" }), W("/abertura/configurar", { competencia: "2026-11" })]);
  assert.ok(simultaneas.every((x) => x.abertura.id === a.id), "uma só abertura por unidade");
  // Mudar antes de qualquer posição: permitido com justificativa (nova versão, histórico).
  await rejeita(W("/abertura/configurar", { competencia: "2026-10" }), CODIGO.ENTRADA_INVALIDA);
  const mudada = (await W("/abertura/configurar", { competencia: "2026-10", justificativa: "Início antecipado (sintético)." })).abertura;
  assert.deepEqual([mudada.id, mudada.competenciaInicio, mudada.dataDeCorte, mudada.versao], [a.id, "2026-10", "2026-09-30", 2]);
  await W("/abertura/configurar", { competencia: "2026-11", justificativa: "Volta à proposta (sintético)." });
  // Saldo usa a data de corte gravada; título anterior usa a competência gravada.
  const s = (await W("/abertura/saldo", { conta: banco.id, valor: "1.000,00", origem: "Extrato sintético de 31/10" })).saldo;
  assert.deepEqual([s.data, s.referencia], ["2026-10-31", "FIM_DO_DIA"]);
  const o = await W("/abertura/obrigacao-anterior", { fornecedorNovo: "Fornecedor A", descricao: "NF 7", valor: "300,00", dataEmissao: "2026-10-31", vencimento: "2026-11-10", origem: "Lista sintética", identificador: "nf 7", chave: randomUUID() });
  assert.deepEqual([o.lancamento.competencia, o.obrigacoes[0].identificador], ["2026-11", "NF7"]);
  await rejeita(W("/abertura/obrigacao-anterior", { fornecedorNovo: "Fornecedor A", descricao: "NF 8", valor: "1,00", dataEmissao: "2026-11-01", vencimento: "2026-11-10", origem: "Lista sintética", chave: randomUUID() }), CODIGO.DATA_INVALIDA);
  // Atalho direto ao núcleo com a categoria patrimonial em OUTRA competência: recusado.
  await rejeita(nucleo.registrarObrigacao(c, { contraparteNova: { tipo: "FORNECEDOR", nome: "X" }, valorOriginalCentavos: 100, categoria: CATEGORIA_TITULOS_ANTERIORES, descricao: "x", competencia: "2026-12", dataEmissao: "2026-10-01", vencimento: "2026-12-10" }), CODIGO.OPERACAO_INVALIDA);
  // Com posições: a competência não muda mais.
  await rejeita(W("/abertura/configurar", { competencia: "2026-10", justificativa: "Tentativa depois das posições (sintético)." }), CODIGO.OPERACAO_INVALIDA);
  const q = await nucleo.consultarAbertura(c);
  assert.deepEqual([q.posicoes.saldos.length, q.posicoes.obrigacoesAnteriores.quantidade, q.posicoes.obrigacoesAnteriores.totalCentavos], [1, 1, 30000]);
  // Concluir fecha a abertura; reabrir é ação sensível (REABRIR).
  await W("/abertura/concluir", { justificativa: "Conferido pelo validador (sintético)." });
  await rejeita(W("/abertura/saldo", { conta: banco.id, valor: "1.000,00", origem: "Extrato sintético de 31/10" }), CODIGO.OPERACAO_INVALIDA);
  await rejeita(W("/abertura/obrigacao-anterior", { fornecedorNovo: "F", descricao: "NF 9", valor: "1,00", dataEmissao: "2026-10-01", vencimento: "2026-11-05", origem: "Lista sintética", chave: randomUUID() }), CODIGO.OPERACAO_INVALIDA);
  assert.equal(ESCRITAS["/abertura/reabrir"].sensivel({}), ACAO.REABRIR, "na plataforma, reabrir exige 2º fator recente");
  await rejeita(A(nucleo, ctx(ORG_A, undefined, TODAS.filter((x) => x !== ACAO.REABRIR)))("/abertura/reabrir", { justificativa: "Sem a ação de reabrir." }), CODIGO.PERMISSAO_INSUFICIENTE);
  assert.equal((await W("/abertura/reabrir", { justificativa: "Faltou um título (sintético)." })).abertura.situacao, "CONFIGURADA");
  // Isolamento: a outra unidade não vê nem herda a abertura.
  assert.equal((await nucleo.consultarAbertura(ctx(ORG_A, UNI_A2))).abertura, null);
  // Configurar exige "configurar".
  await rejeita(A(nucleo, ctx(ORG_A, UNI_A2, [ACAO.VER, ACAO.REGISTRAR]))("/abertura/configurar", { competencia: "2026-11" }), CODIGO.PERMISSAO_INSUFICIENTE);
});

test("abertura INCOMPATÍVEL: lançamento de resultado até o corte (seria contado de novo) impede configurar", async () => {
  const { nucleo } = montar({ relogio: RELOGIO });
  await nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-10-30", brutoCentavos: 5000, fonte: { sistema: "MANUAL", idExterno: "V-OUT" }, pagamentos: [{ forma: "PIX", valorCentavos: 5000 }] });
  await rejeita(A(nucleo)("/abertura/configurar", { competencia: "2026-11" }), CODIGO.OPERACAO_INVALIDA);
  // Com o corte ANTES da venda (início em 10/2026), a venda é do período apurado: compatível.
  assert.equal((await A(nucleo)("/abertura/configurar", { competencia: "2026-10" })).abertura.dataDeCorte, "2026-09-30");
});

test("barreira: importação com data até o corte vai à conferência, classificada contra os títulos anteriores, e NUNCA é aplicada", async () => {
  const { nucleo: n } = montar({ relogio: RELOGIO });
  const W = A(n);
  const caixa = await W("/configuracoes/conta/criar", { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const banco = await W("/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Unicred" });
  await W("/abertura/configurar", { competencia: "2026-11" });
  await W("/abertura/saldo", { conta: banco.id, valor: "0,00", origem: "Extrato sintético de 31/10" });
  // Posição de abertura: iFood devia o pedido P-OUT1 (identificador) e o Stone devia 40,00 (sem identificador).
  const ifood = await W("/abertura/recebivel-anterior", { processador: "IFOOD", descricao: "Pedido iFood de 28/10", valor: "45,00", dataOrigem: "2026-10-28", vencimento: "2026-11-04", origem: "Demonstrativo iFood (sintético)", identificador: "P-OUT1", chave: randomUUID() });
  await W("/abertura/recebivel-anterior", { processador: "STONE", descricao: "Agenda Stone de 30/10", valor: "40,00", dataOrigem: "2026-10-30", origem: "Agenda Stone (sintética)", chave: randomUUID() });
  const dreAntes = await n.apurarCompetencia(c, { competencia: "2026-11" });

  // SAIPOS de 27/10 a 03/11: dois pedidos ANTES do corte (um coberto pelo identificador, um sem título) e um DEPOIS.
  const imp = await importar(n, "SAIPOS", "SAIPOS_VENDAS", saiposVendas([
    { pedido: "P-OUT1", data: "28/10/2026 20:00", canal: "iFood", itens: 4500, forma: "Pago online" },
    { pedido: "P-OUT2", data: "29/10/2026 20:00", canal: "Balcão", itens: 1200, forma: "Dinheiro" },
    { pedido: "P-NOV1", data: "02/11/2026 20:00", canal: "Balcão", itens: 3000, forma: "Dinheiro" },
  ]), { periodoInicio: "2026-10-27", periodoFim: "2026-11-03" });
  await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  const ps = await n.listarPropostas(c, { operacao: "VENDA" });
  const por = (id) => ps.find((p) => p.comando.fonte.idExterno === id);
  assert.equal(por("P-OUT1").estado, "AGUARDANDO_REVISAO");
  assert.equal(por("P-OUT1").correspondenciaAbertura.classificacao, "COBERTO_POR_TITULO_ANTERIOR");
  assert.deepEqual(por("P-OUT1").correspondenciaAbertura.titulos, [{ tipo: "RECEBIVEL", id: ifood.recebivel.id }]);
  assert.ok(por("P-OUT1").divergencias.some((d) => d.codigo === "ANTERIOR_A_ABERTURA"));
  assert.equal(por("P-OUT2").correspondenciaAbertura.classificacao, "SEM_CORRESPONDENCIA");
  assert.equal(por("P-NOV1").estado, "PROPOSTA", "depois do corte segue o fluxo normal");
  // Nunca aplicada: aprovar é recusado (mesmo com justificativa); a resolução é rejeitar.
  await rejeita(n.aprovarProposta(c, { propostaId: por("P-OUT1").id, justificativa: "Tentativa (sintético)." }), CODIGO.OPERACAO_INVALIDA);
  await n.rejeitarProposta(c, { propostaId: por("P-OUT1").id, justificativa: "Já é título de abertura (mesmo pedido)." });
  await n.aprovarProposta(c, { propostaId: por("P-NOV1").id });
  await n.aplicarProposta(c, { propostaId: por("P-NOV1").id });

  // Stone de 30/10 (antes do corte) com o MESMO valor do título sem identificador: correspondência POSSÍVEL, sem aplicar.
  const st = await importar(n, "STONE", "STONE_VENDAS", stoneCsv([{ id: "ST-9", quando: "30/10/2026 19:00", bruto: "40,000000", liquido: "40,000000", aut: "A9" }]), { periodoInicio: "2026-10-30", periodoFim: "2026-10-30" });
  await n.gerarPropostas(c, { importacaoId: st.id });
  const pst = (await n.listarPropostas(c, { operacao: "PAGAMENTO_STONE" }))[0];
  assert.equal(pst.estado, "AGUARDANDO_REVISAO");
  assert.equal(pst.correspondenciaAbertura.classificacao, "CORRESPONDENCIA_POSSIVEL");

  // Recebimento POSTERIOR do título antigo pelo extrato: liquida o título; a DRE de novembro só tem a venda de 02/11.
  const e = await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-11-04", sentido: "ENTRADA", valorCentavos: 4500, natureza: "RECEBIMENTO", descricao: "Repasse iFood (sintético)" });
  await n.registrarLiquidacao(c, { movimentacaoId: e.movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: ifood.recebivel.id, valorCentavos: 4500 }] });
  const dre = await n.apurarCompetencia(c, { competencia: "2026-11" });
  assert.equal(dreAntes.indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, null);
  assert.equal(dre.indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, 3000, "só a venda depois do corte; nada do período anterior");
  assert.equal((await n.apurarCompetencia(c, { competencia: "2026-10" })).indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, null, "outubro não ganhou receita importada");
  assert.equal((await n.consultarContasAReceber(c, {})).itens.find((x) => x.id === ifood.recebivel.id).saldoCentavos, 0);

  // Proposta APROVADA antes de a abertura existir também é barrada na aplicação.
  const { nucleo: n2 } = montar({ relogio: RELOGIO });
  const caixa2 = await n2.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const imp2 = await importar(n2, "SAIPOS", "SAIPOS_VENDAS", saiposVendas([{ pedido: "P-OUT3", data: "29/10/2026 20:00", canal: "Balcão", itens: 1000, forma: "Dinheiro" }]), { periodoInicio: "2026-10-29", periodoFim: "2026-10-29" });
  await n2.gerarPropostas(c, { importacaoId: imp2.id, contaCaixaId: caixa2.id });
  const p3 = (await n2.listarPropostas(c, { operacao: "VENDA" }))[0];
  await n2.aprovarProposta(c, { propostaId: p3.id });
  await A(n2)("/abertura/configurar", { competencia: "2026-11" });
  await rejeita(n2.aplicarProposta(c, { propostaId: p3.id }), CODIGO.OPERACAO_INVALIDA);
});
