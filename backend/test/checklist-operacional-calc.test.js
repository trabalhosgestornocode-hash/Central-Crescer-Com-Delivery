// Checklist Operacional — cálculo puro (sem banco, sem rede, relógio fixo).
//
// Rodar: node --test test/checklist-operacional-calc.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  diaOperacional, montarResumo, medirPreparo, medirEntrega, medirVida, decompor, recebidoEm, concluidoEm,
  LIMITE_ATIVO_MIN, TETO_MIN, VIRADA_HORA, chaveOpaca,
} from "../src/modules/checklist-operacional/checklistOperacional.calc.js";

// 2026-10-09 12:00 em São Paulo (UTC−3). Dia operacional padrão = dia civil: 09/10 00:00 → 10/10 00:00 (03:00Z → 03:00Z).
const AGORA = Date.parse("2026-10-09T15:00:00.000Z");
const iso = (minAntes) => new Date(AGORA - minAntes * 60_000).toISOString();

let seq = 0;
/** Pedido concluído "normal": PLC −60, CFM −59, RTP −49 (preparo 10), DSP −45, CON −20 (entrega 25, vida 40). */
function pedido(over = {}) {
  seq += 1;
  return {
    order_id: `o-${seq}`, display_id: String(1000 + seq), status_oficial: "CONCLUDED", status_oficial_em: iso(20),
    order_type: "DELIVERY", delivery_by: "IFOOD", order_timing: "IMMEDIATE", is_test: false,
    order_created_at: iso(60), placed_event_created_at: iso(60), confirmed_event_at: iso(59),
    ready_event_at: iso(49), dispatch_event_at: iso(45), cancel_event_at: null,
    primeiro_evento_em: iso(60), criado_em: iso(60),
    ...over,
  };
}

describe("dia operacional no fuso do negócio", () => {
  test("padrão é o DIA CIVIL (00:00), a convenção já usada no projeto — 04:00 não é regra aprovada", () => {
    assert.equal(VIRADA_HORA, 0);
    const d = diaOperacional(AGORA);
    assert.equal(d.data, "2026-10-09");
    assert.equal(new Date(d.inicioMs).toISOString(), "2026-10-09T03:00:00.000Z");
    assert.equal(new Date(d.fimMs).toISOString(), "2026-10-10T03:00:00.000Z");
  });

  test("01:30 local já é o dia seguinte no padrão civil", () => {
    assert.equal(diaOperacional(Date.parse("2026-10-10T04:30:00.000Z")).data, "2026-10-10");
  });

  test("virada configurável continua funcionando quando passada EXPLICITAMENTE (ex.: 04:00)", () => {
    const t = Date.parse("2026-10-10T04:30:00.000Z"); // 01:30 local
    assert.equal(diaOperacional(t, { viradaHora: 4 }).data, "2026-10-09");
    assert.equal(diaOperacional(Date.parse("2026-10-10T07:00:00.000Z"), { viradaHora: 4 }).data, "2026-10-10");
  });

  test("o fuso é do negócio, não UTC: 23:30 local de 09/10 já é 10/10 em UTC", () => {
    const t = Date.parse("2026-10-10T02:30:00.000Z"); // 23:30 em SP
    assert.equal(diaOperacional(t).data, "2026-10-09");
    assert.equal(diaOperacional(t, { fuso: "UTC", viradaHora: 0 }).data, "2026-10-10");
  });

  test("virada de mês e de ano", () => {
    assert.equal(diaOperacional(Date.parse("2027-01-01T02:59:00.000Z")).data, "2026-12-31"); // 23:59 local de 31/12
    assert.equal(diaOperacional(Date.parse("2027-01-01T03:00:00.000Z")).data, "2027-01-01"); // 00:00 local de 01/01
  });
});

