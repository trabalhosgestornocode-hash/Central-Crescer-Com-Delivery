// Testes de mecânica de LEASE/FENCING (Checkpoint C3.5) — contra o repo em
// memória, que implementa exatamente o mesmo contrato atômico do repo
// Supabase (CAS via UPDATE...WHERE, nunca read-then-write não atômico —
// ver comentário de whatsappGateway.repo.js#adquirirLease e a migration 084).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { criarRepoEmMemoria, LeaseStaleError } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";

const ORG_ID = "org-lease-teste";
const TTL_MS = 1000;

describe("whatsappGateway.repo — lease/fencing (Checkpoint C3.5)", () => {
  test("acquire simultâneo: A e B tentam ao mesmo tempo (mesmo epoch de partida) — exatamente um ganha, o banco termina com um único owner e lease_epoch = epoch_lido+1, o perdedor recebe acquired:false", async () => {
    const repo = criarRepoEmMemoria();
    const a = randomUUID();
    const b = randomUUID();

    // Semeia um epoch de partida > 0 (equivalente ao "A e B leem epoch 10"
    // do enunciado) — um ciclo prévio de acquire+release, sem relação com
    // A/B desta corrida.
    const semeador = randomUUID();
    const { leaseEpoch: epochDePartida } = await repo.adquirirLease(ORG_ID, { gatewayProcessId: semeador, ttlMs: TTL_MS });
    await repo.liberarLease(ORG_ID, { gatewayProcessId: semeador, leaseEpoch: epochDePartida });

    // "Simultâneo" no repo em memória é síncrono por construção (nenhum
    // await entre leitura e escrita do Map dentro de UMA chamada) — dispara
    // as duas Promises sem aguardar nenhuma antes da outra, o pior caso de
    // corrida observável pelo CHAMADOR. O mecanismo real de exclusão sob
    // concorrência genuína (duas conexões/processos distintos) é o
    // UPDATE...WHERE lease_epoch=$lido do repo Supabase — ver comentário no
    // topo do arquivo e whatsapp-gateway-repo-supabase.test.js (que exercita
    // exatamente este cenário contra o Supabase de teste real; não roda
    // neste sandbox por falta de credenciais, mas prova o mesmo contrato
    // quando executado contra um Postgres de verdade).
    const [rA, rB] = await Promise.all([
      repo.adquirirLease(ORG_ID, { gatewayProcessId: a, ttlMs: TTL_MS }),
      repo.adquirirLease(ORG_ID, { gatewayProcessId: b, ttlMs: TTL_MS }),
    ]);

    const ganhadores = [rA, rB].filter((r) => r.acquired);
    const perdedores = [rA, rB].filter((r) => !r.acquired);
    assert.equal(ganhadores.length, 1, "exatamente um dos dois precisa ganhar a lease");
    assert.equal(perdedores.length, 1);
    assert.equal(ganhadores[0].leaseEpoch, epochDePartida + 1, "lease_epoch precisa ser exatamente epoch_lido+1, nunca +2");

    const snap = repo._snapshot(ORG_ID);
    assert.equal(snap.leaseEpoch, epochDePartida + 1, "o banco termina com um único epoch — não duplica incremento");
    assert.ok(snap.leaseOwnerId === a || snap.leaseOwnerId === b, "o banco termina com um único owner definido");
    // O perdedor nunca escreve nada (nem heartbeat, nem auth-state) sem um
    // acquire válido antes — como o teste de "gravação sem fencing nenhum"
    // abaixo prova, e como authState.js/baileysSession.js do lado do
    // Gateway recusam localmente sem `leaseManager.contexto()` válido.
  });

  test("renew: só owner+epoch válidos renovam", async () => {
    const repo = criarRepoEmMemoria();
    const a = randomUUID();
    const { leaseEpoch, acquired } = await repo.adquirirLease(ORG_ID, { gatewayProcessId: a, ttlMs: TTL_MS });
    assert.ok(acquired);

    const r = await repo.renovarLease(ORG_ID, { gatewayProcessId: a, leaseEpoch, ttlMs: TTL_MS });
    assert.equal(r.renewed, true);
    assert.equal(r.leaseEpoch, leaseEpoch, "renew nunca muda o epoch — só acquire incrementa");
  });

  test("stale renew: epoch antigo é rejeitado", async () => {
    const repo = criarRepoEmMemoria();
    const a = randomUUID();
    const b = randomUUID();
    const { leaseEpoch: epochA } = await repo.adquirirLease(ORG_ID, { gatewayProcessId: a, ttlMs: 0 }); // ttl=0: já nasce elegível para B assumir
    const { acquired: bGanhou, leaseEpoch: epochB } = await repo.adquirirLease(ORG_ID, { gatewayProcessId: b, ttlMs: TTL_MS });
    assert.ok(bGanhou);
    assert.ok(epochB > epochA);

    const rStale = await repo.renovarLease(ORG_ID, { gatewayProcessId: a, leaseEpoch: epochA, ttlMs: TTL_MS });
    assert.equal(rStale.renewed, false, "A (epoch velho) não pode renovar depois que B assumiu");
  });

  test("release: só o owner atual pode liberar", async () => {
    const repo = criarRepoEmMemoria();
    const a = randomUUID();
    const b = randomUUID();
    const { leaseEpoch } = await repo.adquirirLease(ORG_ID, { gatewayProcessId: a, ttlMs: TTL_MS });

    const rBErrado = await repo.liberarLease(ORG_ID, { gatewayProcessId: b, leaseEpoch });
    assert.equal(rBErrado.released, false, "B nunca teve a lease — não pode liberar a de A");

    const rA = await repo.liberarLease(ORG_ID, { gatewayProcessId: a, leaseEpoch });
    assert.equal(rA.released, true);

    // Depois do release, qualquer processo pode adquirir de novo (owner nulo).
    const { acquired } = await repo.adquirirLease(ORG_ID, { gatewayProcessId: b, ttlMs: TTL_MS });
    assert.ok(acquired);
  });

  test("release com epoch STALE (A perdeu a lease para B) é rejeitado — release só funciona para o epoch ATUAL", async () => {
    const repo = criarRepoEmMemoria();
    const a = randomUUID();
    const b = randomUUID();
    const leaseA = await repo.adquirirLease(ORG_ID, { gatewayProcessId: a, ttlMs: TTL_MS });
    await repo.liberarLease(ORG_ID, { gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch });
    const leaseB = await repo.adquirirLease(ORG_ID, { gatewayProcessId: b, ttlMs: TTL_MS });

    // A (atrasado, ainda com o epoch antigo) tenta liberar — não pode
    // afetar a lease de B de jeito nenhum.
    const rAStale = await repo.liberarLease(ORG_ID, { gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch });
    assert.equal(rAStale.released, false);

    const snap = repo._snapshot(ORG_ID);
    assert.equal(snap.leaseOwnerId, b, "a lease de B precisa continuar intacta");
    assert.equal(snap.leaseEpoch, leaseB.leaseEpoch);
  });

  test("acquire pelo MESMO owner, ainda dentro do TTL, é IDEMPOTENTE — nunca incrementa lease_epoch (Checkpoint C3.5, item 3)", async () => {
    const repo = criarRepoEmMemoria();
    const a = randomUUID();
    const primeiro = await repo.adquirirLease(ORG_ID, { gatewayProcessId: a, ttlMs: TTL_MS });
    assert.equal(primeiro.acquired, true);

    // Segunda chamada de acquire do MESMO processo (ex.: retry de rede,
    // chamada duplicada por bug) — precisa se comportar como uma renovação,
    // NUNCA como uma posse nova.
    const segundo = await repo.adquirirLease(ORG_ID, { gatewayProcessId: a, ttlMs: TTL_MS });
    assert.equal(segundo.acquired, true);
    assert.equal(segundo.leaseEpoch, primeiro.leaseEpoch, "reacquire pelo mesmo dono NÃO pode gerar epoch novo");

    // Uma terceira vez, para deixar claro que não é "só a segunda vez que é de graça".
    const terceiro = await repo.adquirirLease(ORG_ID, { gatewayProcessId: a, ttlMs: TTL_MS });
    assert.equal(terceiro.leaseEpoch, primeiro.leaseEpoch);

    // O ponto prático: um heartbeat/auth-state já em voo, assinado com o
    // epoch do PRIMEIRO acquire, continua válido depois do reacquire —
    // nunca é invalidado por um epoch que na verdade não mudou.
    await repo.registrarHeartbeat(ORG_ID, { status: "CONNECTED", gatewayProcessId: a, leaseEpoch: primeiro.leaseEpoch });
    assert.equal(repo._snapshot(ORG_ID).status, "CONNECTED");
  });

  test("lease EXPIRADA mas ninguém ainda adquiriu: heartbeat/auth-state são REJEITADOS mesmo com owner_id e epoch ainda batendo (Checkpoint C3.5, item 4 — não pode depender só do relógio/self-fencing do Gateway)", async () => {
    const repo = criarRepoEmMemoria();
    const a = randomUUID();
    // TTL curtíssimo — a lease expira sozinha, sem ninguém liberar e sem
    // nenhum B tê-la tomado ainda (linha continua com owner_id=A, epoch=1).
    const { leaseEpoch, acquired } = await repo.adquirirLease(ORG_ID, { gatewayProcessId: a, ttlMs: 5 });
    assert.ok(acquired);

    await new Promise((r) => setTimeout(r, 30)); // TTL vence; nenhum outro processo adquiriu

    await assert.rejects(
      repo.registrarHeartbeat(ORG_ID, { status: "DISCONNECTED", gatewayProcessId: a, leaseEpoch }),
      LeaseStaleError,
      "owner_id e epoch ainda batem, mas lease_expires_at <= now() — o BANCO precisa recusar sozinho",
    );
    await assert.rejects(
      repo.salvarAuthState(ORG_ID, { authStateEncrypted: "v1:atrasado", authStateVersion: "v1", gatewayProcessId: a, leaseEpoch }),
      LeaseStaleError,
    );
    // Pela mesma razão, nem RENOVAR uma lease já vencida é permitido — uma
    // renovação atrasada não pode "ressuscitar" uma posse cujo prazo já
    // podia ter sido tomado por outro processo.
    const renovacao = await repo.renovarLease(ORG_ID, { gatewayProcessId: a, leaseEpoch, ttlMs: TTL_MS });
    assert.equal(renovacao.renewed, false);
  });

  test("expiração: A morre sem release (TTL vence), B adquire depois com epoch maior", async () => {
    const repo = criarRepoEmMemoria();
    const a = randomUUID();
    const b = randomUUID();
    const { leaseEpoch: epochA, acquired: aGanhou } = await repo.adquirirLease(ORG_ID, { gatewayProcessId: a, ttlMs: 10 });
    assert.ok(aGanhou);

    await new Promise((r) => setTimeout(r, 30)); // TTL de A vence, sem release nenhum (simula crash)

    const rB = await repo.adquirirLease(ORG_ID, { gatewayProcessId: b, ttlMs: TTL_MS });
    assert.equal(rB.acquired, true, "TTL vencido precisa permitir que outro processo adquira mesmo sem release explícito");
    assert.ok(rB.leaseEpoch > epochA, "epoch precisa ser estritamente maior que o de A");
  });

  test("fencing de heartbeat: B assume epoch mais novo; A tenta escrever DISCONNECTED e é rejeitado; banco continua com o estado de B", async () => {
    const repo = criarRepoEmMemoria();
    const a = randomUUID();
    const b = randomUUID();
    const leaseA = await repo.adquirirLease(ORG_ID, { gatewayProcessId: a, ttlMs: TTL_MS });
    await repo.registrarHeartbeat(ORG_ID, { status: "CONNECTED", gatewayVersion: "vA", gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch });

    // A libera (shutdown gracioso) para B poder assumir — enquanto a lease
    // de A está válida e dentro do TTL, ninguém mais consegue adquirir.
    await repo.liberarLease(ORG_ID, { gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch });
    const leaseB = await repo.adquirirLease(ORG_ID, { gatewayProcessId: b, ttlMs: TTL_MS });
    await repo.registrarHeartbeat(ORG_ID, { status: "CONNECTED", gatewayVersion: "vB", gatewayProcessId: b, leaseEpoch: leaseB.leaseEpoch });

    await assert.rejects(
      repo.registrarHeartbeat(ORG_ID, { status: "DISCONNECTED", gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch }),
      LeaseStaleError,
    );

    const snap = repo._snapshot(ORG_ID);
    assert.equal(snap.status, "CONNECTED");
    assert.equal(snap.gatewayVersion, "vB", "o estado de B tem que continuar intacto — A não pode ter escrito nada");
  });

  test("fencing de auth state: auth state antigo de A não pode sobrescrever o persistido por B", async () => {
    const repo = criarRepoEmMemoria();
    const a = randomUUID();
    const b = randomUUID();
    const leaseA = await repo.adquirirLease(ORG_ID, { gatewayProcessId: a, ttlMs: TTL_MS });
    await repo.salvarAuthState(ORG_ID, { authStateEncrypted: "v1:de-A", authStateVersion: "v1", gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch });

    await repo.liberarLease(ORG_ID, { gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch });
    const leaseB = await repo.adquirirLease(ORG_ID, { gatewayProcessId: b, ttlMs: TTL_MS });
    await repo.salvarAuthState(ORG_ID, { authStateEncrypted: "v1:de-B", authStateVersion: "v1", gatewayProcessId: b, leaseEpoch: leaseB.leaseEpoch });

    await assert.rejects(
      repo.salvarAuthState(ORG_ID, { authStateEncrypted: "v1:de-A-atrasado", authStateVersion: "v1", gatewayProcessId: a, leaseEpoch: leaseA.leaseEpoch }),
      LeaseStaleError,
    );

    assert.deepEqual(await repo.obterAuthState(ORG_ID), { status: "present", authStateEncrypted: "v1:de-B" });
  });

  test("gravação sem fencing nenhum (gatewayProcessId/leaseEpoch ausentes) é sempre rejeitada, mesmo sem nenhuma lease jamais adquirida", async () => {
    const repo = criarRepoEmMemoria();
    await assert.rejects(
      repo.registrarHeartbeat(ORG_ID, { status: "CONNECTED" }),
      LeaseStaleError,
      "undefined/undefined não pode 'por acaso' bater com uma linha que nunca teve lease",
    );
  });

  // L (Checkpoint C3.5-B.1) — contrato explícito de obterAuthState(): ausência
  // real (nunca pareado) NUNCA pode ser confundida com fencing stale (owner/
  // epoch não batem). Achado ao vivo: os dois casos costumavam devolver o
  // MESMO `null`, e o Gateway tratava os dois como "nunca pareado" — gerando
  // QR por cima de uma sessão real já pareada quando na verdade era só o
  // fencing que não bateu.
  test("L) obterAuthState: ausência real (linha nunca existiu) -> {status:'absent'}, NUNCA LeaseStaleError", async () => {
    const repo = criarRepoEmMemoria();
    const resultado = await repo.obterAuthState(ORG_ID, { gatewayProcessId: randomUUID(), leaseEpoch: 1 });
    assert.deepEqual(resultado, { status: "absent" }, "org sem NENHUMA linha ainda é ausência legítima, não fencing stale");
  });

  test("L) obterAuthState: linha existe com ciphertext, mas owner/epoch não batem -> LeaseStaleError, NUNCA {status:'absent'}", async () => {
    const repo = criarRepoEmMemoria();
    const dono = randomUUID();
    const outroProcesso = randomUUID();
    const lease = await repo.adquirirLease(ORG_ID, { gatewayProcessId: dono, ttlMs: TTL_MS });
    await repo.salvarAuthState(ORG_ID, { authStateEncrypted: "v1:real", authStateVersion: "v1", gatewayProcessId: dono, leaseEpoch: lease.leaseEpoch });

    await assert.rejects(
      repo.obterAuthState(ORG_ID, { gatewayProcessId: outroProcesso, leaseEpoch: lease.leaseEpoch }),
      LeaseStaleError,
      "existe ciphertext real — a resposta tem que ser stale, NUNCA absent (senão o chamador descartaria uma sessão real)",
    );
    await assert.rejects(
      repo.obterAuthState(ORG_ID, { gatewayProcessId: dono, leaseEpoch: lease.leaseEpoch + 999 }),
      LeaseStaleError,
      "mesmo owner, epoch errado, também precisa ser stale",
    );
  });

  test("L) obterAuthState: linha existe, owner/epoch batem, mas nunca houve auth_state salvo -> {status:'absent'}", async () => {
    const repo = criarRepoEmMemoria();
    const dono = randomUUID();
    const lease = await repo.adquirirLease(ORG_ID, { gatewayProcessId: dono, ttlMs: TTL_MS });

    const resultado = await repo.obterAuthState(ORG_ID, { gatewayProcessId: dono, leaseEpoch: lease.leaseEpoch });
    assert.deepEqual(resultado, { status: "absent" }, "lease existe e bate, mas nenhum auth_state foi salvo ainda — absence legítima");
  });

  test("L) obterAuthState: sem fencing nenhum informado (retrocompat), devolve o ciphertext se existir — nunca lança", async () => {
    const repo = criarRepoEmMemoria();
    const dono = randomUUID();
    const lease = await repo.adquirirLease(ORG_ID, { gatewayProcessId: dono, ttlMs: TTL_MS });
    await repo.salvarAuthState(ORG_ID, { authStateEncrypted: "v1:retrocompat", authStateVersion: "v1", gatewayProcessId: dono, leaseEpoch: lease.leaseEpoch });

    const resultado = await repo.obterAuthState(ORG_ID);
    assert.deepEqual(resultado, { status: "present", authStateEncrypted: "v1:retrocompat" });
  });
});
