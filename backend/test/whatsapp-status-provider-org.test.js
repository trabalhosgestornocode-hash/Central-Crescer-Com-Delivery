// Receipts — contrato v2 (VINCULADO): qual ORGANIZAÇÃO vale e o que prova a origem do envio.
//
// INCIDENTE (25/09/2026): a mensagem manual do Central fica na empresa do responsável (`contato.organizacoes[0]`) e o receipt era procurado só na org da CONEXÃO
// do Gateway: NAO_ENCONTRADA para sempre. Endurecimento (decisão do dono do produto): NÃO aceitar lookup só por provider_message_id + HMAC. O receipt v2 carrega
//   - `providerInstanceId`: a instância emissora (conferida na rota contra a configurada);
//   - `correlationId`: a idempotencyKey do pedido de envio, que só o Gateway que enviou guardou (rastreio do envio);
// e a org é a do registro de saída que casa com providerMessageId E idempotency_key (UNIQUE no banco) — resolvida no servidor, nunca do payload.
// v1 (Gateway antigo) segue exatamente como antes: só a org da conexão.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarRepoSupabase, criarRepoEmMemoria } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";
import { validarEventoStatusProvider, CONTRATO_STATUS_VERSAO, CONTRATO_STATUS_VERSAO_VINCULADO } from "../src/modules/comunicacao/comunicacao.statusProvider.js";

const ORG_CONEXAO = "00000000-0000-4000-8000-000000000000";
const ORG_EMPRESA = "b1448c7b-0000-4000-8000-000000000001";
const ORG_OUTRA = "c2559d8c-0000-4000-8000-000000000002";
const ID = "3EB0724C17E28CA93C4C8D";
const CHAVE = "wa:manual:b1615aec-4140-43eb-82f5-3eea465a9cfc:v1";
const OUTRA_CHAVE = "wa:manual:11111111-2222-4333-8444-555555555555:v1";

/** Cliente Supabase mínimo: from().select().eq()...limit() sobre `linhas`; rpc() registra a chamada. */
function clienteFalso(linhas, { rpc, erroConsulta = null } = {}) {
  const chamadas = { consultas: [], rpc: [] };
  const from = (tabela) => {
    const filtros = {}; const q = {};
    q.select = () => q; q.eq = (c, v) => { filtros[c] = v; return q; };
    q.limit = async (n) => { chamadas.consultas.push({ tabela, filtros: { ...filtros }, limite: n }); return erroConsulta ? { data: null, error: erroConsulta } : { data: linhas.filter((l) => Object.entries(filtros).every(([c, v]) => l[c] === v)), error: null }; };
    return q;
  };
  const respostaPadrao = { data: [{ resultado: "APLICADO", status_anterior: "SENT", status_atual: "DELIVERED" }], error: null };
  return { chamadas, from, rpc: async (nome, args) => { chamadas.rpc.push({ nome, args }); return rpc ? rpc(nome, args) : respostaPadrao; } };
}
const saida = (org, extra = {}) => ({ organizacao_id: org, direcao: "saida", provider_message_id: ID, idempotency_key: CHAVE, ...extra });
const v2 = (extra = {}) => ({ contrato: 2, providerMessageId: ID, status: "DELIVERED", ocorridoEm: "2026-09-25T06:00:00.000Z", erroCodigo: null, providerInstanceId: "default", correlationId: CHAVE, ...extra });
const v1 = (extra = {}) => ({ providerMessageId: ID, status: "DELIVERED", ocorridoEm: "2026-09-25T06:00:00.000Z", erroCodigo: null, ...extra });

