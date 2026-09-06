// Migration 075 — Fechamento Mensal Visio (evolução da 074 + competência + snapshot).
//
// DUAS camadas, como as demais migrations do projeto (ver migration-060-*.test.js:
// não há runner de migration; elas rodam à mão no SQL Editor do Supabase):
//
//   1. ANÁLISE ESTÁTICA do .sql (sempre roda, sem banco) — prova que a
//      migration é não-destrutiva, transacional, idempotente, tem preflight,
//      FKs ON DELETE RESTRICT nas tabelas de snapshot, triggers de
//      imutabilidade, e que o rollback reverte tudo.
//
//   2. EXECUÇÃO VIVA dos cenários A/B/C (só quando MIGRATION_075_PG_URL
//      aponta um Postgres DESCARTÁVEL — nunca produção nem o Supabase de
//      integração). Cria um banco efêmero, monta o estado equivalente à
//      074, aplica a 075, valida, testa rollback. Sem esse env: SKIP claro.
//
// Rodar (só estático):  node --test test/migration-075.test.js
// Rodar (com A/B/C):     MIGRATION_075_PG_URL=postgresql://postgres:postgres@localhost:5432/postgres \
//                        node --test test/migration-075.test.js

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";

const MIG = readFileSync(fileURLToPath(new URL("../../database/migrations/075_bonificacao_fechamento_mensal.sql", import.meta.url)), "utf8");
const RB  = readFileSync(fileURLToPath(new URL("../../database/migrations/075_rollback.sql", import.meta.url)), "utf8");

// linhas executáveis (sem comentários `--`, sem linhas em branco)
const exec = (sql) => sql.split("\n").map((l) => l.replace(/--.*$/, "").trim()).filter(Boolean).join("\n").toLowerCase();
const migX = exec(MIG);
const rbX  = exec(RB);

// ===========================================================================
// 1. ANÁLISE ESTÁTICA
// ===========================================================================
describe("075 — cabeçalho e contrato", () => {
  test("tem OBJETIVO, PRÉ-REQUISITOS, SEGURANÇA, ROLLBACK, COMO USAR", () => {
    const h = MIG.toLowerCase();
    for (const s of ["objetivo", "pré-requisitos", "segurança", "rollback", "como usar", "preflight", "verificação"]) {
      assert.ok(h.includes(s), `faltou seção "${s}"`);
    }
  });
  test("declara-se transacional e idempotente e roda em begin/commit", () => {
    assert.match(MIG.toLowerCase(), /transacional/);
    assert.match(MIG.toLowerCase(), /idempotente/);
    assert.match(migX, /^begin;/m);
    assert.match(migX, /^commit;/m);
    // begin vem antes de qualquer DDL
    assert.ok(migX.indexOf("begin;") < migX.indexOf("alter table"), "begin; deve preceder o primeiro ALTER");
  });
});

describe("075 — PREFLIGHT (cenário A)", () => {
  test("aborta com RAISE quando bonificacao_mix_mensal tem linhas", () => {
    assert.match(migX, /count\(\*\)\s+into\s+n\s+from\s+bonificacao_mix_mensal/);
    assert.match(migX, /if\s+n\s*>\s*0\s+then[\s\S]*?raise\s+exception[\s\S]*?abortado/);
  });
  test("o preflight está DENTRO do begin/commit (RAISE reverte tudo)", () => {
    const iBegin = migX.indexOf("begin;");
    const iPref = migX.indexOf("count(*)\n      into n");
    const iPref2 = migX.search(/count\(\*\)\s+into\s+n\s+from\s+bonificacao_mix_mensal/);
    const iCommit = migX.lastIndexOf("commit;");
    assert.ok(iBegin >= 0 && iCommit > iBegin);
    assert.ok(iPref2 > iBegin && iPref2 < iCommit, "preflight deve estar entre begin; e commit;");
  });
  test("aborta também se nem a 074 nem a 075 estiverem aplicadas", () => {
    assert.match(migX, /nem bonificacao_mix_mensal nem\s*'?\s*'?bonificacao_fechamento_mensal/);
    assert.match(migX, /aplique a migration 074 primeiro/);
  });
});

describe("075 — NÃO-DESTRUTIVA", () => {
  const proibidos = [
    [/\btruncate\b/, "truncate"],
    [/\bdelete\s+from\s+bonificacao/, "delete from bonificacao*"],
    [/\bupdate\s+bonificacao_(mix_mensal|fechamento_mensal)\s+set\b/, "update de dado na tabela renomeada"],
    [/alter\s+table\s+bonificacao_(mix_mensal|fechamento_mensal)\s+drop\s+column/, "drop column na tabela de fechamento"],
    [/drop\s+table\s+(?!if\s+exists)/, "drop table sem IF EXISTS"],
  ];
  for (const [re, nome] of proibidos) {
    test(`não contém: ${nome}`, () => assert.doesNotMatch(migX, re));
  }
  test("o único DROP TABLE não existe na 075 (só cria)", () => {
    assert.doesNotMatch(migX, /drop\s+table/);
  });
  test("só RENAME / ADD COLUMN / CREATE — colunas novas são nullable ou têm default", () => {
    // toda `add column` da 075 é `if not exists` e (nullable) ou (not null default ...)
    const adds = [...MIG.matchAll(/add column if not exists\s+(\w+)\s+([^,;]+)/gi)].map((m) => `${m[1]} ${m[2]}`.trim());
    assert.ok(adds.length >= 18, `esperava >=18 colunas novas, achei ${adds.length}`);
    for (const a of adds) {
      const temNotNull = /not null/i.test(a);
      const temDefault = /default/i.test(a);
      assert.ok(!temNotNull || temDefault, `coluna nova NOT NULL sem default quebraria a 074: "${a}"`);
    }
  });
});

