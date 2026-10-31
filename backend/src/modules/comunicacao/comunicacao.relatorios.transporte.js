// TRANSPORTE dos relatórios operacionais: a ÚNICA ponte entre a Central (relatórios diário/semanal) e o gateway Baileys existente. Fica em comunicacao/ (como a
// ponte do OTP) para que os módulos da Central nunca importem gateway/provider diretamente. Usa whatsapp.service#enviarTexto (kill switch do modo global +
// conta confirmada); não importa fila, política nem cotas do D-1.
import { criarWhatsAppService } from "./whatsapp.service.js";
import { criarBaileysGatewayProvider } from "./providers/baileysGateway.provider.js";
import { criarGateIdentidade } from "./comunicacao.identidade.js";
import { modoAtual as lerModoAtual } from "./comunicacao.config.js";

/** Lista PRÓPRIA dos relatórios (E.164, vírgula). Obrigatória por padrão (fail-closed); NOTIFICACOES_RELATORIOS_EXIGE_ALLOWLIST=false só por decisão de disponibilidade geral. */
export function listaAutorizada(env = process.env) {
  const bruto = String(env?.NOTIFICACOES_RELATORIOS_ALLOWLIST_E164 ?? "").trim();
  return bruto ? new Set(bruto.split(",").map((x) => x.trim()).filter((x) => /^\+[1-9]\d{7,14}$/.test(x))) : null;
}
export const exigeAllowlist = (env = process.env) => String(env?.NOTIFICACOES_RELATORIOS_EXIGE_ALLOWLIST ?? "true").trim().toLowerCase() !== "false";

let servicoDoProcesso = null;
/** Mesmo gateway Baileys do worker (WHATSAPP_GATEWAY_URL + WHATSAPP_GATEWAY_SECRET): kill switch do modo global + conta confirmada. null se ausente — fail-closed. */
export function servicoDoAmbiente(env = process.env) {
  const gatewayUrl = String(env?.WHATSAPP_GATEWAY_URL ?? "").trim(); const segredoHmac = String(env?.WHATSAPP_GATEWAY_SECRET ?? "");
  if (!gatewayUrl || !segredoHmac.trim()) return null;
  servicoDoProcesso ??= criarWhatsAppService({ provider: criarBaileysGatewayProvider({ gatewayUrl, segredoHmac, env }), identidadeConfirmada: criarGateIdentidade({ env }), modoAtual: () => lerModoAtual() });
  return servicoDoProcesso;
}
