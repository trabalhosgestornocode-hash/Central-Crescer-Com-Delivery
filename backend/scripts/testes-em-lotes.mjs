#!/usr/bin/env node
// 27/11 (PR #236): roda arquivos de teste em LOTES controlados, sem lotar o disco.
//
//   node scripts/testes-em-lotes.mjs [--lote 8] [--concorrencia 1] [--minimo-gb 10] <arquivos de teste...>
//
// - Antes de cada lote: confere o espaço livre no disco do ambiente de teste; abaixo do mínimo, PARA (nada mais roda).
// - Durante o lote: confere a cada 10 s; abaixo da METADE do mínimo, interrompe o lote (árvore de processos inteira).
// - Depois de cada lote: `fv2-banco-teste.mjs limpar` (só apaga banco de processo que já terminou e sem conexão).
// Herda o ambiente (FV2_REPOSITORIO, FV2_PG_BIN...). Não lê .env, não conecta em nada além do que os testes já conectam.
import { spawn, spawnSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lerAmbiente, pastaDoAmbiente } from "./fv2/ambiente.mjs";

const args = process.argv.slice(2);
const opcao = (nome, padrao) => { const i = args.indexOf(`--${nome}`); if (i < 0) return padrao; const v = args[i + 1]; args.splice(i, 2); return Number(v); };
const LOTE = opcao("lote", 8);
const CONCORRENCIA = opcao("concorrencia", 1);
const MINIMO_GB = opcao("minimo-gb", 10);
const arquivos = args;
if (!arquivos.length) { process.stderr.write("uso: node scripts/testes-em-lotes.mjs [--lote N] [--concorrencia N] [--minimo-gb N] <arquivos...>\n"); process.exit(2); }

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), "..");
const livreGb = () => {
  for (const p of [pastaDoAmbiente(), BACKEND]) { try { const s = statfsSync(p); return (s.bavail * s.bsize) / 1024 ** 3; } catch { /* próxima */ } }
  return 0;
};
const limpar = () => { if (lerAmbiente()) spawnSync(process.execPath, ["scripts/fv2-banco-teste.mjs", "limpar"], { cwd: BACKEND, stdio: "inherit" }); };
const matarArvore = (pid) => (process.platform === "win32" ? spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]) : process.kill(-pid, "SIGKILL"));

function rodarLote(lote) {
  return new Promise((resolver) => {
    const filho = spawn(process.execPath, ["--test", "--test-force-exit", `--test-concurrency=${CONCORRENCIA}`, ...lote], { cwd: BACKEND, detached: process.platform !== "win32" });
    let saida = "";
    filho.stdout.on("data", (d) => { saida += d; });
    filho.stderr.on("data", (d) => { saida += d; });
    let interrompido = null;
    const vigia = setInterval(() => {
      const gb = livreGb();
      if (gb < MINIMO_GB / 2 && !interrompido) { interrompido = gb; matarArvore(filho.pid); }
    }, 10_000);
    filho.on("close", (status) => { clearInterval(vigia); resolver({ status, saida, interrompido }); });
  });
}

const CHAVES = ["tests", "pass", "fail", "skipped", "todo", "cancelled"];
const total = Object.fromEntries(CHAVES.map((k) => [k, 0]));
const falhas = [];
let parado = false;
for (let i = 0; i < arquivos.length; i += LOTE) {
  const lote = arquivos.slice(i, i + LOTE);
  const gb = livreGb();
  process.stdout.write(`\n=== lote ${i / LOTE + 1}/${Math.ceil(arquivos.length / LOTE)} (${lote.length} arquivos) — ${gb.toFixed(1)} GB livres\n`);
  if (gb < MINIMO_GB) { process.stdout.write(`PARADO: menos de ${MINIMO_GB} GB livres antes do lote. Nada mais foi executado.\n`); parado = true; break; }
  const { status, saida, interrompido } = await rodarLote(lote);
  const valor = (k) => (saida.match(new RegExp(`^ℹ ${k} (\\d+)$`, "m")) ?? [])[1];
  for (const k of CHAVES) total[k] += Number(valor(k) ?? 0);
  process.stdout.write(`${CHAVES.map((k) => `${k} ${valor(k) ?? "?"}`).join(" | ")}\n`);
  if (status !== 0) {
    falhas.push(...lote);
    process.stdout.write(saida.split("\n").filter((l) => /^not ok|^\s+not ok|✖|failureType|error:|Error:|AssertionError|ERRO/.test(l)).slice(0, 80).join("\n") + "\n");
  }
  limpar();
  if (interrompido !== null) { process.stdout.write(`INTERROMPIDO: ${interrompido.toFixed(1)} GB livres durante o lote (abaixo de ${MINIMO_GB / 2} GB).\n`); parado = true; break; }
}
process.stdout.write(`\n=== TOTAL: ${CHAVES.map((k) => `${k} ${total[k]}`).join(" | ")} — ${livreGb().toFixed(1)} GB livres\n`);
if (falhas.length) process.stdout.write(`lotes com falha (arquivos): ${falhas.join(" ")}\n`);
process.exitCode = parado ? 3 : falhas.length ? 1 : 0;
