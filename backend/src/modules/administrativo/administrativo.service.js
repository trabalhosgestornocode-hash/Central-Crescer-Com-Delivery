// PAINEL ADMINISTRATIVO — orquestração cross-tenant (Fase F).
//
// Junta a camada de I/O (administrativo.repo.js) com o MOTOR PURO
// (administrativo.status.js / administrativo.monitores.js). NENHUMA regra de
// negócio nova mora aqui — só o "carrega em lote -> roda o motor por unidade
// -> consolida" e o formato dos endpoints.
//
// Custo: por chamada de frota são ~5 queries FIXAS (2 catálogos de módulo, 1
// organizações, 1..N unidades por lote, 1..N lançamentos por lote) + O(unidades
// × dias) em memória. NUNCA `for unidade: SELECT`.

import { lerTotalDeducoesRentabilidade } from "../dashboard-executivo/dashboardExecutivo.totalDeducoes.js";
import { calcularProtecaoPrecificacao } from "../dashboard-executivo/dashboardExecutivo.rentabilidade.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import {
  hojeIsoBrasil, diaAnterior, diasDoMes, mesAnterior,
  avaliarUnidade, projetarMes, avaliarDia, pendenciasAntesDe, liberacoesAguardando,
  STATUS_PAINEL, D1_CATEGORIA, ROLLUP,
} from "./administrativo.status.js";
import {
  MONITORES, consolidarOperacao, acaoNecessariaHoje,
  listarPendencias, consolidarEmpresas,
} from "./administrativo.monitores.js";
import {
  listarUnidadesElegiveis, obterOrganizacaoOperacional,
  carregarLancamentosDaFrota, carregarLancamentosDaUnidade, carregarMetasIndicadores, carregarTrocasModeloDaFrota, carregarPrecosReferenciaDaFrota,
} from "./administrativo.repo.js";
import {
  faturamentoDaUnidade, somarFaturamento, coberturaDe,
  rankingFaturamento, rankingConformidade, evolucaoDiaria,
  variacao, variacaoPP, diaEquivalenteNoMesAnterior,
} from "./administrativo.financeiro.js";
import {
  semanaDe, deslocarSemana, primeiroDiaDoMes,
  lucratividadeDaUnidade, agregarRede, folgaLimite,
} from "./administrativo.lucratividade.js";
import {
  classificarAtencaoFinanceira, impactoFinanceiroEstimado,
  composicaoDeducoesDoBloco, somarComposicaoDeducoes,
  filtrarUnidadesRede, ordenarPrioridadeIntervencao, contagemPorSituacao,
} from "./administrativo.visaoRede.js";
import { escolherMetas } from "../dashboard-executivo/dashboardExecutivo.metas.service.js";
import { statusIndicadorRentabilidade, metasComProtecaoPrecificacao, MODELOS_LOGISTICOS, ROTULO_MODELO } from "../dashboard-executivo/dashboardExecutivo.calc.js";
import {
  montarLinhaDoTempo, segmentosDoPeriodo, estadoDoPeriodo, rotuloDoModelo, trocasDeLinhas,
} from "../dashboard-executivo/dashboardExecutivo.modeloTemporal.js";
import { comporMetas, dividirFinanceiroPorSegmento, consolidarSegmentos } from "../dashboard-executivo/dashboardExecutivo.periodoMisto.js";
import { obterMes as obterMesDashboardExecutivo } from "../dashboard-executivo/dashboardExecutivo.service.js";
import {
  carregarDatasLiberadas, listarDesbloqueios, criarDesbloqueio, revogarDesbloqueio,
  obterDesbloqueioAtivoPorId, MOTIVOS_VALIDOS, MOTIVOS_DESBLOQUEIO,
} from "../../shared/desbloqueiosIfood.js";
import { auditar, ACOES } from "../../shared/auditoria.js";

const MONITOR = MONITORES.dashboard_ifood;
const partesData = (iso) => iso.split("-").map(Number); // [ano, mes, dia]

/**
 * Menor intervalo SEGURO para avaliar um dia-alvo: mês do alvo + mês anterior.
 * É o mesmo alcance que `avaliarUnidade` já usa (`diasCorrente` + `diasAnteriores`)
 * e que `dashboardExecutivo.service.js#calcularPendenciasMesAnterior` usa — a
 * fronteira do próprio motor (statusMes reinicia a sequência no dia 1 de cada
 * mês; a pendência atravessa UMA virada de mês). NÃO varre histórico profundo.
 * @param {string} alvoIso
 */
function janelaDoAlvo(alvoIso) {
  const [ano, mes] = partesData(alvoIso);
  const ant = mesAnterior(ano, mes);
  const diasCorr = diasDoMes(ano, mes);
  const diasAnt = diasDoMes(ant.ano, ant.mes);
  return {
    anoAlvo: ano, mesAlvo: mes, ant,
    desdeIso: diasAnt[0],
    ateIso: diasCorr[diasCorr.length - 1],
    diasCorrIso: diasCorr,
    diasAntIso: diasAnt,
  };
}

// ---------------------------------------------------------------------------
// PERÍODO ATIVO (`mes=AAAA-MM`)
// ---------------------------------------------------------------------------
// O painel tem um período ativo. `mes` ausente = mês corrente (comportamento
// histórico, inalterado). O DIA-ALVO derivado do período é:
//   * mês corrente  -> D-1 de hoje (a obrigação viva);
//   * mês passado   -> último dia daquele mês (o mês já fechou por inteiro).
// Mês futuro é recusado — nunca houve obrigação.

/** Valida `AAAA-MM`. `null`/vazio -> null (mês corrente). */
export function validarMes(mes) {
  if (mes === undefined || mes === null || String(mes).trim() === "") return null;
  const m = /^(\d{4})-(\d{2})$/.exec(String(mes).trim());
  if (!m) throw ApiError.badRequest("Período inválido — use AAAA-MM.", { codigo: "PERIODO_INVALIDO" });
  const num = Number(m[2]);
  if (num < 1 || num > 12) throw ApiError.badRequest("Período inválido — mês fora de 01..12.", { codigo: "PERIODO_INVALIDO" });
  return `${m[1]}-${m[2]}`;
}

/**
 * Dia-alvo do período + o próprio período normalizado.
 * @param {string|null|undefined} mes  AAAA-MM (opcional)
 * @param {string} hojeIso
 * @returns {{ periodo: string, dataAlvo: string, mesCorrente: boolean }}
 */
export function alvoDoPeriodo(mes, hojeIso) {
  const pedido = validarMes(mes);
  const mesDeHoje = hojeIso.slice(0, 7);
  const periodo = pedido ?? mesDeHoje;

  if (periodo > mesDeHoje) {
    throw ApiError.badRequest("O período informado ainda não começou — não é possível cobrar um mês futuro.", { codigo: "PERIODO_NAO_VENCIDO" });
  }
  if (periodo === mesDeHoje) {
    return { periodo, dataAlvo: diaAnterior(hojeIso), mesCorrente: true };
  }
  const [ano, num] = periodo.split("-").map(Number);
  const dias = diasDoMes(ano, num);
  return { periodo, dataAlvo: dias[dias.length - 1], mesCorrente: false };
}

/**
 * Avalia a FROTA inteira monitorada por `dashboard_ifood` para um dia-alvo.
 * Padrão: `dataAlvo = D-1` de hoje (a Visão Geral). Qualquer dia PASSADO é
 * aceito (o Monitoramento Diário). Dia futuro/hoje NÃO — nunca é pendência.
 *
 * @param {{ hojeIso?: string, dataAlvo?: string, incluirTeste?: boolean }} [opts]
 * @param {{ supabase?: any }} [deps]
 * @returns {Promise<{ hojeIso: string, referencia: string, monitor: string, unidades: Array<object> }>}
 */
export async function avaliarFrota({ hojeIso, dataAlvo, incluirTeste = false } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const alvo = dataAlvo ?? diaAnterior(hoje);
  if (alvo >= hoje) {
    throw ApiError.badRequest("O dia informado ainda não venceu — não é possível cobrar um lançamento de hoje ou do futuro.", { codigo: "DATA_NAO_VENCIDA" });
  }

  const jan = janelaDoAlvo(alvo);
  const unidades = await listarUnidadesElegiveis({ moduloId: MONITOR.modulo, incluirTeste }, deps);
  if (!unidades.length) {
    return { hojeIso: hoje, referencia: alvo, monitor: MONITOR.chave, unidades: [] };
  }

  const porUnidade = await carregarLancamentosDaFrota({
    unidadeIds: unidades.map((u) => u.unidadeId),
    desdeIso: jan.desdeIso, ateIso: jan.ateIso,
  }, deps);

  const avaliadas = unidades.map((u) => {
    const linhas = porUnidade.get(u.unidadeId) ?? [];
    const porData = new Map(linhas.map((r) => [r.data_lancamento, r]));
    const mkDias = (isos) => isos.map((data) => ({ data, lancamento: porData.get(data) ?? null }));

    const res = avaliarUnidade({
      diasCorrente: mkDias(jan.diasCorrIso),
      diasAnteriores: mkDias(jan.diasAntIso),
      hojeIso: hoje,
      unidadeCriadaEm: u.unidadeCriadaEm,
      dataAlvo: alvo,
    });

    // FINANCEIRO — só as linhas do MÊS do alvo (o mês anterior está carregado
    // para a sequência de pendência, não para o faturamento do período), e
    // cortado no dia-alvo: o faturamento exibido acompanha o que já venceu.
    const linhasDoPeriodo = linhas.filter((r) => jan.diasCorrIso.includes(r.data_lancamento));
    const faturamento = faturamentoDaUnidade(linhasDoPeriodo, { ateDataIso: alvo });

    return { ...u, ...res, faturamento, linhasDoPeriodo, monitor: MONITOR.chave };
  });

  return { hojeIso: hoje, referencia: alvo, monitor: MONITOR.chave, unidades: avaliadas };
}

