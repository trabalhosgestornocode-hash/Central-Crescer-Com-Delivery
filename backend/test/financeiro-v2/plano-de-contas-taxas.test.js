// Plano de contas gerencial (hierárquico, por unidade) e classificação ECONÔMICA das taxas e retenções.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO, catalogos, planoDeContas } from "../../src/modules/financeiro-v2/index.js";
import { ORG_A, ORG_B, UNI_A, UNI_B, ctx, montar, montarComCadastros, obrigacao, rejeita, semRepeticao, sha } from "./helpers/cenario.js";

const achatar = (arvore) => arvore.flatMap((n) => [n, ...achatar(n.filhas)]);
const total = async (nucleo, c, indicador, extra = {}) => (await nucleo.consultarComposicao(c, { indicador, competencia: "2026-09", ...extra })).totalCentavos;

test("o plano tem as 13 classificações principais e categorias em hierarquia", async () => {
  const { nucleo } = montar({ plano: false });
  const c = ctx();
  const r = await nucleo.implantarPlanoDeContas(c, { modelo: "BASE" });
  assert.equal(r.criadas.length, planoDeContas.MODELO_DE_PLANO.BASE.length);
  const arvore = await nucleo.consultarPlanoDeContas(c);
  assert.deepEqual(arvore.map((n) => n.classificacao).sort(), Object.values(catalogos.CLASSIFICACAO).sort());
  assert.ok(arvore.every((raiz) => raiz.aceitaLancamento === false && raiz.filhas.length >= 1)); // raiz só agrupa
  assert.ok(achatar(arvore).every((n) => n.filhas.every((f) => f.classificacao === n.classificacao))); // filha herda a classificação

  // Implantar de novo não duplica nem altera nada.
  assert.deepEqual((await nucleo.implantarPlanoDeContas(c, { modelo: "BASE" })).criadas, []);
  // O complemento da açaiteria entra por cima do genérico, na hierarquia certa.
  const acai = await nucleo.implantarPlanoDeContas(c, { modelo: "ACAITERIA" });
  assert.deepEqual(acai.criadas.sort(), ["ACAI_DISTRIBUIDORA", "AGUA", "ALUGUEL", "ANUNCIOS_IFOOD", "ASSOCIACAO", "BENEFICIOS", "BROWNIES", "COMISSOES_IFOOD", "CONTABILIDADE", "DIARIAS_EXTRAS", "ENERGIA", "ENTREGADORES_PROPRIOS", "EXAMES_OCUPACIONAIS", "FERIAS_E_RESCISOES", "FRUTAS", "JURIDICO", "MANUTENCAO", "MATERIAL_DE_ESCRITORIO", "MENSALIDADE_IFOOD", "MIX", "OPERACOES_ENTRE_EMPRESAS", "OUTROS_INSUMOS", "PARCELAMENTO_TRIBUTARIO", "PROMOCOES_SUBSIDIADAS", "SEGURO_PRESTAMISTA", "SERVICOS_DE_TERCEIROS", "SISTEMAS", "SUCO", "SUPERMERCADO", "TAXAS_STONE", "VALORES_DE_TERCEIROS"]);
  const todas = achatar(await nucleo.consultarPlanoDeContas(c));
  const de = (codigo) => todas.find((n) => n.codigo === codigo);
  assert.deepEqual(de("INSUMOS").filhas.map((f) => f.codigo), ["ACAI_DISTRIBUIDORA", "BROWNIES", "FRUTAS", "MIX", "OUTROS_INSUMOS", "SUCO", "SUPERMERCADO"]);
  for (const [codigo, classificacao, natureza] of [
    ["FRUTAS", "CUSTOS_OPERACIONAIS", "DESPESA"], ["EMBALAGENS", "CUSTOS_OPERACIONAIS", "DESPESA"], ["ENTREGADORES_PROPRIOS", "DESPESAS_COMERCIAIS", "DESPESA"],
    ["COMISSOES_IFOOD", "DESPESAS_COMERCIAIS", "DESPESA"], ["PROMOCOES_SUBSIDIADAS", "DEDUCOES_COMERCIAIS", "DEDUCAO"], ["TAXAS_STONE", "DESPESAS_RECEBIMENTO_PROCESSAMENTO", "DESPESA"],
    ["MENSALIDADE_IFOOD", "DESPESAS_PLATAFORMAS", "DESPESA"], ["ANUNCIOS_IFOOD", "MARKETING", "DESPESA"], ["TAXAS_ANTECIPACAO", "DESPESAS_FINANCEIRAS", "DESPESA"],
    ["JUROS_E_TARIFAS_BANCARIAS", "DESPESAS_FINANCEIRAS", "DESPESA"], ["TRIBUTOS_SOBRE_VENDAS", "TRIBUTOS", "DEDUCAO"], ["EMPRESTIMOS_E_FINANCIAMENTOS", "MOVIMENTACOES_PATRIMONIAIS", "PATRIMONIAL"],
    ["ACAI_DISTRIBUIDORA", "CUSTOS_OPERACIONAIS", "DESPESA"], ["ALUGUEL", "DESPESAS_ADMINISTRATIVAS", "DESPESA"], ["DIARIAS_EXTRAS", "PESSOAL", "DESPESA"],
    ["SEGURO_PRESTAMISTA", "DESPESAS_FINANCEIRAS", "DESPESA"], ["PARCELAMENTO_TRIBUTARIO", "MOVIMENTACOES_PATRIMONIAIS", "PATRIMONIAL"], ["VALORES_DE_TERCEIROS", "MOVIMENTACOES_PATRIMONIAIS", "PATRIMONIAL"],
  ]) {
    assert.deepEqual([de(codigo)?.classificacao, de(codigo)?.natureza], [classificacao, natureza], codigo);
  }
});

