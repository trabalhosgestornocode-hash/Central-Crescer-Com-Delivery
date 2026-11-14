// SAIPOS — principal fonte OPERACIONAL das vendas da loja. Quatro leitores, um por relatório.
// Regras: forma de pagamento NÃO é canal; o total do relatório de formas de pagamento NÃO é faturamento bruto;
// diferença entre relatórios é DETECTADA (aplicacao/importacoes.js → compararRelatoriosSaipos), nunca ajustada.
// Os valores financeiros do iFood são reconciliados com a apuração oficial do iFood (fontes/ifood.js), não com o SAIPOS.
import { somar, subtrair } from "../../dominio/dinheiro.js";
import { centavos, rotulo } from "../leitor.js";
import { DIVERGENCIA, conferirTotalDeclarado, diferenca } from "../motor.js";
import { classificarPorPalavras, col, definirFonte, formaDePagamento } from "./comum.js";

/** Canal de ORIGEM do pedido. Desconhecido fica nulo (pendência), nunca vira Balcão por padrão. */
export function canalSaipos(texto) {
  return classificarPorPalavras(texto, [
    ["IFOOD", ["ifood"]],
    ["ANOTA_AI", ["anota ai", "anotaai"]],
    ["BALCAO", ["balcao", "loja", "salao", "mesa", "retirada no balcao"]],
    ["OUTRO", ["delivery proprio", "telefone", "whatsapp", "site", "cardapio digital"]],
  ]);
}

const ehLinhaDeTotal = (campo) => (u) => /^total/.test(rotulo(u.bruto(campo)));
const CANCELADO = (texto) => /cancel/.test(rotulo(texto));

export const SAIPOS_VENDAS = definirFonte({
  fonte: "SAIPOS",
  tipoRelatorio: "SAIPOS_VENDAS",
  tipoDocumento: "RELATORIO_VENDAS",
  descricao: "relatório de vendas por pedido do SAIPOS",
  colunas: {
    pedido: col(["Pedido", "Nº Pedido", "Numero do pedido", "Código do pedido"]),
    data: col(["Data", "Data do pedido", "Data/Hora"]),
    canal: col(["Canal", "Canal de venda", "Origem"]),
    itens: col(["Itens", "Valor dos itens", "Subtotal"]),
    desconto: col(["Desconto", "Descontos"]),
    acrescimo: col(["Acréscimo", "Acréscimos"]),
    taxaEntrega: col(["Taxa de entrega", "Entrega"]),
    total: col(["Total", "Valor total", "Valor da venda"]),
    forma: col(["Forma de pagamento", "Pagamento"]),
    situacao: col(["Situação", "Status"]),
    autorizacao: col(["Autorização", "NSU", "Código de autorização"], false),
    loja: col(["Loja", "Estabelecimento"], false),
  },
  ehTotal: ehLinhaDeTotal("pedido"),
  lerTotal: (u) => ({ valorCentavos: u.valor("total") }),
  converter(u) {
    const quando = u.dataHora("data");
    const itens = u.valor("itens");
    const desconto = u.valor("desconto");
    const acrescimo = u.valor("acrescimo");
    const taxa = u.valor("taxaEntrega");
    const total = u.valor("total");
    const pedido = u.texto("pedido");
    if (u.erros.length) return null;
    const canalOriginal = u.bruto("canal");
    const formaOriginal = u.bruto("forma");
    return {
      tipoRegistro: "PEDIDO", idExterno: pedido, data: quando.data, valorCentavos: total,
      dados: {
        hora: quando.hora, canal: canalSaipos(canalOriginal), canalOriginal, formaPagamento: formaDePagamento(formaOriginal), formaOriginal,
        itensCentavos: itens, descontoCentavos: desconto, acrescimoCentavos: acrescimo, taxaEntregaCentavos: taxa, totalCentavos: total,
        cancelado: CANCELADO(u.bruto("situacao")), situacaoOriginal: u.bruto("situacao"),
        autorizacao: u.bruto("autorizacao") || null, estabelecimento: u.bruto("loja") || null,
      },
    };
  },
  fechar(registros, { declarados }) {
    const divergencias = [];
    for (const r of registros) {
      const d = r.dados;
      const calculado = subtrair(somar(d.itensCentavos, d.acrescimoCentavos, d.taxaEntregaCentavos), d.descontoCentavos);
      if (calculado !== d.totalCentavos) divergencias.push(diferenca(DIVERGENCIA.LINHA_NAO_FECHA, `Pedido ${r.idExterno}: itens − desconto + acréscimo + entrega não fecha com o total.`, calculado, d.totalCentavos, { linha: r.linha }));
      if (!d.canal) divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `Pedido ${r.idExterno}: canal "${d.canalOriginal}" não reconhecido.`, linha: r.linha });
    }
    const validos = (r) => !r.dados.cancelado;
    const total = conferirTotalDeclarado(registros, declarados, { tipoRegistro: "PEDIDO", rotuloTotal: "total de vendas", filtro: validos });
    const porCanal = {};
    for (const r of registros.filter(validos)) porCanal[r.dados.canal ?? "NAO_IDENTIFICADO"] = somar(porCanal[r.dados.canal ?? "NAO_IDENTIFICADO"] ?? 0, r.valorCentavos);
    const cancelados = registros.filter((r) => r.dados.cancelado);
    return {
      controles: {
        faturamentoCentavos: total.encontrado, pedidosValidos: registros.length - cancelados.length,
        canceladosCentavos: cancelados.reduce((s, r) => somar(s, r.valorCentavos), 0), porCanal,
      },
      divergencias: [...divergencias, ...total.divergencias],
    };
  },
});

