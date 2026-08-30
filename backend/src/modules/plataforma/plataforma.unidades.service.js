// Gestão das UNIDADES pelo SuperAdmin — espelha plataforma.empresas.service.js
// de propósito: mesmo padrão de leitura/escrita/auditoria, mesma ausência de
// `req.tenant` (o SuperAdmin opera sobre qualquer unidade de qualquer
// empresa; a autorização é só o `requireSuperadmin` do router).
//
// FORA DE ESCOPO (decisão registrada — ver migration 034): "Modelo Inicial"
// por unidade e catálogo (produtos/insumos/ficha técnica) isolado por
// unidade. Hoje esse catálogo é só por organizacao_id — compartilhado entre
// todas as unidades da empresa. Nada aqui finge o contrário.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { rotuloPapel } from "../../shared/permissoes.js";
import {
  CATALOGO_MODULOS, modulosDaEmpresa, modulosDaUnidade,
  validarModulos, provisionarModulosUnidade, definirModulosUnidade, rotuloModulo,
} from "../../shared/modulos.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { revogarSessoes } from "../sessao/sessao.service.js";
import { contar, contarVarios, buscar } from "./plataforma.repo.js";
import * as v from "../../shared/validar.js";

const ESTADOS_BR = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG",
  "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
];

/** @param {unknown} v @param {string} campo */
function estadoOpcional(bruto, campo) {
  const estado = v.textoOpcional(bruto, campo, { max: 2 });
  if (!estado) return null;
  const uf = estado.toUpperCase();
  if (!ESTADOS_BR.includes(uf)) throw ApiError.badRequest(`${campo} inválido — use a sigla (ex: MA).`);
  return uf;
}

// --------------------------------------------------------------------------
// Leitura
// --------------------------------------------------------------------------

/**
 * @param {{busca?: string, status?: string, organizacaoId?: string, limite?: unknown}} filtros
 *   `status`: 'ativa' | 'inativa' (mapeia para a coluna booleana `ativo`).
 */
export async function listarUnidades({ busca, status, organizacaoId, limite } = {}) {
  let q = supabase.from("unidades")
    .select("id, organizacao_id, nome, cnpj, cidade, estado, endereco, telefone, responsavel, email, ativo, created_at, organizacoes(id, nome)")
    .order("nome")
    .limit(v.limite(limite, 200, 1, 500));

  if (organizacaoId) q = q.eq("organizacao_id", v.uuid(organizacaoId, "Empresa"));
  if (status) q = q.eq("ativo", v.umDe(status, "Status", ["ativa", "inativa"]) === "ativa");
  if (busca) {
    const termo = v.texto(busca, "Busca", { max: 120 }).replace(/[%,()]/g, " ");
    q = q.or(`nome.ilike.%${termo}%,cnpj.ilike.%${termo}%,cidade.ilike.%${termo}%`);
  }

  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);
  const unidades = data ?? [];
  if (!unidades.length) return [];

  // Contagens/atividade em consultas paralelas, não em 2N — a lista pode crescer.
  const ids = unidades.map((u) => u.id);
  const [modulosPorUnidade, usuarios, sessoesRecentes] = await Promise.all([
    buscar("unidade_modulos", "unidade_id, modulo_id", (q2) => q2.in("unidade_id", ids)),
    buscar("usuarios_unidades", "unidade_id", (q2) => q2.in("unidade_id", ids).eq("ativo", true)),
    // Ordenado desc: a primeira ocorrência de cada unidade_id já é a mais
    // recente — não precisa de agregação por grupo. Limitado a 2000 para não
    // varrer o histórico inteiro só para montar uma coluna da listagem;
    // degrada para "sem atividade recente" numa unidade muito antiga e
    // pouquíssimo usada, nunca quebra (mesmo espírito tolerante de `buscar`).
    buscar("sessoes_contexto", "unidade_id, ultimo_uso_em",
      (q2) => q2.in("unidade_id", ids).order("ultimo_uso_em", { ascending: false }).limit(2000)),
  ]);

  const contaModulos = new Map();
  for (const r of modulosPorUnidade) contaModulos.set(r.unidade_id, (contaModulos.get(r.unidade_id) ?? 0) + 1);
  const contaUsuarios = new Map();
  for (const r of usuarios) contaUsuarios.set(r.unidade_id, (contaUsuarios.get(r.unidade_id) ?? 0) + 1);
  const ultimaAtividade = new Map();
  for (const s of sessoesRecentes) if (!ultimaAtividade.has(s.unidade_id)) ultimaAtividade.set(s.unidade_id, s.ultimo_uso_em);

  return unidades.map((u) => ({
    ...formatarUnidade(u),
    modulosAtivos: contaModulos.get(u.id) ?? 0,
    usuarios: contaUsuarios.get(u.id) ?? 0,
    ultimaAtividade: ultimaAtividade.get(u.id) ?? null,
  }));
}

