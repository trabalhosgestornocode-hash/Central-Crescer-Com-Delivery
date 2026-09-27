// CHECKPOINT C — validação técnica real do Order Details com o Teste (C) (centralizado).
//
//   npm run ifood:order-check -- --order <orderId>
//
// "VALIDAÇÃO TÉCNICA CENTRALIZADA" — NÃO é homologação.
//
// SOMENTE LEITURA e SEM BANCO: token client_credentials -> GET /merchants (exige 1 loja) ->
// GET /order/v1.0/orders/{id} -> parser. NÃO faz confirm, NÃO envia ACK, NÃO grava nada.
// Imprime só a ESTRUTURA do pedido (tipos, contagens, totais, avisos). Nunca imprime segredo, token,
// nem dados pessoais (nome, telefone, documento, endereço).
import { validarAmbienteCentralizadoTesteIfood, provarChavesNoProjetoTeste } from "./ifoodHomologGuard.mjs";

const arg = (nome) => { const i = process.argv.indexOf(nome); return i >= 0 ? process.argv[i + 1] : null; };
const orderId = arg("--order");
const falhar = (titulo, itens = []) => {
  console.error(`\n✖ ${titulo}`);
  for (const i of itens) console.error("  - " + i);
  process.exit(1);
};
if (!orderId) falhar("Informe o pedido:  npm run ifood:order-check -- --order <orderId>");

const r = validarAmbienteCentralizadoTesteIfood(process.env);
if (!r.ok) falhar("AMBIENTE RECUSADO (trava)", r.erros);
const prova = await provarChavesNoProjetoTeste(process.env, r.provaAtivaNecessaria);
if (prova.length) falhar("CHAVES SUPABASE NÃO COMPROVADAS COMO DE TESTE", prova);
console.log(`✔ trava de ambiente: Supabase de TESTE (${r.resumo.supabaseRef}), fora do Render, sem apps reais. (este script não usa o banco)`);

const httpClient = await import("../src/modules/ifood/ifoodHttp.client.js");
const merchantService = await import("../src/modules/ifood/ifoodMerchant.service.js");
const tokenService = await import("../src/modules/ifood/ifoodToken.service.js");
const orderClient = await import("../src/modules/ifood/ifoodOrder.client.js");
const { interpretarPedido } = await import("../src/modules/ifood/ifoodOrder.parser.js");
const { IFOOD_APP_ORDER } = await import("../src/modules/ifood/ifood.constants.js");
const { mascararId } = await import("../src/modules/ifood/ifood.logsafe.js");

console.log(`✔ modo de autenticação: ${tokenService.modoDeAutenticacao()} (escopo do token: ${tokenService.escopoDoToken()})`);

let lojas;
try {
  lojas = await merchantService.listarMerchantsAutorizados({ organizacaoId: null, unidadeId: null, deps: { http: httpClient } });
} catch (e) {
  falhar(`FALHA NA DESCOBERTA DE MERCHANTS [${e?.codigo ?? e?.name}]`, [e?.message ?? String(e)]);
}
if (lojas.total !== 1) falhar(`ESPERAVA EXATAMENTE 1 LOJA e vieram ${lojas.total} — PARANDO`, lojas.merchants.map((m) => `${m.nome ?? "(sem nome)"} | ${m.id}`));
const loja = lojas.merchants[0];
console.log(`✔ loja sandbox: ${loja.nome ?? "(sem nome)"} | id ${mascararId(loja.id)}`);

let bruto;
try {
  bruto = await tokenService.comAccessTokenValido({
    conexaoId: null, appType: IFOOD_APP_ORDER, deps: { http: httpClient },
    fn: (accessToken) => orderClient.buscarDetalhesPedido({ accessToken, orderId, http: httpClient }),
  });
} catch (e) {
  falhar(`GET DETALHES FALHOU [${e?.codigo ?? e?.name}] HTTP ${e?.statusCode ?? "?"}`, [e?.message ?? String(e), JSON.stringify(e?.details ?? {})]);
}
console.log(`✔ GET /order/v1.0/orders/${mascararId(orderId)} -> HTTP 200`);

const p = interpretarPedido(bruto, { orderIdEsperado: orderId, merchantIdEsperado: loja.id });
if (!p.valido) falhar("PARSER REJEITOU O PAYLOAD", [p.motivo]);
const x = p.pedido;

const tipo = (v) => (Array.isArray(v) ? `lista(${v.length})` : v === null || v === undefined ? "ausente" : typeof v);
console.log("\n— estrutura do payload bruto (chaves de 1º nível -> tipo)");
console.log(Object.entries(bruto).map(([k, v]) => `  ${k}: ${tipo(v)}`).join("\n"));

console.log("\n— campos operacionais extraídos (sem dados pessoais)");
const linhas = {
  display_id: x.display_id, order_type: x.order_type, order_timing: x.order_timing, category: x.category, sales_channel: x.sales_channel,
  is_test: x.is_test, order_created_at: x.order_created_at, delivery_by: x.delivery_by, "pickup_code presente": x.pickup_code !== null,
  items_count: x.items_count,
  "total_opcoes_nos_itens": (x.items ?? []).reduce((n, it) => n + (Array.isArray(it.options) ? it.options.length : 0), 0),
  "itens_com_observacao": (x.items ?? []).filter((it) => it.observations).length,
  payment_methods: x.payment_methods.join(",") || "(nenhum)", card_brands: x.card_brands.join(",") || "(nenhuma)", cash_change_for: x.cash_change_for,
  total_order_amount: x.total_order_amount, total_benefits: x.total_benefits, discount_sponsors: JSON.stringify(x.discount_sponsors),
  "documento fiscal presente": x.customer_document_number !== null,
  "tem customer/delivery/payments": [x.customer !== null, x.delivery !== null, x.payments !== null].join("/"),
};
for (const [k, v] of Object.entries(linhas)) console.log(`  ${k}: ${v}`);
console.log(`\navisos do parser: ${p.avisos.length ? p.avisos.join(" | ") : "(nenhum)"}`);
console.log(`payload_hash: ${p.payloadHash.slice(0, 16)}… (sha256 do payload bruto)`);
console.log("\nNADA foi gravado, confirmado ou reconhecido. (somente leitura)");