/** Leitor de relatório de TOTAIS (uma linha por canal, por forma ou por dia). Sem identificador da fonte: impressão digital. */
function relatorioDeTotais({ tipoRelatorio, descricao, tipoRegistro, chave, rotulos, usaData = false }) {
  return definirFonte({
    fonte: "SAIPOS",
    tipoRelatorio,
    tipoDocumento: "RELATORIO_VENDAS",
    descricao,
    colunas: { [chave]: col(rotulos), quantidade: col(["Quantidade", "Qtd", "Pedidos", "Quantidade de pedidos"], false), valor: col(["Valor", "Total", "Faturamento", "Valor total"]) },
    ehTotal: ehLinhaDeTotal(chave),
    lerTotal: (u) => ({ valorCentavos: u.valor("valor") }),
    converter(u) {
      const valor = u.valor("valor");
      const data = usaData ? u.data(chave) : null;
      if (u.erros.length) return null;
      const quantidade = u.bruto("quantidade") && /^\d+$/.test(u.bruto("quantidade")) ? Number(u.bruto("quantidade")) : null;
      const original = u.bruto(chave);
      const dados = { quantidade, [`${chave}Original`]: original };
      if (chave === "canal") dados.canal = canalSaipos(original);
      if (chave === "forma") dados.formaPagamento = formaDePagamento(original);
      // Data do registro de totais do período = último dia do período (preenchida pelo motor via periodo).
      return { tipoRegistro, idExterno: null, data: data ?? u.periodo.fim, valorCentavos: valor, dados, identidade: { tipoRegistro, chave: rotulo(original), inicio: u.periodo.inicio, fim: u.periodo.fim } };
    },
    fechar(registros, { declarados }) {
      const total = conferirTotalDeclarado(registros, declarados, { tipoRegistro, rotuloTotal: descricao });
      return { controles: { totalCentavos: total.encontrado }, divergencias: total.divergencias };
    },
  });
}

export const SAIPOS_VENDAS_POR_CANAL = relatorioDeTotais({
  tipoRelatorio: "SAIPOS_VENDAS_POR_CANAL", descricao: "relatório de vendas por canal do SAIPOS", tipoRegistro: "TOTAL_CANAL", chave: "canal", rotulos: ["Canal", "Canal de venda", "Origem"],
});
/**
 * Formas de pagamento — layout REAL conferido com setembro/2026 (XLSX: "Forma de pagamento", "Valor total dos pagamentos
 * (R$)", "Quantidade de pagamentos", "%" e uma coluna "Dia - dd/mm/aaaa" por dia). Confere total × soma dos dias por forma,
 * e a cobertura de dias × período declarado. Formas que não são meio de pagamento reconhecível ("Pagamento não
 * cadastrado", máquina de outra marca, voucher de desconto) ficam como pendência — nunca são somadas como venda em silêncio.
 */
