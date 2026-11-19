// SWF (sistema de frente de loja da Subway) — relatórios 03, 45 e 76, layout REAL conferido com a exportação XLSX de
// 01–17/11/2026 de uma loja Subway (o SWF imprime o nome e o código da loja; o nome é o que se cadastra em lojasSwf).
//
//   03 "Faturamento por tipo de pagamento": total do PERÍODO por forma de pagamento (todos os canais juntos).
//   45 "Análise de faturamento": uma linha por DIA com a composição (produtos, entregas, descontos, combos...) de TODOS os canais.
//   76 "Vendas por canais/lojas": total do PERÍODO por canal (Delivery: 99Food, iFood; Salão: Balcão), quantidade e valor.
//
// Regras (decisão do proprietário, 19/11/2026):
//   - o SWF só RECONHECE faturamento do canal Balcão/Presencial (relatório 76). iFood e 99Food vêm das fontes oficiais das
//     plataformas: no SWF ficam só como conferência (nunca receita — sem duplicar);
//   - os relatórios 03 e 45 são CONTROLE: não geram receita (misturam canais); servem para conferir o 76 e o dia a dia;
//   - nenhum valor é repartido por dia: o 76 é total do período; o 45 tem dia, mas não separa canal;
//   - formas de pagamento da loja (cartão, dinheiro, Pix) também recebem pedidos de plataforma pagos na entrega: a diferença
//     entre essas formas e o Balcão fica PENDENTE de investigação, sem presumir equivalência.
//
// Fonte gravada = "OUTRO" (o check de fv2_importacao.fonte não aceita SWF e migração exige autorização); o tipo do relatório
// (SWF_*) identifica o sistema, como na 99Food.
import { DIVERGENCIA, diferenca } from "../motor.js";
import { centavos, rotulo } from "../leitor.js";
import { col, definirFonte } from "./comum.js";
import { somar } from "../../dominio/dinheiro.js";
import { SWF_SANGRIAS_ADAPTADOR } from "./swfSangrias.js";

export const SWF_PAGAMENTOS = "SWF_PAGAMENTOS";
export const SWF_ANALISE_FATURAMENTO = "SWF_ANALISE_FATURAMENTO";
export const SWF_CANAIS = "SWF_CANAIS";
export const RELATORIOS_SWF = Object.freeze([SWF_PAGAMENTOS, SWF_ANALISE_FATURAMENTO, SWF_CANAIS, "SWF_SANGRIAS"]);
export const ehRelatorioSwf = (tipo) => RELATORIOS_SWF.includes(tipo);

const PERIODO_DOC = /(\d{2})\/(\d{2})\/(\d{4})\s*a\s*(\d{2})\/(\d{2})\/(\d{4})/;
const DATA_BR = /^\d{2}\/\d{2}\/\d{4}$/;
const iso = (d, m, a) => `${a}-${m}-${d}`;

/** Cabeçalho do documento (antes da tabela): nome da loja e período impresso pelo SWF. */
function cabecalhoDoDocumento(linhas, ate) {
  let periodo = null;
  let loja = null;
  for (let i = 0; i < Math.min(ate, linhas.length); i += 1) {
    for (const c of linhas[i]) {
      const t = String(c ?? "").trim();
      const m = PERIODO_DOC.exec(t);
      if (m && !periodo) periodo = { inicio: iso(m[1], m[2], m[3]), fim: iso(m[4], m[5], m[6]) };
      else if (/^subway\b/i.test(t) && !loja) loja = t.replace(/\s+/g, " ").toUpperCase();
    }
  }
  return { periodo, loja };
}

/** "R$ 1.234,56" → centavos (o SWF põe "R$" só nas linhas de total). */
const valorSwf = (texto, campo) => centavos(String(texto ?? "").replace(/^R\$\s*/, ""), campo);
/** Valor de linha de total: inválido vira ERRO da linha (nunca derruba a leitura nem é ignorado). */
function totalSwf(u, campo) {
  try { return valorSwf(u.bruto(campo), campo); } catch (e) { u.erro("VALOR_INVALIDO", e.message, campo); return null; }
}
/** "2.635" (milhar com ponto) ou "955" → inteiro; outro formato → null. */
const inteiroSwf = (t) => (/^\d{1,3}(\.\d{3})*$/.test(String(t ?? "").trim()) ? Number(String(t).trim().replaceAll(".", "")) : null);

