// ABA CONEXÃO — a identidade do WhatsApp do Crescer com Delivery (Painel Administrativo).
//
// PRINCÍPIOS
//   * REUTILIZA a sessão Baileys do Gateway (connect / qr / status / reset já existentes). Nenhum segundo mecanismo de sessão, nenhuma cópia de credencial aqui.
//   * PERMISSÃO ESPECÍFICA `comunicacao:gerenciar_conexao`: ter acesso às Conversas NÃO permite conectar/desconectar. Ler o estado (sem QR) é permitido a quem vê a Central.
//     O QR só é entregue a quem tem a permissão. SuperAdmin passa por bypass.
//   * O QR passa SÓ EM MEMÓRIA: nunca é gravado, logado nem auditado (a auditoria guarda a ORDEM do QR, nunca o valor).
//   * Depois de escanear, a conta NÃO é aceita em silêncio: fica PENDENTE_CONFIRMACAO até o operador confirmar; cancelar desfaz (reset). Enquanto pendente/não confirmada,
//     o envio manual da Central fica bloqueado (gate CONEXAO_NAO_CONFIRMADA).
//   * IDENTIDADE INTERNA (ambiente, "Agente Crescer") é separada do número: guardamos só o hash do número confirmado; outro número ⇒ a confirmação e o nome deixam de valer.
//   * UMA operação por vez (conectar | trocar | desconectar), com trava atômica no banco (RPC 097) — duas abas/dois operadores nunca abrem duas sessões.
//   * Desconectar NUNCA apaga histórico de comunicação: só o auth do Gateway (reset já existente) e a identidade interna.
//   * Toda ação tem AUDITORIA humana (ator, perfil, e-mail). Sem QR, sem segredo, sem telefone completo.

import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { supabase } from "../../config/supabase.js";
import { executarEfeito } from "../comunicacao/comunicacao.operacoes.js";
import { criarWhatsAppServiceDoAmbiente } from "../comunicacao/comunicacao.teste.js";
import { mascararTelefoneUi } from "./administrativo.comunicacao.central.js";
import { iniciais } from "../comunicacao/comunicacao.roster.js";
import {
  INSTANCIA, HEARTBEAT_FRESCO_MS, hashTelefone, derivarEstado, statusIdentidade, lerConexaoDb, lerIdentidade, resumoIdentidade, identidadeConfirmada,
} from "../comunicacao/comunicacao.identidade.js";

// A regra de "conta confirmada" mora num módulo NEUTRO (comunicacao.identidade.js) para que worker/teste/provider usem exatamente a mesma — reexportada aqui por compatibilidade.
export { INSTANCIA, hashTelefone, derivarEstado, statusIdentidade, resumoIdentidade, identidadeConfirmada };

export const PERMISSAO_CONEXAO = "comunicacao:gerenciar_conexao";
export const NOME_AGENTE = "Agente Crescer";
export const AMBIENTES = Object.freeze(["TESTE", "PRODUCAO"]);
export const ESTADOS = Object.freeze(["CONNECTED", "DISCONNECTED", "CONNECTING", "WAITING_QR", "RECONNECTING", "AUTH_ERROR"]);

export const ROTULO_ESTADO = Object.freeze({
  CONNECTED: "Conectado", DISCONNECTED: "Desconectado", CONNECTING: "Conectando", WAITING_QR: "Aguardando leitura do QR Code", RECONNECTING: "Reconectando", AUTH_ERROR: "Sessão inválida",
});
const ROTULO_AMBIENTE = Object.freeze({ TESTE: "Ambiente de teste", PRODUCAO: "Produção" });
const ROTULO_TIPO_CONTA = Object.freeze({ BUSINESS: "WhatsApp Business", DESCONHECIDO: "Tipo não identificado" });
const MOTIVO_FECHAMENTO = Object.freeze({
  loggedOut: "A conta foi desvinculada pelo aparelho", connectionClosed: "A conexão foi encerrada", connectionLost: "A conexão com o WhatsApp caiu", connectionReplaced: "Outra sessão assumiu esta conta",
  timedOut: "A conexão expirou", badSession: "A sessão ficou inválida", restartRequired: "O WhatsApp pediu para reiniciar a conexão", multideviceMismatch: "Incompatibilidade de dispositivo",
});
const TTL_OPERACAO_S = 300;
const JANELA_RECONCILIACAO_MS = 30_000;
const PERFIL_TTL_MS = 60_000;

