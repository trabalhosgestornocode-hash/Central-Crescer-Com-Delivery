// Garante, por inspeção estática, que nada no processo web (server/app/rotas/services de
// autorização) inicia polling, timers ou o worker do iFood: conectar uma unidade NÃO
// dispara nenhuma chamada automática ao iFood.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ler = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const semComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("processo web e módulos do fluxo distribuído não importam poller/worker nem criam timers", () => {
  const arquivos = [
    "server.js", "app.js", "routes.js",
    "modules/ifood/ifood.routes.js", "modules/ifood/ifood.controller.js",
    "modules/ifood/ifoodAuth.service.js", "modules/ifood/ifoodMerchant.service.js",
    "modules/ifood/ifoodConnection.service.js", "modules/ifood/ifoodToken.service.js",
  ];
  for (const a of arquivos) {
    let src;
    try { src = semComentarios(ler(a)); } catch { continue; }   // arquivo pode não existir com esse nome
    assert.doesNotMatch(src, /worker-ifood|ifoodEvents\.poller|criarPoller/, `${a} referencia poller/worker`);
    assert.doesNotMatch(src, /\bsetInterval\s*\(/, `${a} cria setInterval`);
    assert.doesNotMatch(src, /\bsetTimeout\s*\(\s*[^)]*refresh/i, `${a} agenda refresh automático`);
  }
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
