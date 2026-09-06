// Fechamento mensal (F7) — camada PURA (sem DOM). Testada em
// frontend/test/bonificacaoMensalFechamento.test.js; a parte com DOM
// (dropzones, eventos, chamadas de API) vive em bonificacaoMensalImportModal.js.
//
// Regra de negócio (ver docs/bonificacao-fechamento-mensal-visio.md):
//   COMPETÊNCIA ABERTA   → dados ao vivo.
//   COMPETÊNCIA FECHADA  → snapshot imutável, com origem única:
//     - fechamento_mensal_direto  (SEM_ACOMPANHAMENTO — 2 relatórios mensais)
//     - acompanhamento_diario     (ACOMPANHAMENTO_DIARIO — consolida o diário)
//     - legado_pre_refatoracao
//
// O fechamento mensal DIRETO (pelos 2 relatórios da Visio) NÃO sobrescreve um
// mês acompanhado dia a dia: só existe para competências SEM acompanhamento.
import { escapeHtml, fmtMoeda, fmtPct } from "./utils.js";

export const MESES_FECHAMENTO = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const fmtDataBr = (iso) => (typeof iso === "string" ? iso.split("-").reverse().join("/") : "—");
const item = (lbl, val) => `<div class="vd-pv-item"><span>${escapeHtml(lbl)}</span><b>${val}</b></div>`;
const numOuTraco = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : escapeHtml(v));

/**
 * [Analisar relatórios] só habilita com mês válido, ano válido e os DOIS PDFs.
 * Os checkboxes de conferência NÃO travam a análise — travam a confirmação
 * (viram bloqueio na prévia do backend).
 * @param {{ano:*, mes:*, temVendas:boolean, temProdutos:boolean}} p
 */
export function podeAnalisarMensal({ ano, mes, temVendas, temProdutos }) {
  const a = Number(ano);
  const m = Number(mes);
  if (!Number.isInteger(a) || a < 2000 || a > 2100) return false;
  if (!Number.isInteger(m) || m < 1 || m > 12) return false;
  return !!temVendas && !!temProdutos;
}

/**
 * Corpo da requisição de prévia/confirmação do fechamento mensal direto.
 * `vendas`/`produtos` são os payloads já em base64 ({nomeArquivo, conteudoBase64}).
 */
export function montarPayloadMensal({ ano, mes, vendas, produtos, conferiVendas, conferiProdutos, correcoes }) {
  return {
    ano: Number(ano),
    mes: Number(mes),
    vendas: vendas || undefined,
    produtos: produtos || undefined,
    // O backend usa `produtosCanalConfirmado` para o Relatório de Produtos e
    // `periodoConfirmadoUsuario` para a correspondência da competência.
    produtosCanalConfirmado: !!conferiProdutos,
    periodoConfirmadoUsuario: !!conferiVendas && !!conferiProdutos,
    correcoes: correcoes || undefined,
  };
}

/**
 * View-model da classificação do acompanhamento — decide qual ação a UI oferece.
 * @param {{tipo:string, diasEsperados:number, diasCobertos:number, diasComAcompanhamento:number, diasPendentes:string[]}|null|undefined} acomp
 * @returns {{tipo:string, titulo:string, descricao:string, pendentes:string[],
 *   diasEsperados:number, diasCobertos:number, acao:'confirmar'|'consolidar'|null}}
 */
export function classificacaoView(acomp) {
  const tipo = acomp?.tipo || "SEM_ACOMPANHAMENTO";
  const base = {
    tipo,
    pendentes: Array.isArray(acomp?.diasPendentes) ? acomp.diasPendentes : [],
    diasEsperados: acomp?.diasEsperados ?? 0,
    diasCobertos: acomp?.diasCobertos ?? 0,
  };
  if (tipo === "ACOMPANHAMENTO_DIARIO") {
    return {
      ...base,
      titulo: "Esta competência possui acompanhamento diário completo.",
      descricao: "Os dados mensais serão consolidados a partir dos lançamentos diários já registrados.",
      acao: "consolidar",
    };
  }
  if (tipo === "ACOMPANHAMENTO_PARCIAL") {
    return {
      ...base,
      titulo: "Esta competência possui acompanhamento diário parcial.",
      descricao: "Complete os lançamentos pendentes antes de consolidar esta competência.",
      acao: null,
    };
  }
  return {
    ...base,
    titulo: "Esta competência não possui acompanhamento diário.",
    descricao: "Você pode fechar o mês diretamente usando os relatórios mensais da Visio.",
    acao: "confirmar",
  };
}