const DIA_COLUNA = /^Dia - (\d{2})\/(\d{2})\/(\d{4})$/;
export const SAIPOS_FORMAS_PAGAMENTO = definirFonte({
  fonte: "SAIPOS",
  tipoRelatorio: "SAIPOS_FORMAS_PAGAMENTO",
  tipoDocumento: "RELATORIO_VENDAS",
  descricao: "relatório de formas de pagamento do SAIPOS",
  formatosHomologados: ["xlsx"],
  colunas: {
    forma: col(["Forma de pagamento", "Forma", "Pagamento"]),
    quantidade: col(["Quantidade de pagamentos", "Quantidade", "Qtd"], false),
    valor: col(["Valor total dos pagamentos (R$)", "Valor", "Total", "Valor total"]),
  },
  ehTotal: (u) => /^total/.test(rotulo(u.bruto("forma"))),
  lerTotal: (u) => ({ valorCentavos: u.valor("valor") }),
  converter(u) {
    const valor = u.valor("valor");
    if (u.erros.length) return null;
    const original = u.bruto("forma");
    const dias = {};
    for (const c of u.colunasPorPadrao(DIA_COLUNA)) {
      const [, d, m, a] = DIA_COLUNA.exec(c.rotulo);
      dias[`${a}-${m}-${d}`] = c.texto ? centavos(c.texto, c.rotulo) : 0;
    }
    const forma = formaDePagamento(original);
    const anomalia = !forma ? "FORMA_NAO_RECONHECIDA" : /desconto/.test(rotulo(original)) ? "FORMA_COM_NATUREZA_DE_DESCONTO" : null;
    return {
      tipoRegistro: "TOTAL_FORMA", idExterno: null, data: u.periodo.fim, valorCentavos: valor,
      dados: {
        formaOriginal: original, formaPagamento: forma, quantidade: /^\d+$/.test(u.bruto("quantidade")) ? Number(u.bruto("quantidade")) : null,
        porDia: dias, diasCobertos: Object.keys(dias).sort(), anomalia,
      },
      identidade: { tipoRegistro: "TOTAL_FORMA", chave: rotulo(original), inicio: u.periodo.inicio, fim: u.periodo.fim },
    };
  },
  fechar(registros, { declarados, periodo }) {
    const divergencias = [];
    const erros = [];
    let total = 0;
    const cobertos = new Set();
    for (const r of registros) {
      total = somar(total, r.valorCentavos);
      const dias = Object.entries(r.dados.porDia);
      dias.forEach(([d]) => cobertos.add(d));
      if (dias.length) {
        const soma = dias.reduce((s, [, v]) => somar(s, v), 0);
        if (soma !== r.valorCentavos) divergencias.push(diferenca(DIVERGENCIA.LINHA_NAO_FECHA, `Forma "${r.dados.formaOriginal}": total difere da soma dos dias.`, r.valorCentavos, soma, { linha: r.linha }));
      }
      if (r.dados.anomalia) divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `Forma "${r.dados.formaOriginal}": ${r.dados.anomalia}.`, linha: r.linha, valorCentavos: r.valorCentavos });
    }
    const fora = [...cobertos].filter((d) => d < periodo.inicio || d > periodo.fim);
    if (fora.length) erros.push({ codigo: "PERIODO_INCORRETO", mensagem: `O relatório tem ${fora.length} dia(s) fora do período declarado.`, linha: null, campo: "dia" });
    const esperados = Math.round((Date.parse(`${periodo.fim}T00:00:00Z`) - Date.parse(`${periodo.inicio}T00:00:00Z`)) / 86400000) + 1;
    if (cobertos.size && cobertos.size !== esperados) divergencias.push({ codigo: DIVERGENCIA.PERIODO_DO_DOCUMENTO, mensagem: `O relatório cobre ${cobertos.size} dia(s) de ${esperados} do período declarado.` });
    for (const d of declarados) if (d.valorCentavos !== total) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "A soma das formas não confere com o total declarado.", d.valorCentavos, total, { linha: d.linha }));
    const anomalas = registros.filter((r) => r.dados.anomalia);
    return {
      controles: {
        totalCentavos: total, formas: registros.length, diasCobertos: cobertos.size,
        anomaliasCentavos: anomalas.reduce((s, r) => somar(s, r.valorCentavos), 0), formasAnomalas: anomalas.map((r) => r.dados.formaOriginal),
      },
      divergencias,
      erros,
    };
  },
});
export const SAIPOS_VENDAS_DIARIAS = relatorioDeTotais({
  tipoRelatorio: "SAIPOS_VENDAS_DIARIAS", descricao: "relatório de vendas diárias do SAIPOS", tipoRegistro: "TOTAL_DIA", chave: "data", rotulos: ["Data", "Dia"], usaData: true,
});

