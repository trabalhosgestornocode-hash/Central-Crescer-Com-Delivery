// Contrato genérico de um provider de WhatsApp — desenhado para trocar
// Baileys pela API oficial da Meta (ou Z-API, etc.) SEM reescrever nenhum
// módulo acima desta camada (Policy Engine, Scheduler, Agente Crescer).
// Mesmo espírito de agente.provider.js (isola o resto do módulo do SDK da
// Anthropic) — aqui isola o resto do módulo do provider de WhatsApp.
//
// NINGUÉM além de whatsapp.service.js chama estes métodos diretamente (ver
// o teste arquitetural em test/comunicacao-arquitetura-provider.test.js).
//
// Checkpoint B: só existe FakeProvider (providers/fake.provider.js).
// Checkpoint C: BaileysProvider real, mesma forma exata.

/**
 * @typedef {object} StatusProvider
 * @property {boolean} conectado
 * @property {string} provider          ex.: "fake", "baileys", "meta"
 * @property {string|null} telefone     número conectado (E.164), quando aplicável
 * @property {string|null} atualizadoEm ISO timestamp
 */

/**
 * @typedef {object} ResultadoEnvio
 * @property {string} providerMessageId  id do provider para acompanhamento/idempotência
 * @property {string} enviadoEm          ISO timestamp
 */

/**
 * @typedef {object} WhatsAppProvider
 * @property {() => Promise<void>} connect
 * @property {() => Promise<void>} disconnect
 * @property {() => Promise<StatusProvider>} getStatus
 * @property {(params: {telefoneE164: string, texto: string, idempotencyKey: string}) => Promise<ResultadoEnvio>} sendText
 * @property {(params: {telefoneE164: string, urlImagem: string, legenda?: string, idempotencyKey: string}) => Promise<ResultadoEnvio>} sendImage
 * @property {(params: {telefoneE164: string, urlDocumento: string, nomeArquivo?: string, idempotencyKey: string}) => Promise<ResultadoEnvio>} sendDocument
 * @property {(handler: (mensagem: object) => void) => void} onMessage  registra callback p/ mensagem recebida (Checkpoint F)
 * @property {(params: {providerMessageId: string}) => Promise<void>} markAsRead
 * @property {(providerMessageId: string) => Promise<{status: string}>} getMessageStatus
 */

const METODOS_OBRIGATORIOS = [
  "connect", "disconnect", "getStatus",
  "sendText", "sendImage", "sendDocument",
  "onMessage", "markAsRead", "getMessageStatus",
];

/**
 * Confere que um objeto implementa a forma completa de WhatsAppProvider.
 * Usada na fábrica do provider (fail-fast se um provider novo esquecer um
 * método) e nos próprios testes do FakeProvider — nunca deixa a validação
 * "implícita" (um provider incompleto quebraria silenciosamente só quando
 * o método faltante fosse chamado, possivelmente em produção).
 * @param {object} provider
 * @throws {Error} se algum método obrigatório estiver ausente
 */
export function validarProvider(provider) {
  const faltando = METODOS_OBRIGATORIOS.filter((m) => typeof provider?.[m] !== "function");
  if (faltando.length) {
    throw new Error(`Provider de WhatsApp incompleto — método(s) ausente(s): ${faltando.join(", ")}`);
  }
  return provider;
}
