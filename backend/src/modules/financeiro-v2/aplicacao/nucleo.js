// Montagem do núcleo Financeiro v2. Recebe as dependências por injeção; não lê ambiente, banco nem rede.
import { randomUUID } from "node:crypto";
import { exigirRepositorio } from "../contratos/repositorio.js";
import { criarPoliticaDeEscopo } from "../dominio/contexto.js";
import { criarBase } from "./base.js";
import { operacoesDeAbertura } from "./abertura.js";
import { operacoesDeTaxasContratadas } from "./taxasContratadas.js";
import { operacoesDeFechamentoManual } from "./fechamentoManual.js";
import { operacoesDoCanalSaipos } from "./canalSaipos.js";
import { operacoesDeMovimentosDeCaixa } from "./movimentosDeCaixa.js";
import { operacoesDeSangriasComoDespesa } from "./sangriasComoDespesa.js";
import { operacoesDoCanalPlataforma } from "./canalPlataforma.js";
import { operacoesDoCalendarioFaturamento } from "./calendarioFaturamento.js";
import { operacoesDeImportacoesPorCanal } from "./importacoesPorCanal.js";
import { operacoesDoDemonstrativoIfood } from "./demonstrativoIfood.js";
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
import { operacoesDeEntregadoresProprios } from "./entregadoresProprios.js";
import { operacoesDeExtras } from "./extrasEntregadores.js";

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
 * @param {{fonte?:object, inicioDaOperacao?:string|null, cofreDeNotas?:object|null}} [deps.entregadores] apuração do parser (porta), primeira semana automática e cofre durável das notas
 * @param {boolean} [deps.cargaCompletaDeReferencia] 07B — SOMENTE testes de equivalência: as telas otimizadas voltam a
 *        ler o histórico inteiro, para comparar o resultado com a carga dirigida
 * @param {boolean} [deps.conferirCargaDirigida] 08C — SOMENTE testes: cada consulta otimizada também calcula com a carga
 *        completa e falha (INTEGRIDADE_VIOLADA) se o resultado diferir
 */
export function criarNucleoFinanceiro({
  repositorio, escoposAutorizados, relogio = () => new Date(), gerarId = randomUUID, fuso = "America/Sao_Paulo",
  cofre = null, fontes = criarRegistroDeFontes(), estabelecimentosDaUnidade = null, acessosNegados = criarRegistroDeAcessosNegadosMemoria(),
  exigirConcessaoPersistida = false, autoridadeDeProvisionamento = null, cargaCompletaDeReferencia = false, conferirCargaDirigida = false,
  entregadores = null,
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
    ...operacoesDeEntregadoresProprios(base, { acessosNegados, ...(entregadores ?? {}) }),
    ...operacoesDeExtras(base),
    ...operacoesDeFormacao(base),
    ...operacoesDeAbertura(base),
    ...operacoesDeTaxasContratadas(base),
    ...operacoesDeFechamentoManual(base),
    ...operacoesDoCanalSaipos(base),
    ...operacoesDeMovimentosDeCaixa(base),
    ...operacoesDeSangriasComoDespesa(base),
    ...operacoesDoCanalPlataforma(base),
    ...operacoesDoCalendarioFaturamento(base),
    ...operacoesDeImportacoesPorCanal(base, { fontes }),
    ...operacoesDoDemonstrativoIfood(base),
    ...operacoesDeApuracao(base),
    ...operacoesDeTesouraria(base, { cargaCompleta: cargaCompletaDeReferencia, conferirCarga: conferirCargaDirigida }),
    ...operacoesDeVendasERecebimentos(base, { cargaCompleta: cargaCompletaDeReferencia, conferirCarga: conferirCargaDirigida }),
    ...operacoesDeConferencias(base, { fontes, cargaCompleta: cargaCompletaDeReferencia, conferirCarga: conferirCargaDirigida }),
    ...operacoesDeCompetencia(base, { repositorio, politica, cargaCompleta: cargaCompletaDeReferencia, conferirCarga: conferirCargaDirigida }),
  };
  // Toda operação é assíncrona e falha por rejeição (nunca por exceção síncrona), inclusive erros de validação.
  return Object.freeze(Object.fromEntries(Object.entries(operacoes).map(([nome, op]) => [nome, async (...args) => op(...args)])));
}
