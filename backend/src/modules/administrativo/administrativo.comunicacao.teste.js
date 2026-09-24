// TESTE CONTROLADO — camada do PAINEL ADMINISTRATIVO (H.4-B.5). Só um operador HUMANO autenticado, com confirmação explícita, e só com o modo global
// em DISABLED (o worker está pulando ciclos: nenhum fluxo operacional coexiste). FAIL-CLOSED em qualquer divergência: se qualquer gate falha, o provider
// NÃO é chamado. O envio em si (mensagem própria, sem alerta, 1 provider call) é do módulo comunicacao/comunicacao.teste.js.
//
// A mensagem NÃO é uma pendência: nunca cria/altera alerta D-1, nunca toca a mensagem histórica do 1º piloto.

import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import * as repo from "./administrativo.comunicacao.repo.js";
import { mascararTelefoneUi, abreviarId } from "./administrativo.comunicacao.central.js";
import { modoAtual } from "../comunicacao/comunicacao.config.js";
import { MODOS, STATUS_MENSAGEM } from "../comunicacao/comunicacao.constants.js";
import { pilotoHabilitado, lerAllowlistPiloto } from "../comunicacao/comunicacao.piloto.js";
import * as filaRepo from "../comunicacao/comunicacao.fila.repo.js";
import {
  enviarMensagemTeste, textoDoTeste, limiteTestesReais, criarWhatsAppServiceDoAmbiente, chaveIdempotenciaTeste, PROPOSITO_TESTE, TIPO_MENSAGEM_TESTE,
} from "../comunicacao/comunicacao.teste.js";

const conflito = (msg, codigo) => new ApiError(409, msg, { codigo });

// Costuras de TESTE (produção nunca as passa): o modo global e o estado do Gateway vêm do banco/heartbeat reais.
const lerModo = (deps) => (typeof deps.lerModo === "function" ? deps.lerModo() : modoAtual(deps));
const lerGateway = (deps) => (deps.estadoGateway !== undefined ? deps.estadoGateway : repo.obterEstadoGateway(deps));

/** Bloqueios possíveis (código estável + mensagem para o gestor). A ORDEM é a ordem de exibição. */
const MENSAGENS = Object.freeze({
  MODO_NAO_DISABLED: "O teste só pode ser feito com a automação desativada. Desative a comunicação automática antes de testar.",
  GATEWAY_INDISPONIVEL: "O WhatsApp não está conectado no momento.",
  WHATSAPP_NAO_CONFIGURADO: "A conexão do backend com o WhatsApp não está configurada.",
  UNIDADE_INVALIDA: "Selecione uma unidade ativa desta empresa.",
  SEM_DESTINATARIO: "Esta empresa não tem um destinatário configurado.",
  SEM_CONSENTIMENTO: "O destinatário ainda não teve o consentimento confirmado.",
  NAO_VERIFICADO: "O número do destinatário ainda não foi verificado.",
  OPT_OUT: "O destinatário pediu para não receber mensagens.",
  FORA_DA_ALLOWLIST: "O destinatário não está autorizado pelo piloto neste servidor.",
  LIMITE_TESTE_ATINGIDO: "O limite de mensagens reais de teste já foi atingido.",
});

function ator(autor) {
  return { atorId: autor?.contaId ?? null, perfilId: autor?.perfilId ?? null, perfilNome: autor?.nome ?? null, atorEmail: autor?.email ?? null };
}

/** Escolhe a unidade padrão do teste: a "Matriz" da empresa, senão a primeira ativa. */
function unidadePadrao(unidades) {
  const ativas = unidades.filter((u) => u.ativo !== false);
  return ativas.find((u) => /matriz/i.test(u.nome ?? "")) ?? ativas[0] ?? null;
}

/**
 * Avalia TODOS os gates do teste e devolve o contexto + a lista de bloqueios (vazia = pode enviar). Somente leitura.
 * `env`/`whatsAppConfigurado` só existem para teste.
 */
