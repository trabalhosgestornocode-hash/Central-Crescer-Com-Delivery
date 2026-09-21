// BaileysGatewayProvider — implementa a MESMA forma de WhatsAppProvider
// (whatsapp.provider.js) que providers/fake.provider.js, só que como
// cliente HTTP do gateway-whatsapp (processo separado, sem credencial
// administrativa nenhuma do banco — ver gateway-whatsapp/README.md).
// whatsapp.service.js continua sendo o ÚNICO chamador — este arquivo não
// muda esse invariante, só troca QUEM está do outro lado de connect/
// sendText/etc.
//
// CLASSIFICAÇÃO DE ERRO (Checkpoint C0/C1 + D.3-A/R). REGRA ÚNICA: na dúvida,
// INCERTO -> DELIVERY_UNKNOWN, NUNCA retry automático. Tabela definitiva:
//
//   RETRYAVEL  (só o que PROVA que socket.sendMessage() não pôde ter rodado)
//     * Gateway respondeu WHATSAPP_GATEWAY_NOT_CONNECTED (baileysSession.js#enviar
//       lança isto ANTES de qualquer envio, quando status !== CONNECTED);
//     * a conexão TCP NUNCA foi estabelecida: ECONNREFUSED, ENOTFOUND, EAI_AGAIN,
//       EHOSTUNREACH, ENETUNREACH, timeout de connect, "bad port", URL inválida;
//     * configuração ausente (gatewayUrl/segredo) — nenhuma rede é tocada.
//   PERMANENTE (determinístico; nunca retry, mesmo que nada tenha saído)
//     * WHATSAPP_GATEWAY_LOGGED_OUT, WHATSAPP_GATEWAY_INVALID_MESSAGE;
//     * pedido inválido barrado AQUI (telefone fora de E.164, texto vazio/longo,
//       idempotencyKey ausente, url não-https) — sem rede.
//     (consentimento/opt-out/empresa/tipo NÃO chegam aqui: são vetos de política,
//      decididos antes do provider — ver comunicacao.policy.js.)
//   INCERTO    (tudo o mais — não é possível provar que o envio não ocorreu)
//     * timeout; ECONNRESET/EPIPE/UND_ERR_SOCKET ("other side closed",
//       "terminated") depois de a conexão existir; conexão encerrada depois de a
//       requisição começar; qualquer 5xx; qualquer status fora do contrato (401,
//       404, 423, 502...); 2xx com corpo ilegível numa chamada de ENVIO; qualquer
//       erro desconhecido do Node/fetch.
//   O STATUS HTTP SOZINHO NÃO É PROVA: o Gateway devolve o MESMO
//   `500 WHATSAPP_GATEWAY_UNAVAILABLE` para um erro não tratado ANTES do
//   sendMessage e para uma falha DENTRO dele (server.js#errorHandler).
//   HOJE o Gateway só emite INDISPONIVEL, JA_CONECTADO, NAO_CONECTADO e SEM_LEASE
//   (LOGGED_OUT/410 e SEND_FAILED/502 existem em errors.js mas o caminho de envio
//   não os produz; INVALID_MESSAGE/400 é devolvido cru pela rota). Um Gateway
//   deslogado responde NOT_CONNECTED — logo RETRYAVEL até esgotar os retries.
//
// Este arquivo NÃO importa o cliente de banco nem vê nenhuma credencial
// privilegiada — ver test/whatsapp-gateway-seguranca.test.js e
// test/comunicacao-seguranca-gateway.test.js (mesma fronteira que
// fake.provider.js já respeita).

import { createHash, randomUUID } from "node:crypto";
import { validarProvider } from "../whatsapp.provider.js";
import { assinarRequisicao } from "../gateway/whatsappGateway.hmac.js";
import { motivoBloqueioAutomacao } from "../inbound/inbound.contrato.js";

