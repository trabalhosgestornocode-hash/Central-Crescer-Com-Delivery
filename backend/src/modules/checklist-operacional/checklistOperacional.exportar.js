// Checklist Operacional — RELATÓRIO EM EXCEL do Dashboard Operacional.
//
// Camada de apresentação: recebe o MESMO payload que a tela recebe (indicadores + análises, já calculados pelo
// backend) e só escreve planilhas. Nenhuma regra é recalculada aqui. Uma aba por seção escolhida; números como
// números (o Excel soma/ordena), datas como texto ISO local, vazio quando o dado não existe (nunca zero).
//
// Privacidade: só o número curto do pedido (displayId) e horários — nenhum dado de cliente, merchant ou orderId do
// iFood (a chave dos pedidos já é opaca).

import * as XLSX from "xlsx";
import { NOME_ETAPA } from "./checklistOperacional.indicadores.js";

/** Seções do relatório (as mesmas do PDF, frontend/src/checklistOperacionalRelatorio.js). */
export const SECOES_RELATORIO = Object.freeze([
  { id: "resumo", rotulo: "Resumo executivo" },
  { id: "metas", rotulo: "Metas aplicáveis" },
  { id: "etapas", rotulo: "Desempenho por etapa" },
  { id: "comparativo", rotulo: "Comparativo com o período anterior" },
  { id: "evolucao", rotulo: "Evolução diária" },
  { id: "horarios", rotulo: "Demanda e atrasos por horário" },
  { id: "semana", rotulo: "Volume por dia da semana" },
  { id: "atrasos", rotulo: "Atrasos e ocorrências" },
  { id: "analises", rotulo: "Análises automáticas" },
  { id: "qualidade", rotulo: "Cobertura e qualidade dos dados" },
  { id: "definicoes", rotulo: "Definições dos indicadores" },
]);

export const IDS_SECOES = SECOES_RELATORIO.map((s) => s.id);

/** "resumo,etapas" → ["resumo","etapas"] (desconhecidas ignoradas; vazio = todas). */
export function secoesPedidas(texto) {
  const pedidas = String(texto ?? "").split(",").map((s) => s.trim()).filter((s) => IDS_SECOES.includes(s));
  return pedidas.length ? IDS_SECOES.filter((s) => pedidas.includes(s)) : [...IDS_SECOES];
}

const v = (x) => (x == null || Number.isNaN(x) ? "" : x);
const dataBr = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const horaLocal = (iso, fuso) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: fuso }) : "");

function aba(linhas, larguras) {
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  if (larguras) ws["!cols"] = larguras.map((wch) => ({ wch }));
  return ws;
}

function cabecalho(ctx) {
  const d = ctx.dashboard;
  return [
    ["Crescer com Delivery — Checklist Operacional · Dashboard Operacional"],
    ["Unidade", ctx.unidadeNome ?? ""],
    ["Período", `${dataBr(d.periodo.inicio)} a ${dataBr(d.periodo.fim)}${d.periodo.ate ? ` (parcial até ${horaLocal(d.periodo.ate, d.periodo.fuso)})` : ""}`],
    ["Etapa", d.etapa === "todas" ? "Todas" : NOME_ETAPA[d.etapa]],
    ["Gerado em", horaLocal(ctx.geradoEm, d.periodo.fuso)],
    [],
  ];
}

