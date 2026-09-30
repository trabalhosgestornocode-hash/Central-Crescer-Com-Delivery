// SEGURANÇA DA TRANSIÇÃO (migration 104) — provada contra um Postgres REAL e DESCARTÁVEL (o projeto de TESTE), dentro de UMA transação que termina em
// ROLLBACK: nada persiste. Cenário: o banco "antigo" (schema pós-100, revertendo a 104 dentro da transação) com VÁRIAS empresas já existentes —
// umas habilitadas, outras não — e então a 104 é aplicada. Regras provadas:
//   * habilitado é PRESERVADO como estava;
//   * envio_automatico = false para TODAS as empresas, inclusive as já habilitadas (0 novas empresas com envio automático);
//   * nenhuma empresa é habilitada nem desabilitada pela migration; nenhum destinatário é apagado;
//   * destinatários existentes ganham SÓ a categoria que a empresa já permitia; o catálogo nasce só com pendencia_d1;
//   * o rollback (104_rollback.sql) restaura o schema anterior.
// PULA sozinho sem DATABASE_TESTE_URL / sem confirmação de banco descartável (nunca roda contra produção).
// Rodar: node --env-file=.env --env-file=.env.test-integracao --test test/comunicacao-migration-104.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertBancoDeTeste } from "./helpers/db-teste.js";
import { motivoIndisponivel } from "./helpers/psql-teste.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const MIG = join(aqui, "..", "..", "database", "migrations");
const PULAR = motivoIndisponivel();
const PSQL = [process.env.PSQL_PATH, "C:/Program Files/PostgreSQL/17/bin/psql.exe", "C:/Program Files/PostgreSQL/16/bin/psql.exe", "psql"].filter(Boolean).find((c) => c === "psql" || existsSync(c));

const semTransacao = (sql) => sql.split(/\r?\n/).filter((l) => !/^\s*(begin|commit)\s*;\s*$/i.test(l)).join("\n");
const lerSql = (nome) => semTransacao(readFileSync(join(MIG, nome), "utf8"));