describe("os três tempos", () => {
  test("preparo exato: CFM → RTP", () => {
    const m = medirPreparo(pedido());
    assert.equal(m.min, 10);
    assert.equal(m.aproximado, false);
    assert.equal(m.fim, "RTP");
  });

  test("preparo só com despacho: APROXIMADO, nunca exato", () => {
    const m = medirPreparo(pedido({ ready_event_at: null }));
    assert.equal(m.min, 14);
    assert.equal(m.aproximado, true);
    assert.equal(m.fim, "DSP");
  });

  test("preparo sem confirmação: indisponível (não usa o recebimento no lugar)", () => {
    assert.equal(medirPreparo(pedido({ confirmed_event_at: null })).min, null);
  });

  test("entrega: DSP → CON, só DELIVERY, com a modalidade", () => {
    const m = medirEntrega(pedido({ delivery_by: "MERCHANT" }));
    assert.equal(m.min, 25);
    assert.equal(m.modalidade, "MERCHANT");
  });

  test("TAKEOUT não entra na entrega", () => {
    assert.equal(medirEntrega(pedido({ order_type: "TAKEOUT", dispatch_event_at: null })).motivo, "nao_delivery");
  });

  test("sem detalhes (order_type desconhecido) a entrega não é presumida", () => {
    assert.equal(medirEntrega(pedido({ order_type: null })).motivo, "sem_detalhes");
  });

  test("vida: recebimento (PLC) → conclusão (CON), medida direta", () => {
    assert.equal(medirVida(pedido()).min, 40);
  });

  test("vida sem PLC usa o createdAt oficial do pedido; sem nenhum dos dois, indisponível", () => {
    assert.equal(medirVida(pedido({ placed_event_created_at: null, order_created_at: iso(70) })).min, 50);
    assert.equal(medirVida(pedido({ placed_event_created_at: null, order_created_at: null })).min, null);
    assert.equal(recebidoEm(pedido({ placed_event_created_at: null, order_created_at: null })), null);
  });

  test("cancelamento nunca é conclusão (nem depois de um CON)", () => {
    const p = pedido({ status_oficial: "CANCELLED", status_oficial_em: iso(10), cancel_event_at: iso(10) });
    assert.equal(concluidoEm(p), null);
    assert.equal(medirVida(p).min, null);
    assert.equal(medirEntrega(p).min, null);
  });

  test("decomposição: trecho sem os dois carimbos fica null, nunca estimado", () => {
    assert.deepEqual(decompor(pedido()), { confirmacao: 1, preparo: 10, espera: 4, entrega: 25 });
    const d = decompor(pedido({ ready_event_at: null }));
    assert.equal(d.preparo, null);
    assert.equal(d.espera, null);
    assert.equal(d.entrega, 25);
  });
});

describe("eventos fora de ordem e carimbos inválidos", () => {
  test("pronto ANTES da confirmação: descartado e contado, nunca negativo", () => {
    const r = montarResumo({ pedidos: [pedido({ ready_event_at: iso(70) })], agoraMs: AGORA });
    assert.equal(r.indicadores.preparo.amostras, 0);
    assert.equal(r.indicadores.preparo.descartados, 1);
  });

  test("saída depois da conclusão: entrega descartada", () => {
    const r = montarResumo({ pedidos: [pedido({ dispatch_event_at: iso(10) })], agoraMs: AGORA });
    assert.equal(r.indicadores.entrega.amostras, 0);
    assert.equal(r.indicadores.entrega.descartados, 1);
  });

  test("duração acima do teto é inconsistente", () => {
    const p = pedido({ placed_event_created_at: iso(TETO_MIN.vida + 30), order_created_at: null, primeiro_evento_em: iso(30) });
    assert.equal(medirVida(p).motivo, "inconsistente");
  });

  test("CON atrasado de um pedido de ONTEM não entra na média de hoje", () => {
    const ontem = pedido({
      placed_event_created_at: "2026-10-08T22:00:00.000Z", order_created_at: null, primeiro_evento_em: "2026-10-08T22:00:00.000Z",
      confirmed_event_at: "2026-10-08T22:01:00.000Z", ready_event_at: "2026-10-08T22:10:00.000Z", dispatch_event_at: "2026-10-08T22:15:00.000Z",
      status_oficial_em: iso(5), criado_em: "2026-10-08T22:00:00.000Z",
    });
    const r = montarResumo({ pedidos: [ontem, pedido()], agoraMs: AGORA });
    assert.equal(r.indicadores.vida.amostras, 1);
    assert.equal(r.indicadores.vida.mediaDia, 40);
    assert.equal(r.contagemDia.recebidos, 1);
  });
});

