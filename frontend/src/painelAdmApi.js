// Cliente da API do PAINEL ADMINISTRATIVO (/api/v1/administrativo).
//
// AUTENTICAÇÃO: a mesma do resto do frontend — o Bearer do Supabase
// (`tokenAtual()`), que é a IDENTIDADE. Não há autenticação paralela.
//
// DIFERENÇA DELIBERADA em relação a sessao.js#http: aqui NUNCA vai o header
// `x-context-token`. O Painel Administrativo não opera sob o contexto de
// nenhuma empresa (igual ao Painel SuperAdmin) — mandar o token de contexto
// seria semanticamente errado, mesmo que o backend o ignore nessas rotas.
import { API_BASE } from "./config.js";
import { tokenAtual } from "./supabaseClient.js";

const BASE = "/api/v1/administrativo";

/** Monta a query string, descartando vazios / "todos". @param {Record<string, unknown>} p */
function qs(p = {}) {
  const s = Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== "todos")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return s ? `?${s}` : "";
}

/**
 * @param {string} rota
 * @param {RequestInit & {json?: object}} [opcoes] `json` serializa o corpo e
 *   já manda o Content-Type — só as rotas de desbloqueio usam.
 */
async function chamar(rota, opcoes = {}) {
  const token = await tokenAtual();
  const { json, ...resto } = opcoes;
  const r = await fetch(API_BASE + BASE + rota, {
    ...resto,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    headers: {
      ...(opcoes.headers ?? {}),
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = typeof corpo.error === "string" ? corpo.error : (corpo.error?.message ?? `${r.status} ${r.statusText}`);
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return corpo.data ?? corpo;
}

export const painelAdmApi = {
  performance: (params = {}) => chamar('/performance' + qs(params)),
  performanceUnidades: () => chamar('/performance/unidades'),
  performanceCompetencia: (unidadeId, competencia) => chamar(`/performance/unidades/${encodeURIComponent(unidadeId)}/competencias/${encodeURIComponent(competencia)}`),
  performanceSalvar: (unidadeId, competencia, dados) => chamar(`/performance/unidades/${encodeURIComponent(unidadeId)}/competencias/${encodeURIComponent(competencia)}`, { method:'PATCH', json:dados }),
  desenvolvimento: (rota, params = {}) => chamar('/desenvolvimento' + rota + qs(params)),
  salvarDemanda: (id, dados) => chamar('/desenvolvimento/demandas' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) }),
  excluirDemanda: (id, versao) => chamar('/desenvolvimento/demandas/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versao }) }),
  atualizarDemanda: (id, dados) => chamar('/desenvolvimento/demandas/' + encodeURIComponent(id) + '/atualizacoes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) }),
  /**
   * Sanidade + validação REAL do acesso. 200 = pode entrar; 403 = acesso não
   * está mais disponível (ex.: SuperAdmin revogou depois da tela carregada).
   */
  ping: () => chamar("/ping"),

  // -- Monitoramento. Só leitura, Bearer, sem x-context-token. --
  //
  // PERÍODO ATIVO: todos aceitam `mes=AAAA-MM` (opcional). Ausente = mês
  // corrente. O backend deriva o dia de referência do período: D-1 no mês
  // corrente, último dia num mês já fechado.

  /** Resumo consolidado + "Ação Necessária Hoje" + rollup por empresa. */
  visaoGeral: ({ mes } = {}) => chamar("/visao-geral" + qs({ mes })),

  /**
   * Lista de unidades num dia. Sem `data`, usa o dia de referência do `mes`.
   * Filtros server-side: `mes`, `data` (AAAA-MM-DD, nunca hoje/futuro),
   * `organizacaoId`, `status` (categoria do D-1), `criticidade`.
   * A busca textual é client-side.
   * @param {{mes?: string, data?: string, organizacaoId?: string, status?: string, criticidade?: string}} [filtros]
   */
  monitoramentoDiario: (filtros = {}) => chamar("/monitoramento-diario" + qs(filtros)),

  /** Só unidades não-em-dia. Ordem (CRÍTICO → mais antigo → ATENÇÃO) vem pronta. */
  pendencias: ({ mes } = {}) => chamar("/pendencias" + qs({ mes })),

  /** Rollup por organização (conformidade = Σ/Σ). */
  empresas: ({ mes } = {}) => chamar("/empresas" + qs({ mes })),

  /** Detalhe de uma empresa: resumo + unidades + pendências. */
  detalheEmpresa: (organizacaoId, { mes } = {}) =>
    chamar(`/empresas/${encodeURIComponent(organizacaoId)}` + qs({ mes })),

  /**
   * Calendário mensal de uma unidade — abre no `mes` do período ativo.
   * @param {string} unidadeId
   * @param {string} [mes] AAAA-MM (padrão: mês corrente do backend)
   */
  calendarioUnidade: (unidadeId, mes) =>
    chamar(`/unidades/${encodeURIComponent(unidadeId)}/calendario` + qs({ mes })),

  // -- Desbloqueio administrativo de um dia (migration 068) --
  //
  // As ÚNICAS chamadas de ESCRITA do painel. Quem decide se um dia PODE ser
  // liberado é o backend (`podeDesbloquear` vem pronto no calendário); aqui
  // não se recalcula regra nenhuma.

  /** Histórico de liberações da unidade no mês (ativas e revogadas). */
  desbloqueios: (unidadeId, mes) =>
    chamar(`/unidades/${encodeURIComponent(unidadeId)}/desbloqueios` + qs({ mes })),

  /**
   * Libera UM dia. `motivo` é uma das chaves canônicas do backend;
   * `observacao` é obrigatória quando o motivo é "outro".
   * @param {string} unidadeId
   * @param {{data: string, motivo: string, observacao?: string}} corpo
   */
  desbloquearDia: (unidadeId, corpo) =>
    chamar(`/unidades/${encodeURIComponent(unidadeId)}/desbloqueios`, { method: "POST", json: corpo }),

  /** Revoga uma liberação ainda não usada. */
  revogarDesbloqueio: (unidadeId, desbloqueioId) =>
    chamar(`/unidades/${encodeURIComponent(unidadeId)}/desbloqueios/${encodeURIComponent(desbloqueioId)}`, { method: "DELETE" }),

  // -- Financeiro / Relatórios --
  //
  // Rotas próprias de propósito: o ranking completo não pertence ao payload da
  // Visão Geral (que carrega só o consolidado e os líderes).

  /** Ranking por faturamento absoluto. `escopo`: empresas | unidades. */
  rankingFaturamento: ({ mes, escopo, limite } = {}) =>
    chamar("/rankings/faturamento" + qs({ mes, escopo, limite })),

  /** Ranking por conformidade. `ordem=asc` = quem precisa de mais atenção. */
  rankingConformidade: ({ mes, escopo, ordem, limite } = {}) =>
    chamar("/rankings/conformidade" + qs({ mes, escopo, ordem, limite })),

  /** Relatório executivo do período (operação + conformidade + financeiro). */
  relatorioResumo: ({ mes, topN } = {}) => chamar("/relatorios/resumo" + qs({ mes, topN })),

  /** Pacote COMPLETO do relatório executivo — a fonte única do PDF. */
  relatorioExecutivo: ({ mes, topN } = {}) => chamar("/relatorios/executivo" + qs({ mes, topN })),

  /** Série diária de faturamento — rede inteira ou uma empresa. */
  relatorioEvolucao: ({ mes, organizacaoId } = {}) =>
    chamar("/relatorios/evolucao" + qs({ mes, organizacaoId })),

  /**
   * Análise por BLOCO SEMANAL FIXO DO MÊS (1: 01–07 · 2: 08–14 · 3: 15–21 ·
   * 4: 22–fim) da frota — alimenta as abas Lucratividade e Rentabilidade.
   * `semana` = qualquer data AAAA-MM-DD dentro do bloco; ausente = bloco de D-1.
   */
  relatorioLucratividade: ({ semana } = {}) =>
    chamar("/relatorios/lucratividade" + qs({ semana })),
};
