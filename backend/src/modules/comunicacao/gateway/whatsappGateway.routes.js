// Rotas Gateway -> Backend (Checkpoint C0, item 7 / C1, item 7).
//
// Isolamento da API pública (Checkpoint C1, item 6): estas rotas NÃO ficam
// sob /api/v1 (que exige `requireAuth`, um JWT de usuário Supabase — o
// Gateway não tem, nem deveria ter, um usuário). Elas são montadas
// separadamente em backend/src/app.js, ANTES do `requireAuth`, protegidas
// exclusivamente pelo HMAC de whatsappGateway.hmac.js. Isso é o que as torna
// "não utilizáveis como API pública normal": sem o segredo, 401 sempre —
// nenhuma sessão de usuário, por mais privilegiada, abre essas rotas.
//
// `organizacaoId` NÃO vem do Gateway (ele não conhece organizações/unidades
// — boundary do Checkpoint C0, item 4). Vem de configuração do BACKEND
// (WHATSAPP_GATEWAY_ORGANIZACAO_ID), porque C1 assume um único número/
// gateway para uma única organização (Checkpoint C0, item 20 — não
// superdimensionar agora). Generalizar para múltiplos números é trabalho
// futuro explícito, não um atalho silencioso.

import { Router } from "express";
import { transicaoEfeito } from "../comunicacao.operacoes.js";
import { LeaseStaleError, AuthSessionStaleError, AuthConfirmacaoRecusadaError } from "./whatsappGateway.repo.js";
import { validarEventoInbound, motivoBloqueioAutomacao } from "../inbound/inbound.contrato.js";
import { validarEventoStatusProvider, CONTRATO_STATUS_VERSAO_VINCULADO } from "../comunicacao.statusProvider.js";

// UUID v4-ish — o Gateway gera gatewayProcessId com crypto.randomUUID() a
// cada boot (Checkpoint C3.5, item 2). Validado aqui (fronteira HTTP) antes
// de qualquer coisa tocar o repo — nunca deixamos um valor malformado virar
// parte de uma query (mesmo já sendo parametrizada pelo supabase-js, é
// defesa em profundidade e um 400 é mais claro que um "stale" genérico).
const GATEWAY_PROCESS_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Checkpoint C3.5-C.2/C.3 — mesma forma de UUID, reaproveitada para validar
// authSessionId (gerado pelo Postgres via gen_random_uuid()) na fronteira
// HTTP, antes de chegar ao repo/RPC — defesa em profundidade, mesmo padrão
// já usado para gatewayProcessId.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function processIdValido(v) {
  return typeof v === "string" && GATEWAY_PROCESS_ID_RE.test(v);
}
function authSessionIdValido(v) {
  return typeof v === "string" && UUID_RE.test(v);
}
// Checkpoint C3.5-A (auditoria) — mesma faixa validada dentro das funções
// SQL da migration 084 (defesa em profundidade: a autoridade final é o
// banco, mas rejeitar aqui dá um 400 claro em vez de deixar a RPC lançar).
// Justificativa dos limites no cabeçalho da migration 084.
const TTL_MIN_MS = 1;
const TTL_MAX_MS = 300_000; // 5 minutos — >6x o WHATSAPP_LEASE_TTL_MS configurado (45s)

