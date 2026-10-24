// Checklist Operacional — DASHBOARD OPERACIONAL: componentes (funções puras: payload → HTML).
//
// Só apresentação: todo número vem pronto de GET /checklist-operacional/dashboard (indicadores e análises
// calculados no backend). Valor ausente aparece como "—" com o motivo, nunca como zero. Texto vindo de dado passa por
// escapeHtml. Prefixo `ckd-`.

import { escapeHtml } from "./utils.js";
import { icon } from "./icons.js";
import { graficosDoDashboard, NOME_ETAPA, COR_ETAPA } from "./checklistOperacionalGraficos.js";

export const PERIODOS_DASHBOARD = Object.freeze([
  { id: "hoje", rotulo: "Hoje" }, { id: "ontem", rotulo: "Ontem" }, { id: "semana", rotulo: "Esta semana" },
  { id: "mes", rotulo: "Este mês" }, { id: "personalizado", rotulo: "Personalizado" },
]);
export const ETAPAS_DASHBOARD = Object.freeze([
  { id: "todas", rotulo: "Todas as etapas" }, { id: "preparo", rotulo: "Preparo" }, { id: "entrega", rotulo: "Entrega" }, { id: "vida", rotulo: "Vida do pedido" },
]);

/** Seções dos relatórios (mesma lista do backend: checklistOperacional.exportar.js#SECOES_RELATORIO). */
export const SECOES_RELATORIO = Object.freeze([
  { id: "resumo", rotulo: "Resumo executivo" }, { id: "metas", rotulo: "Metas aplicáveis" }, { id: "etapas", rotulo: "Desempenho por etapa" },
  { id: "comparativo", rotulo: "Comparativo com o período anterior" }, { id: "evolucao", rotulo: "Evolução diária" },
  { id: "horarios", rotulo: "Demanda e atrasos por horário" }, { id: "semana", rotulo: "Volume por dia da semana" },
  { id: "atrasos", rotulo: "Atrasos e ocorrências" }, { id: "analises", rotulo: "Análises automáticas" },
  { id: "qualidade", rotulo: "Cobertura e qualidade dos dados" }, { id: "definicoes", rotulo: "Definições dos indicadores" },
]);

export const num = (v, casas = 1) => (v == null || Number.isNaN(v) ? "—" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas, minimumFractionDigits: 0 }));
export const dataBr = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
const horaBr = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "—");
const SEVERIDADE = { alta: "Prioridade alta", media: "Atenção", informativa: "Informativo" };

/** "01/10/2026 a 21/10/2026 (parcial até 15:00)". */
export function textoPeriodo(p) {
  if (!p) return "—";
  const base = p.inicio === p.fim ? dataBr(p.inicio) : `${dataBr(p.inicio)} a ${dataBr(p.fim)}`;
  return p.ate ? `${base} (parcial até ${new Date(p.ate).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })})` : base;
}

/**
 * Variação contra o período anterior, em texto (a cor é só reforço): tempos — menor é melhor; % dentro — maior é melhor.
 * @returns {{texto: string, tom: 'melhor'|'pior'|'igual'|'sem'}}
 */
export function variacao(dif, { menorMelhor = true, unidade = "min", pp = false } = {}) {
  if (dif == null) return { texto: "sem comparação", tom: "sem" };
  if (Math.abs(dif) < 0.05) return { texto: "igual ao período anterior", tom: "igual" };
  const melhor = menorMelhor ? dif < 0 : dif > 0;
  const sinal = dif > 0 ? "+" : "−";
  return { texto: `${sinal}${num(Math.abs(dif))} ${pp ? "p.p." : unidade} vs. anterior (${melhor ? "melhor" : "pior"})`, tom: melhor ? "melhor" : "pior" };
}

function tile({ rotulo, valor, unidade, sub, delta, icone }) {
  return `
    <article class="ckd-kpi">
      <h3>${icone ? icon(icone, { size: 16 }) : ""}${escapeHtml(rotulo)}</h3>
      <p class="ckd-kpi-valor">${valor}${unidade ? `<small>${escapeHtml(unidade)}</small>` : ""}</p>
      ${sub ? `<p class="ckd-kpi-sub">${sub}</p>` : ""}
      ${delta ? `<p class="ckd-delta ckd-delta--${delta.tom}">${delta.tom === "melhor" ? icon("trending-down", { size: 14 }) : delta.tom === "pior" ? icon("trending-up", { size: 14 }) : ""}${escapeHtml(delta.texto)}</p>` : ""}
    </article>`;
}