describe("validador — contrato v2 (vinculado)", () => {
  const corpo = (extra = {}) => ({ contratoStatus: 2, providerMessageId: ID, status: "DELIVERED", providerInstanceId: "default", correlationId: CHAVE, ...extra });
  test("v2 válido devolve o evento com contrato/instância/correlação; v1 válido devolve o formato antigo (sem campos novos)", () => {
    assert.equal(CONTRATO_STATUS_VERSAO, 1); assert.equal(CONTRATO_STATUS_VERSAO_VINCULADO, 2);
    assert.deepEqual(validarEventoStatusProvider(corpo()), { ok: true, evento: { providerMessageId: ID, status: "DELIVERED", ocorridoEm: null, ackTipo: null, erroCodigo: null, contrato: 2, providerInstanceId: "default", correlationId: CHAVE } });
    assert.deepEqual(validarEventoStatusProvider({ contratoStatus: 1, providerMessageId: ID, status: "READ" }), { ok: true, evento: { providerMessageId: ID, status: "READ", ocorridoEm: null, ackTipo: null, erroCodigo: null } });
  });
  test("v2 exige os DOIS campos, com formato fechado; códigos de erro nunca ecoam o valor", () => {
    const { providerInstanceId, ...semInstancia } = corpo(); const { correlationId, ...semChave } = corpo();
    assert.deepEqual(validarEventoStatusProvider(semInstancia), { ok: false, erro: "providerInstanceId_ausente" });
    assert.deepEqual(validarEventoStatusProvider(semChave), { ok: false, erro: "correlationId_ausente" });
    for (const [extra, campo] of [[{ providerInstanceId: "" }, "providerInstanceId"], [{ providerInstanceId: "a b" }, "providerInstanceId"], [{ providerInstanceId: "x".repeat(65) }, "providerInstanceId"], [{ providerInstanceId: 7 }, "providerInstanceId"],
      [{ correlationId: "" }, "correlationId"], [{ correlationId: "com espaço" }, "correlationId"], [{ correlationId: "x".repeat(201) }, "correlationId"], [{ correlationId: null }, "correlationId"]]) {
      const r = validarEventoStatusProvider(corpo(extra)); assert.deepEqual(r, { ok: false, erro: campo }); assert.ok(!JSON.stringify(r).includes("espaço"));
    }
  });
  test("v1 NUNCA carrega os campos do v2; versão desconhecida e chaves injetadas (organizacao_id) são recusadas", () => {
    assert.deepEqual(validarEventoStatusProvider({ contratoStatus: 1, providerMessageId: ID, status: "READ", providerInstanceId: "default" }), { ok: false, erro: "campo_desconhecido" });
    assert.deepEqual(validarEventoStatusProvider({ contratoStatus: 1, providerMessageId: ID, status: "READ", correlationId: CHAVE }), { ok: false, erro: "campo_desconhecido" });
    assert.deepEqual(validarEventoStatusProvider(corpo({ contratoStatus: 3 })), { ok: false, erro: "contratoStatus" });
    assert.deepEqual(validarEventoStatusProvider(corpo({ organizacao_id: ORG_EMPRESA })), { ok: false, erro: "campo_desconhecido" });
  });
});

