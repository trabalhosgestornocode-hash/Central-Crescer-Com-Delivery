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
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { createServer } from "node:http";

import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, migracao083Aplicada, migracao084Aplicada, migracao085Aplicada } from "./helpers/comunicacao-fixtures.js";
import { criarRepoSupabase, LeaseStaleError } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";
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
  // Checkpoint C3.5-B (correção de lacuna pré-existente) — desde o
  // Checkpoint C3.5-A, registrarHeartbeat/salvarAuthState SEMPRE exigem
  // fencing (gatewayProcessId+leaseEpoch); estes testes (Checkpoint C2, mais
  // antigos) nunca tinham sido atualizados para isso, e o gap só ficava
  // visível rodando este arquivo de propósito contra um Supabase com a
  // migration 084 aplicada (o `npm test` normal sempre pula este arquivo
  // inteiro via motivoPularIntegracao()). Lease própria, adquirida uma vez
  // aqui e reaproveitada por todos os testes deste describe (mesmo owner —
  // reacquire implícito nunca muda o epoch); LIBERADA no after() para não
  // vazar contenção para os describes seguintes (ex.: "Checkpoint C3.5"
  // mais abaixo, que testa expiração/takeover reais nos MESMOS orgA/orgB).
  let leaseA = null;
  let leaseB = null;

  before(async () => {
    if (PULAR_INTEGRACAO || !migracaoOk || !migracao084Ok) return;
    const repo = criarRepoSupabase();
    const procA = randomBytes(16).toString("hex");
    const procB = randomBytes(16).toString("hex");
    const rA = await repo.adquirirLease(orgA, { gatewayProcessId: procA, ttlMs: 60_000 });
    const rB = await repo.adquirirLease(orgB, { gatewayProcessId: procB, ttlMs: 60_000 });
    leaseA = { gatewayProcessId: procA, leaseEpoch: rA.leaseEpoch };
    leaseB = { gatewayProcessId: procB, leaseEpoch: rB.leaseEpoch };
  });
  after(async () => {
    if (!leaseA && !leaseB) return;
    const repo = criarRepoSupabase();
    if (leaseA) await repo.liberarLease(orgA, leaseA).catch(() => {});
    if (leaseB) await repo.liberarLease(orgB, leaseB).catch(() => {});
  });

  test("registrarHeartbeat cria a conexão na primeira chamada e não duplica na segunda", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada neste Supabase — pulando.");
    if (!migracao084Ok) return t.skip("migration 084 (fencing) ainda não aplicada neste Supabase — pulando.");
    const repo = criarRepoSupabase();

    await repo.registrarHeartbeat(orgA, { status: "CONNECTING", gatewayVersion: "0.1.0-teste", ...leaseA });
    await repo.registrarHeartbeat(orgA, { status: "CONNECTED", gatewayVersion: "0.1.0-teste", telefone: "+5511999990001", ...leaseA });

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
    if (!migracao084Ok) return t.skip("migration 084 (fencing) ainda não aplicada neste Supabase — pulando.");
    const repo = criarRepoSupabase();

    await repo.salvarAuthState(orgB, { authStateEncrypted: "v1:aaaa:bbbb:cccc", authStateVersion: "v1", ...leaseB });
    const deA = await repo.obterAuthState(orgA);
    const deB = await repo.obterAuthState(orgB);

    assert.equal(deB, "v1:aaaa:bbbb:cccc");
    assert.notEqual(deA, "v1:aaaa:bbbb:cccc");
  });

  test("atualização de status: DISCONNECTED seta disconnected_at; LOGGED_OUT também", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    if (!migracao084Ok) return t.skip("migration 084 (fencing) ainda não aplicada neste Supabase — pulando.");
    const repo = criarRepoSupabase();

    await repo.registrarHeartbeat(orgA, { status: "DISCONNECTED", ...leaseA });
    let conexao = await repo._obterConexao(orgA);
    assert.equal(conexao.status, "DISCONNECTED");
    assert.ok(conexao.disconnected_at);

    await repo.registrarHeartbeat(orgA, { status: "LOGGED_OUT", ...leaseA });
    conexao = await repo._obterConexao(orgA);
    assert.equal(conexao.status, "LOGGED_OUT");
    assert.ok(conexao.disconnected_at);
  });

  test("heartbeat atualiza last_seen_at a cada chamada", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    if (!migracao084Ok) return t.skip("migration 084 (fencing) ainda não aplicada neste Supabase — pulando.");
    const repo = criarRepoSupabase();

    await repo.registrarHeartbeat(orgA, { status: "CONNECTED", ...leaseA });
    const primeiro = (await repo._obterConexao(orgA)).last_seen_at;

    await new Promise((r) => setTimeout(r, 20));
    await repo.registrarHeartbeat(orgA, { status: "CONNECTED", ...leaseA });
    const segundo = (await repo._obterConexao(orgA)).last_seen_at;

    assert.ok(new Date(segundo).getTime() > new Date(primeiro).getTime());
  });

  test("last_error_class é persistido e respeita o vocabulário fechado (CHECK)", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    if (!migracao084Ok) return t.skip("migration 084 (fencing) ainda não aplicada neste Supabase — pulando.");
    const repo = criarRepoSupabase();

    await repo.registrarHeartbeat(orgA, { status: "DISCONNECTED", lastErrorClass: "RETRYAVEL", ...leaseA });
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
    if (!migracao084Ok) return t.skip("migration 084 (fencing) ainda não aplicada neste Supabase — pulando.");
    const repo = criarRepoSupabase();
    const blob = "v1:dGVzdGU=:YXNzaW5hdHVyYQ==:Y2lmcmFkbw==";

    await repo.salvarAuthState(orgA, { authStateEncrypted: blob, authStateVersion: "v7", ...leaseA });
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
    if (!migracao084Ok) return t.skip("migration 084 (fencing) ainda não aplicada neste Supabase — pulando.");
    const repo = criarRepoSupabase();

    await repo.registrarHeartbeat(orgA, { status: "CONNECTED", telefone: "+5511900000001", gatewayVersion: "vA", ...leaseA });
    await repo.registrarHeartbeat(orgB, { status: "DISCONNECTED", telefone: "+5511900000002", gatewayVersion: "vB", ...leaseB });

    const a = await repo._obterConexao(orgA);
    const b = await repo._obterConexao(orgB);

    assert.equal(a.organizacao_id, orgA);
    assert.equal(b.organizacao_id, orgB);
    assert.notEqual(a.telefone_e164, b.telefone_e164);
    assert.notEqual(a.status, b.status);
    assert.notEqual(a.gateway_version, b.gateway_version);

    // Atualizar B não pode ter tocado A.
    await repo.registrarHeartbeat(orgB, { status: "CONNECTED", gatewayVersion: "vB2", ...leaseB });
    const aDepois = await repo._obterConexao(orgA);
    assert.equal(aDepois.status, "CONNECTED"); // continuava CONNECTED de antes, intocado
    assert.equal(aDepois.gateway_version, "vA");
  });
});

