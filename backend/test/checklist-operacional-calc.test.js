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
/** Pedido concluído "normal": PLC −60, CFM −59, RTP −49, DSP −45 (preparo 15), CON −20 (entrega 25, vida 40 = 15 + 25). */
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
  test("preparo = chegada (PLC) → despacho (DSP); o pronto (RTP) NÃO encerra o preparo", () => {
    const m = medirPreparo(pedido());
    assert.equal(m.min, 15);
    // Mesmo sem RTP o preparo é o mesmo número — o RTP não participa da conta.
    assert.equal(medirPreparo(pedido({ ready_event_at: null })).min, 15);
    // Pronto cedo e entregador demorando: a espera continua dentro do preparo.
    assert.equal(medirPreparo(pedido({ ready_event_at: iso(58) })).min, 15);
  });

  test("Cenário D: chegou 12:00, pronto 12:12, despacho 12:18, conclusão 12:43 → 18 / 25 / 43", () => {
    const t = (hhmm) => `2026-10-09T${hhmm}:00.000Z`;
    const p = pedido({ placed_event_created_at: t("12:00"), confirmed_event_at: t("12:01"), ready_event_at: t("12:12"), dispatch_event_at: t("12:18"), status_oficial_em: t("12:43") });
    assert.equal(medirPreparo(p).min, 18);
    assert.equal(medirEntrega(p).min, 25);
    assert.equal(medirVida(p).min, 43);
    assert.equal(medirPreparo(p).min + medirEntrega(p).min, medirVida(p).min);
  });

  test("sem a chegada (PLC) não há preparo nem vida — o createdAt do pedido NÃO substitui", () => {
    const p = pedido({ placed_event_created_at: null, order_created_at: iso(70) });
    assert.equal(medirPreparo(p).motivo, "carimbo_ausente");
    assert.equal(medirVida(p).motivo, "carimbo_ausente");
    assert.equal(recebidoEm(p), iso(70));   // exibição/janela do dia continuam podendo usar o createdAt
  });

  test("sem despacho (DSP) o preparo não é medido nem inventado", () => {
    assert.equal(medirPreparo(pedido({ dispatch_event_at: null })).motivo, "sem_saida");
  });

  test("RETIRADA (sem DSP) e pedido sem detalhes ficam fora dos três tempos", () => {
    const tk = pedido({ order_type: "TAKEOUT", dispatch_event_at: null, delivery_by: null });
    assert.equal(medirPreparo(tk).motivo, "nao_delivery");
    assert.equal(medirEntrega(tk).motivo, "nao_delivery");
    assert.equal(medirVida(tk).motivo, "nao_delivery");
    const sd = pedido({ order_type: null });
    assert.equal(medirPreparo(sd).motivo, "sem_detalhes");
    assert.equal(medirVida(sd).motivo, "sem_detalhes");
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

  test("vida: chegada (PLC) → conclusão (CON) = preparo + entrega", () => {
    const p = pedido();
    assert.equal(medirVida(p).min, 40);
    assert.equal(medirPreparo(p).min + medirEntrega(p).min, medirVida(p).min);
  });

  test("sem nenhum horário de chegada, recebidoEm é null", () => {
    assert.equal(recebidoEm(pedido({ placed_event_created_at: null, order_created_at: null })), null);
  });

  test("cancelamento nunca é conclusão (nem depois de um CON)", () => {
    const p = pedido({ status_oficial: "CANCELLED", status_oficial_em: iso(10), cancel_event_at: iso(10) });
    assert.equal(concluidoEm(p), null);
    assert.equal(medirVida(p).min, null);
    assert.equal(medirEntrega(p).min, null);
  });

  test("decomposição: preparo + entrega (sem sobreposição); o detalhe do preparo é informativo", () => {
    const d = decompor(pedido());
    assert.equal(d.preparo, 15);
    assert.equal(d.entrega, 25);
    assert.equal(d.preparo + d.entrega, 40);
    // Partição do próprio preparo: confirmação + até o pronto + espera pelo despacho.
    assert.deepEqual(d.detalhePreparo, { confirmacao: 1, ateOPronto: 10, esperaPeloDespacho: 4 });
    const s = d.detalhePreparo;
    assert.equal(s.confirmacao + s.ateOPronto + s.esperaPeloDespacho, d.preparo);
  });

  test("decomposição: sem o despacho os trechos ficam null (nunca estimados); sem RTP ou com RTP fora de ordem não há detalhe", () => {
    const sem = decompor(pedido({ dispatch_event_at: null }));
    assert.equal(sem.preparo, null);
    assert.equal(sem.entrega, null);
    const semRtp = decompor(pedido({ ready_event_at: null }));
    assert.equal(semRtp.preparo, 15);
    assert.equal(semRtp.detalhePreparo, null);
    const foraDeOrdem = decompor(pedido({ ready_event_at: iso(40) }));
    assert.equal(foraDeOrdem.preparo, 15);
    assert.equal(foraDeOrdem.detalhePreparo, null);
  });
});

