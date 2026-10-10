// Consulta ÚNICA de auditoria (database/auditoria/6b6-catalogo-consulta-unica.sql) — a que o responsável cola no SQL Editor do Supabase
// (que só mostra o resultado do último comando). Garante: UM comando SELECT, só catálogo, sem escrita/configuração, sem dado de cliente nem segredo;
// roda sem erro num Postgres descartável com o schema real, mostra o risco ANTES e tudo fechado DEPOIS da 114/115; nunca devolve valor sensível.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --test test/auditoria-consulta-unica.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "database", "auditoria", "6b6-catalogo-consulta-unica.sql");
const fonte = readFileSync(SCRIPT, "utf8");
const semComentarios = fonte.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
const semLiterais = semComentarios.replace(/'(?:[^']|'')*'/g, "''");

describe("consulta única — estático", () => {
  test("é UM único comando SELECT: um só ponto-e-vírgula, no fim; sem BEGIN/COMMIT/SET/DO/DDL/DML/GRANT/REVOKE/COPY", () => {
    assert.equal((semLiterais.match(/;/g) ?? []).length, 1, "um único comando");
    assert.match(semLiterais.trim(), /;$/); assert.match(semLiterais.trim(), /^select\b/i);
    assert.doesNotMatch(semLiterais, /\b(begin|commit|rollback|savepoint|set|reset|do|insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|vacuum|analyze|lock|listen|notify|call|execute|prepare|declare|fetch)\b/i);
    assert.doesNotMatch(semLiterais, /\b(set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_read_file|pg_ls_dir|lo_import|lo_export|dblink|nextval|setval|pg_advisory\w*|http_\w+)\b/i);
  });

  test("só catálogo: toda tabela em FROM/JOIN é pg_*, uma lista VALUES/unnest/aclexplode ou a tabela de controle de migrations (lida só se existir)", () => {
    const alvos = [...semLiterais.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi)].map((m) => m[1].toLowerCase());
    const estranhos = alvos.filter((a) => !/^(pg_[a-z_]+|unnest|aclexplode|t)$/.test(a));
    assert.deepEqual([...new Set(estranhos)], [], `alvos fora do catálogo: ${estranhos}`);
    // a ÚNICA leitura fora do catálogo está dentro de literal e protegida por to_regclass
    const fora = [...semComentarios.matchAll(/from\s+([a-z_]+\.[a-z_]+)/gi)].map((m) => m[1]).filter((n) => !/^pg_|information_schema/.test(n));
    assert.deepEqual([...new Set(fora)], ["supabase_migrations.schema_migrations"]);
    assert.match(semComentarios, /case when to_regclass\('supabase_migrations\.schema_migrations'\) is not null/);
    assert.doesNotMatch(semComentarios, /auth\.users|storage\.objects|vault\.|secrets|encrypted_|password|jwt_secret|\bkey\b|rolpassword|pg_authid|pg_shadow|pg_user_mapping|pg_settings/i);
  });

  test("a única configuração lida é a lista FIXA de chaves pgrst.* (jwt/secrets ficam de fora)", () => {
    assert.equal((semComentarios.match(/rolconfig/g) ?? []).length, 1);
    assert.match(semComentarios, /c ~ '\^pgrst\\\.\(db_schemas\|db_extra_search_path\|db_max_rows\|db_anon_role\|db_pre_request\|db_plan_enabled\)='/);
    assert.doesNotMatch(semComentarios, /jwt_secret|jwt_aud|db_uri|service_role_key/i);
  });

  test("cobre as seções do pedido (versão, migrations, roles, grants, exposição, views, unidade_config, RPCs, outros objetos, policies, Realtime)", () => {
    for (const s of ["1.versao", "2a.", "2b.", "2c.impressao", "3.roles", "4.default_acl", "5.membros", "6.pgrst", "7.views", "7b.views_acl", "7c.views_definicao", "8.unidade_config", "9.sem_rls", "10.rpcs", "10b.", "10c.", "11.funcoes_expostas", "12.fora_de_public", "13.sequences", "14.publicacao_realtime", "15.policies", "16.auth_unidade_ids"]) {
      assert.ok(fonte.includes(`'${s}`), `faltou a seção ${s}`);
    }
  });

  test("o cabeçalho explica o limite do SQL Editor (só o último resultado) e como executar com segurança", () => {
    assert.match(fonte, /mostra apenas o resultado do ÚLTIMO comando/); assert.match(fonte, /NÃO use a service_role key/);
  });
});

