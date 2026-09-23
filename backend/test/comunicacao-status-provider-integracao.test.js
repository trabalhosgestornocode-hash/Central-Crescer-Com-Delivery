// H.4-B.4 — persistência das confirmações de entrega do provider (migration 095, RPC comunicacao_registrar_status_provider) contra o banco de TESTE.
// Cobre: SENT→DELIVERED→READ, SENT→READ, duplicados, atrasados, id desconhecido, isolamento entre organizações, estados intocáveis, ack/erro só em metadados,
// clamp de relógio, concorrência, e a interação com o TRIGGER do alerta (088/092): inicial propaga, reforço NÃO propaga, RESOLVED/CANCELLED não reabrem.
// PULA (não falha) sem credencial de banco descartável / sem as migrations 082-088-092-095.
// Rodar: node --env-file=.env --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-status-provider-integracao.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, criarUnidade, migracao082Aplicada, migracao088Aplicada, migracao092Aplicada } from "./helpers/comunicacao-fixtures.js";
import * as alertasRepo from "../src/modules/comunicacao/comunicacao.alertas.repo.js";
import { criarRepoSupabase } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";
import { TIPOS_ALERTA, SEVERIDADE } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
const aqui = dirname(fileURLToPath(import.meta.url));
const TIPO = TIPOS_ALERTA.DASHBOARD_IFOOD_D1;
let migracaoOk = true;
let orgA = null, orgB = null, unidadeA = null;
let seq = 0;
const repo = criarRepoSupabase();

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada()) && (await migracao092Aplicada());
  if (migracaoOk) {
    const sonda = await supabase.rpc("comunicacao_registrar_status_provider", { p_organizacao_id: "00000000-0000-0000-0000-000000000000", p_provider_message_id: "sonda", p_status: "READ", p_ocorrido_em: null, p_erro_codigo: null });
    migracaoOk = !sonda.error;
  }
  if (!migracaoOk) return;
  orgA = await criarOrganizacao("TESTE status-provider A — descartável");
  orgB = await criarOrganizacao("TESTE status-provider B — descartável");
  unidadeA = await criarUnidade(orgA, "Unidade Status A1");
});
after(async () => { await apagarOrganizacao(orgA); await apagarOrganizacao(orgB); });

const novoId = () => `3EB0TEST${Date.now()}${++seq}`;
const ENVIADO = () => new Date(Date.now() - 60_000).toISOString();

async function novoAlerta(dataReferencia, status = "SENT") {
  const { alerta } = await alertasRepo.criarOuEscalonarAlerta({
    organizacaoId: orgA, unidadeId: unidadeA, tipoAlerta: TIPO, dataReferencia, destinatarioPerfilId: null,
    severidade: SEVERIDADE.ATENCAO, motivo: "teste", metadados: {},
  });
  await supabase.from("comunicacao_alertas").update({ status }).eq("id", alerta.id);
  return alerta;
}
/** Mensagem de saída já SENT (ou o estado pedido) com provider_message_id — como a finalização do envio a deixa. */
async function novaMensagem({ organizacaoId = orgA, status = "SENT", providerId = novoId(), alertaId = null, proposito = null, enviadoEm = ENVIADO() } = {}) {
  const { data, error } = await supabase.from("comunicacao_mensagens").insert({
    organizacao_id: organizacaoId, unidade_id: organizacaoId === orgA ? unidadeA : null, alerta_id: alertaId, tipo: TIPO, conteudo: "teste", idempotency_key: `t:${randomUUID()}`,
    status, disponivel_em: new Date().toISOString(), enviado_em: enviadoEm, provider_message_id: providerId, metadados: proposito ? { proposito } : {},
  }).select("*").single();
  assert.equal(error, null, error?.message);
  return data;
}
const rpc = async (providerId, status, { organizacaoId = orgA, ocorridoEm = null, erroCodigo = null } = {}) => {
  const { data, error } = await supabase.rpc("comunicacao_registrar_status_provider", { p_organizacao_id: organizacaoId, p_provider_message_id: providerId, p_status: status, p_ocorrido_em: ocorridoEm, p_erro_codigo: erroCodigo });
  assert.equal(error, null, error?.message);
  return data;
};
const linha = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("id", id).single()).data;
const statusAlerta = async (id) => (await supabase.from("comunicacao_alertas").select("status").eq("id", id).single()).data.status;
const pular = (t) => { if (!migracaoOk) { t.skip("migrations 082-088-092-095 não aplicadas — pulando."); return true; } return false; };

