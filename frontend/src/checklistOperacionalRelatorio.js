// Checklist Operacional — RELATÓRIO EM PDF do Dashboard Operacional.
//
// Mesmo desenho do relatório executivo (painelAdmPdf.js): documento HTML PRÓPRIO, num iframe isolado, impresso pelo
// navegador ("Salvar como PDF"); sem biblioteca. Os blocos são os MESMOS componentes da tela
// (checklistOperacionalDashboardVisual.js) e os gráficos o mesmo SVG — o PDF não recalcula nada, então corresponde
// exatamente aos filtros e números exibidos. O Excel (backend) usa o mesmo payload.
//
// Privacidade: só número curto do pedido e horários (o payload já não tem cliente, merchant nem orderId).

import { escapeHtml } from "./utils.js";
import { FUSO_PADRAO } from "./checklistOperacionalFuso.js";
import { graficosDoDashboard, NOME_ETAPA } from "./checklistOperacionalGraficos.js";
import {
  kpis, tabelaEtapas, tabelaComparativo, tabelaAtrasos, blocoAnalises, blocoMetas, blocoQualidade, textoPeriodo, SECOES_RELATORIO, num,
} from "./checklistOperacionalDashboardVisual.js";

const LOGO = () => (typeof location !== "undefined" && location.origin ? location.origin : "") + "/assets/logo-crescer-central.jpeg";

/** Resumo executivo em frases (só números do payload). */
export function resumoExecutivo(d) {
  const r = d.resumo;
  const frases = [`${num(r.pedidos, 0)} pedidos acompanhados (${num(r.concluidos, 0)} concluídos, ${num(r.cancelados, 0)} cancelados).`];
  for (const e of d.etapas) {
    const x = r.porEtapa[e];
    if (x.amostras) frases.push(`${NOME_ETAPA[e]}: tempo médio de ${num(x.media)} min em ${num(x.amostras, 0)} pedidos${x.pctDentro == null ? "" : `, ${num(x.pctDentro)}% dentro da meta`}.`);
    else frases.push(`${NOME_ETAPA[e]}: sem medições no período.`);
  }
  if (r.pctPedidosAtrasados != null) frases.push(`${num(r.pedidosAtrasados, 0)} pedidos atrasados (${num(r.pctPedidosAtrasados)}% dos avaliados).`);
  const altas = (d.analises?.itens ?? []).filter((a) => a.severidade === "alta");
  if (altas.length) frases.push(`${altas.length} ${altas.length === 1 ? "ponto de prioridade alta" : "pontos de prioridade alta"}: ${altas.map((a) => a.titulo.toLowerCase()).join("; ")}.`);
  return frases;
}

const secao = (titulo, corpo) => `<section class="pdf-secao"><h2 class="pdf-h2">${escapeHtml(titulo)}</h2>${corpo}</section>`;

