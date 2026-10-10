// O script de auditoria SOMENTE-LEITURA (database/auditoria/6b5-catalogo-somente-leitura.sql) que o responsável vai rodar na produção:
//   * estático: só lê o catálogo, termina em ROLLBACK dentro de transação READ ONLY, não toca em tabela de negócio nem em segredo;
//   * dinâmico (Postgres descartável com o schema real): roda sem erro, não escreve, e DETECTA o risco antes da 115 e o fim dele depois.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55420/postgres node --test test/auditoria-catalogo-sql.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { motivoPular, criarBancoDescartavel, sql, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal, MIGRATIONS_DIR } from "./helpers/schema-real-pg.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "database", "auditoria", "6b5-catalogo-somente-leitura.sql");
const fonte = readFileSync(SCRIPT, "utf8");
const semComentarios = fonte.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");

describe("auditoria de catálogo — estático", () => {
  test("transação READ ONLY que termina em ROLLBACK; nenhum comando que escreva ou mude estado", () => {
    assert.match(semComentarios, /^\s*begin transaction read only;/im); assert.match(semComentarios, /rollback;\s*$/i);
    // palavras dentro de 'literais' (ex.: 'update' de has_table_privilege) não são comandos
    const semLiterais = semComentarios.replace(/'(?:[^']|'')*'/g, "''");
    assert.doesNotMatch(semLiterais, /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|vacuum|analyze|set\s+role|set_config|pg_terminate|pg_cancel|do\s+\$)\b/i);
    assert.doesNotMatch(semLiterais, /\b(commit|pg_read_file|pg_ls_dir|lo_import|dblink|http_|net\.)\b/i);
  });

  test("só consulta catálogo: toda tabela/visão em FROM/JOIN é pg_* ou information_schema (nunca tabela de negócio, auth.users ou storage.objects)", () => {
    const alvos = [...semComentarios.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi)].map((m) => m[1].toLowerCase());
    const permitidos = alvos.filter((a) => !/^(pg_[a-z_]+|unnest|aclexplode|information_schema\..+)$/.test(a));
    assert.deepEqual([...new Set(permitidos)], [], `alvos fora do catálogo: ${permitidos}`);
    assert.doesNotMatch(semComentarios, /auth\.users|storage\.objects|vault\.|secrets|encrypted|password|\bkey\b/i);
  });

  test("a única configuração lida é a de chaves pgrst.* da role authenticator (nada de segredo)", () => {
    const usos = semComentarios.match(/rolconfig/g) ?? [];
    assert.equal(usos.length, 1); assert.match(semComentarios, /c ~ '\^pgrst\\\.\(db_schemas\|db_extra_search_path\|db_max_rows\|db_anon_role\|db_pre_request\|db_plan_enabled\)='/);
  });

  test("cobre as 16 seções do checkpoint (versão, migrations, roles, grants, views, unidade_config, RPCs, exposição, realtime)", () => {
    for (const s of ["1.versao", "2c.impressao", "3.roles", "4.default_acl", "5.membros", "6.pgrst", "7.views", "7b.views_acl", "7c.views_definicao", "8.unidade_config", "9.sem_rls", "10.rpcs", "10b.", "10c.", "11.funcoes_expostas", "12.fora_de_public", "13.sequences", "14.publicacao_realtime", "15.policies", "16.auth_unidade_ids"]) {
      assert.ok(fonte.includes(`'${s}`), `faltou a seção ${s}`);
    }
  });
});

