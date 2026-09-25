// Servidor do Gateway.
//
// Nunca é exposto publicamente: no Render, sobe como Private Service
// (Checkpoint C0 — não provisionado neste checkpoint). Não há CORS, não há
// arquivo estático, não há rota pública além do /health.

import { randomUUID } from "node:crypto";
import express from "express";
import makeWASocket, { DisconnectReason } from "baileys";
import { config, validarConfig } from "./config.js";
import { exigirHmac } from "./hmac.js";
import { criarRotas, health } from "./routes.js";
import { criarExecutorOperacao } from "./operacaoConexao.js";
import { criarBackendClient } from "./backendClient.js";
import { criarAuthStateAdapter, serializarAuth } from "./authState.js";
import { criarTelemetriaAuth } from "./authMetrics.js";
import { criarSessaoBaileys } from "./baileysSession.js";
import { criarLeaseManager } from "./leaseManager.js";
import { log } from "./logsafe.js";
import { instalarGuardaLibsignal } from "./libsignalLogGuard.js";
import { criarInboundGateway } from "./inboundScope.js";
import { criarRastreadorOrigem } from "./inboundContrato.js";
import { criarGuardaAuthHeadroom } from "./authHeadroom.js";

// Checkpoint C3.5-C.9.1 — a libsignal escreve OBJETOS de sessão (material de chave) em
// console.*. Instalada ANTES de qualquer socket/libsignal existir e SEM depender de flag:
// é correção de segurança de log, não telemetria. Ver src/libsignalLogGuard.js.
instalarGuardaLibsignal();

// Falhar no boot é melhor que subir sem autenticação ou sem cifra.
validarConfig();

// Checkpoint C3.5, item 2 — identificador efêmero DESTE processo, gerado
// uma única vez no boot. NUNCA reutilizado entre reinícios (nem em restart,
// nem em redeploy) — é o que dá ao fencing token (lease_epoch) um dono
// claramente distinguível a cada boot. Não confundir com
// `config.providerInstanceId` ("default"), que identifica a SESSÃO lógica,
// não o processo físico.
const gatewayProcessId = randomUUID();

const backendClient = criarBackendClient({
  backendUrl: config.backendUrl,
  segredoHmac: config.segredoHmac,
  timeoutMs: config.timeoutBackendMs,
});

// leaseManager construído ANTES de authAdapter/sessao — os dois recebem
// `leaseManager` (ou getters sobre ele) como dependência, nunca o
// contrário, para não haver referência circular na montagem.
const leaseManager = criarLeaseManager({
  backendClient,
  gatewayProcessId,
  ttlMs: config.lease.ttlMs,
  renewMs: config.lease.renewMs,
  margemSegurancaMs: config.lease.margemSegurancaMs,
  pollingStandbyMs: config.lease.pollingStandbyMs,
  // Checkpoint C3.5, item 12 — perda de lease com socket aberto: fecha e
  // para tudo, nunca tenta reaver ownership silenciosamente.
  aoPerderLease: () => sessao._forcarFailSafe(),
  // Checkpoint C3.5-B — vira leader (boot como leader, ou standby que
  // assumiu depois de polling): avalia restore automático. NUNCA dispara em
  // renew (a fábrica do leaseManager já garante isso — só chama isto numa
  // transição real false->true). `sessao` só é atribuída abaixo, mas esta
  // arrow function só executa quando o leaseManager de fato chamar o
  // callback (depois de `iniciar()`), quando `sessao` já existe — mesmo
  // padrão já usado em `aoPerderLease` acima.
  aoTornarSeLeader: () => sessao._restaurarSessaoSePossivel(),
});

