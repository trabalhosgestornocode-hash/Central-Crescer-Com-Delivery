// Execução 08C — RECLASSIFICAÇÃO FINANCEIRA SEGURA. Roda em memória e no PostgreSQL isolado (FV2_REPOSITORIO=postgres);
// os testes de SQL direto só no PostgreSQL. Identidades, contas, documentos e valores sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, UNI_A2, ctx, montar, montarComCadastros, obrigacao, prepararHomologacao, provisionarAdministrador, rejeita, saida, sha } from "./helpers/cenario.js";
import { comoAplicacao, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const SO_PG = { skip: motivoParaPular(), timeout: 300000 };
const doc = async (n, c, k, tipo = "NOTA_FISCAL") => (await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: `cofre:evidencia-${k}`, hashSha256: sha(k), tipo, recebidoEm: "2026-09-10", descricao: `Evidência sintética ${k}` })).documento.id;
const linha = (ap, codigo) => ap.dre.linhas.find((l) => l.codigo === codigo).valorCentavos;
const hist = async (n, c, id) => (await n.consultarHistorico(c, { registroTipo: "LANCAMENTO", registroId: id })).filter((h) => h.evento === "RECLASSIFICACAO");

async function cenarioProvisorio() {
  const m = await montarComCadastros();
  const { nucleo: n, c, fornecedor } = m;
  // Boleto sem identificação: conta a pagar reconhecida na categoria "a classificar" (fora da DRE).
  const pendente = await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 40000, categoria: "DESPESAS_A_CLASSIFICAR", descricao: "Boleto sem identificação (sintético)" }));
  // Histórico do mesmo fornecedor: duas contas de EMBALAGENS (base da sugestão).
  for (const k of ["h1", "h2"]) await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 1000, categoria: "EMBALAGENS", descricao: `Embalagens ${k}`, fonte: { sistema: "MANUAL", idExterno: `EMB-${k}` } }));
  return { ...m, n, pendente };
}

