// AUTOATENDIMENTO do app Order (pedidos + eventos) — a unidade conecta os pedidos do iFood sem suporte técnico.
//
// Substitui as DUAS etapas manuais do piloto por validação automática equivalente ou mais forte, reaproveitando as mesmas peças:
//   * liberação por unidade (IFOOD_ORDER_PILOT_UNITS)  ->  IFOOD_ORDER_SELF_SERVICE_ENABLED (+ IFOOD_ORDER_SELF_SERVICE_UNITS só durante a
//     liberação gradual) + o módulo `ifood` da unidade (gate da rota) + `integracoes.gerenciar` (gate da rota). O tenant vem SEMPRE do
//     contexto validado (req.tenant). Ver ifoodToken.service.js#autoatendimentoLiberadoParaUnidade;
//   * ID da loja digitado + conferência visual + validação acompanhada  ->  a loja PROVADA pelo token Order que o próprio iFood emitiu
//     nesta autorização (claim `merchant_scope` com order+events, ifoodTokenEscopo.js), escolhida só entre as lojas desse token, depois
//     confirmada por UMA consulta de eventos isolada (ifoodMerchantVinculo.service.js#verificarAutorizacao: sem gravar, sem ACK, com
//     freio de tentativas). O vínculo segue os MESMOS estados e o mesmo índice único de merchant (migration 116 / 056).
//
// Depois da ativação, a unidade entra no escopo do poller pelo vínculo `validado` (ifoodMerchantVinculo.repository.js#listarUnidadesComOrderAtivado),
// lido a cada ciclo — sem restart, sem variável por unidade. O ciclo do poller e o ACK não mudam.
//
// CONEXÃO QUE JÁ TEM LOJA:
//   * no escopo do poller (unidade do piloto — Saci/North — ou ativação anterior): nada a fazer, NUNCA é alterada aqui;
//   * fora do escopo (conexão `legado` cuja loja veio da Merchant API, pelo Analytics/Financial, e que acabou de receber o Order): a loja é
//     a DELA (nunca outra); o token Order precisa cobri-la e a mesma verificação isolada roda antes de ela entrar no poller. O merchant, o
//     nome e a razão social da conexão não são regravados.
//
// O QUE NÃO FAZ: nunca usa a conexão do Financial de homologação; nunca toca lojas adicionais (elas seguem o fluxo próprio, supervisionado);
// nunca confirma/despacha pedidos; nunca loga token nem merchant inteiro.
//
// ESTADOS (para a tela):
//   nao_conectado     sem credencial Order (ou desconectada)
//   validando_loja    loja identificada, verificação no iFood ainda não concluída (falha transitória = recuperável; com horário da próxima)
//   acao_necessaria   o gestor precisa agir: escolher a loja, reautorizar, ou recomeçar
//   conectado         loja validada, conexão ativa e unidade no escopo do poller (os pedidos entram no próximo ciclo)

import { createHash } from "node:crypto";
import { decifrar } from "../../shared/cripto.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import { IFOOD_APP_ORDER } from "./ifood.constants.js";
import { ifoodErro, IFOOD_ERROS } from "./ifood.errors.js";
import { ifoodLog, mascararId } from "./ifood.logsafe.js";
import * as repositorio from "./ifood.repository.js";
import * as vinculoRepositorio from "./ifoodMerchantVinculo.repository.js";
import * as tokenService from "./ifoodToken.service.js";
import * as vinculoService from "./ifoodMerchantVinculo.service.js";
import { FINALIDADES } from "./ifoodFinalidade.js";
import { escopoDoAccessToken, MODULOS_ORDER } from "./ifoodTokenEscopo.js";

export const ESTADOS = Object.freeze({
  NAO_CONECTADO: "nao_conectado",
  VALIDANDO_LOJA: "validando_loja",
  ACAO_NECESSARIA: "acao_necessaria",
  CONECTADO: "conectado",
});

