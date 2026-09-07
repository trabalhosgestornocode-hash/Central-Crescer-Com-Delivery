// Regras de conciliação — funções PURAS (sem I/O), testáveis sem banco.
// Mesmo espírito de bonificacaoMensal.calc.js: a decisão fica isolada da
// escrita, para poder testar a regra sozinha.
import { norm } from "./parserFoodDelivery.parser.js";
import { OPERACAO, rotuloOperacao } from "./parserFoodDelivery.operacao.js";
import { CLASSIFICACAO_CANCELAMENTO } from "./parserFoodDelivery.classificacao.js";
// Reaproveitado só para os limites de calendário (primeiro/último dia do
// mês) — puro, sem lógica de negócio nova. Nenhuma fórmula financeira cruza
// daqui pra lá nem de lá pra cá.
import { diasDoMes } from "../dashboard-executivo/dashboardExecutivo.calc.js";

export const STATUS_CONCILIACAO = {
  INCLUIDO: "incluido",             // taxa válida (entregue/finalizado ou qualquer situação não-cancelada)
  EXCLUIDO: "excluido",             // cancelado E não recebe taxa (motor automático ou override manual) -> taxa descartada
  CANCELADO_COM_TAXA: "cancelado_com_taxa", // cancelado mas recebe taxa ou está em revisão -> taxa continua válida
};

/**
 * Traduz o resultado do motor de classificação automática
 * (parserFoodDelivery.classificacao.js) pro status de conciliação
 * financeira. REVISAR mantém a taxa por padrão — mesmo espírito do
 * comportamento antigo ("cancelado sem código informado mantém a taxa") —
 * só fica destacado como pendente na UI até alguém confirmar/reverter.
 * @param {string} classificacaoCancelamento um de CLASSIFICACAO_CANCELAMENTO
 * @returns {string} um de STATUS_CONCILIACAO
 */
export function resolverStatusConciliacao(classificacaoCancelamento) {
  return classificacaoCancelamento === CLASSIFICACAO_CANCELAMENTO.NAO_RECEBE_TAXA
    ? STATUS_CONCILIACAO.EXCLUIDO
    : STATUS_CONCILIACAO.CANCELADO_COM_TAXA;
}

// Catálogo deliberadamente fechado: evita transformar qualquer texto parecido
// em cancelamento, mas aceita as variantes reais mais comuns dos relatórios.
const STATUS_CANCELADOS = new Set([
  "cancelado", "cancelada", "cancelado pelo restaurante",
  "cancelado pelo cliente", "cancelado pelo entregador",
]);
export const ehCancelado = (situacao) => STATUS_CANCELADOS.has(norm(situacao));

/** Mesma decisão exibida nos detalhes: override vence; legado usa o status
 * financeiro persistido. Não modifica a classificação automática original. */
export function classificacaoEfetivaCancelamento(p) {
  if (!ehCancelado(p.situacao)) return null;
  if (!p.classificacaoOverrideEm && p.classificacaoCancelamento) return p.classificacaoCancelamento;
  return p.statusConciliacao === STATUS_CONCILIACAO.EXCLUIDO
    ? CLASSIFICACAO_CANCELAMENTO.NAO_RECEBE_TAXA : CLASSIFICACAO_CANCELAMENTO.RECEBE_TAXA;
}
/**
 * Pedido sem nome de entregador não entra em NADA da conciliação (item novo
 * do pedido) — não é o `classificarPedido` que decide isso: é filtrado uma
 * camada acima, ANTES da conciliação (parserFoodDelivery.service.js, mesmo
 * estágio do pipeline que remove pedidos de outra operação). Por isso esta
 * função só existe aqui como o critério único e reutilizável — quem chama
 * `classificarPedido` já garante que só chega pedido com entregador.
 */
export const temEntregador = (entregador) => typeof entregador === "string" && entregador.trim() !== "";
/** Chave de agregação segura: não tenta aproximar nomes diferentes, só remove variações de digitação. */
export const chaveEntregador = (entregador) => norm(entregador).replace(/\s+/g, " ");
const nomeExibicaoEntregador = (entregador) => String(entregador).trim().replace(/\s+/g, " ");

/**
 * A ÚNICA regra de negócio da CONCILIAÇÃO em si (item 3 do pedido) — já
 * assume que o pedido passou pelo filtro de operação + entregador:
 *   - não cancelado                          -> incluído (taxa entra normalmente)
 *   - cancelado E código está na lista        -> excluído (taxa descartada)
 *   - cancelado E código NÃO está na lista    -> cancelado_com_taxa (taxa permanece válida)
 * Nunca infere pela sequência logística — só a lista explícita decide.
 * @param {{numeroPedido: string, situacao: string|null}} pedido
 * @param {Set<string>} codigosSemTaxa
 * @returns {string} um de STATUS_CONCILIACAO
 */
