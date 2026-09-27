// Events do iFood — processamento de lote: persistir, deduplicar, resolver tenant,
// aplicar o estado OFICIAL e preparar o ACK. Repositório em memória com a mesma
// semântica do banco (migration 101 validada em Postgres local descartável).
//
// Rodar: node --experimental-vm-modules --test test/ifood-events-service.test.js
import test from "node:test";
import assert from "node:assert/strict";

import { processarLote, reprocessarPendentes, enviarAcks, aplicarEfeito } from "../src/modules/ifood/ifoodEvents.service.js";
import { IFOOD_EVENTS } from "../src/modules/ifood/ifood.constants.js";
import { dividirEmLotesDeAck } from "../src/modules/ifood/ifoodEvents.client.js";
import { normalizarEvento } from "../src/modules/ifood/ifoodEvents.parser.js";
import {
  criarRepoEmMemoria, criarRelogio, ev, t, M_A, M_B, ORG_A, UN_A, ORG_B, UN_B, CONEXAO_A, CONEXAO_B,
} from "./helpers/ifood-events-fakes.js";

const silencio = () => {};
const mapa = (...conexoes) => new Map(conexoes.map((c) => [c.merchant_id, c]));
const AMBOS = () => mapa(CONEXAO_A, CONEXAO_B);

async function lote(repo, brutos, conexoes = AMBOS(), relogio = repo.relogio) {
  return processarLote({ eventosBrutos: brutos, conexoesPorMerchant: conexoes, repo, agora: relogio.agora, log: silencio });
}

// ---------------------------------------------------------------------------
test("evento novo: persistido com o tenant da CONEXÃO, processado, pedido criado e id devolvido para o ACK", async () => {
  const repo = criarRepoEmMemoria();
  const { idsParaAck, resumo } = await lote(repo, [ev("e1", "PLC", { min: 1 })]);

  const e = repo.eventos.get("e1");
  assert.equal(e.processing_status, "PROCESSADO");
  assert.equal(e.organizacao_id, ORG_A);
  assert.equal(e.unidade_id, UN_A);
  assert.equal(e.conexao_id, "con-a");
  assert.equal(e.merchant_id, M_A);
  assert.equal(e.event_code, "PLC");
  assert.equal(e.event_full_code, "PLACED");
  assert.equal(e.event_created_at, t(1));
  assert.match(e.payload_hash, /^[0-9a-f]{64}$/);
  assert.equal(e.payload.id, "e1", "payload bruto preservado");
  assert.ok(e.processed_at && e.received_at);
  assert.equal(e.acknowledged_at, null, "ACK é feito DEPOIS, pelo poller");

  const p = repo.pedidos.get("order-1");
  assert.equal(p.status_oficial, "PLACED");
  assert.equal(p.organizacao_id, ORG_A);
  assert.equal(p.unidade_id, UN_A);
  assert.deepEqual(idsParaAck, ["e1"]);
  assert.equal(resumo.novos, 1);
  assert.equal(resumo.processados, 1);
});

test("o tenant vem SEMPRE da conexão — nunca do payload do evento", async () => {
  const repo = criarRepoEmMemoria();
  await lote(repo, [ev("e1", "PLC", { organizacao_id: ORG_B, organizacaoId: ORG_B, unidade_id: UN_B, tenant: ORG_B, metadata: { organizacao_id: ORG_B } })]);
  const e = repo.eventos.get("e1");
  assert.equal(e.organizacao_id, ORG_A);
  assert.equal(e.unidade_id, UN_A);
  assert.equal(repo.pedidos.get("order-1").organizacao_id, ORG_A);
});

test("dois merchants no mesmo lote: cada evento vai para o SEU tenant, sem mistura", async () => {
  const repo = criarRepoEmMemoria();
  await lote(repo, [
    ev("ea", "PLC", { orderId: "oA", merchantId: M_A, min: 1 }),
    ev("eb", "PLC", { orderId: "oB", merchantId: M_B, min: 1 }),
  ]);
  assert.equal(repo.eventos.get("ea").organizacao_id, ORG_A);
  assert.equal(repo.eventos.get("eb").organizacao_id, ORG_B);
  assert.equal(repo.pedidos.get("oA").unidade_id, UN_A);
  assert.equal(repo.pedidos.get("oB").unidade_id, UN_B);
});

