// Checkpoint G.0.1 (Partes D-J) — fila de concorrência limitada (src/filaConcorrenciaLimitada.js).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { criarFilaConcorrenciaLimitada } from "../src/filaConcorrenciaLimitada.js";

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

describe("validação", () => {
  // `undefined` explícito não entra aqui: destructuring com default trata `{concorrencia: undefined}` como
  // "omitido" (vira 4) por semântica da própria linguagem — não é uma entrada inválida a rejeitar.
  for (const invalido of [0, -1, 1.5, "4", null, NaN]) {
    test(`concorrencia=${JSON.stringify(invalido)} lança`, () => {
      assert.throws(() => criarFilaConcorrenciaLimitada({ concorrencia: invalido }), RangeError);
    });
  }
  test("concorrencia omitida (ou undefined) usa o default (4), não lança", () => {
    assert.doesNotThrow(() => criarFilaConcorrenciaLimitada());
    assert.doesNotThrow(() => criarFilaConcorrenciaLimitada({ concorrencia: undefined }));
    assert.equal(criarFilaConcorrenciaLimitada().metricas().concorrencia, 4);
  });
});

describe("Parte I — burst: a concorrência NUNCA passa do limite, mesmo com centenas/milhares de tarefas", () => {
  for (const concorrencia of [1, 2, 4, 8]) {
    for (const n of [100, 500, 1000]) {
      test(`concorrencia=${concorrencia}, ${n} tarefas rápidas: pico <= ${concorrencia}, todas concluem`, async () => {
        const fila = criarFilaConcorrenciaLimitada({ concorrencia });
        let simultaneas = 0; let picoObservado = 0;
        const promessas = [];
        for (let i = 0; i < n; i++) {
          promessas.push(fila.enfileirar(async () => {
            simultaneas++; picoObservado = Math.max(picoObservado, simultaneas);
            await Promise.resolve(); // cede o microtask, mas nada de I/O real (teste RÁPIDO)
            simultaneas--;
            return i;
          }));
        }
        const resultados = await Promise.all(promessas);
        assert.ok(picoObservado <= concorrencia, `pico observado ${picoObservado} > limite ${concorrencia}`);
        assert.equal(resultados.length, n);
        assert.deepEqual(fila.metricas().picoConcorrencia <= concorrencia, true);
        assert.equal(fila.metricas().concluidas, n);
        assert.equal(fila.metricas().ativos, 0, "nenhuma pendente ao final");
      });
    }
  }
});

describe("Parte F — backend falso: rápido, lento e intermitente, em várias concorrências", () => {
  function backendLento(ms) { return async () => { await espera(ms); return "ok"; }; }
  function backendIntermitente(falhaA_cada) {
    let n = 0;
    // `meuN` é capturado ANTES do `await`: com concorrência > 1 várias chamadas ficam "em voo" ao mesmo tempo
    // compartilhando `n` — reler `n` DEPOIS do await (em vez do valor que esta própria chamada recebeu) faria
    // chamadas concorrentes se confundirem sobre qual delas é "a 5ª", inflando a contagem de falhas.
    return async () => { const meuN = ++n; await espera(1); if (meuN % falhaA_cada === 0) throw new Error("falha simulada"); return "ok"; };
  }

  for (const concorrencia of [1, 2, 4, 8]) {
    test(`concorrencia=${concorrencia}: backend LENTO (20ms) — tempo total cai conforme a concorrência sobe`, async () => {
      const fila = criarFilaConcorrenciaLimitada({ concorrencia });
      const N = 20;
      const t0 = Date.now();
      await Promise.all(Array.from({ length: N }, () => fila.enfileirar(backendLento(20))));
      const duracaoMs = Date.now() - t0;
      // Com N tarefas de 20ms e `concorrencia` workers: tempo mínimo teórico ~= ceil(N/concorrencia)*20ms.
      const minimoTeorico = Math.ceil(N / concorrencia) * 20;
      assert.ok(duracaoMs >= minimoTeorico - 15, `rápido demais? ${duracaoMs}ms < ${minimoTeorico}ms (não deveria ultrapassar a concorrência)`);
      assert.equal(fila.metricas().picoConcorrencia, Math.min(concorrencia, N));
    });

    test(`concorrencia=${concorrencia}: backend INTERMITENTE — falhas isoladas nunca derrubam as outras`, async () => {
      const fila = criarFilaConcorrenciaLimitada({ concorrencia });
      const N = 40;
      const backend = backendIntermitente(5); // UMA closure compartilhada — é o contador dela que produz 1 falha a cada 5 chamadas
      const resultados = await Promise.allSettled(Array.from({ length: N }, () => fila.enfileirar(backend)));
      const falhas = resultados.filter((r) => r.status === "rejected").length;
      const sucessos = resultados.filter((r) => r.status === "fulfilled").length;
      assert.equal(falhas, Math.floor(N / 5));
      assert.equal(sucessos, N - falhas);
      assert.equal(fila.metricas().falhas, falhas);
      assert.equal(fila.metricas().concluidas, N);
    });
  }

  test("uma tarefa SÍNCRONA que lança nunca escapa (nunca derruba o processo nem trava a fila)", async () => {
    const fila = criarFilaConcorrenciaLimitada({ concorrencia: 2 });
    const p1 = fila.enfileirar(() => { throw new Error("sync boom"); });
    const p2 = fila.enfileirar(async () => "ok");
    await assert.rejects(p1, /sync boom/);
    assert.equal(await p2, "ok");
  });
});

