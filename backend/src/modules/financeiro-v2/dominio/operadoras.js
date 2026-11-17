// Fase 02 (doc 40) — OPERADORAS de pagamento (adquirentes/maquininhas) da unidade e a TAXA ESTIMADA de cada pagamento.
//
// Regras:
//   - operadora ≠ canal de venda: a maquininha do iFood usada no balcão é uma OPERADORA (processador MAQUININHA_IFOOD);
//     a venda continua no canal da origem (Presencial). Nunca vira faturamento nem comissão do marketplace iFood;
//   - N operadoras por unidade, com ativação/encerramento e vigência; várias ativas ao mesmo tempo são permitidas;
//   - a operadora de um pagamento é: a informada; senão a ÚNICA ativa na data que atende o processador e a modalidade;
//     duas ou mais candidatas → OPERADORA_AMBIGUA (conferência), nunca escolha arbitrária;
//   - taxa estimada = tabela VIGENTE NA DATA DA VENDA (nunca a da importação), gravada com a versão usada; modalidade sem
//     taxa → TAXA_NAO_CONFIGURADA (nunca 0%);
//   - a estimativa é INFORMATIVA (líquido esperado e conferência): não é lançamento, não entra na DRE. A tarifa que entra na
//     DRE é a efetivamente cobrada (relatório da operadora, doc 36).
import { CODIGO, falhar } from "./erros.js";
import { exigirData } from "./tempo.js";
import { exigirLista, exigirTexto, semCamposDesconhecidos } from "./validacao.js";

/** Modalidades de taxa. Crédito é só à vista (a operação não parcela). */
export const MODALIDADE = Object.freeze({ DEBITO: "DEBITO", CREDITO_A_VISTA: "CREDITO_A_VISTA", PIX: "PIX", VOUCHER: "VOUCHER" });
/** Forma de pagamento da venda → modalidade de taxa (dinheiro e "outra" não têm taxa de operadora). */
export const MODALIDADE_DA_FORMA = Object.freeze({ DEBITO: "DEBITO", CREDITO: "CREDITO_A_VISTA", PIX: "PIX", VALE: "VOUCHER" });
/** Processadores que são ADQUIRENTES/maquininhas (têm tabela de taxas). Marketplace e operadora de benefícios ficam de fora. */
export const PROCESSADORES_ADQUIRENTES = Object.freeze(["STONE", "PAGBANK", "MAQUININHA_IFOOD", "MAQUINA_TERCEIROS", "OPERADORA_BENEFICIOS"]);
export const SITUACAO_OPERADORA = Object.freeze({ ATIVA: "ATIVA", INATIVA: "INATIVA" });
export const SITUACAO_TAXA_ESTIMADA = Object.freeze({
  CALCULADA: "CALCULADA", TAXA_NAO_CONFIGURADA: "TAXA_NAO_CONFIGURADA", SEM_TABELA_VIGENTE: "SEM_TABELA_VIGENTE",
  OPERADORA_AMBIGUA: "OPERADORA_AMBIGUA", SEM_OPERADORA: "SEM_OPERADORA", OPERADORA_INATIVA_NA_DATA: "OPERADORA_INATIVA_NA_DATA",
  NAO_SE_APLICA: "NAO_SE_APLICA",
});

const CODIGO_OPERADORA = /^[A-Z][A-Z0-9_]{1,29}$/;
export function codigoDeOperadora(v, campo = "operadora") {
  const s = String(v ?? "").trim().toUpperCase();
  if (!CODIGO_OPERADORA.test(s)) falhar(CODIGO.ENTRADA_INVALIDA, `${campo}: código inválido (letras maiúsculas, números e _; ex.: STONE, PAGBANK, MAQUININHA_IFOOD).`, { campo });
  return s;
}