/**
 * Tabela definitiva código-de-contrato-do-Gateway -> marcas do erro. Só o que
 * consta aqui recebe marca; qualquer OUTRO código/status fica SEM marca e vira
 * INCERTO em comunicacao.entrega.js#classificarErroEnvio.
 *   { preEnvio: true }    -> RETRYAVEL  (provado: não chegou ao sendMessage)
 *   { permanente: true }  -> PERMANENTE (determinístico; nunca retry)
 */
export const MARCAS_POR_CODIGO_GATEWAY = Object.freeze({
  WHATSAPP_GATEWAY_NOT_CONNECTED: Object.freeze({ preEnvio: true }),
  WHATSAPP_GATEWAY_LOGGED_OUT: Object.freeze({ permanente: true }),
  WHATSAPP_GATEWAY_INVALID_MESSAGE: Object.freeze({ permanente: true }),
});

/**
 * Erros de sistema que só existem na fase de CONEXÃO — se o fetch falhou
 * com um deles, o socket nunca chegou a estar aberto e nada da requisição
 * saiu. ECONNRESET/EPIPE/UND_ERR_SOCKET NÃO estão aqui de propósito: dizem
 * que uma conexão EXISTIU.
 */
const CODIGOS_CONEXAO_NAO_ESTABELECIDA = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * `true` SOMENTE quando a falha do fetch prova que a conexão nunca foi
 * estabelecida (ou que a URL nem é válida) — logo nenhum byte de requisição
 * saiu. Qualquer outra coisa (inclusive "fetch failed" sem `cause`
 * reconhecível) -> `false` -> INCERTO.
 *
 * `fetch` (undici) reporta a falha real em `error.cause`; com happy-eyeballs
 * (localhost, IPv4+IPv6) a causa é um AggregateError e TODOS os
 * sub-erros têm de ser de conexão não estabelecida.
 * @param {any} e
 */
export function falhaProvaQueNadaSaiu(e) {
  // URL inválida: o fetch lança ANTES de qualquer rede ("Failed to parse URL", cause.code ERR_INVALID_URL).
  if (e?.code === "ERR_INVALID_URL" || e?.cause?.code === "ERR_INVALID_URL"
    || (e instanceof TypeError && /invalid url|failed to parse url/i.test(String(e?.message)))) return true;
  const causa = e?.cause;
  if (!causa) return false;
  const itens = Array.isArray(causa.errors) && causa.errors.length ? causa.errors : [causa];
  return itens.every((c) => CODIGOS_CONEXAO_NAO_ESTABELECIDA.has(c?.code)
    || (c?.code === "ETIMEDOUT" && c?.syscall === "connect")
    // fetch recusa "bad ports" (ex.: 1, 25, 6667...) ANTES de criar qualquer conexão.
    || /^bad port$/i.test(String(c?.message ?? "")));
}

const REGEX_E164 = /^\+[1-9][0-9]{7,14}$/; // mesmo formato do check de contatos_whatsapp
export const MAX_TEXTO_ENVIO = 4096;