describe("Parte J — prioridade LIVE > normal: uma tarefa de alta prioridade entra pela FRENTE da fila", () => {
  test("com concorrência=1 e um backlog 'normal' enfileirado primeiro, uma tarefa 'alta' inserida DEPOIS ainda roda ANTES da maior parte do backlog", async () => {
    const fila = criarFilaConcorrenciaLimitada({ concorrencia: 1 });
    const ordem = [];
    // ocupa o único worker imediatamente para dar tempo de enfileirar o backlog ANTES de qualquer um rodar
    const ocupando = fila.enfileirar(async () => { await espera(30); ordem.push("ocupante"); });
    const normais = Array.from({ length: 20 }, (_, i) => fila.enfileirar(async () => { ordem.push(`normal${i}`); }, { prioridade: "normal" }));
    const alta = fila.enfileirar(async () => { ordem.push("LIVE"); }, { prioridade: "alta" });
    await Promise.all([ocupando, ...normais, alta]);
    const posicaoLive = ordem.indexOf("LIVE");
    assert.equal(ordem[0], "ocupante", "a tarefa já em execução não é preemptada (não dá para pausar um fetch em voo)");
    assert.equal(posicaoLive, 1, "LIVE roda logo depois da ocupante, ANTES de todo o backlog normal enfileirado antes dela");
  });

  test("várias tarefas 'alta' entre si preservam a ordem de chegada (FIFO dentro da mesma prioridade)", async () => {
    const fila = criarFilaConcorrenciaLimitada({ concorrencia: 1 });
    const ordem = [];
    const ocupando = fila.enfileirar(async () => { await espera(10); });
    const tarefas = ["a", "b", "c"].map((id) => fila.enfileirar(async () => { ordem.push(id); }, { prioridade: "alta" }));
    await Promise.all([ocupando, ...tarefas]);
    assert.deepEqual(ordem, ["a", "b", "c"]);
  });

  test("prioridade desconhecida cai em 'normal' (fail-safe, nunca lança)", async () => {
    const fila = criarFilaConcorrenciaLimitada({ concorrencia: 1 });
    await assert.doesNotReject(fila.enfileirar(async () => "ok", { prioridade: "urgentissima" }));
  });
});

describe("métricas: só números, nunca conteúdo das tarefas", () => {
  test("metricas() reflete enfileiradas/concluidas/falhas/pico ao longo do tempo", async () => {
    const fila = criarFilaConcorrenciaLimitada({ concorrencia: 3 });
    assert.deepEqual(fila.metricas(), { concorrencia: 3, ativos: 0, pendentesAlta: 0, pendentesNormal: 0, enfileiradas: 0, concluidas: 0, falhas: 0, picoConcorrencia: 0 });
    await Promise.allSettled([
      fila.enfileirar(async () => "ok"),
      fila.enfileirar(async () => { throw new Error("x"); }),
    ]);
    const m = fila.metricas();
    assert.equal(m.enfileiradas, 2); assert.equal(m.concluidas, 2); assert.equal(m.falhas, 1); assert.equal(m.ativos, 0);
  });
});
