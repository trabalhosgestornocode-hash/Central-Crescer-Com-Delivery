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

  /**
   * Mentorados: contas da plataforma + vínculos empresa/unidade já
   * consolidados. Somente leitura. Não usa `mes` — não é um dado do período.
   * A busca por nome/e-mail é client-side (poucas contas).
   */
  mentorados: () => chamar("/mentorados"),

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

  // -- Comunicação / WhatsApp (Checkpoint H.3-A) --
  //
  // Não usa `mes` — a área não olha "um mês por vez" (mesmo espírito de
  // mentorados/desenvolvimento). A ÚNICA escrita é `comunicacaoAtualizarConfiguracao`,
  // e mesmo ela NUNCA habilita envio (o backend recusa `habilitado != false`).

  /** Cards da visão geral: Gateway, worker, modo global, empresas, fila, hoje. */
  comunicacaoResumo: () => chamar("/comunicacao/resumo"),

  /** Lista de empresas com status de configuração da comunicação. */
  comunicacaoOrganizacoes: ({ busca } = {}) => chamar("/comunicacao/organizacoes" + qs({ busca })),

  /** Detalhe de uma empresa: configuração, destinatário (mascarado), unidades pendentes. */
  comunicacaoDetalheOrganizacao: (organizacaoId) =>
    chamar(`/comunicacao/organizacoes/${encodeURIComponent(organizacaoId)}`),

  /** Perfis ELEGÍVEIS desta organização (vínculo ativo) — para o combobox de destinatário. Nunca de outra organização. */
  comunicacaoPerfisElegiveis: (organizacaoId) =>
    chamar(`/comunicacao/organizacoes/${encodeURIComponent(organizacaoId)}/perfis-elegiveis`),

  /** Pré-visualização SOMENTE LEITURA do texto que seria enviado (Checkpoint H.4-A) — nunca envia nada. */
  comunicacaoPreverMensagem: (organizacaoId, { unidadeId } = {}) =>
    chamar(`/comunicacao/organizacoes/${encodeURIComponent(organizacaoId)}/preview-mensagem` + qs({ unidadeId })),

  /**
   * Prepara a configuração de uma empresa — NUNCA habilita envio.
   * @param {string} organizacaoId
   * @param {{telefoneE164?: string, perfilOperacionalId?: string, timezone?: string,
   *   tiposPermitidos?: string[], pausadoAte?: string|null, pausadoMotivo?: string|null}} dados
   */
  comunicacaoAtualizarConfiguracao: (organizacaoId, dados) =>
    chamar(`/comunicacao/organizacoes/${encodeURIComponent(organizacaoId)}/configuracao`, { method: "PUT", json: dados }),

  /**
   * Confirma consentimento + verificação do contato já configurado —
   * Checkpoint H.4-A.3.2. NUNCA envia WhatsApp, NUNCA habilita a organização.
   * Só chame depois de confirmação humana explícita e inequívoca (fora
   * deste código) — o único payload aceito é `confirmacaoExplicita:true`.
   */
  comunicacaoConfirmarConsentimento: (organizacaoId) =>
    chamar(`/comunicacao/organizacoes/${encodeURIComponent(organizacaoId)}/consentimento`, { method: "POST", json: { confirmacaoExplicita: true } }),

  /**
   * Checkpoint H.4-B.1 — as ÚNICAS alavancas de envio (ator humano autenticado; o backend valida tudo).
   * `comunicacaoAtivacao`: modo + prova do piloto no runtime do servidor (contagens, nunca telefone).
   */
  comunicacaoAtivacao: () => chamar("/comunicacao/ativacao"),

  /** Habilita/desabilita a comunicação de UMA empresa. Habilitar exige confirmação explícita (enviada aqui; a UI só chama depois do modal). */
  comunicacaoDefinirHabilitacao: (organizacaoId, habilitado) =>
    chamar(`/comunicacao/organizacoes/${encodeURIComponent(organizacaoId)}/habilitacao`, {
      method: "PUT", json: habilitado === true ? { habilitado: true, confirmacaoExplicita: true } : { habilitado: false },
    }),

  /** Liga (NORMAL) ou desliga (DISABLED) a comunicação automática global. Ligar exige confirmação explícita. */
  comunicacaoDefinirModo: (modo) =>
    chamar("/comunicacao/modo", { method: "PUT", json: modo === "NORMAL" ? { modo: "NORMAL", confirmacaoExplicita: true } : { modo: "DISABLED" } }),

  /** Fila (mensagens ainda em jogo). `status`, `organizacaoId`, `pagina`, `porPagina`. */
  comunicacaoFila: (filtros = {}) => chamar("/comunicacao/fila" + qs(filtros)),

  /** Histórico (mensagens em estado terminal). Mesmos filtros + `tipoAlerta`/`desde`/`ate`. */
  comunicacaoHistorico: (filtros = {}) => chamar("/comunicacao/historico" + qs(filtros)),

  // -- Central de Comunicação (H.4-B.5) --

  /** Histórico COMPLETO de mensagens (todas as origens/status): empresa, unidade, status, origem, desde/ate (ISO), busca (nome), pagina, porPagina. */
  comunicacaoMensagens: (filtros = {}) => chamar("/comunicacao/mensagens" + qs(filtros)),

  /** Detalhe de uma mensagem (ids abreviados, timestamps, tentativas) — sem conteúdo, sem telefone completo. */
  comunicacaoMensagem: (id) => chamar(`/comunicacao/mensagens/${encodeURIComponent(id)}`),

  /** Configuração operacional GLOBAL — somente leitura. */
  comunicacaoConfiguracaoOperacional: () => chamar("/comunicacao/configuracao-operacional"),

  /** O que o modal do teste mostra: empresa, unidade, contato mascarado, WhatsApp, consentimento, verificação, preview e bloqueios. */
  comunicacaoTestePreparo: ({ organizacaoId, unidadeId } = {}) => chamar("/comunicacao/teste/preparo" + qs({ organizacaoId, unidadeId })),

  /**
   * ENVIA UMA mensagem de teste (ator humano + confirmação explícita; o backend valida todos os gates). `testeId` é gerado pela TELA ao abrir o modal:
   * duplo clique = mesmo testeId = uma única mensagem.
   */
  comunicacaoTesteEnviar: ({ organizacaoId, unidadeId, testeId }) =>
    chamar("/comunicacao/teste", { method: "POST", json: { organizacaoId, unidadeId, testeId, confirmacaoExplicita: true } }),

  /** Acompanhamento do teste (a tela consulta a cada poucos segundos). */
  comunicacaoTesteStatus: (mensagemId) => chamar(`/comunicacao/teste/${encodeURIComponent(mensagemId)}`),

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
