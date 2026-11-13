// Execução 07B — testes ADVERSARIAIS no PostgreSQL local isolado. Dados e identidades SINTÉTICOS.
//
// Cada ataque é feito com SQL "à mão" e os MESMOS privilégios do papel da aplicação (fv2_app) — nunca superusuário nem
// BYPASSRLS. Nenhuma concessão-fixture: só existem as concessões gravadas pelo próprio teste (provisionamento real +
// concessões pelo núcleo). Uma recusa da aplicação não basta: aqui é o BANCO que tem de recusar.
//
// O que estes testes NÃO provam: que o gateway real autentica pessoas. A autoridade é sintética (credencial local de
// teste). O banco só garante que a credencial da APLICAÇÃO, sozinha, não escolhe escopo, não cria sessão e não altera
// concessão.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO, criarNucleoFinanceiro, criarRepositorioPostgres } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ATESTANTE, ESCOPOS_PADRAO, ORG_A, ORG_B, TODAS, UNI_A, UNI_A2, UNI_B, USUARIO, autoridadeSintetica, ctx, montar, provisionarAdministrador, rejeita } from "./helpers/cenario.js";
import { abrirPool, comoAplicacao, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular(), timeout: 300000 };
const A = { organizacaoId: ORG_A, unidadeId: UNI_A };
const A2 = { organizacaoId: ORG_A, unidadeId: UNI_A2 };
const B = { organizacaoId: ORG_B, unidadeId: UNI_B };
const OPERADOR = "dddddddd-0000-4000-8000-000000000002";
const LEITOR = "dddddddd-0000-4000-8000-000000000001";
const ESTRANHO = "dddddddd-0000-4000-8000-000000000009";

const recusa = (promessa, ...codigos) => assert.rejects(promessa, (e) => {
  assert.ok(codigos.includes(e.code ?? e.codigo), `esperava ${codigos.join("/")}, veio ${e.code ?? e.codigo}: ${e.message}`);
  return true;
});

/** Cenário: administrador provisionado em A e em B; OPERADOR (sem conceder) e LEITOR (só ver) em A; uma conta em A e em B. */
async function cenario() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { ...A });
  await provisionarAdministrador(repositorio, { ...B });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true, cofre: m.cofre });
  const adm = ctx(ORG_A, UNI_A, TODAS);
  await n.concederAcesso(adm, { usuarioId: OPERADOR, acoes: [ACAO.VER, ACAO.REGISTRAR, ACAO.CONFIGURAR], justificativa: "Operação sintética." });
  await n.concederAcesso(adm, { usuarioId: LEITOR, acoes: [ACAO.VER], justificativa: "Leitura sintética." });
  const contaA = await m.nucleo.configurarContaFinanceira(adm, { tipo: "BANCARIA", nome: "Banco de A" });
  const contaB = await m.nucleo.configurarContaFinanceira(ctx(ORG_B, UNI_B, TODAS), { tipo: "BANCARIA", nome: "Banco de B" });
  const interno = await repositorio.interno();
  const autoridade = await interno.sessoes.autoridade();
  const dono = await interno.dono();
  const token = (usuarioId, escopo = A) => interno.sessoes.emitir({ ...escopo, usuarioId });
  const comToken = (t, fn) => comoAplicacao(interno, null, fn, { token: t });
  const concessaoDe = async (usuarioId, escopo = A) => (await dono.query("select * from fv2_concessao where organizacao_id = $1 and unidade_id = $2 and usuario_id = $3", [escopo.organizacaoId, escopo.unidadeId, usuarioId])).rows[0];
  return { repositorio, n, m, adm, contaA, contaB, interno, autoridade, dono, token, comToken, concessaoDe };
}

