// RESPONSÁVEL DE COMUNICAÇÃO POR EMPRESA (migration 091) — a ÚNICA fonte de "quem recebe os avisos
// desta empresa". Vínculo explícito:  EMPRESA -> RESPONSÁVEL -> TELEFONE -> VALIDAÇÃO DO WHATSAPP.
//
// NUNCA infere o responsável de: unidade selecionada, primeira unidade, perfil ativo, usuário
// associado, organização pai, matriz, `usuarios_organizacoes`/`usuarios_unidades`, sessão ou qualquer
// fallback. Acesso a uma empresa NÃO é ser responsável de comunicação (causa raiz do bug "Jailton Matos
// aparece em Subway Centro - Mogi Mirim": o perfil tem acesso ativo a 47 das 48 empresas).
//
// Toda função exige `organizacaoId` explícito e revalida que o contato PERTENCE a essa empresa: um id de
// contato de outra empresa é recusado (404 lógico), nunca "aceito porque existe".
//
// O responsável NÃO precisa ser usuário do sistema (`perfil_operacional_id` é opcional e informativo).

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { criarOuObterContato, confirmarConsentimentoEVerificacao, normalizarTelefone, mascararTelefone } from "./comunicacao.contatos.repo.js";

export const TIPOS_CONTATO_EMPRESA = Object.freeze(["principal", "secundario", "financeiro", "operacional"]);
export const STATUS_WHATSAPP = Object.freeze({
  NAO_VALIDADO: "NAO_VALIDADO", AGUARDANDO_VALIDACAO: "AGUARDANDO_VALIDACAO", VALIDADO: "VALIDADO", ERRO: "ERRO",
});

const COLUNAS = "id, organizacao_id, nome, telefone_e164, ddi, tipo, contato_whatsapp_id, whatsapp_status, whatsapp_validado_em, ativo, observacoes, perfil_operacional_id, created_at, updated_at";

/**
 * Todos os responsáveis de UMA empresa (ativos e inativos). Nunca sem `organizacaoId`.
 * @param {string} organizacaoId
 */
