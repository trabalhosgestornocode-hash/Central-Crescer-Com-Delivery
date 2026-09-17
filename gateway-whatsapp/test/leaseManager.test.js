// Testes do leaseManager (Checkpoint C3.5) — mecânica de LEADER/STANDBY,
// renovação periódica, self-fencing por prazo local, e perda de lease
// (interna via renew, ou externa via notificarPerdaExterna). Timers são
// injetados como fakes controláveis (agendarIntervalo/cancelarIntervalo) —
// nenhum teste espera tempo real.
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { criarLeaseManager } from "../src/leaseManager.js";

/** setInterval/clearInterval fakes: o teste dispara os timers manualmente via `disparar(id)`. */
function timersControlaveis() {
  let proximoId = 1;
  const timers = new Map(); // id -> fn
  return {
    agendarIntervalo(fn) {
      const id = proximoId++;
      timers.set(id, fn);
      return id;
    },
    cancelarIntervalo(id) { timers.delete(id); },
    async disparar(id) { await timers.get(id)?.(); },
    ativos: () => [...timers.keys()],
  };
}

function backendClientControlavel() {
  const chamadas = { acquire: [], renew: [], release: [] };
  let comportamentoAcquire = async () => ({ acquired: true, leaseEpoch: 1, expiresAt: null });
  let comportamentoRenew = async () => ({ renewed: true, leaseEpoch: 1, expiresAt: null });
  return {
    async adquirirLease(payload) { chamadas.acquire.push(payload); return comportamentoAcquire(payload); },
    async renovarLease(payload) { chamadas.renew.push(payload); return comportamentoRenew(payload); },
    async liberarLease(payload) { chamadas.release.push(payload); return { released: true }; },
    _definirAcquire: (fn) => { comportamentoAcquire = fn; },
    _definirRenew: (fn) => { comportamentoRenew = fn; },
    _chamadas: chamadas,
  };
}

