// Portões do pré-voo da implantação Foody 147–149 (função pura, sem banco): a idade do WAL só é AVISO no TESTE; em produção bloqueia.
// archive_mode desligado ou falha de arquivamento bloqueiam em qualquer alvo remoto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { avaliarPrevoo } from "../testes-seguros/foody-147-149/implantar.mjs";

const base = (wal) => ({
  identidade: { somente_leitura: "on", replica: false },
  historico: { existe: true, foody_registradas: [], numeros_147_149_ocupados: [], termo_v3_registrado: 1 },
  objetos_foody: [],
  dependencias: { tabelas: { unidades: true }, papeis: { service_role: true }, colunas_usuarios_organizacoes: 4, gen_random_uuid: true,
    hashtextextended: true, remapear_descobre_por_colunas: true },
  unidades_piloto: { subway_saci: { existe: true, ativa: true, organizacao_id: "a" }, acai_no_grau_saci: { existe: true, ativa: true, organizacao_id: "b" } },
  concorrencia: { locks_aguardando: 0, locks_fortes_unidades_organizacoes: 0, idle_in_transaction: 0, transacao_mais_longa_s: 0 },
  arquivamento_wal: { modo: "on", ultima_falha_depois_do_ultimo_ok: false, segundos_desde_ultimo: 30, ...wal },
});

test("WAL antigo: AVISO no teste, FALHA em produção", () => {
  const p = base({ segundos_desde_ultimo: 3800 });
  const avisosT = []; assert.deepEqual(avaliarPrevoo(p, "teste", avisosT), []); assert.match(avisosT[0], /3800s/);
  const avisosP = []; const fP = avaliarPrevoo(p, "producao", avisosP);
  assert.equal(fP.length, 1); assert.match(fP[0], /último WAL arquivado há 3800s/); assert.deepEqual(avisosP, []);
});

test("archive_mode desligado ou falha de arquivamento bloqueiam também no teste", () => {
  assert.ok(avaliarPrevoo(base({ modo: "off" }), "teste").some((f) => /archive_mode/.test(f)));
  assert.ok(avaliarPrevoo(base({ ultima_falha_depois_do_ultimo_ok: true }), "teste").some((f) => /falhando/.test(f)));
  assert.ok(avaliarPrevoo(base({ ultima_falha_depois_do_ultimo_ok: true }), "producao").some((f) => /falhando/.test(f)));
});

test("WAL recente: nenhum aviso nem falha; local ignora o arquivamento", () => {
  const av = []; assert.deepEqual(avaliarPrevoo(base({}), "producao", av), []); assert.deepEqual(av, []);
  assert.deepEqual(avaliarPrevoo(base({ modo: "off", segundos_desde_ultimo: 99999 }), "local"), []);
});

test("kit: SHA divergente não tem válvula de escape (nenhuma variável de ambiente pula a conferência)", async () => {
  const { readFileSync } = await import("node:fs");
  const fonte = readFileSync(new URL("../testes-seguros/foody-147-149/implantar.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(fonte, /IGNORAR_SHA/);
  assert.match(fonte, /if \(shaDiverge\.length\) parar\(/);
});

test("travas de alvo: declarar TESTE com conexão de PRODUÇÃO (direta ou pooler) é recusado — o aviso do WAL não alcança produção", async () => {
  const { travasDeAlvo } = await import("../testes-seguros/foody-147-149/implantar.mjs");
  for (const conn of ["postgresql://postgres:x@db.uqybgauuxcrqzquultfu.supabase.co:5432/postgres",
    "postgresql://postgres.uqybgauuxcrqzquultfu:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres"]) {
    assert.ok(travasDeAlvo({ FOODY_ALVO: "teste", FOODY_CONN: conn }).length > 0, conn.replace(/:x@/, ":***@"));
  }
  for (const alvo of ["TESTE", "Teste", "test", "", undefined]) assert.ok(travasDeAlvo({ FOODY_ALVO: alvo, FOODY_CONN: "postgresql://postgres:x@db.wiqqsxnysbzhcrzrrean.supabase.co:5432/postgres" }).length > 0);
  assert.ok(avaliarPrevoo(base({ segundos_desde_ultimo: 3800 }), "TESTE").length > 0, "alvo desconhecido = regra de produção");
});

test("recuperação: só derruba objetos foody_*, sem CASCADE/TRUNCATE, e só apaga os 3 registros por NOME exato", async () => {
  const { gerarPacote } = await import("../testes-seguros/foody-147-149/gerar_pacote.mjs");
  const sql = gerarPacote().arquivos["pacote_recuperar.sql"].replace(/^\s*--.*$/gm, "");
  assert.doesNotMatch(sql, /\bcascade\b|\btruncate\b|drop\s+schema|drop\s+role|drop\s+trigger|alter\s+table/i);
  const drops = [...sql.matchAll(/drop\s+(table|function|view|type|index|policy)\s+(?:if\s+exists\s+)?([\w."]+)/gi)].map((m) => m[2]);
  assert.ok(drops.length >= 24);
  for (const o of drops) assert.match(o, /^public\.foody_/, o);
  const deletes = [...sql.matchAll(/delete\s+from\s+([\w.]+)\s+where\s+([^;]+);/gi)];
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0][1], "supabase_migrations.schema_migrations");
  assert.equal(deletes[0][2].trim(), "name in ('147_foody_camada_central', '148_foody_conexao_compartilhada', '149_foody_conexao_administracao')");
  assert.match(sql, /:'assinatura'/); // sem -v assinatura o psql falha (fail-closed)
});

test("procedimento atual não referencia os arquivos antigos 144–146 da Foody", async () => {
  const { ARQUIVOS, NOMES } = await import("../testes-seguros/foody-147-149/sql_comum.mjs");
  assert.deepEqual(ARQUIVOS, ["147_foody_camada_central.sql", "148_foody_conexao_compartilhada.sql", "149_foody_conexao_administracao.sql"]);
  const { gerarPacote } = await import("../testes-seguros/foody-147-149/gerar_pacote.mjs");
  for (const t of Object.values(gerarPacote().arquivos)) assert.doesNotMatch(t, /14[4-6]_foody|14[4-6]_rollback/);
  assert.ok(NOMES.every((n) => /^14[7-9]_foody_/.test(n)));
});
