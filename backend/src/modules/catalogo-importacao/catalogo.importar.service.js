// Aplicação da carga de catálogo no banco — SEMPRE via fn_catalogo_importar (1 chamada = 1 transação).
//
// O cliente Supabase é INJETADO (nunca importado aqui): o teste usa um duplo, o script usa o do .env.
// Este módulo não decide ONDE escrever — quem chama informa o orgId; a função SQL recusa organização
// inexistente e filtra toda escrita por ela.

import { validarPayload } from "./catalogo.planejar.js";

export class ImportacaoRecusada extends Error {}

/**
 * @param {{rpc: Function}} db cliente Supabase (ou duplo)
 * @param {{orgId: string, fonte: string, payload: object, usuarioId?: string|null, arquivos?: object[], sobrescreverFichas?: boolean}} p
 */
export async function aplicarCatalogo(db, { orgId, fonte, payload, usuarioId = null, arquivos = [], sobrescreverFichas = false }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(orgId ?? ""))) throw new ImportacaoRecusada("orgId inválido.");
  if (!fonte) throw new ImportacaoRecusada("fonte obrigatória.");
  const erros = validarPayload(payload);
  if (erros.length) throw new ImportacaoRecusada(`Payload inválido (${erros.length}): ${erros.slice(0, 5).join("; ")}`);
  const { data, error } = await db.rpc("fn_catalogo_importar", {
    p_org: orgId, p_fonte: fonte, p_payload: payload, p_usuario: usuarioId,
    p_arquivos: arquivos, p_sobrescrever_fichas: sobrescreverFichas,
  });
  if (error) throw new ImportacaoRecusada(`Importação recusada pelo banco: ${error.message}`);
  return data;
}

/**
 * Travas de segurança para escrita via script. Retorna {ok, motivo}. Puro (testável).
 * Exige, juntas: --confirmo-escrita, --org, host de destino confirmado por variável de ambiente
 * IGUAL ao host real do SUPABASE_URL. Sem isso, o script só gera relatório (dry-run).
 */
export function avaliarTravasDeEscrita({ confirmoEscrita, orgId, supabaseUrl, hostConfirmado }) {
  if (!confirmoEscrita) return { ok: false, motivo: "falta --confirmo-escrita (modo simulação)" };
  if (!orgId) return { ok: false, motivo: "falta --org <uuid da empresa>" };
  let host;
  try { host = new URL(supabaseUrl).host; } catch { return { ok: false, motivo: "SUPABASE_URL ausente/inválida" }; }
  if (!hostConfirmado) return { ok: false, motivo: `defina CATALOGO_IMPORT_CONFIRMA_HOST=${host} para confirmar o banco de destino` };
  if (hostConfirmado !== host) return { ok: false, motivo: "CATALOGO_IMPORT_CONFIRMA_HOST não corresponde ao host do SUPABASE_URL" };
  return { ok: true, motivo: null };
}