// ------------------------------------------------------------------------------------------- SAIPOS: faturamento por dia (PDF)
// Layout REAL conferido com setembro/2026: tabela em PDF digital em que cada dia ocupa DUAS linhas de texto (a da data e
// a do fim do nome do dia da semana), e cada valor só se resolve pela POSIÇÃO horizontal da coluna. As âncoras das colunas
// vêm do próprio cabeçalho do relatório (palavras VENDAS, ACUMULADO, TICKET, ITENS, ENTREGA, SERVIÇO, ACRÉSCIMOS, DESCONTOS, CANC).
const COLUNAS_FATURAMENTO = ["Data", "Quantidade de vendas", "Valor das vendas", "Valor acumulado", "Ticket médio", "Total dos itens",
  "Taxa de entrega", "Taxa de serviço", "Acréscimos", "Descontos", "Cancelados"];
const DINHEIRO = /(-?\d{1,3}(?:\.\d{3})*,\d{2})/;

function ancorasDoCabecalho(documento) {
  for (const p of documento.paginas) {
    const frags = p.posicoes.flatMap((l) => l.partes);
    const x = (re, maior = false) => {
      const achados = frags.filter((f) => re.test(rotulo(f.texto))).map((f) => f.x).sort((a, b) => a - b);
      return achados.length ? (maior ? achados.at(-1) : achados[0]) : null;
    };
    const a = {
      quantidade: x(/^vend/), valor: x(/^vend/, true), acumulado: x(/^acumul/), ticket: x(/^ticke/), itens: x(/^itens$/),
      entrega: x(/^entrega$/), servico: x(/^ser$|^servico/), acrescimos: x(/^acrescimos$/), descontos: x(/^descont/), cancelados: x(/^canc/),
    };
    if (Object.values(a).every((v) => v !== null) && a.valor > a.quantidade) return a;
  }
  return null;
}