export function kpis(d) {
  const r = d.resumo;
  const c = d.comparacao;
  const t = [tile({
    rotulo: "Pedidos acompanhados", valor: num(r.pedidos, 0), icone: "receipt",
    sub: `${num(r.concluidos, 0)} concluídos · ${num(r.cancelados, 0)} cancelados`,
    delta: c.pedidos.diferenca == null ? null : { texto: `${c.pedidos.diferenca >= 0 ? "+" : "−"}${num(Math.abs(c.pedidos.diferenca), 0)} vs. anterior (${num(c.pedidos.anterior, 0)})`, tom: "igual" },
  })];
  for (const e of d.etapas) {
    const x = r.porEtapa[e];
    t.push(tile({
      rotulo: `${NOME_ETAPA[e]} — mediana`, valor: num(x.mediana), unidade: x.mediana == null ? "" : "min", icone: "clock",
      sub: `média ${num(x.media)} · P90 ${num(x.p90)} min · ${num(x.amostras, 0)} medições${x.aproximadas ? ` (${x.aproximadas} aprox.)` : ""}`,
      delta: variacao(c.porEtapa[e].mediana.diferenca),
    }));
  }
  const dentro = d.etapas.length === 1 ? r.porEtapa[d.etapas[0]].pctDentro : r.pctPedidosDentro;
  t.push(tile({
    rotulo: d.etapas.length === 1 ? "Dentro da meta" : "Pedidos dentro da meta", valor: num(dentro), unidade: dentro == null ? "" : "%", icone: "target",
    sub: dentro == null ? "sem pedidos avaliados contra meta" : `${num(r.pedidosAvaliados, 0)} pedidos avaliados`,
    delta: d.etapas.length === 1 ? variacao(c.porEtapa[d.etapas[0]].pctDentro.diferencaPP, { menorMelhor: false, pp: true }) : variacao(c.pctPedidosAtrasados.diferencaPP == null ? null : -c.pctPedidosAtrasados.diferencaPP, { menorMelhor: false, pp: true }),
  }));
  const maior = d.etapas.map((e) => r.porEtapa[e].maiorAtraso).filter(Boolean).sort((a, b) => b.excedenteMin - a.excedenteMin)[0];
  t.push(tile({
    rotulo: "Atrasos", valor: num(r.pedidosAtrasados, 0), icone: "alert-triangle",
    sub: r.pctPedidosAtrasados == null ? "sem pedidos avaliados" : `${num(r.pctPedidosAtrasados)}% dos pedidos avaliados`,
  }));
  t.push(tile({
    rotulo: "Maior atraso", valor: maior ? `+${num(maior.excedenteMin)}` : "—", unidade: maior ? "min" : "", icone: "hourglass",
    sub: maior ? `${maior.displayId ? `pedido #${escapeHtml(maior.displayId)}` : "pedido sem número"} · ${num(maior.duracaoMin)} min contra meta de ${num(maior.metaMin)}` : "nenhum atraso no período",
  }));
  return `<section class="ckd-kpis" aria-label="Indicadores principais">${t.join("")}</section>`;
}

export function tabelaEtapas(d) {
  const linhas = d.etapas.map((e) => {
    const x = d.resumo.porEtapa[e];
    return `<tr><th scope="row"><i class="ckd-marca" style="background:${COR_ETAPA[e]}"></i>${NOME_ETAPA[e]}</th>
      <td>${num(x.amostras, 0)}</td><td>${num(x.media)}</td><td>${num(x.mediana)}</td><td>${num(x.p90)}</td>
      <td>${x.pctDentro == null ? "—" : `${num(x.pctDentro)}%`}</td><td>${num(x.atrasos, 0)}${x.pctAtraso == null ? "" : ` (${num(x.pctAtraso)}%)`}</td>
      <td>${x.maiorAtraso ? `+${num(x.maiorAtraso.excedenteMin)} min` : "—"}</td><td>${num(x.semMetaVigente, 0)}</td></tr>`;
  }).join("");
  return `
    <section class="ckd-bloco" aria-labelledby="ckd-t-etapas">
      <h2 id="ckd-t-etapas">Desempenho por etapa</h2>
      <div class="ckd-tabela-wrap"><table class="ckd-tabela">
        <thead><tr><th scope="col">Etapa</th><th scope="col">Medições</th><th scope="col">Média (min)</th><th scope="col">Mediana (min)</th><th scope="col">P90 (min)</th><th scope="col">Dentro da meta</th><th scope="col">Atrasos</th><th scope="col">Maior atraso</th><th scope="col">Sem meta vigente</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table></div>
      <p class="ckd-nota">Entrega é aproximada (saída até a conclusão no iFood). Preparo sem o evento "pronto" é medido até a saída e marcado como aproximado.</p>
    </section>`;
}

