// PAINEL ADMINISTRATIVO — configuração DEFINITIVA de WhatsApp por EMPRESA (fim do piloto, migration 104):
//   status operacional · VÁRIOS destinatários (com categorias de aviso) · envio automático · limites · simulação (dry-run).
//
// Autorização: exatamente a do resto do módulo (`requirePainelAdministrativo` no router inteiro — nenhuma lógica paralela). Multi-tenant: TODA operação
// exige o `organizacaoId` da URL e revalida que o destinatário pertence a essa empresa (id de outra empresa = "não encontrado"). O Painel é
// cross-tenant por AUTORIZAÇÃO explícita; uma empresa nunca vê/altera dados de outra por esta camada.
//
// Telefone: SEMPRE mascarado na saída (nunca o E.164 completo para o frontend). Segredos/tokens: nunca. Toda mudança relevante é AUDITADA.
// Este arquivo NÃO importa o pipeline de orquestração de alertas, o provider nem o whatsapp.service: só lê, configura e simula.

import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import * as repo from "./administrativo.comunicacao.repo.js";
import { mascararTelefoneUi } from "./administrativo.comunicacao.central.js";
import * as contatosEmpresa from "../comunicacao/comunicacao.contatosEmpresa.repo.js";
import * as destinatarios from "../comunicacao/comunicacao.destinatarios.repo.js";
import { modoAtual, obterConfig, obterLimiteDestinatariosAtivos } from "../comunicacao/comunicacao.config.js";
import { modoPermiteEnvioReal, TIPOS_ALERTA } from "../comunicacao/comunicacao.constants.js";
import { diagnosticoPilotoLegado } from "../comunicacao/comunicacao.piloto.js";
import { proximoInstantePermitido } from "../comunicacao/comunicacao.horario.js";
import { janelasEfetivas, interpretarHabilitacao } from "../comunicacao/comunicacao.habilitacao.js";
import { simularCiclo } from "../comunicacao/comunicacao.dryrun.js";
import { resumirEntregaAlerta } from "../comunicacao/comunicacao.entregaAlerta.js";

const conflito = (msg, codigo) => new ApiError(409, msg, { codigo });
const ator = (autor) => ({ atorId: autor?.contaId ?? null, perfilId: autor?.perfilId ?? null, perfilNome: autor?.nome ?? null, atorEmail: autor?.email ?? null });
const lerModo = (deps) => (typeof deps.lerModo === "function" ? deps.lerModo() : modoAtual(deps));

/** Códigos de status operacional (a tela mostra `rotulo`). */
export const STATUS_OPERACIONAL = Object.freeze({
  ATIVO: "ATIVO",
  DESATIVADO_PARA_EMPRESA: "DESATIVADO_PARA_EMPRESA",
  CONFIGURACAO_INCOMPLETA: "CONFIGURACAO_INCOMPLETA",
  SEM_DESTINATARIOS_ATIVOS: "SEM_DESTINATARIOS_ATIVOS",
  ENVIO_AUTOMATICO_DESLIGADO: "ENVIO_AUTOMATICO_DESLIGADO",
  EMPRESA_PAUSADA: "EMPRESA_PAUSADA",
  ENVIO_GLOBAL_DESATIVADO: "ENVIO_GLOBAL_DESATIVADO",
});

const ROTULOS = Object.freeze({
  ATIVO: "Ativo",
  DESATIVADO_PARA_EMPRESA: "WhatsApp desativado para esta empresa",
  CONFIGURACAO_INCOMPLETA: "Configuração incompleta",
  SEM_DESTINATARIOS_ATIVOS: "Sem destinatários ativos",
  ENVIO_AUTOMATICO_DESLIGADO: "Envio automático desligado",
  EMPRESA_PAUSADA: "Empresa pausada",
  ENVIO_GLOBAL_DESATIVADO: "Envio global desativado (modo DISABLED)",
});

/**
 * Estado operacional da EMPRESA, em ordem de precedência (a 1ª regra que casa vence). Pura — testável sem banco.
 *   1. sem habilitação                     -> WhatsApp desativado para esta empresa
 *   2. habilitada e SEM nenhum destinatário / sem timezone / sem tipo / nenhum validado -> Configuração incompleta
 *   3. destinatários cadastrados mas nenhum ativo -> Sem destinatários ativos
 *   4. envio automático desligado
 *   5. pausa vigente
 *   6. modo global sem envio real (DISABLED)
 *   7. ativo
 * @param {{hab: object|null, destinatarios: Array<{ativo: boolean, whatsapp_status?: string}>, modo: string, agora?: Date}} p
 */
