// Fechamento logístico diário — funções PURAS (sem I/O). Reaproveita integralmente as regras do Parser:
//   * operação: classificarOperacao (já aplicada no adaptador);
//   * elegibilidade: Subway + com entregador (mesma regra de ehElegivelConciliacao do Parser);
//   * cancelamentos: classificarCancelamento + resolverStatusConciliacao (motor do Parser);
//   * totais: resumoConciliacao; por entregador: agruparPorEntregador; dashboard: calcularDashboardOperacional.
//
// Regras PRÓPRIAS desta camada (decisões aprovadas):
//   * entregador próprio (courierType internal) e "não classificado" são separados; só o próprio compõe o custo logístico
//     próprio; não classificado vira pendência;
//   * pedidos de OUTRAS OPERAÇÕES despachados pela conta (ex.: Açaí com entregador próprio da Subway) ficam num bloco à parte,
//     com quantidade e taxas identificadas, NUNCA somados aos custos da unidade e NUNCA gravados no tenant da outra operação;
//   * operação em dúvida (revisao_necessaria) fica fora dos totais e vira pendência;
//   * taxa prevista de pedido SEM entregador (a API preenche courierFee mesmo assim) não entra em nada — só é contada;
//   * estados de valor: brutas = SINCRONIZADO; válidas = PROVISORIO enquanto houver decisão pendente; custo real = não disponível.
// CONEXÃO COMPARTILHADA (145, `compartilhado: true`): o mesmo cálculo roda POR TENANT, com a operação daquele tenant como
// principal (titular = subway; destino = a operação do destino). Linhas desativadas e de TRIAGEM nunca entram nos totais; triagem
// pendente na conexão deixa o fechamento PROVISÓRIO. Sem `compartilhado`, a saída é idêntica à da 147 (mesmo hash).
import { OPERACAO, classificarOperacao } from "../parser-food-delivery/parserFoodDelivery.operacao.js";
import {
  ehCancelado, temEntregador, resolverStatusConciliacao, resumoConciliacao, agruparPorEntregador, STATUS_CONCILIACAO,
} from "../parser-food-delivery/parserFoodDelivery.calc.js";
import { classificarCancelamento } from "../parser-food-delivery/parserFoodDelivery.classificacao.js";
import { calcularDashboardOperacional } from "../parser-food-delivery/parserFoodDelivery.dashboard.js";
import { paraPedidoParser, jsonEstavel, sha256 } from "./foody.adapter.js";
import { RESULTADO_TRIAGEM as TRIAGEM } from "./foody.classificacao.js";
import { ENTREGADOR_TIPO, ESTADO_VALORES, STATUS_FECHAMENTO, FOODY_REGRA_VERSAO, STATUS_FOODY_PARA_SITUACAO } from "./foody.constants.js";

const arred = (n) => Math.round((Number(n) || 0) * 100) / 100;
const SITUACOES_CONHECIDAS = new Set(Object.values(STATUS_FOODY_PARA_SITUACAO));

/** Mesmo processamento que o Parser faz em cada pedido elegível (classificarComMotor, sem códigos manuais). */
export function processarElegivel(p) {
  if (!ehCancelado(p.situacao)) {
    return { ...p, statusConciliacao: STATUS_CONCILIACAO.INCLUIDO, classificacaoCancelamento: null, classificacaoRegra: null };
  }
  const r = classificarCancelamento(p);
  return {
    ...p, statusConciliacao: resolverStatusConciliacao(r.classificacao),
    classificacaoCancelamento: r.classificacao, classificacaoRegra: r.regra, classificacaoNivelConfianca: r.nivelConfianca,
  };
}

function blocoTotais(processados) {
  const r = resumoConciliacao(processados);
  return {
    pedidos: r.totalPedidos, entregues: r.entregues, cancelados: r.cancelados,
    canceladosRecebemTaxa: r.canceladosRecebemTaxa, canceladosNaoRecebemTaxa: r.canceladosNaoRecebemTaxa,
    canceladosRevisao: r.canceladosRevisao,
    taxasBrutas: r.taxasBrutas, taxasDescartadas: r.taxasDescartadas, taxasValidas: r.taxasValidas,
    custoMedioPorEntrega: r.entregues ? arred(r.taxasValidas / r.entregues) : null,
  };
}

