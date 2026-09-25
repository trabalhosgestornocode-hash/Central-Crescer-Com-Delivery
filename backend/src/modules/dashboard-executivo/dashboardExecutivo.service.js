import { carregarPrecosRentabilidade } from "./dashboardExecutivo.precos.service.js";
import { calcularProtecaoPrecificacao, calcularComparacaoProduto } from "./dashboardExecutivo.rentabilidade.js";
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { PERMISSOES, temPermissao } from "../../shared/permissoes.js";
import { resolverMetas, obterModeloLogistico, definirModeloLogistico, historicoModeloLogistico } from "./dashboardExecutivo.metas.service.js";
import {
  hojeIsoBrasil, diasDoMes, mesAnterior, diaAnterior, statusMes, resumoPreenchimento,
  verificarDisponibilidade, agruparPendenciasPorMes, ticketMedio, percentual,
  totalDeducoes, receitaLiquida, saldoPercentual, projecaoMensal,
  snapshotFinanceiroMaisRecente, listaSnapshotsFinanceiros, listaDesempenhoDiario, novosClientesAcumulados, ultimoDesempenhoConhecido,
  desempenhoParaTicketMedio,
  confiabilidadeProjecao,
  inconsistencias, STATUS_DIA, indicadorAplicavel, classificarCamposExtrasMensal, statusIndicadorRentabilidade,
  totalDeducoesIndicador, metasComProtecaoPrecificacao, saldoMeta,
  distribuirValorMensal, distribuirQuantidadeMensal, recalcularDistribuicaoMensal,
} from "./dashboardExecutivo.calc.js";
import {
  montarLinhaDoTempo, modeloNaData, segmentosDoPeriodo, estadoDoPeriodo, rotuloDoModelo, modelosDasDatas, descreverPeriodo, trocasDeLinhas,
} from "./dashboardExecutivo.modeloTemporal.js";
import { dividirFinanceiroPorSegmento, consolidarSegmentos, comporMetas, resumirConciliacao } from "./dashboardExecutivo.periodoMisto.js";
import {
  STATUS_CONCILIACAO, piorStatus, avaliarQuedaAcumulado, avisoIgualdadeSuspeitaComBruto, ultimoValorConciliadoAntesDe,
  caminharSequenciaAcumulada, detectarDivergenciaTransicao,
} from "./dashboardExecutivo.confiabilidade.js";
import { gerarDiagnostico, LIMIARES_DIAGNOSTICO } from "./dashboardExecutivo.diagnostico.js";
import { carregarDatasLiberadas } from "../../shared/desbloqueiosIfood.js";
import { emitirEventoRealtime } from "../realtime/emitirEvento.js";
import { EVENTOS_DASHBOARD_IFOOD, competenciaDe } from "./dashboardExecutivo.eventos.js";

const TABELA = "lancamentos_financeiros_diarios";
const TABELA_AUDITORIA = "lancamentos_financeiros_auditoria";
const TABELA_MENSAL = "lancamentos_financeiros_distribuicao_mensal";
const TABELA_MENSAL_AUDITORIA = "lancamentos_financeiros_distribuicao_mensal_auditoria";
const RESOLVIDOS_COM_DADOS = new Set([STATUS_DIA.PREENCHIDO, STATUS_DIA.ZERO_VENDAS]);

/**
 * Desempenho OPERACIONAL (valor bruto, pedidos, novos clientes, ticket médio)
 * por SEGMENTO de modelo — alimenta o comparativo Marketplace × Full Service
 * e a amostra (dias com dado) por regime. NUNCA passa pela reconciliação
 * financeira (é operacional, não Financeiro Oficial) — soma os DELTAS diários
 * já calculados por `listaDesempenhoDiario` (nunca soma acumulado sobre
 * acumulado), dentro do intervalo [inicio, fim] de cada segmento.
 * @param {Array<{data:string, deltaValorVendasBruto:number|null, deltaQtdVendas:number|null, deltaNovosClientes:number|null}>} serieDesempenho
 * @param {Array<{modelo:string, inicio:string, fim:string}>} segmentos
 * @param {Array<object>} linhasComDados linhas CRUAS com dado financeiro real (mesmo critério de `linhasComDados` acima)
 */
function operacionalPorSegmento(serieDesempenho, segmentos, linhasComDados) {
  return segmentos.map((seg) => {
    const dias = serieDesempenho.filter((p) => p.data >= seg.inicio && p.data <= seg.fim);
    const somar = (campo) => {
      const vals = dias.map((p) => p[campo]).filter((v) => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };
    const valorVendasBruto = somar("deltaValorVendasBruto");
    const qtdVendas = somar("deltaQtdVendas");
    const diasComDados = linhasComDados.filter((r) => r.data_lancamento >= seg.inicio && r.data_lancamento <= seg.fim).length;
    return {
      modelo: seg.modelo, inicio: seg.inicio, fim: seg.fim,
      valorVendasBruto, qtdVendas, novosClientes: somar("deltaNovosClientes"),
      ticketMedio: ticketMedio(valorVendasBruto, qtdVendas),
      diasComDados,
    };
  });
}

// ---------------------------------------------------------------------------
// UNIDADE-ALVO — resolve e valida a unidade da ação a partir da sessão.
// Nunca confia no que o cliente manda: quando a sessão já está presa a uma
// unidade, qualquer unidadeId diferente no corpo/query é recusado.
// ---------------------------------------------------------------------------
export async function resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica = false }) {
  if (unidadeIdSessao) {
    if (unidadeIdSolicitado && unidadeIdSolicitado !== unidadeIdSessao) {
      throw ApiError.forbidden("Você não tem acesso a esta unidade.");
    }
    return unidadeIdSessao;
  }
  if (!unidadeIdSolicitado) {
    if (exigirEspecifica) throw ApiError.badRequest("Selecione uma unidade específica para esta ação. A visão \"Todas as unidades\" é somente leitura.");
    return null; // "todas as unidades" — agregado, só leitura
  }
  const { data: unidade, error } = await supabase
    .from("unidades").select("id, organizacao_id").eq("id", unidadeIdSolicitado).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!unidade || unidade.organizacao_id !== organizacaoId) throw ApiError.forbidden("Você não tem acesso a esta unidade.");
  return unidade.id;
}

// ---------------------------------------------------------------------------
// PROJEÇÃO DE UM LANÇAMENTO PARA A API (campos + calculados)
// ---------------------------------------------------------------------------
function calculadosDoLancamento(row) {
  const totalDed = totalDeducoes({
    taxasComissoes: row.taxas_comissoes, servicosPromocoes: row.servicos_promocoes,
    taxasEntregadores: row.taxas_entregadores, ajustesContraLoja: row.ajustes_contra_loja,
  });
  const base = row.valor_vendas_ifood;
  const pctTotal = percentual(totalDed, base);
  const receita = receitaLiquida(base, totalDed, row.ajustes_favor_loja);
  return {
    ticketMedio: ticketMedio(row.valor_vendas_bruto, row.qtd_vendas),
    totalDeducoes: totalDed,
    receitaLiquida: receita,
    percentuais: {
      taxasComissoes: percentual(row.taxas_comissoes, base),
      servicosPromocoes: percentual(row.servicos_promocoes, base),
      taxasEntregadores: percentual(row.taxas_entregadores, base),
      ajustesFavorLoja: percentual(row.ajustes_favor_loja, base),
      ajustesContraLoja: percentual(row.ajustes_contra_loja, base),
      totalDeducoes: pctTotal,
      receitaLiquida: percentual(receita, base),
    },
    saldoPercentual: saldoPercentual(pctTotal),
  };
}

/** Number(x), mas preserva null/undefined em vez de virar 0 — "não informado" ≠ "zero". */
const numOuNulo = (v) => (v == null ? null : Number(v));

function paraApi(row) {
  return {
    id: row.id,
    unidadeId: row.unidade_id,
    data: row.data_lancamento,
    situacao: row.situacao,
    motivoSemOperacao: row.motivo_sem_operacao ?? null,
    observacao: row.observacao ?? null,
    origemLancamento: row.origem_lancamento ?? "diario",
    qtdVendas: row.qtd_vendas ?? null,
    valorVendasBruto: numOuNulo(row.valor_vendas_bruto),
    novosClientes: row.novos_clientes ?? null,
    valorVendasIfood: numOuNulo(row.valor_vendas_ifood),
    taxasComissoes: numOuNulo(row.taxas_comissoes),
    servicosPromocoes: numOuNulo(row.servicos_promocoes),
    taxasEntregadores: numOuNulo(row.taxas_entregadores),
    ajustesFavorLoja: numOuNulo(row.ajustes_favor_loja),
    ajustesContraLoja: numOuNulo(row.ajustes_contra_loja),
    justificativaAjuste: row.justificativa_ajuste ?? null,
    status: row.status,
    usuarioNome: row.usuario_nome ?? null,
    finalizadoEm: row.finalizado_em ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    calculado: calculadosDoLancamento(row),
  };
}

// ---------------------------------------------------------------------------
// UNIDADES VISÍVEIS
// ---------------------------------------------------------------------------
export async function listarUnidades({ organizacaoId, unidadeIdSessao }) {
  if (unidadeIdSessao) {
    const { data, error } = await supabase.from("unidades").select("id, nome, eh_teste").eq("id", unidadeIdSessao).maybeSingle();
    if (error) throw ApiError.internal(error.message);
    if (!data) throw ApiError.notFound("Unidade não encontrada.");
    return { unidades: [{ id: data.id, nome: data.nome, ehTeste: data.eh_teste }], agregadoDisponivel: false };
  }
  const { data, error } = await supabase
    .from("unidades").select("id, nome, eh_teste").eq("organizacao_id", organizacaoId).eq("ativo", true).order("nome");
  if (error) throw ApiError.internal(error.message);
  return { unidades: (data ?? []).map((u) => ({ id: u.id, nome: u.nome, ehTeste: u.eh_teste })), agregadoDisponivel: true };
}

// ---------------------------------------------------------------------------
// MODELO LOGÍSTICO DO IFOOD DE UMA UNIDADE (Marketplace x Full Service)
// Sempre exige uma unidade específica — "todas as unidades" não é um
// conceito válido pra este recurso (cada unidade tem o seu próprio modelo).
// ---------------------------------------------------------------------------
export async function obterModeloLogisticoUnidade({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, data }) {
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: true });
  const modelo = await obterModeloLogistico({ unidadeId, organizacaoId });
  if (!data) return modelo;
  // Com `data`: o modelo VIGENTE NAQUELE DIA (não o atual) — mesma regra de
  // metas.service#obterModeloLogisticoNaData, sobre a linha do tempo já carregada.
  const dia = v.dataOpcional(data, "Data");
  const vigente = modeloNaData(modelo.linhaDoTempo ?? montarLinhaDoTempo({ modeloAtual: modelo.modeloLogistico }), dia);
  return { unidadeId, data: dia, modeloLogistico: vigente, modeloLogisticoRotulo: rotuloDoModelo(vigente) };
}

export async function atualizarModeloLogisticoUnidade({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, usuario, dados: body }) {
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: true });
  const b = v.corpo(body);
  const resultado = await definirModeloLogistico({
    unidadeId, organizacaoId, modeloNovo: b.modeloLogistico, modeloAnterior: b.modeloAnterior, vigenciaInicio: b.vigenciaInicio,
    usuario, motivo: b.motivo, observacao: b.observacao,
  });
  // O modelo logístico decide, ao vivo, como cada mês é calculado — mas agora
  // POR DATA (linha do tempo de vigências, nunca só o valor atual): uma troca
  // retroativa pode mudar qualquer mês a partir da vigência. Por isso este
  // evento não carrega `competencia`: é relevante pro mês que estiver aberto
  // agora, seja qual for (ver a checagem de relevância no frontend).
  await emitirEventoRealtime({
    tipo: EVENTOS_DASHBOARD_IFOOD.MODELO_LOGISTICO_ATUALIZADO,
    organizacaoId, unidadeId, entidadeId: unidadeId, versao: new Date().toISOString(),
  });
  return resultado;
}

export async function historicoModeloLogisticoUnidade({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado }) {
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: true });
  return historicoModeloLogistico({ unidadeId, organizacaoId });
}

// ---------------------------------------------------------------------------
// CALENDÁRIO DE UM MÊS (para uma unidade específica)
// ---------------------------------------------------------------------------
async function carregarCalendarioMes({ unidadeId, ano, mes, hojeIso }) {
  const dias = diasDoMes(ano, mes);
  const inicio = dias[0];
  const fim = dias[dias.length - 1];

  // As liberações administrativas do mês (migration 068) vêm JUNTO com os
  // lançamentos, em paralelo — este é o único ponto do mundo tenant que lê
  // essa tabela, e é o mesmo ponto que já era a porta de entrada do
  // calendário. Quem chama (`obterMes`, `criarLancamento`,
  // `atualizarLancamento`, `obterLancamentoPorData`) herda a exceção sem
  // saber que ela existe.
  const [lancRes, desbloqueios] = await Promise.all([
    supabase.from(TABELA).select("*").eq("unidade_id", unidadeId)
      .gte("data_lancamento", inicio).lte("data_lancamento", fim),
    carregarDatasLiberadas({ unidadeId, desdeIso: inicio, ateIso: fim }),
  ]);
  const { data, error } = lancRes;
  if (error) throw ApiError.internal(error.message);

  const porData = new Map((data ?? []).map((r) => [r.data_lancamento, r]));
  const diasComLancamento = dias.map((data_) => ({ data: data_, lancamento: porData.get(data_) ?? null }));
  const diasComStatus = statusMes({ dias: diasComLancamento, hojeIso, desbloqueios });
  return { diasComStatus, linhas: data ?? [], desbloqueios };
}

// ---------------------------------------------------------------------------
// PENDÊNCIAS DO MÊS ANTERIOR (alerta à parte — não bloqueia o mês atual)
// ---------------------------------------------------------------------------
async function calcularPendenciasMesAnterior({ unidadeId, ano, mes, hojeIso }) {
  const anterior = mesAnterior(ano, mes);
  const { diasComStatus } = await carregarCalendarioMes({ unidadeId, ano: anterior.ano, mes: anterior.mes, hojeIso });
  const pendentes = diasComStatus.filter((d) => d.status === STATUS_DIA.PENDENTE).map((d) => d.data);
  return agruparPendenciasPorMes(pendentes);
}

// ---------------------------------------------------------------------------
// COMPARATIVO DE FATURAMENTO + PLANO DE RECUPERAÇÃO
//
// Mês em andamento: NUNCA compara o total parcial do mês atual com o total
// fechado do mês anterior (isso super/sub-estima a variação). Compara o
// MESMO recorte de dias (1..hoje) dos dois meses — "Estratégia A" do pedido.
// Mês já fechado: compara os dois totais completos, como sempre foi.
//
// Quando há queda real E o mês ainda está em andamento, monta o plano de
// recuperação: quanto falta para alcançar o faturamento do mês anterior
// (referência), quantos dias operacionais restam, e a média diária
// necessária — com cenários quando a meta integral for pouco provável.
// ---------------------------------------------------------------------------
async function calcularComparativoEPlanoRecuperacao({ unidadeId, ano, mes, hojeIso, diasComStatus, base, media }) {
  const anterior = mesAnterior(ano, mes);
  const { diasComStatus: diasAnterior } = await carregarCalendarioMes({ unidadeId, ano: anterior.ano, mes: anterior.mes, hojeIso });
  const linhasAnterior = diasAnterior.map((d) => d.lancamento).filter(Boolean);
  // Financeiro é snapshot acumulado — o total do mês anterior é o snapshot
  // mais recente DELE (nunca soma entre dias, mesmo raciocínio de
  // obterMesDeUmaUnidade/obterHistorico).
  const snapshotAnteriorCompleto = snapshotFinanceiroMaisRecente(linhasAnterior);
  const totalAnteriorCompleto = snapshotAnteriorCompleto ? Number(snapshotAnteriorCompleto.valor_vendas_ifood) : null;

  const [anoAtualNum, mesAtualNum] = hojeIso.split("-").map(Number);
  const mesEmAndamento = ano === anoAtualNum && mes === mesAtualNum;

  // Snapshot ATÉ um dia de corte (mesmo recorte 1..diaAtual nos dois meses,
  // "Estratégia A" do pedido) — troca a soma por "pega o snapshot mais
  // recente dentro do corte", a mesma regra usada em qualquer outro recorte.
  const snapshotAteODia = ({ diasComStatus: dias, anoDoMes, mesDoMes, ateODia }) => {
    const cutoff = `${anoDoMes}-${String(mesDoMes).padStart(2, "0")}-${String(ateODia).padStart(2, "0")}`;
    const linhas = dias.map((d) => d.lancamento).filter(Boolean);
    const snap = snapshotFinanceiroMaisRecente(linhas, cutoff);
    return {
      valor: snap ? Number(snap.valor_vendas_ifood) : null,
      temEstimativa: snap != null && linhas.some((r) => r.origem_lancamento === "distribuicao_mensal" && r.data_lancamento <= cutoff),
    };
  };

  let comparativo;
  if (mesEmAndamento) {
    const diaAtual = Number(hojeIso.slice(8, 10));
    const atualParcial = snapshotAteODia({ diasComStatus, anoDoMes: ano, mesDoMes: mes, ateODia: diaAtual });
    const anteriorParcial = snapshotAteODia({ diasComStatus: diasAnterior, anoDoMes: anterior.ano, mesDoMes: anterior.mes, ateODia: diaAtual });
    comparativo = (atualParcial.valor != null && anteriorParcial.valor != null && anteriorParcial.valor > 0)
      ? {
          tipo: "mesmo_periodo", diaComparado: diaAtual,
          atual: atualParcial.valor, anterior: anteriorParcial.valor,
          diferenca: atualParcial.valor - anteriorParcial.valor,
          pct: ((atualParcial.valor - anteriorParcial.valor) / anteriorParcial.valor) * 100,
          temEstimativa: atualParcial.temEstimativa || anteriorParcial.temEstimativa,
        }
      : { tipo: "indisponivel", pct: null, atual: atualParcial.valor, anterior: null, diferenca: null, diaComparado: diaAtual, temEstimativa: false };
  } else {
    comparativo = totalAnteriorCompleto != null && totalAnteriorCompleto > 0 && base != null
      ? {
          tipo: "mes_fechado", diaComparado: null,
          atual: base, anterior: totalAnteriorCompleto, diferenca: base - totalAnteriorCompleto,
          pct: ((base - totalAnteriorCompleto) / totalAnteriorCompleto) * 100,
          temEstimativa: linhasAnterior.some((r) => r.origem_lancamento === "distribuicao_mensal"),
        }
      : { tipo: "indisponivel", pct: null, atual: base ?? null, anterior: null, diferenca: null, diaComparado: null, temEstimativa: false };
  }

  let recuperacao = null;
  if (mesEmAndamento && totalAnteriorCompleto != null && totalAnteriorCompleto > 0 && base != null && base < totalAnteriorCompleto) {
    const faltante = totalAnteriorCompleto - base;
    const diasRestantes = diasComStatus.filter((d) => d.status === STATUS_DIA.FUTURO).length;
    if (diasRestantes > 0) {
      const mediaNecessaria = faltante / diasRestantes;
      const mediaBase = media ?? 0;
      const poucoProvavel = media != null && media > 0 && mediaNecessaria > media * LIMIARES_DIAGNOSTICO.recuperacaoMultiplicadorPoucoProvavel;
      recuperacao = {
        referencia: totalAnteriorCompleto, atual: base, faltante, diasRestantes,
        mediaAtual: media, mediaNecessaria, poucoProvavel,
        cenarios: {
          conservador: mediaBase,
          parcial: mediaBase * (1 + LIMIARES_DIAGNOSTICO.cenarioParcialPct / 100),
          forte: mediaBase * (1 + LIMIARES_DIAGNOSTICO.cenarioForcaPct / 100),
        },
      };
    } else {
      recuperacao = { referencia: totalAnteriorCompleto, atual: base, faltante, diasRestantes: 0, mediaAtual: media, mediaNecessaria: null, poucoProvavel: true, cenarios: null };
    }
  }

  return { comparativo, recuperacao };
}

