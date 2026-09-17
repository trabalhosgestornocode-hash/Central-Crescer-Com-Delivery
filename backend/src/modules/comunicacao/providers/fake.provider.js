// FakeProvider — implementação em memória do WhatsAppProvider, para testar
// TODO o pipeline (Scheduler, Policy Engine, fila, claim, retry) sem
// depender de Baileys/rede real. Checkpoint C troca isto por um
// BaileysProvider com a MESMA forma exata (whatsapp.provider.js).
//
// Grava cada envio em `mensagensEnviadas` (inspecionável pelos testes) e
// permite injetar falhas determinísticas — nunca aleatório, sempre
// controlado pelo teste que chama.

import { randomUUID } from "node:crypto";
import { validarProvider } from "../whatsapp.provider.js";

/**
 * @param {object} [opts]
 * @param {boolean} [opts.conectado]      estado inicial de conexão
 * @param {string|null} [opts.telefone]   número "conectado" simulado
 * @returns {import('../whatsapp.provider.js').WhatsAppProvider & {
 *   mensagensEnviadas: Array<object>,
 *   falharProximoEnvio: (erro: {mensagem: string, permanente?: boolean, preEnvio?: boolean}) => void,
 *   definirConectado: (valor: boolean) => void,
 * }}
 */
export function criarFakeProvider(opts = {}) {
  let conectado = opts.conectado ?? true;
  let telefone = opts.telefone ?? "+5511999990000";
  const mensagensEnviadas = [];
  const handlersMensagem = [];
  /** @type {null | {mensagem: string, permanente?: boolean, preEnvio?: boolean}} */
  let proximaFalha = null;

  function checarConexao() {
    if (!conectado) {
      const e = new Error("PROVIDER_OFFLINE: fake provider não está conectado.");
      e.codigo = "PROVIDER_OFFLINE";
      // Recusa a conexão ANTES de qualquer tentativa real — sabemos com
      // certeza que nada saiu. Ver comunicacao.entrega.js#classificarErroEnvio.
      e.preEnvio = true;
      throw e;
    }
  }

  function checarFalhaInjetada() {
    if (!proximaFalha) return;
    const falha = proximaFalha;
    proximaFalha = null; // consome — só vale para a PRÓXIMA chamada, nunca trava em loop
    const e = new Error(falha.mensagem);
    e.permanente = !!falha.permanente;
    // Por padrão NENHUMA marcação (nem preEnvio, nem permanente) — simula o
    // caso ambíguo (timeout/conexão caída) de propósito, para exercitar o
    // caminho DELIVERY_UNKNOWN sem que o teste precise lembrar disso.
    e.preEnvio = !!falha.preEnvio;
    throw e;
  }

  async function enviar({ idempotencyKey }) {
    checarConexao();
    checarFalhaInjetada();
    // Idempotência do lado do PROVIDER (defesa extra, além da UNIQUE em
    // comunicacao_mensagens.idempotency_key): reenviar a mesma chave devolve
    // o MESMO resultado, nunca dispara um segundo envio real.
    const existente = mensagensEnviadas.find((m) => m.idempotencyKey === idempotencyKey);
    if (existente) return { providerMessageId: existente.providerMessageId, enviadoEm: existente.enviadoEm };

    const providerMessageId = `fake-${randomUUID()}`;
    const enviadoEm = new Date().toISOString();
    mensagensEnviadas.push({ idempotencyKey, providerMessageId, enviadoEm });
    return { providerMessageId, enviadoEm };
  }

  const provider = {
    async connect() { conectado = true; },
    async disconnect() { conectado = false; },
    async getStatus() {
      return { conectado, provider: "fake", telefone: conectado ? telefone : null, atualizadoEm: new Date().toISOString() };
    },
    async sendText({ telefoneE164, texto, idempotencyKey }) {
      const r = await enviar({ idempotencyKey });
      mensagensEnviadas[mensagensEnviadas.length - 1].tipo = "text";
      mensagensEnviadas[mensagensEnviadas.length - 1].telefoneE164 = telefoneE164;
      mensagensEnviadas[mensagensEnviadas.length - 1].texto = texto;
      return r;
    },
    async sendImage({ telefoneE164, urlImagem, legenda, idempotencyKey }) {
      const r = await enviar({ idempotencyKey });
      mensagensEnviadas[mensagensEnviadas.length - 1].tipo = "image";
      mensagensEnviadas[mensagensEnviadas.length - 1].telefoneE164 = telefoneE164;
      mensagensEnviadas[mensagensEnviadas.length - 1].urlImagem = urlImagem;
      mensagensEnviadas[mensagensEnviadas.length - 1].legenda = legenda ?? null;
      return r;
    },
    async sendDocument({ telefoneE164, urlDocumento, nomeArquivo, idempotencyKey }) {
      const r = await enviar({ idempotencyKey });
      mensagensEnviadas[mensagensEnviadas.length - 1].tipo = "document";
      mensagensEnviadas[mensagensEnviadas.length - 1].telefoneE164 = telefoneE164;
      mensagensEnviadas[mensagensEnviadas.length - 1].urlDocumento = urlDocumento;
      mensagensEnviadas[mensagensEnviadas.length - 1].nomeArquivo = nomeArquivo ?? null;
      return r;
    },
    onMessage(handler) { handlersMensagem.push(handler); },
    async markAsRead(/* { providerMessageId } */) { /* no-op no fake */ },
    async getMessageStatus(providerMessageId) {
      const m = mensagensEnviadas.find((x) => x.providerMessageId === providerMessageId);
      return { status: m ? "SENT" : "UNKNOWN" };
    },

    // ---- só para teste (fora do contrato WhatsAppProvider) ----
    mensagensEnviadas,
    falharProximoEnvio(erro) { proximaFalha = erro; },
    definirConectado(valor) { conectado = !!valor; },
    /** Simula uma mensagem recebida — dispara os handlers registrados via onMessage. */
    simularRecebimento(mensagem) { handlersMensagem.forEach((h) => h(mensagem)); },
  };

  return validarProvider(provider);
}