describe("médias e amostras", () => {
  test("média só dos elegíveis, com a quantidade de pedidos", () => {
    const pedidos = [
      pedido(),                                                                       // preparo 10, entrega 25, vida 40
      pedido({ confirmed_event_at: iso(58), ready_event_at: iso(44), dispatch_event_at: iso(40), status_oficial_em: iso(10) }), // 14, 30, 50
      pedido({ status_oficial: "CANCELLED", status_oficial_em: iso(30), cancel_event_at: iso(30) }),  // fora de tudo
    ];
    const r = montarResumo({ pedidos, agoraMs: AGORA });
    assert.equal(r.indicadores.preparo.mediaDia, 12);
    assert.equal(r.indicadores.preparo.amostras, 2);
    assert.equal(r.indicadores.entrega.mediaDia, 27.5);
    assert.equal(r.indicadores.vida.mediaDia, 45);
    assert.equal(r.indicadores.vida.amostras, 2);
    assert.equal(r.contagemDia.cancelados, 1);
    assert.equal(r.contagemDia.concluidos, 2);
  });

  test("média com preparo aproximado é sinalizada e separa exatas de aproximadas", () => {
    const r = montarResumo({ pedidos: [pedido(), pedido({ ready_event_at: null })], agoraMs: AGORA });
    const p = r.indicadores.preparo;
    assert.equal(p.amostrasExatas, 1);
    assert.equal(p.amostrasAproximadas, 1);
    assert.equal(p.mediaAproximada, true);
    assert.equal(p.mediaDia, 12);
  });

  test("último = o que terminou por último, com o número curto do pedido", () => {
    const r = montarResumo({ pedidos: [pedido({ display_id: "A" }), pedido({ display_id: "B", ready_event_at: iso(40), dispatch_event_at: iso(35), status_oficial_em: iso(5) })], agoraMs: AGORA });
    assert.equal(r.indicadores.preparo.ultimo.displayId, "B");
    assert.equal(r.indicadores.vida.ultimo.displayId, "B");
  });

  test("entrega separada por modalidade e sempre marcada como aproximada (CON não validado)", () => {
    const r = montarResumo({ pedidos: [pedido({ delivery_by: "IFOOD" }), pedido({ delivery_by: "MERCHANT", status_oficial_em: iso(15) })], agoraMs: AGORA });
    const e = r.indicadores.entrega;
    assert.deepEqual(e.porModalidade, { IFOOD: { mediaDia: 25, amostras: 1 }, MERCHANT: { mediaDia: 30, amostras: 1 } });
    assert.equal(e.aproximado, true);
    assert.match(e.criterio, /não foi validada/);
  });

  test("pedido de teste e agendado ficam fora das médias", () => {
    const r = montarResumo({ pedidos: [pedido({ is_test: true }), pedido({ order_timing: "SCHEDULED" })], agoraMs: AGORA });
    assert.equal(r.indicadores.preparo.amostras, 0);
    assert.equal(r.indicadores.vida.amostras, 0);
    assert.equal(r.contagemDia.teste, 1);
  });
});