const authAdapter = criarAuthStateAdapter({
  backendClient,
  chaveEncriptacaoEnv: config.chaveEncriptacaoAuthState,
  obterContextoLease: () => leaseManager.contexto(),
  aoLeaseStale: (motivo) => leaseManager.notificarPerdaExterna(motivo),
  // C.9.1 — inerte (`{habilitada:false}`) enquanto WHATSAPP_AUTH_METRICS_ENABLED não for ligada.
  telemetriaAuth: criarTelemetriaAuth({
    habilitada: config.metricasAuthHabilitadas,
    serializar: serializarAuth,
    emitir: (dados) => log("info", "auth_state.metricas", dados),
  }),
});
// Checkpoint G.0.1 (Partes K-R) — fonte REAL do auth headroom: reaproveita authAdapter.obterUltimoTamanho()
// (o mesmo corpoBytes que auth_state.metricas já calcula), nunca uma segunda serialização do auth state. Fail-closed
// por construção (src/authHeadroom.js): sem medição ainda ⇒ ok()=false ⇒ o recovery simplesmente não inicia.
// Checkpoint G.3.3 — `limiteBytes: config.authStateCapacidadeBytes` (undefined por padrão ⇒ authHeadroom.js usa seu
// próprio default de 1 MiB, comportamento idêntico a antes deste checkpoint). O percentual de 85% (maxUsagePct)
// continua o mesmo — este checkpoint só alinha a REFERÊNCIA, nunca a margem sobre ela.
const guardaAuthHeadroom = criarGuardaAuthHeadroom({
  obterUltimoTamanho: () => authAdapter.obterUltimoTamanho(),
  maxUsagePct: config.offlineRecoveryAuthMaxUsagePct,
  limiteBytes: config.authStateCapacidadeBytes,
});
// Checkpoint G.3.3-B, item 6 — telemetria SEGURA de boot (só números, nunca auth-state/segredo/env bruta): prova
// depois do deploy, sem precisar ler env do Render, que a capacidade efetiva do Gateway bate com a do backend.
// NOMES: "authCapacity*", não "authState*" — src/logsafe.js mascara qualquer chave que CONTENHA "authstate" (pega
// authStateEncrypted de propósito); "authStateCapacityBytes" caía nesse bloqueio e virava "[REDACTED]" nos logs,
// exatamente o oposto do que este item pede. Confirma o sanitizador funcionando; a correção é não colidir com ele.
{
  const { limiteBytes, maxUsagePct } = guardaAuthHeadroom.estado();
  log("info", "auth_state.capacidade", {
    authCapacityBytes: limiteBytes,
    authCapacityMiB: Math.round((limiteBytes / (1024 * 1024)) * 100) / 100,
    authRecoveryMaxUsagePct: maxUsagePct,
  });
}

// C.9.3 — escopo de inbound (padrão ALL_SUPPORTED = sem mudança) + contadores sanitizados opcionais.
const inbound = criarInboundGateway({
  escopoBruto: config.inboundEscopoBruto,
  diagHabilitado: config.inboundDiagHabilitado,
  emitir: (nivel, evento, dados) => log(nivel, evento, dados),
  // C.9.6 — só OBSERVA a fila offline (nunca faz flush); o epoch é só um rótulo técnico nos eventos
  offlineObserve: config.offlineObserveHabilitado,
  obterEpoch: () => leaseManager.contexto()?.leaseEpoch ?? null,
  // Checkpoint G — kill-switch (WHATSAPP_OFFLINE_RECOVERY_ENABLED, nasce OFF). `aoIniciar` é a ÚNICA ponte para o
  // rastreador de origem do Checkpoint F (abaixo): promove as entradas pendentes de OFFLINE_NORMAL para
  // OFFLINE_RECOVERY no instante exato em que o motor entra em RECOVERING — nunca loga id. `lerAuthHeadroomOk`
  // (Checkpoint G.0.1) é a MESMA guarda checada na entrada e antes de CADA batch adicional (src/offlineRecovery.js).
  // Checkpoint G.2.0 — `...config.offlineRecoveryLimites` repassa os 5 caps (já parseados/validados em config.js/
  // validarConfig(), undefined quando a env não foi definida) direto para criarMotorRecovery via
  // criarInboundGateway (inboundScope.js espalha estas chaves sem alteração — ver seu cabeçalho). Sem nenhuma
  // destas envs, os 5 campos são `undefined` e o motor usa PADROES_RECOVERY, idêntico ao comportamento antes desta
  // mudança.
  offlineRecovery: config.offlineRecoveryHabilitado
    ? {
        aoIniciar: () => rastreadorOrigem.promoverPendentesParaRecovery(),
        lerAuthHeadroomOk: () => guardaAuthHeadroom.ok(),
        ...config.offlineRecoveryLimites,
      }
    : false,
});
log(inbound.valido ? "info" : "warn", inbound.valido ? "inbound.escopo" : "inbound.escopo_invalido_usando_padrao", {
  escopo: inbound.escopo, diagnostico: inbound.diagnostico, offlineObserve: inbound.offlineObserve, offlineIdentidade: inbound.estadoIdentidade() !== undefined,
  offlineRecovery: config.offlineRecoveryHabilitado, offlineRecoveryAtivoAgora: inbound.estadoRecovery() !== undefined,
  // prova operacional: só DIRECT_ONLY injeta um shouldIgnoreJid no socket; ALL_SUPPORTED (com ou sem diagnóstico) não injeta nada
  shouldIgnoreJidInjetado: "shouldIgnoreJid" in inbound.opcoesSocket(),
});

