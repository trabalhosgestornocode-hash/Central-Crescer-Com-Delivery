// Contexto e autorização do Financeiro v2.
//
// O contexto (organização, unidade, usuário, permissões) é montado por um ADAPTADOR confiável a partir da sessão
// autenticada — nunca a partir de dados enviados pelo cliente. O núcleo só o valida e o aplica; falha fechada.
// Catálogo de ações PRÓPRIO (`financeiro_v2.*`): não herda nada do financeiro anterior nem de papéis administrativos.
import { CODIGO, falhar } from "./erros.js";
import { ehUuid } from "./validacao.js";

export const ACAO = Object.freeze({
  VER: "financeiro_v2.ver",
  REGISTRAR: "financeiro_v2.registrar",
  CORRIGIR: "financeiro_v2.corrigir",
  CANCELAR: "financeiro_v2.cancelar",
  CONCILIAR: "financeiro_v2.conciliar",
  FECHAR: "financeiro_v2.fechar",
  HOMOLOGAR: "financeiro_v2.homologar",
  REVISAR: "financeiro_v2.revisar",
  CONFIGURAR: "financeiro_v2.configurar",
});
const ACOES = Object.freeze(Object.values(ACAO));

/**
 * @typedef {{organizacaoId:string, unidadeId:string, usuarioId:string, permissoes:readonly string[]}} ContextoFinanceiro
 */

/** @returns {Readonly<ContextoFinanceiro>} */
export function exigirContexto(ctx) {
  if (!ctx || typeof ctx !== "object" || !ehUuid(ctx.organizacaoId) || !ehUuid(ctx.unidadeId) || !ehUuid(ctx.usuarioId)) {
    falhar(CODIGO.CONTEXTO_INVALIDO, "Contexto financeiro ausente ou inválido.");
  }
  const permissoes = Array.isArray(ctx.permissoes) ? ctx.permissoes.filter((p) => ACOES.includes(p)) : [];
  return Object.freeze({
    organizacaoId: ctx.organizacaoId.toLowerCase(),
    unidadeId: ctx.unidadeId.toLowerCase(),
    usuarioId: ctx.usuarioId.toLowerCase(),
    permissoes: Object.freeze([...new Set(permissoes)]),
  });
}

export function autorizar(ctx, acao) {
  if (!ACOES.includes(acao) || !ctx.permissoes.includes(acao)) {
    falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Permissão financeira insuficiente para esta operação.", { acao });
  }
}

/**
 * Lista explícita dos pares organização+unidade em que o núcleo pode operar. Lista vazia = nada opera (falha fechada).
 * Os identificadores reais vêm de configuração no momento da montagem; não ficam no código.
 * @param {Array<{organizacaoId:string, unidadeId:string}>} escoposAutorizados
 */
export function criarPoliticaDeEscopo(escoposAutorizados) {
  if (!Array.isArray(escoposAutorizados) || escoposAutorizados.length === 0 || escoposAutorizados.some((e) => !ehUuid(e?.organizacaoId) || !ehUuid(e?.unidadeId))) {
    falhar(CODIGO.ESCOPO_NAO_AUTORIZADO, "O núcleo financeiro exige ao menos um escopo (organização + unidade) autorizado.");
  }
  const chaves = new Set(escoposAutorizados.map((e) => `${e.organizacaoId.toLowerCase()}|${e.unidadeId.toLowerCase()}`));
  return Object.freeze({
    exigir(ctx) {
      if (!chaves.has(`${ctx.organizacaoId}|${ctx.unidadeId}`)) {
        falhar(CODIGO.ESCOPO_NAO_AUTORIZADO, "Organização/unidade fora do escopo autorizado do Financeiro v2.");
      }
    },
  });
}
