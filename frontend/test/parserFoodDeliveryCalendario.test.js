import { test } from "node:test";
import assert from "node:assert/strict";
import { selecionarDia, estadoDia, mesHtml } from "../src/parserFoodDeliveryCalendario.js";

test("dois cliques no mesmo dia completam um período de um dia", () => {
  const inicio = selecionarDia({}, "2026-09-01");
  assert.deepEqual(inicio, { ini: "2026-09-01", fim: null });
  assert.deepEqual(selecionarDia(inicio, "2026-09-01"), { ini: "2026-09-01", fim: "2026-09-01" });
});
test("intervalo inclusivo e seleção invertida", () => {
  const inicio = selecionarDia({}, "2026-09-05");
  assert.deepEqual(selecionarDia(inicio, "2026-09-01"), { ini: "2026-09-01", fim: "2026-09-05" });
});
test("seleção concluída permite iniciar outro período", () => {
  assert.deepEqual(selecionarDia({ ini: "2026-09-01", fim: "2026-09-05" }, "2026-08-01"), { ini: "2026-08-01", fim: null });
});
test("estados visuais distintos para extremos, intermediários e dia único", () => {
  const periodo = { ini: "2026-09-01", fim: "2026-09-05" };
  assert.equal(estadoDia("2026-09-01", periodo), "inicio");
  assert.equal(estadoDia("2026-09-03", periodo), "intervalo");
  assert.equal(estadoDia("2026-09-05", periodo), "fim");
  assert.equal(estadoDia("2026-09-06", periodo), "");
  assert.equal(estadoDia("2026-09-01", { ini: "2026-09-01", fim: "2026-09-01" }), "unico");
});
test("meses antigos e fevereiro bissexto renderizam os dias corretos", () => {
  const html = mesHtml("2024-02", {});
  assert.match(html, /data-dia="2024-02-29"/);
  assert.doesNotMatch(html, /data-dia="2024-02-30"/);
  assert.equal((mesHtml("2001-01", {}).match(/data-dia=/g) || []).length, 31);
});