test("08C — prévia não grava; mostra caso, sugestão, categorias compatíveis e impacto calculado pelo motor", async () => {
  const { n, c, pendente } = await cenarioProvisorio();
  const l = pendente.lancamento;
  const antesDre = await n.apurarCompetencia(c, { competencia: "2026-09" });
  const r = await n.consultarReclassificacao(c, { lancamentoId: l.id, categoria: "EMBALAGENS" });
  assert.equal(r.caso, "OBRIGACAO_SEM_CATEGORIA_CONFIRMADA");
  assert.equal(r.categoriaAtual.provisoria, true);
  assert.equal(r.sugestao.categoria, "EMBALAGENS");
  assert.ok(r.categoriasPermitidas.every((x) => ["DESPESA", "PATRIMONIAL"].includes(x.natureza)), "despesa só vai para despesa ou patrimonial");
  assert.ok(!r.categoriasPermitidas.some((x) => ["DESPESAS_A_CLASSIFICAR", "DESCONTOS_A_CLASSIFICAR", "OUTRAS_RECEITAS"].includes(x.codigo)));
  assert.equal(r.podeReclassificar, true);
  // Impacto: custo entra na DRE, o título deixa de ficar "fora até classificar", caixa não muda, impedimento some.
  const custo = r.impacto.dre.linhasAlteradas.find((x) => x.codigo === "CUSTOS_OPERACIONAIS");
  assert.deepEqual([custo.antesCentavos - custo.depoisCentavos], [40000]);
  assert.equal(r.impacto.caixa.efeito, "NENHUM");
  assert.deepEqual([r.impacto.titulos[0].efeitoNaDreAntes, r.impacto.titulos[0].efeitoNaDreDepois], ["FORA_ATE_CLASSIFICAR", "NA_LINHA_DA_CATEGORIA"]);
  assert.ok(r.impacto.impedimentos.antes.includes("CLASSIFICACAO_PROVISORIA") && !r.impacto.impedimentos.depois.includes("CLASSIFICACAO_PROVISORIA"));
  assert.deepEqual([r.impacto.exigeEvidencia, r.impacto.evidenciaDisponivel, r.impacto.gravado], [true, false, false]);
  // Nada foi gravado pela prévia.
  const depoisDre = await n.apurarCompetencia(c, { competencia: "2026-09" });
  assert.deepEqual(depoisDre.dre.linhas.map((x) => x.valorCentavos), antesDre.dre.linhas.map((x) => x.valorCentavos));
  const [atual] = (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((x) => x.id === l.id);
  assert.deepEqual([atual.versao, atual.categoria], [l.versao, "DESPESAS_A_CLASSIFICAR"]);
  assert.equal((await hist(n, c, l.id)).length, 0);
});

test("08C — sem evidência a pendência continua; com documento, reclassifica, audita, atualiza DRE/impedimentos e não repete", async () => {
  const { n, c, pendente } = await cenarioProvisorio();
  const l = pendente.lancamento;
  await rejeita(n.reclassificarLancamento(c, { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "Sem nota (sintético).", versaoEsperada: l.versao }), CODIGO.EVIDENCIA_EXIGIDA);
  let fech = await n.consultarFechamento(c, { competencia: "2026-09" });
  assert.ok(fech.impedimentos.some((x) => x.codigo === "CLASSIFICACAO_PROVISORIA"), "sem evidência o impedimento permanece");
  // Nenhuma categoria genérica "resolve" sem documento: OUTRAS_DESPESAS também exige evidência para sair da provisória.
  await rejeita(n.reclassificarLancamento(c, { lancamentoId: l.id, categoria: "OUTRAS_DESPESAS", justificativa: "Genérica (sintético).", versaoEsperada: l.versao }), CODIGO.EVIDENCIA_EXIGIDA);
  const nota = await doc(n, c, "nota");
  const r = await n.reclassificarLancamento(c, { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "Nota fiscal identifica embalagens (sintético).", versaoEsperada: l.versao, documentoId: nota });
  assert.deepEqual([r.repetido, r.lancamento.categoria, r.lancamento.natureza, r.lancamento.valorCentavos, r.lancamento.versao, r.lancamento.id], [false, "EMBALAGENS", "DESPESA", 40000, l.versao + 1, l.id]);
  assert.deepEqual(r.lancamento.evidenciaDeClassificacao, [nota]);
  // Identidade preservada: nenhum lançamento novo foi criado.
  const lancs = (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((x) => x.situacao === "ATIVO");
  assert.equal(lancs.length, 3);
  const ap = await n.apurarCompetencia(c, { competencia: "2026-09" });
  assert.equal(linha(ap, "CUSTOS_OPERACIONAIS"), -42000);
  assert.equal(ap.dre.foraDoResultado.aClassificar.length, 0);
  fech = await n.consultarFechamento(c, { competencia: "2026-09" });
  assert.ok(!fech.impedimentos.some((x) => x.codigo === "CLASSIFICACAO_PROVISORIA"));
  const h = await hist(n, c, l.id);
  assert.deepEqual([h.length, h[0].antes.categoria, h[0].depois.categoria, h[0].justificativa], [1, "DESPESAS_A_CLASSIFICAR", "EMBALAGENS", "Nota fiscal identifica embalagens (sintético)."]);
  const vinculos = (await n.consultarRegistros(c, { tipo: "VINCULO_DOCUMENTAL" })).filter((v) => v.registroId === l.id);
  assert.deepEqual(vinculos.map((v) => v.documentoId), [nota]);
  // Repetição: nada novo (idempotente), mesmo com a versão antiga da prévia.
  const rep = await n.reclassificarLancamento(c, { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "De novo.", versaoEsperada: l.versao, documentoId: nota });
  assert.deepEqual([rep.repetido, rep.lancamento.versao], [true, l.versao + 1]);
  assert.equal((await hist(n, c, l.id)).length, 1);
  // A prévia mostra o histórico e o resultado.
  const consulta = await n.consultarReclassificacao(c, { lancamentoId: l.id });
  assert.deepEqual([consulta.categoriaAtual.codigo, consulta.historico.length, consulta.caso], ["EMBALAGENS", 1, "REATRIBUICAO_ENTRE_CATEGORIAS"]);
});

test("08C — prévia antiga não autoriza alterar registro que mudou; concorrência tem um vencedor", async () => {
  const { nucleo: n, c, fornecedor } = await montarComCadastros();
  const { lancamento: l } = await n.registrarObrigacao(c, obrigacao(fornecedor.id, { categoria: "INSUMOS" }));
  await n.corrigirLancamento(c, { lancamentoId: l.id, mudancas: { descricao: "Descrição corrigida" }, justificativa: "Correção cadastral." });
  await rejeita(n.reclassificarLancamento(c, { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "Prévia velha.", versaoEsperada: l.versao }), CODIGO.CONFLITO_VERSAO);
  const v = l.versao + 1;
  const resultados = await Promise.allSettled([
    n.reclassificarLancamento(c, { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "A (sintético).", versaoEsperada: v }),
    n.reclassificarLancamento(c, { lancamentoId: l.id, categoria: "FRUTAS", justificativa: "B (sintético).", versaoEsperada: v }),
  ]);
  const ok = resultados.filter((x) => x.status === "fulfilled");
  assert.equal(ok.length, 1, "só uma confirmação concorrente vence");
  assert.equal(resultados.find((x) => x.status === "rejected").reason.codigo, CODIGO.CONFLITO_VERSAO);
  assert.equal((await hist(n, c, l.id)).length, 1);
});

test("08C — natureza econômica preservada: receita, dedução, provisória e patrimonial", async () => {
  const { nucleo: n, c, fornecedor, caixa: conta } = await montarComCadastros();
  const venda = await n.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-05", brutoCentavos: 5000, fonte: { sistema: "MANUAL", idExterno: "RC-1" }, composicao: { itensCentavos: 5000, descontos: [{ valorCentavos: 500, financiador: "PENDENTE" }] }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 4500, contaId: conta.id }] });
  const lancs = await n.consultarRegistros(c, { tipo: "LANCAMENTO" });
  const receita = lancs.find((x) => x.natureza === "RECEITA" && x.origem?.id === venda.venda.id);
  const desconto = lancs.find((x) => x.categoria === "DESCONTOS_A_CLASSIFICAR");
  await rejeita(n.reclassificarLancamento(c, { lancamentoId: receita.id, categoria: "FRUTAS", justificativa: "x", versaoEsperada: receita.versao }), CODIGO.CATEGORIA_INVALIDA);
  await rejeita(n.reclassificarLancamento(c, { lancamentoId: desconto.id, categoria: "EMBALAGENS", justificativa: "x", versaoEsperada: desconto.versao, documentoId: await doc(n, c, "d1") }), CODIGO.CATEGORIA_INVALIDA);
  assert.equal((await n.consultarReclassificacao(c, { lancamentoId: desconto.id })).caso, "DESCONTO_SEM_FINANCIADOR");
  assert.equal((await n.consultarReclassificacao(c, { lancamentoId: receita.id })).caso, "CLASSIFICACAO_DE_RECEITA");
  // Ninguém reclassifica PARA uma categoria provisória.
  const { lancamento: ins } = await n.registrarObrigacao(c, obrigacao(fornecedor.id, { categoria: "INSUMOS", fonte: { sistema: "MANUAL", idExterno: "INS-1" } }));
  await rejeita(n.reclassificarLancamento(c, { lancamentoId: ins.id, categoria: "DESPESAS_A_CLASSIFICAR", justificativa: "x", versaoEsperada: ins.versao }), CODIGO.CATEGORIA_INVALIDA);
  // Conta a pagar "a classificar" que era principal de empréstimo: despesa → patrimonial (sai do resultado, continua dívida).
  const emp = await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 30000, categoria: "DESPESAS_A_CLASSIFICAR", fonte: { sistema: "MANUAL", idExterno: "EMP-1" } }));
  const r = await n.reclassificarLancamento(c, { lancamentoId: emp.lancamento.id, categoria: "EMPRESTIMOS_E_FINANCIAMENTOS", justificativa: "Contrato de empréstimo (sintético).", versaoEsperada: emp.lancamento.versao, documentoId: await doc(n, c, "contrato", "CONTRATO") });
  assert.equal(r.lancamento.natureza, "PATRIMONIAL");
  const ap = await n.apurarCompetencia(c, { competencia: "2026-09" });
  assert.ok(ap.dre.foraDoResultado.patrimoniais.some((x) => x.lancamentoId === emp.lancamento.id));
  const titulo = (await n.consultarContasAPagar(c, {})).itens.find((t) => t.id === emp.obrigacoes[0].id);
  assert.deepEqual([titulo.saldoCentavos, titulo.efeitoNaDre], [30000, "FORA_DO_RESULTADO"]);
  // Cancelado não se reclassifica.
  await n.cancelarObrigacao(c, { obrigacaoId: (await n.consultarRegistros(c, { tipo: "OBRIGACAO" })).find((o) => o.lancamentoId === ins.id).id, justificativa: "Duplicada (sintético)." });
  const [cancelado] = (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((x) => x.id === ins.id);
  await rejeita(n.reclassificarLancamento(c, { lancamentoId: ins.id, categoria: "EMBALAGENS", justificativa: "x", versaoEsperada: cancelado.versao }), CODIGO.OPERACAO_INVALIDA);
  assert.equal((await n.consultarReclassificacao(c, { lancamentoId: ins.id })).caso, "OPERACAO_CANCELADA_OU_ESTORNADA");
});

