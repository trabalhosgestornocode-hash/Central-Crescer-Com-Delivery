// Usuários GLOBAIS e suas associações com empresas.
//
// O MODELO, EM UMA FRASE: o login pertence ao usuário; as empresas são
// associadas a ele. Nunca o contrário.
//
//   auth.users  ->  identidade (e-mail e senha, no Supabase Auth)
//   perfis      ->  dados de exibição (nome, e-mail, ativo)
//   usuarios_organizacoes -> ACESSO: uma linha por empresa, com PAPEL PRÓPRIO
//
// É por isso que o mesmo João pode ser Administrador na Subway Saci e
// Financeiro na Subway Fortaleza: o cargo é atributo da associação, não da
// pessoa. `perfis.papel` existe por legado e não autoriza nada.

import { supabase } from "../../config/supabase.js";
import { config } from "../../config/env.js";
import { ApiError } from "../../shared/ApiError.js";
import { papelValido, rotuloPapel, permissoesDoPapel } from "../../shared/permissoes.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { revogarSessoes } from "../sessao/sessao.service.js";
import {
  garantirPerfilOperacionalInicial, inserirVinculoOrgComPerfil, inserirVinculoUnidadeComPerfil,
  definirPinDoPerfil, removerPinDoPerfil, criarPerfilOperacional, definirAtivoDoPerfil,
} from "../sessao/perfil.service.js";
import { validarFormatoPin } from "../../shared/pin.js";

/**
 * Resolve o `perfil_id` REAL do alvo de uma operação de vínculo (Fase G / H1).
 *
 *   * sem `perfilIdBruto` (ou == contaId)  -> o perfil operacional INICIAL,
 *     cujo `id == conta_id` (backfill da migration 060). Isso É um `perfil_id`
 *     válido — quem chama SEMPRE escopa por ele; nunca mais existe a sentinela
 *     "perfilAlvo === usuarioId => não escopar" (que pós-063 deixava um
 *     UPDATE/DELETE do perfil inicial atingir os perfis irmãos da conta).
 *   * `perfilIdBruto` de um perfil adicional -> valida que pertence à conta
 *     (senão 404 genérico — não vaza a existência de perfis de terceiros).
 *
 * M4 (decisão de negócio): ACEITA perfil INATIVO de propósito. O SuperAdmin
 * pode montar empresa/unidade/cargo/permissões ANTES de ativar o perfil.
 * Configurar um vínculo NÃO ativa o perfil (a ativação é só `alternarAtivoPerfil`).
 *
 * Pré-060 (sem a tabela `perfis_operacionais`): devolve `contaId` — nesse
 * schema a conta é o seu próprio (único) perfil.
 *
 * @param {string} contaId
 * @param {unknown} perfilIdBruto
 * @param {typeof supabase} [db] injeção para teste
 * @returns {Promise<string>} o `perfil_id` a usar como escopo (== contaId p/ o inicial)
 */
async function resolverPerfilAlvo(contaId, perfilIdBruto, db = supabase) {
  if (perfilIdBruto == null || perfilIdBruto === "" || String(perfilIdBruto) === String(contaId)) {
    return contaId; // perfil inicial — perfil_id == conta_id (é um perfil_id real)
  }
  const perfilId = v.uuid(perfilIdBruto, "Perfil");
  const { data, error } = await db.from("perfis_operacionais")
    .select("id, conta_id").eq("id", perfilId).maybeSingle();
  if (error && /perfis_operacionais|does not exist|schema cache|could not find/i.test(error.message || "")) {
    return contaId; // pré-060
  }
  if (!data || data.conta_id !== contaId) throw ApiError.notFound("Perfil não encontrado."); // não vaza posse
  return perfilId;
}

// H1 — o perfil inicial também tem `perfil_id` (== conta_id). TODA operação de
// vínculo é escopada por ele. Só o schema pré-060, SEM a coluna, cai no caminho
// legado (e nesse schema a conta tem no máximo 1 perfil, então é seguro).
const RE_PERFIL_ID_AUSENTE = /perfil_id|does not exist|schema cache|could not find/i;

/**
 * Executa a query SEMPRE com `.eq("perfil_id", perfilAlvo)`. Se o banco
 * reclamar da coluna ausente (pré-060), reexecuta SEM o filtro.
 * @param {string} perfilAlvo
 * @param {(escopo: (q: any) => any) => PromiseLike<{data?: any, error?: any}>} montar
 *   recebe uma função que aplica (ou não) o filtro de perfil_id ao builder.
 * @returns {Promise<{data?: any, error?: any}>}
 */
async function rodarEscopadoPorPerfil(perfilAlvo, montar) {
  let r = await montar((q) => q.eq("perfil_id", perfilAlvo));
  if (r?.error && RE_PERFIL_ID_AUSENTE.test(r.error.message || "")) {
    r = await montar((q) => q); // pré-060: sem a coluna
  }
  return r;
}
import { buscar } from "./plataforma.repo.js";
import { JANELA_ONLINE_MS } from "../../middlewares/auth.js";
import * as v from "../../shared/validar.js";

const PAPEIS = /** @type {const} */ (["organization_admin", "unit_manager", "finance", "operations", "viewer"]);

/**
 * @typedef {object} VinculoEmpresa
 * @property {string} organizacaoId
 * @property {string} empresaNome
 * @property {string} papel
 * @property {string} papelRotulo
 * @property {boolean} ativo
 */

// --------------------------------------------------------------------------
// Leitura
// --------------------------------------------------------------------------

/**
 * @param {{busca?: string, limite?: unknown, semEmpresa?: boolean}} filtros
 * @param {{db?: typeof supabase}} [deps] injeção para teste.
 */
export async function listarUsuarios({ busca, limite, semEmpresa = false } = {}, deps = {}) {
  const db = deps.db ?? supabase;
  let q = db.from("perfis")
    .select("id, nome, email, ativo, created_at")
    .order("nome")
    .limit(v.limite(limite, 200, 1, 500));
  if (busca) {
    const termo = v.texto(busca, "Busca", { max: 120 }).replace(/[%,()]/g, " ");
    q = q.or(`nome.ilike.%${termo}%,email.ilike.%${termo}%`);
  }

  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);
  const usuarios = data ?? [];
  if (!usuarios.length) return [];

  const ids = usuarios.map((u) => u.id);
  const desdeOnline = new Date(Date.now() - JANELA_ONLINE_MS).toISOString();
  const [vinculos, admins, painelAdms, sessoes] = await Promise.all([
    buscar("usuarios_organizacoes", "usuario_id, organizacao_id, papel, ativo, organizacoes(id, nome)",
      (qq) => qq.in("usuario_id", ids), db),
    buscar("plataforma_admins", "usuario_id", (qq) => qq.in("usuario_id", ids).eq("ativo", true), db),
    // Acesso GLOBAL ao Painel Administrativo (monitoramento) — independente de
    // `plataforma_admins` e dos vínculos de empresa/unidade (ver migration 061).
    buscar("painel_administrativo_usuarios", "usuario_id", (qq) => qq.in("usuario_id", ids).eq("ativo", true), db),
    buscar("sessoes_contexto", "usuario_id",
      (qq) => qq.in("usuario_id", ids).is("revogada_em", null).gte("ultimo_uso_em", desdeOnline), db),
  ]);

  const porUsuario = new Map();
  for (const x of vinculos) {
    const lista = porUsuario.get(x.usuario_id) ?? [];
    lista.push({
      organizacaoId: x.organizacao_id,
      empresaNome: x.organizacoes?.nome ?? "—",
      papel: x.papel, papelRotulo: rotuloPapel(x.papel), ativo: x.ativo,
    });
    porUsuario.set(x.usuario_id, lista);
  }
  const superadmins = new Set(admins.map((a) => a.usuario_id));
  const painelAdministrativos = new Set(painelAdms.map((a) => a.usuario_id));
  const online = new Set(sessoes.map((s) => s.usuario_id));

  const lista = usuarios.map((u) => ({
    id: u.id, nome: u.nome, email: u.email, ativo: u.ativo, criadoEm: u.created_at,
    superadmin: superadmins.has(u.id),
    // Acesso EXPLÍCITO ao Painel Administrativo (não é implicado por superadmin —
    // o superadmin entra por bypass no middleware, ver requirePainelAdministrativo).
    painelAdministrativo: painelAdministrativos.has(u.id),
    online: online.has(u.id),
    empresas: porUsuario.get(u.id) ?? [],
  }));

  // "Sem empresa" é a fila de trabalho depois da virada da migration 020:
  // são as contas que existem e ainda precisam ser associadas.
  return semEmpresa ? lista.filter((u) => !u.empresas.some((e) => e.ativo)) : lista;
}

