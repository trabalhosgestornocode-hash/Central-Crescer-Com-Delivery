// Contas a pagar em LOTE (lista conferida por uma pessoa), pelo MESMO núcleo de "Registrar conta a pagar" — nenhum caminho paralelo.
// Duas etapas: (1) PRÉVIA pura, sem efeito algum; (2) APLICAÇÃO, que só roda sobre a prévia, linha a linha, idempotente.
//  - Nunca baixa: o status "pago" de qualquer planilha é ignorado; toda obrigação nasce ABERTA (baixa é por extrato/caixa, depois).
//  - Duplicidade: (a) linha já aplicada deste lote (fonte MANUAL + idExterno estável) é só "já registrada"; (b) obrigação existente com
//    mesmo fornecedor, valor, vencimento e descrição é POSSÍVEL DUPLICIDADE e bloqueia a aplicação até uma pessoa decidir.
//  - Competência ANTERIOR à de início da unidade (abertura): vira obrigação ANTERIOR (posição inicial do passivo, patrimonial, fora da DRE;
//    competência = a da abertura), nunca despesa — a despesa daquele período não é apurada aqui, então não há duplicidade na DRE.
//    Essas só podem ser gravadas com a abertura CONFIGURADA e ainda não concluída; as demais, depois que a unidade estiver pronta.
//  - Pendências (categoria provisória "a classificar") ficam fora da DRE e aparecem na Central de Conferências; a nota da conferência
//    vai SEPARADA da descrição, que permanece a original.
// Os DADOS (fornecedor, descrição, valor) vêm de arquivo privado fora do repositório; este módulo não contém nenhum dado real.
import { MODELO_DE_PLANO, CATEGORIA_DESPESA_A_CLASSIFICAR, CATEGORIA_TITULOS_ANTERIORES } from "../dominio/planoDeContas.js";
import { CLASSIFICACAO as C } from "../dominio/catalogos.js";
import { CODIGO, falhar } from "../dominio/erros.js";

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
const dataOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "") && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
const mesOk = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s ?? "");

/** Efeito econômico da categoria no resultado, pela cadeia do modelo: DRE | FORA_DA_DRE_PATRIMONIAL | PENDENTE_FORA_DA_DRE. */
export function efeitoNaDre(categoria, modelo = "SUBWAY") {
  const defs = MODELO_DE_PLANO[modelo];
  let atual = defs.find((d) => d.codigo === categoria);
  if (!atual) return null;
  if (categoria === CATEGORIA_DESPESA_A_CLASSIFICAR) return "PENDENTE_FORA_DA_DRE";
  while (atual.pai) atual = defs.find((d) => d.codigo === atual.pai);
  return atual.classificacao === C.MOVIMENTACOES_PATRIMONIAIS ? "FORA_DA_DRE_PATRIMONIAL" : "DRE";
}

export const idExternoDaLinha = (lote, n) => `${lote}:${n}`;

/**
 * linhas: [{ n, fornecedor, descricao, valorCentavos, vencimento, competencia, categoria, conferencia?: { codigo, nota } }]
 * existentes: obrigações já gravadas na unidade [{ fornecedor, valorCentavos, vencimento, descricao, fonte }]
 */
const ultimoDiaAnterior = (mes) => { const [a, m] = mes.split("-").map(Number); return new Date(Date.UTC(a, m - 1, 0)).toISOString().slice(0, 10); };

