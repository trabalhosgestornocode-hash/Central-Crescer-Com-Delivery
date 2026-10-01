// Garante, por inspeção estática, que nada no processo web (server/app/rotas/services de
// autorização) inicia polling, timers ou o worker do iFood: conectar uma unidade NÃO
// dispara nenhuma chamada automática ao iFood.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ler = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const semComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// O Events pode rodar EMBARCADO no Web Service, mas só pelo host fail-closed `worker-ifood/embedded.js`
// (IFOOD_EVENTS_EMBEDDED_ENABLED=true; padrão desligado). O server.js pode referenciar SÓ esse host; nenhum
// outro arquivo do processo web referencia poller/worker.
const IMPORT_HOST_EMBARCADO = /import\s*\{[^}]*\}\s*from\s*"\.\/worker-ifood\/embedded\.js";/;

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
    if (a === "server.js") {
      assert.match(src, IMPORT_HOST_EMBARCADO, "server.js usa o host embarcado (e só ele)");
      src = src.replace(IMPORT_HOST_EMBARCADO, "");
    }
    assert.doesNotMatch(src, /worker-ifood|ifoodEvents\.poller|criarPoller/, `${a} referencia poller/worker`);
    assert.doesNotMatch(src, /\bsetInterval\s*\(/, `${a} cria setInterval`);
    assert.doesNotMatch(src, /\bsetTimeout\s*\(\s*[^)]*refresh/i, `${a} agenda refresh automático`);
  }
});

test("host embarcado é fail-closed: desligado por padrão e sem import estático do poller/runtime/supervisor", async () => {
  const src = semComentarios(ler("worker-ifood/embedded.js"));
  assert.doesNotMatch(src, /^\s*import\s[^;]*(runtime|supervisor|ifoodEvents\.poller|ifoodToken\.service|repository)/m,
    "poller/runtime/token/repositório só podem entrar por import DINÂMICO, depois da flag");
  const iFlag = src.indexOf("if (!eventsEmbutidoHabilitado(env))");
  const iRuntime = src.indexOf('import("./runtime.js")');
  assert.ok(iFlag > -1 && iRuntime > iFlag, "o gate da flag vem antes de carregar o runtime");
  assert.doesNotMatch(src, /process\.exit|process\.on\(/, "o host embarcado nunca encerra o processo nem registra sinal");
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
