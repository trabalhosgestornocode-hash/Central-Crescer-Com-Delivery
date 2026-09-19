// Checkpoint C3.5-C.8.2 — hardening da PERSISTÊNCIA do auth state contra o beco sem saída do incidente
// de 2026-09-19 (um HTTP 413 deixou uma Promise rejeitada guardada como "estado"; o drain a relançava para
// sempre e nenhuma reconexão voltava a acontecer). Usa o `initAuthCreds()` REAL do Baileys e a cifra REAL;
// nenhum auth real, nenhuma rede, nenhum timer real (agenda falsa determinística).
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { initAuthCreds } from "baileys";
import { criarAuthStateAdapter, AuthStateLoadError, BACKOFF_RETRY_PERSISTENCIA_MS } from "../src/authState.js";
import { classificarFalhaBackend, AuthPersistenciaError } from "../src/classificacaoFalhas.js";
import { decriptar, normalizarChave } from "../src/crypto.js";
import { erro, CODIGOS } from "../src/errors.js";

const CHAVE_ENV = randomBytes(32).toString("base64");
const CHAVE = normalizarChave(CHAVE_ENV);

/** Erro exatamente como backendClient.js#chamar o produz para uma resposta HTTP não-ok. */
const http = (status, extra = {}) => Object.assign(erro(CODIGOS.INDISPONIVEL, { status, corpo: {} }), extra);
/** Timeout/rede inalcançável: INDISPONIVEL sem status HTTP. */
const rede = () => erro(CODIGOS.INDISPONIVEL, "timeout ao chamar o backend");

/** `nextPreKeyId` é a "marca" de cada estado nos testes — decodificada do ciphertext REAL. */
const marcaDe = (cifrado) => JSON.parse(decriptar(cifrado, CHAVE)).creds.nextPreKeyId;

/**
 * Backend falso ROTEIRIZADO: a n-ésima chamada segue `respostas[n]` ('ok' | Error | async fn); depois
 * de esgotado o roteiro, responde ok. Grava a marca de cada chamada e o último estado persistido.
 */
function backendRoteirizado(respostas = []) {
  const chamadas = [];
  let salvo = null;
  let i = 0;
  return {
    async salvarAuthState(payload) {
      const marca = marcaDe(payload.authStateEncrypted);
      chamadas.push(marca);
      const r = respostas[i++] ?? "ok";
      const res = typeof r === "function" ? await r(payload) : r;
      if (res instanceof Error) throw res;
      salvo = { ...payload, marca };
      return { authSessionId: "sessao-fake-1" };
    },
    async carregarAuthState() {
      return salvo
        ? { authStateEncrypted: salvo.authStateEncrypted, authSessionId: "sessao-fake-1", authConfirmado: true }
        : { status: "absent" };
    },
    _chamadas: () => chamadas,
    _marcaSalva: () => salvo?.marca ?? null,
    _payloads: () => chamadas.length,
  };
}

/** Backend falso onde CADA chamada fica pendente até ser liberada/rejeitada pelo teste (tempos de resposta arbitrários). */
function backendControlavel() {
  const pend = [];
  const chamadas = [];
  const concluidas = [];
  let salvo = null;
  return {
    async salvarAuthState(payload) {
      const marca = marcaDe(payload.authStateEncrypted);
      const idx = chamadas.length;
      chamadas.push(marca);
      await new Promise((resolve, rejeitar) => { pend[idx] = { resolve, rejeitar }; });
      salvo = { ...payload, marca };
      concluidas.push(marca);
      return { authSessionId: "sessao-fake-1" };
    },
    async carregarAuthState() { return salvo ? { authStateEncrypted: salvo.authStateEncrypted } : {}; },
    liberar(idx) { pend[idx].resolve(); },
    rejeitar(idx, e) { pend[idx].rejeitar(e); },
    async aguardarChamadas(n) { while (chamadas.length < n) await new Promise((r) => setImmediate(r)); },
    _chamadas: () => chamadas,
    _concluidas: () => concluidas,
    _marcaSalva: () => salvo?.marca ?? null,
  };
}

/** Agenda falsa determinística — nenhum tempo real. Cada `agendar` devolve um id; `cancelar` o invalida. */
function agendaFalsa() {
  const itens = [];
  return {
    agendar: (fn, ms) => { itens.push({ fn, ms, cancelado: false, disparado: false }); return itens.length - 1; },
    cancelar: (id) => { if (itens[id]) itens[id].cancelado = true; },
    pendentes: () => itens.filter((t) => !t.cancelado && !t.disparado),
    todos: () => itens,
    /** Dispara o timer `id` (como o setTimeout faria) e espera o retry assentar. */
    async disparar(id) {
      const t = itens[id];
      assert.ok(t && !t.cancelado && !t.disparado, `timer ${id} não está pendente`);
      t.disparado = true;
      t.fn();
      for (let n = 0; n < 6; n++) await new Promise((r) => setImmediate(r));
    },
    async dispararUltimo() { return this.disparar(itens.length - 1); },
  };
}

