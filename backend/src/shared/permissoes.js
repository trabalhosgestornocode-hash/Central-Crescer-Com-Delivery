// Permissões efetivas por papel, POR EMPRESA.
//
// O papel não pertence ao usuário global: pertence ao vínculo usuário<->empresa
// (usuarios_organizacoes.papel). O mesmo João pode ser organization_admin na
// Subway Saci e finance na Subway Fortaleza — e é este mapa que traduz cada
// um desses papéis em permissões concretas.
//
// As permissões são gravadas na sessão (sessoes_contexto.permissoes) no momento
// da seleção da empresa, e é a linha da sessão que o middleware relê. Mudar um
// papel no painel, portanto, exige revogar as sessões daquele vínculo — o
// módulo de plataforma faz isso.

/**
 * @typedef {'platform_superadmin'|'organization_admin'|'unit_manager'|'finance'|'operations'|'viewer'} PapelAcesso
 */

/** Todas as permissões conhecidas. Fonte única — use estas constantes. */
export const PERMISSOES = {
  DASHBOARD_VER: "dashboard.ver",
  PRODUTOS_VER: "produtos.ver",
  PRODUTOS_EDITAR: "produtos.editar",
  INSUMOS_VER: "insumos.ver",
  INSUMOS_EDITAR: "insumos.editar",
  CMV_VER: "cmv.ver",
  VENDAS_VER: "vendas.ver",
  VENDAS_IMPORTAR: "vendas.importar",
  VENDAS_EDITAR: "vendas.editar",
  INTEGRACOES_VER: "integracoes.ver",
  INTEGRACOES_GERENCIAR: "integracoes.gerenciar",
  USUARIOS_VER: "usuarios.ver",
  USUARIOS_GERENCIAR: "usuarios.gerenciar",
  CONFIG_VER: "configuracoes.ver",
  CONFIG_GERENCIAR: "configuracoes.gerenciar",
  FINANCEIRO_VER: "financeiro.ver",
  // Dashboard Executivo (lançamento financeiro diário por unidade).
  DASHBOARD_EXECUTIVO_VER: "dashboard_executivo.ver",
  // Criar lançamento novo + editar livremente enquanto status = 'rascunho'.
  DASHBOARD_EXECUTIVO_LANCAR: "dashboard_executivo.lancar",
  // Editar um lançamento JÁ FINALIZADO (sempre com motivo + auditoria) e
  // lançar valor negativo em "outras deduções" (ajuste a favor da unidade).
  DASHBOARD_EXECUTIVO_CORRIGIR: "dashboard_executivo.corrigir",
  // Trocar o modelo logístico do iFood da unidade (Marketplace/Full Service).
  // unit_manager NÃO tem — só vê o modelo (via DASHBOARD_EXECUTIVO_VER).
  DASHBOARD_EXECUTIVO_CONFIGURAR: "dashboard_executivo.configurar",
  // Resetar (excluir de verdade) o lançamento de um dia — SÓ funciona em
  // unidade marcada como `eh_teste = true` (o service revalida isso sempre,
  // mesmo com a permissão concedida). Nunca disponível em unidade real.
  DASHBOARD_EXECUTIVO_RESETAR_TESTE: "dashboard_executivo.resetar_teste",
  // Excluir um lançamento de verdade, em QUALQUER unidade (real ou teste) —
  // diferente do reset acima. Deliberadamente NÃO listada em nenhum outro
  // papel abaixo: só entra em `organization_admin` via `Object.values(P)`.
  // Sempre exige motivo e grava snapshot completo antes de apagar (ver
  // lancamentos_financeiros_exclusoes, migration 027).
  DASHBOARD_EXECUTIVO_EXCLUIR: "dashboard_executivo.excluir",

  // Bonificação Mensal (metas + lançamentos diários + importação Visio).
  // Módulo próprio, não uma sub-aba do Dashboard iFood (ver frontend/config.js).
  BONIFICACAO_MENSAL_VER: "bonificacao_mensal.ver",
  // Importar os 2 PDFs da Visio, lançar/corrigir manualmente um dia, e
  // lançar o valor diário dos indicadores manuais (REV/Pesquisas/Nota
  // iFood/Pedidos com chamado — mesmas colunas de bonificacao_lancamentos_
  // diarios, migration 028; ver bonificacaoMensal.service.js#salvarValorDiaIndicador).
  BONIFICACAO_MENSAL_LANCAR: "bonificacao_mensal.lancar",
  // Cadastrar/editar metas e faixas de bonificação (bonificacao_metas/
  // bonificacao_metas_faixas) — DELIBERADAMENTE separada de LANCAR (item 12
  // das instruções: quem lança o indicador do dia a dia não precisa poder
  // mudar a régua da bonificação). NÃO listada em nenhum papel abaixo — só
  // entra em organization_admin via Object.values(P), mesmo desenho de
  // BONIFICACAO_MENSAL_EXCLUIR.
  BONIFICACAO_MENSAL_CONFIGURAR: "bonificacao_mensal.configurar",
  // Excluir um lançamento de verdade (DELETE, com motivo + snapshot).
  // Deliberadamente NÃO listada em nenhum papel abaixo — só entra em
  // organization_admin via Object.values(P). Mesmo espírito de
  // DASHBOARD_EXECUTIVO_EXCLUIR: uma exclusão de dado financeiro não é uma
  // ação de operação do dia a dia.
  BONIFICACAO_MENSAL_EXCLUIR: "bonificacao_mensal.excluir",

  // Parser Food Delivery (importação + conciliação de taxas de entregador
  // dos relatórios .xls/.xlsx do food delivery). Mesmo desenho de
  // BONIFICACAO_MENSAL_*: ver/importar em quase todo papel operacional,
  // excluir restrito a organization_admin.
  PARSER_FD_VER: "parser_food_delivery.ver",
  // Importar um arquivo (preview + confirmar) e editar a lista de códigos
  // "cancelado sem taxa" de uma importação já salva.
  PARSER_FD_IMPORTAR: "parser_food_delivery.importar",
  // Alterar manualmente a classificação automática de UM cancelamento
  // (recebe/não recebe taxa), sempre com motivo — mesmo espírito de
  // DASHBOARD_EXECUTIVO_CORRIGIR: uma correção pontual é mais sensível que
  // importar rotineiramente, por isso ganha permissão própria.
  PARSER_FD_CLASSIFICAR: "parser_food_delivery.classificar",
  // Excluir uma importação de verdade (DELETE, com motivo + snapshot).
  // Deliberadamente NÃO listada em nenhum papel abaixo — só entra em
  // organization_admin via Object.values(P), mesmo espírito de
  // BONIFICACAO_MENSAL_EXCLUIR/DASHBOARD_EXECUTIVO_EXCLUIR.
  PARSER_FD_EXCLUIR: "parser_food_delivery.excluir",

  // Checklist Operacional — SOMENTE visualizar (o resumo da unidade). Existe para o perfil de exibição
  // (`display_operator`, computador ligado à TV): ele tem ESTA permissão e nenhuma outra. Todos os papéis
  // que já abriam o Checklist (via integracoes.ver) a recebem junto com a leitura, então ninguém perde acesso.
  CHECKLIST_VISUALIZAR: "checklist.visualizar",
};

