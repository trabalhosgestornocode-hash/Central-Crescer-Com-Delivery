// Contatos de WhatsApp e o vínculo N:N com perfis operacionais.
//
// INVARIANTE CENTRAL (ajuste aprovado no Checkpoint A): telefone NUNCA
// autentica nem autoriza sozinho. Toda resolução aqui SEMPRE revalida o
// vínculo contra organização/unidade reais (usuarios_organizacoes /
// usuarios_unidades) — nunca confia só em "este telefone está ligado a
// este perfil" para decidir o que ele pode ver.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { auditar, ACOES } from "../../shared/auditoria.js";

const RE_E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * Normaliza um telefone para E.164. Pura — sem I/O — testável isolada.
 * Aceita dígitos com ou sem símbolos; assume Brasil (+55) quando não há
 * DDI explícito e o número tem cara de nacional (10-11 dígitos).
 * @param {string} bruto
 * @returns {string|null} E.164 válido, ou null se não der para normalizar
 */
export function normalizarTelefone(bruto) {
  if (!bruto) return null;
  let s = String(bruto).trim();
  const comMais = s.startsWith("+");
  const digitos = s.replace(/\D/g, "");
  if (!digitos) return null;

  let e164;
  if (comMais) {
    e164 = `+${digitos}`;
  } else if (digitos.length === 10 || digitos.length === 11) {
    e164 = `+55${digitos}`; // nacional sem DDI — assume Brasil
  } else {
    e164 = `+${digitos}`;
  }
  return RE_E164.test(e164) ? e164 : null;
}

/** Mascara um telefone para log/auditoria — nunca o número completo. */
export function mascararTelefone(e164) {
  if (!e164) return null;
  const s = String(e164);
  return s.length <= 4 ? "****" : `${s.slice(0, 4)}${"*".repeat(Math.max(0, s.length - 6))}${s.slice(-2)}`;
}

/**
 * Cria o contato se não existir (idempotente por telefone_e164).
 * @param {{telefoneE164: string, ddi?: string|null, ddd?: string|null}} params
 * @param {{supabase?: any}} [deps]
 */
export async function criarOuObterContato({ telefoneE164, ddi = null, ddd = null }, deps = {}) {
  const e164 = normalizarTelefone(telefoneE164);
  if (!e164) throw ApiError.badRequest("Telefone inválido.", { codigo: "TELEFONE_INVALIDO" });
  const db = deps.supabase ?? supabase;

  const existente = await db.from("contatos_whatsapp").select("*").eq("telefone_e164", e164).maybeSingle();
  if (existente.error) throw ApiError.internal(existente.error.message);
  if (existente.data) return existente.data;

  const { data, error } = await db.from("contatos_whatsapp")
    .insert({ telefone_e164: e164, ddi, ddd }).select("*").single();
  if (error) throw ApiError.internal(error.message);
  return data;
}

/**
 * Vincula um contato a um perfil operacional (idempotente). `principal`
 * é só sinal de UX — nunca usado para pular a revalidação de vínculo real.
 * @param {{contatoId: string, perfilOperacionalId: string, principal?: boolean}} params
 */
export async function vincularPerfil({ contatoId, perfilOperacionalId, principal = false }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("contatos_whatsapp_perfis")
    .upsert(
      { contato_id: contatoId, perfil_operacional_id: perfilOperacionalId, ativo: true, principal },
      { onConflict: "contato_id,perfil_operacional_id" },
    ).select("*").single();
  if (error) throw ApiError.internal(error.message);
  return data;
}

/**
 * Marca opt-out — bloqueia QUALQUER envio proativo futuro para este
 * contato (o Policy Engine consulta este campo). Nunca reativado
 * automaticamente. Sempre auditado (item obrigatório do pedido original).
 * @param {{contatoId: string, origem: string}} params  `origem` ex.: "usuario_solicitou_via_whatsapp"
 */
export async function registrarOptOut({ contatoId, origem }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const agora = new Date().toISOString();
  const { data, error } = await db.from("contatos_whatsapp")
    .update({ opt_out: true, opt_out_em: agora }).eq("id", contatoId).select("telefone_e164").single();
  if (error) throw ApiError.internal(error.message);

  await auditar({
    acao: ACOES.COMUNICACAO_OPT_OUT_REGISTRADO,
    atorTipo: "sistema",
    entidade: "contatos_whatsapp",
    entidadeId: contatoId,
    detalhes: { telefone_mascarado: mascararTelefone(data?.telefone_e164), origem },
  });
  return true;
}

/**
 * Resolve QUAL perfil este contato representa DENTRO do escopo de uma
 * organização/unidade específica — nunca "o perfil principal", sempre
 * revalidado contra o vínculo real (usuarios_organizacoes/usuarios_unidades).
 *
 * Devolve:
 *   - {perfilId}               exatamente 1 perfil vinculado E com vínculo
 *                               real na organização/unidade — caso normal.
 *   - null                     nenhum perfil vinculado tem vínculo real ali
 *                               (SEM_VINCULO — o Policy Engine bloqueia).
 *   - {ambiguo: true, perfis}  mais de um perfil vinculado tem vínculo real
 *                               ali — recusa escolher sozinho (teste 20).
 *
 * @param {{contatoId: string, organizacaoId: string, unidadeId?: string|null}} params
 */