function montar({ backend, agenda = agendaFalsa(), contexto, aoLeaseStale, backoffRetryMs } = {}) {
  const adapter = criarAuthStateAdapter({
    backendClient: backend, chaveEncriptacaoEnv: CHAVE_ENV,
    agendar: agenda.agendar, cancelar: agenda.cancelar,
    ...(contexto ? { obterContextoLease: contexto } : {}),
    ...(aoLeaseStale ? { aoLeaseStale } : {}),
    ...(backoffRetryMs ? { backoffRetryMs } : {}),
  });
  adapter.inicializarCreds(initAuthCreds());
  return { adapter, agenda };
}

const marcar = (adapter, n) => adapter.aoAtualizarCreds({ nextPreKeyId: n });

describe("classificação de falhas Gateway->Backend (transitória × permanente)", () => {
  const casos = [
    [http(500), "transitoria", "http_5xx"],
    [http(502), "transitoria", "http_5xx"],
    [http(503), "transitoria", "http_5xx"],
    [http(504), "transitoria", "http_5xx"],
    [http(408), "transitoria", "http_408"],
    [http(429), "transitoria", "http_429"],
    [http(404), "transitoria", "http_404"],
    [rede(), "transitoria", "rede_ou_timeout"],
    [new Error("qualquer coisa inesperada"), "transitoria", "desconhecido"],
    [http(401), "permanente", "hmac_recusado"],
    [http(403), "permanente", "hmac_recusado"],
    [http(413), "permanente", "payload_grande_demais"],
    [http(400), "permanente", "http_4xx"],
    [http(422), "permanente", "http_4xx"],
    [http(409, { leaseStale: true }), "permanente", "lease_stale"],
    [http(409, { authSessionStale: true }), "permanente", "auth_session_stale"],
    [new AuthPersistenciaError("permanente", "cripto"), "permanente", "cripto"],
    [new AuthPersistenciaError("transitoria", "http_5xx", { status: 503 }), "transitoria", "http_5xx"],
  ];
  for (const [e, classe, causa] of casos) {
    test(`${e?.name ?? "erro"} (${e?.detalheInterno?.status ?? e?.detalheInterno ?? e?.causa ?? e?.message}) -> ${classe}/${causa}`, () => {
      const c = classificarFalhaBackend(e);
      assert.equal(c.classe, classe);
      assert.equal(c.causa, causa);
    });
  }

  test("usa detalheInterno.status (o do BACKEND), nunca GatewayError.status (sempre 503 = o do próprio Gateway)", () => {
    const e = http(401);
    assert.equal(e.status, 503, "premissa: GatewayError.status é o do Gateway");
    assert.equal(classificarFalhaBackend(e).classe, "permanente", "mesmo assim o 401 do backend é permanente");
  });

  test("a classificação só devolve vocabulário fechado — nunca message/corpo do erro", () => {
    const e = http(500);
    e.detalheInterno.corpo = { segredo: "NAO-PODE-VAZAR" };
    e.message = "NAO-PODE-VAZAR-MESSAGE";
    assert.doesNotMatch(JSON.stringify(classificarFalhaBackend(e)), /NAO-PODE-VAZAR/);
  });

  test("nunca lança, nem com entrada absurda", () => {
    for (const x of [undefined, null, 0, "texto", {}, [], Symbol.for("x")]) {
      assert.doesNotThrow(() => classificarFalhaBackend(x));
    }
  });
});

describe("falha -> recuperação: uma Promise rejeitada NÃO é estado (o incidente)", () => {
  test("A falha (500) e depois B (200): B persiste, a fila não fica envenenada, o estado final é B e A NUNCA sobrescreve B", async () => {
    const backend = backendRoteirizado([http(500), "ok"]);
    const { adapter, agenda } = montar({ backend });

    await assert.rejects(marcar(adapter, 1), (e) => e.detalheInterno?.status === 500, "quem enfileirou A recebe o erro ORIGINAL");
    assert.equal(adapter.estadoPersistencia().sujo, true);
    assert.equal(agenda.pendentes().length, 1, "falha transitória: retry em segundo plano agendado");

    await marcar(adapter, 2); // B, backend voltou
    assert.deepEqual(backend._chamadas(), [1, 2]);
    assert.equal(backend._marcaSalva(), 2, "estado final = B");
    const est = adapter.estadoPersistencia();
    assert.equal(est.sujo, false);
    assert.equal(est.ultimaFalha, null);
    assert.equal(agenda.pendentes().length, 0, "B limpou o estado: o retry pendente foi cancelado");

    // Mesmo que o timer de A "disparasse" agora, não há mais nada a gravar — A jamais sobrescreve B.
    assert.ok(agenda.todos()[0].cancelado);
    await adapter.aguardarPersistenciasPendentes();
    assert.deepEqual(backend._chamadas(), [1, 2], "nenhuma gravação extra");
    assert.equal(backend._marcaSalva(), 2);
  });

  test("REPRODUZ O INCIDENTE: depois de uma falha, o drain resolve e o reconnect (garantirPersistido) recupera — antes rejeitava PARA SEMPRE", async () => {
    const backend = backendRoteirizado([http(413), "ok"]);
    const { adapter } = montar({ backend });

    await assert.rejects(marcar(adapter, 7));
    for (let i = 0; i < 3; i++) await adapter.aguardarPersistenciasPendentes(); // antes: rejeitava toda vez, indefinidamente

    // backend corrigido (hotfix do limite): o flush do reconnect regrava o snapshot mais novo.
    const r = await adapter.garantirPersistido();
    assert.deepEqual(r, { status: "persistido" });
    assert.equal(backend._marcaSalva(), 7);
    assert.equal(adapter.estadoPersistencia().sujo, false);
    assert.deepEqual(await adapter.garantirPersistido(), { status: "limpo" }, "nada mais a fazer");
  });

  test("garantirPersistido(): sem nada sujo não chama o backend", async () => {
    const backend = backendRoteirizado();
    const { adapter } = montar({ backend });
    assert.deepEqual(await adapter.garantirPersistido(), { status: "limpo" });
    assert.equal(backend._chamadas().length, 0);
  });
});

