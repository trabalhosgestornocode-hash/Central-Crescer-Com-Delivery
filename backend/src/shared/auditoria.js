// Registro de auditoria da plataforma.
//
// REGRA DE OURO: auditar NUNCA derruba a operação. Se o insert falhar, a ação
// do usuário segue em frente e o erro vai para o log do servidor. O contrário
// (perder um bloqueio de empresa porque a auditoria piscou) seria pior.
//
// A imutabilidade não é imposta aqui, e sim no banco: a migration 020 instala
// triggers que recusam UPDATE/DELETE/TRUNCATE em plataforma_auditoria — vale
// inclusive para o service_role que este backend usa.

import { supabase } from "../config/supabase.js";

/** Ações canônicas. Use estas constantes em vez de string solta. */
export const ACOES = {
  // sessão
  LOGIN: "sessao.login",
  LOGOUT: "sessao.logout",
  CONTEXTO_SELECIONADO: "sessao.contexto_selecionado",
  CONTEXTO_TROCADO: "sessao.contexto_trocado",
  LOGIN_NEGADO: "sessao.login_negado",
  SENHA_DEFINIDA: "sessao.senha_definida",

  // impersonação
  IMPERSONAR_INICIO: "impersonacao.iniciada",
  IMPERSONAR_FIM: "impersonacao.encerrada",

  // empresas
  EMPRESA_CRIADA: "empresa.criada",
  EMPRESA_EDITADA: "empresa.editada",
  EMPRESA_STATUS: "empresa.status_alterado",
  EMPRESA_PLANO: "empresa.plano_alterado",
  EMPRESA_EXCLUIDA: "empresa.excluida",
  EMPRESA_MODULO_HABILITADO: "empresa.modulo_habilitado",
  EMPRESA_MODULO_DESABILITADO: "empresa.modulo_desabilitado",
  EMPRESA_MODELO_CLONADO: "empresa.modelo_clonado",

  // unidades
  UNIDADE_CRIADA: "unidade.criada",
  UNIDADE_EDITADA: "unidade.editada",
  UNIDADE_STATUS: "unidade.status_alterado",
  UNIDADE_MODULO_HABILITADO: "unidade.modulo_habilitado",
  UNIDADE_MODULO_DESABILITADO: "unidade.modulo_desabilitado",
  UNIDADE_EXCLUIDA: "unidade.excluida",
  // Troca da tabela comercial OFICIAL (balcão/iFood) — nunca gravada por
  // "modo de comparação" (isso é só estado de frontend). Ver migration 051
  // (unidade_tabela_comercial_historico), onde o antes/depois fica gravado
  // junto — esta linha em plataforma_auditoria é o espelho geral.
  UNIDADE_TABELA_COMERCIAL_ALTERADA: "unidade.tabela_comercial_alterada",
  // Estrutura organizacional (Fase D) — as ações em si são gravadas DENTRO
  // das funções PL/pgSQL da migration 053 (mesma transação da mudança),
  // não por auditar()/auditarReq(). Estas constantes existem para o
  // frontend/backend terem uma fonte única do texto exato da ação ao
  // filtrar/rotular a auditoria (ver adminUi.js e listarLogsDaUnidade).
  UNIDADE_PROMOVIDA_EMPRESA: "unidade.promovida_para_empresa",
  UNIDADE_TRANSFERIDA: "unidade.transferida_entre_empresas",
  EMPRESA_CONVERTIDA_UNIDADE: "empresa.convertida_para_unidade",

  // usuários e vínculos
  USUARIO_CRIADO: "usuario.criado",
  USUARIO_EDITADO: "usuario.editado",
  USUARIO_BLOQUEADO: "usuario.bloqueado",
  USUARIO_SENHA_REDEFINIDA: "usuario.senha_redefinida",
  USUARIO_EMAIL_ALTERADO: "usuario.email_alterado",
  USUARIO_LOGOUT_FORCADO: "usuario.logout_forcado",
  USUARIO_EXCLUIDO: "usuario.excluido",
  VINCULO_CRIADO: "vinculo.criado",
  VINCULO_EDITADO: "vinculo.editado",
  VINCULO_REMOVIDO: "vinculo.removido",

  // Perfis operacionais (Fase G) — CRUD administrativo de múltiplos usuários
  // por conta de acesso.
  PERFIL_CRIADO: "perfil.criado",
  PERFIL_EDITADO: "perfil.editado",
  PERFIL_ATIVADO: "perfil.ativado",
  PERFIL_DESATIVADO: "perfil.desativado",

  // PIN do perfil operacional (Fase H) — NUNCA grava o PIN nem o hash, só o
  // fato + o perfil afetado.
  PERFIL_PIN_DEFINIDO: "perfil.pin_definido",
  PERFIL_PIN_REMOVIDO: "perfil.pin_removido",
  PERFIL_PIN_BLOQUEADO: "perfil.pin_bloqueado",

  // Eventos de SEGURANÇA (Fase P0.10/P0.2) — capacidade mínima de detecção.
  // Nunca gravam senha/PIN/token/Authorization/secret/TOTP nem payload
  // sensível: só o fato, a rota, o ator e a origem.
  SEGURANCA_ACESSO_NEGADO: "seguranca.acesso_negado",       // 403 em superfície privilegiada
  SEGURANCA_RATE_LIMIT: "seguranca.rate_limit_excedido",    // 429 de um limiteDeTaxa (com throttle anti-spam)
  SEGURANCA_MFA_REQUERIDA: "seguranca.mfa_requerida",       // gate de MFA barrou (AAL insuficiente)
  MFA_CADASTRADA: "seguranca.mfa_cadastrada",               // conta passou a ter 2º fator verificado
  MFA_REMOVIDA: "seguranca.mfa_removida",                   // conta deixou de ter 2º fator

  // Painel Administrativo da Crescer — acesso GLOBAL de monitoramento
  // (painel_administrativo_usuarios). NÃO é SuperAdmin: não concede poder
  // técnico. Concessão/revogação são feitas pelo SuperAdmin.
  PAINEL_ADM_CONCEDIDO: "usuario.painel_administrativo_concedido",
  PAINEL_ADM_REVOGADO: "usuario.painel_administrativo_revogado",

  // Desbloqueio administrativo de um dia do Dashboard iFood (migration 068).
  // As ÚNICAS ações de escrita do Painel Administrativo. O registro detalhado
  // (motivo, observação, quem revogou) vive em `dashboard_ifood_desbloqueios`;
  // estas linhas são o espelho na trilha única da plataforma.
  IFOOD_DIA_DESBLOQUEADO: "dashboard_ifood.dia_desbloqueado",
  IFOOD_DIA_DESBLOQUEIO_REVOGADO: "dashboard_ifood.dia_desbloqueio_revogado",

  // configuração global
  CONFIG_ALTERADA: "config.alterada",

  // Bonificação Mensal
  BONIFICACAO_META_ALTERADA: "bonificacao_mensal.meta_alterada",
  BONIFICACAO_INDICADOR_LANCADO: "bonificacao_mensal.indicador_lancado",
  // Fechamento mensal Visio (arquitetura v3.1): competência congelada
  // (confirmação), reaberta, refechada (nova versão de snapshot) ou capturada
  // como histórico legado. A autoridade do resultado é bonificacao_competencia.
  BONIFICACAO_FECHAMENTO_MENSAL_ALTERADO: "bonificacao_mensal.fechamento_mensal_alterado",
  // Importação DIÁRIA gravada (migration 076): linha escrita pelo gatilho
  // trg_bonificacao_auditar_importacao_diaria na MESMA transação do upsert do
  // lançamento — detalhes.operacao = INSERT|UPDATE, detalhes.documentos = as
  // importações vinculadas. Catalogada aqui para o painel de auditoria.
  BONIFICACAO_IMPORTACAO_DIARIA_GRAVADA: "bonificacao_mensal.importacao_diaria_gravada",

  // Agente Crescer (assistente de IA) — uma linha por mensagem processada,
  // sucesso ou erro (ver detalhes.sucesso). Nunca grava o texto da mensagem
  // nem da resposta, só metadados de uso (ver agente/agente.service.js).
  AGENTE_MENSAGEM_ENVIADA: "agente.mensagem_enviada",
};

