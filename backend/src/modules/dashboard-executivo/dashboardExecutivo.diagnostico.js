// Motor central de diagnóstico do Dashboard iFood — "Diagnóstico via Crescer
// c/ Delivery" (o que está acontecendo) + "Plano de Ação" (o que fazer agora).
//
// REGRA DE OURO: só afirma o que os dados sustentam. Nunca inventa causa
// ("caiu porque as promoções…") — descreve o desvio e calcula o que dá pra
// calcular (quanto falta, até quando, qual o valor em R$). Sem dado
// suficiente, o achado simplesmente não é gerado — nunca um número forçado.
//
// FONTE ÚNICA: cada achado (ponto forte/atenção/alerta) tem um `id` estável.
// Quando ele vira ação no Plano, a ação carrega esse MESMO id em
// `diagnosticoId` — o Plano nunca lista um problema que o Diagnóstico não
// listou, e os dois nunca divergem porque são a mesma passada de dados.
//
// EXTENSÍVEL de propósito: cada tipo de achado é uma função `analisar*()`
// independente que devolve `{achado, acao, manutencao}` ou `null`. Novos
// diagnósticos entram como mais uma função na lista `ANALISADORES`, sem tocar
// no motor central nem nos outros analisadores.
//
// ---------------------------------------------------------------------------
// PLANO DE AÇÃO — CLASSIFICAÇÃO SEMÂNTICA (reformulação)
// ---------------------------------------------------------------------------
// O Plano deixou de ser só um detector de problemas. Cada item tem um `tipo`:
//
//   CRITICAL      indicador acima do LIMITE / queda forte de faturamento
//   WARNING       indicador acima da meta ideal, ainda dentro do limite
//   HEALTHY       indicador dentro da meta ideal — vira AÇÃO DE PRESERVAÇÃO
//   DATA_PENDING  qualidade dos dados (dias pendentes / detalhamento ausente)
//
// A classificação NÃO tem regra própria: consome `statusIndicador`
// (dashboardExecutivo.calc.js), a mesma fonte única dos cards. Quando
// `metaIdeal == limite` (ex.: Taxas e Comissões), não existe faixa WARNING —
// e isso é consequência natural da regra de domínio, não um caso especial.
//
// SEPARAÇÃO SEMÂNTICA: ações corretivas/preventivas ficam em `acoes`
// (CRITICAL + WARNING + DATA_PENDING). Preservação de resultado saudável fica
// em `manutencao` (HEALTHY) — estrutura própria, mais enxuta, para não
// misturar "preciso corrigir" com "preciso preservar" nem inflar o payload
// consumido pelo Agente Crescer.
//
// OPPORTUNITY: deliberadamente NÃO implementado — a meta ideal é um teto
// operacional, não um benchmark de excelência; não há base objetiva para
// afirmar "excepcionalmente bem" sem uma heurística escondida.
import { statusIndicador } from "./dashboardExecutivo.calc.js";

// ---------------------------------------------------------------------------
// LIMIARES — únicos, documentados, nunca duplicados/hardcoded no frontend.
// Mudou o número? Muda só aqui.
// ---------------------------------------------------------------------------
export const LIMIARES_DIAGNOSTICO = {
  // Queda de faturamento no período comparável: abaixo disso já vira achado.
  quedaAtencaoPct: -5,
  quedaAlertaPct: -20,
  // Confiabilidade dos dados do mês.
  diasPendentesParaMedia: 1,
  diasPendentesParaBaixa: 5,
  diasEstimadosParaBaixa: 1,
  // Plano de recuperação: se a média necessária for mais que isto vezes a
  // média atual, a meta integral vira "pouco provável" e mostramos cenários.
  recuperacaoMultiplicadorPoucoProvavel: 2,
  cenarioParcialPct: 10, // "recuperação parcial" = média atual + 10%
  cenarioForcaPct: 20,   // "recuperação forte"   = média atual + 20%
  diasParaAmostraPendentes: 5, // quantas datas listar antes de "+N dias"
  // Comparativo Marketplace × Full Service (período misto): um regime com
  // menos dias que isto no período consultado é "amostra inicial" — os
  // números aparecem, mas a comparação não sustenta uma conclusão de
  // tendência. MESMO limiar de `diasPendentesParaBaixa` (5) — não é um
  // número novo, é a mesma régua de "poucos dias" já usada pra confiabilidade.
  diasSegmentoParaAmostraPequena: 5,
};