export function montarPreviaContasPagarLote(linhas, { lote, existentes = [], modelo = "SUBWAY", competenciaInicio = "2026-11" } = {}) {
  if (!mesOk(competenciaInicio)) falhar(CODIGO.ENTRADA_INVALIDA, "Competência de início inválida.", { campo: "competenciaInicio" });
  const dataDeCorte = ultimoDiaAnterior(competenciaInicio);
  if (!lote || !/^[a-z0-9-]{3,40}$/.test(lote)) falhar(CODIGO.ENTRADA_INVALIDA, "Informe o identificador do lote (a-z, 0-9, hífen).", { campo: "lote" });
  const erros = [], itens = [];
  const vistos = new Set();
  const ja = new Set(existentes.map((o) => o.fonte?.sistema === "MANUAL" ? o.fonte.idExterno : null).filter(Boolean));
  const semelhantes = new Map(existentes.map((o) => [[norm(o.fornecedor), o.valorCentavos, o.vencimento, norm(o.descricao)].join("|"), o]));
  const codigos = new Set(MODELO_DE_PLANO[modelo].filter((d) => d.aceitaLancamento).map((d) => d.codigo));
  for (const l of linhas) {
    const m = [];
    if (!Number.isInteger(l.n) || l.n < 1) m.push("número da linha inválido");
    if (vistos.has(l.n)) m.push("número da linha repetido"); vistos.add(l.n);
    if (!String(l.fornecedor ?? "").trim()) m.push("fornecedor ausente");
    if (!String(l.descricao ?? "").trim()) m.push("descrição ausente");
    if (!Number.isInteger(l.valorCentavos) || l.valorCentavos <= 0) m.push("valor precisa ser inteiro positivo em centavos");
    if (!dataOk(l.vencimento)) m.push("vencimento inválido");
    if (!mesOk(l.competencia)) m.push("competência inválida");
    if (!codigos.has(l.categoria) && l.categoria !== CATEGORIA_DESPESA_A_CLASSIFICAR) m.push(`categoria desconhecida no modelo ${modelo}: ${l.categoria}`);
    if (l.categoria === CATEGORIA_DESPESA_A_CLASSIFICAR && !l.conferencia) m.push("categoria provisória exige o motivo da conferência");
    if (m.length) { erros.push({ n: l.n, motivo: m.join("; ") }); continue; }
    const idExterno = idExternoDaLinha(lote, l.n);
    const chaveSem = [norm(l.fornecedor), l.valorCentavos, l.vencimento, norm(l.descricao)].join("|");
    const estado = ja.has(idExterno) ? "JA_REGISTRADA" : semelhantes.has(chaveSem) ? "POSSIVEL_DUPLICIDADE" : "NOVA";
    const anterior = l.competencia < competenciaInicio;
    itens.push({
      ...l, idExterno, estado, anterior, categoriaOriginal: l.categoria,
      ...(anterior ? { categoria: CATEGORIA_TITULOS_ANTERIORES, competencia: competenciaInicio, competenciaOriginal: l.competencia } : {}),
      efeito: anterior ? "FORA_DA_DRE_PATRIMONIAL" : efeitoNaDre(l.categoria, modelo),
      status: anterior ? "OBRIGACAO_ANTERIOR" : l.conferencia ? "EM_CONFERENCIA" : "CLASSIFICADA",
      dataEmissao: anterior ? (l.vencimento < dataDeCorte ? l.vencimento : dataDeCorte) : l.vencimento,
    });
  }
  const soma = (xs) => xs.reduce((a, x) => a + x.valorCentavos, 0);
  const por = (f) => { const o = {}; for (const i of itens) { const k = f(i); o[k] ??= { quantidade: 0, valorCentavos: 0 }; o[k].quantidade += 1; o[k].valorCentavos += i.valorCentavos; } return o; };
  return {
    lote, erros, itens, competenciaInicio, dataDeCorte,
    apto: erros.length === 0 && !itens.some((i) => i.estado === "POSSIVEL_DUPLICIDADE"),
    resumo: {
      linhas: linhas.length, valorTotalCentavos: soma(itens),
      novas: itens.filter((i) => i.estado === "NOVA").length, jaRegistradas: itens.filter((i) => i.estado === "JA_REGISTRADA").length,
      possiveisDuplicidades: itens.filter((i) => i.estado === "POSSIVEL_DUPLICIDADE").map((i) => i.n),
      porEfeito: por((i) => i.efeito), porCategoria: por((i) => i.categoria), porVencimentoMes: por((i) => i.vencimento.slice(0, 7)),
      anteriores: itens.filter((i) => i.anterior).map((i) => i.n),
      emConferencia: itens.filter((i) => i.status === "EM_CONFERENCIA").map((i) => ({ n: i.n, codigo: i.conferencia.codigo })),
    },
  };
}

/** Aplica só as NOVAS de uma prévia apta. Cada linha é uma obrigação ABERTA (sem pagamento), com chave estável: reaplicar não duplica. */
export async function aplicarContasPagarLote(nucleo, ctx, previa, { so = "TODAS" } = {}) {
  if (previa.erros.length) falhar(CODIGO.ENTRADA_INVALIDA, "A prévia tem erros; nada foi aplicado.", { erros: previa.erros.length });
  if (previa.resumo.possiveisDuplicidades.length) falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "Há possível duplicidade; decida antes de aplicar.", { linhas: previa.resumo.possiveisDuplicidades });
  const aplicadas = [], repetidas = [];
  // `so`: "ANTERIORES" (com a abertura em andamento) ou "DO_PERIODO" (depois); "TODAS" exige que o núcleo aceite as duas.
  const escolhe = (i) => so === "TODAS" || (so === "ANTERIORES") === i.anterior;
  for (const i of previa.itens.filter((x) => x.estado === "NOVA" && escolhe(x))) {
    const base = { contraparteNova: { tipo: "FORNECEDOR", nome: i.fornecedor.slice(0, 120) }, valorOriginalCentavos: i.valorCentavos, descricao: i.descricao,
      dataEmissao: i.dataEmissao, vencimento: i.vencimento, fonte: { sistema: "MANUAL", idExterno: i.idExterno } };
    const r = i.anterior ? await nucleo.registrarObrigacaoAnterior(ctx, base) : await nucleo.registrarObrigacao(ctx, { ...base, categoria: i.categoria, competencia: i.competencia });
    (r.repetido ? repetidas : aplicadas).push(i.n);
  }
  return { aplicadas, repetidas };
}
