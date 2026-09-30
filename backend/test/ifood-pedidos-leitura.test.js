// Tela "Pedidos iFood" — GET /integracoes/ifood/pedidos. Só leitura do banco local:
//   * DTO por lista POSITIVA de campos (nenhum dado pessoal sai: cliente, documento, endereço, itens, pagamentos);
//   * sempre do tenant do Context Token (organização + unidade);
//   * o status é o OFICIAL (status_oficial, vindo dos eventos) — nada é derivado de action_state/HTTP;
//   * não importa client HTTP, token nem ações do iFood (não há como a tela chamar o iFood).
// Sem banco e sem rede.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { paraPedidoDaLista, listarPedidos, LIMITE_PEDIDOS_LISTA } = await import("../src/modules/ifood/ifoodPedidosLeitura.service.js");
const { COLUNAS_LISTA_PEDIDOS } = await import("../src/modules/ifood/ifoodOrder.repository.js");

const LINHA = {
  id: "uuid-interno", order_id: "4d9a31ca-2707-450c-a8fe-e09ed563f1bb", merchant_id: "merchant-1",
  organizacao_id: "org-1", unidade_id: "uni-1", display_id: "4094",
  status_oficial: "CONCLUDED", status_oficial_em: "2026-09-30T07:53:56.086Z", status_oficial_evento_id: "ev-1",
  order_type: "DELIVERY", delivery_by: "MERCHANT", sales_channel: "IFOOD", is_test: true,
  order_created_at: "2026-09-30T07:34:29.000Z", criado_em: "2026-09-30T07:35:00.000Z",
  total_order_amount: "59.90", action_state: "none", action_uncertain: false,
  // dados pessoais / operacionais que NUNCA podem ir para a tela:
  customer: { name: "Fulano", phone: { number: "0800" } }, customer_document_number: "00000000000",
  delivery: { deliveryAddress: { streetName: "Rua X", streetNumber: "1" } }, items: [{ name: "Item" }],
  payments: { methods: [] }, details_payload: { tudo: true }, pickup_code: "6305",
};

test("DTO: só os campos da lista, status oficial e tipos normalizados", () => {
  assert.deepEqual(paraPedidoDaLista(LINHA), {
    orderId: "4d9a31ca-2707-450c-a8fe-e09ed563f1bb", displayId: "4094",
    status: "CONCLUDED", statusEm: "2026-09-30T07:53:56.086Z",
    tipo: "DELIVERY", entregaPor: "MERCHANT", canal: "IFOOD", isTest: true,
    criadoEm: "2026-09-30T07:34:29.000Z", total: 59.9, acaoPendente: false, acaoIncerta: false,
  });
});

test("DTO: nenhum dado pessoal, endereço, item, pagamento, payload bruto nem ids internos", () => {
  const s = JSON.stringify(paraPedidoDaLista(LINHA));
  for (const proibido of ["Fulano", "0800", "00000000000", "Rua X", "Item", "details", "pickup", "6305", "merchant-1", "org-1", "uni-1", "uuid-interno", "ev-1"]) {
    assert.ok(!s.includes(proibido), `vazou ${proibido}`);
  }
});

test("DTO: ausências viram null (nunca zero/'none' inventado); criadoEm cai para criado_em", () => {
  const d = paraPedidoDaLista({ order_id: "o1", criado_em: "2026-09-30T00:00:00Z" });
  assert.equal(d.status, null);
  assert.equal(d.total, null);
  assert.equal(d.displayId, null);
  assert.equal(d.isTest, false);
  assert.equal(d.acaoPendente, false);
  assert.equal(d.criadoEm, "2026-09-30T00:00:00Z");
});

test("DTO: action_state em andamento aparece só como sinalização — o status continua o oficial", () => {
  const d = paraPedidoDaLista({ ...LINHA, status_oficial: "CONFIRMED", action_state: "cancel_requested", action_uncertain: true });
  assert.equal(d.status, "CONFIRMED");
  assert.equal(d.acaoPendente, true);
  assert.equal(d.acaoIncerta, true);
});

test("listarPedidos: consulta SÓ o tenant informado, com o limite padrão, e mapeia pelo DTO", async () => {
  const chamadas = [];
  const repo = { async listarPedidosDoTenant(a) { chamadas.push(a); return [LINHA]; } };
  const r = await listarPedidos({ organizacaoId: "org-1", unidadeId: "uni-1", repo });
  assert.deepEqual(chamadas, [{ organizacaoId: "org-1", unidadeId: "uni-1", limite: LIMITE_PEDIDOS_LISTA }]);
  assert.equal(r.pedidos.length, 1);
  assert.equal(r.pedidos[0].status, "CONCLUDED");
  assert.ok(!("customer" in r.pedidos[0]));
});

test("listarPedidos: repositório sem linhas -> lista vazia", async () => {
  const r = await listarPedidos({ organizacaoId: "o", unidadeId: "u", repo: { async listarPedidosDoTenant() { return null; } } });
  assert.deepEqual(r.pedidos, []);
});

test("repositório: a lista NÃO seleciona colunas de dado pessoal/payload (nem '*') e filtra pelo tenant", () => {
  const cols = COLUNAS_LISTA_PEDIDOS.split(",").map((c) => c.trim());
  assert.ok(!cols.includes("*"));
  for (const c of ["customer", "customer_document_number", "customer_document_type", "delivery", "items", "payments", "details_payload", "pickup_code", "extra_info", "delivery_observations"]) {
    assert.ok(!cols.includes(c), `coluna proibida na lista: ${c}`);
  }
  const src = readFileSync(new URL("../src/modules/ifood/ifoodOrder.repository.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function listarPedidosDoTenant"));
  const corpo = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(corpo, /\.eq\("organizacao_id", organizacaoId\)\.eq\("unidade_id", unidadeId\)/, "filtra pelo tenant");
  assert.match(corpo, /\.limit\(limite\)/);
});

test("o service da tela não tem como chamar o iFood (sem client HTTP, token ou ações de pedido)", () => {
  const src = readFileSync(new URL("../src/modules/ifood/ifoodPedidosLeitura.service.js", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /ifoodHttp\.client|ifoodToken\.service|ifoodOrderActions|ifoodOrder\.client|ifoodOrder\.service|fetch\(|postJson|setInterval/);
});

test("rota: GET /pedidos com integracoes.ver (leitura)", () => {
  const src = readFileSync(new URL("../src/modules/ifood/ifood.routes.js", import.meta.url), "utf8");
  assert.match(src, /ifoodRouter\.get\("\/pedidos", requirePermissao\(PERMISSOES\.INTEGRACOES_VER\), controller\.pedidos\)/);
});
