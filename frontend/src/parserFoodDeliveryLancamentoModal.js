// Modais da camada de ajustes operacionais do Parser Food Delivery
// (migration 079):
//   - abrirLancamentoModal   -> taxa adicional / avulso / entrega manual
//                               (criar e editar). Autocomplete de entregador
//                               reusa o MESMO endpoint do cadastro mestre.
//   - abrirEntregadoresModal -> CRUD do cadastro mestre + reconhecimento
//                               progressivo dos nomes do histórico iFood.
// Zero emoji; ícones via icon(); mesma malha visual dos outros modais.
import { el, escapeHtml, toast, fmtMoeda } from "./utils.js";
import { icon } from "./icons.js";
import {
  pfdEntregadores, pfdEntregadorCriar, pfdEntregadorEditar, pfdEntregadoresSugestoes, pfdEntregadoresReconhecer,
  pfdLancamentoCriar, pfdLancamentoEditar,
} from "./api.js";
import { registrarResetDeContexto } from "./contextoEscopo.js";

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

const hoje = () => new Date(new Date().toLocaleDateString("sv-SE", { timeZone: "America/Fortaleza" }));
const isoHoje = () => hoje().toISOString().slice(0, 10);
const TITULO = { taxa_adicional: "Adicionar taxa de entregador", avulso: "Novo lançamento avulso", manual: "Nova entrega" };

// ---------------------------------------------------------------------------
// ENTREGADOR — campo com autocomplete a partir do cadastro mestre.
// ---------------------------------------------------------------------------
async function carregarEntregadores() {
  try { const { data } = await pfdEntregadores(false); return data || []; }
  catch { return []; }
}

function campoEntregador(id, { valorId = null, valorNome = "" } = {}) {
  return `
    <label class="cfg-campo">
      <span>Entregador *</span>
      <input type="text" id="${id}-input" list="${id}-list" autocomplete="off" placeholder="Nome do entregador" value="${escapeHtml(valorNome)}">
      <datalist id="${id}-list"></datalist>
      <input type="hidden" id="${id}-id" value="${valorId || ""}">
      <em id="${id}-hint" class="cfg-campo-hint"></em>
    </label>`;
}

function ligarCampoEntregador(m, id, entregadores, onEstado) {
  const input = m.querySelector(`#${id}-input`);
  const list = m.querySelector(`#${id}-list`);
  const hidden = m.querySelector(`#${id}-id`);
  const hint = m.querySelector(`#${id}-hint`);
  list.innerHTML = entregadores.map((e) => `<option value="${escapeHtml(e.nome)}"></option>`).join("");
  const casar = () => {
    const nome = input.value.trim().toLowerCase();
    const match = entregadores.find((e) => e.nome.trim().toLowerCase() === nome);
    hidden.value = match ? match.id : "";
    if (!input.value.trim()) { hint.textContent = ""; onEstado?.({ ok: false }); return; }
    if (match) { hint.textContent = ""; onEstado?.({ ok: true, novo: false }); }
    else { hint.textContent = `"${input.value.trim()}" ainda não está cadastrado — será criado ao salvar.`; onEstado?.({ ok: true, novo: true }); }
  };
  input.addEventListener("input", casar);
  casar();
  return {
    payload() {
      const idv = hidden.value;
      return idv ? { entregadorId: idv } : { entregadorNome: input.value.trim(), criarEntregador: true };
    },
    valido() { return !!input.value.trim(); },
  };
}

