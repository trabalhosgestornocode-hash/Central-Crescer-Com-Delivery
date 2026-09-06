// Camada PURA do Fechamento Mensal Visio (arquitetura v3.1).
//
// Sem I/O. O serviço faz o parse dos PDFs, busca as agregações diárias e as
// metas, e passa TUDO já pronto para cá. Aqui só se combina e classifica.
//
// INVARIANTE-MÃE: nada neste arquivo (nem em quem o chama para montar o
// resultado do fechamento) pode chamar obterMes(). `montarResultadoFechamento
// Oficial` produz o MESMO formato canônico que `obterMes()` de uma competência
// `fechada` vai devolver depois — mas por um caminho independente.
//
// F3: implementa PRÉVIA + resultado canônico + roteamento de estado.
//     NÃO implementa snapshot/versionamento/congelamento (F4).

import {
  percentualDerivado, mediaDiaria, somaValida, validarPercentualCruzado, mesmaUnidadeVisio,
  diasDoMes, statusDia, STATUS_DIA_BONIFICACAO,
} from "./bonificacaoMensal.calc.js";
import { evaluateBonusMetric, totalBonificacao } from "./bonificacaoMensal.metas.js";
import { avaliarElegibilidadeBonificacao, avaliarSuperRestaurante } from "./bonificacaoMensal.elegibilidade.js";

/** Indicadores com meta — espelha o CHECK de bonificacao_metas.indicador. */
export const INDICADORES_META = [
  "faturamento", "bebidas", "adicionais", "diversos", "cmv", "ticket_medio",
  "avaliacao_ifood", "cancelamentos", "pedidos_chamado", "rev", "pesquisas",
];

/**
 * Procedência REAL de cada indicador no `fechamento_mensal_direto`.
 *   'vendas'/'produtos' → os 2 relatórios mensais (seguem a `origem` do snapshot).
 *   'manual'            → CMV, Nota iFood, Cancelamentos, Pedidos com chamado,
 *                         Pesquisas e REV vêm das MESMAS fontes manuais/mensais
 *                         de sempre (média/soma dos lançamentos diários + REV
 *                         da competência), INDEPENDENTE da `origem` do snapshot.
 *                         A `origem` de topo é só o rótulo do CAMINHO principal
 *                         (comercial); estes campos não mudam de regra.
 */
export const FONTE_INDICADOR_FECHAMENTO = {
  faturamento: "vendas", ticket_medio: "vendas",
  bebidas: "produtos", adicionais: "produtos", diversos: "produtos",
  cmv: "manual", avaliacao_ifood: "manual", cancelamentos: "manual",
  pedidos_chamado: "manual", rev: "manual", pesquisas: "manual",
};

/** Rótulo de `fonte` no indicador do snapshot: 'relatorio_mensal' (vendas/produtos) ou 'manual'. */
const fonteRotulo = (metade) => (metade === "manual" ? "manual" : "relatorio_mensal");

// ---------------------------------------------------------------------------
// CLASSIFICAÇÃO DE ACOMPANHAMENTO (correção conceitual F4) — DETERMINÍSTICA,
// sem percentual arbitrário. Reaproveita statusDia() (a regra de domínio do
// calendário da Bonificação) — NÃO cria um segundo calendário.
//
//   Dia ESPERADO          = dia da competência que já ocorreu (dataIso <= hoje).
//   Dia COM ACOMPANHAMENTO = statusDia ∈ { IMPORTADO, MANUAL } — Geral + Loja
//                            completos (operou e tem o acompanhamento).
//   Dia JUSTIFICADO        = statusDia = SEM_OPERACAO — registrado como sem
//                            operação (a regra de domínio que justifica ausência).
//   Dia PENDENTE           = statusDia ∈ { PENDENTE, PARCIAL }.
//   Dia COBERTO            = COM ACOMPANHAMENTO ∪ JUSTIFICADO.
//
//   SEM_ACOMPANHAMENTO    ⇔ 0 dias COM ACOMPANHAMENTO.
//   ACOMPANHAMENTO_DIARIO ⇔ ≥1 dia COM ACOMPANHAMENTO E 0 dias PENDENTES.
//   ACOMPANHAMENTO_PARCIAL⇔ ≥1 dia COM ACOMPANHAMENTO E ≥1 dia PENDENTE.
// ---------------------------------------------------------------------------
/**
 * @param {{ lancamentos: Array<object>, ano:number, mes:number, hojeIso:string }} p
 *   `lancamentos` no formato de paraApiLancamento (tem .data, .semOperacao,
 *   .faturamentoGeral, .faturamentoLoja, .qtd*Loja, .origem, .manualOverride).
 * @returns {{
 *   tipo: 'SEM_ACOMPANHAMENTO'|'ACOMPANHAMENTO_PARCIAL'|'ACOMPANHAMENTO_DIARIO',
 *   diasEsperados:number, diasCobertos:number, diasComAcompanhamento:number,
 *   diasSemOperacao:number, diasPendentes:string[], detalhe:Array<{data:string,status:string}>
 * }}
 */
