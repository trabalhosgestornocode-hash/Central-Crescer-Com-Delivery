// Peças comuns aos adaptadores de fonte.
//
// COMPATIBILIDADE de cada adaptador (honesta, conferida no relatório da Execução 02):
//   AMOSTRA_REAL → o formato foi conferido contra um arquivo real exportado pela fonte;
//   SINTETICA    → o contrato foi escrito a partir da descrição dos campos e testado só com arquivos sintéticos.
//                  Um arquivo real que não bata com as colunas é REJEITADO com "formato não reconhecido" — nunca
//                  interpretado por suposição.
import { rotulo } from "../leitor.js";

export const COMPATIBILIDADE = Object.freeze({ AMOSTRA_REAL: "AMOSTRA_REAL", SINTETICA: "SINTETICA" });

export const col = (rotulos, obrigatorio = true) => Object.freeze({ rotulos: Object.freeze(rotulos), obrigatorio });

/** Primeiro padrão que casa com o texto (rótulo normalizado) → código; nenhum → null. */
export function classificarPorPalavras(texto, regras) {
  const r = rotulo(texto);
  for (const [codigo, padroes] of regras) if (padroes.some((p) => (p instanceof RegExp ? p.test(r) : r.includes(p)))) return codigo;
  return null;
}

/** Forma de pagamento como DIMENSÃO própria (nunca é canal). */
export function formaDePagamento(texto) {
  return classificarPorPalavras(texto, [
    ["MULTIPLAS", ["multipl", "mais de uma", "misto"]],
    ["DINHEIRO", ["dinheiro", "especie"]],
    ["PIX", ["pix"]],
    ["DEBITO", ["debito"]],
    ["CREDITO", ["credito"]],
    ["VALE", ["vale", "voucher", "refeicao", "alimentacao"]],
    ["ONLINE_PLATAFORMA", ["pago online", "online", "pagamento pelo app"]],
  ]);
}

/** `formatosHomologados`: formatos conferidos com arquivo REAL. Nos demais formatos o leitor continua SINTÉTICO. */
export function definirFonte(def) {
  const formatosHomologados = Object.freeze([...(def.formatosHomologados ?? [])]);
  return Object.freeze({
    formatos: Object.freeze(["csv", "xlsx"]), ...def, formatosHomologados,
    compatibilidade: formatosHomologados.length ? COMPATIBILIDADE.AMOSTRA_REAL : COMPATIBILIDADE.SINTETICA,
  });
}
export const compatibilidadeNoFormato = (adaptador, formato) => (adaptador.formatosHomologados.includes(formato) ? COMPATIBILIDADE.AMOSTRA_REAL : COMPATIBILIDADE.SINTETICA);
