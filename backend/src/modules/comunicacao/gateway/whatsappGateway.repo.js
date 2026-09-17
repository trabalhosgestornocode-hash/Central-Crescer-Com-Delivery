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

/** Repositório em memória — usado por padrão em C1 (tabela real não existe ainda). */
export function criarRepoEmMemoria() {
  const porOrganizacao = new Map(); // organizacaoId -> registro

  return {
    async obterAuthState(organizacaoId) {
      return porOrganizacao.get(organizacaoId)?.authStateEncrypted ?? null;
    },
    async salvarAuthState(organizacaoId, { authStateEncrypted, authStateVersion }) {
      const atual = porOrganizacao.get(organizacaoId) ?? {};
      porOrganizacao.set(organizacaoId, { ...atual, authStateEncrypted, authStateVersion, updatedAt: new Date().toISOString() });
    },
    async registrarHeartbeat(organizacaoId, { status, telefone, gatewayVersion, providerInstanceId }) {
      const atual = porOrganizacao.get(organizacaoId) ?? {};
      porOrganizacao.set(organizacaoId, {
        ...atual, status, telefone: telefone ?? atual.telefone ?? null, gatewayVersion, providerInstanceId,
        lastSeenAt: new Date().toISOString(),
      });
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

  return {
    async obterAuthState(organizacaoId, deps = {}) {
      const db = await obterCliente(deps);
      const { data, error } = await db.from("whatsapp_conexoes")
        .select("auth_state_encrypted")
        .eq("organizacao_id", organizacaoId)
        .eq("provider_instance_id", deps.providerInstanceId ?? INSTANCIA_PADRAO)
        .maybeSingle();
      if (error) throw ApiError.internal(error.message);
      return data?.auth_state_encrypted ?? null;
    },

    async salvarAuthState(organizacaoId, { authStateEncrypted, authStateVersion, providerInstanceId = INSTANCIA_PADRAO } = {}, deps = {}) {
      const db = await obterCliente(deps);
      await obterOuCriarConexao(db, organizacaoId, providerInstanceId);
      const { error } = await db.from("whatsapp_conexoes")
        .update({ auth_state_encrypted: authStateEncrypted, auth_state_version: authStateVersion })
        .eq("organizacao_id", organizacaoId).eq("provider_instance_id", providerInstanceId);
      if (error) throw ApiError.internal(error.message);
    },

    async registrarHeartbeat(organizacaoId, { status, telefone, gatewayVersion, providerInstanceId = INSTANCIA_PADRAO, lastErrorClass } = {}, deps = {}) {
      const db = await obterCliente(deps);
      await obterOuCriarConexao(db, organizacaoId, providerInstanceId);

      const agora = new Date().toISOString();
      const patch = { last_seen_at: agora };
      if (status !== undefined) patch.status = status;
      if (telefone !== undefined && telefone !== null) patch.telefone_e164 = telefone;
      if (gatewayVersion !== undefined) patch.gateway_version = gatewayVersion;
      if (lastErrorClass !== undefined) patch.last_error_class = lastErrorClass;
      if (status === "CONNECTED") patch.connected_at = agora;
      if (status === "DISCONNECTED" || status === "LOGGED_OUT") patch.disconnected_at = agora;

      const { error } = await db.from("whatsapp_conexoes")
        .update(patch)
        .eq("organizacao_id", organizacaoId).eq("provider_instance_id", providerInstanceId);
      if (error) throw ApiError.internal(error.message);
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
