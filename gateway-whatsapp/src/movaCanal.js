// MOVA — CANAL ISOLADO entre o Gateway e o backend MOVA de HOMOLOGAÇÃO (Execução 05).
//
// Por quê: o Gateway de produção pode ser o transporte do WhatsApp, mas o processamento financeiro de homologação fica num
// backend SEPARADO. Este canal tem URL e segredo HMAC PRÓPRIOS (nunca o WHATSAPP_GATEWAY_SECRET do backend de produção):
//   WHATSAPP_MOVA_BACKEND_URL     endereço do backend MOVA de homologação (https fora de localhost)
//   WHATSAPP_MOVA_BACKEND_SECRET  segredo HMAC só do MOVA (≥ 32 caracteres; diferente do segredo principal)
// Sem os dois (ou com o mesmo segredo do principal), o MOVA NÃO liga no Gateway (fail-closed) — nada de MOVA vai ao backend
// de produção. O canal é best-effort e DESACOPLADO: falha aqui nunca afeta o fluxo principal nem as mensagens automáticas.
// Nova tentativa limitada (rede/5xx) e limite de taxa (eventos por minuto; excesso descartado com log de código).
import { assinarRequisicao } from "./hmac.js";

export const CAMINHO_EVENTO_MOVA = "/internal/mova/eventos/mova-grupo";
/** 28/11: resposta do MOVA sem entrega a nenhum aparelho (o backend reenvia uma cópia, uma vez). */
export const CAMINHO_SEM_ENTREGA_MOVA = "/internal/mova/eventos/mova-sem-entrega";

/** Valida a configuração do canal. Devolve { ativo:false, motivo } ou { ativo:true, url, segredo }. Nunca devolve o segredo em log. */
export function lerCanalMova({ url, segredo, segredoPrincipal }) {
  const u = String(url ?? "").trim(); const s = String(segredo ?? "");
  if (!u && !s) return { ativo: false, motivo: "SEM_CANAL" };
  if (!u || !s) return { ativo: false, motivo: "CANAL_INCOMPLETO" };
  if (s.length < 32) return { ativo: false, motivo: "SEGREDO_CURTO" };
  if (s === segredoPrincipal) return { ativo: false, motivo: "SEGREDO_IGUAL_AO_PRINCIPAL" };
  let parsed; try { parsed = new URL(u); } catch { return { ativo: false, motivo: "URL_INVALIDA" }; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) return { ativo: false, motivo: "URL_SEM_HTTPS" };
  return { ativo: true, url: u.replace(/\/$/, ""), segredo: s };
}

/**
 * @param {{url:string, segredo:string, fetchFn?:typeof fetch, timeoutMs?:number, tentativas?:number, esperaMs?:number[],
 *          maxPorMinuto?:number, relogio?:() => number, esperar?:(ms:number)=>Promise<void>, log?:Function}} deps
 */
export function criarCanalMova({ url, segredo, fetchFn = (...a) => fetch(...a), timeoutMs = 15_000, tentativas = 3, esperaMs = [1000, 3000],
  maxPorMinuto = 30, relogio = () => Date.now(), esperar = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const janela = [];
  const dentroDoLimite = () => {
    const agora = relogio();
    while (janela.length && agora - janela[0] > 60_000) janela.shift();
    if (janela.length >= maxPorMinuto) return false;
    janela.push(agora); return true;
  };
  async function umaVez(corpo, caminho = CAMINHO_EVENTO_MOVA) {
    const headers = { ...assinarRequisicao({ segredo, metodo: "POST", caminho, corpo }), "Content-Type": "application/json" };
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchFn(`${url}${caminho}`, { method: "POST", headers, body: corpo, signal: ctrl.signal });
      return { status: r.status };
    } catch { return { status: 0 }; } finally { clearTimeout(timer); }
  }
  return Object.freeze({
    /** Entrega um evento ao backend MOVA de homologação. Nunca lança. */
    async notificar(payload) {
      if (!dentroDoLimite()) { log("warn", "mova.canal_limite_de_taxa", {}); return { entregue: false, motivo: "LIMITE_DE_TAXA" }; }
      const corpo = JSON.stringify(payload);
      for (let i = 0; i < tentativas; i++) {
        const { status } = await umaVez(corpo); // assinatura NOVA a cada tentativa (nonce de uso único)
        if (status >= 200 && status < 300) return { entregue: true, status };
        if (status !== 0 && status < 500 && status !== 429) { log("warn", "mova.canal_recusado", { status }); return { entregue: false, motivo: "RECUSADO", status }; }
        if (i < tentativas - 1) await esperar(esperaMs[i] ?? esperaMs.at(-1) ?? 1000);
      }
      log("warn", "mova.canal_indisponivel", {});
      return { entregue: false, motivo: "INDISPONIVEL" };
    },
    /** 28/11: avisa o backend que uma resposta do MOVA não chegou a nenhum aparelho. Só ids técnicos. Nunca lança. */
    async notificarSemEntrega({ providerMessageId, correlationId = null }) {
      if (typeof providerMessageId !== "string" || !/^[A-Za-z0-9]{6,64}$/.test(providerMessageId)) return { entregue: false, motivo: "ID_INVALIDO" };
      const corpo = JSON.stringify({ providerMessageId, correlationId: typeof correlationId === "string" ? correlationId.slice(0, 200) : null });
      for (let i = 0; i < tentativas; i++) {
        const { status } = await umaVez(corpo, CAMINHO_SEM_ENTREGA_MOVA);
        if (status >= 200 && status < 300) { log("info", "mova.sem_entrega_avisada", { providerMessageId, status }); return { entregue: true, status }; }
        if (status !== 0 && status < 500 && status !== 429) { log("warn", "mova.sem_entrega_recusada", { providerMessageId, status }); return { entregue: false, motivo: "RECUSADO", status }; }
        if (i < tentativas - 1) await esperar(esperaMs[i] ?? esperaMs.at(-1) ?? 1000);
      }
      log("warn", "mova.sem_entrega_indisponivel", { providerMessageId });
      return { entregue: false, motivo: "INDISPONIVEL" };
    },
  });
}
