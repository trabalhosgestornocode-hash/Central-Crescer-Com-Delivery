// Produtos / CMV 2.0 — área de trabalho do módulo (Visão geral, Produtos, Preparações, Insumos, Central de pendências,
// Precificação) + página da ficha + assistente + revisão de rendimentos + custo zero + homologação em lote.
// Ativada por empresa/unidade pelo módulo `products_cmv_v2` (o legado segue intacto para quem não tem o módulo).
// Nenhum cálculo de custo aqui: tudo vem do motor no backend.

import { el, escapeHtml, toast, fmtDataHora } from "./utils.js";
import { pode } from "./sessao.js";
import {
  cmv2Saude, cmv2Pendencias, cmv2PreviaRendimentos, cmv2AplicarRendimentos, cmv2PreviaCustoZero, cmv2DefinirCustoZero,
  cmv2Rascunhos, cmv2SalvarRascunho, cmv2Rascunho, cmv2PreviaHomologacao, cmv2HomologarLote, cmv2CriarFicha,
  cmv2Recuperacao, cmv2Simular, cmv2DefinirPreco, cmv2ValidarAproveitamento, obterHistoricoProduto, listarInsumos,
  atualizarProduto, adicionarComponente, listarPreparacoes,
} from "./api.js";
import {
  AREAS, SITUACAO, CRITICIDADE_ROTULO, CONFIANCA_ROTULO, ETAPA_ROTULO, NATUREZA, moeda, numero, pct, unidadeRend,
  segmentosSituacao, fraseSaude, filtrarProdutos, filtrarCausas, ajudaEtapa, progressoEtapas, leituraSimulacao,
} from "./produtosCmv2Modelo.js";

const E = escapeHtml;
const st = { area: "visao", saude: null, pend: null, filtros: { busca: "", situacao: "todas", criticidade: "todas", codigo: "todos" }, ficha: null, rascunhos: [] };
const podeEditar = () => pode("produtos.editar");
const podeHomologar = () => pode("configuracoes.gerenciar");

const chip = (situacao) => { const s = SITUACAO[situacao] ?? SITUACAO.rascunho; return `<span class="c2-chip c2-${s.tom}">${E(s.rotulo)}</span>`; };
const crit = (c) => `<span class="c2-crit c2-crit-${c}">${E(CRITICIDADE_ROTULO[c] ?? c)}</span>`;
const esqueleto = (n = 4) => `<div class="c2-esqueleto" aria-busy="true" aria-label="Carregando">${'<div class="c2-esq-linha"></div>'.repeat(n)}</div>`;
const erroHtml = (e) => `<div class="c2-erro" role="alert"><strong>Não foi possível carregar.</strong> ${E(e?.message ?? "")} <button class="c2-btn c2-btn-sec" data-acao="recarregar">Tentar de novo</button></div>`;

export async function renderProdutosCmv2() {
  const view = el("#view");
  view.innerHTML = `<div class="c2" id="c2">
    <nav class="c2-nav" aria-label="Áreas de Produtos / CMV">${AREAS.map((a) => `<button class="c2-nav-item" data-area="${a.id}" aria-current="${a.id === st.area ? "page" : "false"}">${E(a.rotulo)}</button>`).join("")}</nav>
    <main class="c2-conteudo" id="c2-conteudo" tabindex="-1">${esqueleto(6)}</main>
  </div>`;
  view.querySelector(".c2-nav").addEventListener("click", (ev) => { const b = ev.target.closest("[data-area]"); if (b) irArea(b.dataset.area); });
  view.querySelector("#c2").addEventListener("click", aoClicar); // #c2 é recriado a cada abertura: sem listeners duplicados
  await carregarBase();
  pintar();
}

async function carregarBase(forcar = false) {
  if (st.saude && st.pend && !forcar) return;
  try {
    [st.saude, st.pend, st.rascunhos] = await Promise.all([cmv2Saude(), cmv2Pendencias(), cmv2Rascunhos().catch(() => [])]);
    st.erro = null;
  } catch (e) { st.erro = e; }
}

function irArea(area) {
  st.area = area; st.ficha = null;
  for (const b of document.querySelectorAll(".c2-nav-item")) b.setAttribute("aria-current", b.dataset.area === area ? "page" : "false");
  pintar();
  el("#c2-conteudo")?.focus({ preventScroll: true });
}

function pintar() {
  const c = el("#c2-conteudo"); if (!c) return;
  if (st.erro) { c.innerHTML = erroHtml(st.erro); return; }
  const fn = { visao: telaVisao, produtos: () => telaLista("final"), preparacoes: () => telaLista("preparacao"), insumos: telaInsumos, pendencias: telaPendencias, precificacao: telaPrecificacao }[st.area];
  const r = fn();
  if (r instanceof Promise) { c.innerHTML = esqueleto(5); r.then((html) => { if (html != null) c.innerHTML = html; }); } else c.innerHTML = r;
}

// ================================================================== VISÃO GERAL
function telaVisao() {
  const s = st.saude; const r = s.resumo; const f = fraseSaude(s);
  const total = r.produtos_finais + r.preparacoes;
  if (!total) return estadoVazio(s.perfil);
  const seg = segmentosSituacao(r.por_situacao);
  const franquia = s.perfil.modelo === "franquia_padronizada";
  const dims = [
    ["Receita completa", s.dimensoes.receita_completa, "Todos os componentes e o rendimento informados."],
    ["Custo confiável", s.dimensoes.custo_confiavel, "Sem erro de unidade, insumo sem custo ou preparação comprometida."],
    ["Com preço comercial", s.precos.com_preco, "Preço praticado informado em ao menos um canal."],
    ["CMV % disponível", s.dimensoes.cmv_disponivel, "Custo confiável e preço comercial."],
    ["Rentabilidade disponível", s.dimensoes.rentabilidade_disponivel, "Exige também as condições comerciais do canal (comissões e taxas)."],
  ];
  return `
  <header class="c2-hero">
    <h1 class="c2-hero-titulo">${E(f.titulo)}</h1>
    <p class="c2-hero-sub">${E(f.sub)}</p>
    <div class="c2-barra" role="img" aria-label="${E(seg.map((x) => `${x.qtd} ${x.rotulo}`).join(", "))}">
      ${seg.map((x) => `<span class="c2-barra-seg c2-bg-${x.tom}" style="flex:${x.qtd}" title="${E(`${x.qtd} ${x.rotulo}`)}"></span>`).join("")}
    </div>
    <ul class="c2-legenda">${seg.map((x) => `<li><span class="c2-ponto c2-bg-${x.tom}"></span>${x.qtd} ${E(x.rotulo.toLocaleLowerCase("pt-BR"))}</li>`).join("")}</ul>
    ${franquia ? "" : `<p class="c2-nota">Sem pendências não significa homologada: ${r.homologadas} homologada(s) e ${r.elegiveis_homologacao} pronta(s) para revisão.</p>`}
  </header>

  <section class="c2-secao" aria-labelledby="c2-dim">
    <h2 id="c2-dim" class="c2-h2">O que cada ficha já permite calcular</h2>
    <ol class="c2-escada">${dims.map(([t, n, d]) => `<li><span class="c2-escada-n">${n}</span><span class="c2-escada-t">${E(t)}</span><span class="c2-escada-d">${E(d)}</span></li>`).join("")}</ol>
    ${s.precos.com_preco === 0 && !franquia ? `<p class="c2-aviso">Nenhum preço de venda cadastrado nesta unidade. As fichas podem ser concluídas mesmo assim, mas o CMV % e as margens só aparecem depois que os preços praticados forem informados (Precificação).</p>` : ""}
  </section>

  ${s.causas_raiz.length ? `<section class="c2-secao" aria-labelledby="c2-causas">
    <div class="c2-secao-topo"><h2 id="c2-causas" class="c2-h2">Corrija uma vez, resolva vários produtos</h2><button class="c2-link" data-area-ir="pendencias">Ver todas as pendências</button></div>
    <ul class="c2-causas">${s.causas_raiz.slice(0, 5).map(linhaCausa).join("")}</ul>
  </section>` : `<section class="c2-secao"><p class="c2-ok-msg">Nenhuma causa-raiz pendente.${franquia ? (r.por_situacao.incompleta ? ` ${r.por_situacao.incompleta} item(ns) sem ficha cadastrada aparecem em Produtos.` : "") : " Revise as fichas e homologue para oficializar o CMV."}</p></section>`}

  <section class="c2-secao c2-duas">
    <div><h2 class="c2-h2">Insumos</h2><p class="c2-dado"><strong>${r.insumos}</strong> cadastrados · <strong>${r.insumos_sem_custo}</strong> sem custo · <strong>${r.insumos_custo_zero_declarado}</strong> com custo zero declarado</p>
      <p class="c2-dado-sec">Última atualização de preço: ${s.ultima_atualizacao_custo ? E(fmtDataHora(s.ultima_atualizacao_custo)) : "não registrada"}</p></div>
    <div><h2 class="c2-h2">Evolução das correções</h2>${s.evolucao_correcoes.length ? `<ul class="c2-evol">${s.evolucao_correcoes.map((m) => `<li><span>${E(m.mes)}</span><span class="c2-evol-barra" style="--w:${Math.min(100, m.correcoes * 5)}%"></span><span>${m.correcoes}</span></li>`).join("")}</ul>` : `<p class="c2-dado-sec">As correções feitas por aqui (rendimentos, custo zero) aparecem mês a mês.</p>`}</div>
  </section>
  ${!franquia && podeHomologar() ? `<section class="c2-secao"><button class="c2-btn" data-acao="homologacao">Revisar e homologar fichas</button> <button class="c2-btn c2-btn-sec" data-acao="nova-ficha">Nova ficha técnica</button></section>` : ""}`;
}

