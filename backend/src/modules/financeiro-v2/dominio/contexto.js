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
  IMPORTAR: "financeiro_v2.importar",
  CONCEDER: "financeiro_v2.conceder",
  // Execução 06D: abrir/baixar o ARQUIVO de um documento do cofre (ver a ficha continua sendo financeiro_v2.ver).
  DOCUMENTOS: "financeiro_v2.documentos",
  // Execução 08B — ações SEPARADAS de decisões sensíveis. Nenhuma concessão anterior as recebe automaticamente
  // (migração restritiva): quem tinha `revisar`, `importar` ou `conceder` precisa de concessão explícita destas.
  APROVAR: "financeiro_v2.aprovar", // aprovar ou rejeitar proposta
  APLICAR: "financeiro_v2.aplicar", // aplicar proposta JÁ aprovada
  REVOGAR: "financeiro_v2.revogar", // revogar permissões (conceder não revoga; revogar não concede)
  CONFIRMAR_IMPORTACAO: "financeiro_v2.confirmar_importacao", // confirmar ou rejeitar importação revisada
  REABRIR: "financeiro_v2.reabrir", // reabrir competência homologada (com justificativa)
  // Execução 08C — mudar a categoria de um lançamento existente. Separada de `corrigir`: nenhuma concessão anterior a recebe.
  RECLASSIFICAR: "financeiro_v2.reclassificar",
  // Execução 08D — ENVIAR evidência pela interface (guardar no cofre e vincular). Não abre arquivos (documentos) nem
  // decide nada financeiro (reclassificar, conciliar, homologar). Nenhuma concessão anterior a recebe.
  ENVIAR_DOCUMENTO: "financeiro_v2.enviar_documento",
  // Execução 08E — VINCULAR uma saída bancária JÁ registrada (extrato) a contas a pagar: baixa sem criar movimento nem
  // despesa. Separada de `registrar` (pagamento novo), `conciliar` e `reclassificar`. Nenhuma concessão anterior a recebe.
  VINCULAR_PAGAMENTO: "financeiro_v2.vincular_pagamento",
  // Execução 17 — registrar o PAGAMENTO de conta a pagar pelo COMPROVANTE, sem movimentação bancária (a conciliação com o
  // extrato fica pendente e se faz depois com `vincular_pagamento`). Nenhuma concessão anterior a recebe.
  BAIXAR_POR_COMPROVANTE: "financeiro_v2.baixar_por_comprovante",
  // Agente 2 (23/11) — registrar CONTA A PAGAR a partir de documento (uma parcela, despesa, com documento). Separada de
  // `registrar` (que também cria movimentação, receita, contas...). Nenhuma concessão anterior a recebe (migração 0030).
  REGISTRAR_OBRIGACAO: "financeiro_v2.registrar_obrigacao",
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
