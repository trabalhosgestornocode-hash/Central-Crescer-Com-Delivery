// Página FICHAS TÉCNICAS — todas as fichas da empresa (produtos finais e preparações), com custo por porção,
// pendências, homologação e acesso ao editor de ingredientes. Dados: GET /produtos/catalogo/fichas (um grafo só).
// A homologação é decisão de ADMINISTRADOR (configuracoes.gerenciar); editar rendimento exige produtos.editar.
import { state } from "./state.js";
import { el, els, fmtMoeda, fmtDataHora, escapeHtml, toast } from "./utils.js";
import {
  obterFichasCatalogo, definirHomologacaoFicha, homologarFichasEmLote, obterProduto, atualizarProduto,
} from "./api.js";
import { abrirProdutoModal } from "./produtoModal.js";
import { abrirHistoricoModal } from "./historicoModal.js";
import { registrarResetDeContexto, geracaoContexto, contextoMudou } from "./contextoEscopo.js";
import { icon } from "./icons.js";
import { pode } from "./sessao.js";
import {
  CATEGORIAS_FICHA, NATUREZAS, SITUACOES, filtrarFichas, contarPorCategoria, seloHomologacao,
  rotuloMotivo, pendenciasDoItem, rotuloCusto, idsProntos,
} from "./fichasModelo.js";

const filtros = { categoria: "todas", natureza: "todas", situacao: "todas", busca: "" };
let dados = { resumo: null, itens: [] };
let carregou = false;

registrarResetDeContexto(() => {
  dados = { resumo: null, itens: [] }; carregou = false;
  Object.assign(filtros, { categoria: "todas", natureza: "todas", situacao: "todas", busca: "" });
});

const podeHomologar = () => pode("configuracoes.gerenciar");
const podeEditar = () => pode("produtos.editar");
const card = (label, valor, classe = "", sub = "") =>
  `<div class="card ${classe}"><div class="card-label">${label}</div><div class="card-valor">${valor}</div>${sub ? `<div class="card-sub">${sub}</div>` : ""}</div>`;
const fmtQtd = (q) => Number(q).toLocaleString("pt-BR", { maximumFractionDigits: 3 });

function seloHtml(i) {
  const s = seloHomologacao(i, fmtDataHora);
  return `<span class="pill ${s.classe}" title="${escapeHtml(s.detalhe)}">${s.texto}</span>`;
}

function custoHtml(i) {
  if (i.custo_unitario == null) return '<span class="pill muted" title="Ficha incompleta: o custo não é exibido para não induzir erro.">indisponível</span>';
  const mod = i.custo_mao_de_obra_unitario;
  return `${fmtMoeda(i.custo_unitario)}<small class="cu-un"> ${rotuloCusto(i)}</small>`
    + (mod ? `<small class="ft-mod" title="Mão de obra: acompanhada à parte, não entra no CMV">+ MO ${fmtMoeda(mod)}</small>` : "");
}

function pendenciasHtml(i) {
  const { bloqueantes, avisos } = pendenciasDoItem(i);
  if (!bloqueantes.length && !avisos.length) return '<span class="muted">—</span>';
  return (bloqueantes.length ? `<span class="pill bad" title="Impedem a homologação">${bloqueantes.length} a corrigir</span> ` : "")
    + (avisos.length ? `<span class="pill warn" title="Para conferir">${avisos.length} aviso${avisos.length > 1 ? "s" : ""}</span>` : "");
}

