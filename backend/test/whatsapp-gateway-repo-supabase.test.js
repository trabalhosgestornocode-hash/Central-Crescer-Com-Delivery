// Integração — Checkpoint C2: prova, contra o Supabase de TESTE real, que
// `criarRepoSupabase()` (whatsappGateway.repo.js) persiste corretamente em
// `whatsapp_conexoes` e que o isolamento multi-tenant é real, não só
// prometido em comentário. Mesmo padrão de guarda de
// comunicacao-dedup-constraint.test.js: PULA se o Supabase configurado não
// for comprovadamente descartável, ou se a migration 083 ainda não estiver
// aplicada nele.
//
// Também cobre, nas duas últimas describe(): o round-trip do auth state
// fake ponta a ponta (cripto real do gateway-whatsapp + repo real) e um
// heartbeat fake via HTTP com HMAC real — SEM Baileys, SEM WhatsApp
// conectado (Checkpoint C2, seções 5/6 do checklist).
//
// Rodar: npm run test:integracao -- test/whatsapp-gateway-repo-supabase.test.js
// (ou: node --env-file=.env.test-integracao --test test/whatsapp-gateway-repo-supabase.test.js)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import { createServer } from "node:http";

import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, migracao083Aplicada, migracao084Aplicada } from "./helpers/comunicacao-fixtures.js";
import { criarRepoSupabase } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";
import { exigirHmac, assinarRequisicao, _resetarNonces } from "../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";
import { criarWhatsappGatewayRouter } from "../src/modules/comunicacao/gateway/whatsappGateway.routes.js";

// Cripto REAL do Gateway — mesmo módulo que gateway-whatsapp/src/authState.js
// usa. Import cross-package por caminho relativo (crypto.js só depende de
// node:crypto, então é seguro importar direto do backend para provar o
// round-trip real sem subir o processo gateway-whatsapp inteiro).
import { encriptar, decriptar, normalizarChave } from "../../gateway-whatsapp/src/crypto.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
let migracaoOk = true;
let migracao084Ok = true;
let orgA = null;
let orgB = null;

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = await migracao083Aplicada();
  if (!migracaoOk) return;
  migracao084Ok = await migracao084Aplicada();
  orgA = await criarOrganizacao("TESTE whatsapp-gateway-repo — descartável A");
  orgB = await criarOrganizacao("TESTE whatsapp-gateway-repo — descartável B");
});

after(async () => {
  // FK organizacao_id ... on delete cascade: apagar a organização já limpa
  // qualquer linha de whatsapp_conexoes associada a ela.
  await apagarOrganizacao(orgA);
  await apagarOrganizacao(orgB);
});