describe("075 — renomes esperados (074 -> 2 metades)", () => {
  const renames = [
    ["qtd_sanduiches", "produtos_qtd_sanduiches"],
    ["qtd_bebidas", "produtos_qtd_bebidas"],
    ["qtd_adicionais", "produtos_qtd_adicionais"],
    ["qtd_diversos", "produtos_qtd_diversos"],
    ["percentual_bebidas_pdf", "produtos_pct_bebidas_pdf"],
    ["percentual_adicionais_pdf", "produtos_pct_adicionais_pdf"],
    ["percentual_diversos_pdf", "produtos_pct_diversos_pdf"],
    ["faturamento_loja", "produtos_faturamento_loja"],
    ["ppd_loja", "produtos_ppd"],
    ["estabelecimento", "produtos_estabelecimento"],
    ["hash_arquivo", "produtos_hash_arquivo"],
    ["arquivo_storage", "produtos_arquivo_storage"],
    ["origem", "produtos_origem"],
    ["usuario_id", "produtos_usuario_id"],
    ["usuario_nome", "produtos_usuario_nome"],
  ];
  for (const [de, para] of renames) {
    test(`rename column ${de} -> ${para}`, () => {
      assert.match(migX, new RegExp(`rename column ${de}\\s+to ${para}\\b`));
      assert.match(rbX, new RegExp(`rename column ${para}\\s+to ${de}\\b`), "rollback deve reverter o rename");
    });
  }
  test("rename da tabela mix_mensal -> fechamento_mensal (ida e volta)", () => {
    assert.match(migX, /rename to bonificacao_fechamento_mensal/);
    assert.match(rbX, /rename to bonificacao_mix_mensal/);
  });
  test("manual_override e atualizado_em NÃO são renomeados (compartilhados)", () => {
    assert.doesNotMatch(migX, /rename column manual_override/);
    assert.doesNotMatch(migX, /rename column atualizado_em/);
  });
});

describe("075 — as 2 metades + flags obrigatórias", () => {
  test("colunas produtos_* novas", () => {
    for (const c of ["produtos_torque", "produtos_perdas", "produtos_fat_sanduiches", "produtos_pct_fat_sanduiches", "produtos_total_itens", "produtos_canal_confirmado", "produtos_atualizado_em"]) {
      assert.match(migX, new RegExp(`add column if not exists\\s+${c}\\b`));
    }
  });
  test("colunas vendas_* novas", () => {
    for (const c of ["vendas_faturamento", "vendas_ticket_medio", "vendas_cupons_validos", "vendas_cupons_vendas", "vendas_metodos_pagamento", "vendas_estabelecimento", "vendas_origem", "vendas_hash_arquivo", "vendas_arquivo_storage", "vendas_usuario_id", "vendas_usuario_nome", "vendas_atualizado_em"]) {
      assert.match(migX, new RegExp(`add column if not exists\\s+${c}\\b`));
    }
  });
  test("flags dos 2 checkboxes da prévia", () => {
    assert.match(migX, /produtos_canal_confirmado\s+boolean not null default false/);
    assert.match(migX, /periodo_confirmado_usuario\s+boolean not null default false/);
  });
  test("CHECK bfm_completo: as 2 metades + os 2 checkboxes obrigatórios", () => {
    assert.match(migX, /constraint bfm_completo check\s*\([\s\S]*?produtos_qtd_sanduiches\s+is not null[\s\S]*?vendas_faturamento\s+is not null[\s\S]*?produtos_canal_confirmado\s*=\s*true[\s\S]*?periodo_confirmado_usuario\s*=\s*true/);
  });
});

describe("075 — FKs ON DELETE (ajuste 6)", () => {
  test("bonificacao_fechamento_mensal: org e unidade viram ON DELETE RESTRICT (eram CASCADE)", () => {
    assert.match(migX, /bonificacao_fechamento_mensal_organizacao_id_fkey[\s\S]*?references organizacoes\(id\) on delete restrict/);
    assert.match(migX, /bonificacao_fechamento_mensal_unidade_id_fkey[\s\S]*?references unidades\(id\) on delete restrict/);
    // rollback devolve CASCADE
    assert.match(rbX, /references organizacoes\(id\) on delete cascade/);
    assert.match(rbX, /references unidades\(id\) on delete cascade/);
  });
  test("bonificacao_competencia: org, unidade e fechamento_id = ON DELETE RESTRICT", () => {
    assert.match(migX, /organizacao_id uuid not null references organizacoes\(id\)\s+on delete restrict/);
    assert.match(migX, /unidade_id\s+uuid not null references unidades\(id\)\s+on delete restrict/);
    assert.match(migX, /fechamento_id uuid references bonificacao_fechamento_mensal\(id\) on delete restrict/);
  });
  test("bonificacao_competencia_snapshot: TODAS as FKs de negócio = ON DELETE RESTRICT", () => {
    assert.match(migX, /competencia_id uuid not null references bonificacao_competencia\(id\) on delete restrict/);
    assert.match(migX, /organizacao_id uuid not null references organizacoes\(id\)\s+on delete restrict/);
    assert.match(migX, /unidade_id\s+uuid not null references unidades\(id\)\s+on delete restrict/);
    assert.doesNotMatch(migX, /bonificacao_competencia_snapshot[\s\S]*?on delete cascade/);
  });
});

describe("075 — snapshot APPEND-ONLY IMUTÁVEL (ajuste 5)", () => {
  test("função de imutabilidade + triggers BEFORE UPDATE e BEFORE DELETE", () => {
    assert.match(migX, /create or replace function bonificacao_snapshot_imutavel\(\)/);
    assert.match(migX, /raise\s+exception[\s\S]*?append-only/);
    assert.match(migX, /trigger trg_bcsnap_no_update before update on bonificacao_competencia_snapshot/);
    assert.match(migX, /trigger trg_bcsnap_no_delete before delete on bonificacao_competencia_snapshot/);
  });
  test("NÃO existe coluna substituido_em em lugar nenhum", () => {
    assert.doesNotMatch(migX, /substituido_em/);
  });
  test("versão vigente é bonificacao_competencia.versao_atual (não um flag no snapshot)", () => {
    assert.match(migX, /versao_atual int not null default 0/);
    assert.match(migX, /unique \(competencia_id, versao\)/);
  });
});

describe("075 — bonificacao_competencia: state machine no CHECK", () => {
  test("status aceita exatamente os 4 estados aprovados", () => {
    assert.match(migX, /status text not null default 'aberta'\s*check \(status in \('aberta','fechada','reaberta','legado_sem_fechamento'\)\)/);
  });
  test("índice por status (obterMes chaveia por ele)", () => {
    assert.match(migX, /idx_bcomp_status\s+on bonificacao_competencia\(status\)/);
  });
});

describe("075 — RLS preservada / criada com a MESMA expressão", () => {
  test("as 3 tabelas usam auth_unidade_ids() / is_platform_superadmin()", () => {
    const policies = [...MIG.matchAll(/create policy\s+(\w+)[\s\S]*?using\s*\(([^)]*\([^)]*\)[^)]*)\)/gi)];
    assert.ok(policies.length >= 3, `esperava >=3 policies, achei ${policies.length}`);
    for (const p of MIG.matchAll(/create policy[\s\S]*?with check \(([\s\S]*?)\);/gi)) {
      assert.match(p[1], /auth_unidade_ids\(\)/);
      assert.match(p[1], /is_platform_superadmin\(\)/);
    }
  });
  test("não recria auth_unidade_ids / is_platform_superadmin / bonificacao_set_atualizado_em", () => {
    assert.doesNotMatch(migX, /create (or replace )?function auth_unidade_ids/);
    assert.doesNotMatch(migX, /create (or replace )?function is_platform_superadmin/);
    assert.doesNotMatch(migX, /create (or replace )?function bonificacao_set_atualizado_em/);
  });
});