// ---------------------------------------------------------------------------
// GET /dashboard-executivo/mes — payload agregado da página inteira
// ---------------------------------------------------------------------------
export async function obterMes({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, mes: mesRaw, ano: anoRaw, tabelaBalcao, tabelaIfood }) {
  const mes = v.numero(mesRaw, "Mês", { min: 1, max: 12 });
  const ano = v.numero(anoRaw, "Ano", { min: 2000, max: 2100 });
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: false });
  const hojeIso = hojeIsoBrasil();

  if (unidadeId) {
    // O modelo logístico é TEMPORAL: o mês é lido pelo(s) modelo(s) VIGENTE(S)
    // NAS DATAS dele (linha do tempo), nunca pelo modelo atual da unidade — um
    // mês passado em Marketplace continua Marketplace depois da troca para Full
    // Service. Resolve antes das metas, porque cada modelo tem metas diferentes
    // (ver dashboardExecutivo.calc.js). Sem troca datada há um único segmento e
    // tudo se comporta exatamente como antes.
    const modeloAtual = await obterModeloLogistico({ unidadeId, organizacaoId });
    const linhaDoTempo = modeloAtual.linhaDoTempo ?? montarLinhaDoTempo({ modeloAtual: modeloAtual.modeloLogistico });
    const diasDoPeriodo = diasDoMes(ano, mes);
    const segmentos = segmentosDoPeriodo(linhaDoTempo, diasDoPeriodo[0], diasDoPeriodo[diasDoPeriodo.length - 1]);
    const estado = estadoDoPeriodo(segmentos);
    // "misto" é só o estado derivado do período; as regras de aplicabilidade
    // seguem cada segmento (ver obterMesDeUmaUnidade).
    const modelo = { ...modeloAtual, modeloLogistico: estado.tipo, modeloLogisticoRotulo: rotuloDoModelo(estado.tipo) };
    const metasPorSegmento = await Promise.all(segmentos.map(async (s) => ({
      modelo: s.modelo, metas: await resolverMetas({ organizacaoId, unidadeId, modeloLogistico: s.modelo }),
    })));
    const precos = await carregarPrecosRentabilidade({ organizacaoId, unidadeId, tabelaBalcao, tabelaIfood });
    return obterMesDeUmaUnidade({
      organizacaoId, unidadeId, mes, ano, hojeIso, modelo, modeloAtual, precos,
      metas: estado.misto ? {} : metasPorSegmento[0].metas, metasPorSegmento, segmentos, estado, linhaDoTempo,
    });
  }

  // Visão agregada ("todas as unidades"): unidades diferentes podem estar em
  // modelos logísticos diferentes, então não existe UMA meta correta pra
  // mostrar aqui — mostrar a meta de um modelo só pra unidades no outro seria
  // um dado errado. Cards e valores continuam somados normalmente; só o
  // comparativo com meta fica indisponível nesta visão (honesto > inventado).
  return obterMesAgregado({ organizacaoId, mes, ano, hojeIso, metas: {} });
}

