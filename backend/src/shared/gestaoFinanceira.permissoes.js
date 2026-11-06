// Permissões do Dashboard Financeiro — namespace ISOLADO de `permissoes.js`.
//
// De propósito NÃO entram em `PERMISSOES`: `organization_admin` recebe
// `Object.values(PERMISSOES)`, então qualquer permissão declarada lá seria
// herdada por administradores. Aqui só uma concessão explícita (por unidade)
// produz permissões, e ela é relida do banco a cada requisição.

export const MODULO_FINANCEIRO = "gestao_financeira";

export const PERM_FIN = Object.freeze({
  VER: "gestao_financeira.ver",
  LANCAR: "gestao_financeira.lancar",
  EDITAR: "gestao_financeira.editar",
  CONCILIAR: "gestao_financeira.conciliar",
  FECHAR: "gestao_financeira.fechar",
  // Cancelar = transição LÓGICA de status (com motivo, auditada, nunca apaga). Independente de EXCLUIR.
  CANCELAR: "gestao_financeira.cancelar",
  // REABRIR e EXCLUIR existem no catálogo, mas NENHUM nível as concede nesta versão (reabertura: só após homologação
  // específica; exclusão física: nunca). Ficam declaradas para que uma rota futura as exija explicitamente.
  REABRIR: "gestao_financeira.reabrir",
  EXCLUIR: "gestao_financeira.excluir",
  CONFIGURAR: "gestao_financeira.configurar",
  // Financeiro 2.0 (decisão 4): confirmar juros, multas, tarifas, descontos e demais classificações que ALTERAM O RESULTADO.
  CLASSIFICAR: "gestao_financeira.classificar",
});

export const NIVEIS_FINANCEIRO = Object.freeze(["leitura", "operador", "gestor", "contador", "administrador"]);

// Matriz (decisão A7.1 + GO Financeiro 2.0 de 05/11/2026).
//   leitura: consulta.  operador: consulta, registra (obrigações/pagamentos — ficam PROVISÓRIOS) e edita.
//   gestor (Gerente): + conciliar (inclui confirmar quitação e registro provisório), cancelar, fechar e configurar.
//   contador (Contadora): consulta, edita, concilia, CLASSIFICA e fecha. Não registra nem cancela lançamentos.
//   administrador: tudo do gestor + CLASSIFICAR.
// Sem nível: REABRIR (aguarda homologação específica) e EXCLUIR (exclusão física não existe nesta versão).
const POR_NIVEL = Object.freeze({
  leitura: [PERM_FIN.VER],
  operador: [PERM_FIN.VER, PERM_FIN.LANCAR, PERM_FIN.EDITAR],
  gestor: [PERM_FIN.VER, PERM_FIN.LANCAR, PERM_FIN.EDITAR, PERM_FIN.CONCILIAR, PERM_FIN.CANCELAR, PERM_FIN.FECHAR, PERM_FIN.CONFIGURAR],
  contador: [PERM_FIN.VER, PERM_FIN.EDITAR, PERM_FIN.CONCILIAR, PERM_FIN.CLASSIFICAR, PERM_FIN.FECHAR],
  administrador: [PERM_FIN.VER, PERM_FIN.LANCAR, PERM_FIN.EDITAR, PERM_FIN.CONCILIAR, PERM_FIN.CANCELAR, PERM_FIN.FECHAR, PERM_FIN.CONFIGURAR, PERM_FIN.CLASSIFICAR],
});

/** Todas as permissões do catálogo financeiro (para testes/guardas). */
export const PERMISSOES_FINANCEIRAS = Object.freeze(Object.values(PERM_FIN));

/**
 * Nível desconhecido ou ausente => nenhuma permissão (falha fechada).
 * @param {unknown} nivel
 * @returns {string[]}
 */
export function permissoesDoNivelFinanceiro(nivel) {
  return [...(POR_NIVEL[/** @type {string} */ (nivel)] ?? [])];
}

/**
 * Uma concessão vale se: não revogada, não expirada, nível conhecido e do mesmo par org+unidade.
 * @param {{organizacao_id?:string, unidade_id?:string, nivel?:string, revogada_em?:string|null, expira_em?:string|null}|null|undefined} c
 * @param {{organizacaoId:string, unidadeId:string|null}} tenant
 * @param {number} [agora]
 */
export function concessaoVigente(c, tenant, agora = Date.now()) {
  if (!c || !tenant?.unidadeId) return false;
  if (c.organizacao_id !== tenant.organizacaoId || c.unidade_id !== tenant.unidadeId) return false;
  if (c.revogada_em) return false;
  if (c.expira_em && new Date(c.expira_em).getTime() <= agora) return false;
  return NIVEIS_FINANCEIRO.includes(/** @type {string} */ (c.nivel));
}
