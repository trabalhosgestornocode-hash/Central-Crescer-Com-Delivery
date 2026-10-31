// Transporte da Central de Notificações — SÓ simulação nesta versão.
//
// Nenhum import do gateway, do Baileys, de whatsapp.service ou de comunicacao/ providers (teste arquitetural): o OTP e as
// categorias novas NUNCA passam pelo transporte não oficial. A integração oficial (WhatsApp Business Platform, template de
// autenticação) entra aqui na Etapa 6 com `capacidades().otp = true`.
//
// Modos (NOTIFICACOES_OTP_TRANSPORTE):
//   * "desligado" (padrão, inclusive produção): nenhum código sai — a verificação fica indisponível; nada é verificado.
//   * "oficial": WhatsApp Cloud API da Meta (notificacoes.whatsappOficial.js), modelo de AUTENTICAÇÃO. Só com NOTIFICACOES_OTP_TRANSPORTE=oficial
//     E NOTIFICACOES_OTP_OFICIAL_AUTORIZADO=true E credenciais completas. Separado do Baileys. Desligado em produção até a autorização.
//   * "simulacao": só com NOTIFICACOES_AMBIENTE_ISOLADO=true e NODE_ENV explícito development/test. O código vai para a CAIXA DE
//     SIMULAÇÃO em memória, legível apenas por gancho de teste (nunca por log nem pela API). Tudo o que deriva dele é marcado
//     `simulado` no banco e nunca é considerado verificado para envio real.
import { decifrarTelefone } from "./notificacoes.segredos.js";
import { ambienteDeDesenvolvimento } from "../../shared/urlPublica.js";
import { logNotificacoes } from "./notificacoes.basico.js";
import { configuracaoOficial, enviarCodigoOficial } from "./notificacoes.whatsappOficial.js";

const caixa = [];   // [{ desafioId, telefoneHmac, codigo, em }] — só simulação; nunca exposta pela API

export function modoTransporte(env = process.env) {
  const pedido = String(env.NOTIFICACOES_OTP_TRANSPORTE ?? "desligado").trim().toLowerCase();
  if (pedido === "oficial") {
    return env.NOTIFICACOES_OTP_OFICIAL_AUTORIZADO === "true" && configuracaoOficial(env) ? "oficial" : "desligado";   // duas chaves + credenciais
  }
  if (pedido !== "simulacao") return "desligado";
  // fail-closed: NODE_ENV ausente ≠ desenvolvimento (só development/test explícitos + ambiente isolado liberam a simulação)
  if (!ambienteDeDesenvolvimento(env) || env.NOTIFICACOES_AMBIENTE_ISOLADO !== "true") return "desligado";
  return "simulacao";
}

export function capacidades(env = process.env) {
  const modo = modoTransporte(env);
  return { modo, otp: modo !== "desligado", simulado: modo === "simulacao", envioReal: modo === "oficial" };
}

/**
 * Entrega o código ao titular. Devolve { entregue, simulado }. Nunca loga o código nem o número.
 * @param {{desafioId: string, telefoneCifrado: string, telefoneHmac: string, codigo: string}} p
 */
export async function entregarCodigoOtp(p, { env = process.env } = {}) {
  const modo = modoTransporte(env);
  if (modo === "oficial") {
    const r = await enviarCodigoOficial({ desafioId: p.desafioId, para: decifrarTelefone(p.telefoneCifrado), codigo: p.codigo }, { env });
    logNotificacoes(r.entregue ? "info" : "warn", r.entregue ? "otp.oficial_enviado" : "otp.oficial_falhou", { desafio: p.desafioId, motivo: r.motivo ?? null });
    return { entregue: r.entregue, simulado: false, motivo: r.motivo ?? null };
  }
  if (modo !== "simulacao") return { entregue: false, simulado: false, motivo: "TRANSPORTE_DESLIGADO" };
  decifrarTelefone(p.telefoneCifrado);   // prova que o número decifra (o envio real precisará dele); o valor é descartado
  caixa.push({ desafioId: p.desafioId, telefoneHmac: p.telefoneHmac, codigo: p.codigo, em: Date.now() });
  if (caixa.length > 200) caixa.splice(0, caixa.length - 200);
  logNotificacoes("info", "otp.simulado_entregue", { desafio: p.desafioId });
  return { entregue: true, simulado: true };
}

/** Só testes (e harness de navegador isolado): último código simulado de um número/desafio. */
export function _ultimoCodigoSimulado({ desafioId, telefoneHmac } = {}) {
  for (let i = caixa.length - 1; i >= 0; i--) {
    const x = caixa[i];
    if ((desafioId && x.desafioId === desafioId) || (telefoneHmac && x.telefoneHmac === telefoneHmac)) return x.codigo;
  }
  return null;
}
export function _limparCaixaSimulada() { caixa.length = 0; }
