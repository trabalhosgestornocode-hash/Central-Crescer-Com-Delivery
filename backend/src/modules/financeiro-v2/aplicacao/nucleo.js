// Montagem do núcleo Financeiro v2. Recebe as dependências por injeção; não lê ambiente, banco nem rede.
import { randomUUID } from "node:crypto";
import { exigirRepositorio } from "../contratos/repositorio.js";
import { criarPoliticaDeEscopo } from "../dominio/contexto.js";
import { criarBase } from "./base.js";
import { operacoesDeAbertura } from "./abertura.js";
import { operacoesDeCaixa } from "./caixa.js";
import { operacoesDeCompetencia } from "./competencias.js";
import { operacoesDeConciliacao } from "./conciliacao.js";
import { operacoesDeDocumentos } from "./documentos.js";
import { operacoesEconomicas } from "./economico.js";
import { operacoesDeImportacao } from "./importacoes.js";
import { operacoesDeAcesso } from "./acessos.js";
import { operacoesDeConfiguracao } from "./configuracoes.js";
import { operacoesDeCofreDocumental } from "./cofreDocumental.js";
import { operacoesDeFormacao } from "./formacao.js";
import { operacoesDeApuracao } from "./apuracao.js";
import { operacoesDeTesouraria } from "./tesouraria.js";
import { operacoesDeVendasERecebimentos } from "./vendasRecebimentos.js";
import { operacoesDeConferencias } from "./conferencias.js";
import { criarRegistroDeFontes } from "../importacao/fontes/index.js";
import { criarRegistroDeAcessosNegadosMemoria } from "../infra/cofreDisco.js";
import { operacoesDePlano } from "./plano.js";
import { operacoesDeVendas } from "./vendas.js";
import { operacoesDeReclassificacao } from "./reclassificacao.js";
import { operacoesDeEvidencias } from "./evidencias.js";
import { operacoesDeBaixaPorExtrato } from "./baixaPorExtrato.js";

/**
 * @param {object} deps
 * @param {{transacao:Function, leitura:Function}} deps.repositorio adaptador da porta em contratos/repositorio.js
 * @param {Array<{organizacaoId:string, unidadeId:string}>} deps.escoposAutorizados pares em que o núcleo pode operar (obrigatório)
 * @param {() => Date} [deps.relogio]
 * @param {() => string} [deps.gerarId]
 * @param {string} [deps.fuso] fuso da data civil da operação
 * @param {object} [deps.cofre] cofre PRIVADO de documentos (contratos/cofre.js); sem ele, importações ficam indisponíveis
 * @param {object} [deps.fontes] registro de adaptadores de fonte (padrão: todos os da Execução 02)
 * @param {(escopo:object, fonte:string) => string[]|null} [deps.estabelecimentosDaUnidade] códigos de estabelecimento de cada unidade
 * @param {{registrar:Function}} [deps.acessosNegados] onde registrar tentativas de leitura negadas (padrão: memória)
 * @param {boolean} [deps.exigirConcessaoPersistida] 06D: confere a permissão contra a concessão GRAVADA em cada operação
 * @param {{verificar:(ato:object)=>Promise<{ok:boolean, autoridadeId?:string, nivelAutenticacao?:string}>}} [deps.autoridadeDeProvisionamento]
 *        06D/07B: autoridade externa, já autenticada (aal2), que atesta o administrador inicial de uma unidade
 * @param {boolean} [deps.cargaCompletaDeReferencia] 07B — SOMENTE testes de equivalência: as telas otimizadas voltam a
 *        ler o histórico inteiro, para comparar o resultado com a carga dirigida
 * @param {boolean} [deps.conferirCargaDirigida] 08C — SOMENTE testes: cada consulta otimizada também calcula com a carga
 *        completa e falha (INTEGRIDADE_VIOLADA) se o resultado diferir
 */
export function criarNucleoFinanceiro({
  repositorio, escoposAutorizados, relogio = () => new Date(), gerarId = randomUUID, fuso = "America/Sao_Paulo",
  cofre = null, fontes = criarRegistroDeFontes(), estabelecimentosDaUnidade = null, acessosNegados = criarRegistroDeAcessosNegadosMemoria(),
  exigirConcessaoPersistida = false, autoridadeDeProvisionamento = null, cargaCompletaDeReferencia = false, conferirCargaDirigida = false,
}) {
  exigirRepositorio(repositorio);
  const politica = criarPoliticaDeEscopo(escoposAutorizados);
  const base = criarBase({ repositorio, politica, relogio, gerarId, fuso, exigirConcessaoPersistida });
  const operacoes = {
    ...operacoesDePlano(base),
    ...operacoesEconomicas(base),
    ...operacoesDeReclassificacao(base),
    ...operacoesDeVendas(base),
    ...operacoesDeCaixa(base),
    ...operacoesDeDocumentos(base),
    ...operacoesDeConciliacao(base),
    ...operacoesDeImportacao(base, { cofre, fontes, estabelecimentosDaUnidade, acessosNegados }),
    ...operacoesDeAcesso(base, { politica, autoridade: autoridadeDeProvisionamento, acessosNegados }),
    ...operacoesDeConfiguracao(base),
    ...operacoesDeCofreDocumental(base, { cofre, acessosNegados }),
    ...operacoesDeEvidencias(base, { cofre }),
    ...operacoesDeBaixaPorExtrato(base),
    ...operacoesDeFormacao(base),
    ...operacoesDeAbertura(base),
    ...operacoesDeApuracao(base),
    ...operacoesDeTesouraria(base, { cargaCompleta: cargaCompletaDeReferencia, conferirCarga: conferirCargaDirigida }),
    ...operacoesDeVendasERecebimentos(base, { cargaCompleta: cargaCompletaDeReferencia, conferirCarga: conferirCargaDirigida }),
    ...operacoesDeConferencias(base, { fontes, cargaCompleta: cargaCompletaDeReferencia, conferirCarga: conferirCargaDirigida }),
    ...operacoesDeCompetencia(base, { repositorio, politica, cargaCompleta: cargaCompletaDeReferencia, conferirCarga: conferirCargaDirigida }),
  };
  // Toda operação é assíncrona e falha por rejeição (nunca por exceção síncrona), inclusive erros de validação.
  return Object.freeze(Object.fromEntries(Object.entries(operacoes).map(([nome, op]) => [nome, async (...args) => op(...args)])));
}
