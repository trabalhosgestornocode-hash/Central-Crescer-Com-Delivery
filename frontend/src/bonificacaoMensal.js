// BONIFICAÇÃO MENSAL — Central de Performance da unidade. Redesign visual
// (hero, gauges, gráficos, drawer) sobre a MESMA API/regras de negócio do
// backend (bonificacaoMensal.calc.js/.metas.js/.elegibilidade.js/
// visio-parser.js — nada disso muda aqui). Este arquivo só decide COMO
// mostrar o que o backend já calculou.
//
// "Super Restaurante" NÃO é o nome do módulo — é só um AGRUPAMENTO dentro
// dele (correção depois de uma interpretação errada anterior). É o nome que
// a própria operação já usa na planilha: seção "Ifood: Super Restaurante" =
// Avaliação iFood + Cancelamentos + Pedidos com Chamado, exatos 3
// indicadores, nada além disso (ver superRestauranteBlocoHtml). Pesquisas e
// REV são critérios PRÓPRIOS da Bonificação Mensal, cada um com sua aba —
// nunca dentro do agrupamento Super Restaurante.
//
// Os TRÊS critérios que travam a elegibilidade da bonificação do mês inteiro
// (tudo-ou-nada) são Nota iFood + REV + Pesquisas — ver
// bonificacaoMensal.elegibilidade.js#avaliarElegibilidadeBonificacao. Isso é
// um conceito DIFERENTE do agrupamento visual Super Restaurante (que inclui
// Cancelamentos/Pedidos com Chamado, que NÃO travam a elegibilidade — só
// aparecem juntos porque a planilha já os mostra assim).
import { el, escapeHtml, toast, fmtMoeda, fmtPct, fmtDataHora } from "./utils.js";
import { state } from "./state.js";
import { pode } from "./sessao.js";
import { bonifMes, bonifMetas, bonifHistorico, bonifLancamento, bonifSalvarLancamento, bonifExcluirLancamento, bonifSalvarRevMensal } from "./api.js";
import { abrirImportarVisioModal } from "./bonificacaoMensalImportModal.js";
import { abrirEditarMetaModal } from "./bonificacaoMensalMetasModal.js";
import { renderIndicadorManualTab } from "./bonificacaoMensalIndicadorManual.js";
import { registrarResetDeContexto, geracaoContexto, contextoMudou } from "./contextoEscopo.js";
import { destruirGraficosBonificacao, graficoEvolucaoFaturamento, graficoEvolucaoMix } from "./charts.js";
import { gaugeSvg, sparklineSvg, tendencia, escadaFaixas, countUp } from "./bonificacaoMensalVisuais.js";
import { icon } from "./icons.js";

const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
// Nota iFood, Cancelamentos e Pedidos c/ Chamado NÃO têm mais aba própria —
// viraram os 3 cards do agrupamento "Super Restaurante" (aba própria, e
// também um resumo na Visão Geral); o lançamento diário de cada um continua
// existindo, só que abre num drawer (abrirDrawerIndicadorManual) em vez de
// uma página cheia. Pesquisas e REV continuam com aba própria — são
// critérios da Bonificação Mensal, não do agrupamento Super Restaurante.
const ABAS = [
  { id: "visao", icon: "📊", label: "Visão Geral" },
  { id: "visio", icon: "🗓️", label: "Visio" },
  { id: "rev", icon: "📶", label: "REV" },
  { id: "pesquisas", icon: "📝", label: "Pesquisas" },
  { id: "super_restaurante", icon: "🌟", label: "Super Restaurante" },
  { id: "metas", icon: "🎯", label: "Metas e Bonificações" },
  { id: "historico", icon: "📚", label: "Histórico" },
];

const STATUS_DIA_LEGENDA = [
  { chave: "IMPORTADO", label: "Importado", classe: "ok" },
  { chave: "MANUAL", label: "Manual", classe: "info" },
  { chave: "PARCIAL", label: "Parcial", classe: "warn" },
  { chave: "PENDENTE", label: "Pendente", classe: "bad" },
  { chave: "SEM_OPERACAO", label: "Sem operação", classe: "muted" },
  { chave: "FUTURO", label: "Futuro", classe: "muted" },
];
const STATUS_DIA_ROTULO = Object.fromEntries(STATUS_DIA_LEGENDA.map((s) => [s.chave, s]));

// Grupos por área — cada indicador aparece em UM grupo. REV saiu do grupo
// operacional (tem seção própria agora, fora do grid genérico — ver
// renderRevMensal). GRUPOS[2] ("cliente") só é usado pela aba Metas (pra
// agrupar visualmente onde editar o mínimo de cada um) — NUNCA pelo
// grupoHtml()/cardGauge() genérico da Visão Geral: lá, Nota iFood/
// Cancelamentos/Pedidos com Chamado têm renderização própria dentro do
// agrupamento Super Restaurante (ver superRestauranteBlocoHtml), e Pesquisas
// tem aba própria (ver renderPesquisasTab) — nenhum dos 4 usa cardGauge.
const GRUPOS = [
  { id: "comercial", titulo: "Performance Comercial", icon: "📈", indicadores: ["bebidas", "adicionais", "diversos", "ticket_medio"] },
  { id: "operacional", titulo: "Eficiência Operacional", icon: "⚙️", indicadores: ["cmv"] },
  { id: "cliente", titulo: "Qualidade / Experiência do Cliente", icon: "👤", indicadores: ["avaliacao_ifood", "pesquisas", "cancelamentos", "pedidos_chamado"] },
];
const INDICADOR = {
  faturamento:      { label: "Faturamento",         icon: "💰", tipo: "moeda", direcao: "higher_is_better" },
  bebidas:          { label: "Bebidas",             icon: "🥤", tipo: "pct",   direcao: "higher_is_better" },
  adicionais:       { label: "Adicionais",          icon: "🧀", tipo: "pct",   direcao: "higher_is_better" },
  diversos:         { label: "Diversos",            icon: "🍪", tipo: "pct",   direcao: "higher_is_better" },
  cmv:              { label: "CMV",                 icon: "📉", tipo: "pct",   direcao: "lower_is_better" },
  ticket_medio:     { label: "Ticket Médio",        icon: "🎟️", tipo: "moeda", direcao: "higher_is_better" },
  avaliacao_ifood:  { label: "Avaliação",           icon: "⭐", tipo: "nota",  direcao: "higher_is_better" },
  cancelamentos:    { label: "Cancelamentos",       icon: "🚫", tipo: "pct",   direcao: "lower_is_better" },
  pedidos_chamado:  { label: "Chamados",            icon: "☎️", tipo: "pct",   direcao: "lower_is_better" },
  rev:              { label: "REV",                 icon: "📶", tipo: "nota",  direcao: "higher_is_better" },
  pesquisas:        { label: "Pesquisas",           icon: "📝", tipo: "int",   direcao: "higher_is_better" },
};

// Fonte do dado (item 10 da auditoria de 15/08/2026) — de onde cada
// indicador vem hoje. Estático por indicador: Faturamento/Ticket Médio
// sempre do Geral (Relatório de Vendas), Bebidas/Adicionais/Diversos
// sempre do Loja (Relatório de Produtos), o resto é lançamento manual
// (nenhum tem fonte automática comprovada ainda).
const FONTE_INDICADOR = {
  faturamento: "Visio — Relatório de Vendas", ticket_medio: "Visio — Relatório de Vendas",
  bebidas: "Visio — Relatório de Produtos", adicionais: "Visio — Relatório de Produtos", diversos: "Visio — Relatório de Produtos",
  cmv: "Lançamento manual", avaliacao_ifood: "Lançamento manual", cancelamentos: "Lançamento manual",
  pedidos_chamado: "Lançamento manual", rev: "Lançamento manual", pesquisas: "Lançamento manual",
};
// Atribuição de origem de cada indicador — uma fonte só. Não existe "valor da
// Central x valor da Visio": os dados vêm da Visio, a Central só organiza e
// aplica as regras.
function fonteDoIndicador(chave) {
  return FONTE_INDICADOR[chave] || "";
}
const fonteHtml = (chave) => { const f = fonteDoIndicador(chave); return f ? `<span class="bm-fonte">Fonte: ${escapeHtml(f)}</span>` : ""; };

const hoje = new Date();
const bm = { aba: "visao", mes: hoje.getMonth() + 1, ano: hoje.getFullYear(), dadosMes: null, metas: null, historico: null };

// Troca de unidade/empresa: metas, lançamentos e histórico são todos por
// unidade — nada disso pode atravessar. `metas` importa em especial porque
// alimenta as faixas desenhadas nos cards: metas da unidade A sobre números
// da unidade B produziria um "faltam X para a próxima faixa" simplesmente
// errado, sem nenhum aviso na tela.
registrarResetDeContexto(() => {
  bm.aba = "visao";
  bm.mes = hoje.getMonth() + 1;
  bm.ano = hoje.getFullYear();
  bm.dadosMes = null;
  bm.metas = null;
  bm.historico = null;
  fecharDrawer();
  destruirGraficosBonificacao();
});

const podeLancar = () => pode("bonificacao_mensal.lancar");
const podeExcluir = () => pode("bonificacao_mensal.excluir");
const podeConfigurar = () => pode("bonificacao_mensal.configurar");
const vazio = (emoji, titulo, msg, extra = "") =>
  `<div class="estado"><span class="emoji">${emoji}</span><h3>${escapeHtml(titulo)}</h3><p>${escapeHtml(msg)}</p>${extra}</div>`;
