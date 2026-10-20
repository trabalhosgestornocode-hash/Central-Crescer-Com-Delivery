// Regras PURAS da administração de concessões financeiras (validação e política de bloqueio).
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { NIVEIS_FINANCEIRO } from "../../shared/gestaoFinanceira.permissoes.js";

export const MOTIVO_MIN = 10;

/**
 * Chave GERAL de implantação das escritas de concessão (rollout), não uma exigência por concessão: com
 * FINANCEIRO_CONCESSOES_HABILITADAS diferente de "true" todo ambiente fica fechado (falha fechada). Ligada, quem
 * administra é o SuperAdmin autenticado (plataformaRouter) — sem MFA específico do Financeiro (decisão de 2026-10-20).
 * @param {unknown} _usuario  mantido na assinatura: o gate é por ambiente, não por sessão
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ok:true}|{ok:false, status:number, codigo:string, mensagem:string}}
 */
export function avaliarLiberacaoDeConcessoes(_usuario, env = process.env) {
  if (env.FINANCEIRO_CONCESSOES_HABILITADAS !== "true") {
    return { ok: false, status: 403, codigo: "CONCESSOES_BLOQUEADAS", mensagem: "A administração de acessos financeiros está desligada neste ambiente." };
  }
  return { ok: true };
}

/**
 * Valida o corpo de POST /concessoes.
 * @param {unknown} body
 * @param {string} atorId  conta do SuperAdmin
 * @param {number} [agora]
 */
export function validarNovaConcessao(body, atorId, agora = Date.now()) {
  const b = v.corpo(body);
  const motivo = v.texto(b.motivo, "Motivo", { min: MOTIVO_MIN, max: 500 });
  let expiraEm = null;
  if (b.expiraEm != null && b.expiraEm !== "") {
    const t = Date.parse(String(b.expiraEm));
    if (!Number.isFinite(t) || t <= agora) throw ApiError.badRequest("Expiração inválida: informe uma data futura.");
    expiraEm = new Date(t).toISOString();
  }
  return {
    organizacao_id: v.uuid(b.organizacaoId, "Empresa"),
    unidade_id: v.uuid(b.unidadeId, "Unidade"),
    perfil_id: v.uuid(b.perfilId, "Perfil"),
    nivel: v.umDe(b.nivel, "Nível", NIVEIS_FINANCEIRO),
    somente_financeiro: v.booleano(b.somenteFinanceiro, false),
    motivo, expira_em: expiraEm, concedida_por: atorId,
  };
}

/**
 * Autoconcessão: só o SuperAdmin da plataforma pode definir o próprio acesso (migration 126 repete a regra no banco).
 * Qualquer outra conta continua proibida de elevar o próprio privilégio.
 * @param {string|null|undefined} contaDoPerfil
 * @param {string} atorId
 * @param {{superadmin?: boolean}} [ator]
 */
export function garantirSemAutoconcessao(contaDoPerfil, atorId, ator = {}) {
  if (!contaDoPerfil) throw ApiError.notFound("Perfil não encontrado.");
  if (contaDoPerfil === atorId && ator.superadmin !== true) {
    throw ApiError.forbidden("Autoconcessão é proibida.", { codigo: "AUTOCONCESSAO_PROIBIDA" });
  }
}

/** @param {unknown} body */
export function validarRevogacao(body) {
  const b = v.corpo(body);
  return { motivo: v.texto(b.motivo, "Motivo", { min: MOTIVO_MIN, max: 500 }) };
}

/**
 * Situação de uma concessão para a administração. Revogada vence expirada; expirada vence ativa.
 * @param {{revogada_em?:string|null, expira_em?:string|null}} c
 * @param {number} [agora]
 * @returns {'ativa'|'expirada'|'revogada'}
 */
export function situacaoDaConcessao(c, agora = Date.now()) {
  if (c?.revogada_em) return "revogada";
  if (c?.expira_em && new Date(c.expira_em).getTime() <= agora) return "expirada";
  return "ativa";
}

/**
 * Perfis que PODEM receber concessão numa unidade: perfil ativo, conta com vínculo ativo na unidade ou na empresa,
 * nunca o perfil de exibição. Marca os da própria conta do SuperAdmin (identificação na tela).
 * @param {{perfis: Array<{id:string, conta_id:string, nome:string|null}>, contas: Record<string,{nome?:string|null,email?:string|null}>,
 *          vinculosUnidade: Array<{usuario_id:string, papel:string|null, ativo:boolean}>,
 *          vinculosEmpresa: Array<{usuario_id:string, papel:string|null, ativo:boolean}>}} dados
 * @param {string} atorId
 */
