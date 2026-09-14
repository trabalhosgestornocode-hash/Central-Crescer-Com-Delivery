// Prova estrutural de que a rota de credencial Realtime está montada ATRÁS
// de `requireContexto`, exatamente como qualquer outra rota de tenant — é
// isso (não um teste de integração duplicando sessoes_contexto) que garante
// que um contexto revogado/expirado nunca alcança o controller: ele já teria
// sido recusado por `requireContexto`, com o mesmo 409 de qualquer outra rota
// do sistema. A cobertura de revogação/expiração em si já existe para
// `requireContexto` — este teste só garante que a rota nova não bypassa essa
// porta.
//
// Rodar: node --test test/realtime-routes-wiring.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = readFileSync(path.join(AQUI, "../src/routes.js"), "utf8");

describe("routes.js — /realtime fica atrás do gate de contexto", () => {
  test("realtimeRouter é importado e montado em /realtime", () => {
    assert.match(ROUTES, /import\s*\{\s*realtimeRouter\s*\}\s*from\s*["'].*realtime\.routes\.js["']/);
    assert.match(ROUTES, /tenant\.use\(\s*["']\/realtime["']\s*,\s*realtimeRouter\s*\)/);
  });

  test("tenant.use(requireContexto) vem ANTES da montagem de /realtime no arquivo", () => {
    const iGate = ROUTES.indexOf("tenant.use(requireContexto)");
    const iRealtime = ROUTES.indexOf('tenant.use("/realtime"');
    assert.ok(iGate > -1, "o gate de contexto precisa existir no router de tenant");
    assert.ok(iRealtime > -1, "a rota de realtime precisa estar montada");
    assert.ok(iGate < iRealtime, "/realtime tem que vir DEPOIS de requireContexto — nunca antes");
  });

  test("/realtime não leva requireModulo (é infraestrutura, disponível a qualquer contexto válido — como /usuarios e /unidade)", () => {
    const linha = ROUTES.split("\n").find((l) => l.includes('tenant.use("/realtime"'));
    assert.ok(linha, "linha de montagem não encontrada");
    assert.doesNotMatch(linha, /requireModulo/);
  });
});