/**
 * @param {string} idBruto
 * @param {{db?: typeof supabase}} [deps] injeção para teste.
 */
export async function obterUsuario(idBruto, deps = {}) {
  const db = deps.db ?? supabase;
  const id = v.uuid(idBruto, "Usuário");
  const { data: perfil, error } = await db.from("perfis")
    .select("id, nome, email, ativo, created_at").eq("id", id).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!perfil) throw ApiError.notFound("Usuário não encontrado.");

  const [vinculos, vinculosUnidade, admin, painelAdm, sessoes, historico] = await Promise.all([
    buscar("usuarios_organizacoes", "id, organizacao_id, papel, ativo, created_at, organizacoes(id, nome, status)",
      (q) => q.eq("usuario_id", id), db),
    buscar("usuarios_unidades", "id, unidade_id, papel, ativo, unidades(id, nome, organizacao_id)",
      (q) => q.eq("usuario_id", id), db),
    db.from("plataforma_admins").select("usuario_id, observacao")
      .eq("usuario_id", id).eq("ativo", true).maybeSingle().then((r) => r.data),
    // Acesso GLOBAL ao Painel Administrativo (migration 061) — tabela própria,
    // nunca `plataforma_admins`.
    db.from("painel_administrativo_usuarios").select("usuario_id, observacao, created_at, updated_at")
      .eq("usuario_id", id).eq("ativo", true).maybeSingle().then((r) => r.data),
    buscar("sessoes_contexto", "id, perfil_id, organizacao_id, papel, criada_em, ultimo_uso_em, revogada_em, ip, organizacoes(nome)",
      (q) => q.eq("usuario_id", id).order("criada_em", { ascending: false }).limit(20), db),
    buscar("plataforma_auditoria", "id, acao, entidade, organizacao_id, detalhes, ip, created_at",
      (q) => q.eq("ator_id", id).order("created_at", { ascending: false }).limit(50), db),
  ]);

  // E-mail de LOGIN, direto do Auth. `perfis.email` é cópia para exibição e sai
  // de sincronia (trocar o login não atualiza `perfis`) — num painel de gestão
  // de acesso, mostrar o e-mail errado faz o operador tentar logar com um
  // endereço que não existe. Quando divergem, os dois aparecem.
  const authUser = await buscarNoAuth(id, db);
  const emailLogin = authUser?.email ?? null;

  // Fase I — os PERFIS operacionais desta CONTA (perfis_operacionais). Degrada
  // pré-060 (sem a tabela) tratando a conta como seu próprio perfil.
  let perfisOp = [];
  {
    const r = await db.from("perfis_operacionais").select("id, nome, ativo").eq("conta_id", id);
    if (r.error && /perfis_operacionais|does not exist|schema cache|could not find/i.test(r.error.message || "")) {
      perfisOp = [{ id, nome: perfil.nome, ativo: perfil.ativo }];
    } else {
      perfisOp = r.data?.length ? r.data : [{ id, nome: perfil.nome, ativo: perfil.ativo }];
    }
  }
  const nomePerfil = new Map(perfisOp.map((p) => [p.id, p.nome]));

  return {
    id: perfil.id, nome: perfil.nome, email: perfil.email, ativo: perfil.ativo, criadoEm: perfil.created_at,
    emailLogin,
    emailDivergente: !!emailLogin && (perfil.email ?? "").toLowerCase() !== emailLogin.toLowerCase(),
    ultimoLogin: authUser?.last_sign_in_at ?? null,
    superadmin: !!admin,
    observacaoSuperadmin: admin?.observacao ?? null,
    // Painel Administrativo (acesso global de monitoramento). Explícito e
    // separado de `superadmin` — ver item 10 do pedido / requirePainelAdministrativo.
    painelAdministrativo: !!painelAdm,
    observacaoPainelAdministrativo: painelAdm?.observacao ?? null,
    painelAdministrativoDesde: painelAdm?.created_at ?? null,
    empresas: vinculos.map((x) => ({
      vinculoId: x.id, organizacaoId: x.organizacao_id,
      empresaNome: x.organizacoes?.nome ?? "—", empresaStatus: x.organizacoes?.status ?? null,
      papel: x.papel, papelRotulo: rotuloPapel(x.papel), ativo: x.ativo, desde: x.created_at,
    })),
    unidades: vinculosUnidade.map((x) => ({
      vinculoId: x.id, unidadeId: x.unidade_id, unidadeNome: x.unidades?.nome ?? "—",
      organizacaoId: x.unidades?.organizacao_id ?? null,
      papel: x.papel, papelRotulo: x.papel ? rotuloPapel(x.papel) : "herda da empresa", ativo: x.ativo,
    })),
    // Fase I — os perfis operacionais da conta (a CONTA tem 1 hoje; N na Fase G).
    perfisOperacionais: perfisOp.map((p) => ({ id: p.id, nome: p.nome, ativo: p.ativo })),
    sessoes: sessoes.map((s) => ({
      id: s.id, empresa: s.organizacoes?.nome ?? null, papel: s.papel,
      perfilId: s.perfil_id ?? null,   // null = impersonação
      perfilNome: s.perfil_id ? (nomePerfil.get(s.perfil_id) ?? null) : null,
      criadaEm: s.criada_em, ultimoUso: s.ultimo_uso_em, revogadaEm: s.revogada_em, ip: s.ip,
      viva: !s.revogada_em,
    })),
    // Fase I — "online" distinguível por PESSOA. `contaOnline` = qualquer sessão
    // viva; `porPerfil` = sessões vivas de cada perfil; `impersonacoesVivas` =
    // sessões vivas sem perfil (superadmin dentro da empresa).
    sessoesResumo: (() => {
      const vivas = sessoes.filter((s) => !s.revogada_em);
      const porPerfil = perfisOp.map((p) => ({
        perfilId: p.id, nome: p.nome, ativo: p.ativo,
        sessoesVivas: vivas.filter((s) => s.perfil_id === p.id).length,
      }));
      return {
        contaOnline: vivas.length > 0,
        totalSessoesVivas: vivas.length,
        impersonacoesVivas: vivas.filter((s) => !s.perfil_id).length,
        porPerfil,
      };
    })(),
    historico: historico.map((h) => ({
      id: h.id, acao: h.acao, entidade: h.entidade, organizacaoId: h.organizacao_id,
      detalhes: h.detalhes, ip: h.ip, em: h.created_at,
    })),
  };
}

// --------------------------------------------------------------------------
// Escrita — conta
// --------------------------------------------------------------------------

/**
 * Cria a conta (Auth + perfil) e, opcionalmente, já associa empresas com papel.
 * É a tela "Associação de Usuários": nome, e-mail, senha e a lista de empresas
 * com o cargo de cada uma.
 *
 * Se o perfil falhar, a conta do Auth é removida — conta órfã no Auth é um
 * problema silencioso e chato de descobrir depois.
 * @param {import('express').Request} req
 */
export async function criarUsuario(req, body) {
  const nome = v.texto(body.nome, "Nome", { max: 160 });
  const email = v.email(body.email);
  const senha = v.senha(body.senha);
  const empresas = normalizarEmpresas(body.empresas);

  const { data: criado, error: e1 } = await supabase.auth.admin.createUser({
    email, password: senha, email_confirm: true, user_metadata: { nome },
  });
  if (e1 || !criado?.user) throw ApiError.badRequest(traduzErroAuth(e1?.message));
  const usuarioId = criado.user.id;

  const { error: e2 } = await supabase.from("perfis").insert({
    id: usuarioId, nome, email, ativo: true,
    // organizacao_id fica NULO de propósito: o acesso vem dos vínculos.
    organizacao_id: null, unidade_id: null,
  });
  if (e2) {
    await supabase.auth.admin.deleteUser(usuarioId).catch(() => {});
    throw ApiError.badRequest(traduzErroAuth(e2.message));
  }

  // Perfil operacional INICIAL da conta nova (a 060 só backfillou contas que
  // já existiam). id == usuarioId (UUID reaproveitado). FK dos vínculos.
  const perfilId = await garantirPerfilOperacionalInicial({ contaId: usuarioId, nome, ativo: true });

  const vinculados = [];
  for (const emp of empresas) {
    const error = await inserirVinculoOrgComPerfil({
      usuarioId, perfilId, organizacaoId: emp.organizacaoId, papel: emp.papel,
    });
    if (error) { console.error("[plataforma] vínculo não criado:", error.message); continue; }
    vinculados.push(emp);
  }

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.USUARIO_CRIADO, entidade: "usuario", entidadeId: usuarioId,
    detalhes: { nome, email, empresas: vinculados }, ...origemDe(req),
  });

  return { id: usuarioId, nome, email, ativo: true, empresas: vinculados };
}

