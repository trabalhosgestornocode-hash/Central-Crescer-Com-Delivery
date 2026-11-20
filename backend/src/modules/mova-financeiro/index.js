// Centro Financeiro Inteligente MOVA — SUPERFÍCIE PÚBLICA (Execuções 01 e 02).
//
// NÃO está montado em nenhuma rota de produção, não lê ambiente, não conecta a WhatsApp nem IA. A rota de eventos do Gateway
// (`/internal/comunicacao/eventos/mova-grupo`) só existe quando um receptor é INJETADO no router do Gateway — nada em
// produção o injeta. Persistência: PostgreSQL (schema `mova`) ou memória. Ver docs/mova-financeiro/.
import { validarConfiguracao } from "./dominio/configuracao.js";
import { criarPortaFinanceira } from "./aplicacao/portaFinanceira.js";
import { criarMotor } from "./aplicacao/motor.js";
import { criarAprovador } from "./aplicacao/aprovacao.js";
import { criarReceptor } from "./gateway/receptor.js";
import { criarFilaMemoria } from "./gateway/fila.js";
import { criarEvidenciasMemoria } from "./gateway/evidencias.js";
import { criarArmazenamentoMemoria } from "./infra/memoria.js";
import { criarArmazenamentoPostgres, criarConsultasPostgres, criarEvidenciasPostgres, criarFilaPostgres } from "./infra/postgres.js";

export { CONTRATO_EVENTO_VERSAO, validarEvento, chaveDoDocumento } from "./contratos/evento.js";
export { CONTRATO_MOVA_VERSAO, normalizarGatewayMova } from "./adaptadores/gatewayBaileys.js";
export { normalizarBaileys } from "./adaptadores/baileys.js";
export { validarConfiguracao, requisitosCompletos, SITUACAO_FONTES } from "./dominio/configuracao.js";
export { RESULTADO_UNIDADE, resolverUnidade } from "./dominio/unidade.js";
export { fontesOficiais, receitaPodeVirDe } from "./dominio/fontesDeReceita.js";
export { mascararDadosSensiveis, pedidoRestrito } from "./dominio/privacidade.js";
export { CONSULTAS, FERRAMENTAS, INTENCAO, TIPO_DOCUMENTO, criarExtratorSimulado, montarEntradaDoModelo, sinaisDeInjecao, validarSaidaDaIa } from "./ia/contratos.js";
export { OPERACOES_PERMITIDAS, criarPortaFinanceira, exigirContratoFinanceiro } from "./aplicacao/portaFinanceira.js";
export { DECISAO, TIPO_PROPOSTA, criarMotor } from "./aplicacao/motor.js";
export { ErroDeAprovacao, criarAprovador } from "./aplicacao/aprovacao.js";
export { criarFerramentas, periodoDaConsulta } from "./aplicacao/ferramentas.js";
export { ErroDeIa, MODELO_PADRAO, criarExtratorAnthropic, ehFalhaTransitoriaDeIa } from "./ia/provedorAnthropic.js";
export { criarEnviadorDeRespostas, criarWorker } from "./gateway/worker.js";
export { CAMPOS_AUSENTES, esquemaDaSaida } from "./ia/contratos.js";
export { ESTADO_ITEM, ErroTransitorio, criarFilaMemoria } from "./gateway/fila.js";
export { criarEvidenciasMemoria } from "./gateway/evidencias.js";
export { criarReceptor } from "./gateway/receptor.js";
export { criarArmazenamentoMemoria } from "./infra/memoria.js";
export { carregarConfiguracao, criarArmazenamentoPostgres, criarConsultasPostgres, criarEvidenciasPostgres, criarFilaPostgres, ehFalhaDeConexao, instalarConfiguracao } from "./infra/postgres.js";

/**
 * Monta o MOVA. Sem `pool` = memória (simulação); com `pool` = PostgreSQL (schema `mova`).
 * `financeiro` = contrato do Financeiro v2 injetado (ACAO, ErroFinanceiro, validarObrigacao, categoriaProvisoria) — este
 * módulo não importa o núcleo (regra de isolamento: só a camada de integração o importa).
 * `nucleo` = núcleo do Financeiro v2: a PORTA usa só 3 leituras; o APROVADOR (Nível 2) usa os serviços de escrita, sempre com o
 * contexto verificado do administrador.
 * @param {{configuracao:object, nucleo:object, concessoes:{listar:Function}, financeiro:object, extrator:{extrair:Function}, pool?:object,
 *          obterMidia?:Function, relogio?:() => Date, registrar?:Function, fila?:object}} deps
 */
export function criarMova({ configuracao, nucleo, concessoes, financeiro, extrator, pool = null, obterMidia = null, relogio = () => new Date(), registrar = () => {}, fila }) {
  const cfg = validarConfiguracao(configuracao);
  const armazenamento = pool ? criarArmazenamentoPostgres({ pool }) : criarArmazenamentoMemoria({ relogio });
  const evidencias = pool ? criarEvidenciasPostgres({ pool }) : criarEvidenciasMemoria();
  const filaUsada = fila ?? (pool ? criarFilaPostgres({ pool, relogio: () => relogio().getTime() }) : criarFilaMemoria({ relogio: () => relogio().getTime() }));
  const porta = criarPortaFinanceira({ nucleo, concessoes, financeiro });
  const motor = criarMotor({ cfg, porta, extrator, armazenamento, relogio, registrar });
  const receptor = criarReceptor({ cfg, motor, fila: filaUsada, evidencias, armazenamento, obterMidia, relogio, registrar });
  const aprovador = criarAprovador({ cfg, armazenamento, nucleo, financeiro, fila: filaUsada });
  const consultas = pool ? criarConsultasPostgres({ pool }) : null;
  return Object.freeze({ cfg, receptor, motor, aprovador, consultas, armazenamento, evidencias, fila: filaUsada, porta });
}
/** Nome mantido da Execução 01. */
export const criarMovaSimulado = criarMova;