/** Cadastro de operadora (sem taxas: elas vêm nas tabelas versionadas). */
export function validarOperadora(e) {
  semCamposDesconhecidos(e, ["codigo", "nome", "processador", "inicio", "encerramento", "modalidades", "observacao", "justificativa"], "operadora");
  const processador = String(e.processador ?? "").toUpperCase();
  if (!PROCESSADORES_ADQUIRENTES.includes(processador)) falhar(CODIGO.ENTRADA_INVALIDA, `processador: use ${PROCESSADORES_ADQUIRENTES.join(", ")}.`, { campo: "processador" });
  const inicio = exigirData(e.inicio, "inicio");
  const encerramento = e.encerramento ? exigirData(e.encerramento, "encerramento") : null;
  if (encerramento && encerramento < inicio) falhar(CODIGO.DATA_INVALIDA, "Encerramento antes do início.", { campo: "encerramento" });
  const modalidades = exigirLista(e.modalidades, "modalidades", { min: 1, max: 4 }).map((m, i) => {
    const x = String(m ?? "").toUpperCase();
    if (!MODALIDADE[x]) falhar(CODIGO.ENTRADA_INVALIDA, `modalidades[${i}]: use ${Object.keys(MODALIDADE).join(", ")}.`, { campo: `modalidades[${i}]` });
    return x;
  });
  if (new Set(modalidades).size !== modalidades.length) falhar(CODIGO.ENTRADA_INVALIDA, "Modalidade repetida.", { campo: "modalidades" });
  return {
    codigo: codigoDeOperadora(e.codigo, "codigo"), nome: exigirTexto(e.nome, "nome", { max: 80 }), processador, inicio, encerramento,
    modalidades: modalidades.sort(), observacao: exigirTexto(e.observacao, "observacao", { max: 300, opcional: true }) ?? null,
    justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }),
  };
}

const ativaNaData = (o, data) => o.situacao !== SITUACAO_OPERADORA.INATIVA && o.inicio <= data && (!o.encerramento || data <= o.encerramento);

/**
 * Operadoras efetivas da unidade: as cadastradas + (compatibilidade) uma IMPLÍCITA por processador que só tem tabela de
 * taxas legada (doc 35, sem cadastro), ativa e sem datas — o comportamento da tabela Stone anterior não muda.
 */
export function operadorasEfetivas(config) {
  const cadastradas = Array.isArray(config?.operadoras) ? config.operadoras : [];
  const tabelas = Array.isArray(config?.taxasContratadas) ? config.taxasContratadas : [];
  const implicitas = [...new Set(tabelas.map((t) => t.operadora ?? t.processador))]
    .filter((cod) => !cadastradas.some((o) => o.codigo === cod) && PROCESSADORES_ADQUIRENTES.includes(cod))
    .map((cod) => ({ codigo: cod, nome: cod, processador: cod, inicio: "0000-01-01", encerramento: null, modalidades: Object.keys(MODALIDADE), situacao: SITUACAO_OPERADORA.ATIVA, implicita: true }));
  return [...cadastradas, ...implicitas];
}

const vigente = (tabelas, operadora, data) => tabelas.filter((t) => (t.operadora ?? t.processador) === operadora && t.vigenciaInicio <= data && (!t.vigenciaFim || data <= t.vigenciaFim))
  .sort((a, b) => b.vigenciaInicio.localeCompare(a.vigenciaInicio))[0] ?? null;
/** Divisão inteira com arredondamento meio-para-cima (a, b ≥ 0). */
const divisaoArredondada = (a, b) => Math.floor((2 * a + b) / (2 * b));

/**
 * Taxa ESTIMADA de um pagamento. `milesimos` = milésimos de ponto percentual (0,50% = 500); a taxa em centavos é
 * bruto × milésimos / 100.000, meio-para-cima, mais a tarifa fixa (se contratada). Devolve sempre a situação; a versão da
 * tabela usada (operadora, vigência, percentual, tarifa) fica gravada para que mudanças futuras da tabela não a alterem.
 */
