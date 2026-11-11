// Lançamento rápido em NAVEGADOR REAL (Chrome via Playwright) contra o SERVIDOR REAL do domínio financeiro (rotas, validações e permissões
// de verdade) com repositório em MEMÓRIA e dados sintéticos. Nunca fala com Supabase, produção nem rede externa.
// Prova: três toques para lançar, categoria sugerida pelo histórico (visível e trocável), "Já paguei" × "Vou pagar depois" (conta a pagar),
// transferência entre contas, "Registrar e lançar outro", mensagens simples nos erros e perfil sem permissão.
//
// Rodar:  FIN_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright FIN_BROWSER_CHANNEL=chrome \
//         node --test frontend/test/lancamentoRapido.browser.test.js        (FIN_SCREENSHOTS=<pasta> grava capturas)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BACKEND = resolve(RAIZ, "..", "backend");
const reqBackend = createRequire(pathToFileURL(join(BACKEND, "package.json")));
let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.FIN_PLAYWRIGHT_PATH || process.env.CHECKLIST_PLAYWRIGHT_PATH || "playwright")); } catch { /* sem Playwright: pulado */ }
const PULAR = !chromium && "Configure FIN_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.FIN_BROWSER_CHANNEL || process.env.CHECKLIST_BROWSER_CHANNEL;
const CAPTURAS = process.env.FIN_SCREENSHOTS;
const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/financeiro/financeiro-paginas.css">
<script>window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})};</script>
</head><body><div id="app" class="app"><div class="main"><main id="view" class="content"></main></div></div><div id="toast" class="toast"></div></body></html>`;
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml" };
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TODAS = ["ver", "lancar", "editar", "conciliar", "fechar", "configurar", "cancelar", "classificar"].map((a) => `gestao_financeira.${a}`);
const DESKTOP = { width: 1280, height: 860 }, CELULAR = { width: 390, height: 844 };

let servidor, base, navegador, repo, ids;
const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

before(async () => {
  if (PULAR) return;
  process.env.SUPABASE_URL = "http://127.0.0.1:1"; process.env.SUPABASE_SERVICE_ROLE_KEY = "teste-local"; process.env.SUPABASE_ANON_KEY = "teste-local";
  const express = reqBackend("express");
  const { criarDominioRouter } = await import(pathToFileURL(join(BACKEND, "src/modules/gestao-financeira/dominio/rotas.js")).href);
  const { criarRepoMemoria } = await import(pathToFileURL(join(BACKEND, "test/financeiro/helpers/repoMemoria.js")).href);
  repo = criarRepoMemoria();
  // Contas a pagar: o repositório em memória não cobre; esta camada mínima guarda fornecedores e obrigações (as REGRAS são as do serviço real).
  const fornecedores = [], obrigacoes = []; let n = 0;
  Object.assign(repo, {
    listarFornecedores: async () => fornecedores.map((f) => ({ ...f })), inserirFornecedor: async (_c, v) => { const f = { id: U(9000 + ++n), ativo: true, ...v }; fornecedores.push(f); return f; },
    listarObrigacoes: async () => obrigacoes.map((o) => ({ ...o })), inserirObrigacao: async (_c, v) => { const o = { id: U(9500 + ++n), status: "aberta", ...v }; obrigacoes.push(o); return o; },
    listarPagamentos: async () => [], listarVinculosSaidas: async () => [], listarAuditoria: async () => [],
  });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const gate = (acao) => (req, _res, next) => {
    const perms = (req.headers["x-perms"] ?? TODAS.join(",")).split(",");
    req.financeiro = { organizacaoId: U(1), unidadeId: U(2), permissoes: perms }; req.user = { id: U(3) };
    perms.includes(acao) ? next() : next(Object.assign(new Error("Permissão financeira insuficiente."), { statusCode: 403 }));
  };
  app.get("/api/config", (_req, res) => res.json({ supabaseUrl: "http://127.0.0.1:1", supabaseAnonKey: "teste-local" }));
  app.use("/api/v1/gestao-financeira", criarDominioRouter({ autorizar: gate, deps: { repo, db: undefined }, financeiro2: () => true }));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, details: err.details }));
  app.use((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/" || url.pathname === "/index.html") { res.type("html").send(PAGINA); return; }
    const arquivo = join(RAIZ, decodeURIComponent(url.pathname));
    if (arquivo.startsWith(RAIZ) && existsSync(arquivo)) { res.type(MIME[extname(arquivo)] ?? "application/octet-stream").send(readFileSync(arquivo)); return; }
    res.status(404).end();
  });
  servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  navegador = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) });
  if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
  // cadastros de teste, pela API REAL (mesmas validações da produção)
  const post = async (rota, corpo) => { const r = await fetch(`${base}/api/v1/gestao-financeira${rota}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) }); const j = await r.json(); if (!r.ok) throw new Error(`${rota}: ${j.error}`); return j.data; };
  const cat = (nome, papel, natureza = "FIXA") => post("/plano-contas", { tipo: papel === "receita_operacional" ? "RECEITA" : "DESPESA", natureza, nome, papel });
  const rec = await cat("RECEBIMENTO", "receita_operacional"), ins = await cat("INSUMOS - FRUTAS", "custo_variavel"), alu = await cat("ALUGUEL", "despesa_fixa"), tra = await cat("ENTRE CONTAS", "transferencia");
  const uni = await post("/contas", { nome: "UNICRED", tipoConta: "banco" }), sto = await post("/contas", { nome: "STONE", tipoConta: "adquirente" });
  ids = { rec: rec.id, ins: ins.id, alu: alu.id, tra: tra.id, uni: uni.id, sto: sto.id };
  // histórico: a Polpa sempre em INSUMOS e na UNICRED
  for (const [d, v] of [["Polpa de açaí", "300.00"], ["Polpa de açaí", "280.00"], ["Aluguel", "1800.00"]]) {
    await post("/lancamentos", { contaId: ids.uni, categoriaId: d === "Aluguel" ? ids.alu : ids.ins, sentido: "saida", descricao: d, valor: v, dataMovimento: hoje() });
  }
});
after(async () => { await navegador?.close(); await new Promise((r) => servidor?.close(r)); });