export function classificarPedido(pedido, codigosSemTaxa) {
  if (!ehCancelado(pedido.situacao)) return STATUS_CONCILIACAO.INCLUIDO;
  return codigosSemTaxa.has(pedido.numeroPedido) ? STATUS_CONCILIACAO.EXCLUIDO : STATUS_CONCILIACAO.CANCELADO_COM_TAXA;
}

/**
 * @param {Array<{numeroPedido:string, situacao:string|null, taxaEntregador:number|null, statusConciliacao:string,
 *   classificacaoCancelamento?:string|null}>} pedidos já classificados
 */
export function resumoConciliacao(pedidos) {
  let entregues = 0, cancelados = 0, canceladosComTaxa = 0, canceladosSemTaxa = 0;
  let canceladosRecebemTaxa = 0, canceladosNaoRecebemTaxa = 0, canceladosRevisao = 0;
  let taxasBrutas = 0, taxasDescartadas = 0;
  for (const p of pedidos) {
    const taxa = p.taxaEntregador || 0;
    taxasBrutas += taxa;
    if (ehCancelado(p.situacao)) {
      cancelados++;
      if (p.statusConciliacao === STATUS_CONCILIACAO.EXCLUIDO) { canceladosSemTaxa++; taxasDescartadas += taxa; }
      else canceladosComTaxa++;
      // Contadores usam a decisão efetiva, exatamente como o detalhamento.
      const efetiva = classificacaoEfetivaCancelamento(p);
      if (efetiva === CLASSIFICACAO_CANCELAMENTO.RECEBE_TAXA) canceladosRecebemTaxa++;
      else if (efetiva === CLASSIFICACAO_CANCELAMENTO.NAO_RECEBE_TAXA) canceladosNaoRecebemTaxa++;
      else if (efetiva === CLASSIFICACAO_CANCELAMENTO.REVISAR) canceladosRevisao++;
    } else {
      entregues++;
    }
  }
  const taxasValidas = taxasBrutas - taxasDescartadas;
  return {
    totalPedidos: pedidos.length, entregues, cancelados, canceladosComTaxa, canceladosSemTaxa,
    canceladosRecebemTaxa, canceladosNaoRecebemTaxa, canceladosRevisao,
    taxasBrutas: arredondar(taxasBrutas), taxasDescartadas: arredondar(taxasDescartadas), taxasValidas: arredondar(taxasValidas),
  };
}

/**
 * Agrupa os pedidos já classificados por entregador (item 6 do pedido).
 * Pedido sem nome de entregador não entra aqui — não existe entregador pra
 * atribuir a taxa, então não faz sentido aparecer no ranking/taxas dos
 * entregadores (esses pedidos continuam contados no resumo geral da
 * conciliação, só não aparecem AQUI). A ordenação fica a cargo de quem
 * chama (frontend oferece 3 critérios).
 */
export function agruparPorEntregador(pedidos) {
  const porNome = new Map();
  for (const p of pedidos) {
    if (!temEntregador(p.entregador)) continue;
    const chave = chaveEntregador(p.entregador);
    if (!porNome.has(chave)) {
      porNome.set(chave, { entregador: nomeExibicaoEntregador(p.entregador), totalPedidos: 0, entregues: 0, canceladosComTaxa: 0, canceladosSemTaxa: 0, canceladosRevisao: 0, taxasValidas: 0 });
    }
    const g = porNome.get(chave);
    g.totalPedidos++;
    const taxa = p.taxaEntregador || 0;
    if (ehCancelado(p.situacao)) {
      if (p.statusConciliacao === STATUS_CONCILIACAO.EXCLUIDO) g.canceladosSemTaxa++;
      else { g.canceladosComTaxa++; g.taxasValidas += taxa; }
      if (classificacaoEfetivaCancelamento(p) === CLASSIFICACAO_CANCELAMENTO.REVISAR) g.canceladosRevisao++;
    } else {
      g.entregues++;
      g.taxasValidas += taxa;
    }
  }
  return [...porNome.values()].map((g) => ({ ...g, taxasValidas: arredondar(g.taxasValidas) }));
}

/**
 * Valida um código digitado pelo usuário contra os pedidos da prévia (item 2).
 * O mapa recebido é o de TODOS os pedidos do arquivo (Subway + outras
 * operações) — só assim dá pra diferenciar "não encontrado" de "encontrado,
 * mas é de outra operação" (item novo: cancelamento sem taxa só vale para
 * pedidos já classificados como Subway).
 * @param {string} codigo
 * @param {Map<string, {situacao: string|null, operacao?: string}>} pedidosPorNumero
 */