export const MOTIVOS = Object.freeze({
  REAUTORIZAR: "REAUTORIZAR",                       // credencial reauth_required (expirou ou foi revogada no iFood)
  SEM_LOJA_NO_TOKEN: "SEM_LOJA_NO_TOKEN",           // o token não declara nenhuma loja com order+events
  LOJA_DE_OUTRA_UNIDADE: "LOJA_DE_OUTRA_UNIDADE",   // as lojas do token já pertencem a outra conexão (de qualquer empresa)
  LOJA_CONECTADA_FORA_DO_TOKEN: "LOJA_CONECTADA_FORA_DO_TOKEN",   // a conexão já tem loja e o token Order não a cobre
  VARIAS_LOJAS: "VARIAS_LOJAS",                     // o token declara mais de uma loja livre: o gestor escolhe
  MUITAS_LOJAS: "MUITAS_LOJAS",                     // o token declara lojas demais para escolher com segurança na tela
  SEM_AUTORIZACAO: "SEM_AUTORIZACAO",               // o iFood recusou a consulta da loja (403 unauthorizedMerchants)
  VERIFICACAO_FALHOU: "VERIFICACAO_FALHOU",         // falha transitória ao verificar (rede, 5xx)
  AGUARDANDO_NOVA_VERIFICACAO: "AGUARDANDO_NOVA_VERIFICACAO",   // intervalo mínimo entre duas verificações (10 min)
  TENTATIVAS_ESGOTADAS: "TENTATIVAS_ESGOTADAS",     // freio do vínculo (3 consultas por vínculo, 3 rejeições/dia)
});

/** Máximo de lojas do token consideradas (cada uma custa leituras no banco; acima disso o gestor reautoriza só a loja da unidade). */
export const MAX_LOJAS_NO_TOKEN = 10;

const RECONECTE = "Clique em \"Reconectar pedidos iFood\"";
const MENSAGENS = {
  [MOTIVOS.REAUTORIZAR]: `A autorização dos pedidos no iFood expirou ou foi revogada. ${RECONECTE} e autorize de novo.`,
  [MOTIVOS.SEM_LOJA_NO_TOKEN]: `A autorização do iFood não incluiu nenhuma loja com pedidos. ${RECONECTE} e, no Portal do Parceiro, autorize a loja desta unidade.`,
  [MOTIVOS.LOJA_DE_OUTRA_UNIDADE]: `A loja autorizada já está conectada a outra unidade da Central. ${RECONECTE} e autorize a loja desta unidade.`,
  [MOTIVOS.LOJA_CONECTADA_FORA_DO_TOKEN]: `Esta unidade já está ligada a uma loja do iFood, mas a autorização de pedidos foi feita para outra loja. ${RECONECTE} e autorize a mesma loja.`,
  [MOTIVOS.VARIAS_LOJAS]: "A autorização incluiu mais de uma loja. Escolha abaixo a loja desta unidade — o código mostrado (início e fim) é o mesmo do Portal do Parceiro.",
  [MOTIVOS.MUITAS_LOJAS]: `A autorização incluiu lojas demais para escolher aqui. ${RECONECTE} e, no Portal do Parceiro, autorize só a loja desta unidade.`,
  [MOTIVOS.SEM_AUTORIZACAO]: `O iFood não confirmou que o app de pedidos está autorizado para esta loja. ${RECONECTE} e autorize de novo no Portal do Parceiro.`,
  [MOTIVOS.VERIFICACAO_FALHOU]: "Não conseguimos confirmar a loja com o iFood agora. Uma nova verificação fica disponível no horário indicado.",
  [MOTIVOS.AGUARDANDO_NOVA_VERIFICACAO]: "A loja está sendo confirmada com o iFood. Por segurança, uma nova verificação só fica disponível no horário indicado.",
  [MOTIVOS.TENTATIVAS_ESGOTADAS]: "A loja já foi verificada 3 vezes sem sucesso. Para recomeçar, clique em \"Desconectar\" e depois em \"Conectar pedidos iFood\".",
};

/** Referência OPACA de uma loja para a tela: escolher sem nunca expor o merchant inteiro. Estável por merchant. */
export const refDaLoja = (merchantId) => createHash("sha256").update(`ifood-loja:${merchantId}`).digest("hex").slice(0, 16);

/**
 * PURA. Lojas que o token Order declara com TODOS os módulos de pedidos (order + events). Token opaco/sem escopo = nenhuma (sem prova).
 * @returns {string[]} merchants normalizados
 */