/** Corpo do documento conforme as seções escolhidas. */
export function htmlRelatorio(d, secoes, { unidadeNome, geradoEm }) {
  const g = graficosDoDashboard(d);
  const tem = (s) => secoes.includes(s);
  const partes = [];
  partes.push(`
    <header class="pdf-capa">
      <img src="${LOGO()}" alt="" class="pdf-logo"/>
      <div>
        <p class="pdf-marca">Crescer com Delivery · Checklist Operacional</p>
        <h1>Relatório operacional — ${escapeHtml(unidadeNome ?? "Unidade")}</h1>
        <p>Período: <b>${escapeHtml(textoPeriodo(d.periodo))}</b> · Etapa: <b>${d.etapa === "todas" ? "todas" : NOME_ETAPA[d.etapa]}</b></p>
        <p>Comparado com ${escapeHtml(textoPeriodo(d.periodo.anterior))} · Gerado em ${escapeHtml(new Date(geradoEm).toLocaleString("pt-BR", { timeZone: d.periodo.fuso ?? FUSO_PADRAO }))}</p>
      </div>
    </header>`);
  if (tem("resumo")) partes.push(secao("Resumo executivo", `<ul class="pdf-resumo">${resumoExecutivo(d).map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>${kpis(d)}`));
  if (tem("metas")) partes.push(blocoMetas(d));
  if (tem("etapas")) partes.push(tabelaEtapas(d));
  if (tem("comparativo")) partes.push(tabelaComparativo(d));
  if (tem("evolucao")) partes.push(secao("Evolução diária", g.evolucao + g.volumeDiario));
  if (tem("horarios")) partes.push(secao("Demanda e atrasos por horário", g.demandaHora + g.atrasoHora));
  if (tem("semana")) partes.push(secao("Volume por dia da semana e status", g.semana + g.distribuicao));
  if (tem("atrasos")) partes.push(tabelaAtrasos(d, 100));
  if (tem("analises")) partes.push(blocoAnalises(d.analises));
  if (tem("qualidade")) partes.push(blocoQualidade(d));
  if (tem("definicoes")) {
    partes.push(secao("Definições dos indicadores", `<table class="ckd-tabela"><thead><tr><th>Indicador</th><th>Definição</th><th>Fórmula</th><th>Unidade</th><th>Denominador</th><th>Dados ausentes</th></tr></thead><tbody>${Object.values(d.definicoes)
      .map((x) => `<tr><th>${escapeHtml(x.nome)}</th><td>${escapeHtml(x.definicao)}</td><td>${escapeHtml(x.formula)}</td><td>${escapeHtml(x.unidade)}</td><td>${escapeHtml(x.denominador)}</td><td>${escapeHtml(x.ausentes)}</td></tr>`).join("")}</tbody></table>`));
  }
  return partes.join("");
}

export function cssRelatorio() {
  return `
  @page { size: A4; margin: 14mm 12mm 16mm; }
  :root { --ckd-s1: #2a78d6; --ckd-s2: #eb6834; --ckd-s3: #1baf7a; --ckd-bom: #0ca30c; --ckd-ruim: #d03b3b; --ckd-neutro: #b9bcc4; --tx: #17181c; --cz: #5b606b; --ln: #e2e4e9; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 11px/1.45 Inter, system-ui, sans-serif; color: var(--tx); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h1 { font-size: 20px; margin: 2px 0 6px; } h2, .pdf-h2 { font-size: 14px; margin: 0 0 8px; } h3 { font-size: 12px; margin: 0; }
  p { margin: 0 0 4px; }
  .pdf-capa { display: flex; gap: 14px; align-items: center; padding-bottom: 10px; border-bottom: 2px solid #d81324; margin-bottom: 12px; }
  .pdf-logo { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; }
  .pdf-marca { color: #d81324; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; font-size: 10px; }
  .pdf-secao, .ckd-bloco { break-inside: avoid-page; margin: 0 0 14px; }
  .pdf-resumo { margin: 0 0 10px; padding-left: 16px; }
  .ckd-kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .ckd-kpi { border: 1px solid var(--ln); border-radius: 8px; padding: 6px 8px; break-inside: avoid; }
  .ckd-kpi h3 { font-size: 10px; color: var(--cz); font-weight: 600; display: flex; gap: 4px; align-items: center; }
  .ckd-kpi-valor { font-size: 18px; font-weight: 800; } .ckd-kpi-valor small { font-size: 11px; margin-left: 3px; color: var(--cz); }
  .ckd-kpi-sub, .ckd-nota, .ckd-delta { color: var(--cz); font-size: 10px; }
  .ckd-tabela { width: 100%; border-collapse: collapse; font-size: 10px; margin: 4px 0; }
  .ckd-tabela th, .ckd-tabela td { border-bottom: 1px solid var(--ln); padding: 3px 5px; text-align: left; vertical-align: top; }
  .ckd-tabela thead th { background: #f4f5f7; }
  .ckd-marca { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
  .ckd-grafico { margin: 0 0 10px; break-inside: avoid; } .ckd-grafico figcaption b { display: block; } .ckd-grafico figcaption span { color: var(--cz); font-size: 10px; }
  .ckd-grafico svg { width: 100%; height: auto; }
  .ckd-grade { stroke: var(--ln); stroke-width: 1; } .ckd-eixo { fill: var(--cz); font-size: 10px; }
  .ckd-linha { fill: none; stroke-width: 2; } .ckd-ponto { stroke: #fff; stroke-width: 1.5; }
  .ckd-ref { stroke: var(--cz); stroke-dasharray: 4 4; } .ckd-rotulo { fill: var(--tx); font-size: 10px; font-weight: 600; } .ckd-rotulo--dentro { fill: #fff; }
  .ckd-alvo { fill: transparent; }
  .ckd-legenda { display: flex; flex-wrap: wrap; gap: 4px 12px; list-style: none; padding: 0; margin: 4px 0; font-size: 10px; }
  .ckd-legenda i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
  .ckd-tabela-grafico, .ckd-tooltip { display: none; }
  .ckd-analise { border: 1px solid var(--ln); border-left: 3px solid var(--cz); border-radius: 6px; padding: 6px 8px; margin: 0 0 6px; break-inside: avoid; }
  .ckd-analise--alta { border-left-color: #d03b3b; } .ckd-analise--media { border-left-color: #fab219; }
  .ckd-analise header { display: flex; gap: 8px; align-items: baseline; } .ckd-sev { font-size: 9px; font-weight: 700; text-transform: uppercase; color: var(--cz); display: inline-flex; gap: 3px; }
  .ckd-analise dl { margin: 4px 0 0; } .ckd-analise dl div { display: grid; grid-template-columns: 90px 1fr; gap: 6px; } .ckd-analise dt { font-weight: 700; color: var(--cz); } .ckd-analise dd { margin: 0; }
  .ckd-evidencia > summary { font-weight: 600; font-size: 10px; } .ckd-evidencia { margin-top: 4px; }
  .ckd-qualidade { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 12px; } .ckd-qualidade dt { color: var(--cz); } .ckd-qualidade dd { margin: 0; font-weight: 700; }
  .ckd-avisos { padding-left: 0; list-style: none; } .ckd-avisos li { display: flex; gap: 5px; }
  .ckd-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  svg.icon { width: 12px; height: 12px; }
  .pdf-rodape { position: fixed; bottom: -10mm; left: 0; right: 0; font-size: 9px; color: var(--cz); display: flex; justify-content: space-between; }`;
}

