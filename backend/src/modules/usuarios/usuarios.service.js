// Usuários DENTRO de uma empresa (visão do administrador do tenant).
//
// MUDANÇA DE MODELO: antes, um usuário era uma linha de `perfis` presa a uma
// organização, e "excluir usuário" apagava a conta do Auth. Agora a conta é
// global e pode pertencer a várias empresas, então o que este módulo administra
// é o VÍNCULO — quem tem acesso a ESTA empresa e com qual cargo.
//
// Consequência importante, e desejada: "remover" aqui revoga o acesso a esta
// empresa e NÃO apaga a conta. Apagar a conta de alguém que também trabalha na
// Subway Fortaleza, a partir do painel da Subway Saci, seria um administrador
// de um tenant destruindo dado de outro. Exclusão definitiva de conta é
// exclusividade do SuperAdmin.
//
// O escopo (`organizacaoId`) vem sempre de `req.tenant`, que por sua vez vem do
// Context Token — nunca do corpo da requisição.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { PAPEIS_VINCULO, rotuloPapel } from "../../shared/permissoes.js";
import { revogarSessoes } from "../sessao/sessao.service.js";
import * as v from "../../shared/validar.js";

/**
 * @typedef {object} UsuarioDaEmpresa
 * @property {string} id
 * @property {string|null} nome
 * @property {string|null} email
 * @property {string} papel
 * @property {string} papelRotulo
 * @property {boolean} ativo      acesso a ESTA empresa
 * @property {boolean} contaAtiva conta global habilitada
 * @property {string} desde
 */

/**
 * Usuários com acesso a esta empresa — pelo vínculo de EMPRESA
 * (`usuarios_organizacoes`) OU direto por uma UNIDADE dela
 * (`usuarios_unidades`). Um usuário com os dois vínculos aparece UMA vez.
 *
 * `papel` = o cargo NA EMPRESA (vínculo de organização). Quando o acesso é
 * só por unidade, `papel` é null e `origem` diz "unidade" — o cargo real
 * naquele caso é o de cada unidade em `unidades[]` (papel null ali = herda).
 *
 * @param {{organizacaoId: string}} params
 * @param {{supabase?: any}} [deps]
 * @returns {Promise<UsuarioDaEmpresa[]>}
 */
export async function listarUsuarios({ organizacaoId }, deps = {}) {
  const db = deps.supabase ?? supabase;

  const [{ data: vinculosOrg, error: eOrg }, { data: unidades, error: eUn }] = await Promise.all([
    db.from("usuarios_organizacoes")
      .select("usuario_id, papel, ativo, created_at")
      .eq("organizacao_id", organizacaoId)
      .order("created_at", { ascending: true }),
    db.from("unidades").select("id, nome").eq("organizacao_id", organizacaoId),
  ]);
  if (eOrg) throw ApiError.internal(eOrg.message);
  if (eUn) throw ApiError.internal(eUn.message);

  const unidadePorId = new Map((unidades ?? []).map((u) => [u.id, u.nome]));

  let vinculosUni = [];
  if (unidadePorId.size) {
    const { data, error } = await db.from("usuarios_unidades")
      .select("usuario_id, unidade_id, papel, ativo, created_at")
      .in("unidade_id", [...unidadePorId.keys()]);
    if (error) throw ApiError.internal(error.message);
    vinculosUni = data ?? [];
  }

  const idsUsuarios = [...new Set([
    ...(vinculosOrg ?? []).map((x) => x.usuario_id),
    ...vinculosUni.map((x) => x.usuario_id),
  ])];
  if (!idsUsuarios.length) return [];

  const { data: perfis } = await db.from("perfis")
    .select("id, nome, email, ativo").in("id", idsUsuarios);
  const perfilPorId = new Map((perfis ?? []).map((p) => [p.id, p]));

  const orgPorUsuario = new Map((vinculosOrg ?? []).map((x) => [x.usuario_id, x]));
  const uniPorUsuario = new Map();
  for (const x of vinculosUni) {
    if (!uniPorUsuario.has(x.usuario_id)) uniPorUsuario.set(x.usuario_id, []);
    uniPorUsuario.get(x.usuario_id).push(x);
  }

  return idsUsuarios.map((uid) => {
    const org = orgPorUsuario.get(uid) ?? null;
    const unis = (uniPorUsuario.get(uid) ?? []).map((u) => ({
      unidadeId: u.unidade_id,
      unidadeNome: unidadePorId.get(u.unidade_id) ?? "—",
      papel: u.papel,                                   // null = herda o da empresa
      papelRotulo: u.papel ? rotuloPapel(u.papel) : "herda da empresa",
      ativo: u.ativo,
    }));
    const perfil = perfilPorId.get(uid);
    const origem = org && unis.length ? "empresa+unidade" : org ? "empresa" : "unidade";

    return {
      id: uid,
      nome: perfil?.nome ?? null,
      email: perfil?.email ?? null,
      papel: org?.papel ?? null,
      papelRotulo: org ? rotuloPapel(org.papel) : (unis.length === 1 ? unis[0].papelRotulo : "acesso por unidade"),
      ativo: org ? org.ativo : unis.some((u) => u.ativo),
      contaAtiva: perfil?.ativo ?? true,
      desde: org?.created_at
        ?? (uniPorUsuario.get(uid) ?? []).map((u) => u.created_at).sort()[0]
        ?? null,
      origem,                         // "empresa" | "unidade" | "empresa+unidade"
      gerenciavelAqui: !!org,         // o <select> de cargo desta tela só mexe em vínculo de EMPRESA
      unidades: unis,
    };
  });
}