export function statusOperacionalEmpresa({ hab, destinatarios: lista, modo, agora = new Date() }) {
  const r = (codigo, motivo = null) => ({ codigo, rotulo: ROTULOS[codigo], motivo });
  if (!hab || hab.habilitado !== true) return r("DESATIVADO_PARA_EMPRESA");
  if (!lista.length) return r("CONFIGURACAO_INCOMPLETA", "Nenhum destinatário cadastrado.");
  if (!hab.timezone) return r("CONFIGURACAO_INCOMPLETA", "Fuso horário não definido.");
  if (!hab.tipos_permitidos?.length) return r("CONFIGURACAO_INCOMPLETA", "Nenhum tipo de alerta permitido.");
  const ativos = lista.filter((d) => d.ativo === true);
  if (!ativos.length) return r("SEM_DESTINATARIOS_ATIVOS");
  if (!ativos.some((d) => d.whatsapp_status === "VALIDADO")) return r("CONFIGURACAO_INCOMPLETA", "Nenhum destinatário ativo com WhatsApp validado.");
  if (hab.envio_automatico !== true) return r("ENVIO_AUTOMATICO_DESLIGADO");
  if (hab.pausado_ate && new Date(hab.pausado_ate).getTime() > agora.getTime()) return r("EMPRESA_PAUSADA");
  if (!modoPermiteEnvioReal(modo)) return r("ENVIO_GLOBAL_DESATIVADO");
  return r("ATIVO");
}

/** Projeção segura de um destinatário para a tela (telefone SEMPRE mascarado). */
function projetarDestinatario(d, contato, ultimoEnvio) {
  return {
    id: d.id, nome: d.nome, tipo: d.tipo, ativo: d.ativo === true, telefoneMascarado: mascararTelefoneUi(d.telefone_e164),
    whatsappStatus: d.whatsapp_status, autorizadoEm: d.autorizacao_registrada_em ?? d.whatsapp_validado_em ?? null,
    ativadoEm: d.ativado_em ?? null, ultimoEnvioEm: ultimoEnvio ?? null,
    consentimento: contato?.consentimento === true, verificado: contato?.verificado === true, optOut: contato?.opt_out === true,
    categorias: d.categorias ?? [], observacoes: d.observacoes ?? null,
  };
}

/**
 * GET /administrativo/comunicacao/organizacoes/:organizacaoId/whatsapp — a tela de WhatsApp da empresa: status, envio automático, destinatários,
 * categorias, limites e diagnóstico. Somente leitura.
 */
