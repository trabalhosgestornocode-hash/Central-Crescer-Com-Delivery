// PAGAMENTO POR COMPROVANTE COM ENCARGO (juros/multa) — ação ESTREITA `registrar_juros` (23/11/2026, migração 0031).
// Dados SINTÉTICOS. Roda em memória e, com FV2_REPOSITORIO=postgres, no banco isolado; os testes "banco —" exercitam as
// barreiras do PostgreSQL diretamente (banco local descartável, criado por scripts/fv2-banco-teste.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, ctx, montar, montarComCadastros, obrigacao, provisionarAdministrador, saida } from "./helpers/cenario.js";
import { comoAplicacao, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const OUT = "2026-10";
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% comprovante sintetico ${randomUUID()}\n%%EOF\n`);
const ESTREITA = [ACAO.VER, ACAO.ENVIAR_DOCUMENTO, ACAO.BAIXAR_POR_COMPROVANTE, ACAO.REGISTRAR_JUROS];
async function comprovante(m, c = m.c) {
  const g = await m.cofre.guardar(c, { conteudo: pdf(), tipoMime: "application/pdf" });
  return (await m.nucleo.registrarDocumento(c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-10-10", descricao: "Comprovante Pix (sintético)" })).documento;
}
const conta = async (m, valor = 23000, descricao = "Descartáveis (sintético)") => (await m.nucleo.registrarObrigacao(m.c, obrigacao(m.fornecedor.id, { valorOriginalCentavos: valor, competencia: OUT, dataEmissao: "2026-10-01", vencimento: "2026-10-30", descricao }))).obrigacoes[0];
const pagarComEncargo = (n, c, o, doc, extra = {}) => n.registrarPagamentoComEncargo(c, { obrigacaoId: o.id, valorCentavos: 25000, encargoCentavos: 2000, tipoEncargo: "JUROS", dataPagamento: "2026-10-10",
  documentoId: doc.id, idTransacao: `E0000000020261010ENCARGO${Math.floor(Math.random() * 1e6)}`, justificativa: "Pix concluído; R$ 20,00 de juros confirmados pelo remetente (sintético).", confirmar: true, ...extra });
const retrato = async (n, c) => ({
  saidas: (await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).filter((x) => x.sentido === "SAIDA").length,
  liquidacoes: (await n.consultarRegistros(c, { tipo: "LIQUIDACAO" })).length,
  ajustes: (await n.consultarRegistros(c, { tipo: "AJUSTE" })).length,
  despesas: (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((l) => l.situacao === "ATIVO" && l.natureza === "DESPESA"),
});
const rejeita = (p, codigo, motivo) => assert.rejects(p, (e) => e.codigo === codigo && (!motivo || JSON.stringify(e).includes(motivo)));

/** O plano implantado já traz a categoria oficial de juros e multas (a ação estreita não cria categoria). */
const comCategoria = () => montarComCadastros();

test("ENC-1 R$ 230 + R$ 20 de juros: principal e encargo registrados, conta quitada, comprovante vinculado, sem saída, sem 2ª despesa de compra, conciliação pendente; o extrato de R$ 250 concilia a MESMA baixa", async () => {
  const m = await comCategoria();
  const { nucleo: n } = m;
  const o = await conta(m);
  const doc = await comprovante(m);
  const antes = await retrato(n, m.c);
  const narrow = ctx(ORG_A, UNI_A, ESTREITA, "cccccccc-0000-4000-8000-000000000111");
  const r = await pagarComEncargo(n, ctx(ORG_A, UNI_A, TODAS), o, doc); // humano (todas as ações): ok
  void narrow;
  assert.deepEqual([r.repetido, r.conciliacao, r.titulo.situacao, r.titulo.saldoCentavos, r.encargo.valorCentavos, r.encargo.tipo], [false, "CONCILIACAO_PENDENTE", "QUITADA", 0, 2000, "JUROS"]);
  assert.equal(r.liquidacao.movimentacaoId, null);
  assert.equal(r.liquidacao.valorCentavos, 25000, "a liquidação é o TOTAL do comprovante (casa com a saída do extrato)");
  const depois = await retrato(n, m.c);
  assert.deepEqual([depois.saidas, depois.liquidacoes - antes.liquidacoes, depois.ajustes - antes.ajustes], [0, 1, 1], "nenhuma saída; uma baixa; um ajuste");
  const novas = depois.despesas.filter((d) => !antes.despesas.some((a) => a.id === d.id));
  assert.deepEqual(novas.map((d) => [d.categoria, d.valorCentavos]), [["JUROS_E_MULTAS_DE_FORNECEDORES", 2000]], "só o encargo é despesa nova; a compra (R$ 230) já era a despesa da conta");
  const t = (await n.detalharContaAPagar(m.c, { id: o.id })).titulo;
  assert.deepEqual([t.situacaoPagamento, t.situacaoConciliacao, t.saldoCentavos, t.pagoCentavos, t.aConciliarCentavos], ["PAGO_POR_COMPROVANTE", "CONCILIACAO_PENDENTE", 0, 25000, 25000]);
  // O extrato chega com a saída de R$ 250,00: conciliar liga à mesma baixa (valor igual) — sem 2ª baixa, 2ª saída ou despesa.
  const mov = (await n.registrarMovimentacao(m.c, saida(m.banco.id, 25000, { dataEfetiva: "2026-10-10", fonte: { sistema: "UNICRED", idExterno: "EXT-ENC-250" } }))).movimentacao;
  const k = await n.conciliarPagamentoPorComprovante(m.c, { liquidacaoId: r.liquidacao.id, movimentacaoId: mov.id, versaoMovimentacao: mov.versao, justificativa: "Extrato confere (sintético).", confirmar: true });
  assert.deepEqual([k.conciliacao, k.efeito.novasBaixas, k.movimentacao.alocadoCentavos], ["CONCILIADO_COM_EXTRATO", 0, 25000]);
  const fim = await retrato(n, m.c);
  assert.deepEqual([fim.saidas, fim.liquidacoes, fim.ajustes, fim.despesas.length], [1, depois.liquidacoes, depois.ajustes, depois.despesas.length]);
  const integ = await n.verificarConservacao(m.c);
  assert.deepEqual(integ.violacoes ?? integ, []);
});

test("ENC-2 ação ESTREITA faz o pagamento com encargo; idempotente (repetir não lança juros nem baixa de novo); outro arquivo da mesma transação é DUPLICADO", async () => {
  const m = await comCategoria();
  const { nucleo: n } = m;
  const o = await conta(m);
  const doc = await comprovante(m);
  const narrow = ctx(ORG_A, UNI_A, ESTREITA, "cccccccc-0000-4000-8000-000000000111");
  const idTx = "E0000000020261010ENCIDEMP0001";
  const r = await pagarComEncargo(n, narrow, o, doc, { idTransacao: idTx });
  assert.equal(r.titulo.saldoCentavos, 0);
  const a1 = await retrato(n, m.c);
  const r2 = await pagarComEncargo(n, narrow, o, doc, { idTransacao: idTx });
  assert.equal(r2.repetido, true);
  const a2 = await retrato(n, m.c);
  assert.deepEqual([a2.ajustes, a2.liquidacoes, a2.despesas.length], [a1.ajustes, a1.liquidacoes, a1.despesas.length], "nada novo na repetição");
  const outro = await conta(m, 23000, "Outra conta (sintético)");
  const doc2 = await comprovante(m);
  await rejeita(pagarComEncargo(n, narrow, outro, doc2, { idTransacao: idTx }), CODIGO.CONFLITO_IDEMPOTENCIA, "COMPROVANTE_DUPLICADO");
  assert.equal((await n.detalharContaAPagar(m.c, { id: outro.id })).titulo.saldoCentavos, 23000);
  assert.equal((await retrato(n, m.c)).ajustes, a1.ajustes, "o encargo da tentativa recusada foi desfeito (mesma transação)");
});

test("ENC-3 limites: sem a ação registrar_juros é recusado; principal ≠ saldo; acima de 10% do valor da conta; encargo = valor inteiro — nada gravado", async () => {
  const m = await comCategoria();
  const { nucleo: n } = m;
  const o = await conta(m);
  const grande = await conta(m, 10000, "Conta pequena (sintético)");
  const doc = await comprovante(m);
  const base = await retrato(n, m.c);
  const semAcao = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.ENVIAR_DOCUMENTO, ACAO.BAIXAR_POR_COMPROVANTE], "cccccccc-0000-4000-8000-000000000112");
  await rejeita(pagarComEncargo(n, semAcao, o, await comprovante(m)), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(pagarComEncargo(n, m.c, o, await comprovante(m), { valorCentavos: 26000, encargoCentavos: 2000 }), CODIGO.ENTRADA_INVALIDA, "principalCentavos"); // principal 24000 ≠ saldo 23000
  await rejeita(pagarComEncargo(n, m.c, grande, await comprovante(m), { valorCentavos: 12000, encargoCentavos: 2000 }), CODIGO.ENTRADA_INVALIDA, "ENCARGO_ACIMA_DO_LIMITE"); // 20% > 10%
  await rejeita(pagarComEncargo(n, m.c, o, await comprovante(m), { valorCentavos: 2000, encargoCentavos: 2000 }), CODIGO.ENTRADA_INVALIDA, "encargoCentavos");
  const fim = await retrato(n, m.c);
  assert.deepEqual([fim.ajustes, fim.liquidacoes, fim.saidas, fim.despesas.length], [base.ajustes, base.liquidacoes, base.saidas, base.despesas.length]);
  assert.equal((await n.detalharContaAPagar(m.c, { id: o.id })).titulo.saldoCentavos, 23000);
});

// ====================================================================================================== banco (0031)
const pular = motivoParaPular();
const U = (i) => `cccccccc-0000-4000-8000-00000000020${i}`;
const erroDoBanco = (codigos) => (e) => codigos.includes(e.code) || codigos.includes(e.causa?.code) || [CODIGO.INTEGRIDADE_VIOLADA, CODIGO.PERMISSAO_INSUFICIENTE].includes(e.codigo);
async function cenarioBanco() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: m.cofre, exigirConcessaoPersistida: true });
  const adm = ctx(ORG_A, UNI_A, TODAS);
  const interno = await repositorio.interno();
  const sqlComo = async (usuarioId, texto, valores = []) => comoAplicacao(interno, null, (cl) => cl.query(texto, valores), { token: await interno.sessoes.emitir({ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId }) });
  await m.nucleo.configurarContaFinanceira(adm, { tipo: "BANCARIA", nome: "Banco" });
  const forn = await m.nucleo.registrarContraparte(adm, { tipo: "FORNECEDOR", nome: "Fornecedor" });
  const nova = async (valor) => (await m.nucleo.registrarObrigacao(adm, obrigacao(forn.id, { valorOriginalCentavos: valor, competencia: OUT, dataEmissao: "2026-10-01", vencimento: "2026-10-30" }))).obrigacoes[0];
  const doc = async () => { const g = await m.cofre.guardar(adm, { conteudo: pdf(), tipoMime: "application/pdf" });
    return (await m.nucleo.registrarDocumento(adm, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-10-10", descricao: "Comprovante (sintético)" })).documento; };
  return { m, n, adm, sqlComo, nova, doc };
}

test("banco — quem só tem registrar_juros (+ baixar_por_comprovante) registra o encargo pelo núcleo; o banco recusa encargo fora da forma, acima de 10% ou sem a ação", { skip: pular }, async () => {
  const { n, adm, sqlComo, nova, doc } = await cenarioBanco();
  await n.concederAcesso(adm, { usuarioId: U(1), acoes: ESTREITA, justificativa: "Só registra pagamento por comprovante com encargo (sintético)." });
  await n.concederAcesso(adm, { usuarioId: U(2), acoes: [ACAO.VER, ACAO.BAIXAR_POR_COMPROVANTE, ACAO.ENVIAR_DOCUMENTO], justificativa: "Sem a ação de encargo (sintético)." });
  const o = await nova(23000);
  const d = await doc();
  const r = await n.registrarPagamentoComEncargo(ctx(ORG_A, UNI_A, TODAS, U(1)), { obrigacaoId: o.id, valorCentavos: 25000, encargoCentavos: 2000, dataPagamento: "2026-10-10", documentoId: d.id, idTransacao: "E0000000020261010BANCOENC001", justificativa: "Pix concluído com juros (sintético).", confirmar: true});
  assert.deepEqual([r.titulo.situacao, r.liquidacao.movimentacaoId, r.liquidacao.valorCentavos, r.encargo.valorCentavos], ["QUITADA", null, 25000, 2000]);
  // Sem a ação: o banco (e o núcleo) recusam o encargo.
  const o2 = await nova(23000);
  await assert.rejects(n.registrarPagamentoComEncargo(ctx(ORG_A, UNI_A, TODAS, U(2)), { obrigacaoId: o2.id, valorCentavos: 25000, encargoCentavos: 2000, dataPagamento: "2026-10-10", documentoId: (await doc()).id, justificativa: "x (sintético).", confirmar: true }),
    erroDoBanco(["42501"]));
  // SQL cru como a ação estreita: ajuste de 50% do valor da conta e lançamento fora da categoria oficial são barrados pelo banco.
  const o3 = await nova(10000);
  const cat = (await n.consultarRegistros(adm, { tipo: "CATEGORIA" })).find((c) => c.codigo === "INSUMOS");
  await assert.rejects(sqlComo(U(1), `insert into fv2_ajuste (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, alvo_tipo, alvo_id, valor_centavos, motivo, competencia, lancamento_id)
    values ($1,$2,$3,1,now(),$4,now(),$4,'OBRIGACAO',$5,5000,'abusivo','2026-10',$6)`, [randomUUID(), ORG_A, UNI_A, U(1), o3.id, randomUUID()]), erroDoBanco(["42501", "23503", "23514"]));
  assert.ok(cat, "categoria de apoio do teste existe");
  const t = (await n.detalharContaAPagar(adm, { id: o3.id })).titulo;
  assert.equal(t.saldoCentavos, 10000, "nada foi alterado pelas tentativas barradas");
  const integ = await n.verificarConservacao(adm);
  assert.deepEqual(integ.violacoes ?? integ, []);
});