test("08C — movimentação sem natureza não é reclassificada: o caminho é vincular a uma conta", async () => {
  const { nucleo: n, c, banco: conta } = await montarComCadastros();
  const { movimentacao } = await n.registrarMovimentacao(c, saida(conta.id, 1500));
  const r = await n.consultarReclassificacao(c, { movimentacaoId: movimentacao.id });
  assert.deepEqual([r.caso, r.permitida], ["MOVIMENTACAO_SEM_NATUREZA", false]);
  // Nenhuma despesa foi criada pela consulta.
  assert.equal((await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).length, 0);
});

test("08C — permissão própria: corrigir não reclassifica; competência homologada exige reabertura formal", async () => {
  const { n, c, pendente } = await cenarioProvisorio();
  const l = pendente.lancamento;
  const nota = await doc(n, c, "n2");
  const semReclassificar = ctx(ORG_A, UNI_A, TODAS.filter((a) => a !== ACAO.RECLASSIFICAR));
  await rejeita(n.reclassificarLancamento(semReclassificar, { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "x", versaoEsperada: l.versao, documentoId: nota }), CODIGO.PERMISSAO_INSUFICIENTE);
  const leitor = ctx(ORG_A, UNI_A, [ACAO.VER]);
  const vista = await n.consultarReclassificacao(leitor, { lancamentoId: l.id });
  assert.equal(vista.podeReclassificar, false);
  assert.match(vista.motivoBloqueio, /reclassificar/);
  // Homologada: recusa; reabertura formal (reabrir + justificativa) e então reclassifica.
  await n.reclassificarLancamento(c, { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "Nota (sintético).", versaoEsperada: l.versao, documentoId: nota });
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  // 08E (F-1): pendências que exigem documentação são documentadas como ressalva sintética antes de homologar.
  await prepararHomologacao(n, c, "2026-09");
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Homologação sintética.", confirmar: true });
  const [atual] = (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((x) => x.id === l.id);
  await rejeita(n.reclassificarLancamento(c, { lancamentoId: l.id, categoria: "FRUTAS", justificativa: "Depois da homologação.", versaoEsperada: atual.versao }), CODIGO.COMPETENCIA_HOMOLOGADA);
  assert.match((await n.consultarReclassificacao(c, { lancamentoId: l.id })).motivoBloqueio, /homologada/);
  const versoes = await n.consultarVersoesDeFechamento(c, { competencia: "2026-09" });
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "ABERTA", justificativa: "Correção de classificação com nova evidência (sintético).", confirmar: true });
  const r = await n.reclassificarLancamento(c, { lancamentoId: l.id, categoria: "FRUTAS", justificativa: "Nova nota (sintético).", versaoEsperada: atual.versao });
  assert.equal(r.lancamento.categoria, "FRUTAS");
  // A versão homologada anterior continua reproduzível (não foi reescrita).
  const depois = await n.consultarVersoesDeFechamento(c, { competencia: "2026-09" });
  const semVigencia = (v) => ({ ...(v.versoes?.[0] ?? v[0]), vigente: null });
  assert.deepEqual(semVigencia(depois), semVigencia(versoes)); // só deixou de ser a vigente; conteúdo e impressão intactos
});

