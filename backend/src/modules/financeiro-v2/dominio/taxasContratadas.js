// doc 35 — TAXAS CONTRATADAS do processador (Stone) por modalidade e bandeira, com vigência e fonte documental, e a
// CONFERÊNCIA transação a transação: taxa contratada × taxa efetivamente cobrada × líquido informado.
//
// Regras:
//   - a referência PRINCIPAL é o que a Stone informou por transação (taxa e líquido, em milionésimos de real); o contratado
//     serve para CONFERIR, nunca para substituir;
//   - cálculo individual por transação (bruto × percentual, arredondado ao centavo meio-para-cima) — nunca taxa média;
//   - modalidade sem taxa contratada fica SEM_TAXA_CONTRATADA (nunca 0%);
//   - crédito parcelado (o Açaí só vende à vista) vira divergência, sem descartar nem mudar o valor;
//   - totais em duas leituras: soma EXATA dos milionésimos (arredondada uma vez) e soma das taxas arredondadas por
//     transação — a diferença entre as duas é fração de centavo, mostrada explicitamente.
import { CODIGO, falhar } from "./erros.js";
import { exigirData } from "./tempo.js";
import { exigirLista, exigirTexto, semCamposDesconhecidos } from "./validacao.js";

export const MODALIDADE_TAXA = Object.freeze({ DEBITO: "DEBITO", CREDITO_A_VISTA: "CREDITO_A_VISTA", PIX: "PIX" });
const BANDEIRAS = [["MASTERCARD", ["MASTERCARD", "MASTER"]], ["VISA", ["VISA"]], ["ELO", ["ELO"]], ["AMEX", ["AMEX", "AMERICANEXPRESS"]],
  ["UNIONPAY", ["UNIONPAY"]], ["CABAL", ["CABAL"]], ["HIPERCARD", ["HIPERCARD"]], ["PIX", ["PIX"]]];
/** Nome da bandeira normalizado (sem espaço, acento ou caixa); desconhecida fica como veio (normalizada). */
export function bandeiraNormalizada(texto) {
  const t = String(texto ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return BANDEIRAS.find(([, nomes]) => nomes.includes(t))?.[0] ?? t;
}

/** Percentual "2,15" ou "2.15" → milésimos de ponto percentual inteiros (2,15% = 2150). Até 3 casas; 0 < p < 100. */
function percentualEmMilesimos(v, campo) {
  const s = String(v ?? "").trim().replace(",", ".");
  if (!/^\d{1,2}(\.\d{1,3})?$/.test(s)) falhar(CODIGO.ENTRADA_INVALIDA, `${campo}: percentual inválido (ex.: 2,15).`, { campo });
  const [i, d = ""] = s.split(".");
  const m = Number(i) * 1000 + Number(d.padEnd(3, "0"));
  if (m <= 0) falhar(CODIGO.ENTRADA_INVALIDA, `${campo}: percentual precisa ser maior que zero (modalidade sem taxa não entra na tabela).`, { campo });
  return m;
}

/** Tabela contratada: processador, vigência, fonte documental e as taxas por modalidade × bandeira (sem repetição). */
export function validarTabelaDeTaxas(e) {
  semCamposDesconhecidos(e, ["processador", "vigenciaInicio", "vigenciaFim", "fonte", "prazoDeRecebimento", "taxas", "justificativa"], "tabelaDeTaxas");
  const processador = exigirTexto(e.processador, "processador", { max: 30 }).toUpperCase();
  if (processador !== "STONE") falhar(CODIGO.ENTRADA_INVALIDA, "Por enquanto só a tabela da Stone.", { campo: "processador" });
  const vigenciaInicio = exigirData(e.vigenciaInicio, "vigenciaInicio");
  const vigenciaFim = e.vigenciaFim ? exigirData(e.vigenciaFim, "vigenciaFim") : null;
  if (vigenciaFim && vigenciaFim < vigenciaInicio) falhar(CODIGO.DATA_INVALIDA, "Fim da vigência antes do início.", { campo: "vigenciaFim" });
  const taxas = exigirLista(e.taxas, "taxas", { min: 1, max: 40 }).map((t, i) => {
    semCamposDesconhecidos(t, ["modalidade", "bandeira", "percentual"], `taxas[${i}]`);
    const modalidade = String(t.modalidade ?? "").toUpperCase();
    if (!MODALIDADE_TAXA[modalidade]) falhar(CODIGO.ENTRADA_INVALIDA, `taxas[${i}].modalidade: use DEBITO, CREDITO_A_VISTA ou PIX.`, { campo: `taxas[${i}].modalidade` });
    const bandeira = modalidade === "PIX" ? "PIX" : bandeiraNormalizada(exigirTexto(t.bandeira, `taxas[${i}].bandeira`, { max: 30 }));
    return { modalidade, bandeira, milesimos: percentualEmMilesimos(t.percentual, `taxas[${i}].percentual`) };
  });
  const chaves = taxas.map((t) => `${t.modalidade}|${t.bandeira}`);
  if (new Set(chaves).size !== chaves.length) falhar(CODIGO.ENTRADA_INVALIDA, "A mesma modalidade e bandeira aparece duas vezes.", { campo: "taxas" });
  return {
    processador, vigenciaInicio, vigenciaFim, fonte: exigirTexto(e.fonte, "fonte", { max: 300 }),
    prazoDeRecebimento: exigirTexto(e.prazoDeRecebimento, "prazoDeRecebimento", { max: 60, opcional: true }) ?? null, taxas,
    justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }),
  };
}