const conflito = (msg, codigo) => new ApiError(409, msg, { codigo });
const agoraDe = (deps) => (typeof deps.agora === "function" ? deps.agora() : new Date());
const envDe = (deps) => deps.env ?? process.env;
const orgId = (deps) => deps.organizacaoConexaoId ?? envDe(deps).WHATSAPP_GATEWAY_ORGANIZACAO_ID ?? null;
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

async function salvarIdentidade(campos, deps) {
  const db = deps.supabase ?? supabase;
  const { error } = await db.from("whatsapp_identidade").upsert({ organizacao_id: orgId(deps), provider_instance_id: INSTANCIA, ...campos }, { onConflict: "organizacao_id,provider_instance_id" });
  if (error) throw ApiError.internal(error.message);
}

async function servico(deps) {
  if (deps.whatsAppService !== undefined) return deps.whatsAppService;
  return criarWhatsAppServiceDoAmbiente(envDe(deps));
}

/** Estado vivo do Gateway, ou `null` se inalcançável/não configurado (nunca lança). */
async function statusVivo(svc) {
  if (!svc?.conexaoStatus) return null;
  try { const r = await svc.conexaoStatus(); return r && typeof r === "object" ? r : null; } catch { return null; }
}

// Perfil da conta: 3 consultas ao WhatsApp — cache curto em memória (nunca persistido).
let cachePerfil = { em: 0, chave: null, dados: null };
export function _zerarCachePerfil() { cachePerfil = { em: 0, chave: null, dados: null }; }
async function perfilVivo(svc, deps, dbCon = null) {
  if (!svc?.conexaoPerfil) return null;
  const agora = agoraDe(deps).getTime();
  const chave = `${orgId(deps)}:${INSTANCIA}:${dbCon?.telefone_e164 ?? ""}:${dbCon?.connected_at ?? ""}`;
  if (cachePerfil.chave === chave && cachePerfil.dados && agora - cachePerfil.em < PERFIL_TTL_MS) return cachePerfil.dados;
  try {
    const p = await svc.conexaoPerfil();
    if (p?.disponivel) { cachePerfil = { em: agora, chave, dados: p }; return p; }
  } catch { /* o perfil é acessório: a conexão continua valendo */ }
  return null;
}

// ---------------------------------------------------------------------------
// Permissão
// ---------------------------------------------------------------------------

/** SuperAdmin passa; os demais precisam da permissão específica. FAIL-CLOSED em qualquer erro. */
export async function temPermissaoConexao(autor, deps = {}) {
  if (autor?.superadmin === true) return true;
  if (!autor?.contaId) return false;
  try {
    const db = deps.supabase ?? supabase;
    const { data, error } = await db.from("painel_adm_permissoes").select("usuario_id").eq("usuario_id", autor.contaId).eq("permissao", PERMISSAO_CONEXAO).maybeSingle();
    return !error && !!data;
  } catch { return false; }
}

async function exigirPermissao(autor, deps) {
  if (!autor?.contaId) throw ApiError.unauthorized("Operador não identificado.");
  if (!(await temPermissaoConexao(autor, deps))) throw ApiError.forbidden("Você não tem permissão para gerenciar a conexão do WhatsApp.");
}

// ---------------------------------------------------------------------------
// Trava de operação concorrente
// ---------------------------------------------------------------------------

async function iniciarOperacao(tipo, autor, deps) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("whatsapp_operacao_iniciar", { p_organizacao_id: orgId(deps), p_provider_instance_id: INSTANCIA, p_tipo: tipo, p_por: autor.perfilId ?? null, p_ttl_segundos: TTL_OPERACAO_S });
  if (error) throw ApiError.internal(error.message);
  const r = Array.isArray(data) ? data[0] : data;
  if (!r?.iniciada) throw conflito("Já existe uma operação de conexão em andamento. Conclua ou aguarde alguns minutos.", "OPERACAO_EM_ANDAMENTO");
  return r.operacao_id;
}

async function encerrarOperacao(operacaoId, deps) {
  if (!operacaoId) return;
  try { const db = deps.supabase ?? supabase; await db.rpc("whatsapp_operacao_encerrar", { p_organizacao_id: orgId(deps), p_provider_instance_id: INSTANCIA, p_operacao_id: operacaoId }); } catch { /* expira sozinha */ }
}

