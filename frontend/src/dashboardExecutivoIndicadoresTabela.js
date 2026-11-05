// TABELA "Indicadores de Rentabilidade" (Dashboard iFood) — extraída de
// dashboardExecutivo.js para um módulo PRÓPRIO, sem nenhuma dependência do
// singleton `dex` nem da infraestrutura de realtime/agente/contexto do
// tenant. Motivo: o Painel Administrativo (Visão Geral da Rede > detalhe da
// unidade) reaproveita esta MESMA função — nunca uma segunda implementação
// paralela de metas/limite/status — e precisa poder importá-la sem herdar
// módulos que só existem/funcionam dentro do app do tenant (ex.: agenteChat.js,
// que lê `sessionStorage` no top-level e quebra fora de um navegador real).
//
// `renderIndicadores` é puro no payload `d` (mesmo formato de
// `dashboardExecutivo.service.js#obterMes`): cards, metas, limites, saldo e
// status já vêm prontos do backend — zero cálculo aqui.
import { els, escapeHtml, fmtMoeda } from "./utils.js";
import { icon } from "./icons.js";
import { barraComparativaMeta } from "./charts.js";
import { indicadoresRentabilidadeLiberados, indicadoresBloqueadosHtml, ligarBloqueioIndicadores } from "./dashboardExecutivoBloqueio.js";
import { fmtPctRentabilidade, fmtPpRentabilidade } from "./dashboardExecutivoRentabilidade.js";

const CLASSE_STATUS = { dentro_da_meta: "ok", dentro_do_limite: "ok", atencao: "warn", fora_da_meta: "bad", sem_dados: "muted" };

const vazio = (nomeIcone, titulo, msg, extra = "") =>
  `<section class="dex-painel dex-painel-vazio"><h3>${icon(nomeIcone, { size: 15 })} ${escapeHtml(titulo)}</h3><p class="dex-vazio-texto">${escapeHtml(msg)}</p>${extra}</section>`;

function rotuloIndicador(chave) {
  return {
    taxas_comissoes: "Taxas e comissões", servicos_promocoes: "Serviços e promoções",
    taxas_entregadores: "Taxas de entregadores", total_deducoes: "Total de deduções",
  }[chave] ?? chave;
}

const botaoExpandirIndicador = (chave) => ` <button type="button" class="btn btn-ghost btn-xs dex-ind-expandir" data-chave="${chave}">Composição</button>`;

/** Marketplace/Full Service lado a lado pra UM indicador — nunca uma 3ª tabela gigante, só uma linha expansível. */
function composicaoIndicadorHtml(chave, indicadoresPorSegmento) {
  const partes = indicadoresPorSegmento
    .map((seg) => ({ rotulo: seg.rotulo, ind: seg.indicadores[chave] }))
    .filter((p) => p.ind && !p.ind.naoAplicavel && p.ind.atual != null);
  if (!partes.length) return "";
  return partes.map((p) => `<div class="dex-ind-comp-item">
    <span class="dex-ind-comp-rotulo">${escapeHtml(p.rotulo)}</span>
    <span>${fmtPctRentabilidade(p.ind.atual)}</span>
    <span class="dex-conc-pct">Meta ${fmtPctRentabilidade(p.ind.meta?.metaIdeal ?? null)} · Limite ${fmtPctRentabilidade(p.ind.meta?.limite ?? null)}</span>
  </div>`).join("");
}

function linhaComposicaoHtml(chave, conteudo) {
  return `<tr class="dex-ind-comp-linha" id="dex-ind-comp-${chave}" hidden><td colspan="6"><div class="dex-ind-comp">${conteudo}</div></td></tr>`;
}

/**
 * Dependência REAL do gráfico em relação às tabelas oficiais: Atual (financeiro)
 * e Limite (metas_indicadores) nunca dependem delas; a Meta Ideal de Taxas e
 * comissões e de Taxas de entregadores também não (fixas). Só a Meta Ideal de
 * Serviços e promoções e de Total de deduções é DERIVADA da Proteção da
 * Precificação (preços Balcão × iFood das tabelas oficiais —
 * calc.js#metasComProtecaoPrecificacao). Sem proteção calculável (tabela não
 * configurada OU sem preço), o backend mantém a meta-padrão do modelo
 * logístico para esses dois — o gráfico continua, mas diz isso explicitamente.
 */
function notaMetaIdealSemProtecao(d) {
  if (Number.isFinite(d.protecaoPrecificacao?.protecaoPrecificacaoPct)) return "";
  return `<p class="dex-grafico-nota" data-nota-meta-sem-protecao>${icon("info", { size: 12 })} Meta ideal de Serviços e promoções e de Total de deduções depende das tabelas oficiais de Balcão e iFood (Proteção da Precificação), indisponível nesta unidade — para esses dois indicadores o gráfico mostra a meta-padrão do modelo logístico.</p>`;
}

/** Mesmo tratamento de `graficoComparativoHtml` (Visão Geral), pro canvas próprio da aba Indicadores. */
function graficoComparativoIndicadoresHtml(d) {
  const semReferencia = d.modeloPeriodo?.misto && !(d.graficos?.comparativoPercentuais ?? []).some((g) => g.metaIdeal != null || g.limite != null);
  const nota = semReferencia
    ? `<p class="dex-grafico-nota">${icon("info", { size: 12 })} Meta/Limite consolidados indisponíveis neste período — veja a composição de cada indicador na tabela acima.</p>`
    : "";
  return `<section class="dex-painel"><h3>${icon("trending-up", { size: 15 })} Comparativo de percentuais</h3>${nota}${notaMetaIdealSemProtecao(d)}<div class="dex-chart-wrap"><canvas id="dex-chart-ind"></canvas></div></section>`;
}