describe("consulta única — dinâmico (Postgres descartável, schema real)", { skip: motivoPular, timeout: 300_000 }, () => {
  let b; let antes; let depois;
  const SEP = "~~";
  const rodar = () => {
    const r = psqlSync(b.url, "", { arquivo: SCRIPT, formato: `-t -A -F${SEP}` });
    assert.equal(r.ok, true, r.err);
    return r.out.split(/\r?\n/).filter((l) => /^\d+[a-z]?\./.test(l)).map((l) => l.split(SEP));
  };
  const secao = (linhas, nome) => linhas.filter((l) => l[0] === nome);

  before(() => {
    b = criarBancoDescartavel("audit_unica");
    assert.deepEqual(construirSchemaReal(b.url, { ate: 113 }), []);
    sql(b.url, `do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if; end $$;
      alter role authenticator set pgrst.db_schemas = 'public,graphql_public'; alter role authenticator set pgrst.db_max_rows = '1000';
      alter role authenticator set pgrst.jwt_secret = 'SEGREDO-DE-TESTE-QUE-NAO-PODE-APARECER';`);
    antes = rodar();
    for (const f of ["114_rls_exclui_papel_exibicao.sql", "115_fecha_acesso_direto_residual.sql"]) assert.equal(psqlSync(b.url, "", { arquivo: join(MIGRATIONS_DIR, f) }).ok, true);
    depois = rodar();
  });
  after(() => b?.derrubar());

  test("roda sem erro, num único resultado, com todas as seções; chaves pgrst.* só da lista permitida (o segredo de teste NÃO aparece)", () => {
    for (const s of ["1.versao", "2a.tabela_de_controle", "2b.migrations_registradas", "2c.impressao", "3.roles", "4.default_acl", "6.pgrst", "7.views", "7b.views_acl", "7c.views_definicao", "8.unidade_config", "9b.rls_sem_policy", "10.rpcs", "11.funcoes_expostas", "13.sequences", "15.policies", "16.auth_unidade_ids"]) {
      assert.ok(secao(antes, s).length > 0, `sem linhas na seção ${s}`);
    }
    const pgrst = secao(antes, "6.pgrst"); assert.deepEqual(pgrst.map((l) => l[1]).sort(), ["pgrst.db_max_rows", "pgrst.db_schemas"]);
    assert.ok(!antes.concat(depois).flat().join(" ").includes("SEGREDO-DE-TESTE"), "segredo de configuração nunca é lido");
    assert.match(secao(antes, "1.versao")[0][1], /PostgreSQL/);
  });

  test("migrations registradas (2b): lê a tabela de controle SÓ quando existe, devolvendo apenas as versões", () => {
    assert.equal(secao(antes, "2a.tabela_de_controle")[0][1], "não existe");
    assert.match(secao(antes, "2b.migrations_registradas")[0][1], /sem tabela de controle/);
    sql(b.url, "create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, name text, statements text[]); insert into supabase_migrations.schema_migrations values ('20260101000000', 'segredo-nao-lido', '{select 1}');");
    const com = rodar();
    assert.equal(secao(com, "2b.migrations_registradas")[0][1], "20260101000000");
    assert.ok(!com.flat().join(" ").includes("segredo-nao-lido"), "só a versão: nome e statements não saem");
    sql(b.url, "drop schema supabase_migrations cascade");
  });

  test("ANTES da 114/115: mostra o risco (views como dono e legíveis por anon, unidade_config sem RLS, 7 RPCs executáveis, impressões ausentes)", () => {
    const views = secao(antes, "7.views").filter((l) => l[1].startsWith("vw_"));
    assert.equal(views.length, 4); assert.ok(views.every((l) => l[3].includes("roda como o DONO") && l[4] === "anon_select=true" && l[5] === "auth_select=true"), JSON.stringify(views));
    const cfg = secao(antes, "8.unidade_config")[0]; assert.deepEqual([cfg[2], cfg[5]], ["rls_ligado=false", "policies=0"]); assert.match(cfg[6], /anon_upd=true/);
    assert.deepEqual(secao(antes, "9.sem_rls").map((l) => l[1]), ["unidade_config"]);
    const rpcs = secao(antes, "10.rpcs"); assert.equal(rpcs.length, 7);
    assert.ok(rpcs.every((l) => l[2] === "security_definer=false" && /anon=true authenticated=true/.test(l[5]) && l[6] === "public=true"), JSON.stringify(rpcs));
    const imp = Object.fromEntries(secao(antes, "2c.impressao").map((l) => [l[1], l[2]]));
    assert.equal(imp["112 valor display_operator no enum"], "true"); assert.equal(imp["114 auth_unidade_ids ignora display_operator"], "false");
    assert.equal(imp["115 unidade_config com RLS ligado"], "false"); assert.equal(imp["115 views sem SELECT p/ anon/authenticated"], "false");
    assert.ok(secao(antes, "7b.views_acl").some((l) => l[2] === "anon" && l[4] === "SELECT"));
    assert.doesNotMatch(secao(antes, "16.auth_unidade_ids")[0][1], /display_operator/);
  });

  test("DEPOIS da 114/115: tudo fechado (views sem privilégio, unidade_config com RLS e zero policies, RPCs só para service_role, impressões presentes)", () => {
    const views = secao(depois, "7.views").filter((l) => l[1].startsWith("vw_"));
    assert.ok(views.every((l) => l[4] === "anon_select=false" && l[5] === "auth_select=false" && l[6] === "service_select=true"), JSON.stringify(views));
    assert.equal(secao(depois, "7b.views_acl").length, 0);
    const cfg = secao(depois, "8.unidade_config")[0]; assert.deepEqual([cfg[2], cfg[5]], ["rls_ligado=true", "policies=0"]);
    assert.deepEqual(secao(depois, "9.sem_rls"), []);
    const rpcs = secao(depois, "10.rpcs"); assert.ok(rpcs.every((l) => /anon=false authenticated=false service_role=true/.test(l[5]) && l[6] === "public=false"), JSON.stringify(rpcs));
    const imp = Object.fromEntries(secao(depois, "2c.impressao").map((l) => [l[1], l[2]]));
    for (const k of ["112 valor display_operator no enum", "113 constraint uo_sem_papel_exibicao", "114 auth_unidade_ids ignora display_operator", "115 unidade_config com RLS ligado", "115 views sem SELECT p/ anon/authenticated"]) assert.equal(imp[k], "true", k);
    assert.match(secao(depois, "16.auth_unidade_ids")[0][1], /display_operator/);
  });

  test("é somente-leitura DE FATO: roda em transação READ ONLY sem erro e não altera nenhuma tabela do catálogo de usuário (contagem de linhas e versão do schema iguais)", () => {
    const foto = () => sql(b.url, "select (select count(*) from pg_class where relnamespace = 'public'::regnamespace) || '/' || (select count(*) from pg_proc where pronamespace = 'public'::regnamespace) || '/' || (select count(*) from pg_policy) || '/' || (select md5(string_agg(coalesce(relacl::text, '') || coalesce(relrowsecurity::text, ''), '|' order by oid)) from pg_class where relnamespace = 'public'::regnamespace)");
    const f0 = foto();
    const r = psqlSync(b.url, `begin transaction read only; ${fonte}\nrollback;`, { formato: `-t -A -F${SEP}` });
    assert.equal(r.ok, true, r.err);
    assert.equal(foto(), f0);
  });

  test("a saída não contém dado de cliente nem segredo: sem e-mails, tokens, URLs de conexão ou chaves", () => {
    const tudo = antes.concat(depois).map((l) => l.join(" ")).join("\n");
    assert.doesNotMatch(tudo, /@[a-z0-9-]+\.[a-z]{2,}|eyJ[A-Za-z0-9_-]{10,}|postgres(ql)?:\/\/|sb_secret|sb_publishable|service_role_key|jwt_secret/i);
  });
});
