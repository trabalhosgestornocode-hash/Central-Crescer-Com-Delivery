// Catálogo de empresa independente DENTRO da lista de Produtos (Produtos / CMV). Não é uma tela nova.
//
// A lista de Produtos é guiada por preço/tabela comercial; produtos importados (Caramelle) ainda sem preço não apareceriam.
// Este módulo acrescenta, ao fim da MESMA tabela, os produtos com catálogo controlado (`homologacao != nao_aplicavel`) que não têm
// linha de preço no canal/tabela atual. Empresas sem catálogo controlado (Subways) não recebem nenhuma linha, filtro ou botão.
import { state } from "./state.js";
import { el, escapeHtml, fmtMoeda, fmtDataHora, toast } from "./utils.js";
import { obterFichasCatalogo, homologarFichasEmLote } from "./api.js";
import { acoesTabela } from "./actions.js";
import { registrarResetDeContexto, geracaoContexto, contextoMudou } from "./contextoEscopo.js";
import { pode } from "./sessao.js";
import { CATEGORIAS_FICHA, SITUACOES, filtrarFichas, contarPorCategoria, seloHomologacao, idsProntos, rotuloCusto } from "./fichasModelo.js";

let itens = [];        // fichas controladas da empresa (do servidor)
let carregado = false;
let carregando = false;
const filtro = { categoria: "todas", situacao: "todas" };

registrarResetDeContexto(() => { itens = []; carregado = false; carregando = false; filtro.categoria = "todas"; filtro.situacao = "todas"; });
// Qualquer alteração de ficha/produto dispara `app:reload`: o catálogo é rebuscado na próxima renderização da lista.
document.addEventListener("app:reload", () => { carregado = false; if (state.rota === "produtos" && el("#tbody")) carregarCatalogoProdutos(); });

/** Há catálogo controlado nesta empresa? */
export const temCatalogo = () => itens.length > 0;

/** Linhas do catálogo SEM preço na lista atual (já filtradas por busca e pelos filtros do catálogo). */
export function linhasCatalogoSemPreco() {
  if (!itens.length) return [];
  // Filtro por faixa de CMV não se aplica a quem não tem preço: com ele ligado, essas linhas saem (nunca aparecem como "saudável").
  if (state.filtroStatus && state.filtroStatus !== "todos") return [];
  const comPreco = new Set((state.linhas ?? []).map((r) => r.produto_id));
  const base = itens.filter((i) => !comPreco.has(i.id));
  return filtrarFichas(base, { ...filtro, busca: state.busca ?? "" }).map((i) => ({
    produto_id: i.id, nome: i.nome, categoria: i.categoria, tamanho: null, canal: null, tabela: null, preco: null,
    custo: i.custo_unitario, cmv_pct: null, lucro_liquido: null, _catalogo: i,
  }));
}

const rotuloCategoria = (c) => (c ? c[0] + c.slice(1).toLowerCase() : "—");

/** Mesma estrutura de colunas da linha de preço; o que não existe aparece como "—", nunca inventado. */
export function linhaCatalogoHtml(r, i) {
  const it = r._catalogo;
  const s = seloHomologacao(it, fmtDataHora);
  const botoes = acoesTabela().filter((a) => !(a.chave === "simular" && r.custo == null)) // sem custo confiável não há o que simular
    .map((a) => `<button class="acao-btn${a.chave === "remover" ? " acao-perigo" : ""}" data-acao="${a.chave}" data-idx="${i}" title="${a.titulo}" aria-label="${a.titulo}">${a.icon}</button>`).join("");
  return `
  <tr class="pc-linha-catalogo">
    <td>${escapeHtml(rotuloCategoria(it.categoria))}</td>
    <td>—</td><td>—</td>
    <td class="prod-nome"><button class="prod-link" data-idx="${i}">${escapeHtml(r.nome)}</button>
      <small class="muted">${it.natureza === "preparacao" ? "Preparação intermediária" : "Produto final"} · sem preço de venda</small></td>
    <td>—</td><td class="num">—</td>
    <td class="num">${r.custo == null ? '<span class="pill muted" title="Ficha incompleta: custo não exibido">indisponível</span>' : `${fmtMoeda(r.custo)}<small class="cu-un"> ${rotuloCusto(it)}</small>`}</td>
    <td class="num">—</td><td class="num">—</td>
    <td><span class="pill ${s.classe}" title="${escapeHtml(s.detalhe)}">${s.texto}</span></td>
    <td><div class="acoes">${botoes}</div></td>
  </tr>`;
}