export function tabelaComparativo(d) {
  const c = d.comparacao;
  const linha = (rot, x, { menorMelhor = true, pp = false, unidade = "min", casas = 1 } = {}) => {
    const dif = pp ? x.diferencaPP : x.diferenca;
    const v = variacao(dif, { menorMelhor, pp, unidade });
    return `<tr><th scope="row">${escapeHtml(rot)}</th><td>${num(x.atual, casas)}</td><td>${num(x.anterior, casas)}</td><td class="ckd-delta--${v.tom}">${escapeHtml(v.texto)}</td></tr>`;
  };
  const linhas = [
    `<tr><th scope="row">Pedidos</th><td>${num(c.pedidos.atual, 0)}</td><td>${num(c.pedidos.anterior, 0)}</td><td>${c.pedidos.variacaoPct == null ? "—" : `${c.pedidos.variacaoPct > 0 ? "+" : ""}${num(c.pedidos.variacaoPct)}%`}</td></tr>`,
    linha("% pedidos atrasados", c.pctPedidosAtrasados, { pp: true }),
    ...d.etapas.flatMap((e) => [
      linha(`${NOME_ETAPA[e]} — mediana (min)`, c.porEtapa[e].mediana),
      linha(`${NOME_ETAPA[e]} — P90 (min)`, c.porEtapa[e].p90),
      linha(`${NOME_ETAPA[e]} — dentro da meta (%)`, c.porEtapa[e].pctDentro, { menorMelhor: false, pp: true }),
    ]),
  ].join("");
  return `
    <section class="ckd-bloco" aria-labelledby="ckd-t-comp">
      <h2 id="ckd-t-comp">Comparação com o período anterior</h2>
      <p class="ckd-nota">Comparado com ${escapeHtml(textoPeriodo(d.periodo.anterior))}${d.periodo.anterior.ate ? " — cortado no mesmo horário, para não comparar um dia pela metade com um dia inteiro" : ""}.</p>
      <div class="ckd-tabela-wrap"><table class="ckd-tabela"><thead><tr><th scope="col">Indicador</th><th scope="col">Atual</th><th scope="col">Anterior</th><th scope="col">Variação</th></tr></thead><tbody>${linhas}</tbody></table></div>
    </section>`;
}

function evidenciaPedidos(ev) {
  if (!ev?.itens?.length) return "";
  return `<details class="ckd-evidencia"><summary>Evidências: ${ev.total} ${ev.total === 1 ? "pedido" : "pedidos"}${ev.total > ev.itens.length ? ` (os ${ev.itens.length} maiores atrasos)` : ""}</summary>
    <div class="ckd-tabela-wrap"><table class="ckd-tabela ckd-tabela--mini"><thead><tr><th scope="col">Pedido</th><th scope="col">Dia</th><th scope="col">Hora</th><th scope="col">Etapa</th><th scope="col">Duração</th><th scope="col">Meta</th></tr></thead>
    <tbody>${ev.itens.map((p) => `<tr><th scope="row">${p.displayId ? `#${escapeHtml(p.displayId)}` : "sem número"}</th><td>${dataBr(p.data).slice(0, 5)}</td><td>${String(p.hora).padStart(2, "0")}h</td><td>${NOME_ETAPA[p.etapa]}</td><td>${num(p.duracaoMin)} min</td><td>${num(p.metaMin)} min</td></tr>`).join("")}</tbody></table></div></details>`;
}