export function lojasDoToken(accessToken) {
  const e = escopoDoAccessToken(accessToken);
  if (e.formato !== "jwt" || !e.temEscopo) return [];
  return [...e.merchants.entries()].filter(([, mods]) => MODULOS_ORDER.every((m) => mods.has(m))).map(([id]) => id);
}

const resultado = (estado, motivo = null, extra = {}) => ({ estado, motivo, mensagem: motivo ? MENSAGENS[motivo] ?? null : null, ...extra });

function dependencias(deps = {}) {
  return {
    repo: deps.repo ?? repositorio,
    vinculos: deps.vinculos ?? vinculoRepositorio,
    token: deps.token ?? tokenService,
    vinculo: deps.vinculo ?? vinculoService,
    auditar: deps.auditar ?? auditar,
    log: deps.log ?? ifoodLog,
    agora: deps.agora ?? deps.vinculoDeps?.agora ?? (() => new Date()),
    vinculoDeps: deps.vinculoDeps,   // repassado às etapas do vínculo (testes injetam client/http/agora)
  };
}

/** Conexão de PEDIDOS da unidade (nunca a do Financial de homologação) + a credencial Order dela. Defesa em profundidade do tenant. */
async function conexaoECredencial({ organizacaoId, unidadeId, repo }) {
  const conexao = await repo.obterConexaoViva({ organizacaoId, unidadeId, finalidade: FINALIDADES.PEDIDOS_PRODUCAO });
  if (!conexao || conexao.organizacao_id !== organizacaoId || conexao.unidade_id !== unidadeId) return { conexao: null, cred: null };
  const cred = await repo.obterCredencial({ conexaoId: conexao.id, appType: IFOOD_APP_ORDER });
  return { conexao, cred };
}

/** Loja principal da conexão, se ela já tem uma e está ativa. */
const lojaPrincipalDe = (conexao) => (conexao?.merchant_id && conexao.status === "ativa" ? conexao.merchant_id : null);

/**
 * A conexão (com loja) já está no ESCOPO do poller? Mesma regra do poller: unidade do piloto, ou vínculo `validado` desta conexão com o
 * mesmo merchant (ifoodToken.service.js#unidadesOrderNoEscopo). Só leitura.
 */
async function noEscopoDoPoller({ organizacaoId, unidadeId, conexao, token, vinculos }) {
  const piloto = (token.unidadesPilotoOrder?.() ?? []).map((u) => String(u).toLowerCase());
  if (piloto.includes(String(unidadeId).toLowerCase())) return true;
  const ultimo = await vinculos.obterUltimoVinculo({ organizacaoId, unidadeId, conexaoId: conexao.id });
  return ultimo?.estado === "validado" && ultimo.merchant_id === conexao.merchant_id;
}

/** Lojas do token LIVRES para esta conexão: não são loja principal de outra conexão viva, nem loja adicional de nenhuma, nem estão num vínculo em aberto de outra conexão. */
async function lojasLivres({ conexao, cred, repo, vinculos }) {
  let accessToken = null;
  try { accessToken = decifrar(cred.access_token_cifrado); } catch { accessToken = null; }
  const doToken = lojasDoToken(accessToken);
  if (doToken.length > MAX_LOJAS_NO_TOKEN) return { doToken, livres: [] };   // não consulta o banco por loja
  const livres = [];
  for (const merchantId of doToken) {
    const dono = await repo.conexaoVivaDoMerchant({ merchantId });
    if (dono && dono.id !== conexao.id) continue;
    if (await repo.lojaAdicionalVivaDoMerchant({ merchantId })) continue;
    const aberto = await vinculos.vinculoAbertoDoMerchant({ merchantId });
    if (aberto && aberto.conexao_id !== conexao.id) continue;
    livres.push(merchantId);
  }
  return { doToken, livres };
}

const opcoesDe = (merchants) => merchants.map((m) => ({ ref: refDaLoja(m), idMascarado: mascararId(m) }));

/**
 * Freio da verificação, lido do vínculo em aberto (mesmas regras de verificarAutorizacao): já verificada há pouco, limite atingido ou
 * dentro do intervalo de 10 min. Puro.
 */