function blocoOutraOperacao(lista) {
  const comEntregador = lista.filter((p) => temEntregador(p.entregador));
  const taxa = (arr) => arred(arr.reduce((s, p) => s + (Number(p.taxaEntregador) || 0), 0));
  const porTipo = {};
  for (const p of comEntregador) {
    const x = (porTipo[p.entregadorTipo] ??= { pedidos: 0, taxas: 0 });
    x.pedidos++; x.taxas = arred(x.taxas + (Number(p.taxaEntregador) || 0));
  }
  return {
    pedidos: lista.length,
    comEntregador: comEntregador.length,
    entregues: comEntregador.filter((p) => !ehCancelado(p.situacao)).length,
    cancelados: comEntregador.filter((p) => ehCancelado(p.situacao)).length,
    // Taxas IDENTIFICADAS (brutas, de quem tinha entregador). Informativo: não é rateado nem somado ao custo da unidade.
    taxasIdentificadas: taxa(comEntregador),
    porTipoEntregador: porTipo,
    somadoAoCustoDaUnidade: false,
  };
}

/**
 * @param {Array<object>} registros linhas de foody_pedidos (saneadas) da competência
 * @param {{ competencia: string, cobertura: object, operacao?: string, compartilhado?: boolean }} contexto
 *   cobertura = prova da execução de sync usada; operacao = operação principal do tenant (padrão subway)
 * @returns {{ status, estadoValores, cobertura, indicadores, outrasOperacoes, pendencias, hash, regraVersao }}
 */