// --- deduplicação ------------------------------------------------------------------
test("duplicado JÁ no banco: não reprocessa nem duplica; conta a reentrega; ainda devolve o id para o ACK", async () => {
  const repo = criarRepoEmMemoria();
  await lote(repo, [ev("e1", "PLC", { min: 1 })]);
  const antes = structuredClone(repo.pedidos.get("order-1"));
  const statusAntes = repo.eventos.get("e1").processing_status;

  const { idsParaAck, resumo } = await lote(repo, [ev("e1", "PLC", { min: 1 })]);
  assert.equal(repo.eventos.size, 1, "UNIQUE(event_id): continua 1 linha");
  assert.equal(resumo.novos, 0);
  assert.equal(resumo.reentregas, 1);
  assert.equal(repo.eventos.get("e1").reentregas, 1);
  assert.equal(repo.eventos.get("e1").processing_status, statusAntes);
  assert.deepEqual(repo.pedidos.get("order-1"), antes, "nenhum efeito duplicado no pedido");
  assert.deepEqual(idsParaAck, ["e1"], "a doc manda reconhecer também os já processados");
});

test("duplicado DENTRO do lote: uma linha só, ACK uma vez", async () => {
  const repo = criarRepoEmMemoria();
  const { idsParaAck, resumo } = await lote(repo, [ev("e1", "PLC"), ev("e1", "PLC"), ev("e1", "PLC")]);
  assert.equal(repo.eventos.size, 1);
  assert.equal(resumo.duplicadosNoLote, 2);
  assert.deepEqual(idsParaAck, ["e1"]);
});

test("PLACED repetido com id NOVO não cria outro pedido nem desfaz o estado", async () => {
  const repo = criarRepoEmMemoria();
  await lote(repo, [ev("e1", "PLC", { min: 1 }), ev("e2", "CFM", { min: 2 })]);
  await lote(repo, [ev("e3", "PLC", { min: 3 })]);           // "eventos antigos de PLACED" reaparecem com id novo
  assert.equal(repo.pedidos.size, 1);
  assert.equal(repo.pedidos.get("order-1").status_oficial, "CONFIRMED");
  assert.equal(repo.eventos.get("e3").processing_status, "IGNORADO");
  assert.equal(repo.eventos.get("e3").last_error, "regressao_de_ciclo_de_vida");
});

// --- ordem -------------------------------------------------------------------------
test("eventos fora de ordem no lote são processados por createdAt (estado final correto)", async () => {
  const repo = criarRepoEmMemoria();
  await lote(repo, [ev("e3", "RTP", { min: 3 }), ev("e1", "PLC", { min: 1 }), ev("e2", "CFM", { min: 2 })]);
  const p = repo.pedidos.get("order-1");
  assert.equal(p.status_oficial, "READY_TO_PICKUP");
  assert.equal(p.status_oficial_evento_id, "e3");
  assert.deepEqual([...repo.eventos.keys()], ["e1", "e2", "e3"], "persistidos na ordem de criação");
  assert.ok([...repo.eventos.values()].every((e) => e.processing_status === "PROCESSADO"));
});

test("evento atrasado (chega depois, mas é anterior) não regride o estado", async () => {
  const repo = criarRepoEmMemoria();
  await lote(repo, [ev("e2", "CFM", { min: 2 })]);
  await lote(repo, [ev("e1", "PLC", { min: 1 })]);
  assert.equal(repo.pedidos.get("order-1").status_oficial, "CONFIRMED");
  assert.equal(repo.eventos.get("e1").processing_status, "IGNORADO");
});

test("estado FINAL não é desfeito (CONCLUDED); CANCELLED encerra o pedido", async () => {
  const repo = criarRepoEmMemoria();
  await lote(repo, [ev("e1", "PLC", { min: 1 }), ev("e2", "CON", { min: 5 })]);
  await lote(repo, [ev("e3", "DSP", { min: 6 })]);
  assert.equal(repo.pedidos.get("order-1").status_oficial, "CONCLUDED");

  await lote(repo, [ev("c1", "PLC", { orderId: "o2", min: 1 }), ev("c2", "CFM", { orderId: "o2", min: 2 }), ev("c3", "CAN", { orderId: "o2", min: 3 })]);
  assert.equal(repo.pedidos.get("o2").status_oficial, "CANCELLED");
});