describe("ordem e latest-wins com respostas fora de ordem", () => {
  test("A,B,C,D com tempos de resposta diferentes: gravações chegam em ordem, a última persistida é D, nenhuma versão antiga termina por último", async () => {
    const backend = backendControlavel();
    const { adapter } = montar({ backend });

    const ps = [marcar(adapter, 1), marcar(adapter, 2), marcar(adapter, 3), marcar(adapter, 4)];
    // Só A chegou ao backend — B/C/D esperam a vez (serialização).
    await backend.aguardarChamadas(1);
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(backend._chamadas(), [1], "B/C/D não podem ser chamados enquanto A está em voo");

    // Resolve fora da ordem "natural": D não pode passar na frente.
    backend.liberar(0); await ps[0];
    await backend.aguardarChamadas(2); backend.liberar(1); await ps[1];
    await backend.aguardarChamadas(3); backend.liberar(2); await ps[2];
    await backend.aguardarChamadas(4); backend.liberar(3); await ps[3];

    assert.deepEqual(backend._chamadas(), [1, 2, 3, 4], "ordem de CHEGADA = ordem de produção");
    assert.deepEqual(backend._concluidas(), [1, 2, 3, 4], "ordem de CONCLUSÃO = ordem de produção (nada antigo termina depois de um novo)");
    assert.equal(backend._marcaSalva(), 4, "o estado final persistido é D");
    assert.equal(adapter.estadoPersistencia().geracaoPersistida, 4);
    assert.equal(adapter.estadoPersistencia().sujo, false);
  });

  test("A em voo, B falha... : a geração persistida SÓ sobe — concluir A não declara tudo persistido se B (mais nova) ainda está pendente", async () => {
    const backend = backendControlavel();
    const { adapter } = montar({ backend, agenda: agendaFalsa() });

    const pA = marcar(adapter, 10);
    await backend.aguardarChamadas(1);
    const pB = marcar(adapter, 11); // nasce enquanto A está em andamento
    backend.liberar(0); await pA;
    assert.equal(adapter.estadoPersistencia().geracaoPersistida, 1);
    assert.equal(adapter.estadoPersistencia().sujo, true, "B (gen 2) ainda não foi persistida: NÃO pode contar como limpo");

    await backend.aguardarChamadas(2);
    backend.rejeitar(1, http(500));
    await assert.rejects(pB);
    assert.equal(adapter.estadoPersistencia().sujo, true);
    assert.equal(backend._marcaSalva(), 10);
  });

  test("retry de A NUNCA sobrescreve B: com A falha + B já persistido, disparar o timer de A não faz nenhuma chamada", async () => {
    const backend = backendRoteirizado([http(503), "ok"]);
    const { adapter, agenda } = montar({ backend });
    await assert.rejects(marcar(adapter, 1));
    const timerDeA = 0;
    assert.equal(agenda.todos()[timerDeA].ms, 1000);

    await marcar(adapter, 2); // B persiste (backend voltou) — cancela o retry de A
    assert.equal(agenda.todos()[timerDeA].cancelado, true);
    assert.deepEqual(backend._chamadas(), [1, 2]);

    // Mesmo um callback "atrasado" (que escapasse do cancelamento) encontra o estado limpo e não grava nada.
    agenda.todos()[timerDeA].fn();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(backend._chamadas(), [1, 2], "nenhuma gravação do snapshot antigo");
    assert.equal(backend._marcaSalva(), 2);
  });

  test("retry enfileirado ATRÁS de uma gravação em voo da mesma geração NÃO a regrava (guarda anti-duplicata/stale): backend recebe [1,2], nunca [1,2,2]", async () => {
    const backend = backendControlavel();
    const agenda = agendaFalsa();
    const { adapter } = montar({ backend, agenda });

    const pA = marcar(adapter, 1);
    await backend.aguardarChamadas(1);
    backend.rejeitar(0, http(500));
    await assert.rejects(pA); // geração 1 falha; retry armado

    const pB = marcar(adapter, 2); // geração 2 fica EM VOO (pendente)
    await backend.aguardarChamadas(2);
    await agenda.disparar(0); // o retry dispara agora: enfileira a geração 2 ATRÁS da que já está em voo

    backend.liberar(1);
    await pB; // a geração 2 é persistida
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    assert.deepEqual(backend._chamadas(), [1, 2], "o retry da geração 2 encontrou-a já persistida e foi DISPENSADO — nenhuma gravação redundante");
    assert.equal(adapter.estadoPersistencia().geracaoPersistida, 2);
  });

  test("o retry sempre regrava o snapshot MAIS NOVO (latest wins), nunca o que falhou", async () => {
    const backend = backendRoteirizado([http(500), http(500), "ok"]);
    const { adapter, agenda } = montar({ backend });

    await assert.rejects(marcar(adapter, 1)); // A falha
    await assert.rejects(marcar(adapter, 2)); // B (mais novo) também falha
    assert.equal(agenda.pendentes().length, 1, "um único timer, mesmo com duas falhas");

    await agenda.disparar(agenda.pendentes().length ? agenda.todos().findIndex((t) => !t.cancelado && !t.disparado) : 0);
    assert.equal(backend._marcaSalva(), 2, "o retry gravou o estado de B (o mais novo), não o de A");
    assert.deepEqual(backend._chamadas(), [1, 2, 2]);
    assert.equal(adapter.estadoPersistencia().sujo, false);
  });
});

