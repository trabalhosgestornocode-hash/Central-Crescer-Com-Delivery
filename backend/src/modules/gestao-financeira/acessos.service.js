// Gestão SIMPLES de acessos do Dashboard Financeiro por unidade (SuperAdmin): uma tela liga/desliga o módulo na
// unidade e define, por usuário, Sem acesso / Visualização / Operador / Gestor.
// Não cria estrutura nova: escreve nas MESMAS tabelas de sempre — organizacao_modulos/unidade_modulos (shared/modulos.js)
// e gestao_financeira_concessoes (migration 120, revalidada por gatilho; autoconcessão só do SuperAdmin, 126).
// Cada escrita é auditada. Gravações são independentes: uma falha num usuário não desfaz as outras e volta no resumo.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import {
  MODULOS, modulosDaEmpresa, modulosDaUnidade, definirModulosEmpresa, definirModulosUnidade, rotuloModulo,
} from "../../shared/modulos.js";
import { revogarSessoes } from "../sessao/sessao.service.js";
import {
  avaliarLiberacaoDeConcessoes, validarAcessosDaUnidade, planejarAcessos, motivoAutomatico, garantirSemAutoconcessao,
} from "./concessoes.dominio.js";
import { perfisElegiveis } from "./concessoes.service.js";

const FIN = MODULOS.GESTAO_FINANCEIRA;

function origem(req) {
  return { ip: req.ip ?? null, userAgent: req.header?.("user-agent") ?? null };
}

async function carregarUnidade(unidadeId) {
  const { data, error } = await supabase.from("unidades").select("id, nome, organizacao_id").eq("id", unidadeId).maybeSingle();
  if (error) throw ApiError.internal("Falha ao consultar a unidade.");
  if (!data) throw ApiError.notFound("Unidade não encontrada.");
  return data;
}

async function concessoesAtivas(unidadeId) {
  const { data, error } = await supabase.from("gestao_financeira_concessoes")
    .select("id, perfil_id, nivel, expira_em").eq("unidade_id", unidadeId).is("revogada_em", null);
  if (error) throw ApiError.internal("Falha ao consultar os acessos.");
  return data ?? [];
}

/** Estado da tela: módulo ligado?, escrita liberada?, e cada usuário com o nível atual (null = Sem acesso). */
export async function obterAcessosDaUnidade({ unidadeId, atorId }) {
  const unidade = await carregarUnidade(unidadeId);
  const [daEmpresa, daUnidade, elegiveis, ativas] = await Promise.all([
    modulosDaEmpresa(unidade.organizacao_id), modulosDaUnidade(unidadeId),
    perfisElegiveis({ unidadeId, atorId }), concessoesAtivas(unidadeId),
  ]);
  const porPerfil = new Map(ativas.map((c) => [c.perfil_id, c]));
  const usuarios = elegiveis.map((p) => ({ ...p, nivel: porPerfil.get(p.id)?.nivel ?? null, elegivel: true }));
  // Concessão ativa de quem perdeu o vínculo: aparece para poder ser removida (nunca some em silêncio).
  const ids = new Set(elegiveis.map((p) => p.id));
  for (const c of ativas) {
    if (!ids.has(c.perfil_id)) usuarios.push({ id: c.perfil_id, nome: "Usuário sem vínculo ativo", email: null, propria: false, nivel: c.nivel, elegivel: false });
  }
  const liberacao = avaliarLiberacaoDeConcessoes(null);
  return {
    unidade: { id: unidade.id, nome: unidade.nome, organizacaoId: unidade.organizacao_id },
    habilitado: daEmpresa.includes(FIN) && daUnidade.includes(FIN),
    escritaLiberada: liberacao.ok, mensagem: liberacao.ok ? null : liberacao.mensagem,
    usuarios,
  };
}

