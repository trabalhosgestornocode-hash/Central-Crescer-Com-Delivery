// Acesso ao banco da Central de Notificações (service_role). Toda consulta filtra pela EMPRESA do contexto; a unidade permitida
// (D-3) é aplicada no service e revalidada nas RPCs. Nenhuma leitura devolve número em claro de convite/desafio (só cifrado ou
// máscara), código OTP ou token. Os números LEGADOS (comunicacao_contatos_empresa) já são guardados em claro pelo D-1 — aqui
// só viram máscara ou HMAC; nunca são devolvidos completos pela API.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

const db = (deps) => deps?.supabase ?? supabase;
const falha = (error, ctx) => { const e = ApiError.internal(`${ctx}: ${error.message}`); e.codigoBanco = error.code; throw e; };
const rpc = async (deps, nome, args) => {
  const { data, error } = await db(deps).rpc(nome, args);
  if (error) {
    if (error.code === "42501") throw ApiError.forbidden(error.message?.includes("ESCOPO_FORA") ? "Fora do seu alcance (unidade/empresa)." : error.message);
    if (error.code === "22023") throw ApiError.badRequest(error.message);
    falha(error, nome);
  }
  return data;
};

export async function listarCategorias(deps = {}) {
  const { data, error } = await db(deps).from("comunicacao_categorias")
    .select("codigo, rotulo, descricao, tipo_alerta, ativo, grupo, estado, transporte, exige_consentimento, ordem, cota").order("ordem");
  if (error) falha(error, "categorias");
  return data ?? [];
}

export async function listarUnidades({ organizacaoId }, deps = {}) {
  const { data, error } = await db(deps).from("unidades").select("id, nome, ativo, eh_teste, timezone").eq("organizacao_id", organizacaoId).order("nome");
  if (error) falha(error, "unidades");
  return data ?? [];
}

export async function listarDestinatarios({ organizacaoId }, deps = {}) {
  const d = db(deps);
  const { data: ces, error } = await d.from("comunicacao_contatos_empresa")
    .select("id, nome, tipo, telefone_e164, whatsapp_status, ativo, created_at, autorizacao_registrada_em, contato_whatsapp_id, observacoes")
    .eq("organizacao_id", organizacaoId).order("created_at");
  if (error) falha(error, "destinatários");
  const ids = (ces ?? []).map((c) => c.id);
  const contatoIds = (ces ?? []).map((c) => c.contato_whatsapp_id).filter(Boolean);
  const [cats, escs, contatos] = await Promise.all([
    ids.length ? d.from("comunicacao_destinatario_categorias").select("contato_empresa_id, categoria, habilitado").in("contato_empresa_id", ids) : { data: [] },
    ids.length ? d.from("comunicacao_destinatario_escopos")
      .select("id, contato_empresa_id, unidade_escopo_id, categoria, habilitado, origem_autorizacao, origem_vinculo, suspenso_em, suspenso_motivo, janela, silencio, notificar_correcao, verificacao_simulada, atualizado_em")
      .in("contato_empresa_id", ids) : { data: [] },
    contatoIds.length ? d.from("contatos_whatsapp").select("id, opt_out").in("id", contatoIds) : { data: [] },
  ]);
  for (const r of [cats, escs, contatos]) if (r.error) falha(r.error, "destinatários (detalhe)");
  return { destinatarios: ces ?? [], categoriasLegadas: cats.data ?? [], escopos: escs.data ?? [], contatos: contatos.data ?? [] };
}

export async function listarConsentimentos({ organizacaoId, contatoEmpresaIds }, deps = {}) {
  if (!contatoEmpresaIds?.length) return [];
  const { data, error } = await db(deps).from("comunicacao_consentimentos")
    .select("id, contato_empresa_id, unidade_escopo_id, categoria, acao, termo_versao, origem, simulado, ocorreu_em")
    .eq("organizacao_id", organizacaoId).in("contato_empresa_id", contatoEmpresaIds).order("ocorreu_em", { ascending: false }).limit(500);
  if (error) falha(error, "consentimentos");
  return data ?? [];
}

