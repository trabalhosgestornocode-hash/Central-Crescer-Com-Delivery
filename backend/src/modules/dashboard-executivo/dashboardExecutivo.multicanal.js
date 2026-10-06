// Lançamento MULTICANAL do Dashboard iFood (Checkpoint D) — a orquestração
// que o service chama quando o DIA é multicanal. O caminho padrão não passa
// por aqui.
//
//   contexto  -> lê config/canais/valores do mês e calcula participantes,
//                acumulados anteriores por canal e o escopo do dia;
//   normalizar-> valida a entrada POR CANAL e calcula o CONSOLIDADO no
//                servidor (o cliente nunca manda o consolidado), passando-o
//                pela MESMA `normalizarDadosLancamento` do modo padrão — todas
//                as regras atuais (D-1, inconsistências, queda de acumulado,
//                rascunho) valem sobre o consolidado, e a queda por canal
//                entra no mesmo fluxo de confirmação;
//   gravar    -> uma única RPC atômica (consolidado + canais na mesma
//                transação, com concorrência otimista por updated_at);
//   bloco     -> o que o GET por data devolve para o formulário.
//
// Regras de cálculo vivem em dashboardExecutivo.canais.js (puras) e calc.js —
// nada de fórmula aqui. Toda função com I/O aceita `db` (o service passa o
// SEU cliente `supabase`, para que um único ponto de injeção valha para tudo).
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { indicadorAplicavel, STATUS_DIA } from "./dashboardExecutivo.calc.js";
import {
  ESTRUTURA, ESCOPO_ENTREGADORES, estruturaDaUnidade, estruturaDoDia, escopoEntregadoresDoDia, canaisParticipantes,
  desempenhoAnteriorPorCanal, snapshotFinanceiroAnteriorPorCanal, normalizarCanais, consolidarCanais, corpoConsolidado,
  resumoConsolidado, linhasCanaisParaGravacao, quedasPorCanal, valorCanalParaApi, etapaIncompletaMulticanal,
} from "./dashboardExecutivo.canais.js";
import { lerConfigECanais, lerValoresCanais, objetoAusente } from "./dashboardExecutivo.canaisRepo.js";

const RPC_SALVAR = "dashboard_ifood_salvar_lancamento_multicanal";
const SITUACOES = ["normal", "parcial", "sem_operacao", "zero_vendas"];
const MSG_DESATUALIZADO = "Este lançamento foi atualizado em outro dispositivo ou sessão. Os dados exibidos podem estar desatualizados. Atualize o lançamento antes de salvar novamente.";

/**
 * Estrutura de UM dia: lançamento existente => a dele (imutável); dia novo =>
 * a configuração atual da unidade. Só consulta a configuração quando precisa
 * (dia já lançado como padrão nunca lê nada novo). Migration ausente => padrão.
 * @returns {Promise<{estrutura: string, lido: object|null}>}
 */
export async function estruturaDoDiaComConfig({ unidadeId, lancamento, db = supabase }) {
  if (lancamento) return { estrutura: estruturaDoDia({ lancamento }), lido: null };
  const lido = await lerConfigECanais({ unidadeId, db });
  if (lido.ausente) return { estrutura: ESTRUTURA.PADRAO, lido };
  return { estrutura: estruturaDaUnidade(lido.config), lido };
}

/**
 * Tudo que um dia multicanal precisa saber do mês, numa leitura só.
 * @param {{unidadeId: string, dataIso: string, linhasDoMes: object[], lancamento: object|null, lido?: object|null, modeloNaDataLancamento?: string|null}} p
 */
