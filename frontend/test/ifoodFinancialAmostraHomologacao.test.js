// Aviso "Dados de exemplo do ambiente de homologação do iFood" nas abas Sales e
// Financial Events: aparece só quando o BACKEND marca a resposta como fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/ifood.js"), "utf8").replace(/\r\n/g, "\n");
const inicio = SRC.indexOf("function avisoAmostraHomologacao(");
const FN = SRC.slice(inicio, SRC.indexOf("\n}\n", inicio) + 2);

// Executa a função isolada com dependências mínimas (esc/fmtDataSimples) para checar o HTML.
const aviso = new Function("esc", "fmtDataSimples", `${FN}; return avisoAmostraHomologacao;`)(
  (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
  (d) => { const m = String(d ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : "—"; },
);

test("aviso aparece para resposta de fixture (Sales), com texto exigido, loja mascarada e período da amostra", () => {
  const html = aviso({ fonte: "fixture", amostraHomologacao: true, amostra: { merchants: ["f07d****7c00"], periodo: { inicio: "2025-08-01", fim: "2025-08-01" } } });
  assert.match(html, /Dados de exemplo do ambiente de homologação do iFood/);
  assert.match(html, /Os registros exibidos são fornecidos pelo ambiente de homologação do iFood e podem representar uma loja de exemplo diferente da loja vinculada\./);
  assert.match(html, /Loja de exemplo: <span class="mono">f07d\*\*\*\*7c00<\/span>/);
  assert.match(html, /período da amostra: 01\/08\/2025 a 01\/08\/2025/);
  assert.match(html, /ifood-aviso warn/, "aviso informativo, não erro (bad)");
});

test("aviso aparece para Events de fixture mesmo sem período da amostra", () => {
  const html = aviso({ fonte: "fixture", amostraHomologacao: true, amostra: { merchants: ["f07d****7c00"], periodo: null } });
  assert.match(html, /Dados de exemplo do ambiente de homologação do iFood/);
  assert.doesNotMatch(html, /período da amostra/);
});

test("aviso NÃO aparece para dado real nem sem resposta", () => {
  for (const r of [null, undefined, { fonte: "real", amostraHomologacao: false }, { fonte: "real" }]) assert.equal(aviso(r), "", JSON.stringify(r));
});

test("aviso é usado nas abas Sales e Financial Events (uma vez cada)", () => {
  assert.equal((SRC.match(/\$\{avisoAmostraHomologacao\(r\)\}/g) ?? []).length, 2);
  const sales = SRC.slice(SRC.indexOf("function conteudoAbaSales("), SRC.indexOf("function conteudoAbaEvents("));
  assert.match(sales, /\$\{avisoAmostraHomologacao\(r\)\}/);
  assert.match(sales, /Total de vendas \$\{r\.amostraHomologacao \? "na amostra" : "no período"\}/);
  const events = SRC.slice(SRC.indexOf("function conteudoAbaEvents("));
  assert.match(events.slice(0, events.indexOf("\n}\n")), /\$\{avisoAmostraHomologacao\(r\)\}/);
});

test("loja da fixture é rotulada como 'Loja de exemplo', nunca como a loja vinculada; o frontend não decide o modo", () => {
  assert.doesNotMatch(FN, /merchant\.nome|razaoSocial|Loja vinculada/);
  assert.doesNotMatch(FN, /localStorage|location|query|unidadeId/);
});