export function calcularTaxaEstimada({ config, data, processador, operadora = null, forma, bandeira = null, brutoCentavos }) {
  const modalidade = MODALIDADE_DA_FORMA[forma] ?? null;
  const base = { modalidade, bandeira: bandeira ?? (modalidade === "PIX" ? "PIX" : null), brutoCentavos, operadora: operadora ?? null, taxaCentavos: null, liquidoEsperadoCentavos: null, versao: null };
  if (!modalidade || !processador || !PROCESSADORES_ADQUIRENTES.includes(processador)) return { ...base, situacao: SITUACAO_TAXA_ESTIMADA.NAO_SE_APLICA };
  const todas = operadorasEfetivas(config).filter((o) => o.processador === processador);
  let escolhida;
  if (operadora) {
    escolhida = todas.find((o) => o.codigo === operadora);
    if (!escolhida) return { ...base, situacao: SITUACAO_TAXA_ESTIMADA.SEM_OPERADORA };
    if (!ativaNaData(escolhida, data)) return { ...base, situacao: SITUACAO_TAXA_ESTIMADA.OPERADORA_INATIVA_NA_DATA };
  } else {
    const candidatas = todas.filter((o) => ativaNaData(o, data) && o.modalidades.includes(modalidade));
    if (candidatas.length > 1) return { ...base, situacao: SITUACAO_TAXA_ESTIMADA.OPERADORA_AMBIGUA, candidatas: candidatas.map((o) => o.codigo).sort() };
    if (!candidatas.length) return { ...base, situacao: SITUACAO_TAXA_ESTIMADA.SEM_OPERADORA };
    [escolhida] = candidatas;
  }
  const comOperadora = { ...base, operadora: escolhida.codigo };
  const tabela = vigente(Array.isArray(config?.taxasContratadas) ? config.taxasContratadas : [], escolhida.codigo, data);
  if (!tabela) return { ...comOperadora, situacao: SITUACAO_TAXA_ESTIMADA.SEM_TABELA_VIGENTE };
  const chaveBandeira = modalidade === "PIX" ? "PIX" : bandeira;
  const taxa = tabela.taxas.find((t) => t.modalidade === modalidade && t.bandeira === chaveBandeira);
  if (!taxa) return { ...comOperadora, situacao: SITUACAO_TAXA_ESTIMADA.TAXA_NAO_CONFIGURADA };
  const tarifaFixa = taxa.tarifaFixaCentavos ?? 0;
  const taxaCentavos = Math.min(brutoCentavos, divisaoArredondada(brutoCentavos * taxa.milesimos, 100000) + tarifaFixa);
  return {
    ...comOperadora, situacao: SITUACAO_TAXA_ESTIMADA.CALCULADA, taxaCentavos, liquidoEsperadoCentavos: brutoCentavos - taxaCentavos,
    versao: { operadora: escolhida.codigo, vigenciaInicio: tabela.vigenciaInicio, vigenciaFim: tabela.vigenciaFim ?? null, registradaEm: tabela.registradaEm ?? null, milesimos: taxa.milesimos, tarifaFixaCentavos: tarifaFixa },
  };
}

/**
 * Adquirentes candidatas a uma modalidade NA DATA (para a fonte que não diz a operadora, ex.: "Débito Master" da SAIPOS):
 * a única ativa decide; duas ou mais (operadoras simultâneas) → ambígua (conferência); nenhuma → sem operadora.
 * `processadores` restringe a busca (ex.: só STONE e PAGBANK para cartão no balcão).
 */
export function operadoraNaData({ config, data, forma, processadores = PROCESSADORES_ADQUIRENTES }) {
  const modalidade = MODALIDADE_DA_FORMA[forma] ?? null;
  if (!modalidade) return { situacao: SITUACAO_TAXA_ESTIMADA.NAO_SE_APLICA, operadora: null, candidatas: [] };
  const candidatas = operadorasEfetivas(config).filter((o) => processadores.includes(o.processador) && ativaNaData(o, data) && o.modalidades.includes(modalidade));
  if (candidatas.length === 1) return { situacao: "UNICA", operadora: candidatas[0].codigo, processador: candidatas[0].processador, candidatas: [candidatas[0].codigo] };
  return { situacao: candidatas.length ? SITUACAO_TAXA_ESTIMADA.OPERADORA_AMBIGUA : SITUACAO_TAXA_ESTIMADA.SEM_OPERADORA, operadora: null, candidatas: candidatas.map((o) => o.codigo).sort() };
}