// ---------------------------------------------------------------------------
// HTML do painel "Fechamento mensal" — dois dropzones + dois checkboxes.
// ---------------------------------------------------------------------------
const dropZoneHtml = (id, titulo, descricao) => `
  <div class="bm-drop" id="${id}-drop">
    <div class="bm-drop-titulo">${escapeHtml(titulo)}</div>
    <p class="bm-drop-desc">${escapeHtml(descricao)}</p>
    <div class="bm-drop-area" tabindex="0" role="button">
      <span class="bm-drop-icone">📄</span>
      <span class="bm-drop-txt">Arraste o PDF aqui ou <u>selecione o arquivo</u></span>
      <em id="${id}-nome">Nenhum arquivo selecionado</em>
    </div>
    <button type="button" class="btn btn-ghost btn-sm bm-drop-remover" id="${id}-remover" hidden>Trocar / remover</button>
    <input type="file" id="${id}-input" accept=".pdf" hidden>
  </div>`;

/**
 * @param {{mesAtual:number, anoAtual:number, anos:number[], fechada?:boolean, origemFechada?:string|null}} p
 */
export function mensalPaneHtml({ mesAtual, anoAtual, anos, fechada = false, origemFechada = null }) {
  if (fechada) {
    const rotuloOrigem = ORIGEM_ROTULO[origemFechada] || "";
    return `
      <div class="bm-imp-form">
        <div class="bm-mensal-classif ok">
          <b>Competência fechada</b>
          <p>O resultado desta competência já foi congelado${rotuloOrigem ? ` (${escapeHtml(rotuloOrigem)})` : ""}. Não é possível trocar relatórios, analisar de novo, confirmar ou consolidar.</p>
        </div>
      </div>
      <div class="ed-acoes">
        <button class="btn btn-ghost" id="bm-mensal-cancelar">Fechar</button>
      </div>`;
  }

  const anosOpts = anos.map((a) => `<option value="${a}" ${a === anoAtual ? "selected" : ""}>${a}</option>`).join("");
  const mesesOpts = MESES_FECHAMENTO.map((mm, i) => `<option value="${i + 1}" ${i + 1 === mesAtual ? "selected" : ""}>${mm}</option>`).join("");

  return `
    <div class="bm-imp-form">
      <p class="dex-diag-vazio">O <b>fechamento mensal direto</b> recupera competências sem acompanhamento diário (meses antigos) a partir dos <b>dois relatórios mensais</b> da Visio. Um mês acompanhado dia a dia é fechado consolidando o acompanhamento diário.</p>
      <div class="bm-imp-competencia">
        <label class="cfg-campo"><span>Mês *</span><select id="bm-mensal-mes">${mesesOpts}</select></label>
        <label class="cfg-campo"><span>Ano *</span><select id="bm-mensal-ano">${anosOpts}</select></label>
      </div>
      ${dropZoneHtml("bm-mensal-vendas", "1. Relatório Geral de Vendas — mês inteiro", "Relatório com todos os canais, cobrindo o mês inteiro. Fonte do faturamento e do ticket médio da competência.")}
      ${dropZoneHtml("bm-mensal-produtos", "2. Relatório de Produtos — mês inteiro", "Relatório de Produtos filtrado para Loja/Balcão, cobrindo o mês inteiro. Fonte das metas de Bebidas, Adicionais e Diversos.")}
      <label class="bm-mensal-conf"><input type="checkbox" id="bm-mensal-conf-vendas"> Conferi o Relatório Geral de Vendas (mês inteiro, unidade correta).</label>
      <label class="bm-mensal-conf"><input type="checkbox" id="bm-mensal-conf-produtos"> Conferi o Relatório de Produtos (filtro Loja/Balcão, mês inteiro).</label>
      <div class="vd-imp-msg" id="bm-mensal-msg" hidden></div>
      <div id="bm-mensal-preview"></div>
    </div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="bm-mensal-cancelar">Cancelar</button>
      <button class="btn btn-ghost" id="bm-mensal-analisar" disabled>Analisar relatórios</button>
    </div>`;
}

