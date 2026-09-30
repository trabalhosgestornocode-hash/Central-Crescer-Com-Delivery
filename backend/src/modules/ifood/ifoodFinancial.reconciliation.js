// Conciliação Financeira consolidada (Bloco H) — trilha auditável entre
// Sales → Financial Events → Settlements → Reconciliation → Anticipation.
//
// CAMADA SEPARADA E MAJORITARIAMENTE PURA (regra fundamental do pedido):
//   * não altera nenhum contrato/service/mapper individual já implementado;
//   * consome só as formas JÁ NORMALIZADAS que ifoodFinancial.service.js
//     devolve (mapearRespostaSales/FinancialEvents/Settlements/
//     Reconciliation/Anticipation, de ifoodFinancial.mapper.js) — nunca o
//     payload bruto do iFood;
//   * a ÚNICA função com efeito colateral é a raiz `conciliarFinancial`
//     receber os dados já buscados (I/O é responsabilidade de
//     ifoodFinancial.service.js#obterConciliacaoFinanceira).
//
// RESILIÊNCIA (Bloco 12): cada uma das 5 fontes é OPCIONAL —
// `null`/`undefined` significa "não foi possível buscar" (erro, ou o
// chamador optou por não buscar); um objeto com arrays vazios significa
// "buscou com sucesso, zero registros". As duas situações são tratadas de
// forma DIFERENTE (ver classificarComparacao) — ausência de dado nunca vira
// divergência.
//
// DINHEIRO: toda soma/comparação acontece em CENTAVOS INTEIROS (nunca soma
// float diretamente) — ver paraCentavos/centavosParaReais/somaCentavos. A
// única tolerância usada é de ±1 centavo, documentada em TOLERANCIA_CENTAVOS
// — cobre arredondamento de casas decimais entre APIs distintas, não é uma
// regra de negócio.

// ---------------------------------------------------------------------------
// Dinheiro seguro
// ---------------------------------------------------------------------------

/** number -> centavos inteiros. null/NaN/undefined -> null (nunca 0 — 0 é um
 * valor real, null é "não sei"). */
export function paraCentavos(valor) {
  if (typeof valor !== "number" || !Number.isFinite(valor)) return null;
  return Math.round(valor * 100);
}

export function centavosParaReais(centavos) {
  return centavos === null || centavos === undefined ? null : centavos / 100;
}

/** Soma uma lista de `number|null|undefined` em centavos, ignorando os que
 * não são números válidos (não deixa um único campo ausente derrubar a soma
 * inteira — cada valor ausente só não entra na conta). */
export function somaCentavos(valores) {
  return valores.reduce((acc, v) => {
    const c = paraCentavos(v);
    return c === null ? acc : acc + c;
  }, 0);
}

/** hasTransferImpact não informado (null) — nunca tratado como "sem impacto". */
export const impactoDesconhecido = (e) => e?.temImpactoRepasse !== true && e?.temImpactoRepasse !== false;

// Tolerância monetária ÚNICA do módulo — 1 centavo. Cobre diferença de
// arredondamento entre APIs que formatam o mesmo valor com casas decimais
// calculadas de formas distintas (ex.: percentual de taxa aplicado em pontos
// diferentes da cadeia de cálculo). NÃO é uma regra de negócio do iFood —
// é uma decisão de engenharia, documentada aqui por ser a única do módulo.
export const TOLERANCIA_CENTAVOS = 1;

// ---------------------------------------------------------------------------
// Status de conciliação — vocabulário fechado (Bloco 6)
// ---------------------------------------------------------------------------
export const STATUS_CONCILIACAO = Object.freeze({
  CONCILIADO: "CONCILIADO",         // os dois lados presentes e iguais (± tolerância)
  DIVERGENTE: "DIVERGENTE",         // os dois lados presentes e diferentes além da tolerância
  INCOMPLETO: "INCOMPLETO",         // pelo menos um lado não tem dado (fonte ausente ou campo nulo)
  SEM_DADOS: "SEM_DADOS",           // não há NADA pra comparar (nem um lado nem outro)
  NAO_COMPARAVEL: "NAO_COMPARAVEL", // os dados existem mas não há chave/coluna de correlação
});