/**
 * @typedef {object} EntradaAuditoria
 * @property {string|null} [atorId]   auth.users.id — a CONTA
 * @property {string|null} [atorEmail]
 * @property {string|null} [perfilId] perfis_operacionais.id — a PESSOA operacional (Fase D).
 *   null em ações de superadmin/sistema e em impersonação.
 * @property {string|null} [perfilNome] nome da PESSOA no momento da ação — gravado
 *   em `detalhes.perfil_nome` para o log seguir legível se o perfil for desativado (Fase I).
 * @property {'usuario'|'superadmin'|'sistema'} [atorTipo]
 * @property {string} acao
 * @property {string|null} [entidade]
 * @property {string|null} [entidadeId]
 * @property {string|null} [organizacaoId]
 * @property {string|null} [impersonadoPor]
 * @property {Record<string, unknown>} [detalhes]
 * @property {string|null} [ip]
 * @property {string|null} [userAgent]
 */

/**
 * Grava uma entrada de auditoria. Não lança.
 * @param {EntradaAuditoria} entrada
 * @returns {Promise<void>}
 */
// `perfil_id` é da migration 060. Enquanto ela não roda no ambiente, o insert
// com essa coluna falha — então degrada graciosamente (mesmo padrão de
// agente.conversas.service.js#RE_COLUNA_AUSENTE) e grava sem ela. A Fase D
// exige 060, mas isto cobre a janela de transição / o cache de schema.
const RE_COLUNA_AUSENTE = /perfil_id|does not exist|schema cache|could not find/i;