// ---------------------------------------------------------------------------
// 1. VISÃO GERAL  —  GET /administrativo/visao-geral
// ---------------------------------------------------------------------------
export async function visaoGeral({ hojeIso, mes } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const cons = consolidarOperacao(frota.unidades);
  const acao = acaoNecessariaHoje(frota.unidades);
  const porEmpresa = consolidarEmpresas(frota.unidades);
  // "quem tem problema" em dois números, no topo — o gestor não deve precisar
  // somar cartões para descobrir quantas EMPRESAS estão afetadas.
  const empresasComPendencia = porEmpresa.filter((e) => e.unidadesPendentes > 0);
  const fin = resumoFinanceiroDaRede(frota.unidades, porEmpresa);

  return {
    monitor: frota.monitor,
    dataReferencia: frota.hojeIso,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    resumo: {
      unidadesMonitoradas: cons.unidadesMonitoradas,
      empresasMonitoradas: cons.empresasMonitoradas,
      concluidasD1: cons.d1.concluidas,
      emPreenchimentoD1: cons.d1.emPreenchimento,
      naoRealizadasD1: cons.d1.naoRealizadas,
      sequenciaBloqueadaD1: cons.d1.bloqueadas,
      criticas: cons.criticas,
      atencao: cons.atencao,
      emDia: cons.emDia,
      conformidadeD1: cons.d1.taxa,
      conformidadeMes: cons.conformidadeMes.taxa,
      mesCompleto: cons.conformidadeMes.completos,
      mesEsperado: cons.conformidadeMes.esperados,
      // foco em PENDÊNCIA (o que o painel existe para responder)
      empresasComPendencia: empresasComPendencia.length,
      empresasCriticas: porEmpresa.filter((e) => e.criticas > 0).length,
      unidadesComPendencia: empresasComPendencia.reduce((n, e) => n + e.unidadesPendentes, 0),
      empresasSaudaveis: porEmpresa.length - empresasComPendencia.length,
    },
    faturamento: fin,
    acaoNecessariaHoje: acao.pendentes.map(itemAcao),
    resumoAcao: acao.contadores,
    empresas: porEmpresa,
  };
}

const itemAcao = (it) => ({
  unidadeId: it.unidadeId,
  unidadeNome: it.unidadeNome,
  organizacaoId: it.organizacaoId,
  empresaNome: it.empresaNome,
  categoria: it.categoria,
  pendencia: it.pendencia,   // DO PERÍODO — "X dias", "desde DD/MM"
  herdada: it.herdada,       // o que veio de antes do período (nota, não soma)
});

// ---------------------------------------------------------------------------
// 2. MONITORAMENTO DIÁRIO  —  GET /administrativo/monitoramento-diario
// ---------------------------------------------------------------------------
const CATS_D1 = Object.values(D1_CATEGORIA);
const CRITICIDADES = Object.values(ROLLUP);

export async function monitoramentoDiario({ data, mes, organizacaoId, status, criticidade, hojeIso } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  // `data` explícita manda (o usuário escolheu um dia); senão, o dia-alvo do
  // período ativo. Uma data fora do período pedido continua sendo respeitada —
  // quem passa `data` sabe o que quer.
  const alvo = v.dataOpcional(data, "Data") ?? per.dataAlvo;
  const orgFiltro = organizacaoId ? v.uuid(organizacaoId, "Empresa") : null;
  const statusFiltro = status ? v.umDe(status, "Status", CATS_D1) : null;
  const critFiltro = criticidade ? v.umDe(criticidade, "Criticidade", CRITICIDADES) : null;

  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: alvo }, deps);

  let unidades = frota.unidades;
  if (orgFiltro) unidades = unidades.filter((u) => u.organizacaoId === orgFiltro);
  if (statusFiltro) unidades = unidades.filter((u) => u.d1.categoria === statusFiltro);
  if (critFiltro) unidades = unidades.filter((u) => u.rollup.status === critFiltro);

  return {
    monitor: frota.monitor,
    dataReferencia: frota.hojeIso,
    periodo: alvo.slice(0, 7),
    mesCorrente: alvo.slice(0, 7) === hoje.slice(0, 7),
    referencia: frota.referencia,
    filtros: { organizacaoId: orgFiltro, status: statusFiltro, criticidade: critFiltro },
    total: unidades.length,
    unidades: unidades.map((u) => ({
      unidadeId: u.unidadeId,
      unidadeNome: u.unidadeNome,
      organizacaoId: u.organizacaoId,
      empresaNome: u.empresaNome,
      elegivel: u.d1.elegivel,
      statusDia: u.d1.statusDia ?? null,     // STATUS_DIA original do domínio
      categoria: u.d1.categoria,             // classificação administrativa projetada
      bloqueada: u.d1.bloqueada ?? false,
      criticidade: u.rollup.status,
      motivo: u.rollup.motivo,
      // tudo aqui é DO PERÍODO; o histórico anterior vai separado abaixo
      sequenciaBloqueada: u.pendenciasPeriodo.sequenciaBloqueada,
      pendenciaMaisAntiga: u.pendenciasPeriodo.desde,
      diasPendentes: u.pendenciasPeriodo.total,
      pendenciaHerdada: u.pendenciaHerdada.herdada,
      pendenciaHerdadaDesde: u.pendenciaHerdada.desde,
      diasPendentesHistorico: u.pendenciasAcum.total,
      historicoAnterior: u.historicoAnterior,
      conformidadeMes: u.conformidade.taxa,
      mesCompleto: u.conformidade.completos,
      mesEsperado: u.conformidade.esperados,
      ultimoConcluido: u.ultimos.ultimoCompleto,
      ultimoRegistro: u.ultimos.ultimoRegistro,
      criadaEm: u.unidadeCriadaEm,
    })),
  };
}

// ---------------------------------------------------------------------------
// 3. PENDÊNCIAS  —  GET /administrativo/pendencias
// ---------------------------------------------------------------------------
export async function pendencias({ hojeIso, mes } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const lista = listarPendencias(frota.unidades);
  return {
    monitor: frota.monitor,
    dataReferencia: frota.hojeIso,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    total: lista.length,
    criticas: lista.filter((u) => u.criticidade === ROLLUP.CRITICO).length,
    atencao: lista.filter((u) => u.criticidade === ROLLUP.ATENCAO).length,
    unidades: lista,
    // Organizações que ESTE snapshot monitorou (têm ou não pendência). `unidades` só lista quem
    // tem problema — sem isto, uma organização que zerou as pendências some do snapshot e o
    // módulo de Comunicação nunca resolveria os alertas dela.
    organizacoesMonitoradas: [...new Set(frota.unidades.map((u) => u.organizacaoId))],
  };
}

// ---------------------------------------------------------------------------
// 4. EMPRESAS  —  GET /administrativo/empresas
// ---------------------------------------------------------------------------
export async function empresas({ hojeIso, mes } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  return {
    monitor: frota.monitor,
    dataReferencia: frota.hojeIso,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    total: new Set(frota.unidades.map((u) => u.organizacaoId)).size,
    empresas: consolidarEmpresas(frota.unidades),
  };
}

// ---------------------------------------------------------------------------
// 5. DETALHE DA EMPRESA  —  GET /administrativo/empresas/:organizacaoId
// ---------------------------------------------------------------------------
export async function detalheEmpresa({ organizacaoId, hojeIso, mes } = {}, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const org = await obterOrganizacaoOperacional(orgId, deps);
  if (!org) throw ApiError.notFound("Empresa não encontrada ou fora do monitoramento.");

  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const daEmpresa = frota.unidades.filter((u) => u.organizacaoId === orgId);
  const cons = consolidarOperacao(daEmpresa);
  const resumoEmpresa = consolidarEmpresas(daEmpresa)[0] ?? null;

  // Financeiro (reaproveita 100% a Visão Geral da Rede, só recortada por
  // empresa) — aditivo: se faltar módulo financeiro para esta empresa, ou o
  // motor falhar por qualquer razão, o detalhe OPERACIONAL continua
  // funcionando normalmente (nunca deixa o drill-down quebrar por causa do bloco novo).
  const financeiro = await (async () => {
    try {
      const r = await visaoGeralRede({ hojeIso: hoje, mes, organizacaoId: orgId }, deps);
      if (!r.rede?.unidadesMonitoradas) return null;
      return {
        rede: r.rede,
        composicaoDeducoes: r.composicaoDeducoes,
        unidades: r.unidades.map((u) => ({
          unidadeId: u.unidadeId, nome: u.nome,
          faturamento: u.faturamento, deducoes: u.deducoes, deducoesPct: u.deducoesPct,
          meta: u.meta, situacaoFinanceira: u.situacaoFinanceira,
          totalDeducoesIndicadorPct: u.totalDeducoesIndicadorPct,
          impactoFinanceiroEstimado: u.impactoFinanceiroEstimado, ultimaAtualizacao: u.ultimaAtualizacao,
        })),
      };
    } catch { return null; }
  })();

  return {
    monitor: frota.monitor,
    dataReferencia: frota.hojeIso,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    organizacao: { organizacaoId: org.organizacaoId, nome: org.nome, status: org.status, criadaEm: org.criadaEm },
    resumo: resumoEmpresa,
    financeiro,
    consolidado: {
      criticas: cons.criticas, atencao: cons.atencao, emDia: cons.emDia,
      conformidadeD1: cons.d1.taxa, conformidadeMes: cons.conformidadeMes.taxa,
      mesCompleto: cons.conformidadeMes.completos, mesEsperado: cons.conformidadeMes.esperados,
    },
    unidades: daEmpresa.map((u) => ({
      unidadeId: u.unidadeId,
      unidadeNome: u.unidadeNome,
      criticidade: u.rollup.status,
      motivo: u.rollup.motivo,
      d1Status: u.d1.categoria,
      d1StatusDia: u.d1.statusDia ?? null,
      // tudo aqui é DO PERÍODO; o histórico anterior vai separado abaixo
      sequenciaBloqueada: u.pendenciasPeriodo.sequenciaBloqueada,
      pendenciaMaisAntiga: u.pendenciasPeriodo.desde,
      diasPendentes: u.pendenciasPeriodo.total,
      pendenciaHerdada: u.pendenciaHerdada.herdada,
      pendenciaHerdadaDesde: u.pendenciaHerdada.desde,
      diasPendentesHistorico: u.pendenciasAcum.total,
      historicoAnterior: u.historicoAnterior,
      conformidadeMes: u.conformidade.taxa,
      mesCompleto: u.conformidade.completos,
      mesEsperado: u.conformidade.esperados,
      ultimoConcluido: u.ultimos.ultimoCompleto,
      ultimoRegistro: u.ultimos.ultimoRegistro,
      criadaEm: u.unidadeCriadaEm,
    })),
    pendencias: listarPendencias(daEmpresa),
  };
}

