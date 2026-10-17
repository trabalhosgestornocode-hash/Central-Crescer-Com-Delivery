// Homologação LOCAL contra a planilha real. NUNCA roda em CI e não grava nada.
// Uso: node scripts/financeiro-homologacao-local.mjs <planilha.xlsx> [esperado.json]
// A planilha e o JSON de esperados ficam FORA do repositório (repo público).
import { readFileSync } from "node:fs";
import XLSX from "xlsx";
import { paraCentavos, formatarCentavos, formatarBps } from "../src/financeiro-calculos/dinheiro.js";
import { papelDeTipoNatureza } from "../src/financeiro-calculos/planoContas.js";
import { apurar, saldosPorConta } from "../src/financeiro-calculos/motor.js";

const [, , arquivo, esperadoPath] = process.argv;
if (!arquivo) { console.error("uso: <planilha.xlsx> [esperado.json]"); process.exit(2); }

const wb = XLSX.read(readFileSync(arquivo), { cellDates: true });
const linhas = XLSX.utils.sheet_to_json(wb.Sheets["FLUXO DE CAIXA"], { header: 1, defval: null });
const cab = linhas.findIndex((l) => l?.[1] === "DATA");
if (cab < 0) { console.error("cabeçalho DATA não encontrado"); process.exit(2); }

const lancamentos = [];
const semPapel = [];
for (const [i, l] of linhas.slice(cab + 1).entries()) {
  if (!l || l[1] == null) continue;
  const [, data, desc, ent, sai, tipo, nat, cat, conta] = l;
  const entrada = paraCentavos(ent) ?? 0;
  const saida = paraCentavos(sai) ?? 0;
  if (entrada > 0 && saida > 0) throw new Error(`linha ${cab + 2 + i}: entrada e saída simultâneas`);
  const papel = papelDeTipoNatureza(tipo, nat);
  const lan = { id: `L${cab + 2 + i}`, contaId: String(conta).trim(), sentido: entrada > 0 ? "entrada" : "saida", valorCentavos: entrada > 0 ? entrada : saida, papel, status: "realizado", desc, data, cat };
  if (!papel) semPapel.push(lan.id);
  lancamentos.push(lan);
}

const r = apurar(lancamentos);
const contas = [...new Set(lancamentos.map((l) => l.contaId))].map((id) => ({ id, nome: id }));
// Aberturas: o "SALDO ANTERIOR" da planilha só existe para contas com saldo informado; as demais são DESCONHECIDAS (null).
const aberturas = Object.fromEntries(contas.map((c) => [c.id, null]));
for (const l of lancamentos) if (l.papel === "saldo_anterior") aberturas[l.contaId] = (aberturas[l.contaId] ?? 0) + l.valorCentavos;
const saldos = saldosPorConta(contas, aberturas, lancamentos);

const medido = {
  lancamentos: lancamentos.length,
  semPapel: semPapel.length,
  receitaOperacional: r.receitaOperacional,
  custosVariaveis: r.custosVariaveis,
  despesasVariaveis: r.despesasVariaveis,
  tributos: r.tributos,
  despesasFixas: r.despesasFixas,
  despesasPessoal: r.despesasPessoal,
  despesasFinanceiras: r.despesasFinanceiras,
  margemContribuicao: r.margemContribuicao,
  resultadoGerencial: r.resultadoGerencial,
  margemLiquidaBps: r.margemLiquidaBps,
  margemContribuicaoBps: r.margemContribuicaoBps,
  pontoEquilibrio: r.pontoEquilibrio,
  entradasTotais: r.entradasTotais,
  saidasTotais: r.saidasTotais,
  transfLiquidasExternas: r.transferencias.liquidasExternas,
  variacaoCaixa: r.variacaoCaixa,
  saldoAnterior: r.saldoAnterior,
  saldoFinal: r.saldoFinal,
  ponteFecha: r.ponteResultadoCaixa.fecha ? 1 : 0,
};

console.log("— medido —");
for (const [k, v] of Object.entries(medido)) console.log(k.padEnd(24), String(v).padStart(10), /Bps$/.test(k) ? formatarBps(v) : /^(lancamentos|semPapel|ponteFecha)$/.test(k) ? "" : formatarCentavos(v));
console.log("— saldos por conta (abertura desconhecida = parcial) —");
for (const c of saldos.contas) console.log(c.contaId.padEnd(10), "abertura", c.aberturaCentavos === null ? "DESCONHECIDA" : formatarCentavos(c.aberturaCentavos), "| variação", formatarCentavos(c.variacao), "| saldo", c.saldoCentavos === null ? "parcial" : formatarCentavos(c.saldoCentavos));

if (esperadoPath) {
  const esperado = JSON.parse(readFileSync(esperadoPath, "utf8"));
  let falhas = 0;
  for (const [k, v] of Object.entries(esperado)) {
    const ok = medido[k] === v;
    if (!ok) falhas++;
    console.log(ok ? "OK  " : "FALHA", k, "esperado", v, "medido", medido[k]);
  }
  process.exit(falhas ? 1 : 0);
}