describe("whatsappGateway.repo — criarRepoSupabase() contra o banco de teste real", { skip: PULAR_INTEGRACAO }, () => {
  test("registrarHeartbeat cria a conexão na primeira chamada e não duplica na segunda", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada neste Supabase — pulando.");
    const repo = criarRepoSupabase();

    await repo.registrarHeartbeat(orgA, { status: "CONNECTING", gatewayVersion: "0.1.0-teste" });
    await repo.registrarHeartbeat(orgA, { status: "CONNECTED", gatewayVersion: "0.1.0-teste", telefone: "+5511999990001" });

    const { data, error } = await supabase.from("whatsapp_conexoes").select("*").eq("organizacao_id", orgA);
    assert.ifError(error);
    assert.equal(data.length, 1, "esperava exatamente 1 linha — heartbeat repetido não deve duplicar");
    assert.equal(data[0].status, "CONNECTED");
    assert.equal(data[0].telefone_e164, "+5511999990001");
    assert.equal(data[0].gateway_version, "0.1.0-teste");
    assert.ok(data[0].connected_at, "status CONNECTED deveria setar connected_at");
  });

  test("busca por organizacao_id + provider_instance_id: obterAuthState de A nunca vê dado de B", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    const repo = criarRepoSupabase();

    await repo.salvarAuthState(orgB, { authStateEncrypted: "v1:aaaa:bbbb:cccc", authStateVersion: "v1" });
    const deA = await repo.obterAuthState(orgA);
    const deB = await repo.obterAuthState(orgB);

    assert.equal(deB, "v1:aaaa:bbbb:cccc");
    assert.notEqual(deA, "v1:aaaa:bbbb:cccc");
  });

  test("atualização de status: DISCONNECTED seta disconnected_at; LOGGED_OUT também", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    const repo = criarRepoSupabase();

    await repo.registrarHeartbeat(orgA, { status: "DISCONNECTED" });
    let conexao = await repo._obterConexao(orgA);
    assert.equal(conexao.status, "DISCONNECTED");
    assert.ok(conexao.disconnected_at);

    await repo.registrarHeartbeat(orgA, { status: "LOGGED_OUT" });
    conexao = await repo._obterConexao(orgA);
    assert.equal(conexao.status, "LOGGED_OUT");
    assert.ok(conexao.disconnected_at);
  });

  test("heartbeat atualiza last_seen_at a cada chamada", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    const repo = criarRepoSupabase();

    await repo.registrarHeartbeat(orgA, { status: "CONNECTED" });
    const primeiro = (await repo._obterConexao(orgA)).last_seen_at;

    await new Promise((r) => setTimeout(r, 20));
    await repo.registrarHeartbeat(orgA, { status: "CONNECTED" });
    const segundo = (await repo._obterConexao(orgA)).last_seen_at;

    assert.ok(new Date(segundo).getTime() > new Date(primeiro).getTime());
  });

  test("last_error_class é persistido e respeita o vocabulário fechado (CHECK)", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    const repo = criarRepoSupabase();

    await repo.registrarHeartbeat(orgA, { status: "DISCONNECTED", lastErrorClass: "RETRYAVEL" });
    assert.equal((await repo._obterConexao(orgA)).last_error_class, "RETRYAVEL");

    // Fora do vocabulário — o banco tem que recusar, não o app.
    const direto = await supabase.from("whatsapp_conexoes")
      .update({ last_error_class: "QUALQUER_COISA" })
      .eq("organizacao_id", orgA);
    assert.ok(direto.error, "esperava que o CHECK recusasse um last_error_class fora do vocabulário");
    assert.equal(direto.error.code, "23514"); // check_violation
  });

  test("auth_state_encrypted: salvarAuthState grava só o ciphertext, obterAuthState lê de volta exatamente", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    const repo = criarRepoSupabase();
    const blob = "v1:dGVzdGU=:YXNzaW5hdHVyYQ==:Y2lmcmFkbw==";

    await repo.salvarAuthState(orgA, { authStateEncrypted: blob, authStateVersion: "v7" });
    const lido = await repo.obterAuthState(orgA);
    assert.equal(lido, blob);

    const direto = await supabase.from("whatsapp_conexoes").select("auth_state_encrypted, auth_state_version").eq("organizacao_id", orgA).single();
    assert.equal(direto.data.auth_state_encrypted, blob);
    assert.equal(direto.data.auth_state_version, "v7");
  });

  test("UNIQUE (organizacao_id, provider_instance_id): segunda linha manual para o mesmo par é recusada", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    // orgA já tem uma linha 'default' das chamadas anteriores.
    const dup = await supabase.from("whatsapp_conexoes").insert({ organizacao_id: orgA, provider_instance_id: "default" });
    assert.ok(dup.error);
    assert.equal(dup.error.code, "23505"); // unique_violation
  });

  test("FK organizacao_id: insert com organização inexistente é recusado", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    const inexistente = "00000000-0000-4000-8000-000000000000";
    const r = await supabase.from("whatsapp_conexoes").insert({ organizacao_id: inexistente, provider_instance_id: "outra" });
    assert.ok(r.error);
    assert.equal(r.error.code, "23503"); // foreign_key_violation
  });

  test("CHECK status: valor fora do vocabulário fechado é recusado", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    const r = await supabase.from("whatsapp_conexoes").insert({ organizacao_id: orgA, provider_instance_id: "outra-instancia", status: "BOGUS" });
    assert.ok(r.error);
    assert.equal(r.error.code, "23514"); // check_violation
  });

  test("cross-org: heartbeat/auth-state de A nunca altera nem vaza para B", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    const repo = criarRepoSupabase();

    await repo.registrarHeartbeat(orgA, { status: "CONNECTED", telefone: "+5511900000001", gatewayVersion: "vA" });
    await repo.registrarHeartbeat(orgB, { status: "DISCONNECTED", telefone: "+5511900000002", gatewayVersion: "vB" });

    const a = await repo._obterConexao(orgA);
    const b = await repo._obterConexao(orgB);

    assert.equal(a.organizacao_id, orgA);
    assert.equal(b.organizacao_id, orgB);
    assert.notEqual(a.telefone_e164, b.telefone_e164);
    assert.notEqual(a.status, b.status);
    assert.notEqual(a.gateway_version, b.gateway_version);

    // Atualizar B não pode ter tocado A.
    await repo.registrarHeartbeat(orgB, { status: "CONNECTED", gatewayVersion: "vB2" });
    const aDepois = await repo._obterConexao(orgA);
    assert.equal(aDepois.status, "CONNECTED"); // continuava CONNECTED de antes, intocado
    assert.equal(aDepois.gateway_version, "vA");
  });
});