function linhaCausa(c) {
  const acao = c.codigo === "insumo_sem_custo" ? `<button class="c2-btn c2-btn-sec" data-acao="custo-zero" data-id="${E(c.alvo.id)}">Resolver insumo</button>`
    : c.codigo.startsWith("rendimento") ? `<button class="c2-btn c2-btn-sec" data-acao="rendimentos">Revisar rendimento</button>`
      : `<button class="c2-btn c2-btn-sec" data-acao="abrir-ficha" data-id="${E(c.alvo?.id ?? "")}">Abrir ficha</button>`;
  // Rendimento: a frase concreta (valor cadastrado × massa) diz mais que a descrição genérica.
  const frase = c.detalhe?.rendimento != null
    ? `Rende ${numero(c.detalhe.rendimento, 3)} ${E(c.detalhe.unidade ?? "")} com ${numero(c.detalhe.massa_componentes, 0)} ${E(c.detalhe.unidade ?? "")} de ingredientes.${c.detalhe.sugestao ? ` Provável ${numero(c.detalhe.sugestao, 0)} ${E(c.detalhe.unidade)}.` : " Exige pesagem do lote."}`
    : E(c.problema);
  return `<li class="c2-causa">
    <div class="c2-causa-cab">${crit(c.criticidade)}<strong>${E(c.nome)}</strong><span class="c2-causa-imp">${c.qtd_impactados} produto(s) afetado(s)</span></div>
    <p class="c2-causa-p">${frase}</p>
    <details class="c2-detalhe"><summary>Por que importa e como corrigir</summary><p><strong>Impacto:</strong> ${E(c.impacto)}</p><p><strong>Como corrigir:</strong> ${E(c.correcao)}</p><p><strong>Onde:</strong> ${E(c.onde)}</p></details>
    <div class="c2-causa-acao">${acao}</div></li>`;
}

function estadoVazio(perfil) {
  return `<div class="c2-vazio">
    <h1 class="c2-hero-titulo">Esta unidade ainda não tem fichas técnicas</h1>
    <p class="c2-hero-sub">A ficha técnica diz quanto custa cada produto. Comece pelo que mais vende — ou pela preparação usada em mais produtos (massa, arroz, base).</p>
    <ol class="c2-passos">
      <li><strong>Cadastre os insumos</strong> com o preço e o tamanho da embalagem de compra (ex.: arroz 5 kg por R$ 32,90).</li>
      <li><strong>Monte as preparações</strong> e pese o lote pronto para informar o rendimento.</li>
      <li><strong>Monte os produtos</strong> usando insumos e preparações, e informe o preço de venda de cada canal.</li>
    </ol>
    ${perfil?.recursos?.assistente_receitas !== false && podeEditar() ? `<button class="c2-btn" data-acao="nova-ficha">Criar a primeira ficha</button>` : ""}
    <p class="c2-nota">Outra unidade da mesma empresa já tem catálogo? A cópia assistida entre unidades autorizadas pode ser feita pela equipe da mentoria — os custos e preços não são copiados automaticamente.</p>
  </div>`;
}

// ================================================================== LISTAS
function telaLista(tipo) {
  const prep = tipo === "preparacao";
  const itens = filtrarProdutos(st.pend.produtos, { busca: st.filtros.busca, situacao: st.filtros.situacao, tipo });
  const todos = st.pend.produtos.filter((p) => (prep ? p.tipo === "submontagem" : p.tipo !== "submontagem"));
  const sits = [...new Set(todos.map((p) => p.situacao))];
  return `
  <header class="c2-topo"><div><h1 class="c2-h1">${prep ? "Preparações intermediárias" : "Produtos"}</h1>
    <p class="c2-dado-sec">${prep ? "Massas, recheios, bases e molhos feitos na casa e usados em outros produtos. Não exigem preço de venda." : "Itens vendidos no cardápio."}</p></div>
    ${podeEditar() && st.saude.perfil.recursos.assistente_receitas ? `<button class="c2-btn" data-acao="nova-ficha" data-natureza="${prep ? "preparacao" : "produto_final"}">Nova ${prep ? "preparação" : "ficha"}</button>` : ""}
  </header>
  <div class="c2-filtros" role="search">
    <label class="c2-campo"><span>Buscar</span><input type="search" id="c2-busca" value="${E(st.filtros.busca)}" placeholder="Nome do ${prep ? "preparo" : "produto"}" /></label>
    <label class="c2-campo"><span>Situação</span><select id="c2-sit"><option value="todas">Todas (${todos.length})</option>${sits.map((s) => `<option value="${s}" ${st.filtros.situacao === s ? "selected" : ""}>${E(SITUACAO[s]?.rotulo ?? s)} (${todos.filter((p) => p.situacao === s).length})</option>`).join("")}</select></label>
  </div>
  ${rascunhosHtml(prep)}
  ${itens.length ? `<ul class="c2-lista">${itens.map((p) => `<li><button class="c2-linha" data-acao="abrir-ficha" data-id="${E(p.id)}">
      <span class="c2-linha-nome">${E(p.nome)}</span>${chip(p.situacao)}
      <span class="c2-linha-info">${p.pendencias.filter((x) => x.codigo !== "sem_preco_venda").length ? `${p.pendencias.filter((x) => x.codigo !== "sem_preco_venda").length} pendência(s)` : prep ? `rende ${numero(p.rendimento, 3)} ${E(unidadeRend(p.unidade_rendimento, p.rendimento))}` : p.pendencias.some((x) => x.codigo === "sem_preco_venda") ? "sem preço de venda" : "pronta"}</span>
    </button></li>`).join("")}</ul>` : `<p class="c2-vazio-curto">Nenhum item com esses filtros.</p>`}`;
}

function rascunhosHtml(prep) {
  const rs = (st.rascunhos ?? []).filter((r) => !r.produto_id && (prep ? r.natureza === "preparacao" : r.natureza !== "preparacao"));
  if (!rs.length) return "";
  return `<div class="c2-rascunhos"><h2 class="c2-h3">Rascunhos para continuar</h2><ul>${rs.map((r) => `<li><button class="c2-link" data-acao="retomar" data-id="${E(r.id)}">${E(r.identificacao?.nome || "Sem nome")} — parou em ${E(ETAPA_ROTULO[r.etapa] ?? r.etapa)}</button></li>`).join("")}</ul></div>`;
}

