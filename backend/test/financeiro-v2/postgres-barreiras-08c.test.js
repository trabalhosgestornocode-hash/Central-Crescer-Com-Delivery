// Execução 08C — barreiras do BANCO que os testes de mutação precisam enxergar: confirmar importação só com `importar`
// e ação concedida em OUTRA unidade usada nesta. Núcleo "ingênuo" (não confere concessão gravada; contexto alega tudo):
// quem recusa é o PostgreSQL. Dados e identidades sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, UNI_A2, ctx, montar, obrigacao, prepararHomologacao, provisionarAdministrador } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, saiposVendas } from "./helpers/arquivos.js";
import { comoAplicacao, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular(), timeout: 300000 };
const recusado = (p) => assert.rejects(p, (e) => [CODIGO.PERMISSAO_INSUFICIENTE, CODIGO.INTEGRIDADE_VIOLADA, CODIGO.NAO_ENCONTRADO].includes(e.codigo));
const U = (k) => `dddddddd-0000-4000-8000-0000000004${String(k).padStart(2, "0")}`;

async function cenario() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  for (const unidadeId of [UNI_A, UNI_A2]) await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: m.cofre, exigirConcessaoPersistida: true });
  const ingenuo = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: m.cofre });
  return { repositorio, m, n, ingenuo, adm: (u = UNI_A) => ctx(ORG_A, u, TODAS) };
}

