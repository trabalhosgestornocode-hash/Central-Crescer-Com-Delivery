// Metas e limiares da Central de Performance — FONTE ÚNICA. Nada de "20", "7"
// ou "10" espalhado pelo controller/frontend; nenhuma persistência. A camada
// de análise (performance.analysis.js) lê tudo daqui. Estrutura preparada
// para, no futuro, estas metas virem do Painel Administrativo; nesta etapa
// ficam centralizadas no backend, com override opcional por variável de ambiente.
import { numero, variacao } from './performance.calc.js';

// Limiares de classificação de tendência. Documentados e centralizados de
// propósito: a preferência é sempre a comparação histórica da própria unidade
// (primeiro mês x último, mês a mês, sequência), e não um corte absoluto de
// mercado. Todos em % (variação) ou p.p. (pontos percentuais de um indicador
// que já é percentual, como custo/faturamento ou retenção).
export const LIMIARES = {
  // Faturamento e novos clientes — variação percentual do próprio histórico.
  quedaAcumuladaPct: -5,        // <= -5% no acumulado do período => QUEDA
  quedaForteAcumuladaPct: -20,  // <= -20% no acumulado => QUEDA FORTE
  quedaForteMensalPct: -15,     // <= -15% no último mês a mês => QUEDA FORTE
  crescimentoAcumuladaPct: 7,   // >= meta mínima de crescimento => CRESCIMENTO
  clientesQuedaAcumuladaPct: -5,
  // Margem após iFood (retenção %). Diferença em p.p. entre 1º e último mês.
  margemPp: 1.5,                // |Δ| < 1.5 p.p. => ESTÁVEL
  // Custos iFood (deduções/faturamento %). Deterioração por p.p. e por
  // descolamento entre a variação das despesas e a do faturamento.
  custoIfoodPp: 1.5,
  custoDescolamentoPct: 5,      // (Δ% despesas - Δ% faturamento) >= 5 => pressão
  custoDescolamentoFortePct: 15,
  // Entregadores (custo/faturamento % e custo por pedido). Tendência, nunca um
  // único mês. Faixas em p.p. do percentual sobre faturamento.
  entregadoresAcompanharPp: 0.5,
  entregadoresCorrecaoPp: 2,
  // Conversão: gap em p.p. contra a meta mínima antes de escalar de ATENÇÃO.
  conversaoCriticaPp: 5,
  // Amostragem mínima para arriscar uma classificação de tendência.
  minPontos: 2,
};

const metaFinita = (v, nome, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${nome} inválida`);
  return n;
};

/** Metas centralizadas, com override opcional por ambiente. */
export function configuracaoMetas(env = process.env) {
  const conversaoMinima = metaFinita(env.PERFORMANCE_META_CONVERSAO ?? env.PERFORMANCE_CONVERSAO_REFERENCIA ?? 20, 'PERFORMANCE_META_CONVERSAO', 0, 100);
  const crescimentoMinimo = metaFinita(env.PERFORMANCE_META_CRESCIMENTO_MIN ?? 7, 'PERFORMANCE_META_CRESCIMENTO_MIN', 0, 100);
  const crescimentoDesejado = metaFinita(env.PERFORMANCE_META_CRESCIMENTO_DESEJADO ?? 10, 'PERFORMANCE_META_CRESCIMENTO_DESEJADO', 0, 100);
  if (crescimentoDesejado < crescimentoMinimo) throw new Error('Meta de crescimento desejada menor que a mínima');
  return { conversaoMinima, crescimentoMinimo, crescimentoDesejado,
    limiares: { ...LIMIARES, crescimentoAcumuladaPct: crescimentoMinimo } };
}

/**
 * Meta de faturamento do próximo mês a partir do último mês com base válida.
 * Retorna null quando não há faturamento > 0 (não inventa meta sobre lacuna).
 */
export function metasFaturamento(faturamentoAtual, metas) {
  const atual = numero(faturamentoAtual);
  if (atual == null || atual <= 0) return null;
  const metaMinima = numero(atual * (1 + metas.crescimentoMinimo / 100));
  const metaDesejada = numero(atual * (1 + metas.crescimentoDesejado / 100));
  return { atual, metaMinima, metaDesejada,
    faltaMinima: numero(metaMinima - atual), faltaDesejada: numero(metaDesejada - atual),
    percentualNecessarioMinimo: metas.crescimentoMinimo, percentualNecessarioDesejado: metas.crescimentoDesejado };
}

/**
 * Situação da conversão de uma competência contra a meta mínima.
 * Nunca consolida vários meses (sem denominador de visitas); é sempre pontual.
 */
export function metaConversao(conversaoAtual, metas) {
  const atual = numero(conversaoAtual);
  const meta = metas.conversaoMinima;
  if (atual == null) return { atual: null, meta, gapPp: null, status: 'SEM DADOS' };
  const gapPp = numero(atual - meta);
  return { atual, meta, gapPp, status: gapPp >= 0 ? 'DENTRO DA META' : 'ABAIXO DA META' };
}

/** Variação percentual necessária para sair de `de` e chegar a `para`. */
export const percentualNecessario = (de, para) => variacao(para, de);