/** Percentual efetivo em centésimos de ponto (2,95% = 295), calculado dos TOTAIS (nunca média de percentuais). */
export const percentualEfetivo = (taxaCentavos, brutoCentavos) => (brutoCentavos > 0 ? divisaoArredondada(taxaCentavos * 10000, brutoCentavos) : null);

/**
 * Cards por modalidade (e bandeira dentro): bruto, taxa estimada, líquido esperado, percentual efetivo e o que ficou sem
 * cálculo (taxa não configurada, operadora ambígua…). Bruto sem cálculo NUNCA entra como taxa zero.
 */
export function resumoPorModalidade(itens) {
  const grupos = new Map();
  for (const i of itens) {
    const m = i.modalidade ?? "SEM_MODALIDADE";
    if (!grupos.has(m)) grupos.set(m, new Map());
    const b = i.bandeira ?? "—";
    const porBandeira = grupos.get(m);
    if (!porBandeira.has(b)) porBandeira.set(b, []);
    porBandeira.get(b).push(i);
  }
  const somar = (lista) => {
    const calculados = lista.filter((x) => x.situacao === SITUACAO_TAXA_ESTIMADA.CALCULADA);
    const brutoCentavos = lista.reduce((s, x) => s + x.brutoCentavos, 0);
    const brutoCalculado = calculados.reduce((s, x) => s + x.brutoCentavos, 0);
    const taxaCentavos = calculados.reduce((s, x) => s + x.taxaCentavos, 0);
    const pendentes = lista.filter((x) => x.situacao !== SITUACAO_TAXA_ESTIMADA.CALCULADA && x.situacao !== SITUACAO_TAXA_ESTIMADA.NAO_SE_APLICA);
    const situacoes = [...new Set(lista.map((x) => x.situacao))].sort();
    const situacao = !pendentes.length ? (calculados.length ? "CALCULADO" : "NAO_SE_APLICA") : calculados.length ? "PARCIAL" : "PENDENTE";
    // Recebido CONFIRMADO (liquidação registrada / entrada no caixa): nunca presumido. Conferência só fecha com tudo recebido.
    const comRecebido = lista.filter((x) => typeof x.recebidoCentavos === "number");
    const recebidoCentavos = comRecebido.length ? comRecebido.reduce((s, x) => s + x.recebidoCentavos, 0) : null;
    const esperadoParaConferir = lista.reduce((s, x) => s + (x.situacao === SITUACAO_TAXA_ESTIMADA.CALCULADA ? x.brutoCentavos - x.taxaCentavos : x.situacao === SITUACAO_TAXA_ESTIMADA.NAO_SE_APLICA ? x.brutoCentavos : 0), 0);
    const situacaoConferencia = pendentes.length ? "PENDENTE"
      : comRecebido.length < lista.length ? (comRecebido.length ? "PARCIAL" : situacao === "NAO_SE_APLICA" ? "PENDENTE" : "AGUARDANDO_EXTRATO")
      : recebidoCentavos === esperadoParaConferir ? "CONCILIADO" : "DIVERGENTE";
    return {
      quantidade: lista.length, brutoCentavos, brutoCalculadoCentavos: brutoCalculado, taxaCentavos, liquidoEsperadoCentavos: brutoCalculado - taxaCentavos,
      percentualEfetivoCentesimos: percentualEfetivo(taxaCentavos, brutoCalculado),
      brutoSemCalculoCentavos: pendentes.reduce((s, x) => s + x.brutoCentavos, 0), situacoes, situacao,
      recebidoCentavos, diferencaCentavos: situacaoConferencia === "CONCILIADO" || situacaoConferencia === "DIVERGENTE" ? recebidoCentavos - esperadoParaConferir : null, situacaoConferencia,
    };
  };
  return [...grupos.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([modalidade, porBandeira]) => ({
    modalidade, ...somar([...porBandeira.values()].flat()),
    bandeiras: [...porBandeira.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bandeira, lista]) => ({ bandeira, ...somar(lista) })),
  }));
}
