// Ponte entre o boot/shutdown do backend HTTP principal e o motor do worker
// de comunicação (config.js/loop.js) — Checkpoint H.2-B.1.
//
// MESMO ESPÍRITO de martinbrower.worker.contract.js#inicializarWorkerRemoto:
//   - flag desligada (padrão) = "nada disso existe neste processo". Os
//     imports do worker (que exigem WHATSAPP_GATEWAY_URL/SECRET) só
//     acontecem DENTRO do branch habilitado — com a flag desligada, essa
//     exigência genuinamente não existe neste boot (Checkpoint H.2-B.1 §5).
//   - falhar aqui NUNCA derruba o boot do backend. Mesma filosofia já usada
//     em G.3.3 (auth-state) e no próprio Martin Brower: o backend serve
//     dezenas de features e não pode cair por causa da configuração de uma
//     só delas — com config inválida e a flag LIGADA, o worker
//     simplesmente não inicia (logado alto e claro), o resto do backend
//     sobe normalmente. Ver `docs/comunicacao-worker-h2a.md` para a
//     justificativa completa desta escolha.
//
// Import DINÂMICO por padrão (produção); os parâmetros de injeção abaixo
// existem só para testar sem rede/sem Supabase real.
//
// `ESTADOS` é importado ESTÁTICO de propósito (Checkpoint H.2-B, item 2):
// loop.js só importa MODOS de comunicacao.constants.js (vocabulário puro,
// sem env/rede) — importar o enum não viola "config do worker não é exigida
// com a flag desligada".
import { ESTADOS } from "./loop.js";
import { registrarEstadoDoWorker } from "./estado.js";

const GRACE_PERIOD_EMBUTIDO_MS = 8_000; // < que o fallback de 10s do próprio server.js — nunca corre com ele

/** A automação está habilitada neste processo? Default: NÃO — mesmo padrão de MB_PLAYWRIGHT_ENABLED. */
export function workerEmbutidoHabilitado(env = process.env) {
  return env.COMUNICACAO_WORKER_ENABLED === "true";
}

let pararAtual = null; // função de parada do worker atualmente rodando, ou null se nunca iniciou

/**
 * Chamado uma vez, na subida do backend, DEPOIS da config/validações
 * principais já terem passado. Nunca bloqueia `app.listen()` — o chamador
 * não deve dar `await` nisto no caminho crítico do boot.
 * @param {{
 *   env?: NodeJS.ProcessEnv, log?: Function, gracePeriodMs?: number,
 *   carregarConfig?: Function, criarLoopWorker?: Function, modoAtual?: Function,
 *   executarCiclo?: Function, criarWhatsAppService?: Function, criarBaileysGatewayProvider?: Function,
 * }} [params] Os 6 últimos são injetáveis SÓ para teste — produção sempre usa os imports dinâmicos reais.
 */
export async function iniciarWorkerComunicacaoEmbutido({
  env = process.env, log = () => {}, gracePeriodMs = GRACE_PERIOD_EMBUTIDO_MS,
  carregarConfig: carregarConfigInjetado, criarLoopWorker: criarLoopWorkerInjetado,
  modoAtual: modoAtualInjetado, executarCiclo: executarCicloInjetado,
  criarWhatsAppService: criarWhatsAppServiceInjetado, criarBaileysGatewayProvider: criarProviderInjetado,
} = {}) {
  if (!workerEmbutidoHabilitado(env)) {
    log("info", "comunicacao.worker_not_started", { reason: "worker_disabled" });
    return { habilitado: false, motivo: "COMUNICACAO_WORKER_ENABLED != true", workerState: ESTADOS.DISABLED };
  }

  // DISTINTO de cima de propósito (Checkpoint H.2-B, item 2): "desligado pela
  // flag" e "ligado mas mal configurado" são estados operacionais diferentes
  // — o segundo é um erro de configuração real que precisa aparecer como tal
  // (workerState=ERROR, evento próprio), nunca disfarçado de "desabilitado".
  // A mensagem de erro nunca inclui a URL/segredo em si — só a mensagem que
  // config.js já produz (nomeia a variável ofendida, nunca ecoa o valor).
  let config;
  try {
    const carregar = carregarConfigInjetado ?? (await import("./config.js")).carregarConfig;
    config = carregar(env);
  } catch (e) {
    log("error", "comunicacao.worker_start_failed", { reason: "config_invalida", erro: String(e?.message ?? e).slice(0, 300) });
    return { habilitado: false, motivo: "config inválida", workerState: ESTADOS.ERROR };
  }

  const criarLoopWorker = criarLoopWorkerInjetado ?? (await import("./loop.js")).criarLoopWorker;
  const modoAtual = modoAtualInjetado ?? (await import("../modules/comunicacao/comunicacao.config.js")).modoAtual;
  const executarCiclo = executarCicloInjetado ?? (await import("../modules/comunicacao/comunicacao.alertas.service.js")).executarCiclo;
  const criarWhatsAppService = criarWhatsAppServiceInjetado ?? (await import("../modules/comunicacao/whatsapp.service.js")).criarWhatsAppService;
  const criarBaileysGatewayProvider = criarProviderInjetado ?? (await import("../modules/comunicacao/providers/baileysGateway.provider.js")).criarBaileysGatewayProvider;

  const { criarGateIdentidade: criarGate } = await import("../modules/comunicacao/comunicacao.identidade.js");
  const whatsAppService = criarWhatsAppService({
    provider: criarBaileysGatewayProvider({ gatewayUrl: config.gatewayUrl, segredoHmac: config.segredoHmac }),
    // O worker/automação só envia com a conta CONFIRMADA na aba Conexão (mesma regra do envio manual). Sem confirmação: provider = 0.
    identidadeConfirmada: criarGate({ env }),
  });
  const loop = criarLoopWorker({ executarCiclo, modoAtual, whatsAppService, intervalMs: config.intervalMs, log, gracePeriodMs });

  // Fire-and-forget de propósito (mesmo padrão do `.then()` de
  // inicializarWorkerRemoto em server.js): o laço roda até `encerrar()`, sem
  // bloquear nada. `loopPrincipal()` nunca rejeita (executarUmTick() já
  // captura qualquer erro do ciclo) — o `.catch()` aqui é só rede de
  // segurança contra uma falha genuinamente inesperada, sem derrubar o
  // processo por ela.
  // loop.iniciar() já loga comunicacao.worker_boot/worker_ready — não duplicar aqui.
  loop.iniciar().catch((e) => log("error", "comunicacao.worker_loop_quebrou", { erro: String(e?.message ?? e).slice(0, 300) }));
  registrarEstadoDoWorker(loop.obterEstado);   // só leitura, para o Painel (H.4-B.5)
  pararAtual = (sinal) => { registrarEstadoDoWorker(null); return loop.encerrar(sinal); };

  return { habilitado: true, obterEstado: loop.obterEstado };
}

/**
 * Chamado pelo shutdown do backend (mesmo handler de SIGTERM/SIGINT já
 * existente em server.js — NUNCA registrar um segundo). Idempotente/no-op
 * se o worker nunca chegou a iniciar (flag desligada).
 * @param {string} sinal
 */
export async function pararWorkerComunicacaoEmbutido(sinal) {
  if (!pararAtual) return;
  const parar = pararAtual;
  pararAtual = null;
  await parar(sinal);
}