// Checkpoint F/G — origem POR MENSAGEM (LIVE | OFFLINE_NORMAL | OFFLINE_RECOVERY). Criado aqui (não dentro de
// baileysSession.js) só para que `rotularOffline` possa consultar `inbound.recoveryAtivo()` — a ÚNICA razão de
// injetar isto em vez de deixar baileysSession.js criar o seu próprio, como antes do Checkpoint G.
const rastreadorOrigem = criarRastreadorOrigem({ rotularOffline: () => (inbound.recoveryAtivo() ? "OFFLINE_RECOVERY" : "OFFLINE_NORMAL") });

const sessao = criarSessaoBaileys({
  authAdapter,
  backendClient,
  config,
  fabricaSocket: makeWASocket,
  inbound,
  rastreadorOrigem,
  DisconnectReasonLoggedOut: DisconnectReason.loggedOut,
  leaseManager,
});

const app = express();
app.disable("x-powered-by");

// Probe do Render — antes do HMAC, de propósito. Não revela nada sensível.
app.get("/health", health);

// express.raw: o HMAC assina os BYTES recebidos. Reparsear/reserializar
// JSON mudaria a representação e quebraria a assinatura. As rotas usam
// `req.corpoJson`, produzido pelo middleware.
app.use(
  "/internal",
  express.raw({ type: "*/*", limit: config.limiteCorpoBytes }),
  exigirHmac(config.segredoHmac),
  (req, res, next) => {
    // Controle legado sem fencing não pode concorrer com operações persistentes.
    if (req.method === "POST" && /^\/whatsapp\/(connect|disconnect|reset|desconectar-conta)\/?$/.test(req.path))
      return res.status(409).json({ error: "OPERACAO_OBRIGATORIA" });
    next();
  },
  criarRotas(sessao, { executarOperacao: criarExecutorOperacao(sessao, backendClient) }),
);

app.use((_req, res) => res.status(404).json({ error: "not_found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  log("error", "erro_nao_tratado", { rota: req.path, mensagem: err?.message });
  res.status(err?.status ?? 500).json({ error: err?.codigo ?? "WHATSAPP_GATEWAY_UNAVAILABLE" });
});

const servidor = app.listen(config.porta, () => {
  log("info", "gateway.iniciado", { porta: config.porta, gatewayVersion: config.gatewayVersion, gatewayProcessId });
});

servidor.headersTimeout = 65_000;

// Checkpoint C3.5, item 8 — tenta virar LEADER assim que sobe; se não
// ganhar, já entra sozinho em polling STANDBY (nunca abre socket, nunca
// chama conectar()). Roda em paralelo ao `listen()` acima — /health
// responde independente de já ter resolvido a lease.
leaseManager.iniciar().catch((e) => log("error", "lease.iniciar_falhou", { erro: e?.message }));

// --- shutdown gracioso --------------------------------------------------
// Checkpoint C3.5, itens 9/10 — a ORDEM decide se isto é seguro:
//   LEADER:  para timers -> fecha socket (via desconectar(), que também
//            manda o heartbeat FINAL, ainda com o epoch válido) -> só
//            DEPOIS libera a lease. Nunca libera antes de fechar o socket
//            (senão um processo novo poderia adquirir e abrir socket novo
//            enquanto este ainda está conectado — overlap).
//   STANDBY: para o polling e pronto. NUNCA chama `sessao.desconectar()` —
//            não tem lease, não tem socket, não pode gravar heartbeat
//            nenhum. É exatamente isto que teria impedido o que a
//            instância ociosa `j4jv6` fez ao vivo (escrever DISCONNECTED
//            sem nunca ter tido conexão real).
let encerrando = false;
async function encerrar(sinal) {
  if (encerrando) return;
  encerrando = true;
  log("warn", "gateway.encerrando", { sinal });
  servidor.close();

  leaseManager.pararTemporizadores();
  if (leaseManager.souLeader()) {
    await sessao.desconectar().catch(() => {});
    await leaseManager.liberar().catch(() => {});
  }

  log("info", "gateway.encerrado", { sinal });
  process.exit(0);
}
for (const sinal of ["SIGTERM", "SIGINT"]) process.on(sinal, () => encerrar(sinal));

process.on("uncaughtException", async (e) => {
  log("error", "excecao_nao_capturada", { mensagem: e.message });
  leaseManager.pararTemporizadores();
  // Mesma regra do shutdown gracioso (item 9/10): só quem é leader manda o
  // heartbeat final — um standby nunca grava nada aqui.
  if (leaseManager.souLeader()) await sessao.desconectar().catch(() => {});
  process.exit(1);
});
process.on("unhandledRejection", (motivo) => {
  log("error", "promessa_rejeitada", { mensagem: String(motivo?.message ?? motivo) });
});
