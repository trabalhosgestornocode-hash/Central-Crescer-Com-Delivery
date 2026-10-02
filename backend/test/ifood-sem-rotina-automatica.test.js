// Garante, por inspeção estática, que nada no processo web (server/app/rotas/services de
// autorização) inicia polling, timers ou o worker do iFood: conectar uma unidade NÃO
// dispara nenhuma chamada automática ao iFood.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ler = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const semComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// O Events pode rodar EMBARCADO no Web Service, mas só pelo host fail-closed `worker-ifood/embedded.js`
// (IFOOD_EVENTS_EMBEDDED_ENABLED=true; padrão desligado). Regra (fail-closed):
//   * SÓ o server.js pode referenciar worker-ifood, e SÓ por UM import estático exatamente com os dois nomes
//     aprovados do host embarcado. Qualquer outra referência (outro arquivo do worker, import dinâmico, nome
//     extra, import repetido, poller direto) é violação;
//   * nenhum outro arquivo do processo web referencia poller/worker;
//   * nenhum deles cria setInterval nem agenda refresh.
const IMPORT_HOST_EMBARCADO = /import\s*\{\s*iniciarEventsIfoodEmbutido\s*,\s*pararEventsIfoodEmbutido\s*\}\s*from\s*"\.\/worker-ifood\/embedded\.js";/;
const REFERENCIA_PROIBIDA = /worker-ifood|ifoodEvents\.poller|criarPoller|criarLoopDoPoller/;

