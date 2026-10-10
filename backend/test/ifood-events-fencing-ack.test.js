// Fencing do ACK de Events: nenhum ACK desta instância sai depois que o lease poderia ter vencido.
//
// Por que existe: um ACK com retries (3 x 20 s + Retry-After de até 30 s) pode durar mais que o TTL do lease
// (90 s). Sem prazo, durante um deploy (duas instâncias) a nova poderia assumir o lease enquanto a antiga ainda
// reenvia o ACK. Agora cada lote de ACK sai com um AbortSignal que vence em (antes da renovação + TTL - margem),
// e o cliente HTTP não manda tentativa nova com o sinal já abortado.
//
// Sem rede e sem banco: fetch falso, repositório em memória com o relógio do "banco".
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";

const clienteReal = await import("../src/modules/ifood/ifoodEvents.client.js");
const { postJson } = await import("../src/modules/ifood/ifoodHttp.client.js");
const { criarPoller } = await import("../src/modules/ifood/ifoodEvents.poller.js");
const { IFOOD_EVENTS, IFOOD_HTTP } = await import("../src/modules/ifood/ifood.constants.js");
const { IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");
const { criarRepoEmMemoria, criarRelogio, criarClienteFake, criarTokenFake, ev, pilotoDe } = await import("./helpers/ifood-events-fakes.js");

const silencio = () => {};
const resposta = (status) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => "" });

// ---------------------------------------------------------------------------
// Cliente HTTP: sinal abortado nunca gera tentativa nova
// ---------------------------------------------------------------------------
test("HTTP: sinal JÁ abortado -> nenhuma requisição sai (IFOOD_CANCELADO)", async () => {
  let chamadas = 0;
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    postJson("/events/v1.0/events/acknowledgment", [{ id: "e1" }], { accessToken: "tok", sinal: ctrl.signal, fetchImpl: async () => { chamadas += 1; return resposta(202); } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_CANCELADO,
  );
  assert.equal(chamadas, 0);
});

test("HTTP: sinal abortado DURANTE a espera do retry -> a 2ª tentativa não é enviada", async () => {
  let chamadas = 0;
  const ctrl = new AbortController();
  const p = postJson("/events/v1.0/events/acknowledgment", [{ id: "e1" }], {
    accessToken: "tok", sinal: ctrl.signal,
    fetchImpl: async () => { chamadas += 1; setTimeout(() => ctrl.abort(), 10); return resposta(503); },   // 503 = transitório: haveria retry
  });
  await assert.rejects(p, (e) => e.codigo === IFOOD_ERROS.IFOOD_CANCELADO);
  assert.equal(chamadas, 1, `retry enviado depois do abort (backoff de ${IFOOD_HTTP.backoffBaseMs} ms)`);
});

test("HTTP: abort DURANTE uma tentativa em voo -> ela é cancelada e não há retry", async () => {
  let chamadas = 0;
  const ctrl = new AbortController();
  const p = postJson("/events/v1.0/events/acknowledgment", [{ id: "e1" }], {
    accessToken: "tok", sinal: ctrl.signal,
    fetchImpl: (_url, opts) => new Promise((_, rej) => {
      chamadas += 1;
      opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      setTimeout(() => ctrl.abort(), 10);   // o prazo vence com a requisição ainda sem resposta
    }),
  });
  await assert.rejects(p, (e) => e.codigo === IFOOD_ERROS.IFOOD_CANCELADO);
  assert.equal(chamadas, 1, "cancelado pelo chamador não é 'timeout': não pode virar retry");
});

// ---------------------------------------------------------------------------
// Poller: prazo do ACK derivado da renovação do lease
// ---------------------------------------------------------------------------
function montar({ relogio = criarRelogio(), repo, respostas, holder = "inst-A", leaseTtlS = 90 } = {}) {
  repo ??= criarRepoEmMemoria({ relogio });
  const client = criarClienteFake(clienteReal, { respostasPolling: respostas });
  const token = criarTokenFake({ escopo: "app" });
  const poller = criarPoller({ repo, token, client, holder, agora: relogio.agora, log: silencio, leaseTtlS, unidadesPiloto: pilotoDe(repo) });
  return { repo, client, poller, relogio };
}

test("cada ACK sai com um AbortSignal cujo prazo = renovação + TTL - margem", async () => {
  const relogio = criarRelogio();
  const { client, poller } = montar({ relogio, respostas: [[ev("e1", "PLC")]] });
  const vistos = [];
  const original = client.confirmarEventos;
  client.confirmarEventos = async (a) => { vistos.push({ sinal: a.sinal, abortado: a.sinal?.aborted }); return original(a); };
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.equal(vistos.length, 1);
  assert.ok(vistos[0].sinal instanceof AbortSignal, "o ACK precisa receber o sinal do prazo");
  assert.equal(vistos[0].abortado, false);
  assert.ok(90_000 - IFOOD_EVENTS.margemFencingAckMs > 0);
});

test("RPC de renovação lenta: sem prazo restante, o ACK NÃO sai (LEASE_PERDIDO) e o evento volta", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio });
  const { client, poller } = montar({ relogio, repo, respostas: [[ev("e1", "PLC")]] });
  const adquirirOriginal = repo.adquirirLease.bind(repo);
  let renovacoes = 0;
  repo.adquirirLease = async (p) => {
    const r = await adquirirOriginal(p);
    // 2ª chamada = a renovação antes do ACK: a resposta "chega" 80 s depois (> TTL 90 - margem 15).
    if ((renovacoes += 1) === 2) relogio.avancarS(80);
    return r;
  };
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "LEASE_PERDIDO");
  assert.equal(client.acks.length, 0, "nenhum ACK pode sair sem prazo de lease");
  assert.equal(repo.eventos.get("e1").acknowledged_at, null, "sem ACK o evento volta no próximo polling");
});

