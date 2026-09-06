// Modal "Importar Visio" — dois modos:
//   📅 Lançamento diário  — 2 relatórios (Geral + Loja) de UM dia.
//   📆 Fechamento mensal  — os 2 relatórios mensais (Vendas + Produtos
//      Loja/Balcão) que consolidam a competência. Prévia implementada na F3;
//      a confirmação (gravação + snapshot congelado) entra na F4. O redesenho
//      completo desta aba (2 dropzones + checkboxes) é a F7.
//
// A leitura/interpretação do PDF acontece sempre no BACKEND
// (bonificacao-mensal/visio-parser.js); o frontend só embala o arquivo em
// base64, mostra a prévia e deixa corrigir manualmente antes de confirmar.
import { el, escapeHtml, toast, fmtMoeda, fmtPct } from "./utils.js";
import {
  bonifImportarPreview, bonifImportarConfirmar,
  bonifFechamentoMensalPreview, bonifFechamentoMensalConfirmar,
} from "./api.js";

const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

let ov = null;
function fecharOverlay() { ov?.remove(); ov = null; document.removeEventListener("keydown", onEsc); }
function onEsc(e) { if (e.key === "Escape") fecharOverlay(); }
function overlay(html) {
  fecharOverlay();
  ov = document.createElement("div"); ov.className = "modal-overlay";
  ov.innerHTML = `<div class="modal bm-modal">${html}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) fecharOverlay(); });
  document.body.appendChild(ov); document.addEventListener("keydown", onEsc);
  return ov.querySelector(".modal");
}

// ---------- arquivo -> base64 (mesma técnica de vendas.js) ----------
async function arquivoPayload(file) {
  if (!file) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const BLOCO = 0x8000;
  for (let i = 0; i < bytes.length; i += BLOCO) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + BLOCO));
  return { nomeArquivo: file.name, conteudoBase64: btoa(bin) };
}

const dropZoneHtml = (id, titulo, descricao) => `
  <div class="bm-drop" id="${id}-drop">
    <div class="bm-drop-titulo">${escapeHtml(titulo)}</div>
    <p class="bm-drop-desc">${escapeHtml(descricao)}</p>
    <div class="bm-drop-area" tabindex="0" role="button">
      <span class="bm-drop-icone">📄</span>
      <span class="bm-drop-txt">Arraste o PDF aqui ou <u>selecione o arquivo</u></span>
      <em id="${id}-nome">Nenhum arquivo selecionado</em>
    </div>
    <input type="file" id="${id}-input" accept=".pdf" hidden>
  </div>`;

function wireDropZone(m, id, onArquivo) {
  const zona = m.querySelector(`#${id}-drop`);
  const area = zona.querySelector(".bm-drop-area");
  const input = zona.querySelector(`#${id}-input`);
  const nomeEl = zona.querySelector(`#${id}-nome`);
  const aplicar = (file) => {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) { toast("Selecione um arquivo PDF."); return; }
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

const fmtDataBr = (iso) => iso?.split("-").reverse().join("/") ?? "—";

/**
 * @param {{unidadeNome:string, mesAtual:number, anoAtual:number, onSalvo:Function, modo?:"diario"|"mensal"}} p
 */
export function abrirImportarVisioModal({ unidadeNome, mesAtual, anoAtual, onSalvo, modo = "diario" }) {
  // `ctx` é o estado do modal, compartilhado por todos os handlers.
  const ctx = {
    modo,
    arquivos: { geral: null, loja: null, mensal: null },
    diario: { ultimoPreview: null },
    mensal: { ultimoPreview: null },
    onSalvo,
  };
  const hojeIso = new Date().toISOString().slice(0, 10);
  const anos = [anoAtual, anoAtual - 1, anoAtual - 2];

  const m = overlay(`
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>⬆️ Importar dados da Visio</h2><div class="modal-tags"><span class="chip">🏪 ${escapeHtml(unidadeNome || "—")}</span></div></div>
    <div class="bm-imp-modos" role="tablist">
      <button class="bm-imp-modo ${modo === "diario" ? "ativo" : ""}" data-modo="diario" role="tab">📅 Lançamento diário</button>
      <button class="bm-imp-modo ${modo === "mensal" ? "ativo" : ""}" data-modo="mensal" role="tab">📆 Fechamento mensal (oficial)</button>
    </div>

    <div class="bm-imp-pane" data-pane="diario" ${modo === "diario" ? "" : "hidden"}>
      <div class="bm-imp-form">
        <label class="cfg-campo bm-imp-data"><span>Data do lançamento *</span><input type="date" id="bm-imp-data" value="${hojeIso}"></label>
        ${dropZoneHtml("bm-geral", "Relatório Geral", "Relatório com todos os canais. Utilizado principalmente para o faturamento total da loja.")}
        <label class="cfg-campo"><span>Data de venda do Relatório Geral</span><input type="date" id="bm-geral-periodo"></label>
        <label><input type="checkbox" id="bm-geral-periodo-confirmado"> Conferi que o Relatório Geral cobre somente essa data.</label>
        ${dropZoneHtml("bm-loja", "Relatório Loja", "Relatório filtrado somente para Loja/Balcão. Utilizado para calcular as metas de Bebidas, Adicionais e Diversos.")}
        <label class="cfg-campo"><span>Data de venda do Relatório Loja</span><input type="date" id="bm-loja-periodo"></label>
        <label><input type="checkbox" id="bm-loja-periodo-confirmado"> Conferi que o Relatório Loja cobre somente essa data.</label>
        <div class="vd-imp-msg" id="bm-imp-msg" hidden></div>
        <div id="bm-imp-preview"></div>
      </div>
      <div class="ed-acoes">
        <button class="btn btn-ghost" id="bm-imp-cancelar">Cancelar</button>
        <button class="btn btn-ghost" id="bm-imp-analisar">Analisar relatórios</button>
        <button class="btn btn-primary" id="bm-imp-confirmar" disabled>Confirmar lançamento</button>
      </div>
    </div>

    <div class="bm-imp-pane" data-pane="mensal" ${modo === "mensal" ? "" : "hidden"}>
      <div class="bm-imp-form">
        <p class="dex-diag-vazio">O fechamento mensal consolida a competência a partir dos <b>dois relatórios mensais</b> da Visio (Vendas + Produtos Loja/Balcão). A prévia abaixo valida os arquivos; a confirmação definitiva entra na próxima etapa.</p>
        <div class="bm-imp-competencia">
          <label class="cfg-campo"><span>Mês *</span><select id="bm-mensal-mes">${MESES.map((mm, i) => `<option value="${i + 1}" ${i + 1 === mesAtual ? "selected" : ""}>${mm}</option>`).join("")}</select></label>
          <label class="cfg-campo"><span>Ano *</span><select id="bm-mensal-ano">${anos.map((a) => `<option value="${a}" ${a === anoAtual ? "selected" : ""}>${a}</option>`).join("")}</select></label>
        </div>
        ${dropZoneHtml("bm-mensal", "Relatório de Produtos — mês inteiro (Loja)", "Mesmo relatório do lançamento diário, só que com o filtro de data cobrindo todo o mês.")}
        <div class="vd-imp-msg" id="bm-mensal-msg" hidden></div>
        <div id="bm-mensal-preview"></div>
      </div>
      <div class="ed-acoes">
        <button class="btn btn-ghost" id="bm-mensal-cancelar">Cancelar</button>
        <button class="btn btn-ghost" id="bm-mensal-analisar">Analisar relatório</button>
        <button class="btn btn-primary" id="bm-mensal-confirmar" disabled>Confirmar fechamento</button>
      </div>
    </div>`);

  ctx.dataDiario = () => m.querySelector("#bm-imp-data").value;
  ctx.competencia = () => ({ ano: Number(m.querySelector("#bm-mensal-ano").value), mes: Number(m.querySelector("#bm-mensal-mes").value) });

  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#bm-imp-cancelar").addEventListener("click", fecharOverlay);
  m.querySelector("#bm-mensal-cancelar").addEventListener("click", fecharOverlay);

  m.querySelectorAll(".bm-imp-modo").forEach((b) => b.addEventListener("click", () => {
    ctx.modo = b.dataset.modo;
    m.querySelectorAll(".bm-imp-modo").forEach((x) => x.classList.toggle("ativo", x === b));
    m.querySelectorAll(".bm-imp-pane").forEach((p) => { p.hidden = p.dataset.pane !== ctx.modo; });
  }));

  // ---- pane diário ----
  for (const tipo of ["geral", "loja"]) {
    wireDropZone(m, `bm-${tipo}`, (f) => {
      ctx.arquivos[tipo] = f;
      m.querySelector(`#bm-${tipo}-periodo`).value = "";
      m.querySelector(`#bm-${tipo}-periodo-confirmado`).checked = false;
      invalidarDiario();
    });
    m.querySelector(`#bm-${tipo}-periodo`).addEventListener("change", () => {
      m.querySelector(`#bm-${tipo}-periodo-confirmado`).checked = false;
      invalidarDiario();
    });
    m.querySelector(`#bm-${tipo}-periodo-confirmado`).addEventListener("change", invalidarDiario);
  }
  m.querySelector("#bm-imp-data").addEventListener("change", invalidarDiario);
  m.querySelector("#bm-imp-analisar").addEventListener("click", () => processarDiario(m, ctx, false));
  m.querySelector("#bm-imp-confirmar").addEventListener("click", () => processarDiario(m, ctx, true));

  // ---- pane mensal ----
  wireDropZone(m, "bm-mensal", (f) => { ctx.arquivos.mensal = f; invalidarMensal(); });
  m.querySelector("#bm-mensal-mes").addEventListener("change", invalidarMensal);
  m.querySelector("#bm-mensal-ano").addEventListener("change", invalidarMensal);
  m.querySelector("#bm-mensal-analisar").addEventListener("click", () => processarMensal(m, ctx, false));
  m.querySelector("#bm-mensal-confirmar").addEventListener("click", () => processarMensal(m, ctx, true));

  function invalidarDiario() {
    ctx.diario.ultimoPreview = null;
    m.querySelector("#bm-imp-confirmar").disabled = true;
    m.querySelector("#bm-imp-preview").innerHTML = "";
    m.querySelector("#bm-imp-msg").hidden = true;
  }
  function invalidarMensal() {
    ctx.mensal.ultimoPreview = null;
    m.querySelector("#bm-mensal-confirmar").disabled = true;
    m.querySelector("#bm-mensal-preview").innerHTML = "";
    m.querySelector("#bm-mensal-msg").hidden = true;
  }
}

// ===========================================================================
// LANÇAMENTO DIÁRIO (Geral + Loja) — fluxo original, inalterado.
// ===========================================================================
async function processarDiario(m, ctx, confirmar) {
  const msg = m.querySelector("#bm-imp-msg");
  const setMsg = (t, cls = "erro") => { msg.hidden = false; msg.className = "vd-imp-msg " + cls; msg.textContent = t; };
  const dataLancamento = ctx.dataDiario();
  if (!dataLancamento) return setMsg("Informe a data do lançamento.");
  if (!ctx.arquivos.geral && !ctx.arquivos.loja) return setMsg("Envie pelo menos um dos dois relatórios (Geral ou Loja).");

  const btn = m.querySelector(confirmar ? "#bm-imp-confirmar" : "#bm-imp-analisar");
  const txtOriginal = btn.textContent;
  const etapas = confirmar ? ["Salvando…"] : ["Enviando arquivos…", "Lendo relatórios…", "Validando informações…"];
  let i = 0;
  btn.disabled = true;
  const timer = etapas.length > 1 ? setInterval(() => { btn.textContent = etapas[Math.min(i++, etapas.length - 1)]; }, 700) : null;
  btn.textContent = etapas[0];

  try {
    let payload = ctx.diario.ultimoPreview?.payload;
    if (!confirmar || !payload) {
      const [geral, loja] = await Promise.all([arquivoPayload(ctx.arquivos.geral), arquivoPayload(ctx.arquivos.loja)]);
      for (const [tipo, arquivo] of [["geral", geral], ["loja", loja]]) {
        if (!arquivo) continue;
        const inicio = m.querySelector(`#bm-${tipo}-periodo`).value;
        const confirmado = m.querySelector(`#bm-${tipo}-periodo-confirmado`).checked;
        if (inicio) arquivo.periodo = { inicio, fim: inicio, confirmado };
      }
      payload = { data: dataLancamento, geral, loja };
      ctx.diario.ultimoPreview = { payload };
    }
    if (confirmar) {
      await bonifImportarConfirmar({ ...payload, substituir: ctx.diario.ultimoPreview?.substituir });
      toast("Relatórios processados. Lançamento salvo ✅");
      fecharOverlay();
      ctx.onSalvo?.();
    } else {
      const { data } = await bonifImportarPreview(payload);
      if (data.duplicado) return renderDuplicado(m, ctx, data);
      renderPreview(m, ctx, data);
    }
  } catch (e) {
    setMsg("Erro: " + e.message);
  } finally {
    if (timer) clearInterval(timer);
    btn.disabled = false; btn.textContent = txtOriginal;
  }
}

function renderDuplicado(m, ctx, data) {
  const box = m.querySelector("#bm-imp-preview");
  const l = data.existente;
  const p = data.preview;
  const linha = (lbl, atual, novo) => `<tr><td>${lbl}</td><td class="num">${atual}</td><td class="num">${novo}</td></tr>`;
  box.innerHTML = `
    <div class="vd-preview">
      <div class="vd-pv-titulo">⚠️ Já existe um lançamento para ${fmtDataBr(p.data)}</div>
      <div class="tabela-wrap"><table class="grid">
        <thead><tr><th></th><th class="num">Valor atual</th><th class="num">Novo valor</th></tr></thead>
        <tbody>
          ${linha("Faturamento Geral", fmtMoeda(l.faturamentoGeral), p.geral ? fmtMoeda(p.geral.faturamento) : "—")}
          ${linha("Ticket Médio Geral", l.ticketMedio != null ? fmtMoeda(l.ticketMedio) : "—", p.geral?.ticketMedio != null ? fmtMoeda(p.geral.ticketMedio) : "—")}
          ${linha("Faturamento Loja", fmtMoeda(l.faturamentoLoja), p.loja ? fmtMoeda(p.loja.faturamento) : "—")}
          ${linha("Sanduíches/Saladas", l.qtdSanduichesLoja ?? "—", p.loja?.sanduichesSaladas ?? "—")}
          ${linha("Bebidas", l.qtdBebidasLoja ?? "—", p.loja?.bebidas ?? "—")}
          ${linha("Adicionais", l.qtdAdicionaisLoja ?? "—", p.loja?.adicionais ?? "—")}
          ${linha("Diversos", l.qtdDiversosLoja ?? "—", p.loja?.diversos ?? "—")}
          ${linha("Origem", escapeHtml(l.origem), "visio")}
        </tbody>
      </table></div>
      <p class="dex-diag-vazio">Confirmar vai <b>substituir</b> este lançamento pelos novos valores acima.</p>
    </div>`;
  const conf = m.querySelector("#bm-imp-confirmar");
  conf.disabled = false; conf.textContent = "Substituir lançamento";
  ctx.diario.ultimoPreview.substituir = true;
}

function renderPreview(m, ctx, data) {
  const p = data.preview;
  const box = m.querySelector("#bm-imp-preview");
  const item = (lbl, val) => `<div class="vd-pv-item"><span>${lbl}</span><b>${val}</b></div>`;
  box.innerHTML = `
    <div class="vd-preview">
      <div class="vd-pv-titulo">Dados encontrados — ${fmtDataBr(p.data)}</div>
      ${p.geral ? `<div class="bm-pv-bloco"><b>Geral</b><div class="vd-pv-grid">
        ${item("Faturamento Total", fmtMoeda(p.geral.faturamento))}
        ${item("Ticket Médio", fmtMoeda(p.geral.ticketMedio))}
        ${item("Cupons válidos", p.geral.cuponsValidos ?? "—")}
        ${item("Cupons de vendas", p.geral.cuponsVendas ?? "—")}
        ${item("Estabelecimento", escapeHtml(p.geral.estabelecimento || "—"))}
      </div></div>` : `<p class="dex-diag-vazio">Relatório Geral não enviado.</p>`}
      ${p.loja ? `<div class="bm-pv-bloco"><b>Loja / Balcão</b><div class="vd-pv-grid">
        ${item("Faturamento Loja", fmtMoeda(p.loja.faturamento))}
        ${item("PPD", p.loja.ppd)}
        ${item("Sanduíches/Saladas", p.loja.sanduichesSaladas)}
        ${item("Bebidas", `${p.loja.bebidas} → ${fmtPct(p.loja.mixCalculado?.bebidas)}`)}
        ${item("Adicionais", `${p.loja.adicionais} → ${fmtPct(p.loja.mixCalculado?.adicionais)}`)}
        ${item("Diversos", `${p.loja.diversos} → ${fmtPct(p.loja.mixCalculado?.diversos)}`)}
        ${item("Estabelecimento", escapeHtml(p.loja.estabelecimento || "—"))}
      </div></div>` : `<p class="dex-diag-vazio">Relatório Loja não enviado.</p>`}
      ${p.avisos?.length ? `<div class="vd-pv-divs">${p.avisos.map((a) => `<div class="vd-pv-div"><span class="pill warn">atenção</span> ${escapeHtml(a)}</div>`).join("")}</div>` : `<div class="vd-pv-ok">✅ Nenhuma divergência encontrada.</div>`}
      <details class="bm-pv-corrigir"><summary>Algum número foi lido errado? Corrigir manualmente</summary>
        <div class="cfg-form-grid">
          ${p.geral ? `<label class="cfg-campo"><span>Faturamento Geral (correção)</span><input type="number" step="0.01" id="bm-corr-geral-faturamento" placeholder="${p.geral.faturamento}"></label>
          <label class="cfg-campo"><span>Ticket Médio (correção)</span><input type="number" step="0.01" id="bm-corr-geral-ticketMedio" placeholder="${p.geral.ticketMedio}"></label>` : ""}
          ${p.loja ? `<label class="cfg-campo"><span>Faturamento Loja (correção)</span><input type="number" step="0.01" id="bm-corr-loja-faturamento" placeholder="${p.loja.faturamento}"></label>
          <label class="cfg-campo"><span>Sanduíches/Saladas (correção)</span><input type="number" step="1" id="bm-corr-loja-sandwichesSalads" placeholder="${p.loja.sanduichesSaladas}"></label>
          <label class="cfg-campo"><span>Bebidas (correção)</span><input type="number" step="1" id="bm-corr-loja-beverages" placeholder="${p.loja.bebidas}"></label>
          <label class="cfg-campo"><span>Adicionais (correção)</span><input type="number" step="1" id="bm-corr-loja-additions" placeholder="${p.loja.adicionais}"></label>
          <label class="cfg-campo"><span>Diversos (correção)</span><input type="number" step="1" id="bm-corr-loja-miscellaneous" placeholder="${p.loja.diversos}"></label>` : ""}
        </div>
        <p class="dex-diag-vazio">Campos preenchidos aqui substituem o valor lido do PDF e ficam marcados como correção manual.</p>
        <button class="btn btn-ghost btn-sm" id="bm-corr-aplicar" type="button">Reanalisar com as correções</button>
      </details>
    </div>`;

  const conf = m.querySelector("#bm-imp-confirmar");
  conf.disabled = false; conf.textContent = "Confirmar lançamento";
  m.querySelector("#bm-corr-aplicar")?.addEventListener("click", () => aplicarCorrecoes(m, ctx));
}

function aplicarCorrecoes(m, ctx) {
  const lerNum = (id) => { const v = m.querySelector(`#${id}`)?.value; return v === "" || v == null ? undefined : v; };
  const correcoes = {
    geral: { faturamento: lerNum("bm-corr-geral-faturamento"), ticketMedio: lerNum("bm-corr-geral-ticketMedio") },
    loja: {
      faturamento: lerNum("bm-corr-loja-faturamento"), sandwichesSalads: lerNum("bm-corr-loja-sandwichesSalads"),
      beverages: lerNum("bm-corr-loja-beverages"), additions: lerNum("bm-corr-loja-additions"), miscellaneous: lerNum("bm-corr-loja-miscellaneous"),
    },
  };
  if (ctx.diario.ultimoPreview?.payload) ctx.diario.ultimoPreview.payload = { ...ctx.diario.ultimoPreview.payload, correcoes };
  m.querySelector("#bm-imp-analisar").click();
}

// ===========================================================================
// FECHAMENTO MENSAL OFICIAL (1 Relatório de Produtos, mês inteiro).
// ===========================================================================
async function processarMensal(m, ctx, confirmar) {
  const msg = m.querySelector("#bm-mensal-msg");
  const setMsg = (t, cls = "erro") => { msg.hidden = false; msg.className = "vd-imp-msg " + cls; msg.textContent = t; };
  const { ano, mes } = ctx.competencia();
  if (!ano || !mes) return setMsg("Escolha o mês e o ano do fechamento.");
  if (!ctx.arquivos.mensal) return setMsg("Envie o Relatório de Produtos mensal (Loja).");

  const btn = m.querySelector(confirmar ? "#bm-mensal-confirmar" : "#bm-mensal-analisar");
  const txtOriginal = btn.textContent;
  const etapas = confirmar ? ["Salvando…"] : ["Enviando arquivo…", "Lendo relatório…", "Validando…"];
  let i = 0;
  btn.disabled = true;
  const timer = etapas.length > 1 ? setInterval(() => { btn.textContent = etapas[Math.min(i++, etapas.length - 1)]; }, 700) : null;
  btn.textContent = etapas[0];

  try {
    const produtos = await arquivoPayload(ctx.arquivos.mensal);
    // F7 acrescenta o dropzone do Relatório de Vendas + os 2 checkboxes. Por
    // ora só o de Produtos existe — a prévia devolve o bloqueio "falta Vendas".
    const payload = {
      ano, mes, produtos,
      vendas: ctx.arquivos.vendasMensal ? await arquivoPayload(ctx.arquivos.vendasMensal) : undefined,
      produtosCanalConfirmado: !!ctx.mensal.canalConfirmado,
      periodoConfirmadoUsuario: !!ctx.mensal.periodoConfirmado,
      correcoes: ctx.mensal.ultimoPreview?.correcoes,
    };
    if (confirmar) {
      await bonifFechamentoMensalConfirmar(payload);
      toast("Fechamento mensal salvo ✅");
      fecharOverlay();
      ctx.onSalvo?.();
    } else {
      const { data } = await bonifFechamentoMensalPreview(payload);
      ctx.mensal.ultimoPreview = { payload };
      renderPreviewMensal(m, data);
    }
  } catch (e) {
    setMsg("Erro: " + e.message);
  } finally {
    if (timer) clearInterval(timer);
    btn.disabled = false; btn.textContent = txtOriginal;
  }
}

// Prévia F3: `data` é o próprio preview ({ competencia, vendas, produtos,
// validacao:{bloqueios,alertas}, prontoParaConfirmar }). SEM comparação entre
// fontes — bloqueios impedem confirmar, alertas são só conferência do arquivo.
function renderPreviewMensal(m, data) {
  const box = m.querySelector("#bm-mensal-preview");
  const item = (lbl, val) => `<div class="vd-pv-item"><span>${lbl}</span><b>${val}</b></div>`;
  const prod = data.produtos || {};
  const vend = data.vendas || {};
  const pct = prod.percentuais || {};
  const val = data.validacao || { bloqueios: [], alertas: [] };

  const bloqueios = (val.bloqueios || []).length
    ? `<div class="vd-pv-divs">${val.bloqueios.map((b) => `<div class="vd-pv-div"><span class="pill bad">bloqueio</span> ${escapeHtml(b)}</div>`).join("")}</div>`
    : "";
  const alertas = (val.alertas || []).length
    ? `<div class="vd-pv-divs">${val.alertas.map((a) => `<div class="vd-pv-div"><span class="pill ${a.tipo === "critico" ? "bad" : "warn"}">${a.tipo === "critico" ? "atenção" : "conferir"}</span> ${escapeHtml(a.msg || a)}</div>`).join("")}</div>`
    : "";

  box.innerHTML = `
    <div class="vd-preview">
      <div class="vd-pv-titulo">Fechamento — ${escapeHtml(data.competencia?.label || "")}</div>
      <div class="bm-pv-bloco"><b>Relatório de Vendas — mês</b><div class="vd-pv-grid">
        ${item("Faturamento", vend.faturamento != null ? fmtMoeda(vend.faturamento) : "—")}
        ${item("Ticket médio", vend.ticketMedio != null ? fmtMoeda(vend.ticketMedio) : "—")}
        ${item("Quantidade de vendas", vend.quantidadeVendas ?? "—")}
        ${item("Estabelecimento", escapeHtml(vend.estabelecimento || "—"))}
      </div></div>
      <div class="bm-pv-bloco"><b>Relatório de Produtos — mês (Loja/Balcão)</b><div class="vd-pv-grid">
        ${item("Sanduíches/Saladas (base)", prod.sanduichesSaladas ?? "—")}
        ${item("Bebidas", `${prod.bebidas ?? "—"} → ${fmtPct(pct.bebidas)}`)}
        ${item("Adicionais", `${prod.adicionais ?? "—"} → ${fmtPct(pct.adicionais)}`)}
        ${item("Diversos", `${prod.diversos ?? "—"} → ${fmtPct(pct.diversos)}`)}
        ${item("Faturamento Loja", prod.faturamentoLoja != null ? fmtMoeda(prod.faturamentoLoja) : "—")}
        ${item("PPD", prod.ppd ?? "—")}
        ${item("Estabelecimento", escapeHtml(prod.estabelecimento || "—"))}
      </div></div>
      ${bloqueios}
      ${alertas}
      ${!bloqueios && !alertas ? `<div class="vd-pv-ok">✅ Nenhum bloqueio ou alerta.</div>` : ""}
    </div>`;

  const conf = m.querySelector("#bm-mensal-confirmar");
  conf.disabled = !data.prontoParaConfirmar;
}