function freioDaVerificacao(aberto, agoraMs) {
  const L = vinculoService.VINCULO_MANUAL;
  const verificadaMs = aberto?.autorizacao_verificada_em ? Date.parse(aberto.autorizacao_verificada_em) : null;
  if (verificadaMs != null && agoraMs - verificadaMs < L.validadeVerificacaoMs) return { recente: true };
  if (Number(aberto?.autorizacao_tentativas ?? 0) >= L.maxVerificacoes) return { esgotado: true };
  const ultimaMs = aberto?.autorizacao_ultima_tentativa_em ? Date.parse(aberto.autorizacao_ultima_tentativa_em) : null;
  if (ultimaMs != null && agoraMs - ultimaMs < L.intervaloVerificacaoMs) return { proximaVerificacaoEm: new Date(ultimaMs + L.intervaloVerificacaoMs).toISOString() };
  return {};
}

/**
 * ATIVA os pedidos da unidade (idempotente; seguro contra duplo clique — cada etapa do vínculo é compare-and-set e o merchant tem índice único).
 * Chamado logo depois do OAuth Order (ifoodAuth.service.js) e pelos botões "Verificar novamente" / escolha da loja.
 * @param {{organizacaoId: string, unidadeId: string, usuarioId?: string, ref?: string|null, deps?: object}} p
 * @returns {Promise<{estado: string, motivo: string|null, mensagem: string|null, opcoes?: Array<{ref, idMascarado}>, lojaMascarada?: string, proximaVerificacaoEm?: string}>}
 */
