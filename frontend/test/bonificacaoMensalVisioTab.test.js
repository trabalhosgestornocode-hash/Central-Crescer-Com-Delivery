// Aba "Visio" (renderLancamentos) — competência fechada pelo LANÇAMENTO MENSAL
// DIRETO não deve exibir "31 dias pendentes / 0% alimentado". A decisão vem do
// backend (d.alimentacaoMes, testado em backend/bonificacao-mensal-calc.test.js
// #resumoAlimentacaoMes); aqui garantimos que o frontend a respeita.
//
// Testes por asserção no fonte (mesma convenção de bonificacaoMensalFechamento.test.js) —
// bonificacaoMensal.js é DOM-heavy e não é importável sem um jsdom completo.
//
// Rodar: node --test frontend/test/bonificacaoMensalVisioTab.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../src/bonificacaoMensal.js", import.meta.url)), "utf8");
const CODIGO = SRC.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n"); // ignora comentários

describe("aba Visio — competência fechada por fechamento_mensal_direto", () => {
  test("renderLancamentos ramifica por d.alimentacaoMes.mostrarCalendarioDiario", () => {
    assert.match(CODIGO, /const a = d\.alimentacaoMes \|\|/);
    assert.match(CODIGO, /if \(a\.mostrarCalendarioDiario === false\) \{/);
    assert.match(CODIGO, /box\.innerHTML = fechamentoMensalDiretoHtml\(d\)/);
  });

  test("% e contagem vêm do backend (a.pct / a.contagem), não são recalculados no cliente", () => {
    assert.match(CODIGO, /const contagem = a\.contagem \|\| \{\}/);
    assert.match(CODIGO, /width:\$\{a\.pct\}%/);
    assert.match(CODIGO, /fmtPct\(a\.pct\)\} do mês alimentado/);
    // não sobrou a conta antiga baseada só no calendário
    assert.doesNotMatch(CODIGO, /alimentados \/ passados/);
    assert.doesNotMatch(CODIGO, /d\.calendario\.length - \(contagem\.FUTURO/);
  });

  test("card de mês fechado mostra 100% e os indicadores congelados do snapshot", () => {
    assert.match(CODIGO, /function fechamentoMensalDiretoHtml\(d\)/);
    assert.match(CODIGO, /fechado pelo lançamento mensal/i);
    assert.match(CODIGO, /Competência alimentada: <b>100%<\/b>|width:100%/);
    assert.match(CODIGO, /d\.valoresOficiais/);
    assert.match(CODIGO, /Ver os indicadores congelados/);
    assert.match(CODIGO, /Bonificação \(definitiva\)/);
  });

  test("acompanhamento_diario / legado -> calendário histórico + nota de consolidado", () => {
    assert.match(CODIGO, /const consolidado = d\.congelado === true/);
    assert.match(CODIGO, /O mês está 100% consolidado/);
    // o calendário (dex-cal) ainda é renderizado nesse caminho
    assert.match(CODIGO, /d\.calendario\.map\(\(dia\) => diaHtml\(dia\)\)/);
  });
});

describe("Visão Geral — sem gráfico de evolução diária no fechamento direto", () => {
  test("semEvolucaoDiaria guarda os 2 gráficos + as 2 seções", () => {
    assert.match(CODIGO, /const semEvolucaoDiaria = d\.congelado === true && d\.alimentacaoMes\?\.origem === "fechamento_mensal_direto"/);
    assert.match(CODIGO, /\$\{semEvolucaoDiaria \? "" : evolucaoFaturamentoHtml\(d\)\}/);
    assert.match(CODIGO, /\$\{semEvolucaoDiaria \? "" : evolucaoMixHtml\(d\)\}/);
    assert.match(CODIGO, /if \(!semEvolucaoDiaria\) \{[\s\S]*graficoEvolucaoFaturamento/);
  });
});

describe("Histórico — origem do fechamento visível", () => {
  test("card de mês fechado mostra o rótulo da origem", () => {
    assert.match(CODIGO, /const ORIGEM_RESULTADO_ROTULO = \{/);
    assert.match(SRC, /fechamento_mensal_direto: "Fechado · lançamento mensal direto"/);
    assert.match(SRC, /acompanhamento_diario: "Fechado · acompanhamento diário"/);
    assert.match(CODIGO, /m\.congelado \? `<span class="bm-hist-origem">\$\{escapeHtml\(ORIGEM_RESULTADO_ROTULO\[m\.origemResultado\]/);
  });
});

describe("não mistura fontes / não fabrica dias", () => {
  test("o frontend nunca cria linhas de calendário artificiais para uma competência fechada", () => {
    assert.doesNotMatch(CODIGO, /Array\.from\(\{ ?length: ?31/);
    assert.doesNotMatch(CODIGO, /calendario\.push/);
  });
  test("mesTemDados continua reconhecendo competência congelada", () => {
    assert.match(CODIGO, /if \(d\.congelado\) return true;/);
  });
});