/** Violações da regra num arquivo do processo web (fonte já sem comentários). Vazio = conforme. */
function violacoesDoProcessoWeb(nome, src) {
  const v = [];
  let resto = src;
  if (nome === "server.js") resto = resto.replace(IMPORT_HOST_EMBARCADO, "");   // remove UMA ocorrência aprovada
  if (REFERENCIA_PROIBIDA.test(resto)) v.push(`${nome} referencia poller/worker fora do host embarcado aprovado`);
  if (/\bsetInterval\s*\(/.test(resto)) v.push(`${nome} cria setInterval`);
  if (/\bsetTimeout\s*\(\s*[^)]*refresh/i.test(resto)) v.push(`${nome} agenda refresh automático`);
  return v;
}

test("processo web e módulos do fluxo distribuído não importam poller/worker nem criam timers", () => {
  const arquivos = [
    "server.js", "app.js", "routes.js", "servidor.lifecycle.js",
    "modules/ifood/ifood.routes.js", "modules/ifood/ifood.controller.js",
    "modules/ifood/ifoodAuth.service.js", "modules/ifood/ifoodMerchant.service.js",
    "modules/ifood/ifoodConnection.service.js", "modules/ifood/ifoodToken.service.js",
    "modules/ifood/ifoodEventsEstado.js",
  ];
  for (const a of arquivos) {
    let src;
    try { src = semComentarios(ler(a)); } catch { continue; }   // arquivo pode não existir com esse nome
    if (a === "server.js") assert.match(src, IMPORT_HOST_EMBARCADO, "server.js usa o host embarcado aprovado");
    assert.deepEqual(violacoesDoProcessoWeb(a, src), [], a);
  }
});

test("o guarda RECUSA tentativas proibidas (cada uma isolada)", () => {
  const aprovado = 'import { iniciarEventsIfoodEmbutido, pararEventsIfoodEmbutido } from "./worker-ifood/embedded.js";';
  const proibidas = [
    ["server.js", 'import "./worker-ifood/index.js";', "entrypoint dedicado"],
    ["server.js", 'import { executarWorker } from "./worker-ifood/lifecycle.js";', "lifecycle dedicado (exit 1)"],
    ["server.js", `${aprovado}\nconst r = await import("./worker-ifood/runtime.js");`, "runtime por import dinâmico"],
    ["server.js", `${aprovado}\nimport { criarSupervisorEvents } from "./worker-ifood/supervisor.js";`, "supervisor direto"],
    ["server.js", 'import { criarPoller } from "./modules/ifood/ifoodEvents.poller.js";', "poller direto"],
    ["server.js", 'import { iniciarEventsIfoodEmbutido, pararEventsIfoodEmbutido, outro } from "./worker-ifood/embedded.js";', "nome extra no host"],
    ["server.js", `${aprovado}\n${aprovado}`, "host importado duas vezes"],
    ["server.js", 'const host = await import("./worker-ifood/embedded.js");', "host por import dinâmico"],
    ["server.js", `${aprovado}\nsetInterval(() => {}, 30000);`, "setInterval no processo web"],
    ["app.js", aprovado, "host embarcado fora do server.js"],
    ["modules/ifood/ifood.controller.js", 'import { criarLoopDoPoller } from "./ifoodEvents.poller.js";', "loop do poller numa rota"],
  ];
  for (const [nome, src, caso] of proibidas) {
    assert.notDeepEqual(violacoesDoProcessoWeb(nome, src), [], `deveria recusar: ${caso}`);
  }
  // Controle: o único uso aprovado passa.
  assert.deepEqual(violacoesDoProcessoWeb("server.js", aprovado), []);
});

test("host embarcado é fail-closed: desligado por padrão e sem import estático do poller/runtime/supervisor", async () => {
  const src = semComentarios(ler("worker-ifood/embedded.js"));
  assert.doesNotMatch(src, /^\s*import\s[^;]*(runtime|supervisor|ifoodEvents\.poller|ifoodToken\.service|repository)/m,
    "poller/runtime/token/repositório só podem entrar por import DINÂMICO, depois da flag");
  const iFlag = src.indexOf("if (!eventsEmbutidoHabilitado(env))");
  const iRuntime = src.indexOf('import("./runtime.js")');
  assert.ok(iFlag > -1 && iRuntime > iFlag, "o gate da flag vem antes de carregar o runtime");
  assert.doesNotMatch(src, /process\.exit|process\.on\(/, "o host embarcado nunca encerra o processo nem registra sinal");
  for (const f of ["worker-ifood/supervisor.js", "worker-ifood/runtime.js", "modules/ifood/ifoodEventsEstado.js"]) {
    assert.doesNotMatch(semComentarios(ler(f)), /process\.exit|process\.on\(|process\.once\(/, `${f} nunca encerra o processo nem registra sinal`);
  }
  const { eventsEmbutidoHabilitado } = await import("../src/worker-ifood/embedded.js");
  assert.equal(eventsEmbutidoHabilitado({}), false);
  assert.equal(eventsEmbutidoHabilitado({ IFOOD_EVENTS_EMBEDDED_ENABLED: "1" }), false);
  assert.equal(eventsEmbutidoHabilitado({ IFOOD_EVENTS_EMBEDDED_ENABLED: "TRUE" }), false);
  assert.equal(eventsEmbutidoHabilitado({ IFOOD_EVENTS_WORKER_ENABLED: "true" }), false, "a flag do worker dedicado não liga o embarcado");
  assert.equal(eventsEmbutidoHabilitado({ IFOOD_EVENTS_EMBEDDED_ENABLED: "true" }), true);
});

test("worker do iFood é fail-closed: desligado por padrão", async () => {
  const { carregarConfigWorkerIfood } = await import("../src/worker-ifood/config.js");
  assert.equal(carregarConfigWorkerIfood({}).habilitado, false);
  assert.equal(carregarConfigWorkerIfood({ IFOOD_EVENTS_WORKER_ENABLED: "1" }).habilitado, false);
});

test("o fluxo distribuído só usa rotas de autenticação e Merchant read-only (nenhuma escrita no iFood)", () => {
  const src = semComentarios(ler("modules/ifood/ifoodMerchant.service.js")) + semComentarios(ler("modules/ifood/ifoodAuth.service.js"));
  assert.doesNotMatch(src, /postJson|putJson|patchJson|deleteJson/);
  assert.doesNotMatch(src, /IFOOD_ROTAS\.(order|events|financial|merchantStatus)/);
});