/** Linhas "DEBITO;MASTERCARD;2,15" (uma por linha) → taxas. Para o formulário. */
export function taxasDoTexto(texto) {
  return String(texto ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [modalidade, bandeira, percentual] = l.split(/[;\t]/).map((x) => x.trim());
    return { modalidade, bandeira: bandeira || "PIX", percentual };
  });
}

const vigente = (tabelas, processador, data) => tabelas.filter((t) => t.processador === processador && t.vigenciaInicio <= data && (!t.vigenciaFim || data <= t.vigenciaFim))
  .sort((a, b) => b.vigenciaInicio.localeCompare(a.vigenciaInicio))[0] ?? null;
/** Divisão inteira com arredondamento meio-para-cima (a, b ≥ 0). */
const divisaoArredondada = (a, b) => Math.floor((2 * a + b) / (2 * b));
/** Centavos a partir de milionésimos, meio-para-cima (valores não negativos). */
const centavosDe = (micros) => Math.floor((micros + 5000) / 10000);

/** Modalidade praticada a partir do produto e das parcelas do relatório Stone. */
export function modalidadeDaTransacao(d) {
  const produto = String(d.produto ?? "").toUpperCase();
  if (produto === "PIX") return { modalidade: "PIX", bandeira: "PIX" };
  const bandeira = bandeiraNormalizada(d.bandeira);
  if (produto === "DEBITO") return { modalidade: "DEBITO", bandeira };
  if (produto === "CREDITO") return { modalidade: Number(d.parcelas ?? 1) > 1 ? "CREDITO_PARCELADO" : "CREDITO_A_VISTA", bandeira };
  return { modalidade: produto || "DESCONHECIDA", bandeira };
}

/**
 * Conferência: transações do relatório (dados do leitor STONE_VENDAS) × tabelas contratadas vigentes na data.
 * @param {Array<{id:string, data:string, dados:object}>} transacoes
 * @param {Array<object>} tabelas
 */