export function blocoAnalises(an) {
  const itens = an?.itens ?? [];
  const cards = itens.map((a) => `
    <article class="ckd-analise ckd-analise--${a.severidade}">
      <header><span class="ckd-sev">${a.severidade === "alta" ? icon("alert-octagon", { size: 15 }) : a.severidade === "media" ? icon("alert-triangle", { size: 15 }) : icon("info", { size: 15 })}${SEVERIDADE[a.severidade] ?? a.severidade}</span><h3>${escapeHtml(a.titulo)}</h3></header>
      <dl>
        <div><dt>Fato</dt><dd>${escapeHtml(a.constatacao)}</dd></div>
        <div><dt>Indicador</dt><dd>${escapeHtml(a.indicador)} · ${escapeHtml(textoPeriodo(a.periodo))}</dd></div>
        <div><dt>Referência</dt><dd>${escapeHtml(a.referencia)}</dd></div>
        <div><dt>Ocorrências</dt><dd>${num(a.ocorrencias, 0)}</dd></div>
        ${a.hipotese ? `<div class="ckd-hipotese"><dt>Hipótese <small>(não comprovada)</small></dt><dd>${escapeHtml(a.hipotese)}</dd></div>` : ""}
        ${a.recomendacao ? `<div class="ckd-recomendacao"><dt>Recomendação</dt><dd>${escapeHtml(a.recomendacao)}</dd></div>` : ""}
      </dl>
      ${evidenciaPedidos(a.evidencias?.pedidos)}
    </article>`).join("");
  const nao = an?.naoAvaliadas?.length
    ? `<details class="ckd-evidencia"><summary>${an.naoAvaliadas.length} ${an.naoAvaliadas.length === 1 ? "análise não avaliada" : "análises não avaliadas"} por falta de dados</summary><ul>${an.naoAvaliadas.map((n) => `<li>${escapeHtml(n.motivo)}</li>`).join("")}</ul></details>` : "";
  return `
    <section class="ckd-bloco" aria-labelledby="ckd-t-an">
      <h2 id="ckd-t-an">Inteligência operacional</h2>
      <p class="ckd-nota">${escapeHtml(an?.aviso ?? "")}</p>
      ${cards || '<p class="ckd-vazio">Nenhuma análise disparou com os dados deste período.</p>'}
      ${nao}
    </section>`;
}

export function tabelaAtrasos(d, limite = 50) {
  const a = d.atrasos;
  if (!a.total) return `<section class="ckd-bloco" aria-labelledby="ckd-t-atr"><h2 id="ckd-t-atr">Atrasos e ocorrências</h2><p class="ckd-vazio">Nenhum atraso registrado no período.</p></section>`;
  const itens = a.itens.slice(0, limite);
  return `
    <section class="ckd-bloco" aria-labelledby="ckd-t-atr">
      <h2 id="ckd-t-atr">Atrasos e ocorrências</h2>
      <p class="ckd-nota">${a.total} ${a.total === 1 ? "atraso" : "atrasos"} no período; mostrando os ${itens.length} maiores. A lista completa sai no Excel${a.truncado ? " (até 500)" : ""}.</p>
      <div class="ckd-tabela-wrap"><table class="ckd-tabela"><thead><tr><th scope="col">Pedido</th><th scope="col">Recebido</th><th scope="col">Etapa</th><th scope="col">Duração</th><th scope="col">Meta</th><th scope="col">Acima</th></tr></thead>
      <tbody>${itens.map((x) => `<tr><th scope="row">${x.displayId ? `#${escapeHtml(x.displayId)}` : "sem número"}</th><td>${horaBr(x.recebidoEm)}</td><td>${NOME_ETAPA[x.etapa]}${x.aproximado ? " (aprox.)" : ""}</td><td>${num(x.duracaoMin)} min</td><td>${num(x.metaMin)} min</td><td>+${num(x.excedenteMin)} min</td></tr>`).join("")}</tbody></table></div>
    </section>`;
}

export function blocoMetas(d) {
  const m = d.metasAplicaveis;
  const lin = m.versoes.map((v) => `<tr><th scope="row">v${v.versao}</th><td>${horaBr(v.desde)}</td>${["preparo", "entrega", "vida"].map((e) => `<td>${num(v.valores[e].meta)} min <small>(aviso ${num(v.valores[e].avisoPct, 0)}%)</small></td>`).join("")}</tr>`).join("");
  return `
    <section class="ckd-bloco" aria-labelledby="ckd-t-metas">
      <h2 id="ckd-t-metas">Metas aplicáveis</h2>
      <p class="ckd-nota">Cada pedido é avaliado pela meta que valia no momento do recebimento. Alterar a meta não muda resultados já registrados.</p>
      ${lin ? `<div class="ckd-tabela-wrap"><table class="ckd-tabela"><thead><tr><th scope="col">Versão</th><th scope="col">Vigente desde</th><th scope="col">Preparo</th><th scope="col">Entrega</th><th scope="col">Vida</th></tr></thead><tbody>${lin}</tbody></table></div>` : '<p class="ckd-vazio">Nenhuma meta salva para a unidade neste período.</p>'}
      ${m.inicioSemMeta && lin ? '<p class="ckd-nota">Parte do período não tinha meta salva: esses pedidos não entram no % dentro da meta.</p>' : ""}
    </section>`;
}