/** Confere o período impresso no documento contra o período declarado na importação. */
function conferirPeriodoDoDocumento(u) {
  const ini = u.bruto("periodoInicioDoc");
  const fim = u.bruto("periodoFimDoc");
  if (!ini || !fim) return false; // o 76 não imprime o período: o declarado vale e fica divergência para conferência
  if (ini !== u.periodo.inicio || fim !== u.periodo.fim) u.erro("PERIODO_INCORRETO", `O relatório é de ${ini} a ${fim}, diferente do período declarado (${u.periodo.inicio} a ${u.periodo.fim}).`, "periodo");
  return true;
}

/** Acrescenta loja e período do cabeçalho do documento a cada linha a partir do cabeçalho da tabela. */
function anexarCabecalho(linhas, indiceCabecalho) {
  const { periodo, loja } = cabecalhoDoDocumento(linhas, indiceCabecalho);
  const largura = linhas[indiceCabecalho].length;
  return linhas.map((l, i) => {
    if (i < indiceCabecalho) return l;
    if (i === indiceCabecalho) return [...l, "LojaDoc", "PeriodoInicioDoc", "PeriodoFimDoc"];
    if (!l.some((c) => String(c ?? "").trim())) return []; // linha em branco continua em branco
    const base = Array.from({ length: largura }, (_, j) => l[j] ?? "");
    return [...base, loja ?? "", periodo?.inicio ?? "", periodo?.fim ?? ""];
  });
}
const COLUNAS_DOC = { lojaDoc: col(["LojaDoc"], false), periodoInicioDoc: col(["PeriodoInicioDoc"], false), periodoFimDoc: col(["PeriodoFimDoc"], false) };
const indiceOnde = (linhas, teste) => linhas.findIndex((l) => teste(l.map(rotulo)));

// ---------------------------------------------------------------------------------------------------------- 03 pagamentos
/**
 * Grupo da forma de pagamento do SWF. Formas da plataforma ("99 ONLINE", "IFOOD VOUCHER"...) foram pagas no app; as demais
 * (TEF, P.O.S, dinheiro, Pix) foram recebidas pela LOJA — no balcão OU na entrega de pedido de plataforma (não se presume qual).
 */
export function grupoDaFormaSwf(texto) {
  const r = rotulo(texto);
  if (/^99\b/.test(r) || r.includes("99food")) return { grupo: "PLATAFORMA_99FOOD", canal: "NOVENTA_E_NOVE_FOOD" };
  if (/^ifood\b/.test(r)) return { grupo: "PLATAFORMA_IFOOD", canal: "IFOOD" };
  if (r === "dinheiro") return { grupo: "RECEBIDO_PELA_LOJA", forma: "DINHEIRO" };
  if (r.includes("pix")) return { grupo: "RECEBIDO_PELA_LOJA", forma: "PIX" };
  if (r.includes("debito") || r.includes("maestro")) return { grupo: "RECEBIDO_PELA_LOJA", forma: "DEBITO" };
  if (r.includes("credito") || r.split(" ").includes("cred")) return { grupo: "RECEBIDO_PELA_LOJA", forma: "CREDITO" };
  if (r.includes("voucher")) return { grupo: "RECEBIDO_PELA_LOJA", forma: "VALE" };
  if (r.includes("cartao")) return { grupo: "RECEBIDO_PELA_LOJA", forma: "CARTAO_NAO_IDENTIFICADO" };
  return { grupo: "NAO_RECONHECIDA" };
}

