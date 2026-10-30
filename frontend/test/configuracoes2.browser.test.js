// Configurações 2.0 + Central de Notificações + páginas do titular em NAVEGADOR REAL (Chrome via Playwright).
//
// Servidor local em memória: serve o frontend e responde a Central com os SERVICES REAIS do backend
// (notificacoes.service / notificacoes.titular.service / notificacoes.permissoes) sobre o cenário em memória dos testes do
// backend. Transporte do código = SIMULAÇÃO (caixa em memória do processo; o "titular" lê o código dali, como leria no
// WhatsApp). Nunca fala com produção, Supabase, iFood ou WhatsApp.
//
// Rodar:
//   CHECKLIST_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright CHECKLIST_BROWSER_CHANNEL=chrome \
//   node --test frontend/test/configuracoes2.browser.test.js
// (precisa de backend/node_modules). CHECKLIST_SCREENSHOTS=<pasta> grava capturas.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.CHECKLIST_PLAYWRIGHT_PATH || "playwright")); } catch { /* sem Playwright: pulado */ }
const PULAR = !chromium && "Configure CHECKLIST_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.CHECKLIST_BROWSER_CHANNEL;
const CAPTURAS = process.env.CHECKLIST_SCREENSHOTS;
const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ENV_SIM = { NOTIFICACOES_OTP_TRANSPORTE: "simulacao", NOTIFICACOES_AMBIENTE_ISOLADO: "true", NODE_ENV: "test" };

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/configuracoes.css">
<script>window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:"acc"}}}),
  mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:"aal1",nextLevel:"aal1"}}),listFactors:async()=>({data:{totp:[]}})}}})};</script>
