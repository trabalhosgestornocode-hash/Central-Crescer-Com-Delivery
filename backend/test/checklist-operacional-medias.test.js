// Checklist Operacional — regra final das MÉDIAS: quem entra em cada indicador, vida TOTAL × vida DECOMPOSTA, tamanho da amostra
// e integridade temporal (nada de horário inventado, cancelado nunca é concluído, duração nunca negativa).
//
// Rodar: node --experimental-vm-modules --test test/checklist-operacional-medias.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { montarResumo } from "../src/modules/checklist-operacional/checklistOperacional.calc.js";

const AGORA = Date.parse("2026-10-09T15:00:00.000Z");
const iso = (minAntes) => new Date(AGORA - minAntes * 60_000).toISOString();

let seq = 0;
/** Entrega concluída: PLC −60, CFM −59, RTP −49, DSP −45 (preparo 15), CON −20 (entrega 25, vida 40). */
function pedido(over = {}) {
  seq += 1;
  return {
    order_id: `m-${seq}`, display_id: String(2000 + seq), status_oficial: "CONCLUDED", status_oficial_em: iso(20),
    order_type: "DELIVERY", delivery_by: "IFOOD", order_timing: "IMMEDIATE", is_test: false,
    order_created_at: iso(60), placed_event_created_at: iso(60), confirmed_event_at: iso(59),
    ready_event_at: iso(49), dispatch_event_at: iso(45), cancel_event_at: null,
    primeiro_evento_em: iso(60), criado_em: iso(60), ...over,
  };
}
const resumo = (pedidos) => montarResumo({ pedidos, agoraMs: AGORA }).indicadores;

describe("vida TOTAL × vida DECOMPOSTA (conjuntos separados, nunca misturados)", () => {
  // 3 pedidos completos (preparo 15, entrega 25, vida 40) + 1 concluído SEM DSP (vida 50, sem preparo nem entrega).
  const completos = [pedido(), pedido(), pedido()];
  const semDsp = pedido({ dispatch_event_at: null, placed_event_created_at: iso(70), order_created_at: iso(70), primeiro_evento_em: iso(70) });
  const ind = resumo([...completos, semDsp]);

  test("a vida TOTAL inclui o pedido sem DSP (PLC e CON válidos); a DECOMPOSTA não", () => {
    assert.equal(ind.vida.amostras, 4);
    assert.equal(ind.vida.mediaDia, 42.5);            // (40×3 + 50) / 4
    assert.equal(ind.vida.decomposta.amostras, 3);
    assert.equal(ind.vida.decomposta.mediaDia, 40);
    assert.equal(ind.vida.decomposta.semSaida, 1);    // quem ficou só na vida total, informado
  });

  test("na DECOMPOSTA, preparo + entrega = vida (mesmo conjunto, mesma amostra nos três números)", () => {
    const d = ind.vida.decomposta;
    assert.equal(d.preparoMediaDia, 15);
    assert.equal(d.entregaMediaDia, 25);
    assert.equal(d.preparoMediaDia + d.entregaMediaDia, d.mediaDia);
  });

  test("a média de preparo/entrega NÃO é a decomposta: cada indicador tem o próprio conjunto e a própria amostra", () => {
    assert.equal(ind.preparo.amostras, 3);   // o sem DSP não tem preparo
    assert.equal(ind.entrega.amostras, 3);
    assert.notEqual(ind.vida.amostras, ind.entrega.amostras);
  });

  test("cada indicador diz quem entra (`conjunto`) e o tamanho da amostra válida", () => {
    for (const k of ["preparo", "entrega", "vida"]) {
      assert.equal(typeof ind[k].conjunto, "string", k);
      assert.ok(ind[k].conjunto.length > 20, k);
      assert.equal(typeof ind[k].amostras, "number", k);
    }
    assert.match(ind.vida.decomposta.conjunto, /preparo \+ entrega = vida/);
    assert.match(ind.vida.conjunto, /mesmo sem o evento de saída/);
  });

  test("a decomposição do ÚLTIMO pedido sem DSP não inventa o trecho que falta", () => {
    const so = resumo([semDsp]).vida;
    assert.equal(so.amostras, 1);
    assert.equal(so.decomposta.amostras, 0);
    assert.equal(so.decomposta.mediaDia, null);
    assert.equal(so.decomposicao.preparo, null);
    assert.equal(so.decomposicao.entrega, null);
    assert.equal(so.decomposicao.detalhePreparo, null);
  });
});

