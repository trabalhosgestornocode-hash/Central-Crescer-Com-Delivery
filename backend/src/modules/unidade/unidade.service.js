// Configuração da PRÓPRIA unidade, pelo tenant (organization_admin com
// `configuracoes.gerenciar`) — espelha o mesmo dado que o SuperAdmin já edita
// em plataforma.unidades.service.js#atualizarUnidade, mas escopado por
// `req.tenant` (nunca aceita unidadeId vindo do corpo/query: só a unidade do
// Context Token da própria sessão pode ser alterada por aqui).
//
// Cobre hoje:
//   * TABELAS COMERCIAIS (balcão/iFood)  — unidades.tabela_balcao/tabela_ifood
//   * DADOS DA UNIDADE                    — nome, cnpj, endereço, responsável,
//     e-mail, telefone (status é READ-ONLY no tenant: ativar/desativar é só
//     do SuperAdmin, senão o tenant poderia se trancar para fora)
//   * METAS E LIMITES DE CMV              — unidade_config (migration 058)
//
// TODAS as funções aceitam `deps` (default: supabase real) para serem
// testáveis sem rede — ver backend/test/unidade-dados.test.js.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { auditarReq, ACOES } from "../../shared/auditoria.js";
import { resolverTabelasComerciaisUnidade, normalizarCanalTabela } from "../../shared/tabelaComercial.js";

// Defaults OFICIAIS do sistema para "Metas e Limites de CMV" quando a unidade
// ainda não tem linha em `unidade_config`. Espelham `CMV_LIMITES` de
// frontend/src/config.js — mantenha os dois em sincronia até a 2ª etapa
// (tornar os consumidores globais de statusCmv() tenant-aware).
export const DEFAULTS_METAS_CMV = Object.freeze({
  cmvSaudavel: 32,
  cmvAtencao: 40,
  metaFatDia: null,
  metaFatMes: null,
  margemMinima: null,
});

// Colunas de "Dados da Unidade" que o tenant pode LER e (a maioria) editar.
const COLUNAS_DADOS = "id, nome, cnpj, endereco, telefone, responsavel, email, cidade, estado, ativo";

/**
 * Tabela comercial oficial da unidade (balcão + iFood) — a mesma fonte que
 * Dashboard/Produtos-CMV usam, exposta para a tela de Configurações mostrar
 * ANTES de qualquer edição.
 * @param {{unidadeId: string|null}} p
 */
export async function obterTabelasComerciais({ unidadeId }) {
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para ver as tabelas comerciais.");
  return resolverTabelasComerciaisUnidade({ unidadeId });
}

/**
 * Troca REAL da tabela oficial de um canal. Nunca confundir com "modo de
 * comparação" das telas (isso não grava nada — é estado só de frontend).
 * @param {import('express').Request} req
 * @param {{canal?: string, novaTabela?: string, motivo?: string}} body
 */
