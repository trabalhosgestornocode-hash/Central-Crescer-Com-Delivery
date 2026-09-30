// Tela "Pedidos iFood": rótulos do status OFICIAL + ligação tela/API. Sem DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rotuloStatusPedido, rotuloTipoPedido, STATUS_PEDIDO_UI } from "../src/ifoodEstado.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const ler = (f) => readFileSync(path.join(SRC, f), "utf8");

test("CONCLUDED -> 'Concluído' (verde)", () => assert.deepEqual(rotuloStatusPedido("CONCLUDED"), { rotulo: "Concluído", classe: "ok" }));
test("CANCELLED -> 'Cancelado' (vermelho)", () => assert.deepEqual(rotuloStatusPedido("CANCELLED"), { rotulo: "Cancelado", classe: "bad" }));
test("DISPATCHED -> 'Despachado'", () => assert.equal(rotuloStatusPedido("DISPATCHED").rotulo, "Despachado"));

test("todos os status oficiais do iFood têm rótulo em português", () => {
  const oficiais = ["PLACED", "CONFIRMED", "SEPARATION_STARTED", "SEPARATION_ENDED", "READY_TO_PICKUP", "DISPATCHED", "CONCLUDED", "CANCELLED"];
  assert.deepEqual(Object.keys(STATUS_PEDIDO_UI).sort(), [...oficiais].sort());
  for (const s of oficiais) assert.notEqual(rotuloStatusPedido(s).rotulo, s);
});

test("sem status / desconhecido: nunca inventa um estado", () => {
  assert.deepEqual(rotuloStatusPedido(null), { rotulo: "Aguardando status", classe: "muted" });
  assert.deepEqual(rotuloStatusPedido("NOVO_DO_IFOOD"), { rotulo: "NOVO_DO_IFOOD", classe: "muted" });
});

test("tipo do pedido: entrega própria x iFood, retirada, ausente", () => {
  assert.equal(rotuloTipoPedido("DELIVERY", "MERCHANT"), "Entrega própria");
  assert.equal(rotuloTipoPedido("DELIVERY", "IFOOD"), "Entrega iFood");
  assert.equal(rotuloTipoPedido("TAKEOUT", null), "Retirada");
  assert.equal(rotuloTipoPedido(null, null), "—");
});

test("api.js: wrapper GET /integracoes/ifood/pedidos (sem merchantId/tenant no front)", () => {
  assert.match(ler("api.js"), /export const ifoodPedidos = \(\) => getJson\(`\$\{IFOOD\}\/pedidos`\)/);
});

test("ifood.js: painel abre a tela, tela usa o rótulo oficial e zera no reset de contexto", () => {
  const s = ler("ifood.js");
  assert.match(s, /id="ifood-abrir-pedidos"/);
  assert.match(s, /api\.ifoodPedidos\(\)/);
  assert.match(s, /rotuloStatusPedido\(p\.status\)/);
  assert.match(s, /estado\.pedidos = null;\s+\/\/ idem/);
  // a tela é só leitura: nenhuma ação de pedido é chamada daqui
  assert.doesNotMatch(s, /confirmarPedido|requestCancellation|readyToPickup|\/dispatch/);
});
