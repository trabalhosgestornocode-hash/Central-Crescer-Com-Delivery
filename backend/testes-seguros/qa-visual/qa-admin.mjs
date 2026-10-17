// QA visual da tela "Acesso Financeiro" (SuperAdmin) — backend FALSO, dados fictícios, loopback.
import { createRequire } from "node:module";
// ESM ignora NODE_PATH: o playwright-core fica FORA do repositório; QA_MODULOS aponta para a pasta que contém node_modules.
const { chromium } = createRequire(`${process.env.QA_MODULOS || process.cwd()}/`)("playwright-core");
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(aqui, "shots");   // ignorado pelo git mkdirSync(SHOTS, { recursive: true });
const BASE = "http://127.0.0.1:4173";
const res = [];
const checar = (nome, ok, d = "") => res.push({ nome, ok: !!ok, d });
const api = (p) => fetch(BASE + p).then((r) => r.json());

const nav = await chromium.launch({ executablePath: process.env.QA_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const ctx = await nav.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
const ver = (s) => page.locator(s).first().isVisible().catch(() => false);
const foto = (n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) });

await api("/qa/cenario?nome=superadmin"); await api("/qa/escrita?on=0");
await page.goto(BASE + "/", { waitUntil: "load" }); await page.waitForTimeout(1500);
checar("superadmin: abre o painel SuperAdmin", await ver("#admin"));
await page.locator('#adm-menu li[data-tela="acesso-financeiro"]').first().click();
await page.waitForTimeout(800);
checar("aba 'Acesso Financeiro' existe e abre", /Acesso ao Dashboard Financeiro/.test(await page.locator("#adm-view").innerText()));
checar("aviso de BLOQUEIO visível (flag/MFA)", /Bloqueado\./.test(await page.locator("#adm-view").innerText()));
await foto("20-admin-acesso-financeiro-inicial");

await page.selectOption("#fa-org", "org-qa"); await page.waitForTimeout(700);
await page.selectOption("#fa-uni", "uni-a"); await page.waitForTimeout(900);
let texto = await page.locator("#adm-view").innerText();
checar("lista: concessão ativa e expirada aparecem; revogada oculta por padrão", /Marina Souza/.test(texto) && /Paulo Lima/.test(texto) && !/Rita Alves/.test(texto));
checar("lista: pills Ativa/Expirada", /Ativa/.test(texto) && /Expirada/.test(texto));
checar("lista: 'só financeiro' sinalizado", /só financeiro/.test(texto));
checar("auditoria: histórico exibido", /Histórico de auditoria/.test(texto) && /Concedida/.test(texto));
await page.locator("#fa-rev").check(); await page.waitForTimeout(900);
texto = await page.locator("#adm-view").innerText();
checar("incluir revogadas: mostra Revogada e o motivo da revogação", /Rita Alves/.test(texto) && /Revogada/.test(texto) && /Mudou de função/.test(texto));
checar("revogada não oferece 'Preparar revogação'", (await page.locator('[data-fin-acao="revogar"]').count()) === 2);
await foto("21-admin-acesso-financeiro-lista");

// --- preparar concessão (BLOQUEADO)
await page.locator('[data-fin-acao="nova"]').click(); await page.waitForTimeout(700);
checar("modal (bloqueado): aviso de gravação bloqueada", /Gravação bloqueada/.test(await page.locator("#adm-modal-body").innerText()));
checar("modal (bloqueado): NÃO existe botão de confirmar", (await page.locator("#adm-modal-ok").count()) === 0);
await page.selectOption("#fa-perfil", "perfil-su"); await page.waitForTimeout(200);
checar("autoconcessão: perfil próprio rotulado e recusado na prévia", /sua própria conta/.test(await page.locator("#fa-perfil option:checked").innerText()) && /Autoconcessão/.test(await page.locator("#fa-prev").innerText()));
await page.selectOption("#fa-perfil", "perfil-4"); await page.selectOption("#fa-nivel", "operador"); await page.fill("#fa-motivo", "curto"); await page.waitForTimeout(200);
checar("motivo curto: exige 10+ caracteres", /motivo/i.test(await page.locator("#fa-prev").innerText()));
await page.fill("#fa-motivo", "Contratação de analista financeiro"); await page.waitForTimeout(200);
checar("dados válidos: prévia diz que NADA será gravado (bloqueado)", /Nada será gravado/.test(await page.locator("#fa-prev").innerText()));
await foto("22-admin-modal-concessao-bloqueado");
await page.keyboard.press("Escape"); await page.waitForTimeout(300);
const ch0 = await api("/qa/chamadas");
checar("bloqueado: nenhuma chamada de escrita foi feita ao servidor", ch0.length === 0, JSON.stringify(ch0));

