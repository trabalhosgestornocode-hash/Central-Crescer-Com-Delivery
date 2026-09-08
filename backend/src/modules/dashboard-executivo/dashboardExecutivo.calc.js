// Camada de cálculo do Dashboard Executivo — FONTE ÚNICA das fórmulas de
// negócio (ticket médio, percentuais, deduções, projeção, status do dia,
// diagnóstico). Puro, sem I/O, testável isoladamente — mesmo espírito de
// insumos.calc.js: o backend valida e persiste por cima disto; o frontend só
// mostra prévias, sempre recomputadas no servidor.

/** Data de hoje no fuso do negócio (America/Sao_Paulo), em ISO AAAA-MM-DD. */
export function hojeIsoBrasil(agora = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(agora);
}

/**
 * Lista de datas ISO (AAAA-MM-DD) de um mês inteiro.
 * @param {number} ano @param {number} mes 1-indexado (1 = janeiro)
 * @returns {string[]}
 */
export function diasDoMes(ano, mes) {
  const totalDias = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, "0");
  return Array.from({ length: totalDias }, (_, i) => `${ano}-${pad(mes)}-${pad(i + 1)}`);
}

/** Mês anterior a {ano, mes} (1-indexado), com o rollover de janeiro -> dezembro do ano anterior. */
export function mesAnterior(ano, mes) {
  return mes === 1 ? { ano: ano - 1, mes: 12 } : { ano, mes: mes - 1 };
}

/**
 * Dia anterior a uma data ISO (AAAA-MM-DD) — comparação de CALENDÁRIO, não
 * subtração de milissegundos: `Date.UTC` normaliza sozinho quando o dia
 * vira 0 (cai pro último dia do mês anterior), incluindo virada de ano
 * (janeiro -> dezembro do ano anterior). Usado pela regra "Financeiro só
 * aparece quando a data do lançamento é ontem" (dashboardExecutivo.service.js).
 * @param {string} dataIso
 * @returns {string}
 */
export function diaAnterior(dataIso) {
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia - 1));
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Status possíveis de um dia no calendário do mês. */
export const STATUS_DIA = {
  PREENCHIDO: "PREENCHIDO",
  PENDENTE: "PENDENTE",
  BLOQUEADO: "BLOQUEADO",
  RASCUNHO: "RASCUNHO",
  // Dia "normal" com Situação/Desempenho preenchidos mas Financeiro ainda
  // indisponível (a data só vira "ontem" amanhã) — ver
  // dashboardExecutivo.service.js#normalizarDadosLancamento. É o estado
  // ESPERADO de quase todo dia até o dia seguinte, não um esquecimento —
  // por isso é RESOLVIDO (não bloqueia a sequência), diferente de um
  // RASCUNHO "de verdade" deixado pra trás.
  FINANCEIRO_PENDENTE: "FINANCEIRO_PENDENTE",
  SEM_OPERACAO: "SEM_OPERACAO",
  ZERO_VENDAS: "ZERO_VENDAS",
  FUTURO: "FUTURO",
};

/** Status que "resolvem" o dia (contam para a sequência e para o % de conclusão). */
const RESOLVIDOS = new Set([STATUS_DIA.PREENCHIDO, STATUS_DIA.SEM_OPERACAO, STATUS_DIA.ZERO_VENDAS, STATUS_DIA.FINANCEIRO_PENDENTE]);

/**
 * Situações em que a unidade OPEROU e teve vendas — `normal` e `parcial`
 * ("Funcionou, parcialmente": horário reduzido, cardápio limitado, etc.).
 * Nesses dias o Desempenho e o Financeiro são dados REAIS (extrato acumulado
 * do iFood) e entram nos totais/snapshots normalmente. As demais situações
 * (`sem_operacao`/`zero_vendas`) gravam os 5 campos financeiros como 0
 * sintético e NUNCA entram na busca de snapshot.
 */
const SITUACOES_OPERACIONAIS = new Set(["normal", "parcial"]);
export const situacaoOperou = (situacao) => SITUACOES_OPERACIONAIS.has(situacao);

// ---------------------------------------------------------------------------
// FÓRMULAS FINANCEIRAS
// ---------------------------------------------------------------------------

/**
 * Ticket médio = valor bruto ÷ quantidade de vendas. Nunca divide por zero e
 * nunca inventa um lado da conta: se qualquer um dos dois não foi informado
 * (null/undefined — "não sei"), o ticket médio é indisponível, não 0.
 * @param {number|null} valorBruto @param {number|null} qtdVendas @returns {number|null}
 */
export function ticketMedio(valorBruto, qtdVendas) {
  if (valorBruto == null || qtdVendas == null) return null;
  const q = Number(qtdVendas);
  const v = Number(valorBruto);
  if (!Number.isFinite(q) || !Number.isFinite(v) || q <= 0) return null;
  return v / q;
}

/**
 * Percentual de `valor` sobre `base` (0-100). Null quando a base é inválida
 * OU quando `valor` não foi informado (não confundir "0% de verdade" com
 * "não sei quanto foi").
 * @param {number|null} valor @param {number} base @returns {number|null}
 */
export function percentual(valor, base) {
  if (valor == null) return null;
  const b = Number(base);
  if (!Number.isFinite(b) || b <= 0) return null;
  return (Number(valor) / b) * 100;
}

/**
 * Delta ISOLADO entre dois snapshots ACUMULADOS de um mesmo campo Financeiro
 * (ex.: taxas_entregadores). Só é matematicamente exato quando os dois
 * pontos são de dias REALMENTE consecutivos no calendário e AMBOS têm
 * Financeiro preenchido — por isso não recebe datas: é responsabilidade de
 * quem chama garantir que `anterior` é o dia imediatamente anterior a
 * `atual` (ver dashboardDia.tool.js no módulo do Agente, único uso hoje).
 * Null quando qualquer um dos dois lados não tem o campo preenchido —
 * comparar um snapshot com um "buraco" atribuiria a diferença de vários
 * dias a um só, o que seria inventar um número (mesma regra de `percentual`
 * acima: "não sei" nunca vira 0 nem um valor aproximado).
 * @param {number|null} atual @param {number|null} anterior @returns {number|null}
 */