/**
 * Cria a conta e a vincula a ESTA empresa. Se o e-mail já tiver conta na
 * plataforma, apenas concede o acesso — é o caso comum de um funcionário que
 * já trabalha em outra unidade do grupo, e criar uma segunda conta para ele
 * seria justamente o problema que o modelo novo resolve.
 *
 * @param {object} params
 * @param {string} params.organizacaoId
 * @param {unknown} params.nome
 * @param {unknown} params.email
 * @param {unknown} params.senha
 * @param {unknown} params.papel
 */
export async function criarUsuario({ organizacaoId, nome, email, senha, papel }) {
  const emailNorm = v.email(email);
  const nomeNorm = v.textoOpcional(nome, "Nome", { max: 160 }) ?? emailNorm.split("@")[0];
  const papelNorm = v.umDe(papel, "Cargo", PAPEIS_VINCULO);

  // Já existe conta com este e-mail? Então é concessão de acesso, não criação.
  const existente = await acharContaPorEmail(emailNorm);

  if (existente) {
    const { data: vinculo } = await supabase.from("usuarios_organizacoes")
      .select("id, ativo").eq("usuario_id", existente.id).eq("organizacao_id", organizacaoId).maybeSingle();
    if (vinculo?.ativo) throw ApiError.badRequest("Este usuário já tem acesso a esta empresa.");

    const { error } = await supabase.from("usuarios_organizacoes").upsert(
      { usuario_id: existente.id, organizacao_id: organizacaoId, papel: papelNorm, ativo: true },
      { onConflict: "usuario_id,organizacao_id" });
    if (error) throw ApiError.internal(error.message);

    return {
      id: existente.id, nome: existente.nome, email: existente.email,
      papel: papelNorm, papelRotulo: rotuloPapel(papelNorm), ativo: true,
      contaAtiva: existente.ativo,
      // A senha informada é ignorada de propósito: um admin de tenant não pode
      // trocar a senha de uma conta que também acessa outras empresas.
      aviso: "Usuário já existia na plataforma — o acesso a esta empresa foi concedido e a senha atual foi mantida.",
    };
  }

  const senhaNorm = v.senha(senha);
  const { data: criado, error: e1 } = await supabase.auth.admin.createUser({
    email: emailNorm, password: senhaNorm, email_confirm: true, user_metadata: { nome: nomeNorm },
  });
  if (e1 || !criado?.user) throw ApiError.badRequest(traduz(e1?.message));
  const uid = criado.user.id;

  // `perfis` é identidade: sem organizacao_id, que agora é legado.
  const { error: e2 } = await supabase.from("perfis").insert({
    id: uid, nome: nomeNorm, email: emailNorm, ativo: true, organizacao_id: null, unidade_id: null,
  });
  if (e2) {
    await supabase.auth.admin.deleteUser(uid).catch(() => {});
    throw ApiError.badRequest(traduz(e2.message));
  }

  const { error: e3 } = await supabase.from("usuarios_organizacoes")
    .insert({ usuario_id: uid, organizacao_id: organizacaoId, papel: papelNorm, ativo: true });
  if (e3) {
    // Sem vínculo a conta nasce inútil — desfaz tudo em vez de deixar sobra.
    await supabase.auth.admin.deleteUser(uid).catch(() => {});
    throw ApiError.internal("Usuário criado, mas o acesso à empresa falhou. Nada foi mantido.");
  }

  return {
    id: uid, nome: nomeNorm, email: emailNorm,
    papel: papelNorm, papelRotulo: rotuloPapel(papelNorm), ativo: true, contaAtiva: true,
  };
}