/** Linha de concessão no formato da função guardada (como a aplicação chamaria). */
function linhaDeConcessao({ id = randomUUID(), escopo = A, usuarioId, acoes, situacao = "ATIVA", ator, versao = 1, base = null }) {
  const agora = new Date().toISOString();
  return JSON.stringify({
    id: base?.id ?? id, organizacao_id: escopo.organizacaoId, unidade_id: escopo.unidadeId, versao,
    criado_em: base?.criado_em ?? agora, criado_por: base?.criado_por ?? ator, atualizado_em: agora, atualizado_por: ator,
    chave_idempotencia: `concessao:${usuarioId}`, impressao: null, extras: {}, usuario_id: usuarioId, acoes, situacao,
    concedido_por: ator, justificativa: "Tentativa direta (teste adversarial).",
  });
}

test("1, 2 — SQL direto não concede nem revoga: a aplicação não tem INSERT/UPDATE em concessão", pular, async () => {
  const { token, comToken, concessaoDe } = await cenario();
  const tAdm = await token(USUARIO);
  const leitor = await concessaoDe(LEITOR);
  // Mesmo o ADMINISTRADOR, com sessão válida, não escreve a tabela diretamente.
  await recusa(comToken(tAdm, (cl) => cl.query(`insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, usuario_id, acoes, situacao, concedido_por, justificativa)
    values ($1, $2, $3, 1, now(), $4, now(), $4, $5, '["financeiro_v2.homologar"]', 'ATIVA', $4, 'x')`, [randomUUID(), ORG_A, UNI_A, USUARIO, ESTRANHO])), "42501");
  await recusa(comToken(tAdm, (cl) => cl.query(`update fv2_concessao set acoes = '["financeiro_v2.ver","financeiro_v2.homologar"]', versao = versao + 1 where id = $1`, [leitor.id])), "42501");
  // 2: revogar pela função guardada SEM ter `conceder` (operador) é recusado no banco.
  const tOp = await token(OPERADOR);
  await recusa(comToken(tOp, (cl) => cl.query("select fv2_gravar_concessao($1::jsonb, $2)", [linhaDeConcessao({ base: leitor, usuarioId: LEITOR, acoes: [], situacao: "REVOGADA", ator: OPERADOR, versao: leitor.versao + 1 }), leitor.versao])), "FV032");
  assert.equal((await concessaoDe(LEITOR)).situacao, "ATIVA");
});

test("3, 4 — autoconcessão, ação não possuída, autoria falsa e concessão entre unidades: recusadas NO BANCO", pular, async () => {
  const { n, token, comToken, concessaoDe } = await cenario();
  const tAdm = await token(USUARIO);
  const tOp = await token(OPERADOR);
  const op = await concessaoDe(OPERADOR);
  // 3: o operador tenta se dar `conceder`; o administrador tenta alterar a própria concessão.
  await recusa(comToken(tOp, (cl) => cl.query("select fv2_gravar_concessao($1::jsonb, $2)", [linhaDeConcessao({ base: op, usuarioId: OPERADOR, acoes: [...op.acoes, ACAO.CONCEDER], ator: OPERADOR, versao: op.versao + 1 }), op.versao])), "FV030");
  const adm = await concessaoDe(USUARIO);
  await recusa(comToken(tAdm, (cl) => cl.query("select fv2_gravar_concessao($1::jsonb, $2)", [linhaDeConcessao({ base: adm, usuarioId: USUARIO, acoes: TODAS, ator: USUARIO, versao: adm.versao + 1 }), adm.versao])), "FV030");
  // Ação que o concedente não tem: um concedente LIMITADO (ver + conceder) tenta dar homologar.
  await n.concederAcesso(ctx(ORG_A, UNI_A, TODAS), { usuarioId: ESTRANHO, acoes: [ACAO.VER, ACAO.CONCEDER], justificativa: "Concedente limitado." });
  const tLimitado = await token(ESTRANHO);
  await recusa(comToken(tLimitado, (cl) => cl.query("select fv2_gravar_concessao($1::jsonb, null)", [linhaDeConcessao({ usuarioId: randomUUID(), acoes: [ACAO.VER, ACAO.HOMOLOGAR], ator: ESTRANHO })])), "FV034");
  // Autoria falsa: gravar "em nome" de outro usuário.
  await recusa(comToken(tAdm, (cl) => cl.query("select fv2_gravar_concessao($1::jsonb, null)", [linhaDeConcessao({ usuarioId: randomUUID(), acoes: [ACAO.VER], ator: ESTRANHO })])), "FV031");
  // 4: concessão para OUTRA unidade usando a sessão de A — e sem sessão na outra unidade.
  await recusa(comToken(tAdm, (cl) => cl.query("select fv2_gravar_concessao($1::jsonb, null)", [linhaDeConcessao({ escopo: A2, usuarioId: randomUUID(), acoes: [ACAO.VER], ator: USUARIO })])), "42501");
  await recusa(comToken(tAdm, (cl) => cl.query("select fv2_gravar_concessao($1::jsonb, null)", [linhaDeConcessao({ escopo: B, usuarioId: randomUUID(), acoes: [ACAO.VER], ator: USUARIO })])), "42501");
  await recusa(token(USUARIO, A2), "FV020"); // o administrador de A não tem concessão em A2: nem sessão existe
  // Pelo núcleo: mesmo com contexto alegando tudo, sem concessão gravada do concedente, nada é concedido.
  await rejeita(n.concederAcesso(ctx(ORG_A, UNI_A2, TODAS), { usuarioId: LEITOR, acoes: [ACAO.VER], justificativa: "x" }), CODIGO.PERMISSAO_INSUFICIENTE);
});

