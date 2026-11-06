// Utilitários comuns dos repositórios financeiros: tradução de erros do banco e filtros de escopo (org / org+unidade).
import { ApiError } from "../../../shared/ApiError.js";

export const PAGINA = 1000; // teto do PostgREST por requisição

const NUM = (m) => /(\d+)\s*pendencia/.exec(m)?.[1];
/** Mensagens AMIGÁVEIS por código de regra do banco. Nunca devolvem o texto interno da exceção. */
export const MENSAGENS = Object.freeze({
  FIN_PERIODO_FECHADO: "Este mês está fechado e não aceita alterações. Para corrigir, o período precisa ser reaberto por quem tem autorização.",
  FIN_PERIODO_JA_FECHADO: "Este período já está fechado.",
  FIN_PERIODO_NAO_FECHADO: "Este período não está fechado.",
  FIN_PERIODO_PENDENCIAS: (m) => `Há ${NUM(m) ?? "algumas"} pendência(s) que impedem o fechamento. Resolva-as: fechar com pendências só é possível com uma exceção excepcional, aprovada por SuperAdmin para esta unidade e competência.`,
  FIN_PERIODO_EXCECAO_INSUFICIENTE: "A exceção concedida não cobre todas as pendências atuais do mês (ou já foi usada ou venceu). Nada foi fechado.",
  FIN_EXCECAO_JUSTIFICATIVA_OBRIGATORIA: "Informe a justificativa da exceção (mínimo de 20 caracteres).",
  FIN_EXCECAO_VALIDADE_INVALIDA: "A validade da exceção deve ser de 1 a 30 dias. Exceção permanente não existe.",
  FIN_EXCECAO_SEM_PENDENCIAS: "Não há pendências neste mês para excepcionar.",
  FIN_EXCECAO_IMUTAVEL: "Esta exceção não pode ser alterada, apagada ou reutilizada.",
  FIN_EXCECAO_VIA_FUNCAO: "Esta operação só é permitida pelo fluxo autorizado da exceção.",
  FIN_EXCECAO_MOTIVO_OBRIGATORIO: "Informe o motivo (mínimo de 10 caracteres).",
  FIN_REABERTURA_DESABILITADA: "A reabertura de períodos ainda não foi habilitada.",
  FIN_PERIODO_PENDENCIAS_NAO_RECONHECIDAS: "Há pendências no período: confirme que você as reconhece para fechar.",
  FIN_PERIODO_CONFLITO_DADOS: "Os dados do mês mudaram desde a pré-visualização. Recarregue e confira antes de fechar.",
  FIN_CONCILIACAO_DIVERGENTE: "A conciliação do mês foi recalculada pelo banco e não confere com a pré-visualização. Nada foi fechado: recarregue o pré-fechamento e confira as pendências.",
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
  // Financeiro 2.0 (migration 151): contas a pagar, acréscimos e conciliação de saídas
  FIN2_TRANSICAO_VIA_FUNCAO: "Esta mudança só pode ser feita pela ação própria (quitar, classificar, confirmar ou cancelar).",
  FIN2_CONCILIACAO_VIA_FUNCAO: "A conciliação só é confirmada por uma pessoa, pela ação «Confirmar». Nada foi conciliado automaticamente.",
  FIN2_ESTADO_INICIAL_INVALIDO: "O registro precisa começar em aberto, sem classificação.",
  FIN2_OBRIGACAO_NAO_ABERTA: "Esta conta já está quitada ou cancelada. Para alterar pagamentos, desfaça a quitação antes.",
  FIN2_OBRIGACAO_NAO_QUITADA: "Só uma conta quitada tem diferença a classificar.",
  FIN2_OBRIGACAO_QUITADA: "Esta conta está quitada: desfaça a quitação antes de alterar valor, competência ou categoria.",
  FIN2_OBRIGACAO_CANCELADA_IMUTAVEL: "Esta conta foi cancelada e não pode ser alterada.",
  FIN2_OBRIGACAO_COM_PAGAMENTO: "Cancele os pagamentos desta conta antes de cancelá-la.",
  FIN2_QUITACAO_SEM_PAGAMENTO: "Registre ao menos um pagamento antes de quitar a conta.",
  FIN2_SEM_DIFERENCA: "O total pago é igual ao valor original: não há diferença a classificar.",
  FIN2_CLASSIFICACAO_INCOMPATIVEL: "Classificação incompatível: acréscimo aceita juros, multa, tarifa ou outro; pagamento a menor aceita apenas desconto.",
  FIN2_MOTIVO_OBRIGATORIO: "Informe o motivo (mínimo de 10 caracteres).",
  FIN2_PAGAMENTO_CANCELADO_IMUTAVEL: "Este pagamento foi cancelado e não pode ser alterado.",
  FIN2_PAGAMENTO_VINCULADO: "Este pagamento está vinculado a uma saída do extrato. Desfaça o vínculo antes de alterá-lo ou cancelá-lo.",
  FIN2_LANCAMENTO_VINCULADO: "Esta saída do extrato está vinculada a pagamento(s). Desfaça o vínculo antes de alterá-la.",
  FIN2_LANCAMENTO_NAO_E_SAIDA: "Só saídas realizadas do extrato podem ser conciliadas com pagamentos.",
  FIN2_LANCAMENTO_TRANSFERENCIA: "Transferência entre contas não é pagamento de conta: não pode ser vinculada.",
  FIN2_ALOCACAO_EXCEDIDA: "Este pagamento (ou esta saída) já está vinculado a outro registro.",
  FIN2_ALOCACAO_PARCIAL: "Cada pagamento entra no vínculo pelo valor integral. Um pagamento feito em duas saídas deve ser registrado como dois pagamentos.",
  FIN2_ISOLAMENTO_INVALIDO: "Operação recusada: nível de isolamento da transação não suportado.",
  FIN2_SAIDA_JA_VINCULADA: "Esta saída do extrato já está vinculada a outro grupo de pagamentos. Desfaça ou rejeite o outro vínculo antes.",
  FIN2_QUITACAO_EM_MES_FECHADO: "Esta alteração deixaria a conta paga por inteiro com o último pagamento num mês fechado, e ela não poderia mais ser quitada. Nada foi alterado.",
  FIN2_CAMPO_VIA_FUNCAO: "A evidência e a autoria da conciliação só são gravadas pelas ações de confirmar ou desfazer.",
  FIN2_JUSTIFICATIVA_OBRIGATORIA: "A diferença de valor ou de data está fora da tolerância (R$ 0,01 e 1 dia): informe a justificativa (mínimo de 10 caracteres).",
  FIN2_GRUPO_INVALIDO: "Um vínculo concilia exatamente uma saída do extrato.",
  FIN2_TRANSICAO_INVALIDA: "Esta mudança de situação do vínculo não é permitida.",
  FIN2_VINCULO_ENCERRADO_IMUTAVEL: "Este vínculo foi rejeitado ou revogado e não pode ser alterado.",
  FIN2_DIVERGENCIAS_BLOQUEADORAS: (m) => `Há ${/(\d+)\s*divergencia/.exec(m)?.[1] ?? "algumas"} divergência(s) de contas a pagar ou de conciliação de saídas que impedem o fechamento. Resolva-as antes de fechar.`,
});
const GENERICA = "A operação foi recusada pelas regras de integridade financeira. Nada foi alterado.";
// códigos que indicam "não existe neste contexto" (inclusive de outro tenant) → 404, sem diferenciar o motivo
const NAO_ENCONTRADO = new Set(["FIN_TRANSFERENCIA_NAO_ENCONTRADA", "FIN_PERIODO_NAO_ENCONTRADO", "FIN_IMPORTACAO_NAO_ENCONTRADA", "FIN2_OBRIGACAO_NAO_ENCONTRADA", "FIN2_VINCULO_NAO_ENCONTRADO"]);

