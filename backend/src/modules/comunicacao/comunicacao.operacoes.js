import { randomUUID } from "node:crypto";
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

export async function transicaoEfeito({ organizacaoId, operacaoId, token, acao, fase }, deps = {}) {
  const { data, error } = await (deps.supabase ?? supabase).rpc("whatsapp_operacao_efeito", {
    p_organizacao_id: organizacaoId, p_provider_instance_id: "default", p_operacao_id: operacaoId,
    p_token: token, p_acao: acao, p_fase: fase,
  });
  if (error) throw ApiError.internal(error.message);
  return data === true;
}

export async function executarEfeito(svc, operacaoId, acao, deps = {}) {
  const organizacaoId = deps.organizacaoConexaoId ?? (deps.env ?? process.env).WHATSAPP_GATEWAY_ORGANIZACAO_ID;
  const contexto = { organizacaoId, operacaoId, token: randomUUID(), acao };
  if (!await transicaoEfeito({ ...contexto, fase: "PREPARAR" }, deps))
    throw new ApiError(409, "Operação inválida, expirada ou aguardando reconciliação.", { codigo: "OPERACAO_INVALIDA" });
  try {
    return await svc.conexaoExecutarOperacao({ operacaoId, token: contexto.token, acao });
  } catch (error) {
    // Somente PENDENTE pode ser revogada. EXECUTANDO permanece bloqueada até ACK/reconciliação.
    await transicaoEfeito({ ...contexto, fase: "ABORTAR" }, deps).catch(() => false);
    throw error;
  }
}