/**
 * Altera cargo e/ou acesso do usuário NESTA empresa.
 * As sessões daquele usuário nesta empresa são revogadas: as permissões ficam
 * gravadas na sessão, então sem revogar a mudança só valeria no próximo login.
 *
 * @param {object} params
 * @param {string} params.organizacaoId
 * @param {string} params.id
 * @param {unknown} [params.papel]
 * @param {unknown} [params.ativo]
 * @param {string} params.solicitanteId
 */
export async function atualizarUsuario({ organizacaoId, id, papel, ativo, solicitanteId }) {
  const usuarioId = v.uuid(id, "Usuário");
  const patch = {};
  if (papel !== undefined) patch.papel = v.umDe(papel, "Cargo", PAPEIS_VINCULO);
  if (ativo !== undefined) patch.ativo = v.booleano(ativo, true);
  if (!Object.keys(patch).length) throw ApiError.badRequest("Informe o cargo ou o status do acesso.");

  // Impedir o auto-rebaixamento evita o cenário em que o único administrador da
  // empresa se torna 'viewer' e ninguém mais consegue gerenciar usuários.
  if (usuarioId === solicitanteId) {
    throw ApiError.badRequest("Você não pode alterar o próprio acesso. Peça a outro administrador.");
  }

  const { data, error } = await supabase.from("usuarios_organizacoes")
    .update(patch)
    .eq("usuario_id", usuarioId).eq("organizacao_id", organizacaoId)
    .select("papel, ativo").single();
  if (error || !data) throw ApiError.notFound("Usuário não encontrado nesta empresa.");

  const sessoesRevogadas = await revogarSessoes({
    usuarioId, organizacaoId,
    motivo: patch.ativo === false ? "acesso_bloqueado" : "papel_alterado",
  });

  return {
    id: usuarioId, papel: data.papel, papelRotulo: rotuloPapel(data.papel),
    ativo: data.ativo, sessoesRevogadas,
  };
}

/**
 * Remove o ACESSO do usuário a esta empresa. A conta continua existindo — veja
 * a nota no topo do arquivo sobre por que não apagamos a conta aqui.
 *
 * @param {object} params
 * @param {string} params.organizacaoId
 * @param {string} params.id
 * @param {string} params.solicitanteId
 */