async function abrir({ viewport = DESKTOP, permissoes = TODAS } = {}) {
  const contexto = await navegador.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600, extraHTTPHeaders: { "x-perms": permissoes.join(",") } });
  const p = await contexto.newPage();
  const erros = [];
  p.on("pageerror", (e) => erros.push(e.message));
  await p.goto(base + "/");
  await p.evaluate(async ({ permissoes }) => {
    window.__recarregou = 0;
    const m = await import("/src/financeiro/lancamentoRapido.js");
    window.__outros = 0;
    m.abrirLancamentoRapido({ permissoes, aposSalvar: () => { window.__recarregou += 1; }, aoEscolherOutros: () => { window.__outros += 1; } });
  }, { permissoes });
  await p.waitForSelector("dialog.fin-lr[open]");
  return { p, erros, fechar: () => contexto.close() };
}
const ultimos = (n = 1) => [...repo._lancamentos?.() ?? []].slice(-n);
const api = async (rota) => (await (await fetch(`${base}/api/v1/gestao-financeira${rota}`)).json()).data;
const captura = async (p, nome) => { if (CAPTURAS) await p.screenshot({ path: resolve(CAPTURAS, `${nome}.png`) }); };
const lancs = async () => (await api(`/lancamentos?de=2020-01-01&ate=2099-12-31&limite=500`)).itens;