export async function resolverPerfilDoContato({ contatoId, organizacaoId, unidadeId = null }, deps = {}) {
  const db = deps.supabase ?? supabase;

  const vinc = await db.from("contatos_whatsapp_perfis")
    .select("perfil_operacional_id").eq("contato_id", contatoId).eq("ativo", true);
  if (vinc.error) throw ApiError.internal(vinc.error.message);
  const perfilIds = (vinc.data ?? []).map((r) => r.perfil_operacional_id);
  if (!perfilIds.length) return null;

  let validos;
  if (unidadeId) {
    const r = await db.from("usuarios_unidades")
      .select("perfil_id").eq("unidade_id", unidadeId).in("perfil_id", perfilIds);
    if (r.error) throw ApiError.internal(r.error.message);
    validos = new Set((r.data ?? []).map((x) => x.perfil_id));
  } else {
    const r = await db.from("usuarios_organizacoes")
      .select("perfil_id").eq("organizacao_id", organizacaoId).in("perfil_id", perfilIds);
    if (r.error) throw ApiError.internal(r.error.message);
    validos = new Set((r.data ?? []).map((x) => x.perfil_id));
  }

  const candidatos = perfilIds.filter((id) => validos.has(id));
  if (candidatos.length === 0) return null;
  if (candidatos.length > 1) return { ambiguo: true, perfis: candidatos };
  return { perfilId: candidatos[0] };
}

/** @param {string} id */
export async function obterContato(id, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("contatos_whatsapp").select("*").eq("id", id).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data;
}

/** @param {string} id */
export async function obterPerfilOperacional(id, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("perfis_operacionais").select("id, ativo").eq("id", id).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data;
}

/**
 * Este perfil tem vínculo REAL (usuarios_organizacoes/usuarios_unidades)
 * com a organização/unidade dadas? Revalidação usada no envio — nunca
 * confia só no `contatos_whatsapp_perfis` (que é só "este telefone PODE
 * representar este perfil", não "este perfil tem acesso a este tenant").
 * @param {{perfilId: string, organizacaoId: string, unidadeId?: string|null}} params
 */
export async function perfilTemVinculo({ perfilId, organizacaoId, unidadeId = null }, deps = {}) {
  const db = deps.supabase ?? supabase;
  if (unidadeId) {
    const { data, error } = await db.from("usuarios_unidades").select("perfil_id").eq("perfil_id", perfilId).eq("unidade_id", unidadeId).maybeSingle();
    if (error) throw ApiError.internal(error.message);
    return !!data;
  }
  const { data, error } = await db.from("usuarios_organizacoes").select("perfil_id").eq("perfil_id", perfilId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return !!data;
}

/**
 * Caminho INVERSO de `resolverPerfilDoContato`: dada uma unidade com
 * pendência, quais contatos de WhatsApp já vinculados a um perfil daquela
 * unidade existem? É a base (simples, de propósito) para
 * `comunicacao.alertas.service.js#agendarEnviosPendentes` escolher um
 * destinatário. Sem UI de "quem recebe" ainda (Checkpoint D/E) isto só
 * encontra algo se um contato já foi vinculado manualmente (ex.: fixture
 * de teste) — em produção, greenfield, devolve lista vazia até então.
 * @param {{organizacaoId: string, unidadeId: string}} params
 * @returns {Promise<Array<{contatoId: string, perfilId: string, telefoneE164: string, principal: boolean}>>}
 */
export async function resolverContatosDaUnidade({ organizacaoId, unidadeId }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const uu = await db.from("usuarios_unidades").select("perfil_id").eq("unidade_id", unidadeId);
  if (uu.error) throw ApiError.internal(uu.error.message);
  const perfilIds = [...new Set((uu.data ?? []).map((r) => r.perfil_id).filter(Boolean))];
  if (!perfilIds.length) return [];

  // FAIL-CLOSED (D.3-C): só é candidato a mensagem PROATIVA quem tem
  // consentimento EXPLÍCITO e telefone verificado e não pediu para parar.
  // Ter o telefone cadastrado não basta. (A decisão final continua sendo do
  // Policy Engine no momento do envio — isto só evita AGENDAR para quem já
  // se sabe que não pode receber.)
  const { data, error } = await db.from("contatos_whatsapp_perfis")
    .select("contato_id, perfil_operacional_id, principal, created_at, contatos_whatsapp!inner(telefone_e164, opt_out, consentimento, verificado)")
    .in("perfil_operacional_id", perfilIds)
    .eq("ativo", true)
    .eq("contatos_whatsapp.opt_out", false)
    .eq("contatos_whatsapp.consentimento", true)
    .eq("contatos_whatsapp.verificado", true)
    .order("principal", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw ApiError.internal(error.message);

  return (data ?? []).map((r) => ({
    contatoId: r.contato_id,
    perfilId: r.perfil_operacional_id,
    telefoneE164: r.contatos_whatsapp?.telefone_e164 ?? null,
    principal: r.principal,
  }));
}