export async function excluirUsuario({ organizacaoId, id, solicitanteId }) {
  const usuarioId = v.uuid(id, "Usuário");
  if (usuarioId === solicitanteId) {
    throw ApiError.badRequest("Você não pode remover o próprio acesso.");
  }

  const { data: vinculo } = await supabase.from("usuarios_organizacoes")
    .select("id").eq("usuario_id", usuarioId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (!vinculo) throw ApiError.notFound("Usuário não encontrado nesta empresa.");

  // Último administrador não sai: a empresa ficaria sem quem gerencia acessos,
  // e a saída seria depender do SuperAdmin para uma operação de rotina.
  const { data: admins } = await supabase.from("usuarios_organizacoes")
    .select("usuario_id").eq("organizacao_id", organizacaoId)
    .eq("papel", "organization_admin").eq("ativo", true);
  if ((admins ?? []).length === 1 && admins[0].usuario_id === usuarioId) {
    throw ApiError.badRequest("Este é o único administrador da empresa. Promova outro antes de removê-lo.");
  }

  const { error } = await supabase.from("usuarios_organizacoes")
    .delete().eq("usuario_id", usuarioId).eq("organizacao_id", organizacaoId);
  if (error) throw ApiError.internal(error.message);

  // Vínculos de unidade desta empresa também saem — sozinhos, eles ainda
  // autorizariam a seleção de contexto.
  const { data: unidades } = await supabase.from("unidades")
    .select("id").eq("organizacao_id", organizacaoId);
  if (unidades?.length) {
    await supabase.from("usuarios_unidades").delete()
      .eq("usuario_id", usuarioId).in("unidade_id", unidades.map((u) => u.id));
  }

  const sessoesRevogadas = await revogarSessoes({ usuarioId, organizacaoId, motivo: "acesso_removido" });
  return { id: usuarioId, acessoRemovido: true, contaPreservada: true, sessoesRevogadas };
}

/**
 * Acha a conta pelo e-mail olhando os DOIS lugares onde ele mora.
 *
 * `perfis.email` é uma cópia para exibição e sai de sincronia com facilidade:
 * trocar o login no Supabase Auth não atualiza `perfis`. Este banco já tem um
 * caso assim. Se procurássemos só em `perfis`, digitar o e-mail de login de
 * alguém que já existe cairia no caminho de CRIAÇÃO e morreria em "já existe um
 * usuário com este e-mail" — quando a intenção correta era conceder acesso.
 *
 * @param {string} emailNorm e-mail já normalizado em minúsculas
 * @returns {Promise<{id: string, nome: string|null, email: string|null, ativo: boolean}|null>}
 */
async function acharContaPorEmail(emailNorm) {
  const { data: porPerfil } = await supabase
    .from("perfis").select("id, nome, email, ativo").eq("email", emailNorm).maybeSingle();
  if (porPerfil) return porPerfil;

  // Não achou pelo e-mail de exibição: procura pelo e-mail de LOGIN.
  const usuarioAuth = await acharNoAuthPorEmail(emailNorm);
  if (!usuarioAuth) return null;

  // Achou no Auth — traz o perfil pelo id (a identidade real).
  const { data: perfil } = await supabase
    .from("perfis").select("id, nome, email, ativo").eq("id", usuarioAuth.id).maybeSingle();
  return perfil ?? {
    // Conta existe no Auth sem linha em `perfis`. Raro, mas possível; devolve o
    // mínimo para o fluxo de concessão de acesso funcionar.
    id: usuarioAuth.id, nome: usuarioAuth.user_metadata?.nome ?? null,
    email: usuarioAuth.email ?? emailNorm, ativo: true,
  };
}

/**
 * Procura um usuário no Supabase Auth por e-mail.
 *
 * O SDK não expõe busca por e-mail — só `listUsers` paginado. Paginamos com
 * teto para não transformar isso em varredura ilimitada num projeto grande;
 * se passar do teto, devolve null e o fluxo cai na criação, que ainda barra
 * duplicata com a mensagem do Auth.
 * @param {string} emailNorm
 */
async function acharNoAuthPorEmail(emailNorm) {
  const PAGINAS_MAX = 10, POR_PAGINA = 200;
  for (let pagina = 1; pagina <= PAGINAS_MAX; pagina++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page: pagina, perPage: POR_PAGINA });
    if (error) return null;
    const usuarios = data?.users ?? [];
    const achado = usuarios.find((u) => (u.email ?? "").toLowerCase() === emailNorm);
    if (achado) return achado;
    if (usuarios.length < POR_PAGINA) return null;   // última página
  }
  return null;
}

/** Cargos atribuíveis — o frontend usa para montar o seletor. */
export function papeisDisponiveis() {
  return PAPEIS_VINCULO.map((p) => ({ valor: p, rotulo: rotuloPapel(p) }));
}

function traduz(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("already been registered") || m.includes("already exists") || m.includes("duplicate"))
    return "Já existe um usuário com este e-mail.";
  if (m.includes("password")) return "Senha inválida (mínimo de 8 caracteres).";
  if (m.includes("invalid email")) return "E-mail inválido.";
  return msg || "Falha na operação.";
}