export function classificarAcompanhamento({ lancamentos, ano, mes, hojeIso }) {
  const S = STATUS_DIA_BONIFICACAO;
  const porData = new Map((lancamentos || []).filter((l) => l && l.data).map((l) => [l.data, l]));
  const detalhe = [];
  let diasEsperados = 0, diasComAcompanhamento = 0, diasSemOperacao = 0;
  const diasPendentes = [];

  for (const dataIso of diasDoMes(Number(ano), Number(mes))) {
    const status = statusDia({ lancamento: porData.get(dataIso) || null, dataIso, hojeIso });
    if (status === S.FUTURO) continue; // ainda não é um dia "esperado"
    diasEsperados++;
    detalhe.push({ data: dataIso, status });
    if (status === S.IMPORTADO || status === S.MANUAL) diasComAcompanhamento++;
    else if (status === S.SEM_OPERACAO) diasSemOperacao++;
    else diasPendentes.push(dataIso); // PENDENTE | PARCIAL
  }

  const diasCobertos = diasComAcompanhamento + diasSemOperacao;
  let tipo;
  if (diasComAcompanhamento === 0) tipo = "SEM_ACOMPANHAMENTO";
  else if (diasPendentes.length === 0) tipo = "ACOMPANHAMENTO_DIARIO";
  else tipo = "ACOMPANHAMENTO_PARCIAL";

  return { tipo, diasEsperados, diasCobertos, diasComAcompanhamento, diasSemOperacao, diasPendentes, detalhe };
}

const FORMULA_INDICADOR = {
  faturamento: "Relatório de Vendas mensal (faturamento)",
  ticket_medio: "Relatório de Vendas mensal (ticket médio)",
  bebidas: "qtd_bebidas / qtd_sanduiches * 100 (Relatório de Produtos mensal — Loja/Balcão)",
  adicionais: "qtd_adicionais / qtd_sanduiches * 100 (Relatório de Produtos mensal — Loja/Balcão)",
  diversos: "qtd_diversos / qtd_sanduiches * 100 (Relatório de Produtos mensal — Loja/Balcão)",
  cmv: "média diária do mês (lançamento manual)",
  avaliacao_ifood: "média diária do mês (lançamento manual)",
  cancelamentos: "média diária do mês (lançamento manual)",
  pedidos_chamado: "média diária do mês (lançamento manual)",
  rev: "valor único da competência (bonificacao_rev_mensal)",
  pesquisas: "soma do mês (lançamento manual)",
};

// ---------------------------------------------------------------------------
// NÚCLEO COMPARTILHADO — mesmo motor para o cálculo ao vivo (obterMes aberta/
// reaberta) e para o resultado oficial do fechamento. ZERO fórmula duplicada.
// ---------------------------------------------------------------------------
/**
 * @param {{
 *   valores: Record<string, number|null>,   // um por indicador de INDICADORES_META
 *   metasVigentes: Record<string, object>,  // metasVigentesPorIndicador(primeiroDia)
 *   mesFechado: boolean,
 * }} p
 * @returns {{
 *   indicadores: Record<string, object>,
 *   resumo: {bonificacaoAtual:number, bonificacaoBruta:number, bonificacaoMaxima:number, metasAtingidas:number, metasComRegra:number, progressoPct:number|null},
 *   elegibilidade: object, superRestaurante: object, indicadoresAtencao: string[],
 * }}
 */