/** Liga/desliga o Financeiro na unidade e aplica os níveis pedidos. Devolve o resumo do que mudou. */
export async function salvarAcessosDaUnidade(req, unidadeId) {
  const liberacao = avaliarLiberacaoDeConcessoes(req.user);
  if (!liberacao.ok) throw new ApiError(liberacao.status, liberacao.mensagem, { codigo: liberacao.codigo });
  const pedido = validarAcessosDaUnidade(req.body);
  const unidade = await carregarUnidade(unidadeId);
  const orgId = unidade.organizacao_id;
  const ator = { id: req.user.id, email: req.user.email ?? null };

  // Plano completo ANTES de escrever: perfil fora da unidade recusa a gravação inteira.
  const [elegiveis, ativas] = await Promise.all([perfisElegiveis({ unidadeId, atorId: ator.id }), concessoesAtivas(unidadeId)]);
  const plano = planejarAcessos({ ativas, elegiveis, pedido: pedido.acessos });
  const contaPorPerfil = new Map();
  if (plano.conceder.length) {
    const { data, error } = await supabase.from("perfis_operacionais").select("id, conta_id").in("id", plano.conceder.map((x) => x.perfilId));
    if (error) throw ApiError.internal("Falha ao consultar os perfis.");
    for (const p of data ?? []) contaPorPerfil.set(p.id, p.conta_id);
    for (const x of plano.conceder) garantirSemAutoconcessao(contaPorPerfil.get(x.perfilId), ator.id, req.user);
  }

  // 1) Módulo: ligar exige empresa E unidade; desligar mexe só na unidade (a empresa pode ter outras unidades).
  const modulo = { empresaLigada: false, unidadeLigada: false, unidadeDesligada: false, sessoesRevogadas: 0 };
  const daEmpresa = await modulosDaEmpresa(orgId);
  const daUnidade = await modulosDaUnidade(unidadeId);
  if (pedido.habilitado) {
    let empresaAtual = daEmpresa;
    if (!daEmpresa.includes(FIN)) {
      await definirModulosEmpresa(orgId, [...daEmpresa, FIN], ator.id);
      empresaAtual = [...daEmpresa, FIN];
      modulo.empresaLigada = true;
      await auditar({ atorId: ator.id, atorEmail: ator.email, atorTipo: "superadmin", acao: ACOES.EMPRESA_MODULO_HABILITADO,
        entidade: "organizacao", entidadeId: orgId, organizacaoId: orgId, detalhes: { modulo: FIN, moduloNome: rotuloModulo(FIN), via: "gestao_acessos_financeiro" }, ...origem(req) });
    }
    if (!daUnidade.includes(FIN)) {
      await definirModulosUnidade(unidadeId, [...daUnidade, FIN], empresaAtual, ator.id);
      modulo.unidadeLigada = true;
      await auditar({ atorId: ator.id, atorEmail: ator.email, atorTipo: "superadmin", acao: ACOES.UNIDADE_MODULO_HABILITADO,
        entidade: "unidade", entidadeId: unidadeId, organizacaoId: orgId, detalhes: { unidade: unidade.nome, modulo: FIN, moduloNome: rotuloModulo(FIN), via: "gestao_acessos_financeiro" }, ...origem(req) });
    }
  } else if (daUnidade.includes(FIN)) {
    await definirModulosUnidade(unidadeId, daUnidade.filter((m) => m !== FIN), daEmpresa, ator.id);
    modulo.unidadeDesligada = true;
    await auditar({ atorId: ator.id, atorEmail: ator.email, atorTipo: "superadmin", acao: ACOES.UNIDADE_MODULO_DESABILITADO,
      entidade: "unidade", entidadeId: unidadeId, organizacaoId: orgId, detalhes: { unidade: unidade.nome, modulo: FIN, moduloNome: rotuloModulo(FIN), via: "gestao_acessos_financeiro" }, ...origem(req) });
  }
  // Mesma convenção da aba de módulos: a sessão grava os módulos efetivos, então quem estava na unidade entra de novo.
  if (modulo.unidadeLigada || modulo.unidadeDesligada) {
    modulo.sessoesRevogadas = await revogarSessoes({ unidadeId, motivo: "modulos_unidade_alterados" });
  }

  // 2) Acessos. Erro de regra do gatilho (vínculo, perfil inativo…) vira falha do usuário, não da gravação inteira.
  const resultado = { concedidos: 0, alterados: 0, revogados: 0, inalterados: plano.inalterados, falhas: [] };
  const falhou = (perfilId, error) => resultado.falhas.push({ perfilId, mensagem: /Concessão financeira/.test(error?.message ?? "") ? error.message : "Não foi possível gravar este acesso." });

  for (const x of plano.conceder) {
    const motivo = motivoAutomatico("conceder", ator, x.nivel);
    const { data, error } = await supabase.from("gestao_financeira_concessoes")
      .insert({ organizacao_id: orgId, unidade_id: unidadeId, perfil_id: x.perfilId, nivel: x.nivel, somente_financeiro: false, motivo, expira_em: null, concedida_por: ator.id })
      .select("id").single();
    if (error) { falhou(x.perfilId, error); continue; }
    resultado.concedidos += 1;
    await auditar({ atorId: ator.id, atorEmail: ator.email, acao: ACOES.FINANCEIRO_CONCESSAO_CONCEDIDA, entidade: "gestao_financeira_concessoes",
      entidadeId: data.id, organizacaoId: orgId, detalhes: { unidade_id: unidadeId, perfil_id: x.perfilId, nivel: x.nivel, motivo, propria: contaPorPerfil.get(x.perfilId) === ator.id }, ...origem(req) });
  }
  for (const x of plano.alterar) {
    const { data, error } = await supabase.from("gestao_financeira_concessoes")
      .update({ nivel: x.para }).eq("id", x.concessaoId).is("revogada_em", null).select("id").maybeSingle();
    if (error || !data) { falhou(x.perfilId, error); continue; }
    resultado.alterados += 1;
    await auditar({ atorId: ator.id, atorEmail: ator.email, acao: ACOES.FINANCEIRO_CONCESSAO_ALTERADA, entidade: "gestao_financeira_concessoes",
      entidadeId: x.concessaoId, organizacaoId: orgId, detalhes: { unidade_id: unidadeId, perfil_id: x.perfilId, de: x.de, para: x.para, motivo: motivoAutomatico("alterar", ator, x.para) }, ...origem(req) });
  }
  for (const x of plano.revogar) {
    const motivo = motivoAutomatico("revogar", ator);
    const { data, error } = await supabase.from("gestao_financeira_concessoes")
      .update({ revogada_em: new Date().toISOString(), revogada_por: ator.id, motivo_revogacao: motivo })
      .eq("id", x.concessaoId).is("revogada_em", null).select("id").maybeSingle();
    if (error || !data) { falhou(x.perfilId, error); continue; }
    resultado.revogados += 1;
    await auditar({ atorId: ator.id, atorEmail: ator.email, acao: ACOES.FINANCEIRO_CONCESSAO_REVOGADA, entidade: "gestao_financeira_concessoes",
      entidadeId: x.concessaoId, organizacaoId: orgId, detalhes: { unidade_id: unidadeId, perfil_id: x.perfilId, de: x.de, motivo }, ...origem(req) });
  }

  return { modulo, ...resultado, estado: await obterAcessosDaUnidade({ unidadeId, atorId: ator.id }) };
}
