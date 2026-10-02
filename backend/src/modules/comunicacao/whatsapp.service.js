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
import { modoPermiteEnvioReal } from "./comunicacao.constants.js";
import { lerAllowlistRetryResend } from "./retryResendAllowlist.js";

/** Recusa de envio porque a conta do WhatsApp conectada NÃO é a que o operador confirmou (ou nada está confirmado). O provider NÃO foi chamado. */
export class IdentidadeNaoConfirmadaError extends Error {
  constructor() { super("A conta do WhatsApp conectada ainda não foi confirmada. Confirme a conta na aba Conexão."); this.name = "IdentidadeNaoConfirmadaError"; this.code = "CONEXAO_NAO_CONFIRMADA"; this.preEnvio = true; }
}

/**
 * KILL SWITCH na FRONTEIRA FINAL DO PROVIDER. Com `modo = DISABLED` (ou ausente/desconhecido) NENHUM envio real chega ao provider — nem automático, nem
 * teste controlado, nem resposta humana da Central, nem qualquer caminho inesperado. O provider NÃO foi chamado (preEnvio). Semântica única e inequívoca:
 * DISABLED = WhatsApp completamente incapaz de realizar envio real. Só leitura/simulação (dry-run) continuam possíveis.
 */
export class ModoDesabilitadoError extends Error {
  constructor(modo = null) {
    super("Envio bloqueado: o módulo WhatsApp está em modo DISABLED. Altere o modo operacional antes de realizar um envio real.");
    this.name = "ModoDesabilitadoError"; this.code = "MODO_DISABLED"; this.preEnvio = true; this.modo = modo;
  }
}

/**
 * @param {{provider: import('./whatsapp.provider.js').WhatsAppProvider, identidadeConfirmada?: () => Promise<boolean>, semGateIdentidade?: boolean}} params
 *   - `identidadeConfirmada`: gate de identidade (comunicacao.identidade.js#criarGateIdentidade). FAIL-CLOSED: sem gate, NENHUM envio sai —
 *     a única exceção é `semGateIdentidade: true`, reservado a testes com provider falso (um teste estático proíbe seu uso em código de produção).
 *   - `modoAtual`: lê o modo global (comunicacao.config.js#modoAtual). FAIL-CLOSED: sem ele, ou se a leitura falhar, NENHUM envio sai — a única exceção é
 *     `semGateModo: true`, reservado a testes com provider falso (mesmo teste estático).
 *   - `allowlistRetryResend`: modules/comunicacao/retryResendAllowlist.js (padrão: lida da env). Decide, por `contatoId`, se a mensagem vai ao Gateway marcada
 *     `retryResend: true` (guardada para reenvio sob retry receipt). Fail closed: sem contatoId, contato fora da lista ou lista vazia/inválida ⇒ sem marca.
 *     Só isso muda: o envio em si (gates, provider, corpo) é idêntico para todos.
 */
export function criarWhatsAppService({ provider, identidadeConfirmada = null, semGateIdentidade = false, modoAtual = null, semGateModo = false, allowlistRetryResend = lerAllowlistRetryResend() }) {
  validarProvider(provider);
  /** `true` só para contato autorizado; qualquer dúvida ⇒ `undefined` (o provider nem inclui o campo). */
  const retryResendPara = (contatoId) => {
    try { return allowlistRetryResend?.permite?.(contatoId) === true ? true : undefined; } catch { return undefined; }
  };

  /** A conta conectada é a confirmada? Qualquer dúvida ou exceção ⇒ false. */
  async function contaConfirmada() {
    if (semGateIdentidade === true) return true;
    if (typeof identidadeConfirmada !== "function") return false;
    try { return (await identidadeConfirmada()) === true; } catch { return false; }
  }
  /** O modo global permite envio real? Qualquer dúvida (sem leitor, exceção, valor desconhecido, DISABLED) ⇒ false. */
  async function modoPermiteEnvio() {
    if (semGateModo === true) return true;
    if (typeof modoAtual !== "function") return false;
    try { return modoPermiteEnvioReal(await modoAtual()); } catch { return false; }
  }
  /** TODO envio (texto, imagem, documento; worker, manual ou teste) passa por aqui ANTES do provider: 1º o KILL SWITCH, depois a identidade. */
  async function exigirContaConfirmada() {
    if (!(await modoPermiteEnvio())) throw new ModoDesabilitadoError();
    if (!(await contaConfirmada())) throw new IdentidadeNaoConfirmadaError();
  }

  return {
    /** Kill switch (só leitura): o modo global permite envio real agora? Usado pelas telas e pré-checagens. */
    modoPermiteEnvio,

    /** Gate de identidade (só leitura): usado pela política do worker para ADIAR sem consumir tentativa, e pelas telas. */
    identidadeConfirmada: contaConfirmada,

    /** @returns {Promise<import('./whatsapp.provider.js').StatusProvider>} */
    async getStatus() {
      return provider.getStatus();
    },

    /**
     * @param {{telefoneE164: string, texto: string, idempotencyKey: string, contatoId?: string|null}} params
     *   `contatoId` só alimenta a allowlist do reenvio sob retry (nunca vai ao Gateway).
     * @returns {Promise<import('./whatsapp.provider.js').ResultadoEnvio>}
     */
    async enviarTexto({ telefoneE164, texto, idempotencyKey, contatoId = null }) {
      await exigirContaConfirmada();
      return provider.sendText({ telefoneE164, texto, idempotencyKey, retryResend: retryResendPara(contatoId) });
    },

    /** @param {{telefoneE164: string, urlImagem: string, legenda?: string, idempotencyKey: string, contatoId?: string|null}} params */
    async enviarImagem({ telefoneE164, urlImagem, legenda, idempotencyKey, contatoId = null }) {
      await exigirContaConfirmada();
      return provider.sendImage({ telefoneE164, urlImagem, legenda, idempotencyKey, retryResend: retryResendPara(contatoId) });
    },

    /** @param {{telefoneE164: string, urlDocumento: string, nomeArquivo?: string, idempotencyKey: string, contatoId?: string|null}} params */
    async enviarDocumento({ telefoneE164, urlDocumento, nomeArquivo, idempotencyKey, contatoId = null }) {
      await exigirContaConfirmada();
      return provider.sendDocument({ telefoneE164, urlDocumento, nomeArquivo, idempotencyKey, retryResend: retryResendPara(contatoId) });
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