test("08C — escopo: lançamento de outra unidade não é alcançado", async () => {
  const { n, c, pendente } = await cenarioProvisorio();
  const outra = ctx(ORG_A, UNI_A2);
  await rejeita(n.reclassificarLancamento(outra, { lancamentoId: pendente.lancamento.id, categoria: "EMBALAGENS", justificativa: "x", versaoEsperada: 1 }), CODIGO.NAO_ENCONTRADO);
  await rejeita(n.consultarReclassificacao(outra, { lancamentoId: pendente.lancamento.id }), CODIGO.NAO_ENCONTRADO);
});

// --------------------------------------------------------------------------------------------- banco (PostgreSQL)
const U = (k) => `dddddddd-0000-4000-8000-0000000003${String(k).padStart(2, "0")}`;

async function cenarioBanco() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true });
  const ingenuo = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA });
  const adm = ctx(ORG_A, UNI_A, TODAS);
  const perfis = { corretor: [ACAO.VER, ACAO.CORRIGIR, ACAO.REVISAR, ACAO.CANCELAR], reclassificador: [ACAO.VER, ACAO.RECLASSIFICAR] };
  const ids = { corretor: U(1), reclassificador: U(2) };
  for (const [p, acoes] of Object.entries(perfis)) await n.concederAcesso(adm, { usuarioId: ids[p], acoes, justificativa: `Perfil ${p} (sintético).` });
  const forn = await m.nucleo.registrarContraparte(adm, { tipo: "FORNECEDOR", nome: "Fornecedor sintético" });
  const pend = await m.nucleo.registrarObrigacao(adm, obrigacao(forn.id, { valorOriginalCentavos: 40000, categoria: "DESPESAS_A_CLASSIFICAR" }));
  const nota = await doc(m.nucleo, adm, "nb");
  const como = (p, acoes = TODAS) => ctx(ORG_A, UNI_A, acoes, ids[p]);
  return { repositorio, m, n, ingenuo, adm, ids, perfis, como, pend, nota };
}