test("5, 6, 12 — identidade forjada, variáveis manipuladas e atalhos de autenticação não abrem nada", pular, async () => {
  const { contaA, contaB, token, comToken, interno, dono } = await cenario();
  const contar = (t, tabela = "fv2_conta") => comToken(t, async (cl) => (await cl.query(`select count(*)::int as n from ${tabela}`)).rows[0].n);
  // Sem sessão, token inventado, token "parecido": nada aparece e nada se grava.
  for (const t of [null, "", "x".repeat(64), "0".repeat(64)]) {
    assert.equal(await contar(t), 0);
    assert.equal(await contar(t, "fv2_concessao"), 0);
    await recusa(comToken(t, (cl) => cl.query("insert into fv2_contraparte (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, tipo, nome) values ($1, $2, $3, 1, now(), $4, now(), $4, 'FORNECEDOR', 'Forjado')", [randomUUID(), ORG_A, UNI_A, USUARIO])), "42501");
  }
  // As variáveis ANTIGAS de escopo não valem mais nada — nem sozinhas, nem junto de uma sessão válida de A.
  const comVariaveis = (t) => comToken(t, async (cl) => {
    await cl.query("select set_config('fv2.organizacao_id', $1, true), set_config('fv2.unidade_id', $2, true)", [ORG_B, UNI_B]);
    return (await cl.query("select id from fv2_conta")).rows.map((r) => r.id);
  });
  assert.deepEqual(await comVariaveis(null), []);
  assert.deepEqual(await comVariaveis(await token(USUARIO)), [contaA.id]);
  // Trocar o token no meio da transação por outro inventado: a partir dali, nada.
  const tA = await token(USUARIO);
  assert.deepEqual(await comToken(tA, async (cl) => {
    const antes = (await cl.query("select count(*)::int as n from fv2_conta")).rows[0].n;
    await cl.query("select set_config('fv2.sessao', 'forjado', true)");
    return [antes, (await cl.query("select count(*)::int as n from fv2_conta")).rows[0].n];
  }), [1, 0]);
  // 6: desligar RLS, assumir outro papel, criar objetos ou ler a tabela de sessões: o papel da aplicação não pode.
  await recusa(comToken(tA, (cl) => cl.query("set local row_security = off").then(() => cl.query("select count(*) from fv2_conta"))), "42501");
  await recusa(comToken(tA, (cl) => cl.query("alter table fv2_conta disable row level security")), "42501");
  await recusa(comToken(tA, (cl) => cl.query("alter table fv2_conta no force row level security")), "42501");
  await recusa(comToken(tA, (cl) => cl.query("set role fv2_autoridade")), "42501");
  await recusa(comToken(tA, (cl) => cl.query("set role fv2_guardiao")), "42501");
  await recusa(comToken(tA, (cl) => cl.query("select * from fv2_sessao_banco")), "42501");
  await recusa(comToken(tA, (cl) => cl.query("select * from fv2_auditoria_concessao")), "42501");
  await recusa(comToken(tA, (cl) => cl.query("create function fv2_atalho() returns int language sql as 'select 1'")), "42501");
  // 12: emitir sessão, sessão de provisionamento ou encerrar sessões alheias — só a autoridade.
  await recusa(comToken(tA, (cl) => cl.query("select fv2_abrir_sessao($1, $2, $3, 60, 'atalho')", [USUARIO, ORG_B, UNI_B])), "42501");
  await recusa(comToken(tA, (cl) => cl.query("select fv2_abrir_sessao_de_provisionamento($1, $2, $3, $4, '[\"financeiro_v2.ver\"]', 'aal2', 'x', 'y')", [ESTRANHO, USUARIO, ORG_B, UNI_B])), "42501");
  await recusa(comToken(tA, (cl) => cl.query("select fv2_encerrar_sessoes($1, $2, $3, 'x')", [USUARIO, ORG_B, UNI_B])), "42501");
  await recusa(comToken(tA, (cl) => cl.query("insert into fv2_sessao_banco (token_hash, usuario_id, organizacao_id, unidade_id, finalidade, pode_escrever, expira_em) values (sha256('x'), $1, $2, $3, 'OPERACAO', true, now() + interval '1 hour')", [USUARIO, ORG_B, UNI_B])), "42501");
  // Higiene das funções privilegiadas: dono = guardião, search_path fixo, sem EXECUTE para PUBLIC.
  const { rows: funcoes } = await dono.query(`select p.proname, pg_get_userbyid(p.proowner) as dono, p.prosecdef, p.proconfig,
      has_function_privilege('public', p.oid, 'execute') as publico, has_function_privilege('fv2_app', p.oid, 'execute') as app
      from pg_proc p where p.prosecdef and p.proname like 'fv2%' order by 1`);
  assert.deepEqual(funcoes.map((f) => f.proname), ["fv2__sessao_vigente", "fv2_abrir_sessao", "fv2_abrir_sessao_de_provisionamento", "fv2_encerrar_sessoes", "fv2_gravar_concessao"]);
  for (const f of funcoes) {
    assert.equal(f.dono, "fv2_guardiao", f.proname);
    assert.ok(f.proconfig?.some((c) => c.startsWith("search_path=pg_catalog")), f.proname);
    assert.equal(f.publico, false, f.proname);
  }
  assert.deepEqual(funcoes.filter((f) => f.app).map((f) => f.proname), ["fv2__sessao_vigente", "fv2_gravar_concessao"]);
  const { rows: [papeis] } = await dono.query(`select (select rolbypassrls from pg_roles where rolname = 'fv2_app') as app_bypass,
      (select rolbypassrls from pg_roles where rolname = 'fv2_guardiao') as guardiao_bypass,
      (select rolcanlogin from pg_roles where rolname = 'fv2_guardiao') as guardiao_login,
      (select count(*)::int from pg_auth_members m join pg_roles r on r.oid = m.roleid where r.rolname = 'fv2_guardiao') as membros_guardiao,
      has_schema_privilege('fv2_app', current_schema(), 'CREATE') as app_cria`);
  assert.deepEqual(papeis, { app_bypass: false, guardiao_bypass: false, guardiao_login: false, membros_guardiao: 0, app_cria: false });
  assert.ok(contaB.id && interno.pool);
});