describe("round-trip do auth state fake — Gateway cifra -> Backend/Repo grava -> lê -> Gateway decifra", { skip: PULAR_INTEGRACAO }, () => {
  test("plaintext sobrevive idêntico (byte a byte) e o banco só vê ciphertext", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    if (!migracao084Ok) return t.skip("migration 084 (fencing) ainda não aplicada neste Supabase — pulando.");
    const repo = criarRepoSupabase();
    // Checkpoint C3.5-B (correção de lacuna pré-existente) — salvarAuthState
    // exige fencing desde C3.5-A; lease própria, adquirida e liberada só
    // dentro deste teste (não vaza contenção para o describe seguinte).
    const procRoundTrip = randomBytes(16).toString("hex");
    const leaseRoundTrip = await repo.adquirirLease(orgA, { gatewayProcessId: procRoundTrip, ttlMs: 30_000 });
    assert.ok(leaseRoundTrip.acquired);
    const contextoLease = { gatewayProcessId: procRoundTrip, leaseEpoch: leaseRoundTrip.leaseEpoch };

    // Cleanup GARANTIDO (correção de qualidade) — try/finally: mesmo que
    // qualquer assertion abaixo lance no meio do teste, a lease própria
    // deste teste é liberada de qualquer forma, sem vazar contenção para o
    // describe seguinte.
    try {
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
      await repo.salvarAuthState(orgA, { authStateEncrypted: ciphertext, authStateVersion: "v1", ...contextoLease });

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
    } finally {
      // Libera a lease própria deste teste — não vaza contenção para os
      // describes seguintes, mesmo se algo acima tiver falhado.
      await repo.liberarLease(orgA, contextoLease).catch(() => {});
    }
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
  // Checkpoint C3.5-B (correção de lacuna pré-existente) — a rota
  // /eventos/heartbeat exige fencing no corpo desde C3.5-A; lease própria
  // deste describe, adquirida no before() e liberada no after() (não vaza
  // contenção para o describe "Checkpoint C3.5" logo abaixo, que testa
  // expiração/takeover reais no MESMO orgA).
  let leaseHttp = null;

  before(async () => {
    if (PULAR_INTEGRACAO || !migracaoOk) return;
    const repo = criarRepoSupabase();
    if (migracao084Ok) {
      // UUID de verdade (não randomBytes().toString('hex')) — a rota HTTP
      // valida o FORMATO de gatewayProcessId (whatsappGateway.routes.js#
      // processIdValido), diferente das chamadas diretas ao repo usadas
      // pelos outros describes deste arquivo, que aceitam qualquer string.
      const procHttp = randomUUID();
      const r = await repo.adquirirLease(orgA, { gatewayProcessId: procHttp, ttlMs: 60_000 });
      leaseHttp = { gatewayProcessId: procHttp, leaseEpoch: r.leaseEpoch };
    }
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
  after(async () => {
    servidor?.close();
    if (leaseHttp) await criarRepoSupabase().liberarLease(orgA, leaseHttp).catch(() => {});
  });

  async function chamarAssinado(metodo, caminho, corpoObj) {
    const corpo = corpoObj === undefined ? "" : JSON.stringify(corpoObj);
    const headers = assinarRequisicao({ segredo: SEGREDO, metodo, caminho, corpo });
    if (corpo) headers["Content-Type"] = "application/json";
    return fetch(`${baseUrl}${caminho}`, { method: metodo, headers, body: corpo || undefined });
  }

  test("heartbeat assinado com HMAC válido é persistido no banco real", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    if (!migracao084Ok) return t.skip("migration 084 (fencing) ainda não aplicada neste Supabase — pulando.");
    _resetarNonces();
    const r = await chamarAssinado("POST", "/internal/comunicacao/eventos/heartbeat", {
      status: "CONNECTED", telefone: "+5511988880000", gatewayVersion: "0.1.0-c2-http", ...leaseHttp,
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

    try {
      const [rA, rB] = await Promise.all([
        repoA.adquirirLease(orgA, { gatewayProcessId: a, ttlMs: 5000 }),
        repoB.adquirirLease(orgA, { gatewayProcessId: b, ttlMs: 5000 }),
      ]);

      const ganhadores = [rA, rB].filter((r) => r.acquired);
      assert.equal(ganhadores.length, 1, "exatamente um dos dois precisa ganhar, mesmo com duas conexões reais competindo no Postgres");

      const conexao = await repoA._obterConexao(orgA);
      assert.ok(conexao.lease_owner_id === a || conexao.lease_owner_id === b);
      assert.equal(conexao.lease_epoch, ganhadores[0].leaseEpoch);
    } finally {
      // Cleanup GARANTIDO (correção de qualidade) — roda mesmo se alguma
      // assertion acima tiver falhado; lê o estado ATUAL (nunca assume
      // quem ganhou, nem que a corrida terminou como esperado) e libera
      // quem quer que seja o dono corrente — sem isto, os 5s de TTL deste
      // acquire ficavam bloqueando orgA para os testes seguintes deste
      // describe (contenção real, não um bug deles).
      const conexaoAtual = await repoA._obterConexao(orgA).catch(() => null);
      if (conexaoAtual?.lease_owner_id === a || conexaoAtual?.lease_owner_id === b) {
        await repoA.liberarLease(orgA, { gatewayProcessId: conexaoAtual.lease_owner_id, leaseEpoch: conexaoAtual.lease_epoch }).catch(() => {});
      }
    }
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
    try {
      const primeiro = await repo.adquirirLease(orgB, { gatewayProcessId: a, ttlMs: 5000 });
      assert.ok(primeiro.acquired);
      const segundo = await repo.adquirirLease(orgB, { gatewayProcessId: a, ttlMs: 5000 });
      assert.equal(segundo.leaseEpoch, primeiro.leaseEpoch, "reacquire pelo mesmo dono não pode gerar epoch novo no Postgres real");
    } finally {
      // Cleanup GARANTIDO (correção de qualidade) — roda mesmo se alguma
      // assertion acima tiver falhado; lê o estado ATUAL em vez de assumir
      // que 'primeiro'/'segundo' foram atingidos — sem liberar, os 5s de
      // TTL bloqueavam orgB para o teste seguinte deste describe.
      const conexaoAtual = await repo._obterConexao(orgB).catch(() => null);
      if (conexaoAtual?.lease_owner_id === a) {
        await repo.liberarLease(orgB, { gatewayProcessId: a, leaseEpoch: conexaoAtual.lease_epoch }).catch(() => {});
      }
    }
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

    // ttlMs generoso (não 200 como os outros testes de expiração deste
    // describe) — de propósito: diferente deles, este teste faz uma chamada
    // de rede (registrarHeartbeat) ENTRE o acquire e a espera de expiração;
    // contra um Supabase real, essa chamada sozinha pode levar mais que
    // 200ms, fazendo a lease expirar ANTES mesmo do heartbeat de A ser
    // aceito (falso negativo, não um bug de fencing). Margem generosa nos
    // dois lados: TTL alto o bastante para sobreviver a UM round-trip real;
    // espera bem maior que o TTL para garantir expiração de verdade depois.
    const leaseA = await repo.adquirirLease(orgA, { gatewayProcessId: a, ttlMs: 3000 });
    try {
      // Prova EXPLÍCITA (correção de qualidade) de que a lease de A está
      // genuinamente válida ANTES da espera — não basta o heartbeat abaixo
      // "não lançar por acaso": embrulhar em assert.doesNotReject() usa o
      // resultado da própria operação FENCED como a prova (ela só pode ter
      // sucesso se, NESTE INSTANTE, lease_owner_id=a E lease_epoch=
      // leaseA.leaseEpoch E lease_expires_at>now() no Postgres — as MESMAS
      // três condições atômicas da migration 084). Nenhum acesso paralelo
      // ao banco foi adicionado; é a mesma chamada de sempre, só que agora
      // com a expectativa declarada explicitamente.
      await assert.doesNotReject(
        repo.registrarHeartbeat(orgA, { status: "CONNECTED", gatewayVersion: "vA", gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch }),
        "a lease de A precisa estar genuinamente válida ANTES da espera de expiração — o heartbeat fenced precisa ser aceito",
      );

      await new Promise((r) => setTimeout(r, 3500)); // TTL de A vence (3000ms), com folga
      const leaseB = await repo.adquirirLease(orgA, { gatewayProcessId: b, ttlMs: 5000 });
      assert.ok(leaseB.acquired, "takeover só pode ser possível DEPOIS da expiração real de A");
      assert.ok(leaseB.leaseEpoch > leaseA.leaseEpoch, "takeover precisa gerar um epoch novo, maior que o de A");
      await repo.registrarHeartbeat(orgA, { status: "CONNECTED", gatewayVersion: "vB", gatewayProcessId: b, leaseEpoch: leaseB.leaseEpoch });

      await assert.rejects(repo.registrarHeartbeat(orgA, { status: "DISCONNECTED", gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch }));
      await assert.rejects(repo.salvarAuthState(orgA, { authStateEncrypted: "v1:de-A-atrasado", authStateVersion: "v1", gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch }));
      const releaseStale = await repo.liberarLease(orgA, { gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch });
      assert.equal(releaseStale.released, false);

      const conexao = await repo._obterConexao(orgA);
      assert.equal(conexao.gateway_version, "vB", "dados de B precisam continuar intactos, intocados pelas tentativas de A");
      assert.equal(conexao.lease_owner_id, b);
    } finally {
      // Cleanup GARANTIDO (correção de qualidade) — roda mesmo se qualquer
      // assertion acima tiver falhado (inclusive ANTES do takeover de B
      // acontecer). Lê o estado ATUAL de orgA (nunca assume quem é o dono
      // nem que o takeover chegou a ocorrer) e libera quem quer que seja o
      // dono corrente — a ou b, o que estiver lá.
      const conexaoAtual = await repo._obterConexao(orgA).catch(() => null);
      if (conexaoAtual?.lease_owner_id === a || conexaoAtual?.lease_owner_id === b) {
        await repo.liberarLease(orgA, { gatewayProcessId: conexaoAtual.lease_owner_id, leaseEpoch: conexaoAtual.lease_epoch }).catch(() => {});
      }
    }
  });
});

// Checkpoint C3.5-B — validação REAL de whatsapp_desired_state_fenced (migration
// 085) contra o Supabase de teste. Organização/linha própria e descartável
// (orgC, apagada no after() abaixo — FK ON DELETE CASCADE também limpa a
// linha de whatsapp_conexoes associada). SEMPRE `provider_instance_id =
// 'teste-c35b'` — nunca 'default', nunca a organização real. PULA (não
// falha) se o Supabase configurado não for comprovadamente descartável
// (motivoPularIntegracao) ou se a migration 085 ainda não estiver aplicada
// nele.
describe("whatsappGateway.repo — desired_connection_state fenced contra o Supabase de teste real (Checkpoint C3.5-B)", { skip: PULAR_INTEGRACAO }, () => {
  const PROVIDER_TESTE = "teste-c35b";
  let orgC = null;
  let migracao085Ok = true;

  before(async () => {
    if (PULAR_INTEGRACAO || !migracaoOk) return;
    migracao085Ok = await migracao085Aplicada();
    if (!migracao085Ok) return;
    orgC = await criarOrganizacao("TESTE whatsapp-desired-state — descartável C");
  });
  after(async () => { await apagarOrganizacao(orgC); });

  test("A-L: ciclo completo de whatsapp_desired_state_fenced — owner válido, leitura, stale epoch, lease expirada, outro processo, takeover, owner stale, valor inválido, sem corrupção", async (t) => {
    if (!migracaoOk) return t.skip("migration 083 ainda não aplicada — pulando.");
    if (!migracao085Ok) return t.skip("migration 085 (desired_connection_state) ainda não aplicada neste Supabase — pulando.");
    const repo = criarRepoSupabase();
    const procA = randomBytes(16).toString("hex");
    const procB = randomBytes(16).toString("hex");

    // A — adquire lease válida para a fixture (owner A)
    const leaseA = await repo.adquirirLease(orgC, { gatewayProcessId: procA, ttlMs: 5000, providerInstanceId: PROVIDER_TESTE });
    assert.ok(leaseA.acquired, "A: lease inicial precisava ter sido concedida");

    // B — owner+epoch válidos: desired CONNECTED -> ok=true (não lança)
    await repo.definirEstadoDesejado(orgC, {
      desiredConnectionState: "CONNECTED", providerInstanceId: PROVIDER_TESTE,
      gatewayProcessId: procA, leaseEpoch: leaseA.leaseEpoch,
    });

    // C — confirmar leitura: CONNECTED
    let estado = await repo.obterEstadoSessao(orgC, { providerInstanceId: PROVIDER_TESTE, gatewayProcessId: procA, leaseEpoch: leaseA.leaseEpoch });
    assert.equal(estado.desiredConnectionState, "CONNECTED", "C: leitura precisava refletir CONNECTED");

    // D — mesmo owner: desired DISCONNECTED -> ok=true
    await repo.definirEstadoDesejado(orgC, {
      desiredConnectionState: "DISCONNECTED", providerInstanceId: PROVIDER_TESTE,
      gatewayProcessId: procA, leaseEpoch: leaseA.leaseEpoch,
    });

    // E — confirmar leitura: DISCONNECTED
    estado = await repo.obterEstadoSessao(orgC, { providerInstanceId: PROVIDER_TESTE, gatewayProcessId: procA, leaseEpoch: leaseA.leaseEpoch });
    assert.equal(estado.desiredConnectionState, "DISCONNECTED", "E: leitura precisava refletir DISCONNECTED");

    // F — stale epoch (mesmo owner, epoch errado, lease ainda válida) -> ok=false
    await assert.rejects(
      repo.definirEstadoDesejado(orgC, {
        desiredConnectionState: "CONNECTED", providerInstanceId: PROVIDER_TESTE,
        gatewayProcessId: procA, leaseEpoch: leaseA.leaseEpoch + 999,
      }),
      (e) => e instanceof LeaseStaleError,
      "F: epoch errado precisava ser recusado (LeaseStaleError)",
    );

    // G — lease expirada: renova (mesmo owner, ainda válido = idempotente, TTL curtíssimo),
    // deixa vencer de verdade no Postgres, tenta escrever -> ok=false
    const leaseCurta = await repo.adquirirLease(orgC, { gatewayProcessId: procA, ttlMs: 200, providerInstanceId: PROVIDER_TESTE });
    assert.ok(leaseCurta.acquired, "G: reacquire pelo mesmo dono (ainda válido) precisava funcionar antes do teste de expiração");
    await new Promise((r) => setTimeout(r, 500)); // TTL vence de verdade no Postgres
    await assert.rejects(
      repo.definirEstadoDesejado(orgC, {
        desiredConnectionState: "CONNECTED", providerInstanceId: PROVIDER_TESTE,
        gatewayProcessId: procA, leaseEpoch: leaseCurta.leaseEpoch,
      }),
      (e) => e instanceof LeaseStaleError,
      "G: lease expirada precisava ser recusada mesmo com owner_id/epoch batendo",
    );

    // H — outro process_id tentando (lease de A já venceu, ninguém tomou ainda) -> também recusado
    await assert.rejects(
      repo.definirEstadoDesejado(orgC, {
        desiredConnectionState: "CONNECTED", providerInstanceId: PROVIDER_TESTE,
        gatewayProcessId: procB, leaseEpoch: leaseCurta.leaseEpoch,
      }),
      (e) => e instanceof LeaseStaleError,
      "H: outro process_id sem ter adquirido a lease precisava ser recusado",
    );

    // I — takeover de verdade: B adquire (lease de A expirada), epoch novo, consegue gravar CONNECTED
    const leaseB = await repo.adquirirLease(orgC, { gatewayProcessId: procB, ttlMs: 5000, providerInstanceId: PROVIDER_TESTE });
    assert.ok(leaseB.acquired, "I: B precisava conseguir adquirir depois da lease de A vencer");
    assert.ok(leaseB.leaseEpoch > leaseCurta.leaseEpoch, "I: takeover precisava gerar um epoch novo, maior que o anterior");
    await repo.definirEstadoDesejado(orgC, {
      desiredConnectionState: "CONNECTED", providerInstanceId: PROVIDER_TESTE,
      gatewayProcessId: procB, leaseEpoch: leaseB.leaseEpoch,
    });
    estado = await repo.obterEstadoSessao(orgC, { providerInstanceId: PROVIDER_TESTE, gatewayProcessId: procB, leaseEpoch: leaseB.leaseEpoch });
    assert.equal(estado.desiredConnectionState, "CONNECTED", "I: novo owner (B) precisava ter conseguido gravar CONNECTED");

    // J — owner antigo (A) depois do takeover -> ok=false
    await assert.rejects(
      repo.definirEstadoDesejado(orgC, {
        desiredConnectionState: "DISCONNECTED", providerInstanceId: PROVIDER_TESTE,
        gatewayProcessId: procA, leaseEpoch: leaseCurta.leaseEpoch,
      }),
      (e) => e instanceof LeaseStaleError,
      "J: A (owner antigo) não podia mais escrever depois do takeover de B",
    );

    // K — valor inválido (fora do vocabulário do RPC/CHECK), com owner+epoch VÁLIDOS -> rejeitado com segurança, nunca ok=true silencioso
    await assert.rejects(
      repo.definirEstadoDesejado(orgC, {
        desiredConnectionState: "INVALID", providerInstanceId: PROVIDER_TESTE,
        gatewayProcessId: procB, leaseEpoch: leaseB.leaseEpoch,
      }),
      "K: valor fora do vocabulário precisava ser rejeitado pelo RPC/CHECK, nunca aceito silenciosamente",
    );

    // L — owner/epoch/valor atuais não corrompidos pela tentativa inválida (K)
    const conexaoFinal = await repo._obterConexao(orgC, PROVIDER_TESTE);
    assert.equal(conexaoFinal.desired_connection_state, "CONNECTED", "L: a tentativa inválida (K) não podia ter alterado desired_connection_state");
    assert.equal(conexaoFinal.lease_owner_id, procB, "L: lease_owner_id precisava continuar íntegro (B)");
    assert.equal(conexaoFinal.lease_epoch, leaseB.leaseEpoch, "L: lease_epoch precisava continuar íntegro (o de B)");
  });
});
