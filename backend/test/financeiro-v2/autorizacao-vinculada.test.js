// 27/11 (PR #236) — AUTORIZAÇÃO VINCULADA À OPERAÇÃO ENTRE EMPRESAS, de ponta a ponta num PostgreSQL REAL e isolado:
// autoridade co-localizada (mesmo emissor do gateway) + verificador de MFA real (HS256 de referência) + repositório PostgreSQL
// + migrações reais (RLS, gatilhos, funções guardadas). Dados SINTÉTICOS. Nada aqui toca produção.
//
// O que se prova:
//   - sem vínculo, a sessão de uma unidade NÃO alcança a outra (o antigo CONTRAPARTE_SEM_SESSAO) e nada é gravado;
//   - com vínculo, a MESMA pessoa (concessão nas duas empresas) com 2º fator RECENTE grava os dois lados numa transação;
//   - a sessão vinculada é RESTRITA (ver + registrar_intercompany), presa à chave e auditada; nunca é reaproveitada;
//   - sem MFA, com MFA antigo ou sem a ação na outra empresa ⇒ recusa e NADA gravado (rollback dos dois lados);
//   - as duas direções; reembolso vinculado; reembolso de outra chave recusado.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ACAO, CODIGO, criarNucleoFinanceiro, criarRepositorioPostgres, criarVerificadorDeMfa, verificadorHs256 } from "../../src/modules/financeiro-v2/index.js";
import { criarAutoridadeCoLocalizada } from "../../src/modules/fv2-integracao/autoridadeCoLocalizada.js";
import { criarEmissorDeSessoes } from "../../src/modules/fv2-integracao/emissorDeSessoes.js";
import { comIdentidadeDaRequisicao } from "../../src/modules/fv2-integracao/clienteGateway.js";
import { AGORA, ORG_A, ORG_B, TODAS, UNI_A, UNI_B, obrigacao } from "./helpers/cenario.js";
import { abrirPool, criarBancoDeTeste, motivoParaPular } from "./helpers/postgres.js";

