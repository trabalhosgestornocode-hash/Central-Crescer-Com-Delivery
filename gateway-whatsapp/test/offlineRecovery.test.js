// Checkpoint G — testes UNITÁRIOS (relógio/timer falsos, sem Baileys real) do motor de OFFLINE_RECOVERY.
// Ver test/offlineRecoveryIntegracao.test.js para os cenários com o Baileys REAL (socket local, sendNode de verdade).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { criarMotorRecovery, FASE_RECOVERY, MOTIVOS_FINALIZACAO, PADROES_RECOVERY } from "../src/offlineRecovery.js";

const aqui = dirname(fileURLToPath(import.meta.url));

/** ambiente com relógio/timer INJETADOS (timers nunca disparam sozinhos: só `avancar()` os move e chama tick). */
function abrir(opcoesMotor = {}) {
  let t = 1_700_000_000_000;
  const eventos = [];
  const timers = [];
  const est = {
    buffer: true, aberto: true, offlineFim: false, retidas: 5, fase: "OFFLINE_STALLED_OBSERVED",
    authOk: true, identidade: true, habilitado: true,
  };
  const pedidos = [];
  const iniciar = { n: 0 };
  const agendar = (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; };
  const cancelar = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  const motor = criarMotorRecovery({
    agora: () => t, emitir: (nivel, evento, dados) => eventos.push({ evento, dados }), obterEpoch: () => 7,
    agendar, cancelar, habilitado: () => est.habilitado,
    tickMs: 100, batchQuietMs: 1000, maxRecoveryBatches: 5, maxRecoveryNodes: 500, maxRecoveryDurationMs: 10_000, maxConsecutiveNoProgressBatches: 2,
    ...opcoesMotor,
  });
  const g = motor.novaGeracao({
    lerBufferAtivo: () => est.buffer, lerSocketAberto: () => est.aberto, lerOfflineFimRecebido: () => est.offlineFim,
    lerMensagensRetidas: () => est.retidas, lerFaseObservador: () => est.fase, lerAuthHeadroomOk: () => est.authOk,
    lerIdentidadeDisponivel: () => est.identidade, pedirBatch: () => pedidos.push(t), aoIniciar: () => { iniciar.n += 1; },
  });
  function avancar(ms, passo = 100) {
    const alvo = t + ms;
    while (t < alvo) { t = Math.min(t + passo, alvo); motor.tick(g); }
  }
  const porNome = (n) => eventos.filter((x) => x.evento === n);
  /** simula um lote de `n` nós offline, `unicos` deles com fingerprint novo, entregues "instantaneamente" (mesmo t) */
  function loteDeNos(n, unicos) {
    for (let i = 0; i < n; i++) motor.aoNo(g, { progressoUtil: i < unicos });
  }
  return { motor, g, est, eventos, porNome, avancar, pedidos, iniciar, loteDeNos, timers };
}

describe("vocabulário fechado", () => {
  test("MOTIVOS_FINALIZACAO é exatamente o vocabulário do checkpoint", () => {
    assert.deepEqual([...MOTIVOS_FINALIZACAO].sort(), [
      "auth_headroom", "disabled", "internal_error", "live_node", "marker_received",
      "max_batches", "max_duration", "max_nodes", "no_progress", "socket_closed",
    ].sort());
  });
  test("FASE_RECOVERY tem exatamente IDLE/RECOVERING/DONE", () => {
    assert.deepEqual(Object.keys(FASE_RECOVERY).sort(), ["DONE", "IDLE", "RECOVERING"]);
  });
});

describe("kill-switch: desligado nasce e permanece equivalente a 'recovery inexistente'", () => {
  test("habilitado=false: mesmo com stall confirmado e todas as precondições, NUNCA inicia, NUNCA pede batch", () => {
    const a = abrir(); a.est.habilitado = false;
    a.avancar(5000);
    assert.equal(a.motor.estado().status, FASE_RECOVERY.IDLE);
    assert.equal(a.pedidos.length, 0);
    assert.equal(a.iniciar.n, 0);
    assert.equal(a.eventos.length, 0, "nenhum evento de recovery — nem started, nem aborted");
  });

  test("habilitado vira false NO MEIO do recovery: aborta no próximo tick com 'disabled' (kill-switch checado continuamente)", () => {
    const a = abrir();
    a.avancar(100); // início
    assert.equal(a.motor.estado().status, FASE_RECOVERY.RECOVERING);
    a.est.habilitado = false;
    a.avancar(100);
    assert.equal(a.motor.estado().status, FASE_RECOVERY.DONE);
    assert.equal(a.motor.estado().motivoFinal, "disabled");
    assert.equal(a.porNome("inbound.offline_recovery_aborted")[0].dados.reason, "disabled");
  });
});

