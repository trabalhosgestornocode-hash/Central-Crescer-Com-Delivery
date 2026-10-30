// Central de Notificações — operações do GESTOR (rotas autenticadas do tenant). D-3: o recorte vem de escopoDeGestao(req).
//
// Estados (doc 04 §3) são DERIVADOS, nunca gravados: LEGACY_ACTIVE (recebia o D-1 antes da Central; sem OTP retroativo),
// ATIVO (convite + OTP + consentimento), VERIFICADO_SEM_CONSENTIMENTO, SUSPENSO, REVOGADO; convites: PENDENTE_VERIFICACAO,
// VERIFICADO_SEM_CONSENTIMENTO, EXPIRADO. Nada aqui grava consentimento: só o titular (notificacoes.titular.service.js).
import { ApiError } from "../../shared/ApiError.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import * as v from "../../shared/validar.js";
import * as repo from "./notificacoes.repository.js";
import { unidadeNoAlcance } from "./notificacoes.permissoes.js";
import { validarWhatsapp, mascarar, gerarToken, hashToken, CONVITE_VALIDADE_MS } from "./notificacoes.basico.js";
import { segredosDisponiveis, cifrarTelefone, hmacTelefone, VERSAO_CHAVE_ATUAL } from "./notificacoes.segredos.js";
import { capacidades } from "./notificacoes.envio.js";

export const CATEGORIA_D1 = "pendencia_d1";
export const TEXTO_PENDENCIA_D1 = "Nenhum destinatário configurado para o Dashboard iFood D-1";
const LIMITE_CONVITES_USUARIO_DIA = 30;
const LIMITE_CONVITES_UNIDADE_DIA = 50;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const conflito = (msg, codigo) => new ApiError(409, msg, { codigo });
const R = (deps) => deps?.repo ?? repo;
const exigirSegredos = (deps) => {
  if (deps?.segredosDisponiveis ? !deps.segredosDisponiveis() : !segredosDisponiveis()) {
    throw new ApiError(503, "A Central de Notificações ainda não está habilitada neste ambiente.", { codigo: "NOTIFICACOES_INDISPONIVEL" });
  }
};
const quem = (req) => ({ contaId: req?.user?.id ?? null, perfilId: req?.perfil?.id ?? req?.acesso?.perfilId ?? null, nome: req?.perfil?.nome ?? null, email: req?.user?.email ?? null });