/** A operação informada é a vigente? Confirmar/cancelar toleram expiração sem substituição; sem trava, apenas uma conta ainda não confirmada. */
async function verificarOperacao(operacaoId, deps) {
  const id = v.uuid(operacaoId, "Operação");
  const ident = await lerIdentidade(deps);
  if (ident?.operacao_id === id && ms(ident.operacao_expira_em) > agoraDe(deps).getTime() && !ident.efeito_token) return ident;
  throw conflito("Esta operação de conexão não está mais ativa. Comece de novo.", "OPERACAO_INVALIDA");
}

// ---------------------------------------------------------------------------
// Auditoria (sem QR, sem segredo, sem telefone completo)
// ---------------------------------------------------------------------------

const ator = (autor) => ({ atorId: autor?.contaId ?? null, perfilId: autor?.perfilId ?? null, perfilNome: autor?.nome ?? null, atorEmail: autor?.email ?? null });
async function auditarConexao(acao, autor, detalhes, deps) {
  await (deps.auditar ?? auditar)({ ...ator(autor), acao, entidade: "whatsapp_conexoes", entidadeId: null, organizacaoId: orgId(deps), detalhes: { ...detalhes } });
}
const erroCurto = (e) => String(e?.message ?? e).replace(/BAILEYS_GATEWAY_HTTP_\d+: /, "").slice(0, 120);

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

/** GET /comunicacao/conexao — quem vê a Central vê o estado; o QR e as ações exigem permissão. */
export async function estado(autor, deps = {}) {
  const agora = agoraDe(deps);
  const svc = await servico(deps);
  const [dbCon, identidade, live, gerenciar] = await Promise.all([lerConexaoDb(deps).catch(() => null), lerIdentidade(deps).catch(() => null), statusVivo(svc), temPermissaoConexao(autor, deps)]);
  const estadoUi = derivarEstado({ live, db: dbCon, agora });
  const conectado = estadoUi === "CONNECTED";
  if (!conectado) _zerarCachePerfil();
  const perfil = conectado ? await perfilVivo(svc, deps, dbCon) : null;
  const telefoneAtual = perfil?.telefoneE164 ?? dbCon?.telefone_e164 ?? null;
  const stIdent = statusIdentidade({ conectado, identidade, telefoneAtual });
  const agente = stIdent === "CONFIRMADA" && identidade?.nome_operacional === NOME_AGENTE;
  const ultimoSinal = dbCon?.last_seen_at ?? null;
  const fresco = !!ultimoSinal && agora.getTime() - ms(ultimoSinal) <= HEARTBEAT_FRESCO_MS;
  const saude = conectado ? (fresco ? { id: "saudavel", rotulo: "Saudável" } : { id: "atencao", rotulo: "Atenção" }) : estadoUi === "RECONNECTING" ? { id: "atencao", rotulo: "Atenção" } : { id: "sem_sinal", rotulo: "Sem sinal" };
  // O id da operação só sai para quem GERENCIA (é o que permite retomar/cancelar o assistente); os demais nem veem que há uma operação.
  // INCERTO, ou EXECUTANDO parado além da janela de estabilização (a mesma da RPC): nunca uma operação normal em curso.
  const precisaReconciliar = identidade?.efeito_estado === "INCERTO" || (identidade?.efeito_estado === "EXECUTANDO" && agora.getTime() - ms(identidade.efeito_atualizado_em) >= JANELA_RECONCILIACAO_MS);
  const ativa = identidade?.operacao_id && (identidade.efeito_token || ms(identidade.operacao_expira_em) > agora.getTime()) ? {
    id: identidade.operacao_id, tipo: identidade.operacao_tipo, expiraEm: identidade.operacao_expira_em,
    efeitoEstado: identidade.efeito_estado ?? null, reconciliacaoNecessaria: precisaReconciliar,
    efeitoAcao: identidade.efeito_acao ?? null, incertoDesde: identidade.efeito_incerto_desde ?? null,
    ultimaVerificacaoEm: identidade.efeito_verificado_em ?? null, verificacoes: identidade.efeito_verificacoes ?? 0,
    ultimoResultado: identidade.efeito_ultimo_resultado ?? null, podeReconciliar: !!identidade.efeito_token,
  } : null;
  const motivo = live?.ultimoFechamento?.razao ? (MOTIVO_FECHAMENTO[live.ultimoFechamento.razao] ?? "Motivo não identificado") : null;

  return {
    estado: estadoUi, rotulo: ROTULO_ESTADO[estadoUi], conectado, reconectando: estadoUi === "RECONNECTING", semSinal: live === null,
    identidade: {
      status: stIdent, ambiente: identidade?.ambiente ?? "TESTE", ambienteRotulo: ROTULO_AMBIENTE[identidade?.ambiente ?? "TESTE"],
      nomeOperacional: stIdent === "CONFIRMADA" ? (identidade?.nome_operacional ?? null) : null, agenteCrescer: agente, confirmadoEm: stIdent === "CONFIRMADA" ? identidade?.confirmado_em ?? null : null,
    },
    conta: conectado ? {
      nome: perfil?.nome ?? null, iniciais: iniciais(perfil?.nome ?? "WhatsApp"), fotoUrl: perfil?.fotoUrl ?? null, telefoneMascarado: mascararTelefoneUi(telefoneAtual),
      tipoConta: perfil?.tipoConta ?? "DESCONHECIDO", tipoContaRotulo: ROTULO_TIPO_CONTA[perfil?.tipoConta ?? "DESCONHECIDO"], descricao: perfil?.descricao ?? null,
    } : null,
    saude: { ...saude, ultimoSinalEm: ultimoSinal, conectadoEm: conectado ? dbCon?.connected_at ?? null : null },
    tecnico: {
      gateway: live ? "Respondendo" : "Sem resposta", heartbeatEm: ultimoSinal,
      sessaoValida: dbCon?.lease_expires_at ? ms(dbCon.lease_expires_at) > agora.getTime() : null, socket: live ? (live.status === "CONNECTED" ? "Aberto" : "Fechado") : "Desconhecido",
      ultimaConexaoEm: dbCon?.connected_at ?? null, ultimaDesconexaoEm: dbCon?.disconnected_at ?? null, motivoUltimaDesconexao: motivo,
      versao: dbCon?.gateway_version ?? null, tentativasReconexao: live?.tentativasReconexao ?? 0,
    },
    permissoes: { gerenciar },
    operacao: gerenciar ? ativa : null,
    // Estado da reconciliação para QUALQUER usuário do painel (sem id de operação, sem token): quem só lê vê o aviso, mas não a ação.
    reconciliacao: precisaReconciliar ? { reconciliacaoNecessaria: true, acao: identidade.efeito_acao ?? null, incertoDesde: identidade.efeito_incerto_desde ?? identidade.efeito_atualizado_em ?? null, ultimaVerificacaoEm: identidade.efeito_verificado_em ?? null, ultimoResultado: identidade.efeito_ultimo_resultado ?? null, verificacoes: identidade.efeito_verificacoes ?? 0 } : null,
  };
}

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------

