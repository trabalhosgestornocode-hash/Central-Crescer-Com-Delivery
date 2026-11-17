// Fase 04 (doc 42) — FECHAMENTO MANUAL DE CAIXA da SAIPOS e a comparação com as vendas importadas.
//
// Regras:
//   - o fechamento é o que a equipe informa (um por dia × caixa; vários caixas no mesmo dia). É CONFERÊNCIA: nunca gera
//     receita, lançamento ou movimentação — o faturamento vem das importações (nada é somado duas vezes);
//   - dinheiro: esperado = abertura + vendas em dinheiro + reforços − retiradas − transferências; diferença = informado − esperado;
//   - formas: crédito/débito/voucher por bandeira, Pix por operadora, Anota Aí à parte, iFood/99Food só para conferência
//     do caixa (nunca faturamento SAIPOS);
//   - comparação do dia: soma dos caixas × vendas do dia (Presencial e Anota Aí) por forma/bandeira/operadora; sem
//     relatório importado, o dia fica "só fechamento manual" — origem e situação explícitas, sem receita.
import { CODIGO, falhar } from "./erros.js";
import { exigirData } from "./tempo.js";
import { exigirInteiro, exigirLista, exigirTexto, semCamposDesconhecidos } from "./validacao.js";
import { bandeiraNormalizada } from "./taxasContratadas.js";
import { codigoDeOperadora } from "./operadoras.js";

export const GRUPO_FECHAMENTO = Object.freeze({
  CREDITO: "CREDITO", DEBITO: "DEBITO", PIX: "PIX", VOUCHER: "VOUCHER", ANOTA_AI: "ANOTA_AI", OUTRA: "OUTRA",
  IFOOD_CONFERENCIA: "IFOOD_CONFERENCIA", NOVENTA_E_NOVE_FOOD_CONFERENCIA: "NOVENTA_E_NOVE_FOOD_CONFERENCIA",
});
/** Grupos que NÃO são faturamento SAIPOS (só conferência do caixa). */
export const GRUPOS_SO_CONFERENCIA = Object.freeze(["IFOOD_CONFERENCIA", "NOVENTA_E_NOVE_FOOD_CONFERENCIA"]);
const COM_BANDEIRA = ["CREDITO", "DEBITO", "VOUCHER"];
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

const centavosOuNulo = (v, campo) => (v === undefined || v === null || v === "" ? null : exigirInteiro(v, campo, { min: 0, max: 100_000_000_00 }));
const hora = (v, campo) => {
  if (v === undefined || v === null || v === "") return null;
  if (!HORA.test(String(v))) falhar(CODIGO.ENTRADA_INVALIDA, `${campo}: use HH:MM.`, { campo });
  return String(v);
};

