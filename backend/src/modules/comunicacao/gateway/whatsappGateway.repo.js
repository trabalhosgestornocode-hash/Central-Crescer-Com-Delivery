// Persistência dos eventos do Gateway WhatsApp em `whatsapp_conexoes`.
//
// STATUS (Checkpoint C2): a migration 083 (database/migrations/
// 083_whatsapp_conexoes.sql) já foi aplicada no banco de TESTE e validada
// (schema, RLS, grants, constraints — ver checkpoint intermediário do C2).
// PRODUÇÃO AINDA NÃO — `criarRepoSupabase()` já funciona de verdade, mas
// `whatsappGateway.bootstrap.js` continua usando `criarRepoEmMemoria()` até
// a 083 ser aplicada em produção (decisão explícita, não esquecimento).
//
// Import de config/supabase.js só acontece dentro de `criarRepoSupabase`
// (via `import()` dinâmico, preguiçoso — só na primeira chamada real), nunca
// no topo do módulo — assim importar este arquivo não implica abrir conexão
// nenhuma, e o repo em memória (ainda o único usado em produção) nunca toca
// a rede. Ver whatsapp-gateway-seguranca.test.js, que verifica isso.
//
// ÚNICO NÚMERO POR ORGANIZAÇÃO (Checkpoint C0, item 20): `provider_instance_id`
// existe na tabela para o futuro, mas não é parâmetro público das funções
// abaixo ainda — fica fixo em INSTANCIA_PADRAO ("default") até existir
// roteamento multi-instância de verdade. Não superdimensionar agora.
//
// GATEWAY -> BANCO DIRETO CONTINUA PROIBIDO: só este arquivo (dentro do
// BACKEND) fala com Supabase. O processo gateway-whatsapp nunca importa
// nada daqui — ele só vê o backend via HTTP+HMAC (backendClient.js).

import { ApiError } from "../../../shared/ApiError.js";

const INSTANCIA_PADRAO = "default";

// FENCING (Checkpoint C3.5) — lançado por salvarAuthState/registrarHeartbeat
// quando o (gatewayProcessId, leaseEpoch) apresentado não bate com o dono
// atual da lease. Nunca sobrescreve nada quando isto acontece: a rota HTTP
// (whatsappGateway.routes.js) traduz isto em 409, nunca em 500 — é o
// comportamento ESPERADO de um processo stale, não uma falha de infra.
export class LeaseStaleError extends Error {
  constructor(detalhe) {
    super("lease stale — gatewayProcessId/leaseEpoch não é mais o dono atual");
    this.name = "LeaseStaleError";
    this.code = "WHATSAPP_GATEWAY_LEASE_STALE";
    this.detalhe = detalhe;
  }
}

/**
 * Checkpoint C3.5, itens 1/4 (auditoria) — fencing de uma gravação sensível
 * (heartbeat/auth-state) exige as TRÊS condições, não só owner+epoch:
 *   lease_owner_id = gatewayProcessId
 *   AND lease_epoch = leaseEpoch
 *   AND lease_expires_at > agora
 * Sem a terceira condição, um dono cujo TTL já venceu — mas que ainda
 * ninguém tomou (nenhum outro processo chegou a chamar acquire) — continuaria
 * escrevendo livremente, com a garantia dependendo só do auto-fencing por
 * relógio do lado do Gateway (não é aceitável: o BANCO precisa recusar
 * sozinho, mesmo que o Gateway nunca percebesse que passou do prazo).
 */
function fencingValido(atual, { gatewayProcessId, leaseEpoch }, agora = Date.now()) {
  // Fencing ausente/malformado nunca pode "por acaso" bater (ex.: nenhuma
  // lease foi adquirida ainda e o caller também não mandou nada — os dois
  // lados `undefined` não podem contar como owner válido).
  if (!gatewayProcessId || typeof leaseEpoch !== "number") return false;
  if (!atual?.leaseOwnerId || atual.leaseOwnerId !== gatewayProcessId || atual.leaseEpoch !== leaseEpoch) return false;
  if (!atual.leaseExpiresAt || new Date(atual.leaseExpiresAt).getTime() <= agora) return false;
  return true;
}

