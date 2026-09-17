// WhatsAppService — a ÚNICA camada que chama Provider.send*/connect/etc.
//
// INVARIANTE ARQUITETURAL (ajuste aprovado): "nenhum ponto do sistema pode
// chamar Provider.send* diretamente" — só este arquivo importa e invoca os
// métodos de envio de um WhatsAppProvider. Todo chamador (Scheduler/fila)
// passa por comunicacao.policy.js#avaliarEnvio ANTES de chegar aqui — este
// serviço não reavalia política, só executa o que já foi aprovado.
//
// Verificação estática desta invariante: test/comunicacao-arquitetura-provider.test.js
// escaneia o módulo inteiro e falha se `.sendText(`/`.sendImage(`/`.sendDocument(`
// aparecer em qualquer arquivo além deste.

import { validarProvider } from "./whatsapp.provider.js";

/**
 * @param {{provider: import('./whatsapp.provider.js').WhatsAppProvider}} params
 */
export function criarWhatsAppService({ provider }) {
  validarProvider(provider);

  return {
    /** @returns {Promise<import('./whatsapp.provider.js').StatusProvider>} */
    async getStatus() {
      return provider.getStatus();
    },

    /**
     * @param {{telefoneE164: string, texto: string, idempotencyKey: string}} params
     * @returns {Promise<import('./whatsapp.provider.js').ResultadoEnvio>}
     */
    async enviarTexto({ telefoneE164, texto, idempotencyKey }) {
      return provider.sendText({ telefoneE164, texto, idempotencyKey });
    },

    /** @param {{telefoneE164: string, urlImagem: string, legenda?: string, idempotencyKey: string}} params */
    async enviarImagem({ telefoneE164, urlImagem, legenda, idempotencyKey }) {
      return provider.sendImage({ telefoneE164, urlImagem, legenda, idempotencyKey });
    },

    /** @param {{telefoneE164: string, urlDocumento: string, nomeArquivo?: string, idempotencyKey: string}} params */
    async enviarDocumento({ telefoneE164, urlDocumento, nomeArquivo, idempotencyKey }) {
      return provider.sendDocument({ telefoneE164, urlDocumento, nomeArquivo, idempotencyKey });
    },

    /** @param {(mensagem: object) => void} handler */
    onMensagemRecebida(handler) {
      provider.onMessage(handler);
    },
  };
}