function ttlValido(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= TTL_MIN_MS && v <= TTL_MAX_MS;
}
function epochValido(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./whatsappGateway.repo.js').criarRepoEmMemoria>} deps.repo
 * @param {string} deps.organizacaoId
 * @param {import('../whatsapp.provider.js').WhatsAppProvider & {_receberEventoMensagem?: Function}} [deps.provider]
 *   opcional — quando presente, repassa o evento de mensagem recebida para
 *   os handlers registrados via `provider.onMessage()` (Checkpoint F).
 *   Sem isso, mensagem recebida só fica registrada pelo repo.
 * @param {{processarInbound: (p: {organizacaoId: string, evento: object}) => Promise<{destino: string}>}} [deps.inbox]
 *   Central de Comunicação — decide se o evento vira mensagem de conversa (SÓ responsável autorizado). Sem isto (testes antigos), o comportamento de
 *   sempre: só o razão técnico.
 */
export function criarWhatsappGatewayRouter({ repo, organizacaoId, provider, inbox, efeito = transicaoEfeito, providerInstanceId = process.env.WHATSAPP_PROVIDER_INSTANCE_ID ?? "default" }) {
  const router = Router();
  router.post("/operacao/efeito", async (req, res, next) => {
    try {
      const { operacaoId, token, acao, fase } = req.corpoJson ?? {};
      if (!UUID_RE.test(operacaoId ?? "") || !UUID_RE.test(token ?? "") ||
          !["CONECTAR", "ENCERRAR", "DESCONECTAR", "RESET"].includes(acao) ||
          !["CONSUMIR", "CONCLUIR", "INCERTO", "FALHA_DETERMINISTICA"].includes(fase)) return res.status(400).json({ error: "OPERACAO_INVALIDA" });
      const ok = await efeito({ organizacaoId, operacaoId, token, acao, fase });
      res.status(ok ? 200 : 409).json({ ok, ...(ok ? {} : { error: "OPERACAO_INVALIDA" }) });
    } catch (e) { next(e); }
  });

  // Checkpoint F — contrato inbound ESTRITO. 400 com um CÓDIGO fechado (nunca ecoa o valor). O organizacaoId vem da CONFIG do backend, nunca do
  // corpo (chave desconhecida ⇒ 400). Persiste em tabela PRÓPRIA (idempotente). Só um evento novo E elegível (LIVE, cliente direto, sem
  // fromMe/falha/stub, estado RECEIVED) chega ao provider: recovery, offline, fromMe, falha de decrypt e duplicata NUNCA disparam nada.
  router.post("/eventos/mensagem-recebida", async (req, res, next) => {
    try {
      const v = validarEventoInbound(req.corpoJson);
      if (!v.ok) return res.status(400).json({ error: "mensagem_recebida_invalida", campo: v.erro });
      // Central de Comunicação — o CONTEÚDO (texto/tipo) só serve à conversa: nunca vai ao razão técnico (090) nem ao provider/automação.
      const { tipoConteudo: _t, texto: _x, ...tecnico } = v.evento;
      // PRIVACIDADE: resolve o contato ANTES de gravar. Autorizado ⇒ conversa. Desconhecido ⇒ ignorado, e o razão técnico NÃO guarda o telefone dele.
      // Uma falha do inbox (ex.: migration 096 ainda não aplicada) NUNCA derruba o razão técnico: degrada para IGNORADO (fail-closed) e loga SEM dados.
      let decisao = null;
      if (inbox) {
        try { decisao = await inbox.processarInbound({ organizacaoId, evento: v.evento }); } catch (e) {
          console.error(JSON.stringify({ evento: "central.inbox_falhou", erro: String(e?.name ?? "erro").slice(0, 60) }));
          decisao = { destino: "IGNORADO", motivo: "falha_interna" };
        }
      }
      const paraRazao = decisao && decisao.destino !== "INBOX" ? { ...tecnico, telefoneE164: null, telefoneOrigem: null } : tecnico;
      const r = await repo.registrarMensagemRecebida(organizacaoId, paraRazao);
      if (!r.duplicada && motivoBloqueioAutomacao({ ...tecnico, estado: r.estado }) === null) provider?._receberEventoMensagem?.(tecnico);
      res.json({ ok: true, duplicada: r.duplicada, estado: r.estado });
    } catch (e) { next(e); }
  });

  // H.4-B.4 — confirmações de entrega do provider (SERVER_ACK/DELIVERED/READ/PROVIDER_ERROR). MESMO canal autenticado do Gateway (HMAC + anti-replay
  // do middleware `exigirHmac`, montado antes de requireAuth): nenhuma rota pública nova. Contrato estrito (400 com CÓDIGO fechado, nunca ecoa o valor);
  // o organizacaoId vem da CONFIG do backend. 200 mesmo com `NAO_ENCONTRADA` (o receipt pode chegar antes do backend gravar o providerMessageId): o
  // Gateway lê `resultado` e faz retry limitado. Quem propaga ao alerta é o trigger do banco (088/092), nunca esta rota.
  router.post("/eventos/status-provider", async (req, res, next) => {
    try {
      const v = validarEventoStatusProvider(req.corpoJson);
      if (!v.ok) return res.status(400).json({ error: "status_provider_invalido", campo: v.erro });
      // v2 (vinculado): a instância emissora tem de ser a configurada. Divergência => resposta idêntica a "não encontrada" (sem oráculo) + contador sem dados.
      if (v.evento.contrato === CONTRATO_STATUS_VERSAO_VINCULADO && v.evento.providerInstanceId !== providerInstanceId) {
        console.warn(JSON.stringify({ evento: "status_provider.instancia_divergente" }));
        return res.json({ ok: true, resultado: "NAO_ENCONTRADA" });
      }
      const r = await repo.registrarStatusProvider(organizacaoId, v.evento);
      res.json({ ok: true, resultado: r?.resultado ?? null });
    } catch (e) { next(e); }
  });

  // FENCING (Checkpoint C3.5) — heartbeat e auth-state são as duas gravações
  // sensíveis de estado da sessão (item 5 do checklist). As duas exigem
  // gatewayProcessId + leaseEpoch e devolvem 409 WHATSAPP_GATEWAY_LEASE_STALE
  // (nunca 500, nunca sucesso silencioso) quando o processo não é mais o
  // dono atual — é assim que se evita exatamente o que a instância ociosa
  // `j4jv6` fez ao vivo (escrever DISCONNECTED por cima de um estado mais
  // novo só porque chegou depois).
  function corpoFencingValido(corpo) {
    return processIdValido(corpo?.gatewayProcessId) && epochValido(corpo?.leaseEpoch);
  }

  router.post("/eventos/heartbeat", async (req, res, next) => {
    try {
      const corpo = req.corpoJson ?? {};
      if (!corpoFencingValido(corpo)) {
        return res.status(400).json({ error: "gatewayProcessId/leaseEpoch ausente ou inválido" });
      }
      await repo.registrarHeartbeat(organizacaoId, corpo);
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof LeaseStaleError) return res.status(409).json({ error: e.code });
      next(e);
    }
  });

  router.post("/eventos/auth-state", async (req, res, next) => {
    try {
      const corpo = req.corpoJson ?? {};
      const { authStateEncrypted, authStateVersion } = corpo;
      if (typeof authStateEncrypted !== "string" || !authStateEncrypted) {
        return res.status(400).json({ error: "authStateEncrypted ausente" });
      }
      if (!corpoFencingValido(corpo)) {
        return res.status(400).json({ error: "gatewayProcessId/leaseEpoch ausente ou inválido" });
      }
      // O backend armazena SÓ o ciphertext — nunca decifra (não tem a
      // chave). Ver Checkpoint C0, item 8/11.
      await repo.salvarAuthState(organizacaoId, { authStateEncrypted, authStateVersion, gatewayProcessId: corpo.gatewayProcessId, leaseEpoch: corpo.leaseEpoch });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof LeaseStaleError) return res.status(409).json({ error: e.code });
      next(e);
    }
  });

  // Reset explícito do operador (Checkpoint C3.5-B.2) — invalida o
  // ciphertext antigo de forma controlada (ex.: sessão revogada fora de
  // banda, pelo celular) para permitir um pareamento novo. Rota NOVA, sem
  // preocupação de retrocompat de rolling deploy: fencing SEMPRE
  // obrigatório aqui (nunca opcional como em GET /auth-state).
  router.post("/eventos/auth-state/reset", async (req, res, next) => {
    try {
      const corpo = req.corpoJson ?? {};
      if (!corpoFencingValido(corpo)) {
        return res.status(400).json({ error: "gatewayProcessId/leaseEpoch ausente ou inválido" });
      }
      await repo.resetarAuthState(organizacaoId, { gatewayProcessId: corpo.gatewayProcessId, leaseEpoch: corpo.leaseEpoch });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof LeaseStaleError) return res.status(409).json({ error: e.code });
      next(e);
    }
  });

  // Confirmação durável da geração de auth (Checkpoint C3.5-C.2/C.3) — só
  // pode ser chamada pelo Gateway depois de connection:"open" observado E
  // toda persistência pendente concluída (ver baileysSession.js). Fencing
  // SEMPRE obrigatório (rota nova, sem janela de rolling deploy a
  // proteger, mesmo raciocínio de /eventos/auth-state/reset).
  router.post("/eventos/auth-state/confirmar", async (req, res, next) => {
    try {
      const corpo = req.corpoJson ?? {};
      if (!corpoFencingValido(corpo)) {
        return res.status(400).json({ error: "gatewayProcessId/leaseEpoch ausente ou inválido" });
      }
      if (!authSessionIdValido(corpo.authSessionId)) {
        return res.status(400).json({ error: "authSessionId ausente ou inválido" });
      }
      await repo.confirmarAuthState(organizacaoId, {
        gatewayProcessId: corpo.gatewayProcessId, leaseEpoch: corpo.leaseEpoch,
        authSessionIdEsperado: corpo.authSessionId,
      });
      res.json({ ok: true });
    } catch (e) {
      // Checkpoint C3.5-C.2/C.3 — três motivos de rejeição, três status
      // sanitizados distintos no corpo (nunca a mensagem interna do erro):
      // LEASE_STALE é o mesmo 409 de sempre; AUTH_SESSION_STALE é um 409
      // com código PRÓPRIO (diagnosticável em log/telemetria como "geração
      // errada", nunca confundido com "dono errado"); AUTH_ABSENT/NOT_FOUND
      // (anomalias) caem no mesmo 409 genérico de confirmação recusada.
      if (e instanceof LeaseStaleError) return res.status(409).json({ error: e.code });
      if (e instanceof AuthSessionStaleError) return res.status(409).json({ error: e.code });
      if (e instanceof AuthConfirmacaoRecusadaError) return res.status(409).json({ error: e.code });
      next(e);
    }
  });

  router.get("/auth-state", async (req, res, next) => {
    try {
      // Fencing OPCIONAL via querystring (Checkpoint C3.5-B, item 11) —
      // GET não tem corpo; `req.query` já vem parseado pelo Express a
      // partir de `req.originalUrl` (que é o que o HMAC assina). Malformado
      // é tratado como "ausente" (cai no comportamento antigo), nunca como
      // erro — retrocompatível de propósito durante rolling deploy.
      const gatewayProcessId = processIdValido(req.query.gatewayProcessId) ? req.query.gatewayProcessId : undefined;
      const leaseEpochNum = Number(req.query.leaseEpoch);
      const leaseEpoch = epochValido(leaseEpochNum) ? leaseEpochNum : undefined;
      const resultado = await repo.obterAuthState(organizacaoId, { gatewayProcessId, leaseEpoch });
      // Checkpoint C3.5-B.1 — `status` explícito é o contrato NOVO (Gateway
      // atualizado passa a ler isto). `authStateEncrypted` no nível raiz é
      // mantido de propósito quando presente — é o que um Gateway ANTERIOR
      // a este checkpoint (retrocompat de rolling deploy) continua lendo
      // (`!r?.authStateEncrypted` → comportamento antigo, inalterado).
      // Checkpoint C3.5-C.2/C.3 — authConfirmado/authSessionId são campos
      // NOVOS e ADITIVOS: um Gateway anterior a este checkpoint simplesmente
      // os ignora (nunca os lê), sem quebrar nada.
      if (resultado.status === "present") {
        res.json({
          status: "present",
          authStateEncrypted: resultado.authStateEncrypted,
          authConfirmado: resultado.authConfirmado === true,
          authSessionId: resultado.authSessionId ?? null,
        });
      } else {
        res.json({ status: "absent" });
      }
    } catch (e) {
      if (e instanceof LeaseStaleError) return res.status(409).json({ error: e.code });
      next(e);
    }
  });

  // ---- intenção do operador (Checkpoint C3.5-B) ----
  router.post("/eventos/desired-state", async (req, res, next) => {
    try {
      const corpo = req.corpoJson ?? {};
      if (corpo.desiredConnectionState !== "CONNECTED" && corpo.desiredConnectionState !== "DISCONNECTED") {
        return res.status(400).json({ error: "desiredConnectionState precisa ser CONNECTED ou DISCONNECTED" });
      }
      if (!corpoFencingValido(corpo)) {
        return res.status(400).json({ error: "gatewayProcessId/leaseEpoch ausente ou inválido" });
      }
      await repo.definirEstadoDesejado(organizacaoId, {
        desiredConnectionState: corpo.desiredConnectionState, gatewayProcessId: corpo.gatewayProcessId, leaseEpoch: corpo.leaseEpoch,
      });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof LeaseStaleError) return res.status(409).json({ error: e.code });
      next(e);
    }
  });

  // Leitura fenced de status + intenção — usada pelo restore automático
  // (Checkpoint C3.5-B) para decidir se pode restaurar. REQUER fencing
  // (diferente de /auth-state, que o mantém opcional por retrocompatibilidade
  // — esta rota é nova, nasce junto com o código que a usa, sem janela de
  // deploy a proteger).
  router.get("/estado-conexao", async (req, res, next) => {
    try {
      const gatewayProcessId = req.query.gatewayProcessId;
      const leaseEpoch = Number(req.query.leaseEpoch);
      if (!processIdValido(gatewayProcessId) || !epochValido(leaseEpoch)) {
        return res.status(400).json({ error: "gatewayProcessId/leaseEpoch ausente ou inválido" });
      }
      const estado = await repo.obterEstadoSessao(organizacaoId, { gatewayProcessId, leaseEpoch });
      res.json(estado);
    } catch (e) {
      if (e instanceof LeaseStaleError) return res.status(409).json({ error: e.code });
      next(e);
    }
  });

  // ---- lease/fencing (Checkpoint C3.5, item 6) ----
  // Mesma fronteira HMAC das demais rotas /internal/comunicacao — nunca
  // expostas publicamente (ver server.js do Gateway e app.js do backend,
  // que montam isto ANTES de requireAuth e só atrás de exigirHmac).
  router.post("/lease/acquire", async (req, res, next) => {
    try {
      const { gatewayProcessId, ttlMs } = req.corpoJson ?? {};
      if (!processIdValido(gatewayProcessId)) {
        return res.status(400).json({ error: "gatewayProcessId ausente ou inválido" });
      }
      if (!ttlValido(ttlMs)) {
        return res.status(400).json({ error: `ttlMs precisa estar entre ${TTL_MIN_MS} e ${TTL_MAX_MS} ms` });
      }
      const r = await repo.adquirirLease(organizacaoId, { gatewayProcessId, ttlMs });
      res.json({ acquired: r.acquired, leaseEpoch: r.leaseEpoch, expiresAt: r.expiresAt });
    } catch (e) { next(e); }
  });

  router.post("/lease/renew", async (req, res, next) => {
    try {
      const { gatewayProcessId, leaseEpoch, ttlMs } = req.corpoJson ?? {};
      if (!processIdValido(gatewayProcessId) || !epochValido(leaseEpoch)) {
        return res.status(400).json({ error: "gatewayProcessId/leaseEpoch ausente ou inválido" });
      }
      if (!ttlValido(ttlMs)) {
        return res.status(400).json({ error: `ttlMs precisa estar entre ${TTL_MIN_MS} e ${TTL_MAX_MS} ms` });
      }
      const r = await repo.renovarLease(organizacaoId, { gatewayProcessId, leaseEpoch, ttlMs });
      if (!r.renewed) return res.status(409).json({ error: "WHATSAPP_GATEWAY_LEASE_STALE" });
      res.json({ renewed: true, leaseEpoch: r.leaseEpoch, expiresAt: r.expiresAt });
    } catch (e) { next(e); }
  });

  router.post("/lease/release", async (req, res, next) => {
    try {
      const { gatewayProcessId, leaseEpoch } = req.corpoJson ?? {};
      if (!processIdValido(gatewayProcessId) || !epochValido(leaseEpoch)) {
        return res.status(400).json({ error: "gatewayProcessId/leaseEpoch ausente ou inválido" });
      }
      const r = await repo.liberarLease(organizacaoId, { gatewayProcessId, leaseEpoch });
      res.json({ released: r.released });
    } catch (e) { next(e); }
  });

  return router;
}
