// Events do iFood — parser, catálogo, cliente HTTP (polling/ACK) e regra de transição.
// Sem rede e sem banco. Endpoints/métodos/payloads conferidos no portal oficial
// (Events > Polling de eventos e Eventos de pedido, 2026-09-27).
//
// Rodar: node --experimental-vm-modules --test test/ifood-events-parser-client.test.js
import test from "node:test";
import assert from "node:assert/strict";

import {
  CATALOGO_EVENTOS, STATUS_PEDIDO, classificarCodigo, normalizarEvento, hashDoPayload, ordenarPorCriacao,
} from "../src/modules/ifood/ifoodEvents.parser.js";
import {
  buscarEventos, confirmarEventos, dividirEmLotesDeAck, dividirMerchantsEmLotes,
} from "../src/modules/ifood/ifoodEvents.client.js";
import { decidirTransicao } from "../src/modules/ifood/ifoodEvents.service.js";
import * as httpClient from "../src/modules/ifood/ifoodHttp.client.js";
import { IFOOD_ROTAS, IFOOD_EVENTS } from "../src/modules/ifood/ifood.constants.js";
import { IFOOD_ERROS, IfoodError } from "../src/modules/ifood/ifood.errors.js";
import { ev, t } from "./helpers/ifood-events-fakes.js";

const rejeita = (p, codigo) => assert.rejects(p, (e) => e instanceof IfoodError && e.codigo === codigo, `esperava ${codigo}`);