const P = PERMISSOES;

/** Só leitura — a base de todos os papéis operacionais. (Não inclui o perfil de exibição.) */
const LEITURA = [
  P.DASHBOARD_VER, P.PRODUTOS_VER, P.INSUMOS_VER, P.CMV_VER, P.VENDAS_VER,
  P.INTEGRACOES_VER, P.DASHBOARD_EXECUTIVO_VER, P.BONIFICACAO_MENSAL_VER, P.PARSER_FD_VER,
  P.CHECKLIST_VISUALIZAR,
];

/** @type {Record<string, string[]>} */
const POR_PAPEL = {
  organization_admin: Object.values(P),

  unit_manager: [
    ...LEITURA,
    P.PRODUTOS_EDITAR, P.INSUMOS_EDITAR, P.VENDAS_IMPORTAR, P.VENDAS_EDITAR,
    P.INTEGRACOES_GERENCIAR, P.USUARIOS_VER, P.CONFIG_VER,
    P.DASHBOARD_EXECUTIVO_LANCAR, P.BONIFICACAO_MENSAL_LANCAR, P.PARSER_FD_IMPORTAR, P.PARSER_FD_CLASSIFICAR,
  ],

  finance: [...LEITURA, P.FINANCEIRO_VER, P.CONFIG_VER, P.DASHBOARD_EXECUTIVO_LANCAR, P.DASHBOARD_EXECUTIVO_CORRIGIR, P.DASHBOARD_EXECUTIVO_CONFIGURAR, P.DASHBOARD_EXECUTIVO_RESETAR_TESTE, P.BONIFICACAO_MENSAL_LANCAR, P.PARSER_FD_IMPORTAR, P.PARSER_FD_CLASSIFICAR],

  operations: [...LEITURA, P.PRODUTOS_EDITAR, P.INSUMOS_EDITAR, P.VENDAS_IMPORTAR, P.DASHBOARD_EXECUTIVO_LANCAR, P.DASHBOARD_EXECUTIVO_CORRIGIR, P.DASHBOARD_EXECUTIVO_CONFIGURAR, P.DASHBOARD_EXECUTIVO_RESETAR_TESTE, P.BONIFICACAO_MENSAL_LANCAR, P.PARSER_FD_IMPORTAR, P.PARSER_FD_CLASSIFICAR],

  viewer: [...LEITURA],

  // Perfil de EXIBIÇÃO (computador ligado à TV da loja): vê o Checklist Operacional da unidade e MAIS NADA.
  // Deliberadamente fora de LEITURA e sem nenhum item dela (nem integracoes.ver). Só existe como vínculo de
  // UNIDADE (nunca de empresa, nunca consolidado) — ver PAPEIS_UNIDADE/PAPEIS_VINCULO abaixo.
  display_operator: [P.CHECKLIST_VISUALIZAR],
};

