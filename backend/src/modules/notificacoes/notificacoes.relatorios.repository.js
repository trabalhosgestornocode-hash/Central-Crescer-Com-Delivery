// Acesso a dados dos relatórios operacionais (diário/semanal) pela Central: fechamentos armazenados, resumo semanal, fila/auditoria de envios
// (migration 141) e a autorização ATUAL do destinatário. Sempre filtra por organização + unidade; nada daqui chama o iFood ou o gateway.
import { supabase } from "../../config/supabase.js";

const db = (deps) => deps?.supabase ?? supabase;
const falha = (error, o) => { throw new Error(`relatórios: falha ao ${o}: ${error.message}`); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exigir = (...ids) => { for (const id of ids) if (!UUID.test(String(id ?? ""))) throw new Error("relatórios: identificador inválido"); };

/** Unidades com o módulo do Checklist habilitado na UNIDADE (a empresa é conferida depois, por `modulosEfetivosDaUnidade`). */
export async function unidadesCandidatas(deps = {}) {
  const { data: um, error } = await db(deps).from("unidade_modulos").select("unidade_id").eq("modulo_id", "checklist_operacional");
  if (error) falha(error, "listar unidades com o módulo");
  const ids = (um ?? []).map((r) => r.unidade_id);
  if (!ids.length) return [];
  const { data, error: e2 } = await db(deps).from("unidades").select("id, organizacao_id, nome, timezone").in("id", ids);
  if (e2) falha(e2, "ler unidades");
  return (data ?? []).map((u) => ({ organizacaoId: u.organizacao_id, unidadeId: u.id, unidadeNome: u.nome, fusoUnidade: u.timezone ?? null }));
}

/** Versões armazenadas dos fechamentos diários no intervalo [de, ate] (inclusive). */
export async function fechamentosEntre({ organizacaoId, unidadeId, de, ate }, deps = {}) {
  exigir(organizacaoId, unidadeId);
  const { data, error } = await db(deps).from("operacional_fechamentos")
    .select("id, competencia, versao, status, hash_conteudo, indicadores, diagnostico, cobertura")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).gte("competencia", de).lte("competencia", ate)
    .order("competencia").order("versao", { ascending: false }).limit(200);
  if (error) falha(error, "ler fechamentos");
  return data ?? [];
}

/** Grava o resumo semanal (idempotente por unidade + semana + hash) e devolve o id. */
export async function registrarResumoSemanal({ organizacaoId, unidadeId, resumo, mensagem }, deps = {}) {
  exigir(organizacaoId, unidadeId);
  const linha = { organizacao_id: organizacaoId, unidade_id: unidadeId, semana_inicio: resumo.semanaInicio, status: resumo.status, dias_validos: resumo.diasValidos,
    dias_ausentes: resumo.diasAusentes, hash_conteudo: resumo.hash, indicadores: resumo.indicadores, mensagem };
  const ins = await db(deps).from("operacional_resumos_semanais").upsert(linha, { onConflict: "unidade_id,semana_inicio,hash_conteudo", ignoreDuplicates: true });
  if (ins.error) falha(ins.error, "gravar o resumo semanal");
  const { data, error } = await db(deps).from("operacional_resumos_semanais").select("id")
    .eq("unidade_id", unidadeId).eq("semana_inicio", resumo.semanaInicio).eq("hash_conteudo", resumo.hash).maybeSingle();
  if (error || !data) falha(error ?? { message: "resumo não encontrado após gravar" }, "ler o resumo semanal");
  return data.id;
}

/** Enfileira (idempotente pela chave). @returns {Promise<number>} quantos itens são NOVOS */
export async function enfileirar(linhas, deps = {}) {
  if (!linhas?.length) return 0;
  const chaves = linhas.map((l) => l.chave_idempotencia);
  const { data: ja, error: e0 } = await db(deps).from("operacional_relatorios_envios").select("chave_idempotencia").in("chave_idempotencia", chaves);
  if (e0) falha(e0, "conferir a fila");
  const existentes = new Set((ja ?? []).map((r) => r.chave_idempotencia));
  const novas = linhas.filter((l) => !existentes.has(l.chave_idempotencia));
  if (!novas.length) return 0;
  const { error } = await db(deps).from("operacional_relatorios_envios").upsert(novas, { onConflict: "chave_idempotencia", ignoreDuplicates: true });
  if (error) falha(error, "enfileirar");
  return novas.length;
}