describe("repositório REAL — org resolvida pelo registro vinculado (v2)", () => {
  const repo = criarRepoSupabase();

  test("REGRESSÃO DO INCIDENTE: manual na empresa do responsável (≠ conexão) + id + chave certos ⇒ o RPC recebe a org DO REGISTRO e aplica", async () => {
    const db = clienteFalso([saida(ORG_EMPRESA)]);
    const r = await repo.registrarStatusProvider(ORG_CONEXAO, v2(), { supabase: db });
    assert.deepEqual(r, { resultado: "APLICADO", statusAtual: "DELIVERED", statusAnterior: "SENT" });
    assert.equal(db.chamadas.rpc.length, 1);
    assert.equal(db.chamadas.rpc[0].nome, "comunicacao_registrar_status_provider");
    assert.equal(db.chamadas.rpc[0].args.p_organizacao_id, ORG_EMPRESA, "org do REGISTRO, não a da conexão");
    assert.equal(db.chamadas.rpc[0].args.p_provider_message_id, ID); assert.equal(db.chamadas.rpc[0].args.p_status, "DELIVERED");
  });
  test("a consulta é ESTRITA e por chave ÚNICA: direcao='saida' + idempotency_key + provider_message_id (nunca só o id do provider)", async () => {
    const db = clienteFalso([saida(ORG_EMPRESA)]);
    await repo.registrarStatusProvider(ORG_CONEXAO, v2(), { supabase: db });
    assert.deepEqual(db.chamadas.consultas[0], { tabela: "comunicacao_mensagens", filtros: { direcao: "saida", idempotency_key: CHAVE, provider_message_id: ID }, limite: 2 });
  });
  test("id certo + chave de OUTRA mensagem ⇒ NAO_ENCONTRADA, RPC não chamado; chave certa + id de outra ⇒ idem (o par tem de ser do MESMO registro)", async () => {
    const db = clienteFalso([saida(ORG_EMPRESA), saida(ORG_OUTRA, { provider_message_id: "OUTRO-ID", idempotency_key: OUTRA_CHAVE })]);
    assert.deepEqual(await repo.registrarStatusProvider(ORG_CONEXAO, v2({ correlationId: OUTRA_CHAVE }), { supabase: db }), { resultado: "NAO_ENCONTRADA" });
    assert.deepEqual(await repo.registrarStatusProvider(ORG_CONEXAO, v2({ providerMessageId: "OUTRO-ID" }), { supabase: db }), { resultado: "NAO_ENCONTRADA" });
    assert.equal(db.chamadas.rpc.length, 0);
  });
  test("linha de ENTRADA com o mesmo id/chave não conta (só saída); id desconhecido ⇒ NAO_ENCONTRADA sem RPC", async () => {
    const db = clienteFalso([saida(ORG_EMPRESA, { direcao: "entrada" })]);
    assert.deepEqual(await repo.registrarStatusProvider(ORG_CONEXAO, v2(), { supabase: db }), { resultado: "NAO_ENCONTRADA" });
    assert.equal(db.chamadas.rpc.length, 0);
  });
  test("mais de uma linha (impossível com idempotency_key UNIQUE) ⇒ sem dono: NAO_ENCONTRADA, nada é alterado", async () => {
    const db = clienteFalso([saida(ORG_EMPRESA), saida(ORG_OUTRA)]);
    assert.deepEqual(await repo.registrarStatusProvider(ORG_CONEXAO, v2(), { supabase: db }), { resultado: "NAO_ENCONTRADA" });
    assert.equal(db.chamadas.rpc.length, 0);
  });
  test("automático (org = conexão) e manual (org ≠ conexão) seguem o mesmo caminho e cada um usa a SUA org", async () => {
    for (const org of [ORG_CONEXAO, ORG_EMPRESA]) {
      const db = clienteFalso([saida(org)]);
      await repo.registrarStatusProvider(ORG_CONEXAO, v2({ status: "READ" }), { supabase: db });
      assert.equal(db.chamadas.rpc[0].args.p_organizacao_id, org); assert.equal(db.chamadas.rpc[0].args.p_status, "READ");
    }
  });
  test("SERVER_ACK e PROVIDER_ERROR também passam pela resolução vinculada", async () => {
    for (const e of [v2({ status: "SERVER_ACK" }), v2({ status: "PROVIDER_ERROR", erroCodigo: "479" })]) {
      const db = clienteFalso([saida(ORG_EMPRESA)], { rpc: async () => ({ data: [{ resultado: "ACK_REGISTRADO", status_atual: "SENT" }], error: null }) });
      const r = await repo.registrarStatusProvider(ORG_CONEXAO, e, { supabase: db });
      assert.equal(r.resultado, "ACK_REGISTRADO"); assert.equal(db.chamadas.rpc[0].args.p_organizacao_id, ORG_EMPRESA);
    }
  });
  test("v1 (legado): SEM consulta de resolução — o RPC recebe a org da CONEXÃO, como sempre foi", async () => {
    const db = clienteFalso([saida(ORG_EMPRESA)]);
    await repo.registrarStatusProvider(ORG_CONEXAO, v1(), { supabase: db });
    assert.equal(db.chamadas.consultas.length, 0); assert.equal(db.chamadas.rpc[0].args.p_organizacao_id, ORG_CONEXAO);
  });
  test("erro na consulta ou no RPC vira erro (500), nunca sucesso silencioso; resposta fora do contrato é recusada; org da conexão é obrigatória", async () => {
    await assert.rejects(() => repo.registrarStatusProvider(ORG_CONEXAO, v2(), { supabase: clienteFalso([], { erroConsulta: { message: "boom" } }) }), /boom/);
    await assert.rejects(() => repo.registrarStatusProvider(ORG_CONEXAO, v2(), { supabase: clienteFalso([saida(ORG_EMPRESA)], { rpc: async () => ({ data: null, error: { message: "rpc caiu" } }) }) }), /rpc caiu/);
    await assert.rejects(() => repo.registrarStatusProvider(ORG_CONEXAO, v2(), { supabase: clienteFalso([saida(ORG_EMPRESA)], { rpc: async () => ({ data: [{ resultado: "INVENTADO" }], error: null }) }) }), /inesperada/);
    await assert.rejects(() => repo.registrarStatusProvider("", v2(), { supabase: clienteFalso([]) }), /organizacaoId obrigat/);
  });
});

describe("repositório EM MEMÓRIA (usado pelos testes de rota) segue a MESMA regra", () => {
  test("v2 exige idempotencyKey + id do MESMO registro; v1 só a org da conexão", async () => {
    const repo = criarRepoEmMemoria();
    repo._semearMensagem(ORG_EMPRESA, { providerMessageId: ID, status: "SENT", idempotencyKey: CHAVE });
    assert.equal((await repo.registrarStatusProvider(ORG_CONEXAO, v1())).resultado, "NAO_ENCONTRADA", "v1 não alcança outra org");
    assert.equal((await repo.registrarStatusProvider(ORG_CONEXAO, v2({ correlationId: OUTRA_CHAVE }))).resultado, "NAO_ENCONTRADA");
    assert.equal(repo._mensagem(ORG_EMPRESA, ID).status, "SENT");
    assert.equal((await repo.registrarStatusProvider(ORG_CONEXAO, v2())).resultado, "APLICADO");
    assert.equal(repo._mensagem(ORG_EMPRESA, ID).status, "DELIVERED");
  });
});
