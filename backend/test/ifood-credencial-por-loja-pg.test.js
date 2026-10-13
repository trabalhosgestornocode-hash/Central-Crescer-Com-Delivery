// Credenciais INDEPENDENTES por loja (migration 118) em Postgres LOCAL e DESCARTÁVEL, sobre o schema REAL do projeto (base + 068..118):
// a migration (aditiva, idempotente, backend-only), constraints, gatilhos de tenant, isolamento entre unidades, o rollback, e — de ponta a
// ponta — o repositório REAL (via PostgREST falso), o OAuth da Saladas (iFood simulado) e o poller com a credencial própria no banco.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --experimental-vm-modules --test test/ifood-credencial-por-loja-pg.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";

const M118 = join(MIGRATIONS_DIR, "118_ifood_loja_credenciais.sql");
const R118 = join(MIGRATIONS_DIR, "118_rollback.sql");

const ORG = "00000000-0000-0000-0000-0000000000a0"; const ORG2 = "00000000-0000-0000-0000-0000000000b0";
const UN_A = "00000000-0000-0000-0000-0000000000a1"; const UN_B = "00000000-0000-0000-0000-0000000000b1";
const CON_A = "11111111-1111-4111-8111-1111111111a1"; const CON_B = "11111111-1111-4111-8111-1111111111b1";
const LOJA_A = "22222222-2222-4222-8222-2222222222a1"; const LOJA_B = "22222222-2222-4222-8222-2222222222b1";
const M_SAND = "a6e54f00-0000-4000-8000-0000000039b9"; const M_OUT = "55c8f400-0000-4000-8000-000000007040";
const M_SAL = "04a17bf5-b9e6-4693-a862-a5715e9f9374"; const M_COMP = "cccccccc-0000-4000-8000-00000000000c"; const M_OUTRA_UN = "dddddddd-0000-4000-8000-00000000000d";