export async function contextoMulticanal({ unidadeId, dataIso, linhasDoMes, lancamento, lido = null, modeloNaDataLancamento = null, db = supabase }) {
  const leitura = lido ?? await lerConfigECanais({ unidadeId, db });
  if (leitura.ausente) {
    throw new ApiError(409, "O lançamento por canais ainda não está disponível neste ambiente (migration 108 não aplicada).");
  }
  const idsMulticanal = (linhasDoMes ?? []).filter((r) => r.estrutura_lancamento === ESTRUTURA.MULTICANAL).map((r) => r.id);
  const linhasCanaisDoMes = await lerValoresCanais({ lancamentoIds: idsMulticanal, db });
  const valoresDoDia = lancamento ? linhasCanaisDoMes.filter((f) => f.lancamento_id === lancamento.id) : [];

  // Participam: ativos + quem já tem valor NO MÊS (ainda que desativado
  // depois) + quem já está gravado neste dia. Nunca o cliente escolhe.
  const idsComValor = new Set([...linhasCanaisDoMes.map((f) => f.canal_id), ...valoresDoDia.map((f) => f.canal_id)]);
  const participantes = canaisParticipantes(leitura.canais, idsComValor);
  const canalIds = participantes.map((c) => c.id);
  // Produto (Checkpoint F): em Sanduíches + Saladas a taxa de entregadores é
  // SEMPRE da unidade — um dia NOVO nasce com escopo "unidade" seja qual for a
  // configuração gravada. Um dia já lançado mantém o escopo gravado nele.
  const escopoEntregadores = lancamento
    ? escopoEntregadoresDoDia({ lancamento, config: leitura.config })
    : ESCOPO_ENTREGADORES.UNIDADE;
  const entregadoresAplicavel = !modeloNaDataLancamento || indicadorAplicavel(modeloNaDataLancamento, "taxas_entregadores");
  return {
    config: leitura.config,
    estruturaUnidade: estruturaDaUnidade(leitura.config),
    participantes, linhasCanaisDoMes, valoresDoDia, escopoEntregadores, entregadoresAplicavel,
    desempenhoAnterior: desempenhoAnteriorPorCanal({ linhasDoMes, linhasCanaisDoMes, antesDeDataIso: dataIso, canalIds }),
    snapshotAnterior: snapshotFinanceiroAnteriorPorCanal({ linhasDoMes, linhasCanaisDoMes, antesDeDataIso: dataIso, canalIds }),
  };
}

/**
 * Normaliza um dia multicanal: canais -> consolidado -> regras do consolidado.
 * `normalizarDadosLancamento` é injetada (é do service) para não haver ciclo
 * de import e para garantir que é EXATAMENTE a mesma regra do modo padrão.
 * @returns {{dados: object, canais: object[], linhasCanais: object[]}}
 */
export function normalizarDiaMulticanal(body, { ctx, dataIso, linhasDoMes, exigirFinanceiro, desempenhoAnteriorUnidade, financeiroAnterior, modeloNaDataLancamento, normalizarDadosLancamento }) {
  const b = v.corpo(body);
  const situacao = v.umDe(b.situacao, "Situação", SITUACOES);
  const statusAlvo = v.umDeOpcional(b.status, "Status", ["rascunho", "finalizado"], "rascunho");

  const canais = normalizarCanais(b.canais, {
    participantes: ctx.participantes, situacaoUnidade: situacao, statusAlvo, exigirFinanceiro,
    escopoEntregadores: ctx.escopoEntregadores, entregadoresAplicavel: ctx.entregadoresAplicavel,
    desempenhoAnterior: ctx.desempenhoAnterior,
  });
  // Taxa compartilhada (escopo "unidade"): um único valor, no nível da unidade.
  const taxasEntregadoresUnidade = ctx.escopoEntregadores === ESCOPO_ENTREGADORES.UNIDADE
    ? v.numeroOpcionalNulo(b.taxasEntregadores, "Taxas de entregadores", { min: 0, max: 1e9 })
    : null;
  const consolidado = consolidarCanais(canais, { escopoEntregadores: ctx.escopoEntregadores, taxasEntregadoresUnidade });

  // Queda de acumulado POR CANAL entra no MESMO fluxo de confirmação do
  // consolidado (aviso leve -> confirmarAvisos; material -> confirmação
  // reforçada + justificativa), nunca num fluxo paralelo.
  const sinaisCanal = quedasPorCanal({
    canais, linhasDoMes, linhasCanaisDoMes: ctx.linhasCanaisDoMes, dataIso,
    escopoEntregadores: ctx.escopoEntregadores, entregadoresAplicavel: ctx.entregadoresAplicavel,
  });

  const dados = normalizarDadosLancamento(corpoConsolidado(b, consolidado), {
    exigirFinanceiro, desempenhoAnterior: desempenhoAnteriorUnidade, financeiroAnterior, modeloNaDataLancamento,
    sinaisQuedaExtras: sinaisCanal,
  });
  return { dados, canais, linhasCanais: linhasCanaisParaGravacao(canais) };
}

/** Mapeia os erros da RPC de lançamento para a mesma semântica HTTP do modo padrão. */
function erroDaRpc(error) {
  const msg = error?.message ?? "";
  if (objetoAusente(error)) return new ApiError(409, "O lançamento por canais ainda não está disponível neste ambiente (migration 108 não aplicada).");
  if (error?.code === "23505" || /duplicate key|unique/i.test(msg)) {
    return new ApiError(409, "Já existe um lançamento para esta unidade e data.", { statusDia: STATUS_DIA.PREENCHIDO });
  }
  if (error?.code === "23503" || /foreign key/i.test(msg)) return ApiError.badRequest("Canal não pertence a esta unidade.");
  const [, codigo] = /^([A-Z_]+)\b/.exec(msg) ?? [];
  if (codigo === "LANCAMENTO_DESATUALIZADO") {
    const e = new ApiError(409, MSG_DESATUALIZADO);
    e.codigo = "LANCAMENTO_DESATUALIZADO";
    return e;
  }
  if (codigo === "LANCAMENTO_NAO_ENCONTRADO") return ApiError.notFound("Lançamento não encontrado.");
  if (codigo === "LANCAMENTO_NAO_MULTICANAL") return new ApiError(409, "Este dia não foi lançado por canais.");
  if (codigo === "CANAL_AUSENTE") return ApiError.badRequest("Todo canal já lançado neste dia precisa continuar no lançamento.");
  return ApiError.badRequest(msg || "Falha ao gravar o lançamento.");
}