export async function renderFichas() {
  const g = geracaoContexto();
  el("#view").innerHTML = `
    <div class="cards" id="ft-cards">${card("Fichas", "…")}${card("Prontas para homologar", "…")}${card("Homologadas", "…")}${card("Incompletas", "…")}</div>
    <p class="ft-ajuda">Aqui estão os produtos finais (o que você vende) e as preparações (recheios, cremes e massas usados em outras receitas).
      O <b>custo por porção</b> é o custo dos ingredientes e embalagens dividido pelo rendimento da receita; a <b>mão de obra</b> aparece à parte e não entra no CMV.
      Uma ficha só vale como <b>homologada</b> depois da conferência de um administrador, e deixa de valer se a receita ou o custo mudarem.</p>
    <div class="ft-abas" id="ft-abas" role="tablist" aria-label="Categorias"></div>
    <div class="toolbar">
      <div class="busca"><input id="ft-busca" type="search" placeholder="Buscar ficha pelo nome..." value="${escapeHtml(filtros.busca)}" aria-label="Buscar ficha" /></div>
      <select id="ft-natureza" aria-label="Tipo">${NATUREZAS.map((n) => `<option value="${n.id}">${n.rotulo}</option>`).join("")}</select>
      <select id="ft-situacao" aria-label="Situação">${SITUACOES.map((n) => `<option value="${n.id}">${n.rotulo}</option>`).join("")}</select>
      <button id="ft-atualizar" class="btn btn-ghost btn-sm">${icon("refresh", { size: 14 })} Atualizar</button>
      <button id="ft-lote" class="btn btn-primary btn-sm" hidden></button>
      <span class="result-count" id="ft-count"></span>
    </div>
    <div class="tabela-wrap" id="ft-tabela"><div class="estado-mini">Carregando fichas…</div></div>`;
  el("#ft-natureza").value = filtros.natureza;
  el("#ft-situacao").value = filtros.situacao;
  ligarFiltros();
  await carregar(g);
}

async function carregar(g = geracaoContexto()) {
  try {
    const r = await obterFichasCatalogo();
    if (contextoMudou(g) || state.rota !== "fichas") return;
    dados = r.data; carregou = true;
    desenhar();
  } catch (e) {
    if (contextoMudou(g)) return;
    const t = el("#ft-tabela");
    if (t) t.innerHTML = `<div class="estado-mini erro">Não foi possível carregar as fichas: ${escapeHtml(e.message)}</div>`;
  }
}

function ligarFiltros() {
  let t;
  el("#ft-busca").addEventListener("input", (e) => { filtros.busca = e.target.value; clearTimeout(t); t = setTimeout(desenhar, 150); });
  el("#ft-natureza").addEventListener("change", (e) => { filtros.natureza = e.target.value; desenhar(); });
  el("#ft-situacao").addEventListener("change", (e) => { filtros.situacao = e.target.value; desenhar(); });
  el("#ft-atualizar").addEventListener("click", () => carregar());
  el("#ft-lote").addEventListener("click", homologarProntas);
}

function desenhar() {
  if (!el("#ft-tabela") || !carregou) return;
  const r = dados.resumo ?? {};
  el("#ft-cards").innerHTML = card("Fichas", r.total ?? 0, "", `${r.produtos_finais ?? 0} produtos · ${r.preparacoes ?? 0} preparações`)
    + card("Prontas para homologar", r.prontas_para_homologar ?? 0, "ok")
    + card("Homologadas", r.homologadas ?? 0)
    + card("Incompletas", r.incompletas ?? 0, r.incompletas ? "bad" : "");
  const contagem = contarPorCategoria(dados.itens, filtros);
  const abas = CATEGORIAS_FICHA.filter((c) => c.id === "todas" || contagem[c.id]);
  el("#ft-abas").innerHTML = abas.map((c) =>
    `<button type="button" role="tab" class="ft-aba ${filtros.categoria === c.id ? "ativa" : ""}" data-cat="${c.id}" aria-selected="${filtros.categoria === c.id}">${c.rotulo} <span class="ft-aba-n">${contagem[c.id] ?? 0}</span></button>`).join("");
  els(".ft-aba").forEach((b) => b.addEventListener("click", () => { filtros.categoria = b.dataset.cat; desenhar(); }));

  const lista = filtrarFichas(dados.itens, filtros);
  el("#ft-count").textContent = `${lista.length} ficha${lista.length === 1 ? "" : "s"}`;
  const prontos = idsProntos(lista);
  const lote = el("#ft-lote");
  lote.hidden = !(podeHomologar() && prontos.length);
  lote.textContent = `Homologar ${prontos.length} pronta${prontos.length === 1 ? "" : "s"} da lista`;

  if (!dados.itens.length) {
    el("#ft-tabela").innerHTML = `<div class="estado-mini">Nenhuma ficha cadastrada para esta empresa ainda.</div>`;
    return;
  }
  if (!lista.length) { el("#ft-tabela").innerHTML = `<div class="estado-mini">Nenhuma ficha com esses filtros.</div>`; return; }
  el("#ft-tabela").innerHTML = `<table class="grid ft-grid"><thead><tr>
      <th>Ficha</th><th>Categoria</th><th class="num">Rendimento</th><th class="num">Custo</th><th>Pendências</th><th>Homologação</th><th>Ações</th>
    </tr></thead><tbody>${lista.map((i) => `
      <tr data-id="${i.id}" class="ft-linha">
        <td><b>${escapeHtml(i.nome)}</b><br><small class="muted">${i.natureza === "preparacao" ? "Preparação" : "Produto final"} · ${i.qtd_componentes} ingrediente${i.qtd_componentes === 1 ? "" : "s"}</small></td>
        <td>${i.categoria ? escapeHtml(i.categoria[0] + i.categoria.slice(1).toLowerCase()) : "—"}</td>
        <td class="num">${fmtQtd(i.rendimento)}${i.unidade_rendimento ? ` <small>${escapeHtml(i.unidade_rendimento)}</small>` : ""}</td>
        <td class="num">${custoHtml(i)}</td>
        <td>${pendenciasHtml(i)}</td>
        <td>${seloHtml(i)}</td>
        <td><button class="btn btn-ghost btn-sm" data-abrir="${i.id}">Abrir ficha</button></td>
      </tr>`).join("")}</tbody></table>`;
  els("[data-abrir]").forEach((b) => b.addEventListener("click", (ev) => { ev.stopPropagation(); abrirDetalhe(b.dataset.abrir); }));
  els(".ft-linha").forEach((tr) => tr.addEventListener("click", () => abrirDetalhe(tr.dataset.id)));
}