const PULAR = motivoParaPular();
const SEGREDO = "segredo-sintetico-de-teste-com-mais-de-32-caracteres";
const CONTA = "c0c0c0c0-0000-4000-8000-0000000000c1";
const PESSOA = "d0d0d0d0-0000-4000-8000-0000000000d1";
const CONTA_Q = "c0c0c0c0-0000-4000-8000-0000000000c2";
const PESSOA_Q = "d0d0d0d0-0000-4000-8000-0000000000d2";
const AUTOR = "f1f1f1f1-0000-4000-8000-0000000000f1";
const VALOR = 649560;
const ESCOPOS = [{ organizacaoId: ORG_A, unidadeId: UNI_A }, { organizacaoId: ORG_B, unidadeId: UNI_B }];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt({ sub = CONTA, aal = "aal2", fatorHaS = 60 } = {}) {
  const agora = Math.floor(Date.now() / 1000);
  const corpo = { sub, aal, iat: agora - 5, exp: agora + 3600, amr: aal === "aal2" ? [{ method: "totp", timestamp: agora - fatorHaS }] : [{ method: "password", timestamp: agora - 5 }] };
  const base = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(corpo)}`;
  return `${base}.${createHmac("sha256", SEGREDO).update(base).digest("base64url")}`;
}
const sessaoDaPlataforma = (organizacaoId, unidadeId, { conta = CONTA, pessoa = PESSOA } = {}) => ({
  user: { id: conta, ativo: true, senhaProvisoria: false },
  tenant: { organizacaoId, unidadeId },
  acesso: { sessionId: `s-${unidadeId.slice(-4)}`, expiraEm: new Date(Date.now() + 3600_000).toISOString(), perfilId: pessoa, papel: "FINANCEIRO", impersonando: false },
});
const ctx = (organizacaoId, unidadeId, pessoa = PESSOA) => ({ organizacaoId, unidadeId, usuarioId: pessoa, permissoes: TODAS });

let amb;
async function iniciar() {
  const { urlApp, urlAdmin, urlAutoridade } = await criarBancoDeTeste(ESCOPOS);
  const pool = await abrirPool(urlApp);
  const poolAutoridade = await abrirPool(urlAutoridade, { max: 4 });
  const dono = await abrirPool(urlAdmin, { max: 2 });
  const verificar = verificadorHs256(SEGREDO);
  const deps = { poolAutoridade, obterUsuario: async (t) => { const p = verificar(t); return p ? { id: p.sub } : null; }, mfa: criarVerificadorDeMfa({ verificarAssinatura: verificar }) };
  const repositorio = criarRepositorioPostgres({ pool, sessoes: criarAutoridadeCoLocalizada(deps) });
  const nucleo = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS, relogio: () => AGORA, exigirConcessaoPersistida: true });
  const conceder = (organizacaoId, unidadeId, usuarioId, acoes) => dono.query(`with nova as (
      insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por,
                                 chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
      values (gen_random_uuid(), $1::uuid, $2::uuid, 1, now(), $4::uuid, now(), $4::uuid, 'concessao:' || $3, null, '{}'::jsonb,
              $3::uuid, $5::jsonb, 'ATIVA', $4::uuid, 'Fixture sintética da autorização vinculada.') returning *)
    insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
    select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'CRIACAO', null, jsonb_build_object('versao', 1, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from nova`,
  [organizacaoId, unidadeId, usuarioId, AUTOR, JSON.stringify([...new Set(acoes)].sort())]);
  await conceder(ORG_A, UNI_A, PESSOA, TODAS);
  await conceder(ORG_B, UNI_B, PESSOA, TODAS);
  // Q: tudo em A; em B, aprova e aplica, mas SEM registrar_intercompany
  await conceder(ORG_A, UNI_A, PESSOA_Q, TODAS);
  await conceder(ORG_B, UNI_B, PESSOA_Q, TODAS.filter((a) => a !== ACAO.REGISTRAR_INTERCOMPANY));
  // preparação: plano de contas em cada empresa (com a sessão da própria unidade, como a pessoa faria)
  for (const e of ESCOPOS) await comIdentidadeDaRequisicao({ tokenDeAcesso: jwt(), sessao: sessaoDaPlataforma(e.organizacaoId, e.unidadeId), contaPessoal: true, finalidade: "OPERACAO" },
    () => nucleo.implantarPlanoDeContas(ctx(e.organizacaoId, e.unidadeId), { modelo: "ACAITERIA" }));
  return { pool, poolAutoridade, dono, nucleo, emissor: criarEmissorDeSessoes(deps) };
}

/** Roda `fn` como a rota faria: identidade da requisição (sessão da unidade ativa) e, se houver, o vínculo da operação. */
const como = (sessao, fn, { token = jwt(), vinculo = null } = {}) =>
  comIdentidadeDaRequisicao({ tokenDeAcesso: token, sessao, contaPessoal: true, finalidade: "OPERACAO", ...(vinculo ? { vinculo } : {}) }, fn);
const pagamento = (x = {}) => ({ valorCentavos: VALOR, dataPagamento: "2026-10-10", descricao: "Distribuidora paga pela outra empresa (sintético)", nomeDevedora: "Açaí Sintético", nomeCredora: "Subway Sintética", ...x });

async function contaEmAberto(org, uni, sufixo) {
  const s = sessaoDaPlataforma(org, uni);
  return como(s, async () => {
    const f = await amb.nucleo.registrarContraparte(ctx(org, uni), { tipo: "FORNECEDOR", nome: `Distribuidora ${sufixo}` });
    return (await amb.nucleo.registrarObrigacao(ctx(org, uni), obrigacao(f.id, { valorOriginalCentavos: VALOR, competencia: "2026-10", dataEmissao: "2026-10-05", vencimento: "2026-10-10", descricao: `Compra ${sufixo} (sintético)`, fonte: { sistema: "MANUAL", idExterno: `AV:${sufixo}` } }))).obrigacoes[0];
  });
}
const linhas = async (chave) => (await amb.dono.query("select organizacao_id::text o, papel from fv2_intercompany where chave_idempotencia like $1 order by papel", [`intercompany:${chave}:%`])).rows;
const liquidacoesDe = async (obrigacaoId) => (await amb.dono.query("select count(*)::int n from fv2_liquidacao where alvo_id = $1", [obrigacaoId])).rows[0].n;

before(async () => { if (!PULAR) amb = await iniciar(); });

test("AV-1 sem vínculo: a sessão da unidade ativa NÃO alcança a outra empresa — nada gravado em nenhuma", { skip: PULAR, timeout: 120000 }, async () => {
  const ob = await contaEmAberto(ORG_A, UNI_A, "av1");
  await assert.rejects(como(sessaoDaPlataforma(ORG_A, UNI_A), () => amb.nucleo.registrarPagamentoPorOutraEmpresa(ctx(ORG_A, UNI_A), ctx(ORG_B, UNI_B), pagamento({ obrigacaoId: ob.id, chave: "AV:1" }))));
  assert.deepEqual(await linhas("AV:1"), []);
  assert.equal(await liquidacoesDe(ob.id), 0);
});

test("AV-2 com vínculo: mesma pessoa + 2º fator recente grava os DOIS lados; auditoria aal2 presa à chave; sessão restrita", { skip: PULAR, timeout: 120000 }, async () => {
  const ob = await contaEmAberto(ORG_A, UNI_A, "av2");
  const vinculo = { organizacaoId: ORG_B, unidadeId: UNI_B, chave: "AV:2", propostaId: "a2a2a2a2-0000-4000-8000-0000000000a2" };
  const r = await como(sessaoDaPlataforma(ORG_A, UNI_A), () => amb.nucleo.registrarPagamentoPorOutraEmpresa(ctx(ORG_A, UNI_A), ctx(ORG_B, UNI_B), pagamento({ obrigacaoId: ob.id, chave: "AV:2" })), { vinculo });
  assert.deepEqual([r.titulo.situacao, r.liquidacao.movimentacaoId, r.devedora.vinculoId === r.credora.vinculoId], ["QUITADA", null, true]);
  assert.deepEqual((await linhas("AV:2")).map((x) => [x.o, x.papel]), [[ORG_B, "CREDORA"], [ORG_A, "DEVEDORA"]]);
  const { rows: [a] } = await amb.dono.query("select * from fv2_autorizacao_vinculada where chave = 'AV:2'");
  assert.deepEqual([a.usuario_id, a.organizacao_id, a.unidade_id, a.principal_organizacao_id, a.principal_unidade_id, a.finalidade, a.nivel_autenticacao, a.proposta_id],
    [PESSOA, ORG_B, UNI_B, ORG_A, UNI_A, "INTERCOMPANY", "aal2", vinculo.propostaId]);
  assert.ok(a.expira_em - a.emitida_em <= 121_000, "validade curta (≤ 120 s)");
  const { rows: [s] } = await amb.dono.query("select acoes_autorizadas, finalidade from fv2_sessao_banco where id = $1", [a.sessao_id]);
  assert.deepEqual([s.finalidade, s.acoes_autorizadas], ["OPERACAO", ["financeiro_v2.registrar_intercompany", "financeiro_v2.ver"]]);
  // repetir não duplica nada (idempotência pela chave), nem com nova autorização
  const r2 = await como(sessaoDaPlataforma(ORG_A, UNI_A), () => amb.nucleo.registrarPagamentoPorOutraEmpresa(ctx(ORG_A, UNI_A), ctx(ORG_B, UNI_B), pagamento({ obrigacaoId: ob.id, chave: "AV:2" })), { vinculo });
  assert.equal(r2.repetido, true);
  assert.equal((await linhas("AV:2")).length, 2);
  assert.equal(await liquidacoesDe(ob.id), 1);
});

test("AV-3 a sessão vinculada é ESTREITA mesmo com concessão ampla: sem registrar/corrigir, só a chave dela; auditoria imutável", { skip: PULAR, timeout: 120000 }, async () => {
  const obB = await contaEmAberto(ORG_B, UNI_B, "av3");
  const r = await amb.emissor.emitirSessaoVinculada({ sessao: sessaoDaPlataforma(ORG_A, UNI_A), contaPessoal: true, token: jwt(),
    escopo: { organizacaoId: ORG_B, unidadeId: UNI_B, usuarioId: PESSOA }, vinculo: { organizacaoId: ORG_B, unidadeId: UNI_B, chave: "AV:3" } });
  assert.equal(r.ok, true);
  const cl = await amb.pool.connect();
  try {
    await cl.query("begin");
    await cl.query("select fv2_assumir_sessao($1)", [r.token]);
    const { rows: [v] } = await cl.query("select fv2_tem_acao(array['financeiro_v2.registrar']) amplo, fv2_tem_acao(array['financeiro_v2.corrigir','financeiro_v2.cancelar']) corrigir, fv2_tem_acao(array['financeiro_v2.registrar_intercompany']) estreito, fv2__chave_vinculada() chave");
    assert.deepEqual([v.amplo, v.corrigir, v.estreito, v.chave], [false, false, true, "AV:3"]);
    await assert.rejects(cl.query("update fv2_obrigacao set descricao = 'alterada', versao = versao + 1 where id = $1", [obB.id]));
  } finally { await cl.query("rollback").catch(() => {}); cl.release(); }
  await assert.rejects(amb.dono.query("update fv2_autorizacao_vinculada set chave = 'outra' where chave = 'AV:3'"), /não se altera/);
  await assert.rejects(amb.dono.query("delete from fv2_autorizacao_vinculada where chave = 'AV:3'"));
});

test("AV-4 sem 2º fator, com 2º fator ANTIGO, ou para a própria unidade ⇒ recusa; nada gravado (rollback dos dois lados)", { skip: PULAR, timeout: 120000 }, async () => {
  const ob = await contaEmAberto(ORG_A, UNI_A, "av4");
  const vinculo = { organizacaoId: ORG_B, unidadeId: UNI_B, chave: "AV:4" };
  const tentar = (token) => como(sessaoDaPlataforma(ORG_A, UNI_A), () => amb.nucleo.registrarPagamentoPorOutraEmpresa(ctx(ORG_A, UNI_A), ctx(ORG_B, UNI_B), pagamento({ obrigacaoId: ob.id, chave: "AV:4" })), { vinculo, token });
  await assert.rejects(tentar(jwt({ aal: "aal1" })));
  await assert.rejects(tentar(jwt({ fatorHaS: 11 * 60 })));
  await assert.rejects(tentar(jwt({ sub: CONTA_Q })), "token de outra conta");
  assert.deepEqual(await linhas("AV:4"), []);
  assert.equal(await liquidacoesDe(ob.id), 0);
  assert.equal((await amb.dono.query("select count(*)::int n from fv2_autorizacao_vinculada where chave = 'AV:4'")).rows[0].n, 0);
  const propria = await amb.emissor.emitirSessaoVinculada({ sessao: sessaoDaPlataforma(ORG_A, UNI_A), contaPessoal: true, token: jwt(), escopo: { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: PESSOA }, vinculo: { organizacaoId: ORG_A, unidadeId: UNI_A, chave: "AV:4p" } });
  assert.deepEqual([propria.ok, propria.motivo], [false, "VINCULO_PARA_A_PROPRIA_UNIDADE"]);
  const outraPessoa = await amb.emissor.emitirSessaoVinculada({ sessao: sessaoDaPlataforma(ORG_A, UNI_A), contaPessoal: true, token: jwt(), escopo: { organizacaoId: ORG_B, unidadeId: UNI_B, usuarioId: PESSOA_Q }, vinculo: { organizacaoId: ORG_B, unidadeId: UNI_B, chave: "AV:4q" } });
  assert.deepEqual([outraPessoa.ok, outraPessoa.motivo], [false, "ESCOPO_DIFERENTE_DO_VINCULO"]);
  const compartilhada = await amb.emissor.emitirSessaoVinculada({ sessao: sessaoDaPlataforma(ORG_A, UNI_A), contaPessoal: false, token: jwt(), escopo: { organizacaoId: ORG_B, unidadeId: UNI_B, usuarioId: PESSOA }, vinculo: { organizacaoId: ORG_B, unidadeId: UNI_B, chave: "AV:4c" } });
  assert.deepEqual([compartilhada.ok, compartilhada.motivo], [false, "CONTA_COMPARTILHADA"]);
});

test("AV-5 sem registrar_intercompany na OUTRA empresa ⇒ o BANCO recusa a autorização (FV020) e nada fica gravado", { skip: PULAR, timeout: 120000 }, async () => {
  const s = sessaoDaPlataforma(ORG_A, UNI_A, { conta: CONTA_Q, pessoa: PESSOA_Q });
  const ob = await como(s, async () => {
    const f = await amb.nucleo.registrarContraparte(ctx(ORG_A, UNI_A, PESSOA_Q), { tipo: "FORNECEDOR", nome: "Distribuidora av5" });
    return (await amb.nucleo.registrarObrigacao(ctx(ORG_A, UNI_A, PESSOA_Q), obrigacao(f.id, { valorOriginalCentavos: VALOR, competencia: "2026-10", dataEmissao: "2026-10-05", vencimento: "2026-10-10", descricao: "Compra av5 (sintético)" }))).obrigacoes[0];
  }, { token: jwt({ sub: CONTA_Q }) });
  const r = await amb.emissor.emitirSessaoVinculada({ sessao: s, contaPessoal: true, token: jwt({ sub: CONTA_Q }), escopo: { organizacaoId: ORG_B, unidadeId: UNI_B, usuarioId: PESSOA_Q }, vinculo: { organizacaoId: ORG_B, unidadeId: UNI_B, chave: "AV:5" } });
  assert.deepEqual([r.ok, r.motivo, r.codigoBanco], [false, "BANCO_RECUSOU", "FV020"]);
  const qB = { ...ctx(ORG_B, UNI_B, PESSOA_Q), permissoes: TODAS };
  await assert.rejects(como(s, () => amb.nucleo.registrarPagamentoPorOutraEmpresa(ctx(ORG_A, UNI_A, PESSOA_Q), qB, pagamento({ obrigacaoId: ob.id, chave: "AV:5" })), { token: jwt({ sub: CONTA_Q }), vinculo: { organizacaoId: ORG_B, unidadeId: UNI_B, chave: "AV:5" } }));
  assert.deepEqual(await linhas("AV:5"), []);
  assert.equal(await liquidacoesDe(ob.id), 0);
});

test("AV-6 direção INVERSA (sessão na B, a A pagou): mesmas regras; reembolso vinculado parcial e integral; reembolso de OUTRA chave recusado sem gravar", { skip: PULAR, timeout: 120000 }, async () => {
  const ob = await contaEmAberto(ORG_B, UNI_B, "av6");
  const sB = sessaoDaPlataforma(ORG_B, UNI_B);
  const pg = (chave) => ({ organizacaoId: ORG_A, unidadeId: UNI_A, chave });
  const r = await como(sB, () => amb.nucleo.registrarPagamentoPorOutraEmpresa(ctx(ORG_B, UNI_B), ctx(ORG_A, UNI_A), pagamento({ obrigacaoId: ob.id, chave: "AV:6", nomeDevedora: "Subway Sintética", nomeCredora: "Açaí Sintético" })), { vinculo: pg("AV:6") });
  assert.deepEqual([r.devedora.organizacaoId, r.credora.organizacaoId, r.titulo.situacao], [ORG_B, ORG_A, "QUITADA"]);
  const reembolso = (valorCentavos, chave, vinculoChave = chave) => como(sB, () => amb.nucleo.registrarReembolsoEntreEmpresas(ctx(ORG_B, UNI_B), ctx(ORG_A, UNI_A), { vinculoId: r.vinculoId, valorCentavos, data: "2026-10-12", chave }), { vinculo: pg(vinculoChave) });
  const p = await reembolso(200000, "AV:6:r1");
  assert.deepEqual([p.devedora.situacao, p.credora.saldoCentavos], ["PARCIAL", VALOR - 200000]);
  // vínculo de uma chave, reembolso de outra: a credora recusa ⇒ a devedora também volta
  await assert.rejects(reembolso(100000, "AV:6:r2", "AV:6:outra"));
  const { rows } = await amb.dono.query("select papel, reembolsado_centavos::int v from fv2_intercompany where vinculo_id = $1 order by papel", [r.vinculoId]);
  assert.deepEqual(rows.map((x) => x.v), [200000, 200000], "nenhum lado mudou");
  const f = await reembolso(VALOR - 200000, "AV:6:r3");
  assert.deepEqual([f.devedora.situacao, f.credora.situacao], ["LIQUIDADO", "LIQUIDADO"]);
});

test("AV-7 o token vinculado NUNCA é reaproveitado: depois da operação, a sessão da A segue sem alcançar a B por operação comum", { skip: PULAR, timeout: 120000 }, async () => {
  const ob = await contaEmAberto(ORG_A, UNI_A, "av7");
  await como(sessaoDaPlataforma(ORG_A, UNI_A), () => amb.nucleo.registrarPagamentoPorOutraEmpresa(ctx(ORG_A, UNI_A), ctx(ORG_B, UNI_B), pagamento({ obrigacaoId: ob.id, chave: "AV:7" })), { vinculo: { organizacaoId: ORG_B, unidadeId: UNI_B, chave: "AV:7" } });
  await assert.rejects(como(sessaoDaPlataforma(ORG_A, UNI_A), () => amb.nucleo.consultarRegistros(ctx(ORG_B, UNI_B), { tipo: "OBRIGACAO" })), (e) => [CODIGO.PERMISSAO_INSUFICIENTE, CODIGO.ESCOPO_NAO_AUTORIZADO, CODIGO.SESSAO_INVALIDA].includes(e.codigo) || /recusou/i.test(e.message));
  // o vínculo de OUTRA operação também não serve para gravar esta
  const ob2 = await contaEmAberto(ORG_A, UNI_A, "av7b");
  await assert.rejects(como(sessaoDaPlataforma(ORG_A, UNI_A), () => amb.nucleo.registrarPagamentoPorOutraEmpresa(ctx(ORG_A, UNI_A), ctx(ORG_B, UNI_B), pagamento({ obrigacaoId: ob2.id, chave: "AV:7b" })), { vinculo: { organizacaoId: ORG_B, unidadeId: UNI_B, chave: "AV:7" } }));
  assert.deepEqual(await linhas("AV:7b"), []);
  assert.equal(await liquidacoesDe(ob2.id), 0);
});