export async function painelEmpresa({ organizacaoId } = {}, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const agora = deps.agora ?? new Date();
  const [org, modo, gateway, lista, categoriasCatalogo, limitesGlobais, janelasGlobais, tetoDestinatarios, atividade] = await Promise.all([
    repo.obterOrganizacaoComConfiguracao(orgId, deps), lerModo(deps), repo.obterEstadoGateway(deps),
    destinatarios.listarDestinatariosDaEmpresa(orgId, deps), destinatarios.listarCategorias({ apenasAtivas: true }, deps),
    obterConfig("limites", deps), obterConfig("janelas", deps), obterLimiteDestinatariosAtivos(deps), repo.obterAtividadeDaEmpresa(orgId, deps),
  ]);
  const alertasRecentes = (await repo.listarAlertasRecentesComMensagens({ organizacaoId: orgId, limite: 10 }, deps)).map(({ alerta, mensagens }) => ({
    alertaId: alerta.id, unidadeId: alerta.unidade_id, tipo: alerta.tipo_alerta, dataReferencia: alerta.data_referencia, status: alerta.status, atualizadoEm: alerta.updated_at,
    // status do alerta é "otimista" (evita reprocessar); a ENTREGA por destinatário é a verdade administrativa: parcial nunca fica escondida.
    entrega: resumirEntregaAlerta(mensagens),
  }));
  if (!org) throw ApiError.notFound("Empresa não encontrada.");
  const hab = org.comunicacao_habilitacoes ?? null;
  const contatos = await repo.listarContatosPorIds(lista.map((d) => d.contato_whatsapp_id), deps);
  const contatoPorId = new Map(contatos.map((c) => [c.id, c]));
  const status = statusOperacionalEmpresa({ hab, destinatarios: lista, modo, agora });

  // Próximo envio POSSÍVEL: a próxima mensagem já agendada, senão a próxima abertura de janela comercial da empresa.
  let proximoEnvioPossivelEm = atividade.proximoEm ?? null;
  if (!proximoEnvioPossivelEm && hab?.timezone) {
    try {
      const h = interpretarHabilitacao(hab, TIPOS_ALERTA.DASHBOARD_IFOOD_D1, agora);
      const janelas = janelasEfetivas(h, janelasGlobais);
      if (janelas) proximoEnvioPossivelEm = proximoInstantePermitido(agora, hab.timezone, janelas).toISOString();
    } catch { proximoEnvioPossivelEm = null; }
  }
  const ativos = lista.filter((d) => d.ativo === true);
  return {
    organizacao: { organizacaoId: org.id, nome: org.nome },
    // Painel de status (etapa 10)
    status: {
      ...status,
      whatsapp: gateway.estado,                       // conectado | desconectado | instavel | desconhecido
      modoGlobal: modo, envioRealPermitido: modoPermiteEnvioReal(modo),
      empresaHabilitada: hab?.habilitado === true,
      envioAutomatico: hab?.envio_automatico === true,
      destinatariosAtivos: ativos.length, destinatariosTotal: lista.length,
      ultimoEnvioEm: atividade.ultimoEm ?? null, proximoEnvioPossivelEm,
    },
    configuracao: {
      timezone: hab?.timezone ?? null, tiposPermitidos: hab?.tipos_permitidos ?? [], pausadoAte: hab?.pausado_ate ?? null, pausadoMotivo: hab?.pausado_motivo ?? null,
      limites: {
        limiteDiarioOrg: hab?.limite_diario_org ?? null, cooldownMinutos: hab?.cooldown_minutos ?? null,
        padraoGlobal: { maxPorDestinatarioPorDia: limitesGlobais?.max_por_contato_por_dia ?? null, maxPorOrganizacaoPorDia: limitesGlobais?.max_por_organizacao_por_dia ?? 20 },
      },
      tetoDestinatariosAtivos: tetoDestinatarios,
    },
    categoriasDisponiveis: categoriasCatalogo.map((c) => ({ codigo: c.codigo, rotulo: c.rotulo, descricao: c.descricao })),
    alertasRecentes,
    destinatarios: lista.map((d) => projetarDestinatario(d, contatoPorId.get(d.contato_whatsapp_id), atividade.ultimoPorContato?.get(d.contato_whatsapp_id) ?? null)),
    // Diagnóstico técnico: as variáveis do piloto, se ainda existirem no ambiente, aparecem como LEGACY — sem efeito (nunca o valor).
    diagnostico: { pilotoLegado: diagnosticoPilotoLegado(deps.env ?? process.env) },
  };
}

// ---------------------------------------------------------------------------
// DESTINATÁRIOS
// ---------------------------------------------------------------------------

const saidaDestinatario = (d) => ({ id: d.id, nome: d.nome, tipo: d.tipo, ativo: d.ativo === true, telefoneMascarado: mascararTelefoneUi(d.telefone_e164), whatsappStatus: d.whatsapp_status });

/** POST /organizacoes/:id/destinatarios */
export async function criarDestinatario({ organizacaoId, nome, telefone, tipo, categorias, observacoes } = {}, autor, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const teto = await obterLimiteDestinatariosAtivos(deps);
  const ativos = (await contatosEmpresa.listarDaEmpresa(orgId, deps)).filter((d) => d.ativo === true).length;
  if (ativos >= teto) throw conflito(`A empresa atingiu o limite de ${teto} destinatários ativos. Desative um antes de adicionar outro.`, "LIMITE_DESTINATARIOS");
  const d = await destinatarios.criarDestinatario({ organizacaoId: orgId, nome, telefone, tipo, categorias, observacoes }, autor, deps);
  return { organizacaoId: orgId, destinatario: saidaDestinatario(d), categorias };
}

/** PUT /organizacoes/:id/destinatarios/:contatoId */
export async function atualizarDestinatario({ organizacaoId, contatoEmpresaId, nome, telefone, tipo, observacoes } = {}, autor, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const cid = v.uuid(contatoEmpresaId, "Destinatário");
  const r = await destinatarios.atualizarDestinatario({ organizacaoId: orgId, contatoEmpresaId: cid, nome, telefone, tipo, observacoes }, autor, deps);
  return { organizacaoId: orgId, destinatario: saidaDestinatario(r.destinatario), telefoneAlterado: r.telefoneAlterado };
}