test("7, 8 — conexão reutilizada não carrega a sessão anterior; falha no meio não deixa efeito", pular, async () => {
  const { contaA, contaB, token, interno, n } = await cenario();
  const umaConexao = await abrirPool(interno.urlApp, { max: 1 });
  const tA = await token(USUARIO);
  const tB = await token(USUARIO, B);
  const ids = async (cl) => (await cl.query("select id from fv2_conta")).rows.map((r) => r.id);
  const cl = await umaConexao.connect();
  try {
    // Sessão de A declarada no nível da CONEXÃO (como um código descuidado faria) e devolvida ao pool.
    await cl.query("select set_config('fv2.sessao', $1, false)", [tA]);
    assert.deepEqual(await ids(cl), [contaA.id]);
  } finally {
    cl.release();
  }
  const cl2 = await umaConexao.connect(); // a MESMA conexão física (pool de 1)
  try {
    await cl2.query("begin");
    await cl2.query("select fv2_assumir_sessao($1)", [tB]); // a próxima transação de outro escopo limpa o valor da conexão
    assert.deepEqual(await ids(cl2), [contaB.id]);
    await cl2.query("commit");
    assert.deepEqual(await ids(cl2), [], "depois da transação, a conexão volta sem sessão");
    // Erro no meio de uma transação: rollback, e a conexão volta sem sessão nem efeito.
    await cl2.query("begin");
    await cl2.query("select fv2_assumir_sessao($1)", [tA]);
    await cl2.query("update fv2_conta set nome = 'meio caminho', versao = versao + 1 where id = $1", [contaA.id]);
    await assert.rejects(cl2.query("select 1/0"));
    await cl2.query("rollback");
    assert.deepEqual(await ids(cl2), []);
  } finally {
    cl2.release();
  }
  assert.equal((await n.consultarRegistros(ctx(ORG_A, UNI_A, TODAS), { tipo: "CONTA" }))[0].nome, "Banco de A");
  // Pelo adaptador: operação que falha depois de gravar não deixa nada.
  await assert.rejects(interno.repo.transacao(async (tx) => {
    await tx.anexarHistorico({ id: randomUUID(), organizacaoId: ORG_A, unidadeId: UNI_A, registroTipo: "CONTA", registroId: contaA.id, evento: "CORRECAO", antes: null, depois: null, justificativa: "meio", usuarioId: USUARIO, em: AGORA.toISOString() });
    throw new Error("falha no meio");
  }, { escopo: { ...A, usuarioId: USUARIO } }), /falha no meio/);
  const hist = await n.consultarHistorico(ctx(ORG_A, UNI_A, TODAS), { registroTipo: "CONTA", registroId: contaA.id });
  assert.ok(hist.every((h) => h.justificativa !== "meio"));
  // Mesma pessoa em duas unidades ao mesmo tempo: cada transação enxerga só a própria.
  const [emA, emB] = await Promise.all([
    interno.repo.leitura((tx) => tx.listar({ ...A, usuarioId: USUARIO }, "CONTA"), { escopo: { ...A, usuarioId: USUARIO } }),
    interno.repo.leitura((tx) => tx.listar({ ...B, usuarioId: USUARIO }, "CONTA"), { escopo: { ...B, usuarioId: USUARIO } }),
  ]);
  assert.deepEqual([emA.map((c) => c.id), emB.map((c) => c.id)], [[contaA.id], [contaB.id]]);
  // Pedir o escopo B com a lista de registros de A (escopo do comando ≠ escopo da sessão) não traz nada de A.
  assert.deepEqual(await interno.repo.leitura((tx) => tx.listar({ ...A, usuarioId: USUARIO }, "CONTA"), { escopo: { ...B, usuarioId: USUARIO } }), []);
});