export function calcularFechamentoLogistico(registros, { competencia, cobertura, operacao = OPERACAO.SUBWAY, compartilhado = false }) {
  const pedidos = (registros ?? []).filter((r) => r.competencia === competencia && r.roteamento_ativo !== false).map(paraPedidoParser)
    .sort((a, b) => (a.dataHora < b.dataHora ? -1 : a.dataHora > b.dataHora ? 1 : String(a.foodyUid).localeCompare(String(b.foodyUid))));
  const pendencias = [];

  const subway = pedidos.filter((p) => p.operacao === operacao); // operação PRINCIPAL deste tenant
  const emDuvida = pedidos.filter((p) => p.operacao === OPERACAO.REVISAO_NECESSARIA);
  const triagem = pedidos.filter((p) => p.operacao === TRIAGEM);
  const outras = pedidos.filter((p) => p.operacao !== operacao && p.operacao !== OPERACAO.REVISAO_NECESSARIA && p.operacao !== TRIAGEM);

  const elegiveis = subway.filter((p) => temEntregador(p.entregador));
  const semEntregador = subway.filter((p) => !temEntregador(p.entregador));
  const processados = elegiveis.map(processarElegivel);
  const proprios = processados.filter((p) => p.entregadorTipo === ENTREGADOR_TIPO.PROPRIO);
  const naoClassificados = processados.filter((p) => p.entregadorTipo === ENTREGADOR_TIPO.NAO_CLASSIFICADO);

  const total = blocoTotais(processados);
  const proprio = blocoTotais(proprios);
  const naoClassificado = blocoTotais(naoClassificados);
  const dash = calcularDashboardOperacional(processados).resumo;

  const entregadores = agruparPorEntregador(proprios)
    .map((g) => ({ entregadorHash: g.chave, pedidos: g.totalPedidos, entregues: g.entregues, canceladosComTaxa: g.canceladosComTaxa,
      canceladosSemTaxa: g.canceladosSemTaxa, canceladosRevisao: g.canceladosRevisao, taxasValidas: g.taxasValidas }))
    .sort((a, b) => b.taxasValidas - a.taxasValidas || a.entregadorHash.localeCompare(b.entregadorHash));

  const outrasOperacoes = {};
  for (const op of [...new Set(outras.map((p) => p.operacao))].sort()) {
    outrasOperacoes[op] = blocoOutraOperacao(outras.filter((p) => p.operacao === op));
  }

  // ---- pendências (sem dado pessoal: só contagens e códigos)
  if (total.canceladosRevisao > 0) pendencias.push({ codigo: "CANCELAMENTO_EM_REVISAO", quantidade: total.canceladosRevisao });
  if (naoClassificados.length > 0) pendencias.push({ codigo: "ENTREGADOR_NAO_CLASSIFICADO", quantidade: naoClassificados.length, taxasValidas: naoClassificado.taxasValidas });
  if (emDuvida.length > 0) pendencias.push({ codigo: "OPERACAO_EM_DUVIDA", quantidade: emDuvida.length });
  // Regra do Parser: sem termo de NENHUMA operação, o pedido é da principal (Subway). Uma operação nova/desconhecida cairia aqui —
  // por isso é contado e exposto (com as taxas), em vez de ficar invisível. Informativo: não muda o estado (paridade com o Parser).
  // No modo compartilhado toda linha classificada tem evidência própria (catálogo/termo/decisão): não existe "por padrão".
  const porPadrao = compartilhado ? [] : elegiveis.filter((p) => classificarOperacao({ detalhesPedido: p.detalhesPedido }).termosEncontrados.length === 0);
  if (porPadrao.length > 0) {
    pendencias.push({ codigo: "OPERACAO_POR_PADRAO", quantidade: porPadrao.length, informativa: true,
      taxasBrutas: arred(porPadrao.reduce((s, p) => s + (Number(p.taxaEntregador) || 0), 0)) });
  }
  const situacoesDesconhecidas = pedidos.filter((p) => !SITUACOES_CONHECIDAS.has(p.situacao)).length;
  if (situacoesDesconhecidas > 0) pendencias.push({ codigo: "STATUS_DESCONHECIDO", quantidade: situacoesDesconhecidas });
  const taxaSemDado = processados.filter((p) => p.taxaEntregador == null).length;
  if (taxaSemDado > 0) pendencias.push({ codigo: "TAXA_AUSENTE", quantidade: taxaSemDado });
  for (const c of cobertura?.pendencias ?? []) pendencias.push(c);

  const coberturaOk = cobertura?.completa === true;
  const status = coberturaOk ? STATUS_FECHAMENTO.CONSOLIDADO : STATUS_FECHAMENTO.INCOMPLETO;
  const triagemPendente = compartilhado ? Number(cobertura?.triagemPendente) || 0 : 0;
  const decisaoPendente = total.canceladosRevisao > 0 || naoClassificados.length > 0 || emDuvida.length > 0 || situacoesDesconhecidas > 0 || taxaSemDado > 0
    || triagemPendente > 0;
  const estadoValores = decisaoPendente || !coberturaOk ? ESTADO_VALORES.PROVISORIO : ESTADO_VALORES.SINCRONIZADO;

  const blocoPrincipal = {
    pedidos: subway.length,
    semEntregador: semEntregador.length,
    taxasPrevistasSemEntregador: arred(semEntregador.reduce((s, p) => s + (Number(p.taxaEntregador) || 0), 0)), // informativo
    elegiveis: elegiveis.length,
    elegiveisSemEvidenciaDeOperacao: porPadrao.length,
    total,
    proprio,
    naoClassificado,
    custoLogisticoProprio: proprio.taxasValidas,
    regrasCancelamento: Object.fromEntries(Object.entries(processados.reduce((m, p) => {
      if (p.classificacaoRegra) m[p.classificacaoRegra] = (m[p.classificacaoRegra] || 0) + 1; return m;
    }, {})).sort()),
    dashboard: {
      totalEntregas: dash.totalEntregas, taxasTotal: dash.taxasTotal, tempoMedioEntregaMin: dash.tempoMedioEntregaMin,
      entregadoresAtivos: dash.entregadoresAtivos,
    },
    entregadores,
  };
  const indicadores = {
    competencia,
    fonte: "foody_api",
    estadoPorValor: {
      taxasBrutas: ESTADO_VALORES.SINCRONIZADO,
      taxasValidas: estadoValores,
      custoReal: null, // não disponível nesta fase (exige lançamentos; nunca inventado)
    },
    pedidosNaConta: pedidos.length,
    [compartilhado ? operacao : "subway"]: blocoPrincipal,
    operacaoEmDuvida: { pedidos: emDuvida.length },
  };
  if (compartilhado) {
    indicadores.operacao = operacao;
    // Triagem fica na titular, fora de qualquer total; só contagem e taxa bruta identificada (informativo, sem rateio).
    indicadores.triagem = { pedidosNesteTenant: triagem.length, pendentesNaConexao: triagemPendente,
      taxasIdentificadas: arred(triagem.filter((p) => temEntregador(p.entregador)).reduce((s, p) => s + (Number(p.taxaEntregador) || 0), 0)),
      somadoAoCustoDaUnidade: false };
  }

  const coberturaPersistida = {
    completa: coberturaOk,
    janelaInicio: cobertura?.janelaInicio ?? null, janelaFim: cobertura?.janelaFim ?? null,
    paginas: cobertura?.paginas ?? null, pedidosUnicos: cobertura?.pedidosUnicos ?? null,
  };
  const hash = sha256(jsonEstavel({ regra: FOODY_REGRA_VERSAO, cobertura: coberturaPersistida, indicadores, outrasOperacoes, pendencias }));
  return { status, estadoValores, cobertura: coberturaPersistida, indicadores, outrasOperacoes, pendencias, hash, regraVersao: FOODY_REGRA_VERSAO };
}
