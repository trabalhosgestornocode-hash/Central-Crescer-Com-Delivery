// MOVA CORE — CONVERSA REAL pelo PIPELINE INTEGRADO (receptor → fila → motor atual → MOVA CORE → saída) com o modelo REAL
// (Haiku), a montagem de PRODUÇÃO do núcleo (montarConversaCore), o banco do MOVA no PostgreSQL isolado e o Financeiro v2 real em
// memória com dados SINTÉTICOS. Nada sai para o WhatsApp: as respostas ficam em mova.resposta do banco de teste.
//   node --env-file=.env.mova-teste scripts/mova-core/avaliacao/pipeline-real.mjs [--max-usd=0.03]
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG, FIN, OPER, ORG, ALFA, BETA, cenario, gw } from "../../../test/mova-financeiro/helpers/operacao.js";
import { criarOrcamentoIa } from "../../../src/modules/mova-financeiro/index.js";
import { ACAO } from "../../../src/modules/financeiro-v2/index.js";
import { montarConversaCore } from "../../../src/modules/fv2-integracao/movaCoreConversa.js";
import { custoRealMicrousd } from "../../../src/modules/mova-core/custo.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const MAX_USD = Number(args["max-usd"] ?? 0.03);
const dirR = join(AQUI, "resultados"); mkdirSync(dirR, { recursive: true });
const gasto = readdirSync(dirR).filter((f) => /^real-.*\.json$/.test(f)).reduce((a, f) => a + (JSON.parse(readFileSync(join(dirR, f), "utf8")).orcamento?.gastoMicrousd ?? 0), 0) / 1e6;
console.log(`gasto acumulado em avaliações reais: US$ ${gasto.toFixed(6)} de US$ 1; teto desta rodada US$ ${MAX_USD}`);
if (gasto + MAX_USD > 1 + 1e-9) throw new Error("recusado: passaria do limite cumulativo de US$ 1");
const chave = process.env.MOVA_CORE_ANTHROPIC_KEY_TESTE;
if (!chave) throw new Error("Defina MOVA_CORE_ANTHROPIC_KEY_TESTE em .env.mova-teste");
if (["ANTHROPIC_API_KEY", "MOVA_ANTHROPIC_API_KEY"].map((k) => process.env[k]).includes(chave)) throw new Error("chave de teste igual a uma de produção: recusado");
const { default: Anthropic } = await import("@anthropic-ai/sdk");

let gastoMicrousd = 0; let chamadas = 0;
const criarClienteIa = () => {
  const real = new Anthropic({ apiKey: chave, maxRetries: 2 });
  return { messages: {
    async create(req) {
      if (gastoMicrousd >= MAX_USD * 1e6) throw Object.assign(new Error("teto da rodada"), { status: 429 });
      const r = await real.messages.create(req); chamadas++;
      gastoMicrousd += custoRealMicrousd({ modelo: r.model, uso: r.usage }); return r;
    },
    countTokens: (r) => real.messages.countTokens(r),
  } };
};

const holder = { real: null }; const eventos = [];
const s = await cenario({ comandosDeterministicos: true, extras: () => ({ conversaNova: { atender: async (x) => (holder.real ? holder.real.atender(x) : null) } }) });
await s.conta("2026-10-20", 12345, ALFA);
await s.conta("2026-10-10", 4990, ALFA);
const fornBeta = await s.m.nucleo.registrarContraparte(s.c(ORG, BETA), { tipo: "FORNECEDOR", nome: "Gelo Beta Sintético" });
await s.conta("2026-10-25", 30000, BETA, fornBeta);
holder.real = await montarConversaCore({ conversaCore: { modo: "RESPOSTA", unidades: [ALFA, BETA] }, servicoUsuarioId: CONFIG.identidadeServico.usuarioId, configuracao: s.mova.cfg,
  porta: s.mova.porta, acaoVer: ACAO.VER, orcamento: criarOrcamentoIa({ pool: s.banco.pool }), criarClienteIa, registrar: (e) => eventos.push(e), relogio: () => new Date("2026-10-15T12:00:00Z") });