const fmtPct1 = (v) => `${Number(v).toFixed(1)}%`;
const fmtPp1 = (v) => `${Number(v).toFixed(1)} p.p.`;
const fmtR = (v) => `R$ ${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDataBrCurta = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const ROTULO_INDICADOR = {
  taxas_comissoes: "Taxas e Comissões",
  servicos_promocoes: "Serviços e Promoções",
  taxas_entregadores: "Taxas de Entregadores",
};

/** Rótulo de qualquer categoria de achado — usado pelos textos do resumo. */
const ROTULO_ACHADO = {
  ...ROTULO_INDICADOR,
  total_deducoes: "Total de Deduções",
  faturamento: "Faturamento",
  receita_liquida: "Receita Líquida",
};

// Orientação por indicador — sempre "o que ANALISAR/fazer", nunca uma causa
// afirmada (respeita a REGRA DE OURO). Uma variante mais firme para CRITICAL,
// uma mais branda para WARNING.
const ACAO_RECOMENDADA = {
  taxas_comissoes: {
    CRITICAL: "Confira o extrato do iFood do período linha a linha: comissão e taxa de transação online são contratuais, então um valor acima do limite merece conferência antes de qualquer ação.",
    WARNING: "Acompanhe a composição de Taxas e Comissões nos próximos dias e verifique se o mix de canais e formas de pagamento mudou em relação ao habitual.",
  },
  servicos_promocoes: {
    CRITICAL: "Reveja todas as campanhas e promoções ativas no período e o retorno de cada uma; desative as que não se pagam antes de mexer nas demais.",
    WARNING: "Reveja o retorno das campanhas ativas e evite acumular novas promoções enquanto o indicador estiver acima da faixa ideal.",
  },
  taxas_entregadores: {
    CRITICAL: "Reveja os repasses a entregadores no período e os dias de maior volume; confirme se o modelo logístico e as taxas praticadas estão corretos no iFood.",
    WARNING: "Acompanhe os repasses a entregadores nos dias de maior volume e confirme se as taxas seguem as praticadas no início do mês.",
  },
};
const ACAO_RECOMENDADA_DEDUCOES = {
  CRITICAL: "Abra o detalhamento das deduções (aba Indicadores) e comece pelo componente de maior participação — é onde uma redução tem mais efeito no total.",
  WARNING: "Acompanhe os componentes das deduções pelo detalhamento (aba Indicadores) e atue cedo no que estiver crescendo.",
};

// Orientação curta de preservação (cards HEALTHY, bloco "Como manter este
// resultado"). Linguagem de manutenção — nunca sugere que há um problema.
const COMO_PRESERVAR = {
  taxas_comissoes: "Acompanhe mudanças nas taxas do iFood e no mix de canais e formas de pagamento — são os fatores que mais mexem neste indicador.",
  servicos_promocoes: "Controle quantas campanhas ficam ativas ao mesmo tempo e revise o retorno de cada uma periodicamente.",
  taxas_entregadores: "Acompanhe os repasses a entregadores nos dias de maior volume e qualquer mudança no modelo logístico da unidade.",
  total_deducoes: "Acompanhe a evolução de cada componente das deduções e atue cedo se algum começar a subir.",
};

// ---------------------------------------------------------------------------
// CONFIABILIDADE DOS DADOS — quão bem sustentado está o diagnóstico do mês.
// Regras objetivas e centralizadas (ver LIMIARES_DIAGNOSTICO acima); nada de
// score obscuro.
// ---------------------------------------------------------------------------
export function confiabilidadeDados({ diasComDados, diasPendentes, diasEstimados }) {
  if (!diasComDados) return { nivel: "indisponivel", motivo: "Ainda não há lançamentos neste mês." };
  const L = LIMIARES_DIAGNOSTICO;
  const motivos = [];
  let nivel = "alta";
  if (diasEstimados >= L.diasEstimadosParaBaixa) {
    nivel = "baixa";
    motivos.push(`${diasEstimados} dia(s) com valor estimado por distribuição mensal (não é dado diário real)`);
  }
  if (diasPendentes >= L.diasPendentesParaBaixa) {
    nivel = "baixa";
    motivos.push(`${diasPendentes} dias pendentes`);
  } else if (diasPendentes >= L.diasPendentesParaMedia && nivel === "alta") {
    nivel = "media";
    motivos.push(`${diasPendentes} dia(s) pendente(s)`);
  }
  return { nivel, motivo: motivos.length ? motivos.join(" · ") : "Mês com todos os dias regularizados." };
}

// ---------------------------------------------------------------------------
// ANALISADORES — cada um cuida de UM tipo de achado. Devolvem sempre um objeto
// { achado, acao, manutencao } (qualquer campo pode ser null) ou null.
// ---------------------------------------------------------------------------

/**
 * Taxas e Comissões / Serviços e Promoções / Taxas de Entregadores —
 * meta ideal x limite, em % e R$. Dentro da meta -> item de MANUTENÇÃO
 * (HEALTHY); acima -> ação corretiva (WARNING/CRITICAL).
 *
 * `contexto` (opcional, período misto — item do pedido: um problema que
 * existe SÓ num regime não pode virar recomendação genérica do mês inteiro):
 * `{sufixoId, rotuloPrefixo}` — reusa esta MESMA função por segmento (chamada
 * uma vez por regime em `gerarDiagnostico`), só prefixando id/título pra não
 * colidir com o achado consolidado.
 */
function analisarIndicadorPercentual(chave, dado, faturamentoBase, contexto = null) {
  if (!dado || dado.naoAplicavel || dado.atual == null || !dado.meta) return null;
  const rotuloBase = ROTULO_INDICADOR[chave];
  const rotulo = contexto ? `${rotuloBase} — ${contexto.rotuloPrefixo}` : rotuloBase;
  const idBase = contexto ? `${chave}_${contexto.sufixoId}` : chave;
  const metaIdeal = dado.meta.metaIdeal;
  const limite = dado.meta.limite;
  const st = statusIndicador(dado.atual, dado.meta);

  // -- HEALTHY: dentro da meta ideal ---------------------------------------
  if (st.chave === "dentro_da_meta") {
    const margemPp = metaIdeal - dado.atual;
    return {
      achado: {
        id: `${idBase}_dentro_da_meta`, categoria: chave, severidade: "forte",
        titulo: `${rotulo} dentro da meta ideal`,
        descricao: `${rotulo} está em ${fmtPct1(dado.atual)}, dentro da meta ideal de ${fmtPct1(metaIdeal)}.`,
        metricas: { percentualAtual: dado.atual, percentualIdeal: metaIdeal, percentualLimite: limite, valorAtual: dado.valor },
      },
      acao: null,
      manutencao: {
        diagnosticoId: `${idBase}_dentro_da_meta`,
        tipo: "HEALTHY",
        categoria: chave,
        titulo: `Manter ${rotulo} sob controle`,
        situacao: `${fmtPct1(dado.atual)} do faturamento`,
        status: "Dentro da meta",
        meta: { ideal: metaIdeal, limite },
        // Margem abaixo do teto — só quando é uma folga real (> 0).
        diferenca: margemPp > 0.05 ? { pp: margemPp } : null,
        explicacao: `O indicador está em ${fmtPct1(dado.atual)}, dentro da faixa saudável (meta ideal ${fmtPct1(metaIdeal)}), e atualmente não exige correção.`,
        comoPreservar: COMO_PRESERVAR[chave],
        objetivo: { proximo: null, ideal: `permanecer ≤ ${fmtPct1(metaIdeal)}` },
        cta: { label: `Analisar ${rotulo}`, aba: "indicadores" },
      },
    };
  }

  // -- WARNING / CRITICAL: acima da meta ----------------------------------
  const tipo = st.chave === "atencao" ? "WARNING" : "CRITICAL";
  const severidade = tipo === "WARNING" ? "atencao" : "alerta";
  const valorIdeal = faturamentoBase != null ? (faturamentoBase * metaIdeal) / 100 : null;
  const excessoSobreIdeal = valorIdeal != null && dado.valor != null ? dado.valor - valorIdeal : null;
  const limiteReais = dado.saldo?.limiteReais ?? null;
  const excessoSobreLimite = limiteReais != null && dado.valor != null ? dado.valor - limiteReais : null;
  const margemReais = dado.saldo?.disponivelReais ?? null;
  const margemPp = dado.saldo?.disponivelPp ?? null;

  const titulo = tipo === "WARNING" ? `${rotulo} acima da faixa ideal` : `${rotulo} acima do limite`;

  let explicacao;
  let impacto = null;
  let objetivo;
  if (tipo === "WARNING") {
    explicacao = `${rotulo} está em ${fmtPct1(dado.atual)} do faturamento — acima da meta ideal de ${fmtPct1(metaIdeal)}, mas ainda dentro do limite de ${fmtPct1(limite)}.`;
    if (excessoSobreIdeal != null) {
      impacto = `Para voltar à meta ideal de ${fmtPct1(metaIdeal)} considerando o faturamento registrado até agora, seria necessário reduzir aproximadamente ${fmtR(excessoSobreIdeal)} em ${rotulo}.`;
    }
    if (margemReais != null && margemReais > 0) {
      explicacao += ` Ainda há margem até o limite (${fmtPp1(margemPp)} · ${fmtR(margemReais)}), mas como já está acima da faixa ideal não é recomendável ampliar os gastos sem avaliar o retorno.`;
    }
    objetivo = { proximo: `≤ ${fmtPct1(metaIdeal)}`, ideal: null };
  } else {
    explicacao = `${rotulo} está em ${fmtPct1(dado.atual)} do faturamento e ultrapassou o limite máximo de ${fmtPct1(limite)} (meta ideal ${fmtPct1(metaIdeal)}).`;
    if (excessoSobreLimite != null) {
      impacto = `Para retornar ao limite de ${fmtPct1(limite)}, é necessário reduzir aproximadamente ${fmtR(excessoSobreLimite)} em ${rotulo} no período`;
      impacto += excessoSobreIdeal != null ? `; para retornar à meta ideal, aproximadamente ${fmtR(excessoSobreIdeal)}.` : ".";
    } else if (excessoSobreIdeal != null) {
      impacto = `Para retornar à meta ideal de ${fmtPct1(metaIdeal)}, seria necessário reduzir aproximadamente ${fmtR(excessoSobreIdeal)} em ${rotulo}.`;
    }
    objetivo = { proximo: `≤ ${fmtPct1(limite)}`, ideal: metaIdeal < limite ? `aproximar de ${fmtPct1(metaIdeal)}` : null };
  }

  // `descricao` da ação: preservada com o mesmo espírito da versão anterior
  // (compatibilidade com o Agente Crescer, que a lê via consultar_diagnostico).
  const descricao = [explicacao, impacto].filter(Boolean).join(" ");

  return {
    achado: {
      id: `${idBase}_${st.chave}`, categoria: chave, severidade, titulo,
      descricao: `${rotulo} está em ${fmtPct1(dado.atual)} — meta ideal ${fmtPct1(metaIdeal)}, limite ${fmtPct1(limite)}.`,
      metricas: {
        percentualAtual: dado.atual, percentualIdeal: metaIdeal, percentualLimite: limite,
        valorAtual: dado.valor, valorIdeal, excesso: excessoSobreIdeal, limiteReais,
        excessoSobreLimite, margemAteLimiteReais: margemReais, margemAteLimitePp: margemPp,
      },
    },
    acao: {
      diagnosticoId: `${idBase}_${st.chave}`,
      tipo,
      categoria: chave,
      titulo,
      situacao: `${fmtPct1(dado.atual)} do faturamento`,
      meta: { ideal: metaIdeal, limite },
      diferenca: {
        pp: dado.atual - metaIdeal,
        reais: tipo === "WARNING" ? excessoSobreIdeal : (excessoSobreLimite ?? excessoSobreIdeal),
      },
      impacto,
      explicacao,
      acaoRecomendada: ACAO_RECOMENDADA[chave]?.[tipo] ?? null,
      objetivo,
      descricao,
      cta: { label: `Analisar ${rotulo}`, aba: "indicadores" },
      ordenacao: {
        temImpacto: (tipo === "WARNING" ? excessoSobreIdeal : excessoSobreLimite) != null,
        excessoReais: tipo === "WARNING" ? excessoSobreIdeal : (excessoSobreLimite ?? null),
        distanciaLimitePp: dado.atual - limite,
      },
    },
    manutencao: null,
  };
}

/**
 * Total de Deduções — meta ideal x limite + qual componente mais contribui
 * (sem inferir causa). `contexto` (opcional): mesmo espírito de
 * `analisarIndicadorPercentual` — chamada uma vez por segmento no período misto.
 */
function analisarTotalDeducoes(dado, componentes, faturamentoBase, contexto = null) {
  if (!dado || dado.atual == null || !dado.meta) return null;
  const rotuloTd = contexto ? `Total de Deduções — ${contexto.rotuloPrefixo}` : "Total de Deduções";
  const idBase = contexto ? `total_deducoes_${contexto.sufixoId}` : "total_deducoes";
  const metaIdeal = dado.meta.metaIdeal;
  const limite = dado.meta.limite;
  const st = statusIndicador(dado.atual, dado.meta);

  if (st.chave === "dentro_da_meta") {
    const margemPp = metaIdeal - dado.atual;
    return {
      achado: {
        id: `${idBase}_dentro_da_meta`, categoria: "total_deducoes", severidade: "forte",
        titulo: `${rotuloTd} dentro da meta ideal`,
        descricao: `${rotuloTd} em ${fmtPct1(dado.atual)}, dentro da meta ideal de ${fmtPct1(metaIdeal)}.`,
        metricas: { percentualAtual: dado.atual, percentualIdeal: metaIdeal, percentualLimite: limite },
      },
      acao: null,
      manutencao: {
        diagnosticoId: `${idBase}_dentro_da_meta`,
        tipo: "HEALTHY",
        categoria: "total_deducoes",
        titulo: `Manter ${rotuloTd.toLowerCase()} sob controle`,
        situacao: `${fmtPct1(dado.atual)} do faturamento`,
        status: "Dentro da meta",
        meta: { ideal: metaIdeal, limite },
        diferenca: margemPp > 0.05 ? { pp: margemPp } : null,
        explicacao: `${rotuloTd} está em ${fmtPct1(dado.atual)}, dentro da faixa saudável (meta ideal ${fmtPct1(metaIdeal)}), e atualmente não exige correção.`,
        comoPreservar: COMO_PRESERVAR.total_deducoes,
        objetivo: { proximo: null, ideal: `permanecer ≤ ${fmtPct1(metaIdeal)}` },
        cta: { label: "Ver Indicadores", aba: "indicadores" },
      },
    };
  }

  const conhecidos = componentes.filter((c) => c.percentual != null).sort((a, b) => b.percentual - a.percentual);
  const maior = conhecidos[0] ?? null;
  const composicaoTexto = maior ? ` O componente com maior participação é ${maior.rotulo} (${fmtPct1(maior.percentual)} do faturamento) — não significa necessariamente a causa da variação, só onde está a maior parcela.` : "";
  const tipo = st.chave === "atencao" ? "WARNING" : "CRITICAL";
  const severidade = tipo === "WARNING" ? "atencao" : "alerta";
  const excesso = faturamentoBase != null && dado.valor != null ? dado.valor - (faturamentoBase * metaIdeal) / 100 : null;
  const limiteReais = faturamentoBase != null ? (faturamentoBase * limite) / 100 : null;
  const excessoSobreLimite = limiteReais != null && dado.valor != null ? dado.valor - limiteReais : null;
  const titulo = tipo === "WARNING" ? `${rotuloTd} acima da faixa ideal` : `${rotuloTd} acima do limite`;

  const explicacao = tipo === "WARNING"
    ? `${rotuloTd} está em ${fmtPct1(dado.atual)} do faturamento — acima da meta ideal de ${fmtPct1(metaIdeal)}, mas ainda dentro do limite de ${fmtPct1(limite)}.${composicaoTexto}`
    : `${rotuloTd} está em ${fmtPct1(dado.atual)} do faturamento e ultrapassou o limite máximo de ${fmtPct1(limite)}.${composicaoTexto}`;
  const impacto = tipo === "CRITICAL" && excessoSobreLimite != null
    ? `Para retornar ao limite de ${fmtPct1(limite)}, é necessário reduzir aproximadamente ${fmtR(excessoSobreLimite)} no total de deduções.`
    : excesso != null
      ? `Para retornar à meta ideal de ${fmtPct1(metaIdeal)}, é necessário reduzir aproximadamente ${fmtR(excesso)} no total de deduções.`
      : null;
  const objetivo = tipo === "WARNING"
    ? { proximo: `≤ ${fmtPct1(metaIdeal)}`, ideal: null }
    : { proximo: `≤ ${fmtPct1(limite)}`, ideal: metaIdeal < limite ? `aproximar de ${fmtPct1(metaIdeal)}` : null };

  return {
    achado: {
      id: `${idBase}_${st.chave}`, categoria: "total_deducoes", severidade, titulo,
      descricao: `${rotuloTd} em ${fmtPct1(dado.atual)} — meta ideal ${fmtPct1(metaIdeal)}, limite ${fmtPct1(limite)}.${composicaoTexto}`,
      metricas: { percentualAtual: dado.atual, percentualIdeal: metaIdeal, percentualLimite: limite, excesso, excessoSobreLimite, composicao: conhecidos },
    },
    acao: {
      diagnosticoId: `${idBase}_${st.chave}`,
      tipo,
      categoria: "total_deducoes",
      titulo: tipo === "WARNING"
        ? (contexto ? `Revisar a composição das deduções — ${contexto.rotuloPrefixo}` : "Revisar a composição das deduções")
        : (contexto ? `Reduzir o total de deduções — ${contexto.rotuloPrefixo}` : "Reduzir o total de deduções"),
      situacao: `${fmtPct1(dado.atual)} do faturamento`,
      meta: { ideal: metaIdeal, limite },
      diferenca: { pp: dado.atual - metaIdeal, reais: tipo === "CRITICAL" ? (excessoSobreLimite ?? excesso) : excesso },
      impacto,
      explicacao,
      acaoRecomendada: ACAO_RECOMENDADA_DEDUCOES[tipo],
      objetivo,
      descricao: (impacto ?? "Total de deduções acima do esperado.") + composicaoTexto,
      cta: { label: "Ver Indicadores", aba: "indicadores" },
      ordenacao: {
        temImpacto: (tipo === "CRITICAL" ? excessoSobreLimite : excesso) != null,
        excessoReais: tipo === "CRITICAL" ? (excessoSobreLimite ?? null) : (excesso ?? null),
        distanciaLimitePp: dado.atual - limite,
      },
    },
    manutencao: null,
  };
}

/**
 * Faturamento — comparação com o período de referência + plano de
 * recuperação. `comparativo` já vem pronto do service (mesmo período quando
 * o mês está em andamento, mês fechado x mês fechado quando não está — ver
 * dashboardExecutivo.service.js#calcularComparativoFaturamento).
 *
 * Crescimento -> ponto forte (sem ação nem manutenção: não há meta/limite de
 * faturamento, o conceito HEALTHY do Plano é ancorado em meta). Queda -> ação
 * corretiva (CRITICAL/WARNING) com o plano de recuperação como detalhe.
 */
function analisarFaturamento(comparativo, recuperacao) {
  if (!comparativo || comparativo.tipo === "indisponivel" || comparativo.pct == null) return null;
  const L = LIMIARES_DIAGNOSTICO;
  const rotuloRecorte = comparativo.tipo === "mesmo_periodo" ? `nos primeiros ${comparativo.diaComparado} dias` : "no mês fechado";
  const notaEstimativa = comparativo.temEstimativa ? " Atenção: um dos períodos comparados inclui dias com valor estimado por distribuição mensal, não lançamento diário real." : "";

  if (comparativo.pct > 0) {
    return {
      achado: {
        id: "faturamento_cresceu", categoria: "faturamento", severidade: "forte",
        titulo: "Faturamento em crescimento",
        descricao: `Faturamento cresceu ${fmtPct1(comparativo.pct)} ${rotuloRecorte}, comparado ao mesmo recorte do mês anterior (${fmtR(comparativo.anterior)} → ${fmtR(comparativo.atual)}).${notaEstimativa}`,
        metricas: { ...comparativo },
      },
      acao: null,
      manutencao: null,
    };
  }
  if (comparativo.pct > L.quedaAtencaoPct) return null; // queda pequena — não vira achado

  const tipo = comparativo.pct <= L.quedaAlertaPct ? "CRITICAL" : "WARNING";
  const severidade = tipo === "CRITICAL" ? "alerta" : "atencao";
  const explicacao = `Faturamento caiu ${fmtPct1(Math.abs(comparativo.pct))} ${rotuloRecorte}, comparado ao mesmo recorte do mês anterior (${fmtR(comparativo.anterior)} → ${fmtR(comparativo.atual)}, diferença de ${fmtR(comparativo.diferenca)}).${notaEstimativa} Dados insuficientes para determinar a causa com segurança — este diagnóstico aponta o desvio, não o motivo.`;
  const achado = {
    id: "faturamento_caiu", categoria: "faturamento", severidade,
    titulo: "Faturamento em queda",
    descricao: explicacao,
    metricas: { ...comparativo },
  };

  let acao = null;
  if (recuperacao) {
    const descricao = recuperacao.diasRestantes <= 0
      ? `O mês está praticamente encerrado — recuperação integral não é mais possível dentro deste período. Faturamento de referência (mês anterior): ${fmtR(recuperacao.referencia)}; registrado até agora: ${fmtR(recuperacao.atual)}.`
      : recuperacao.poucoProvavel
        ? `Recuperação integral pouco provável com base no ritmo atual — seria necessário elevar a média diária de ${fmtR(recuperacao.mediaAtual ?? 0)} para ${fmtR(recuperacao.mediaNecessaria)} nos ${recuperacao.diasRestantes} dia(s) restantes. Cenários possíveis: conservador (mantém o ritmo atual) ${fmtR(recuperacao.cenarios.conservador)}/dia · recuperação parcial (+${L.cenarioParcialPct}%) ${fmtR(recuperacao.cenarios.parcial)}/dia · recuperação forte (+${L.cenarioForcaPct}%) ${fmtR(recuperacao.cenarios.forte)}/dia. São cenários matemáticos, não uma previsão estatística.`
        : `Para atingir o faturamento de referência de ${fmtR(recuperacao.referencia)} até o final do mês, a unidade precisa elevar sua média diária de aproximadamente ${fmtR(recuperacao.mediaAtual ?? 0)} para ${fmtR(recuperacao.mediaNecessaria)} nos próximos ${recuperacao.diasRestantes} dia(s) — faltam ${fmtR(recuperacao.faltante)}.`;
    acao = {
      diagnosticoId: "faturamento_caiu",
      tipo,
      categoria: "faturamento",
      titulo: recuperacao.diasRestantes <= 0 ? "Mês encerrado — ver fechamento" : (recuperacao.poucoProvavel ? "Cenários para o restante do mês" : "Plano de recuperação do faturamento"),
      situacao: `${fmtPct1(Math.abs(comparativo.pct))} abaixo do mês anterior (${rotuloRecorte})`,
      meta: null,
      diferenca: { pp: null, reais: comparativo.diferenca },
      impacto: recuperacao.faltante != null ? `Faltam ${fmtR(recuperacao.faltante)} para o faturamento de referência de ${fmtR(recuperacao.referencia)}.` : null,
      explicacao,
      acaoRecomendada: recuperacao.diasRestantes <= 0
        ? "O período está encerrado — use o fechamento para planejar o próximo mês."
        : recuperacao.poucoProvavel
          ? "Avalie os cenários de faturamento para o restante do mês e defina uma meta realista de média diária."
          : "Siga o plano de recuperação: eleve a média diária para o valor indicado no restante do mês.",
      objetivo: { proximo: null, ideal: `atingir ${fmtR(recuperacao.referencia)}` },
      descricao,
      cta: { label: "Ver plano de recuperação", expandir: "recuperacao" },
      detalhe: recuperacao,
      ordenacao: {
        temImpacto: recuperacao.faltante != null,
        excessoReais: recuperacao.faltante ?? null,
        distanciaLimitePp: null,
      },
    };
  }
  return { achado, acao, manutencao: null };
}

/** Dias sem lançamento — sempre acionável, aponta exatamente quais dias. DATA_PENDING. */
function analisarDiasPendentes(diasPendentes, datas) {
  if (!diasPendentes) return null;
  const L = LIMIARES_DIAGNOSTICO;
  const severidade = diasPendentes >= L.diasPendentesParaBaixa ? "alerta" : "atencao";
  const amostra = datas.slice(0, L.diasParaAmostraPendentes).map(fmtDataBrCurta).join(", ");
  const resto = datas.length > L.diasParaAmostraPendentes ? ` e +${datas.length - L.diasParaAmostraPendentes} dia(s)` : "";
  const plural = diasPendentes > 1 ? "s" : "";
  const explicacao = `Existem ${diasPendentes} dia${plural} sem lançamento neste mês (${amostra}${resto}). Enquanto existirem lançamentos pendentes, faturamento, médias, projeções e comparações deste mês podem estar subestimados.`;
  return {
    achado: {
      id: "dias_pendentes", categoria: "dados", severidade,
      titulo: `${diasPendentes} lançamento${plural} pendente${plural}`,
      descricao: explicacao,
      metricas: { diasPendentes, datas },
    },
    acao: {
      diagnosticoId: "dias_pendentes",
      tipo: "DATA_PENDING",
      categoria: "dados",
      titulo: `Regularizar ${diasPendentes} dia${plural}`,
      situacao: `${diasPendentes} dia${plural} sem lançamento no período`,
      meta: null,
      diferenca: null,
      impacto: null, // pendência de dado não é impacto financeiro operacional (ver item 10 do pedido)
      explicacao,
      acaoRecomendada: `Lance os dias pendentes (${amostra}${resto}) para estabilizar médias, projeções e comparações do mês.`,
      objetivo: { proximo: "regularizar os lançamentos pendentes", ideal: null },
      descricao: `Os seguintes dias ainda não possuem lançamento: ${amostra}${resto}.`,
      cta: { label: `Regularizar ${diasPendentes} dia${plural}`, aba: "lancamentos" },
      ordenacao: { temImpacto: false, excessoReais: null, distanciaLimitePp: null },
    },
    manutencao: null,
  };
}

/** Detalhamento financeiro (taxas/serviços/deduções) totalmente ausente no mês — ex.: mês só com lançamento mensal. DATA_PENDING. */
function analisarDetalhamentoAusente(indicadores) {
  const chaves = ["taxas_comissoes", "servicos_promocoes", "total_deducoes"];
  const relevantes = chaves.filter((c) => !indicadores[c]?.naoAplicavel);
  if (!relevantes.length || !relevantes.every((c) => indicadores[c]?.atual == null)) return null;
  const explicacao = "Taxas e Comissões, Serviços e Promoções e Total de Deduções — dados insuficientes para avaliação neste mês.";
  return {
    achado: {
      id: "detalhamento_financeiro_ausente", categoria: "dados", severidade: "atencao",
      titulo: "Detalhamento financeiro ainda não disponível",
      descricao: explicacao,
      metricas: {},
    },
    acao: {
      diagnosticoId: "detalhamento_financeiro_ausente",
      tipo: "DATA_PENDING",
      categoria: "dados",
      titulo: "Completar dados financeiros",
      situacao: "Detalhamento de taxas, serviços e deduções ainda não informado",
      meta: null,
      diferenca: null,
      impacto: null,
      explicacao,
      acaoRecomendada: "Complete os dados financeiros dos lançamentos para habilitar a análise dos indicadores de rentabilidade.",
      objetivo: { proximo: "informar o detalhamento financeiro do mês", ideal: null },
      descricao: "Complete os dados financeiros dos lançamentos para habilitar esta análise.",
      cta: { label: "Ir para Lançamentos", aba: "lancamentos" },
      ordenacao: { temImpacto: false, excessoReais: null, distanciaLimitePp: null },
    },
    manutencao: null,
  };
}

/**
 * Divergência entre a data ADMINISTRATIVA da troca de modelo logístico e o
 * comportamento dos próprios dados financeiros (ver
 * dashboardExecutivo.confiabilidade.js#detectarDivergenciaTransicao — caso
 * real Subway Feiraguay, 2026-09-22: Taxas de Entregadores parou de acumular
 * em 18/09, mas a troca só foi registrada a partir de 20/09).
 *
 * REGRA DE OURO reforçada aqui: NUNCA sugere corrigir a vigência sozinho —
 * só descreve o desvio encontrado, sempre como ATENÇÃO (nunca crítico: é uma
 * possibilidade a verificar, não um problema financeiro confirmado).
 * @param {{divergente:boolean, dataMudancaOperacional:string|null, diasDeDivergencia:number|null, vigenciaInicio:string}|null} divergencia
 */
function analisarDivergenciaTransicao(divergencia) {
  if (!divergencia?.divergente) return null;
  const dataOp = fmtDataBrCurta(divergencia.dataMudancaOperacional);
  const dataAdm = fmtDataBrCurta(divergencia.vigenciaInicio);
  const explicacao = `Os dados financeiros apresentam mudança de comportamento a partir de ${dataOp}, `
    + `${divergencia.diasDeDivergencia} dia(s) antes da data registrada para a alteração do modelo logístico (${dataAdm}). `
    + "Verifique se a operação no novo modelo começou efetivamente antes da data cadastrada.";
  return {
    achado: {
      id: "divergencia_transicao_modelo", categoria: "dados", severidade: "atencao",
      titulo: "Possível divergência na data de transição operacional",
      descricao: explicacao,
      metricas: { dataMudancaOperacional: divergencia.dataMudancaOperacional, vigenciaRegistrada: divergencia.vigenciaInicio, diasDeDivergencia: divergencia.diasDeDivergencia },
    },
    acao: {
      diagnosticoId: "divergencia_transicao_modelo",
      tipo: "DATA_PENDING",
      categoria: "dados",
      titulo: "Confirmar a data efetiva da mudança de modelo",
      situacao: `Comportamento mudou em ${dataOp}, vigência registrada em ${dataAdm}`,
      meta: null,
      diferenca: null,
      impacto: null,
      explicacao,
      acaoRecomendada: "Se a mudança para o novo modelo realmente começou antes, registre a vigência correta em Modelo Logístico (\"Informar quando o modelo atual começou\"). A vigência atual NÃO é alterada automaticamente.",
      objetivo: { proximo: "confirmar a data efetiva da transição", ideal: null },
      descricao: explicacao,
      cta: { label: "Ver Modelo Logístico", aba: "visao-geral" },
      ordenacao: { temImpacto: false, excessoReais: null, distanciaLimitePp: null },
    },
    manutencao: null,
  };
}

const ROTULO_MODELO_DIAG = { marketplace: "Marketplace", full_service: "Full Service" };

// Indicadores comparáveis entre regimes e se "maior é pior" (dedução) ou
// "maior é melhor" (receita) — decide se a diferença é ponto forte ou atenção.
const COMPARATIVO_INDICADORES = [
  { chave: "taxas_comissoes", campo: "taxasComissoes", rotulo: "Taxas e Comissões", maiorEhPior: true },
  { chave: "servicos_promocoes", campo: "servicosPromocoes", rotulo: "Serviços e Promoções", maiorEhPior: true },
  { chave: "taxas_entregadores", campo: "taxasEntregadores", rotulo: "Taxas de Entregadores", maiorEhPior: true },
  { chave: "total_deducoes", campo: "totalDeducoes", rotulo: "Total de Deduções", maiorEhPior: true },
  { chave: "receita_liquida", campo: "receitaLiquida", rotulo: "Receita Líquida", maiorEhPior: false },
];

/**
 * Comparativo Marketplace × Full Service — compara o PRIMEIRO e o ÚLTIMO
 * segmento do período (o caso comum: uma troca, dois regimes). Cada
 * indicador só é comparado quando os DOIS lados estão conciliados (percentual
 * sobre o faturamento do PRÓPRIO regime) — nunca compara um lado suspeito, e
 * nunca gera "alerta de ausência" para um componente 'nao_aplicavel' (regra
 * C: Entregadores em Full Service simplesmente não entra na comparação).
 *
 * REGRA DE OURO (reforçada): "após a transição" / "no período X", NUNCA
 * "X causou Y" — o texto descreve o desvio, não afirma causalidade.
 *
 * AMOSTRA PEQUENA: reusa o limiar de `LIMIARES_DIAGNOSTICO` (mesma régua de
 * "poucos dias" da confiabilidade, nunca um motor paralelo) — um regime com
 * menos de `diasSegmentoParaAmostraPequena` dias no período ainda mostra os
 * números, mas o achado avisa que a base é inicial.
 * @param {Array<{modelo:string, diasComDados:number, percentuais:Record<string,{valor:number|null,status:string}>}>|null} comparativoSegmentos
 * @returns {Array<{achado:object, acao:null, manutencao:null}>}
 */
function analisarComparativoSegmentos(comparativoSegmentos) {
  if (!comparativoSegmentos || comparativoSegmentos.length < 2) return [];
  const primeiro = comparativoSegmentos[0];
  const ultimo = comparativoSegmentos[comparativoSegmentos.length - 1];
  if (primeiro.modelo === ultimo.modelo) return [];
  const L = LIMIARES_DIAGNOSTICO;
  const amostraPequena = (seg) => seg.diasComDados > 0 && seg.diasComDados < L.diasSegmentoParaAmostraPequena;
  const rotuloA = ROTULO_MODELO_DIAG[primeiro.modelo] ?? primeiro.modelo;
  const rotuloB = ROTULO_MODELO_DIAG[ultimo.modelo] ?? ultimo.modelo;

  const resultados = [];
  for (const { chave, campo, rotulo, maiorEhPior } of COMPARATIVO_INDICADORES) {
    const pA = primeiro.percentuais?.[campo];
    const pB = ultimo.percentuais?.[campo];
    if (!pA || !pB || pA.status !== "conciliado" || pB.status !== "conciliado" || pA.valor == null || pB.valor == null) continue;
    const diffPp = pB.valor - pA.valor;
    if (Math.abs(diffPp) < 0.05) continue; // praticamente igual — não vira achado

    const pioroou = maiorEhPior ? diffPp > 0 : diffPp < 0;
    const amostraTexto = (() => {
      const partes = [];
      if (amostraPequena(primeiro)) partes.push(`${rotuloA} tem ${primeiro.diasComDados} dia(s)`);
      if (amostraPequena(ultimo)) partes.push(`${rotuloB} tem ${ultimo.diasComDados} dia(s)`);
      if (!partes.length) return "";
      return ` Amostra inicial: ${partes.join(" e ")} no período — os números já podem ser acompanhados, mas ainda não há base suficiente para concluir uma tendência.`;
    })();
    const descricao = `Após a transição de ${rotuloA} para ${rotuloB}, ${rotulo} passou de ${fmtPct1(pA.valor)} para ${fmtPct1(pB.valor)} `
      + `(${diffPp > 0 ? "+" : ""}${fmtPp1(diffPp)}).${amostraTexto}`;

    resultados.push({
      achado: {
        id: `comparativo_${chave}`, categoria: chave, severidade: pioroou ? "atencao" : "forte",
        titulo: `${rotulo}: ${rotuloA} × ${rotuloB}`,
        descricao,
        metricas: {
          modeloAnterior: primeiro.modelo, modeloAtual: ultimo.modelo,
          percentualAnterior: pA.valor, percentualAtual: pB.valor, diferencaPp: diffPp,
          amostraPequenaAnterior: amostraPequena(primeiro), amostraPequenaAtual: amostraPequena(ultimo),
        },
      },
      acao: null,
      manutencao: null,
    });
  }
  return resultados;
}

// ---------------------------------------------------------------------------
// PRIORIDADE DO PLANO DE AÇÃO — única regra de ordenação, nunca duplicada.
//   1. CRITICAL  (financeiro acima do limite / queda forte)
//   2. WARNING   (financeiro acima da meta ideal)
//   3. DATA_PENDING (pendências que comprometem a confiabilidade)
//   4. (reservado)
// HEALTHY não entra em `acoes` — vai para `manutencao`, com estrutura própria.
// Desempate DENTRO de um mesmo nível (só com dados que já existem):
//   a) tem impacto financeiro conhecido antes de não tem;
//   b) maior excesso financeiro em R$;
//   c) maior `atual - limite` (mais acima / mais perto de estourar o limite);
//   d) ordem estável dos analisadores (Array.sort é estável no Node).
// ---------------------------------------------------------------------------
function prioridadeDe(achado) {
  if (achado.categoria === "dados") return 3;
  if (achado.severidade === "alerta") return 1;
  if (achado.severidade === "atencao") return 2;
  return 4;
}

function ordenarAcoes(acoes) {
  return acoes.sort((a, b) =>
    a.prioridade - b.prioridade
    || Number(b.ordenacao?.temImpacto) - Number(a.ordenacao?.temImpacto)
    || (b.ordenacao?.excessoReais ?? -Infinity) - (a.ordenacao?.excessoReais ?? -Infinity)
    || (b.ordenacao?.distanciaLimitePp ?? -Infinity) - (a.ordenacao?.distanciaLimitePp ?? -Infinity));
}

// ---------------------------------------------------------------------------
// RESUMO OPERACIONAL — determinístico, montado por template a partir dos
// achados. NUNCA usa IA. NUNCA afirma "operação excelente" com confiabilidade
// baixa (ver item 13 do pedido).
// ---------------------------------------------------------------------------
function rotulosDe(achados) {
  return achados.filter((a) => a.categoria !== "dados").map((a) => ROTULO_ACHADO[a.categoria] ?? a.categoria);
}
const listar = (arr) => (arr.length ? ` (${arr.join(", ")})` : "");

function montarResumo({ alertas, pontosAtencao, manutencao, confiabilidade }) {
  const listaCriticos = rotulosDe(alertas);
  const listaAtencao = rotulosDe(pontosAtencao);
  const listaSaudaveis = manutencao.map((m) => ROTULO_ACHADO[m.categoria] ?? m.categoria);
  const dadosPendentes = [...alertas, ...pontosAtencao].filter((a) => a.categoria === "dados").length;

  const criticos = listaCriticos.length;
  const atencoes = listaAtencao.length;
  const saudaveis = listaSaudaveis.length;
  const contadores = { criticos, atencoes, saudaveis, dadosPendentes };

  const confFraca = confiabilidade.nivel === "baixa" || confiabilidade.nivel === "indisponivel";
  const notaPendencias = dadosPendentes > 0
    ? ` Há ${dadosPendentes} pendência(s) de dados que podem alterar médias, projeções e comparações do mês.`
    : "";

  let estado, manchete, texto;
  if (criticos > 0) {
    estado = "CRITICO";
    manchete = "Operação com pontos críticos";
    texto = `${criticos} indicador(es) ultrapassou(aram) o limite${listar(listaCriticos)}.`;
    if (atencoes > 0) texto += ` Outro(s) ${atencoes} está(ão) acima da faixa ideal${listar(listaAtencao)}.`;
    texto += saudaveis > 0
      ? ` A prioridade é atuar nesses pontos sem comprometer o que já está sob controle${listar(listaSaudaveis)}.`
      : " A prioridade é atuar nesses pontos.";
    texto += notaPendencias;
  } else if (atencoes > 0) {
    estado = "ATENCAO";
    manchete = "Operação requer atenção";
    texto = `Nenhum indicador crítico no período. ${atencoes} indicador(es) saiu(íram) da faixa ideal${listar(listaAtencao)}, mas segue(m) dentro do limite.`;
    texto += saudaveis > 0
      ? ` O foco é evitar que avancem para o limite e preservar o que está saudável${listar(listaSaudaveis)}.`
      : " O foco é evitar que avancem para o limite.";
    texto += notaPendencias;
  } else if (saudaveis > 0 && !confFraca) {
    estado = "SAUDAVEL";
    manchete = "Operação saudável";
    texto = `Nenhum indicador crítico ou de atenção foi identificado com os dados disponíveis. O foco neste momento é preservar os resultados atuais${listar(listaSaudaveis)}.`;
    texto += notaPendencias;
  } else {
    estado = "DADOS_INSUFICIENTES";
    manchete = "Leitura ainda não conclusiva";
    texto = saudaveis > 0
      ? `Os indicadores disponíveis estão dentro dos parâmetros, mas há limitações nos dados do período (${confiabilidade.motivo}) que podem alterar a leitura quando forem regularizados.`
      : `Ainda não há dados suficientes neste mês para uma leitura conclusiva do Plano de Ação.`;
  }

  return { estado, manchete, contadores, texto };
}

// ---------------------------------------------------------------------------
// MOTOR CENTRAL
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   indicadores: Record<string, {atual: number|null, valor: number|null, meta: {metaIdeal:number,limite:number}|null, saldo: object|null, naoAplicavel: boolean}>,
 *   faturamentoBase: number|null,
 *   diasComDados: number,
 *   diasPendentes: number,
 *   diasPendentesDatas: string[],
 *   diasEstimados: number,
 *   comparativo: object|null,
 *   recuperacao: object|null,
 *   divergenciaTransicao: {divergente:boolean, dataMudancaOperacional:string|null, diasDeDivergencia:number|null, vigenciaInicio:string}|null,
 *   indicadoresPorSegmento: Array<{modelo:string, rotulo:string, diasComDados:number, faturamentoBase:number|null, indicadores: Record<string, {atual:number|null,valor:number|null,meta:object|null,saldo:object|null,naoAplicavel:boolean}>}>|null,
 *   comparativoSegmentos: Array<{modelo:string, diasComDados:number, percentuais:Record<string,{valor:number|null,status:string}>}>|null,
 * }} input
 */
export function gerarDiagnostico(input) {
  const {
    indicadores, faturamentoBase, diasComDados, diasPendentes, diasPendentesDatas, diasEstimados, comparativo, recuperacao,
    divergenciaTransicao = null, indicadoresPorSegmento = null, comparativoSegmentos = null,
  } = input;

  if (!diasComDados) {
    return {
      pontosFortes: [], pontosAtencao: [], alertas: [], acoes: [], manutencao: [],
      semDadosSuficientes: true,
      confiabilidade: confiabilidadeDados({ diasComDados: 0, diasPendentes, diasEstimados }),
      resumo: {
        estado: "DADOS_INSUFICIENTES",
        manchete: "Ainda sem dados neste mês",
        contadores: { criticos: 0, atencoes: 0, saudaveis: 0, dadosPendentes: 0 },
        texto: "Ainda não há lançamentos suficientes neste mês para gerar um plano de ação.",
      },
    };
  }

  const componentesDeducao = [
    { chave: "taxas_comissoes", rotulo: "Taxas e Comissões", percentual: indicadores.taxas_comissoes?.atual ?? null },
    { chave: "servicos_promocoes", rotulo: "Serviços e Promoções", percentual: indicadores.servicos_promocoes?.atual ?? null },
    { chave: "taxas_entregadores", rotulo: "Taxas de Entregadores", percentual: indicadores.taxas_entregadores?.atual ?? null },
  ];

  // Lista de analisadores — adicionar um novo diagnóstico é adicionar uma
  // entrada aqui, sem tocar no resto do motor (ver cabeçalho do arquivo).
  const ANALISADORES = [
    () => analisarIndicadorPercentual("taxas_comissoes", indicadores.taxas_comissoes, faturamentoBase),
    () => analisarIndicadorPercentual("servicos_promocoes", indicadores.servicos_promocoes, faturamentoBase),
    () => analisarIndicadorPercentual("taxas_entregadores", indicadores.taxas_entregadores, faturamentoBase),
    () => analisarTotalDeducoes(indicadores.total_deducoes, componentesDeducao, faturamentoBase),
    () => analisarFaturamento(comparativo, recuperacao),
    () => analisarDiasPendentes(diasPendentes, diasPendentesDatas),
    () => analisarDetalhamentoAusente(indicadores),
    () => analisarDivergenciaTransicao(divergenciaTransicao),
  ];

  // PERÍODO MISTO: Plano de Ação SEGMENTADO (item do pedido — um problema que
  // existe SÓ num regime não pode virar recomendação genérica do mês
  // inteiro). Reusa OS MESMOS analisadores, uma vez por segmento, com
  // `contexto` só pra não colidir id/título com o achado consolidado — nenhuma
  // fórmula nova. Também o comparativo Marketplace × Full Service (achados
  // "forte"/"atenção", sem ação própria — as ações vêm dos itens acima).
  if (indicadoresPorSegmento) {
    for (const seg of indicadoresPorSegmento) {
      const contexto = { sufixoId: seg.modelo, rotuloPrefixo: seg.rotulo };
      const faturamentoSeg = seg.faturamentoBase ?? null;
      const componentesDeducaoSeg = [
        { chave: "taxas_comissoes", rotulo: `Taxas e Comissões — ${seg.rotulo}`, percentual: seg.indicadores.taxas_comissoes?.atual ?? null },
        { chave: "servicos_promocoes", rotulo: `Serviços e Promoções — ${seg.rotulo}`, percentual: seg.indicadores.servicos_promocoes?.atual ?? null },
        { chave: "taxas_entregadores", rotulo: `Taxas de Entregadores — ${seg.rotulo}`, percentual: seg.indicadores.taxas_entregadores?.atual ?? null },
      ];
      ANALISADORES.push(
        () => analisarIndicadorPercentual("taxas_comissoes", seg.indicadores.taxas_comissoes, faturamentoSeg, contexto),
        () => analisarIndicadorPercentual("servicos_promocoes", seg.indicadores.servicos_promocoes, faturamentoSeg, contexto),
        () => analisarIndicadorPercentual("taxas_entregadores", seg.indicadores.taxas_entregadores, faturamentoSeg, contexto),
        () => analisarTotalDeducoes(seg.indicadores.total_deducoes, componentesDeducaoSeg, faturamentoSeg, contexto),
      );
    }
  }
  for (const resultado of analisarComparativoSegmentos(comparativoSegmentos)) ANALISADORES.push(() => resultado);

  const pontosFortes = [], pontosAtencao = [], alertas = [], acoes = [], manutencao = [];
  for (const analisar of ANALISADORES) {
    const resultado = analisar();
    if (!resultado) continue;
    const { achado, acao, manutencao: item } = resultado;
    if (achado.severidade === "forte") pontosFortes.push(achado);
    else if (achado.severidade === "atencao") pontosAtencao.push(achado);
    else alertas.push(achado);
    if (acao) acoes.push({ ...acao, prioridade: prioridadeDe(achado) });
    if (item) manutencao.push(item);
  }

  ordenarAcoes(acoes);
  // Manutenção: mais perto do teto primeiro (menor folga = acompanhar de perto).
  manutencao.sort((a, b) => (a.diferenca?.pp ?? Infinity) - (b.diferenca?.pp ?? Infinity));

  const confiabilidade = confiabilidadeDados({ diasComDados, diasPendentes, diasEstimados });

  return {
    pontosFortes, pontosAtencao, alertas, acoes, manutencao,
    semDadosSuficientes: false,
    confiabilidade,
    resumo: montarResumo({ alertas, pontosAtencao, manutencao, confiabilidade }),
  };
}
