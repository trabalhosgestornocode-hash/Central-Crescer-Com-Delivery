// Worker de Events do iFood — ciclo de vida do PROCESSO, testado num processo-filho REAL.
//
// Os testes do loop (ifood-events-poller.test.js) injetam `sleep`, então nunca exercitaram o dormir real:
// foi assim que o `unref()` do timer passou — sem health server, o timer era o único handle vivo e o Node
// saía com código 0 logo depois do 1º ciclo (sem liberar o lease). Aqui NADA é mascarado: loop real,
// setTimeout real, ciclo de vida real (src/worker-ifood/lifecycle.js), sem health server. Só o poller é
// falso (test/helpers/ifood-worker-fixture.mjs).
//
//   A  depois do 1º ciclo o processo continua VIVO dormindo (piso de 30 s)
//   B  SIGTERM durante o sono: acorda, libera o lease e sai com 0
//   C  o loop termina sem shutdown pedido: log estruturado, lease liberado e saída 1 (nunca "saudável")
//   D  o entrypoint real sobe só com variáveis de ambiente do processo (sem .env)
//
// SIGTERM: em POSIX (Render) o teste manda o sinal real; no Windows o sinal não chega a handlers, então o
// teste pede por IPC e o fixture dispara o MESMO handler registrado pelo ciclo de vida.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(AQUI, "..");
const FIXTURE = path.join(AQUI, "helpers", "ifood-worker-fixture.mjs");
const WINDOWS = process.platform === "win32";

