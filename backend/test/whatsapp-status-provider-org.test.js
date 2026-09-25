// Receipts (SERVER_ACK/DELIVERED/READ) — qual ORGANIZAÇÃO vale para correlacionar o receipt com a mensagem enviada.
//
// INCIDENTE (25/09/2026): a mensagem manual enviada pelo Central ficou registrada na empresa do responsável (`contato.organizacoes[0]`, para
// histórico/auditoria) e o receipt era procurado só na org da CONEXÃO do Gateway (config do backend): NAO_ENCONTRADA para sempre, nunca DELIVERED/READ.
//
// CONTRATO NOVO: a org do receipt é a do REGISTRO de saída que carrega o id do provider (id gerado pelo nosso Gateway a cada envio) — resolvida no
// SERVIDOR, nunca do payload. Um dono ⇒ ele; vários ⇒ só vale a org da conexão, se estiver entre eles; senão NAO_ENCONTRADA (nunca escolhe por palpite).
// Cross-tenant continua impossível: o receipt só altera A mensagem com aquele id, dentro da org dona dela (o RPC 095 continua exigindo
// organizacao_id + provider_message_id + direcao='saida'); mensagens de qualquer outra org/id ficam intactas.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarRepoSupabase, criarRepoEmMemoria, escolherOrganizacaoDaSaida } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";

const ORG_CONEXAO = "00000000-0000-4000-8000-000000000000";
const ORG_EMPRESA = "b1448c7b-0000-4000-8000-000000000001";
const ORG_OUTRA = "c2559d8c-0000-4000-8000-000000000002";
const ID = "3EB0724C17E28CA93C4C8D";

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
const saida = (org, id = ID, extra = {}) => ({ organizacao_id: org, direcao: "saida", provider_message_id: id, ...extra });
const evento = (extra = {}) => ({ providerMessageId: ID, status: "DELIVERED", ocorridoEm: "2026-09-25T06:00:00.000Z", erroCodigo: null, ...extra });

describe("escolherOrganizacaoDaSaida — regra única do dono da saída", () => {
  test("nenhum dono ⇒ null; um dono ⇒ ele (mesmo que ≠ conexão); repetido na mesma org conta como um", () => {
    assert.equal(escolherOrganizacaoDaSaida([], ORG_CONEXAO), null);
    assert.equal(escolherOrganizacaoDaSaida([ORG_EMPRESA], ORG_CONEXAO), ORG_EMPRESA);
    assert.equal(escolherOrganizacaoDaSaida([ORG_EMPRESA, ORG_EMPRESA], ORG_CONEXAO), ORG_EMPRESA);
  });
  test("vários donos: só a da conexão vale; sem ela é ambíguo ⇒ null (nunca palpite)", () => {
    assert.equal(escolherOrganizacaoDaSaida([ORG_EMPRESA, ORG_CONEXAO], ORG_CONEXAO), ORG_CONEXAO);
    assert.equal(escolherOrganizacaoDaSaida([ORG_EMPRESA, ORG_OUTRA], ORG_CONEXAO), null);
  });
});