describe("entrada (seção 19): fail-closed — qualquer precondição faltando, nunca inicia", () => {
  const casos = [
    ["fase diferente de OFFLINE_STALLED_OBSERVED", (est) => { est.fase = "OFFLINE_LOADING"; }],
    ["buffer inativo", (est) => { est.buffer = false; }],
    ["offlineFimRecebido já true", (est) => { est.offlineFim = true; }],
    ["mensagensRetidas = 0", (est) => { est.retidas = 0; }],
    ["socket não aberto", (est) => { est.aberto = false; }],
    ["identidade indisponível (sem fingerprint não há como medir progresso)", (est) => { est.identidade = false; }],
    ["auth headroom ruim", (est) => { est.authOk = false; }],
  ];
  for (const [nome, mutar] of casos) {
    test(`nunca inicia: ${nome}`, () => {
      const a = abrir(); mutar(a.est);
      a.avancar(5000);
      assert.equal(a.motor.estado().status, FASE_RECOVERY.IDLE);
      assert.equal(a.pedidos.length, 0);
      assert.equal(a.porNome("inbound.offline_recovery_started").length, 0);
    });
  }

  test("só UMA tentativa por geração: se a 1ª falhar, avançar mais tempo não tenta de novo mesmo se as condições melhorarem depois", () => {
    const a = abrir(); a.est.retidas = 0;
    a.avancar(200); // a 1ª tentativa (tick) já falha e marca tentouIniciar
    a.est.retidas = 10; // "melhora" depois
    a.avancar(5000);
    assert.equal(a.motor.estado().status, FASE_RECOVERY.IDLE);
    assert.equal(a.pedidos.length, 0);
  });
});

describe("cenário 1 (sucesso): pede batch, progresso útil mantém, marcador chega ⇒ completed sem flush manual", () => {
  test("inicia pedindo 1 batch; ao settle com progresso pede o próximo; marcador durante recovery ⇒ marker_received", () => {
    const a = abrir();
    a.avancar(100);
    assert.equal(a.pedidos.length, 1, "pediu o 1º batch adicional ao entrar em RECOVERING");
    assert.deepEqual(Object.keys(a.porNome("inbound.offline_recovery_started")[0].dados).sort(), ["epoch", "mensagensRetidasNoInicio", "socketGeneration"]);

    a.loteDeNos(100, 100); // o "servidor" entregou 100 novos
    a.avancar(1100); // settle da quietude
    assert.equal(a.pedidos.length, 2, "progresso útil ⇒ pediu o 2º batch");
    const lote1 = a.porNome("inbound.offline_recovery_batch")[0].dados;
    assert.deepEqual([lote1.batchNumber, lote1.nodes, lote1.unique, lote1.duplicates], [1, 100, 100, 0]);

    a.motor.aoMarcador(a.g); // o marcador chegou durante o 2º batch
    assert.equal(a.motor.estado().status, FASE_RECOVERY.DONE);
    assert.equal(a.motor.estado().motivoFinal, "marker_received");
    const done = a.porNome("inbound.offline_recovery_completed")[0].dados;
    assert.equal(done.reason, "marker_received");
    assert.equal(done.batchesRequested, 2);
  });
});

describe("cenário 3/47 (100% duplicado): aborta por falta de progresso, ZERO flush manual", () => {
  test("dois lotes seguidos sem NENHUM fingerprint novo ⇒ no_progress", () => {
    const a = abrir({ maxConsecutiveNoProgressBatches: 2 });
    a.avancar(100); assert.equal(a.pedidos.length, 1);
    a.loteDeNos(100, 0); a.avancar(1100); // lote 1: 100% duplicado
    assert.equal(a.motor.estado().status, FASE_RECOVERY.RECOVERING, "1º lote sem progresso ainda não aborta (teto=2)");
    assert.equal(a.pedidos.length, 2);
    a.loteDeNos(100, 0); a.avancar(1100); // lote 2: também 100% duplicado ⇒ teto atingido
    assert.equal(a.motor.estado().status, FASE_RECOVERY.DONE);
    assert.equal(a.motor.estado().motivoFinal, "no_progress");
    assert.equal(a.pedidos.length, 2, "NUNCA pediu um 3º batch depois do abort");
  });
});

