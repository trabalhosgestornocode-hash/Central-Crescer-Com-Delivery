// CONCILIAÇÃO DO PERÍODO + COMPARATIVO Marketplace × Full Service — helpers
// PUROS (sem DOM, sem API). Consome exatamente o que o backend já expõe em
// período misto: `d.modeloPeriodo.conciliacao` (segmentos + consolidado,
// granular por campo — ver dashboardExecutivo.confiabilidade.js) e
// `d.comparativoSegmentos` (financeiro reconciliado + operacional por
// regime — ver dashboardExecutivo.service.js#operacionalPorSegmento).
//
// PRINCÍPIO (igual ao backend): um registro `{valor, status, ultimoValorValido}`
// só vira um NÚMERO quando `status === 'conciliado'`. Fora disso, o máximo que
// se mostra é o `ultimoValorValido` como CONTEXTO/EVIDÊNCIA — nunca rotulado
// como "oficial". `nao_aplicavel` é um estado semântico próprio (nunca "0%"
// nem "Dados insuficientes").
import { fmtMoeda, fmtPct, temValor } from "./utils.js";
import { fmtPp } from "./dashboardExecutivoPlano.js";
import { ROTULO_MODELO, fmtDataCompleta, fmtDiaMes } from "./dashboardExecutivoModelo.js";

export const STATUS_ROTULO = {
  suspeito: "Conciliação pendente",
  nao_conciliavel: "Não conciliável",
  nao_aplicavel: "Não aplicável",
  sem_dado: "Sem dado",
};
export const STATUS_CLASSE = {
  conciliado: "ok", suspeito: "warn", nao_conciliavel: "bad", nao_aplicavel: "muted", sem_dado: "muted",
};

/**
 * Badge discreto de status — `null` quando 'conciliado' (não polui a UI com
 * um selo "ok" em todo campo saudável; só aparece quando há algo a dizer).
 * @param {string|undefined} status
 * @returns {{classe:string, label:string}|null}
 */
export function badgeStatus(status) {
  if (!status || status === "conciliado") return null;
  return { classe: STATUS_CLASSE[status] ?? "muted", label: STATUS_ROTULO[status] ?? status };
}

/**
 * Um registro `{valor, status, ultimoValorValido}` -> o que mostrar. NUNCA
 * apresenta `ultimoValorValido` como se fosse o valor confirmado — vira um
 * texto de CONTEXTO separado, com a badge de status ao lado.
 * @param {{valor:number|null, status:string, ultimoValorValido:{valor:number,data:string}|null}|null|undefined} registro
 * @param {(v:number|null)=>string} formatar fmtMoeda ou fmtPct
 * @returns {{texto:string, contexto:string|null, badge:{classe:string,label:string}|null}}
 */
export function valorDoRegistro(registro, formatar = fmtMoeda) {
  if (!registro) return { texto: "—", contexto: null, badge: null };
  if (registro.status === "nao_aplicavel") return { texto: "Não aplicável", contexto: null, badge: null };
  if (registro.status === "conciliado") return { texto: formatar(registro.valor), contexto: null, badge: null };
  const contexto = registro.ultimoValorValido
    ? `Último valor confiável: ${formatar(registro.ultimoValorValido.valor)} em ${fmtDataCompleta(registro.ultimoValorValido.data)}`
    : null;
  return { texto: "—", contexto, badge: badgeStatus(registro.status) };
}

/** Atalho de `valorDoRegistro` pra percentuais (fmtPct em vez de fmtMoeda). */
export const percentualDoRegistro = (registro) => valorDoRegistro(registro, fmtPct);

/**
 * Diferença em PONTOS PERCENTUAIS — para indicadores que já são percentuais
 * (Taxas, Serviços, Deduções, Receita Líquida %). Nunca chamar isso de "%".
 * @param {number|null} de @param {number|null} para
 * @returns {{diff:number, texto:string}|null}
 */
export function variacaoPp(de, para) {
  if (de == null || para == null) return null;
  const diff = para - de;
  return { diff, texto: `${diff > 0 ? "+" : ""}${fmtPp(diff)}` };
}

/**
 * Variação RELATIVA (%) — para valores em R$ ou médias (Ticket Médio,
 * Faturamento médio/dia, Pedidos médios/dia). Nunca usar pontos percentuais aqui.
 * @param {number|null} de @param {number|null} para
 * @returns {{pct:number, texto:string}|null}
 */