describe("retry LIMITADO com backoff (fake timers)", () => {
  test("500, 500, 200: retries com backoff 1s e 2s, sucesso no terceiro, sem duplicar nem gravar estado velho", async () => {
    const backend = backendRoteirizado([http(500), http(500), "ok"]);
    const { adapter, agenda } = montar({ backend });

    await assert.rejects(marcar(adapter, 5)); // tentativa original (falha 1)
    assert.deepEqual(agenda.pendentes().map((t) => t.ms), [1000], "1º retry após 1s");

    await agenda.dispararUltimo(); // retry 1 -> falha 2
    assert.equal(adapter.estadoPersistencia().sujo, true);
    assert.deepEqual(agenda.pendentes().map((t) => t.ms), [2000], "2º retry após 2s");

    await agenda.dispararUltimo(); // retry 2 -> sucesso
    assert.deepEqual(backend._chamadas(), [5, 5, 5], "exatamente 3 chamadas do MESMO snapshot (sem duplicata extra)");
    assert.equal(backend._marcaSalva(), 5);
    const est = adapter.estadoPersistencia();
    assert.equal(est.sujo, false);
    assert.equal(est.retryTentativas, 0, "o orçamento de retry volta ao zero depois do sucesso");
    assert.equal(agenda.pendentes().length, 0);
  });

  test("o backoff usa a lista configurada (padrão 1s,2s,5s,10s,30s) e o TAMANHO dela é o teto de retries", async () => {
    assert.deepEqual([...BACKOFF_RETRY_PERSISTENCIA_MS], [1000, 2000, 5000, 10000, 30000]);
    const backend = backendRoteirizado(Array(20).fill(http(503)));
    const { adapter, agenda } = montar({ backend });

    await assert.rejects(marcar(adapter, 1));
    const esperas = [agenda.pendentes()[0].ms];
    for (let i = 0; i < 5; i++) {
      await agenda.dispararUltimo();
      const p = agenda.pendentes();
      if (p.length) esperas.push(p[0].ms);
    }
    assert.deepEqual(esperas, [1000, 2000, 5000, 10000, 30000], "backoff crescente e com teto");
  });

  test("NUNCA loop infinito: depois de N retries falhando, para (retryEsgotado), o estado segue sujo e nenhum timer novo é armado", async () => {
    const backend = backendRoteirizado(Array(50).fill(http(500)));
    const { adapter, agenda } = montar({ backend, backoffRetryMs: [10, 20, 30] });

    await assert.rejects(marcar(adapter, 9)); // tentativa original
    for (let i = 0; i < 10 && agenda.pendentes().length; i++) await agenda.dispararUltimo();

    assert.equal(backend._chamadas().length, 1 + 3, "1 original + exatamente 3 retries (o tamanho do backoff)");
    const est = adapter.estadoPersistencia();
    assert.equal(est.retryEsgotado, true);
    assert.equal(est.sujo, true, "esgotar o retry NÃO finge que persistiu");
    assert.equal(agenda.pendentes().length, 0, "nenhum timer novo depois de esgotado");
    const antes = backend._chamadas().length;
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(backend._chamadas().length, antes, "e nada mais é tentado sozinho");
  });

  test("depois de esgotado, o flush do reconnect (garantirPersistido) ainda tenta UMA vez — e resolve se o backend voltou", async () => {
    const backend = backendRoteirizado([http(500), http(500), http(500), "ok"]);
    const { adapter, agenda } = montar({ backend, backoffRetryMs: [10, 20] });
    await assert.rejects(marcar(adapter, 4));
    for (let i = 0; i < 6 && agenda.pendentes().length; i++) await agenda.dispararUltimo();
    assert.equal(adapter.estadoPersistencia().retryEsgotado, true);

    assert.deepEqual(await adapter.garantirPersistido(), { status: "persistido" });
    assert.equal(backend._marcaSalva(), 4);
    assert.equal(adapter.estadoPersistencia().retryEsgotado, false);
  });

  test("um único timer por vez, mesmo com muitas falhas em rajada (nada de tempestade de retries)", async () => {
    const backend = backendRoteirizado(Array(10).fill(http(500)));
    const { adapter, agenda } = montar({ backend });
    for (let i = 1; i <= 6; i++) await assert.rejects(marcar(adapter, i));
    assert.equal(agenda.pendentes().length, 1);
    assert.equal(agenda.todos().length, 1, "6 falhas, 1 timer armado");
  });
});

