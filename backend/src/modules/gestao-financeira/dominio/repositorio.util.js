// Utilitários comuns dos repositórios financeiros: tradução de erros do banco e filtros de escopo (org / org+unidade).
import { ApiError } from "../../../shared/ApiError.js";

export const PAGINA = 1000; // teto do PostgREST por requisição

const NUM = (m) => /(\d+)\s*pendencia/.exec(m)?.[1];
/** Mensagens AMIGÁVEIS por código de regra do banco. Nunca devolvem o texto interno da exceção. */
export const MENSAGENS = Object.freeze({
  FIN_PERIODO_FECHADO: "Este mês está fechado e não aceita alterações. Para corrigir, o período precisa ser reaberto por quem tem autorização.",
  FIN_PERIODO_JA_FECHADO: "Este período já está fechado.",
  FIN_PERIODO_NAO_FECHADO: "Este período não está fechado.",
  FIN_PERIODO_PENDENCIAS: (m) => `Há ${NUM(m) ?? "algumas"} pendência(s) que impedem o fechamento. Resolva-as ou, se a política da unidade permitir, feche reconhecendo as pendências.`,
  FIN_PERIODO_PENDENCIAS_NAO_RECONHECIDAS: "Há pendências no período: confirme que você as reconhece para fechar.",
  FIN_PERIODO_CONFLITO_DADOS: "Os dados do mês mudaram desde a pré-visualização. Recarregue e confira antes de fechar.",
  FIN_PERIODO_CONFLITO_VERSAO: "O período foi alterado por outra operação. Recarregue a tela e tente novamente.",
  FIN_PERIODO_MOTIVO_OBRIGATORIO: "Informe o motivo (mínimo de 10 caracteres).",
  FIN_PERIODO_TRANSICAO_INVALIDA: "Esta mudança de situação do período não é permitida.",
  FIN_PERIODO_FECHAMENTO_INCOMPLETO: "O fechamento exige responsável, data e snapshot.",
  FIN_PERIODO_MES_INVALIDO: "Mês inválido.",
  FIN_SNAPSHOT_IMUTAVEL: "O snapshot de um período fechado não pode ser alterado.",
  FIN_TRANSFERENCIA_VINCULADA: "Este lançamento faz parte de uma transferência vinculada. Use «Cancelar transferência» para cancelar as duas pernas, ou «Desvincular» se o pareamento estiver errado.",
  FIN_TRANSFERENCIA_CANCELADA_IMUTAVEL: "Esta transferência já foi cancelada e não pode ser alterada.",
  FIN_TRANSFERENCIA_MOTIVO_OBRIGATORIO: "Informe o motivo (mínimo de 10 caracteres).",
  FIN_TRANSFERENCIA_ESTADO_INCONSISTENTE: "Esta transferência está em um estado que exige revisão manual. Nada foi alterado.",
  FIN_TRANSFERENCIA_NAO_CANCELAVEL: "Esta transferência não pode ser cancelada agora: as duas pernas precisam estar realizadas. Nada foi alterado.",
  FIN_TRANSFERENCIA_PARCIAL: "Uma transferência só pode ser cancelada por inteiro. Nada foi alterado.",
  FIN_PAR_INVALIDO: "As duas pernas não formam um par válido (mesmo valor, sentidos opostos, contas diferentes e categoria de transferência).",
  FIN_PAPEL_EM_USO: "Esta categoria já possui lançamentos: o papel não pode ser trocado. Crie outra categoria e reclassifique com motivo.",
  FIN_CAMPO_IMUTAVEL: "Este campo não pode ser alterado.",
  FIN_ESCOPO_INVALIDO: "O registro informado não pertence a este contexto.",
  FIN_IMPORTACAO_ESTADO_INVALIDO: "A importação não está mais em estado de prévia.",
  FIN_AUDITORIA_E_IMUTAVEL: "A trilha de auditoria não pode ser alterada.",
});
const GENERICA = "A operação foi recusada pelas regras de integridade financeira. Nada foi alterado.";
// códigos que indicam "não existe neste contexto" (inclusive de outro tenant) → 404, sem diferenciar o motivo
const NAO_ENCONTRADO = new Set(["FIN_TRANSFERENCIA_NAO_ENCONTRADA", "FIN_PERIODO_NAO_ENCONTRADO", "FIN_IMPORTACAO_NAO_ENCONTRADA"]);

/** Traduz erro do banco em ApiError. Conflitos de período (concorrência) → 409; "não encontrado" → 404; regras de integridade → 400. */
export const falha = (error) => {
  if (!error) return;
  const msg = String(error.message ?? "");
  const codigo = (/^(fin_[a-z_]+)/.exec(msg)?.[1] ?? "INTEGRIDADE").toUpperCase();
  const m = MENSAGENS[codigo];
  const texto = typeof m === "function" ? m(msg) : (m ?? GENERICA);
  if (/^fin_periodo_conflito/.test(msg)) throw new ApiError(409, texto, { codigo });
  if (NAO_ENCONTRADO.has(codigo)) throw ApiError.notFound("Registro não encontrado.", { codigo });
  if (error.code === "23505") throw ApiError.badRequest("Registro duplicado.", { codigo: "DUPLICADO" });
  if (error.code === "P0002") throw ApiError.notFound("Registro não encontrado.", { codigo: codigo === "INTEGRIDADE" ? "NAO_ENCONTRADO" : codigo });
  if (["23514", "23502", "23503"].includes(error.code)) throw ApiError.badRequest(texto, { codigo });
  throw ApiError.internal("Falha ao acessar os dados financeiros.");
};

export const org = (q, ctx) => q.eq("organizacao_id", ctx.organizacaoId);
export const unid = (q, ctx) => q.eq("organizacao_id", ctx.organizacaoId).eq("unidade_id", ctx.unidadeId);