// --- estado só por evento oficial ------------------------------------------------------
test("o estado só existe se um EVENTO OFICIAL de ORDER_STATUS o definir (nada de 'assumir' ação)", async () => {
  const repo = criarRepoEmMemoria();
  // pedido conhecido só por um evento que NÃO é de status (ex.: solicitação de cancelamento)
  await lote(repo, [ev("e1", "CAR", { min: 1 })]);
  const p = repo.pedidos.get("order-1");
  assert.equal(p.status_oficial, null, "CAR (pedido de cancelamento) não muda o estado — só o evento CAN muda");
  assert.equal(repo.eventos.get("e1").processing_status, "IGNORADO");

  await lote(repo, [ev("e2", "CAN", { min: 2 })]);
  assert.equal(repo.pedidos.get("order-1").status_oficial, "CANCELLED");
});

// --- desconhecidos / quarentena --------------------------------------------------------
test("evento de código DESCONHECIDO: guardado, marcado e reconhecido; não trava nada", async () => {
  const repo = criarRepoEmMemoria();
  const { idsParaAck, resumo } = await lote(repo, [ev("e1", "ZZZ", { fullCode: "ALGO_NOVO_DO_IFOOD" }), ev("e2", "PLC", { min: 1 })]);
  assert.equal(repo.eventos.get("e1").processing_status, "DESCONHECIDO");
  assert.equal(repo.eventos.get("e1").event_code, "ZZZ");
  assert.equal(repo.eventos.get("e2").processing_status, "PROCESSADO", "o lote continua");
  assert.deepEqual(idsParaAck.sort(), ["e1", "e2"]);
  assert.equal(resumo.desconhecidos, 1);
  assert.equal(repo.pedidos.get("order-1").status_oficial, "PLACED");
  assert.equal(repo.pedidos.size, 1, "desconhecido não cria pedido");
});

test("merchant SEM conexão viva: quarentena (sem tenant), nunca toca em pedido, e é reconhecido", async () => {
  const repo = criarRepoEmMemoria();
  const { idsParaAck, resumo } = await lote(repo, [ev("e1", "PLC", { merchantId: "merchant-que-ninguem-tem" })]);
  const e = repo.eventos.get("e1");
  assert.equal(e.processing_status, "MERCHANT_DESCONHECIDO");
  assert.equal(e.organizacao_id, null);
  assert.equal(e.unidade_id, null);
  assert.equal(e.conexao_id, null);
  assert.equal(repo.pedidos.size, 0);
  assert.deepEqual(idsParaAck, ["e1"]);
  assert.equal(resumo.quarentena, 1);
});

test("merchant sem conexão desta instância não vira tenant de outro: mapa vazio -> tudo em quarentena", async () => {
  const repo = criarRepoEmMemoria();
  await lote(repo, [ev("e1", "PLC"), ev("e2", "PLC", { orderId: "o2", merchantId: M_B })], new Map());
  assert.ok([...repo.eventos.values()].every((e) => e.processing_status === "MERCHANT_DESCONHECIDO" && e.organizacao_id === null));
  assert.equal(repo.pedidos.size, 0);
});

test("cross-tenant: pedido que já pertence a OUTRA unidade NUNCA é alterado por evento de merchant diferente", async () => {
  const repo = criarRepoEmMemoria();
  await lote(repo, [ev("b1", "PLC", { orderId: "o-x", merchantId: M_B, min: 1 }), ev("b2", "CFM", { orderId: "o-x", merchantId: M_B, min: 2 })]);
  const antes = structuredClone(repo.pedidos.get("o-x"));

  // Evento do merchant A reivindicando o MESMO orderId (colisão/anomalia)
  const { idsParaAck } = await lote(repo, [ev("a1", "CAN", { orderId: "o-x", merchantId: M_A, min: 9 })]);

  const e = repo.eventos.get("a1");
  assert.equal(e.processing_status, "FALHOU");
  assert.equal(e.last_error, "PEDIDO_DE_OUTRO_TENANT");
  assert.equal(e.retry_count, IFOOD_EVENTS.maxTentativasProcessamento, "não reprocessável: sai da fila de retry");
  assert.deepEqual(repo.pedidos.get("o-x"), antes, "pedido de B intacto");
  assert.equal(repo.pedidos.get("o-x").organizacao_id, ORG_B);
  assert.deepEqual(idsParaAck, ["a1"]);
});

