// Execução 08 — AUTORIZAÇÃO POR AÇÃO no PostgreSQL (migração 0012). SQL "à mão" com os privilégios do papel da
// aplicação e sessões de banco legítimas de usuários com concessões LIMITADAS (gravadas pelo núcleo). RLS por unidade não
// substitui autorização por ação: aqui, dentro da própria unidade, cada ação só grava o que lhe cabe. Dados sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, ctx, montar, provisionarAdministrador, rejeita } from "./helpers/cenario.js";
import { comoAplicacao, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular(), timeout: 300000 };
const A = { organizacaoId: ORG_A, unidadeId: UNI_A };
const U = (n) => `dddddddd-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
const PERFIS = {
  leitor: [ACAO.VER], importador: [ACAO.VER, ACAO.IMPORTAR], conciliador: [ACAO.VER, ACAO.CONCILIAR],
  operador: [ACAO.VER, ACAO.REGISTRAR], fechador: [ACAO.VER, ACAO.FECHAR], configurador: [ACAO.VER, ACAO.CONFIGURAR],
};
const recusa = (p, ...codigos) => assert.rejects(p, (e) => {
  assert.ok(codigos.includes(e.code ?? e.codigo), `esperava ${codigos.join("/")}, veio ${e.code ?? e.codigo}: ${e.message}`);
  return true;
});

async function cenario() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { ...A });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true });
  const adm = ctx(ORG_A, UNI_A, TODAS);
  const ids = {};
  let i = 0;
  for (const [perfil, acoes] of Object.entries(PERFIS)) {
    ids[perfil] = U((i += 1));
    await n.concederAcesso(adm, { usuarioId: ids[perfil], acoes, justificativa: `Perfil sintético ${perfil}.` });
  }
  const conta = await m.nucleo.configurarContaFinanceira(adm, { tipo: "BANCARIA", nome: "Banco" });
  const forn = await m.nucleo.registrarContraparte(adm, { tipo: "FORNECEDOR", nome: "Fornecedor" });
  const obrig = (await m.nucleo.registrarObrigacao(adm, { contraparteId: forn.id, valorOriginalCentavos: 1000, categoria: "INSUMOS", descricao: "x", competencia: "2026-09", dataEmissao: "2026-09-02", vencimento: "2026-09-20" })).obrigacoes[0];
  await m.nucleo.alterarEstadoDaCompetencia(adm, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  const interno = await repositorio.interno();
  const sql = async (perfil, texto, valores = []) => comoAplicacao(interno, null, (cl) => cl.query(texto, valores), { token: await interno.sessoes.emitir({ ...A, usuarioId: ids[perfil] }) });
  return { repositorio, n, m, adm, ids, conta, forn, obrig, interno, sql };
}

// UPDATE barrado pelo RLS (USING) não dá erro: simplesmente não alcança linha nenhuma. "Nada alterado" é a prova.
const nadaAlterado = async (p) => assert.equal((await p).rowCount, 0, "nenhuma linha alterada");
const contraparteNova = (escopo = A) => ["insert into fv2_contraparte (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, tipo, nome) values ($1, $2, $3, 1, now(), $4, now(), $4, 'FORNECEDOR', 'Injetado')", [randomUUID(), escopo.organizacaoId, escopo.unidadeId, U(99)]];

test("08 — cada ação só grava o que lhe cabe NO BANCO (mesma unidade, sessão legítima, SQL direto)", pular, async () => {
  const { sql, conta, obrig, m, adm, interno, ids } = await cenario();
  // 1. Leitura tentando gravar: nada.
  await recusa(sql("leitor", ...contraparteNova()), "42501");
  await nadaAlterado(sql("leitor", "update fv2_conta set nome = 'x', versao = versao + 1 where id = $1", [conta.id]));
  // 2. Importação tentando homologar / mudar estado da competência.
  await nadaAlterado(sql("importador", "update fv2_competencia set estado = 'FECHAMENTO_HOMOLOGADO', versao = versao + 1 where competencia = '2026-09'"));
  // 3. Conciliação tentando gravar venda, obrigação, conta ou conceder acesso.
  await recusa(sql("conciliador", ...contraparteNova()), "42501");
  await nadaAlterado(sql("conciliador", "update fv2_obrigacao set descricao = 'x', versao = versao + 1 where id = $1", [obrig.id]));
  await recusa(sql("conciliador", "select fv2_gravar_concessao($1::jsonb, null)", [JSON.stringify({ id: randomUUID(), organizacao_id: ORG_A, unidade_id: UNI_A, versao: 1, criado_em: new Date().toISOString(), criado_por: U(3), atualizado_em: new Date().toISOString(), atualizado_por: U(3), chave_idempotencia: "concessao:x", impressao: null, extras: {}, usuario_id: U(98), acoes: [ACAO.VER], situacao: "ATIVA", concedido_por: U(3), justificativa: "x" })]), "FV032");
  // 4. Fechar não homologa; operador não fecha nem administra contas; configurador não registra obrigação.
  await recusa(sql("fechador", "update fv2_competencia set estado = 'FECHAMENTO_HOMOLOGADO', versao = versao + 1 where competencia = '2026-09'"), "42501");
  await nadaAlterado(sql("operador", "update fv2_competencia set estado = 'FECHAMENTO_COM_PENDENCIAS', versao = versao + 1 where competencia = '2026-09'"));
  await nadaAlterado(sql("operador", "update fv2_conta set nome = 'x', versao = versao + 1 where id = $1", [conta.id]));
  await nadaAlterado(sql("configurador", "update fv2_obrigacao set descricao = 'x', versao = versao + 1 where id = $1", [obrig.id]));
  // Fechar ENXERGA a competência (pode fechar), mas homologar exige `homologar`: aqui a recusa é com erro (gatilho).
  // 5. Tabelas sem alteração legítima recusam até o administrador (erro, não "sumiço").
  const { documento } = await m.nucleo.registrarDocumento(adm, { origem: "MANUAL", arquivoId: "cofre:sintetico-08", hashSha256: "a".repeat(64), tipo: "COMPROVANTE", recebidoEm: "2026-09-10" });
  await m.nucleo.vincularDocumento(adm, { documentoId: documento.id, registroTipo: "OBRIGACAO", registroId: obrig.id });
  await recusa(sql("operador", "update fv2_vinculo_documental set registro_tipo = registro_tipo, versao = versao + 1"), "42501");
  // Controles positivos: cada um grava o que é seu (a recusa acima não é "nada funciona").
  // (com o histórico exigido pelo banco na mesma transação, como o núcleo faz)
  const comHistorico = async (perfil, texto, valores, registroTipo, registroId, versao) => comoAplicacao(interno, null, async (cl) => {
    const r = await cl.query(texto, valores);
    await cl.query("insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, usuario_id, em) values ($1, $2, $3, $4, $5, 'CORRECAO', null, $6::jsonb, $7, now())",
      [randomUUID(), ORG_A, UNI_A, registroTipo, registroId, JSON.stringify({ versao }), ids[perfil]]);
    return r;
  }, { token: await interno.sessoes.emitir({ ...A, usuarioId: ids[perfil] }) });
  const [sqlNova, valoresNova] = contraparteNova();
  assert.equal((await comHistorico("operador", sqlNova, valoresNova, "CONTRAPARTE", valoresNova[0], 1)).rowCount, 1);
  assert.equal((await comHistorico("configurador", "update fv2_conta set nome = 'Banco renomeado', versao = versao + 1 where id = $1", [conta.id], "CONTA", conta.id, conta.versao + 1)).rowCount, 1);
});

test("08 — pelo núcleo, a mesma barreira: ação errada é recusada antes; e o banco recusa mesmo se o núcleo deixasse passar", pular, async () => {
  const { repositorio, n, ids } = await cenario();
  const c = (perfil, acoes = PERFIS[perfil]) => ctx(ORG_A, UNI_A, acoes, ids[perfil]);
  await rejeita(n.alterarEstadoDaCompetencia(c("importador"), { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "x", confirmar: true }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(n.concederAcesso(c("conciliador"), { usuarioId: U(98), acoes: [ACAO.VER], justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
  // Núcleo SEM exigir concessão gravada (um núcleo "ingênuo") e contexto que ALEGA homologar: o BANCO recusa pela
  // concessão real do usuário da sessão (só tem `fechar`).
  const ingenuo = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA });
  await rejeita(ingenuo.alterarEstadoDaCompetencia(ctx(ORG_A, UNI_A, TODAS, ids.fechador), { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Sintética.", confirmar: true }), CODIGO.INTEGRIDADE_VIOLADA);
  await rejeita(ingenuo.registrarContraparte(ctx(ORG_A, UNI_A, TODAS, ids.conciliador), { tipo: "FORNECEDOR", nome: "Alegado" }), CODIGO.INTEGRIDADE_VIOLADA);
  // O dono de verdade da ação passa pelo mesmo núcleo ingênuo.
  assert.equal((await ingenuo.registrarContraparte(ctx(ORG_A, UNI_A, TODAS, ids.operador), { tipo: "FORNECEDOR", nome: "Legítimo" })).nome, "Legítimo");
});

test("08 — revogação de UMA ação no meio da transação: o comando seguinte já é recusado", pular, async () => {
  const { n, adm, ids, interno } = await cenario();
  const token = await interno.sessoes.emitir({ ...A, usuarioId: ids.operador });
  const cl = await interno.pool.connect();
  try {
    await cl.query("begin");
    await cl.query("select fv2_assumir_sessao($1)", [token]);
    const [sqlA, valoresA] = contraparteNova();
    assert.equal((await cl.query(sqlA, valoresA)).rowCount, 1);
    await n.revogarAcesso(adm, { usuarioId: ids.operador, acoes: [ACAO.REGISTRAR], justificativa: "Retira registrar (sintético)." });
    const [sqlB, valoresB] = contraparteNova();
    await recusa(cl.query(sqlB, valoresB), "42501");
    await cl.query("rollback");
  } finally {
    cl.release();
  }
});
