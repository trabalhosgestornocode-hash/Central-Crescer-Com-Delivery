// D-3 — quem gerencia o quê na Central de Notificações. Fonte única no backend (a interface só reflete; o banco revalida).
//
//   * organization_admin: a empresa inteira (unidadePermitida = null).
//   * qualquer outro papel com `notificacoes.gerenciar` (gerente da unidade): SÓ a unidade do contexto da sessão, já validada
//     pelo Context Token; sem unidade no contexto (visão consolidada) não gerencia nada.
//   * `notificacoes.ver` sem `gerenciar` (ex.: finance): leitura, no mesmo recorte.
// A unidade permitida é repassada às RPCs (`p_unidade_permitida`) — o banco recusa escopo fora dela (42501).
import { ApiError } from "../../shared/ApiError.js";
import { PERMISSOES, temPermissao } from "../../shared/permissoes.js";

/**
 * @param {{ tenant?: {organizacaoId: string, unidadeId: string|null}, acesso?: {papel?: string, permissoes?: string[]} }} req
 * @returns {{ organizacaoId: string, unidadePermitida: string|null, unidadeContexto: string|null, podeVer: boolean, podeGerenciar: boolean, papel: string|null }}
 */
export function escopoDeGestao(req) {
  const organizacaoId = req?.tenant?.organizacaoId ?? null;
  const unidadeContexto = req?.tenant?.unidadeId ?? null;
  const permissoes = req?.acesso?.permissoes ?? [];
  const papel = req?.acesso?.papel ?? null;
  const gerencia = temPermissao(permissoes, PERMISSOES.NOTIFICACOES_GERENCIAR);
  const ve = gerencia || temPermissao(permissoes, PERMISSOES.NOTIFICACOES_VER);
  const daEmpresa = papel === "organization_admin";
  return {
    organizacaoId,
    unidadeContexto,
    papel,
    // admin da empresa: tudo; demais: só a unidade do contexto (nula = nada)
    unidadePermitida: daEmpresa ? null : unidadeContexto,
    podeVer: !!organizacaoId && ve && (daEmpresa || !!unidadeContexto),
    podeGerenciar: !!organizacaoId && gerencia && (daEmpresa || !!unidadeContexto),
  };
}

export function exigirVer(req) {
  const e = escopoDeGestao(req);
  if (!e.podeVer) throw ApiError.forbidden(e.unidadeContexto || e.papel === "organization_admin" ? "Sem permissão para ver as notificações." : "Selecione uma unidade para ver as notificações dela.");
  return e;
}

export function exigirGerenciar(req) {
  const e = escopoDeGestao(req);
  if (!e.podeGerenciar) throw ApiError.forbidden(e.papel === "organization_admin" || e.unidadeContexto ? "Sem permissão para gerenciar as notificações." : "Selecione uma unidade para gerenciar as notificações dela.");
  return e;
}

/** O alvo (unidade) está no alcance? Admin: qualquer unidade da empresa (o banco confere a empresa); gerente: só a dele. */
export function unidadeNoAlcance(escopo, unidadeId) {
  return !!unidadeId && (escopo.unidadePermitida === null || escopo.unidadePermitida === unidadeId);
}