// ---------------------------------------------------------------------------
// 6. CALENDÁRIO DA UNIDADE  —  GET /administrativo/unidades/:unidadeId/calendario?mes=YYYY-MM
// ---------------------------------------------------------------------------
export async function calendarioUnidade({ unidadeId, mes, hojeIso } = {}, deps = {}) {
  const uniId = v.uuid(unidadeId, "Unidade");
  const hoje = hojeIso ?? hojeIsoBrasil();
  // Mesma validação de período do resto do painel (recusa formato inválido e
  // mês futuro); o mês corrente É permitido — os dias por vir aparecem como
  // NÃO APLICÁVEL, nunca como pendência.
  const per = alvoDoPeriodo(mes, hoje);
  const [ano, numMes] = per.periodo.split("-").map(Number);

  // A unidade tem de estar no universo monitorado PADRÃO (org ativa, unidade
  // não-teste) — o calendário é rota HTTP normal, não chamada diagnóstica.
  const elegiveis = await listarUnidadesElegiveis({ moduloId: MONITOR.modulo }, deps);
  const alvo = elegiveis.find((u) => u.unidadeId === uniId);
  if (!alvo) throw ApiError.notFound("Unidade não encontrada ou fora do monitoramento.");

  const ant = mesAnterior(ano, numMes);
  const diasCorrIso = diasDoMes(ano, numMes);
  const diasAntIso = diasDoMes(ant.ano, ant.mes);

  const desdeIso = diasAntIso[0];
  const ateIso = diasCorrIso[diasCorrIso.length - 1];
  // Lançamentos e liberações administrativas na MESMA janela (mês anterior +
  // corrente) e em paralelo — o calendário não fica mais caro por causa da
  // exceção: uma query a mais, nunca uma por dia.
  const [linhas, liberadas, historico] = await Promise.all([
    carregarLancamentosDaUnidade({ unidadeId: uniId, desdeIso, ateIso }, deps),
    carregarDatasLiberadas({ unidadeId: uniId, desdeIso, ateIso }, deps),
    listarDesbloqueios({ unidadeId: uniId, desdeIso, ateIso }, deps),
  ]);
  const porData = new Map(linhas.map((r) => [r.data_lancamento, r]));
  const mkDias = (isos) => isos.map((data) => ({ data, lancamento: porData.get(data) ?? null }));

  const proj = projetarMes({
    dias: mkDias(diasCorrIso), hojeIso: hoje, unidadeCriadaEm: alvo.unidadeCriadaEm, desbloqueios: liberadas,
  });
  const projTodos = [...projetarMes({ dias: mkDias(diasAntIso), hojeIso: hoje, unidadeCriadaEm: alvo.unidadeCriadaEm, desbloqueios: liberadas }), ...proj];

  // Liberação ATIVA de cada dia (para o botão "Revogar") e o histórico
  // completo do dia (inclusive revogadas) — a linha do tempo do item 6.
  const ativaPorData = new Map(historico.filter((h) => h.ativo).map((h) => [h.data, h]));
  const historicoPorData = historico.reduce((acc, h) => {
    (acc.get(h.data) ?? acc.set(h.data, []).get(h.data)).push(h);
    return acc;
  }, new Map());

  // Dia de referência DO PERÍODO: D-1 no mês corrente, último dia num mês
  // fechado — o mesmo alvo que a Visão Geral usa, para o calendário não
  // contar uma história diferente da tela que levou até ele.
  const dataAlvo = per.dataAlvo;
  const d1 = avaliarDia(projTodos, dataAlvo);
  const pend = pendenciasAntesDe(projTodos, dataAlvo);

  return {
    monitor: MONITOR.chave,
    dataReferencia: hoje,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    unidade: { unidadeId: alvo.unidadeId, unidadeNome: alvo.unidadeNome, organizacaoId: alvo.organizacaoId, empresaNome: alvo.empresaNome, criadaEm: alvo.unidadeCriadaEm },
    mes: `${ano}-${String(numMes).padStart(2, "0")}`,
    d1Deste: d1.data === dataAlvo && diasCorrIso.includes(dataAlvo) ? d1.categoria : null,
    sequenciaBloqueada: pend.sequenciaBloqueada,
    // Destaque de risco (item 12): liberado e AINDA sem lançamento continua
    // sendo pendência — este número existe para cobrar, não para tranquilizar.
    liberacoes: liberacoesAguardando(proj),
    motivos: MOTIVOS_DESBLOQUEIO,
    dias: proj.map((d) => ({
      data: d.data,
      statusDia: d.statusDia,
      painel: d.painel,
      completo: d.painel === STATUS_PAINEL.COMPLETO,
      esperado: d.painel !== STATUS_PAINEL.NAO_APLICAVEL,
      bloqueada: d.bloqueada,
      emPreenchimento: d.emPreenchimento,
      motivoNaoAplicavel: d.motivoNaoAplicavel ?? null,
      // --- exceção administrativa (068)
      desbloqueadoAdmin: d.desbloqueadoAdmin,
      situacaoDesbloqueio: d.situacaoDesbloqueio ?? null,
      // Só faz sentido oferecer "Desbloquear" num dia que a REGRA fecharia e
      // que ainda não está liberado. Dia completo, futuro, de hoje ou já
      // liberado não mostra ação — a decisão é do backend, o frontend só
      // renderiza (item 4: nada de regra duplicada no cliente).
      podeDesbloquear: podeDesbloquearDia(d, hoje),
      liberacaoAtiva: ativaPorData.get(d.data) ?? null,
      liberacoesHistorico: historicoPorData.get(d.data) ?? [],
    })),
  };
}

/**
 * Dashboard iFood COMPLETO de uma unidade (cards, Indicadores de
 * Rentabilidade, projeção, diagnóstico, evolução) — para o clique em
 * empresa/unidade na Visão Geral da Rede abrir a MESMA leitura que o
 * franqueado vê no Dashboard iFood, nunca uma segunda implementação paralela.
 *
 * Reaproveita `dashboardExecutivo.service.js#obterMes` POR CHAMADA DIRETA DE
 * FUNÇÃO (nunca a rota HTTP tenant-scoped, que exige `req.tenant` e não
 * existe no mundo administrativo) — `unidadeIdSessao: null` evita a checagem
 * "só a própria unidade da sessão" (não há sessão de unidade aqui) e
 * `resolverUnidadeAlvo` ainda confere, no servidor, que a unidade pedida
 * pertence à `organizacaoId` resolvida abaixo — nenhuma regra de acesso é
 * pulada, só adaptada ao mundo cross-tenant. Zero fórmula, meta ou
 * classificação de status recalculada aqui: `obterMes` já devolve
 * `cards`/`indicadoresRentabilidade` prontos (mesma `statusIndicadorRentabilidade`
 * e `saldoMeta` do Dashboard iFood do tenant).
 * @param {{unidadeId: string, mes?: string, hojeIso?: string}} params
 * @param {{supabase?: object, obterMesDashboardExecutivo?: Function}} [deps]
 */
export async function detalheOperacaoUnidade({ unidadeId, mes, hojeIso } = {}, deps = {}) {
  const uniId = v.uuid(unidadeId, "Unidade");
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const [ano, numMes] = per.periodo.split("-").map(Number);

  // Mesmo universo monitorado do calendário/Visão Geral da Rede — nunca um
  // escopo de elegibilidade diferente para a mesma unidade.
  const elegiveis = await listarUnidadesElegiveis({ moduloId: MONITOR.modulo }, deps);
  const alvo = elegiveis.find((u) => u.unidadeId === uniId);
  if (!alvo) throw ApiError.notFound("Unidade não encontrada ou fora do monitoramento.");

  const obterMesFn = deps.obterMesDashboardExecutivo ?? obterMesDashboardExecutivo;
  const dashboard = await obterMesFn({
    organizacaoId: alvo.organizacaoId, unidadeIdSessao: null, unidadeIdSolicitado: uniId,
    mes: numMes, ano,
  });

  return {
    unidade: {
      unidadeId: alvo.unidadeId, unidadeNome: alvo.unidadeNome,
      organizacaoId: alvo.organizacaoId, empresaNome: alvo.empresaNome,
    },
    periodo: { mes: numMes, ano, ym: per.periodo, mesCorrente: per.mesCorrente },
    situacaoFinanceira: classificarAtencaoFinanceira(dashboard.cards?.totalDeducoes?.percentual, dashboard.cards?.totalDeducoes?.meta),
    dashboard,
  };
}

/**
 * Um dia é candidato a desbloqueio administrativo quando a regra normal o
 * mantém fechado E ele ainda não foi liberado:
 *   * BLOQUEADO  — travado pela sequência;
 *   * PENDENTE fora da janela D-1 — a unidade até consegue abrir o dia, mas o
 *     Financeiro não é oferecido nele (não é mais "ontem"), que é justamente
 *     o beco sem saída que a exceção existe para resolver.
 *
 * Nunca oferece para: hoje/futuro/antes da criação (`NAO_APLICAVEL`), dia já
 * resolvido, dia já liberado, nem para o PRÓPRIO D-1 — esse está disponível
 * pela regra normal e não precisa de exceção nenhuma.
 * @param {ReturnType<typeof projetarMes>[number]} d
 * @param {string} hojeIso
 */
function podeDesbloquearDia(d, hojeIso) {
  if (d.desbloqueadoAdmin) return false;
  if (d.painel !== STATUS_PAINEL.NAO_LANCADO) return false;
  if (d.data === diaAnterior(hojeIso) && !d.bloqueada) return false;
  return true;
}

// ===========================================================================
// DESBLOQUEIO ADMINISTRATIVO DE UM DIA (migration 068)
//
// As ÚNICAS rotas de ESCRITA do Painel Administrativo. O resto do módulo é
// monitoramento; aqui o painel age. Ainda assim NÃO é poder de SuperAdmin: a
// escrita é estreita (uma data de uma unidade), sem efeito em nenhum outro
// módulo, e todo o rastro fica em `dashboard_ifood_desbloqueios` +
// `plataforma_auditoria`.
// ===========================================================================

/**
 * Resolve a unidade do desbloqueio pelo MESMO caminho do resto do painel
 * (`listarUnidadesElegiveis`): a unidade tem de estar no universo monitorado.
 * É daqui — nunca do corpo da requisição — que sai o `organizacao_id` gravado,
 * o que torna impossível uma liberação apontar para a empresa errada.
 */
async function unidadeParaDesbloqueio(unidadeId, deps) {
  const uniId = v.uuid(unidadeId, "Unidade");
  const elegiveis = await listarUnidadesElegiveis({ moduloId: MONITOR.modulo }, deps);
  const alvo = elegiveis.find((u) => u.unidadeId === uniId);
  if (!alvo) throw ApiError.notFound("Unidade não encontrada ou fora do monitoramento.");
  return alvo;
}

/**
 * Cria a liberação de UM dia. Recusa data futura e o próprio dia de hoje: não
 * existe fechamento a lançar de um dia que ainda não terminou, então liberar
 * isso seria abrir uma porta para lugar nenhum.
 *
 * NÃO valida se o dia está de fato bloqueado — um painel que só deixasse
 * liberar o que ele mesmo acabou de calcular ficaria refém de corrida entre a
 * tela e o banco (a unidade pode ter preenchido no meio do caminho). A
 * unicidade real é o índice parcial da 068, e liberar um dia que já estava
 * disponível é inócuo por construção: `financeiroDisponivelNaData` já diria
 * sim por outro motivo.
 *
 * @param {{unidadeId: string, data: string, motivo: string, observacao?: string|null, hojeIso?: string, autor: object, req?: object}} p
 */
