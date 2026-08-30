import { limitesCmv } from "./cmvConfig.js";

const brlFmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export const el = (sel, root = document) => root.querySelector(sel);
export const els = (sel, root = document) => [...root.querySelectorAll(sel)];

export const temValor = (v) => v !== null && v !== undefined && v !== "" && !Number.isNaN(v);

export const fmtMoeda = (v) => (temValor(v) && !Number.isNaN(Number(v)) ? brlFmt.format(Number(v)) : "—");
export const fmtPct = (v) => (temValor(v) && !Number.isNaN(Number(v)) ? Number(v).toFixed(1) + "%" : "—");
export const fmtTexto = (v) => (temValor(v) ? String(v) : "—");
export const fmtHora = (ts) => (ts ? new Date(ts).toLocaleTimeString("pt-BR") : "—");

// Tempo relativo curto em pt-BR (ex.: "há 5 min", "há 2 dias").
export function fmtRelativo(iso) {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "agora mesmo";
  const m = Math.floor(s / 60); if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60); if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24); if (d < 30) return `há ${d} dia${d > 1 ? "s" : ""}`;
  const meses = Math.floor(d / 30); if (meses < 12) return `há ${meses} ${meses > 1 ? "meses" : "mês"}`;
  return `há ${Math.floor(meses / 12)} ano(s)`;
}

// Data + hora curtas em pt-BR (ex.: "08/07/2026 14:32").
export const fmtDataHora = (iso) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Regex construída em runtime (não literal) para não depender de como o
// editor/terminal salva caracteres combinantes no arquivo-fonte.
const REGEX_DIACRITICOS = new RegExp("[" + String.fromCharCode(0x0300) + "-" + String.fromCharCode(0x036f) + "]", "g");

/**
 * Normaliza texto para busca: minúsculas e sem acento ("São Luís" -> "sao luis").
 * Usado por qualquer busca client-side instantânea do app (seleção de
 * ambiente, estrutura organizacional do SuperAdmin etc.) — uma fonte só.
 * @param {unknown} txt
 */
export function normalizarBusca(txt) {
  return (txt ?? "").toString().normalize("NFD").replace(REGEX_DIACRITICOS, "").toLowerCase();
}

// Classifica o status de CMV a partir do percentual.
// Usa os limites da UNIDADE atual (cmvConfig.js) — carregados uma vez ao
// entrar/trocar de unidade. `limites` explícito só para teste/casos especiais.
export function statusCmv(pct, limites = limitesCmv()) {
  if (!temValor(pct)) return { chave: "sem", label: "Sem dados", classe: "muted" };
  const p = Number(pct);
  if (p <= limites.saudavel) return { chave: "saudavel", label: "Saudável", classe: "ok" };
  if (p <= limites.atencao) return { chave: "atencao", label: "Atenção", classe: "warn" };
  return { chave: "critico", label: "Crítico", classe: "bad" };
}

// Toast simples reutilizável
let toastTimer;
export function toast(msg) {
  const t = el("#toast");
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => (t.hidden = true), 250);
  }, 2800);
}
