// Central de Conferências reformulada em NAVEGADOR REAL (Chrome via Playwright): desktop e celular, com a ESTRUTURA de setembro/2026
// (fixture no formato exato da API). O servidor local responde a API em memória e REGISTRA toda escrita: abrir/consultar a Central
// não pode escrever nada, e nenhuma ação confirma sozinha. Nunca fala com produção.
//
// Rodar:  FIN_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright FIN_BROWSER_CHANNEL=chrome \
//         node --test frontend/test/centralConferencias.browser.test.js     (FIN_SCREENSHOTS=<pasta> grava capturas)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { CENTRAL_SETEMBRO, PDOC_SETEMBRO } from "./conferenciasFixture.js";

let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.FIN_PLAYWRIGHT_PATH || process.env.CHECKLIST_PLAYWRIGHT_PATH || "playwright")); } catch { /* sem Playwright: pulado */ }
const PULAR = !chromium && "Configure FIN_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.FIN_BROWSER_CHANNEL || process.env.CHECKLIST_BROWSER_CHANNEL;
const CAPTURAS = process.env.FIN_SCREENSHOTS;
const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MIME = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".html": "text/html; charset=utf-8" };
const TODAS = ["ver", "lancar", "editar", "conciliar", "classificar"].map((a) => `gestao_financeira.${a}`);
const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/financeiro/financeiro-paginas.css">
<script>window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})};</script>
</head><body><div id="app" class="app"><div class="main"><main id="view" class="content"></main></div></div><div id="toast" class="toast"></div></body></html>`;

const api = { escritas: [], central: null, pdoc: null, perms: TODAS, falhaCentral: null };
const zerar = (extra = {}) => Object.assign(api, { escritas: [], central: structuredClone(CENTRAL_SETEMBRO), pdoc: structuredClone(PDOC_SETEMBRO), perms: TODAS, falhaCentral: null }, extra);
const json = (res, status, corpo) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(corpo)); };
let servidor, base, navegador;

before(async () => {
  if (PULAR) return;
  servidor = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"), caminho = u.pathname;
    if (caminho === "/api/config") return json(res, 200, { supabaseUrl: "http://127.0.0.1:1", supabaseAnonKey: "x" });
    if (caminho === "/api/v1/gestao-financeira/status") return json(res, 200, { data: { habilitado: true, nivel: "gestor", permissoes: api.perms, financeiro2: true } });
    if (caminho.startsWith("/api/v1/gestao-financeira/")) {
      const rota = caminho.slice("/api/v1/gestao-financeira".length);
      if (req.method !== "GET") {
        let corpo = ""; for await (const c of req) corpo += c;
        api.escritas.push({ metodo: req.method, rota, corpo: corpo ? JSON.parse(corpo) : null });
        const m = /^\/pendencias-documentais\/modelos\/([^/]+)\/dispensar$/.exec(rota);
        if (m) { const mod = api.pdoc.modelos.find((x) => x.chave === decodeURIComponent(m[1])); mod.dispensada = { justificativa: JSON.parse(corpo).justificativa, em: "2026-11-10T10:00:00Z" }; }
        const c = /^\/pendencias-documentais\/modelos\/([^/]+)$/.exec(rota);
        if (c) api.pdoc.modelos.find((x) => x.chave === decodeURIComponent(c[1])).cadastrada = true;
        return json(res, 200, { data: {} });
      }
      if (rota === "/conferencias") return api.falhaCentral ? json(res, api.falhaCentral, { error: api.falhaCentral === 403 ? "Permissão financeira insuficiente." : "Falha interna." }) : json(res, 200, { data: api.central });
      if (rota === "/pendencias-documentais") return json(res, 200, { data: api.pdoc });
      if (rota === "/conferencias/historico") return json(res, 200, { data: { itens: [{ id: 1, entidade: "fin_vendas_ajustes", entidadeId: CENTRAL_SETEMBRO.pendencias[0].refs[0], acao: "insert", em: "2026-10-01T10:00:00Z" }] } });
      if (rota === "/transferencias/multiplas") return json(res, 200, { data: [] });
      if (/\/historico$/.test(rota)) return json(res, 200, { data: { itens: [] } });
      return json(res, 404, { error: "não encontrado" });
    }
    if (caminho === "/" || caminho === "/index.html") { res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(PAGINA); return; }
    const arq = resolve(RAIZ, "." + caminho);
    if (!arq.startsWith(RAIZ + sep)) { res.writeHead(403).end(); return; }
    try { res.setHeader("Content-Type", MIME[extname(arq)] ?? "application/octet-stream"); res.end(readFileSync(arq)); } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  navegador = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) });
  if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
});
after(async () => { await navegador?.close(); if (servidor) await new Promise((r) => servidor.close(r)); });

const DESKTOP = { width: 1366, height: 860 }, CELULAR = { width: 390, height: 844 };
async function abrir({ viewport = DESKTOP, permissoes } = {}) {
  const contexto = await navegador.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  await contexto.route((url) => !url.href.startsWith(base), (r) => r.fulfill({ status: 200, body: "" }));
  const p = await contexto.newPage();
  const erros = [];
  p.on("pageerror", (e) => erros.push(e.message));
  await p.goto(base + "/");
  await p.evaluate(async ({ permissoes }) => {
    const { state } = await import("/src/state.js");
    state.sessao = { ...(state.sessao ?? {}), empresa: { id: "o", nome: "Açaí de teste" }, unidade: { id: "u", nome: "Loja Centro" } };
    const { abrirCentral } = await import("/src/financeiro/conferencias.js");
    abrirCentral({ mes: "2026-09", ...(permissoes ? { permissoes } : {}) });
  }, { permissoes });
  return { p, erros, fechar: () => contexto.close() };
}
const captura = async (p, nome) => { if (CAPTURAS) await p.screenshot({ path: resolve(CAPTURAS, `${nome}.png`), fullPage: false }); };
const esperarLista = (p) => p.waitForSelector(".cf2-grupo", { timeout: 15_000 });
const textos = (p, sel) => p.$$eval(sel, (ns) => ns.map((n) => n.textContent.replace(/\s+/g, " ").trim()));

describe("Central de Conferências no navegador (estrutura de setembro/2026)", { skip: PULAR, timeout: 300_000 }, () => {
  test("cabeçalho, três abas e pendências agrupadas por assunto, sem duplicar e SEM nenhuma escrita ao consultar", async () => {
    zerar();
    const { p, erros, fechar } = await abrir();
    try {
      await esperarLista(p);
      const cab = await p.locator(".cf2-cab").innerText();
      assert.match(cab, /Açaí de teste · Loja Centro/); assert.match(cab, /Grupos de pendências em aberto\s*9/); assert.match(cab, /Sugestões documentais não cadastradas\s*5/); assert.match(cab, /Aguardando aprovação/);
      assert.deepEqual(await textos(p, "[role=tab]"), ["Pendências (9)", "Sugestões documentais (5)", "Referências e competências"]);
      assert.deepEqual(await textos(p, ".cf2-grupo > h4"), ["Vendas e ajustes 1", "Contas, pagamentos e juros 4", "Custos e rateios 1", "Caixa e conciliação 1", "Classificações financeiras 1", "Pendências documentais 2"]);
      const ids = await p.$$eval("[data-cf2-item]", (ns) => ns.map((n) => n.dataset.cf2Item));
      assert.equal(ids.length, new Set(ids).size, "nenhuma pendência em dois grupos");
      const ifood = (await p.locator('[data-cf2-item^="ajuste:"]').innerText()).replace(/ /g, " ");
      for (const t of ["Ajuste iFood", "R$ 788,15", "Estimado", "Contadora", "Aguardando relatório do Portal do Parceiro."]) assert.ok(ifood.includes(t), `linha do iFood: falta ${t}`);
      assert.doesNotMatch(await p.locator(".cf2-aba").innerText(), /Portal do Parceiro iFood → relatórios/, "instrução técnica não aparece na lista");
      await captura(p, "central-desktop-pendencias");
      // percorre as três abas
      await p.click("#cf2-aba-sugestoes"); await p.click("#cf2-aba-referencias"); await p.click("#cf2-aba-pendencias");
      assert.deepEqual(api.escritas, [], "consultar a Central não escreve nada");
      assert.deepEqual(erros, []);
    } finally { await fechar(); }
  });

  test("filtros, busca por valor/fornecedor e ordenação", async () => {
    zerar();
    const { p, fechar } = await abrir();
    try {
      await esperarLista(p);
      await p.fill("[data-cf2-f=busca]", "6.633,60");
      assert.deepEqual(await textos(p, ".cf2-nome"), ["Pago por Sócia — Distribuidora compra 08/2026"]);
      await p.fill("[data-cf2-f=busca]", "distribuidora");
      assert.ok((await textos(p, ".cf2-nome")).some((t) => /Sócia/.test(t)));
      await p.fill("[data-cf2-f=busca]", "");
      await p.selectOption("[data-cf2-f=status]", "estimado");
      assert.deepEqual(await textos(p, ".cf2-nome"), ["Ajuste iFood"]);
      await p.selectOption("[data-cf2-f=status]", "confirmado");
      assert.deepEqual(await textos(p, ".cf2-nome"), ["Nota de compra de gelo"]);
      await p.selectOption("[data-cf2-f=status]", "todas");
      await p.selectOption("[data-cf2-f=categoria]", "contas");
      assert.deepEqual(await textos(p, ".cf2-grupo > h4"), ["Contas, pagamentos e juros 4"]);
      await p.selectOption("[data-cf2-f=categoria]", "");
      await p.fill("[data-cf2-f=busca]", "xyz-nada");
      assert.match(await p.locator("[data-cf2-lista]").innerText(), /Nenhum item corresponde aos filtros/);
      await p.click("[data-cf2-limpar]");
      await p.selectOption("[data-cf2-f=ordem]", "valor");
      assert.equal((await textos(p, ".cf2-grupo:nth-of-type(2) .cf2-nome"))[0], "Pago por Sócia — Distribuidora compra 08/2026");
    } finally { await fechar(); }
  });

  test("Revisar abre o detalhe em 8 partes + Detalhes técnicos; iFood exige relatório compatível e evidência; Esc volta à lista", async () => {
    zerar();
    const { p, fechar } = await abrir();
    try {
      await esperarLista(p);
      await p.click('[data-cf2-item^="ajuste:"] [data-cf2-revisar]');
      await p.waitForSelector("[data-cf2-det-titulo]");
      assert.deepEqual((await textos(p, ".cf2-secao > h5")).map((t) => t.replace(/^\d/, "")), ["O que aconteceu", "Por que está pendente", "O documento que falta", "O que precisa ser conferido",
        "Valores e registros relacionados", "Evidências disponíveis", "Histórico", "Próxima ação permitida"]);
      assert.equal(await p.locator(".cf2-tec summary").innerText(), "Detalhes técnicos");
      assert.equal(await p.evaluate(() => document.activeElement?.matches("[data-cf2-det-titulo]")), true, "foco vai para o título do detalhe");
      // confirmar sem marcar o relatório compatível: o formulário recusa e NADA é enviado
      await p.fill("textarea[name=evidencia]", "Relatório financeiro do Portal 01–30/09");
      await p.click("[data-cf2-acao=confirmar_ajuste] button[type=submit]");
      assert.deepEqual(api.escritas, []);
      await captura(p, "central-desktop-detalhe-ifood");
      await p.click("[data-cf2-hist]");
      await p.waitForFunction(() => /insert/.test(document.querySelector("[data-cf2-hist-corpo]")?.textContent ?? ""));
      await p.keyboard.press("Escape");
      await p.waitForSelector(".cf2-grupo");
      assert.equal(await p.locator(".fin-pn").count(), 1, "Esc no detalhe volta à lista, não fecha a Central");
      assert.equal(await p.evaluate(() => document.activeElement?.dataset?.cf2Revisar?.startsWith("ajuste:")), true, "foco volta ao botão Revisar");
    } finally { await fechar(); }
  });

  test("ações por natureza: rateio um por vez; juros em duas decisões; terceiro sem saída bancária; R$ 80 sem conta presumida; transferências 5 + 6", async () => {
    zerar();
    const { p, fechar } = await abrir();
    try {
      await esperarLista(p);
      // rateios: cinco cartões, cada um com a sua confirmação
      await p.click('[data-cf2-revisar="rateios"]');
      assert.equal(await p.locator("[data-cf2-rateio]").count(), 5);
      await p.click("[data-cf2-rateio]:first-child [data-cf2-aprovar]");
      assert.deepEqual(api.escritas, [], "sem marcar 'Conferi o documento', nada é enviado");
      await p.check("[data-cf2-rateio]:first-child [data-cf2-conferi]");
      await p.click("[data-cf2-rateio]:first-child [data-cf2-aprovar]");
      await p.waitForFunction(() => true);
      await p.waitForTimeout(300);
      assert.deepEqual(api.escritas.map((e) => e.rota), [`/rateios/${CENTRAL_SETEMBRO.pendencias[1].itens[0].id}/aprovar`], "aprovou UM rateio");
      await p.click("[data-cf2-voltar]");
      // juros: duas decisões; classificar travado até quitar
      await p.click('[data-cf2-item^="juros:"] [data-cf2-revisar]');
      const etapas = await textos(p, ".cf2-etapa h6");
      assert.deepEqual(etapas, ["Decisão 1 — Quitar ou conciliar a obrigação", "Decisão 2 — Classificar a natureza do acréscimo"]);
      assert.equal(await p.locator("[data-cf2-acao=classificar_acrescimo] button[type=submit]").isDisabled(), true);
      await p.click("[data-cf2-voltar]");
      // pagamento da sócia
      await p.click('[data-cf2-item^="terceiro:"] [data-cf2-revisar]');
      const terc = await p.locator(".cf2-det").innerText();
      assert.match(terc, /pagou com recursos pessoais/); assert.match(terc, /não registre saída bancária/); assert.match(terc, /Reembolso à sócia/);
      assert.equal(await p.locator(".cf2-det form").count(), 0, "nenhum formulário de saída bancária");
      await captura(p, "central-desktop-terceiro");
      await p.click("[data-cf2-voltar]");
      // R$ 80: exige comprovante antes de informar conta
      await p.click('[data-cf2-item^="origem:"] [data-cf2-revisar]');
      assert.match(await p.locator(".cf2-det").innerText(), /Nenhuma conta bancária é presumida/);
      await p.selectOption("select[name=contaId]", { index: 1 });
      const antes = api.escritas.length;
      await p.click("[data-cf2-acao=resolver_origem] button[type=submit]");
      assert.equal(api.escritas.length, antes, "sem marcar o comprovante, nada é enviado");
      await p.click("[data-cf2-voltar]");
      // transferências
      await p.click('[data-cf2-revisar="transferencias"]');
      assert.deepEqual((await textos(p, ".cf2-secao h6")).filter((t) => /Correspondência|várias/.test(t)), ["Correspondência 1:1 (5)", "Uma saída × várias entradas (6)"]);
      assert.equal(await p.locator("[data-cf2-vincular]").count(), 5); assert.equal(await p.locator("[data-cf2-multipla]").count(), 6);
      await p.click("[data-cf2-voltar]");
      // lançamentos sem classificação: tabela compacta com Revisar por linha
      await p.click('[data-cf2-revisar="classificacao_pendente"]');
      assert.equal(await p.locator(".cf2-tabela tbody [data-cf2-lanc]").count(), 8);
      await p.click('[data-cf2-lanc="0"]');
      assert.equal(await p.locator("#cf2-lanc-0").isVisible(), true);
      assert.match(await p.locator("#cf2-lanc-0").innerText(), /Evidência necessária/);
    } finally { await fechar(); }
  });

  test("sugestões: cinco linhas com 'Revisar e cadastrar', relação 190,53 × 195,25 (R$ 4,72) e dispensa com justificativa", async () => {
    zerar();
    const { p, fechar } = await abrir();
    try {
      await esperarLista(p);
      await p.click("#cf2-aba-sugestoes");
      assert.equal(await p.locator("[data-cf2-sug]").count(), 5);
      assert.ok((await textos(p, "[data-cf2-sug]")).every((t) => t === "Revisar e cadastrar"));
      const rel = await p.locator(".cf2-relacao").innerText();
      assert.match(rel, /R\$\s195,25 − R\$\s4,72 = R\$\s190,53/); assert.match(rel, /Não contar como duas perdas/);
      await captura(p, "central-desktop-sugestoes");
      await p.click('[data-cf2-sug="doc:2026-09:divergencia-caixa-0-82"]');
      await p.click("[data-cf2-sug-dispensar]");
      await p.fill("dialog textarea[name=justificativa]", "Cupom fiscal conferido: o valor correto é R$ 96,00");
      await p.click("dialog button[type=submit]");
      await p.waitForSelector(".cf2-dispensadas");
      assert.deepEqual(api.escritas.map((e) => [e.metodo, e.rota]), [["POST", "/pendencias-documentais/modelos/doc%3A2026-09%3Adivergencia-caixa-0-82/dispensar"]]);
      assert.equal(await p.locator("[data-cf2-sug]:not(.cf2-item--dispensada [data-cf2-sug])").count(), 4);
    } finally { await fechar(); }
  });

  test("referências: sem referência oficial NÃO mostra '0 de 0'; compras de agosto e contas de setembro; metodologia", async () => {
    zerar();
    const { p, fechar } = await abrir();
    try {
      await esperarLista(p);
      await p.click("#cf2-aba-referencias");
      const t = await p.locator(".cf2-aba").innerText();
      assert.match(t, /Nenhuma referência documental cadastrada para comparação\./); assert.doesNotMatch(t, /0 de 0/);
      assert.match(t, /Compras de agosto\/2026 pagas em setembro\/2026/); assert.match(t, /Contas de setembro\/2026 pagas em outubro\/2026/); assert.match(t, /Metodologia gerencial/);
      assert.match(t, /Competência e caixa/);
    } finally { await fechar(); }
  });

  test("teclado: setas entre abas", async () => {
    zerar();
    const { p, fechar } = await abrir();
    try {
      await esperarLista(p);
      await p.focus("#cf2-aba-pendencias");
      await p.keyboard.press("ArrowRight");
      assert.equal(await p.evaluate(() => document.activeElement.id), "cf2-aba-sugestoes");
      assert.equal(await p.getAttribute("#cf2-aba-sugestoes", "aria-selected"), "true");
      await p.keyboard.press("End");
      assert.equal(await p.evaluate(() => document.activeElement.id), "cf2-aba-referencias");
    } finally { await fechar(); }
  });

  test("estados: erro com nova tentativa, sem permissão, sem pendências, e perfil só-leitura com ações desabilitadas", async () => {
    zerar({ falhaCentral: 500 });
    let s = await abrir();
    try {
      await s.p.waitForSelector("[data-cf2-tentar]");
      api.falhaCentral = null;
      await s.p.click("[data-cf2-tentar]");
      await esperarLista(s.p);
    } finally { await s.fechar(); }
    zerar({ falhaCentral: 403 });
    s = await abrir();
    try { await s.p.waitForSelector(".fin-estado--erro"); assert.match(await s.p.locator(".fin-estado--erro").innerText(), /Sem permissão/); assert.equal(await s.p.locator("[data-cf2-tentar]").count(), 0); } finally { await s.fechar(); }
    zerar(); api.central = { ...api.central, pendencias: [], concluidasDocumentais: [], total: 0 };
    s = await abrir();
    try { await s.p.waitForSelector(".cf2-vazio-bloco"); assert.match(await s.p.locator(".cf2-aba").innerText(), /Nenhuma pendência registrada para setembro\/2026/); } finally { await s.fechar(); }
    zerar();
    s = await abrir({ permissoes: ["gestao_financeira.ver"] });
    try {
      await esperarLista(s.p);
      assert.equal(await s.p.locator("[data-cf2-doc-novo]").isDisabled(), true);
      await s.p.click('[data-cf2-item^="ajuste:"] [data-cf2-revisar]');
      assert.equal(await s.p.locator("[data-cf2-acao=confirmar_ajuste] button[type=submit]").isDisabled(), true);
    } finally { await s.fechar(); }
  });

  test("celular (390 px): sem rolagem horizontal, lista e detalhe utilizáveis", async () => {
    zerar();
    const { p, fechar } = await abrir({ viewport: CELULAR });
    try {
      await esperarLista(p);
      const larg = () => p.evaluate(() => { const pn = document.querySelector(".fin-pn-corpo"); return { w: pn.clientWidth, s: pn.scrollWidth }; });
      let r = await larg(); assert.ok(r.s <= r.w + 1, `lista: rolagem horizontal ${r.s} > ${r.w}`);
      await captura(p, "central-celular-lista");
      await p.click('[data-cf2-revisar="transferencias"]');
      r = await larg(); assert.ok(r.s <= r.w + 1, `detalhe: rolagem horizontal ${r.s} > ${r.w}`);
      await captura(p, "central-celular-detalhe");
    } finally { await fechar(); }
  });
});