export const ORIGEM_ROTULO = {
  fechamento_mensal_direto: "fechamento mensal direto",
  acompanhamento_diario: "acompanhamento diário consolidado",
  legado_pre_refatoracao: "histórico legado",
};

// ---------------------------------------------------------------------------
// Prévia — classificação + indicadores oficiais + conferência de importação.
// SEM comparação entre fontes: um único percentual oficial por indicador.
// ---------------------------------------------------------------------------
function indicadoresOficiaisHtml(resultadoOficial) {
  const vo = resultadoOficial?.valoresOficiais || {};
  const pct = vo.percentuais || {};
  const ind = resultadoOficial?.indicadores || {};
  const manual = (k) => ind[k]?.valorAtual ?? null;
  return `
    <div class="bm-pv-bloco"><b>Indicadores que serão congelados</b><div class="vd-pv-grid">
      ${item("Faturamento", vo.faturamento != null ? fmtMoeda(vo.faturamento) : "—")}
      ${item("Ticket médio", vo.ticketMedio != null ? fmtMoeda(vo.ticketMedio) : "—")}
      ${item("Bebidas", fmtPct(pct.bebidas))}
      ${item("Adicionais", fmtPct(pct.adicionais))}
      ${item("Diversos", fmtPct(pct.diversos))}
      ${item("Sanduíches/Saladas (base)", numOuTraco(vo.sanduichesSaladas))}
      ${item("Quantidade de vendas", numOuTraco(vo.quantidadeVendas))}
      ${item("CMV", manual("cmv") != null ? fmtPct(manual("cmv")) : "—")}
      ${item("Nota iFood", numOuTraco(manual("avaliacao_ifood")))}
      ${item("Cancelamentos", numOuTraco(manual("cancelamentos")))}
      ${item("Pedidos com chamado", numOuTraco(manual("pedidos_chamado")))}
      ${item("Pesquisas", numOuTraco(manual("pesquisas")))}
      ${item("REV", numOuTraco(manual("rev")))}
    </div></div>`;
}

function conferenciaImportacaoHtml(conferencia) {
  if (!conferencia) return "";
  const p = conferencia.percentuais || {};
  const regra = p.regra || {};
  const pdf = p.impressosNoPdf || {};
  const reg = conferencia.registradoNaCompetencia;
  const linhaPct = (k, lbl) => `<div class="vd-pv-item"><span>${lbl}</span><b>${fmtPct(regra[k])}</b><em>PDF: ${pdf[k] != null ? fmtPct(pdf[k]) : "—"}</em></div>`;
  return `
    <details class="bm-pv-corrigir">
      <summary>Conferência de importação (dado técnico — não altera o resultado)</summary>
      <div class="vd-pv-grid">
        ${linhaPct("bebidas", "Bebidas")}
        ${linhaPct("adicionais", "Adicionais")}
        ${linhaPct("diversos", "Diversos")}
      </div>
      ${reg ? `<p class="dex-diag-vazio">Registrado na competência (${numOuTraco(reg.dias)} dia(s)): Sanduíches/Saladas ${numOuTraco(reg.sanduichesSaladas)} · Bebidas ${numOuTraco(reg.bebidas)} · Adicionais ${numOuTraco(reg.adicionais)} · Diversos ${numOuTraco(reg.diversos)}.</p>` : ""}
    </details>`;
}