describe("leaseManager — LEADER/STANDBY (Checkpoint C3.5)", () => {
  test("iniciar() com acquire bem-sucedido vira LEADER e agenda renovação periódica", async () => {
    const timers = timersControlaveis();
    const backendClient = backendClientControlavel();
    const lm = criarLeaseManager({
      backendClient, gatewayProcessId: "proc-a", ttlMs: 1000, renewMs: 300,
      agendarIntervalo: timers.agendarIntervalo, cancelarIntervalo: timers.cancelarIntervalo,
    });

    const ganhou = await lm.iniciar();
    assert.equal(ganhou, true);
    assert.equal(lm.souLeader(), true);
    assert.deepEqual(lm.contexto(), { gatewayProcessId: "proc-a", leaseEpoch: 1 });
    assert.equal(timers.ativos().length, 1, "um timer de renovação precisa estar agendado");
  });

  test("iniciar() sem ganhar o acquire vira STANDBY e entra em polling — nunca vira leader sozinho sem um acquire novo", async () => {
    const timers = timersControlaveis();
    const backendClient = backendClientControlavel();
    backendClient._definirAcquire(async () => ({ acquired: false, leaseEpoch: 5, expiresAt: null }));
    const lm = criarLeaseManager({
      backendClient, gatewayProcessId: "proc-b", ttlMs: 1000, renewMs: 300,
      agendarIntervalo: timers.agendarIntervalo, cancelarIntervalo: timers.cancelarIntervalo,
    });

    const ganhou = await lm.iniciar();
    assert.equal(ganhou, false);
    assert.equal(lm.souLeader(), false);
    assert.equal(lm.contexto(), null);
    assert.equal(timers.ativos().length, 1, "precisa estar em polling standby");
  });

  test("polling standby: quando o acquire volta a suceder, o próximo tick vira LEADER", async () => {
    const timers = timersControlaveis();
    const backendClient = backendClientControlavel();
    backendClient._definirAcquire(async () => ({ acquired: false, leaseEpoch: 1, expiresAt: null }));
    const lm = criarLeaseManager({
      backendClient, gatewayProcessId: "proc-b", ttlMs: 1000, renewMs: 300,
      agendarIntervalo: timers.agendarIntervalo, cancelarIntervalo: timers.cancelarIntervalo,
    });
    await lm.iniciar();
    assert.equal(lm.souLeader(), false);
    const [idPolling] = timers.ativos();

    backendClient._definirAcquire(async () => ({ acquired: true, leaseEpoch: 2, expiresAt: null }));
    await timers.disparar(idPolling);

    assert.equal(lm.souLeader(), true);
    assert.deepEqual(lm.contexto(), { gatewayProcessId: "proc-b", leaseEpoch: 2 });
  });

  test("renew bem-sucedido mantém leader e não muda o epoch", async () => {
    const timers = timersControlaveis();
    const backendClient = backendClientControlavel();
    const lm = criarLeaseManager({
      backendClient, gatewayProcessId: "proc-a", ttlMs: 1000, renewMs: 300,
      agendarIntervalo: timers.agendarIntervalo, cancelarIntervalo: timers.cancelarIntervalo,
    });
    await lm.iniciar();
    const [idRenovacao] = timers.ativos();

    await timers.disparar(idRenovacao);

    assert.equal(lm.souLeader(), true);
    assert.equal(lm.contexto().leaseEpoch, 1, "renew nunca muda o epoch");
    assert.equal(backendClient._chamadas.renew.length, 1);
  });

  test("renew explicitamente rejeitado (renewed:false) dispara aoPerderLease e volta para STANDBY", async () => {
    const timers = timersControlaveis();
    const backendClient = backendClientControlavel();
    const aoPerderLease = mock.fn(async () => {});
    const lm = criarLeaseManager({
      backendClient, gatewayProcessId: "proc-a", ttlMs: 1000, renewMs: 300, aoPerderLease,
      agendarIntervalo: timers.agendarIntervalo, cancelarIntervalo: timers.cancelarIntervalo,
    });
    await lm.iniciar();
    const [idRenovacao] = timers.ativos();

    backendClient._definirRenew(async () => ({ renewed: false, leaseEpoch: null, expiresAt: null }));
    await timers.disparar(idRenovacao);

    assert.equal(lm.souLeader(), false);
    assert.equal(lm.contexto(), null);
    assert.equal(aoPerderLease.mock.calls.length, 1);
    assert.equal(timers.ativos().length, 1, "precisa ter trocado para o timer de polling standby");
  });

  test("renew falha por rede ANTES do prazo local: continua leader, tenta de novo depois (sem aoPerderLease ainda)", async () => {
    const timers = timersControlaveis();
    const backendClient = backendClientControlavel();
    const aoPerderLease = mock.fn(async () => {});
    const lm = criarLeaseManager({
      backendClient, gatewayProcessId: "proc-a", ttlMs: 100_000, renewMs: 300, margemSegurancaMs: 1000, aoPerderLease,
      agendarIntervalo: timers.agendarIntervalo, cancelarIntervalo: timers.cancelarIntervalo,
    });
    await lm.iniciar(); // ttl de 100s — muito longe do prazo
    const [idRenovacao] = timers.ativos();

    backendClient._definirRenew(async () => { throw new Error("timeout de rede (simulado)"); });
    await timers.disparar(idRenovacao);

    assert.equal(lm.souLeader(), true, "ainda longe do prazo local — não pode desistir na primeira falha de rede");
    assert.equal(aoPerderLease.mock.calls.length, 0);
  });

  test("renew falha por rede DEPOIS que o prazo local (com margem) já passou: self-fencing — dispara aoPerderLease mesmo sem confirmação do backend (item 13)", async () => {
    const timers = timersControlaveis();
    const backendClient = backendClientControlavel();
    const aoPerderLease = mock.fn(async () => {});
    // TTL curtíssimo + margem generosa: o prazo local (ttl - margem) já
    // fica no passado praticamente assim que o acquire termina.
    const lm = criarLeaseManager({
      backendClient, gatewayProcessId: "proc-a", ttlMs: 1, renewMs: 300, margemSegurancaMs: 10_000, aoPerderLease,
      agendarIntervalo: timers.agendarIntervalo, cancelarIntervalo: timers.cancelarIntervalo,
    });
    await lm.iniciar();
    const [idRenovacao] = timers.ativos();

    backendClient._definirRenew(async () => { throw new Error("backend indisponível (simulado)"); });
    await timers.disparar(idRenovacao);

    assert.equal(lm.souLeader(), false, "sem conseguir confirmar renovação e já além do prazo local, precisa desistir sozinho");
    assert.equal(aoPerderLease.mock.calls.length, 1);
  });

  test("notificarPerdaExterna() (ex.: 409 detectado num heartbeat/auth-state fenced) tem o mesmo efeito de perder no renew", async () => {
    const timers = timersControlaveis();
    const backendClient = backendClientControlavel();
    const aoPerderLease = mock.fn(async () => {});
    const lm = criarLeaseManager({
      backendClient, gatewayProcessId: "proc-a", ttlMs: 1000, renewMs: 300, aoPerderLease,
      agendarIntervalo: timers.agendarIntervalo, cancelarIntervalo: timers.cancelarIntervalo,
    });
    await lm.iniciar();
    assert.equal(lm.souLeader(), true);

    await lm.notificarPerdaExterna("heartbeat_stale");

    assert.equal(lm.souLeader(), false);
    assert.equal(aoPerderLease.mock.calls.length, 1);
    assert.equal(aoPerderLease.mock.calls[0].arguments.length, 0, "aoPerderLease não recebe o motivo — é só um sinal 'feche tudo'");
  });

  test("pararTemporizadores() para o timer de renovação mas MANTÉM contexto() válido (shutdown do leader precisa do epoch ainda válido para o heartbeat final)", async () => {
    const timers = timersControlaveis();
    const backendClient = backendClientControlavel();
    const lm = criarLeaseManager({
      backendClient, gatewayProcessId: "proc-a", ttlMs: 1000, renewMs: 300,
      agendarIntervalo: timers.agendarIntervalo, cancelarIntervalo: timers.cancelarIntervalo,
    });
    await lm.iniciar();

    lm.pararTemporizadores();

    assert.equal(timers.ativos().length, 0, "nenhum timer pode continuar rodando depois do shutdown começar");
    assert.equal(lm.souLeader(), true, "ainda é leader — só os TIMERS pararam, não o estado");
    assert.deepEqual(lm.contexto(), { gatewayProcessId: "proc-a", leaseEpoch: 1 }, "epoch ainda válido para a última gravação fenced");
  });

  test("liberar() só funciona enquanto leader; depois de liberar, contexto() volta a null", async () => {
    const timers = timersControlaveis();
    const backendClient = backendClientControlavel();
    const lm = criarLeaseManager({
      backendClient, gatewayProcessId: "proc-a", ttlMs: 1000, renewMs: 300,
      agendarIntervalo: timers.agendarIntervalo, cancelarIntervalo: timers.cancelarIntervalo,
    });
    await lm.iniciar();
    lm.pararTemporizadores();

    const r = await lm.liberar();
    assert.equal(r.released, true);
    assert.equal(lm.souLeader(), false);
    assert.equal(lm.contexto(), null);
    assert.equal(backendClient._chamadas.release.length, 1);
    assert.deepEqual(backendClient._chamadas.release[0], { gatewayProcessId: "proc-a", leaseEpoch: 1 });
  });

  test("liberar() chamado numa instância standby (nunca foi leader) é um no-op seguro — nunca chama o backend", async () => {
    const timers = timersControlaveis();
    const backendClient = backendClientControlavel();
    backendClient._definirAcquire(async () => ({ acquired: false, leaseEpoch: 9, expiresAt: null }));
    const lm = criarLeaseManager({
      backendClient, gatewayProcessId: "proc-b", ttlMs: 1000, renewMs: 300,
      agendarIntervalo: timers.agendarIntervalo, cancelarIntervalo: timers.cancelarIntervalo,
    });
    await lm.iniciar();

    const r = await lm.liberar();
    assert.equal(r.released, false);
    assert.equal(backendClient._chamadas.release.length, 0, "standby nunca teve nada para liberar — não pode nem tentar");
  });
});
