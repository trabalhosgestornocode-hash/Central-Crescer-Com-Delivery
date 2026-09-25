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
import { motivoBloqueioAutomacao } from "./inbound/inbound.contrato.js";

/** Recusa de envio porque a conta do WhatsApp conectada NÃO é a que o operador confirmou (ou nada está confirmado). O provider NÃO foi chamado. */
export class IdentidadeNaoConfirmadaError extends Error {
  constructor() { super("A conta do WhatsApp conectada ainda não foi confirmada. Confirme a conta na aba Conexão."); this.name = "IdentidadeNaoConfirmadaError"; this.code = "CONEXAO_NAO_CONFIRMADA"; this.preEnvio = true; }
}

/**
 * @param {{provider: import('./whatsapp.provider.js').WhatsAppProvider, identidadeConfirmada?: () => Promise<boolean>, semGateIdentidade?: boolean}} params
 *   - `identidadeConfirmada`: gate de identidade (comunicacao.identidade.js#criarGateIdentidade). FAIL-CLOSED: sem gate, NENHUM envio sai —
 *     a única exceção é `semGateIdentidade: true`, reservado a testes com provider falso (um teste estático proíbe seu uso em código de produção).
 */
export function criarWhatsAppService({ provider, identidadeConfirmada = null, semGateIdentidade = false }) {
  validarProvider(provider);

  /** A conta conectada é a confirmada? Qualquer dúvida ou exceção ⇒ false. */
  async function contaConfirmada() {
    if (semGateIdentidade === true) return true;
    if (typeof identidadeConfirmada !== "function") return false;
    try { return (await identidadeConfirmada()) === true; } catch { return false; }
  }
  /** TODO envio (texto, imagem, documento; worker, manual ou teste) passa por aqui ANTES do provider. */
  async function exigirContaConfirmada() { if (!(await contaConfirmada())) throw new IdentidadeNaoConfirmadaError(); }

  return {
    /** Gate de identidade (só leitura): usado pela política do worker para ADIAR sem consumir tentativa, e pelas telas. */
    identidadeConfirmada: contaConfirmada,

    /** @returns {Promise<import('./whatsapp.provider.js').StatusProvider>} */
    async getStatus() {
      return provider.getStatus();
    },

    /**
     * @param {{telefoneE164: string, texto: string, idempotencyKey: string}} params
     * @returns {Promise<import('./whatsapp.provider.js').ResultadoEnvio>}
     */
    async enviarTexto({ telefoneE164, texto, idempotencyKey }) {
      await exigirContaConfirmada();
      return provider.sendText({ telefoneE164, texto, idempotencyKey });
    },

    /** @param {{telefoneE164: string, urlImagem: string, legenda?: string, idempotencyKey: string}} params */
    async enviarImagem({ telefoneE164, urlImagem, legenda, idempotencyKey }) {
      await exigirContaConfirmada();
      return provider.sendImage({ telefoneE164, urlImagem, legenda, idempotencyKey });
    },

    /** @param {{telefoneE164: string, urlDocumento: string, nomeArquivo?: string, idempotencyKey: string}} params */
    async enviarDocumento({ telefoneE164, urlDocumento, nomeArquivo, idempotencyKey }) {
      await exigirContaConfirmada();
      return provider.sendDocument({ telefoneE164, urlDocumento, nomeArquivo, idempotencyKey });
    },

    /** @param {(mensagem: object) => void} handler */
    onMensagemRecebida(handler) {
      // Checkpoint F — 3ª camada: o handler (futuro Agente/automação) só vê evento elegível (LIVE, cliente direto, sem fromMe/falha/stub).
      provider.onMessage((mensagem) => { if (motivoBloqueioAutomacao(mensagem) === null) handler(mensagem); });
    },

    // ---- Aba Conexão: identidade e sessão da conta (NENHUM envia mensagem). Só aparecem se o provider tem a capacidade; o fake não tem. ----
    /** Estado vivo da sessão no Gateway (status, qrDisponivel, reconectando...). */
    async conexaoStatus() { return provider.statusConexao ? provider.statusConexao() : provider.getStatus(); },
    /** QR atual + metadados (só em memória; o chamador nunca o loga nem persiste). */
    async conexaoQr() { if (!provider.qrAtual) throw new Error("provider sem QR"); return provider.qrAtual(); },
    /** Perfil da conta conectada (nome, foto, recado, tipo, telefone). */
    async conexaoPerfil() { if (!provider.perfilConta) return { disponivel: false, motivo: "nao_suportado" }; return provider.perfilConta(); },
    /** Inicia o pareamento/conexão (a MESMA rota /connect do Gateway). */
    async conexaoExecutarOperacao(payload) {
      if (!provider.executarOperacao) throw new Error("Gateway sem suporte a operações protegidas");
      return provider.executarOperacao(payload);
    },
    async conexaoConectar() { return provider.connect(); },
    /** Desconecta a conta: desvincula o aparelho (melhor esforço) e reseta o auth do Gateway. Nunca toca no histórico. */
    async conexaoDesconectarConta({ desvincular = true } = {}) { if (!provider.desconectarConta) throw new Error("provider sem desconectarConta"); return provider.desconectarConta({ desvincular }); },
    /** Encerra um pareamento em andamento (fecha o socket sem apagar nada do histórico). */
    async conexaoEncerrar() { return provider.disconnect(); },

    /**
     * Central de Comunicação — foto de perfil (URL https) de UM número autorizado. Não envia nada. Provider sem a capacidade (ex.: fake) ⇒ sem foto.
     * Nunca lança: a ausência de foto jamais quebra a interface.
     * @param {{telefoneE164: string}} params
     * @returns {Promise<{url: string|null, motivo: string}>}
     */
    async buscarFotoPerfil({ telefoneE164 }) {
      if (typeof provider.fotoPerfil !== "function") return { url: null, motivo: "nao_suportado" };
      try { return await provider.fotoPerfil({ telefoneE164 }); } catch { return { url: null, motivo: "indisponivel" }; }
    },
  };
}