/** Filtros e ação em lote — desenhados dentro da toolbar existente, só quando há catálogo. */
function desenharFiltros(onChange) {
  const alvo = el("#pc-filtros");
  if (!alvo) return;
  if (!itens.length) { alvo.innerHTML = ""; return; }
  const contagem = contarPorCategoria(itens, { situacao: filtro.situacao });
  const prontos = idsProntos(filtrarFichas(itens, { ...filtro, busca: state.busca ?? "" }));
  alvo.innerHTML = `
    <select id="pc-cat" aria-label="Categoria do catálogo">${CATEGORIAS_FICHA.filter((c) => c.id === "todas" || contagem[c.id]).map((c) => `<option value="${c.id}">${c.rotulo}${c.id === "todas" ? "" : ` (${contagem[c.id]})`}</option>`).join("")}</select>
    <select id="pc-sit" aria-label="Situação da ficha">${SITUACOES.map((c) => `<option value="${c.id}">${c.rotulo}</option>`).join("")}</select>
    ${pode("configuracoes.gerenciar") && prontos.length ? `<button id="pc-lote" class="btn btn-primary btn-sm">Homologar ${prontos.length} pronta${prontos.length === 1 ? "" : "s"}</button>` : ""}`;
  el("#pc-cat").value = filtro.categoria; el("#pc-sit").value = filtro.situacao;
  el("#pc-cat").addEventListener("change", (e) => { filtro.categoria = e.target.value; desenharFiltros(onChange); onChange(); });
  el("#pc-sit").addEventListener("change", (e) => { filtro.situacao = e.target.value; desenharFiltros(onChange); onChange(); });
  el("#pc-lote")?.addEventListener("click", async () => {
    const ids = idsProntos(filtrarFichas(itens, { ...filtro, busca: state.busca ?? "" }));
    if (!ids.length) return;
    if (!confirm(`Homologar ${ids.length} ficha${ids.length === 1 ? "" : "s"}?\n\nVocê confirma que conferiu ingredientes, quantidades e rendimentos. Elas passarão a valer como CMV homologado e deixam de valer se a receita ou o custo mudarem.`)) return;
    el("#pc-lote").disabled = true;
    try {
      const r = (await homologarFichasEmLote(ids)).data;
      toast(`${r.homologadas.length} homologada${r.homologadas.length === 1 ? "" : "s"}${r.recusadas.length ? ` · ${r.recusadas.length} recusada${r.recusadas.length === 1 ? "" : "s"}` : ""}.`);
      document.dispatchEvent(new CustomEvent("app:reload"));
    } catch (e) { toast(`Não foi possível homologar: ${e.message}`); el("#pc-lote") && (el("#pc-lote").disabled = false); }
  });
}

/** Busca o catálogo controlado (uma vez por contexto/recarga) e redesenha a lista. `onChange` re-renderiza só a tabela. */
export async function carregarCatalogoProdutos(onChange = () => {}) {
  if (carregado) { desenharFiltros(onChange); return; }
  if (carregando) return;
  carregando = true;
  const g = geracaoContexto();
  try {
    const r = await obterFichasCatalogo();
    if (contextoMudou(g)) return;
    itens = (r.data?.itens ?? []).filter((i) => i.homologacao !== "nao_aplicavel");
  } catch { if (!contextoMudou(g)) itens = []; }   // sem permissão/migration: a lista segue como sempre
  finally { carregando = false; }
  if (contextoMudou(g)) return;
  carregado = true;
  desenharFiltros(onChange);
  onChange();
}

export const _teste = { definir(l) { itens = l; carregado = true; }, filtro };