async function obterMesDeUmaUnidade({
  organizacaoId, unidadeId, mes, ano, hojeIso, metas: metasUnicas, metasPorSegmento, modelo, modeloAtual, precos,
  segmentos, estado, linhaDoTempo,
}) {
  const { diasComStatus, linhas } = await carregarCalendarioMes({ unidadeId, ano, mes, hojeIso });
  const resumo = resumoPreenchimento(diasComStatus);

  // PERÍODO MISTO (Marketplace + Full Service no mesmo mês): o Financeiro é
  // acumulado, então cada regime é a DIFERENÇA entre snapshots (ver
  // dashboardExecutivo.periodoMisto.js). RECONCILIAÇÃO GRANULAR (2026-09-22,
  // investigação real Subway Feiraguay — ver dashboardExecutivo.confiabilidade.js):
  // cada CAMPO de cada SEGMENTO tem seu próprio status de conciliação
  // ('conciliado'|'suspeito'|'nao_conciliavel'|'nao_aplicavel'|'sem_dado').
  // Um campo ruim (ex.: queda inesperada no acumulado de valor_vendas_ifood)
  // NUNCA apaga os outros — a indisponibilidade só se propaga pelas
  // dependências matemáticas REAIS (um percentual depende do SEU valor E do
  // faturamento do MESMO recorte; Total de Deduções em R$ não depende do
  // faturamento). `consolidado` está SEMPRE presente quando `misto` — a
  // granularidade está nos campos, não mais num "disponível" de tudo ou nada.
  const misto = estado.misto;
  const divisao = misto ? dividirFinanceiroPorSegmento(linhas, segmentos) : null;
  const consolidado = misto ? consolidarSegmentos(divisao) : null;
  // Um indicador se aplica ao período se se aplica a ALGUM regime dele
  // (Taxas de Entregadores: existe se houve Marketplace no período).
  const aplicavel = (indicador) => segmentos.some((s) => indicadorAplicavel(s.modelo, indicador));

  // "Dias com dados" = dias com valor financeiro real (PREENCHIDO ou ZERO_VENDAS).
  // SEM_OPERACAO não entra na média (loja fechada não é "um dia de vendas").
  const linhasComDados = linhas.filter((r) => {
    const status = diasComStatus.find((d) => d.data === r.data_lancamento)?.status;
    return RESOLVIDOS_COM_DADOS.has(status);
  });

  // FONTE DE VERDADE FINANCEIRA = etapa Financeiro. `valor_vendas_ifood` é o
  // faturamento; taxas/serviços/entregadores/outras são o detalhamento. A
  // etapa Desempenho (valor_vendas_bruto, qtd_vendas, novos_clientes) é
  // operacional/complementar e NUNCA alimenta faturamento, projeção,
  // comparativo ou os cards de meta — só o próprio ticket médio, que é
  // conceitualmente dela (ver dashboardExecutivo.calc.js).
  //
  // Financeiro é SNAPSHOT ACUMULADO do mês (dia 1 até a data do lançamento),
  // não um valor isolado por dia — nunca soma entre dias (somaria acumulado
  // sobre acumulado). Pega sempre o snapshot mais recente do mês inteiro
  // (`linhas`, não `linhasComDados` — nunca escondemos um snapshot já salvo
  // mesmo que o dia em si não conte como "resolvido com dados").
  const snapshot = snapshotFinanceiroMaisRecente(linhas);
  // Par (valor bruto, pedidos) pra Ticket Médio — mesma fonte única de
  // Lançamentos/Histórico (ver cards.ticketMedio, abaixo).
  const parTicketMedio = desempenhoParaTicketMedio(linhas);
  const serieDesempenho = listaDesempenhoDiario(diasComStatus.map((d) => d.data), linhas);
  const novosClientes = novosClientesAcumulados(diasComStatus.map((d) => d.data), linhas);
  // Comparativo Marketplace × Full Service (Visão Geral + Diagnóstico): combina
  // o financeiro reconciliado por segmento (`consolidado.porSegmento`) com o
  // operacional por segmento (nunca passa pela reconciliação — Ticket Médio,
  // Novos Clientes e Pedidos são conceitos operacionais, sempre calculáveis
  // independente do status do Financeiro Oficial).
  const comparativoSegmentos = misto
    ? operacionalPorSegmento(serieDesempenho, segmentos, linhasComDados).map((op, i) => {
      const fin = consolidado.porSegmento[i];
      const faturamentoSeg = fin.campos.valorVendasIfood;
      // Percentual do SEU regime (nunca a base do período inteiro) — cada
      // segmento é lido contra o próprio faturamento, igual a um mês simples.
      const pct = (registro) => {
        if (registro.status === STATUS_CONCILIACAO.NAO_APLICAVEL) return { valor: null, status: STATUS_CONCILIACAO.NAO_APLICAVEL };
        const status = piorStatus(registro.status, faturamentoSeg.status);
        return { valor: status === STATUS_CONCILIACAO.CONCILIADO ? percentual(registro.valor, faturamentoSeg.valor) : null, status };
      };
      return {
        ...op, financeiro: fin,
        percentuais: {
          taxasComissoes: pct(fin.campos.taxasComissoes), servicosPromocoes: pct(fin.campos.servicosPromocoes),
          taxasEntregadores: pct(fin.campos.taxasEntregadores), totalDeducoes: pct(fin.totalDeducoes), receitaLiquida: pct(fin.receitaLiquida),
        },
      };
    })
    : null;
  const valoresDoSnapshot = {
    valorVendasIfood: snapshot ? Number(snapshot.valor_vendas_ifood) : null,
    taxasComissoes: snapshot?.taxas_comissoes != null ? Number(snapshot.taxas_comissoes) : null,
    servicosPromocoes: snapshot?.servicos_promocoes != null ? Number(snapshot.servicos_promocoes) : null,
    taxasEntregadores: snapshot?.taxas_entregadores != null ? Number(snapshot.taxas_entregadores) : null,
    ajustesFavorLoja: snapshot?.ajustes_favor_loja != null ? Number(snapshot.ajustes_favor_loja) : null,
    ajustesContraLoja: snapshot?.ajustes_contra_loja != null ? Number(snapshot.ajustes_contra_loja) : null,
  };
  // RECONCILIAÇÃO GRANULAR — um registro {valor, status, ultimoValorValido}
  // por campo financeiro. Fora do período misto, o snapshot é tratado como
  // fato (comportamento idêntico ao anterior — regressão zero); só falta
  // status quando o campo nunca foi informado ('sem_dado').
  const registroSimples = (valor) => ({
    valor, status: valor == null ? STATUS_CONCILIACAO.SEM_DADO : STATUS_CONCILIACAO.CONCILIADO, ultimoValorValido: null,
  });
  const campoFinanceiro = (campoCamel) => (misto ? consolidado.campos[campoCamel] : registroSimples(valoresDoSnapshot[campoCamel]));

  const cardValores = {
    valorVendasIfood: campoFinanceiro("valorVendasIfood").valor,
    taxasComissoes: campoFinanceiro("taxasComissoes").valor,
    servicosPromocoes: campoFinanceiro("servicosPromocoes").valor,
    taxasEntregadores: campoFinanceiro("taxasEntregadores").valor,
    ajustesFavorLoja: campoFinanceiro("ajustesFavorLoja").valor,
    ajustesContraLoja: campoFinanceiro("ajustesContraLoja").valor,
  };
  const base = cardValores.valorVendasIfood;
  // Denominador do % de Entregadores: faturamento dos regimes onde ele existe
  // (no mês simples é o próprio faturamento — nada muda).
  const baseEntregadores = misto ? consolidado.baseEntregadores.valor : base;
  const statusBaseEntregadores = misto ? consolidado.baseEntregadores.status : campoFinanceiro("valorVendasIfood").status;

  // Total FINANCEIRO ("caixa real": inclusive entregadores e ajustes contra a
  // loja) e Receita Líquida — no mês simples, igual a sempre (raw snapshot);
  // em período misto já vêm reconciliados de `consolidarSegmentos` (nunca
  // soma um regime não confiável por baixo — ver periodoMisto.js).
  const receitaLiquidaValor = !misto
    ? receitaLiquida(base, totalDeducoes({
      taxasComissoes: valoresDoSnapshot.taxasComissoes, servicosPromocoes: valoresDoSnapshot.servicosPromocoes,
      taxasEntregadores: valoresDoSnapshot.taxasEntregadores, ajustesContraLoja: valoresDoSnapshot.ajustesContraLoja,
    }), valoresDoSnapshot.ajustesFavorLoja)
    : consolidado.receitaLiquida.valor;
  // Total do INDICADOR "Total de Deduções" — recalculado SEMPRE pelas parcelas
  // de dedução APLICÁVEIS ao modelo (Marketplace inclui entregadores; Full
  // Service não). Fonte única: calc.js#totalDeducoesIndicador. É este o número
  // da tabela de Indicadores de Rentabilidade, do card e do saldo/Disponível —
  // nunca o total financeiro acima, nunca um valor legado. Em período misto é
  // a SOMA em reais dos segmentos, cada um com as parcelas do SEU modelo
  // (consolidarSegmentos) — granular: um componente suspeito num segmento
  // não apaga o total do outro segmento nem os demais indicadores.
  const totalDed = !misto
    ? totalDeducoesIndicador(modelo.modeloLogistico, {
      taxas_comissoes: cardValores.taxasComissoes,
      servicos_promocoes: cardValores.servicosPromocoes,
      taxas_entregadores: cardValores.taxasEntregadores,
    })
    : consolidado.totalDeducoes.valor;
  const statusTotalDed = misto ? consolidado.totalDeducoes.status : registroSimples(totalDed).status;

  // Um PERCENTUAL só existe quando o SEU campo E a base/faturamento do MESMO
  // recorte estão conciliados — a única propagação de indisponibilidade é
  // essa dependência matemática real (nunca "o mês tem 2 modelos, então
  // nada"). `percentual()` já devolve null se faltar valor/base; o `status`
  // aqui só GARANTE que um valor "de contexto" (ultimoValorValido, nunca
  // oficial) não vaze pra dentro de uma meta/diagnóstico.
  const statusPercentual = (campoCamel, statusBaseIndicador) => piorStatus(campoFinanceiro(campoCamel).status, statusBaseIndicador);
  const percentualConciliado = (campoCamel, statusBaseIndicador) =>
    (statusPercentual(campoCamel, statusBaseIndicador) === STATUS_CONCILIACAO.CONCILIADO ? percentual(cardValores[campoCamel], base) : null);

  const indicadoresRentabilidade = {
    taxas_comissoes: percentualConciliado("taxasComissoes", campoFinanceiro("valorVendasIfood").status),
    servicos_promocoes: percentualConciliado("servicosPromocoes", campoFinanceiro("valorVendasIfood").status),
    taxas_entregadores: piorStatus(campoFinanceiro("taxasEntregadores").status, statusBaseEntregadores) === STATUS_CONCILIACAO.CONCILIADO
      ? percentual(cardValores.taxasEntregadores, baseEntregadores) : null,
    total_deducoes: piorStatus(statusTotalDed, campoFinanceiro("valorVendasIfood").status) === STATUS_CONCILIACAO.CONCILIADO
      ? percentual(totalDed, base) : null,
  };
  // PROTEÇÃO DA PRECIFICAÇÃO — conceito exclusivo do Simulador de Preço.
  // Calculada só a partir dos preços das tabelas; NÃO toca `metas` nem os 4
  // indicadores logísticos abaixo.
  const protecaoPrecificacao = {
    ...calcularProtecaoPrecificacao({
      precoBalcao: precos.balcao.preco, precoIfood: precos.ifood.preco,
      ticketMedioIfood: ticketMedio(parTicketMedio?.valorVendasBruto ?? null, parTicketMedio?.qtdVendas ?? null),
    }),
    precos,
    // Partes brutas do Ticket Médio (valor de vendas ÷ pedidos) — para a UI
    // explicar a diferença de arredondamento sem refazer a conta.
    ticketMedioBase: parTicketMedio
      ? { valorVendasBruto: parTicketMedio.valorVendasBruto, qtdVendas: parTicketMedio.qtdVendas }
      : null,
    comparacao: calcularComparacaoProduto(precos, {
      taxasComissoesPct: indicadoresRentabilidade.taxas_comissoes,
      servicosPromocoesPct: indicadoresRentabilidade.servicos_promocoes,
    }),
  };
  // META IDEAL de Serviços e Promoções e de Total de Deduções acompanha a
  // Proteção da Precificação — Full Service E Marketplace, cada um com sua
  // reserva (ver metasComProtecaoPrecificacao). `metasRentabilidade` alimenta
  // a TABELA de Indicadores e os 4 cards de rentabilidade da Visão Geral;
  // saldos/Disponível/barras, Plano de Ação e Agente seguem `metas` original.
  const pctProtecao = protecaoPrecificacao.protecaoPrecificacaoPct;
  const nomesIndicadores = Object.keys(indicadoresRentabilidade);
  let metas = metasUnicas;
  let derivada;
  // Metas DERIVADAS por segmento (proteção da precificação já aplicada) —
  // hoisted pra fora do `else` porque o Diagnóstico por regime (Plano de Ação
  // segmentado, ver `indicadoresPorSegmento` abaixo) reusa exatamente estas,
  // nunca recalcula.
  let metasDerivadasPorSegmento = null;
  if (!misto) {
    derivada = metasComProtecaoPrecificacao(metas, pctProtecao, modelo.modeloLogistico);
  } else {
    // Meta composta do período misto: cada regime com a SUA meta, ponderada pelo
    // faturamento do regime (dashboardExecutivo.periodoMisto.js#comporMetas) —
    // só quando o faturamento (peso) de TODOS os regimes elegíveis está
    // CONCILIADO (nunca um peso inventado a partir de um valor suspeito). Um
    // indicador cujo peso falhou fica sem meta composta — mas isso NÃO afeta
    // os demais indicadores nem os outros campos do período (granular).
    const pesos = divisao.segmentos.map((s) => s.campos.valorVendasIfood);
    const parte = (m, i, metasDoRegime) => ({
      modelo: m.modelo, peso: pesos[i].valorOficial, pesoConciliado: pesos[i].status === STATUS_CONCILIACAO.CONCILIADO, metas: metasDoRegime,
    });
    metas = comporMetas(metasPorSegmento.map((m, i) => parte(m, i, m.metas)), nomesIndicadores);
    metasDerivadasPorSegmento = metasPorSegmento.map((m) => metasComProtecaoPrecificacao(m.metas, pctProtecao, m.modelo));
    derivada = {
      metas: comporMetas(metasDerivadasPorSegmento.map((d, i) => parte(metasPorSegmento[i], i, d.metas)), nomesIndicadores),
      protecaoInsuficiente: metasDerivadasPorSegmento.some((d) => d.protecaoInsuficiente),
      metaServicosAcimaDoLimite: metasDerivadasPorSegmento.some((d) => d.metaServicosAcimaDoLimite),
    };
  }
  const metasRentabilidade = derivada.metas;
  protecaoPrecificacao.protecaoInsuficiente = derivada.protecaoInsuficiente;
  protecaoPrecificacao.metaServicosAcimaDoLimite = derivada.metaServicosAcimaDoLimite;
  const saldos = {
    taxas_comissoes: saldoMeta({ valorUtilizado: cardValores.taxasComissoes, percentualUtilizado: indicadoresRentabilidade.taxas_comissoes, limitePct: metas.taxas_comissoes?.limite ?? null, faturamentoBase: base }),
    servicos_promocoes: saldoMeta({ valorUtilizado: cardValores.servicosPromocoes, percentualUtilizado: indicadoresRentabilidade.servicos_promocoes, limitePct: metas.servicos_promocoes?.limite ?? null, faturamentoBase: base }),
    taxas_entregadores: saldoMeta({ valorUtilizado: cardValores.taxasEntregadores, percentualUtilizado: indicadoresRentabilidade.taxas_entregadores, limitePct: metas.taxas_entregadores?.limite ?? null, faturamentoBase: baseEntregadores }),
    total_deducoes: saldoMeta({ valorUtilizado: totalDed, percentualUtilizado: indicadoresRentabilidade.total_deducoes, limitePct: metas.total_deducoes?.limite ?? null, faturamentoBase: base }),
  };

  const cards = {
    // Antes chamado "vendasBrutas" e alimentado pela etapa Desempenho — era
    // exatamente o bug relatado: o card financeiro principal usando o dado
    // errado. Agora é o faturamento real do Financeiro — o snapshot
    // acumulado mais recente do mês, com o período que ele cobre.
    faturamento: {
      valor: base,
      periodoInicio: snapshot ? `${ano}-${String(mes).padStart(2, "0")}-01` : null,
      periodoFim: snapshot?.data_lancamento ?? null,
      dataAtualizacao: snapshot?.data_lancamento ?? null,
    },
    // Os 4 cards de rentabilidade usam a MESMA semântica visual da tabela de
    // Indicadores: metaIdeal derivada (Full Service) + statusIndicadorRentabilidade
    // (Meta Ideal não gera alerta; Atenção só acima do limite). Plano de Ação,
    // Diagnóstico e Agente seguem `statusIndicador` sobre `metas` (não `metasRentabilidade`).
    taxasComissoes: { valor: cardValores.taxasComissoes, percentual: indicadoresRentabilidade.taxas_comissoes, meta: metasRentabilidade.taxas_comissoes ?? null, saldo: saldos.taxas_comissoes, status: statusIndicadorRentabilidade(indicadoresRentabilidade.taxas_comissoes, metasRentabilidade.taxas_comissoes) },
    servicosPromocoes: { valor: cardValores.servicosPromocoes, percentual: indicadoresRentabilidade.servicos_promocoes, meta: metasRentabilidade.servicos_promocoes ?? null, saldo: saldos.servicos_promocoes, status: statusIndicadorRentabilidade(indicadoresRentabilidade.servicos_promocoes, metasRentabilidade.servicos_promocoes) },
    // Faltavam na Visão Geral (só entravam somados dentro de totalDeducoes,
    // sem card próprio) — quem conferia a conta de cabeça via só os 2 cards
    // acima não batia com o Total de Deduções. Taxas de Entregadores só se
    // aplica ao modelo Marketplace (Full Service não usa entregadores
    // próprios do iFood) — `naoAplicavel` some com o card inteiro nesse
    // caso (mesma regra de INDICADORES_POR_MODELO já usada no diagnóstico,
    // não "sem dados": o indicador não existe pra esse modelo, ponto).
    // Ajustes a favor / contra a loja são PURAMENTE INFORMATIVOS — só valor e
    // % das vendas, sem meta/status/pill/barra. "Ajustes a favor" (crédito)
    // não entra no Total de Deduções e aumenta a Receita líquida; "Ajustes
    // contra" (débito) entra no Total de Deduções (ver calc.js#totalDeducoes /
    // #receitaLiquida). Nenhum dos dois gera "dentro/fora da meta".
    taxasEntregadores: { valor: cardValores.taxasEntregadores, percentual: indicadoresRentabilidade.taxas_entregadores, meta: metasRentabilidade.taxas_entregadores ?? null, saldo: saldos.taxas_entregadores, status: statusIndicadorRentabilidade(indicadoresRentabilidade.taxas_entregadores, metasRentabilidade.taxas_entregadores), naoAplicavel: !aplicavel("taxas_entregadores") },
    ajustesFavor: { valor: cardValores.ajustesFavorLoja, percentual: percentual(cardValores.ajustesFavorLoja, base) },
    ajustesContra: { valor: cardValores.ajustesContraLoja, percentual: percentual(cardValores.ajustesContraLoja, base) },
    totalDeducoes: { valor: totalDed, percentual: indicadoresRentabilidade.total_deducoes, meta: metasRentabilidade.total_deducoes ?? null, saldo: saldos.total_deducoes, status: statusIndicadorRentabilidade(indicadoresRentabilidade.total_deducoes, metasRentabilidade.total_deducoes) },
    receitaLiquida: { valor: receitaLiquidaValor, percentual: percentual(receitaLiquidaValor, base) },
    // Ticket médio (Desempenho) — indicador OPERACIONAL, nunca deriva do
    // Financeiro. Usa o par mais confiável do mês inteiro (diário real
    // acumulado, ou soma das fatias do Lançamento Mensal quando não há
    // nenhum lançamento diário real — ver dashboardExecutivo.calc.js#
    // desempenhoParaTicketMedio), nunca um dia isolado.
    ticketMedio: { valor: ticketMedio(parTicketMedio?.valorVendasBruto ?? null, parTicketMedio?.qtdVendas ?? null) },
    // Mesmo acumulado exibido em Desempenho; indicador informativo, sem
    // meta, status, saldo ou barra.
    novosClientes: { valor: novosClientes },
  };

  // Projeção: o snapshot já É o acumulado de dia 1 até `data_lancamento` —
  // a média diária é esse total dividido pelos dias que ele cobre (não uma
  // média dos "dias com dados", que hoje em dia normalmente é só 1).
  // Multiplicador da projeção = todos os dias do mês (sem calendário
  // operacional configurável ainda — ver migration 023).
  const diasNoSnapshot = snapshot ? Number(snapshot.data_lancamento.slice(8, 10)) : 0;
  const media = snapshot && diasNoSnapshot > 0 ? Number(snapshot.valor_vendas_ifood) / diasNoSnapshot : null;
  const projecao = projecaoMensal(media, diasComStatus.length);
  // "Vencido" = até ONTEM, nunca hoje — hoje é sempre "em andamento", não
  // "atrasado" (mesma regra de elegibilidade do Financeiro: só se sabe o
  // fechamento completo de um dia no dia seguinte). Sem isso, o dia atual
  // sem lançamento contava como pendência todo santo dia, mesmo o mês
  // inteiro regularizado até ontem — derrubando a confiabilidade da
  // projeção pra "baixa" permanentemente e mandando "regularizar hoje" no
  // Plano de Ação, um alvo que muda de dia em dia e nunca se resolve de
  // verdade (ver mesmo raciocínio em diasPendentesDatas, abaixo).
  const dataLimiteVencido = diaAnterior(hojeIso);
  const diasVencidos = diasComStatus.filter((d) => d.data <= dataLimiteVencido).length;
  const confiabilidade = confiabilidadeProjecao({
    diasVencidos, diasResolvidos: resumo.diasPreenchidos, diasComDados: linhasComDados.length,
  });

  // Comparativo com o período de referência — trata mês em andamento com
  // cuidado (não compara um mês parcial com um mês fechado inteiro) e, se
  // houver queda real, monta o plano de recuperação. Ver função abaixo.
  const { comparativo, recuperacao } = await calcularComparativoEPlanoRecuperacao({
    unidadeId, ano, mes, hojeIso, diasComStatus, base, media,
  });

  const diasEstimados = linhas.filter((r) => r.origem_lancamento === "distribuicao_mensal").length;
  // O Plano de Ação nunca manda "regularizar hoje" — hoje ainda está em
  // andamento (mesma regra de dataLimiteVencido acima). Sem isso, todo dia
  // 12 pedia pra regularizar o dia 12, e no dia 13 pediria pra regularizar
  // o dia 13, um alvo que nunca fecha (é exatamente o ciclo descrito no
  // pedido). Dias ANTERIORES de verdade continuam cobrados normalmente.
  const diasPendentesDatas = diasComStatus
    .filter((d) => (d.status === STATUS_DIA.PENDENTE || d.status === STATUS_DIA.BLOQUEADO) && d.data <= dataLimiteVencido)
    .map((d) => d.data);

  const indicadoresParaDiagnostico = {
    taxas_comissoes: { atual: null, valor: cardValores.taxasComissoes, meta: metas.taxas_comissoes ?? null, saldo: saldos.taxas_comissoes, naoAplicavel: !aplicavel("taxas_comissoes") },
    servicos_promocoes: { atual: null, valor: cardValores.servicosPromocoes, meta: metas.servicos_promocoes ?? null, saldo: saldos.servicos_promocoes, naoAplicavel: !aplicavel("servicos_promocoes") },
    taxas_entregadores: { atual: null, valor: cardValores.taxasEntregadores, meta: metas.taxas_entregadores ?? null, saldo: saldos.taxas_entregadores, naoAplicavel: !aplicavel("taxas_entregadores") },
    total_deducoes: { atual: null, valor: totalDed, meta: metas.total_deducoes ?? null, saldo: saldos.total_deducoes, naoAplicavel: !aplicavel("total_deducoes") },
  };
  for (const [k, v] of Object.entries(indicadoresRentabilidade)) {
    indicadoresParaDiagnostico[k].atual = indicadoresParaDiagnostico[k].naoAplicavel ? null : v;
  }

  // INDICADORES POR SEGMENTO (Plano de Ação segmentado — item do pedido: um
  // problema que existe SÓ no Full Service não pode virar uma recomendação
  // genérica do mês inteiro). Reusa `comparativoSegmentos` (percentuais já
  // reconciliados por regime) e `metasDerivadasPorSegmento` (proteção da
  // precificação já aplicada por regime, calculada acima) — nenhuma fórmula
  // nova, só reempacota pro formato que `gerarDiagnostico` já entende.
  const CAMPO_DO_INDICADOR = { taxas_comissoes: "taxasComissoes", servicos_promocoes: "servicosPromocoes", taxas_entregadores: "taxasEntregadores", total_deducoes: "totalDeducoes" };
  const indicadoresPorSegmento = misto && comparativoSegmentos ? comparativoSegmentos.map((seg, i) => {
    const metasSeg = metasDerivadasPorSegmento?.[i]?.metas ?? {};
    const faturamentoSeg = seg.financeiro.campos.valorVendasIfood.valor;
    const indicadores = {};
    for (const [chave, campoCamel] of Object.entries(CAMPO_DO_INDICADOR)) {
      const pct = seg.percentuais[campoCamel];
      const valorAbs = campoCamel === "totalDeducoes" ? seg.financeiro.totalDeducoes.valor : seg.financeiro.campos[campoCamel].valor;
      const naoAplicavel = pct.status === STATUS_CONCILIACAO.NAO_APLICAVEL;
      const meta = metasSeg[chave] ?? null;
      indicadores[chave] = {
        atual: naoAplicavel ? null : pct.valor, valor: valorAbs, meta, naoAplicavel,
        saldo: naoAplicavel ? null : saldoMeta({ valorUtilizado: valorAbs, percentualUtilizado: pct.valor, limitePct: meta?.limite ?? null, faturamentoBase: faturamentoSeg }),
      };
    }
    return {
      modelo: seg.modelo, rotulo: rotuloDoModelo(seg.modelo), inicio: seg.inicio, fim: seg.fim, diasComDados: seg.diasComDados,
      faturamentoBase: faturamentoSeg, indicadores,
    };
  }) : null;

  // DIVERGÊNCIA DE TRANSIÇÃO (item do pedido, investigação real Subway
  // Feiraguay): compara quando um componente exclusivo de um modelo (Taxas
  // de Entregadores, só Marketplace) parou de acumular contra a data
  // ADMINISTRATIVA da troca — só no caso comum de UMA troca no período (2
  // segmentos); NUNCA altera a vigência sozinho, só sinaliza (ver
  // dashboardExecutivo.confiabilidade.js#detectarDivergenciaTransicao).
  const divergenciaTransicao = misto && divisao.fonte === "snapshot" && segmentos.length === 2
    ? (() => {
      const seqEntregadores = caminharSequenciaAcumulada(linhas, "taxas_entregadores");
      const d = detectarDivergenciaTransicao(seqEntregadores, segmentos[1].inicio, segmentos[0].fim);
      return d.divergente ? { ...d, vigenciaInicio: segmentos[1].inicio } : null;
    })()
    : null;

  const diagnosticoNovo = gerarDiagnostico({
    indicadores: indicadoresParaDiagnostico,
    faturamentoBase: base,
    diasComDados: linhasComDados.length,
    // Deriva do MESMO array filtrado (nunca de resumo.diasPendentes, que
    // inclui hoje) — a contagem no texto do achado precisa bater exatamente
    // com as datas listadas.
    diasPendentes: diasPendentesDatas.length,
    diasPendentesDatas,
    diasEstimados,
    comparativo,
    recuperacao,
    divergenciaTransicao,
    indicadoresPorSegmento,
    comparativoSegmentos,
  });

  const pendenciasMesesAnteriores = await calcularPendenciasMesAnterior({ unidadeId, ano, mes, hojeIso });

  // Resumo do lançamento mensal deste mês (se existir) — alimenta a faixa
  // discreta no topo da aba Lançamentos (item 6 do pedido). Reaproveita as
  // `linhas` já carregadas por carregarCalendarioMes acima: nenhuma consulta
  // extra além de buscar o lote em si.
  const loteMensal = await buscarLoteMensalDoMes({ unidadeId, ano, mes });
  const linhasDoLote = loteMensal ? linhas.filter((r) => r.distribuicao_mensal_id === loteMensal.id) : [];
  // Aplicabilidade dos campos do lote pelos modelos vigentes nos DIAS que ele cobre.
  const lancamentoMensal = montarResumoLoteMensal(
    loteMensal, linhasDoLote,
    modelosDasDatas(linhaDoTempo, linhasDoLote.map((r) => r.data_lancamento), estado.modelos),
  );

  return {
    protecaoPrecificacao,
    agregado: false,
    unidadeId,
    ehTeste: modelo.ehTeste,
    // Modelo do PERÍODO consultado ('marketplace' | 'full_service', ou 'misto' —
    // estado derivado, nunca persistido). O modelo de HOJE vai em `modeloAtual`.
    modeloLogistico: modelo.modeloLogistico,
    modeloLogisticoRotulo: modelo.modeloLogisticoRotulo,
    modeloAtual: {
      modeloLogistico: modeloAtual.modeloLogistico, modeloLogisticoRotulo: modeloAtual.modeloLogisticoRotulo,
      // já existe alguma troca datada? (define se ainda dá para declarar "desde quando o modelo atual vale")
      possuiTrocaDatada: linhaDoTempo.length > 1,
    },
    modeloPeriodo: descreverPeriodo({
      estado, segmentos, linhaDoTempo,
      resumoConciliacao: misto ? resumirConciliacao(consolidado) : null,
      fonteConciliacao: misto ? divisao.fonte : null,
      conciliacao: misto ? { segmentos: divisao.segmentos, consolidado } : null,
    }),
    // Comparativo Marketplace × Full Service — financeiro reconciliado +
    // operacional, por segmento (`null` fora do período misto). Ver
    // `operacionalPorSegmento` acima e `dashboardExecutivo.periodoMisto.js#porSegmento`.
    comparativoSegmentos,
    // Indicadores (atual/meta/limite/saldo) POR SEGMENTO — mesma forma de
    // `indicadoresRentabilidade`, um objeto por regime. Alimenta o
    // detalhamento por regime na aba Indicadores (drawer/expansão) — nunca
    // recalculado no frontend, é exatamente o que o Plano de Ação segmentado usa.
    indicadoresPorSegmento,
    periodo: { mes, ano },
    resumoPreenchimento: resumo,
    calendario: diasComStatus,
    pendenciasMesesAnteriores,
    lancamentoMensal,
    cards,
    // TABELA de Indicadores de Rentabilidade: metaIdeal derivada (Full Service) +
    // classificador de status PRÓPRIO desta apresentação (Meta Ideal não gera
    // alerta; Atenção só acima do limite; sem estado "Crítico" aqui).
    indicadoresRentabilidade: Object.fromEntries(
      Object.entries(indicadoresRentabilidade).map(([k, atualBruto]) => {
        const ehAplicavel = aplicavel(k);
        const atual = ehAplicavel ? atualBruto : null;
        const valorUtilizado = { taxas_comissoes: cardValores.taxasComissoes, servicos_promocoes: cardValores.servicosPromocoes, taxas_entregadores: cardValores.taxasEntregadores, total_deducoes: totalDed }[k] ?? null;
        return [k, {
          atual, metaIdeal: metasRentabilidade[k]?.metaIdeal ?? null, limite: metasRentabilidade[k]?.limite ?? null,
          naoAplicavel: !ehAplicavel,
          status: ehAplicavel ? statusIndicadorRentabilidade(atual, metasRentabilidade[k]) : null,
          saldo: ehAplicavel ? saldoMeta({ valorUtilizado, percentualUtilizado: atual, limitePct: metasRentabilidade[k]?.limite ?? null, faturamentoBase: k === "taxas_entregadores" ? baseEntregadores : base }) : null,
        }];
      }),
    ),
    graficos: {
      comparativoPercentuais: Object.entries(indicadoresRentabilidade)
        .filter(([indicador]) => aplicavel(indicador))
        .map(([indicador, atual]) => ({
          indicador, atual, metaIdeal: metasRentabilidade[indicador]?.metaIdeal ?? null, limite: metasRentabilidade[indicador]?.limite ?? null,
        })),
      composicaoDeducoes: [
        { indicador: "taxas_comissoes", valor: cardValores.taxasComissoes },
        { indicador: "servicos_promocoes", valor: cardValores.servicosPromocoes },
        { indicador: "taxas_entregadores", valor: cardValores.taxasEntregadores },
        // Só o ajuste CONTRA a loja compõe as deduções — o ajuste a favor é crédito.
        { indicador: "ajustes_contra_loja", valor: cardValores.ajustesContraLoja },
      ],
    },
    // Desempenho é acompanhamento OPERACIONAL — e agora ACUMULADO do mês,
    // mesma lógica do Financeiro (cada dia guarda o total até ali; o
    // "quanto esse dia fez sozinho" é sempre derivado por subtração, nunca
    // a fonte — ver listaDesempenhoDiario em calc.js). NUNCA é fonte de
    // verdade financeira: nenhum card, meta, projeção ou diagnóstico usa
    // isto — só o Financeiro (`cards.faturamento`) faz isso.
    desempenhoOperacional: (() => {
      const serie = serieDesempenho;
      // "valor" é o que o gráfico "Evolução diária" plota — o delta (dia
      // sozinho), não o acumulado bruto (que sempre sobe e mentiria
      // visualmente sobre o dia ter vendido mais que o mês inteiro).
      const evolucaoDiaria = diasComStatus.map((d, i) => ({
        data: d.data, status: d.status,
        valor: serie[i].deltaValorVendasBruto,
        deltaQtdVendas: serie[i].deltaQtdVendas,
        deltaNovosClientes: serie[i].deltaNovosClientes,
        acumuladoValorVendasBruto: serie[i].valorVendasBruto,
      }));
      const ultimaComDado = [...serie].reverse().find((p) => p.valorVendasBruto != null) ?? null;
      const diasNoAcumulado = ultimaComDado ? Number(ultimaComDado.data.slice(8, 10)) : 0;
      return {
        evolucaoDiaria,
        // Acumulado = o valor mais recente conhecido, NUNCA soma entre dias
        // (somaria acumulado sobre acumulado — mesmo raciocínio do Financeiro).
        acumulado: ultimaComDado?.valorVendasBruto ?? null,
        acumuladoQtdVendas: ultimaComDado?.qtdVendas ?? null,
        acumuladoNovosClientes: novosClientes,
        dataAtualizacao: ultimaComDado?.data ?? null,
        mediaDiaria: ultimaComDado != null && diasNoAcumulado > 0 ? ultimaComDado.valorVendasBruto / diasNoAcumulado : null,
        aviso: "Acompanhamento operacional — não representa o faturamento financeiro oficial.",
      };
    })(),
    // Série do mês pra visualizar a evolução dos SNAPSHOTS reais do
    // Financeiro (não confundir com faturamento diário — cada ponto é o
    // acumulado até aquela data). `cards.faturamento` continua sendo a
    // fonte oficial; isto é só a série pro gráfico "Evolução do Financeiro
    // acumulado" (nunca interpola entre pontos — ver listaSnapshotsFinanceiros).
    snapshotsFinanceiros: listaSnapshotsFinanceiros(diasComStatus.map((d) => d.data), linhas),
    projecao: {
      mediaDiaria: media, diasConsiderados: linhasComDados.length, diasResolvidos: resumo.diasPreenchidos,
      diasPendentes: resumo.diasPendentes, diasPrevistos: diasComStatus.length, projecaoMensal: projecao,
      confiabilidade: confiabilidade.nivel, justificativa: confiabilidade.justificativa,
      parcial: resumo.diasPendentes > 0,
    },
    diagnostico: diagnosticoNovo,
  };
}