describe("erros PERMANENTES: sem retry, sem loop, logados", () => {
  const permanentes = [
    ["HMAC recusado (401)", () => http(401), "hmac_recusado"],
    ["HMAC recusado (403)", () => http(403), "hmac_recusado"],
    ["payload acima do teto (413)", () => http(413), "payload_grande_demais"],
    ["contrato inválido (400)", () => http(400), "http_4xx"],
    ["auth session obsoleta", () => http(409, { authSessionStale: true }), "auth_session_stale"],
  ];
  for (const [nome, fazerErro, causa] of permanentes) {
    test(`${nome}: nenhum retry agendado, uma única chamada, classificado como permanente/${causa}`, async (t) => {
      const linhas = [];
      t.mock.method(console, "error", (s) => linhas.push(s));
      t.mock.method(console, "log", (s) => linhas.push(s));
      const backend = backendRoteirizado([fazerErro()]);
      const { adapter, agenda } = montar({ backend });

      await assert.rejects(marcar(adapter, 1));
      assert.equal(agenda.todos().length, 0, "NENHUM timer de retry");
      assert.equal(backend._chamadas().length, 1);
      const est = adapter.estadoPersistencia();
      assert.equal(est.ultimaFalha.classe, "permanente");
      assert.equal(est.ultimaFalha.causa, causa);
      assert.equal(est.sujo, true, "a memória continua mais nova que o backend (nada foi descartado)");
      const log = linhas.map((s) => JSON.parse(s)).find((l) => l.evento === "auth_state.persistencia_falhou");
      assert.ok(log, "falha observável — nunca engolida");
      assert.equal(log.classe, "permanente");
      assert.equal(log.causa, causa);
    });
  }

  test("413 ESTRUTURAL (acima do teto do backend): 1 tentativa, ZERO retries em segundo plano, e cada flush explícito é UMA tentativa — nunca loop", async () => {
    const backend = backendRoteirizado(Array(50).fill(http(413)));
    const { adapter, agenda } = montar({ backend });

    await assert.rejects(marcar(adapter, 1));
    for (let i = 0; i < 3; i++) {
      await assert.rejects(adapter.garantirPersistido(), (e) => e instanceof AuthPersistenciaError && e.classe === "permanente" && e.causa === "payload_grande_demais" && e.status === 413);
    }
    assert.equal(agenda.todos().length, 0, "nunca agenda retry para 413");
    assert.equal(backend._chamadas().length, 1 + 3, "1 original + 1 por flush explícito, sem nada sozinho");
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(backend._chamadas().length, 4);
  });

  test("permanente NÃO é para sempre: se o backend for corrigido, o próximo flush explícito grava (era exatamente o caso do 413 antes do hotfix)", async () => {
    const backend = backendRoteirizado([http(413), "ok"]);
    const { adapter } = montar({ backend });
    await assert.rejects(marcar(adapter, 3));
    assert.deepEqual(await adapter.garantirPersistido(), { status: "persistido" });
    assert.equal(backend._marcaSalva(), 3);
  });

  test("garantirPersistido() rejeita com AuthPersistenciaError SANITIZADO — nunca a mensagem/corpo do erro original", async () => {
    const e = http(413);
    e.message = "SEGREDO-NA-MENSAGEM";
    e.detalheInterno.corpo = { authStateEncrypted: "v1:AAAA:BBBB:CCCC" };
    const { adapter } = montar({ backend: backendRoteirizado([e, e]) });
    await assert.rejects(marcar(adapter, 1));
    try {
      await adapter.garantirPersistido();
      assert.fail("deveria rejeitar");
    } catch (err) {
      assert.ok(err instanceof AuthPersistenciaError);
      assert.doesNotMatch(String(err.message) + JSON.stringify({ ...err }), /SEGREDO-NA-MENSAGEM|v1:AAAA/);
    }
  });

  test("nenhum plaintext/ciphertext do auth aparece nos logs de falha/retry", async (t) => {
    const linhas = [];
    t.mock.method(console, "error", (s) => linhas.push(s));
    t.mock.method(console, "warn", (s) => linhas.push(s));
    t.mock.method(console, "log", (s) => linhas.push(s));
    const { adapter, agenda } = montar({ backend: backendRoteirizado([http(500), http(500), "ok"]) });
    await assert.rejects(adapter.aoAtualizarCreds({ noiseKey: { private: Buffer.from("SEGREDO-PRIVADO-XYZ"), public: Buffer.from("pub") }, nextPreKeyId: 1 }));
    await agenda.dispararUltimo();
    await agenda.dispararUltimo();
    const tudo = linhas.join("\n");
    assert.doesNotMatch(tudo, /SEGREDO-PRIVADO-XYZ/);
    // No plaintext serializado o Buffer vira {__buffer: base64} — o literal acima nunca aparece nele; por isso
    // também se procura a forma base64 e o marcador do serializador (senão um vazamento do plaintext passaria).
    assert.ok(!tudo.includes(Buffer.from("SEGREDO-PRIVADO-XYZ").toString("base64")), "nunca o auth serializado (base64)");
    assert.ok(!tudo.includes("__buffer"), "nunca o auth serializado (marcador de Buffer)");
    assert.doesNotMatch(tudo, /v1:[A-Za-z0-9+/=]+:/, "nunca o formato do ciphertext");
    assert.ok(linhas.some((s) => JSON.parse(s).evento === "auth_state.retry_agendado"));
  });
});

