// OTP da Central de Notificações pelo Baileys — a ÚNICA ponte entre a Central e o WhatsApp do gateway existente.
//
// Reaproveita a infraestrutura de envio SEM tocar na fila nem nas cotas do D-1: o envio passa por whatsapp.service#enviarTexto (kill switch do
// modo global + conta confirmada na aba Conexão, exatamente como qualquer envio) e por uma reserva própria no banco (migration 138):
// deduplicação por desafio, cota própria (hora/dia/simultâneos) e PRIORIDADE do D-1 (o OTP adia se o D-1 está sendo enviado).
// O código em claro vive só na memória desta requisição; nunca é gravado, logado nem devolvido. O gateway ignora o eco da própria
// mensagem (fromMe) e não guarda texto de envios próprios.
//
// Classificação (mesma regra do worker): provado pré-envio ⇒ FALHOU; qualquer dúvida (timeout, 5xx, conexão cortada) ⇒ INCERTO e
// NUNCA reenvio automático (o titular pede outro código após 60 s; o banco limita). Não importa nada de fila, política ou worker do D-1.
import { reservarEnvioOtp, registrarResultadoOtp } from "./comunicacao.otp.repo.js";
import { criarWhatsAppService } from "./whatsapp.service.js";
import { criarBaileysGatewayProvider } from "./providers/baileysGateway.provider.js";
import { criarGateIdentidade } from "./comunicacao.identidade.js";
import { modoAtual as lerModoAtual } from "./comunicacao.config.js";

const PADRAO = { hora: 30, dia: 150, simultaneos: 3, timeoutMs: 20_000 };
const inteiro = (v, padrao, min, max) => { const n = Number.parseInt(String(v ?? ""), 10); return Number.isInteger(n) && n >= min && n <= max ? n : padrao; };

export function limitesDoAmbiente(env = process.env) {
  return {
    maxHora: inteiro(env.NOTIFICACOES_OTP_MAX_HORA, PADRAO.hora, 1, 1000),
    maxDia: inteiro(env.NOTIFICACOES_OTP_MAX_DIA, PADRAO.dia, 1, 10000),
    maxSimultaneos: inteiro(env.NOTIFICACOES_OTP_MAX_SIMULTANEOS, PADRAO.simultaneos, 1, 20),
  };
}

/** Lista de números autorizados para a HOMOLOGAÇÃO REAL (E.164, separados por vírgula). Definida ⇒ qualquer outro número é recusado antes de tudo. */
export function listaAutorizada(env = process.env) {
  const bruto = String(env.NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164 ?? "").trim();
  if (!bruto) return null;
  return new Set(bruto.split(",").map((s) => s.trim()).filter((s) => /^\+[1-9]\d{7,14}$/.test(s)));
}

let servicoDoProcesso = null;
/** Serviço de WhatsApp do ambiente (mesma config do worker: WHATSAPP_GATEWAY_URL + WHATSAPP_GATEWAY_SECRET). null se ausente — fail-closed. */
export function servicoDoAmbiente(env = process.env) {
  const gatewayUrl = String(env.WHATSAPP_GATEWAY_URL ?? "").trim();
  const segredoHmac = String(env.WHATSAPP_GATEWAY_SECRET ?? "");
  if (!gatewayUrl || !segredoHmac.trim()) return null;
  servicoDoProcesso ??= criarWhatsAppService({ provider: criarBaileysGatewayProvider({ gatewayUrl, segredoHmac, env }), identidadeConfirmada: criarGateIdentidade({ env }), modoAtual: () => lerModoAtual() });
  return servicoDoProcesso;
}

export const textoOtp = (codigo) => `Crescer com Delivery: seu código de verificação é ${codigo}. Vale por 5 minutos. Não compartilhe com ninguém.`;

const comTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(Object.assign(new Error("timeout"), { _timeout: true })), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

/** Erro do serviço/provider → { status, motivo, incerta }. Na dúvida: INCERTO. */
export function classificarFalha(e) {
  if (e?.name === "ModoDesabilitadoError") return { status: "FALHOU", motivo: "MODO_DESABILITADO", incerta: false };
  if (e?.name === "IdentidadeNaoConfirmadaError") return { status: "FALHOU", motivo: "CONEXAO_NAO_CONFIRMADA", incerta: false };
  if (e?.permanente) return { status: "FALHOU", motivo: /NOT_ON_WHATSAPP/i.test(String(e.message)) ? "NUMERO_SEM_WHATSAPP" : "ENVIO_RECUSADO", incerta: false };
  if (e?.preEnvio === true && !e?._timeout) return { status: "FALHOU", motivo: "GATEWAY_DESCONECTADO", incerta: false };
  return { status: "INCERTO", motivo: "ENTREGA_INCERTA", incerta: true };
}

/**
 * @param {{desafioId: string, telefoneE164: string, codigo: string}} p
 * @returns {Promise<{entregue: boolean, incerta?: boolean, motivo: string|null}>} nunca lança; nunca devolve nem loga número/código
 */
export async function enviarOtpBaileys({ desafioId, telefoneE164, codigo }, { env = process.env, repo = { reservarEnvioOtp, registrarResultadoOtp }, obterServico = () => servicoDoAmbiente(env), log = () => {}, timeoutMs = PADRAO.timeoutMs } = {}) {
  if (!/^\d{6}$/.test(String(codigo)) || !/^\+[1-9]\d{7,14}$/.test(String(telefoneE164))) return { entregue: false, motivo: "DADOS_INVALIDOS" };
  const autorizados = listaAutorizada(env);
  if (autorizados && !autorizados.has(telefoneE164)) return { entregue: false, motivo: "FORA_DA_LISTA_AUTORIZADA" };

  let reserva;
  try { reserva = await repo.reservarEnvioOtp({ desafioId, ...limitesDoAmbiente(env) }); }
  catch { return { entregue: false, motivo: "RESERVA_INDISPONIVEL" }; }   // sem reserva, NADA sai (fail-closed)
  if (reserva === "JA_RESERVADO") return { entregue: false, motivo: "JA_ENVIADO" };
  if (reserva === "LIMITE_ATINGIDO") return { entregue: false, motivo: "LIMITE_OTP" };
  if (reserva === "SATURADO") return { entregue: false, motivo: "SATURADO" };
  if (reserva === "ADIADO_PRIORIDADE_D1") return { entregue: false, motivo: "PRIORIDADE_D1" };
  if (reserva !== "RESERVADO") return { entregue: false, motivo: "RESERVA_INDISPONIVEL" };

  const fechar = async (status, motivo) => { try { await repo.registrarResultadoOtp({ desafioId, status, motivo }); } catch { log("otp.baileys_resultado_nao_gravado", { desafio: desafioId }); } };
  let servico;
  try { servico = await obterServico(); } catch { servico = null; }
  if (!servico) { await fechar("FALHOU", "GATEWAY_NAO_CONFIGURADO"); return { entregue: false, motivo: "GATEWAY_NAO_CONFIGURADO" }; }
  try {
    await comTimeout(servico.enviarTexto({ telefoneE164, texto: textoOtp(codigo), idempotencyKey: `otp:${desafioId}` }), timeoutMs);
    await fechar("ENVIADO", null);
    return { entregue: true, motivo: null };
  } catch (e) {
    const c = classificarFalha(e);
    await fechar(c.status, c.motivo);
    // INCERTO: a mensagem PODE ter saído — o desafio segue válido; o titular espera e, se preciso, pede outro (limites no banco).
    return c.incerta ? { entregue: true, incerta: true, motivo: c.motivo } : { entregue: false, motivo: c.motivo };
  }
}
