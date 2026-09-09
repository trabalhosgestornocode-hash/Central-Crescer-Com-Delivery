// DESIGN SYSTEM do PAINEL ADMINISTRATIVO — "central de acompanhamento".
//
// Separado do adminUi.js (Painel SuperAdmin, técnico) de propósito: este é um
// ambiente GERENCIAL premium, com a identidade da Crescer com Delivery
// (vermelho da marca + grafite/vinho profundo), não um dashboard genérico.
//
// Três tons de status no painel inteiro — crítico / atenção / positivo — e
// NADA além disso. `null` do backend nunca vira número: vira "—" com a
// explicação do porquê ao lado.
//
// Todo texto vindo do servidor passa por `escapeHtml` (as views montam HTML
// por template string).

import { escapeHtml, normalizarBusca } from "./utils.js";
import { icon } from "./icons.js";

// ---------------------------------------------------------------------------
// Formatação — "não sei" (null) nunca vira número
// ---------------------------------------------------------------------------

/** Fração 0..1 → "94%". `null`/inválido → "—". */
export function fmtPct(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

/** Conformidade que pode não ter denominador — distingue "sem base" de 0%. */
export function fmtConformidade(taxa, { semBase = "Sem unidades elegíveis" } = {}) {
  if (taxa === null || taxa === undefined || taxa === "") return { texto: "—", nota: semBase, vazio: true, fracao: null };
  const n = Number(taxa);
  return { texto: fmtPct(n), nota: "", vazio: false, fracao: Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null };
}

export function fmtNum(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("pt-BR") : "—";
}

/** "2026-09-14" → "14/09/2026". */
export function fmtData(iso) {
  if (!iso || typeof iso !== "string") return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** "2026-09-14" → "14/09" (compacto para listas). */
export function fmtDataCurta(iso) {
  if (!iso || typeof iso !== "string") return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}` : iso;
}

export const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

/** "2026-09" → "Setembro 2026". */
export function fmtMesLongo(mesIso) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(mesIso ?? ""));
  if (!m) return String(mesIso ?? "—");
  return `${MESES[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** Nº de dias pendentes → "3 dias" / "1 dia" / "" quando 0. */
export function fmtDiasPendentes(n) {
  const q = Number(n) || 0;
  if (q <= 0) return "";
  return `${q} dia${q > 1 ? "s" : ""}`;
}

// ---------------------------------------------------------------------------
// Dicionários de status — 3 tons só: crítico / atenção / positivo
// ---------------------------------------------------------------------------

/** rollup.status → { classe, rotulo }. */
export const CRITICIDADE = {
  critico: { classe: "critico", rotulo: "Crítico" },
  atencao: { classe: "atencao", rotulo: "Atenção" },
  em_dia: { classe: "ok", rotulo: "Em dia" },
};

/** d1.categoria (STATUS_DIA projetado) → { classe, rotulo, icone, ajuda }. */
export const CATEGORIA_D1 = {
  sequencia_bloqueada: { classe: "critico", rotulo: "Sequência travada", icone: "ban" },
  nao_realizado: { classe: "atencao", rotulo: "Não iniciado", icone: "alert-triangle" },
  em_preenchimento: { classe: "atencao", rotulo: "Em aberto", icone: "clock" },
  concluido: { classe: "ok", rotulo: "Concluído", icone: "check-circle" },
  nao_aplicavel: { classe: "muted", rotulo: "Não aplicável", icone: "minus-circle" },
};

/**
 * Frase operacional do status: o que o gestor precisa ENTENDER, nao o nome
 * técnico do enum. Explica o grupo na "Ação necessária".
 */
export const EXPLICACAO_D1 = {
  sequencia_bloqueada: "Há dia(s) sem lançamento travando os seguintes.",
  nao_realizado: "O fechamento de ontem não foi iniciado.",
  em_preenchimento: "O financeiro de ontem ainda está em aberto.",
  concluido: "O fechamento de ontem foi concluído.",
  nao_aplicavel: "Sem obrigação neste dia.",
};

/** Ordem fixa dos grupos da "Ação Necessária Hoje" (nunca por percentual). */
export const ORDEM_ACAO = ["sequencia_bloqueada", "nao_realizado", "em_preenchimento", "concluido"];

/** projetarDia → estado visual da célula do calendário. */
export function estadoDiaCalendario(dia) {
  if (!dia) return { classe: "vazio", rotulo: "—" };
  if (dia.painel === "NAO_APLICAVEL") {
    const motivo = dia.motivoNaoAplicavel;
    if (motivo === "futuro") return { classe: "futuro", rotulo: "Ainda não venceu" };
    if (motivo === "hoje") return { classe: "hoje", rotulo: "Hoje — vence amanhã" };
    return { classe: "na", rotulo: "Não aplicável" };
  }
  if (dia.painel === "COMPLETO") {
    // Um dia que só fechou porque alguém liberou merece nome próprio — é o
    // "Regularizado" da linha do tempo, não um concluído qualquer.
    return dia.situacaoDesbloqueio === "regularizado"
      ? { classe: "regularizado", rotulo: "Regularizado após liberação" }
      : { classe: "concluido", rotulo: "Concluído" };
  }
  if (dia.painel === "INCOMPLETO") return { classe: "em-preenchimento", rotulo: "Em preenchimento" };
  // Liberado e AINDA vazio: continua sendo pendência (nunca vira "ok"), mas a
  // cor conta a história certa — a porta está aberta e ninguém entrou.
  if (dia.situacaoDesbloqueio === "aguardando_lancamento") {
    return { classe: "liberado", rotulo: "Liberado administrativamente — aguardando lançamento" };
  }
  if (dia.bloqueada) return { classe: "bloqueado", rotulo: "Bloqueado pela sequência" };
  return { classe: "nao-realizado", rotulo: "Não realizado" };
}

/** Rótulos amigáveis da coluna "Financeiro" na lista de dias (item 1 e 11). */
export function rotuloFinanceiroDia(dia) {
  if (!dia) return "—";
  if (dia.painel === "NAO_APLICAVEL") {
    return dia.motivoNaoAplicavel === "hoje" ? "Vence amanhã" : "—";
  }
  if (dia.painel === "COMPLETO") {
    return dia.situacaoDesbloqueio === "regularizado" ? "Regularizado" : "Lançado";
  }
  if (dia.painel === "INCOMPLETO") return "Em preenchimento";
  if (dia.situacaoDesbloqueio === "aguardando_lancamento") return "Aguardando lançamento";
  if (dia.bloqueada) return "Bloqueado pela sequência";
  return "Bloqueado";
}

// ---------------------------------------------------------------------------
// Átomos
// ---------------------------------------------------------------------------

/** @param {{classe: string, rotulo: string, icone?: string}} m */
export function chip(m, { comIcone = false } = {}) {
  const meta = m ?? { classe: "muted", rotulo: "—" };
  return `<span class="padm-chip padm-chip--${meta.classe}">${
    comIcone && meta.icone ? icon(meta.icone, { size: 12 }) : ""
  }${escapeHtml(meta.rotulo)}</span>`;
}

export const chipCriticidade = (status) => chip(CRITICIDADE[status] ?? { classe: "muted", rotulo: status ?? "—" });
export const chipCategoria = (cat, opts) => chip(CATEGORIA_D1[cat] ?? { classe: "muted", rotulo: cat ?? "—" }, opts);

/** Métrica em linha: "12 unidades" com o número em destaque. */
export const metrica = (valor, rotulo, tom = "") =>
  `<span class="padm-metrica ${tom ? `padm-metrica--${tom}` : ""}"><i>${escapeHtml(String(valor))}</i>${escapeHtml(rotulo)}</span>`;

/**
 * Barra de saúde: proporção crítico / atenção / em dia numa faixa só.
 * Lê-se de relance qual empresa está pior — sem gráfico decorativo.
 */
export function barraSaude({ criticas = 0, atencao = 0, emDia = 0 }) {
  const total = (criticas || 0) + (atencao || 0) + (emDia || 0);
  if (!total) return `<span class="padm-saude padm-saude--vazia" aria-hidden="true"></span>`;
  const p = (n) => `${((n / total) * 100).toFixed(2)}%`;
  return `<span class="padm-saude" role="img" aria-label="${criticas} críticas, ${atencao} em atenção, ${emDia} em dia">
    ${criticas ? `<i class="padm-saude--critico" style="width:${p(criticas)}"></i>` : ""}
    ${atencao ? `<i class="padm-saude--atencao" style="width:${p(atencao)}"></i>` : ""}
    ${emDia ? `<i class="padm-saude--ok" style="width:${p(emDia)}"></i>` : ""}
  </span>`;
}

// ---------------------------------------------------------------------------
// Cartão de indicador
// ---------------------------------------------------------------------------

/**
 * KPI premium. `tom` ∈ "", "critico", "atencao", "ok". `progresso` (0..1)
 * desenha a barra sutil sob o número. `nota` explica o dado (ou por que é "—").
 * `destaque` engrossa o cartão — usado quando o número exige ação.
 * @param {{label: string, valor: string, nota?: string, tom?: string, icone?: string, progresso?: number|null, destaque?: boolean, acao?: string}} o
 */
export function card({ label, valor, nota = "", tom = "", icone = "", progresso = null, destaque = false, acao = "" }) {
  const classes = ["padm-card", tom ? `padm-card--${tom}` : "", destaque ? "padm-card--destaque" : ""].filter(Boolean).join(" ");
  const tag = acao ? "button" : "div";
  const attrs = acao
    ? ` type="button" data-padm-card="${escapeHtml(acao)}" aria-controls="padm-card-detalhe-${escapeHtml(acao)}" aria-expanded="false"`
    : "";
  return `
    <${tag} class="${classes}${acao ? " padm-card--interativo" : ""}"${attrs}>
      <span class="padm-card-top">
        <span class="padm-card-label">${escapeHtml(label)}</span>
        ${icone ? `<span class="padm-card-ic">${icon(icone, { size: 15 })}</span>` : ""}
      </span>
      <span class="padm-card-valor">${escapeHtml(String(valor))}</span>
      ${progresso !== null && progresso !== undefined
        ? `<span class="padm-card-barra"><i style="width:${(Math.max(0, Math.min(1, progresso)) * 100).toFixed(1)}%"></i></span>`
        : ""}
      ${nota ? `<span class="padm-card-nota">${escapeHtml(nota)}</span>` : ""}
      ${acao ? `<span class="padm-card-cta">Ver lista <span aria-hidden="true">↓</span></span>` : ""}
    </${tag}>`;
}

export const cards = (html) => `<div class="padm-cards">${html}</div>`;

/** @param {{titulo: string, acoes?: string, corpo: string, sub?: string, icone?: string}} o */
export function secao({ titulo, acoes = "", corpo, sub = "", icone = "" }) {
  return `
    <section class="padm-secao">
      <header class="padm-secao-head">
        <div class="padm-secao-tit">
          ${icone ? `<span class="padm-secao-ic">${icon(icone, { size: 16 })}</span>` : ""}
          <div>
            <h2>${escapeHtml(titulo)}</h2>
            ${sub ? `<p class="padm-secao-sub">${escapeHtml(sub)}</p>` : ""}
          </div>
        </div>
        ${acoes ? `<div class="padm-secao-acoes">${acoes}</div>` : ""}
      </header>
      ${corpo}
    </section>`;
}

// ---------------------------------------------------------------------------
// Estados: loading (skeleton) / vazio / erro
// ---------------------------------------------------------------------------

/**
 * Esqueleto de carregamento — a silhueta da tela que vai chegar, não um
 * spinner genérico. `forma` escolhe o molde.
 * @param {"painel"|"lista"|"calendario"} forma
 */
export function carregando(forma = "painel") {
  const bloco = (c) => `<span class="padm-sk ${c}"></span>`;
  if (forma === "calendario") {
    return `<div class="padm-carregando" aria-busy="true" aria-label="Carregando">
      ${bloco("padm-sk--titulo")}
      <div class="padm-sk-cal">${Array.from({ length: 35 }, () => bloco("padm-sk--dia")).join("")}</div>
    </div>`;
  }
  if (forma === "lista") {
    return `<div class="padm-carregando" aria-busy="true" aria-label="Carregando">
      ${bloco("padm-sk--titulo")}
      <div class="padm-sk-lista">${Array.from({ length: 5 }, () => bloco("padm-sk--linha")).join("")}</div>
    </div>`;
  }
  return `<div class="padm-carregando" aria-busy="true" aria-label="Carregando">
    <div class="padm-sk-cards">${Array.from({ length: 6 }, () => bloco("padm-sk--card")).join("")}</div>
    ${bloco("padm-sk--titulo")}
    <div class="padm-sk-lista">${Array.from({ length: 4 }, () => bloco("padm-sk--linha")).join("")}</div>
  </div>`;
}

/**
 * Erro de carga. O 403 é tratado ANTES (volta para a seleção de ambiente), então
 * aqui só chega falha de rede ou do servidor — e as duas dizem coisas
 * diferentes ao operador.
 * @param {Error|string} e
 */
export function erro(e) {
  const msg = typeof e === "string" ? e : (e?.message || "Erro desconhecido.");
  const rede = /failed to fetch|networkerror|load failed|ECONN|fetch/i.test(msg);
  return `
    <div class="padm-estado padm-estado--erro">
      <span class="padm-estado-ic">${icon("alert-triangle", { size: 22 })}</span>
      <h3>${escapeHtml(rede ? "Sem conexão com o servidor" : "Não foi possível carregar")}</h3>
      <p>${escapeHtml(rede
        ? "O painel não conseguiu falar com a API. Verifique a rede e tente de novo."
        : msg)}</p>
      <button class="btn btn-primary btn-sm" data-padm-acao="recarregar">Tentar de novo</button>
    </div>`;
}

/** Estado vazio positivo (nada pendente) ou neutro (sem dados no período). */
export function vazio(titulo, texto = "", { tom = "ok", icone = "check-circle" } = {}) {
  return `<div class="padm-estado padm-estado--${tom}">
     <span class="padm-estado-ic">${icon(icone, { size: 22 })}</span>
     <h3>${escapeHtml(titulo)}</h3>${texto ? `<p>${escapeHtml(texto)}</p>` : ""}
   </div>`;
}

/**
 * Nota discreta de pendência HERDADA — a parte que começou antes do período
 * analisado. Aparece como texto secundário, NUNCA somada à métrica do mês:
 * olhando setembro, "6 dias desde 26/08" seria mentira sobre setembro.
 * @param {{desde?: string|null, total?: number}|null|boolean} herdada
 * @param {string|null} [desdeIso] quando `herdada` é booleano
 */
export function notaHerdada(herdada, desdeIso = null) {
  const desde = typeof herdada === "object" && herdada ? herdada.desde : desdeIso;
  const ativo = typeof herdada === "object" ? !!herdada : !!herdada;
  if (!ativo) return "";
  // "vem de", não "desde": "desde DD/MM" é o vocabulário da MÉTRICA do período.
  // Usar a mesma palavra nas duas faria a nota parecer a contagem do mês.
  return `<span class="padm-herdada" title="A sequência já vinha travada antes deste período — os dias anteriores não entram na contagem do mês.">
    ${icon("clock", { size: 11 })}pendência anterior ao período${desde ? ` · vem de ${escapeHtml(fmtDataCurta(desde))}` : ""}
  </span>`;
}

/** Campo de busca com ícone. */
export const busca = (id, ph = "Buscar empresa ou unidade…", valor = "") =>
  `<label class="padm-busca">
     <span class="padm-busca-ic">${icon("eye", { size: 15 })}</span>
     <input type="search" id="${id}" placeholder="${escapeHtml(ph)}" value="${escapeHtml(valor ?? "")}" autocomplete="off" />
   </label>`;

/** Frase curta por unidade, para a linha da lista. */
export function fraseStatus(cat, { dias = 0, desde = null } = {}) {
  const base = {
    sequencia_bloqueada: "Sequência travada",
    nao_realizado: "Fechamento de ontem não iniciado",
    em_preenchimento: "Financeiro de ontem em aberto",
    concluido: "Em dia",
  }[cat] ?? "—";
  const q = Number(dias) || 0;
  if (q > 0) return `${base} · ${q} dia${q > 1 ? "s" : ""} no período`;
  if (desde) return `${base} · desde ${fmtDataCurta(desde)}`;
  return base;
}

// ---------------------------------------------------------------------------
// Identificação de pendência — empresa e unidade
// ---------------------------------------------------------------------------

/**
 * Escapa e, havendo termo de busca, destaca as ocorrências com <mark>.
 * O gestor digita "Mogi" e vê onde bateu — em empresa E em unidade.
 * @param {string} texto @param {string} termo já normalizado (normalizarBusca)
 */
export function realce(texto, termo) {
  const t = String(texto ?? "—");
  if (!termo) return escapeHtml(t);
  const i = normalizarBusca(t).indexOf(termo);
  if (i < 0) return escapeHtml(t);
  // `normalizarBusca` preserva o comprimento (só remove acento e caixa), então
  // os índices do texto normalizado valem para o original.
  return escapeHtml(t.slice(0, i))
    + `<mark class="padm-mark">${escapeHtml(t.slice(i, i + termo.length))}</mark>`
    + escapeHtml(t.slice(i + termo.length));
}

/** Selo com a contagem de unidades pendentes de uma empresa. */
export function seloPendencia(e = {}) {
  const unidadesPendentes = qtdPendentes(e);
  const criticas = e.criticas ?? 0;
  if (!unidadesPendentes) {
    return `<span class="padm-selo padm-selo--ok">${icon("check-circle", { size: 12 })}Sem pendência</span>`;
  }
  const tom = criticas > 0 ? "critico" : "atencao";
  const ic = criticas > 0 ? "alert-triangle" : "clock";
  const plural = unidadesPendentes > 1 ? "s" : "";
  return `<span class="padm-selo padm-selo--${tom}">${icon(ic, { size: 12 })}${unidadesPendentes} unidade${plural} pendente${plural}</span>`;
}

/** Severidade -> vocabulário do gestor. */
export const SEVERIDADE = {
  0: { classe: "critico", rotulo: "Crítica" },
  1: { classe: "atencao", rotulo: "Atenção" },
  2: { classe: "ok", rotulo: "Saudável" },
};
export const severidadeDe = (e) => ((e?.criticas ?? 0) > 0 ? 0 : (e?.atencao ?? 0) > 0 ? 1 : 2);

/**
 * Quantas unidades da empresa estão pendentes. O backend manda pronto em
 * `unidadesPendentes`; o fallback (críticas + atenção) mantém a tela correta
 * se a resposta vier de uma versão anterior do contrato.
 */
export const qtdPendentes = (e) =>
  e?.unidadesPendentes ?? (e?.pendentes?.length ?? ((e?.criticas ?? 0) + (e?.atencao ?? 0)));

/** Linha compacta de uma unidade pendente dentro do bloco da empresa. */
export function linhaUnidadePendente(u, termo = "") {
  const cat = CATEGORIA_D1[u.d1Status] ?? { classe: "muted", rotulo: u.d1Status ?? "—" };
  const dias = fmtDiasPendentes(u.diasPendentes);
  const quando = dias || (u.pendenciaMaisAntiga ? `desde ${fmtDataCurta(u.pendenciaMaisAntiga)}` : "");
  return `
    <li class="padm-uni" data-padm-nav="unidade" data-id="${escapeHtml(u.unidadeId ?? "")}" data-nome="${escapeHtml(u.unidadeNome ?? "")}" tabindex="0" role="button">
      <span class="padm-uni-bolha padm-uni-bolha--${cat.classe}" aria-hidden="true"></span>
      <span class="padm-uni-nome">${realce(u.unidadeNome, termo)}</span>
      <span class="padm-uni-status">${escapeHtml(cat.rotulo)}</span>
      ${quando ? `<span class="padm-uni-dias">${escapeHtml(quando)}</span>` : ""}
      ${u.pendenciaHerdada ? `<span class="padm-uni-heranca" title="A sequência já vinha travada antes deste período.">vem de ${escapeHtml(fmtDataCurta(u.pendenciaHerdadaDesde))}</span>` : ""}
      <span class="padm-uni-ir" aria-hidden="true">›</span>
    </li>`;
}

/**
 * Bloco de uma empresa: cabeçalho com severidade + mini-resumo executivo + as
 * unidades pendentes já reveladas. Usa `<details>` nativo — expandir/recolher
 * sem JS de estado, e o conteúdo continua no DOM (a busca acha dentro dele).
 * Empresas com problema nascem ABERTAS: o painel não esconde pendência.
 */
/**
 * Nota de HISTÓRICO ANTERIOR ao período — contexto, nunca status.
 * Cinza/neutra de propósito: uma empresa com setembro 100%% e uma pendência de
 * agosto está SAUDÁVEL em setembro. A nota diz onde procurar, sem pintar o
 * card de vermelho.
 * @param {{existe?: boolean, desde?: string|null, unidades?: number}} h
 */
export function notaHistoricoEmpresa(h) {
  if (!h?.existe) return "";
  const n = h.unidades ?? 0;
  return `<span class="padm-hist-nota" title="Pendência anterior ao período analisado. Não afeta a saúde deste mês — troque o período para tratá-la.">
    ${icon("archive", { size: 11 })}Há histórico anterior ao período${h.desde ? ` · desde ${escapeHtml(fmtDataCurta(h.desde))}` : ""}${n > 1 ? ` (${n} unidades)` : ""}
  </span>`;
}

export function blocoEmpresa(e, { termo = "", aberto = null } = {}) {
  const sev = SEVERIDADE[severidadeDe(e)];
  const pendentes = e.pendentes ?? [];
  const confD1 = fmtConformidade(e.conformidadeD1, { semBase: "—" });
  const confMes = fmtConformidade(e.conformidadeMes, { semBase: "—" });
  const d1Txt = e.d1Ok === null || e.d1Ok === undefined ? "—" : e.d1Ok ? "Sim" : "Não";
  const abrir = aberto === null ? qtdPendentes(e) > 0 : aberto;

  const resumo = [
    ["Unidades", fmtNum(e.unidadesMonitoradas), ""],
    ["Pendentes", fmtNum(qtdPendentes(e)), qtdPendentes(e) > 0 ? ((e.criticas ?? 0) > 0 ? "critico" : "atencao") : ""],
    ["Críticas", fmtNum(e.criticas), (e.criticas ?? 0) > 0 ? "critico" : ""],
    ["Atenção", fmtNum(e.atencao), (e.atencao ?? 0) > 0 ? "atencao" : ""],
    ["D-1 fechado", d1Txt, e.d1Ok === false ? "atencao" : e.d1Ok ? "ok" : ""],
    ["Conf. D-1", confD1.texto, ""],
    ["Conf. mês", confMes.texto, ""],
  ].map(([r, v, tom]) => `<span class="padm-emp-m ${tom ? `padm-emp-m--${tom}` : ""}"><small>${escapeHtml(r)}</small><b>${v}</b></span>`).join("");

  const pior = e.piorUnidade
    ? `<span class="padm-emp-pior" title="Unidade que deve ser tratada primeiro">${icon("target", { size: 12 })}Prioridade: <b>${realce(e.piorUnidade.unidadeNome, termo)}</b></span>`
    : "";

  const corpo = pendentes.length
    ? `<ul class="padm-uni-lista">${pendentes.map((u) => linhaUnidadePendente(u, termo)).join("")}</ul>`
    : `<p class="padm-emp-limpa">${icon("check-circle", { size: 13 })}Todas as unidades em dia neste período.</p>`;

  const alvoBusca = normalizarBusca([e.empresaNome, ...pendentes.map((u) => u.unidadeNome)].join(" "));

  return `
    <details class="padm-emp padm-emp--${sev.classe}" ${abrir ? "open" : ""} data-sev="${severidadeDe(e)}"
             data-pendentes="${pendentes.length}" data-busca="${escapeHtml(alvoBusca)}">
      <summary class="padm-emp-head">
        <span class="padm-emp-seta" aria-hidden="true">›</span>
        <span class="padm-emp-ident">
          <b class="padm-emp-nome">${realce(e.empresaNome, termo)}</b>
          ${pior}
          ${notaHistoricoEmpresa(e.historicoAnterior)}
        </span>
        <span class="padm-emp-selos">
          ${seloPendencia(e)}
          <span class="padm-chip padm-chip--${sev.classe}">${escapeHtml(sev.rotulo)}</span>
        </span>
      </summary>
      <div class="padm-emp-corpo">
        <div class="padm-emp-resumo">${resumo}</div>
        ${barraSaude(e)}
        <div class="padm-emp-unis">
          <span class="padm-emp-unis-tit">${pendentes.length ? `Unidades com pendência (${pendentes.length})` : "Unidades"}</span>
          ${corpo}
        </div>
        <button class="padm-emp-abrir" data-padm-nav="empresa" data-id="${escapeHtml(e.organizacaoId ?? "")}" data-nome="${escapeHtml(e.empresaNome ?? "")}">Abrir detalhe da empresa ›</button>
      </div>
    </details>`;
}

/** Segmentos de filtro por severidade (mesma linguagem em Empresas e Pendências). */
export function filtroSeveridade(valor, contagens = {}) {
  const opcoes = [
    ["todas", "Todas"], ["pendencia", "Com pendência"],
    ["criticas", "Críticas"], ["atencao", "Atenção"], ["saudaveis", "Saudáveis"],
  ];
  return `<div class="padm-segm" role="tablist">${opcoes.map(([v, r]) => `
    <button class="padm-segm-btn ${v === valor ? "ativo" : ""}" data-padm-filtro="${v}" role="tab" aria-selected="${v === valor}">
      ${escapeHtml(r)}${contagens[v] === undefined ? "" : `<span class="padm-segm-n">${contagens[v]}</span>`}
    </button>`).join("")}</div>`;
}

/** Aplica o filtro de severidade a uma lista de empresas consolidadas. */
export function filtrarEmpresas(empresas, filtro) {
  const lista = empresas ?? [];
  if (filtro === "pendencia") return lista.filter((e) => qtdPendentes(e) > 0);
  if (filtro === "criticas") return lista.filter((e) => (e.criticas ?? 0) > 0);
  if (filtro === "atencao") return lista.filter((e) => (e.criticas ?? 0) === 0 && (e.atencao ?? 0) > 0);
  if (filtro === "saudaveis") return lista.filter((e) => qtdPendentes(e) === 0);
  return lista;
}

/** Contagens para os selos dos segmentos. */
export function contagensEmpresas(empresas) {
  const l = empresas ?? [];
  return {
    todas: l.length,
    pendencia: filtrarEmpresas(l, "pendencia").length,
    criticas: filtrarEmpresas(l, "criticas").length,
    atencao: filtrarEmpresas(l, "atencao").length,
    saudaveis: filtrarEmpresas(l, "saudaveis").length,
  };
}

// ---------------------------------------------------------------------------
// FINANCEIRO — dinheiro, cobertura e a sinalização do provisório
// ---------------------------------------------------------------------------

// FORMATADOR MONETÁRIO ÚNICO da área Relatórios: sempre 2 casas decimais,
// padrão pt-BR. `null`/vazio -> "—" (nunca "R$ 0,00" artificial); 0 real -> "R$ 0,00".
const BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/** R$ com 2 casas decimais (pt-BR). `null`/vazio/NaN -> "—", nunca "R$ 0,00" artificial. */
export function fmtDinheiro(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? BRL.format(n) : "—";
}

/** R$ 4.287.430 -> "R$ 4,3 mi" / "R$ 412,4 mil" — cartões estreitos da Visão Geral. */
export function fmtDinheiroCurto(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e6) return `R$ ${(n / 1e6).toFixed(1).replace(".", ",")} mi`;
  if (abs >= 1e3) return `R$ ${(n / 1e3).toFixed(1).replace(".", ",")} mil`;
  return BRL.format(n);
}

/** Variação 0.073 -> "+7,3%". `null` -> "". */
export function fmtVariacao(v) {
  if (v === null || v === undefined) return "";
  const n = Number(v) * 100;
  if (!Number.isFinite(n)) return "";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1).replace(".", ",")}%`;
}

/** Variação em pontos percentuais: 0.04 -> "+4 p.p.". */
export function fmtVariacaoPP(v) {
  if (v === null || v === undefined) return "";
  const n = Number(v) * 100;
  if (!Number.isFinite(n)) return "";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1).replace(".", ",")} p.p.`;
}

/** Seta + tom da variação. `null` = sem comparação possível. */
export function tomVariacao(v, { maiorEhMelhor = true } = {}) {
  if (v === null || v === undefined || Number(v) === 0) return { classe: "neutro", seta: "" };
  const positivo = Number(v) > 0;
  const bom = maiorEhMelhor ? positivo : !positivo;
  return { classe: bom ? "ok" : "critico", seta: positivo ? "↑" : "↓" };
}

/**
 * Selo do valor PROVISÓRIO. O gestor aprovou incluir rascunho no faturamento,
 * desde que não pareça confirmado — este é o "desde que". Discreto (âmbar,
 * não vermelho: rascunho é estado operacional normal, não erro).
 * @param {{provisorio?: number, incluiProvisorio?: boolean}} f
 */
export function seloProvisorio(f) {
  if (!f?.incluiProvisorio || !(f.provisorio > 0)) return "";
  return `<span class="padm-provisorio" title="Inclui lançamentos ainda em rascunho. O valor existe, mas pode mudar até ser finalizado.">
    ${icon("clock", { size: 11 })}${escapeHtml(fmtDinheiro(f.provisorio))} não finalizados
  </span>`;
}

/** Forma compacta para tabela densa: "28/30 · 93%". */
export function textoCoberturaCurto(c) {
  if (!c || !c.esperados) return "";
  return c.taxa == null ? `${c.completos}/${c.esperados}` : `${c.completos}/${c.esperados} · ${Math.round(c.taxa * 100)}%`;
}

/** Cobertura "28/30 dias · 93%" — mostra se o faturamento está completo. */
export function textoCobertura(c) {
  if (!c || !c.esperados) return "";
  const pct = c.taxa == null ? "" : ` · ${Math.round(c.taxa * 100)}%`;
  return `${c.completos}/${c.esperados} dias${pct}`;
}

/**
 * Linha de um ranking. `medalha` nas 3 primeiras posições (numérica, sem
 * emoji — a estética do painel é sóbria).
 * @param {object} item @param {{tipo?: "faturamento"|"conformidade", termo?: string}} opts
 */
export function linhaRanking(item, { tipo = "faturamento", termo = "" } = {}) {
  const pos = item.posicao;
  const destaque = pos <= 3 ? ` padm-rank-pos--${pos}` : "";
  const nav = item.empresaNome
    ? `data-padm-nav="unidade" data-id="${escapeHtml(item.id ?? "")}" data-nome="${escapeHtml(item.nome ?? "")}"`
    : `data-padm-nav="empresa" data-id="${escapeHtml(item.id ?? "")}" data-nome="${escapeHtml(item.nome ?? "")}"`;

  const principal = tipo === "conformidade"
    ? fmtPct(item.conformidadeMes)
    : fmtDinheiro(item.faturamento?.total);
  const secundario = tipo === "conformidade"
    ? (item.faturamento?.total != null ? fmtDinheiro(item.faturamento.total) : "")
    : (item.conformidadeMes != null ? `${fmtPct(item.conformidadeMes)} conformidade` : "");

  return `
    <li class="padm-rank" ${nav} tabindex="0" role="button">
      <span class="padm-rank-pos${destaque}">${String(pos).padStart(2, "0")}</span>
      <span class="padm-rank-id">
        <b>${realce(item.nome, termo)}</b>
        ${item.empresaNome ? `<small>${realce(item.empresaNome, termo)}</small>` : ""}
        ${seloProvisorio(item.faturamento)}
      </span>
      <span class="padm-rank-val">
        <b>${escapeHtml(principal)}</b>
        ${secundario ? `<small>${escapeHtml(secundario)}</small>` : ""}
        ${textoCobertura(item.cobertura) ? `<small class="padm-rank-cob">${escapeHtml(textoCobertura(item.cobertura))}</small>` : ""}
      </span>
      <span class="padm-item-ir" aria-hidden="true">›</span>
    </li>`;
}

/**
 * Sparkline de barras em SVG puro — sem biblioteca. Dia sem dado vira um
 * traço vazio, nunca uma barra interpolada.
 * @param {Array<{data: string, valor: number|null}>} serie
 */
export function barrasEvolucao(serie) {
  const pontos = serie ?? [];
  if (!pontos.length) return vazio("Sem série no período", "", { tom: "muted", icone: "bar-chart" });
  const valores = pontos.map((p) => (p.valor == null ? null : Number(p.valor)));
  const max = Math.max(...valores.filter((v) => v != null), 1);
  const L = 100 / pontos.length;

  const barras = pontos.map((p, i) => {
    const v = valores[i];
    const alt = v == null ? 0 : Math.max((v / max) * 100, v > 0 ? 2 : 0);
    const dia = p.data.slice(8, 10);
    if (v == null) {
      return `<g><rect x="${(i * L).toFixed(3)}%" y="98" width="${(L * 0.62).toFixed(3)}%" height="2" class="padm-barra padm-barra--vazia"><title>${escapeHtml(fmtData(p.data))} · sem lançamento</title></rect></g>`;
    }
    return `<g><rect x="${(i * L).toFixed(3)}%" y="${(100 - alt).toFixed(3)}" width="${(L * 0.62).toFixed(3)}%" height="${alt.toFixed(3)}" rx="1" class="padm-barra"><title>${escapeHtml(fmtData(p.data))} · ${escapeHtml(fmtDinheiro(v))}</title></rect></g>`;
  }).join("");

  const rotulos = pontos.map((p, i) => (i % 5 === 0 || i === pontos.length - 1
    ? `<span style="left:${(i * L + L / 2).toFixed(3)}%">${p.data.slice(8, 10)}</span>` : "")).join("");

  return `
    <div class="padm-grafico">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Evolução diária do faturamento">${barras}</svg>
      <div class="padm-grafico-eixo">${rotulos}</div>
    </div>`;
}
