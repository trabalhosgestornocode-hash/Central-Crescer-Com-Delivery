// CENTRAL DE COMUNICAÇÃO — conversas com responsáveis autorizados (Painel Administrativo).
//
// Quatro regras estruturais (todas testadas em test/central-*.test.js):
//   1. QUEM APARECE é decidido AQUI, no servidor, pelo roster (comunicacao.roster.js). Um contato fora do roster não tem conversa, não aparece na lista,
//      não aparece na busca e não abre por id (404). O frontend nunca decide.
//   2. NADA de telefone completo sai daqui (só `********NN`). A busca é por NOME de responsável/empresa/unidade — nunca por telefone.
//   3. O ENVIO MANUAL não é um segundo pipeline: passa pelos MESMOS gates do teste controlado (consentimento, verificação, opt-out, piloto, Gateway) e
//      pelo mesmo outbox/RPCs fenced/recibos (comunicacao.manual.js). Idempotente por `envioId`; ator humano auditado. FAIL-CLOSED.
//   4. "Enviada" NUNCA é "entregue": o status vem do outbox (SENT ≠ DELIVERED ≠ READ).
//
// Atualização ao vivo: o Realtime existente é por tenant (`empresa:`/`unidade:`) e o Painel Administrativo não tem esse contexto; por isso a tela
// consulta `atualizacoes()` (um cursor barato) em vez de recarregar listas — ver a decisão registrada em docs/comunicacao-central-conversas.md.

import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import * as repo from "./administrativo.comunicacao.repo.js";
import { origemDaMensagem, mascararTelefoneUi, configuracaoOperacional } from "./administrativo.comunicacao.central.js";
import * as service from "./administrativo.comunicacao.service.js";
import * as conexao from "./administrativo.comunicacao.conexao.js";
import { pendencias as lerPendenciasReal } from "./administrativo.service.js";
import * as rosterRepo from "../comunicacao/comunicacao.roster.js";
import { normalizarBusca, iniciais } from "../comunicacao/comunicacao.roster.js";
import * as inboxRepo from "../comunicacao/comunicacao.inbox.repo.js";
import { metricasInbox } from "../comunicacao/comunicacao.inbox.service.js";
import * as centralRepo from "../comunicacao/comunicacao.central.repo.js";
import { telefoneAutorizadoNoPiloto } from "../comunicacao/comunicacao.piloto.js";
import { criarWhatsAppServiceDoAmbiente } from "../comunicacao/comunicacao.teste.js";
import { enviarMensagemManual, normalizarTextoManual, chaveIdempotenciaManual } from "../comunicacao/comunicacao.manual.js";
import { JANELA_REFORCO, CUTOFF_REFORCO, ESPACAMENTO_MINIMO_HORAS } from "../comunicacao/comunicacao.reforco.js";
import { modoAtual } from "../comunicacao/comunicacao.config.js";
import { STATUS_MENSAGEM } from "../comunicacao/comunicacao.constants.js";

const HORA = 3_600_000;
const DIA = 24 * HORA;
export const FILTROS_CONVERSA = Object.freeze(["todas", "nao_lidas", "pendencias", "automacao", "humano"]);
export const JANELA_PADRAO_HORAS = 24;
const JANELA_MAX_HORAS = 30 * 24;                 // a retenção do texto recebido (padrão 30 dias)
const FOTO_TTL_MS = 6 * HORA;                     // a URL da foto expira: renovamos de tempos em tempos
const FOTO_SEM_FOTO_MS = DIA;                     // sem foto / privacidade: não perguntar de novo ao WhatsApp por 24h
const FOTO_FALHA_MS = 15 * 60_000;                // falha transitória: tentar de novo em 15 min

const CATEGORIA_POR_ORIGEM = Object.freeze({ manual_painel: "manual", teste_controlado: "teste", automacao: "automatica", reforco: "automatica", aviso_tardio: "automatica" });
const ORIGENS_AUTOMATICAS = new Set(["automacao", "reforco", "aviso_tardio"]);

const conflito = (msg, codigo) => new ApiError(409, msg, { codigo });
const agoraDe = (deps) => (typeof deps.agora === "function" ? deps.agora() : new Date());
const envDe = (deps) => deps.env ?? process.env;
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
const conexaoOrgId = (deps) => deps.organizacaoConexaoId ?? envDe(deps).WHATSAPP_GATEWAY_ORGANIZACAO_ID ?? null;

/** Início do dia no Brasil (UTC-3 fixo: o país não tem horário de verão desde 2019), em ISO UTC. */
export function inicioDoDiaBrasil(agora = new Date()) {
  const local = new Date(agora.getTime() - 3 * HORA);
  return `${local.toISOString().slice(0, 10)}T03:00:00.000Z`;
}