describe("auditoria de catálogo — dinâmico (Postgres descartável, schema real)", { skip: motivoPular, timeout: 300_000 }, () => {
  let b; let antes; let depois;
  const rodar = () => {
    const r = psqlSync(b.url, "", { arquivo: SCRIPT, formato: "-t -A -F|" });
    assert.equal(r.ok, true, r.err);
    return r.out.split(/\r?\n/).filter((l) => /^\d/.test(l)).map((l) => l.split("|"));
  };
  const secao = (linhas, nome) => linhas.filter((l) => l[0] === nome);

  before(() => {
    b = criarBancoDescartavel("audit_catalogo");
    assert.deepEqual(construirSchemaReal(b.url, { ate: 113 }), []);
    sql(b.url, `do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if; end $$;
      alter role authenticator set pgrst.db_schemas = 'public,graphql_public'; alter role authenticator set pgrst.db_max_rows = '1000';`);
    antes = rodar();
    for (const f of ["114_rls_exclui_papel_exibicao.sql", "115_fecha_acesso_direto_residual.sql"]) assert.equal(psqlSync(b.url, "", { arquivo: join(MIGRATIONS_DIR, f) }).ok, true);
    depois = rodar();
  });
  after(() => b?.derrubar());

  test("roda sem erro, não escreve nada e devolve todas as seções", () => {
    for (const s of ["1.versao", "2a.tabela_de_controle", "2c.impressao", "3.roles", "4.default_acl", "6.pgrst", "7.views", "7b.views_acl", "7c.views_definicao", "8.unidade_config", "9b.rls_sem_policy", "10.rpcs", "11.funcoes_expostas", "13.sequences", "15.policies", "16.auth_unidade_ids"]) {
      assert.ok(secao(antes, s).length > 0, `sem linhas na seção ${s}`);
    }
    assert.match(secao(antes, "1.versao")[0][1], /PostgreSQL/);
    assert.equal(secao(antes, "6.pgrst").find((l) => l[1] === "pgrst.db_schemas")[2], "public,graphql_public");
  });

  test("ANTES da 114/115 o script MOSTRA o risco: 4 views sem opções legíveis por anon, unidade_config sem RLS, 7 RPCs executáveis, impressões 114/115 ausentes", () => {
    const views = secao(antes, "7.views").filter((l) => l[1].startsWith("vw_"));
    assert.equal(views.length, 4);
    assert.ok(views.every((l) => l[3].includes("roda como o DONO") && l[4] === "t" && l[5] === "t"), JSON.stringify(views));
    const cfg = secao(antes, "8.unidade_config")[0]; assert.deepEqual([cfg[2], cfg[7], cfg[8]], ["f", "t", "t"], "sem RLS e com UPDATE/SELECT para anon/authenticated");
    assert.deepEqual(secao(antes, "9.sem_rls").map((l) => l[1]), ["unidade_config"]);
    const rpcs = secao(antes, "10.rpcs"); assert.equal(rpcs.length, 7); assert.ok(rpcs.every((l) => l[2] === "f" && l[5] === "t" && l[6] === "t" && l[8] === "t"), "INVOKER; anon, authenticated e PUBLIC executam");
    const imp = Object.fromEntries(secao(antes, "2c.impressao").map((l) => [l[1], l[2]]));
    assert.equal(imp["112 valor display_operator no enum"], "t"); assert.equal(imp["114 auth_unidade_ids ignora display_operator"], "f");
    assert.equal(imp["115 unidade_config com RLS ligado"], "f"); assert.equal(imp["115 views sem SELECT p/ anon/authenticated"], "f");
    assert.ok(secao(antes, "7b.views_acl").some((l) => l[2] === "anon" && l[4] === "SELECT"), "ACL decodificada mostra anon com SELECT");
    assert.match(secao(antes, "16.auth_unidade_ids")[0][1], /^(?!.*display_operator)/);
  });

  test("DEPOIS da 114/115 o script mostra tudo fechado: views sem SELECT, unidade_config com RLS, RPCs só para service_role, impressões presentes", () => {
    const views = secao(depois, "7.views").filter((l) => l[1].startsWith("vw_"));
    assert.ok(views.every((l) => l[4] === "f" && l[5] === "f" && l[6] === "t"), JSON.stringify(views));
    assert.equal(secao(depois, "7b.views_acl").length, 0, "nenhum privilégio de PUBLIC/anon/authenticated nas views");
    const cfg = secao(depois, "8.unidade_config")[0]; assert.deepEqual([cfg[2], cfg[5]], ["t", "0"], "RLS ligado e zero policies = nega tudo a anon/authenticated (o privilégio nominal permanece, o RLS é que nega; service_role ignora RLS)");
    assert.deepEqual(secao(depois, "9.sem_rls"), []);
    const rpcs = secao(depois, "10.rpcs"); assert.equal(rpcs.length, 7);
    assert.ok(rpcs.every((l) => l[5] === "f" && l[6] === "f" && l[7] === "t" && l[8] === "f"), JSON.stringify(rpcs));
    const imp = Object.fromEntries(secao(depois, "2c.impressao").map((l) => [l[1], l[2]]));
    for (const k of ["112 valor display_operator no enum", "113 constraint uo_sem_papel_exibicao", "114 auth_unidade_ids ignora display_operator", "115 unidade_config com RLS ligado", "115 views sem SELECT p/ anon/authenticated"]) assert.equal(imp[k], "t", k);
    assert.match(secao(depois, "16.auth_unidade_ids")[0][1], /display_operator/);
  });

  test("funções expostas: só as auxiliares de RLS, fn_custo_* e nada mais; SECURITY DEFINER sempre com search_path fixo", () => {
    const expostas = secao(depois, "11.funcoes_expostas");
    const nomes = expostas.map((l) => l[1].split("(")[0].replace(/^public\./, "")).sort();
    assert.deepEqual(nomes, ["auth_organizacao_id", "auth_organizacao_ids", "auth_unidade_id", "auth_unidade_ids", "fn_custo_produto", "fn_recalc_custo", "is_platform_superadmin", "tem_grant_realtime"]);
    for (const l of expostas.filter((x) => x[2] === "t")) assert.match(l[3], /search_path=/, l[1]);
  });

  test("a saída não contém dado de cliente nem segredo: só nomes de objeto, flags, contagens e código de função", () => {
    const tudo = antes.concat(depois).map((l) => l.join("|")).join("\n");
    assert.doesNotMatch(tudo, /@teste\.invalid|eyJ[A-Za-z0-9_-]{10,}|postgres(ql)?:\/\/|sb_secret|service_role_key/i);
    assert.equal(secao(antes, "6.pgrst").every((l) => l[1].startsWith("pgrst.")), true);
  });
});