/**
 * Renderiza a aba/seção "Indicadores de Rentabilidade" dentro de `box`.
 * @param {HTMLElement} box
 * @param {object} d payload no formato de `dashboardExecutivo.service.js#obterMes`
 */
export function renderIndicadores(box, d) {
  if (!d || d.agregado) {
    box.innerHTML = vazio("building", "Visão consolidada", "Os indicadores de rentabilidade dependem do modelo logístico (Marketplace/Full Service) de cada unidade e não são exibidos nesta visão. Selecione uma unidade específica no filtro acima.");
    return;
  }
  // O gráfico "Comparativo de percentuais" é um componente À PARTE: nunca
  // herda o bloqueio da tabela. A dependência dele das tabelas oficiais
  // (só a Meta Ideal de 2 indicadores) é tratada nele mesmo — ver
  // graficoComparativoIndicadoresHtml.
  const graficos = `<div class="dex-graficos">${graficoComparativoIndicadoresHtml(d)}</div>`;
  // Sem as DUAS tabelas oficiais PERSISTIDAS da unidade deste payload, a seção
  // "Indicadores de Rentabilidade" fica censurada (configuração pendente ≠
  // "Dados insuficientes"); nenhum valor real dela é renderizado. O CTA leva a
  // unidade DESTE payload.
  if (!indicadoresRentabilidadeLiberados(d)) {
    box.innerHTML = indicadoresBloqueadosHtml(d) + graficos;
    ligarBloqueioIndicadores(box, d.unidadeId ?? null);
    barraComparativaMeta("dex-chart-ind", d.graficos.comparativoPercentuais);
    return;
  }
  const misto = d.modeloPeriodo?.misto && d.indicadoresPorSegmento?.length;
  const linhas = Object.entries(d.indicadoresRentabilidade).map(([chave, v]) => {
    const composicao = misto ? composicaoIndicadorHtml(chave, d.indicadoresPorSegmento) : "";
    const podeExpandir = misto && composicao;
    if (v.naoAplicavel) {
      return `<tr class="dex-linha-na">
        <td>${rotuloIndicador(chave)}${podeExpandir ? botaoExpandirIndicador(chave) : ""}</td>
        <td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td>
        <td><span class="pill muted">Não se aplica a este modelo</span></td>
      </tr>${podeExpandir ? linhaComposicaoHtml(chave, composicao) : ""}`;
    }
    const s = v.status ?? { label: "Dados insuficientes", chave: "sem_dados" };
    const saldo = v.saldo;
    // 2 casas decimais APENAS nesta tabela (fmtPctRentabilidade / fmtPpRentabilidade).
    let disponivel = "—";
    if (saldo?.status === "disponivel") disponivel = `${fmtPpRentabilidade(saldo.disponivelPp)}${saldo.disponivelReais != null ? ` (${fmtMoeda(saldo.disponivelReais)})` : ""}`;
    else if (saldo?.status === "limite_atingido") disponivel = "Limite atingido";
    else if (saldo?.status === "acima_do_limite") disponivel = `−${fmtPpRentabilidade(Math.abs(saldo.disponivelPp))}${saldo.disponivelReais != null ? ` (−${fmtMoeda(Math.abs(saldo.disponivelReais))})` : ""}`;
    return `<tr>
      <td>${rotuloIndicador(chave)}${podeExpandir ? botaoExpandirIndicador(chave) : ""}</td>
      <td class="num">${fmtPctRentabilidade(v.atual)}</td>
      <td class="num">${fmtPctRentabilidade(v.metaIdeal)}</td>
      <td class="num">${fmtPctRentabilidade(v.limite)}</td>
      <td class="num">${disponivel}</td>
      <td><span class="pill ${CLASSE_STATUS[s.chave] ?? "muted"}">${s.label}</span></td>
    </tr>${podeExpandir ? linhaComposicaoHtml(chave, composicao) : ""}`;
  }).join("");

  box.innerHTML = `
    <section class="dex-painel">
      <h3>${icon("target", { size: 15 })} Indicadores de Rentabilidade</h3>
      ${misto ? `<p class="dex-resumo-sub">${icon("info", { size: 12 })} "Atual" é o valor CONSOLIDADO do período. Clique em <b>Composição</b> pra ver Marketplace e Full Service separadamente.</p>` : ""}
      <div class="tabela-wrap"><table class="grid">
        <thead><tr><th>Indicador</th><th class="num">Atual</th><th class="num">Meta ideal</th><th class="num">Limite</th><th class="num">Disponível</th><th>Status</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table></div>
    </section>
    ${graficos}`;
  barraComparativaMeta("dex-chart-ind", d.graficos.comparativoPercentuais);
  els(".dex-ind-expandir").forEach((btn) => btn.addEventListener("click", () => {
    const linha = document.getElementById(`dex-ind-comp-${btn.dataset.chave}`);
    if (linha) linha.hidden = !linha.hidden;
  }));
}