/**
 * Grava consolidado + canais numa única transação (RPC da migration 108).
 * Criação: `lancamentoId`/`versao` nulos. Edição: `versao` = updated_at lido
 * (obrigatória — protege o dia inteiro, consolidado E composição).
 */
export async function gravarDiaMulticanal({ organizacaoId, unidadeId, lancamentoId = null, versao = null, linha, linhasCanais, db = supabase }) {
  const { data, error } = await db.rpc(RPC_SALVAR, {
    p_organizacao_id: organizacaoId, p_unidade_id: unidadeId,
    p_lancamento_id: lancamentoId, p_versao: versao,
    p_lancamento: linha, p_canais: linhasCanais,
  });
  if (error) throw erroDaRpc(error);
  return Array.isArray(data) ? data[0] : data;
}

/**
 * Bloco `multicanal` do GET por data — só existe quando o DIA é multicanal
 * (dia padrão: resposta idêntica à de sempre). Traz o que o formulário vai
 * precisar: canais participantes na ordem, valores gravados, acumulados
 * anteriores (para "Sem vendas" e pré-preenchimento do Financeiro),
 * consolidado + derivados e a etapa em que um rascunho deve reabrir.
 */
export function blocoMulticanal({ ctx, lancamento, mostrarFinanceiro }) {
  const valores = ctx.valoresDoDia.map(valorCanalParaApi);
  const porCanal = new Map(valores.map((x) => [x.canalId, x]));
  const consolidado = lancamento ? {
    qtdVendas: num(lancamento.qtd_vendas), valorVendasBruto: num(lancamento.valor_vendas_bruto), novosClientes: num(lancamento.novos_clientes),
    valorVendasIfood: num(lancamento.valor_vendas_ifood), taxasComissoes: num(lancamento.taxas_comissoes),
    servicosPromocoes: num(lancamento.servicos_promocoes), taxasEntregadores: num(lancamento.taxas_entregadores),
    ajustesFavorLoja: num(lancamento.ajustes_favor_loja), ajustesContraLoja: num(lancamento.ajustes_contra_loja),
  } : null;
  return {
    estruturaDia: ESTRUTURA.MULTICANAL,
    estruturaUnidade: ctx.estruturaUnidade,
    taxasEntregadoresEscopo: ctx.escopoEntregadores,
    entregadoresAplicavel: ctx.entregadoresAplicavel,
    canais: ctx.participantes.map((c) => ({ canalId: c.id, nome: c.nome, ordem: c.ordem, ativo: c.ativo !== false })),
    valores,
    anteriores: ctx.participantes.map((c) => {
      const d = ctx.desempenhoAnterior.get(c.id);
      const s = ctx.snapshotAnterior.get(c.id);
      return {
        canalId: c.id,
        desempenho: d ? { conhecido: d.conhecido, qtdVendas: d.qtdVendas, valorVendasBruto: d.valorVendasBruto, novosClientes: d.novosClientes } : null,
        financeiro: s ? {
          dataReferencia: s.data_lancamento, valorVendasIfood: num(s.valor_vendas_ifood), taxasComissoes: num(s.taxas_comissoes),
          servicosPromocoes: num(s.servicos_promocoes), taxasEntregadores: num(s.taxas_entregadores),
          ajustesFavorLoja: num(s.ajustes_favor_loja), ajustesContraLoja: num(s.ajustes_contra_loja),
        } : null,
      };
    }),
    consolidado,
    resumo: consolidado ? resumoConsolidado(consolidado) : null,
    etapaIncompleta: etapaIncompletaMulticanal({
      situacao: lancamento?.situacao ?? null, motivoSemOperacao: lancamento?.motivo_sem_operacao ?? null, mostrarFinanceiro,
      canais: ctx.participantes.map((c) => porCanal.get(c.id) ?? { canalId: c.id, situacaoCanal: null }),
      taxasEntregadoresUnidade: lancamento?.taxas_entregadores ?? null,
      escopoEntregadores: ctx.escopoEntregadores, entregadoresAplicavel: ctx.entregadoresAplicavel,
    }),
  };
}

const num = (x) => (x == null ? null : Number(x));