async function avaliarGates({ organizacaoId, unidadeId }, deps = {}) {
  const env = deps.env ?? process.env;
  const org = await repo.obterOrganizacaoComConfiguracao(organizacaoId, deps);
  if (!org) throw ApiError.notFound("Empresa não encontrada.");
  const hab = org.comunicacao_habilitacoes ?? null;
  const [modo, gateway, unidades, contato, contabilizadas] = await Promise.all([
    lerModo(deps), lerGateway(deps), repo.listarUnidades({ organizacaoId }, deps),
    hab?.destinatario_contato_id ? repo.obterContato(hab.destinatario_contato_id, deps) : null,
    filaRepo.listarMensagensTesteContabilizadas(deps),
  ]);
  const unidade = unidadeId ? (unidades.find((u) => u.id === unidadeId && u.ativo !== false) ?? null) : unidadePadrao(unidades);
  const lista = lerAllowlistPiloto(env);
  const pilotoAtivo = pilotoHabilitado(env);
  const permitidoNoPiloto = pilotoAtivo && !!contato?.telefone_e164 && lista.includes(contato.telefone_e164);
  const whatsappConfigurado = deps.whatsAppService !== undefined
    ? !!deps.whatsAppService
    : !!String(env.WHATSAPP_GATEWAY_URL ?? "").trim() && !!String(env.WHATSAPP_GATEWAY_SECRET ?? "").trim();
  const limite = limiteTestesReais(env);

  const bloqueios = [];
  if (modo !== MODOS.DISABLED) bloqueios.push("MODO_NAO_DISABLED");
  if (gateway.estado !== "conectado") bloqueios.push("GATEWAY_INDISPONIVEL");
  if (!whatsappConfigurado) bloqueios.push("WHATSAPP_NAO_CONFIGURADO");
  if (!unidade) bloqueios.push("UNIDADE_INVALIDA");
  if (!contato) bloqueios.push("SEM_DESTINATARIO");
  else {
    if (contato.consentimento !== true) bloqueios.push("SEM_CONSENTIMENTO");
    if (contato.verificado !== true) bloqueios.push("NAO_VERIFICADO");
    if (contato.opt_out !== false) bloqueios.push("OPT_OUT");
    if (!permitidoNoPiloto) bloqueios.push("FORA_DA_ALLOWLIST");
  }
  if (contabilizadas.length >= limite) bloqueios.push("LIMITE_TESTE_ATINGIDO");
  return { org, hab, contato, unidade, unidades, modo, gateway, pilotoAtivo, permitidoNoPiloto, contabilizadas, limite, bloqueios };
}

/** GET /administrativo/comunicacao/teste/preparo?organizacaoId=&unidadeId= — o que o modal mostra (sem telefone completo). */
export async function preparoTeste({ organizacaoId, unidadeId } = {}, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const uniId = unidadeId ? v.uuid(unidadeId, "Unidade") : null;
  const g = await avaliarGates({ organizacaoId: orgId, unidadeId: uniId }, deps);
  return {
    organizacao: { organizacaoId: orgId, nome: g.org.nome },
    unidade: g.unidade ? { unidadeId: g.unidade.id, nome: g.unidade.nome } : null,
    unidadesDisponiveis: g.unidades.filter((u) => u.ativo !== false).map((u) => ({ unidadeId: u.id, nome: u.nome })),
    contato: g.contato ? { telefoneMascarado: mascararTelefoneUi(g.contato.telefone_e164), consentimento: g.contato.consentimento === true, verificado: g.contato.verificado === true, optOut: g.contato.opt_out === true } : null,
    whatsapp: g.gateway.estado,
    modo: g.modo,
    piloto: { ativo: g.pilotoAtivo, destinatarioPermitido: g.permitidoNoPiloto },
    limite: { usados: g.contabilizadas.length, maximo: g.limite },
    previewTexto: textoDoTeste(g.unidade?.nome),
    podeEnviar: g.bloqueios.length === 0,
    bloqueios: g.bloqueios.map((codigo) => ({ codigo, mensagem: MENSAGENS[codigo] })),
  };
}

const existentePorChave = (testeId, deps) => repo.obterMensagemPorChave(chaveIdempotenciaTeste(testeId), deps);

/**
 * POST /administrativo/comunicacao/teste   { organizacaoId, unidadeId, testeId, confirmacaoExplicita }
 * `testeId` (UUID) é gerado pela TELA ao abrir o modal: duplo clique/reenvio = MESMO testeId = UMA mensagem.
 */