const SECAO = {
  resumo(ctx) {
    const d = ctx.dashboard;
    const r = d.resumo;
    const linhas = [...cabecalho(ctx), ["Indicador", "Valor", "Unidade"],
      ["Pedidos acompanhados", r.pedidos, "pedidos"], ["Concluídos", r.concluidos, "pedidos"], ["Cancelados", r.cancelados, "pedidos"],
      ["Em andamento", r.emAndamento, "pedidos"], ["Pedidos avaliados contra a meta", r.pedidosAvaliados, "pedidos"],
      ["Pedidos atrasados", r.pedidosAtrasados, "pedidos"], ["Pedidos atrasados", v(r.pctPedidosAtrasados), "%"],
      ["Pedidos dentro da meta", v(r.pctPedidosDentro), "%"], [],
      ["Destaques das análises"]];
    for (const a of ctx.analises?.itens?.slice(0, 5) ?? []) linhas.push([`[${a.severidade}] ${a.titulo}`, a.constatacao]);
    if (!ctx.analises?.itens?.length) linhas.push(["Nenhuma análise disparou com os dados do período."]);
    return aba(linhas, [40, 60, 12]);
  },
  metas(ctx) {
    const m = ctx.dashboard.metasAplicaveis;
    const linhas = [...cabecalho(ctx), ["Versão", "Vigente desde", "Preparo (min)", "Aviso preparo (%)", "Entrega (min)", "Aviso entrega (%)", "Vida (min)", "Aviso vida (%)"]];
    for (const x of m.versoes) {
      linhas.push([x.versao, horaLocal(x.desde, ctx.dashboard.periodo.fuso), x.valores.preparo.meta, x.valores.preparo.avisoPct, x.valores.entrega.meta, x.valores.entrega.avisoPct, x.valores.vida.meta, x.valores.vida.avisoPct]);
    }
    if (m.inicioSemMeta) linhas.push([], ["Parte do período não tinha meta salva: esses pedidos ficaram fora do % dentro da meta."]);
    return aba(linhas, [10, 20, 14, 16, 14, 16, 12, 14]);
  },
  etapas(ctx) {
    const d = ctx.dashboard;
    const linhas = [...cabecalho(ctx), ["Etapa", "Amostras", "Média (min)", "Mediana (min)", "P90 (min)", "Mínimo", "Máximo", "Avaliadas", "Dentro da meta", "% dentro", "Atrasos", "% atrasos", "Maior atraso (min acima)", "Pedido do maior atraso", "Sem meta vigente", "Descartadas"]];
    for (const e of d.etapas) {
      const x = d.resumo.porEtapa[e];
      linhas.push([NOME_ETAPA[e], x.amostras, v(x.media), v(x.mediana), v(x.p90), v(x.minimo), v(x.maximo), x.avaliadas, x.dentro, v(x.pctDentro), x.atrasos, v(x.pctAtraso),
        v(x.maiorAtraso?.excedenteMin), x.maiorAtraso?.displayId ? `#${x.maiorAtraso.displayId}` : "", x.semMetaVigente, x.descartados]);
    }
    return aba(linhas, [16, 10, 11, 12, 10, 9, 9, 10, 13, 9, 9, 10, 20, 18, 15, 12, 12]);
  },
  comparativo(ctx) {
    const d = ctx.dashboard;
    const c = d.comparacao;
    const linhas = [...cabecalho(ctx),
      ["Comparado com", `${dataBr(d.periodo.anterior.inicio)} a ${dataBr(d.periodo.anterior.fim)}${d.periodo.anterior.ate ? ` (cortado em ${horaLocal(d.periodo.anterior.ate, d.periodo.fuso)})` : ""}`], [],
      ["Indicador", "Atual", "Anterior", "Diferença", "Variação (%)"],
      ["Pedidos", c.pedidos.atual, c.pedidos.anterior, c.pedidos.diferenca, v(c.pedidos.variacaoPct)],
      ["% pedidos atrasados", v(c.pctPedidosAtrasados.atual), v(c.pctPedidosAtrasados.anterior), v(c.pctPedidosAtrasados.diferencaPP), "p.p."]];
    for (const e of d.etapas) {
      const x = c.porEtapa[e];
      for (const [k, rot] of [["media", "média (min)"], ["mediana", "mediana (min)"], ["p90", "P90 (min)"]]) {
        linhas.push([`${NOME_ETAPA[e]} — ${rot}`, v(x[k].atual), v(x[k].anterior), v(x[k].diferenca), v(x[k].variacaoPct)]);
      }
      linhas.push([`${NOME_ETAPA[e]} — % dentro da meta`, v(x.pctDentro.atual), v(x.pctDentro.anterior), v(x.pctDentro.diferencaPP), "p.p."]);
    }
    return aba(linhas, [34, 12, 12, 12, 14]);
  },
  evolucao(ctx) {
    const d = ctx.dashboard;
    const cab = ["Data", "Sem cobertura", "Pedidos", "Concluídos", "Cancelados", "Atrasados", "% atrasados"];
    for (const e of d.etapas) cab.push(`${NOME_ETAPA[e]} média`, `${NOME_ETAPA[e]} mediana`, `${NOME_ETAPA[e]} P90`, `${NOME_ETAPA[e]} % dentro`);
    const linhas = [...cabecalho(ctx), cab];
    for (const x of d.evolucaoDiaria) {
      const l = [dataBr(x.data), x.semCobertura ? "sim" : "", x.pedidos, x.concluidos, x.cancelados, x.pedidosAtrasados, v(x.pctPedidosAtrasados)];
      for (const e of d.etapas) { const y = x.porEtapa[e]; l.push(v(y.media), v(y.mediana), v(y.p90), v(y.pctDentro)); }
      linhas.push(l);
    }
    return aba(linhas);
  },
  horarios(ctx) {
    const linhas = [...cabecalho(ctx), ["Hora", "Pedidos", "Avaliados", "Atrasados", "% atrasados"]];
    for (const h of ctx.dashboard.demandaPorHora) linhas.push([`${String(h.hora).padStart(2, "0")}h`, h.pedidos, h.avaliados, h.atrasados, v(h.pctAtrasados)]);
    return aba(linhas, [8, 10, 10, 10, 12]);
  },
  semana(ctx) {
    const linhas = [...cabecalho(ctx), ["Dia da semana", "Pedidos", "Dias observados", "Média por dia"]];
    for (const s of ctx.dashboard.volumePorDiaDaSemana) linhas.push([s.nome, s.pedidos, s.diasObservados, v(s.mediaPorDia)]);
    return aba(linhas, [16, 10, 16, 14]);
  },
  atrasos(ctx) {
    const a = ctx.dashboard.atrasos;
    const linhas = [...cabecalho(ctx), [`${a.total} atrasos no período${a.truncado ? ` (listados os ${a.itens.length} maiores)` : ""}`], [],
      ["Pedido", "Recebido em", "Etapa", "Duração (min)", "Meta (min)", "Acima da meta (min)", "Versão da meta"]];
    for (const x of a.itens) {
      linhas.push([x.displayId ? `#${x.displayId}` : "sem número", horaLocal(x.recebidoEm, ctx.dashboard.periodo.fuso), NOME_ETAPA[x.etapa], x.duracaoMin, x.metaMin, x.excedenteMin, v(x.versaoMeta)]);
    }
    return aba(linhas, [14, 20, 16, 14, 11, 18, 14, 11]);
  },
  analises(ctx) {
    const an = ctx.analises ?? { itens: [], naoAvaliadas: [] };
    const linhas = [...cabecalho(ctx), [an.aviso ?? ""], [],
      ["Severidade", "Análise", "Constatação (fato)", "Indicador", "Referência", "Ocorrências", "Hipótese (não comprovada)", "Recomendação"]];
    for (const a of an.itens) linhas.push([a.severidade, a.titulo, a.constatacao, a.indicador, a.referencia, a.ocorrencias, a.hipotese ?? "", a.recomendacao ?? ""]);
    if (an.naoAvaliadas?.length) {
      linhas.push([], ["Regras não avaliadas (amostra insuficiente)"]);
      for (const n of an.naoAvaliadas) linhas.push([n.regra, n.motivo]);
    }
    linhas.push([], ["Evidências (pedidos citados)"], ["Análise", "Pedido", "Data", "Hora", "Etapa", "Duração (min)", "Meta (min)"]);
    for (const a of an.itens) {
      for (const p of a.evidencias?.pedidos?.itens ?? []) linhas.push([a.titulo, p.displayId ? `#${p.displayId}` : "sem número", dataBr(p.data), `${String(p.hora).padStart(2, "0")}h`, NOME_ETAPA[p.etapa], p.duracaoMin, p.metaMin]);
    }
    return aba(linhas, [12, 30, 70, 30, 40, 12, 50, 50]);
  },
  qualidade(ctx) {
    const q = ctx.dashboard.qualidade;
    const linhas = [...cabecalho(ctx),
      ["Primeiro pedido registrado da unidade", horaLocal(q.primeiroPedidoEm, ctx.dashboard.periodo.fuso) || "nenhum"],
      ["Dias sem cobertura (antes do primeiro pedido)", q.diasSemCobertura], ["Dias sem pedidos", q.diasSemPedidos],
      ["Pedidos de teste (fora de tudo)", q.pedidosTeste], ["Pedidos sem detalhes do iFood", q.pedidosSemDetalhes],
      ["Agendados (fora de preparo e vida)", q.agendados], ["Em andamento no momento da consulta", q.emAndamento],
      ["Medições sem meta vigente", q.semMetaVigente], [], ["Etapa", "Esperadas", "Válidas", "Descartadas", "Sem carimbo", "Sem meta vigente"]];
    for (const [e, x] of Object.entries(q.porEtapa)) linhas.push([NOME_ETAPA[e], x.esperadas, x.validas, x.descartados, x.semCarimbo, x.semMetaVigente]);
    linhas.push([], ["Avisos"]);
    for (const a of q.avisos) linhas.push([a]);
    linhas.push([], ["Cumprimento dos itens do checklist", ctx.dashboard.checklistItens.motivo]);
    return aba(linhas, [46, 14, 10, 12, 12, 12, 16]);
  },
  definicoes(ctx) {
    const linhas = [...cabecalho(ctx), ["Indicador", "Definição", "Fórmula", "Unidade", "Denominador", "Dados ausentes"]];
    for (const d of Object.values(ctx.dashboard.definicoes)) linhas.push([d.nome, d.definicao, d.formula, d.unidade, d.denominador, d.ausentes]);
    return aba(linhas, [28, 60, 50, 12, 36, 60]);
  },
};

const NOME_ABA = {
  resumo: "Resumo", metas: "Metas", etapas: "Etapas", comparativo: "Comparativo", evolucao: "Evolução diária", horarios: "Horários",
  semana: "Dia da semana", atrasos: "Atrasos", analises: "Análises", qualidade: "Qualidade dos dados", definicoes: "Definições",
};

/**
 * @param {{dashboard: object, analises: object, unidadeNome?: string, geradoEm: string, secoes: string[]}} ctx
 * @returns {Buffer}
 */
export function gerarExcel(ctx) {
  const wb = XLSX.utils.book_new();
  for (const s of ctx.secoes) XLSX.utils.book_append_sheet(wb, SECAO[s](ctx), NOME_ABA[s]);
  wb.Props = { Title: "Dashboard Operacional — Checklist", Author: "Crescer com Delivery" };
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

/** `Checklist-Operacional_2026-10-01_a_2026-10-24.xlsx` (só caracteres seguros no header). */
export const nomeArquivoExcel = (d) => `Checklist-Operacional_${d.periodo.inicio}_a_${d.periodo.fim}.xlsx`;