export function montarResultadoCompetencia({ valores, metasVigentes, mesFechado }) {
  const indicadores = {};
  for (const indicador of INDICADORES_META) {
    const valor = valores?.[indicador] ?? null;
    indicadores[indicador] = { ...evaluateBonusMetric(valor, metasVigentes?.[indicador]), valorAtual: valor, indicador };
  }
  const bonificacao = totalBonificacao(indicadores);
  const bonificacaoBruta = bonificacao.atual;

  const minimoDe = (indicador) => {
    const f = metasVigentes?.[indicador]?.faixas?.[0];
    return f ? (f.valorMin ?? f.valorMax ?? null) : null;
  };
  const elegibilidade = avaliarElegibilidadeBonificacao({
    notaIfood: { valor: valores?.avaliacao_ifood ?? null, minimo: minimoDe("avaliacao_ifood") },
    rev: { valor: valores?.rev ?? null, minimo: minimoDe("rev") },
    pesquisas: { valor: valores?.pesquisas ?? null, minimo: minimoDe("pesquisas") },
    mesFechado,
  });
  if (elegibilidade.status === "nao_elegivel") bonificacao.atual = 0;

  const superRestaurante = avaliarSuperRestaurante({
    avaliacaoIfood: { valor: valores?.avaliacao_ifood ?? null, minimo: minimoDe("avaliacao_ifood") },
    cancelamentos: { valor: valores?.cancelamentos ?? null, minimo: minimoDe("cancelamentos") },
    pedidosChamado: { valor: valores?.pedidos_chamado ?? null, minimo: minimoDe("pedidos_chamado") },
  });

  const indicadoresAtencao = Object.values(indicadores)
    .filter((i) => i.status === "meta_nao_atingida" && i.temBonusDefinido)
    .map((i) => i.indicador);

  return {
    indicadores,
    resumo: {
      bonificacaoAtual: bonificacao.atual,
      bonificacaoBruta,
      bonificacaoMaxima: bonificacao.maximo,
      metasAtingidas: bonificacao.metasAtingidas,
      metasComRegra: bonificacao.metasComRegra,
      progressoPct: bonificacao.maximo > 0 ? (bonificacao.atual / bonificacao.maximo) * 100 : null,
    },
    elegibilidade, superRestaurante, indicadoresAtencao,
  };
}

// ---------------------------------------------------------------------------
// RESULTADO OFICIAL DO FECHAMENTO — função pura aprovada. NÃO chama obterMes().
// ---------------------------------------------------------------------------
/**
 * @param {{
 *   vendas:   {faturamento:number, ticketMedio:number, cuponsValidos:number|null, cuponsVendas:number|null,
 *              estabelecimento:string|null, metodosPagamento:Array, hash:string, origem?:string},
 *   produtos: {qtdSanduiches:number, qtdBebidas:number, qtdAdicionais:number, qtdDiversos:number,
 *              ppd:number|null, torque:number|null, perdas:number|null, fatSanduiches:number|null,
 *              pctFatSanduiches:number|null, totalItens:number|null, produtosFuncionais:number|null,
 *              faturamentoLoja:number|null, estabelecimento:string|null,
 *              percentualBebidasPdf:number|null, percentualAdicionaisPdf:number|null, percentualDiversosPdf:number|null,
 *              hash:string, origem?:string},
 *   manuais:  {cmv:number|null, avaliacaoIfood:number|null, cancelamentos:number|null, pedidosChamado:number|null, pesquisas:number|null, rev:number|null},
 *   metasVigentes: Record<string, object>,
 *   contexto: {unidade:{id,nome,organizacaoId}, ano:number, mes:number,
 *              canalConfirmado:boolean, periodoConfirmado:boolean,
 *              codigoVersao?:string|null, confirmadoPor?:object|null,
 *              avisosImportacao?:string[], crossChecks?:object},
 * }} p
 * @returns {object} objeto canônico da competência (formato do snapshot v3.1 §5.4, sem lifecycle)
 */