export async function desbloquearDia({ unidadeId, data, motivo, observacao, hojeIso, autor = {}, req } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const alvo = await unidadeParaDesbloqueio(unidadeId, deps);

  const dataIso = v.dataOpcional(data, "Data") ?? (() => { throw ApiError.badRequest("Data é obrigatória."); })();
  if (dataIso >= hoje) {
    throw ApiError.badRequest("Só é possível liberar um dia já encerrado — o fechamento de hoje ainda não existe.");
  }
  const criadaEm = alvo.unidadeCriadaEm ? String(alvo.unidadeCriadaEm).slice(0, 10) : null;
  if (criadaEm && dataIso < criadaEm) {
    throw ApiError.badRequest("Esta data é anterior à criação da unidade — nunca houve obrigação de lançamento.");
  }

  const motivoOk = v.umDe(motivo, "Motivo", MOTIVOS_VALIDOS);
  const obs = v.textoOpcional(observacao, "Observação", { max: 500 });
  if (motivoOk === "outro" && !obs) {
    throw ApiError.badRequest("Descreva o motivo na observação quando escolher \"Outro\".");
  }

  const criado = await criarDesbloqueio({
    organizacaoId: alvo.organizacaoId, unidadeId: alvo.unidadeId, dataIso,
    motivo: motivoOk, observacao: obs, autor,
  }, deps);

  // Espelho geral na auditoria da plataforma (a linha da 068 é o registro
  // detalhado; esta é a trilha única onde se vê "o que a Crescer fez").
  await auditar({
    atorId: autor.id ?? null, atorEmail: autor.email ?? null, perfilId: autor.perfilId ?? null,
    perfilNome: autor.nome ?? null,
    acao: ACOES.IFOOD_DIA_DESBLOQUEADO,
    entidade: "dashboard_ifood_desbloqueios", entidadeId: criado.id,
    organizacaoId: alvo.organizacaoId,
    detalhes: {
      unidade_id: alvo.unidadeId, unidade_nome: alvo.unidadeNome, empresa_nome: alvo.empresaNome,
      data_referencia: dataIso, tipo: criado.tipo, motivo: motivoOk, observacao: obs,
    },
    ip: req?.ip ?? null, userAgent: req?.get?.("user-agent") ?? null,
  });

  return { desbloqueio: criado, unidade: dadosDaUnidade(alvo) };
}

/**
 * Revoga uma liberação ainda ATIVA — o dia volta a obedecer só à regra normal.
 *
 * Se o financeiro daquele dia JÁ foi lançado, a revogação é recusada: não
 * existe desfazer aqui. Apagar/reverter lançamento é outro assunto, com outra
 * permissão (`DASHBOARD_EXECUTIVO_CORRIGIR`), e silenciosamente esconder um
 * dado já gravado seria pior do que manter a liberação no histórico.
 */
export async function revogarDesbloqueioDia({ unidadeId, desbloqueioId, hojeIso, autor = {}, req } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const alvo = await unidadeParaDesbloqueio(unidadeId, deps);
  const id = v.uuid(desbloqueioId, "Liberação");

  const ativo = await obterDesbloqueioAtivoPorId({ id, unidadeId: alvo.unidadeId }, deps);
  if (!ativo) throw ApiError.notFound("Liberação não encontrada ou já revogada.");

  const [lanc] = await carregarLancamentosDaUnidade({
    unidadeId: alvo.unidadeId, desdeIso: ativo.data, ateIso: ativo.data,
  }, deps);
  if (lanc?.valor_vendas_ifood != null) {
    throw new ApiError(409, "O financeiro deste dia já foi lançado — a liberação cumpriu seu papel e fica no histórico.");
  }

  const revogado = await revogarDesbloqueio({ id, unidadeId: alvo.unidadeId, autor }, deps);

  await auditar({
    atorId: autor.id ?? null, atorEmail: autor.email ?? null, perfilId: autor.perfilId ?? null,
    perfilNome: autor.nome ?? null,
    acao: ACOES.IFOOD_DIA_DESBLOQUEIO_REVOGADO,
    entidade: "dashboard_ifood_desbloqueios", entidadeId: revogado.id,
    organizacaoId: alvo.organizacaoId,
    detalhes: {
      unidade_id: alvo.unidadeId, unidade_nome: alvo.unidadeNome, empresa_nome: alvo.empresaNome,
      data_referencia: revogado.data, motivo_original: revogado.motivo,
    },
    ip: req?.ip ?? null, userAgent: req?.get?.("user-agent") ?? null,
  });

  return { desbloqueio: revogado, unidade: dadosDaUnidade(alvo), dataReferencia: hoje };
}

/** Histórico de liberações de uma unidade no período (ativas e revogadas). */
export async function historicoDesbloqueios({ unidadeId, mes, hojeIso } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const alvo = await unidadeParaDesbloqueio(unidadeId, deps);
  const per = alvoDoPeriodo(mes, hoje);
  const [ano, numMes] = per.periodo.split("-").map(Number);
  const dias = diasDoMes(ano, numMes);

  const lista = await listarDesbloqueios({
    unidadeId: alvo.unidadeId, desdeIso: dias[0], ateIso: dias[dias.length - 1],
  }, deps);
  return { unidade: dadosDaUnidade(alvo), periodo: per.periodo, motivos: MOTIVOS_DESBLOQUEIO, desbloqueios: lista };
}

const dadosDaUnidade = (u) => ({
  unidadeId: u.unidadeId, unidadeNome: u.unidadeNome,
  organizacaoId: u.organizacaoId, empresaNome: u.empresaNome,
});

// ===========================================================================
// FINANCEIRO — consolidado, rankings, evolução e comparação
// ===========================================================================

/** Itens de ranking a partir da frota avaliada, no nível UNIDADE. */
const itensUnidade = (unidades) => (unidades ?? []).map((u) => ({
  id: u.unidadeId,
  nome: u.unidadeNome,
  extras: { organizacaoId: u.organizacaoId, empresaNome: u.empresaNome, criticidade: u.rollup?.status ?? null },
  faturamento: u.faturamento,
  cobertura: coberturaDe([u]),
  conformidadeMes: u.conformidade?.taxa ?? null,
}));

/** Itens de ranking no nível EMPRESA (agrega as unidades da organização). */
function itensEmpresa(unidades, porEmpresa) {
  const porOrg = new Map();
  for (const u of unidades ?? []) {
    const k = u.organizacaoId ?? "sem_empresa";
    if (!porOrg.has(k)) porOrg.set(k, []);
    porOrg.get(k).push(u);
  }
  return [...porOrg.entries()].map(([orgId, lista]) => {
    const rollup = (porEmpresa ?? []).find((e) => e.organizacaoId === orgId);
    return {
      id: orgId,
      nome: lista[0]?.empresaNome ?? null,
      extras: {
        unidadesMonitoradas: lista.length,
        unidadesPendentes: rollup?.unidadesPendentes ?? null,
        criticas: rollup?.criticas ?? null,
        atencao: rollup?.atencao ?? null,
      },
      faturamento: somarFaturamento(lista),
      cobertura: coberturaDe(lista),
      conformidadeMes: rollup?.conformidadeMes ?? coberturaDe(lista).taxa,
    };
  });
}

/** Consolidado da rede + líderes — o que a home executiva mostra. */
function resumoFinanceiroDaRede(unidades, porEmpresa) {
  const rede = somarFaturamento(unidades);
  const cobertura = coberturaDe(unidades);
  const topEmp = rankingFaturamento(itensEmpresa(unidades, porEmpresa), { limite: 1 })[0] ?? null;
  const topUni = rankingFaturamento(itensUnidade(unidades), { limite: 1 })[0] ?? null;
  return {
    ...rede,
    cobertura,
    liderEmpresa: topEmp && { organizacaoId: topEmp.id, nome: topEmp.nome, total: topEmp.faturamento.total },
    liderUnidade: topUni && { unidadeId: topUni.id, nome: topUni.nome, empresaNome: topUni.empresaNome, total: topUni.faturamento.total },
  };
}

/**
 * GET /administrativo/rankings/faturamento
 * @param {{mes?: string, escopo?: "empresas"|"unidades", limite?: number, hojeIso?: string}} p
 */
export async function rankingDeFaturamento({ hojeIso, mes, escopo = "empresas", limite } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const esc = v.umDe(escopo, "Escopo", ["empresas", "unidades"]);
  const lim = limite ? Number(limite) : null;

  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const porEmpresa = consolidarEmpresas(frota.unidades);
  const itens = esc === "unidades" ? itensUnidade(frota.unidades) : itensEmpresa(frota.unidades, porEmpresa);

  return {
    monitor: frota.monitor,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    escopo: esc,
    total: itens.length,
    rede: somarFaturamento(frota.unidades),
    itens: rankingFaturamento(itens, { limite: lim }),
  };
}

/**
 * GET /administrativo/rankings/conformidade
 * `ordem=asc` devolve quem precisa de mais atenção — mesma lista, outra ponta.
 */
export async function rankingDeConformidade({ hojeIso, mes, escopo = "empresas", ordem = "desc", limite } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const esc = v.umDe(escopo, "Escopo", ["empresas", "unidades"]);
  const ord = v.umDe(ordem, "Ordem", ["desc", "asc"]);
  const lim = limite ? Number(limite) : null;

  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const porEmpresa = consolidarEmpresas(frota.unidades);
  const itens = esc === "unidades" ? itensUnidade(frota.unidades) : itensEmpresa(frota.unidades, porEmpresa);

  return {
    monitor: frota.monitor,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    escopo: esc,
    ordem: ord,
    total: itens.length,
    itens: rankingConformidade(itens, { ordem: ord, limite: lim }),
  };
}

/**
 * GET /administrativo/relatorios/evolucao
 * Série diária da rede (ou de UMA empresa) no período.
 */
export async function evolucaoFaturamento({ hojeIso, mes, organizacaoId } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const orgFiltro = organizacaoId ? v.uuid(organizacaoId, "Empresa") : null;

  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const alvoUnidades = orgFiltro
    ? frota.unidades.filter((u) => u.organizacaoId === orgFiltro)
    : frota.unidades;

  const [ano, num] = per.periodo.split("-").map(Number);
  // A série vai só até o dia-alvo: dia futuro não tem faturamento, tem ausência.
  const dias = diasDoMes(ano, num).filter((d) => d <= per.dataAlvo);
  const serie = evolucaoDiaria(
    alvoUnidades.map((u) => ({ linhas: u.linhasDoPeriodo ?? [] })),
    dias,
  );

  return {
    monitor: frota.monitor,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    organizacaoId: orgFiltro,
    unidades: alvoUnidades.length,
    serie,
  };
}

