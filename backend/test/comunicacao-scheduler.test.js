// Scheduler — 100% função pura, sem banco. Determinismo é o ponto central:
// nada aqui usa Math.random() (a distribuição é carga/capacidade, nunca
// "parecer humano" — ver o comentário no topo de comunicacao.scheduler.js).
// Rodar: node --test test/comunicacao-scheduler.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dentroDaJanela, proximoInicioDeJanela, distribuirHorarios } from "../src/modules/comunicacao/comunicacao.scheduler.js";

const JANELAS = {
  seg_sex: { inicio: "08:00", fim: "18:00" },
  sab: { inicio: "08:00", fim: "13:00" },
  dom: null,
};

// Uma quarta-feira (2026-09-16 é quarta) e um domingo (2026-09-20) conhecidos.
const QUA_10H = () => new Date(2026, 8, 16, 10, 0, 0);
const QUA_19H = () => new Date(2026, 8, 16, 19, 0, 0); // depois do fim da janela
const DOM_10H = () => new Date(2026, 8, 20, 10, 0, 0); // domingo — sem expediente
const SAB_14H = () => new Date(2026, 8, 19, 14, 0, 0); // depois do fim do sábado

describe("comunicacao.scheduler — janelas", () => {
  test("dentro do horário comercial de um dia útil", () => {
    assert.equal(dentroDaJanela(QUA_10H(), JANELAS), true);
  });

  test("fora do horário (depois das 18h de um dia útil)", () => {
    assert.equal(dentroDaJanela(QUA_19H(), JANELAS), false);
  });

  test("domingo nunca está dentro da janela", () => {
    assert.equal(dentroDaJanela(DOM_10H(), JANELAS), false);
  });

  test("teste 12 — fora da janela comercial REAGENDA para o próximo início elegível, nunca descarta", () => {
    const proximo = proximoInicioDeJanela(QUA_19H(), JANELAS);
    // próximo dia útil (quinta), 08:00 — nunca null, nunca lança.
    assert.equal(proximo.getDate(), 17);
    assert.equal(proximo.getHours(), 8);
    assert.equal(proximo.getMinutes(), 0);
  });

  test("teste 12 — domingo reagenda para segunda 08:00 (pula o dia sem expediente)", () => {
    const proximo = proximoInicioDeJanela(DOM_10H(), JANELAS);
    assert.equal(proximo.getDay(), 1); // segunda
    assert.equal(proximo.getHours(), 8);
  });

  test("sábado depois do expediente reagenda para segunda (domingo é pulado)", () => {
    const proximo = proximoInicioDeJanela(SAB_14H(), JANELAS);
    assert.equal(proximo.getDay(), 1);
    assert.equal(proximo.getHours(), 8);
  });

  test("janelas todas fechadas lança em vez de travar (proteção contra loop infinito)", () => {
    assert.throws(() => proximoInicioDeJanela(QUA_10H(), { seg_sex: null, sab: null, dom: null }, 5));
  });
});

describe("comunicacao.scheduler — distribuirHorarios (determinístico, sem randomização)", () => {
  test("mesma entrada produz sempre a mesma saída", () => {
    const params = { quantidade: 5, inicio: QUA_10H(), fim: new Date(2026, 8, 16, 12, 0, 0), intervaloMinimoMs: 60_000, janelas: JANELAS };
    const a = distribuirHorarios(params).map((d) => d.getTime());
    const b = distribuirHorarios(params).map((d) => d.getTime());
    assert.deepEqual(a, b);
  });

  test("respeita o intervalo mínimo entre envios consecutivos", () => {
    const horarios = distribuirHorarios({
      quantidade: 4, inicio: QUA_10H(), fim: new Date(2026, 8, 16, 10, 5, 0), // janela bem curta -> intervalo mínimo domina
      intervaloMinimoMs: 3 * 60_000, janelas: JANELAS,
    });
    for (let i = 1; i < horarios.length; i++) {
      const gap = horarios[i].getTime() - horarios[i - 1].getTime();
      assert.ok(gap >= 3 * 60_000, `intervalo ${gap}ms menor que o mínimo`);
    }
  });

  test("quantidade zero devolve lista vazia", () => {
    assert.deepEqual(distribuirHorarios({ quantidade: 0, inicio: QUA_10H(), fim: QUA_10H(), intervaloMinimoMs: 1000, janelas: JANELAS }), []);
  });

  test("item que transborda a janela de hoje reagenda para o próximo dia elegível (nunca some)", () => {
    const inicio = new Date(2026, 8, 16, 17, 58, 0); // faltam 2 min pro fim do expediente de quarta
    const fim = new Date(2026, 8, 16, 18, 0, 0);
    const horarios = distribuirHorarios({ quantidade: 3, inicio, fim, intervaloMinimoMs: 3 * 60_000, janelas: JANELAS });
    assert.equal(horarios.length, 3);
    // o(s) último(s) não cabem mais hoje -> caem no dia seguinte, 08:00.
    const algumTransbordou = horarios.some((h) => h.getDate() !== 16);
    assert.ok(algumTransbordou, "esperava que algum horário transbordasse para o próximo dia");
  });
});
