import { limitesCmv } from "./cmvConfig.js";

const brlFmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export const el = (sel, root = document) => root.querySelector(sel);
export const els = (sel, root = document) => [...root.querySelectorAll(sel)];

export const temValor = (v) => v !== null && v !== undefined && v !== "" && !Number.isNaN(v);

export const fmtMoeda = (v) => (temValor(v) && !Number.isNaN(Number(v)) ? brlFmt.format(Number(v)) : "—");

/**
 * Decompõe um valor em BRL nas partes visuais (sinal/cifrão/inteiro/
 * centavos) usando `Intl.NumberFormat.formatToParts` — nunca reconstrói o
 * número por conta própria (mesma fonte de verdade de fmtMoeda). `digitos`
 * é só a contagem de dígitos da parte inteira (sem separador de milhar),
 * usada pra decidir a camada de tamanho em fmtMoedaHtml().
 * @param {number|string|null|undefined} v
 */
export function fmtMoedaPartes(v) {
  if (!temValor(v) || Number.isNaN(Number(v))) return null;
  let sinal = "", moeda = "", inteiro = "", centavos = "";
  for (const p of brlFmt.formatToParts(Number(v))) {
    if (p.type === "minusSign") sinal = p.value;
    else if (p.type === "currency") moeda = p.value;
    else if (p.type === "integer" || p.type === "group") inteiro += p.value;
    else if (p.type === "decimal" || p.type === "fraction") centavos += p.value;
  }
  return { sinal, moeda, inteiro, centavos, digitos: inteiro.replace(/\D/g, "").length };
}

/** "15,3 mil" / "1,52 mi" / "12,5 mi" — 2 casas quando o número cabe abaixo de 10, 1 caso contrário (mesmo padrão nos 3 patamares). */
function fmtMoedaCompacta(v) {
  const abs = Math.abs(Number(v));
  const sinal = Number(v) < 0 ? "-" : "";
  let n, sufixo;
  if (abs >= 1_000_000_000) { n = abs / 1_000_000_000; sufixo = "bi"; }
  else if (abs >= 1_000_000) { n = abs / 1_000_000; sufixo = "mi"; }
  else { n = abs / 1_000; sufixo = "mil"; }
  const casas = n < 10 ? 2 : 1;
  return `${sinal}${n.toFixed(casas).replace(".", ",")} ${sufixo}`;
}

/**
 * HTML de um valor monetário em camadas (cifrão menor · inteiro em destaque
 * · centavos discretos) pra cards financeiros — nunca quebra no meio do
 * número (o valor inteiro fica num único `<span>` com `white-space:nowrap`,
 * ver `.valor-money` em styles.css) e reduz de tamanho suavemente conforme a
 * quantidade de dígitos da parte inteira via `.valor-money--t1..t4`.
 * Só vira formato compacto ("R$ 12,5 mi") a partir de 10 dígitos inteiros
 * (>= R$ 1 bilhão) — nunca abrevia um valor que ainda cabe com fonte
 * reduzida. O valor por extenso sempre fica disponível no `title` (tooltip).
 * Reutilizável em qualquer card financeiro que hoje só chama `fmtMoeda()`.
 * @param {number|string|null|undefined} v
 */
export function fmtMoedaHtml(v) {
  const partes = fmtMoedaPartes(v);
  if (!partes) return `<span class="valor-money valor-money--t1"><span class="valor-money-inteiro">—</span></span>`;
  const completo = escapeHtml(fmtMoeda(v));
  if (partes.digitos >= 10) {
    return `<span class="valor-money valor-money--compacto" title="${completo}"><span class="valor-money-cifrao">${partes.moeda}</span> <span class="valor-money-inteiro">${escapeHtml(fmtMoedaCompacta(v))}</span></span>`;
  }
  const tier = partes.digitos <= 3 ? "t1" : partes.digitos <= 5 ? "t2" : partes.digitos <= 7 ? "t3" : "t4";
  return `<span class="valor-money valor-money--${tier}" title="${completo}"><span class="valor-money-cifrao">${partes.moeda}</span> <span class="valor-money-inteiro">${partes.sinal}${partes.inteiro}</span><span class="valor-money-centavos">${partes.centavos}</span></span>`;
}
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
