// Modal "Importar relatório Food Delivery" — 2 passos:
//   1. upload -> prévia de formato/período/quantidade
//   2. análise automática (cancelamentos classificados pelo motor +
//      conciliação financeira) -> confirmar
// A classificação de cada cancelamento (recebe/não recebe taxa/revisão) é
// automática desde a reformulação — não existe mais uma etapa de digitar
// códigos manualmente aqui (ver aba Cancelamentos pra alterar uma decisão
// pontual DEPOIS de importado). A leitura da planilha acontece sempre no
// BACKEND (parser-food-delivery/parserFoodDelivery.parser.js); o frontend só
// embala o arquivo em base64 e reenvia a cada chamada (mesma técnica de
// bonificacaoMensalImportModal.js) — nenhum estado de importação fica
// "pendente" no servidor entre os passos.
import { el, escapeHtml, toast, fmtMoeda } from "./utils.js";
import { icon } from "./icons.js";
import { pfdImportarPreview, pfdConciliarPreview, pfdConciliarConfirmar } from "./api.js";

import { geracaoContexto, contextoMudou, registrarResetDeContexto } from "./contextoEscopo.js";

registrarResetDeContexto(() => fecharOverlay());
let ov = null;
function fecharOverlay() { ov?.remove(); ov = null; document.removeEventListener("keydown", onEsc); }
function onEsc(e) { if (e.key === "Escape") fecharOverlay(); }
function overlay(html) {
  fecharOverlay();
  ov = document.createElement("div"); ov.className = "modal-overlay";
  ov.innerHTML = `<div class="modal bm-modal pfd-modal">${html}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) fecharOverlay(); });
  document.body.appendChild(ov); document.addEventListener("keydown", onEsc);
  return ov.querySelector(".modal");
}

// ---------- arquivo -> base64 (mesma técnica de bonificacaoMensalImportModal.js) ----------
async function arquivoPayload(file) {
  if (!file) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const BLOCO = 0x8000;
  for (let i = 0; i < bytes.length; i += BLOCO) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + BLOCO));
  return { nomeArquivo: file.name, conteudoBase64: btoa(bin) };
}

const fmtDataBr = (iso) => (iso ? iso.split("-").reverse().join("/") : "—");
const fmtPeriodo = (ini, fim) => (!ini ? "—" : ini === fim ? fmtDataBr(ini) : `${fmtDataBr(ini)} até ${fmtDataBr(fim)}`);

export function abrirImportarFoodDeliveryModal({ unidadeNome, onSalvo }) {
  const ctx = {
    geracao: geracaoContexto(), etapa: 1, arquivoFile: null, payloadArquivo: null, previewArquivo: null,
    periodoManual: { inicio: "", fim: "" }, conciliacao: null, onSalvo,
  };

  const m = overlay(`
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>${icon("upload", { size: 19 })} Importar relatório Food Delivery</h2><div class="modal-tags"><span class="chip">${icon("store", { size: 13 })} ${escapeHtml(unidadeNome || "—")}</span></div></div>
    <div class="pfd-imp-corpo"></div>`);
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);

  renderEtapa1(m, ctx);
}

// ---------------------------------------------------------------------------
// ETAPA 1 — upload + prévia de formato/período/quantidade
// ---------------------------------------------------------------------------
function renderEtapa1(m, ctx) {
  const corpo = m.querySelector(".pfd-imp-corpo");
  corpo.innerHTML = `
    <div class="bm-imp-form">
      <div class="bm-drop" id="pfd-drop">
        <div class="bm-drop-titulo">Relatório de pedidos (.xls ou .xlsx)</div>
        <p class="bm-drop-desc">Relatório detalhado de pedidos do food delivery — diário, semanal, mensal ou qualquer intervalo.</p>
        <div class="bm-drop-area" tabindex="0" role="button">
          <span class="bm-drop-icone">${icon("file-text", { size: 22 })}</span>
          <span class="bm-drop-txt">Arraste o arquivo aqui ou <u>selecione o arquivo</u></span>
          <em id="pfd-drop-nome">Nenhum arquivo selecionado</em>
        </div>
        <input type="file" id="pfd-drop-input" accept=".xls,.xlsx" hidden>
      </div>
      <div class="vd-imp-msg" id="pfd-imp-msg" hidden></div>
      <div id="pfd-preview-1"></div>
    </div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="pfd-cancelar">Cancelar</button>
      <button class="btn btn-primary" id="pfd-analisar" disabled>Analisar relatório</button>
    </div>`;

  m.querySelector("#pfd-cancelar").addEventListener("click", fecharOverlay);
  wireDropZone(m, "pfd-drop", (f) => {
    ctx.arquivoFile = f; ctx.previewArquivo = null;
    m.querySelector("#pfd-preview-1").innerHTML = "";
    m.querySelector("#pfd-analisar").disabled = false;
  });
  m.querySelector("#pfd-analisar").addEventListener("click", () => analisarArquivo(m, ctx));
}

function wireDropZone(m, id, onArquivo) {
  const zona = m.querySelector(`#${id}`);
  const area = zona.querySelector(".bm-drop-area");
  const input = zona.querySelector(`#${id}-input`);
  const nomeEl = zona.querySelector(`#${id}-nome`);
  const aplicar = (file) => {
    if (!file) return;
    if (!/\.(xls|xlsx)$/i.test(file.name)) { toast("Selecione um arquivo .xls ou .xlsx."); return; }
    nomeEl.textContent = file.name;
    zona.classList.add("preenchido");
    onArquivo(file);
  };
  area.addEventListener("click", () => input.click());
  area.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") input.click(); });
  input.addEventListener("change", () => aplicar(input.files?.[0]));
  ["dragenter", "dragover"].forEach((ev) => area.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add("arrastando"); }));
  ["dragleave", "drop"].forEach((ev) => area.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove("arrastando"); }));
  area.addEventListener("drop", (e) => aplicar(e.dataTransfer.files?.[0]));
}