export function tabelaDoPdfFaturamento(documento) {
  const avisos = [];
  const ancoras = ancorasDoCabecalho(documento);
  if (!ancoras) return { linhas: [], avisos: [{ codigo: "LINHA_NAO_INTERPRETADA", mensagem: "Cabeçalho do relatório de faturamento por dia não encontrado.", linha: null }] };
  const nomes = Object.keys(ancoras);
  const linhas = [COLUNAS_FATURAMENTO];
  for (const p of documento.paginas) {
    const usadas = new Set();
    const comValores = (l) => l.partes.some((f) => DINHEIRO.test(f.texto));
    // Linha de dia = começa com data E traz valores (a data solta do cabeçalho do relatório não é dia). Linha TOTAL também.
    const datas = p.posicoes.filter((l) => comValores(l) && (/^\d{2}\/\d{2}\/\d{4}$/.test(l.partes[0]?.texto ?? "") || /^total/.test(rotulo(l.texto.replace(/\s+/g, "")))));
    for (const ld of datas) {
      // A segunda linha do dia é a vizinha mais próxima (até 16 pontos) que não começa com data.
      const par = p.posicoes
        .filter((l) => l !== ld && !usadas.has(l) && !/^\d{2}\/\d{2}\/\d{4}$/.test(l.partes[0]?.texto ?? "") && Math.abs(l.y - ld.y) <= 16 && l.partes.some((f) => DINHEIRO.test(f.texto)))
        // Preferência pela linha logo ACIMA na coordenada do PDF (onde o relatório põe o resto da célula); depois a mais próxima.
        .sort((a, b) => (b.y > ld.y) - (a.y > ld.y) || Math.abs(a.y - ld.y) - Math.abs(b.y - ld.y))[0];
      if (par) usadas.add(par);
      const valores = {};
      for (const f of [...ld.partes.slice(1), ...(par?.partes ?? [])]) {
        const dinheiro = DINHEIRO.exec(f.texto)?.[1];
        const inteiro = /^\d+$/.test(f.texto.trim()) && !/^total/.test(rotulo(f.texto)) ? f.texto.trim() : null;
        if (!dinheiro && !inteiro) continue;
        const coluna = inteiro ? "quantidade" : nomes.filter((n) => n !== "quantidade").sort((a, b) => Math.abs(ancoras[a] - f.x) - Math.abs(ancoras[b] - f.x))[0];
        if (valores[coluna] !== undefined) avisos.push({ codigo: "LINHA_NAO_INTERPRETADA", mensagem: `Dia ${ld.partes[0].texto}: dois valores na coluna ${coluna}.`, linha: null });
        valores[coluna] = dinheiro ?? inteiro;
      }
      const d = ld.partes[0].texto;
      const rotuloDaLinha = /^\d{2}\/\d{2}\/\d{4}$/.test(d) ? `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}` : "TOTAL";
      linhas.push([rotuloDaLinha, ...nomes.map((n) => valores[n] ?? "")]);
    }
  }
  return { linhas, avisos };
}