describe("RPC comunicacao_registrar_status_provider — máquina monotônica", { skip: PULAR_INTEGRACAO }, () => {
  test("SENT -> DELIVERED preenche entregue_em; DELIVERED -> READ preenche lido_em; entregue_em é preservado", async (t) => {
    if (pular(t)) return;
    const m = await novaMensagem();
    assert.equal((await rpc(m.provider_message_id, "DELIVERED", { ocorridoEm: new Date().toISOString() })).resultado, "APLICADO");
    const d = await linha(m.id);
    assert.equal(d.status, "DELIVERED"); assert.ok(d.entregue_em); assert.equal(d.lido_em, null);
    const r = await rpc(m.provider_message_id, "READ");
    assert.deepEqual([r.resultado, r.status_anterior, r.status_atual], ["APLICADO", "DELIVERED", "READ"]);
    const l = await linha(m.id);
    assert.equal(l.status, "READ"); assert.ok(l.lido_em); assert.equal(l.entregue_em, d.entregue_em);
  });

  test("SENT -> READ direto: READ implica entrega (entregue_em preenchido junto)", async (t) => {
    if (pular(t)) return;
    const m = await novaMensagem();
    assert.equal((await rpc(m.provider_message_id, "READ")).resultado, "APLICADO");
    const l = await linha(m.id);
    assert.equal(l.status, "READ"); assert.ok(l.entregue_em && l.lido_em);
  });

  test("evento DUPLICADO é idempotente (nada muda, inclusive os timestamps)", async (t) => {
    if (pular(t)) return;
    const m = await novaMensagem();
    await rpc(m.provider_message_id, "DELIVERED");
    const antes = await linha(m.id);
    const r = await rpc(m.provider_message_id, "DELIVERED");
    assert.equal(r.resultado, "DUPLICADO");
    const depois = await linha(m.id);
    assert.equal(depois.status, "DELIVERED"); assert.equal(depois.entregue_em, antes.entregue_em);
    await rpc(m.provider_message_id, "READ");
    const lido = (await linha(m.id)).lido_em;
    assert.equal((await rpc(m.provider_message_id, "READ")).resultado, "DUPLICADO");
    assert.equal((await linha(m.id)).lido_em, lido);
  });

  test("evento ATRASADO nunca regride: DELIVERED depois de READ continua READ, sem alterar timestamps", async (t) => {
    if (pular(t)) return;
    const m = await novaMensagem();
    await rpc(m.provider_message_id, "READ");
    const antes = await linha(m.id);
    assert.equal((await rpc(m.provider_message_id, "DELIVERED")).resultado, "DUPLICADO");
    const depois = await linha(m.id);
    assert.equal(depois.status, "READ"); assert.equal(depois.entregue_em, antes.entregue_em); assert.equal(depois.lido_em, antes.lido_em);
  });

  test("receipt de id DESCONHECIDO: NAO_ENCONTRADA, sem exceção e sem tocar em nenhuma outra mensagem", async (t) => {
    if (pular(t)) return;
    const outra = await novaMensagem();
    assert.deepEqual(await rpc("ID-QUE-NAO-EXISTE", "READ"), { resultado: "NAO_ENCONTRADA" });
    assert.equal((await linha(outra.id)).status, "SENT");
  });

  test("ISOLAMENTO: mesmo providerMessageId em OUTRA organização não é alcançado (correlação é por organização)", async (t) => {
    if (pular(t)) return;
    const idComum = novoId();
    const daA = await novaMensagem({ organizacaoId: orgA, providerId: idComum });
    const daB = await novaMensagem({ organizacaoId: orgB, providerId: idComum });
    assert.equal((await rpc(idComum, "READ", { organizacaoId: orgA })).resultado, "APLICADO");
    assert.equal((await linha(daA.id)).status, "READ");
    assert.equal((await linha(daB.id)).status, "SENT");
  });

  test("dois registros com o MESMO id na MESMA organização: AMBIGUA e nenhum é alterado (fail-safe)", async (t) => {
    if (pular(t)) return;
    const idComum = novoId();
    const a = await novaMensagem({ providerId: idComum }); const b = await novaMensagem({ providerId: idComum });
    assert.deepEqual(await rpc(idComum, "READ"), { resultado: "AMBIGUA" });
    assert.equal((await linha(a.id)).status, "SENT"); assert.equal((await linha(b.id)).status, "SENT");
  });

  test("estados que um receipt NUNCA toca: SENDING/SCHEDULED/FAILED/CANCELLED/DELIVERY_UNKNOWN/BLOCKED/PROCESSING => ESTADO_NAO_ELEGIVEL", async (t) => {
    if (pular(t)) return;
    for (const st of ["SENDING", "SCHEDULED", "FAILED", "CANCELLED", "DELIVERY_UNKNOWN", "BLOCKED", "PROCESSING"]) {
      const m = await novaMensagem({ status: st });
      for (const ev of ["DELIVERED", "READ", "SERVER_ACK"]) {
        const r = await rpc(m.provider_message_id, ev);
        assert.deepEqual([r.resultado, r.status_atual], ["ESTADO_NAO_ELEGIVEL", st], `${st}+${ev}`);
      }
      const l = await linha(m.id);
      assert.equal(l.status, st); assert.equal(l.entregue_em, null); assert.equal(l.lido_em, null);
    }
  });

  test("mensagem de ENTRADA (direcao='entrada') com o mesmo id nunca é correlacionada", async (t) => {
    if (pular(t)) return;
    const id = novoId();
    await supabase.from("comunicacao_mensagens").insert({ organizacao_id: orgA, direcao: "entrada", tipo: TIPO, conteudo: "x", idempotency_key: `t:${randomUUID()}`, status: "SENT", disponivel_em: new Date().toISOString(), provider_message_id: id });
    assert.deepEqual(await rpc(id, "READ"), { resultado: "NAO_ENCONTRADA" });
  });

  test("SERVER_ACK e PROVIDER_ERROR ficam SÓ em metadados (status intacto, idempotentes, metadados anteriores preservados)", async (t) => {
    if (pular(t)) return;
    const m = await novaMensagem({ proposito: "reforco" });
    assert.equal((await rpc(m.provider_message_id, "SERVER_ACK")).resultado, "ACK_REGISTRADO");
    const primeiro = (await linha(m.id)).metadados.provider_ack.servidor_em;
    assert.ok(primeiro);
    assert.equal((await rpc(m.provider_message_id, "SERVER_ACK")).resultado, "DUPLICADO");
    assert.equal((await linha(m.id)).metadados.provider_ack.servidor_em, primeiro);
    assert.equal((await rpc(m.provider_message_id, "PROVIDER_ERROR", { erroCodigo: "479" })).resultado, "ERRO_REGISTRADO");
    assert.equal((await rpc(m.provider_message_id, "PROVIDER_ERROR", { erroCodigo: "500" })).resultado, "DUPLICADO");
    const l = await linha(m.id);
    assert.equal(l.status, "SENT"); assert.equal(l.metadados.proposito, "reforco", "metadados anteriores preservados"); assert.equal(l.metadados.provider_erro.codigo, "479");
  });

  test("parâmetros inválidos FALHAM alto (22023) — nunca gravam nada", async (t) => {
    if (pular(t)) return;
    const m = await novaMensagem();
    for (const args of [
      { p_provider_message_id: m.provider_message_id, p_status: "SENT" }, { p_provider_message_id: m.provider_message_id, p_status: "FAILED" },
      { p_provider_message_id: "", p_status: "READ" }, { p_provider_message_id: "x".repeat(129), p_status: "READ" },
      { p_provider_message_id: m.provider_message_id, p_status: "PROVIDER_ERROR" }, { p_provider_message_id: m.provider_message_id, p_status: "PROVIDER_ERROR", p_erro_codigo: "a b" },
    ]) {
      const { error } = await supabase.rpc("comunicacao_registrar_status_provider", { p_organizacao_id: orgA, p_ocorrido_em: null, p_erro_codigo: null, ...args });
      assert.ok(error && /STATUS_PROVIDER_INVALIDO/.test(error.message), JSON.stringify(args));
    }
    assert.equal((await linha(m.id)).status, "SENT");
  });

  test("relógio: nunca no futuro, nunca antes do próprio envio", async (t) => {
    if (pular(t)) return;
    const enviado = new Date(Date.now() - 30_000);
    const a = await novaMensagem({ enviadoEm: enviado.toISOString() });
    await rpc(a.provider_message_id, "DELIVERED", { ocorridoEm: new Date(Date.now() + 3600_000).toISOString() });
    // tolerância de 2 min entre o relógio do banco e o desta máquina; o pedido era +60 min
    assert.ok(new Date((await linha(a.id)).entregue_em).getTime() <= Date.now() + 120_000, "futuro é limitado a now() do banco");
    const b = await novaMensagem({ enviadoEm: enviado.toISOString() });
    await rpc(b.provider_message_id, "DELIVERED", { ocorridoEm: new Date(enviado.getTime() - 60_000).toISOString() });
    assert.equal(new Date((await linha(b.id)).entregue_em).getTime(), enviado.getTime(), "receipt 'anterior' ao enviado_em fica em enviado_em");
  });

  test("CONCORRÊNCIA: 20 eventos DELIVERED/READ simultâneos convergem para READ, com entregue_em e lido_em, sem erro", async (t) => {
    if (pular(t)) return;
    const m = await novaMensagem();
    const eventos = Array.from({ length: 20 }, (_, i) => (i % 2 ? "READ" : "DELIVERED"));
    const rs = await Promise.all(eventos.map((e) => rpc(m.provider_message_id, e)));
    assert.ok(rs.every((r) => ["APLICADO", "DUPLICADO"].includes(r.resultado)));
    const l = await linha(m.id);
    assert.equal(l.status, "READ"); assert.ok(l.entregue_em && l.lido_em);
  });
});