const formatarUnidade = (u) => ({
  id: u.id,
  organizacaoId: u.organizacao_id,
  empresa: u.organizacoes ? { id: u.organizacoes.id, nome: u.organizacoes.nome, status: u.organizacoes.status ?? undefined } : null,
  nome: u.nome,
  cnpj: u.cnpj,
  cidade: u.cidade ?? null,
  estado: u.estado ?? null,
  endereco: u.endereco,
  telefone: u.telefone,
  responsavel: u.responsavel ?? null,
  email: u.email ?? null,
  ativo: u.ativo,
  criadoEm: u.created_at,
});

/** Ficha completa de uma unidade: dados, empresa, usuários e métricas operacionais. */
export async function obterUnidade(idBruto) {
  const id = v.uuid(idBruto, "Unidade");

  const { data: u, error } = await supabase.from("unidades")
    .select(`id, organizacao_id, nome, cnpj, cidade, estado, endereco, telefone, responsavel, email,
      tabela_balcao, tabela_ifood, ativo, eh_teste, modelo_logistico_ifood,
      created_at, updated_at, organizacoes(id, nome, status)`)
    .eq("id", id).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!u) throw ApiError.notFound("Unidade não encontrada.");

  const [usuarios, metricas, ultimaSessao] = await Promise.all([
    listarUsuariosDaUnidade(id),
    contarVarios([
      { chave: "vendas", tabela: "vendas", filtro: (q) => q.eq("unidade_id", id) },
      { chave: "lancamentosDashboardIfood", tabela: "lancamentos_financeiros_diarios", filtro: (q) => q.eq("unidade_id", id) },
      { chave: "bonificacaoLancamentos", tabela: "bonificacao_lancamentos_diarios", filtro: (q) => q.eq("unidade_id", id) },
      { chave: "martinBrowerSincronizacoes", tabela: "martin_brower_sincronizacoes", filtro: (q) => q.eq("unidade_id", id) },
    ]),
    supabase.from("sessoes_contexto").select("ultimo_uso_em").eq("unidade_id", id)
      .order("ultimo_uso_em", { ascending: false }).limit(1).maybeSingle(),
  ]);

  return {
    ...formatarUnidade(u),
    tabelaBalcao: u.tabela_balcao,
    tabelaIfood: u.tabela_ifood,
    ehTeste: u.eh_teste ?? false,
    modeloLogisticoIfood: u.modelo_logistico_ifood ?? null,
    atualizadoEm: u.updated_at,
    usuarios,
    metricas,
    ultimaAtividade: ultimaSessao.data?.ultimo_uso_em ?? null,
  };
}

/** Usuários vinculados a uma unidade, com o papel daquele vínculo (`papel: null` = herda o da empresa). */
export async function listarUsuariosDaUnidade(idBruto) {
  const id = v.uuid(idBruto, "Unidade");
  const vinculos = await buscar("usuarios_unidades",
    "id, usuario_id, papel, ativo, created_at", (q) => q.eq("unidade_id", id));
  if (!vinculos.length) return [];

  const perfis = await buscar("perfis", "id, nome, email, ativo",
    (q) => q.in("id", vinculos.map((x) => x.usuario_id)));
  const porId = new Map(perfis.map((p) => [p.id, p]));

  return vinculos.map((x) => ({
    vinculoId: x.id,
    usuarioId: x.usuario_id,
    nome: porId.get(x.usuario_id)?.nome ?? null,
    email: porId.get(x.usuario_id)?.email ?? null,
    papel: x.papel,
    papelRotulo: x.papel ? rotuloPapel(x.papel) : "Herda o papel da empresa",
    vinculoAtivo: x.ativo,
    contaAtiva: porId.get(x.usuario_id)?.ativo ?? null,
    desde: x.created_at,
  }));
}

