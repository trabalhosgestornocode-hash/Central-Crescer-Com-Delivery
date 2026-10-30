// D-14 — convite de usuário por E-MAIL (substitui a senha definida pelo administrador).
//
//   * Conta que JÁ existe na plataforma: recebe só o vínculo com a empresa, como antes (nenhuma senha passa por aqui).
//   * Conta nova: cria um CONVITE — token de 32 bytes, só o SHA-256 no banco, 72 h, uso único (usuarios_convite_consumir),
//     e-mail guardado como HMAC + cifrado. O convidado aceita JÁ AUTENTICADO com o mesmo e-mail; só então o vínculo nasce.
//   * Envio do e-mail: DESLIGADO por padrão (USUARIOS_CONVITE_EMAIL ≠ "supabase"). Desligado, NENHUM convite é criado (não existe
//     convite que ninguém consegue ativar): a conta nova é recusada com 409 e a tela orienta usar o Painel SuperAdmin. Ligado, usa o
//     convite do Supabase Auth (SMTP próprio, template e redirect — DEP-2) com link montado só da origem CONFIÁVEL (APP_URL_PUBLICA);
//     se o e-mail falhar, o convite é cancelado na hora. Nada de credencial na tela ou no log.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { PAPEIS_VINCULO, rotuloPapel } from "../../shared/permissoes.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { garantirPerfilOperacionalInicial, inserirVinculoOrgComPerfil, inserirVinculoUnidadeComPerfil } from "../sessao/perfil.service.js";
import { gerarToken, hashToken, tokenValido } from "../notificacoes/notificacoes.basico.js";
import { segredosDisponiveis, cifrarEmail, hmacEmail, VERSAO_CHAVE_ATUAL } from "../notificacoes/notificacoes.segredos.js";
import { contaExistentePorEmail, criarUsuario } from "./usuarios.service.js";
import { origemParaLinks } from "../../shared/urlPublica.js";

const VALIDADE_MS = 72 * 3_600_000 - 60_000;

export function mascararEmail(email) {
  const [u, d] = String(email).split("@");
  return `${u.slice(0, Math.min(2, u.length))}${"*".repeat(Math.max(3, u.length - 2))}@${d}`;
}

export function modoEnvioEmail(env = process.env) {
  return String(env.USUARIOS_CONVITE_EMAIL ?? "").trim().toLowerCase() === "supabase" ? "supabase" : "desligado";
}

