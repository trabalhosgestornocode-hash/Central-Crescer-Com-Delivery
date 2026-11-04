// Ponte relatórios do Checklist → bloco logístico Foody (Fase D). Desligada por padrão:
//
//   FOODY_CENTRAL_RELATORIO_ENABLED=true  E  unidade em FOODY_CENTRAL_RELATORIO_UNIDADES (uuid, vírgula)
//
// Sem a flag: nada é lido e a mensagem fica byte a byte igual. Com a flag:
//   * lê SÓ fechamentos Foody da organização + unidade do relatório (cada linha conferida) — Subway nunca vê o Açaí e vice-versa;
//   * acrescenta o bloco ao texto de cada destinatário: R$ só para papel com acesso financeiro, contagens para os demais;
//   * se o texto com o bloco não passar na validação da mensagem (tamanho, dado proibido), vai a mensagem ORIGINAL — o bloco
//     nunca impede o relatório;
//   * a chave de idempotência NÃO muda (continua a do fechamento do Checklist): versão nova do fechamento Foody depois do
//     enfileiramento não gera mensagem corretiva;
//   * falha de leitura = mensagem original (fail-safe). Nunca envia: só altera o texto que já seria enfileirado.
import { linhasLogisticaDiaria, linhasLogisticaSemanal, recebeValores } from "../foody/foody.mensagem.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FLAG_RELATORIO = "FOODY_CENTRAL_RELATORIO_ENABLED";
export const FLAG_RELATORIO_UNIDADES = "FOODY_CENTRAL_RELATORIO_UNIDADES";

export function logisticaFoodyPermitida(env, unidadeId) {
  if (String(env?.[FLAG_RELATORIO] ?? "").trim().toLowerCase() !== "true") return false;
  const lista = new Set(String(env?.[FLAG_RELATORIO_UNIDADES] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)));
  return lista.has(String(unidadeId ?? "").toLowerCase());
}

async function leituraPadrao({ organizacaoId, unidadeId, de, ate }) {
  const { supabase } = await import("../../config/supabase.js");
  const { data, error } = await supabase.from("foody_fechamentos_logisticos")
    .select("organizacao_id, unidade_id, competencia, versao, status, estado_valores, indicadores")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).gte("competencia", de).lte("competencia", ate).limit(500);
  if (error) throw new Error("leitura");
  return data ?? [];
}

/** @returns {Promise<object[]|null>} null = desligado ou falha (mensagem original) */
export async function lerFechamentosFoody({ env = process.env, organizacaoId, unidadeId, de, ate, ler = leituraPadrao }) {
  if (!logisticaFoodyPermitida(env, unidadeId)) return null;
  try {
    const linhas = await ler({ organizacaoId, unidadeId, de, ate });
    if ((linhas ?? []).some((r) => r.organizacao_id !== organizacaoId || r.unidade_id !== unidadeId)) return null;
    return linhas;
  } catch { return null; }
}

/** Texto final de UM destinatário. `validar(texto) → {ok}`. Devolve o original quando não há bloco ou ele invalidaria a mensagem. */
export function textoComLogistica({ texto, fechamentos, tipoDestinatario, validar, competencia = null, dias = null }) {
  if (!fechamentos || !texto) return texto;
  const incluirValores = recebeValores(tipoDestinatario);
  const linhas = dias ? linhasLogisticaSemanal({ fechamentos, dias, incluirValores }) : linhasLogisticaDiaria({ fechamentos, competencia, incluirValores });
  if (!linhas?.length) return texto;
  const final = `${texto}\n\n${linhas.join("\n")}`;
  return validar(final).ok ? final : texto;
}