async function homologarProntas() {
  const ids = idsProntos(filtrarFichas(dados.itens, filtros));
  if (!ids.length) return;
  if (!confirm(`Homologar ${ids.length} ficha${ids.length === 1 ? "" : "s"}?\n\nVocê confirma que conferiu os ingredientes, quantidades e rendimentos. Elas passarão a valer como CMV homologado e deixam de valer se a receita ou o custo mudarem.`)) return;
  const btn = el("#ft-lote"); btn.disabled = true;
  try {
    const r = (await homologarFichasEmLote(ids)).data;
    toast(`${r.homologadas.length} homologada${r.homologadas.length === 1 ? "" : "s"}${r.recusadas.length ? ` · ${r.recusadas.length} recusada${r.recusadas.length === 1 ? "" : "s"} (incompletas)` : ""}.`);
    await carregar();
  } catch (e) { toast(`Não foi possível homologar: ${e.message}`); } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------------------------
// Detalhe da ficha
// ---------------------------------------------------------------------------------------------
let overlay = null;
function fechar() { overlay?.remove(); overlay = null; document.removeEventListener("keydown", onKey); }
function onKey(e) { if (e.key === "Escape") fechar(); }

async function abrirDetalhe(id) {
  const item = dados.itens.find((i) => i.id === id);
  if (!item) return;
  fechar();
  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal modal-ficha" role="dialog" aria-modal="true" aria-label="Ficha técnica"></div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) fechar(); });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKey);
  await desenharDetalhe(item);
}

async function desenharDetalhe(item) {
  const m = overlay?.querySelector(".modal");
  if (!m) return;
  const s = seloHomologacao(item, fmtDataHora);
  const { bloqueantes, avisos } = pendenciasDoItem(item);
  const motivo = item.homologacao === "pendente" && item.homologacao_motivo ? rotuloMotivo(item.homologacao_motivo) : "";
  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>${escapeHtml(item.nome)}</h2>
      <div class="modal-tags"><span class="chip">${item.natureza === "preparacao" ? "Preparação" : "Produto final"}</span>${item.categoria ? `<span class="chip">${escapeHtml(item.categoria[0] + item.categoria.slice(1).toLowerCase())}</span>` : ""}<span class="pill ${s.classe}">${s.texto}</span></div></div>

    <section class="ft-bloco">
      <h3>Custo</h3>
      <div class="ft-kpis">
        <div><span>Custo ${rotuloCusto(item)}</span><b>${item.custo_unitario == null ? "indisponível" : fmtMoeda(item.custo_unitario)}</b></div>
        <div><span>Rendimento</span><b>${fmtQtd(item.rendimento)}${item.unidade_rendimento ? " " + escapeHtml(item.unidade_rendimento) : ""}</b></div>
        <div title="Acompanhada à parte. Não entra no CMV."><span>Mão de obra ${rotuloCusto(item)}</span><b>${item.custo_mao_de_obra_unitario == null ? "—" : fmtMoeda(item.custo_mao_de_obra_unitario)}</b></div>
      </div>
      ${item.custo_unitario == null ? '<p class="ft-aviso">Ficha incompleta: o custo não é exibido para não induzir a erro. Corrija as pendências abaixo.</p>' : ""}
      ${podeEditar() ? `<div class="ft-rend"><label>Rendimento da receita <input id="ft-rend" type="number" min="0.001" step="any" value="${item.rendimento}" /></label>
        ${item.natureza === "preparacao" ? `<label>Unidade <select id="ft-rend-un">${["", "g", "ml", "un", "kg", "l"].map((u) => `<option value="${u}" ${u === (item.unidade_rendimento ?? "") ? "selected" : ""}>${u || "—"}</option>`).join("")}</select></label>` : ""}
        <button id="ft-rend-salvar" class="btn btn-ghost btn-sm">Salvar rendimento</button>
        <small class="muted">Alterar o rendimento muda o custo e invalida a homologação.</small></div>` : ""}
    </section>

    ${item.natureza === "produto_final" ? `<section class="ft-bloco">
      <h3>Vínculo com o iFood</h3>
      <p class="muted">O <b>código do PDV</b> é o mesmo código que o item tem no cardápio do iFood. É por ele que o Dashboard calcula o CMV teórico do que foi vendido. Cada produto precisa de um código próprio.</p>
      <div class="ft-rend"><label>Código do PDV <input id="ft-pdv" maxlength="60" value="${escapeHtml(item.codigo_pdv ?? "")}" placeholder="ex.: CAP-001" ${podeEditar() ? "" : "disabled"} /></label>
        ${podeEditar() ? '<button id="ft-pdv-salvar" class="btn btn-ghost btn-sm">Salvar código</button>' : ""}
        <small class="muted">${item.codigo_pdv ? "Vinculado." : "Sem código: o vínculo só acontece se o nome do item no iFood for idêntico e único."}</small></div>
    </section>` : ""}

    <section class="ft-bloco">
      <h3>Homologação</h3>
      <p>${escapeHtml(s.detalhe)}${motivo && s.classe !== "bad" ? "" : ""}</p>
      ${item.homologacao === "pendente" && motivo ? `<p class="ft-aviso">${escapeHtml(motivo)}</p>` : ""}
      <div class="ft-acoes">
        ${podeHomologar() && item.pode_homologar ? `<button id="ft-homologar" class="btn btn-primary btn-sm">Homologar esta ficha</button>` : ""}
        ${podeHomologar() && item.homologacao === "homologada" ? `<button id="ft-reabrir" class="btn btn-ghost btn-sm">Reabrir homologação</button>` : ""}
        ${!podeHomologar() && item.pode_homologar ? `<small class="muted">Somente um administrador pode homologar.</small>` : ""}
      </div>
    </section>

    <section class="ft-bloco">
      <h3>Pendências ${bloqueantes.length + avisos.length ? `(${bloqueantes.length + avisos.length})` : ""}</h3>
      ${!bloqueantes.length && !avisos.length ? '<p class="muted">Nenhuma pendência registrada.</p>' : `<ul class="ft-pend">
        ${bloqueantes.map((p) => `<li class="bad"><b>${escapeHtml(p.texto)}</b>${p.detalhe ? `<small>${escapeHtml(p.detalhe)}</small>` : ""}<em>${escapeHtml(p.acao)}</em></li>`).join("")}
        ${avisos.map((p) => `<li class="warn">${escapeHtml(p.texto)}${p.detalhe ? `<small>${escapeHtml(p.detalhe)}</small>` : ""}<em>${escapeHtml(p.acao)}</em></li>`).join("")}</ul>`}
    </section>

    <section class="ft-bloco"><h3>Ingredientes</h3><div id="ft-ficha"><div class="estado-mini">Carregando…</div></div>
      <div class="ft-acoes">
        <button id="ft-editar" class="btn btn-ghost btn-sm">${podeEditar() ? "Editar ingredientes e quantidades" : "Ver ficha completa"}</button>
        <button id="ft-historico" class="btn btn-ghost btn-sm">Histórico de alterações</button>
      </div>
    </section>`;
  m.querySelector(".modal-close").addEventListener("click", fechar);
  m.querySelector("#ft-editar").addEventListener("click", () => { fechar(); abrirProdutoModal(item.id); });
  m.querySelector("#ft-historico").addEventListener("click", () => abrirHistoricoModal(item.id, item.nome));
  m.querySelector("#ft-homologar")?.addEventListener("click", () => acaoHomologacao(item, "homologar"));
  m.querySelector("#ft-reabrir")?.addEventListener("click", () => acaoHomologacao(item, "reabrir"));
  m.querySelector("#ft-rend-salvar")?.addEventListener("click", () => salvarRendimento(item, m));
  m.querySelector("#ft-pdv-salvar")?.addEventListener("click", () => salvarCodigoPdv(item, m));
  carregarIngredientes(item, m);
}

async function carregarIngredientes(item, m) {
  const alvo = m.querySelector("#ft-ficha");
  try {
    const p = (await obterProduto(item.id)).data;
    if (!overlay || !alvo.isConnected) return;
    const linhas = (p.ficha ?? []).filter((c) => c.ativo !== false);
    alvo.innerHTML = !linhas.length ? '<p class="muted">Nenhum ingrediente na ficha.</p>' : `<table class="grid ft-ing"><thead><tr><th>Item</th><th class="num">Quantidade</th><th class="num">Custo do item</th></tr></thead><tbody>
      ${linhas.map((c) => `<tr><td>${escapeHtml(c.nome)}${c.tipo === "submontagem" ? ' <span class="chip">preparação</span>' : ""}</td>
        <td class="num">${fmtQtd(c.quantidade)} ${escapeHtml(c.unidade ?? "")}</td>
        <td class="num">${c.custo_aplicado == null ? '<span class="pill muted">sem custo</span>' : fmtMoeda(c.custo_aplicado)}</td></tr>`).join("")}</tbody></table>
      <small class="muted">Custo do lote inteiro. O custo por porção divide pelo rendimento (${fmtQtd(item.rendimento)}).</small>`;
  } catch (e) { if (alvo.isConnected) alvo.innerHTML = `<p class="estado-mini erro">${escapeHtml(e.message)}</p>`; }
}

async function acaoHomologacao(item, acao) {
  const texto = acao === "homologar"
    ? `Homologar "${item.nome}"?\n\nVocê confirma que conferiu ingredientes, quantidades e rendimento. A homologação deixa de valer se a receita ou o custo mudarem.`
    : `Reabrir a homologação de "${item.nome}"? O CMV desta ficha deixa de ser considerado homologado.`;
  if (!confirm(texto)) return;
  try {
    await definirHomologacaoFicha(item.id, acao);
    toast(acao === "homologar" ? "Ficha homologada." : "Homologação reaberta.");
    await carregar();
    const novo = dados.itens.find((i) => i.id === item.id);
    if (novo && overlay) await desenharDetalhe(novo);
  } catch (e) { toast(`Não foi possível concluir: ${e.message}`); }
}

async function salvarCodigoPdv(item, m) {
  const codigo = m.querySelector("#ft-pdv").value.trim();
  try {
    await atualizarProduto(item.id, { codigo_pdv: codigo || null });
    toast(codigo ? "Código do PDV salvo." : "Vínculo removido.");
    await carregar();
    const novo = dados.itens.find((i) => i.id === item.id);
    if (novo && overlay) await desenharDetalhe(novo);
  } catch (e) { toast(`Não foi possível salvar: ${e.message}`); }
}

async function salvarRendimento(item, m) {
  const rend = Number(m.querySelector("#ft-rend").value);
  if (!(rend > 0)) { toast("Informe um rendimento maior que zero."); return; }
  const un = m.querySelector("#ft-rend-un")?.value;
  const corpo = { rendimento: rend, ...(un !== undefined ? { unidade_rendimento: un || null } : {}) };
  if (item.homologacao === "homologada" && !confirm("Esta ficha está homologada. Alterar o rendimento muda o custo e a homologação será invalidada. Continuar?")) return;
  try {
    await atualizarProduto(item.id, corpo);
    toast("Rendimento atualizado.");
    await carregar();
    const novo = dados.itens.find((i) => i.id === item.id);
    if (novo && overlay) await desenharDetalhe(novo);
  } catch (e) { toast(`Não foi possível salvar: ${e.message}`); }
}

// Depois de editar ingredientes no editor existente, o app dispara `app:reload`: recarrega a lista se esta página estiver aberta.
document.addEventListener("app:reload", () => { if (state.rota === "fichas" && el("#ft-tabela")) carregar(); });