export function validarCodigo(codigo, pedidosPorNumero) {
  const chave = String(codigo).trim();
  const pedido = pedidosPorNumero.get(chave);
  if (!pedido) return { codigo: chave, encontrado: false, situacao: null, cancelado: false, operacao: null, alerta: "Pedido não encontrado" };

  if (pedido.operacao && pedido.operacao !== OPERACAO.SUBWAY) {
    return {
      codigo: chave, encontrado: true, situacao: pedido.situacao, cancelado: false, operacao: pedido.operacao,
      alerta: pedido.operacao === OPERACAO.REVISAO_NECESSARIA
        ? "Este pedido está com a operação indefinida (revisão necessária) — confira antes de usar este código."
        : `Este pedido foi identificado como pertencente a outra operação (${rotuloOperacao(pedido.operacao)}) e não faz parte desta conciliação.`,
    };
  }
  if (!temEntregador(pedido.entregador)) {
    return {
      codigo: chave, encontrado: true, situacao: pedido.situacao, cancelado: ehCancelado(pedido.situacao), operacao: pedido.operacao ?? OPERACAO.SUBWAY,
      alerta: "Este pedido não tem entregador atribuído — já fica de fora da conciliação automaticamente, não precisa informar o código.",
    };
  }

  const cancelado = ehCancelado(pedido.situacao);
  return {
    codigo: chave, encontrado: true, situacao: pedido.situacao, cancelado, operacao: pedido.operacao ?? OPERACAO.SUBWAY,
    alerta: cancelado ? null : "Pedido encontrado, mas a situação não é \"Cancelado\" — a taxa não será descartada automaticamente.",
  };
}