async function obterMesAgregado({ organizacaoId, mes, ano, hojeIso, metas }) {
  const dias = diasDoMes(ano, mes);
  const { data, error } = await supabase
    .from(TABELA).select("*").eq("organizacao_id", organizacaoId)
    .gte("data_lancamento", dias[0]).lte("data_lancamento", dias[dias.length - 1]);
  if (error) throw ApiError.internal(error.message);

  const linhas = (data ?? []).filter((r) => r.status === "finalizado" || r.status === "rascunho"); // inclui rascunho na visão agregada (é leitura)

  // Financeiro é snapshot acumulado POR UNIDADE — nunca soma linhas cruas
  // (mesmo bug que na visão por unidade, só que aqui multiplicado por
  // unidade). A soma correta entre unidades é: snapshot mais recente DE
  // CADA UNIDADE, somados entre si (unidades são independentes uma da
  // outra — isso sim é aditivo).
  const linhasPorUnidade = new Map();
  for (const r of linhas) {
    if (!linhasPorUnidade.has(r.unidade_id)) linhasPorUnidade.set(r.unidade_id, []);
    linhasPorUnidade.get(r.unidade_id).push(r);
  }
  const snapshotsPorUnidade = [...linhasPorUnidade.values()]
    .map((linhasDaUnidade) => snapshotFinanceiroMaisRecente(linhasDaUnidade))
    .filter(Boolean);
  // Taxas de Entregadores só se aplica ao modelo Marketplace — na visão
  // agregada, unidades diferentes podem estar em modelos diferentes, então
  // só escondemos o card quando NENHUMA unidade com dado no mês é
  // Marketplace (card genuinamente vazio pra todo mundo). Se pelo menos uma
  // for Marketplace, o card fica (é relevante pra ela, mesmo que outras
  // unidades não o usem).
  const idsUnidadesComDado = [...linhasPorUnidade.keys()];
  const { data: unidadesComDado, error: erroUnidades } = idsUnidadesComDado.length
    ? await supabase.from("unidades").select("id, modelo_logistico_ifood").in("id", idsUnidadesComDado)
    : { data: [], error: null };
  if (erroUnidades) throw ApiError.internal(erroUnidades.message);
  // O modelo é lido NO MÊS consultado (linha do tempo de vigências), não o atual:
  // uma unidade que era Marketplace naquele mês continua contando como
  // Marketplace mesmo depois de virar Full Service. Sem a migration 089 (ou sem
  // troca datada) cai no modelo atual — comportamento anterior.
  const trocasPorUnidade = new Map();
  if (idsUnidadesComDado.length) {
    const { data: trocasRows, error: erroTrocas } = await supabase
      .from("unidade_modelo_logistico_historico")
      .select("unidade_id, vigencia_inicio, modelo_anterior, modelo_novo")
      .in("unidade_id", idsUnidadesComDado).not("vigencia_inicio", "is", null);
    if (!erroTrocas) {
      for (const r of trocasRows ?? []) {
        if (!trocasPorUnidade.has(r.unidade_id)) trocasPorUnidade.set(r.unidade_id, []);
        trocasPorUnidade.get(r.unidade_id).push(r);
      }
    }
  }
  const temMarketplaceNoMes = (u) => segmentosDoPeriodo(
    montarLinhaDoTempo({ modeloAtual: u.modelo_logistico_ifood, trocas: trocasDeLinhas(trocasPorUnidade.get(u.id)) }),
    dias[0], dias[dias.length - 1],
  ).some((s) => indicadorAplicavel(s.modelo, "taxas_entregadores"));
  const taxasEntregadoresNaoAplicavel = idsUnidadesComDado.length > 0
    && !(unidadesComDado ?? []).some(temMarketplaceNoMes);
  // Ticket médio agregado = soma dos totais (valor bruto e pedidos) do par
  // mais confiável DE CADA UNIDADE, dividida no fim — nunca a média dos
  // tickets médios de cada unidade (mesmo raciocínio de "soma dos totais,
  // não média de médias" usado pro Financeiro acima).
  const paresTicketPorUnidade = [...linhasPorUnidade.values()]
    .map((linhasDaUnidade) => desempenhoParaTicketMedio(linhasDaUnidade))
    .filter(Boolean);
  const somarPares = (campo) => (paresTicketPorUnidade.length
    ? paresTicketPorUnidade.reduce((s, p) => s + p[campo], 0) : null);
  const ticketMedioAgregado = ticketMedio(somarPares("valorVendasBruto"), somarPares("qtdVendas"));
  // Preserva a semântica já usada por Desempenho: pega o último acumulado
  // conhecido de cada unidade pela série central e só então soma entre
  // unidades. Não tenta deduplicar clientes entre lojas.
  const novosClientesPorUnidade = [...linhasPorUnidade.values()]
    .map((linhasDaUnidade) => novosClientesAcumulados(dias, linhasDaUnidade))
    .filter((valor) => valor != null);
  const novosClientesAgregado = novosClientesPorUnidade.length
    ? novosClientesPorUnidade.reduce((s, valor) => s + Number(valor), 0)
    : null;
  const somaEntreUnidades = (campo) => {
    const valoresCampo = snapshotsPorUnidade.map((s) => s[campo]).filter((v) => v != null);
    return valoresCampo.length ? valoresCampo.reduce((s, v) => s + Number(v), 0) : null;
  };
  const valores = {
    valorVendasIfood: somaEntreUnidades("valor_vendas_ifood"),
    taxasComissoes: somaEntreUnidades("taxas_comissoes"),
    servicosPromocoes: somaEntreUnidades("servicos_promocoes"),
    taxasEntregadores: somaEntreUnidades("taxas_entregadores"),
    ajustesFavorLoja: somaEntreUnidades("ajustes_favor_loja"),
    ajustesContraLoja: somaEntreUnidades("ajustes_contra_loja"),
  };
  // Total FINANCEIRO (todas as saídas + ajustes) — só pra Receita Líquida.
  const totalDedFinanceiro = totalDeducoes({
    taxasComissoes: valores.taxasComissoes, servicosPromocoes: valores.servicosPromocoes,
    taxasEntregadores: valores.taxasEntregadores, ajustesContraLoja: valores.ajustesContraLoja,
  });
  const base = valores.valorVendasIfood;
  const receitaLiquidaValor = base != null ? receitaLiquida(base, totalDedFinanceiro, valores.ajustesFavorLoja) : null;
  // Total do INDICADOR — soma das parcelas de dedução aplicáveis. Na visão
  // agregada as unidades podem estar em modelos diferentes: entregadores só
  // entra se PELO MENOS UMA unidade com dado no mês for Marketplace (mesma
  // regra que decide exibir o card, `taxasEntregadoresNaoAplicavel`).
  const totalDed = totalDeducoesIndicador(taxasEntregadoresNaoAplicavel ? "full_service" : "marketplace", {
    taxas_comissoes: valores.taxasComissoes,
    servicos_promocoes: valores.servicosPromocoes,
    taxas_entregadores: valores.taxasEntregadores,
  });
  const indicadoresRentabilidade = {
    taxas_comissoes: percentual(valores.taxasComissoes, base),
    servicos_promocoes: percentual(valores.servicosPromocoes, base),
    taxas_entregadores: percentual(valores.taxasEntregadores, base),
    total_deducoes: percentual(totalDed, base),
  };
  // O total agregado só é tão atual quanto a unidade MAIS ATRASADA — usa a
  // data mais antiga entre os snapshots de cada unidade, não a mais recente.
  const dataAtualizacaoAgregada = snapshotsPorUnidade.length
    ? snapshotsPorUnidade.map((s) => s.data_lancamento).sort()[0] : null;

  // Desempenho também é ACUMULADO do mês agora (mesma lógica do Financeiro
  // — ver listaDesempenhoDiario). Somar o acumulado ENTRE UNIDADES no mesmo
  // dia é válido (dois totais acumulados diferentes, mesmo instante); o
  // delta (dia sozinho) só pode ser calculado DEPOIS dessa soma, nunca
  // antes (senão dia 2 da unidade A + dia 5 da unidade B viraria um "dia"
  // sem sentido). Pula fatia de distribuição mensal, mesmo critério de
  // sempre.
  const porData = new Map();
  for (const r of linhas) {
    if (r.origem_lancamento === "distribuicao_mensal" || r.valor_vendas_bruto == null) continue;
    const acc = porData.get(r.data_lancamento) ?? 0;
    porData.set(r.data_lancamento, acc + Number(r.valor_vendas_bruto));
  }
  let anteriorAgregado = null;
  const evolucaoDiariaDesempenho = dias.map((d) => {
    const acumulado = porData.get(d) ?? null;
    const delta = acumulado == null ? null : (anteriorAgregado != null ? acumulado - anteriorAgregado : (d === dias[0] ? acumulado : null));
    if (acumulado != null) anteriorAgregado = acumulado;
    return {
      data: d, status: d > hojeIso ? STATUS_DIA.FUTURO : (acumulado != null ? STATUS_DIA.PREENCHIDO : STATUS_DIA.PENDENTE),
      valor: delta,
      acumuladoValorVendasBruto: acumulado,
    };
  });

  return {
    agregado: true,
    unidadeId: null,
    modeloLogistico: null,
    periodo: { mes, ano },
    aviso: "Visão consolidada de todas as unidades — somente leitura. Selecione uma unidade específica para lançar ou corrigir dados. Como cada unidade pode estar em um modelo logístico diferente (Marketplace/Full Service), as metas não são exibidas nesta visão agregada.",
    cards: {
      faturamento: {
        valor: base,
        periodoInicio: snapshotsPorUnidade.length ? `${ano}-${String(mes).padStart(2, "0")}-01` : null,
        periodoFim: dataAtualizacaoAgregada,
        dataAtualizacao: dataAtualizacaoAgregada,
      },
      // Visão agregada não exibe metas (modelos logísticos diferentes) — status
      // fica "sem_dados". Mesmo classificador da tabela, por coerência.
      taxasComissoes: { valor: valores.taxasComissoes, percentual: indicadoresRentabilidade.taxas_comissoes, meta: metas.taxas_comissoes ?? null, status: statusIndicadorRentabilidade(indicadoresRentabilidade.taxas_comissoes, metas.taxas_comissoes) },
      servicosPromocoes: { valor: valores.servicosPromocoes, percentual: indicadoresRentabilidade.servicos_promocoes, meta: metas.servicos_promocoes ?? null, status: statusIndicadorRentabilidade(indicadoresRentabilidade.servicos_promocoes, metas.servicos_promocoes) },
      taxasEntregadores: { valor: valores.taxasEntregadores, percentual: indicadoresRentabilidade.taxas_entregadores, meta: metas.taxas_entregadores ?? null, status: statusIndicadorRentabilidade(indicadoresRentabilidade.taxas_entregadores, metas.taxas_entregadores), naoAplicavel: taxasEntregadoresNaoAplicavel },
      ajustesFavor: { valor: valores.ajustesFavorLoja, percentual: percentual(valores.ajustesFavorLoja, base) },
      ajustesContra: { valor: valores.ajustesContraLoja, percentual: percentual(valores.ajustesContraLoja, base) },
      totalDeducoes: { valor: totalDed, percentual: indicadoresRentabilidade.total_deducoes, meta: metas.total_deducoes ?? null, status: statusIndicadorRentabilidade(indicadoresRentabilidade.total_deducoes, metas.total_deducoes) },
      receitaLiquida: { valor: receitaLiquidaValor, percentual: percentual(receitaLiquidaValor, base) },
      ticketMedio: { valor: ticketMedioAgregado },
      novosClientes: { valor: novosClientesAgregado },
    },
    indicadoresRentabilidade: Object.fromEntries(
      Object.entries(indicadoresRentabilidade).map(([k, atual]) => [k, {
        atual, metaIdeal: metas[k]?.metaIdeal ?? null, limite: metas[k]?.limite ?? null,
        status: statusIndicadorRentabilidade(atual, metas[k]),
      }]),
    ),
    graficos: {
      comparativoPercentuais: Object.entries(indicadoresRentabilidade).map(([indicador, atual]) => ({
        indicador, atual, metaIdeal: metas[indicador]?.metaIdeal ?? null, limite: metas[indicador]?.limite ?? null,
      })),
      composicaoDeducoes: [
        { indicador: "taxas_comissoes", valor: valores.taxasComissoes },
        { indicador: "servicos_promocoes", valor: valores.servicosPromocoes },
        { indicador: "taxas_entregadores", valor: valores.taxasEntregadores },
        { indicador: "ajustes_contra_loja", valor: valores.ajustesContraLoja },
      ],
    },
    // Mesma forma de obterMesDeUmaUnidade — ver comentário lá. Aqui, soma
    // entre unidades de cada acumulado diário.
    desempenhoOperacional: (() => {
      const ultimoComDado = [...evolucaoDiariaDesempenho].reverse().find((p) => p.acumuladoValorVendasBruto != null) ?? null;
      const diasNoAcumulado = ultimoComDado ? Number(ultimoComDado.data.slice(8, 10)) : 0;
      return {
        evolucaoDiaria: evolucaoDiariaDesempenho,
        acumulado: ultimoComDado?.acumuladoValorVendasBruto ?? null,
        acumuladoNovosClientes: novosClientesAgregado,
        dataAtualizacao: ultimoComDado?.data ?? null,
        mediaDiaria: ultimoComDado != null && diasNoAcumulado > 0 ? ultimoComDado.acumuladoValorVendasBruto / diasNoAcumulado : null,
        aviso: "Acompanhamento operacional — os valores financeiros oficiais são provenientes do Financeiro iFood.",
      };
    })(),
  };
}

// ---------------------------------------------------------------------------
// GET /dashboard-executivo/lancamentos/:data
// ---------------------------------------------------------------------------
export async function obterLancamentoPorData({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, data }) {
  const dataIso = v.dataOpcional(data, "Data") ?? (() => { throw ApiError.badRequest("Data é obrigatória."); })();
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: true });

  const { data: row, error } = await supabase
    .from(TABELA).select("*").eq("unidade_id", unidadeId).eq("data_lancamento", dataIso).maybeSingle();
  if (error) throw ApiError.internal(error.message);

  const hojeIso = hojeIsoBrasil();
  const [ano, mes] = dataIso.split("-").map(Number);
  const { diasComStatus, desbloqueios } = await carregarCalendarioMes({ unidadeId, ano, mes, hojeIso });
  const disponibilidade = verificarDisponibilidade(diasComStatus, dataIso);

  return {
    lancamento: row ? paraApi(row) : null,
    disponibilidade,
    ...financeiroDisponivelNaData({ dataIso, hojeIso, valorVendasIfoodExistente: row?.valor_vendas_ifood ?? null, desbloqueios }),
  };
}

/**
 * Regra central (item "REGRA" do pedido): a etapa Financeiro só é oferecida
 * quando a data lançada é exatamente ontem — OU quando o registro JÁ tem um
 * snapshot financeiro salvo (nunca esconde/impede acesso a dado histórico
 * já existente, mesmo que hoje a data não seja mais "ontem") — OU quando
 * existe um DESBLOQUEIO ADMINISTRATIVO ativo para aquela unidade e data
 * (migration 068; o Set vem do banco via `carregarCalendarioMes`, nunca de
 * uma lista no código). Comparação de CALENDÁRIO via `diaAnterior`
 * (calc.js), nunca diferença de milissegundos. Autoridade única — usada
 * tanto pela leitura (aqui) quanto pela escrita
 * (`criarLancamento`/`atualizarLancamento`), nunca recalculada no frontend.
 *
 * A ordem das três condições É a regra do produto: o fluxo normal decide
 * primeiro, a exceção administrativa só entra quando ele já disse não.
 * @param {{dataIso: string, hojeIso: string, valorVendasIfoodExistente: number|null, desbloqueios?: Set<string>}} p
 */