export async function alterarTabelaComercial(req, body) {
  const { unidadeId, organizacaoId } = req.tenant ?? {};
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para alterar sua tabela comercial.");

  if (!["balcao", "ifood"].includes(body?.canal)) throw ApiError.badRequest("Canal inválido — use 'balcao' ou 'ifood'.");
  const canal = normalizarCanalTabela(body.canal);
  const novaTabela = v.texto(body?.novaTabela, "Nova tabela", { max: 20 });
  const motivo = v.textoOpcional(body?.motivo, "Motivo", { max: 300 });
  const coluna = canal === "ifood" ? "tabela_ifood" : "tabela_balcao";

  const { data: antes, error: erroAntes } = await supabase
    .from("unidades").select(`id, nome, ${coluna}`).eq("id", unidadeId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (erroAntes) throw ApiError.internal(erroAntes.message);
  if (!antes) throw ApiError.notFound("Unidade não encontrada.");

  const tabelaAnterior = antes[coluna] ?? null;
  if (tabelaAnterior === novaTabela) {
    return { canal, tabelaAnterior, tabelaNova: novaTabela, alterado: false };
  }

  const { error: erroUpdate } = await supabase.from("unidades").update({ [coluna]: novaTabela }).eq("id", unidadeId);
  if (erroUpdate) throw ApiError.internal(erroUpdate.message);

  // Histórico dedicado (migration 051) — guarda o antes/depois; a linha em
  // plataforma_auditoria abaixo é o espelho geral (mesmo padrão de
  // unidade_modelo_logistico_historico / migration 024).
  const { error: erroHistorico } = await supabase.from("unidade_tabela_comercial_historico").insert({
    unidade_id: unidadeId, organizacao_id: organizacaoId, canal,
    tabela_anterior: tabelaAnterior, tabela_nova: novaTabela,
    usuario_id: req.user?.id ?? null, usuario_nome: req.user?.nome ?? null, usuario_email: req.user?.email ?? null,
    origem: "tenant", motivo,
  });
  if (erroHistorico) console.error("[unidade] falha ao gravar histórico de tabela comercial:", erroHistorico.message);

  await auditarReq(req, {
    acao: ACOES.UNIDADE_TABELA_COMERCIAL_ALTERADA,
    entidade: "unidade", entidadeId: unidadeId,
    detalhes: { unidade: antes.nome, canal, tabelaAnterior, tabelaNova: novaTabela, motivo: motivo ?? undefined },
  });

  return { canal, tabelaAnterior, tabelaNova: novaTabela, alterado: true };
}

// =====================================================================
// DADOS DA UNIDADE  (nome, cnpj, endereço, responsável, e-mail, telefone)
// =====================================================================

/**
 * Lê os dados de identificação/contato da unidade do Context Token.
 * `status` vem como string ("ativa"/"inativa") só para exibição — a edição
 * de status NÃO passa por aqui (é exclusiva do SuperAdmin).
 * @param {{unidadeId: string|null}} p
 * @param {{supabase?: import('@supabase/supabase-js').SupabaseClient}} [deps]
 */
export async function obterDados({ unidadeId }, deps = {}) {
  const db = deps.supabase ?? supabase;
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para ver os dados da loja.");

  const { data, error } = await db.from("unidades").select(COLUNAS_DADOS).eq("id", unidadeId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data) throw ApiError.notFound("Unidade não encontrada.");

  return {
    id: data.id,
    nome: data.nome ?? null,
    cnpj: data.cnpj ?? null,
    endereco: data.endereco ?? null,
    telefone: data.telefone ?? null,
    responsavel: data.responsavel ?? null,
    email: data.email ?? null,
    cidade: data.cidade ?? null,
    estado: data.estado ?? null,
    // status é READ-ONLY no tenant (ativar/desativar só o SuperAdmin faz).
    status: data.ativo ? "ativa" : "inativa",
    statusEditavel: false,
  };
}

/**
 * Atualiza os dados de identificação/contato da unidade do Context Token.
 * NUNCA aceita `unidadeId`/`organizacaoId` do corpo — o registro editado é
 * sempre `req.tenant.unidadeId`. `status`/`ativo` são IGNORADOS de propósito.
 * @param {import('express').Request} req
 * @param {Record<string, unknown>} body
 * @param {{supabase?: import('@supabase/supabase-js').SupabaseClient}} [deps]
 */
export async function atualizarDados(req, body, deps = {}) {
  const db = deps.supabase ?? supabase;
  const unidadeId = req.tenant?.unidadeId ?? null;
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para editar os dados da loja.");

  const patch = {};
  if (body.nome !== undefined)        patch.nome = v.texto(body.nome, "Nome da unidade", { max: 160 });
  if (body.cnpj !== undefined)        patch.cnpj = v.cnpjOpcional(body.cnpj);
  if (body.endereco !== undefined)    patch.endereco = v.textoOpcional(body.endereco, "Endereço", { max: 300 });
  if (body.telefone !== undefined)    patch.telefone = v.telefoneOpcional(body.telefone);
  if (body.responsavel !== undefined) patch.responsavel = v.textoOpcional(body.responsavel, "Responsável", { max: 160 });
  if (body.email !== undefined)       patch.email = v.emailOpcional(body.email, "E-mail da loja");
  if (body.cidade !== undefined)      patch.cidade = v.textoOpcional(body.cidade, "Cidade", { max: 120 });
  if (body.estado !== undefined)      patch.estado = v.textoOpcional(body.estado, "Estado (UF)", { max: 2 })?.toUpperCase() ?? null;

  if (!Object.keys(patch).length) throw ApiError.badRequest("Nada para atualizar.");

  const { data, error } = await db.from("unidades")
    .update(patch).eq("id", unidadeId).select(COLUNAS_DADOS).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data) throw ApiError.notFound("Unidade não encontrada.");

  await (deps.auditarReq ?? auditarReq)(req, {
    acao: ACOES.UNIDADE_EDITADA, entidade: "unidade", entidadeId: unidadeId,
    detalhes: { unidade: data.nome, campos: Object.keys(patch), origem: "tenant" },
  });

  return {
    id: data.id,
    nome: data.nome ?? null,
    cnpj: data.cnpj ?? null,
    endereco: data.endereco ?? null,
    telefone: data.telefone ?? null,
    responsavel: data.responsavel ?? null,
    email: data.email ?? null,
    cidade: data.cidade ?? null,
    estado: data.estado ?? null,
    status: data.ativo ? "ativa" : "inativa",
    statusEditavel: false,
  };
}

