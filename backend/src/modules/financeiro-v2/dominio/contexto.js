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
  // 23/11 — registrar o ENCARGO (juros/multa) de uma conta a pagar JUNTO com o pagamento por comprovante. Estreita: só vale em
  // conjunto com `baixar_por_comprovante`, só quita a conta, com teto de 10% do valor da conta e a categoria oficial de juros e
  // multas. NÃO é `corrigir` (que altera qualquer título). Nenhuma concessão anterior a recebe (migração 0031).
  REGISTRAR_JUROS: "financeiro_v2.registrar_juros",
  // 25/11 — PRESTAR CONTAS DE UMA SANGRIA EXISTENTE (MOVA CORE §12): despesa paga com o dinheiro da retirada (liquidada contra a
  // PRÓPRIA saída da sangria), prestação parcial, troco devolvido ao mesmo caixa e o pendente. NÃO é `registrar` (sem saída nova,
  // pagamento, transferência, receita ou conta existente). Nenhuma concessão anterior a recebe (migração 0032).
  PRESTAR_SANGRIA: "financeiro_v2.prestar_sangria",
  // 26/11 — registrar CONTA A PAGAR RELATADA (sem documento) em 1 a 24 parcelas com vencimentos explícitos; nunca paga, nunca
  // receita, sem movimentação nem liquidação. Nenhuma concessão anterior a recebe (migração 0033).
  REGISTRAR_CONTA_PARCELADA: "financeiro_v2.registrar_conta_parcelada",
  // 26/11 — OPERAÇÃO ENTRE EMPRESAS do grupo (uma empresa paga a conta da outra): passivo na devedora, ativo na credora, ligados
  // por um vínculo único; liquida a conta da devedora sem saída bancária nela; reembolso parcial/total. Migração 0034.
  REGISTRAR_INTERCOMPANY: "financeiro_v2.registrar_intercompany",
  // 27/11 — PRINCIPAL DE EMPRÉSTIMO/FINANCIAMENTO (fora da DRE). Não grava nada sozinha: COMPLEMENTA as estreitas de conta
  // (registrar_conta_parcelada, registrar_obrigacao + baixar_por_comprovante) aceitando só a categoria EMPRESTIMOS_E_FINANCIAMENTOS.
  // Nunca lucros, aportes/retiradas, entre empresas, terceiros ou outra patrimonial. Migração 0035.
  REGISTRAR_EMPRESTIMO: "financeiro_v2.registrar_emprestimo",
  // 28/11 — CORREÇÃO CADASTRAL de conta a pagar (fornecedor, vencimento, descrição, observação, forma de pagamento): só conta
  // aberta, sem pagamento, de despesa/equipamento e de período editável. NÃO é `corrigir` (ampla). Migração 0036.
  CORRIGIR_CONTA_A_PAGAR: "financeiro_v2.corrigir_conta_a_pagar",
  // 28/11 — FASE 2 (migração 0037): operações ESTREITAS de conta a pagar existente de despesa/equipamento, período aberto/preliminar.
  // NÃO são `reclassificar`/`corrigir`/`cancelar` (amplas). Pagamento, ajuste prévio ou parcela cancelada que torne ambíguo ⇒ revisão humana.
  RECLASSIFICAR_CONTA_A_PAGAR: "financeiro_v2.reclassificar_conta_a_pagar",       // categoria da compra inteira
  AJUSTAR_CONTA_A_PAGAR: "financeiro_v2.ajustar_conta_a_pagar",                   // valor correto ⇒ ajuste documentado (nunca sobrescreve)
  MOVER_COMPETENCIA_CONTA_A_PAGAR: "financeiro_v2.mover_competencia_conta_a_pagar", // competência da compra entre períodos abertos
  CANCELAR_CONTA_A_PAGAR: "financeiro_v2.cancelar_conta_a_pagar",                 // compra inteira ou uma parcela (com ajuste auditado)
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
