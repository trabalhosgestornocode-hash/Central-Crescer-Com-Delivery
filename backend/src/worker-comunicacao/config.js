// Config do worker de comunicação — SEM segunda fonte de verdade para regra de
// negócio: `modo`, janelas, cooldowns, limites etc. continuam só em
// comunicacao.config.js (lido do banco). Este arquivo só resolve o que é
// genuinamente operacional do PROCESSO (intervalo do laço, credenciais para
// falar com o Gateway, porta do /health).
//
// Parsing FAIL-CLOSED (mesmo espírito de gateway-whatsapp/src/config.js e de
// whatsappGateway.bootstrap.js#lerLimiteAuthStateBytes): ausente -> default;
// presente e inválido (0, negativo, decimal, texto, NaN, abaixo do mínimo
// defensivo) -> lança, o boot morre. Nunca "assume um valor plausível".

const INTERVALO_PADRAO_MS = 60_000; // 1 ciclo/minuto
const INTERVALO_MINIMO_MS = 5_000; // defesa contra polling agressivo por engano

/**
 * @param {string|undefined} valorBruto
 * @param {number} padrao
 * @param {{minimo?: number}} [opts]
 */
function inteiroPositivoEnvOuPadrao(valorBruto, padrao, { minimo } = {}) {
  if (valorBruto === undefined || valorBruto === null || String(valorBruto).trim() === "") return padrao;
  const texto = String(valorBruto).trim();
  if (!/^\d+$/.test(texto)) {
    throw new Error(`precisa ser um inteiro positivo em milissegundos, sem sinal e sem casas decimais (recebido: "${valorBruto}")`);
  }
  const n = Number(texto);
  if (!(n > 0)) throw new Error(`precisa ser > 0 (recebido: ${n})`);
  if (minimo !== undefined && n < minimo) throw new Error(`(${n}) não pode ser menor que o mínimo defensivo de ${minimo} ms`);
  return n;
}

/** @param {string|undefined} [valorEnv] */
export function lerIntervaloMs(valorEnv) {
  try {
    return inteiroPositivoEnvOuPadrao(valorEnv, INTERVALO_PADRAO_MS, { minimo: INTERVALO_MINIMO_MS });
  } catch (e) {
    throw new Error(`COMUNICACAO_WORKER_INTERVAL_MS ${e.message}`);
  }
}

// Mesma política de esquema já usada pelo projeto para URL (ver
// backend/src/shared/validar.js#urlOpcional: aceita http:/https:, recusa o
// resto — inclusive esquemas tipo `javascript:`). Aceitar http: de propósito:
// serviços privados do Render (como o próprio gateway-whatsapp) são
// endereçados internamente sem TLS, e é o mesmo esquema usado em
// desenvolvimento local (http://127.0.0.1:PORTA) — nenhuma política nova
// incompatível com o que já existe. urlOpcional() não é reaproveitável aqui
// (lança ApiError de requisição HTTP e trata ausência como válida); a regra
// de protocolo é a mesma, só o formato do erro muda (config de boot).
function validarGatewayUrl(valorBruto) {
  if (valorBruto === undefined || valorBruto === null || String(valorBruto).trim() === "") {
    throw new Error("WHATSAPP_GATEWAY_URL ausente — obrigatória para o worker poder chamar o Gateway.");
  }
  const texto = String(valorBruto).trim();
  let url;
  try {
    url = new URL(texto);
  } catch {
    throw new Error(`WHATSAPP_GATEWAY_URL inválida: "${texto}" não é uma URL bem formada.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`WHATSAPP_GATEWAY_URL precisa começar com http:// ou https:// (recebido esquema "${url.protocol}").`);
  }
  return texto;
}

// Só presença — mesmo contrato que baileysGateway.provider.js já exige
// (`segredoHmac` ausente/vazio -> BAILEYS_GATEWAY_DISABLED). Nenhum
// comprimento mínimo é imposto aqui: o provider não impõe um, e inventar um
// novo aqui duplicaria/divergiria da regra dele.
function validarSegredoHmac(valorBruto) {
  if (valorBruto === undefined || valorBruto === null || String(valorBruto).trim() === "") {
    throw new Error("WHATSAPP_GATEWAY_SECRET ausente — obrigatório para assinar requisições ao Gateway.");
  }
  return String(valorBruto);
}

/**
 * Lê toda a config do processo. FAIL-CLOSED: intervalo, URL do Gateway e
 * segredo HMAC ausentes/inválidos derrubam o boot — o worker de produção
 * nunca sobe "meio configurado". (`modo=DISABLED` continua garantindo 0
 * chamadas ao provider mesmo com config válida — ver loop.js; validar a
 * PRESENÇA da config no boot não é uma chamada ao provider.)
 * @param {NodeJS.ProcessEnv} [env]
 */
export function carregarConfig(env = process.env) {
  return {
    intervalMs: lerIntervaloMs(env.COMUNICACAO_WORKER_INTERVAL_MS),
    gatewayUrl: validarGatewayUrl(env.WHATSAPP_GATEWAY_URL),
    segredoHmac: validarSegredoHmac(env.WHATSAPP_GATEWAY_SECRET),
    porta: Number(env.PORT) || 8080,
  };
}

export const _INTERVALO_PADRAO_MS = INTERVALO_PADRAO_MS;
export const _INTERVALO_MINIMO_MS = INTERVALO_MINIMO_MS;
