// Inventário das capacidades REAIS do Financeiro 2.0 para a matriz do MOVA (Agente 2). Só leitura do código: monta o núcleo
// oficial em memória (sem banco), lista as operações expostas e, pelo código-fonte, a permissão (ACAO) que cada uma exige.
// Uso: node scripts/mova/inventarioCapacidades.mjs > inventario.json
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { montar } from "../../test/financeiro-v2/helpers/cenario.js";
import { ACAO } from "../../src/modules/financeiro-v2/index.js";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "../../src/modules/financeiro-v2");
const NOME_ACAO = Object.fromEntries(Object.entries(ACAO).map(([k, v]) => [k, v]));
const fontes = [];
for (const d of ["aplicacao", "importacao", "integracao"]) {
  try { for (const f of readdirSync(join(raiz, d))) if (f.endsWith(".js")) fontes.push({ arquivo: `${d}/${f}`, texto: readFileSync(join(raiz, d, f), "utf8") }); } catch { /* pasta ausente */ }
}
const { nucleo } = montar({});
const ops = Object.keys(nucleo).filter((k) => typeof nucleo[k] === "function").sort();
const saida = ops.map((nome) => {
  for (const { arquivo, texto } of fontes) {
    const m = new RegExp(`\\n\\s+(?:async\\s+)?${nome}\\s*\\(`).exec(texto);
    if (!m) continue;
    const trecho = texto.slice(m.index, m.index + 1500);
    const acoes = [...new Set([...trecho.matchAll(/ACAO\.([A-Z_]+)/g)].map((x) => x[1]))].filter((x) => NOME_ACAO[x]);
    return { operacao: nome, arquivo, permissoes: acoes.map((a) => NOME_ACAO[a]) };
  }
  return { operacao: nome, arquivo: null, permissoes: [] };
});
console.log(JSON.stringify({ total: saida.length, acoes: Object.values(ACAO), operacoes: saida }, null, 1));