test("categorias específicas da açaiteria não são obrigatórias para outra empresa", async () => {
  const { nucleo } = montar({ plano: false });
  const acai = ctx(ORG_A, UNI_A);
  const outra = ctx(ORG_B, UNI_B);
  await nucleo.implantarPlanoDeContas(acai, { modelo: "ACAITERIA" });
  await nucleo.implantarPlanoDeContas(outra, { modelo: "BASE" });
  await nucleo.registrarCategoria(outra, { codigo: "TECIDOS", nome: "Tecidos", paiCodigo: "INSUMOS" }); // cada empresa cria as suas
  const fornecedorA = await nucleo.registrarContraparte(acai, { tipo: "FORNECEDOR", nome: "Fornecedor A" });
  const fornecedorB = await nucleo.registrarContraparte(outra, { tipo: "FORNECEDOR", nome: "Fornecedor B" });
  assert.equal((await nucleo.registrarObrigacao(acai, obrigacao(fornecedorA.id, { categoria: "FRUTAS" }))).lancamento.classificacao, "CUSTOS_OPERACIONAIS");
  assert.equal((await nucleo.registrarObrigacao(outra, obrigacao(fornecedorB.id, { categoria: "TECIDOS" }))).lancamento.classificacao, "CUSTOS_OPERACIONAIS");
  await rejeita(nucleo.registrarObrigacao(outra, obrigacao(fornecedorB.id, { categoria: "FRUTAS" })), CODIGO.CATEGORIA_INVALIDA); // não existe no plano dela
  await rejeita(nucleo.registrarObrigacao(acai, obrigacao(fornecedorA.id, { categoria: "TECIDOS" })), CODIGO.CATEGORIA_INVALIDA);
  const codigos = async (c) => achatar(await nucleo.consultarPlanoDeContas(c)).map((n) => n.codigo);
  assert.ok(!(await codigos(outra)).includes("TAXAS_STONE") && (await codigos(acai)).includes("TAXAS_STONE"));
});

