// Administração de concessões financeiras (SuperAdmin). Todo acesso passa por service_role e por validações explícitas;
// o banco repete as regras críticas por trigger (migration 120): unidade da organização, perfil ativo e vinculado,
// autoconcessão proibida, motivo mínimo, uma concessão ativa por perfil+unidade.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import {
  garantirSemAutoconcessao, validarNovaConcessao, validarRevogacao, situacaoDaConcessao, montarPerfisElegiveis,
} from "./concessoes.dominio.js";

const COLUNAS = "id, organizacao_id, unidade_id, perfil_id, nivel, somente_financeiro, concedida_por, motivo, concedida_em, expira_em, revogada_em, revogada_por, motivo_revogacao";

function origem(req) {
  return { ip: req.ip ?? null, userAgent: req.header?.("user-agent") ?? null };
}

/** Erros de regra vindos dos triggers viram 400 legível; o resto vira 500 genérico (sem vazar SQL). */
function traduzir(error) {
  if (!error) return null;
  if (error.code === "23505") return ApiError.badRequest("Este perfil já tem uma concessão ativa nesta unidade.", { codigo: "CONCESSAO_JA_ATIVA" });
  if (/Concessão financeira|autoconcessão/i.test(error.message || "")) return ApiError.badRequest(error.message);
  if (error.code === "23514") return ApiError.badRequest("Dados da concessão inválidos (nível, motivo ou expiração).");
  return ApiError.internal("Falha ao gravar a concessão.");
}

export async function listar({ unidadeId, perfilId, incluirRevogadas = false } = {}) {
  let q = supabase.from("gestao_financeira_concessoes").select(COLUNAS).order("concedida_em", { ascending: false }).limit(200);
  if (unidadeId) q = q.eq("unidade_id", unidadeId);
  if (perfilId) q = q.eq("perfil_id", perfilId);
  if (!incluirRevogadas) q = q.is("revogada_em", null);
  const { data, error } = await q;
  if (error) throw ApiError.internal("Falha ao listar concessões.");
  const linhas = data ?? [];

  // Nome/e-mail do perfil para a tela (somente leitura).
  const ids = [...new Set(linhas.map((c) => c.perfil_id))];
  const nomes = {};
  if (ids.length) {
    const { data: perfis } = await supabase.from("perfis_operacionais").select("id, nome, conta_id").in("id", ids);
    const contas = [...new Set((perfis ?? []).map((p) => p.conta_id))];
    const { data: cs } = contas.length ? await supabase.from("perfis").select("id, nome, email").in("id", contas) : { data: [] };
    const porConta = Object.fromEntries((cs ?? []).map((c) => [c.id, c]));
    for (const p of perfis ?? []) nomes[p.id] = { nome: p.nome ?? porConta[p.conta_id]?.nome ?? null, email: porConta[p.conta_id]?.email ?? null };
  }
  const agora = Date.now();
  return linhas.map((c) => ({ ...c, situacao: situacaoDaConcessao(c, agora), perfil_nome: nomes[c.perfil_id]?.nome ?? null, perfil_email: nomes[c.perfil_id]?.email ?? null }));
}

/** Perfis elegíveis a receber concessão na unidade (nunca o de exibição; a própria conta vem marcada). */
export async function perfisElegiveis({ unidadeId, atorId }) {
  const { data: unidade, error: eU } = await supabase.from("unidades").select("id, organizacao_id").eq("id", unidadeId).maybeSingle();
  if (eU) throw ApiError.internal("Falha ao consultar a unidade.");
  if (!unidade) throw ApiError.notFound("Unidade não encontrada.");
  const [vu, ve] = await Promise.all([
    supabase.from("usuarios_unidades").select("usuario_id, papel, ativo").eq("unidade_id", unidadeId),
    supabase.from("usuarios_organizacoes").select("usuario_id, papel, ativo").eq("organizacao_id", unidade.organizacao_id),
  ]);
  if (vu.error || ve.error) throw ApiError.internal("Falha ao consultar os vínculos.");
  const contasIds = [...new Set([...(vu.data ?? []), ...(ve.data ?? [])].map((v) => v.usuario_id))];
  if (!contasIds.length) return [];
  const [perfis, contas] = await Promise.all([
    supabase.from("perfis_operacionais").select("id, conta_id, nome").in("conta_id", contasIds).eq("ativo", true),
    supabase.from("perfis").select("id, nome, email").in("id", contasIds),
  ]);
  if (perfis.error || contas.error) throw ApiError.internal("Falha ao consultar os perfis.");
  return montarPerfisElegiveis({
    perfis: perfis.data ?? [], contas: Object.fromEntries((contas.data ?? []).map((c) => [c.id, c])),
    vinculosUnidade: vu.data ?? [], vinculosEmpresa: ve.data ?? [],
  }, atorId);
}

