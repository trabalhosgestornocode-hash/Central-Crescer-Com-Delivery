// Camada de cálculo da Bonificação Mensal — status do dia, agregados do
// mês (faturamento acumulado, mix ponderado), projeção e validação
// cruzada dos PDFs da Visio. Puro, sem I/O — mesmo espírito de
// dashboard-executivo/dashboardExecutivo.calc.js: o service persiste por
// cima disto, o frontend só mostra o resultado (sempre recomputado no
// servidor).
//
// Regra geral do módulo inteiro: `null` = não informado, `0` = resultado
// real igual a zero. Nunca tratar um como o outro (item 22).

/** @param {number} ano @param {number} mes 1-indexado @returns {string[]} datas ISO (AAAA-MM-DD) do mês inteiro. */
export function diasDoMes(ano, mes) {
  const totalDias = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, "0");
  return Array.from({ length: totalDias }, (_, i) => `${ano}-${pad(mes)}-${pad(i + 1)}`);
}

/** Data de hoje no fuso do negócio (America/Sao_Paulo), em ISO AAAA-MM-DD. */
export function hojeIsoBrasil(agora = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(agora);
}

/** Status possíveis de um dia no calendário da Bonificação Mensal (item 21). */
export const STATUS_DIA_BONIFICACAO = {
  IMPORTADO: "IMPORTADO",       // PDF Geral + PDF Loja confirmados, sem correção manual
  MANUAL: "MANUAL",             // dados completos, mas lançados/corrigidos manualmente
  PARCIAL: "PARCIAL",           // só um dos relatórios, ou falta indicador necessário
  PENDENTE: "PENDENTE",         // dia passado sem nenhuma informação
  FUTURO: "FUTURO",             // dia ainda não ocorreu
  SEM_OPERACAO: "SEM_OPERACAO", // loja marcou explicitamente que não operou
};

// Campos do Geral/Loja que, se corrigidos manualmente, tiram o dia de
// IMPORTADO na Visio — nas DUAS convenções de chave que manual_override usa
// hoje: snake_case (bonificacaoMensal.service.js#processarImportacaoVisio,
// correção durante a prévia) e camelCase (upsertLancamentoManual —
// caminho legado de antes do Ticket Médio virar automático). Nunca inclui
// os indicadores manuais com aba própria (rev/pesquisas/avaliacao_ifood/
// pedidos_chamado/cancelamentos) nem CMV — esses não vêm da Visio.
const CAMPOS_OVERRIDE_VISIO = new Set([
  "faturamento_geral", "faturamentoGeral", "ticket_medio", "ticketMedio",
  "estabelecimento_geral", "ppd_geral", "ppdGeral",
  "faturamento_loja", "faturamentoLoja", "ppd_loja", "ppdLoja", "estabelecimento_loja",
  "qtd_sanduiches_loja", "qtdSanduichesLoja", "qtd_bebidas_loja", "qtdBebidasLoja",
  "qtd_adicionais_loja", "qtdAdicionaisLoja", "qtd_diversos_loja", "qtdDiversosLoja",
]);

/**
 * @param {{lancamento: object|null, dataIso: string, hojeIso: string}} p
 * @returns {string} uma das chaves de STATUS_DIA_BONIFICACAO
 */
export function statusDia({ lancamento, dataIso, hojeIso }) {
  if (dataIso > hojeIso) return STATUS_DIA_BONIFICACAO.FUTURO;
  if (!lancamento) return STATUS_DIA_BONIFICACAO.PENDENTE;
  if (lancamento.semOperacao) return STATUS_DIA_BONIFICACAO.SEM_OPERACAO;

  // Só depende de faturamentoGeral — o Relatório de Vendas (novo layout do
  // Geral, a partir de 15/08/2026) não traz mais PPD, então exigir
  // ppdGeral aqui deixaria TODO dia importado depois da troca preso em
  // PARCIAL/PENDENTE pra sempre (bug real, corrigido na auditoria).
  const temGeral = lancamento.faturamentoGeral != null;
  const temLoja = lancamento.faturamentoLoja != null && lancamento.qtdSanduichesLoja != null
    && lancamento.qtdBebidasLoja != null && lancamento.qtdAdicionaisLoja != null && lancamento.qtdDiversosLoja != null;
  // "Corrigido manualmente" pra fins do status da VISIO só conta um override
  // nos campos do Geral/Loja em si — nunca em REV/Pesquisas/Nota iFood/
  // Pedidos com chamado/Cancelamentos/CMV, que têm aba e calendário PRÓPRIOS
  // (bonificacaoMensalIndicadorManual.js) e não têm nada a ver com a Visio.
  // Sem esse filtro, lançar REV pra um dia (ou um Ticket Médio manual de
  // antes da automação — chaves em snake_case e camelCase coexistem por
  // causa dessa migração) deixava o dia preso em "MANUAL" pra sempre, mesmo
  // com Geral+Loja vindo 100% frescos da Visio (bug real relatado 15/08/2026).
  const overrideAfetaVisio = (chave) => CAMPOS_OVERRIDE_VISIO.has(chave);
  const corrigidoManualmente = !!(lancamento.manualOverride && Object.keys(lancamento.manualOverride).some(overrideAfetaVisio));
  const ehManual = lancamento.origem === "manual" || corrigidoManualmente;

  if (temGeral && temLoja) return ehManual ? STATUS_DIA_BONIFICACAO.MANUAL : STATUS_DIA_BONIFICACAO.IMPORTADO;
  if (temGeral || temLoja) return STATUS_DIA_BONIFICACAO.PARCIAL;
  return STATUS_DIA_BONIFICACAO.PENDENTE;
}