function financeiroDisponivelNaData({ dataIso, hojeIso, valorVendasIfoodExistente, desbloqueios }) {
  const desbloqueioAdmin = desbloqueios instanceof Set && desbloqueios.has(dataIso);
  const mostrarFinanceiro = valorVendasIfoodExistente != null
    || dataIso === diaAnterior(hojeIso)
    || desbloqueioAdmin;
  const [ano, mes] = dataIso.split("-").map(Number);
  return {
    mostrarFinanceiro,
    // Procedência da liberação — o frontend usa só para AVISAR o operador de
    // que aquele dia foi aberto por exceção ("liberado administrativamente"),
    // nunca para decidir disponibilidade (isso é sempre backend).
    financeiroPorDesbloqueio: desbloqueioAdmin && valorVendasIfoodExistente == null && dataIso !== diaAnterior(hojeIso),
    periodoFinanceiroInicio: `${ano}-${String(mes).padStart(2, "0")}-01`,
    periodoFinanceiroFim: dataIso,
  };
}

// ---------------------------------------------------------------------------
// NORMALIZAÇÃO DOS DADOS DE ENTRADA DO FORMULÁRIO (etapas 1-3)
// ---------------------------------------------------------------------------
const COLUNAS_ACUMULADAS = {
  valorVendasIfood: "valor_vendas_ifood", taxasComissoes: "taxas_comissoes",
  servicosPromocoes: "servicos_promocoes", taxasEntregadores: "taxas_entregadores",
};

/** Modelo logístico vigente NA DATA do lançamento (linha do tempo, nunca o modelo atual da unidade). */
async function modeloVigenteNaData({ unidadeId, organizacaoId, dataIso }) {
  const modelo = await obterModeloLogistico({ unidadeId, organizacaoId });
  return modeloNaData(modelo.linhaDoTempo ?? montarLinhaDoTempo({ modeloAtual: modelo.modeloLogistico }), dataIso);
}

/** Contexto pra validação preventiva (item E) — ver `normalizarDadosLancamento`. */
function montarFinanceiroAnterior(linhas, dataIso) {
  const porCampo = Object.fromEntries(
    Object.entries(COLUNAS_ACUMULADAS).map(([campo, coluna]) => [campo, ultimoValorConciliadoAntesDe(linhas, coluna, dataIso)]),
  );
  return { porCampo, linhasDoMes: linhas, dataIso };
}

// Exportada só pra teste unitário direto (função pura, sem I/O) — o resto
// do módulo continua chamando-a internamente do mesmo jeito.
//
// `financeiroAnterior` (opcional, calculado por quem chama):
// `{ porCampo: Record<campo, {valor,data}|null>, linhasDoMes: object[], dataIso: string }` —
// `porCampo` é o último ponto CONCILIADO conhecido de cada campo acumulado
// antes desta data (ver `ultimoValorConciliadoAntesDe`); `linhasDoMes`/`dataIso`
// alimentam a checagem cruzada com `valor_vendas_bruto` (ver
// `avisoIgualdadeSuspeitaComBruto`). Alimenta a VALIDAÇÃO PREVENTIVA (item E
// da investigação 2026-09-22): se o valor novo for MENOR que o último
// conhecido, o usuário é avisado ANTES de salvar — nunca depois. Uma queda
// leve vira um aviso comum (mesmo mecanismo de `inconsistencias()` acima);
// uma queda MATERIAL exige confirmação reforçada (`confirmarQuedaMaterial`)
// E uma justificativa por escrito (`justificativaQuedaAcumulado`) — nunca só
// um checkbox genérico. Casos legítimos de correção continuam possíveis,
// só passam a deixar rastro explícito (ver `criarLancamento`/`atualizarLancamento`,
// que gravam a justificativa na auditoria).
export function normalizarDadosLancamento(body, { exigirFinanceiro, desempenhoAnterior, financeiroAnterior = null, modeloNaDataLancamento = null }) {
  const b = v.corpo(body);
  const situacao = v.umDe(b.situacao, "Situação", ["normal", "parcial", "sem_operacao", "zero_vendas"]);
  const statusAlvo = v.umDeOpcional(b.status, "Status", ["rascunho", "finalizado"], "rascunho");

  // Desempenho é ACUMULADO do mês (mesma lógica do Financeiro, ver
  // listaDesempenhoDiario) — um dia sem venda real (Sem operação/Zero
  // vendas) não pode gravar 0 literal, isso "zeraria" a série e inventaria
  // um delta gigante negativo no dia seguinte. Em vez disso REPETE o
  // acumulado do dia anterior (`desempenhoAnterior`, calculado por quem
  // chama — ver ultimoDesempenhoConhecido): o delta desse dia dá 0
  // corretamente, sem quebrar a continuidade da série.
  const anterior = desempenhoAnterior ?? { qtdVendas: 0, valorVendasBruto: 0, novosClientes: 0 };

  if (situacao === "sem_operacao") {
    // Rascunho pode ficar incompleto (item novo — "Salvar como rascunho" em
    // qualquer etapa): só exige o motivo de verdade quando o usuário está
    // FINALIZANDO. Um rascunho que já marcou "não funcionou" mas ainda não
    // escolheu o motivo continua salvável.
    const motivo = statusAlvo === "finalizado"
      ? v.texto(b.motivoSemOperacao, "Motivo de não operação", { min: 1, max: 300 })
      : v.textoOpcional(b.motivoSemOperacao, "Motivo de não operação", { max: 300 });
    return {
      situacao, statusAlvo, motivoSemOperacao: motivo, observacao: v.textoOpcional(b.observacao, "Observação", { max: 1000 }),
      qtdVendas: anterior.qtdVendas, valorVendasBruto: anterior.valorVendasBruto, novosClientes: anterior.novosClientes, valorVendasIfood: 0,
      taxasComissoes: 0, servicosPromocoes: 0, taxasEntregadores: 0, ajustesFavorLoja: 0, ajustesContraLoja: 0, justificativaAjuste: null,
      avisos: [], sinaisQuedaMaterialConfirmados: [],
    };
  }

  if (situacao === "zero_vendas") {
    return {
      situacao, statusAlvo, motivoSemOperacao: null, observacao: v.textoOpcional(b.observacao, "Observação", { max: 1000 }),
      qtdVendas: anterior.qtdVendas, valorVendasBruto: anterior.valorVendasBruto, novosClientes: anterior.novosClientes,
      valorVendasIfood: 0, taxasComissoes: 0, servicosPromocoes: 0, taxasEntregadores: 0, ajustesFavorLoja: 0, ajustesContraLoja: 0, justificativaAjuste: null,
      avisos: [], sinaisQuedaMaterialConfirmados: [],
    };
  }

  // situacao === "normal" ou "parcial" ("Funcionou, parcialmente" percorre o
  // MESMO fluxo de um dia normal — só a unidade operou de forma parcial) —
  // ETAPA DESEMPENHO (qtdVendas/valorVendasBruto/
  // novosClientes) é OPCIONAL: nada aqui bloqueia o lançamento, e o que não
  // for informado vira null (nunca 0) — "não sei" ≠ "foi zero". Os 3 campos
  // são ACUMULADOS do mês (mesma lógica do Financeiro) — o valor isolado do
  // dia é sempre derivado por subtração, nunca gravado diretamente (ver
  // listaDesempenhoDiario em calc.js).
  //
  // ETAPA FINANCEIRO: o iFood só consolida o financeiro do dia com 1 dia de
  // atraso, então só é EXIGIDA quando a data lançada é ontem (`exigirFinanceiro`,
  // calculado por quem chama — ver `financeiroDisponivelNaData`) E o usuário
  // está FINALIZANDO (item novo — rascunho pode estar incompleto mesmo num
  // dia elegível pro Financeiro: "Salvar como rascunho" com Desempenho
  // parcial, sem nunca ter aberto a etapa Financeiro, precisa continuar
  // funcionando). Nos demais casos os 5 campos usam a MESMA função opcional
  // do Desempenho — não inventa zero pro que ainda não existe no iFood nem
  // pro que o usuário ainda não chegou a preencher. Isso não desfinaliza um
  // dia antigo: ao FINALIZAR com `exigirFinanceiro` true (inclusive por já
  // ter snapshot salvo — ver `atualizarLancamento`), o comportamento
  // continua idêntico ao de sempre, campo obrigatório de verdade.
  const exigirFinanceiroDeVerdade = exigirFinanceiro && statusAlvo === "finalizado";
  const qtdVendasRaw = v.numeroOpcionalNulo(b.qtdVendas, "Quantidade de vendas", { min: 0 });
  const qtdVendas = qtdVendasRaw == null ? null : Math.trunc(qtdVendasRaw);
  const valorVendasBruto = v.numeroOpcionalNulo(b.valorVendasBruto, "Valor bruto das vendas", { min: 0 });
  const novosClientesRaw = v.numeroOpcionalNulo(b.novosClientes, "Novos clientes", { min: 0 });
  const novosClientes = novosClientesRaw == null ? null : Math.trunc(novosClientesRaw);
  const numFinanceiro = (valor, campo) => exigirFinanceiroDeVerdade
    ? v.numero(valor, campo, { min: 0 })
    : v.numeroOpcionalNulo(valor, campo, { min: 0 });
  const valorVendasIfood = numFinanceiro(b.valorVendasIfood, "Valor das vendas (iFood)");
  const taxasComissoes = numFinanceiro(b.taxasComissoes, "Taxas e comissões");
  const servicosPromocoes = numFinanceiro(b.servicosPromocoes, "Serviços e promoções");
  // No Full Service o campo não existe (o formulário nem o exibe): opcional, nunca exigido.
  const taxasEntregadoresAplicavel = !modeloNaDataLancamento || indicadorAplicavel(modeloNaDataLancamento, "taxas_entregadores");
  const taxasEntregadores = taxasEntregadoresAplicavel
    ? numFinanceiro(b.taxasEntregadores, "Taxas de entregadores")
    : v.numeroOpcionalNulo(b.taxasEntregadores, "Taxas de entregadores", { min: 0 });
  // Ajustes a favor / contra da loja: SEMPRE positivos e SEMPRE opcionais —
  // um ajuste financeiro é a exceção, não a regra, e não deve travar a
  // finalização de um dia. `null` = "não houve ajuste" (tratado como 0 nas
  // fórmulas). Ver dashboardExecutivo.calc.js#totalDeducoes / #receitaLiquida.
  const ajustesFavorLoja = v.numeroOpcionalNulo(b.ajustesFavorLoja, "Ajustes a favor da loja", { min: 0, max: 1e9 });
  const ajustesContraLoja = v.numeroOpcionalNulo(b.ajustesContraLoja, "Ajustes contra a loja", { min: 0, max: 1e9 });
  const justificativaAjuste = v.textoOpcional(b.justificativaAjuste, "Justificativa do ajuste", { max: 500 });

  const totalDed = totalDeducoes({ taxasComissoes, servicosPromocoes, taxasEntregadores, ajustesContraLoja });
  const avisos = inconsistencias({ qtdVendas, valorVendasBruto, valorVendasIfood, totalDed });

  // VALIDAÇÃO PREVENTIVA (item E, investigação 2026-09-22): campos acumulados
  // com valor NOVO menor que o último ponto conciliado conhecido. Nunca
  // bloqueia por si só um valor igual/maior — "não sei" (financeiroAnterior
  // ausente) também não bloqueia.
  const CAMPOS_ACUMULADOS = [
    ["valorVendasIfood", "Valor das vendas (iFood)", valorVendasIfood],
    ["taxasComissoes", "Taxas e Comissões", taxasComissoes],
    ["servicosPromocoes", "Serviços e Promoções", servicosPromocoes],
    ["taxasEntregadores", "Taxas de Entregadores", taxasEntregadores],
  ];
  // Taxas de Entregadores não existe no Full Service: o último ponto conciliado
  // é de outro modelo (Marketplace) e o 0 informado é o valor correto — não é queda.
  const sinaisQueda = CAMPOS_ACUMULADOS
    .filter(([campo]) => campo !== "taxasEntregadores" || !modeloNaDataLancamento || indicadorAplicavel(modeloNaDataLancamento, "taxas_entregadores"))
    .map(([campo, rotulo, valorNovo]) => avaliarQuedaAcumulado({ campo, rotulo, valorNovo, ultimoConhecido: financeiroAnterior?.porCampo?.[campo] ?? null }))
    .filter(Boolean);
  for (const sinal of sinaisQueda) if (sinal.nivel === "leve") avisos.push(sinal.mensagem);

  const avisoIgualdade = avisoIgualdadeSuspeitaComBruto({
    valorVendasIfood, valorVendasBruto, linhasDoMes: financeiroAnterior?.linhasDoMes ?? [], dataAtualIso: financeiroAnterior?.dataIso ?? null,
  });
  if (avisoIgualdade) avisos.push(avisoIgualdade);

  if (statusAlvo === "finalizado" && avisos.length > 0 && !v.booleano(b.confirmarAvisos, false)) {
    throw ApiError.badRequest(`Existem inconsistências que precisam de confirmação antes de finalizar: ${avisos.join(" ")}`, { avisos, confirmacaoNecessaria: true });
  }

  // Quedas MATERIAIS exigem confirmação reforçada E justificativa por escrito
  // — nunca só o checkbox genérico acima (`confirmarAvisos`). O texto vira
  // rastro de auditoria (ver `criarLancamento`/`atualizarLancamento`).
  const sinaisMateriais = sinaisQueda.filter((s) => s.nivel === "material");
  let justificativaQuedaAcumulado = null;
  if (statusAlvo === "finalizado" && sinaisMateriais.length > 0) {
    if (!v.booleano(b.confirmarQuedaMaterial, false)) {
      throw ApiError.badRequest(
        `Uma ou mais quedas de acumulado precisam de confirmação reforçada e justificativa antes de finalizar: ${sinaisMateriais.map((s) => s.mensagem).join(" ")}`,
        { sinaisQuedaMaterial: sinaisMateriais, confirmacaoReforcadaNecessaria: true },
      );
    }
    justificativaQuedaAcumulado = v.texto(b.justificativaQuedaAcumulado, "Justificativa da queda de acumulado", { min: 10, max: 500 });
  }

  // Invariante: um dia "normal"/"parcial" só é FINALIZADO sem financeiro quando o
  // financeiro nem é elegível ainda (`exigirFinanceiro=false` — a maioria
  // dos dias do mês, ver financeiroDisponivelNaData). Quando é elegível,
  // `numFinanceiro` acima já exige o valor via `v.numero` — chegar aqui com
  // `exigirFinanceiro=true` e `valorVendasIfood == null` é impossível (já
  // teria lançado badRequest lá em cima). Não há mais bloqueio de
  // finalização por falta de financeiro em dias não elegíveis — é
  // exatamente o "financeiro é snapshot acumulado, não pendência diária"
  // (ver migration 036).

  return {
    situacao, statusAlvo, motivoSemOperacao: null, observacao: v.textoOpcional(b.observacao, "Observação", { max: 1000 }),
    qtdVendas, valorVendasBruto, novosClientes, valorVendasIfood,
    taxasComissoes, servicosPromocoes, taxasEntregadores, ajustesFavorLoja, ajustesContraLoja, justificativaAjuste,
    avisos,
    // Rastro de auditoria de quedas MATERIAIS confirmadas (vazio no caso comum) —
    // quem chama grava uma linha por campo em `lancamentos_financeiros_auditoria`
    // mesmo numa criação (não só correção de um lançamento já finalizado).
    sinaisQuedaMaterialConfirmados: sinaisMateriais.length ? sinaisMateriais.map((s) => ({ ...s, justificativa: justificativaQuedaAcumulado })) : [],
  };
}

// ---------------------------------------------------------------------------
// POST /dashboard-executivo/lancamentos
// ---------------------------------------------------------------------------
export async function criarLancamento({ organizacaoId, unidadeIdSessao, acesso, usuario, dados: body }) {
  const b = v.corpo(body);
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado: b.unidadeId, exigirEspecifica: true });
  const dataIso = v.dataOpcional(b.data, "Data");
  if (!dataIso) throw ApiError.badRequest("Data é obrigatória.");

  const hojeIso = hojeIsoBrasil();
  if (dataIso > hojeIso) throw ApiError.badRequest("Não é possível lançar uma data futura.");

  const [ano, mes] = dataIso.split("-").map(Number);
  const { diasComStatus, linhas, desbloqueios } = await carregarCalendarioMes({ unidadeId, ano, mes, hojeIso });
  const disponibilidade = verificarDisponibilidade(diasComStatus, dataIso);
  if (!disponibilidade.disponivel) throw new ApiError(409, disponibilidade.motivo, { statusDia: disponibilidade.status });
  if (disponibilidade.status !== STATUS_DIA.PENDENTE) {
    throw new ApiError(409, "Já existe um lançamento para esta data. Utilize a edição.", { statusDia: disponibilidade.status });
  }

  // Criação nunca tem snapshot anterior — exigirFinanceiro depende só da data
  // ser ontem OU de haver desbloqueio administrativo ativo para ela.
  const { mostrarFinanceiro: exigirFinanceiro } = financeiroDisponivelNaData({ dataIso, hojeIso, valorVendasIfoodExistente: null, desbloqueios });
  // `linhas` já veio de carregarCalendarioMes acima — nenhuma consulta extra
  // pra achar o acumulado de Desempenho do dia anterior (usado só se a
  // situação for Sem operação/Zero vendas, ver normalizarDadosLancamento).
  const desempenhoAnterior = ultimoDesempenhoConhecido(linhas, dataIso);
  const modeloNaDataLancamento = await modeloVigenteNaData({ unidadeId, organizacaoId, dataIso });
  const dados = normalizarDadosLancamento(body, { exigirFinanceiro, desempenhoAnterior, financeiroAnterior: montarFinanceiroAnterior(linhas, dataIso), modeloNaDataLancamento });

  const linha = {
    organizacao_id: organizacaoId,
    unidade_id: unidadeId,
    data_lancamento: dataIso,
    situacao: dados.situacao,
    motivo_sem_operacao: dados.motivoSemOperacao,
    observacao: dados.observacao,
    qtd_vendas: dados.qtdVendas,
    valor_vendas_bruto: dados.valorVendasBruto,
    novos_clientes: dados.novosClientes,
    valor_vendas_ifood: dados.valorVendasIfood,
    taxas_comissoes: dados.taxasComissoes,
    servicos_promocoes: dados.servicosPromocoes,
    taxas_entregadores: dados.taxasEntregadores,
    ajustes_favor_loja: dados.ajustesFavorLoja,
    ajustes_contra_loja: dados.ajustesContraLoja,
    justificativa_ajuste: dados.justificativaAjuste,
    status: dados.statusAlvo,
    usuario_id: usuario?.id ?? null,
    usuario_nome: usuario?.nome ?? null,
    usuario_email: usuario?.email ?? null,
    finalizado_em: dados.statusAlvo === "finalizado" ? new Date().toISOString() : null,
  };

  const { data: row, error } = await supabase.from(TABELA).insert(linha).select("*").single();
  if (error) {
    if (/duplicate key|unique/i.test(error.message)) {
      throw new ApiError(409, "Já existe um lançamento para esta unidade e data.", { statusDia: STATUS_DIA.PREENCHIDO });
    }
    throw ApiError.badRequest(error.message);
  }

  // Auditoria do ciclo de vida do rascunho (item novo — "criação do
  // rascunho; atualizações posteriores; finalização", só nas ações de
  // salvar, nunca por campo/tecla). Reaproveita a MESMA tabela/helper da
  // correção de lançamento finalizado — não é uma trilha paralela, é o
  // mesmo `lancamentos_financeiros_auditoria` com `campo: "status"`.
  await registrarAuditoria({
    lancamentoId: row.id, organizacaoId, unidadeId, campo: "status",
    valorAnterior: null, valorNovo: dados.statusAlvo, usuario,
    motivo: dados.statusAlvo === "finalizado" ? "Lançamento criado já finalizado" : "Rascunho criado",
  });

  // Rastro de queda MATERIAL de acumulado confirmada (item E) — uma linha por
  // campo, com a justificativa que o usuário foi obrigado a escrever.
  for (const s of dados.sinaisQuedaMaterialConfirmados) {
    await registrarAuditoria({
      lancamentoId: row.id, organizacaoId, unidadeId, campo: `${s.campo}_queda_confirmada`,
      valorAnterior: String(s.valorAnterior), valorNovo: String(s.valorNovo), usuario, motivo: s.justificativa,
    });
  }

  // Emitido DEPOIS da escrita confirmada (insert + auditoria já persistidos) —
  // nunca antes. Falha de Broadcast nunca vira falha desta operação (ver
  // emitirEventoRealtime). Payload mínimo: nenhum valor financeiro, nenhum
  // nome — só o suficiente pra quem estiver ouvindo saber "isto ficou
  // obsoleto" e refazer o fetch oficial.
  await emitirEventoRealtime({
    tipo: EVENTOS_DASHBOARD_IFOOD.LANCAMENTO_CRIADO,
    organizacaoId, unidadeId,
    data: dataIso, competencia: competenciaDe(ano, mes),
    entidadeId: row.id, versao: row.updated_at,
  });

  return { lancamento: paraApi(row), avisos: dados.avisos };
}

