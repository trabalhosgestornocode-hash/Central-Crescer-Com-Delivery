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

/** @param {{busca?: string, limite?: unknown, semEmpresa?: boolean}} filtros */
export async function listarUsuarios({ busca, limite, semEmpresa = false } = {}) {
  let q = supabase.from("perfis")
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
  const [vinculos, admins, sessoes] = await Promise.all([
    buscar("usuarios_organizacoes", "usuario_id, organizacao_id, papel, ativo, organizacoes(id, nome)",
      (qq) => qq.in("usuario_id", ids)),
    buscar("plataforma_admins", "usuario_id", (qq) => qq.in("usuario_id", ids).eq("ativo", true)),
    buscar("sessoes_contexto", "usuario_id",
      (qq) => qq.in("usuario_id", ids).is("revogada_em", null).gte("ultimo_uso_em", desdeOnline)),
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
  const online = new Set(sessoes.map((s) => s.usuario_id));

  const lista = usuarios.map((u) => ({
    id: u.id, nome: u.nome, email: u.email, ativo: u.ativo, criadoEm: u.created_at,
    superadmin: superadmins.has(u.id),
    online: online.has(u.id),
    empresas: porUsuario.get(u.id) ?? [],
  }));

  // "Sem empresa" é a fila de trabalho depois da virada da migration 020:
  // são as contas que existem e ainda precisam ser associadas.
  return semEmpresa ? lista.filter((u) => !u.empresas.some((e) => e.ativo)) : lista;
}

export async function obterUsuario(idBruto) {
  const id = v.uuid(idBruto, "Usuário");
  const { data: perfil, error } = await supabase.from("perfis")
    .select("id, nome, email, ativo, created_at").eq("id", id).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!perfil) throw ApiError.notFound("Usuário não encontrado.");

  const [vinculos, vinculosUnidade, admin, sessoes, historico] = await Promise.all([
    buscar("usuarios_organizacoes", "id, organizacao_id, papel, ativo, created_at, organizacoes(id, nome, status)",
      (q) => q.eq("usuario_id", id)),
    buscar("usuarios_unidades", "id, unidade_id, papel, ativo, unidades(id, nome, organizacao_id)",
      (q) => q.eq("usuario_id", id)),
    supabase.from("plataforma_admins").select("usuario_id, observacao")
      .eq("usuario_id", id).eq("ativo", true).maybeSingle().then((r) => r.data),
    buscar("sessoes_contexto", "id, organizacao_id, papel, criada_em, ultimo_uso_em, revogada_em, ip, organizacoes(nome)",
      (q) => q.eq("usuario_id", id).order("criada_em", { ascending: false }).limit(20)),
    buscar("plataforma_auditoria", "id, acao, entidade, organizacao_id, detalhes, ip, created_at",
      (q) => q.eq("ator_id", id).order("created_at", { ascending: false }).limit(50)),
  ]);

  // E-mail de LOGIN, direto do Auth. `perfis.email` é cópia para exibição e sai
  // de sincronia (trocar o login não atualiza `perfis`) — num painel de gestão
  // de acesso, mostrar o e-mail errado faz o operador tentar logar com um
  // endereço que não existe. Quando divergem, os dois aparecem.
  const authUser = await buscarNoAuth(id);
  const emailLogin = authUser?.email ?? null;

  return {
    id: perfil.id, nome: perfil.nome, email: perfil.email, ativo: perfil.ativo, criadoEm: perfil.created_at,
    emailLogin,
    emailDivergente: !!emailLogin && (perfil.email ?? "").toLowerCase() !== emailLogin.toLowerCase(),
    ultimoLogin: authUser?.last_sign_in_at ?? null,
    superadmin: !!admin,
    observacaoSuperadmin: admin?.observacao ?? null,
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
    sessoes: sessoes.map((s) => ({
      id: s.id, empresa: s.organizacoes?.nome ?? null, papel: s.papel,
      criadaEm: s.criada_em, ultimoUso: s.ultimo_uso_em, revogadaEm: s.revogada_em, ip: s.ip,
      viva: !s.revogada_em,
    })),
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

  const vinculados = [];
  for (const emp of empresas) {
    const { error } = await supabase.from("usuarios_organizacoes").insert({
      usuario_id: usuarioId, organizacao_id: emp.organizacaoId, papel: emp.papel, ativo: true,
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

/** @param {import('express').Request} req */
export async function forcarLogout(req, idBruto) {
  const id = v.uuid(idBruto, "Usuário");
  const sessoesRevogadas = await revogarSessoes({ usuarioId: id, motivo: "logout_forcado" });

  // Revogar as sessões do Auth também. Sem isso o usuário continuaria
  // autenticado (só sem contexto) e escolheria a empresa novamente.
  const authEncerrado = await encerrarSessoesAuth(id);

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.USUARIO_LOGOUT_FORCADO, entidade: "usuario", entidadeId: id,
    detalhes: { sessoesRevogadas, authEncerrado }, ...origemDe(req),
  });
  return { id, sessoesRevogadas, authEncerrado };
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

  const { error } = await supabase.from("usuarios_organizacoes")
    .upsert({ usuario_id: usuarioId, organizacao_id: organizacaoId, papel, ativo: true },
            { onConflict: "usuario_id,organizacao_id" });
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

  const linhas = itens.map((i) => ({
    usuario_id: usuarioId, organizacao_id: i.organizacaoId, papel: i.papel, ativo: true,
  }));
  const { error } = await db.from("usuarios_organizacoes").insert(linhas);
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
export async function atualizarVinculo(req, idBruto, organizacaoIdBruto, body) {
  const usuarioId = v.uuid(idBruto, "Usuário");
  const organizacaoId = v.uuid(organizacaoIdBruto, "Empresa");

  const patch = {};
  if (body.papel !== undefined) patch.papel = v.umDe(body.papel, "Cargo", PAPEIS);
  if (body.ativo !== undefined) patch.ativo = v.booleano(body.ativo, true);
  if (!Object.keys(patch).length) throw ApiError.badRequest("Informe o cargo ou o status do acesso.");

  const { data, error } = await supabase.from("usuarios_organizacoes")
    .update(patch).eq("usuario_id", usuarioId).eq("organizacao_id", organizacaoId)
    .select("id, papel, ativo").single();
  if (error || !data) throw ApiError.notFound("Associação não encontrada.");

  const sessoesRevogadas = await revogarSessoes({
    usuarioId, organizacaoId, motivo: patch.ativo === false ? "acesso_bloqueado" : "papel_alterado",
  });

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.VINCULO_EDITADO, entidade: "vinculo", entidadeId: `${usuarioId}:${organizacaoId}`,
    organizacaoId, detalhes: { ...patch, sessoesRevogadas }, ...origemDe(req),
  });

  return { usuarioId, organizacaoId, papel: data.papel, papelRotulo: rotuloPapel(data.papel), ativo: data.ativo, sessoesRevogadas };
}

/** Remove a associação (e os vínculos de unidade daquela empresa). */
export async function removerVinculo(req, idBruto, organizacaoIdBruto) {
  const usuarioId = v.uuid(idBruto, "Usuário");
  const organizacaoId = v.uuid(organizacaoIdBruto, "Empresa");

  const { error } = await supabase.from("usuarios_organizacoes")
    .delete().eq("usuario_id", usuarioId).eq("organizacao_id", organizacaoId);
  if (error) throw ApiError.internal(error.message);

  // Vínculos de unidade da mesma empresa perderiam sentido — e sobrariam como
  // acesso residual, já que a unidade sozinha também autoriza a seleção.
  const unidades = await buscar("unidades", "id", (q) => q.eq("organizacao_id", organizacaoId));
  if (unidades.length) {
    await supabase.from("usuarios_unidades").delete()
      .eq("usuario_id", usuarioId).in("unidade_id", unidades.map((u) => u.id));
  }

  const sessoesRevogadas = await revogarSessoes({ usuarioId, organizacaoId, motivo: "vinculo_removido" });

  await auditar({
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
export async function associarUnidade(req, idBruto, body) {
  const usuarioId = v.uuid(idBruto, "Usuário");
  const unidadeId = v.uuid(body.unidadeId, "Unidade");
  const papel = body.papel == null || body.papel === "" ? null : v.umDe(body.papel, "Cargo", PAPEIS);

  const { data: unidade } = await supabase.from("unidades")
    .select("id, nome, organizacao_id").eq("id", unidadeId).maybeSingle();
  if (!unidade) throw ApiError.notFound("Unidade não encontrada.");

  const { data: vinculoOrg } = await supabase.from("usuarios_organizacoes")
    .select("id").eq("usuario_id", usuarioId).eq("organizacao_id", unidade.organizacao_id).maybeSingle();
  if (!vinculoOrg) throw ApiError.badRequest("Associe o usuário à empresa desta unidade primeiro.");

  const { error } = await supabase.from("usuarios_unidades")
    .upsert({ usuario_id: usuarioId, unidade_id: unidadeId, papel, ativo: true },
            { onConflict: "usuario_id,unidade_id" });
  if (error) throw ApiError.internal(error.message);

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.VINCULO_CRIADO, entidade: "vinculo_unidade", entidadeId: `${usuarioId}:${unidadeId}`,
    organizacaoId: unidade.organizacao_id,
    detalhes: { unidade: unidade.nome, papel }, ...origemDe(req),
  });

  return { usuarioId, unidadeId, papel };
}

/** Remove o vínculo com uma unidade. */
export async function removerVinculoUnidade(req, idBruto, unidadeIdBruto) {
  const usuarioId = v.uuid(idBruto, "Usuário");
  const unidadeId = v.uuid(unidadeIdBruto, "Unidade");

  const { error } = await supabase.from("usuarios_unidades")
    .delete().eq("usuario_id", usuarioId).eq("unidade_id", unidadeId);
  if (error) throw ApiError.internal(error.message);

  await auditar({
    atorId: req.user.id, atorEmail: req.user.email, atorTipo: "superadmin",
    acao: ACOES.VINCULO_REMOVIDO, entidade: "vinculo_unidade", entidadeId: `${usuarioId}:${unidadeId}`,
    ...origemDe(req),
  });
  return { usuarioId, unidadeId, removido: true };
}

/**
 * Edita o vínculo usuário<->UNIDADE: o cargo que SOBREPÕE o da empresa
 * (`papel: null`/vazio volta a herdar) e/ou bloqueia/libera o acesso a essa
 * unidade especificamente — mesmo padrão de `atualizarVinculo`, mas revoga só
 * as sessões PRESAS àquela unidade (não a empresa inteira).
 * @param {import('express').Request} req
 */
export async function atualizarVinculoUnidade(req, idBruto, unidadeIdBruto, body) {
  const usuarioId = v.uuid(idBruto, "Usuário");
  const unidadeId = v.uuid(unidadeIdBruto, "Unidade");

  const patch = {};
  if (body.papel !== undefined) patch.papel = body.papel == null || body.papel === "" ? null : v.umDe(body.papel, "Cargo", PAPEIS);
  if (body.ativo !== undefined) patch.ativo = v.booleano(body.ativo, true);
  if (!Object.keys(patch).length) throw ApiError.badRequest("Informe o cargo ou o status do acesso.");

  const { data, error } = await supabase.from("usuarios_unidades")
    .update(patch).eq("usuario_id", usuarioId).eq("unidade_id", unidadeId)
    .select("id, papel, ativo").single();
  if (error || !data) throw ApiError.notFound("Associação não encontrada.");

  const sessoesRevogadas = await revogarSessoes({
    usuarioId, unidadeId, motivo: patch.ativo === false ? "acesso_bloqueado" : "papel_alterado",
  });

  await auditar({
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
async function buscarNoAuth(usuarioId) {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(usuarioId);
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
