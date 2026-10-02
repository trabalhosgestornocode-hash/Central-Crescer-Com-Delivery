// CONTRATO DO WORKER PLAYWRIGHT — Fase 3 (não implementado nesta fase).
//
// Este arquivo NÃO importa playwright e NÃO abre navegador. Ele define a
// fronteira entre o backend principal (leve, roda no Render Free) e o
// processo que de fato dirige o Chromium (pesado, roda separado).
//
// POR QUE SEPARADO
//   O serviço principal do Render Free tem 512 MB. Um Chromium headless
//   consome 300–500 MB só para abrir uma aba, e o pacote do browser pesa
//   ~150 MB no build. Instalar Playwright no serviço principal derrubaria a
//   API. Por isso o worker é um PROCESSO À PARTE, plugável depois sem tocar
//   em nada do que já existe.
//
// ONDE O WORKER PODE RODAR (decisão da Fase 3, ainda em aberto)
//   * Render Background Worker dedicado (plano pago, >= 1 GB);
//   * VPS pequena (1 vCPU / 2 GB já folga);
//   * container efêmero por execução (Cloud Run / Fly Machines) — o mais
//     econômico, já que a sincronização é esporádica.
//
// ESTIMATIVA DE RECURSOS POR EXECUÇÃO
//   RAM pico      ~600 MB (Chromium + página do portal)
//   Disco         ~400 MB (imagem + browser)
//   CPU           1 vCPU durante ~40–90 s
//   Duração       ~60 s (login + 2FA humano pode chegar a vários minutos)
//   Concorrência  1 por unidade (imposto pelo lock); 2–3 por instância
//
// VARIÁVEIS DE AMBIENTE FUTURAS (documentadas aqui, ainda não exigidas)
//   MB_PLAYWRIGHT_ENABLED   'true' habilita as rotas que recebem credenciais.
//                           Default 'false'. Enquanto false, o backend não
//                           aceita senha nenhuma e responde WORKER_DISABLED.
//   MB_WORKER_URL           URL do processo worker (ex: https://mb-worker.interno)
//   MB_WORKER_TOKEN         segredo compartilhado backend <-> worker (HMAC).
//                           NÃO é credencial da Martin Brower.
//   MB_WORKER_TIMEOUT_MS    teto de uma execução (default 300000)
//
// REGRAS QUE O WORKER DEVE HONRAR (não negociáveis)
//   1. Credenciais chegam por HTTPS, ficam só em memória e são descartadas
//      em bloco `finally`, inclusive no caminho de erro.
//   2. Token JWT e cookies do portal NUNCA voltam ao backend, ao frontend,
//      ao banco ou ao log. Só o payload de dados atravessa a fronteira.
//   3. As chamadas à API do portal são feitas DENTRO do contexto autenticado
//      (page.evaluate ou request context), para reaproveitar os cookies sem
//      nunca extraí-los.
//   4. O browser context é destruído ao concluir, cancelar, expirar ou falhar.
//   5. Nenhuma tentativa de contornar CAPTCHA ou mecanismo de segurança. Se
//      o portal apresentar um desafio, o worker PARA e devolve
//      MARTIN_BROWER_AUTH_FAILED para o humano resolver no portal oficial.
//   6. O orderId vem sempre do findProxPedidoV2, nunca é fixo.

import { mbErro, MB_ERROS } from "./martinbrower.errors.js";
import { efeitosExternosPermitidos } from "../../ambiente/efeitosExternos.js";

/**
 * A automação está habilitada neste ambiente? Default: NÃO. Além da flag, exige a guarda de efeitos externos
 * (ambiente/efeitosExternos.js): um PR Preview do Render herda MB_PLAYWRIGHT_ENABLED e não pode receber credenciais.
 */
export function workerHabilitado() {
  return process.env.MB_PLAYWRIGHT_ENABLED === "true" && efeitosExternosPermitidos(process.env);
}

export function exigirWorkerHabilitado() {
  if (!workerHabilitado()) throw mbErro(MB_ERROS.MARTIN_BROWER_WORKER_DISABLED);
}

/**
 * Interface que o worker da Fase 3 deve implementar. O backend só conhece
 * estes quatro métodos — a troca de "worker in-process" por "worker HTTP
 * remoto" não muda uma linha do controller.
 *
 * @typedef {object} MartinBrowerWorker
 * @property {(p: {sessionId, clientId, credenciais, sinal, aoProgredir}) => Promise<{precisa2fa: boolean}>} iniciar
 *           Abre o navegador e faz login. Resolve com precisa2fa=true quando
 *           o portal pedir código, e AGUARDA `informarCodigo`.
 * @property {(p: {sessionId, codigo}) => Promise<void>} informarCodigo
 *           Entrega o código 2FA digitado pelo usuário.
 * @property {(p: {sessionId, clientId, sinal}) => Promise<{pedido: object, catalogo: object}>} coletar
 *           Executa findProxPedidoV2 + loadItens DENTRO da sessão autenticada
 *           e devolve os payloads CRUS. Nunca devolve token nem cookie.
 * @property {(p: {sessionId}) => Promise<void>} encerrar
 *           Destrói o browser context. Idempotente. Chamado em `finally`.
 */

/**
 * Implementação nula usada enquanto MB_PLAYWRIGHT_ENABLED=false.
 * Falha alto e claro em vez de fingir que sincronizou.
 */
export const workerIndisponivel = {
  async iniciar() { throw mbErro(MB_ERROS.MARTIN_BROWER_WORKER_DISABLED); },
  async informarCodigo() { throw mbErro(MB_ERROS.MARTIN_BROWER_WORKER_DISABLED); },
  async coletar() { throw mbErro(MB_ERROS.MARTIN_BROWER_WORKER_DISABLED); },
  async encerrar() { /* nada a encerrar */ },
};

// Resolvido em runtime. Este é o ÚNICO ponto do backend que conhece QUAL
// implementação de worker está em uso.
let workerAtual = workerIndisponivel;

export function registrarWorker(worker) { workerAtual = worker ?? workerIndisponivel; }

export function obterWorker() {
  if (!workerHabilitado()) return workerIndisponivel;
  return workerAtual;
}

/**
 * Registra o adapter HTTP remoto (Cloud Run) — Fase 3.
 *
 * Import DINÂMICO de propósito: com MB_PLAYWRIGHT_ENABLED=false o módulo do
 * adapter sequer é carregado, então a flag desligada realmente significa
 * "nada disso existe neste processo".
 *
 * Chamado uma vez, na subida do app. Falhar aqui NÃO derruba o backend: sem
 * worker registrado, as rotas respondem WORKER_DISABLED, que é o estado
 * seguro.
 */
export async function inicializarWorkerRemoto() {
  if (!workerHabilitado()) return { habilitado: false, motivo: "MB_PLAYWRIGHT_ENABLED != true" };

  if (!process.env.MB_WORKER_URL || !process.env.MB_WORKER_SECRET) {
    return { habilitado: false, motivo: "MB_WORKER_URL ou MB_WORKER_SECRET ausentes" };
  }

  try {
    const { remoteWorker } = await import("./martinbrower.remote.worker.js");
    registrarWorker(remoteWorker);
    return { habilitado: true, url: process.env.MB_WORKER_URL };
  } catch (e) {
    return { habilitado: false, motivo: `falha ao carregar o adapter: ${e.message}` };
  }
}