describe("round-trip do auth state fake — Gateway cifra -> Backend/Repo grava -> lê -> Gateway decifra", { skip: PULAR_INTEGRACAO }, () => {
  test("plaintext sobrevive idêntico (byte a byte) e o banco só vê ciphertext", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    const repo = criarRepoSupabase();

    // Chave fake, só para este teste — nunca a chave real do Gateway.
    const chave = normalizarChave(randomBytes(32).toString("base64"));
    const plaintextOriginal = JSON.stringify({
      creds: { fake: true, noiseKey: { private: Buffer.from("teste-c2-noise-key").toString("base64") } },
      keys: { "pre-key": { "1": { fake: "valor-c2" } } },
    });

    // Gateway cifra.
    const ciphertext = encriptar(plaintextOriginal, chave);
    assert.notEqual(ciphertext, plaintextOriginal);
    assert.match(ciphertext, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);

    // Backend recebe o ciphertext e o Repository grava.
    await repo.salvarAuthState(orgA, { authStateEncrypted: ciphertext, authStateVersion: "v1" });

    // O banco NUNCA vê o plaintext — só o ciphertext, exatamente como veio.
    const direto = await supabase.from("whatsapp_conexoes").select("auth_state_encrypted").eq("organizacao_id", orgA).single();
    assert.equal(direto.data.auth_state_encrypted, ciphertext);
    assert.ok(!direto.data.auth_state_encrypted.includes("noise-key"), "o banco não pode conter nenhum fragmento do plaintext");

    // Repository lê; Backend devolve o ciphertext; Gateway decifra.
    const lidoDoBanco = await repo.obterAuthState(orgA);
    assert.equal(lidoDoBanco, ciphertext);
    const plaintextDecifrado = decriptar(lidoDoBanco, chave);

    // Comparação byte a byte com a origem.
    assert.ok(Buffer.from(plaintextDecifrado, "utf8").equals(Buffer.from(plaintextOriginal, "utf8")));
    assert.equal(plaintextDecifrado, plaintextOriginal);

    // Registro artificial deste teste, removido ao final.
    await supabase.from("whatsapp_conexoes").update({ auth_state_encrypted: null, auth_state_version: null }).eq("organizacao_id", orgA);
  });

  test("decifrar com a chave errada lança (GCM detecta adulteração/chave incorreta)", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    const chaveCerta = normalizarChave(randomBytes(32).toString("base64"));
    const chaveErrada = normalizarChave(randomBytes(32).toString("base64"));
    const ciphertext = encriptar("segredo-c2", chaveCerta);
    assert.throws(() => decriptar(ciphertext, chaveErrada));
  });
});

describe("heartbeat fake via HTTP com HMAC real (Gateway -> Backend -> banco) — sem Baileys, sem WhatsApp", { skip: PULAR_INTEGRACAO }, () => {
  const SEGREDO = "h".repeat(32);
  let servidor;
  let baseUrl;

  before(async () => {
    if (PULAR_INTEGRACAO || !migracaoOk) return;
    const repo = criarRepoSupabase();
    const app = express();
    app.use(
      "/internal/comunicacao",
      express.raw({ type: "*/*", limit: 256 * 1024 }),
      exigirHmac(SEGREDO),
      criarWhatsappGatewayRouter({ repo, organizacaoId: orgA }),
    );
    await new Promise((resolve) => { servidor = createServer(app).listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(() => servidor?.close());

  async function chamarAssinado(metodo, caminho, corpoObj) {
    const corpo = corpoObj === undefined ? "" : JSON.stringify(corpoObj);
    const headers = assinarRequisicao({ segredo: SEGREDO, metodo, caminho, corpo });
    if (corpo) headers["Content-Type"] = "application/json";
    return fetch(`${baseUrl}${caminho}`, { method: metodo, headers, body: corpo || undefined });
  }

  test("heartbeat assinado com HMAC válido é persistido no banco real", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/comunicacao/eventos/heartbeat", {
      status: "CONNECTED", telefone: "+5511988880000", gatewayVersion: "0.1.0-c2-http",
    });
    assert.equal(r.status, 200);

    const { data, error } = await supabase.from("whatsapp_conexoes").select("*").eq("organizacao_id", orgA).single();
    assert.ifError(error);
    assert.equal(data.status, "CONNECTED");
    assert.equal(data.telefone_e164, "+5511988880000");
    assert.equal(data.gateway_version, "0.1.0-c2-http");
    assert.ok(Date.now() - new Date(data.last_seen_at).getTime() < 10_000, "last_seen_at deveria ser recentíssimo");
  });

  test("assinatura HMAC inválida é recusada com 401 genérico (e não altera o banco)", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    const antes = await supabase.from("whatsapp_conexoes").select("gateway_version").eq("organizacao_id", orgA).single();

    _resetarNonces();
    const r = await fetch(`${baseUrl}/internal/comunicacao/eventos/heartbeat`, {
      method: "POST",
      headers: {
        "X-Gateway-Timestamp": String(Date.now()),
        "X-Gateway-Nonce": "a".repeat(20),
        "X-Gateway-Signature": "0".repeat(64),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "CONNECTED", gatewayVersion: "FORJADO" }),
    });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "unauthorized" });

    const depois = await supabase.from("whatsapp_conexoes").select("gateway_version").eq("organizacao_id", orgA).single();
    assert.equal(depois.data.gateway_version, antes.data.gateway_version, "assinatura inválida não pode ter alterado o banco");
  });
});

