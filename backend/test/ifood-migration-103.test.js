// Migration 103 (Checkpoint D) — guardas estáticas. A validação em Postgres (PGlite) roda à parte; aqui garantimos
// que o arquivo é aditivo, não toca nas migrations anteriores e que o rollback é seguro.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const MIG = path.join(AQUI, "../../database/migrations");
const ler = (f) => readFileSync(path.join(MIG, f), "utf8");
const semComentarios = (sql) => sql.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join("\n");

test("103 e 103_rollback existem; nada acima de 103 apareceu junto", () => {
  assert.ok(existsSync(path.join(MIG, "103_ifood_order_actions.sql")));
  assert.ok(existsSync(path.join(MIG, "103_rollback.sql")));
  // Posteriores conhecidas (não pertencem a este checkpoint): 104 = WhatsApp com vários destinatários (fim do piloto);
  // 105 = cache de retry do WhatsApp (reenvio sob retry receipt).
  const POSTERIORES_CONHECIDAS = new Set(["104_comunicacao_destinatarios_multiplos.sql", "104_rollback.sql", "105_whatsapp_retry_cache.sql", "105_rollback.sql",
    // 106 = registro do requestId da Reconciliation On Demand (Financial, homologação).
    "106_ifood_financial_reconciliacao_on_demand.sql", "106_rollback.sql",
    // 107 = RLS dos desbloqueios do Dashboard iFood (corretiva da 068); 108 = Dashboard iFood multicanal.
    "107_dashboard_ifood_desbloqueios_rls.sql", "108_dashboard_ifood_canais.sql", "108_rollback.sql",
    "109_comunicacao_envios_grupo.sql", "109_rollback.sql",
    // 110 = telas de exibição do Checklist (TV/tablet) e pareamento por código.
    "110_exibicao_dispositivos.sql", "110_rollback.sql",
    // 112/113 = papel "Operador de Exibição" (valor do enum + constraint de só-unidade) — Checklist via HDMI, Checkpoint 6B.
    "112_papel_operador_exibicao.sql", "112_rollback.sql", "113_papel_exibicao_somente_unidade.sql", "113_rollback.sql",
    // 114 = o RLS não concede nada à conta de exibição (auth_unidade_ids ignora o papel) — achado do 6B.3.
    "114_rls_exclui_papel_exibicao.sql", "114_rollback.sql",
    // 115 = fecha o acesso direto residual (views, unidade_config, RPCs) — proposta do 6B.4.
    "115_fecha_acesso_direto_residual.sql", "115_rollback.sql",
    // 116 = vinculo manual do merchant para unidades so com o app Order (111-115 reservadas a outros trabalhos).
    "116_ifood_merchant_vinculo_manual.sql", "116_rollback.sql"]);
  const acima = readdirSync(MIG).filter((f) => /^\d{3}_/.test(f) && Number(f.slice(0, 3)) > 103 && !POSTERIORES_CONHECIDAS.has(f));
  assert.deepEqual(acima, []);
});

test("103 é aditiva: nenhuma tabela é removida/truncada e nenhum dado é apagado ou reescrito", () => {
  const sql = semComentarios(ler("103_ifood_order_actions.sql"));
  assert.doesNotMatch(sql, /drop\s+table|truncate|delete\s+from|update\s+\w+\s+set/i);
  assert.doesNotMatch(sql, /drop\s+column/i);
  for (const tabela of ["ifood_pedidos", "ifood_pedido_acoes", "ifood_disputas"]) assert.match(sql, new RegExp(tabela));
  // só cria/estende objetos da família iFood
  assert.doesNotMatch(sql, /alter\s+table\s+(?!ifood_)/i);
});

test("103 não altera as migrations 056, 101 e 102 (sem CREATE OR REPLACE das funções da 101; ck da 102 só é substituído por DDL nova)", () => {
  const sql = semComentarios(ler("103_ifood_order_actions.sql"));
  assert.doesNotMatch(sql, /create\s+or\s+replace\s+function/i);
  // ifood_conexoes só aparece como alvo de FK (conexao_id) — nunca é alterada.
  assert.doesNotMatch(sql, /(alter\s+table|create\s+(unique\s+)?index\s+\S+\s+on|create\s+trigger\s+\S+\s+\w+\s+\w*\s*on|drop\s+\w+\s+\S+\s+on)\s+(if\s+exists\s+)?ifood_(conexoes|credenciais|oauth_sessoes|eventos|poller_lease)\b/i);
  assert.doesNotMatch(sql, /ifood_credenciais|ifood_oauth_sessoes|ifood_poller_lease/i);
  assert.match(sql, /references ifood_conexoes\(id\)/);
});

test("103: action_state aceita 13 valores por padrão único; estado incerto só com *_requested; RLS sem policy", () => {
  const sql = ler("103_ifood_order_actions.sql");
  assert.match(sql, /\^\(none\|\(confirm\|ready\|dispatch\|cancel\)_\(sending\|requested\|failed\)\)\$/);
  assert.match(sql, /action_uncertain = false or action_state ~ '_requested\$'/);
  assert.match(sql, /alter table ifood_disputas enable row level security/);
  assert.doesNotMatch(sql, /create\s+policy/i);
  assert.match(sql, /constraint uq_ifood_disputas_dispute_id unique \(dispute_id\)/);
  // auditoria: apenas ações do escopo autorizado
  assert.match(sql, /'confirm','ready','dispatch','cancel','dispute_accept','dispute_reject','dispute_alternative'/);
  assert.doesNotMatch(sql, /startPreparation|tracking/i);
});

test("103_rollback ABORTA se houver dados da 103 (disputas, ações novas, estados novos) e não recria nada além da 102", () => {
  const rb = ler("103_rollback.sql");
  assert.match(rb, /raise exception 'Rollback 103 abortado/);
  assert.ok(rb.indexOf("raise exception") < rb.indexOf("drop table if exists ifood_disputas"), "o abort vem ANTES de qualquer DROP");
  for (const parte of ["from ifood_disputas", "acao <> 'confirm'", "action_state !~", "ready_requested_at", "action_uncertain"]) assert.ok(rb.includes(parte), parte);
  // volta aos 4 valores da 102
  assert.match(rb, /action_state in \('none','confirm_sending','confirm_requested','confirm_failed'\)/);
});
