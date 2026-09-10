// RELATÓRIO EXECUTIVO EM PDF — Painel Administrativo / Crescer com Delivery.
//
// ARQUITETURA: template HTML DEDICADO + `window.print()` com CSS Paged Media.
// Zero biblioteca (o projeto não tem nenhuma de geração de PDF; `pdf-parse`
// só LÊ). O navegador faz a paginação, e `break-inside: avoid` garante que
// nenhum card, empresa ou bloco de unidade seja cortado ao meio — nativamente,
// melhor do que qualquer paginação manual em jsPDF.
//
// NÃO é "imprimir a tela": é um documento próprio, montado num iframe isolado,
// com capa, cabeçalho/rodapé fixos, numeração e a identidade da marca.
//
// DADOS: vêm prontos de `GET /administrativo/relatorios/executivo`. Este
// arquivo NÃO recalcula regra alguma — nem status, nem pendência, nem
// faturamento. É camada de apresentação.

import { escapeHtml } from "./utils.js";
import {
  fmtPct, fmtNum, fmtData, fmtDataCurta, fmtMesLongo, fmtDinheiro,
  fmtVariacao, fmtVariacaoPP, fmtDiasPendentes, CATEGORIA_D1, CRITICIDADE, textoCobertura, textoCoberturaCurto,
} from "./painelAdmUi.js";

/** Seções que o modal oferece. `padrao` marca o que vem ligado. */
export const SECOES_PDF = [
  { id: "resumo", label: "Resumo executivo", padrao: true },
  { id: "saude", label: "Saúde da rede", padrao: true },
  { id: "pendentes", label: "Empresas com pendência", padrao: true },
  { id: "unidadesPendentes", label: "Detalhe das unidades pendentes", padrao: true },
  { id: "emDia", label: "Empresas em dia", padrao: true },
  { id: "financeiro", label: "Faturamento e comparação", padrao: true },
  { id: "evolucao", label: "Evolução do faturamento", padrao: true },
  { id: "rankFaturamento", label: "Ranking de faturamento", padrao: true },
  { id: "rankConformidade", label: "Ranking de conformidade", padrao: true },
  { id: "prioridades", label: "Prioridades do período", padrao: true },
  { id: "tabelaEmpresas", label: "Tabela completa de empresas", padrao: true },
  // Desligada por padrão: numa rede grande é a seção que mais cresce.
  { id: "tabelaUnidades", label: "Tabela completa de unidades", padrao: false },
];

export const secoesPadrao = () =>
  Object.fromEntries(SECOES_PDF.map((s) => [s.id, s.padrao]));

/** `Crescer-com-Delivery_Relatorio-Executivo_2026-09.pdf` */
export const nomeArquivoPdf = (periodo) =>
  `Crescer-com-Delivery_Relatorio-Executivo_${periodo ?? "periodo"}.pdf`;

/**
 * Logo oficial — o MESMO arquivo do favicon e da tela de seleção (não duplica
 * asset). Resolvido pela origem em runtime: o documento vive num iframe
 * `srcdoc`/aba nova, e um caminho relativo poderia quebrar. Em produção sai o
 * domínio real, nunca localhost.
 */
export const LOGO_URL = (typeof location !== "undefined" && location.origin ? location.origin : "")
  + "/assets/logo-crescer-central.jpeg";

const dataHoraBR = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * Limpa texto vindo do banco antes de imprimir. O PDF anterior mostrou
 * "Feira de Santana\uFFFEBA": U+FFFE é um NONCHARACTER, que nenhuma fonte
 * desenha — vira caixinha. Tira controles C0/C1, noncharacters e substitutos
 * órfãos, e PRESERVA acentos, ç, hífen e traços tipográficos.
 * @param {unknown} v
 */
