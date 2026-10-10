// Encerramento do backend com SIGTERM de VERDADE, num processo filho — e o comando de início do serviço.
//
// Por que existe: em produção (Render) o encerramento gracioso nunca rodava. O serviço iniciava por
// `npm start`, e o npm NÃO repassa o SIGTERM ao Node: o Node seguia consultando o iFood até ser morto por
// SIGKILL, e o lease do poller vencia em vez de ser liberado. O handler em si (servidor.lifecycle.js) sempre
// esteve certo — faltava o sinal chegar. Por isso:
//   1. o comando de início tem de pôr o NODE como o processo que recebe o sinal (`exec node ...`, nunca `npm`);
//   2. com o sinal chegando, o processo para o poller, espera o ciclo em voo, libera o lease e sai sozinho.
//
// Os testes de processo precisam de sinais POSIX: no Windows o SIGTERM não chega a handlers (são pulados).
// Sem Supabase, sem iFood: test/helpers/servidor-sigterm-app.mjs usa repositório, cliente e token falsos.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, "..", "..");
const APP = path.join(AQUI, "helpers", "servidor-sigterm-app.mjs");
const SEM_SINAIS = process.platform === "win32" && "SIGTERM não chega a handlers no Windows";

// ---------------------------------------------------------------------------
// Comando de início: o Node tem de ser o processo que recebe o sinal
// ---------------------------------------------------------------------------
describe("comando de início do serviço", () => {
  const blueprint = readFileSync(path.join(RAIZ, "render.yaml"), "utf8");
  const inicio = blueprint.match(/^\s*startCommand:\s*(.+)$/m)?.[1]?.trim() ?? "";

  test("render.yaml inicia o Node com `exec` — sem npm no meio do caminho do sinal", () => {
    assert.ok(inicio, "startCommand ausente no render.yaml");
    assert.doesNotMatch(inicio, /\bnpm\b|\byarn\b|\bpnpm\b|\bnpx\b/, `"${inicio}": gerenciador de pacotes não repassa SIGTERM ao Node`);
    assert.match(inicio, /(^|&&\s*)exec node src\/server\.js$/, `"${inicio}": o último comando tem de ser "exec node src/server.js"`);
  });

  test("o script `start` continua existindo para uso local (mesmo arquivo de entrada)", () => {
    const pkg = JSON.parse(readFileSync(path.join(RAIZ, "backend", "package.json"), "utf8"));
    assert.equal(pkg.scripts.start, "node src/server.js");
  });

  test("o guia de deploy manda iniciar pelo Node, não pelo npm", () => {
    const guia = readFileSync(path.join(RAIZ, "docs", "DEPLOY.md"), "utf8");
    assert.match(guia, /\*\*Start:\*\* `node src\/server\.js`/);
    assert.doesNotMatch(guia, /\*\*Start:\*\* `npm start`/);
  });
});

// ---------------------------------------------------------------------------
// Processo real + SIGTERM real
// ---------------------------------------------------------------------------
/** Sobe o app de teste com o Node como processo principal, manda SIGTERM e devolve o que aconteceu. */
function rodar({ pollMs = 0, esperarMarca = "CICLO=OK", atrasoMs = 100 } = {}) {
  return new Promise((resolve, reject) => {
    const filho = spawn(process.execPath, [APP], { env: { ...process.env, SIG_POLL_MS: String(pollMs) }, stdio: ["ignore", "pipe", "pipe"] });
    let saida = ""; let erro = ""; let enviado = null;
    const prazo = setTimeout(() => { filho.kill("SIGKILL"); reject(new Error(`o processo não terminou sozinho.\n${saida}\n${erro}`)); }, 25_000);
    filho.stderr.on("data", (d) => { erro += d; });
    filho.stdout.on("data", (d) => {
      saida += d;
      if (enviado == null && saida.includes(`MARCA ${esperarMarca}`)) {
        enviado = 0;
        setTimeout(() => { enviado = Date.now(); filho.kill("SIGTERM"); }, atrasoMs);
      }
    });
    filho.on("exit", (codigo, sinal) => {
      clearTimeout(prazo);
      const marcas = saida.split("\n").filter((l) => l.startsWith("MARCA ")).map((l) => l.slice(6));
      resolve({ codigo, sinal, marcas, duracaoMs: enviado ? Date.now() - enviado : null, erro });
    });
  });
}
const indice = (marcas, prefixo) => marcas.findIndex((m) => m.startsWith(prefixo));

