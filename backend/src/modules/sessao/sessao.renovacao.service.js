// Renovação AUTOMÁTICA do contexto — SÓ do perfil de exibição (computador da TV, expediente de ~17 h).
//
// Módulo à parte de propósito: `sessao.service.js` tem travas estáticas que conferem o texto de `selecionarContexto`
// (autorização só por perfil_id etc.); a renovação reaproveita essa função em vez de duplicá-la. Política e cálculos
// puros: shared/renovacaoExibicao.js. Rota: POST /api/v1/sessao/renovar.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { PAPEL_EXIBICAO } from "../../shared/permissoes.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { decidirRenovacao, lerPoliticaRenovacao, mfaExigidoParaExibicao } from "../../shared/renovacaoExibicao.js";
import { selecionarContexto, revogarSessoes } from "./sessao.service.js";

/**
 * RENOVAÇÃO AUTOMÁTICA do contexto — SÓ do perfil de exibição (computador da TV, expediente de ~17 h).
 *
 * Em vez de esticar a validade de todos os papéis, o perfil de exibição troca o próprio contexto por um novo ANTES
 * de ele vencer, sem fechar o painel. Tudo é decidido aqui, no servidor, com o que o servidor sabe:
 *   * quem pede: a sessão já validada por `requireAuth` + `requireContexto` (JWT do Supabase válido, contexto vivo,
 *     usuário e perfil ativos, empresa não bloqueada). Empresa, unidade e perfil vêm da LINHA da sessão
 *     (`req.tenant`/`req.acesso`), nunca do corpo; o corpo não é lido;
 *   * elegibilidade: SÓ `display_operator` e nunca impersonação — qualquer outro papel recebe 403 e NADA muda;
 *   * tempo: só dentro da janela antes do vencimento (antes disso é "cedo": nada muda); limite ABSOLUTO desde a
 *     AUTENTICAÇÃO (padrão 20 h) — passou, 401 REAUTENTICACAO_NECESSARIA; sem carimbo no JWT não renova (fail-closed);
 *   * MFA: se `MFA_ENFORCE_EXIBICAO=true`, o JWT precisa estar em aal2;
 *   * tudo é REVALIDADO pelo mesmo caminho da seleção de contexto (conta → perfil → vínculo direto da unidade →
 *     empresa → papel → permissões → módulos). Permissões e módulos são RECALCULADOS, nunca copiados do contexto
 *     antigo — logo a renovação não amplia nada, e se o vínculo/papel/unidade mudou, ela é negada;
 *   * concorrência: compare-and-set atômico na linha da sessão (`motivo_revogacao IS NULL` → 'renovada'). Duas
 *     renovações do MESMO contexto (aba duplicada, timer repetido) → só uma vence; a outra recebe 409;
 *   * sobreposição curta: o contexto antigo continua valendo por `gracaS` (90 s) só para as requisições em voo — o
 *     polling do painel não leva 409 no meio da troca. Ele NÃO pode ser renovado de novo (a marca 'renovada' o impede);
 *   * falha transitória (banco/rede do servidor): o contexto antigo é RESTAURADO; negação de acesso (403): o antigo é
 *     REVOGADO na hora; outra recusa (4xx): o antigo só morre ao fim da graça;
 *   * auditoria: `sessao.contexto_renovado` / `sessao.contexto_renovacao_negada` — só ids, motivos e prazos, jamais token.
 *
 * @param {{usuario: any, acesso: any, tenant: {organizacaoId: string, unidadeId: string|null}, ip?: string|null, userAgent?: string|null}} p
 * @param {{agora?: () => number, supabase?: any, selecionarContexto?: Function, politica?: object, auditar?: Function}} [deps]
 */