test("vários lotes: o lease é renovado a cada lote; se outra instância assumiu, os lotes seguintes NÃO saem", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio });
  const n = IFOOD_EVENTS.maxIdsPorAck + 5;   // 2 lotes
  const eventos = Array.from({ length: n }, (_, i) => ev(`e${i}`, "PLC", { orderId: `o${i}` }));
  const { client, poller } = montar({ relogio, repo, respostas: [eventos] });
  const original = client.confirmarEventos;
  client.confirmarEventos = async (a) => {
    const r = await original(a);
    // Depois do 1º lote: a instância "trava" 100 s (> TTL) e a B assume o lease vencido.
    relogio.avancarS(100);
    const b = await repo.adquirirLease({ nome: IFOOD_EVENTS.leaseNome, holder: "inst-B", ttlS: 90 });
    assert.equal(b.adquirido, true);
    return r;
  };
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "LEASE_PERDIDO");
  assert.equal(client.acks.length, 1, "só o 1º lote (com lease válido) foi reconhecido");
  assert.equal(client.acks[0].eventIds.length, IFOOD_EVENTS.maxIdsPorAck);
  assert.equal(repo.lease.holder, "inst-B");
});

test("vários lotes, ainda titular mas o prazo do 1º lote passou: a renovação por lote deixa o 2º lote sair", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio });
  const n = IFOOD_EVENTS.maxIdsPorAck + 5;   // 2 lotes
  const eventos = Array.from({ length: n }, (_, i) => ev(`e${i}`, "PLC", { orderId: `o${i}` }));
  const { client, poller } = montar({ relogio, repo, respostas: [eventos] });
  const original = client.confirmarEventos;
  client.confirmarEventos = async (a) => {
    const r = await original(a);
    relogio.avancarS(80);   // > TTL 90 - margem 15: o prazo do 1º lote acabou, mas o lease (90 s) ainda é desta instância
    return r;
  };
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.equal(client.acks.length, 2, "o 2º lote sai com um prazo novo, renovado");
  assert.equal(repo.lease.holder, "inst-A");
});

