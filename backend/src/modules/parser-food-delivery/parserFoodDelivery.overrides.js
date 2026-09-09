// Override MANUAL da classificação de um cancelamento (recebe / não recebe
// taxa) — item 6 do pedido. Diferença do mecanismo antigo (colunas
// `classificacao_override_*` em parser_fd_pedidos): aqui a decisão vive numa
// tabela própria com IDENTIDADE ESTÁVEL do pedido
// (unidade + numero_pedido + hora operacional), então SOBREVIVE a um
// delete + reimportação do período (item 15 — "estratégia idempotente").
//
// O caminho de leitura (aplicarOverridesPersistidos) é chamado em TODOS os
// pontos que montam pedidos para a API: obterImportacao, analisarPeriodo,
// conciliarPreview, confirmarImportacao. Um pedido sem override não é
// tocado — o motor automático continua sendo a fonte primária.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { horaOperacional } from "./parserFoodDelivery.periodo.js";
import { resolverStatusConciliacao, STATUS_CONCILIACAO } from "./parserFoodDelivery.calc.js";
import { CLASSIFICACAO_CANCELAMENTO } from "./parserFoodDelivery.classificacao.js";

const TABELA = "parser_fd_pedido_overrides";

/** Chave estável (sem fuso) de um pedido — os 19 primeiros chars do ISO local. */
export function chaveIdentidadePedido({ numeroPedido, dataHora }) {
  const iso = horaOperacional(dataHora);
  if (!numeroPedido || !iso) return null;
  return `${numeroPedido}||${String(iso).slice(0, 19)}`;
}

/**
 * Carrega os overrides de uma unidade e devolve um Map por chave de
 * identidade — pronto para `aplicarOverridesPersistidos`.
 */
export async function carregarOverridesPorUnidade({ organizacaoId, unidadeId }) {
  const { data, error } = await supabase.from(TABELA).select("*")
    .eq("unidade_id", unidadeId).eq("organizacao_id", organizacaoId);
  if (error) throw ApiError.internal(error.message);
  const mapa = new Map();
  for (const row of data || []) {
    mapa.set(`${row.numero_pedido}||${String(row.data_hora_chave).slice(0, 19)}`, row);
  }
  return mapa;
}

/**
 * Sobrepõe a classificação/status dos pedidos (formato da API — paraApiPedido)
 * com o que estiver persistido. Puro sobre a lista + o Map; não faz I/O.
 * @param {object[]} pedidosApi
 * @param {Map<string, object>} overridesMap
 * @returns {object[]} nova lista (não muta a original)
 */
export function aplicarOverridesPersistidos(pedidosApi, overridesMap) {
  if (!overridesMap || !overridesMap.size) return pedidosApi;
  return pedidosApi.map((p) => {
    const chave = chaveIdentidadePedido({ numeroPedido: p.numeroPedido, dataHora: p.dataHora });
    const ovr = chave && overridesMap.get(chave);
    if (!ovr) return p;
    const statusConciliacao = resolverStatusConciliacao(ovr.classificacao_final);
    return {
      ...p,
      statusConciliacao,
      classificacaoEfetiva: ovr.classificacao_final,
      classificacaoOverrideUsuarioNome: ovr.usuario_nome,
      classificacaoOverrideMotivo: ovr.motivo,
      classificacaoOverrideEm: ovr.criado_em,
      classificacaoOriginal: ovr.classificacao_original ?? p.classificacaoOriginal ?? p.classificacaoCancelamento,
    };
  });
}

/**
 * Grava (upsert) o override de UM pedido por identidade estável. Usado por
 * alterarClassificacaoCancelamento no service. Devolve a linha gravada.
 */
export async function definirOverride({
  organizacaoId, unidadeId, numeroPedido, dataHora, classificacaoFinal, classificacaoOriginal, motivo, usuario,
}) {
  if (![CLASSIFICACAO_CANCELAMENTO.RECEBE_TAXA, CLASSIFICACAO_CANCELAMENTO.NAO_RECEBE_TAXA].includes(classificacaoFinal)) {
    throw ApiError.badRequest('Classificação inválida — informe "recebe_taxa" ou "nao_recebe_taxa".');
  }
  const iso = horaOperacional(dataHora);
  if (!numeroPedido || !iso) throw ApiError.badRequest("Pedido sem identidade estável (número/data) — não é possível registrar o override.");
  const dataHoraChave = String(iso).slice(0, 19);

  const { data, error } = await supabase.from(TABELA).upsert({
    organizacao_id: organizacaoId, unidade_id: unidadeId,
    numero_pedido: numeroPedido, data_hora_chave: dataHoraChave,
    classificacao_final: classificacaoFinal, classificacao_original: classificacaoOriginal ?? null,
    motivo, usuario_id: usuario?.id || null, usuario_nome: usuario?.nome || null, usuario_email: usuario?.email || null,
    atualizado_em: new Date().toISOString(),
  }, { onConflict: "unidade_id,numero_pedido,data_hora_chave" }).select("*").single();
  if (error) throw ApiError.internal(`Falha ao registrar o override: ${error.message}`);
  return data;
}

export { STATUS_CONCILIACAO };