test("08C banco — corrigir não muda categoria; reclassificar não muda valor nem cancela (núcleo ingênuo, contexto alegando tudo)", SO_PG, async () => {
  const { n, ingenuo, como, pend, nota, perfis } = await cenarioBanco();
  const l = pend.lancamento;
  const recusado = (p) => assert.rejects(p, (e) => [CODIGO.PERMISSAO_INSUFICIENTE, CODIGO.INTEGRIDADE_VIOLADA].includes(e.codigo));
  await rejeita(n.reclassificarLancamento(como("corretor", perfis.corretor), { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "x", versaoEsperada: l.versao, documentoId: nota }), CODIGO.PERMISSAO_INSUFICIENTE);
  await recusado(ingenuo.reclassificarLancamento(como("corretor"), { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "x", versaoEsperada: l.versao, documentoId: nota }));
  await recusado(ingenuo.cancelarObrigacao(como("reclassificador"), { obrigacaoId: pend.obrigacoes[0].id, justificativa: "x" }));
  await recusado(ingenuo.corrigirLancamento(como("reclassificador"), { lancamentoId: l.id, mudancas: { descricao: "x" }, justificativa: "x" }));
  const r = await n.reclassificarLancamento(como("reclassificador", perfis.reclassificador), { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "Nota (sintético).", versaoEsperada: l.versao, documentoId: nota });
  assert.equal(r.lancamento.categoria, "EMBALAGENS");
});