describe("repositório REAL — registrarStatusProvider resolve a org pelo registro", () => {
  const repo = criarRepoSupabase();

  test("REGRESSÃO DO INCIDENTE: envio manual na empresa do responsável (≠ org da conexão) ⇒ o RPC recebe a org DO REGISTRO e aplica", async () => {
    const db = clienteFalso([saida(ORG_EMPRESA)]);
    const r = await repo.registrarStatusProvider(ORG_CONEXAO, evento(), { supabase: db });
    assert.deepEqual(r, { resultado: "APLICADO", statusAtual: "DELIVERED", statusAnterior: "SENT" });
    assert.equal(db.chamadas.rpc.length, 1);
    assert.equal(db.chamadas.rpc[0].nome, "comunicacao_registrar_status_provider");
    assert.equal(db.chamadas.rpc[0].args.p_organizacao_id, ORG_EMPRESA, "org do REGISTRO, não a da conexão");
    assert.equal(db.chamadas.rpc[0].args.p_provider_message_id, ID);
    assert.equal(db.chamadas.rpc[0].args.p_status, "DELIVERED");
  });
  test("envio automático (org = conexão) continua igual", async () => {
    const db = clienteFalso([saida(ORG_CONEXAO)]);
    await repo.registrarStatusProvider(ORG_CONEXAO, evento({ status: "READ" }), { supabase: db });
    assert.equal(db.chamadas.rpc[0].args.p_organizacao_id, ORG_CONEXAO); assert.equal(db.chamadas.rpc[0].args.p_status, "READ");
  });
  test("a consulta é ESTRITA: só direcao='saida' e exatamente aquele provider_message_id (entrada/outros ids nunca entram)", async () => {
    const db = clienteFalso([saida(ORG_EMPRESA), { organizacao_id: ORG_OUTRA, direcao: "entrada", provider_message_id: ID }, saida(ORG_OUTRA, "OUTRO-ID")]);
    await repo.registrarStatusProvider(ORG_CONEXAO, evento(), { supabase: db });
    assert.deepEqual(db.chamadas.consultas[0], { tabela: "comunicacao_mensagens", filtros: { direcao: "saida", provider_message_id: ID }, limite: 20 });
    assert.equal(db.chamadas.rpc[0].args.p_organizacao_id, ORG_EMPRESA, "a linha 'entrada' e o outro id não influenciam");
  });
  test("id desconhecido ⇒ NAO_ENCONTRADA SEM chamar o RPC (nada é tocado)", async () => {
    const db = clienteFalso([saida(ORG_EMPRESA, "OUTRO-ID")]);
    assert.deepEqual(await repo.registrarStatusProvider(ORG_CONEXAO, evento(), { supabase: db }), { resultado: "NAO_ENCONTRADA" });
    assert.equal(db.chamadas.rpc.length, 0);
  });
  test("CROSS-TENANT: o mesmo id em duas orgs, nenhuma a da conexão ⇒ ambíguo: NAO_ENCONTRADA e NENHUMA é alterada (RPC não chamado)", async () => {
    const db = clienteFalso([saida(ORG_EMPRESA), saida(ORG_OUTRA)]);
    assert.deepEqual(await repo.registrarStatusProvider(ORG_CONEXAO, evento(), { supabase: db }), { resultado: "NAO_ENCONTRADA" });
    assert.equal(db.chamadas.rpc.length, 0);
  });
  test("lote saturado (id repetido 20+ vezes) ⇒ ambíguo: NAO_ENCONTRADA, RPC não chamado — nunca decide por uma amostra", async () => {
    const db = clienteFalso(Array.from({ length: 25 }, () => saida(ORG_EMPRESA)));
    assert.deepEqual(await repo.registrarStatusProvider(ORG_CONEXAO, evento(), { supabase: db }), { resultado: "NAO_ENCONTRADA" });
    assert.equal(db.chamadas.rpc.length, 0);
  });
  test("o mesmo id em duas orgs incluindo a da conexão ⇒ vale a da conexão (determinístico)", async () => {
    const db = clienteFalso([saida(ORG_EMPRESA), saida(ORG_CONEXAO)]);
    await repo.registrarStatusProvider(ORG_CONEXAO, evento(), { supabase: db });
    assert.equal(db.chamadas.rpc[0].args.p_organizacao_id, ORG_CONEXAO);
  });
  test("o RPC é chamado com a org resolvida também para SERVER_ACK e PROVIDER_ERROR (mesmo caminho)", async () => {
    for (const e of [evento({ status: "SERVER_ACK" }), evento({ status: "PROVIDER_ERROR", erroCodigo: "479" })]) {
      const db = clienteFalso([saida(ORG_EMPRESA)], { rpc: async () => ({ data: [{ resultado: "ACK_REGISTRADO", status_atual: "SENT" }], error: null }) });
      const r = await repo.registrarStatusProvider(ORG_CONEXAO, e, { supabase: db });
      assert.equal(r.resultado, "ACK_REGISTRADO"); assert.equal(db.chamadas.rpc[0].args.p_organizacao_id, ORG_EMPRESA);
    }
  });
  test("erro na consulta ou no RPC vira erro (500), nunca sucesso silencioso; resposta fora do contrato é recusada", async () => {
    await assert.rejects(() => repo.registrarStatusProvider(ORG_CONEXAO, evento(), { supabase: clienteFalso([], { erroConsulta: { message: "boom" } }) }), /boom/);
    await assert.rejects(() => repo.registrarStatusProvider(ORG_CONEXAO, evento(), { supabase: clienteFalso([saida(ORG_EMPRESA)], { rpc: async () => ({ data: null, error: { message: "rpc caiu" } }) }) }), /rpc caiu/);
    await assert.rejects(() => repo.registrarStatusProvider(ORG_CONEXAO, evento(), { supabase: clienteFalso([saida(ORG_EMPRESA)], { rpc: async () => ({ data: [{ resultado: "INVENTADO" }], error: null }) }) }), /inesperada/);
  });
  test("organizacaoId da conexão é obrigatório", async () => {
    await assert.rejects(() => repo.registrarStatusProvider("", evento(), { supabase: clienteFalso([]) }), /organizacaoId obrigat/);
  });
});

