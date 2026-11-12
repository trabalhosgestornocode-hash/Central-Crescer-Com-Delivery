// Montagem do núcleo Financeiro v2. Recebe as dependências por injeção; não lê ambiente, banco nem rede.
import { randomUUID } from "node:crypto";
import { exigirRepositorio } from "../contratos/repositorio.js";
import { criarPoliticaDeEscopo } from "../dominio/contexto.js";
import { criarBase } from "./base.js";
import { operacoesDeCaixa } from "./caixa.js";
import { operacoesDeCompetencia } from "./competencias.js";
import { operacoesDeConciliacao } from "./conciliacao.js";
import { operacoesDeDocumentos } from "./documentos.js";
import { operacoesEconomicas } from "./economico.js";
import { operacoesDePlano } from "./plano.js";
import { operacoesDeVendas } from "./vendas.js";

/**
 * @param {object} deps
 * @param {{transacao:Function, leitura:Function}} deps.repositorio adaptador da porta em contratos/repositorio.js
 * @param {Array<{organizacaoId:string, unidadeId:string}>} deps.escoposAutorizados pares em que o núcleo pode operar (obrigatório)
 * @param {() => Date} [deps.relogio]
 * @param {() => string} [deps.gerarId]
 * @param {string} [deps.fuso] fuso da data civil da operação
 */
export function criarNucleoFinanceiro({ repositorio, escoposAutorizados, relogio = () => new Date(), gerarId = randomUUID, fuso = "America/Sao_Paulo" }) {
  exigirRepositorio(repositorio);
  const politica = criarPoliticaDeEscopo(escoposAutorizados);
  const base = criarBase({ repositorio, politica, relogio, gerarId, fuso });
  const operacoes = {
    ...operacoesDePlano(base),
    ...operacoesEconomicas(base),
    ...operacoesDeVendas(base),
    ...operacoesDeCaixa(base),
    ...operacoesDeDocumentos(base),
    ...operacoesDeConciliacao(base),
    ...operacoesDeCompetencia(base, { repositorio, politica }),
  };
  // Toda operação é assíncrona e falha por rejeição (nunca por exceção síncrona), inclusive erros de validação.
  return Object.freeze(Object.fromEntries(Object.entries(operacoes).map(([nome, op]) => [nome, async (...args) => op(...args)])));
}