export function limparTexto(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .normalize("NFC")
    // controles C0/C1 (menos tab/quebra), noncharacters U+FFFE/U+FFFF e U+FDD0..U+FDEF
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFDD0-\uFDEF\uFFFE\uFFFF]/g, "")
    // substitutos órfãos (metade de um par UTF-16 quebrado)
    .replace(/[\uD800-\uDFFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** `escapeHtml` + sanitização — todo texto do documento passa por aqui. */
const txt = (v) => escapeHtml(limparTexto(v));

const rotuloCategoria = (c) => CATEGORIA_D1[c]?.rotulo ?? (c ?? "—");
const rotuloCriticidade = (c) => CRITICIDADE[c]?.rotulo ?? (c ?? "—");
const tomCriticidade = (c) => CRITICIDADE[c]?.classe ?? "muted";

/** Selo do ajuste provisório — POSITIVO ou NEGATIVO (correção para baixo). */
function textoProvisorio(f) {
  const v = f?.provisorio ?? 0;
  if (!v) return "";
  return v > 0
    ? `inclui ${fmtDinheiro(v)} provisórios`
    : `ajuste provisório de ${fmtDinheiro(v)}`;
}

// ---------------------------------------------------------------------------
// Blocos
// ---------------------------------------------------------------------------

const kpi = (rot, val, sub = "", tom = "") => `
  <div class="k ${tom ? `k--${tom}` : ""}">
    <span class="k-r">${escapeHtml(rot)}</span>
    <span class="k-v">${escapeHtml(String(val))}</span>
    ${sub ? `<span class="k-s">${escapeHtml(sub)}</span>` : ""}
  </div>`;

const secao = (titulo, corpo, sub = "") => `
  <section class="sec">
    <h2>${escapeHtml(titulo)}</h2>
    ${sub ? `<p class="sec-sub">${escapeHtml(sub)}</p>` : ""}
    ${corpo}
  </section>`;

/**
 * Tabela. Cada coluna aceita `{ t, num, w }`:
 *   `num` alinha à direita e trava o `nowrap` (dinheiro nunca quebra);
 *   `w`   fixa a largura em % — nome de empresa/unidade fica largo, coluna
 *         numérica fica estreita. Sem isso os nomes quebravam em 3–4 linhas
 *         enquanto colunas de 1 dígito sobravam espaço.
 * `<colgroup>` é o que dá controle real de largura em `table-layout: fixed`.
 */
const tabela = (colunas, linhas, vazio = "Sem registros no período.") => {
  if (!linhas.length) return `<p class="vazio">${escapeHtml(vazio)}</p>`;
  const cols = colunas.some((c) => c.w)
    ? `<colgroup>${colunas.map((c) => `<col${c.w ? ` style="width:${c.w}"` : ""}>`).join("")}</colgroup>`
    : "";
  return `
    <table>
      ${cols}
      <thead><tr>${colunas.map((c) => `<th${c.num ? ' class="n"' : ""}>${escapeHtml(c.t ?? c)}</th>`).join("")}</tr></thead>
      <tbody>${linhas.map((l) => `<tr>${l.map((c, i) => `<td${colunas[i]?.num ? ' class="n"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>`;
};

/** Barra segmentada crítica / atenção / em dia. */
function barraSaude(o) {
  const total = (o.criticas || 0) + (o.atencao || 0) + (o.emDia || 0);
  if (!total) return "";
  const p = (n) => `${((n / total) * 100).toFixed(2)}%`;
  return `
    <div class="saude">
      <div class="saude-barra">
        ${o.criticas ? `<i class="b-critico" style="width:${p(o.criticas)}"></i>` : ""}
        ${o.atencao ? `<i class="b-atencao" style="width:${p(o.atencao)}"></i>` : ""}
        ${o.emDia ? `<i class="b-ok" style="width:${p(o.emDia)}"></i>` : ""}
      </div>
      <div class="saude-leg">
        <span><i class="b-critico"></i>${fmtNum(o.criticas)} críticas</span>
        <span><i class="b-atencao"></i>${fmtNum(o.atencao)} em atenção</span>
        <span><i class="b-ok"></i>${fmtNum(o.emDia)} em dia</span>
      </div>
    </div>`;
}

/** Gráfico de evolução em SVG — delta negativo desenha abaixo da linha zero. */
function grafico(serie) {
  const pts = (serie ?? []).filter((p) => p.valor != null || p.acumulado != null);
  if (!pts.length) return `<p class="vazio">Sem série no período.</p>`;
  const vals = (serie ?? []).map((p) => (p.valor == null ? null : Number(p.valor)));
  const max = Math.max(...vals.filter((v) => v != null).map(Math.abs), 1);
  const temNeg = vals.some((v) => v != null && v < 0);
  const zero = temNeg ? 55 : 100;           // linha do zero, em % da altura
  const escala = temNeg ? 45 : 95;
  const L = 100 / (serie?.length || 1);

  const barras = (serie ?? []).map((p, i) => {
    const v = vals[i];
    // com poucos dias a barra ficaria larguíssima — limita a fatia usada
    const fatia = Math.min(0.62, 8 / (serie?.length || 1));
    const x = (i * L + L * (1 - fatia) / 2).toFixed(3);
    const w = (L * fatia).toFixed(3);
    if (v == null) return `<rect x="${x}%" y="${(zero - 0.6).toFixed(2)}" width="${w}%" height="1.2" class="g-vazio"/>`;
    const h = Math.max((Math.abs(v) / max) * escala, 0.8);
    const y = v >= 0 ? zero - h : zero;
    return `<rect x="${x}%" y="${y.toFixed(2)}" width="${w}%" height="${h.toFixed(2)}" class="${v >= 0 ? "g-barra" : "g-barra-neg"}"/>`;
  }).join("");

  const eixo = (serie ?? []).map((p, i) => (i % 4 === 0 || i === serie.length - 1
    ? `<span style="left:${(i * L + L / 2).toFixed(3)}%">${p.data.slice(8, 10)}</span>` : "")).join("");

  // Altura proporcional ao período: uma barra só não pode ocupar 1/4 da folha.
  const nd = (serie ?? []).length;
  const porte = nd <= 3 ? "curto" : nd <= 15 ? "medio" : "longo";

  return `
    <div class="graf graf--${porte}">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <line x1="0" y1="${zero}" x2="100" y2="${zero}" class="g-zero"/>
        ${barras}
      </svg>
      <div class="graf-eixo">${eixo}</div>
      <p class="graf-nota">Valor de cada dia (variação do acumulado). Dia sem lançamento fica vazio — nunca estimado.</p>
    </div>`;
}

/** Bloco de uma empresa com pendência + suas unidades. */
function blocoEmpresaPendente(e, { comUnidades = true } = {}) {
  const unidades = comUnidades && (e.pendentes ?? []).length
    ? `<div class="unis">
         <span class="unis-t">Unidades com pendência (${e.pendentes.length})</span>
         ${e.pendentes.map((u) => `
           <div class="uni">
             <span class="uni-n">${txt(u.unidadeNome ?? "—")}</span>
             <span class="uni-d">
               <b class="t-${tomCriticidade(u.criticidade)}">${escapeHtml(rotuloCriticidade(u.criticidade))}</b>
               · ${escapeHtml(rotuloCategoria(u.d1Status))}
               ${u.diasPendentes > 0 ? ` · ${escapeHtml(fmtDiasPendentes(u.diasPendentes))} no período` : ""}
               ${u.pendenciaMaisAntiga ? ` · desde ${escapeHtml(fmtDataCurta(u.pendenciaMaisAntiga))}` : ""}
             </span>
             ${u.pendenciaHerdada ? `<span class="uni-h">Pendência histórica iniciada em ${escapeHtml(fmtDataCurta(u.pendenciaHerdadaDesde))} — não contada nos dias do período.</span>` : ""}
           </div>`).join("")}
       </div>`
    : "";

  return `
    <div class="emp emp--${e.severidade === 0 ? "critico" : "atencao"}">
      <div class="emp-h">
        <b>${txt(e.empresaNome ?? "—")}</b>
        <span class="badge badge--${e.severidade === 0 ? "critico" : "atencao"}">
          ${e.unidadesPendentes} de ${e.unidadesMonitoradas} unidade(s) com pendência
        </span>
      </div>
      <div class="emp-m">
        <span><small>Críticas</small><b class="t-critico">${fmtNum(e.criticas)}</b></span>
        <span><small>Atenção</small><b class="t-atencao">${fmtNum(e.atencao)}</b></span>
        <span><small>Em dia</small><b class="t-ok">${fmtNum(e.emDia)}</b></span>
        <span><small>Conf. D-1</small><b>${fmtPct(e.conformidadeD1)}</b></span>
        <span><small>Conf. mês</small><b>${fmtPct(e.conformidadeMes)}</b></span>
        <span><small>Mais antiga</small><b>${fmtData(e.pendenciaMaisAntiga)}</b></span>
        ${e.faturamento?.total != null ? `<span><small>Faturamento</small><b>${escapeHtml(fmtDinheiro(e.faturamento.total))}</b></span>` : ""}
      </div>
      ${e.piorUnidade ? `<p class="prio">Unidade prioritária: <b>${txt(e.piorUnidade.unidadeNome ?? "—")}</b></p>` : ""}
      ${e.historicoAnterior?.existe ? `<p class="hist">Há histórico anterior ao período (desde ${escapeHtml(fmtData(e.historicoAnterior.desde))}) — não afeta a saúde deste mês.</p>` : ""}
      ${unidades}
    </div>`;
}

// ---------------------------------------------------------------------------
// Documento
// ---------------------------------------------------------------------------

/**
 * Monta o HTML completo do relatório.
 * @param {object} d saída de GET /administrativo/relatorios/executivo
 * @param {Record<string, boolean>} sec seções ligadas
 */
export function htmlRelatorioPdf(d, sec = secoesPadrao()) {
  const o = d?.operacao ?? {}, cf = d?.conformidade ?? {}, f = d?.faturamento ?? {}, c = d?.comparacao;
  const periodoLongo = fmtMesLongo(d?.periodo);
  const geradoEm = dataHoraBR(d?.geradoEm);

  const capa = `
    <section class="pagina pagina--capa">
      <div class="capa-topo">
        <img class="capa-logo" src="${LOGO_URL}" alt="" />
        <span class="capa-marca">Crescer com Delivery</span>
      </div>
      <div class="capa-faixa"></div>
      <h1>Relatório Executivo</h1>
      <p class="capa-sub">Monitoramento · ${escapeHtml(d?.monitorNome ?? "Dashboard iFood")}</p>
      <p class="capa-per">${escapeHtml(periodoLongo)}</p>
      <div class="capa-nums">
        <span><b>${fmtNum(o.empresasMonitoradas)}</b>empresas monitoradas</span>
        <span><b>${fmtNum(o.unidadesMonitoradas)}</b>unidades monitoradas</span>
      </div>
      <p class="capa-pe">
        Fechamento monitorado: <b>${fmtData(d?.d1)}</b>${d?.mesCorrente === false ? " · mês fechado" : ""}<br>
        Gerado em ${escapeHtml(geradoEm)} · Uso interno
      </p>
    </section>`;

  const partes = [];

  if (sec.resumo) {
    partes.push(secao("Resumo executivo", `
      <div class="kpis">
        ${kpi("Empresas monitoradas", fmtNum(o.empresasMonitoradas))}
        ${kpi("Unidades monitoradas", fmtNum(o.unidadesMonitoradas))}
        ${kpi("Empresas com pendência", fmtNum(o.empresasComPendencia), `${fmtNum(o.empresasEmDia)} em dia`, o.empresasComPendencia > 0 ? "critico" : "ok")}
        ${kpi("Unidades com pendência", fmtNum(o.unidadesComPendencia), `de ${fmtNum(o.unidadesMonitoradas)}`, o.unidadesComPendencia > 0 ? "critico" : "ok")}
        ${kpi("Críticas", fmtNum(o.criticas), "", o.criticas > 0 ? "critico" : "")}
        ${kpi("Atenção", fmtNum(o.atencao), "", o.atencao > 0 ? "atencao" : "")}
        ${kpi("Em dia", fmtNum(o.emDia), "", "ok")}
        ${kpi("Conformidade D-1", fmtPct(cf.d1), `${fmtNum(cf.d1Concluidas)} de ${fmtNum(cf.d1Elegiveis)}`)}
        ${kpi("Conformidade do mês", fmtPct(cf.mes), `${fmtNum(cf.mesCompleto)} de ${fmtNum(cf.mesEsperado)} dias`)}
        ${f.total != null ? kpi("Faturamento da rede", fmtDinheiro(f.total), textoCobertura(f.cobertura)) : ""}
        ${f.total != null ? kpi("Confirmado", fmtDinheiro(f.confirmado)) : ""}
        ${f.provisorio ? kpi(f.provisorio > 0 ? "Provisório" : "Ajuste provisório", fmtDinheiro(f.provisorio), "não finalizado", "atencao") : ""}
      </div>`, `Período analisado: ${periodoLongo}`));
  }

  if (sec.saude) partes.push(secao("Saúde da rede", barraSaude(o), "Proporção de unidades por criticidade no período"));

  if (sec.pendentes) {
    const lista = d?.empresas?.comPendencia ?? [];
    partes.push(secao("Empresas com pendências",
      lista.length
        ? lista.map((e) => blocoEmpresaPendente(e, { comUnidades: !!sec.unidadesPendentes })).join("")
        : `<p class="vazio">Nenhuma empresa com pendência no período.</p>`,
      lista.length ? `${lista.length} empresa(s) precisam de ação — da mais grave para a menos grave` : ""));
  }

  if (sec.emDia) {
    const lista = d?.empresas?.emDia ?? [];
    partes.push(secao("Empresas em dia", tabela(
      [{ t: "Empresa", w: "34%" }, { t: "Unid.", num: true, w: "7%" }, { t: "Conf. D-1", num: true, w: "10%" },
       { t: "Conf. mês", num: true, w: "10%" }, { t: "Faturamento", num: true, w: "15%" },
       { t: "Cobertura", num: true, w: "15%" }, { t: "Status", w: "9%" }],
      lista.map((e) => [
        txt(e.empresaNome ?? "—")
          + (e.historicoAnterior?.existe
            ? `<br><small class="hist-i">Há histórico anterior ao período (desde ${escapeHtml(fmtData(e.historicoAnterior.desde))}) — não afeta a saúde deste mês.</small>`
            : ""),
        fmtNum(e.unidadesMonitoradas),
        fmtPct(e.conformidadeD1),
        fmtPct(e.conformidadeMes),
        escapeHtml(fmtDinheiro(e.faturamento?.total)),
        escapeHtml(textoCobertura(e.cobertura) || "—"),
        `<span class="badge badge--ok">Em dia</span>`,
      ]),
      "Nenhuma empresa fechou o período sem pendência.",
    ), "Preencheram corretamente o período — pendência de mês anterior não retira desta lista"));
  }

  if (sec.financeiro && f.total != null) {
    partes.push(secao("Faturamento", `
      <div class="fin">
        <div class="fin-t">
          <span class="fin-r">Faturamento da rede no período</span>
          <b class="fin-v">${escapeHtml(fmtDinheiro(f.total))}</b>
          <span class="fin-l">
            Confirmado <b>${escapeHtml(fmtDinheiro(f.confirmado))}</b>
            ${f.provisorio ? ` · ${escapeHtml(textoProvisorio(f))}` : ""}
            ${textoCobertura(f.cobertura) ? ` · Cobertura <b>${escapeHtml(textoCobertura(f.cobertura))}</b>` : ""}
          </span>
        </div>
        ${c?.faturamento ? `
          <div class="fin-c">
            <span class="fin-cv">${escapeHtml(fmtVariacao(c.faturamento.variacao) || "—")}</span>
            <small>vs ${escapeHtml(fmtMesLongo(c.periodo))} · mesmos ${c.diasEquivalentes} dias${c.faturamento.incluiProvisorio ? " · inclui dados não finalizados" : ""}</small>
          </div>` : ""}
      </div>
      ${f.liderEmpresa || f.liderUnidade ? `
        <div class="lideres">
          ${f.liderEmpresa ? `<span><small>Empresa líder</small><b>${txt(f.liderEmpresa.nome ?? "—")}</b><i>${escapeHtml(fmtDinheiro(f.liderEmpresa.total))}</i></span>` : ""}
          ${f.liderUnidade ? `<span><small>Unidade líder</small><b>${txt(f.liderUnidade.nome ?? "—")}</b><i>${escapeHtml(fmtDinheiro(f.liderUnidade.total))}</i></span>` : ""}
        </div>` : ""}
      ${c ? `
        <table class="comp">
          <thead><tr><th>Indicador</th><th class="n">Período atual</th><th class="n">${escapeHtml(fmtMesLongo(c.periodo))} (1–${c.diasEquivalentes})</th><th class="n">Variação</th></tr></thead>
          <tbody>
            <tr><td>Faturamento</td><td class="n">${escapeHtml(fmtDinheiro(f.total))}</td><td class="n">${escapeHtml(fmtDinheiro(c.faturamento?.anterior))}</td><td class="n">${escapeHtml(fmtVariacao(c.faturamento?.variacao) || "—")}</td></tr>
            <tr><td>Conformidade do mês</td><td class="n">${fmtPct(cf.mes)}</td><td class="n">${fmtPct(c.conformidadeMes?.anterior)}</td><td class="n">${escapeHtml(fmtVariacaoPP(c.conformidadeMes?.variacaoPP) || "—")}</td></tr>
            <tr><td>Unidades com pendência</td><td class="n">${fmtNum(o.criticas + o.atencao)}</td><td class="n">${fmtNum(c.pendencias?.anterior)}</td><td class="n">${c.pendencias?.variacao == null ? "—" : `${c.pendencias.variacao > 0 ? "+" : ""}${fmtNum(c.pendencias.variacao)}`}</td></tr>
          </tbody>
        </table>` : ""}`,
      c ? "Comparação com o período equivalente do mês anterior — mesmo número de dias" : ""));
  }

  if (sec.evolucao) partes.push(secao("Evolução do faturamento", grafico(d?.evolucao)));

  if (sec.rankFaturamento) {
    const emp = d?.rankings?.faturamentoEmpresas ?? [];
    const uni = d?.rankings?.faturamentoUnidades ?? [];
    partes.push(secao("Top empresas por faturamento", tabela(
      [{ t: "#", num: true, w: "6%" }, { t: "Empresa", w: "40%" }, { t: "Faturamento", num: true, w: "18%" },
       { t: "Cobertura", num: true, w: "20%" }, { t: "Conformidade", num: true, w: "16%" }],
      emp.map((i) => [
        String(i.posicao).padStart(2, "0"),
        `${txt(i.nome ?? "—")}${i.faturamento?.provisorio ? `<br><small class="prov">${escapeHtml(textoProvisorio(i.faturamento))}</small>` : ""}`,
        escapeHtml(fmtDinheiro(i.faturamento?.total)),
        escapeHtml(textoCobertura(i.cobertura) || "—"),
        fmtPct(i.conformidadeMes),
      ]),
    ), "Soma do snapshot financeiro mais recente de cada unidade — nunca a soma dos acumulados diários"));

    partes.push(secao("Top unidades por faturamento", tabela(
      [{ t: "#", num: true, w: "6%" }, { t: "Unidade", w: "26%" }, { t: "Empresa", w: "26%" },
       { t: "Faturamento", num: true, w: "15%" }, { t: "Cobertura", num: true, w: "16%" }, { t: "Conformidade", num: true, w: "11%" }],
      uni.map((i) => [
        String(i.posicao).padStart(2, "0"),
        txt(i.nome ?? "—"),
        txt(i.empresaNome ?? "—"),
        escapeHtml(fmtDinheiro(i.faturamento?.total)),
        escapeHtml(textoCobertura(i.cobertura) || "—"),
        fmtPct(i.conformidadeMes),
      ]),
    )));
  }

  if (sec.rankConformidade) {
    const linhas = (l) => l.map((i) => [
      String(i.posicao).padStart(2, "0"),
      txt(i.nome ?? "—"),
      fmtPct(i.conformidadeMes),
      fmtNum(i.unidadesPendentes ?? 0),
    ]);
    const cols = [{ t: "#", num: true, w: "6%" }, { t: "Empresa", w: "54%" },
                  { t: "Conformidade", num: true, w: "18%" }, { t: "Unidades pendentes", num: true, w: "22%" }];
    partes.push(secao("Melhores em conformidade", tabela(cols, linhas(d?.rankings?.conformidadeEmpresas ?? []))));
    partes.push(secao("Maior atenção necessária", tabela(cols, linhas(d?.rankings?.atencaoEmpresas ?? [])),
      "Empresas onde apoiar primeiro no próximo período"));
  }

  if (sec.prioridades) {
    const p = d?.prioridades ?? [];
    partes.push(secao("Prioridades do período", tabela(
      [{ t: "#", num: true, w: "5%" }, { t: "Empresa", w: "26%" }, { t: "Unidade", w: "24%" },
       { t: "Status", w: "17%" }, { t: "Criticidade", w: "13%" }, { t: "Dias", num: true, w: "7%" }, { t: "Desde", num: true, w: "8%" }],
      p.map((u, i) => [
        String(i + 1).padStart(2, "0"),
        txt(u.empresaNome ?? "—"),
        `${txt(u.unidadeNome ?? "—")}${u.pendenciaHerdada ? `<br><small class="prov">histórico desde ${escapeHtml(fmtDataCurta(u.pendenciaHerdadaDesde))}</small>` : ""}`,
        escapeHtml(rotuloCategoria(u.d1Status)),
        `<b class="t-${tomCriticidade(u.criticidade)}">${escapeHtml(rotuloCriticidade(u.criticidade))}</b>`,
        u.diasPendentes || "—",
        escapeHtml(fmtDataCurta(u.pendenciaMaisAntiga)),
      ]),
      "Nenhuma unidade precisa de ação no período.",
    ), "Ordem de tratamento: sequência travada → não iniciado → em aberto"));
  }

  if (sec.tabelaEmpresas) {
    partes.push(secao("Resumo por empresa", tabela(
      [{ t: "Empresa", w: "36%" }, { t: "Unid.", num: true, w: "4.5%" }, { t: "Pend.", num: true, w: "4.5%" },
       { t: "Crít.", num: true, w: "4.5%" }, { t: "Aten.", num: true, w: "4.5%" }, { t: "Em dia", num: true, w: "5%" },
       { t: "D-1", num: true, w: "5.5%" }, { t: "Mês", num: true, w: "5.5%" },
       { t: "Faturamento", num: true, w: "11%" }, { t: "Cobertura", num: true, w: "9%" }, { t: "Status", w: "6.5%" }],
      (d?.empresas?.todas ?? []).map((e) => [
        txt(e.empresaNome ?? "—"),
        fmtNum(e.unidadesMonitoradas), fmtNum(e.unidadesPendentes),
        fmtNum(e.criticas), fmtNum(e.atencao), fmtNum(e.emDia),
        fmtPct(e.conformidadeD1), fmtPct(e.conformidadeMes),
        escapeHtml(fmtDinheiro(e.faturamento?.total)),
        escapeHtml(textoCoberturaCurto(e.cobertura) || "—"),
        `<span class="badge badge--${e.severidade === 0 ? "critico" : e.severidade === 1 ? "atencao" : "ok"}">${e.severidade === 0 ? "Crítica" : e.severidade === 1 ? "Atenção" : "Em dia"}</span>`,
      ]),
    ), "Todas as empresas monitoradas no período"));
  }

  if (sec.tabelaUnidades) {
    partes.push(secao("Resumo por unidade", tabela(
      [{ t: "Empresa", w: "26%" }, { t: "Unidade", w: "24%" }, { t: "Status D-1", w: "13%" },
       { t: "Criticidade", w: "10%" }, { t: "Pend.", num: true, w: "5%" }, { t: "Conf. mês", num: true, w: "7%" },
       { t: "Faturamento", num: true, w: "8%" }, { t: "Cobertura", num: true, w: "7%" }],
      (d?.unidades ?? []).map((u) => [
        txt(u.empresaNome ?? "—"),
        txt(u.unidadeNome ?? "—"),
        escapeHtml(rotuloCategoria(u.d1Status)),
        `<b class="t-${tomCriticidade(u.criticidade)}">${escapeHtml(rotuloCriticidade(u.criticidade))}</b>`,
        u.diasPendentes || "—",
        fmtPct(u.conformidadeMes),
        escapeHtml(fmtDinheiro(u.faturamento?.total)),
        escapeHtml(textoCoberturaCurto(u.cobertura) || "—"),
      ]),
    ), "Todas as unidades monitoradas no período"));
  }

  return `${capa}<div id="fonte">${partes.join("")}</div>`;
}

/** Cabeçalho/rodapé de cada página + a folha de estilo do documento. */
export function cssRelatorioPdf() {
  return `
/* Margem ZERO no @page: cada .pagina controla o próprio recuo. É o que permite
   reservar altura física para cabeçalho e rodapé — com \`position: fixed\` o
   Chrome os ancorava DENTRO da área de conteúdo e eles cobriam as tabelas. */
@page { size: A4 portrait; margin: 0; }

*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font: 400 9pt/1.4 "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
  color: #17181c; background: #fff;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
b, strong { font-weight: 700; }
small { font-size: 7.2pt; }

/* ---------- página ---------- */
.pagina {
  width: 210mm; height: 297mm; padding: 14mm 12mm;
  display: flex; flex-direction: column; overflow: hidden;
  page-break-after: always; break-after: page;
}
.pagina:last-child { page-break-after: auto; break-after: auto; }
.pg-cab, .pg-rod {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 7pt; color: #8a8f97; flex: 0 0 auto;
}
.pg-cab { height: 8mm; border-bottom: .5pt solid #e8e9ee; margin-bottom: 4mm; }
.pg-rod { height: 7mm; border-top: .5pt solid #e8e9ee; margin-top: auto; padding-top: 2mm; }
.pg-cab b { color: #7d0f1c; }
.pg-corpo { flex: 1 1 auto; min-height: 0; }

/* ---------- capa ---------- */
.pagina--capa {
  padding: 26mm 22mm;
  background: linear-gradient(160deg, #2a0609 0%, #4a0a10 46%, #7d0f1c 100%);
  color: #fff;
}
.capa-topo { display: flex; align-items: center; gap: 5mm; }
.capa-logo {
  width: 16mm; height: 16mm; border-radius: 3.5mm; object-fit: contain;
  background: #0a0a0c; flex: 0 0 auto;
}
.capa-marca { font-size: 11pt; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; opacity: .85; }
.capa-faixa { width: 54mm; height: 3.5pt; background: #F42433; border-radius: 2pt; margin: 7mm 0 auto; }
.pagina--capa h1 { font-size: 34pt; font-weight: 800; letter-spacing: -1pt; line-height: 1.05; margin: 0 0 3mm; }
.capa-sub { font-size: 11.5pt; opacity: .8; margin: 0 0 12mm; }
.capa-per {
  font-size: 16pt; font-weight: 700; margin: 0 0 12mm; padding: 3mm 6mm;
  border-left: 3pt solid #F42433; background: rgba(255,255,255,.07); width: fit-content;
}
.capa-nums { display: flex; gap: 16mm; margin-bottom: auto; }
.capa-nums span { display: flex; flex-direction: column; font-size: 9pt; opacity: .8; }
.capa-nums b { font-size: 26pt; font-weight: 800; opacity: 1; letter-spacing: -1pt; }
.capa-pe { font-size: 8.5pt; opacity: .7; line-height: 1.7; margin: 0; }

/* ---------- seções ---------- */
.sec { margin-bottom: 5mm; }
.sec > h2 {
  font-size: 12pt; font-weight: 750; color: #7d0f1c; margin: 0 0 1mm;
  padding-bottom: 1.2mm; border-bottom: 1.1pt solid #7d0f1c;
  break-after: avoid; page-break-after: avoid;
}
.sec-sub { font-size: 7.6pt; color: #666b73; margin: 0 0 2.4mm; break-after: avoid; page-break-after: avoid; }
.sec-cont {
  font-size: 8pt; font-weight: 700; color: #7d0f1c; margin: 0 0 2mm;
  padding-bottom: 1mm; border-bottom: .8pt solid #e8e9ee;
}

/* ---------- KPIs ---------- */
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2mm; break-inside: avoid; page-break-inside: avoid; }
.k {
  border: .7pt solid #e8e9ee; border-left: 2.2pt solid #cfd2d8; border-radius: 1.6mm;
  padding: 2mm 2.4mm; break-inside: avoid; page-break-inside: avoid;
}
.k--critico { border-left-color: #c0121f; background: #fdf4f4; }
.k--atencao { border-left-color: #c48a12; background: #fdfaf1; }
.k--ok { border-left-color: #0e9d57; background: #f3fbf7; }
.k-r { display: block; font-size: 6.2pt; font-weight: 750; letter-spacing: .4pt; text-transform: uppercase; color: #666b73; }
.k-v { display: block; font-size: 14pt; font-weight: 780; letter-spacing: -.4pt; line-height: 1.15; }
.k-s { display: block; font-size: 6.6pt; color: #666b73; }

/* ---------- saúde ---------- */
.saude { break-inside: avoid; page-break-inside: avoid; }
.saude-barra { display: flex; height: 5mm; border-radius: 1.2mm; overflow: hidden; background: #eef0f3; }
.saude-barra i { display: block; height: 100%; }
.saude-leg { display: flex; gap: 7mm; margin-top: 2mm; font-size: 8pt; }
.saude-leg span { display: inline-flex; align-items: center; gap: 1.8mm; }
.saude-leg i { width: 2.4mm; height: 2.4mm; border-radius: .7mm; display: inline-block; }
.b-critico { background: #c0121f; }
.b-atencao { background: #c48a12; }
.b-ok { background: #0e9d57; }

/* ---------- empresa ---------- */
.emp {
  border: .7pt solid #e8e9ee; border-left: 2.2pt solid #cfd2d8; border-radius: 1.6mm;
  padding: 2.8mm 3.4mm; margin-bottom: 2.6mm;
  break-inside: avoid; page-break-inside: avoid;
}
.emp--critico { border-left-color: #c0121f; }
.emp--atencao { border-left-color: #c48a12; }
.emp-h { display: flex; justify-content: space-between; align-items: baseline; gap: 4mm; margin-bottom: 1.8mm; }
.emp-h b { font-size: 10.5pt; font-weight: 720; }
.emp-m { display: flex; flex-wrap: wrap; gap: 1.4mm 6mm; padding-bottom: 1.4mm; }
.emp-m span { display: flex; flex-direction: column; line-height: 1.2; }
.emp-m small { font-size: 6pt; font-weight: 750; letter-spacing: .3pt; text-transform: uppercase; color: #666b73; }
.emp-m b { font-size: 9.5pt; font-weight: 740; }
.prio { font-size: 8.2pt; margin: 0 0 .6mm; }
.hist { font-size: 7.2pt; color: #666b73; font-style: italic; margin: 0 0 .6mm; }

.unis { border-top: .5pt dashed #e8e9ee; padding-top: 1.8mm; margin-top: .6mm; }
.unis-t { display: block; font-size: 6.2pt; font-weight: 750; letter-spacing: .4pt; text-transform: uppercase; color: #666b73; margin-bottom: 1.2mm; }
.uni { padding: 1mm 0; border-bottom: .4pt solid #f2f3f6; break-inside: avoid; }
.uni:last-child { border-bottom: 0; }
.uni-n { display: block; font-size: 9pt; font-weight: 680; }
.uni-d { display: block; font-size: 7.6pt; color: #666b73; }
.uni-h { display: block; font-size: 6.8pt; color: #8a8f97; font-style: italic; }

.t-critico { color: #c0121f; }
.t-atencao { color: #c48a12; }
.t-ok { color: #0e9d57; }
.t-muted { color: #666b73; }

.badge { display: inline-block; font-size: 6.6pt; font-weight: 720; padding: .4mm 1.8mm; border-radius: 5pt; white-space: nowrap; }
.badge--critico { background: #fbe4e6; color: #c0121f; }
.badge--atencao { background: #fdf3d9; color: #8a6208; }
.badge--ok { background: #e2f7ec; color: #0b7a44; }

/* ---------- financeiro ---------- */
.fin {
  display: flex; justify-content: space-between; align-items: center; gap: 8mm;
  border: .7pt solid #e8e9ee; border-left: 2.2pt solid #7d0f1c; border-radius: 1.6mm;
  padding: 3mm 4mm; break-inside: avoid; page-break-inside: avoid;
}
.fin-r { display: block; font-size: 6.4pt; font-weight: 750; letter-spacing: .4pt; text-transform: uppercase; color: #666b73; }
.fin-v { display: block; font-size: 19pt; font-weight: 800; letter-spacing: -.7pt; line-height: 1.1; }
.fin-l { display: block; font-size: 7.6pt; color: #666b73; margin-top: .6mm; }
.fin-c { text-align: right; white-space: nowrap; }
.fin-cv { display: block; font-size: 13pt; font-weight: 760; color: #0b7a44; }
.fin-c small { display: block; font-size: 6.6pt; color: #666b73; white-space: normal; }
.lideres { display: flex; gap: 12mm; margin-top: 2.4mm; break-inside: avoid; page-break-inside: avoid; }
.lideres span { display: flex; flex-direction: column; line-height: 1.25; }
.lideres small { font-size: 6.2pt; font-weight: 750; letter-spacing: .3pt; text-transform: uppercase; color: #666b73; }
.lideres b { font-size: 9.5pt; font-weight: 700; }
.lideres i { font-style: normal; font-size: 8.6pt; font-weight: 720; color: #7d0f1c; }
.comp { margin-top: 3mm; }

/* ---------- gráfico (altura conforme o nº de dias) ---------- */
.graf { break-inside: avoid; page-break-inside: avoid; }
.graf svg { width: 100%; display: block; }
.graf--curto svg { height: 14mm; }
.graf--medio svg { height: 24mm; }
.graf--longo svg { height: 30mm; }
.g-barra { fill: #c0121f; }
.g-barra-neg { fill: #c48a12; }
.g-vazio { fill: #d6d9de; }
.g-zero { stroke: #cfd2d8; stroke-width: .4; vector-effect: non-scaling-stroke; }
.graf-eixo { position: relative; height: 3.4mm; margin-top: .8mm; }
.graf-eixo span { position: absolute; transform: translateX(-50%); font-size: 6pt; color: #8a8f97; }
.graf-nota { font-size: 6.6pt; color: #8a8f97; margin: .6mm 0 0; }

/* ---------- tabelas ---------- */
table { width: 100%; border-collapse: collapse; font-size: 7.6pt; table-layout: fixed; }
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th {
  text-align: left; font-size: 6.2pt; font-weight: 750; letter-spacing: .3pt; text-transform: uppercase;
  color: #fff; background: #7d0f1c; padding: 1.3mm 1.6mm; border: 0;
}
td { padding: 1.15mm 1.6mm; border-bottom: .4pt solid #eceef1; vertical-align: top; overflow-wrap: break-word; }
th.n { text-align: right; white-space: normal; }
td.n { text-align: right; white-space: nowrap; }
tbody tr:nth-child(even) td { background: #fafbfc; }
.prov { color: #8a6208; font-size: 6.2pt; }
.hist-i { color: #8a8f97; font-size: 6.2pt; font-style: italic; }
.vazio { font-size: 8pt; color: #666b73; font-style: italic; padding: 2mm 0; }

/* Prévia na tela: as folhas A4 empilhadas, com a mesma medida da impressão. */
@media screen {
  body { background: #eceef1; padding: 8mm 0; }
  .pagina { margin: 0 auto 6mm; box-shadow: 0 2mm 8mm rgba(0,0,0,.12); background: #fff; }
  .pagina--capa { background: linear-gradient(160deg, #2a0609 0%, #4a0a10 46%, #7d0f1c 100%); }
  #fonte { display: none; }          /* some enquanto o paginador não roda */
}`;
}

// ---------------------------------------------------------------------------
// PAGINAÇÃO
// ---------------------------------------------------------------------------
//
// CAUSA RAIZ dos dois defeitos do PDF anterior:
//
//   1. `position: fixed` para cabeçalho/rodapé. Ao imprimir, o Chrome
//      posiciona `fixed` relativo à ÁREA DE CONTEÚDO (já dentro das margens
//      do `@page`), não à folha física. `top: 6mm` empurrava o cabeçalho
//      6mm PARA DENTRO do conteúdo — daí ele cobrir as tabelas.
//
//   2. `counter(page)` / `counter(pages)` só existem dentro dos margin boxes
//      do `@page` (`@top-center`…), que o Chrome não implementa. Fora deles
//      os contadores valem 0 — daí o "Página 0 de 0", inclusive na capa.
//
// A correção não é ajustar offsets: é PAGINAR de verdade. O documento passa a
// ser uma sequência de `.pagina` com altura A4 exata, cada uma com cabeçalho e
// rodapé NO FLUXO (altura reservada, impossível sobrepor) e o número real.
// Como a quebra deixa de ser decidida pelo motor de impressão, também somem a
// linha órfã, o título sozinho no pé da página e a última página quase vazia.

/** Altura útil (mm) do miolo de uma página, já descontados cabeçalho e rodapé. */
export const ALTURA_UTIL_MM = 297 - 14 - 14 - 8 - 7;   // margens + cabeçalho + rodapé

/**
 * Script embutido no documento: mede os blocos e os distribui em páginas.
 * Roda dentro do iframe/aba, antes de imprimir. Precisa ser string porque vive
 * num documento isolado — não compartilha módulo com o app.
 */
export const SCRIPT_PAGINADOR = `
(function () {
  var MM = 96 / 25.4;                                  // 1mm em px CSS
  var UTIL = ${ALTURA_UTIL_MM} * MM;

  function novaPagina(doc, num) {
    var p = doc.createElement("section");
    p.className = "pagina";
    p.innerHTML =
      '<header class="pg-cab"><span><b>Crescer com Delivery</b> · Painel Administrativo</span>' +
      '<span>' + doc.body.dataset.periodo + '</span></header>' +
      '<div class="pg-corpo"></div>' +
      '<footer class="pg-rod"><span>' + doc.body.dataset.rodape + '</span>' +
      '<span class="pg-n">Página ' + num + '</span></footer>';
    doc.querySelector(".doc").appendChild(p);
    return p.querySelector(".pg-corpo");
  }

  /** Clona uma tabela vazia, só com o <thead> — o contexto de cada página. */
  function moldeTabela(tab) {
    var t = tab.cloneNode(false);
    // o <colgroup> PRECISA vir junto: com table-layout:fixed e sem ele, todas
    // as colunas ficam iguais e o nome da empresa quebra em 4 linhas enquanto
    // a coluna de 1 dígito sobra espaço.
    var cg = tab.querySelector("colgroup");
    if (cg) t.appendChild(cg.cloneNode(true));
    var th = tab.querySelector("thead");
    if (th) t.appendChild(th.cloneNode(true));
    t.appendChild(tab.ownerDocument.createElement("tbody"));
    return t;
  }

  function paginar(doc) {
    var pre = doc.getElementById("pre");
    var capa = pre && pre.querySelector(".pagina--capa");
    if (capa) doc.querySelector(".doc").appendChild(capa);
    var fonte = doc.getElementById("fonte");
    if (!fonte) return 0;
    var blocos = Array.prototype.slice.call(fonte.children);
    var corpo = novaPagina(doc, 1);
    var num = 1;

    // .pg-corpo é flex-item esticado: getBoundingClientRect devolve SEMPRE a
    // altura cheia da página, então nada quebraria. O que importa é o conteúdo
    // (scrollHeight) contra o espaço real do miolo (clientHeight).
    function altura(el) { return el.scrollHeight; }
    function limite() { return corpo.clientHeight || UTIL; }
    function cabe() { return altura(corpo) <= limite(); }
    // scrollHeight de um flex-item esticado NUNCA fica abaixo do clientHeight,
    // entao ele so serve para detectar estouro. Para saber quanto ainda cabe e
    // preciso somar os filhos — sem isso sobra() dava 0 e toda secao comecava
    // numa pagina nova, desperdicando meia folha.
    function usado() {
      var h = 0, f = corpo.children;
      for (var i = 0; i < f.length; i++) h += f[i].getBoundingClientRect().height;
      return h;
    }
    function sobra() { return limite() - usado(); }
    function quebrar() { num++; corpo = novaPagina(doc, num); }

    for (var i = 0; i < blocos.length; i++) {
      var b = blocos[i];
      corpo.appendChild(b);

      if (cabe()) continue;                            // coube

      // Estourou. Se o bloco é uma tabela longa, divide por LINHA, repetindo
      // o <thead> na continuação — nunca deixa 1 linha sozinha.
      var tab = b.matches("table") ? b : b.querySelector(":scope > table");
      var linhas = tab ? Array.prototype.slice.call(tab.querySelectorAll("tbody > tr")) : [];

      if (tab && linhas.length > 4) {
        corpo.removeChild(b);
        var restantes = linhas.slice();
        var primeiro = true;

        while (restantes.length) {
          // Espaco minimo para ABRIR uma tabela: titulo + thead + algumas
          // linhas. Sem isso sobrava o caso do PDF anterior — cabecalho no pe
          // de uma pagina e 1-2 linhas soltas.
          if (!primeiro || sobra() < 48 * MM) quebrar();
          var hospede = primeiro ? b : b.cloneNode(false);
          if (!primeiro) {
            // continuação: só a tabela, o título já deu contexto
            var t = moldeTabela(tab);
            hospede.appendChild(t);
            var tit = b.querySelector(":scope > h2");
            if (tit) {
              var cont = doc.createElement("p");
              cont.className = "sec-cont";
              cont.textContent = tit.textContent + " — continuação";
              hospede.insertBefore(cont, t);
            }
          }
          corpo.appendChild(hospede);

          var destino = hospede.querySelector("tbody");
          var origem = hospede === b ? tab.querySelector("tbody") : destino;
          if (hospede === b) { destino = origem; while (destino.firstChild) destino.removeChild(destino.firstChild); }

          // enche até estourar, depois devolve a última linha
          while (restantes.length) {
            destino.appendChild(restantes.shift());
            if (!cabe()) {
              if (destino.children.length === 1) break;      // linha maior que a página
              restantes.unshift(destino.lastElementChild);
              destino.removeChild(destino.lastElementChild);
              break;
            }
          }
          // nunca deixar UMA linha órfã na próxima página
          if (restantes.length === 1 && destino.children.length > 2) {
            restantes.unshift(destino.lastElementChild);
            destino.removeChild(destino.lastElementChild);
          }
          primeiro = false;
        }
        continue;
      }

      // Seção com VÁRIOS cards de empresa: reparte por card (cada card
      // continua inteiro), repetindo o título como "— continuação".
      var cards = Array.prototype.slice.call(b.querySelectorAll(":scope > .emp"));
      if (cards.length > 1) {
        corpo.removeChild(b);
        var fila = cards.slice();
        var titulo = b.querySelector(":scope > h2");
        var rotulo = titulo ? titulo.textContent : "";
        var inicio = true;

        while (fila.length) {
          if (!inicio || sobra() < 48 * MM) quebrar();
          var host;
          if (inicio) {
            host = b;
            for (var k = 0; k < cards.length; k++) if (cards[k].parentNode === b) b.removeChild(cards[k]);
          } else {
            host = b.cloneNode(false);
            var cont2 = doc.createElement("p");
            cont2.className = "sec-cont";
            cont2.textContent = rotulo + " — continuação";
            host.appendChild(cont2);
          }
          corpo.appendChild(host);

          while (fila.length) {
            host.appendChild(fila[0]);
            if (!cabe()) {
              if (host.querySelectorAll(".emp").length === 1) { fila.shift(); break; }
              host.removeChild(fila[0]);
              break;
            }
            fila.shift();
          }
          inicio = false;
        }
        continue;
      }

      // Bloco atômico (card, KPIs, gráfico, tabela curta): vai inteiro para a
      // próxima página. Se ele sozinho não cabe, fica onde está — cortar é
      // melhor que sumir, e nenhum bloco real chega a esse tamanho.
      corpo.removeChild(b);
      if (altura(corpo) === 0) { corpo.appendChild(b); continue; }
      quebrar();
      corpo.appendChild(b);
    }

    fonte.remove();
    if (pre) pre.remove();
    return num;
  }

  function numerar(doc, total) {
    var ns = doc.querySelectorAll(".pg-n");
    for (var i = 0; i < ns.length; i++) {
      ns[i].textContent = "Página " + (i + 1) + " de " + total;
    }
  }

  function rodar() {
    var total = paginar(document);
    numerar(document, total);
    document.body.dataset.paginas = String(total);
    // so libera a impressao depois das imagens: a logo da capa sairia em
    // branco se o print disparasse antes do decode.
    var imgs = Array.prototype.slice.call(document.images);
    var faltam = imgs.filter(function (i) { return !i.complete; }).length;
    function fim() { document.body.classList.add("pronto"); }
    if (!faltam) return fim();
    imgs.forEach(function (i) {
      if (i.complete) return;
      var ok = function () { if (--faltam <= 0) fim(); };
      i.addEventListener("load", ok); i.addEventListener("error", ok);
    });
    setTimeout(fim, 3000);   // nunca travar por uma imagem que nao chega
  }

  if (document.readyState === "complete" || document.readyState === "interactive") rodar();
  else document.addEventListener("DOMContentLoaded", rodar);
})();
`;

// ---------------------------------------------------------------------------
// Geração
// ---------------------------------------------------------------------------

/**
 * Monta o documento completo (usado pela geração e pelos testes).
 * @param {object} dados @param {Record<string, boolean>} secoes
 */
export function documentoPdf(dados, secoes = secoesPadrao()) {
  const periodoLongo = fmtMesLongo(dados?.periodo);
  const geradoEm = dataHoraBR(dados?.geradoEm);
  const titulo = nomeArquivoPdf(dados?.periodo).replace(/\.pdf$/, "");
  const rodape = `Relatório gerado em ${geradoEm} · Uso interno — Crescer com Delivery`;

  // `#fonte` guarda os blocos soltos; o paginador os distribui em `.pagina`s
  // com cabeçalho, rodapé e número reais.
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>${escapeHtml(titulo)}</title>
<style>${cssRelatorioPdf()}</style>
</head><body data-periodo="${escapeHtml(periodoLongo)}" data-rodape="${escapeHtml(rodape)}">
<div class="doc"></div>
<div id="pre">${htmlRelatorioPdf(dados, secoes)}</div>
<script>${SCRIPT_PAGINADOR}<\/script>
</body></html>`;
}

/**
 * Abre o diálogo de impressão do navegador com o documento pronto, num iframe
 * isolado (o CSS do relatório não vaza para o app, e o app não vaza para ele).
 *
 * O título do documento vira o nome sugerido do arquivo em "Salvar como PDF".
 * @param {object} dados @param {Record<string, boolean>} secoes
 * @returns {Promise<void>}
 */
export function gerarPdf(dados, secoes = secoesPadrao()) {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(frame);

    const limpar = () => { frame.remove(); resolve(); };
    frame.onload = () => {
      const w = frame.contentWindow;
      // só imprime DEPOIS que o paginador montou as páginas — senão o Chrome
      // pagina o documento pela metade.
      const pronto = () => {
        try { w.focus(); w.print(); } catch { /* diálogo pode ser bloqueado */ }
        setTimeout(limpar, 1000);
      };
      const esperar = (tentativas = 60) => {
        if (w.document?.body?.classList.contains("pronto") || tentativas <= 0) pronto();
        else setTimeout(() => esperar(tentativas - 1), 50);
      };
      esperar();
    };
    frame.srcdoc = documentoPdf(dados, secoes);
  });
}

/** Abre o documento numa aba nova, para conferir antes de imprimir. */
export function previewPdf(dados, secoes = secoesPadrao()) {
  const aba = window.open("", "_blank");
  if (!aba) return false;
  aba.document.write(documentoPdf(dados, secoes));
  aba.document.close();
  return true;
}
