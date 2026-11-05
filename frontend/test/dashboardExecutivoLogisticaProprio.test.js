// Bloco "Entregadores próprios · Foody" no Dashboard Executivo (apresentação). Dados FICTÍCIOS.
// Rodar: node --test frontend/test/dashboardExecutivoLogisticaProprio.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { logisticaProprioHtml } = await import("../src/dashboardExecutivoLogisticaProprio.js");
const ler = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const BLOCO = {
  fonte: "foody_api", somadoAoResultadoOficial: false, aviso: "Informativo — não compõe deduções nem rentabilidade.",
  dias: { definitivos: 3, pendentes: 1, incompletos: 0 }, parcial: true,
  custoAtribuido: 1632, taxaPrevista: 635, taxaCobradaCliente: null, taxaCobradaClienteMotivo: "Não consta no fechamento Foody.",
  pagamentoConciliado: null, pagamentoConciliadoMotivo: "Conciliação é feita pelo Parser.",
};

describe("desligado por padrão", () => {
  test("sem a chave do backend nada é renderizado", () => {
    for (const v of [undefined, null, "", 0, false]) assert.equal(logisticaProprioHtml(v), "");
  });
  test("a aba só acrescenta o bloco depois dos indicadores oficiais e sem tocar neles", () => {
    const src = ler("../src/dashboardExecutivo.js");
    assert.match(src, /renderIndicadores\(box, dex\.dadosMes\);\s*\n\s*\/\/[^\n]*\n\s*box\.insertAdjacentHTML\("beforeend", logisticaProprioHtml\(dex\.dadosMes\.logisticaProprio\)\)/);
    assert.equal((src.match(/logisticaProprioHtml\(/g) ?? []).length, 1);
  });
  test("módulo é só formatação: sem rede, sem cálculo financeiro", () => {
    const m = ler("../src/dashboardExecutivoLogisticaProprio.js");
    const imports = m.split("\n").filter((l) => l.startsWith("import ")).join(" ");
    assert.doesNotMatch(imports, /api\.js|state\.js|dashboardExecutivo\.js/);
    assert.doesNotMatch(m, /fetch\(|dashExec/);
  });
});

describe("distinção das grandezas", () => {
  const html = logisticaProprioHtml(BLOCO);
  test("quatro linhas separadas, rotuladas, sem confundir com 'Taxas de entregadores' do iFood", () => {
    for (const r of ["Custo atribuído", "Taxa prevista", "Taxa cobrada do cliente", "Pagamento conciliado"]) assert.match(html, new RegExp(r));
    assert.doesNotMatch(html, />Taxas de entregadores</);
    assert.match(html, /Entregadores próprios · Foody/);
  });
  test("o que não existe aparece como — com motivo, nunca como R$ 0,00", () => {
    assert.match(html, /Não consta no fechamento Foody/);
    assert.match(html, /Conciliação é feita pelo Parser/);
    const celulas = [...html.matchAll(/data-lp-valor>([^<]*)</g)].map((m) => m[1]);
    assert.equal(celulas[2], "—"); assert.equal(celulas[3], "—");
  });
  test("período parcial é declarado", () => {
    assert.match(html, /data-logistica-proprio="parcial"/);
    assert.match(html, /1 dia\(s\) pendente\(s\)\/incompleto\(s\) fora dos valores/);
  });
});

describe("dados preliminares nunca viram custo definitivo", () => {
  test("sem dia definitivo: sem valores e mensagem explícita", () => {
    const html = logisticaProprioHtml({ ...BLOCO, dias: { definitivos: 0, pendentes: 2, incompletos: 0 }, custoAtribuido: null, taxaPrevista: null });
    assert.match(html, /data-logistica-proprio="sem-valor"/);
    assert.match(html, /Nenhum dia com fechamento definitivo/);
    const celulas = [...html.matchAll(/data-lp-valor>([^<]*)</g)].map((m) => m[1]);
    assert.ok(celulas.every((c) => c === "—"), celulas.join("|"));
  });
});

describe("isolamento e segurança", () => {
  test("erro do backend: mensagem neutra, sem valores, sem vazar o código", () => {
    const html = logisticaProprioHtml({ erro: "FONTE_FOODY_TENANT_DIVERGENTE" });
    assert.match(html, /data-logistica-proprio="erro"/);
    assert.doesNotMatch(html, /TENANT|R\$/);
  });
  test("texto vindo do backend é escapado (sem HTML injetado)", () => {
    const html = logisticaProprioHtml({ ...BLOCO, aviso: '<img src=x onerror=alert(1)>', taxaCobradaClienteMotivo: "<script>x</script>" });
    assert.doesNotMatch(html, /<img|<script/);
  });
  test("o front não escolhe unidade nem organização: nada no módulo referencia ids de tenant", () => {
    assert.doesNotMatch(ler("../src/dashboardExecutivoLogisticaProprio.js"), /unidade_?id|organizacao_?id|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