/** Prévia de uma linha só (para a lista e o histórico). Nunca mais que `max` caracteres. */
export function previa(texto, max = 90) {
  const t = String(texto ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(t);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : t;
}

// ---------------------------------------------------------------------------
// Projeções
// ---------------------------------------------------------------------------

function projetarSaida(m) {
  const origem = origemDaMensagem(m);
  const em = m.status === STATUS_MENSAGEM.SCHEDULED ? m.disponivel_em : (m.enviado_em ?? m.created_at);
  return {
    id: m.id, direcao: "saida", categoria: CATEGORIA_POR_ORIGEM[origem] ?? "automatica", origem, tipo: "texto", texto: m.conteudo ?? "",
    status: m.status, em, criadoEm: m.created_at, agendadoPara: m.status === STATUS_MENSAGEM.SCHEDULED ? m.disponivel_em : null,
    enviadoEm: m.enviado_em ?? null, entregueEm: m.entregue_em ?? null, lidoEm: m.lido_em ?? null, falhouEm: m.falhou_em ?? null,
    erro: m.erro ? String(m.erro).slice(0, 200) : null, operador: m.metadados?.ator_nome ? String(m.metadados.ator_nome).slice(0, 80) : null,
    envioId: typeof m.metadados?.envio_id === "string" ? m.metadados.envio_id : null,
  };
}

const projetarEntrada = (m) => ({
  id: m.id, direcao: "entrada", categoria: "recebida", origem: "contato", tipo: m.tipo_conteudo, texto: m.texto ?? null, status: null, em: m.recebido_em,
  criadoEm: m.recebido_em, enviadoEm: null, entregueEm: null, lidoEm: null, falhouEm: null, erro: null, operador: null,
});

const porEm = (a, b) => ms(a.em) - ms(b.em);

/** Foto utilizável agora (cache dentro do TTL) ou null — a interface cai no avatar de iniciais. */
function fotoVigente(cache, agora) {
  if (!cache?.foto_url || !cache.foto_atualizada_em) return null;
  return agora.getTime() - ms(cache.foto_atualizada_em) < FOTO_TTL_MS + HORA ? cache.foto_url : null;
}

const previaDe = (msg) => (msg.tipo === "midia" ? "Mídia recebida" : previa(msg.texto));

function pendenciasPorOrg(snapshot) {
  const mapa = new Map();
  for (const u of snapshot?.unidades ?? []) {
    if (u.criticidade !== "critico" && u.criticidade !== "atencao") continue;
    mapa.set(u.organizacaoId, (mapa.get(u.organizacaoId) ?? 0) + 1);
  }
  return mapa;
}

/** Cabeçalho comum (lista e contexto): identidade do responsável e vínculos. Só telefone MASCARADO. */
function baseContato(c, { fotoUrl, pendPorOrg }) {
  return {
    contatoId: c.contatoId, nome: c.nome, iniciais: iniciais(c.nome), fotoUrl: fotoUrl ?? null, cargo: c.cargo,
    telefoneMascarado: mascararTelefoneUi(c.telefoneE164),
    empresas: c.organizacoes.map((o) => ({ organizacaoId: o.organizacaoId, nome: o.nome, pendenciasAtuais: pendPorOrg.get(o.organizacaoId) ?? 0 })),
    unidades: c.unidades.map((u) => ({ unidadeId: u.unidadeId, nome: u.nome, organizacaoId: u.organizacaoId })),
    consentimento: c.consentimento, verificado: c.verificado, optOut: c.optOut,
    pendenciasAtuais: c.organizacoes.reduce((s, o) => s + (pendPorOrg.get(o.organizacaoId) ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Lista de conversas
// ---------------------------------------------------------------------------

/** Junta roster + inbox + outbox em UMA linha por contato (fonte de "última mensagem", não lidas e atividade nas últimas 24h). */
async function montarConversas(deps) {
  const agora = agoraDe(deps);
  const desde30 = new Date(agora.getTime() - JANELA_MAX_HORAS * HORA).toISOString();
  const roster = await (deps.roster ?? rosterRepo).listarRoster(deps);
  const ids = roster.map((c) => c.contatoId);
  const orgConexao = conexaoOrgId(deps);
  const [resumo, saidas, fotos, pend] = await Promise.all([
    orgConexao ? inboxRepo.resumoPorContato(orgConexao, deps) : [],
    centralRepo.listarSaidasRecentes({ contatoIds: ids, desde: desde30 }, deps),
    centralRepo.obterFotos(ids, deps),
    (deps.lerPendencias ?? lerPendenciasReal)({}, deps).catch(() => ({ unidades: [] })),
  ]);
  const pendPorOrg = pendenciasPorOrg(pend);
  const resumoPorContato = new Map(resumo.map((r) => [r.contato_id, r]));
  const saidasPorContato = new Map();
  for (const m of saidas) { if (!saidasPorContato.has(m.contato_id)) saidasPorContato.set(m.contato_id, []); saidasPorContato.get(m.contato_id).push(projetarSaida(m)); }

  const limite24h = agora.getTime() - DIA;
  const itens = roster.map((c) => {
    const r = resumoPorContato.get(c.contatoId);
    const s = (saidasPorContato.get(c.contatoId) ?? []).sort(porEm);
    const ultimaSaida = s[s.length - 1] ?? null;
    const ultimaEntrada = r ? { em: r.ultima_recebida_em, texto: r.ultima_texto, tipo: r.ultimo_tipo === "midia" ? "midia" : "texto" } : null;
    const entradaMaisNova = ultimaEntrada && (!ultimaSaida || ms(ultimaEntrada.em) >= ms(ultimaSaida.em));
    const ultima = entradaMaisNova
      ? { direcao: "entrada", categoria: "recebida", previa: previaDe(ultimaEntrada), em: ultimaEntrada.em, status: null }
      : ultimaSaida ? { direcao: "saida", categoria: ultimaSaida.categoria, previa: previa(ultimaSaida.texto), em: ultimaSaida.em, status: ultimaSaida.status } : null;
    const recentes = s.filter((m) => ms(m.em) >= limite24h);
    const automacao24h = recentes.some((m) => m.categoria === "automatica");
    const humano24h = recentes.some((m) => m.categoria === "manual") || (!!ultimaEntrada && ms(ultimaEntrada.em) >= limite24h);
    return {
      ...baseContato(c, { fotoUrl: fotoVigente(fotos.get(c.contatoId), agora), pendPorOrg }),
      ultimaMensagem: ultima, naoLidas: r?.nao_lidas ?? 0, ultimaAtividadeEm: ultima?.em ?? null, ultimaEntradaEm: ultimaEntrada?.em ?? null, automacao24h, humano24h,
      whatsappConfirmado: !!ultimaEntrada || s.some((m) => !!m.entregueEm),
    };
  });
  return { itens, agora };
}

const combina = (c, termo) => normalizarBusca(c.nome).includes(termo)
  || c.empresas.some((e) => normalizarBusca(e.nome).includes(termo))
  || c.unidades.some((u) => normalizarBusca(u.nome).includes(termo));

/**
 * GET /comunicacao/conversas?filtro=&busca=
 * Sem busca: só quem tem atividade nos últimos 30 dias (uma "caixa de entrada"). Com busca: qualquer responsável do roster que case por NOME de
 * responsável/empresa/unidade — nunca por telefone.
 */
export async function listarConversas({ filtro = "todas", busca } = {}, deps = {}) {
  if (!FILTROS_CONVERSA.includes(filtro)) throw ApiError.badRequest("Filtro inválido.", { codigo: "FILTRO_INVALIDO" });
  const { itens } = await montarConversas(deps);
  const termo = normalizarBusca(busca);
  const base = termo ? itens.filter((c) => combina(c, termo)) : itens.filter((c) => c.ultimaAtividadeEm);
  const totais = {
    todas: base.length, naoLidas: base.filter((c) => c.naoLidas > 0).length, pendencias: base.filter((c) => c.pendenciasAtuais > 0).length,
    automacao: base.filter((c) => c.automacao24h).length, humano: base.filter((c) => c.humano24h).length,
  };
  const passa = { todas: () => true, nao_lidas: (c) => c.naoLidas > 0, pendencias: (c) => c.pendenciasAtuais > 0, automacao: (c) => c.automacao24h, humano: (c) => c.humano24h }[filtro];
  const lista = base.filter(passa).sort((a, b) => (ms(b.ultimaAtividadeEm) - ms(a.ultimaAtividadeEm)) || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
  return { itens: lista, totais, filtro, cursor: formatarCursor(await centralRepo.lerCursoresAtuais(deps)) };
}

// ---------------------------------------------------------------------------
// Gates do envio (compartilhados entre "pode enviar?" da tela e o envio em si)
// ---------------------------------------------------------------------------

const MENSAGENS_GATE = Object.freeze({
  SEM_CONSENTIMENTO: "Este responsável ainda não teve o consentimento confirmado.",
  NAO_VERIFICADO: "O número deste responsável ainda não foi verificado.",
  OPT_OUT: "Este responsável pediu para não receber mensagens.",
  FORA_DA_ALLOWLIST: "Este número não está autorizado pelo piloto neste servidor.",
  GATEWAY_INDISPONIVEL: "O WhatsApp não está conectado no momento.",
  CONEXAO_NAO_CONFIRMADA: "A conta do WhatsApp conectada ainda não foi confirmada. Confirme a conta na aba Conexão antes de enviar.",
  WHATSAPP_NAO_CONFIGURADO: "A conexão do backend com o WhatsApp não está configurada.",
});

async function avaliarGatesManual(contato, deps) {
  const env = envDe(deps);
  const gateway = deps.estadoGateway !== undefined ? deps.estadoGateway : await repo.obterEstadoGateway(deps);
  const configurado = deps.whatsAppService !== undefined ? !!deps.whatsAppService : (!!String(env.WHATSAPP_GATEWAY_URL ?? "").trim() && !!String(env.WHATSAPP_GATEWAY_SECRET ?? "").trim());
  const codigos = [];
  if (contato.consentimento !== true) codigos.push("SEM_CONSENTIMENTO");
  if (contato.verificado !== true) codigos.push("NAO_VERIFICADO");
  if (contato.optOut !== false) codigos.push("OPT_OUT");
  if (!telefoneAutorizadoNoPiloto(contato.telefoneE164, env)) codigos.push("FORA_DA_ALLOWLIST");
  if (gateway?.estado !== "conectado") codigos.push("GATEWAY_INDISPONIVEL");
  // A conta conectada precisa ser a que o operador CONFIRMOU na aba Conexão (outro número, ou conta pendente, nunca envia). Só banco; fail-closed.
  const confirmada = deps.identidadeConfirmada !== undefined ? deps.identidadeConfirmada : await conexao.identidadeConfirmada(deps);
  if (confirmada !== true) codigos.push("CONEXAO_NAO_CONFIRMADA");
  if (!configurado) codigos.push("WHATSAPP_NAO_CONFIGURADO");
  return { bloqueios: codigos.map((codigo) => ({ codigo, mensagem: MENSAGENS_GATE[codigo] })), gateway };
}

// ---------------------------------------------------------------------------
// Foto de perfil (cache com TTL; nunca bloqueia nem quebra a tela)
// ---------------------------------------------------------------------------

const fotosEmAndamento = new Set();

/**
 * Atualiza a foto em SEGUNDO PLANO quando o cache venceu. Não espera, não lança, uma consulta por contato por vez. O resultado aparece na próxima
 * atualização da tela. Sem foto/privacidade ⇒ registra "sem foto" por 24h; falha transitória ⇒ tenta de novo em 15 min (sem apagar a foto atual).
 */
export function agendarAtualizacaoFoto(contato, cache, deps = {}) {
  const agora = agoraDe(deps).getTime();
  if (cache?.foto_indisponivel_ate && ms(cache.foto_indisponivel_ate) > agora) return null;
  if (cache?.foto_url && cache.foto_atualizada_em && agora - ms(cache.foto_atualizada_em) < FOTO_TTL_MS) return null;
  if (fotosEmAndamento.has(contato.contatoId)) return null;
  fotosEmAndamento.add(contato.contatoId);
  return (async () => {
    try {
      const servico = deps.whatsAppService !== undefined ? deps.whatsAppService : await criarWhatsAppServiceDoAmbiente(envDe(deps));
      if (!servico?.buscarFotoPerfil) return;
      const r = await servico.buscarFotoPerfil({ telefoneE164: contato.telefoneE164 });
      const t = agoraDe(deps);
      if (r?.url) await centralRepo.salvarFoto({ contatoId: contato.contatoId, url: r.url, atualizadaEm: t.toISOString(), indisponivelAte: null }, deps);
      else if (r?.motivo === "sem_foto") await centralRepo.salvarFoto({ contatoId: contato.contatoId, url: null, atualizadaEm: t.toISOString(), indisponivelAte: new Date(t.getTime() + FOTO_SEM_FOTO_MS).toISOString() }, deps);
      else await centralRepo.salvarFoto({ contatoId: contato.contatoId, indisponivelAte: new Date(t.getTime() + FOTO_FALHA_MS).toISOString() }, deps);
    } catch { /* a foto é cosmética: falhar aqui nunca afeta a conversa */ } finally { fotosEmAndamento.delete(contato.contatoId); }
  })();
}

// ---------------------------------------------------------------------------
// Uma conversa
// ---------------------------------------------------------------------------

function contextoDaConversa(c, ctx) {
  const { fotoUrl, pendPorOrg, saidas, entradas } = ctx;
  const automaticas = saidas.filter((m) => m.categoria === "automatica");
  const manuais = saidas.filter((m) => m.categoria === "manual");
  const ultimaAuto = automaticas[automaticas.length - 1] ?? null;
  const humanas = [...manuais, ...entradas].sort(porEm);
  const ultimaHumana = humanas[humanas.length - 1] ?? null;
  return {
    ...baseContato(c, { fotoUrl, pendPorOrg }),
    ultimaAutomatica: ultimaAuto ? { em: ultimaAuto.em, previa: previa(ultimaAuto.texto), status: ultimaAuto.status } : null,
    ultimaHumana: ultimaHumana ? { em: ultimaHumana.em, direcao: ultimaHumana.direcao, previa: previaDe(ultimaHumana), operador: ultimaHumana.operador } : null,
  };
}

/**
 * GET /comunicacao/conversas/:contatoId?horas=24 — a conversa (entradas + saídas manuais/automáticas/teste em ordem cronológica) e o contexto.
 * `horas` limitado a 1..720 (a retenção do texto). Não depende de sincronizar histórico do WhatsApp nem reativa recovery.
 */
export async function obterConversa({ contatoId, horas = JANELA_PADRAO_HORAS, antes } = {}, autor, deps = {}) {
  const id = v.uuid(contatoId, "Conversa");
  const janelaHoras = Math.min(JANELA_MAX_HORAS, Math.max(1, Math.trunc(Number(horas)) || JANELA_PADRAO_HORAS));
  const contato = await (deps.roster ?? rosterRepo).buscarAutorizadoPorId(id, deps);
  if (!contato) throw ApiError.notFound("Conversa não encontrada.");   // desconhecido e inexistente são indistinguíveis de propósito

  const agora = agoraDe(deps);
  const desde = new Date(agora.getTime() - janelaHoras * HORA).toISOString();
  const desde30 = new Date(agora.getTime() - JANELA_MAX_HORAS * HORA).toISOString();
  let cursorPagina = null;
  if (antes) {
    try {
      cursorPagina = JSON.parse(Buffer.from(String(antes), "base64url").toString("utf8"));
      if (String(antes).length > 600 || cursorPagina.contatoId !== id || !["entrada", "saida"].includes(cursorPagina.direcao) || !Number.isFinite(Date.parse(cursorPagina.em))) throw new Error();
      v.uuid(cursorPagina.id, "Cursor");
    } catch { throw ApiError.badRequest("Cursor de histórico inválido.", { codigo: "CURSOR_INVALIDO" }); }
  }
  const [linhas, fotos, pend, gates] = await Promise.all([
    centralRepo.paginaConversa({ organizacaoId: conexaoOrgId(deps), contatoId: id, desde: desde30, antes: cursorPagina }, deps),
    centralRepo.obterFotos([id], deps),
    (deps.lerPendencias ?? lerPendenciasReal)({}, deps).catch(() => ({ unidades: [] })),
    avaliarGatesManual(contato, deps),
  ]);
  const visiveis = linhas.filter((m) => cursorPagina || ms(m.em) >= ms(desde) || m.registro.status === STATUS_MENSAGEM.SCHEDULED);
  const pagina = visiveis.slice(0, 200);
  const temMaisAntigas = linhas.length > pagina.length;
  const ultimo = pagina.at(-1) ?? { em: desde, direcao: "saida", id: "ffffffff-ffff-4fff-bfff-ffffffffffff" };
  const proximaPagina = temMaisAntigas ? Buffer.from(JSON.stringify({ em: ultimo.em, direcao: ultimo.direcao, id: ultimo.id, contatoId: id })).toString("base64url") : null;
  const todas = pagina.map((m) => m.direcao === "entrada" ? projetarEntrada(m.registro) : projetarSaida(m.registro)).reverse();
  const entradas = todas.filter((m) => m.direcao === "entrada");
  const saidas = todas.filter((m) => m.direcao === "saida");
  const cache = fotos.get(id);
  agendarAtualizacaoFoto(contato, cache, deps);

  const ator = autor ?? {};
  await (deps.auditar ?? auditar)({
    atorId: ator.contaId ?? null, perfilId: ator.perfilId ?? null, perfilNome: ator.nome ?? null, atorEmail: ator.email ?? null,
    acao: ACOES.COMUNICACAO_CONVERSA_ABERTA, entidade: "contatos_whatsapp", entidadeId: id, organizacaoId: contato.organizacoes[0]?.organizacaoId ?? null,
    detalhes: { telefone_mascarado: mascararTelefoneUi(contato.telefoneE164), janela_horas: janelaHoras },
  });

  return {
    contato: { ...contextoDaConversa(contato, { fotoUrl: fotoVigente(cache, agora), pendPorOrg: pendenciasPorOrg(pend), saidas, entradas }), whatsappConfirmado: entradas.length > 0 || saidas.some((m) => !!m.entregueEm) },
    mensagens: todas,
    janelaHoras, temMaisAntigas, proximaPagina,
    envio: { podeEnviar: gates.bloqueios.length === 0, bloqueios: gates.bloqueios, maxCaracteres: 4096 },
    cursor: formatarCursor(await centralRepo.lerCursoresAtuais(deps)),
  };
}

/** POST /comunicacao/conversas/:contatoId/lida  { ate? } — marca a conversa como lida até o instante da última mensagem que a tela MOSTROU. */
export async function marcarLida({ contatoId, ate } = {}, autor, deps = {}) {
  const id = v.uuid(contatoId, "Conversa");
  if (!(await (deps.roster ?? rosterRepo).buscarAutorizadoPorId(id, deps))) throw ApiError.notFound("Conversa não encontrada.");
  const agora = agoraDe(deps);
  let instante = agora.toISOString();
  if (ate !== undefined && ate !== null && ate !== "") {
    const t = Date.parse(String(ate));
    if (!Number.isFinite(t)) throw ApiError.badRequest("Instante inválido.", { codigo: "PERIODO_INVALIDO" });
    instante = new Date(Math.min(t, agora.getTime() + 60_000)).toISOString();   // nunca "lê" o futuro
  }
  await inboxRepo.marcarLida({ organizacaoId: conexaoOrgId(deps), contatoId: id, ate: instante, porPerfilId: autor?.perfilId ?? null }, deps);
  return { ok: true, lidaAte: instante };
}

// ---------------------------------------------------------------------------
// Envio manual
// ---------------------------------------------------------------------------

/**
 * POST /comunicacao/conversas/:contatoId/mensagens  { envioId, texto, organizacaoId?, unidadeId? }
 * `envioId` (UUID) nasce na TELA ao começar a escrever: duplo clique / reenvio = MESMO envioId = UMA mensagem. FAIL-CLOSED em qualquer gate.
 */
export async function enviarMensagem({ contatoId, envioId, texto, organizacaoId, unidadeId } = {}, autor, deps = {}) {
  if (!autor?.contaId) throw ApiError.unauthorized("Operador não identificado.");
  const id = v.uuid(contatoId, "Conversa");
  const eid = v.uuid(envioId, "Envio");
  const limpo = normalizarTextoManual(texto);
  if (limpo === null) throw ApiError.badRequest("Escreva uma mensagem de até 4096 caracteres.", { codigo: "TEXTO_INVALIDO" });

  const existente = async () => repo.obterMensagemPorChave(chaveIdempotenciaManual(eid), deps);
  const repetido = await existente();
  if (repetido) return { mensagemId: repetido.id, status: repetido.status, resultado: "JA_EXISTIA", jaExistia: true };

  const contato = await (deps.roster ?? rosterRepo).buscarAutorizadoPorId(id, deps);
  if (!contato) throw ApiError.notFound("Conversa não encontrada.");

  const { bloqueios } = await avaliarGatesManual(contato, deps);
  if (bloqueios.length) {
    const corrida = await existente();   // uma corrida com a MESMA chave pode ter criado a mensagem entre a checagem acima e agora
    if (corrida) return { mensagemId: corrida.id, status: corrida.status, resultado: "JA_EXISTIA", jaExistia: true };
    throw conflito(bloqueios[0].mensagem, bloqueios[0].codigo);
  }

  // Empresa/unidade do registro: a informada (se pertence a ESTE responsável) ou a primeira; unidade só quando não há ambiguidade.
  let org = contato.organizacoes[0];
  if (organizacaoId) {
    org = contato.organizacoes.find((o) => o.organizacaoId === organizacaoId);
    if (!org) throw ApiError.badRequest("Empresa não pertence a este responsável.", { codigo: "EMPRESA_INVALIDA" });
  }
  const unidadesDaOrg = contato.unidades.filter((u) => u.organizacaoId === org.organizacaoId);
  let unidade = unidadesDaOrg.length === 1 ? unidadesDaOrg[0] : null;
  if (unidadeId) {
    unidade = unidadesDaOrg.find((u) => u.unidadeId === unidadeId);
    if (!unidade) throw ApiError.badRequest("Unidade não pertence a este responsável.", { codigo: "UNIDADE_INVALIDA" });
  }

  const whatsAppService = deps.whatsAppService !== undefined ? deps.whatsAppService : await criarWhatsAppServiceDoAmbiente(envDe(deps));
  if (!whatsAppService) throw conflito(MENSAGENS_GATE.WHATSAPP_NAO_CONFIGURADO, "WHATSAPP_NAO_CONFIGURADO");

  const audit = deps.auditar ?? auditar;
  const base = { atorId: autor.contaId, perfilId: autor.perfilId ?? null, perfilNome: autor.nome ?? null, atorEmail: autor.email ?? null, entidade: "comunicacao_mensagens", organizacaoId: org.organizacaoId };
  const detalhes = { contato_id: id, telefone_mascarado: mascararTelefoneUi(contato.telefoneE164), unidade_id: unidade?.unidadeId ?? null, envio_id: eid, origem: "manual_painel", caracteres: Array.from(limpo).length };
  let r;
  try {
    r = await enviarMensagemManual({
      envioId: eid, organizacaoId: org.organizacaoId, unidadeId: unidade?.unidadeId ?? null, contatoId: id, destinatarioPerfilId: null, contatoEmpresaId: contato.responsaveis?.find((x) => x.organizacaoId === org.organizacaoId)?.id ?? null,
      telefoneE164: contato.telefoneE164, texto: limpo, atorPerfilId: autor.perfilId ?? null, atorNome: autor.nome ?? null, whatsAppService,
      aoIniciar: (mensagemId) => audit({ ...base, acao: ACOES.COMUNICACAO_MANUAL_INICIADO, entidadeId: mensagemId, detalhes }),
    }, deps);
  } catch (e) {
    await audit({ ...base, acao: ACOES.COMUNICACAO_MANUAL_FALHOU, entidadeId: null, detalhes: { ...detalhes, etapa: "criacao_ou_envio", erro: String(e?.message ?? e).slice(0, 200) } });
    throw e;
  }

  if (r.resultado === "JA_EXISTIA") return { mensagemId: r.mensagemId, status: r.status, resultado: "JA_EXISTIA", jaExistia: true };
  if (r.resultado === "POSSE_PERDIDA") throw conflito("O envio desta mensagem já está em andamento.", "ENVIO_EM_ANDAMENTO");
  if (r.resultado === "ENVIADO") await audit({ ...base, acao: ACOES.COMUNICACAO_MANUAL_ENVIADO, entidadeId: r.mensagemId, detalhes });
  else await audit({ ...base, acao: ACOES.COMUNICACAO_MANUAL_FALHOU, entidadeId: r.mensagemId, detalhes: { ...detalhes, classificacao: r.classificacao ?? null, resultado: r.resultado, erro: r.erro ?? null } });

  const linha = await centralRepo.obterSaida(r.mensagemId, deps);
  return { mensagemId: r.mensagemId, status: r.status ?? null, resultado: r.resultado, jaExistia: false, mensagem: linha ? projetarSaida(linha) : null };
}

// ---------------------------------------------------------------------------
// Atualização ao vivo (cursor barato, sem recarregar listas)
// ---------------------------------------------------------------------------

const RE_CURSOR = /^(?:|\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))\|(?:|\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))$/;
const formatarCursor = ({ inbox, saida }) => `${inbox ?? ""}|${saida ?? ""}`;
function lerCursor(texto) {
  if (typeof texto !== "string" || !RE_CURSOR.test(texto)) return null;
  const [inbox, saida] = texto.split("|");
  if ([inbox, saida].some((valor) => valor && !Number.isFinite(Date.parse(valor)))) return null;
  return { inbox: inbox || null, saida: saida || null };
}

/**
 * GET /comunicacao/central/atualizacoes?cursor= — o que mudou desde o cursor: só ids de conversas e totais (nenhum conteúdo). A tela usa isto para
 * recarregar SÓ a lista e a conversa aberta, e só quando algo mudou. Sem cursor: devolve o cursor atual.
 */
export async function atualizacoes({ cursor } = {}, deps = {}) {
  const anterior = cursor ? lerCursor(cursor) : null;
  if (cursor && !anterior) throw ApiError.badRequest("Cursor inválido.", { codigo: "CURSOR_INVALIDO" });
  const [atual, gateway, modo] = await Promise.all([
    centralRepo.lerCursoresAtuais(deps), repo.obterEstadoGateway(deps).catch(() => ({ estado: "desconhecido" })),
    (deps.modoAtual ?? modoAtual)(deps).catch(() => null),   // as pílulas do topo (WhatsApp e automação) vivem daqui
  ]);
  const orgConexao = conexaoOrgId(deps);
  const resumo = orgConexao ? await inboxRepo.resumoPorContato(orgConexao, deps) : [];
  const naoLidas = resumo.filter((r) => (r.nao_lidas ?? 0) > 0).length;
  const novo = formatarCursor(atual);
  if (!anterior || novo === formatarCursor(anterior)) return { cursor: novo, mudou: false, contatosAlterados: [], naoLidas, gateway: gateway.estado, modo };
  const alterados = await centralRepo.contatosAlteradosDesde(anterior, deps);
  // Só conversas autorizadas: um id que o roster não reconhece nunca vaza para a tela.
  const roster = await (deps.roster ?? rosterRepo).listarRoster(deps);
  const autorizados = new Set(roster.map((c) => c.contatoId));
  return { cursor: novo, mudou: true, contatosAlterados: alterados === null ? [...autorizados] : alterados.filter((id) => autorizados.has(id)), naoLidas, gateway: gateway.estado, modo };
}

// ---------------------------------------------------------------------------
// Visão geral
// ---------------------------------------------------------------------------

const ROTULO_GATEWAY = Object.freeze({ conectado: "Conectado", desconectado: "Desconectado", instavel: "Instável", desconhecido: "Desconhecido" });
const ROTULO_MODO = Object.freeze({ NORMAL: "Ativa", REACTIVE_ONLY: "Somente reativa", DISABLED: "Desativada" });

/** GET /comunicacao/central/visao-geral */
export async function visaoGeral(deps = {}) {
  const agora = agoraDe(deps);
  const inicioDia = inicioDoDiaBrasil(agora);
  const [conversas, saidasHoje, entradasHoje, proximos, resumoSaude, orgs, modo, identidade, enviadasHoje] = await Promise.all([
    montarConversas(deps),
    centralRepo.listarSaidasDesde({ desde: inicioDia }, deps),
    inboxRepo.listarMensagensDesde({ organizacaoId: conexaoOrgId(deps), desde: inicioDia }, deps),
    centralRepo.listarProximosEnvios({ limite: 6 }, deps),
    (deps.resumo ?? service.resumo)(deps),
    (deps.organizacoes ?? service.organizacoes)({}, deps),
    (deps.modoAtual ?? modoAtual)(deps),
    (deps.resumoIdentidade ?? conexao.resumoIdentidade)(deps),
    centralRepo.listarEnviadasDesde({ desde: inicioDia }, deps),
  ]);
  const roster = new Set(conversas.itens.map((c) => c.contatoId));
  const saidas = saidasHoje.filter((m) => m.contato_id && roster.has(m.contato_id));
  const entradas = entradasHoje.filter((m) => roster.has(m.contato_id));
  const enviadas = enviadasHoje.filter((m) => m.contato_id && roster.has(m.contato_id));
  const entregues = enviadas.filter((m) => m.status === "DELIVERED" || m.status === "READ");
  const falhas = saidas.filter((m) => m.status === "FAILED").length;
  const incertas = saidas.filter((m) => m.status === "DELIVERY_UNKNOWN").length;
  const naoLidasConversas = conversas.itens.filter((c) => c.naoLidas > 0);
  const gw = resumoSaude.gateway?.estado ?? "desconhecido";

  const alertas = [];
  if (gw !== "conectado") alertas.push({ id: "gateway", severidade: "critico", titulo: "WhatsApp fora do ar", texto: "Nenhuma mensagem pode ser enviada ou recebida até a conexão voltar.", destino: { aba: "conexao" } });
  else if (identidade && identidade.status === "PENDENTE_CONFIRMACAO") alertas.push({ id: "conta_pendente", severidade: "atencao", titulo: "Conta do WhatsApp aguardando confirmação", texto: "O envio pelo painel fica bloqueado até você confirmar a conta em Conexão.", destino: { aba: "conexao" } });
  if (falhas > 0) alertas.push({ id: "falhas", severidade: "atencao", titulo: `${falhas} mensagem${falhas === 1 ? "" : "s"} não ${falhas === 1 ? "foi enviada" : "foram enviadas"} hoje`, texto: "Veja no histórico o motivo e o destinatário.", destino: { aba: "historico", status: "FAILED" } });
  if (incertas > 0) alertas.push({ id: "incertas", severidade: "atencao", titulo: `${incertas} entrega${incertas === 1 ? "" : "s"} sem confirmação`, texto: "O WhatsApp não confirmou se chegaram. Nenhum reenvio é feito sozinho.", destino: { aba: "historico", status: "DELIVERY_UNKNOWN" } });
  // Sem resposta = há mensagem RECEBIDA não lida com mais de 2h — independente de um aviso automático ter saído depois (isso não é atendimento humano).
  const paradas = naoLidasConversas.filter((c) => c.ultimaEntradaEm && agora.getTime() - ms(c.ultimaEntradaEm) > 2 * HORA);
  if (paradas.length) alertas.push({ id: "sem_resposta", severidade: "atencao", titulo: `${paradas.length} conversa${paradas.length === 1 ? "" : "s"} sem resposta há mais de 2 horas`, texto: "Um responsável escreveu e ainda não foi atendido.", destino: { aba: "conversas", filtro: "nao_lidas" } });
  const semContatoApto = orgs.filter((o) => (o.pendenciasAtuais ?? 0) > 0 && (!o.contato || o.contato.consentimento !== true || o.contato.verificado !== true)).length;
  if (semContatoApto) alertas.push({ id: "sem_contato_apto", severidade: "atencao", titulo: `${semContatoApto} empresa${semContatoApto === 1 ? "" : "s"} com pendência e sem contato apto`, texto: "Falta destinatário, consentimento ou verificação para avisar.", destino: { aba: "destinatarios" } });
  if (modo !== "NORMAL") alertas.push({ id: "automacao_off", severidade: "info", titulo: "Automação desativada", texto: "Nenhum alerta automático está sendo enviado.", destino: { aba: "automacoes" } });

  const nomeOrg = new Map(orgs.map((o) => [o.organizacaoId, o.nome]));
  return {
    cards: {
      whatsapp: { estado: gw, rotulo: ROTULO_GATEWAY[gw] ?? "Desconhecido", conta: identidade ? { status: identidade.status, confirmada: identidade.confirmada, ambiente: identidade.ambiente, nomeOperacional: identidade.nomeOperacional } : null },
      automacao: { modo, rotulo: ROTULO_MODO[modo] ?? "—", ativa: modo === "NORMAL" },
      conversasNaoLidas: naoLidasConversas.length,
      mensagensHoje: { total: saidas.length + entradas.length, enviadas: enviadas.length, recebidas: entradas.length },
      entreguesHojePct: enviadas.length ? Math.round((entregues.length / enviadas.length) * 100) : null,
      falhasHoje: falhas,
    },
    conversasRecentes: conversas.itens.filter((c) => c.ultimaAtividadeEm).sort((a, b) => ms(b.ultimaAtividadeEm) - ms(a.ultimaAtividadeEm)).slice(0, 5),
    alertas,
    proximosEnvios: proximos.filter((p) => !p.contato_id || roster.has(p.contato_id)).map((p) => ({ organizacaoId: p.organizacao_id, empresa: nomeOrg.get(p.organizacao_id) ?? null, em: p.disponivel_em, origem: origemDaMensagem(p) })),
    cursor: formatarCursor(await centralRepo.lerCursoresAtuais(deps)),
  };
}

// ---------------------------------------------------------------------------
// Automações
// ---------------------------------------------------------------------------

const hhmm = (h) => `${String(h.hora).padStart(2, "0")}:${String(h.minuto).padStart(2, "0")}`;

/** GET /comunicacao/central/automacoes — a automação D-1 do dashboard iFood em linguagem de negócio, com os valores REAIS aplicados hoje. */
export async function automacoes(deps = {}) {
  const [modo, orgs, config, proximos, gateway] = await Promise.all([
    (deps.modoAtual ?? modoAtual)(deps), (deps.organizacoes ?? service.organizacoes)({}, deps),
    (deps.configuracaoOperacional ?? configuracaoOperacional)(deps), centralRepo.listarProximosEnvios({ limite: 20 }, deps),
    deps.estadoGateway !== undefined ? deps.estadoGateway : repo.obterEstadoGateway(deps).catch(() => ({ estado: "desconhecido" })),
  ]);
  const janela = config?.janelaComercial?.seg_sex ?? null;
  const disp = config?.disponibilidadeIfood ?? null;
  const nomeOrg = new Map(orgs.map((o) => [o.organizacaoId, o.nome]));
  const habilitadas = orgs.filter((o) => o.habilitada);
  return {
    modo, rotuloModo: ROTULO_MODO[modo] ?? "—", ativa: modo === "NORMAL",
    // Sem sessão válida do WhatsApp nenhuma automação sai — a tela avisa (o histórico nunca é apagado).
    whatsapp: { estado: gateway?.estado ?? "desconhecido", conectado: gateway?.estado === "conectado", rotulo: gateway?.estado === "conectado" ? "WhatsApp conectado" : "WhatsApp desconectado" },
    dashboardIfoodD1: {
      titulo: "Dashboard iFood D-1",
      resumo: "Avisa o responsável quando o lançamento do dia anterior ainda não foi feito.",
      quandoDetecta: "Continuamente, para cada unidade monitorada.",
      quandoEnvia: (janela ? `Dentro da janela comercial (${janela.inicio}–${janela.fim}, segunda a sexta).` : "Dentro da janela comercial configurada.") + (disp ? ` O aviso do dia anterior só sai a partir das ${disp.enviosPermitidosApos} (os dados do iFood ficam disponíveis às ${disp.dadosDisponiveisApos}).` : ""),
      quandoReforca: `Uma vez, entre ${hhmm(JANELA_REFORCO.inicio)} e ${hhmm(JANELA_REFORCO.fim)}, só se o prazo vence hoje e a pendência continua (mínimo de ${ESPACAMENTO_MINIMO_HORAS} h depois do primeiro aviso).`,
      horarioLimite: hhmm(CUTOFF_REFORCO),
      linhaDoTempo: [
        { id: "janela", titulo: disp ? "Avisos do D-1 começam" : "Janela comercial começa", horario: disp && janela ? (disp.enviosPermitidosApos > janela.inicio ? disp.enviosPermitidosApos : janela.inicio) : (janela?.inicio ?? null), texto: disp ? `Antes das ${disp.dadosDisponiveisApos} os dados do iFood não estão disponíveis; os avisos saem a partir das ${disp.enviosPermitidosApos}.` : "A partir daqui os avisos normais podem sair." },
        { id: "deteccao", titulo: "Pendência detectada", horario: null, texto: "O monitoramento identifica o lançamento atrasado." },
        { id: "agendada", titulo: "Mensagem agendada", horario: null, texto: "Programada para o horário permitido, com pequeno espalhamento." },
        { id: "enviada", titulo: "Mensagem enviada", horario: null, texto: "Enviada ao WhatsApp. A entrega é confirmada depois." },
        { id: "reforco", titulo: "Reforço, se necessário", horario: hhmm(JANELA_REFORCO.inicio), texto: "Um segundo aviso quando o prazo vence hoje e nada foi lançado." },
        { id: "limite", titulo: "Horário limite", horario: hhmm(CUTOFF_REFORCO), texto: "Depois disso nada sai e nada é reagendado para outro dia." },
      ],
    },
    empresasHabilitadas: { total: habilitadas.length, itens: habilitadas.map((o) => ({ organizacaoId: o.organizacaoId, nome: o.nome, pausada: !!o.pausada, pendenciasAtuais: o.pendenciasAtuais ?? 0, proximoEnvioEm: o.proximoEnvioEm ?? null, ultimoEnvioEm: o.ultimoEnvioEm ?? null, proximaAcao: o.proximaAcao })) },
    proximosEnvios: proximos.map((p) => ({ organizacaoId: p.organizacao_id, empresa: nomeOrg.get(p.organizacao_id) ?? null, em: p.disponivel_em, origem: origemDaMensagem(p) })),
  };
}

// ---------------------------------------------------------------------------
// Destinatários
// ---------------------------------------------------------------------------

/** GET /comunicacao/central/destinatarios?busca= — os responsáveis do roster (nunca telefone completo) e a situação de cada um. */
export async function destinatarios({ busca } = {}, deps = {}) {
  const [{ itens }, orgs] = await Promise.all([montarConversas(deps), (deps.organizacoes ?? service.organizacoes)({}, deps)]);
  const habilitada = new Map(orgs.map((o) => [o.organizacaoId, o.habilitada === true]));
  const termo = normalizarBusca(busca);
  const lista = (termo ? itens.filter((c) => combina(c, termo)) : itens).map((c) => ({
    contatoId: c.contatoId, nome: c.nome, iniciais: c.iniciais, fotoUrl: c.fotoUrl, cargo: c.cargo, telefoneMascarado: c.telefoneMascarado,
    empresas: c.empresas.map((e) => ({ organizacaoId: e.organizacaoId, nome: e.nome, habilitada: habilitada.get(e.organizacaoId) === true })),
    unidades: c.unidades, consentimento: c.consentimento, verificado: c.verificado, optOut: c.optOut, whatsappConfirmado: c.whatsappConfirmado,
    comunicacaoHabilitada: c.empresas.some((e) => habilitada.get(e.organizacaoId) === true), ultimaInteracaoEm: c.ultimaAtividadeEm, naoLidas: c.naoLidas,
  }));
  return { itens: lista, total: lista.length };
}

// ---------------------------------------------------------------------------
// Histórico geral (entradas + saídas)
// ---------------------------------------------------------------------------

const ORIGENS_HISTORICO = Object.freeze(["contato", "automacao", "reforco", "aviso_tardio", "teste_controlado", "manual_painel"]);

/** GET /comunicacao/central/historico — todas as mensagens de responsáveis autorizados (recebidas e enviadas), com filtros. Busca por NOME, nunca por telefone. */
export async function historicoGeral({ organizacaoId, unidadeId, status, origem, desde, ate, busca, operador, pagina, porPagina } = {}, deps = {}) {
  if (organizacaoId) v.uuid(organizacaoId, "Empresa");
  if (unidadeId) v.uuid(unidadeId, "Unidade");
  if (status && !Object.values(STATUS_MENSAGEM).includes(status)) throw ApiError.badRequest("Status inválido.", { codigo: "STATUS_INVALIDO" });
  if (origem && !ORIGENS_HISTORICO.includes(origem)) throw ApiError.badRequest("Origem inválida.", { codigo: "ORIGEM_INVALIDA" });
  const iso = (x, rot) => { if (x === undefined || x === null || x === "") return null; const t = Date.parse(String(x)); if (!Number.isFinite(t)) throw ApiError.badRequest(`${rot} inválida.`, { codigo: "PERIODO_INVALIDO" }); return t; };
  const t0 = iso(desde, "Data inicial"); const t1 = iso(ate, "Data final");

  const agora = agoraDe(deps);
  const desde30 = new Date(agora.getTime() - JANELA_MAX_HORAS * HORA).toISOString();
  const roster = await (deps.roster ?? rosterRepo).listarRoster(deps);
  const porContato = new Map(roster.map((c) => [c.contatoId, c]));
  const ids = roster.map((c) => c.contatoId);
  const orgConexao = conexaoOrgId(deps);
  const [saidas, entradas] = await Promise.all([
    centralRepo.listarSaidasRecentes({ contatoIds: ids, desde: desde30, limite: 3000 }, deps),
    orgConexao ? inboxRepo.listarMensagensDesde({ organizacaoId: orgConexao, desde: desde30, limite: 3000, comTexto: true }, deps) : [],
  ]);

  const linhas = [];
  for (const m of saidas) {
    const c = porContato.get(m.contato_id); if (!c) continue;
    const p = projetarSaida(m);
    linhas.push({ ...p, contatoId: c.contatoId, responsavel: c.nome, unidadeIds: m.unidade_id ? [m.unidade_id] : c.unidades.map((u) => u.unidadeId), organizacaoIds: [m.organizacao_id] });
  }
  for (const m of entradas) {
    const c = porContato.get(m.contato_id); if (!c) continue;
    const p = projetarEntrada(m);
    linhas.push({ ...p, contatoId: c.contatoId, responsavel: c.nome, unidadeIds: c.unidades.map((u) => u.unidadeId), organizacaoIds: c.organizacoes.map((o) => o.organizacaoId) });
  }

  const termo = normalizarBusca(busca);
  const op = normalizarBusca(operador);
  const nomesOrg = new Map(roster.flatMap((c) => c.organizacoes.map((o) => [o.organizacaoId, o.nome])));
  const nomesUni = new Map(roster.flatMap((c) => c.unidades.map((u) => [u.unidadeId, u.nome])));
  const filtradas = linhas.filter((l) => {
    if (organizacaoId && !l.organizacaoIds.includes(organizacaoId)) return false;
    if (unidadeId && !l.unidadeIds.includes(unidadeId)) return false;
    if (status && l.status !== status) return false;
    if (origem && l.origem !== origem) return false;
    if (t0 !== null && ms(l.em) < t0) return false;
    if (t1 !== null && ms(l.em) > t1) return false;
    if (op && !normalizarBusca(l.operador).includes(op)) return false;
    if (termo) {
      const c = porContato.get(l.contatoId);
      if (!combina({ nome: c.nome, empresas: c.organizacoes, unidades: c.unidades }, termo)) return false;
    }
    return true;
  }).sort((a, b) => ms(b.em) - ms(a.em));

  const p = Math.max(1, Number(pagina) || 1);
  const porPag = Math.min(100, Math.max(1, Number(porPagina) || 25));
  return {
    itens: filtradas.slice((p - 1) * porPag, p * porPag).map((l) => ({
      id: l.id, contatoId: l.contatoId, direcao: l.direcao, categoria: l.categoria, origem: l.origem, em: l.em, responsavel: l.responsavel,
      empresas: l.organizacaoIds.map((id) => nomesOrg.get(id)).filter(Boolean), unidades: l.unidadeIds.map((id) => nomesUni.get(id)).filter(Boolean).slice(0, 3),
      previa: l.tipo === "midia" ? "Mídia recebida" : previa(l.texto, 120), status: l.status, enviadoEm: l.enviadoEm, entregueEm: l.entregueEm, lidoEm: l.lidoEm,
      falhouEm: l.falhouEm, erro: l.erro, operador: l.operador,
    })),
    total: filtradas.length, pagina: p, porPagina: porPag,
  };
}

// ---------------------------------------------------------------------------
// Diagnóstico técnico (escondido por padrão na tela; só booleanos/rótulos/contagens)
// ---------------------------------------------------------------------------

/** GET /comunicacao/central/diagnostico — infraestrutura para a área secundária de Configurações. Nunca segredo, HMAC, token, auth-state nem telefone. */
export async function diagnosticoTecnico(deps = {}) {
  const [r, erros] = await Promise.all([(deps.resumo ?? service.resumo)(deps), centralRepo.listarUltimosErros({ limite: 5 }, deps).catch(() => [])]);
  return {
    ...r, inbox: { ...metricasInbox(), retencaoDias: inboxRepo.retencaoDias(envDe(deps)) },
    ultimosErros: erros.map((m) => ({ status: m.status, em: m.falhou_em ?? m.entrega_incerta_em ?? m.updated_at, erro: m.erro ? String(m.erro).slice(0, 160) : null, origem: origemDaMensagem(m) })),
  };
}
