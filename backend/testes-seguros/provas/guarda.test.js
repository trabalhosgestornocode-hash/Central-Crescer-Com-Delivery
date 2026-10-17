// PROVAS de isolamento do T1. Rodam SOB a guarda (node testes-seguros/executar.mjs --provas) em modo de prova:
// as violações são registradas e recusadas, mas não derrubam o processo — o objetivo é provar que cada vetor é barrado.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dgram from "node:dgram";
import cp from "node:child_process";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { __spawnSyncSemGuardaSomenteProva } from "../guarda.mjs";
import { FICTICIO, HERDAVEIS, montarEnvFicticio, montarArgsNode, carregaArquivoEnv, pareceCredencialReal, hostLocal } from "../ambiente.mjs";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const guardaUrl = pathToFileURL(path.join(aqui, "..", "guarda.mjs")).href;
const LOG = process.env.TESTE_SEGURO_LOG;
const violacoes = () => fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bloqueado = (e) => e?.code === "ERR_ISOLAMENTO_VIOLADO";
const vetorRegistrado = (vetor, desde) => violacoes().slice(desde).some((v) => v.vetor === vetor);
const marca = () => violacoes().length;

describe("ambiente fictício", () => {
  test("a guarda está ativa e o ambiente é o fictício", () => {
    assert.ok(globalThis.__TESTE_SEGURO__?.versao >= 1);
    assert.equal(process.env.SUPABASE_URL, FICTICIO.SUPABASE_URL);
    assert.equal(process.env.NODE_ENV, "test");
  });
  test("só variáveis permitidas + fictícias existem no processo (nada herdado do shell)", () => {
    // O Windows injeta estas ao criar o processo, mesmo com ambiente mínimo (caminhos/nome de usuário; nenhuma é credencial).
    const injetadasPeloSO = ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "USERNAME", "USERPROFILE", "WINDIR", "TEMP", "TMP"];
    const aceitas = new Set([...HERDAVEIS, ...injetadasPeloSO, ...Object.keys(FICTICIO), "NODE_OPTIONS", "TESTE_SEGURO_LOG", "TESTE_SEGURO_MODO_PROVA", "NODE_TEST_CONTEXT"]);
    const extras = Object.keys(process.env).filter((k) => !aceitas.has(k));
    assert.deepEqual(extras, []);
  });
  test("montarEnvFicticio descarta credenciais hostis do ambiente de quem chama", () => {
    const env = montarEnvFicticio({ PATH: "p", SUPABASE_URL: "https://prod.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.cargaCargaCarga.assinaturaAssinatura", DATABASE_URL: "postgres://u:p@db.supabase.co/x", RESEND_API_KEY: "re_real" }, { guardaUrl });
    assert.equal(env.SUPABASE_URL, FICTICIO.SUPABASE_URL);
    assert.equal(env.PATH, "p");
    assert.ok(!("DATABASE_URL" in env) && !("RESEND_API_KEY" in env));
    assert.ok(!Object.values(env).some((v) => /supabase\.co|^eyJ/.test(String(v))));
  });
  test("o comando de execução nunca carrega .env", () => {
    const args = montarArgsNode({ guardaUrl, arquivos: ["test/a.test.js"] });
    assert.equal(carregaArquivoEnv(args), false);
    assert.equal(carregaArquivoEnv(["--env-file=.env"]), true);
    assert.equal(carregaArquivoEnv(["--env-file-if-exists", "x"]), true);  // a forma separada também conta
    assert.equal(carregaArquivoEnv(["--env-file-if-exists=.env"]), true);
  });
  test("detecção de credencial/host real", () => {
    assert.equal(pareceCredencialReal("SUPABASE_URL", "https://abc.supabase.co"), true);
    assert.equal(pareceCredencialReal("SUPABASE_URL", "http://127.0.0.1:9"), false);
    assert.equal(pareceCredencialReal("X", "eyJhbGciOiJIUzI1NiJ9.cargaCargaCarga.assinaturaAssinatura"), true);
    assert.equal(pareceCredencialReal("DATABASE_URL", "postgres://u:p@db.exemplo.com/x"), true);
    assert.equal(pareceCredencialReal("DATABASE_URL", "postgres://u:p@127.0.0.1/x"), false);
    assert.equal(pareceCredencialReal("SUPABASE_SERVICE_ROLE_KEY", "chave-real-abc"), true);
    assert.equal(pareceCredencialReal("SUPABASE_SERVICE_ROLE_KEY", FICTICIO.SUPABASE_SERVICE_ROLE_KEY), false);
    assert.equal(hostLocal("127.0.0.1") && hostLocal("localhost") && hostLocal("::1"), true);
    assert.equal(hostLocal("8.8.8.8") || hostLocal("example.com") || hostLocal("10.0.0.1"), false);
  });
});

