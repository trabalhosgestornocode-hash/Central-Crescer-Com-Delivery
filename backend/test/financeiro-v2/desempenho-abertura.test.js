// Desempenho e experiência da abertura do Crescer Com Delivery Financeiro (frontend): cache curto em memória sem misturar contextos,
// invalidação após ação confirmada, erro nunca guardado, aviso de demonstração fora da plataforma, favicon e título oficiais.
// Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { criarConsultor, enviar, invalidarCache } from "../../../frontend/financeiro-v2/consulta.js";

const resp = (ok, corpo, status = ok ? 200 : 500) => ({ ok, status, json: async () => corpo });
const contador = (respostas) => { const f = async (...a) => { f.chamadas.push(a[0]); return typeof respostas === "function" ? respostas(a[0]) : respostas; }; f.chamadas = []; return f; };

test("a mesma consulta é reaproveitada; URL diferente (competência/filtro) ou sessão de demonstração diferente NÃO", async () => {
  invalidarCache();
  const f = contador((u) => resp(true, { u }));
  const c = criarConsultor(f);
  const a = await c.consultar("/api/fv2/dre?competencia=2026-09", {});
  const b = await c.consultar("/api/fv2/dre?competencia=2026-09", {});
  assert.deepEqual(a, b);
  assert.equal(f.chamadas.length, 1);
  await c.consultar("/api/fv2/dre?competencia=2026-10", {});
  await c.consultar("/api/fv2/dre?competencia=2026-09", { "x-fv2-demo-sessao": "outra" });
  assert.equal(f.chamadas.length, 3);
});

test("o cache devolve cópia: alterar o resultado não suja a próxima leitura", async () => {
  invalidarCache();
  const c = criarConsultor(contador(() => resp(true, { total: 10 })));
  const a = await c.consultar("/x", {});
  a.dados.total = 999;
  assert.equal((await c.consultar("/x", {})).dados.total, 10);
});

test("erro nunca fica guardado", async () => {
  invalidarCache();
  let falha = true;
  const f = contador(() => (falha ? resp(false, { erro: "FALHA" }) : resp(true, { ok: 1 })));
  const c = criarConsultor(f);
  assert.equal((await c.consultar("/y", {})).ok, false);
  falha = false;
  assert.equal((await c.consultar("/y", {})).ok, true);
  assert.equal(f.chamadas.length, 2);
});

test("ação confirmada esvazia o cache; ação recusada não", async () => {
  invalidarCache();
  const f = contador(() => resp(true, { v: 1 }));
  const c = criarConsultor(f);
  await c.consultar("/z", {});
  await enviar("/acao", {}, {}, async () => resp(false, { erro: "NEGADO" }, 403));
  await c.consultar("/z", {});
  assert.equal(f.chamadas.length, 1, "ação recusada mantém o cache");
  await enviar("/acao", {}, {}, async () => resp(true, {}));
  await c.consultar("/z", {});
  assert.equal(f.chamadas.length, 2, "ação confirmada força releitura");
});

test("sem cache quando desligado (consultor de leitura ao vivo)", async () => {
  invalidarCache();
  const f = contador(() => resp(true, {}));
  const c = criarConsultor(f, { usarCache: false });
  await c.consultar("/w", {}); await c.consultar("/w", {});
  assert.equal(f.chamadas.length, 2);
});

test("cabeçalho do HTML: favicon oficial versionado, título, e aviso de demonstração só fora da plataforma", async () => {
  const html = await readFile(new URL("../../../frontend/financeiro-v2/index.html", import.meta.url), "utf8");
  assert.match(html, /<title>Crescer Com Delivery Financeiro<\/title>/);
  assert.match(html, /rel="icon"[^>]*logo-crescer-central\.jpeg\?v=\d+/);
  assert.match(html, /apple-touch-icon/);
  const tema = await readFile(new URL("../../../frontend/financeiro-v2/tema.js", import.meta.url), "utf8");
  assert.match(tema, /get\("modo"\) === "plataforma"/);
  assert.match(tema, /dataset\.modo = "plataforma"/);
  const css = await readFile(new URL("../../../frontend/financeiro-v2/fv2.css", import.meta.url), "utf8");
  assert.match(css, /data-modo="plataforma"\][^{]*faixa-demo[^{]*\{[^}]*display:\s*none/);
});

test("erro de leitura oferece 'Tentar novamente' (só no estado de erro); cache é esvaziado ao sair, trocar sessão/unidade e atualizar", async () => {
  const telas = await readFile(new URL("../../../frontend/financeiro-v2/telas.js", import.meta.url), "utf8");
  assert.match(telas, /tipo === "erro" \? '<p><button type="button" class="botao" data-tentar-novamente>Tentar novamente<\/button><\/p>'/);
  const app = await readFile(new URL("../../../frontend/financeiro-v2/app.js", import.meta.url), "utf8");
  assert.match(app, /closest\("\[data-tentar-novamente\], #atualizar-dados"\)\) \{ invalidarCache\(\); carregar\(\); return; \}/);
  assert.match(app, /invalidarCache\(\); \/\/ ao encerrar a sessão/);
  assert.match(app, /#filtro-unidade"\)\.addEventListener\("change", \(e\) => \{[^}]*invalidarCache\(\)/);
  assert.match(app, /#filtro-sessao"\)\.addEventListener\("change", \(e\) => \{ invalidarCache\(\)/);
  // O reenvio nunca é automático: nenhum laço de repetição em torno de enviar().
  assert.doesNotMatch(app, /setInterval|retry|tentarDeNovo/i);
  const html = await readFile(new URL("../../../frontend/financeiro-v2/index.html", import.meta.url), "utf8");
  assert.match(html, /id="atualizar-dados"/);
});

test("nada financeiro é guardado de forma persistente no navegador (sem localStorage/sessionStorage/IndexedDB/cookie nos módulos de dados)", async () => {
  for (const arq of ["consulta.js", "app.js", "telas.js", "telasTesouraria.js"]) {
    const src = await readFile(new URL(`../../../frontend/financeiro-v2/${arq}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /localStorage\.setItem|sessionStorage\.setItem|indexedDB|document\.cookie\s*=/, arq);
  }
});