describe("quem NÃO entra nas médias", () => {
  test("cancelado nunca é concluído: fora de preparo, entrega e vida — mesmo depois de DSP/CON", () => {
    const canc = pedido({ status_oficial: "CANCELLED", status_oficial_em: iso(10), cancel_event_at: iso(10) });
    const ind = resumo([canc]);
    for (const k of ["preparo", "entrega", "vida"]) assert.equal(ind[k].amostras, 0, k);
    const r = montarResumo({ pedidos: [canc, pedido()], agoraMs: AGORA });
    assert.equal(r.contagemDia.cancelados, 1);
    assert.equal(r.contagemDia.concluidos, 1);
  });

  test("retirada, pedido sem detalhes e pedido de teste ficam fora dos três e da decomposta", () => {
    const ind = resumo([pedido(), pedido({ order_type: "TAKEOUT", dispatch_event_at: null }), pedido({ order_type: null }), pedido({ is_test: true })]);
    for (const k of ["preparo", "entrega", "vida"]) assert.equal(ind[k].amostras, 1, k);
    assert.equal(ind.vida.decomposta.amostras, 1);
  });

  test("agendado: fora de preparo e vida (e da decomposta), mas dentro da entrega", () => {
    const ind = resumo([pedido(), pedido({ order_timing: "SCHEDULED" })]);
    assert.equal(ind.preparo.amostras, 1);
    assert.equal(ind.vida.amostras, 1);
    assert.equal(ind.vida.decomposta.amostras, 1);
    assert.equal(ind.entrega.amostras, 2);
    assert.equal(ind.preparo.agendadosExcluidos, 1);
  });

  test("em andamento já despachado: tem PREPARO (terminou no despacho), mas não tem entrega nem vida", () => {
    const ind = resumo([pedido({ status_oficial: "DISPATCHED", status_oficial_em: iso(45) })]);
    assert.equal(ind.preparo.amostras, 1);
    assert.equal(ind.preparo.mediaDia, 15);
    assert.equal(ind.entrega.amostras, 0);
    assert.equal(ind.vida.amostras, 0);
  });
});

describe("integridade temporal", () => {
  test("nenhuma duração negativa ou zero entra em média; é descartada e contada", () => {
    const ind = resumo([
      pedido(),
      pedido({ dispatch_event_at: iso(70) }),          // despacho ANTES da chegada
      pedido({ status_oficial_em: iso(50) }),          // conclusão antes do despacho
      pedido({ dispatch_event_at: iso(60) }),          // despacho no mesmo instante da chegada (duração 0)
    ]);
    assert.ok(ind.preparo.mediaDia > 0 && ind.entrega.mediaDia > 0 && ind.vida.mediaDia > 0);
    assert.equal(ind.preparo.descartados, 2);
    assert.equal(ind.entrega.descartados, 1);
    assert.equal(ind.vida.decomposta.amostras, 1);     // só o pedido íntegro entra na decomposta
  });

  test("concluído sem horário de conclusão (status_oficial_em vazio): sem duração e sem horário inventado", () => {
    const sem = pedido({ status_oficial_em: null });
    const ind = resumo([sem]);
    assert.equal(ind.vida.amostras, 0);
    assert.equal(ind.entrega.amostras, 0);
    assert.equal(ind.vida.mediaDia, null);
    assert.equal(ind.preparo.amostras, 1);             // o preparo não depende da conclusão
  });

  test("pedido de ontem concluído hoje não entra nas médias de hoje (pertence ao dia da chegada)", () => {
    const ontem = pedido({ placed_event_created_at: iso(60 + 24 * 60), order_created_at: iso(60 + 24 * 60), primeiro_evento_em: iso(60 + 24 * 60), criado_em: iso(60 + 24 * 60), dispatch_event_at: iso(45 + 24 * 60), status_oficial_em: iso(20) });
    const ind = resumo([ontem]);
    assert.equal(ind.vida.amostras, 0);
    assert.equal(ind.preparo.amostras, 0);
  });
});
