// Guarda de log da libsignal (Checkpoint C3.5-C.9.1).
//
// PROBLEMA (provado no código instalado — libsignal 6.0.0, commit bcea72df, a dependência do
// baileys 6.7.24; node_modules/libsignal/src/session_record.js): a libsignal escreve OBJETOS de
// sessão (`SessionEntry`: rootKey, chaves de cadeia, chaves efêmeras, chaves de mensagem
// puladas) direto em `console.*`, sem nenhum mecanismo de logger/silêncio:
//
//     closeSession(session)   -> console.info("Closing session:", session)
//     openSession(session)    -> console.info("Opening session:", session)
//     removeOldSessions()     -> console.info("Removing old closed session:", oldestSession)
//     closeSession(session)   -> console.warn("Session already closed", session)
//     queue_job(bucket, ...)  -> console.warn("Unhandled bucket type (for naming):", typeof bucket, bucket)
//
// No Render, tudo o que sai em stdout vira log persistente e consultável. O `logger` do Baileys
// (criarLoggerBaileysSilencioso) NÃO cobre isso: a libsignal não usa o logger do Baileys.
//
// OPÇÕES AVALIADAS
//   1. mecanismo suportado pelo pacote      — não existe (nenhum parâmetro de logger nas classes).
//   2. logger próprio                       — idem, o `console` é global e fixo no código da libsignal.
//   3. patch da dependência (patch-package) — reproduzível, mas exige nova ferramenta no build do Docker,
//                                             quebra silenciosamente quando o commit git da libsignal muda
//                                             e fica FORA do código testado do Gateway.
//   4. filtro específico no Gateway         — ESCOLHIDA: testável, sem tocar node_modules, sem depender do
//                                             build. Só desvia quando o PRIMEIRO argumento é EXATAMENTE uma
//                                             das mensagens perigosas conhecidas; todo o resto passa intacto.
//
// NÃO faz: desligar console.info, sobrescrever logs em geral, esconder erros. "Session error:",
// "Failed to decrypt message with any known session..." (Bad MAC) etc. seguem visíveis como antes.
// Um teste-canário (test/libsignalLogGuard.test.js) varre a libsignal instalada e FALHA se uma
// versão futura adicionar uma chamada de console com argumentos extras que este guarda não conheça.

import { log } from "./logsafe.js";

/**
 * Mensagem exata (1º argumento) -> evento sanitizado. O evento nunca carrega o objeto nem
 * qualquer argumento seguinte: só o fato de que aconteceu.
 */
export const MENSAGENS_PERIGOSAS = Object.freeze({
  "Closing session:": "libsignal.session_fechada",
  "Opening session:": "libsignal.session_reaberta",
  "Removing old closed session:": "libsignal.session_antiga_removida",
  "Session already closed": "libsignal.session_ja_fechada",
  "Unhandled bucket type (for naming):": "libsignal.bucket_tipo_inesperado",
});

const METODOS = ["log", "info", "warn", "error", "debug"];
const MARCA = Symbol.for("crescer.gateway.libsignalLogGuard");

/**
 * Instala a guarda no objeto `console` informado. Idempotente: instalar duas vezes não empilha
 * wrappers. Devolve `{ desinstalar, contadores }` (contadores por evento, só números).
 *
 * @param {object} [deps]
 * @param {Console} [deps.alvo]  console a proteger (padrão: o global)
 * @param {(nivel: string, evento: string, dados?: object) => void} [deps.emitir] padrão: `log` do logsafe
 */
export function instalarGuardaLibsignal({ alvo = console, emitir = log } = {}) {
  if (alvo[MARCA]) return alvo[MARCA];

  const originais = {};
  const contadores = Object.fromEntries(Object.values(MENSAGENS_PERIGOSAS).map((e) => [e, 0]));

  for (const metodo of METODOS) {
    const original = alvo[metodo];
    if (typeof original !== "function") continue;
    originais[metodo] = original;
    alvo[metodo] = function guardado(...args) {
      const evento = typeof args[0] === "string" ? MENSAGENS_PERIGOSAS[args[0]] : undefined;
      if (evento === undefined) return original.apply(this, args);
      // Perigosa: NÃO repassa nenhum argumento. Emite só o evento (sem objeto, sem ids).
      contadores[evento]++;
      try {
        emitir("info", evento, {});
      } catch {
        // Logar nunca pode derrubar o fluxo criptográfico que chamou o console.
      }
      return undefined;
    };
  }

  const controle = {
    contadores,
    desinstalar() {
      for (const [metodo, original] of Object.entries(originais)) alvo[metodo] = original;
      delete alvo[MARCA];
    },
  };
  Object.defineProperty(alvo, MARCA, { value: controle, configurable: true, enumerable: false });
  return controle;
}