describe("repositório EM MEMÓRIA (usado pelos testes de rota) segue a MESMA regra", () => {
  const cria = () => criarRepoEmMemoria();
  test("dono único em outra org ⇒ aplica nele e só nele", async () => {
    const repo = cria();
    repo._semearMensagem(ORG_EMPRESA, { providerMessageId: ID, status: "SENT" });
    repo._semearMensagem(ORG_CONEXAO, { providerMessageId: "OUTRO", status: "SENT" });
    assert.equal((await repo.registrarStatusProvider(ORG_CONEXAO, evento())).resultado, "APLICADO");
    assert.equal(repo._mensagem(ORG_EMPRESA, ID).status, "DELIVERED");
    assert.equal(repo._mensagem(ORG_CONEXAO, "OUTRO").status, "SENT", "receipt nunca altera outra mensagem");
  });
  test("ambíguo sem a da conexão ⇒ NAO_ENCONTRADA e nada muda; com a da conexão ⇒ ela", async () => {
    const repo = cria();
    repo._semearMensagem(ORG_EMPRESA, { providerMessageId: ID, status: "SENT" }); repo._semearMensagem(ORG_OUTRA, { providerMessageId: ID, status: "SENT" });
    assert.equal((await repo.registrarStatusProvider(ORG_CONEXAO, evento())).resultado, "NAO_ENCONTRADA");
    assert.equal(repo._mensagem(ORG_EMPRESA, ID).status, "SENT"); assert.equal(repo._mensagem(ORG_OUTRA, ID).status, "SENT");
    repo._semearMensagem(ORG_CONEXAO, { providerMessageId: ID, status: "SENT" });
    assert.equal((await repo.registrarStatusProvider(ORG_CONEXAO, evento())).resultado, "APLICADO");
    assert.equal(repo._mensagem(ORG_CONEXAO, ID).status, "DELIVERED"); assert.equal(repo._mensagem(ORG_EMPRESA, ID).status, "SENT");
  });
  test("ordem dos receipts: SENT→DELIVERED→READ; DELIVERED depois de READ não regride; READ direto implica entrega; duplicado é idempotente", async () => {
    const repo = cria(); repo._semearMensagem(ORG_EMPRESA, { providerMessageId: ID, status: "SENT" });
    const enviar = async (status) => (await repo.registrarStatusProvider(ORG_CONEXAO, evento({ status }))).resultado;
    assert.equal(await enviar("READ"), "APLICADO"); const m = repo._mensagem(ORG_EMPRESA, ID); assert.ok(m.entregueEm && m.lidoEm);
    assert.equal(await enviar("DELIVERED"), "DUPLICADO"); assert.equal(repo._mensagem(ORG_EMPRESA, ID).status, "READ");
    assert.equal(await enviar("READ"), "DUPLICADO");
  });
});