export function deltaFinanceiro(atual, anterior) {
  if (atual == null || anterior == null) return null;
  return Number(atual) - Number(anterior);
}

/**
 * Soma as deduções que EFETIVAMENTE reduzem a receita: taxas e comissões,
 * serviços e promoções, taxas de entregadores e AJUSTES CONTRA A LOJA
 * (débitos/descontos). Ajuste A FAVOR da loja (crédito/reembolso) NUNCA entra
 * aqui — ver `receitaLiquida`. Se NENHUMA parte foi informada, o total é
 * indisponível (null) — não um 0 que faria um card de meta parecer "dentro
 * da meta" por falta de dado. Se ALGUMAS foram informadas, soma só as
 * conhecidas (melhor esforço) — é o caso normal de um lançamento diário
 * real, onde taxas/serviços/entregadores sempre chegam juntas.
 * @param {{taxasComissoes: number|null, servicosPromocoes: number|null, taxasEntregadores: number|null, ajustesContraLoja: number|null}} p
 * @returns {number|null}
 */
export function totalDeducoes({ taxasComissoes, servicosPromocoes, taxasEntregadores, ajustesContraLoja }) {
  const partes = [taxasComissoes, servicosPromocoes, taxasEntregadores, ajustesContraLoja];
  if (partes.every((p) => p == null)) return null;
  return partes.reduce((s, p) => s + (p == null ? 0 : Number(p)), 0);
}

/**
 * Receita líquida = faturamento − total de deduções + ajustes A FAVOR da loja
 * (créditos/reembolsos, que aumentam o valor efetivamente recebido).
 * Indisponível se o total de deduções não pôde ser calculado — apresentar
 * `valorVendas` sozinho aqui insinuaria "deduções zero", o que não sabemos.
 * `ajustesFavor` ausente conta como 0 (um ajuste é a exceção, não a regra).
 * @param {number} valorVendas @param {number|null} totalDed @param {number|null} [ajustesFavor] @returns {number|null}
 */
export function receitaLiquida(valorVendas, totalDed, ajustesFavor = null) {
  if (totalDed == null) return null;
  return (Number(valorVendas) || 0) - Number(totalDed) + (Number(ajustesFavor) || 0);
}

/** @param {number|null} percentualTotalDeducoes @returns {number|null} */
export function saldoPercentual(percentualTotalDeducoes) {
  if (percentualTotalDeducoes == null) return null;
  return 100 - percentualTotalDeducoes;
}

/**
 * Média diária a partir de uma lista de valores diários VÁLIDOS (dias
 * pendentes/futuros nunca entram aqui — filtrar antes de chamar).
 * @param {Array<number|null|undefined>} valores @returns {number|null}
 */
export function mediaDiaria(valores) {
  const validos = (valores ?? []).filter((v) => v != null && Number.isFinite(Number(v)));
  if (!validos.length) return null;
  return validos.reduce((s, v) => s + Number(v), 0) / validos.length;
}

// ---------------------------------------------------------------------------
// STATUS FRENTE À META — fonte única (era duplicado: um cálculo aqui, outro
// no frontend). Cards, diagnóstico e a nova visão de "quanto ainda resta"
// usam todos esta mesma função.
// ---------------------------------------------------------------------------

/**
 * @param {number|null} atual @param {{metaIdeal: number, limite: number}|null|undefined} meta
 * @returns {{chave: 'sem_dados'|'dentro_da_meta'|'atencao'|'fora_da_meta', label: string}}
 */
export function statusIndicador(atual, meta) {
  if (atual == null || meta == null || meta.metaIdeal == null || meta.limite == null) {
    return { chave: "sem_dados", label: "Dados insuficientes" };
  }
  if (atual <= meta.metaIdeal) return { chave: "dentro_da_meta", label: "Dentro da meta" };
  if (atual <= meta.limite) return { chave: "atencao", label: "Atenção" };
  return { chave: "fora_da_meta", label: "Fora da meta" };
}

/**
 * Quanto do LIMITE (não da meta ideal) ainda está disponível — em pontos
 * percentuais e, quando dá pra calcular, em reais.
 * limiteEmReais = faturamentoBase × limite%; saldo = limiteEmReais − valorUtilizado.
 * @param {{valorUtilizado: number|null, percentualUtilizado: number|null, limitePct: number|null, faturamentoBase: number|null}} p
 * @returns {{disponivelPp: number|null, disponivelReais: number|null, limiteReais: number|null, status: 'sem_dados'|'disponivel'|'limite_atingido'|'acima_do_limite'}}
 */
export function saldoMeta({ valorUtilizado, percentualUtilizado, limitePct, faturamentoBase }) {
  if (percentualUtilizado == null || limitePct == null) {
    return { disponivelPp: null, disponivelReais: null, limiteReais: null, status: "sem_dados" };
  }
  const disponivelPp = limitePct - percentualUtilizado;
  let limiteReais = null;
  let disponivelReais = null;
  if (faturamentoBase != null && faturamentoBase > 0 && valorUtilizado != null) {
    limiteReais = (faturamentoBase * limitePct) / 100;
    disponivelReais = limiteReais - valorUtilizado;
  }
  const status = disponivelPp > 0 ? "disponivel" : disponivelPp === 0 ? "limite_atingido" : "acima_do_limite";
  return { disponivelPp, disponivelReais, limiteReais, status };
}

// ---------------------------------------------------------------------------
// LANÇAMENTO DE FATURAMENTO MENSAL — distribuição exata em centavos
// ---------------------------------------------------------------------------

