// Múltiplas conexões iFood — repositórios e serviços REAIS sobre um Postgres LOCAL e DESCARTÁVEL (schema real, migrations 124 e 125 aplicadas),
// falando com o banco por um PostgREST falso. Cenário: Saci (legado) + Subway North (Financial de homologação + Order de produção) +
// outra empresa. Prova a seleção por finalidade, o poller/listas sem a loja de teste, o OAuth que cria `pedidos_producao`, e a
// desconexão independente — tudo com SQL de verdade.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55430/postgres node --experimental-vm-modules --test test/ifood-multi-conexao-real-pg.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { motivoPular, criarBancoDescartavel, sql, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal } from "./helpers/schema-real-pg.js";

const ORG = "00000000-0000-0000-0000-0000000000a0"; const ORG2 = "00000000-0000-0000-0000-0000000000b0";
const UN_SACI = "00000000-0000-0000-0000-0000000000a1"; const UN_NORTH = "00000000-0000-0000-0000-0000000000a2"; const UN_NOVA = "00000000-0000-0000-0000-0000000000a3";
const UN_OUTRA = "00000000-0000-0000-0000-0000000000b1";
const CON_SACI = "11111111-1111-4111-8111-1111111111a1"; const CON_TESTE = "11111111-1111-4111-8111-1111111111a2"; const CON_REAL = "11111111-1111-4111-8111-1111111111a3";
const CON_NOVA_TESTE = "11111111-1111-4111-8111-1111111111a4"; const CON_OUTRA = "11111111-1111-4111-8111-1111111111b1";
const M_SACI = "a6e54f00-0000-4000-8000-0000000039b9"; const M_TESTE = "7e570000-0000-4000-8000-00000000aaaa"; const M_REAL = "ea100000-0000-4000-8000-00000000bbbb";
const M_NOVA_TESTE = "7e570000-0000-4000-8000-00000000cccc"; const M_OUTRA = "55c8f400-0000-4000-8000-000000007040";

