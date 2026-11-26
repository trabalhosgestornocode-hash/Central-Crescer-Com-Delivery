// NÚCLEO MENTORADOS — construtores PUROS de HTML (sem DOM, sem rede): listagem, perfil (5 abas), slides da
// apresentação e gráficos SVG. Tudo o que é número já vem calculado pelo backend (centavos / % com 4 casas);
// aqui só se formata. Ausência de dado aparece como "não informado", nunca como 0.

import { escapeHtml as esc } from "./utils.js";
import { icon } from "./icons.js";

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const NUM = new Intl.NumberFormat("pt-BR");
const NA = '<span class="nm-na">não informado</span>';
const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MESES_LONGOS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export const reais = (c) => (c == null ? null : BRL.format(c / 100));
export function reaisCompacto(c) {
  if (c == null) return null;
  const v = c / 100, a = Math.abs(v);
  if (a >= 1e6) return `R$ ${(v / 1e6).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mi`;
  if (a >= 1e3) return `R$ ${(v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
  return BRL.format(v);
}
export const pct = (v, casas = 2) => (v == null ? null : `${v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`);
export const pctSinal = (v, casas = 2) => (v == null ? null : `${v > 0 ? "+" : v < 0 ? "−" : ""}${pct(Math.abs(v), casas)}`);
export const pp = (v, casas = 2) => (v == null ? null : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })} p.p.`);
export const num = (v) => (v == null ? null : NUM.format(v));
export const mesCurto = (ym) => { if (!ym) return "—"; const [a, m] = ym.slice(0, 7).split("-"); return `${MESES_CURTOS[Number(m) - 1]}/${a.slice(2)}`; };
export const mesLongo = (ym) => { if (!ym) return "—"; const [a, m] = ym.slice(0, 7).split("-"); return `${MESES_LONGOS[Number(m) - 1]} de ${a}`; };
export const maiuscula = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
export const intervalo = (de, ate) => `${mesCurto(de)} – ${mesCurto(ate)}`;
export const dataBr = (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
const ou = (v) => (v == null ? NA : esc(v));
export const mesesTxt = (n) => `${n} ${n === 1 ? "mês" : "meses"}`;
export const tempoMentoria = (meses) => (meses == null || meses <= 0 ? "início" : meses < 12 ? `${meses} ${meses === 1 ? "mês" : "meses"}` : `${Math.floor(meses / 12)} ${Math.floor(meses / 12) === 1 ? "ano" : "anos"}${meses % 12 ? ` e ${meses % 12} ${meses % 12 === 1 ? "mês" : "meses"}` : ""}`);

/** Valor de um indicador formatado pelo tipo. */
export function valorIndicador(tipo, v) {
  if (v == null) return null;
  if (tipo === "reais") return reais(v);
  if (tipo === "percentual") return pct(v);
  return num(v);
}

const STATUS = { ativa: ["Ativa", "ok"], pausada: ["Pausada", "warn"], encerrada: ["Encerrada", "muted"] };
const DISPONIBILIDADE = { completa: ["Dados completos", "ok"], parcial: ["Dados parciais", "warn"], sem_dados: ["Sem dados", "muted"] };
const selo = ([rotulo, tom]) => `<span class="nm-selo nm-selo--${tom}">${esc(rotulo)}</span>`;
const leituraClasse = (l) => (l === "melhora" ? "nm-bom" : l === "piora" ? "nm-ruim" : "");

// ---------------------------------------------------------------------------
// Listagem
// ---------------------------------------------------------------------------
export const filtrosPadrao = () => ({ termo: "", mentor: "", status: "", renovacao: "", dados: "" });

const normalizar = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const normalizarTexto = normalizar;

/** Aplica busca e filtros. `hojeIso` decide "renova em 90 dias". */
export function filtrar(itens, f, hojeIso) {
  const termo = normalizar(f.termo).trim();
  const hoje = Date.parse(hojeIso ?? new Date().toISOString().slice(0, 10));
  return itens.filter((m) => {
    if (termo && ![m.empresa, m.responsavel, m.mentor, m.cidade, m.uf].some((v) => normalizar(v).includes(termo))) return false;
    if (f.mentor && (m.mentor ?? "") !== f.mentor) return false;
    if (f.status && m.status !== f.status) return false;
    if (f.dados === "pendente" ? !m.pendencias?.length : f.dados && m.disponibilidade !== f.dados) return false;
    if (f.renovacao) {
      const dias = m.dataRenovacao ? Math.round((Date.parse(m.dataRenovacao) - hoje) / 864e5) : null;
      if (f.renovacao === "sem" && dias != null) return false;
      if (f.renovacao === "90" && !(dias != null && dias >= 0 && dias <= 90)) return false;
      if (f.renovacao === "vencida" && !(dias != null && dias < 0)) return false;
    }
    return true;
  });
}

function opcoes(lista, atual, rotuloTodos) {
  return `<option value="">${esc(rotuloTodos)}</option>` + lista.map(([v, r]) => `<option value="${esc(v)}"${v === atual ? " selected" : ""}>${esc(r)}</option>`).join("");
}

function variacaoCelula(m) {
  const v = m.variacaoVendas;
  if (!v) return `<span class="nm-na">sem ciclo</span>`;
  if (!v.comparavel) return `<span class="nm-na" title="${esc(v.motivo ?? "")}">não comparável</span>`;
  const cls = v.percentual > 0 ? "nm-bom" : v.percentual < 0 ? "nm-ruim" : "";
  const emCurso = m.cicloEmCurso ? `<span class="nm-sub">${esc(m.cicloEmCurso.rotulo.replace(" de mentoria", ""))} em curso (${mesesTxt(m.cicloEmCurso.meses)}): ${m.cicloEmCurso.comparavel ? pctSinal(m.cicloEmCurso.percentual) : "não comparável"}</span>` : "";
  return `<strong class="nm-num ${cls}">${pctSinal(v.percentual)}</strong>${m.cicloAtual?.parcial ? `<span class="nm-sub">parcial · ${mesesTxt(m.cicloAtual.meses)}</span>` : `<span class="nm-sub">${esc(m.cicloAtual?.rotulo ?? "")}</span>`}${emCurso}`;
}

export function htmlLista(d, f = filtrosPadrao()) {
  const todos = d?.mentorados ?? [];
  const mentores = [...new Set(todos.map((m) => m.mentor).filter(Boolean))].sort().map((x) => [x, x]);
  const lista = filtrar(todos, f, d?.hojeIso);
  const renovar90 = filtrar(todos, { ...filtrosPadrao(), renovacao: "90" }, d?.hojeIso).length;
  const resumo = `
    <div class="nm-resumo" role="list">
      <div role="listitem"><span class="nm-resumo__n">${todos.length}</span><span>empresas na mentoria</span></div>
      <div role="listitem"><span class="nm-resumo__n">${todos.filter((m) => m.status === "ativa").length}</span><span>ativas</span></div>
      <div role="listitem"><span class="nm-resumo__n">${renovar90}</span><span>renovam em até 90 dias</span></div>
      <div role="listitem"><span class="nm-resumo__n">${todos.filter((m) => m.pendencias?.length).length}</span><span>com cadastro pendente</span></div>
    </div>`;
  const linhas = lista.map((m) => {
    const alertas = (m.alertas ?? []).filter((a) => a.nivel === "atencao");
    return `<tr>
      <th scope="row"><button type="button" class="nm-link" data-nm-abrir="${esc(m.organizacaoId)}">${esc(m.empresa)}</button>
        <span class="nm-sub">${esc([m.responsavel, [m.cidade, m.uf].filter(Boolean).join("/")].filter(Boolean).join(" · ") || "—")}</span>
        <span class="nm-empresa-status">${selo(STATUS[m.status] ?? [m.status, "muted"])}</span></th>
      <td data-rotulo="Mentor">${ou(m.mentor)}</td>
      <td class="nm-contrato" data-rotulo="Contrato">${m.dataEntrada ? `<span class="nm-num">desde ${dataBr(m.dataEntrada)}</span><span class="nm-sub">${tempoMentoria(m.mesesDeMentoria)} · ${m.dataRenovacao ? `renova ${dataBr(m.dataRenovacao)}` : "renovação não informada"}</span>` : selo(["Entrada pendente", "warn"])}${m.pendencias?.length ? `<span class="nm-sub nm-alerta">pendente: ${esc(m.pendencias.join(", "))}</span>` : ""}</td>
      <td class="nm-num" data-rotulo="Vendas">${variacaoCelula(m)}</td>
      <td class="nm-num" data-rotulo="Custos iFood">${m.custosIfood?.comparavel ? `<span class="${m.custosIfood.pontosPercentuais < 0 ? "nm-bom" : m.custosIfood.pontosPercentuais > 0 ? "nm-ruim" : ""}">${pp(m.custosIfood.pontosPercentuais)}</span>` : `<span class="nm-na">—</span>`}</td>
      <td data-rotulo="Dados">${selo(DISPONIBILIDADE[m.disponibilidade] ?? ["—", "muted"])}${m.divergenciasPendentes ? `<span class="nm-sub nm-alerta">${icon("alert-triangle", { size: 12 })} ${m.divergenciasPendentes} mês(es) com divergência a analisar</span>` : ""}${alertas.length && !m.divergenciasPendentes ? `<span class="nm-sub nm-alerta">${icon("alert-triangle", { size: 12 })} ${esc(alertas[0].texto)}</span>` : ""}</td>
      <td class="nm-acoes"><button type="button" class="nm-btn" data-nm-apresentar="${esc(m.organizacaoId)}" aria-label="Apresentar resultados de ${esc(m.empresa)}">${icon("play", { size: 14 })}Apresentar</button></td>
    </tr>`;
  }).join("");
  return `
  <section class="nm" aria-labelledby="nm-titulo">
    <header class="nm-cab">
      <div><p class="nm-sobre">Painel Administrativo</p><h1 id="nm-titulo" class="nm-h1">Núcleo Mentorados</h1>
        <p class="nm-lead">Evolução de cada empresa antes e durante a mentoria, com fontes auditáveis.</p></div>
      <button type="button" class="nm-btn nm-btn--primario" data-nm-vincular>${icon("plus", { size: 16 })}Vincular empresas</button>
    </header>
    ${resumo}
    <div class="nm-filtros" role="search">
      <label class="nm-campo nm-campo--busca"><span class="nm-rotulo">Buscar</span>
        <input id="nm-busca" type="search" autocomplete="off" placeholder="Empresa, responsável, cidade…" value="${esc(f.termo)}" /></label>
      <label class="nm-campo"><span class="nm-rotulo">Mentor</span><select data-nm-filtro="mentor">${opcoes(mentores, f.mentor, "Todos")}</select></label>
      <label class="nm-campo"><span class="nm-rotulo">Status</span><select data-nm-filtro="status">${opcoes([["ativa", "Ativa"], ["pausada", "Pausada"], ["encerrada", "Encerrada"]], f.status, "Todos")}</select></label>
      <label class="nm-campo"><span class="nm-rotulo">Renovação</span><select data-nm-filtro="renovacao">${opcoes([["90", "Em até 90 dias"], ["vencida", "Vencida"], ["sem", "Sem data"]], f.renovacao, "Todas")}</select></label>
      <label class="nm-campo"><span class="nm-rotulo">Dados</span><select data-nm-filtro="dados">${opcoes([["completa", "Completos"], ["parcial", "Parciais"], ["sem_dados", "Sem dados"], ["pendente", "Cadastro pendente"]], f.dados, "Todos")}</select></label>
    </div>
    ${!todos.length ? vazio("Nenhuma empresa cadastrada na mentoria", "O Núcleo só mostra empresas vinculadas explicitamente — nenhuma empresa da plataforma entra automaticamente. Vincule as empresas que participam da mentoria.", `<button type="button" class="nm-btn nm-btn--primario" data-nm-vincular>Vincular empresas</button>`)
      : !lista.length ? vazio("Nenhuma empresa com esses filtros", "Ajuste a busca ou limpe os filtros.", `<button type="button" class="nm-btn" data-nm-limpar>Limpar filtros</button>`)
      : `<div class="nm-tabela-wrap"><table class="nm-tabela nm-tabela--lista">
        <caption class="nm-sr">Empresas participantes da mentoria (${lista.length})</caption>
        <thead><tr><th scope="col">Empresa</th><th scope="col">Mentor</th><th scope="col">Contrato</th>
          <th scope="col" class="nm-num" title="Vendas no iFood do ciclo em destaque × período equivalente anterior">Vendas</th><th scope="col" class="nm-num" title="Taxas, comissões, serviços e promoções sobre vendas, em pontos percentuais">Custos iFood</th><th scope="col">Dados</th><th scope="col"><span class="nm-sr">Ações</span></th></tr></thead>
        <tbody>${linhas}</tbody></table></div>`}
    <p class="nm-rodape">Vendas = valor das vendas no extrato do iFood (não é o faturamento total da empresa). Comparativos usam períodos de mesmo tamanho; meses sem dado ficam fora do cálculo.</p>
  </section>`;
}

export function vazio(titulo, texto, acao = "") {
  return `<div class="nm-vazio" role="status"><h2>${esc(titulo)}</h2><p>${esc(texto)}</p>${acao}</div>`;
}
export const carregandoNucleo = (texto = "Carregando…") => `<div class="nm nm-carregando" role="status" aria-live="polite"><div class="nm-esqueleto"></div><div class="nm-esqueleto nm-esqueleto--2"></div><p class="nm-sr">${esc(texto)}</p></div>`;
export function erroNucleo(e) {
  const instalado = e?.status !== 503;
  return `<div class="nm nm-erro" role="alert"><h2>${instalado ? "Não foi possível carregar o Núcleo Mentorados" : "Núcleo Mentorados ainda não instalado"}</h2>
    <p>${esc(instalado ? e?.message ?? "Erro desconhecido." : "A migration 162 ainda não foi aplicada neste ambiente. Nenhum dado foi alterado.")}</p>
    <p class="nm-cab__acoes" style="justify-content:center">${instalado ? `<button type="button" class="nm-btn" data-nm-recarregar>Tentar novamente</button>` : ""}<button type="button" class="nm-btn nm-btn--quieto" data-nm-voltar>Voltar à lista</button></p></div>`;
}

// ---------------------------------------------------------------------------
// Gráficos SVG (sem dependência; imprimem nítidos no PDF)
// ---------------------------------------------------------------------------
/** Rótulo do eixo X: a cada 3 meses em séries longas, sempre o último, nunca colado nele. */
export function mostraRotulo(i, n) {
  if (i === n - 1) return true;
  const passo = n > 18 ? 3 : n > 9 ? 2 : 1;
  return i % passo === 0 && n - 1 - i >= passo;
}

/** Linha vertical tracejada no início do mês do marco (ex.: mudança para Full Service), com rótulo curto. */
function svgMarcos(marcos, pontos, xInicio, topo, base) {
  return (marcos ?? []).map((m) => {
    const i = pontos.findIndex((p) => p.mes === m.mes);
    if (i < 0) return "";
    const x = xInicio(i);
    const aDireita = x > 960 * 0.7; // perto da borda direita o rótulo vai para a esquerda da linha
    return `<g class="nm-g-marco"><line x1="${x}" x2="${x}" y1="${topo}" y2="${base}"/><text x="${aDireita ? x - 6 : x + 6}" y="${topo + 12}" text-anchor="${aDireita ? "end" : "start"}">${esc(m.curto ?? m.rotulo)}</text></g>`;
  }).join("");
}
/** Marcos a partir das mudanças operacionais da análise. */
export const marcosDe = (mudancas = []) => mudancas.map((m) => ({ mes: m.mes, rotulo: m.texto, curto: `${ROTULO_MODELO_CURTO[m.para] ?? m.para} desde ${mesCurto(m.mes)}` }));
const ROTULO_MODELO_CURTO = { marketplace: "Marketplace", full_service: "Full Service", misto: "Misto", outro: "Outro modelo" };

function escalaNice(max) {
  if (!(max > 0)) return { max: 1, passo: 1 };
  const bruto = max / 4, mag = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((p) => p >= bruto);
  return { max: Math.ceil(max / passo) * passo, passo };
}

/**
 * Barras mensais (uma série, cor pelo período: "antes" / "mentoria"). Mês sem dado = marcação tracejada, nunca barra zero.
 * @param {{pontos: Array<{mes: string, valor: number|null, grupo: 'antes'|'mentoria'|'fora'}>, rotuloEixo?: (v:number)=>string, titulo: string}} p
 */
export function graficoBarras({ pontos, titulo, rotuloEixo = (v) => reaisCompacto(v), marcos = [] }) {
  const W = 960, H = 340, ml = 64, mr = 12, mt = 16, mb = 40;
  const max = Math.max(0, ...pontos.map((p) => p.valor ?? 0));
  const { max: topo, passo } = escalaNice(max);
  const larg = (W - ml - mr) / Math.max(1, pontos.length);
  const barra = Math.max(4, Math.min(28, larg - 4));
  const y = (v) => mt + (H - mt - mb) * (1 - v / topo);
  const grade = [];
  for (let v = 0; v <= topo + 1e-9; v += passo) grade.push(`<line x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}" class="nm-g-grade"/><text x="${ml - 8}" y="${y(v) + 4}" text-anchor="end" class="nm-g-eixo">${esc(rotuloEixo(v))}</text>`);
  const marcas = pontos.map((p, i) => {
    const cx = ml + larg * i + larg / 2;
    const rot = mostraRotulo(i, pontos.length) ? `<text x="${cx}" y="${H - mb + 18}" text-anchor="middle" class="nm-g-eixo">${mesCurto(p.mes)}</text>` : "";
    const rotulo = `${mesLongo(p.mes)}: ${p.valor == null ? "não informado" : reais(p.valor)}${p.grupo === "antes" ? " (antes da mentoria)" : p.grupo === "mentoria" ? " (mentoria)" : ""}`;
    if (p.valor == null) return `<g class="nm-g-ponto" tabindex="0" role="img" aria-label="${esc(rotulo)}" data-nm-dica="${esc(rotulo)}"><rect x="${cx - barra / 2}" y="${y(0) - 18}" width="${barra}" height="18" class="nm-g-vazio"/>${rot}</g>`;
    const h = Math.max(1, y(0) - y(p.valor));
    // Barra com topo arredondado (4px) ancorada na linha de base.
    const x = cx - barra / 2, top = y(p.valor), r = Math.min(4, barra / 2, h);
    const d = `M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + barra - r} Q${x + barra},${top} ${x + barra},${top + r} V${y(0)} Z`;
    return `<g class="nm-g-ponto" tabindex="0" role="img" aria-label="${esc(rotulo)}" data-nm-dica="${esc(rotulo)}"><rect x="${cx - larg / 2}" y="${mt}" width="${larg}" height="${H - mt - mb}" class="nm-g-alvo"/><path d="${d}" class="nm-g-barra nm-g-${p.grupo}"/>${rot}</g>`;
  }).join("");
  const marcosSvg = svgMarcos(marcos, pontos, (i) => ml + larg * i, mt, H - mb);
  return `<figure class="nm-grafico"><svg viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(titulo)}${marcos.length ? `. ${esc(marcos.map((m) => m.rotulo).join("; "))}` : ""}" preserveAspectRatio="xMidYMid meet">${grade.join("")}<line x1="${ml}" x2="${W - mr}" y1="${y(0)}" y2="${y(0)}" class="nm-g-base"/>${marcas}${marcosSvg}</svg></figure>`;
}

/** Linha de % mensal com faixa de meta (máximo). Mês sem dado interrompe a linha (sem interpolar). */
export function graficoLinhaPct({ pontos, meta = null, titulo, marcos = [] }) {
  const W = 960, H = 300, ml = 52, mr = 16, mt = 16, mb = 40;
  const vals = pontos.map((p) => p.valor).filter((v) => v != null);
  const { max: topo, passo } = escalaNice(Math.max(meta ?? 0, ...vals, 1));
  const passoX = (W - ml - mr) / Math.max(1, pontos.length - 1);
  const x = (i) => ml + passoX * i, y = (v) => mt + (H - mt - mb) * (1 - v / topo);
  const grade = [];
  for (let v = 0; v <= topo + 1e-9; v += passo) grade.push(`<line x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}" class="nm-g-grade"/><text x="${ml - 8}" y="${y(v) + 4}" text-anchor="end" class="nm-g-eixo">${v.toLocaleString("pt-BR")}%</text>`);
  let caminho = "", aberto = false;
  pontos.forEach((p, i) => { if (p.valor == null) { aberto = false; return; } caminho += `${aberto ? "L" : "M"}${x(i)},${y(p.valor)} `; aberto = true; });
  const pts = pontos.map((p, i) => {
    const rot = `${mesLongo(p.mes)}: ${p.valor == null ? "não informado" : pct(p.valor)}`;
    const label = mostraRotulo(i, pontos.length) ? `<text x="${x(i)}" y="${H - mb + 18}" text-anchor="middle" class="nm-g-eixo">${mesCurto(p.mes)}</text>` : "";
    return `<g class="nm-g-ponto" tabindex="0" role="img" aria-label="${esc(rot)}" data-nm-dica="${esc(rot)}"><rect x="${x(i) - passoX / 2}" y="${mt}" width="${passoX}" height="${H - mt - mb}" class="nm-g-alvo"/>${p.valor == null ? "" : `<circle cx="${x(i)}" cy="${y(p.valor)}" r="4.5" class="nm-g-marcador nm-g-${p.grupo}"/>`}${label}</g>`;
  }).join("");
  const linhaMeta = meta != null ? `<line x1="${ml}" x2="${W - mr}" y1="${y(meta)}" y2="${y(meta)}" class="nm-g-meta"/><text x="${ml + 6}" y="${y(meta) - 6}" text-anchor="start" class="nm-g-meta-rot">meta: até ${pct(meta, 0)}</text>` : "";
  const marcosSvg = svgMarcos(marcos, pontos, (i) => x(i) - passoX / 2, mt, H - mb);
  return `<figure class="nm-grafico"><svg viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(titulo)}${marcos.length ? `. ${esc(marcos.map((m) => m.rotulo).join("; "))}` : ""}" preserveAspectRatio="xMidYMid meet">${grade.join("")}${linhaMeta}${marcosSvg}<path d="${caminho}" class="nm-g-linha"/>${pts}</svg></figure>`;
}

const legendaPeriodos = () => `<ul class="nm-legenda"><li><span class="nm-chave nm-g-antes"></span>Antes da mentoria</li><li><span class="nm-chave nm-g-mentoria"></span>Durante a mentoria</li><li><span class="nm-chave nm-chave--vazio"></span>Não informado</li></ul>`;

/** Grupo de cada mês em relação à entrada. */
export function grupoDoMes(ym, entrada) {
  const e = entrada.slice(0, 7);
  const antesInicio = `${Number(e.slice(0, 4)) - 1}${e.slice(4)}`;
  if (ym >= e) return "mentoria";
  if (ym >= antesInicio) return "antes";
  return "fora";
}

// ---------------------------------------------------------------------------
// Perfil — 5 abas
// ---------------------------------------------------------------------------
export const ABAS = [
  ["visao", "Visão geral"], ["historico", "Histórico financeiro"], ["comparativo", "Comparativo"],
  ["evolucao", "Evolução da mentoria"], ["apresentacoes", "Apresentações"],
];

const indicador = (comp, chave) => comp?.indicadores.find((i) => i.chave === chave) ?? null;

function kpi({ rotulo, valor, detalhe = "", tom = "", grande = false }) {
  return `<div class="nm-kpi${grande ? " nm-kpi--grande" : ""}"><span class="nm-kpi__rotulo">${esc(rotulo)}</span><span class="nm-kpi__valor nm-num ${tom}">${valor ?? NA}</span>${detalhe ? `<span class="nm-kpi__detalhe">${detalhe}</span>` : ""}</div>`;
}

function alertasHtml(alertas = []) {
  if (!alertas.length) return "";
  return `<ul class="nm-alertas">${alertas.map((a) => `<li class="nm-alertas__${a.nivel}">${icon(a.nivel === "atencao" ? "alert-triangle" : "info", { size: 14 })}<span>${esc(a.texto)}</span></li>`).join("")}</ul>`;
}

export function htmlPerfil(p, aba = "visao") {
  const e = p.empresa ?? {}, part = p.participante ?? {};
  const comp = p.analise?.comparativos?.[p.analise?.comparativoPrincipal] ?? null;
  const cab = `
  <header class="nm-cab nm-cab--perfil">
    <div>
      <button type="button" class="nm-voltar" data-nm-voltar>${icon("arrow-left", { size: 14 })}Núcleo Mentorados</button>
      <h1 class="nm-h1">${esc(e.nome ?? "Empresa")}</h1>
      <p class="nm-lead">${[part.cidade && `${esc(part.cidade)}${part.uf ? `/${esc(part.uf)}` : ""}`, part.mentor_nome && `Mentor: ${esc(part.mentor_nome)}`, `Na mentoria desde ${mesLongo(part.data_entrada)} · ${tempoMentoria(p.analise?.periodos?.mesesDeMentoria)}`, part.data_renovacao ? `Renovação em ${dataBr(part.data_renovacao)}` : "Renovação não cadastrada"].filter(Boolean).join(" · ")}</p>
    </div>
    <div class="nm-cab__acoes">
      <button type="button" class="nm-btn" data-nm-editar>Editar cadastro</button>
      <button type="button" class="nm-btn nm-btn--primario" data-nm-apresentar="${esc(e.id)}">${icon("play", { size: 14 })}Modo apresentação</button>
    </div>
  </header>
  <nav class="nm-abas" role="tablist" aria-label="Seções do perfil">${ABAS.map(([id, r]) => `<button type="button" role="tab" id="nm-aba-${id}" aria-controls="nm-painel" aria-selected="${id === aba}" tabindex="${id === aba ? 0 : -1}" data-nm-aba="${id}">${esc(r)}</button>`).join("")}</nav>`;
  const corpo = { visao: abaVisao, historico: abaHistorico, comparativo: abaComparativo, evolucao: abaEvolucao, apresentacoes: abaApresentacoes }[aba] ?? abaVisao;
  return `<section class="nm nm-perfil">${cab}<div id="nm-painel" role="tabpanel" aria-labelledby="nm-aba-${aba}" class="nm-painel">${corpo(p, comp)}</div></section>`;
}

function abaVisao(p, comp) {
  const v = indicador(comp, "valorVendas"), c = indicador(comp, "pctTaxasMaisServicos"), mm = indicador(comp, "mediaMensalVendas");
  const fechado = (m) => !p.analise?.mesCorrente || m.mes < p.analise.mesCorrente;
  const ultimo = p.analise?.evolucao?.filter((x) => x.valorVendas != null && fechado(x)).at(-1);
  const sem = !p.serie?.some((m) => m.valorVendas != null);
  const mud = p.analise?.mudancas ?? [];
  if (sem) return vazio("Ainda não há dados de vendas", "Importe a planilha de histórico na aba Histórico financeiro ou aguarde os lançamentos do Dashboard iFood.") + alertasHtml(p.analise?.alertas);
  const pontos = (p.serie ?? []).filter(fechado).map((m) => ({ mes: m.mes, valor: m.valorVendas, grupo: grupoDoMes(m.mes, p.participante.data_entrada) })).filter((x) => x.grupo !== "fora");
  return `
  ${comp ? `<p class="nm-contexto">${esc(comp.ciclo.rotulo)} (${intervalo(comp.ciclo.inicio, comp.ciclo.fim)}${comp.ciclo.parcial ? `, parcial: ${comp.ciclo.meses} de 12 meses` : ""}) comparado a ${intervalo(comp.ciclo.referencia.inicio, comp.ciclo.referencia.fim)}.${emCursoTxt(p, comp)}</p>` : `<p class="nm-contexto">${p.participante?.data_entrada ? "Ainda não há mês de mentoria encerrado." : "Data de entrada na mentoria pendente: confirme-a em “Editar cadastro” para liberar os comparativos."}</p>`}
  ${mud.length ? `<p class="nm-contexto nm-contexto--mudanca">${icon("alert-triangle", { size: 14 })} ${esc(mud.map((m) => m.texto).join("; "))}. Custos de entregadores antes e depois não são comparáveis; a ausência dessa taxa não é economia.</p>` : ""}
  <div class="nm-kpis">
    ${kpi({ rotulo: "Crescimento das vendas no iFood", grande: true, valor: v?.comparavel ? pctSinal(v.variacaoPercentual) : null, tom: leituraClasse(v?.leitura), detalhe: v?.comparavel ? `${reais(v.referencia)} → ${reais(v.atual)}` : esc(v?.motivo ?? "Sem ciclo de mentoria encerrado.") })}
    ${kpi({ rotulo: "Custos iFood sobre vendas", valor: c?.comparavel ? `${pct(c.referencia)} → ${pct(c.atual)}` : null, tom: leituraClasse(c?.leitura), detalhe: c?.comparavel ? `${pp(c.pontosPercentuais)} · taxas, comissões, serviços e promoções` : esc(c?.motivo ?? "") })}
    ${kpi({ rotulo: "Média mensal de vendas", valor: mm?.atual != null ? reais(mm.atual) : null, detalhe: mm?.comparavel ? `antes: ${reais(mm.referencia)}` : "" })}
    ${kpi({ rotulo: `Último mês fechado (${mesCurto(ultimo?.mes)})`, valor: ultimo ? reais(ultimo.valorVendas) : null, detalhe: ultimo?.yoy?.percentual != null ? `${pctSinal(ultimo.yoy.percentual)} vs ${mesCurto(`${Number(ultimo.mes.slice(0, 4)) - 1}${ultimo.mes.slice(4)}`)}` : "sem mesmo mês do ano anterior" })}
  </div>
  <div class="nm-bloco"><div class="nm-bloco__cab"><h2>Evolução das vendas no iFood</h2>${legendaPeriodos()}</div>
    ${graficoBarras({ pontos, titulo: "Vendas mensais no iFood, antes e durante a mentoria", marcos: marcosDe(p.analise?.mudancas) })}<div class="nm-dica" role="status" aria-live="polite" hidden></div>
    ${p.analise?.mesCorrente ? `<p class="nm-sub">Meses fechados até ${mesCurto(pontos.at(-1)?.mes)}. O mês de ${mesLongo(p.analise.mesCorrente)} ainda está em andamento e aparece só no histórico.</p>` : ""}</div>
  ${metasHtml(p.analise?.metas)}
  <div class="nm-bloco"><h2>Alertas</h2>${alertasHtml(p.analise?.alertas) || "<p class=\"nm-muted\">Nenhum alerta.</p>"}</div>`;
}

function emCursoTxt(p, comp) {
  const c = p.analise?.comparativos?.at(-1);
  if (!c || c === comp) return "";
  const v = indicador(c, "valorVendas");
  return ` ${esc(c.ciclo.rotulo)} em curso: ${mesesTxt(c.ciclo.meses)}${v?.comparavel ? `, vendas ${pctSinal(v.variacaoPercentual)} vs os mesmos meses do ano anterior` : ""} (detalhes na aba Comparativo).`;
}

function metasHtml(metas = []) {
  if (!metas.length) return "";
  return `<div class="nm-bloco"><h2>Metas × realizado no ciclo em destaque</h2><table class="nm-tabela nm-tabela--compacta"><thead><tr><th scope="col">Indicador</th><th scope="col" class="nm-num">Meta (máximo)</th><th scope="col" class="nm-num">Realizado</th><th scope="col" class="nm-num">Diferença</th><th scope="col">Situação</th></tr></thead><tbody>
    ${metas.map((m) => `<tr><th scope="row">${esc(m.rotulo)}</th><td class="nm-num">${pct(m.meta, 0)}</td><td class="nm-num">${m.realizado == null ? NA : pct(m.realizado)}</td><td class="nm-num">${m.diferencaPp == null ? "—" : pp(m.diferencaPp)}</td><td>${m.contexto ? `${selo(["Não avaliável", "muted"])}<span class="nm-sub">${esc(m.contexto)}</span>` : m.dentro == null ? `<span class="nm-na">sem dado</span>` : m.dentro ? selo(["Dentro da meta", "ok"]) : selo(["Acima da meta", "bad"])}${m.realizado != null && !m.contexto ? `<span class="nm-sub">${m.meses} meses com dado</span>` : ""}</td></tr>`).join("")}
  </tbody></table></div>`;
}

const ROTULO_FONTE = { importacao: "Planilha", dashboard_ifood: "Dashboard iFood" };

function abaHistorico(p) {
  const meses = [...(p.serie ?? [])].reverse();
  const div = new Map(); for (const d of p.divergencias ?? []) (div.get(d.mes) ?? div.set(d.mes, []).get(d.mes)).push(d);
  const pctLinha = (m, ...cs) => (m.valorVendas != null && cs.every((c) => m[c] != null) ? pct(cs.reduce((s, c) => s + m[c], 0) / m.valorVendas * 100) : null);
  const tabela = !meses.length ? vazio("Sem histórico", "Nenhum mês com dados ainda.") : `<div class="nm-tabela-wrap"><table class="nm-tabela nm-tabela--densa">
    <caption class="nm-sr">Histórico mensal</caption>
    <thead><tr><th scope="col">Mês</th><th scope="col" class="nm-num">Vendas no iFood</th><th scope="col" class="nm-num">Taxas e comissões</th><th scope="col" class="nm-num">Serviços e promoções</th><th scope="col" class="nm-num">Entregadores</th><th scope="col" class="nm-num">Taxas+serviços</th><th scope="col" class="nm-num" title="Pedidos · ticket médio · novos clientes (aba Desempenho)">Desempenho</th><th scope="col">Origem</th></tr></thead>
    <tbody>${meses.map((m) => `<tr${div.has(m.mes) && div.get(m.mes).some((d) => !d.resolvidaPor) ? ' class="nm-linha-div"' : ""}>
      <th scope="row">${mesCurto(m.mes)}${p.analise?.mesCorrente && m.mes >= p.analise.mesCorrente ? `<span class="nm-sub">em andamento</span>` : ""}</th>
      <td class="nm-num">${ou(reais(m.valorVendas))}</td>
      <td class="nm-num">${ou(reais(m.taxasComissoes))}<span class="nm-sub">${pctLinha(m, "taxasComissoes") ?? ""}</span></td>
      <td class="nm-num">${ou(reais(m.servicosPromocoes))}<span class="nm-sub">${pctLinha(m, "servicosPromocoes") ?? ""}</span></td>
      <td class="nm-num">${ou(reais(m.taxasEntregadores))}<span class="nm-sub">${pctLinha(m, "taxasEntregadores") ?? ""}</span></td>
      <td class="nm-num">${ou(pctLinha(m, "taxasComissoes", "servicosPromocoes"))}</td>
      <td class="nm-num">${m.qtdPedidos == null && m.novosClientes == null ? NA : `${num(m.qtdPedidos) ?? "—"} pedidos<span class="nm-sub">ticket ${m.qtdPedidos && m.valorVendasDesempenho != null ? reais(Math.round(m.valorVendasDesempenho / m.qtdPedidos)) : "—"} · ${num(m.novosClientes) ?? "—"} novos</span>`}</td>
      <td class="nm-origem">${esc(ROTULO_FONTE[m.fonte] ?? m.fonte ?? "—")}${Object.values(m.escolhas ?? {}).some((e) => e.aplicada) ? `<span class="nm-sub">escolha registrada</span>` : ""}${m.fontes?.desempenho && m.fontes.desempenho !== m.fontes.financeiro ? `<span class="nm-sub">desempenho: ${esc(ROTULO_FONTE[m.fontes.desempenho])}</span>` : ""}${div.has(m.mes) ? (div.get(m.mes).every((d) => d.resolvidaPor) ? `<button type="button" class="nm-sub nm-link" data-nm-divergencia="${esc(m.mes)}">${icon("check-circle", { size: 12 })} divergência resolvida</button>` : `<button type="button" class="nm-sub nm-alerta nm-link" data-nm-divergencia="${esc(m.mes)}">${icon("alert-triangle", { size: 12 })} ${div.get(m.mes).filter((d) => !d.resolvidaPor).length} divergência(s)</button>`) : ""}</td>
    </tr>`).join("")}</tbody></table></div>`;
  const imps = (p.importacoes ?? []).slice().reverse();
  return `
  <div class="nm-bloco nm-bloco--linha"><div><h2>Histórico mensal</h2>
    <p class="nm-muted">Fonte padrão: <strong>${esc(ROTULO_FONTE[p.fontes?.preferencial] ?? "—")}</strong>. A planilha complementa o histórico; quando um mês existe nas duas fontes, a outra aparece como divergência — nunca é somada — e um administrador pode escolher, com justificativa, qual vale por período e grupo. Os registros oficiais do Dashboard iFood nunca são alterados.</p></div>
    <span class="nm-cab__acoes"><button type="button" class="nm-btn" data-nm-escolher-fonte>Escolher fonte</button><button type="button" class="nm-btn nm-btn--primario" data-nm-importar>${icon("upload", { size: 14 })}Importar planilha</button></span></div>
  ${tabela}
  ${htmlEscolhas(p.escolhasFonte)}
  <div class="nm-bloco"><h2>Importações</h2>${!imps.length ? '<p class="nm-muted">Nenhuma planilha importada.</p>' : `<ul class="nm-lista-fontes">${imps.map((i) => `<li><strong>${esc(i.arquivo_nome)}</strong><span>${intervalo(i.mes_inicio, i.mes_fim)} · ${i.meses} meses · leitor ${esc(i.leitor_versao)}</span><span class="nm-sub">importada em ${dataBr(i.created_at)}${i.importado_por_email ? ` por ${esc(i.importado_por_email)}` : ""} · SHA-256 ${esc(i.arquivo_sha256.slice(0, 12))}…</span></li>`).join("")}</ul>`}</div>`;
}

const ROTULO_GRUPO = { financeiro: "Financeiro (vendas, taxas, serviços, entregadores)", desempenho: "Desempenho (pedidos, ticket, novos clientes)" };
export function htmlEscolhas(lista = []) {
  if (!lista?.length) return "";
  return `<div class="nm-bloco"><h2>Escolhas de fonte</h2><ul class="nm-lista-fontes">${lista.slice().reverse().map((e) => `<li${e.revogada_em ? ' class="nm-revogada"' : ""}>
    <strong>${intervalo(e.mes_inicio, e.mes_fim)} · ${esc(ROTULO_GRUPO[e.grupo] ?? e.grupo)} → ${esc(ROTULO_FONTE[e.fonte])}</strong>
    <span>“${esc(e.justificativa)}”</span>
    <span class="nm-sub">${e.criado_por_nome ? `${esc(e.criado_por_nome)} · ` : ""}${dataBr(e.created_at)}${e.revogada_em ? ` · revogada em ${dataBr(e.revogada_em)}: “${esc(e.motivo_revogacao)}”` : ""}</span>
    ${e.revogada_em ? "" : `<span class="nm-lista-fontes__acoes"><button type="button" class="nm-btn nm-btn--quieto" data-nm-revogar-fonte="${esc(e.id)}">Revogar</button></span>`}</li>`).join("")}</ul></div>`;
}

export function htmlDivergencias(lista = []) {
  return `<table class="nm-tabela nm-tabela--compacta"><thead><tr><th scope="col">Campo</th><th scope="col" class="nm-num">Usado</th><th scope="col" class="nm-num">Descartado</th><th scope="col" class="nm-num">Diferença</th></tr></thead><tbody>
  ${lista.map((d) => { const f = (v) => (v == null ? NA : d.tipo === "reais" ? reais(v) : num(v)); return `<tr><th scope="row">${esc(d.rotulo)}${d.resolvidaPor ? '<span class="nm-sub">resolvida por escolha registrada</span>' : ""}</th><td class="nm-num">${f(d.usado.valor)}<span class="nm-sub">${esc(ROTULO_FONTE[d.usado.fonte])}</span></td><td class="nm-num">${f(d.descartado.valor)}<span class="nm-sub">${esc(ROTULO_FONTE[d.descartado.fonte])}</span></td><td class="nm-num">${d.diferenca == null ? "—" : f(d.diferenca)}</td></tr>`; }).join("")}
  </tbody></table>`;
}

function tabelaComparativo(c) {
  return `<div class="nm-tabela-wrap"><table class="nm-tabela">
    <caption class="nm-sr">${esc(c.ciclo.rotulo)}</caption>
    <thead><tr><th scope="col">Indicador</th><th scope="col" class="nm-num">${intervalo(c.ciclo.referencia.inicio, c.ciclo.referencia.fim)}</th><th scope="col" class="nm-num">${intervalo(c.ciclo.inicio, c.ciclo.fim)}</th><th scope="col" class="nm-num">Variação</th><th scope="col" class="nm-num">Meses com dado</th></tr></thead>
    <tbody>${c.indicadores.map((i) => {
      const variacao = !i.comparavel ? `<span class="nm-na" title="${esc(i.motivo ?? "")}">${i.estruturaMudou ? "estrutura de custos mudou" : "não comparável"}</span>`
        : i.tipo === "percentual" ? `<strong class="${leituraClasse(i.leitura)}">${pp(i.pontosPercentuais)}</strong>`
        : `<strong class="${leituraClasse(i.leitura)}">${pctSinal(i.variacaoPercentual) ?? "—"}</strong><span class="nm-sub">${i.variacaoAbsoluta == null ? "" : `${i.variacaoAbsoluta > 0 ? "+" : ""}${valorIndicador(i.tipo, i.variacaoAbsoluta)}`}</span>`;
      return `<tr><th scope="row">${esc(i.rotulo)}</th><td class="nm-num">${valorIndicador(i.tipo, i.referencia) ?? NA}</td><td class="nm-num">${valorIndicador(i.tipo, i.atual) ?? NA}</td><td class="nm-num">${variacao}</td><td class="nm-num"><span class="nm-cobertura">${i.cobertura.referencia}/${i.cobertura.esperados} · ${i.cobertura.atual}/${i.cobertura.esperados}</span></td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function abaComparativo(p) {
  const comps = p.analise?.comparativos ?? [];
  if (!comps.length) return vazio("Sem comparativo ainda", "O comparativo aparece quando houver ao menos um mês de mentoria encerrado com dados.");
  const ev = (p.analise?.evolucao ?? []).filter((x) => x.valorVendas != null && (!p.analise.mesCorrente || x.mes < p.analise.mesCorrente)).slice(-12).reverse();
  return `
  <p class="nm-contexto">Antes da mentoria: ${p.analise.periodos.antes ? intervalo(p.analise.periodos.antes.inicio, p.analise.periodos.antes.fim) : "—"}. Cada ciclo é comparado ao período equivalente imediatamente anterior, com o mesmo número de meses. Percentuais agregados são ponderados pelos totais (Σ custos ÷ Σ vendas). Indicadores percentuais variam em pontos percentuais (p.p.).</p>
  ${comps.map((c) => `<div class="nm-bloco"><h2>${esc(c.ciclo.rotulo)}${c.ciclo.parcial ? ` <span class="nm-selo nm-selo--warn">parcial · ${c.ciclo.meses} de 12 meses</span>` : ""}</h2>${tabelaComparativo(c)}</div>`).join("")}
  <div class="nm-bloco"><h2>Mês contra mês e ano contra ano (vendas)</h2><div class="nm-tabela-wrap"><table class="nm-tabela nm-tabela--compacta"><thead><tr><th scope="col">Mês</th><th scope="col" class="nm-num">Vendas</th><th scope="col" class="nm-num">vs mês anterior</th><th scope="col" class="nm-num">vs mesmo mês do ano anterior</th><th scope="col" class="nm-num">Taxas+serviços</th></tr></thead><tbody>
  ${ev.map((m) => `<tr><th scope="row">${mesCurto(m.mes)}</th><td class="nm-num">${reais(m.valorVendas)}</td><td class="nm-num">${pctSinal(m.mom.percentual) ?? NA}</td><td class="nm-num">${pctSinal(m.yoy.percentual) ?? NA}</td><td class="nm-num">${pct(m.pctTaxasMaisServicos) ?? NA}</td></tr>`).join("")}
  </tbody></table></div></div>
  ${(p.analise?.mudancas ?? []).length ? `<p class="nm-rodape">Mudanças de modelo operacional: ${esc(p.analise.mudancas.map((m) => m.texto).join("; "))}. Indicadores de entregadores não são comparados entre estruturas de custo diferentes.</p>` : ""}
  <p class="nm-rodape">Comparação temporal: mostra o que mudou, não prova que a mentoria causou a mudança. Consulte as estratégias registradas na aba Evolução da mentoria.</p>`;
}

const ROTULO_INDICADOR = { taxasComissoes: "taxas e comissões", servicosPromocoes: "serviços e promoções", taxasMaisServicos: "taxas + serviços e promoções", taxasEntregadores: "entregadores", custosIfoodTotal: "total com entregadores", valorVendas: "vendas", ticketMedio: "ticket médio", qtdPedidos: "pedidos", novosClientes: "novos clientes" };
const TIPOS = { diagnostico: "Diagnóstico", estrategia: "Estratégia", meta: "Meta", evidencia: "Evidência", observacao: "Observação", mudanca_operacional: "Mudança operacional" };
function abaEvolucao(p) {
  const regs = p.registros ?? [];
  const grupo = (t) => regs.filter((r) => r.tipo === t);
  return `
  <div class="nm-bloco nm-bloco--linha"><div><h2>Linha do tempo da mentoria</h2><p class="nm-muted">Diagnóstico, estratégias, metas, evidências, mudanças operacionais e observações. Itens privados não aparecem nos slides (só nas notas do mentor).</p></div>
    <button type="button" class="nm-btn nm-btn--primario" data-nm-novo-registro>${icon("plus", { size: 14 })}Novo registro</button></div>
  ${!regs.length ? vazio("Nada registrado ainda", "Comece pelo diagnóstico inicial: o que foi encontrado antes da mentoria.") : `<ol class="nm-linha-tempo">${regs.map((r) => `<li class="nm-lt nm-lt--${esc(r.tipo)}">
    <div class="nm-lt__data nm-num">${dataBr(r.data_registro)}</div>
    <div class="nm-lt__corpo"><p class="nm-lt__tipo">${esc(TIPOS[r.tipo] ?? r.tipo)}${r.privado ? ' · <span class="nm-privado">privado</span>' : ""}</p>
      <h3>${esc(r.titulo)}</h3>${r.descricao ? `<p>${esc(r.descricao)}</p>` : ""}
      ${r.tipo === "meta" && r.meta_valor != null ? `<p class="nm-sub">Meta: ${esc(ROTULO_INDICADOR[r.meta_indicador] ?? r.meta_indicador ?? "")} ${r.meta_unidade === "percentual" ? pct(Number(r.meta_valor)) : r.meta_unidade === "reais" ? reais(Math.round(Number(r.meta_valor) * 100)) : num(Number(r.meta_valor))}</p>` : ""}
      ${r.indicadores?.length ? `<p class="nm-sub">Indicadores: ${r.indicadores.map(esc).join(", ")}</p>` : ""}
      ${r.tipo === "mudanca_operacional" ? `<p class="nm-sub">${esc(ROTULO_MODELO_CURTO[r.modelo_anterior] ?? "Modelo anterior não informado")} → ${esc(ROTULO_MODELO_CURTO[r.modelo_novo] ?? r.modelo_novo)} · a partir deste mês, custos de entregadores não são comparáveis com o período anterior.</p>` : ""}
      <p class="nm-lt__acoes"><button type="button" class="nm-link" data-nm-editar-registro="${esc(r.id)}">Editar</button><button type="button" class="nm-link nm-link--perigo" data-nm-remover-registro="${esc(r.id)}">Remover</button></p></div></li>`).join("")}</ol>`}
  <p class="nm-rodape">${grupo("estrategia").length} estratégia(s) · ${grupo("meta").length} meta(s) · ${grupo("evidencia").length} evidência(s). Registre evidências para sustentar qualquer relação entre ação e resultado.</p>`;
}

function abaApresentacoes(p) {
  const aps = p.apresentacoes ?? [];
  return `
  <div class="nm-bloco nm-bloco--linha"><div><h2>Apresentações</h2><p class="nm-muted">Cada versão guarda um retrato exato dos números usados (com hash). Reabrir uma versão antiga mostra os mesmos números de quando foi gerada.</p></div>
    <button type="button" class="nm-btn nm-btn--primario" data-nm-nova-apresentacao>${icon("plus", { size: 14 })}Gerar nova versão</button></div>
  ${!aps.length ? vazio("Nenhuma apresentação gerada", "Gere a primeira versão para abrir o modo apresentação e exportar em PDF.") : `<ul class="nm-lista-fontes">${aps.map((a) => `<li><strong>v${a.versao} · ${esc(a.titulo)}</strong><span>gerada em ${dataBr(a.created_at)}${a.criado_por_nome ? ` por ${esc(a.criado_por_nome)}` : ""} · SHA-256 ${esc(a.snapshot_sha256.slice(0, 12))}…</span>
    <span class="nm-lista-fontes__acoes"><button type="button" class="nm-btn" data-nm-abrir-apresentacao="${esc(a.id)}">${icon("play", { size: 14 })}Abrir</button><button type="button" class="nm-btn nm-btn--quieto" data-nm-pdf="${esc(a.id)}">Exportar PDF</button></span></li>`).join("")}</ul>`}
  <div class="nm-bloco nm-bloco--nota"><h2>Compartilhamento</h2><p class="nm-muted">Desativado. Um link externo exige uma política de autorização (quem pode ver, por quanto tempo, revogação) que ainda não foi definida. Por ora, exporte o PDF e envie por um canal seu.</p></div>`;
}

// ---------------------------------------------------------------------------
// Slides da apresentação (a partir do SNAPSHOT guardado — nunca recalcula)
// ---------------------------------------------------------------------------
export const SLIDES = [
  ["capa", "Capa"], ["diagnostico", "Diagnóstico anterior"], ["estrategias", "Estratégias executadas"], ["vendas", "Comparativo de vendas"],
  ["evolucao", "Evolução mensal"], ["clientes", "Pedidos, clientes e ticket"], ["eficiencia", "Eficiência financeira"],
  ["metas", "Metas e resultados"], ["oportunidades", "Oportunidades de melhoria"], ["plano", "Plano para o próximo ciclo"],
];

function fonteSlide(texto) { return `<details class="ap-fonte"><summary>Fontes e fórmulas</summary><p>${texto}</p></details>`; }

/**
 * @param {object} snap snapshot da apresentação (backend: montarSnapshot)
 * @param {object} cfg configuração (slidesOcultos, ocultarIndisponiveis, notas, oportunidades, plano)
 * @returns {Array<{id: string, titulo: string, html: string, notas: string, disponivel: boolean}>}
 */
export function slides(snap, cfg = {}) {
  const a = snap.analise ?? {}, part = snap.participante ?? {};
  const comp = a.comparativos?.[a.comparativoPrincipal] ?? null;
  const ind = (k) => indicador(comp, k);
  const publicos = (snap.registros ?? []).filter((r) => !r.privado);
  const fonte = `${(snap.fontes?.importacoes ?? []).map((i) => `Planilha “${esc(i.arquivo)}” (${intervalo(i.inicio, i.fim)}, SHA-256 ${esc(i.sha256.slice(0, 12))}…)`).join("; ") || "Sem planilha importada"}; Dashboard iFood: ${snap.fontes?.dashboardIfood?.meses ?? 0} mês(es), snapshot mensal oficial. Fonte preferencial: ${esc(ROTULO_FONTE[snap.fontes?.preferencial] ?? "—")}. Retrato gerado em ${dataBr(snap.geradoEm)}.`;
  const periodoTxt = comp ? `${intervalo(comp.ciclo.referencia.inicio, comp.ciclo.referencia.fim)} × ${intervalo(comp.ciclo.inicio, comp.ciclo.fim)}` : "";
  const notas = cfg.notas ?? {};
  const lista = [];
  const add = (id, html, disponivel = true) => lista.push({ id, titulo: SLIDES.find(([s]) => s === id)[1], html, notas: notas[id] ?? "", disponivel });

  add("capa", `<div class="ap-capa"><p class="ap-sobre">Resultados da mentoria · Crescer com Delivery</p><h1 class="ap-h1">${esc(snap.empresa?.nome ?? "")}</h1>
    <p class="ap-lead">${[part.cidade && `${esc(part.cidade)}${part.uf ? `/${esc(part.uf)}` : ""}`, `Mentoria desde ${mesLongo(part.dataEntrada)}`, part.mentor && `Mentor: ${esc(part.mentor)}`].filter(Boolean).join(" · ")}</p>
    ${comp ? `<p class="ap-periodo">${esc(comp.ciclo.rotulo)} · ${periodoTxt}</p>` : ""}</div>`);

  const antes = a.comparativos?.[0]?.referenciaAgregada ?? null;
  const diag = publicos.filter((r) => r.tipo === "diagnostico");
  const pa = antes?.percentuais;
  add("diagnostico", `<p class="ap-sobre">Antes da mentoria · ${antes ? intervalo(antes.inicio, antes.fim) : ""}</p><h2 class="ap-h2">Ponto de partida</h2>
    <div class="ap-kpis">${[
      ["Vendas no iFood (12 meses)", antes ? reais(antes.totais.valorVendas.total) : null],
      ["Média mensal", antes ? reais(antes.mediaMensalVendas) : null],
      ["Taxas e comissões / vendas", pct(pa?.taxasComissoes?.pct)],
      ["Serviços e promoções / vendas", pct(pa?.servicosPromocoes?.pct)],
      ["Taxas + serviços / vendas", pct(pa?.taxasMaisServicos?.pct)],
    ].filter(([, v]) => v != null || !cfg.ocultarIndisponiveis).map(([r, v]) => `<div class="ap-kpi"><span>${esc(r)}</span><strong class="nm-num">${v ?? NA}</strong></div>`).join("")}</div>
    ${diag.length ? `<ul class="ap-itens">${diag.map((r) => `<li><strong>${esc(r.titulo)}</strong>${r.descricao ? ` — ${esc(r.descricao)}` : ""}</li>`).join("")}</ul>` : ""}
    ${fonteSlide(`${fonte} Percentuais = Σ componente ÷ Σ vendas dos meses com o dado.`)}`, !!antes?.totais?.valorVendas?.total);

  const estr = publicos.filter((r) => r.tipo === "estrategia" || r.tipo === "evidencia" || r.tipo === "mudanca_operacional");
  add("estrategias", `<p class="ap-sobre">O que foi feito</p><h2 class="ap-h2">Estratégias executadas</h2>
    ${estr.length ? `<ol class="ap-linha">${estr.slice().sort((x, y) => x.data.localeCompare(y.data)).map((r) => `<li><span class="ap-data nm-num">${dataBr(r.data)}</span><div><strong>${esc(r.titulo)}</strong>${r.descricao ? `<p>${esc(r.descricao)}</p>` : ""}${r.tipo === "evidencia" ? '<span class="ap-tag">evidência</span>' : ""}${r.tipo === "mudanca_operacional" ? `<span class="ap-tag">mudança operacional · ${esc(ROTULO_MODELO_CURTO[r.modeloAnterior] ?? "—")} → ${esc(ROTULO_MODELO_CURTO[r.modeloNovo] ?? "")}</span>` : ""}</div></li>`).join("")}</ol>` : `<p class="ap-vazio">Nenhuma estratégia registrada.</p>`}`, estr.length > 0);

  const v = ind("valorVendas"), mm = ind("mediaMensalVendas");
  add("vendas", `<p class="ap-sobre">${esc(comp?.ciclo.rotulo ?? "")} · ${periodoTxt}</p><h2 class="ap-h2">Vendas no iFood</h2>
    ${v?.comparavel ? `<div class="ap-heroi"><strong class="ap-heroi__n nm-num">${pctSinal(v.variacaoPercentual)}</strong><span>de crescimento nas vendas no iFood</span></div>
    <div class="ap-duo"><div><span>Antes</span><strong class="nm-num">${reais(v.referencia)}</strong><em>média ${reais(mm?.referencia)}/mês</em></div><div class="ap-seta" aria-hidden="true">→</div><div><span>Com a mentoria</span><strong class="nm-num">${reais(v.atual)}</strong><em>média ${reais(mm?.atual)}/mês</em></div></div>
    <p class="ap-nota">Diferença: ${v.variacaoAbsoluta > 0 ? "+" : ""}${reais(v.variacaoAbsoluta)} em ${comp.ciclo.meses} meses${comp.ciclo.parcial ? " (ciclo parcial, comparado aos mesmos meses do ano anterior)" : ""}.</p>
    <p class="ap-ressalva">Valor das vendas no extrato do iFood — não é o faturamento total da empresa. A comparação mostra o que mudou entre os períodos; as ações que contribuíram estão no slide de estratégias.</p>` : `<p class="ap-vazio">${esc(v?.motivo ?? "Sem ciclo comparável.")}</p>`}
    ${fonteSlide(`${fonte} Vendas = valor das vendas do extrato financeiro do iFood (não é o faturamento total da empresa). Crescimento = (Σ ciclo − Σ anterior) ÷ Σ anterior.`)}`, !!v?.comparavel);

  const fechadoS = (m) => !a.mesCorrente || m.mes < a.mesCorrente;
  const serieFechada = (snap.serie ?? []).filter(fechadoS);
  const pontos = serieFechada.map((m) => ({ mes: m.mes, valor: m.valorVendas, grupo: grupoDoMes(m.mes, part.dataEntrada) })).filter((x) => x.grupo !== "fora");
  const ult = (a.evolucao ?? []).filter((x) => x.valorVendas != null && fechadoS(x)).at(-1);
  add("evolucao", `<p class="ap-sobre">Mês a mês</p><h2 class="ap-h2">Evolução mensal das vendas</h2>${legendaPeriodos()}
    ${graficoBarras({ pontos, titulo: "Vendas mensais no iFood", marcos: marcosDe(a.mudancas) })}<div class="nm-dica" role="status" aria-live="polite" hidden></div>
    ${ult ? `<p class="ap-nota">${maiuscula(mesLongo(ult.mes))}: ${reais(ult.valorVendas)}${ult.yoy.percentual != null ? ` · ${pctSinal(ult.yoy.percentual)} vs mesmo mês do ano anterior` : ""}${ult.mom.percentual != null ? ` · ${pctSinal(ult.mom.percentual)} vs mês anterior` : ""}.</p>` : ""}
    ${fonteSlide(fonte)}`, pontos.some((x) => x.valor != null));

  const atual = comp?.atualAgregado;
  const ped = ind("qtdPedidos"), tk = ind("ticketMedio"), nc = ind("novosClientes");
  const temDesempenho = [ped, tk, nc].some((i) => i?.atual != null);
  const mesesDesempenho = comp ? (snap.serie ?? []).filter((m) => m.mes >= comp.ciclo.inicio && m.mes <= comp.ciclo.fim && (m.qtdPedidos != null || m.novosClientes != null)) : [];
  const linhaDesemp = (i, rotulo) => `<div class="ap-kpi"><span>${esc(rotulo)}</span><strong class="nm-num">${valorIndicador(i?.tipo, i?.atual) ?? NA}</strong><em>${i?.comparavel ? (i.tipo === "percentual" ? pp(i.pontosPercentuais) : `${pctSinal(i.variacaoPercentual)} vs anterior`) : `${i?.cobertura?.atual ?? 0} de ${i?.cobertura?.esperados ?? 12} meses informados · sem comparação`}</em></div>`;
  add("clientes", `<p class="ap-sobre">Aba Desempenho do iFood</p><h2 class="ap-h2">Pedidos, clientes e ticket médio</h2>
    <div class="ap-kpis ap-kpis--3">${linhaDesemp(ped, "Pedidos")}${linhaDesemp(tk, "Ticket médio")}${linhaDesemp(nc, "Novos clientes")}</div>
    ${mesesDesempenho.length && mesesDesempenho.length <= 12 ? `<table class="ap-tabela"><thead><tr><th scope="col">Mês</th><th scope="col">Pedidos</th><th scope="col">Ticket médio</th><th scope="col">Novos clientes</th></tr></thead><tbody>${mesesDesempenho.map((m) => `<tr><th scope="row">${mesCurto(m.mes)}</th><td>${num(m.qtdPedidos) ?? NA}</td><td>${m.qtdPedidos && m.valorVendasDesempenho != null ? reais(Math.round(m.valorVendasDesempenho / m.qtdPedidos)) : NA}</td><td>${num(m.novosClientes) ?? NA}</td></tr>`).join("")}</tbody></table>` : ""}
    ${!ped?.comparavel ? `<p class="ap-nota">Dados de desempenho incompletos: estes números descrevem só os meses informados e não sustentam comparação com o período anterior.</p>` : ""}
    ${snap.metas?.referencia?.ticketMedio ? `<p class="ap-nota">Referência de ticket: mínimo ${reais(snap.metas.referencia.ticketMedio.minimo * 100)}, ideal ${reais(snap.metas.referencia.ticketMedio.ideal * 100)}.</p>` : ""}
    ${fonteSlide(`${fonte} Ticket médio = Σ valor (aba Desempenho) ÷ Σ pedidos, só meses com os dois.`)}`, temDesempenho);

  const efic = ["pctTaxasComissoes", "pctServicosPromocoes", "pctTaxasMaisServicos"].map(ind);
  const metaTS = snap.metas?.maximos?.taxasMaisServicos ?? null;
  const pontosPct = serieFechada.map((m) => ({ mes: m.mes, grupo: grupoDoMes(m.mes, part.dataEntrada), valor: m.valorVendas && m.taxasComissoes != null && m.servicosPromocoes != null ? Math.round(((m.taxasComissoes + m.servicosPromocoes) / m.valorVendas) * 1e6) / 1e4 : null })).filter((x) => x.grupo !== "fora");
  add("eficiencia", `<p class="ap-sobre">${periodoTxt}</p><h2 class="ap-h2">Eficiência financeira no iFood</h2>
    <div class="ap-kpis ap-kpis--3">${efic.map((i) => i ? `<div class="ap-kpi"><span>${esc(i.rotulo)}</span><strong class="nm-num">${pct(i.referencia) ?? NA} → ${pct(i.atual) ?? NA}</strong><em class="${leituraClasse(i.leitura)}">${i.comparavel ? pp(i.pontosPercentuais) : "não comparável"}</em></div>` : "").join("")}</div>
    ${graficoLinhaPct({ pontos: pontosPct, meta: metaTS, titulo: "Taxas, comissões, serviços e promoções sobre as vendas, mês a mês", marcos: marcosDe(a.mudancas) })}
    ${(a.mudancas ?? []).length ? `<p class="ap-nota">${esc(a.mudancas.map((m) => m.texto).join("; "))}: custos de entregadores antes e depois não são comparáveis, e a ausência dessa taxa não é economia.</p>` : ""}<div class="nm-dica" role="status" aria-live="polite" hidden></div>
    ${atual?.vendasPorRealPromocao != null ? `<p class="ap-nota">No ciclo: ${atual.vendasPorRealPromocao.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} reais vendidos para cada R$ 1 em serviços e promoções (antes: ${comp.referenciaAgregada.vendasPorRealPromocao?.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? "—"}). Indicador de relação, não de causa.</p>` : ""}
    ${fonteSlide(`${fonte} Percentuais ponderados: Σ (taxas + serviços) ÷ Σ vendas. Variação em pontos percentuais (p.p.) — diferença entre dois percentuais, não variação relativa.`)}`, efic.some((i) => i?.atual != null));

  const metas = a.metas ?? [];
  add("metas", `<p class="ap-sobre">Ciclo atual</p><h2 class="ap-h2">Metas e resultados</h2>
    ${metas.length ? `<div class="ap-metas">${metas.map((m) => `<div class="ap-meta ${m.contexto || m.dentro == null ? "" : m.dentro ? "ap-meta--ok" : "ap-meta--fora"}"><span>${esc(m.rotulo)}</span><strong class="nm-num">${pct(m.realizado) ?? NA}</strong><em>meta até ${pct(m.meta, 0)} · ${m.contexto ? "não avaliável: ciclo mistura modelos operacionais" : m.dentro == null ? "sem dado" : m.dentro ? "dentro da meta" : `${pp(m.diferencaPp)} acima`}</em></div>`).join("")}</div>` : `<p class="ap-vazio">Nenhuma meta definida.</p>`}
    ${fonteSlide(`${fonte} Metas da planilha (rótulos “Até X%”) e metas registradas pelo mentor (estas prevalecem).`)}`, metas.length > 0);

  // Oportunidades: fatos mensuráveis (último trimestre acima da meta) + texto do mentor. Nunca uma causa presumida.
  const ult3 = serieFechada.filter((m) => m.valorVendas != null).slice(-3);
  const fatos = [];
  if (ult3.length && snap.metas?.maximos?.servicosPromocoes != null) {
    const acima = ult3.filter((m) => m.servicosPromocoes != null && (m.servicosPromocoes / m.valorVendas) * 100 > snap.metas.maximos.servicosPromocoes);
    if (acima.length) fatos.push(`Serviços e promoções acima de ${pct(snap.metas.maximos.servicosPromocoes, 0)} das vendas em ${acima.map((m) => `${mesCurto(m.mes)} (${pct((m.servicosPromocoes / m.valorVendas) * 100)})`).join(", ")}.`);
  }
  if (ult3.length && snap.metas?.maximos?.taxasComissoes != null) {
    const acima = ult3.filter((m) => m.taxasComissoes != null && (m.taxasComissoes / m.valorVendas) * 100 > snap.metas.maximos.taxasComissoes);
    if (acima.length) fatos.push(`Taxas e comissões acima de ${pct(snap.metas.maximos.taxasComissoes, 0)} em ${acima.map((m) => `${mesCurto(m.mes)} (${pct((m.taxasComissoes / m.valorVendas) * 100)})`).join(", ")}.`);
  }
  add("oportunidades", `<p class="ap-sobre">Próximos ganhos</p><h2 class="ap-h2">Oportunidades de melhoria</h2>
    <div class="ap-colunas">
    ${fatos.length ? `<div><h3 class="ap-h3">Nos números (últimos 3 meses fechados)</h3><ul class="ap-itens">${fatos.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
    ${cfg.oportunidades ? `<div><h3 class="ap-h3">Recomendação do mentor</h3><div class="ap-texto">${esc(cfg.oportunidades).replace(/\n/g, "<br>")}</div></div>` : ""}
    </div>
    ${!fatos.length && !cfg.oportunidades ? `<p class="ap-vazio">Nenhuma oportunidade registrada.</p>` : ""}`, fatos.length > 0 || !!cfg.oportunidades);

  const metasFuturas = publicos.filter((r) => r.tipo === "meta");
  add("plano", `<p class="ap-sobre">Próximo ciclo</p><h2 class="ap-h2">Plano recomendado</h2>
    ${cfg.plano ? `<div class="ap-texto">${esc(cfg.plano).replace(/\n/g, "<br>")}</div>` : ""}
    ${metasFuturas.length ? `<ul class="ap-itens">${metasFuturas.map((r) => `<li><strong>${esc(r.titulo)}</strong>${r.metaValor != null ? ` — ${r.metaUnidade === "percentual" ? pct(Number(r.metaValor)) : r.metaUnidade === "reais" ? reais(Math.round(Number(r.metaValor) * 100)) : num(Number(r.metaValor))}` : ""}</li>`).join("")}</ul>` : ""}
    ${!cfg.plano && !metasFuturas.length ? `<p class="ap-vazio">Plano ainda não definido.</p>` : ""}`, !!cfg.plano || metasFuturas.length > 0);

  const ocultos = new Set(cfg.slidesOcultos ?? []);
  return lista.filter((s) => !ocultos.has(s.id) && (s.disponivel || !cfg.ocultarIndisponiveis));
}