test("evento conhecido sem orderId: guardado como IGNORADO (sem pedido)", async () => {
  const repo = criarRepoEmMemoria();
  await lote(repo, [ev("e1", "PLC", { orderId: null })]);
  assert.equal(repo.eventos.get("e1").processing_status, "IGNORADO");
  assert.equal(repo.pedidos.size, 0);
});

test("evento inválido (sem id) é descartado com log e NÃO entra no ACK; o resto do lote segue", async () => {
  const repo = criarRepoEmMemoria();
  const { idsParaAck, resumo } = await lote(repo, [{ code: "PLC" }, null, ev("e1", "PLC", { min: 1 })]);
  assert.equal(resumo.invalidos, 2);
  assert.deepEqual(idsParaAck, ["e1"]);
});

test("lote vazio ou só inválidos: nada é persistido nem reconhecido", async () => {
  const repo = criarRepoEmMemoria();
  assert.deepEqual((await lote(repo, [])).idsParaAck, []);
  assert.deepEqual((await lote(repo, [{}])).idsParaAck, []);
  assert.equal(repo.chamadas.includes("inserirEventos"), false);
});

// --- falhas ------------------------------------------------------------------------------
test("FALHA ao persistir: o lote LANÇA (nada é reconhecido) e nada fica gravado", async () => {
  const repo = criarRepoEmMemoria();
  repo.falhar.inserirEventos = 1;
  await assert.rejects(lote(repo, [ev("e1", "PLC")]), /falha injetada em inserirEventos/);
  assert.equal(repo.eventos.size, 0);
  assert.equal(repo.pedidos.size, 0);
});

test("FALHA ao processar um evento JÁ persistido: fica FALHOU (retry_count), o lote não lança e o ACK segue", async () => {
  const repo = criarRepoEmMemoria();
  repo.falhar.garantirPedido = 1;
  const { idsParaAck, resumo } = await lote(repo, [ev("e1", "PLC", { min: 1 })]);
  const e = repo.eventos.get("e1");
  assert.equal(e.processing_status, "FALHOU");
  assert.equal(e.retry_count, 1);
  assert.match(e.last_error, /falha injetada/);
  assert.deepEqual(idsParaAck, ["e1"], "está seguro no banco: reconhecer evita reentrega/strikes");
  assert.equal(resumo.falhas, 1);
  assert.equal(repo.pedidos.size, 0);
});

test("reprocessarPendentes: recupera o evento FALHOU quando o problema passa (uma vez só, sem duplicar efeito)", async () => {
  const repo = criarRepoEmMemoria();
  repo.falhar.garantirPedido = 1;
  await lote(repo, [ev("e1", "PLC", { min: 1 })]);
  const r1 = await reprocessarPendentes({ repo, agora: repo.relogio.agora, log: silencio });
  assert.equal(r1.tentados, 1);
  assert.equal(repo.eventos.get("e1").processing_status, "PROCESSADO");
  assert.equal(repo.pedidos.get("order-1").status_oficial, "PLACED");
  const r2 = await reprocessarPendentes({ repo, agora: repo.relogio.agora, log: silencio });
  assert.equal(r2.tentados, 0, "já processado: sai da fila");
});

test("reprocessarPendentes: incrementa retry_count e PARA no limite de tentativas", async () => {
  const repo = criarRepoEmMemoria();
  repo.falhar.garantirPedido = 1 + IFOOD_EVENTS.maxTentativasProcessamento + 5;
  await lote(repo, [ev("e1", "PLC")]);
  for (let i = 0; i < IFOOD_EVENTS.maxTentativasProcessamento + 3; i += 1) await reprocessarPendentes({ repo, agora: repo.relogio.agora, log: silencio });
  const e = repo.eventos.get("e1");
  assert.equal(e.processing_status, "FALHOU");
  assert.equal(e.retry_count, IFOOD_EVENTS.maxTentativasProcessamento, "não passa do teto");
  const r = await reprocessarPendentes({ repo, agora: repo.relogio.agora, log: silencio });
  assert.equal(r.tentados, 0);
});