/**
 * Regra CENTRAL de classificação — reutilizada pelas 3 comparações par-a-par.
 * Ausência de dado NUNCA vira divergência (Bloco 6).
 * @param {number|null} esperadoCentavos
 * @param {number|null} encontradoCentavos
 */
export function classificarComparacao(esperadoCentavos, encontradoCentavos, tolerancia = TOLERANCIA_CENTAVOS) {
  if (esperadoCentavos === null || encontradoCentavos === null) {
    return { status: STATUS_CONCILIACAO.INCOMPLETO, divergenciaCentavos: null };
  }
  const diff = encontradoCentavos - esperadoCentavos;
  return {
    status: Math.abs(diff) <= tolerancia ? STATUS_CONCILIACAO.CONCILIADO : STATUS_CONCILIACAO.DIVERGENTE,
    divergenciaCentavos: diff,
  };
}

/** Agrega uma lista de status individuais (ex.: 1 por venda) num só. Prioridade:
 * qualquer DIVERGENTE vence; senão, todos CONCILIADO -> CONCILIADO; lista
 * vazia -> SEM_DADOS; caso contrário -> INCOMPLETO (tem algo faltando). */
function agregarStatus(lista) {
  if (lista.length === 0) return STATUS_CONCILIACAO.SEM_DADOS;
  if (lista.some((s) => s === STATUS_CONCILIACAO.DIVERGENTE)) return STATUS_CONCILIACAO.DIVERGENTE;
  if (lista.every((s) => s === STATUS_CONCILIACAO.CONCILIADO)) return STATUS_CONCILIACAO.CONCILIADO;
  return STATUS_CONCILIACAO.INCOMPLETO;
}

/** Agrega os status das 3 comparações par-a-par num `statusGeral`. Prioridade:
 * DIVERGENTE > NAO_COMPARAVEL (sem misturar com INCOMPLETO) > INCOMPLETO >
 * CONCILIADO; tudo SEM_DADOS -> SEM_DADOS. */
function agregarStatusGeral(lista) {
  const validos = lista.filter(Boolean);
  if (validos.length === 0 || validos.every((s) => s === STATUS_CONCILIACAO.SEM_DADOS)) return STATUS_CONCILIACAO.SEM_DADOS;
  if (validos.some((s) => s === STATUS_CONCILIACAO.DIVERGENTE)) return STATUS_CONCILIACAO.DIVERGENTE;
  if (validos.every((s) => s === STATUS_CONCILIACAO.CONCILIADO)) return STATUS_CONCILIACAO.CONCILIADO;
  if (validos.some((s) => s === STATUS_CONCILIACAO.NAO_COMPARAVEL) && !validos.some((s) => s === STATUS_CONCILIACAO.INCOMPLETO)) {
    return STATUS_CONCILIACAO.NAO_COMPARAVEL;
  }
  return STATUS_CONCILIACAO.INCOMPLETO;
}

// ---------------------------------------------------------------------------
// 1. Sales × Financial Events — por venda (sale.id ↔ evento.referencia.id)
// ---------------------------------------------------------------------------

/**
 * @param {object[]|null} vendasList  ifoodFinancial.mapper.js#mapearVenda[]
 * @param {object[]|null} eventosList ifoodFinancial.mapper.js#mapearEventoFinanceiro[]
 */