function iniciarFilho(args, { env = {}, ipc = WINDOWS } = {}) {
  const filho = spawn(process.execPath, args, {
    cwd: BACKEND,
    // ambiente mínimo e explícito: nada de .env, nada herdado que ligue algo por engano
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  const eventos = [];
  let resto = "";
  let stderr = "";
  const esperando = [];
  filho.stdout.on("data", (b) => {
    resto += b.toString();
    const linhas = resto.split("\n");
    resto = linhas.pop();
    for (const l of linhas) {
      if (!l.trim()) continue;
      let ev;
      try { ev = JSON.parse(l); } catch { ev = { evento: "_texto", texto: l }; }
      eventos.push(ev);
      for (const w of [...esperando]) if (w.nome === ev.evento) { esperando.splice(esperando.indexOf(w), 1); w.resolve(ev); }
    }
  });
  filho.stderr.on("data", (b) => { stderr += b.toString(); });
  const saida = new Promise((resolve) => filho.on("exit", (code, signal) => resolve({ code, signal })));
  return {
    filho, eventos, saida,
    get stderr() { return stderr; },
    vivo: () => filho.exitCode === null && filho.signalCode === null,
    esperar(nome, ms = 10_000) {
      const ja = eventos.find((e) => e.evento === nome);
      if (ja) return Promise.resolve(ja);
      return new Promise((resolve, reject) => {
        const w = { nome, resolve };
        esperando.push(w);
        setTimeout(() => reject(new Error(`timeout esperando "${nome}"; eventos: ${JSON.stringify(eventos)}; stderr: ${stderr}`)), ms).unref();
        saida.then(() => setTimeout(() => {
          if (esperando.includes(w)) reject(new Error(`processo saiu antes de "${nome}"; eventos: ${JSON.stringify(eventos)}; stderr: ${stderr}`));
        }, 50));
      });
    },
    sigterm() { if (WINDOWS) filho.send("SIGTERM"); else filho.kill("SIGTERM"); },
    matar() { if (this.vivo()) filho.kill("SIGKILL"); },
  };
}
const esperarMs = (ms) => new Promise((r) => setTimeout(r, ms));

test("A — depois do 1º ciclo o worker continua VIVO dormindo (sem health server, timer real)", async () => {
  const w = iniciarFilho([FIXTURE, "normal"]);
  try {
    await w.esperar("pronto");
    await w.esperar("ciclo");
    await esperarMs(1500);   // bem depois do ciclo: com o unref, o processo já teria saído com 0
    assert.equal(w.vivo(), true, `o processo saiu sozinho depois do 1º ciclo; eventos: ${JSON.stringify(w.eventos)}`);
    assert.equal(w.eventos.filter((e) => e.evento === "ciclo").length, 1, "dormindo: nenhum ciclo extra antes dos 30 s");
    assert.ok(!w.eventos.some((e) => e.evento === "worker.loop_terminou_inesperadamente"));
  } finally { w.matar(); }
});

test("B — SIGTERM durante o sono: acorda, libera o lease e sai com código 0", async () => {
  const w = iniciarFilho([FIXTURE, "normal"]);
  try {
    await w.esperar("ciclo");
    await esperarMs(300);
    assert.equal(w.vivo(), true);
    const t0 = Date.now();
    w.sigterm();
    const { code } = await w.saida;
    assert.equal(code, 0, `stderr: ${w.stderr}`);
    assert.ok(Date.now() - t0 < 5000, "não esperou o sono de 30 s terminar");
    const nomes = w.eventos.map((e) => e.evento);
    assert.ok(nomes.includes("worker.encerrando"));
    assert.ok(nomes.includes("lease_liberado"), "lease liberado no shutdown");
    assert.ok(nomes.indexOf("lease_liberado") < nomes.indexOf("worker.encerrado"));
    assert.equal(w.eventos.find((e) => e.evento === "worker.encerrado").codigo, 0);
    assert.equal(w.eventos.filter((e) => e.evento === "ciclo").length, 1, "nenhum ciclo novo depois do SIGTERM");
  } finally { w.matar(); }
});

test("C — o loop termina sem shutdown pedido: log de erro estruturado, lease liberado e saída 1", async () => {
  const w = iniciarFilho([FIXTURE, "loop-quebra"]);
  try {
    const { code } = await w.saida;
    assert.equal(code, 1, "término inesperado NUNCA sai com 0");
    const erro = w.eventos.find((e) => e.evento === "worker.loop_terminou_inesperadamente");
    assert.ok(erro, `sem o log estruturado; eventos: ${JSON.stringify(w.eventos)}`);
    assert.equal(erro.nivel, "error");
    assert.equal(erro.motivo, "loop_falhou");
    assert.match(erro.erro, /log do loop quebrou/);
    assert.ok(w.eventos.some((e) => e.evento === "lease_liberado"), "libera o lease para outro worker assumir sem esperar o TTL");
    assert.ok(!w.eventos.some((e) => e.evento === "worker.encerrado"), "não finge um shutdown normal");
  } finally { w.matar(); }
});

test("D — o entrypoint real sobe SÓ com variáveis de ambiente (sem .env): desligado por padrão, sai com 0", async () => {
  const w = iniciarFilho(["src/worker-ifood/index.js"], { ipc: false, env: { IFOOD_EVENTS_WORKER_ENABLED: "false" } });
  const { code } = await w.saida;
  assert.equal(code, 0, `stderr: ${w.stderr}`);
  assert.doesNotMatch(w.stderr, /\.env|not found|ENOENT/i);
  assert.ok(w.eventos.some((e) => /DESABILITADO/.test(e.texto ?? "")), JSON.stringify(w.eventos));
});

test("scripts: `worker:ifood` (produção/Render) NÃO depende de arquivo .env; o de desenvolvimento local continua existindo", () => {
  const { scripts } = JSON.parse(readFileSync(path.join(BACKEND, "package.json"), "utf8"));
  assert.equal(scripts["worker:ifood"], "node src/worker-ifood/index.js");
  assert.match(scripts["dev:worker:ifood"], /--env-file=\.env\b.*src\/worker-ifood\/index\.js/);
  assert.match(scripts["worker:ifood:centralized-test"], /scripts\/worker-ifood-centralized-test\.mjs/, "Teste (C) inalterado");
});

test("o dormir do loop NÃO usa unref (o timer precisa manter o worker vivo) e o entrypoint usa o ciclo de vida", () => {
  const semComentarios = (f) => readFileSync(path.join(BACKEND, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  const poller = semComentarios("src/modules/ifood/ifoodEvents.poller.js");
  const dormir = poller.slice(poller.indexOf("const dormir"), poller.indexOf("async function rodar"));
  assert.ok(dormir.length > 0);
  assert.doesNotMatch(dormir, /unref/);
  assert.match(semComentarios("src/worker-ifood/index.js"), /executarWorker\(/);
});
