// Conciliação LOCAL contra a planilha real (somente leitura; nada é gravado nem publicado).
// As REFERÊNCIAS vêm dos valores colados na aba "CONFERÊNCIA SACI" (cópia da planilha complementar ausente) — usadas só aqui, nunca no produto.
// O mapeamento nome→tipo de conta e a exceção do aluguel existem SÓ neste script de homologação (no produto são dados configurados e aprovados).
// Uso: node scripts/financeiro-conciliacao-local.mjs <planilha.xlsx>
import { readFileSync } from "node:fs";
import XLSX from "xlsx";
import { paraCentavos, formatarCentavos } from "../src/financeiro-calculos/dinheiro.js";
import { papelDeTipoNatureza } from "../src/financeiro-calculos/planoContas.js";
import { paraDataISO } from "../src/financeiro-calculos/importacao.js";
import { conciliar } from "../src/financeiro-calculos/conciliacao.js";

const arq = process.argv[2];
if (!arq) { console.error("uso: <planilha.xlsx>"); process.exit(2); }
const wb = XLSX.read(readFileSync(arq));
const aba = (n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, raw: true });

// lançamentos do fluxo
const fluxo = aba("FLUXO DE CAIXA");
const cab = fluxo.findIndex((l) => l?.[1] === "DATA");
const lancamentos = fluxo.slice(cab + 1).filter((l) => l?.[1] != null).map((l, i) => {
  const [, data, desc, ent, sai, tipo, nat, cat, conta] = l;
  const e = paraCentavos(ent) ?? 0, s = paraCentavos(sai) ?? 0;
  return { id: `L${i}`, contaId: String(conta).trim(), sentido: e > 0 ? "entrada" : "saida", valorCentavos: e > 0 ? e : s, papel: papelDeTipoNatureza(tipo, nat), categoriaId: String(cat).trim(), data: paraDataISO(data), status: "realizado" };
});
const contas = [["UNICRED", "banco"], ["STONE", "adquirente"], ["CAIXA", "caixa_fisico"], ["IFOOD", "carteira_plataforma"]].map(([id, tipo_conta]) => ({ id, nome: id, tipo_conta, canal_referencia: id === "STONE" || id === "IFOOD" ? id : null }));

// referências a partir da aba de conferência (valores colados da planilha complementar)
const conf = aba("CONFERÊNCIA SACI");
const refs = [];
const num = (v) => (typeof v === "number" ? paraCentavos(Math.round(v * 100) / 100) : null);
let secao = 0;
for (const l of conf) {
  if (typeof l?.[0] === "string" && l[0].startsWith("2. SANGRIAS")) secao = 2;
  const d = l?.[0] instanceof Date || typeof l?.[0] === "number" ? paraDataISO(l[0]) : null;
  if (!d || !d.startsWith("2026-09")) continue;
  if (secao === 0) { // 1. faturamento diário: B = vendas, C = caixa espécie
    if (num(l[1]) != null) refs.push({ id: `v${d}`, data: d, tipo: "venda", canal: null, valorCentavos: num(l[1]) });
    if (num(l[2]) != null) refs.push({ id: `d${d}`, data: d, tipo: "dinheiro", canal: null, valorCentavos: num(l[2]) });
  } else if (num(l[1]) != null) refs.push({ id: `s${d}`, data: d, tipo: "sangria", canal: null, valorCentavos: num(l[1]) });
}
const rot = (t) => conf.find((l) => typeof l?.[0] === "string" && l[0].includes(t));
refs.push({ id: "taxa-stone", data: "2026-09-30", tipo: "taxa", canal: "STONE", valorCentavos: num(rot("Tarifa Stone")[1]) });
refs.push({ id: "taxa-ifood", data: "2026-09-30", tipo: "taxa", canal: "IFOOD", valorCentavos: num(rot("Taxas do iFood")[1]) });

const roda = (excecoes) => conciliar({ mes: "2026-09", lancamentos, contas, referencias: refs, excecoesSangria: excecoes });
const sem = roda(new Set());
const com = roda(new Set(["ALUGUEL"]));    // exceção APROVADA (neste script: dado explícito)
const ok = (c, t) => { console.log(c ? "OK   " : "FALHA", t); if (!c) process.exitCode = 1; };

const p = com.ponte;
console.log(`vendas ${formatarCentavos(p.vendasCentavos)} | recebido ${formatarCentavos(p.recebidoCentavos)} | a explicar ${formatarCentavos(p.diferencaAExplicarCentavos)} | taxas ${formatarCentavos(p.taxasTotalCentavos)} | residual ${formatarCentavos(p.residualCentavos)} | estado ${p.estado}`);
ok(p.vendasCentavos === 8318338, "vendas de referência (soma diária) = 83.183,38");
ok(p.recebidoCentavos === 7769484, "receitas recebidas = 77.694,84");
ok(p.diferencaAExplicarCentavos === 548854, "diferença inicial = 5.488,54");
ok(p.taxas.find((t) => t.canal === "STONE")?.centavos === 81977 && p.taxas.find((t) => t.canal === "IFOOD")?.centavos === 479978, "taxas Stone 819,77 e iFood 4.799,78");
ok(p.residualCentavos === -13101, "residual = −131,01");
ok(p.estado === "pendente_identificacao", "residual permanece PENDENTE DE IDENTIFICAÇÃO (nunca prazo automático)");

const caixaDivergentes = com.caixaDias.filter((d) => d.diferencaCentavos !== 0 && d.diferencaCentavos !== null);
ok(caixaDivergentes.length === 0, `caixa em espécie confere dia a dia (${com.caixaDias.length} dias, ${caixaDivergentes.length} divergentes)`);

console.log(`sangrias sem exceção: total ${formatarCentavos(sem.totalSangria.fluxoCentavos)} | com exceção do aluguel: referência ${formatarCentavos(com.totalSangria.referenciaCentavos)} livro ${formatarCentavos(com.totalSangria.fluxoCentavos)} diferença ${formatarCentavos(com.totalSangria.diferencaCentavos)}`);
ok(com.totalSangria.referenciaCentavos === 106800, "sangrias de referência = 1.068,00");
ok(com.totalSangria.fluxoCentavos === 105882, "saídas do caixa consideradas = 1.058,82 (com a exceção aprovada do aluguel)");
ok(com.totalSangria.diferencaCentavos === -918, "diferença total das sangrias = −9,18");
const dias = com.sangriaDias.filter((d) => d.estado === "pendente_identificacao").map((d) => `${d.data}:${formatarCentavos(d.diferencaCentavos)}`);
console.log("dias de sangria divergentes:", dias.join(" "));
ok(dias.length === 2 && dias[0].startsWith("2026-09-02") && dias[1].startsWith("2026-09-04"), "divergências de sangria somente em 02/09 e 04/09");
ok(sem.totalSangria.fluxoCentavos > com.totalSangria.fluxoCentavos, "sem a exceção aprovada o aluguel entra no confronto (a regra é DADO, não código)");