// Campos "de dado" de um lançamento — usados tanto pra decidir se uma edição
// de um lançamento finalizado é uma CORREÇÃO de verdade (exige permissão +
// motivo) quanto pra montar a trilha de auditoria.
const CAMPOS_AUDITADOS = [
  ["situacao", "situacao"], ["motivo_sem_operacao", "motivo_sem_operacao"], ["observacao", "observacao"],
  ["qtd_vendas", "qtd_vendas"], ["valor_vendas_bruto", "valor_vendas_bruto"], ["novos_clientes", "novos_clientes"],
  ["valor_vendas_ifood", "valor_vendas_ifood"], ["taxas_comissoes", "taxas_comissoes"],
  ["servicos_promocoes", "servicos_promocoes"], ["taxas_entregadores", "taxas_entregadores"],
  ["ajustes_favor_loja", "ajustes_favor_loja"], ["ajustes_contra_loja", "ajustes_contra_loja"],
];

/**
 * Uma edição de um lançamento já finalizado só é uma "correção" (exige
 * permissão + motivo) quando muda um valor que JÁ existia. Completar um
 * campo que ainda estava `null` — o caso normal de "o financeiro de ontem
 * acabou de ficar disponível" (ver financeiroDisponivelNaData) — não é
 * correção de erro nenhum, é o fluxo esperado, e não deve travar atrás da
 * permissão de correção.
 * @param {object} antes — linha CRUA do banco antes da edição
 * @param {object} patch — patch snake_case prestes a ser gravado
 * @returns {boolean}
 */
function precisaCorrecao(antes, patch) {
  return CAMPOS_AUDITADOS.some(([campoAntes, campoDepois]) => {
    if (antes[campoAntes] == null) return false; // não havia valor antes: preenchimento, não correção
    return String(antes[campoAntes]) !== String(patch[campoDepois]);
  });
}

// ---------------------------------------------------------------------------
// PUT /dashboard-executivo/lancamentos/:id
// ---------------------------------------------------------------------------
export async function atualizarLancamento({ organizacaoId, unidadeIdSessao, acesso, usuario, id, dados: body }) {
  const lancamentoId = v.uuid(id, "Lançamento");
  const { data: antes, error: eAntes } = await supabase
    .from(TABELA).select("*").eq("id", lancamentoId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (eAntes) throw ApiError.internal(eAntes.message);
  if (!antes) throw ApiError.notFound("Lançamento não encontrado.");

  if (unidadeIdSessao && antes.unidade_id !== unidadeIdSessao) {
    throw ApiError.forbidden("Você não tem acesso a este lançamento.");
  }

  // Concorrência otimista (Etapa 2): o cliente manda de volta o `updatedAt`
  // que leu quando abriu o formulário (`seVersao`). Se a linha mudou desde
  // então — outro dispositivo/sessão salvou primeiro —, recusa em vez de
  // sobrescrever em silêncio (last-write-wins). Campo OPCIONAL de propósito:
  // sem `seVersao` no corpo, nenhuma checagem é feita (compatível com
  // qualquer chamador que ainda não a envie). Nunca bloqueia locking
  // pessimista nem avisa "quem está editando" — é só "isto mudou, recarregue".
  if (body?.seVersao && antes.updated_at
      && new Date(antes.updated_at).getTime() !== new Date(body.seVersao).getTime()) {
    const conflito = new ApiError(409,
      "Este lançamento foi atualizado em outro dispositivo ou sessão. Os dados exibidos podem estar desatualizados. Atualize o lançamento antes de salvar novamente.");
    conflito.codigo = "LANCAMENTO_DESATUALIZADO";
    throw conflito;
  }

  const eraFinalizado = antes.status === "finalizado";
  const podeCorrigir = temPermissao(acesso.permissoes, PERMISSOES.DASHBOARD_EXECUTIVO_CORRIGIR);

  // Edição posterior (item do pedido): nunca esconde/impede acesso a um
  // snapshot financeiro JÁ salvo — `antes.valor_vendas_ifood != null` cobre
  // tanto "está finalizado" (sempre tem, pelo invariante) quanto "é
  // rascunho mas alguém já preencheu financeiro nele". Fora isso, a regra
  // normal: só exige quando a data ainda é ontem, reavaliada agora.
  // Mesmo raciocínio de criarLancamento: `linhasDoMes` só é usado se a edição
  // virar Sem operação/Zero vendas (repete o acumulado de Desempenho do dia
  // anterior em vez de zerar a série). O calendário é carregado ANTES da
  // decisão porque é ele que traz os desbloqueios administrativos do mês.
  const hojeIso = hojeIsoBrasil();
  const [anoAntes, mesAntes] = antes.data_lancamento.split("-").map(Number);
  const { linhas: linhasDoMes, desbloqueios } = await carregarCalendarioMes({ unidadeId: antes.unidade_id, ano: anoAntes, mes: mesAntes, hojeIso });
  const { mostrarFinanceiro: exigirFinanceiro } = financeiroDisponivelNaData({
    dataIso: antes.data_lancamento, hojeIso, valorVendasIfoodExistente: antes.valor_vendas_ifood, desbloqueios,
  });
  const desempenhoAnterior = ultimoDesempenhoConhecido(linhasDoMes, antes.data_lancamento);
  const modeloNaDataLancamento = await modeloVigenteNaData({ unidadeId: antes.unidade_id, organizacaoId: antes.organizacao_id, dataIso: antes.data_lancamento });
  const dados = normalizarDadosLancamento(body, {
    exigirFinanceiro, desempenhoAnterior, financeiroAnterior: montarFinanceiroAnterior(linhasDoMes, antes.data_lancamento), modeloNaDataLancamento,
  });

  const patch = {
    situacao: dados.situacao,
    motivo_sem_operacao: dados.motivoSemOperacao,
    observacao: dados.observacao,
    qtd_vendas: dados.qtdVendas,
    valor_vendas_bruto: dados.valorVendasBruto,
    novos_clientes: dados.novosClientes,
    valor_vendas_ifood: dados.valorVendasIfood,
    taxas_comissoes: dados.taxasComissoes,
    servicos_promocoes: dados.servicosPromocoes,
    taxas_entregadores: dados.taxasEntregadores,
    ajustes_favor_loja: dados.ajustesFavorLoja,
    ajustes_contra_loja: dados.ajustesContraLoja,
    justificativa_ajuste: dados.justificativaAjuste,
  };

  let motivoCorrecao = null;
  if (eraFinalizado && precisaCorrecao(antes, patch)) {
    if (!podeCorrigir) throw ApiError.forbidden("Editar um lançamento finalizado exige a permissão de correção.");
    motivoCorrecao = v.texto(v.corpo(body).motivo, "Motivo da correção", { min: 3, max: 500 });
  }

  // Uma vez finalizado, permanece finalizado (correção não "desfinaliza").
  // A partir de rascunho, o próprio PUT pode finalizar.
  patch.status = eraFinalizado ? "finalizado" : dados.statusAlvo;
  if (!eraFinalizado && dados.statusAlvo === "finalizado") {
    patch.finalizado_em = new Date().toISOString();
    patch.usuario_id = usuario?.id ?? antes.usuario_id;
    patch.usuario_nome = usuario?.nome ?? antes.usuario_nome;
    patch.usuario_email = usuario?.email ?? antes.usuario_email;
  }

  // `organizacao_id` repetido na própria escrita (não só na leitura acima,
  // linha 676): defesa em profundidade — o `id` já foi validado contra o
  // tenant, mas a escrita não deve depender só de quem chamou ter feito isso.
  const { data: depois, error } = await supabase
    .from(TABELA).update(patch).eq("id", lancamentoId).eq("organizacao_id", organizacaoId).select("*").single();
  if (error) throw ApiError.badRequest(error.message);

  // Auditoria: um lançamento finalizado editado grava uma linha POR CAMPO
  // alterado, preservando o registro original (nunca se sobrescreve "em silêncio").
  if (eraFinalizado) {
    for (const [campoAntes, campoDepois] of CAMPOS_AUDITADOS) {
      const valorAntes = antes[campoAntes];
      const valorDepois = depois[campoDepois];
      if (String(valorAntes ?? "") !== String(valorDepois ?? "")) {
        await registrarAuditoria({
          lancamentoId, organizacaoId, unidadeId: antes.unidade_id, campo: campoDepois,
          valorAnterior: valorAntes != null ? String(valorAntes) : null,
          valorNovo: valorDepois != null ? String(valorDepois) : null,
          usuario, motivo: motivoCorrecao,
        });
      }
    }
  } else {
    // Auditoria do ciclo de vida do rascunho (item novo): "atualizações
    // posteriores" e "finalização" — uma linha por ação de salvar, nunca
    // por campo. Só entra aqui quando NÃO era finalizado (o bloco `if`
    // acima já audita campo a campo qualquer correção de um já finalizado).
    await registrarAuditoria({
      lancamentoId, organizacaoId, unidadeId: antes.unidade_id, campo: "status",
      valorAnterior: "rascunho", valorNovo: patch.status,
      usuario, motivo: patch.status === "finalizado" ? "Lançamento finalizado" : "Rascunho atualizado",
    });
  }

  // Rastro de queda MATERIAL de acumulado confirmada (item E) — além da
  // auditoria por campo acima (que já grava o motivo genérico da correção),
  // uma linha específica com a justificativa que o usuário foi obrigado a
  // escrever para ESSA queda em particular.
  for (const s of dados.sinaisQuedaMaterialConfirmados) {
    await registrarAuditoria({
      lancamentoId, organizacaoId, unidadeId: antes.unidade_id, campo: `${s.campo}_queda_confirmada`,
      valorAnterior: String(s.valorAnterior), valorNovo: String(s.valorNovo), usuario, motivo: s.justificativa,
    });
  }

  await emitirEventoRealtime({
    tipo: EVENTOS_DASHBOARD_IFOOD.LANCAMENTO_ATUALIZADO,
    organizacaoId, unidadeId: antes.unidade_id,
    data: antes.data_lancamento, competencia: competenciaDe(anoAntes, mesAntes),
    entidadeId: lancamentoId, versao: depois.updated_at,
  });

  return { lancamento: paraApi(depois), avisos: dados.avisos };
}

async function registrarAuditoria({ lancamentoId, organizacaoId, unidadeId, campo, valorAnterior, valorNovo, usuario, motivo }) {
  const { error } = await supabase.from(TABELA_AUDITORIA).insert({
    lancamento_id: lancamentoId,
    organizacao_id: organizacaoId,
    unidade_id: unidadeId,
    campo,
    valor_anterior: valorAnterior,
    valor_novo: valorNovo,
    usuario_id: usuario?.id ?? null,
    usuario_nome: usuario?.nome ?? null,
    usuario_email: usuario?.email ?? null,
    motivo: motivo ?? "Não informado",
  });
  if (error) console.error("[dashboard-executivo] falha ao registrar auditoria:", error.message);
}

// ---------------------------------------------------------------------------
// DELETE (de verdade) DE UM LANÇAMENTO — universal (qualquer unidade, real
// ou de teste), restrito a quem tem DASHBOARD_EXECUTIVO_EXCLUIR (só
// organization_admin, ver permissoes.js). Diferente do reset de teste: aqui
// é UM dia só, sem cascata, e sempre com motivo + snapshot completo — nunca
// se apaga um lançamento financeiro "em silêncio".
// ---------------------------------------------------------------------------
export async function excluirLancamento({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, usuario, id, motivo: motivoRaw }) {
  const lancamentoId = v.uuid(id, "Lançamento");
  const motivo = v.texto(motivoRaw, "Motivo da exclusão", { min: 3, max: 500 });

  const { data: linha, error } = await supabase
    .from(TABELA).select("*").eq("id", lancamentoId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!linha) throw ApiError.notFound("Lançamento não encontrado.");

  // Mesma regra de escopo das demais ações: sessão presa a uma unidade não
  // pode agir sobre lançamento de outra unidade, mesmo com a permissão.
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado: unidadeIdSolicitado ?? linha.unidade_id, exigirEspecifica: true });
  if (linha.unidade_id !== unidadeId) throw ApiError.forbidden("Você não tem acesso a este lançamento.");

  // Snapshot ANTES de apagar — tabela própria, sem FK para o lançamento (que
  // está prestes a deixar de existir), então o registro da exclusão nunca
  // some junto com o que foi apagado.
  const { error: eLog } = await supabase.from("lancamentos_financeiros_exclusoes").insert({
    organizacao_id: organizacaoId, unidade_id: linha.unidade_id, data_lancamento: linha.data_lancamento,
    lancamento_snapshot: linha, motivo,
    usuario_id: usuario?.id ?? null, usuario_nome: usuario?.nome ?? null, usuario_email: usuario?.email ?? null,
  });
  if (eLog) console.error("[dashboard-executivo] falha ao registrar log de exclusão:", eLog.message);

  const { error: eDel } = await supabase.from(TABELA).delete().eq("id", lancamentoId);
  if (eDel) throw ApiError.badRequest(eDel.message);

  const [anoExc, mesExc] = linha.data_lancamento.split("-").map(Number);
  await emitirEventoRealtime({
    tipo: EVENTOS_DASHBOARD_IFOOD.LANCAMENTO_EXCLUIDO,
    organizacaoId, unidadeId: linha.unidade_id,
    data: linha.data_lancamento, competencia: competenciaDe(anoExc, mesExc),
    // A linha já não existe pra ter um updated_at próprio — a versão aqui é
    // só "quando a exclusão aconteceu", suficiente pra dedup/ordenação.
    entidadeId: lancamentoId, versao: new Date().toISOString(),
  });

  return { excluido: true, data: linha.data_lancamento, unidadeId: linha.unidade_id };
}

// ---------------------------------------------------------------------------
// GET /dashboard-executivo/historico — rollup de 12 meses
// ---------------------------------------------------------------------------
export async function obterHistorico({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, ano: anoRaw }) {
  const ano = v.numero(anoRaw, "Ano", { min: 2000, max: 2100 });
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: false });

  let q = supabase.from(TABELA).select("*")
    .gte("data_lancamento", `${ano}-01-01`).lte("data_lancamento", `${ano}-12-31`)
    .in("status", ["finalizado", "rascunho"]);
  q = unidadeId ? q.eq("unidade_id", unidadeId) : q.eq("organizacao_id", organizacaoId);
  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);

  const hojeIso = hojeIsoBrasil();
  const meses = [];
  let totalMesAnterior = null;
  for (let mes = 1; mes <= 12; mes++) {
    const dias = diasDoMes(ano, mes);
    const linhasMes = (data ?? []).filter((r) => r.data_lancamento >= dias[0] && r.data_lancamento <= dias[dias.length - 1]);
    const linhasFinalizadas = linhasMes.filter((r) => r.status === "finalizado");
    // Faturamento = Financeiro (fonte de verdade) = snapshot acumulado mais
    // recente do mês, nunca soma entre dias (um dia finalizado pode não ter
    // financeiro nenhum agora — só é exigido no dia elegível, ver
    // financeiroDisponivelNaData). `null` quando o mês inteiro não tem
    // nenhum snapshot ainda — nunca "R$ 0,00" fingindo que se sabe o valor.
    const snapshot = snapshotFinanceiroMaisRecente(linhasMes);
    const faturamento = snapshot ? Number(snapshot.valor_vendas_ifood) : null;
    const ajustesFavorLoja = snapshot?.ajustes_favor_loja != null ? Number(snapshot.ajustes_favor_loja) : null;
    const ajustesContraLoja = snapshot?.ajustes_contra_loja != null ? Number(snapshot.ajustes_contra_loja) : null;
    const totalDed = totalDeducoes({
      taxasComissoes: snapshot?.taxas_comissoes != null ? Number(snapshot.taxas_comissoes) : null,
      servicosPromocoes: snapshot?.servicos_promocoes != null ? Number(snapshot.servicos_promocoes) : null,
      taxasEntregadores: snapshot?.taxas_entregadores != null ? Number(snapshot.taxas_entregadores) : null,
      ajustesContraLoja,
    });
    const diasFinalizados = linhasFinalizadas.length;
    const diasRascunho = linhasMes.filter((r) => r.status === "rascunho").length;
    const diasVencidosNoMes = dias.filter((d) => d <= hojeIso).length;
    const diasPendentes = Math.max(diasVencidosNoMes - diasFinalizados - diasRascunho, 0);

    // Ticket médio: mesma fonte única de Lançamentos/Visão Geral (ver
    // dashboardExecutivo.calc.js#desempenhoParaTicketMedio) — prioriza o
    // lançamento diário real mais recente com os dois lados conhecidos (já
    // é o ACUMULADO do mês até ali); sem nenhum, soma de volta as fatias do
    // Lançamento Mensal (nunca pega uma fatia isolada, nunca faz média de
    // tickets diários). Um mês sem nenhum dado de Desempenho resulta
    // corretamente em `null`, não em "R$ 0,00".
    const parTicketMedio = desempenhoParaTicketMedio(linhasMes);
    const qtdVendas = parTicketMedio?.qtdVendas ?? null;
    const linhasDesempenhoPorUnidade = new Map();
    for (const linha of linhasMes) {
      if (!linhasDesempenhoPorUnidade.has(linha.unidade_id)) linhasDesempenhoPorUnidade.set(linha.unidade_id, []);
      linhasDesempenhoPorUnidade.get(linha.unidade_id).push(linha);
    }
    const novosClientesPorUnidade = [...linhasDesempenhoPorUnidade.values()]
      .map((linhasDaUnidade) => novosClientesAcumulados(dias, linhasDaUnidade))
      .filter((valor) => valor != null);
    const novosClientes = novosClientesPorUnidade.length
      ? novosClientesPorUnidade.reduce((s, valor) => s + Number(valor), 0)
      : null;

    // Média diária: o snapshot já é o acumulado de dia 1 até `data_lancamento`
    // — divide por quantos dias ele cobre, nunca por "dias com dados" (ver
    // mesmo raciocínio em obterMesDeUmaUnidade).
    const diasNoSnapshot = snapshot ? Number(snapshot.data_lancamento.slice(8, 10)) : 0;
    const media = snapshot && diasNoSnapshot > 0 ? Number(snapshot.valor_vendas_ifood) / diasNoSnapshot : null;
    const statusMesRotulo = ano * 100 + mes > Number(hojeIso.slice(0, 7).replace("-", ""))
      ? "futuro"
      : (diasPendentes > 0 ? "incompleto" : (diasFinalizados > 0 ? "completo" : "sem_dados"));

    const comparativoMesAnteriorPct = faturamento != null && totalMesAnterior != null && totalMesAnterior > 0
      ? ((faturamento - totalMesAnterior) / totalMesAnterior) * 100 : null;

    meses.push({
      mes, ano, status: statusMesRotulo,
      diasPreenchidos: diasFinalizados, diasPendentes, diasRascunho,
      faturamento, qtdVendas, novosClientes,
      ticketMedio: ticketMedio(parTicketMedio?.valorVendasBruto ?? null, qtdVendas),
      ajustesFavorLoja, ajustesContraLoja,
      totalDeducoes: totalDed,
      percentualDeducoes: percentual(totalDed, faturamento),
      receitaLiquida: faturamento != null ? receitaLiquida(faturamento, totalDed, ajustesFavorLoja) : null,
      mediaDiaria: media,
      projecaoMensal: projecaoMensal(media, dias.length),
      comparativoMesAnteriorPct,
    });
    totalMesAnterior = faturamento != null && faturamento > 0 ? faturamento : totalMesAnterior;
  }

  return { ano, unidadeId, meses };
}