// ================================================================== INSUMOS
async function telaInsumos() {
  let insumos;
  try { insumos = await listarInsumos({}); } catch (e) { return erroHtml(e); }
  const lista = Array.isArray(insumos) ? insumos : insumos?.data ?? insumos?.itens ?? [];
  const raiz = new Map(st.pend.causas_raiz.filter((c) => c.codigo === "insumo_sem_custo").map((c) => [c.alvo.id, c]));
  const nat = (i) => (i.custo_zero_declarado ? "zero" : Number(i.preco_unitario) > 0 ? "ok" : "desconhecido");
  const ordenado = [...lista].sort((a, b) => (raiz.get(b.id)?.qtd_impactados ?? -1) - (raiz.get(a.id)?.qtd_impactados ?? -1) || String(a.nome).localeCompare(String(b.nome)));
  return `<header class="c2-topo"><div><h1 class="c2-h1">Insumos e embalagens</h1>
    <p class="c2-dado-sec">O custo de cada ficha nasce aqui: preço de compra ÷ quantidade da embalagem. Corrigir um insumo recalcula todos os produtos que o usam.</p></div>
    <button class="c2-btn c2-btn-sec" data-acao="cadastro-insumos">Abrir cadastro completo</button></header>
  <dl class="c2-legenda-custo"><div><dt><span class="c2-tag c2-tag-ok">Informado</span></dt><dd>preço de aquisição cadastrado</dd></div>
    <div><dt><span class="c2-tag c2-tag-zero">Zero declarado</span></dt><dd>decisão registrada, com motivo e responsável</dd></div>
    <div><dt><span class="c2-tag c2-tag-bad">Desconhecido</span></dt><dd>sem preço — a ficha fica incompleta (o sistema não presume zero)</dd></div></dl>
  <ul class="c2-lista">${ordenado.slice(0, 400).map((i) => {
    const r = raiz.get(i.id); const n = nat(i);
    return `<li class="c2-linha c2-linha-estatica"><span class="c2-linha-nome">${E(i.nome)}</span>
      <span class="c2-tag ${n === "ok" ? "c2-tag-ok" : n === "zero" ? "c2-tag-zero" : "c2-tag-bad"}">${n === "ok" ? moeda(i.preco_unitario, { unidade: i.unidade_medida }) : n === "zero" ? "Zero declarado" : "Desconhecido"}</span>
      <span class="c2-linha-info">${r ? `trava ${r.qtd_impactados} produto(s)` : i.tipo === "embalagem" ? "embalagem" : ""}</span>
      ${(n !== "ok" || i.custo_zero_declarado) ? `<button class="c2-btn c2-btn-sec c2-btn-p" data-acao="custo-zero" data-id="${E(i.id)}">${i.custo_zero_declarado ? "Revisar" : "Resolver"}</button>` : ""}</li>`;
  }).join("")}</ul>`;
}

// ================================================================== CENTRAL DE PENDÊNCIAS
function telaPendencias() {
  const causas = filtrarCausas(st.pend.causas_raiz, st.filtros);
  const codigos = [...new Set(st.pend.causas_raiz.map((c) => c.codigo))];
  const porProduto = st.pend.produtos.filter((p) => p.pendencias.some((x) => !["sem_preco_venda", "preparacao_comprometida"].includes(x.codigo)) && !st.pend.causas_raiz.some((c) => c.diretos?.includes?.(p.id)));
  const temRend = st.pend.causas_raiz.some((c) => c.codigo === "rendimento_unidade_suspeita");
  return `<header class="c2-topo"><div><h1 class="c2-h1">Central de pendências</h1>
    <p class="c2-dado-sec">Ordenadas pelo que destrava mais produtos. Cada correção recalcula automaticamente as fichas dependentes.</p></div>
    ${temRend ? `<button class="c2-btn" data-acao="rendimentos">Revisar rendimentos suspeitos</button>` : ""}</header>
  <div class="c2-filtros">
    <label class="c2-campo"><span>Criticidade</span><select id="c2-crit"><option value="todas">Todas</option>${["critica", "alta", "media"].map((k) => `<option value="${k}" ${st.filtros.criticidade === k ? "selected" : ""}>${CRITICIDADE_ROTULO[k]}</option>`).join("")}</select></label>
    <label class="c2-campo"><span>Tipo de problema</span><select id="c2-cod"><option value="todos">Todos</option>${codigos.map((k) => `<option value="${k}" ${st.filtros.codigo === k ? "selected" : ""}>${E(st.pend.catalogo[k]?.problema.slice(0, 60) ?? k)}</option>`).join("")}</select></label>
  </div>
  ${causas.length ? `<h2 class="c2-h2">Causas-raiz (${causas.length})</h2><ul class="c2-causas">${causas.map(linhaCausa).join("")}</ul>` : `<p class="c2-ok-msg">Nenhuma causa-raiz com esses filtros.</p>`}
  ${porProduto.length ? `<h2 class="c2-h2">Pendências próprias de cada ficha (${porProduto.length})</h2>
    <ul class="c2-lista">${porProduto.slice(0, 200).map((p) => `<li><button class="c2-linha" data-acao="abrir-ficha" data-id="${E(p.id)}"><span class="c2-linha-nome">${E(p.nome)}</span>${chip(p.situacao)}
      <span class="c2-linha-info">${E([...new Set(p.pendencias.filter((x) => x.codigo !== "sem_preco_venda").map((x) => st.pend.catalogo[x.codigo]?.onde))].join(", "))}</span></button></li>`).join("")}</ul>` : ""}`;
}

// ================================================================== PRECIFICAÇÃO
function telaPrecificacao() {
  const vendaveis = st.pend.produtos.filter((p) => p.vendavel && p.tipo !== "submontagem").sort((a, b) => a.nome.localeCompare(b.nome));
  return `<header class="c2-topo"><div><h1 class="c2-h1">Precificação</h1>
    <p class="c2-dado-sec">Simule preço, meta de CMV e margem por canal. Nada aqui altera o preço real do cardápio.</p></div></header>
  <form class="c2-sim" id="c2-sim">
    <label class="c2-campo c2-campo-larga"><span>Produto</span><select name="produto" required><option value="">Escolha um produto</option>${vendaveis.map((p) => `<option value="${E(p.id)}">${E(p.nome)}${p.situacao === "inconsistente" ? " (custo não confiável)" : ""}</option>`).join("")}</select></label>
    <label class="c2-campo"><span>Preço a simular (R$)</span><input name="preco" inputmode="decimal" placeholder="usa o preço oficial" /></label>
    <label class="c2-campo"><span>Meta de CMV (%)</span><input name="meta" inputmode="decimal" placeholder="ex.: 30" /></label>
    <label class="c2-campo"><span>Margem de contribuição alvo (%)</span><input name="alvo" inputmode="decimal" placeholder="ex.: 25" /></label>
    <button class="c2-btn" type="submit">Simular</button>
  </form>
  <div id="c2-sim-res" aria-live="polite"></div>`;
}

const numBR = (s) => { const t = String(s ?? "").trim(); if (!t) return null; const n = Number(t.replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) ? n : NaN; };

async function simular(form) {
  const fd = new FormData(form); const id = fd.get("produto"); if (!id) return;
  const preco = numBR(fd.get("preco")); const meta = numBR(fd.get("meta")); const alvo = numBR(fd.get("alvo"));
  if ([preco, meta, alvo].some((x) => Number.isNaN(x))) { toast("Use números no formato 12,90."); return; }
  const out = el("#c2-sim-res"); out.innerHTML = esqueleto(3);
  try {
    const r = await cmv2Simular(id, { preco, meta_cmv: meta != null ? meta / 100 : null, margem_contribuicao_alvo: alvo != null ? alvo / 100 : null });
    out.innerHTML = `<p class="c2-nota">${E(r.aviso)}</p>${r.canais.some((c) => c.canal === "sem_canal") ? `<p class="c2-aviso">Nenhum canal configurado nem preço cadastrado. Configure as condições comerciais (comissões, taxas) em Configurações para ver a margem de contribuição por canal.</p>` : ""}
    <div class="c2-sim-canais">${r.canais.map((c) => `<article class="c2-canal"><h3 class="c2-h3">${c.canal === "sem_canal" ? "Sem canal configurado" : E(c.canal)}</h3>
      ${!c.disponivel ? `<p class="c2-aviso">${E(c.motivo)}</p>` : `
      <p class="c2-canal-preco">${c.preco ? moeda(c.preco) : "sem preço"}<small>${c.preco_oficial ? `oficial ${moeda(c.preco_oficial)}${c.origem_preco ? ` (${E(c.origem_preco)})` : ""}` : "sem preço oficial"}</small></p>
      <dl class="c2-dl">
        <div><dt>Custo (CMV unitário)</dt><dd>${moeda(c.custo)}</dd></div>
        <div><dt>CMV</dt><dd>${pct(c.cmv_pct, 1)}</dd></div>
        <div><dt>Margem bruta</dt><dd>${moeda(c.margem_bruta)} <small>${pct(c.margem_bruta_pct, 1)}</small></dd></div>
        <div><dt>Deduções do canal</dt><dd>${c.condicao_configurada ? `${pct(c.deducoes_pct * 100, 1)}${c.deducoes_fixas ? ` + ${moeda(c.deducoes_fixas)}/pedido` : ""}` : "não configuradas"}</dd></div>
        <div><dt>Margem de contribuição</dt><dd class="${c.margem_contribuicao < 0 ? "c2-neg" : ""}">${moeda(c.margem_contribuicao)} <small>${pct(c.margem_contribuicao_pct, 1)}</small></dd></div>
        <div><dt>Preço para a meta de CMV</dt><dd>${moeda(c.preco_para_meta_cmv)}</dd></div>
        <div><dt>Preço para a margem alvo</dt><dd>${moeda(c.preco_para_margem_alvo)}</dd></div>
      </dl><p class="c2-leitura">${E(leituraSimulacao(c))}</p>${c.avisos.map((a) => `<p class="c2-aviso">${E(a)}</p>`).join("")}`}
    </article>`).join("")}</div>`;
  } catch (e) { out.innerHTML = erroHtml(e); }
}

