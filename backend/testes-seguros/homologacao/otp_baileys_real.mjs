// TESTE REAL de baixo volume do OTP pelo Baileys — NÃO é executado automaticamente. Envia NO MÁXIMO 1 código a UM número que o
// responsável autorizou expressamente (nunca um cliente). Usa o MESMO caminho do produto (enviarOtpBaileys → whatsapp.service → gateway),
// com reservas EM MEMÓRIA (não toca no banco). Nada é gravado; o número só aparece mascarado; o código não é impresso (chega só no WhatsApp).
//
//   OTP_REAL_AUTORIZO=SIM OTP_REAL_TELEFONE_E164=+55119XXXXXXXX \
//   WHATSAPP_GATEWAY_URL=... WHATSAPP_GATEWAY_SECRET=... COMUNICACAO_IDENTIDADE_* (as mesmas do worker) node backend/testes-seguros/homologacao/otp_baileys_real.mjs
// Pré-requisitos: gateway conectado, conta confirmada na aba Conexão, modo operacional diferente de DISABLED, ninguém do D-1 sendo enviado.
import { randomUUID, randomInt } from "node:crypto";

const tel = String(process.env.OTP_REAL_TELEFONE_E164 ?? "");
if (process.env.OTP_REAL_AUTORIZO !== "SIM") { console.error("PARADO: defina OTP_REAL_AUTORIZO=SIM (autorização expressa para UM envio real)."); process.exit(2); }
if (!/^\+[1-9]\d{7,14}$/.test(tel)) { console.error("PARADO: OTP_REAL_TELEFONE_E164 deve ser UM número em E.164 (+55...)."); process.exit(2); }
if (tel.includes(",")) { console.error("PARADO: só um número."); process.exit(2); }
const mascarado = `${tel.slice(0, 5)}${"*".repeat(Math.max(0, tel.length - 7))}${tel.slice(-2)}`;

const { enviarOtpBaileys } = await import("../../src/modules/comunicacao/comunicacao.otp.js");
const reservas = new Map();
const repo = {
  reservarEnvioOtp: async ({ desafioId }) => { if (reservas.has(desafioId)) return "JA_RESERVADO"; reservas.set(desafioId, "ENVIANDO"); return "RESERVADO"; },
  registrarResultadoOtp: async ({ desafioId, status }) => { reservas.set(desafioId, status); return true; },
};
const codigo = String(randomInt(0, 1_000_000)).padStart(6, "0");
const env = { ...process.env, NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164: tel };
console.log(`Enviando 1 código de TESTE para ${mascarado} …`);
const r = await enviarOtpBaileys({ desafioId: randomUUID(), telefoneE164: tel, codigo }, { env, repo, log: (e, d) => console.warn(e, JSON.stringify(d)) });
console.log(JSON.stringify({ entregue: r.entregue, incerta: r.incerta === true, motivo: r.motivo }));
console.log(r.entregue ? "Confira no aparelho do número autorizado e confirme ao responsável. NENHUM outro envio foi feito." : "Nada foi enviado. Motivo acima (vocabulário fixo).");
process.exit(r.entregue ? 0 : 1);