test("9 — revogação vale na próxima ação e corta a transação em andamento; concorrência não escala privilégio", pular, async () => {
  const { n, contaA, token, comToken, interno, dono, adm } = await cenario();
  const ctxOp = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.REGISTRAR, ACAO.CONFIGURAR], OPERADOR);
  await n.registrarContraparte(ctxOp, { tipo: "FORNECEDOR", nome: "Antes da revogação" }); // o adaptador guardou o token
  const tOp = await token(OPERADOR);
  // Transação do operador EM ANDAMENTO: lê, depois a revogação é gravada, depois tenta continuar.
  const cl = await interno.pool.connect();
  try {
    await cl.query("begin");
    await cl.query("select fv2_assumir_sessao($1)", [tOp]);
    assert.equal((await cl.query("select count(*)::int as n from fv2_conta")).rows[0].n, 1);
    await n.revogarAcesso(adm, { usuarioId: OPERADOR, justificativa: "Desligamento (sintético)." });
    assert.equal((await cl.query("select count(*)::int as n from fv2_conta")).rows[0].n, 0, "a sessão revogada deixa de ver no MESMO instante");
    await recusa(cl.query("update fv2_conta set nome = 'depois', versao = versao + 1 where id = $1 returning id", [contaA.id]).then((r) => { if (!r.rowCount) { const e = new Error("nada alterado"); e.code = "42501"; throw e; } }), "42501");
    await cl.query("rollback");
  } finally {
    cl.release();
  }
  // Próxima ação pelo núcleo (token antigo em cache): o banco recusa a sessão e a autoridade não emite outra.
  await rejeita(n.registrarContraparte(ctxOp, { tipo: "FORNECEDOR", nome: "Depois da revogação" }), CODIGO.PERMISSAO_INSUFICIENTE);
  await recusa(comToken(tOp, async (cl2) => { if ((await cl2.query("select count(*)::int as n from fv2_conta")).rows[0].n !== 0) throw Object.assign(new Error("viu"), { code: "VIU" }); throw Object.assign(new Error("ok"), { code: "NADA" }); }), "NADA");
  const { rows: sessoes } = await dono.query("select count(*)::int as n from fv2_sessao_banco where usuario_id = $1 and revogada_em is null", [OPERADOR]);
  assert.equal(sessoes[0].n, 0, "todas as sessões de banco do revogado foram encerradas");

  // Concorrência: enquanto o administrador retira `conceder` de um gestor, o gestor tenta conceder `registrar` a terceiros.
  const GESTOR = "dddddddd-0000-4000-8000-000000000007";
  for (let rodada = 0; rodada < 6; rodada += 1) {
    await n.concederAcesso(adm, { usuarioId: GESTOR, acoes: [ACAO.VER, ACAO.CONCEDER, ACAO.REGISTRAR], justificativa: `Gestor rodada ${rodada}.` });
    const ctxGestor = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.CONCEDER, ACAO.REGISTRAR], GESTOR);
    const alvo = randomUUID();
    await Promise.allSettled([
      n.revogarAcesso(adm, { usuarioId: GESTOR, acoes: [ACAO.CONCEDER], justificativa: "Retira conceder." }),
      n.concederAcesso(ctxGestor, { usuarioId: alvo, acoes: [ACAO.VER, ACAO.REGISTRAR], justificativa: "Corrida." }),
    ]);
    // Invariante: toda concessão FEITA pelo gestor foi gravada ANTES da retirada do `conceder` dele (ordem real, sequência do banco).
    const { rows } = await dono.query(`select seq, ator, usuario_alvo, operacao from fv2_auditoria_concessao where organizacao_id = $1 and unidade_id = $2 and (ator = $3 or usuario_alvo = $3) order by seq`, [ORG_A, UNI_A, GESTOR]);
    const retirada = rows.filter((r) => r.usuario_alvo === GESTOR && r.operacao === "REVOGACAO").at(-1);
    assert.ok(retirada, "a retirada foi gravada");
    assert.deepEqual(rows.filter((r) => r.ator === GESTOR && Number(r.seq) > Number(retirada.seq)), [], `rodada ${rodada}: concessão gravada depois da retirada`);
  }
});