describe("075 — fluxo transacional F4 (secção 6: congelar / reabrir)", () => {
  test("bonificacao_congelar_competencia: congela em versão N+1, sem tocar a anterior", () => {
    assert.match(migX, /create or replace function bonificacao_congelar_competencia\(/);
    // status alvo: só legado_pre_refatoracao vira legado; os 2 fechamentos → 'fechada'
    assert.match(migX, /v_status\s*:=\s*case p_origem when 'legado_pre_refatoracao' then 'legado_sem_fechamento' else 'fechada' end/);
    // origens aceitas (correção conceitual F4)
    assert.match(migX, /p_origem not in \('fechamento_mensal_direto','acompanhamento_diario','legado_pre_refatoracao'\)/);
    assert.match(migX, /origem text not null[\s\S]*?check \(origem in \('fechamento_mensal_direto','acompanhamento_diario','legado_pre_refatoracao'\)\)/);
    assert.doesNotMatch(migX, /'fechamento_visio'/);
    // nova versão = versao_atual + 1, snapshot é INSERT (append-only)
    assert.match(migX, /v_versao\s*:=\s*v_comp\.versao_atual\s*\+\s*1/);
    assert.match(migX, /insert into bonificacao_competencia_snapshot\s*\(/);
    // recusa refechar competência já fechada / recongelar legado
    assert.match(migX, /if v_comp\.status = 'fechada' then[\s\S]*?raise\s+exception[\s\S]*?abortado/i);
    assert.match(migX, /if v_comp\.status = 'legado_sem_fechamento' then[\s\S]*?raise\s+exception/i);
    // trava a linha da competência
    assert.match(migX, /from bonificacao_competencia[\s\S]*?for update/);
  });
  test("bonificacao_reabrir_competencia: só reabre 'fechada', exige motivo, não apaga nada", () => {
    assert.match(migX, /create or replace function bonificacao_reabrir_competencia\(/);
    assert.match(migX, /if v_comp\.status <> 'fechada' then[\s\S]*?raise\s+exception/i);
    assert.match(migX, /length\(trim\(p_motivo\)\)[\s\S]*?raise\s+exception/i);
    assert.match(migX, /update bonificacao_competencia set[\s\S]*?status = 'reaberta'/);
    assert.doesNotMatch(migX, /delete from bonificacao_competencia_snapshot/);
  });
  test("rollback dropa as 2 funções", () => {
    assert.match(rbX, /drop function if exists bonificacao_congelar_competencia\(/);
    assert.match(rbX, /drop function if exists bonificacao_reabrir_competencia\(/);
  });
});

describe("075_rollback — reverte tudo", () => {
  test("dropa as 2 tabelas novas + a função de imutabilidade, com IF EXISTS", () => {
    assert.match(rbX, /drop table\s+if exists bonificacao_competencia_snapshot/);
    assert.match(rbX, /drop table\s+if exists bonificacao_competencia\b/);
    assert.match(rbX, /drop function if exists bonificacao_snapshot_imutavel/);
  });
  test("dropa as colunas que a 075 adicionou (todas, com IF EXISTS)", () => {
    for (const c of ["produtos_torque", "produtos_perdas", "produtos_total_itens", "produtos_canal_confirmado", "vendas_faturamento", "vendas_metodos_pagamento", "periodo_confirmado_usuario"]) {
      assert.match(rbX, new RegExp(`drop column if exists ${c}\\b`));
    }
  });
  test("renomeia a tabela e as colunas de volta e roda em begin/commit", () => {
    assert.match(rbX, /^begin;/m);
    assert.match(rbX, /^commit;/m);
    assert.match(rbX, /rename to bonificacao_mix_mensal/);
  });
  test("é reexecutável (tudo com IF EXISTS / guarda de tabela)", () => {
    assert.match(rbX, /if not exists \(select 1 from information_schema\.tables[\s\S]*?bonificacao_fechamento_mensal'\) then[\s\S]*?return;/);
  });
});

// ===========================================================================
// 2. EXECUÇÃO VIVA — cenários A / B / C (Postgres efêmero)
// ===========================================================================
const PG_URL = process.env.MIGRATION_075_PG_URL || "";
let psqlOk = false;
try { if (PG_URL) { execFileSync("psql", ["--version"], { stdio: "pipe" }); psqlOk = true; } } catch { psqlOk = false; }
const PULAR_VIVO = !PG_URL
  ? "MIGRATION_075_PG_URL não definido — cenários A/B/C só rodam contra um Postgres descartável (nunca produção)."
  : !psqlOk ? "psql não encontrado no PATH." : false;

const TMP = join(tmpdir(), `mig075-${randomUUID().slice(0, 8)}`);
const arquivos = { setup: null, mig: null, rb: null };
let adminUrl = "", dbName = "", dbUrl = "";

// prereqs mínimos + tabela equivalente à 074 (mesmos nomes de constraint que a 075 espera renomear)
const SETUP_SQL = `
do $$ begin if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$;
create table organizacoes (id uuid primary key default gen_random_uuid(), nome text);
create table unidades     (id uuid primary key default gen_random_uuid(), nome text);
create table perfis       (id uuid primary key default gen_random_uuid(), nome text);
create function auth_unidade_ids() returns setof uuid as $f$ select id from unidades $f$ language sql stable;
create function is_platform_superadmin() returns boolean as $f$ select false $f$ language sql stable;
create function bonificacao_set_atualizado_em() returns trigger as $f$ begin new.atualizado_em = now(); return new; end $f$ language plpgsql;

create table bonificacao_mix_mensal (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  ano int not null check (ano between 2000 and 2100),
  mes int not null check (mes between 1 and 12),
  qtd_sanduiches int not null check (qtd_sanduiches >= 0),
  qtd_bebidas int not null check (qtd_bebidas >= 0),
  qtd_adicionais int not null check (qtd_adicionais >= 0),
  qtd_diversos int not null check (qtd_diversos >= 0),
  percentual_bebidas_pdf numeric(6,3),
  percentual_adicionais_pdf numeric(6,3),
  percentual_diversos_pdf numeric(6,3),
  faturamento_loja numeric(14,2),
  ppd_loja numeric(10,2),
  estabelecimento text,
  hash_arquivo text,
  arquivo_storage text,
  origem text not null default 'visio' check (origem in ('visio','manual','misto')),
  manual_override jsonb not null default '{}'::jsonb,
  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (unidade_id, ano, mes)
);
create index idx_bmm_unidade on bonificacao_mix_mensal(unidade_id, ano desc, mes desc);
create index idx_bmm_org on bonificacao_mix_mensal(organizacao_id);
create trigger trg_bmm_upd before update on bonificacao_mix_mensal for each row execute function bonificacao_set_atualizado_em();
alter table bonificacao_mix_mensal enable row level security;
create policy rls_bonificacao_mix_mensal_tenant on bonificacao_mix_mensal for all to authenticated
  using (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());
`;

// alguns Postgres locais têm mismatch de "collation version" (OS atualizou a
// ICU/libc) — vira AVISO em toda operação e polui a saída. Não é erro; filtra.
const semRuido = (s) => String(s || "").split(/\r?\n/)
  .filter((l) => !/collation|ordena[çc][ãa]o|refresh collation|rebuild all objects/i.test(l))
  .join("\n").trim();

function psql(url, sqlOrFile, { file = false } = {}) {
  const args = [url, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A"];
  if (file) args.push("-f", sqlOrFile);
  else args.push("-c", sqlOrFile);
  return semRuido(execFileSync("psql", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}
function psqlExpectFail(url, sql) {
  try { psql(url, sql); return null; }
  catch (e) { return semRuido(String(e.stderr || "") + "\n" + String(e.stdout || "") + "\n" + String(e.message || "")); }
}

describe("075 — cenários A/B/C (execução viva)", { skip: PULAR_VIVO }, () => {
  before(() => {
    execFileSync("mkdir", ["-p", TMP]);
    arquivos.setup = join(TMP, "setup.sql"); writeFileSync(arquivos.setup, SETUP_SQL);
    arquivos.mig = join(TMP, "075.sql"); writeFileSync(arquivos.mig, MIG);
    arquivos.rb = join(TMP, "075_rollback.sql"); writeFileSync(arquivos.rb, RB);
    adminUrl = PG_URL;
    dbName = `mig075_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    psql(adminUrl, `create database ${dbName} template template0`);
    dbUrl = adminUrl.replace(/\/[^/]*$/, `/${dbName}`);
    psql(dbUrl, arquivos.setup, { file: true });
  });
  after(() => {
    try { psql(adminUrl, `drop database if exists ${dbName} with (force)`); } catch { /* ok */ }
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ok */ }
  });

  test("CENÁRIO A — 1 linha em bonificacao_mix_mensal → migration ABORTA, schema e dados intactos", () => {
    psql(dbUrl, `
      insert into organizacoes(id,nome) values ('00000000-0000-0000-0000-0000000000aa','Org A');
      insert into unidades(id,nome)     values ('00000000-0000-0000-0000-0000000000bb','Uni A');
      insert into bonificacao_mix_mensal(organizacao_id,unidade_id,ano,mes,qtd_sanduiches,qtd_bebidas,qtd_adicionais,qtd_diversos)
        values ('00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000000bb',2026,7, 2533,1086,613,508);
    `);

    const err = psqlExpectFail(dbUrl, `\\i ${arquivos.mig.replace(/\\/g, "/")}`);
    assert.ok(err, "a migration deveria ter falhado");
    assert.match(err, /ABORTADO/i);
    assert.match(err, /bonificacao_mix_mensal tem 1 linha/i);

    // schema intacto: tabela ainda tem o nome antigo, sem colunas novas, sem tabelas novas
    assert.equal(psql(dbUrl, `select to_regclass('bonificacao_mix_mensal') is not null`), "t");
    assert.equal(psql(dbUrl, `select to_regclass('bonificacao_fechamento_mensal')`), "");
    assert.equal(psql(dbUrl, `select to_regclass('bonificacao_competencia')`), "");
    assert.equal(psql(dbUrl, `select to_regclass('bonificacao_competencia_snapshot')`), "");
    assert.equal(psql(dbUrl, `select count(*) from information_schema.columns where table_name='bonificacao_mix_mensal' and column_name like 'produtos_%'`), "0");
    assert.equal(psql(dbUrl, `select count(*) from information_schema.columns where table_name='bonificacao_mix_mensal' and column_name like 'vendas_%'`), "0");
    // dado intacto
    assert.equal(psql(dbUrl, `select qtd_sanduiches||'/'||qtd_bebidas||'/'||qtd_adicionais||'/'||qtd_diversos from bonificacao_mix_mensal`), "2533/1086/613/508");
    // FKs ainda CASCADE
    assert.equal(psql(dbUrl, `select confdeltype from pg_constraint where conname='bonificacao_mix_mensal_organizacao_id_fkey'`), "c");

    // limpeza p/ o cenário B
    psql(dbUrl, `delete from bonificacao_mix_mensal; delete from unidades; delete from organizacoes;`);
  });

  test("CENÁRIO B — 0 linhas → migration APLICA por completo (caminho de produção)", () => {
    assert.equal(psql(dbUrl, `select count(*) from bonificacao_mix_mensal`), "0");
    const out = psql(dbUrl, `\\i ${arquivos.mig.replace(/\\/g, "/")}`);
    assert.doesNotMatch(out, /erro|error|abortado/i);

    // tabela renomeada
    assert.equal(psql(dbUrl, `select to_regclass('bonificacao_mix_mensal')`), "");
    assert.equal(psql(dbUrl, `select to_regclass('bonificacao_fechamento_mensal') is not null`), "t");
    assert.equal(psql(dbUrl, `select count(*) from bonificacao_fechamento_mensal`), "0");

    // colunas renomeadas + novas
    const cols = psql(dbUrl, `select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name='bonificacao_fechamento_mensal'`);
    for (const c of ["produtos_qtd_sanduiches", "produtos_qtd_bebidas", "produtos_ppd", "produtos_torque", "produtos_perdas", "produtos_total_itens", "produtos_canal_confirmado", "vendas_faturamento", "vendas_ticket_medio", "vendas_metodos_pagamento", "periodo_confirmado_usuario"]) {
      assert.ok(cols.split(",").includes(c), `faltou coluna ${c}`);
    }
    for (const c of ["qtd_sanduiches", "ppd_loja", "faturamento_loja", "percentual_bebidas_pdf"]) {
      assert.ok(!cols.split(",").includes(c), `coluna antiga ${c} não deveria existir`);
    }

    // FKs viraram RESTRICT
    assert.equal(psql(dbUrl, `select confdeltype from pg_constraint where conname='bonificacao_fechamento_mensal_organizacao_id_fkey'`), "r");
    assert.equal(psql(dbUrl, `select confdeltype from pg_constraint where conname='bonificacao_fechamento_mensal_unidade_id_fkey'`), "r");

    // CHECK bfm_completo
    assert.equal(psql(dbUrl, `select count(*) from pg_constraint where conname='bfm_completo' and contype='c'`), "1");

    // índices / trigger / policy renomeados
    assert.equal(psql(dbUrl, `select count(*) from pg_indexes where tablename='bonificacao_fechamento_mensal' and indexname in ('idx_bfm_unidade','idx_bfm_org')`), "2");
    assert.equal(psql(dbUrl, `select count(*) from pg_trigger where tgrelid='bonificacao_fechamento_mensal'::regclass and tgname='trg_bfm_upd'`), "1");
    assert.equal(psql(dbUrl, `select count(*) from pg_policy where polrelid='bonificacao_fechamento_mensal'::regclass and polname='rls_bonificacao_fechamento_mensal_tenant'`), "1");

    // tabelas novas + FKs RESTRICT
    for (const t of ["bonificacao_competencia", "bonificacao_competencia_snapshot"]) {
      assert.equal(psql(dbUrl, `select to_regclass('${t}') is not null`), "t", `${t} deveria existir`);
      assert.equal(psql(dbUrl, `select count(*) from pg_policy where polrelid='${t}'::regclass`), "1", `${t} deveria ter RLS`);
    }
    // FKs de NEGÓCIO (org / unidade / competencia / fechamento) = RESTRICT.
    // As FKs para `perfis` (criado_por/fechada_por/reaberta_por) são ON DELETE SET NULL de propósito.
    assert.equal(psql(dbUrl, `select bool_and(confdeltype='r') from pg_constraint where conrelid='bonificacao_competencia_snapshot'::regclass and contype='f' and confrelid <> 'perfis'::regclass`), "t");
    assert.equal(psql(dbUrl, `select bool_and(confdeltype='r') from pg_constraint where conrelid='bonificacao_competencia'::regclass and contype='f' and confrelid in ('organizacoes'::regclass,'unidades'::regclass,'bonificacao_fechamento_mensal'::regclass)`), "t");
    assert.equal(psql(dbUrl, `select confdeltype from pg_constraint where conname='bonificacao_competencia_snapshot_competencia_id_fkey'`), "r");
    assert.equal(psql(dbUrl, `select bool_and(confdeltype='n') from pg_constraint where conrelid='bonificacao_competencia_snapshot'::regclass and contype='f' and confrelid = 'perfis'::regclass`), "t");

    // status CHECK
    const chk = psql(dbUrl, `select pg_get_constraintdef(oid) from pg_constraint where conrelid='bonificacao_competencia'::regclass and conname like '%status%'`);
    for (const s of ["aberta", "fechada", "reaberta", "legado_sem_fechamento"]) assert.match(chk, new RegExp(s));

    // ---- IMUTABILIDADE DO SNAPSHOT ----
    psql(dbUrl, `
      insert into organizacoes(id,nome) values ('00000000-0000-0000-0000-0000000000a1','O');
      insert into unidades(id,nome)     values ('00000000-0000-0000-0000-0000000000b1','U');
      insert into bonificacao_competencia(id,organizacao_id,unidade_id,ano,mes,status,versao_atual)
        values ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',2026,8,'fechada',1);
      insert into bonificacao_competencia_snapshot(id,competencia_id,organizacao_id,unidade_id,ano,mes,versao,origem,snapshot)
        values ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',2026,8,1,'fechamento_mensal_direto','{"ok":true}'::jsonb);
    `);
    assert.match(psqlExpectFail(dbUrl, `update bonificacao_competencia_snapshot set versao = versao`), /append-only/i);
    assert.match(psqlExpectFail(dbUrl, `delete from bonificacao_competencia_snapshot`), /append-only/i);
    // não dá para apagar a competência que tem snapshot (RESTRICT)
    assert.match(psqlExpectFail(dbUrl, `delete from bonificacao_competencia where id='00000000-0000-0000-0000-0000000000c1'`), /viola|violat|restrict|foreign key/i);
    // nem a unidade / organização
    assert.match(psqlExpectFail(dbUrl, `delete from unidades where id='00000000-0000-0000-0000-0000000000b1'`), /viola|violat|restrict|foreign key/i);

    // INSERT de nova versão continua livre (append-only)
    psql(dbUrl, `
      update bonificacao_competencia set versao_atual=2 where id='00000000-0000-0000-0000-0000000000c1';
      insert into bonificacao_competencia_snapshot(competencia_id,organizacao_id,unidade_id,ano,mes,versao,origem,snapshot)
        values ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',2026,8,2,'fechamento_mensal_direto','{"v":2}'::jsonb);
    `);
    assert.equal(psql(dbUrl, `select count(*) from bonificacao_competencia_snapshot where competencia_id='00000000-0000-0000-0000-0000000000c1'`), "2");

    // idempotência: aplicar a 075 de novo não quebra
    const out2 = psql(dbUrl, `\\i ${arquivos.mig.replace(/\\/g, "/")}`);
    assert.doesNotMatch(out2, /erro|error|abortado/i);

    // NÃO limpamos os snapshots aqui — o trigger de imutabilidade recusa DELETE
    // (é justamente o comportamento que queremos). O cenário C dropa as tabelas
    // via rollback (DROP TABLE não dispara trigger de linha).
  });

  test("CENÁRIO D — fluxo F4: congelar (v1) → refechar bloqueado → reabrir → refechar (v2) → v1 intacto → legado", () => {
    // org/unidade próprios (a competência 2026-08 de O/U já foi usada no cenário B)
    psql(dbUrl, `
      insert into organizacoes(id,nome) values ('00000000-0000-0000-0000-0000000000a4','O4');
      insert into unidades(id,nome)     values ('00000000-0000-0000-0000-0000000000b4','U4');
    `);
    const ORG = "00000000-0000-0000-0000-0000000000a4";
    const UNI = "00000000-0000-0000-0000-0000000000b4";
    const fech = JSON.stringify({
      produtos_qtd_sanduiches: 2533, produtos_qtd_bebidas: 1086, produtos_qtd_adicionais: 613, produtos_qtd_diversos: 508,
      produtos_pct_bebidas_pdf: 42.9, produtos_pct_adicionais_pdf: 24.2, produtos_pct_diversos_pdf: 20.1,
      produtos_faturamento_loja: 41000, produtos_ppd: 57, produtos_torque: 53.33, produtos_perdas: 0,
      produtos_total_itens: 12761, produtos_estabelecimento: "Subway Teresina Saci", produtos_origem: "visio",
      vendas_faturamento: 109613.74, vendas_ticket_medio: 52.47, vendas_cupons_validos: 2089, vendas_cupons_vendas: 2089,
      vendas_metodos_pagamento: [{ metodo: "IFOOD ONLINE", qtd: 147, valor: 6649.45 }],
      vendas_estabelecimento: "Subway Teresina Saci", vendas_origem: "visio",
    }).replace(/'/g, "''");

    // 1. congela (fechamento_visio) → competência 'fechada' v1 + bfm + snapshot v1
    const r1 = psql(dbUrl, `select bonificacao_congelar_competencia(
      '${ORG}'::uuid,'${UNI}'::uuid,2026,8,'fechamento_mensal_direto',
      '{"origem":"fechamento_mensal_direto","valoresOficiais":{"faturamento":109613.74,"percentuais":{"bebidas":42.87}}}'::jsonb,
      '${fech}'::jsonb, null::text, null::uuid, null::text)`);
    assert.match(r1, /"versao"\s*:\s*1/);
    assert.match(r1, /"status"\s*:\s*"fechada"/);
    assert.equal(psql(dbUrl, `select status||' v'||versao_atual from bonificacao_competencia where unidade_id='${UNI}' and ano=2026 and mes=8`), "fechada v1");
    assert.equal(psql(dbUrl, `select count(*) from bonificacao_fechamento_mensal where unidade_id='${UNI}' and ano=2026 and mes=8`), "1");
    assert.equal(psql(dbUrl, `select produtos_canal_confirmado and periodo_confirmado_usuario from bonificacao_fechamento_mensal where unidade_id='${UNI}' and ano=2026 and mes=8`), "t");
    assert.equal(psql(dbUrl, `select fechamento_id is not null from bonificacao_competencia where unidade_id='${UNI}' and ano=2026 and mes=8`), "t");
    assert.equal(psql(dbUrl, `select snapshot->>'origem' from bonificacao_competencia_snapshot where unidade_id='${UNI}' and ano=2026 and mes=8 and versao=1`), "fechamento_mensal_direto");

    // 2. refechar sem reabrir → ERRO
    assert.match(psqlExpectFail(dbUrl, `select bonificacao_congelar_competencia('${ORG}'::uuid,'${UNI}'::uuid,2026,8,'fechamento_mensal_direto','{}'::jsonb,'${fech}'::jsonb,null::text,null::uuid,null::text)`), /ABORTADO[\s\S]*?FECHADA/i);

    // 3. reabrir sem motivo → ERRO; com motivo → 'reaberta'
    assert.match(psqlExpectFail(dbUrl, `select bonificacao_reabrir_competencia('${UNI}'::uuid,2026,8,'x',null::uuid,null::text)`), /motivo/i);
    psql(dbUrl, `select bonificacao_reabrir_competencia('${UNI}'::uuid,2026,8,'erro no PDF de vendas',null::uuid,null::text)`);
    assert.equal(psql(dbUrl, `select status from bonificacao_competencia where unidade_id='${UNI}' and ano=2026 and mes=8`), "reaberta");
    assert.equal(psql(dbUrl, `select versao_atual from bonificacao_competencia where unidade_id='${UNI}' and ano=2026 and mes=8`), "1"); // ainda v1 até refechar

    // 4. refechar → v2, competência 'fechada' v2, snapshot v1 INTACTO
    const r2 = psql(dbUrl, `select bonificacao_congelar_competencia('${ORG}'::uuid,'${UNI}'::uuid,2026,8,'fechamento_mensal_direto','{"v":2}'::jsonb,'${fech}'::jsonb,'refechado apos correcao',null::uuid,null::text)`);
    assert.match(r2, /"versao"\s*:\s*2/);
    assert.equal(psql(dbUrl, `select status||' v'||versao_atual from bonificacao_competencia where unidade_id='${UNI}' and ano=2026 and mes=8`), "fechada v2");
    assert.equal(psql(dbUrl, `select count(*) from bonificacao_competencia_snapshot where unidade_id='${UNI}' and ano=2026 and mes=8`), "2");
    assert.equal(psql(dbUrl, `select snapshot->>'origem' from bonificacao_competencia_snapshot where unidade_id='${UNI}' and ano=2026 and mes=8 and versao=1`), "fechamento_mensal_direto");
    assert.equal(psql(dbUrl, `select reaberta_em is null from bonificacao_competencia where unidade_id='${UNI}' and ano=2026 and mes=8`), "t"); // limpo ao refechar

    // 5. legado: outra competência, nunca fechada → captura congela como legado (p_fechamento = null)
    const rl = psql(dbUrl, `select bonificacao_congelar_competencia('${ORG}'::uuid,'${UNI}'::uuid,2026,7,'legado_pre_refatoracao','{"origem":"legado_pre_refatoracao","resumo":{"bonificacaoAtual":123}}'::jsonb,null::jsonb,'captura de rollout',null::uuid,null::text)`);
    assert.match(rl, /"status"\s*:\s*"legado_sem_fechamento"/);
    assert.equal(psql(dbUrl, `select status from bonificacao_competencia where unidade_id='${UNI}' and ano=2026 and mes=7`), "legado_sem_fechamento");
    assert.equal(psql(dbUrl, `select legado_capturado_em is not null from bonificacao_competencia where unidade_id='${UNI}' and ano=2026 and mes=7`), "t");
    // recongelar legado → ERRO
    assert.match(psqlExpectFail(dbUrl, `select bonificacao_congelar_competencia('${ORG}'::uuid,'${UNI}'::uuid,2026,7,'legado_pre_refatoracao','{}'::jsonb,null::jsonb,null::text,null::uuid,null::text)`), /ABORTADO[\s\S]*?LEGADO/i);
    // snapshot legado não referencia bfm
    assert.equal(psql(dbUrl, `select fechamento_id is null from bonificacao_competencia where unidade_id='${UNI}' and ano=2026 and mes=7`), "t");

    // 6. acompanhamento_diario: 3ª competência, p_fechamento = null → status 'fechada', origem 'acompanhamento_diario', sem bfm
    const ra = psql(dbUrl, `select bonificacao_congelar_competencia('${ORG}'::uuid,'${UNI}'::uuid,2026,6,'acompanhamento_diario','{"origem":"acompanhamento_diario","resumo":{"bonificacaoAtual":500}}'::jsonb,null::jsonb,'consolidacao',null::uuid,null::text)`);
    assert.match(ra, /"status"\s*:\s*"fechada"/);
    assert.equal(psql(dbUrl, `select status from bonificacao_competencia where unidade_id='${UNI}' and ano=2026 and mes=6`), "fechada");
    assert.equal(psql(dbUrl, `select snapshot->>'origem' from bonificacao_competencia_snapshot where unidade_id='${UNI}' and ano=2026 and mes=6 and versao=1`), "acompanhamento_diario");
    assert.equal(psql(dbUrl, `select fechamento_id is null from bonificacao_competencia where unidade_id='${UNI}' and ano=2026 and mes=6`), "t"); // sem bfm
    assert.equal(psql(dbUrl, `select fechada_em is not null from bonificacao_competencia where unidade_id='${UNI}' and ano=2026 and mes=6`), "t");
    // origem inválida → recusada pelo CHECK / pela função
    assert.match(psqlExpectFail(dbUrl, `select bonificacao_congelar_competencia('${ORG}'::uuid,'${UNI}'::uuid,2026,5,'fechamento_visio','{}'::jsonb,null::jsonb,null::text,null::uuid,null::text)`), /origem inv[áa]lida|check/i);
  });

  test("CENÁRIO C — rollback devolve o schema ao estado 074 (e é reexecutável)", () => {
    const out = psql(dbUrl, `\\i ${arquivos.rb.replace(/\\/g, "/")}`);
    assert.doesNotMatch(out, /erro|error/i);

    assert.equal(psql(dbUrl, `select to_regclass('bonificacao_fechamento_mensal')`), "");
    assert.equal(psql(dbUrl, `select to_regclass('bonificacao_mix_mensal') is not null`), "t");
    assert.equal(psql(dbUrl, `select to_regclass('bonificacao_competencia')`), "");
    assert.equal(psql(dbUrl, `select to_regclass('bonificacao_competencia_snapshot')`), "");

    const cols = psql(dbUrl, `select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name='bonificacao_mix_mensal'`).split(",");
    for (const c of ["qtd_sanduiches", "qtd_bebidas", "ppd_loja", "faturamento_loja", "percentual_bebidas_pdf", "estabelecimento", "hash_arquivo", "origem", "usuario_id"]) {
      assert.ok(cols.includes(c), `074: faltou coluna ${c} de volta`);
    }
    for (const c of ["produtos_qtd_sanduiches", "vendas_faturamento", "periodo_confirmado_usuario", "produtos_torque"]) {
      assert.ok(!cols.includes(c), `074: coluna ${c} não deveria ter voltado`);
    }
    // FKs de volta para CASCADE
    assert.equal(psql(dbUrl, `select confdeltype from pg_constraint where conname='bonificacao_mix_mensal_organizacao_id_fkey'`), "c");
    assert.equal(psql(dbUrl, `select confdeltype from pg_constraint where conname='bonificacao_mix_mensal_unidade_id_fkey'`), "c");
    // trigger/índices/policy de volta
    assert.equal(psql(dbUrl, `select count(*) from pg_trigger where tgrelid='bonificacao_mix_mensal'::regclass and tgname='trg_bmm_upd'`), "1");
    assert.equal(psql(dbUrl, `select count(*) from pg_policy where polrelid='bonificacao_mix_mensal'::regclass and polname='rls_bonificacao_mix_mensal_tenant'`), "1");

    // rollback reexecutável (não quebra rodando 2x)
    const out2 = psql(dbUrl, `\\i ${arquivos.rb.replace(/\\/g, "/")}`);
    assert.doesNotMatch(out2, /erro|error/i);
    assert.equal(psql(dbUrl, `select to_regclass('bonificacao_mix_mensal') is not null`), "t");
  });
});
