// Coleta automática de D-1 logo depois da virada do dia em Brasília.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INTERVALO_PADRAO_MS, NOVA_TENTATIVA_MS, criarAgendadorFoody, msAteAVirada, ontemFalhou, proximoAtrasoMs } from "../src/modules/foody/foody.agendador.js";

const MIN = 60_000;
const env = { FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_AGENDADOR_ENABLED: "true", FOODY_CENTRAL_UNIDADES: "aaaaaaaa-0000-4000-8000-000000000001" };

test("a próxima coleta acontece às 00:10 de Brasília", () => {
  assert.equal(msAteAVirada(new Date("2026-11-18T02:50:00Z")), 20 * MIN); // 23:50 de 17/11
  assert.equal(msAteAVirada(new Date("2026-11-18T03:05:00Z")), 5 * MIN); // 00:05 de 18/11
  assert.equal(msAteAVirada(new Date("2026-11-18T03:10:00Z")), 1440 * MIN); // exatamente 00:10: próxima é amanhã
});
test("vale o que vier primeiro: virada, intervalo de 6 horas ou nova tentativa", () => {
  assert.equal(proximoAtrasoMs({ agora: new Date("2026-11-18T02:50:00Z") }), 20 * MIN);
  assert.equal(proximoAtrasoMs({ agora: new Date("2026-11-18T12:00:00Z") }), INTERVALO_PADRAO_MS);
  assert.equal(proximoAtrasoMs({ agora: new Date("2026-11-18T12:00:00Z"), falhouOntem: true }), NOVA_TENTATIVA_MS);
});
test("só falha real da coleta de ontem pede nova tentativa", () => {
  const agora = new Date("2026-11-18T03:10:00Z");
  assert.equal(ontemFalhou([{ competencia: "2026-11-17", erro: "ERRO_INTERNO" }], agora), true);
  assert.equal(ontemFalhou([{ unidadeId: "u", erro: "SEM_CONEXAO" }], agora), true);
  assert.equal(ontemFalhou([{ competencia: "2026-11-16", erro: "ERRO_INTERNO" }], agora), false);
  assert.equal(ontemFalhou([{ competencia: "2026-11-17", erro: "INTERROMPIDO" }, { competencia: "2026-11-17", status: "CONSOLIDADO" }], agora), false);
});
test("agendador: coleta na virada e tenta de novo depois de falhar", async () => {
  const atrasos = [];
  let tique;
  const temporizador = { set: (f, ms) => { tique = f; atrasos.push(ms); return 1; }, clear: () => {} };
  let falhar = true;
  const ag = criarAgendadorFoody({ unidades: [{ organizacaoId: "o", unidadeId: env.FOODY_CENTRAL_UNIDADES }], env, alinharComAVirada: true, atrasoInicialMs: 3 * MIN, temporizador, agora: () => new Date("2026-11-18T12:00:00Z"),
    executar: async () => { if (falhar) throw Object.assign(new Error("x"), { codigo: "REDE" }); return { fechamento: { status: "CONSOLIDADO" } }; } });
  ag.iniciar();
  assert.equal(atrasos.at(-1), 3 * MIN);
  await tique();
  assert.equal(atrasos.at(-1), NOVA_TENTATIVA_MS);
  falhar = false;
  await tique();
  assert.equal(atrasos.at(-1), INTERVALO_PADRAO_MS);
  await ag.parar();
});