// ---------------------------------------------------------------------------
// ALIMENTAÇÃO DA COMPETÊNCIA — quanto do mês está OFICIALMENTE preenchido.
//
// O calendário diário (statusDia) responde "o mês foi acompanhado dia a dia?".
// Isso NÃO é a mesma pergunta que "o mês está alimentado?": uma competência
// fechada pelo LANÇAMENTO MENSAL (2 relatórios da Visio, origem
// 'fechamento_mensal_direto') está 100% alimentada — o snapshot É o dado
// oficial do mês — mesmo sem um único lançamento diário. Interpretar a
// ausência de lançamentos diários como "31 dias pendentes" está errado para
// esse caso (mesma lógica do lançamento mensal do Dashboard iFood).
//
// Regra por origem:
//   'fechamento_mensal_direto' → 100%, sem calendário diário (não houve).
//   'acompanhamento_diario' / 'legado_pre_refatoracao' → 100%, calendário
//      histórico preservado (o mês FOI consolidado a partir dele).
//   'ao_vivo' (aberta/reaberta/sem competência) → calcula pelos dias reais,
//      exatamente como antes.
// ---------------------------------------------------------------------------
const STATUS_ALIMENTADO = new Set([
  STATUS_DIA_BONIFICACAO.IMPORTADO, STATUS_DIA_BONIFICACAO.MANUAL,
  STATUS_DIA_BONIFICACAO.PARCIAL, STATUS_DIA_BONIFICACAO.SEM_OPERACAO,
]);

const ROTULO_ORIGEM_ALIMENTACAO = {
  fechamento_mensal_direto: "Fechado pelo lançamento mensal",
  acompanhamento_diario: "Consolidado pelo acompanhamento diário",
  legado_pre_refatoracao: "Histórico legado consolidado",
};

/**
 * @param {{ calendario: Array<{status:string}>, congelado: boolean, origemResultado: string }} p
 * @returns {{
 *   origem: string, pct: number, rotulo: string,
 *   mostrarCalendarioDiario: boolean,
 *   diasEsperados: number|null, diasAlimentados: number|null,
 *   contagem: Record<string, number>
 * }}
 */
export function resumoAlimentacaoMes({ calendario = [], congelado = false, origemResultado = "ao_vivo" }) {
  const contagem = {};
  for (const d of calendario) contagem[d.status] = (contagem[d.status] || 0) + 1;

  if (congelado && origemResultado === "fechamento_mensal_direto") {
    return {
      origem: origemResultado, pct: 100,
      rotulo: ROTULO_ORIGEM_ALIMENTACAO[origemResultado],
      mostrarCalendarioDiario: false,
      diasEsperados: null, diasAlimentados: null, contagem,
    };
  }
  if (congelado && (origemResultado === "acompanhamento_diario" || origemResultado === "legado_pre_refatoracao")) {
    return {
      origem: origemResultado, pct: 100,
      rotulo: ROTULO_ORIGEM_ALIMENTACAO[origemResultado],
      mostrarCalendarioDiario: true,
      diasEsperados: null, diasAlimentados: null, contagem,
    };
  }

  // ao vivo — calcula pelos dias reais (mesma conta que a aba fazia no cliente)
  const esperados = calendario.length - (contagem[STATUS_DIA_BONIFICACAO.FUTURO] || 0);
  const alimentados = calendario.filter((d) => STATUS_ALIMENTADO.has(d.status)).length;
  const pct = esperados > 0 ? (alimentados / esperados) * 100 : 0;
  return {
    origem: "ao_vivo", pct,
    rotulo: `${alimentados} de ${esperados} dia${esperados === 1 ? "" : "s"}`,
    mostrarCalendarioDiario: true,
    diasEsperados: esperados, diasAlimentados: alimentados, contagem,
  };
}