// ---------------------------------------------------------------------------
// Parser / catálogo
// ---------------------------------------------------------------------------
test("normalizarEvento: evento oficial válido vira a forma normalizada, com payload bruto e hash sha256", () => {
  const raw = ev("evt-1", "PLC", { min: 1 });
  const r = normalizarEvento(raw);
  assert.equal(r.valido, true);
  const e = r.evento;
  assert.equal(e.eventId, "evt-1");
  assert.equal(e.code, "PLC");
  assert.equal(e.fullCode, "PLACED");
  assert.equal(e.orderId, "order-1");
  assert.equal(e.createdAt, t(1));
  assert.equal(e.salesChannel, "IFOOD");
  assert.deepEqual(e.payload, raw, "payload bruto preservado inteiro");
  assert.match(e.payloadHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(e.classificacao, { conhecido: true, grupo: "ORDER_STATUS", status: "PLACED" });
});

test("normalizarEvento: sem id não pode ser reconhecido -> inválido (nunca inventa id); não-objeto também", () => {
  assert.equal(normalizarEvento({ code: "PLC" }).valido, false);
  assert.equal(normalizarEvento({ id: "  ", code: "PLC" }).valido, false);
  for (const lixo of [null, undefined, "x", 42, [], [{ id: "a" }]]) assert.equal(normalizarEvento(lixo).valido, false);
});

test("hash do payload é estável (independe da ordem das chaves) e muda com o conteúdo", () => {
  const a = hashDoPayload({ id: "1", metadata: { x: 1, y: [1, 2] }, code: "PLC" });
  const b = hashDoPayload({ code: "PLC", metadata: { y: [1, 2], x: 1 }, id: "1" });
  assert.equal(a, b);
  assert.notEqual(a, hashDoPayload({ id: "1", metadata: { x: 2, y: [1, 2] }, code: "PLC" }));
});

test("código fora do catálogo NÃO é erro: fica marcado como desconhecido; campos ausentes ganham 'UNKNOWN'", () => {
  const r = normalizarEvento({ id: "e", code: "ZZZ", fullCode: "ALGO_NOVO", orderId: "o", merchantId: "m", createdAt: t(0) });
  assert.equal(r.valido, true);
  assert.equal(r.evento.classificacao.conhecido, false);
  const sem = normalizarEvento({ id: "e2" }).evento;
  assert.equal(sem.code, "UNKNOWN");
  assert.equal(sem.merchantId, "UNKNOWN");
  assert.equal(sem.orderId, null);
});

test("createdAt inválido vira null (não derruba o lote)", () => {
  assert.equal(normalizarEvento({ id: "e", code: "PLC", createdAt: "ontem" }).evento.createdAt, null);
  assert.equal(normalizarEvento({ id: "e", code: "PLC" }).evento.createdAt, null);
});

test("ordenarPorCriacao: ordena por createdAt, é estável e põe 'sem data' primeiro", () => {
  const e = (id, createdAt) => ({ eventId: id, createdAt });
  const r = ordenarPorCriacao([e("c", t(3)), e("a", t(1)), e("sem", null), e("b", t(1)), e("d", t(2))]);
  assert.deepEqual(r.map((x) => x.eventId), ["sem", "a", "b", "d", "c"]);
});

test("catálogo: todos os códigos da documentação oficial existem e só ORDER_STATUS tem estado", () => {
  const docs = ["PLC", "CFM", "SPS", "SPE", "RTP", "DSP", "CON", "CAN", "CAR", "CARF", "HSD", "HSS",
    "ADR", "GTO", "AAO", "DDD", "CLT", "AAD", "DRGO", "DRDO", "DCR", "DDCR", "DDCS", "DRCR", "DPCR", "DPCS",
    "DAR", "DAU", "DAA", "DAD", "DGA", "DGD", "DGAC", "DGDC", "DGU", "RDR", "RDS", "RDF", "DCRA", "DCRR", "RTS",
    "OPA", "RPS", "PRS", "CPR", "CPT", "BOA", "RFI"];
  for (const c of docs) assert.ok(CATALOGO_EVENTOS[c], `falta ${c}`);
  const comEstado = Object.entries(CATALOGO_EVENTOS).filter(([, v]) => v.status).map(([k]) => k).sort();
  assert.deepEqual(comEstado, ["CAN", "CFM", "CON", "DSP", "PLC", "RTP", "SPE", "SPS"]);
  for (const v of Object.values(CATALOGO_EVENTOS)) if (v.status) assert.equal(v.grupo, "ORDER_STATUS");
  assert.equal(classificarCodigo("HSD").grupo, "ORDER_HANDSHAKE");
  assert.equal(classificarCodigo("CAR").grupo, "CANCELLATION_REQUEST");
  assert.equal(classificarCodigo("nao-existe").conhecido, false);
});

// ---------------------------------------------------------------------------
// Regra de transição do estado oficial (pura)
// ---------------------------------------------------------------------------
const ped = (status, min) => ({ status_oficial: status, status_oficial_em: min == null ? null : t(min) });
const evt = (status, min) => ({ status, createdAt: min == null ? null : t(min) });

test("decidirTransicao: sem estado -> aplica; avanço normal -> aplica", () => {
  assert.equal(decidirTransicao(ped(null, null), evt("PLACED", 0)).aplicar, true);
  assert.equal(decidirTransicao(ped("PLACED", 0), evt("CONFIRMED", 1)).aplicar, true);
  assert.equal(decidirTransicao(ped("CONFIRMED", 1), evt("READY_TO_PICKUP", 2)).aplicar, true);
});

test("decidirTransicao: PLACED repetido (id novo, horário POSTERIOR) NÃO desfaz um pedido já confirmado", () => {
  assert.deepEqual(decidirTransicao(ped("CONFIRMED", 5), evt("PLACED", 6)), { aplicar: false, motivo: "regressao_de_ciclo_de_vida" });
});

test("decidirTransicao: evento de estágio anterior que chegou fora de ordem é ignorado", () => {
  assert.deepEqual(decidirTransicao(ped("CONFIRMED", 5), evt("PLACED", 1)), { aplicar: false, motivo: "regressao_de_ciclo_de_vida" });
  assert.deepEqual(decidirTransicao(ped("DISPATCHED", 9), evt("READY_TO_PICKUP", 4)), { aplicar: false, motivo: "regressao_de_ciclo_de_vida" });
});

test("decidirTransicao: estágio MAIS avançado sempre avança, mesmo com createdAt anterior (relógios diferentes)", () => {
  assert.equal(decidirTransicao(ped("CONFIRMED", 5), evt("DISPATCHED", 4)).aplicar, true);
});

test("decidirTransicao: mesmo status -> ignora", () => {
  assert.deepEqual(decidirTransicao(ped("PLACED", 1), evt("PLACED", 2)), { aplicar: false, motivo: "mesmo_status" });
});

test("decidirTransicao: estado FINAL não regride (CONCLUDED/CANCELLED); CANCELLED pode vir depois de estado normal", () => {
  assert.equal(decidirTransicao(ped("CONCLUDED", 5), evt("DISPATCHED", 9)).motivo, "estado_final_nao_regride");
  assert.equal(decidirTransicao(ped("CANCELLED", 5), evt("CONFIRMED", 9)).motivo, "estado_final_nao_regride");
  assert.equal(decidirTransicao(ped("CONFIRMED", 1), evt("CANCELLED", 2)).aplicar, true);
  assert.equal(decidirTransicao(ped("READY_TO_PICKUP", 1), evt("CANCELLED", 0)).aplicar, true, "cancelamento é sempre um avanço");
});

test("decidirTransicao: entre dois estados finais vale o mais recente", () => {
  assert.equal(decidirTransicao(ped("CONCLUDED", 5), evt("CANCELLED", 6)).aplicar, true);
  assert.deepEqual(decidirTransicao(ped("CANCELLED", 5), evt("CONCLUDED", 1)), { aplicar: false, motivo: "anterior_ao_estado_atual" });
});

test("decidirTransicao: empate de horário decide pelo ciclo de vida", () => {
  assert.equal(decidirTransicao(ped("CONFIRMED", 3), evt("PLACED", 3)).aplicar, false);
  assert.equal(decidirTransicao(ped("PLACED", 3), evt("CONFIRMED", 3)).aplicar, true);
});

test("decidirTransicao: sem createdAt utilizável, aplica o avanço (não trava por falta de data)", () => {
  assert.equal(decidirTransicao(ped("PLACED", 1), evt("CONFIRMED", null)).aplicar, true);
});

// ---------------------------------------------------------------------------
// Cliente: polling
// ---------------------------------------------------------------------------
const httpFake = (resposta) => {
  const chamadas = [];
  return {
    chamadas,
    getJson: async (caminho, opts) => { chamadas.push({ tipo: "GET", caminho, opts }); return typeof resposta === "function" ? resposta() : resposta; },
    postJson: async (caminho, corpo, opts) => { chamadas.push({ tipo: "POST", caminho, corpo, opts }); return {}; },
  };
};

test("buscarEventos: GET /events/v1.0/events:polling com x-polling-merchants (ids únicos, separados por vírgula)", async () => {
  const http = httpFake([{ id: "e1" }]);
  const r = await buscarEventos({ accessToken: "tok", merchantIds: ["m1", "m2", "m1", " m2 "], http });
  assert.deepEqual(r, [{ id: "e1" }]);
  const c = http.chamadas[0];
  assert.equal(c.tipo, "GET");
  assert.equal(c.caminho, "/events/v1.0/events:polling");
  assert.equal(c.caminho, IFOOD_ROTAS.eventsPolling);
  assert.equal(c.opts.headers["x-polling-merchants"], "m1,m2");
  assert.equal(c.opts.accessToken, "tok");
  assert.equal(c.opts.contexto, "events");
  assert.ok(!c.caminho.includes("?"), "sem filtros types/groups: consome tudo e decide localmente");
});

test("buscarEventos: 204 (sem corpo) vira lista vazia", async () => {
  assert.deepEqual(await buscarEventos({ accessToken: "t", merchantIds: ["m"], http: httpFake({}) }), []);
});

test("buscarEventos: resposta que não é lista nem vazia -> IFOOD_RESPOSTA_INVALIDA", async () => {
  await rejeita(buscarEventos({ accessToken: "t", merchantIds: ["m"], http: httpFake({ error: "x" }) }), IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA);
  await rejeita(buscarEventos({ accessToken: "t", merchantIds: ["m"], http: httpFake("texto") }), IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA);
});

test("buscarEventos: limite de 100 merchants e mínimo de 1 são exigidos ANTES de chamar a API", async () => {
  const http = httpFake([]);
  const muitos = Array.from({ length: 101 }, (_, i) => `m${i}`);
  await rejeita(buscarEventos({ accessToken: "t", merchantIds: muitos, http }), IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA);
  await rejeita(buscarEventos({ accessToken: "t", merchantIds: [], http }), IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA);
  await rejeita(buscarEventos({ accessToken: "t", merchantIds: ["", "  "], http }), IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA);
  assert.equal(http.chamadas.length, 0);
  assert.equal((await buscarEventos({ accessToken: "t", merchantIds: muitos.slice(0, 100), http })).length, 0);
});

// ---------------------------------------------------------------------------
// Cliente: ACK
// ---------------------------------------------------------------------------
test("confirmarEventos: POST /events/v1.0/events/acknowledgment com [{id}] únicos", async () => {
  const http = httpFake();
  const r = await confirmarEventos({ accessToken: "tok", eventIds: ["a", "b", "a"], http });
  assert.equal(r.enviados, 2);
  const c = http.chamadas[0];
  assert.equal(c.tipo, "POST");
  assert.equal(c.caminho, "/events/v1.0/events/acknowledgment");
  assert.equal(c.caminho, IFOOD_ROTAS.eventsAck);
  assert.deepEqual(c.corpo, [{ id: "a" }, { id: "b" }]);
  assert.equal(c.opts.accessToken, "tok");
});

test("confirmarEventos: lista vazia não chama a API; mais de 2000 ids é recusado antes de chamar", async () => {
  const http = httpFake();
  assert.deepEqual(await confirmarEventos({ accessToken: "t", eventIds: [], http }), { enviados: 0 });
  await rejeita(confirmarEventos({ accessToken: "t", eventIds: Array.from({ length: 2001 }, (_, i) => `e${i}`), http }), IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA);
  assert.equal(http.chamadas.length, 0);
  await confirmarEventos({ accessToken: "t", eventIds: Array.from({ length: 2000 }, (_, i) => `e${i}`), http });
  assert.equal(http.chamadas[0].corpo.length, 2000);
});

test("lotes: ACK em até 2000 ids únicos; merchants em até 100 por polling", () => {
  const ids = Array.from({ length: 4500 }, (_, i) => `e${i}`).concat(["e0", "e1"]);   // duplicados somem
  const lotes = dividirEmLotesDeAck(ids);
  assert.deepEqual(lotes.map((l) => l.length), [2000, 2000, 500]);
  assert.equal(IFOOD_EVENTS.maxIdsPorAck, 2000);
  const ms = dividirMerchantsEmLotes(Array.from({ length: 250 }, (_, i) => `m${i}`));
  assert.deepEqual(ms.map((l) => l.length), [100, 100, 50]);
  assert.deepEqual(dividirEmLotesDeAck([]), []);
});

test("constantes de Events seguem a documentação: 30 s de piso, 100 merchants, 2000 ids", () => {
  assert.equal(IFOOD_EVENTS.intervaloPollingMs, 30_000);
  assert.equal(IFOOD_EVENTS.intervaloMinimoMs, 30_000);
  assert.equal(IFOOD_EVENTS.maxMerchantsPorPolling, 100);
  assert.equal(STATUS_PEDIDO.CONFIRMED, "CONFIRMED");
});

// ---------------------------------------------------------------------------
// Cliente HTTP real (fetch falso): headers, 204 e 403 com unauthorizedMerchants
// ---------------------------------------------------------------------------
const resp = ({ status = 200, corpo = "", ct = "application/json", headers = {} } = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => ({ "content-type": ct, ...headers })[String(k).toLowerCase()] ?? null },
  text: async () => (typeof corpo === "string" ? corpo : JSON.stringify(corpo)),
});