export const SWF_PAGAMENTOS_ADAPTADOR = definirFonte({
  fonte: "OUTRO",
  tipoRelatorio: SWF_PAGAMENTOS,
  tipoDocumento: "RELATORIO_VENDAS",
  descricao: "relatório 03 do SWF (faturamento por tipo de pagamento)",
  formatosHomologados: ["xlsx"],
  colunas: { forma: col(["Forma de pagamento"]), valor: col(["Valor"]), ...COLUNAS_DOC },
  // O SWF mescla células: o rótulo "Forma de pagamento" e as formas ficam em colunas diferentes. Cada linha vira
  // [primeiro texto, último texto] — forma e valor (a linha de total só tem o valor).
  prepararTabela(linhas) {
    const i = indiceOnde(linhas, (r) => r.includes("forma de pagamento") && r.includes("valor"));
    if (i < 0) return linhas;
    let fim = false; // depois da linha de total vem só o rodapé de impressão (data, página): fica fora da tabela
    const compacta = linhas.map((l, k) => {
      if (k < i) return l;
      if (fim) return [];
      const cheias = l.map((c) => String(c ?? "").trim()).filter(Boolean);
      if (!cheias.length) return [];
      if (cheias.length === 1 && /^R\$/.test(cheias[0])) { fim = true; return ["", cheias[0]]; }
      if (cheias.length === 1) return [cheias[0], ""];
      return [cheias[0], cheias.at(-1)];
    });
    return anexarCabecalho(compacta, i);
  },
  // Linha sem forma: total ("R$ 1.234,56") ou rodapé de impressão (data/página) — nunca venda.
  ehTotal: (u) => !u.bruto("forma"),
  lerTotal: (u) => { if (u.bruto("forma") || !u.bruto("valor").trim()) return null; const v = totalSwf(u, "valor"); return v === null ? null : { valorCentavos: v }; },
  converter(u) {
    conferirPeriodoDoDocumento(u);
    const valor = u.valor("valor");
    if (u.erros.length) return null;
    const original = u.bruto("forma");
    const g = grupoDaFormaSwf(original);
    return {
      tipoRegistro: "TOTAL_FORMA_PERIODO", idExterno: `swf03:${rotulo(original)}:${u.periodo.inicio}:${u.periodo.fim}`, data: u.periodo.fim, valorCentavos: valor,
      dados: { formaOriginal: original, grupo: g.grupo, canalDaPlataforma: g.canal ?? null, formaPagamento: g.forma ?? null, estabelecimento: u.bruto("lojaDoc") || null, periodoInicio: u.periodo.inicio, periodoFim: u.periodo.fim },
    };
  },
  fechar(registros, { declarados }) {
    const divergencias = [];
    const porGrupo = {};
    for (const r of registros) {
      porGrupo[r.dados.grupo] = somar(porGrupo[r.dados.grupo] ?? 0, r.valorCentavos);
      if (r.dados.grupo === "NAO_RECONHECIDA") divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `Forma "${r.dados.formaOriginal}" não reconhecida.`, linha: r.linha, valorCentavos: r.valorCentavos });
    }
    const total = registros.reduce((s, r) => somar(s, r.valorCentavos), 0);
    for (const d of declarados) if (d.valorCentavos !== total) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "A soma das formas não confere com o total do relatório.", d.valorCentavos, total, { linha: d.linha }));
    return { controles: { swf: { relatorio: "03", totalCentavos: total, porGrupo, formas: registros.length } }, divergencias };
  },
});

