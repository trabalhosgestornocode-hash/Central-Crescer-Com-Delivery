// Gate do Dashboard Financeiro. Três condições INDEPENDENTES, todas relidas no banco a cada requisição:
//   1. empresa habilitada para `gestao_financeira`
//   2. unidade habilitada para `gestao_financeira`
//   3. concessão explícita vigente do PERFIL para a unidade
// Falha fechada: erro de leitura => 500, nunca passagem. NÃO há bypass de impersonação nem de papel.
import { ApiError } from "../shared/ApiError.js";
import { supabase } from "../config/supabase.js";
import { MODULO_FINANCEIRO, concessaoVigente, permissoesDoNivelFinanceiro } from "../shared/gestaoFinanceira.permissoes.js";

/** Leitura real no banco; injetável nos testes. */
export const leitorPadrao = {
  async moduloEmpresa(orgId) {
    const { data, error } = await supabase.from("organizacao_modulos").select("modulo_id")
      .eq("organizacao_id", orgId).eq("modulo_id", MODULO_FINANCEIRO).maybeSingle();
    if (error) throw error;
    return !!data;
  },
  async moduloUnidade(unidadeId) {
    const { data, error } = await supabase.from("unidade_modulos").select("modulo_id")
      .eq("unidade_id", unidadeId).eq("modulo_id", MODULO_FINANCEIRO).maybeSingle();
    if (error) throw error;
    return !!data;
  },
  async concessao(perfilId, orgId, unidadeId) {
    const { data, error } = await supabase.from("gestao_financeira_concessoes")
      .select("organizacao_id, unidade_id, nivel, somente_financeiro, revogada_em, expira_em")
      .eq("perfil_id", perfilId).eq("organizacao_id", orgId).eq("unidade_id", unidadeId).is("revogada_em", null)
      .maybeSingle();
    if (error) throw error;
    return data;
  },
};

/**
 * Resolve o acesso financeiro do contexto. `leitor` é injetável para testes sem banco.
 * @returns {Promise<{ok:true, nivel:string, permissoes:string[], somenteFinanceiro:boolean}|{ok:false, codigo:string}>}
 */
export async function resolverAcessoFinanceiro(acesso, tenant, leitor = leitorPadrao, agora = Date.now()) {
  if (!acesso || !tenant?.organizacaoId) return { ok: false, codigo: "FINANCEIRO_SEM_CONCESSAO" };
  if (acesso.impersonando) return { ok: false, codigo: "FINANCEIRO_BLOQUEADO_IMPERSONACAO" };
  // Perfil de exibição (TV da loja) nunca enxerga o financeiro, mesmo que alguém grave uma concessão para ele.
  if (acesso.papel === "display_operator") return { ok: false, codigo: "FINANCEIRO_SEM_CONCESSAO" };
  if (!acesso.perfilId || !tenant.unidadeId) return { ok: false, codigo: "FINANCEIRO_SEM_CONCESSAO" };
  if (!(await leitor.moduloEmpresa(tenant.organizacaoId)) || !(await leitor.moduloUnidade(tenant.unidadeId))) {
    return { ok: false, codigo: "FINANCEIRO_NAO_HABILITADO" };
  }
  const c = await leitor.concessao(acesso.perfilId, tenant.organizacaoId, tenant.unidadeId);
  if (!concessaoVigente(c, tenant, agora)) return { ok: false, codigo: "FINANCEIRO_SEM_CONCESSAO" };
  return { ok: true, nivel: c.nivel, permissoes: permissoesDoNivelFinanceiro(c.nivel), somenteFinanceiro: c.somente_financeiro === true };
}

/** Gate da montagem de `/gestao-financeira`. Preenche `req.financeiro`. */
export function requireFinanceiro(leitor = leitorPadrao) {
  return async (req, _res, next) => {
    try {
      const r = await resolverAcessoFinanceiro(req.acesso, req.tenant, leitor);
      if (!r.ok) return next(ApiError.forbidden("Acesso ao Dashboard Financeiro não autorizado.", { codigo: r.codigo }));
      req.financeiro = { nivel: r.nivel, permissoes: r.permissoes, somenteFinanceiro: r.somenteFinanceiro, organizacaoId: req.tenant.organizacaoId, unidadeId: req.tenant.unidadeId };
      next();
    } catch {
      next(ApiError.internal("Falha ao validar o acesso financeiro."));
    }
  };
}

/**
 * Exige uma permissão financeira por rota. Sem bypass.
 * @param {string} permissao
 */
export function autorizarAcaoFinanceira(permissao) {
  return (req, _res, next) => {
    if (!req.financeiro?.permissoes?.includes(permissao)) {
      return next(ApiError.forbidden("Permissão financeira insuficiente.", { codigo: "FINANCEIRO_PERMISSAO_INSUFICIENTE" }));
    }
    next();
  };
}