export const SAIPOS_FATURAMENTO_POR_DIA = definirFonte({
  fonte: "SAIPOS",
  tipoRelatorio: "SAIPOS_FATURAMENTO_POR_DIA",
  tipoDocumento: "RELATORIO_VENDAS",
  descricao: "relatório de faturamento por dia do SAIPOS (PDF)",
  formatosHomologados: ["pdf"],
  formatos: Object.freeze(["pdf"]),
  tabelaDoPdf: tabelaDoPdfFaturamento,
  ehTotal: (u) => /^total/.test(rotulo(u.bruto("data"))),
  lerTotal: (u) => ({ valorCentavos: u.valor("valor", { opcional: true }), descontosCentavos: u.valor("descontos", { opcional: true }), quantidade: u.bruto("quantidade") ? Number(u.bruto("quantidade")) : null }),
  colunas: {
    data: col(["Data"]), quantidade: col(["Quantidade de vendas"], false), valor: col(["Valor das vendas"]), acumulado: col(["Valor acumulado"]),
    ticket: col(["Ticket médio"], false), itens: col(["Total dos itens"], false), entrega: col(["Taxa de entrega"], false), servico: col(["Taxa de serviço"], false),
    acrescimos: col(["Acréscimos"], false), descontos: col(["Descontos"], false), cancelados: col(["Cancelados"], false),
  },
  converter(u) {
    const data = u.data("data");
    const valor = u.valor("valor");
    const acumulado = u.valor("acumulado");
    const opc = (c) => u.valor(c, { opcional: true }) ?? 0;
    const comp = { itensCentavos: opc("itens"), taxaEntregaCentavos: opc("entrega"), taxaServicoCentavos: opc("servico"), acrescimosCentavos: opc("acrescimos"), descontosCentavos: opc("descontos"), canceladosCentavos: opc("cancelados"), ticketMedioCentavos: opc("ticket") };
    if (u.erros.length) return null;
    return {
      tipoRegistro: "TOTAL_DIA", idExterno: null, data, valorCentavos: valor,
      dados: { quantidadeVendas: u.bruto("quantidade") ? Number(u.bruto("quantidade")) : null, acumuladoCentavos: acumulado, ...comp },
      identidade: { tipoRegistro: "TOTAL_DIA", data, relatorio: "FATURAMENTO_POR_DIA" },
    };
  },
  fechar(registros, { periodo, declarados }) {
    const divergencias = [];
    const ordem = [...registros].sort((a, b) => (a.data < b.data ? -1 : 1));
    let acumulado = 0;
    const soma = { faturamento: 0, itens: 0, entrega: 0, servico: 0, acrescimos: 0, descontos: 0, cancelados: 0, vendas: 0 };
    for (const r of ordem) {
      acumulado = somar(acumulado, r.valorCentavos);
      if (r.dados.acumuladoCentavos !== acumulado) {
        divergencias.push(diferenca(DIVERGENCIA.LINHA_NAO_FECHA, `Dia ${r.data}: valor acumulado não encadeia com os valores diários.`, acumulado, r.dados.acumuladoCentavos, { linha: r.linha }));
        acumulado = r.dados.acumuladoCentavos;
      }
      soma.faturamento = somar(soma.faturamento, r.valorCentavos);
      soma.itens = somar(soma.itens, r.dados.itensCentavos);
      soma.entrega = somar(soma.entrega, r.dados.taxaEntregaCentavos);
      soma.servico = somar(soma.servico, r.dados.taxaServicoCentavos);
      soma.acrescimos = somar(soma.acrescimos, r.dados.acrescimosCentavos);
      soma.descontos = somar(soma.descontos, r.dados.descontosCentavos);
      soma.cancelados = somar(soma.cancelados, r.dados.canceladosCentavos);
      soma.vendas += r.dados.quantidadeVendas ?? 0;
    }
    for (const t of declarados) {
      if (t.valorCentavos !== null && t.valorCentavos !== soma.faturamento) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "Total do relatório difere da soma dos dias.", t.valorCentavos, soma.faturamento, { linha: t.linha }));
      if (t.descontosCentavos !== null && t.descontosCentavos !== soma.descontos) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "Total de descontos do relatório difere da soma dos dias.", t.descontosCentavos, soma.descontos, { linha: t.linha }));
      if (t.quantidade !== null && t.quantidade !== soma.vendas) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "Quantidade total de vendas difere da soma dos dias.", t.quantidade, soma.vendas, { linha: t.linha }));
    }
    const dias = new Set(registros.map((r) => r.data));
    const esperados = Math.round((Date.parse(`${periodo.fim}T00:00:00Z`) - Date.parse(`${periodo.inicio}T00:00:00Z`)) / 86400000) + 1;
    if (dias.size !== esperados) divergencias.push({ codigo: DIVERGENCIA.PERIODO_DO_DOCUMENTO, mensagem: `O relatório cobre ${dias.size} dia(s) de ${esperados} do período declarado.` });
    return {
      controles: {
        dias: dias.size, faturamentoCentavos: soma.faturamento, acumuladoFinalCentavos: ordem.at(-1)?.dados.acumuladoCentavos ?? null,
        totalItensCentavos: soma.itens, taxaEntregaCentavos: soma.entrega, taxaServicoCentavos: soma.servico, acrescimosCentavos: soma.acrescimos,
        descontosCentavos: soma.descontos, canceladosCentavos: soma.cancelados, quantidadeVendas: soma.vendas,
        totalDeclarado: declarados[0] ? { valorCentavos: declarados[0].valorCentavos, descontosCentavos: declarados[0].descontosCentavos, quantidade: declarados[0].quantidade } : null,
      },
      divergencias,
    };
  },
});

export const FONTES_SAIPOS = Object.freeze([SAIPOS_VENDAS, SAIPOS_VENDAS_POR_CANAL, SAIPOS_FORMAS_PAGAMENTO, SAIPOS_VENDAS_DIARIAS, SAIPOS_FATURAMENTO_POR_DIA]);