/**
 * GET /administrativo/relatorios/resumo — o Relatório Executivo do período.
 *
 * Inclui a comparação com o mês anterior no PERÍODO EQUIVALENTE: 1..14/set
 * contra 1..14/ago, nunca contra o agosto inteiro. Custo: uma segunda
 * avaliação de frota (o mês anterior é outro recorte), ainda em lote.
 */
export async function relatorioExecutivo({ hojeIso, mes, topN = 5 } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const n = Math.max(1, Math.min(20, Number(topN) || 5));

  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const porEmpresa = consolidarEmpresas(frota.unidades);
  const cons = consolidarOperacao(frota.unidades);
  const empresas = itensEmpresa(frota.unidades, porEmpresa);
  const unidades = itensUnidade(frota.unidades);
  const fin = resumoFinanceiroDaRede(frota.unidades, porEmpresa);

  const comparacao = await compararComMesAnterior({ per, hoje, atual: { fin, cons } }, deps);

  return {
    monitor: frota.monitor,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    dataReferencia: frota.hojeIso,

    operacao: {
      empresasMonitoradas: cons.empresasMonitoradas,
      unidadesMonitoradas: cons.unidadesMonitoradas,
      empresasComPendencia: porEmpresa.filter((e) => e.unidadesPendentes > 0).length,
      unidadesComPendencia: porEmpresa.reduce((s, e) => s + (e.unidadesPendentes ?? 0), 0),
      criticas: cons.criticas, atencao: cons.atencao, emDia: cons.emDia,
    },
    conformidade: {
      d1: cons.d1.taxa,
      mes: cons.conformidadeMes.taxa,
      mesCompleto: cons.conformidadeMes.completos,
      mesEsperado: cons.conformidadeMes.esperados,
    },
    faturamento: fin,
    comparacao,

    prioridades: {
      empresas: porEmpresa.filter((e) => e.unidadesPendentes > 0).slice(0, n).map((e) => ({
        organizacaoId: e.organizacaoId, empresaNome: e.empresaNome,
        unidadesPendentes: e.unidadesPendentes, criticas: e.criticas, atencao: e.atencao,
        pendenciaMaisAntiga: e.pendenciaMaisAntiga, piorUnidade: e.piorUnidade,
      })),
      unidades: listarPendencias(frota.unidades).slice(0, n),
    },

    rankings: {
      faturamentoEmpresas: rankingFaturamento(empresas, { limite: n }),
      faturamentoUnidades: rankingFaturamento(unidades, { limite: n }),
      conformidadeEmpresas: rankingConformidade(empresas, { limite: n }),
      atencaoEmpresas: rankingConformidade(empresas, { ordem: "asc", limite: n }),
    },
  };
}

/**
 * Comparação com o mês anterior no MESMO número de dias corridos.
 * `null` quando o mês anterior não tem base — nunca fabrica crescimento.
 */
async function compararComMesAnterior({ per, hoje, atual }, deps) {
  const [ano, num] = per.periodo.split("-").map(Number);
  const ant = mesAnterior(ano, num);
  const diasAnt = diasDoMes(ant.ano, ant.mes);
  const alvoAnt = diaEquivalenteNoMesAnterior(per.dataAlvo, diasAnt);
  if (!alvoAnt) return null;

  const frotaAnt = await avaliarFrota({ hojeIso: hoje, dataAlvo: alvoAnt }, deps);
  if (!frotaAnt.unidades.length) return null;

  const finAnt = somarFaturamento(frotaAnt.unidades);
  const consAnt = consolidarOperacao(frotaAnt.unidades);
  const pendAnt = listarPendencias(frotaAnt.unidades).length;
  const pendAtual = atual.cons.criticas + atual.cons.atencao;

  return {
    periodo: `${ant.ano}-${String(ant.mes).padStart(2, "0")}`,
    ate: alvoAnt,
    diasEquivalentes: Number(per.dataAlvo.slice(8, 10)),
    faturamento: {
      anterior: finAnt.total,
      variacao: variacao(atual.fin.total, finAnt.total),
      // a comparação carrega o aviso quando QUALQUER um dos lados tem rascunho
      incluiProvisorio: !!(atual.fin.incluiProvisorio || finAnt.incluiProvisorio),
    },
    conformidadeMes: {
      anterior: consAnt.conformidadeMes.taxa,
      variacaoPP: variacaoPP(atual.cons.conformidadeMes.taxa, consAnt.conformidadeMes.taxa),
    },
    pendencias: { anterior: pendAnt, variacao: pendAtual - pendAnt },
  };
}

/**
 * GET /administrativo/relatorios/executivo — o PACOTE COMPLETO do período.
 *
 * Contrato único do relatório em PDF (item 23): uma chamada, tudo dentro. O
 * PDF é camada de APRESENTAÇÃO — não recalcula nada, não conhece `statusMes`,
 * não sabe o que é snapshot acumulado. Tudo aqui sai das mesmas funções que
 * alimentam a tela; se a regra mudar, o PDF acompanha sozinho.
 *
 * Custo: as mesmas 2 avaliações de frota do relatório executivo (período +
 * período equivalente anterior). Nenhuma query por empresa.
 *
 * PRIVACIDADE: só informação gerencial. Nenhum e-mail, PIN, token, credencial
 * ou id de usuário — `organizacaoId`/`unidadeId` viajam apenas porque a tela
 * usa para navegar, e o template do PDF não os imprime.
 */
export async function relatorioExecutivoCompleto({ hojeIso, mes, topN = 10 } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const n = Math.max(1, Math.min(50, Number(topN) || 10));

  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const porEmpresa = consolidarEmpresas(frota.unidades);
  const cons = consolidarOperacao(frota.unidades);
  const itensEmp = itensEmpresa(frota.unidades, porEmpresa);
  const itensUni = itensUnidade(frota.unidades);
  const fin = resumoFinanceiroDaRede(frota.unidades, porEmpresa);
  const comparacao = await compararComMesAnterior({ per, hoje, atual: { fin, cons } }, deps);

  // Faturamento por empresa/unidade, indexado — as tabelas completas casam o
  // financeiro com o operacional sem recalcular.
  const finPorEmpresa = new Map(itensEmp.map((i) => [i.id, i]));
  const finPorUnidade = new Map(itensUni.map((i) => [i.id, i]));

  const linhaEmpresa = (e) => {
    const f = finPorEmpresa.get(e.organizacaoId);
    return {
      organizacaoId: e.organizacaoId,
      empresaNome: e.empresaNome,
      unidadesMonitoradas: e.unidadesMonitoradas,
      unidadesPendentes: e.unidadesPendentes,
      criticas: e.criticas, atencao: e.atencao, emDia: e.emDia,
      conformidadeD1: e.conformidadeD1, conformidadeMes: e.conformidadeMes,
      d1Ok: e.d1Ok, severidade: e.severidade,
      pendenciaMaisAntiga: e.pendenciaMaisAntiga,
      piorUnidade: e.piorUnidade,
      historicoAnterior: e.historicoAnterior,
      pendentes: e.pendentes,
      faturamento: f?.faturamento ?? null,
      cobertura: f?.cobertura ?? null,
    };
  };

  const emDia = porEmpresa.filter((e) => e.unidadesPendentes === 0).map(linhaEmpresa);
  const comPendencia = porEmpresa.filter((e) => e.unidadesPendentes > 0).map(linhaEmpresa);

  const todasUnidades = frota.unidades.map((u) => {
    const f = finPorUnidade.get(u.unidadeId);
    return {
      organizacaoId: u.organizacaoId,
      empresaNome: u.empresaNome,
      unidadeId: u.unidadeId,
      unidadeNome: u.unidadeNome,
      d1Status: u.d1?.categoria ?? null,
      criticidade: u.rollup?.status ?? null,
      diasPendentes: u.pendenciasPeriodo?.total ?? 0,
      pendenciaMaisAntiga: u.pendenciasPeriodo?.desde ?? null,
      sequenciaBloqueada: u.pendenciasPeriodo?.sequenciaBloqueada ?? false,
      historicoAnterior: u.historicoAnterior,
      conformidadeMes: u.conformidade?.taxa ?? null,
      faturamento: f?.faturamento ?? null,
      cobertura: f?.cobertura ?? null,
    };
  }).sort((a, b) =>
    String(a.empresaNome ?? "").localeCompare(String(b.empresaNome ?? ""), "pt-BR")
    || String(a.unidadeNome ?? "").localeCompare(String(b.unidadeNome ?? ""), "pt-BR"));

  const [ano, num] = per.periodo.split("-").map(Number);
  const diasSerie = diasDoMes(ano, num).filter((d) => d <= per.dataAlvo);
  const evolucao = evolucaoDiaria(
    frota.unidades.map((u) => ({ linhas: u.linhasDoPeriodo ?? [] })),
    diasSerie,
  );

  return {
    monitor: frota.monitor,
    monitorNome: MONITOR.nome,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    dataReferencia: frota.hojeIso,
    geradoEm: new Date().toISOString(),

    operacao: {
      empresasMonitoradas: cons.empresasMonitoradas,
      unidadesMonitoradas: cons.unidadesMonitoradas,
      empresasComPendencia: comPendencia.length,
      empresasEmDia: emDia.length,
      unidadesComPendencia: porEmpresa.reduce((s, e) => s + (e.unidadesPendentes ?? 0), 0),
      criticas: cons.criticas, atencao: cons.atencao, emDia: cons.emDia,
    },
    conformidade: {
      d1: cons.d1.taxa,
      mes: cons.conformidadeMes.taxa,
      mesCompleto: cons.conformidadeMes.completos,
      mesEsperado: cons.conformidadeMes.esperados,
      d1Concluidas: cons.d1.concluidas,
      d1Elegiveis: cons.d1.elegiveis,
    },
    faturamento: fin,
    comparacao,
    evolucao,

    empresas: { emDia, comPendencia, todas: [...comPendencia, ...emDia] },
    unidades: todasUnidades,
    prioridades: listarPendencias(frota.unidades),

    rankings: {
      faturamentoEmpresas: rankingFaturamento(itensEmp, { limite: n }),
      faturamentoUnidades: rankingFaturamento(itensUni, { limite: n }),
      conformidadeEmpresas: rankingConformidade(itensEmp, { limite: 5 }),
      atencaoEmpresas: rankingConformidade(itensEmp, { ordem: "asc", limite: 5 }),
    },
  };
}

