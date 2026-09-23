// Contrato de erros do Gateway.
//
// O Gateway NUNCA devolve mensagem técnica do Baileys ao backend (stack
// trace, detalhe de protocolo do WhatsApp) — fica só no log do Gateway.
// O que atravessa a fronteira é sempre um destes códigos fechados.

export const CODIGOS = {
  NAO_CONECTADO: "WHATSAPP_GATEWAY_NOT_CONNECTED",
  JA_CONECTADO: "WHATSAPP_GATEWAY_ALREADY_CONNECTED",
  LOGGED_OUT: "WHATSAPP_GATEWAY_LOGGED_OUT",
  ENVIO_FALHOU: "WHATSAPP_GATEWAY_SEND_FAILED",
  MENSAGEM_INVALIDA: "WHATSAPP_GATEWAY_INVALID_MESSAGE",
  AUTH_STATE_INDISPONIVEL: "WHATSAPP_GATEWAY_AUTH_STATE_UNAVAILABLE",
  INDISPONIVEL: "WHATSAPP_GATEWAY_UNAVAILABLE",
  // Checkpoint C3.5 — este processo não é (ou deixou de ser) o dono da
  // lease da sessão. 423 (Locked): o recurso existe, mas está travado por
  // outro dono — nunca abre um segundo socket concorrente.
  SEM_LEASE: "WHATSAPP_GATEWAY_NOT_LEADER",
  // H.4-B.4 — pré-validação do destinatário (consulta ao próprio WhatsApp ANTES do sendMessage; src/destinatario.js).
  // Nos três, NADA foi enviado (o backend os marca como pré-envio; ver providers/baileysGateway.provider.js).
  DESTINATARIO_INEXISTENTE: "WHATSAPP_GATEWAY_RECIPIENT_NOT_ON_WHATSAPP",
  DESTINATARIO_NAO_VERIFICADO: "WHATSAPP_GATEWAY_RECIPIENT_UNVERIFIED",
  CONSULTA_DESTINATARIO_FALHOU: "WHATSAPP_GATEWAY_RECIPIENT_LOOKUP_FAILED",
};

const STATUS = {
  [CODIGOS.NAO_CONECTADO]: 409,
  [CODIGOS.JA_CONECTADO]: 409,
  [CODIGOS.LOGGED_OUT]: 410,
  [CODIGOS.ENVIO_FALHOU]: 502,
  [CODIGOS.MENSAGEM_INVALIDA]: 400,
  [CODIGOS.AUTH_STATE_INDISPONIVEL]: 503,
  [CODIGOS.INDISPONIVEL]: 503,
  [CODIGOS.SEM_LEASE]: 423,
  [CODIGOS.DESTINATARIO_INEXISTENTE]: 422,
  [CODIGOS.DESTINATARIO_NAO_VERIFICADO]: 422,
  [CODIGOS.CONSULTA_DESTINATARIO_FALHOU]: 503,
};

export class GatewayError extends Error {
  constructor(codigo, detalheInterno) {
    super(codigo);
    this.name = "GatewayError";
    this.codigo = codigo;
    this.status = STATUS[codigo] ?? 500;
    // Fica SÓ no log do Gateway; nunca entra na resposta HTTP.
    this.detalheInterno = detalheInterno;
  }
}

export const erro = (codigo, detalheInterno) => new GatewayError(codigo, detalheInterno);