describe("fencing e lease", () => {
  test("lease 409 (leaseStale) ao gravar: aoLeaseStale acionado, snapshot DESCARTADO (não fica sujo), sem retry", async () => {
    const aoLeaseStale = mock.fn();
    const backend = backendRoteirizado([http(409, { leaseStale: true })]);
    const { adapter, agenda } = montar({ backend, aoLeaseStale, contexto: () => ({ gatewayProcessId: "p", leaseEpoch: 3 }) });

    await assert.rejects(marcar(adapter, 1));
    assert.equal(aoLeaseStale.mock.calls.length, 1);
    assert.equal(aoLeaseStale.mock.calls[0].arguments[0], "auth_state_stale");
    assert.equal(agenda.todos().length, 0, "sem retry: o backend já disse que não somos mais o dono");
    const est = adapter.estadoPersistencia();
    assert.equal(est.sujo, false, "descartado: o backend é a fonte da verdade daqui em diante");
    assert.equal(est.ultimaFalha.causa, "lease_stale");
  });

  test("epoch de lease mudou depois do snapshot: garantirPersistido() DESCARTA (não grava sob epoch alheio) e não chama o backend", async () => {
    let contexto = { gatewayProcessId: "p", leaseEpoch: 5 };
    const backend = backendRoteirizado([http(500)]);
    const { adapter } = montar({ backend, contexto: () => contexto });
    await assert.rejects(marcar(adapter, 1)); // snapshot produzido sob o epoch 5, falhou
    assert.equal(backend._chamadas().length, 1);

    contexto = { gatewayProcessId: "p", leaseEpoch: 6 }; // perdeu e reaver a lease: epoch novo
    assert.deepEqual(await adapter.garantirPersistido(), { status: "descartado" });
    assert.equal(backend._chamadas().length, 1, "NUNCA regrava um snapshot velho sob um epoch novo");
    assert.equal(adapter.estadoPersistencia().sujo, false);
  });

  test("o retry em segundo plano também descarta (não grava) se a lease mudou enquanto esperava", async () => {
    let contexto = { gatewayProcessId: "p", leaseEpoch: 5 };
    const backend = backendRoteirizado([http(500)]);
    const { adapter, agenda } = montar({ backend, contexto: () => contexto });
    await assert.rejects(marcar(adapter, 1));
    contexto = null; // perdeu a lease
    await agenda.dispararUltimo();
    assert.equal(backend._chamadas().length, 1, "sem lease, o retry não escreve nada");
    assert.equal(adapter.estadoPersistencia().sujo, false, "snapshot descartado");
    assert.equal(adapter.estadoPersistencia().memoriaObsoleta, true, "e a memória inteira foi invalidada (não só o pendente)");
    contexto = { gatewayProcessId: "p", leaseEpoch: 6 }; // nova lease do mesmo processo
    await assert.rejects(marcar(adapter, 2), (e) => e.causa === "memoria_obsoleta");
    assert.equal(backend._chamadas().length, 1, "nada da memória antiga sai sob o epoch novo");
  });

  test("sem lease no momento do evento: recusa local (permanente), nunca chama o backend e não deixa o estado 'sujo' para sempre", async () => {
    const backend = backendRoteirizado();
    const { adapter, agenda } = montar({ backend, contexto: () => null });
    await assert.rejects(marcar(adapter, 1), (e) => e instanceof AuthPersistenciaError && e.causa === "sem_lease_local");
    assert.equal(backend._chamadas().length, 0);
    assert.equal(agenda.todos().length, 0);
    assert.equal(adapter.estadoPersistencia().sujo, false);
  });

  test("toda gravação (inclusive o retry) usa o contexto de lease capturado NO SNAPSHOT", async () => {
    const payloads = [];
    let n = 0;
    const backend = {
      async salvarAuthState(p) { payloads.push(p); if (++n === 1) throw http(500); return {}; },
      async carregarAuthState() { return {}; },
    };
    const agenda = agendaFalsa();
    const adapter = criarAuthStateAdapter({
      backendClient: backend, chaveEncriptacaoEnv: CHAVE_ENV, agendar: agenda.agendar, cancelar: agenda.cancelar,
      obterContextoLease: () => ({ gatewayProcessId: "proc-x", leaseEpoch: 7 }),
    });
    adapter.inicializarCreds(initAuthCreds());
    await assert.rejects(adapter.aoAtualizarCreds({ nextPreKeyId: 1 }));
    await agenda.dispararUltimo();
    assert.equal(payloads.length, 2);
    for (const p of payloads) { assert.equal(p.gatewayProcessId, "proc-x"); assert.equal(p.leaseEpoch, 7); }
  });
});

