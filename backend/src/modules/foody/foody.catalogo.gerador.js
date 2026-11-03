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
import { linhasDoPedido, operacoesPorTermo } from "./foody.classificacao.js";

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