export function conciliarSalesComEvents(vendasList, eventosList) {
  const vendas = vendasList ?? [];
  const eventos = eventosList ?? [];

  // Agrupa eventos por pedido — só referencia.tipo === "ORDER" tem sentido
  // aqui (a doc também cita "TRANSACTION" como outro tipo possível de
  // referência, que não se relaciona com uma venda específica).
  const eventosPorVenda = new Map();
  for (const ev of eventos) {
    if (ev?.referencia?.tipo !== "ORDER" || !ev?.referencia?.id) continue;
    const lista = eventosPorVenda.get(ev.referencia.id) ?? [];
    lista.push(ev);
    eventosPorVenda.set(ev.referencia.id, lista);
  }

  const porVenda = vendas.map((venda) => {
    const eventosDaVenda = eventosPorVenda.get(venda.id) ?? [];
    const impactantes = eventosDaVenda.filter((e) => e.temImpactoRepasse === true);
    // Eventos SEM impacto continuam aparecendo na explicação (Bloco 1) —
    // só não entram na soma comparada contra o saldo.
    const semImpacto = eventosDaVenda.filter((e) => e.temImpactoRepasse === false);
    const impactoNaoInformado = eventosDaVenda.filter(impactoDesconhecido);
    const saleBalanceCentavos = paraCentavos(venda.resumoFinanceiro?.saldo);
    const somaImpactantesCentavos = somaCentavos(impactantes.map((e) => e.valor));

    // Nenhum evento encontrado pra esta venda: não é divergência (pode ainda
    // não ter chegado, ou o período consultado não cobriu os eventos dela)
    // — é dado incompleto. Evento com impacto desconhecido também: a soma não fecha.
    const comparacao = eventosDaVenda.length === 0 || impactoNaoInformado.length > 0
      ? { status: STATUS_CONCILIACAO.INCOMPLETO, divergenciaCentavos: null }
      : classificarComparacao(saleBalanceCentavos, somaImpactantesCentavos);

    return {
      saleId: venda.id,
      saleShortId: venda.shortId,
      saleBalance: venda.resumoFinanceiro?.saldo ?? null,
      somaEventosImpactantes: centavosParaReais(somaImpactantesCentavos),
      eventosComImpacto: impactantes.length,
      eventosSemImpacto: semImpacto.length,
      eventosImpactoNaoInformado: impactoNaoInformado.length,
      eventos: eventosDaVenda.map((e) => ({ nome: e.nome, valor: e.valor, temImpactoRepasse: e.temImpactoRepasse })),
      status: comparacao.status,
      divergencia: centavosParaReais(comparacao.divergenciaCentavos),
    };
  });

  return {
    quantidadeVendas: vendas.length,
    quantidadeConciliadas: porVenda.filter((v) => v.status === STATUS_CONCILIACAO.CONCILIADO).length,
    quantidadeDivergentes: porVenda.filter((v) => v.status === STATUS_CONCILIACAO.DIVERGENTE).length,
    quantidadeIncompletas: porVenda.filter((v) => v.status === STATUS_CONCILIACAO.INCOMPLETO).length,
    status: agregarStatus(porVenda.map((v) => v.status)),
    porVenda,
  };
}

// ---------------------------------------------------------------------------
// 2. Financial Events × Settlements — nível de período (não por venda)
// ---------------------------------------------------------------------------

/**
 * @param {object[]|null} eventosList
 * @param {{saldo:number|null, titulos:object[]}|null} settlementsData
 */
export function conciliarEventsComSettlements(eventosList, settlementsData) {
  // Uma das duas fontes nem foi buscada -> não dá pra comparar nada, mas
  // ainda mostramos o que existe do lado que TEM dado.
  if (eventosList === null || eventosList === undefined || settlementsData === null || settlementsData === undefined) {
    const eventos = eventosList ?? [];
    const impactantes = eventos.filter((e) => e.temImpactoRepasse === true);
    return {
      eventosComImpacto: impactantes.length,
      eventosSemImpacto: eventos.filter((e) => e.temImpactoRepasse === false).length,
      eventosImpactoNaoInformado: eventos.filter(impactoDesconhecido).length,
      somaEventosImpactantes: eventosList ? centavosParaReais(somaCentavos(impactantes.map((e) => e.valor))) : null,
      settlementBalance: settlementsData?.saldo ?? null,
      closingItemsTotal: settlementsData ? centavosParaReais(somaCentavos((settlementsData.titulos ?? []).map((t) => t.valor))) : null,
      status: STATUS_CONCILIACAO.INCOMPLETO,
      divergencia: null,
    };
  }

  const impactantes = eventosList.filter((e) => e.temImpactoRepasse === true);
  const semImpacto = eventosList.filter((e) => e.temImpactoRepasse === false);
  const impactoNaoInformado = eventosList.filter(impactoDesconhecido);
  const somaEventosCentavos = somaCentavos(impactantes.map((e) => e.valor));
  const settlementBalanceCentavos = paraCentavos(settlementsData.saldo);
  const closingItemsTotalCentavos = somaCentavos((settlementsData.titulos ?? []).map((t) => t.valor));

  const comparacao = impactoNaoInformado.length > 0
    ? { status: STATUS_CONCILIACAO.INCOMPLETO, divergenciaCentavos: null }
    : classificarComparacao(settlementBalanceCentavos, somaEventosCentavos);

  return {
    eventosComImpacto: impactantes.length,
    eventosSemImpacto: semImpacto.length,
    eventosImpactoNaoInformado: impactoNaoInformado.length,
    somaEventosImpactantes: centavosParaReais(somaEventosCentavos),
    settlementBalance: settlementsData.saldo ?? null,
    closingItemsTotal: centavosParaReais(closingItemsTotalCentavos),
    status: comparacao.status,
    divergencia: centavosParaReais(comparacao.divergenciaCentavos),
  };
}