const carregando = () => `<div class="estado"><div class="spinner"></div>Carregando…</div>`;
const fmtDataBr = (iso) => iso?.split("-").reverse().join("/") ?? "—";

function fmtValor(valor, tipo) {
  if (valor == null) return "—";
  if (tipo === "moeda") return fmtMoeda(valor);
  if (tipo === "pct") return fmtPct(valor);
  if (tipo === "nota") return Number(valor).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  return Number(valor).toLocaleString("pt-BR");
}

export async function renderBonificacaoMensal() {
  const view = el("#view");
  if (!view) return;
  view.innerHTML = carregando();
  const unidadeNome = state.sessao?.unidade?.nome;
  if (!state.sessao?.unidade?.id) {
    view.innerHTML = vazio("🏪", "Selecione uma unidade", "A Bonificação Mensal é por unidade. Selecione uma unidade no seletor de contexto para continuar.");
    return;
  }
  montarLayout(unidadeNome);
  await carregarConteudo();
}

function montarLayout(unidadeNome) {
  const view = el("#view");
  const anos = anosDisponiveis();
  view.innerHTML = `
    <div class="bm-topo">
      <div class="dex-head-txt">
        <h2><img src="/assets/menu-bonificacao-mensal.png" alt="" class="dex-logo" /> Bonificação Mensal</h2>
        <p>Sua central de performance: metas, progresso e bonificação da unidade em tempo real.</p>
      </div>
      <div class="bm-filtros">
        <label class="cfg-campo"><span>Mês</span>
          <select id="bm-mes">${MESES.map((m, i) => `<option value="${i + 1}" ${i + 1 === bm.mes ? "selected" : ""}>${m}</option>`).join("")}</select></label>
        <label class="cfg-campo"><span>Ano</span>
          <select id="bm-ano">${anos.map((a) => `<option value="${a}" ${a === bm.ano ? "selected" : ""}>${a}</option>`).join("")}</select></label>
        <span class="bm-unidade-chip">🏪 ${escapeHtml(unidadeNome || "—")}</span>
        ${podeLancar() ? `<button class="btn btn-primary btn-sm" id="bm-importar-visio">⬆️ Importar Visio</button>` : ""}
      </div>
    </div>
    <nav class="dex-nav" aria-label="Seções da Bonificação Mensal">
      ${ABAS.map((a) => `<button class="dex-tab ${a.id === bm.aba ? "ativo" : ""}" data-aba="${a.id}"><span>${a.icon}</span> ${a.label}</button>`).join("")}
    </nav>
    <div id="bm-conteudo" class="bm-conteudo"></div>`;

  el("#bm-mes").addEventListener("change", (e) => { bm.mes = Number(e.target.value); carregarConteudo(); });
  el("#bm-ano").addEventListener("change", (e) => { bm.ano = Number(e.target.value); carregarConteudo(); });
  el("#bm-importar-visio")?.addEventListener("click", () => abrirImportarVisioModal({ unidadeNome, mesAtual: bm.mes, anoAtual: bm.ano, onSalvo: carregarConteudo }));
  view.querySelectorAll(".dex-tab").forEach((b) => b.addEventListener("click", () => irParaAba(b.dataset.aba)));
}

function anosDisponiveis() {
  const atual = hoje.getFullYear();
  const lista = [];
  for (let a = atual + 1; a >= atual - 3; a--) lista.push(a);
  return lista;
}

function irParaAba(aba) {
  bm.aba = aba;
  el("#view")?.querySelectorAll(".dex-tab").forEach((b) => b.classList.toggle("ativo", b.dataset.aba === aba));
  renderAbaAtual();
}

async function carregarConteudo() {
  const box = el("#bm-conteudo");
  if (!box) return;
  box.innerHTML = carregando();
  destruirGraficosBonificacao();
  const g = geracaoContexto();
  try {
    const [{ data: mesData }, { data: metasData }] = await Promise.all([bonifMes({ mes: bm.mes, ano: bm.ano }), bonifMetas()]);
    if (contextoMudou(g)) return; // resposta da unidade anterior — descarta
    bm.dadosMes = mesData;
    bm.metas = metasData;
    verificarNovasFaixas(mesData);
    renderAbaAtual();
  } catch (e) {
    if (contextoMudou(g)) return;
    box.innerHTML = vazio("⚠️", "Erro ao carregar", e.message, `<button class="btn btn-ghost btn-sm" id="bm-retry">Tentar novamente</button>`);
    el("#bm-retry")?.addEventListener("click", carregarConteudo);
  }
}

function renderAbaAtual() {
  const box = el("#bm-conteudo");
  if (!box || !bm.dadosMes) return;
  destruirGraficosBonificacao();
  if (bm.aba === "visao") return renderVisaoGeral(box);
  if (bm.aba === "visio") return renderLancamentos(box);
  if (bm.aba === "rev") return renderRevMensal(box);
  if (bm.aba === "pesquisas") return renderPesquisasTab(box);
  if (bm.aba === "super_restaurante") return renderSuperRestaurante(box);
  if (bm.aba === "metas") return renderMetas(box);
  if (bm.aba === "historico") return renderHistorico(box);
}

// ---------------------------------------------------------------------------
// META VIGENTE (client-side, só pra desenhar linhas/escadas — a AVALIAÇÃO
// oficial de cada indicador já vem pronta em d.indicadores, calculada no
// backend. Isto aqui só espelha a mesma regra de vigência p/ exibir as
// faixas completas de um indicador).
// ---------------------------------------------------------------------------
function metaDoIndicador(indicador) {
  const candidatas = (bm.metas || []).filter((m) => m.indicador === indicador);
  if (!candidatas.length) return null;
  const refIso = `${bm.ano}-${String(bm.mes).padStart(2, "0")}-01`;
  const vigentes = candidatas.filter((m) => m.validFrom <= refIso && (!m.validUntil || m.validUntil >= refIso));
  if (!vigentes.length) return candidatas[candidatas.length - 1];
  return vigentes.reduce((melhor, m) => (!melhor || m.validFrom > melhor.validFrom ? m : melhor), null);
}

// ---------------------------------------------------------------------------
// EMPTY STATE (item 20)
// ---------------------------------------------------------------------------
function mesTemDados(d) {
  if (d.congelado) return true; // competência fechada: resultado congelado, sempre tem dado
  return d.calendario.some((dia) => dia.status !== "PENDENTE" && dia.status !== "FUTURO");
}

function emptyStateHtml(unidadeNome) {
  return `<section class="bm-empty">
    <span class="bm-empty-icone">📊</span>
    <h3>Comece importando os dados da Visio</h3>
    <p>Importe os relatórios <b>Geral</b> e <b>Loja</b> para visualizar faturamento, mix de vendas, metas, projeções e a bonificação de ${escapeHtml(unidadeNome || "sua unidade")}.</p>
    ${podeLancar() ? `<button class="btn btn-primary" id="bm-empty-importar">⬆️ Importar Visio</button>` : ""}
  </section>`;
}

// ---------------------------------------------------------------------------
// COR POR STATUS (item 2) — heurística só de EXIBIÇÃO, não altera nenhuma
// regra de negócio: vermelho fica reservado a indicadores "menor é melhor"
// realmente estourados; "ainda não atingiu uma faixa" NUNCA é vermelho por
// padrão (é normal em qualquer ponto do mês).
// ---------------------------------------------------------------------------
function corIndicador(res, meta) {
  if (res.status === "sem_dados" || res.status === "sem_meta") return "neutro";
  if (res.status === "meta_maxima") return "sucesso";
  if (res.status === "dentro_da_meta") return res.bonusAtual > 0 ? "sucesso" : "institucional";
  // meta_nao_atingida:
  if (meta?.direcao === "lower_is_better") {
    const piorFaixa = [...(meta.faixas || [])].sort((a, b) => a.ordem - b.ordem)[0];
    const limite = piorFaixa?.valorMax ?? piorFaixa?.valorMin;
    if (limite != null && res.valorAtual != null && res.valorAtual > limite * 1.25) return "critico";
  }
  return "institucional";
}
const PILL_DA_COR = { neutro: "muted", institucional: "info", sucesso: "ok", atencao: "warn", critico: "bad" };
const HEX_DA_COR = { neutro: "#9AA5A0", institucional: "#3B82C4", sucesso: "#0f8a4c", atencao: "#c48a12", critico: "#DB3B3B" };

// ---------------------------------------------------------------------------
// "NOVA FAIXA ATINGIDA" (item 19) — comparado com o que já foi visto neste
// navegador (localStorage), por unidade+mês+indicador. Nunca reabre em outra
// aba/dispositivo por conta própria — é só um feedback local de sessão.
// ---------------------------------------------------------------------------
function verificarNovasFaixas(d) {
  const unidadeId = state.sessao?.unidade?.id;
  if (!unidadeId) return;
  const base = `bm:faixa:${unidadeId}:${d.ano}-${d.mes}:`;
  for (const [indicador, res] of Object.entries(d.indicadores)) {
    const chave = base + indicador;
    const ordemAtual = res.faixaAtual?.ordem ?? 0;
    const bruto = localStorage.getItem(chave);
    if (bruto != null && ordemAtual > Number(bruto) && res.bonusAtual > 0) {
      mostrarNovaFaixaToast(indicador, res, Number(bruto));
    }
    localStorage.setItem(chave, String(ordemAtual));
  }
}

