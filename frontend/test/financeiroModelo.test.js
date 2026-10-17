// Rodar: node --test frontend/test/financeiroModelo.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { moeda, pct, periodoDoMes, mesAnterior, queryString, descreverSaldo, variacaoTexto, rotuloMes, dataBr, diaMes } from "../src/financeiro/modelo.js";
import { tetoEixo, graficoEntradasSaidas, graficoBarrasHorizontais, estado } from "../src/financeiro/graficos.js";

const nb = (s) => s.replace(/ /g, " ");

test("moeda: centavos exatos, negativo, sinal e ausente (nunca R$ 0,00 para null)", () => {
  assert.equal(nb(moeda(7769484)), "R$ 77.694,84");
  assert.equal(nb(moeda(-1234)), "−R$ 12,34");
  assert.equal(nb(moeda(5, { sinal: true })), "+R$ 0,05");
  assert.equal(nb(moeda(0)), "R$ 0,00");
  assert.equal(moeda(null), "—");
  assert.equal(moeda(undefined), "—");
  assert.equal(moeda(Number.NaN), "—");
});

test("percentual: bps → texto; é percentual, nunca moeda; null vira traço", () => {
  assert.equal(pct(1888), "18,88%");
  assert.equal(pct(-5), "−0,05%");
  assert.equal(pct(null), "—");
});

test("períodos: mês, mês anterior, bissexto e entradas inválidas", () => {
  assert.deepEqual(periodoDoMes("2026-09"), { de: "2026-09-01", ate: "2026-09-30" });
  assert.deepEqual(periodoDoMes("2028-02"), { de: "2028-02-01", ate: "2028-02-29" });
  assert.equal(periodoDoMes("2026-13"), null);
  assert.equal(mesAnterior("2026-01"), "2025-12");
  assert.equal(rotuloMes("2026-09"), "setembro/2026");
  assert.equal(dataBr("2026-09-02"), "02/09/2026");
  assert.equal(diaMes("2026-09-02"), "02/09");
});

test("queryString ignora vazios e escapa", () => {
  assert.equal(queryString({ de: "2026-09-01", busca: "a b&c", x: "", y: null }), "?de=2026-09-01&busca=a%20b%26c");
  assert.equal(queryString({}), "");
});

test("saldo: abertura desconhecida é parcial e mostra só o movimento", () => {
  const p = descreverSaldo({ saldoCentavos: null, saldoSemAberturaCentavos: 415505 });
  assert.equal(p.parcial, true);
  assert.match(nb(p.detalhe), /Abertura desconhecida · movimento R\$ 4\.155,05/);
  const ok = descreverSaldo({ saldoCentavos: 26023, aberturaCentavos: 22766, variacao: 3257 });
  assert.equal(ok.parcial, false);
  assert.equal(nb(ok.principal), "R$ 260,23");
});

test("variação: base zero não gera percentual; ausente gera null", () => {
  assert.equal(variacaoTexto(null, 5), null);
  assert.doesNotMatch(variacaoTexto(100, 0).texto, /%/);
  assert.match(nb(variacaoTexto(150, 100).texto), /\+50,00%/);
});

test("eixo: teto bonito cobre o máximo", () => {
  for (const m of [1, 99, 1234, 7769484, 100000]) assert.ok(tetoEixo(m) >= m);
  assert.equal(tetoEixo(0), 100);
  assert.equal(tetoEixo(100000), 100000);
});

test("gráfico entradas×saídas: legenda, tabela alternativa, rótulo acessível e escapa HTML", () => {
  const html = graficoEntradasSaidas([
    { periodo: "2026-09-01", entradas: 100000, saidas: 40000, saldo: 60000 },
    { periodo: "2026-09-02", entradas: 0, saidas: 25000, saldo: -25000 },
  ], { titulo: "Teste <b>x</b>" });
  assert.match(html, /role="img"/);
  assert.match(html, /fin-legenda/);
  assert.match(html, /Ver como tabela/);
  assert.match(html, /Teste &lt;b&gt;x&lt;\/b&gt;/);
  assert.equal((html.match(/class="fin-bar"/g) ?? []).length, 3); // barra zerada não é desenhada
  assert.equal(graficoEntradasSaidas([]), "");
});

test("barras horizontais: valor e participação como rótulo direto; vazio devolve string vazia", () => {
  const html = graficoBarrasHorizontais([{ rotulo: "ALUGUEL", centavos: 100000, participacaoBps: 6250 }, { rotulo: "LUZ", centavos: 60000, participacaoBps: 3750 }]);
  assert.match(html, /62,50%/);
  assert.match(html, /width:100%/);
  assert.match(html, /width:60%/);
  assert.equal(graficoBarrasHorizontais([]), "");
  assert.equal(graficoBarrasHorizontais([{ rotulo: "x", centavos: 0 }]), "");
});

test("estados: erro anuncia role=alert e oferece nova tentativa", () => {
  assert.match(estado.erro("falhou"), /role="alert"/);
  assert.match(estado.erro("falhou"), /data-fin-retry/);
  assert.match(estado.carregando(), /aria-live/);
});
