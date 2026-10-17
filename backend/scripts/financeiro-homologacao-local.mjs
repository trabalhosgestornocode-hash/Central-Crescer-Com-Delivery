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

// ---- comparação com as abas derivadas (ANALISE CATEGORIAS e DRE GERENCIAL) ----
{
  const { montarDre, rankingCategorias } = await import("../src/financeiro-calculos/relatorios.js");
  const cats = new Map();
  const ent = lancamentos.map((l) => {
    const id = `${l.cat}`;
    if (l.papel && !cats.has(id)) cats.set(id, { id, nome: id, papel: l.papel });
    return { ...l, categoriaId: l.papel ? id : null, data: "2026-09-01" };
  });
  const rank = rankingCategorias(ent, cats);
  const aba = XLSX.utils.sheet_to_json(wb.Sheets["ANALISE CATEGORIAS"], { header: 1, defval: null });
  let divergencias = 0;
  let somaAba = 0;
  for (const l of aba) {
    if (l?.[2] === "TOTAL CUSTOS + DESPESAS + TRIBUTOS") { somaAba = paraCentavos(l[3]); continue; }
    if (!l || typeof l[3] !== "number" || !l[2] || l[0] === "Origem") continue;
    const mine = rank.itens.find((i) => i.nome === l[2]);
    const esperado = paraCentavos(l[3]);
    if (!mine || mine.centavos !== esperado) { divergencias++; console.log("DIVERGE categoria", l[2], "planilha", esperado, "motor", mine?.centavos); }
  }
  console.log(divergencias === 0 ? "OK   análise de categorias: todas as categorias conferem" : `FALHA análise de categorias: ${divergencias} divergência(s)`);
  console.log(rank.totalCentavos === somaAba ? "OK   total custos+despesas+tributos confere" : `FALHA total ${rank.totalCentavos} x ${somaAba}`, formatarCentavos(rank.totalCentavos));
  const dre = montarDre(ent, cats);
  const aDre = XLSX.utils.sheet_to_json(wb.Sheets["DRE GERENCIAL"], { header: 1, defval: null });
  const val = (rot) => aDre.find((l) => String(l?.[0] ?? "").trim() === rot)?.[1];
  const par = [["Receita bruta", "receita"], ["(-) Custos variáveis (CMV)", "custos"], ["(-) Despesas variáveis", "desp_variaveis"], ["(-) Tributos", "tributos"], ["Margem de Contribuição", "margem_contribuicao"], ["(-) Despesas fixas", "desp_fixas"], ["(-) Despesas com pessoal", "pessoal"], ["(-) Despesas financeiras", "desp_financeiras"], ["Resultado Gerencial", "resultado"]];
  for (const [rot, id] of par) {
    const ok = paraCentavos(val(rot)) === dre.linhas.find((x) => x.id === id).centavos;
    console.log(ok ? "OK  " : "FALHA", "DRE", rot);
    if (!ok) divergencias++;
  }
  const tarifa = dre.linhas.find((x) => x.id === "custos").detalhes.find((d) => d.nome === "TARIFA VENDAS");
  console.log(paraCentavos(val("(-) Tarifas/taxas sobre vendas")) === tarifa?.centavos ? "OK   detalhe tarifas sobre vendas" : "FALHA detalhe tarifas");
  const mlAba = aDre.find((l) => l?.[0] === "Margem Líquida")?.[1];
  console.log("margem líquida: planilha", mlAba, "→ motor", formatarBps(dre.linhas.find((x) => x.id === "margem_liquida").bps), "(planilha formatava como moeda: I-1)");
  if (divergencias) process.exitCode = 1;
}