export async function listarDaEmpresa(organizacaoId, deps = {}) {
  if (!organizacaoId) throw ApiError.badRequest("Empresa obrigatória.");
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_contatos_empresa").select(COLUNAS).eq("organizacao_id", organizacaoId);
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/**
 * Responsáveis de VÁRIAS empresas numa consulta só (lote) — agrupados por empresa. Nada por unidade.
 * @param {string[]} organizacaoIds
 * @returns {Promise<Map<string, object[]>>}
 */
export async function listarDasEmpresas(organizacaoIds, deps = {}) {
  const db = deps.supabase ?? supabase;
  const porEmpresa = new Map();
  if (!organizacaoIds?.length) return porEmpresa;
  const { data, error } = await db.from("comunicacao_contatos_empresa").select(COLUNAS).in("organizacao_id", organizacaoIds);
  if (error) throw ApiError.internal(error.message);
  for (const c of data ?? []) {
    if (!porEmpresa.has(c.organizacao_id)) porEmpresa.set(c.organizacao_id, []);
    porEmpresa.get(c.organizacao_id).push(c);
  }
  return porEmpresa;
}

/**
 * VALIDAÇÃO PRÉ-ENVIO do responsável de UMA mensagem (função PURA). Devolve `{valido, motivo}`:
 *   SEM_RESPONSAVEL       a mensagem não aponta para um responsável da empresa (ou ele não é DESTA empresa)
 *   RESPONSAVEL_INATIVO   o responsável foi desativado
 *   WHATSAPP_NAO_VALIDADO o número não está VALIDADO nesta empresa
 *   TELEFONE_DIVERGENTE   o telefone/registro mudou desde o agendamento (trocar o número invalida a fila)
 * `contatoEmpresa` deve vir de `obterDaEmpresa` (que já devolve null para contato de OUTRA empresa).
 * @param {{job: object, contato: object|null, contatoEmpresa: object|null}} p
 * @returns {{valido: boolean, motivo: string|null}}
 */
export function avaliarResponsavelDaMensagem({ job, contato, contatoEmpresa }) {
  if (!contatoEmpresa || contatoEmpresa.organizacao_id !== job?.organizacao_id) return { valido: false, motivo: "SEM_RESPONSAVEL" };
  if (contatoEmpresa.ativo !== true) return { valido: false, motivo: "RESPONSAVEL_INATIVO" };
  if (contatoEmpresa.whatsapp_status !== "VALIDADO") return { valido: false, motivo: "WHATSAPP_NAO_VALIDADO" };
  if (!contato || contatoEmpresa.contato_whatsapp_id !== job.contato_id || contato.telefone_e164 !== contatoEmpresa.telefone_e164
      || (job.telefone_snapshot && job.telefone_snapshot !== contato.telefone_e164)) return { valido: false, motivo: "TELEFONE_DIVERGENTE" };
  return { valido: true, motivo: null };
}

/** O responsável principal ATIVO de uma lista (ou o principal inativo, para exibição), nunca "o primeiro". */
export function escolherPrincipal(contatos) {
  const principais = (contatos ?? []).filter((c) => c.tipo === "principal");
  return principais.find((c) => c.ativo) ?? principais[0] ?? null;
}

/**
 * Um responsável POR ID, exigindo que seja DESTA empresa. `null` se não existe OU é de outra empresa.
 * @param {{organizacaoId: string, contatoEmpresaId: string}} p
 */
export async function obterDaEmpresa({ organizacaoId, contatoEmpresaId }, deps = {}) {
  if (!organizacaoId || !contatoEmpresaId) return null;
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_contatos_empresa").select(COLUNAS).eq("id", contatoEmpresaId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data || data.organizacao_id !== organizacaoId) return null; // de outra empresa = como se não existisse
  return data;
}

async function apontarHabilitacao({ organizacaoId, contatoEmpresa }, deps) {
  const db = deps.supabase ?? supabase;
  const { data: existente, error: e1 } = await db.from("comunicacao_habilitacoes").select("organizacao_id").eq("organizacao_id", organizacaoId).maybeSingle();
  if (e1) throw ApiError.internal(e1.message);
  const ponteiro = {
    destinatario_contato_id: contatoEmpresa?.contato_whatsapp_id ?? null,
    destinatario_contato_empresa_id: contatoEmpresa?.id ?? null,
    destinatario_perfil_id: contatoEmpresa?.perfil_operacional_id ?? null,
  };
  if (existente) {
    // NUNCA toca `habilitado`/timezone/tipos: só o ponteiro do destinatário.
    const { error } = await db.from("comunicacao_habilitacoes").update(ponteiro).eq("organizacao_id", organizacaoId);
    if (error) throw ApiError.internal(error.message);
    return;
  }
  const { error } = await db.from("comunicacao_habilitacoes").insert({ organizacao_id: organizacaoId, habilitado: false, tipos_permitidos: [], ...ponteiro });
  if (error) throw ApiError.internal(error.message);
}

/**
 * Cria ou edita o responsável PRINCIPAL da empresa (a UI trabalha com 1; o banco aceita vários tipos).
 * TROCAR O TELEFONE invalida a validação (volta a AGUARDANDO_VALIDACAO) e aponta a habilitação para o
 * novo registro de telefone — que nasce SEM consentimento/verificação: a empresa não recebe nada até uma
 * nova confirmação humana. Não altera `habilitado`.
 *
 * @param {{organizacaoId: string, nome: string, telefoneE164: string, observacoes?: string|null, ativo?: boolean, perfilOperacionalId?: string|null}} p
 * @param {{contaId?: string, perfilId?: string, nome?: string}} autor
 */
export async function salvarResponsavelPrincipal({ organizacaoId, nome, telefoneE164, observacoes, ativo, perfilOperacionalId }, autor, deps = {}) {
  const db = deps.supabase ?? supabase;
  const nomeLimpo = String(nome ?? "").trim();
  if (!nomeLimpo) throw ApiError.badRequest("Informe o nome do responsável.", { codigo: "NOME_OBRIGATORIO" });
  const e164 = normalizarTelefone(telefoneE164);
  if (!e164) throw ApiError.badRequest("Telefone inválido.", { codigo: "TELEFONE_INVALIDO" });

  const { data: org, error: eo } = await db.from("organizacoes").select("id, nome").eq("id", organizacaoId).maybeSingle();
  if (eo) throw ApiError.internal(eo.message);
  if (!org) throw ApiError.notFound("Empresa não encontrada.");

  const atual = escolherPrincipal(await listarDaEmpresa(organizacaoId, deps));
  const trocouTelefone = !atual || atual.telefone_e164 !== e164;
  const contatoTel = trocouTelefone ? await criarOuObterContato({ telefoneE164: e164 }, deps) : null;

  let salvo;
  if (atual) {
    const campos = {
      nome: nomeLimpo,
      observacoes: observacoes === undefined ? atual.observacoes : (observacoes || null),
      ativo: ativo === undefined ? atual.ativo : ativo === true,
      atualizado_por: autor?.perfilId ?? null,
    };
    if (perfilOperacionalId !== undefined) campos.perfil_operacional_id = perfilOperacionalId || null;
    if (trocouTelefone) {
      Object.assign(campos, {
        telefone_e164: e164, contato_whatsapp_id: contatoTel.id,
        whatsapp_status: STATUS_WHATSAPP.AGUARDANDO_VALIDACAO, whatsapp_validado_em: null,
      });
    }
    const { data, error } = await db.from("comunicacao_contatos_empresa").update(campos).eq("id", atual.id).select(COLUNAS).single();
    if (error) throw ApiError.internal(error.message);
    salvo = data;
  } else {
    const { data, error } = await db.from("comunicacao_contatos_empresa").insert({
      organizacao_id: organizacaoId, nome: nomeLimpo, telefone_e164: e164, tipo: "principal",
      contato_whatsapp_id: contatoTel.id, whatsapp_status: STATUS_WHATSAPP.AGUARDANDO_VALIDACAO, whatsapp_validado_em: null,
      ativo: ativo === undefined ? true : ativo === true, observacoes: observacoes || null,
      perfil_operacional_id: perfilOperacionalId || null,
      criado_por: autor?.perfilId ?? null, atualizado_por: autor?.perfilId ?? null,
    }).select(COLUNAS).single();
    if (error) throw ApiError.internal(error.message);
    salvo = data;
  }

  await apontarHabilitacao({ organizacaoId, contatoEmpresa: salvo }, deps);
  await auditar({
    acao: ACOES.COMUNICACAO_RESPONSAVEL_ALTERADO, atorTipo: "usuario", atorId: autor?.contaId ?? null, perfilId: autor?.perfilId ?? null, perfilNome: autor?.nome ?? null,
    organizacaoId, entidade: "comunicacao_contatos_empresa", entidadeId: salvo.id,
    detalhes: { operacao: atual ? "editado" : "criado", telefone_mascarado: mascararTelefone(e164), telefone_alterado: trocouTelefone, ativo: salvo.ativo, tipo: "principal" },
  });
  return salvo;
}

/**
 * Ativa/desativa o recebimento de avisos de UM responsável DESTA empresa. Não mexe na validação do número.
 * @param {{organizacaoId: string, contatoEmpresaId: string, ativo: boolean}} p
 */
export async function definirAtivo({ organizacaoId, contatoEmpresaId, ativo }, autor, deps = {}) {
  const db = deps.supabase ?? supabase;
  const contato = await obterDaEmpresa({ organizacaoId, contatoEmpresaId }, deps);
  if (!contato) throw ApiError.notFound("Responsável não encontrado nesta empresa.");
  const { data, error } = await db.from("comunicacao_contatos_empresa")
    .update({ ativo: ativo === true, atualizado_por: autor?.perfilId ?? null }).eq("id", contatoEmpresaId).select(COLUNAS).single();
  if (error) throw ApiError.internal(error.message);
  await auditar({
    acao: ACOES.COMUNICACAO_RESPONSAVEL_ALTERADO, atorTipo: "usuario", atorId: autor?.contaId ?? null, perfilId: autor?.perfilId ?? null, perfilNome: autor?.nome ?? null,
    organizacaoId, entidade: "comunicacao_contatos_empresa", entidadeId: contatoEmpresaId,
    detalhes: { operacao: ativo === true ? "ativado" : "desativado", telefone_mascarado: mascararTelefone(contato.telefone_e164) },
  });
  return data;
}

/**
 * Valida o WhatsApp do responsável — confirmação HUMANA explícita (a decisão é do chamador/service, nunca
 * inferida). Confirma consentimento+verificação do registro do telefone e marca VALIDADO com data.
 * @param {{organizacaoId: string, contatoEmpresaId: string}} p
 */
export async function validarWhatsApp({ organizacaoId, contatoEmpresaId }, autor, deps = {}) {
  const db = deps.supabase ?? supabase;
  const contato = await obterDaEmpresa({ organizacaoId, contatoEmpresaId }, deps);
  if (!contato) throw ApiError.notFound("Responsável não encontrado nesta empresa.");
  if (!contato.contato_whatsapp_id) throw ApiError.badRequest("Este responsável não tem telefone registrado.", { codigo: "SEM_CONTATO" });
  await confirmarConsentimentoEVerificacao({
    contatoId: contato.contato_whatsapp_id, organizacaoId,
    atorId: autor?.contaId ?? null, perfilId: autor?.perfilId ?? null, perfilNome: autor?.nome ?? null, atorEmail: autor?.email ?? null,
    origem: "confirmacao_explicita_operador_painel_admin",
  }, deps);
  const { data, error } = await db.from("comunicacao_contatos_empresa")
    .update({ whatsapp_status: STATUS_WHATSAPP.VALIDADO, whatsapp_validado_em: new Date().toISOString(), atualizado_por: autor?.perfilId ?? null })
    .eq("id", contatoEmpresaId).select(COLUNAS).single();
  if (error) throw ApiError.internal(error.message);
  await auditar({
    acao: ACOES.COMUNICACAO_RESPONSAVEL_ALTERADO, atorTipo: "usuario", atorId: autor?.contaId ?? null, perfilId: autor?.perfilId ?? null, perfilNome: autor?.nome ?? null,
    organizacaoId, entidade: "comunicacao_contatos_empresa", entidadeId: contatoEmpresaId,
    detalhes: { operacao: "whatsapp_validado", telefone_mascarado: mascararTelefone(contato.telefone_e164) },
  });
  return data;
}