describe("carregar() nunca sobrescreve memória mais nova que o backend", () => {
  test("estado sujo -> carregar() recusa com AuthStateLoadError('pendente_nao_persistido') e a memória continua intacta", async () => {
    const backend = backendRoteirizado([http(500)]);
    const { adapter } = montar({ backend });
    await assert.rejects(marcar(adapter, 42));
    await assert.rejects(adapter.carregar(), (e) => e instanceof AuthStateLoadError && e.categoria === "pendente_nao_persistido");
    assert.equal(adapter._snapshot().creds.nextPreKeyId, 42, "a memória mais nova NÃO foi sobrescrita");
  });

  test("depois do flush, carregar() volta a funcionar", async () => {
    const backend = backendRoteirizado([http(500)]);
    const { adapter } = montar({ backend });
    await assert.rejects(marcar(adapter, 42));
    await adapter.garantirPersistido();
    const r = await adapter.carregar();
    assert.equal(r.status, "loaded");
  });

  test("estado LIMPO: carregar() funciona normalmente (sem regressão do fluxo de boot)", async () => {
    const backend = backendRoteirizado();
    const { adapter } = montar({ backend });
    assert.deepEqual(await adapter.carregar(), { status: "absent" });
  });
});

describe("INVARIANTE: lease perdida -> memória (suja OU limpa) fica OBSOLETA e nunca é reutilizada/persistida", () => {
  test("lease perdida com estado sujo: pendente descartado, retries cancelados, e NENHUMA gravação nova sai da memória antiga — nem com um epoch novo", async () => {
    let contexto = { gatewayProcessId: "p", leaseEpoch: 1 };
    const backend = backendRoteirizado([http(500)]);
    const { adapter, agenda } = montar({ backend, contexto: () => contexto });
    await assert.rejects(marcar(adapter, 99)); // sujo, retry armado
    assert.equal(adapter.estadoPersistencia().sujo, true);
    assert.equal(agenda.pendentes().length, 1);

    adapter.marcarMemoriaObsoleta("lease_perdida");
    const est = adapter.estadoPersistencia();
    assert.equal(est.sujo, false, "pendente descartado");
    assert.equal(est.memoriaObsoleta, true);
    assert.equal(agenda.pendentes().length, 0, "retries cancelados");

    // o MESMO processo adquire uma NOVA lease (epoch 2) e um evento tardio do socket velho chega:
    contexto = { gatewayProcessId: "p", leaseEpoch: 2 };
    const antes = backend._chamadas().length;
    await assert.rejects(marcar(adapter, 100), (e) => e instanceof AuthPersistenciaError && e.classe === "permanente" && e.causa === "memoria_obsoleta");
    assert.equal(backend._chamadas().length, antes, "nada da memória descartada é gravado sob o epoch novo");
    assert.equal(adapter.estadoPersistencia().sujo, false, "a recusa não deixa o estado 'sujo'");
  });

  test("mesmo com a memória LIMPA (nada pendente): perder a lease a invalida — outro dono pode ter escrito, então ela não é mais a fonte da verdade", async () => {
    const backend = backendRoteirizado();
    const { adapter } = montar({ backend, contexto: () => ({ gatewayProcessId: "p", leaseEpoch: 1 }) });
    await marcar(adapter, 5); // persistido, limpo
    assert.equal(adapter.estadoPersistencia().sujo, false);
    adapter.marcarMemoriaObsoleta("lease_perdida");
    await assert.rejects(marcar(adapter, 6), (e) => e.causa === "memoria_obsoleta");
    assert.deepEqual(backend._chamadas(), [5], "a gravação de 6 nunca saiu");
  });

  test("só o estado AUTORIZADO pelo backend volta a valer: carregar() traz o do backend (não a memória descartada), limpa a obsolescência e as gravações voltam ao normal", async () => {
    let contexto = { gatewayProcessId: "p", leaseEpoch: 1 };
    const backend = backendRoteirizado([ "ok", http(500) ]);
    const { adapter } = montar({ backend, contexto: () => contexto });
    await marcar(adapter, 10); // backend: 10
    await assert.rejects(marcar(adapter, 99)); // memória: 99 (suja, não persistida)
    adapter.marcarMemoriaObsoleta("lease_perdida");
    contexto = { gatewayProcessId: "p", leaseEpoch: 2 }; // nova lease

    const r = await adapter.carregar();
    assert.equal(r.status, "loaded");
    assert.equal(adapter._snapshot().creds.nextPreKeyId, 10, "a memória descartada (99) NUNCA é reaproveitada — vale o estado do backend");
    assert.equal(adapter.estadoPersistencia().memoriaObsoleta, false);

    await marcar(adapter, 11); // agora persiste normalmente, sob o epoch novo
    assert.equal(backend._marcaSalva(), 11);
  });

  test("garantirPersistido() com epoch mudado marca a memória obsoleta (não só descarta o pendente)", async () => {
    let contexto = { gatewayProcessId: "p", leaseEpoch: 5 };
    const backend = backendRoteirizado([http(500)]);
    const { adapter } = montar({ backend, contexto: () => contexto });
    await assert.rejects(marcar(adapter, 1));
    contexto = { gatewayProcessId: "p", leaseEpoch: 6 };
    assert.deepEqual(await adapter.garantirPersistido(), { status: "descartado" });
    assert.equal(adapter.estadoPersistencia().memoriaObsoleta, true);
    await assert.rejects(marcar(adapter, 2), (e) => e.causa === "memoria_obsoleta");
  });

  test("409 de lease ao gravar também torna a memória obsoleta", async () => {
    const backend = backendRoteirizado([http(409, { leaseStale: true })]);
    const { adapter } = montar({ backend, contexto: () => ({ gatewayProcessId: "p", leaseEpoch: 3 }) });
    await assert.rejects(marcar(adapter, 1));
    assert.equal(adapter.estadoPersistencia().memoriaObsoleta, true);
    await assert.rejects(marcar(adapter, 2), (e) => e.causa === "memoria_obsoleta");
    assert.equal(backend._chamadas().length, 1);
  });

  test("um novo pareamento (inicializarCreds) e um reset (invalidarLocal) limpam a obsolescência", async () => {
    const backend = backendRoteirizado();
    const { adapter } = montar({ backend });
    adapter.marcarMemoriaObsoleta("lease_perdida");
    adapter.inicializarCreds(initAuthCreds());
    assert.equal(adapter.estadoPersistencia().memoriaObsoleta, false);
    await marcar(adapter, 1);

    adapter.marcarMemoriaObsoleta("lease_perdida");
    adapter.invalidarLocal();
    assert.equal(adapter.estadoPersistencia().memoriaObsoleta, false);
  });

  test("mutação de memória SEM lease (evento tardio depois de perder a lease) torna-a obsoleta e não grava", async () => {
    let contexto = null;
    const backend = backendRoteirizado();
    const { adapter } = montar({ backend, contexto: () => contexto });
    await assert.rejects(marcar(adapter, 1), (e) => e.causa === "sem_lease_local");
    contexto = { gatewayProcessId: "p", leaseEpoch: 9 }; // lease adquirida depois
    await assert.rejects(marcar(adapter, 2), (e) => e.causa === "memoria_obsoleta", "a memória mutada sem lease não vira snapshot só porque agora há lease");
    assert.equal(backend._chamadas().length, 0);
  });
});

