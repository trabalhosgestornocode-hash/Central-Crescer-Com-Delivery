// Fixtures do Núcleo Mentorados — série SINTÉTICA (nenhum dado de cliente: o repositório é público), com o mesmo
// formato da planilha "Histórico Financeiro do iFood" do mentor (24 meses, out/24–set/26, desempenho só nos 3 últimos
// meses, entregadores ausentes nos 2 últimos). Totais escolhidos para conta exata:
//   antes  (out/24–set/25): vendas R$ 786.000,00 · taxas 15% = R$ 117.900,00 · serviços 10% = R$ 78.600,00 (25,00%)
//   1º ano (out/25–set/26): vendas R$ 1.179.000,00 · taxas 12,5% = R$ 147.375,00 · serviços 6% = R$ 70.740,00 (18,50%)
//   crescimento 50,00% · redução de 6,50 p.p.
// A conferência com a planilha REAL fica em referencia-real.test.js (opcional, só local).
import XLSX from "xlsx";

export const MESES = Array.from({ length: 24 }, (_, i) => {
  const t = 2024 * 12 + 9 + i;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
});
const r2 = (v) => Math.round(v * 100) / 100;
export const VENDAS = MESES.map((_, i) => (i < 12 ? 60000 + 1000 * i : 90000 + 1500 * (i - 12)));
export const TAXAS = VENDAS.map((v, i) => r2(v * (i < 12 ? 0.15 : 0.125)));
export const SERVICOS = VENDAS.map((v, i) => r2(v * (i < 12 ? 0.10 : 0.06)));
export const ENTREGADORES = VENDAS.map((v, i) => (i >= 22 ? null : r2(v * 0.13)));
export const PEDIDOS = MESES.map((_, i) => (i >= 21 ? 2000 + 100 * (i - 21) : null));
export const VENDAS_DESEMPENHO = MESES.map((_, i) => (i >= 21 ? 90000 + 4500 * (i - 21) : null));
export const NOVOS = MESES.map((_, i) => (i >= 21 ? 500 + 50 * (i - 21) : null));

/** Série canônica (centavos) — a mesma que o leitor produz. */
export function serieReferencia() {
  const c = (v) => (v == null ? null : Math.round(v * 100));
  return MESES.map((mes, i) => ({
    mes, valorVendas: c(VENDAS[i]), taxasComissoes: c(TAXAS[i]), servicosPromocoes: c(SERVICOS[i]),
    taxasEntregadores: c(ENTREGADORES[i]), qtdPedidos: PEDIDOS[i], valorVendasDesempenho: c(VENDAS_DESEMPENHO[i]),
    novosClientes: NOVOS[i], precificacaoPct: 30,
  }));
}

const serial = (ym) => { const [a, m] = ym.split("-").map(Number); return (Date.UTC(a, m - 1, 1) - Date.UTC(1899, 11, 30)) / 864e5; };

/** Gera o .xlsx sintético no layout da planilha do mentor (Buffer). `ajuste(linhas)` monta variações. */
export function planilhaReferencia(ajuste = (l) => l) {
  const cab = [null, "DIA/MÊS/ANO", ...MESES.map(serial)];
  const linha = (rotulo, valores) => [null, rotulo, ...valores.map((v) => (v == null ? null : v))];
  const pctLinha = (rotulo, f) => [null, rotulo, ...MESES.map((_, i) => f(i))];
  const div = (a, b) => (b ? a / b : 0);
  let linhas = [
    [],
    [null, "CHECK-UP FINANCEIRO DO IFOOD | LOJA EXEMPLO - CIDADE - UF\n"],
    [],
    cab,
    linha("Aba - Desempenho | TOTAL DE VENDAS REALIZADAS", PEDIDOS),
    linha("VALOR TOTAL DAS VENDAS", VENDAS_DESEMPENHO),
    linha("TICKET MÉDIO | Mínimo R$45 - Ideal R$50", PEDIDOS.map((p, i) => (p ? VENDAS_DESEMPENHO[i] / p : null))),
    linha("NOVOS CLIENTES", NOVOS),
    linha("Aba - Financeiro | VALOR DAS VENDAS ", VENDAS),
    linha("[R$] TAXAS E COMISSÕES", TAXAS),
    linha("[R$] SERVIÇOS E PROMOÇÕES", SERVICOS),
    pctLinha("[%] TAXAS E COMISSÕES | Até 13%", (i) => div(TAXAS[i], VENDAS[i])),
    pctLinha("[%] SERVIÇOS E PROMOÇÕES | Até 5%", (i) => div(SERVICOS[i], VENDAS[i])),
    pctLinha("[%] TAXAS E COMISSÕES + SERVIÇOS E PROMOÇÕES | Até 18%", (i) => div(TAXAS[i] + SERVICOS[i], VENDAS[i])),
    [...linha("[R$] TAXA DOS ENTREGADORES ", ENTREGADORES), "Ago/26 Fullservice"],
    pctLinha("[%] TAXA DOS ENTREGADORES | Ideal 12% - Limite 15%", (i) => div(ENTREGADORES[i] ?? 0, VENDAS[i])),
    pctLinha("[%] TAXAS E COMISSÕES + SERVIÇOS E PROMOÇÕES + ENTREGADORES | Ideal 30% - Limite 33%", (i) => div(TAXAS[i] + SERVICOS[i] + (ENTREGADORES[i] ?? 0), VENDAS[i])),
    pctLinha("[%] META RESTAURANTE MAKETPLACE", () => 0.3),
    [],
    [null, "MÊS / ANO", ...MESES.map(serial)],
    pctLinha("COMISSÃO IFOOD - ENTREGA PARCEIRA", () => 0.1),
    pctLinha("% PRECIFICAÇÃO LOJA X IFOOD", () => 0.3),
    [],
    [null, "PRODUTO BALCÃO", "PREÇO"],
    [null, "PRODUTO A", 24.5],
    [null, "% PRECIFICAÇÃO LOJA X IFOOD", 0.31],
  ];
  linhas = ajuste(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), "Loja Exemplo");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
