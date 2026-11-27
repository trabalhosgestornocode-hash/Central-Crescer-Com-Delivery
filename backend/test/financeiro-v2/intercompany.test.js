// 26/11 — OPERAÇÕES ENTRE EMPRESAS (intercompany). Caso real (dados SINTÉTICOS): a Subway Saci pagou R$ 6.495,60 à distribuidora
// pelo Açaí no Grau Saci. Aqui a organização A faz o papel do Açaí (devedora) e a B o da Subway (credora); o inverso também é testado.
// Regras: despesa reconhecida UMA vez (na devedora); a conta do fornecedor fica liquidada "paga por outra empresa" sem saída inventada;
// passivo na devedora e ativo na credora, ligados por UM vínculo; reembolso parcial/integral não é receita nem despesa; tudo atômico;
// permissão nas DUAS empresas. Roda em memória e, com FV2_REPOSITORIO=postgres, no PostgreSQL isolado (RLS, triggers e políticas).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { sqlConcessaoOperacionalDoMova } from "../../scripts/fv2/pacoteProducao.mjs";
import { AGORA, ESCOPOS_PADRAO, ORG_A, ORG_B, TODAS, UNI_A, UNI_B, ctx, montar, obrigacao, provisionarAdministrador, saida } from "./helpers/cenario.js";
import { motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const VALOR = 649560;
const A = () => ctx(ORG_A, UNI_A);
const B = () => ctx(ORG_B, UNI_B);

async function cenario() {
  const m = montar();
  const n = m.nucleo;
  const fornA = await n.registrarContraparte(A(), { tipo: "FORNECEDOR", nome: "Distribuidora Sintética A" });
  const fornB = await n.registrarContraparte(B(), { tipo: "FORNECEDOR", nome: "Distribuidora Sintética B" });
  const bancoA = await n.configurarContaFinanceira(A(), { tipo: "BANCARIA", nome: "Banco A", instituicao: "Banco Teste" });
  const bancoB = await n.configurarContaFinanceira(B(), { tipo: "BANCARIA", nome: "Banco B", instituicao: "Banco Teste" });
  return { ...m, n, fornA, fornB, bancoA, bancoB };
}
const conta = (fornecedorId, x = {}) => obrigacao(fornecedorId, { valorOriginalCentavos: VALOR, competencia: "2026-10", dataEmissao: "2026-10-05", vencimento: "2026-10-10", descricao: "Distribuidora açaí (sintético)", ...x });
const pagamento = (x = {}) => ({ valorCentavos: VALOR, dataPagamento: "2026-10-10", descricao: "Distribuidora açaí paga pela outra empresa (sintético)", nomeDevedora: "Açaí Sintético", nomeCredora: "Subway Sintética", chave: "MOVA:ic-1", ...x });

async function retrato(n, c) {
  const l = (tipo) => n.consultarRegistros(c, { tipo });
  return {
    despesas: (await l("LANCAMENTO")).filter((x) => x.situacao === "ATIVO" && x.natureza === "DESPESA").length,
    contas: (await l("OBRIGACAO")).length,
    liquidacoes: (await l("LIQUIDACAO")).length,
    saidas: (await l("MOVIMENTACAO")).filter((x) => x.sentido === "SAIDA").length,
    entreEmpresas: (await n.consultarContasEntreEmpresas(c)).itens.length,
  };
}

test("IC-1 conta EXISTENTE da devedora paga pela outra empresa: liquidada sem saída, passivo × ativo no mesmo vínculo, nenhuma despesa nova; repetir não duplica", async () => {
  const m = await cenario();
  const ob = (await m.n.registrarObrigacao(A(), conta(m.fornA.id))).obrigacoes[0];
  const [a0, b0] = [await retrato(m.n, A()), await retrato(m.n, B())];
  const r = await m.n.registrarPagamentoPorOutraEmpresa(A(), B(), pagamento({ obrigacaoId: ob.id }));
  assert.deepEqual([r.repetido, r.contaCriada, r.titulo.situacao, r.titulo.saldoCentavos], [false, false, "QUITADA", 0]);
  assert.deepEqual([r.liquidacao.movimentacaoId, r.liquidacao.origemDoVinculo, r.liquidacao.intercompanyId], [null, "INTERCOMPANY", r.devedora.id], "paga por outra empresa: nenhuma saída inventada");
  assert.equal(r.devedora.vinculoId, r.credora.vinculoId);
  assert.deepEqual([r.devedora.papel, r.devedora.saldoCentavos, r.devedora.situacao, r.devedora.obrigacaoId], ["DEVEDORA", VALOR, "ABERTO", ob.id]);
  assert.deepEqual([r.credora.papel, r.credora.saldoCentavos, r.credora.obrigacaoId, r.credora.vencimento], ["CREDORA", VALOR, null, null], "vencimento do reembolso nunca é inventado");
  const [a1, b1] = [await retrato(m.n, A()), await retrato(m.n, B())];
  assert.deepEqual([a1.despesas - a0.despesas, a1.contas - a0.contas, a1.liquidacoes - a0.liquidacoes, a1.saidas - a0.saidas, a1.entreEmpresas - a0.entreEmpresas], [0, 0, 1, 0, 1]);
  assert.deepEqual([b1.despesas - b0.despesas, b1.contas - b0.contas, b1.liquidacoes - b0.liquidacoes, b1.saidas - b0.saidas, b1.entreEmpresas - b0.entreEmpresas], [0, 0, 0, 0, 1], "credora: só o ativo, nada de despesa");
  const r2 = await m.n.registrarPagamentoPorOutraEmpresa(A(), B(), pagamento({ obrigacaoId: ob.id }));
  assert.deepEqual([r2.repetido, r2.vinculoId], [true, r.vinculoId]);
  assert.deepEqual([await retrato(m.n, A()), await retrato(m.n, B())], [a1, b1]);
  await assert.rejects(m.n.registrarPagamentoPorOutraEmpresa(A(), B(), pagamento({ obrigacaoId: ob.id, valorCentavos: VALOR - 1 })), (e) => e.codigo === CODIGO.CONFLITO_IDEMPOTENCIA);
});

test("IC-2 conta que NÃO existia: criada na devedora e liquidada na mesma transação (UMA despesa, só na devedora)", async () => {
  const m = await cenario();
  const r = await m.n.registrarPagamentoPorOutraEmpresa(A(), B(), pagamento({ obrigacaoNova: conta(m.fornA.id, { fonte: { sistema: "MANUAL", idExterno: "MOVA:ic-2" } }), chave: "MOVA:ic-2" }));
  assert.deepEqual([r.contaCriada, r.titulo.situacao, r.efeito.despesasNaDevedora, r.efeito.despesasNaCredora, r.efeito.novasSaidas], [true, "QUITADA", 1, 0, 0]);
  const [a, b] = [await retrato(m.n, A()), await retrato(m.n, B())];
  assert.deepEqual([a.despesas, a.contas, a.saidas, b.despesas, b.contas, b.saidas], [1, 1, 0, 0, 0, 0]);
});

test("IC-3 direção INVERSA (A paga pela B): mesmas regras, cada lado na sua empresa", async () => {
  const m = await cenario();
  const ob = (await m.n.registrarObrigacao(B(), conta(m.fornB.id))).obrigacoes[0];
  const r = await m.n.registrarPagamentoPorOutraEmpresa(B(), A(), pagamento({ obrigacaoId: ob.id, nomeDevedora: "Subway Sintética", nomeCredora: "Açaí Sintético", chave: "MOVA:ic-3" }));
  assert.deepEqual([r.devedora.organizacaoId, r.credora.organizacaoId, r.titulo.situacao], [ORG_B, ORG_A, "QUITADA"]);
  const va = await m.n.consultarContasEntreEmpresas(A());
  const vb = await m.n.consultarContasEntreEmpresas(B());
  assert.deepEqual([va.totais.aReceberCentavos, va.totais.aPagarCentavos, vb.totais.aPagarCentavos, vb.totais.aReceberCentavos], [VALOR, 0, VALOR, 0]);
});

test("IC-4 REEMBOLSO parcial e integral liquida os dois lados; maior que o saldo é recusado; repetir não duplica; não é receita nem despesa", async () => {
  const m = await cenario();
  const ob = (await m.n.registrarObrigacao(A(), conta(m.fornA.id))).obrigacoes[0];
  const r = await m.n.registrarPagamentoPorOutraEmpresa(A(), B(), pagamento({ obrigacaoId: ob.id }));
  const [a0, b0] = [await retrato(m.n, A()), await retrato(m.n, B())];
  const p = await m.n.registrarReembolsoEntreEmpresas(A(), B(), { vinculoId: r.vinculoId, valorCentavos: 200000, data: "2026-10-12", chave: "reembolso-1" });
  assert.deepEqual([p.devedora.situacao, p.devedora.saldoCentavos, p.credora.situacao, p.credora.saldoCentavos], ["PARCIAL", VALOR - 200000, "PARCIAL", VALOR - 200000]);
  const rep = await m.n.registrarReembolsoEntreEmpresas(A(), B(), { vinculoId: r.vinculoId, valorCentavos: 200000, data: "2026-10-12", chave: "reembolso-1" });
  assert.equal(rep.repetido, true);
  await assert.rejects(m.n.registrarReembolsoEntreEmpresas(A(), B(), { vinculoId: r.vinculoId, valorCentavos: VALOR, data: "2026-10-13", chave: "reembolso-2" }), (e) => e.codigo === CODIGO.LIQUIDACAO_INCOMPATIVEL);
  const f = await m.n.registrarReembolsoEntreEmpresas(A(), B(), { vinculoId: r.vinculoId, valorCentavos: VALOR - 200000, data: "2026-10-14", chave: "reembolso-2" });
  assert.deepEqual([f.devedora.situacao, f.devedora.saldoCentavos, f.credora.situacao, f.credora.liquidacoes.length], ["LIQUIDADO", 0, "LIQUIDADO", 2]);
  assert.deepEqual([await retrato(m.n, A()), await retrato(m.n, B())], [a0, b0], "reembolso não cria lançamento, conta, liquidação de fornecedor nem saída");
  const ab = await m.n.consultarContasEntreEmpresas(A(), { incluirLiquidadas: false });
  assert.equal(ab.itens.length, 0);
});

test("IC-5 ATOMICIDADE: falha no lado da credora (saída inexistente) ⇒ NADA gravado na devedora (nem passivo, nem liquidação)", async () => {
  const m = await cenario();
  const ob = (await m.n.registrarObrigacao(A(), conta(m.fornA.id))).obrigacoes[0];
  const a0 = await retrato(m.n, A());
  await assert.rejects(m.n.registrarPagamentoPorOutraEmpresa(A(), B(), pagamento({ obrigacaoId: ob.id, movimentacaoCredoraId: "dddddddd-0000-4000-8000-000000000999" })), (e) => e.codigo === CODIGO.NAO_ENCONTRADO);
  assert.deepEqual(await retrato(m.n, A()), a0);
  const t = (await m.n.consultarRegistros(A(), { tipo: "OBRIGACAO" })).find((x) => x.id === ob.id);
  assert.equal(t.saldoCentavos, VALOR, "a conta continua em aberto");
});

test("IC-6 permissão nas DUAS empresas e escopos distintos: sem a ação numa delas ⇒ recusa antes de gravar", async () => {
  const m = await cenario();
  const ob = (await m.n.registrarObrigacao(A(), conta(m.fornA.id))).obrigacoes[0];
  const sem = (c) => ({ ...c, permissoes: c.permissoes.filter((x) => x !== ACAO.REGISTRAR_INTERCOMPANY) });
  await assert.rejects(m.n.registrarPagamentoPorOutraEmpresa(A(), sem(B()), pagamento({ obrigacaoId: ob.id })), (e) => e.codigo === CODIGO.PERMISSAO_INSUFICIENTE);
  await assert.rejects(m.n.registrarPagamentoPorOutraEmpresa(sem(A()), B(), pagamento({ obrigacaoId: ob.id })), (e) => e.codigo === CODIGO.PERMISSAO_INSUFICIENTE);
  await assert.rejects(m.n.registrarPagamentoPorOutraEmpresa(A(), A(), pagamento({ obrigacaoId: ob.id })), (e) => e.codigo === CODIGO.ENTRADA_INVALIDA);
  // conta nova exige também permissão de registrar conta na devedora
  const estreito = { ...A(), permissoes: [ACAO.VER, ACAO.REGISTRAR_INTERCOMPANY] };
  await assert.rejects(m.n.registrarPagamentoPorOutraEmpresa(estreito, B(), pagamento({ obrigacaoNova: conta(m.fornA.id, { fonte: { sistema: "MANUAL", idExterno: "MOVA:ic-6" } }), chave: "MOVA:ic-6" })), (e) => e.codigo === CODIGO.PERMISSAO_INSUFICIENTE);
  assert.equal((await retrato(m.n, A())).entreEmpresas, 0);
  assert.equal((await retrato(m.n, B())).entreEmpresas, 0);
});

test("IC-7 saída do EXTRATO da credora: ligada uma vez (mesmo valor); outra operação não reaproveita a mesma saída; nenhuma saída é criada", async () => {
  const m = await cenario();
  const ob1 = (await m.n.registrarObrigacao(A(), conta(m.fornA.id))).obrigacoes[0];
  const ob2 = (await m.n.registrarObrigacao(A(), conta(m.fornA.id, { descricao: "Outra compra (sintético)" }))).obrigacoes[0];
  const mov = (await m.n.registrarMovimentacao(B(), saida(m.bancoB.id, VALOR, { dataEfetiva: "2026-10-10", fonte: { sistema: "UNICRED", idExterno: "EXT-IC-1" } }))).movimentacao;
  const r = await m.n.registrarPagamentoPorOutraEmpresa(A(), B(), pagamento({ obrigacaoId: ob1.id }));
  const v = await m.n.vincularSaidaDaOperacaoEntreEmpresas(B(), { intercompanyId: r.credora.id, movimentacaoId: mov.id });
  assert.equal(v.registro.movimentacaoId, mov.id);
  assert.equal((await m.n.vincularSaidaDaOperacaoEntreEmpresas(B(), { intercompanyId: r.credora.id, movimentacaoId: mov.id })).repetido, true);
  await assert.rejects(m.n.registrarPagamentoPorOutraEmpresa(A(), B(), pagamento({ obrigacaoId: ob2.id, chave: "MOVA:ic-7b", movimentacaoCredoraId: mov.id })), (e) => e.codigo === CODIGO.CONFLITO_IDEMPOTENCIA);
  await assert.rejects(m.n.vincularSaidaDaOperacaoEntreEmpresas(A(), { intercompanyId: r.devedora.id, movimentacaoId: mov.id }));
  assert.equal((await retrato(m.n, B())).saidas, 1);
});

test("IC-8 visão: devedora, credora, valor, reembolsado, saldo, histórico; isolada por empresa (C não vê nada de A/B)", async () => {
  const m = await cenario();
  const ob = (await m.n.registrarObrigacao(A(), conta(m.fornA.id))).obrigacoes[0];
  const r = await m.n.registrarPagamentoPorOutraEmpresa(A(), B(), pagamento({ obrigacaoId: ob.id, vencimentoReembolso: "2026-11-10" }));
  await m.n.registrarReembolsoEntreEmpresas(A(), B(), { vinculoId: r.vinculoId, valorCentavos: 100000, data: "2026-10-20", chave: "r1", observacao: "Pix parcial (sintético)" });
  const v = await m.n.consultarContasEntreEmpresas(A());
  const [i] = v.itens;
  assert.deepEqual([i.papel, i.credora.organizacaoId, i.contraparteNome, i.valorCentavos, i.reembolsadoCentavos, i.saldoCentavos, i.vencimento, i.situacao, i.liquidacoes.length],
    ["DEVEDORA", ORG_B, "Subway Sintética", VALOR, 100000, VALOR - 100000, "2026-11-10", "PARCIAL", 1]);
  assert.deepEqual(v.totais, { aPagarCentavos: VALOR - 100000, aReceberCentavos: 0 });
  await assert.rejects(m.n.consultarContasEntreEmpresas(ctx(ORG_A, "aaaaaaaa-0000-4000-8000-0000000000ff")));
});

test("IC-9 banco — identidade ESTREITA do MOVA (só registrar_intercompany nas duas empresas) num PostgreSQL real: grava os dois lados; sem a concessão numa delas, nada fica gravado; a ação estreita não altera a conta além da posição", { skip: motivoParaPular(), timeout: 300000 }, async () => {
  const OPERADOR = "eeeeeeee-0000-4000-8000-0000000000cb";
  const ESTREITAS = [ACAO.VER, ACAO.REGISTRAR_INTERCOMPANY];
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_B, unidadeId: UNI_B });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const f = await m.nucleo.registrarContraparte(ctx(ORG_A, UNI_A, TODAS), { tipo: "FORNECEDOR", nome: "Distribuidora Sintética" });
  const ob = (await m.nucleo.registrarObrigacao(ctx(ORG_A, UNI_A, TODAS), conta(f.id))).obrigacoes[0];
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true });
  const dono = await (await repositorio.interno()).dono();
  const conceder = async (organizacaoId, unidadeId) => {
    const cl = await dono.connect();
    try {
      await cl.query("begin");
      await cl.query(sqlConcessaoOperacionalDoMova({ identidade: OPERADOR, organizacaoId, unidadeId, acoes: ESTREITAS, concedidoPor: "eeeeeeee-0000-4000-8000-0000000000d1", justificativa: "Identidade operacional do MOVA autorizada pelo proprietário (sintético)" }));
      await cl.query("commit");
    } finally { cl.release(); }
  };
  const opA = ctx(ORG_A, UNI_A, ESTREITAS, OPERADOR);
  const opB = ctx(ORG_B, UNI_B, ESTREITAS, OPERADOR);
  const linhas = async () => (await dono.query("select papel from fv2_intercompany order by papel")).rows.map((x) => x.papel);
  await conceder(ORG_A, UNI_A);
  // só na devedora: a credora recusa e a transação inteira volta
  await assert.rejects(n.registrarPagamentoPorOutraEmpresa(opA, opB, pagamento({ obrigacaoId: ob.id })));
  assert.deepEqual(await linhas(), []);
  assert.equal((await dono.query("select count(*)::int n from fv2_liquidacao where organizacao_id = $1", [ORG_A])).rows[0].n, 0);
  await conceder(ORG_B, UNI_B);
  const r = await n.registrarPagamentoPorOutraEmpresa(opA, opB, pagamento({ obrigacaoId: ob.id }));
  assert.deepEqual([r.titulo.situacao, r.liquidacao.movimentacaoId], ["QUITADA", null]);
  assert.deepEqual(await linhas(), ["CREDORA", "DEVEDORA"]);
  const v = (await dono.query("select count(distinct vinculo_id)::int n from fv2_intercompany")).rows[0].n;
  assert.equal(v, 1, "um único vínculo entre os dois registros");
  const p = await n.registrarReembolsoEntreEmpresas(opA, opB, { vinculoId: r.vinculoId, valorCentavos: VALOR, data: "2026-10-14", chave: "r-db" });
  assert.deepEqual([p.devedora.situacao, p.credora.situacao], ["LIQUIDADO", "LIQUIDADO"]);
  // a ação estreita sozinha não cria conta nova nem lançamento
  await assert.rejects(n.registrarPagamentoPorOutraEmpresa(opA, opB, pagamento({ obrigacaoNova: conta(f.id, { fonte: { sistema: "MANUAL", idExterno: "MOVA:ic-db-2" } }), chave: "MOVA:ic-db-2" })), (e) => e.codigo === CODIGO.PERMISSAO_INSUFICIENTE);
  // SQL cru com a sessão estreita: mudar a descrição/valor da conta é recusado pelo banco
  const tok = await (await repositorio.interno()).sessoes.emitir({ usuarioId: OPERADOR, organizacaoId: ORG_A, unidadeId: UNI_A, permissoes: ESTREITAS });
  const cl = await (await repositorio.interno()).pool.connect();
  try {
    await cl.query("begin");
    await cl.query("select fv2_assumir_sessao($1)", [tok]);
    await assert.rejects(cl.query("update fv2_obrigacao set descricao = 'alterada', versao = versao + 1 where id = $1", [ob.id]));
  } finally { await cl.query("rollback").catch(() => {}); cl.release(); }
});