/** @param {import('express').Request} req */
export async function atualizarUsuario(req, idBruto, body) {
  const id = v.uuid(idBruto, "Usuário");
  const patch = {};
  if (body.nome !== undefined) patch.nome = v.texto(body.nome, "Nome", { max: 160 });
  if (body.ativo !== undefined) patch.ativo = v.booleano(body.ativo, true);
  if (!Object.keys(patch).length) throw ApiError.badRequest("Nada para atualizar.");

  // Um superadmin não se desativa. Ele perderia o acesso ao painel e não
  // haveria caminho pela UI para desfazer — só SQL direto no banco.
  if (patch.ativo === false && id === req.user.id) {
    throw ApiError.badRequest("Você não pode desativar a própria conta.");
  }

  const { data, error } = await supabase.from("perfis")
    .update(patch).eq("id", id).select("id, nome, ativo").single();
  if (error || !data) throw ApiError.notFound("Usuário não encontrado.");

  // Desativar a conta precisa derrubar quem já está dentro — senão o bloqueio
  // só valeria no próximo login.
  let sessoesRevogadas = 0;
  if (patch.ativo === false) {
    sessoesRevogadas = await revogarSessoes({ usuarioId: id, motivo: "usuario_desativado" });
  }

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: patch.ativo === false ? ACOES.USUARIO_BLOQUEADO : ACOES.USUARIO_EDITADO,
    entidade: "usuario", entidadeId: id,
    detalhes: { campos: Object.keys(patch), sessoesRevogadas }, ...origemDe(req),
  });

  return { id, ...patch, sessoesRevogadas };
}

/**
 * Redefine a senha. A nova senha NÃO é registrada na auditoria — só o fato de
 * ter sido trocada, por quem e quando.
 * @param {import('express').Request} req
 */
export async function redefinirSenha(req, idBruto, body) {
  const id = v.uuid(idBruto, "Usuário");
  const senha = v.senha(body.senha);

  const { error } = await supabase.auth.admin.updateUserById(id, { password: senha });
  if (error) throw ApiError.badRequest(traduzErroAuth(error.message));

  // Trocar a senha invalida as sessões: se a troca é por suspeita de
  // comprometimento, manter a sessão aberta anula o efeito.
  const sessoesRevogadas = await revogarSessoes({ usuarioId: id, motivo: "senha_redefinida" });

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.USUARIO_SENHA_REDEFINIDA, entidade: "usuario", entidadeId: id,
    detalhes: { sessoesRevogadas }, ...origemDe(req),
  });
  return { id, sessoesRevogadas };
}

/** @param {import('express').Request} req */
export async function alterarEmail(req, idBruto, body) {
  const id = v.uuid(idBruto, "Usuário");
  const email = v.email(body.email);

  const { data: antes } = await supabase.from("perfis").select("email").eq("id", id).maybeSingle();

  const { error } = await supabase.auth.admin.updateUserById(id, { email, email_confirm: true });
  if (error) throw ApiError.badRequest(traduzErroAuth(error.message));
  // `perfis.email` é cópia para exibição — precisa acompanhar, senão o painel
  // mostra um e-mail e o login usa outro.
  await supabase.from("perfis").update({ email }).eq("id", id);

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.USUARIO_EMAIL_ALTERADO, entidade: "usuario", entidadeId: id,
    detalhes: { de: antes?.email ?? null, para: email }, ...origemDe(req),
  });
  return { id, email };
}

/**
 * Encerra sessões à força (SuperAdmin). Fase I — DUAS semânticas explícitas:
 *
 *   * `perfilId` informado -> encerra só as sessões DAQUELA PESSOA
 *     (`revogarSessoes({ perfilId })`). NÃO toca o Supabase Auth: a credencial
 *     compartilhada segue válida e os OUTROS perfis da mesma conta continuam
 *     logados. É o "Encerrar sessões deste perfil".
 *
 *   * `perfilId` ausente -> encerra a CONTA inteira: todas as sessões de todos
 *     os perfis (`revogarSessoes({ usuarioId })`) MAIS a revogação global no
 *     Auth (`encerrarSessoesAuth`) — o usuário precisa logar de novo. É o
 *     "Encerrar sessões desta conta".
 *
 * @param {import('express').Request} req
 * @param {string} idBruto  a CONTA (perfis.id / auth.users.id)
 * @param {string|null} [perfilIdBruto]  quando presente, escopa ao perfil
 */
export async function forcarLogout(req, idBruto, perfilIdBruto = null) {
  const id = v.uuid(idBruto, "Usuário");

  if (perfilIdBruto != null && perfilIdBruto !== "") {
    const perfilId = v.uuid(perfilIdBruto, "Perfil");
    const sessoesRevogadas = await revogarSessoes({ perfilId, motivo: "logout_forcado_perfil" });
    await auditar({
      atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
      acao: ACOES.USUARIO_LOGOUT_FORCADO, entidade: "usuario", entidadeId: id,
      detalhes: { escopo: "perfil", perfilId, sessoesRevogadas, authEncerrado: false }, ...origemDe(req),
    });
    return { id, escopo: "perfil", perfilId, sessoesRevogadas, authEncerrado: false };
  }

  const sessoesRevogadas = await revogarSessoes({ usuarioId: id, motivo: "logout_forcado" });
  // Revogar as sessões do Auth também. Sem isso o usuário continuaria
  // autenticado (só sem contexto) e escolheria a empresa novamente.
  const authEncerrado = await encerrarSessoesAuth(id);

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.USUARIO_LOGOUT_FORCADO, entidade: "usuario", entidadeId: id,
    detalhes: { escopo: "conta", sessoesRevogadas, authEncerrado }, ...origemDe(req),
  });
  return { id, escopo: "conta", sessoesRevogadas, authEncerrado };
}

// ==========================================================================
// FASE G — múltiplos PERFIS operacionais por conta de acesso
// ==========================================================================

/**
 * Perfis operacionais de uma conta, com os vínculos de CADA perfil e o
 * booleano `temPin` (NUNCA o hash). É o que a tela "Usuários desta conta"
 * do painel SuperAdmin renderiza.
 * @param {string} contaIdBruto
 */
export async function perfisDaConta(contaIdBruto, deps = {}) {
  const db = deps.db ?? supabase;
  const contaId = v.uuid(contaIdBruto, "Usuário");

  const { data: conta } = await db.from("perfis").select("id, nome, email, ativo").eq("id", contaId).maybeSingle();
  if (!conta) throw ApiError.notFound("Conta de acesso não encontrada.");

  let perfis;
  const rp = await db.from("perfis_operacionais")
    .select("id, nome, ativo, pin_hash, created_at").eq("conta_id", contaId).order("created_at");
  if (rp.error && /perfis_operacionais|does not exist|schema cache/i.test(rp.error.message || "")) {
    perfis = [{ id: contaId, nome: conta.nome, ativo: conta.ativo, pin_hash: null }]; // pré-060
  } else {
    perfis = rp.data?.length ? rp.data : [{ id: contaId, nome: conta.nome, ativo: conta.ativo, pin_hash: null }];
  }

  const [vOrg, vUni] = await Promise.all([
    buscar("usuarios_organizacoes", "organizacao_id, papel, ativo, perfil_id, usuario_id, organizacoes(id, nome, status)",
      (q) => q.eq("usuario_id", contaId), db),
    buscar("usuarios_unidades", "unidade_id, papel, ativo, perfil_id, usuario_id, unidades(id, nome, organizacao_id)",
      (q) => q.eq("usuario_id", contaId), db),
  ]);
  const chave = (x) => x.perfil_id ?? x.usuario_id ?? contaId;

  const ativosComPin = perfis.filter((p) => p.ativo && p.pin_hash).length;
  const ativos = perfis.filter((p) => p.ativo).length;

  return {
    conta: { id: conta.id, nome: conta.nome, email: conta.email, ativo: conta.ativo },
    multiPerfil: ativos >= 2,
    configPinCompleta: ativos < 2 || ativosComPin === ativos,
    perfis: perfis.map((p) => ({
      id: p.id,
      nome: p.nome,
      ativo: p.ativo,
      inicial: p.id === contaId,
      temPin: !!p.pin_hash, // NUNCA o hash
      empresas: vOrg.filter((x) => chave(x) === p.id).map((x) => ({
        organizacaoId: x.organizacao_id, empresaNome: x.organizacoes?.nome ?? "—",
        empresaStatus: x.organizacoes?.status ?? null,
        papel: x.papel, papelRotulo: rotuloPapel(x.papel), ativo: x.ativo,
      })),
      unidades: vUni.filter((x) => chave(x) === p.id).map((x) => ({
        unidadeId: x.unidade_id, unidadeNome: x.unidades?.nome ?? "—",
        organizacaoId: x.unidades?.organizacao_id ?? null,
        papel: x.papel, papelRotulo: x.papel ? rotuloPapel(x.papel) : "herda da empresa", ativo: x.ativo,
      })),
    })),
  };
}