export async function listarConvites({ organizacaoId }, deps = {}) {
  const { data, error } = await db(deps).from("comunicacao_convites")
    .select("id, nome, tipo_destinatario, telefone_mascarado, unidades_pretendidas, categorias_pretendidas, contato_empresa_id, status, criado_em, expira_em, verificado_em, concluido_em, simulado, unidade_permitida")
    .eq("organizacao_id", organizacaoId).order("criado_em", { ascending: false }).limit(100);
  if (error) falha(error, "convites");
  return data ?? [];
}

export async function contarConvitesRecentes({ organizacaoId, criadoPor, unidadeId, desdeIso }, deps = {}) {
  const base = () => db(deps).from("comunicacao_convites").select("id", { count: "exact", head: true }).eq("organizacao_id", organizacaoId).gte("criado_em", desdeIso);
  const [porUsuario, porUnidade] = await Promise.all([
    criadoPor ? base().eq("criado_por", criadoPor) : { count: 0 },
    unidadeId ? base().contains("unidades_pretendidas", [unidadeId]) : { count: 0 },
  ]);
  return { porUsuario: porUsuario.count ?? 0, porUnidade: porUnidade.count ?? 0 };
}

export async function inserirConvite(linha, deps = {}) {
  const { data, error } = await db(deps).from("comunicacao_convites").insert(linha).select("id, expira_em").single();
  if (error) {
    if (error.code === "42501") throw ApiError.forbidden(error.message);
    if (error.code === "22023") throw ApiError.badRequest(error.message);
    falha(error, "convite");
  }
  return data;
}

export async function cancelarConvite({ organizacaoId, id }, deps = {}) {
  const { data, error } = await db(deps).from("comunicacao_convites").update({ status: "CANCELADO", cancelado_em: new Date().toISOString() })
    .eq("organizacao_id", organizacaoId).eq("id", id).in("status", ["PENDENTE", "VERIFICADO"]).select("id, unidades_pretendidas").maybeSingle();
  if (error) falha(error, "cancelar convite");
  return data;
}

/** Convite pelo hash do token (rota pública do titular). Devolve também o cifrado (o envio do OTP precisa dele). */
export async function obterConvitePorToken(tokenHash, deps = {}) {
  const { data, error } = await db(deps).from("comunicacao_convites")
    .select("id, organizacao_id, nome, telefone_cifrado, telefone_hmac, unidades_pretendidas, categorias_pretendidas, contato_empresa_id, status, expira_em, simulado")
    .eq("token_hash", tokenHash).maybeSingle();
  if (error) falha(error, "convite");
  return data;
}

export async function obterNomes({ organizacaoId, unidadeIds }, deps = {}) {
  const d = db(deps);
  const [org, uns] = await Promise.all([
    d.from("organizacoes").select("nome").eq("id", organizacaoId).maybeSingle(),
    unidadeIds?.length ? d.from("unidades").select("id, nome").in("id", unidadeIds) : { data: [] },
  ]);
  return { empresa: org.data?.nome ?? "a empresa", unidades: uns.data ?? [] };
}

export async function termoVigente(deps = {}) {
  const { data, error } = await db(deps).from("comunicacao_termos").select("versao, texto, hash, rascunho").order("versao", { ascending: false }).limit(1).maybeSingle();
  if (error) falha(error, "termo");
  return data;
}

export async function ultimoDesafioDoConvite(conviteId, deps = {}) {
  const { data, error } = await db(deps).from("comunicacao_desafios_titular").select("id, consumido_em, invalidado_em, expira_em, simulado")
    .eq("convite_id", conviteId).order("criado_em", { ascending: false }).limit(1).maybeSingle();
  if (error) falha(error, "desafio");
  return data;
}

