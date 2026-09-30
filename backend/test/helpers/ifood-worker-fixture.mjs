// Processo-filho REAL para test/ifood-worker-lifecycle.test.js.
//
// Usa o loop REAL (criarLoopDoPoller com o dormir/setTimeout REAL — nada mascarado) e o ciclo de vida
// REAL do worker (executarWorker). Só o poller é falso: lease em memória, sem Supabase e sem iFood.
// Nenhum health server. Conversa com o teste por linhas JSON no stdout.
//
//   node ifood-worker-fixture.mjs normal        ciclo OK e dorme (piso de 30 s) até receber SIGTERM
//   node ifood-worker-fixture.mjs loop-quebra   o laço do loop quebra depois do 1º ciclo (término inesperado)
import { criarLoopDoPoller } from "../../src/modules/ifood/ifoodEvents.poller.js";
import { executarWorker } from "../../src/worker-ifood/lifecycle.js";

const modo = process.argv[2] ?? "normal";
const emitir = (evento, dados = {}) => process.stdout.write(`${JSON.stringify({ evento, ...dados })}\n`);

let ciclos = 0;
let temLease = false;
const poller = {
  async executarCiclo() {
    ciclos += 1;
    temLease = true;
    emitir("ciclo", { n: ciclos });
    if (modo === "loop-quebra") throw new Error("falha no ciclo");
    return { estado: "OK" };
  },
  async encerrar() {
    if (!temLease) return false;
    temLease = false;
    emitir("lease_liberado");
    return true;
  },
};

// "loop-quebra": o próprio laço quebra (o log do erro do ciclo lança) — o loop termina sem shutdown pedido.
const logDoLoop = modo === "loop-quebra" ? () => { throw new Error("log do loop quebrou"); } : () => {};
const loop = criarLoopDoPoller({ poller, log: logDoLoop });

executarWorker({ loop, poller, log: (nivel, evento, dados = {}) => emitir(evento, { nivel, ...dados }) });

// Windows não entrega SIGTERM ao handler (child.kill encerra à força): lá o teste pede o sinal por IPC e
// o handler REAL registrado por executarWorker é disparado. O canal é unref(): NÃO mantém o processo vivo
// (senão o caso "continua vivo dormindo" passaria por causa do canal, e não do timer).
if (process.channel) {
  process.on("message", (m) => { if (m === "SIGTERM") process.emit("SIGTERM", "SIGTERM"); });
  process.channel.unref();
}
emitir("pronto", { modo, pid: process.pid });