test("08C banco — SQL direto: o gatilho preserva a identidade, a natureza e o plano; revogação vale na hora", SO_PG, async () => {
  const { repositorio, n, ingenuo, adm, ids, como, pend, perfis } = await cenarioBanco();
  const interno = await repositorio.interno();
  const l = pend.lancamento;
  const escopo = (usuarioId, permissoes) => ({ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId, permissoes });
  const sql = async (usuarioId, permissoes, texto, valores) => {
    const token = await interno.sessoes.emitir(escopo(usuarioId, permissoes));
    return comoAplicacao(interno, escopo(usuarioId, permissoes), (cl) => cl.query(texto, valores), { token });
  };
  const cat = async (codigo) => (await n.consultarRegistros(adm, { tipo: "CATEGORIA" })).find((x) => x.codigo === codigo);
  const emb = await cat("EMBALAGENS");
  const rec = await cat("OUTRAS_RECEITAS");
  const set = "update fv2_lancamento set categoria_id = $2, categoria_codigo = $3, classificacao = $4, natureza = $5, versao = versao + 1";
  const R = ids.reclassificador;
  // Categoria + valor na mesma gravação: identidade do fato não muda.
  await assert.rejects(sql(R, perfis.reclassificador, `${set}, valor_centavos = 1 where id = $1`, [l.id, emb.id, emb.codigo, emb.classificacao, emb.natureza]), (e) => e.code === "FV037");
  // Natureza incompatível (despesa → receita).
  await assert.rejects(sql(R, perfis.reclassificador, `${set} where id = $1`, [l.id, rec.id, rec.codigo, rec.classificacao, rec.natureza]), (e) => e.code === "FV038");
  // Código e id que não conferem com o plano (forjar natureza).
  await assert.rejects(sql(R, perfis.reclassificador, `${set} where id = $1`, [l.id, emb.id, "INSUMOS", emb.classificacao, emb.natureza]), (e) => e.code === "FV038");
  // Sem a ação: 42501 no banco, mesmo com SQL válido.
  await assert.rejects(sql(ids.corretor, perfis.corretor, `${set} where id = $1`, [l.id, emb.id, emb.codigo, emb.classificacao, emb.natureza]), (e) => e.code === "42501");
  // Revogação: o token antigo deixa de valer e o núcleo ingênuo é barrado pelo banco.
  await n.revogarAcesso(adm, { usuarioId: R, acoes: [ACAO.RECLASSIFICAR], justificativa: "Fim da função (sintético)." });
  await rejeita(n.reclassificarLancamento(como("reclassificador", perfis.reclassificador), { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "x", versaoEsperada: l.versao }), CODIGO.PERMISSAO_INSUFICIENTE);
  // Sem nenhuma ação de escrita, o banco nem deixa alcançar a linha (NAO_ENCONTRADO também é recusa segura).
  await assert.rejects(ingenuo.reclassificarLancamento(como("reclassificador"), { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "x", versaoEsperada: l.versao }), (e) => [CODIGO.PERMISSAO_INSUFICIENTE, CODIGO.INTEGRIDADE_VIOLADA, CODIGO.NAO_ENCONTRADO].includes(e.codigo));
  const [atual] = (await n.consultarRegistros(adm, { tipo: "LANCAMENTO" })).filter((x) => x.id === l.id);
  assert.deepEqual([atual.categoria, atual.valorCentavos, atual.versao], ["DESPESAS_A_CLASSIFICAR", 40000, l.versao]);
});

test("08C banco — migração restritiva: concessão anterior com corrigir/revisar não recebe reclassificar", SO_PG, async () => {
  const { n, adm, ids } = await cenarioBanco();
  const p = await n.consultarPermissoes(adm);
  const lista = p.itens ?? p.concessoes ?? p.usuarios ?? [];
  const corretor = lista.find((x) => x.usuarioId === ids.corretor);
  assert.ok(corretor && corretor.acoes.includes(ACAO.CORRIGIR) && !corretor.acoes.includes(ACAO.RECLASSIFICAR));
});
