// ROSTER AUTORIZADO da Central de Comunicação — a fonte ÚNICA de "quem a Central reconhece".
//
// Um contato só existe para a Central se for um RESPONSÁVEL DE COMUNICAÇÃO CADASTRADO de uma empresa: EMPRESA → RESPONSÁVEL (ativo) → TELEFONE
// (WhatsApp validado). Nunca "perfil com acesso à empresa" (migration 100: o perfil administrador com acesso a 47 empresas aparecia em todas). As
// unidades da empresa entram só para EXIBIÇÃO. A regra vive UMA vez, no banco (view `comunicacao_roster_autorizado`, 096, redefinida na 100); inbound, lista de conversas,
// destinatários e envio manual leem daqui — nenhum deles decide "quem é autorizado" por conta própria, e o frontend nunca decide.
//
// Este módulo é: (1) leitura da view (paginada — a view tem 1 linha por contato × empresa × unidade) e (2) agregação PURA em UM contato por telefone.
// Um telefone ligado a várias unidades/empresas é UMA conversa, com chips de unidades.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

const VISAO = "comunicacao_roster_autorizado";
const PAGINA = 1000;

/** Rótulos de negócio dos papéis (cargo/função) que existem no banco — nada inventado. */
export const ROTULO_PAPEL = Object.freeze({
  organization_admin: "Administrador da empresa", unit_manager: "Gestor de unidade", finance: "Financeiro", operations: "Operação", viewer: "Consulta",
  // tipos do RESPONSÁVEL DE COMUNICAÇÃO (migration 100)
  principal: "Responsável principal", secundario: "Responsável secundário", financeiro: "Financeiro", operacional: "Operação",
});
const PRIORIDADE_PAPEL = ["principal", "secundario", "financeiro", "operacional", "organization_admin", "unit_manager", "operations", "finance", "viewer"];

/** Minúsculo, sem acento, sem espaços nas pontas — a mesma normalização de busca do resto da Central. */
export const normalizarBusca = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Iniciais para o avatar quando não há foto (duas letras no máximo). */
export function iniciais(nome) {
  const partes = String(nome ?? "").trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return "?";
  const a = Array.from(partes[0])[0] ?? "";
  const b = partes.length > 1 ? (Array.from(partes[partes.length - 1])[0] ?? "") : "";
  return (a + b).toLocaleUpperCase("pt-BR") || "?";
}

const porNome = (a, b) => String(a.nome).localeCompare(String(b.nome), "pt-BR");

/**
 * Linhas da view → UM contato por `contato_id`. Determinístico (ordenado por nome), sem duplicar empresa/unidade/perfil.
 * @param {Array<object>} linhas
 * @returns {Array<{contatoId: string, telefoneE164: string, consentimento: boolean, verificado: boolean, optOut: boolean,
 *   nome: string, perfis: Array<{perfilId: string, nome: string}>, organizacoes: Array<{organizacaoId: string, nome: string}>,
 *   unidades: Array<{unidadeId: string, nome: string, organizacaoId: string}>, papeis: string[], cargo: string|null}>}
 */
export function agruparRoster(linhas) {
  const mapa = new Map();
  for (const l of linhas ?? []) {
    if (!l?.contato_id) continue;
    let c = mapa.get(l.contato_id);
    if (!c) {
      c = {
        contatoId: l.contato_id, telefoneE164: l.telefone_e164, consentimento: l.consentimento === true, verificado: l.verificado === true, optOut: l.opt_out === true,
        _perfis: new Map(), _orgs: new Map(), _unidades: new Map(), _papeis: new Set(), _responsaveis: new Map(),
      };
      mapa.set(l.contato_id, c);
    }
    // "perfis" = os RESPONSÁVEIS de comunicação (id do responsável, nunca de perfil/usuário) — mantém o formato que a Central já consome.
    const rid = l.responsavel_id ?? l.perfil_id; // (compatível com linhas antigas do roster: sem responsavel_id, o perfil_id fazia esse papel)
    if (rid) {
      c._perfis.set(rid, { perfilId: rid, nome: l.responsavel_nome ?? l.perfil_nome ?? "" });
      if (l.responsavel_id) c._responsaveis.set(l.responsavel_id, { id: l.responsavel_id, organizacaoId: l.organizacao_id, nome: l.responsavel_nome ?? "" });
    }
    if (l.organizacao_id) c._orgs.set(l.organizacao_id, { organizacaoId: l.organizacao_id, nome: l.organizacao_nome ?? "" });
    if (l.unidade_id) c._unidades.set(l.unidade_id, { unidadeId: l.unidade_id, nome: l.unidade_nome ?? "", organizacaoId: l.organizacao_id });
    if (l.papel) c._papeis.add(l.papel);
  }
  return [...mapa.values()].map((c) => {
    const perfis = [...c._perfis.values()].sort(porNome);
    const papeis = PRIORIDADE_PAPEL.filter((p) => c._papeis.has(p));
    return {
      contatoId: c.contatoId, telefoneE164: c.telefoneE164, consentimento: c.consentimento, verificado: c.verificado, optOut: c.optOut,
      nome: perfis[0]?.nome || "Responsável", perfis, responsaveis: [...c._responsaveis.values()],
      organizacoes: [...c._orgs.values()].sort(porNome), unidades: [...c._unidades.values()].sort(porNome),
      papeis, cargo: papeis.length ? ROTULO_PAPEL[papeis[0]] ?? null : null,
    };
  }).sort(porNome);
}

async function lerVisao(filtro, deps) {
  const db = deps.supabase ?? supabase;
  const linhas = [];
  for (let de = 0; ; de += PAGINA) {
    let q = db.from(VISAO).select("*");
    if (filtro) q = filtro(q);
    const { data, error } = await q.order("contato_id", { ascending: true }).range(de, de + PAGINA - 1);
    if (error) throw ApiError.internal(error.message);
    linhas.push(...(data ?? []));
    if ((data ?? []).length < PAGINA) break;
  }
  return linhas;
}

/** Todos os contatos autorizados (uma entrada por telefone). */
export async function listarRoster(deps = {}) {
  return agruparRoster(await lerVisao(null, deps));
}

/** O contato autorizado deste telefone (E.164), ou `null` — desconhecido NUNCA é tratado como autorizado. */
export async function buscarAutorizadoPorTelefone(telefoneE164, deps = {}) {
  if (typeof telefoneE164 !== "string" || !/^\+[1-9][0-9]{7,14}$/.test(telefoneE164)) return null;
  const linhas = await lerVisao((q) => q.eq("telefone_e164", telefoneE164), deps);
  return agruparRoster(linhas)[0] ?? null;
}

/** O contato autorizado com este id, ou `null`. */
export async function buscarAutorizadoPorId(contatoId, deps = {}) {
  if (typeof contatoId !== "string" || contatoId === "") return null;
  const linhas = await lerVisao((q) => q.eq("contato_id", contatoId), deps);
  return agruparRoster(linhas)[0] ?? null;
}
