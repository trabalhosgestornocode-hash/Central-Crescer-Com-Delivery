#!/usr/bin/env node
// Executor do T1 (testes unitários isolados). Uso (a partir de backend/):
//   node testes-seguros/executar.mjs                      -> toda a suíte test/*.test.js
//   node testes-seguros/executar.mjs test/a.test.js ...   -> arquivos escolhidos
//   node testes-seguros/executar.mjs --provas             -> provas de isolamento da própria guarda
//   opções: --concorrencia=N
//
// O ambiente do teste é CONSTRUÍDO do zero (ambiente.mjs): nada do shell chega ao processo — nem credenciais de
// produção. Nunca passa --env-file. A guarda (guarda.mjs) é pré-carregada em todo processo/subprocesso/worker.
// Saída final: código do teste, OU 1 se houve qualquer violação de isolamento (mesmo que o teste a tenha engolido).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { montarEnvFicticio, montarArgsNode } from "./ambiente.mjs";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(aqui, "..");
const guardaUrl = pathToFileURL(path.join(aqui, "guarda.mjs")).href;

const argv = process.argv.slice(2);
const provas = argv.includes("--provas");
const concorrencia = argv.find((a) => a.startsWith("--concorrencia="))?.split("=")[1] ?? null;
let arquivos = argv.filter((a) => !a.startsWith("--"));

if (argv.some((a) => /^--env-file/.test(a))) { console.error("[testes-seguros] --env-file é proibido."); process.exit(2); }

if (provas) arquivos = readdirSync(path.join(aqui, "provas")).filter((f) => f.endsWith(".test.js")).map((f) => path.join("testes-seguros", "provas", f));
else if (!arquivos.length) arquivos = readdirSync(path.join(backend, "test")).filter((f) => f.endsWith(".test.js")).sort().map((f) => path.join("test", f));

const pasta = mkdtempSync(path.join(tmpdir(), "testes-seguros-"));
const logPath = path.join(pasta, "violacoes.jsonl");
writeFileSync(logPath, "");

const env = montarEnvFicticio(process.env, { guardaUrl, logPath, modoProva: provas });
const args = montarArgsNode({ guardaUrl, arquivos, concorrencia });

console.log(`[testes-seguros] T1 — ${arquivos.length} arquivo(s) · rede externa BLOQUEADA · .env NÃO carregado · ambiente fictício · Node ${process.version}`);

const filho = spawn(process.execPath, args, { cwd: backend, env, stdio: "inherit", shell: false });
filho.on("exit", (codigo, sinal) => {
  const linhas = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  rmSync(pasta, { recursive: true, force: true });
  if (provas) { console.log(`[testes-seguros] provas concluídas (${linhas.length} bloqueios registrados durante as provas).`); process.exit(codigo ?? 1); }
  if (linhas.length) {
    const porVetor = {};
    for (const v of linhas) { const k = `${v.vetor}`; (porVetor[k] ??= new Set()).add(v.alvo); }
    console.error(`\n[testes-seguros] ${linhas.length} VIOLAÇÃO(ÕES) DE ISOLAMENTO:`);
    for (const [vetor, alvos] of Object.entries(porVetor)) console.error(`  - ${vetor}: ${[...alvos].slice(0, 5).join(", ")}${alvos.size > 5 ? ` (+${alvos.size - 5})` : ""}`);
    process.exit(1);
  }
  process.exit(sinal ? 1 : (codigo ?? 1));
});