describe("indicador indisponível × sem pedidos", () => {
  test("sem pedidos: indicadores disponíveis, zerados, sem valor inventado", () => {
    const r = montarResumo({ pedidos: [], agoraMs: AGORA });
    for (const k of ["preparo", "entrega", "vida"]) {
      assert.equal(r.indicadores[k].disponivel, true);
      assert.equal(r.indicadores[k].mediaDia, null);
      assert.equal(r.indicadores[k].ultimo, null);
      assert.equal(r.indicadores[k].amostras, 0);
    }
    assert.deepEqual(r.pedidosAtivos, []);
    assert.equal(r.contagemDia.recebidos, 0);
  });

  test("concluídos sem detalhes: entrega INDISPONÍVEL com o motivo, não zero", () => {
    const r = montarResumo({ pedidos: [pedido({ order_type: null, display_id: null })], agoraMs: AGORA });
    assert.equal(r.indicadores.entrega.disponivel, false);
    assert.match(r.indicadores.entrega.motivo, /detalhes/);
    assert.ok(r.alertas.some((a) => a.codigo === "detalhes_ausentes"));
  });

  test("concluídos sem carimbo de recebimento: vida indisponível", () => {
    const r = montarResumo({ pedidos: [pedido({ placed_event_created_at: null, order_created_at: null })], agoraMs: AGORA });
    assert.equal(r.indicadores.vida.disponivel, false);
  });

  test("entrega concluída sem DSP: indisponível", () => {
    const r = montarResumo({ pedidos: [pedido({ dispatch_event_at: null })], agoraMs: AGORA });
    assert.equal(r.indicadores.entrega.disponivel, false);
    assert.match(r.indicadores.entrega.motivo, /DSP/);
  });
});

describe("pedidos em andamento", () => {
  test("ativo recente aparece com os carimbos que iniciam cada contador, com chave opaca", () => {
    const p = pedido({ status_oficial: "CONFIRMED", status_oficial_em: iso(4), placed_event_created_at: iso(5), confirmed_event_at: iso(4), ready_event_at: null, dispatch_event_at: null });
    const r = montarResumo({ pedidos: [p], agoraMs: AGORA });
    assert.equal(r.pedidosAtivos.length, 1);
    assert.deepEqual(Object.keys(r.pedidosAtivos[0]).sort(), ["agendado", "confirmadoEm", "despachadoEm", "displayId", "entregaPor", "id", "recebidoEm", "semConclusao", "status", "tipo"]);
    assert.equal(r.pedidosAtivos[0].confirmadoEm, iso(4));
    assert.equal(r.pedidosAtivos[0].id, chaveOpaca(p.order_id));
    assert.notEqual(r.pedidosAtivos[0].id, p.order_id);
    assert.equal(r.pedidosAtivos[0].semConclusao, false);
  });

  test("aberto há mais do limite CONTINUA ativo (estado oficial), marcado e com alerta crítico", () => {
    const preso = pedido({ status_oficial: "DISPATCHED", placed_event_created_at: iso(LIMITE_ATIVO_MIN + 30), primeiro_evento_em: iso(LIMITE_ATIVO_MIN + 30) });
    const r = montarResumo({ pedidos: [preso], agoraMs: AGORA });
    assert.equal(r.pedidosAtivos.length, 1);
    assert.equal(r.pedidosAtivos[0].semConclusao, true);
    assert.equal(r.contagemDia.emAndamento, 1);
    assert.equal(r.contagemDia.semConclusao, 1);
    const a = r.alertas.find((x) => x.codigo === "pedidos_sem_conclusao");
    assert.equal(a.nivel, "critico");
    assert.equal(a.quantidade, 1);
  });

  test("ativo sem nenhum horário de referência também continua ativo e é marcado", () => {
    const r = montarResumo({ pedidos: [pedido({ status_oficial: "CONFIRMED", placed_event_created_at: null, order_created_at: null, primeiro_evento_em: null, criado_em: null })], agoraMs: AGORA });
    assert.equal(r.pedidosAtivos.length, 1);
    assert.equal(r.pedidosAtivos[0].semConclusao, true);
  });

  test("pedido aberto antes da meia-noite continua em andamento depois dela (janela por tempo, não por dia)", () => {
    const agora = Date.parse("2026-10-10T03:20:00.000Z"); // 00:20 local de 10/10
    const p = pedido({ status_oficial: "CONFIRMED", placed_event_created_at: "2026-10-10T02:50:00.000Z", primeiro_evento_em: "2026-10-10T02:50:00.000Z", ready_event_at: null, dispatch_event_at: null });
    const r = montarResumo({ pedidos: [p], agoraMs: agora });
    assert.equal(r.pedidosAtivos.length, 1);
    assert.equal(r.contagemDia.recebidos, 0); // recebido às 23:50 de 09/10: pertence ao dia anterior
  });

  test("agendado em andamento é ATIVO (marcado), sem virar contador de atraso", () => {
    const r = montarResumo({ pedidos: [pedido({ status_oficial: "CONFIRMED", order_timing: "SCHEDULED", ready_event_at: null, dispatch_event_at: null })], agoraMs: AGORA });
    assert.equal(r.pedidosAtivos.length, 1);
    assert.equal(r.pedidosAtivos[0].agendado, true);
    assert.equal(r.contagemDia.agendados, 1);
  });
});

