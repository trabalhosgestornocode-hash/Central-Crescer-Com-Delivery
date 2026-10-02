// Ciclo de vida do processo HTTP da Central: subir, ficar saudável, encerrar com o SIGTERM do Render.
//
// Extraído de server.js para ser testado com um `proc` falso (no Windows o SIGTERM não chega a handlers).
//
// BOOT: `aoEscutar` só roda depois do `listen()` — é ali que os subsistemas degradáveis (iFood Events) começam,
// sem `await`, com o /health já respondendo. Nada de subsistema pode impedir o HTTP de subir.
//
// ENCERRAMENTO (um único handler para SIGTERM/SIGINT; sinal repetido não dispara um segundo encerramento):
//   1. marca "encerrando" e arma o prazo final (process.exit(0) em `prazoFinalMs`, rede de segurança);
//   2. `antesDeFechar` rodam EM PARALELO (cada um com o seu prazo, sempre menor que o final): param os laços
//      (sem ciclo novo), esperam o ciclo em voo e liberam o lease. Falha de um não impede os outros;
//   3. fecha o servidor HTTP (que continuou atendendo até aqui);
//   4. sai com 0.
// process.exit só acontece AQUI — nunca por falha de um subsistema.

/**
 * @param {{
 *   app: import("express").Express, porta: number|string,
 *   timeouts?: { requestTimeoutMs: number, headersTimeoutMs: number, keepAliveTimeoutMs: number },
 *   aoEscutar?: (servidor: import("node:http").Server) => void,
 *   antesDeFechar?: Array<(sinal: string) => unknown>,
 *   proc?: NodeJS.Process, prazoFinalMs?: number, log?: (msg: string) => void,
 * }} p
 */
export function iniciarServidorHttp({
  app, porta, timeouts, aoEscutar, antesDeFechar = [], proc = process, prazoFinalMs = 10_000, log = console.log,
}) {
  const servidor = app.listen(porta, () => aoEscutar?.(servidor));

  // Timeouts globais: sem eles uma conexão lenta (ou maliciosa) segura um socket
  // indefinidamente. keepAliveTimeout > o do proxy do Render evita 502 espúrio.
  if (timeouts) {
    servidor.requestTimeout = timeouts.requestTimeoutMs;
    servidor.headersTimeout = timeouts.headersTimeoutMs;
    servidor.keepAliveTimeout = timeouts.keepAliveTimeoutMs;
  }

  let encerramento = null;
  function encerrar(sinal) {
    if (encerramento) return encerramento;
    log(`[${sinal}] encerrando servidor…`);
    // Rede de segurança caso algum laço ou conexão não feche sozinho.
    setTimeout(() => proc.exit(0), prazoFinalMs).unref?.();
    encerramento = Promise.allSettled(antesDeFechar.map((parar) => Promise.resolve().then(() => parar(sinal))))
      .then(() => new Promise((resolve) => servidor.close(() => resolve())))
      .then(() => proc.exit(0));
    return encerramento;
  }

  for (const sinal of ["SIGTERM", "SIGINT"]) proc.on(sinal, () => { void encerrar(sinal); });

  return { servidor, encerrar };
}