async function registrar(req, acao, { organizacaoId, unidadeId = null, entidadeId = null, detalhes = {} }, deps = {}) {
  const a = quem(req);
  await (deps.auditar ?? auditar)({
    acao, atorTipo: "usuario", atorId: a.contaId, perfilId: a.perfilId, perfilNome: a.nome, organizacaoId,
    entidade: "notificacoes", entidadeId, impersonadoPor: req?.acesso?.impersonadoPor ?? null,
    detalhes: { ...detalhes, unidade_id: unidadeId },
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------------------------------------------------------
function ultimaAcao(ledger, ceId, categoria) {
  const x = ledger.find((l) => l.contato_empresa_id === ceId && l.categoria === categoria && (l.acao === "CONCEDIDO" || l.acao === "REVOGADO"));
  return x?.acao ?? null;   // ledger vem ordenado do mais recente para o mais antigo
}

/** Estado derivado de um destinatário (puro, testável). */
export function estadoDoDestinatario({ ce, escopos, categoriasLegadas, optOut, ledger, selecaoLigada }) {
  if (optOut === true) return "REVOGADO";
  if (ce.ativo === false) return "SUSPENSO";
  const convite = escopos.filter((e) => e.origem_autorizacao === "CONVITE_OTP");
  const legadoCat = categoriasLegadas.find((c) => c.categoria === CATEGORIA_D1);
  const temLegado = escopos.some((e) => e.origem_autorizacao === "LEGACY_ACTIVE") || (ce.whatsapp_status === "VALIDADO" && !!legadoCat);
  if (temLegado && !convite.length) {
    const ativoLegado = selecaoLigada
      ? escopos.some((e) => e.origem_autorizacao === "LEGACY_ACTIVE" && e.habilitado && !e.suspenso_em) && legadoCat?.habilitado === true
      : legadoCat?.habilitado === true;
    if (ativoLegado) return "LEGACY_ACTIVE";
    if (ultimaAcao(ledger, ce.id, CATEGORIA_D1) === "REVOGADO") return "REVOGADO";
    return "SUSPENSO";
  }
  if (!convite.length) return "VERIFICADO_SEM_CONSENTIMENTO";
  const vale = convite.filter((e) => e.habilitado && !e.suspenso_em && ultimaAcao(ledger, ce.id, e.categoria) === "CONCEDIDO");
  if (vale.length) return "ATIVO";
  if (convite.every((e) => ultimaAcao(ledger, ce.id, e.categoria) === "REVOGADO")) return "REVOGADO";
  if (convite.some((e) => e.suspenso_em)) return "SUSPENSO";
  return "VERIFICADO_SEM_CONSENTIMENTO";
}

export function estadoDoConvite(c, agora = Date.now()) {
  if (c.status === "PENDENTE") return Date.parse(c.expira_em) <= agora ? "EXPIRADO" : "PENDENTE_VERIFICACAO";
  if (c.status === "VERIFICADO") return Date.parse(c.expira_em) <= agora ? "EXPIRADO" : "VERIFICADO_SEM_CONSENTIMENTO";
  return c.status === "CONCLUIDO" ? "CONCLUIDO" : "CANCELADO";
}

/** Resumo da Central para o contexto: estado do recurso, unidades no alcance e pendências (D-16). */
export async function resumo({ escopo, deps = {} }) {
  const r = R(deps);
  const [unidades, selecaoLigada] = await Promise.all([r.listarUnidades({ organizacaoId: escopo.organizacaoId }, deps), r.selecaoPorEscopoLigada(deps)]);
  const noAlcance = unidades.filter((u) => u.ativo && !u.eh_teste && unidadeNoAlcance(escopo, u.id));
  const pendencias = [];
  for (const u of noAlcance) {
    const lista = await r.resolverD1PorUnidade({ organizacaoId: escopo.organizacaoId, unidadeId: u.id }, deps);
    if (!(lista ?? []).some((x) => x.elegivel)) pendencias.push({ codigo: "SEM_DESTINATARIO_D1", unidadeId: u.id, unidadeNome: u.nome, texto: TEXTO_PENDENCIA_D1 });
  }
  return {
    disponivel: deps.segredosDisponiveis ? deps.segredosDisponiveis() : segredosDisponiveis(),
    transporte: capacidades(deps.env),
    selecaoPorEscopo: selecaoLigada,
    unidades: noAlcance.map((u) => ({ id: u.id, nome: u.nome })),
    pendencias,
    podeGerenciar: escopo.podeGerenciar,
    recorte: escopo.unidadePermitida ? "unidade" : "empresa",
  };
}

export async function listarDestinatarios({ escopo, deps = {} }) {
  const r = R(deps);
  const [dados, categorias, unidades, selecaoLigada, convites] = await Promise.all([
    r.listarDestinatarios({ organizacaoId: escopo.organizacaoId }, deps), r.listarCategorias(deps),
    r.listarUnidades({ organizacaoId: escopo.organizacaoId }, deps), r.selecaoPorEscopoLigada(deps), r.listarConvites({ organizacaoId: escopo.organizacaoId }, deps),
  ]);
  const nomeUn = new Map(unidades.map((u) => [u.id, u.nome]));
  const rotulo = new Map(categorias.map((c) => [c.codigo, c.rotulo]));
  const ledger = await r.listarConsentimentos({ organizacaoId: escopo.organizacaoId, contatoEmpresaIds: dados.destinatarios.map((d) => d.id) }, deps);
  const optOut = new Map(dados.contatos.map((c) => [c.id, c.opt_out === true]));
  const ativasDaEmpresa = unidades.filter((u) => u.ativo && !u.eh_teste);
  const itens = [];
  for (const ce of dados.destinatarios) {
    const escopos = dados.escopos.filter((e) => e.contato_empresa_id === ce.id);
    const categoriasLegadas = dados.categoriasLegadas.filter((c) => c.contato_empresa_id === ce.id);
    const estado = estadoDoDestinatario({ ce, escopos, categoriasLegadas, optOut: optOut.get(ce.contato_whatsapp_id) ?? false, ledger, selecaoLigada });
    const legadoPreM3 = !selecaoLigada && ce.whatsapp_status === "VALIDADO" && categoriasLegadas.some((c) => c.categoria === CATEGORIA_D1);
    // vínculos por unidade: antes da M3, o legado recebe o D-1 de todas as unidades da empresa (configuração anterior)
    const vinculos = escopos.map((e) => ({
      unidadeId: e.unidade_escopo_id, unidadeNome: nomeUn.get(e.unidade_escopo_id) ?? "Unidade", categoria: e.categoria, categoriaRotulo: rotulo.get(e.categoria) ?? e.categoria,
      habilitado: e.habilitado, suspenso: !!e.suspenso_em, suspensoMotivo: e.suspenso_motivo ?? null, origem: e.origem_autorizacao, origemVinculo: e.origem_vinculo,
      janela: e.janela ?? null, silencio: e.silencio ?? null, notificarCorrecao: e.notificar_correcao, simulado: e.verificacao_simulada === true,
      consentimento: e.origem_autorizacao === "CONVITE_OTP" ? ultimaAcao(ledger, ce.id, e.categoria) : null,
      transferida: !nomeUn.has(e.unidade_escopo_id),
    }));
    const unidadesDoDestinatario = legadoPreM3 ? ativasDaEmpresa.map((u) => u.id) : [...new Set(escopos.map((e) => e.unidade_escopo_id))];
    if (escopo.unidadePermitida && !unidadesDoDestinatario.includes(escopo.unidadePermitida)) continue;   // gerente: só o que toca a unidade dele
    const compartilhado = unidadesDoDestinatario.some((u) => u !== escopo.unidadePermitida);
    itens.push({
      id: ce.id, nome: ce.nome, tipo: ce.tipo, telefoneMascarado: mascarar(ce.telefone_e164), estado,
      origem: escopos.some((e) => e.origem_autorizacao === "CONVITE_OTP") ? "CONVITE_OTP" : (legadoPreM3 || escopos.some((e) => e.origem_autorizacao === "LEGACY_ACTIVE") ? "LEGACY_ACTIVE" : "OUTRO"),
      autorizacaoAnteriorEm: ce.autorizacao_registrada_em ?? null,
      configuracaoAnteriorTodasUnidades: legadoPreM3,
      vinculos: escopo.unidadePermitida ? vinculos.filter((x) => x.unidadeId === escopo.unidadePermitida) : vinculos,
      compartilhadoComOutrasUnidades: !!escopo.unidadePermitida && compartilhado,
      podeEditarCadastro: escopo.podeGerenciar && (!escopo.unidadePermitida || !compartilhado),
    });
  }
  const agora = Date.now();
  const convs = convites
    .filter((c) => !escopo.unidadePermitida || (c.unidades_pretendidas ?? []).includes(escopo.unidadePermitida))
    .map((c) => ({ id: c.id, nome: c.nome, telefoneMascarado: c.telefone_mascarado, estado: estadoDoConvite(c, agora), criadoEm: c.criado_em, expiraEm: c.expira_em,
      unidades: (c.unidades_pretendidas ?? []).map((u) => nomeUn.get(u) ?? "Unidade"), categorias: (c.categorias_pretendidas ?? []).map((k) => rotulo.get(k) ?? k), simulado: c.simulado }));
  return { destinatarios: itens, convites: convs, selecaoPorEscopo: selecaoLigada };
}

export async function listarCategorias({ deps = {} } = {}) {
  const cats = await R(deps).listarCategorias(deps);
  return cats.map((c) => ({ codigo: c.codigo, rotulo: c.rotulo, descricao: c.descricao, grupo: c.grupo, estado: c.estado,
    selecionavel: c.estado === "ATIVA" || c.estado === "SIMULACAO", simulacao: c.estado === "SIMULACAO", exigeConsentimento: c.exige_consentimento, cota: c.cota ?? null }));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Convite (o gestor convida; o titular verifica e consente)
// ---------------------------------------------------------------------------------------------------------------------------
export async function criarConvite({ req, escopo, corpo, baseUrl = "", deps = {} }) {
  exigirSegredos(deps);
  const r = R(deps);
  const nome = v.texto(corpo?.nome, "Nome", { min: 1, max: 120 });
  const tipo = v.umDeOpcional(corpo?.tipo, "Papel", ["principal", "secundario", "financeiro", "operacional"], "operacional");
  const unidades = [...new Set(Array.isArray(corpo?.unidades) ? corpo.unidades.map((u) => v.uuid(u, "Unidade")) : [])];
  if (!unidades.length || unidades.length > 50) throw ApiError.badRequest("Escolha ao menos uma unidade.");
  for (const u of unidades) if (!unidadeNoAlcance(escopo, u)) throw ApiError.forbidden("Você só pode convidar para a sua unidade.");
  const categorias = [...new Set(Array.isArray(corpo?.categorias) ? corpo.categorias.map(String) : [])];
  const disponiveis = new Set((await r.listarCategorias(deps)).filter((c) => c.estado === "ATIVA" || c.estado === "SIMULACAO").map((c) => c.codigo));
  if (!categorias.length || categorias.some((c) => !disponiveis.has(c))) throw ApiError.badRequest("Escolha categorias disponíveis.");

  let e164; let contatoEmpresaId = null;
  if (corpo?.destinatarioId) {                                 // adesão voluntária de um destinatário já cadastrado (ex.: legado)
    contatoEmpresaId = v.uuid(corpo.destinatarioId, "Destinatário");
    const ce = await r.obterDestinatario({ organizacaoId: escopo.organizacaoId, id: contatoEmpresaId }, deps);
    if (!ce) throw ApiError.notFound("Destinatário não encontrado.");
    e164 = validarWhatsapp(ce.telefone_e164);
    if (!e164) throw ApiError.badRequest("O número cadastrado deste destinatário não é um WhatsApp válido.");
  } else {
    e164 = validarWhatsapp(corpo?.telefone);
    if (!e164) throw ApiError.badRequest("Informe um WhatsApp válido (com DDD; de fora do Brasil, com +DDI).", { codigo: "TELEFONE_INVALIDO" });
    const { destinatarios } = await r.listarDestinatarios({ organizacaoId: escopo.organizacaoId }, deps);
    if (destinatarios.some((d) => d.ativo && d.telefone_e164 === e164)) {
      throw conflito("Este número já é destinatário desta empresa. Use “Convidar para novas categorias” nele.", "JA_E_DESTINATARIO");
    }
  }
  const desde = new Date(Date.now() - 86_400_000).toISOString();
  const contagem = await r.contarConvitesRecentes({ organizacaoId: escopo.organizacaoId, criadoPor: req?.user?.id ?? null, unidadeId: unidades[0], desdeIso: desde }, deps);
  if (contagem.porUsuario >= LIMITE_CONVITES_USUARIO_DIA || contagem.porUnidade >= LIMITE_CONVITES_UNIDADE_DIA) {
    throw ApiError.tooManyRequests("Limite diário de convites atingido. Tente amanhã.");
  }
  const token = gerarToken();
  const expira = new Date(Date.now() + CONVITE_VALIDADE_MS - 60_000);
  const linha = await r.inserirConvite({
    token_hash: hashToken(token), organizacao_id: escopo.organizacaoId, unidades_pretendidas: unidades, categorias_pretendidas: categorias,
    contato_empresa_id: contatoEmpresaId, nome, tipo_destinatario: tipo, telefone_cifrado: cifrarTelefone(e164), telefone_hmac: hmacTelefone(e164),
    telefone_mascarado: mascarar(e164), chave_versao: VERSAO_CHAVE_ATUAL, criado_por: req?.user?.id ?? null, criado_perfil_id: quem(req).perfilId,
    unidade_permitida: escopo.unidadePermitida, expira_em: expira.toISOString(), simulado: capacidades(deps.env).simulado,
  }, deps);
  await registrar(req, ACOES.NOTIFICACAO_CONVITE_CRIADO, { organizacaoId: escopo.organizacaoId, unidadeId: unidades[0], entidadeId: linha.id,
    detalhes: { unidades, categorias, telefone_mascarado: mascarar(e164), adesao_de_legado: !!contatoEmpresaId } }, deps);
  // O token vai no FRAGMENTO (#): navegadores não o enviam ao servidor nem a logs de acesso. Mostrado UMA vez ao gestor.
  return { id: linha.id, link: `${baseUrl}/notificacoes/convite.html#t=${token}`, expiraEm: linha.expira_em, telefoneMascarado: mascarar(e164) };
}

export async function cancelarConvite({ req, escopo, id, deps = {} }) {
  const cid = v.uuid(id, "Convite");
  const r = R(deps);
  const conv = (await r.listarConvites({ organizacaoId: escopo.organizacaoId }, deps)).find((c) => c.id === cid);
  if (!conv) throw ApiError.notFound("Convite não encontrado.");
  if (escopo.unidadePermitida && !(conv.unidades_pretendidas ?? []).every((u) => u === escopo.unidadePermitida)) throw ApiError.forbidden("Convite de outra unidade.");
  const feito = await r.cancelarConvite({ organizacaoId: escopo.organizacaoId, id: cid }, deps);
  if (!feito) throw conflito("Este convite já foi concluído ou cancelado.", "CONVITE_ENCERRADO");
  await registrar(req, ACOES.NOTIFICACAO_CONVITE_CANCELADO, { organizacaoId: escopo.organizacaoId, unidadeId: conv.unidades_pretendidas?.[0] ?? null, entidadeId: cid }, deps);
  return { cancelado: true };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Escopo: suspender/reativar, preferências, vínculo de legado, pedido de revogação, edição do cadastro
// ---------------------------------------------------------------------------------------------------------------------------
function alvoEscopo(escopo, corpo) {
  const unidadeId = v.uuid(corpo?.unidadeId, "Unidade");
  if (!unidadeNoAlcance(escopo, unidadeId)) throw ApiError.forbidden("Fora do seu alcance (unidade).");
  return { unidadeId, categoria: v.texto(corpo?.categoria ?? CATEGORIA_D1, "Categoria", { max: 64 }) };
}

export async function suspender({ req, escopo, destinatarioId, corpo, deps = {} }) {
  const contatoEmpresaId = v.uuid(destinatarioId, "Destinatário");
  const { unidadeId, categoria } = alvoEscopo(escopo, corpo);
  const suspender = corpo?.suspender !== false;
  const motivo = suspender ? v.textoOpcional(corpo?.motivo, "Motivo", { max: 300 }) : null;
  const r = await R(deps).suspenderEscopo({ organizacaoId: escopo.organizacaoId, unidadePermitida: escopo.unidadePermitida, contatoEmpresaId, unidadeId,
    categoria, suspender, motivo, ator: quem(req).perfilId }, deps);
  if (r?.resultado === "ESCOPO_INEXISTENTE") throw ApiError.notFound("Este destinatário não tem esse vínculo nessa unidade.");
  await registrar(req, suspender ? ACOES.NOTIFICACAO_ESCOPO_SUSPENSO : ACOES.NOTIFICACAO_ESCOPO_REATIVADO, { organizacaoId: escopo.organizacaoId, unidadeId,
    entidadeId: contatoEmpresaId, detalhes: { categoria, motivo, mensagens_canceladas: r?.mensagens_canceladas ?? 0 } }, deps);
  return r;
}

function faixa(valor, campo) {
  if (valor == null || valor === "") return null;
  if (typeof valor !== "object" || !HHMM.test(valor.inicio ?? "") || !HHMM.test(valor.fim ?? "") || valor.inicio === valor.fim) {
    throw ApiError.badRequest(`${campo}: use início e fim no formato HH:MM, diferentes.`);
  }
  return { inicio: valor.inicio, fim: valor.fim };
}

export async function definirPreferencias({ req, escopo, destinatarioId, corpo, deps = {} }) {
  const contatoEmpresaId = v.uuid(destinatarioId, "Destinatário");
  const { unidadeId, categoria } = alvoEscopo(escopo, corpo);
  const p = { janela: faixa(corpo?.janela, "Horário preferido"), silencio: faixa(corpo?.silencio, "Horário de silêncio"),
    notificarCorrecao: typeof corpo?.notificarCorrecao === "boolean" ? corpo.notificarCorrecao : null,
    habilitado: corpo?.habilitado === false ? false : null };   // o gestor só RESTRINGE: nunca liga o que o titular não autorizou
  const r = await R(deps).preferenciasEscopo({ organizacaoId: escopo.organizacaoId, unidadePermitida: escopo.unidadePermitida, contatoEmpresaId, unidadeId, categoria, ...p, ator: quem(req).perfilId }, deps);
  if (r?.resultado === "ESCOPO_INEXISTENTE") throw ApiError.notFound("Este destinatário não tem esse vínculo nessa unidade.");
  await registrar(req, ACOES.NOTIFICACAO_ESCOPO_ALTERADO, { organizacaoId: escopo.organizacaoId, unidadeId, entidadeId: contatoEmpresaId, detalhes: { categoria, ...p } }, deps);
  return r;
}

export async function vincularLegado({ req, escopo, destinatarioId, corpo, deps = {} }) {
  const contatoEmpresaId = v.uuid(destinatarioId, "Destinatário");
  const unidadeId = v.uuid(corpo?.unidadeId, "Unidade");
  if (!unidadeNoAlcance(escopo, unidadeId)) throw ApiError.forbidden("Fora do seu alcance (unidade).");
  v.texto(corpo?.motivo, "Motivo", { min: 3, max: 300 });
  const r = await R(deps).vincularLegado({ organizacaoId: escopo.organizacaoId, unidadePermitida: escopo.unidadePermitida, contatoEmpresaId, unidadeId, ator: quem(req).perfilId }, deps);
  if (r?.resultado === "SELECAO_POR_ESCOPO_DESLIGADA") throw conflito("Antes da ativação da nova seleção, os destinatários legados já recebem o D-1 de todas as unidades.", "SELECAO_DESLIGADA");
  if (r?.resultado === "NAO_E_LEGADO") throw conflito("Só destinatários legados podem ser vinculados assim (só para o D-1). Para os demais, envie um convite.", "NAO_E_LEGADO");
  await registrar(req, ACOES.NOTIFICACAO_VINCULO_INCLUIDO, { organizacaoId: escopo.organizacaoId, unidadeId, entidadeId: contatoEmpresaId, detalhes: { categoria: CATEGORIA_D1, motivo: corpo.motivo } }, deps);
  return r;
}

/** Pedido do TITULAR registrado pelo gestor (canal fora do sistema). Gerente: efeito só na unidade dele. Nunca reativa nada. */
export async function registrarPedidoRevogacao({ req, escopo, destinatarioId, corpo, deps = {} }) {
  exigirSegredos(deps);
  const contatoEmpresaId = v.uuid(destinatarioId, "Destinatário");
  const motivo = v.texto(corpo?.motivo, "Como o titular pediu", { min: 3, max: 300 });
  const categorias = Array.isArray(corpo?.categorias) && corpo.categorias.length ? corpo.categorias.map(String) : null;
  const ce = await R(deps).obterDestinatario({ organizacaoId: escopo.organizacaoId, id: contatoEmpresaId }, deps);
  if (!ce) throw ApiError.notFound("Destinatário não encontrado.");
  const r = await R(deps).revogar({ telefoneHmac: hmacTelefone(ce.telefone_e164), contatosEmpresa: [contatoEmpresaId], categorias,
    unidadeEscopoId: escopo.unidadePermitida, origem: "pedido_registrado_gestor", registradoPor: quem(req).perfilId }, deps);
  await registrar(req, ACOES.NOTIFICACAO_REVOGACAO_REGISTRADA, { organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadePermitida, entidadeId: contatoEmpresaId,
    detalhes: { categorias: categorias ?? "todas", motivo, mensagens_canceladas: r?.mensagens_canceladas ?? 0 } }, deps);
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Histórico, consentimentos e auditoria (sem conteúdo integral, IP, user-agent ou número completo)
// ---------------------------------------------------------------------------------------------------------------------------
export async function historico({ escopo, unidadeId, deps = {} }) {
  const alvo = unidadeId ? v.uuid(unidadeId, "Unidade") : escopo.unidadePermitida;
  if (alvo && !unidadeNoAlcance(escopo, alvo)) throw ApiError.forbidden("Fora do seu alcance (unidade).");
  const h = await R(deps).historico({ organizacaoId: escopo.organizacaoId, unidadeId: alvo ?? null, limite: 100 }, deps);
  return {
    reais: h.reais.map((m) => ({ id: m.id, unidadeId: m.unidade_id, destinatarioId: m.contato_empresa_id, tipo: m.tipo, status: m.status, erro: m.erro ?? null,
      criadoEm: m.created_at, enviadoEm: m.enviado_em, entregueEm: m.entregue_em, lidoEm: m.lido_em, proposito: m.metadados?.proposito ?? "inicial" })),
    simuladas: h.simuladas.map((s) => ({ id: s.id, unidadeId: s.unidade_id, fechamentoId: s.fechamento_id, versao: s.fechamento_versao, status: s.status,
      transporte: s.transporte, criadoEm: s.criado_em, destinatarioId: s.validacao?.destinatario ?? null, proposito: s.validacao?.proposito ?? null })),
  };
}

export async function consentimentos({ escopo, deps = {} }) {
  const r = R(deps);
  const { destinatarios } = await listarDestinatarios({ escopo, deps });
  const ids = destinatarios.map((d) => d.id);
  const ledger = await r.listarConsentimentos({ organizacaoId: escopo.organizacaoId, contatoEmpresaIds: ids }, deps);
  return ledger
    .filter((l) => !escopo.unidadePermitida || !l.unidade_escopo_id || l.unidade_escopo_id === escopo.unidadePermitida)
    .map((l) => ({ id: l.id, destinatarioId: l.contato_empresa_id, categoria: l.categoria, acao: l.acao, termoVersao: l.termo_versao, origem: l.origem, simulado: l.simulado, em: l.ocorreu_em }));
}

export async function auditoria({ escopo, deps = {} }) {
  const linhas = await R(deps).auditoria({ organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadePermitida, limite: 100 }, deps);
  const permitido = new Set(["categoria", "categorias", "motivo", "unidades", "telefone_mascarado", "mensagens_canceladas", "adesao_de_legado", "perfil_nome", "unidade_id", "janela", "silencio", "notificarCorrecao", "habilitado"]);
  return linhas.map((l) => ({ id: l.id, acao: l.acao, em: l.created_at, destinatarioId: l.entidade_id,
    detalhes: Object.fromEntries(Object.entries(l.detalhes ?? {}).filter(([k]) => permitido.has(k))) }));
}