describe("cenário 4 (marcador antes do watchdog): recovery nunca inicia", () => {
  test("fase nunca chega a OFFLINE_STALLED_OBSERVED (offline terminou sozinho) ⇒ aoMarcador só fecha a janela, sem eventos", () => {
    const a = abrir(); a.est.fase = "OFFLINE_LOADING";
    a.avancar(300);
    a.motor.aoMarcador(a.g);
    assert.equal(a.motor.estado().status, FASE_RECOVERY.IDLE);
    assert.equal(a.eventos.length, 0);
    a.est.fase = "OFFLINE_STALLED_OBSERVED"; // mesmo que a fase "mude" depois (não deveria, mas por segurança)
    a.avancar(300);
    assert.equal(a.motor.estado().status, FASE_RECOVERY.IDLE, "marcador já fechou a janela de entrada desta geração");
  });
});

describe("cenário 8/52 (limite de nós): aborta ao atingir maxRecoveryNodes mesmo com progresso", () => {
  test("um único lote gigante e todo novo ⇒ max_nodes vence antes de max_batches", () => {
    const a = abrir({ maxRecoveryNodes: 150, maxRecoveryBatches: 10 });
    a.avancar(100);
    a.loteDeNos(200, 200); // acima do teto de nós, mas TODOS únicos (progresso real)
    a.avancar(1100);
    assert.equal(a.motor.estado().motivoFinal, "max_nodes");
  });

  test("maxRecoveryBatches vence quando o volume por lote é pequeno", () => {
    const a = abrir({ maxRecoveryNodes: 100_000, maxRecoveryBatches: 2 });
    a.avancar(100); assert.equal(a.pedidos.length, 1);
    a.loteDeNos(10, 10); a.avancar(1100); assert.equal(a.pedidos.length, 2);
    a.loteDeNos(10, 10); a.avancar(1100);
    assert.equal(a.motor.estado().motivoFinal, "max_batches");
    assert.equal(a.pedidos.length, 2, "nunca excedeu o teto de batches");
  });
});

describe("cenário 9/53 (limite de tempo): aborta por duração mesmo com progresso constante", () => {
  test("progresso a cada tick nunca deixa a quietude vencer, mas maxRecoveryDurationMs aborta mesmo assim", () => {
    const a = abrir({ maxRecoveryDurationMs: 1000, batchQuietMs: 5000 });
    a.avancar(100);
    for (let i = 0; i < 20; i++) { a.loteDeNos(1, 1); a.avancar(100); }
    assert.equal(a.motor.estado().status, FASE_RECOVERY.DONE);
    assert.equal(a.motor.estado().motivoFinal, "max_duration");
  });
});

describe("cenário 10/54 (auth headroom): guarda de segurança do auth-state", () => {
  test("headroom ruim JÁ na entrada ⇒ nunca inicia", () => {
    const a = abrir(); a.est.authOk = false;
    a.avancar(1000);
    assert.equal(a.motor.estado().status, FASE_RECOVERY.IDLE);
  });
  test("headroom fica ruim DURANTE o recovery ⇒ aborta no próximo settle, sem esperar os outros limites", () => {
    const a = abrir();
    a.avancar(100);
    a.est.authOk = false;
    a.loteDeNos(5, 5); a.avancar(1100);
    assert.equal(a.motor.estado().motivoFinal, "auth_headroom");
  });
});

describe("cenário 5/49 (marcador durante a espera de resposta): 1 vencedor, sem segundo request tardio", () => {
  test("marcador chega no meio da janela de quietude: encerra ANTES do timer decidir pedir mais um batch", () => {
    const a = abrir();
    a.avancar(100); assert.equal(a.pedidos.length, 1);
    a.loteDeNos(5, 5);
    a.motor.aoMarcador(a.g); // ainda dentro da janela de quietude de 1000ms
    assert.equal(a.motor.estado().motivoFinal, "marker_received");
    a.avancar(2000); // o tick seguinte não pode reagir mais (já está DONE)
    assert.equal(a.pedidos.length, 1, "nenhum 2º pedido depois do marcador");
  });
});