// ===========================================================================
// LUCRATIVIDADE / RENTABILIDADE SEMANAL  —  GET /administrativo/relatorios/lucratividade
// ===========================================================================
//
// Análise SEMANAL (segunda a domingo) comparativa da frota iFood monitorada,
// para as abas Lucratividade (faturamento + eficiência das deduções por modelo)
// e Rentabilidade (receita líquida após deduções do iFood). Um único payload
// alimenta as duas abas; o frontend deriva ordenação/filtro/busca sem refetch.
//
// Reaproveita as MESMAS fontes/fórmulas do Dashboard iFood: o recorte semanal
// (administrativo.lucratividade.js) é diferença de snapshot acumulado, nunca
// rateio. Metas de dedução vêm de `metas_indicadores` pelo MODELO LOGÍSTICO da
// loja (escolherMetas — fonte única com o Dashboard Executivo).

const R2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);

/** Valida `AAAA-MM-DD` (qualquer dia dentro do bloco semanal desejado). */
function validarDiaSemana(dia) {
  if (dia === undefined || dia === null || String(dia).trim() === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dia).trim());
  if (!m) throw ApiError.badRequest("Semana inválida — informe uma data AAAA-MM-DD.", { codigo: "SEMANA_INVALIDA" });
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * GET /administrativo/relatorios/lucratividade?semana=AAAA-MM-DD
 *
 * A semana é um BLOCO FIXO DO MÊS (1: 01–07 · 2: 08–14 · 3: 15–21 · 4: 22–fim) —
 * nunca cruza meses, nunca há Semana 5. Sem `semana`, usa o bloco que contém
 * D-1 (o corte D-1 é mantido). A comparação "semana anterior" é o bloco
 * imediatamente anterior nessa mesma régua (Semana 1 compara com a Semana 4 do
 * mês anterior); como a Semana 4 varia de 7 a 10 dias, comparam-se os valores
 * REAIS do período — sem normalizar.
 *
 * A UNIDADE é a entidade ranqueada — cada unidade da frota iFood monitorada
 * disputa posição individualmente. A empresa (`empresaNome`/`organizacaoId`)
 * viaja em cada linha só como CONTEXTO: uma empresa pode ter várias unidades,
 * mas nunca soma essas unidades para competir. Somente os indicadores GLOBAIS
 * DE REDE consolidam todas as unidades.
 * @param {{ semana?: string, hojeIso?: string }} p
 */
export async function lucratividadeSemanal({ semana, hojeIso } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const d1 = diaAnterior(hoje);
  const diaAlvo = validarDiaSemana(semana) ?? d1;
  const alvo = semanaDe(diaAlvo);
  const { inicio, fim, indice } = alvo;

  if (inicio > d1) {
    throw ApiError.badRequest("Esta semana ainda não começou — não há faturamento a analisar.", { codigo: "SEMANA_NAO_VENCIDA" });
  }

  const ateData = fim <= d1 ? fim : d1;
  const ehSemanaCorrente = inicio <= d1 && d1 <= fim;
  const anterior = semanaDe(deslocarSemana(inicio, -1));
  const antInicio = anterior.inicio;
  const antFim = anterior.fim;
  const podeAvancar = deslocarSemana(inicio, 1) <= d1;

  const semanaOut = {
    ano: alvo.ano, mes: alvo.mes, indice,
    inicio, fim, ateData, ehSemanaCorrente,
    anterior: { ano: anterior.ano, mes: anterior.mes, indice: anterior.indice, inicio: antInicio, fim: antFim },
  };

  const frota = await listarUnidadesElegiveis({ moduloId: MONITOR.modulo }, deps);
  if (!frota.length) {
    return {
      monitor: MONITOR.chave,
      semana: semanaOut,
      podeAvancar,
      rede: redeVazia(),
      unidades: [],
      destaques: { melhorEficiencia: null, piorEficiencia: null, maiorRentabilidade: null },
      atencao: { menorFaturamento: [], menorRentabilidade: [] },
    };
  }

  const orgIds = [...new Set(frota.map((u) => u.organizacaoId))];
  const [porUnidade, metasLinhas, trocasPorUnidade] = await Promise.all([
    carregarLancamentosDaFrota({
      unidadeIds: frota.map((u) => u.unidadeId),
      // do 1º dia do mês do bloco anterior (base do delta) até o fim do bloco atual
      desdeIso: primeiroDiaDoMes(antInicio),
      ateIso: fim,
    }, deps),
    carregarMetasIndicadores({ organizacaoIds: orgIds }, deps),
    carregarTrocasModeloDaFrota({ unidadeIds: frota.map((u) => u.unidadeId) }, deps),
  ]);

  // ---- UMA linha por UNIDADE: semana atual + semana anterior + meta do modelo.
  //      A empresa vem junto (empresaNome/organizacaoId) só como contexto. ----
  const unidades = frota.map((u) => {
    const linhas = porUnidade.get(u.unidadeId) ?? [];
    const sem = lucratividadeDaUnidade(linhas, { inicio, fim, ateDataIso: ateData });
    const ant = lucratividadeDaUnidade(linhas, { inicio: antInicio, fim: antFim, ateDataIso: antFim });

    // O modelo é o VIGENTE NA SEMANA (linha do tempo de vigências), não o atual da
    // unidade: uma semana passada em Marketplace continua avaliada como Marketplace
    // depois da troca. Semana que atravessa a troca = "misto": meta composta,
    // ponderada pelo faturamento de cada regime (comporMetas) — nunca a meta de um só.
    // Sem troca datada há um único segmento e nada muda.
    const linhaDoTempo = u.modeloLogistico
      ? montarLinhaDoTempo({ modeloAtual: u.modeloLogistico, trocas: trocasDeLinhas(trocasPorUnidade.get(u.unidadeId)) })
      : null;
    const segmentos = linhaDoTempo && ateData >= inicio ? segmentosDoPeriodo(linhaDoTempo, inicio, ateData) : [];
    const estado = segmentos.length ? estadoDoPeriodo(segmentos) : { tipo: u.modeloLogistico ?? null, misto: false };
    const metasDoModelo = (m) => escolherMetas(
      metasLinhas.filter((r) => r.modelo_logistico === m), { organizacaoId: u.organizacaoId, unidadeId: u.unidadeId },
    );
    const modelo = estado.tipo ?? null;
    let metaDed;
    if (estado.misto) {
      const partes = segmentos.map((s) => ({
        modelo: s.modelo,
        peso: lucratividadeDaUnidade(linhas, { inicio: s.inicio, fim: s.fim, ateDataIso: ateData }).faturamento ?? 0,
        metas: metasDoModelo(s.modelo),
      }));
      metaDed = comporMetas(partes, ["total_deducoes"]).total_deducoes ?? null;
    } else {
      metaDed = modelo ? (metasDoModelo(modelo).total_deducoes ?? null) : null;
    }

    return {
      unidadeId: u.unidadeId,
      nome: u.unidadeNome,
      empresaNome: u.empresaNome,
      organizacaoId: u.organizacaoId,
      modeloLogistico: modelo,
      modeloLogisticoRotulo: modelo ? rotuloDoModelo(modelo) : null,

      faturamento: R2(sem.faturamento),
      faturamentoAnterior: R2(ant.faturamento),
      variacaoFaturamento: variacao(sem.faturamento, ant.faturamento),
      confirmado: R2(sem.confirmado),
      provisorio: R2(sem.provisorio),
      incluiProvisorio: sem.incluiProvisorio,

      deducoes: R2(sem.deducoes),
      deducoesPct: R2(sem.deducoesPct),
      meta: metaDed ? { metaIdeal: R2(metaDed.metaIdeal), limite: R2(metaDed.limite) } : null,
      folgaLimitePp: R2(folgaLimite(sem.deducoesPct, metaDed)),
      status: statusIndicadorRentabilidade(sem.deducoesPct, metaDed),

      receitaLiquida: R2(sem.receitaLiquida),
      receitaLiquidaAnterior: R2(ant.receitaLiquida),
      variacaoReceitaLiquida: variacao(sem.receitaLiquida, ant.receitaLiquida),
      rentabilidadeReais: R2(sem.receitaLiquida),
      rentabilidadePct: R2(sem.rentabilidadePct),
      rentabilidadePctAnterior: R2(ant.rentabilidadePct),
      variacaoRentabilidadePp: variacaoPP(sem.rentabilidadePct, ant.rentabilidadePct),

      semDado: sem.semDado,
      _sem: sem, _ant: ant,   // internos p/ o total de rede
    };
  });

  const ctx = (u) => ({ unidadeId: u.unidadeId, nome: u.nome, empresaNome: u.empresaNome, organizacaoId: u.organizacaoId });

  // ---- posição no ranking COMPLETO de UNIDADES (p/ os recortes "menores") ----
  const posFaturamento = new Map(
    unidades.filter((u) => u.faturamento != null)
      .sort((a, b) => b.faturamento - a.faturamento)
      .map((u, i) => [u.unidadeId, i + 1]));
  const posRentabilidade = new Map(
    unidades.filter((u) => u.rentabilidadePct != null)
      .sort((a, b) => b.rentabilidadePct - a.rentabilidadePct)
      .map((u, i) => [u.unidadeId, i + 1]));

  const menorFaturamento = unidades
    .filter((u) => u.faturamento != null)
    .sort((a, b) => a.faturamento - b.faturamento)
    .slice(0, 10)
    .map((u) => ({
      ...ctx(u),
      faturamento: u.faturamento, rentabilidadePct: u.rentabilidadePct,
      variacaoFaturamento: u.variacaoFaturamento,
      posicaoGeral: posFaturamento.get(u.unidadeId) ?? null,
    }));

  const menorRentabilidade = unidades
    .filter((u) => u.rentabilidadePct != null)
    .sort((a, b) => a.rentabilidadePct - b.rentabilidadePct)
    .slice(0, 10)
    .map((u) => ({
      ...ctx(u),
      faturamento: u.faturamento, receitaLiquida: u.receitaLiquida,
      rentabilidadePct: u.rentabilidadePct,
      posicaoGeral: posRentabilidade.get(u.unidadeId) ?? null,
    }));

  // ---- destaques — todos por UNIDADE ----
  const eficientes = unidades.filter((u) => u.status?.chave !== "sem_dados" && u.folgaLimitePp != null);
  const slimEfic = (u) => u && ({
    ...ctx(u), modeloLogisticoRotulo: u.modeloLogisticoRotulo,
    deducoesPct: u.deducoesPct, meta: u.meta, folgaLimitePp: u.folgaLimitePp, status: u.status,
  });
  const melhorEficiencia = eficientes.length
    ? slimEfic(eficientes.reduce((m, u) => (u.folgaLimitePp > m.folgaLimitePp ? u : m)))
    : null;
  const piorEficiencia = eficientes.length
    ? slimEfic(eficientes.reduce((m, u) => (u.folgaLimitePp < m.folgaLimitePp ? u : m)))
    : null;

  const comRent = unidades.filter((u) => u.rentabilidadePct != null);
  const maiorRentabilidade = comRent.length
    ? (() => {
        const u = comRent.reduce((m, x) => (x.rentabilidadePct > m.rentabilidadePct ? x : m));
        return {
          ...ctx(u), modeloLogisticoRotulo: u.modeloLogisticoRotulo,
          rentabilidadePct: u.rentabilidadePct, rentabilidadeReais: u.rentabilidadeReais,
          faturamento: u.faturamento,
        };
      })()
    : null;

  // ---- rede: aqui SIM soma TODAS as unidades (indicador global) ----
  const redeAgg = agregarRede(unidades.map((u) => u._sem));
  const redeAggAnt = agregarRede(unidades.map((u) => u._ant));
  const rede = {
    empresasMonitoradas: orgIds.length,
    unidadesMonitoradas: unidades.length,
    faturamento: R2(redeAgg.faturamento),
    faturamentoAnterior: R2(redeAggAnt.faturamento),
    variacaoFaturamento: variacao(redeAgg.faturamento, redeAggAnt.faturamento),
    deducoes: R2(redeAgg.deducoes),
    deducoesPct: R2(redeAgg.deducoesPct),
    receitaLiquida: R2(redeAgg.receitaLiquida),
    receitaLiquidaAnterior: R2(redeAggAnt.receitaLiquida),
    variacaoReceitaLiquida: variacao(redeAgg.receitaLiquida, redeAggAnt.receitaLiquida),
    rentabilidadeMediaRede: R2(redeAgg.rentabilidadePct),
    rentabilidadeMediaRedeAnterior: R2(redeAggAnt.rentabilidadePct),
    variacaoRentabilidadeMediaPp: variacaoPP(redeAgg.rentabilidadePct, redeAggAnt.rentabilidadePct),
  };

  for (const u of unidades) { delete u._sem; delete u._ant; }
  // Ordem de entrega: maior faturamento primeiro; unidade sem dado por último.
  unidades.sort((a, b) => {
    if (a.faturamento == null && b.faturamento == null) return String(a.nome ?? "").localeCompare(String(b.nome ?? ""), "pt-BR");
    if (a.faturamento == null) return 1;
    if (b.faturamento == null) return -1;
    return b.faturamento - a.faturamento || String(a.nome ?? "").localeCompare(String(b.nome ?? ""), "pt-BR");
  });

  return {
    monitor: MONITOR.chave,
    semana: semanaOut,
    podeAvancar,
    rede,
    unidades,
    destaques: { melhorEficiencia, piorEficiencia, maiorRentabilidade },
    atencao: { menorFaturamento, menorRentabilidade },
  };
}