/**
 * Distribui um valor mensal (reais) por N dias sem perder nem sobrar um
 * centavo: converte para centavos inteiros, divide, e o resto (sempre < N
 * centavos) vai para os primeiros dias. A soma dos valores retornados é
 * SEMPRE exatamente igual a `valorTotalReais` — nunca aproxima.
 * @param {number} valorTotalReais @param {number} quantidadeDias
 * @returns {number[]} um valor em reais por dia (tamanho = quantidadeDias)
 */
export function distribuirValorMensal(valorTotalReais, quantidadeDias) {
  const dias = Math.trunc(Number(quantidadeDias));
  if (!Number.isFinite(dias) || dias <= 0) return [];
  const totalCentavos = Math.round(Number(valorTotalReais) * 100);
  const baseCentavos = Math.floor(totalCentavos / dias);
  const resto = totalCentavos - baseCentavos * dias;
  return Array.from({ length: dias }, (_, i) => (baseCentavos + (i < resto ? 1 : 0)) / 100);
}

/**
 * Mesma ideia de `distribuirValorMensal`, mas para CONTAGENS inteiras
 * (quantidade de pedidos, novos clientes do mês) — sem centavos, o resto vai
 * pros primeiros dias. A soma é sempre exatamente igual ao total informado.
 * @param {number} quantidadeTotal @param {number} quantidadeDias
 * @returns {number[]}
 */
export function distribuirQuantidadeMensal(quantidadeTotal, quantidadeDias) {
  const dias = Math.trunc(Number(quantidadeDias));
  if (!Number.isFinite(dias) || dias <= 0) return [];
  const total = Math.trunc(Number(quantidadeTotal));
  const base = Math.floor(total / dias);
  const resto = total - base * dias;
  return Array.from({ length: dias }, (_, i) => base + (i < resto ? 1 : 0));
}

// Campos "extra" (opcionais) de um lançamento mensal — os que usam contagem
// inteira (pedidos, novos clientes) em vez de valor em reais. Usado tanto
// aqui quanto no service para decidir qual função de distribuição aplicar.
export const CAMPOS_EXTRAS_MENSAL_INTEIROS = new Set(["qtdVendasTotal", "novosClientesTotal"]);

/**
 * Funde a edição de um lançamento mensal com o que já estava salvo, e
 * recalcula a distribuição diária — regra de atualização do item 2/3 do
 * pedido: só substitui o que veio no `patch`; o que não veio preserva o
 * valor salvo (nunca "some" nem vira zero). Determinístico: reaplicar o
 * mesmo total sobre o mesmo número de dias sempre reproduz as mesmas
 * fatias, então mesmo um campo "sem mudança real" pode passar por aqui sem
 * problema algum.
 *
 * @param {{valorTotalMensal: number, extras: Record<string, number|null>}} atual — valores hoje salvos no lote
 * @param {{valorTotalMensal?: number, extras?: Record<string, number|null>}} patch — só as chaves que o usuário de fato editou (chave ausente = não editado)
 * @param {number} quantidadeDias — nº de dias vinculados a este lote (fixo: a edição nunca muda QUAIS dias pertencem ao lote, só os valores deles)
 * @returns {{valorTotalMensal: number, extras: Record<string, number|null>, fatiasPorCampo: {valorVendasIfood: number[], [extra: string]: (number[]|null)}}}
 */
export function recalcularDistribuicaoMensal({ valorAtual, extrasAtuais, patch, quantidadeDias }) {
  const valorTotalMensal = Object.prototype.hasOwnProperty.call(patch, "valorTotalMensal") && patch.valorTotalMensal != null
    ? Number(patch.valorTotalMensal) : Number(valorAtual);

  const patchExtras = patch.extras ?? {};
  const extras = {};
  for (const campo of Object.keys(extrasAtuais)) {
    extras[campo] = Object.prototype.hasOwnProperty.call(patchExtras, campo) ? patchExtras[campo] : extrasAtuais[campo];
  }

  const fatiasPorCampo = { valorVendasIfood: distribuirValorMensal(valorTotalMensal, quantidadeDias) };
  for (const [campo, valor] of Object.entries(extras)) {
    if (valor == null) { fatiasPorCampo[campo] = null; continue; }
    fatiasPorCampo[campo] = CAMPOS_EXTRAS_MENSAL_INTEIROS.has(campo)
      ? distribuirQuantidadeMensal(valor, quantidadeDias)
      : distribuirValorMensal(valor, quantidadeDias);
  }

  return { valorTotalMensal, extras, fatiasPorCampo };
}

/** @param {number|null} media @param {number} diasPrevistos @returns {number|null} */
export function projecaoMensal(media, diasPrevistos) {
  if (media == null) return null;
  return media * (Number(diasPrevistos) || 0);
}

/**
 * Nível de confiabilidade da projeção — regras determinísticas (sem IA).
 * @param {{diasVencidos: number, diasResolvidos: number, diasComDados: number}} p
 * @returns {{nivel: 'alta'|'media'|'baixa'|'indisponivel', justificativa: string}}
 */
export function confiabilidadeProjecao({ diasVencidos, diasResolvidos, diasComDados }) {
  const vencidos = Number(diasVencidos) || 0;
  const resolvidos = Number(diasResolvidos) || 0;
  const comDados = Number(diasComDados) || 0;
  const pendentes = Math.max(vencidos - resolvidos, 0);
  const LIMIAR_RAZOAVEL = 5;

  if (comDados === 0) {
    return { nivel: "indisponivel", justificativa: "Ainda não há lançamentos neste mês para calcular uma projeção." };
  }
  if (pendentes > 0) {
    return { nivel: "baixa", justificativa: `Existem ${pendentes} dia(s) pendente(s) neste mês — regularize os lançamentos para uma projeção mais confiável.` };
  }
  if (comDados >= LIMIAR_RAZOAVEL) {
    return { nivel: "alta", justificativa: `Todos os ${vencidos} dia(s) já vencido(s) neste mês estão resolvidos, com ${comDados} dia(s) de dados.` };
  }
  return { nivel: "media", justificativa: `Sem pendências, mas ainda há poucos dias preenchidos (${comDados}) para uma projeção de alta confiança.` };
}