describe("eventos fora de ordem e carimbos inválidos", () => {
  test("despacho ANTES da chegada: descartado e contado, nunca negativo", () => {
    const r = montarResumo({ pedidos: [pedido({ dispatch_event_at: iso(70) })], agoraMs: AGORA });
    assert.equal(r.indicadores.preparo.amostras, 0);
    assert.equal(r.indicadores.preparo.descartados, 1);
  });

  test("pronto (RTP) fora de ordem NÃO afeta o preparo", () => {
    const r = montarResumo({ pedidos: [pedido({ ready_event_at: iso(70) }), pedido({ ready_event_at: iso(10) })], agoraMs: AGORA });
    assert.equal(r.indicadores.preparo.amostras, 2);
    assert.equal(r.indicadores.preparo.mediaDia, 15);
    assert.equal(r.indicadores.preparo.descartados, 0);
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
      pedido(),                                                                       // preparo 15, entrega 25, vida 40
      pedido({ confirmed_event_at: iso(58), ready_event_at: iso(44), dispatch_event_at: iso(40), status_oficial_em: iso(10) }), // 20, 30, 50
      pedido({ status_oficial: "CANCELLED", status_oficial_em: iso(30), cancel_event_at: iso(30) }),  // fora de tudo
    ];
    const r = montarResumo({ pedidos, agoraMs: AGORA });
    assert.equal(r.indicadores.preparo.mediaDia, 17.5);
    assert.equal(r.indicadores.preparo.amostras, 2);
    assert.equal(r.indicadores.entrega.mediaDia, 27.5);
    assert.equal(r.indicadores.vida.mediaDia, 45);
    // Mesmo conjunto de pedidos nos três: a média da vida é a soma das médias dos trechos.
    assert.equal(r.indicadores.preparo.mediaDia + r.indicadores.entrega.mediaDia, r.indicadores.vida.mediaDia);
    assert.equal(r.indicadores.vida.amostras, 2);
    assert.equal(r.contagemDia.cancelados, 1);
    assert.equal(r.contagemDia.concluidos, 2);
  });

  test("retirada e pedido sem detalhes ficam fora das médias de tempo e são contados à parte", () => {
    const pedidos = [pedido(), pedido({ order_type: "TAKEOUT", dispatch_event_at: null, delivery_by: null, status_oficial_em: iso(5) }), pedido({ order_type: null })];
    const r = montarResumo({ pedidos, agoraMs: AGORA });
    for (const k of ["preparo", "entrega", "vida"]) assert.equal(r.indicadores[k].amostras, 1, k);
    assert.equal(r.indicadores.vida.mediaDia, 40);
    assert.equal(r.indicadores.preparo.retiradas, 1);
    assert.equal(r.indicadores.preparo.semDetalhes, 1);
    assert.equal(r.contagemDia.recebidos, 3);   // a retirada continua contada como pedido recebido
    assert.equal(r.contagemDia.concluidos, 3);
  });

  test("a retirada aparece em 'últimos pedidos' sem nenhuma duração inventada", () => {
    const r = montarResumo({ pedidos: [pedido({ order_type: "TAKEOUT", dispatch_event_at: null, delivery_by: null })], agoraMs: AGORA });
    const linha = r.ultimosPedidos[0];
    assert.equal(linha.tipo, "TAKEOUT");
    assert.equal(linha.preparoMin, null);
    assert.equal(linha.entregaMin, null);
    assert.equal(linha.vidaMin, null);
  });

  test("último = o que terminou por último, com o número curto do pedido", () => {
    const r = montarResumo({ pedidos: [pedido({ display_id: "A" }), pedido({ display_id: "B", dispatch_event_at: iso(35), status_oficial_em: iso(5) })], agoraMs: AGORA });
    assert.equal(r.indicadores.preparo.ultimo.displayId, "B");
    assert.equal(r.indicadores.vida.ultimo.displayId, "B");
  });

  test("entrega separada por modalidade e sempre marcada como aproximada (CON não validado)", () => {
    const r = montarResumo({ pedidos: [pedido({ delivery_by: "IFOOD" }), pedido({ delivery_by: "MERCHANT", status_oficial_em: iso(15) })], agoraMs: AGORA });
    const e = r.indicadores.entrega;
    assert.deepEqual(e.porModalidade, { IFOOD: { mediaDia: 25, amostras: 1 }, MERCHANT: { mediaDia: 30, amostras: 1 } });
    assert.equal(e.aproximado, true);
    assert.match(e.criterio, /conclusão registrada pelo iFood/);
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
