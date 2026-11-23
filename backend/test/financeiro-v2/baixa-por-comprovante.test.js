// Execução 17 — PAGAMENTO POR COMPROVANTE (baixa documental, sem movimentação bancária) × CONCILIAÇÃO com o extrato.
// Dados SINTÉTICOS. Roda em memória e, com FV2_REPOSITORIO=postgres, no banco isolado; os testes "banco —" exercitam
// as barreiras do PostgreSQL (migração 0029) diretamente.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, ctx, montar, montarComCadastros, obrigacao, provisionarAdministrador, saida } from "./helpers/cenario.js";
import { comoAplicacao, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const OUT = "2026-10";
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% comprovante sintetico ${randomUUID()}\n%%EOF\n`);
const ID_TX = "E0000000020261010SINTMANUT400";
async function comprovante(m, c = m.c, tipo = "COMPROVANTE") {
  const g = await m.cofre.guardar(c, { conteudo: pdf(), tipoMime: "application/pdf" });
  return (await m.nucleo.registrarDocumento(c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo, recebidoEm: "2026-10-10", descricao: "Comprovante Pix (sintético)" })).documento;
}
/** Despesa de MANUTENÇÃO de R$ 400,00 (sintética), em aberto, e o banco da unidade. */
async function manutencao(valor = 40000) {
  const m = await montarComCadastros();
  const conta = (await m.nucleo.registrarObrigacao(m.c, obrigacao(m.fornecedor.id, { valorOriginalCentavos: valor, competencia: OUT, dataEmissao: "2026-10-01", vencimento: "2026-10-30", descricao: "Manutenção do freezer (sintético)" }))).obrigacoes[0];
  const doc = await comprovante(m);
  return { ...m, n: m.nucleo, conta, doc };
}
const pagar = (n, c, conta, doc, extra = {}) => n.registrarPagamentoPorComprovante(c, { obrigacaoId: conta.id, valorCentavos: 40000, dataPagamento: "2026-10-10", documentoId: doc.id, idTransacao: ID_TX, justificativa: "Pix concluído conforme comprovante (sintético).", confirmar: true, ...extra });
const detalhe = async (n, c, conta) => (await n.detalharContaAPagar(c, { id: conta.id })).titulo;
const retrato = async (n, c) => ({
  saidas: (await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).filter((x) => x.sentido === "SAIDA").length,
  liquidacoes: (await n.consultarRegistros(c, { tipo: "LIQUIDACAO" })).length,
  despesas: (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((l) => l.situacao === "ATIVO").length,
});
const rejeita = (p, codigo, motivo) => assert.rejects(p, (e) => e.codigo === codigo && (!motivo || e.detalhes?.motivo === motivo || e.dados?.motivo === motivo || JSON.stringify(e).includes(motivo)));

test("PC-1 manutenção R$ 400: pago por comprovante SEM saída nova; conciliação PENDENTE; extrato posterior concilia a MESMA baixa (sem 2ª despesa, 2ª saída ou 2ª baixa)", async () => {
  const { n, c, banco, conta, doc } = await manutencao();
  const antes = await retrato(n, c);
  const r = await pagar(n, c, conta, doc);
  assert.deepEqual([r.repetido, r.conciliacao, r.titulo.situacao, r.titulo.saldoCentavos], [false, "CONCILIACAO_PENDENTE", "QUITADA", 0]);
  assert.equal(r.liquidacao.movimentacaoId, null);
  let t = await detalhe(n, c, conta);
  assert.deepEqual([t.situacaoPagamento, t.situacaoConciliacao, t.aConciliarCentavos], ["PAGO_POR_COMPROVANTE", "CONCILIACAO_PENDENTE", 40000]);
  assert.deepEqual(t.pagamentos.map((x) => [x.origem, x.conciliacaoBancaria, x.valorCentavos]), [["COMPROVANTE", "CONCILIACAO_PENDENTE", 40000]]);
  const depois = await retrato(n, c);
  assert.deepEqual([depois.saidas, depois.despesas, depois.liquidacoes], [antes.saidas, antes.despesas, antes.liquidacoes + 1], "nenhuma saída nem despesa inventada");
  // O extrato chega com a saída de R$ 400,00 do dia.
  const mov = (await n.registrarMovimentacao(c, saida(banco.id, 40000, { dataEfetiva: "2026-10-10", fonte: { sistema: "UNICRED", idExterno: "EXT-SINT-400" } }))).movimentacao;
  const pend = await n.consultarPagamentosPorComprovanteAConciliar(c);
  assert.deepEqual(pend.itens.map((x) => [x.situacao, x.candidatas.map((y) => y.movimentacaoId)]), [["CANDIDATA_UNICA", [mov.id]]]);
  // Baixa comum pelo extrato é RECUSADA (seria a 2ª baixa): o caminho é conciliar.
  await rejeita(n.vincularPagamentoDoExtrato(c, { movimentacaoId: mov.id, versaoMovimentacao: mov.versao, alocacoes: [{ obrigacaoId: conta.id, valorCentavos: 40000 }], documentoId: doc.id, justificativa: "x", confirmar: true }), CODIGO.LIQUIDACAO_INCOMPATIVEL, "PAGAMENTO_POR_COMPROVANTE_A_CONCILIAR");
  await assert.rejects(n.registrarLiquidacao(c, { movimentacaoId: mov.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: conta.id, valorCentavos: 40000 }] }));
  const k = await n.conciliarPagamentoPorComprovante(c, { liquidacaoId: r.liquidacao.id, movimentacaoId: mov.id, versaoMovimentacao: mov.versao, justificativa: "Saída do extrato confere com o comprovante (sintético).", confirmar: true });
  assert.deepEqual([k.repetido, k.conciliacao, k.movimentacao.alocadoCentavos, k.efeito.novasBaixas], [false, "CONCILIADO_COM_EXTRATO", 40000, 0]);
  t = await detalhe(n, c, conta);
  assert.deepEqual([t.situacaoPagamento, t.situacaoConciliacao, t.saldoCentavos, t.pagoCentavos], ["PAGO_POR_COMPROVANTE", "CONCILIADO_COM_EXTRATO", 0, 40000]);
  const fim = await retrato(n, c);
  assert.deepEqual([fim.saidas, fim.despesas, fim.liquidacoes], [antes.saidas + 1, antes.despesas, antes.liquidacoes + 1], "uma saída (a do extrato), uma baixa, nenhuma despesa nova");
  // Idempotência: conciliar de novo não muda nada.
  const k2 = await n.conciliarPagamentoPorComprovante(c, { liquidacaoId: r.liquidacao.id, movimentacaoId: mov.id, versaoMovimentacao: mov.versao, justificativa: "de novo", confirmar: true });
  assert.equal(k2.repetido, true);
  assert.equal((await n.consultarPagamentosPorComprovanteAConciliar(c)).itens.length, 0);
  const integ = await n.verificarConservacao(c);
  assert.deepEqual(integ.violacoes ?? integ, []);
});

test("PC-2 mesmo comprovante: repetido devolve o já registrado; em outra conta ou com outro id da mesma transação é DUPLICADO", async () => {
  const { n, c, fornecedor, conta, doc } = await manutencao();
  await pagar(n, c, conta, doc);
  assert.equal((await pagar(n, c, conta, doc)).repetido, true);
  const outra = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 40000, competencia: OUT, dataEmissao: "2026-10-01", vencimento: "2026-10-30" }))).obrigacoes[0];
  await rejeita(pagar(n, c, outra, doc), CODIGO.CONFLITO_IDEMPOTENCIA, "COMPROVANTE_DUPLICADO");
  await rejeita(pagar(n, c, outra, doc, { idTransacao: null }), CODIGO.CONFLITO_IDEMPOTENCIA, "COMPROVANTE_DUPLICADO");
  assert.equal((await detalhe(n, c, outra)).saldoCentavos, 40000);
});

test("PC-3 parcial, acima do saldo, data futura (agendamento), documento que não é comprovante, sem confirmação e sem permissão", async () => {
  const m = await manutencao();
  const { n, c, conta, doc } = m;
  await rejeita(pagar(n, c, conta, doc, { valorCentavos: 40001 }), CODIGO.LIQUIDACAO_EXCEDE_SALDO, "VALOR_ACIMA_DO_SALDO");
  await rejeita(pagar(n, c, conta, doc, { dataPagamento: "2026-10-20" }), CODIGO.DATA_INVALIDA);
  await rejeita(pagar(n, c, conta, doc, { confirmar: false }), CODIGO.CONFIRMACAO_EXIGIDA);
  const nota = await comprovante(m, c, "NOTA_FISCAL");
  await rejeita(pagar(n, c, conta, nota, { idTransacao: null }), CODIGO.EVIDENCIA_EXIGIDA, "DOCUMENTO_NAO_E_COMPROVANTE");
  await rejeita(pagar(n, ctx(ORG_A, UNI_A, TODAS.filter((a) => a !== ACAO.BAIXAR_POR_COMPROVANTE)), conta, doc), CODIGO.PERMISSAO_INSUFICIENTE);
  const r = await pagar(n, c, conta, doc, { valorCentavos: 15000 });
  assert.deepEqual([r.titulo.situacao, r.titulo.saldoCentavos], ["PARCIAL", 25000]);
  const t = await detalhe(n, c, conta);
  assert.deepEqual([t.situacaoPagamento, t.situacaoConciliacao], ["PARCIALMENTE_PAGO", "CONCILIACAO_PENDENTE"]);
});

test("PC-4 conciliação: valor divergente, fora da tolerância de data, extrato ambíguo, saída já usada; estorno do pago por comprovante devolve o saldo", async () => {
  const { n, c, banco, conta, doc } = await manutencao();
  const r = await pagar(n, c, conta, doc);
  const s = async (v, d) => (await n.registrarMovimentacao(c, saida(banco.id, v, { dataEfetiva: d, fonte: { sistema: "UNICRED", idExterno: `EXT-${randomUUID().slice(0, 8)}` } }))).movimentacao;
  const conc = (mov) => n.conciliarPagamentoPorComprovante(c, { liquidacaoId: r.liquidacao.id, movimentacaoId: mov.id, versaoMovimentacao: mov.versao, justificativa: "teste", confirmar: true });
  assert.equal((await n.consultarPagamentosPorComprovanteAConciliar(c)).itens[0].situacao, "SEM_EXTRATO");
  await rejeita(conc(await s(39900, "2026-10-10")), CODIGO.CONCILIACAO_INVALIDA, "VALOR_DIVERGENTE");
  await rejeita(conc(await s(40000, "2026-10-01")), CODIGO.CONCILIACAO_INVALIDA, "DATA_DIVERGENTE");
  await s(40000, "2026-10-11");
  await s(40000, "2026-10-12");
  assert.equal((await n.consultarPagamentosPorComprovanteAConciliar(c)).itens[0].situacao, "AMBIGUA");
  // Estorno (ação crítica, humana): devolve o saldo à conta; nada a devolver no extrato (não havia saída).
  const e = await n.estornarLiquidacao(c, { liquidacaoId: r.liquidacao.id, justificativa: "Comprovante revisado: pagamento não confirmado (sintético)." });
  assert.equal(e.movimentacao, null);
  assert.equal(e.titulo.saldoCentavos, 40000);
  assert.equal((await n.consultarPagamentosPorComprovanteAConciliar(c)).itens.length, 0);
});

// ================================================================================================ banco (0029)
const pular = motivoParaPular();
const U = (i) => `cccccccc-0000-4000-8000-00000000010${i}`;
const erroDoBanco = (codigos) => (e) => codigos.includes(e.code) || codigos.includes(e.causa?.code) || [CODIGO.INTEGRIDADE_VIOLADA, CODIGO.PERMISSAO_INSUFICIENTE].includes(e.codigo);
async function cenarioBanco() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: m.cofre, exigirConcessaoPersistida: true });
  const adm = ctx(ORG_A, UNI_A, TODAS);
  const interno = await repositorio.interno();
  const sqlComo = async (usuarioId, texto, valores = []) => comoAplicacao(interno, null, (cl) => cl.query(texto, valores), { token: await interno.sessoes.emitir({ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId }) });
  const banco = await m.nucleo.configurarContaFinanceira(adm, { tipo: "BANCARIA", nome: "Banco" });
  const forn = await m.nucleo.registrarContraparte(adm, { tipo: "FORNECEDOR", nome: "Fornecedor" });
  const conta = (await m.nucleo.registrarObrigacao(adm, obrigacao(forn.id, { valorOriginalCentavos: 40000, competencia: OUT, dataEmissao: "2026-10-01", vencimento: "2026-10-30" }))).obrigacoes[0];
  const doc = await comprovante(m, adm);
  return { m, n, adm, sqlComo, banco, forn, conta, doc };
}
const liqSql = (u, conta, extras, movId = null) => ["insert into fv2_liquidacao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, movimentacao_id, alvo_tipo, alvo_id, valor_centavos, estornado_centavos, data_efetiva, situacao, extras) values ($1, $2, $3, 1, now(), $4, now(), $4, $5, 'OBRIGACAO', $6, 40000, 0, '2026-10-10', 'VALIDA', $7::jsonb)",
  [randomUUID(), ORG_A, UNI_A, u, movId, conta.id, JSON.stringify(extras)]];

test("banco — quem só baixa por comprovante não cria saída, despesa nem baixa com saída; sem comprovante válido é recusado; conciliar só liga a saída", { skip: pular }, async () => {
  const { m, n, adm, sqlComo, banco, forn, conta, doc } = await cenarioBanco();
  await n.concederAcesso(adm, { usuarioId: U(1), acoes: [ACAO.VER, ACAO.BAIXAR_POR_COMPROVANTE], justificativa: "Só registra pagamento por comprovante (sintético)." });
  await n.concederAcesso(adm, { usuarioId: U(2), acoes: [ACAO.VER, ACAO.VINCULAR_PAGAMENTO], justificativa: "Só vincula pagamentos do extrato (sintético)." });
  const comoU1 = ctx(ORG_A, UNI_A, TODAS, U(1));
  // SQL cru como U1: liquidação sem movimentação precisa ser COMPROVANTE com documento COMPROVANTE da unidade.
  await assert.rejects(sqlComo(U(1), ...liqSql(U(1), conta, {})), erroDoBanco(["42501", "23514"]));
  await assert.rejects(sqlComo(U(1), ...liqSql(U(1), conta, { origemDoVinculo: "COMPROVANTE", documentoId: randomUUID() })), erroDoBanco(["42501"]));
  const mov = (await m.nucleo.registrarMovimentacao(adm, saida(banco.id, 40000, { dataEfetiva: "2026-10-10" }))).movimentacao;
  await assert.rejects(sqlComo(U(1), ...liqSql(U(1), conta, { origemDoVinculo: "COMPROVANTE", documentoId: doc.id }, mov.id)), erroDoBanco(["42501"]), "quem só baixa por comprovante não usa saída");
  await assert.rejects(sqlComo(U(1), "insert into fv2_movimentacao (id) values ($1)", [randomUUID()]), erroDoBanco(["42501", "23502"]));
  // Pelo núcleo, U1 faz exatamente a baixa documental.
  const r = await n.registrarPagamentoPorComprovante(comoU1, { obrigacaoId: conta.id, valorCentavos: 40000, dataPagamento: "2026-10-10", documentoId: doc.id, idTransacao: ID_TX, justificativa: "Pix concluído (sintético).", confirmar: true });
  assert.deepEqual([r.titulo.situacao, r.liquidacao.movimentacaoId], ["QUITADA", null]);
  // Trocar o valor ou a conta da liquidação depois: recusado.
  await assert.rejects(sqlComo(U(2), "update fv2_liquidacao set valor_centavos = 1, versao = versao + 1 where id = $1", [r.liquidacao.id]), erroDoBanco(["42501"]));
  // U2 concilia (liga a saída existente); depois a saída não se troca.
  const k = await n.conciliarPagamentoPorComprovante(ctx(ORG_A, UNI_A, TODAS, U(2)), { liquidacaoId: r.liquidacao.id, movimentacaoId: mov.id, versaoMovimentacao: mov.versao, justificativa: "Extrato confere (sintético).", confirmar: true });
  assert.equal(k.liquidacao.movimentacaoId, mov.id);
  const mov2 = (await m.nucleo.registrarMovimentacao(adm, saida(banco.id, 40000, { dataEfetiva: "2026-10-10" }))).movimentacao;
  await assert.rejects(sqlComo(U(2), "update fv2_liquidacao set movimentacao_id = $2, versao = versao + 1 where id = $1", [r.liquidacao.id, mov2.id]), erroDoBanco(["42501"]));
  const saidas = (await n.consultarRegistros(adm, { tipo: "MOVIMENTACAO" })).filter((x) => x.sentido === "SAIDA");
  assert.equal(saidas.length, 2, "só as saídas registradas pelo extrato");
  assert.equal(saidas.find((x) => x.id === mov.id).alocadoCentavos, 40000);
  void forn;
});