// ---------------------------------------------------------------------------
// PERCENTUAIS DERIVADOS (item 10) — nunca depender do percentual do PDF.
// ---------------------------------------------------------------------------

/**
 * Percentual de `valor` sobre `base` (0-100). Null quando a base é inválida
 * OU quando `valor` não foi informado — "não sei" nunca vira "0%".
 * @param {number|null} valor @param {number|null} base
 */
export function percentualDerivado(valor, base) {
  if (valor == null || base == null) return null;
  if (!Number.isFinite(base) || base <= 0) return null;
  return (Number(valor) / base) * 100;
}

/** Mix (Bebidas/Adicionais/Diversos) de um único lançamento diário, a partir das quantidades brutas. */
export function mixDoDia(lancamento) {
  const base = lancamento?.qtdSanduichesLoja ?? null;
  return {
    bebidas: percentualDerivado(lancamento?.qtdBebidasLoja, base),
    adicionais: percentualDerivado(lancamento?.qtdAdicionaisLoja, base),
    diversos: percentualDerivado(lancamento?.qtdDiversosLoja, base),
  };
}

/**
 * Validação cruzada (item 11): compara o percentual que o PRÓPRIO PDF
 * informou com o que o sistema calculou a partir das quantidades brutas.
 * @param {number|null} pdfPct @param {number|null} calculadoPct @param {number} tolerancia pontos percentuais
 */
export function validarPercentualCruzado(pdfPct, calculadoPct, tolerancia = 1.5) {
  if (pdfPct == null || calculadoPct == null) return { divergente: false, diferenca: null };
  const diferenca = Math.abs(pdfPct - calculadoPct);
  return { divergente: diferenca > tolerancia, diferenca };
}

/**
 * Detecta possível inversão entre os PDFs Geral e Loja (item 14-15):
 * Faturamento e PPD do Geral devem ser >= aos do Loja. Não exige igualdade
 * (item 68) — só sinaliza quando o Loja vem MAIOR que o Geral.
 * @param {{faturamento:number, ppd:number, sandwichesSalads:number, beverages:number, additions:number, miscellaneous:number}} geral
 * @param {{faturamento:number, ppd:number, sandwichesSalads:number, beverages:number, additions:number, miscellaneous:number}} loja
 */
export function detectarInversaoRelatorios(geral, loja) {
  const campos = [
    ["faturamento", "Faturamento"], ["ppd", "PPD"], ["sandwichesSalads", "Sanduíches/Saladas"],
    ["beverages", "Bebidas"], ["additions", "Adicionais"], ["miscellaneous", "Diversos"],
  ];
  const violacoes = [];
  for (const [campo, rotulo] of campos) {
    const vg = geral?.[campo], vl = loja?.[campo];
    if (vg != null && vl != null && vl > vg) violacoes.push({ campo, rotulo, geral: vg, loja: vl });
  }
  const invertido = violacoes.some((v) => v.campo === "faturamento" || v.campo === "ppd");
  return { invertido, violacoes };
}

// ---------------------------------------------------------------------------
// AGREGADOS DO MÊS
// ---------------------------------------------------------------------------

/**
 * Faturamento acumulado do mês (item 40) — soma dos dias com dado real.
 * Retorna null (não 0) se nenhum dia do mês tem faturamento informado.
 * @param {Array<{faturamentoGeral: number|null}>} lancamentos
 */
export function faturamentoAcumulado(lancamentos) {
  const validos = (lancamentos || []).filter((l) => l.faturamentoGeral != null);
  if (!validos.length) return null;
  return validos.reduce((s, l) => s + Number(l.faturamentoGeral), 0);
}

/**
 * Mix mensal PONDERADO (itens 44-45): soma das quantidades do mês inteiro,
 * não média simples dos percentuais diários — evita a distorção de dias
 * com volumes muito diferentes.
 * @param {Array<{qtdSanduichesLoja:number|null, qtdBebidasLoja:number|null, qtdAdicionaisLoja:number|null, qtdDiversosLoja:number|null}>} lancamentos
 */