/** "Conceder acesso": conta existente = vínculo imediato; conta nova = convite por e-mail. */
export async function concederOuConvidar({ req, organizacaoId, nome, email, papel, unidadeId = null, baseUrl = null, env = process.env, deps = {} }) {
  const emailNorm = v.email(email);
  const papelNorm = v.umDe(papel, "Cargo", PAPEIS_VINCULO);
  const nomeNorm = v.textoOpcional(nome, "Nome", { max: 160 }) ?? emailNorm.split("@")[0];
  const unidade = unidadeId ? v.uuid(unidadeId, "Unidade") : null;
  const db = deps.supabase ?? supabase;
  if (unidade) {
    const { data: u } = await db.from("unidades").select("id").eq("id", unidade).eq("organizacao_id", organizacaoId).maybeSingle();
    if (!u) throw ApiError.badRequest("Unidade fora desta empresa.");
  }

  if (await (deps.contaExistentePorEmail ?? contaExistentePorEmail)(emailNorm)) {
    if (unidade) throw ApiError.badRequest("Esta pessoa já tem conta: conceda o acesso à empresa (o acesso por unidade é feito pelo Administrador da plataforma).");
    const r = await (deps.criarUsuario ?? criarUsuario)({ organizacaoId, nome: nomeNorm, email: emailNorm, senha: null, papel: papelNorm });
    return { tipo: "ACESSO_CONCEDIDO", usuario: r };
  }

  if (modoEnvioEmail(env) !== "supabase") {
    throw new ApiError(409, "Esta pessoa ainda não tem conta e o envio de convites por e-mail não está configurado. Peça ao Administrador da plataforma para criar a conta.", { codigo: "CONVITE_EMAIL_DESLIGADO" });
  }
  if (!(deps.segredosDisponiveis ? deps.segredosDisponiveis() : segredosDisponiveis())) {
    throw new ApiError(503, "Convites por e-mail ainda não estão habilitados neste ambiente.", { codigo: "CONVITE_INDISPONIVEL" });
  }
  const origem = baseUrl ?? origemParaLinks({ env, req });   // origem confiável ANTES de gravar qualquer coisa
  const token = gerarToken();
  const linha = {
    token_hash: hashToken(token), organizacao_id: organizacaoId, unidade_alvo_id: unidade, papel: papelNorm, nome: nomeNorm,
    email_hmac: hmacEmail(emailNorm), email_cifrado: cifrarEmail(emailNorm), email_mascarado: mascararEmail(emailNorm), chave_versao: VERSAO_CHAVE_ATUAL,
    criado_por: req?.user?.id ?? null, criado_perfil_id: req?.perfil?.id ?? null, expira_em: new Date(Date.now() + VALIDADE_MS).toISOString(),
  };
  const { data, error } = await db.from("usuarios_convites").insert(linha).select("id, expira_em").single();
  if (error?.code === "23505") throw new ApiError(409, "Já existe um convite pendente para este e-mail nesta empresa.");
  if (error) throw ApiError.internal(error.message);

  const { error: e } = await db.auth.admin.inviteUserByEmail(emailNorm, { redirectTo: `${origem}/convite-usuario.html#t=${token}`, data: { nome: nomeNorm } });
  const envio = e ? "FALHOU" : "ENVIADO";
  // Falhou o e-mail: o convite morre aqui (revogado) — nada fica pendente sem como ser ativado; o admin pode tentar de novo.
  await db.from("usuarios_convites").update({ envio_status: envio, envio_tentado_em: new Date().toISOString(), ...(e ? { revogado_em: new Date().toISOString(), revogado_por: req?.user?.id ?? null } : {}) }).eq("id", data.id);
  await (deps.auditar ?? auditar)({ acao: ACOES.USUARIO_CONVITE_CRIADO, atorTipo: "usuario", atorId: req?.user?.id ?? null, perfilId: req?.perfil?.id ?? null,
    organizacaoId, entidade: "usuario_convite", entidadeId: data.id, detalhes: { email_mascarado: linha.email_mascarado, papel: papelNorm, unidade_id: unidade, envio } });
  if (e) throw new ApiError(502, "Não foi possível enviar o convite por e-mail agora. Nada ficou pendente: tente de novo.", { codigo: "CONVITE_EMAIL_FALHOU" });
  return { tipo: "CONVITE_CRIADO", convite: { id: data.id, emailMascarado: linha.email_mascarado, papel: papelNorm, papelRotulo: rotuloPapel(papelNorm), expiraEm: data.expira_em, envio } };
}

export async function listarConvites({ organizacaoId, deps = {} }) {
  const { data, error } = await (deps.supabase ?? supabase).from("usuarios_convites")
    .select("id, nome, papel, email_mascarado, unidade_alvo_id, criado_em, expira_em, envio_status, usado_em, revogado_em")
    .eq("organizacao_id", organizacaoId).is("usado_em", null).is("revogado_em", null).order("criado_em", { ascending: false }).limit(50);
  if (error) throw ApiError.internal(error.message);
  const agora = Date.now();
  return (data ?? []).map((c) => ({ id: c.id, nome: c.nome, papel: c.papel, papelRotulo: rotuloPapel(c.papel), emailMascarado: c.email_mascarado,
    unidadeId: c.unidade_alvo_id, criadoEm: c.criado_em, expiraEm: c.expira_em, envio: c.envio_status, expirado: Date.parse(c.expira_em) <= agora }));
}