/** Trilha de auditoria de uma unidade — eventos gravados com entidade='unidade'. */
export async function listarLogsDaUnidade(idBruto, limiteBruto) {
  const id = v.uuid(idBruto, "Unidade");
  return (await buscar("plataforma_auditoria",
    "id, ator_email, ator_tipo, acao, entidade, entidade_id, organizacao_id, impersonado_por, detalhes, ip, created_at",
    (q) => q.eq("entidade", "unidade").eq("entidade_id", id).order("created_at", { ascending: false }).limit(v.limite(limiteBruto, 100))))
    .map(formatarLog);
}

const formatarLog = (l) => ({
  id: l.id, atorEmail: l.ator_email, atorTipo: l.ator_tipo, acao: l.acao,
  entidade: l.entidade, entidadeId: l.entidade_id, organizacaoId: l.organizacao_id ?? null,
  impersonado: !!l.impersonado_por, detalhes: l.detalhes, ip: l.ip, em: l.created_at,
});

/** Contagens de registros operacionais/vinculados — alimenta o preview de exclusão (item 8) e a aba Dados/Configurações. */
export async function impactoExclusaoUnidade(idBruto) {
  const id = v.uuid(idBruto, "Unidade");
  const { data: unidade } = await supabase.from("unidades").select("id, nome").eq("id", id).maybeSingle();
  if (!unidade) throw ApiError.notFound("Unidade não encontrada.");

  const metricas = await contarVarios([
    { chave: "usuarios", tabela: "usuarios_unidades", filtro: (q) => q.eq("unidade_id", id) },
    { chave: "vendas", tabela: "vendas", filtro: (q) => q.eq("unidade_id", id) },
    { chave: "estoque", tabela: "estoque", filtro: (q) => q.eq("unidade_id", id) },
    { chave: "lancamentosDashboardIfood", tabela: "lancamentos_financeiros_diarios", filtro: (q) => q.eq("unidade_id", id) },
    { chave: "bonificacaoLancamentos", tabela: "bonificacao_lancamentos_diarios", filtro: (q) => q.eq("unidade_id", id) },
    { chave: "martinBrowerIntegracoes", tabela: "martin_brower_integracoes", filtro: (q) => q.eq("unidade_id", id) },
  ]);

  // `usuarios` não entra na conta de "histórico operacional" — um vínculo de
  // usuário sozinho não é motivo pra recusar a exclusão física (o cascade da
  // FK já remove o vínculo); o que bloqueia é dado operacional de verdade.
  const totalOperacional = Object.entries(metricas)
    .filter(([chave]) => chave !== "usuarios")
    .reduce((soma, [, valor]) => soma + (valor ?? 0), 0);

  return { id: unidade.id, nome: unidade.nome, metricas, exclusaoFisicaSegura: totalOperacional === 0 };
}

// --------------------------------------------------------------------------
// Escrita
// --------------------------------------------------------------------------

/** @param {import('express').Request} req */
export async function criarUnidade(req, body) {
  const organizacaoId = v.uuid(body.organizacaoId, "Empresa");
  const { data: empresa } = await supabase.from("organizacoes").select("id, nome").eq("id", organizacaoId).maybeSingle();
  if (!empresa) throw ApiError.notFound("Empresa não encontrada.");

  // Módulos validados ANTES do insert: uma unidade não pode nascer com um id
  // de módulo inexistente, nem com um módulo que a própria empresa não tem
  // (item 4 — a herança é imposta na escrita, com erro claro, não um filtro silencioso).
  const moduloIdsDesejados = validarModulos(body.modulos ?? []);
  const modulosEmpresa = await modulosDaEmpresa(organizacaoId);
  const recusados = moduloIdsDesejados.filter((id) => !modulosEmpresa.includes(id));
  if (recusados.length) {
    throw ApiError.badRequest(
      `A empresa não possui o(s) módulo(s) ${recusados.map(rotuloModulo).join(", ")} — a unidade não pode recebê-los.`);
  }

  const dados = {
    organizacao_id: organizacaoId,
    nome: v.texto(body.nome, "Nome", { max: 160 }),
    cnpj: v.cnpjOpcional(body.cnpj),
    cidade: v.textoOpcional(body.cidade, "Cidade", { max: 120 }),
    estado: estadoOpcional(body.estado, "Estado"),
    endereco: v.textoOpcional(body.endereco, "Endereço", { max: 300 }),
    telefone: v.telefoneOpcional(body.telefone),
    tabela_balcao: v.textoOpcional(body.tabelaBalcao, "Tabela balcão", { max: 20 }),
    tabela_ifood: v.textoOpcional(body.tabelaIfood, "Tabela iFood", { max: 20 }),
    ativo: true,
  };

  const { data: unidade, error } = await supabase.from("unidades").insert(dados).select("id, nome").single();
  if (error) {
    if (error.message.includes("duplicate") || error.message.includes("unique")) {
      throw ApiError.badRequest("Já existe uma unidade com este CNPJ.");
    }
    throw ApiError.internal(error.message);
  }

  const habilitados = await provisionarModulosUnidade(unidade.id, moduloIdsDesejados, modulosEmpresa, req.user.id);

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.UNIDADE_CRIADA, entidade: "unidade", entidadeId: unidade.id, organizacaoId,
    detalhes: { nome: unidade.nome, empresa: empresa.nome, modulos: habilitados },
    ...origemDe(req),
  });

  return { id: unidade.id, nome: unidade.nome, organizacaoId };
}