describe("agendados por indicador", () => {
  const ag = pedido({ order_timing: "SCHEDULED" });

  test("preparo e vida EXCLUEM o agendado (e informam quantos)", () => {
    const r = montarResumo({ pedidos: [ag], agoraMs: AGORA });
    assert.equal(r.indicadores.preparo.amostras, 0);
    assert.equal(r.indicadores.preparo.agendadosExcluidos, 1);
    assert.equal(r.indicadores.vida.amostras, 0);
    assert.equal(r.indicadores.vida.agendadosExcluidos, 1);
  });

  test("entrega INCLUI o agendado: saída → conclusão não depende do agendamento", () => {
    const r = montarResumo({ pedidos: [ag], agoraMs: AGORA });
    assert.equal(r.indicadores.entrega.amostras, 1);
    assert.equal(r.indicadores.entrega.mediaDia, 25);
  });

  test("na tabela, agendado não mostra preparo nem vida", () => {
    const linha = montarResumo({ pedidos: [ag], agoraMs: AGORA }).ultimosPedidos[0];
    assert.equal(linha.agendado, true);
    assert.equal(linha.preparoMin, null);
    assert.equal(linha.vidaMin, null);
    assert.equal(linha.entregaMin, 25);
  });
});

describe("cancelados fora das médias", () => {
  test("cancelado depois de pronto não entra em preparo; cancelado depois de CON não entra em entrega nem vida", () => {
    const r = montarResumo({
      pedidos: [
        pedido({ status_oficial: "CANCELLED", status_oficial_em: iso(15), cancel_event_at: iso(15) }),
        pedido({ status_oficial: "CANCELLED", status_oficial_em: iso(5), cancel_event_at: iso(5) }),
      ],
      agoraMs: AGORA,
    });
    for (const k of ["preparo", "entrega", "vida"]) assert.equal(r.indicadores[k].amostras, 0, k);
    assert.equal(r.contagemDia.cancelados, 2);
    assert.ok(r.ultimosPedidos.every((l) => l.preparoMin == null && l.entregaMin == null && l.vidaMin == null));
  });
});

describe("sem dado pessoal", () => {
  test("nenhum campo de cliente/endereço/pagamento sai do resumo, mesmo se a linha trouxer", () => {
    const sujo = pedido({ customer: { name: "Fulano", phone: "11999999999" }, delivery: { address: "Rua X" }, payments: [{ v: 1 }], customer_document_number: "12345678900", items: [{ n: "x" }] });
    const r = montarResumo({ pedidos: [sujo, pedido({ status_oficial: "CONFIRMED", ...{ customer: { name: "Beltrano" } } })], agoraMs: AGORA });
    const texto = JSON.stringify(r);
    assert.ok(!texto.includes(sujo.order_id), "orderId do iFood não sai");
    for (const proibido of ["Fulano", "Beltrano", "11999999999", "Rua X", "12345678900", "customer", "payments", "items"]) {
      assert.ok(!texto.includes(proibido), `vazou ${proibido}`);
    }
  });
});