function mostrarNovaFaixaToast(indicador, res, ordemAnterior) {
  const meta = INDICADOR[indicador]; if (!meta) return;
  const bonusAnterior = ordemAnterior > 0 ? "faixa anterior" : "R$ 0";
  const banner = document.createElement("div");
  banner.className = "bm-conquista-toast";
  banner.innerHTML = `<span class="bm-conquista-emoji">${icon("award", { size: 22 })}</span>
    <div><b>Nova faixa alcançada!</b><br>${escapeHtml(meta.label)} chegou a ${fmtValor(res.valorAtual, meta.tipo)}.<br>
    <span class="bm-conquista-bonus">Bonificação: ${bonusAnterior} → ${fmtMoeda(res.bonusAtual)}</span></div>
    <button class="bm-conquista-fechar" aria-label="Fechar">×</button>`;
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add("show"));
  const remover = () => { banner.classList.remove("show"); setTimeout(() => banner.remove(), 300); };
  banner.querySelector(".bm-conquista-fechar").addEventListener("click", remover);
  setTimeout(remover, 7000);
}

// ---------------------------------------------------------------------------
// ABA 1 — VISÃO GERAL
// ---------------------------------------------------------------------------
function renderVisaoGeral(box) {
  const d = bm.dadosMes;

  if (!mesTemDados(d)) {
    box.innerHTML = emptyStateHtml(d.unidade?.nome);
    box.querySelector("#bm-empty-importar")?.addEventListener("click", () => el("#bm-importar-visio")?.click());
    return;
  }

  box.innerHTML = `
    ${heroHtml(d)}
    ${elegibilidadeBonificacaoHtml(d)}
    ${superRestauranteVisaoGeralHtml(d)}
    ${evolucaoFaturamentoHtml(d)}
    ${proximasConquistasHtml(d)}
    ${fechamentoMensalHtml(d)}
    ${grupoHtml(d, GRUPOS[0])}
    ${evolucaoMixHtml(d)}
    ${grupoHtml(d, GRUPOS[1])}
    ${alertasHtml(d)}
  `;

  const faixasFaturamento = metaDoIndicador("faturamento")?.faixas ?? [];
  graficoEvolucaoFaturamento("bm-chart-faturamento", { calendario: d.calendario, faixas: faixasFaturamento, mediaDiariaValida: d.faturamento.mediaDiariaValida });
  graficoEvolucaoMix("bm-chart-mix", d.calendario);

  // count-up dos números do hero (item 18)
  countUp(box.querySelector("#bm-hero-atual"), d.resumo.bonificacaoAtual ?? 0, { formatar: (v) => fmtMoeda(v) });
  requestAnimationFrame(() => { box.querySelector(".bm-hero-barra-fill")?.classList.add("preenchida"); });

  box.querySelector("#bm-importar-visio-2")?.addEventListener("click", () => el("#bm-importar-visio")?.click());
  wireFechamentoMensal(box);
  // Os 3 cards do Super Restaurante (Nota iFood/Cancelamentos/Pedidos com
  // Chamado) não têm mais aba própria — todos abrem o lançamento diário num
  // drawer, sem sair da Visão Geral.
  box.querySelectorAll("[data-criterio]").forEach((elCard) => elCard.addEventListener("click", () => abrirDrawerIndicadorManual(elCard.dataset.criterio)));
}

// ---------------------------------------------------------------------------
// ESTADO DO FECHAMENTO MENSAL (arquitetura v3.1). Sem comparação entre fontes:
// durante o mês os indicadores usam os dados disponíveis da competência;
// quando os dois relatórios mensais da Visio são importados e o fechamento é
// confirmado, a competência congela. A importação vive no modal "Importar
// Visio". Redesenho visual completo desta área = F7.
// ---------------------------------------------------------------------------
function fechamentoMensalHtml(d) {
  const comp = `${MESES[d.mes - 1]}/${d.ano}`;
  const fechada = d.congelado === true;
  const pill = fechada
    ? `<span class="pill ok">Competência fechada</span>`
    : `<span class="pill info">Fechamento mensal pendente</span>`;
  const linha = fechada
    ? `<p class="bm-vazio-inline">Resultado congelado do fechamento mensal de ${escapeHtml(comp)}.</p>`
    : `<p class="bm-vazio-inline">Os indicadores usam os dados disponíveis da competência. Importe o fechamento mensal para consolidar ${escapeHtml(comp)}.</p>`;
  const acao = (!fechada && podeLancar())
    ? `<div class="ed-acoes"><button class="btn btn-primary btn-sm" id="bm-fm-importar">📆 Importar fechamento mensal</button></div>`
    : "";

  return `<section class="bm-secao" id="bm-fechamento-mensal">
    <h3 class="bm-secao-titulo">📆 Fechamento mensal — ${escapeHtml(comp)} ${pill}</h3>
    <div class="bm-card">${linha}${acao}</div>
  </section>`;
}

function wireFechamentoMensal(box) {
  box.querySelector("#bm-fm-importar")?.addEventListener("click", () => abrirImportarVisioModal({
    unidadeNome: state.sessao?.unidade?.nome, mesAtual: bm.mes, anoAtual: bm.ano,
    onSalvo: carregarConteudo, modo: "mensal",
  }));
}

// ---------- HERO ----------
function heroHtml(d) {
  const r = d.resumo;
  const semRegra = r.bonificacaoMaxima <= 0;
  const pct = r.progressoPct ?? 0;
  const badge = d.mesFechado ? `<span class="pill ok">Resultado final</span>` : `<span class="pill info">Projeção do mês</span>`;

  const criticos = Object.entries(d.indicadores).filter(([k, res]) => corIndicador(res, metaDoIndicador(k)) === "critico").length;
  const emProgresso = Object.values(d.indicadores).filter((res) => res.status === "meta_nao_atingida").length;

  const projecaoBonus = null; // bonificação não tem projeção própria calculada no backend — só o faturamento tem; deixamos claro que o valor do hero é o ATUAL, nunca inventado.

  return `<section class="bm-hero">
    <div class="bm-hero-principal">
      <div class="bm-hero-topo"><span class="bm-hero-rotulo">Bonificação ${d.mesFechado ? "conquistada" : "atual"}</span>${badge}</div>
      <div class="bm-hero-valor" id="bm-hero-atual">${fmtMoeda(0)}</div>
      <div class="bm-hero-sub">de <b>${fmtMoeda(r.bonificacaoMaxima)}</b> possíveis${semRegra ? "" : ` · ${fmtPct(pct)}`}</div>
      ${r.bonificacaoBruta > r.bonificacaoAtual ? `<p class="bm-hero-nota">Calculado pelos indicadores comerciais/operacionais: <b>${fmtMoeda(r.bonificacaoBruta)}</b> — não pago porque um ou mais critérios obrigatórios de elegibilidade (Nota iFood, REV ou Pesquisas) não foram atendidos neste período.</p>` : ""}
      <div class="bm-hero-barra"><div class="bm-hero-barra-fill" style="--pct:${Math.max(2, Math.min(100, pct))}%"></div></div>
      <div class="bm-caminho">
        <span class="bm-caminho-ponta">R$ 0</span>
        <div class="bm-caminho-trilho">
          <div class="bm-caminho-marca atual" style="left:${Math.min(96, pct)}%" title="Atual: ${fmtMoeda(r.bonificacaoAtual)}"></div>
        </div>
        <span class="bm-caminho-ponta">${fmtMoeda(r.bonificacaoMaxima)}</span>
      </div>
    </div>
    <div class="bm-hero-stats">
      <div class="bm-hero-stat"><b>${r.metasAtingidas}</b><span>de ${r.metasComRegra} metas atingidas</span></div>
      <div class="bm-hero-stat"><b>${emProgresso}</b><span>em progresso</span></div>
      <div class="bm-hero-stat ${criticos ? "critico" : ""}"><b>${criticos}</b><span>críticas</span></div>
    </div>
  </section>`;
}

// ---------- EVOLUÇÃO DO FATURAMENTO ----------
function evolucaoFaturamentoHtml(d) {
  const f = d.faturamento;
  const fi = d.indicadores.faturamento;
  const meta = metaDoIndicador("faturamento");
  const ritmo = f.ritmoNecessarioProximaFaixa;
  return `<section class="bm-secao">
    <h3 class="bm-secao-titulo">📈 Evolução do Faturamento</h3>
    <div class="bm-fat-grid">
      <div class="bm-card bm-chart-card"><canvas id="bm-chart-faturamento" height="260"></canvas></div>
      <div class="bm-card bm-fat-resumo">
        <div class="bm-fat-linha"><span>Acumulado</span><b>${fmtMoeda(f.acumulado)}</b></div>
        <div class="bm-fat-linha"><span>${d.mesFechado ? "Resultado" : "Projeção de fechamento"}</span><b>${fmtMoeda(f.projecao)}</b></div>
        ${fi.proximaFaixa ? `
          <div class="bm-fat-linha"><span>Próxima meta</span><b>${fmtMoeda(fi.proximaFaixa.valorMin)}</b></div>
          <div class="bm-fat-linha"><span>Faltam</span><b>${fmtMoeda(Math.abs(fi.faltante))}</b></div>
          ${ritmo != null && f.diasRestantes > 0 ? `<p class="bm-fat-ritmo">Ritmo necessário: <b>${fmtMoeda(ritmo)}/dia</b> nos próximos ${f.diasRestantes} dias.</p>` : ""}
        ` : fi.status === "meta_maxima" ? `<p class="bm-fat-ritmo">🎉 Faixa máxima de faturamento atingida.</p>` : `<p class="bm-fat-ritmo">Sem meta de faturamento vigente.</p>`}
        ${escadaFaixas({ faixas: meta?.faixas ?? [], faixaAtualOrdem: fi.faixaAtual?.ordem ?? null, fmt: (v) => fmtMoeda(v) })}
      </div>
    </div>
  </section>`;
}