export function mixMensalPonderado(lancamentos) {
  let somaSanduiches = 0, somaBebidas = 0, somaAdicionais = 0, somaDiversos = 0, diasComDados = 0;
  for (const l of lancamentos || []) {
    if (l.qtdSanduichesLoja == null) continue;
    somaSanduiches += Number(l.qtdSanduichesLoja);
    somaBebidas += Number(l.qtdBebidasLoja ?? 0);
    somaAdicionais += Number(l.qtdAdicionaisLoja ?? 0);
    somaDiversos += Number(l.qtdDiversosLoja ?? 0);
    diasComDados++;
  }
  if (!diasComDados || somaSanduiches <= 0) {
    return { bebidas: null, adicionais: null, diversos: null, somaSanduiches, somaBebidas: null, somaAdicionais: null, somaDiversos: null, diasComDados };
  }
  return {
    bebidas: percentualDerivado(somaBebidas, somaSanduiches),
    adicionais: percentualDerivado(somaAdicionais, somaSanduiches),
    diversos: percentualDerivado(somaDiversos, somaSanduiches),
    somaSanduiches, somaBebidas, somaAdicionais, somaDiversos, diasComDados,
  };
}

// NOTA (arquitetura v3.1): não existe "resolvedor" que escolha entre fontes de
// mix, e não há duas versões dos números da competência. Quem decide QUAL
// resultado vale é `bonificacao_competencia.status` (ver obterMes):
//   competência aberta / reaberta → dados atuais (mixMensalPonderado acima)
//   competência fechada           → snapshot congelado da versão vigente
// O mix oficial do mês fechado é montado por `montarResultadoFechamentoOficial`
// (bonificacaoMensal.fechamento.js), a partir das quantidades do Relatório de
// Produtos mensal (Loja/Balcão), com a mesma fórmula Σ acompanhamento ÷ Σ
// principais — não a partir daqui.

/**
 * Ticket Médio mensal PONDERADO (auditoria 15/08/2026, item 9): faturamento
 * acumulado ÷ cupons válidos acumulados — nunca a média simples dos tickets
 * diários (que distorce quando os dias têm volumes muito diferentes, mesmo
 * problema que o Mix já resolvia). Só entra na soma o dia que tem os DOIS
 * dados juntos (faturamento + cupons) — um dia com ticket médio lançado
 * manualmente sem cupons não pode corromper o ponderado do mês.
 * @param {Array<{faturamentoGeral:number|null, cuponsValidosGeral:number|null}>} lancamentos
 * @returns {number|null}
 */
export function ticketMedioPonderado(lancamentos) {
  let somaFaturamento = 0, somaCupons = 0;
  for (const l of lancamentos || []) {
    if (l.faturamentoGeral == null || l.cuponsValidosGeral == null || Number(l.cuponsValidosGeral) <= 0) continue;
    somaFaturamento += Number(l.faturamentoGeral);
    somaCupons += Number(l.cuponsValidosGeral);
  }
  return somaCupons > 0 ? somaFaturamento / somaCupons : null;
}

/**
 * Média de uma lista de valores diários VÁLIDOS (null é ignorado, nunca
 * tratado como 0). Usada para CMV/Ticket médio/REV — indicadores lançados
 * manualmente e nem sempre preenchidos todo dia.
 * @param {Array<number|null|undefined>} valores
 */
export function mediaDiaria(valores) {
  const validos = (valores ?? []).filter((v) => v != null && Number.isFinite(Number(v)));
  if (!validos.length) return null;
  return validos.reduce((s, v) => s + Number(v), 0) / validos.length;
}

/**
 * Soma de uma lista de valores diários VÁLIDOS — para indicadores
 * CUMULATIVOS no mês (ex.: Pesquisas/NPS, item 34), diferente de
 * `mediaDiaria`. null (não 0) se nenhum dia tem o dado.
 * @param {Array<number|null|undefined>} valores
 */
export function somaValida(valores) {
  const validos = (valores ?? []).filter((v) => v != null && Number.isFinite(Number(v)));
  if (!validos.length) return null;
  return validos.reduce((s, v) => s + Number(v), 0);
}

/**
 * Projeção de faturamento para o fechamento do mês (itens 41-43).
 * NUNCA "média dos dias preenchidos × dias do mês" ingênuo: dias com
 * `semOperacao=true` e dias sem lançamento (pendentes) ficam de fora da
 * média-base, e só os dias FUTUROS entram como "dias restantes" — dias
 * passados pendentes não inflam nem descontam a projeção, só ficam
 * sinalizados para o usuário resolver.
 * @param {{lancamentos: Array<object>, ano:number, mes:number, hojeIso:string}} p
 */