test("regras do cadastro de categorias: hierarquia, natureza, inativação e permissão", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  const nova = await nucleo.registrarCategoria(c, { codigo: "GAS_DE_COZINHA", nome: "Gás de cozinha", paiCodigo: "INSUMOS" });
  assert.deepEqual([nova.classificacao, nova.natureza, nova.aceitaLancamento, nova.ativa, nova.doSistema], ["CUSTOS_OPERACIONAIS", "DESPESA", true, true, false]);

  await rejeita(nucleo.registrarCategoria(c, { codigo: "GAS_DE_COZINHA", nome: "Repetida", paiCodigo: "INSUMOS" }), CODIGO.CATEGORIA_INVALIDA);
  await rejeita(nucleo.registrarCategoria(c, { codigo: "X1", nome: "Sem pai nem classificação" }), CODIGO.CATEGORIA_INVALIDA);
  await rejeita(nucleo.registrarCategoria(c, { codigo: "X2", nome: "Pai fantasma", paiCodigo: "NAO_EXISTE" }), CODIGO.CATEGORIA_INVALIDA);
  await rejeita(nucleo.registrarCategoria(c, { codigo: "X3", nome: "Classificação diferente da mãe", paiCodigo: "INSUMOS", classificacao: "MARKETING" }), CODIGO.CATEGORIA_INVALIDA);
  await rejeita(nucleo.registrarCategoria(c, { codigo: "X4", nome: "Natureza incompatível", paiCodigo: "INSUMOS", natureza: "RECEITA" }), CODIGO.CATEGORIA_INVALIDA);
  await rejeita(nucleo.registrarCategoria(c, { codigo: "codigo minusculo", nome: "x", paiCodigo: "INSUMOS" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.registrarCategoria(c, { codigo: "X5", nome: "x", classificacao: "INVENTADA" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.registrarCategoria(ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.REGISTRAR]), { codigo: "X6", nome: "x", paiCodigo: "INSUMOS" }), CODIGO.PERMISSAO_INSUFICIENTE);

  // Categoria agrupadora não recebe lançamento; categoria inexistente também não.
  await rejeita(nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { categoria: "CUSTOS_OPERACIONAIS" })), CODIGO.CATEGORIA_INVALIDA);
  await rejeita(nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { categoria: "NAO_EXISTE" })), CODIGO.CATEGORIA_INVALIDA);
  await rejeita(nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { categoria: "OUTRAS_RECEITAS" })), CODIGO.CATEGORIA_INVALIDA); // dívida não é receita

  // Inativar não apaga e não afeta lançamentos antigos; só impede novos.
  const antes = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { categoria: "GAS_DE_COZINHA" }));
  const inativa = await nucleo.alterarCategoria(c, { codigo: "GAS_DE_COZINHA", mudancas: { ativa: false }, justificativa: "Deixou de ser usada" });
  assert.deepEqual([inativa.ativa, inativa.versao], [false, 2]);
  await rejeita(nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { categoria: "GAS_DE_COZINHA" })), CODIGO.CATEGORIA_INVALIDA);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" })).find((l) => l.id === antes.lancamento.id).categoria, "GAS_DE_COZINHA");
  await rejeita(nucleo.registrarCategoria(c, { codigo: "X7", nome: "Filha de inativa", paiCodigo: "GAS_DE_COZINHA" }), CODIGO.CATEGORIA_INVALIDA);
  await rejeita(nucleo.alterarCategoria(c, { codigo: "VENDA_BALCAO", mudancas: { ativa: false }, justificativa: "x" }), CODIGO.CATEGORIA_INVALIDA); // usada pelo sistema
  const h = await nucleo.consultarHistorico(c, { registroTipo: "CATEGORIA", registroId: nova.id });
  assert.deepEqual(h.map((e) => [e.evento, e.justificativa]), [["CRIACAO", null], ["CORRECAO", "Deixou de ser usada"]]);
});