describe("cancelamento e reset", () => {
  test("cancelarRetries(): o timer pendente é cancelado e um callback tardio não grava nada", async () => {
    const backend = backendRoteirizado([http(500)]);
    const { adapter, agenda } = montar({ backend });
    await assert.rejects(marcar(adapter, 1));
    assert.equal(agenda.pendentes().length, 1);
    adapter.cancelarRetries();
    assert.equal(agenda.pendentes().length, 0);
    agenda.todos()[0].fn(); // callback tardio (o timer já cancelado)
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(backend._chamadas().length, 1);
  });

  test("invalidarLocal() (reset): descarta o pendente, cancela o retry e zera o estado", async () => {
    const backend = backendRoteirizado([http(500)]);
    const { adapter, agenda } = montar({ backend });
    await assert.rejects(marcar(adapter, 1));
    adapter.invalidarLocal();
    const est = adapter.estadoPersistencia();
    assert.equal(est.sujo, false);
    assert.equal(est.ultimaFalha, null);
    assert.equal(agenda.pendentes().length, 0);
    assert.deepEqual(await adapter.garantirPersistido(), { status: "limpo" });
  });

  test("um retry pendente nunca segura o processo vivo (unref)", async () => {
    let unrefChamado = false;
    const adapter = criarAuthStateAdapter({
      backendClient: backendRoteirizado([http(500)]), chaveEncriptacaoEnv: CHAVE_ENV,
      agendar: () => ({ unref() { unrefChamado = true; } }), cancelar: () => {},
    });
    adapter.inicializarCreds(initAuthCreds());
    await assert.rejects(adapter.aoAtualizarCreds({ nextPreKeyId: 1 }));
    assert.equal(unrefChamado, true);
  });
});