// ================================================================== PÁGINA DA FICHA
async function abrirFicha(id) {
  const c = el("#c2-conteudo"); c.innerHTML = esqueleto(8);
  try {
    const [rec, hist] = await Promise.all([cmv2Recuperacao(id), obterHistoricoProduto(id).catch(() => [])]);
    st.ficha = rec;
    const item = st.pend.produtos.find((p) => p.id === id);
    const prog = progressoEtapas(rec.etapas);
    const d = rec.dados; const prep = rec.natureza === "preparacao";
    const lote = d.ingredientes.reduce((s, x) => s + (x.ativo !== false && x.custo_aplicado != null ? x.custo_aplicado : 0), 0);
    const semCusto = d.ingredientes.some((x) => x.custo_aplicado == null || (!x.custo_zero_declarado && x.tipo === "insumo" && !(x.custo_unitario_base > 0)));
    const usadoPor = st.pend.produtos.filter((p) => p.pendencias.some((x) => x.codigo === "preparacao_comprometida" && x.detalhe === id));
    const h0 = hist?.data ?? hist;
    const histLista = (Array.isArray(h0) ? h0 : h0?.grupos ?? h0?.itens ?? []).slice(0, 12);
    const pendencias = rec.etapas.flatMap((e) => e.pendencias);
    const homolog = item?.homologacao;
    c.innerHTML = `
    <nav class="c2-migalha"><button class="c2-link" data-area-ir="${prep ? "preparacoes" : "produtos"}">${prep ? "Preparações" : "Produtos"}</button><span aria-hidden="true">/</span><span>${E(rec.nome)}</span></nav>
    <header class="c2-ficha-cab">
      <div><p class="c2-ficha-nat">${E(NATUREZA[rec.natureza]?.rotulo ?? "")}</p><h1 class="c2-h1">${E(rec.nome)}</h1>
      <div class="c2-ficha-status">${chip(item?.situacao)}<span class="c2-dado-sec">${prog.ok} de ${prog.total} etapas válidas</span></div>
      <div class="c2-progresso" role="progressbar" aria-valuenow="${Math.round(prog.pct)}" aria-valuemin="0" aria-valuemax="100" aria-label="Preenchimento da ficha"><span style="width:${prog.pct}%"></span></div></div>
      <div class="c2-ficha-acoes">${podeEditar() && st.saude.perfil.recursos.assistente_receitas ? `<button class="c2-btn" data-acao="recuperar" data-id="${E(id)}">${pendencias.length ? "Corrigir com o assistente" : "Editar com o assistente"}</button>` : ""}</div>
    </header>

    <section class="c2-regua" aria-label="Formação do custo unitário">
      <div class="c2-regua-termo"><span class="c2-regua-n">${moeda(lote)}</span><span class="c2-regua-r">custo do lote${semCusto ? " (incompleto)" : ""}</span></div>
      <span class="c2-regua-op" aria-hidden="true">÷</span>
      <div class="c2-regua-termo ${pendencias.some((x) => x.codigo?.startsWith("rendimento")) ? "c2-regua-alerta" : ""}"><span class="c2-regua-n">${numero(d.porcionamento.rendimento, 3)}</span><span class="c2-regua-r">${prep ? `rendimento em ${E(unidadeRend(d.porcionamento.unidade_rendimento, d.porcionamento.rendimento))}` : "porções do lote"}</span></div>
      <span class="c2-regua-op" aria-hidden="true">=</span>
      <div class="c2-regua-termo c2-regua-res"><span class="c2-regua-n">${moeda(rec.custo_unitario)}</span><span class="c2-regua-r">por ${prep ? E(unidadeRend(d.porcionamento.unidade_rendimento, 1)) : "unidade"}${homolog === "homologada" ? " · homologado" : semCusto ? " · estimado, incompleto" : " · calculado, não homologado"}</span></div>
    </section>

    ${pendencias.length ? `<section class="c2-secao"><h2 class="c2-h2">O que falta</h2><ul class="c2-faltas">${pendencias.map((p) => `<li><div class="c2-causa-cab">${crit(p.criticidade)}<strong>${E(p.problema)}</strong></div><p class="c2-causa-p"><strong>Como corrigir:</strong> ${E(p.correcao)}</p>${p.detalhe?.sugestao ? `<p class="c2-dado-sec">Valor provável: ${numero(p.detalhe.sugestao, 0)} ${E(p.detalhe.unidade)}. Confirme pesando o lote antes de corrigir.</p>` : ""}</li>`).join("")}</ul></section>` : ""}

    <section class="c2-secao"><h2 class="c2-h2">Composição do lote</h2>
      <div class="c2-tabela-envolve"><table class="c2-tabela"><thead><tr><th scope="col">Componente</th><th scope="col">Quantidade</th><th scope="col">Custo por unidade</th><th scope="col">No lote</th></tr></thead>
      <tbody>${d.ingredientes.map((x) => `<tr class="${x.ativo === false ? "c2-inativa" : ""}"><td>${E(x.nome)}${x.tipo === "submontagem" ? ' <span class="c2-tag c2-tag-prep">preparação</span>' : ""}${x.custo_zero_declarado ? ' <span class="c2-tag c2-tag-zero">zero declarado</span>' : ""}${x.peso_bruto ? `<br><small>bruto ${numero(x.peso_bruto)} · líquido ${numero(x.peso_liquido)}</small>` : ""}</td>
        <td data-rotulo="Quantidade">${numero(x.quantidade, 3)} ${E(x.unidade)}</td><td data-rotulo="Custo por unidade">${x.custo_unitario_base == null || (!x.custo_zero_declarado && !(x.custo_unitario_base > 0)) ? '<span class="c2-tag c2-tag-bad">desconhecido</span>' : moeda(x.custo_unitario_base, { unidade: x.unidade_base })}</td><td data-rotulo="No lote">${moeda(x.custo_aplicado)}</td></tr>`).join("")}</tbody></table></div>
    </section>

    ${!prep ? `<section class="c2-secao"><h2 class="c2-h2">Preços por canal</h2>${d.precos.length ? `<ul class="c2-precos">${d.precos.map((p) => `<li><span>${E(p.canal)}${p.tabela ? ` · tabela ${E(p.tabela)}` : ""}</span><strong>${moeda(p.preco)}</strong><small>${E(p.origem ?? "origem não registrada")}</small></li>`).join("")}</ul>` : `<p class="c2-aviso">Sem preço de venda: a ficha pode ser concluída, mas CMV % e margens ficam indisponíveis.</p>`}
      ${podeEditar() ? `<form class="c2-preco-form" data-form="preco" data-id="${E(id)}"><label class="c2-campo"><span>Canal</span><select name="canal">${["balcao", "ifood", "app", "uber", "outro"].map((k) => `<option>${k}</option>`).join("")}</select></label><label class="c2-campo"><span>Preço praticado (R$)</span><input name="preco" inputmode="decimal" required placeholder="24,90" /></label><label class="c2-campo"><span>Origem</span><input name="origem" value="cardápio vigente" /></label><button class="c2-btn c2-btn-sec">Salvar preço</button></form>` : ""}</section>` : ""}

    <section class="c2-secao c2-duas">
      <div><h2 class="c2-h2">Dependências</h2>${usadoPor.length ? `<p class="c2-dado-sec">Afeta ${usadoPor.length} produto(s) enquanto tiver pendência:</p><ul class="c2-mini">${usadoPor.slice(0, 15).map((p) => `<li><button class="c2-link" data-acao="abrir-ficha" data-id="${E(p.id)}">${E(p.nome)}</button></li>`).join("")}</ul>` : `<p class="c2-dado-sec">${prep ? "Nenhum produto comprometido por esta preparação." : "Usa as preparações listadas na composição."}</p>`}</div>
      <div><h2 class="c2-h2">Histórico</h2>${histLista.length ? `<ul class="c2-hist">${histLista.map((h) => `<li><time>${E(fmtDataHora(h.created_at ?? h.quando ?? ""))}</time> ${E(h.usuario_nome ?? h.quem ?? "sistema")}: ${E((h.mudancas ?? [h]).map((m) => `${m.rotulo ?? m.campo} ${m.valor_anterior ?? ""} → ${m.valor_novo ?? ""}`).join("; "))}</li>`).join("")}</ul>` : `<p class="c2-dado-sec">Sem alterações registradas.</p>`}</div>
    </section>`;
  } catch (e) { c.innerHTML = erroHtml(e); }
}

