// MOVA CORE — F2: ROTAS do vínculo WhatsApp ↔ conta da plataforma (pedido de 24/11, §5). Montadas DEPOIS de requireContexto:
// tudo vem da sessão VERIFICADA (req.user, req.acesso, req.tenant), nunca do corpo. Ligadas só com MOVA_CORE_VINCULO_HABILITADO=1.
//
//   GET  /mova/vinculo/meu             o perfil logado está vinculado? (sem dados de outras pessoas)
//   POST /mova/vinculo/codigo          gera o código de uso único (6 dígitos, 10 min) para enviar ao MOVA no privado do WhatsApp
//   POST /mova/vinculo/revogar         { vinculoId, motivo? } — o titular revoga o próprio; o administrador, qualquer um da empresa
//   GET  /mova/vinculo/admin           administração (usuarios.gerenciar): vínculos da empresa + entradas da lista sem vínculo
//   POST /mova/vinculo/admin/aprovar   { entradaId, perfilId } — o administrador vincula uma entrada da lista a um perfil
// Impersonação nunca gera código, nunca administra e nunca é vinculada. Cada vínculo/revogação fica na auditoria do serviço.
import { Router } from "express";

const STATUS = { SEM_PERMISSAO_DE_ADMINISTRAR_VINCULOS: 403, IMPERSONACAO_NAO_VINCULA: 403, PERFIL_DE_EXIBICAO_NAO_VINCULA: 403, PERFIL_SEM_ACESSO_A_EMPRESA: 403,
  PERFIL_DE_OUTRA_CONTA: 403, VINCULO_NAO_ENCONTRADO: 404, ENTRADA_NAO_ENCONTRADA: 404, JA_VINCULADO: 409, ENTRADA_INVALIDA: 400, ENTRADA_INCOMPLETA: 400 };
const MENSAGEM = {
  SEM_PERMISSAO_DE_ADMINISTRAR_VINCULOS: "Só quem administra os usuários desta empresa pode fazer isso.",
  IMPERSONACAO_NAO_VINCULA: "Em acesso de suporte (impersonação) não é possível vincular o WhatsApp.",
  PERFIL_DE_EXIBICAO_NAO_VINCULA: "Perfis de exibição (TV/checklist) não são vinculados ao WhatsApp.",
  PERFIL_SEM_ACESSO_A_EMPRESA: "Este perfil não tem acesso ativo a esta empresa.", PERFIL_DE_OUTRA_CONTA: "Este perfil não é da sua conta.",
  VINCULO_NAO_ENCONTRADO: "Vínculo não encontrado nesta empresa.", ENTRADA_NAO_ENCONTRADA: "Essa pessoa não está na lista autorizada do MOVA desta empresa.",
  JA_VINCULADO: "Esse WhatsApp (ou esse perfil) já está vinculado.", ENTRADA_INVALIDA: "Entrada da lista inválida.", ENTRADA_INCOMPLETA: "Informe a pessoa da lista e o perfil.",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.servico                 criarServicoDeIdentidade(...) (preguiçoso: só abre o banco no 1º uso)
 * @param {(organizacaoId:string) => Promise<object[]>} deps.entradasDaOrganizacao  entradas da LISTA autorizada do MOVA (servidor)
 */
export function criarRouterVinculoMova({ servico, entradasDaOrganizacao }) {
  const r = Router();
  const responder = (res, x, ok = 200) => (x?.ok === false ? res.status(STATUS[x.motivo] ?? 409).json({ erro: x.motivo, codigo: x.motivo, error: MENSAGEM[x.motivo] ?? "Não foi possível concluir.", mensagem: MENSAGEM[x.motivo] ?? "Não foi possível concluir." }) : res.status(ok).json(x));
  const org = (req) => req.tenant?.organizacaoId ?? req.acesso?.empresa?.id ?? null;
  const rota = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

  r.get("/meu", rota(async (req, res) => {
    if (!req.acesso?.perfilId) return responder(res, { ok: false, motivo: "IMPERSONACAO_NAO_VINCULA" });
    res.json(await (await servico()).meuVinculo({ perfilId: req.acesso.perfilId, organizacaoId: org(req) }));
  }));
  r.post("/codigo", rota(async (req, res) => {
    res.set("Cache-Control", "no-store"); // o código aparece UMA vez na tela; nunca em cache
    responder(res, await (await servico()).solicitarCodigo({ contaId: req.user?.id ?? null, perfilId: req.acesso?.perfilId ?? null, organizacaoId: org(req), impersonando: Boolean(req.acesso?.impersonando) }));
  }));
  r.post("/revogar", rota(async (req, res) => {
    const vinculoId = String(req.body?.vinculoId ?? "");
    if (!UUID.test(vinculoId)) return responder(res, { ok: false, motivo: "VINCULO_NAO_ENCONTRADO" });
    responder(res, await (await servico()).revogarAutorizado({ acesso: req.acesso, contaId: req.user?.id ?? null, organizacaoId: org(req), vinculoId, motivo: String(req.body?.motivo ?? "REVOGADO").slice(0, 120) }));
  }));
  r.get("/admin", rota(async (req, res) => {
    responder(res, await (await servico()).listarParaAdmin({ acessoDoAdmin: req.acesso, organizacaoId: org(req), entradas: await entradasDaOrganizacao(org(req)) }));
  }));
  r.post("/admin/aprovar", rota(async (req, res) => {
    const entradaId = String(req.body?.entradaId ?? ""); const perfilId = String(req.body?.perfilId ?? "");
    if (!entradaId || !UUID.test(perfilId)) return responder(res, { ok: false, motivo: "ENTRADA_INCOMPLETA" });
    const entrada = (await entradasDaOrganizacao(org(req))).find((e) => String(e.id ?? e.pessoaId ?? "") === entradaId);
    if (!entrada) return responder(res, { ok: false, motivo: "ENTRADA_NAO_ENCONTRADA" });
    responder(res, await (await servico()).aprovarPorAdmin({ acessoDoAdmin: req.acesso, adminContaId: req.user?.id ?? null, organizacaoId: org(req), entrada, perfilId }), 201);
  }));
  return r;
}
