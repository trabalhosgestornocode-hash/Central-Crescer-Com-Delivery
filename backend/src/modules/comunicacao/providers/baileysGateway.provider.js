// BaileysGatewayProvider — implementa a MESMA forma de WhatsAppProvider
// (whatsapp.provider.js) que providers/fake.provider.js, só que como
// cliente HTTP do gateway-whatsapp (processo separado, sem credencial
// administrativa nenhuma do banco — ver gateway-whatsapp/README.md).
// whatsapp.service.js continua sendo o ÚNICO chamador — este arquivo não
// muda esse invariante, só troca QUEM está do outro lado de connect/
// sendText/etc.
//
// CLASSIFICAÇÃO DE ERRO (Checkpoint C0/C1, item 17/22 — DELIVERY_UNKNOWN):
// a resposta HTTP do Gateway já diz se algo saiu ou não —
//   * NOT_CONNECTED / LOGGED_OUT / INVALID_MESSAGE -> preEnvio: true (o
//     Gateway garante que nada foi tentado no WhatsApp).
//   * LOGGED_OUT / INVALID_MESSAGE, além de preEnvio, também são permanente:
//     true (não é ambiguidade, é uma resposta definitiva do Gateway).
//   * qualquer OUTRO erro HTTP (5xx, corpo inesperado) -> SEM marcação —
//     vira INCERTO em comunicacao.entrega.js#classificarErroEnvio, de
//     propósito: não sabemos se o envio chegou a sair.
//   * erro de REDE antes de qualquer resposta (conexão recusada, DNS) ->
//     preEnvio: true (nada saiu do backend).
//   * TIMEOUT (nosso AbortController expirou) -> SEM marcação -> INCERTO
//     (o Gateway pode ter recebido e processado antes da resposta voltar).
//
// Este arquivo NÃO importa o cliente de banco nem vê nenhuma credencial
// privilegiada — ver test/whatsapp-gateway-seguranca.test.js e
// test/comunicacao-seguranca-gateway.test.js (mesma fronteira que
// fake.provider.js já respeita).

import { createHash, randomUUID } from "node:crypto";
import { validarProvider } from "../whatsapp.provider.js";
import { assinarRequisicao } from "../gateway/whatsappGateway.hmac.js";

const CODIGOS_PREENVIO = new Set([
  "WHATSAPP_GATEWAY_NOT_CONNECTED",
  "WHATSAPP_GATEWAY_LOGGED_OUT",
  "WHATSAPP_GATEWAY_INVALID_MESSAGE",
]);
const CODIGOS_PERMANENTES = new Set([
  "WHATSAPP_GATEWAY_LOGGED_OUT",
  "WHATSAPP_GATEWAY_INVALID_MESSAGE",
]);

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

  async function chamar(metodo, caminho, corpoObj) {
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
      try { json = texto ? JSON.parse(texto) : {}; } catch { json = {}; }

      if (!resp.ok) {
        const codigo = json?.error;
        throw erroEnvio(`BAILEYS_GATEWAY_HTTP_${resp.status}: ${codigo ?? "erro desconhecido"}`, {
          preEnvio: CODIGOS_PREENVIO.has(codigo),
          permanente: CODIGOS_PERMANENTES.has(codigo),
        });
      }
      return json;
    } catch (e) {
      if (e?._classificadoPeloGateway) throw e; // já classificado acima (inclusive INCERTO, sem marcação)
      if (e?.name === "AbortError") {
        // Timeout: NUNCA marcar preEnvio/permanente — vira INCERTO. O
        // Gateway pode ter processado o envio antes da resposta voltar.
        throw erroEnvio("BAILEYS_GATEWAY_TIMEOUT: sem resposta do Gateway dentro do prazo.");
      }
      // Erro de rede (conexão recusada, DNS, etc.) ANTES de qualquer
      // resposta — nada saiu do backend.
      throw erroEnvio(`BAILEYS_GATEWAY_UNREACHABLE: ${e?.message ?? e}`, { preEnvio: true });
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
      return chamar("POST", "/internal/whatsapp/messages", { telefoneE164, tipo: "text", texto, idempotencyKey });
    },
    async sendImage({ telefoneE164, urlImagem, legenda, idempotencyKey }) {
      return chamar("POST", "/internal/whatsapp/messages", { telefoneE164, tipo: "image", urlImagem, legenda, idempotencyKey });
    },
    async sendDocument({ telefoneE164, urlDocumento, nomeArquivo, idempotencyKey }) {
      return chamar("POST", "/internal/whatsapp/messages", { telefoneE164, tipo: "document", urlDocumento, nomeArquivo, idempotencyKey });
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
    _receberEventoMensagem(mensagem) { handlersMensagem.forEach((h) => h(mensagem)); },
  };

  return validarProvider(provider);
}

// Exportado só para o teste do formato canônico de erro/classificação.
export const _hashCorpo = (corpo) => createHash("sha256").update(corpo ?? "").digest("hex");
export const _novoIdempotencyKey = () => randomUUID();
