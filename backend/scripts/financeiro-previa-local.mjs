// Prévia LOCAL da importação contra a planilha real (somente leitura; nada é gravado nem publicado).
// Uso: node scripts/financeiro-previa-local.mjs <planilha.xlsx>
import { readFileSync } from "node:fs";
import { lerLivroCaixaXlsx } from "../src/modules/gestao-financeira/dominio/importacao/leitorXlsx.js";
import { montarPrevia, aplicarDecisoesPares } from "../src/financeiro-calculos/importacao.js";
import { formatarCentavos } from "../src/financeiro-calculos/dinheiro.js";

const arq = process.argv[2];
if (!arq) { console.error("uso: <planilha.xlsx>"); process.exit(2); }
const { aba, brutas, totalDeclarado, abasIgnoradas } = lerLivroCaixaXlsx(readFileSync(arq));
const previa = montarPrevia({ brutas, totalDeclarado });
const alta = aplicarDecisoesPares(previa, { confirmarAltaConfianca: true });
console.log("aba lida:", aba, "| ignoradas:", abasIgnoradas.join(", "));
console.log("resumo:", JSON.stringify({ ...previa.resumo, conferencia: undefined }, null, 1));
const c = previa.resumo.conferencia;
console.log("conferência:", c.confere, "declarado", formatarCentavos(c.declarado?.entradaCentavos), "/", formatarCentavos(c.declarado?.saidaCentavos), "| calculado", formatarCentavos(c.calculado.entradaCentavos), "/", formatarCentavos(c.calculado.saidaCentavos));
console.log("erros:", previa.erros.length);
console.log("após confirmar pares de alta confiança → pares confirmados:", alta.resumo.paresConfirmados, "| pendentes restantes:", alta.resumo.pendentes);
const ext = alta.lancamentos.filter((l) => l.papel === "transferencia" && l.pendente);
const liquido = ext.reduce((s, l) => s + (l.sentido === "saida" ? l.valor_centavos : -l.valor_centavos), 0);
console.log("transferências ainda sem par:", ext.length, "| líquido saindo:", formatarCentavos(liquido));
console.log("ambíguos:", alta.pares.filter((p) => !p.confirmado).length);
