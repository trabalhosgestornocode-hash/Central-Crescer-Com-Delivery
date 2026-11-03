// Classificação de operação para a CONEXÃO COMPARTILHADA (Subway Saci + Açaí no Grau Saci na mesma conta Foody).
// Funções PURAS. Não substitui o Parser (que segue com classificarOperacao e "sem termo = Subway"): só vale quando a conexão
// tem destino ATIVO e a flag de compartilhamento está ligada.
//
// Regra (estrita — a triagem é o padrão, nunca a Subway):
//   * o pedido é quebrado em LINHAS DE ITEM (produto e complementos), normalizadas;
//   * cada linha precisa de evidência própria:
//       - CATÁLOGO: a linha inteira está no catálogo versionado de UMA operação (foody.catalogo-operacao.js), ou
//       - TERMO VALIDADO: a linha contém um termo validado de UMA operação (lista curta, abaixo);
//   * linha SEM evidência (produto/complemento desconhecido) → o pedido inteiro vai para TRIAGEM, mesmo que as outras linhas
//     sejam conhecidas (um item novo do Açaí junto de um sanduíche não pode levar dado do Açaí para a Subway);
//   * evidências de operações diferentes (no pedido ou na mesma linha) → TRIAGEM por CONFLITO;
//   * pedido sem linha → TRIAGEM por SEM_EVIDENCIA.
// Comparação de LINHA INTEIRA, nunca de palavra solta: "gotas de chocolate" é cobertura no Açaí e sabor de cookie na Subway.
// O catálogo NÃO aprende em produção: só muda por PR (nova versão + teste de regressão com o hash).
import { CATALOGO_OPERACAO } from "./foody.catalogo-operacao.js";

export const OPERACAO_COMPARTILHADA = Object.freeze({ SUBWAY: "subway", ACAI_NO_GRAU: "acai_no_grau" });
export const RESULTADO_TRIAGEM = "triagem";
/** Versão do catálogo em uso (vai para cada linha classificada e cada decisão de triagem). */
export const CATALOGO_VERSAO = CATALOGO_OPERACAO.versao;
export const MOTIVO_TRIAGEM = Object.freeze({
  ITEM_DESCONHECIDO: "ITEM_DESCONHECIDO",
  CONFLITO: "CONFLITO",
  SEM_EVIDENCIA: "SEM_EVIDENCIA",
});

/**
 * Termos VALIDADOS (evidência independente do catálogo), por operação. Lista curta e explícita — cada termo com a origem.
 * Casamento por palavra inteira, sem acento/caixa.
 */
export const TERMOS_VALIDADOS = Object.freeze({
  acai_no_grau: Object.freeze([
    Object.freeze({ termo: "acai", origem: "nome da operação; 0 ocorrências em pedidos Subway no histórico (15.330 pedidos)" }),
    Object.freeze({ termo: "paleta", origem: "confirmado pelo responsável em 03/11/2026: paletas são só do Açaí" }),
  ]),
  subway: Object.freeze([
    Object.freeze({ termo: "subway", origem: "nome da operação; 0 ocorrências em pedidos Açaí no histórico" }),
  ]),
});

const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Normaliza UMA linha de item: sem quantidade inicial ("2x"), sem acento/caixa, tamanhos/preços genéricos, espaços simples. */
export function normalizarLinhaItem(linha) {
  return semAcento(linha).toLowerCase()
    .replace(/^\s*\d+\s*x\s*/, "")
    .replace(/\(?\d+\s*(ml|g|cm|l)\)?/g, "#$1")
    .replace(/r\$\s*[\d.,]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Linhas de item distintas do texto `orderDetails` (uma por quebra de linha). */
export function linhasDoPedido(detalhes) {
  return [...new Set(String(detalhes ?? "").split(/\r?\n/).map(normalizarLinhaItem).filter(Boolean))];
}

const regexTermo = (t) => new RegExp(`(^|[^a-z0-9])${t}($|[^a-z0-9])`);
const TERMOS_RE = Object.entries(TERMOS_VALIDADOS).map(([op, lista]) => [op, lista.map((x) => regexTermo(x.termo))]);

function criarIndice(catalogo) {
  const indice = new Map();
  for (const [op, linhas] of Object.entries(catalogo.linhas)) for (const l of linhas) indice.set(l, op);
  return indice;
}
const INDICE_PADRAO = criarIndice(CATALOGO_OPERACAO);

/** Operações cujos termos validados aparecem na linha (normalizada). */
export function operacoesPorTermo(linhaNormalizada) {
  return TERMOS_RE.filter(([, res]) => res.some((re) => re.test(linhaNormalizada))).map(([op]) => op);
}

/**
 * @param {string|null} detalhes texto `orderDetails` do pedido
 * @param {{catalogo?: object}} [opcoes] catálogo alternativo (só testes/avaliação)
 * @returns {{ operacao: 'subway'|'acai_no_grau'|'triagem', motivo: string|null, linhas: number, desconhecidas: number,
 *   evidencias: {catalogo:number, termo:number}, catalogoVersao: string }}
 */
export function classificarPedidoCompartilhado(detalhes, opcoes = {}) {
  const catalogo = opcoes.catalogo ?? CATALOGO_OPERACAO;
  const indice = opcoes.catalogo ? criarIndice(catalogo) : INDICE_PADRAO;
  const linhas = linhasDoPedido(detalhes);
  const votos = new Set();
  let desconhecidas = 0, porCatalogo = 0, porTermo = 0, conflitoNaLinha = false;
  for (const l of linhas) {
    const ops = new Set();
    if (indice.has(l)) { ops.add(indice.get(l)); porCatalogo++; }
    const termos = operacoesPorTermo(l);
    if (termos.length) { for (const o of termos) ops.add(o); porTermo++; }
    if (ops.size === 0) { desconhecidas++; continue; }
    if (ops.size > 1) conflitoNaLinha = true;
    for (const o of ops) votos.add(o);
  }
  const base = { linhas: linhas.length, desconhecidas, evidencias: { catalogo: porCatalogo, termo: porTermo }, catalogoVersao: catalogo.versao };
  if (linhas.length === 0) return { operacao: RESULTADO_TRIAGEM, motivo: MOTIVO_TRIAGEM.SEM_EVIDENCIA, ...base };
  if (conflitoNaLinha || votos.size > 1) return { operacao: RESULTADO_TRIAGEM, motivo: MOTIVO_TRIAGEM.CONFLITO, ...base };
  if (desconhecidas > 0) return { operacao: RESULTADO_TRIAGEM, motivo: MOTIVO_TRIAGEM.ITEM_DESCONHECIDO, ...base };
  return { operacao: [...votos][0], motivo: null, ...base };
}