// ---------------------------------------------------------------------------
// LANÇAMENTO DE FATURAMENTO MENSAL
//
// Para meses históricos onde o franqueado só sabe o total do mês, não o
// detalhe por dia. Distribui o valor pelos dias SEM lançamento (nunca
// sobrescreve um dia que já tem registro — rascunho ou finalizado, qualquer
// situação). Cada dia gerado nasce com origem_lancamento='distribuicao_mensal'
// e SEM Desempenho/detalhamento financeiro (null — não inventa o que não se
// sabe). Mesmo endpoint faz preview (confirmar=false) e execução
// (confirmar=true), igual ao padrão já usado no reset de teste.
// ---------------------------------------------------------------------------

async function localizarDiasParaDistribuicao({ unidadeId, ano, mes, hojeIso }) {
  const diasDoMesTodos = diasDoMes(ano, mes);
  const diasElegiveis = diasDoMesTodos.filter((d) => d <= hojeIso); // nunca no futuro
  if (!diasElegiveis.length) {
    return { diasDoMesTodos, diasComLancamento: [], diasElegiveisParaDistribuir: [] };
  }
  const { data, error } = await supabase
    .from(TABELA).select("data_lancamento").eq("unidade_id", unidadeId)
    .gte("data_lancamento", diasElegiveis[0]).lte("data_lancamento", diasElegiveis[diasElegiveis.length - 1]);
  if (error) throw ApiError.internal(error.message);
  const comLancamento = new Set((data ?? []).map((r) => r.data_lancamento));
  return {
    diasDoMesTodos,
    diasComLancamento: [...comLancamento],
    diasElegiveisParaDistribuir: diasElegiveis.filter((d) => !comLancamento.has(d)),
  };
}

// Campos extras do lançamento mensal: TODOS opcionais — o franqueado pode
// saber só o faturamento total, ou também os totais de pedidos/deduções do
// mês. O que não for informado continua null em cada dia gerado (nunca 0).
const CAMPOS_EXTRAS_MENSAL = [
  ["qtdVendasTotal", "Quantidade de pedidos do mês"],
  ["valorVendasBrutoTotal", "Valor bruto de vendas do mês"],
  ["novosClientesTotal", "Novos clientes do mês"],
  ["taxasComissoesTotal", "Taxas e comissões do mês"],
  ["servicosPromocoesTotal", "Serviços e promoções do mês"],
  ["taxasEntregadoresTotal", "Taxas de entregadores do mês"],
  ["ajustesFavorLojaTotal", "Ajustes a favor da loja no mês"],
  ["ajustesContraLojaTotal", "Ajustes contra a loja no mês"],
];

function validarEntradaLancamentoMensal({ mesRaw, anoRaw, valorRaw, extrasRaw }) {
  const mes = v.numero(mesRaw, "Mês", { min: 1, max: 12 });
  const ano = v.numero(anoRaw, "Ano", { min: 2000, max: 2100 });
  const valorTotalMensal = v.numero(valorRaw, "Faturamento total do mês", { min: 0.01 });
  const extras = {};
  for (const [campo, rotulo] of CAMPOS_EXTRAS_MENSAL) {
    extras[campo] = v.numeroOpcionalNulo(extrasRaw?.[campo], rotulo, { min: 0 });
  }
  return { mes, ano, valorTotalMensal, extras };
}

// Nome da coluna, em `lancamentos_financeiros_diarios`, que carrega a fatia
// diária de cada campo extra do lançamento mensal.
const COLUNA_DIARIA_EXTRA = {
  qtdVendasTotal: "qtd_vendas",
  valorVendasBrutoTotal: "valor_vendas_bruto",
  novosClientesTotal: "novos_clientes",
  taxasComissoesTotal: "taxas_comissoes",
  servicosPromocoesTotal: "servicos_promocoes",
  taxasEntregadoresTotal: "taxas_entregadores",
  ajustesFavorLojaTotal: "ajustes_favor_loja",
  ajustesContraLojaTotal: "ajustes_contra_loja",
};

/** Modelos vigentes (na linha do tempo da unidade) nos dias que o lote cobre. */
function modelosDoLoteMensal(modelo, linhasDoLote) {
  const linhaDoTempo = modelo.linhaDoTempo ?? montarLinhaDoTempo({ modeloAtual: modelo.modeloLogistico });
  return modelosDasDatas(linhaDoTempo, (linhasDoLote ?? []).map((r) => r.data_lancamento), [modelo.modeloLogistico]);
}

/** `true` só quando a chave está de fato presente no corpo (distingue "não editou" de "editou para vazio/null"). */
function campoInformado(body, chave) {
  return Object.prototype.hasOwnProperty.call(body, chave);
}

/** Lote mais recente de distribuição mensal para esta unidade/ano/mês, ou `null`. Só há um lote "ativo" por mês (ver `lancamentoMensal`, que bloqueia um segundo). */
async function buscarLoteMensalDoMes({ unidadeId, ano, mes }) {
  const { data, error } = await supabase
    .from(TABELA_MENSAL).select("*").eq("unidade_id", unidadeId).eq("ano", ano).eq("mes", mes)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data;
}

/**
 * Projeta um lote + os dias diários vinculados a ele para a API — a
 * "leitura do lançamento mensal original" pedida no item 1 (não confundir
 * com os valores diários distribuídos: aqui é o total que o franqueado
 * informou, reconstituído a partir do que foi de fato gravado). Os totais
 * dos campos extras são a SOMA das fatias diárias do lote — nunca uma
 * cópia guardada à parte — porque a soma de `distribuirValorMensal`/
 * `distribuirQuantidadeMensal` é sempre exatamente igual ao total original
 * (ver dashboardExecutivo.calc.js), então não há uma segunda fonte de
 * verdade para divergir.
 *
 * `modeloLogistico` decide a APLICABILIDADE de cada campo extra: um campo que
 * nem existe no modelo da unidade (ex.: "taxas de entregadores" no Full
 * Service) nunca entra em `camposPendentes` — é listado à parte em
 * `camposNaoAplicaveis`. "Não aplicável" ≠ "faltando" ≠ "zero" (ver
 * dashboardExecutivo.calc.js#campoExtraMensalAplicavel / INDICADORES_POR_MODELO).
 */
function montarResumoLoteMensal(lote, linhasDoLote, modeloLogistico) {
  if (!lote) return null;
  const somaNulavel = (coluna) => {
    const valores = linhasDoLote.map((r) => r[coluna]).filter((x) => x != null);
    return valores.length ? valores.reduce((s, x) => s + Number(x), 0) : null;
  };
  const extras = {};
  for (const [campo] of CAMPOS_EXTRAS_MENSAL) extras[campo] = somaNulavel(COLUNA_DIARIA_EXTRA[campo]);
  // Aplicabilidade + preenchimento: fonte única em calc.js. Um campo que não
  // existe no modelo logístico da unidade (ex.: entregadores no Full Service)
  // nunca vira "pendência" — vai para `camposNaoAplicaveis`.
  const { pendentes: camposPendentes, naoAplicaveis: camposNaoAplicaveis } =
    classificarCamposExtrasMensal(CAMPOS_EXTRAS_MENSAL, extras, modeloLogistico);
  const valorTotalMensal = lote.valor_total_centavos / 100;

  return {
    id: lote.id,
    unidadeId: lote.unidade_id,
    mes: lote.mes,
    ano: lote.ano,
    origem: "monthly_distribution",
    valorTotalMensal,
    diasDistribuidos: lote.dias_distribuidos,
    valorMedioAproximado: lote.dias_distribuidos > 0 ? valorTotalMensal / lote.dias_distribuidos : null,
    diasCriados: linhasDoLote.map((r) => r.data_lancamento).sort(),
    extras,
    // Ticket médio do mês (Desempenho) = valor bruto de vendas ÷ quantidade
    // de pedidos, MESMA função central do diário (ver
    // dashboardExecutivo.calc.js#ticketMedio) — nunca um campo manual, e
    // nunca deriva do Financeiro. Sem os dois totais informados, fica null
    // ("Não informado" no frontend), nunca 0.
    ticketMedio: ticketMedio(extras.valorVendasBrutoTotal, extras.qtdVendasTotal),
    camposPendentes,
    camposNaoAplicaveis,
    criadoEm: lote.created_at,
    criadoPor: { id: lote.usuario_id ?? null, nome: lote.usuario_nome ?? null, email: lote.usuario_email ?? null },
    atualizadoEm: lote.updated_at ?? lote.created_at,
    atualizadoPor: lote.atualizado_por_nome || lote.atualizado_por_email
      ? { id: lote.atualizado_por_id ?? null, nome: lote.atualizado_por_nome ?? null, email: lote.atualizado_por_email ?? null }
      : null,
  };
}

/** Auditoria do LOTE (criado/editado/excluído) — nunca derruba a operação se falhar (mesmo espírito de `registrarAuditoria`). */
async function registrarAuditoriaMensal({ distribuicaoMensalId, organizacaoId, unidadeId, ano, mes, acao, camposAlterados, usuario }) {
  const { error } = await supabase.from(TABELA_MENSAL_AUDITORIA).insert({
    distribuicao_mensal_id: distribuicaoMensalId,
    organizacao_id: organizacaoId, unidade_id: unidadeId, ano, mes, acao,
    campos_alterados: camposAlterados ?? null,
    usuario_id: usuario?.id ?? null, usuario_nome: usuario?.nome ?? null, usuario_email: usuario?.email ?? null,
  });
  if (error) console.error("[dashboard-executivo] falha ao registrar auditoria do lançamento mensal:", error.message);
}

// ---------------------------------------------------------------------------
// GET /dashboard-executivo/lancamentos-mensais — item 1 do pedido: ver o
// lançamento mensal ORIGINAL (não os valores diários que ele gerou).
// ---------------------------------------------------------------------------
export async function obterLancamentoMensal({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, mes: mesRaw, ano: anoRaw }) {
  const mes = v.numero(mesRaw, "Mês", { min: 1, max: 12 });
  const ano = v.numero(anoRaw, "Ano", { min: 2000, max: 2100 });
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: true });

  const lote = await buscarLoteMensalDoMes({ unidadeId, ano, mes });
  if (!lote) return { existe: false, mes, ano, unidadeId };

  const { data: linhasDoLote, error } = await supabase
    .from(TABELA).select("*").eq("distribuicao_mensal_id", lote.id).order("data_lancamento");
  if (error) throw ApiError.internal(error.message);

  // Modelo(s) vigente(s) NOS DIAS que o lote cobre (linha do tempo da unidade) —
  // decide quais campos extras são "não aplicáveis" e não devem virar pendência.
  // Um lote de dias Full Service não cobra Entregadores; um de dias Marketplace cobra.
  const modelo = await obterModeloLogistico({ unidadeId, organizacaoId });
  const modelosDoLote = modelosDoLoteMensal(modelo, linhasDoLote);
  return {
    existe: true,
    modeloLogistico: modelo.modeloLogistico,
    modeloLogisticoRotulo: modelo.modeloLogisticoRotulo,
    modelosDoLote,
    atravessaTrocaDeModelo: modelosDoLote.length > 1,
    ...montarResumoLoteMensal(lote, linhasDoLote ?? [], modelosDoLote),
  };
}

export async function lancamentoMensal({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, usuario, dados: body, confirmar }) {
  const b = v.corpo(body);
  const { mes, ano, valorTotalMensal, extras } = validarEntradaLancamentoMensal({
    mesRaw: b.mes, anoRaw: b.ano, valorRaw: b.valorTotalMensal, extrasRaw: b,
  });
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado: b.unidadeId, exigirEspecifica: true });
  const hojeIso = hojeIsoBrasil();

  // Item 8 do pedido: um mês já lançado NUNCA bloqueia sem saída — em vez de
  // tentar (e falhar por falta de dia elegível) criar um SEGUNDO lote para o
  // mesmo mês, aponta direto para o gerenciamento do lote existente
  // (visualizar/editar/excluir, ver obterLancamentoMensal/atualizarLancamentoMensal).
  const loteExistente = await buscarLoteMensalDoMes({ unidadeId, ano, mes });
  if (loteExistente) {
    throw new ApiError(409,
      "Este mês já possui um lançamento de faturamento mensal. Abra o lançamento existente para visualizar, complementar ou excluir.",
      { lancamentoMensalId: loteExistente.id, existente: true });
  }

  const { diasDoMesTodos, diasComLancamento, diasElegiveisParaDistribuir } =
    await localizarDiasParaDistribuicao({ unidadeId, ano, mes, hojeIso });

  if (!diasElegiveisParaDistribuir.length) {
    throw ApiError.badRequest(
      diasComLancamento.length
        ? "Todos os dias já decorridos deste mês já têm lançamento individual — não há dia disponível para a distribuição."
        : "Este mês ainda não tem nenhum dia decorrido para receber a distribuição.",
    );
  }

  // O lote é UM total do mês espalhado em fatias UNIFORMES por dia. Se os dias a
  // distribuir atravessam uma troca de modelo (Marketplace -> Full Service), as
  // fatias de cada regime seriam um artefato da divisão uniforme — não dá para
  // atribuir com segurança as parcelas (ex.: Entregadores, que só existem no
  // Marketplace) a cada regime. Em vez de uma gambiarra, bloqueia e orienta.
  const modeloDaUnidade = await obterModeloLogistico({ unidadeId, organizacaoId });
  const linhaDoTempoLote = modeloDaUnidade.linhaDoTempo ?? montarLinhaDoTempo({ modeloAtual: modeloDaUnidade.modeloLogistico });
  const modelosDosDias = modelosDasDatas(linhaDoTempoLote, diasElegiveisParaDistribuir);
  if (modelosDosDias.length > 1) {
    throw new ApiError(409,
      "Os dias a distribuir atravessam a troca de modelo logístico (Marketplace e Full Service no mesmo período). "
      + "Um lançamento mensal não pode ser dividido entre modelos com segurança: lance os dias individualmente "
      + "(acumulado diário), incluindo o dia da véspera da troca.",
      { atravessaTrocaDeModelo: true, modelos: modelosDosDias });
  }

  const preview = {
    mes, ano, valorTotalMensal,
    diasNoMes: diasDoMesTodos.length,
    diasComLancamento: diasComLancamento.length,
    diasParaDistribuir: diasElegiveisParaDistribuir.length,
    valorMedioAproximado: valorTotalMensal / diasElegiveisParaDistribuir.length,
    // Só informativo pro preview mostrar o que também será distribuído.
    camposExtrasInformados: CAMPOS_EXTRAS_MENSAL.filter(([campo]) => extras[campo] != null).map(([campo]) => campo),
  };
  if (!confirmar) return preview;

  const n = diasElegiveisParaDistribuir.length;
  const fatias = distribuirValorMensal(valorTotalMensal, n);
  // Cada campo extra só é distribuído se o franqueado informou o total —
  // senão fica null em todo dia (nunca 0). Contagens usam distribuição
  // inteira; valores em R$ usam a mesma exatidão em centavos do faturamento.
  const fatiasQtdVendas = extras.qtdVendasTotal != null ? distribuirQuantidadeMensal(extras.qtdVendasTotal, n) : null;
  const fatiasValorVendasBruto = extras.valorVendasBrutoTotal != null ? distribuirValorMensal(extras.valorVendasBrutoTotal, n) : null;
  const fatiasNovosClientes = extras.novosClientesTotal != null ? distribuirQuantidadeMensal(extras.novosClientesTotal, n) : null;
  const fatiasTaxasComissoes = extras.taxasComissoesTotal != null ? distribuirValorMensal(extras.taxasComissoesTotal, n) : null;
  const fatiasServicosPromocoes = extras.servicosPromocoesTotal != null ? distribuirValorMensal(extras.servicosPromocoesTotal, n) : null;
  const fatiasTaxasEntregadores = extras.taxasEntregadoresTotal != null ? distribuirValorMensal(extras.taxasEntregadoresTotal, n) : null;
  const fatiasAjustesFavor = extras.ajustesFavorLojaTotal != null ? distribuirValorMensal(extras.ajustesFavorLojaTotal, n) : null;
  const fatiasAjustesContra = extras.ajustesContraLojaTotal != null ? distribuirValorMensal(extras.ajustesContraLojaTotal, n) : null;

  const { data: lote, error: eLote } = await supabase.from("lancamentos_financeiros_distribuicao_mensal").insert({
    organizacao_id: organizacaoId, unidade_id: unidadeId, ano, mes,
    valor_total_centavos: Math.round(valorTotalMensal * 100),
    dias_distribuidos: n,
    usuario_id: usuario?.id ?? null, usuario_nome: usuario?.nome ?? null, usuario_email: usuario?.email ?? null,
  }).select("id").single();
  if (eLote) throw ApiError.badRequest(eLote.message);

  const linhas = diasElegiveisParaDistribuir.map((dataLancamento, i) => ({
    organizacao_id: organizacaoId, unidade_id: unidadeId, data_lancamento: dataLancamento,
    situacao: "normal", status: "finalizado",
    origem_lancamento: "distribuicao_mensal", distribuicao_mensal_id: lote.id,
    valor_vendas_ifood: fatias[i],
    qtd_vendas: fatiasQtdVendas ? fatiasQtdVendas[i] : null,
    // valor_vendas_bruto (Desempenho) é um total INDEPENDENTE do franqueado
    // (valorVendasBrutoTotal) — nunca reaproveita a fatia do Financeiro
    // (valor_vendas_ifood). Sem o total de Desempenho informado, fica null
    // (mesmo comportamento do lançamento diário: sem os dois lados, sem
    // ticket médio — ver dashboardExecutivo.calc.js#ticketMedio).
    valor_vendas_bruto: fatiasValorVendasBruto ? fatiasValorVendasBruto[i] : null,
    novos_clientes: fatiasNovosClientes ? fatiasNovosClientes[i] : null,
    taxas_comissoes: fatiasTaxasComissoes ? fatiasTaxasComissoes[i] : null,
    servicos_promocoes: fatiasServicosPromocoes ? fatiasServicosPromocoes[i] : null,
    taxas_entregadores: fatiasTaxasEntregadores ? fatiasTaxasEntregadores[i] : null,
    ajustes_favor_loja: fatiasAjustesFavor ? fatiasAjustesFavor[i] : null,
    ajustes_contra_loja: fatiasAjustesContra ? fatiasAjustesContra[i] : null,
    usuario_id: usuario?.id ?? null, usuario_nome: usuario?.nome ?? null, usuario_email: usuario?.email ?? null,
    finalizado_em: new Date().toISOString(),
  }));

  const { error: eIns } = await supabase.from(TABELA).insert(linhas);
  if (eIns) {
    // Não deixa um lote órfão se a inserção dos dias falhar no meio (ex.:
    // corrida com um lançamento diário criado entre o preview e a confirmação).
    await supabase.from("lancamentos_financeiros_distribuicao_mensal").delete().eq("id", lote.id);
    if (/duplicate key|unique/i.test(eIns.message)) {
      throw new ApiError(409, "Algum dia deste mês recebeu um lançamento entre a prévia e a confirmação. Recarregue e tente novamente.");
    }
    throw ApiError.badRequest(eIns.message);
  }

  await registrarAuditoriaMensal({
    distribuicaoMensalId: lote.id, organizacaoId, unidadeId, ano, mes, acao: "criado",
    camposAlterados: { valorTotalMensal, diasDistribuidos: n, ...Object.fromEntries(Object.entries(extras).filter(([, valor]) => valor != null)) },
    usuario,
  });

  // Um evento só, mesmo distribuindo N dias — o front refaz o mês inteiro
  // (carregarConteudo) de qualquer forma; emitir por linha seria ruído.
  await emitirEventoRealtime({
    tipo: EVENTOS_DASHBOARD_IFOOD.LANCAMENTO_MENSAL_ATUALIZADO,
    organizacaoId, unidadeId, competencia: competenciaDe(ano, mes),
    entidadeId: lote.id, versao: new Date().toISOString(),
  });

  return { ...preview, confirmado: true, distribuicaoId: lote.id, diasCriados: diasElegiveisParaDistribuir };
}