export function blocoQualidade(d) {
  const q = d.qualidade;
  return `
    <section class="ckd-bloco" aria-labelledby="ckd-t-qual">
      <h2 id="ckd-t-qual">Cobertura e qualidade dos dados</h2>
      <dl class="ckd-qualidade">
        <div><dt>Primeiro pedido registrado</dt><dd>${q.primeiroPedidoEm ? horaBr(q.primeiroPedidoEm) : "nenhum"}</dd></div>
        <div><dt>Dias sem cobertura</dt><dd>${num(q.diasSemCobertura, 0)}</dd></div>
        <div><dt>Dias sem pedidos</dt><dd>${num(q.diasSemPedidos, 0)}</dd></div>
        <div><dt>Pedidos sem detalhes do iFood</dt><dd>${num(q.pedidosSemDetalhes, 0)}</dd></div>
        <div><dt>Medições sem meta vigente</dt><dd>${num(q.semMetaVigente, 0)}</dd></div>
        <div><dt>Pedidos de teste (fora)</dt><dd>${num(q.pedidosTeste, 0)}</dd></div>
      </dl>
      ${q.avisos.length ? `<ul class="ckd-avisos">${q.avisos.map((a) => `<li>${icon("info", { size: 14 })}<span>${escapeHtml(a)}</span></li>`).join("")}</ul>` : ""}
      <p class="ckd-nota"><b>Cumprimento dos itens do checklist:</b> indisponível — ${escapeHtml(d.checklistItens.motivo)}</p>
    </section>`;
}

export function blocoDefinicoes(d) {
  return `
    <details class="ckd-bloco ckd-definicoes">
      <summary><h2>Como cada indicador é calculado</h2></summary>
      <div class="ckd-tabela-wrap"><table class="ckd-tabela"><thead><tr><th scope="col">Indicador</th><th scope="col">Definição</th><th scope="col">Fórmula</th><th scope="col">Unidade</th><th scope="col">Denominador</th><th scope="col">Dados ausentes</th></tr></thead>
      <tbody>${Object.values(d.definicoes).map((x) => `<tr><th scope="row">${escapeHtml(x.nome)}</th><td>${escapeHtml(x.definicao)}</td><td>${escapeHtml(x.formula)}</td><td>${escapeHtml(x.unidade)}</td><td>${escapeHtml(x.denominador)}</td><td>${escapeHtml(x.ausentes)}</td></tr>`).join("")}</tbody></table></div>
    </details>`;
}

export function filtros(f, { hoje, unidadeNome, carregando }) {
  const opt = (lista, atual) => lista.map((o) => `<option value="${o.id}"${o.id === atual ? " selected" : ""}>${o.rotulo}</option>`).join("");
  const pers = f.periodo === "personalizado";
  return `
    <form class="ckd-filtros" data-ckd-filtros aria-label="Filtros do Dashboard">
      <label class="ckd-campo"><span>Unidade</span><output title="Para trocar, use o seletor de unidade do topo">${icon("store", { size: 15 })}${escapeHtml(unidadeNome ?? "Unidade")}</output></label>
      <label class="ckd-campo"><span>Período</span><select name="periodo">${opt(PERIODOS_DASHBOARD, f.periodo)}</select></label>
      <label class="ckd-campo"${pers ? "" : " hidden"}><span>De</span><input type="date" name="inicio" value="${escapeHtml(f.inicio ?? "")}" max="${hoje}" ${pers ? "required" : ""}/></label>
      <label class="ckd-campo"${pers ? "" : " hidden"}><span>Até</span><input type="date" name="fim" value="${escapeHtml(f.fim ?? "")}" max="${hoje}" ${pers ? "required" : ""}/></label>
      <label class="ckd-campo"><span>Etapa</span><select name="etapa">${opt(ETAPAS_DASHBOARD, f.etapa)}</select></label>
      <button type="submit" class="btn btn-primary"${carregando ? " disabled aria-busy=\"true\"" : ""}>${icon("refresh", { size: 16 })}<span>${carregando ? "Calculando…" : "Atualizar"}</span></button>
    </form>`;
}

