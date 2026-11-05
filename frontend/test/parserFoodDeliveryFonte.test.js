import { test } from "node:test";
import assert from "node:assert/strict";
import { fonteLogisticaHtml, temFonteFoody, temDiaSoFoody } from "../src/parserFoodDeliveryFonte.js";

const fmt = { fmtMoeda: (n) => `R$ ${Number(n).toFixed(2)}`, escapeHtml: (s) => String(s).replace(/</g, "&lt;") };
const bloco = {
  dias: [
    { competencia: "2026-11-02", fonte: "EXCEL", pedidos: 70, entregues: 64, taxaBruta: 679, taxaValida: 622, custoLogisticoAtribuido: null, foodyIgnorado: { versao: 2 } },
    { competencia: "2026-11-03", fonte: "FOODY", versao: 1, pedidos: 60, entregues: 58, taxaBruta: 600, taxaValida: 580, custoLogisticoAtribuido: 500 },
    { competencia: "2026-11-04", fonte: "FOODY_PENDENTE", pendencias: ["TRIAGEM_PENDENTE"], pedidos: 50, entregues: 49, taxaBruta: 500, taxaValida: 490 },
    { competencia: "2026-11-05", fonte: "SEM_DADOS", pedidos: 0, entregues: 0 },
  ],
  totais: { dias: { excel: 1, foody: 1 }, pedidos: 130, entregues: 122, taxaBruta: 1279, taxaValida: 1202, custoLogisticoAtribuido: null, custoRealConciliado: null, diasForaDoTotal: 1 },
};

test("mostra uma linha por dia com dado, a fonte de cada um e os totais do backend (sem recalcular)", () => {
  const h = fonteLogisticaHtml(bloco, fmt);
  assert.equal((h.match(/<tr data-fonte=/g) ?? []).length, 3, "SEM_DADOS não vira linha");
  assert.match(h, /data-fonte="EXCEL"[\s\S]*Foody só como conferência/);
  assert.match(h, /data-fonte="FOODY"[\s\S]*versão 1/);
  assert.match(h, /data-fonte="FOODY_PENDENTE"[\s\S]*fora do total: pedido em triagem/);
  assert.match(h, /<th class="num">130<\/th>/, "total de pedidos é o do backend (pendente fora)");
  assert.match(h, /1 dia ficou fora do total/);
  assert.match(h, /nunca são somadas/);
});
test("dia Excel nunca mostra custo atribuído; erro de leitura vira aviso e não números", () => {
  const h = fonteLogisticaHtml(bloco, fmt);
  assert.match(h, /data-fonte="EXCEL">[\s\S]*?<td class="num">—<\/td>\s*<td>Foody só/);
  assert.match(fonteLogisticaHtml({ erro: "FONTE_FOODY_INDISPONIVEL" }, fmt), /não puderam ser lidos/);
  assert.equal(fonteLogisticaHtml(null, fmt), "");
  assert.equal(fonteLogisticaHtml({ dias: [{ competencia: "2026-11-05", fonte: "SEM_DADOS" }], totais: {} }, fmt), "");
});
test("predicados: há Foody? há dia só-Foody?", () => {
  assert.equal(temFonteFoody(bloco), true);
  assert.equal(temDiaSoFoody(bloco), true);
  assert.equal(temFonteFoody({ dias: [{ fonte: "EXCEL" }, { fonte: "SEM_DADOS" }] }), false);
  assert.equal(temDiaSoFoody({ dias: [{ fonte: "FOODY_PENDENTE" }] }), false);
  assert.equal(temFonteFoody(null), false);
});