async function analisarArquivo(m, ctx) {
  const msg = m.querySelector("#pfd-imp-msg");
  const setMsg = (t, cls = "erro") => { msg.hidden = false; msg.className = "vd-imp-msg " + cls; msg.textContent = t; };
  const btn = m.querySelector("#pfd-analisar");
  const txtOriginal = btn.textContent;
  btn.disabled = true; btn.textContent = "Lendo planilha…";
  try {
    ctx.payloadArquivo = await arquivoPayload(ctx.arquivoFile);
    const { data } = await pfdImportarPreview({ arquivo: ctx.payloadArquivo });
    ctx.previewArquivo = data;
    renderPreview1(m, ctx);
  } catch (e) {
    setMsg("Erro: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = txtOriginal;
  }
}

function renderPreview1(m, ctx) {
  const p = ctx.previewArquivo;
  const box = m.querySelector("#pfd-preview-1");
  const item = (lbl, val) => `<div class="vd-pv-item"><span>${lbl}</span><b>${val}</b></div>`;
  const situacoes = Object.entries(p.porSituacao || {}).map(([s, n]) => `${escapeHtml(s)}: ${n}`).join(" · ");
  const f = p.filtragem || {};
  box.innerHTML = `
    <div class="vd-preview">
      <div class="vd-pv-titulo">Relatório lido com sucesso</div>
      <div class="vd-pv-grid">
        ${item("Arquivo original", escapeHtml(p.nomeArquivo || "—"))}
        ${item("Total de pedidos", p.totalPedidos)}
        ${item("Período analisado", p.periodoDetectado ? fmtPeriodo(p.periodoInicio, p.periodoFim) : "não detectado")}
      </div>
      <p class="dex-diag-vazio">Por situação: ${situacoes || "—"}</p>
      <div class="bm-pv-bloco" style="margin-top:10px">
        <b>${icon("filter", { size: 14 })} Filtragem</b>
        <div class="vd-pv-grid" style="margin-top:8px">
          ${item("Subway Saci (entram na conta)", f.subway ?? "—")}
          ${item("Sem entregador (ignorados)", f.semEntregador ?? 0)}
          ${item("Açaí no Grau (ignorados)", f.acaiNoGrau ?? 0)}
          ${item("Operação indefinida", f.revisaoNecessaria ?? 0)}
        </div>
        ${p.colunaDetalhesEncontrada === false ? `<p class="dex-diag-vazio">${icon("alert-triangle", { size: 13 })} Não encontrei a coluna "Detalhes do pedido" — não foi possível separar por operação; todos os pedidos serão tratados como Subway Saci.</p>` : ""}
      </div>
      ${!p.periodoDetectado ? `
        <div class="cfg-form-grid" style="margin-top:10px">
          <label class="cfg-campo"><span>Período inicial *</span><input type="date" id="pfd-periodo-ini"></label>
          <label class="cfg-campo"><span>Período final *</span><input type="date" id="pfd-periodo-fim"></label>
        </div>
        <p class="dex-diag-vazio">Não consegui identificar o período automaticamente neste relatório — informe manualmente.</p>` : ""}
    </div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="pfd-voltar-1">Trocar arquivo</button>
      <button class="btn btn-primary" id="pfd-analisar-cancelamentos">Analisar cancelamentos ${icon("arrow-right", { size: 14 })}</button>
    </div>`;
  m.querySelector("#pfd-voltar-1").addEventListener("click", () => renderEtapa1(m, ctx));
  m.querySelector("#pfd-analisar-cancelamentos").addEventListener("click", () => {
    if (!p.periodoDetectado) {
      ctx.periodoManual.inicio = m.querySelector("#pfd-periodo-ini")?.value || "";
      ctx.periodoManual.fim = m.querySelector("#pfd-periodo-fim")?.value || "";
      if (!ctx.periodoManual.inicio || !ctx.periodoManual.fim) { toast("Informe o período inicial e final."); return; }
    }
    analisarConciliacao(m, ctx);
  });
}

// ---------------------------------------------------------------------------
// ANÁLISE AUTOMÁTICA — roda o motor de classificação de cancelamentos +
// conciliação financeira completa (nenhuma entrada manual necessária).
// ---------------------------------------------------------------------------
async function analisarConciliacao(m, ctx) {
  const corpo = m.querySelector(".pfd-imp-corpo");
  corpo.innerHTML = `<div class="estado"><div class="spinner"></div>Avaliando cancelamentos e consolidando taxas…</div>`;
  try {
    const { data } = await pfdConciliarPreview({
      arquivo: ctx.payloadArquivo,
      periodoInicio: ctx.periodoManual.inicio || undefined, periodoFim: ctx.periodoManual.fim || undefined,
    });
    ctx.conciliacao = data;
    renderRevisaoFinal(m, ctx);
  } catch (e) {
    corpo.innerHTML = `<div class="vd-imp-msg erro">Erro ao analisar: ${escapeHtml(e.message)}</div>
      <div class="ed-acoes"><button class="btn btn-ghost" id="pfd-voltar-erro">${icon("chevron-left", { size: 14 })} Voltar</button></div>`;
    m.querySelector("#pfd-voltar-erro").addEventListener("click", () => renderPreview1(m, ctx));
  }
}

// ---------------------------------------------------------------------------
// ETAPA 2 — revisão final: relatório processado com sucesso (seção 40) +
// resultado da análise automática dos cancelamentos -> confirmar.
// ---------------------------------------------------------------------------
function renderRevisaoFinal(m, ctx) {
  const corpo = m.querySelector(".pfd-imp-corpo");
  const d = ctx.conciliacao;
  const r = d.resumo;
  const avisos = [];
  if (d.avisos?.hashDuplicado) avisos.push(`Este arquivo já foi importado (${escapeHtml(d.avisos.hashDuplicado.nomeArquivo || "importação anterior")}) — não será possível confirmar.`);
  for (const s of d.avisos?.periodosSobrepostos || []) avisos.push(`Já existe uma importação cobrindo parte deste período (${fmtPeriodo(s.periodoInicio, s.periodoFim)}, ${escapeHtml(s.nomeArquivo || "arquivo")}).`);

  corpo.innerHTML = `
    <div class="vd-preview">
      <div class="vd-pv-titulo">${icon("check-circle", { size: 15 })} Relatório processado com sucesso — ${fmtPeriodo(d.periodoInicio, d.periodoFim)}</div>
      <p class="dex-diag-vazio">Filtragem: ${d.filtragem?.subway ?? r.totalPedidos} Subway com entregador · ${d.filtragem?.semEntregador ?? 0} sem entregador · ${d.filtragem?.acaiNoGrau ?? 0} Açaí no Grau · ${d.filtragem?.revisaoNecessaria ?? 0} indefinidos ignorados.</p>
      <div class="vd-pv-grid">
        <div class="vd-pv-item"><span>Total de pedidos Subway</span><b>${r.totalPedidos}</b></div>
        <div class="vd-pv-item"><span>Entregues/finalizados</span><b>${r.entregues}</b></div>
        <div class="vd-pv-item"><span>Cancelados</span><b>${r.cancelados}</b></div>
      </div>
      <div class="bm-pv-bloco" style="margin-top:10px">
        <b>${icon("activity", { size: 14 })} Análise automática dos cancelamentos</b>
        <div class="pfd-status-band pfd-status-band--compacto" style="margin-top:8px">
          <div class="pfd-status-item pfd-status--pos"><span class="pfd-status-lbl">Recebem taxa</span><span class="pfd-status-val">${r.canceladosRecebemTaxa}</span></div>
          <div class="pfd-status-item pfd-status--neutro"><span class="pfd-status-lbl">Não recebem</span><span class="pfd-status-val">${r.canceladosNaoRecebemTaxa}</span></div>
          <div class="pfd-status-item pfd-status--warn"><span class="pfd-status-lbl">Para revisar</span><span class="pfd-status-val">${r.canceladosRevisao}</span></div>
        </div>
        ${r.canceladosRevisao > 0 ? `<p class="dex-diag-vazio" style="margin-top:6px">Pedidos em revisão mantêm a taxa por padrão — confira depois na aba Cancelamentos.</p>` : ""}
      </div>
      <div class="pfd-conciliacao" style="margin-top:12px">
        <div class="pfd-conc-linha"><span>Taxas encontradas</span><b>${fmtMoeda(r.taxasBrutas)}</b></div>
        <div class="pfd-conc-linha pfd-conc-neg"><span>Taxas descartadas</span><b>− ${fmtMoeda(r.taxasDescartadas)}</b></div>
        <div class="pfd-conc-divisor"></div>
        <div class="pfd-conc-linha pfd-conc-final"><span>Valor devido aos entregadores</span><b>${fmtMoeda(r.taxasValidas)}</b></div>
      </div>
      ${avisos.length ? `<div class="vd-pv-divs">${avisos.map((a) => `<div class="vd-pv-div"><span class="pill warn">atenção</span> ${a}</div>`).join("")}</div>` : `<div class="vd-pv-ok">${icon("check-circle", { size: 14 })} Nenhuma duplicidade encontrada para este período.</div>`}
    </div>
    <div class="vd-imp-msg" id="pfd-imp-msg-2" hidden></div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="pfd-voltar-2">${icon("chevron-left", { size: 14 })} Voltar</button>
      <button class="btn btn-primary" id="pfd-confirmar" ${d.avisos?.hashDuplicado ? "disabled" : ""}>Confirmar importação</button>
    </div>`;

  m.querySelector("#pfd-voltar-2").addEventListener("click", () => renderPreview1(m, ctx));
  m.querySelector("#pfd-confirmar").addEventListener("click", () => confirmar(m, ctx));
}

async function confirmar(m, ctx) {
  if (contextoMudou(ctx.geracao)) return;
  const msg = m.querySelector("#pfd-imp-msg-2");
  const btn = m.querySelector("#pfd-confirmar");
  const txtOriginal = btn.textContent;
  btn.disabled = true; btn.textContent = "Salvando…";
  try {
    const { data } = await pfdConciliarConfirmar({
      arquivo: ctx.payloadArquivo,
      periodoInicio: ctx.periodoManual.inicio || undefined, periodoFim: ctx.periodoManual.fim || undefined,
    });
    if (contextoMudou(ctx.geracao)) return;
    toast("Relatório importado e conciliado.");
    fecharOverlay();
    await ctx.onSalvo?.(data);
  } catch (e) {
    msg.hidden = false; msg.className = "vd-imp-msg erro"; msg.textContent = "Erro: " + e.message;
    btn.disabled = false; btn.textContent = txtOriginal;
  }
}
