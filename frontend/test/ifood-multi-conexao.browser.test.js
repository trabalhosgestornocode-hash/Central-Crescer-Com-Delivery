// iFood — CONEXÕES SEPARADAS (Financial de homologação + Order de produção) em NAVEGADOR REAL (Chromium/Chrome via Playwright), desktop e celular.
// Servidor local mínimo: serve o frontend e responde a API do iFood com respostas SIMULADAS. Nunca fala com produção, Supabase nem iFood.
//
// Rodar:
//   IFOOD_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright IFOOD_BROWSER_CHANNEL=chrome \
//   node --test frontend/test/ifood-multi-conexao.browser.test.js     (IFOOD_SCREENSHOTS=<pasta> grava capturas)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)(process.env.IFOOD_PLAYWRIGHT_PATH || process.env.CHECKLIST_PLAYWRIGHT_PATH || "playwright"));
} catch { /* sem Playwright: pulado */ }
const PULAR = !chromium && "Configure IFOOD_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.IFOOD_BROWSER_CHANNEL || process.env.CHECKLIST_BROWSER_CHANNEL;
const CAPTURAS = process.env.IFOOD_SCREENSHOTS;
const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));
const IFOOD_API = "/api/v1/integracoes/ifood";
const ID_FIN = "11111111-1111-4111-8111-1111111111a2";
const ID_PED = "11111111-1111-4111-8111-1111111111a3";

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/styles.css">
<script>window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})};</script>
</head><body>
<div id="app" class="app"><div class="main"><header class="topbar"><h1 id="page-title">Integração iFood</h1></header><main id="view" class="content"></main></div></div>
</body></html>`;
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

const mTeste = { idMascarado: "7e57****aaaa", nome: "Teste - Subway North", razaoSocial: null };
const mReal = { idMascarado: "ea10****bbbb", nome: "Subway North Shopping", razaoSocial: null };
const cFin = { id: ID_FIN, finalidade: "financeiro_homologacao", ambiente: "homologacao", status: "ativa", merchant: mTeste, credenciais: { financial: { status: "ativa" }, analytics: { status: "ativa" } } };
const cPed = { id: ID_PED, finalidade: "pedidos_producao", ambiente: "producao", status: "ativa", merchant: mReal, credenciais: { order: { status: "ativa" } } };
const statusNorth = (conexoes) => ({
  conectado: true, status: "ativa", merchant: mTeste,
  apps: { analytics: { conectado: true, status: "ativa" }, financial: { conectado: true, status: "ativa" } },
  order: { configurado: true, conectado: conexoes.some((c) => c.id === ID_PED), status: "ativa", tokenValido: true, expiraEm: null, merchant: mReal, ultimaAutenticacao: null, tokenAtualizadoEm: null, ultimoEvento: null, ultimoAck: null, ultimoPedido: null, eventosComFalha: 0, worker: null, observabilidadeDisponivel: false, erroAtual: null, lojaValidada: true, lojaInformada: null, validacaoFinalHabilitada: false },
  conexoes, eventosRecebimento: { estado: "active" }, atencao: { total: 0, apps: [] }, conectadaEm: "2026-10-10T12:00:00Z", homologacao: false, financialHomologacao: true,
});

let servidor; let base; let navegador;
const ctl = { status: statusNorth([cFin, cPed]), chamadas: [] };
const json = (res, status, corpo) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(corpo)); };

before(async () => {
  if (PULAR) return;
  servidor = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/" || url.pathname === "/index.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end(PAGINA); }
    if (url.pathname.startsWith("/api/")) {
      ctl.chamadas.push({ metodo: req.method, caminho: url.pathname.replace(IFOOD_API, ""), consulta: url.search });
      if (url.pathname === `${IFOOD_API}/status` && req.method === "GET") return json(res, 200, { data: ctl.status });
      if ((url.pathname === `${IFOOD_API}/` || url.pathname === IFOOD_API) && req.method === "DELETE") {
        const id = url.searchParams.get("conexaoId");
        ctl.status = statusNorth(ctl.status.conexoes.filter((c) => c.id !== id));   // só a escolhida sai
        return json(res, 200, { data: { ok: true, jaDesconectado: false } });
      }
      return json(res, 404, { error: "não simulado" });
    }
    const arquivo = join(RAIZ, decodeURIComponent(url.pathname));
    if (arquivo.startsWith(RAIZ) && existsSync(arquivo)) { res.writeHead(200, { "content-type": MIME[extname(arquivo)] ?? "application/octet-stream" }); return res.end(readFileSync(arquivo)); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  navegador = await chromium.launch({ ...(CANAL ? { channel: CANAL } : {}) });
  if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
});
after(async () => { await navegador?.close(); await new Promise((r) => servidor?.close(r)); });

const DESKTOP = { width: 1366, height: 768 };
const CELULAR = { width: 390, height: 844 };

async function abrir({ viewport = DESKTOP } = {}) {
  const contexto = await navegador.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  const pagina = await contexto.newPage();
  const erros = []; const dialogos = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  pagina.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) erros.push(m.text()); });
  pagina.on("dialog", (d) => { dialogos.push(d.message()); d.accept(); });
  await pagina.goto(base + "/");
  await pagina.evaluate(async () => {
    const { state } = await import("/src/state.js");
    Object.assign(state.sessao, { empresa: { id: "org", nome: "Empresa de teste" }, unidade: "00000000-0000-0000-0000-0000000000a2", permissoes: ["integracoes.ver", "integracoes.gerenciar"], modulos: ["ifood"] });
    state.rota = "ifood";
    (await import("/src/ifood.js")).renderIfood();
  });
  await pagina.locator("#ifood-operacao").waitFor();
  return { pagina, erros, dialogos, fechar: () => contexto.close() };
}
const captura = async (pagina, nome) => { if (CAPTURAS) await pagina.screenshot({ path: resolve(CAPTURAS, `${nome}.png`), fullPage: true }); };
async function semEstouro(pagina, rotulo) {
  const r = await pagina.evaluate(() => {
    const largura = document.documentElement.clientWidth;
    const fora = [...document.querySelectorAll("#view button, #view .ifood-conexao-item")].filter((n) => n.offsetParent !== null)
      .map((n) => ({ id: n.id || n.textContent.trim().slice(0, 30), d: Math.round(n.getBoundingClientRect().right) })).filter((x) => x.d > largura + 1);
    return { largura, rolagem: document.documentElement.scrollWidth, fora };
  });
  assert.ok(r.rolagem <= r.largura + 1, `${rotulo}: rolagem horizontal (${r.rolagem} > ${r.largura})`);
  assert.deepEqual(r.fora, [], `${rotulo}: elementos fora da tela`);
}

describe("iFood — conexões separadas da unidade, no navegador", { skip: PULAR }, () => {
  for (const [nome, viewport] of [["desktop", DESKTOP], ["celular", CELULAR]]) {
    test(`${nome}: dois cartões independentes; desconectar o de PEDIDOS chama o servidor com o id dele e o Financial de homologação permanece`, async () => {
      ctl.status = statusNorth([cFin, cPed]); ctl.chamadas = [];
      const { pagina, erros, dialogos, fechar } = await abrir({ viewport });
      try {
        const secao = pagina.locator("#ifood-conexoes");
        await secao.waitFor();
        const texto = await secao.innerText();
        assert.match(texto, /Financial — Homologação/);
        assert.match(texto, /Ambiente de homologação/);
        assert.match(texto, /Order\/Events — Produção/);
        assert.match(texto, /7e57\*\*\*\*aaaa/); assert.match(texto, /ea10\*\*\*\*bbbb/);
        assert.equal(await pagina.locator("[data-desconectar-conexao]").count(), 2);
        assert.equal(await pagina.locator('[data-acao="desconectar"]').count(), 0, "sem 'desconectar tudo'");
        const html = await pagina.content();
        assert.ok(!/7e570000|ea100000/.test(html), "merchant nunca inteiro na tela");
        await captura(pagina, `multi-${nome}-duas-conexoes`);
        await semEstouro(pagina, `${nome} duas conexões`);

        await pagina.locator(`[data-desconectar-conexao="${ID_PED}"]`).click();
        await pagina.waitForFunction(() => document.querySelectorAll("[data-desconectar-conexao]").length === 1);
        assert.match(dialogos[0], /SOMENTE a conexão "Order\/Events — Produção"/);
        assert.match(dialogos[0], /As outras conexões desta unidade NÃO serão afetadas/);
        const del = ctl.chamadas.filter((c) => c.metodo === "DELETE");
        assert.equal(del.length, 1);
        assert.equal(del[0].consulta, `?conexaoId=${ID_PED}`);
        assert.equal(await pagina.locator(`[data-desconectar-conexao="${ID_FIN}"]`).count(), 1, "o Financial de homologação segue lá");
        assert.match(await pagina.locator("#ifood-conexoes").innerText(), /Financial — Homologação/);
        await captura(pagina, `multi-${nome}-apos-desconectar-pedidos`);
        await semEstouro(pagina, `${nome} após desconectar`);
        assert.deepEqual(erros, []);
      } finally { await fechar(); }
    });
  }

  test("unidade com uma conexão só (Saci): tela de sempre, com o Desconectar genérico e sem a seção de conexões", async () => {
    const saci = { ...statusNorth([]), merchant: mReal, financialHomologacao: false };
    delete saci.conexoes;
    ctl.status = saci; ctl.chamadas = [];
    const { pagina, erros, fechar } = await abrir();
    try {
      assert.equal(await pagina.locator("#ifood-conexoes").count(), 0);
      assert.equal(await pagina.locator('[data-acao="desconectar"]').count(), 1);
      assert.deepEqual(erros, []);
    } finally { await fechar(); }
  });
});