function psqlTransacao(corpo) {
  const { url } = assertBancoDeTeste({ ...process.env, SUPABASE_URL: "" });
  const sql = `begin;\n${corpo}\nrollback;\n`;
  const r = spawnSync(PSQL, [url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"], { input: sql, encoding: "utf8", timeout: 120_000, env: { ...process.env, PGCLIENTENCODING: "UTF8" } });
  return { ok: r.status === 0, out: (r.stdout || "").replaceAll("\r", "").trim(), err: (r.stderr || "").replace(url, "<url-teste>") };
}

const ORG = ["a1000000-0000-4000-8000-000000000001", "a1000000-0000-4000-8000-000000000002", "a1000000-0000-4000-8000-000000000003", "a1000000-0000-4000-8000-000000000004"];

/** Estado ANTIGO: 4 empresas; 2 habilitadas (com responsável), 1 configurada e desabilitada, 1 sem configuração. */
const CENARIO_ANTIGO = `
insert into organizacoes (id, nome) values ${ORG.map((id, i) => `('${id}', 'TESTE-104 empresa ${i + 1}')`).join(", ")};
insert into contatos_whatsapp (id, telefone_e164, verificado, consentimento) values
  ('b1000000-0000-4000-8000-000000000001', '+5511970000001', true, true),
  ('b1000000-0000-4000-8000-000000000002', '+5511970000002', true, true),
  ('b1000000-0000-4000-8000-000000000003', '+5511970000003', true, true);
insert into comunicacao_contatos_empresa (id, organizacao_id, nome, telefone_e164, tipo, contato_whatsapp_id, whatsapp_status, whatsapp_validado_em, ativo) values
  ('c1000000-0000-4000-8000-000000000001', '${ORG[0]}', 'Resp 1', '+5511970000001', 'principal', 'b1000000-0000-4000-8000-000000000001', 'VALIDADO', now(), true),
  ('c1000000-0000-4000-8000-000000000002', '${ORG[1]}', 'Resp 2', '+5511970000002', 'principal', 'b1000000-0000-4000-8000-000000000002', 'VALIDADO', now(), true),
  ('c1000000-0000-4000-8000-000000000003', '${ORG[2]}', 'Resp 3', '+5511970000003', 'principal', 'b1000000-0000-4000-8000-000000000003', 'VALIDADO', now(), true);
insert into comunicacao_habilitacoes (organizacao_id, habilitado, tipos_permitidos, timezone, destinatario_contato_id, destinatario_contato_empresa_id) values
  ('${ORG[0]}', true,  '{dashboard_ifood_d1}', 'America/Fortaleza', 'b1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001'),
  ('${ORG[1]}', true,  '{dashboard_ifood_d1}', 'America/Sao_Paulo', 'b1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002'),
  ('${ORG[2]}', false, '{}',                   'America/Sao_Paulo', 'b1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000003');
`;

describe("MIGRATION 104 — segurança da transição (Postgres real e descartável, transação com ROLLBACK)", { skip: PULAR }, () => {
  test("com várias empresas já existentes: 0 empresas com envio automático; habilitado preservado; nada apagado", () => {
    const r = psqlTransacao(`
      ${lerSql("104_rollback.sql")}
      ${CENARIO_ANTIGO}
      select 'ANTES_habilitadas=' || count(*) filter (where habilitado) || ';total=' || count(*) from comunicacao_habilitacoes where organizacao_id in (${ORG.map((o) => `'${o}'`).join(",")});
      ${lerSql("104_comunicacao_destinatarios_multiplos.sql")}
      select 'DEPOIS_habilitadas=' || count(*) filter (where habilitado) || ';automaticas=' || count(*) filter (where envio_automatico) || ';total=' || count(*) from comunicacao_habilitacoes where organizacao_id in (${ORG.map((o) => `'${o}'`).join(",")});
      select 'GLOBAL_automaticas=' || count(*) from comunicacao_habilitacoes where envio_automatico;
      select 'RESPONSAVEIS=' || count(*) from comunicacao_contatos_empresa where organizacao_id in (${ORG.map((o) => `'${o}'`).join(",")});
      select 'CATEGORIAS_CATALOGO=' || string_agg(codigo, ',') from comunicacao_categorias;
      select 'CATEGORIAS_DEST=' || count(*) from comunicacao_destinatario_categorias where organizacao_id in (${ORG.map((o) => `'${o}'`).join(",")});
    `);
    assert.equal(r.ok, true, r.err);
    const linhas = new Map(r.out.split("\n").map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]));
    assert.equal(linhas.get("ANTES_habilitadas"), "2;total=3");
    assert.equal(linhas.get("DEPOIS_habilitadas"), "2;automaticas=0;total=3", "habilitado preservado e NENHUMA empresa com envio automático");
    assert.equal(linhas.get("GLOBAL_automaticas"), "0", "0 novas empresas com envio automático no banco inteiro");
    assert.equal(linhas.get("RESPONSAVEIS"), "3", "nenhum destinatário apagado");
    assert.equal(linhas.get("CATEGORIAS_CATALOGO"), "pendencia_d1", "só o que já existe funcionalmente");
    assert.equal(linhas.get("CATEGORIAS_DEST"), "2", "só os destinatários de empresas que JÁ permitiam dashboard_ifood_d1 ganham a categoria");
  });

  test("uma empresa já habilitada NÃO é elegível ao envio até o envio automático ser ligado (RPC de agendamento recusa)", () => {
    const r = psqlTransacao(`
      ${lerSql("104_rollback.sql")}
      ${CENARIO_ANTIGO}
      ${lerSql("104_comunicacao_destinatarios_multiplos.sql")}
      insert into comunicacao_alertas (id, organizacao_id, tipo_alerta, data_referencia, severidade, status) values ('d1000000-0000-4000-8000-000000000001', '${ORG[0]}', 'dashboard_ifood_d1', '2026-09-10', 'atencao', 'DETECTED');
      select 'AGENDAR=' || ((comunicacao_agendar_mensagens_alerta('d1000000-0000-4000-8000-000000000001', 'inicial', null,
        '[{"contato_empresa_id":"c1000000-0000-4000-8000-000000000001","conteudo":"x","disponivel_em":"2026-09-16T13:00:00Z"}]'::jsonb, 5))->>'acao');
      select 'MENSAGENS=' || count(*) from comunicacao_mensagens where alerta_id = 'd1000000-0000-4000-8000-000000000001';
      select 'LIGAR_SEM_HABILITAR=' || ((comunicacao_definir_envio_automatico('${ORG[3]}', true, null))->>'acao');
      select 'LIGAR=' || ((comunicacao_definir_envio_automatico('${ORG[0]}', true, null))->>'acao');
      select 'AGENDAR_DEPOIS=' || ((comunicacao_agendar_mensagens_alerta('d1000000-0000-4000-8000-000000000001', 'inicial', null,
        '[{"contato_empresa_id":"c1000000-0000-4000-8000-000000000001","conteudo":"x","disponivel_em":"2026-09-16T13:00:00Z"}]'::jsonb, 5))->>'acao');
      select 'MENSAGENS_DEPOIS=' || count(*) from comunicacao_mensagens where alerta_id = 'd1000000-0000-4000-8000-000000000001';
    `);
    assert.equal(r.ok, true, r.err);
    const m = Object.fromEntries(r.out.split("\n").map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]));
    assert.equal(m.AGENDAR, "ENVIO_AUTOMATICO_DESLIGADO");
    assert.equal(m.MENSAGENS, "0");
    assert.equal(m.LIGAR_SEM_HABILITAR, "SEM_CONFIGURACAO");
    assert.equal(m.LIGAR, "LIGADO", "só uma ação explícita liga o envio automático");
    assert.equal(m.AGENDAR_DEPOIS, "OK");
    assert.equal(m.MENSAGENS_DEPOIS, "1");
  });

  test("a migration é idempotente (reaplicar não muda nada) e o ROLLBACK restaura o schema pós-100", () => {
    const r = psqlTransacao(`
      ${lerSql("104_rollback.sql")}
      ${CENARIO_ANTIGO}
      ${lerSql("104_comunicacao_destinatarios_multiplos.sql")}
      ${lerSql("104_comunicacao_destinatarios_multiplos.sql")}
      select 'AUTOMATICAS_APOS_2X=' || count(*) from comunicacao_habilitacoes where envio_automatico;
      ${lerSql("104_rollback.sql")}
      select 'COLUNA_APOS_ROLLBACK=' || count(*) from information_schema.columns where table_name = 'comunicacao_habilitacoes' and column_name = 'envio_automatico';
      select 'TABELA_APOS_ROLLBACK=' || coalesce(to_regclass('comunicacao_categorias')::text, 'ausente');
      select 'RESERVA_9_ARGS=' || (to_regprocedure('comunicacao_reservar_envio(uuid,text,bigint,integer,numeric,integer,integer,integer,timestamptz)') is not null);
      select 'HABILITADAS_APOS_ROLLBACK=' || count(*) filter (where habilitado) from comunicacao_habilitacoes where organizacao_id in (${ORG.map((o) => `'${o}'`).join(",")});
    `);
    assert.equal(r.ok, true, r.err);
    const m = Object.fromEntries(r.out.split("\n").map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1)]));
    assert.equal(m.AUTOMATICAS_APOS_2X, "0");
    assert.equal(m.COLUNA_APOS_ROLLBACK, "0");
    assert.equal(m.TABELA_APOS_ROLLBACK, "ausente");
    assert.equal(m.RESERVA_9_ARGS, "true");
    assert.equal(m.HABILITADAS_APOS_ROLLBACK, "2", "o rollback preserva o estado habilitado");
  });

  test("nada persiste: o teste inteiro rodou em transação com ROLLBACK", () => {
    const r = psqlTransacao(`select 'RESIDUO=' || count(*) from organizacoes where nome like 'TESTE-104 empresa%';`);
    assert.equal(r.ok, true, r.err);
    assert.equal(r.out, "RESIDUO=0");
  });
});