/**
 * Adiciona um PERFIL operacional a uma conta existente (Fase G). O 2º perfil
 * NÃO cria auth.users, NÃO cria e-mail, NÃO cria segunda conta Supabase — é
 * uma linha em `perfis_operacionais` da MESMA conta.
 *
 * FLUXO TRANSACIONAL (compensação em caso de falha — o perfil recém-criado é
 * apagado por completo, sem history, deixando a conta como estava):
 *   0. valida TUDO antes de qualquer escrita (conta, orgs, cargos, PIN);
 *   1. se a conta VAI passar a ter 2+ perfis ativos, TODOS os perfis ativos
 *      precisam de PIN — os que faltam vêm em `body.pinsPerfisExistentes`
 *      [{ perfilId, pin }] OU a operação é recusada com a lista pendente;
 *   2. cria o perfil (UUID novo);
 *   3. cria os vínculos de empresa/unidade do novo perfil (perfil_id);
 *   4. grava o PIN do novo perfil;
 *   5. grava o PIN dos perfis existentes que faltavam;
 *   -> qualquer falha em 3/4: apaga o perfil novo (CASCADE nos vínculos) e lança.
 *
 * @param {import('express').Request} req
 * @param {string} contaIdBruto
 * @param {{ nome, pin, empresas:[{organizacaoId,papel}], unidades?:[{unidadeId,papel}], ativo?, pinsPerfisExistentes?:[{perfilId,pin}] }} body
 */
export async function criarPerfilNaConta(req, contaIdBruto, body) {
  const contaId = v.uuid(contaIdBruto, "Usuário");
  const nome = v.texto(body?.nome, "Nome do usuário", { max: 160 });
  const ativo = body?.ativo === undefined ? true : v.booleano(body.ativo, true);
  const empresas = normalizarEmpresas(body?.empresas);
  const unidades = Array.isArray(body?.unidades) ? body.unidades : [];
  const pinNovo = validarFormatoPin(body?.pin); // Fase H — obrigatório para o novo perfil

  // ---- 0. conta existe? ----
  const { data: conta } = await supabase.from("perfis").select("id, nome, ativo").eq("id", contaId).maybeSingle();
  if (!conta) throw ApiError.notFound("Conta de acesso não encontrada.");

  // ---- 1. estado de PIN dos perfis já existentes ----
  const { data: existentes, error: eEx } = await supabase.from("perfis_operacionais")
    .select("id, nome, ativo, pin_hash").eq("conta_id", contaId);
  if (eEx && /perfis_operacionais|does not exist|schema cache/i.test(eEx.message || "")) {
    throw ApiError.badRequest("A base ainda não suporta múltiplos usuários por conta (migration 060 pendente). Aplique 060 e 063 no staging primeiro.");
  }
  const ativosExistentes = (existentes ?? []).filter((p) => p.ativo);
  // a conta VAI ter 2+ ativos? (os existentes ativos + este, se ativo)
  const viraMulti = (ativosExistentes.length + (ativo ? 1 : 0)) >= 2;

  /** @type {Map<string,string>} perfilId -> pin a configurar */
  const pinsPendentes = new Map();
  if (viraMulti) {
    const semPin = ativosExistentes.filter((p) => !p.pin_hash);
    const fornecidos = new Map(
      (Array.isArray(body?.pinsPerfisExistentes) ? body.pinsPerfisExistentes : [])
        .map((x) => [v.uuid(x?.perfilId, "Perfil"), validarFormatoPin(x?.pin)]),
    );
    for (const p of semPin) {
      if (!fornecidos.has(p.id)) {
        throw new ApiError(409,
          "Antes de adicionar outro usuário, defina um PIN para os usuários que ainda não têm.",
          { codigo: "PIN_PENDENTE_PERFIS_EXISTENTES", perfis: semPin.map((x) => ({ id: x.id, nome: x.nome })) });
      }
      pinsPendentes.set(p.id, fornecidos.get(p.id));
    }
  }

  // ---- validação de orgs/unidades ANTES de escrever ----
  const orgIds = [...new Set(empresas.map((e) => e.organizacaoId))];
  const { data: orgsOk } = await supabase.from("organizacoes").select("id").in("id", orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"]);
  const orgSet = new Set((orgsOk ?? []).map((o) => o.id));
  for (const e of empresas) if (!orgSet.has(e.organizacaoId)) throw ApiError.badRequest("Uma das empresas informadas não existe.");

  // ---- 2. cria o perfil (UUID novo) ----
  const perfil = await criarPerfilOperacional({ contaId, nome, ativo });

  try {
    // ---- 3. vínculos do novo perfil ----
    for (const e of empresas) {
      const err = await inserirVinculoOrgComPerfil({ usuarioId: contaId, perfilId: perfil.id, organizacaoId: e.organizacaoId, papel: e.papel });
      if (err?.codigo) throw ApiError.badRequest(err.message, { codigo: err.codigo });
      if (err) throw ApiError.internal(err.message);
    }
    for (const u of unidades) {
      const unidadeId = v.uuid(u?.unidadeId, "Unidade");
      const papelU = u?.papel == null || u?.papel === "" ? null : v.umDe(u.papel, "Cargo", PAPEIS);
      const err = await inserirVinculoUnidadeComPerfil({ usuarioId: contaId, perfilId: perfil.id, unidadeId, papel: papelU });
      if (err?.codigo) throw ApiError.badRequest(err.message, { codigo: err.codigo });
      if (err) throw ApiError.internal(err.message);
    }
    // ---- 4. PIN do novo perfil (sem revogar sessões — o perfil não tem nenhuma) ----
    await definirPinDoPerfil({ contaId, perfilId: perfil.id, pin: pinNovo, motivo: "pin_definido", revogarSessoesDoPerfil: false });
    // ---- 5. PIN dos perfis existentes que faltavam ----
    for (const [pid, pin] of pinsPendentes) {
      await definirPinDoPerfil({ contaId, perfilId: pid, pin, motivo: "pin_definido" });
    }
  } catch (erro) {
    // compensação: apaga o perfil novo (CASCADE remove seus vínculos)
    await supabase.from("perfis_operacionais").delete().eq("id", perfil.id).catch(() => {});
    throw erro;
  }

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    perfilId: req.perfil?.id ?? null,
    acao: ACOES.PERFIL_CRIADO, entidade: "perfil_operacional", entidadeId: perfil.id,
    detalhes: { conta: contaId, nome, empresas: empresas.map((e) => e.organizacaoId), pinsExistentesConfigurados: [...pinsPendentes.keys()] },
    ...origemDe(req),
  });

  return { perfilId: perfil.id, nome: perfil.nome, ativo: perfil.ativo, empresas: empresas.length, unidades: unidades.length };
}

/**
 * Renomeia um perfil (Fase G). NÃO toca e-mail/senha da conta.
 * @param {import('express').Request} req
 */
export async function renomearPerfil(req, contaIdBruto, perfilIdBruto, body) {
  const contaId = v.uuid(contaIdBruto, "Usuário");
  const perfilId = await resolverPerfilAlvo(contaId, perfilIdBruto);
  const nome = v.texto(body?.nome, "Nome do usuário", { max: 160 });

  const { data, error } = await supabase.from("perfis_operacionais")
    .update({ nome }).eq("id", perfilId).eq("conta_id", contaId).select("id, nome").single();
  if (error || !data) throw ApiError.notFound("Perfil não encontrado.");

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    perfilId: req.perfil?.id ?? null,
    acao: ACOES.PERFIL_EDITADO, entidade: "perfil_operacional", entidadeId: perfilId,
    detalhes: { conta: contaId, nome }, ...origemDe(req),
  });
  return { perfilId, nome: data.nome };
}