test("getJson: header extra é enviado e NUNCA sobrescreve Authorization", async () => {
  let visto;
  const fetchImpl = async (url, opts) => { visto = { url, opts }; return resp({ corpo: [] }); };
  await httpClient.getJson("/events/v1.0/events:polling", {
    accessToken: "tok-real", contexto: "events", fetchImpl,
    headers: { "x-polling-merchants": "m1,m2", Authorization: "Bearer INTRUSO" },
  });
  assert.equal(visto.opts.headers["x-polling-merchants"], "m1,m2");
  assert.equal(visto.opts.headers.Authorization, "Bearer tok-real");
  assert.equal(visto.opts.method, "GET");
  assert.ok(visto.url.endsWith("/events/v1.0/events:polling"));
});

test("polling 204 (sem corpo, sem content-type) devolve vazio pelo cliente HTTP real", async () => {
  const fetchImpl = async () => resp({ status: 204, corpo: "", ct: "" });
  const r = await httpClient.getJson("/events/v1.0/events:polling", { accessToken: "t", contexto: "events", fetchImpl });
  assert.deepEqual(r, {});
  // e o cliente de Events traduz isso para []
  const http = { getJson: (c, o) => httpClient.getJson(c, { ...o, fetchImpl }) };
  assert.deepEqual(await buscarEventos({ accessToken: "t", merchantIds: ["m"], http }), []);
});