// ---------------------------------------------------------------------------
// CALENDÁRIO / SEQUÊNCIA
// ---------------------------------------------------------------------------

/**
 * Status "de dados" de um dia, a partir do lançamento (se existir).
 * Devolve null quando NÃO há lançamento — o chamador (statusMes) decide entre
 * PENDENTE/BLOQUEADO/FUTURO a partir do contexto.
 * @param {{lancamento: {status: string, situacao: string, valor_vendas_ifood?: number|null}|null, ehDataElegivel: boolean}} p
 * @returns {string|null}
 */
export function statusDiaBase({ lancamento, ehDataElegivel }) {
  if (!lancamento) return null;
  if (lancamento.status === "rascunho") {
    // Rascunho "normal" sem financeiro ainda é o estado esperado SÓ no dia
    // elegível (dataIso === diaAnterior(hojeIso) — ver
    // dashboardExecutivo.service.js#financeiroDisponivelNaData). Fora desse
    // dia, o financeiro nem é oferecido — um rascunho ali é incompleto por
    // outro motivo de verdade, não "esperando o financeiro do iFood".
    // `lancamento` aqui é a linha CRUA do banco (snake_case), nunca o
    // objeto já convertido pela API — ver carregarCalendarioMes.
    if (ehDataElegivel && situacaoOperou(lancamento.situacao) && lancamento.valor_vendas_ifood == null) return STATUS_DIA.FINANCEIRO_PENDENTE;
    return STATUS_DIA.RASCUNHO;
  }
  if (lancamento.situacao === "sem_operacao") return STATUS_DIA.SEM_OPERACAO;
  if (lancamento.situacao === "zero_vendas") return STATUS_DIA.ZERO_VENDAS;
  return STATUS_DIA.PREENCHIDO;
}

/**
 * Deriva o status de cada dia de um mês. A sequência é calculada SEMPRE
 * dentro do mês recebido: o dia 1 nunca é bloqueado por pendência de um mês
 * anterior (isso vira um alerta à parte — ver `agruparPendenciasPorMes`).
 *
 * `desbloqueios` é o ÚNICO ponto de entrada da exceção administrativa
 * (migration 068 / Painel Administrativo). Um Set de datas ISO liberadas
 * para AQUELA unidade que levanta, só naquelas datas, as duas travas desta
 * função: a janela D-1 do Financeiro (`elegivelFinanceiro`) e a trava
 * sequencial (`BLOQUEADO`). Vazio = comportamento padrão, byte a byte igual
 * ao de antes da exceção existir.
 *
 * Deliberadamente NÃO "resolve" o dia: um dia liberado e ainda vazio vira
 * PENDENTE, não some da conta de pendências — liberar não é preencher (ver
 * `resumoPreenchimento` e a projeção do painel em administrativo.status.js).
 * @param {{dias: Array<{data: string, lancamento: object|null}>, hojeIso: string, desbloqueios?: Set<string>}} p
 * @returns {Array<{data: string, status: string, lancamento: object|null, elegivelFinanceiro: boolean, desbloqueadoAdmin: boolean}>}
 */
export function statusMes({ dias, hojeIso, desbloqueios }) {
  const resultado = [];
  let anteriorResolvido = true; // dia 1 do mês nunca começa bloqueado
  const dataElegivel = diaAnterior(hojeIso);
  const liberado = (data) => desbloqueios instanceof Set && desbloqueios.has(data);
  for (const dia of dias ?? []) {
    let status;
    const temDesbloqueio = liberado(dia.data);
    if (dia.data > hojeIso) {
      // Uma liberação NUNCA antecipa o futuro: o dia de hoje/amanhã não tem
      // fechamento nenhum para lançar. A exceção existe para o passado.
      status = STATUS_DIA.FUTURO;
    } else {
      const base = statusDiaBase({
        lancamento: dia.lancamento,
        ehDataElegivel: dia.data === dataElegivel || temDesbloqueio,
      });
      if (base) status = base;
      else if (!anteriorResolvido && !temDesbloqueio) status = STATUS_DIA.BLOQUEADO;
      else status = STATUS_DIA.PENDENTE;
    }
    // Exposto pro frontend decidir apresentação (badge "Financeiro
    // disponível"/"Financeiro ✓" no dia, faixa-resumo) sem precisar
    // recalcular "hoje - 1" no cliente — mesma autoridade única de sempre,
    // só que agora visível fora desta função. Não muda NENHUMA regra: já
    // era exatamente isto que decidia `ehDataElegivel` acima.
    resultado.push({
      data: dia.data,
      status,
      lancamento: dia.lancamento ?? null,
      elegivelFinanceiro: dia.data === dataElegivel || (temDesbloqueio && status !== STATUS_DIA.FUTURO),
      // Marca de PROCEDÊNCIA, não de status: diz que a disponibilidade deste
      // dia veio de uma liberação administrativa, não da regra normal. O
      // painel usa para rotular "Liberado administrativamente" sem precisar
      // consultar a tabela de novo.
      desbloqueadoAdmin: temDesbloqueio && status !== STATUS_DIA.FUTURO,
    });
    anteriorResolvido = RESOLVIDOS.has(status);
  }
  return resultado;
}

