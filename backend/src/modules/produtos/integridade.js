// INTEGRIDADE da ficha — critério ÚNICO de confiabilidade para a interface antiga e a nova (independe de products_cmv_v2).
//
// Carrega o grafo COMPLETO (paginado) + pendências abertas da carga e roda o motor de diagnóstico. Toda homologação
// (individual, em lote, pela tela antiga ou pela nova, ou por chamada direta à API) passa por aqui no backend.

import { supabase } from "../../config/supabase.js";
import { carregarGrafo, lerTudo } from "./custo.js";
import { diagnosticarOrganizacao, elegibilidadeHomologacao, CATALOGO_PENDENCIAS, CRITICIDADE } from "./diagnostico.js";
import { pendenciasCargaAbertas, CODIGOS_CARGA_BLOQUEANTES } from "./pendenciasCarga.js";

/** Pendências de carga por produto (todas as fontes somadas), paginadas. */
export async function pendenciasCargaPorProduto(organizacaoId) {
  const r = await lerTudo((de, ate) => supabase.from("catalogo_origem").select("entidade_id, pendencias")
    .eq("organizacao_id", organizacaoId).eq("entidade", "produto").order("id").range(de, ate));
  const mapa = new Map();
  if (r.error) return mapa; // tabela da 157 ausente: sem pendências de carga (comportamento legado)
  for (const o of r.data ?? []) mapa.set(o.entidade_id, [...(mapa.get(o.entidade_id) ?? []), ...(o.pendencias ?? [])]);
  return mapa;
}

/**
 * Diagnóstico de integridade da organização (sem preços: a falta de preço NUNCA bloqueia a integridade técnica).
 * @param {string} organizacaoId @param {{grafo?: object, cargas?: Map}} [pre] reaproveita o que já foi carregado
 */
export async function diagnosticoIntegridade(organizacaoId, pre = {}) {
  const [grafo, cargas] = await Promise.all([pre.grafo ?? carregarGrafo(organizacaoId), pre.cargas ?? pendenciasCargaPorProduto(organizacaoId)]);
  const diag = diagnosticarOrganizacao(grafo, {
    pendenciasCarga: (pid) => pendenciasCargaAbertas(cargas.get(pid) ?? []).filter((x) => CODIGOS_CARGA_BLOQUEANTES.has(x.codigo)),
  });
  const porId = new Map(diag.produtos.map((p) => [p.id, p]));
  return { grafo, cargas, diag, porId };
}

/** Motivos que impedem homologar um produto (vazio = íntegro). Fichas padronizadas não passam por aqui. */
export function motivosIntegridade(item) {
  if (!item) return ["Produto não encontrado no diagnóstico desta organização."];
  return [...new Set(item.pendencias.filter((x) => x.codigo !== "sem_preco_venda").map((x) => CATALOGO_PENDENCIAS[x.codigo].problema))];
}

/**
 * Fichas JÁ homologadas que hoje não passariam na integridade. Só relata (nunca revoga homologação histórica).
 * @param {{diag: object}} d de diagnosticoIntegridade()
 */
export function homologadasComInconsistencia(d) {
  return d.diag.produtos
    .filter((p) => p.homologacao === "homologada" && p.pendencias.some((x) => x.codigo !== "sem_preco_venda"))
    .map((p) => ({
      id: p.id, nome: p.nome, tipo: p.tipo,
      criticidade: p.pendencias.reduce((m, x) => (CRITICIDADE[CATALOGO_PENDENCIAS[x.codigo].criticidade] > CRITICIDADE[m] ? CATALOGO_PENDENCIAS[x.codigo].criticidade : m), "info"),
      motivos: motivosIntegridade(p),
    }));
}

export { elegibilidadeHomologacao };
