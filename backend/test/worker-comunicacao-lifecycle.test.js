import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  workerEmbutidoHabilitado, iniciarWorkerComunicacaoEmbutido, pararWorkerComunicacaoEmbutido,
} from "../src/worker-comunicacao/lifecycle.js";
import { ESTADOS } from "../src/worker-comunicacao/loop.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const configValida = () => ({ intervalMs: 15, gatewayUrl: "http://gateway.teste", segredoHmac: "segredo-de-teste" });

describe("Checkpoint H.2-B.1 — kill-switch COMUNICACAO_WORKER_ENABLED", () => {
  test("mesmo padrão de MB_PLAYWRIGHT_ENABLED: só a string exata 'true' habilita", () => {
    assert.equal(workerEmbutidoHabilitado({ COMUNICACAO_WORKER_ENABLED: "true" }), true);
    for (const v of [undefined, "", "false", "TRUE", "1", "yes", "on"]) {
      assert.equal(workerEmbutidoHabilitado({ COMUNICACAO_WORKER_ENABLED: v }), false, `"${v}" deveria ser false`);
    }
  });
});

describe("Checkpoint H.2-B.1 — lifecycle embutido (A-G)", () => {
  test("A. ENABLED=false -> worker não inicia e NENHUMA dependência do worker é tocada", async () => {
    let tocou = false;
    const r = await iniciarWorkerComunicacaoEmbutido({
      env: {},
      carregarConfig: () => { tocou = true; },
      criarLoopWorker: () => { tocou = true; },
      modoAtual: () => { tocou = true; },
      executarCiclo: () => { tocou = true; },
    });
    assert.equal(r.habilitado, false);
    assert.equal(r.motivo, "COMUNICACAO_WORKER_ENABLED != true");
    assert.equal(tocou, false);
  });

  test("B. ENABLED=true + modo global DISABLED (mock) -> laço real inicia mas executarCiclo=0", async () => {
    let chamadas = 0;
    const r = await iniciarWorkerComunicacaoEmbutido({
      env: { COMUNICACAO_WORKER_ENABLED: "true" },
      carregarConfig: configValida,
      modoAtual: async () => "DISABLED",
      executarCiclo: async () => { chamadas += 1; return {}; },
      criarWhatsAppService: () => ({}),
      criarBaileysGatewayProvider: () => ({}),
    });
    assert.equal(r.habilitado, true);
    await sleep(60);
    assert.equal(chamadas, 0, "executarCiclo não pode ser chamado com modo=DISABLED");
    assert.equal(r.obterEstado().estado, "DISABLED");
    await pararWorkerComunicacaoEmbutido("TESTE");
  });

  test("C. ENABLED=true + modo NORMAL (mock) -> executarCiclo é chamado", async () => {
    let chamadas = 0;
    const r = await iniciarWorkerComunicacaoEmbutido({
      env: { COMUNICACAO_WORKER_ENABLED: "true" },
      carregarConfig: () => ({ ...configValida(), intervalMs: 5000 }),
      modoAtual: async () => "NORMAL",
      executarCiclo: async () => { chamadas += 1; return { deteccao: {}, agendamento: {}, lote: [] }; },
      criarWhatsAppService: () => ({}),
      criarBaileysGatewayProvider: () => ({}),
    });
    assert.equal(r.habilitado, true);
    await sleep(40);
    assert.ok(chamadas >= 1, "executarCiclo deveria ter sido chamado ao menos 1x");
    await pararWorkerComunicacaoEmbutido("TESTE");
  });

  test("D. pararWorkerComunicacaoEmbutido chama encerrar() do laço ativo, e é idempotente", async () => {
    let encerrarChamadoCom = null;
    const loopFake = {
      iniciar: () => new Promise(() => {}), // nunca resolve dentro da janela do teste
      encerrar: async (sinal) => { encerrarChamadoCom = sinal; },
      obterEstado: () => ({ estado: "IDLE", lastCycleAt: null, lastCycleStatus: null }),
    };
    const r = await iniciarWorkerComunicacaoEmbutido({
      env: { COMUNICACAO_WORKER_ENABLED: "true" },
      carregarConfig: configValida,
      criarLoopWorker: () => loopFake,
      modoAtual: async () => "DISABLED",
      executarCiclo: async () => ({}),
      criarWhatsAppService: () => ({}),
      criarBaileysGatewayProvider: () => ({}),
    });
    assert.equal(r.habilitado, true);

    await pararWorkerComunicacaoEmbutido("SIGTERM");
    assert.equal(encerrarChamadoCom, "SIGTERM");

    encerrarChamadoCom = null;
    await pararWorkerComunicacaoEmbutido("SIGTERM"); // idempotente: não deve chamar de novo nem lançar
    assert.equal(encerrarChamadoCom, null);
  });

  test("pararWorkerComunicacaoEmbutido é no-op seguro quando o worker nunca iniciou", async () => {
    await assert.doesNotReject(() => pararWorkerComunicacaoEmbutido("SIGTERM"));
  });

  test("E. erro dentro de um ciclo não vira rejeição não tratada do processo", async () => {
    let rejeicoesNaoTratadas = 0;
    const handler = () => { rejeicoesNaoTratadas += 1; };
    process.on("unhandledRejection", handler);
    try {
      const r = await iniciarWorkerComunicacaoEmbutido({
        env: { COMUNICACAO_WORKER_ENABLED: "true" },
        carregarConfig: configValida,
        modoAtual: async () => "NORMAL",
        executarCiclo: async () => { throw new Error("falha simulada"); },
        criarWhatsAppService: () => ({}),
        criarBaileysGatewayProvider: () => ({}),
      });
      assert.equal(r.habilitado, true);
      await sleep(60);
      assert.equal(rejeicoesNaoTratadas, 0);
      await pararWorkerComunicacaoEmbutido("TESTE");
    } finally {
      process.removeListener("unhandledRejection", handler);
    }
  });

  test("F. ENABLED=true + config inválida -> worker não inicia, mas iniciarWorkerComunicacaoEmbutido NÃO lança", async () => {
    const r = await iniciarWorkerComunicacaoEmbutido({
      env: { COMUNICACAO_WORKER_ENABLED: "true" },
      carregarConfig: () => { throw new Error("WHATSAPP_GATEWAY_URL ausente — obrigatória"); },
    });
    assert.equal(r.habilitado, false);
    assert.match(r.motivo, /config inválida/);
  });

  test("H.2-B item 2: config inválida com ENABLED=true emite worker_start_failed + workerState=ERROR — NUNCA worker_not_started/reason=worker_disabled", async () => {
    const eventos = [];
    const r = await iniciarWorkerComunicacaoEmbutido({
      env: { COMUNICACAO_WORKER_ENABLED: "true" },
      log: (nivel, evento, dados) => eventos.push({ nivel, evento, dados }),
      carregarConfig: () => { throw new Error("WHATSAPP_GATEWAY_SECRET ausente — obrigatório"); },
    });
    assert.equal(r.habilitado, false);
    assert.equal(r.workerState, ESTADOS.ERROR);
    assert.ok(eventos.some((e) => e.evento === "comunicacao.worker_start_failed" && e.dados.reason === "config_invalida"));
    assert.ok(!eventos.some((e) => e.evento === "comunicacao.worker_not_started"), "config inválida NUNCA pode ser reportada como worker_disabled");
    // a mensagem de erro nomeia a variável, nunca ecoa um valor de segredo
    const evtErro = eventos.find((e) => e.evento === "comunicacao.worker_start_failed");
    assert.match(evtErro.dados.erro, /WHATSAPP_GATEWAY_SECRET/);
  });

  test("flag desligada continua reportando workerState=DISABLED (nunca ERROR)", async () => {
    const r = await iniciarWorkerComunicacaoEmbutido({ env: {} });
    assert.equal(r.workerState, ESTADOS.DISABLED);
  });

  test("G. ENABLED=false: a config específica do worker nunca é avaliada, mesmo que seria inválida", async () => {
    const r = await iniciarWorkerComunicacaoEmbutido({
      env: { COMUNICACAO_WORKER_ENABLED: "false" }, // explícito, não só ausente
      carregarConfig: () => { throw new Error("NUNCA deveria ser chamado com a flag desligada"); },
    });
    assert.equal(r.habilitado, false);
    assert.equal(r.motivo, "COMUNICACAO_WORKER_ENABLED != true");
  });
});