async function gatewayOuErro(deps) {
  const svc = await servico(deps);
  if (!svc?.conexaoConectar) throw conflito("A conexão do backend com o WhatsApp não está configurada.", "WHATSAPP_NAO_CONFIGURADO");
  return svc;
}

const jaEmAndamentoNoGateway = (e) => /already|em andamento|JA_CONECTADO|409/i.test(String(e?.message ?? ""));

/**
 * POST /comunicacao/conexao/reconciliar — "Rever estado da conexão". O operador só DISPARA a verificação: a decisão (CONCLUIDO / ABORTADO /
 * AINDA_INCERTO) é do banco, sob lock, a partir do snapshot da sessão gravado no PREPARAR e do estado vivo do Gateway consultado agora.
 * Não existe parâmetro que force sucesso. Idempotente: sem efeito pendente devolve JA_RESOLVIDO.
 */
export async function reconciliar(autor, deps = {}) {
  await exigirPermissao(autor, deps);
  const ident = await lerIdentidade(deps);
  if (!ident?.efeito_token) return { decisao: "JA_RESOLVIDO", motivo: "sem_efeito_pendente", estado: await estado(autor, deps) };
  const svc = deps.whatsAppService !== undefined ? deps.whatsAppService : await servico(deps).catch(() => null);
  const live = await statusVivo(svc);
  const estadoGw = live ? derivarEstado({ live, db: null, agora: agoraDe(deps) }) : null;
  let authGw = null;
  if (estadoGw === "CONNECTED") { try { const p = await svc.conexaoPerfil(); authGw = p?.disponivel ? p.authSessionId ?? null : null; } catch { authGw = null; } }
  const gatewayOk = !!live && (estadoGw !== "CONNECTED" || !!authGw);
  const { data, error } = await (deps.supabase ?? supabase).rpc("whatsapp_operacao_reconciliar", {
    p_organizacao_id: orgId(deps), p_provider_instance_id: INSTANCIA, p_operacao_id: ident.operacao_id, p_gateway_ok: gatewayOk,
    p_gateway_estado: gatewayOk ? estadoGw : null, p_gateway_auth_session_id: authGw, p_por: autor.perfilId ?? null,
  });
  if (error) throw ApiError.internal(error.message);
  const r = Array.isArray(data) ? data[0] : data;
  if (!r) throw ApiError.internal("Reconciliação sem resposta.");
  if (r.decisao === "RECUSADO") throw conflito("A operação mudou. Atualize a conexão.", "OPERACAO_INVALIDA");
  if (r.decisao !== "JA_RESOLVIDO") {
    await auditarConexao(ACOES.WHATSAPP_CONEXAO_RECONCILIADA, autor, { operacao_id: ident.operacao_id, acao: r.acao, decisao: r.decisao, motivo: r.motivo, gateway_estado: estadoGw }, deps);
    if (r.decisao !== "AINDA_INCERTO") _zerarCachePerfil();
  }
  return { decisao: r.decisao, motivo: r.motivo, estado: await estado(autor, deps) };
}