// Bloqueios que a UI já explica no bloco de classificação — não repetir.
const bloqueioDeAcompanhamento = (b) => /acompanhad[ao] dia a dia|Acompanhamento parcial/i.test(b);

/**
 * @param {object} data prévia do backend (bonifFechamentoMensalPreview).
 * @returns {string}
 */
export function previewMensalHtml(data) {
  if (!data) return "";
  const cls = classificacaoView(data.acompanhamento);
  const val = data.validacao || { bloqueios: [], alertas: [] };
  const label = data.competencia?.label || "";

  const classifBloco = `
    <div class="bm-mensal-classif ${cls.tipo === "ACOMPANHAMENTO_DIARIO" ? "ok" : cls.tipo === "ACOMPANHAMENTO_PARCIAL" ? "warn" : "info"}">
      <b>${escapeHtml(cls.titulo)}</b>
      <p>${escapeHtml(cls.descricao)}</p>
      ${cls.tipo === "ACOMPANHAMENTO_PARCIAL" ? `
        <p>Dias esperados: <b>${cls.diasEsperados}</b> · Dias cobertos: <b>${cls.diasCobertos}</b></p>
        ${cls.pendentes.length ? `<p>Dias pendentes:</p><ul class="bm-mensal-pendentes">${cls.pendentes.map((d) => `<li>${escapeHtml(fmtDataBr(d))}</li>`).join("")}</ul>` : ""}
      ` : ""}
    </div>`;

  // Bloqueios só interessam no caminho do fechamento DIRETO. Em parcial/diário a
  // ação é outra (completar o diário / consolidar) — o bloco de classificação já
  // diz o que fazer; repetir os bloqueios do backend só confunde.
  const bloqueiosVisiveis = cls.tipo === "SEM_ACOMPANHAMENTO"
    ? (val.bloqueios || []).filter((b) => !bloqueioDeAcompanhamento(b))
    : [];
  const bloqueiosBloco = bloqueiosVisiveis.length
    ? `<div class="vd-pv-divs">${bloqueiosVisiveis.map((b) => `<div class="vd-pv-div"><span class="pill bad">bloqueio</span> ${escapeHtml(b)}</div>`).join("")}</div>`
    : "";

  const alertasBloco = (val.alertas || []).length
    ? `<div class="bm-mensal-conferencia"><b>Conferência de importação</b>${(val.alertas || []).map((a) => `<div class="vd-pv-div"><span class="pill ${a.tipo === "critico" ? "bad" : "warn"}">${a.tipo === "critico" ? "atenção" : "conferir"}</span> ${escapeHtml(a.msg || a)}</div>`).join("")}</div>`
    : "";

  // Prévia dos indicadores oficiais: só no fechamento mensal DIRETO. Em
  // acompanhamento diário o congelamento parte do cálculo ao vivo, não do PDF.
  const indicadoresBloco = cls.tipo === "SEM_ACOMPANHAMENTO" ? indicadoresOficiaisHtml(data.resultadoOficial) : "";

  let acaoBotao = "";
  if (cls.acao === "confirmar") {
    acaoBotao = `<div class="ed-acoes"><button class="btn btn-primary" id="bm-mensal-acao" data-acao="confirmar" ${data.prontoParaConfirmar ? "" : "disabled"}>Confirmar fechamento</button></div>`;
  } else if (cls.acao === "consolidar") {
    acaoBotao = `<div class="ed-acoes"><button class="btn btn-primary" id="bm-mensal-acao" data-acao="consolidar">Consolidar acompanhamento diário</button></div>`;
  }

  return `
    <div class="vd-preview">
      <div class="vd-pv-titulo">Fechamento mensal — ${escapeHtml(label)}</div>
      ${classifBloco}
      ${indicadoresBloco}
      ${bloqueiosBloco}
      ${alertasBloco}
      ${conferenciaImportacaoHtml(val.conferencia)}
      ${acaoBotao}
    </div>`;
}