/**
 * O Financeiro do iFood é um SNAPSHOT ACUMULADO do mês (do dia 1 até a data
 * do lançamento), não um valor isolado daquele dia — é assim que o extrato
 * do iFood é liberado (ver migration 036, que substitui a premissa contrária
 * de `023_dashboard_executivo.sql`). Por isso a fonte de verdade financeira
 * de um período NUNCA é a soma de `valor_vendas_ifood` entre vários dias
 * (somaria acumulados sobre acumulados) — é sempre o snapshot mais recente
 * dentro do recorte pedido.
 * Só considera dias que operaram (`normal`/`parcial` — ver
 * `situacaoOperou`); "sem operação"/"zero vendas" gravam os 5 campos
 * financeiros como 0 REAL (ver normalizarDadosLancamento), não como extrato
 * do iFood; deixar esses dias entrarem na busca faria um dia sem operação
 * "apagar" o último snapshot de verdade só por ser mais recente na data.
 *
 * Exceção deliberada: dias de "Lançamento Mensal" (`origem_lancamento ===
 * 'distribuicao_mensal'`) NÃO são snapshot — são fatias que a própria
 * distribuição desenhou pra SOMAR de volta o total que o usuário informou
 * (ver `distribuirValorMensal`), o oposto do resto desta função. Entram só
 * como último recurso (somadas entre si), quando não existe nenhuma entrada
 * real no recorte — nunca competem com um snapshot de verdade, mesmo que
 * este seja mais antigo.
 * @param {Array<{data_lancamento: string, situacao: string, valor_vendas_ifood: number|null, origem_lancamento?: string|null}>} linhas — linhas CRUAS do banco
 * @param {string|null} [ateDataIso] — corte opcional (inclusive); sem ele, considera o mês inteiro
 * @returns {{data_lancamento: string, valor_vendas_ifood: number, taxas_comissoes: number|null, servicos_promocoes: number|null, taxas_entregadores: number|null, ajustes_favor_loja: number|null, ajustes_contra_loja: number|null}|null}
 */
export function snapshotFinanceiroMaisRecente(linhas, ateDataIso = null) {
  const candidatas = (linhas ?? []).filter((r) =>
    situacaoOperou(r.situacao) && (ateDataIso == null || r.data_lancamento <= ateDataIso));

  let maisRecente = null;
  for (const r of candidatas) {
    if (r.origem_lancamento === "distribuicao_mensal" || r.valor_vendas_ifood == null) continue;
    if (!maisRecente || r.data_lancamento > maisRecente.data_lancamento) maisRecente = r;
  }
  if (maisRecente) return maisRecente;

  const distribuidas = candidatas.filter((r) => r.origem_lancamento === "distribuicao_mensal" && r.valor_vendas_ifood != null);
  if (!distribuidas.length) return null;
  const somar = (campo) => {
    const valoresCampo = distribuidas.map((r) => r[campo]).filter((v) => v != null);
    return valoresCampo.length ? valoresCampo.reduce((s, v) => s + Number(v), 0) : null;
  };
  return {
    data_lancamento: distribuidas.reduce((max, r) => (r.data_lancamento > max ? r.data_lancamento : max), distribuidas[0].data_lancamento),
    valor_vendas_ifood: somar("valor_vendas_ifood"),
    taxas_comissoes: somar("taxas_comissoes"),
    servicos_promocoes: somar("servicos_promocoes"),
    taxas_entregadores: somar("taxas_entregadores"),
    ajustes_favor_loja: somar("ajustes_favor_loja"),
    ajustes_contra_loja: somar("ajustes_contra_loja"),
  };
}

/**
 * Par (valorVendasBruto, qtdVendas) do mês pra calcular o TICKET MÉDIO —
 * fonte única usada por Lançamentos (histórico), Visão Geral (unidade e
 * agregado) e visão anual. Mesma prioridade que `snapshotFinanceiroMaisRecente`
 * já usa pro Financeiro, adaptada pro par de Desempenho:
 *
 * 1) Lançamento diário REAL (não fatia de Lançamento Mensal) mais recente
 *    com os dois lados conhecidos — já é o ACUMULADO do mês até aquele dia
 *    (o franqueado informa assim, ver dashboardExecutivoForm.js).
 * 2) Sem nenhum lançamento diário real com o par completo: soma de volta as
 *    fatias do Lançamento Mensal (`origem_lancamento === 'distribuicao_mensal'`)
 *    — nunca pega a fatia de UM dia isolado (que é só uma divisão
 *    proporcional do total, não um ticket médio de verdade).
 *
 * Nunca mistura as duas fontes no mesmo cálculo, e nunca faz média de
 * tickets médios diários — sempre "soma dos totais, dividida no fim" (ver
 * `ticketMedio`, acima).
 * @param {Array<{data_lancamento: string, origem_lancamento?: string|null, qtd_vendas?: number|null, valor_vendas_bruto?: number|null}>} linhas
 * @returns {{valorVendasBruto: number, qtdVendas: number}|null}
 */
export function desempenhoParaTicketMedio(linhas) {
  const reais = (linhas ?? []).filter((r) =>
    r.origem_lancamento !== "distribuicao_mensal" && r.qtd_vendas != null && r.valor_vendas_bruto != null);
  const maisRecente = reais.reduce((mais, r) => (!mais || r.data_lancamento > mais.data_lancamento ? r : mais), null);
  if (maisRecente) {
    return { valorVendasBruto: Number(maisRecente.valor_vendas_bruto), qtdVendas: Number(maisRecente.qtd_vendas) };
  }

  const distribuidas = (linhas ?? []).filter((r) => r.origem_lancamento === "distribuicao_mensal");
  const somar = (campo) => {
    const valores = distribuidas.map((r) => r[campo]).filter((v) => v != null);
    return valores.length ? valores.reduce((s, v) => s + Number(v), 0) : null;
  };
  const somaValor = somar("valor_vendas_bruto");
  const somaQtd = somar("qtd_vendas");
  if (somaValor == null || somaQtd == null) return null;
  return { valorVendasBruto: somaValor, qtdVendas: somaQtd };
}