// ---------------------------------------------------------------------------
// LANÇAMENTO — criar/editar (taxa_adicional | avulso | manual)
// ---------------------------------------------------------------------------
export async function abrirLancamentoModal({ modo, pedido = null, lancamento = null, catalogos = null, dataSugerida = null, onSalvo }) {
  const editar = !!lancamento;
  const m = overlay(`
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>${icon(modo === "avulso" ? "plus" : "banknote", { size: 18 })} ${escapeHtml(editar ? "Editar lançamento" : (TITULO[modo] || "Lançamento"))}</h2></div>
    <div class="pfd-lanc-corpo"><div class="estado"><div class="spinner"></div>Carregando…</div></div>`);
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);

  const entregadores = await carregarEntregadores();
  if (!ov) return;

  const motivos = modo === "taxa_adicional" ? (catalogos?.motivosTaxaAdicional || [])
    : modo === "avulso" ? (catalogos?.motivosAvulso || []) : [];
  const pedInfo = pedido || (lancamento && lancamento.numeroPedido ? { numeroPedido: lancamento.numeroPedido, id: lancamento.pedidoId, taxaEntregador: null } : null);
  const l = lancamento || {};

  const corpo = m.querySelector(".pfd-lanc-corpo");
  corpo.innerHTML = `
    <div class="cfg-form-grid">
      ${modo === "taxa_adicional" ? `
        <label class="cfg-campo"><span>Pedido</span>
          <input type="text" value="${escapeHtml(pedInfo?.numeroPedido || "—")}" disabled>
        </label>` : ""}
      ${campoEntregador("pfd-lanc-entr", { valorId: l.entregadorId, valorNome: l.entregadorNome || "" })}
      <label class="cfg-campo"><span>Valor (R$) *</span>
        <input type="number" id="pfd-lanc-valor" min="0" step="0.01" value="${l.valor != null ? l.valor : ""}" placeholder="0,00">
      </label>
      <label class="cfg-campo"><span>Data *</span>
        <input type="date" id="pfd-lanc-data" max="${isoHoje()}" value="${escapeHtml(l.data || dataSugerida || isoHoje())}">
      </label>
      <label class="cfg-campo"><span>Horário</span>
        <input type="time" id="pfd-lanc-hora" value="${escapeHtml((l.hora || "").slice(0, 5))}">
      </label>
      ${motivos.length ? `
        <label class="cfg-campo"><span>Motivo *</span>
          <select id="pfd-lanc-motivo">
            <option value="">Selecione…</option>
            ${motivos.map((mo) => `<option value="${mo.valor}" ${l.motivo === mo.valor ? "selected" : ""}>${escapeHtml(mo.rotulo)}</option>`).join("")}
          </select>
        </label>
        <label class="cfg-campo" id="pfd-lanc-motivo-desc-wrap" ${l.motivo === "outro" ? "" : "hidden"}><span>Descrição do motivo *</span>
          <input type="text" id="pfd-lanc-motivo-desc" maxlength="500" value="${escapeHtml(l.motivoDescricao || "")}">
        </label>` : ""}
      ${modo === "manual" ? `
        <label class="cfg-campo"><span>Situação</span>
          <input type="text" id="pfd-lanc-situacao" maxlength="80" value="${escapeHtml(l.situacao || "")}" placeholder="ex.: Entregue">
        </label>
        <label class="cfg-campo"><span>Classificação</span>
          <select id="pfd-lanc-classificacao">
            <option value="">—</option>
            <option value="recebe_taxa" ${l.classificacao === "recebe_taxa" ? "selected" : ""}>Recebe taxa</option>
            <option value="nao_recebe_taxa" ${l.classificacao === "nao_recebe_taxa" ? "selected" : ""}>Não recebe taxa</option>
          </select>
        </label>
        <label class="cfg-campo"><span>Código do pedido (se houver)</span>
          <input type="text" id="pfd-lanc-numped" maxlength="60" value="${escapeHtml(l.numeroPedido || "")}">
        </label>` : ""}
      <label class="cfg-campo cfg-campo--full"><span>Observação${modo === "avulso" ? "" : ""}</span>
        <textarea id="pfd-lanc-obs" maxlength="1000" rows="2">${escapeHtml(l.observacao || "")}</textarea>
      </label>
    </div>
    <div class="vd-imp-msg" id="pfd-lanc-msg" hidden></div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="pfd-lanc-cancelar">Cancelar</button>
      <button class="btn btn-primary" id="pfd-lanc-salvar">${editar ? "Salvar alterações" : "Salvar"}</button>
    </div>`;

  const campoEntr = ligarCampoEntregador(m, "pfd-lanc-entr", entregadores);
  m.querySelector("#pfd-lanc-cancelar").addEventListener("click", fecharOverlay);
  const motivoSel = m.querySelector("#pfd-lanc-motivo");
  motivoSel?.addEventListener("change", () => {
    const wrap = m.querySelector("#pfd-lanc-motivo-desc-wrap");
    if (wrap) wrap.hidden = motivoSel.value !== "outro";
  });

  m.querySelector("#pfd-lanc-salvar").addEventListener("click", async () => {
    const msg = m.querySelector("#pfd-lanc-msg");
    const setMsg = (t) => { msg.hidden = false; msg.className = "vd-imp-msg erro"; msg.textContent = t; };
    const valor = Number(m.querySelector("#pfd-lanc-valor").value);
    if (!campoEntr.valido()) return setMsg("Informe o entregador.");
    if (!Number.isFinite(valor) || valor < 0) return setMsg("Informe um valor válido.");
    const obs = m.querySelector("#pfd-lanc-obs").value.trim();
    if (valor === 0 && !obs) return setMsg("Valor R$ 0,00 só é aceito com uma justificativa na observação.");
    const motivo = motivoSel ? motivoSel.value : undefined;
    if (motivos.length && !motivo) return setMsg("Selecione o motivo.");
    const motivoDescricao = m.querySelector("#pfd-lanc-motivo-desc")?.value.trim() || undefined;
    if (motivo === "outro" && !motivoDescricao) return setMsg("Descreva o motivo.");

    const payload = {
      origem: modo, ...campoEntr.payload(),
      valor, data: m.querySelector("#pfd-lanc-data").value,
      hora: m.querySelector("#pfd-lanc-hora").value || undefined,
      motivo, motivoDescricao, observacao: obs || undefined,
    };
    if (modo === "taxa_adicional") payload.pedidoId = pedInfo?.id || l.pedidoId;
    if (modo === "manual") {
      payload.situacao = m.querySelector("#pfd-lanc-situacao")?.value.trim() || undefined;
      payload.classificacao = m.querySelector("#pfd-lanc-classificacao")?.value || undefined;
      payload.numeroPedido = m.querySelector("#pfd-lanc-numped")?.value.trim() || undefined;
    }

    const btn = m.querySelector("#pfd-lanc-salvar");
    btn.disabled = true; btn.textContent = "Salvando…";
    try {
      if (editar) await pfdLancamentoEditar(l.id, payload);
      else await pfdLancamentoCriar(payload);
      fecharOverlay();
      await onSalvo?.();
    } catch (e) {
      setMsg("Erro: " + e.message);
      btn.disabled = false; btn.textContent = editar ? "Salvar alterações" : "Salvar";
    }
  });
}