</head><body>
<div id="app" class="app"><div class="main"><main id="view" class="content"></main></div></div><div id="toast" class="toast"></div>
</body></html>`;

let servidor; let base; let M;
const est = { cen: null, titular: null, permissoes: [], papel: "organization_admin", unidade: null, corpos: [], unidadeDados: null, convitesUsuario: [] };

function novoCenario() {
  const cen = M.fake.cenario();
  const db = cen.db;
  const desafios = [];
  // Repositório do titular sobre o MESMO banco em memória da Central (o convite criado na tela é o que o titular abre).
  const titular = {
    obterConvitePorToken: async (h) => db.convites.find((c) => c.token_hash === h) ?? null,
    obterNomes: async ({ unidadeIds }) => ({ empresa: "Rede Sabor", unidades: db.unidades.filter((u) => unidadeIds.includes(u.id)).map((u) => ({ id: u.id, nome: u.nome })) }),
    termoVigente: async () => ({ versao: 1, texto: "RASCUNHO — SOMENTE SIMULAÇÃO. Autorizo {empresa} a me enviar os avisos escolhidos.", rascunho: true }),
    criarDesafio: async (p) => {
      const ultimo = desafios.filter((d) => d.telefoneHmac === p.telefoneHmac).at(-1);
      if (ultimo && Date.now() - ultimo.criado < 60_000) return { resultado: "AGUARDE", segundos: 60 };
      desafios.filter((d) => d.telefoneHmac === p.telefoneHmac).forEach((d) => { d.invalidado = true; });
      const d = { id: randomUUID(), ...p, tentativas: 0, criado: Date.now() };
      desafios.push(d);
      return { resultado: "CRIADO", desafio_id: d.id };
    },
    verificarDesafio: async ({ desafioId, codigoHmac }) => {
      const d = desafios.find((x) => x.id === desafioId);
      if (!d || d.consumido_em || d.invalidado) return { resultado: "INVALIDO" };
      d.tentativas += 1;
      if (d.codigoHmac !== codigoHmac) return d.tentativas >= 5 ? { resultado: "BLOQUEADO" } : { resultado: "INCORRETO", restantes: 5 - d.tentativas };
      d.consumido_em = new Date().toISOString();
      const c = db.convites.find((x) => x.id === d.conviteId);
      if (c) c.status = "VERIFICADO";
      return { resultado: "VERIFICADO", simulado: true };
    },
    obterDesafio: async (id) => { const d = desafios.find((x) => x.id === id); return d ? { id: d.id, tipo: d.tipo, telefone_hmac: d.telefoneHmac, consumido_em: d.consumido_em ?? null } : null; },
    consentir: async (p) => {
      const c = db.convites.find((x) => x.id === p.conviteId);
      const d = desafios.find((x) => x.id === p.desafioId);
      if (!c || !d?.consumido_em || d.conviteId !== c.id) return { resultado: "VERIFICACAO_EXPIRADA" };
      c.status = "CONCLUIDO";
      if (!p.categorias.length) return { resultado: "RECUSADO_PELO_TITULAR", simulado: true };
      const ce = { id: randomUUID(), organizacao_id: c.organizacao_id, nome: c.nome, tipo: c.tipo_destinatario, telefone_e164: p.telefoneE164, whatsapp_status: "NAO_VALIDADO", ativo: true, created_at: new Date().toISOString(), contato_whatsapp_id: null };
      db.destinatarios.push(ce);
      for (const u of c.unidades_pretendidas) for (const k of p.categorias) {
        db.escopos.push({ id: randomUUID(), contato_empresa_id: ce.id, unidade_escopo_id: u, categoria: k, habilitado: true, origem_autorizacao: "CONVITE_OTP", origem_vinculo: "CONVITE", suspenso_em: null, notificar_correcao: false, verificacao_simulada: true });
      }
      for (const k of p.categorias) db.ledger.unshift({ id: randomUUID(), contato_empresa_id: ce.id, organizacao_id: c.organizacao_id, categoria: k, acao: "CONCEDIDO", termo_versao: p.termoVersao, origem: "link_convite_otp", simulado: true, ocorreu_em: new Date().toISOString() });
      return { resultado: "CONSENTIDO", contato_empresa_id: ce.id, simulado: true };
    },
    destinatariosDoNumero: async (e164) => db.destinatarios.filter((d) => d.telefone_e164 === e164 && d.ativo),
    revogar: async (p) => {
      for (const e of db.escopos) if (p.contatosEmpresa.includes(e.contato_empresa_id) && (!p.categorias || p.categorias.includes(e.categoria))) e.habilitado = false;
      for (const l of db.categoriasLegadas) if (p.contatosEmpresa.includes(l.contato_empresa_id) && (!p.categorias || p.categorias.includes(l.categoria))) l.habilitado = false;
      for (const ce of p.contatosEmpresa) {
        const org = db.destinatarios.find((d) => d.id === ce)?.organizacao_id;
        for (const k of p.categorias ?? ["pendencia_d1", "fechamento_operacional_diario"]) db.ledger.unshift({ id: randomUUID(), contato_empresa_id: ce, organizacao_id: org, categoria: k, acao: "REVOGADO", origem: p.origem, simulado: true, ocorreu_em: new Date().toISOString() });
      }
      db.chamadas.push(["revogar", p]);
      return { resultado: "REVOGADO", mensagens_canceladas: 0 };
    },
  };
  est.cen = cen;
  est.repo = { ...cen.repo, ...titular, resolverD1PorUnidade: cen.repo.resolverD1PorUnidade };
  est.unidadeDados = { id: M.fake.UN.A1, nome: "Centro", cnpj: "", endereco: "", cidade: "Belo Horizonte", estado: "MG", responsavel: "", email: "", telefone: "", status: "ativa",
    timezone: null, horarioFuncionamento: null, fusoDisponivel: true, fusoCorte: null };
  est.convitesUsuario = [];
  est.corpos = [];
}

before(async () => {
  if (PULAR) return;
  Object.assign(process.env, { SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "ficticio_service_role_key_0123456789abcdef", SUPABASE_ANON_KEY: "ficticio_anon_key_0123456789abcdef0123",
    NOTIFICACOES_SEGREDO_MESTRE: "segredo-de-teste-da-central-0123456789abcdef" });
  const back = (m) => import(new URL(`../../backend/${m}`, import.meta.url));
  M = {
    svc: await back("src/modules/notificacoes/notificacoes.service.js"),
    tit: await back("src/modules/notificacoes/notificacoes.titular.service.js"),
    perm: await back("src/modules/notificacoes/notificacoes.permissoes.js"),
    envio: await back("src/modules/notificacoes/notificacoes.envio.js"),
    unidade: await back("src/modules/unidade/unidade.service.js"),
    fake: await back("test/helpers/notificacoes-fake.js"),
  };
  novoCenario();
  const json = (res, status, corpo) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(corpo)); };
  const lerCorpo = (req) => new Promise((r) => { let c = ""; req.on("data", (x) => { c += x; }); req.on("end", () => r(c ? JSON.parse(c) : {})); });
  const deps = () => ({ repo: est.repo, env: ENV_SIM, auditar: async () => {}, semEspera: true });
  const reqFalso = () => ({ tenant: { organizacaoId: M.fake.ORG_A, unidadeId: est.unidade }, acesso: { permissoes: est.permissoes, papel: est.papel }, user: { id: "u-gestor", email: "gestor@x.com" }, perfil: { id: "p-gestor", nome: "Gestor" } });
  servidor = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    try {
      if (p === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(PAGINA); return; }
      if (p === "/favicon.ico") { res.writeHead(204).end(); return; }
      if (p === "/api/config") return json(res, 200, { supabaseUrl: "http://127.0.0.1:9", supabaseAnonKey: "x" });
      const corpo = ["POST", "PATCH", "PUT"].includes(req.method) ? await lerCorpo(req) : null;
      if (p.startsWith("/api/")) est.corpos.push({ metodo: req.method, p, corpo });
      // ---- unidade ----
      if (p === "/api/v1/unidade/dados" && req.method === "GET") return json(res, 200, { data: est.unidadeDados });
      if (p === "/api/v1/unidade/dados" && req.method === "PATCH") {
        if ("timezone" in corpo && corpo.timezone && !Intl.supportedValuesOf("timeZone").includes(corpo.timezone)) return json(res, 400, { error: "Fuso inválido." });
        const horario = "horarioFuncionamento" in corpo ? M.unidade.validarHorario(corpo.horarioFuncionamento) : est.unidadeDados.horarioFuncionamento;
        est.unidadeDados = { ...est.unidadeDados, ...corpo, horarioFuncionamento: horario };
        return json(res, 200, { data: est.unidadeDados });
      }
      if (p === "/api/v1/unidade/metas-cmv") return json(res, 200, { data: { persistido: false, cmvSaudavel: 30, cmvAtencao: 35, metaFatDia: null, metaFatMes: null, margemMinima: null } });
      if (p === "/api/v1/unidade/tabelas-comerciais") return json(res, 200, { data: { tabelaBalcao: "E", tabelaIfood: null, catalogo: { balcao: ["E"], ifood: ["Z4"] } } });
      if (p === "/api/v1/inteligencia/integracoes") return json(res, 200, { data: [{ id: "ifood", nome: "iFood", conectado: true }] });
      // ---- usuários (D-14) ----
      if (p === "/api/v1/usuarios" && req.method === "GET") return json(res, 200, { data: [{ id: "u1", nome: "Gestor", email: "gestor@x.com", papel: "organization_admin", ativo: true, gerenciavelAqui: true, unidades: [] }] });
      if (p === "/api/v1/usuarios" && req.method === "POST") {
        est.convitesUsuario.push({ id: randomUUID(), nome: corpo.nome, papel: corpo.papel, emailMascarado: `${corpo.email.slice(0, 2)}${"*".repeat(8)}@${corpo.email.split("@")[1]}`, envio: "DESLIGADO", expirado: false });
        return json(res, 201, { data: { tipo: "CONVITE_CRIADO", convite: { envio: "DESLIGADO" } } });
      }
      if (p === "/api/v1/usuarios/convites" && req.method === "GET") return json(res, 200, { data: est.convitesUsuario });
      if (p.startsWith("/api/v1/usuarios/convites/") && req.method === "DELETE") { est.convitesUsuario = est.convitesUsuario.filter((c) => c.id !== p.split("/").pop()); return json(res, 200, { data: { revogado: true } }); }
      // ---- Central (services reais) ----
      const N = "/api/v1/notificacoes";
      if (p.startsWith(N)) {
        const r = reqFalso();
        const rota = p.slice(N.length);
        if (rota === "/resumo") return json(res, 200, { data: await M.svc.resumo({ escopo: M.perm.exigirVer(r), deps: deps() }) });
        if (rota === "/categorias") { M.perm.exigirVer(r); return json(res, 200, { data: await M.svc.listarCategorias({ deps: deps() }) }); }
        if (rota === "/destinatarios") return json(res, 200, { data: await M.svc.listarDestinatarios({ escopo: M.perm.exigirVer(r), deps: deps() }) });
        if (rota === "/historico") return json(res, 200, { data: await M.svc.historico({ escopo: M.perm.exigirVer(r), deps: deps() }) });
        if (rota === "/consentimentos") return json(res, 200, { data: await M.svc.consentimentos({ escopo: M.perm.exigirVer(r), deps: deps() }) });
        if (rota === "/auditoria") return json(res, 200, { data: await M.svc.auditoria({ escopo: M.perm.exigirGerenciar(r), deps: deps() }) });
        if (rota === "/convites" && req.method === "POST") return json(res, 201, { data: await M.svc.criarConvite({ req: r, escopo: M.perm.exigirGerenciar(r), corpo, baseUrl: base, deps: deps() }) });
        let m = rota.match(/^\/convites\/([^/]+)\/cancelar$/);
        if (m) return json(res, 200, { data: await M.svc.cancelarConvite({ req: r, escopo: M.perm.exigirGerenciar(r), id: m[1], deps: deps() }) });
        m = rota.match(/^\/destinatarios\/([^/]+)\/(suspensao|preferencias|vincular-unidade|pedido-revogacao)$/);
        if (m) {
          const fn = { suspensao: "suspender", preferencias: "definirPreferencias", "vincular-unidade": "vincularLegado", "pedido-revogacao": "registrarPedidoRevogacao" }[m[2]];
          return json(res, 200, { data: await M.svc[fn]({ req: r, escopo: M.perm.exigirGerenciar(r), destinatarioId: m[1], corpo, deps: deps() }) });
        }
      }
      // ---- titular (público) ----
      const T = "/api/publico/notificacoes";
      if (p.startsWith(T) && req.method === "POST") {
        const d = deps(); const rota = p.slice(T.length); const ip = "203.0.113.9";
        const fn = {
          "/convite/abrir": () => M.tit.abrirConvite({ token: corpo.token, deps: d }),
          "/convite/codigo": () => M.tit.pedirCodigoConvite({ token: corpo.token, ip, deps: d }),
          "/convite/verificar": () => M.tit.verificarCodigoConvite({ ...corpo, deps: d }),
          "/convite/consentir": () => M.tit.consentirConvite({ ...corpo, ip, userAgent: "teste", deps: d }),
          "/gestao/codigo": () => M.tit.pedirCodigoGestao({ telefone: corpo.telefone, ip, deps: d }),
          "/gestao/verificar": () => M.tit.verificarCodigoGestao({ ...corpo, deps: d }),
          "/gestao/inscricoes": () => M.tit.minhasInscricoes({ sessao: corpo.sessao, e164: corpo.telefone, deps: d }),
          "/gestao/revogar": () => M.tit.revogarComoTitular({ ...corpo, e164: corpo.telefone, ip, deps: d }),
        }[rota];
        if (fn) return json(res, 200, { data: await fn() });
      }
      if (p.startsWith("/api/")) return json(res, 404, { error: "não encontrado" });
      const arq = resolve(RAIZ, "." + p);
      if (!arq.startsWith(RAIZ + sep)) { res.writeHead(403).end(); return; }
      res.setHeader("Content-Type", arq.endsWith(".css") ? "text/css" : arq.endsWith(".html") ? "text/html; charset=utf-8" : arq.endsWith(".svg") ? "image/svg+xml" : "text/javascript");
      res.end(readFileSync(arq));
    } catch (e) {
      json(res, e?.statusCode ?? 500, { error: e?.message ?? "erro" });
    }
  });
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
});
after(async () => { if (servidor) await new Promise((r) => servidor.close(r)); });

const ADMIN = ["configuracoes.ver", "configuracoes.gerenciar", "usuarios.gerenciar", "notificacoes.ver", "notificacoes.gerenciar"];
async function abrir(browser, { viewport = { width: 1366, height: 900 }, permissoes = ADMIN, papel = "organization_admin", unidade = M.fake.UN.A1, tema = "light", secao = null } = {}) {
  est.permissoes = permissoes; est.papel = papel; est.unidade = unidade;
  const ctx = await browser.newContext({ viewport, permissions: ["clipboard-read", "clipboard-write"] });
  const pagina = await ctx.newPage();
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  pagina.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) erros.push(m.text()); });
  await pagina.goto(base + "/");
  await pagina.evaluate(async ({ org, unidade: un, permissoes: perms, papel: pp, tema: t, secao: s }) => {
    sessionStorage.clear();
    document.documentElement.setAttribute("data-theme", t);
    window.__navegacoes = [];
    document.addEventListener("app:navegar", (e) => window.__navegacoes.push(e.detail.rota));
    const { state } = await import("/src/state.js");
    Object.assign(state.sessao, { empresa: { id: org, nome: "Rede Sabor" }, unidade: un ? { id: un, nome: "Centro" } : null, permissoes: perms, papel: pp, modulos: [] });
    state.rota = "configuracoes";
    const cfg = await import("/src/configuracoes.js");
    if (s) cfg.abrirSecaoConfiguracoes(s); else cfg.renderConfiguracoes();
  }, { org: M.fake.ORG_A, unidade, permissoes, papel, tema, secao });
  await pagina.locator("[data-cfg2]").waitFor();
  return { ctx, pagina, erros };
}
const foto = async (pagina, nome) => { if (CAPTURAS) await pagina.screenshot({ path: resolve(CAPTURAS, `${nome}.png`), fullPage: true, animations: "disabled" }); };
const semRolagemHorizontal = (pagina) => pagina.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const texto = (pagina) => pagina.evaluate(() => document.body.innerText);
const categoria = async (pagina, id) => { await pagina.locator(`[data-cat="${id}"]`).click(); await pagina.locator(`[data-cat="${id}"][aria-current="true"]`).waitFor(); };

const OPC = { skip: PULAR };
describe("Configurações 2.0 em navegador real", { timeout: 300_000 }, () => {
  let browser;
  before(async () => { if (PULAR) return; browser = await chromium.launch({ headless: true, ...(CANAL ? { channel: CANAL } : {}) }); });
  after(async () => { await browser?.close(); });

  test("desktop: 7 categorias com teclado; Unidade valida, mostra estado de salvamento e grava fuso + horário", OPC, async () => {
    novoCenario();
    const { ctx, pagina, erros } = await abrir(browser);
    assert.equal(await pagina.locator("[data-cat]").count(), 7);
    await pagina.locator("#u-nome").waitFor();
    await foto(pagina, "cfg2-unidade-desktop");
    await pagina.locator('[data-cat="unidade-empresa"]').focus();
    await pagina.keyboard.press("ArrowDown");
    assert.equal(await pagina.evaluate(() => document.activeElement?.dataset.cat), "metas-operacao", "setas percorrem as categorias");
    // validação no campo, sem gravar
    const secaoUnidade = pagina.locator("#cfg-corpo-unidade");
    await secaoUnidade.locator("#u-cnpj").fill("11.111.111/1111-11");
    assert.match(await secaoUnidade.locator("[data-estado]").textContent(), /Alterações não salvas/);
    await secaoUnidade.locator("[data-salvar]").click();
    await pagina.waitForFunction(() => /CNPJ inválido/.test(document.querySelector("#u-cnpj-erro")?.textContent ?? ""));
    assert.ok(!est.corpos.some((c) => c.metodo === "PATCH" && c.p === "/api/v1/unidade/dados"), "CNPJ inválido não vai ao servidor");
    await secaoUnidade.locator("#u-cnpj").fill("11.222.333/0001-81");
    await secaoUnidade.locator("[data-salvar]").click();
    await pagina.waitForFunction(() => /Salvo às/.test(document.querySelector("#cfg-corpo-unidade [data-estado]")?.textContent ?? ""));
    // fuso + horário (aberto até depois da meia-noite)
    const secaoFuso = pagina.locator("#cfg-corpo-fuso");
    await secaoFuso.locator("#u-fuso").selectOption("America/Manaus");
    await secaoFuso.locator('[data-aberto="sex"]').check();
    await secaoFuso.locator('[data-inicio="sex"]').fill("18:00");
    await secaoFuso.locator('[data-fim="sex"]').fill("01:00");
    await secaoFuso.locator("[data-salvar]").click();
    await pagina.waitForFunction(() => /Salvo às/.test(document.querySelector("#cfg-corpo-fuso [data-estado]")?.textContent ?? ""));
    const gravado = est.corpos.filter((c) => c.metodo === "PATCH" && c.p === "/api/v1/unidade/dados").at(-1).corpo;
    assert.equal(gravado.timezone, "America/Manaus");
    assert.deepEqual(gravado.horarioFuncionamento.sex, [{ inicio: "18:00", fim: "01:00" }]);
    assert.deepEqual(gravado.horarioFuncionamento.seg, []);
    assert.match(await texto(pagina), /uso do fuso por unidade ainda não foi ligado/);
    assert.deepEqual(erros, []);
    await ctx.close();
  });

  test("sair com alteração não salva pede confirmação em diálogo acessível (sem confirm())", OPC, async () => {
    novoCenario();
    const { ctx, pagina, erros } = await abrir(browser);
    await pagina.locator("#u-nome").fill("Centro Novo");
    await pagina.locator('[data-cat="preferencias"]').click();
    const dlg = pagina.locator("dialog.cfg-dialogo");
    await dlg.waitFor();
    assert.equal(await dlg.evaluate((d) => d.open), true);
    assert.match(await dlg.textContent(), /Sair sem salvar\?/);
    await pagina.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached" });
    assert.equal(await pagina.locator('[data-cat="unidade-empresa"][aria-current="true"]').count(), 1, "cancelar mantém a categoria");
    await pagina.locator('[data-cat="preferencias"]').click();
    await dlg.locator("[data-ok]").click();
    await pagina.locator('[data-cat="preferencias"][aria-current="true"]').waitFor();
    assert.deepEqual(erros, []);
    await ctx.close();
  });

  test("Metas e operação: atalhos navegam pelo shell; deep-link de Tabelas Comerciais mostra só a seção", OPC, async () => {
    novoCenario();
    const { ctx, pagina, erros } = await abrir(browser);
    await categoria(pagina, "metas-operacao");
    await pagina.locator('[data-rota="checklist-operacional"]').click();
    assert.deepEqual(await pagina.evaluate(() => window.__navegacoes), ["checklist-operacional"]);
    await ctx.close();
    const b = await abrir(browser, { secao: "precos" });
    await b.pagina.locator("text=Tabelas comerciais da unidade").waitFor();
    assert.equal(await b.pagina.locator("#cfg-corpo-cmv").count(), 0);
    await b.pagina.locator("#cfg-ver-categoria").click();
    await b.pagina.locator("#cfg-corpo-cmv").waitFor();
    assert.deepEqual([...erros, ...b.erros], []);
    await b.ctx.close();
  });

  test("Usuários e acesso (D-14): sem senha; conceder a e-mail novo cria convite com e-mail mascarado; cancelar por diálogo", OPC, async () => {
    novoCenario();
    const { ctx, pagina, erros } = await abrir(browser);
    await categoria(pagina, "usuarios-acesso");
    await pagina.locator("#nu-email").waitFor();
    assert.equal(await pagina.locator('#cfg-detalhe input[type="password"], #nu-senha').count(), 0, "nenhum campo de senha");
    await pagina.locator("#nu-add").click();
    await pagina.waitForFunction(() => /Informe um e-mail válido/.test(document.querySelector("#nu-email-erro")?.textContent ?? ""));
    await pagina.locator("#nu-nome").fill("Nova Pessoa");
    await pagina.locator("#nu-email").fill("nova.pessoa@empresa.com");
    await pagina.locator("#nu-add").click();
    await pagina.waitForFunction(() => /Envio de e-mail desativado/.test(document.body.innerText));
    const post = est.corpos.find((c) => c.metodo === "POST" && c.p === "/api/v1/usuarios");
    assert.ok(!("senha" in post.corpo), "a tela nunca envia senha");
    assert.match(await texto(pagina), /no\*{8}@empresa\.com/);
    assert.doesNotMatch(await texto(pagina), /nova\.pessoa@empresa\.com/);
    await foto(pagina, "cfg2-usuarios");
    await pagina.locator("[data-revogar]").click();
    await pagina.locator("dialog.cfg-dialogo [data-ok]").click();
    await pagina.waitForFunction(() => /Nenhum convite pendente/.test(document.body.innerText));
    assert.deepEqual(erros, []);
    await ctx.close();
  });

  test("Central (admin): simulação explícita, legado preservado, pendência; convite → link único → titular verifica e consente", OPC, async () => {
    novoCenario();
    M.envio._limparCaixaSimulada();
    const { ctx, pagina, erros } = await abrir(browser);
    await categoria(pagina, "notificacoes");
    await pagina.locator(".ntf-dest").first().waitFor();
    const h = await texto(pagina);
    assert.match(h, /Modo de simulação/);
    assert.match(h, /continua recebendo de todas as unidades/);
    assert.match(h, /Ativo — configuração anterior/);
    assert.match(h, /\+551\*{8}01/);
    assert.doesNotMatch(h, /\+5511900000001/);
    await foto(pagina, "cfg2-central-destinatarios");
    // convite
    await pagina.locator("[data-novo-convite]").click();
    await pagina.locator("#ntf-nome").waitFor();
    await pagina.locator("#ntf-nome").fill("Carla");
    await pagina.locator("#ntf-tel").fill("(31) 98888-7766");
    await pagina.locator('input[name="ntf-un"][value="' + M.fake.UN.A1 + '"]').check();
    await pagina.locator('input[name="ntf-cat"][value="fechamento_operacional_diario"]').check();
    await pagina.locator('form[data-form-convite] button[type="submit"]').click();
    await pagina.locator("#ntf-link-unico").waitFor();
    const link = await pagina.locator("#ntf-link-unico").inputValue();
    assert.match(link, /\/notificacoes\/convite\.html#t=[A-Za-z0-9_-]{43}$/);
    assert.match(await texto(pagina), /Aguardando verificação/);
    assert.match(await texto(pagina), /\+553\*{8}66/);
    await foto(pagina, "cfg2-central-convite");
    const convite = est.cen.db.convites.at(-1);
    assert.ok(!JSON.stringify(convite).includes("988887766"), "número só cifrado/HMAC/mascarado no banco");
    assert.equal(convite.simulado, true);
    // titular (sem conta) abre o link
    const tt = await ctx.newPage();
    tt.on("pageerror", (e) => erros.push(e.message));
    await tt.goto(link);
    await tt.locator("#tt-pedir").waitFor();
    assert.equal(new URL(tt.url()).hash, "", "o token sai da barra de endereço");
    assert.match(await tt.locator("body").innerText(), /Ambiente de simulação/);
    await tt.locator("#tt-pedir").click();
    await tt.locator("#tt-codigo").waitFor();
    const codigo = M.envio._ultimoCodigoSimulado({ telefoneHmac: convite.telefone_hmac });
    assert.match(codigo, /^\d{6}$/);
    await tt.locator("#tt-codigo").fill(codigo === "000000" ? "111111" : "000000");
    await tt.locator("#tt-form-codigo button[type=submit]").click();
    await tt.waitForFunction(() => /Código incorreto\. Restam 4/.test(document.body.innerText));
    await tt.locator("#tt-codigo").fill(codigo);
    await tt.locator("#tt-form-codigo button[type=submit]").click();
    await tt.locator("#tt-form-consentimento").waitFor();
    assert.equal(await tt.locator('input[name="cat"]:checked').count(), 0, "nenhum aviso pré-marcado");
    await tt.locator("#tt-form-consentimento button[type=submit]").click();
    await tt.waitForFunction(() => /Marque ao menos um aviso/.test(document.body.innerText));
    await tt.locator('input[name="cat"]').first().check();
    await foto(tt, "titular-consentimento");
    await tt.locator("#tt-form-consentimento button[type=submit]").click();
    await tt.waitForFunction(() => /Os avisos marcados foram autorizados/.test(document.body.innerText));
    // de volta à Central: a pessoa virou destinatária ATIVA (simulada), com o registro no livro de consentimentos
    await pagina.locator('[data-aba="destinatarios"]').click();
    await pagina.waitForFunction(() => /Carla/.test(document.querySelector("#ntf-painel")?.innerText ?? ""));
    await pagina.locator('[data-aba="consentimentos"]').click();
    await pagina.waitForFunction(() => /Concedido[\s\S]*pelo titular, com código/.test(document.querySelector("#ntf-painel")?.innerText ?? ""));
    assert.deepEqual(erros, []);
    await ctx.close();
  });

  test("gestão do titular: anti-enumeração na tela; com o código, vê e para de receber", OPC, async () => {
    novoCenario();
    M.envio._limparCaixaSimulada();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const tt = await ctx.newPage();
    const erros = [];
    tt.on("pageerror", (e) => erros.push(e.message));
    await tt.goto(base + "/notificacoes/gerenciar.html");
    // número inexistente: mesma mensagem, código nunca confere
    await tt.locator("#tt-tel").fill("(11) 97777-0000");
    await tt.locator("#tt-form-numero button").click();
    await tt.locator("#tt-codigo").waitFor();
    const msgInexistente = await tt.locator(".tt-aviso").textContent();
    await tt.locator("#tt-outro").click();
    await tt.locator("#tt-tel").fill("(11) 90000-0001");   // Ana — legado de duas empresas
    await tt.locator("#tt-form-numero button").click();
    await tt.locator("#tt-codigo").waitFor();
    assert.equal(await tt.locator(".tt-aviso").textContent(), msgInexistente, "mesma resposta exista ou não o número");
    const codigo = M.envio._ultimoCodigoSimulado({ telefoneHmac: (await import(new URL("../../backend/src/modules/notificacoes/notificacoes.segredos.js", import.meta.url))).hmacTelefone("+5511900000001") });
    await tt.locator("#tt-codigo").fill(codigo);
    await tt.locator("#tt-form-codigo button[type=submit]").click();
    await tt.locator("form.tt-empresa").first().waitFor();
    assert.equal(await tt.locator("form.tt-empresa").count(), 2, "as duas empresas em que o número recebe");
    assert.ok(await semRolagemHorizontal(tt));
    await foto(tt, "titular-gestao-390");
    await tt.locator("form.tt-empresa").first().locator("[data-sair-empresa]").click();
    await tt.waitForFunction(() => /você não recebe mais avisos desta empresa/.test(document.body.innerText));
    assert.equal(await tt.locator("form.tt-empresa").count(), 1);
    const rev = est.cen.db.chamadas.filter(([k]) => k === "revogar").at(-1)[1];
    assert.equal(rev.origem, "pagina_gestao_otp");
    assert.deepEqual(erros, []);
    await ctx.close();
  });

  test("gerente de unidade: vê só a própria unidade; o convite fica preso à unidade dele; sem auditoria da empresa toda", OPC, async () => {
    novoCenario();
    const { ctx, pagina, erros } = await abrir(browser, { papel: "unit_manager", permissoes: ["configuracoes.ver", "notificacoes.ver", "notificacoes.gerenciar"] });
    await categoria(pagina, "notificacoes");
    await pagina.locator(".ntf-abas").waitFor();
    await pagina.locator('[data-aba="convites"]').click();
    await pagina.locator('input[name="ntf-un"]').first().waitFor();
    assert.equal(await pagina.locator('input[name="ntf-un"]').count(), 1);
    assert.equal(await pagina.locator('input[name="ntf-un"]').isDisabled(), true);
    assert.equal(await pagina.locator('input[name="ntf-un"]').isChecked(), true);
    assert.equal(await pagina.locator('[data-cat="usuarios-acesso"]').count(), 1);
    await categoria(pagina, "usuarios-acesso");
    await pagina.waitForFunction(() => /Equipe desta empresa/.test(document.body.innerText));
    assert.equal(await pagina.locator("#nu-add").count(), 0, "sem usuarios.gerenciar: não concede acesso");
    assert.deepEqual(erros, []);
    await ctx.close();
  });

  test("celular 390 px: lista de categorias → detalhe → voltar; nenhuma categoria rola na horizontal; tema escuro", OPC, async () => {
    novoCenario();
    const { ctx, pagina, erros } = await abrir(browser, { viewport: { width: 390, height: 844 } });
    assert.equal(await pagina.locator(".cfg2-nav").isVisible(), true);
    assert.equal(await pagina.locator(".cfg2-conteudo").isVisible(), false, "no celular a tela inicial é a lista");
    await foto(pagina, "cfg2-390-lista");
    for (const id of ["unidade-empresa", "metas-operacao", "notificacoes", "usuarios-acesso", "integracoes", "seguranca-privacidade", "preferencias"]) {
      await pagina.locator(`[data-cat="${id}"]`).click();
      await pagina.locator(".cfg2--detalhe").waitFor();
      await pagina.waitForTimeout(150);
      assert.ok(await semRolagemHorizontal(pagina), `rolagem horizontal em ${id}`);
      if (id === "notificacoes" || id === "unidade-empresa") await foto(pagina, `cfg2-390-${id}`);
      await pagina.locator("#cfg-voltar").click();
      await pagina.locator(".cfg2:not(.cfg2--detalhe)").waitFor();
    }
    const alvo = await pagina.locator('[data-cat="notificacoes"]').boundingBox();
    assert.ok(alvo.height >= 44, "alvo de toque ≥ 44 px");
    await ctx.close();
    const escuro = await abrir(browser, { tema: "dark" });
    await categoria(escuro.pagina, "notificacoes");
    await escuro.pagina.locator(".ntf-abas").waitFor();
    await foto(escuro.pagina, "cfg2-central-escuro");
    assert.deepEqual([...erros, ...escuro.erros], []);
    await escuro.ctx.close();
  });
});
