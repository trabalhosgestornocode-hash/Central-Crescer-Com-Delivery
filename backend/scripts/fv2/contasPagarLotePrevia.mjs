// Prévia LOCAL de um lote de contas a pagar (somente leitura: não abre banco, não grava, não publica).
// Uso: node scripts/fv2/contasPagarLotePrevia.mjs <lote.json> [existentes.json] [saida.csv]
//  - lote.json: { lote, linhas:[{ n, fornecedor, descricao, valorCentavos, vencimento, competencia, categoria, conferencia?, atencao? }] } — ARQUIVO PRIVADO, fora do repositório.
//  - existentes.json (opcional): obrigações já gravadas na unidade, lidas à parte (somente SELECT) para a checagem de duplicidade.
// A aplicação em produção NÃO está aqui: exige autorização específica, plano SUBWAY implantado e a unidade configurada.
import { readFileSync, writeFileSync } from "node:fs";
import { montarPreviaContasPagarLote } from "../../src/modules/financeiro-v2/aplicacao/contasPagarLote.js";

const [arq, arqExistentes, saida] = process.argv.slice(2);
if (!arq) { console.error("uso: <lote.json> [existentes.json] [saida.csv]"); process.exit(2); }
const { lote, linhas } = JSON.parse(readFileSync(arq, "utf8"));
const existentes = arqExistentes && arqExistentes !== "-" ? JSON.parse(readFileSync(arqExistentes, "utf8")) : [];
const p = montarPreviaContasPagarLote(linhas, { lote, existentes });
const fm = (c) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
console.log(`lote ${lote}: ${p.resumo.linhas} linhas, total ${fm(p.resumo.valorTotalCentavos)} | apto: ${p.apto}`);
console.log("erros:", p.erros.length, JSON.stringify(p.erros));
console.log("novas:", p.resumo.novas, "| já registradas:", p.resumo.jaRegistradas, "| possíveis duplicidades:", JSON.stringify(p.resumo.possiveisDuplicidades));
for (const [k, v] of Object.entries(p.resumo.porEfeito)) console.log(" efeito", k.padEnd(26), String(v.quantidade).padStart(3), fm(v.valorCentavos).padStart(16));
for (const [k, v] of Object.entries(p.resumo.porCategoria).sort()) console.log(" categoria", k.padEnd(34), String(v.quantidade).padStart(3), fm(v.valorCentavos).padStart(16));
for (const [k, v] of Object.entries(p.resumo.porVencimentoMes)) console.log(" vencimento", k, String(v.quantidade).padStart(3), fm(v.valorCentavos).padStart(16));
console.log("obrigações ANTERIORES (competência < início ".concat(p.competenciaInicio, "; corte ", p.dataDeCorte, "):"), JSON.stringify(p.resumo.anteriores));
console.log("em conferência:", JSON.stringify(p.resumo.emConferencia));
console.log("com atenção:", JSON.stringify(p.itens.filter((i) => i.atencao).map((i) => i.n)));
if (saida) {
  const cab = "n;fornecedor;descricao;vencimento;competencia_aplicada;competencia_original;valor;categoria;efeito_dre;status;estado;nota_conferencia;atencao";
  const l = p.itens.map((i) => [i.n, i.fornecedor, i.descricao, i.vencimento, i.competencia, i.competenciaOriginal ?? "", (i.valorCentavos / 100).toFixed(2).replace(".", ","), i.categoria, i.efeito, i.status, i.estado, i.conferencia?.nota ?? "", i.atencao ?? ""].map((x) => String(x).replace(/;/g, ",")).join(";"));
  writeFileSync(saida, "﻿" + [cab, ...l].join("\n"), "utf8");
  console.log("CSV privado gravado em", saida);
}
process.exit(p.apto ? 0 : 1);
