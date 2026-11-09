// Modal de detalhe do produto: visão geral + FICHA TÉCNICA EDITÁVEL + preços/CMV.
// A ficha referencia os insumos cadastrados; o backend recalcula custo e CMV a
// cada alteração e devolve o produto já atualizado (nunca custo desconectado).
import {
  obterProduto, listarInsumos, listarPreparacoes, obterCondicoesComerciais,
  adicionarComponente, atualizarComponente, removerComponente,
} from "./api.js";
import { topoCatalogoHtml, formacaoCatalogoHtml, margensCatalogoHtml, ligarCatalogo } from "./produtoCatalogo.js";
import { state } from "./state.js";
import { UNIDADES_BASE, CATEGORIA_INSUMO_ROTULO } from "./config.js";
import { fmtMoeda, fmtPct, fmtTexto, escapeHtml, statusCmv, toast } from "./utils.js";
import { registrarResetDeContexto } from "./contextoEscopo.js";
import { icon } from "./icons.js";
import { botaoContextualHtml, ligarBotoesContextuais, sincronizarContextoPainel } from "./agentePainel.js";

const CAT_LABEL = {
  sanduiche: "Sanduíche", salada: "Salada", bebida: "Bebida", sobremesa: "Sobremesa",
  chips: "Chips", adicional: "Adicional", acompanhamento: "Acompanhamento",
  combo: "Combo", submontagem: "Submontagem", outro: "Outro",
};
const CANAL_LABEL = { balcao: "Balcão", ifood: "iFood", uber: "Uber", app: "App", outro: "Outro" };
const catLabel = (t) => CAT_LABEL[t] || fmtTexto(t);
const canalLabel = (c) => CANAL_LABEL[c] || fmtTexto(c);
const catInsumo = (c) => CATEGORIA_INSUMO_ROTULO[c] ?? (c ? fmtTexto(c) : "—");
const podeEditar = () => (state.sessao?.permissoes ?? []).includes("produtos.editar");

function fmtQtd(q, un) {
  const n = Number(q);
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + " " + (un || "un");
}

let overlay = null;
let insumosCache = null; // lista de insumos ativos (para o seletor)
let condicoesAtuais = null; // condições comerciais da empresa (só carregadas para produtos com catálogo controlado)
function fechar() {
  overlay?.remove(); overlay = null; insumosCache = null; preparacoesCache = null; condicoesAtuais = null;
  document.removeEventListener("keydown", onKey);
  // "produto aberto" deixou de existir — Page Context do Agente Crescer volta pra "lista".
  state.detalheAberto.produto = null;
  sincronizarContextoPainel();
}
function onKey(e) { if (e.key === "Escape") fechar(); }

// Trocar de empresa/unidade com o modal aberto fecha o modal e joga fora o
// cache de insumos: o seletor da ficha técnica não pode oferecer insumos da
// empresa anterior (seria um vínculo salvo no catálogo errado).
registrarResetDeContexto(fechar);

export async function abrirProdutoModal(produtoId) {
  fechar();
  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal"><div class="estado"><div class="spinner"></div>Carregando ficha técnica…</div></div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) fechar(); });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKey);

  try {
    const { data } = await obterProduto(produtoId);
    // Catálogo controlado (importado/independente): a margem usa as condições comerciais DA empresa. Subways não pagam esta chamada.
    if (data.controlado) condicoesAtuais = await obterCondicoesComerciais().then((r) => r.data ?? null).catch(() => null);
    render(data);
  } catch (e) {
    overlay.querySelector(".modal").innerHTML =
      `<button class="modal-close" aria-label="Fechar">×</button><div class="estado erro"><span class="estado-ic">${icon("alert-triangle", { size: 22 })}</span><h3>Erro ao carregar</h3><p>${escapeHtml(e.message)}</p></div>`;
    overlay.querySelector(".modal-close").addEventListener("click", fechar);
  }
}

/**
 * Abre o produto pelo NOME — usada pela action "product_detail" do Agente
 * Crescer (Etapa F.1). Nunca recebe um id do Claude: procura na lista de
 * CMV já carregada (`state.linhas`, a MESMA que alimenta a tela Produtos/
 * CMV) e só então chama `abrirProdutoModal` com o id real encontrado. Se o
 * nome não bater com nada carregado, avisa e não abre nada — nunca inventa
 * um produto.
 * @param {string} nome
 */
