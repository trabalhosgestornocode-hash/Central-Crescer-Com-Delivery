// iFood — autorização de uma LOJA ADICIONAL (Saladas) em NAVEGADOR REAL (Chromium/Chrome via Playwright), desktop e celular.
//
// Servidor local mínimo: serve o frontend e responde a API do iFood com respostas SIMULADAS e roteirizadas (status, /oauth/start,
// /oauth/complete) registrando cada chamada. Nunca fala com produção, Supabase nem iFood: sem OAuth real, sem userCode real.
// A lógica de verdade (escopo do token, gravação só na credencial da loja, polling intacto) é do backend e tem testes próprios
// (backend/test/ifood-oauth-loja-adicional-ui.test.js e ifood-credencial-por-loja-*.test.js).
//
// Rodar:
//   IFOOD_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright IFOOD_BROWSER_CHANNEL=chrome \
//   node --test frontend/test/ifood-loja-adicional.browser.test.js
// IFOOD_SCREENSHOTS=<pasta> grava capturas das telas.

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

const LOJA = "22222222-2222-4222-8222-2222222222a1";
const OUTRA_LOJA = "22222222-2222-4222-8222-2222222222b1";
const SALADAS_INTEIRO = "04a17bf5-b9e6-4693-a862-a5715e9f9374";
const IFOOD_API = "/api/v1/integracoes/ifood";

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/styles.css">
<script>window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})};</script>
</head><body>
<div id="app" class="app"><div class="main"><header class="topbar"><h1 id="page-title">Integração iFood</h1></header><main id="view" class="content"></main></div></div>
</body></html>`;

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

/** Status da unidade (Sanduíches conectada + Saladas como loja adicional). `credencial`/`estado` mudam ao concluir. */
function statusBase({ lojas, orderConectado = true } = {}) {
  return {
    conectado: false, status: "ativa", merchant: { idMascarado: "a6e5****39b9", nome: "Subway Sanduíches", razaoSocial: "X LTDA" },
    apps: { analytics: { conectado: false, status: null }, financial: { conectado: false, status: null } },
    order: {
      configurado: true, conectado: orderConectado, status: orderConectado ? "ativa" : null, tokenValido: orderConectado, expiraEm: null, merchant: null,
      ultimaAutenticacao: null, tokenAtualizadoEm: null, ultimoEvento: null, ultimoAck: null, ultimoPedido: null, eventosComFalha: 0, worker: null,
      observabilidadeDisponivel: false, erroAtual: null, lojaValidada: orderConectado, lojaInformada: null, validacaoFinalHabilitada: false,
    },
    ...(lojas ? { lojasAdicionais: lojas } : {}),
    eventosRecebimento: { estado: "active" }, atencao: { total: 0, apps: [] }, conectadaEm: "2026-10-10T12:00:00Z", homologacao: false, financialHomologacao: false,
  };
}
const saladas = (extra = {}) => ({ id: LOJA, rotulo: "Saladas", idMascarado: "04a1****9374", estado: "pendente", credencial: null, ...extra });

let servidor; let base; let navegador;
const ctl = { status: statusBase({ lojas: [saladas()] }), startRespostas: [], completeRespostas: [], chamadas: [] };
const reiniciar = (status) => { ctl.status = status; ctl.startRespostas = []; ctl.completeRespostas = []; ctl.chamadas = []; };

function lerCorpo(req) { return new Promise((r) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); }); }
const json = (res, status, corpo) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(corpo)); };

before(async () => {
  if (PULAR) return;
  servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/" || url.pathname === "/index.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end(PAGINA); }
    if (url.pathname.startsWith("/api/")) {
      const corpo = req.method === "POST" ? await lerCorpo(req) : null;
      ctl.chamadas.push({ metodo: req.method, caminho: url.pathname.replace(IFOOD_API, ""), corpo });
      if (url.pathname === `${IFOOD_API}/status` && req.method === "GET") return json(res, 200, { data: ctl.status });
      if (url.pathname === `${IFOOD_API}/oauth/start`) {
        const roteiro = ctl.startRespostas.shift();
        if (roteiro) return json(res, roteiro.status, roteiro.json);
        return json(res, 201, { data: { sessionId: "33333333-3333-4333-8333-333333333333", appType: "order", userCode: "SIMU-LADO", verificationUrl: "https://portal.exemplo/codigo", verificationUrlComplete: "https://portal.exemplo/codigo?c=SIMU-LADO", expiraEm: new Date(Date.now() + 10 * 60_000).toISOString() } });
      }
      if (url.pathname === `${IFOOD_API}/oauth/complete`) {
        const roteiro = ctl.completeRespostas.shift();
        if (roteiro) return json(res, roteiro.status, roteiro.json);
        // sucesso simulado: a credencial própria da loja passa a `ativa`; o ESTADO do polling não muda
        ctl.status = { ...ctl.status, lojasAdicionais: ctl.status.lojasAdicionais.map((l) => (l.id === LOJA ? { ...l, credencial: "ativa" } : l)) };
        return json(res, 200, { data: { appType: "order", status: "authorized", conexaoStatus: "ativa", lojaAlvo: true } });
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

async function abrir({ viewport = DESKTOP, permissoes = ["integracoes.ver", "integracoes.gerenciar"] } = {}) {
  const contexto = await navegador.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  const pagina = await contexto.newPage();
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  pagina.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) erros.push(m.text()); });
  await pagina.goto(base + "/");
  await pagina.evaluate(async (perms) => {
    const { state } = await import("/src/state.js");
    Object.assign(state.sessao, { empresa: { id: "org", nome: "Empresa de teste" }, unidade: "00000000-0000-0000-0000-0000000000a1", permissoes: perms, modulos: ["ifood"] });
    state.rota = "ifood";
    (await import("/src/ifood.js")).renderIfood();
  }, permissoes);
  await pagina.locator("#ifood-operacao").waitFor();
  return { pagina, erros, fechar: () => contexto.close() };
}
const texto = (pagina, sel) => pagina.locator(sel).innerText();
const captura = async (pagina, nome) => { if (CAPTURAS) await pagina.screenshot({ path: resolve(CAPTURAS, `${nome}.png`), fullPage: true }); };
async function semEstouro(pagina, rotulo) {
  const r = await pagina.evaluate(() => {
    const largura = document.documentElement.clientWidth;
    const fora = [...document.querySelectorAll("#view button, #view input, #view a.btn, #view .ifood-codigo-box, #view .ifood-loja-item")]
      .filter((n) => n.offsetParent !== null)
      .map((n) => ({ id: n.id || n.textContent.trim().slice(0, 30), d: Math.round(n.getBoundingClientRect().right) }))
      .filter((x) => x.d > largura + 1);
    return { largura, rolagem: document.documentElement.scrollWidth, fora };
  });
  assert.ok(r.rolagem <= r.largura + 1, `${rotulo}: rolagem horizontal (${r.rolagem} > ${r.largura})`);
  assert.deepEqual(r.fora, [], `${rotulo}: elementos fora da tela`);
}
async function aguardarMsg(pagina, padrao) {
  await pagina.waitForFunction((fonte) => new RegExp(fonte, "i").test(document.querySelector("#ifood-msg")?.textContent ?? ""), padrao.source);
  return pagina.locator("#ifood-msg").innerText();
}
const chamadasDe = (caminho) => ctl.chamadas.filter((c) => c.caminho === caminho);

describe("iFood — autorização da loja adicional, no navegador", { skip: PULAR }, () => {
  for (const [nome, viewport] of [["desktop", DESKTOP], ["celular", CELULAR]]) {
    test(`${nome}: painel -> selecionar a Saladas -> código -> erro de escopo -> novo código -> concluir; o polling segue desligado`, async () => {
      reiniciar(statusBase({ lojas: [saladas()] }));
      const { pagina, erros, fechar } = await abrir({ viewport });
      try {
        // 1. O painel mostra a loja pelo NOME, sem o merchant inteiro; o botão está lá
        const card = pagina.locator("#ifood-lojas-adicionais");
        await card.waitFor();
        assert.match(await card.innerText(), /Saladas/);
        assert.match(await card.innerText(), /04a1\*\*\*\*9374/);
        assert.equal(await texto(pagina, "[data-polling]"), "Aguardando liberação");
        assert.equal(await texto(pagina, "[data-credencial]"), "Autorização: Não autorizada");
        assert.ok(!(await pagina.content()).includes(SALADAS_INTEIRO), "o merchant inteiro nunca chega à tela");
        const botao = pagina.locator(`[data-autorizar-loja="${LOJA}"]`);
        assert.equal((await botao.innerText()).trim(), "Autorizar Saladas");
        await captura(pagina, `01-${nome}-painel-com-saladas`);
        await semEstouro(pagina, `${nome} painel`);

        // 2. O assistente mostra a loja SELECIONADA antes de gerar o código; sem campo para digitar merchant
        await botao.click();
        await pagina.locator("#ifood-loja-selecionada").waitFor();
        const sel = await texto(pagina, "#ifood-loja-selecionada");
        assert.match(sel, /Saladas/);
        assert.match(sel, /conta desta loja/);
        assert.match(sel, /não ativa o recebimento de pedidos/);
        assert.equal(await pagina.locator("#view input").count(), 0, "nenhum campo de texto antes de gerar o código (nada de merchant digitado)");
        assert.equal(chamadasDe("/oauth/start").length, 0, "nada é chamado só por abrir o assistente");
        await captura(pagina, `02-${nome}-assistente-antes-do-codigo`);
        await semEstouro(pagina, `${nome} assistente`);

        // 3. Gera o código: o corpo leva `lojaId` da lista (nunca o merchant)
        await pagina.locator("#ifood-gerar").click();
        await pagina.locator(".ifood-codigo").waitFor();
        assert.equal(await texto(pagina, ".ifood-codigo"), "SIMU-LADO");
        assert.deepEqual(chamadasDe("/oauth/start").at(-1).corpo, { appType: "order", lojaId: LOJA });
        assert.match(await texto(pagina, "#ifood-loja-selecionada"), /Saladas/, "a loja continua visível junto do código");
        await captura(pagina, `03-${nome}-codigo`);
        await semEstouro(pagina, `${nome} código`);

        // 4. Erro de ESCOPO: mensagem clara, continua na etapa, nada concluído
        ctl.completeRespostas.push({ status: 409, json: { error: "x", codigo: "IFOOD_CREDENCIAL_SEM_COBERTURA" } });
        await pagina.locator("#ifood-authcode").fill("CODIGO-DA-LOJA-ERRADA");
        await pagina.locator("#ifood-concluir").click();
        assert.match(await aguardarMsg(pagina, /não cobre esta loja/), /conta DA LOJA.*Nada foi alterado/);
        assert.equal(await pagina.locator("#ifood-concluir").isEnabled(), true);
        assert.deepEqual(chamadasDe("/oauth/complete").at(-1).corpo, { appType: "order", sessionId: "33333333-3333-4333-8333-333333333333", authorizationCode: "CODIGO-DA-LOJA-ERRADA" });
        await captura(pagina, `04-${nome}-erro-de-escopo`);

        // 5. Sessão expirada: aparece "Gerar novo código"; gerar de novo reutiliza a MESMA loja
        ctl.completeRespostas.push({ status: 409, json: { error: "x", codigo: "IFOOD_OAUTH_SESSAO_EXPIRADA" } });
        await pagina.locator("#ifood-concluir").click();
        await aguardarMsg(pagina, /expirou/);
        await pagina.locator("#ifood-regenerar").waitFor({ state: "visible" });
        await pagina.locator("#ifood-regenerar").click();
        // espera a tela REPINTAR com o novo código (o botão "Gerar novo código" volta a ficar oculto)
        await pagina.waitForFunction(() => document.querySelector("#ifood-regenerar")?.hidden === true);
        assert.equal(chamadasDe("/oauth/start").length, 2);
        assert.deepEqual(chamadasDe("/oauth/start").at(-1).corpo, { appType: "order", lojaId: LOJA });

        // 6. Concluir: volta ao painel com o aviso; a credencial passa a "Autorizada" e o POLLING CONTINUA "Aguardando liberação"
        await pagina.locator("#ifood-authcode").fill("CODIGO-CERTO");
        await pagina.locator("#ifood-concluir").click();
        await pagina.locator("#ifood-lojas-aviso").waitFor();
        assert.match(await texto(pagina, "#ifood-lojas-aviso"), /Saladas autorizada.*continua desligado/);
        assert.equal(await texto(pagina, "[data-credencial]"), "Autorização: Autorizada");
        assert.equal(await texto(pagina, "[data-polling]"), "Aguardando liberação");
        assert.equal((await pagina.locator(`[data-autorizar-loja="${LOJA}"]`).innerText()).trim(), "Reautorizar Saladas");
        assert.deepEqual(ctl.chamadas.filter((c) => c.metodo === "POST").map((c) => c.caminho), ["/oauth/start", "/oauth/complete", "/oauth/complete", "/oauth/start", "/oauth/complete"], "só o OAuth foi chamado: nenhuma ativação/liberação de loja");
        await captura(pagina, `05-${nome}-concluido`);
        await semEstouro(pagina, `${nome} concluído`);
        assert.deepEqual(erros, []);
      } finally { await fechar(); }
    });
  }

  test("cancelar (Voltar ao status) antes de concluir: volta ao painel, sem chamar /oauth/complete", async () => {
    reiniciar(statusBase({ lojas: [saladas()] }));
    const { pagina, erros, fechar } = await abrir();
    try {
      await pagina.locator(`[data-autorizar-loja="${LOJA}"]`).click();
      await pagina.locator("#ifood-gerar").click();
      await pagina.locator(".ifood-codigo").waitFor();
      await pagina.locator("#ifood-wizard-sair").click();
      await pagina.locator("#ifood-lojas-adicionais").waitFor();
      assert.equal(chamadasDe("/oauth/complete").length, 0);
      assert.equal(await texto(pagina, "[data-credencial]"), "Autorização: Não autorizada");
      assert.equal(await pagina.locator("#ifood-lojas-aviso").count(), 0, "cancelar não mostra aviso de sucesso");
      assert.deepEqual(erros, []);
    } finally { await fechar(); }
  });

  test("sem `integracoes.gerenciar`: a loja aparece, mas NÃO há botão para autorizar; nenhuma chamada de OAuth", async () => {
    reiniciar(statusBase({ lojas: [saladas()] }));
    const { pagina, fechar } = await abrir({ permissoes: ["integracoes.ver"] });
    try {
      await pagina.locator("#ifood-lojas-adicionais").waitFor();
      assert.equal(await pagina.locator("[data-autorizar-loja]").count(), 0);
      assert.match(await texto(pagina, "#ifood-lojas-adicionais"), /Sem permissão para gerenciar integrações/);
      assert.equal(chamadasDe("/oauth/start").length, 0);
    } finally { await fechar(); }
  });

  test("id de loja forjado no DOM (que não está na lista do status) não abre o assistente nem chama o OAuth", async () => {
    reiniciar(statusBase({ lojas: [saladas()] }));
    const { pagina, fechar } = await abrir();
    try {
      await pagina.evaluate((outra) => { document.querySelector("[data-autorizar-loja]").dataset.autorizarLoja = outra; }, OUTRA_LOJA);
      await pagina.locator(`[data-autorizar-loja="${OUTRA_LOJA}"]`).click();
      await pagina.waitForTimeout(150);
      assert.equal(await pagina.locator("#ifood-loja-selecionada").count(), 0);
      assert.equal(chamadasDe("/oauth/start").length, 0);
    } finally { await fechar(); }
  });

  test("app de pedidos NÃO conectado: a loja aparece mas a ação fica indisponível, com a explicação", async () => {
    reiniciar(statusBase({ lojas: [saladas()], orderConectado: false }));
    const { pagina, fechar } = await abrir();
    try {
      await pagina.locator("#ifood-lojas-adicionais").waitFor();
      assert.equal(await pagina.locator("[data-autorizar-loja]").count(), 0);
      assert.match(await texto(pagina, "#ifood-lojas-adicionais"), /Conecte primeiro o app de pedidos/);
    } finally { await fechar(); }
  });

  test("a Sanduíches mantém o fluxo atual: sem lojas adicionais não há bloco novo, e conectar pedidos envia SÓ { appType }", async () => {
    reiniciar(statusBase({ orderConectado: false }));
    ctl.status = { ...ctl.status, merchant: null, order: { ...ctl.status.order, lojaValidada: false } };
    const { pagina, erros, fechar } = await abrir();
    try {
      assert.equal(await pagina.locator("#ifood-lojas-adicionais").count(), 0);
      await pagina.locator('[data-acao="conectar_order"]').click();
      assert.equal(await pagina.locator("#ifood-loja-selecionada").count(), 0, "o assistente da Sanduíches não mostra loja selecionada");
      await pagina.locator("#ifood-gerar").click();
      await pagina.locator(".ifood-codigo").waitFor();
      assert.deepEqual(chamadasDe("/oauth/start").at(-1).corpo, { appType: "order" }, "exatamente o corpo de antes: sem lojaId nem merchantId");
      assert.deepEqual(erros, []);
    } finally { await fechar(); }
  });
});