/** Traduz erro do banco em ApiError. Conflitos de período (concorrência) → 409; "não encontrado" → 404; regras de integridade → 400. */
export const falha = (error) => {
  if (!error) return;
  const msg = String(error.message ?? "");
  const codigo = (/^(fin2?_[a-z_]+)/.exec(msg)?.[1] ?? "INTEGRIDADE").toUpperCase();
  const m = MENSAGENS[codigo];
  const texto = typeof m === "function" ? m(msg) : (m ?? GENERICA);
  if (/^fin_(periodo_conflito|conciliacao_divergente)/.test(msg)) throw new ApiError(409, texto, { codigo });   // M1: divergência banco × aplicação = conflito de estado (recarregar), nunca fecha
  if (NAO_ENCONTRADO.has(codigo)) throw ApiError.notFound("Registro não encontrado.", { codigo });
  if (error.code === "23505") throw ApiError.badRequest("Registro duplicado.", { codigo: "DUPLICADO" });
  if (error.code === "P0002") throw ApiError.notFound("Registro não encontrado.", { codigo: codigo === "INTEGRIDADE" ? "NAO_ENCONTRADO" : codigo });
  if (["23514", "23502", "23503"].includes(error.code)) throw ApiError.badRequest(texto, { codigo });
  throw ApiError.internal("Falha ao acessar os dados financeiros.");
};

export const org = (q, ctx) => q.eq("organizacao_id", ctx.organizacaoId);
export const unid = (q, ctx) => q.eq("organizacao_id", ctx.organizacaoId).eq("unidade_id", ctx.unidadeId);