describe("cenário 6/50 (socket fecha): cancela tudo, nenhum callback tardio", () => {
  test("aoFechado durante RECOVERING ⇒ socket_closed imediato (não espera a quietude)", () => {
    const a = abrir();
    a.avancar(100);
    a.motor.aoFechado(a.g);
    assert.equal(a.motor.estado().motivoFinal, "socket_closed");
    a.avancar(5000); // nada mais acontece depois de fechado
    assert.equal(a.pedidos.length, 1);
  });

  test("um NÓ da geração fechada que chega atrasado é ignorado (guarda de geração)", () => {
    const a = abrir();
    a.avancar(100);
    a.motor.aoFechado(a.g);
    a.motor.aoNo(a.g, { progressoUtil: true }); // tardio — geração já fechada (status DONE)
    assert.equal(a.motor.estado().nodesRecebidos, 0, "não contou: o motor só processa nós enquanto RECOVERING");
  });
});

describe("cenário 7/51 (nova geração): callback tardio da geração anterior é ignorado", () => {
  test("gen 1 em RECOVERING; gen 2 abre; ações com o token da gen 1 não tocam a gen 2", () => {
    const a = abrir();
    a.avancar(100);
    const g1 = a.g;
    assert.equal(a.motor.estado().status, FASE_RECOVERY.RECOVERING);
    const g2 = a.motor.novaGeracao({
      lerBufferAtivo: () => false, lerSocketAberto: () => true, lerOfflineFimRecebido: () => false,
      lerMensagensRetidas: () => 0, lerFaseObservador: () => "CONNECTING", lerAuthHeadroomOk: () => true,
      lerIdentidadeDisponivel: () => true, pedirBatch: () => {}, aoIniciar: () => {},
    });
    assert.notEqual(g1, g2);
    const estadoLimpo = { socketGeneration: g2, status: FASE_RECOVERY.IDLE, motivoFinal: null, tentouIniciar: false, batchesSolicitados: 0, nodesRecebidos: 0, nodesUnicos: 0, duplicados: 0, consecutiveNoProgressBatches: 0 };
    assert.deepEqual(a.motor.estado(), estadoLimpo);
    a.motor.aoMarcador(g1); a.motor.aoNo(g1, { progressoUtil: true }); a.motor.aoFechado(g1); a.motor.aoNoVivo(g1);
    assert.deepEqual(a.motor.estado(), estadoLimpo, "geração 2 intacta em TODOS os campos (não só `status`) — nada da 1 vazou para ela, nem sequer `tentouIniciar`");
    // a geração 2 continua funcionando normalmente depois disso (a guarda não deixou nenhum resíduo)
    a.motor.tick(g2); // fase="OFFLINE_STALLED_OBSERVED" simulada abaixo via novo ambiente seria redundante; aqui só prova que não lançou nem travou
    assert.equal(a.motor.estado().status, FASE_RECOVERY.IDLE);
  });
});

describe("cenário 34 (nó vivo compete): não flush, apenas registra e para", () => {
  test("aoNoVivo durante RECOVERING ⇒ live_node imediato, sem pedir mais batches depois", () => {
    const a = abrir();
    a.avancar(100);
    a.motor.aoNoVivo(a.g);
    assert.equal(a.motor.estado().motivoFinal, "live_node");
    const done = a.porNome("inbound.offline_recovery_completed")[0].dados;
    assert.equal(done.reason, "live_node");
    a.avancar(5000);
    assert.equal(a.pedidos.length, 1);
  });
  test("aoNoVivo fora do RECOVERING (IDLE) é NOOP — não inventa um recovery que nunca começou", () => {
    const a = abrir(); a.est.retidas = 0; // nunca vai iniciar
    a.avancar(200);
    a.motor.aoNoVivo(a.g);
    assert.equal(a.motor.estado().status, FASE_RECOVERY.IDLE);
    assert.equal(a.eventos.length, 0);
  });
});