export function variacaoRelativa(de, para) {
  if (de == null || para == null || de === 0) return null;
  const pct = ((para - de) / Math.abs(de)) * 100;
  return { pct, texto: `${pct > 0 ? "+" : ""}${fmtPct(pct)}` };
}

/**
 * Média por dia — nunca inventa se não houver dias (evita comparar
 * faturamento absoluto de períodos com quantidades diferentes de dias).
 * @param {number|null} total @param {number} dias
 */
export function mediaPorDia(total, dias) {
  if (total == null || !dias) return null;
  return total / dias;
}

/** "01/09 a 12/09" — intervalo do segmento dentro do período consultado (sempre com fim, mesmo no regime em aberto: é o fim do PERÍODO, não do regime). */
export function fmtIntervalo(inicio, fim) {
  return `${fmtDiaMes(inicio)} a ${fmtDiaMes(fim)}`;
}

/**
 * Monta a estrutura pronta pra Conciliação do Período: um bloco por
 * segmento + o bloco Consolidado. Cada campo já vem como
 * `{texto, contexto, badge}` (ver `valorDoRegistro`), pronto pra HTML.
 * @param {Array<object>} comparativoSegmentos (`d.comparativoSegmentos`)
 * @param {object} consolidado (`d.modeloPeriodo.conciliacao.consolidado`)
 */
export function montarConciliacao(comparativoSegmentos, consolidado) {
  if (!comparativoSegmentos?.length || !consolidado) return null;
  const blocoSegmento = (seg) => {
    const fin = seg.financeiro;
    return {
      modelo: seg.modelo, rotulo: ROTULO_MODELO[seg.modelo] ?? seg.modelo,
      intervalo: fmtIntervalo(seg.inicio, seg.fim),
      faturamento: valorDoRegistro(fin.campos.valorVendasIfood),
      taxasComissoes: { valor: valorDoRegistro(fin.campos.taxasComissoes), percentual: percentualDoRegistro(seg.percentuais.taxasComissoes) },
      servicosPromocoes: { valor: valorDoRegistro(fin.campos.servicosPromocoes), percentual: percentualDoRegistro(seg.percentuais.servicosPromocoes) },
      taxasEntregadores: { valor: valorDoRegistro(fin.campos.taxasEntregadores), percentual: percentualDoRegistro(seg.percentuais.taxasEntregadores) },
      totalDeducoes: { valor: valorDoRegistro(fin.totalDeducoes), percentual: percentualDoRegistro(seg.percentuais.totalDeducoes) },
      receitaLiquida: { valor: valorDoRegistro(fin.receitaLiquida), percentual: percentualDoRegistro(seg.percentuais.receitaLiquida) },
    };
  };
  return {
    segmentos: comparativoSegmentos.map(blocoSegmento),
    consolidado: {
      faturamento: valorDoRegistro(consolidado.campos.valorVendasIfood),
      deducoes: valorDoRegistro(consolidado.totalDeducoes),
      deducoesPercentual: consolidado.campos.valorVendasIfood.status === "conciliado" && consolidado.totalDeducoes.status === "conciliado"
        ? { texto: fmtPct((consolidado.totalDeducoes.valor / consolidado.campos.valorVendasIfood.valor) * 100), contexto: null, badge: null }
        : { texto: "—", contexto: null, badge: badgeStatus(consolidado.totalDeducoes.status !== "conciliado" ? consolidado.totalDeducoes.status : consolidado.campos.valorVendasIfood.status) },
      receitaLiquida: valorDoRegistro(consolidado.receitaLiquida),
    },
  };
}

// Indicadores comparáveis (mesma ordem da tabela sugerida no pedido).
const INDICADORES_COMPARATIVO = [
  { chave: "taxasComissoes", rotulo: "Taxas e Comissões", tipo: "pct" },
  { chave: "servicosPromocoes", rotulo: "Serviços e Promoções", tipo: "pct" },
  { chave: "taxasEntregadores", rotulo: "Taxas de Entregadores", tipo: "pct" },
  { chave: "totalDeducoes", rotulo: "Total de Deduções", tipo: "pct" },
  { chave: "receitaLiquida", rotulo: "Receita Líquida", tipo: "pct" },
];