export async function ativar({ organizacaoId, unidadeId, usuarioId = null, ref = null, deps = {} }) {
  const d = dependencias(deps);
  if (!d.token.autoatendimentoLiberadoParaUnidade(unidadeId)) throw ifoodErro(IFOOD_ERROS.IFOOD_AUTOATENDIMENTO_DESLIGADO);
  const { conexao, cred } = await conexaoECredencial({ organizacaoId, unidadeId, repo: d.repo });
  if (!conexao || !cred) return resultado(ESTADOS.NAO_CONECTADO);
  const lojaPrincipal = lojaPrincipalDe(conexao);
  // Conexão com loja que o poller JÁ consulta (piloto — Saci/North — ou ativação anterior): nada a fazer, nunca é alterada aqui.
  if (lojaPrincipal && await noEscopoDoPoller({ organizacaoId, unidadeId, conexao, token: d.token, vinculos: d.vinculos })) {
    return resultado(ESTADOS.CONECTADO, null, { lojaMascarada: mascararId(lojaPrincipal), jaAtiva: true });
  }
  if (cred.status === "reauth_required") return resultado(ESTADOS.ACAO_NECESSARIA, MOTIVOS.REAUTORIZAR);
  if (cred.status !== "ativa") return resultado(ESTADOS.NAO_CONECTADO);

  const base = { organizacaoId, unidadeId, usuarioId, deps: d.vinculoDeps };
  const pendente = async (motivo, extra = {}) => {
    await d.auditar({ atorId: usuarioId, acao: ACOES.IFOOD_PEDIDOS_ATIVACAO_PENDENTE, entidade: "ifood_conexao", entidadeId: conexao.id, organizacaoId, detalhes: { unidadeId, motivo } }).catch(() => {});
    d.log("info", "order_autoatendimento.pendente", { organizacaoId, unidadeId, conexaoId: conexao.id, motivo });
    return resultado(motivo === MOTIVOS.VERIFICACAO_FALHOU ? ESTADOS.VALIDANDO_LOJA : ESTADOS.ACAO_NECESSARIA, motivo, extra);
  };
  // Corrida (duplo clique, OAuth + "Verificar novamente" juntos): a outra requisição desta MESMA conexão já avançou. Relê e descreve o
  // estado real, em vez de acusar "loja de outra unidade". Só é "de outra unidade" se o vínculo/merchant não for desta conexão.
  const emAndamento = async (merchantId) => {
    const atual = await d.repo.obterConexaoViva({ organizacaoId, unidadeId, finalidade: FINALIDADES.PEDIDOS_PRODUCAO });
    if (atual?.id === conexao.id && lojaPrincipalDe(atual) && await noEscopoDoPoller({ organizacaoId, unidadeId, conexao: atual, token: d.token, vinculos: d.vinculos })) {
      return resultado(ESTADOS.CONECTADO, null, { lojaMascarada: mascararId(atual.merchant_id) });
    }
    const meu = await d.vinculos.obterVinculoAberto({ organizacaoId, unidadeId, conexaoId: conexao.id });
    if (meu && (!merchantId || meu.merchant_id === merchantId)) return resultado(ESTADOS.VALIDANDO_LOJA, null, { lojaMascarada: mascararId(meu.merchant_id), emAndamento: true });
    return null;
  };

  // 1. Loja: a principal da conexão (se já tem), o vínculo em aberto (já identificado) ou uma das lojas LIVRES do token.
  let aberto = await d.vinculos.obterVinculoAberto({ organizacaoId, unidadeId, conexaoId: conexao.id });
  const { doToken, livres } = await lojasLivres({ conexao, cred, repo: d.repo, vinculos: d.vinculos });
  if (doToken.length > MAX_LOJAS_NO_TOKEN) return pendente(MOTIVOS.MUITAS_LOJAS);
  let merchantId;
  if (lojaPrincipal) {
    // A loja é a da conexão — nunca outra. O token Order precisa cobri-la (prova de que o app de pedidos foi autorizado para ELA).
    if (!livres.includes(lojaPrincipal)) return pendente(MOTIVOS.LOJA_CONECTADA_FORA_DO_TOKEN, { lojaMascarada: mascararId(lojaPrincipal) });
    merchantId = lojaPrincipal;
  } else {
    merchantId = aberto?.merchant_id ?? null;
    if (ref) {
      const escolhida = livres.find((m) => refDaLoja(m) === ref);
      if (!escolhida) throw ifoodErro(IFOOD_ERROS.IFOOD_AUTOATENDIMENTO_LOJA_INVALIDA);
      merchantId = escolhida;
    }
    // O vínculo em aberto só é aproveitado se a loja dele continua coberta pelo token ATUAL (uma reautorização pode ter trocado as lojas).
    if (merchantId && !ref && !livres.includes(merchantId)) merchantId = null;
    if (!merchantId) {
      if (doToken.length === 0) return pendente(MOTIVOS.SEM_LOJA_NO_TOKEN);
      if (livres.length === 0) return pendente(MOTIVOS.LOJA_DE_OUTRA_UNIDADE);
      if (livres.length > 1) return pendente(MOTIVOS.VARIAS_LOJAS, { opcoes: opcoesDe(livres) });
      merchantId = livres[0];
    }
  }
  const lojaMascarada = mascararId(merchantId);

  // 2. Vínculo nos MESMOS estados do fluxo manual: informado -> aguardando_validacao. A conferência é a prova do token (não um clique).
  try {
    if (!aberto || aberto.merchant_id !== merchantId || aberto.estado === "informado") {
      if (!aberto || aberto.merchant_id !== merchantId) await d.vinculo.informarMerchant({ ...base, merchantId, modo: vinculoService.MODO_AUTOATENDIMENTO });
      await d.vinculo.confirmarMerchant({ ...base, merchantId });
      aberto = await d.vinculos.obterVinculoAberto({ organizacaoId, unidadeId, conexaoId: conexao.id });
    }
  } catch (e) {
    if (e?.codigo === IFOOD_ERROS.IFOOD_VINCULO_DUPLICADO || e?.codigo === IFOOD_ERROS.IFOOD_MERCHANT_JA_VINCULADO || e?.codigo === IFOOD_ERROS.IFOOD_VINCULO_ESTADO_INVALIDO) {
      const r = await emAndamento(merchantId);
      if (r) return r;
      if (e.codigo !== IFOOD_ERROS.IFOOD_VINCULO_ESTADO_INVALIDO) return pendente(MOTIVOS.LOJA_DE_OUTRA_UNIDADE);
    }
    if (e?.codigo === IFOOD_ERROS.IFOOD_VINCULO_TENTATIVAS_ESGOTADAS) return pendente(MOTIVOS.TENTATIVAS_ESGOTADAS);
    throw e;
  }

  // 3. Verificação isolada no iFood (uma consulta de eventos só desta loja, sem gravar e sem ACK). O freio é lido ANTES, para a tela dizer
  //    "nova verificação às HH:MM" em vez de um erro; verificarAutorizacao reaplica as mesmas regras com compare-and-set.
  const agoraMs = d.agora().getTime();
  const freio = freioDaVerificacao(aberto, agoraMs);
  if (freio.esgotado) return pendente(MOTIVOS.TENTATIVAS_ESGOTADAS, { lojaMascarada });
  if (freio.proximaVerificacaoEm) {
    return resultado(ESTADOS.VALIDANDO_LOJA, MOTIVOS.AGUARDANDO_NOVA_VERIFICACAO, { lojaMascarada, proximaVerificacaoEm: freio.proximaVerificacaoEm, podeVerificar: false });
  }
  if (!freio.recente) {
    let r;
    try {
      r = await d.vinculo.verificarAutorizacao({ ...base, modo: vinculoService.MODO_AUTOATENDIMENTO });
    } catch (e) {
      if (e?.codigo === IFOOD_ERROS.IFOOD_VINCULO_ESTADO_INVALIDO || e?.codigo === IFOOD_ERROS.IFOOD_VINCULO_NAO_ENCONTRADO) {
        const atual = await emAndamento(merchantId);
        if (atual) return atual;
      }
      if (e?.codigo === IFOOD_ERROS.IFOOD_VINCULO_TENTATIVAS_ESGOTADAS) {
        // Corrida com outra verificação desta conexão: relê o freio para dizer o horário certo.
        const releitura = freioDaVerificacao(await d.vinculos.obterVinculoAberto({ organizacaoId, unidadeId, conexaoId: conexao.id }), agoraMs);
        if (releitura.proximaVerificacaoEm) return resultado(ESTADOS.VALIDANDO_LOJA, MOTIVOS.AGUARDANDO_NOVA_VERIFICACAO, { lojaMascarada, proximaVerificacaoEm: releitura.proximaVerificacaoEm, podeVerificar: false });
        return pendente(MOTIVOS.TENTATIVAS_ESGOTADAS, { lojaMascarada });
      }
      d.log("warn", "order_autoatendimento.verificacao_falhou", { organizacaoId, unidadeId, conexaoId: conexao.id, codigo: e?.codigo ?? "ERRO_INTERNO" });
      const proxima = new Date(agoraMs + vinculoService.VINCULO_MANUAL.intervaloVerificacaoMs).toISOString();
      return pendente(MOTIVOS.VERIFICACAO_FALHOU, { lojaMascarada, proximaVerificacaoEm: proxima, podeVerificar: false });
    }
    if (!r?.autorizacaoVerificada) return pendente(MOTIVOS.SEM_AUTORIZACAO);
  }

  // 4. Promoção: merchant na conexão (ativa) e vínculo `validado` — a partir daqui o poller enxerga a unidade no próximo ciclo.
  try {
    await d.vinculo.concluirValidacao({ ...base, merchantId, modo: vinculoService.MODO_AUTOATENDIMENTO });
  } catch (e) {
    const r = await emAndamento(merchantId);
    if (r?.estado === ESTADOS.CONECTADO) return r;   // a outra requisição concluiu (auditada por ela)
    if (e?.codigo === IFOOD_ERROS.IFOOD_VINCULO_DUPLICADO || e?.codigo === IFOOD_ERROS.IFOOD_MERCHANT_JA_VINCULADO) return pendente(MOTIVOS.LOJA_DE_OUTRA_UNIDADE);
    if (r) return r;
    throw e;
  }
  await d.auditar({
    atorId: usuarioId, acao: ACOES.IFOOD_PEDIDOS_CONECTADOS, entidade: "ifood_conexao", entidadeId: conexao.id, organizacaoId,
    detalhes: { unidadeId, loja: lojaMascarada, origem: "autoatendimento", lojaJaExistente: !!lojaPrincipal },
  }).catch(() => {});
  d.log("info", "order_autoatendimento.conectado", { organizacaoId, unidadeId, conexaoId: conexao.id, merchantId: lojaMascarada, por: usuarioId });
  return resultado(ESTADOS.CONECTADO, null, { lojaMascarada });
}

