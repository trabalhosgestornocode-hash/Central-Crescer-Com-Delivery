// MIGRATION 110 (telas de exibição + pareamento) contra um Postgres REAL e DESCARTÁVEL — isolamento entre empresas e
// unidades, privilégios, unicidade de tokens, pareamento de uso único, aprovação/consumo concorrentes, expiração,
// inatividade, revogação (manual, em massa, unidade transferida/desativada), rotação sem tela órfã, reuso do token
// anterior SEM revogação indevida, fail-closed (empresa bloqueada, módulo retirado), limpeza e rollback.
// PULA sozinho sem EXIBICAO_PG_URL (nunca roda contra Supabase/produção). Aponte para um banco VAZIO e descartável:
//   initdb -D <dir> -U postgres -A trust && pg_ctl -D <dir> -o "-p 55410" start
//   EXIBICAO_PG_URL=postgresql://postgres@127.0.0.1:55410/postgres node --test test/exibicao-migration-110-pg.test.js
// O teste cria os papéis do Supabase e versões MÍNIMAS de organizacoes/unidades/organizacao_modulos/perfis_operacionais
// SE não existirem (dados fictícios), e aplica a migration 110 REAL.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const aqui = dirname(fileURLToPath(import.meta.url));
const URL_PG = (process.env.EXIBICAO_PG_URL || "").trim();
const PSQL = process.env.EXIBICAO_PSQL || "psql";
const motivoPular = URL_PG ? false : "EXIBICAO_PG_URL ausente — precisa de um Postgres descartável (veja o cabeçalho). PULADO — não é falha.";
const MIG = join(aqui, "..", "..", "database", "migrations");

// Empresas/unidades/contas fictícias.
const ORG_A = "a0000000-0000-4000-8000-00000000000a";
const ORG_B = "b0000000-0000-4000-8000-00000000000b";
const UNI_A1 = "a1000000-0000-4000-8000-0000000000a1";
const UNI_A2 = "a2000000-0000-4000-8000-0000000000a2";
const UNI_B1 = "b1000000-0000-4000-8000-0000000000b1";
const CONTA = "c0000000-0000-4000-8000-00000000000c";
const PERFIL = "d0000000-0000-4000-8000-00000000000d";

const sha = (s) => createHash("sha256").update(s).digest("hex");
let seq = 0;
const novo = (rotulo) => sha(`${rotulo}-${++seq}-${Math.random()}`);