// ---------------------------------------------------------------------------------------------------------- 45 análise
const COMPONENTES_45 = Object.freeze({
  produtos: { rotulos: ["Produtos"], sinal: 1 }, repiques: { rotulos: ["Repiques"], sinal: 1 }, servicos: { rotulos: ["Serviços", "Servicos"], sinal: 1 },
  entregas: { rotulos: ["Tx. Entregas", "Tx Entregas"], sinal: 1 }, creditos: { rotulos: ["Créditos", "Creditos"], sinal: -1 }, descontos: { rotulos: ["Descontos"], sinal: -1 },
  combos: { rotulos: ["Combos"], sinal: -1 }, especiais: { rotulos: ["Especiais"], sinal: -1 }, cortesias: { rotulos: ["Cortesias"], sinal: -1 }, assinadas: { rotulos: ["Assinadas"], sinal: -1 },
});
export const SWF_ANALISE_FATURAMENTO_ADAPTADOR = definirFonte({
  fonte: "OUTRO",
  tipoRelatorio: SWF_ANALISE_FATURAMENTO,
  tipoDocumento: "RELATORIO_VENDAS",
  descricao: "relatório 45 do SWF (análise de faturamento por dia)",
  formatosHomologados: ["xlsx"],
  colunas: {
    data: col(["Data"]), ...Object.fromEntries(Object.entries(COMPONENTES_45).map(([k, v]) => [k, col(v.rotulos)])),
    total: col(["Total"]), faturamento: col(["Faturamento"]), diferencaDoc: col(["Diferença", "Diferenca"], false), ...COLUNAS_DOC,
  },
  prepararTabela(linhas) {
    const i = indiceOnde(linhas, (r) => r.includes("data") && r.includes("faturamento") && r.includes("produtos"));
    return i < 0 ? linhas : anexarCabecalho(linhas, i);
  },
  // "(17)" = linha de total (quantidade de dias); data de impressão no rodapé = ignorada.
  ehTotal: (u) => !DATA_BR.test(u.bruto("data").trim()),
  lerTotal: (u) => { const m = /^\((\d+)\)$/.exec(u.bruto("data").trim()); if (!m) return null; const v = totalSwf(u, "faturamento"); return v === null ? null : { dias: Number(m[1]), faturamentoCentavos: v }; },
  converter(u) {
    conferirPeriodoDoDocumento(u);
    const data = u.data("data");
    const comp = Object.fromEntries(Object.keys(COMPONENTES_45).map((k) => [`${k}Centavos`, u.valor(k)]));
    const total = u.valor("total");
    const faturamento = u.valor("faturamento");
    if (u.erros.length) return null;
    const calculado = Object.entries(COMPONENTES_45).reduce((s, [k, v]) => s + v.sinal * comp[`${k}Centavos`], 0);
    return {
      tipoRegistro: "TOTAL_DIA_TODOS_CANAIS", idExterno: `swf45:${data}`, data, valorCentavos: faturamento,
      dados: { ...comp, totalCentavos: total, faturamentoCentavos: faturamento, composicaoCentavos: calculado, fecha: calculado === total && total === faturamento, estabelecimento: u.bruto("lojaDoc") || null, todosOsCanais: true },
    };
  },
  fechar(registros, { declarados, periodo }) {
    const divergencias = [];
    const erros = [];
    for (const r of registros.filter((x) => !x.dados.fecha)) divergencias.push(diferenca(DIVERGENCIA.LINHA_NAO_FECHA, `Dia ${r.data}: a composição não fecha com o faturamento.`, r.valorCentavos, r.dados.composicaoCentavos, { linha: r.linha }));
    const total = registros.reduce((s, r) => somar(s, r.valorCentavos), 0);
    for (const d of declarados) {
      if (d.faturamentoCentavos !== total) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "A soma dos dias não confere com o total do relatório.", d.faturamentoCentavos, total, { linha: d.linha }));
      if (d.dias !== registros.length) divergencias.push({ codigo: DIVERGENCIA.TOTAL_NAO_CONFERE, mensagem: `O relatório declara ${d.dias} dia(s) e traz ${registros.length}.`, linha: d.linha });
    }
    const esperados = Math.round((Date.parse(`${periodo.fim}T00:00:00Z`) - Date.parse(`${periodo.inicio}T00:00:00Z`)) / 86400000) + 1;
    if (registros.length !== esperados) divergencias.push({ codigo: DIVERGENCIA.PERIODO_DO_DOCUMENTO, mensagem: `O relatório traz ${registros.length} dia(s) de ${esperados} do período (dia sem linha fica sem registro, nunca zero).` });
    const soma = (k) => registros.reduce((s, r) => somar(s, r.dados[k]), 0);
    return {
      controles: { swf: { relatorio: "45", dias: registros.length, faturamentoCentavos: total, produtosCentavos: soma("produtosCentavos"), entregasCentavos: soma("entregasCentavos"), descontosCentavos: soma("descontosCentavos"), combosCentavos: soma("combosCentavos") } },
      divergencias, erros,
    };
  },
});

// ---------------------------------------------------------------------------------------------------------- 76 canais
/** Canal do SWF → canal do Financeiro. Desconhecido → null (fica pendência; nunca vira Balcão por suposição). */
export function canalSwf(texto) {
  const r = rotulo(texto);
  if (r === "balcao" || r === "presencial" || r === "salao") return "BALCAO";
  if (r === "ifood") return "IFOOD";
  if (r === "99food" || r === "99 food") return "NOVENTA_E_NOVE_FOOD";
  return null;
}
/**
 * O 76 tem cabeçalho em três níveis (grupo / canal / Qtd-Total) e uma coluna por canal. Vira uma tabela longa:
 * Loja | Grupo | Canal | Qtd | Total — uma linha por loja × canal, mais as linhas "Total Canal" e "Total" (controle).
 */
