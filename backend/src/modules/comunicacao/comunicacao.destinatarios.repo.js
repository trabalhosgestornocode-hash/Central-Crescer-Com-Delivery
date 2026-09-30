// DESTINATÁRIOS DA EMPRESA (migration 104) — VÁRIOS por empresa, cada um tratado individualmente:
//   EMPRESA -> DESTINATÁRIOS (comunicacao_contatos_empresa) -> TELEFONE (contatos_whatsapp: consentimento/verificação/opt-out) -> CATEGORIAS de aviso.
//
// Toda função exige `organizacaoId` explícito e revalida que o destinatário PERTENCE à empresa (um id de outra empresa é "não encontrado", nunca
// aceito). Telefone: normalizado para E.164 com DDI, validado (números obviamente inválidos são recusados) e NUNCA sai daqui completo para logs/auditoria
// (sempre mascarado). O teto de destinatários ATIVOS é do banco (trigger, configurável) — aqui só se traduz o erro.
//
// Reutiliza, sem duplicar: cadastro/validação/ativação de comunicacao.contatosEmpresa.repo.js e o registro de opt-out de comunicacao.contatos.repo.js.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { criarOuObterContato, normalizarTelefone, mascararTelefone, registrarOptOut } from "./comunicacao.contatos.repo.js";
import { TIPOS_CONTATO_EMPRESA, STATUS_WHATSAPP, obterDaEmpresa, listarDaEmpresa } from "./comunicacao.contatosEmpresa.repo.js";

const COLUNAS = "id, organizacao_id, nome, telefone_e164, tipo, contato_whatsapp_id, whatsapp_status, whatsapp_validado_em, ativo, observacoes, ativado_em, autorizacao_registrada_em, created_at, updated_at";
const conflito = (msg, codigo) => new ApiError(409, msg, { codigo });

const atorAuditoria = (autor) => ({
  atorTipo: "usuario", atorId: autor?.contaId ?? null, perfilId: autor?.perfilId ?? null, perfilNome: autor?.nome ?? null, atorEmail: autor?.email ?? null,
});

/**
 * Validação de NEGÓCIO do telefone, além do formato E.164: recusa números obviamente inválidos (todos os dígitos iguais, sequências) e, para o Brasil
 * (+55), exige DDD válido (11–99) e o tamanho nacional correto (10 fixo/11 celular; celular começa com 9). Pura.
 * @param {string|null} e164
 * @returns {{ok: boolean, motivo: string|null}}
 */
export function validarTelefoneOperacional(e164) {
  if (!e164 || !/^\+[1-9][0-9]{7,14}$/.test(e164)) return { ok: false, motivo: "Telefone inválido: informe o número com DDI e DDD." };
  const digitos = e164.slice(1);
  if (/^(\d)\1+$/.test(digitos)) return { ok: false, motivo: "Telefone inválido: dígitos repetidos." };
  const local = digitos.startsWith("55") ? digitos.slice(2) : null;
  if (local !== null) {
    if (local.length !== 10 && local.length !== 11) return { ok: false, motivo: "Telefone brasileiro inválido: use DDD + número (10 ou 11 dígitos)." };
    const ddd = Number(local.slice(0, 2));
    if (ddd < 11 || ddd > 99 || local[1] === "0") return { ok: false, motivo: "DDD inválido." };
    if (local.length === 11 && local[2] !== "9") return { ok: false, motivo: "Celular brasileiro deve começar com 9 após o DDD." };
    if (/^(\d)\1+$/.test(local.slice(2))) return { ok: false, motivo: "Telefone inválido: dígitos repetidos." };
  }
  return { ok: true, motivo: null };
}

/** Normaliza + valida o telefone informado pelo operador; lança 400 claro se inválido. */
export function telefoneOuErro(bruto) {
  const e164 = normalizarTelefone(bruto);
  const v = validarTelefoneOperacional(e164);
  if (!v.ok) throw ApiError.badRequest(v.motivo, { codigo: "TELEFONE_INVALIDO" });
  return e164;
}