/**
 * Linhas da tabela Comparativo Marketplace × Full Service — só compara o
 * PRIMEIRO e o ÚLTIMO segmento (o caso comum: uma troca, dois regimes).
 * Um indicador só vira LINHA quando os DOIS lados estão 'conciliado' — uma
 * comparação com um lado "—" não compara nada (esse fato já aparece na
 * Conciliação do Período); 'nao_aplicavel' num dos lados também não entra
 * aqui (não é "N/A vs N/A", é fora de escopo da comparação).
 * @param {Array<object>} comparativoSegmentos
 */
export function linhasComparativoIndicadores(comparativoSegmentos) {
  if (!comparativoSegmentos || comparativoSegmentos.length < 2) return [];
  const a = comparativoSegmentos[0];
  const b = comparativoSegmentos[comparativoSegmentos.length - 1];
  const linhas = [];
  for (const { chave, rotulo } of INDICADORES_COMPARATIVO) {
    const ra = a.percentuais[chave];
    const rb = b.percentuais[chave];
    if (ra.status !== "conciliado" || rb.status !== "conciliado") continue;
    const variacao = variacaoPp(ra.valor, rb.valor);
    linhas.push({ rotulo, a: percentualDoRegistro(ra), b: percentualDoRegistro(rb), variacaoTexto: variacao?.texto ?? "—" });
  }
  return linhas;
}

/**
 * Linhas OPERACIONAIS do comparativo (Ticket Médio, Pedidos, Novos Clientes,
 * Faturamento — com médias por dia). Nunca compara total absoluto sem
 * considerar a quantidade de dias de cada regime.
 * @param {Array<object>} comparativoSegmentos
 */
export function linhasComparativoOperacional(comparativoSegmentos) {
  if (!comparativoSegmentos || comparativoSegmentos.length < 2) return [];
  const a = comparativoSegmentos[0];
  const b = comparativoSegmentos[comparativoSegmentos.length - 1];
  // Todas as linhas aqui são valores/médias (nunca percentuais) — a
  // variação é SEMPRE relativa (%), nunca pontos percentuais (esses só
  // existem em `linhasComparativoIndicadores`, acima).
  const linha = (rotulo, va, vb, formatar) => {
    const variacao = variacaoRelativa(va, vb);
    return { rotulo, a: temValor(va) ? formatar(va) : "—", b: temValor(vb) ? formatar(vb) : "—", variacaoTexto: variacao?.texto ?? "—" };
  };
  const diasA = a.diasComDados || null;
  const diasB = b.diasComDados || null;
  return [
    linha("Faturamento (Desempenho)", a.valorVendasBruto, b.valorVendasBruto, fmtMoeda),
    linha("Faturamento médio/dia", mediaPorDia(a.valorVendasBruto, diasA), mediaPorDia(b.valorVendasBruto, diasB), fmtMoeda),
    linha("Pedidos", a.qtdVendas, b.qtdVendas, (v) => String(v)),
    linha("Pedidos médios/dia", mediaPorDia(a.qtdVendas, diasA), mediaPorDia(b.qtdVendas, diasB), (v) => v.toFixed(1)),
    linha("Ticket médio", a.ticketMedio, b.ticketMedio, fmtMoeda),
    linha("Novos clientes", a.novosClientes, b.novosClientes, (v) => String(v)),
    linha("Novos clientes médios/dia", mediaPorDia(a.novosClientes, diasA), mediaPorDia(b.novosClientes, diasB), (v) => v.toFixed(1)),
  ].filter((l) => l.a !== "—" || l.b !== "—");
}

/**
 * Nota de amostra pequena por regime — mesmo texto do Diagnóstico (não
 * duplica o critério, só reaproveita `diasComDados` que o backend já
 * calcula). `limiar` é passado por quem chama (mesmo valor de
 * LIMIARES_DIAGNOSTICO.diasSegmentoParaAmostraPequena — não hardcoda aqui).
 * @param {Array<object>} comparativoSegmentos @param {number} limiar
 */
export function notaAmostraPequena(comparativoSegmentos, limiar) {
  if (!comparativoSegmentos?.length) return null;
  const pequenos = comparativoSegmentos.filter((s) => s.diasComDados > 0 && s.diasComDados < limiar);
  if (!pequenos.length) return null;
  const partes = pequenos.map((s) => `${ROTULO_MODELO[s.modelo] ?? s.modelo} tem ${s.diasComDados} dia(s)`);
  return `Amostra inicial: ${partes.join(" e ")} no período — os números já podem ser acompanhados, mas ainda não há base suficiente para concluir uma tendência.`;
}