/**
 * Ativa/desativa um perfil (Fase G — nunca DELETE). Desativar revoga só as
 * sessões daquele perfil. Reativar exige config de PIN completa se a conta
 * ficar multi-perfil.
 * @param {import('express').Request} req
 */
export async function alternarAtivoPerfil(req, contaIdBruto, perfilIdBruto, body) {
  const contaId = v.uuid(contaIdBruto, "Usuário");
  const perfilId = v.uuid(perfilIdBruto, "Perfil");
  const ativo = v.booleano(body?.ativo, true);

  const r = await definirAtivoDoPerfil({ contaId, perfilId, ativo });

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    perfilId: req.perfil?.id ?? null,
    acao: ativo ? ACOES.PERFIL_ATIVADO : ACOES.PERFIL_DESATIVADO,
    entidade: "perfil_operacional", entidadeId: perfilId,
    detalhes: { conta: contaId, sessoesRevogadas: r.sessoesRevogadas }, ...origemDe(req),
  });
  return r;
}

/**
 * SuperAdmin define/reseta o PIN de um PERFIL operacional (Fase H). Atua SÓ em
 * perfil que já existe — NÃO cria perfil. "Definir pela 1ª vez" e "reset
 * administrativo" são a MESMA operação: grava o hash, zera tentativas, limpa
 * bloqueio e revoga TODAS as sessões daquele perfil (não os irmãos).
 * O PIN em texto puro nunca sai do corpo da requisição — nunca é auditado.
 * @param {import('express').Request} req
 */
export async function definirPinPerfil(req, contaIdBruto, perfilIdBruto, body) {
  const contaId = v.uuid(contaIdBruto, "Usuário");
  const perfilId = v.uuid(perfilIdBruto, "Perfil");
  const r = await definirPinDoPerfil({ contaId, perfilId, pin: body?.pin, motivo: "pin_reset_admin" });
  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.PERFIL_PIN_DEFINIDO, entidade: "perfil_operacional", entidadeId: perfilId,
    detalhes: { conta: contaId, sessoesRevogadas: r.sessoesRevogadas }, ...origemDe(req),
  });
  return { perfilId, sessoesRevogadas: r.sessoesRevogadas };
}

/** @param {import('express').Request} req */
export async function removerPinPerfil(req, contaIdBruto, perfilIdBruto) {
  const contaId = v.uuid(contaIdBruto, "Usuário");
  const perfilId = v.uuid(perfilIdBruto, "Perfil");
  const r = await removerPinDoPerfil({ contaId, perfilId });
  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.PERFIL_PIN_REMOVIDO, entidade: "perfil_operacional", entidadeId: perfilId,
    detalhes: { conta: contaId, sessoesRevogadas: r.sessoesRevogadas }, ...origemDe(req),
  });
  return { perfilId, sessoesRevogadas: r.sessoesRevogadas };
}

/** @param {import('express').Request} req */
export async function excluirUsuario(req, idBruto) {
  const id = v.uuid(idBruto, "Usuário");
  if (id === req.user.id) throw ApiError.badRequest("Você não pode excluir a própria conta.");

  const { data: perfil } = await supabase.from("perfis").select("id, nome, email").eq("id", id).maybeSingle();

  // Auditoria antes do delete: depois, o e-mail já não existe em lugar algum.
  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.USUARIO_EXCLUIDO, entidade: "usuario", entidadeId: id,
    detalhes: { nome: perfil?.nome ?? null, email: perfil?.email ?? null }, ...origemDe(req),
  });

  // Apagar do Auth cascateia para `perfis` e para os vínculos (FKs on delete cascade).
  const { error } = await supabase.auth.admin.deleteUser(id);
  if (error) throw ApiError.badRequest(traduzErroAuth(error.message));
  return { id, excluido: true };
}

// --------------------------------------------------------------------------
// Escrita — associações usuário <-> empresa
// --------------------------------------------------------------------------

/**
 * Associa (ou reativa) o usuário a uma empresa com um papel.
 * Upsert em vez de insert: reassociar alguém que já foi removido é rotina, e
 * um erro de chave duplicada nesse caso seria só atrito.
 * @param {import('express').Request} req
 */
export async function associarEmpresa(req, idBruto, body) {
  const usuarioId = v.uuid(idBruto, "Usuário");
  const organizacaoId = v.uuid(body.organizacaoId, "Empresa");
  const papel = v.umDe(body.papel, "Cargo", PAPEIS);

  const [{ data: usuario }, { data: empresa }] = await Promise.all([
    supabase.from("perfis").select("id, nome").eq("id", usuarioId).maybeSingle(),
    supabase.from("organizacoes").select("id, nome").eq("id", organizacaoId).maybeSingle(),
  ]);
  if (!usuario) throw ApiError.notFound("Usuário não encontrado.");
  if (!empresa) throw ApiError.notFound("Empresa não encontrada.");

  // Fase G — `body.perfilId` mira um perfil específico da conta; ausente ->
  // perfil inicial (garantido para contas legadas que nunca tiveram a linha).
  const perfilId = (body.perfilId && String(body.perfilId) !== String(usuarioId))
    ? await resolverPerfilAlvo(usuarioId, body.perfilId)
    : await garantirPerfilOperacionalInicial({ contaId: usuarioId, nome: usuario.nome });
  const error = await inserirVinculoOrgComPerfil({ usuarioId, perfilId, organizacaoId, papel, upsert: true });
  if (error?.codigo) throw ApiError.badRequest(error.message, { codigo: error.codigo });
  if (error) throw ApiError.internal(error.message);

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.VINCULO_CRIADO, entidade: "vinculo", entidadeId: `${usuarioId}:${organizacaoId}`,
    organizacaoId, detalhes: { usuario: usuario.nome, empresa: empresa.nome, papel }, ...origemDe(req),
  });

  return { usuarioId, organizacaoId, papel, papelRotulo: rotuloPapel(papel), ativo: true };
}

/**
 * Associação EM MASSA — cria N vínculos novos numa operação atômica.
 *
 * Conceitualmente responsável APENAS por NOVAS associações. Se qualquer
 * `organizacaoId` da lista já estiver vinculada ao usuário, o endpoint
 * RECUSA a operação inteira (409) e não grava nada — nem via upsert, nem de
 * outra forma. Alterar o cargo de um vínculo existente é trabalho do
 * `atualizarVinculo` (endpoint separado, com revogação de sessão). Assim é
 * impossível um bug de frontend mudar acidentalmente um cargo já existente
 * pela tela "Associar empresas".
 *
 * Atomicidade: um único INSERT com array. A constraint
 * `unique (usuario_id, organizacao_id)` (migration 015) garante que uma
 * corrida (vínculo criado entre a checagem e o insert) derruba o INSERT
 * INTEIRO — ou entra tudo, ou nada.
 *
 * @param {import('express').Request} req
 * @param {string} idBruto
 * @param {{itens?: Array<{organizacaoId: string, papel: string}>}} body
 * @param {{supabase?: any, auditar?: Function}} [deps]
 */
