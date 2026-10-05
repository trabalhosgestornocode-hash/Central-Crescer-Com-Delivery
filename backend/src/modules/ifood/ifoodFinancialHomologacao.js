// Homologação Financial do iFood POR UNIDADE — decisão ÚNICA do header
// `x-request-homologation: true` em TODAS as APIs Financial (Sales, Financial
// Events, Settlements, Anticipation, Reconciliation, On Demand: POST, status e
// download).
//
// POR QUE EXISTE
//   A flag global IFOOD_FINANCIAL_FIXTURE é recusada no boot em produção
//   (Render / Supabase de produção / NODE_ENV=production — ver
//   ifood.ambienteTeste.js#resolverFixtureFinanceira) e continua assim. Para
//   homologar no MESMO serviço de produção, só as unidades listadas em
//   IFOOD_FINANCIAL_HOMOLOGATION_UNITS (UUIDs) consultam o ambiente de teste do
//   iFood; todas as outras usam dado real.
//
// REGRAS
//   * falha fechada: lista ausente/vazia/inválida -> nenhuma unidade;
//   * o `unidadeId` vem SEMPRE do tenant do backend (req.tenant) — nunca de
//     body, query ou header do navegador;
//   * a flag global só pode ser `true` em ambiente seguro de teste (o guard de
//     boot garante); lá ela continua valendo para todas as unidades;
//   * a lista é lida no boot (config) — mudar exige deploy, então POST, status e
//     download de uma mesma solicitação usam o mesmo modo dentro do processo.
//   * Merchant, Order e Events operacional NÃO consultam esta função.

import { config } from "../../config/env.js";
import { unidadeNoPilotoOrder } from "./ifoodOrderPiloto.js";

/**
 * A unidade usa o ambiente de homologação (fixture) do iFood nas APIs Financial?
 * @param {string|null|undefined} unidadeId do tenant do backend
 * @param {{ifood?: {financialFixture?: boolean, financialHomologacaoUnidades?: string[]}}} [cfg]
 * @returns {boolean}
 */
export function usarHomologacaoFinancial(unidadeId, cfg = config) {
  if (cfg?.ifood?.financialFixture === true) return true; // só possível em teste local (guard de boot)
  return unidadeNoPilotoOrder(cfg?.ifood?.financialHomologacaoUnidades, unidadeId);
}

/** Quantas unidades estão em homologação — para o log de boot (nunca os ids). */
export function totalUnidadesHomologacaoFinancial(cfg = config) {
  const lista = cfg?.ifood?.financialHomologacaoUnidades;
  return Array.isArray(lista) ? lista.length : 0;
}
