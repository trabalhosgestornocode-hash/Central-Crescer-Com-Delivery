// Leitura dos relatórios "Relatório de Produtos" da Visio Analytics
// (Geral e Loja) usados na Bonificação Mensal.
//
// Mesmo espírito de vendas/sw-parser.js: o backend é quem interpreta o PDF,
// nunca o frontend — importação manual e futura automação usam a mesma
// lógica. Reaproveita daquele módulo só o que é genérico (matriz de texto,
// sha256, decodificação do base64); NADA em vendas/ foi alterado. A
// normalização numérica pt-BR (parseNumeroBR/parseQuantidadeBR/parseMoedaBR,
// abaixo) é PRÓPRIA deste parser — sw-parser.js#parseBR usa parseFloat e
// quebra "3.460" -> 3.46 (separador de milhar tratado como decimal), o que
// não aparece nos relatórios DIÁRIOS (quantidades < 1000) mas quebra o
// relatório MENSAL. Não dá pra corrigir lá sem mexer no módulo Vendas.
//
// O parser é agnóstico a "Geral" ou "Loja": os dois PDFs têm exatamente a
// mesma estrutura (só mudam os filtros aplicados na Visio antes de
// exportar — item 14 das instruções). Quem decide qual é qual é o usuário,
// no modal de importação; este módulo só extrai os campos e devolve uma
// estrutura padronizada — a validação cruzada (Geral >= Loja, mesma
// unidade) acontece na camada de serviço.
import { ApiError } from "../../shared/ApiError.js";
import { emProducao } from "../../config/seguranca.js";
import { sha256, norm, textoParaMatriz, decodificarArquivo } from "../vendas/sw-parser.js";

// ---------------------------------------------------------------------
// LOG DE DESENVOLVIMENTO
// Ligado fora de produção, por padrão — é o que permite depurar "por que
// este PDF não leu" sem precisar mexer em código. Nunca imprime o texto cru
// do PDF inteiro (pode ter dado de faturamento) nem roda em produção.
// ---------------------------------------------------------------------
const DEBUG = !emProducao;
const logDebug = (...args) => { if (DEBUG) console.log("[visio-parser]", ...args); };

// pdf-parse padrão cola as colunas; este pagerender preserva a estrutura de
// tabela inserindo TAB entre itens da mesma linha (mesmo Y) — cópia local
// do helper de sw-parser.js (não exportado de lá) para não tocar em Vendas.
function renderPaginaComColunas(pageData) {
  return pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false }).then((tc) => {
    let ultimoY = null, texto = "";
    for (const item of tc.items) {
      if (!item.str) continue;
      const y = item.transform[5];
      if (ultimoY === null) texto = item.str;
      else if (Math.abs(y - ultimoY) < 2) texto += "\t" + item.str;
      else texto += "\n" + item.str;
      ultimoY = y;
    }
    return texto;
  });
}