export async function revogarConvite({ req, organizacaoId, id, deps = {} }) {
  const cid = v.uuid(id, "Convite");
  const { data, error } = await (deps.supabase ?? supabase).from("usuarios_convites")
    .update({ revogado_em: new Date().toISOString(), revogado_por: req?.user?.id ?? null })
    .eq("organizacao_id", organizacaoId).eq("id", cid).is("usado_em", null).is("revogado_em", null).select("id").maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data) throw ApiError.notFound("Convite não encontrado ou já encerrado.");
  await (deps.auditar ?? auditar)({ acao: ACOES.USUARIO_CONVITE_REVOGADO, atorTipo: "usuario", atorId: req?.user?.id ?? null, organizacaoId, entidade: "usuario_convite", entidadeId: cid });
  return { revogado: true };
}

/** O CONVIDADO (já autenticado com o e-mail convidado) aceita: consumo atômico + vínculo. Sem contexto de empresa. */
export async function aceitarConvite({ req, token, deps = {} }) {
  if (!tokenValido(token)) throw ApiError.badRequest("Convite inválido.");
  const email = req?.user?.email;
  if (!email) throw ApiError.unauthorized("Entre com o e-mail que recebeu o convite.");
  if (!(deps.segredosDisponiveis ? deps.segredosDisponiveis() : segredosDisponiveis())) throw new ApiError(503, "Convites indisponíveis neste ambiente.");
  const db = deps.supabase ?? supabase;
  const { data: r, error } = await db.rpc("usuarios_convite_consumir", { p_token_hash: hashToken(token), p_email_hmac: hmacEmail(email), p_usuario_id: req.user.id });
  if (error) throw ApiError.internal(error.message);
  const MSG = { INVALIDO: "Convite inválido.", REVOGADO: "Este convite foi cancelado.", JA_USADO: "Este convite já foi usado.", EXPIRADO: "Este convite expirou. Peça um novo.",
    EMAIL_DIVERGENTE: "Este convite é para outro e-mail. Entre com o e-mail convidado.", UNIDADE_MUDOU_DE_EMPRESA: "A unidade do convite mudou de empresa. Peça um novo convite." };
  if (r?.resultado !== "CONSUMIDO") throw ApiError.badRequest(MSG[r?.resultado] ?? "Convite inválido.");
  const nome = r.nome ?? email.split("@")[0];
  const { data: perfil } = await db.from("perfis").select("id").eq("id", req.user.id).maybeSingle();
  if (!perfil) await db.from("perfis").insert({ id: req.user.id, nome, email, ativo: true, organizacao_id: null, unidade_id: null });
  const perfilId = await (deps.garantirPerfilOperacionalInicial ?? garantirPerfilOperacionalInicial)({ contaId: req.user.id, nome, ativo: true });
  const e = r.unidade_alvo_id
    ? await (deps.inserirVinculoUnidade ?? inserirVinculoUnidadeComPerfil)({ usuarioId: req.user.id, perfilId, unidadeId: r.unidade_alvo_id, papel: r.papel, upsert: true })
    : await (deps.inserirVinculoOrg ?? inserirVinculoOrgComPerfil)({ usuarioId: req.user.id, perfilId, organizacaoId: r.organizacao_id, papel: r.papel, upsert: true });
  if (e) throw ApiError.internal("Convite aceito, mas o acesso não pôde ser criado. Fale com o administrador.");
  await (deps.auditar ?? auditar)({ acao: ACOES.USUARIO_CONVITE_ACEITO, atorTipo: "usuario", atorId: req.user.id, organizacaoId: r.organizacao_id,
    entidade: "usuario_convite", entidadeId: r.convite_id, detalhes: { papel: r.papel, unidade_id: r.unidade_alvo_id ?? null } });
  return { aceito: true, organizacaoId: r.organizacao_id };
}