test("10, 11 — provisionamento: repetido recusado; sem MFA recusado; atestante não recebe acesso nem enxerga dados", pular, async () => {
  const { repositorio, token, autoridade, dono, comToken } = await cenario();
  // 10: A já tem administrador → núcleo e banco recusam um segundo provisionamento inicial.
  await rejeita(provisionarAdministrador(repositorio, { ...A, usuarioId: ESTRANHO }), CODIGO.PROVISIONAMENTO_RECUSADO);
  await recusa(autoridade.query("select fv2_abrir_sessao_de_provisionamento($1, $2, $3, $4, '[\"financeiro_v2.ver\"]', 'aal2', 'x', 'y')", [ATESTANTE, ESTRANHO, ORG_A, UNI_A]), "FV021");
  // 11: sem MFA (aal1) — pelo núcleo e direto na autoridade do banco; atestante = alvo também não.
  const semMfa = autoridadeSintetica({ nivelAutenticacao: "aal1" });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, autoridadeDeProvisionamento: semMfa });
  const ato = { ...A2, usuarioId: ESTRANHO, acoes: [ACAO.VER, ACAO.CONCEDER], justificativa: "x", evidencia: "y" };
  await rejeita(n.provisionarAdministradorInicial({ ...ato, atestado: semMfa.assinar(ato) }), CODIGO.PROVISIONAMENTO_RECUSADO);
  await recusa(autoridade.query("select fv2_abrir_sessao_de_provisionamento($1, $2, $3, $4, '[\"financeiro_v2.ver\"]', 'aal1', 'x', 'y')", [ATESTANTE, ESTRANHO, ORG_A, UNI_A2]), "FV021");
  await recusa(autoridade.query("select fv2_abrir_sessao_de_provisionamento($1, $2, $3, $4, '[\"financeiro_v2.ver\"]', 'aal2', 'x', 'y')", [ESTRANHO, ESTRANHO, ORG_A, UNI_A2]), "FV021");
  await recusa(autoridade.query("select fv2_abrir_sessao_de_provisionamento($1, $2, $3, $4, '[\"financeiro_v2.ver\"]', 'aal2', '', 'y')", [ATESTANTE, ESTRANHO, ORG_A, UNI_A2]), "FV021");
  // A sessão de provisionamento (legítima, em A2) não enxerga dados financeiros, não grava fora da concessão atestada
  // e não concede nada a outra pessoa nem ações diferentes das atestadas.
  const { rows: [{ t }] } = await autoridade.query("select fv2_abrir_sessao_de_provisionamento($1, $2, $3, $4, '[\"financeiro_v2.conceder\",\"financeiro_v2.ver\"]', 'aal2', 'Primeiro administrador.', 'Ato sintético') as t", [ATESTANTE, ESTRANHO, ORG_A, UNI_A2]);
  await dono.query("insert into fv2_conta (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, tipo, nome, ativa) select $1, $2, $3, 1, now(), $4, now(), $4, 'BANCARIA', 'Conta de A2', true", [randomUUID(), ORG_A, UNI_A2, USUARIO]).catch(() => {});
  assert.equal(await comToken(t, async (cl) => (await cl.query("select count(*)::int as n from fv2_conta")).rows[0].n), 0);
  await recusa(comToken(t, (cl) => cl.query("insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, usuario_id, em) values ($1, $2, $3, 'CONTA', $1, 'CRIACAO', $4, now())", [randomUUID(), ORG_A, UNI_A2, ATESTANTE])), "42501");
  await recusa(comToken(t, (cl) => cl.query("select fv2_gravar_concessao($1::jsonb, null)", [linhaDeConcessao({ escopo: A2, usuarioId: ATESTANTE, acoes: [ACAO.CONCEDER, ACAO.VER], ator: ATESTANTE })])), "FV030");
  await recusa(comToken(t, (cl) => cl.query("select fv2_gravar_concessao($1::jsonb, null)", [linhaDeConcessao({ escopo: A2, usuarioId: LEITOR, acoes: [ACAO.CONCEDER, ACAO.VER], ator: ATESTANTE })])), "FV035");
  await recusa(comToken(t, (cl) => cl.query("select fv2_gravar_concessao($1::jsonb, null)", [linhaDeConcessao({ escopo: A2, usuarioId: ESTRANHO, acoes: TODAS, ator: ATESTANTE })])), "FV035");
  // O atestante nunca ganha sessão operacional (não tem concessão).
  await recusa(token(ATESTANTE, A2), "FV020");
  await recusa(token(ATESTANTE, A), "FV020");
  // Trilha: o provisionamento legítimo de A ficou registrado e concluído, com nível aal2 e evidência.
  const { rows: prov } = await dono.query("select atestante_id, usuario_id, nivel_autenticacao, concluido_em is not null as concluido from fv2_provisionamento_inicial where organizacao_id = $1 and unidade_id = $2", [ORG_A, UNI_A]);
  assert.deepEqual(prov, [{ atestante_id: ATESTANTE, usuario_id: USUARIO, nivel_autenticacao: "aal2", concluido: true }]);
  // Auditoria das concessões: só inclusão, inclusive para o dono do banco.
  await recusa(dono.query("update fv2_auditoria_concessao set justificativa = 'apagado'"), "FV040");
  await recusa(dono.query("delete from fv2_auditoria_concessao"), "FV040");
});