/** POST /comunicacao/conexao/iniciar — abre o pareamento (mesma rota /connect do Gateway) e devolve a operação para o assistente. */
export async function iniciar(autor, deps = {}, { revisar = false } = {}) {
  await exigirPermissao(autor, deps);
  const svc = await gatewayOuErro(deps);
  const atual = derivarEstado({ live: await statusVivo(svc), db: await lerConexaoDb(deps).catch(() => null), agora: agoraDe(deps) });
  if (atual === "CONNECTED" && !revisar) throw conflito("O WhatsApp já está conectado. Para usar outro número, escolha Trocar número.", "JA_CONECTADO");
  const operacaoId = await iniciarOperacao("CONECTAR", autor, deps);
  await auditarConexao(ACOES.WHATSAPP_CONEXAO_INICIADA, autor, { operacao_id: operacaoId, tipo: "conectar" }, deps);
  try { if (atual !== "CONNECTED") await executarEfeito(svc, operacaoId, "CONECTAR", deps); } catch (e) {
    if (!jaEmAndamentoNoGateway(e)) {
      await auditarConexao(ACOES.WHATSAPP_CONEXAO_FALHOU, autor, { operacao_id: operacaoId, etapa: "iniciar", erro: erroCurto(e) }, deps);
      await encerrarOperacao(operacaoId, deps);
      throw conflito("Não foi possível iniciar a conexão agora. Verifique o Gateway e tente de novo.", "CONEXAO_INDISPONIVEL");
    }
  }
  _zerarCachePerfil();
  return { operacaoId, expiraEm: new Date(agoraDe(deps).getTime() + TTL_OPERACAO_S * 1000).toISOString() };
}

const qrAuditados = new Set();
export function _zerarQrAuditados() { qrAuditados.clear(); }

/**
 * POST /comunicacao/conexao/novo-qr { operacaoId } — o QR expirou (o Baileys encerra o pareamento depois de ~2,5 min sem leitura): reabre o pareamento DENTRO da mesma operação
 * (mesma trava, mesma rota /connect do Gateway). Nunca cria uma segunda sessão: só reconecta se a conta ainda não está conectada.
 */
export async function novoQr({ operacaoId } = {}, autor, deps = {}) {
  await exigirPermissao(autor, deps);
  await verificarOperacao(operacaoId, deps);
  const svc = await gatewayOuErro(deps);
  const atual = derivarEstado({ live: await statusVivo(svc), db: null, agora: agoraDe(deps) });
  if (atual === "CONNECTED") throw conflito("O WhatsApp já está conectado. Confirme ou cancele a conta identificada.", "JA_CONECTADO");
  try {
    if (atual !== "DISCONNECTED") await executarEfeito(svc, operacaoId, "ENCERRAR", deps);
    await executarEfeito(svc, operacaoId, "CONECTAR", deps);
  } catch (e) {
    if (!jaEmAndamentoNoGateway(e)) {
      await auditarConexao(ACOES.WHATSAPP_CONEXAO_FALHOU, autor, { operacao_id: operacaoId, etapa: "novo_qr", erro: erroCurto(e) }, deps);
      throw conflito("Não foi possível gerar um novo QR Code agora. Tente de novo em instantes.", "CONEXAO_INDISPONIVEL");
    }
  }
  return { ok: true };
}