describe("rede externa bloqueada", () => {
  test("TCP (net.connect / Socket.connect)", () => {
    const m = marca();
    assert.throws(() => net.connect(53, "8.8.8.8"), bloqueado);
    assert.throws(() => net.createConnection({ host: "example.com", port: 80 }), bloqueado);
    assert.throws(() => new net.Socket().connect(80, "1.1.1.1"), bloqueado);
    assert.ok(vetorRegistrado("net", m));
  });
  test("TLS", () => {
    const m = marca();
    assert.throws(() => tls.connect(443, "example.com"), bloqueado);
    assert.ok(vetorRegistrado("tls", m));
  });
  test("HTTP e HTTPS (request/get)", () => {
    const m = marca();
    assert.throws(() => http.get("http://example.com/"), bloqueado);
    assert.throws(() => http.request({ host: "example.com", path: "/" }), bloqueado);
    assert.throws(() => https.get("https://example.com/"), bloqueado);
    assert.throws(() => https.request(new URL("https://example.com/")), bloqueado);
    assert.ok(vetorRegistrado("http", m) && vetorRegistrado("https", m));
  });
  test("HTTP/2", () => {
    assert.throws(() => http2.connect("https://example.com"), bloqueado);
  });
  test("fetch (string, URL e Request)", async () => {
    const m = marca();
    await assert.rejects(async () => fetch("https://example.com/"), bloqueado);
    await assert.rejects(async () => fetch(new URL("https://example.com/")), bloqueado);
    await assert.rejects(async () => fetch(new Request("https://example.com/")), bloqueado);
    assert.ok(vetorRegistrado("fetch", m));
  });
  test("a URL do Supabase de produção (forma típica) é barrada no fetch", async () => {
    await assert.rejects(async () => fetch("https://exemplo-projeto.supabase.co/rest/v1/perfis"), bloqueado);
  });
  test("UDP externo", () => {
    const s = dgram.createSocket("udp4");
    try { assert.throws(() => s.send("x", 53, "8.8.8.8"), bloqueado); assert.throws(() => s.connect(53, "8.8.8.8"), bloqueado); }
    finally { s.close(); }
  });
  test("DNS: lookup por nome, resolve*, Resolver e promises", async () => {
    const m = marca();
    assert.throws(() => dns.lookup("example.com", () => {}), bloqueado);
    assert.throws(() => dns.resolve4("example.com", () => {}), bloqueado);
    assert.throws(() => dns.resolveTxt("example.com", () => {}), bloqueado);
    assert.throws(() => new dns.Resolver(), bloqueado);
    await assert.rejects(async () => dns.promises.lookup("example.com"), bloqueado);
    assert.throws(() => dns.promises.resolve4("example.com"), bloqueado);
    assert.ok(vetorRegistrado("dns", m));
  });
});