// =====================================================================
// METAS E LIMITES DE CMV  (unidade_config — migration 058)
// =====================================================================

function saidaMetasCmv(linha) {
  const num = (x) => (x == null ? null : Number(x));
  if (!linha) {
    return { ...DEFAULTS_METAS_CMV, persistido: false };
  }
  return {
    cmvSaudavel: num(linha.cmv_saudavel) ?? DEFAULTS_METAS_CMV.cmvSaudavel,
    cmvAtencao:  num(linha.cmv_atencao)  ?? DEFAULTS_METAS_CMV.cmvAtencao,
    metaFatDia:  num(linha.meta_fat_dia),
    metaFatMes:  num(linha.meta_fat_mes),
    margemMinima: num(linha.margem_minima),
    persistido: true,
  };
}

/**
 * Metas e limites de CMV da unidade do Context Token. Sem linha em
 * `unidade_config` -> devolve os defaults oficiais do sistema.
 * @param {{unidadeId: string|null}} p
 * @param {{supabase?: import('@supabase/supabase-js').SupabaseClient}} [deps]
 */
export async function obterMetasCmv({ unidadeId }, deps = {}) {
  const db = deps.supabase ?? supabase;
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para ver as metas de CMV.");

  const { data, error } = await db.from("unidade_config").select("*").eq("unidade_id", unidadeId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return saidaMetasCmv(data);
}

/**
 * Cria/atualiza (upsert) as metas de CMV da unidade do Context Token.
 * Escopo por `req.tenant.unidadeId` — uma unidade nunca altera a config de
 * outra. Campos ausentes no corpo não são tocados; `null` explícito limpa.
 * @param {import('express').Request} req
 * @param {Record<string, unknown>} body
 * @param {{supabase?: import('@supabase/supabase-js').SupabaseClient}} [deps]
 */
export async function salvarMetasCmv(req, body, deps = {}) {
  const db = deps.supabase ?? supabase;
  const unidadeId = req.tenant?.unidadeId ?? null;
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para editar as metas de CMV.");

  const atual = await obterMetasCmv({ unidadeId }, deps);

  const pct = (val, campo, fallback) =>
    val === undefined ? fallback : v.numeroOpcionalNulo(val, campo, { min: 0, max: 100 });
  const reais = (val, campo, fallback) =>
    val === undefined ? fallback : v.numeroOpcionalNulo(val, campo, { min: 0, max: 100_000_000 });

  const cmvSaudavel = pct(body.cmvSaudavel, "CMV saudável", atual.cmvSaudavel);
  const cmvAtencao  = pct(body.cmvAtencao,  "CMV de atenção", atual.cmvAtencao);
  const metaFatDia  = reais(body.metaFatDia, "Meta de faturamento diário", atual.metaFatDia);
  const metaFatMes  = reais(body.metaFatMes, "Meta de faturamento mensal", atual.metaFatMes);
  const margemMinima = pct(body.margemMinima, "Margem mínima", atual.margemMinima);

  if (cmvSaudavel != null && cmvAtencao != null && cmvSaudavel > cmvAtencao) {
    throw ApiError.badRequest("O CMV saudável não pode ser maior que o CMV de atenção.");
  }

  const linha = {
    unidade_id: unidadeId,
    cmv_saudavel: cmvSaudavel,
    cmv_atencao: cmvAtencao,
    meta_fat_dia: metaFatDia,
    meta_fat_mes: metaFatMes,
    margem_minima: margemMinima,
    atualizado_por: req.user?.id ?? null,
  };

  const { data, error } = await db.from("unidade_config")
    .upsert(linha, { onConflict: "unidade_id" }).select("*").maybeSingle();
  if (error) throw ApiError.internal(error.message);

  await (deps.auditarReq ?? auditarReq)(req, {
    acao: ACOES.UNIDADE_EDITADA, entidade: "unidade_config", entidadeId: unidadeId,
    detalhes: { origem: "tenant", metas: { cmvSaudavel, cmvAtencao, metaFatDia, metaFatMes, margemMinima } },
  });

  return saidaMetasCmv(data ?? linha);
}
