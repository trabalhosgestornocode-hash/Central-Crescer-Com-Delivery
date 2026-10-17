// Regras PURAS da administração de concessões financeiras (validação e política de bloqueio).
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { NIVEIS_FINANCEIRO } from "../../shared/gestaoFinanceira.permissoes.js";
import { avaliarMfaRecente } from "../../shared/mfaRecente.js";

export const MOTIVO_MIN = 10;

/**
 * Política de liberação dos endpoints de concessão. Falha FECHADA por padrão:
 * só abre com FINANCEIRO_CONCESSOES_HABILITADAS=true, que NÃO deve ser ligada antes de a prova de MFA (AAL2 + 2º fator
 * recente) ter sido feita em um Supabase descartável. Mesmo ligada, cada requisição exige AAL2 recente.
 * @param {{aal?:string|null, mfaEm?:number|null}} usuario
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number} [agora]
 * @returns {{ok:true}|{ok:false, status:number, codigo:string, mensagem:string}}
 */
export function avaliarLiberacaoDeConcessoes(usuario, env = process.env, agora = Date.now()) {
  if (env.FINANCEIRO_CONCESSOES_HABILITADAS !== "true") {
    return { ok: false, status: 403, codigo: "CONCESSOES_BLOQUEADAS", mensagem: "A administração de concessões financeiras está bloqueada neste ambiente." };
  }
  const mfa = avaliarMfaRecente(usuario, agora);
  if (!mfa.ok) {
    return {
      ok: false, status: 401, codigo: mfa.codigo,
      mensagem: mfa.codigo === "MFA_REQUERIDA"
        ? "Esta ação exige verificação em duas etapas (MFA)."
        : "Confirme o segundo fator novamente (autenticação recente de até 10 minutos).",
    };
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

/** Proíbe a autoconcessão: o perfil beneficiado não pode pertencer à conta de quem concede. */
export function garantirSemAutoconcessao(contaDoPerfil, atorId) {
  if (!contaDoPerfil) throw ApiError.notFound("Perfil não encontrado.");
  if (contaDoPerfil === atorId) throw ApiError.forbidden("Autoconcessão é proibida.", { codigo: "AUTOCONCESSAO_PROIBIDA" });
}

/** @param {unknown} body */
export function validarRevogacao(body) {
  const b = v.corpo(body);
  return { motivo: v.texto(b.motivo, "Motivo", { min: MOTIVO_MIN, max: 500 }) };
}
