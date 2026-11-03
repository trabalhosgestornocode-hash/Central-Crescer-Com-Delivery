// Roteamento da CONEXÃO COMPARTILHADA (migration 145) — função PURA. Decide, para cada pedido saneado, EM QUAL tenant a linha
// é gravada e com QUAIS dados. Uma única regra para todo pedido:
//
//   operação final = última decisão de triagem do uid (se houver) ?? classificação estrita do catálogo
//   * subway (titular)                       → unidade TITULAR, dados completos, sem destino;
//   * outra operação COM destino ATIVO       → unidade/organização do DESTINO, dados completos, destino_id;
//   * outra operação SEM destino ATIVO       → unidade TITULAR, só o mínimo logístico (regra F1 da 144);
//   * triagem                                → unidade TITULAR, SEM dado comercial (valor, taxa, pagamento, cancelamento);
//                                              mantém os itens (detalhes), que são o que o administrador precisa para decidir.
// O tenant de destino vem SEMPRE da linha de foody_conexao_destinos (aprovada pelas duas organizações), nunca do pedido.
import { minimizarOutraOperacao, hashConteudoPedido } from "./foody.adapter.js";
import { OPERACAO_COMPARTILHADA, RESULTADO_TRIAGEM } from "./foody.classificacao.js";

export const ROTA = Object.freeze({ TITULAR: "titular", DESTINO: "destino", MINIMO: "minimo", TRIAGEM: "triagem" });

/** Campos comerciais retirados da linha de triagem (os itens ficam para a decisão humana). */
export const CAMPOS_COMERCIAIS_TRIAGEM = Object.freeze([
  "valor_total", "taxa_entrega", "forma_pagamento", "cancelamento_razao", "cancelamento_justificativa",
]);
/** Campos zerados quando a linha deixa de ser a ativa do uid (reclassificação / destino revogado). */
export const CAMPOS_DESATIVACAO = Object.freeze([
  "detalhes_pedido", "valor_total", "taxa_entrega", "forma_pagamento", "cancelamento_razao", "cancelamento_justificativa",
]);

const OPERACOES_DECIDIVEIS = new Set(Object.values(OPERACAO_COMPARTILHADA));

/** Índice operação → destino ATIVO. Recusa (fail-closed) dois destinos ativos para a mesma operação ou destino na titular. */
export function indexarDestinos(destinosAtivos, titular) {
  const mapa = new Map();
  for (const d of destinosAtivos ?? []) {
    if (d.estado !== "ATIVO") continue;
    if (d.operacao === OPERACAO_COMPARTILHADA.SUBWAY) throw new TypeError("roteamento: a operação da titular não tem destino.");
    if (d.unidade_id === titular.unidadeId) throw new TypeError("roteamento: destino não pode ser a unidade titular.");
    if (mapa.has(d.operacao)) throw new TypeError(`roteamento: dois destinos ativos para ${d.operacao}.`);
    mapa.set(d.operacao, d);
  }
  return mapa;
}

/**
 * @param {object} registro saída de sanearPedidoApi(..., { compartilhado: true }) — sem fonte_hash
 * @param {{ titular:{organizacaoId:string, unidadeId:string}, destinos: Map<string, object>, decisao?: {operacao_decidida:string}|null }} ctx
 * @returns {{ rota: string, tenant:{organizacaoId:string, unidadeId:string}, linha: object }}
 */
export function rotearPedido(registro, { titular, destinos, decisao = null }) {
  const linha = { ...registro, destino_id: null };
  if (decisao && OPERACOES_DECIDIVEIS.has(decisao.operacao_decidida)) {
    linha.operacao = decisao.operacao_decidida;
    linha.operacao_motivo = "Operação definida por decisão de triagem registrada (auditável).";
    linha.triagem_motivo = null;
  }
  let rota, tenant = { organizacaoId: titular.organizacaoId, unidadeId: titular.unidadeId };
  if (linha.operacao === RESULTADO_TRIAGEM) {
    rota = ROTA.TRIAGEM;
    for (const k of CAMPOS_COMERCIAIS_TRIAGEM) linha[k] = null;
    linha.triagem_motivo ??= "SEM_EVIDENCIA";
  } else {
    linha.triagem_motivo = null;
    if (linha.operacao === OPERACAO_COMPARTILHADA.SUBWAY) {
      rota = ROTA.TITULAR;
    } else if (destinos.has(linha.operacao)) {
      const d = destinos.get(linha.operacao);
      rota = ROTA.DESTINO;
      tenant = { organizacaoId: d.organizacao_id, unidadeId: d.unidade_id };
      linha.destino_id = d.id;
    } else {
      rota = ROTA.MINIMO;
      minimizarOutraOperacao(linha);
    }
  }
  linha.fonte_hash = hashConteudoPedido(linha, { compartilhado: true });
  return { rota, tenant, linha };
}

/** Chave estável de tenant. */
export const chaveTenant = (t) => `${t.organizacaoId}|${t.unidadeId}`;