function psql(sql, { arquivo, papel } = {}) {
  const corpo = papel ? `set role ${papel}; ${sql}` : sql;
  const args = [URL_PG, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "|", ...(arquivo ? ["-f", arquivo] : ["-c", corpo])];
  const r = spawnSync(PSQL, args, { encoding: "utf8", timeout: 60_000, env: { ...process.env, PGOPTIONS: "-c lc_messages=C", PGCLIENTENCODING: "UTF8" } });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const ok = (sql, opts) => { const r = psql(sql, opts); assert.equal(r.ok, true, `${sql}\n${r.err}`); return r.out; };
const falha = (sql, trecho, opts) => {
  const r = psql(sql, opts);
  assert.equal(r.ok, false, `deveria falhar: ${sql}`);
  if (trecho) assert.ok(r.err.includes(trecho), `esperava "${trecho}"; veio: ${r.err}`);
  return r.err;
};
const aplicar = (arquivo) => { const r = psql("", { arquivo: join(MIG, arquivo) }); return r; };

/** Executa como o backend (service_role), que é o único papel com EXECUTE nas funções. */
const comoBackend = (sql) => ok(sql, { papel: "service_role" });

// ---- atalhos do fluxo -------------------------------------------------------------------------------------------
function iniciar({ codigo = novo("codigo"), segredo = novo("segredo"), validade = 600, rede = "200.10.20.0/24" } = {}) {
  const out = comoBackend(`select resultado || '|' || coalesce(pareamento_id::text, '-') from exibicao_pareamento_iniciar('${codigo}', '${segredo}', ${validade}, '${rede}', 'Chrome / Android TV')`);
  const [resultado, id] = out.split("|");
  return { resultado, id, codigo, segredo };
}
const aprovar = ({ codigo, org = ORG_A, unidade = UNI_A1, nome = "TV Cozinha", modo = "tv" }) =>
  comoBackend(`select resultado from exibicao_pareamento_aprovar('${codigo}', '${org}', '${unidade}', '${CONTA}', '${PERFIL}', '${nome}', '${modo}')`);
function consumir({ segredo, token = novo("token"), limite = 10 }) {
  const out = comoBackend(`select resultado || '|' || coalesce(dispositivo_id::text, '-') from exibicao_pareamento_consumir('${segredo}', '${token}', 90, 30, ${limite})`);
  const [resultado, id] = out.split("|");
  return { resultado, id, token };
}
/** Cria uma tela completa (pedido -> aprovação -> consumo) e devolve id + token (hash). */
function criarTela(opts = {}) {
  const p = iniciar();
  assert.equal(p.resultado, "ok");
  assert.equal(aprovar({ codigo: p.codigo, ...opts }), "ok");
  // Limite alto: os testes acumulam telas na mesma unidade (o limite real é testado à parte).
  const c = consumir({ segredo: p.segredo, limite: opts.limite ?? 100 });
  assert.equal(c.resultado, "ok", `consumo: ${c.resultado}`);
  return c;
}
const resolver = (token, rede = "200.10.20.0/24") =>
  comoBackend(`select resultado || '|' || coalesce(unidade_id::text, '-') || '|' || rotacao_devida from exibicao_dispositivo_resolver('${token}', '${rede}', 'Chrome / Android TV')`).split("|");

describe("MIGRATION 110 em Postgres real e descartável", { skip: motivoPular }, () => {
  before(() => {
    ok(`do $$ begin
          if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
          if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
          if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
          if not exists (select 1 from pg_type where typname = 'status_organizacao') then
            create type status_organizacao as enum ('ativa', 'teste', 'bloqueada', 'suspensa', 'cancelada');
          end if;
        end $$;`);
    ok(`create table if not exists organizacoes (id uuid primary key, nome text not null, ativo boolean not null default true,
          status status_organizacao not null default 'ativa');
        create table if not exists unidades (id uuid primary key, organizacao_id uuid not null references organizacoes(id),
          nome text not null, ativo boolean not null default true);
        create table if not exists organizacao_modulos (organizacao_id uuid not null, modulo_id text not null,
          primary key (organizacao_id, modulo_id));
        create table if not exists perfis_operacionais (id uuid primary key, nome text);`);
    ok(`insert into organizacoes (id, nome) values ('${ORG_A}', 'Empresa A (teste)'), ('${ORG_B}', 'Empresa B (teste)') on conflict do nothing;
        insert into unidades (id, organizacao_id, nome) values
          ('${UNI_A1}', '${ORG_A}', 'Unidade A1'), ('${UNI_A2}', '${ORG_A}', 'Unidade A2'), ('${UNI_B1}', '${ORG_B}', 'Unidade B1')
          on conflict do nothing;
        insert into organizacao_modulos values ('${ORG_A}', 'ifood'), ('${ORG_B}', 'ifood') on conflict do nothing;
        insert into perfis_operacionais (id, nome) values ('${PERFIL}', 'Gerente (teste)') on conflict do nothing;`);
    // Banco limpo de uma execução anterior (só objetos desta migration).
    aplicar("110_rollback.sql");
    const r = aplicar("110_exibicao_dispositivos.sql");
    assert.equal(r.ok, true, r.err);
  });
  after(() => { if (URL_PG) { ok("update dispositivos_exibicao set revogado_em = now(), motivo_revogacao = 'manual' where revogado_em is null"); } });

  describe("privilégios e exposição", () => {
    test("tabelas sem acesso direto para nenhum papel (nem service_role); RLS ligada", () => {
      for (const papel of ["anon", "authenticated", "service_role"]) {
        falha("select count(*) from dispositivos_exibicao", "permission denied", { papel });
        falha("select count(*) from pareamentos_exibicao", "permission denied", { papel });
      }
      assert.equal(ok("select string_agg(relname || ':' || relrowsecurity, ',' order by relname) from pg_class where relname in ('dispositivos_exibicao','pareamentos_exibicao')"),
        "dispositivos_exibicao:true,pareamentos_exibicao:true");
    });
    test("funções: só o service_role executa; anon/authenticated não", () => {
      for (const papel of ["anon", "authenticated"]) {
        falha(`select exibicao_dispositivo_resolver('${"0".repeat(64)}', null, null)`, "permission denied", { papel });
        falha(`select exibicao_pareamento_iniciar('${novo("c")}', '${novo("s")}', 300, null, null)`, "permission denied", { papel });
      }
      falha(`select exibicao_unidade_elegivel('${ORG_A}', '${UNI_A1}')`, "permission denied", { papel: "service_role" });
    });
    test("todas as funções SECURITY DEFINER com search_path fixo", () => {
      const linhas = ok(`select p.proname || ':' || p.prosecdef || ':' || coalesce(array_to_string(p.proconfig, ';'), '')
                           from pg_proc p where p.proname like 'exibicao\\_%' order by 1`).split("\n");
      assert.ok(linhas.length >= 14);
      for (const l of linhas) assert.match(l, /search_path=pg_catalog, pg_temp/, l);
      for (const l of linhas.filter((x) => !x.startsWith("exibicao_conferir_tenant"))) assert.match(l, /:true:/, l);
    });
    test("nenhuma função de gestão ou de estado devolve hash/segredo", () => {
      const colunas = ok(`select string_agg(p.proname || '.' || a, ',') from pg_proc p, unnest(p.proargnames) a
                           where p.proname in ('exibicao_dispositivos_listar','exibicao_pareamento_estado','exibicao_dispositivo_resolver')
                             and a is not null`);
      assert.doesNotMatch(colunas.replace(/p_token_hash|p_segredo_hash/g, ""), /hash|segredo|token/);
      const t = criarTela();
      const listagem = comoBackend(`select row_to_json(l)::text from exibicao_dispositivos_listar('${ORG_A}', '${UNI_A1}') l`);
      assert.ok(!listagem.includes(t.token), "a listagem não contém o hash do token");
      assert.doesNotMatch(listagem, /[0-9a-f]{64}/);
    });
    test("sombra no schema public NÃO sequestra as funções (papel com CREATE em public)", () => {
      ok(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'atacante_teste') then create role atacante_teste; end if; end $$;
          grant usage, create on schema public to atacante_teste;
          create table if not exists public.prova_sombra (quem text);
          grant insert on public.prova_sombra to atacante_teste;
          truncate public.prova_sombra;`);
      // Sobrecargas com a assinatura EXATA dos argumentos usados nas funções (antes: venciam a nativa).
      ok(`set role atacante_teste;
          create or replace function public.hashtextextended(t text, s integer) returns bigint language sql as $f$ insert into public.prova_sombra values (current_user) returning 1::bigint $f$;
          create or replace function public.make_interval(secs integer) returns interval language sql as $f$ insert into public.prova_sombra values (current_user) returning interval '1 second' $f$;
          create or replace function public.left(t text, n integer) returns text language sql as $f$ insert into public.prova_sombra values (current_user) returning t $f$;
          create or replace function public.now() returns timestamptz language sql as $f$ insert into public.prova_sombra values (current_user) returning clock_timestamp() $f$;`);
      const t = criarTela();
      resolver(t.token);
      comoBackend(`select count(*) from exibicao_dispositivos_listar('${ORG_A}', '${UNI_A1}')`);
      assert.equal(ok("select count(*) from public.prova_sombra"), "0", "nenhuma função do atacante executou");
      ok(`drop function public.hashtextextended(text, integer); drop function public.make_interval(integer);
          drop function public."left"(text, integer); drop function public.now(); drop table public.prova_sombra;
          revoke create on schema public from atacante_teste;`);
    });
    test("formato: só hash hex de 64 é aceito (texto em claro é recusado)", () => {
      falha(`insert into dispositivos_exibicao (organizacao_id, unidade_id, nome, token_hash, autorizado_por_conta_id, expira_em)
             values ('${ORG_A}', '${UNI_A1}', 'X', 'meu-token-em-claro', '${CONTA}', now() + interval '1 day')`, "dispositivos_exibicao_token_hex");
      falha(`insert into pareamentos_exibicao (codigo_hash, segredo_hash, expira_em) values ('ABCD-1234', '${novo("s")}', now() + interval '5 min')`,
        "pareamentos_exibicao_codigo_hex");
    });
  });

  describe("isolamento entre empresas e unidades", () => {
    test("a tela pertence a UMA empresa+unidade e a resolução devolve só ela", () => {
      const t = criarTela({ unidade: UNI_A1 });
      const [resultado, unidade] = resolver(t.token);
      assert.equal(resultado, "ok");
      assert.equal(unidade, UNI_A1);
    });
    test("outra empresa/unidade não lista, não renomeia e não revoga a tela", () => {
      const t = criarTela({ unidade: UNI_A1, nome: "TV Isolamento" });
      const listaB = comoBackend(`select count(*) from exibicao_dispositivos_listar('${ORG_B}', '${UNI_B1}') where id = '${t.id}'`);
      const listaA2 = comoBackend(`select count(*) from exibicao_dispositivos_listar('${ORG_A}', '${UNI_A2}') where id = '${t.id}'`);
      const listaCruzada = comoBackend(`select count(*) from exibicao_dispositivos_listar('${ORG_B}', '${UNI_A1}') where id = '${t.id}'`);
      assert.deepEqual([listaB, listaA2, listaCruzada], ["0", "0", "0"]);
      assert.equal(comoBackend(`select exibicao_dispositivo_renomear('${ORG_B}', '${UNI_B1}', '${t.id}', 'Hack')`), "nao_encontrado");
      assert.equal(comoBackend(`select exibicao_dispositivo_renomear('${ORG_A}', '${UNI_A2}', '${t.id}', 'Hack')`), "nao_encontrado");
      assert.equal(comoBackend(`select exibicao_dispositivos_revogar('${ORG_B}', '${UNI_B1}', '${t.id}', '${CONTA}')`), "0");
      assert.equal(comoBackend(`select exibicao_dispositivos_revogar('${ORG_A}', '${UNI_A2}', null, '${CONTA}')`), "0", "revogar A2 em massa não alcança A1");
      assert.equal(resolver(t.token)[0], "ok");
    });
    test("gestão sem empresa/unidade é recusada (escopo sempre explícito)", () => {
      falha(`select exibicao_dispositivos_revogar(null, null, null, '${CONTA}')`, "exige empresa", { papel: "service_role" });
      falha(`select exibicao_dispositivo_renomear(null, '${UNI_A1}', '${CONTA}', 'x')`, "exige empresa", { papel: "service_role" });
      assert.equal(comoBackend(`select count(*) from exibicao_dispositivos_listar(null, null)`), "0");
    });
    test("aprovar para unidade de OUTRA empresa é recusado (código não escolhe unidade livremente)", () => {
      const p = iniciar();
      assert.equal(aprovar({ codigo: p.codigo, org: ORG_A, unidade: UNI_B1 }), "unidade_indisponivel");
      assert.equal(comoBackend(`select estado from exibicao_pareamento_estado('${p.segredo}')`), "pendente");
    });
    test("integridade: unidade incoerente com a empresa e troca de unidade da tela são barradas pelo banco", () => {
      falha(`insert into dispositivos_exibicao (organizacao_id, unidade_id, nome, token_hash, autorizado_por_conta_id, expira_em)
             values ('${ORG_A}', '${UNI_B1}', 'X', '${novo("t")}', '${CONTA}', now() + interval '1 day')`, "unidade não pertence");
      const t = criarTela({ unidade: UNI_A1 });
      falha(`update dispositivos_exibicao set unidade_id = '${UNI_A2}' where id = '${t.id}'`, "não muda de empresa/unidade");
      falha(`insert into dispositivos_exibicao (organizacao_id, unidade_id, nome, token_hash, autorizado_por_conta_id, expira_em)
             values ('${ORG_A}', '${"e".repeat(8)}-0000-4000-8000-000000000000', 'X', '${novo("t")}', '${CONTA}', now() + interval '1 day')`, "unidade não pertence");
    });
  });

  describe("pareamento", () => {
    test("uso único: aprovar duas vezes e consumir duas vezes", () => {
      const p = iniciar();
      assert.equal(aprovar({ codigo: p.codigo }), "ok");
      assert.equal(aprovar({ codigo: p.codigo, unidade: UNI_A2 }), "indisponivel", "segunda aprovação (até para outra unidade) é recusada");
      const c1 = consumir({ segredo: p.segredo });
      assert.equal(c1.resultado, "ok");
      assert.equal(consumir({ segredo: p.segredo }).resultado, "ja_consumido");
      assert.equal(aprovar({ codigo: p.codigo }), "nao_encontrado", "código consumido não volta a existir");
    });
    test("antes da aprovação a tela só 'aguarda' e não vê a unidade; depois vê o nome", () => {
      const p = iniciar();
      assert.equal(consumir({ segredo: p.segredo }).resultado, "aguardando");
      assert.equal(comoBackend(`select estado || '|' || coalesce(unidade_nome, '-') from exibicao_pareamento_estado('${p.segredo}')`), "pendente|-");
      assert.equal(aprovar({ codigo: p.codigo, nome: "TV Salao" }), "ok");
      assert.equal(comoBackend(`select estado || '|' || unidade_nome || '|' || nome_dispositivo from exibicao_pareamento_estado('${p.segredo}')`), "aprovado|Unidade A1|TV Salao");
    });
    test("consulta antes de aprovar: só metadados do pedido pendente (quando, navegador, rede) — nada de unidade/hash", () => {
      const p = iniciar({ rede: "192.0.2.0/24" });
      assert.equal(comoBackend(`select resultado || '|' || navegador_resumo || '|' || rede_prefixo || '|' || (expira_em > criado_em) from exibicao_pareamento_consultar('${p.codigo}')`),
        "ok|Chrome / Android TV|192.0.2.0/24|true");
      const cols = ok(`select array_to_string(proargnames, ',') from pg_proc where proname = 'exibicao_pareamento_consultar'`);
      assert.doesNotMatch(cols.replace("p_codigo_hash", ""), /hash|segredo|unidade|organizacao/);
      aprovar({ codigo: p.codigo });
      assert.equal(comoBackend(`select resultado from exibicao_pareamento_consultar('${p.codigo}')`), "indisponivel");
      assert.equal(comoBackend(`select resultado from exibicao_pareamento_consultar('${novo("x")}')`), "nao_encontrado");
    });
    test("segredo errado não consome; código desconhecido não aprova", () => {
      const p = iniciar();
      aprovar({ codigo: p.codigo });
      assert.equal(consumir({ segredo: novo("outro") }).resultado, "nao_encontrado");
      assert.equal(aprovar({ codigo: novo("chute") }), "nao_encontrado");
      assert.equal(consumir({ segredo: p.segredo }).resultado, "ok");
    });
    test("expiração: pedido vencido não aprova; aprovado vencido não consome", () => {
      const p1 = iniciar();
      ok(`update pareamentos_exibicao set criado_em = now() - interval '11 minutes', expira_em = now() - interval '1 second' where id = '${p1.id}'`);
      assert.equal(aprovar({ codigo: p1.codigo }), "expirado");
      const p2 = iniciar();
      aprovar({ codigo: p2.codigo });
      ok(`update pareamentos_exibicao set criado_em = now() - interval '14 minutes', expira_em = now() - interval '1 second' where id = '${p2.id}'`);
      assert.equal(consumir({ segredo: p2.segredo }).resultado, "expirado");
      assert.equal(comoBackend(`select estado from exibicao_pareamento_estado('${p2.segredo}')`), "cancelado");
    });
    test("validade do pedido limitada (60..900 s) e no máximo 15 min no banco", () => {
      falha(`select exibicao_pareamento_iniciar('${novo("c")}', '${novo("s")}', 3600, null, null)`, "fora da faixa", { papel: "service_role" });
      falha(`insert into pareamentos_exibicao (codigo_hash, segredo_hash, expira_em) values ('${novo("c")}', '${novo("s")}', now() + interval '1 hour')`,
        "pareamentos_exibicao_validade");
    });
    test("limite de pedidos pendentes por rede (contra enchimento)", () => {
      const rede = "203.0.113.0/24";
      for (let i = 0; i < 20; i++) assert.equal(iniciar({ rede }).resultado, "ok");
      assert.equal(iniciar({ rede }).resultado, "limite_rede");
      assert.equal(iniciar({ rede: "198.51.100.0/24" }).resultado, "ok", "outra rede segue");
      ok(`update pareamentos_exibicao set estado = 'cancelado' where rede_prefixo = '${rede}'`);
    });
    test("código ativo duplicado vira 'codigo_em_uso' (o backend gera outro)", () => {
      const p = iniciar();
      assert.equal(iniciar({ codigo: p.codigo }).resultado, "codigo_em_uso");
    });
    test("cancelado pela tela não aprova nem consome", () => {
      const p = iniciar();
      assert.equal(comoBackend(`select exibicao_pareamento_cancelar('${p.segredo}')`), "ok");
      assert.equal(aprovar({ codigo: p.codigo }), "nao_encontrado");
      assert.equal(consumir({ segredo: p.segredo }).resultado, "indisponivel");
    });
  });

  describe("concorrência", () => {
    /** Roda vários SQL ao mesmo tempo, cada um na sua conexão, e devolve as saídas. */
    const emParalelo = (sqls) => Promise.all(sqls.map((sql) => new Promise((resolver_, rejeitar) => {
      const p = spawn(PSQL, [URL_PG, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", `set role service_role; ${sql}`],
        { env: { ...process.env, PGOPTIONS: "-c lc_messages=C" } });
      let out = ""; let err = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { err += d; });
      p.on("close", (c) => (c === 0 ? resolver_(out.trim()) : rejeitar(new Error(err))));
    })));

    test("duas aprovações simultâneas do mesmo código (unidades diferentes): só uma vence", async () => {
      const p = iniciar();
      const sql = (u) => `begin; select resultado from exibicao_pareamento_aprovar('${p.codigo}', '${ORG_A}', '${u}', '${CONTA}', null, 'TV', 'tv'); select pg_sleep(0.4); commit;`;
      const saidas = await emParalelo([sql(UNI_A1), sql(UNI_A2), sql(UNI_A1)]);
      const resultados = saidas.map((s) => s.split("\n").find((l) => l && l !== "BEGIN" && l !== "COMMIT")).sort();
      assert.deepEqual(resultados.filter((r) => r === "ok").length, 1, JSON.stringify(saidas));
      assert.equal(resultados.filter((r) => r === "indisponivel").length, 2);
    });
    test("dois consumos simultâneos do mesmo pedido: uma tela só", async () => {
      const p = iniciar();
      aprovar({ codigo: p.codigo });
      const sql = `begin; select resultado from exibicao_pareamento_consumir('${p.segredo}', md5(random()::text) || md5(random()::text), 90, 30, 10); select pg_sleep(0.4); commit;`;
      const saidas = await emParalelo([sql, sql, sql]);
      const ok_ = saidas.filter((s) => s.includes("ok")).length;
      assert.equal(ok_, 1, JSON.stringify(saidas));
      assert.equal(ok(`select count(*) from dispositivos_exibicao d join pareamentos_exibicao p on p.dispositivo_id = d.id where p.id = '${p.id}'`), "1");
    });
    test("limite de telas por unidade não é furado por consumos simultâneos", async () => {
      ok(`update dispositivos_exibicao set revogado_em = now(), motivo_revogacao = 'manual' where unidade_id = '${UNI_A2}' and revogado_em is null`);
      const pedidos = Array.from({ length: 4 }, () => { const p = iniciar(); aprovar({ codigo: p.codigo, unidade: UNI_A2 }); return p; });
      const saidas = await emParalelo(pedidos.map((p) =>
        `select resultado from exibicao_pareamento_consumir('${p.segredo}', md5(random()::text) || md5(random()::text), 90, 30, 2)`));
      assert.equal(saidas.filter((s) => s === "ok").length, 2, JSON.stringify(saidas));
      assert.equal(saidas.filter((s) => s === "limite_atingido").length, 2);
    });
  });

  describe("expiração, inatividade e revogação", () => {
    test("expirada e inativa param de resolver (sem dados)", () => {
      const t1 = criarTela();
      ok(`update dispositivos_exibicao set criado_em = now() - interval '91 days', expira_em = now() - interval '1 second' where id = '${t1.id}'`);
      assert.deepEqual(resolver(t1.token).slice(0, 2), ["expirado", "-"]);
      const t2 = criarTela();
      ok(`update dispositivos_exibicao set ultimo_uso_em = now() - interval '31 days' where id = '${t2.id}'`);
      assert.deepEqual(resolver(t2.token).slice(0, 2), ["inativo", "-"]);
    });
    test("validade absoluta no banco: no máximo 180 dias", () => {
      falha(`insert into dispositivos_exibicao (organizacao_id, unidade_id, nome, token_hash, autorizado_por_conta_id, expira_em)
             values ('${ORG_A}', '${UNI_A1}', 'X', '${novo("t")}', '${CONTA}', now() + interval '365 days')`, "dispositivos_exibicao_validade");
    });
    test("revogar uma, revogar todas da unidade, desconectar no aparelho", () => {
      const a = criarTela({ unidade: UNI_A1 });
      const b = criarTela({ unidade: UNI_A1 });
      const c = criarTela({ unidade: UNI_A1 });
      assert.equal(comoBackend(`select exibicao_dispositivos_revogar('${ORG_A}', '${UNI_A1}', '${a.id}', '${CONTA}')`), "1");
      assert.equal(resolver(a.token)[0], "revogado");
      assert.equal(resolver(b.token)[0], "ok");
      assert.equal(comoBackend(`select exibicao_dispositivo_desconectar('${b.token}')`), "ok");
      assert.equal(resolver(b.token)[0], "revogado");
      const n = Number(comoBackend(`select exibicao_dispositivos_revogar('${ORG_A}', '${UNI_A1}', null, '${CONTA}')`));
      assert.ok(n >= 1);
      assert.equal(resolver(c.token)[0], "revogado");
      assert.equal(ok(`select motivo_revogacao from dispositivos_exibicao where id = '${c.id}'`), "unidade_revogada_em_massa");
    });
    test("unidade desativada ou transferida de empresa revoga as telas dela (gatilho)", () => {
      ok(`insert into unidades (id, organizacao_id, nome) values ('${"f".repeat(8)}-0000-4000-8000-0000000000f1', '${ORG_A}', 'Unidade temporaria')
          on conflict (id) do update set organizacao_id = excluded.organizacao_id, ativo = true`);
      const U = `${"f".repeat(8)}-0000-4000-8000-0000000000f1`;
      const t = criarTela({ unidade: U });
      ok(`update unidades set organizacao_id = '${ORG_B}' where id = '${U}'`);
      assert.equal(resolver(t.token)[0], "revogado");
      assert.equal(ok(`select motivo_revogacao from dispositivos_exibicao where id = '${t.id}'`), "unidade_transferida");
      ok(`update unidades set organizacao_id = '${ORG_A}' where id = '${U}'`);
      const t2 = criarTela({ unidade: U });
      ok(`update unidades set ativo = false where id = '${U}'`);
      assert.equal(ok(`select motivo_revogacao from dispositivos_exibicao where id = '${t2.id}'`), "unidade_desativada");
      assert.equal(aprovar({ codigo: iniciar().codigo, unidade: U }), "unidade_indisponivel");
    });
    test("gatilho em unidades: criar unidade e editar dados comuns não mexe em tela; só a unidade afetada; reativar não 'desrevoga'", () => {
      const U2 = `${"f".repeat(8)}-0000-4000-8000-0000000000f2`;
      ok(`insert into unidades (id, organizacao_id, nome) values ('${U2}', '${ORG_A}', 'Unidade nova')
          on conflict (id) do update set organizacao_id = excluded.organizacao_id, ativo = true`);
      const tA1 = criarTela({ unidade: UNI_A1 });
      const tU2 = criarTela({ unidade: U2 });
      ok(`update unidades set nome = 'Unidade nova renomeada' where id = '${U2}'`);
      ok(`update unidades set ativo = true where id = '${U2}'`);
      assert.equal(resolver(tU2.token)[0], "ok", "editar nome / ativo sem mudança não revoga");
      ok(`update unidades set ativo = false where id = '${U2}'`);
      assert.equal(resolver(tA1.token)[0], "ok", "outra unidade intacta");
      assert.equal(resolver(tU2.token)[0], "revogado");
      ok(`update unidades set ativo = true where id = '${U2}'`);
      assert.equal(resolver(tU2.token)[0], "revogado", "reativar não devolve a tela (precisa novo pareamento)");
    });
    test("gatilho em unidades é transacional: transferência desfeita (ROLLBACK) deixa a tela ativa", () => {
      const U3 = `${"f".repeat(8)}-0000-4000-8000-0000000000f3`;
      ok(`insert into unidades (id, organizacao_id, nome) values ('${U3}', '${ORG_A}', 'Unidade 3')
          on conflict (id) do update set organizacao_id = excluded.organizacao_id, ativo = true`);
      const t = criarTela({ unidade: U3 });
      ok(`begin; update unidades set organizacao_id = '${ORG_B}' where id = '${U3}'; rollback;`);
      assert.equal(resolver(t.token)[0], "ok");
      assert.equal(ok(`select organizacao_id from unidades where id = '${U3}'`), ORG_A);
    });
    test("gatilho em unidades não toca em outras tabelas (sessões de contexto, Order/Events, Financeiro)", () => {
      const corpo = ok(`select prosrc from pg_proc where proname = 'exibicao_unidade_alterada'`);
      const tabelas = [...corpo.matchAll(/(?:update|insert into|delete from)\s+public\.(\w+)/g)].map((m) => m[1]);
      assert.deepEqual([...new Set(tabelas)].sort(), ["dispositivos_exibicao", "pareamentos_exibicao"]);
      assert.equal(ok(`select tgtype & 1 from pg_trigger where tgname = 'trg_exibicao_unidade_alterada'`), "1", "FOR EACH ROW");
      assert.equal(ok(`select count(*) from information_schema.triggers where trigger_name = 'trg_exibicao_unidade_alterada' and event_manipulation = 'UPDATE'`), "1",
        "só UPDATE (criar unidade não dispara)");
    });
    test("fail-closed: empresa bloqueada e módulo retirado recusam (sem revogar); voltam quando o acesso volta", () => {
      const t = criarTela({ unidade: UNI_A1 });
      ok(`update organizacoes set status = 'bloqueada' where id = '${ORG_A}'`);
      assert.deepEqual(resolver(t.token).slice(0, 2), ["empresa_indisponivel", "-"]);
      ok(`update organizacoes set status = 'ativa' where id = '${ORG_A}'`);
      ok(`delete from organizacao_modulos where organizacao_id = '${ORG_A}' and modulo_id = 'ifood'`);
      assert.deepEqual(resolver(t.token).slice(0, 2), ["modulo_indisponivel", "-"]);
      ok(`insert into organizacao_modulos values ('${ORG_A}', 'ifood')`);
      assert.equal(resolver(t.token)[0], "ok");
    });
    test("lixo ou nulo na resolução: nao_encontrado (nunca erro que vaze detalhe)", () => {
      assert.equal(resolver("x' or 1=1 --".replace(/'/g, "''"))[0], "nao_encontrado");
      assert.equal(comoBackend("select resultado from exibicao_dispositivo_resolver(null, null, null)"), "nao_encontrado");
      assert.equal(resolver(novo("inexistente"))[0], "nao_encontrado");
    });
  });

  describe("rotação do token", () => {
    test("sem tela órfã: o anterior vale até o novo ser usado; depois, 2 min de folga; depois, recusado SEM revogar", () => {
      const t = criarTela();
      assert.equal(resolver(t.token)[0], "ok");
      const novoToken = novo("rot");
      assert.equal(comoBackend(`select exibicao_dispositivo_rotacionar('${t.id}', '${t.token}', '${novoToken}')`), "ok");
      // Set-Cookie ainda não chegou: o anterior continua valendo, quantas vezes for.
      assert.equal(resolver(t.token)[0], "ok_token_anterior");
      assert.equal(resolver(t.token)[0], "ok_token_anterior");
      // O novo chega e é usado: confirma; o anterior ganha só a folga.
      assert.equal(resolver(novoToken)[0], "ok");
      assert.equal(resolver(t.token)[0], "ok_token_anterior");
      ok(`update dispositivos_exibicao set token_anterior_valido_ate = now() - interval '1 second' where id = '${t.id}'`);
      assert.equal(resolver(t.token)[0], "token_substituido");
      assert.equal(ok(`select reuso_contador || '|' || (suspeita_em is not null) || '|' || (revogado_em is null) from dispositivos_exibicao where id = '${t.id}'`), "1|true|true",
        "marca suspeita, mas NÃO revoga (pode ser corrida/restauração)");
      assert.equal(resolver(novoToken)[0], "ok", "a tela legítima continua");
    });
    test("token anterior reaparecendo de OUTRA rede (VPN, rede móvel ou cópia): bloqueia só o anterior, NÃO revoga a tela", () => {
      const t = criarTela();
      const novoToken = novo("rot");
      comoBackend(`select exibicao_dispositivo_rotacionar('${t.id}', '${t.token}', '${novoToken}')`);
      assert.equal(resolver(novoToken, "200.10.20.0/24")[0], "ok");
      ok(`update dispositivos_exibicao set token_anterior_valido_ate = now() - interval '1 second' where id = '${t.id}'`);
      for (const rede of ["45.67.89.0/24", "177.1.2.0/24"]) assert.equal(resolver(t.token, rede)[0], "token_substituido");
      assert.equal(ok(`select reuso_contador || '|' || ultimo_reuso_rede || '|' || (suspeita_em is not null) || '|' || (revogado_em is null) from dispositivos_exibicao where id = '${t.id}'`),
        "2|177.1.2.0/24|true|true");
      assert.equal(resolver(novoToken, "189.9.9.0/24")[0], "ok", "a tela legítima segue, mesmo trocando de rede");
      const lista = comoBackend(`select situacao || '|' || reuso_contador || '|' || (suspeita_em is not null) from exibicao_dispositivos_listar('${ORG_A}', '${UNI_A1}') where id = '${t.id}'`);
      assert.equal(lista, "ativa|2|true", "a gestão vê a suspeita e decide");
      assert.equal(comoBackend(`select exibicao_dispositivos_revogar('${ORG_A}', '${UNI_A1}', '${t.id}', '${CONTA}')`), "1");
      assert.equal(resolver(novoToken)[0], "revogado");
    });
    test("mudança de rede sozinha não afeta a tela (rede móvel/VPN/reinício)", () => {
      const t = criarTela();
      for (const rede of ["10.0.0.0/24", "200.1.1.0/24", "2804:14c:5b8a::/48", null]) {
        assert.equal(comoBackend(`select resultado from exibicao_dispositivo_resolver('${t.token}', ${rede ? `'${rede}'` : "null"}, null)`), "ok");
      }
    });
    test("duas abas rotacionando ao mesmo tempo com o mesmo token: a segunda recebe 'conflito' (nada de tela órfã)", () => {
      const t = criarTela();
      const n1 = novo("aba1");
      assert.equal(comoBackend(`select exibicao_dispositivo_rotacionar('${t.id}', '${t.token}', '${n1}')`), "ok");
      assert.equal(comoBackend(`select exibicao_dispositivo_rotacionar('${t.id}', '${t.token}', '${novo("aba2")}')`), "conflito");
      assert.equal(resolver(n1)[0], "ok", "o cookie entregue pela primeira aba vale");
    });
    test("Set-Cookie perdido: com o anterior em uso há mais de 1 h, a rotação é refeita; antes disso, não", () => {
      const t = criarTela();
      const perdido = novo("perdido");
      comoBackend(`select exibicao_dispositivo_rotacionar('${t.id}', '${t.token}', '${perdido}')`);
      assert.equal(resolver(t.token)[0], "ok_token_anterior");
      assert.equal(comoBackend(`select exibicao_dispositivo_rotacionar('${t.id}', '${t.token}', '${novo("cedo")}')`), "conflito");
      ok(`update dispositivos_exibicao set token_rotacionado_em = now() - interval '2 hours' where id = '${t.id}'`);
      assert.equal(resolver(t.token)[2], "true", "rotação devida de novo");
      const novoDeNovo = novo("refeita");
      assert.equal(comoBackend(`select exibicao_dispositivo_rotacionar('${t.id}', '${t.token}', '${novoDeNovo}')`), "ok");
      assert.equal(resolver(perdido)[0], "nao_encontrado", "o token que nunca chegou não vale mais");
      assert.equal(resolver(t.token)[0], "ok_token_anterior");
      assert.equal(resolver(novoDeNovo)[0], "ok");
    });
    test("compare-and-swap: rotação concorrente com o mesmo token esperado -> uma 'ok', outra 'conflito'", () => {
      const t = criarTela();
      assert.equal(comoBackend(`select exibicao_dispositivo_rotacionar('${t.id}', '${t.token}', '${novo("a")}')`), "ok");
      assert.equal(comoBackend(`select exibicao_dispositivo_rotacionar('${t.id}', '${novo("x")}', '${novo("b")}')`), "conflito");
    });
    test("rotação devida só depois de 24 h de uso confirmado", () => {
      const t = criarTela();
      assert.equal(resolver(t.token)[2], "false");
      ok(`update dispositivos_exibicao set token_rotacionado_em = now() - interval '25 hours' where id = '${t.id}'`);
      assert.equal(resolver(t.token)[2], "true");
    });
    test("tokens únicos em todas as telas", () => {
      const t = criarTela();
      falha(`insert into dispositivos_exibicao (organizacao_id, unidade_id, nome, token_hash, autorizado_por_conta_id, expira_em)
             values ('${ORG_A}', '${UNI_A1}', 'Copia', '${t.token}', '${CONTA}', now() + interval '1 day')`, "uq_dispositivos_exibicao_token");
    });
  });

  describe("limpeza e rollback", () => {
    test("limpeza remove pedidos encerrados antigos e telas revogadas há mais de 90 dias", () => {
      const p = iniciar();
      ok(`update pareamentos_exibicao set estado = 'cancelado', criado_em = now() - interval '2 days', expira_em = now() - interval '2 days' + interval '5 min' where id = '${p.id}'`);
      const t = criarTela();
      ok(`update dispositivos_exibicao set revogado_em = now() - interval '91 days', motivo_revogacao = 'manual' where id = '${t.id}'`);
      assert.ok(Number(comoBackend("select exibicao_limpar(1000)")) >= 2);
      assert.equal(ok(`select count(*) from pareamentos_exibicao where id = '${p.id}'`), "0");
      assert.equal(ok(`select count(*) from dispositivos_exibicao where id = '${t.id}'`), "0");
    });
    test("rollback aborta com tela ativa; depois de revogar, remove tudo (inclusive o gatilho em unidades)", () => {
      criarTela();
      const r1 = aplicar("110_rollback.sql");
      assert.equal(r1.ok, false);
      assert.match(r1.err, /telas de exibição ativas/);
      ok("update dispositivos_exibicao set revogado_em = now(), motivo_revogacao = 'manual' where revogado_em is null");
      const r2 = aplicar("110_rollback.sql");
      assert.equal(r2.ok, true, r2.err);
      assert.equal(ok("select count(*) from pg_class where relname in ('dispositivos_exibicao','pareamentos_exibicao')"), "0");
      assert.equal(ok("select count(*) from pg_trigger where tgname = 'trg_exibicao_unidade_alterada'"), "0");
      assert.equal(ok("select count(*) from pg_proc where proname like 'exibicao\\_%'"), "0");
      // Reaplica (idempotência da subida depois do rollback) para o after() e próximas execuções.
      const r3 = aplicar("110_exibicao_dispositivos.sql");
      assert.equal(r3.ok, true, r3.err);
    });
  });
});