/**
 * GET /comunicacao/conexao/qr?operacaoId= — QR atual, SÓ para quem tem a permissão e só da operação vigente. Cache-Control: no-store (no controller).
 * A auditoria registra a ORDEM do QR gerado, nunca o valor. Ao conectar, o QR some da resposta na hora e o assistente segue para "WhatsApp identificado".
 */
export async function qr({ operacaoId } = {}, autor, deps = {}) {
  await exigirPermissao(autor, deps);
  await verificarOperacao(operacaoId, deps);
  const svc = await gatewayOuErro(deps);
  const [live, q] = await Promise.all([statusVivo(svc), svc.conexaoQr().catch(() => null)]);
  const estadoUi = derivarEstado({ live, db: null, agora: agoraDe(deps) });
  if (estadoUi === "CONNECTED") {
    const perfil = await perfilVivo(svc, deps);
    return { estado: estadoUi, rotulo: ROTULO_ESTADO[estadoUi], disponivel: false, svg: null, geradoEm: null, expiraEm: null, ordem: 0, segundosRestantes: 0, identificada: true, conta: contaVisivel(perfil) };
  }
  const valor = typeof q?.qr === "string" && q.qr ? q.qr : null;
  if (valor && q.geradoEm) {
    const chave = `${operacaoId}:${q.geradoEm}`;
    if (!qrAuditados.has(chave)) { qrAuditados.add(chave); if (qrAuditados.size > 500) qrAuditados.clear(); await auditarConexao(ACOES.WHATSAPP_QR_GERADO, autor, { operacao_id: operacaoId, ordem: q.ordem ?? null }, deps); }
  }
  const restante = valor && q?.expiraEm ? Math.max(0, Math.round((ms(q.expiraEm) - agoraDe(deps).getTime()) / 1000)) : 0;
  // O navegador recebe SÓ o desenho (SVG gerado no Gateway), nunca a string crua do QR. SVG ausente/estranho ⇒ `svg: null` (a tela explica; nada é inventado).
  const svg = valor && typeof q?.svg === "string" && q.svg.startsWith("<svg ") && q.svg.length < 300_000 ? q.svg : null;
  return { estado: estadoUi, rotulo: ROTULO_ESTADO[estadoUi], disponivel: !!valor, svg, geradoEm: valor ? q.geradoEm ?? null : null, expiraEm: valor ? q.expiraEm ?? null : null, ordem: valor ? q.ordem ?? 0 : 0, segundosRestantes: restante, identificada: false, conta: null };
}

function contaVisivel(perfil) {
  if (!perfil) return null;
  return {
    nome: perfil.nome ?? null, iniciais: iniciais(perfil.nome ?? "WhatsApp"), fotoUrl: perfil.fotoUrl ?? null, telefoneMascarado: mascararTelefoneUi(perfil.telefoneE164),
    tipoConta: perfil.tipoConta ?? "DESCONHECIDO", tipoContaRotulo: ROTULO_TIPO_CONTA[perfil.tipoConta ?? "DESCONHECIDO"], descricao: perfil.descricao ?? null,
  };
}