export async function ultimoDesafioDeGestao(telefoneHmac, deps = {}) {
  const { data, error } = await db(deps).from("comunicacao_desafios_titular").select("id, consumido_em, invalidado_em, expira_em, simulado")
    .eq("telefone_hmac", telefoneHmac).eq("tipo", "gestao").order("criado_em", { ascending: false }).limit(1).maybeSingle();
  if (error) falha(error, "desafio");
  return data;
}

export async function obterDesafio(id, deps = {}) {
  const { data, error } = await db(deps).from("comunicacao_desafios_titular").select("id, tipo, convite_id, telefone_hmac, consumido_em, simulado").eq("id", id).maybeSingle();
  if (error) falha(error, "desafio");
  return data;
}

/** Destinatários (de qualquer empresa) com este número — para a página de gestão do titular. Busca pelo E.164 do legado. */
export async function destinatariosDoNumero(e164, deps = {}) {
  const { data, error } = await db(deps).from("comunicacao_contatos_empresa").select("id, organizacao_id, nome, ativo").eq("telefone_e164", e164);
  if (error) falha(error, "destinatários do número");
  return data ?? [];
}

export async function obterDestinatario({ organizacaoId, id }, deps = {}) {
  const { data, error } = await db(deps).from("comunicacao_contatos_empresa").select("id, organizacao_id, nome, telefone_e164, ativo").eq("organizacao_id", organizacaoId).eq("id", id).maybeSingle();
  if (error) falha(error, "destinatário");
  return data;
}

export async function historico({ organizacaoId, unidadeId = null, limite = 100 }, deps = {}) {
  const d = db(deps);
  let q1 = d.from("comunicacao_mensagens").select("id, unidade_id, contato_empresa_id, tipo, status, erro, created_at, enviado_em, entregue_em, lido_em, metadados")
    .eq("organizacao_id", organizacaoId).eq("direcao", "saida").order("created_at", { ascending: false }).limit(limite);
  let q2 = d.from("operacional_mensagens_simuladas").select("id, unidade_id, fechamento_id, fechamento_versao, status, transporte, criado_em, validacao")
    .eq("organizacao_id", organizacaoId).order("criado_em", { ascending: false }).limit(limite);
  if (unidadeId) { q1 = q1.eq("unidade_id", unidadeId); q2 = q2.eq("unidade_id", unidadeId); }
  const [r1, r2] = await Promise.all([q1, q2]);
  if (r1.error) falha(r1.error, "histórico");
  return { reais: r1.data ?? [], simuladas: r2.error ? [] : (r2.data ?? []) };
}

export async function auditoria({ organizacaoId, unidadeId = null, limite = 100 }, deps = {}) {
  let q = db(deps).from("plataforma_auditoria").select("id, acao, entidade, entidade_id, detalhes, created_at, perfil_id")
    .eq("organizacao_id", organizacaoId).like("acao", "notificacao.%").order("created_at", { ascending: false }).limit(limite);
  if (unidadeId) q = q.eq("detalhes->>unidade_id", unidadeId);
  const { data, error } = await q;
  if (error) falha(error, "auditoria");
  return data ?? [];
}

export const selecaoPorEscopoLigada = async (deps = {}) => (await rpc(deps, "comunicacao_selecao_por_escopo_ligada", {})) === true;
export const resolverD1PorUnidade = (p, deps = {}) => rpc(deps, "comunicacao_resolver_destinatarios_unidade", { p_organizacao_id: p.organizacaoId, p_unidade_id: p.unidadeId, p_tipo_alerta: "dashboard_ifood_d1" });
export const suspenderEscopo = (p, deps = {}) => rpc(deps, "comunicacao_escopo_suspender", {
  p_organizacao_id: p.organizacaoId, p_unidade_permitida: p.unidadePermitida, p_contato_empresa_id: p.contatoEmpresaId, p_unidade_id: p.unidadeId,
  p_categoria: p.categoria, p_suspender: p.suspender, p_motivo: p.motivo ?? null, p_ator: p.ator ?? null });