/** @param {import('express').Request} req */
export async function atualizarUnidade(req, idBruto, body) {
  const id = v.uuid(idBruto, "Unidade");
  const patch = {};
  if (body.nome !== undefined) patch.nome = v.texto(body.nome, "Nome", { max: 160 });
  if (body.cnpj !== undefined) patch.cnpj = v.cnpjOpcional(body.cnpj);
  if (body.cidade !== undefined) patch.cidade = v.textoOpcional(body.cidade, "Cidade", { max: 120 });
  if (body.estado !== undefined) patch.estado = estadoOpcional(body.estado, "Estado");
  if (body.endereco !== undefined) patch.endereco = v.textoOpcional(body.endereco, "Endereço", { max: 300 });
  if (body.telefone !== undefined) patch.telefone = v.telefoneOpcional(body.telefone);
  if (body.responsavel !== undefined) patch.responsavel = v.textoOpcional(body.responsavel, "Responsável", { max: 160 });
  if (body.email !== undefined) patch.email = v.emailOpcional(body.email, "E-mail da loja");
  if (body.tabelaBalcao !== undefined) patch.tabela_balcao = v.textoOpcional(body.tabelaBalcao, "Tabela balcão", { max: 20 });
  if (body.tabelaIfood !== undefined) patch.tabela_ifood = v.textoOpcional(body.tabelaIfood, "Tabela iFood", { max: 20 });
  if (!Object.keys(patch).length) throw ApiError.badRequest("Nada para atualizar.");

  // Tabela comercial muda de identidade (não só um campo de cadastro) — para
  // manter o antes/depois no histórico dedicado (migration 051, mesmo padrão
  // de unidade_modelo_logistico_historico), precisa saber o valor ANTES do
  // update. Só busca quando o patch de fato mexe em tabela_balcao/tabela_ifood.
  const mexeTabelaComercial = "tabela_balcao" in patch || "tabela_ifood" in patch;
  let antesTabelas = null;
  if (mexeTabelaComercial) {
    const { data: antes } = await supabase.from("unidades").select("tabela_balcao, tabela_ifood").eq("id", id).maybeSingle();
    antesTabelas = antes;
  }

  const { data, error } = await supabase.from("unidades")
    .update(patch).eq("id", id).select("id, nome, organizacao_id").single();
  if (error || !data) throw ApiError.notFound("Unidade não encontrada.");

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.UNIDADE_EDITADA, entidade: "unidade", entidadeId: id, organizacaoId: data.organizacao_id,
    detalhes: { campos: Object.keys(patch), unidade: data.nome }, ...origemDe(req),
  });

  if (mexeTabelaComercial && antesTabelas) {
    const trocas = [
      "tabela_balcao" in patch && patch.tabela_balcao !== antesTabelas.tabela_balcao
        ? { canal: "balcao", tabelaAnterior: antesTabelas.tabela_balcao, tabelaNova: patch.tabela_balcao }
        : null,
      "tabela_ifood" in patch && patch.tabela_ifood !== antesTabelas.tabela_ifood
        ? { canal: "ifood", tabelaAnterior: antesTabelas.tabela_ifood, tabelaNova: patch.tabela_ifood }
        : null,
    ].filter(Boolean);

    for (const troca of trocas) {
      await supabase.from("unidade_tabela_comercial_historico").insert({
        unidade_id: id, organizacao_id: data.organizacao_id, canal: troca.canal,
        tabela_anterior: troca.tabelaAnterior, tabela_nova: troca.tabelaNova,
        usuario_id: req.user.id, usuario_nome: req.user.nome ?? null, usuario_email: req.user.email,
        origem: "superadmin",
      });
      await auditar({
        atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
        acao: ACOES.UNIDADE_TABELA_COMERCIAL_ALTERADA, entidade: "unidade", entidadeId: id, organizacaoId: data.organizacao_id,
        detalhes: { unidade: data.nome, ...troca }, ...origemDe(req),
      });
    }
  }

  return { id, nome: data.nome };
}