/** O perfil de exibição (Operador de Exibição). Valor do enum `papel_acesso` (migration 112). */
export const PAPEL_EXIBICAO = "display_operator";

/** Papéis de vínculo de EMPRESA (usuarios_organizacoes). O de exibição NÃO entra: ele é só de unidade. `platform_superadmin` NÃO está aqui: é global. */
export const PAPEIS_VINCULO = Object.keys(POR_PAPEL).filter((p) => p !== PAPEL_EXIBICAO);

/** Papéis atribuíveis a um vínculo de UNIDADE (usuarios_unidades): os de empresa + o de exibição. */
export const PAPEIS_UNIDADE = Object.keys(POR_PAPEL);

/** Rótulos em pt-BR — usados no painel e nas telas de seleção. */
export const PAPEIS_ROTULO = {
  platform_superadmin: "SuperAdmin da Plataforma",
  organization_admin: "Administrador",
  unit_manager: "Gestor de Unidade",
  finance: "Financeiro",
  operations: "Operação",
  viewer: "Consulta",
  display_operator: "Operador de Exibição",
};

/**
 * Permissões efetivas de um papel de vínculo.
 * Papel desconhecido cai em `viewer` — na dúvida, o mínimo.
 * @param {string} papel
 * @returns {string[]}
 */
export function permissoesDoPapel(papel) {
  return [...(POR_PAPEL[papel] ?? POR_PAPEL.viewer)];
}

/**
 * @param {string[]|undefined|null} permissoes
 * @param {string} necessaria
 * @returns {boolean}
 */
export function temPermissao(permissoes, necessaria) {
  return Array.isArray(permissoes) && permissoes.includes(necessaria);
}

/** Papel válido para um vínculo de EMPRESA. @param {string} papel */
export function papelValido(papel) {
  return PAPEIS_VINCULO.includes(papel);
}

/** Papel válido para um vínculo de UNIDADE (inclui o de exibição). @param {string} papel */
export function papelUnidadeValido(papel) {
  return PAPEIS_UNIDADE.includes(papel);
}

/** @param {string} papel */
export function rotuloPapel(papel) {
  return PAPEIS_ROTULO[papel] ?? papel;
}