export function validarFechamentoManual(e) {
  semCamposDesconhecidos(e, ["data", "caixa", "responsavelAbertura", "responsavelFechamento", "horaAbertura", "horaFechamento", "dinheiro", "formas", "observacao", "justificativa"], "fechamento");
  const data = exigirData(e.data, "data");
  const caixa = exigirTexto(e.caixa, "caixa", { max: 40 });
  const d = e.dinheiro ?? {};
  semCamposDesconhecidos(d, ["aberturaCentavos", "vendasCentavos", "retiradasCentavos", "reforcosCentavos", "transferenciasCentavos", "informadoCentavos"], "dinheiro");
  const dinheiro = Object.fromEntries(["aberturaCentavos", "vendasCentavos", "retiradasCentavos", "reforcosCentavos", "transferenciasCentavos", "informadoCentavos"].map((k) => [k, centavosOuNulo(d[k], `dinheiro.${k}`)]));
  const vistas = new Set();
  const formas = exigirLista(e.formas ?? [], "formas", { min: 0, max: 60 }).map((f, i) => {
    const campo = `formas[${i}]`;
    semCamposDesconhecidos(f, ["grupo", "bandeira", "operadora", "esperadoCentavos", "informadoCentavos", "observacao"], campo);
    const grupo = String(f.grupo ?? "").toUpperCase();
    if (!GRUPO_FECHAMENTO[grupo]) falhar(CODIGO.ENTRADA_INVALIDA, `${campo}.grupo: use ${Object.keys(GRUPO_FECHAMENTO).join(", ")}.`, { campo: `${campo}.grupo` });
    const bandeira = COM_BANDEIRA.includes(grupo) ? bandeiraNormalizada(exigirTexto(f.bandeira, `${campo}.bandeira`, { max: 30 })) : null;
    const operadora = grupo === "PIX" ? (f.operadora ? codigoDeOperadora(f.operadora, `${campo}.operadora`) : "NAO_INFORMADA") : null;
    const informadoCentavos = centavosOuNulo(f.informadoCentavos, `${campo}.informadoCentavos`);
    if (informadoCentavos === null) falhar(CODIGO.ENTRADA_INVALIDA, `${campo}.informadoCentavos: informe o valor (0 se não houve).`, { campo: `${campo}.informadoCentavos` });
    const chave = `${grupo}|${bandeira ?? operadora ?? ""}`;
    if (vistas.has(chave)) falhar(CODIGO.ENTRADA_INVALIDA, `${campo}: a mesma forma aparece duas vezes no mesmo caixa.`, { campo });
    vistas.add(chave);
    return {
      grupo, bandeira, operadora, esperadoCentavos: centavosOuNulo(f.esperadoCentavos, `${campo}.esperadoCentavos`), informadoCentavos,
      observacao: exigirTexto(f.observacao, `${campo}.observacao`, { max: 200, opcional: true }) ?? null,
    };
  });
  return {
    data, caixa, responsavelAbertura: exigirTexto(e.responsavelAbertura, "responsavelAbertura", { max: 80, opcional: true }) ?? null,
    responsavelFechamento: exigirTexto(e.responsavelFechamento, "responsavelFechamento", { max: 80, opcional: true }) ?? null,
    horaAbertura: hora(e.horaAbertura, "horaAbertura"), horaFechamento: hora(e.horaFechamento, "horaFechamento"), dinheiro, formas,
    observacao: exigirTexto(e.observacao, "observacao", { max: 500, opcional: true }) ?? null,
    justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500, opcional: true }) ?? null,
  };
}

/** Totais derivados do que foi informado (nunca gravados como receita). */
export function calcularFechamento(f) {
  const d = f.dinheiro;
  const n = (v) => v ?? 0;
  const dinheiroEsperado = n(d.aberturaCentavos) + n(d.vendasCentavos) + n(d.reforcosCentavos) - n(d.retiradasCentavos) - n(d.transferenciasCentavos);
  const formas = f.formas.map((x) => ({ ...x, diferencaCentavos: x.esperadoCentavos === null ? null : x.informadoCentavos - x.esperadoCentavos }));
  const soma = (filtro) => formas.filter(filtro).reduce((s, x) => s + x.informadoCentavos, 0);
  const presencialCentavos = n(d.vendasCentavos) + soma((x) => !GRUPOS_SO_CONFERENCIA.includes(x.grupo) && x.grupo !== "ANOTA_AI");
  return {
    dinheiro: { ...d, esperadoCentavos: dinheiroEsperado, diferencaCentavos: d.informadoCentavos === null ? null : d.informadoCentavos - dinheiroEsperado },
    formas,
    totais: { presencialCentavos, anotaAiCentavos: soma((x) => x.grupo === "ANOTA_AI"), soConferenciaCentavos: soma((x) => GRUPOS_SO_CONFERENCIA.includes(x.grupo)) },
  };
}

const GRUPO_DA_FORMA = Object.freeze({ DINHEIRO: "DINHEIRO", CREDITO: "CREDITO", DEBITO: "DEBITO", PIX: "PIX", VALE: "VOUCHER", OUTRA: "OUTRA" });

/**
 * Comparação de UM dia: soma dos caixas × vendas do dia (Presencial e Anota Aí; iFood/99Food nunca entram).
 * `vendas` = [{ canal, fonte, brutoCentavos, pagamentos: [{ forma, bandeira, operadora, processador, valorCentavos }] }].
 */