describe("múltiplas conexões iFood — repositórios e serviços reais, SQL real", { skip: motivoPular, timeout: 900_000 }, () => {
  let b; let falso; let repo; let repoEv; let repoOrder; let auth; let conexaoSvc; let token;
  const q = (t) => sql(b.url, t);
  const cred = (con, app, status = "ativa") => `insert into ifood_credenciais (conexao_id, app_type, access_token_cifrado, refresh_token_cifrado, expira_em, status) values ('${con}', '${app}', 'AC-${app}', 'RC-${app}', now() + interval '1 hour', '${status}')`;
  /**
   * Adaptador mínimo do cliente do Supabase SÓ para as consultas de conexões elegíveis (o PostgREST falso não faz embed um-para-muitos):
   * traduz os filtros recebidos (eq/neq/not + o inner join com ifood_credenciais) em SQL real. Os filtros VÊM do código sob teste.
   */
  const dbSql = () => ({
    from(tabela) {
      const f = { eq: [], neq: [], not: [], join: false };
      const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
      const q = {
        select(cols) { f.join = /ifood_credenciais!inner/.test(cols); return q; },
        eq(c, v) { f.eq.push([c, v]); return q; },
        neq(c, v) { f.neq.push([c, v]); return q; },
        not(c, op, v) { f.not.push([c, op, v]); return q; },
        then(res, rej) {
          try {
            assert.equal(tabela, "ifood_conexoes");
            const w = [
              ...f.eq.filter(([c]) => !c.includes(".")).map(([c, v]) => `c.${c} = ${lit(v)}`),
              ...f.neq.map(([c, v]) => `c.${c} <> ${lit(v)}`),
              ...f.not.map(([c, op, v]) => `c.${c} is not ${v === null ? "null" : lit(v)}`),
              ...(f.join ? [`exists (select 1 from ifood_credenciais k where k.conexao_id = c.id and k.app_type = ${lit(f.eq.find(([c]) => c === "ifood_credenciais.app_type")?.[1] ?? "order")})`] : []),
            ];
            const credenciais = f.join ? ", (select json_agg(json_build_object('app_type', k.app_type, 'status', k.status)) from ifood_credenciais k where k.conexao_id = c.id and k.app_type = 'order') as ifood_credenciais" : "";
            const linhas = JSON.parse(q_(`select coalesce(json_agg(t), '[]'::json) from (select c.id, c.organizacao_id, c.unidade_id, c.merchant_id${credenciais} from ifood_conexoes c where ${w.join(" and ") || "true"}) t`));
            return Promise.resolve({ data: linhas, error: null }).then(res, rej);
          } catch (e) { return Promise.reject(e).then(res, rej); }
        },
      };
      return q;
    },
  });
  const q_ = (t) => sql(b.url, t);
  const snap = (con) => q(`select md5(c::text) from ifood_conexoes c where id = '${con}'`) + "/" + q(`select coalesce(md5(string_agg(k::text, '|' order by app_type)), '-') from ifood_credenciais k where conexao_id = '${con}'`);

  before(async () => {
    b = criarBancoDescartavel("multi_conexao_real");
    const falhas = construirSchemaReal(b.url);   // base + 068..125 (inclui 124 e 125)
    assert.deepEqual(falhas, [], JSON.stringify(falhas));
    q(`insert into organizacoes (id, nome) values ('${ORG}', 'Org A'), ('${ORG2}', 'Org B');
       insert into unidades (id, nome, organizacao_id) values ('${UN_SACI}', 'Saci', '${ORG}'), ('${UN_NORTH}', 'North', '${ORG}'), ('${UN_NOVA}', 'Nova', '${ORG}'), ('${UN_OUTRA}', 'Outra', '${ORG2}');
       insert into ifood_conexoes (id, organizacao_id, unidade_id, merchant_id, status, finalidade, ambiente) values
         ('${CON_SACI}', '${ORG}', '${UN_SACI}', '${M_SACI}', 'ativa', 'legado', 'nao_informado'),
         ('${CON_TESTE}', '${ORG}', '${UN_NORTH}', '${M_TESTE}', 'ativa', 'financeiro_homologacao', 'homologacao'),
         ('${CON_REAL}', '${ORG}', '${UN_NORTH}', '${M_REAL}', 'ativa', 'pedidos_producao', 'producao'),
         ('${CON_NOVA_TESTE}', '${ORG}', '${UN_NOVA}', '${M_NOVA_TESTE}', 'ativa', 'financeiro_homologacao', 'homologacao'),
         ('${CON_OUTRA}', '${ORG2}', '${UN_OUTRA}', '${M_OUTRA}', 'ativa', 'legado', 'nao_informado');
       ${cred(CON_SACI, "order")}; ${cred(CON_SACI, "financial")}; ${cred(CON_TESTE, "financial")}; ${cred(CON_TESTE, "analytics")}; ${cred(CON_REAL, "order")};
       ${cred(CON_NOVA_TESTE, "financial")}; ${cred(CON_OUTRA, "order")};`);
    const { iniciarSupabaseFalso } = await import("./helpers/supabase-falso-pg.js");
    falso = await iniciarSupabaseFalso({ pgUrl: b.url, usuarios: new Map() });
    Object.assign(process.env, {
      SUPABASE_URL: falso.url, SUPABASE_SERVICE_ROLE_KEY: "chave-service-role-de-teste-".padEnd(48, "z"), SUPABASE_ANON_KEY: "chave-anon-de-teste-".padEnd(48, "a"),
      IFOOD_TOKEN_SECRET: "teste-secret-fixo-para-cripto-1234567890",
      IFOOD_ORDER_PILOT_UNITS: [UN_SACI, UN_NORTH, UN_NOVA, UN_OUTRA].join(","), IFOOD_FINANCIAL_HOMOLOGATION_UNITS: [UN_NORTH, UN_NOVA].join(","),
      IFOOD_ORDER_CLIENT_ID: "order-id", IFOOD_ORDER_CLIENT_SECRET: "order-secret", IFOOD_TEST_CLIENT_ID: "test-id", IFOOD_TEST_CLIENT_SECRET: "test-secret",
    });
    repo = await import("../src/modules/ifood/ifood.repository.js");
    repoEv = await import("../src/modules/ifood/ifoodEvents.repository.js");
    repoOrder = await import("../src/modules/ifood/ifoodOrder.repository.js");
    auth = await import("../src/modules/ifood/ifoodAuth.service.js");
    conexaoSvc = await import("../src/modules/ifood/ifoodConnection.service.js");
    token = await import("../src/modules/ifood/ifoodToken.service.js");
  });
  after(() => { falso?.parar?.(); b?.derrubar(); });

  test("seleção por finalidade com SQL real: cada app encontra a SUA conexão; a legada (Saci) serve a todos; outro tenant não enxerga", async () => {
    const t = { organizacaoId: ORG, unidadeId: UN_NORTH };
    assert.equal((await repo.obterConexaoViva({ ...t, finalidade: "financeiro_homologacao" })).id, CON_TESTE);
    assert.equal((await repo.obterConexaoViva({ ...t, finalidade: "pedidos_producao" })).id, CON_REAL);
    await assert.rejects(repo.obterConexaoViva(t), (e) => e.codigo === "IFOOD_CONEXAO_AMBIGUA", "sem finalidade e com duas: ambígua");
    assert.equal((await repo.listarConexoesVivas(t)).length, 2);
    for (const f of ["financeiro_homologacao", "pedidos_producao"]) assert.equal((await repo.obterConexaoViva({ organizacaoId: ORG, unidadeId: UN_SACI, finalidade: f })).id, CON_SACI);
    assert.equal(await repo.obterConexaoViva({ organizacaoId: ORG2, unidadeId: UN_NORTH, finalidade: "pedidos_producao" }), null, "tenant cruzado");
    assert.equal(await repo.obterConexaoViva({ organizacaoId: ORG, unidadeId: UN_NOVA, finalidade: "pedidos_producao" }), null, "a financeira nunca serve pedidos");
  });

  test("poller/listas: a loja de TESTE nunca é elegível (nem no modo centralizado)", async () => {
    const elegiveis = await repoEv.listarConexoesElegiveisParaEvents({ db: dbSql() });
    assert.deepEqual(elegiveis.map((c) => c.id).sort(), [CON_SACI, CON_REAL, CON_OUTRA].sort());
    assert.ok(!elegiveis.some((c) => [M_TESTE, M_NOVA_TESTE].includes(c.merchant_id)));
    const todas = await repoEv.listarConexoesComMerchant({ db: dbSql() });
    assert.deepEqual(todas.map((c) => c.id).sort(), [CON_SACI, CON_REAL, CON_OUTRA].sort());
  });

  test("token por merchant: o merchant de teste não resolve; o real e o da Saci resolvem", async () => {
    assert.equal(await repoOrder.obterConexaoAtivaDoMerchant({ organizacaoId: ORG, unidadeId: UN_NORTH, merchantId: M_TESTE }), null);
    assert.equal((await repoOrder.obterConexaoAtivaDoMerchant({ organizacaoId: ORG, unidadeId: UN_NORTH, merchantId: M_REAL })).id, CON_REAL);
    assert.equal((await repoOrder.obterConexaoAtivaDoMerchant({ organizacaoId: ORG, unidadeId: UN_SACI, merchantId: M_SACI })).id, CON_SACI);
    assert.equal(await repoOrder.obterConexaoAtivaDoMerchant({ organizacaoId: ORG, unidadeId: UN_SACI, merchantId: M_REAL }), null, "merchant de outra unidade");
  });

  test("status da North com SQL real: topo = Financial (loja de teste), Order = loja real, `conexoes` com as duas", async () => {
    const s = await conexaoSvc.obterStatus({ organizacaoId: ORG, unidadeId: UN_NORTH });
    assert.equal(s.merchant.idMascarado, "7e57****aaaa");
    assert.equal(s.order.merchant.idMascarado, "ea10****bbbb");
    assert.deepEqual(s.conexoes.map((c) => [c.id, c.finalidade, c.ambiente]).sort(), [[CON_REAL, "pedidos_producao", "producao"], [CON_TESTE, "financeiro_homologacao", "homologacao"]].sort());
    const saci = await conexaoSvc.obterStatus({ organizacaoId: ORG, unidadeId: UN_SACI });
    assert.equal(saci.conexoes, undefined, "Saci: resposta de sempre");
  });

  test("OAuth do Order numa unidade que separa e só tem a conexão de teste: cria a conexão `pedidos_producao` (SQL real) sem tocar a de teste", async () => {
    const antes = snap(CON_NOVA_TESTE);
    const posts = [];
    const deps = {
      http: { async postForm(rota, corpo) { posts.push(corpo.clientId); return { userCode: "ABCD-EFGH", authorizationCodeVerifier: "verifier", expiresIn: 600 }; } },
      token: { ...token, trocarAuthorizationCodePorToken: async () => ({ accessToken: "AT-novo", refreshToken: "RT-novo", tokenType: "bearer", expiraEm: new Date(Date.now() + 3 * 3_600_000).toISOString() }) },
    };
    const ini = await auth.iniciarConexao({ organizacaoId: ORG, unidadeId: UN_NOVA, appType: "order", usuarioId: null, deps });
    assert.equal(posts[0], "order-id", "app de pedidos, nunca o de teste");
    assert.equal(q(`select finalidade from ifood_oauth_sessoes where id = '${ini.sessionId}'`), "pedidos_producao", "a sessão carrega a finalidade");
    const fim = await auth.concluirAutorizacao({ organizacaoId: ORG, unidadeId: UN_NOVA, appType: "order", sessaoId: ini.sessionId, authorizationCode: "codigo", usuarioId: null, deps });
    assert.equal(fim.status, "authorized");
    const nova = q(`select id from ifood_conexoes where unidade_id = '${UN_NOVA}' and finalidade = 'pedidos_producao' and status <> 'revogada'`);
    assert.ok(nova, "conexão de pedidos criada");
    assert.equal(q(`select ambiente from ifood_conexoes where id = '${nova}'`), "producao");
    assert.equal(q(`select string_agg(app_type, ',') from ifood_credenciais where conexao_id = '${nova}'`), "order", "a credencial Order foi para a conexão NOVA");
    assert.equal(snap(CON_NOVA_TESTE), antes, "conexão e credenciais de teste intactas");
  });

  test("Order com o banco recusando credencial order na conexão de teste: a defesa final do banco vale mesmo se o código errasse", () => {
    const r = psqlSync(b.url, cred(CON_TESTE, "order"));
    assert.equal(r.ok, false);
    assert.match(r.err, /nunca recebe credencial order/);
  });

  test("desconexão independente com SQL real: sem id e com duas vivas = recusa; com o id da conexão de pedidos revoga só ela", async () => {
    const antesTeste = snap(CON_TESTE);
    await assert.rejects(conexaoSvc.desconectar({ organizacaoId: ORG, unidadeId: UN_NORTH, usuarioId: null }), (e) => e.codigo === "IFOOD_CONEXAO_AMBIGUA");
    assert.equal(q(`select count(*) from ifood_conexoes where unidade_id = '${UN_NORTH}' and status <> 'revogada'`), "2");
    await assert.rejects(conexaoSvc.desconectar({ organizacaoId: ORG, unidadeId: UN_NORTH, usuarioId: null, conexaoId: CON_OUTRA }), (e) => e.codigo === "IFOOD_CONEXAO_NAO_ENCONTRADA", "conexão de outra empresa");
    const r = await conexaoSvc.desconectar({ organizacaoId: ORG, unidadeId: UN_NORTH, usuarioId: null, conexaoId: CON_REAL });
    assert.equal(r.jaDesconectado, false);
    assert.equal(q(`select status from ifood_conexoes where id = '${CON_REAL}'`), "revogada");
    assert.equal(q(`select count(*) from ifood_credenciais where conexao_id = '${CON_REAL}'`), "0");
    assert.equal(snap(CON_TESTE), antesTeste, "o Financial de homologação segue exatamente como estava");
    assert.equal(q(`select status from ifood_conexoes where id = '${CON_SACI}'`), "ativa");
    // poller: a conexão revogada sai das elegíveis; a Saci continua
    assert.deepEqual((await repoEv.listarConexoesElegiveisParaEvents({ db: dbSql() })).map((c) => c.id).filter((id) => [CON_SACI, CON_REAL].includes(id)), [CON_SACI]);
  });
});
