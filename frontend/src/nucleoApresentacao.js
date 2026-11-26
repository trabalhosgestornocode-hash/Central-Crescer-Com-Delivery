// NÚCLEO MENTORADOS — Modo Apresentação de Impacto.
//
// Palco 16:9 em tela cheia sobre o Painel. Os slides vêm do SNAPSHOT guardado da versão (nunca recalcula).
// Teclado: → / PageDown / Espaço avançam · ← / PageUp voltam · Home / End · N notas do mentor · F tela cheia ·
// I fontes e fórmulas · P exportar PDF · Esc fecha. As notas privadas só aparecem no painel do apresentador e
// nunca vão para o PDF.

import { escapeHtml as esc } from "./utils.js";
import { icon } from "./icons.js";
import { slides as montarSlides } from "./nucleoMentoradosViews.js";
import { ligarDicas } from "./nucleoMentoradosDicas.js";

let aberto = null;

/**
 * @param {{apresentacao: object, aoExportar?: (id: string) => Promise<void>, imprimir?: boolean}} p
 */
export function abrirApresentacao({ apresentacao, aoExportar, imprimir = false }) {
  fecharApresentacao();
  const lista = montarSlides(apresentacao.snapshot, apresentacao.configuracao ?? {});
  if (!lista.length) return;
  const anterior = document.activeElement;
  const raiz = document.createElement("div");
  raiz.className = "ap";
  raiz.setAttribute("role", "dialog");
  raiz.setAttribute("aria-modal", "true");
  raiz.setAttribute("aria-label", `Apresentação: ${apresentacao.titulo} (versão ${apresentacao.versao})`);
  raiz.innerHTML = `
    <div class="ap-palco-wrap"><div class="ap-palco">
      ${lista.map((s, i) => `<section class="ap-slide" data-slide="${esc(s.id)}" aria-roledescription="slide" aria-label="${i + 1} de ${lista.length}: ${esc(s.titulo)}"${i ? " hidden" : ""}>${s.html}
        <footer class="ap-rodape"><span>${esc(apresentacao.snapshot.empresa?.nome ?? "")}</span><span>Crescer com Delivery · v${apresentacao.versao}</span><span class="nm-num">${i + 1}/${lista.length}</span></footer></section>`).join("")}
    </div></div>
    <aside class="ap-notas" hidden aria-label="Notas do mentor (privadas)"><h2>Notas do mentor <span>privadas · não vão para o PDF</span></h2><div class="ap-notas__txt"></div></aside>
    <div class="ap-barra" role="toolbar" aria-label="Controles da apresentação">
      <button type="button" data-ap="anterior" aria-label="Slide anterior (←)">${icon("chevron-left", { size: 18 })}</button>
      <span class="ap-contador nm-num" aria-live="polite"></span>
      <button type="button" data-ap="proximo" aria-label="Próximo slide (→)">${icon("chevron-right", { size: 18 })}</button>
      <span class="ap-sep"></span>
      <button type="button" data-ap="notas" aria-pressed="false" title="Notas (N)">Notas</button>
      <button type="button" data-ap="tela" title="Tela cheia (F)">${icon("maximize", { size: 16 })}<span class="nm-sr">Tela cheia</span></button>
      <button type="button" data-ap="pdf" title="Exportar PDF (P)">PDF</button>
      <button type="button" data-ap="fechar" title="Fechar (Esc)">${icon("x", { size: 18 })}<span class="nm-sr">Fechar</span></button>
    </div>`;
  document.body.appendChild(raiz);
  document.body.classList.add("ap-aberta");
  const secoes = [...raiz.querySelectorAll(".ap-slide")];
  let atual = 0;
  const contador = raiz.querySelector(".ap-contador");
  const notasTxt = raiz.querySelector(".ap-notas__txt");
  const ir = (n) => {
    atual = Math.max(0, Math.min(lista.length - 1, n));
    secoes.forEach((s, i) => { s.hidden = i !== atual; });
    contador.textContent = `${atual + 1} / ${lista.length} · ${lista[atual].titulo}`;
    notasTxt.innerHTML = lista[atual].notas ? esc(lista[atual].notas).replace(/\n/g, "<br>") : '<p class="nm-muted">Sem notas para este slide.</p>';
    raiz.querySelector('[data-ap="anterior"]').disabled = atual === 0;
    raiz.querySelector('[data-ap="proximo"]').disabled = atual === lista.length - 1;
  };
  const alternarNotas = () => {
    const n = raiz.querySelector(".ap-notas"); n.hidden = !n.hidden;
    raiz.querySelector('[data-ap="notas"]').setAttribute("aria-pressed", String(!n.hidden));
  };
  const telaCheia = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else raiz.requestFullscreen?.().catch(() => {});
  };
  const pdf = async () => {
    document.body.classList.add("ap-imprimindo");
    secoes.forEach((s) => { s.hidden = false; });
    // No PDF, fontes e fórmulas vão sempre abertas (o leitor não tem como clicar).
    const fontes = [...raiz.querySelectorAll(".ap-fonte")];
    const estavamAbertas = fontes.map((d) => d.open);
    fontes.forEach((d) => { d.open = true; });
    try { await aoExportar?.(apresentacao.id); } catch { /* registro de auditoria não bloqueia a exportação */ }
    window.print();
    fontes.forEach((d, i) => { d.open = estavamAbertas[i]; });
    document.body.classList.remove("ap-imprimindo");
    ir(atual);
  };
  const tecla = (e) => {
    if (e.target.closest?.("input, textarea, select")) return;
    const k = e.key;
    if (["ArrowRight", "PageDown", " "].includes(k)) { e.preventDefault(); ir(atual + 1); }
    else if (["ArrowLeft", "PageUp"].includes(k)) { e.preventDefault(); ir(atual - 1); }
    else if (k === "Home") { e.preventDefault(); ir(0); }
    else if (k === "End") { e.preventDefault(); ir(lista.length - 1); }
    else if (k === "n" || k === "N") alternarNotas();
    else if (k === "f" || k === "F") telaCheia();
    else if (k === "p" || k === "P") { e.preventDefault(); pdf(); }
    else if (k === "i" || k === "I") { const d = secoes[atual].querySelector(".ap-fonte"); if (d) d.open = !d.open; }
    else if (k === "Escape" && !document.fullscreenElement) fecharApresentacao();
  };
  raiz.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ap]"); if (!b) return;
    ({ anterior: () => ir(atual - 1), proximo: () => ir(atual + 1), notas: alternarNotas, tela: telaCheia, pdf, fechar: fecharApresentacao })[b.dataset.ap]?.();
  });
  document.addEventListener("keydown", tecla);
  const desligarDicas = ligarDicas(raiz);
  aberto = { raiz, tecla, anterior, desligarDicas };
  ir(0);
  raiz.querySelector('[data-ap="proximo"]').focus();
  if (imprimir) setTimeout(pdf, 50);
}

export function fecharApresentacao() {
  if (!aberto) return;
  const { raiz, tecla, anterior, desligarDicas } = aberto;
  aberto = null;
  document.removeEventListener("keydown", tecla);
  desligarDicas?.();
  if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => {});
  raiz.remove();
  document.body.classList.remove("ap-aberta", "ap-imprimindo");
  anterior?.focus?.();
}