test("reprocessarPendentes não toca em eventos de quarentena (sem tenant)", async () => {
  const repo = criarRepoEmMemoria();
  await lote(repo, [ev("e1", "PLC", { merchantId: "ninguem" })]);
  const r = await reprocessarPendentes({ repo, agora: repo.relogio.agora, log: silencio });
  assert.equal(r.tentados, 0);
  assert.equal(repo.pedidos.size, 0);
});

// --- aplicarEfeito: corrida ---------------------------------------------------------------
test("aplicarEfeito: perde a corrida (estado mudou entre ler e gravar), relê e reavalia", async () => {
  const repo = criarRepoEmMemoria();
  await lote(repo, [ev("e1", "PLC", { min: 1 })]);
  const original = repo.aplicarStatusPedido;
  let interferiu = false;
  repo.aplicarStatusPedido = async (args) => {
    if (!interferiu) {                                            // outro processo avança o pedido antes do CAS
      interferiu = true;
      const p = repo.pedidos.get("order-1");
      p.status_oficial = "READY_TO_PICKUP"; p.status_oficial_em = t(9);
    }
    return original(args);
  };
  const e = normalizarEvento(ev("e2", "CFM", { min: 2 })).evento;
  const r = await aplicarEfeito({ evento: e, tenant: { organizacaoId: ORG_A, unidadeId: UN_A }, repo, agora: repo.relogio.agora, log: silencio });
  assert.equal(r.status, "IGNORADO", "CONFIRMED já está atrás de READY_TO_PICKUP");
  assert.equal(repo.pedidos.get("order-1").status_oficial, "READY_TO_PICKUP");
});

// --- ACK ---------------------------------------------------------------------------------------
test("enviarAcks: lotes de até 2000; grava acknowledged_at só depois de cada 202", async () => {
  const repo = criarRepoEmMemoria();
  const ids = Array.from({ length: 4500 }, (_, i) => `e${i}`);
  await repo.inserirEventos(ids.map((id) => ({ event_id: id, processing_status: "PROCESSADO", payload: {} })));
  const enviados = [];
  await enviarAcks({ idsParaAck: ids, repo, agora: repo.relogio.agora, log: silencio, dividir: dividirEmLotesDeAck, confirmar: async (l) => { enviados.push(l.length); } });
  assert.deepEqual(enviados, [2000, 2000, 500]);
  assert.ok([...repo.eventos.values()].every((e) => e.acknowledged_at));
});

test("enviarAcks: se um lote falha, PARA e lança; só os lotes já confirmados ficam marcados", async () => {
  const repo = criarRepoEmMemoria();
  const ids = Array.from({ length: 4100 }, (_, i) => `e${i}`);
  await repo.inserirEventos(ids.map((id) => ({ event_id: id, processing_status: "PROCESSADO", payload: {} })));
  let n = 0;
  await assert.rejects(enviarAcks({
    idsParaAck: ids, repo, agora: repo.relogio.agora, log: silencio, dividir: dividirEmLotesDeAck,
    confirmar: async () => { n += 1; if (n === 2) throw new Error("iFood fora do ar"); },
  }), /iFood fora do ar/);
  const marcados = [...repo.eventos.values()].filter((e) => e.acknowledged_at).length;
  assert.equal(marcados, 2000, "só o 1º lote (confirmado) foi carimbado; o resto volta no polling");
});

test("enviarAcks: falha só no carimbo LOCAL (depois do 202) não aborta os demais lotes", async () => {
  const repo = criarRepoEmMemoria();
  const ids = Array.from({ length: 2500 }, (_, i) => `e${i}`);
  await repo.inserirEventos(ids.map((id) => ({ event_id: id, processing_status: "PROCESSADO", payload: {} })));
  repo.falhar.marcarAck = 1;
  const enviados = [];
  const r = await enviarAcks({ idsParaAck: ids, repo, agora: repo.relogio.agora, log: silencio, dividir: dividirEmLotesDeAck, confirmar: async (l) => { enviados.push(l.length); } });
  assert.deepEqual(enviados, [2000, 500]);
  assert.equal(r.confirmados, 2500);
});

test("relógio: received_at usa o instante injetado (nada de Date.now escondido)", async () => {
  const rel = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio: rel });
  rel.avancarS(3600);
  await lote(repo, [ev("e1", "PLC")], AMBOS(), rel);
  assert.equal(repo.eventos.get("e1").received_at, rel.agora().toISOString());
});