/** Histórico de auditoria das concessões (trilha append-only da migration 120). */
export async function auditoria({ unidadeId, perfilId, concessaoId } = {}) {
  let q = supabase.from("gestao_financeira_concessoes_auditoria")
    .select("id, concessao_id, organizacao_id, unidade_id, perfil_id, evento, nivel, ator_id, motivo, ocorreu_em")
    .order("ocorreu_em", { ascending: false }).limit(200);
  if (unidadeId) q = q.eq("unidade_id", unidadeId);
  if (perfilId) q = q.eq("perfil_id", perfilId);
  if (concessaoId) q = q.eq("concessao_id", concessaoId);
  const { data, error } = await q;
  if (error) throw ApiError.internal("Falha ao consultar a auditoria.");
  return data ?? [];
}

export async function conceder(req) {
  const dados = validarNovaConcessao(req.body, req.user.id);

  const { data: perfil, error: ePerfil } = await supabase
    .from("perfis_operacionais").select("id, conta_id, ativo").eq("id", dados.perfil_id).maybeSingle();
  if (ePerfil) throw ApiError.internal("Falha ao consultar o perfil.");
  garantirSemAutoconcessao(perfil?.conta_id, req.user.id);
  if (perfil.ativo !== true) throw ApiError.badRequest("Perfil inativo.");

  const { data: unidade, error: eUni } = await supabase
    .from("unidades").select("id, organizacao_id").eq("id", dados.unidade_id).maybeSingle();
  if (eUni) throw ApiError.internal("Falha ao consultar a unidade.");
  if (!unidade || unidade.organizacao_id !== dados.organizacao_id) throw ApiError.badRequest("A unidade não pertence à empresa informada.");

  const { data, error } = await supabase.from("gestao_financeira_concessoes").insert(dados).select(COLUNAS).single();
  if (error) throw traduzir(error);

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, acao: ACOES.FINANCEIRO_CONCESSAO_CONCEDIDA,
    entidade: "gestao_financeira_concessoes", entidadeId: data.id, organizacaoId: dados.organizacao_id,
    detalhes: { unidade_id: dados.unidade_id, perfil_id: dados.perfil_id, nivel: dados.nivel, somente_financeiro: dados.somente_financeiro, expira_em: dados.expira_em, motivo: dados.motivo },
    ...origem(req),
  });
  return data;
}

export async function revogar(req, id) {
  const { motivo } = validarRevogacao(req.body);
  const { data, error } = await supabase.from("gestao_financeira_concessoes")
    .update({ revogada_em: new Date().toISOString(), revogada_por: req.user.id, motivo_revogacao: motivo })
    .eq("id", id).is("revogada_em", null).select(COLUNAS).maybeSingle();
  if (error) throw traduzir(error);
  if (!data) throw ApiError.notFound("Concessão não encontrada ou já revogada.");

  // Efeito imediato: o gate financeiro relê a concessão a cada requisição. NENHUMA sessão operacional é encerrada.
  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, acao: ACOES.FINANCEIRO_CONCESSAO_REVOGADA,
    entidade: "gestao_financeira_concessoes", entidadeId: data.id, organizacaoId: data.organizacao_id,
    detalhes: { unidade_id: data.unidade_id, perfil_id: data.perfil_id, motivo },
    ...origem(req),
  });
  return data;
}