// ---------- PRÓXIMAS CONQUISTAS ----------
function proximidadeRelativa(res, meta) {
  if (res.status !== "meta_nao_atingida" || !res.proximaFaixa) return -1;
  const alvo = res.proximaFaixa.valorMin ?? res.proximaFaixa.valorMax;
  const faixaAnterior = meta?.faixas?.find((f) => f.ordem === res.proximaFaixa.ordem - 1);
  const base = faixaAnterior ? (faixaAnterior.valorMin ?? faixaAnterior.valorMax) : (meta?.direcao === "higher_is_better" ? 0 : alvo * 2);
  const vao = Math.abs(alvo - base);
  if (!vao) return 0;
  return Math.max(0, Math.min(1, 1 - Math.abs(res.faltante) / vao));
}

function proximasConquistasHtml(d) {
  const candidatos = Object.entries(d.indicadores)
    .map(([chave, res]) => ({ chave, res, meta: metaDoIndicador(chave), prox: proximidadeRelativa(res, metaDoIndicador(chave)) }))
    .filter((c) => c.prox >= 0 && c.res.bonusProximaFaixa != null)
    .sort((a, b) => b.prox - a.prox)
    .slice(0, 4);

  if (!candidatos.length) {
    return `<section class="bm-secao"><h3 class="bm-secao-titulo">🎯 Próximas conquistas</h3>
      <p class="bm-vazio-inline">Sem conquistas pendentes com dado suficiente no momento — as metas com dado já estão na faixa máxima ou ainda não têm valor lançado.</p></section>`;
  }
  return `<section class="bm-secao">
    <h3 class="bm-secao-titulo">🎯 Próximas conquistas</h3>
    <div class="bm-conquistas">
      ${candidatos.map(({ chave, res }) => {
        const info = INDICADOR[chave];
        return `<div class="bm-conquista-card">
          <div class="bm-conquista-topo"><span>${info.icon}</span> ${info.label}</div>
          <div class="bm-conquista-valores">${fmtValor(res.valorAtual, info.tipo)} <span class="seta">→</span> ${fmtValor(res.proximaFaixa.valorMin ?? res.proximaFaixa.valorMax, info.tipo)}</div>
          <div class="bm-conquista-barra"><div style="width:${(proximidadeRelativa(res, metaDoIndicador(chave)) * 100).toFixed(0)}%"></div></div>
          <div class="bm-conquista-baixo"><span>Faltam ${fmtValor(Math.abs(res.faltante), info.tipo)}</span><b>+${fmtMoeda(res.bonusProximaFaixa)}</b></div>
        </div>`;
      }).join("")}
    </div>
  </section>`;
}

// ---------- GRUPOS (Performance Comercial / Eficiência Operacional) ----------
function grupoHtml(d, grupo) {
  const cards = grupo.indicadores.map((chave) => {
    const res = d.indicadores[chave];
    const meta = metaDoIndicador(chave);
    if (chave === "cmv") return cardCmv(d, res, meta);
    if (chave === "ticket_medio" || chave === "rev") return cardRegua(chave, res, meta);
    return cardGauge(chave, res, meta, d);
  }).join("");
  return `<section class="bm-secao">
    <h3 class="bm-secao-titulo">${grupo.icon} ${grupo.titulo}</h3>
    <div class="bm-grid-cards">${cards}</div>
  </section>`;
}

function dadosGauge(res) {
  const faixas = [res.faixaAtual, res.proximaFaixa, res.faixaMaxima].filter(Boolean);
  const limites = faixas.flatMap((f) => [f.valorMin, f.valorMax]).filter((v) => v != null);
  if (!limites.length || res.valorAtual == null) return null;
  const min = Math.min(...limites, res.valorAtual), max = Math.max(...limites, res.valorAtual);
  if (max === min) return null;
  const marcos = faixas.map((f) => {
    const alvo = f.valorMin != null ? f.valorMin : f.valorMax;
    return { fracao: (alvo - min) / (max - min), titulo: `${alvo} · ${f.bonus == null ? "sem valor" : "R$ " + f.bonus}`, atingido: res.faixaAtual && f.ordem <= res.faixaAtual.ordem };
  });
  return { min, max, marcos };
}

function cardGauge(chave, res, meta, d) {
  const info = INDICADOR[chave];
  const cor = corIndicador(res, meta);
  if (res.status === "sem_dados" || res.status === "sem_meta") {
    return `<div class="bm-card bm-gauge-card neutro"><div class="bm-card-topo"><span>${info.icon}</span> ${info.label}</div>
      <p class="bm-vazio-inline">Dados não informados</p>${fonteHtml(chave, d)}</div>`;
  }
  const g = dadosGauge(res);
  return `<div class="bm-card bm-gauge-card">
    <div class="bm-card-topo"><span>${info.icon}</span> ${info.label} <span class="pill ${PILL_DA_COR[cor]}">${rotuloStatus(res)}</span></div>
    ${g ? gaugeSvg({ valorAtual: res.valorAtual, min: g.min, max: g.max, marcos: g.marcos, cor: HEX_DA_COR[cor] }) : ""}
    <div class="bm-gauge-valor">${fmtValor(res.valorAtual, info.tipo)}</div>
    <div class="bm-gauge-detalhe">
      <span>Faixa atual: <b>${res.bonusAtual == null ? "—" : fmtMoeda(res.bonusAtual)}</b></span>
      ${res.proximaFaixa ? `<span>Próxima: <b>${fmtValor(res.proximaFaixa.valorMin ?? res.proximaFaixa.valorMax, info.tipo)}</b> (+${fmtMoeda(res.bonusProximaFaixa)}) · faltam ${fmtValor(Math.abs(res.faltante), info.tipo)}</span>` : `<span>Faixa máxima atingida 🎉</span>`}
    </div>
    ${fonteHtml(chave, d)}
  </div>`;
}

function cardCmv(d, res, meta) {
  const info = INDICADOR.cmv;
  const cor = corIndicador(res, meta);
  const valores = d.calendario.map((dia) => dia.lancamento?.cmvPct ?? null);
  const tend = tendencia(valores, { menorMelhor: true });
  if (res.status === "sem_dados" || res.status === "sem_meta") {
    return `<div class="bm-card bm-gauge-card neutro"><div class="bm-card-topo"><span>${info.icon}</span> ${info.label}</div>
      <p class="bm-vazio-inline">Dados não informados (lançamento manual)</p></div>`;
  }
  const g = dadosGauge(res);
  return `<div class="bm-card bm-gauge-card">
    <div class="bm-card-topo"><span>${info.icon}</span> ${info.label} <span class="pill ${PILL_DA_COR[cor]}">${rotuloStatus(res)}</span></div>
    ${g ? gaugeSvg({ valorAtual: res.valorAtual, min: g.min, max: g.max, marcos: g.marcos, cor: HEX_DA_COR[cor] }) : ""}
    <div class="bm-gauge-valor">${fmtValor(res.valorAtual, info.tipo)} <span class="bm-menor-melhor">quanto menor, melhor</span></div>
    ${sparklineSvg(valores) ? `<div class="bm-card-spark">${sparklineSvg(valores, { cor: HEX_DA_COR[cor] })}${tend ? `<span class="bm-tendencia ${tend.direcao}">${tend.icone} ${tend.label}</span>` : ""}</div>` : ""}
    <div class="bm-gauge-detalhe">
      <span>Faixa atual: <b>${res.bonusAtual == null ? "—" : fmtMoeda(res.bonusAtual)}</b></span>
      ${res.proximaFaixa ? `<span>Próxima: <b>${fmtValor(res.proximaFaixa.valorMin ?? res.proximaFaixa.valorMax, info.tipo)}</b> (+${fmtMoeda(res.bonusProximaFaixa)}) · faltam ${fmtValor(Math.abs(res.faltante), info.tipo)}</span>` : `<span>Faixa máxima atingida 🎉</span>`}
    </div>
    ${fonteHtml("cmv")}
  </div>`;
}