// ================================================================== ASSISTENTE (nova ficha e recuperação)
const ETAPAS = {
  produto_final: ["identificacao", "ingredientes", "aproveitamento", "porcionamento", "complementares", "precos", "revisao"],
  preparacao: ["identificacao", "ingredientes", "aproveitamento", "porcionamento", "revisao"],
  revenda: ["identificacao", "complementares", "precos", "revisao"],
};

async function abrirAssistente({ natureza = "produto_final", recuperacao = null, rascunho = null } = {}) {
  const a = st.assist = {
    natureza: rascunho?.natureza ?? recuperacao?.natureza ?? natureza,
    etapa: rascunho?.etapa ?? recuperacao?.proxima_etapa ?? "identificacao",
    rascunhoId: rascunho?.id ?? recuperacao?.rascunho?.id ?? null,
    produtoId: recuperacao?.produto_id ?? rascunho?.produto_id ?? null,
    rec: recuperacao, dados: rascunho?.dados ?? recuperacao?.rascunho?.dados ?? { identificacao: { nome: recuperacao?.nome ?? "" } },
  };
  if (!a.rec && a.produtoId) a.rec = await cmv2Recuperacao(a.produtoId);
  pintarAssistente();
}

function pintarAssistente() {
  const a = st.assist; const c = el("#c2-conteudo");
  const etapas = ETAPAS[a.natureza]; const i = etapas.indexOf(a.etapa);
  const estado = (e) => a.rec?.etapas.find((x) => x.etapa === e)?.estado ?? (etapas.indexOf(e) < i ? "valida" : "aberta");
  const ajuda = ajudaEtapa(a.etapa, a.natureza);
  c.innerHTML = `<div class="c2-assist">
    <header class="c2-topo"><div><p class="c2-ficha-nat">${a.rec ? "Recuperação de ficha existente" : "Nova ficha técnica"}</p><h1 class="c2-h1">${E(a.dados.identificacao?.nome || a.rec?.nome || "Sem nome")}</h1>
      ${a.rec ? `<p class="c2-dado-sec">Os dados válidos foram mantidos. Só as etapas marcadas como pendentes precisam de atenção.</p>` : ""}</div>
      <button class="c2-btn c2-btn-sec" data-acao="assist-salvar">Salvar e continuar depois</button></header>
    <ol class="c2-etapas" aria-label="Etapas">${etapas.map((e, k) => `<li><button class="c2-etapa c2-etapa-${estado(e)}" data-etapa="${e}" aria-current="${e === a.etapa ? "step" : "false"}"><span class="c2-etapa-n">${k + 1}</span>${E(ETAPA_ROTULO[e])}${estado(e) === "pendente" ? '<span class="c2-sr"> (pendente)</span>' : ""}</button></li>`).join("")}</ol>
    <div class="c2-assist-corpo">
      <section class="c2-assist-form" aria-labelledby="c2-etapa-t"><h2 id="c2-etapa-t" class="c2-h2">${E(ETAPA_ROTULO[a.etapa])}</h2>${corpoEtapa(a)}</section>
      <aside class="c2-ajuda" aria-label="Como preencher"><h3 class="c2-h3">${E(ajuda.titulo)}</h3><ol>${ajuda.passos.map((p) => `<li>${E(p)}</li>`).join("")}</ol></aside>
    </div>
    <footer class="c2-assist-rodape">
      <button class="c2-btn c2-btn-sec" data-acao="assist-voltar" ${i === 0 ? "disabled" : ""}>Etapa anterior</button>
      ${a.etapa === "revisao" ? `<button class="c2-btn" data-acao="assist-concluir">${a.produtoId ? "Concluir revisão" : "Criar ficha"}</button>` : `<button class="c2-btn" data-acao="assist-avancar">Próxima etapa</button>`}
    </footer></div>`;
}

function corpoEtapa(a) {
  const d = a.rec?.dados; const pend = a.rec?.etapas.find((x) => x.etapa === a.etapa)?.pendencias ?? [];
  const avisos = pend.map((p) => `<p class="c2-aviso"><strong>${E(p.problema)}</strong> ${E(p.correcao)}</p>`).join("");
  switch (a.etapa) {
    case "identificacao": return `${avisos}
      <label class="c2-campo c2-campo-larga"><span>Nome</span><input data-campo="identificacao.nome" value="${E(a.dados.identificacao?.nome ?? "")}" ${a.produtoId ? "readonly" : ""} required /></label>
      <fieldset class="c2-natureza" ${a.produtoId ? "disabled" : ""}><legend>Tipo</legend>${Object.entries(NATUREZA).map(([k, n]) => `<label class="c2-opcao"><input type="radio" name="natureza" value="${k}" ${a.natureza === k ? "checked" : ""} /><span><strong>${E(n.rotulo)}</strong><br>${E(n.texto)}<br><small>${E(n.exemplo)}</small></span></label>`).join("")}</fieldset>`;
    case "ingredientes": return `${avisos}${d ? `<ul class="c2-mini">${d.ingredientes.map((x) => `<li>${E(x.nome)} — ${numero(x.quantidade, 3)} ${E(x.unidade)} ${x.custo_aplicado == null || (!x.custo_zero_declarado && x.tipo === "insumo" && !(x.custo_unitario_base > 0)) ? '<span class="c2-tag c2-tag-bad">sem custo</span>' : '<span class="c2-tag c2-tag-ok">ok</span>'}</li>`).join("")}</ul>` : ""}
      ${a.produtoId ? `<form class="c2-linha-form" data-form="componente"><label class="c2-campo"><span>Insumo ou preparação</span><select name="ref" id="c2-ref"><option value="">Carregando…</option></select></label><label class="c2-campo"><span>Quantidade</span><input name="quantidade" inputmode="decimal" required placeholder="250" /></label><label class="c2-campo"><span>Unidade</span><select name="unidade">${["g", "kg", "ml", "l", "un"].map((u) => `<option>${u}</option>`).join("")}</select></label><button class="c2-btn c2-btn-sec">Adicionar</button></form>`
        : `<p class="c2-dado-sec">Os ingredientes são adicionados assim que a ficha é criada (ao concluir), com conversão automática de unidades.</p>`}`;
    case "aproveitamento": return `${avisos}<p class="c2-dado-sec">Use quando o ingrediente perde peso na limpeza (peixe, carne, frutas). Opcional para os demais.</p>
      <form class="c2-linha-form" data-form="aproveitamento"><label class="c2-campo"><span>Peso bruto (g)</span><input name="bruto" inputmode="decimal" placeholder="3200" /></label><label class="c2-campo"><span>Peso líquido (g)</span><input name="liquido" inputmode="decimal" placeholder="2000" /></label><label class="c2-campo"><span>Índice de cocção (opcional)</span><input name="ic" inputmode="decimal" placeholder="0,85" /></label><button class="c2-btn c2-btn-sec">Calcular</button></form><div id="c2-aprov-res" aria-live="polite"></div>`;
    case "porcionamento": return `${avisos}
      <div class="c2-linha-form"><label class="c2-campo"><span>Rendimento do lote</span><input data-campo="porcionamento.rendimento" inputmode="decimal" value="${E(String(a.dados.porcionamento?.rendimento ?? d?.porcionamento.rendimento ?? "").replace(".", ","))}" /></label>
      ${a.natureza === "preparacao" ? `<label class="c2-campo"><span>Unidade</span><select data-campo="porcionamento.unidade_rendimento">${["g", "kg", "ml", "l", "un"].map((u) => `<option ${(a.dados.porcionamento?.unidade_rendimento ?? d?.porcionamento.unidade_rendimento) === u ? "selected" : ""}>${u}</option>`).join("")}</select></label>` : ""}</div>
      <p class="c2-dado-sec" id="c2-rend-eco"></p>`;
    case "complementares": return `${avisos}<p class="c2-dado-sec">Embalagens entram como insumo do tipo embalagem na etapa de ingredientes. Mão de obra é registrada à parte e não entra no CMV.</p>`;
    case "precos": return `${avisos}${d?.precos?.length ? `<ul class="c2-precos">${d.precos.map((p) => `<li><span>${E(p.canal)}</span><strong>${moeda(p.preco)}</strong></li>`).join("")}</ul>` : `<p class="c2-dado-sec">Nenhum preço informado. Você pode concluir sem preço e voltar depois.</p>`}
      ${a.produtoId && podeEditar() ? `<form class="c2-preco-form" data-form="preco" data-id="${E(a.produtoId)}"><label class="c2-campo"><span>Canal</span><select name="canal">${["balcao", "ifood", "app", "uber", "outro"].map((k) => `<option>${k}</option>`).join("")}</select></label><label class="c2-campo"><span>Preço praticado (R$)</span><input name="preco" inputmode="decimal" required /></label><input type="hidden" name="origem" value="assistente" /><button class="c2-btn c2-btn-sec">Salvar preço</button></form>` : ""}`;
    case "revisao": {
      const bloqueadas = a.rec?.etapas.filter((e) => e.estado === "pendente") ?? [];
      return bloqueadas.length ? `<p class="c2-aviso">Ainda há ${bloqueadas.length} etapa(s) pendente(s): ${bloqueadas.map((e) => E(ETAPA_ROTULO[e.etapa])).join(", ")}. Você pode salvar e voltar depois.</p>`
        : `<p class="c2-ok-msg">${a.produtoId ? "Ficha sem pendências técnicas. A homologação é feita por quem administra a unidade." : "Confira o nome e o tipo. Ao criar, você segue para adicionar ingredientes."}</p>`;
    }
    default: return "";
  }
}

