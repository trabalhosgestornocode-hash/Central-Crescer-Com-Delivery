// RealtimeManager — resincronização do token quando a sessão Supabase Auth
// normal renova (gotcha documentado do supabase-js: o Realtime NÃO se
// resincroniza sozinho — ver o comentário no topo de realtimeManager.js e a
// entrega da validação pré-Etapa-2, item 11 "setAuth()").
//
// Em arquivo PRÓPRIO porque `iniciar()` só pode ser chamado uma vez por
// processo (contextoEscopo.js não tem "desregistrar") e o listener de
// `sb.auth.onAuthStateChange` é registrado UMA vez, contra o cliente que
// existir no momento da chamada — aqui o fake já está pronto ANTES de
// iniciar(), diferente de realtimeManager.test.js (que testa outra coisa).
//
// Rodar: node --test frontend/test/realtimeManagerAuthSync.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

globalThis.document = new EventTarget();
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

const { state } = await import("../src/state.js");
const M = await import("../src/realtime/realtimeManager.js");

let callbackCapturado = null;
const cliente = {
  ultimoAuth: null,
  auth: {
    onAuthStateChange(cb) {
      callbackCapturado = cb;
      return { data: { subscription: { unsubscribe() {} } } };
    },
  },
  realtime: { setAuth(token) { cliente.ultimoAuth = token; } },
  channel() {
    return { on() { return this; }, subscribe(cb) { cb?.("SUBSCRIBED"); return this; } };
  },
  removeChannel() {},
};

M._injetarDependenciasParaTeste({
  obterCliente: async () => cliente,
  solicitarCredencial: async () => ({ validadeS: 300, topicos: ["empresa:org-1"] }),
  obterTokenAuth: async () => "auth-tok-inicial",
  setTimeout: () => 1,
  clearTimeout: () => {},
});
M.iniciar();
await new Promise((r) => setImmediate(r)); // deixa o registro assíncrono de onAuthStateChange assentar

describe("RealtimeManager — reaplica o token quando a sessão Auth normal renova", () => {
  test("com conexão ativa: um refresh da sessão Auth reaplica o novo access_token no Realtime", async () => {
    state.sessao.empresa = { id: "org-1" };
    await M.conectarParaContextoAtual();
    assert.ok(callbackCapturado, "iniciar() tem que ter registrado sb.auth.onAuthStateChange");

    callbackCapturado("TOKEN_REFRESHED", { access_token: "auth-tok-renovado" });
    assert.equal(cliente.ultimoAuth, "auth-tok-renovado");
  });

  test("sem conexão ativa (desconectado): não tenta reaplicar nada (nada para reautorizar)", async () => {
    await M.desligarTudo();
    cliente.ultimoAuth = "sentinela";
    callbackCapturado("TOKEN_REFRESHED", { access_token: "auth-tok-outro" });
    assert.equal(cliente.ultimoAuth, "sentinela", "sem canal ativo, não deveria chamar setAuth de novo");
  });

  test("evento sem sessão (ex.: SIGNED_OUT) não lança nem chama setAuth com valor inválido", () => {
    assert.doesNotThrow(() => callbackCapturado("SIGNED_OUT", null));
  });
});
