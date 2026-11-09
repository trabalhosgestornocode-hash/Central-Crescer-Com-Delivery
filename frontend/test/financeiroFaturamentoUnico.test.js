// Faturamento único no dashboard: só o Faturamento bruto gerencial aparece como KPI; o total do painel (SAIPOS) fica só na composição.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cartao } from "../src/financeiro/painel.js";
import { EXPLICACOES } from "../src/financeiro/explicacoes.js";

const canal = (rotulo, centavos, pctBrutoBps, extra = {}) => ({ id: `canal:${rotulo}`, rotulo, centavos, pctBrutoBps, situacao: "confirmado", origemTecnica: ["x"], ...extra });
const comp = {
  id: "faturamentoBruto", rotulo: "Faturamento bruto", valorCentavos: 8318338, unidade: "moeda", situacao: "confirmado",
  componentes: [canal("Balcão", 5040953, 6060), canal("Anota Aí", 202182, 243), canal("iFood", 3075203, 3697, { situacao: "pendente_contadora" })],
  pendencias: ["Ajuste de R$ 788,15 (iFood) está estimado e aguarda confirmação."],
  canalConferencia: { somaCentavos: 8318338, brutoOficialCentavos: 8318338, diferencaCentavos: 0, confere: true, painelCentavos: 8472602, ajustesCentavos: -154264, ponteFecha: true },
};

test("o card de faturamento mostra R$ 83.183,38, a composição por canal e o ajuste iFood pendente, sem o total do painel", () => {
  const h = cartao("faturamentoBruto", "Faturamento bruto", comp, { destaque: true });
  assert.match(h, /83\.183,38/);
  assert.match(h, /Faturamento bruto/);
  assert.match(h, /60,60%/); assert.match(h, /2,43%/); assert.match(h, /36,97%/);
  assert.equal(6060 + 243 + 3697, 10000, "os percentuais dos três canais somam 100%");
  assert.match(h, /inclui ajuste estimado/);
  assert.match(h, /aguarda confirmação/);
  assert.match(h, /Ver composição completa/); assert.match(h, /data-fin-valor="faturamentoBruto"/);
  assert.doesNotMatch(h, /84\.726,02/); assert.doesNotMatch(h, /84\.726/); assert.doesNotMatch(h, /Total de vendas por canal/);
});

test("não existe mais o indicador 'Total de vendas por canal' na interface", () => {
  assert.equal(EXPLICACOES.totalVendasCanais, undefined);
  const painel = readFileSync(new URL("../src/financeiro/painel.js", import.meta.url), "utf8");
  assert.doesNotMatch(painel, /Total de vendas por canal/); assert.doesNotMatch(painel, /c\("totalVendasCanais"\)/);
  const f = EXPLICACOES.faturamentoBruto;
  assert.match(f.simples, /antes de qualquer desconto, taxa ou imposto/);
  assert.match(f.cuidado, /Venda não é dinheiro na conta/);
  assert.match(f.formula, /base gerencial por canal = total do painel \(SAIPOS\) \+ ajustes; coincide com as vendas diárias do mês/);
});