export async function associarEmpresasLote(req, idBruto, body, deps = {}) {
  const db = deps.supabase ?? supabase;
  const registrar = deps.auditar ?? auditar;

  const usuarioId = v.uuid(idBruto, "Usuário");
  const itens = normalizarEmpresas(body?.itens);
  if (!itens.length) throw ApiError.badRequest("Selecione ao menos uma empresa.");

  const ids = itens.map((i) => i.organizacaoId);
  const idsUnicos = [...new Set(ids)];
  if (idsUnicos.length !== ids.length) throw ApiError.badRequest("Empresa repetida na seleção.");

  const { data: usuario } = await db.from("perfis").select("id, nome").eq("id", usuarioId).maybeSingle();
  if (!usuario) throw ApiError.notFound("Usuário não encontrado.");

  const { data: orgs, error: eOrgs } = await db.from("organizacoes").select("id, nome").in("id", idsUnicos);
  if (eOrgs) throw ApiError.internal(eOrgs.message);
  const orgPorId = new Map((orgs ?? []).map((o) => [o.id, o]));
  if (orgPorId.size !== idsUnicos.length) {
    throw ApiError.badRequest("Uma ou mais empresas da seleção não existem.");
  }

  // NENHUM vínculo já existente pode ser tocado por este fluxo.
  const { data: existentes, error: eEx } = await db.from("usuarios_organizacoes")
    .select("organizacao_id").eq("usuario_id", usuarioId).in("organizacao_id", idsUnicos);
  if (eEx) throw ApiError.internal(eEx.message);
  if (existentes?.length) {
    throw new ApiError(409,
      "Uma ou mais empresas já estão associadas a este usuário. Este fluxo só cria novas associações — "
      + "para mudar o cargo de um vínculo que já existe, use a edição do vínculo.",
      { jaAssociadas: existentes.map((x) => ({ organizacaoId: x.organizacao_id, empresaNome: orgPorId.get(x.organizacao_id)?.nome ?? null })) });
  }

  // `perfil_id` = o perfil operacional INICIAL da conta (== usuarioId; existe
  // desde a 060/criarUsuario). Fase E — chave canônica do vínculo.
  const base = itens.map((i) => ({ usuario_id: usuarioId, organizacao_id: i.organizacaoId, papel: i.papel, ativo: true }));
  let { error } = await db.from("usuarios_organizacoes").insert(base.map((l) => ({ ...l, perfil_id: usuarioId })));
  if (error && /perfil_id|does not exist|schema cache|could not find/i.test(error.message || "")) {
    ({ error } = await db.from("usuarios_organizacoes").insert(base)); // pré-060
  }
  if (error) {
    if (/duplicate key|unique|already exists/i.test(error.message || "")) {
      throw new ApiError(409, "Uma associação foi criada em paralelo. Recarregue e tente de novo.", { corrida: true });
    }
    throw ApiError.internal(error.message);
  }

  const criadas = itens.map((i) => ({
    organizacaoId: i.organizacaoId,
    empresaNome: orgPorId.get(i.organizacaoId)?.nome ?? null,
    papel: i.papel, papelRotulo: rotuloPapel(i.papel), ativo: true,
  }));

  await registrar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.VINCULO_CRIADO, entidade: "vinculo", entidadeId: `${usuarioId}:lote`,
    detalhes: { usuario: usuario.nome, empresas: criadas.map((c) => ({ organizacaoId: c.organizacaoId, empresa: c.empresaNome, papel: c.papel })) },
    ...origemDe(req),
  });

  return { usuarioId, criadas };
}

/**
 * Troca o cargo ou bloqueia o acesso do usuário APENAS naquela empresa.
 *
 * Revoga as sessões daquele usuário nessa empresa — as permissões ficam
 * gravadas na sessão, então sem revogar o cargo novo só valeria na próxima
 * seleção de contexto.
 * @param {import('express').Request} req
 */
export async function atualizarVinculo(req, idBruto, organizacaoIdBruto, body, deps = {}) {
  const db = deps.supabase ?? supabase;
  const registrar = deps.auditar ?? auditar;
  const revogar = deps.revogar ?? revogarSessoes;
  const usuarioId = v.uuid(idBruto, "Usuário");
  const organizacaoId = v.uuid(organizacaoIdBruto, "Empresa");
  const perfilAlvo = await resolverPerfilAlvo(usuarioId, body.perfilId, db);

  const patch = {};
  if (body.papel !== undefined) patch.papel = v.umDe(body.papel, "Cargo", PAPEIS);
  if (body.ativo !== undefined) patch.ativo = v.booleano(body.ativo, true);
  if (!Object.keys(patch).length) throw ApiError.badRequest("Informe o cargo ou o status do acesso.");

  // H1 — SEMPRE escopa por perfil_id (o perfil inicial também tem perfil_id ==
  // conta_id). Nunca toca a linha de um perfil irmão da mesma conta.
  const { data, error } = await rodarEscopadoPorPerfil(perfilAlvo, (escopo) =>
    escopo(db.from("usuarios_organizacoes")
      .update(patch).eq("usuario_id", usuarioId).eq("organizacao_id", organizacaoId))
      .select("id, papel, ativo, perfil_id").single());
  if (error || !data) throw ApiError.notFound("Associação não encontrada.");

  // MODEL Y: só as sessões DAQUELE PERFIL naquela empresa — nunca um perfil
  // irmão da mesma conta, nem a conta em outra empresa.
  const sessoesRevogadas = await revogar({
    perfilId: data.perfil_id ?? perfilAlvo, organizacaoId,
    motivo: patch.ativo === false ? "acesso_bloqueado" : "papel_alterado",
  });

  await registrar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.VINCULO_EDITADO, entidade: "vinculo", entidadeId: `${usuarioId}:${organizacaoId}`,
    organizacaoId, detalhes: { ...patch, sessoesRevogadas }, ...origemDe(req),
  });

  return { usuarioId, organizacaoId, papel: data.papel, papelRotulo: rotuloPapel(data.papel), ativo: data.ativo, sessoesRevogadas };
}

/** Remove a associação (e os vínculos de unidade daquela empresa). */
export async function removerVinculo(req, idBruto, organizacaoIdBruto, opts = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const registrar = deps.auditar ?? auditar;
  const revogar = deps.revogar ?? revogarSessoes;
  const usuarioId = v.uuid(idBruto, "Usuário");
  const organizacaoId = v.uuid(organizacaoIdBruto, "Empresa");
  const perfilAlvo = await resolverPerfilAlvo(usuarioId, opts.perfilId, db);

  // H1 — perfil_id ANTES de apagar (escopo Model Y da revogação). SEMPRE
  // escopado: o perfil inicial não é exceção.
  const { data: vinculo } = await rodarEscopadoPorPerfil(perfilAlvo, (escopo) =>
    escopo(db.from("usuarios_organizacoes")
      .select("perfil_id").eq("usuario_id", usuarioId).eq("organizacao_id", organizacaoId)).maybeSingle());
  const perfilId = vinculo?.perfil_id ?? perfilAlvo;

  const { error } = await rodarEscopadoPorPerfil(perfilAlvo, (escopo) =>
    escopo(db.from("usuarios_organizacoes")
      .delete().eq("usuario_id", usuarioId).eq("organizacao_id", organizacaoId)));
  if (error) throw ApiError.internal(error.message);

  // Vínculos de unidade da mesma empresa perderiam sentido — e sobrariam como
  // acesso residual, já que a unidade sozinha também autoriza a seleção. Só as
  // unidades DESTE perfil (H1 — nunca as de um irmão).
  const unidades = await buscar("unidades", "id", (q) => q.eq("organizacao_id", organizacaoId), db);
  if (unidades.length) {
    await rodarEscopadoPorPerfil(perfilAlvo, (escopo) =>
      escopo(db.from("usuarios_unidades").delete()
        .eq("usuario_id", usuarioId).in("unidade_id", unidades.map((u) => u.id))));
  }

  const sessoesRevogadas = await revogar({ perfilId, organizacaoId, motivo: "vinculo_removido" });

  await registrar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.VINCULO_REMOVIDO, entidade: "vinculo", entidadeId: `${usuarioId}:${organizacaoId}`,
    organizacaoId, detalhes: { sessoesRevogadas }, ...origemDe(req),
  });

  return { usuarioId, organizacaoId, removido: true, sessoesRevogadas };
}

/**
 * Associa o usuário a uma UNIDADE específica. `papel` nulo = herda o da
 * empresa. Exige que o vínculo com a empresa da unidade já exista — caso
 * contrário o acesso ficaria pendurado numa empresa à qual a pessoa não
 * pertence.
 */
export async function associarUnidade(req, idBruto, body, deps = {}) {
  const db = deps.supabase ?? supabase;
  const registrar = deps.auditar ?? auditar;
  const usuarioId = v.uuid(idBruto, "Usuário");
  const unidadeId = v.uuid(body.unidadeId, "Unidade");
  const papel = body.papel == null || body.papel === "" ? null : v.umDe(body.papel, "Cargo", PAPEIS);
  const perfilAlvo = await resolverPerfilAlvo(usuarioId, body.perfilId, db);

  const { data: unidade } = await db.from("unidades")
    .select("id, nome, organizacao_id").eq("id", unidadeId).maybeSingle();
  if (!unidade) throw ApiError.notFound("Unidade não encontrada.");

  // H1 — o vínculo de empresa consultado é o DESTE perfil (inclusive o inicial).
  const { data: vinculoOrg } = await rodarEscopadoPorPerfil(perfilAlvo, (escopo) =>
    escopo(db.from("usuarios_organizacoes")
      .select("id, perfil_id").eq("usuario_id", usuarioId).eq("organizacao_id", unidade.organizacao_id)).maybeSingle());
  if (!vinculoOrg) throw ApiError.badRequest("Associe o usuário à empresa desta unidade primeiro.");

  const perfilId = vinculoOrg.perfil_id ?? perfilAlvo;
  const error = await inserirVinculoUnidadeComPerfil({ usuarioId, perfilId, unidadeId, papel, upsert: true });
  if (error?.codigo) throw ApiError.badRequest(error.message, { codigo: error.codigo });
  if (error) throw ApiError.internal(error.message);

  await registrar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.VINCULO_CRIADO, entidade: "vinculo_unidade", entidadeId: `${usuarioId}:${unidadeId}`,
    organizacaoId: unidade.organizacao_id,
    detalhes: { unidade: unidade.nome, papel }, ...origemDe(req),
  });

  return { usuarioId, unidadeId, papel };
}