/** Documento completo (evidências abertas: no papel ninguém clica). */
export function documentoRelatorio(d, secoes, meta) {
  const corpo = htmlRelatorio(d, secoes, meta).replace(/<details class="ckd-evidencia">/g, '<details class="ckd-evidencia" open>');
  const titulo = `Checklist-Operacional_${d.periodo.inicio}_a_${d.periodo.fim}`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(titulo)}</title><style>${cssRelatorio()}</style></head>
<body>${corpo}<footer class="pdf-rodape"><span>Crescer com Delivery · ${escapeHtml(meta.unidadeNome ?? "")}</span><span>Números calculados pela Central a partir dos pedidos registrados. Hipóteses não são comprovadas.</span></footer></body></html>`;
}

/** Abre a impressão do navegador ("Salvar como PDF") num iframe isolado. */
export function gerarPdfDashboard(d, secoes, meta) {
  return imprimirDocumento(documentoRelatorio(d, secoes, meta));
}

/** Imprime um documento HTML completo num iframe isolado (mesmo mecanismo para o Dashboard e o Fechamento). */
export function imprimirDocumento(documento) {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(frame);
    frame.onload = () => {
      // Espera a logo (ou 1,5 s) para não imprimir a capa sem ela.
      const w = frame.contentWindow;
      const img = w.document.querySelector("img");
      let feito = false;
      const imprimir = () => {
        if (feito) return;
        feito = true;
        try { w.focus(); w.print(); } catch { /* bloqueado */ }
        setTimeout(() => { frame.remove(); resolve(); }, 1000);
      };
      if (!img || img.complete) imprimir();
      else { img.addEventListener("load", imprimir, { once: true }); img.addEventListener("error", imprimir, { once: true }); setTimeout(imprimir, 1500); }
    };
    frame.srcdoc = documento;
  });
}

export const IDS_SECOES = SECOES_RELATORIO.map((s) => s.id);
