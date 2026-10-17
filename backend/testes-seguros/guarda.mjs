// GUARDA DE ISOLAMENTO do T1 — pré-carregada (`node --import`) em todo processo, subprocesso e worker dos testes.
//
// Falha FECHADA: qualquer tentativa de sair do computador (rede, DNS, UDP, HTTP/2), de abrir um shell/programa externo, de
// ler um arquivo .env ou de iniciar com credencial real no ambiente é (1) registrada no arquivo de violações,
// (2) recusada com ERR_ISOLAMENTO_VIOLADO e (3) faz o processo terminar com código 1 — mesmo que o teste engula o erro.
// Só loopback (127.0.0.0/8, ::1, localhost) e sockets locais passam. Não depende de nenhum pacote do projeto.
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dgram from "node:dgram";
import cp from "node:child_process";
import wt from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { hostLocal, pareceCredencialReal, carregaArquivoEnv, montarEnvFicticio } from "./ambiente.mjs";

const AQUI = fileURLToPath(import.meta.url);
const GUARDA_URL = pathToFileURL(AQUI).href;
const LOG = process.env.TESTE_SEGURO_LOG || null;
const MODO_PROVA = process.env.TESTE_SEGURO_MODO_PROVA === "1";
const NODE_EXE = path.resolve(process.execPath).toLowerCase();

const appendSync = fs.appendFileSync.bind(fs);
const realEnv = { ...process.env };

function abortar(motivo) {
  process.stderr.write(`\n[testes-seguros] ABORTADO (falha fechada): ${motivo}\n`);
  process.exit(97);
}

// ---------- 0. Pré-condições de arranque ----------
if (process.env.TESTE_SEGURO !== "1") abortar("a guarda só roda sob testes-seguros/executar.mjs (TESTE_SEGURO!=1).");
if (carregaArquivoEnv(process.execArgv) || /--env-file/.test(process.env.NODE_OPTIONS ?? "")) abortar("--env-file é proibido no T1.");
// Só o processo RAIZ (criado pelo executor) confere o ambiente: filhos/workers recebem o que o teste declarou (ver envSeguro).
if (process.env.TESTE_SEGURO_FILHO !== "1") {
  for (const [nome, valor] of Object.entries(process.env)) {
    if (nome === "NODE_OPTIONS") continue;
    if (pareceCredencialReal(nome, valor)) abortar(`variável ${nome} parece credencial/host real.`);
  }
}

// ---------- registro de violações ----------
let violacoes = 0;
export function violacoesDesteProcesso() { return violacoes; }

function violar(vetor, alvo) {
  violacoes++;
  const linha = JSON.stringify({ pid: process.pid, thread: wt.isMainThread ? "main" : "worker", vetor, alvo: String(alvo).slice(0, 200), em: new Date().toISOString() });
  try { if (LOG) appendSync(LOG, linha + "\n"); } catch { /* o processo ainda falha pelo exitCode */ }
  if (!MODO_PROVA) process.exitCode = 1;
  const e = new Error(`[testes-seguros] ${vetor} bloqueado: ${alvo}`);
  e.code = "ERR_ISOLAMENTO_VIOLADO";
  throw e;
}
if (!MODO_PROVA) process.on("exit", () => { if (violacoes > 0) process.exitCode = 1; });

// ---------- 1. Rede (TCP/TLS/HTTP/HTTP2/fetch/UDP) ----------
const alvoDe = (a) => {
  if (a == null) return null;
  if (typeof a === "string") { try { return new URL(a).hostname || null; } catch { return null; } }   // ilegível: a API original rejeita antes de qualquer rede
  if (a instanceof URL) return a.hostname;
  if (typeof a === "object") return a.hostname ?? a.host ?? (a.url ? alvoDe(a.url) : null);
  return null;
};
// Nomes que NUNCA identificam um host da internet: `.invalid` (RFC 2606) e nomes de UM só rótulo (sem ponto), que só
// resolveriam via configuração da rede local. Não consultamos DNS para eles: a falha ENOTFOUND é SIMULADA aqui.
const ehInvalido = (h) => {
  const s = String(h ?? "").toLowerCase();
  if (!s || net.isIP(s) || hostLocal(s)) return false;
  return /\.invalid$/.test(s) || !s.includes(".");
};
const nuncaLocal = (host) => !hostLocal(host) && !ehInvalido(host);
const erroNaoEncontrado = (hostname) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", errno: -3008, syscall: "getaddrinfo", hostname });

function exigirLocal(vetor, host) {
  if (host == null || host === "") return;            // padrão do Node = localhost
  if (nuncaLocal(host)) violar(vetor, host);
}