/**
 * Série do mês inteiro (um ponto por dia, mesmo formato de
 * `desempenhoOperacional.evolucaoDiaria`) só com os dias que têm snapshot
 * financeiro REAL — mesmo filtro de `snapshotFinanceiroMaisRecente`
 * (situação operacional, nunca fatia de "Lançamento Mensal"); os demais dias vêm
 * `null`. Pronta pra plotar SEM interpolar: Chart.js com `spanGaps:false` já
 * não conecta a linha através de um `null`, então dois snapshots distantes
 * no mês aparecem como pontos isolados, nunca uma reta inventada entre eles.
 * Também calcula `delta` contra o snapshot anterior do mês (não contra o
 * dia anterior — snapshots não são diários) e o percentual de deduções
 * daquele snapshot — nunca a fonte oficial (`snapshotFinanceiroMaisRecente`
 * continua sendo), só a série pra visualizar a evolução.
 * @param {string[]} dias — ISO AAAA-MM-DD de todos os dias do mês (diasDoMes)
 * @param {Array<{data_lancamento: string, situacao: string, valor_vendas_ifood: number|null, origem_lancamento?: string|null, taxas_comissoes?: number|null, servicos_promocoes?: number|null, taxas_entregadores?: number|null, ajustes_contra_loja?: number|null}>} linhas — linhas CRUAS do banco
 * @returns {Array<{data: string, valor: number|null, delta: number|null, percentualTotalDeducoes: number|null}>}
 */
export function listaSnapshotsFinanceiros(dias, linhas) {
  const porData = new Map();
  for (const r of linhas ?? []) {
    if (!situacaoOperou(r.situacao) || r.origem_lancamento === "distribuicao_mensal" || r.valor_vendas_ifood == null) continue;
    porData.set(r.data_lancamento, r);
  }
  let anterior = null;
  return (dias ?? []).map((data) => {
    const r = porData.get(data);
    if (!r) return { data, valor: null, delta: null, percentualTotalDeducoes: null };
    const valor = Number(r.valor_vendas_ifood);
    const totalDed = totalDeducoes({
      taxasComissoes: r.taxas_comissoes, servicosPromocoes: r.servicos_promocoes,
      taxasEntregadores: r.taxas_entregadores, ajustesContraLoja: r.ajustes_contra_loja,
    });
    const delta = anterior != null ? valor - anterior : null;
    anterior = valor;
    return { data, valor, delta, percentualTotalDeducoes: percentual(totalDed, valor) };
  });
}

// Campos de Desempenho que passaram a ser ACUMULADOS (item do pedido: "pra
// tanto o desempenho e o financeiro terem a mesma lógica") — cada dia
// guarda o total do mês até ali, nunca o valor isolado daquele dia. O
// valor isolado ("quanto aquele dia fez sozinho") é sempre DERIVADO por
// subtração (hoje - o último acumulado conhecido), nunca a fonte.
const CAMPOS_DESEMPENHO_ACUMULADO = [
  ["qtdVendas", "qtd_vendas"], ["valorVendasBruto", "valor_vendas_bruto"], ["novosClientes", "novos_clientes"],
];

/**
 * Série do mês (um ponto por dia) com o ACUMULADO e o DELTA (o dia
 * sozinho) de cada campo de Desempenho. Delta de um dia = esse acumulado
 * menos o último acumulado conhecido ANTES dele — nunca o dia de calendário
 * anterior direto, porque Desempenho é opcional e pode ter buracos (dias
 * "não informado" no meio do mês). No dia 1 do mês (ou no primeiro dia com
 * dado, se dia 1 não tiver), o delta é o próprio acumulado — não existe
 * "dia 0" pra subtrair.
 *
 * Ignora `origem_lancamento === 'distribuicao_mensal'` — fatia estimada de
 * "Lançamento Mensal" (valor fixo repetido pelos dias sem lançamento, ver
 * `distribuirValorMensal`), não um acumulado real; não participa da série
 * nem quebra a continuidade dela (mesmo critério de `listaSnapshotsFinanceiros`).
 * @param {string[]} dias — ISO AAAA-MM-DD de todos os dias do mês (diasDoMes)
 * @param {Array<{data_lancamento: string, origem_lancamento?: string|null, qtd_vendas?: number|null, valor_vendas_bruto?: number|null, novos_clientes?: number|null}>} linhas — linhas CRUAS do banco
 * @returns {Array<{data: string, qtdVendas: number|null, valorVendasBruto: number|null, novosClientes: number|null, deltaQtdVendas: number|null, deltaValorVendasBruto: number|null, deltaNovosClientes: number|null}>}
 */
export function listaDesempenhoDiario(dias, linhas) {
  const porData = new Map();
  for (const r of linhas ?? []) {
    if (r.origem_lancamento === "distribuicao_mensal") continue;
    porData.set(r.data_lancamento, r);
  }
  const primeiroDia = dias?.[0] ?? null;
  const anterior = { qtdVendas: null, valorVendasBruto: null, novosClientes: null };
  return (dias ?? []).map((data) => {
    const r = porData.get(data);
    const ponto = { data };
    for (const [chave, coluna] of CAMPOS_DESEMPENHO_ACUMULADO) {
      const bruto = r?.[coluna];
      const valor = bruto != null ? Number(bruto) : null;
      const deltaChave = `delta${chave[0].toUpperCase()}${chave.slice(1)}`;
      if (valor == null) {
        ponto[chave] = null;
        ponto[deltaChave] = null;
      } else {
        ponto[chave] = valor;
        ponto[deltaChave] = anterior[chave] != null ? valor - anterior[chave] : (data === primeiroDia ? valor : null);
        anterior[chave] = valor;
      }
    }
    return ponto;
  });
}

