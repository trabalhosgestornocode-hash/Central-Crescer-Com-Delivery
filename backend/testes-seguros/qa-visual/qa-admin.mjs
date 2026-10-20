// QA visual da tela "Acesso Financeiro" (SuperAdmin, gestão simples por unidade) — backend FALSO, dados fictícios, loopback.
// Rodar: node servidor-qa.mjs <porta>  e depois  QA_PORTA=<porta> QA_MODULOS=<pasta com playwright-core> node qa-admin.mjs
import { createRequire } from "node:module";
// ESM ignora NODE_PATH: o playwright-core fica FORA do repositório; QA_MODULOS aponta para a pasta que contém node_modules.
const { chromium } = createRequire(`${process.env.QA_MODULOS || process.cwd()}/`)("playwright-core");
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(aqui, "shots");   // ignorado pelo git
mkdirSync(SHOTS, { recursive: true });
const BASE = `http://127.0.0.1:${process.env.QA_PORTA || 4173}`;
const res = [];
const checar = (nome, ok, d = "") => res.push({ nome, ok: !!ok, d });
const api = (p) => fetch(BASE + p).then((r) => r.json());

const nav = await chromium.launch({ executablePath: process.env.QA_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const ctx = await nav.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
const ver = (s) => page.locator(s).first().isVisible().catch(() => false);
const foto = (p, n) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), fullPage: true });
const texto = () => page.locator("#adm-view").innerText();
const nivel = (perfil) => page.locator(`.fa-nivel[data-perfil="${perfil}"]`);

async function abrirTela(p) {
  await p.goto(BASE + "/", { waitUntil: "load" }); await p.waitForTimeout(1500);
  // No celular o menu lateral rola na horizontal; o clique vai direto no item.
  await p.locator('#adm-menu li[data-tela="acesso-financeiro"]').first().evaluate((li) => li.click()); await p.waitForTimeout(800);
  await p.selectOption("#fa-org", "org-qa"); await p.waitForTimeout(700);
  await p.selectOption("#fa-uni", "uni-a"); await p.waitForTimeout(900);
}

// --- GRAVAÇÃO DESLIGADA (flag de rollout)
await api("/qa/cenario?nome=superadmin"); await api("/qa/escrita?on=0");
await page.goto(BASE + "/", { waitUntil: "load" }); await page.waitForTimeout(1500);
checar("superadmin: abre o painel SuperAdmin", await ver("#admin"));
await page.locator('#adm-menu li[data-tela="acesso-financeiro"]').first().click(); await page.waitForTimeout(800);
checar("aba 'Acesso Financeiro' abre e pede empresa e unidade", /Acesso ao Dashboard Financeiro/.test(await texto()) && /Escolha a empresa e a unidade/.test(await texto()));
await page.selectOption("#fa-org", "org-qa"); await page.waitForTimeout(700);
await page.selectOption("#fa-uni", "uni-a"); await page.waitForTimeout(900);
let t = await texto();
checar("desligada: aviso 'Gravação desligada.' sem falar de MFA", /Gravação desligada\./.test(t) && !/MFA|duas etapas/i.test(t));
checar("desligada: chave e seletores travados, Salvar desabilitado",
  await page.locator("#fa-ligado").isDisabled() && await nivel("perfil-4").isDisabled() && await page.locator("#fa-salvar").isDisabled());
checar("lista: usuários da unidade, 'você' e 'sem vínculo' sinalizados", /Marina Souza/.test(t) && /Bruno Dias/.test(t) && /você/.test(t) && /sem vínculo/.test(t));
checar("lista: nível atual de cada um no seletor", (await nivel("perfil-1").inputValue()) === "operador" && (await nivel("perfil-4").inputValue()) === "");
await foto(page, "20-admin-acesso-financeiro-desligado");
checar("desligada: nenhuma escrita enviada", (await api("/qa/chamadas")).length === 0);

// --- GRAVAÇÃO LIBERADA (mock)
await api("/qa/escrita?on=1");
await page.selectOption("#fa-uni", ""); await page.waitForTimeout(500);
await page.selectOption("#fa-uni", "uni-a"); await page.waitForTimeout(900);
checar("liberada: sem aviso de bloqueio, chave habilitada", !/Gravação desligada/.test(await texto()) && !(await page.locator("#fa-ligado").isDisabled()));
checar("sem mudanças: 'Nenhuma alteração' e Salvar desabilitado", /Nenhuma alteração/.test(await page.locator("#fa-contagem").innerText()) && await page.locator("#fa-salvar").isDisabled());
checar("sem vínculo: mostra o nível atual e só oferece removê-lo",
  (await nivel("perfil-ex").inputValue()) === "leitura" && (await nivel("perfil-ex").locator("option").count()) === 2);