describe("SIGTERM em processo real (Node como processo principal)", { skip: SEM_SINAIS }, () => {
  test("poller ocioso: o handler roda, o poller para, o lease é liberado e o processo sai sozinho com código 0", async () => {
    const r = await rodar();
    assert.deepEqual([r.codigo, r.sinal], [0, null], r.marcas.join(" | ") + r.erro);
    assert.ok(r.marcas.includes("LOG [SIGTERM] encerrando servidor…"), "o handler do servidor.lifecycle.js recebeu o sinal");
    assert.ok(r.marcas.includes("LEASE_LIBERADO=true"));
    assert.ok(r.marcas.includes("POLLER_PARADO drenado=true leaseLiberado=true"));
    assert.ok(r.marcas.at(-1).startsWith("EXIT codigo=0 leaseVivo=false"), "na saída o lease já não está com este processo");
    assert.ok(r.duracaoMs < 3_000, `saiu em ${r.duracaoMs} ms`);
    // Nenhuma consulta nova depois do sinal.
    assert.equal(indice(r.marcas.slice(indice(r.marcas, "LOG [SIGTERM]")), "POLL_INICIO"), -1);
  });

  test("SIGTERM no meio de uma consulta: espera o ciclo em voo terminar e SÓ ENTÃO libera o lease", async () => {
    const r = await rodar({ pollMs: 1_500, esperarMarca: "POLL_INICIO", atrasoMs: 300 });
    assert.equal(r.codigo, 0, r.marcas.join(" | "));
    const iSinal = indice(r.marcas, "LOG [SIGTERM]");
    const iCiclo = indice(r.marcas, "CICLO=OK");
    const iLease = indice(r.marcas, "LEASE_LIBERADO=true");
    assert.ok(iSinal >= 0 && iCiclo > iSinal, "o ciclo em andamento terminou depois do sinal (não foi cortado)");
    assert.ok(iLease > iCiclo, "o lease só é liberado depois do ciclo terminar");
    assert.ok(r.marcas.includes("POLLER_PARADO drenado=true leaseLiberado=true"));
    assert.equal(r.marcas.filter((m) => m === "CICLO=OK").length, 1, "nenhum ciclo novo começou depois do sinal");
  });

  test("consulta mais longa que o prazo de parada: sai no prazo e NÃO libera o lease (o ciclo ainda pode reconhecer eventos)", async () => {
    const r = await rodar({ pollMs: 20_000, esperarMarca: "POLL_INICIO", atrasoMs: 300 });
    assert.equal(r.codigo, 0, r.marcas.join(" | "));
    assert.ok(r.marcas.includes("POLLER_PARADO drenado=false leaseLiberado=false"));
    assert.ok(!r.marcas.some((m) => m.startsWith("LEASE_LIBERADO")), "sem drenar, o lease vence sozinho pelo TTL — nunca é liberado no meio");
    assert.ok(r.marcas.at(-1).startsWith("EXIT codigo=0 leaseVivo=true"));
    assert.ok(r.duracaoMs >= 6_500 && r.duracaoMs < 10_500, `respeitou o prazo de 7 s e a rede de segurança de 10 s (${r.duracaoMs} ms)`);
  });

  test("segundo SIGTERM durante a parada não dispara um segundo encerramento", async () => {
    const r = await new Promise((resolve, reject) => {
      const filho = spawn(process.execPath, [APP], { env: { ...process.env, SIG_POLL_MS: "1200" }, stdio: ["ignore", "pipe", "pipe"] });
      let saida = ""; let enviou = false;
      const prazo = setTimeout(() => { filho.kill("SIGKILL"); reject(new Error(saida)); }, 20_000);
      filho.stdout.on("data", (d) => {
        saida += d;
        if (!enviou && saida.includes("MARCA POLL_INICIO")) { enviou = true; setTimeout(() => filho.kill("SIGTERM"), 200); setTimeout(() => filho.kill("SIGTERM"), 500); }
      });
      filho.on("exit", (codigo) => { clearTimeout(prazo); resolve({ codigo, marcas: saida.split("\n").filter((l) => l.startsWith("MARCA ")).map((l) => l.slice(6)) }); });
    });
    assert.equal(r.codigo, 0);
    assert.equal(r.marcas.filter((m) => m.startsWith("LOG [SIGTERM]")).length, 1);
    assert.equal(r.marcas.filter((m) => m.startsWith("PARANDO_POLLER")).length, 1);
    assert.equal(r.marcas.filter((m) => m === "LEASE_LIBERADO=true").length, 1);
  });
});