test("ponta a ponta (cliente de Events + cliente HTTP REAIS): o retry do ACK não sai depois do prazo do lease", async () => {
  const { getJson, postJson: postReal } = await import("../src/modules/ifood/ifoodHttp.client.js");
  const relogio = { agoraMs: () => Date.now(), agora: () => new Date(), avancarS: () => {} };
  const repo = criarRepoEmMemoria({ relogio });
  const chamadas = { polling: 0, ack: 0 };
  // fetch falso: polling devolve 1 evento; ACK responde 503 (transitório -> haveria retry após 700 ms de backoff).
  const fetchImpl = async (url) => {
    const ehAck = String(url).includes("acknowledgment");
    chamadas[ehAck ? "ack" : "polling"] += 1;
    if (ehAck) return { ok: false, status: 503, headers: { get: () => null }, text: async () => "" };
    return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === "content-type" ? "application/json" : null) }, text: async () => JSON.stringify([ev("e1", "PLC")]) };
  };
  const http = {
    getJson: (c, o) => getJson(c, { ...o, fetchImpl }),
    postJson: (c, b, o) => postReal(c, b, { ...o, fetchImpl }),
  };
  // Prazo do ACK = TTL - margem = 150 ms: vence DURANTE o backoff de 700 ms do 1º retry.
  const leaseTtlS = (IFOOD_EVENTS.margemFencingAckMs + 150) / 1000;
  const poller = criarPoller({ repo, token: criarTokenFake({ escopo: "app" }), http, holder: "inst-A", agora: relogio.agora, log: silencio, leaseTtlS, unidadesPiloto: pilotoDe(repo) });
  await assert.rejects(poller.executarCiclo(), (e) => e.codigo === IFOOD_ERROS.IFOOD_CANCELADO);
  assert.equal(chamadas.polling, 1);
  assert.equal(chamadas.ack, 1, "o retry do ACK não pode sair depois do prazo do lease");
  assert.equal(repo.eventos.get("e1").acknowledged_at, null);
});

test("ACK pendurado é abortado no prazo — antes do lease poder vencer (relógio real)", async () => {
  const relogio = { agoraMs: () => Date.now(), agora: () => new Date(), avancarS: () => {} };
  const repo = criarRepoEmMemoria({ relogio });
  // TTL "curto" só para o teste: prazo = TTL - margem = 200 ms; o lease no "banco" vence em 15,2 s.
  const leaseTtlS = (IFOOD_EVENTS.margemFencingAckMs + 200) / 1000;
  const { client, poller } = montar({ relogio, repo, respostas: [[ev("e1", "PLC")]], leaseTtlS });
  let abortadoEm = null;
  client.confirmarEventos = ({ sinal }) => new Promise((_, rej) => {
    sinal.addEventListener("abort", () => { abortadoEm = Date.now(); rej(Object.assign(new Error("abortado"), { codigo: IFOOD_ERROS.IFOOD_CANCELADO })); }, { once: true });
  });
  const t0 = Date.now();
  // O timer do AbortSignal.timeout é unref (em produção o socket do fetch / o servidor HTTP mantém o processo
  // vivo). Aqui o ACK falso não abre socket: este timer só segura o event loop até o abort acontecer.
  const vivo = setTimeout(() => {}, 5_000);
  // Único grupo e ele falhou (etapa ack): o erro sobe para o loop aplicar backoff.
  await assert.rejects(poller.executarCiclo(), (e) => e.codigo === IFOOD_ERROS.IFOOD_CANCELADO);
  clearTimeout(vivo);
  assert.ok(abortadoEm, "o prazo precisa abortar o ACK pendurado");
  assert.ok(abortadoEm < repo.lease.ate, "o abort acontece ANTES do vencimento do lease no banco");
  assert.ok(abortadoEm - t0 < 2_000, `abort no prazo (~200 ms), levou ${abortadoEm - t0} ms`);
  assert.equal(repo.eventos.get("e1").acknowledged_at, null, "sem ACK confirmado, nada é marcado");
});