// Ticket Médio / REV — régua horizontal simples (atual x meta), item 13.
function cardRegua(chave, res, meta) {
  const info = INDICADOR[chave];
  const cor = corIndicador(res, meta);
  if (res.status === "sem_dados" || res.status === "sem_meta") {
    return `<div class="bm-card bm-regua-card neutro"><div class="bm-card-topo"><span>${info.icon}</span> ${info.label}</div>
      <p class="bm-vazio-inline">Dados não informados</p>${fonteHtml(chave)}</div>`;
  }
  const alvo = res.proximaFaixa ? (res.proximaFaixa.valorMin ?? res.proximaFaixa.valorMax) : null;
  const g = dadosGauge(res);
  const pct = g ? Math.max(2, Math.min(100, ((res.valorAtual - g.min) / (g.max - g.min)) * 100)) : (res.status === "meta_maxima" ? 100 : 8);
  return `<div class="bm-card bm-regua-card">
    <div class="bm-card-topo"><span>${info.icon}</span> ${info.label} <span class="pill ${PILL_DA_COR[cor]}">${rotuloStatus(res)}</span></div>
    <div class="bm-regua-valor">${fmtValor(res.valorAtual, info.tipo)}</div>
    <div class="bm-regua-barra"><div style="width:${pct}%; background:${HEX_DA_COR[cor]}"></div>${(g?.marcos ?? []).map((m) => `<span class="bm-regua-marco" style="left:${Math.max(0, Math.min(100, m.fracao * 100))}%"></span>`).join("")}</div>
    <div class="bm-gauge-detalhe">
      ${alvo != null ? `<span>Meta: <b>${fmtValor(alvo, info.tipo)}</b> · faltam ${fmtValor(Math.abs(res.faltante), info.tipo)}</span>` : `<span>Faixa máxima atingida 🎉</span>`}
    </div>
    ${fonteHtml(chave)}
  </div>`;
}

function rotuloStatus(res) {
  return { sem_dados: "Sem dados", sem_meta: "Sem meta", meta_nao_atingida: "Em progresso", dentro_da_meta: "Dentro da meta", meta_maxima: "Máxima" }[res.status] ?? res.status;
}

