// WhatsApp Cloud API OFICIAL (Meta) — só para o OTP da Central. Totalmente separado do gateway/Baileys: nenhum import deles.
//
// DESLIGADO por padrão. O modo "oficial" só existe se TODAS estas condições valerem (ver notificacoes.envio.js#modoTransporte):
//   NOTIFICACOES_OTP_TRANSPORTE=oficial  E  NOTIFICACOES_OTP_OFICIAL_AUTORIZADO=true  E  credenciais completas (abaixo)  E  não é simulação.
// Credenciais (somente variáveis de ambiente; nunca em código, banco ou log):
//   WHATSAPP_CLOUD_PHONE_NUMBER_ID, WHATSAPP_CLOUD_TOKEN (token de acesso do usuário do sistema), WHATSAPP_CLOUD_TEMPLATE_OTP
//   (nome do modelo de AUTENTICAÇÃO aprovado), WHATSAPP_CLOUD_TEMPLATE_LANG (padrão pt_BR), WHATSAPP_CLOUD_API_VERSION (padrão v21.0),
//   WHATSAPP_CLOUD_APP_SECRET (assinatura dos webhooks), WHATSAPP_CLOUD_VERIFY_TOKEN (handshake do webhook).
//
// Garantias: o número e o código nunca são logados; sem repetição automática em 4xx (evita código duplicado); timeout curto; a chave
// de idempotência é o id do desafio (o mesmo desafio nunca gera duas mensagens neste processo); erros do provedor viram códigos fixos.
import crypto from "node:crypto";

const PADRAO = { lang: "pt_BR", versao: "v21.0", timeoutMs: 8000 };
const OBRIGATORIAS = ["WHATSAPP_CLOUD_PHONE_NUMBER_ID", "WHATSAPP_CLOUD_TOKEN", "WHATSAPP_CLOUD_TEMPLATE_OTP"];

/** Configuração completa (ou null). Nunca devolve o token em claro para fora deste módulo além do necessário para a chamada. */
export function configuracaoOficial(env = process.env) {
  if (OBRIGATORIAS.some((k) => !String(env[k] ?? "").trim())) return null;
  const versao = String(env.WHATSAPP_CLOUD_API_VERSION ?? PADRAO.versao).trim();
  if (!/^v\d{1,2}\.\d$/.test(versao)) return null;
  return {
    phoneNumberId: String(env.WHATSAPP_CLOUD_PHONE_NUMBER_ID).trim(), token: String(env.WHATSAPP_CLOUD_TOKEN).trim(),
    template: String(env.WHATSAPP_CLOUD_TEMPLATE_OTP).trim(), lang: String(env.WHATSAPP_CLOUD_TEMPLATE_LANG ?? PADRAO.lang).trim(), versao,
  };
}

/** Quais credenciais faltam (só nomes) — para o pré-voo de ativação. */
export const credenciaisFaltando = (env = process.env) => OBRIGATORIAS.filter((k) => !String(env[k] ?? "").trim());

/** Corpo do modelo de AUTENTICAÇÃO: o código no corpo e no botão (copiar código / toque único). */
export function montarMensagemAutenticacao({ para, codigo, template, lang }) {
  if (!/^\d{6}$/.test(String(codigo))) throw new TypeError("codigo OTP deve ter 6 dígitos");
  if (!/^\+?[1-9]\d{7,14}$/.test(String(para))) throw new TypeError("telefone inválido");
  return {
    messaging_product: "whatsapp", to: String(para).replace(/^\+/, ""), type: "template",
    template: { name: template, language: { code: lang }, components: [
      { type: "body", parameters: [{ type: "text", text: String(codigo) }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: String(codigo) }] },
    ] },
  };
}

const enviados = new Map();   // desafioId → { em } — idempotência em memória (a duplicidade REAL é barrada pelo banco: 1 desafio = 1 código)