describe("Lançamento rápido no navegador (servidor financeiro real, dados sintéticos)", { skip: PULAR, timeout: 300_000 }, () => {
  test("passo 1: três botões grandes em linguagem comum + 'Outros tipos de registro' (o seletor completo continua acessível)", async () => {
    const { p, erros, fechar } = await abrir();
    try {
      assert.equal(await p.locator("#fin-lr-t").innerText(), "O que aconteceu?");
      assert.deepEqual(await p.$$eval("[data-acao] strong", (ns) => ns.map((n) => n.textContent)), ["Saiu dinheiro", "Entrou dinheiro", "Passei entre minhas contas"]);
      assert.equal(await p.evaluate(() => document.activeElement?.dataset?.acao), "saiu", "foco no primeiro botão: Enter já avança");
      await captura(p, "lr-desktop-passo1");
      await p.click("[data-outros]");
      assert.equal(await p.evaluate(() => window.__outros), 1); assert.equal(await p.locator("dialog.fin-lr").count(), 0);
      assert.deepEqual(erros, []);
    } finally { await fechar(); }
  });

  test("saiu dinheiro: descrição conhecida → categoria SUGERIDA com o motivo, conta sugerida, resumo claro; registra com 3 informações", async () => {
    const antes = (await lancs()).length;
    const { p, fechar } = await abrir();
    try {
      await p.click('[data-acao="saiu"]');
      await p.waitForSelector("[name=descricao]");
      assert.equal(await p.locator("[name=contaId]").count(), 1, "a conta existe (dentro de 'Mais detalhes') e já vem escolhida");
      assert.equal(await p.locator("[name=contaId]").inputValue(), ids.uni, "conta sugerida: a mais recente");
      assert.equal(await p.locator(".fin-lr-mais").evaluate((n) => n.open), false, "detalhes recolhidos");
      await p.fill("[name=descricao]", "polpa de acai");
      assert.equal(await p.locator("[name=categoriaId]").inputValue(), ids.ins);
      assert.match(await p.locator("[data-sug]").innerText(), /Sugerida: .*usaram esta categoria: 2 de 2\. Troque se não for essa\./);
      await p.fill("[name=valor]", "1.234,56");
      const r = (await p.locator("[data-resumo]").innerText()).replace(/ /g, " ");
      assert.match(r, /Vai registrar: Saída de R\$ 1\.234,56/); assert.match(r, /categoria INSUMOS - FRUTAS/); assert.match(r, /Aparece em: Fluxo de Caixa, saldos e DRE/);
      await captura(p, "lr-desktop-saiu");
      await p.click('[data-salvar="fechar"]');
      await p.waitForSelector("dialog.fin-lr", { state: "detached" });
      assert.equal(await p.evaluate(() => window.__recarregou), 1);
      const todos = await lancs();
      assert.equal(todos.length, antes + 1);
      const novo = todos.find((l) => l.descricao === "polpa de acai");
      assert.deepEqual([novo.sentido, Number(novo.valor_centavos), novo.categoria_id, novo.conta_id, novo.data_movimento.slice(0, 10), novo.status], ["saida", 123456, ids.ins, ids.uni, hoje(), "realizado"]);
    } finally { await fechar(); }
  });

  test("trocar a categoria sugerida vale: a escolha da pessoa não é sobrescrita ao continuar digitando", async () => {
    const { p, fechar } = await abrir();
    try {
      await p.click('[data-acao="saiu"]'); await p.waitForSelector("[name=descricao]");
      await p.fill("[name=descricao]", "Polpa de açaí");
      assert.equal(await p.locator("[name=categoriaId]").inputValue(), ids.ins);
      await p.selectOption("[name=categoriaId]", ids.alu);
      await p.fill("[name=descricao]", "Polpa de açaí extra");
      assert.equal(await p.locator("[name=categoriaId]").inputValue(), ids.alu, "escolha manual preservada");
      assert.equal(await p.locator("[data-sug]").innerText(), "");
    } finally { await fechar(); }
  });

  test("sem base no histórico: NÃO chuta categoria; registra 'sem categoria' e avisa que fica para classificar", async () => {
    const { p, fechar } = await abrir();
    try {
      await p.click('[data-acao="saiu"]'); await p.waitForSelector("[name=descricao]");
      await p.fill("[name=descricao]", "Coisa nunca vista antes"); await p.fill("[name=valor]", "10");
      assert.equal(await p.locator("[name=categoriaId]").inputValue(), "");
      assert.match(await p.locator("[data-resumo]").innerText(), /sem categoria \(fica para classificar depois\)/);
      await p.click('[data-salvar="fechar"]'); await p.waitForSelector("dialog.fin-lr", { state: "detached" });
      const l = (await lancs()).find((x) => x.descricao === "Coisa nunca vista antes");
      assert.equal(l.categoria_id, null); assert.equal(l.classificacao_pendente, true);
    } finally { await fechar(); }
  });

  test("entrou dinheiro: só categorias de receita; grava como entrada", async () => {
    const { p, fechar } = await abrir();
    try {
      await p.click('[data-acao="entrou"]'); await p.waitForSelector("[name=descricao]");
      assert.deepEqual(await p.$$eval("[name=categoriaId] option", (os) => os.map((o) => o.textContent)), ["Não sei — classificar depois", "RECEBIMENTO"]);
      assert.equal(await p.locator("[name=contaId]").inputValue(), "", "sem histórico de entradas e com duas contas: a pessoa escolhe a conta, visível");
      await p.fill("[name=descricao]", "Venda do dia"); await p.fill("[name=valor]", "850"); await p.selectOption("[name=categoriaId]", ids.rec);
      await p.click('[data-salvar="fechar"]');
      assert.match(await p.locator('[data-msg="contaId"]').innerText(), /Escolha a conta/);
      await p.selectOption("[name=contaId]", ids.sto);
      await p.click('[data-salvar="fechar"]'); await p.waitForSelector("dialog.fin-lr", { state: "detached" });
      const l = (await lancs()).find((x) => x.descricao === "Venda do dia");
      assert.deepEqual([l.sentido, Number(l.valor_centavos), l.categoria_id, l.conta_id], ["entrada", 85000, ids.rec, ids.sto]);
    } finally { await fechar(); }
  });

  test("vou pagar depois: vira CONTA A PAGAR (sem lançamento de caixa), exige fornecedor e categoria; competência = mês do vencimento", async () => {
    const antes = (await lancs()).length;
    const { p, fechar } = await abrir();
    try {
      await p.click('[data-acao="saiu"]'); await p.waitForSelector("[name=descricao]");
      await p.check('[name=quando][value="depois"]');
      await p.waitForSelector("[name=fornecedor]");
      await p.fill("[name=descricao]", "Boleto de embalagens"); await p.fill("[name=valor]", "420"); await p.fill("[name=data]", "2026-12-15");
      await p.click('[data-salvar="fechar"]');
      assert.match(await p.locator('[data-msg="fornecedor"]').innerText(), /para quem/i); assert.match(await p.locator('[data-msg="categoriaId"]').innerText(), /Escolha a categoria/);
      await p.fill("[name=fornecedor]", "Embalagens Brasil"); await p.selectOption("[name=categoriaId]", ids.ins);
      assert.equal(await p.locator('[data-msg="fornecedor"]').innerText(), "", "o erro some assim que o campo é corrigido");
      assert.equal(await p.locator('[data-msg="categoriaId"]').innerText(), ""); assert.equal(await p.locator("[name=fornecedor]").getAttribute("aria-invalid"), "false");
      assert.doesNotMatch(await p.locator("[data-resumo]").innerText(), /\.\./, "sem ponto duplicado");
      assert.match((await p.locator("[data-resumo]").innerText()).replace(/ /g, " "), /vence em 15\/12\/2026\. Entra no resultado de dezembro\/2026 \(INSUMOS - FRUTAS\)\.[\s\S]*Ainda não saiu dinheiro/);
      await captura(p, "lr-desktop-depois");
      await p.click('[data-salvar="fechar"]'); await p.waitForSelector("dialog.fin-lr", { state: "detached" });
      const contas = await api("/contas-pagar?mes=2026-12");
      const lista = contas.itens ?? contas;
      const o = lista.find((x) => /embalagens/i.test(x.descricao));
      assert.ok(o, "a conta a pagar foi criada"); assert.equal(o.competencia.slice(0, 7), "2026-12"); assert.equal(o.vencimento.slice(0, 10), "2026-12-15"); assert.equal(Number(o.valorOriginalCentavos ?? o.valor_original_centavos), 42000);
      assert.equal((await lancs()).length, antes, "nenhum lançamento de caixa foi criado: o dinheiro ainda não saiu");
    } finally { await fechar(); }
  });

  test("passei entre minhas contas: cria as duas pernas ligadas, sem categoria de despesa nem receita", async () => {
    const { p, fechar } = await abrir();
    try {
      await p.click('[data-acao="transferi"]'); await p.waitForSelector("[name=contaDestinoId]");
      await p.fill("[name=valor]", "500"); await p.selectOption("[name=contaId]", ids.sto);
      await p.selectOption("[name=contaDestinoId]", ids.sto).catch(() => {});
      assert.equal(await p.locator("[name=contaDestinoId] option", { hasText: "STONE" }).count(), 0, "a conta de origem não aparece como destino");
      await p.selectOption("[name=contaDestinoId]", ids.uni);
      assert.match((await p.locator("[data-resumo]").innerText()).replace(/ /g, " "), /Transferência de R\$ 500,00 .*: STONE → UNICRED\.[\s\S]*não entra na DRE/);
      await p.click('[data-salvar="fechar"]'); await p.waitForSelector("dialog.fin-lr", { state: "detached" });
      const t = await api("/transferencias");
      assert.ok((t.itens ?? t).length >= 1);
      const pernas = (await lancs()).filter((l) => l.categoria_id === ids.tra);
      assert.deepEqual(pernas.map((l) => l.sentido).sort(), ["entrada", "saida"]);
    } finally { await fechar(); }
  });

  test("'Registrar e lançar outro' mantém conta e data, limpa o resto e recarrega a tela de trás a cada registro", async () => {
    const { p, fechar } = await abrir();
    try {
      await p.click('[data-acao="saiu"]'); await p.waitForSelector("[name=descricao]");
      await p.fill("[name=descricao]", "Gelo"); await p.fill("[name=valor]", "15");
      await p.click('[data-salvar="outro"]');
      await p.waitForFunction(() => document.querySelector("[name=descricao]")?.value === "");
      assert.equal(await p.locator("[name=valor]").inputValue(), ""); assert.equal(await p.locator("[name=contaId]").inputValue(), ids.uni);
      assert.equal(await p.evaluate(() => window.__recarregou), 1);
      await p.fill("[name=descricao]", "Sacos"); await p.fill("[name=valor]", "22,40"); await p.click('[data-salvar="fechar"]');
      await p.waitForSelector("dialog.fin-lr", { state: "detached" });
      assert.equal(await p.evaluate(() => window.__recarregou), 2);
      const d = (await lancs()).map((l) => l.descricao); assert.ok(d.includes("Gelo") && d.includes("Sacos"));
    } finally { await fechar(); }
  });

  test("erros em português simples, sem registrar nada; erro do servidor aparece no próprio formulário e deixa tentar de novo", async () => {
    const antes = (await lancs()).length;
    const { p, fechar } = await abrir();
    try {
      await p.click('[data-acao="saiu"]'); await p.waitForSelector("[name=descricao]");
      await p.click('[data-salvar="fechar"]');
      assert.match(await p.locator('[data-msg="descricao"]').innerText(), /poucas palavras/); assert.match(await p.locator('[data-msg="valor"]').innerText(), /maior que zero/);
      assert.equal(await p.locator("[name=descricao]").getAttribute("aria-invalid"), "true");
      assert.equal((await lancs()).length, antes);
      await p.fill("[name=descricao]", "Teste"); await p.fill("[name=valor]", "5"); await p.fill("[name=data]", "2026-13-45").catch(() => {});
      await p.evaluate(() => { document.querySelector("[name=data]").value = ""; document.querySelector("[name=data]").dispatchEvent(new Event("input", { bubbles: true })); });
      await p.click('[data-salvar="fechar"]');
      assert.match(await p.locator('[data-msg="data"]').innerText(), /data válida/);
      assert.equal((await lancs()).length, antes);
    } finally { await fechar(); }
  });

  test("sem permissão de lançar: botões desabilitados com aviso; nada a registrar", async () => {
    const { p, fechar } = await abrir({ permissoes: ["gestao_financeira.ver"] });
    try {
      assert.equal(await p.locator("[data-acao]:not([disabled])").count(), 0);
      assert.match(await p.locator("dialog.fin-lr").innerText(), /Seu perfil não registra lançamentos/);
    } finally { await fechar(); }
  });

  test("tema escuro: texto legível (contraste mínimo 4,5:1) nos cartões, no resumo e no seletor", async () => {
    const { p, fechar } = await abrir();
    try {
      await p.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await p.click('[data-acao="saiu"]'); await p.waitForSelector("[name=descricao]");
      await p.fill("[name=descricao]", "Polpa de açaí"); await p.fill("[name=valor]", "50");
      await p.waitForTimeout(400);   // as cores têm transição de 0,15 s: mede só depois de assentar
      await captura(p, "lr-desktop-escuro");
      const baixos = await p.evaluate(() => {
        const lum = (c) => { let m = c.match(/[\d.]+/g).map(Number); if (/^color\(/.test(c)) m = m.slice(0, 3).map((v) => v * 255);   /* color-mix devolve color(srgb 0-1) */ const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(m[0]) + .7152 * f(m[1]) + .0722 * f(m[2]); };
        const rgba = (c) => { let m = c.match(/[\d.]+/g).map(Number); if (/^color\(/.test(c)) m = [...m.slice(0, 3).map((v) => v * 255), m[3] ?? 1]; return [m[0], m[1], m[2], m[3] ?? 1]; };
        const fundo = (n) => { const camadas = []; for (let x = n; x; x = x.parentElement) { const c = rgba(getComputedStyle(x).backgroundColor); if (c[3] > 0) camadas.push(c); if (c[3] === 1) break; } let base = [255, 255, 255]; for (const c of camadas.reverse()) base = base.map((v, k) => v * (1 - c[3]) + c[k] * c[3]); return `rgb(${base.join(",")})`; };   // compõe as camadas translúcidas como o navegador
        const alvos = ["[data-resumo]", ".fin-lr-seg label:has(input:checked) > span", ".fin-lr-seg label:not(:has(input:checked)) > span", "#fin-lr-t", "[data-sug]", ".fin-lr label.fin-campo > span"];
        return alvos.map((sel) => { const n = document.querySelector(sel); if (!n) return null; const a = lum(getComputedStyle(n).color), b = lum(fundo(n)); const r = (Math.max(a, b) + .05) / (Math.min(a, b) + .05); return r < 4.5 ? `${sel}: ${r.toFixed(2)}` : null; }).filter(Boolean);
      });
      assert.deepEqual(baixos, [], "contraste baixo no tema escuro");
    } finally { await fechar(); }
  });

  test("celular (390 px): sem rolagem horizontal, campos com 16px (sem zoom) e alvos de toque grandes", async () => {
    const { p, fechar } = await abrir({ viewport: CELULAR });
    try {
      const alturaBotao = await p.locator("[data-acao]").first().evaluate((n) => n.getBoundingClientRect().height);
      assert.ok(alturaBotao >= 56, `botão de ação com ${alturaBotao}px`);
      await captura(p, "lr-celular-passo1");
      await p.click('[data-acao="saiu"]'); await p.waitForSelector("[name=descricao]");
      await p.fill("[name=descricao]", "Polpa de açaí"); await p.fill("[name=valor]", "99,90");
      const m = await p.evaluate(() => { const d = document.querySelector("dialog.fin-lr"); return { w: d.clientWidth, s: d.scrollWidth, fonte: getComputedStyle(document.querySelector("[name=valor]")).fontSize }; });
      assert.ok(m.s <= m.w + 1, `rolagem horizontal ${m.s} > ${m.w}`); assert.equal(m.fonte, "16px");
      const cortados = await p.evaluate(() => { const d = document.querySelector("dialog.fin-lr").getBoundingClientRect(); return [...document.querySelectorAll("dialog.fin-lr button")].filter((b) => b.offsetParent && (b.getBoundingClientRect().right > d.right + 1 || b.getBoundingClientRect().left < d.left - 1)).map((b) => b.textContent.trim()); });
      assert.deepEqual(cortados, [], "nenhum botão cortado");
      await captura(p, "lr-celular-saiu");
    } finally { await fechar(); }
  });
});