/** Repositório em memória — usado por padrão em C1 (tabela real não existe ainda). */
export function criarRepoEmMemoria() {
  const porOrganizacao = new Map(); // organizacaoId -> registro

  return {
    /**
     * Checkpoint C3.5-B.1 — contrato explícito de 3 resultados, nunca mais
     * um `string|null` ambíguo (achado ao vivo: um `null` por "nunca
     * pareado" e um `null` por "fencing não bateu" eram indistinguíveis,
     * e o Gateway tratava os dois como "sem sessão" — gerando QR por cima
     * de uma sessão real já pareada).
     *   { status: "absent" }                       — nenhum ciphertext salvo
     *   { status: "present", authStateEncrypted }   — ciphertext existe
     *   throws LeaseStaleError                      — owner+epoch informados
     *     e não batem com o dono atual (nunca confundido com "absent")
     * Fencing continua OPCIONAL (retrocompat de rolling deploy — item 11):
     * só é aplicado quando o caller manda owner+epoch. Sem checagem de
     * expiração aqui de propósito, mesma justificativa de sempre — a
     * autoridade de tempo continua só nas escritas.
     */
    async obterAuthState(organizacaoId, { gatewayProcessId, leaseEpoch } = {}) {
      const atual = porOrganizacao.get(organizacaoId);
      if (!atual) return { status: "absent" };
      if (gatewayProcessId && typeof leaseEpoch === "number") {
        if (atual.leaseOwnerId !== gatewayProcessId || atual.leaseEpoch !== leaseEpoch) {
          throw new LeaseStaleError({ organizacaoId });
        }
      }
      if (!atual.authStateEncrypted) return { status: "absent" };
      return { status: "present", authStateEncrypted: atual.authStateEncrypted };
    },
    async salvarAuthState(organizacaoId, { authStateEncrypted, authStateVersion, gatewayProcessId, leaseEpoch }) {
      const atual = porOrganizacao.get(organizacaoId) ?? {};
      if (!fencingValido(atual, { gatewayProcessId, leaseEpoch })) throw new LeaseStaleError({ organizacaoId });
      porOrganizacao.set(organizacaoId, { ...atual, authStateEncrypted, authStateVersion, updatedAt: new Date().toISOString() });
    },
    async registrarHeartbeat(organizacaoId, { status, telefone, gatewayVersion, providerInstanceId, gatewayProcessId, leaseEpoch }) {
      const atual = porOrganizacao.get(organizacaoId) ?? {};
      if (!fencingValido(atual, { gatewayProcessId, leaseEpoch })) throw new LeaseStaleError({ organizacaoId });
      porOrganizacao.set(organizacaoId, {
        ...atual, status, telefone: telefone ?? atual.telefone ?? null, gatewayVersion, providerInstanceId,
        lastSeenAt: new Date().toISOString(),
      });
    },
    // ---- intenção do operador (Checkpoint C3.5-B) ----
    // Campo SEPARADO de `status`: nunca escrito por registrarHeartbeat, nem
    // por qualquer caminho técnico (SIGTERM/perda de lease) — só por
    // chamada explícita a esta função (que corresponde a /connect ou
    // /disconnect manuais, ou a um LOGGED_OUT real detectado). Default
    // 'DISCONNECTED' para linha nova, igual à migration 085.
    async definirEstadoDesejado(organizacaoId, { desiredConnectionState, gatewayProcessId, leaseEpoch }) {
      const atual = porOrganizacao.get(organizacaoId) ?? { desiredConnectionState: "DISCONNECTED" };
      if (!fencingValido(atual, { gatewayProcessId, leaseEpoch })) throw new LeaseStaleError({ organizacaoId });
      if (desiredConnectionState !== "CONNECTED" && desiredConnectionState !== "DISCONNECTED") {
        throw new Error(`desiredConnectionState inválido: ${desiredConnectionState}`);
      }
      porOrganizacao.set(organizacaoId, { ...atual, desiredConnectionState });
    },
    /** Leitura fenced (owner+epoch, sem checar expiração — mesma justificativa de obterAuthState) usada pelo restore para decidir se pode restaurar. */
    async obterEstadoSessao(organizacaoId, { gatewayProcessId, leaseEpoch } = {}) {
      const atual = porOrganizacao.get(organizacaoId) ?? { desiredConnectionState: "DISCONNECTED" };
      if (atual.leaseOwnerId !== gatewayProcessId || atual.leaseEpoch !== leaseEpoch) throw new LeaseStaleError({ organizacaoId });
      return { status: atual.status ?? null, desiredConnectionState: atual.desiredConnectionState ?? "DISCONNECTED" };
    },
    // ---- lease/fencing (Checkpoint C3.5) ----
    // Single-process, Map síncrono: cada bloco abaixo é atômico por
    // construção (nenhum `await` entre a leitura e a escrita do Map), o
    // equivalente em memória do UPDATE...WHERE atômico do repo Supabase.
    async adquirirLease(organizacaoId, { gatewayProcessId, ttlMs }) {
      const atual = porOrganizacao.get(organizacaoId) ?? {};
      const agora = Date.now();
      // <= (não só <): uma lease cujo expires_at é exatamente "agora" já
      // conta como vencida — evita depender de o relógio ter avançado pelo
      // menos 1ms entre duas chamadas síncronas (Date.now() tem resolução
      // de ~1ms; um TTL curtíssimo pode cair no mesmo tick).
      const expirada = !atual.leaseExpiresAt || new Date(atual.leaseExpiresAt).getTime() <= agora;

      // Checkpoint C3.5, item 3 (auditoria) — RE-ACQUIRE pelo MESMO dono,
      // ainda dentro do TTL, é uma RENOVAÇÃO, nunca uma posse nova: NÃO pode
      // incrementar o epoch. Um acquire duplicado do mesmo processo (retry,
      // bug) jamais pode invalidar silenciosamente escritas/heartbeats já em
      // voo assinados com o epoch atual — só uma troca REAL de dono (owner
      // null, expirado, ou outro processo) justifica epoch novo.
      if (atual.leaseOwnerId === gatewayProcessId && !expirada) {
        const expiresAt = new Date(agora + ttlMs).toISOString();
        porOrganizacao.set(organizacaoId, { ...atual, leaseExpiresAt: expiresAt });
        return { acquired: true, leaseEpoch: atual.leaseEpoch, expiresAt };
      }

      const elegivel = !atual.leaseOwnerId || expirada;
      if (!elegivel) {
        return { acquired: false, leaseEpoch: atual.leaseEpoch ?? 0, expiresAt: atual.leaseExpiresAt ?? null };
      }
      const leaseEpoch = (atual.leaseEpoch ?? 0) + 1;
      const expiresAt = new Date(agora + ttlMs).toISOString();
      porOrganizacao.set(organizacaoId, { ...atual, leaseOwnerId: gatewayProcessId, leaseEpoch, leaseExpiresAt: expiresAt });
      return { acquired: true, leaseEpoch, expiresAt };
    },
    async renovarLease(organizacaoId, { gatewayProcessId, leaseEpoch, ttlMs }) {
      const atual = porOrganizacao.get(organizacaoId) ?? {};
      // Checkpoint C3.5, item 4 (auditoria) — renovar uma lease JÁ EXPIRADA
      // (mesmo com owner/epoch ainda batendo) é recusado: uma renovação
      // atrasada que chega depois do prazo não pode "ressuscitar" uma posse
      // que já podia ter sido tomada por outro processo. `fencingValido` já
      // checa expiração — reaproveitado aqui de propósito (mesma regra).
      if (!fencingValido(atual, { gatewayProcessId, leaseEpoch })) return { renewed: false, leaseEpoch: null, expiresAt: null };
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      porOrganizacao.set(organizacaoId, { ...atual, leaseExpiresAt: expiresAt });
      return { renewed: true, leaseEpoch, expiresAt };
    },
    async liberarLease(organizacaoId, { gatewayProcessId, leaseEpoch }) {
      const atual = porOrganizacao.get(organizacaoId) ?? {};
      if (!fencingValido(atual, { gatewayProcessId, leaseEpoch })) return { released: false };
      porOrganizacao.set(organizacaoId, { ...atual, leaseOwnerId: null, leaseExpiresAt: null });
      return { released: true };
    },
    async registrarStatusProvider(_organizacaoId, { providerMessageId, status }) {
      // Checkpoint C2: escrever em comunicacao_mensagens/comunicacao_tentativas
      // (não em whatsapp_conexoes — isto é sobre a CONEXÃO, não a mensagem).
      return { providerMessageId, status };
    },
    async registrarMensagemRecebida(_organizacaoId, payload) {
      // Checkpoint F: resolução de contato/perfil + comunicacao_conversas.
      // Por ora, só repassa o evento (log fica a cargo do handler da rota).
      return payload;
    },
    // ---- só para teste ----
    _snapshot: (organizacaoId) => porOrganizacao.get(organizacaoId) ?? null,
  };
}