function tabelaLongaDo76(linhas) {
  const i = indiceOnde(linhas, (r) => r.filter((x) => x === "qtd").length >= 2 && r.includes("total"));
  // Os níveis de cabeçalho acima de Qtd/Total são as linhas NÃO vazias anteriores (o SWF intercala linhas em branco).
  const acima = linhas.slice(0, Math.max(i, 0)).filter((l) => l.some((c) => String(c ?? "").trim()));
  if (i < 0 || acima.length < 2) return linhas;
  const n3 = linhas[i].map(rotulo);
  const esquerda = (linha, j, min = 0) => { for (let k = j; k >= min; k -= 1) if (String(linha[k] ?? "").trim()) return { k, t: String(linha[k]).trim() }; return null; };
  const colunas = [];
  n3.forEach((r, j) => {
    if (r !== "qtd") return;
    const g = esquerda(acima.at(-2), j);
    const c = esquerda(acima.at(-1), j, g?.k ?? 0);
    const kTotal = n3.findIndex((x, k) => k > j && x === "total");
    if (kTotal > 0) colunas.push({ grupo: g?.t ?? "", canal: c?.t ?? g?.t ?? "", qtd: j, total: kTotal });
  });
  const { periodo } = cabecalhoDoDocumento(linhas, i);
  const saida = [["Loja", "Grupo", "Canal", "Qtd", "Total", "PeriodoInicioDoc", "PeriodoFimDoc"]];
  for (const l of linhas.slice(i + 1)) {
    const loja = String(l[0] ?? "").trim();
    if (!loja) continue;
    for (const c of colunas) saida.push([loja, c.grupo, c.canal, l[c.qtd] ?? "", l[c.total] ?? "", periodo?.inicio ?? "", periodo?.fim ?? ""]);
  }
  return saida;
}
const ehSubtotal = (u) => rotulo(u.bruto("canal")) === "total canal" || rotulo(u.bruto("grupo")) === "total";
const ehTotais = (u) => rotulo(u.bruto("loja")).startsWith("totais");
const lojaDo76 = (t) => { const m = /^(\d+)\s*-\s*(.+)$/.exec(String(t).trim()); return m ? { codigo: m[1], nome: m[2].replace(/\s+/g, " ").toUpperCase() } : { codigo: null, nome: String(t).trim().toUpperCase() }; };

