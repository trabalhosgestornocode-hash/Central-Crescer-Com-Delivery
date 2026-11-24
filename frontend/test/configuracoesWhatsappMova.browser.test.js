// §5 — Configurações → "WhatsApp (MOVA)" no NAVEGADOR: o próprio usuário gera o código; o administrador aprova e revoga;
// rota desligada ⇒ a seção some. Backend REAL das rotas (serviço de identidade em memória), sessão injetada como requireContexto.
// Rodar: CHECKLIST_PLAYWRIGHT_PATH=.../playwright node --test frontend/test/configuracoesWhatsappMova.browser.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.CHECKLIST_PLAYWRIGHT_PATH || "playwright")); } catch { /* sem Playwright: pulado */ }
const PULAR = !chromium && "Configure CHECKLIST_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ORG = "11111111-1111-4111-8111-111111111111", UNI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANA = "a1000000-0000-4000-8000-000000000001", ADM = "a2000000-0000-4000-8000-000000000002";
const JID_ANA = "5585999990001@s.whatsapp.net";
const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/configuracoes.css">
<script>window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:"acc"}}}),
  mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:"aal1",nextLevel:"aal1"}}),listFactors:async()=>({data:{totp:[]}})}}})};</script>
</head><body><div id="app" class="app"><div class="main"><main id="view" class="content"></main></div></div><div id="toast" class="toast"></div></body></html>`;

let servidor, base, servico, ligado = true;
const sessao = { perfil: ANA, permissoes: [] };
const lancar = () => chromium.launch(process.env.CHECKLIST_BROWSER_CHANNEL ? { channel: process.env.CHECKLIST_BROWSER_CHANNEL } : {});

before(async () => {
  if (PULAR) return;
  Object.assign(process.env, { SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "ficticio_service_role_key_0123456789abcdef", SUPABASE_ANON_KEY: "ficticio_anon_key_0123456789abcdef0123" });
  const back = (m) => import(new URL(`../../backend/${m}`, import.meta.url));
  const express = createRequire(new URL("../../backend/package.json", import.meta.url))("express");
  const { criarRouterVinculoMova } = await back("src/modules/mova-core/rotasVinculo.js");
  const { criarServicoDeIdentidade } = await back("src/modules/mova-core/identidade.js");
  const ENTRADAS = [{ id: "pessoa-ana", nome: "Ana Caixa", ids: [JID_ANA], privado: JID_ANA }, { id: "pessoa-bia", nome: "Bia Gerente", ids: ["5585999990002@s.whatsapp.net"] }];
  servico = criarServicoDeIdentidade({
    identificarParticipante: ({ participanteId }) => { const e = ENTRADAS.find((x) => x.ids.includes(participanteId)); return e ? { entrada: e, organizacaoId: ORG, privado: true } : null; },
    plataforma: { acessoDoPerfil: async ({ perfilId }) => ([ANA, ADM].includes(perfilId) ? { contaId: perfilId, papel: "gerente", permissoes: [], modulos: [], unidades: [UNI], ativo: true } : null) },
  });
  const app = express(); app.use(express.json());
  app.get("/", (_q, res) => res.type("html").send(PAGINA));
  app.get("/favicon.ico", (_q, res) => res.status(204).end());
  app.get("/api/config", (_q, res) => res.json({ supabaseUrl: "http://127.0.0.1:9", supabaseAnonKey: "x" }));
  app.use("/api/v1", (rq, _res, next) => {
    rq.user = { id: sessao.perfil }; rq.tenant = { organizacaoId: ORG, unidadeId: UNI };
    rq.acesso = { perfilId: sessao.perfil, papel: "gerente", permissoes: sessao.permissoes, empresa: { id: ORG }, impersonando: false }; next();
  });
  app.get("/api/v1/usuarios", (_q, res) => res.json({ data: [{ id: ANA, nome: "Ana Caixa", ativo: true }, { id: ADM, nome: "Dono", ativo: true }] }));
  const rotas = criarRouterVinculoMova({ servico: async () => servico, entradasDaOrganizacao: async () => ENTRADAS });
  app.use("/api/v1/mova/vinculo", (rq, res, next) => (ligado ? rotas(rq, res, next) : next()));
  app.use("/api", (_q, res) => res.status(404).json({ error: "não encontrado" }));
  app.use((rq, res) => {
    const arq = resolve(RAIZ, "." + decodeURIComponent(rq.path));
    if (!arq.startsWith(RAIZ + sep)) return res.status(403).end();
    try { res.type(arq.endsWith(".css") ? "text/css" : arq.endsWith(".svg") ? "image/svg+xml" : "text/javascript").send(readFileSync(arq)); } catch { res.status(404).end(); }
  });
  servidor = app.listen(0, "127.0.0.1"); await new Promise((r) => servidor.once("listening", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(async () => { if (servidor) await new Promise((r) => servidor.close(r)); });

async function abrir(browser, permissoes) {
  const pagina = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const erros = []; pagina.on("pageerror", (e) => erros.push(e.message));
  await pagina.goto(base + "/");
  await pagina.evaluate(async ({ org, uni, permissoes: p }) => {
    sessionStorage.clear();
    const { state } = await import("/src/state.js");
    Object.assign(state.sessao, { empresa: { id: org, nome: "Empresa Teste" }, unidade: { id: uni, nome: "Loja" }, permissoes: ["configuracoes.ver", ...p], papel: "gerente", modulos: [] });
    state.rota = "configuracoes";
    (await import("/src/configuracoes.js")).renderConfiguracoes();
  }, { org: ORG, uni: UNI, permissoes });
  await pagina.locator("[data-cfg2]").waitFor();
  await pagina.locator('[data-cat="usuarios-acesso"]').click();
  return { pagina, erros };
}

describe("Configurações → WhatsApp (MOVA)", { skip: PULAR }, () => {
  test("WB-01 o próprio usuário gera o código, vincula pelo WhatsApp e se desvincula; sem administração não vê a lista", async () => {
    const browser = await lancar();
    try {
      ligado = true; Object.assign(sessao, { perfil: ANA, permissoes: [] });
      const { pagina, erros } = await abrir(browser, []);
      await pagina.getByText("Não vinculado").waitFor();
      await pagina.getByRole("button", { name: "Gerar código de vínculo" }).click();
      const instrucao = await pagina.locator(".cfg-codigo code").innerText();
      assert.match(instrucao, /^vincular \d{6}$/);
      assert.equal(await pagina.getByText("Vínculos do WhatsApp nesta empresa").count(), 0);
      assert.equal((await servico.confirmarCodigo({ grupoId: JID_ANA, participanteId: JID_ANA, texto: instrucao })).ok, true);
      const { pagina: p2, erros: e2 } = await abrir(browser, []);
      await p2.getByText("Vinculado", { exact: true }).waitFor();
      await p2.getByRole("button", { name: "Desvincular meu WhatsApp" }).click();
      await p2.getByRole("button", { name: "Revogar", exact: true }).last().click();
      await p2.getByText("Não vinculado").waitFor();
      assert.equal((await servico.resolver({ grupoId: JID_ANA, participanteId: JID_ANA })).vinculado, false);
      assert.deepEqual([...erros, ...e2], []);
    } finally { await browser.close(); }
  });

  test("WB-02 administrador: vê a lista do MOVA, vincula uma pessoa a um perfil e revoga", async () => {
    const browser = await lancar();
    try {
      ligado = true; Object.assign(sessao, { perfil: ADM, permissoes: ["usuarios.gerenciar"] });
      const { pagina, erros } = await abrir(browser, ["usuarios.gerenciar"]);
      await pagina.getByText("Vínculos do WhatsApp nesta empresa").waitFor();
      await pagina.locator('select[data-entrada="pessoa-bia"]').selectOption(ADM);
      await pagina.locator('button[data-acao="aprovar"][data-entrada="pessoa-bia"]').click();
      await pagina.getByText("Vinculado a Dono").waitFor();
      await pagina.locator('button[data-acao="revogar"]').click();
      await pagina.getByRole("button", { name: "Revogar", exact: true }).last().click();
      await pagina.locator('select[data-entrada="pessoa-bia"]').waitFor();
      assert.deepEqual(erros, []);
    } finally { await browser.close(); }
  });

  test("WB-03 rota desligada no servidor ⇒ a seção some; o resto de Usuários e acesso continua", async () => {
    const browser = await lancar();
    try {
      ligado = false;
      const { pagina } = await abrir(browser, []);
      await pagina.waitForTimeout(400);
      assert.equal(await pagina.getByText("Meu WhatsApp no MOVA").count(), 0);
    } finally { await browser.close(); ligado = true; }
  });
});