function redeVazia() {
  return {
    empresasMonitoradas: 0, unidadesMonitoradas: 0,
    faturamento: null, faturamentoAnterior: null, variacaoFaturamento: null,
    deducoes: null, deducoesPct: null,
    receitaLiquida: null, receitaLiquidaAnterior: null, variacaoReceitaLiquida: null,
    rentabilidadeMediaRede: null, rentabilidadeMediaRedeAnterior: null, variacaoRentabilidadeMediaPp: null,
  };
}

// ===========================================================================
// VISÃO GERAL DA REDE — GET /administrativo/visao-geral-rede
// ===========================================================================
//
// Central de inteligência gerencial: faturamento, deduções (taxas/comissões +
// serviços/promoções) e a classificação de atenção financeira (EM_DIA /
// ATENÇÃO / CRÍTICA / SEM_DADOS) de TODA a frota monitorada, por mês.
//
// NENHUMA fórmula nova de faturamento/dedução/receita: tudo vem de
// `lucratividadeDaUnidade` (o mesmo motor usado pela Lucratividade semanal —
// aqui chamado com `inicio`/`fim` = o MÊS inteiro em vez de um bloco de 7
// dias). A classificação de 4 estados e o impacto financeiro estimado vivem
// em `administrativo.visaoRede.js`, sobre o MESMO par (metaIdeal, limite) por
// modelo logístico que o Dashboard iFood já usa.
const pad2 = (x) => String(x).padStart(2, "0");
const ymDe = (ano, mes) => `${ano}-${pad2(mes)}`;

/** Recorte [inicio..fim] de um mês-calendário (ano, mes 1-based), cortado em `ateDataIso` quando o mês é o corrente. */
function janelaDoMes(ano, mes, { corrente, dataAlvo }) {
  const dias = diasDoMes(ano, mes);
  return { inicio: dias[0], fim: corrente ? dataAlvo : dias[dias.length - 1] };
}

function visaoRedeVazia(per) {
  return {
    monitor: MONITOR.chave,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    filtros: { organizacaoId: null, unidadeId: null, modalidade: null, situacao: null, busca: null },
    rede: redeVazia(),
    distribuicaoSituacoes: { sem_dados: 0, em_dia: 0, atencao: 0, critica: 0 },
    composicaoDeducoes: { taxasComissoes: null, servicosPromocoes: null, outrosAjustes: null },
    evolucaoMensal: [],
    rankingPorModalidade: {
      marketplace: { melhores: [], atencao: [] },
      full_service: { melhores: [], atencao: [] },
    },
    unidades: [],
    empresas: [],
  };
}

/**
 * @param {{ mes?: string, organizacaoId?: string, unidadeId?: string, modalidade?: string, situacao?: string, busca?: string, hojeIso?: string }} p
 */
