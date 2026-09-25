// Receipts contrato v2 ("VINCULADO") — prova contra o banco de TESTE descartável, com o repo REAL (filtros PostgREST reais) e a RPC 095 real.
// Envio manual vive na org da EMPRESA (diferente da org da conexão do gateway); o v2 só a alcança com providerMessageId + correlationId (idempotency_key) do MESMO registro.
// PULA (não falha) sem credencial de banco descartável / sem as migrations 082-088-092-095.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, migracao082Aplicada, migracao088Aplicada, migracao092Aplicada } from "./helpers/comunicacao-fixtures.js";
import { criarRepoSupabase } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";
import { TIPOS_ALERTA } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
const TIPO = TIPOS_ALERTA.DASHBOARD_IFOOD_D1;
let migracaoOk = true;
let orgConexao = null, orgEmpresa = null;
let seq = 0;
const repo = criarRepoSupabase();

async function limpar() {
  // apagar a org remove as mensagens (FK cascade); apaga também por organização, por segurança
  for (const o of [orgConexao, orgEmpresa]) {
    if (o) { await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", o); await apagarOrganizacao(o); }
  }
}

before(async () => {
  if (PULAR_INTEGRACAO) return;
  try {
    migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada()) && (await migracao092Aplicada());
    if (migracaoOk) {
      const sonda = await supabase.rpc("comunicacao_registrar_status_provider", { p_organizacao_id: "00000000-0000-0000-0000-000000000000", p_provider_message_id: "sonda", p_status: "READ", p_ocorrido_em: null, p_erro_codigo: null });
      migracaoOk = !sonda.error;
    }
    if (!migracaoOk) return;
    orgConexao = await criarOrganizacao("TESTE vinculado CONEXAO — descartável");
    orgEmpresa = await criarOrganizacao("TESTE vinculado EMPRESA — descartável");
  } catch (e) { await limpar(); throw e; }
});
after(limpar);

const novoId = () => `3EB0VINC${Date.now()}${++seq}`;
async function novaSaida(organizacaoId, { providerId = novoId(), status = "SENT" } = {}) {
  const { data, error } = await supabase.from("comunicacao_mensagens").insert({
    organizacao_id: organizacaoId, direcao: "saida", tipo: TIPO, conteudo: "teste", idempotency_key: `t:${randomUUID()}`,
    status, disponivel_em: new Date().toISOString(), enviado_em: new Date(Date.now() - 60_000).toISOString(), provider_message_id: providerId, metadados: {},
  }).select("*").single();
  assert.equal(error, null, error?.message);
  return data;
}
const linha = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("id", id).single()).data;
const v2 = (m, status, extra = {}) => ({ contrato: 2, providerMessageId: m.provider_message_id, correlationId: m.idempotency_key, status, ...extra });
const v1 = (m, status) => ({ providerMessageId: m.provider_message_id, status });
const pular = (t) => { if (!migracaoOk) { t.skip("migrations 082-088-092-095 não aplicadas — pulando."); return true; } return false; };