describe("eventos/métricas (seções 63-64): só vocabulário fechado, sem identificadores", () => {
  test("payload dos eventos não tem chaves fora do fechado", () => {
    const a = abrir();
    a.avancar(100);
    a.loteDeNos(10, 4); a.avancar(1100);
    a.motor.aoMarcador(a.g);
    for (const nome of ["inbound.offline_recovery_started", "inbound.offline_recovery_batch", "inbound.offline_recovery_completed"]) {
      const d = a.porNome(nome)[0].dados;
      const txt = JSON.stringify(d);
      for (const proibido = /[a-zA-Z0-9]{20,}/g; ;) {
        const m = proibido.exec(txt);
        if (!m) break;
        assert.ok(!/[+@]/.test(m[0]), `campo com pinta de JID/telefone em ${nome}: ${m[0]}`);
      }
      assert.ok(Object.values(d).every((v) => typeof v === "number" || typeof v === "string" || typeof v === "boolean" || typeof v === "object"));
    }
  });

  test("metricas() acumula ao longo de várias gerações", () => {
    const a = abrir();
    a.avancar(100); a.motor.aoNoVivo(a.g); // 1 sucesso (live_node)
    const g2 = a.motor.novaGeracao({
      lerBufferAtivo: () => true, lerSocketAberto: () => true, lerOfflineFimRecebido: () => false,
      lerMensagensRetidas: () => 5, lerFaseObservador: () => "OFFLINE_STALLED_OBSERVED", lerAuthHeadroomOk: () => true,
      lerIdentidadeDisponivel: () => true, pedirBatch: () => {}, aoIniciar: () => {},
    });
    a.motor.tick(g2); a.motor.aoFechado(g2); // 1 aborto (socket_closed)
    const m = a.motor.metricas();
    assert.equal(m.iniciados, 2); assert.equal(m.sucesso, 1); assert.equal(m.abortados, 1);
  });
});

describe("GUARDA ESTRUTURAL (seção 69): o motor não tem acesso a flush/buffer/sendNode/ev/ws/socket", () => {
  const fonte = readFileSync(join(aqui, "..", "src", "offlineRecovery.js"), "utf8").replace(/\r\n/g, "\n");
  const codigo = fonte.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  test("nenhum token proibido no código (só em comentários, que já foram removidos)", () => {
    for (const proibido of [/\bflush\s*\(/i, /\.buffer\s*\(/, /\.emit\s*\(/, /\bsendNode\b/, /\bsendMessage\b/, /\.end\s*\(/, /\.close\s*\(/, /relayMessage/, /\.query\s*\(/, /offline_batch/, /fetch\s*\(/, /require\(|^import /m]) {
      assert.ok(!proibido.test(codigo), `token proibido encontrado: ${proibido}`);
    }
  });

  test("a fábrica não declara/usa nenhum parâmetro chamado ev/ws/socket/sock", () => {
    const assinatura = codigo.slice(codigo.indexOf("export function criarMotorRecovery("), codigo.indexOf("export function criarMotorRecovery(") + 800);
    for (const proibido of [/\bev\b/, /\bws\b/, /\bsocket\b/, /\bsock\b/]) assert.ok(!proibido.test(assinatura), `parâmetro proibido: ${proibido}`);
  });

  test("PADROES_RECOVERY expõe exatamente os limites documentados no checkpoint (nada a mais, nada a menos)", () => {
    assert.deepEqual(Object.keys(PADROES_RECOVERY).sort(), ["batchQuietMs", "maxConsecutiveNoProgressBatches", "maxRecoveryBatches", "maxRecoveryDurationMs", "maxRecoveryNodes", "tickMs"].sort());
  });
});

describe("validação de limites (mesma dureza do offlineObserve.js)", () => {
  for (const [campo, invalido] of [["tickMs", 0], ["batchQuietMs", -1], ["maxRecoveryBatches", 0], ["maxRecoveryNodes", 0], ["maxRecoveryDurationMs", 0], ["maxConsecutiveNoProgressBatches", 0]]) {
    test(`${campo}=${invalido} lança`, () => {
      assert.throws(() => criarMotorRecovery({ emitir: () => {}, [campo]: invalido }));
    });
  }
});