// ---------------------------------------------------------------------------
// PUT /dashboard-executivo/lancamentos-mensais/:id — item 2/3 do pedido:
// editar/complementar SEM apagar o que já tinha, e recalcular a distribuição
// diária quando o faturamento muda (mantendo a soma exata em centavos).
// Os dias que pertencem ao lote são sempre os mesmos de quando ele foi
// criado — editar nunca muda QUAIS dias, só os valores desses dias (ver
// dashboardExecutivo.calc.js#recalcularDistribuicaoMensal).
// ---------------------------------------------------------------------------
export async function atualizarLancamentoMensal({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, usuario, id, dados: body }) {
  const loteId = v.uuid(id, "Lançamento mensal");
  const b = v.corpo(body);

  const { data: lote, error: eLote } = await supabase.from(TABELA_MENSAL).select("*").eq("id", loteId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (eLote) throw ApiError.internal(eLote.message);
  if (!lote) throw ApiError.notFound("Lançamento mensal não encontrado.");

  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado: unidadeIdSolicitado ?? lote.unidade_id, exigirEspecifica: true });
  if (lote.unidade_id !== unidadeId) throw ApiError.forbidden("Você não tem acesso a este lançamento.");

  // Modelo logístico da unidade (fonte canônica: unidades.modelo_logistico_ifood)
  // — decide a aplicabilidade dos campos extras no resumo devolvido (um campo
  // que não existe no modelo nunca vira "pendência"; ver montarResumoLoteMensal).
  const modelo = await obterModeloLogistico({ unidadeId, organizacaoId });
  const resumo = (loteArg, linhasArg) => {
    const modelosDoLote = modelosDoLoteMensal(modelo, linhasArg);
    return {
      existe: true,
      modeloLogistico: modelo.modeloLogistico,
      modeloLogisticoRotulo: modelo.modeloLogisticoRotulo,
      modelosDoLote,
      atravessaTrocaDeModelo: modelosDoLote.length > 1,
      ...montarResumoLoteMensal(loteArg, linhasArg, modelosDoLote),
    };
  };

  const { data: linhas, error: eLinhas } = await supabase
    .from(TABELA).select("*").eq("distribuicao_mensal_id", loteId).order("data_lancamento");
  if (eLinhas) throw ApiError.internal(eLinhas.message);
  if (!linhas?.length) {
    throw ApiError.badRequest("Este lançamento mensal não tem mais dias vinculados a ele (podem ter sido removidos individualmente). Exclua o lote e lance novamente.");
  }
  const n = linhas.length;

  // Só valida/entra no patch o que o corpo realmente trouxe — chave ausente
  // preserva o valor salvo (regra "não apagar em silêncio" do item 2).
  const valorAtual = lote.valor_total_centavos / 100;
  const patch = {};
  if (campoInformado(b, "valorTotalMensal")) {
    patch.valorTotalMensal = v.numero(b.valorTotalMensal, "Faturamento total do mês", { min: 0.01 });
  }
  const extrasAtuais = {};
  for (const [campo] of CAMPOS_EXTRAS_MENSAL) {
    const valores = linhas.map((r) => r[COLUNA_DIARIA_EXTRA[campo]]).filter((x) => x != null);
    extrasAtuais[campo] = valores.length ? valores.reduce((s, x) => s + Number(x), 0) : null;
  }
  const patchExtras = {};
  for (const [campo, rotulo] of CAMPOS_EXTRAS_MENSAL) {
    if (campoInformado(b, campo)) patchExtras[campo] = v.numeroOpcionalNulo(b[campo], rotulo, { min: 0 });
  }
  if (Object.keys(patchExtras).length) patch.extras = patchExtras;

  // Nada foi de fato enviado (PUT vazio) — devolve o estado atual sem tocar no banco.
  if (!campoInformado(b, "valorTotalMensal") && !Object.keys(patchExtras).length) {
    return resumo(lote, linhas);
  }

  const { valorTotalMensal: valorNovo, extras: extrasNovos, fatiasPorCampo } =
    recalcularDistribuicaoMensal({ valorAtual, extrasAtuais, patch, quantidadeDias: n });

  // Diff pra auditoria — só entra o que realmente mudou de valor.
  const camposAlterados = {};
  if (valorNovo !== valorAtual) camposAlterados.valorTotalMensal = { de: valorAtual, para: valorNovo };
  for (const [campo] of CAMPOS_EXTRAS_MENSAL) {
    if (extrasNovos[campo] !== extrasAtuais[campo]) camposAlterados[campo] = { de: extrasAtuais[campo], para: extrasNovos[campo] };
  }
  if (!Object.keys(camposAlterados).length) {
    // Reenviou os mesmos valores já salvos — nada mudou de fato.
    return resumo(lote, linhas);
  }

  const resultados = await Promise.all(linhas.map((linha, i) => {
    const patchLinha = {
      valor_vendas_ifood: fatiasPorCampo.valorVendasIfood[i],
      // Mesma regra da criação: valor_vendas_bruto vem só do total
      // INDEPENDENTE de Desempenho (valorVendasBrutoTotal), nunca da fatia
      // do Financeiro (ver lancamentoMensal acima).
      valor_vendas_bruto: fatiasPorCampo.valorVendasBrutoTotal ? fatiasPorCampo.valorVendasBrutoTotal[i] : null,
      qtd_vendas: fatiasPorCampo.qtdVendasTotal ? fatiasPorCampo.qtdVendasTotal[i] : null,
      novos_clientes: fatiasPorCampo.novosClientesTotal ? fatiasPorCampo.novosClientesTotal[i] : null,
      taxas_comissoes: fatiasPorCampo.taxasComissoesTotal ? fatiasPorCampo.taxasComissoesTotal[i] : null,
      servicos_promocoes: fatiasPorCampo.servicosPromocoesTotal ? fatiasPorCampo.servicosPromocoesTotal[i] : null,
      taxas_entregadores: fatiasPorCampo.taxasEntregadoresTotal ? fatiasPorCampo.taxasEntregadoresTotal[i] : null,
      ajustes_favor_loja: fatiasPorCampo.ajustesFavorLojaTotal ? fatiasPorCampo.ajustesFavorLojaTotal[i] : null,
      ajustes_contra_loja: fatiasPorCampo.ajustesContraLojaTotal ? fatiasPorCampo.ajustesContraLojaTotal[i] : null,
    };
    return supabase.from(TABELA).update(patchLinha).eq("id", linha.id);
  }));
  const eFalha = resultados.find((r) => r.error);
  if (eFalha) throw ApiError.badRequest(eFalha.error.message);

  const { data: loteAtualizado, error: eUpd } = await supabase.from(TABELA_MENSAL).update({
    valor_total_centavos: Math.round(valorNovo * 100),
    updated_at: new Date().toISOString(),
    atualizado_por_id: usuario?.id ?? null, atualizado_por_nome: usuario?.nome ?? null, atualizado_por_email: usuario?.email ?? null,
  }).eq("id", loteId).select("*").single();
  if (eUpd) throw ApiError.badRequest(eUpd.message);

  await registrarAuditoriaMensal({
    distribuicaoMensalId: loteId, organizacaoId, unidadeId, ano: lote.ano, mes: lote.mes, acao: "editado", camposAlterados, usuario,
  });

  const { data: linhasFinal, error: eFinal } = await supabase
    .from(TABELA).select("*").eq("distribuicao_mensal_id", loteId).order("data_lancamento");
  if (eFinal) throw ApiError.internal(eFinal.message);

  await emitirEventoRealtime({
    tipo: EVENTOS_DASHBOARD_IFOOD.LANCAMENTO_MENSAL_ATUALIZADO,
    organizacaoId, unidadeId, competencia: competenciaDe(lote.ano, lote.mes),
    entidadeId: loteId, versao: loteAtualizado.updated_at,
  });

  return resumo(loteAtualizado, linhasFinal ?? []);
}

// ---------------------------------------------------------------------------
// POST /dashboard-executivo/lancamentos-mensais/:id/excluir — item 4/5 do
// pedido: remove SÓ os dias que este lote gerou (origem_lancamento =
// 'distribuicao_mensal' vinculados a `distribuicao_mensal_id = id`) — nunca
// um lançamento manual, mesmo que esteja no mesmo mês, porque manual nunca
// carrega esse vínculo. Snapshot de cada dia ANTES de apagar, no mesmo log
// universal de exclusões usado pela exclusão de um dia avulso (migration 027).
// ---------------------------------------------------------------------------
export async function excluirLancamentoMensal({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, usuario, id, motivo: motivoRaw }) {
  const loteId = v.uuid(id, "Lançamento mensal");
  const motivo = v.texto(motivoRaw, "Motivo da exclusão", { min: 3, max: 500 });

  const { data: lote, error: eLote } = await supabase.from(TABELA_MENSAL).select("*").eq("id", loteId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (eLote) throw ApiError.internal(eLote.message);
  if (!lote) throw ApiError.notFound("Lançamento mensal não encontrado.");

  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado: unidadeIdSolicitado ?? lote.unidade_id, exigirEspecifica: true });
  if (lote.unidade_id !== unidadeId) throw ApiError.forbidden("Você não tem acesso a este lançamento.");

  const { data: linhas, error: eLinhas } = await supabase.from(TABELA).select("*").eq("distribuicao_mensal_id", loteId);
  if (eLinhas) throw ApiError.internal(eLinhas.message);

  if (linhas?.length) {
    const { error: eLog } = await supabase.from("lancamentos_financeiros_exclusoes").insert(
      linhas.map((linha) => ({
        organizacao_id: organizacaoId, unidade_id: linha.unidade_id, data_lancamento: linha.data_lancamento,
        lancamento_snapshot: linha, motivo: `Exclusão de lançamento mensal (${lote.mes}/${lote.ano}): ${motivo}`,
        usuario_id: usuario?.id ?? null, usuario_nome: usuario?.nome ?? null, usuario_email: usuario?.email ?? null,
      })),
    );
    if (eLog) console.error("[dashboard-executivo] falha ao registrar log de exclusão (mensal):", eLog.message);
  }

  // Auditoria ANTES de apagar o lote — a FK de distribuicao_mensal_id é ON
  // DELETE SET NULL (não CASCADE), então este registro sobrevive à exclusão
  // do lote que ele descreve (ver migration 033).
  await registrarAuditoriaMensal({
    distribuicaoMensalId: loteId, organizacaoId, unidadeId, ano: lote.ano, mes: lote.mes, acao: "excluido",
    camposAlterados: { valorTotalMensal: lote.valor_total_centavos / 100, diasRemovidos: linhas?.length ?? 0 },
    usuario,
  });

  if (linhas?.length) {
    const { error: eDel } = await supabase.from(TABELA).delete().eq("distribuicao_mensal_id", loteId);
    if (eDel) throw ApiError.badRequest(eDel.message);
  }
  const { error: eDelLote } = await supabase.from(TABELA_MENSAL).delete().eq("id", loteId);
  if (eDelLote) throw ApiError.badRequest(eDelLote.message);

  await emitirEventoRealtime({
    tipo: EVENTOS_DASHBOARD_IFOOD.LANCAMENTO_MENSAL_ATUALIZADO,
    organizacaoId, unidadeId, competencia: competenciaDe(lote.ano, lote.mes),
    entidadeId: loteId, versao: new Date().toISOString(),
  });

  return { excluido: true, mes: lote.mes, ano: lote.ano, diasRemovidos: linhas?.length ?? 0 };
}

// ---------------------------------------------------------------------------
// RESET DE DIA — SÓ EM UNIDADE DE TESTE (eh_teste = true).
//
// Exclusão física de verdade, algo que NUNCA existe pra unidade real (ver
// criarLancamento/atualizarLancamento acima — nenhum DELETE ali, de propósito).
// A checagem de eh_teste é SEMPRE buscada fresca no banco aqui, nunca confiada
// a partir do cliente — mesmo que alguém chame a rota direto na unha para a
// Subway Saci, isto recusa.
// ---------------------------------------------------------------------------
async function garantirUnidadeDeTeste({ unidadeId, organizacaoId }) {
  const { data, error } = await supabase
    .from("unidades").select("id, organizacao_id, eh_teste").eq("id", unidadeId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data || data.organizacao_id !== organizacaoId) throw ApiError.notFound("Unidade não encontrada.");
  if (!data.eh_teste) {
    throw ApiError.forbidden("O reset de lançamentos só está disponível em unidades de teste.");
  }
}

async function lancamentosAPartirDe({ unidadeId, dataAlvo }) {
  const { data, error } = await supabase
    .from(TABELA).select("id, data_lancamento").eq("unidade_id", unidadeId)
    .gte("data_lancamento", dataAlvo).order("data_lancamento");
  if (error) throw ApiError.internal(error.message);
  return (data ?? []).map((l) => ({ id: l.id, data: l.data_lancamento }));
}

/** Preview (dry-run): quais lançamentos seriam removidos, sem apagar nada. */
export async function previewResetTeste({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, data: dataRaw }) {
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: true });
  await garantirUnidadeDeTeste({ unidadeId, organizacaoId });
  const dataAlvo = v.dataOpcional(dataRaw, "Data") ?? (() => { throw ApiError.badRequest("Data é obrigatória."); })();

  const lancamentos = await lancamentosAPartirDe({ unidadeId, dataAlvo });
  if (!lancamentos.length) throw ApiError.notFound("Não existe lançamento nesta data (ou posterior) para resetar.");

  return { unidadeId, dataAlvo, lancamentos };
}

/** Executa de fato: apaga a partir da data (inclusive) e registra o log de teste. */
export async function executarResetTeste({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, data: dataRaw, usuario }) {
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: true });
  await garantirUnidadeDeTeste({ unidadeId, organizacaoId });
  const dataAlvo = v.dataOpcional(dataRaw, "Data") ?? (() => { throw ApiError.badRequest("Data é obrigatória."); })();

  const lancamentos = await lancamentosAPartirDe({ unidadeId, dataAlvo });
  if (!lancamentos.length) throw ApiError.notFound("Não existe lançamento nesta data (ou posterior) para resetar.");

  // Log ANTES de apagar: se o delete falhar no meio, ao menos fica o registro
  // da tentativa (não é a auditoria financeira real — essa nunca é tocada aqui).
  const { error: eLog } = await supabase.from("dashboard_teste_reset_log").insert({
    organizacao_id: organizacaoId, unidade_id: unidadeId,
    usuario_id: usuario?.id ?? null, usuario_nome: usuario?.nome ?? null, usuario_email: usuario?.email ?? null,
    data_inicial_reset: dataAlvo,
    lancamentos_removidos: lancamentos,
  });
  if (eLog) console.error("[dashboard-executivo] falha ao registrar log de reset de teste:", eLog.message);

  const { error: eDel } = await supabase
    .from(TABELA).delete().eq("unidade_id", unidadeId).gte("data_lancamento", dataAlvo);
  if (eDel) throw ApiError.badRequest(eDel.message);

  return { unidadeId, dataAlvo, removidos: lancamentos.map((l) => l.data) };
}