export function conferirTaxas(transacoes, tabelas, { processador = "STONE" } = {}) {
  const itens = transacoes.map((t) => {
    const d = t.dados;
    const { modalidade, bandeira } = modalidadeDaTransacao(d);
    const tabela = vigente(tabelas, processador, t.data);
    const taxa = tabela?.taxas.find((x) => x.modalidade === modalidade && x.bandeira === bandeira) ?? null;
    const brutoMicros = d.brutoMicros ?? d.brutoCentavos * 10000;
    const cobradoMicros = d.descontoInformadoMicros ?? (d.taxaInformadaCentavos ?? 0) * 10000;
    const esperadoMicros = taxa ? divisaoArredondada(brutoMicros * taxa.milesimos, 100000) : null;
    const cobradoCentavos = centavosDe(cobradoMicros);
    const esperadoCentavos = esperadoMicros === null ? null : centavosDe(esperadoMicros);
    let situacao = "CONFERE";
    if (modalidade === "CREDITO_PARCELADO") situacao = "PARCELADA_A_CONFERIR";
    else if (!tabela) situacao = "SEM_TABELA_VIGENTE";
    else if (!taxa) situacao = "SEM_TAXA_CONTRATADA";
    else if (cobradoCentavos !== esperadoCentavos) situacao = "DIFERENTE_DO_CONTRATADO";
    return {
      id: t.id, data: t.data, modalidade, bandeira, bandeiraOriginal: d.bandeira ?? null, parcelas: d.parcelas ?? null, antecipada: Boolean(d.antecipada),
      brutoCentavos: centavosDe(brutoMicros), brutoMicros, cobradoMicros, cobradoCentavos, liquidoInformadoMicros: d.liquidoMicros ?? null,
      percentualContratado: taxa ? taxa.milesimos / 1000 : null, esperadoCentavos, liquidoEsperadoCentavos: esperadoCentavos === null ? null : centavosDe(brutoMicros) - esperadoCentavos,
      diferencaCentavos: esperadoCentavos === null ? null : cobradoCentavos - esperadoCentavos, situacao, tabelaVigencia: tabela?.vigenciaInicio ?? null,
    };
  });
  const somaMicros = (l, k) => l.reduce((s, x) => s + (x[k] ?? 0), 0);
  const brutoMicrosDe = (l) => l.reduce((s, x) => s + x.brutoMicros, 0);
  const resumo = (l) => ({
    transacoes: l.length, brutoCentavos: l.reduce((s, x) => s + x.brutoCentavos, 0),
    cobradoCentavos: centavosDe(somaMicros(l, "cobradoMicros")), cobradoArredondadoPorTransacaoCentavos: l.reduce((s, x) => s + x.cobradoCentavos, 0),
    liquidoInformadoCentavos: l.every((x) => x.liquidoInformadoMicros !== null) ? centavosDe(somaMicros(l, "liquidoInformadoMicros")) : null,
    esperadoCentavos: l.every((x) => x.esperadoCentavos !== null) ? l.reduce((s, x) => s + x.esperadoCentavos, 0) : null,
    // milésimos de ponto percentual, em inteiros (2,15% = 2150): cobrado ÷ bruto, arredondado meio-para-cima
    percentualEfetivoMilesimos: brutoMicrosDe(l) ? divisaoArredondada(somaMicros(l, "cobradoMicros") * 100000, brutoMicrosDe(l)) : null,
    porSituacao: l.reduce((a, x) => ({ ...a, [x.situacao]: (a[x.situacao] ?? 0) + 1 }), {}),
  });
  const grupos = new Map();
  for (const x of itens) {
    const k = `${x.modalidade}|${x.bandeira}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(x);
  }
  const composicao = [...grupos.entries()].map(([k, l]) => {
    const [modalidade, bandeira] = k.split("|");
    return { modalidade, bandeira, percentualContratado: l[0].percentualContratado, ...resumo(l) };
  }).sort((a, b) => b.brutoCentavos - a.brutoCentavos);
  const total = resumo(itens);
  return {
    processador, total, composicao,
    fracaoDeCentavo: { centavos: total.cobradoArredondadoPorTransacaoCentavos - total.cobradoCentavos, explicacao: "A Stone cobra em milionésimos de real: a soma exata das taxas (arredondada uma vez) difere da soma das taxas arredondadas transação a transação." },
    pendencias: itens.filter((x) => x.situacao !== "CONFERE"),
  };
}