describe("receipt v2 VINCULADO — repo real + RPC 095 reais", { skip: PULAR_INTEGRACAO }, () => {
  test("manual (orgEmpresa): id+correlationId corretos => APLICADO; SENT->DELIVERED->READ só nessa linha", async (t) => {
    if (pular(t)) return;
    const manual = await novaSaida(orgEmpresa);
    const auto = await novaSaida(orgConexao);
    const r1 = await repo.registrarStatusProvider(orgConexao, v2(manual, "DELIVERED", { ocorridoEm: new Date().toISOString() }));
    assert.equal(r1.resultado, "APLICADO");
    let l = await linha(manual.id);
    assert.equal(l.status, "DELIVERED"); assert.ok(l.entregue_em); assert.equal(l.lido_em, null);
    const r2 = await repo.registrarStatusProvider(orgConexao, v2(manual, "READ"));
    assert.deepEqual([r2.resultado, r2.statusAnterior, r2.statusAtual], ["APLICADO", "DELIVERED", "READ"]);
    l = await linha(manual.id);
    assert.equal(l.status, "READ"); assert.ok(l.lido_em && l.entregue_em);
    const a = await linha(auto.id);
    assert.equal(a.status, "SENT"); assert.equal(a.entregue_em, null); assert.equal(a.lido_em, null, "linha da org da conexão intocada");
  });

  test("correlationId ERRADO => NAO_ENCONTRADA e nada muda", async (t) => {
    if (pular(t)) return;
    const manual = await novaSaida(orgEmpresa);
    const r = await repo.registrarStatusProvider(orgConexao, { ...v2(manual, "READ"), correlationId: `t:${randomUUID()}` });
    assert.equal(r.resultado, "NAO_ENCONTRADA");
    const l = await linha(manual.id);
    assert.equal(l.status, "SENT"); assert.equal(l.entregue_em, null); assert.equal(l.lido_em, null);
  });

  test("correlationId de uma linha + providerMessageId da OUTRA => NAO_ENCONTRADA; nenhuma das duas muda", async (t) => {
    if (pular(t)) return;
    const manual = await novaSaida(orgEmpresa);
    const auto = await novaSaida(orgConexao);
    const r1 = await repo.registrarStatusProvider(orgConexao, { ...v2(manual, "READ"), providerMessageId: auto.provider_message_id });
    assert.equal(r1.resultado, "NAO_ENCONTRADA");
    const r2 = await repo.registrarStatusProvider(orgConexao, { ...v2(auto, "READ"), providerMessageId: manual.provider_message_id });
    assert.equal(r2.resultado, "NAO_ENCONTRADA");
    for (const m of [manual, auto]) { const l = await linha(m.id); assert.equal(l.status, "SENT"); assert.equal(l.lido_em, null); }
  });

  test("providerMessageId desconhecido => NAO_ENCONTRADA (sem exceção)", async (t) => {
    if (pular(t)) return;
    const manual = await novaSaida(orgEmpresa);
    const r = await repo.registrarStatusProvider(orgConexao, { ...v2(manual, "READ"), providerMessageId: "ID-QUE-NAO-EXISTE" });
    assert.equal(r.resultado, "NAO_ENCONTRADA");
    assert.equal((await linha(manual.id)).status, "SENT");
  });

  test("DELIVERED duplicado => DUPLICADO (timestamps preservados)", async (t) => {
    if (pular(t)) return;
    const manual = await novaSaida(orgEmpresa);
    assert.equal((await repo.registrarStatusProvider(orgConexao, v2(manual, "DELIVERED"))).resultado, "APLICADO");
    const antes = await linha(manual.id);
    assert.equal((await repo.registrarStatusProvider(orgConexao, v2(manual, "DELIVERED"))).resultado, "DUPLICADO");
    const depois = await linha(manual.id);
    assert.equal(depois.status, "DELIVERED"); assert.equal(depois.entregue_em, antes.entregue_em);
  });

  test("READ e depois DELIVERED atrasado: não regride (DUPLICADO)", async (t) => {
    if (pular(t)) return;
    const manual = await novaSaida(orgEmpresa);
    await repo.registrarStatusProvider(orgConexao, v2(manual, "READ"));
    const antes = await linha(manual.id);
    assert.equal((await repo.registrarStatusProvider(orgConexao, v2(manual, "DELIVERED"))).resultado, "DUPLICADO");
    const depois = await linha(manual.id);
    assert.equal(depois.status, "READ"); assert.equal(depois.entregue_em, antes.entregue_em); assert.equal(depois.lido_em, antes.lido_em);
  });

  test("SERVER_ACK grava só metadados.provider_ack (status intacto)", async (t) => {
    if (pular(t)) return;
    const manual = await novaSaida(orgEmpresa);
    assert.equal((await repo.registrarStatusProvider(orgConexao, v2(manual, "SERVER_ACK"))).resultado, "ACK_REGISTRADO");
    const l = await linha(manual.id);
    assert.equal(l.status, "SENT"); assert.ok(l.metadados.provider_ack?.servidor_em); assert.equal(l.entregue_em, null); assert.equal(l.lido_em, null);
  });

  test("v1 (legado) com a org da conexão: alcança SÓ a linha da conexão, NUNCA a da orgEmpresa", async (t) => {
    if (pular(t)) return;
    const manual = await novaSaida(orgEmpresa);
    const auto = await novaSaida(orgConexao);
    assert.equal((await repo.registrarStatusProvider(orgConexao, v1(manual, "READ"))).resultado, "NAO_ENCONTRADA");
    assert.equal((await linha(manual.id)).status, "SENT");
    assert.equal((await repo.registrarStatusProvider(orgConexao, v1(auto, "DELIVERED"))).resultado, "APLICADO");
    assert.equal((await linha(auto.id)).status, "DELIVERED");
    assert.equal((await linha(manual.id)).status, "SENT");
  });

  test("automático (orgConexao) com v2 também funciona, sem tocar a linha da orgEmpresa", async (t) => {
    if (pular(t)) return;
    const manual = await novaSaida(orgEmpresa);
    const auto = await novaSaida(orgConexao);
    assert.equal((await repo.registrarStatusProvider(orgConexao, v2(auto, "READ"))).resultado, "APLICADO");
    const a = await linha(auto.id);
    assert.equal(a.status, "READ"); assert.ok(a.entregue_em && a.lido_em);
    assert.equal((await linha(manual.id)).status, "SENT");
  });
});