export function montarResultadoFechamentoOficial({ vendas, produtos, manuais, metasVigentes, contexto }) {
  const base = produtos.qtdSanduiches;
  const valores = {
    faturamento: vendas.faturamento,
    ticket_medio: vendas.ticketMedio,
    bebidas: percentualDerivado(produtos.qtdBebidas, base),
    adicionais: percentualDerivado(produtos.qtdAdicionais, base),
    diversos: percentualDerivado(produtos.qtdDiversos, base),
    cmv: manuais?.cmv ?? null,
    avaliacao_ifood: manuais?.avaliacaoIfood ?? null,
    cancelamentos: manuais?.cancelamentos ?? null,
    pedidos_chamado: manuais?.pedidosChamado ?? null,
    rev: manuais?.rev ?? null,
    pesquisas: manuais?.pesquisas ?? null,
  };

  const core = montarResultadoCompetencia({ valores, metasVigentes, mesFechado: true });

  const indicadores = {};
  for (const [k, v] of Object.entries(core.indicadores)) {
    indicadores[k] = { ...v, fonte: fonteRotulo(FONTE_INDICADOR_FECHAMENTO[k]), formula: FORMULA_INDICADOR[k] || null };
  }

  // Percentual CANÔNICO do mix = qtd / qtd_sanduiches * 100 (Relatório de
  // Produtos mensal Loja/Balcão). É o ÚNICO percentual que a Bonificação usa.
  // O percentual que o próprio PDF imprime não é uma segunda fonte do
  // indicador — entra só em metadados.conferenciaImportacao, como material
  // técnico de conferência da importação.
  const percentuais = { bebidas: valores.bebidas, adicionais: valores.adicionais, diversos: valores.diversos };
  const percentuaisImpressosNoPdf = {
    bebidas: produtos.percentualBebidasPdf ?? null,
    adicionais: produtos.percentualAdicionaisPdf ?? null,
    diversos: produtos.percentualDiversosPdf ?? null,
  };
  const divergenciaPercentualPP = {};
  for (const k of ["bebidas", "adicionais", "diversos"]) {
    divergenciaPercentualPP[k] = (percentuaisImpressosNoPdf[k] != null && percentuais[k] != null)
      ? Number((percentuaisImpressosNoPdf[k] - percentuais[k]).toFixed(2))
      : null;
  }

  return {
    escopoBonificacao: "unidade",
    unidade: contexto.unidade,
    competencia: { ano: contexto.ano, mes: contexto.mes },
    // Snapshot de competência SEM acompanhamento diário, fechada pelos 2
    // relatórios mensais da Visio. Origem única e obrigatória.
    origem: "fechamento_mensal_direto",
    geradoEm: new Date().toISOString(),
    fonte: {
      vendas: { hash: vendas.hash ?? null, estabelecimento: vendas.estabelecimento ?? null, origem: vendas.origem ?? "visio" },
      produtos: {
        hash: produtos.hash ?? null, estabelecimento: produtos.estabelecimento ?? null, origem: produtos.origem ?? "visio",
        canalConfirmadoPeloUsuario: !!contexto.canalConfirmado,
      },
      periodoConfirmadoPeloUsuario: !!contexto.periodoConfirmado,
    },
    valoresOficiais: {
      faturamento: vendas.faturamento, ticketMedio: vendas.ticketMedio,
      quantidadeVendas: vendas.cuponsVendas ?? null, cuponsValidos: vendas.cuponsValidos ?? null,
      sanduichesSaladas: produtos.qtdSanduiches, bebidas: produtos.qtdBebidas,
      adicionais: produtos.qtdAdicionais, diversos: produtos.qtdDiversos,
      ppd: produtos.ppd ?? null, torque: produtos.torque ?? null, perdas: produtos.perdas ?? null,
      fatSanduiches: produtos.fatSanduiches ?? null, pctFatSanduiches: produtos.pctFatSanduiches ?? null,
      totalItens: produtos.totalItens ?? null, produtosFuncionais: produtos.produtosFuncionais ?? null,
      faturamentoLoja: produtos.faturamentoLoja ?? null,
      metodosPagamento: vendas.metodosPagamento ?? [],
      // único percentual do mix — a regra da Bonificação (qtd / qtd_sanduiches * 100)
      percentuais,
    },
    indicadores,
    elegibilidade: core.elegibilidade,
    superRestaurante: core.superRestaurante,
    indicadoresAtencao: core.indicadoresAtencao,
    bonificacao: {
      bruta: core.resumo.bonificacaoBruta,
      definitiva: core.resumo.bonificacaoAtual,   // já com o portão de elegibilidade aplicado
      maxima: core.resumo.bonificacaoMaxima,
      metasAtingidas: core.resumo.metasAtingidas,
      metasComRegra: core.resumo.metasComRegra,
    },
    metadados: {
      codigoVersao: contexto.codigoVersao ?? null,
      confirmadoPor: contexto.confirmadoPor ?? null,
      avisosImportacao: contexto.avisosImportacao ?? [],
      // Conferência TÉCNICA da importação — nunca é fonte de indicador. Guarda
      // o que o PDF imprimiu e o quanto isso divergiu da regra, além dos
      // cross-checks com os lançamentos já registrados.
      conferenciaImportacao: {
        percentuaisImpressosNoPdf,
        divergenciaPercentualPP,
        crossChecks: contexto.crossChecks ?? {},
      },
      reaberturas: [],
    },
  };
}

