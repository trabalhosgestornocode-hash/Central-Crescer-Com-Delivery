// Fase E — 1 (isolamento entre organizações e unidades) e 15 (acesso e autorização).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO, criarNucleoFinanceiro, criarRepositorioMemoria } from "../../src/modules/financeiro-v2/index.js";
import { ORG_A, ORG_B, OUTRO_USUARIO, UNI_A, UNI_A2, UNI_B, ctx, entrada, montar, montarComCadastros, obrigacao, rejeita, saida } from "./helpers/cenario.js";

test("registros de uma organização são invisíveis e intocáveis para outra", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const { obrigacoes: [ob] } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  const b = ctx(ORG_B, UNI_B);

  assert.deepEqual(await nucleo.consultarRegistros(b, { tipo: "OBRIGACAO" }), []);
  assert.deepEqual(await nucleo.consultarRegistros(b, { tipo: "CONTA" }), []);
  assert.deepEqual(await nucleo.consultarHistorico(b, { registroTipo: "OBRIGACAO", registroId: ob.id }), []);
  assert.equal((await nucleo.consultarComposicao(b, { indicador: "DESPESAS", competencia: "2026-09" })).totalCentavos, 0);

  // Conhecer o id não basta: a outra organização recebe "não encontrado", igual a um id inexistente.
  await rejeita(nucleo.corrigirObrigacao(b, { obrigacaoId: ob.id, mudancas: { descricao: "invasão" }, justificativa: "x" }), CODIGO.NAO_ENCONTRADO);
  await rejeita(nucleo.cancelarObrigacao(b, { obrigacaoId: ob.id, justificativa: "x" }), CODIGO.NAO_ENCONTRADO);
  await rejeita(nucleo.registrarMovimentacao(b, saida(banco.id, 1000)), CODIGO.NAO_ENCONTRADO); // conta de A
  await rejeita(nucleo.registrarObrigacao(b, obrigacao(fornecedor.id)), CODIGO.NAO_ENCONTRADO); // fornecedor de A

  const [intacta] = await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" });
  assert.equal(intacta.versao, 1);
  assert.equal(intacta.descricao, "Compra sintética");
});

test("unidades da mesma organização também são isoladas entre si", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const { obrigacoes: [ob] } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  const outraUnidade = ctx(ORG_A, UNI_A2);
  assert.deepEqual(await nucleo.consultarRegistros(outraUnidade, { tipo: "OBRIGACAO" }), []);
  const contaLa = await nucleo.configurarContaFinanceira(outraUnidade, { tipo: "BANCARIA", nome: "Conta da outra unidade" });
  const { movimentacao } = await nucleo.registrarMovimentacao(outraUnidade, saida(contaLa.id, 100000));
  // Pagamento de uma unidade não quita obrigação de outra.
  await rejeita(nucleo.registrarLiquidacao(outraUnidade, { movimentacaoId: movimentacao.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 100000 }] }), CODIGO.NAO_ENCONTRADO);
  // Transferência não atravessa unidades.
  await rejeita(nucleo.registrarTransferencia(c, { contaOrigemId: banco.id, contaDestinoId: contaLa.id, valorCentavos: 100, dataEfetiva: "2026-09-10" }), CODIGO.NAO_ENCONTRADO);
});

test("mesma origem externa em organizações diferentes não colide", async () => {
  const { nucleo } = montar();
  const venda = { canal: "BALCAO", dataVenda: "2026-09-01", brutoCentavos: 5000, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 5000 }], fonte: { sistema: "SAIPOS", idExterno: "PED-1" } };
  const a = await nucleo.registrarVenda(ctx(), venda);
  const b = await nucleo.registrarVenda(ctx(ORG_B, UNI_B), venda);
  assert.equal(a.repetido, false);
  assert.equal(b.repetido, false);
  assert.notEqual(a.venda.id, b.venda.id);
});

test("escopo fora da lista autorizada é recusado, mesmo com todas as permissões", async () => {
  const { nucleo } = montar({ escopos: [{ organizacaoId: ORG_A, unidadeId: UNI_A }] });
  await rejeita(nucleo.consultarRegistros(ctx(ORG_B, UNI_B), { tipo: "CONTA" }), CODIGO.ESCOPO_NAO_AUTORIZADO);
  await rejeita(nucleo.consultarRegistros(ctx(ORG_A, UNI_A2), { tipo: "CONTA" }), CODIGO.ESCOPO_NAO_AUTORIZADO);
  await rejeita(nucleo.configurarContaFinanceira(ctx(ORG_A, UNI_B), { tipo: "BANCARIA", nome: "x" }), CODIGO.ESCOPO_NAO_AUTORIZADO);
  assert.equal((await nucleo.consultarRegistros(ctx(), { tipo: "CONTA" })).length, 0);
});

test("núcleo sem escopo autorizado ou sem repositório válido não é criado", () => {
  const erro = (fn, codigo) => assert.throws(fn, (e) => e.codigo === codigo);
  erro(() => criarNucleoFinanceiro({ repositorio: criarRepositorioMemoria(), escoposAutorizados: [] }), CODIGO.ESCOPO_NAO_AUTORIZADO);
  erro(() => criarNucleoFinanceiro({ repositorio: criarRepositorioMemoria() }), CODIGO.ESCOPO_NAO_AUTORIZADO);
  erro(() => criarNucleoFinanceiro({ repositorio: criarRepositorioMemoria(), escoposAutorizados: [{ organizacaoId: "x", unidadeId: UNI_A }] }), CODIGO.ESCOPO_NAO_AUTORIZADO);
  erro(() => criarNucleoFinanceiro({ repositorio: {}, escoposAutorizados: [{ organizacaoId: ORG_A, unidadeId: UNI_A }] }), CODIGO.REPOSITORIO_INVALIDO);
});