export function compararDia({ fechamentos, vendas }) {
  const linhas = new Map();
  const pegar = (grupo, sub) => {
    const k = `${grupo}|${sub ?? ""}`;
    if (!linhas.has(k)) linhas.set(k, { grupo, sub: sub ?? null, manualCentavos: null, importadoCentavos: null });
    return linhas.get(k);
  };
  const somar = (alvo, campo, v) => { alvo[campo] = (alvo[campo] ?? 0) + v; };
  for (const f of fechamentos) {
    if (f.dados.dinheiro.vendasCentavos !== null) somar(pegar("DINHEIRO", null), "manualCentavos", f.dados.dinheiro.vendasCentavos);
    for (const x of f.dados.formas) {
      if (GRUPOS_SO_CONFERENCIA.includes(x.grupo)) continue;
      somar(pegar(x.grupo, x.bandeira ?? x.operadora), "manualCentavos", x.informadoCentavos);
    }
  }
  const relevantes = vendas.filter((v) => v.canal === "BALCAO" || v.canal === "ANOTA_AI");
  for (const v of relevantes) {
    if (v.canal === "ANOTA_AI") { somar(pegar("ANOTA_AI", null), "importadoCentavos", v.pagoCentavos ?? v.brutoCentavos); continue; }
    if (!v.pagamentos.length) { somar(pegar("A_CONFERIR", null), "importadoCentavos", v.brutoCentavos); continue; }
    for (const p of v.pagamentos) {
      const grupo = GRUPO_DA_FORMA[p.forma] ?? "OUTRA";
      const sub = ["CREDITO", "DEBITO", "VOUCHER"].includes(grupo) ? (p.bandeira ?? "NAO_INFORMADA") : grupo === "PIX" ? (p.operadora ?? p.processador ?? "NAO_INFORMADA") : null;
      somar(pegar(grupo, sub), "importadoCentavos", p.valorCentavos);
    }
  }
  // Voucher importado SEM bandeira (a SAIPOS diz só "Vale"): compara o total do voucher do dia, sem inventar bandeira.
  const vouchers = [...linhas.values()].filter((l) => l.grupo === "VOUCHER");
  const agruparVoucher = vouchers.some((l) => l.sub === "NAO_INFORMADA" && l.importadoCentavos !== null);
  const linhasFinais = agruparVoucher ? [...linhas.values()].filter((l) => l.grupo !== "VOUCHER") : [...linhas.values()];
  if (agruparVoucher) {
    const total = { grupo: "VOUCHER", sub: "TODAS", manualCentavos: null, importadoCentavos: null };
    for (const l of vouchers) {
      if (l.manualCentavos !== null) total.manualCentavos = (total.manualCentavos ?? 0) + l.manualCentavos;
      if (l.importadoCentavos !== null) total.importadoCentavos = (total.importadoCentavos ?? 0) + l.importadoCentavos;
    }
    linhasFinais.push(total);
  }
  const comparacao = linhasFinais.sort((a, b) => `${a.grupo}|${a.sub}`.localeCompare(`${b.grupo}|${b.sub}`)).map((l) => {
    const situacao = (l.manualCentavos ?? 0) === 0 && (l.importadoCentavos ?? 0) === 0 ? "CONFERE" : l.manualCentavos === null ? "SO_IMPORTADO" : l.importadoCentavos === null ? "SO_MANUAL" : l.manualCentavos === l.importadoCentavos ? "CONFERE" : "DIVERGENTE";
    return { ...l, diferencaCentavos: l.manualCentavos !== null && l.importadoCentavos !== null ? l.manualCentavos - l.importadoCentavos : null, situacao };
  });
  const temImportacao = relevantes.some((v) => v.fonte?.sistema === "SAIPOS");
  const temVendas = relevantes.length > 0;
  const situacao = !fechamentos.length ? (temVendas ? "SEM_FECHAMENTO_MANUAL" : "SEM_MOVIMENTO")
    : !temVendas ? "SO_FECHAMENTO_MANUAL"
    : comparacao.every((l) => l.situacao === "CONFERE") ? "CONFERE" : "DIVERGENTE";
  return {
    situacao, temImportacao, comparacao,
    observacao: situacao === "SO_FECHAMENTO_MANUAL"
      ? "Sem relatório importado neste dia: o fechamento manual fica registrado (origem: equipe) e NÃO entra no faturamento até a importação."
      : "O faturamento é o das vendas importadas; o fechamento manual só confere (nunca soma).",
  };
}
