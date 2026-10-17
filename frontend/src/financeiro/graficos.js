// Gráficos do financeiro: SVG gerado como STRING (sem biblioteca, sem DOM) — testável em Node e leve no navegador.
// Regras (skill dataviz): um eixo só; marcas finas com topo arredondado ancorado na base; grade recessiva; legenda sempre que há
// 2+ séries; identidade nunca só por cor (legenda + rótulo + tabela); cores validadas claro/escuro (definidas no CSS).
import { moeda, pct, diaMes } from "./modelo.js";
import { escapeHtml } from "../utils.js";

/** Teto "bonito" do eixo (1/2/5 × 10^k) em centavos. */
export function tetoEixo(maxCentavos) {
  if (!(maxCentavos > 0)) return 100;
  const exp = 10 ** Math.floor(Math.log10(maxCentavos));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= maxCentavos) return m * exp;
  return 10 * exp;
}

const moedaCurta = (c) => {
  const v = Math.abs(c) / 100;
  const s = v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1).replace(".", ",")} mi` : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(".", ",")} mil` : String(Math.round(v));
  return `${c < 0 ? "−" : ""}${s}`;
};

/** Barra com topo arredondado (4px) e base reta, ancorada na linha de base. */
function barra(x, yBase, w, h, cor, tip) {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  const d = `M${x},${yBase} V${yBase - h + r} Q${x},${yBase - h} ${x + r},${yBase - h} H${x + w - r} Q${x + w},${yBase - h} ${x + w},${yBase - h + r} V${yBase} Z`;
  return `<path class="fin-bar" d="${d}" fill="${cor}" data-tip="${escapeHtml(tip)}" tabindex="0"/>`;
}

/**
 * Entradas × saídas por período (barras agrupadas, UMA escala). serie: [{periodo, entradas, saidas}] em centavos.
 * Inclui legenda e uma visão em tabela (acessibilidade).
 */
export function graficoEntradasSaidas(serie, { titulo = "Entradas e saídas por dia" } = {}) {
  if (!serie?.length) return "";
  const W = 720, H = 280, mE = 56, mD = 12, mT = 12, mB = 34;
  const area = { w: W - mE - mD, h: H - mT - mB };
  const teto = tetoEixo(Math.max(...serie.flatMap((s) => [s.entradas, s.saidas])));
  const y = (c) => (c / teto) * area.h;
  const yBase = mT + area.h;
  const passo = area.w / serie.length;
  const larg = Math.max(3, Math.min(16, (passo - 6) / 2 - 1));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * teto);
  let svg = `<svg class="fin-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(titulo)}" preserveAspectRatio="xMidYMid meet">`;
  for (const t of ticks) {
    const yy = yBase - y(t);
    svg += `<line class="fin-grade" x1="${mE}" x2="${W - mD}" y1="${yy}" y2="${yy}"/><text class="fin-eixo" x="${mE - 8}" y="${yy + 4}" text-anchor="end">${moedaCurta(t)}</text>`;
  }
  const cadaRotulo = Math.ceil(serie.length / 12);
  serie.forEach((s, i) => {
    const cx = mE + passo * i + passo / 2;
    svg += barra(cx - larg - 1, yBase, larg, y(s.entradas), "var(--fin-entrada)", `${diaMes(s.periodo)} · Entradas ${moeda(s.entradas)}`);
    svg += barra(cx + 1, yBase, larg, y(s.saidas), "var(--fin-saida)", `${diaMes(s.periodo)} · Saídas ${moeda(s.saidas)}`);
    if (i % cadaRotulo === 0) svg += `<text class="fin-eixo" x="${cx}" y="${H - 12}" text-anchor="middle">${escapeHtml(diaMes(s.periodo))}</text>`;
  });
  svg += `<line class="fin-base" x1="${mE}" x2="${W - mD}" y1="${yBase}" y2="${yBase}"/></svg>`;
  const linhas = serie.map((s) => `<tr><th scope="row">${escapeHtml(diaMes(s.periodo))}</th><td>${moeda(s.entradas)}</td><td>${moeda(s.saidas)}</td><td>${moeda(s.saldo ?? s.entradas - s.saidas, { sinal: true })}</td></tr>`).join("");
  return `<figure class="fin-grafico">
    <figcaption>${escapeHtml(titulo)}</figcaption>
    <ul class="fin-legenda" aria-label="Legenda"><li><i class="fin-chip fin-chip--entrada"></i>Entradas</li><li><i class="fin-chip fin-chip--saida"></i>Saídas</li></ul>
    ${svg}
    <details class="fin-tabela-alt"><summary>Ver como tabela</summary><div class="fin-tabela-wrap"><table class="fin-tabela"><thead><tr><th>Período</th><th>Entradas</th><th>Saídas</th><th>Saldo</th></tr></thead><tbody>${linhas}</tbody></table></div></details>
  </figure>`;
}

/**
 * Ranking em barras horizontais (uma série): rótulo à esquerda, valor e participação como rótulo direto.
 * itens: [{rotulo, centavos, participacaoBps?}]
 */
export function graficoBarrasHorizontais(itens, { titulo = "Ranking", limite = 10 } = {}) {
  const lista = (itens ?? []).filter((i) => i.centavos > 0).slice(0, limite);
  if (!lista.length) return "";
  const max = Math.max(...lista.map((i) => i.centavos));
  const linhas = lista.map((i) => {
    const w = Math.max(1, Math.round((i.centavos / max) * 100));
    const tip = `${i.rotulo} · ${moeda(i.centavos)}${i.participacaoBps != null ? ` · ${pct(i.participacaoBps)}` : ""}`;
    return `<li class="fin-hbar" data-tip="${escapeHtml(tip)}" tabindex="0">
      <span class="fin-hbar-rot" title="${escapeHtml(i.rotulo)}">${escapeHtml(i.rotulo)}</span>
      <span class="fin-hbar-trilho"><span class="fin-hbar-barra" style="width:${w}%"></span></span>
      <span class="fin-hbar-val">${moeda(i.centavos)}${i.participacaoBps != null ? `<small>${pct(i.participacaoBps)}</small>` : ""}</span>
    </li>`;
  }).join("");
  return `<figure class="fin-grafico"><figcaption>${escapeHtml(titulo)}</figcaption><ol class="fin-hbars" aria-label="${escapeHtml(titulo)}">${linhas}</ol></figure>`;
}

/** Estados vazios/erro/carregando padronizados (HTML). */
export const estado = {
  carregando: (t = "Carregando…") => `<div class="fin-estado" role="status" aria-live="polite"><span class="fin-spin" aria-hidden="true"></span>${escapeHtml(t)}</div>`,
  vazio: (titulo, texto = "") => `<div class="fin-estado fin-estado--vazio"><h3>${escapeHtml(titulo)}</h3>${texto ? `<p>${escapeHtml(texto)}</p>` : ""}</div>`,
  erro: (texto) => `<div class="fin-estado fin-estado--erro" role="alert"><h3>Não foi possível carregar</h3><p>${escapeHtml(texto)}</p><button type="button" class="btn btn-ghost btn-sm" data-fin-retry>Tentar novamente</button></div>`,
};
