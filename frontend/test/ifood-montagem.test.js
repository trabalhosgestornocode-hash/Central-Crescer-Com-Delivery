// iFood (frontend) — a tela real está LIGADA ao menu, ao router e à API?
//
// Mesma motivação de backend/test/ifood-rotas-montagem.test.js: na Fase 1
// o `ifood.js` existia, mas config.js seguia com `tipo: "integracao"` (tela
// genérica), router.js não tinha o case e api.js não tinha os wrappers.
// Testes puros sem DOM: leitura estrutural dos arquivos.
//
// Rodar: node --test test/ifood-montagem.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const ler = (f) => readFileSync(path.join(SRC, f), "utf8");

describe("frontend — iFood ligado de ponta a ponta", () => {
  test("config.js: item 'iFood' do menu abre a tela real (tipo 'ifood'), no módulo 'ifood', seção INTEGRAÇÕES", () => {
    const linha = ler("config.js").split("\n").find((l) => /\{\s*id:\s*"ifood"/.test(l));
    assert.ok(linha, "item de menu iFood não encontrado");
    assert.match(linha, /tipo:\s*"ifood"/);
    assert.doesNotMatch(linha, /tipo:\s*"integracao"/, "não pode cair na tela genérica órfã");
    assert.match(linha, /modulo:\s*"ifood"/);
    assert.match(linha, /secao:\s*"INTEGRAÇÕES"/);
  });

  test("router.js: importa renderIfood e roteia o tipo 'ifood' para ele", () => {
    const r = ler("router.js");
    assert.match(r, /import\s*\{\s*renderIfood\s*\}\s*from\s*["']\.\/ifood\.js["']/);
    assert.match(r, /case\s*"ifood":\s*\n\s*renderIfood\(\);/);
  });

  test("api.js: todos os wrappers usados por ifood.js existem", () => {
    const api = ler("api.js");
    const usados = [...new Set([...ler("ifood.js").matchAll(/\bapi\.(ifood[A-Za-z]+)\b/g)].map((m) => m[1]))];
    assert.ok(usados.length >= 8, `esperava ao menos 8 wrappers em uso, achei ${usados.length}`);
    for (const nome of usados) {
      assert.match(api, new RegExp(`export const ${nome}\\b`), `api.js não exporta ${nome}`);
    }
  });

  test("api.js: wrappers da Fase 1 e Financial apontam para /api/v1/integracoes/ifood", () => {
    const api = ler("api.js");
    assert.match(api, /const IFOOD = "\/api\/v1\/integracoes\/ifood"/);
    for (const nome of [
      "ifoodStatus", "ifoodOauthStart", "ifoodOauthComplete", "ifoodMerchants", "ifoodVincularMerchant", "ifoodDesconectar",
      "ifoodFinancialSales", "ifoodFinancialEvents", "ifoodFinancialSettlements", "ifoodFinancialReconciliation",
      "ifoodFinancialReconciliationOnDemandSolicitar", "ifoodFinancialReconciliationOnDemandStatus",
      "ifoodFinancialAnticipations", "ifoodFinancialConciliation",
    ]) assert.match(api, new RegExp(`export const ${nome}\\b`), `falta ${nome}`);
  });

  test("api.js: nenhum wrapper envia merchantId em rota Financial (o backend resolve pela conexão da unidade)", () => {
    const trecho = ler("api.js").split("\n").filter((l) => l.includes("${IFOOD}/financial/")).join("\n");
    assert.ok(trecho.length > 0);
    assert.doesNotMatch(trecho, /merchantId/i);
  });

  test("api.js: nenhuma função de Order/Events/operação de pedido — só a LEITURA da lista de pedidos (GET)", () => {
    const api = ler("api.js");
    const nomes = [...api.matchAll(/export const (ifood[A-Za-z]+)/g)].map((m) => m[1]);
    const suspeitos = nomes.filter((n) => /Order|Pedido|Polling|Ack|Confirm|Dispatch|Ready|Cancel|Handshake/i.test(n));
    assert.deepEqual(suspeitos, ["ifoodPedidos"]);
    assert.match(api, /export const ifoodPedidos = \(\) => getJson\(/, "ifoodPedidos é só GET, sem parâmetros");
  });

  test("ifood.js: nunca lê ou grava token/secret/verifier em localStorage", () => {
    // Só código: comentários de linha citam "localStorage" justamente para dizer que não é usado.
    const src = ler("ifood.js").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    assert.doesNotMatch(src, /localStorage|sessionStorage/);
    assert.doesNotMatch(src, /clientSecret|accessToken|refreshToken|authorizationCodeVerifier/);
  });
});