/** Divide texto colado (vírgula, espaço ou quebra de linha) numa lista de códigos únicos. */
export function extrairCodigos(texto) {
  return [...new Set(String(texto || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * Soma os resumos JÁ CALCULADOS de várias importações de um mesmo período
 * (Agente Crescer, Etapa D — "quantos cancelamentos este mês"). Nenhuma
 * reclassificação aqui, só aritmética pura sobre números que o motor
 * determinístico (parserFoodDelivery.classificacao.js) já decidiu no
 * momento de cada importação — mesmo espírito de resumoConciliacao, mas
 * agregando IMPORTAÇÕES já resumidas em vez de PEDIDOS individuais.
 * @param {Array<{totalPedidos?:number, entregues?:number, cancelados?:number,
 *   canceladosComTaxa?:number, canceladosSemTaxa?:number, canceladosRecebemTaxa?:number,
 *   canceladosNaoRecebemTaxa?:number, canceladosRevisao?:number,
 *   taxasBrutas?:number, taxasDescartadas?:number, taxasValidas?:number}>} importacoes
 */
export function somarResumosPeriodo(importacoes) {
  const soma = (campo) => (importacoes ?? []).reduce((s, i) => s + (Number(i[campo]) || 0), 0);
  return {
    totalImportacoes: (importacoes ?? []).length,
    totalPedidos: soma("totalPedidos"),
    entregues: soma("entregues"),
    cancelados: soma("cancelados"),
    canceladosComTaxa: soma("canceladosComTaxa"),
    canceladosSemTaxa: soma("canceladosSemTaxa"),
    canceladosRecebemTaxa: soma("canceladosRecebemTaxa"),
    canceladosNaoRecebemTaxa: soma("canceladosNaoRecebemTaxa"),
    canceladosRevisao: soma("canceladosRevisao"),
    taxasBrutas: arredondar(soma("taxasBrutas")),
    taxasDescartadas: arredondar(soma("taxasDescartadas")),
    taxasValidas: arredondar(soma("taxasValidas")),
  };
}

/**
 * Primeiro e último dia (ISO AAAA-MM-DD) de um mês — via diasDoMes(), sem
 * lógica de data nova.
 * @param {number} ano @param {number} mes 1-indexado
 */
export function limitesDoMes(ano, mes) {
  const dias = diasDoMes(ano, mes);
  return { inicio: dias[0], fim: dias[dias.length - 1] };
}

/** Primeiro dia (ISO) do mês SEGUINTE — usado como limite EXCLUSIVO em filtros de timestamp. */
export function inicioMesSeguinte(ano, mes) {
  const proximo = mes === 12 ? { ano: ano + 1, mes: 1 } : { ano, mes: mes + 1 };
  return diasDoMes(proximo.ano, proximo.mes)[0];
}

/**
 * Decide entre candidatos de um `numeroPedido` já carregados do banco (a
 * consulta em si mora em parserFoodDelivery.service.js) — pura, sem I/O.
 * Quando `ano`/`mes` são informados, filtra pelo mês do próprio pedido
 * (`dataHora`) ANTES de decidir. NUNCA escolhe sozinho entre 2+ candidatos
 * que sobrarem — mesmo espírito de escolherCandidato (agente/tools/produtosCmvBusca.js),
 * só que aqui a busca é por CÓDIGO exato, não por nome (sem tolerância a erro
 * de digitação: um número de pedido não se aproxima por edição de texto).
 * @param {Array<{dataHora: string|null}>} candidatos
 * @param {{ano?: number, mes?: number}} [filtro]
 * @returns {{status: 'unico', candidato: object} | {status: 'ambiguo', candidatos: object[]} | {status: 'nao_encontrado'}}
 */
export function resolverCandidatoPedido(candidatos, { ano, mes } = {}) {
  let lista = candidatos ?? [];
  if (ano && mes) {
    const prefixo = `${ano}-${String(mes).padStart(2, "0")}`;
    lista = lista.filter((p) => typeof p.dataHora === "string" && p.dataHora.startsWith(prefixo));
  }
  if (!lista.length) return { status: "nao_encontrado" };
  if (lista.length > 1) return { status: "ambiguo", candidatos: lista };
  return { status: "unico", candidato: lista[0] };
}

/**
 * Monta a explicação de UM pedido já identificado (candidato único resolvido
 * por `resolverCandidatoPedido`) para "por que este pedido recebe/não recebe
 * taxa" — pura, sem I/O. NUNCA decide nada: só organiza o que já está
 * gravado (classificação do motor determinístico, timeline, eventual
 * correção manual) numa resposta honesta sobre o que é/não é aplicável a
 * este pedido específico.
 * @param {object} pedido já no formato da API (paraApiPedido/paraResumoCancelamento do service)
 */
export function explicarCancelamento(pedido) {
  const base = { encontrado: true, numeroPedido: pedido.numeroPedido, dataHora: pedido.dataHora };

  if (!ehCancelado(pedido.situacao)) {
    return { ...base, cancelado: false, situacao: pedido.situacao };
  }
  if (pedido.operacao && pedido.operacao !== OPERACAO.SUBWAY) {
    return {
      ...base, cancelado: true, elegivelConciliacao: false,
      motivoNaoElegivel: `Este pedido foi identificado como pertencente a outra operação (${rotuloOperacao(pedido.operacao)}) — não faz parte da conciliação de taxas de entregador.`,
    };
  }
  if (!temEntregador(pedido.entregador)) {
    return {
      ...base, cancelado: true, elegivelConciliacao: false,
      motivoNaoElegivel: "Este pedido não tem entregador atribuído — não faz parte da conciliação de taxas.",
    };
  }
  if (!pedido.classificacaoCancelamento) {
    return {
      ...base, cancelado: true, elegivelConciliacao: true, classificacaoDisponivel: false,
      motivo: "Esta importação é anterior à classificação automática de cancelamentos — não há classificação nem timeline registrada para este pedido.",
    };
  }
  return {
    ...base, cancelado: true, elegivelConciliacao: true, classificacaoDisponivel: true,
    classificacaoAutomatica: {
      decisao: pedido.classificacaoCancelamento, motivo: pedido.classificacaoMotivo,
      nivelConfianca: pedido.classificacaoNivelConfianca, regra: pedido.classificacaoRegra,
    },
    statusFinanceiroAtual: pedido.statusConciliacao,
    emRevisao: pedido.classificacaoCancelamento === CLASSIFICACAO_CANCELAMENTO.REVISAR,
    // Presente só quando um humano corrigiu a decisão automática — nunca
    // sobrescreve classificacaoAutomatica (essa é sempre o que o MOTOR disse).
    correcaoManual: pedido.classificacaoOverrideEm ? {
      usuarioNome: pedido.classificacaoOverrideUsuarioNome, motivo: pedido.classificacaoOverrideMotivo, em: pedido.classificacaoOverrideEm,
    } : null,
    timeline: {
      dataDespachado: pedido.dataDespachado, dataAceito: pedido.dataAceito, dataColetado: pedido.dataColetado,
      dataChegadaEntrega: pedido.dataChegadaEntrega, dataCancelado: pedido.dataCancelado,
    },
  };
}

const arredondar = (n) => Math.round(n * 100) / 100;