describe("hosts .invalid (RFC 2606): falha simulada localmente, sem consulta DNS", () => {
  test("fetch, net e dns.lookup falham com ENOTFOUND e NÃO contam como violação", async () => {
    const m = marca();
    await assert.rejects(fetch("https://gateway-que-nao-existe.invalid/x"), (e) => e instanceof TypeError && (e.cause?.code === "ENOTFOUND" || /fetch failed/.test(e.message)));
    await new Promise((res) => net.connect(80, "x.invalid").on("error", (e) => { assert.equal(e.code, "ENOTFOUND"); res(); }));
    await assert.rejects(dns.promises.lookup("y.invalid"), (e) => e.code === "ENOTFOUND");
    assert.equal(marca(), m, "nenhum bloqueio deveria ter sido registrado");
  });
  test("nome de um só rótulo (ex.: 'internal') também falha localmente; nome com ponto continua BLOQUEADO", async () => {
    const m = marca();
    await assert.rejects(fetch("http://internal/messages"), (e) => e instanceof TypeError);
    await assert.rejects(dns.promises.lookup("intranet"), (e) => e.code === "ENOTFOUND");
    assert.equal(marca(), m);
    await assert.rejects(async () => fetch("http://intranet.empresa.com.br/"), bloqueado);
  });
});

describe("loopback continua funcionando (testes de rota locais)", () => {
  test("servidor HTTP em 127.0.0.1 atendido por http.get e fetch", async () => {
    const srv = http.createServer((_q, r) => r.end("ok"));
    await new Promise((res) => srv.listen(0, "127.0.0.1", res));
    const { port } = srv.address();
    try {
      const corpo = await new Promise((res, rej) => http.get({ host: "127.0.0.1", port }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d)); }).on("error", rej));
      assert.equal(corpo, "ok");
      assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "ok");
      assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), "ok");
    } finally { srv.close(); }
  });
});