/**
 * Envia o código pelo modelo de autenticação. Devolve { entregue, provedorId?, motivo? }. Nunca lança por falha de rede/provedor.
 * @param {{ desafioId: string, para: string, codigo: string }} p
 */
export async function enviarCodigoOficial(p, { env = process.env, fetchImpl = globalThis.fetch, agora = Date.now } = {}) {
  const cfg = configuracaoOficial(env);
  if (!cfg) return { entregue: false, motivo: "CREDENCIAIS_INCOMPLETAS" };
  if (enviados.has(p.desafioId)) return { entregue: false, motivo: "JA_ENVIADO" };
  let corpo;
  try { corpo = montarMensagemAutenticacao({ para: p.para, codigo: p.codigo, template: cfg.template, lang: cfg.lang }); }
  catch { return { entregue: false, motivo: "DADOS_INVALIDOS" }; }
  enviados.set(p.desafioId, { em: agora() });
  if (enviados.size > 5000) for (const k of [...enviados.keys()].slice(0, 1000)) enviados.delete(k);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PADRAO.timeoutMs);
  try {
    const r = await fetchImpl(`https://graph.facebook.com/${cfg.versao}/${cfg.phoneNumberId}/messages`, {
      method: "POST", signal: ctl.signal, headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" }, body: JSON.stringify(corpo),
    });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const id = j?.messages?.[0]?.id ?? null;
      return id ? { entregue: true, provedorId: id } : { entregue: false, motivo: "RESPOSTA_SEM_ID" };
    }
    enviados.delete(p.desafioId);   // recusa definitiva do provedor: o titular pode pedir novo código (o banco já limita)
    return { entregue: false, motivo: r.status === 401 || r.status === 403 ? "CREDENCIAL_RECUSADA" : r.status === 429 ? "LIMITE_DO_PROVEDOR" : r.status >= 500 ? "PROVEDOR_INDISPONIVEL" : "RECUSADO_PELO_PROVEDOR" };
  } catch {
    // timeout/rede: não sabemos se a mensagem saiu → NÃO repetir (evita dois códigos); o titular pede outro após 60 s.
    return { entregue: false, motivo: "SEM_RESPOSTA" };
  } finally { clearTimeout(t); }
}

export function _limparIdempotencia() { enviados.clear(); }

// ---------------------------------------------------------------------------------------------------------------------------
// Webhook (status de entrega). Assinatura X-Hub-Signature-256 = sha256 do CORPO CRU com o App Secret.
// ---------------------------------------------------------------------------------------------------------------------------
export function assinaturaValida(corpoCru, cabecalho, appSecret) {
  if (!appSecret || typeof cabecalho !== "string" || !cabecalho.startsWith("sha256=")) return false;
  const esperado = crypto.createHmac("sha256", appSecret).update(corpoCru).digest("hex");
  const recebido = cabecalho.slice(7);
  const a = Buffer.from(esperado, "utf8"); const b = Buffer.from(recebido, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Handshake do cadastro do webhook (GET). Devolve o desafio só se o token de verificação confere. */
export function handshakeWebhook(consulta, verifyToken) {
  if (!verifyToken || consulta?.["hub.mode"] !== "subscribe") return null;
  const a = Buffer.from(String(consulta["hub.verify_token"] ?? "")); const b = Buffer.from(verifyToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? String(consulta["hub.challenge"] ?? "") : null;
}

/** Extrai os status do payload (sem telefone). Cada item tem uma chave de idempotência estável: provedorId + status. */
export function extrairStatus(payload) {
  const itens = [];
  for (const e of payload?.entry ?? []) for (const c of e?.changes ?? []) for (const s of c?.value?.statuses ?? []) {
    if (!s?.id || !s?.status) continue;
    itens.push({ provedorId: String(s.id), status: String(s.status), codigoErro: s.errors?.[0]?.code ?? null, chave: `${s.id}:${s.status}` });
  }
  return itens;
}