/** POST /comunicacao/conexao/confirmar { operacaoId, utilizarComoAgente?, ambiente? } — o operador confirma a conta identificada. */
export async function confirmar({ operacaoId, utilizarComoAgente, ambiente } = {}, autor, deps = {}) {
  await exigirPermissao(autor, deps);
  const ident = await verificarOperacao(operacaoId, deps);
  if (ambiente !== undefined && !AMBIENTES.includes(ambiente)) throw ApiError.badRequest("Ambiente inválido.", { codigo: "AMBIENTE_INVALIDO" });
  const svc = await gatewayOuErro(deps);
  const conexaoEsperada = await lerConexaoDb(deps);
  const live = await statusVivo(svc);
  if (derivarEstado({ live, db: null, agora: agoraDe(deps) }) !== "CONNECTED") throw conflito("O WhatsApp ainda não está conectado. Escaneie o QR Code primeiro.", "NAO_CONECTADO");
  _zerarCachePerfil();
  const perfil = await perfilVivo(svc, deps);
  // Confirmar exige a identidade lida agora do Gateway; heartbeat antigo não prova a conta atual.
  const telefone = perfil?.telefoneE164 ?? null;
  if (!telefone) throw conflito("Não foi possível identificar a conta conectada. Tente novamente.", "SEM_IDENTIDADE");
  if (!perfil.authSessionId || perfil.authSessionId !== conexaoEsperada?.auth_session_id)
    throw conflito("A sessão mudou durante a identificação. Atualize a conexão.", "OPERACAO_INVALIDA");
  const agente = utilizarComoAgente === true;
  const amb = ambiente ?? ident?.ambiente ?? "TESTE";
  const { data: confirmou, error } = await (deps.supabase ?? supabase).rpc("whatsapp_confirmar_identidade_operacao", {
    p_organizacao_id: orgId(deps), p_provider_instance_id: INSTANCIA, p_operacao_id: operacaoId,
    p_telefone_hash: hashTelefone(telefone), p_auth_session_id: perfil.authSessionId,
    p_ambiente: amb, p_nome_operacional: agente ? NOME_AGENTE : null, p_por: autor.perfilId ?? null,
  });
  if (error) throw ApiError.internal(error.message);
  if (confirmou !== true) throw conflito("A operação ou a conta mudou. Atualize a conexão antes de confirmar.", "OPERACAO_INVALIDA");
  await auditarConexao(ACOES.WHATSAPP_CONECTADO, autor, { operacao_id: operacaoId, telefone_mascarado: mascararTelefoneUi(telefone), ambiente: amb, agente_crescer: agente, tipo_conta: perfil?.tipoConta ?? "DESCONHECIDO" }, deps);
  return estado(autor, deps);
}

async function limparIdentidade(deps, operacaoId) {
  const { data, error } = await (deps.supabase ?? supabase).from("whatsapp_identidade")
    .update({ status: "SEM_CONTA", telefone_hash: null, nome_operacional: null, confirmado_em: null, confirmado_por: null, identificado_em: null })
    .eq("organizacao_id", orgId(deps)).eq("provider_instance_id", INSTANCIA).eq("operacao_id", operacaoId).select("organizacao_id").maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data) throw conflito("Operação substituída.", "OPERACAO_INVALIDA");
}

/** POST /comunicacao/conexao/cancelar { operacaoId } — cancela o pareamento OU a confirmação (desfaz a sessão criada pelo QR). */
export async function cancelar({ operacaoId } = {}, autor, deps = {}) {
  await exigirPermissao(autor, deps);
  await verificarOperacao(operacaoId, deps);
  const svc = await gatewayOuErro(deps);
  const live = await statusVivo(svc);
  const estadoUi = derivarEstado({ live, db: null, agora: agoraDe(deps) });
  try {
    if (estadoUi === "CONNECTED") {
      await executarEfeito(svc, operacaoId, "DESCONECTAR", deps);
      await limparIdentidade(deps, operacaoId);
      await auditarConexao(ACOES.WHATSAPP_DESCONECTADO, autor, { operacao_id: operacaoId, motivo: "confirmacao_cancelada" }, deps);
    } else {
      if (estadoUi !== "DISCONNECTED") await executarEfeito(svc, operacaoId, "ENCERRAR", deps);
      await auditarConexao(ACOES.WHATSAPP_CONEXAO_FALHOU, autor, { operacao_id: operacaoId, etapa: "assistente", motivo: "cancelada_pelo_operador" }, deps);
    }
  } catch (e) {
    await auditarConexao(ACOES.WHATSAPP_CONEXAO_FALHOU, autor, { operacao_id: operacaoId, etapa: "cancelar", erro: erroCurto(e) }, deps);
    throw conflito("Não foi possível cancelar agora. Tente de novo.", "CANCELAR_FALHOU");
  } finally { await encerrarOperacao(operacaoId, deps); _zerarCachePerfil(); }
  return estado(autor, deps);
}

