// Calendário de intervalo. Rascunho local até o segundo clique; o período
// aplicado continua pertencendo exclusivamente ao Parser.
import { icon } from "./icons.js";
const iso = (d) => d.toISOString().slice(0, 10);
const data = (s) => new Date(`${s}T12:00:00Z`);
const fmt = (s) => s.split("-").reverse().join("/");

export function selecionarDia(selecao, dia) {
  if (!selecao.ini || selecao.fim) return { ini: dia, fim: null };
  return dia < selecao.ini ? { ini: dia, fim: selecao.ini } : { ini: selecao.ini, fim: dia };
}

export function estadoDia(dia, { ini, fim }) {
  if (dia === ini && dia === fim) return "unico";
  if (dia === ini) return "inicio";
  if (dia === fim) return "fim";
  return ini && fim && dia > ini && dia < fim ? "intervalo" : "";
}

export function mesHtml(mes, selecao) {
  const primeiro = data(`${mes}-01`);
  const n = new Date(Date.UTC(primeiro.getUTCFullYear(), primeiro.getUTCMonth() + 1, 0)).getUTCDate();
  const titulo = primeiro.toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });
  return `<section class="pfd-cal-mes"><h4>${titulo}</h4><div class="pfd-cal-grid">
    ${["dom", "seg", "ter", "qua", "qui", "sex", "sáb"].map((d) => `<span class="pfd-cal-semana">${d}</span>`).join("")}
    ${"<span></span>".repeat(primeiro.getUTCDay())}
    ${Array.from({ length: n }, (_, i) => {
      const dia = `${mes}-${String(i + 1).padStart(2, "0")}`;
      const estado = estadoDia(dia, selecao);
      return `<button type="button" class="pfd-cal-dia ${estado}" data-dia="${dia}" aria-label="${fmt(dia)}${estado ? `, ${estado}` : ""}" aria-pressed="${!!estado}">${i + 1}</button>`;
    }).join("")}</div></section>`;
}

export function montarCalendario(alvo, { ini, fim, onSelecionar }) {
  let selecao = { ini, fim };
  let mes = (ini || new Date().toLocaleDateString("sv-SE", { timeZone: "America/Fortaleza" })).slice(0, 7);
  const deslocar = (delta) => {
    const d = data(`${mes}-01`); d.setUTCMonth(d.getUTCMonth() + delta);
    mes = iso(d).slice(0, 7); render();
  };
  function render() {
    const proximo = data(`${mes}-01`); proximo.setUTCMonth(proximo.getUTCMonth() + 1);
    alvo.innerHTML = `<div class="pfd-cal-toolbar">
      <button type="button" class="btn btn-ghost btn-sm" data-mover="-1" aria-label="Mês anterior">${icon("chevron-left", { size: 15 })}</button>
      <label>Ir para mês <input type="month" data-mes value="${mes}" aria-label="Mês do calendário"></label>
      <button type="button" class="btn btn-ghost btn-sm" data-mover="1" aria-label="Próximo mês">${icon("chevron-right", { size: 15 })}</button>
    </div><div class="pfd-cal-meses">${mesHtml(mes, selecao)}${mesHtml(iso(proximo).slice(0, 7), selecao)}</div>
    <p class="pfd-cal-instrucao" aria-live="polite">${selecao.ini && !selecao.fim ? `Início: ${fmt(selecao.ini)}. Selecione o fim; clique no mesmo dia para consultar um dia.` : "Selecione o início e depois o fim do período."}</p>`;
    alvo.querySelectorAll("[data-mover]").forEach((b) => b.addEventListener("click", () => deslocar(Number(b.dataset.mover))));
    alvo.querySelector("[data-mes]").addEventListener("change", (e) => {
      if (/^\d{4}-\d{2}$/.test(e.target.value)) { mes = e.target.value; render(); }
    });
    alvo.querySelectorAll("[data-dia]").forEach((b) => {
      b.addEventListener("click", () => {
        selecao = selecionarDia(selecao, b.dataset.dia);
        render();
        if (selecao.fim) onSelecionar(selecao);
        else alvo.querySelector(`[data-dia="${selecao.ini}"]`)?.focus();
      });
      b.addEventListener("keydown", (e) => {
        const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
        if (!delta) return;
        e.preventDefault();
        const d = data(b.dataset.dia); d.setUTCDate(d.getUTCDate() + delta);
        const dia = iso(d);
        if (!alvo.querySelector(`[data-dia="${dia}"]`)) { mes = dia.slice(0, 7); render(); }
        alvo.querySelector(`[data-dia="${dia}"]`)?.focus();
      });
    });
  }
  render();
}