const connectOriginal = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let a0 = args[0];
  if (Array.isArray(a0)) a0 = a0[0];                   // forma normalizada interna do Node
  if (a0 && typeof a0 === "object") {
    if (a0.path) return connectOriginal.apply(this, args);                // IPC / named pipe local
    exigirLocal("net", a0.host ?? "localhost");
  } else if (typeof a0 === "number" || (typeof a0 === "string" && /^\d+$/.test(a0))) {
    exigirLocal("net", typeof args[1] === "string" ? args[1] : "localhost");
  } else if (typeof a0 === "string") {
    return connectOriginal.apply(this, args);                              // caminho de socket local
  }
  return connectOriginal.apply(this, args);
};

const tlsConnect = tls.connect;
tls.connect = function (...args) {
  const o = typeof args[0] === "object" && args[0] !== null ? args[0] : { port: args[0], host: typeof args[1] === "string" ? args[1] : undefined };
  exigirLocal("tls", o.host ?? o.servername ?? "localhost");
  return tlsConnect.apply(this, args);
};

for (const [nome, mod] of [["http", http], ["https", https]]) {
  for (const fn of ["request", "get"]) {
    const orig = mod[fn];
    mod[fn] = function (...args) {
      const a = typeof args[0] === "string" || args[0] instanceof URL ? args[0] : args[0];
      exigirLocal(nome, alvoDe(a) ?? alvoDe(args[1]) ?? "localhost");
      return orig.apply(this, args);
    };
  }
}
const h2connect = http2.connect;
http2.connect = function (authority, ...r) { exigirLocal("http2", alvoDe(authority)); return h2connect.call(this, authority, ...r); };

if (typeof globalThis.fetch === "function") {
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = function (input, ...r) {
    try { exigirLocal("fetch", alvoDe(input instanceof Request ? input.url : input)); }
    catch (e) { return Promise.reject(e); }
    return fetchOriginal.call(this, input, ...r);
  };
}

const dgramSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  const dest = args.find((x, i) => i > 0 && typeof x === "string" && !/^\d+$/.test(x));
  if (dest !== undefined) exigirLocal("udp", dest);
  return dgramSend.apply(this, args);
};
const dgramConnect = dgram.Socket.prototype.connect;
dgram.Socket.prototype.connect = function (port, address, ...r) { exigirLocal("udp", typeof address === "string" ? address : "localhost"); return dgramConnect.call(this, port, address, ...r); };

// ---------- 2. DNS ----------
const dnsLookup = dns.lookup;
dns.lookup = function (hostname, ...r) {
  if (ehInvalido(hostname)) {                       // falha simulada: nenhuma consulta DNS sai do computador
    const cb = r.find((x) => typeof x === "function");
    if (cb) process.nextTick(cb, erroNaoEncontrado(hostname));
    return {};
  }
  if (hostname && !net.isIP(String(hostname))) exigirLocal("dns", hostname);
  return dnsLookup.call(this, hostname, ...r);
};
const bloqueioDns = (nome) => () => violar("dns", nome);
for (const k of Object.keys(dns)) {
  if (/^resolve/.test(k) || k === "reverse" || k === "lookupService" || k === "getServers") { if (typeof dns[k] === "function") dns[k] = bloqueioDns(`dns.${k}`); }
}
dns.Resolver = class { constructor() { violar("dns", "dns.Resolver"); } };
const dnsP = dns.promises;
const dnsPLookup = dnsP.lookup;
dnsP.lookup = function (hostname, ...r) {
  if (ehInvalido(hostname)) return Promise.reject(erroNaoEncontrado(hostname));
  if (hostname && !net.isIP(String(hostname))) exigirLocal("dns", hostname);
  return dnsPLookup.call(this, hostname, ...r);
};
for (const k of Object.keys(dnsP)) { if (/^resolve/.test(k) || k === "reverse" || k === "lookupService") dnsP[k] = bloqueioDns(`dns.promises.${k}`); }
dnsP.Resolver = class { constructor() { violar("dns", "dns.promises.Resolver"); } };

// ---------- 3. Subprocessos: só `node`, sempre com a guarda e ambiente fictício ----------
const ehNode = (file) => {
  const f = String(file ?? "");
  return path.resolve(f).toLowerCase() === NODE_EXE || /^(node|node\.exe)$/i.test(path.basename(f)) && !/[\\/]/.test(f);
};
const spawnSyncBruto = cp.spawnSync;   // antes do patch; usado só pelo gancho de prova
/**
 * Ambiente de um filho/worker. O que o PRÓPRIO TESTE declara (literais do código-fonte, que é público — ex.: URL de
 * "produção" fictícia para provar que a configuração a recusa, ou flags de feature) PREVALECE. A proteção não está em
 * filtrar esses literais, e sim em (1) o processo raiz ter sido construído do zero (nada do shell existe aqui) e
 * (2) a rede/subprocessos/.env continuarem bloqueados em TODO filho (a guarda é reimposta). Faltando, entram os padrões
 * fictícios e o mínimo para o Node existir (PATH etc.).
 */
