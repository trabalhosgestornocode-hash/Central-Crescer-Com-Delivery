import { createApp } from "./app.js";
import { config } from "./config/env.js";
import { TIMEOUTS } from "./config/seguranca.js";
import { inicializarWorkerRemoto } from "./modules/martinbrower/martinbrower.worker.contract.js";
import { iniciarWorkerComunicacaoEmbutido, pararWorkerComunicacaoEmbutido } from "./worker-comunicacao/lifecycle.js";
import { workerLog } from "./worker-comunicacao/worker-comunicacao.logsafe.js";
import { iniciarPurgaPeriodica } from "./modules/comunicacao/comunicacao.inbox.retencao.js";
import { iniciarEventsIfoodEmbutido, pararEventsIfoodEmbutido } from "./worker-ifood/embedded.js";
import { totalUnidadesHomologacaoFinancial } from "./modules/ifood/ifoodFinancialHomologacao.js";
import { iniciarServidorHttp } from "./servidor.lifecycle.js";
import { avaliarEfeitosExternos } from "./ambiente/efeitosExternos.js";
import { lerAllowlistRetryResend } from "./modules/comunicacao/retryResendAllowlist.js";

// Guarda de efeitos externos (ambiente/efeitosExternos.js): decide, ANTES das flags de cada rotina, se este processo pode
// consumir fila, enviar WhatsApp, purgar dados ou falar com iFood/Martin Brower. Autorização POSITIVA: sem ela (PR
// Preview, serviço não autorizado, local/teste sem opt-in) tudo fica bloqueado. Só vocabulário fechado no log.
{
  const e = avaliarEfeitosExternos();
  console.log(`   Efeitos externos: ${e.permitido ? "PERMITIDOS" : "BLOQUEADOS"} (ambiente=${e.ambiente}, motivo=${e.motivo})`);
  // Allowlist do reenvio sob retry (modules/comunicacao/retryResendAllowlist.js): só estado e contagem — nunca os contato_id.
  const a = lerAllowlistRetryResend();
  console.log(`   WhatsApp retry resend: allowlist ${a.estado} (${a.total} contato(s))`);
}

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

// Encerramento gracioso (servidor.lifecycle.js): o Render manda SIGTERM antes de
// derrubar a instância. Um único handler; os laços embarcados param em paralelo,
// cada um com prazo próprio (comunicação 8 s, iFood Events 7 s) sempre menor que
// o fallback de 10 s — nunca competem pelo mesmo encerramento. As paradas são
// idempotentes/no-op quando o laço nunca iniciou (flag desligada).
iniciarServidorHttp({
  app: createApp(),
  porta: config.port,
  timeouts: TIMEOUTS,
  aoEscutar: () => {
    console.log(`🥪 Subway Saci API rodando em http://localhost:${config.port}`);
    console.log(`   Health:   http://localhost:${config.port}/health`);
    console.log(`   Produtos: http://localhost:${config.port}/api/v1/produtos?vendavel=true`);
    // Só a QUANTIDADE — nunca os UUIDs das unidades.
    console.log(`   iFood Financial homologação: ${totalUnidadesHomologacaoFinancial()} unidade(s) habilitada(s)`);

    // iFood Events embarcado: só com IFOOD_EVENTS_EMBEDDED_ENABLED=true (padrão: desligado = nenhum polling).
    // Começa DEPOIS do HTTP ouvir e sem await: banco, iFood ou config com problema viram estado `degraded`
    // do Events — o Web Service continua saudável. Nunca rejeita.
    iniciarEventsIfoodEmbutido().then((r) => {
      console.log(r.habilitado
        ? "   iFood Events: embarcado ATIVO"
        : `   iFood Events: embarcado ${r.estado === "disabled" ? "DESABILITADO" : "NÃO INICIADO"} (${r.motivo})`);
    });
  },
  antesDeFechar: [
    () => purgaInbox.parar(),
    (sinal) => pararWorkerComunicacaoEmbutido(sinal),
    (sinal) => pararEventsIfoodEmbutido(sinal),
  ],
});