/**
 * Ativa/desativa a unidade — item 8 (o caminho seguro de "exclusão" para
 * quando há histórico operacional). Ao desativar, revoga só as sessões
 * PRESAS àquela unidade (nunca a empresa inteira).
 * @param {import('express').Request} req
 */
export async function alterarStatusUnidade(req, idBruto, body) {
  const id = v.uuid(idBruto, "Unidade");
  const ativo = v.booleano(body.ativo, true);
  const motivo = v.textoOpcional(body.motivo, "Motivo", { max: 300 });

  const { data: antes } = await supabase.from("unidades").select("id, nome, organizacao_id, ativo").eq("id", id).maybeSingle();
  if (!antes) throw ApiError.notFound("Unidade não encontrada.");

  const { error } = await supabase.from("unidades").update({ ativo }).eq("id", id);
  if (error) throw ApiError.internal(error.message);

  let sessoesRevogadas = 0;
  if (!ativo) sessoesRevogadas = await revogarSessoes({ unidadeId: id, motivo: "unidade_desativada" });

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.UNIDADE_STATUS, entidade: "unidade", entidadeId: id, organizacaoId: antes.organizacao_id,
    detalhes: { de: antes.ativo, para: ativo, motivo, sessoesRevogadas, unidade: antes.nome }, ...origemDe(req),
  });

  return { id, ativo, sessoesRevogadas };
}

/**
 * Exclui a unidade DE VERDADE. Item 8: nunca destrutivo em silêncio — recusa
 * de cara se houver qualquer histórico operacional (vendas, estoque,
 * lançamentos, integrações), orientando para "Desativar" em vez disso. Só
 * quando as contagens são zero é que pede a confirmação pelo nome exato
 * (mesmo padrão de `excluirEmpresa`) e apaga.
 * @param {import('express').Request} req
 */
export async function excluirUnidade(req, idBruto, body) {
  const id = v.uuid(idBruto, "Unidade");
  const { data: unidade } = await supabase.from("unidades").select("id, nome, organizacao_id").eq("id", id).maybeSingle();
  if (!unidade) throw ApiError.notFound("Unidade não encontrada.");

  const impacto = await impactoExclusaoUnidade(id);
  if (!impacto.exclusaoFisicaSegura) {
    throw ApiError.badRequest(
      "Esta unidade tem histórico operacional (vendas, estoque, lançamentos ou integrações) — excluir apagaria tudo isso " +
      "definitivamente. Use \"Desativar\" para encerrar o acesso sem perder o histórico.",
      { metricas: impacto.metricas },
    );
  }

  const confirmacao = typeof body?.confirmacao === "string" ? body.confirmacao.trim() : "";
  if (confirmacao !== unidade.nome) {
    throw ApiError.badRequest(
      `Exclusão não confirmada. Envie "confirmacao" com o nome exato da unidade ("${unidade.nome}").`);
  }

  await revogarSessoes({ unidadeId: id, motivo: "unidade_excluida" });

  // Auditoria ANTES do delete — o log é imutável e não pode depender de a
  // unidade ainda existir (mesmo padrão de `excluirEmpresa`).
  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.UNIDADE_EXCLUIDA, entidade: "unidade", entidadeId: id, organizacaoId: unidade.organizacao_id,
    detalhes: { nome: unidade.nome }, ...origemDe(req),
  });

  const { error } = await supabase.from("unidades").delete().eq("id", id);
  if (error) throw ApiError.internal(error.message);
  return { id, nome: unidade.nome, excluida: true };
}