const envSeguro = (doTeste) => {
  const base = doTeste && typeof doTeste === "object" ? doTeste : process.env;
  const declarado = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && v !== null) declarado[k] = String(v);
  const padrao = montarEnvFicticio(realEnv, { guardaUrl: GUARDA_URL, logPath: LOG ?? undefined, modoProva: MODO_PROVA });
  return { ...padrao, ...declarado, NODE_OPTIONS: padrao.NODE_OPTIONS, TESTE_SEGURO: "1", TESTE_SEGURO_FILHO: "1",
    ...(LOG ? { TESTE_SEGURO_LOG: LOG } : {}), ...(MODO_PROVA ? { TESTE_SEGURO_MODO_PROVA: "1" } : {}) };
};
function comGuardaNosArgs(args) {
  const a = Array.isArray(args) ? [...args] : [];
  return a.includes(GUARDA_URL) ? a : ["--import", GUARDA_URL, ...a];
}
function prepararSpawn(vetor, file, args, options) {
  if (!ehNode(file)) violar("subprocesso", `${vetor}: ${file}`);
  let a = args; let o = options;
  if (!Array.isArray(a)) { o = a; a = []; }
  return [file, comGuardaNosArgs(a), { ...(o ?? {}), env: envSeguro(o?.env), shell: false }];
}
for (const fn of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const orig = cp[fn];
  cp[fn] = function (file, args, options, ...r) {
    const [f, a, o] = prepararSpawn(fn, file, args, options);
    return orig.call(this, f, a, o, ...r);
  };
}
for (const fn of ["exec", "execSync"]) cp[fn] = function (comando) { return violar("subprocesso", `${fn}: ${String(comando).slice(0, 80)}`); };
const forkOrig = cp.fork;
cp.fork = function (modulo, args, options) {
  let a = args; let o = options;
  if (!Array.isArray(a)) { o = a; a = []; }
  const execArgv = [...(o?.execArgv ?? process.execArgv)];
  if (!execArgv.includes(GUARDA_URL)) execArgv.push("--import", GUARDA_URL);
  return forkOrig.call(this, modulo, a, { ...(o ?? {}), execArgv, env: envSeguro(o?.env) });
};

// ---------- 4. Worker threads ----------
const WorkerOriginal = wt.Worker;
wt.Worker = class WorkerGuardado extends WorkerOriginal {
  constructor(file, options = {}) {
    const execArgv = [...(options.execArgv ?? process.execArgv)];
    if (!execArgv.includes(GUARDA_URL)) execArgv.push("--import", GUARDA_URL);
    // Worker `eval` não roda --import (verificado no Node 20): carrega a guarda ANTES do código original.
    const alvo = options.eval === true
      ? `import(${JSON.stringify(GUARDA_URL)}).then(() => (0, eval)(${JSON.stringify(String(file))}));`
      : file;
    super(alvo, { ...options, execArgv, env: options.env === wt.SHARE_ENV ? wt.SHARE_ENV : envSeguro(options.env) });
  }
};

// ---------- 5. Arquivos .env ----------
const ehArquivoEnv = (p) => {
  try {
    if (typeof p === "number") return false;
    const caminho = p instanceof URL ? fileURLToPath(p) : Buffer.isBuffer(p) ? p.toString() : String(p);
    const base = path.basename(caminho).toLowerCase();
    return /^\.env(\.|$)/.test(base) && !/\.example$/.test(base);
  } catch { return false; }
};
for (const fn of ["readFileSync", "openSync", "createReadStream", "readFile", "open"]) {
  const orig = fs[fn];
  if (typeof orig !== "function") continue;
  fs[fn] = function (p, ...r) { if (ehArquivoEnv(p)) violar("env", String(p)); return orig.call(this, p, ...r); };
}
for (const fn of ["readFile", "open"]) {
  const orig = fs.promises[fn];
  fs.promises[fn] = function (p, ...r) { if (ehArquivoEnv(p)) return Promise.reject(Object.assign(new Error(`[testes-seguros] env bloqueado: ${p}`), { code: "ERR_ISOLAMENTO_VIOLADO" }, violarSemLancar("env", String(p)))); return orig.call(this, p, ...r); };
}
function violarSemLancar(vetor, alvo) { try { violar(vetor, alvo); } catch { /* registrado */ } return {}; }
if (typeof process.loadEnvFile === "function") process.loadEnvFile = () => violar("env", "process.loadEnvFile");

syncBuiltinESMExports();

// Gancho SÓ para as provas: executa um `node` SEM a guarda (para provar que ela aborta o arranque com credencial real
// e que o executor propaga a falha). Inexistente fora do modo de prova.
export function __spawnSyncSemGuardaSomenteProva(...args) {
  if (!MODO_PROVA) throw new Error("disponível apenas no modo de prova");
  return spawnSyncBruto(...args);
}
globalThis.__TESTE_SEGURO__ = Object.freeze({ versao: 1, pid: process.pid, modoProva: MODO_PROVA });