describe("TRIGGER do alerta × receipt (088/092)", { skip: PULAR_INTEGRACAO }, () => {
  test("mensagem INICIAL: SENT -> DELIVERED -> READ é refletido no alerta", async (t) => {
    if (pular(t)) return;
    const alerta = await novoAlerta("2026-09-01", "SENT");
    const m = await novaMensagem({ alertaId: alerta.id });
    await rpc(m.provider_message_id, "DELIVERED");
    assert.equal(await statusAlerta(alerta.id), "DELIVERED");
    await rpc(m.provider_message_id, "READ");
    assert.equal(await statusAlerta(alerta.id), "READ");
    await rpc(m.provider_message_id, "DELIVERED");   // atrasado
    assert.equal(await statusAlerta(alerta.id), "READ", "o alerta também não regride");
  });

  test("mensagem INICIAL SENT -> READ direto leva o alerta a READ", async (t) => {
    if (pular(t)) return;
    const alerta = await novaAlerta_("2026-09-02");
    const m = await novaMensagem({ alertaId: alerta.id });
    await rpc(m.provider_message_id, "READ");
    assert.equal(await statusAlerta(alerta.id), "READ");
  });

  test("REFORÇO (metadados.proposito='reforco'): a mensagem atualiza, o ALERTA NÃO é sobrescrito", async (t) => {
    if (pular(t)) return;
    const alerta = await novoAlerta("2026-09-03", "READ");           // a inicial já foi lida
    const r = await novaMensagem({ alertaId: alerta.id, proposito: "reforco" });
    await rpc(r.provider_message_id, "DELIVERED");
    assert.equal((await linha(r.id)).status, "DELIVERED");
    assert.equal(await statusAlerta(alerta.id), "READ", "reforço DELIVERED não regride o alerta READ");
    await rpc(r.provider_message_id, "READ");
    assert.equal((await linha(r.id)).status, "READ");
    assert.equal(await statusAlerta(alerta.id), "READ");
    const alerta2 = await novoAlerta("2026-09-04", "SENT");           // a inicial só foi enviada
    const r2 = await novaMensagem({ alertaId: alerta2.id, proposito: "reforco" });
    await rpc(r2.provider_message_id, "READ");
    assert.equal((await linha(r2.id)).status, "READ");
    assert.equal(await statusAlerta(alerta2.id), "SENT", "o reforço lido NÃO promove o alerta");
  });

  test("RESOLVED e CANCELLED NÃO são reabertos por um receipt tardio (a mensagem histórica é atualizada, a pendência não ressuscita)", async (t) => {
    if (pular(t)) return;
    for (const terminal of ["RESOLVED", "CANCELLED"]) {
      const alerta = await novoAlerta(terminal === "RESOLVED" ? "2026-09-05" : "2026-09-06", terminal);
      const m = await novaMensagem({ alertaId: alerta.id });
      await rpc(m.provider_message_id, "DELIVERED");
      await rpc(m.provider_message_id, "READ");
      assert.equal((await linha(m.id)).status, "READ", `${terminal}: a mensagem histórica é atualizada`);
      assert.equal(await statusAlerta(alerta.id), terminal, `${terminal}: o alerta continua terminal`);
    }
  });
});

