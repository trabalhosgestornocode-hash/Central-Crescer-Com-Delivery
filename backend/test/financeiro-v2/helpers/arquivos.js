// Arquivos SINTÉTICOS das fontes, no formato do contrato de cada adaptador. Nenhum nome, código ou valor aqui é real.
// Valores em centavos são formatados no padrão brasileiro ("1.234,56").
const reais = (c) => {
  const neg = c < 0;
  const abs = Math.abs(c);
  const inteiro = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}${inteiro},${String(abs % 100).padStart(2, "0")}`;
};
const csv = (linhas) => new TextEncoder().encode(`${linhas.map((l) => l.join(";")).join("\r\n")}\r\n`);
export const texto = (s) => new TextEncoder().encode(s);
export { reais };

/** Pedidos: [{pedido, data:"dd/mm/aaaa hh:mm", canal, itens, desconto, acrescimo, taxa, total, forma, situacao, autorizacao}] */
export function saiposVendas(pedidos, { total = null, semColuna = null } = {}) {
  const cab = ["Pedido", "Data", "Canal", "Itens", "Desconto", "Acréscimo", "Taxa de entrega", "Total", "Forma de pagamento", "Situação", "Autorização"];
  const linhas = pedidos.map((p) => [p.pedido, p.data, p.canal ?? "Balcão", reais(p.itens), reais(p.desconto ?? 0), reais(p.acrescimo ?? 0), reais(p.taxa ?? 0),
    p.totalTexto ?? reais(p.total ?? (p.itens - (p.desconto ?? 0) + (p.acrescimo ?? 0) + (p.taxa ?? 0))), p.forma ?? "Dinheiro", p.situacao ?? "Concluído", p.autorizacao ?? ""]);
  if (total !== null) linhas.push(["TOTAL", "", "", "", "", "", "", reais(total), "", "", ""]);
  const tabela = [cab, ...linhas];
  if (semColuna) { const i = cab.indexOf(semColuna); return csv(tabela.map((l) => l.filter((_, j) => j !== i))); }
  return csv(tabela);
}

export const saiposDiarias = (dias, total = null) => csv([["Data", "Quantidade de pedidos", "Valor"], ...dias.map(([d, q, v]) => [d, String(q), reais(v)]), ...(total !== null ? [["Total", "", reais(total)]] : [])]);
export const saiposFormas = (formas, total = null) => csv([["Forma de pagamento", "Quantidade", "Valor"], ...formas.map(([f, q, v]) => [f, String(q), reais(v)]), ...(total !== null ? [["Total", "", reais(total)]] : [])]);
export const saiposCanais = (canais) => csv([["Canal", "Quantidade", "Valor"], ...canais.map(([c, q, v]) => [c, String(q), reais(v)])]);

/** Transações: [{id, quando:"dd/mm/aaaa hh:mm", produto, bandeira, bruto, mdr, antecipacao, liquido?, status, stonecode, autorizacao}] */
export function stoneVendas(transacoes) {
  return csv([
    ["Identificador da transação", "Data da venda", "Produto", "Modalidade", "Bandeira", "Valor bruto", "Desconto de MDR", "Desconto de antecipação", "Valor líquido", "Status", "Stonecode", "Autorização"],
    ...transacoes.map((t) => [t.id, t.quando, t.produto ?? "Crédito", t.modalidade ?? "À vista", t.bandeira ?? "Bandeira Teste", reais(t.bruto), reais(t.mdr ?? 0), reais(t.antecipacao ?? 0),
      reais(t.liquido ?? (t.bruto - (t.mdr ?? 0) - (t.antecipacao ?? 0))), t.status ?? "Aprovada", t.stonecode ?? "", t.autorizacao ?? ""]),
  ]);
}

export const stoneRecebimentos = (itens) => csv([["Data do pagamento", "Identificador da transação", "Parcela", "Valor líquido"], ...itens.map((i) => [i.data, i.transacao, String(i.parcela ?? 1), reais(i.liquido)])]);

/** Componentes: [{data, tipo, descricao, pedido, valor, responsavel}] */
export const ifoodApuracao = (componentes) => csv([["Data", "Tipo de lançamento", "Descrição", "Pedido", "Valor", "Responsável"], ...componentes.map((c) => [c.data, c.tipo, c.descricao ?? "", c.pedido ?? "", reais(c.valor), c.responsavel ?? ""])]);

/** Entregas: [{pedido, data, entregador, taxa, custo, situacao}] + subtotais por entregador + total. */
export function foodyEntregas(entregas, { subtotais = {}, total = null } = {}) {
  const linhas = [["Pedido", "Data", "Entregador", "Taxa de entrega", "Custo reconhecido", "Situação", "Total devido"]];
  for (const e of entregas) linhas.push([e.pedido, e.data, e.entregador, reais(e.taxa), reais(e.custo), e.situacao ?? "Entregue", ""]);
  for (const [quem, v] of Object.entries(subtotais)) linhas.push(["", "", quem, "", "", "", reais(v)]);
  if (total !== null) linhas.push(["", "", "TOTAL", "", "", "", reais(total)]);
  return csv(linhas);
}

/** Extrato: saldo anterior + lançamentos [{data, historico, documento, valor (com sinal), saldo?}] + saldo final opcional. */
export function unicredExtrato({ saldoInicial, lancamentos, saldoFinal = undefined, encadear = true }) {
  const linhas = [["Data", "Histórico", "Documento", "Valor", "Saldo"], [lancamentos[0]?.data ?? "01/09/2026", "SALDO ANTERIOR", "", "", reais(saldoInicial)]];
  let saldo = saldoInicial;
  for (const l of lancamentos) {
    saldo += l.valor;
    linhas.push([l.data, l.historico, l.documento ?? "", reais(l.valor), l.saldo !== undefined ? reais(l.saldo) : encadear ? reais(saldo) : ""]);
  }
  if (saldoFinal !== null) linhas.push([lancamentos.at(-1)?.data ?? "30/09/2026", "SALDO FINAL", "", "", reais(saldoFinal === undefined ? saldo : saldoFinal)]);
  return csv(linhas);
}

export const PERIODO_SETEMBRO = Object.freeze({ periodoInicio: "2026-09-01", periodoFim: "2026-09-30" });