describe("credencial própria por loja (118) — Postgres descartável, schema real", { skip: motivoPular, timeout: 900_000 }, () => {
  let b; let falhas;
  const q = (t) => sql(b.url, t);
  const tenta = (t) => psqlSync(b.url, t);
  /** Recria a loja da Saladas (mesmo id) no estado pedido, respeitando a máquina de estados da 117 (apaga a linha como superusuário). */
  const recriarLojaA = (estado = "pendente") => {
    q(`delete from ifood_conexao_lojas where id = '${LOJA_A}'`);
    q(`insert into ifood_conexao_lojas (id, conexao_id, organizacao_id, unidade_id, merchant_id, rotulo) values ('${LOJA_A}', '${CON_A}', '${ORG}', '${UN_A}', '${M_SAL}', 'Saladas')`);
    if (estado === "liberada") q(`update ifood_conexao_lojas set estado = 'liberada', liberada_em = now() where id = '${LOJA_A}'`);
    if (estado === "desativada") q(`update ifood_conexao_lojas set estado = 'desativada', desativada_em = now() where id = '${LOJA_A}'`);
  };
  const insCred = (loja, extra = "") => tenta(`insert into ifood_loja_credenciais (loja_id, app_type, access_token_cifrado, refresh_token_cifrado, expira_em ${extra.split("|")[0] ?? ""}) values ('${loja}', 'order', 'AC', 'RC', now() + interval '6 hours' ${extra.split("|")[1] ?? ""})`);

  before(() => {
    b = criarBancoDescartavel("loja_cred");
    falhas = construirSchemaReal(b.url);
    q(`insert into organizacoes (id, nome) values ('${ORG}', 'Org A'), ('${ORG2}', 'Org B');
       insert into unidades (id, nome, organizacao_id) values ('${UN_A}', 'Subway Saci — Matriz', '${ORG}'), ('${UN_B}', 'Outra loja', '${ORG2}');
       insert into ifood_conexoes (id, organizacao_id, unidade_id, merchant_id, status) values
         ('${CON_A}', '${ORG}', '${UN_A}', '${M_SAND}', 'ativa'), ('${CON_B}', '${ORG2}', '${UN_B}', '${M_OUT}', 'ativa');
       insert into ifood_credenciais (conexao_id, app_type, access_token_cifrado, refresh_token_cifrado, expira_em, status) values
         ('${CON_A}', 'order', 'AC-SAND', 'RC-SAND', now() + interval '1 hour', 'ativa'), ('${CON_B}', 'order', 'AC-OUT', 'RC-OUT', now() + interval '1 hour', 'ativa');
       insert into ifood_conexao_lojas (id, conexao_id, organizacao_id, unidade_id, merchant_id, rotulo) values
         ('${LOJA_A}', '${CON_A}', '${ORG}', '${UN_A}', '${M_SAL}', 'Saladas'), ('${LOJA_B}', '${CON_B}', '${ORG2}', '${UN_B}', '${M_OUTRA_UN}', 'Outra');`);
  });
  after(() => b?.derrubar());

  // =====================================================================
  describe("migration, permissões e restrições", () => {
    test("o schema real (base + 068..118) aplica sem falhas; reaplicar a 118 é idempotente", () => {
      assert.deepEqual(falhas, [], JSON.stringify(falhas));
      assert.equal(psqlSync(b.url, "", { arquivo: M118 }).ok, true);
      assert.equal(q("select count(*) from ifood_loja_credenciais"), "0");
    });

    test("100% aditiva: ifood_conexoes, ifood_credenciais e ifood_conexao_lojas (117) intactas; a sessão OAuth só ganha `loja_id` (nula)", () => {
      assert.equal(q("select count(*) from information_schema.columns where table_name = 'ifood_conexao_lojas' and column_name = 'credencial'"), "0");
      assert.equal(q("select count(*) from information_schema.columns where table_name = 'ifood_credenciais' and column_name = 'loja_id'"), "0");
      assert.equal(q("select count(*) from pg_indexes where indexname in ('uq_ifood_conexao_unidade_viva', 'uq_ifood_conexao_merchant_vivo', 'uq_ifood_conexao_lojas_merchant_vivo')"), "3");
      assert.equal(q("select is_nullable from information_schema.columns where table_name = 'ifood_oauth_sessoes' and column_name = 'loja_id'"), "YES");
      assert.equal(q(`select access_token_cifrado from ifood_credenciais where conexao_id = '${CON_A}'`), "AC-SAND");
    });

    test("backend-only: RLS ligada, ZERO policies, anon/authenticated/PUBLIC sem privilégio; service_role só select/insert/update (sem delete)", () => {
      assert.equal(q("select relrowsecurity::text from pg_class where oid = 'public.ifood_loja_credenciais'::regclass"), "true");
      assert.equal(q("select count(*) from pg_policy where polrelid = 'public.ifood_loja_credenciais'::regclass"), "0");
      for (const papel of ["anon", "authenticated"]) {
        assert.equal(q(`select has_table_privilege('${papel}', 'public.ifood_loja_credenciais', 'select,insert,update,delete,truncate,references,trigger')::text`), "false", papel);
        for (const f of ["ifood_loja_credenciais_validar()", "ifood_oauth_sessoes_loja_validar()"]) assert.equal(q(`select has_function_privilege('${papel}', 'public.${f}', 'execute')::text`), "false", `${papel} ${f}`);
      }
      assert.equal(q("select has_table_privilege('service_role', 'public.ifood_loja_credenciais', 'select,insert,update')::text"), "true");
      assert.equal(q("select has_table_privilege('service_role', 'public.ifood_loja_credenciais', 'delete,truncate')::text"), "false");
      assert.equal(q("select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.proname in ('ifood_loja_credenciais_validar', 'ifood_oauth_sessoes_loja_validar') and a.grantee = 0"), "0");
    });

    test("TITULAR ÚNICO: no máximo UMA credencial por loja e app; só o app `order`; status válido", () => {
      assert.equal(insCred(LOJA_A).ok, true);
      assert.match(insCred(LOJA_A).err, /uq_ifood_loja_cred_loja_app|duplicate key/);
      assert.equal(tenta(`insert into ifood_loja_credenciais (loja_id, app_type, access_token_cifrado, expira_em) values ('${LOJA_B}', 'financial', 'x', now())`).ok, false);
      assert.equal(tenta(`insert into ifood_loja_credenciais (loja_id, app_type, access_token_cifrado, expira_em, status) values ('${LOJA_B}', 'order', 'x', now(), 'qualquer')`).ok, false);
      assert.equal(q("select count(*) from ifood_loja_credenciais"), "1");
    });

    test("ISOLAMENTO: organização/unidade da credencial são DERIVADAS da loja (um valor forjado é substituído); loja inexistente/desativada recusada", () => {
      assert.equal(q(`select organizacao_id || '|' || unidade_id from ifood_loja_credenciais where loja_id = '${LOJA_A}'`), `${ORG}|${UN_A}`);
      // forjar o tenant de OUTRA organização no insert: o gatilho sobrescreve com o da loja
      assert.equal(tenta(`insert into ifood_loja_credenciais (loja_id, organizacao_id, unidade_id, app_type, access_token_cifrado, expira_em) values ('${LOJA_B}', '${ORG}', '${UN_A}', 'order', 'x', now() + interval '1 hour')`).ok, true);
      assert.equal(q(`select organizacao_id || '|' || unidade_id from ifood_loja_credenciais where loja_id = '${LOJA_B}'`), `${ORG2}|${UN_B}`, "tenant da loja B, não o forjado");
      assert.match(insCred("99999999-9999-4999-8999-999999999999").err, /não existe|foreign key|viola/);
      q(`insert into ifood_conexao_lojas (conexao_id, organizacao_id, unidade_id, merchant_id) values ('${CON_A}', '${ORG}', '${UN_A}', '${M_COMP}')`);
      q(`update ifood_conexao_lojas set estado = 'desativada', desativada_em = now() where merchant_id = '${M_COMP}'`);
      const desativada = q(`select id from ifood_conexao_lojas where merchant_id = '${M_COMP}'`);
      assert.match(insCred(desativada).err, /desativada não recebe credencial/);
    });

    test("loja, app e tenant da credencial são imutáveis; atualizar a credencial atualiza `atualizado_em`", () => {
      assert.match(tenta(`update ifood_loja_credenciais set loja_id = '${LOJA_B}' where loja_id = '${LOJA_A}'`).err, /não mudam/);
      assert.match(tenta(`update ifood_loja_credenciais set unidade_id = '${UN_B}' where loja_id = '${LOJA_A}'`).err, /não mudam/);
      const antes = q(`select atualizado_em from ifood_loja_credenciais where loja_id = '${LOJA_A}'`);
      q("select pg_sleep(0.05)");
      assert.equal(tenta(`update ifood_loja_credenciais set status = 'reauth_required' where loja_id = '${LOJA_A}'`).ok, true);
      assert.notEqual(q(`select atualizado_em from ifood_loja_credenciais where loja_id = '${LOJA_A}'`), antes);
      q(`update ifood_loja_credenciais set status = 'ativa' where loja_id = '${LOJA_A}'`);
    });

    test("sessão OAuth com loja-alvo: só `order`, só a loja DO MESMO tenant, e a loja-alvo não muda", () => {
      const ins = (org, un, app, loja) => tenta(`insert into ifood_oauth_sessoes (organizacao_id, unidade_id, app_type, user_code, expira_em, loja_id) values ('${org}', '${un}', '${app}', 'ABCD-1234', now() + interval '10 minutes', ${loja ? `'${loja}'` : "null"})`);
      assert.equal(ins(ORG, UN_A, "order", LOJA_A).ok, true);
      assert.equal(ins(ORG, UN_A, "order", null).ok, true, "fluxo da conexão (sem loja-alvo) segue igual");
      assert.match(ins(ORG, UN_A, "order", LOJA_B).err, /não pertence a esta organização\/unidade/);
      assert.match(ins(ORG2, UN_B, "order", LOJA_A).err, /não pertence a esta organização\/unidade/);
      assert.match(ins(ORG, UN_A, "financial", LOJA_A).err, /só para o app order/);
      assert.match(tenta(`update ifood_oauth_sessoes set loja_id = '${LOJA_B}' where loja_id = '${LOJA_A}'`).err, /não muda|não pertence/);
    });
  });

  // =====================================================================
  describe("repositório REAL + token + OAuth + poller (PostgREST falso sobre o banco real)", () => {
    let falso; let repo; let repoEv; let repoOrder; let token; let authSvc; let cripto; let tokenEscopo;
    const jwt = (ids, expEmMs = 6 * 3_600_000) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ merchant_scope: ids.flatMap((i) => [`${i}:order`, `${i}:events`]), exp: Math.floor((Date.now() + expEmMs) / 1000) })).toString("base64url")}.assinatura-falsa`;

    before(async () => {
      const { iniciarSupabaseFalso } = await import("./helpers/supabase-falso-pg.js");
      falso = await iniciarSupabaseFalso({ pgUrl: b.url, usuarios: new Map() });
      Object.assign(process.env, {
        SUPABASE_URL: falso.url, SUPABASE_SERVICE_ROLE_KEY: "chave-service-role-de-teste-".padEnd(48, "z"), SUPABASE_ANON_KEY: "chave-anon-de-teste-".padEnd(48, "a"),
        IFOOD_TOKEN_SECRET: "teste-secret-fixo-para-cripto-1234567890", IFOOD_ORDER_PILOT_UNITS: UN_A, IFOOD_ORDER_CLIENT_ID: "order-id", IFOOD_ORDER_CLIENT_SECRET: "order-secret",
      });
      repo = await import("../src/modules/ifood/ifood.repository.js");
      repoEv = await import("../src/modules/ifood/ifoodEvents.repository.js");
      repoOrder = await import("../src/modules/ifood/ifoodOrder.repository.js");
      token = await import("../src/modules/ifood/ifoodToken.service.js");
      authSvc = await import("../src/modules/ifood/ifoodAuth.service.js");
      cripto = await import("../src/shared/cripto.js");
      tokenEscopo = await import("../src/modules/ifood/ifoodTokenEscopo.js");
      q("delete from ifood_loja_credenciais; delete from ifood_oauth_sessoes; update ifood_conexao_lojas set estado = 'desativada', desativada_em = now() where merchant_id not in ('" + M_SAL + "', '" + M_OUTRA_UN + "')");
      q(`update ifood_conexao_lojas set estado = 'pendente' where merchant_id = '${M_SAL}'`);
    });
    after(() => falso?.parar?.());

    test("credencial por loja: salvar (upsert), ler, atualizar condicional (compare-and-set) — a da conexão nunca é tocada", async () => {
      assert.equal(await repo.obterCredencial({ conexaoId: CON_A, appType: "order", lojaId: LOJA_A }), null);
      await repo.salvarCredencial({ conexaoId: CON_A, lojaId: LOJA_A, appType: "order", accessTokenCifrado: "AC1", refreshTokenCifrado: "RC1", expiraEm: new Date(Date.now() + 3.6e6).toISOString(), tokenType: "Bearer" });
      const c = await repo.obterCredencial({ conexaoId: CON_A, appType: "order", lojaId: LOJA_A });
      assert.equal(c.access_token_cifrado, "AC1");
      assert.equal(c.unidade_id, UN_A, "tenant derivado da loja pelo gatilho");
      // sem refresh novo: o anterior fica
      await repo.salvarCredencial({ conexaoId: CON_A, lojaId: LOJA_A, appType: "order", accessTokenCifrado: "AC2", refreshTokenCifrado: undefined, expiraEm: new Date(Date.now() + 3.6e6).toISOString() });
      assert.equal(q(`select refresh_token_cifrado from ifood_loja_credenciais where loja_id = '${LOJA_A}'`), "RC1");
      // compare-and-set
      assert.equal(await repo.atualizarCredencial({ conexaoId: CON_A, lojaId: LOJA_A, appType: "order", campos: { status: "reauth_required" }, seAccessCifradoIgual: "AC-ERRADO" }), null);
      assert.ok(await repo.atualizarCredencial({ conexaoId: CON_A, lojaId: LOJA_A, appType: "order", campos: { access_token_cifrado: "AC3" }, seAccessCifradoIgual: "AC2" }));
      assert.equal(q(`select access_token_cifrado from ifood_loja_credenciais where loja_id = '${LOJA_A}'`), "AC3");
      assert.equal(q(`select access_token_cifrado || '|' || status from ifood_credenciais where conexao_id = '${CON_A}'`), "AC-SAND|ativa", "Sanduíches intacta");
      assert.equal((await repo.obterCredencial({ conexaoId: CON_A, appType: "order" })).access_token_cifrado, "AC-SAND");
    });

    test("lojasComCredencialPropria / listarLojasExtrasVivasDaConexao: loja com credencial própria sai da lista que a credencial da CONEXÃO precisa cobrir", async () => {
      recriarLojaA("liberada");
      q(`insert into ifood_loja_credenciais (loja_id, app_type, access_token_cifrado, expira_em) values ('${LOJA_A}', 'order', 'AC', now() + interval '1 hour')`);
      const mapa = await repo.lojasComCredencialPropria({ lojaIds: [LOJA_A, LOJA_B] });
      assert.deepEqual([...mapa.entries()], [[LOJA_A, "ativa"]], "só a loja que tem credencial própria");
      assert.deepEqual(await repo.listarLojasExtrasVivasDaConexao({ conexaoId: CON_A }), [], "a Saladas tem credencial própria: não é exigida da credencial da conexão");
      q(`delete from ifood_loja_credenciais where loja_id = '${LOJA_A}'`);
      assert.deepEqual(await repo.listarLojasExtrasVivasDaConexao({ conexaoId: CON_A }), [M_SAL], "sem credencial própria (modo compartilhado) volta a ser exigida");
      const [linha] = await repoEv.listarLojasExtrasParaPolling({ conexaoIds: [CON_A] });
      assert.equal(linha.credencial_propria, false);
      await repo.salvarCredencial({ conexaoId: CON_A, lojaId: LOJA_A, appType: "order", accessTokenCifrado: "AC4", refreshTokenCifrado: "RC4", expiraEm: new Date(Date.now() + 3.6e6).toISOString() });
      const [linha2] = await repoEv.listarLojasExtrasParaPolling({ conexaoIds: [CON_A] });
      assert.deepEqual([linha2.credencial_propria, linha2.credencial_status], [true, "ativa"]);
    });

    test("obterConexaoAtivaDoMerchant: principal; extra compartilhada; extra com credencial própria (`lojaId`); `pendente`/outra unidade = null", async () => {
      const t = { organizacaoId: ORG, unidadeId: UN_A };
      assert.deepEqual(await repoOrder.obterConexaoAtivaDoMerchant({ ...t, merchantId: M_SAND }), { id: CON_A, organizacao_id: ORG, unidade_id: UN_A, merchant_id: M_SAND });
      assert.equal((await repoOrder.obterConexaoAtivaDoMerchant({ ...t, merchantId: M_SAL })).lojaId, LOJA_A, "credencial própria -> lojaId");
      q(`delete from ifood_loja_credenciais where loja_id = '${LOJA_A}'`);
      const comp = await repoOrder.obterConexaoAtivaDoMerchant({ ...t, merchantId: M_SAL });
      assert.equal(comp.id, CON_A); assert.equal(comp.lojaId, undefined, "compartilhada -> token da conexão");
      q(`update ifood_conexao_lojas set estado = 'bloqueada', bloqueada_em = now(), bloqueio_motivo = 'SEM_AUTORIZACAO' where id = '${LOJA_A}'`);
      assert.equal(await repoOrder.obterConexaoAtivaDoMerchant({ ...t, merchantId: M_SAL }), null, "loja bloqueada não recebe ação");
      recriarLojaA("liberada");
      assert.equal(await repoOrder.obterConexaoAtivaDoMerchant({ organizacaoId: ORG2, unidadeId: UN_B, merchantId: M_SAL }), null, "outra unidade nunca resolve a loja");
      assert.equal(await repoOrder.obterConexaoAtivaDoMerchant({ ...t, merchantId: M_OUTRA_UN }), null, "loja de outra unidade nunca resolve aqui");
    });

    test("OAuth da Saladas ponta a ponta: a credencial nasce em ifood_loja_credenciais; Sanduíches, conexão e estado da loja NÃO mudam", async () => {
      recriarLojaA("pendente");
      const antesSand = q(`select access_token_cifrado || '|' || refresh_token_cifrado || '|' || expira_em from ifood_credenciais where conexao_id = '${CON_A}'`);
      const antesCon = q(`select status || '|' || merchant_id || '|' || atualizado_em from ifood_conexoes where id = '${CON_A}'`);
      const http = { async postForm() { return { userCode: "ABCD-EFGH", authorizationCodeVerifier: "verifier-x", verificationUrl: "u", verificationUrlComplete: "uc", expiresIn: 600 }; } };
      const novoToken = jwt([M_SAL]);
      const tk = { ...token, async trocarAuthorizationCodePorToken() { return { accessToken: novoToken, refreshToken: "RT-SAL", expiraEm: new Date(Date.now() + 6 * 3.6e6).toISOString(), tokenType: "Bearer" }; } };
      const ini = await authSvc.iniciarConexao({ organizacaoId: ORG, unidadeId: UN_A, appType: "order", usuarioId: null, merchantId: M_SAL, deps: { http, token: tk } });
      assert.equal(q(`select loja_id from ifood_oauth_sessoes where id = '${ini.sessionId}'`), LOJA_A);
      const fim = await authSvc.concluirAutorizacao({ organizacaoId: ORG, unidadeId: UN_A, appType: "order", sessaoId: ini.sessionId, authorizationCode: "codigo", usuarioId: null, deps: { http, token: tk } });
      assert.equal(fim.lojaAlvo, true);
      const row = await repo.obterCredencial({ conexaoId: CON_A, appType: "order", lojaId: LOJA_A });
      assert.equal(cripto.decifrar(row.access_token_cifrado), novoToken);
      assert.equal(cripto.decifrar(row.refresh_token_cifrado), "RT-SAL");
      assert.ok(!JSON.stringify(row).includes("RT-SAL") && !JSON.stringify(row).includes("assinatura-falsa"), "nada em claro no banco");
      assert.equal(q(`select access_token_cifrado || '|' || refresh_token_cifrado || '|' || expira_em from ifood_credenciais where conexao_id = '${CON_A}'`), antesSand, "credencial da Sanduíches intacta");
      assert.equal(q(`select status || '|' || merchant_id || '|' || atualizado_em from ifood_conexoes where id = '${CON_A}'`), antesCon, "conexão intacta");
      assert.equal(q(`select estado from ifood_conexao_lojas where id = '${LOJA_A}'`), "pendente", "autorizar NÃO libera a loja no polling");
      assert.equal(q(`select status from ifood_oauth_sessoes where id = '${ini.sessionId}'`), "authorized");
      assert.ok(tokenEscopo.coberturaDoToken({ novo: novoToken, atual: null, merchantsExigidos: [M_SAL] }).cobre);
    });

    test("OAuth com token só da Sanduíches para a loja-alvo: recusado, sessão `failed`, nada gravado no banco", async () => {
      recriarLojaA("pendente");
      const http = { async postForm() { return { userCode: "WXYZ-1234", authorizationCodeVerifier: "v2", verificationUrl: "u", verificationUrlComplete: "uc", expiresIn: 600 }; } };
      const tk = { ...token, async trocarAuthorizationCodePorToken() { return { accessToken: jwt([M_SAND]), refreshToken: "RT-X", expiraEm: new Date(Date.now() + 6 * 3.6e6).toISOString() }; } };
      const ini = await authSvc.iniciarConexao({ organizacaoId: ORG, unidadeId: UN_A, appType: "order", usuarioId: null, merchantId: M_SAL, deps: { http, token: tk } });
      await assert.rejects(authSvc.concluirAutorizacao({ organizacaoId: ORG, unidadeId: UN_A, appType: "order", sessaoId: ini.sessionId, authorizationCode: "c", usuarioId: null, deps: { http, token: tk } }), (e) => e?.codigo === "IFOOD_CREDENCIAL_SEM_COBERTURA");
      assert.equal(q(`select count(*) from ifood_loja_credenciais where loja_id = '${LOJA_A}'`), "0");
      assert.equal(q(`select status from ifood_oauth_sessoes where id = '${ini.sessionId}'`), "failed");
      assert.equal(q(`select access_token_cifrado from ifood_credenciais where conexao_id = '${CON_A}'`), "AC-SAND");
    });

    test("isolamento entre unidades no OAuth: a loja de OUTRA unidade não pode ser alvo; tenant errado na conclusão não encontra a sessão", async () => {
      const http = { async postForm() { return { userCode: "QQQQ-1111", authorizationCodeVerifier: "v3", verificationUrl: "u", verificationUrlComplete: "uc", expiresIn: 600 }; } };
      await assert.rejects(authSvc.iniciarConexao({ organizacaoId: ORG, unidadeId: UN_A, appType: "order", usuarioId: null, merchantId: M_OUTRA_UN, deps: { http } }), (e) => e?.codigo === "IFOOD_LOJA_NAO_ENCONTRADA");
      const ini = await authSvc.iniciarConexao({ organizacaoId: ORG, unidadeId: UN_A, appType: "order", usuarioId: null, merchantId: M_SAL, deps: { http } });
      await assert.rejects(authSvc.concluirAutorizacao({ organizacaoId: ORG2, unidadeId: UN_B, appType: "order", sessaoId: ini.sessionId, authorizationCode: "c", usuarioId: null, deps: { http } }), (e) => ["IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA", "IFOOD_ORDER_PILOTO_NAO_HABILITADO"].includes(e?.codigo));
    });

    test("PODER ponta a ponta: Saladas `liberada` com credencial própria no banco real é consultada com o token DELA, vira `ativa`; reauth no banco a deixa parada; Sanduíches segue", async () => {
      const fakes = await import("./helpers/ifood-events-fakes.js");
      const pollerMod = await import("../src/modules/ifood/ifoodEvents.poller.js");
      const clienteReal = await import("../src/modules/ifood/ifoodEvents.client.js");
      recriarLojaA("liberada");
      await repo.salvarCredencial({ conexaoId: CON_A, lojaId: LOJA_A, appType: "order", accessTokenCifrado: "AC-SAL", refreshTokenCifrado: "RC-SAL", expiraEm: new Date(Date.now() + 3.6e6).toISOString() });

      const relogio = fakes.criarRelogio();
      const mem = fakes.criarRepoEmMemoria({ relogio, conexoes: [{ id: CON_A, organizacao_id: ORG, unidade_id: UN_A, merchant_id: M_SAND }] });
      for (const f of ["listarLojasExtrasParaPolling", "iniciarVerificacaoLoja", "marcarLojaAtiva", "bloquearLoja"]) mem[f] = (...a) => repoEv[f](...a);
      const usados = [];
      const tk = { escopoDoToken: () => "conexao", async comAccessTokenValido({ conexaoId, lojaId, fn }) { usados.push(lojaId ?? "conexao"); return fn(lojaId ? "tok-loja" : "tok-conexao"); } };
      const client = fakes.criarClienteFake(clienteReal, { respostasPolling: [[fakes.ev("s1", "PLC", { orderId: "o-sand", merchantId: M_SAND, min: 1 })], [fakes.ev("d1", "PLC", { orderId: "o-sal", merchantId: M_SAL, min: 1 })], [], [], [], []] });
      const poller = pollerMod.criarPoller({ repo: mem, token: tk, client, holder: "w1", agora: relogio.agora, log: () => {}, leaseTtlS: 90, unidadesPiloto: fakes.pilotoDe(mem) });
      const r = await poller.executarCiclo(); relogio.avancarS(30);
      assert.equal(r.estado, "OK");
      assert.deepEqual(client.polls.map((p) => [p.merchantIds, p.accessToken]), [[[M_SAND], "tok-conexao"], [[M_SAL], "tok-loja"]]);
      assert.equal(q(`select estado || '|' || verificacoes from ifood_conexao_lojas where id = '${LOJA_A}'`), "ativa|1");
      assert.equal(mem.pedidos.get("o-sal").unidade_id, UN_A);
      assert.equal(mem.pedidos.get("o-sal").merchant_id, M_SAL);

      // reauth_required no banco: a loja para (sem fallback para o token da conexão); a Sanduíches segue
      q(`update ifood_loja_credenciais set status = 'reauth_required' where loja_id = '${LOJA_A}'`);
      const r2 = await poller.executarCiclo();
      assert.equal(r2.estado, "OK");
      assert.deepEqual(client.polls.slice(2).map((p) => p.merchantIds), [[M_SAND]]);
      assert.equal(r2.conexoesIgnoradas.length, 1);
    });
  });

  // =====================================================================
  describe("rollback", () => {
    test("recusa se houver credencial própria `ativa` (nada é removido); sem ela remove tabela, coluna e funções; idempotente; reaplica", () => {
      q(`delete from ifood_loja_credenciais`);
      q(`insert into ifood_loja_credenciais (loja_id, app_type, access_token_cifrado, expira_em) values ('${LOJA_A}', 'order', 'AC', now() + interval '1 hour')`);
      const r = psqlSync(b.url, "", { arquivo: R118 });
      assert.equal(r.ok, false);
      assert.match(r.err, /Rollback 118 abortado/);
      assert.equal(q("select to_regclass('public.ifood_loja_credenciais') is not null"), "t");
      q(`update ifood_loja_credenciais set status = 'reauth_required'`);
      assert.equal(psqlSync(b.url, "", { arquivo: R118 }).ok, true);
      assert.equal(q("select to_regclass('public.ifood_loja_credenciais') is null"), "t");
      assert.equal(q("select count(*) from information_schema.columns where table_name = 'ifood_oauth_sessoes' and column_name = 'loja_id'"), "0");
      assert.equal(q("select count(*) from pg_proc where proname in ('ifood_loja_credenciais_validar', 'ifood_oauth_sessoes_loja_validar')"), "0");
      assert.equal(psqlSync(b.url, "", { arquivo: R118 }).ok, true, "idempotente");
      assert.equal(q(`select access_token_cifrado from ifood_credenciais where conexao_id = '${CON_A}'`), "AC-SAND", "credencial da conexão intacta");
      assert.equal(q("select count(*) from ifood_conexao_lojas"), "3", "lojas da 117 intactas");
      assert.equal(psqlSync(b.url, "", { arquivo: M118 }).ok, true, "a migration reaplica depois do rollback");
    });

    test("pós-condição: se anon ainda alcançar a tabela por outra via (herança de role), a 118 ABORTA e desfaz TUDO", () => {
      const papel = `zz_heranca_${Date.now().toString(36)}`;
      psqlSync(b.url, "", { arquivo: R118 });
      try {
        q(`create role ${papel} nologin; grant ${papel} to anon; alter default privileges in schema public grant all on tables to ${papel}`);
        const r = psqlSync(b.url, "", { arquivo: M118 });
        assert.equal(r.ok, false);
        assert.match(r.err, /MIGRATION 118 abortada e DESFEITA/);
        assert.equal(q("select to_regclass('public.ifood_loja_credenciais') is null"), "t", "nada ficou criado");
        assert.equal(q("select count(*) from information_schema.columns where table_name = 'ifood_oauth_sessoes' and column_name = 'loja_id'"), "0");
      } finally {
        psqlSync(b.url, `alter default privileges in schema public revoke all on tables from ${papel}; revoke ${papel} from anon; drop role if exists ${papel}`);
      }
      assert.equal(psqlSync(b.url, "", { arquivo: M118 }).ok, true, "sem a herança, aplica normalmente");
    });
  });
});