await page.locator(".fa-chave").click(); await page.waitForTimeout(300);
checar("chave: liga o Financeiro e avisa que a sessão será renovada", /Financeiro ligado/.test(await texto()) && /entrar de novo/.test(await texto()));
await nivel("perfil-su").selectOption("gestor"); await page.waitForTimeout(200);
await nivel("perfil-4").selectOption("leitura"); await page.waitForTimeout(200);
await nivel("perfil-1").selectOption(""); await page.waitForTimeout(200);
await nivel("perfil-falha").selectOption("operador"); await page.waitForTimeout(200);
checar("contagem: 5 alterações não salvas e linhas destacadas",
  /5 alteração/.test(await page.locator("#fa-contagem").innerText()) && (await page.locator(".fa-usuario--mudou").count()) === 4);
checar("Salvar habilitado com alterações", !(await page.locator("#fa-salvar").isDisabled()));
await page.locator("#fa-descartar").click(); await page.waitForTimeout(300);
checar("Descartar volta ao estado do servidor", /Nenhuma alteração/.test(await page.locator("#fa-contagem").innerText()) && (await nivel("perfil-1").inputValue()) === "operador");

await page.locator(".fa-chave").click(); await page.waitForTimeout(200);
await nivel("perfil-su").selectOption("gestor"); await nivel("perfil-4").selectOption("leitura");
await nivel("perfil-1").selectOption(""); await nivel("perfil-falha").selectOption("operador"); await page.waitForTimeout(200);
await foto(page, "21-admin-acesso-financeiro-alteracoes");
await page.locator("#fa-salvar").click(); await page.waitForTimeout(1000);
const put = (await api("/qa/chamadas")).find((x) => x.rota === "acessos");
const corpo = put?.corpo ?? {};
checar("pedido: unidade certa, módulo ligado e só quem mudou", put?.id === "uni-a" && corpo.habilitado === true && corpo.acessos?.length === 4, JSON.stringify(put));
checar("pedido: níveis corretos (Sem acesso vai como null)", JSON.stringify(corpo.acessos) === JSON.stringify([
  { perfilId: "perfil-su", nivel: "gestor" }, { perfilId: "perfil-1", nivel: null },
  { perfilId: "perfil-4", nivel: "leitura" }, { perfilId: "perfil-falha", nivel: "operador" },
]), JSON.stringify(corpo.acessos));
checar("pedido: NÃO leva concedente, empresa nem motivo", Object.keys(corpo).sort().join() === "acessos,habilitado");
t = await texto();
checar("depois de salvar: estado do servidor recarregado", (await nivel("perfil-4").inputValue()) === "leitura" && (await nivel("perfil-su").inputValue()) === "gestor" && /Financeiro ligado/.test(t));
checar("falha de um usuário aparece na linha dele", /não tem vínculo ativo/.test(await page.locator(".fa-usuario", { hasText: "Caio Teste" }).innerText()));
await foto(page, "22-admin-acesso-financeiro-salvo");

// --- desligada de novo: o servidor recusa e a tela não finge sucesso
await nivel("perfil-1").selectOption("leitura"); await api("/qa/escrita?on=0");
await page.locator("#fa-salvar").click(); await page.waitForTimeout(800);
checar("servidor recusou: tela mantém a alteração e não mostra sucesso", (await nivel("perfil-1").inputValue()) === "leitura" && !(await page.locator("#fa-salvar").isDisabled()));

// --- celular
await api("/qa/cenario?nome=superadmin");
const m = await nav.newContext({ viewport: { width: 390, height: 844 } });
const pm = await m.newPage();
await abrirTela(pm);
const larg = await pm.evaluate(() => document.documentElement.scrollWidth);
checar("celular: tela sem rolagem horizontal", larg <= 392, `scrollWidth=${larg}`);
const alturaSel = await pm.locator('.fa-nivel[data-perfil="perfil-4"]').evaluate((e) => e.getBoundingClientRect().height);
checar("celular: seletor com altura de toque (>= 40px)", alturaSel >= 40, `altura=${alturaSel}`);
await foto(pm, "23-admin-acesso-financeiro-celular");

await nav.close();
for (const x of res) console.log(`${x.ok ? "OK   " : "FALHA"} ${x.nome}${!x.ok && x.d ? "  -> " + x.d : ""}`);
console.log(`\n${res.filter((x) => x.ok).length}/${res.length} verificações OK`);
process.exitCode = res.every((x) => x.ok) ? 0 : 1;
