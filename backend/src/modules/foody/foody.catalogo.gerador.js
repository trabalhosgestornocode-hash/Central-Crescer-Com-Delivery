// Geração OFFLINE do catálogo de linhas por operação (função PURA). Nunca roda em produção: o resultado vira o arquivo
// versionado foody.catalogo-operacao.js por PR, com teste de regressão do hash.
//
// Rótulo de treino: a operação que a regra do Parser (classificarOperacao) dá ao pedido POR TERMO — só entram pedidos com
// termo de UMA operação (sem termo, em revisão ou misturados ficam fora). Uma linha entra no catálogo de uma operação quando:
//   * aparece em pedidos de UMA só operação (linha vista nas duas é descartada e contada);
//   * foi vista >= `minimoOcorrencias` vezes em >= `minimoDias` dias distintos (corta texto livre e digitação única);
//   * não parece texto livre/dado pessoal (filtro abaixo) e não contém termo validado da OUTRA operação.
import { createHash } from "node:crypto";
import { classificarOperacao } from "../parser-food-delivery/parserFoodDelivery.operacao.js";
import { linhasDoPedido, operacoesPorTermo, normalizarLinhaItem } from "./foody.classificacao.js";

const PARECE_TEXTO_LIVRE = /@|\d{5,}|\b(obs|observ\w*|rua|avenida|av|apto|apartamento|bloco|casa|condominio|troco|cpf|cartao|pix|telefone|whats\w*|zap|entregar|entregador|portao|campainha|teste|favor|por favor|obrigad\w*|cliente)\b/;

export function pareceTextoLivre(linha) {
  return linha.length > 120 || PARECE_TEXTO_LIVRE.test(linha);
}

/** Hash estável do conteúdo do catálogo (linhas + termos). Muda com qualquer linha. */
export function hashCatalogo(linhas) {
  const canonico = JSON.stringify(Object.keys(linhas).sort().map((op) => [op, [...linhas[op]].sort()]));
  return createHash("sha256").update(canonico).digest("hex");
}

/**
 * @param {Array<{detalhes:string, dia?:string}>} pedidos  texto de itens + dia (AAAA-MM-DD) do pedido
 * @param {{minimoOcorrencias?:number, minimoDias?:number}} [opcoes]
 */
export function gerarCatalogo(pedidos, { minimoOcorrencias = 2, minimoDias = 2 } = {}) {
  const cont = new Map();
  const estat = { pedidos: 0, treino: 0, semTermoOuRevisao: 0, linhasVistasNasDuas: 0, descartadasTextoLivre: 0, descartadasRaras: 0,
    descartadasTermoDaOutra: 0 };
  for (const p of pedidos) {
    estat.pedidos++;
    const r = classificarOperacao({ detalhesPedido: p.detalhes });
    if (r.termosEncontrados.length === 0 || (r.operacao !== "subway" && r.operacao !== "acai_no_grau")) { estat.semTermoOuRevisao++; continue; }
    estat.treino++;
    for (const l of linhasDoPedido(p.detalhes)) {
      const x = cont.get(l) ?? { subway: 0, acai_no_grau: 0, dias: new Set() };
      x[r.operacao]++; if (p.dia) x.dias.add(p.dia); cont.set(l, x);
    }
  }
  const linhas = { subway: [], acai_no_grau: [] };
  for (const [l, x] of cont) {
    if (x.subway && x.acai_no_grau) { estat.linhasVistasNasDuas++; continue; }
    const op = x.subway ? "subway" : "acai_no_grau";
    if (x[op] < minimoOcorrencias || x.dias.size < minimoDias) { estat.descartadasRaras++; continue; }
    if (pareceTextoLivre(l)) { estat.descartadasTextoLivre++; continue; }
    if (operacoesPorTermo(l).some((o) => o !== op)) { estat.descartadasTermoDaOutra++; continue; }
    linhas[op].push(l);
  }
  for (const op of Object.keys(linhas)) linhas[op].sort();
  return { linhas, hash: hashCatalogo(linhas), estatisticas: { ...estat, subway: linhas.subway.length, acai_no_grau: linhas.acai_no_grau.length },
    parametros: { minimoOcorrencias, minimoDias } };
}

/**
 * Junta as linhas VALIDADAS À MÃO (foody.catalogo-validadas.js) às linhas geradas. Função PURA; lança erro (nunca ignora) se uma
 * validada não estiver normalizada, parecer texto livre, trouxer termo da outra operação ou já existir no catálogo da outra.
 * @param {{subway:string[], acai_no_grau:string[]}} linhas
 * @param {ReadonlyArray<{operacao:string, linha:string, evidencia:string, validadoEm:string}>} validadas
 */
export function incluirValidadas(linhas, validadas) {
  const saida = Object.fromEntries(Object.entries(linhas).map(([op, l]) => [op, [...l]]));
  let incluidas = 0, jaPresentes = 0;
  for (const v of validadas) {
    const op = v.operacao, l = v.linha;
    if (!Object.hasOwn(saida, op)) throw new Error(`validada com operação desconhecida: ${op}`);
    if (normalizarLinhaItem(l) !== l) throw new Error(`validada não normalizada: ${l}`);
    if (pareceTextoLivre(l)) throw new Error(`validada parece texto livre: ${l}`);
    if (operacoesPorTermo(l).some((o) => o !== op)) throw new Error(`validada com termo de outra operação: ${l}`);
    if (!(String(v.evidencia ?? "").length > 20) || !/^\d{4}-\d{2}-\d{2}$/.test(String(v.validadoEm ?? ""))) throw new Error(`validada sem evidência/data: ${l}`);
    for (const [outra, ls] of Object.entries(saida)) if (outra !== op && ls.includes(l)) throw new Error(`validada já está no catálogo de ${outra}: ${l}`);
    if (saida[op].includes(l)) { jaPresentes++; continue; }
    saida[op].push(l); incluidas++;
  }
  for (const op of Object.keys(saida)) saida[op].sort();
  return { linhas: saida, hash: hashCatalogo(saida), incluidas, jaPresentes };
}

/** Texto do arquivo versionado foody.catalogo-operacao.js (função PURA; quem grava é o script offline). */
export function renderizarCatalogo(corpo) {
  return `// GERADO por scripts/foody-gerar-catalogo.mjs / scripts/foody-catalogo-incluir-validadas.mjs — NÃO editar à mão.
// Catálogo VERSIONADO de linhas de item por operação. Mudança só por PR: gerar de novo com --versao nova e registrar o hash em
// test/foody-compartilhada-catalogo.test.js. Linhas validadas à mão ficam em foody.catalogo-validadas.js (com a evidência).
// Conteúdo: nomes de produto/complemento do cardápio (sem dado de cliente).
const congelar = (o) => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.freeze(v)])));
const C = ${JSON.stringify(corpo, null, 2)};
export const CATALOGO_OPERACAO = Object.freeze({ ...C, origem: Object.freeze(C.origem), termosValidados: congelar(C.termosValidados), linhas: congelar(C.linhas) });
`;
}