/** Remove o vínculo com uma unidade. */
export async function removerVinculoUnidade(req, idBruto, unidadeIdBruto, opts = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const registrar = deps.auditar ?? auditar;
  const revogar = deps.revogar ?? revogarSessoes;
  const usuarioId = v.uuid(idBruto, "Usuário");
  const unidadeId = v.uuid(unidadeIdBruto, "Unidade");
  const perfilAlvo = await resolverPerfilAlvo(usuarioId, opts.perfilId, db);

  // H1 — SEMPRE escopado por perfil_id (o perfil inicial não é exceção).
  const { data: vinculo } = await rodarEscopadoPorPerfil(perfilAlvo, (escopo) =>
    escopo(db.from("usuarios_unidades")
      .select("perfil_id").eq("usuario_id", usuarioId).eq("unidade_id", unidadeId)).maybeSingle());
  const perfilId = vinculo?.perfil_id ?? perfilAlvo;

  const { error } = await rodarEscopadoPorPerfil(perfilAlvo, (escopo) =>
    escopo(db.from("usuarios_unidades")
      .delete().eq("usuario_id", usuarioId).eq("unidade_id", unidadeId)));
  if (error) throw ApiError.internal(error.message);

  // MODEL Y — blast radius mínimo: só as sessões desse perfil PRESAS àquela
  // unidade. Quem tem vínculo de empresa segue acessando as outras unidades.
  const sessoesRevogadas = await revogar({ perfilId, unidadeId, motivo: "vinculo_unidade_removido" });

  await registrar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.VINCULO_REMOVIDO, entidade: "vinculo_unidade", entidadeId: `${usuarioId}:${unidadeId}`,
    detalhes: { sessoesRevogadas }, ...origemDe(req),
  });
  return { usuarioId, unidadeId, removido: true, sessoesRevogadas };
}

/**
 * Edita o vínculo usuário<->UNIDADE: o cargo que SOBREPÕE o da empresa
 * (`papel: null`/vazio volta a herdar) e/ou bloqueia/libera o acesso a essa
 * unidade especificamente — mesmo padrão de `atualizarVinculo`, mas revoga só
 * as sessões PRESAS àquela unidade (não a empresa inteira).
 * @param {import('express').Request} req
 */
export async function atualizarVinculoUnidade(req, idBruto, unidadeIdBruto, body, deps = {}) {
  const db = deps.supabase ?? supabase;
  const registrar = deps.auditar ?? auditar;
  const revogar = deps.revogar ?? revogarSessoes;
  const usuarioId = v.uuid(idBruto, "Usuário");
  const unidadeId = v.uuid(unidadeIdBruto, "Unidade");
  const perfilAlvo = await resolverPerfilAlvo(usuarioId, body.perfilId, db);

  const patch = {};
  if (body.papel !== undefined) patch.papel = body.papel == null || body.papel === "" ? null : v.umDe(body.papel, "Cargo", PAPEIS);
  if (body.ativo !== undefined) patch.ativo = v.booleano(body.ativo, true);
  if (!Object.keys(patch).length) throw ApiError.badRequest("Informe o cargo ou o status do acesso.");

  // H1 — SEMPRE escopado por perfil_id (o perfil inicial também).
  const { data, error } = await rodarEscopadoPorPerfil(perfilAlvo, (escopo) =>
    escopo(db.from("usuarios_unidades")
      .update(patch).eq("usuario_id", usuarioId).eq("unidade_id", unidadeId))
      .select("id, papel, ativo, perfil_id").single());
  if (error || !data) throw ApiError.notFound("Associação não encontrada.");

  // MODEL Y — só as sessões desse perfil presas àquela unidade.
  const sessoesRevogadas = await revogar({
    perfilId: data.perfil_id ?? perfilAlvo, unidadeId,
    motivo: patch.ativo === false ? "acesso_bloqueado" : "papel_alterado",
  });

  await registrar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.VINCULO_EDITADO, entidade: "vinculo_unidade", entidadeId: `${usuarioId}:${unidadeId}`,
    detalhes: { ...patch, sessoesRevogadas }, ...origemDe(req),
  });

  return {
    usuarioId, unidadeId, papel: data.papel,
    papelRotulo: data.papel ? rotuloPapel(data.papel) : "herda da empresa",
    ativo: data.ativo, sessoesRevogadas,
  };
}

/**
 * Concede ou revoga o papel GLOBAL de SuperAdmin da plataforma.
 * Nunca sobre si mesmo — remover o próprio superadmin deixaria a plataforma
 * potencialmente sem nenhum administrador, sem caminho de volta pela UI.
 */
export async function definirSuperadmin(req, idBruto, body) {
  const id = v.uuid(idBruto, "Usuário");
  const conceder = v.booleano(body.superadmin, false);
  if (id === req.user.id) {
    throw ApiError.badRequest("Você não pode alterar o próprio papel de SuperAdmin.");
  }

  const { data: perfil } = await supabase.from("perfis").select("id, email").eq("id", id).maybeSingle();
  if (!perfil) throw ApiError.notFound("Usuário não encontrado.");

  if (conceder) {
    const { error } = await supabase.from("plataforma_admins").upsert({
      usuario_id: id, ativo: true,
      observacao: v.textoOpcional(body.observacao, "Observação", { max: 300 })
        ?? `Concedido por ${req.user.email}.`,
    }, { onConflict: "usuario_id" });
    if (error) throw ApiError.internal(error.message);
  } else {
    const { error } = await supabase.from("plataforma_admins")
      .update({ ativo: false }).eq("usuario_id", id);
    if (error) throw ApiError.internal(error.message);
    await revogarSessoes({ usuarioId: id, motivo: "superadmin_revogado" });
  }

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: "usuario.superadmin_alterado", entidade: "usuario", entidadeId: id,
    detalhes: { email: perfil.email, superadmin: conceder }, ...origemDe(req),
  });

  return { id, superadmin: conceder };
}

// --------------------------------------------------------------------------
// PAINEL ADMINISTRATIVO DA CRESCER — acesso GLOBAL de monitoramento
//
// Espelha `definirSuperadmin`, mas é um poder COMPLETAMENTE separado:
//   - não é SuperAdmin (não concede nada técnico);
//   - não toca `plataforma_admins`, `usuarios_organizacoes`, `usuarios_unidades`,
//     papéis, permissões, nem cria Context Token;
//   - a fonte de verdade é `painel_administrativo_usuarios` (migration 061);
//   - revogar NÃO precisa encerrar sessão: o flag é relido a cada request
//     (requireAuth) — o efeito é imediato, sem `revogarSessoes`.
//
// Quem administra este acesso é SEMPRE o SuperAdmin (a rota vive no
// plataformaRouter, atrás de `requireSuperadmin`). Um usuário que só tem o
// Painel Administrativo NÃO pode conceder/revogar — monitorar operações e
// administrar quem entra no painel são responsabilidades distintas.
// --------------------------------------------------------------------------

/**
 * Decide, de forma PURA, o que fazer com o acesso ao Painel Administrativo a
 * partir do estado atual e da intenção. Sem I/O — testável isoladamente.
 *
 * Regra de idempotência (item 14 do pedido): sem mudança REAL de estado, não
 * escreve nem audita.
 *
 * @param {{registroAtual: {ativo?: boolean}|null, conceder: boolean}} p
 * @returns {{alterado: boolean, operacao: 'nenhuma'|'inserir'|'reativar'|'revogar', estadoAnterior: boolean, estadoNovo: boolean}}
 */
export function planejarMudancaPainelAdministrativo({ registroAtual, conceder }) {
  const tinhaAcesso = registroAtual?.ativo === true;
  if (conceder === tinhaAcesso) {
    return { alterado: false, operacao: "nenhuma", estadoAnterior: tinhaAcesso, estadoNovo: tinhaAcesso };
  }
  const operacao = conceder ? (registroAtual ? "reativar" : "inserir") : "revogar";
  return { alterado: true, operacao, estadoAnterior: tinhaAcesso, estadoNovo: conceder };
}