function coletarCampos() {
  const a = st.assist;
  for (const inp of document.querySelectorAll("[data-campo]")) {
    const [g, k] = inp.dataset.campo.split(".");
    a.dados[g] = { ...(a.dados[g] ?? {}), [k]: inp.value };
  }
  const nat = document.querySelector('input[name="natureza"]:checked'); if (nat && !a.produtoId) a.natureza = nat.value;
}

async function salvarRascunho(silencioso = false) {
  const a = st.assist; coletarCampos();
  try {
    const r = await cmv2SalvarRascunho(a.rascunhoId, { natureza: a.natureza, etapa: a.etapa, dados: a.dados, produto_id: a.produtoId });
    a.rascunhoId = r.id; if (!silencioso) toast("Rascunho salvo. Você pode continuar depois.");
  } catch (e) { toast(e.message); }
}

async function aplicarEtapa() {
  // Na recuperação, grava o que mudou nesta etapa usando os endpoints existentes (mesmas validações).
  const a = st.assist; coletarCampos();
  if (a.etapa === "porcionamento" && a.produtoId && a.dados.porcionamento?.rendimento != null) {
    const n = numBR(a.dados.porcionamento.rendimento);
    if (n == null || Number.isNaN(n) || n <= 0) { toast("Informe um rendimento maior que zero."); return false; }
    if (/^\d{1,3}\.\d{3}$/.test(String(a.dados.porcionamento.rendimento).trim()) || (a.natureza === "preparacao" && n < 10 && ["g", "ml"].includes(a.dados.porcionamento.unidade_rendimento ?? a.rec?.dados.porcionamento.unidade_rendimento))) {
      if (!confirmarInline(`Rendimento de ${numero(n, 3)} ${a.dados.porcionamento.unidade_rendimento ?? a.rec?.dados.porcionamento.unidade_rendimento} — é isso mesmo? Para 2,6 kg, digite 2600 g.`)) return false;
    }
    if (n !== Number(a.rec?.dados.porcionamento.rendimento)) {
      try { await atualizarProduto(a.produtoId, { rendimento: n, ...(a.dados.porcionamento.unidade_rendimento ? { unidade_rendimento: a.dados.porcionamento.unidade_rendimento } : {}) }); toast("Rendimento atualizado. Produtos dependentes recalculados."); }
      catch (e) { toast(e.message); return false; }
    }
  }
  return true;
}

// Confirmação sem window.confirm (bloqueia automação): o 1º clique arma, o 2º confirma.
function confirmarInline(msg) {
  const a = st.assist; if (a.confirmado === msg) { a.confirmado = null; return true; }
  a.confirmado = msg; toast(msg + " Clique de novo para confirmar."); return false;
}

async function avancar(delta) {
  const a = st.assist; const etapas = ETAPAS[a.natureza];
  if (delta > 0 && !(await aplicarEtapa())) return;
  if (delta > 0 && a.etapa === "identificacao" && !String(a.dados.identificacao?.nome ?? "").trim()) { toast("Informe o nome."); return; }
  const i = Math.min(Math.max(etapas.indexOf(a.etapa) + delta, 0), etapas.length - 1);
  a.etapa = etapas[i];
  if (a.produtoId) a.rec = await cmv2Recuperacao(a.produtoId);
  await salvarRascunho(true);
  pintarAssistente(); posEtapa();
}

async function posEtapa() {
  const a = st.assist;
  if (a.etapa === "ingredientes" && a.produtoId) {
    const [ins, preps] = await Promise.all([listarInsumos({}).catch(() => []), listarPreparacoes().catch(() => [])]);
    const lI = Array.isArray(ins) ? ins : ins?.data ?? []; const lP = (Array.isArray(preps) ? preps : preps?.data ?? []).filter((p) => p.id !== a.produtoId);
    const sel = el("#c2-ref"); if (sel) sel.innerHTML = `<option value="">Escolha</option><optgroup label="Insumos">${lI.map((i) => `<option value="i:${E(i.id)}">${E(i.nome)} (${E(i.unidade_medida)})</option>`).join("")}</optgroup><optgroup label="Preparações">${lP.map((p) => `<option value="p:${E(p.id)}">${E(p.nome)}</option>`).join("")}</optgroup>`;
  }
  if (a.etapa === "porcionamento") {
    const inp = document.querySelector('[data-campo="porcionamento.rendimento"]'); const eco = el("#c2-rend-eco");
    const eco1 = () => { const n = numBR(inp.value); eco.textContent = n && !Number.isNaN(n) ? `Lido como ${numero(n, 3)} — ${n >= 1000 ? `${numero(n / 1000, 3)} mil` : "menos de mil"}.` : ""; };
    inp?.addEventListener("input", eco1); eco1();
  }
}

async function concluirAssistente() {
  const a = st.assist; coletarCampos();
  if (a.produtoId) { await salvarRascunho(true); toast("Revisão salva."); await carregarBase(true); abrirFicha(a.produtoId); return; }
  try {
    const rend = numBR(a.dados.porcionamento?.rendimento);
    const p = await cmv2CriarFicha({ natureza: a.natureza, nome: a.dados.identificacao?.nome, rendimento: rend, unidade_rendimento: a.dados.porcionamento?.unidade_rendimento, rascunho_id: a.rascunhoId });
    toast(`Ficha "${p.nome}" criada. Agora adicione os ingredientes.`);
    await carregarBase(true);
    st.assist = null; abrirAssistente({ recuperacao: await cmv2Recuperacao(p.id) }); st.assist.etapa = "ingredientes"; pintarAssistente(); posEtapa();
  } catch (e) { toast(e.message); }
}