/**
 * Resumo para o GET /status (bloco `order.autoatendimento`). Só LEITURA: nunca chama o iFood, nunca grava. Sem a liberação = null (a tela
 * fica exatamente como antes). Falha ao ler = estado recuperável sem derrubar o status.
 * @param {{organizacaoId, unidadeId, conexao: object|null, cred: object|null, deps?: object}} p
 */
export async function resumoParaStatus({ organizacaoId, unidadeId, conexao, cred, deps = {} }) {
  const d = dependencias(deps);
  if (!d.token.autoatendimentoLiberadoParaUnidade(unidadeId)) return null;
  const base = { habilitado: true };
  if (!conexao || !cred) return { ...base, ...resultado(ESTADOS.NAO_CONECTADO) };
  const lojaPrincipal = lojaPrincipalDe(conexao);
  try {
    if (lojaPrincipal && await noEscopoDoPoller({ organizacaoId, unidadeId, conexao, token: d.token, vinculos: d.vinculos })) {
      return { ...base, ...resultado(ESTADOS.CONECTADO), lojaMascarada: mascararId(lojaPrincipal) };
    }
    if (cred.status === "reauth_required") return { ...base, ...resultado(ESTADOS.ACAO_NECESSARIA, MOTIVOS.REAUTORIZAR) };
    if (cred.status !== "ativa") return { ...base, ...resultado(ESTADOS.NAO_CONECTADO) };
    const ultimo = await d.vinculos.obterUltimoVinculo({ organizacaoId, unidadeId, conexaoId: conexao.id });
    if (ultimo?.estado === "rejeitado") {
      const motivo = ultimo.encerrado_motivo === "MERCHANT_JA_VINCULADO" ? MOTIVOS.LOJA_DE_OUTRA_UNIDADE : MOTIVOS.SEM_AUTORIZACAO;
      return { ...base, ...resultado(ESTADOS.ACAO_NECESSARIA, motivo) };
    }
    if (ultimo && (ultimo.estado === "informado" || ultimo.estado === "aguardando_validacao")) {
      const lojaMascarada = mascararId(ultimo.merchant_id);
      const freio = freioDaVerificacao(ultimo, d.agora().getTime());
      if (freio.esgotado) return { ...base, ...resultado(ESTADOS.ACAO_NECESSARIA, MOTIVOS.TENTATIVAS_ESGOTADAS), lojaMascarada };
      if (freio.proximaVerificacaoEm) {
        return { ...base, ...resultado(ESTADOS.VALIDANDO_LOJA, MOTIVOS.AGUARDANDO_NOVA_VERIFICACAO), lojaMascarada, proximaVerificacaoEm: freio.proximaVerificacaoEm, podeVerificar: false };
      }
      return { ...base, ...resultado(ESTADOS.VALIDANDO_LOJA), lojaMascarada, podeVerificar: true };
    }
    const { doToken, livres } = await lojasLivres({ conexao, cred, repo: d.repo, vinculos: d.vinculos });
    if (doToken.length > MAX_LOJAS_NO_TOKEN) return { ...base, ...resultado(ESTADOS.ACAO_NECESSARIA, MOTIVOS.MUITAS_LOJAS) };
    if (lojaPrincipal) {
      return livres.includes(lojaPrincipal)
        ? { ...base, ...resultado(ESTADOS.VALIDANDO_LOJA), lojaMascarada: mascararId(lojaPrincipal), podeVerificar: true }
        : { ...base, ...resultado(ESTADOS.ACAO_NECESSARIA, MOTIVOS.LOJA_CONECTADA_FORA_DO_TOKEN), lojaMascarada: mascararId(lojaPrincipal) };
    }
    if (doToken.length === 0) return { ...base, ...resultado(ESTADOS.ACAO_NECESSARIA, MOTIVOS.SEM_LOJA_NO_TOKEN) };
    if (livres.length === 0) return { ...base, ...resultado(ESTADOS.ACAO_NECESSARIA, MOTIVOS.LOJA_DE_OUTRA_UNIDADE) };
    if (livres.length > 1) return { ...base, ...resultado(ESTADOS.ACAO_NECESSARIA, MOTIVOS.VARIAS_LOJAS), opcoes: opcoesDe(livres) };
    return { ...base, ...resultado(ESTADOS.VALIDANDO_LOJA), lojaMascarada: mascararId(livres[0]), podeVerificar: true };
  } catch (e) {
    d.log("warn", "order_autoatendimento.status_falhou", { organizacaoId, unidadeId, erro: String(e?.message ?? e).slice(0, 200) });
    return { ...base, ...resultado(ESTADOS.VALIDANDO_LOJA), podeVerificar: true };
  }
}
