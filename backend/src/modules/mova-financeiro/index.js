// Centro Financeiro Inteligente MOVA — Execução 01 (fundação). SUPERFÍCIE PÚBLICA.
//
// NÃO está montado em nenhuma rota, não lê ambiente, não conecta a WhatsApp, Evolution, IA nem banco. Só em SIMULAÇÃO:
// propostas e respostas ficam em memória. Ver docs/mova-financeiro/01-fundacao.md.
import { validarConfiguracao } from "./dominio/configuracao.js";
import { criarPortaFinanceira } from "./aplicacao/portaFinanceira.js";
import { criarMotor } from "./aplicacao/motor.js";
import { criarReceptor } from "./gateway/receptor.js";
import { criarFilaMemoria } from "./gateway/fila.js";
import { criarEvidenciasMemoria } from "./gateway/evidencias.js";
import { criarArmazenamentoMemoria } from "./infra/memoria.js";

export { CONTRATO_EVENTO_VERSAO, validarEvento, chaveDoDocumento } from "./contratos/evento.js";
export { normalizarEvolution } from "./adaptadores/evolution.js";
export { normalizarBaileys } from "./adaptadores/baileys.js";
export { validarConfiguracao, SITUACAO_FONTES } from "./dominio/configuracao.js";
export { RESULTADO_UNIDADE, resolverUnidade } from "./dominio/unidade.js";
export { fontesOficiais, receitaPodeVirDe } from "./dominio/fontesDeReceita.js";
export { CONSULTAS, FERRAMENTAS, INTENCAO, TIPO_DOCUMENTO, criarExtratorSimulado, montarEntradaDoModelo, sinaisDeInjecao, validarSaidaDaIa } from "./ia/contratos.js";
export { OPERACOES_PERMITIDAS, criarPortaFinanceira, exigirContratoFinanceiro } from "./aplicacao/portaFinanceira.js";
export { DECISAO, TIPO_PROPOSTA, criarMotor } from "./aplicacao/motor.js";
export { ESTADO_ITEM, ErroTransitorio, criarFilaMemoria } from "./gateway/fila.js";
export { criarEvidenciasMemoria } from "./gateway/evidencias.js";
export { criarReceptor } from "./gateway/receptor.js";
export { criarArmazenamentoMemoria } from "./infra/memoria.js";

/**
 * Monta o MOVA em SIMULAÇÃO sobre um núcleo do Financeiro v2 (as consultas são reais; nada é gravado nele).
 * `financeiro` = peças do contrato do Financeiro v2 (ACAO, ErroFinanceiro, validarObrigacao, categoriaProvisoria), injetadas por quem
 * monta — este módulo não importa o núcleo (regra de isolamento: só a camada de integração o importa).
 * @param {{configuracao:object, nucleo:object, concessoes:{listar:Function}, financeiro:object, extrator:{extrair:Function},
 *          obterMidia?:Function, relogio?:() => Date, registrar?:Function, fila?:object}} deps
 */
export function criarMovaSimulado({ configuracao, nucleo, concessoes, financeiro, extrator, obterMidia = null, relogio = () => new Date(), registrar = () => {}, fila }) {
  const cfg = validarConfiguracao(configuracao);
  const armazenamento = criarArmazenamentoMemoria({ relogio });
  const evidencias = criarEvidenciasMemoria();
  const filaUsada = fila ?? criarFilaMemoria({ relogio: () => relogio().getTime() });
  const porta = criarPortaFinanceira({ nucleo, concessoes, financeiro });
  const motor = criarMotor({ cfg, porta, extrator, armazenamento, relogio, registrar });
  const receptor = criarReceptor({ cfg, motor, fila: filaUsada, evidencias, armazenamento, obterMidia, relogio, registrar });
  return Object.freeze({ cfg, receptor, motor, armazenamento, evidencias, fila: filaUsada, porta });
}