const ROTEIRO = [
  { de: FIN, texto: "oi, tudo bem? o que você consegue fazer por mim?" },
  { de: FIN, texto: "quais contas tenho pra pagar na alfa?", deve: [/123,45/, /49,90/] },
  { de: FIN, texto: "tem alguma vencida?", deve: [/49,90/] },
  { de: FIN, texto: "quanto devo pro Fornecedor Sintético na alfa?", deve: [/173,35|123,45/] },
  { de: FIN, texto: "e na beta?", deve: [/300,00/] },
  { de: FIN, texto: "quanto vendemos ontem na alfa?" },
  { de: FIN, texto: "como ficou o resultado de outubro na alfa?" },
  { de: FIN, texto: "tem sangria pendente de prestação de contas na alfa?" },
  { de: FIN, texto: "qual o saldo do caixa e dos bancos da alfa?" },
  { de: FIN, texto: "quanto tenho a receber na alfa?" },
  { de: FIN, texto: "quanto vou pagar aos entregadores essa semana na alfa?" },
  { de: FIN, texto: "como funciona a baixa de conta por comprovante no sistema?" },
  { de: FIN, texto: "registra aí uma despesa de 50 reais de gelo de hoje na alfa", naoDeve: [/(?<!nada )\b(registrei|lancei|foi registrad|foi lancad)/i, /monto a proposta|voc[eê] confirma com/i] },
  { de: OPER, texto: "quanto tenho pra pagar na alfa?", naoDeve: [/R\$\s?\d/] },
];
const linhas = [];
const escritasAntes = s.chamadas.filter((c) => /^(registrar|baixar|abrir|fechar|liquidar|criar)/.test(c.nome)).length;
for (const p of ROTEIRO) {
  const antes = (await s.saida()).length; const t0 = Date.now();
  await s.enviar(gw({ texto: p.texto, grupo: p.de, de: p.de }));
  const novas = (await s.saida()).slice(antes).map((m) => m.texto);
  const h = await s.ultima();
  const texto = novas.join("\n---\n");
  const problemas = [
    ...(!/^MOVA_CORE:/.test(h.motivo) ? [`NAO_FOI_PELO_NUCLEO:${h.decisao}/${h.motivo}`] : []),
    ...(!texto ? ["SEM_RESPOSTA"] : []),
    ...(p.deve ?? []).filter((r) => !r.test(texto)).map((r) => `FALTOU:${r}`),
    ...(p.naoDeve ?? []).filter((r) => r.test(texto)).map((r) => `NAO_DEVIA:${r}`),
  ];
  linhas.push({ de: p.de === FIN ? "FINANCEIRO" : "OPERACIONAL", pergunta: p.texto, resposta: texto, motivo: h.motivo, ferramentas: h.ferramentas ?? h.extra?.ferramentas ?? null, ms: Date.now() - t0, problemas });
  console.log(`\n${problemas.length ? "FALHOU" : "OK  "} [${h.motivo}] ${p.texto}\n  → ${texto.replace(/\n+/g, " ⏎ ").slice(0, 700)}${problemas.length ? `\n  !! ${problemas.join(" | ")}` : ""}`);
}
const escritas = s.chamadas.filter((c) => /^(registrar|baixar|abrir|fechar|liquidar|criar)/.test(c.nome)).length - escritasAntes;
const resumo = { mensagens: linhas.length, ok: linhas.filter((l) => !l.problemas.length).length, pelonucleo: linhas.filter((l) => /^MOVA_CORE:/.test(l.motivo)).length, escritasNoFinanceiro: escritas,
  chamadasIa: chamadas, custoUsd: Number((gastoMicrousd / 1e6).toFixed(6)), latenciaMediaMs: Math.round(linhas.reduce((a, l) => a + l.ms, 0) / linhas.length) };
console.log("\n", JSON.stringify(resumo));
const arq = join(dirR, `real-pipeline-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
writeFileSync(arq, JSON.stringify({ modo: "REAL — pipeline integrado (motor atual + MOVA CORE), dados sintéticos", em: new Date().toISOString(), resumo, linhas, orcamento: { gastoMicrousd: Math.round(gastoMicrousd) } }, null, 2));
console.log("arquivo:", arq);
await s.banco.pool.end?.().catch(() => {});
