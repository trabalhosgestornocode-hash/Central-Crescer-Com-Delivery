// Central → Conversas: o estado de entrega da mensagem enviada aparece em TEXTO ("Enviada", "Entregue 10:32", "Lida 10:35"), não só em cor/pontos/tooltip.
// Regras (incidente 25/09/2026, item 6 do pedido): a hora vem só do carimbo do PRÓPRIO estado; "Lida" só quando o banco diz READ (o RPC só avança com receipt real do provider);
// sem dado confiável não se inventa hora nem se promove o estado (permanece no último comprovado).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rotuloEntrega, trilhaDe } from "../src/central/centralModelo.js";
import { htmlMensagem, htmlFluxo, trilha } from "../src/central/centralUi.js";

const AGORA = new Date(2026, 8, 25, 12, 0, 0);
const local = (h, m = 0) => new Date(2026, 8, 25, h, m, 0).toISOString();
const saida = (o = {}) => ({ id: "m1", direcao: "saida", categoria: "manual", tipo: "texto", texto: "Bom dia", status: "SENT", em: local(2, 58), enviadoEm: local(2, 58), entregueEm: null, lidoEm: null, operador: "Camila", ...o });
const texto = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("rotuloEntrega — o último estado COMPROVADO, em texto", () => {
  test("SENT ⇒ 'Enviada' (sem hora extra: a hora de envio já está na bolha)", () => assert.equal(rotuloEntrega(saida({ status: "SENT" })), "Enviada"));
  test("DELIVERED ⇒ 'Entregue' + hora da ENTREGA quando existe", () => {
    assert.equal(rotuloEntrega(saida({ status: "DELIVERED", entregueEm: local(3, 0) })), "Entregue 03:00");
    assert.equal(rotuloEntrega(saida({ status: "DELIVERED", entregueEm: null })), "Entregue", "sem carimbo confiável, sem hora");
  });
  test("READ ⇒ 'Lida' + hora da LEITURA quando existe; a hora da entrega não vira hora de leitura", () => {
    assert.equal(rotuloEntrega(saida({ status: "READ", entregueEm: local(3, 0), lidoEm: local(3, 2) })), "Lida 03:02");
    assert.equal(rotuloEntrega(saida({ status: "READ", entregueEm: local(3, 0), lidoEm: null })), "Lida");
  });
  test("NUNCA promove: SENT com lidoEm/entregueEm preenchidos continua 'Enviada'; DELIVERED com lidoEm continua 'Entregue' (o estado é o do banco)", () => {
    assert.equal(rotuloEntrega(saida({ status: "SENT", entregueEm: local(3, 0), lidoEm: local(3, 2) })), "Enviada");
    assert.equal(rotuloEntrega(saida({ status: "DELIVERED", entregueEm: local(3, 0), lidoEm: local(3, 2) })), "Entregue 03:00");
  });
  test("estados que não são entrega (agendada, enviando, falhou, entrega incerta, cancelada, bloqueada) e entradas inválidas ⇒ '' (têm o próprio rótulo)", () => {
    for (const s of ["SCHEDULED", "PROCESSING", "SENDING", "FAILED", "DELIVERY_UNKNOWN", "CANCELLED", "BLOCKED", "", undefined, "INVENTADO"]) assert.equal(rotuloEntrega(saida({ status: s })), "", String(s));
    assert.equal(rotuloEntrega(null), ""); assert.equal(rotuloEntrega(undefined), ""); assert.equal(rotuloEntrega({}), "");
  });
  test("carimbo inválido não vira hora (nem '1970', nem 'NaN')", () => {
    for (const ruim of ["ontem", "", 0, {}, "0000-00-00"]) assert.equal(rotuloEntrega(saida({ status: "DELIVERED", entregueEm: ruim })), "Entregue");
  });
});

describe("bolha da conversa — o estado aparece em texto", () => {
  test("SENT: 'Enviada' visível; sem 'Entregue'/'Lida' (a trilha continua distinguindo SENT de DELIVERED)", () => {
    const t = texto(htmlMensagem(saida()));
    assert.match(t, /02:58/); assert.match(t, /\bEnviada\b/); assert.ok(!/Entregue|Lida/.test(t.replace("Enviada ao WhatsApp", "")));
    assert.deepEqual(trilhaDe("SENT").map((m) => m.estado), ["feito", "pendente", "pendente"]);
  });
  test("DELIVERED: 'Entregue 03:00' visível; nada de 'Lida'", () => {
    const t = texto(htmlMensagem(saida({ status: "DELIVERED", entregueEm: local(3, 0) })));
    assert.match(t, /Entregue 03:00/); assert.ok(!/\bLida\b/.test(t));
  });
  test("READ: 'Lida 03:02' visível", () => {
    assert.match(texto(htmlMensagem(saida({ status: "READ", entregueEm: local(3, 0), lidoEm: local(3, 2) }))), /Lida 03:02/);
  });
  test("o texto do estado NÃO depende só de cor: existe como texto (não só no aria-label/tooltip) e leva a classe do estado", () => {
    const h = htmlMensagem(saida({ status: "DELIVERED", entregueEm: local(3, 0) }));
    assert.match(h, /<span class="cc-status-txt cc-status-txt--delivered">Entregue 03:00<\/span>/);
    assert.match(h, /aria-label="Entregue\./, "o rótulo acessível da trilha continua presente");
  });
  test("estados que já tinham rótulo continuam idênticos (Agendada, Falhou, Entrega não confirmada) — sem rótulo duplicado", () => {
    for (const [s, r] of [["SCHEDULED", "Agendada"], ["FAILED", "Falhou"], ["DELIVERY_UNKNOWN", "Entrega não confirmada"]]) {
      const h = htmlMensagem(saida({ status: s })); const n = (texto(h).match(new RegExp(r, "g")) ?? []).length;
      assert.equal(n, 1, `${s}: '${r}' aparece uma vez`);
    }
  });
  test("mensagem RECEBIDA não ganha rótulo de entrega", () => {
    const h = htmlMensagem({ id: "e1", direcao: "entrada", categoria: "recebida", tipo: "texto", texto: "Oi", status: null, em: local(3, 5) });
    assert.ok(!/cc-status-txt/.test(h)); assert.ok(!/Enviada|Entregue|Lida/.test(texto(h)));
  });
  test("segurança: rótulo é escapado e a trilha aceita 'rotulo' sem quebrar o HTML", () => {
    assert.match(trilha("READ", { rotulo: "<b>x</b>" }), /&lt;b&gt;x&lt;\/b&gt;/);
    const f = htmlFluxo({ mensagens: [saida({ status: "READ", lidoEm: local(3, 2) }), saida({ id: "m2", status: "SENT" })], janelaHoras: 24, agora: AGORA });
    assert.equal((f.match(/data-cc-msg=/g) ?? []).length, 2); assert.match(texto(f), /Lida 03:02/); assert.match(texto(f), /\bEnviada\b/);
  });
});