// ================================================================== FERRAMENTAS: rendimentos, custo zero, homologação
async function abrirRevisaoRendimentos(sobrescritas = {}) {
  const c = el("#c2-conteudo"); c.innerHTML = esqueleto(6);
  try {
    const { itens } = await cmv2PreviaRendimentos(sobrescritas);
    st.rend = { itens, sobrescritas };
    c.innerHTML = `<nav class="c2-migalha"><button class="c2-link" data-area-ir="pendencias">Central de pendências</button><span aria-hidden="true">/</span><span>Revisão de rendimentos</span></nav>
    <header class="c2-topo"><div><h1 class="c2-h1">Revisão de rendimentos suspeitos</h1>
      <p class="c2-dado-sec">O rendimento é muito pequeno para a massa dos ingredientes — quase sempre um valor em kg digitado na unidade g. Nada é aplicado sem sua seleção, uma justificativa e a revalidação no servidor.</p></div></header>
    ${itens.length ? `<form id="c2-rend-form"><p class="c2-dado">${itens.length} preparação(ões) · ${itens.filter((i) => i.sugestao != null).length} com sugestão fundamentada · ${itens.filter((i) => i.sugestao == null).length} exigem pesagem</p>
      <ul class="c2-revs">${itens.map((i) => `<li class="c2-rev" data-id="${E(i.produto_id)}">
        <label class="c2-rev-sel"><input type="checkbox" name="sel" value="${E(i.produto_id)}" /><span class="c2-sr">Selecionar ${E(i.nome)}</span></label>
        <div class="c2-rev-id"><strong>${E(i.nome)}</strong><span class="c2-conf c2-conf-${i.confianca}">${E(CONFIANCA_ROTULO[i.confianca])}</span>
          <p class="c2-rev-causa">${E(i.causa)}</p>
          <p class="c2-rev-origem">${i.origem?.arquivo ? `Origem: ${E(i.origem.arquivo)}, aba ${E(i.origem.aba ?? "?")} (planilha dizia ${numero(i.origem.rendimento_planilha, 3)})` : "Origem: cadastro manual"} · ingredientes somam ${numero(i.massa_ingredientes, 0)} ${E(i.unidade)} (${i.linhas_comparaveis} de ${i.linhas_total} linhas comparáveis)</p></div>
        <div class="c2-rev-valores">
          <div><span class="c2-rev-r">Rendimento</span><span>${numero(i.rendimento_atual, 3)} ${E(i.unidade)} → <input name="novo" inputmode="decimal" value="${i.rendimento_proposto != null ? E(String(i.rendimento_proposto)) : ""}" placeholder="pese o lote" aria-label="Novo rendimento de ${E(i.nome)} em ${E(i.unidade)}" /> ${E(i.unidade)}</span></div>
          <div><span class="c2-rev-r">Custo por ${E(i.unidade)}</span><span>${moeda(i.custo_unitario_antes)} → ${i.custo_unitario_depois != null ? `<strong>${moeda(i.custo_unitario_depois)}</strong>` : "—"}</span></div>
          <div><span class="c2-rev-r">Produtos dependentes</span><span>${i.dependentes}${i.reducao_custo_dependentes ? ` · custo deles cai ${moeda(i.reducao_custo_dependentes)} no total` : ""}</span></div>
        </div>
        <label class="c2-campo c2-rev-just"><span>Justificativa</span><input name="just" placeholder="ex.: lote pesado: 2.600 g" /></label>
      </li>`).join("")}</ul>
      <div class="c2-assist-rodape"><button type="button" class="c2-btn c2-btn-sec" data-acao="rend-recalcular">Atualizar prévia com os valores editados</button>
      ${podeHomologar() ? `<button class="c2-btn" type="submit">Aplicar selecionadas</button>` : `<p class="c2-dado-sec">Só administradores aplicam correções.</p>`}</div></form>` : `<p class="c2-ok-msg">Nenhum rendimento suspeito nesta unidade.</p>`}`;
  } catch (e) { c.innerHTML = erroHtml(e); }
}

function lerFormRendimentos() {
  const linhas = [...document.querySelectorAll("#c2-rend-form .c2-rev")];
  return linhas.map((tr) => ({ id: tr.dataset.id, sel: tr.querySelector('[name="sel"]').checked, novo: numBR(tr.querySelector('[name="novo"]').value), just: tr.querySelector('[name="just"]').value }));
}

async function aplicarRendimentos() {
  const l = lerFormRendimentos().filter((x) => x.sel);
  if (!l.length) { toast("Selecione ao menos uma preparação."); return; }
  const porId = new Map(st.rend.itens.map((i) => [i.produto_id, i]));
  try {
    const r = await cmv2AplicarRendimentos(l.map((x) => ({ produto_id: x.id, rendimento_atual: porId.get(x.id).rendimento_atual, rendimento_novo: x.novo, justificativa: x.just })));
    toast(`${r.corrigidos} rendimento(s) corrigido(s); ${r.recalculados} ficha(s) recalculada(s).`);
    await carregarBase(true); abrirRevisaoRendimentos();
  } catch (e) { toast(e.details?.erros?.join(" ") ?? e.message); }
}

async function abrirCustoZero(insumoId) {
  const c = el("#c2-conteudo"); c.innerHTML = esqueleto(5);
  try {
    const p = await cmv2PreviaCustoZero(insumoId);
    const declarado = p.insumo.natureza_custo === "zero_declarado";
    c.innerHTML = `<nav class="c2-migalha"><button class="c2-link" data-area-ir="insumos">Insumos</button><span aria-hidden="true">/</span><span>${E(p.insumo.nome)}</span></nav>
    <header class="c2-topo"><div><h1 class="c2-h1">${E(p.insumo.nome)}</h1><p class="c2-dado-sec">${declarado ? "Custo zero declarado." : "Sem custo de aquisição: as fichas que o usam ficam incompletas."}</p></div></header>
    <section class="c2-secao c2-duas"><div><h2 class="c2-h2">Opção 1 — informar o preço de compra</h2><p class="c2-dado-sec">Se o item é comprado (ex.: água mineral, galão), cadastre preço e embalagem no cadastro de insumos.</p><button class="c2-btn c2-btn-sec" data-acao="cadastro-insumos">Abrir cadastro de insumos</button></div>
    <div><h2 class="c2-h2">Opção 2 — declarar custo zero no CMV</h2><p class="c2-dado-sec">${E(p.aviso)}</p>
    ${podeHomologar() ? `<form data-form="custo-zero" data-id="${E(insumoId)}" data-declarar="${declarado ? "0" : "1"}"><label class="c2-campo c2-campo-larga"><span>Motivo ${declarado ? "da revisão" : ""}</span><input name="motivo" required placeholder="${declarado ? "ex.: passamos a comprar água mineral" : "ex.: água da rede, absorvida nas despesas operacionais"}" /></label><button class="c2-btn">${declarado ? "Revogar custo zero" : "Declarar custo zero"}</button></form>` : `<p class="c2-dado-sec">Só administradores fazem essa declaração.</p>`}</div></section>
    <section class="c2-secao"><h2 class="c2-h2">Impacto previsto</h2>
      <p class="c2-dado">${p.afetados} ficha(s) usam este insumo. Depois da correção, <strong>${p.ficariam_sem_pendencia}</strong> ficariam sem pendência técnica e <strong>${p.continuariam_com_pendencia}</strong> continuariam com outras pendências.</p>
      <ul class="c2-lista">${p.itens.slice(0, 150).map((x) => `<li class="c2-linha c2-linha-estatica c2-linha-trans"><span class="c2-linha-nome">${E(x.nome)}</span><span class="c2-trans">${chip(x.situacao_antes)}<span aria-label="passa a">→</span>${chip(x.situacao_depois)}</span><span class="c2-linha-info">${x.pendencias_restantes.length ? `ainda: ${E([...new Set(x.pendencias_restantes.map((k) => st.pend.catalogo[k]?.onde ?? k))].join(", "))}` : ""}</span></li>`).join("")}</ul></section>`;
  } catch (e) { c.innerHTML = erroHtml(e); }
}