describe("subprocessos", () => {
  test("programas externos e shells são recusados", () => {
    const m = marca();
    assert.throws(() => cp.spawn("curl", ["https://example.com"]), bloqueado);
    assert.throws(() => cp.spawnSync("whoami"), bloqueado);
    assert.throws(() => cp.exec("echo oi"), bloqueado);
    assert.throws(() => cp.execSync("echo oi"), bloqueado);
    assert.throws(() => cp.execFile("cmd", ["/c", "dir"]), bloqueado);
    assert.throws(() => cp.execFileSync("psql", ["--version"]), bloqueado);
    assert.throws(() => cp.spawn("node", ["-e", "1"], { shell: true }) && cp.spawn("sh", ["-c", "1"]), bloqueado);
    assert.ok(vetorRegistrado("subprocesso", m));
  });
  test("o que o TESTE declara chega ao filho (flags, URL de produção simulada), mas o filho segue sem rede", () => {
    const r = cp.spawnSync(process.execPath, ["-e", `
      console.log(JSON.stringify({ f: process.env.MINHA_FLAG_DE_TESTE, u: process.env.SUPABASE_URL }));
      fetch(process.env.SUPABASE_URL + "/rest/v1/x").catch((e) => console.log(e.code));`],
      { env: { MINHA_FLAG_DE_TESTE: "ligada", SUPABASE_URL: "https://producao-simulada.supabase.co" }, encoding: "utf8" });
    const [l1, l2] = r.stdout.trim().split(/\r?\n/);
    assert.deepEqual(JSON.parse(l1), { f: "ligada", u: "https://producao-simulada.supabase.co" });
    assert.equal(l2, "ERR_ISOLAMENTO_VIOLADO");
  });
  test("URL ilegível não é violação: o fetch original rejeita antes de qualquer rede", async () => {
    const m = marca();
    await assert.rejects(fetch("gateway interno sem protocolo"), (e) => e instanceof TypeError);
    assert.equal(marca(), m);
  });
  test("node filho é permitido, herda a guarda e, sem env declarado, recebe o ambiente fictício (nunca o do shell)", () => {
    const r = cp.spawnSync(process.execPath, ["-e", "console.log(JSON.stringify({g:!!globalThis.__TESTE_SEGURO__,u:process.env.SUPABASE_URL,k:process.env.SUPABASE_SERVICE_ROLE_KEY}))"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual([o.g, o.u, o.k], [true, FICTICIO.SUPABASE_URL, FICTICIO.SUPABASE_SERVICE_ROLE_KEY]);
  });
  test("env declarado SEM chaves do Supabase: o filho recebe os padrões fictícios (não fica sem configuração)", () => {
    const r = cp.spawnSync(process.execPath, ["-e", "console.log(process.env.SUPABASE_URL)"], { env: { OUTRA: "1" }, encoding: "utf8" });
    assert.equal(r.stdout.trim(), FICTICIO.SUPABASE_URL);
  });
  test("node filho também não alcança a rede, e o bloqueio fica registrado com o pid do filho", () => {
    const m = marca();
    const r = cp.spawnSync(process.execPath, ["-e", "fetch('https://example.com').then(()=>console.log('PASSOU')).catch((e)=>console.log(e.code))"], { encoding: "utf8" });
    assert.equal(r.stdout.trim(), "ERR_ISOLAMENTO_VIOLADO");
    const novos = violacoes().slice(m);
    assert.ok(novos.some((v) => v.vetor === "fetch" && v.pid !== process.pid));
  });
  test("fork recebe a guarda e o ambiente fictício", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-prova-"));
    const f = path.join(dir, "filho.mjs");
    fs.writeFileSync(f, "process.send({g:!!globalThis.__TESTE_SEGURO__,u:process.env.SUPABASE_URL});");
    try {
      const msg = await new Promise((res, rej) => { const c = cp.fork(f, [], { env: { SUPABASE_URL: "https://producao.supabase.co" } }); c.on("message", res); c.on("error", rej); });
      assert.deepEqual(msg, { g: true, u: "https://producao.supabase.co" });   // literal declarado pelo teste; a guarda segue ativa
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test("filho iniciado com --env-file aborta (97) em vez de carregar .env", () => {
    const r = cp.spawnSync(process.execPath, ["--env-file-if-exists=nao-existe.env", "-e", "console.log('rodou')"], { encoding: "utf8" });
    // Nosso wrapper insere a guarda ANTES; o argumento proibido continua nos execArgv do filho => a guarda aborta.
    assert.equal(r.status, 97, r.stdout + r.stderr);
    assert.ok(!/rodou/.test(r.stdout));
  });
});

describe("worker threads", () => {
  const rodar = (codigo, opts = {}) => new Promise((res, rej) => {
    const w = new Worker(codigo, { eval: true, ...opts });
    w.on("message", res); w.on("error", rej);
  });
  test("worker herda a guarda: rede externa bloqueada (mesmo com URL de produção declarada)", async () => {
    const m = marca();
    const msg = await rodar(`
      const { parentPort } = require("node:worker_threads");
      fetch("https://example.com").then(() => parentPort.postMessage({ rede: "PASSOU" }), (e) => parentPort.postMessage({ rede: e.code, g: !!globalThis.__TESTE_SEGURO__, u: process.env.SUPABASE_URL }));
    `, { env: { SUPABASE_URL: "https://producao.supabase.co" } });
    assert.deepEqual(msg, { rede: "ERR_ISOLAMENTO_VIOLADO", g: true, u: "https://producao.supabase.co" });
    assert.ok(violacoes().slice(m).some((v) => v.thread === "worker"));
  });
  test("worker não consegue abrir subprocesso externo", async () => {
    const msg = await rodar(`
      const { parentPort } = require("node:worker_threads");
      try { require("node:child_process").spawnSync("whoami"); parentPort.postMessage("PASSOU"); } catch (e) { parentPort.postMessage(e.code); }
    `);
    assert.equal(msg, "ERR_ISOLAMENTO_VIOLADO");
  });
});

describe("arquivos .env", () => {
  test("ler qualquer .env (inclusive inexistente) é recusado; .env.example é permitido", async () => {
    const m = marca();
    assert.throws(() => fs.readFileSync(path.join(aqui, "..", "..", ".env")), bloqueado);
    assert.throws(() => fs.readFileSync(path.join(aqui, "nao-existe", ".env.test")), bloqueado);
    assert.throws(() => fs.openSync(".env.test-integracao", "r"), bloqueado);
    await assert.rejects(fs.promises.readFile(".env"), bloqueado);
    assert.throws(() => fs.createReadStream(".env"), bloqueado);
    if (process.loadEnvFile) assert.throws(() => process.loadEnvFile(".env"), bloqueado);
    assert.ok(vetorRegistrado("env", m));
    assert.ok(fs.readFileSync(path.join(aqui, "..", "..", ".env.example"), "utf8").length > 0);
  });
});

describe("falha fechada no arranque e no executor", () => {
  const semGuarda = (args, env) => __spawnSyncSemGuardaSomenteProva(process.execPath, args, { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, encoding: "utf8" });
  test("sem TESTE_SEGURO=1 a guarda não inicia", () => {
    const r = semGuarda(["--import", guardaUrl, "-e", "console.log('rodou')"], {});
    assert.equal(r.status, 97); assert.match(r.stderr, /TESTE_SEGURO/); assert.ok(!/rodou/.test(r.stdout));
  });
  test("credencial real no ambiente impede o arranque", () => {
    const r = semGuarda(["--import", guardaUrl, "-e", "console.log('rodou')"], { TESTE_SEGURO: "1", SUPABASE_URL: "https://producao.supabase.co" });
    assert.equal(r.status, 97); assert.match(r.stderr, /SUPABASE_URL/); assert.ok(!/rodou/.test(r.stdout));
  });
  test("NODE_OPTIONS com --env-file impede o arranque", () => {
    const r = semGuarda(["--import", guardaUrl, "-e", "console.log('rodou')"], { TESTE_SEGURO: "1", NODE_OPTIONS: "--env-file=.env" });
    // O próprio Node recusa --env-file em NODE_OPTIONS (9); a guarda aborta com 97 caso isso mude. Nunca executa.
    assert.ok([9, 97].includes(r.status), `status ${r.status}`);
    assert.ok(!/rodou/.test(r.stdout));
  });
  test("o executor: ambiente hostil do chamador não chega ao teste, e violação engolida pelo teste derruba a execução (exit 1)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-prova-"));
    const t = path.join(dir, "hostil.test.js");
    fs.writeFileSync(t, `
      import { test } from "node:test"; import assert from "node:assert/strict";
      test("ve o ambiente fictício", () => assert.equal(process.env.SUPABASE_URL, "${FICTICIO.SUPABASE_URL}"));
      test("tenta sair e engole o erro", async () => { try { await fetch("https://example.com"); } catch { /* engolido de propósito */ } });
    `);
    try {
      const r = semGuarda([path.join(aqui, "..", "executar.mjs"), t], { SUPABASE_URL: "https://producao.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "eyJreal", TESTE_SEGURO_MODO_PROVA: "0" });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /VIOLAÇ/);
      assert.match(r.stderr, /fetch: example\.com/);
      assert.match(r.stdout, /pass 2|ok 1 - ve o ambiente/);   // o 1º teste passou: o ambiente hostil não vazou
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test("o executor recusa --env-file", () => {
    const r = semGuarda([path.join(aqui, "..", "executar.mjs"), "--env-file=.env"], {});
    // O Node interpreta --env-file mesmo depois do script (9 = arquivo ausente); se existisse, o executor recusaria (2).
    // Em ambos os casos nenhum teste roda — e o ambiente do filho é sempre construído do zero, nunca herdado.
    assert.ok([2, 9].includes(r.status), `status ${r.status}`);
    assert.ok(!/T1 —/.test(r.stdout));
  });
});