test("08C banco — importar não confirma importação (a confirmação grava registros de fonte: exige confirmar_importacao)", pular, async () => {
  const { m, n, ingenuo, adm } = await cenario();
  await n.concederAcesso(adm(), { usuarioId: U(1), acoes: [ACAO.VER, ACAO.IMPORTAR], justificativa: "Só importa (sintético)." });
  const r = await m.nucleo.receberArquivoParaImportacao(adm(), { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", ...PERIODO_SETEMBRO, conteudo: saiposVendas([{ pedido: "B-1", data: "05/09/2026 12:00", itens: 2000, forma: "Dinheiro" }]) });
  await recusado(ingenuo.confirmarImportacao(ctx(ORG_A, UNI_A, TODAS, U(1)), { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia }));
  const [imp] = (await n.consultarRegistros(adm(), { tipo: "IMPORTACAO" })).filter((x) => x.id === r.importacao.id);
  assert.notEqual(imp.estado, "IMPORTADO");
  assert.equal((await n.consultarRegistros(adm(), { tipo: "REGISTRO_FONTE" })).length, 0);
});

test("08C banco — ação concedida em OUTRA unidade não vale nesta (reclassificar e fechar)", pular, async () => {
  const { m, n, ingenuo, adm } = await cenario();
  await n.concederAcesso(adm(UNI_A), { usuarioId: U(2), acoes: [ACAO.VER], justificativa: "Leitura nesta unidade (sintético)." });
  await n.concederAcesso(adm(UNI_A2), { usuarioId: U(2), acoes: [ACAO.VER, ACAO.RECLASSIFICAR, ACAO.FECHAR, ACAO.CORRIGIR], justificativa: "Operação na outra unidade (sintético)." });
  const forn = await m.nucleo.registrarContraparte(adm(), { tipo: "FORNECEDOR", nome: "Fornecedor sintético" });
  const { lancamento: l } = await m.nucleo.registrarObrigacao(adm(), obrigacao(forn.id, { categoria: "INSUMOS" }));
  const comoNaA = ctx(ORG_A, UNI_A, TODAS, U(2));
  await recusado(ingenuo.reclassificarLancamento(comoNaA, { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "x", versaoEsperada: l.versao }));
  await recusado(ingenuo.alterarEstadoDaCompetencia(comoNaA, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" }));
  const [atual] = (await n.consultarRegistros(adm(), { tipo: "LANCAMENTO" })).filter((x) => x.id === l.id);
  assert.deepEqual([atual.categoria, atual.versao], ["INSUMOS", l.versao]);
  assert.equal((await n.consultarRegistros(adm(), { tipo: "COMPETENCIA" })).length, 0);
});

// ---------------------------------------------------------------------------- isolando cada gatilho da 0013 (mutação 08C)
// Os testes da 08B eram barrados ANTES pela política da tabela; aqui o usuário tem tudo o que a tabela pede, e só o
// gatilho específico da transição (ou a regra da função de concessão) pode recusar.

test("08C banco — aplicar proposta exige `aplicar` mesmo para quem registra e aprova (gatilho da proposta)", pular, async () => {
  const { m, n, ingenuo, adm } = await cenario();
  await n.concederAcesso(adm(), { usuarioId: U(3), acoes: [ACAO.VER, ACAO.REGISTRAR, ACAO.APROVAR], justificativa: "Registra e aprova, não aplica (sintético)." });
  const caixa = await m.nucleo.configurarContaFinanceira(adm(), { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const r = await m.nucleo.receberArquivoParaImportacao(adm(), { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", ...PERIODO_SETEMBRO, conteudo: saiposVendas([{ pedido: "AP-1", data: "05/09/2026 12:00", itens: 2000, forma: "Dinheiro" }]) });
  const conf = await m.nucleo.confirmarImportacao(adm(), { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia });
  await m.nucleo.gerarPropostas(adm(), { importacaoId: conf.importacao.id, contaCaixaId: caixa.id });
  const [p] = (await n.consultarRegistros(adm(), { tipo: "PROPOSTA" })).filter((x) => x.importacaoId === conf.importacao.id);
  await n.aprovarProposta(adm(), { propostaId: p.id, justificativa: "Conferida (sintético)." });
  await recusado(ingenuo.aplicarProposta(ctx(ORG_A, UNI_A, TODAS, U(3)), { propostaId: p.id }));
  assert.equal((await n.consultarRegistros(adm(), { tipo: "VENDA" })).length, 0);
  const [depois] = (await n.consultarRegistros(adm(), { tipo: "PROPOSTA" })).filter((x) => x.id === p.id);
  assert.equal(depois.estado, "APROVADA");
});

test("08C banco — reabrir competência homologada exige `reabrir` mesmo para quem fecha (gatilho da transição)", pular, async () => {
  const { n, ingenuo, adm } = await cenario();
  await n.concederAcesso(adm(), { usuarioId: U(4), acoes: [ACAO.VER, ACAO.FECHAR, ACAO.CONCILIAR], justificativa: "Fecha e concilia, não reabre (sintético)." });
  // 08E (F-1): pendências que exigem documentação são documentadas (ressalva sintética) antes de homologar.
  await prepararHomologacao(n, adm(), "2026-08");
  await n.alterarEstadoDaCompetencia(adm(), { competencia: "2026-08", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Sintética.", confirmar: true });
  await recusado(ingenuo.alterarEstadoDaCompetencia(ctx(ORG_A, UNI_A, TODAS, U(4)), { competencia: "2026-08", novoEstado: "ABERTA", justificativa: "Tentativa sem reabrir (sintético).", confirmar: true }));
  const [c] = (await n.consultarRegistros(adm(), { tipo: "COMPETENCIA" })).filter((x) => x.competencia === "2026-08");
  assert.equal(c.estado, "FECHAMENTO_HOMOLOGADO");
});

test("08C banco — SQL direto na função de concessão: quem só concede não revoga (FV036)", pular, async () => {
  const { repositorio, n, adm } = await cenario();
  await n.concederAcesso(adm(), { usuarioId: U(5), acoes: [ACAO.VER, ACAO.CONCEDER], justificativa: "Só concede (sintético)." });
  await n.concederAcesso(adm(), { usuarioId: U(6), acoes: [ACAO.VER, ACAO.REGISTRAR], justificativa: "Alvo (sintético)." });
  const interno = await repositorio.interno();
  const dono = await interno.dono();
  const { rows: [alvo] } = await dono.query("select to_jsonb(c) as j, versao from fv2_concessao c where usuario_id = $1 and unidade_id = $2", [U(6), UNI_A]);
  const p = { ...alvo.j, acoes: ["financeiro_v2.ver"], versao: alvo.versao + 1, atualizado_por: U(5), concedido_por: U(5), atualizado_em: new Date().toISOString(), justificativa: "Revogação sem a ação revogar (sintético)." };
  const escopo = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: U(5), permissoes: [ACAO.VER, ACAO.CONCEDER] };
  const token = await interno.sessoes.emitir(escopo);
  await assert.rejects(comoAplicacao(interno, escopo, (cl) => cl.query("select fv2_gravar_concessao($1::jsonb, $2)", [JSON.stringify(p), alvo.versao]), { token }), (e) => e.code === "FV036");
  const { rows: [depois] } = await dono.query("select acoes from fv2_concessao where usuario_id = $1 and unidade_id = $2", [U(6), UNI_A]);
  assert.ok(depois.acoes.includes("financeiro_v2.registrar"));
});
