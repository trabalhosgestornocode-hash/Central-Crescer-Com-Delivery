import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarLoopWorker, ESTADOS } from "../src/worker-comunicacao/loop.js";

const MODOS = { DISABLED: "DISABLED", NORMAL: "NORMAL", REACTIVE_ONLY: "REACTIVE_ONLY" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function contadorDeChamadas(fn) {
  const chamado = { n: 0 };
  const wrapped = (...args) => { chamado.n += 1; return fn(...args); };
  return { wrapped, chamado };
}

describe("Checkpoint H.2-A — laço do worker de comunicação", () => {
  test("modo=DISABLED: executarCiclo() NUNCA é chamado, mesmo em vários ticks", async () => {
    const eventos = [];
    const { wrapped: executarCiclo, chamado } = contadorDeChamadas(async () => ({}));
    const loop = criarLoopWorker({
      executarCiclo,
      modoAtual: async () => MODOS.DISABLED,
      whatsAppService: { enviarTexto: async () => { throw new Error("NUNCA deveria ser chamado"); } },
      intervalMs: 15,
      log: (nivel, evento, dados) => eventos.push({ nivel, evento, dados }),
    });

    loop.iniciar();
    await sleep(70); // tempo suficiente para vários ticks de 15ms
    await loop.encerrar("TESTE");

    assert.equal(chamado.n, 0, "executarCiclo deveria ter 0 chamadas com modo=DISABLED");
    assert.ok(eventos.some((e) => e.evento === "comunicacao.cycle_skipped" && e.dados.reason === "global_disabled"));
    assert.ok(!eventos.some((e) => e.evento === "comunicacao.cycle_completed" && e.dados.status === "completed"));
    assert.equal(loop.obterEstado().lastCycleStatus, "skipped");
  });

  test("modo=NORMAL: um tick chama executarCiclo() exatamente 1x e nunca toca o provider diretamente", async () => {
    const { wrapped: executarCiclo, chamado } = contadorDeChamadas(async () => ({ deteccao: {}, agendamento: {}, lote: [] }));
    let providerChamado = false;
    const whatsAppService = { enviarTexto: async () => { providerChamado = true; } };
    const loop = criarLoopWorker({
      executarCiclo, modoAtual: async () => MODOS.NORMAL, whatsAppService,
      intervalMs: 5000, // bem maior que a janela do teste — só 1 tick deve rodar
    });

    loop.iniciar();
    await sleep(40);
    await loop.encerrar("TESTE");

    assert.equal(chamado.n, 1);
    assert.equal(providerChamado, false, "o laço nunca deve chamar whatsAppService diretamente");
  });

  test("sem sobreposição: um ciclo lento nunca roda concorrente com outro", async () => {
    let emVoo = 0;
    let maxConcorrencia = 0;
    const executarCiclo = async () => {
      emVoo += 1;
      maxConcorrencia = Math.max(maxConcorrencia, emVoo);
      await sleep(80); // mais lento que o intervalo do laço
      emVoo -= 1;
      return { deteccao: {}, agendamento: {}, lote: [] };
    };
    const loop = criarLoopWorker({
      executarCiclo, modoAtual: async () => MODOS.NORMAL, whatsAppService: {}, intervalMs: 10,
    });

    loop.iniciar();
    await sleep(220);
    await loop.encerrar("TESTE");

    assert.equal(maxConcorrencia, 1, "nunca deve haver mais de 1 executarCiclo() em voo na mesma instância");
  });

  test("ciclo com erro: loga cycle_failed e o worker continua vivo para o próximo tick", async () => {
    const eventos = [];
    let chamada = 0;
    const executarCiclo = async () => {
      chamada += 1;
      if (chamada === 1) throw new Error("falha simulada");
      return { deteccao: {}, agendamento: {}, lote: [] };
    };
    const loop = criarLoopWorker({
      executarCiclo, modoAtual: async () => MODOS.NORMAL, whatsAppService: {}, intervalMs: 15,
      log: (nivel, evento, dados) => eventos.push({ nivel, evento, dados }),
    });

    loop.iniciar();
    await sleep(70); // tempo para pelo menos 2 ticks
    await loop.encerrar("TESTE");

    assert.ok(chamada >= 2, "o worker deve continuar chamando executarCiclo após uma falha");
    assert.ok(eventos.some((e) => e.evento === "comunicacao.cycle_failed"));
    assert.ok(eventos.some((e) => e.evento === "comunicacao.cycle_completed" && e.dados.status === "completed"));
  });

  test("shutdown durante o sleep: acorda imediatamente, não espera o intervalo e não inicia ciclo novo", async () => {
    const { wrapped: executarCiclo, chamado } = contadorDeChamadas(async () => ({ deteccao: {}, agendamento: {}, lote: [] }));
    const loop = criarLoopWorker({
      executarCiclo, modoAtual: async () => MODOS.NORMAL, whatsAppService: {}, intervalMs: 5000, // bem longo
    });

    loop.iniciar();
    await sleep(30); // deixa o primeiro tick terminar e o laço entrar em sleep(5000)
    assert.equal(chamado.n, 1);

    const inicio = Date.now();
    await loop.encerrar("TESTE");
    const duracao = Date.now() - inicio;

    assert.ok(duracao < 1000, `encerrar() deveria ser quase instantâneo durante o sleep, levou ${duracao}ms`);
    assert.equal(chamado.n, 1, "nenhum ciclo novo deveria ter iniciado após o sinal de encerramento");
  });

  test("shutdown durante um ciclo em voo: espera o término natural (grace period) e não inicia outro", async () => {
    const { wrapped: executarCiclo, chamado } = contadorDeChamadas(async () => {
      await sleep(80);
      return { deteccao: {}, agendamento: {}, lote: [] };
    });
    const loop = criarLoopWorker({
      executarCiclo, modoAtual: async () => MODOS.NORMAL, whatsAppService: {}, intervalMs: 10, gracePeriodMs: 2000,
    });

    loop.iniciar();
    await sleep(20); // ainda dentro do ciclo de 80ms
    const inicio = Date.now();
    await loop.encerrar("TESTE");
    const duracao = Date.now() - inicio;

    assert.ok(duracao >= 50, `deveria ter esperado o ciclo em voo terminar naturalmente, levou só ${duracao}ms`);
    assert.equal(chamado.n, 1, "nenhum segundo ciclo deveria ter iniciado depois do sinal de encerramento");
    assert.equal(loop.obterEstado().lastCycleStatus, "completed");
  });

  test("estado exposto por obterEstado() nunca fica em BOOTING depois de iniciar()", async () => {
    const loop = criarLoopWorker({
      executarCiclo: async () => ({ deteccao: {}, agendamento: {}, lote: [] }),
      modoAtual: async () => MODOS.DISABLED, whatsAppService: {}, intervalMs: 5000,
    });
    assert.equal(loop.obterEstado().estado, ESTADOS.BOOTING);
    loop.iniciar();
    await sleep(20);
    assert.notEqual(loop.obterEstado().estado, ESTADOS.BOOTING);
    await loop.encerrar("TESTE");
  });
});