export async function visaoGeralRede({
  hojeIso, mes, organizacaoId, unidadeId, modalidade, situacao, busca,
} = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const orgFiltro = organizacaoId ? v.uuid(organizacaoId, "Empresa") : null;
  const uniFiltro = unidadeId ? v.uuid(unidadeId, "Unidade") : null;
  const modFiltro = modalidade ? v.umDe(modalidade, "Modalidade", MODELOS_LOGISTICOS) : null;
  const sitFiltro = situacao ? v.umDe(situacao, "Situação", ["em_dia", "atencao", "critica", "sem_dados"]) : null;

  const frotaBase = await listarUnidadesElegiveis({ moduloId: MONITOR.modulo }, deps);
  if (!frotaBase.length) return visaoRedeVazia(per);

  const [ano, numMes] = per.periodo.split("-").map(Number);
  const { inicio: inicioMes, fim: fimMes } = janelaDoMes(ano, numMes, { corrente: per.mesCorrente, dataAlvo: per.dataAlvo });
  const antCal = mesAnterior(ano, numMes);
  const diasMesAnterior = diasDoMes(antCal.ano, antCal.mes);
  const inicioMesAnterior = diasMesAnterior[0];
  const fimMesAnterior = diaEquivalenteNoMesAnterior(fimMes, diasMesAnterior);

  // Janela larga para a EVOLUÇÃO MENSAL (até 6 meses, incluindo o atual) — UMA
  // query só; o recorte por mês é feito em memória (igual ao bloco semanal).
  const MESES_EVOLUCAO = 6;
  const mesesEvolucao = [];
  { let a = ano, m = numMes;
    for (let i = 0; i < MESES_EVOLUCAO; i++) { mesesEvolucao.unshift({ ano: a, mes: m }); const p = mesAnterior(a, m); a = p.ano; m = p.mes; } }
  const desdeEvolucao = diasDoMes(mesesEvolucao[0].ano, mesesEvolucao[0].mes)[0];

  const orgIds = [...new Set(frotaBase.map((u) => u.organizacaoId))];
  const [porUnidade, metasLinhas, trocasPorUnidade, precosPorUnidade] = await Promise.all([
    carregarLancamentosDaFrota({
      unidadeIds: frotaBase.map((u) => u.unidadeId), desdeIso: desdeEvolucao, ateIso: fimMes,
    }, deps),
    carregarMetasIndicadores({ organizacaoIds: orgIds }, deps),
    carregarTrocasModeloDaFrota({ unidadeIds: frotaBase.map((u) => u.unidadeId) }, deps),
    carregarPrecosReferenciaDaFrota({ unidades: frotaBase }, deps),
  ]);

  // Só linhas DIÁRIAS entram (ver cabeçalho de administrativo.lucratividade.js).
  const diariasPorUnidade = new Map(frotaBase.map((u) => [
    u.unidadeId, (porUnidade.get(u.unidadeId) ?? []).filter((r) => r.origem_lancamento !== "distribuicao_mensal"),
  ]));

  const unidades = frotaBase.map((u) => {
    const diarias = diariasPorUnidade.get(u.unidadeId) ?? [];
    const doMes = (ym) => diarias.filter((r) => String(r.data_lancamento).slice(0, 7) === ym);
    const linhasAtual = doMes(per.periodo);
    const linhasAnteriores = doMes(ymDe(antCal.ano, antCal.mes));
    // Data REAL do lançamento mais recente do mês — nunca inventada; null quando a unidade não tem nenhum lançamento no período.
    const ultimaAtualizacao = linhasAtual.length
      ? linhasAtual.reduce((max, r) => (String(r.data_lancamento) > max ? String(r.data_lancamento) : max), String(linhasAtual[0].data_lancamento))
      : null;

    const atual = lucratividadeDaUnidade(linhasAtual, { inicio: inicioMes, fim: fimMes, ateDataIso: fimMes });
    const anterior = lucratividadeDaUnidade(linhasAnteriores, { inicio: inicioMesAnterior, fim: fimMesAnterior, ateDataIso: fimMesAnterior });
    const composicao = composicaoDeducoesDoBloco(linhasAtual, inicioMes, fimMes);

    // Modelo VIGENTE no mês (linha do tempo de vigências) — mesmo padrão de
    // `lucratividadeSemanal`. Mês que atravessa uma troca = "misto": meta
    // composta, ponderada pelo faturamento de cada regime.
    const linhaDoTempo = u.modeloLogistico
      ? montarLinhaDoTempo({ modeloAtual: u.modeloLogistico, trocas: trocasDeLinhas(trocasPorUnidade.get(u.unidadeId)) })
      : null;
    const segmentos = linhaDoTempo && fimMes >= inicioMes ? segmentosDoPeriodo(linhaDoTempo, inicioMes, fimMes) : [];
    const estado = segmentos.length ? estadoDoPeriodo(segmentos) : { tipo: u.modeloLogistico ?? null, misto: false };
    const metasDoModelo = (m) => escolherMetas(
      metasLinhas.filter((r) => r.modelo_logistico === m), { organizacaoId: u.organizacaoId, unidadeId: u.unidadeId },
    );
    const modelo = estado.tipo ?? null;
    const divisao = estado.misto ? dividirFinanceiroPorSegmento(linhasAtual, segmentos) : null;
    const consolidado = divisao ? consolidarSegmentos(divisao) : null;
    const indicador = lerTotalDeducoesRentabilidade(linhasAtual, modelo, consolidado);
    const protecao = calcularProtecaoPrecificacao({ ...precosPorUnidade.get(u.unidadeId), ticketMedioIfood: null }).protecaoPrecificacaoPct;
    const metasRentabilidade = (m) => metasComProtecaoPrecificacao(metasDoModelo(m), protecao, m).metas;
    let metaDed;
    if (estado.misto) {
      const partes = divisao.segmentos.map((s) => ({
        modelo: s.modelo,
        peso: s.campos.valorVendasIfood.valorOficial,
        pesoConciliado: s.campos.valorVendasIfood.status === "conciliado",
        metas: metasRentabilidade(s.modelo),
      }));
      metaDed = comporMetas(partes, ["total_deducoes"]).total_deducoes ?? null;
    } else {
      metaDed = modelo ? (metasRentabilidade(modelo).total_deducoes ?? null) : null;
    }

    // Classificar com precisão integral; arredondar apenas os valores apresentados.
    const meta = metaDed ? { metaIdeal: metaDed.metaIdeal, limite: metaDed.limite } : null;
    const situacaoFinanceira = classificarAtencaoFinanceira(indicador.percentual, meta);

    return {
      unidadeId: u.unidadeId,
      nome: u.unidadeNome,
      empresaNome: u.empresaNome,
      organizacaoId: u.organizacaoId,
      cidade: null, // sem coluna de cidade cadastrada hoje — ver limitações no relatório final
      ultimaAtualizacao,
      modeloLogistico: modelo,
      modeloLogisticoRotulo: modelo ? (ROTULO_MODELO[modelo] ?? modelo) : null,

      faturamento: R2(atual.faturamento),
      confirmado: R2(atual.confirmado),
      provisorio: R2(atual.provisorio),
      incluiProvisorio: atual.incluiProvisorio,
      faturamentoAnterior: R2(anterior.faturamento),
      variacaoFaturamento: variacao(atual.faturamento, anterior.faturamento),

      deducoes: R2(atual.deducoes),
      deducoesPct: R2(atual.deducoesPct),
      totalDeducoesIndicador: indicador.valor,
      totalDeducoesIndicadorPct: indicador.percentual,
      composicaoDeducoes: {
        taxasComissoes: R2(composicao.taxasComissoes),
        servicosPromocoes: R2(composicao.servicosPromocoes),
        outrosAjustes: R2(composicao.outrosAjustes),
      },
      meta,
      folgaLimitePp: R2(folgaLimite(indicador.percentual, metaDed)),

      receitaLiquida: R2(atual.receitaLiquida),
      rentabilidadePct: R2(atual.rentabilidadePct),

      situacaoFinanceira,
      impactoFinanceiroEstimado: impactoFinanceiroEstimado(atual.faturamento, indicador.percentual, meta),

      semDado: atual.semDado,
      _anterior: { faturamento: R2(anterior.faturamento), deducoes: R2(anterior.deducoes), receitaLiquida: R2(anterior.receitaLiquida), semDado: anterior.semDado },
    };
  });

  // ---- universo dos CARDS/distribuição: empresa+unidade+modalidade, NUNCA a
  // própria situação (senão a distribuição mostraria sempre 100% num balde). ----
  const universoCards = filtrarUnidadesRede(unidades, { organizacaoId: orgFiltro, unidadeId: uniFiltro, modalidade: modFiltro });
  // ---- universo da TABELA/ranking: todos os filtros, inclusive situação. ----
  const universoTabela = filtrarUnidadesRede(unidades, { organizacaoId: orgFiltro, unidadeId: uniFiltro, modalidade: modFiltro, situacao: sitFiltro, busca });

  const redeAtual = agregarRede(universoCards.map((u) => ({ faturamento: u.faturamento, deducoes: u.deducoes, receitaLiquida: u.receitaLiquida, semDado: u.semDado })));
  const redeAnterior = agregarRede(universoCards.map((u) => u._anterior));
  const composicaoRede = somarComposicaoDeducoes(universoCards.map((u) => u.composicaoDeducoes));
  const distribuicaoSituacoes = contagemPorSituacao(universoCards);
  const orgIdsCards = new Set(universoCards.map((u) => u.organizacaoId));

  const rede = {
    empresasMonitoradas: orgIdsCards.size,
    unidadesMonitoradas: universoCards.length,
    unidadesEmAtencao: distribuicaoSituacoes.atencao,
    unidadesCriticas: distribuicaoSituacoes.critica,
    faturamento: R2(redeAtual.faturamento),
    faturamentoAnterior: R2(redeAnterior.faturamento),
    variacaoFaturamento: variacao(redeAtual.faturamento, redeAnterior.faturamento),
    deducoes: R2(redeAtual.deducoes),
    deducoesPct: R2(redeAtual.deducoesPct),
    taxasComissoes: composicaoRede.taxasComissoes,
    servicosPromocoes: composicaoRede.servicosPromocoes,
    receitaLiquida: R2(redeAtual.receitaLiquida),
    receitaLiquidaAnterior: R2(redeAnterior.receitaLiquida),
    variacaoReceitaLiquida: variacao(redeAtual.receitaLiquida, redeAnterior.receitaLiquida),
    impactoFinanceiroTotalEstimado: R2(universoCards.reduce((s, u) => s + (u.impactoFinanceiroEstimado ?? 0), 0)),
  };

  // ---- evolução mensal (até 6 meses) — mesmo universoCards (sem o filtro de
  // situação, que é do mês corrente), recortando cada mês em memória. ----
  const evolucaoMensal = mesesEvolucao.map(({ ano: a, mes: m }) => {
    const ehCorrente = a === ano && m === numMes;
    const { inicio, fim } = janelaDoMes(a, m, { corrente: ehCorrente && per.mesCorrente, dataAlvo: per.dataAlvo });
    const ym = ymDe(a, m);
    const porUnidadeMes = universoCards.map((u) => {
      const linhas = (diariasPorUnidade.get(u.unidadeId) ?? []).filter((r) => String(r.data_lancamento).slice(0, 7) === ym);
      return lucratividadeDaUnidade(linhas, { inicio, fim, ateDataIso: fim });
    });
    const agg = agregarRede(porUnidadeMes);
    return {
      mes: ym,
      faturamento: R2(agg.faturamento),
      deducoes: R2(agg.deducoes),
      deducoesPct: R2(agg.deducoesPct),
      receitaLiquida: R2(agg.receitaLiquida),
      unidadesComDado: agg.unidadesComDado,
    };
  });

  // ---- rankings, separados por modalidade (estruturas financeiras diferentes). ----
  const rankingPorModalidade = {};
  for (const modelo of MODELOS_LOGISTICOS) {
    const doModelo = universoTabela.filter((u) => u.modeloLogistico === modelo);
    const melhores = doModelo
      .filter((u) => u.situacaoFinanceira.chave !== "sem_dados")
      .sort((a, b) => {
        const ordem = { em_dia: 0, atencao: 1, critica: 2 };
        return ordem[a.situacaoFinanceira.chave] - ordem[b.situacaoFinanceira.chave]
          || b.folgaLimitePp - a.folgaLimitePp;
      })
      .slice(0, 10).map(linhaDeRanking);
    const atencao = ordenarPrioridadeIntervencao(doModelo.filter((u) => ["atencao", "critica"].includes(u.situacaoFinanceira.chave)))
      .slice(0, 10).map(linhaDeRanking);
    rankingPorModalidade[modelo] = { melhores, atencao };
  }

  // ---- tabela gerencial por EMPRESA (consolidada ponderada) + por UNIDADE. ----
  const empresas = consolidarEmpresasRede(universoTabela);

  for (const u of unidades) delete u._anterior;
  universoTabela.sort((a, b) => {
    if (a.faturamento == null && b.faturamento == null) return String(a.nome ?? "").localeCompare(String(b.nome ?? ""), "pt-BR");
    if (a.faturamento == null) return 1;
    if (b.faturamento == null) return -1;
    return b.faturamento - a.faturamento || String(a.nome ?? "").localeCompare(String(b.nome ?? ""), "pt-BR");
  });

  return {
    monitor: MONITOR.chave,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    filtros: { organizacaoId: orgFiltro, unidadeId: uniFiltro, modalidade: modFiltro, situacao: sitFiltro, busca: busca || null },
    rede,
    distribuicaoSituacoes,
    composicaoDeducoes: composicaoRede,
    evolucaoMensal,
    rankingPorModalidade,
    unidades: universoTabela,
    empresas,
  };
}

const linhaDeRanking = (u) => ({
  unidadeId: u.unidadeId, nome: u.nome, empresaNome: u.empresaNome, organizacaoId: u.organizacaoId,
  modeloLogisticoRotulo: u.modeloLogisticoRotulo, faturamento: u.faturamento, deducoesPct: u.deducoesPct,
  totalDeducoesIndicadorPct: u.totalDeducoesIndicadorPct,
  meta: u.meta, folgaLimitePp: u.folgaLimitePp, situacaoFinanceira: u.situacaoFinanceira,
  impactoFinanceiroEstimado: u.impactoFinanceiroEstimado,
});

/**
 * Consolida a tabela gerencial por EMPRESA × MODALIDADE (nunca cruzando os
 * dois modelos numa única linha — estruturas financeiras diferentes). O
 * percentual da linha é recalculado sobre a SOMA dos valores monetários
 * (`agregarRede`), nunca pela média das unidades. A situação da empresa é a
 * PIOR situação entre as unidades do grupo (nunca escondida por uma média).
 */
function consolidarEmpresasRede(unidades) {
  const grupos = new Map();
  for (const u of unidades) {
    const chave = `${u.organizacaoId}::${u.modeloLogistico ?? "sem_modelo"}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(u);
  }
  const ORDEM = { critica: 3, atencao: 2, em_dia: 1, sem_dados: 0 };
  return [...grupos.values()].map((lista) => {
    const agg = agregarRede(lista.map((u) => ({ faturamento: u.faturamento, deducoes: u.deducoes, receitaLiquida: u.receitaLiquida, semDado: u.semDado })));
    const pior = lista.reduce((m, u) => (ORDEM[u.situacaoFinanceira.chave] > ORDEM[m.situacaoFinanceira.chave] ? u : m));
    return {
      organizacaoId: lista[0].organizacaoId,
      empresaNome: lista[0].empresaNome,
      modeloLogistico: lista[0].modeloLogistico,
      modeloLogisticoRotulo: lista[0].modeloLogisticoRotulo,
      unidadesMonitoradas: lista.length,
      faturamento: R2(agg.faturamento),
      deducoes: R2(agg.deducoes),
      deducoesPct: R2(agg.deducoesPct),
      receitaLiquida: R2(agg.receitaLiquida),
      situacaoFinanceira: pior.situacaoFinanceira,
      impactoFinanceiroEstimado: R2(lista.reduce((s, u) => s + (u.impactoFinanceiroEstimado ?? 0), 0)),
    };
  }).sort((a, b) => (b.faturamento ?? 0) - (a.faturamento ?? 0));
}