/**
 * Concede ou revoga o acesso GLOBAL ao Painel Administrativo.
 * @param {import('express').Request} req
 * @param {string} idBruto
 * @param {{conceder?: unknown, observacao?: unknown}} body
 * @param {{db?: typeof supabase, registrar?: typeof auditar}} [deps] injeção para teste.
 */
export async function definirPainelAdministrativo(req, idBruto, body, deps = {}) {
  const db = deps.db ?? supabase;
  const registrar = deps.registrar ?? auditar;

  const id = v.uuid(idBruto, "Usuário");
  const conceder = v.booleano(body.conceder, false);
  const observacao = v.textoOpcional(body.observacao, "Observação", { max: 300 });

  const { data: perfil } = await db.from("perfis").select("id, nome, email").eq("id", id).maybeSingle();
  if (!perfil) throw ApiError.notFound("Usuário não encontrado.");

  const { data: registroAtual } = await db.from("painel_administrativo_usuarios")
    .select("usuario_id, ativo, observacao").eq("usuario_id", id).maybeSingle();

  const plano = planejarMudancaPainelAdministrativo({ registroAtual, conceder });

  if (!plano.alterado) {
    return { id, painelAdministrativo: plano.estadoNovo, alterado: false };
  }

  if (conceder) {
    // `criado_por` acompanha quem concedeu (inclusive numa reativação — é o
    // dado relevante da concessão vigente). `created_at` fica com o insert
    // original (o `upsert` não o reescreve); `updated_at` sobe pelo trigger.
    const { error } = await db.from("painel_administrativo_usuarios").upsert({
      usuario_id: id,
      ativo: true,
      criado_por: req.user.id,
      observacao: observacao ?? registroAtual?.observacao ?? `Concedido por ${req.user.email}.`,
    }, { onConflict: "usuario_id" });
    if (error) throw ApiError.internal(error.message);
  } else {
    const { error } = await db.from("painel_administrativo_usuarios")
      .update({ ativo: false, observacao: observacao ?? registroAtual?.observacao ?? null })
      .eq("usuario_id", id);
    if (error) throw ApiError.internal(error.message);
    // Sem revogarSessoes: o Painel Administrativo não tem sessoes_contexto.
    // O próximo request já lê `ativo=false` em requireAuth -> acesso cortado.
  }

  await registrar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: conceder ? ACOES.PAINEL_ADM_CONCEDIDO : ACOES.PAINEL_ADM_REVOGADO,
    entidade: "usuario", entidadeId: id,
    detalhes: {
      email: perfil.email, nome: perfil.nome,
      operacao: plano.operacao,
      estadoAnterior: plano.estadoAnterior ? "com_acesso" : "sem_acesso",
      estadoNovo: plano.estadoNovo ? "com_acesso" : "sem_acesso",
      observacao: observacao ?? null,
    },
    ...origemDe(req),
  });

  return { id, painelAdministrativo: conceder, alterado: true };
}

/**
 * Lista as contas que têm (ou já tiveram) acesso ao Painel Administrativo.
 * Somente leitura, para a tela do SuperAdmin.
 * @param {{status?: 'ativos'|'revogados'|'todos'}} [filtros]  padrão: só ativos.
 * @param {{db?: typeof supabase}} [deps]
 */
export async function listarUsuariosPainelAdministrativo(filtros = {}, deps = {}) {
  const db = deps.db ?? supabase;
  const status = ["ativos", "revogados", "todos"].includes(filtros.status) ? filtros.status : "ativos";

  let q = db.from("painel_administrativo_usuarios")
    .select("usuario_id, ativo, observacao, created_at, updated_at")
    .order("created_at", { ascending: true });
  if (status === "ativos") q = q.eq("ativo", true);
  else if (status === "revogados") q = q.eq("ativo", false);

  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);
  const registros = data ?? [];
  if (!registros.length) return { status, usuarios: [], total: 0 };

  const ids = [...new Set(registros.map((r) => r.usuario_id))];
  const { data: perfis } = await db.from("perfis").select("id, nome, email, ativo").in("id", ids);
  const porId = new Map((perfis ?? []).map((p) => [p.id, p]));

  const usuarios = registros.map((r) => {
    const p = porId.get(r.usuario_id);
    return {
      id: r.usuario_id,
      nome: p?.nome ?? "—",
      email: p?.email ?? "—",
      contaAtiva: p?.ativo ?? null,        // a conta em si (login) está ativa?
      acessoAtivo: r.ativo === true,       // o acesso ao painel está ativo?
      observacao: r.observacao ?? null,
      concedidoEm: r.created_at,
      atualizadoEm: r.updated_at,
    };
  });
  return { status, usuarios, total: usuarios.length };
}

// --------------------------------------------------------------------------

/**
 * Valida a lista de empresas enviada na criação do usuário.
 * @param {unknown} entrada
 * @returns {Array<{organizacaoId: string, papel: string}>}
 */
function normalizarEmpresas(entrada) {
  if (entrada == null) return [];
  if (!Array.isArray(entrada)) throw ApiError.badRequest("`empresas` deve ser uma lista.");
  if (entrada.length > 100) throw ApiError.badRequest("Máximo de 100 empresas por usuário.");
  return entrada.map((item, i) => {
    if (!item || typeof item !== "object") throw ApiError.badRequest(`Empresa ${i + 1} inválida.`);
    const organizacaoId = v.uuid(item.organizacaoId, `Empresa ${i + 1}`);
    const papel = String(item.papel ?? "");
    if (!papelValido(papel)) throw ApiError.badRequest(`Cargo inválido na empresa ${i + 1}.`);
    return { organizacaoId, papel };
  });
}

/**
 * Dados da conta no Supabase Auth (e-mail de login, último acesso).
 * Devolve null em qualquer falha: é informação complementar, e não vale
 * derrubar a tela de detalhe do usuário por causa dela.
 * @param {string} usuarioId
 */
async function buscarNoAuth(usuarioId, cliente = supabase) {
  try {
    const { data, error } = await cliente.auth.admin.getUserById(usuarioId);
    if (error) return null;
    return data?.user ?? null;
  } catch {
    return null;
  }
}

/**
 * Encerra as sessões do usuário no Supabase Auth (revoga os refresh tokens).
 *
 * Por que via fetch e não pelo SDK: `supabase.auth.admin.signOut(jwt, scope)`
 * espera o JWT DO PRÓPRIO usuário — serve para o usuário se deslogar, não para
 * um administrador deslogar outra pessoa. O endpoint administrativo do GoTrue
 * (`POST /auth/v1/admin/users/:id/logout`) faz exatamente isso, e o SDK não o
 * expõe. Chamá-lo direto com a service_role key é o caminho suportado.
 *
 * Falha aqui NÃO derruba o "forçar logout": as sessões de contexto já foram
 * revogadas, o que é o que impede o acesso aos dados. O retorno diz se a parte
 * do Auth também foi, para o painel ser honesto sobre o alcance da ação.
 * @param {string} usuarioId
 * @returns {Promise<boolean>}
 */
async function encerrarSessoesAuth(usuarioId) {
  try {
    const url = `${config.supabaseUrl.replace(/\/$/, "")}/auth/v1/admin/users/${usuarioId}/logout`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        apikey: config.supabaseServiceKey,
        Authorization: `Bearer ${config.supabaseServiceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scope: "global" }),
    });
    if (!r.ok) {
      console.error("[plataforma] logout no Auth falhou:", r.status, await r.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (e) {
    console.error("[plataforma] logout no Auth falhou:", e?.message);
    return false;
  }
}

/** Traduz os erros do Supabase Auth para mensagens que o admin entenda. */
function traduzErroAuth(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("already been registered") || m.includes("already exists") || m.includes("duplicate"))
    return "Já existe um usuário com este e-mail.";
  if (m.includes("password")) return "Senha inválida (mínimo de 8 caracteres).";
  if (m.includes("invalid email") || m.includes("email_address_invalid")) return "E-mail inválido.";
  if (m.includes("not found")) return "Usuário não encontrado no provedor de autenticação.";
  return msg || "Falha na operação.";
}

/** Permissões de um papel — o painel usa para mostrar o que cada cargo pode. */
export function detalharPapeis() {
  return PAPEIS.map((p) => ({ valor: p, rotulo: rotuloPapel(p), permissoes: permissoesDoPapel(p) }));
}

/** @param {import('express').Request} req */
function origemDe(req) {
  const encaminhado = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(encaminhado) ? encaminhado[0] : encaminhado)?.split(",")[0]?.trim()
    || req.socket?.remoteAddress || null;
  return { ip, userAgent: req.header("user-agent") || null };
}