export const SWF_CANAIS_ADAPTADOR = definirFonte({
  fonte: "OUTRO",
  tipoRelatorio: SWF_CANAIS,
  tipoDocumento: "RELATORIO_VENDAS",
  descricao: "relatório 76 do SWF (vendas por canal)",
  formatosHomologados: ["xlsx"],
  colunas: { loja: col(["Loja"]), grupo: col(["Grupo"]), canal: col(["Canal"]), quantidade: col(["Qtd"]), valor: col(["Total"]), periodoInicioDoc: col(["PeriodoInicioDoc"], false), periodoFimDoc: col(["PeriodoFimDoc"], false) },
  prepararTabela: tabelaLongaDo76,
  ehTotal: (u) => ehSubtotal(u) || ehTotais(u),
  lerTotal: (u) => { const v = totalSwf(u, "valor"); return v === null ? null : { loja: u.bruto("loja"), grupo: u.bruto("grupo"), canal: u.bruto("canal"), subtotal: ehSubtotal(u), totais: ehTotais(u), valorCentavos: v, quantidade: inteiroSwf(u.bruto("quantidade")) }; },
  converter(u) {
    const periodoNoDocumento = conferirPeriodoDoDocumento(u);
    const valor = u.valor("valor");
    const quantidade = inteiroSwf(u.bruto("quantidade"));
    if (quantidade === null) u.erro("VALOR_INVALIDO", "Qtd deve ser um número inteiro.", "quantidade");
    if (u.erros.length) return null;
    const loja = lojaDo76(u.bruto("loja"));
    const canalOriginal = u.bruto("canal");
    const canal = canalSwf(canalOriginal);
    return {
      tipoRegistro: "TOTAL_CANAL", idExterno: `swf76:${loja.codigo ?? rotulo(loja.nome)}:${rotulo(canalOriginal)}:${u.periodo.inicio}:${u.periodo.fim}`, data: u.periodo.fim, valorCentavos: valor,
      dados: {
        canal, canalOriginal, grupo: u.bruto("grupo"), quantidade, estabelecimento: loja.nome, lojaCodigo: loja.codigo, periodoInicio: u.periodo.inicio, periodoFim: u.periodo.fim,
        // Só o Balcão é faturamento pelo SWF; iFood e 99Food são conferência (a fonte oficial é a plataforma).
        papel: canal === "BALCAO" ? "RECEITA" : canal ? "CONFERENCIA" : "A_CLASSIFICAR", sistema: "SWF", periodoNoDocumento,
      },
    };
  },
  fechar(registros, { declarados }) {
    const divergencias = [];
    const porCanal = {};
    const quantidadePorCanal = {};
    for (const r of registros) {
      const k = r.dados.canal ?? "NAO_IDENTIFICADO";
      porCanal[k] = somar(porCanal[k] ?? 0, r.valorCentavos);
      quantidadePorCanal[k] = (quantidadePorCanal[k] ?? 0) + r.dados.quantidade;
      if (!r.dados.canal) divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `Canal "${r.dados.canalOriginal}" do SWF não reconhecido: não vira faturamento.`, linha: r.linha, valorCentavos: r.valorCentavos });
    }
    // Subtotais da própria loja: soma dos canais do grupo = "Total Canal" do grupo; soma de tudo = "Total".
    for (const d of declarados.filter((x) => x.subtotal && !x.totais)) {
      const daLoja = registros.filter((r) => r.original?.Loja === d.loja || lojaDo76(d.loja).nome === r.dados.estabelecimento);
      const doGrupo = rotulo(d.grupo) === "total" ? daLoja : daLoja.filter((r) => rotulo(r.dados.grupo) === rotulo(d.grupo));
      const soma = doGrupo.reduce((s, r) => somar(s, r.valorCentavos), 0);
      const qtd = doGrupo.reduce((s, r) => s + r.dados.quantidade, 0);
      if (soma !== d.valorCentavos) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, `Total do grupo ${d.grupo} não confere com a soma dos canais.`, d.valorCentavos, soma, { linha: d.linha }));
      if (d.quantidade !== null && qtd !== d.quantidade) divergencias.push({ codigo: DIVERGENCIA.TOTAL_NAO_CONFERE, mensagem: `Quantidade do grupo ${d.grupo}: ${d.quantidade} declarada, ${qtd} somada.`, linha: d.linha });
    }
    // Linha "Totais" (todas as lojas) por canal.
    for (const d of declarados.filter((x) => x.totais && !x.subtotal)) {
      const soma = registros.filter((r) => rotulo(r.dados.canalOriginal) === rotulo(d.canal)).reduce((s, r) => somar(s, r.valorCentavos), 0);
      if (soma !== d.valorCentavos) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, `Totais do canal ${d.canal} não conferem com a soma das lojas.`, d.valorCentavos, soma, { linha: d.linha }));
    }
    if (registros.some((r) => !r.dados.periodoNoDocumento)) divergencias.push({ codigo: DIVERGENCIA.PERIODO_DO_DOCUMENTO, mensagem: "O relatório 76 não imprime o período: confira se o arquivo é mesmo do período declarado (o 45 e o 03 do mesmo período ajudam a conferir)." });
    const total = registros.reduce((s, r) => somar(s, r.valorCentavos), 0);
    return { controles: { swf: { relatorio: "76", totalCentavos: total, porCanal, quantidadePorCanal, lojas: [...new Set(registros.map((r) => r.dados.estabelecimento))] } }, divergencias };
  },
});

export const FONTES_SWF = Object.freeze([SWF_PAGAMENTOS_ADAPTADOR, SWF_ANALISE_FATURAMENTO_ADAPTADOR, SWF_CANAIS_ADAPTADOR, SWF_SANGRIAS_ADAPTADOR]);