test("contexto ausente ou malformado falha fechado", async () => {
  const { nucleo } = montar();
  for (const ruim of [null, undefined, {}, { organizacaoId: ORG_A }, { ...ctx(), unidadeId: "1" }, { ...ctx(), usuarioId: null }, "ctx"]) {
    await rejeita(nucleo.consultarRegistros(ruim, { tipo: "CONTA" }), CODIGO.CONTEXTO_INVALIDO);
  }
});

test("cada operação exige a permissão própria; sem permissão nada é gravado", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const so = (...p) => ctx(ORG_A, UNI_A, p);
  const { obrigacoes: [ob] } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  const { movimentacao } = await nucleo.registrarMovimentacao(c, saida(banco.id, 100000));
  const antes = (await nucleo.consultarHistorico(c, { registroTipo: "OBRIGACAO", registroId: ob.id })).length;

  const negadas = [
    [so(), () => nucleo.consultarRegistros(so(), { tipo: "CONTA" })],
    [so(ACAO.VER), () => nucleo.registrarObrigacao(so(ACAO.VER), obrigacao(fornecedor.id))],
    [so(ACAO.VER), () => nucleo.registrarMovimentacao(so(ACAO.VER), saida(banco.id, 10))],
    [so(ACAO.VER, ACAO.REGISTRAR), () => nucleo.configurarContaFinanceira(so(ACAO.VER, ACAO.REGISTRAR), { tipo: "BANCARIA", nome: "x" })],
    [so(ACAO.VER, ACAO.REGISTRAR), () => nucleo.corrigirObrigacao(so(ACAO.VER, ACAO.REGISTRAR), { obrigacaoId: ob.id, mudancas: { descricao: "y" }, justificativa: "z" })],
    [so(ACAO.VER, ACAO.CORRIGIR), () => nucleo.cancelarObrigacao(so(ACAO.VER, ACAO.CORRIGIR), { obrigacaoId: ob.id, justificativa: "z" })],
    [so(ACAO.VER, ACAO.REGISTRAR), () => nucleo.registrarAjuste(so(ACAO.VER, ACAO.REGISTRAR), { alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 100, motivo: "juros", categoria: "JUROS_E_TARIFAS_BANCARIAS" })],
    [so(ACAO.VER, ACAO.REGISTRAR), () => nucleo.criarCorrespondenciaCandidata(so(ACAO.VER, ACAO.REGISTRAR), { ladoA: [{ tipo: "MOVIMENTACAO", id: movimentacao.id, valorCentavos: 100000 }], ladoB: [{ tipo: "OBRIGACAO", id: ob.id, valorCentavos: 100000 }] })],
    [so(ACAO.VER, ACAO.REGISTRAR), () => nucleo.alterarEstadoDaCompetencia(so(ACAO.VER, ACAO.REGISTRAR), { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" })],
  ];
  for (const [, fn] of negadas) await rejeita(fn, CODIGO.PERMISSAO_INSUFICIENTE);

  assert.equal((await nucleo.consultarHistorico(c, { registroTipo: "OBRIGACAO", registroId: ob.id })).length, antes);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" })).length, 1);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "CONTA" })).length, 2);
});

test("permissões desconhecidas (inclusive do financeiro antigo) não concedem nada", async () => {
  const { nucleo } = montar();
  const antigo = ctx(ORG_A, UNI_A, ["gestao_financeira.ver", "gestao_financeira.lancar", "*", "admin", "financeiro_v2.*"]);
  await rejeita(nucleo.consultarRegistros(antigo, { tipo: "CONTA" }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(nucleo.configurarContaFinanceira(antigo, { tipo: "BANCARIA", nome: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
});

test("homologar e revisar são permissões separadas de fechar", async () => {
  const { nucleo } = montar();
  const fechador = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.FECHAR]);
  await nucleo.alterarEstadoDaCompetencia(fechador, { competencia: "2026-08", novoEstado: "FECHAMENTO_PRELIMINAR" });
  await rejeita(nucleo.alterarEstadoDaCompetencia(fechador, { competencia: "2026-08", novoEstado: "FECHAMENTO_HOMOLOGADO", confirmar: true, metodologia: "m" }), CODIGO.PERMISSAO_INSUFICIENTE);
  await nucleo.alterarEstadoDaCompetencia(ctx(ORG_A, UNI_A, [ACAO.HOMOLOGAR]), { competencia: "2026-08", novoEstado: "FECHAMENTO_HOMOLOGADO", confirmar: true, metodologia: "Metodologia sintética" });
  await rejeita(nucleo.alterarEstadoDaCompetencia(ctx(ORG_A, UNI_A, [ACAO.FECHAR, ACAO.HOMOLOGAR]), { competencia: "2026-08", novoEstado: "ABERTA", confirmar: true, justificativa: "erro" }), CODIGO.PERMISSAO_INSUFICIENTE);
});

test("o responsável de cada registro é o usuário do contexto, nunca um dado da entrada", async () => {
  const { nucleo, c, banco } = await montarComCadastros();
  await rejeita(nucleo.registrarMovimentacao(c, { ...entrada(banco.id, 100), usuarioId: OUTRO_USUARIO }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.registrarMovimentacao(c, { ...entrada(banco.id, 100), organizacaoId: ORG_B }), CODIGO.ENTRADA_INVALIDA);
  const { movimentacao } = await nucleo.registrarMovimentacao(ctx(ORG_A, UNI_A, undefined, OUTRO_USUARIO), entrada(banco.id, 100));
  assert.equal(movimentacao.criadoPor, OUTRO_USUARIO);
  assert.equal(movimentacao.organizacaoId, ORG_A);
});
