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
//
// CREDENCIAIS (app TEST distribuído do iFood)
//   A mesma allowlist faz o appType `financial` dessas unidades usar
//   IFOOD_TEST_CLIENT_ID/SECRET em TODO o ciclo OAuth: userCode (tenant), troca do
//   authorizationCode (unidade da sessão persistida) e refresh (unidade da conexão
//   persistida) — ver ifoodToken.service.js#fonteDaCredencial. Sem IFOOD_TEST_* a
//   unidade recebe IFOOD_APP_SEM_CREDENCIAL; nunca cai para o app de produção.
//   Order/Analytics/Events não mudam.
//
// ENCERRAMENTO DA HOMOLOGAÇÃO (ordem obrigatória)
//   Enquanto houver conexão Financial TEST ativa na unidade, NÃO tire a unidade da
//   allowlist: o refresh seguinte passaria a usar o app de produção e a credencial
//   cairia em reauth_required. Encerrar assim:
//     1. concluir Reconciliation On Demand em andamento;
//     2. baixar evidências/CSV;
//     3. "Desconectar" na tela iFood da unidade;
//     4. confirmar credenciais removidas e conexão revogada;
//     5. só então remover a unidade de IFOOD_FINANCIAL_HOMOLOGATION_UNITS (deploy).

import { config } from "../../config/env.js";
import { unidadeNoPilotoOrder } from "./ifoodOrderPiloto.js";

/**
 * A unidade está na allowlist IFOOD_FINANCIAL_HOMOLOGATION_UNITS? Só a lista —
 * SEM a flag global de fixture. É o que decide as CREDENCIAIS do app TEST no
 * fluxo Financial (ifoodToken.service.js#credenciaisDoApp) e é a base do header.
 * @param {string|null|undefined} unidadeId do tenant/sessão/conexão persistida (nunca do navegador)
 * @param {{ifood?: {financialHomologacaoUnidades?: string[]}}} [cfg]
 */
export function unidadeEmHomologacaoFinancial(unidadeId, cfg = config) {
  return unidadeNoPilotoOrder(cfg?.ifood?.financialHomologacaoUnidades, unidadeId);
}

/**
 * A unidade usa o ambiente de homologação (fixture) do iFood nas APIs Financial?
 * @param {string|null|undefined} unidadeId do tenant do backend
 * @param {{ifood?: {financialFixture?: boolean, financialHomologacaoUnidades?: string[]}}} [cfg]
 * @returns {boolean}
 */
export function usarHomologacaoFinancial(unidadeId, cfg = config) {
  if (cfg?.ifood?.financialFixture === true) return true; // só possível em teste local (guard de boot)
  return unidadeEmHomologacaoFinancial(unidadeId, cfg);
}

/** Quantas unidades estão em homologação — para o log de boot (nunca os ids). */
export function totalUnidadesHomologacaoFinancial(cfg = config) {
  const lista = cfg?.ifood?.financialHomologacaoUnidades;
  return Array.isArray(lista) ? lista.length : 0;
}