/**
 * Último acumulado mensal conhecido de novos clientes. É a leitura canônica
 * usada por Desempenho, cards e histórico; toda a seleção de linhas continua
 * delegada a `listaDesempenhoDiario` (inclusive a exclusão de distribuições
 * mensais estimadas).
 * @returns {number|null}
 */
export function novosClientesAcumulados(dias, linhas) {
  const ultimo = [...listaDesempenhoDiario(dias, linhas)]
    .reverse().find((p) => p.novosClientes != null);
  return ultimo?.novosClientes ?? null;
}

/**
 * Últimos valores ACUMULADOS conhecidos (não-null) de cada campo de
 * Desempenho antes de uma data — usado quando "Sem operação"/"Zero vendas"
 * precisam REPETIR o acumulado do dia anterior (não zerar a série; ver
 * normalizarDadosLancamento). Só olha dentro do MESMO MÊS de `antesDeDataIso`
 * — Desempenho reseta todo mês, igual o Financeiro (nunca herda do mês
 * anterior). Sem nenhum dia anterior com dado (ex.: é o dia 1 do mês), volta
 * zero — o acumulado começa do zero mesmo.
 * @param {Array<{data_lancamento: string, origem_lancamento?: string|null, qtd_vendas?: number|null, valor_vendas_bruto?: number|null, novos_clientes?: number|null}>} linhas
 * @param {string} antesDeDataIso
 * @returns {{qtdVendas: number, valorVendasBruto: number, novosClientes: number}}
 */
export function ultimoDesempenhoConhecido(linhas, antesDeDataIso) {
  const mesAlvo = antesDeDataIso.slice(0, 7);
  const candidatas = (linhas ?? [])
    .filter((r) => r.origem_lancamento !== "distribuicao_mensal"
      && r.data_lancamento < antesDeDataIso && r.data_lancamento.slice(0, 7) === mesAlvo)
    .slice()
    .sort((a, b) => (a.data_lancamento < b.data_lancamento ? -1 : a.data_lancamento > b.data_lancamento ? 1 : 0));
  const resultado = { qtdVendas: 0, valorVendasBruto: 0, novosClientes: 0 };
  for (const r of candidatas) {
    for (const [chave, coluna] of CAMPOS_DESEMPENHO_ACUMULADO) {
      if (r[coluna] != null) resultado[chave] = Number(r[coluna]);
    }
  }
  return resultado;
}

/**
 * Resumo do preenchimento do mês (para o card "resumo" + barra de progresso).
 * @param {Array<{data: string, status: string, lancamento: object|null}>} diasComStatus
 */
export function resumoPreenchimento(diasComStatus) {
  const lista = diasComStatus ?? [];
  const total = lista.length;
  const diasPreenchidos = lista.filter((d) => RESOLVIDOS.has(d.status)).length;
  const diasRascunho = lista.filter((d) => d.status === STATUS_DIA.RASCUNHO).length;
  const diasPendentes = lista.filter((d) => d.status === STATUS_DIA.PENDENTE || d.status === STATUS_DIA.BLOQUEADO).length;
  const diasSemOperacao = lista.filter((d) => d.status === STATUS_DIA.SEM_OPERACAO).length;
  const diasZeroVendas = lista.filter((d) => d.status === STATUS_DIA.ZERO_VENDAS).length;
  const primeiroDiaPendente = lista.find((d) => d.status === STATUS_DIA.PENDENTE)?.data ?? null;
  const ultimoLancamento = [...lista].reverse().find((d) => d.lancamento)?.data ?? null;

  return {
    totalDias: total,
    diasPreenchidos,
    diasPendentes,
    diasRascunho,
    diasSemOperacao,
    diasZeroVendas,
    percentualConclusao: total > 0 ? (diasPreenchidos / total) * 100 : 0,
    primeiroDiaPendente,
    ultimoLancamento,
  };
}

/**
 * Verifica se uma data específica está disponível para lançar (POST) — a
 * trava sequencial. Não distingue rascunho/finalizado: quem chama decide o
 * que fazer com PREENCHIDO/RASCUNHO (editar) vs PENDENTE (criar).
 * @param {Array<{data: string, status: string}>} diasComStatus
 * @param {string} dataAlvo
 * @returns {{disponivel: boolean, motivo: string|null, status: string|null}}
 */
export function verificarDisponibilidade(diasComStatus, dataAlvo) {
  const alvo = (diasComStatus ?? []).find((d) => d.data === dataAlvo);
  if (!alvo) return { disponivel: false, motivo: "Data fora do mês consultado.", status: null };
  if (alvo.status === STATUS_DIA.FUTURO) return { disponivel: false, motivo: "Não é possível lançar uma data futura.", status: alvo.status };
  if (alvo.status === STATUS_DIA.BLOQUEADO) {
    return { disponivel: false, motivo: "Existe um dia anterior deste mês ainda pendente. Resolva-o primeiro.", status: alvo.status };
  }
  return { disponivel: true, motivo: null, status: alvo.status };
}

/**
 * Agrupa datas pendentes por mês/ano — alimenta o alerta de "pendências de
 * meses anteriores" (não bloqueia o mês atual, só avisa).
 * @param {string[]} datasPendentesIso
 * @returns {Array<{ano: number, mes: number, dias: string[]}>}
 */
export function agruparPendenciasPorMes(datasPendentesIso) {
  const grupos = new Map();
  for (const dataIso of datasPendentesIso ?? []) {
    const [ano, mes] = dataIso.split("-");
    const chave = `${ano}-${mes}`;
    if (!grupos.has(chave)) grupos.set(chave, { ano: Number(ano), mes: Number(mes), dias: [] });
    grupos.get(chave).dias.push(dataIso);
  }
  return [...grupos.values()].sort((a, b) => a.ano - b.ano || a.mes - b.mes);
}

// ---------------------------------------------------------------------------
// VALIDAÇÕES PURAS (usadas pelo service; devolvem mensagem pt-BR ou null)
// ---------------------------------------------------------------------------

