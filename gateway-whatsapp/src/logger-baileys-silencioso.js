// Logger no-op passado explicitamente a makeWASocket(). O Baileys tem seu
// PRÓPRIO logger interno (pino, node_modules/baileys/lib/Utils/logger.js,
// usado como default quando nenhum é passado) que escreve DIRETO no stdout —
// fora do nosso sanitizador (logsafe.js#sanitizar). Sem isto, eventos
// internos da biblioteca (handshake, registro, QR, falhas de conexão)
// vazavam para os logs do Render sem passar por nenhuma revisão nossa —
// confirmado ao vivo no Checkpoint C3 (linhas com "connected to WA",
// "not logged in, attempting registration...", devicePairingData).
//
// CONTRATO EXATO exigido pelo Baileys — não é um pino real, é qualquer
// objeto que satisfaça a interface `ILogger`
// (node_modules/baileys/lib/Utils/logger.d.ts):
//   level: string
//   child(obj): ILogger
//   trace/debug/info/warn/error(obj, msg?): void
// `fatal` não é exigido pelo contrato, mas implementamos por segurança —
// não custa nada e cobre qualquer chamada inesperada.
//
// Decisão: NÃO usar `pino` (nem instalado como dependência direta, nem
// dependido silenciosamente como transitivo do Baileys) — um objeto puro
// com métodos vazios já satisfaz o contrato inteiro, sem dependência nova
// nenhuma. Mais simples, mais auditável, zero superfície extra.
const NIVEIS = ["trace", "debug", "info", "warn", "error", "fatal"];

/** @returns {import('baileys').ILogger} */
export function criarLoggerBaileysSilencioso() {
  const logger = { level: "silent" };
  for (const nivel of NIVEIS) logger[nivel] = () => {};
  // Baileys encadeia child() por módulo interno (ex.: logger.child({class:
  // "baileys"})) — cada filho precisa satisfazer o MESMO contrato.
  logger.child = () => criarLoggerBaileysSilencioso();
  return logger;
}
