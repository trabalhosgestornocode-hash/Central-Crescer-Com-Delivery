// MOVA — núcleo da Edge Function `mova-rele` (Execução 11). JS puro (Web APIs): roda no Deno da Edge Function e no Node dos testes.
// Contrato IDÊNTICO ao do canal do Gateway (gateway-whatsapp/src/movaCanal.js): POST <url>/internal/mova/eventos/mova-grupo com
// X-Gateway-Timestamp / X-Gateway-Nonce / X-Gateway-Signature sobre o caminho "/internal/mova/eventos/mova-grupo".
// Esta camada só valida a FORMA (método, rota, tamanho, UTF-8, cabeçalhos) e repassa os bytes exatos ao banco, que confere
// assinatura, janela, nonce e limite ANTES de gravar (mova_rele.receber). Responde só depois da gravação confirmada.
// Logs: só códigos — nunca corpo, telefone, assinatura ou segredo.
export const ROTA = "/internal/mova/eventos/mova-grupo";
export const LIMITE_BYTES = 21 * 1024 * 1024; // mesmo limite do backend MOVA (mídia de até 15 MB em base64 + envelope)

const json = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Caminho da requisição sem o prefixo da função ("/mova-rele" ou "/functions/v1/mova-rele"). */
export function caminhoDaRota(url) {
  const p = new URL(url).pathname;
  return p.replace(/^\/(?:functions\/v1\/)?mova-rele(?=\/|$)/, "");
}

/**
 * @param {Request} req
 * @param {{receber:(a:object)=>Promise<string>, log?:(evento:string, dados?:object)=>void, limiteBytes?:number}} deps
 *   `receber` chama mova_rele.receber no banco e devolve GRAVADO|DUPLICADO|NAO_AUTORIZADO|REPLAY|LIMITE|INVALIDO.
 */
export async function tratar(req, { receber, log = () => {}, limiteBytes = LIMITE_BYTES }) {
  const u = new URL(req.url);
  if (caminhoDaRota(req.url) !== ROTA || u.search) { log("rele.rota_desconhecida"); return json(404, { error: "not_found" }); }
  if (req.method !== "POST") { log("rele.metodo_recusado"); return json(405, { error: "method_not_allowed" }); }
  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (declarado > limiteBytes) { log("rele.grande_demais"); return json(413, { error: "payload_too_large" }); }
  const ts = req.headers.get("x-gateway-timestamp"); const nonce = req.headers.get("x-gateway-nonce"); const assinatura = req.headers.get("x-gateway-signature");
  if (!ts || !nonce || !assinatura || !/^\d{10,13}$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(assinatura)) {
    log("rele.nao_autorizado", { motivo: "CABECALHO" }); return json(401, { error: "unauthorized" });
  }
  // Lê com teto (não confia só no content-length).
  const leitor = req.body?.getReader(); const partes = []; let total = 0;
  if (leitor) {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.byteLength;
      if (total > limiteBytes) { await leitor.cancel().catch(() => {}); log("rele.grande_demais"); return json(413, { error: "payload_too_large" }); }
      partes.push(value);
    }
  }
  const bytes = new Uint8Array(total); let o = 0; for (const p of partes) { bytes.set(p, o); o += p.byteLength; }
  let corpo;
  try { corpo = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { log("rele.invalido", { motivo: "UTF8" }); return json(400, { error: "invalid_body" }); }
  if (!corpo) { log("rele.invalido", { motivo: "VAZIO" }); return json(400, { error: "invalid_body" }); }
  let r;
  try { r = await receber({ corpo, ts, nonce, assinatura, caminho: ROTA, origem: "gateway-whatsapp" }); }
  catch { log("rele.banco_indisponivel"); return json(503, { error: "unavailable" }); } // o Gateway tenta de novo (5xx)
  log("rele.resultado", { resultado: r, bytes: total });
  switch (r) {
    case "GRAVADO": return json(202, { status: "ENFILEIRADO" });
    case "DUPLICADO": return json(200, { status: "DUPLICADO" });
    case "LIMITE": return json(429, { error: "rate_limited" });
    case "INVALIDO": return json(400, { error: "invalid_body" });
    default: return json(401, { error: "unauthorized" }); // NAO_AUTORIZADO | REPLAY — resposta genérica
  }
}
