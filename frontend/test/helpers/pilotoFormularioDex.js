// Piloto do formulário de lançamento do Dashboard iFood
// (dashboardExecutivoForm.js) sobre o DOM mínimo: abre o modal de verdade,
// responde o GET por data com o que o teste mandar, captura o corpo de cada
// POST/PUT e oferece atalhos para clicar/digitar/marcar. Nenhuma rede.
import { instalarDomMinimo, Elemento } from "./domMinimo.js";

export const doc = instalarDomMinimo();
const toastEl = new Elemento("div", { id: "toast", hidden: "" });
doc.body.appendChild(toastEl);
globalThis.setTimeout = ((orig) => (fn, ms, ...a) => orig(fn, Math.min(ms ?? 0, 0), ...a))(globalThis.setTimeout);

export const chamadas = [];
let respostaGet = null;
let respostaEscrita = () => ({ status: 200, body: { data: { lancamento: { id: "novo" }, avisos: [] } } });

globalThis.fetch = async (url, opcoes = {}) => {
  const u = String(url);
  const metodo = (opcoes.method ?? "GET").toUpperCase();
  if (u.includes("/api/config")) return resposta(200, { supabaseUrl: "https://x.example", supabaseAnonKey: "anon" });
  if (metodo === "GET" && u.includes("/dashboard-executivo/lancamentos/")) {
    chamadas.push({ metodo, url: u });
    return resposta(200, { data: structuredClone(respostaGet) });
  }
  if (metodo === "POST" || metodo === "PUT") {
    const body = opcoes.body ? JSON.parse(opcoes.body) : null;
    chamadas.push({ metodo, url: u, body });
    const r = respostaEscrita({ metodo, url: u, body });
    return resposta(r.status, r.body);
  }
  return resposta(200, { data: {} });
};
function resposta(status, corpo) {
  return { ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => corpo };
}

const form = await import("../../src/dashboardExecutivoForm.js");

export const toast = () => toastEl.textContent;
export function definirGet(r) { respostaGet = r; }
export function definirEscrita(fn) { respostaEscrita = fn; }
export const modal = () => doc.querySelector(".modal");
export const html = () => modal()?.innerHTML ?? "";
export const corpo = () => doc.querySelector(".dex-form-corpo")?.innerHTML ?? "";
export const sel = (s) => modal()?.querySelector(s) ?? null;
export const todos = (s) => modal()?.querySelectorAll(s) ?? [];
export const clicar = (s) => { const e = sel(s); if (!e) throw new Error(`não achei ${s}`); e.click(); return e; };
export const digitar = (s, v) => { const e = sel(s); if (!e) throw new Error(`não achei ${s}`); e.digitar(v); return e; };
export const marcar = (s) => { const e = sel(s); if (!e) throw new Error(`não achei ${s}`); e.marcar(); return e; };
export const etapa = () => (/Etapa (\d+)\/(\d+) · ([^<]+)/.exec(html()) ?? []).slice(1).join(" ");
export const esperar = () => new Promise((r) => setTimeout(r, 0)).then(() => new Promise((r) => setTimeout(r, 0)));
export const ultimaEscrita = () => [...chamadas].reverse().find((c) => c.metodo !== "GET") ?? null;

export async function abrir({ data = "2026-09-02", get, unidadeId = "u1", modeloLogistico = "marketplace" } = {}) {
  chamadas.length = 0;
  definirGet(get);
  await form.abrirLancamentoModal({ data, unidadeId, modeloLogistico, ehTeste: false, onSalvo: () => {} });
  await esperar();
}

export async function salvarRascunho() { clicar("#dex-f-rascunho"); await esperar(); return ultimaEscrita(); }
export async function finalizar() { clicar("#dex-f-finalizar"); await esperar(); return ultimaEscrita(); }
export const avancar = () => clicar("#dex-f-avancar");
export const voltar = () => clicar("#dex-f-voltar");
