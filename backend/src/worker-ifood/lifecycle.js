// Ciclo de vida do PROCESSO do worker de Events do iFood: sinais, término inesperado e código de saída.
//
// Separado de index.js para ser testado num processo-filho REAL (test/ifood-worker-lifecycle.test.js)
// com o loop real, sem Supabase nem iFood.
//
// CÓDIGOS DE SAÍDA
//   0  só em shutdown DELIBERADO (SIGTERM/SIGINT) que terminou bem: ciclo em andamento concluído e lease liberado.
//   1  qualquer outra saída: o loop terminou/quebrou sem ninguém pedir, erro no shutdown, prazo de
//      shutdown estourado ou uncaughtException. Um worker que para sozinho NUNCA pode parecer saudável
//      (o Render reinicia o processo e o log mostra o motivo).

import { ifoodLog } from "../modules/ifood/ifood.logsafe.js";

const PRAZO_SHUTDOWN_MS = 30_000;
const PRAZO_LIBERAR_LEASE_MS = 5_000;

const msgErro = (e) => String(e?.message ?? e).slice(0, 300);

/**
 * Liga o loop ao processo. Não retorna controle de saída: quem encerra o processo é esta função.
 * @param {{
 *   loop: { iniciar: () => Promise<void>, parar: () => Promise<void> },
 *   poller?: { encerrar?: () => Promise<boolean> },   // para liberar o lease quando o loop quebra sozinho
 *   health?: { close: () => void } | null,
 *   log?: Function, proc?: NodeJS.Process, prazoShutdownMs?: number,
 * }} p
 */
export function executarWorker({ loop, poller = null, health = null, log = ifoodLog, proc = process, prazoShutdownMs = PRAZO_SHUTDOWN_MS }) {
  let encerrando = false;

  async function encerrar(sinal) {
    if (encerrando) return;
    encerrando = true;
    log("info", "worker.encerrando", { sinal });
    // unref AQUI é correto: é só o prazo máximo do shutdown — não deve, sozinho, manter o processo vivo.
    const forca = setTimeout(() => { log("error", "worker.shutdown_prazo_estourado", { prazoMs: prazoShutdownMs }); proc.exit(1); }, prazoShutdownMs);
    forca.unref?.();
    let codigo = 0;
    try {
      await loop.parar();            // espera o ciclo em andamento e libera o lease
    } catch (e) {
      codigo = 1;
      log("error", "worker.erro_no_shutdown", { erro: msgErro(e) });
    }
    health?.close?.();
    log("info", "worker.encerrado", { sinal, codigo });
    proc.exit(codigo);
  }

  /** O loop terminou (ou quebrou) sem shutdown deliberado: libera o lease (best-effort) e sai com 1. */
  async function terminouSozinho(motivo, e) {
    if (encerrando) return;          // parar() foi pedido: o término do loop é o esperado
    encerrando = true;
    log("error", "worker.loop_terminou_inesperadamente", { motivo, erro: e === undefined ? null : msgErro(e) });
    if (poller?.encerrar) {
      await Promise.race([
        poller.encerrar().catch(() => false),
        new Promise((r) => { setTimeout(r, PRAZO_LIBERAR_LEASE_MS).unref?.(); }),
      ]);
    }
    health?.close?.();
    proc.exit(1);
  }

  proc.on("SIGTERM", () => { void encerrar("SIGTERM"); });
  proc.on("SIGINT", () => { void encerrar("SIGINT"); });
  proc.on("uncaughtException", (e) => { log("error", "worker.uncaughtException", { erro: msgErro(e) }); proc.exit(1); });
  proc.on("unhandledRejection", (e) => { log("error", "worker.unhandledRejection", { erro: msgErro(e) }); });

  Promise.resolve()
    .then(() => loop.iniciar())
    .then(() => terminouSozinho("loop_retornou"), (e) => terminouSozinho("loop_falhou", e));

  return { encerrar };
}