export async function auditar(entrada) {
  // `perfil_nome` vai para dentro de `detalhes` (não é coluna) — o log fica
  // autoexplicativo mesmo se o perfil for desativado depois. Só quando há nome.
  const detalhes = entrada.perfilNome
    ? { ...(entrada.detalhes ?? {}), perfil_nome: entrada.perfilNome }
    : (entrada.detalhes ?? {});
  const linha = {
    ator_id: entrada.atorId ?? null,
    ator_email: entrada.atorEmail ?? null,
    perfil_id: entrada.perfilId ?? null,   // Fase D — a PESSOA (coluna da migration 060)
    ator_tipo: entrada.atorTipo ?? "usuario",
    acao: entrada.acao,
    entidade: entrada.entidade ?? null,
    entidade_id: entrada.entidadeId != null ? String(entrada.entidadeId) : null,
    organizacao_id: entrada.organizacaoId ?? null,
    impersonado_por: entrada.impersonadoPor ?? null,
    detalhes,
    ip: entrada.ip ?? null,
    user_agent: entrada.userAgent ?? null,
  };
  try {
    let { error } = await supabase.from("plataforma_auditoria").insert(linha);
    if (error && RE_COLUNA_AUSENTE.test(error.message || "")) {
      const { perfil_id: _semPerfil, ...semColunaNova } = linha;
      ({ error } = await supabase.from("plataforma_auditoria").insert(semColunaNova));
    }
    if (error) console.error("[auditoria] falha ao registrar:", entrada.acao, error.message);
  } catch (e) {
    console.error("[auditoria] exceção ao registrar:", entrada.acao, e?.message);
  }
}

/**
 * Extrai ator + origem da requisição para não repetir isso em cada controller.
 * Já resolve o caso da impersonação: o ator é quem está operando (o usuário
 * "de dentro" da empresa) e `impersonadoPor` diz quem realmente estava ali.
 * @param {import('express').Request & {user?: any, acesso?: any, tenant?: any}} req
 * @returns {Partial<EntradaAuditoria>}
 */
export function contextoDaRequisicao(req) {
  const encaminhado = req.headers?.["x-forwarded-for"];
  const ip = (Array.isArray(encaminhado) ? encaminhado[0] : encaminhado)?.split(",")[0]?.trim()
    || req.socket?.remoteAddress || null;
  return {
    atorId: req.user?.id ?? null,
    atorEmail: req.user?.email ?? null,
    // Fase D — a PESSOA operacional da sessão. `req.perfil` é setado por
    // requireContexto (null em impersonação e onde não há contexto).
    perfilId: req.perfil?.id ?? req.acesso?.perfilId ?? null,
    perfilNome: req.perfil?.nome ?? null, // Fase I — snapshot em detalhes.perfil_nome

    atorTipo: req.user?.superadmin ? "superadmin" : "usuario",
    organizacaoId: req.tenant?.organizacaoId ?? null,
    impersonadoPor: req.acesso?.impersonadoPor ?? null,
    ip,
    userAgent: req.header?.("user-agent") ?? null,
  };
}

/**
 * Açúcar: `auditar` já preenchido com o contexto da requisição.
 * @param {import('express').Request} req
 * @param {EntradaAuditoria} entrada
 */
export function auditarReq(req, entrada) {
  return auditar({ ...contextoDaRequisicao(req), ...entrada });
}