// ---------------------------------------------------------------------------
// 3. Reconciliation — adapter de colunas desconhecidas (Bloco 3)
// ---------------------------------------------------------------------------
//
// Os nomes REAIS das colunas do CSV nunca foram confirmados (nenhuma fonte
// oficial documenta isso — ver ifoodFinancial.mapper.js#parsearArquivoConciliacao).
// Este adapter faz o MELHOR ESFORÇO por heurística de nomes prováveis, sem
// nunca quebrar se o arquivo real tiver nomenclatura diferente: colunas que
// não batem com nenhum candidato ficam preservadas em `bruto`, e o registro
// é marcado `correlacao: "nao_determinada"` em vez de inventar um vínculo.

const CANDIDATOS_COLUNA_ID = ["pedido", "id_pedido", "order_id", "orderid", "numero_pedido", "sale_id", "saleid", "id"];
const CANDIDATOS_COLUNA_VALOR = ["valor", "value", "amount", "valor_transacao", "valor_liquido", "valor_repasse"];

function normalizarNomeColuna(c) {
  return String(c ?? "").toLowerCase().trim();
}

function detectarColuna(colunas, candidatos) {
  const normalizadas = colunas.map(normalizarNomeColuna);
  for (const candidato of candidatos) {
    const idx = normalizadas.indexOf(candidato);
    if (idx !== -1) return colunas[idx];
  }
  return null;
}

/** "1.234,56" (BR) ou "1,234.56" (US) ou "45.00"/"45,00" simples -> number.
 * Sem essa conversão, valores com vírgula decimal (comum em CSV brasileiro)
 * virariam NaN. Nunca lança — retorna null se não conseguir interpretar. */