// --------------------------------------------------------------------------
// Módulos (aba "Acessos") — herança Empresa -> Unidade
// --------------------------------------------------------------------------

/** Catálogo completo — mesmo catálogo de empresas, reexportado por conveniência do controller. */
export function catalogoModulos() {
  return CATALOGO_MODULOS;
}

/**
 * Catálogo + estado de cada módulo para UMA unidade: se a empresa disponibiliza,
 * se a unidade tem habilitado, e o efetivo (interseção — o que de fato vale).
 * `disponivelNaEmpresa: false` é o que o frontend usa para desenhar o
 * checkbox desabilitado, com a explicação de por que não dá pra marcar.
 */
export async function modulosDaUnidadeAdmin(idBruto) {
  const id = v.uuid(idBruto, "Unidade");
  const { data: unidade } = await supabase.from("unidades").select("id, organizacao_id").eq("id", id).maybeSingle();
  if (!unidade) throw ApiError.notFound("Unidade não encontrada.");

  const [empresaSet, unidadeSet] = await Promise.all([
    modulosDaEmpresa(unidade.organizacao_id).then((lista) => new Set(lista)),
    modulosDaUnidade(id).then((lista) => new Set(lista)),
  ]);

  return {
    modulos: CATALOGO_MODULOS.map((m) => ({
      ...m,
      disponivelNaEmpresa: empresaSet.has(m.id),
      habilitado: unidadeSet.has(m.id),
      efetivo: empresaSet.has(m.id) && unidadeSet.has(m.id),
    })),
  };
}

/**
 * Substitui os módulos habilitados de uma unidade. Audita CADA módulo que
 * mudou, igual `definirModulosEmpresaAdmin`. Revoga as sessões PRESAS a esta
 * unidade — não a empresa inteira (item 5: a mudança precisa valer na hora,
 * sem derrubar as outras unidades da mesma empresa).
 * @param {import('express').Request} req
 */
export async function definirModulosUnidadeAdmin(req, idBruto, body) {
  const id = v.uuid(idBruto, "Unidade");
  const moduloIds = validarModulos(body?.modulos ?? []);

  const { data: unidade } = await supabase.from("unidades").select("id, nome, organizacao_id").eq("id", id).maybeSingle();
  if (!unidade) throw ApiError.notFound("Unidade não encontrada.");

  const modulosEmpresa = await modulosDaEmpresa(unidade.organizacao_id);
  const { habilitados, desabilitados, recusados } = await definirModulosUnidade(id, moduloIds, modulosEmpresa, req.user.id);

  const origem = origemDe(req);
  for (const moduloId of habilitados) {
    await auditar({
      atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
      acao: ACOES.UNIDADE_MODULO_HABILITADO, entidade: "unidade", entidadeId: id, organizacaoId: unidade.organizacao_id,
      detalhes: { unidade: unidade.nome, modulo: moduloId, moduloNome: rotuloModulo(moduloId) }, ...origem,
    });
  }
  for (const moduloId of desabilitados) {
    await auditar({
      atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
      acao: ACOES.UNIDADE_MODULO_DESABILITADO, entidade: "unidade", entidadeId: id, organizacaoId: unidade.organizacao_id,
      detalhes: { unidade: unidade.nome, modulo: moduloId, moduloNome: rotuloModulo(moduloId) }, ...origem,
    });
  }

  let sessoesRevogadas = 0;
  if (habilitados.length || desabilitados.length) {
    sessoesRevogadas = await revogarSessoes({ unidadeId: id, motivo: "modulos_unidade_alterados" });
  }

  return { id, modulos: moduloIds, habilitados, desabilitados, recusados, sessoesRevogadas };
}

/**
 * Contagem rápida de unidades — usada pelo Dashboard Global do SuperAdmin, se
 * precisar (mantido pequeno e opcional; não lança se a tabela não existir).
 */
export async function contarUnidades(filtro) {
  return contar("unidades", filtro);
}

/** @param {import('express').Request} req */
function origemDe(req) {
  const encaminhado = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(encaminhado) ? encaminhado[0] : encaminhado)?.split(",")[0]?.trim()
    || req.socket?.remoteAddress || null;
  return { ip, userAgent: req.header("user-agent") || null };
}