test("sem plano implantado: venda funciona (categorias do sistema nascem sozinhas), despesa sem categoria cadastrada não", async () => {
  const { nucleo } = montar({ plano: false });
  const c = ctx();
  const fornecedor = await nucleo.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Fornecedor" });
  await rejeita(nucleo.registrarObrigacao(c, obrigacao(fornecedor.id)), CODIGO.CATEGORIA_INVALIDA);
  const v = await nucleo.registrarVenda(c, { canal: "IFOOD", dataVenda: "2026-09-10", brutoCentavos: 5000, pagamentos: [{ forma: "CREDITO", processador: "IFOOD", valorCentavos: 5000 }], fonte: { sistema: "IFOOD", idExterno: "O-1" } });
  assert.deepEqual([v.lancamento.natureza, v.lancamento.categoria, v.lancamento.classificacao, v.lancamento.canal], ["RECEITA", "VENDA_IFOOD", "RECEITA_OPERACIONAL", "IFOOD"]);
  assert.deepEqual(achatar(await nucleo.consultarPlanoDeContas(c)).map((n) => [n.codigo, n.doSistema]), [["RECEITA_OPERACIONAL", true], ["VENDA_IFOOD", true]]);
});

test("taxas e retenções são classificadas pela natureza econômica, não por terem sido descontadas do repasse", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  const v = await nucleo.registrarVenda(c, { canal: "IFOOD", dataVenda: "2026-09-10", brutoCentavos: 100000, pagamentos: [{ forma: "CREDITO", processador: "IFOOD", valorCentavos: 100000 }], fonte: { sistema: "IFOOD", idExterno: "O-1" } });
  const [aReceber] = v.recebiveis;
  const { documento } = await nucleo.registrarDocumento(c, { origem: "IFOOD", arquivoId: "cofre:sintetico-repasse", hashSha256: sha("c3"), tipo: "DEMONSTRATIVO_REPASSE", competencia: "2026-09", recebidoEm: "2026-10-02" });

  // O demonstrativo do canal mostra o que foi descontado do repasse desta venda. Cada desconto reduz o MESMO recebível
  // (não nasce um segundo recebível do mesmo dinheiro) e vira UM lançamento, na categoria que diz o que ele é.
  const reter = (categoria, valorCentavos, extra = {}) => nucleo.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: aReceber.id, valorCentavos: -valorCentavos, motivo: `Retido no repasse: ${categoria}`, categoria, ...extra });
  const lancamentosDeRetencao = [];
  for (const [categoria, valor] of [["DESCONTOS_COMERCIAIS", 5000], ["COMISSOES_IFOOD", 12000], ["MENSALIDADE_IFOOD", 3000], ["ANUNCIOS_IFOOD", 2000], ["TAXAS_DE_PROCESSAMENTO", 1000]]) {
    lancamentosDeRetencao.push((await reter(categoria, valor)).lancamento);
  }
  // Antecipação só entra como encargo financeiro com documento que a comprove.
  await rejeita(reter("TAXAS_ANTECIPACAO", 500), CODIGO.CATEGORIA_INVALIDA);
  const antecipacao = await reter("TAXAS_ANTECIPACAO", 500, { documentoId: documento.id });
  lancamentosDeRetencao.push(antecipacao.lancamento);

  assert.deepEqual(lancamentosDeRetencao.map((l) => [l.categoria, l.natureza, l.classificacao, l.valorCentavos, l.retidoNoRepasse, l.canal]), [
    ["DESCONTOS_COMERCIAIS", "DEDUCAO", "DEDUCOES_COMERCIAIS", 5000, true, "IFOOD"],
    ["COMISSOES_IFOOD", "DESPESA", "DESPESAS_COMERCIAIS", 12000, true, "IFOOD"],
    ["MENSALIDADE_IFOOD", "DESPESA", "DESPESAS_PLATAFORMAS", 3000, true, "IFOOD"],
    ["ANUNCIOS_IFOOD", "DESPESA", "MARKETING", 2000, true, "IFOOD"],
    ["TAXAS_DE_PROCESSAMENTO", "DESPESA", "DESPESAS_RECEBIMENTO_PROCESSAMENTO", 1000, true, "IFOOD"],
    ["TAXAS_ANTECIPACAO", "DESPESA", "DESPESAS_FINANCEIRAS", 500, true, "IFOOD"],
  ]);
  assert.equal(antecipacao.alvo.saldoCentavos, 76500); // o que o canal de fato repassa
  assert.equal(await total(nucleo, c, "SALDO_A_RECEBER"), 76500);

  // O mesmo vale para o recebível avulso (repasse de canal cujas vendas não foram registradas uma a uma).
  const avulso = { processador: "ANOTA_AI", canal: "ANOTA_AI", brutoCentavos: 1000, competencia: "2026-08", fonte: { sistema: "ANOTA_AI", idExterno: "REP-08" } };
  await rejeita(nucleo.registrarRecebivel(c, { ...avulso, retencoes: [{ categoria: "OUTRAS_RECEITAS", valorCentavos: 1 }] }), CODIGO.CATEGORIA_INVALIDA); // retenção não é receita
  await rejeita(nucleo.registrarRecebivel(c, { ...avulso, retencoes: [{ categoria: "TAXAS_ANTECIPACAO", valorCentavos: 10 }] }), CODIGO.CATEGORIA_INVALIDA); // sem documento
  const comDocumento = await nucleo.registrarRecebivel(c, { ...avulso, documentoIds: [documento.id], retencoes: [{ categoria: "TAXAS_ANTECIPACAO", valorCentavos: 10 }] });
  assert.deepEqual([comDocumento.lancamentosDeRetencao[0].classificacao, comDocumento.recebivel.saldoCentavos], ["DESPESAS_FINANCEIRAS", 990]);

  // Uma despesa paga por fora (não descontada de repasse) e uma movimentação patrimonial.
  await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 30000, categoria: "FRUTAS" }));
  const emprestimo = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 50000, categoria: "EMPRESTIMOS_E_FINANCIAMENTOS", descricao: "Parcela de empréstimo (principal)" }));
  assert.deepEqual([emprestimo.lancamento.natureza, emprestimo.lancamento.classificacao], ["PATRIMONIAL", "MOVIMENTACOES_PATRIMONIAIS"]);

  // Visão da DRE: cada componente na sua natureza.
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 100000);
  assert.equal(await total(nucleo, c, "DEDUCOES"), 5000); // só o desconto comercial é dedução
  assert.equal(await total(nucleo, c, "DESPESAS"), 48500); // 18.500 retidos + 30.000 por fora; o empréstimo NÃO é despesa
  assert.equal(await total(nucleo, c, "DESPESAS", { classificacao: "DESPESAS_COMERCIAIS" }), 12000);
  assert.equal(await total(nucleo, c, "DESPESAS", { classificacao: "DESPESAS_PLATAFORMAS" }), 3000);
  assert.equal(await total(nucleo, c, "DESPESAS", { classificacao: "MARKETING" }), 2000);
  assert.equal(await total(nucleo, c, "DESPESAS", { classificacao: "DESPESAS_RECEBIMENTO_PROCESSAMENTO" }), 1000);
  assert.equal(await total(nucleo, c, "DESPESAS", { classificacao: "DESPESAS_FINANCEIRAS" }), 500);
  assert.equal(await total(nucleo, c, "DESPESAS", { classificacao: "CUSTOS_OPERACIONAIS" }), 30000);
  assert.equal(await total(nucleo, c, "SALDO_A_PAGAR"), 80000); // o empréstimo é dívida, mesmo sem ser despesa

  // Visão do canal: Faturamento Líquido Gerencial = receita − deduções − despesas retidas no repasse.
  assert.equal(await total(nucleo, c, "RETENCOES_DE_CANAL"), 18500);
  assert.equal(await total(nucleo, c, "FATURAMENTO_LIQUIDO_GERENCIAL"), 76500);
  assert.equal(await total(nucleo, c, "FATURAMENTO_LIQUIDO_GERENCIAL", { canal: "IFOOD" }), 76500);
  assert.equal(await total(nucleo, c, "FATURAMENTO_LIQUIDO_GERENCIAL", { canal: "BALCAO" }), 0);
  assert.equal(await total(nucleo, c, "DESPESAS_FORA_DO_REPASSE"), 30000);

  // As duas visões leem os MESMOS lançamentos: nenhum componente reduz o resultado duas vezes.
  const resultado = await nucleo.consultarComposicao(c, { indicador: "RESULTADO_ECONOMICO", competencia: "2026-09" });
  assert.equal(resultado.totalCentavos, 46500); // 100.000 − 5.000 − 48.500
  assert.equal(resultado.totalCentavos, 76500 - 30000); // = faturamento líquido do canal − despesas por fora
  assert.ok(semRepeticao(resultado));
  assert.equal(resultado.itens.length, 8); // 1 receita + 6 retenções + 1 despesa por fora; o empréstimo fica de fora
  await rejeita(nucleo.consultarComposicao(c, { indicador: "ENTRADAS_DE_CAIXA", competencia: "2026-09", canal: "IFOOD" }), CODIGO.ENTRADA_INVALIDA);

  // Reclassificar muda a categoria (com histórico), não o resultado; receita não vira despesa por reclassificação.
  const comissao = lancamentosDeRetencao[1];
  const { lancamento: reclass } = await nucleo.reclassificarLancamento(c, { lancamentoId: comissao.id, categoria: "ANUNCIOS_IFOOD", justificativa: "Era anúncio, não comissão", versaoEsperada: comissao.versao });
  assert.deepEqual([reclass.categoria, reclass.classificacao, reclass.natureza, reclass.valorCentavos], ["ANUNCIOS_IFOOD", "MARKETING", "DESPESA", 12000]);
  assert.equal(await total(nucleo, c, "DESPESAS", { classificacao: "MARKETING" }), 14000);
  assert.equal(await total(nucleo, c, "RESULTADO_ECONOMICO"), 46500);
  const receita = (await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" })).find((l) => l.natureza === "RECEITA");
  await rejeita(nucleo.reclassificarLancamento(c, { lancamentoId: receita.id, categoria: "FRUTAS", justificativa: "x", versaoEsperada: receita.versao }), CODIGO.CATEGORIA_INVALIDA);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("taxa descoberta depois (ajuste no recebível) também segue a categoria; crédito de ajuste é receita, não taxa negativa", async () => {
  const { nucleo, c } = await montarComCadastros();
  const v = await nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: 20000, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 20000 }], fonte: { sistema: "SAIPOS", idExterno: "V-1" } });
  const [recebivel] = v.recebiveis;
  const taxa = await nucleo.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: recebivel.id, valorCentavos: -398, motivo: "Taxa do cartão de crédito", categoria: "TAXAS_STONE" });
  assert.deepEqual([taxa.lancamento.natureza, taxa.lancamento.classificacao, taxa.lancamento.valorCentavos, taxa.lancamento.retidoNoRepasse, taxa.lancamento.canal, taxa.alvo.saldoCentavos], ["DESPESA", "DESPESAS_RECEBIMENTO_PROCESSAMENTO", 398, true, "BALCAO", 19602]);
  const credito = await nucleo.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: recebivel.id, valorCentavos: 137, motivo: "Crédito de ajuste do processador", categoria: "OUTRAS_RECEITAS" });
  assert.deepEqual([credito.lancamento.natureza, credito.lancamento.valorCentavos, credito.alvo.saldoCentavos], ["RECEITA", 137, 19739]);
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 20000); // receita de vendas não se mistura com outras receitas
  assert.equal(await total(nucleo, c, "OUTRAS_RECEITAS"), 137);
  assert.equal(await total(nucleo, c, "DEDUCOES"), 0);
  assert.equal(await total(nucleo, c, "FATURAMENTO_LIQUIDO_GERENCIAL"), 19602);
  assert.equal(await total(nucleo, c, "RESULTADO_ECONOMICO"), 19739);
  assert.equal(await total(nucleo, c, "SALDO_A_RECEBER"), 19739);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});