export async function renovarContexto({ usuario, acesso, tenant, ip = null, userAgent = null }, deps = {}) {
  const agora = deps.agora ?? (() => Date.now());
  const db = deps.supabase ?? supabase;
  const selecionar = deps.selecionarContexto ?? selecionarContexto;
  const politica = deps.politica ?? lerPoliticaRenovacao();
  const registrar = deps.auditar ?? auditar;
  const iso = (ms) => new Date(ms).toISOString();

  const negar = async (status, codigo, mensagem, motivo, extra = {}) => {
    await registrar({
      atorId: usuario?.id ?? null, atorEmail: usuario?.email ?? null, perfilId: acesso?.perfilId ?? null,
      acao: ACOES.CONTEXTO_RENOVACAO_NEGADA, entidade: "organizacao", entidadeId: tenant?.organizacaoId ?? null,
      organizacaoId: tenant?.organizacaoId ?? null, ip, userAgent,
      detalhes: { motivo, sessaoId: acesso?.sessionId ?? null, ...extra },
    });
    throw new ApiError(status, mensagem, { codigo });
  };

  // 1) Elegibilidade — nada é alterado para quem não é o perfil de exibição.
  if (!acesso || acesso.impersonando || acesso.papel !== PAPEL_EXIBICAO || !tenant?.unidadeId) {
    return negar(403, "RENOVACAO_NAO_PERMITIDA", "Esta sessão não pode ser renovada automaticamente.", "papel_nao_elegivel", { papel: acesso?.papel ?? null });
  }
  // 2) MFA (dormente por padrão).
  if (mfaExigidoParaExibicao() && usuario.aal !== "aal2") {
    return negar(401, "MFA_REQUERIDA", "Este acesso exige verificação em duas etapas (MFA). Entre novamente.", "mfa_requerida");
  }
  // 3) Tempo: janela, limite absoluto desde a autenticação, carimbo confiável.
  const agoraMs = agora();
  const expiraEmMs = Date.parse(acesso.expiraEm);
  if (!Number.isFinite(expiraEmMs)) return negar(409, "CONTEXTO_INVALIDO", "Contexto inválido. Entre novamente.", "sem_expiracao");
  const decisao = decidirRenovacao({ agoraMs, expiraEmMs, authEmMs: usuario.authEm ?? null, politica });
  if (decisao.acao === "indisponivel") {
    return negar(403, "RENOVACAO_INDISPONIVEL", "A renovação automática não está disponível para esta autenticação.", "sem_carimbo_de_autenticacao");
  }
  if (decisao.acao === "reautenticar") {
    return negar(401, "REAUTENTICACAO_NECESSARIA", "O tempo máximo desta autenticação terminou. Entre novamente com a senha.", "limite_absoluto",
      { limiteAbsolutoEm: decisao.limiteEm ? iso(decisao.limiteEm) : null });
  }
  if (decisao.acao === "cedo") {
    return { renovado: false, expiraEm: iso(expiraEmMs), servidorEm: iso(agoraMs), limiteAbsolutoEm: iso(decisao.limiteEm) };
  }

  // 4) Compare-and-set ATÔMICO: marca o contexto antigo como 'renovada' e encurta o prazo dele à graça. Só uma vence.
  const graca = iso(Math.min(expiraEmMs, agoraMs + politica.gracaS * 1000));
  const marcar = await db.from("sessoes_contexto")
    .update({ expira_em: graca, motivo_revogacao: "renovada" })
    .eq("id", acesso.sessionId).eq("usuario_id", usuario.id).is("revogada_em", null).is("motivo_revogacao", null)
    .select("id");
  if (marcar.error) throw new ApiError(503, "Não foi possível renovar agora. Tente novamente em instantes.", { codigo: "RENOVACAO_INDISPONIVEL_AGORA" });
  const marcadas = Array.isArray(marcar.data) ? marcar.data : (marcar.data ? [marcar.data] : []);
  if (marcadas.length !== 1) {
    return negar(409, "RENOVACAO_CONCORRENTE", "Este contexto já foi renovado ou encerrado.", "concorrente");
  }
  const restaurarAntiga = () => db.from("sessoes_contexto")
    .update({ expira_em: iso(expiraEmMs), motivo_revogacao: null })
    .eq("id", acesso.sessionId).is("revogada_em", null).eq("motivo_revogacao", "renovada");
  const revogarAntigaAgora = () => db.from("sessoes_contexto")
    .update({ revogada_em: iso(agora()), motivo_revogacao: "renovacao_negada" })
    .eq("id", acesso.sessionId).is("revogada_em", null);

  // 5) Revalida TUDO e cria o contexto novo (mesmo caminho da seleção). Identidade vem da sessão, nunca do cliente.
  let dados;
  try {
    dados = await selecionar({
      usuario, perfilId: acesso.perfilId, organizacaoId: tenant.organizacaoId, unidadeId: tenant.unidadeId,
      validadeS: decisao.validadeS, renovacao: { sessaoAnteriorId: acesso.sessionId }, ip, userAgent, agora,
    });
  } catch (e) {
    const status = e instanceof ApiError ? e.statusCode : 500;
    if (status >= 500) {
      try { await restaurarAntiga(); } catch { /* o contexto antigo ainda vale até o fim da graça */ }
    } else if (status === 403) {
      try { await revogarAntigaAgora(); } catch { /* idem */ }
    }
    await registrar({
      atorId: usuario.id, atorEmail: usuario.email, perfilId: acesso.perfilId,
      acao: ACOES.CONTEXTO_RENOVACAO_NEGADA, entidade: "organizacao", entidadeId: tenant.organizacaoId, organizacaoId: tenant.organizacaoId, ip, userAgent,
      detalhes: { motivo: status >= 500 ? "falha_transitoria" : "revalidacao_negada", status, sessaoId: acesso.sessionId },
    });
    throw e;
  }

  // 6) A identidade tem de ser EXATAMENTE a mesma e o papel continuar o de exibição (defesa em profundidade).
  if (dados.papel !== PAPEL_EXIBICAO || dados.unidade?.id !== tenant.unidadeId || dados.empresa?.id !== tenant.organizacaoId) {
    try { await revogarSessoes({ sessionId: dados.sessionId, motivo: "renovacao_identidade_mudou" }); } catch { /* melhor esforço */ }
    try { await revogarAntigaAgora(); } catch { /* idem */ }
    return negar(403, "RENOVACAO_NAO_PERMITIDA", "Esta sessão não pode ser renovada automaticamente.", "identidade_mudou");
  }
  return { ...dados, renovado: true };
}