/** POST /comunicacao/conexao/desconectar { confirmacaoExplicita } — remove SÓ a sessão do Gateway e a identidade interna. NUNCA apaga histórico. */
export async function desconectar({ confirmacaoExplicita } = {}, autor, deps = {}) {
  await exigirPermissao(autor, deps);
  if (confirmacaoExplicita !== true) throw ApiError.badRequest("Confirmação explícita obrigatória para desconectar o WhatsApp.", { codigo: "CONFIRMACAO_OBRIGATORIA" });
  const svc = await gatewayOuErro(deps);
  const operacaoId = await iniciarOperacao("DESCONECTAR", autor, deps);
  const dbCon = await lerConexaoDb(deps).catch(() => null);
  try {
    await executarEfeito(svc, operacaoId, "DESCONECTAR", deps);
    await limparIdentidade(deps, operacaoId);
    await auditarConexao(ACOES.WHATSAPP_DESCONECTADO, autor, { operacao_id: operacaoId, motivo: "operador", telefone_mascarado: mascararTelefoneUi(dbCon?.telefone_e164) }, deps);
  } catch (e) {
    await auditarConexao(ACOES.WHATSAPP_CONEXAO_FALHOU, autor, { operacao_id: operacaoId, etapa: "desconectar", erro: erroCurto(e) }, deps);
    throw conflito("Resultado da desconexão não confirmado. A operação permanece protegida; verifique a sessão e reconcilie antes de tentar novamente.", "DESCONECTAR_FALHOU");
  } finally { await encerrarOperacao(operacaoId, deps); _zerarCachePerfil(); }
  return estado(autor, deps);
}

/**
 * POST /comunicacao/conexao/trocar { confirmacaoExplicita } — sequência SEGURA: confirma intenção → desconecta a conta atual → gera QR. A trava de operação é mantida (o assistente
 * segue com o MESMO operacaoId até confirmar); duas sessões concorrentes são impossíveis (o reset termina antes do connect).
 */
export async function trocar({ confirmacaoExplicita } = {}, autor, deps = {}) {
  await exigirPermissao(autor, deps);
  if (confirmacaoExplicita !== true) throw ApiError.badRequest("Confirmação explícita obrigatória para trocar o número.", { codigo: "CONFIRMACAO_OBRIGATORIA" });
  const svc = await gatewayOuErro(deps);
  const operacaoId = await iniciarOperacao("TROCAR", autor, deps);
  const dbCon = await lerConexaoDb(deps).catch(() => null);
  await auditarConexao(ACOES.WHATSAPP_CONEXAO_INICIADA, autor, { operacao_id: operacaoId, tipo: "trocar" }, deps);
  try {
    await executarEfeito(svc, operacaoId, "DESCONECTAR", deps);
    await limparIdentidade(deps, operacaoId);
    await auditarConexao(ACOES.WHATSAPP_DESCONECTADO, autor, { operacao_id: operacaoId, motivo: "troca_de_numero", telefone_mascarado: mascararTelefoneUi(dbCon?.telefone_e164) }, deps);
    _zerarCachePerfil();
    await executarEfeito(svc, operacaoId, "CONECTAR", deps);
  } catch (e) {
    await auditarConexao(ACOES.WHATSAPP_CONEXAO_FALHOU, autor, { operacao_id: operacaoId, etapa: "trocar", erro: erroCurto(e) }, deps);
    await encerrarOperacao(operacaoId, deps);
    throw conflito("Resultado da troca não confirmado. Verifique a sessão e reconcilie a operação antes de continuar.", "TROCAR_FALHOU");
  }
  return { operacaoId, expiraEm: new Date(agoraDe(deps).getTime() + TTL_OPERACAO_S * 1000).toISOString() };
}

/** PUT /comunicacao/conexao/identidade { ambiente?, agenteCrescer? } — identidade INTERNA (separada do número). */
export async function definirIdentidade({ ambiente, agenteCrescer } = {}, autor, deps = {}) {
  await exigirPermissao(autor, deps);
  if (ambiente !== undefined && !AMBIENTES.includes(ambiente)) throw ApiError.badRequest("Ambiente inválido.", { codigo: "AMBIENTE_INVALIDO" });
  if (agenteCrescer !== undefined && typeof agenteCrescer !== "boolean") throw ApiError.badRequest("Valor inválido.", { codigo: "VALOR_INVALIDO" });
  const atual = await estado(autor, deps);
  const campos = {};
  if (ambiente !== undefined) campos.ambiente = ambiente;
  if (agenteCrescer !== undefined) {
    if (atual.identidade.status !== "CONFIRMADA") throw conflito("Só uma conta conectada e confirmada pode ser marcada como Agente Crescer.", "CONTA_NAO_CONFIRMADA");
    campos.nome_operacional = agenteCrescer ? NOME_AGENTE : null;
  }
  if (!Object.keys(campos).length) return atual;
  await salvarIdentidade(campos, deps);
  await auditarConexao(ACOES.WHATSAPP_IDENTIDADE_DEFINIDA, autor, { ambiente: ambiente ?? null, agente_crescer: agenteCrescer ?? null }, deps);
  return estado(autor, deps);
}
