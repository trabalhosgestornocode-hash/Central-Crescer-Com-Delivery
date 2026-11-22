// MOVA — Execução 14: rodada REAL do conjunto de avaliação com o Claude Haiku 5.5. Só roda com autorização explícita do
// proprietário (flag) e só contra o banco de HOMOLOGAÇÃO marcado. O cenário (unidades, Financeiro) é fictício e LOCAL; o
// ORÇAMENTO e o interruptor de IA são os do banco de homologação (o mesmo livro da rodada pelo WhatsApp), então os limites de
// custo e de chamadas valem para as duas coisas juntas. Sem repetição: cada caso é chamado no máximo uma vez.
//
// Uso (a partir de backend/):
//   node --env-file=<.env.execucao da homologação> scripts/mova/avaliacaoHaiku.mjs --autorizado=execucao-14 --chave-de=<backend/.env principal>
// A chave é lida só da linha ANTHROPIC_API_KEY do arquivo indicado, mantida em memória e nunca impressa.
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { CASOS } from "../../test/mova-financeiro/avaliacao/casos.mjs";
import { executarAvaliacao } from "../../test/mova-financeiro/avaliacao/executor.mjs";
import { clienteComOrcamento, criarControle, criarOrcamentoIa } from "../../src/modules/mova-financeiro/index.js";
import { exigirBancoDeHomologacao } from "../../src/modules/fv2-integracao/mova.js";

const arg = (n) => (process.argv.find((x) => x.startsWith(`--${n}=`)) ?? "").slice(n.length + 3);
if (arg("autorizado") !== "execucao-14") { console.error("RECUSADO: falta --autorizado=execucao-14 (autorização do proprietário)."); process.exit(1); }
if (process.env.MOVA_MODO !== "HOMOLOGACAO" || !process.env.MOVA_HOMOLOGACAO_MARCADOR || !process.env.MOVA_DATABASE_URL) { console.error("RECUSADO: ambiente não é o de homologação."); process.exit(1); }
const linha = readFileSync(arg("chave-de"), "utf8").split("\n").map((l) => l.replace(/\r$/, "")).find((l) => l.startsWith("ANTHROPIC_API_KEY="));
const chave = linha?.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
if (!chave || !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(chave)) { console.error("RECUSADO: chave ausente."); process.exit(1); }

const ca = process.env.MOVA_PG_CA ?? process.env.FV2_PG_CA ?? null;
const pool = new pg.Pool({ connectionString: process.env.MOVA_DATABASE_URL, max: 2, ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true } });
await exigirBancoDeHomologacao(pool, process.env.MOVA_HOMOLOGACAO_MARCADOR);
const teto = Object.freeze({ maxSaida: 600, maxEntrada: 4000, esforco: "low" }); // 14B: 3.400 recusou 4 de 8 mensagens reais (contexto com 3 unidades)
const orcamento = criarOrcamentoIa({ pool });
const controle = criarControle({ pool, cacheMs: 0 });
const real = new Anthropic({ apiKey: chave, maxRetries: 0 }); // sem nova tentativa automática
const casos = CASOS.filter((c) => c.real);

const criarCliente = (registrar) => {
  const orcado = clienteComOrcamento(real, { orcamento, controle, teto });
  return { beta: { messages: { async create(req) {
    let r;
    try { r = await orcado.beta.messages.create(req); }
    catch (e) { registrar({ json: null, stop: `ERRO:${e?.codigo ?? e?.status ?? "?"}`, uso: null }); throw e; }
    let json = null;
    try { json = JSON.parse((r.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("")); } catch { /* JSON inválido: medido */ }
    registrar({ json, stop: r.stop_reason, uso: { modelo: r.model, entrada: r.usage?.input_tokens ?? 0, saida: r.usage?.output_tokens ?? 0 } });
    return r;
  } } } };
};

const { resultados, metricas, chamadas } = await executarAvaliacao({ criarCliente, casos });
const custo = chamadas.reduce((s, c) => s + (c.uso ? Math.ceil(c.uso.entrada * 0.1 + c.uso.saida * 0.5) : 0), 0);
const relatorio = { em: new Date().toISOString(), modelo: "claude-haiku-5-5", casos: casos.length, metricas, custoMicroUsd: custo, resultados, chamadas: chamadas.map(({ caso, stop, uso }) => ({ caso, stop, uso })) };
const saida = arg("saida") || "avaliacao-haiku-resultado.json";
writeFileSync(saida, JSON.stringify(relatorio, (k, v) => (v instanceof RegExp ? String(v) : v), 2));
for (const r of resultados) console.log(r.id, r.aprovado ? "OK" : "XX", `${r.decisao}/${r.motivo}`, JSON.stringify(r.criterios));
console.log(JSON.stringify(metricas.porCriterio));
console.log(`chamadas=${chamadas.length} custo≈US$ ${(custo / 1e6).toFixed(6)} relatório=${saida}`);
await pool.end();
process.exit(0);