export async function enviarTeste({ organizacaoId, unidadeId, testeId, confirmacaoExplicita } = {}, autor, deps = {}) {
  if (!autor?.contaId) throw ApiError.unauthorized("Operador não identificado.");
  const orgId = v.uuid(organizacaoId, "Empresa");
  const uniId = v.uuid(unidadeId, "Unidade");
  const tid = v.uuid(testeId, "Teste");
  if (confirmacaoExplicita !== true) {
    throw ApiError.badRequest("Confirmação explícita obrigatória para enviar a mensagem de teste.", { codigo: "CONFIRMACAO_OBRIGATORIA" });
  }
  // Repetição do MESMO teste (duplo clique / corrida): só devolve o que existe — sem gates, sem provider.
  const jaExiste = await existentePorChave(tid, deps);
  if (jaExiste) return { mensagemId: jaExiste.id, status: jaExiste.status, resultado: "JA_EXISTIA", jaExistia: true };

  const g = await avaliarGates({ organizacaoId: orgId, unidadeId: uniId }, deps);
  if (g.bloqueios.length) {
    // Uma corrida com a MESMA chave pode ter criado a mensagem entre a checagem acima e agora (o próprio teste conta no limite): reconfere.
    const corrida = await existentePorChave(tid, deps);
    if (corrida) return { mensagemId: corrida.id, status: corrida.status, resultado: "JA_EXISTIA", jaExistia: true };
    const codigo = g.bloqueios[0];
    throw conflito(MENSAGENS[codigo], codigo);
  }

  const whatsAppService = deps.whatsAppService !== undefined ? deps.whatsAppService : await criarWhatsAppServiceDoAmbiente(deps.env ?? process.env);
  if (!whatsAppService) throw conflito(MENSAGENS.WHATSAPP_NAO_CONFIGURADO, "WHATSAPP_NAO_CONFIGURADO");

  const base = ator(autor);
  const detalhesBase = { unidade_id: uniId, unidade: g.unidade.nome, telefone_mascarado: mascararTelefoneUi(g.contato.telefone_e164), teste_id: tid, origem: "teste_painel" };
  let r;
  try {
    r = await enviarMensagemTeste({
      testeId: tid, organizacaoId: orgId, unidadeId: uniId, contatoId: g.contato.id, destinatarioPerfilId: g.hab?.destinatario_perfil_id ?? null,
      telefoneE164: g.contato.telefone_e164, texto: textoDoTeste(g.unidade.nome), atorPerfilId: autor.perfilId ?? null,
      limite: g.limite, whatsAppService, modoAtual: () => lerModo(deps),
      aoIniciar: (mensagemId) => auditar({ ...base, acao: ACOES.COMUNICACAO_TESTE_INICIADO, entidade: "comunicacao_mensagens", entidadeId: mensagemId, organizacaoId: orgId, detalhes: detalhesBase }),
    }, deps);
  } catch (e) {
    await auditar({ ...base, acao: ACOES.COMUNICACAO_TESTE_FALHOU, entidade: "comunicacao_mensagens", entidadeId: null, organizacaoId: orgId, detalhes: { ...detalhesBase, etapa: "criacao_ou_envio", erro: String(e?.message ?? e).slice(0, 200) } });
    throw e;
  }

  if (r.resultado === "JA_EXISTIA") return { mensagemId: r.mensagemId, status: r.status, resultado: "JA_EXISTIA", jaExistia: true };
  if (r.resultado === "LIMITE_ATINGIDO") throw conflito(MENSAGENS.LIMITE_TESTE_ATINGIDO, "LIMITE_TESTE_ATINGIDO");
  if (r.resultado === "MODO_NAO_PERMITIDO") throw conflito(MENSAGENS.MODO_NAO_DISABLED, "MODO_NAO_DISABLED");
  if (r.resultado === "POSSE_PERDIDA") throw conflito("O envio deste teste já está em andamento.", "TESTE_EM_ANDAMENTO");

  if (r.resultado === "ENVIADO") {
    await auditar({ ...base, acao: ACOES.COMUNICACAO_TESTE_ENVIADO, entidade: "comunicacao_mensagens", entidadeId: r.mensagemId, organizacaoId: orgId, detalhes: detalhesBase });
  } else {
    await auditar({ ...base, acao: ACOES.COMUNICACAO_TESTE_FALHOU, entidade: "comunicacao_mensagens", entidadeId: r.mensagemId, organizacaoId: orgId, detalhes: { ...detalhesBase, classificacao: r.classificacao ?? null, resultado: r.resultado, erro: r.erro ?? null } });
  }
  return { mensagemId: r.mensagemId, status: r.status ?? null, resultado: r.resultado, jaExistia: false };
}