export async function proximosPendentes({ limite = 10, agoraIso }, deps = {}) {
  const { data, error } = await db(deps).from("operacional_relatorios_envios")
    .select("id, organizacao_id, unidade_id, tipo, categoria, referencia, proposito, contato_empresa_id, chave_idempotencia, mensagem, status, tentativas, disponivel_em, expira_em")
    .in("status", ["PENDENTE", "ENVIANDO"]).lte("disponivel_em", agoraIso).order("disponivel_em").limit(limite);
  if (error) falha(error, "ler a fila");
  return data ?? [];
}

export async function reservar({ id, worker, leaseSegundos = 120, inicioDiaIso, maxPorDestinatarioDia = null }, deps = {}) {
  exigir(id);
  const { data, error } = await db(deps).rpc("operacional_relatorio_reservar", { p_id: id, p_worker: worker, p_lease_segundos: leaseSegundos, p_inicio_dia: inicioDiaIso, p_max_por_destinatario_dia: maxPorDestinatarioDia });
  if (error) falha(error, "reservar o envio");
  return data;
}

export async function finalizar({ id, worker, resultado, providerMessageId = null, motivo = null, retryAposSegundos = null }, deps = {}) {
  exigir(id);
  const { data, error } = await db(deps).rpc("operacional_relatorio_finalizar", { p_id: id, p_worker: worker, p_resultado: resultado, p_provider_message_id: providerMessageId, p_motivo: motivo, p_retry_apos_segundos: retryAposSegundos });
  if (error) falha(error, "finalizar o envio");
  return data;
}

/**
 * Autorização ATUAL do destinatário para a categoria NESTA unidade, lida na hora do envio (revogação, suspensão, desativação e opt-out valem).
 * @returns {Promise<{autorizado: boolean, motivo: string|null, telefoneE164?: string, contatoWhatsappId?: string|null}>}
 */
export async function autorizacaoAtual({ organizacaoId, unidadeId, contatoEmpresaId, categoria }, deps = {}) {
  exigir(organizacaoId, unidadeId, contatoEmpresaId);
  const d = db(deps);
  const [ce, esc, led] = await Promise.all([
    d.from("comunicacao_contatos_empresa").select("id, telefone_e164, ativo, whatsapp_status, contato_whatsapp_id").eq("organizacao_id", organizacaoId).eq("id", contatoEmpresaId).maybeSingle(),
    d.from("comunicacao_destinatario_escopos").select("habilitado, origem_autorizacao, suspenso_em").eq("contato_empresa_id", contatoEmpresaId).eq("unidade_escopo_id", unidadeId).eq("categoria", categoria).maybeSingle(),
    d.from("comunicacao_consentimentos").select("acao").eq("organizacao_id", organizacaoId).eq("contato_empresa_id", contatoEmpresaId).eq("categoria", categoria).in("acao", ["CONCEDIDO", "REVOGADO"]).order("ocorreu_em", { ascending: false }).limit(1),
  ]);
  for (const r of [ce, esc, led]) if (r.error) falha(r.error, "ler a autorização");
  const c = ce.data; const e = esc.data;
  if (!c || c.ativo !== true) return { autorizado: false, motivo: "DESTINATARIO_INATIVO" };
  if (c.whatsapp_status !== "VALIDADO") return { autorizado: false, motivo: "WHATSAPP_NAO_VALIDADO" };
  if (!e || e.habilitado !== true || e.suspenso_em) return { autorizado: false, motivo: "ESCOPO_INATIVO" };
  if (e.origem_autorizacao !== "CONVITE_OTP") return { autorizado: false, motivo: "ORIGEM_NAO_AUTORIZADA" };
  if (led.data?.[0]?.acao !== "CONCEDIDO") return { autorizado: false, motivo: "SEM_CONSENTIMENTO_VIGENTE" };
  let optOut = null;
  if (c.contato_whatsapp_id) {
    const cw = await d.from("contatos_whatsapp").select("opt_out").eq("id", c.contato_whatsapp_id).maybeSingle();
    if (cw.error) falha(cw.error, "ler opt-out"); optOut = cw.data?.opt_out;
  }
  if (optOut !== false) return { autorizado: false, motivo: "OPT_OUT" };         // ausente/indeterminado = fail-closed
  return { autorizado: true, motivo: null, telefoneE164: c.telefone_e164, contatoWhatsappId: c.contato_whatsapp_id };
}
