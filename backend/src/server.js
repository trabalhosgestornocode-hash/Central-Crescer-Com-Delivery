import { createApp } from "./app.js";
import { config } from "./config/env.js";
import { TIMEOUTS } from "./config/seguranca.js";
import { inicializarWorkerRemoto } from "./modules/martinbrower/martinbrower.worker.contract.js";
import { iniciarWorkerComunicacaoEmbutido, pararWorkerComunicacaoEmbutido } from "./worker-comunicacao/lifecycle.js";
import { workerLog } from "./worker-comunicacao/worker-comunicacao.logsafe.js";
import { iniciarPurgaPeriodica } from "./modules/comunicacao/comunicacao.inbox.retencao.js";

// Worker Martin Brower: só é carregado com MB_PLAYWRIGHT_ENABLED=true. Com a
// flag desligada (padrão), o adapter nem é importado — nenhum código de
// integração remota entra neste processo, e as rotas respondem WORKER_DISABLED.
// Nunca derruba a subida: sem worker, o estado seguro é "desabilitado".
inicializarWorkerRemoto().then((r) => {
  console.log(r.habilitado
    ? `   Martin Brower: worker remoto ATIVO (${r.url})`
    : `   Martin Brower: worker DESABILITADO (${r.motivo})`);
});

// Worker de comunicação (H.2-B.1): mesmo espírito — só roda com
// COMUNICACAO_WORKER_ENABLED=true (padrão: desligado). Com a flag desligada,
// nem WHATSAPP_GATEWAY_URL/SECRET precisam existir neste ambiente. Nunca
// derruba a subida do backend, mesmo com a flag ligada e config inválida.
iniciarWorkerComunicacaoEmbutido({ log: (nivel, evento, dados) => workerLog(nivel, evento, dados) }).then((r) => {
  console.log(r.habilitado
    ? "   Comunicação: worker embutido ATIVO"
    : `   Comunicação: worker embutido DESABILITADO (${r.motivo})`);
});

// Retenção REAL do texto recebido na Central (30 dias): purga periódica, independente do worker de automação. Falha nunca derruba a subida.
const purgaInbox = iniciarPurgaPeriodica({ log: (nivel, evento, dados) => workerLog(nivel, evento, dados) });
console.log(purgaInbox.ativa ? "   Comunicação: purga da caixa de entrada ATIVA" : "   Comunicação: purga da caixa de entrada DESLIGADA");

const servidor = createApp().listen(config.port, () => {
  console.log(`🥪 Subway Saci API rodando em http://localhost:${config.port}`);
  console.log(`   Health:   http://localhost:${config.port}/health`);
  console.log(`   Produtos: http://localhost:${config.port}/api/v1/produtos?vendavel=true`);
});

// Timeouts globais: sem eles uma conexão lenta (ou maliciosa) segura um socket
// indefinidamente. keepAliveTimeout > o do proxy do Render evita 502 espúrio.
servidor.requestTimeout = TIMEOUTS.requestTimeoutMs;
servidor.headersTimeout = TIMEOUTS.headersTimeoutMs;
servidor.keepAliveTimeout = TIMEOUTS.keepAliveTimeoutMs;

// Encerramento gracioso: o Render manda SIGTERM antes de derrubar a instância.
// pararWorkerComunicacaoEmbutido() é idempotente/no-op se o worker nunca
// iniciou (flag desligada) — por isso entra aqui sem precisar de um segundo
// handler de sinal. O grace period do worker embutido (8s) é sempre menor
// que o fallback de 10s abaixo, então nunca competem pelo mesmo encerramento.
for (const sinal of ["SIGTERM", "SIGINT"]) {
  process.on(sinal, () => {
    console.log(`[${sinal}] encerrando servidor…`);
    purgaInbox.parar();
    pararWorkerComunicacaoEmbutido(sinal).finally(() => {
      servidor.close(() => process.exit(0));
    });
    // Rede de segurança caso alguma conexão não feche sozinha.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
