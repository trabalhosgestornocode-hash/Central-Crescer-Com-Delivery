// Processo de teste do encerramento: ciclo de vida REAL (servidor.lifecycle.js) + poller e loop REAIS do
// iFood Events sobre repositório, cliente e token FALSOS em memória. Sem Supabase, sem iFood, sem rede externa.
// Cada passo vira uma linha "MARCA ..." no stdout, para o teste ler depois que o processo terminar.
//
//   SIG_POLL_MS  duração simulada de cada consulta de eventos (0 = imediata)
Object.assign(process.env, { SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x" });
const marca = (t) => process.stdout.write(`MARCA ${t}\n`);

const express = (await import("express")).default;
const { iniciarServidorHttp } = await import("../../src/servidor.lifecycle.js");
const { criarPoller, criarLoopDoPoller } = await import("../../src/modules/ifood/ifoodEvents.poller.js");
const clienteReal = await import("../../src/modules/ifood/ifoodEvents.client.js");
const { criarRepoEmMemoria, criarClienteFake, criarTokenFake, pilotoDe, CONEXAO_A } = await import("./ifood-events-fakes.js");

const relogio = { agoraMs: () => Date.now(), agora: () => new Date(), avancarS() {} };   // relógio real
const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
const liberar = repo.liberarLease;
repo.liberarLease = async (a) => { const r = await liberar(a); marca(`LEASE_LIBERADO=${r}`); return r; };

const pollMs = Number(process.env.SIG_POLL_MS ?? 0);
const client = criarClienteFake(clienteReal, { respostasPolling: [] });
const buscar = client.buscarEventos;
client.buscarEventos = async (a) => {
  marca("POLL_INICIO");
  if (pollMs) await new Promise((r) => setTimeout(r, pollMs));
  const x = await buscar(a);
  marca("POLL_FIM");
  return x;
};

const poller = criarPoller({
  repo, token: criarTokenFake({ escopo: "conexao" }), client, holder: `teste-${process.pid}`,
  agora: relogio.agora, log: () => {}, leaseTtlS: 90, unidadesPiloto: pilotoDe(repo),
});
const loop = criarLoopDoPoller({ poller, intervaloMs: 30_000, log: () => {}, aoFinalizarCiclo: (r) => marca(`CICLO=${r?.estado}`) });

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));
iniciarServidorHttp({
  app, porta: 0, timeouts: null,
  aoEscutar: () => { marca("ESCUTANDO"); void loop.iniciar(); },
  // Mesmo formato do server.js: uma parada por laço embarcado, com o prazo do iFood Events (7 s).
  antesDeFechar: [async (sinal) => {
    marca(`PARANDO_POLLER sinal=${sinal}`);
    const r = await loop.parar({ prazoMs: 7_000 });
    marca(`POLLER_PARADO drenado=${r.drenado} leaseLiberado=${r.leaseLiberado}`);
  }],
  log: (m) => marca(`LOG ${m}`),
});
process.on("exit", (c) => marca(`EXIT codigo=${c} leaseVivo=${repo.lease ? repo.lease.ate > Date.now() : false}`));