export async function abrirProdutoPorNome(nome) {
  const alvo = String(nome ?? "").trim().toLowerCase();
  if (!alvo) return;
  const linha = (state.linhas ?? []).find((r) => String(r.nome ?? "").trim().toLowerCase() === alvo)
    ?? (state.linhas ?? []).find((r) => String(r.nome ?? "").trim().toLowerCase().includes(alvo));
  if (!linha?.produto_id) {
    toast(`Não encontrei "${nome}" na lista de produtos carregada.`);
    return;
  }
  await abrirProdutoModal(linha.produto_id);
}

const STATUS_CLASSE = { completa: "ok", sem_componentes: "muted", insumo_sem_custo: "bad", insumo_inativo: "warn", sem_preco: "warn" };

function render(p) {
  const editar = podeEditar();
  const st = p.status_ficha ?? { chave: "sem_componentes", label: "—" };
  const precoRef = (p.precos ?? []).map((x) => Number(x.preco)).filter((n) => n > 0).sort((a, b) => a - b)[0] ?? null;
  const margemR = precoRef != null ? precoRef - Number(p.custo) : null;
  const margemP = precoRef != null && precoRef > 0 ? (margemR / precoRef) * 100 : null;

  const fichaRows = (p.ficha ?? []).length
    ? p.ficha.map((c) => linhaFicha(c, editar, p.controlado)).join("")
    : `<tr><td colspan="${editar ? 7 : 6}"><div class="estado"><span class="estado-ic">${icon("clipboard-list", { size: 22 })}</span><p>Ficha vazia. ${editar ? "Adicione o primeiro insumo abaixo." : "Nenhum componente cadastrado."}</p></div></td></tr>`;

  const precoRows = (p.precos ?? []).length
    ? p.precos.map((pr) => {
        const cmv = st.chave === "insumo_sem_custo" ? null : (pr.preco > 0 ? (Number(p.custo) / Number(pr.preco)) * 100 : null);
        const s = statusCmv(cmv);
        return `<tr>
          <td>${canalLabel(pr.canal)}</td>
          <td>${fmtTexto(pr.tabela)}</td>
          <td class="num">${fmtMoeda(pr.preco)}${pr.desatualizado ? ' <span class="badge">2024</span>' : ""}</td>
          <td class="num"><span class="pill ${s.classe}">${cmv == null ? "—" : fmtPct(cmv)}</span></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="4"><div class="estado"><p>Sem preços cadastrados.</p></div></td></tr>`;

  overlay.querySelector(".modal").innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head">
      <h2>${escapeHtml(p.nome)}</h2>
      <div class="modal-tags">
        ${p.tamanho ? `<span class="chip">${escapeHtml(p.tamanho)}</span>` : ""}
        <span class="chip">${catLabel(p.tipo)}</span>
        ${p.controlado && p.catalogo?.categoria ? `<span class="chip">${escapeHtml(p.catalogo.categoria[0] + p.catalogo.categoria.slice(1).toLowerCase())}</span>` : ""}
        ${p.controlado ? `<span class="chip">${p.catalogo?.natureza === "preparacao" ? "Preparação intermediária" : "Produto final"}</span>` : ""}
        ${p.ativo ? "" : '<span class="pill muted">Inativo</span>'}
        <span class="pill ${STATUS_CLASSE[st.chave] ?? "muted"}">${escapeHtml(st.label)}</span>
      </div>
      ${botaoContextualHtml("products_cmv_produto")}
    </div>
    ${p.controlado ? topoCatalogoHtml(p) : ""}

    <div class="modal-cmv-grid">
      <div class="modal-custo"><span>${p.controlado ? "Custo unitário" : "Custo total"}</span><strong>${fmtMoeda(p.custo)}</strong></div>
      <div class="modal-custo"><span>Componentes</span><strong>${p.qtd_componentes ?? 0}</strong></div>
      <div class="modal-custo"><span title="${p.controlado ? "Preço menos custo, sem comissão e demais deduções. A margem de contribuição por canal está mais abaixo." : ""}">${p.controlado ? "Margem bruta (menor preço)" : "Margem (menor preço)"}</span><strong>${margemR == null ? "—" : fmtMoeda(margemR)}${margemP == null ? "" : ` <small>(${fmtPct(margemP)})</small>`}</strong></div>
    </div>
    ${st.chave === "insumo_sem_custo" ? `<div class="banner-erro">Não é possível calcular o CMV: há insumo sem custo na ficha. Defina o preço do insumo pendente.</div>` : ""}

    <div class="modal-sec-titulo">${icon("receipt", { size: 14 })} Ficha técnica</div>
    <div class="tabela-wrap">
      <table class="grid grid-modal">
        <thead><tr><th>Insumo</th><th>Categoria</th><th class="num">Qtd</th><th>Un.</th><th class="num">Custo/un-base</th><th class="num">Custo aplicado</th>${editar ? "<th>Ações</th>" : ""}</tr></thead>
        <tbody id="pm-ficha">${fichaRows}</tbody>
      </table>
    </div>
    ${editar ? `<div id="pm-add-area"><button class="btn btn-ghost btn-sm" id="pm-add-btn">${icon("plus", { size: 13 })} Adicionar insumo</button>${p.controlado ? ` <button class="btn btn-ghost btn-sm" id="pm-addprep-btn">${icon("plus", { size: 13 })} Adicionar preparação</button>` : ""}</div>` : ""}
    ${p.controlado ? formacaoCatalogoHtml(p) : ""}

    <div class="modal-sec-titulo">${icon("banknote", { size: 14 })} Preços por canal · CMV</div>
    <div class="tabela-wrap">
      <table class="grid grid-modal">
        <thead><tr><th>Canal</th><th>Tabela</th><th class="num">Preço</th><th class="num">CMV</th></tr></thead>
        <tbody>${precoRows}</tbody>
      </table>
    </div>
    <p class="rodape">CMV = custo da ficha ÷ preço de venda. Não inclui taxas de canal (mostradas no simulador).</p>
    ${p.controlado ? margensCatalogoHtml(p, condicoesAtuais) : ""}
  `;

  // "produto aberto" pro Page Context do Agente Crescer — só o NOME, nunca
  // custo/preço/id (ver state.js#detalheAberto). Atualiza mesmo em
  // re-renders (após editar a ficha): o nome não muda, é idempotente.
  state.detalheAberto.produto = p.nome;
  sincronizarContextoPainel();

  const m = overlay.querySelector(".modal");
  m.querySelector(".modal-close").addEventListener("click", fechar);
  ligarBotoesContextuais(m);
  if (p.controlado) {
    ligarCatalogo(m, p, { condicoes: condicoesAtuais, recarregar: async () => { const { data } = await obterProduto(p.id); render(data); } });
  }
  if (editar) {
    m.querySelector("#pm-add-btn")?.addEventListener("click", () => abrirAddForm(p));
    m.querySelector("#pm-addprep-btn")?.addEventListener("click", () => abrirAddPrepForm(p));
    m.querySelectorAll("[data-ficha-acao]").forEach((btn) =>
      btn.addEventListener("click", () => fichaAcao(btn.dataset.fichaAcao, btn.dataset.fichaId, p)));
  }
}

function linhaFicha(c, editar, controlado = false) {
  const custoUn = c.custo_unitario_base == null ? '<span class="pill muted">sem custo</span>' : fmtMoeda(c.custo_unitario_base);
  const custoAp = c.custo_aplicado == null ? '<span class="pill bad">pendente</span>' : fmtMoeda(c.custo_aplicado);
  const acoes = c.tipo === "insumo" || controlado
    ? `<button class="acao-btn" data-ficha-acao="editar" data-ficha-id="${c.ficha_id}" title="Editar" aria-label="Editar componente">${icon("pencil", { size: 14 })}</button>
       <button class="acao-btn" data-ficha-acao="remover" data-ficha-id="${c.ficha_id}" title="Remover da ficha" aria-label="Remover da ficha">${icon("trash", { size: 14 })}</button>`
    : `<span class="cu-cod">submontagem</span>`;
  return `<tr class="${c.insumo_ativo ? "" : "linha-inativa"}">
    <td>${escapeHtml(c.nome)}${c.insumo_ativo ? "" : ' <span class="pill warn">inativo</span>'}</td>
    <td>${catInsumo(c.categoria)}</td>
    <td class="num">${Number(c.quantidade).toLocaleString("pt-BR", { maximumFractionDigits: 3 })}</td>
    <td>${escapeHtml(c.unidade || "un")}</td>
    <td class="num">${custoUn}</td>
    <td class="num">${custoAp}</td>
    ${editar ? `<td><div class="acoes">${acoes}</div></td>` : ""}
  </tr>`;
}

// ---------- Ações de linha ----------
async function fichaAcao(acao, fichaId, p) {
  if (acao === "remover") {
    if (!confirm("Remover este insumo da ficha? O insumo continua cadastrado na unidade.")) return;
    try {
      const { data } = await removerComponente(p.id, fichaId);
      toast(`Componente removido. Custo recalculado.`);
      render(data.produto);
      document.dispatchEvent(new CustomEvent("app:reload"));
    } catch (e) { toast("Erro: " + e.message); }
    return;
  }
  if (acao === "editar") {
    const c = (p.ficha ?? []).find((x) => x.ficha_id === fichaId);
    if (c) abrirEditForm(p, c);
  }
}

// ---------- Editar quantidade/unidade de um componente ----------
function abrirEditForm(p, c) {
  const linha = overlay.querySelector(`[data-ficha-id="${c.ficha_id}"]`)?.closest("tr");
  if (!linha) return;
  const colspan = podeEditar() ? 7 : 6;
  linha.innerHTML = `<td colspan="${colspan}">
    <div class="pm-editrow">
      <b>${escapeHtml(c.nome)}</b>
      <label>Qtd <input type="number" id="pm-q" min="0" step="0.001" value="${Number(c.quantidade)}" /></label>
      <label>Un. <select id="pm-u">${(c.tipo === "insumo" ? UNIDADES_BASE : UNIDADES_BASE.filter(([v]) => v === c.unidade)).map(([v, l]) => `<option value="${v}" ${v === c.unidade ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <span id="pm-prev" class="pm-prev"></span>
      <button class="btn btn-primary btn-sm" id="pm-save">Salvar</button>
      <button class="btn btn-ghost btn-sm" id="pm-cancel">Cancelar</button>
    </div>
    <div class="ed-erro" id="pm-eerr" hidden></div>
  </td>`;

  const q = linha.querySelector("#pm-q");
  const u = linha.querySelector("#pm-u");
  const prev = linha.querySelector("#pm-prev");
  const atualizar = () => {
    const base = c.custo_unitario_base;
    if (base == null) { prev.textContent = "insumo sem custo"; return; }
    // prévia: converte para a unidade-base do insumo e multiplica
    const val = Number(q.value);
    prev.textContent = Number.isFinite(val) ? "≈ " + fmtMoeda(estimar(base, val, u.value, c.unidade_base)) : "";
  };
  q.addEventListener("input", atualizar);
  u.addEventListener("change", atualizar);
  atualizar();

  linha.querySelector("#pm-cancel").addEventListener("click", () => render(p));
  linha.querySelector("#pm-save").addEventListener("click", async () => {
    const err = linha.querySelector("#pm-eerr");
    try {
      const { data } = await atualizarComponente(p.id, c.ficha_id, { quantidade: q.value, unidade: u.value });
      toast("Componente atualizado. Custo recalculado.");
      render(data.produto);
      document.dispatchEvent(new CustomEvent("app:reload"));
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
}

// Estimativa de custo (mesma lógica do backend) só para prévia visual.
const FATOR = { g: 1, kg: 1000, ml: 1, l: 1000, un: 1, fatia: 1, porcao: 1, folha: 1 };
const DIM = { g: "m", kg: "m", ml: "v", l: "v", un: "u", fatia: "f", porcao: "p", folha: "h" };
function estimar(custoBase, qtd, unUso, unBase) {
  if (DIM[unUso] !== DIM[unBase]) return NaN;
  const qtdBase = (qtd * (FATOR[unUso] ?? 1)) / (FATOR[unBase] ?? 1);
  return qtdBase * custoBase;
}

// ---------- Adicionar PREPARAÇÃO intermediária à receita (catálogo controlado) ----------
// Mesma área e mesmo editor do "Adicionar insumo". Só preparações da própria empresa (a API também garante isso e recusa ciclos).
let preparacoesCache = null;
async function abrirAddPrepForm(p) {
  const area = overlay.querySelector("#pm-add-area");
  if (!area) return;
  area.innerHTML = `<div class="estado-mini">Carregando preparações…</div>`;
  try {
    if (!preparacoesCache) {
      const { data } = await listarPreparacoes();
      preparacoesCache = (data ?? []).filter((x) => x.vendavel === false);
    }
  } catch (e) { area.innerHTML = `<div class="ed-erro">Erro: ${escapeHtml(e.message)}</div>`; return; }

  const jaNaFicha = new Set((p.ficha ?? []).filter((c) => c.tipo === "submontagem").map((c) => c.subproduto_id));
  const lista = preparacoesCache.filter((x) => x.id !== p.id);
  if (!lista.length) {
    area.innerHTML = `<div class="estado-mini">Nenhuma preparação intermediária cadastrada nesta empresa.</div><button class="btn btn-ghost btn-sm" id="pm-p-cancel">Fechar</button>`;
    area.querySelector("#pm-p-cancel").addEventListener("click", () => render(p));
    return;
  }
  const opcoes = lista.map((x) => `<option value="${x.id}" ${jaNaFicha.has(x.id) ? "disabled" : ""}>${escapeHtml(x.nome)}${x.unidade_rendimento ? ` (${x.unidade_rendimento})` : ""}${jaNaFicha.has(x.id) ? " (já na receita)" : ""}</option>`).join("");
  area.innerHTML = `
    <div class="pm-addbox">
      <div class="pm-editrow">
        <label>Preparação <select id="pm-p-sel"><option value="">Selecione…</option>${opcoes}</select></label>
        <label>Qtd usada <input type="number" id="pm-p-q" min="0" step="0.001" placeholder="ex: 100" /></label>
        <label>Un. <select id="pm-p-u"></select></label>
        <span id="pm-p-prev" class="pm-prev"></span>
      </div>
      <p class="muted pm-p-ajuda">A quantidade é na unidade em que a preparação rende. O custo usa o custo unitário da preparação (custo do lote ÷ rendimento).</p>
      <div class="ed-erro" id="pm-p-err" hidden></div>
      <div class="ed-acoes">
        <button class="btn btn-ghost btn-sm" id="pm-p-cancel">Cancelar</button>
        <button class="btn btn-primary btn-sm" id="pm-p-add">Adicionar à receita</button>
      </div>
    </div>`;
  const sel = area.querySelector("#pm-p-sel"); const uSel = area.querySelector("#pm-p-u");
  const qInp = area.querySelector("#pm-p-q"); const prev = area.querySelector("#pm-p-prev");
  const atual = () => lista.find((x) => x.id === sel.value);
  const unidades = () => {
    const base = atual()?.unidade_rendimento ?? "un";
    const compat = UNIDADES_BASE.filter(([v]) => DIM[v] === DIM[base]);
    uSel.innerHTML = (compat.length ? compat : [[base, base]]).map(([v]) => `<option value="${v}" ${v === base ? "selected" : ""}>${v}</option>`).join("");
  };
  const previa = () => {
    const x = atual(); if (!x) { prev.textContent = ""; return; }
    if (x.custo_cache == null || Number(x.custo_cache) <= 0) { prev.textContent = "preparação sem custo"; return; }
    const val = Number(qInp.value);
    prev.textContent = Number.isFinite(val) && val > 0 ? "custo aplicado ≈ " + fmtMoeda(estimar(Number(x.custo_cache), val, uSel.value, x.unidade_rendimento ?? "un")) : "";
  };
  sel.addEventListener("change", () => { unidades(); previa(); });
  uSel.addEventListener("change", previa); qInp.addEventListener("input", previa);
  unidades();
  area.querySelector("#pm-p-cancel").addEventListener("click", () => render(p));
  area.querySelector("#pm-p-add").addEventListener("click", async () => {
    const err = area.querySelector("#pm-p-err");
    if (!sel.value) { err.textContent = "Selecione uma preparação."; err.hidden = false; return; }
    try {
      const { data } = await adicionarComponente(p.id, { subproduto_id: sel.value, quantidade: qInp.value, unidade: uSel.value });
      toast("Preparação adicionada. Custo recalculado; a homologação, se houver, foi invalidada.");
      render(data.produto);
      document.dispatchEvent(new CustomEvent("app:reload"));
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
}

// ---------- Adicionar insumo à ficha ----------
async function abrirAddForm(p) {
  const area = overlay.querySelector("#pm-add-area");
  if (!area) return;
  area.innerHTML = `<div class="estado-mini">Carregando insumos…</div>`;
  try {
    if (!insumosCache) {
      const { data } = await listarInsumos({ status: "ativo" });
      insumosCache = (data.itens ?? []).filter((i) => i.ativo);
    }
  } catch (e) { area.innerHTML = `<div class="ed-erro">Erro: ${escapeHtml(e.message)}</div>`; return; }

  if (!insumosCache.length) {
    area.innerHTML = `<div class="estado-mini">Nenhum insumo ativo. Cadastre insumos na aba Insumos primeiro.</div>
      <button class="btn btn-ghost btn-sm" id="pm-add-cancel">Fechar</button>`;
    area.querySelector("#pm-add-cancel").addEventListener("click", () => render(p));
    return;
  }

  const jaNaFicha = new Set((p.ficha ?? []).filter((c) => c.tipo === "insumo").map((c) => c.insumo_id));
  const opcoes = insumosCache.map((i) => `<option value="${i.id}" ${jaNaFicha.has(i.id) ? "disabled" : ""}>${escapeHtml(i.nome)}${jaNaFicha.has(i.id) ? " (já na ficha)" : ""}</option>`).join("");

  area.innerHTML = `
    <div class="pm-addbox">
      <div class="pm-editrow">
        <label>Insumo <select id="pm-a-insumo"><option value="">Selecione…</option>${opcoes}</select></label>
        <label>Qtd usada <input type="number" id="pm-a-q" min="0" step="0.001" placeholder="ex: 76" /></label>
        <label>Un. <select id="pm-a-u"></select></label>
        <span id="pm-a-prev" class="pm-prev"></span>
      </div>
      <div class="ed-erro" id="pm-a-err" hidden></div>
      <div class="ed-acoes">
        <button class="btn btn-ghost btn-sm" id="pm-a-cancel">Cancelar</button>
        <button class="btn btn-primary btn-sm" id="pm-a-add">Adicionar à ficha</button>
      </div>
    </div>`;

  const sel = area.querySelector("#pm-a-insumo");
  const uSel = area.querySelector("#pm-a-u");
  const qInp = area.querySelector("#pm-a-q");
  const prev = area.querySelector("#pm-a-prev");

  const insumoAtual = () => insumosCache.find((i) => i.id === sel.value);
  const preencherUnidades = () => {
    const ins = insumoAtual();
    // Só oferece unidades compatíveis com a unidade-base do insumo.
    const base = ins?.unidade_base ?? "un";
    const compat = UNIDADES_BASE.filter(([v]) => DIM[v] === DIM[base]);
    const lista = compat.length ? compat : UNIDADES_BASE.filter(([v]) => v === base);
    uSel.innerHTML = lista.map(([v, l]) => `<option value="${v}" ${v === base ? "selected" : ""}>${v}</option>`).join("");
  };
  const atualizarPrev = () => {
    const ins = insumoAtual();
    if (!ins) { prev.textContent = ""; return; }
    if (ins.custo_unitario == null) { prev.textContent = "insumo sem custo"; return; }
    const val = Number(qInp.value);
    prev.textContent = Number.isFinite(val) && val > 0 ? "custo aplicado ≈ " + fmtMoeda(estimar(ins.custo_unitario, val, uSel.value, ins.unidade_base)) : "";
  };
  sel.addEventListener("change", () => { preencherUnidades(); atualizarPrev(); });
  uSel.addEventListener("change", atualizarPrev);
  qInp.addEventListener("input", atualizarPrev);
  preencherUnidades();

  area.querySelector("#pm-a-cancel").addEventListener("click", () => render(p));
  area.querySelector("#pm-a-add").addEventListener("click", async () => {
    const err = area.querySelector("#pm-a-err");
    if (!sel.value) { err.textContent = "Selecione um insumo."; err.hidden = false; return; }
    try {
      const { data } = await adicionarComponente(p.id, { insumo_id: sel.value, quantidade: qInp.value, unidade: uSel.value });
      toast(`Insumo adicionado. Custo recalculado.`);
      render(data.produto);
      document.dispatchEvent(new CustomEvent("app:reload"));
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
}
