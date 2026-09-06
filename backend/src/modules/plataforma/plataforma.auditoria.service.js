// Consulta da auditoria e dos logs da plataforma.
//
// Somente LEITURA — de propósito. Não existe endpoint de escrita ou exclusão
// aqui: o registro é feito por `shared/auditoria.js` durante as ações, e a
// migration 020 instala triggers que recusam UPDATE/DELETE/TRUNCATE na tabela.
// O requisito "esses registros nunca poderão ser apagados" é cumprido no banco,
// não pela ausência de uma rota — uma rota ausente se adiciona; um trigger é
// uma barreira de verdade.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { buscar } from "./plataforma.repo.js";
import { ACOES } from "../../shared/auditoria.js";
import * as v from "../../shared/validar.js";

/**
 * @param {object} filtros
 * @param {string} [filtros.acao]
 * @param {string} [filtros.atorId]
 * @param {string} [filtros.organizacaoId]
 * @param {string} [filtros.entidade]
 * @param {string} [filtros.busca]      texto livre em e-mail/ação
 * @param {string} [filtros.desde]      data ISO
 * @param {string} [filtros.ate]        data ISO
 * @param {boolean} [filtros.soImpersonacao]
 * @param {unknown} [filtros.limite]
 */
export async function listarAuditoria(filtros = {}) {
  let q = supabase.from("plataforma_auditoria")
    .select("id, ator_id, ator_email, ator_tipo, acao, entidade, entidade_id, organizacao_id, impersonado_por, detalhes, ip, user_agent, created_at")
    .order("created_at", { ascending: false })
    .limit(v.limite(filtros.limite, 100, 1, 500));

  if (filtros.acao) q = q.eq("acao", v.texto(filtros.acao, "Ação", { max: 80 }));
  if (filtros.atorId) q = q.eq("ator_id", v.uuid(filtros.atorId, "Usuário"));
  if (filtros.organizacaoId) q = q.eq("organizacao_id", v.uuid(filtros.organizacaoId, "Empresa"));
  if (filtros.entidade) q = q.eq("entidade", v.texto(filtros.entidade, "Entidade", { max: 40 }));
  if (filtros.desde) q = q.gte("created_at", v.dataOpcional(filtros.desde, "Data inicial"));
  // `ate` recebe o dia inteiro: filtrar por `<= 2026-07-29` excluiria tudo o
  // que aconteceu nesse dia depois da meia-noite.
  if (filtros.ate) q = q.lt("created_at", proximoDia(v.dataOpcional(filtros.ate, "Data final")));
  if (filtros.soImpersonacao) q = q.not("impersonado_por", "is", null);
  if (filtros.busca) {
    const termo = v.texto(filtros.busca, "Busca", { max: 120 }).replace(/[%,()]/g, " ");
    q = q.or(`ator_email.ilike.%${termo}%,acao.ilike.%${termo}%,entidade_id.ilike.%${termo}%`);
  }

  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);

  const registros = data ?? [];
  const nomesEmpresa = await mapearEmpresas(registros.map((r) => r.organizacao_id));

  return registros.map((r) => ({
    id: r.id,
    atorId: r.ator_id,
    atorEmail: r.ator_email,
    atorTipo: r.ator_tipo,
    acao: r.acao,
    acaoRotulo: rotuloAcao(r.acao),
    entidade: r.entidade,
    entidadeId: r.entidade_id,
    organizacaoId: r.organizacao_id,
    empresaNome: r.organizacao_id ? nomesEmpresa.get(r.organizacao_id) ?? "(excluída)" : null,
    impersonado: !!r.impersonado_por,
    detalhes: r.detalhes,
    ip: r.ip,
    userAgent: r.user_agent,
    em: r.created_at,
  }));
}

/** Só os acessos de suporte (superadmin dentro de empresa) — a trilha crítica. */
export async function listarImpersonacoes({ limite } = {}) {
  return listarAuditoria({ soImpersonacao: true, limite: v.limite(limite, 100) });
}

/**
 * Filtros disponíveis para o painel montar os seletores, com contagem por ação.
 * Vem do próprio dado: um filtro que oferece ações que nunca ocorreram só faz
 * o operador procurar por nada.
 */
export async function opcoesDeFiltro() {
  const [registros, empresas] = await Promise.all([
    buscar("plataforma_auditoria", "acao, entidade", (q) => q.order("created_at", { ascending: false }).limit(5000)),
    buscar("organizacoes", "id, nome", (q) => q.order("nome")),
  ]);

  const porAcao = new Map();
  const entidades = new Set();
  for (const r of registros) {
    porAcao.set(r.acao, (porAcao.get(r.acao) ?? 0) + 1);
    if (r.entidade) entidades.add(r.entidade);
  }

  return {
    acoes: [...porAcao.entries()]
      .map(([valor, total]) => ({ valor, rotulo: rotuloAcao(valor), total }))
      .sort((a, b) => b.total - a.total),
    entidades: [...entidades].sort(),
    empresas: empresas.map((e) => ({ id: e.id, nome: e.nome })),
    // Catálogo completo, mesmo o que ainda não ocorreu — serve de documentação
    // do que o sistema é capaz de registrar.
    acoesConhecidas: Object.values(ACOES).map((valor) => ({ valor, rotulo: rotuloAcao(valor) })),
  };
}

/** Rótulos em pt-BR para as ações auditadas. */
const ROTULOS = {
  "sessao.login": "Login",
  "sessao.logout": "Logout",
  "sessao.contexto_selecionado": "Entrou na empresa",
  "sessao.contexto_trocado": "Trocou de unidade",
  "sessao.login_negado": "Acesso negado",
  "impersonacao.iniciada": "SuperAdmin entrou como empresa",
  "impersonacao.encerrada": "SuperAdmin saiu da empresa",
  "empresa.criada": "Empresa criada",
  "empresa.editada": "Empresa editada",
  "empresa.status_alterado": "Status da empresa alterado",
  "empresa.plano_alterado": "Plano da empresa alterado",
  "empresa.excluida": "Empresa excluída",
  "usuario.criado": "Usuário criado",
  "usuario.editado": "Usuário editado",
  "usuario.bloqueado": "Usuário bloqueado",
  "usuario.senha_redefinida": "Senha redefinida",
  "usuario.email_alterado": "E-mail alterado",
  "usuario.logout_forcado": "Logout forçado",
  "usuario.excluido": "Usuário excluído",
  "usuario.superadmin_alterado": "Papel de SuperAdmin alterado",
  "vinculo.criado": "Acesso concedido",
  "vinculo.editado": "Acesso alterado",
  "vinculo.removido": "Acesso removido",
  "config.alterada": "Configuração global alterada",
  "migracao.020_reset_acessos": "Migração: acessos zerados",
  "bonificacao_mensal.fechamento_mensal_alterado": "Fechamento mensal alterado",
  "bonificacao_mensal.importacao_diaria_gravada": "Importação diária gravada",
};

/** @param {string} acao */
export function rotuloAcao(acao) {
  return ROTULOS[acao] ?? acao;
}

/** @param {string[]} ids */
async function mapearEmpresas(ids) {
  const unicos = [...new Set(ids.filter(Boolean))];
  if (!unicos.length) return new Map();
  const empresas = await buscar("organizacoes", "id, nome", (q) => q.in("id", unicos));
  return new Map(empresas.map((e) => [e.id, e.nome]));
}

/** @param {string} isoDate */
function proximoDia(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}