/** Catálogo de categorias (ativas por padrão). */
export async function listarCategorias({ apenasAtivas = true } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  let q = db.from("comunicacao_categorias").select("codigo, rotulo, descricao, tipo_alerta, ativo").order("codigo");
  if (apenasAtivas) q = q.eq("ativo", true);
  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/** Categorias habilitadas por destinatário de UMA empresa: Map<contatoEmpresaId, string[]>. */
export async function listarCategoriasDaEmpresa(organizacaoId, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_destinatario_categorias")
    .select("contato_empresa_id, categoria, habilitado").eq("organizacao_id", organizacaoId).eq("habilitado", true);
  if (error) throw ApiError.internal(error.message);
  const mapa = new Map();
  for (const r of data ?? []) {
    if (!mapa.has(r.contato_empresa_id)) mapa.set(r.contato_empresa_id, []);
    mapa.get(r.contato_empresa_id).push(r.categoria);
  }
  return mapa;
}

/**
 * O destinatário tem habilitada alguma categoria ATIVA cujo tipo_alerta é `tipoAlerta`? (revalidação no JIT do envio — o banco já filtra ao agendar.)
 * @param {{contatoEmpresaId: string, tipoAlerta: string}} p
 */
export async function destinatarioRecebeTipo({ contatoEmpresaId, tipoAlerta }, deps = {}) {
  if (!contatoEmpresaId || !tipoAlerta) return false;
  const db = deps.supabase ?? supabase;
  const [cats, hab] = await Promise.all([
    db.from("comunicacao_categorias").select("codigo").eq("tipo_alerta", tipoAlerta).eq("ativo", true),
    db.from("comunicacao_destinatario_categorias").select("categoria").eq("contato_empresa_id", contatoEmpresaId).eq("habilitado", true),
  ]);
  if (cats.error) throw ApiError.internal(cats.error.message);
  if (hab.error) throw ApiError.internal(hab.error.message);
  const codigos = new Set((cats.data ?? []).map((c) => c.codigo));
  return (hab.data ?? []).some((h) => codigos.has(h.categoria));
}

async function validarCategorias(categorias, deps) {
  if (!Array.isArray(categorias) || categorias.some((c) => typeof c !== "string")) {
    throw ApiError.badRequest("categorias deve ser uma lista de códigos.", { codigo: "CATEGORIAS_INVALIDAS" });
  }
  const unicas = [...new Set(categorias)];
  const validas = new Set((await listarCategorias({ apenasAtivas: true }, deps)).map((c) => c.codigo));
  const invalida = unicas.find((c) => !validas.has(c));
  if (invalida) throw ApiError.badRequest(`Categoria inválida ou inativa: ${invalida}.`, { codigo: "CATEGORIA_INVALIDA" });
  return unicas;
}

/** Traduz os erros de banco do cadastro (teto de ativos, telefone duplicado) em 409 claros. */
function traduzirErroCadastro(error) {
  const msg = String(error?.message ?? "");
  if (/MAX_DESTINATARIOS_ATIVOS/.test(msg)) return conflito("A empresa atingiu o limite de destinatários ativos. Desative um antes de adicionar outro.", "LIMITE_DESTINATARIOS");
  if (String(error?.code) === "23505" || /ux_contatos_empresa/.test(msg)) return conflito("Já existe um destinatário ativo com este telefone nesta empresa.", "DESTINATARIO_DUPLICADO");
  return ApiError.internal(msg);
}

async function gravarCategorias({ organizacaoId, contatoEmpresaId, categorias, autor }, deps) {
  const db = deps.supabase ?? supabase;
  const { data: atuais, error: e0 } = await db.from("comunicacao_destinatario_categorias")
    .select("categoria, habilitado").eq("contato_empresa_id", contatoEmpresaId);
  if (e0) throw ApiError.internal(e0.message);
  const antes = new Set((atuais ?? []).filter((r) => r.habilitado).map((r) => r.categoria));
  const depois = new Set(categorias);
  const conhecidas = new Set((atuais ?? []).map((r) => r.categoria));
  const linhas = [
    ...categorias.map((categoria) => ({ contato_empresa_id: contatoEmpresaId, organizacao_id: organizacaoId, categoria, habilitado: true, habilitado_por: autor?.perfilId ?? null })),
    ...[...conhecidas].filter((c) => !depois.has(c)).map((categoria) => ({ contato_empresa_id: contatoEmpresaId, organizacao_id: organizacaoId, categoria, habilitado: false, habilitado_por: autor?.perfilId ?? null })),
  ];
  if (linhas.length) {
    const { error } = await db.from("comunicacao_destinatario_categorias").upsert(linhas, { onConflict: "contato_empresa_id,categoria" });
    if (error) throw ApiError.internal(error.message);
  }
  const habilitadas = categorias.filter((c) => !antes.has(c));
  const desabilitadas = [...antes].filter((c) => !depois.has(c));
  for (const categoria of habilitadas) {
    await auditar({ ...atorAuditoria(autor), acao: ACOES.COMUNICACAO_CATEGORIA_HABILITADA, organizacaoId, entidade: "comunicacao_contatos_empresa", entidadeId: contatoEmpresaId, detalhes: { categoria } });
  }
  for (const categoria of desabilitadas) {
    await auditar({ ...atorAuditoria(autor), acao: ACOES.COMUNICACAO_CATEGORIA_DESABILITADA, organizacaoId, entidade: "comunicacao_contatos_empresa", entidadeId: contatoEmpresaId, detalhes: { categoria } });
  }
  return { habilitadas, desabilitadas };
}

/**
 * Cadastra um destinatário da empresa. Nasce ATIVO, com o WhatsApp AGUARDANDO_VALIDACAO e SEM consentimento/verificação: não recebe nada até a
 * validação humana explícita. `categorias` obrigatório (subconjunto do catálogo ATIVO).
 * @param {{organizacaoId: string, nome: string, telefone: string, tipo?: string, categorias: string[], observacoes?: string|null}} p
 * @param {{contaId?: string, perfilId?: string, nome?: string, email?: string}} autor
 */
export async function criarDestinatario({ organizacaoId, nome, telefone, tipo = "secundario", categorias, observacoes = null }, autor, deps = {}) {
  const db = deps.supabase ?? supabase;
  const nomeLimpo = String(nome ?? "").trim();
  if (!nomeLimpo) throw ApiError.badRequest("Informe o nome do destinatário.", { codigo: "NOME_OBRIGATORIO" });
  if (!TIPOS_CONTATO_EMPRESA.includes(tipo)) throw ApiError.badRequest(`Tipo inválido. Aceito: ${TIPOS_CONTATO_EMPRESA.join(", ")}.`, { codigo: "TIPO_INVALIDO" });
  const e164 = telefoneOuErro(telefone);
  const cats = await validarCategorias(categorias ?? [], deps);
  if (!cats.length) throw ApiError.badRequest("Escolha ao menos um tipo de aviso.", { codigo: "CATEGORIAS_OBRIGATORIAS" });

  const { data: org, error: eo } = await db.from("organizacoes").select("id").eq("id", organizacaoId).maybeSingle();
  if (eo) throw ApiError.internal(eo.message);
  if (!org) throw ApiError.notFound("Empresa não encontrada.");

  const contato = await criarOuObterContato({ telefoneE164: e164 }, deps);
  const agora = new Date().toISOString();
  const { data, error } = await db.from("comunicacao_contatos_empresa").insert({
    organizacao_id: organizacaoId, nome: nomeLimpo, telefone_e164: e164, tipo, contato_whatsapp_id: contato.id,
    whatsapp_status: STATUS_WHATSAPP.AGUARDANDO_VALIDACAO, whatsapp_validado_em: null, ativo: true, ativado_em: agora,
    observacoes: observacoes || null, criado_por: autor?.perfilId ?? null, atualizado_por: autor?.perfilId ?? null,
  }).select(COLUNAS).single();
  if (error) throw traduzirErroCadastro(error);

  await gravarCategorias({ organizacaoId, contatoEmpresaId: data.id, categorias: cats, autor }, deps);
  await auditar({
    ...atorAuditoria(autor), acao: ACOES.COMUNICACAO_DESTINATARIO_CRIADO, organizacaoId, entidade: "comunicacao_contatos_empresa", entidadeId: data.id,
    detalhes: { telefone_mascarado: mascararTelefone(e164), tipo, categorias: cats },
  });
  return data;
}

/**
 * Edita nome/tipo/observações e, se vier, o TELEFONE. Trocar o número invalida a validação (volta a AGUARDANDO_VALIDACAO) e aponta para o novo registro
 * de telefone — que nasce sem consentimento/verificação: o destinatário não recebe nada até nova confirmação humana.
 */
export async function atualizarDestinatario({ organizacaoId, contatoEmpresaId, nome, telefone, tipo, observacoes }, autor, deps = {}) {
  const db = deps.supabase ?? supabase;
  const atual = await obterDaEmpresa({ organizacaoId, contatoEmpresaId }, deps);
  if (!atual) throw ApiError.notFound("Destinatário não encontrado nesta empresa.");
  const campos = { atualizado_por: autor?.perfilId ?? null };
  if (nome !== undefined) {
    const n = String(nome ?? "").trim();
    if (!n) throw ApiError.badRequest("Informe o nome do destinatário.", { codigo: "NOME_OBRIGATORIO" });
    campos.nome = n;
  }
  if (tipo !== undefined) {
    if (!TIPOS_CONTATO_EMPRESA.includes(tipo)) throw ApiError.badRequest(`Tipo inválido. Aceito: ${TIPOS_CONTATO_EMPRESA.join(", ")}.`, { codigo: "TIPO_INVALIDO" });
    campos.tipo = tipo;
  }
  if (observacoes !== undefined) campos.observacoes = observacoes || null;
  let trocouTelefone = false;
  if (telefone !== undefined) {
    const e164 = telefoneOuErro(telefone);
    if (e164 !== atual.telefone_e164) {
      trocouTelefone = true;
      const contato = await criarOuObterContato({ telefoneE164: e164 }, deps);
      Object.assign(campos, { telefone_e164: e164, contato_whatsapp_id: contato.id, whatsapp_status: STATUS_WHATSAPP.AGUARDANDO_VALIDACAO, whatsapp_validado_em: null, autorizacao_registrada_em: null, autorizacao_registrada_por: null });
    }
  }
  const { data, error } = await db.from("comunicacao_contatos_empresa").update(campos).eq("id", contatoEmpresaId).eq("organizacao_id", organizacaoId).select(COLUNAS).single();
  if (error) throw traduzirErroCadastro(error);
  if (trocouTelefone) {
    await auditar({
      ...atorAuditoria(autor), acao: ACOES.COMUNICACAO_DESTINATARIO_NUMERO_ALTERADO, organizacaoId, entidade: "comunicacao_contatos_empresa", entidadeId: contatoEmpresaId,
      detalhes: { de_mascarado: mascararTelefone(atual.telefone_e164), para_mascarado: mascararTelefone(data.telefone_e164) },
    });
  }
  return { destinatario: data, telefoneAlterado: trocouTelefone };
}

/** Define EXATAMENTE as categorias habilitadas do destinatário (as demais ficam desabilitadas). */
export async function definirCategorias({ organizacaoId, contatoEmpresaId, categorias }, autor, deps = {}) {
  const atual = await obterDaEmpresa({ organizacaoId, contatoEmpresaId }, deps);
  if (!atual) throw ApiError.notFound("Destinatário não encontrado nesta empresa.");
  const cats = await validarCategorias(categorias ?? [], deps);
  const r = await gravarCategorias({ organizacaoId, contatoEmpresaId, categorias: cats, autor }, deps);
  return { categorias: cats, ...r };
}

/** Ativa/desativa UM destinatário. Desativar é imediato (o envio revalida `ativo` no JIT). Ativar respeita o teto do banco. */
export async function definirAtivoDestinatario({ organizacaoId, contatoEmpresaId, ativo }, autor, deps = {}) {
  const db = deps.supabase ?? supabase;
  const atual = await obterDaEmpresa({ organizacaoId, contatoEmpresaId }, deps);
  if (!atual) throw ApiError.notFound("Destinatário não encontrado nesta empresa.");
  if (atual.ativo === (ativo === true)) return { destinatario: atual, alterou: false };
  const campos = { ativo: ativo === true, atualizado_por: autor?.perfilId ?? null };
  if (ativo === true) campos.ativado_em = new Date().toISOString();
  const { data, error } = await db.from("comunicacao_contatos_empresa").update(campos).eq("id", contatoEmpresaId).eq("organizacao_id", organizacaoId).select(COLUNAS).single();
  if (error) throw traduzirErroCadastro(error);
  await auditar({
    ...atorAuditoria(autor), acao: ativo === true ? ACOES.COMUNICACAO_DESTINATARIO_ATIVADO : ACOES.COMUNICACAO_DESTINATARIO_DESATIVADO,
    organizacaoId, entidade: "comunicacao_contatos_empresa", entidadeId: contatoEmpresaId, detalhes: { telefone_mascarado: mascararTelefone(atual.telefone_e164) },
  });
  return { destinatario: data, alterou: true };
}

/**
 * Registra o OPT-OUT de um destinatário (a pessoa pediu para parar). Bloqueia imediatamente qualquer envio proativo a esse telefone (todas as empresas
 * em que ele constar). Nunca reativado automaticamente. Reaproveita `registrarOptOut` (que audita). Não implementa chatbot: registro é ato do operador.
 */
export async function registrarOptOutDestinatario({ organizacaoId, contatoEmpresaId }, autor, deps = {}) {
  const atual = await obterDaEmpresa({ organizacaoId, contatoEmpresaId }, deps);
  if (!atual) throw ApiError.notFound("Destinatário não encontrado nesta empresa.");
  if (!atual.contato_whatsapp_id) throw ApiError.badRequest("Este destinatário não tem telefone registrado.", { codigo: "SEM_CONTATO" });
  await registrarOptOut({ contatoId: atual.contato_whatsapp_id, origem: "operador_painel_admin" }, deps);
  return { contatoEmpresaId, optOut: true };
}

/** Destinatários (todos) de UMA empresa + categorias habilitadas de cada um. Telefone COMPLETO — quem expõe ao frontend mascara. */
export async function listarDestinatariosDaEmpresa(organizacaoId, deps = {}) {
  const [lista, categorias] = await Promise.all([listarDaEmpresa(organizacaoId, deps), listarCategoriasDaEmpresa(organizacaoId, deps)]);
  return lista.map((d) => ({ ...d, categorias: categorias.get(d.id) ?? [] }));
}