/** Motivo de invalidez do pedido de envio, ou `null` se válido. Roda ANTES de qualquer rede. */
function motivoPedidoInvalido({ telefoneE164, idempotencyKey }, extra = {}) {
  if (typeof telefoneE164 !== "string" || !REGEX_E164.test(telefoneE164)) return "telefoneE164 fora do formato E.164";
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200) return "idempotencyKey ausente/vazia";
  if ("texto" in extra && (typeof extra.texto !== "string" || !extra.texto.trim() || extra.texto.length > MAX_TEXTO_ENVIO)) return `texto ausente/vazio ou maior que ${MAX_TEXTO_ENVIO} caracteres`;
  if ("url" in extra && (typeof extra.url !== "string" || !/^https:\/\//i.test(extra.url))) return "url ausente ou não-https";
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.gatewayUrl
 * @param {string} opts.segredoHmac
 * @param {number} [opts.timeoutMs]
 * @returns {import('../whatsapp.provider.js').WhatsAppProvider}
 */
export function criarBaileysGatewayProvider({ gatewayUrl, segredoHmac, timeoutMs = 15_000 }) {
  const handlersMensagem = [];
  const url = String(gatewayUrl ?? "").replace(/\/+$/, "");

  function erroEnvio(mensagem, { preEnvio = false, permanente = false } = {}) {
    const e = new Error(mensagem);
    if (preEnvio) e.preEnvio = true;
    if (permanente) e.permanente = true;
    // Marcador INDEPENDENTE do valor de preEnvio/permanente (que podem
    // legitimamente ser `false`/ausentes no caso INCERTO — ver HTTP 5xx
    // abaixo). Sem isto, o catch mais externo não conseguia distinguir "já
    // classifiquei isto como INCERTO de propósito" de "isto nunca passou
    // pela classificação" — e reclassificava um INCERTO como preEnvio:true
    // (erro de rede), quebrando a garantia de nunca fazer retry cego.
    e._classificadoPeloGateway = true;
    return e;
  }

  /** Pedido de envio inválido: PERMANENTE e comprovadamente pré-envio (nenhuma rede tocada). */
  function rejeitarPedidoInvalido(motivo) {
    return erroEnvio(`BAILEYS_GATEWAY_INVALID_MESSAGE: ${motivo}`, { preEnvio: true, permanente: true });
  }

  /**
   * @param {string} metodo
   * @param {string} caminho
   * @param {object} [corpoObj]
   * @param {{envio?: boolean}} [opcoes]  `envio: true` = chamada que pode gerar mensagem no WhatsApp
   *   (leitura estrita da resposta: 2xx ilegível NÃO é sucesso, é INCERTO).
   */
  async function chamar(metodo, caminho, corpoObj, { envio = false } = {}) {
    if (!url || !segredoHmac) {
      // Configuração ausente é um "nada saiu" claro — seguro reivindicar de novo.
      throw erroEnvio("BAILEYS_GATEWAY_DISABLED: gatewayUrl/segredoHmac ausente.", { preEnvio: true });
    }

    const corpo = corpoObj === undefined ? "" : JSON.stringify(corpoObj);
    const headers = assinarRequisicao({ segredo: segredoHmac, metodo, caminho, corpo });
    if (corpo) headers["Content-Type"] = "application/json";

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${url}${caminho}`, { method: metodo, headers, body: corpo || undefined, signal: ctrl.signal });
      const texto = await resp.text();
      let json;
      let legivel = true;
      try { json = texto ? JSON.parse(texto) : {}; } catch { json = {}; legivel = false; }

      if (!resp.ok) {
        const codigo = json?.error;
        throw erroEnvio(`BAILEYS_GATEWAY_HTTP_${resp.status}: ${codigo ?? "erro desconhecido"}`, MARCAS_POR_CODIGO_GATEWAY[codigo] ?? {});
      }
      if (envio && (!legivel || json === null || typeof json !== "object" || Array.isArray(json))) {
        // 2xx mas não sabemos ler o que o Gateway respondeu: o envio PODE ter
        // acontecido. Sem marcação -> INCERTO.
        throw erroEnvio("BAILEYS_GATEWAY_RESPOSTA_ILEGIVEL: 2xx com corpo que não é um objeto JSON.");
      }
      return json;
    } catch (e) {
      if (e?._classificadoPeloGateway) throw e; // já classificado acima (inclusive INCERTO, sem marcação)
      if (e?.name === "AbortError") {
        // Timeout: NUNCA marcar preEnvio/permanente — vira INCERTO. O
        // Gateway pode ter processado o envio antes da resposta voltar.
        throw erroEnvio("BAILEYS_GATEWAY_TIMEOUT: sem resposta do Gateway dentro do prazo.");
      }
      if (falhaProvaQueNadaSaiu(e)) {
        // A conexão nunca foi estabelecida — nada saiu do backend.
        throw erroEnvio(`BAILEYS_GATEWAY_UNREACHABLE: ${e?.cause?.code ?? e?.code ?? e?.message ?? e}`, { preEnvio: true });
      }
      // Qualquer outra falha de transporte (conexão que existiu e caiu,
      // reset, socket fechado no meio da resposta, "terminated"...): a
      // requisição PODE ter chegado ao Gateway e o sendMessage rodado.
      throw erroEnvio(`BAILEYS_GATEWAY_TRANSPORTE_AMBIGUO: ${e?.cause?.code ?? e?.code ?? e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const provider = {
    async connect() { await chamar("POST", "/internal/whatsapp/connect", {}); },
    async disconnect() { await chamar("POST", "/internal/whatsapp/disconnect", {}); },
    async getStatus() { return chamar("GET", "/internal/whatsapp/status"); },
    // ---- fora do contrato WhatsAppProvider (Checkpoint C3.5-B.2) — RESET
    // explícito do operador: invalida o auth state antigo (revogado/
    // reparado fora de banda, ex.: o usuário removeu o dispositivo pelo
    // celular) para permitir um pareamento novo controlado. Deliberadamente
    // NÃO faz parte do contrato genérico (METODOS_OBRIGATORIOS em
    // whatsapp.provider.js) — é uma capacidade específica de auth
    // state cifrado do Gateway Baileys, sem equivalente natural numa API
    // oficial (Meta/Z-API não tem "ciphertext de sessão" para resetar).
    async reset() { await chamar("POST", "/internal/whatsapp/reset", {}); },

    async sendText({ telefoneE164, texto, idempotencyKey }) {
      const invalido = motivoPedidoInvalido({ telefoneE164, idempotencyKey }, { texto });
      if (invalido) throw rejeitarPedidoInvalido(invalido);
      return chamar("POST", "/internal/whatsapp/messages", { telefoneE164, tipo: "text", texto, idempotencyKey }, { envio: true });
    },
    async sendImage({ telefoneE164, urlImagem, legenda, idempotencyKey }) {
      const invalido = motivoPedidoInvalido({ telefoneE164, idempotencyKey }, { url: urlImagem });
      if (invalido) throw rejeitarPedidoInvalido(invalido);
      return chamar("POST", "/internal/whatsapp/messages", { telefoneE164, tipo: "image", urlImagem, legenda, idempotencyKey }, { envio: true });
    },
    async sendDocument({ telefoneE164, urlDocumento, nomeArquivo, idempotencyKey }) {
      const invalido = motivoPedidoInvalido({ telefoneE164, idempotencyKey }, { url: urlDocumento });
      if (invalido) throw rejeitarPedidoInvalido(invalido);
      return chamar("POST", "/internal/whatsapp/messages", { telefoneE164, tipo: "document", urlDocumento, nomeArquivo, idempotencyKey }, { envio: true });
    },

    onMessage(handler) { handlersMensagem.push(handler); },

    async markAsRead({ providerMessageId, telefoneE164 }) {
      await chamar("POST", `/internal/whatsapp/messages/${encodeURIComponent(providerMessageId)}/read`, { telefoneE164 });
    },
    async getMessageStatus(providerMessageId) {
      return chamar("GET", `/internal/whatsapp/messages/${encodeURIComponent(providerMessageId)}/status`);
    },

    // ---- fora do contrato WhatsAppProvider: ponto de entrada usado por
    // whatsappGateway.routes.js#/eventos/mensagem-recebida para alimentar
    // os handlers registrados via onMessage(). O Gateway EMPURRA o evento
    // por HTTP (ele não pode ser "puxado" — mensagem recebida é sempre
    // push); este é o único jeito de conectar aquele POST a este provider
    // sem quebrar "só whatsapp.service.js chama o provider de envio".
    // Checkpoint F — defesa em profundidade: mesmo chamado direto, nada fora do contrato/elegível (LIVE, cliente direto, sem fromMe/falha/stub) chega aos handlers.
    _receberEventoMensagem(mensagem) {
      if (motivoBloqueioAutomacao(mensagem) !== null) return;
      handlersMensagem.forEach((h) => h(mensagem));
    },
  };

  return validarProvider(provider);
}

// Exportado só para o teste do formato canônico de erro/classificação.
export const _hashCorpo = (corpo) => createHash("sha256").update(corpo ?? "").digest("hex");
export const _novoIdempotencyKey = () => randomUUID();