/** PUT /organizacoes/:id/destinatarios/:contatoId/categorias   { categorias: [...] } */
export async function definirCategoriasDestinatario({ organizacaoId, contatoEmpresaId, categorias } = {}, autor, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const cid = v.uuid(contatoEmpresaId, "Destinatário");
  return { organizacaoId: orgId, contatoEmpresaId: cid, ...(await destinatarios.definirCategorias({ organizacaoId: orgId, contatoEmpresaId: cid, categorias }, autor, deps)) };
}

/** PUT /organizacoes/:id/destinatarios/:contatoId/ativo   { ativo } — desativar é IMEDIATO (o envio revalida `ativo` no JIT). */
export async function definirAtivoDestinatario({ organizacaoId, contatoEmpresaId, ativo } = {}, autor, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const cid = v.uuid(contatoEmpresaId, "Destinatário");
  if (typeof ativo !== "boolean") throw ApiError.badRequest("ativo deve ser booleano.", { codigo: "ATIVO_INVALIDO" });
  const r = await destinatarios.definirAtivoDestinatario({ organizacaoId: orgId, contatoEmpresaId: cid, ativo }, autor, deps);
  return { organizacaoId: orgId, destinatario: saidaDestinatario(r.destinatario), alterou: r.alterou };
}

/** POST /organizacoes/:id/destinatarios/:contatoId/autorizar   { confirmacaoExplicita } — registra a AUTORIZAÇÃO/consentimento (ato humano explícito). */
export async function autorizarDestinatario({ organizacaoId, contatoEmpresaId, confirmacaoExplicita } = {}, autor, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const cid = v.uuid(contatoEmpresaId, "Destinatário");
  if (confirmacaoExplicita !== true) {
    throw ApiError.badRequest("Confirmação explícita obrigatória — só confirme depois de autorização inequívoca do destinatário.", { codigo: "CONFIRMACAO_OBRIGATORIA" });
  }
  const r = await contatosEmpresa.validarWhatsApp({ organizacaoId: orgId, contatoEmpresaId: cid }, autor, deps);
  await auditar({
    ...ator(autor), atorTipo: "usuario", acao: ACOES.COMUNICACAO_DESTINATARIO_AUTORIZADO, organizacaoId: orgId, entidade: "comunicacao_contatos_empresa", entidadeId: cid,
    detalhes: { origem: "confirmacao_explicita_operador_painel_admin" },
  });
  return { organizacaoId: orgId, destinatario: saidaDestinatario(r) };
}

/** POST /organizacoes/:id/destinatarios/:contatoId/opt-out — registra que a pessoa pediu para parar; bloqueia envios imediatamente. */
export async function registrarOptOutDestinatario({ organizacaoId, contatoEmpresaId, confirmacaoExplicita } = {}, autor, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const cid = v.uuid(contatoEmpresaId, "Destinatário");
  if (confirmacaoExplicita !== true) throw ApiError.badRequest("Confirmação explícita obrigatória para registrar o opt-out.", { codigo: "CONFIRMACAO_OBRIGATORIA" });
  return { organizacaoId: orgId, ...(await destinatarios.registrarOptOutDestinatario({ organizacaoId: orgId, contatoEmpresaId: cid }, autor, deps)) };
}

// ---------------------------------------------------------------------------
// ENVIO AUTOMÁTICO + LIMITES
// ---------------------------------------------------------------------------

const MOTIVO_ENVIO_AUTOMATICO = Object.freeze({
  SEM_CONFIGURACAO: "A empresa ainda não tem configuração de WhatsApp.",
  EMPRESA_NAO_HABILITADA: "Ative os avisos pelo WhatsApp para esta empresa antes de ligar o envio automático.",
  SEM_DESTINATARIO_ELEGIVEL: "É preciso ao menos um destinatário ativo, autorizado e com a categoria de aviso habilitada.",
});

/**
 * PUT /organizacoes/:id/envio-automatico   { ligar, confirmacaoExplicita }
 * Ligar: confirmação explícita + empresa habilitada + destinatário elegível (o banco valida atomicamente). Desligar: sempre permitido.
 * NÃO altera o modo global: com `modo = DISABLED` nada é enviado, mesmo com o envio automático ligado.
 */
