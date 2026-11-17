// SAIPOS — principal fonte OPERACIONAL das vendas da loja. Quatro leitores, um por relatório.
// Regras: forma de pagamento NÃO é canal; o total do relatório de formas de pagamento NÃO é faturamento bruto;
// diferença entre relatórios é DETECTADA (aplicacao/importacoes.js → compararRelatoriosSaipos), nunca ajustada.
// Os valores financeiros do iFood são reconciliados com a apuração oficial do iFood (fontes/ifood.js), não com o SAIPOS.
import { formatarBRL, somar, subtrair } from "../../dominio/dinheiro.js";
import { centavos, rotulo } from "../leitor.js";
import { DIVERGENCIA, conferirTotalDeclarado, diferenca } from "../motor.js";
import { classificarPorPalavras, col, definirFonte, formaDePagamento } from "./comum.js";

/** Canal de ORIGEM do pedido. Desconhecido fica nulo (pendência), nunca vira Balcão por padrão. */
export function canalSaipos(texto) {
  return classificarPorPalavras(texto, [
    ["NOVENTA_E_NOVE_FOOD", ["99 food", "99food"]],
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
  // Layout REAL "Vendas por período" conferido com novembro/2026 (doc 39 §2, doc 41). CSV segue sintético.
  formatosHomologados: ["xlsx"],
  colunas: {
    pedido: col(["Pedido", "Nº Pedido", "Numero do pedido", "Código do pedido"]),
    data: col(["Data", "Data do pedido", "Data/Hora", "Data da venda"]),
    canal: col(["Canal", "Canal de venda", "Origem"]),
    itens: col(["Itens", "Valor dos itens", "Subtotal"]),
    desconto: col(["Desconto", "Descontos"]),
    acrescimo: col(["Acréscimo", "Acréscimos"]),
    taxaEntrega: col(["Taxa de entrega", "Entrega"]),
    total: col(["Total", "Valor total", "Valor da venda"]),
    forma: col(["Forma de pagamento", "Pagamento"]),
    // Layout sintético antigo: "Situação". Layout REAL "Vendas por período" (doc 39): "Está cancelado" (S/N).
    situacao: col(["Situação", "Status"], false),
    estaCancelado: col(["Está cancelado"], false),
    tipoPedido: col(["Tipo do pedido"], false),
    idParceiro: col(["Id do pedido no parceiro"], false),
    autorizacao: col(["Autorização", "NSU", "Código de autorização"], false),
    loja: col(["Loja", "Estabelecimento"], false),
  },
  ehTotal: ehLinhaDeTotal("pedido"),
  lerTotal: (u) => ({ valorCentavos: u.valor("total") }),
  converter(u) {
    const quando = u.dataHora("data");
    const itens = u.valor("itens");
    // Fichas presenciais do layout real vêm com entrega/acréscimo/desconto vazios: vazio = 0 (o total confere a fórmula).
    const desconto = u.valor("desconto", { opcional: true }) ?? 0;
    const acrescimo = u.valor("acrescimo", { opcional: true }) ?? 0;
    const taxa = u.valor("taxaEntrega", { opcional: true }) ?? 0;
    const total = u.valor("total");
    const pedido = u.texto("pedido");
    if (u.erros.length) return null;
    const layoutReal = u.bruto("tipoPedido") !== undefined && u.bruto("tipoPedido") !== null && u.bruto("tipoPedido") !== "";
    const canalOriginal = u.bruto("canal");
    const formaOriginal = u.bruto("forma");
    const pagamentosOriginais = String(formaOriginal ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    // Canal vazio + ficha (tipo F) no layout real = PRESENCIAL. Sem esse indício, canal vazio segue pendência (nunca Balcão por padrão).
    const tipo = String(u.bruto("tipoPedido") ?? "").trim().toUpperCase();
    const canal = canalSaipos(canalOriginal) ?? (layoutReal && !String(canalOriginal ?? "").trim() && tipo === "F" ? "BALCAO" : null);
    const idParceiro = String(u.bruto("idParceiro") ?? "").trim();
    // Identidade (doc 39 §2): integração → canal + id do pedido no parceiro; ficha (sem identificador) → impressão digital
    // dos campos da linha + ocorrência (o motor numera repetições idênticas); layout antigo → o número do pedido.
    const idExterno = idParceiro ? `${canal ?? rotulo(canalOriginal)}:${idParceiro}` : layoutReal ? null : pedido;
    const identidade = idExterno ? undefined : { tipoRegistro: "PEDIDO", data: quando.data, hora: quando.hora, tipo, canal: canalOriginal ?? null, total, itens, desconto, taxa, acrescimo, pagamento: formaOriginal ?? null };
    const cancelado = /^s/i.test(String(u.bruto("estaCancelado") ?? "").trim()) || CANCELADO(u.bruto("situacao"));
    return {
      tipoRegistro: "PEDIDO", idExterno, ...(identidade ? { identidade } : {}), data: quando.data, valorCentavos: total,
      dados: {
        hora: quando.hora, canal, canalOriginal, formaPagamento: pagamentosOriginais.length > 1 ? "MULTIPLAS" : formaDePagamento(formaOriginal), formaOriginal,
        pagamentosOriginais, tipoPedido: tipo || null, pedidoOriginal: pedido, idParceiro: idParceiro || null,
        itensCentavos: itens, descontoCentavos: desconto, acrescimoCentavos: acrescimo, taxaEntregaCentavos: taxa, totalCentavos: total,
        cancelado, situacaoOriginal: u.bruto("situacao") ?? u.bruto("estaCancelado") ?? null,
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
    // Quantos pedidos válidos de cada canal (a prévia por canal mostra valor E quantidade; iFood e 99Food só como conferência).
    const pedidosPorCanal = {};
    for (const r of registros.filter(validos)) { const k = r.dados.canal ?? "NAO_IDENTIFICADO"; pedidosPorCanal[k] = (pedidosPorCanal[k] ?? 0) + 1; }
    return {
      controles: {
        faturamentoCentavos: total.encontrado, pedidosValidos: registros.length - cancelados.length, pedidosCancelados: cancelados.length,
        canceladosCentavos: cancelados.reduce((s, r) => somar(s, r.valorCentavos), 0), porCanal, pedidosPorCanal,
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

/**
 * doc 34 — "Desempenho por atendente" do SAIPOS (layout REAL de setembro/2026: ATENDENTE, QUANTIDADE_VENDAS,
 * VALOR_TOTAL_VENDAS, CATEGORIA, ITEM, QUANTIDADE_ITEM, VALOR_TOTAL_ITEM). O total de vendas se repete em cada item do
 * atendente: um registro por ATENDENTE (repetições idênticas ficam como duplicadas no arquivo, nunca somadas). As
 * integrações identificam o canal; atendente humano é venda do Balcão (anotado como canal deduzido do atendente).
 * Valor é TOTAL DO PERÍODO por canal — sem pedido, sem forma de pagamento.
 */
export function canalDoAtendente(texto) {
  const r = rotulo(texto);
  if (r.startsWith("integration") && r.split(" ").includes("ifood")) return { canal: "IFOOD", deduzido: false };
  if (r.startsWith("integration api int sale") || r.includes("anota ai") || r.includes("anotaai")) return { canal: "ANOTA_AI", deduzido: false };
  if (r.startsWith("integration")) return { canal: null, deduzido: false };
  return { canal: "BALCAO", deduzido: true };
}
export const SAIPOS_DESEMPENHO_POR_ATENDENTE = definirFonte({
  fonte: "SAIPOS",
  tipoRelatorio: "SAIPOS_DESEMPENHO_POR_ATENDENTE",
  tipoDocumento: "RELATORIO_VENDAS",
  descricao: "relatório de desempenho por atendente do SAIPOS (canais de venda)",
  formatosHomologados: ["xlsx"],
  colunas: {
    atendente: col(["ATENDENTE", "Atendente"]),
    quantidade: col(["QUANTIDADE_VENDAS", "Quantidade de vendas"]),
    valor: col(["VALOR_TOTAL_VENDAS", "Valor total das vendas"]),
  },
  ehTotal: (u) => /^total/.test(rotulo(u.bruto("atendente"))),
  lerTotal: (u) => ({ valorCentavos: u.valor("valor") }),
  converter(u) {
    const valor = u.valor("valor");
    if (u.erros.length) return null;
    const original = u.bruto("atendente");
    const { canal, deduzido } = canalDoAtendente(original);
    return {
      tipoRegistro: "TOTAL_CANAL", idExterno: `atendente:${rotulo(original)}:${u.periodo.inicio}:${u.periodo.fim}`, data: u.periodo.fim, valorCentavos: valor,
      dados: { canal, canalOriginal: original, canalDeduzidoDoAtendente: deduzido, quantidade: /^\d+$/.test(u.bruto("quantidade")) ? Number(u.bruto("quantidade")) : null, periodoInicio: u.periodo.inicio, periodoFim: u.periodo.fim },
    };
  },
  fechar(registros) {
    const divergencias = [];
    const porCanal = {};
    for (const r of registros) {
      porCanal[r.dados.canal ?? "NAO_IDENTIFICADO"] = somar(porCanal[r.dados.canal ?? "NAO_IDENTIFICADO"] ?? 0, r.valorCentavos);
      if (!r.dados.canal) divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `Atendente "${r.dados.canalOriginal}": integração sem canal reconhecido.`, linha: r.linha, valorCentavos: r.valorCentavos });
    }
    return { controles: { totalCentavos: registros.reduce((s, r) => somar(s, r.valorCentavos), 0), porCanal, atendentes: registros.length }, divergencias };
  },
});

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

/**
 * De-para das formas do SAIPOS (rótulos REAIS do relatório de formas de pagamento) → venda do dia por forma: canal de
 * origem, forma, processador que fica devendo e se o dinheiro cai no caixa físico. Definido pelo proprietário (16/11/2026):
 * cartões de bandeira = maquininha Stone no balcão; "Pago Online via Pix" = maquininha do iFood na loja; "Pago Online"
 * (sem mais nada) = pedidos 99 Food; "Pix na Entrega" = Stone levada pelo entregador. Nulo = sem venda automática (fica
 * pendência): voucher de desconto (natureza a definir) e qualquer forma não listada — nunca é presumida.
 */
const DE_PARA_FORMAS = Object.freeze({
  "online ifood": { canal: "IFOOD", forma: "OUTRA", processador: "IFOOD" },
  "pago online via pix": { canal: "BALCAO", forma: "PIX", processador: "IFOOD", descricao: "Pix na maquininha do iFood" },
  dinheiro: { canal: "BALCAO", forma: "DINHEIRO", caixa: true },
  vale: { canal: "BALCAO", forma: "VALE", processador: "OPERADORA_BENEFICIOS" },
  "online anotaai": { canal: "ANOTA_AI", forma: "OUTRA", processador: "ANOTA_AI" },
  "online anota ai": { canal: "ANOTA_AI", forma: "OUTRA", processador: "ANOTA_AI" },
  "pago online": { canal: "OUTRO", forma: "OUTRA", processador: "OUTRO", descricao: "99 Food" },
  "pix na entrega": { canal: "OUTRO", forma: "PIX", processador: "STONE", descricao: "Pix na entrega (Stone com o entregador)" },
  "pagamento nao cadastrado": { canal: "OUTRO", forma: null, revisar: true, descricao: "Pagamento a identificar" },
});
export function deParaFormaSaipos(texto) {
  const r = rotulo(texto);
  const cartao = /^(debito|credito) (master|mastercard|visa|elo|amex|hipercard|hiper|diners|cabal|banescard)$/.exec(r);
  if (cartao) return { canal: "BALCAO", forma: cartao[1] === "debito" ? "DEBITO" : "CREDITO", processador: "STONE" };
  return DE_PARA_FORMAS[r] ?? null;
}

/**
 * Fase 03 (doc 41) — UMA descrição do campo "Pagamento" do relatório por pedido → pagamento da venda (sem canal: o canal é
 * a ORIGEM do pedido). `adquirente: true` = cartão cuja operadora (Stone/PagBank…) é decidida pela data (operadoraNaData).
 * Nulo = sem pagamento automático (fica pendência): voucher de desconto, "Online iFood" numa ficha, não cadastrado, desconhecida.
 * "Pago Online via Pix" = maquininha do iFood no balcão (D2, 17/11/2026); "Pix na Entrega" NÃO herda isso (Stone, de-para 16/11).
 */
export function pagamentoDaDescricaoSaipos(texto) {
  const r = rotulo(texto);
  const cartao = /^(debito|credito) (master|mastercard|visa|elo|amex|hipercard|hiper|diners|cabal|banescard)$/.exec(r);
  if (cartao) return { forma: cartao[1] === "debito" ? "DEBITO" : "CREDITO", bandeira: cartao[2], adquirente: true };
  const tabela = {
    dinheiro: { forma: "DINHEIRO", caixa: true },
    "pago online via pix": { forma: "PIX", processador: "MAQUININHA_IFOOD" },
    "pix na entrega": { forma: "PIX", processador: "STONE" },
    vale: { forma: "VALE", processador: "OPERADORA_BENEFICIOS" },
    "online anotaai": { forma: "OUTRA", processador: "ANOTA_AI", canais: ["ANOTA_AI"] },
    "online anota ai": { forma: "OUTRA", processador: "ANOTA_AI", canais: ["ANOTA_AI"] },
  };
  return tabela[r] ?? null;
}
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

// ------------------------------------------------------------------------------------------ movimentações de Frente de Caixa
/**
 * Natureza de uma movimentação de dinheiro em espécie das frentes de caixa. Só é reconhecida com TODOS os sinais do layout real
 * (descrição + conta Cofre + categoria Frente de Caixa + sinal do valor); qualquer dúvida vira DESCONHECIDA (pendência), nunca palpite.
 * Convenção do export (conta Cofre): valor POSITIVO = dinheiro que ENTRA no cofre (retirada do caixa); NEGATIVO = SAI do cofre (reforço).
 * Nenhuma dessas movimentações é receita, despesa ou faturamento: são transferências entre o caixa e o cofre.
 */
export const NATUREZA_MOVIMENTO_CAIXA = Object.freeze({ SANGRIA: "SANGRIA", REFORCO: "REFORCO", TRANSFERENCIA: "TRANSFERENCIA", DESCONHECIDA: "DESCONHECIDA" });

export function classificarMovimentoDeCaixa({ descricao, conta, categoria, valorCentavos }) {
  const d = rotulo(descricao);
  const noCofre = /(^| )cofre( |$)/.test(rotulo(conta));
  const frenteDeCaixa = rotulo(categoria).includes("frente de caixa");
  const N = NATUREZA_MOVIMENTO_CAIXA;
  const desconhecida = (motivo, anomalia = null) => ({ natureza: N.DESCONHECIDA, motivo, anomalia });
  if (!valorCentavos) return desconhecida("Valor zero.", "VALOR_ZERO");
  if (/^retirada de frente de caixa( |$)/.test(d)) {
    if (!noCofre || !frenteDeCaixa) return desconhecida("Descrição de retirada, mas a conta não é o Cofre ou a categoria não é Frente de Caixa.", "CONTA_OU_CATEGORIA_INESPERADA");
    if (valorCentavos < 0) return desconhecida("Retirada com valor negativo: o sinal contradiz a natureza.", "SINAL_INESPERADO");
    return { natureza: N.SANGRIA, motivo: "Retirada de Frente de Caixa para o Cofre.", anomalia: null };
  }
  if (/^reforco de frente de caixa( |$)/.test(d)) {
    if (!noCofre || !frenteDeCaixa) return desconhecida("Descrição de reforço, mas a conta não é o Cofre ou a categoria não é Frente de Caixa.", "CONTA_OU_CATEGORIA_INESPERADA");
    if (valorCentavos > 0) return desconhecida("Reforço com valor positivo: o sinal contradiz a natureza.", "SINAL_INESPERADO");
    return { natureza: N.REFORCO, motivo: "Reforço de Frente de Caixa, saído do Cofre.", anomalia: null };
  }
  if (/^transferencia( |$)/.test(d) && frenteDeCaixa) return { natureza: N.TRANSFERENCIA, motivo: "Transferência interna (origem e destino a confirmar: o export não os informa).", anomalia: null };
  return desconhecida("Descrição não reconhecida como retirada, reforço ou transferência.", "DESCRICAO_NAO_RECONHECIDA");
}

export const SAIPOS_MOVIMENTOS_CAIXA = definirFonte({
  fonte: "SAIPOS",
  tipoRelatorio: "SAIPOS_MOVIMENTOS_CAIXA",
  tipoDocumento: "OUTRO",
  descricao: "relatório Financeiro do SAIPOS (movimentações de Frente de Caixa)",
  // Layout REAL conferido com um export "Financeiro" exportado de uma loja (nov/2026). CSV segue sintético.
  formatosHomologados: ["xlsx"],
  colunas: {
    vencimento: col(["Vencimento"]),
    emissao: col(["Emissão", "Emissao"], false),
    pagamento: col(["Pagamento", "Data do pagamento"]),
    conta: col(["Conta"]),
    metodo: col(["Método de Pagamento", "Metodo de pagamento"], false),
    categoria: col(["Categoria"]),
    valor: col(["Valor"]),
    pago: col(["Pago", "Situação", "Situacao"]),
    fornecedor: col(["Fornecedor"], false),
    descricao: col(["Descrição", "Descricao"]),
  },
  converter(u) {
    const valor = u.valor("valor");
    const vencimento = u.data("vencimento");
    const pagamento = u.data("pagamento", { opcional: true });
    const emissao = u.data("emissao", { opcional: true });
    const descricao = u.texto("descricao");
    const conta = u.texto("conta");
    const categoria = u.texto("categoria");
    if (u.erros.length) return null;
    const pagoTexto = rotulo(u.bruto("pago"));
    const pago = ["sim", "pago", "s"].includes(pagoTexto) ? true : ["nao", "n", "pendente", "em aberto"].includes(pagoTexto) ? false : null;
    const classe = classificarMovimentoDeCaixa({ descricao, conta, categoria, valorCentavos: valor });
    const data = pagamento ?? vencimento;
    return {
      tipoRegistro: "MOVIMENTO_CAIXA", idExterno: null, data, valorCentavos: valor,
      dados: {
        natureza: classe.natureza, naturezaMotivo: classe.motivo, anomalia: classe.anomalia ?? (pago === null ? "PAGO_NAO_INTERPRETADO" : null),
        valorAbsolutoCentavos: Math.abs(valor), descricaoOriginal: descricao, contaOriginal: conta, categoriaOriginal: categoria,
        metodoPagamento: u.bruto("metodo") || null, fornecedor: u.bruto("fornecedor") || null,
        vencimento, emissao, pagamento, pago,
        // Só entra nos totais quando foi efetivamente pago E o sentido é conhecido. Transferência NÃO entra: o export não diz se o dinheiro
        // sai ou entra no caixa, e abater do dinheiro esperado sem saber falsearia a conferência — fica "a confirmar", visível e fora da conta.
        considerar: pago === true && ![NATUREZA_MOVIMENTO_CAIXA.DESCONHECIDA, NATUREZA_MOVIMENTO_CAIXA.TRANSFERENCIA].includes(classe.natureza),
        // O export não traz caixa, operador nem horário: o vínculo com a frente de caixa fica PENDENTE (nunca inventado).
        caixa: null, vinculoComCaixa: "PENDENTE",
      },
      identidade: { tipoRegistro: "MOVIMENTO_CAIXA", chave: `${rotulo(descricao)}|${rotulo(conta)}|${rotulo(categoria)}`, data, valorCentavos: valor },
    };
  },
  /**
   * Contradição com o que JÁ foi importado (provável arquivo corrigido): no período deste arquivo, para cada tipo de movimento presente nele,
   * há linhas ativas de importações anteriores que ele NÃO traz? Somar duplicaria o dinheiro. O sistema NÃO decide sozinho: mostra a divergência e,
   * SÓ com aceite explícito + justificativa na confirmação, marca essas linhas anteriores como SUBSTITUÍDAS (preservadas no histórico, fora dos
   * totais). Linhas iguais ficam como "já importadas". Devolve { divergencias, ausentes } (ausentes = registros anteriores que seriam substituídos).
   */
  conflitosComImportadas({ registros, anteriores, periodo }) {
    const chaves = new Set(registros.map((r) => r.chave));
    const naturezas = new Set(registros.map((r) => r.dados.natureza));
    const ausentes = anteriores.filter((a) => a.dataReferencia >= periodo.inicio && a.dataReferencia <= periodo.fim && naturezas.has(a.dados?.natureza) && !chaves.has(a.chaveIdempotencia));
    const porDia = new Map();
    for (const a of ausentes) porDia.set(a.dataReferencia, [...(porDia.get(a.dataReferencia) ?? []), a]);
    const nome = { SANGRIA: "retirada(s)", REFORCO: "reforço(s)", TRANSFERENCIA: "transferência(s)", DESCONHECIDA: "movimentação(ões) sem classificação" };
    const divergencias = [...porDia].sort(([x], [y]) => x.localeCompare(y)).map(([data, lista]) => ({
      codigo: DIVERGENCIA.CONFLITO_COM_IMPORTADO, linha: null, quantidade: lista.length,
      mensagem: `Dia ${data.slice(8, 10)}/${data.slice(5, 7)}: já há ${lista.length} ${nome[lista[0].dados.natureza] ?? "movimentação(ões)"} importada(s) (${lista.map((a) => formatarBRL(a.dados.valorAbsolutoCentavos)).join(", ")}) que este arquivo NÃO traz. Se este arquivo CORRIGE a importação anterior, confirme: essas linhas anteriores ficam SUBSTITUÍDAS (preservadas no histórico, fora dos totais). Se é só outro recorte, NÃO confirme: tire este dia do período.`,
    }));
    return { divergencias, ausentes };
  },
  fechar(registros) {
    const divergencias = [];
    const N = NATUREZA_MOVIMENTO_CAIXA;
    const soma = (natureza) => registros.filter((r) => r.dados.natureza === natureza && r.dados.considerar).reduce((s, r) => somar(s, r.dados.valorAbsolutoCentavos), 0);
    const qtd = (natureza) => registros.filter((r) => r.dados.natureza === natureza && r.dados.considerar).length;
    for (const r of registros) {
      const d = r.dados;
      if (d.natureza === N.DESCONHECIDA) divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `Movimentação "${d.descricaoOriginal}" não classificada (${d.naturezaMotivo}) — fica pendente, fora dos totais.`, linha: r.linha, valorCentavos: r.valorCentavos });
      else if (d.natureza === N.TRANSFERENCIA) divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `Transferência "${d.descricaoOriginal}": origem e destino não constam no relatório — fica a confirmar, fora do dinheiro esperado.`, linha: r.linha, valorCentavos: r.valorCentavos });
      if (d.pago === false) divergencias.push({ codigo: DIVERGENCIA.ANOMALIA_DE_PLANILHA, mensagem: `Movimentação "${d.descricaoOriginal}" ainda não paga no relatório: fica fora dos totais.`, linha: r.linha, valorCentavos: r.valorCentavos });
      else if (d.pago === null) divergencias.push({ codigo: DIVERGENCIA.ANOMALIA_DE_PLANILHA, mensagem: `A coluna "Pago" não foi interpretada: a linha "${d.descricaoOriginal}" fica fora dos totais.`, linha: r.linha, valorCentavos: r.valorCentavos });
    }
    const dias = new Set(registros.filter((r) => r.dados.considerar).map((r) => r.data));
    return {
      controles: {
        sangrias: qtd(N.SANGRIA), sangriasCentavos: soma(N.SANGRIA), reforcos: qtd(N.REFORCO), reforcosCentavos: soma(N.REFORCO),
        transferenciasAConfirmar: registros.filter((r) => r.dados.natureza === N.TRANSFERENCIA && r.dados.pago === true).length,
        desconhecidas: registros.filter((r) => r.dados.natureza === N.DESCONHECIDA).length,
        naoPagas: registros.filter((r) => r.dados.pago === false).length, diasComMovimento: dias.size, semCaixaIdentificado: registros.length,
        // Conferência das classificações (a prévia mostra linha a linha; até 100 linhas).
        movimentos: registros.slice(0, 100).map((r) => ({ linha: r.linha, data: r.data, natureza: r.dados.natureza, valorCentavos: r.dados.valorAbsolutoCentavos, descricao: r.dados.descricaoOriginal, considerar: r.dados.considerar, pago: r.dados.pago, motivo: r.dados.naturezaMotivo })),
      },
      divergencias,
    };
  },
});

export const FONTES_SAIPOS = Object.freeze([SAIPOS_VENDAS, SAIPOS_VENDAS_POR_CANAL, SAIPOS_DESEMPENHO_POR_ATENDENTE, SAIPOS_FORMAS_PAGAMENTO, SAIPOS_VENDAS_DIARIAS, SAIPOS_FATURAMENTO_POR_DIA, SAIPOS_MOVIMENTOS_CAIXA]);
