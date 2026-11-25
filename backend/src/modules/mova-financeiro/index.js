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
export { validarConfiguracao, configuracaoViva, requisitosCompletos, SITUACAO_FONTES, ehConversaPrivada } from "./dominio/configuracao.js";
export { RESULTADO_UNIDADE, resolverUnidade } from "./dominio/unidade.js";
export { ACESSO, CAPACIDADES, CONSULTAS_SEM_VALORES, JANELA_CONTINUIDADE_MS, PERFIL, chamaPeloNome, participanteAutorizado } from "./dominio/participantes.js";
export { interpretarComando } from "./aplicacao/comandos.js";
export { fontesOficiais, receitaPodeVirDe } from "./dominio/fontesDeReceita.js";
export { mascararDadosSensiveis, pedidoRestrito } from "./dominio/privacidade.js";
export { CONSULTAS, FERRAMENTAS, INTENCAO, TIPO_DOCUMENTO, criarExtratorSimulado, montarEntradaDoModelo, sinaisDeInjecao, validarSaidaDaIa } from "./ia/contratos.js";
export { OPERACOES_PERMITIDAS, criarPortaFinanceira, exigirContratoFinanceiro } from "./aplicacao/portaFinanceira.js";
export { DECISAO, TIPO_PROPOSTA, criarMotor } from "./aplicacao/motor.js";
export { ErroDeAprovacao, criarAprovador } from "./aplicacao/aprovacao.js";
export { criarFerramentas, periodoDaConsulta } from "./aplicacao/ferramentas.js";
export { criarRedator, validarRedacao } from "./aplicacao/redator.js";
export { ErroDeIa, MODELO_PADRAO, MODELOS_PERMITIDOS, criarExtratorAnthropic, ehFalhaTransitoriaDeIa } from "./ia/provedorAnthropic.js";
export { AVISO_TETO, criarEnviadorDeRespostas, criarWorker } from "./gateway/worker.js";
export { ESTADOS_FINAIS_RELE, criarSaidaPeloRele } from "./gateway/saidaRele.js";
export { CAMPOS_AUSENTES, esquemaDaSaida } from "./ia/contratos.js";
export { ESTADO_ITEM, ErroTransitorio, criarFilaMemoria } from "./gateway/fila.js";
export { criarEvidenciasMemoria } from "./gateway/evidencias.js";
export { criarReceptor } from "./gateway/receptor.js";
export { conferirEventoDoRele, criarConsumidorRele } from "./gateway/consumidorRele.js";
export { criarArmazenamentoMemoria } from "./infra/memoria.js";
export { CHAVES_DE_CONTROLE, PRECOS_IA, clienteComOrcamento, criarControle, criarOrcamentoIa } from "./infra/operacao.js";
export { TETOS_RENOVAVEIS_MICROUSD, criarOrcamentoRenovavel, custoMicrousd, regimeDeOrcamento } from "./infra/orcamentoRenovavel.js";
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
export function criarMova({ configuracao, nucleo, concessoes, financeiro, extrator, pool = null, obterMidia = null, relogio = () => new Date(), registrar = () => {}, fila, controle = null, redator = null, somenteConsultas = false, comandosDeterministicos = false, autonomia = false, operacional = null, entregadores = false, recebimentoDocumental = false, pagamentoPorComprovante = false, criarDespesas = false, registrarJuros = false, criarContas = false, avisosNoGrupo = {}, conversaNova = null }) {
  // 23/11: configuração VIVA (lista de entregadores recarregável) já vem validada: é usada como está, senão a recarga não chegaria aqui.
  const cfg = typeof configuracao?.recarregarEntregadores === "function" ? configuracao : validarConfiguracao(configuracao);
  const armazenamento = pool ? criarArmazenamentoPostgres({ pool }) : criarArmazenamentoMemoria({ relogio });
  const evidencias = pool ? criarEvidenciasPostgres({ pool }) : criarEvidenciasMemoria();
  const filaUsada = fila ?? (pool ? criarFilaPostgres({ pool, relogio: () => relogio().getTime() }) : criarFilaMemoria({ relogio: () => relogio().getTime() }));
  const porta = criarPortaFinanceira({ nucleo, concessoes, financeiro });
  // Agente 2 — Frente C: conferência com o extrato + política de autonomia (só com `autonomia`); escrita só com a porta OPERACIONAL.
  const execucao = autonomia ? criarExecucao({ armazenamento, porta, identidadeLeitura: cfg.identidadeServico.usuarioId, operacional, pagamentoPorComprovante, criarDespesas, registrarJuros, criarContas, obterEvidencia: (r) => evidencias.obter(r), relogio, registrar }) : null;
  // Agente 2 — Frente D: entregadores no privado + rotina semanal (só com `entregadores`; escrita só pela porta OPERACIONAL).
  const fluxoEntregadores = entregadores ? criarEntregadoresMova({ cfg, porta, armazenamento, operacional, extrator, obterEvidencia: (r) => evidencias.obter(r), relogio, registrar, avisosNoGrupo }) : null;
  const motor = criarMotor({ cfg, porta, extrator, armazenamento, relogio, registrar, redator, somenteConsultas, comandosDeterministicos, execucao, entregadores: fluxoEntregadores,
    recebimentoDocumental, obterEvidencia: (r) => evidencias.obter(r), conversaNova });
  const receptor = criarReceptor({ cfg, motor, fila: filaUsada, evidencias, armazenamento, obterMidia, relogio, registrar, controle, recebimentoDocumental });
  const aprovador = criarAprovador({ cfg, armazenamento, nucleo, financeiro, fila: filaUsada, execucao });
  const consultas = pool ? criarConsultasPostgres({ pool }) : null;
  return Object.freeze({ cfg, receptor, motor, aprovador, consultas, armazenamento, evidencias, fila: filaUsada, porta, execucao, entregadores: fluxoEntregadores, recebimentoDocumental, pagamentoPorComprovante: Boolean(pagamentoPorComprovante) });
}
/** Nome mantido da Execução 01. */
export const criarMovaSimulado = criarMova;
import { criarExecucao } from "./aplicacao/execucao.js";
// Agente 2 — Central de pendências e documentos recebidos sem IA (só leitura do Financeiro; conferência humana no banco do MOVA).
export { MOTIVO as MOTIVO_PENDENCIA, MOTIVO_SAIDA, ROTULO_MOTIVO, ROTULO_SAIDA, classificarSaidas, contasRelacionadas, linhaDoTempo, montarConferencia, pendenciaDaConta } from "./aplicacao/centralConferencia.js";
export { ESTADO_CONFERENCIA, MIMES_SEM_LEITURA, RESPOSTA_DOCUMENTO, TIPOS_INFORMADOS, conferirArquivo } from "./aplicacao/recebimentoDocumental.js";
import { criarEntregadoresMova } from "./aplicacao/entregadoresMova.js";
export { AUTOMACAO, RESPOSTA_ENTREGADOR, criarEntregadoresMova } from "./aplicacao/entregadoresMova.js";
export { criarPortaOperacional, executorDaPessoa, ErroDeExecucao, OPERACOES_DE_ESCRITA } from "./aplicacao/portaOperacional.js";
export { criarExecucao };
// Agente 2 — Frente C (autonomia configurável, só decisão) e Frente D (rotina dos entregadores, só composição).
export { NIVEL as NIVEL_AUTONOMIA, OPERACAO as OPERACAO_AUTONOMA, conferirComExtrato, decidirAutonomia, validarPolitica, validarPoliticas } from "./dominio/autonomia.js";
export { identificarEntregador, mensagemCobrancaNota, mensagemSemanal, pendenciaDeNota, precisaCobrarNota, validarEntregadores } from "./dominio/entregadores.js";