/**
 * Avisos (não bloqueiam por si só) de inconsistência entre desempenho e
 * financeiro — devem ser exibidos na etapa de conferência do formulário.
 * @param {{qtdVendas: number, valorVendasBruto: number, valorVendasIfood: number, totalDed: number}} p
 * @returns {string[]}
 */
export function inconsistencias({ qtdVendas, valorVendasBruto, valorVendasIfood, totalDed }) {
  const avisos = [];
  const q = Number(qtdVendas) || 0;
  const v = Number(valorVendasBruto) || 0;
  if (v > 0 && q === 0) avisos.push("Há valor de vendas informado, mas a quantidade de vendas está zerada.");
  if (q > 0 && v === 0) avisos.push("Há quantidade de vendas informada, mas o valor bruto está zerado.");
  if (Number(totalDed) > (Number(valorVendasIfood) || 0)) avisos.push("O total de deduções ultrapassa o valor das vendas do iFood.");
  return avisos;
}

// ---------------------------------------------------------------------------
// MODELO LOGÍSTICO DO IFOOD (Marketplace x Full Service)
// ---------------------------------------------------------------------------

export const MODELOS_LOGISTICOS = ["marketplace", "full_service"];

export const ROTULO_MODELO = {
  marketplace: "Marketplace",
  full_service: "Full Service",
};

/**
 * Quais indicadores de rentabilidade existem em cada modelo. É esta lista —
 * não a presença ou ausência de uma linha em `metas_indicadores` — que
 * decide se um indicador é "não aplicável": no Full Service quem entrega é
 * o parceiro do iFood, então não existe meta de "motoboy próprio"
 * (taxas_entregadores). Fonte única dessa regra de negócio.
 * @type {Record<string, string[]>}
 */
export const INDICADORES_POR_MODELO = {
  marketplace: ["taxas_comissoes", "servicos_promocoes", "taxas_entregadores", "total_deducoes"],
  full_service: ["taxas_comissoes", "servicos_promocoes", "total_deducoes"],
};

/**
 * @param {string} modelo @param {string} indicador @returns {boolean}
 */
export function indicadorAplicavel(modelo, indicador) {
  return (INDICADORES_POR_MODELO[modelo] ?? INDICADORES_POR_MODELO.full_service).includes(indicador);
}

// ---------------------------------------------------------------------------
// SIMULADOR DE PREÇO (Balcão x iFood) — auditado e corrigido: a margem do
// iFood passa a descontar Taxas e Comissões E Serviços e Promoções (antes só
// descontava Taxas e Comissões), e a referência do modelo logístico usada
// para avaliar a diferença de preço é calculada aqui, não lida de uma linha
// separada em `metas_indicadores`.
// ---------------------------------------------------------------------------

/**
 * Margem estimada do iFood, descontando as DUAS deduções que o simulador
 * considera hoje: Taxas e Comissões (cobrança obrigatória do canal) e
 * Serviços e Promoções (investimento em campanhas do mês). NÃO inclui Taxas
 * de entregadores nem ajustes contra a loja — por isso nunca é lucro líquido
 * (ver NOTA_MARGEM_IFOOD em dashboardExecutivo.simulador.service.js).
 *
 * Nunca trata percentual ausente como 0: se Taxas e Comissões OU Serviços e
 * Promoções não foram apurados no mês, a margem inteira fica indisponível
 * (null) — um 0 aqui inflaria a margem escondendo dado faltante.
 * @param {{preco: number, custo: number, taxaComissoesPct: number|null, servicosPromocoesPct: number|null}} p
 * @returns {{taxaComissoesReais: number|null, servicosPromocoesReais: number|null, deducoesConsideradasPct: number|null, receitaAposDeducoesConsideradas: number|null, margemEstimada: number|null, margemEstimadaPct: number|null}}
 */
export function margemEstimadaIfood({ preco, custo, taxaComissoesPct, servicosPromocoesPct }) {
  if (taxaComissoesPct == null || servicosPromocoesPct == null) {
    return {
      taxaComissoesReais: null, servicosPromocoesReais: null, deducoesConsideradasPct: null,
      receitaAposDeducoesConsideradas: null, margemEstimada: null, margemEstimadaPct: null,
    };
  }
  const p = Number(preco);
  const taxaComissoesReais = (p * taxaComissoesPct) / 100;
  const servicosPromocoesReais = (p * servicosPromocoesPct) / 100;
  const receitaAposDeducoesConsideradas = p - taxaComissoesReais - servicosPromocoesReais;
  const margemEstimada = receitaAposDeducoesConsideradas - Number(custo || 0);
  const margemEstimadaPct = p > 0 ? (margemEstimada / p) * 100 : null;
  return {
    taxaComissoesReais, servicosPromocoesReais,
    deducoesConsideradasPct: taxaComissoesPct + servicosPromocoesPct,
    receitaAposDeducoesConsideradas, margemEstimada, margemEstimadaPct,
  };
}

// `referenciaModeloPct` / `limiteCombinadoPct` / `situacaoDiferencaPreco` foram
// removidos com o simulador antigo. A PROTEÇÃO DA PRECIFICAÇÃO (diferença entre
// tabela Balcão e tabela iFood) é um conceito à parte, no motor slim
// dashboardExecutivo.rentabilidade.js, e NUNCA se cruza com as metas/limites
// logísticos (marketplace/full_service, `metas_indicadores`) dos 4 indicadores.

// Diagnóstico executivo e Plano de Ação viraram um motor à parte —
// dashboardExecutivo.diagnostico.js — que usa statusIndicador/saldoMeta
// daqui como base, mas gera pontos fortes/atenção/alertas/ações
// quantitativos, ligados 1:1 por id (ver DIAGNOSTICO_ARQUITETURA lá).