export function projecaoFaturamento({ lancamentos, ano, mes, hojeIso }) {
  const dias = diasDoMes(ano, mes);
  const porData = new Map((lancamentos || []).map((l) => [l.data, l]));
  const passados = dias.filter((d) => d <= hojeIso);
  const futuros = dias.filter((d) => d > hojeIso);

  let acumulado = 0, diasValidos = 0, diasPendentes = 0, diasSemOperacao = 0;
  for (const d of passados) {
    const l = porData.get(d);
    if (!l) { diasPendentes++; continue; }
    if (l.semOperacao) { diasSemOperacao++; continue; }
    if (l.faturamentoGeral == null) { diasPendentes++; continue; }
    acumulado += Number(l.faturamentoGeral);
    diasValidos++;
  }

  const mesFechado = futuros.length === 0 && diasPendentes === 0;
  if (!diasValidos) {
    return {
      acumulado: acumulado || null, mediaDiariaValida: null, projecao: null,
      diasValidos, diasPendentes, diasSemOperacao, diasRestantes: futuros.length, mesFechado,
    };
  }

  const mediaDiariaValida = acumulado / diasValidos;
  const diasRestantes = futuros.length;
  // Mês fechado (sem dias futuros nem pendentes): a "projeção" é o próprio
  // acumulado — não há mais nada a estimar, é o resultado final.
  const projecao = mesFechado ? acumulado : acumulado + mediaDiariaValida * diasRestantes;

  return { acumulado, mediaDiariaValida, projecao, diasValidos, diasPendentes, diasSemOperacao, diasRestantes, mesFechado };
}

/**
 * Ritmo diário necessário para alcançar uma próxima faixa (item 43):
 * quanto falta ÷ dias operacionais restantes.
 * @param {number|null} faltante @param {number|null} diasRestantes
 */
export function ritmoNecessario(faltante, diasRestantes) {
  if (faltante == null || diasRestantes == null || diasRestantes <= 0) return null;
  return faltante / diasRestantes;
}

/** Participação do balcão no faturamento do dia/mês (item 54) — dado disponível, ainda sem regra de meta. */
export function participacaoLoja(faturamentoLoja, faturamentoGeral) {
  return percentualDerivado(faturamentoLoja, faturamentoGeral);
}

// ---------------------------------------------------------------------------
// VALIDAÇÃO DE UNIDADE (item 16 — CRÍTICA)
// ---------------------------------------------------------------------------

// Palavras genéricas demais para provar de qual loja é o relatório (o nome
// da unidade no sistema raramente é IDÊNTICO ao nome do estabelecimento na
// Visio — ex.: sistema "Subway Saci — Matriz" x Visio "Subway Teresina
// Saci" — então a comparação é por TOKEN DISTINTIVO em comum, não por
// igualdade de string).
const PALAVRAS_GENERICAS = new Set([
  "subway", "sanduiches", "sanduíches", "loja", "unidade", "matriz", "delivery", "restaurante", "the",
]);

function tokensDistintivos(nome) {
  return norm(nome).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !PALAVRAS_GENERICAS.has(t));
}
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

/**
 * O relatório da Visio pertence à unidade atualmente selecionada? Nunca
 * compara por igualdade exata (os nomes vêm de sistemas diferentes) — basta
 * um token distintivo em comum (ex.: "saci"). Se o PDF não trouxe nome
 * nenhum, não bloqueia (mas também não confirma) — quem decide é quem tem
 * outros sinais (data duplicada, faixas de valor etc.).
 * @param {string|null} nomeUnidadeSistema @param {string|null} nomeEstabelecimentoVisio
 * @returns {boolean|null} true = bate, false = diverge, null = não deu para comparar
 */
export function mesmaUnidadeVisio(nomeUnidadeSistema, nomeEstabelecimentoVisio) {
  if (!nomeUnidadeSistema || !nomeEstabelecimentoVisio) return null;
  const distintivosSistema = new Set(tokensDistintivos(nomeUnidadeSistema));
  const distintivosVisio = tokensDistintivos(nomeEstabelecimentoVisio);
  if (!distintivosSistema.size || !distintivosVisio.length) return null;
  return distintivosVisio.some((t) => distintivosSistema.has(t));
}