test("403 do polling traz unauthorizedMerchants no erro (só a lista de ids, nada mais do corpo)", async () => {
  const fetchImpl = async () => resp({ status: 403, corpo: { unauthorizedMerchants: ["m-x", "m-y", 42], segredo: "nao-pode-vazar" } });
  await assert.rejects(
    httpClient.getJson("/events/v1.0/events:polling", { accessToken: "t", contexto: "events", fetchImpl }),
    (e) => {
      assert.equal(e.codigo, IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO);
      assert.deepEqual(e.details.unauthorizedMerchants, ["m-x", "m-y"]);
      assert.ok(!JSON.stringify(e.details).includes("nao-pode-vazar"));
      return true;
    },
  );
});

test("403 fora do contexto 'events' NÃO lê o corpo (comportamento das outras APIs intacto)", async () => {
  let leu = false;
  const fetchImpl = async () => ({ ...resp({ status: 403 }), text: async () => { leu = true; return "{}"; } });
  await assert.rejects(httpClient.getJson("/merchant/v1.0/merchants", { accessToken: "t", fetchImpl }), (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO);
  assert.equal(leu, false);
});

test("429 do polling é reconhecido como IFOOD_RATE_LIMITED (após os retries do cliente)", async () => {
  process.env.IFOOD_API_BASE_URL = "https://merchant-api.ifood.com.br";
  let n = 0;
  const fetchImpl = async () => { n += 1; return resp({ status: 429, corpo: { code: "429" }, headers: { "retry-after": "0" } }); };
  await rejeita(httpClient.getJson("/events/v1.0/events:polling", { accessToken: "t", contexto: "events", fetchImpl }), IFOOD_ERROS.IFOOD_RATE_LIMITED);
  assert.ok(n >= 1);
});