describe("repo real (supabase-js) — contrato da resposta", { skip: PULAR_INTEGRACAO }, () => {
  test("registrarStatusProvider mapeia o jsonb da RPC (objeto, não array) e o organizacaoId vem do parâmetro", async (t) => {
    if (pular(t)) return;
    const m = await novaMensagem();
    assert.deepEqual(await repo.registrarStatusProvider(orgA, { providerMessageId: m.provider_message_id, status: "DELIVERED" }),
      { resultado: "APLICADO", statusAtual: "DELIVERED", statusAnterior: "SENT" });
    assert.equal((await repo.registrarStatusProvider(orgA, { providerMessageId: m.provider_message_id, status: "DELIVERED" })).resultado, "DUPLICADO");
    assert.equal((await repo.registrarStatusProvider(orgB, { providerMessageId: m.provider_message_id, status: "READ" })).resultado, "NAO_ENCONTRADA");
    await assert.rejects(repo.registrarStatusProvider("", { providerMessageId: "x", status: "READ" }));
    await assert.rejects(repo.registrarStatusProvider(orgA, { providerMessageId: m.provider_message_id, status: "INVALIDO" }));
  });
});

describe("migration 095 — arquivos", () => {
  const sql = readFileSync(join(aqui, "..", "..", "database", "migrations", "095_comunicacao_status_provider.sql"), "utf8").replace(/\r\n/g, "\n");
  const sqlSemComentarios = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  test("SECURITY INVOKER (padrão), search_path fixo, EXECUTE só service_role, sem mexer no trigger nem em coluna/enum", () => {
    assert.match(sqlSemComentarios, /revoke all on function comunicacao_registrar_status_provider\(uuid, text, text, timestamptz, text\) from public, anon, authenticated;/);
    assert.match(sqlSemComentarios, /grant execute on function comunicacao_registrar_status_provider\(uuid, text, text, timestamptz, text\) to service_role;/);
    assert.match(sqlSemComentarios, /set search_path = public/);
    assert.doesNotMatch(sqlSemComentarios, /security definer/i);
    assert.doesNotMatch(sqlSemComentarios, /alter table|add column|drop trigger|create trigger|create or replace function comunicacao_mensagens_sincroniza_alerta/i);
  });
  test("rollback remove a RPC e o índice", () => {
    const rb = readFileSync(join(aqui, "..", "..", "database", "migrations", "095_rollback.sql"), "utf8");
    assert.match(rb, /drop function if exists comunicacao_registrar_status_provider\(uuid, text, text, timestamptz, text\)/);
    assert.match(rb, /drop index if exists idx_comunicacao_mensagens_provider_msg/);
  });
});

// (helper local com nome distinto do topo só para legibilidade do teste SENT->READ)
async function novaAlerta_(dataReferencia) { return novoAlerta(dataReferencia, "SENT"); }