// --- preparar revogação (BLOQUEADO)
await page.locator('[data-fin-acao="revogar"]').first().click(); await page.waitForTimeout(500);
checar("revogação (bloqueado): aviso + referência ao procedimento de emergência, sem botão Revogar", /Revogação bloqueada/.test(await page.locator("#adm-modal-body").innerText()) && /revogacao-emergencial/.test(await page.locator("#adm-modal-body").innerText()) && (await page.locator("#adm-modal-ok").count()) === 0);
await foto("23-admin-modal-revogacao-bloqueado");
await page.keyboard.press("Escape"); await page.waitForTimeout(300);

// --- LIBERADO no mock (só para conferir o corpo enviado)
await api("/qa/escrita?on=1");
await page.selectOption("#fa-uni", ""); await page.selectOption("#fa-uni", "uni-a"); await page.waitForTimeout(900);
checar("liberado: aviso muda e menciona MFA recente", /Escritas liberadas/.test(await page.locator("#adm-view").innerText()));
await page.locator('[data-fin-acao="nova"]').click(); await page.waitForTimeout(700);
checar("liberado: botão Conceder existe", (await page.locator("#adm-modal-ok").count()) === 1);
await page.selectOption("#fa-perfil", "perfil-4"); await page.selectOption("#fa-nivel", "gestor");
await page.fill("#fa-exp", "2099-12-31"); await page.locator("#fa-sofin").check(); await page.fill("#fa-motivo", "  Gestor financeiro da unidade  ");
await page.locator("#adm-modal-ok").click(); await page.waitForTimeout(900);
const ch = await api("/qa/chamadas");
const c = ch.find((x) => x.rota === "conceder")?.corpo ?? {};
checar("corpo enviado: org/unidade/perfil/nível/motivo normalizados", c.organizacaoId === "org-qa" && c.unidadeId === "uni-a" && c.perfilId === "perfil-4" && c.nivel === "gestor" && c.motivo === "Gestor financeiro da unidade", JSON.stringify(c));
checar("corpo enviado: somenteFinanceiro e expiração ISO", c.somenteFinanceiro === true && /^(2099-12-31|2100-01-01)T/.test(c.expiraEm ?? ""));
checar("corpo enviado: NÃO leva concedente", !JSON.stringify(c).match(/concedid/i));
await page.locator('[data-fin-acao="revogar"]').first().click(); await page.waitForTimeout(400);
await page.fill("#fa-motivo-rev", "Encerramento do contrato"); await page.locator("#adm-modal-ok").click(); await page.waitForTimeout(800);
const r = (await api("/qa/chamadas")).find((x) => x.rota === "revogar");
checar("revogação enviada com id e motivo", r?.id === "c-1" && r?.corpo?.motivo === "Encerramento do contrato", JSON.stringify(r));
await api("/qa/escrita?on=0");

// --- mobile
const m = await nav.newContext({ viewport: { width: 390, height: 844 } });
const pm = await m.newPage();
await pm.goto(BASE + "/", { waitUntil: "load" }); await pm.waitForTimeout(1500);
const larg = await pm.evaluate(() => document.documentElement.scrollWidth);
checar("mobile: painel SuperAdmin sem rolagem horizontal da página", larg <= 392, `scrollWidth=${larg}`);
await foto("24-admin-mobile-inicial");

await nav.close();
for (const x of res) console.log(`${x.ok ? "OK   " : "FALHA"} ${x.nome}${!x.ok && x.d ? "  -> " + x.d : ""}`);
console.log(`\n${res.filter((x) => x.ok).length}/${res.length} verificações OK`);