// ---------- EVOLUÇÃO DO MIX ----------
function evolucaoMixHtml(d) {
  const temDado = d.calendario.some((dia) => dia.lancamento?.mix?.bebidas != null);
  return `<section class="bm-secao">
    <h3 class="bm-secao-titulo">🥤 Evolução do Mix de Vendas</h3>
    <div class="bm-card bm-chart-card">
      ${temDado ? `<canvas id="bm-chart-mix" height="220"></canvas>` : `<p class="bm-vazio-inline">Ainda sem dias suficientes com Relatório Loja importado para traçar a evolução.</p>`}
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// ELEGIBILIDADE DA BONIFICAÇÃO — tri-state (Elegível/Em acompanhamento/Não
// elegível) dos 3 critérios obrigatórios (Nota iFood + REV + Pesquisas).
// Conceito DIFERENTE do agrupamento visual "Super Restaurante" logo abaixo
// (que é só Nota iFood + Cancelamentos + Pedidos com Chamado, sem travar
// nada). Linguagem sempre consultiva — as frases prontas vêm do backend
// (bonificacaoMensal.elegibilidade.js), fonte única da regra; aqui só se
// decide COR e LAYOUT, nunca o texto do motivo.
// ---------------------------------------------------------------------------
const STATUS_ELEGIBILIDADE_TXT = {
  elegivel: { titulo: "Elegível", classe: "sucesso", desc: "Todos os critérios obrigatórios do período foram alcançados." },
  nao_elegivel: { titulo: "Não elegível", classe: "atencao" },
  em_acompanhamento: { titulo: "Em acompanhamento", classe: "institucional", desc: "O mês ainda está aberto — os critérios ainda podem ser atingidos até o fechamento da competência." },
};
const ELEGIBILIDADE_ROTULO = { elegivel: "Elegível", em_acompanhamento: "Em acompanhamento", nao_elegivel: "Não elegível" };

function elegibilidadeBonificacaoHtml(d) {
  const el = d.elegibilidade;
  const txt = STATUS_ELEGIBILIDADE_TXT[el.status];
  const motivosHtml = el.motivosInelegibilidade.length
    ? `<ul class="bm-motivos">${el.motivosInelegibilidade.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul>` : "";
  const descNaoElegivel = el.status === "nao_elegivel"
    ? `${el.motivosInelegibilidade.length} critério${el.motivosInelegibilidade.length === 1 ? "" : "s"} obrigatório${el.motivosInelegibilidade.length === 1 ? "" : "s"} não ${el.motivosInelegibilidade.length === 1 ? "foi" : "foram"} alcançado${el.motivosInelegibilidade.length === 1 ? "" : "s"} (Nota iFood, REV e Pesquisas).`
    : txt.desc;

  return `<section class="bm-secao">
    <h3 class="bm-secao-titulo">🎯 Elegibilidade da Bonificação</h3>
    <div class="bm-card bm-elegibilidade ${txt.classe}">
      <div class="bm-card-topo"><span>Nota iFood + REV + Pesquisas</span></div>
      <div class="bm-elegibilidade-titulo">${txt.titulo}</div>
      <p class="bm-vazio-inline">${descNaoElegivel}</p>
      ${motivosHtml}
      ${el.status !== "elegivel" ? `<p class="bm-vazio-inline bm-motivos-nota">O não atingimento de qualquer critério obrigatório torna a unidade inelegível à bonificação deste período.</p>` : ""}
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// SUPER RESTAURANTE — agrupamento "Ifood: Super Restaurante" da planilha:
// Avaliação (Nota) iFood + Cancelamentos + Pedidos com Chamado, exatos 3
// indicadores, nada além disso (Pesquisas NÃO entra aqui — é critério
// próprio da Bonificação Mensal, ver renderPesquisasTab). Só o agrupamento
// visual: sem pontuação própria, sem média entre os três, sem percentual
// geral — o backend (avaliarSuperRestaurante) só devolve a contagem "X de 3
// dentro da meta" + pontos de atenção discretos.
// ---------------------------------------------------------------------------
const TITULO_CARD_SUPER_RESTAURANTE = { avaliacao_ifood: "Avaliação iFood", cancelamentos: "Cancelamentos", pedidos_chamado: "Pedidos com Chamado" };
const INDICADORES_SUPER_RESTAURANTE = ["avaliacao_ifood", "cancelamentos", "pedidos_chamado"];

/** Normaliza o resultado do motor de faixas (cancelamentos/pedidos_chamado, que continuam no sistema de faixas de sempre) pro mesmo formato {valor,minimo,atingido} dos critérios de elegibilidade/Super Restaurante. */
function criterioDeIndicador(res) {
  const f = res.faixaAtual || res.proximaFaixa || res.faixaMaxima || null;
  const minimo = f ? (f.valorMin ?? f.valorMax ?? null) : null;
  const atingido = res.status === "sem_dados" || res.status === "sem_meta" ? null : res.status !== "meta_nao_atingida";
  return { valor: res.valorAtual, minimo, atingido };
}

function cardCriterio({ chave, info, criterio, clicavel, titulo, comBarraProgresso }) {
  const { valor, minimo, atingido } = criterio;
  const rotuloMeta = info.direcao === "lower_is_better" ? "Meta máxima" : "Meta mínima";
  // Nunca "crítico" (vermelho) aqui de propósito — o pior estado visual de
  // um critério obrigatório é "atenção", nunca a cor reservada pra problema
  // real do restante do painel.
  const cor = atingido === true ? "sucesso" : atingido === false ? "atencao" : "neutro";
  const statusTxt = atingido === true ? "✓ Critério atingido" : atingido === false ? "Critério não atingido" : (minimo == null ? "Sem meta cadastrada" : "Ainda sem dado no período");

  // Só quem ACUMULA ao longo do mês (Pesquisas) ganha barra de progresso —
  // os demais são um valor fechado do período; uma barra ali sugeriria um
  // "andamento" que não existe de verdade.
  let barra = "";
  if (comBarraProgresso && minimo != null && valor != null && atingido !== true) {
    const pctMeta = Math.max(0, Math.min(100, (valor / minimo) * 100));
    barra = `<div class="bm-regua-barra"><div style="width:${pctMeta}%; background:${HEX_DA_COR[cor]}"></div></div>
      <p class="bm-vazio-inline">${fmtPct(pctMeta)} da meta mensal · faltam ${Math.max(0, Math.ceil(minimo - valor))} pesquisas</p>`;
  }

  return `<div class="bm-card bm-criterio-card ${cor}" ${clicavel ? `data-criterio="${chave}" role="button" tabindex="0"` : ""}>
    <div class="bm-card-topo"><span>${info.icon}</span> ${titulo ?? info.label}</div>
    <div class="bm-gauge-valor">${fmtValor(valor, info.tipo)}</div>
    ${barra}
    <div class="bm-gauge-detalhe">
      ${minimo != null ? `<span>${rotuloMeta}: <b>${fmtValor(minimo, info.tipo)}</b></span>` : ""}
      <span class="pill ${PILL_DA_COR[cor]}">${statusTxt}</span>
    </div>
  </div>`;
}

/** Conteúdo comum aos dois pontos onde o Super Restaurante aparece (Visão Geral e a aba própria) — nunca duplicar a regra de exibição. */
function superRestauranteBlocoHtml(d) {
  const sr = d.superRestaurante;
  const cards = INDICADORES_SUPER_RESTAURANTE.map((chave) => {
    const info = INDICADOR[chave];
    const criterio = chave === "avaliacao_ifood" ? d.elegibilidade.criterios.nota_ifood : sr.criterios[chave];
    return cardCriterio({ chave, info, criterio, clicavel: true, titulo: TITULO_CARD_SUPER_RESTAURANTE[chave] });
  }).join("");

  const total = sr.totalComMeta || INDICADORES_SUPER_RESTAURANTE.length;
  const resumoClasse = sr.totalComMeta > 0 && sr.dentroDaMeta === sr.totalComMeta ? "sucesso" : sr.pontosDeAtencao.length ? "atencao" : "neutro";
  const pontosHtml = sr.pontosDeAtencao.length
    ? `<ul class="bm-motivos">${sr.pontosDeAtencao.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` : "";

  return `<div class="bm-grid-cards">${cards}</div>
    <p class="bm-super-resumo ${resumoClasse}">${sr.dentroDaMeta} de ${total} indicador${total === 1 ? "" : "es"} dentro da meta</p>
    ${pontosHtml}`;
}

function superRestauranteVisaoGeralHtml(d) {
  return `<section class="bm-secao" id="bm-super-restaurante">
    <h3 class="bm-secao-titulo">🌟 Super Restaurante</h3>
    ${superRestauranteBlocoHtml(d)}
  </section>`;
}

function renderSuperRestaurante(box) {
  const d = bm.dadosMes;
  box.innerHTML = `<section class="bm-secao">
    <h3 class="bm-secao-titulo">🌟 Super Restaurante — ${MESES[d.mes - 1]}/${d.ano}</h3>
    <p class="bm-vazio-inline">Agrupamento que a operação já usa na planilha ("Ifood: Super Restaurante"): Avaliação iFood, Cancelamentos e Pedidos com Chamado.</p>
    ${superRestauranteBlocoHtml(d)}
  </section>`;
  box.querySelectorAll("[data-criterio]").forEach((elCard) => elCard.addEventListener("click", () => abrirDrawerIndicadorManual(elCard.dataset.criterio)));
}

// ---------- ALERTAS / AÇÕES ----------
function alertasHtml(d) {
  const pendentes = d.diasPendentes ?? [];
  if (!pendentes.length && !(d.indicadoresAtencao ?? []).length) return "";
  return `<section class="bm-secao">
    <h3 class="bm-secao-titulo">🔔 Alertas e ações</h3>
    <div class="bm-alertas">
      ${pendentes.length ? `<div class="bm-alerta warn"><b>${pendentes.length} dia(s) pendente(s)</b><span>${pendentes.slice(0, 6).map(fmtDataBr).join(", ")}${pendentes.length > 6 ? "…" : ""}</span></div>` : ""}
      ${(d.indicadoresAtencao ?? []).map((chave) => {
        const info = INDICADOR[chave]; if (!info) return "";
        const res = d.indicadores[chave];
        return `<div class="bm-alerta info"><b>${info.icon} ${info.label} ainda não atingiu a 1ª faixa</b><span>Faltam ${fmtValor(Math.abs(res.faltante), info.tipo)} para +${fmtMoeda(res.bonusProximaFaixa)}</span></div>`;
      }).join("")}
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// ABA 2 — LANÇAMENTOS (calendário — preservado; topo com resumo, item 16)
// ---------------------------------------------------------------------------
function renderLancamentos(box) {
  const d = bm.dadosMes;
  const contagem = {};
  for (const dia of d.calendario) contagem[dia.status] = (contagem[dia.status] || 0) + 1;
  const passados = d.calendario.length - (contagem.FUTURO || 0);
  const alimentados = (contagem.IMPORTADO || 0) + (contagem.MANUAL || 0) + (contagem.PARCIAL || 0) + (contagem.SEM_OPERACAO || 0);
  const pctAlimentado = passados > 0 ? (alimentados / passados) * 100 : 0;

  box.innerHTML = `
    <div class="bm-cal-resumo">
      ${STATUS_DIA_LEGENDA.map((s) => `<div class="bm-cal-resumo-item"><span class="pill ${s.classe}">${contagem[s.chave] || 0}</span><small>${s.label}</small></div>`).join("")}
      <div class="bm-cal-resumo-pct"><div class="bm-cal-resumo-barra"><div style="width:${pctAlimentado}%"></div></div><small>${fmtPct(pctAlimentado)} do mês alimentado</small></div>
    </div>
    <section class="dex-cal-wrap">
      <div class="dex-cal">${d.calendario.map((dia) => diaHtml(dia)).join("")}</div>
    </section>`;

  box.querySelectorAll(".dex-cal-dia[data-clicavel]").forEach((elDia) => elDia.addEventListener("click", () => abrirDrawerDia(elDia.dataset.data)));
}

function diaHtml(dia) {
  const s = STATUS_DIA_ROTULO[dia.status] ?? { label: dia.status, classe: "muted" };
  const numero = Number(dia.data.slice(8, 10));
  const clicavel = dia.status !== "FUTURO";
  return `<div class="dex-cal-dia pill ${s.classe}" ${clicavel ? `data-clicavel data-data="${dia.data}" role="button" tabindex="0"` : ""} title="${fmtDataBr(dia.data)} · ${s.label}">
    <span class="dex-cal-num">${numero}</span><span class="dex-cal-status">${s.label}</span>
  </div>`;
}

// ---------- DRAWER de detalhe do dia (item 17) ----------
let drawerEl = null;
// Só o drawer de indicador manual (Nota iFood/Pesquisas) precisa recarregar
// a tela de trás ao fechar — pode ter lançado um dia novo, e o Hero/cards da
// Visão Geral (por trás do drawer) ficariam com o número antigo até um
// F5. O drawer de detalhe do dia já recarrega sozinho a cada ação (ver
// marcarSemOperacao/excluirLancamentoDia), então não precisa disto.
let drawerRecarregarAoFechar = false;
function fecharDrawer() {
  if (!drawerEl) return;
  drawerEl.classList.remove("aberto");
  const alvo = drawerEl;
  setTimeout(() => alvo.remove(), 220);
  drawerEl = null;
  document.removeEventListener("keydown", onEscDrawer);
  if (drawerRecarregarAoFechar) { drawerRecarregarAoFechar = false; carregarConteudo(); }
}
function onEscDrawer(e) { if (e.key === "Escape") fecharDrawer(); }

/** Abre o calendário diário de Nota iFood/Pesquisas num drawer — mesmo renderer de sempre (bonificacaoMensalIndicadorManual.js), só que sem aba própria (item 1). */
async function abrirDrawerIndicadorManual(indicador) {
  fecharDrawer();
  drawerRecarregarAoFechar = true;
  drawerEl = document.createElement("div");
  drawerEl.className = "bm-drawer-overlay";
  drawerEl.innerHTML = `<aside class="bm-drawer bm-drawer-largo"><button class="modal-close" aria-label="Fechar">×</button><div class="bm-drawer-conteudo">${carregando()}</div></aside>`;
  drawerEl.addEventListener("click", (e) => { if (e.target === drawerEl) fecharDrawer(); });
  document.body.appendChild(drawerEl);
  document.addEventListener("keydown", onEscDrawer);
  requestAnimationFrame(() => drawerEl.classList.add("aberto"));
  drawerEl.querySelector(".modal-close").addEventListener("click", fecharDrawer);

  const corpo = drawerEl.querySelector(".bm-drawer-conteudo");
  await renderIndicadorManualTab(corpo, indicador, {
    ano: bm.ano, mes: bm.mes, unidadeNome: state.sessao?.unidade?.nome, podeLancar: podeLancar(),
  });
}

async function abrirDrawerDia(data) {
  fecharDrawer();
  drawerEl = document.createElement("div");
  drawerEl.className = "bm-drawer-overlay";
  drawerEl.innerHTML = `<aside class="bm-drawer"><button class="modal-close" aria-label="Fechar">×</button><div class="bm-drawer-conteudo">${carregando()}</div></aside>`;
  drawerEl.addEventListener("click", (e) => { if (e.target === drawerEl) fecharDrawer(); });
  document.body.appendChild(drawerEl);
  document.addEventListener("keydown", onEscDrawer);
  requestAnimationFrame(() => drawerEl.classList.add("aberto"));
  drawerEl.querySelector(".modal-close").addEventListener("click", fecharDrawer);

  const corpo = drawerEl.querySelector(".bm-drawer-conteudo");
  const g = geracaoContexto();
  try {
    const { data: l } = await bonifLancamento(data);
    // Trocou de unidade com o drawer abrindo: o reset já fechou este drawer.
    // Sem esta guarda, o detalhe do dia da unidade ANTERIOR apareceria por
    // cima da tela da unidade nova.
    if (contextoMudou(g)) return;
    corpo.innerHTML = detalheDiaHtml(data, l);
    corpo.querySelector("#bm-dia-sem-op")?.addEventListener("click", () => marcarSemOperacao(data));
    corpo.querySelector("#bm-dia-excluir")?.addEventListener("click", () => excluirLancamentoDia(data));
  } catch (e) {
    if (contextoMudou(g)) return;
    corpo.innerHTML = vazio("⚠️", "Erro ao carregar o dia", e.message);
  }
}

function detalheDiaHtml(data, l) {
  const botaoSemOp = podeLancar() ? `<button class="btn btn-ghost btn-sm" id="bm-dia-sem-op">🚫 Marcar sem operação</button>` : "";
  // Excluir só existe quando HÁ o que excluir — e é sempre de verdade (DELETE
  // + libera os PDFs importados nesse dia pra reimportação, ver o service).
  const botaoExcluir = (l && podeExcluir())
    ? `<button class="btn btn-perigo btn-sm" id="bm-dia-excluir" title="Apaga este lançamento e libera os PDFs importados nele para reimportar em outra data">🗑️ Excluir lançamento</button>` : "";
  const acoes = (botaoSemOp || botaoExcluir) ? `<div class="ed-acoes">${botaoSemOp}${botaoExcluir}</div>` : "";
  if (!l) return `<h3>${fmtDataBr(data)}</h3><p class="bm-vazio-inline">Nenhum lançamento para este dia ainda.</p>${acoes}`;
  if (l.semOperacao) return `<h3>${fmtDataBr(data)}</h3><span class="pill muted">Sem operação</span><p class="bm-vazio-inline">${escapeHtml(l.motivoSemOperacao || "")}</p>${acoes}`;
  const item = (lbl, val) => `<div class="vd-pv-item"><span>${lbl}</span><b>${val}</b></div>`;
  return `<h3>${fmtDataBr(data)} <span class="pill ${l.origem === "manual" ? "info" : l.origem === "misto" ? "warn" : "ok"}">${l.origem}</span></h3>
    <div class="bm-drawer-bloco"><div class="vd-pv-titulo">Geral</div><div class="vd-pv-grid">
      ${item("Faturamento", fmtMoeda(l.faturamentoGeral))}${item("Ticket Médio", l.ticketMedio != null ? fmtMoeda(l.ticketMedio) : "—")}
      ${item("Cupons válidos", l.cuponsValidosGeral ?? "—")}${item("Cupons de vendas", l.cuponsVendasGeral ?? "—")}
    </div></div>
    <div class="bm-drawer-bloco"><div class="vd-pv-titulo">Loja / Balcão</div><div class="vd-pv-grid">
      ${item("Faturamento", fmtMoeda(l.faturamentoLoja))}${item("PPD", l.ppdLoja ?? "—")}${item("Sanduíches/Saladas", l.qtdSanduichesLoja ?? "—")}
    </div></div>
    <div class="bm-drawer-bloco"><div class="vd-pv-titulo">Mix</div><div class="vd-pv-grid">
      ${item("Bebidas", `${l.qtdBebidasLoja ?? "—"} → ${fmtPct(l.mix.bebidas)}`)}
      ${item("Adicionais", `${l.qtdAdicionaisLoja ?? "—"} → ${fmtPct(l.mix.adicionais)}`)}
      ${item("Diversos", `${l.qtdDiversosLoja ?? "—"} → ${fmtPct(l.mix.diversos)}`)}
    </div></div>
    <p class="bm-vazio-inline">Origem: ${escapeHtml(l.origem)} · Importado em ${fmtDataHora(l.criadoEm)}${l.usuarioNome ? ` · por ${escapeHtml(l.usuarioNome)}` : ""}</p>
    ${acoes}`;
}

async function marcarSemOperacao(data) {
  const motivo = prompt("Motivo de a unidade não ter operado neste dia:");
  if (!motivo) return;
  try {
    await bonifSalvarLancamento({ data, semOperacao: true, motivoSemOperacao: motivo });
    toast("Dia marcado como sem operação.");
    await carregarConteudo();
    await abrirDrawerDia(data);
  } catch (e) { toast("Erro: " + e.message); }
}

/**
 * Exclusão de VERDADE — para corrigir um dia importado errado (ex.: a data
 * do lançamento ficou errada). Libera também os PDFs desse dia pra
 * reimportação (o backend apaga bonificacao_importacoes junto — sem isso, o
 * mesmo arquivo continuaria bloqueado por já ter sido importado antes,
 * mesmo numa data diferente).
 */
async function excluirLancamentoDia(data) {
  const motivo = prompt(`Motivo da exclusão do lançamento de ${fmtDataBr(data)}:\n\n(isso também libera os PDFs importados neste dia para reimportar em outra data)`);
  if (!motivo) return;
  if (!confirm(`Excluir de vez o lançamento de ${fmtDataBr(data)}? Esta ação não pode ser desfeita.`)) return;
  try {
    await bonifExcluirLancamento(data, motivo);
    toast("Lançamento excluído.");
    fecharDrawer();
    await carregarConteudo();
  } catch (e) { toast("Erro: " + e.message); }
}

// ---------------------------------------------------------------------------
// ABA "REV" — critério próprio da Bonificação Mensal (migration 052): 1
// valor por MÊS, não mais por dia. Fica FORA do agrupamento Super
// Restaurante — mantém espaço próprio, junto de Pesquisas.
// ---------------------------------------------------------------------------
function renderRevMensal(box) {
  const d = bm.dadosMes;
  const rev = d.revMensal;
  const meta = metaDoIndicador("rev");
  const minimo = meta?.faixas?.[0]?.valorMin ?? null;
  const criterio = d.elegibilidade.criterios.rev;
  const cor = criterio.atingido === true ? "sucesso" : criterio.atingido === false ? "atencao" : "neutro";
  const statusTxt = criterio.atingido === true ? "✓ Critério atingido" : criterio.atingido === false ? "Critério não atingido" : (minimo == null ? "Sem meta cadastrada" : "Ainda sem dado neste período");

  box.innerHTML = `
    <section class="bm-secao">
      <h3 class="bm-secao-titulo">📶 REV — ${MESES[d.mes - 1]}/${d.ano}</h3>
      <p class="bm-vazio-inline">REV é publicado pela operação uma vez por competência — um valor para o mês inteiro, nunca por dia.</p>
      <div class="bm-card bm-criterio-card ${cor}" style="max-width:360px">
        <div class="bm-card-topo"><span>${INDICADOR.rev.icon}</span> REV do mês</div>
        <div class="bm-gauge-valor">${rev ? fmtValor(rev.valor, "nota") : "—"}</div>
        <div class="bm-gauge-detalhe">
          ${minimo != null ? `<span>Meta mínima: <b>${fmtValor(minimo, "nota")}</b></span>` : ""}
          <span class="pill ${PILL_DA_COR[cor]}">${statusTxt}</span>
        </div>
        ${rev ? `<p class="bm-vazio-inline">Atualizado em ${fmtDataHora(rev.atualizadoEm)}${rev.usuarioNome ? ` por ${escapeHtml(rev.usuarioNome)}` : ""}</p>` : ""}
        ${podeLancar() ? `<div class="ed-acoes"><button class="btn btn-ghost btn-sm" id="bm-rev-editar">✏️ ${rev ? "Corrigir" : "Lançar"} REV do mês</button></div>` : ""}
      </div>
      <div id="bm-rev-editor"></div>
    </section>
    <section class="bm-secao"><h3 class="bm-secao-titulo">📚 Últimos meses</h3><div id="bm-rev-historico">${carregando()}</div></section>`;

  box.querySelector("#bm-rev-editar")?.addEventListener("click", () => abrirEditorRevMensal(box, rev));
  carregarHistoricoRev(box);
}

function abrirEditorRevMensal(box, revAtual) {
  const area = box.querySelector("#bm-rev-editor");
  if (!area) return;
  area.innerHTML = `<div class="bm-card" style="max-width:360px">
    <h4>✏️ REV — ${MESES[bm.mes - 1]}/${bm.ano}</h4>
    <form id="bm-rev-form" class="cfg-form-grid">
      <label class="cfg-campo"><span>Valor de REV</span>
        <input type="number" step="0.1" min="0" id="bm-rev-valor" value="${revAtual?.valor ?? ""}" placeholder="Ex.: 86" required></label>
      <div class="ed-acoes">
        <button type="button" class="btn btn-ghost" id="bm-rev-cancelar">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar</button>
      </div>
    </form>
  </div>`;
  area.querySelector("#bm-rev-cancelar").addEventListener("click", () => { area.innerHTML = ""; });
  area.querySelector("#bm-rev-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const valor = area.querySelector("#bm-rev-valor").value;
    if (valor === "") return toast("Informe o valor de REV.");
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await bonifSalvarRevMensal({ ano: bm.ano, mes: bm.mes, valor });
      toast("REV do mês salvo ✅");
      await carregarConteudo();
    } catch (err) {
      toast("Erro: " + err.message);
      btn.disabled = false;
    }
  });
  area.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function carregarHistoricoRev(box) {
  const alvo = box.querySelector("#bm-rev-historico");
  if (!alvo) return;
  const g = geracaoContexto();
  try {
    const { data } = await bonifHistorico({ ano: bm.ano });
    if (contextoMudou(g)) return;
    if (!alvo.isConnected) return; // usuário já trocou de aba antes da resposta chegar
    if (!data.length) { alvo.innerHTML = `<p class="bm-vazio-inline">Sem histórico ainda.</p>`; return; }
    // Sem coluna de "critério atingido" por mês de propósito: o mínimo de
    // REV pode ter mudado de vigência entre um mês e outro (item 31 —
    // histórico nunca muda quando a meta futura é editada), então comparar
    // o REV de um mês antigo contra o mínimo de HOJE seria enganoso.
    alvo.innerHTML = `<div class="tabela-wrap"><table class="grid">
      <thead><tr><th>Mês</th><th class="num">REV</th></tr></thead>
      <tbody>${data.map((m) => `<tr><td>${MESES[m.mes - 1]}/${m.ano}</td><td class="num">${fmtValor(m.rev, "nota")}</td></tr>`).join("")}</tbody>
    </table></div>`;
  } catch (e) {
    if (contextoMudou(g)) return;
    alvo.innerHTML = `<p class="bm-vazio-inline">Erro ao carregar histórico: ${escapeHtml(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// ABA "PESQUISAS" — critério próprio da Bonificação Mensal (fora do
// agrupamento Super Restaurante). Acumula ao longo do mês (calendário
// diário, mesmo componente reaproveitado de sempre) — por isso ganha um
// card-resumo do critério de elegibilidade no topo, no mesmo espírito do
// que a aba REV já mostra, seguido do calendário diário completo.
// ---------------------------------------------------------------------------
function renderPesquisasTab(box) {
  const d = bm.dadosMes;
  const criterio = d.elegibilidade.criterios.pesquisas;
  box.innerHTML = `
    <section class="bm-secao">
      <h3 class="bm-secao-titulo">📝 Elegibilidade — Pesquisas do mês</h3>
      <div class="bm-grid-cards" style="max-width:360px">
        ${cardCriterio({ chave: "pesquisas", info: INDICADOR.pesquisas, criterio, clicavel: false, comBarraProgresso: true })}
      </div>
    </section>
    <section class="bm-secao"><div id="bm-pesquisas-detalhe"></div></section>`;
  renderIndicadorManualTab(box.querySelector("#bm-pesquisas-detalhe"), "pesquisas", {
    ano: bm.ano, mes: bm.mes, unidadeNome: state.sessao?.unidade?.nome, podeLancar: podeLancar(),
  });
}

// ---------------------------------------------------------------------------
// ABA 3 — METAS (escada de progressão visual, item 15)
// ---------------------------------------------------------------------------
async function renderMetas(box) {
  const dados = bm.metas;
  if (!dados?.length) { box.innerHTML = vazio("🎯", "Nenhuma meta cadastrada", "Esta unidade ainda não tem metas de bonificação cadastradas."); return; }
  // REV saiu de GRUPOS (tem página própria agora, fora do grid genérico —
  // ver renderRevMensal) mas a META dele continua editável aqui, junto das
  // demais — só entra num grupo próprio pra não sumir da tela de metas.
  const porGrupo = [
    ...GRUPOS,
    { id: "faturamento", titulo: "Faturamento", icon: "💰", indicadores: ["faturamento"] },
    { id: "rev", titulo: "REV", icon: "📶", indicadores: ["rev"] },
  ];
  const aviso = podeConfigurar()
    ? `O histórico de metas anteriores é preservado — editar cria uma NOVA vigência a partir da data escolhida, o mês já vivido continua avaliado pela regra antiga.`
    : `Vigente a partir de ${fmtDataBr(metaDoIndicador("faturamento")?.validFrom)}. Só quem tem a permissão "configurar bonificação" pode alterar metas.`;
  box.innerHTML = `<p class="bm-vazio-inline">${aviso}</p>
    ${porGrupo.map((g) => {
      // metaDoIndicador() resolve a VIGENTE pro mês em exibição (item 10) —
      // nunca pegar a 1ª linha crua de `dados`, que pode ter várias vigências
      // do mesmo indicador desde que a edição existe. null só quando o
      // indicador nunca teve NENHUMA meta cadastrada.
      const metasDoGrupo = g.indicadores.map((ind) => metaDoIndicador(ind) ?? { indicador: ind, semMeta: true });
      if (!metasDoGrupo.length) return "";
      return `<section class="bm-secao"><h3 class="bm-secao-titulo">${g.icon} ${g.titulo}</h3>
        <div class="bm-metas-grid">${metasDoGrupo.map(metaCardHtml).join("")}</div></section>`;
    }).join("")}`;
  box.querySelectorAll("[data-editar-meta]").forEach((btn) => btn.addEventListener("click", () => {
    const indicador = btn.dataset.editarMeta;
    abrirEditarMetaModal({ indicador, metaAtual: metaDoIndicador(indicador), onSalvo: async () => { await carregarConteudo(); } });
  }));
}

function metaCardHtml(m) {
  const info = INDICADOR[m.indicador] ?? { label: m.indicador, icon: "🎯", tipo: "num" };
  const botaoEditar = podeConfigurar() ? `<button class="btn btn-ghost btn-sm" data-editar-meta="${m.indicador}">✏️ Editar</button>` : "";
  if (m.semMeta) {
    return `<div class="bm-card bm-meta-card">
      <div class="bm-card-topo"><span>${info.icon}</span> ${info.label} <span class="pill muted">sem meta cadastrada</span></div>
      ${botaoEditar}
    </div>`;
  }
  const direcaoTxt = m.direcao === "higher_is_better" ? "Quanto maior, melhor" : "Quanto menor, melhor";
  const fmt = (v) => fmtValor(v, info.tipo);
  return `<div class="bm-card bm-meta-card">
    <div class="bm-card-topo"><span>${info.icon}</span> ${info.label} <span class="pill muted">${direcaoTxt}</span></div>
    ${escadaFaixas({ faixas: m.faixas, faixaAtualOrdem: null, fmt })}
    ${botaoEditar}
  </div>`;
}

// ---------------------------------------------------------------------------
// ABA 4 — HISTÓRICO
// ---------------------------------------------------------------------------
async function renderHistorico(box) {
  box.innerHTML = carregando();
  const g = geracaoContexto();
  try {
    const { data } = await bonifHistorico({ ano: bm.ano });
    if (contextoMudou(g)) return; // resposta da unidade anterior — descarta
    bm.historico = data;
    if (!data.length) { box.innerHTML = vazio("📚", "Sem histórico", "Ainda não há meses fechados para exibir."); return; }
    box.innerHTML = `<section class="bm-secao"><h3 class="bm-secao-titulo">📚 Histórico de ${bm.ano}</h3>
      <div class="bm-grid-cards">${data.map((m) => `
        <div class="bm-card bm-historico-card">
          <div class="bm-card-topo"><span>${m.mesFechado ? "✅" : "🔄"}</span> ${MESES[m.mes - 1]}/${m.ano}</div>
          <div class="bm-gauge-valor">${fmtMoeda(m.bonificacaoAtual)}</div>
          <div class="bm-gauge-detalhe">
            <span>de ${fmtMoeda(m.bonificacaoMaxima)} possíveis</span>
            <span>${m.metasAtingidas} de ${m.metasComRegra} metas · faturamento ${fmtMoeda(m.faturamentoAcumulado)}</span>
          </div>
        </div>`).join("")}</div>
    </section>
    <section class="bm-secao"><h3 class="bm-secao-titulo">🎯 Evolução da Elegibilidade da Bonificação</h3>
      <p class="bm-vazio-inline">Critérios obrigatórios: Nota iFood, REV e Pesquisas.</p>
      <div class="tabela-wrap"><table class="grid">
        <thead><tr><th>Mês</th><th class="num">Nota iFood</th><th class="num">REV</th><th class="num">Pesquisas</th><th>Elegibilidade</th></tr></thead>
        <tbody>${data.map((m) => `<tr>
          <td>${MESES[m.mes - 1]}/${m.ano}</td>
          <td class="num">${fmtValor(m.notaIfood, "nota")}</td>
          <td class="num">${fmtValor(m.rev, "nota")}</td>
          <td class="num">${fmtValor(m.pesquisas, "int")}</td>
          <td><span class="pill ${m.elegibilidade === "elegivel" ? "ok" : m.elegibilidade === "em_acompanhamento" ? "info" : "warn"}">${ELEGIBILIDADE_ROTULO[m.elegibilidade] ?? m.elegibilidade}</span></td>
        </tr>`).join("")}</tbody>
      </table></div>
    </section>
    <section class="bm-secao"><h3 class="bm-secao-titulo">🌟 Evolução do Super Restaurante</h3>
      <p class="bm-vazio-inline">Agrupamento: Avaliação iFood, Cancelamentos e Pedidos com Chamado.</p>
      <div class="tabela-wrap"><table class="grid">
        <thead><tr><th>Mês</th><th class="num">Avaliação</th><th class="num">Cancelamentos</th><th class="num">Pedidos c/ Chamado</th><th>Dentro da meta</th></tr></thead>
        <tbody>${data.map((m) => `<tr>
          <td>${MESES[m.mes - 1]}/${m.ano}</td>
          <td class="num">${fmtValor(m.notaIfood, "nota")}</td>
          <td class="num">${fmtValor(m.cancelamentos, "pct")}</td>
          <td class="num">${fmtValor(m.pedidosChamado, "pct")}</td>
          <td><span class="pill ${m.superRestauranteTotalComMeta > 0 && m.superRestauranteDentroDaMeta === m.superRestauranteTotalComMeta ? "ok" : "warn"}">${m.superRestauranteDentroDaMeta} de ${m.superRestauranteTotalComMeta || 3}</span></td>
        </tr>`).join("")}</tbody>
      </table></div>
    </section>`;
  } catch (e) {
    box.innerHTML = vazio("⚠️", "Erro ao carregar histórico", e.message);
  }
}