async function abrirHomologacao() {
  const c = el("#c2-conteudo"); c.innerHTML = esqueleto(6);
  try {
    const p = await cmv2PreviaHomologacao();
    c.innerHTML = `<header class="c2-topo"><div><h1 class="c2-h1">Homologação de fichas</h1>
      <p class="c2-dado-sec">Homologar torna o custo oficial. Só entram fichas sem pendência técnica (incluindo as preparações usadas por elas). Preço de venda não é exigido.</p></div></header>
    <p class="c2-dado">${p.elegiveis.length} elegível(is) · ${p.bloqueadas.length} bloqueada(s) · ${p.homologadas} já homologada(s)${p.padronizadas ? ` · ${p.padronizadas} padronizada(s) da franquia, fora deste fluxo` : ""}</p>
    <form id="c2-hom-form"><div class="c2-hom-topo"><label class="c2-opcao-inline"><input type="checkbox" id="c2-hom-todas" /> Selecionar todas as elegíveis</label>
      ${podeHomologar() ? `<button class="c2-btn" type="submit">Homologar selecionadas</button>` : ""}</div>
      <ul class="c2-lista">${p.elegiveis.map((i) => `<li class="c2-linha c2-linha-estatica"><label class="c2-opcao-inline"><input type="checkbox" name="hom" value="${E(i.id)}" /> <span class="c2-linha-nome">${E(i.nome)}</span></label>${chip(i.situacao)}<button type="button" class="c2-link" data-acao="abrir-ficha" data-id="${E(i.id)}">Ver ficha</button></li>`).join("")}</ul></form>
    ${p.homologadas_inconsistentes?.length ? `<h2 class="c2-h2">Homologadas que precisam de nova revisão (${p.homologadas_inconsistentes.length})</h2><p class="c2-dado-sec">Foram homologadas antes e hoje não passariam na verificação. A homologação continua valendo até alguém revisar: nada é revogado automaticamente.</p><ul class="c2-lista">${p.homologadas_inconsistentes.map((i) => `<li class="c2-linha c2-linha-estatica"><span class="c2-linha-nome">${E(i.nome)}</span>${crit(i.criticidade)}<span class="c2-linha-info">${E(i.motivos.join(" "))}</span></li>`).join("")}</ul>` : ""}
    ${p.bloqueadas.length ? `<h2 class="c2-h2">Bloqueadas e por quê</h2><ul class="c2-lista">${p.bloqueadas.map((i) => `<li class="c2-linha c2-linha-estatica"><span class="c2-linha-nome">${E(i.nome)}</span>${chip(i.situacao)}<span class="c2-linha-info">${E(i.motivos.join(" "))}</span></li>`).join("")}</ul>` : ""}`;
  } catch (e) { c.innerHTML = erroHtml(e); }
}

// ================================================================== eventos
async function aoClicar(ev) {
  const ir = ev.target.closest("[data-area-ir]"); if (ir) { irArea(ir.dataset.areaIr); return; }
  const et = ev.target.closest("[data-etapa]"); if (et && st.assist) { coletarCampos(); st.assist.etapa = et.dataset.etapa; pintarAssistente(); posEtapa(); return; }
  const b = ev.target.closest("[data-acao]"); if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.acao) {
    case "recarregar": await carregarBase(true); pintar(); break;
    case "abrir-ficha": if (id) abrirFicha(id); break;
    case "rendimentos": abrirRevisaoRendimentos(); break;
    case "rend-recalcular": { const s = {}; for (const x of lerFormRendimentos()) if (x.novo > 0) s[x.id] = x.novo; abrirRevisaoRendimentos(s); break; }
    case "custo-zero": abrirCustoZero(id); break;
    case "homologacao": abrirHomologacao(); break;
    case "nova-ficha": abrirAssistente({ natureza: b.dataset.natureza ?? "produto_final" }); break;
    case "recuperar": abrirAssistente({ recuperacao: await cmv2Recuperacao(id) }); posEtapa(); break;
    case "retomar": abrirAssistente({ rascunho: await cmv2Rascunho(id) }); posEtapa(); break;
    case "assist-salvar": salvarRascunho(); break;
    case "assist-avancar": avancar(1); break;
    case "assist-voltar": avancar(-1); break;
    case "assist-concluir": concluirAssistente(); break;
    case "cadastro-insumos": (await import("./router.js")).irPara("insumos"); break;
    default: break;
  }
}

document.addEventListener("input", (ev) => {
  if (!el("#c2")) return;
  if (ev.target.id === "c2-busca") { st.filtros.busca = ev.target.value; const pos = ev.target.selectionStart; pintar(); const n = el("#c2-busca"); n?.focus(); n?.setSelectionRange(pos, pos); }
});
document.addEventListener("change", (ev) => {
  if (!el("#c2")) return;
  const m = { "c2-sit": "situacao", "c2-crit": "criticidade", "c2-cod": "codigo" }[ev.target.id];
  if (m) { st.filtros[m] = ev.target.value; pintar(); }
  if (ev.target.id === "c2-hom-todas") for (const c of document.querySelectorAll('[name="hom"]')) c.checked = ev.target.checked;
});
document.addEventListener("submit", async (ev) => {
  if (!el("#c2")) return;
  const f = ev.target;
  if (f.id === "c2-sim") { ev.preventDefault(); simular(f); return; }
  if (f.id === "c2-rend-form") { ev.preventDefault(); aplicarRendimentos(); return; }
  if (f.id === "c2-hom-form") {
    ev.preventDefault(); const ids = [...f.querySelectorAll('[name="hom"]:checked')].map((x) => x.value);
    if (!ids.length) { toast("Selecione ao menos uma ficha."); return; }
    try { const r = await cmv2HomologarLote(ids); toast(`${r.homologadas.length} homologada(s); ${r.recusadas.length} recusada(s).`); await carregarBase(true); abrirHomologacao(); } catch (e) { toast(e.message); }
    return;
  }
  const tipo = f.dataset.form; if (!tipo) return; ev.preventDefault();
  const fd = new FormData(f);
  try {
    if (tipo === "preco") {
      const preco = numBR(fd.get("preco")); if (!(preco > 0)) { toast("Informe o preço no formato 24,90."); return; }
      await cmv2DefinirPreco(f.dataset.id, { canal: fd.get("canal"), preco, origem: fd.get("origem") || "manual" });
      toast("Preço salvo com origem e data."); await carregarBase(true);
      if (st.assist) { st.assist.rec = await cmv2Recuperacao(st.assist.produtoId); pintarAssistente(); } else abrirFicha(f.dataset.id);
    } else if (tipo === "custo-zero") {
      const declarar = f.dataset.declarar === "1";
      const r = await cmv2DefinirCustoZero(f.dataset.id, declarar, fd.get("motivo"));
      toast(r.alterado ? `${declarar ? "Custo zero declarado" : "Declaração revogada"}; ${r.recalculados} ficha(s) recalculada(s).` : "Nada mudou.");
      await carregarBase(true); abrirCustoZero(f.dataset.id);
    } else if (tipo === "componente") {
      const [k, ref] = String(fd.get("ref")).split(":"); const q = numBR(fd.get("quantidade"));
      if (!ref || !(q > 0)) { toast("Escolha o componente e a quantidade."); return; }
      await adicionarComponente(st.assist.produtoId, { ...(k === "i" ? { insumo_id: ref } : { subproduto_id: ref }), quantidade: q, unidade: fd.get("unidade") });
      toast("Componente adicionado e custo recalculado."); st.assist.rec = await cmv2Recuperacao(st.assist.produtoId); pintarAssistente(); posEtapa();
    } else if (tipo === "aproveitamento") {
      const r = await cmv2ValidarAproveitamento(null, { pesoBruto: numBR(fd.get("bruto")), pesoLiquido: numBR(fd.get("liquido")), indiceCoccao: numBR(fd.get("ic")) });
      el("#c2-aprov-res").innerHTML = r.ok ? `<dl class="c2-dl"><div><dt>Fator de correção</dt><dd>${numero(r.fator_correcao, 3)}</dd></div><div><dt>Aproveitamento</dt><dd>${pct(r.aproveitamento_pct, 1)}</dd></div><div><dt>Perda na limpeza</dt><dd>${numero(r.perda_limpeza)} g</dd></div>${r.peso_pronto != null ? `<div><dt>Peso após preparo</dt><dd>${numero(r.peso_pronto)} g</dd></div>` : ""}<div><dt>Quantidade a lançar na ficha</dt><dd>${numero(r.quantidade_cobrada)} g (peso bruto)</dd></div></dl>${r.avisos.map((x) => `<p class="c2-aviso">${E(x)}</p>`).join("")}`
        : r.erros.map((x) => `<p class="c2-aviso c2-aviso-bad">${E(x)}</p>`).join("");
    }
  } catch (e) { toast(e.message); }
});
