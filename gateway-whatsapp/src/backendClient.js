// Cliente HTTP para o backend Crescer — a via Gateway -> Backend.
//
// Espelha a forma de backend/src/modules/martinbrower/martinbrower.remote.
// worker.js#chamar: corpo serializado UMA vez (é isso que é assinado e
// enviado), timeout com AbortController, e um log que nunca inclui headers
// (a assinatura) nem o corpo (aqui, potencialmente auth state).
//
// Este módulo NUNCA importa Supabase nem vê a service_role — só fala HTTP
// autenticado por HMAC com o backend. Ver test/seguranca-sem-supabase.test.js.

import { assinarRequisicao } from "./hmac.js";
import { log, prefixoAssinatura } from "./logsafe.js";
import { erro, CODIGOS } from "./errors.js";

/**
 * @param {{backendUrl: string, segredoHmac: string, timeoutMs: number}} deps
 */
export function criarBackendClient({ backendUrl, segredoHmac, timeoutMs }) {
  async function chamar(metodo, caminho, corpoObj) {
    if (!backendUrl || !segredoHmac) throw erro(CODIGOS.INDISPONIVEL, "backendUrl/segredoHmac ausente");

    const corpo = corpoObj === undefined ? "" : JSON.stringify(corpoObj);
    const headers = assinarRequisicao({ segredo: segredoHmac, metodo, caminho, corpo });
    if (corpo) headers["Content-Type"] = "application/json";

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const resp = await fetch(`${backendUrl}${caminho}`, {
        method: metodo, headers, body: corpo || undefined, signal: ctrl.signal,
      });
      const duracaoMs = Date.now() - t0;
      const texto = await resp.text();
      let json;
      try { json = texto ? JSON.parse(texto) : {}; } catch { json = {}; }

      log(resp.ok ? "info" : "warn", "backend.chamada", {
        metodo, caminho: caminho.split("?")[0], status: resp.status, duracaoMs,
      });

      if (!resp.ok) {
        // 401/403 aqui são o backend recusando a NOSSA assinatura — nunca
        // logamos a assinatura inteira, só o prefixo para correlacionar.
        if (resp.status === 401 || resp.status === 403) {
          log("error", "backend.autenticacao_recusada", {
            status: resp.status, assinatura: prefixoAssinatura(headers["X-Gateway-Signature"]),
          });
        }
        throw erro(CODIGOS.INDISPONIVEL, { status: resp.status, corpo: json });
      }
      return json;
    } catch (e) {
      if (e?.codigo) throw e;
      if (e?.name === "AbortError") {
        log("error", "backend.timeout", { caminho: caminho.split("?")[0], timeoutMs });
        throw erro(CODIGOS.INDISPONIVEL, "timeout ao chamar o backend");
      }
      log("error", "backend.inalcancavel", { caminho: caminho.split("?")[0], erro: e?.message });
      throw erro(CODIGOS.INDISPONIVEL, e?.message);
    } finally {
      clearTimeout(timer);
    }
  }

  const R = "/internal/comunicacao";

  return {
    /** Mensagem recebida do WhatsApp (Baileys `messages.upsert`, fromMe=false). */
    async notificarMensagemRecebida(payload) {
      return chamar("POST", `${R}/eventos/mensagem-recebida`, payload);
    },
    /** Transição de status de uma mensagem já enviada (SENT/DELIVERED/READ/FAILED). */
    async notificarStatusProvider(payload) {
      return chamar("POST", `${R}/eventos/status-provider`, payload);
    },
    /** Heartbeat periódico — ver src/baileysSession.js. */
    async notificarHeartbeat(payload) {
      return chamar("POST", `${R}/eventos/heartbeat`, payload);
    },
    /** Auth state cifrado (creds.update do Baileys) — grava no backend. */
    async salvarAuthState(payload) {
      return chamar("POST", `${R}/eventos/auth-state`, payload);
    },
    /** Bootstrap/reconexão: recupera o auth state cifrado salvo. */
    async carregarAuthState() {
      return chamar("GET", `${R}/auth-state`);
    },
  };
}