// ---------------------------------------------------------------------------
// VALIDAÇÃO DA PRÉVIA — bloqueios (impedem confirmar) × alertas (nunca mudam
// cálculo, nunca bloqueiam sozinhos). NÃO infere mês/período do PDF.
// ---------------------------------------------------------------------------
/**
 * @param {{
 *   vendas: object|null, produtos: object|null, unidadeNome: string,
 *   somaDiaria: {sanduiches:number, bebidas:number, adicionais:number, diversos:number, faturamentoLoja:number}|null,
 *   competenciaExistente: {status:string}|null,
 *   acompanhamento: {tipo:string, diasEsperados:number, diasComAcompanhamento:number, diasPendentes:string[]}|null,
 *   produtosCanalConfirmado: boolean, periodoConfirmadoUsuario: boolean,
 * }} p
 * @returns {{bloqueios: string[], alertas: Array<{tipo:'critico'|'alerta', msg:string}>, crossChecks: object}}
 */
export function validarFechamentoMensal({
  vendas, produtos, unidadeNome, somaDiaria, competenciaExistente, acompanhamento,
  produtosCanalConfirmado, periodoConfirmadoUsuario,
}) {
  const bloqueios = [];
  const alertas = [];

  // 1. falta de PDF
  if (!vendas) bloqueios.push("Envie o Relatório de Vendas mensal.");
  if (!produtos) bloqueios.push("Envie o Relatório de Produtos mensal.");
  if (bloqueios.length) return { bloqueios, alertas, crossChecks: {} };

  // 2. tipo trocado (o parser já recusa antes — defesa em profundidade)
  if (vendas.tipo && vendas.tipo !== "vendas") bloqueios.push("O arquivo enviado como Relatório de Vendas não é um Relatório de Vendas.");
  if (produtos.tipo && produtos.tipo !== "produtos") bloqueios.push("O arquivo enviado como Relatório de Produtos não é um Relatório de Produtos.");

  // 3. estabelecimento incompatível com a unidade
  if (mesmaUnidadeVisio(unidadeNome, vendas.estabelecimento) === false) {
    bloqueios.push(`O Relatório de Vendas pertence a outra unidade (relatório de "${vendas.estabelecimento}").`);
  }
  if (mesmaUnidadeVisio(unidadeNome, produtos.estabelecimento) === false) {
    bloqueios.push(`O Relatório de Produtos pertence a outra unidade (relatório de "${produtos.estabelecimento}").`);
  }
  // 4. estabelecimentos divergentes entre os dois PDFs
  if (vendas.estabelecimento && produtos.estabelecimento
      && mesmaUnidadeVisio(vendas.estabelecimento, produtos.estabelecimento) === false) {
    bloqueios.push(`Os dois relatórios são de estabelecimentos diferentes: "${vendas.estabelecimento}" x "${produtos.estabelecimento}".`);
  }

  // 5. quantidade inválida (o parser garante inteiro ≥ 0 — defesa)
  const qtds = [
    ["Sanduíches/Saladas", produtos.qtdSanduiches], ["Bebidas", produtos.qtdBebidas],
    ["Adicionais", produtos.qtdAdicionais], ["Diversos", produtos.qtdDiversos],
  ];
  for (const [k, v] of qtds) {
    if (!Number.isInteger(v) || v < 0) bloqueios.push(`Quantidade inválida de ${k}: "${v}".`);
  }
  if (!(produtos.qtdSanduiches > 0)) bloqueios.push("Sanduíches/Saladas (base do mix) precisa ser maior que zero.");

  // 6 e 7. checkboxes obrigatórios
  if (!produtosCanalConfirmado) bloqueios.push("Confirme que o Relatório de Produtos foi exportado com filtro Loja/Balcão.");
  if (!periodoConfirmadoUsuario) bloqueios.push("Confirme que os dois arquivos correspondem à competência selecionada.");

  // 8. competência já fechada
  if (competenciaExistente?.status === "fechada") {
    bloqueios.push("Esta competência já está fechada. Reabra o fechamento antes de importar de novo.");
  }

  // 9 e 10. NÃO sobrescrever acompanhamento diário. O fechamento mensal DIRETO
  //   (pelos 2 relatórios do mês) só existe para competências SEM acompanhamento
  //   — meses antigos (junho, julho, agosto…). Quem tem acompanhamento diário
  //   consolida o que já existe (fluxo consolidarAcompanhamentoDiario).
  if (acompanhamento?.tipo === "ACOMPANHAMENTO_DIARIO") {
    bloqueios.push(
      `Esta competência foi acompanhada dia a dia (${acompanhamento.diasComAcompanhamento} de ${acompanhamento.diasEsperados} dias). `
      + "O fechamento se faz consolidando o acompanhamento diário — não pelos relatórios mensais.",
    );
  } else if (acompanhamento?.tipo === "ACOMPANHAMENTO_PARCIAL") {
    const p = acompanhamento.diasPendentes || [];
    bloqueios.push(
      `Acompanhamento parcial: ${acompanhamento.diasComAcompanhamento} de ${acompanhamento.diasEsperados} dias têm relatório `
      + `(${p.length} pendente${p.length === 1 ? "" : "s"}: ${p.slice(0, 8).join(", ")}${p.length > 8 ? "…" : ""}). `
      + "Complete o acompanhamento diário antes de consolidar a competência. "
      + "O fechamento mensal direto não é permitido para competências parcialmente acompanhadas.",
    );
  }

  // ---- ALERTAS: só CONFERÊNCIA DE IMPORTAÇÃO. Nunca bloqueiam, nunca mudam o
  // cálculo, nunca viram "um segundo valor" do indicador. Servem para pegar
  // arquivo trocado, filtro errado ou período errado ANTES de confirmar.
  const crossChecks = {};
  const vf = Number(vendas.faturamento) || 0;
  const pf = produtos.faturamentoLoja != null ? Number(produtos.faturamentoLoja) : null;

  if (vf > 0 && pf != null) {
    const razao = pf / vf;
    crossChecks.produtosFatVsVendasFat = Number(razao.toFixed(4));
    if (razao >= 0.90) {
      alertas.push({ tipo: "critico", msg: `O faturamento do Relatório de Produtos está muito próximo do total de vendas (${(razao * 100).toFixed(0)}%). Verifique se ele foi exportado com o filtro Loja/Balcão antes de confirmar.` });
    } else if (razao >= 0.60) {
      alertas.push({ tipo: "alerta", msg: `O faturamento do Relatório de Produtos representa ${(razao * 100).toFixed(0)}% do total de vendas. Confirme que o arquivo está filtrado para Loja/Balcão.` });
    }
  }
  if (somaDiaria?.faturamentoLoja > 0 && pf != null) {
    const desvio = Math.abs(pf - somaDiaria.faturamentoLoja) / somaDiaria.faturamentoLoja;
    crossChecks.produtosFatVsRegistrado = Number(desvio.toFixed(4));
    if (desvio > 0.10) {
      alertas.push({ tipo: "alerta", msg: `O faturamento Loja deste arquivo não acompanha os lançamentos já registrados para a competência. Verifique se o período e o canal do arquivo estão corretos.` });
    }
  }

  // Consistência INTERNA do próprio Relatório de Produtos: o % impresso tem que
  // bater com as quantidades do mesmo relatório.
  const rec = {
    bebidas: percentualDerivado(produtos.qtdBebidas, produtos.qtdSanduiches),
    adicionais: percentualDerivado(produtos.qtdAdicionais, produtos.qtdSanduiches),
    diversos: percentualDerivado(produtos.qtdDiversos, produtos.qtdSanduiches),
  };
  for (const [k, pdfPct] of [
    ["Bebidas", produtos.percentualBebidasPdf], ["Adicionais", produtos.percentualAdicionaisPdf], ["Diversos", produtos.percentualDiversosPdf],
  ]) {
    const alvo = rec[k.toLowerCase()];
    const r = validarPercentualCruzado(pdfPct, alvo);
    if (r.divergente) {
      alertas.push({ tipo: "alerta", msg: `No Relatório de Produtos, o percentual impresso de ${k} (${pdfPct}%) não corresponde às quantidades do próprio relatório (${alvo.toFixed(1)}%). Confira se o arquivo foi exportado sem filtros que alterem a contagem.` });
    }
  }

  // Quantidade de vendas principais do arquivo x lançamentos já registrados.
  if (somaDiaria?.sanduiches > 0) {
    const desvio = Math.abs(produtos.qtdSanduiches - somaDiaria.sanduiches) / somaDiaria.sanduiches;
    crossChecks.principaisVsRegistrado = Number(desvio.toFixed(4));
    if (desvio > 0.10) {
      alertas.push({ tipo: "alerta", msg: `A quantidade de vendas principais deste arquivo não acompanha os lançamentos já registrados para a competência. Verifique o período e o canal (Loja/Balcão) do arquivo.` });
    }
  }

  return { bloqueios, alertas, crossChecks };
}

// ---------------------------------------------------------------------------
// ROTEAMENTO DE ESTADO — decide, para obterMes(), qual caminho seguir.
// PURA: só olha o status. Ver arquitetura v3.1 §4.
// ---------------------------------------------------------------------------
/**
 * @param {{status?: string}|null} competencia
 * @returns {'snapshot'|'ao_vivo'} 'snapshot' = fechada/legado; 'ao_vivo' = aberta/reaberta/inexistente
 */
export function roteamentoObterMes(competencia) {
  const s = competencia?.status ?? "aberta";
  if (s === "fechada" || s === "legado_sem_fechamento") return "snapshot";
  return "ao_vivo"; // 'aberta' | 'reaberta' | qualquer outro → cálculo ao vivo (ignora bonificacao_fechamento_mensal)
}

/** Rótulo de `fechamentoStatus` no retorno do obterMes ao vivo. */
export function fechamentoStatusAoVivo(competencia, mesFechado) {
  if (competencia?.status === "reaberta") return "reaberto";
  return mesFechado ? "aguardando_fechamento" : "aberto";
}