test("13, 14, 15 — outra organização, outra unidade e documento fora do escopo: recusados no banco", pular, async () => {
  const { m, contaA, contaB, token, comToken, adm } = await cenario();
  const tA = await token(USUARIO);
  const tLeitor = await token(LEITOR);
  // 13: leitura pelo id exato de outra organização.
  assert.deepEqual(await comToken(tA, async (cl) => (await cl.query("select id from fv2_conta where id = $1", [contaB.id])).rows), []);
  // 14: escrita em outra unidade — linha carimbada com o escopo alheio e alteração por id.
  await recusa(comToken(tA, (cl) => cl.query("insert into fv2_contraparte (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, tipo, nome) values ($1, $2, $3, 1, now(), $4, now(), $4, 'FORNECEDOR', 'Invasor')", [randomUUID(), ORG_B, UNI_B, USUARIO])), "42501");
  assert.equal(await comToken(tA, async (cl) => (await cl.query("update fv2_conta set nome = 'invadida', versao = versao + 1 where id = $1", [contaB.id])).rowCount), 0);
  // Quem só tem `ver` lê, mas não grava nada no banco (nem na própria unidade).
  assert.equal(await comToken(tLeitor, async (cl) => (await cl.query("select count(*)::int as n from fv2_conta")).rows[0].n), 1);
  assert.equal(await comToken(tLeitor, async (cl) => (await cl.query("update fv2_conta set nome = 'leitor', versao = versao + 1 where id = $1", [contaA.id])).rowCount), 0);
  // 15: documento de B não é visível nem pelo id para a sessão de A; pelo núcleo, "não encontrado".
  const g = await m.cofre.guardar(ctx(ORG_B, UNI_B, TODAS), { conteudo: new TextEncoder().encode("%PDF-1.4\n%%EOF\n"), tipoMime: "application/pdf" });
  const docB = (await m.nucleo.registrarDocumento(ctx(ORG_B, UNI_B, TODAS), { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-09-15", descricao: "Documento sintético de B" })).documento;
  assert.deepEqual(await comToken(tA, async (cl) => (await cl.query("select id from fv2_documento where id = $1", [docB.id])).rows), []);
  assert.deepEqual(await comToken(tA, async (cl) => (await cl.query("select id from fv2_vinculo_documental")).rows), []);
  await rejeita(m.nucleo.obterArquivoDoDocumento(adm, { id: docB.id, finalidade: "BAIXAR" }), CODIGO.NAO_ENCONTRADO);
});

test("adaptador: token de outro usuário ou unidade entregue pela autoridade é recusado (o banco confere a identidade)", pular, async () => {
  const { interno, token } = await cenario();
  const tokenDeB = await token(USUARIO, B);
  const trocada = criarRepositorioPostgres({ pool: interno.pool, sessoes: { emitir: async () => tokenDeB } });
  await rejeita(trocada.leitura((tx) => tx.listar({ ...A, usuarioId: USUARIO }, "CONTA"), { escopo: { ...A, usuarioId: USUARIO } }), CODIGO.PERMISSAO_INSUFICIENTE);
  const tokenDoLeitor = await token(LEITOR);
  const outraPessoa = criarRepositorioPostgres({ pool: interno.pool, sessoes: { emitir: async () => tokenDoLeitor } });
  await rejeita(outraPessoa.transacao(async () => 1, { escopo: { ...A, usuarioId: USUARIO } }), CODIGO.PERMISSAO_INSUFICIENTE);
});