// ---------------------------------------------------------------------------
// ENTREGADORES — cadastro mestre + reconhecimento do histórico.
// ---------------------------------------------------------------------------
export async function abrirEntregadoresModal({ onMudou } = {}) {
  const m = overlay(`
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>${icon("users", { size: 18 })} Entregadores da unidade</h2></div>
    <div class="pfd-entr-corpo"><div class="estado"><div class="spinner"></div>Carregando…</div></div>`);
  m.classList.add("pfd-modal--wide");
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  let mudou = false;
  const fechar = () => { fecharOverlay(); if (mudou) onMudou?.(); };
  m.querySelector(".modal-close").onclick = fechar;

  async function render() {
    const corpo = m.querySelector(".pfd-entr-corpo");
    let entregadores = [];
    let sugestoes = [];
    try { entregadores = (await pfdEntregadores(true)).data || []; } catch { /* segue vazio */ }
    try { sugestoes = (await pfdEntregadoresSugestoes()).data || []; } catch { /* opcional */ }
    if (!ov) return;

    corpo.innerHTML = `
      <div class="ed-acoes" style="margin-bottom:10px">
        <input type="text" id="pfd-entr-novo" placeholder="Nome do novo entregador" style="flex:1">
        <button class="btn btn-primary btn-sm" id="pfd-entr-add">${icon("plus", { size: 13 })} Cadastrar</button>
      </div>
      <div class="tabela-wrap"><table class="grid">
        <thead><tr><th>Nome</th><th>Origem</th><th>Status</th><th></th></tr></thead>
        <tbody>${entregadores.length ? entregadores.map((e) => `
          <tr class="${e.ativo ? "" : "pfd-linha-excluida"}">
            <td>${escapeHtml(e.nome)}</td>
            <td>${e.origemCadastro === "reconhecido_ifood" ? "Reconhecido" : "Manual"}</td>
            <td>${e.ativo ? `<span class="pill ok">Ativo</span>` : `<span class="pill muted">Inativo</span>`}</td>
            <td class="num"><button class="btn btn-ghost btn-sm" data-toggle="${e.id}" data-ativo="${e.ativo}">${e.ativo ? "Inativar" : "Reativar"}</button></td>
          </tr>`).join("") : `<tr><td colspan="4" class="dex-diag-vazio">Nenhum entregador cadastrado ainda.</td></tr>`}</tbody>
      </table></div>
      ${sugestoes.length ? `
        <div class="bm-drawer-bloco" style="margin-top:14px">
          <div class="vd-pv-titulo">${icon("refresh", { size: 13 })} Nomes encontrados no histórico do iFood (ainda não cadastrados)</div>
          <p class="dex-diag-vazio">Marque quem deve virar entregador cadastrado — os pedidos que casam serão vinculados.</p>
          <div class="pfd-sugestoes">${sugestoes.map((s, i) => `
            <label class="pfd-sugestao"><input type="checkbox" data-sug="${i}" value="${escapeHtml(s.nome)}"> ${escapeHtml(s.nome)} <span class="pfd-mini-tag">${s.pedidos} ped.</span></label>`).join("")}</div>
          <button class="btn btn-ghost btn-sm" id="pfd-entr-reconhecer" style="margin-top:8px">Reconhecer selecionados</button>
        </div>` : ""}
      <div class="ed-acoes"><button class="btn btn-ghost" id="pfd-entr-fechar">Fechar</button></div>`;

    m.querySelector("#pfd-entr-fechar").addEventListener("click", fechar);
    m.querySelector("#pfd-entr-add").addEventListener("click", async () => {
      const nome = m.querySelector("#pfd-entr-novo").value.trim();
      if (nome.length < 2) { toast("Informe um nome com ao menos 2 caracteres."); return; }
      try { await pfdEntregadorCriar(nome); mudou = true; toast("Entregador cadastrado."); render(); }
      catch (e) { toast("Erro: " + e.message); }
    });
    m.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", async () => {
      try { await pfdEntregadorEditar(b.dataset.toggle, { ativo: b.dataset.ativo !== "true" }); mudou = true; render(); }
      catch (e) { toast("Erro: " + e.message); }
    }));
    m.querySelector("#pfd-entr-reconhecer")?.addEventListener("click", async () => {
      const nomes = [...m.querySelectorAll("[data-sug]:checked")].map((c) => c.value);
      if (!nomes.length) { toast("Selecione ao menos um nome."); return; }
      try { const { data } = await pfdEntregadoresReconhecer(nomes); mudou = true; toast(`${data.total} entregador(es) reconhecido(s).`); render(); }
      catch (e) { toast("Erro: " + e.message); }
    });
  }
  render();
}