export function numeroDeTextoMonetario(texto) {
  if (typeof texto === "number") return Number.isFinite(texto) ? texto : null;
  if (typeof texto !== "string" || !texto.trim()) return null;
  let s = texto.trim().replace(/[^\d.,-]/g, "");
  if (!s) return null; // sobrou vazio depois de tirar tudo que não é dígito/./,/- (ex.: "abc")
  const temVirgula = s.includes(",");
  const temPonto = s.includes(".");
  if (temVirgula && temPonto) {
    // O último separador que aparece é o decimal; o outro é milhar.
    s = s.lastIndexOf(",") > s.lastIndexOf(".")
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  } else if (temVirgula) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {{colunas:string[], linhas:object[]}|null} arquivo ifoodFinancial.mapper.js#parsearArquivoConciliacao (já parseado pelo service)
 */
export function adaptarRegistrosReconciliation(arquivo) {
  if (!arquivo || !Array.isArray(arquivo.colunas) || arquivo.colunas.length === 0) {
    return { disponivel: false, colunaIdDetectada: null, colunaValorDetectada: null, registros: [] };
  }
  const colunaId = detectarColuna(arquivo.colunas, CANDIDATOS_COLUNA_ID);
  const colunaValor = detectarColuna(arquivo.colunas, CANDIDATOS_COLUNA_VALOR);

  const registros = (arquivo.linhas ?? []).map((linha) => ({
    bruto: linha, // TODAS as colunas, conhecidas ou não — nunca descartadas
    idCorrelacao: colunaId ? (linha[colunaId] ?? null) : null,
    valor: colunaValor ? numeroDeTextoMonetario(linha[colunaValor]) : null,
    correlacao: colunaId ? "por_coluna_detectada" : "nao_determinada",
  }));

  return { disponivel: true, colunaIdDetectada: colunaId, colunaValorDetectada: colunaValor, registros };
}

/**
 * @param {{saldo:number|null, titulos:object[]}|null} settlementsData
 * @param {ReturnType<typeof adaptarRegistrosReconciliation>|null} reconciliationAdaptado
 */
export function conciliarSettlementsComReconciliation(settlementsData, reconciliationAdaptado) {
  if (!settlementsData) {
    return { status: STATUS_CONCILIACAO.INCOMPLETO, settlementBalance: null, totalReconciliationIdentificado: null, divergencia: null, motivo: "Settlements não disponível para o período." };
  }
  if (!reconciliationAdaptado || !reconciliationAdaptado.disponivel) {
    return { status: STATUS_CONCILIACAO.INCOMPLETO, settlementBalance: settlementsData.saldo ?? null, totalReconciliationIdentificado: null, divergencia: null, motivo: "Reconciliation não disponível para o período." };
  }
  if (!reconciliationAdaptado.colunaValorDetectada) {
    return {
      status: STATUS_CONCILIACAO.NAO_COMPARAVEL, settlementBalance: settlementsData.saldo ?? null, totalReconciliationIdentificado: null, divergencia: null,
      motivo: "Não foi possível identificar automaticamente uma coluna de valor no arquivo de conciliação — colunas reais ainda não confirmadas contra um arquivo real.",
    };
  }

  const totalCentavos = somaCentavos(reconciliationAdaptado.registros.map((r) => r.valor));
  const comparacao = classificarComparacao(paraCentavos(settlementsData.saldo), totalCentavos);
  return {
    status: comparacao.status,
    settlementBalance: settlementsData.saldo ?? null,
    totalReconciliationIdentificado: centavosParaReais(totalCentavos),
    divergencia: centavosParaReais(comparacao.divergenciaCentavos),
    motivo: null,
  };
}

// ---------------------------------------------------------------------------
// 4. Anticipation — transformação do recebimento, nunca da venda (Bloco 4)
// ---------------------------------------------------------------------------

/** valorOriginal - taxa ≈ valorAntecipado, só quando os 3 campos existem
 * (Bloco 4 é explícito: "somente quando os três campos estiverem presentes"). */
function checarConsistenciaAntecipacao(a) {
  if (a?.valorOriginal == null || a?.taxa?.valor == null || a?.valorAntecipado == null) return null;
  const esperadoCentavos = paraCentavos(a.valorOriginal) - paraCentavos(a.taxa.valor);
  const encontradoCentavos = paraCentavos(a.valorAntecipado);
  return Math.abs(encontradoCentavos - esperadoCentavos) <= TOLERANCIA_CENTAVOS;
}

/** @param {object[]|null} antecipacoesList */
export function resumirAnticipation(antecipacoesList) {
  const lista = antecipacoesList ?? [];
  const avaliacoes = lista.map((a) => ({ item: a, consistente: checarConsistenciaAntecipacao(a) }));
  const avaliadas = avaliacoes.filter((v) => v.consistente !== null);
  const inconsistentes = avaliadas.filter((v) => v.consistente === false).map((v) => v.item);

  return {
    quantidade: lista.length,
    valorOriginal: centavosParaReais(somaCentavos(lista.map((a) => a.valorOriginal))),
    taxas: centavosParaReais(somaCentavos(lista.map((a) => a.taxa?.valor))),
    valorAntecipado: centavosParaReais(somaCentavos(lista.map((a) => a.valorAntecipado))),
    // null = nenhum item tinha os 3 campos pra avaliar (não é inconsistência, é ausência de dado).
    consistente: avaliadas.length === 0 ? null : inconsistentes.length === 0,
    itensAvaliados: avaliadas.length,
    itensInconsistentes: inconsistentes,
  };
}

// ---------------------------------------------------------------------------
// 5. Resultado consolidado
// ---------------------------------------------------------------------------

function divergenciasDoResultado({ salesVsEvents, eventsVsSettlements, settlementsVsReconciliation, anticipationResumo }) {
  const lista = [];

  for (const v of salesVsEvents.porVenda) {
    if (v.status !== STATUS_CONCILIACAO.DIVERGENTE) continue;
    lista.push({
      codigo: "SALES_EVENTS_DIVERGENCIA",
      origem: `Venda ${v.saleShortId ?? v.saleId ?? ""}`,
      esperado: v.saleBalance,
      encontrado: v.somaEventosImpactantes,
      diferenca: v.divergencia,
      explicacao: "A soma dos eventos financeiros com impacto no repasse (hasTransferImpact=true) não bate com o saldo (billingSummary.saleBalance) que a API Sales informou para este pedido.",
    });
  }

  if (eventsVsSettlements.status === STATUS_CONCILIACAO.DIVERGENTE) {
    lista.push({
      codigo: "EVENTS_SETTLEMENTS_DIVERGENCIA",
      origem: "Período consultado",
      esperado: eventsVsSettlements.settlementBalance,
      encontrado: eventsVsSettlements.somaEventosImpactantes,
      diferenca: eventsVsSettlements.divergencia,
      explicacao: "A soma dos eventos financeiros com impacto no repasse do período não bate com o saldo (balance) devolvido pela API Settlements.",
    });
  }

  if (settlementsVsReconciliation.status === STATUS_CONCILIACAO.DIVERGENTE) {
    lista.push({
      codigo: "SETTLEMENTS_RECONCILIATION_DIVERGENCIA",
      origem: "Arquivo de conciliação",
      esperado: settlementsVsReconciliation.settlementBalance,
      encontrado: settlementsVsReconciliation.totalReconciliationIdentificado,
      diferenca: settlementsVsReconciliation.divergencia,
      explicacao: "O total identificado no arquivo de conciliação (coluna de valor detectada por heurística — nomes reais não confirmados) não bate com o saldo do Settlements. Confira manualmente.",
    });
  }

  anticipationResumo.itensInconsistentes.forEach((a, i) => {
    const esperado = a.valorOriginal - (a.taxa?.valor ?? 0);
    lista.push({
      codigo: "ANTICIPATION_TAXA_INCONSISTENTE",
      origem: `Antecipação ${i + 1} (${a.tipo ?? "tipo desconhecido"})`,
      esperado: Math.round(esperado * 100) / 100,
      encontrado: a.valorAntecipado,
      diferenca: Math.round((a.valorAntecipado - esperado) * 100) / 100,
      explicacao: "valorOriginal - taxa.valor não bate com valorAntecipado informado pela API Anticipation.",
    });
  });

  return lista;
}

/**
 * Função raiz — PURA. Cada fonte é `null` (não buscada/falhou) ou o objeto
 * já normalizado pelo service correspondente. Nunca lança por fonte
 * ausente (Bloco 12) — o pior caso é um resultado onde tudo é SEM_DADOS.
 *
 * @param {{
 *   periodo: {inicio: string|null, fim: string|null},
 *   sales: {vendas: object[]}|null,
 *   events: {eventos: object[]}|null,
 *   settlements: {saldo: number|null, titulos: object[]}|null,
 *   reconciliation: {competencia: string|null, arquivo: object|null}|null,
 *   anticipations: {saldo: number|null, antecipacoes: object[]}|null,
 * }} p
 */
export function conciliarFinancial({ periodo, sales, events, settlements, reconciliation, anticipations }) {
  const vendasList = sales?.vendas ?? null;
  const eventosList = events?.eventos ?? null;

  const vendasResumo = sales ? {
    quantidade: (vendasList ?? []).length,
    bruto: centavosParaReais(somaCentavos((vendasList ?? []).map((v) => v.valorBruto?.total))),
    saldoVendas: centavosParaReais(somaCentavos((vendasList ?? []).map((v) => v.resumoFinanceiro?.saldo))),
  } : null;

  const eventosResumo = events ? {
    quantidade: (eventosList ?? []).length,
    creditos: centavosParaReais(somaCentavos((eventosList ?? []).filter((e) => e.tipoValor === "credito").map((e) => e.valor))),
    debitos: centavosParaReais(somaCentavos((eventosList ?? []).filter((e) => e.tipoValor === "debito").map((e) => e.valor))),
    comImpactoTransferencia: (eventosList ?? []).filter((e) => e.temImpactoRepasse === true).length,
    semImpactoTransferencia: (eventosList ?? []).filter((e) => e.temImpactoRepasse === false).length,
    impactoNaoInformado: (eventosList ?? []).filter(impactoDesconhecido).length,
    // Com algum impacto desconhecido o saldo impactante não é calculável (null, não um parcial).
    saldoImpactante: (eventosList ?? []).some(impactoDesconhecido)
      ? null
      : centavosParaReais(somaCentavos((eventosList ?? []).filter((e) => e.temImpactoRepasse === true).map((e) => e.valor))),
  } : null;

  const settlementsResumo = settlements ? {
    quantidade: (settlements.titulos ?? []).length,
    balance: settlements.saldo ?? null,
    closingItemsTotal: centavosParaReais(somaCentavos((settlements.titulos ?? []).map((t) => t.valor))),
  } : null;

  const reconciliationAdaptado = reconciliation ? adaptarRegistrosReconciliation(reconciliation.arquivo) : null;
  const reconciliationResumo = {
    disponivel: !!reconciliationAdaptado?.disponivel,
    quantidadeRegistros: reconciliationAdaptado?.registros.length ?? 0,
    totalIdentificado: reconciliationAdaptado?.disponivel
      ? centavosParaReais(somaCentavos(reconciliationAdaptado.registros.map((r) => r.valor)))
      : null,
    colunaIdDetectada: reconciliationAdaptado?.colunaIdDetectada ?? null,
    colunaValorDetectada: reconciliationAdaptado?.colunaValorDetectada ?? null,
    competencia: reconciliation?.competencia ?? null,
  };

  // resumirAnticipation(null) já devolve a forma "vazia" correta (quantidade
  // 0, consistente null) — não precisa de tratamento extra pra fonte ausente.
  const anticipationResumo = resumirAnticipation(anticipations?.antecipacoes ?? null);

  const salesVsEvents = conciliarSalesComEvents(vendasList, eventosList);
  const eventsVsSettlements = conciliarEventsComSettlements(eventosList, settlements ?? null);
  const settlementsVsReconciliation = conciliarSettlementsComReconciliation(settlements ?? null, reconciliationAdaptado);

  const statusGeral = agregarStatusGeral([salesVsEvents.status, eventsVsSettlements.status, settlementsVsReconciliation.status]);
  const divergencias = divergenciasDoResultado({ salesVsEvents, eventsVsSettlements, settlementsVsReconciliation, anticipationResumo });

  return {
    periodo: periodo ?? { inicio: null, fim: null },
    vendas: vendasResumo,
    eventos: eventosResumo,
    settlements: settlementsResumo,
    reconciliation: reconciliationResumo,
    anticipation: anticipationResumo,
    conciliacao: {
      salesVsEvents: { status: salesVsEvents.status, quantidadeVendas: salesVsEvents.quantidadeVendas, quantidadeConciliadas: salesVsEvents.quantidadeConciliadas, quantidadeDivergentes: salesVsEvents.quantidadeDivergentes, quantidadeIncompletas: salesVsEvents.quantidadeIncompletas },
      eventsVsSettlements,
      settlementsVsReconciliation,
      statusGeral,
      divergencias,
    },
    // Trilha por venda — usada pela UI pra montar a "Trilha Financeira"
    // (venda -> eventos -> settlement -> reconciliation -> antecipação).
    trilhaPorVenda: salesVsEvents.porVenda,
  };
}