/** Situação amigável do teste (a tela nunca chama SENT de "Entregue"). */
function situacaoDoTeste(m) {
  switch (m.status) {
    case STATUS_MENSAGEM.PROCESSING: return "PREPARANDO";
    case STATUS_MENSAGEM.SENDING: return "ENVIANDO";
    case STATUS_MENSAGEM.SENT: return "ENVIADO_AO_PROVEDOR";
    case STATUS_MENSAGEM.DELIVERED: return "ENTREGUE";
    case STATUS_MENSAGEM.READ: return "LIDO";
    case STATUS_MENSAGEM.DELIVERY_UNKNOWN: return "ENTREGA_NAO_CONFIRMADA";
    case STATUS_MENSAGEM.FAILED: return "FALHOU";
    case STATUS_MENSAGEM.CANCELLED: return "CANCELADO";
    default: return "OUTRO";
  }
}

/**
 * GET /administrativo/comunicacao/teste/:mensagemId — acompanhamento do teste (a tela consulta a cada poucos segundos). Grava, UMA vez cada, a auditoria
 * ENTREGUE/LIDO quando o receipt já foi persistido (marcador em metadados com concorrência otimista).
 */
export async function statusTeste({ mensagemId } = {}, autor, deps = {}) {
  const mid = v.uuid(mensagemId, "Mensagem");
  const m = await repo.obterMensagemCentral(mid, deps);
  if (!m || (m.metadados?.proposito !== PROPOSITO_TESTE && m.tipo !== TIPO_MENSAGEM_TESTE)) throw ApiError.notFound("Teste não encontrado.");
  const base = ator(autor);
  const detalhes = { teste_id: m.metadados?.teste_id ?? null, mensagem: abreviarId(m.id), provider: abreviarId(m.provider_message_id) };
  const entregue = m.status === STATUS_MENSAGEM.DELIVERED || m.status === STATUS_MENSAGEM.READ || !!m.entregue_em;
  const lido = m.status === STATUS_MENSAGEM.READ || !!m.lido_em;
  if (entregue && await filaRepo.marcarAuditoriaTeste({ id: m.id, marco: "entregue" }, deps)) {
    await auditar({ ...base, acao: ACOES.COMUNICACAO_TESTE_ENTREGUE, entidade: "comunicacao_mensagens", entidadeId: m.id, organizacaoId: m.organizacao_id, detalhes: { ...detalhes, entregue_em: m.entregue_em } });
  }
  if (lido && await filaRepo.marcarAuditoriaTeste({ id: m.id, marco: "lido" }, deps)) {
    await auditar({ ...base, acao: ACOES.COMUNICACAO_TESTE_LIDO, entidade: "comunicacao_mensagens", entidadeId: m.id, organizacaoId: m.organizacao_id, detalhes: { ...detalhes, lido_em: m.lido_em } });
  }
  const enviadoMs = m.enviado_em ? Date.parse(m.enviado_em) : null;
  return {
    mensagemId: m.id, idAbreviado: abreviarId(m.id), providerMessageIdAbreviado: abreviarId(m.provider_message_id),
    status: m.status, situacao: situacaoDoTeste(m),
    criadoEm: m.created_at, enviadoEm: m.enviado_em ?? null, servidorAceitouEm: m.metadados?.provider_ack?.servidor_em ?? null,
    entregueEm: m.entregue_em ?? null, lidoEm: m.lido_em ?? null, falhouEm: m.falhou_em ?? null,
    erro: m.erro ? String(m.erro).slice(0, 200) : null, erroProvider: m.metadados?.provider_erro?.codigo ?? null, tentativas: m.tentativas,
    segundosDesdeEnvio: enviadoMs != null && Number.isFinite(enviadoMs) ? Math.max(0, Math.round((Date.now() - enviadoMs) / 1000)) : null,
  };
}