export const preferenciasEscopo = (p, deps = {}) => rpc(deps, "comunicacao_escopo_preferencias", {
  p_organizacao_id: p.organizacaoId, p_unidade_permitida: p.unidadePermitida, p_contato_empresa_id: p.contatoEmpresaId, p_unidade_id: p.unidadeId,
  p_categoria: p.categoria, p_habilitado: p.habilitado ?? null, p_janela: p.janela ?? null, p_silencio: p.silencio ?? null,
  p_notificar_correcao: p.notificarCorrecao ?? null, p_ator: p.ator ?? null });
export const vincularLegado = (p, deps = {}) => rpc(deps, "comunicacao_legado_vincular_unidade", {
  p_organizacao_id: p.organizacaoId, p_unidade_permitida: p.unidadePermitida, p_contato_empresa_id: p.contatoEmpresaId, p_unidade_id: p.unidadeId, p_ator: p.ator ?? null });
export const revogar = (p, deps = {}) => rpc(deps, "comunicacao_revogar", {
  p_telefone_hmac: p.telefoneHmac, p_contatos_empresa: p.contatosEmpresa, p_categorias: p.categorias ?? null, p_unidade_escopo_id: p.unidadeEscopoId ?? null,
  p_origem: p.origem, p_evidencia_id: p.evidenciaId ?? null, p_registrado_por: p.registradoPor ?? null, p_sair_de_tudo: !!p.sairDeTudo, p_ip_hmac: p.ipHmac ?? null });
export const criarDesafio = (p, deps = {}) => rpc(deps, "comunicacao_desafio_criar", {
  p_tipo: p.tipo, p_convite_id: p.conviteId ?? null, p_telefone_cifrado: p.telefoneCifrado, p_telefone_hmac: p.telefoneHmac,
  p_codigo_hmac: p.codigoHmac, p_ip_hmac: p.ipHmac ?? null, p_simulado: !!p.simulado, p_chave_versao: p.chaveVersao ?? 1, p_id: p.id ?? null });
export const verificarDesafio = (p, deps = {}) => rpc(deps, "comunicacao_desafio_verificar", { p_desafio_id: p.desafioId, p_codigo_hmac: p.codigoHmac });
export const consentir = (p, deps = {}) => rpc(deps, "comunicacao_titular_consentir", {
  p_convite_id: p.conviteId, p_desafio_id: p.desafioId, p_categorias: p.categorias, p_termo_versao: p.termoVersao,
  p_telefone_e164: p.telefoneE164, p_ip_hmac: p.ipHmac ?? null, p_user_agent: p.userAgent ?? null });
export const cotaCategoria = (p, deps = {}) => rpc(deps, "comunicacao_cota_categoria_disponivel", {
  p_categoria: p.categoria, p_contato_empresa_id: p.contatoEmpresaId, p_unidade_id: p.unidadeId, p_organizacao_id: p.organizacaoId, p_inicio_dia: p.inicioDiaIso });
export const ativarSelecao = (p, deps = {}) => rpc(deps, "comunicacao_ativar_selecao_por_escopo", {
  p_migracao_id: p.migracaoId, p_universo: p.universo, p_modulo_id: p.moduloId, p_ator: p.ator ?? null });
export const desativarSelecao = (p, deps = {}) => rpc(deps, "comunicacao_desativar_selecao_por_escopo", { p_ator: p.ator ?? null });
export async function estadoSelecao(deps = {}) {
  const { data, error } = await db(deps).from("comunicacao_configuracoes").select("valor, atualizado_em").eq("chave", "selecao_por_escopo").maybeSingle();
  if (error) falha(error, "seleção");
  return data?.valor ?? { ligada: false };
}