// Checkpoint C3.5 — as MESMAS propriedades de lease/fencing verificadas em
// whatsapp-gateway-lease.test.js (repo em memória), agora contra o Postgres
// de teste real: aqui é onde a concorrência genuína entre duas conexões/
// processos distintos de fato acontece (o repo em memória só prova o
// contrato observável — ver comentário no outro arquivo). PULA se a
// migration 084 ainda não estiver aplicada no Supabase de teste configurado.
describe("whatsappGateway.repo — lease/fencing contra o Supabase de teste real (Checkpoint C3.5)", { skip: PULAR_INTEGRACAO }, () => {
  test("acquire simultâneo via DUAS conexões reais: exatamente um ganha, banco termina com um único owner e lease_epoch = epoch_lido+1", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    if (!migracao084Ok) return t.skip("migration 084 (lease/fencing) ainda não aplicada neste Supabase — pulando.");
    const repoA = criarRepoSupabase();
    const repoB = criarRepoSupabase();
    const a = randomBytes(16).toString("hex");
    const b = randomBytes(16).toString("hex");

    const [rA, rB] = await Promise.all([
      repoA.adquirirLease(orgA, { gatewayProcessId: a, ttlMs: 5000 }),
      repoB.adquirirLease(orgA, { gatewayProcessId: b, ttlMs: 5000 }),
    ]);

    const ganhadores = [rA, rB].filter((r) => r.acquired);
    assert.equal(ganhadores.length, 1, "exatamente um dos dois precisa ganhar, mesmo com duas conexões reais competindo no Postgres");

    const conexao = await repoA._obterConexao(orgA);
    assert.ok(conexao.lease_owner_id === a || conexao.lease_owner_id === b);
    assert.equal(conexao.lease_epoch, ganhadores[0].leaseEpoch);
  });

  test("relógio do processo Node artificialmente adiantado/atrasado NÃO muda a decisão — autoridade é sempre now() do Postgres", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    if (!migracao084Ok) return t.skip("migration 084 (lease/fencing) ainda não aplicada neste Supabase — pulando.");
    const OriginalDate = Date;
    try {
      const repo = criarRepoSupabase();
      const a = randomBytes(16).toString("hex");

      // Relógio do processo ATRASADO em 1 ano — se alguma decisão dependesse
      // de Date.now()/new Date() do lado do Node, o acquire abaixo
      // "pensaria" que qualquer expiração é muito no futuro. Como
      // criarRepoSupabase() nunca calcula timestamp nenhum (prova estrutural
      // em whatsapp-gateway-seguranca.test.js), isto não pode ter efeito
      // algum — só o now() do Postgres decide.
      global.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : [OriginalDate.now() - 365 * 24 * 60 * 60 * 1000])); }
        static now() { return OriginalDate.now() - 365 * 24 * 60 * 60 * 1000; }
      };

      const { leaseEpoch, acquired } = await repo.adquirirLease(orgA, { gatewayProcessId: a, ttlMs: 200 });
      assert.ok(acquired);

      global.Date = OriginalDate; // restaura para o setTimeout real esperar de verdade
      await new Promise((r) => setTimeout(r, 500)); // TTL vence de verdade (tempo real do Postgres)

      // Relógio do processo agora ADIANTADO em 1 ano — se a decisão de
      // "ainda válida?" dependesse do Node, isto faria a lease parecer
      // vencida há muito tempo (o que até bateria com a realidade aqui,
      // mas por acidente) — o ponto é que o resultado tem que ser o MESMO
      // independente de qual ddessas distorções o relógio local sofre.
      global.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : [OriginalDate.now() + 365 * 24 * 60 * 60 * 1000])); }
        static now() { return OriginalDate.now() + 365 * 24 * 60 * 60 * 1000; }
      };

      await assert.rejects(
        repo.registrarHeartbeat(orgA, { status: "CONNECTED", gatewayProcessId: a, leaseEpoch }),
        "a lease já venceu de verdade (tempo real do Postgres) — precisa rejeitar, com o relógio do Node dizendo qualquer coisa",
      );
    } finally {
      global.Date = OriginalDate;
    }
  });

  test("acquire pelo MESMO owner, ainda válido, é idempotente contra o Postgres real — não incrementa lease_epoch", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    if (!migracao084Ok) return t.skip("migration 084 (lease/fencing) ainda não aplicada neste Supabase — pulando.");
    const repo = criarRepoSupabase();
    const a = randomBytes(16).toString("hex");
    const primeiro = await repo.adquirirLease(orgB, { gatewayProcessId: a, ttlMs: 5000 });
    assert.ok(primeiro.acquired);
    const segundo = await repo.adquirirLease(orgB, { gatewayProcessId: a, ttlMs: 5000 });
    assert.equal(segundo.leaseEpoch, primeiro.leaseEpoch, "reacquire pelo mesmo dono não pode gerar epoch novo no Postgres real");
  });

  test("lease expirada mas ninguém tomou: heartbeat/auth-state são rejeitados pelo BANCO mesmo com owner_id/epoch batendo (não depende do relógio do Gateway)", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    if (!migracao084Ok) return t.skip("migration 084 (lease/fencing) ainda não aplicada neste Supabase — pulando.");
    const repo = criarRepoSupabase();
    const a = randomBytes(16).toString("hex");
    const { leaseEpoch, acquired } = await repo.adquirirLease(orgB, { gatewayProcessId: a, ttlMs: 200 });
    assert.ok(acquired);

    await new Promise((r) => setTimeout(r, 500)); // TTL vence de verdade no Postgres; ninguém mais adquiriu

    await assert.rejects(repo.registrarHeartbeat(orgB, { status: "DISCONNECTED", gatewayProcessId: a, leaseEpoch }));
    await assert.rejects(repo.salvarAuthState(orgB, { authStateEncrypted: "v1:atrasado", authStateVersion: "v1", gatewayProcessId: a, leaseEpoch }));

    const conexao = await repo._obterConexao(orgB);
    assert.notEqual(conexao.status, "DISCONNECTED", "a rejeição precisa ter impedido a escrita — status não pode ter mudado");
  });

  test("stale owner: B assume depois que a lease de A expira — A não consegue mais heartbeat, DISCONNECTED, auth-state nem release; dados de B intactos", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    if (!migracao084Ok) return t.skip("migration 084 (lease/fencing) ainda não aplicada neste Supabase — pulando.");
    const repo = criarRepoSupabase();
    const a = randomBytes(16).toString("hex");
    const b = randomBytes(16).toString("hex");

    const leaseA = await repo.adquirirLease(orgA, { gatewayProcessId: a, ttlMs: 200 });
    await repo.registrarHeartbeat(orgA, { status: "CONNECTED", gatewayVersion: "vA", gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch });

    await new Promise((r) => setTimeout(r, 500)); // TTL de A vence
    const leaseB = await repo.adquirirLease(orgA, { gatewayProcessId: b, ttlMs: 5000 });
    assert.ok(leaseB.acquired);
    assert.ok(leaseB.leaseEpoch > leaseA.leaseEpoch);
    await repo.registrarHeartbeat(orgA, { status: "CONNECTED", gatewayVersion: "vB", gatewayProcessId: b, leaseEpoch: leaseB.leaseEpoch });

    await assert.rejects(repo.registrarHeartbeat(orgA, { status: "DISCONNECTED", gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch }));
    await assert.rejects(repo.salvarAuthState(orgA, { authStateEncrypted: "v1:de-A-atrasado", authStateVersion: "v1", gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch }));
    const releaseStale = await repo.liberarLease(orgA, { gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch });
    assert.equal(releaseStale.released, false);

    const conexao = await repo._obterConexao(orgA);
    assert.equal(conexao.gateway_version, "vB", "dados de B precisam continuar intactos, intocados pelas tentativas de A");
    assert.equal(conexao.lease_owner_id, b);
  });
});
