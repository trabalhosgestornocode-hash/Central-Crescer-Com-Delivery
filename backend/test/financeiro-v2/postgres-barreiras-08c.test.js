// Execução 08C — barreiras do BANCO que os testes de mutação precisam enxergar: confirmar importação só com `importar`
// e ação concedida em OUTRA unidade usada nesta. Núcleo "ingênuo" (não confere concessão gravada; contexto alega tudo):
// quem recusa é o PostgreSQL. Dados e identidades sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, UNI_A2, ctx, montar, obrigacao, provisionarAdministrador } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, saiposVendas } from "./helpers/arquivos.js";
import { motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

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