async function matrizDePdf(buf) {
  let pdfParse;
  try {
    ({ default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js"));
  } catch {
    throw ApiError.badRequest("Leitor de PDF indisponível no servidor. Tente novamente em instantes.");
  }
  const { text } = await pdfParse(buf, { pagerender: renderPaginaComColunas });
  const matriz = textoParaMatriz(text);
  if (!matriz.length) throw ApiError.badRequest("Não consegui extrair texto deste PDF (pode ser digitalizado/imagem). Exporte novamente da Visio.");
  logDebug(`matriz extraída: ${matriz.length} linha(s) de texto.`);
  return matriz;
}

// ---------------------------------------------------------------------
// NORMALIZAÇÃO NUMÉRICA pt-BR — FONTE ÚNICA para este parser.
//
// Nos relatórios da Visio (pt-BR) o "." é SEMPRE separador de MILHAR e a ","
// é SEMPRE o separador decimal — nunca o contrário. `parseFloat("3.460")`
// devolve 3.46 (trata "." como decimal e joga fora o "0" final): ERRADO
// para estes dados. Bug real relatado (relatório MENSAL, quantidades na casa
// dos milhares): "3.460" virava 3.46 na base e "1.412" chegava como 1.412
// num campo `integer` do Postgres ("invalid input syntax for type integer").
// Nos relatórios DIÁRIOS nunca apareceu porque as quantidades do dia são < 1000.
//
//   parseNumeroBR("3.460")        -> 3460
//   parseNumeroBR("R$ 109.613,74") -> 109613.74
//   parseNumeroBR("180,5")        -> 180.5
//   parseQuantidadeBR("1.412")    -> 1412   (inteiro — quantidade de itens)
//   parseQuantidadeBR("3.460,5")  -> null   (quantidade não é fracionária)
//
// `null` = "não parece número" — NUNCA se chuta 0 (item 22 do módulo).
// ---------------------------------------------------------------------
const NUM_BR_RE = /^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/;

/** Número pt-BR (aceita R$/$ e separador de milhar). "." = milhar, "," = decimal. → Number|null. */
export function parseNumeroBR(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").replace(/[R$\s  ]/gi, "").trim();
  if (s === "" || !NUM_BR_RE.test(s)) return null;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
/** Igual a parseNumeroBR, mas o resultado TEM que ser inteiro NÃO-negativo (contagem de itens). "1.412" → 1412; "3.460,5" / "-5" → null. */
export function parseQuantidadeBR(v) {
  const n = parseNumeroBR(v);
  return n != null && Number.isInteger(n) && n >= 0 ? n : null;
}
/** Valor monetário pt-BR: "R$ 109.613,74" → 109613.74. Mesma regra de parseNumeroBR (que já tolera R$). */
export const parseMoedaBR = parseNumeroBR;
/** Percentual pt-BR: "68,0%" → 68 ; "42,4%" → 42.4. Tira o "%" e cai no número decimal. */
export function parsePercentualBR(v) {
  return parseNumeroBR(String(v ?? "").replace(/%/g, ""));
}

// ---------------------------------------------------------------------
// REGRA ÚNICA DE NORMALIZAÇÃO, POR TIPO DE CAMPO
//   quantidade      → parseQuantidadeBR  (inteiro ≥ 0; fracionário/lixo → null)
//   moeda           → parseMoedaBR       ("R$ 1.234,56" → 1234.56)
//   percentual      → parsePercentualBR  ("42,4%" → 42.4)
//   número decimal  → parseNumeroBR      ("180,5" → 180.5 ; "2.089" → 2089)
// "." é SEMPRE separador de milhar; "," é SEMPRE o decimal. Nunca parseFloat.
// ---------------------------------------------------------------------

// ---------- reconhecimento de células ----------
const MONEY_RE = /^(?:r\$|\$)\s?-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?$/i;
// Inteiro "puro" para DETECÇÃO de layout — aceita separador de milhar
// ("1.234", relatório MENSAL) E dígitos corridos ("57", "1234"). Rejeita
// decimal ("1,5", "1.23") — isso é outro tipo de célula.
const INT_RE = /^\d{1,3}(?:\.\d{3})*$|^\d+$/;
// PPD ("Torque por estabelecimento") NÃO é sempre inteiro — o relatório
// Geral (soma de todos os canais) traz PPD fracionário (ex.: "180,5"),
// enquanto o relatório de uma unidade/canal isolado costuma dar um inteiro
// (ex.: "57" ou, no mês, "2.089"). Aceita milhar E decimal (mesma forma de NUM_BR_RE).
const DECIMAL_RE = /^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/;
const PCT_RE = /^-?\d{1,3}(?:[.,]\d+)?%$/;

const parsePct = (s) => (s == null ? null : parsePercentualBR(s));
/** Quantidade "pura" do Mix de Vendas (sem % nem $) — SEMPRE inteiro pt-BR. */
const numeroPuro = (s) => parseQuantidadeBR(s);
const PCT_CELULA_RE = /^-?\d{1,3}(?:[.,]\d+)?%$/;
const ehMoeda = (s) => MONEY_RE.test(String(s ?? "").replace(/\s+/g, ""));

// ---------------------------------------------------------------------
// DETECÇÃO RÍGIDA DO TIPO DE RELATÓRIO — pelo CONTEÚDO, nunca pelo nome do
// arquivo. Um "Relatório de Vendas" no slot de Produtos (e vice-versa) tem
// que ser recusado com mensagem clara (F2, item 1).
//
//   'produtos' : título "Relatório de Produtos"  E  (tabela "Torque por
//                estabelecimento"  OU  seção "% de acompanhamentos em
//                vendas principais")  E  sem título "Relatório de Vendas".
//   'vendas'   : título "Relatório de Vendas"  E  ("Resumo de vendas"  OU
//                "Cupons válidos"  OU  "Detalhe de vendas por
//                estabelecimento")  E  sem título "Relatório de Produtos".
//   null       : não bate em nenhum dos dois de forma inequívoca.
//
// NÃO infere mês/ano/período/canal — isso NÃO está de forma confiável no
// PDF e pertence ao fluxo de confirmação/cross-check (arquitetura v3.1).
// ---------------------------------------------------------------------
const TITULO_PRODUTOS = normCel("Relatório de Produtos");
const TITULO_VENDAS = normCel("Relatório de Vendas");
const ANCORAS_PRODUTOS = [normCel("Torque por estabelecimento"), normCel("% de acompanhamentos em vendas principais")];
const ANCORAS_VENDAS = [normCel("Resumo de vendas"), normCel("Cupons válidos"), normCel("Detalhe de vendas por estabelecimento")];

/** @param {string[][]} matriz @returns {'produtos'|'vendas'|null} */
export function detectarTipoRelatorio(matriz) {
  const linhas = (matriz || []).map((r) => normCel((r || []).join(" ")));
  const tem = (needle) => linhas.some((l) => l.includes(needle));

  const tituloProdutos = tem(TITULO_PRODUTOS);
  const tituloVendas = tem(TITULO_VENDAS);
  const ancoraProdutos = ANCORAS_PRODUTOS.some(tem);
  const ancoraVendas = ANCORAS_VENDAS.some(tem);

  const ehProdutos = tituloProdutos && ancoraProdutos && !tituloVendas;
  const ehVendas = tituloVendas && ancoraVendas && !tituloProdutos;
  if (ehProdutos && !ehVendas) return "produtos";
  if (ehVendas && !ehProdutos) return "vendas";
  return null;
}

function exigirTipo(matriz, esperado, alvo) {
  const tipo = detectarTipoRelatorio(matriz);
  if (tipo === esperado) return;
  const nomeEsperado = esperado === "produtos" ? "Relatório de Produtos" : "Relatório de Vendas";
  const nomeOutro = esperado === "produtos" ? "Relatório de Vendas" : "Relatório de Produtos";
  if (tipo && tipo !== esperado) {
    throw ApiError.badRequest(`O arquivo enviado ${alvo} é um "${nomeOutro}", não um "${nomeEsperado}". Envie o relatório correto no campo certo.`);
  }
  throw ApiError.badRequest(`Não reconheci o arquivo enviado ${alvo} como um "${nomeEsperado}" exportado da Visio.`);
}

/**
 * Normaliza uma célula para COMPARAÇÃO semântica (nunca para exibição):
 * minúsculas, sem acento (via norm(), de sw-parser.js), sem caracteres
 * invisíveis que a extração de PDF às vezes deixa (zero-width, NBSP),
 * espaços/quebras colapsados, sem pontuação de borda ("Bebidas:", "- Bebidas").
 * Cobre os itens pedidos: trim, collapse de espaços, normalização Unicode,
 * comparação case-insensitive, tolerância a acentos e a pequenas variações.
 */
function normCel(s) {
  return norm(String(s ?? "").replace(/[​‌‍﻿ ]/g, " "))
    .replace(/\s+/g, " ")
    .replace(/^[:\-–—.\s]+|[:\-–—.\s]+$/g, "")
    .trim();
}

// Rótulos aceitos por categoria do Mix de Vendas — comparados via normCel().
// Cada categoria é buscada PELO NOME, nunca pela posição da linha: um
// relatório pode listar Bebidas/Adicionais/Diversos em qualquer ordem.
const ALIASES_CATEGORIA = {
  sanduiches: ["sanduiches/saladas", "sanduiches / saladas", "sanduiche/salada", "sanduiches e saladas", "sanduiches", "saladas"],
  bebidas: ["bebidas", "bebida"],
  adicionais: ["adicionais", "adicional"],
  diversos: ["diversos", "diverso"],
  total: ["total"],
};
const CATEGORIAS_MIX = ["sanduiches", "bebidas", "adicionais", "diversos"];
const ROTULO_CATEGORIA = { sanduiches: "Sanduíches/Saladas", bebidas: "Bebidas", adicionais: "Adicionais", diversos: "Diversos" };
const ANCORA_SECAO = normCel("% de acompanhamentos em vendas principais");

/** A célula (já normalizada) É o rótulo desta categoria? */
function ehRotuloDe(categoria, normalizado) {
  return ALIASES_CATEGORIA[categoria].some((a) => normalizado === a || normalizado.replace(/[\s/]/g, "") === a.replace(/[\s/]/g, ""));
}

/**
 * Corrige rótulos que a extração do PDF quebrou em duas linhas de 1 célula
 * (ex.: "Sanduíches/" numa linha e "Saladas" na seguinte — item pedido
 * explicitamente: "Sanduíches/Saladas eventualmente separado por quebra de
 * linha"). Só funde quando a linha isolada NÃO é, sozinha, um rótulo válido
 * — nunca mexe em conteúdo que já faz sentido como está.
 * @param {string[][]} matriz
 * @returns {string[][]}
 */
function fundirRotulosQuebrados(matriz) {
  const out = [];
  for (let i = 0; i < matriz.length; i++) {
    const atual = matriz[i];
    const prox = matriz[i + 1];
    const jaEhRotulo = atual?.length === 1 && CATEGORIAS_MIX.some((c) => ehRotuloDe(c, normCel(atual[0])));
    const juntoVira = atual?.length === 1 && prox?.length === 1
      && CATEGORIAS_MIX.some((c) => ehRotuloDe(c, normCel(`${atual[0]} ${prox[0]}`)) || ehRotuloDe(c, normCel(`${atual[0]}${prox[0]}`)));
    if (!jaEhRotulo && juntoVira) {
      out.push([`${atual[0]} ${prox[0]}`.trim()]);
      i++; // linha seguinte já foi consumida na fusão
      continue;
    }
    out.push(atual);
  }
  return out;
}

/**
 * Busca, dentro de uma faixa [de, ate) da matriz, a QUANTIDADE de cada
 * categoria do Mix de Vendas — sempre pelo NOME da categoria, nunca por
 * posição fixa de linha. Cobre os formatos reais observados:
 *   1. ["Bebidas", "34"]                — rótulo e valor na mesma linha
 *   2. ["Bebidas"] seguido de ["34"]     — rótulo e valor em linhas separadas
 * Se um rótulo bater mas nenhum número "puro" (sem %) for encontrado perto
 * dele, a busca NÃO desiste da categoria — continua procurando outra
 * ocorrência do mesmo nome mais adiante (existe uma tabela de REFERÊNCIA de
 * mercado, mais acima no relatório, que também usa "Bebidas" como rótulo
 * mas só tem percentuais — nunca é confundida com a quantidade real porque
 * seus valores têm "%" e por isso nunca batem em numeroPuro()).
 * @param {string[][]} matriz já com fundirRotulosQuebrados aplicado
 * @param {number} de @param {number} ate
 */
function buscarCategoriasPorNome(matriz, de, ate) {
  const valores = {};
  const log = [];
  const fim = Math.min(ate, matriz.length);

  for (const categoria of CATEGORIAS_MIX) {
    for (let i = Math.max(de, 0); i < fim; i++) {
      const row = matriz[i] || [];
      if (!row.length || !ehRotuloDe(categoria, normCel(row[0]))) continue;

      let valor = row.length >= 2 ? numeroPuro(row[1]) : null;
      for (let j = i + 1; valor == null && j < Math.min(i + 4, fim); j++) {
        const r2 = matriz[j] || [];
        if (r2.length === 1) valor = numeroPuro(r2[0]);
        else break; // linha com mais de 1 célula não é "só o número" — não é isto
      }

      if (valor != null) {
        valores[categoria] = valor;
        log.push(`${ROTULO_CATEGORIA[categoria]} -> linha ${i} ("${row.join(" | ")}") = ${valor}`);
        break;
      }
      // rótulo bateu mas sem valor perto — provavelmente outra tabela
      // (ex.: o quadro de referência "Como deve ser meu Mix de vendas?",
      // que também tem uma linha "Bebidas" mas só com percentuais). Segue
      // procurando outra ocorrência do mesmo nome.
    }
  }
  return { valores, log };
}

/**
 * Percentuais que o PRÓPRIO PDF calculou (linhas soltas de 1 célula logo
 * após "Total") — só para a validação cruzada do item 11; o cálculo de
 * negócio NUNCA usa este valor, só as quantidades.
 *
 * A Visio varia a ordem das linhas do mix entre relatórios (ex.: `Diversos`
 * antes de `Adicionais`), e as linhas soltas de percentual depois de "Total"
 * seguem EXATAMENTE a ordem das linhas de categoria acima. Por isso cada
 * percentual é mapeado pelo RÓTULO da categoria correspondente, nunca por
 * posição fixa (bug histórico: percentualAdicionaisPdf/percentualDiversosPdf
 * saíam trocados quando o PDF listava Diversos antes de Adicionais — ver
 * bonificacao-mensal-visio-parser.test.js "ordem Diversos→Adicionais").
 * @param {string[][]} matriz @param {number} de @param {number} ate
 */
function buscarPercentuaisDoTotal(matriz, de, ate) {
  const fim = Math.min(ate, matriz.length);
  const inicio = Math.max(de, 0);
  let idxTotal = -1;
  for (let i = inicio; i < fim; i++) {
    const row = matriz[i] || [];
    if (row.length && ehRotuloDe("total", normCel(row[0]))) { idxTotal = i; break; }
  }
  if (idxTotal < 0) return {};

  // Ordem REAL das categorias nas linhas da seção, antes de "Total".
  const ordem = [];
  for (let i = inicio; i < idxTotal; i++) {
    const cel = normCel((matriz[i] || [])[0] || "");
    if (!cel) continue;
    const cat = CATEGORIAS_MIX.find((c) => ehRotuloDe(c, cel));
    if (cat && !ordem.includes(cat)) ordem.push(cat);
  }

  const pcts = [];
  for (let j = idxTotal + 1; j < Math.min(idxTotal + 6, fim) && pcts.length < 4; j++) {
    const r = matriz[j];
    if (r && r.length === 1 && PCT_RE.test(r[0])) pcts.push(parsePct(r[0]));
    else if (pcts.length) break; // sequência já começou e quebrou — para
  }

  // Sanduíches/Saladas é a base (100%); tira dos dois lados e zipa o resto
  // por rótulo. Se a ordem das linhas não pôde ser determinada, cai no
  // comportamento anterior (posicional) como último recurso.
  const ordemAcomp = ordem.filter((c) => c !== "sanduiches");
  const pctsAcomp = pcts.length && Math.round(pcts[0]) === 100 ? pcts.slice(1) : pcts;
  const porCategoria = {};
  if (ordemAcomp.length) {
    for (let k = 0; k < pctsAcomp.length && k < ordemAcomp.length; k++) porCategoria[ordemAcomp[k]] = pctsAcomp[k];
  } else {
    [porCategoria.bebidas, porCategoria.adicionais, porCategoria.diversos] = pctsAcomp;
  }
  return {
    percentualBebidasPdf: porCategoria.bebidas ?? null,
    percentualAdicionaisPdf: porCategoria.adicionais ?? null,
    percentualDiversosPdf: porCategoria.diversos ?? null,
  };
}

/** pt-BR: ["Adicionais"] -> "Adicionais"; ["Adicionais","Diversos"] -> "Adicionais e Diversos". */
function listarPt(itens) {
  if (itens.length <= 1) return itens[0] ?? "";
  return `${itens.slice(0, -1).join(", ")} e ${itens[itens.length - 1]}`;
}

/**
 * Localiza a tabela "Torque por estabelecimento" (única fonte confiável de
 * Faturamento + PPD do relatório): 7 células numéricas na ordem fixa
 * [Fat. bruto, Torque bruto, Faturamento, PPD, Torque, Perdas, Produtos func.],
 * seguida (não necessariamente na linha imediatamente ao lado — o PDF
 * repete a tabela e o nome vem numa linha própria) pelo nome do
 * estabelecimento. A ordem das COLUNAS aqui é fixa pelo próprio layout da
 * Visio (é uma tabela real, não rótulos soltos que podem trocar de posição
 * como no Mix de Vendas) — não há o mesmo risco de reordenação.
 * @param {string[][]} matriz
 */
function extrairTorquePorEstabelecimento(matriz) {
  for (let i = 0; i < matriz.length; i++) {
    const row = matriz[i] || [];
    if (row.length !== 7) continue;
    if (!(MONEY_RE.test(row[0]) && MONEY_RE.test(row[1]) && MONEY_RE.test(row[2])
      && DECIMAL_RE.test(row[3]) && MONEY_RE.test(row[4]) && MONEY_RE.test(row[5]) && INT_RE.test(row[6]))) continue;

    // nome do estabelecimento: primeira linha de 1 célula, depois desta,
    // que não seja "Total" (a tabela costuma se repetir logo abaixo).
    let estabelecimento = null;
    for (let j = i + 1; j < Math.min(i + 8, matriz.length); j++) {
      const r = matriz[j];
      if (r && r.length === 1 && r[0].trim() && norm(r[0]) !== "total") { estabelecimento = r[0].trim(); break; }
    }
    return {
      fatBruto: parseMoedaBR(row[0]), torqueBruto: parseMoedaBR(row[1]), faturamento: parseMoedaBR(row[2]),
      ppd: parseNumeroBR(row[3]), torque: parseMoedaBR(row[4]), perdas: parseMoedaBR(row[5]), produtosFuncionais: parseQuantidadeBR(row[6]),
      estabelecimento,
    };
  }
  return null;
}

/**
 * "Fat. sanduíches/saladas" (card do topo do Relatório de Produtos) + o
 * "% do fat. total" que o PDF calcula ao lado. Best-effort: null se o card
 * não aparecer. NÃO é usado no cálculo do mix — é exibição/auditoria.
 *   linha i    : ["Fat. sanduíches/saladas"]
 *   linha i+1  : ["$", "2.648,56"]           (moeda, células podem vir separadas)
 *   linha i+2  : ["68,0%", "do fat. total"]  (percentual + rótulo)
 * @param {string[][]} matriz
 * @returns {{valor: number|null, pct: number|null}}
 */
function extrairFatSanduichesSaladas(matriz) {
  for (let i = 0; i < matriz.length; i++) {
    const alvo = normCel((matriz[i] || []).join(" "));
    if (!/fat.{0,4}sanduiches.{0,4}saladas/.test(alvo)) continue;
    let valor = null, pct = null;
    for (let j = i + 1; j < Math.min(i + 4, matriz.length); j++) {
      const cells = (matriz[j] || []).map((c) => String(c));
      if (valor == null && ehMoeda(cells.join(""))) valor = parseMoedaBR(cells.join(""));
      if (pct == null) {
        const pctCell = cells.find((c) => PCT_CELULA_RE.test(c.trim()));
        if (pctCell && cells.some((c) => /do fat/i.test(c))) pct = parsePercentualBR(pctCell);
      }
    }
    if (valor != null || pct != null) return { valor, pct };
  }
  return { valor: null, pct: null };
}

/**
 * Total de ITENS da tabela "Indicadores por categoria" (SANDUÍCHES E SALADAS
 * + BEBIDAS + OUTROS + ADICIONAIS + DIVERSOS). Escopado DEPOIS da âncora
 * "Indicadores por categoria" e exige a linha "Total <int> <moeda> ...".
 * Best-effort: null se não achar. Exibição/auditoria — não entra no cálculo.
 * @param {string[][]} matriz
 * @returns {number|null}
 */
function extrairTotalItensCategoria(matriz) {
  const idx = matriz.findIndex((r) => normCel((r || [])[0] || "") === "indicadores por categoria");
  if (idx < 0) return null;
  for (let j = idx + 1; j < Math.min(idx + 16, matriz.length); j++) {
    const row = matriz[j] || [];
    if (row.length >= 3 && ehRotuloDe("total", normCel(row[0]))) {
      const n = parseQuantidadeBR(row[1]);
      if (n != null && ehMoeda(row[2])) return n;
    }
  }
  return null;
}

/**
 * Localiza as quantidades do Mix de Vendas — Sanduíches/Saladas, Bebidas,
 * Adicionais, Diversos — SEMPRE pelo nome de cada categoria, nunca pela
 * posição da linha (uma categoria pode vir em qualquer ordem entre
 * relatórios diferentes).
 *
 * Estratégia em 2 passos:
 *   1. Escopado à seção "% de acompanhamentos em vendas principais" — é
 *      onde a Visio sempre publica a quantidade de verdade, e escopar evita
 *      confundir com a tabela de REFERÊNCIA de mercado ("Como deve ser meu
 *      Mix de vendas?"), que aparece antes e também usa os mesmos rótulos,
 *      mas só com percentuais de benchmark (nunca quantidade).
 *   2. Fallback: documento inteiro, só para as categorias que a seção não
 *      resolveu. Seguro mesmo assim porque o valor buscado nunca tem "%"
 *      (ver numeroPuro) — a tabela de referência não pode ser confundida
 *      com a quantidade real mesmo sendo revarrida.
 *
 * Exportada (só ela, entre as funções internas deste arquivo) para dar pra
 * testar a resiliência — ordem trocada, rótulo quebrado, etc. — direto
 * contra uma matriz sintética, sem precisar de um PDF de verdade pra cada
 * variação de layout (ver bonificacao-mensal-visio-parser.test.js).
 *
 * @param {string[][]} matrizOriginal
 * @param {string} rotulo "Geral" | "Loja" | outro — só para os logs/erros
 */
export function extrairMixVendas(matrizOriginal, rotulo) {
  const matriz = fundirRotulosQuebrados(matrizOriginal);

  const idxSecao = matriz.findIndex((r) => r.some((c) => normCel(c) === ANCORA_SECAO || normCel(c).includes(ANCORA_SECAO)));
  logDebug(`[${rotulo}] seção "% de acompanhamentos em vendas principais": ${idxSecao >= 0 ? `encontrada na linha ${idxSecao}` : "NÃO encontrada — indo direto para o fallback no documento inteiro"}.`);

  let valores = {};
  if (idxSecao >= 0) {
    const r1 = buscarCategoriasPorNome(matriz, idxSecao, idxSecao + 15);
    valores = r1.valores;
    r1.log.forEach((l) => logDebug(`[${rotulo}] (seção)`, l));
  }

  const faltandoNaSecao = CATEGORIAS_MIX.filter((c) => valores[c] == null);
  if (faltandoNaSecao.length) {
    logDebug(`[${rotulo}] fallback (documento inteiro) para: ${faltandoNaSecao.map((c) => ROTULO_CATEGORIA[c]).join(", ")}.`);
    const r2 = buscarCategoriasPorNome(matriz, 0, matriz.length);
    r2.log.forEach((l) => logDebug(`[${rotulo}] (documento inteiro)`, l));
    valores = { ...r2.valores, ...valores }; // o que já foi achado na seção principal tem prioridade
  }

  const faltando = CATEGORIAS_MIX.filter((c) => valores[c] == null);
  if (faltando.length) logDebug(`[${rotulo}] categorias não localizadas: ${faltando.map((c) => ROTULO_CATEGORIA[c]).join(", ")}.`);

  const percentuais = idxSecao >= 0 ? buscarPercentuaisDoTotal(matriz, idxSecao, idxSecao + 15) : {};

  return {
    sanduichesSaladas: valores.sanduiches ?? null,
    bebidas: valores.bebidas ?? null,
    adicionais: valores.adicionais ?? null,
    diversos: valores.diversos ?? null,
    ...percentuais,
    faltando: faltando.map((c) => ROTULO_CATEGORIA[c]),
  };
}

/**
 * Parser central do "Relatório de Produtos" da Visio (Loja/Balcão ou Geral —
 * o parser é agnóstico ao canal; quem decide o canal é o fluxo posterior).
 * @param {Buffer} buf
 * @param {{rotulo?: string}} [opts] rotulo = "Geral"/"Loja" — só enriquece as
 *   mensagens de erro; nunca muda a lógica.
 * @returns {Promise<{
 *   tipo: 'produtos',
 *   estabelecimento: string|null, faturamento: number, ppd: number,
 *   torque: number|null, perdas: number|null, produtosFuncionais: number|null,
 *   fatSanduichesSaladas: number|null, pctFatSanduichesSaladas: number|null, totalItens: number|null,
 *   sandwichesSalads: number, beverages: number, additions: number, miscellaneous: number,
 *   percentualBebidasPdf: number|null, percentualAdicionaisPdf: number|null, percentualDiversosPdf: number|null,
 *   hash: string
 * }>}
 */
export async function parseVisioProductReport(buf, opts = {}) {
  const rotulo = opts.rotulo || null;
  const alvo = rotulo ? `no campo do Relatório ${rotulo}` : "neste relatório";
  const matriz = await matrizDePdf(buf);

  // F2 item 1 — recusa explícita de um "Relatório de Vendas" neste slot.
  exigirTipo(matriz, "produtos", alvo);

  const torque = extrairTorquePorEstabelecimento(matriz);
  if (!torque) {
    logDebug(`[${rotulo ?? "?"}] tabela "Torque por estabelecimento" não localizada — motivo mais comum: layout não é um Relatório de Produtos.`);
    throw ApiError.badRequest(`Não foi possível localizar o faturamento e o PPD ${alvo}. Confira se é um "Relatório de Produtos" exportado da Visio.`);
  }

  const mix = extrairMixVendas(matriz, rotulo ?? "?");
  if (mix.faltando.length) {
    const plural = mix.faltando.length > 1 ? "as quantidades de" : "a quantidade de";
    throw ApiError.badRequest(`Não foi possível localizar ${plural} ${listarPt(mix.faltando)} ${alvo}.`);
  }
  // Garantia dura (item 5): as 4 quantidades JÁ são inteiros não-negativos aqui
  // (parseQuantidadeBR devolve null pra qualquer coisa que não seja — e null
  // já teria caído em `faltando` acima). Este assert é só a rede de segurança
  // pra nunca deixar um não-inteiro seguir pro cálculo de percentual ou pro INSERT.
  for (const [k, val] of [["Sanduíches/Saladas", mix.sanduichesSaladas], ["Bebidas", mix.bebidas], ["Adicionais", mix.adicionais], ["Diversos", mix.diversos]]) {
    if (!Number.isInteger(val) || val < 0) {
      throw ApiError.badRequest(`O número de ${k} lido ${alvo} (${val}) não é uma quantidade inteira válida. Confira o relatório.`);
    }
  }

  const fatSand = extrairFatSanduichesSaladas(matriz);

  return {
    tipo: "produtos",
    estabelecimento: torque.estabelecimento,
    faturamento: torque.faturamento,          // faturamento (Loja) — tabela Torque
    ppd: torque.ppd,
    torque: torque.torque,                     // NOVO — Torque líquido
    perdas: torque.perdas,                     // NOVO
    produtosFuncionais: torque.produtosFuncionais, // NOVO (7ª coluna da tabela Torque)
    fatSanduichesSaladas: fatSand.valor,       // NOVO — "Fat. sanduíches/saladas"
    pctFatSanduichesSaladas: fatSand.pct,      // NOVO — "% do fat. total"
    totalItens: extrairTotalItensCategoria(matriz), // NOVO — Total de "Indicadores por categoria"
    sandwichesSalads: mix.sanduichesSaladas,
    beverages: mix.bebidas,
    additions: mix.adicionais,
    miscellaneous: mix.diversos,
    percentualBebidasPdf: mix.percentualBebidasPdf,
    percentualAdicionaisPdf: mix.percentualAdicionaisPdf,
    percentualDiversosPdf: mix.percentualDiversosPdf,
    hash: sha256(buf),
  };
}

// ---------------------------------------------------------------------
// "RELATÓRIO DE VENDAS" — novo formato do relatório Geral da Visio
// (substituiu o antigo "Relatório de Produtos" nesse slot; o Loja continua
// no formato antigo, parseVisioProductReport acima). Layout bem diferente:
// cards nomeados ("Faturamento"/"Cupons válidos"/"Cupons de vendas"/"Ticket
// médio") em vez da tabela "Torque por estabelecimento" — não tem PPD, mas
// tem Ticket Médio pela 1ª vez.
//
// Busca SEMPRE pelo nome do campo (normCel — já tolera espaço/acento/quebra
// de linha), nunca por posição — mesmo espírito de extrairMixVendas acima.
// ---------------------------------------------------------------------
const ROTULOS_VENDAS = {
  faturamento: [normCel("Faturamento")],
  cuponsValidos: [normCel("Cupons válidos")],
  cuponsVendas: [normCel("Cupons de vendas")],
  ticketMedio: [normCel("Ticket médio")],
};
const ANCORA_ESTABELECIMENTO_VENDAS = normCel("Detalhe de vendas por estabelecimento");
const ROTULOS_TABELA_ESTABELECIMENTO = new Set(["estabelecimento", "total", "vendas por estabelecimento"]);

/**
 * Testa se `s` (células já concatenadas, sem espaços) é um valor do tipo
 * pedido — devolve o número normalizado (pt-BR) ou null. Moeda usa
 * parseMoedaBR (decimal por vírgula); inteiro usa parseQuantidadeBR
 * ("2.089" → 2089, nunca 2.089).
 */
function valorDoTipo(s, tipo) {
  const j = String(s ?? "").replace(/\s+/g, "");
  if (tipo === "moeda") return MONEY_RE.test(j) ? parseMoedaBR(j) : null;
  return INT_RE.test(j) ? parseQuantidadeBR(j) : null;
}

/**
 * Acha o valor logo após um rótulo EXATO (linha de 1 célula, como nos cards
 * de resumo) — tolera o valor estar na mesma linha (rótulo + valor juntos)
 * OU na(s) linha(s) seguinte(s), item pedido explicitamente (12): não
 * depender da ordem dos elementos nem de quebras de linha.
 * @param {string[][]} matriz @param {string[]} aliasesNormalizados @param {'moeda'|'inteiro'} tipo
 */
function buscarValorAposRotulo(matriz, aliasesNormalizados, tipo) {
  for (let i = 0; i < matriz.length; i++) {
    const row = matriz[i] || [];
    if (!row.length) continue;
    if (!aliasesNormalizados.includes(normCel(row[0]))) continue;

    if (row.length > 1) {
      const v = valorDoTipo(row.slice(1).join(""), tipo);
      if (v != null) return v;
    }
    const prox = matriz[i + 1] || [];
    if (prox.length) {
      const v = valorDoTipo(prox.join(""), tipo);
      if (v != null) return v;
    }
  }
  return null;
}

/**
 * "Métodos de pagamento" do Relatório de Vendas — lista canônica
 * `[{ metodo, qtd, valor }]`. Persistida para conferência futura; NÃO entra
 * em nenhum cálculo de bonificação (F2 item 3). Best-effort: `[]` se a seção
 * não aparecer.
 *
 * OBS: a Visio pagina esta seção ("Página 1 de N") — o PDF exportado
 * costuma trazer só a 1ª página. O parser devolve o que estiver no
 * documento, sem inventar o resto.
 *   linha  : ["Método", "Quantidade", "Faturamento líquido", "↓"]   (header)
 *   linhas : ["IFOOD ONLINE", "147", "$ 6.649,45"]                  (uma por método)
 * @param {string[][]} matriz
 * @returns {Array<{metodo: string, qtd: number, valor: number}>}
 */
function extrairMetodosPagamento(matriz) {
  const idx = matriz.findIndex((r) => normCel((r || [])[0] || "") === normCel("Métodos de pagamento"));
  if (idx < 0) return [];
  let hdr = -1;
  for (let j = idx; j < Math.min(idx + 6, matriz.length); j++) {
    const n = (matriz[j] || []).map((c) => normCel(c));
    if (n.includes("metodo") && n.includes("quantidade")) { hdr = j; break; }
  }
  if (hdr < 0) return [];

  const out = [];
  for (let j = hdr + 1; j < matriz.length; j++) {
    const cells = (matriz[j] || []).map((c) => String(c).trim()).filter((c) => c && c !== "↓");
    if (cells.length < 3) break; // fim do bloco (ex.: "Resumo do faturamento")
    const metodo = cells[0];
    const qtd = parseQuantidadeBR(cells[1]);
    const valor = parseMoedaBR(cells[2]);
    if (!metodo || /^[\d.]/.test(metodo) || qtd == null || valor == null) break;
    out.push({ metodo, qtd, valor });
  }
  return out;
}

/** Nome do estabelecimento na tabela "Detalhe de vendas por estabelecimento" — mesmo princípio de extrairTorquePorEstabelecimento. */
function extrairEstabelecimentoVendas(matriz) {
  const idxAncora = matriz.findIndex((r) => r.some((c) => {
    const n = normCel(c);
    return n === ANCORA_ESTABELECIMENTO_VENDAS || n.includes(ANCORA_ESTABELECIMENTO_VENDAS);
  }));
  const inicio = idxAncora >= 0 ? idxAncora + 1 : 0;
  for (let i = inicio; i < Math.min(inicio + 25, matriz.length); i++) {
    const row = matriz[i] || [];
    if (row.length !== 1) continue;
    const norm = normCel(row[0]);
    if (!norm || ROTULOS_TABELA_ESTABELECIMENTO.has(norm) || /^\d/.test(norm)) continue;
    return row[0].trim();
  }
  return null;
}

/**
 * Parser do "Relatório de Vendas" da Visio (relatório GERAL / todos os
 * canais). Fonte oficial de Faturamento, Ticket Médio e Quantidade de
 * Vendas (= Cupons de vendas). Métodos de pagamento ficam disponíveis para
 * conferência futura — não entram em cálculo (F2 item 3).
 * @param {Buffer} buf
 * @param {{rotulo?: string}} [opts]
 * @returns {Promise<{
 *   tipo: 'vendas', estabelecimento: string|null, faturamento: number, ticketMedio: number,
 *   cuponsValidos: number|null, cuponsVendas: number|null,
 *   metodosPagamento: Array<{metodo:string, qtd:number, valor:number}>, hash: string
 * }>}
 */
export async function parseVisioSalesReport(buf, opts = {}) {
  const rotulo = opts.rotulo || null;
  const alvo = rotulo ? `no campo do Relatório ${rotulo}` : "neste relatório";
  const matriz = await matrizDePdf(buf);

  // F2 item 1 — recusa explícita de um "Relatório de Produtos" neste slot.
  exigirTipo(matriz, "vendas", alvo);

  const faturamento = buscarValorAposRotulo(matriz, ROTULOS_VENDAS.faturamento, "moeda");
  const ticketMedio = buscarValorAposRotulo(matriz, ROTULOS_VENDAS.ticketMedio, "moeda");
  const cuponsValidos = buscarValorAposRotulo(matriz, ROTULOS_VENDAS.cuponsValidos, "inteiro");
  const cuponsVendas = buscarValorAposRotulo(matriz, ROTULOS_VENDAS.cuponsVendas, "inteiro");
  const estabelecimento = extrairEstabelecimentoVendas(matriz);
  const metodosPagamento = extrairMetodosPagamento(matriz);

  const faltando = [];
  if (faturamento == null) faltando.push("o Faturamento");
  if (ticketMedio == null) faltando.push("o Ticket Médio");
  if (faltando.length) {
    logDebug(`[${rotulo ?? "?"}] Relatório de Vendas — campos não localizados: ${faltando.join(", ")}.`);
    throw ApiError.badRequest(`Não foi possível localizar ${listarPt(faltando)} ${alvo}. Confira se é um "Relatório de Vendas" exportado da Visio.`);
  }

  return { tipo: "vendas", estabelecimento, faturamento, ticketMedio, cuponsValidos, cuponsVendas, metodosPagamento, hash: sha256(buf) };
}

export const MAX_ARQUIVO = 15 * 1024 * 1024; // 15 MB por PDF — mesmo limite de vendas/sw-parser.js
// Teto COMBINADO dos PDFs de uma mesma operação (fechamento mensal manda 2).
// Fica abaixo do limite de corpo de 50 MB em base64
// (LIMITES_CORPO.bonificacaoMensalImportacao): quando os 2 passam
// individualmente (≤15 MB cada) mas juntos são grandes demais, a mensagem diz
// exatamente isso em vez de um 413 "Arquivo(s) grande(s)".
export const MAX_ARQUIVOS_COMBINADO = 25 * 1024 * 1024;

/** Decodifica e valida o PDF em base64 vindo do modal de importação. */
export function decodificarPdfVisio(arq, rotulo) {
  if (!/\.pdf$/i.test(arq?.nomeArquivo || "")) throw ApiError.badRequest(`O arquivo do Relatório ${rotulo} precisa ser um PDF.`);
  const buf = decodificarArquivo(arq, `Relatório ${rotulo}`);
  if (buf.length > MAX_ARQUIVO) throw ApiError.badRequest(`Arquivo do Relatório ${rotulo} acima de 15 MB.`);
  // assinatura mínima de PDF ("%PDF-") — nunca confiar só na extensão do nome.
  if (buf.slice(0, 5).toString("latin1") !== "%PDF-") throw ApiError.badRequest(`O arquivo do Relatório ${rotulo} não parece ser um PDF válido.`);
  return buf;
}

/** Teto combinado da operação (soma dos PDFs já decodificados). */
export function exigirLimiteCombinado(...bufs) {
  const total = bufs.reduce((s, b) => s + (b?.length || 0), 0);
  if (total > MAX_ARQUIVOS_COMBINADO) {
    throw ApiError.badRequest(
      `Os relatórios somam ${(total / (1024 * 1024)).toFixed(1)} MB (máximo 25 MB juntos). `
      + "Exporte um período menor ou reduza o tamanho de cada PDF.",
    );
  }
}