/**
 * Tela inteira do Dashboard.
 * @param {{dados: object|null, filtro: object, unidadeNome: string, carregando: boolean, erro: string|null, hoje: string}} p
 */
export function telaDashboard({ dados, filtro, unidadeNome, carregando, erro, hoje }) {
  const cab = `
    <header class="ckd-cab">
      <div>
        <h1>${icon("bar-chart", { size: 24 })}Dashboard Operacional</h1>
        <p>${dados ? `${escapeHtml(textoPeriodo(dados.periodo))} · ${dados.etapa === "todas" ? "todas as etapas" : NOME_ETAPA[dados.etapa]}` : "Histórico de tempos da unidade"}</p>
      </div>
      <div class="ckd-acoes">
        <button type="button" class="btn btn-ghost" data-acao="relatorio"${dados ? "" : " disabled"}>${icon("file-text", { size: 16 })}<span>Relatório PDF / Excel</span></button>
        <button type="button" class="btn btn-ghost" data-acao="voltar-checklist">${icon("arrow-left", { size: 16 })}<span>Voltar ao Checklist</span></button>
      </div>
    </header>`;
  const status = erro
    ? `<p class="ckd-erro" role="alert">${escapeHtml(erro)}</p>`
    : carregando ? '<p class="ckd-carregando" role="status">Calculando os indicadores do período…</p>' : "";
  if (!dados) return `<section class="ckd" data-ckd>${cab}${filtros(filtro, { hoje, unidadeNome, carregando })}${status}</section>`;
  const g = graficosDoDashboard(dados);
  const avisos = dados.qualidade.avisos.length
    ? `<details class="ckd-avisos-topo"${dados.qualidade.avisos.length <= 2 ? " open" : ""}><summary>${icon("info", { size: 15 })}${dados.qualidade.avisos.length} ${dados.qualidade.avisos.length === 1 ? "observação" : "observações"} sobre os dados deste período</summary><ul>${dados.qualidade.avisos.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul></details>` : "";
  return `
    <section class="ckd" data-ckd aria-busy="${carregando ? "true" : "false"}">
      ${cab}
      ${filtros(filtro, { hoje, unidadeNome, carregando })}
      ${status}
      ${avisos}
      ${kpis(dados)}
      <div class="ckd-graficos">${g.evolucao}${g.volumeDiario}${g.demandaHora}${g.atrasoHora}${g.semana}${g.distribuicao}</div>
      ${blocoAnalises(dados.analises)}
      ${tabelaEtapas(dados)}
      ${tabelaComparativo(dados)}
      ${tabelaAtrasos(dados)}
      ${blocoMetas(dados)}
      ${blocoQualidade(dados)}
      ${blocoDefinicoes(dados)}
      <p class="ckd-rodape">Calculado pela Central às ${escapeHtml(horaBr(dados.servidorEm))}. Fuso da operação: ${escapeHtml(dados.periodo.fuso)}.</p>
      <div class="ckd-tooltip" data-ckd-tooltip role="tooltip" hidden></div>
    </section>`;
}

/** Diálogo de escolha das seções do relatório. */
export function dialogoRelatorio(selecionadas) {
  return `
    <form method="dialog" class="ckd-rel" data-ckd-rel>
      <h2 id="ckd-t-rel">Relatório do período</h2>
      <p>O relatório usa exatamente os filtros e os números desta tela. Escolha as seções:</p>
      <fieldset><legend class="ckd-sr">Seções</legend>
        ${SECOES_RELATORIO.map((s) => `<label><input type="checkbox" name="secao" value="${s.id}"${selecionadas.includes(s.id) ? " checked" : ""}/> ${s.rotulo}</label>`).join("")}
      </fieldset>
      <p class="ckd-rel-erro" data-rel-erro role="alert" hidden></p>
      <footer>
        <button type="button" class="btn btn-ghost" data-acao="rel-cancelar">Cancelar</button>
        <button type="button" class="btn btn-ghost" data-acao="rel-excel">${icon("grid", { size: 16 })}<span>Baixar Excel</span></button>
        <button type="button" class="btn btn-primary" data-acao="rel-pdf">${icon("file-text", { size: 16 })}<span>Gerar PDF</span></button>
      </footer>
    </form>`;
}