export async function definirEnvioAutomatico({ organizacaoId, ligar, confirmacaoExplicita } = {}, autor, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  if (typeof ligar !== "boolean") throw ApiError.badRequest("`ligar` deve ser true ou false.", { codigo: "LIGAR_INVALIDO" });
  if (ligar && confirmacaoExplicita !== true) throw ApiError.badRequest("Confirmação explícita obrigatória para ligar o envio automático.", { codigo: "CONFIRMACAO_OBRIGATORIA" });
  const org = await repo.obterOrganizacaoComConfiguracao(orgId, deps);
  if (!org) throw ApiError.notFound("Empresa não encontrada.");
  const r = await repo.definirEnvioAutomatico({ organizacaoId: orgId, ligar, atorPerfilId: autor?.perfilId ?? null }, deps);
  if (MOTIVO_ENVIO_AUTOMATICO[r.acao]) throw conflito(MOTIVO_ENVIO_AUTOMATICO[r.acao], r.acao);
  const alterou = r.acao === "LIGADO" || r.acao === "DESLIGADO";
  if (alterou) {
    await auditar({
      ...ator(autor), atorTipo: "usuario", acao: r.acao === "LIGADO" ? ACOES.COMUNICACAO_ENVIO_AUTOMATICO_LIGADO : ACOES.COMUNICACAO_ENVIO_AUTOMATICO_DESLIGADO,
      organizacaoId: orgId, entidade: "comunicacao_habilitacoes", entidadeId: orgId, detalhes: { de: !ligar, para: ligar },
    });
  }
  return { organizacaoId: orgId, envioAutomatico: ligar, alterou };
}

const inteiroPositivoOuNulo = (x, nome) => {
  if (x === null) return null;
  if (!Number.isInteger(x) || x <= 0 || x > 100_000) throw ApiError.badRequest(`${nome} deve ser um inteiro positivo (ou null para o padrão global).`, { codigo: "LIMITE_INVALIDO" });
  return x;
};

/** PUT /organizacoes/:id/limites   { limiteDiarioOrg?, cooldownMinutos? } — null volta ao padrão global. */
export async function atualizarLimites({ organizacaoId, limiteDiarioOrg, cooldownMinutos } = {}, autor, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const campos = {};
  if (limiteDiarioOrg !== undefined) campos.limiteDiarioOrg = inteiroPositivoOuNulo(limiteDiarioOrg, "limiteDiarioOrg");
  if (cooldownMinutos !== undefined) campos.cooldownMinutos = inteiroPositivoOuNulo(cooldownMinutos, "cooldownMinutos");
  if (!Object.keys(campos).length) throw ApiError.badRequest("Informe limiteDiarioOrg e/ou cooldownMinutos.", { codigo: "LIMITE_INVALIDO" });
  const r = await repo.atualizarLimitesOrganizacao({ organizacaoId: orgId, ...campos, atorPerfilId: autor?.perfilId ?? null }, deps);
  await auditar({
    ...ator(autor), atorTipo: "usuario", acao: ACOES.COMUNICACAO_LIMITES_ALTERADOS, organizacaoId: orgId, entidade: "comunicacao_habilitacoes", entidadeId: orgId,
    detalhes: { limite_diario_org: r.limite_diario_org, cooldown_minutos: r.cooldown_minutos },
  });
  return { organizacaoId: orgId, limiteDiarioOrg: r.limite_diario_org, cooldownMinutos: r.cooldown_minutos };
}

// ---------------------------------------------------------------------------
// SIMULAÇÃO (DRY-RUN)
// ---------------------------------------------------------------------------

/**
 * POST /organizacoes/:id/dry-run — o motor completo SEM efeito: não cria alerta/mensagem, não consome idempotência/limite/cooldown, não chama o provider.
 * Permitido em QUALQUER modo (inclusive DISABLED). Só registra QUEM executou (auditoria administrativa genérica — nunca nas tabelas operacionais).
 */
export async function executarDryRun({ organizacaoId } = {}, autor, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const org = await repo.obterOrganizacaoComConfiguracao(orgId, deps);
  if (!org) throw ApiError.notFound("Empresa não encontrada.");
  const r = await (deps.simularCiclo ?? simularCiclo)({ organizacaoId: orgId, agora: deps.agora ?? new Date() }, deps);
  await auditar({
    ...ator(autor), atorTipo: "usuario", acao: ACOES.COMUNICACAO_DRY_RUN_EXECUTADO, organizacaoId: orgId, entidade: "comunicacao_habilitacoes", entidadeId: orgId,
    detalhes: { ...r.resumo, modo_global: r.modoGlobal, provider_chamado: false },
  });
  return r;
}