/**
 * Repositório real, contra `whatsapp_conexoes` (Supabase). Multi-tenant por
 * construção: toda query é filtrada por `organizacao_id` (e `provider_instance_id`)
 * — nunca existe um "obter a conexão" sem organização, mesmo havendo hoje só
 * uma organização configurada (WHATSAPP_GATEWAY_ORGANIZACAO_ID).
 */
export function criarRepoSupabase() {
  // Import preguiçoso (só na primeira chamada real) — ver nota no topo do
  // arquivo. `deps.supabase` (testes) sempre tem prioridade sobre o cliente
  // real, e nunca dispara o import dinâmico.
  let clientePromise = null;
  async function obterCliente(deps) {
    if (deps?.supabase) return deps.supabase;
    if (!clientePromise) clientePromise = import("../../../config/supabase.js").then((m) => m.supabase);
    return clientePromise;
  }

  /** Localiza a linha (organizacao_id, provider_instance_id); cria vazia (defaults da 083) se não existir ainda. */
  async function obterOuCriarConexao(db, organizacaoId, providerInstanceId) {
    const sel = await db.from("whatsapp_conexoes").select("*")
      .eq("organizacao_id", organizacaoId).eq("provider_instance_id", providerInstanceId).maybeSingle();
    if (sel.error) throw ApiError.internal(sel.error.message);
    if (sel.data) return sel.data;

    const ins = await db.from("whatsapp_conexoes")
      .insert({ organizacao_id: organizacaoId, provider_instance_id: providerInstanceId })
      .select("*").single();
    if (ins.error) throw ApiError.internal(ins.error.message);
    return ins.data;
  }

  /**
   * Checkpoint C3.5 (auditoria de autoridade de relógio) — toda decisão de
   * validade de lease e todo `lease_expires_at` novo são calculados DENTRO
   * do Postgres (`now()`), nunca no Node. PostgREST não permite expressar
   * `now()`/`now()+interval` num `.update()`/`.gt()` comum (são só
   * comparação/atribuição de valores literais, nunca expressões avaliadas
   * no banco) — por isso as 5 operações fenced (acquire/renew/release/
   * heartbeat/auth-state) são funções SQL (migration 084), chamadas via
   * `.rpc()`. O relógio do Gateway (`leaseManager.js`) continua existindo,
   * mas só para self-fencing PREVENTIVO — a autoridade que efetivamente
   * autoriza uma escrita é sempre o `now()` do banco, dentro da função.
   */
  async function chamarRpc(db, nome, args) {
    const { data, error } = await db.rpc(nome, args);
    if (error) throw ApiError.internal(error.message);
    // Toda função retorna `table(...)` — supabase-js devolve um array com
    // exatamente 1 linha (as funções sempre fazem `return query select ...`
    // uma única vez).
    return data?.[0] ?? null;
  }

  /** UPDATE fenced (owner+epoch+lease_expires_at>now(), tudo do banco) — usado por heartbeat e auth-state. 0 linhas afetadas = LeaseStaleError. */
  async function atualizarComFencing(db, organizacaoId, providerInstanceId, funcaoRpc, argsExtras, { gatewayProcessId, leaseEpoch }) {
    if (!gatewayProcessId || typeof leaseEpoch !== "number") {
      throw new LeaseStaleError({ organizacaoId, providerInstanceId, motivo: "fencing ausente" });
    }
    const r = await chamarRpc(db, funcaoRpc, {
      p_organizacao_id: organizacaoId, p_provider_instance_id: providerInstanceId,
      p_process_id: gatewayProcessId, p_epoch: leaseEpoch, ...argsExtras,
    });
    if (!r?.ok) throw new LeaseStaleError({ organizacaoId, providerInstanceId });
  }

  return {
    /**
     * Checkpoint C3.5-B.1 — mesmo contrato explícito de 3 resultados do repo
     * em memória (ver comentário lá): `{status:"absent"}`,
     * `{status:"present", authStateEncrypted}`, ou lança `LeaseStaleError`.
     * NUNCA mais um `null` ambíguo que sirva tanto para "nunca pareado"
     * quanto para "fencing não bateu" — essa ambiguidade foi a causa raiz
     * comprovada de um QR gerado por cima de uma sessão real já pareada em
     * produção (auditoria C3.5-B.1). Fencing continua OPCIONAL (retrocompat
     * de rolling deploy, item 11): só é verificado quando o caller manda
     * owner+epoch. Busca owner/epoch da linha na MESMA query (sem 2º round-
     * trip) para poder distinguir "linha não existe" de "linha existe mas
     * outro é o dono" numa única leitura.
     */
    async obterAuthState(organizacaoId, deps = {}) {
      const db = await obterCliente(deps);
      const providerInstanceId = deps.providerInstanceId ?? INSTANCIA_PADRAO;
      const { data, error } = await db.from("whatsapp_conexoes")
        .select("auth_state_encrypted, lease_owner_id, lease_epoch")
        .eq("organizacao_id", organizacaoId)
        .eq("provider_instance_id", providerInstanceId)
        .maybeSingle();
      if (error) throw ApiError.internal(error.message);
      if (!data) return { status: "absent" };
      // De propósito SEM checar `lease_expires_at > now()` aqui — mesma
      // justificativa de sempre (autoridade de tempo só nas escritas).
      if (deps.gatewayProcessId && typeof deps.leaseEpoch === "number") {
        if (data.lease_owner_id !== deps.gatewayProcessId || data.lease_epoch !== deps.leaseEpoch) {
          throw new LeaseStaleError({ organizacaoId, providerInstanceId });
        }
      }
      if (!data.auth_state_encrypted) return { status: "absent" };
      return { status: "present", authStateEncrypted: data.auth_state_encrypted };
    },

    async salvarAuthState(organizacaoId, { authStateEncrypted, authStateVersion, providerInstanceId = INSTANCIA_PADRAO, gatewayProcessId, leaseEpoch } = {}, deps = {}) {
      const db = await obterCliente(deps);
      await obterOuCriarConexao(db, organizacaoId, providerInstanceId);
      await atualizarComFencing(db, organizacaoId, providerInstanceId, "whatsapp_auth_state_fenced",
        { p_auth_state_encrypted: authStateEncrypted, p_auth_state_version: authStateVersion },
        { gatewayProcessId, leaseEpoch });
    },

    async registrarHeartbeat(organizacaoId, { status, telefone, gatewayVersion, providerInstanceId = INSTANCIA_PADRAO, lastErrorClass, gatewayProcessId, leaseEpoch } = {}, deps = {}) {
      const db = await obterCliente(deps);
      await obterOuCriarConexao(db, organizacaoId, providerInstanceId);
      // `connected_at`/`disconnected_at`/`last_seen_at` são calculados DENTRO
      // da função SQL com `now()` do banco — nunca aqui. `p_status`/
      // `p_telefone`/etc. em NULL significam "não mudar" (COALESCE na
      // função); undefined vira null naturalmente no payload JSON do RPC.
      await atualizarComFencing(db, organizacaoId, providerInstanceId, "whatsapp_heartbeat_fenced", {
        p_status: status ?? null,
        p_telefone: telefone ?? null,
        p_gateway_version: gatewayVersion ?? null,
        p_last_error_class: lastErrorClass ?? null,
      }, { gatewayProcessId, leaseEpoch });
    },

    // ---- intenção do operador (Checkpoint C3.5-B) ----
    // Campo SEPARADO de `status` — nunca escrito por registrarHeartbeat, nem
    // por qualquer caminho técnico (SIGTERM/perda de lease). Via RPC dedicada
    // (whatsapp_desired_state_fenced, migration 085) — nunca via
    // whatsapp_heartbeat_fenced, de propósito (preserva a assinatura dela
    // intacta para compatibilidade de rolling deploy).
    async definirEstadoDesejado(organizacaoId, { desiredConnectionState, providerInstanceId = INSTANCIA_PADRAO, gatewayProcessId, leaseEpoch } = {}, deps = {}) {
      const db = await obterCliente(deps);
      await obterOuCriarConexao(db, organizacaoId, providerInstanceId);
      await atualizarComFencing(db, organizacaoId, providerInstanceId, "whatsapp_desired_state_fenced",
        { p_desired_connection_state: desiredConnectionState },
        { gatewayProcessId, leaseEpoch });
    },

    /** Leitura fenced (owner+epoch, sem checar expiração — mesma justificativa de obterAuthState) usada pelo restore para decidir se pode restaurar. */
    async obterEstadoSessao(organizacaoId, { providerInstanceId = INSTANCIA_PADRAO, gatewayProcessId, leaseEpoch } = {}, deps = {}) {
      const db = await obterCliente(deps);
      const { data, error } = await db.from("whatsapp_conexoes")
        .select("status, desired_connection_state")
        .eq("organizacao_id", organizacaoId).eq("provider_instance_id", providerInstanceId)
        .eq("lease_owner_id", gatewayProcessId ?? "").eq("lease_epoch", leaseEpoch ?? -1)
        .maybeSingle();
      if (error) throw ApiError.internal(error.message);
      if (!data) throw new LeaseStaleError({ organizacaoId, providerInstanceId });
      return { status: data.status, desiredConnectionState: data.desired_connection_state };
    },

    async registrarStatusProvider(_organizacaoId, { providerMessageId, status }) {
      // Mesma pendência do repo em memória: isto é sobre a MENSAGEM
      // (comunicacao_mensagens/comunicacao_tentativas), não sobre a conexão
      // (whatsapp_conexoes) — fora do escopo deste checkpoint.
      return { providerMessageId, status };
    },
    async registrarMensagemRecebida(_organizacaoId, payload) {
      // Checkpoint F: resolução de contato/perfil + comunicacao_conversas.
      return payload;
    },

    // ---- lease/fencing (Checkpoint C3.5) ----
    // As três operações abaixo são chamadas RPC para funções SQL (migration
    // 084) — nenhuma delas calcula "agora" nem "novo prazo" no Node; tudo
    // é `now()` do Postgres, dentro da função, na MESMA instrução atômica
    // que decide elegibilidade e grava. Ver comentário de `chamarRpc` acima
    // e o cabeçalho da migration 084 para a justificativa completa (por que
    // não dá para expressar isso num `.update()`/`.gt()` comum do PostgREST).
    async adquirirLease(organizacaoId, { gatewayProcessId, ttlMs, providerInstanceId = INSTANCIA_PADRAO } = {}, deps = {}) {
      const db = await obterCliente(deps);
      const r = await chamarRpc(db, "whatsapp_lease_acquire", {
        p_organizacao_id: organizacaoId, p_provider_instance_id: providerInstanceId,
        p_process_id: gatewayProcessId, p_ttl_ms: ttlMs,
      });
      return { acquired: !!r?.acquired, leaseEpoch: r?.lease_epoch ?? 0, expiresAt: r?.lease_expires_at ?? null };
    },

    async renovarLease(organizacaoId, { gatewayProcessId, leaseEpoch, ttlMs, providerInstanceId = INSTANCIA_PADRAO } = {}, deps = {}) {
      const db = await obterCliente(deps);
      const r = await chamarRpc(db, "whatsapp_lease_renew", {
        p_organizacao_id: organizacaoId, p_provider_instance_id: providerInstanceId,
        p_process_id: gatewayProcessId, p_epoch: leaseEpoch, p_ttl_ms: ttlMs,
      });
      if (!r?.renewed) return { renewed: false, leaseEpoch: null, expiresAt: null };
      return { renewed: true, leaseEpoch: r.lease_epoch, expiresAt: r.lease_expires_at };
    },

    async liberarLease(organizacaoId, { gatewayProcessId, leaseEpoch, providerInstanceId = INSTANCIA_PADRAO } = {}, deps = {}) {
      const db = await obterCliente(deps);
      const r = await chamarRpc(db, "whatsapp_lease_release", {
        p_organizacao_id: organizacaoId, p_provider_instance_id: providerInstanceId,
        p_process_id: gatewayProcessId, p_epoch: leaseEpoch,
      });
      return { released: !!r?.released };
    },

    // ---- só para teste/instrumentação ----
    async _obterConexao(organizacaoId, providerInstanceId = INSTANCIA_PADRAO, deps = {}) {
      const db = await obterCliente(deps);
      const { data, error } = await db.from("whatsapp_conexoes").select("*")
        .eq("organizacao_id", organizacaoId).eq("provider_instance_id", providerInstanceId).maybeSingle();
      if (error) throw ApiError.internal(error.message);
      return data;
    },
  };
}