export function montarPerfisElegiveis({ perfis, contas, vinculosUnidade, vinculosEmpresa }, atorId) {
  const ok = (v) => v.ativo === true && v.papel !== "display_operator";
  const contasComVinculo = new Set([...vinculosUnidade, ...vinculosEmpresa].filter(ok).map((v) => v.usuario_id));
  return perfis
    .filter((p) => contasComVinculo.has(p.conta_id))
    .map((p) => ({
      id: p.id, nome: p.nome ?? contas[p.conta_id]?.nome ?? "—", email: contas[p.conta_id]?.email ?? null,
      propria: p.conta_id === atorId,
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

// ------------------------------------------------------------------ Gestão simples de acessos por unidade
// Uma tela: ligar/desligar o Financeiro na unidade e escolher, por usuário, Sem acesso / Visualização / Operador / Gestor.
// Tudo é traduzido para as MESMAS concessões da 120 (inserir, alterar nível, revogar), que o banco revalida por gatilho.

export const LIMITE_ACESSOS_POR_GRAVACAO = 500;

/**
 * Valida o corpo de PUT /concessoes/unidades/:id/acessos.
 * `nivel: null` (ou "sem_acesso") = Sem acesso. Perfil repetido é recusado.
 * @param {unknown} body
 * @returns {{habilitado:boolean, acessos:Array<{perfilId:string, nivel:string|null}>}}
 */
export function validarAcessosDaUnidade(body) {
  const b = v.corpo(body);
  if (typeof b.habilitado !== "boolean") throw ApiError.badRequest("Informe se o Financeiro fica ligado na unidade.");
  if (!Array.isArray(b.acessos)) throw ApiError.badRequest("Acessos deve ser uma lista.");
  if (b.acessos.length > LIMITE_ACESSOS_POR_GRAVACAO) throw ApiError.badRequest(`No máximo ${LIMITE_ACESSOS_POR_GRAVACAO} usuários por gravação.`);
  const vistos = new Set();
  const acessos = b.acessos.map((item) => {
    const a = v.corpo(item);
    const perfilId = v.uuid(a.perfilId, "Perfil");
    if (vistos.has(perfilId)) throw ApiError.badRequest("Usuário informado mais de uma vez.");
    vistos.add(perfilId);
    const bruto = a.nivel == null || a.nivel === "" || a.nivel === "sem_acesso" ? null : a.nivel;
    return { perfilId, nivel: bruto === null ? null : v.umDe(bruto, "Nível", NIVEIS_FINANCEIRO) };
  });
  return { habilitado: b.habilitado, acessos };
}

/**
 * Diferença entre as concessões ATIVAS da unidade e o que a tela pediu. Função PURA.
 * Só perfis elegíveis da unidade podem receber acesso; perfil fora da lista é recusado (nunca concedido em silêncio).
 * Perfil ausente do pedido = não mexe nele.
 * @param {{ativas: Array<{id:string, perfil_id:string, nivel:string}>, elegiveis: Array<{id:string}>,
 *          pedido: Array<{perfilId:string, nivel:string|null}>}} dados
 * @returns {{conceder: Array<{perfilId:string, nivel:string}>, alterar: Array<{concessaoId:string, perfilId:string, de:string, para:string}>,
 *            revogar: Array<{concessaoId:string, perfilId:string, de:string}>, inalterados: number}}
 */
export function planejarAcessos({ ativas, elegiveis, pedido }) {
  const permitidos = new Set(elegiveis.map((p) => p.id));
  const ativaPorPerfil = new Map(ativas.map((c) => [c.perfil_id, c]));
  const plano = { conceder: [], alterar: [], revogar: [], inalterados: 0 };
  for (const { perfilId, nivel } of pedido) {
    const atual = ativaPorPerfil.get(perfilId);
    if (nivel === null) {
      if (atual) plano.revogar.push({ concessaoId: atual.id, perfilId, de: atual.nivel });
      else plano.inalterados += 1;
      continue;
    }
    if (!permitidos.has(perfilId)) {
      throw ApiError.badRequest("Um dos usuários não tem vínculo ativo com esta unidade ou empresa.", { codigo: "PERFIL_NAO_ELEGIVEL" });
    }
    if (!atual) plano.conceder.push({ perfilId, nivel });
    else if (atual.nivel !== nivel) plano.alterar.push({ concessaoId: atual.id, perfilId, de: atual.nivel, para: nivel });
    else plano.inalterados += 1;
  }
  return plano;
}

/**
 * Motivo gravado automaticamente na auditoria (a tela simples não pede texto). Sempre >= MOTIVO_MIN.
 * @param {'conceder'|'alterar'|'revogar'} acao
 * @param {{email?:string|null, id:string}} ator
 * @param {string|null} [nivel]
 */
export function motivoAutomatico(acao, ator, nivel = null) {
  const quem = ator.email || ator.id;
  if (acao === "revogar") return `Acesso removido na gestão de acessos por ${quem}.`;
  if (acao === "alterar") return `Nível alterado para ${nivel} na gestão de acessos por ${quem}.`;
  return `Acesso ${nivel} definido na gestão de acessos por ${quem}.`;
}
