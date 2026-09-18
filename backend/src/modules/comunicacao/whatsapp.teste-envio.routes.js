// ROTA TEMPORÁRIA — Checkpoint C3.5-D, Fase 1 (envio manual controlado).
//
// Existe SÓ para permitir ao SuperAdmin disparar, manualmente, UMA mensagem
// de teste através do caminho real (whatsapp.service.js -> provider ->
// gateway-whatsapp, que é um private_service do Render só alcançável pela
// rede interna — não há hoje nenhuma outra rota que chegue lá). Não cria
// fila, não cria scheduler, não lê nenhuma tabela de negócio (pendências/
// clientes) — o número e o texto vêm exclusivamente do corpo da requisição.
//
// Continua respeitando o invariante de whatsapp.service.js ("nenhum ponto
// do sistema chama Provider.send* diretamente"): esta rota chama
// `whatsAppService.enviarTexto()`, nunca o provider.
//
// REMOÇÃO: candidata a ser removida assim que o teste de envio manual deste
// checkpoint for concluído — ver relatório do checkpoint para a decisão.
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { requireSuperadmin, exigirMfaSeExigido } from "../../middlewares/auth.js";
import { criarWhatsAppService } from "./whatsapp.service.js";
import { criarBaileysGatewayProvider } from "./providers/baileysGateway.provider.js";
import { auditar } from "../../shared/auditoria.js";
import { ApiError } from "../../shared/ApiError.js";

export const whatsappTesteEnvioRouter = Router();
whatsappTesteEnvioRouter.use(requireSuperadmin);
whatsappTesteEnvioRouter.use(exigirMfaSeExigido("superadmin"));

function mascarar(telefoneE164) {
  const s = String(telefoneE164 ?? "");
  return s.replace(/\d(?=\d{2})/g, "•");
}

whatsappTesteEnvioRouter.post("/teste-envio", async (req, res, next) => {
  try {
    const { telefoneE164, texto } = req.body ?? {};
    if (typeof telefoneE164 !== "string" || !/^\+\d{10,15}$/.test(telefoneE164)) {
      return next(ApiError.badRequest("telefoneE164 inválido — esperado E.164, ex.: +5511999998888."));
    }
    if (typeof texto !== "string" || !texto.trim() || texto.length > 500) {
      return next(ApiError.badRequest("texto ausente/vazio ou maior que 500 caracteres."));
    }

    const gatewayUrl = process.env.WHATSAPP_GATEWAY_URL;
    const segredoHmac = process.env.WHATSAPP_GATEWAY_SECRET;
    if (!gatewayUrl || !segredoHmac) {
      return next(ApiError.internal("WHATSAPP_GATEWAY_URL/WHATSAPP_GATEWAY_SECRET ausentes."));
    }

    const provider = criarBaileysGatewayProvider({ gatewayUrl, segredoHmac });
    const whatsAppService = criarWhatsAppService({ provider });
    const idempotencyKey = randomUUID();

    const resultado = await whatsAppService.enviarTexto({ telefoneE164, texto, idempotencyKey });

    await auditar({
      atorId: req.user?.id ?? null,
      atorEmail: req.user?.email ?? null,
      atorTipo: "usuario",
      acao: "comunicacao.teste_envio_manual",
      entidade: "whatsapp_mensagem_teste",
      detalhes: { telefoneMascarado: mascarar(telefoneE164), idempotencyKey },
    });

    res.json({ ok: true, resultado });
  } catch (e) {
    next(e);
  }
});
