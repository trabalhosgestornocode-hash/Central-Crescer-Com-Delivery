// Peças de interface compartilhadas pelas páginas financeiras. O CSS é carregado sob demanda (o shell do Agente 1 não é tocado).
import { escapeHtml as esc, toast } from "../utils.js";
import { estado } from "./graficos.js";
import { mesDe } from "./modelo.js";

export { esc, estado };

let cssPronto = false;
export function garantirCss() {
  if (cssPronto || typeof document === "undefined") return;
  cssPronto = true;
  if (document.querySelector("link[data-fin-css]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = new URL("./financeiro-paginas.css", import.meta.url).href;
  l.dataset.finCss = "1";
  document.head.appendChild(l);
}

/** Mês escolhido persiste só na sessão do navegador (conveniência; nunca autoriza nada). */
export function lerMes() {
  try { return sessionStorage.getItem("fin:mes") || mesDe(); } catch { return mesDe(); }
}
export function gravarMes(ym) { try { sessionStorage.setItem("fin:mes", ym); } catch { /* sem storage: ok */ } }

export const aviso = (texto, tipo = "ok") => toast(tipo === "bad" ? `⚠ ${texto}` : texto);

export const badge = (texto, tipo = "muted") => `<span class="fin-badge fin-badge--${tipo}">${esc(texto)}</span>`;

export function cabecalho({ titulo, sub = "", extra = "" }) {
  return `<header class="fin-cab"><div><h2>${esc(titulo)}</h2>${sub ? `<p class="fin-sub">${esc(sub)}</p>` : ""}</div><div class="fin-cab-acoes">${extra}</div></header>`;
}

export const seletorMes = (valor, id = "fin-mes") =>
  `<label class="fin-campo fin-campo--inline" for="${id}"><span>Mês</span><input type="month" id="${id}" value="${esc(valor)}" required></label>`;

export function kpi({ rotulo, valor, sub = "", status = "ok", formula = "", origem = "", destaque = false }) {
  const tag = status === "parcial" ? badge("Parcial", "warn") : status === "indisponivel" ? badge("Indisponível", "muted") : "";
  const info = formula ? `<details class="fin-info"><summary aria-label="Como é calculado: ${esc(rotulo)}">Fórmula</summary><p><strong>Fórmula:</strong> ${esc(formula)}</p>${origem ? `<p><strong>Origem:</strong> ${esc(origem)}</p>` : ""}</details>` : "";
  return `<article class="fin-kpi${destaque ? " fin-kpi--destaque" : ""}"><span class="fin-kpi-rot">${esc(rotulo)} ${tag}</span><strong class="fin-kpi-val">${valor}</strong>${sub ? `<span class="fin-kpi-sub">${sub}</span>` : ""}${info}</article>`;
}

/** colunas: [{ rotulo, num?, render(l) → html }] */
export function tabela({ colunas, linhas, vazio = "Nada para mostrar." }) {
  if (!linhas.length) return `<p class="fin-vazio-linha">${esc(vazio)}</p>`;
  const th = colunas.map((c) => `<th scope="col"${c.num ? ' class="fin-num"' : ""}>${esc(c.rotulo)}</th>`).join("");
  const tr = linhas.map((l) => `<tr>${colunas.map((c) => `<td${c.num ? ' class="fin-num"' : ""}${c.rotulo ? ` data-rot="${esc(c.rotulo)}"` : ""}>${c.render(l)}</td>`).join("")}</tr>`).join("");
  return `<div class="fin-tabela-wrap"><table class="fin-tabela"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

/** Carrega com estados de carregamento/erro (com nova tentativa). `corrida` evita pintar resposta de uma navegação antiga. */
export async function carregarEm(alvo, buscar, pintar) {
  const token = Symbol("carga");
  alvo._cargaAtual = token;
  alvo.innerHTML = estado.carregando();
  try {
    const dados = await buscar();
    if (alvo._cargaAtual !== token || !alvo.isConnected) return;
    alvo.innerHTML = "";
    await pintar(dados);
  } catch (e) {
    if (alvo._cargaAtual !== token || !alvo.isConnected) return;
    alvo.innerHTML = estado.erro(e?.message || "Falha de comunicação.");
    alvo.querySelector("[data-fin-retry]")?.addEventListener("click", () => carregarEm(alvo, buscar, pintar));
  }
}

/** Tooltip único por documento (hover e foco), reutilizado por todos os gráficos. */
let tip;
export function ativarTooltips(raiz) {
  if (typeof document === "undefined") return;
  tip ??= Object.assign(document.createElement("div"), { className: "fin-tooltip", role: "tooltip", hidden: true });
  if (!tip.isConnected) document.body.appendChild(tip);
  const mostrar = (e) => {
    const alvo = e.target.closest?.("[data-tip]");
    if (!alvo) return;
    tip.textContent = alvo.dataset.tip;
    tip.hidden = false;
    const r = alvo.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
    tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8 + window.scrollY)}px`;
  };
  const esconder = () => { tip.hidden = true; };
  raiz.addEventListener("mouseover", mostrar);
  raiz.addEventListener("focusin", mostrar);
  raiz.addEventListener("mouseout", esconder);
  raiz.addEventListener("focusout", esconder);
}

/**
 * Diálogo modal acessível (<dialog>). `corpo`: HTML do formulário. `aoEnviar(formData, dlg)` → Promise; erro mostra mensagem
 * no próprio diálogo, sem fechar. Fecha com Esc ou Cancelar.
 */
export function dialogo({ titulo, corpo, enviar = "Salvar", aoEnviar, perigo = false }) {
  const dlg = document.createElement("dialog");
  dlg.className = "fin-dialogo";
  dlg.innerHTML = `<form method="dialog" class="fin-form" novalidate>
    <h3>${esc(titulo)}</h3>
    <div class="fin-form-corpo">${corpo}</div>
    <p class="fin-form-erro" role="alert" hidden></p>
    <div class="fin-form-acoes"><button type="button" class="btn btn-ghost btn-sm" data-cancelar>Cancelar</button>
      <button type="submit" class="btn ${perigo ? "btn-ghost" : "btn-primary"} btn-sm">${esc(enviar)}</button></div></form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector("form");
  const erro = dlg.querySelector(".fin-form-erro");
  const fechar = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector("[data-cancelar]").addEventListener("click", fechar);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); fechar(); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true; erro.hidden = true;
    try { await aoEnviar(new FormData(form), dlg); fechar(); }
    catch (err) { erro.textContent = err?.message || "Não foi possível concluir."; erro.hidden = false; btn.disabled = false; }
  });
  dlg.showModal();
  dlg.querySelector("input, select, textarea")?.focus();
  return dlg;
}

export const campo = (rotulo, nome, { tipo = "text", valor = "", obrig = false, extra = "", dica = "" } = {}) =>
  `<label class="fin-campo"><span>${esc(rotulo)}${obrig ? " *" : ""}</span><input type="${tipo}" name="${nome}" value="${esc(valor)}" ${obrig ? "required" : ""} ${extra}>${dica ? `<small>${esc(dica)}</small>` : ""}</label>`;

export const selecao = (rotulo, nome, opcoes, { valor = "", obrig = false, vazio = "" } = {}) =>
  `<label class="fin-campo"><span>${esc(rotulo)}${obrig ? " *" : ""}</span><select name="${nome}" ${obrig ? "required" : ""}>${vazio !== null && vazio !== undefined && (vazio !== "" || !obrig) ? `<option value="">${esc(vazio || "—")}</option>` : ""}${opcoes.map((o) => `<option value="${esc(o.valor)}"${o.valor === valor ? " selected" : ""}>${esc(o.rotulo)}</option>`).join("")}</select></label>`;
