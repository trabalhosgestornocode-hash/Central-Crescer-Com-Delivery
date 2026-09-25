import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { criarExecutorOperacao } from "../src/operacaoConexao.js";
import { erro, CODIGOS } from "../src/errors.js";

function montar(efeito = async () => {}) {
  const atual = { operacaoId: randomUUID(), token: randomUUID(), acao: "DESCONECTAR", estado: "PENDENTE" };
  let chamadas = 0;
  const backendClient = { operacaoEfeito: async (p) => {
    if (p.operacaoId !== atual.operacaoId || p.token !== atual.token || p.acao !== atual.acao) return { ok: false };
    if (p.fase === "CONSUMIR" && atual.estado === "PENDENTE") { atual.estado = "EXECUTANDO"; return { ok: true }; }
    if (p.fase === "CONCLUIR" && atual.estado === "EXECUTANDO") { atual.estado = "CONCLUIDO"; return { ok: true }; }
    if (p.fase === "INCERTO" && atual.estado === "EXECUTANDO") { atual.estado = "INCERTO"; return { ok: true }; }
    if (p.fase === "FALHA_DETERMINISTICA" && atual.estado === "EXECUTANDO") { atual.estado = "LIVRE"; return { ok: true }; }
    return { ok: false };
  } };
  const executor = criarExecutorOperacao({ desconectarConta: async () => { chamadas++; await efeito(); } }, backendClient);
  return { atual, executor, chamadas: () => chamadas };
}

test("token obsoleto nunca chega ao logout/reset", async () => {
  const m = montar();
  await assert.rejects(() => m.executor({ ...m.atual, operacaoId: randomUUID() }), { status: 409 });
  assert.equal(m.chamadas(), 0);
});
test("requisições simultâneas do mesmo token executam exatamente um efeito", async () => {
  let liberar, entrou;
  const barreira = new Promise((r) => { liberar = r; });
  const inicio = new Promise((r) => { entrou = r; });
  const m = montar(async () => { entrou(); await barreira; });
  const primeira = m.executor(m.atual);
  await inicio;
  await assert.rejects(() => m.executor(m.atual), { status: 409 });
  assert.equal(m.atual.estado, "EXECUTANDO");
  liberar(); await primeira;
  assert.equal(m.chamadas(), 1);
  assert.equal(m.atual.estado, "CONCLUIDO");
});
test("erro depois de efeito externo mantém estado INCERTO reconciliável", async () => {
  const m = montar(async () => { throw new Error("logout executado, confirmação perdida"); });
  await assert.rejects(() => m.executor(m.atual), (e) => e.reconciliacaoNecessaria === true);
  assert.equal(m.atual.estado, "INCERTO");
  await assert.rejects(() => m.executor(m.atual), { status: 409 });
  assert.equal(m.chamadas(), 1);
});
test("falha de autorização do backend antes do efeito é fail-closed", async () => {
  let tocou = false;
  const executar = criarExecutorOperacao({ conectar: async () => { tocou = true; } }, { operacaoEfeito: async () => { throw new Error("rede"); } });
  await assert.rejects(() => executar({ operacaoId: randomUUID(), token: randomUUID(), acao: "CONECTAR" }));
  assert.equal(tocou, false);
});

test("falha determinística ANTES do efeito (guarda do gateway) libera sem reconciliação", async () => {
  for (const codigo of [CODIGOS.SEM_LEASE, CODIGOS.JA_CONECTADO, CODIGOS.NAO_CONECTADO]) {
    const m = montar(async () => { throw erro(codigo); });
    await assert.rejects(() => m.executor(m.atual), (e) => e.codigo === codigo && e.reconciliacaoNecessaria !== true);
    assert.equal(m.atual.estado, "LIVRE", codigo);
  }
});
test("timeout/queda depois de chamar o provider é incerteza real: INCERTO, nunca livre", async () => {
  const m = montar(async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); });
  await assert.rejects(() => m.executor(m.atual), (e) => e.reconciliacaoNecessaria === true);
  assert.equal(m.atual.estado, "INCERTO");
});
test("se a falha determinística não puder ser registrada, degrada para INCERTO (fail-safe)", async () => {
  const atual = { operacaoId: randomUUID(), token: randomUUID(), acao: "DESCONECTAR" };
  const fases = [];
  const backendClient = { operacaoEfeito: async (p) => { fases.push(p.fase); return { ok: p.fase === "CONSUMIR" || p.fase === "INCERTO" }; } };
  const executor = criarExecutorOperacao({ desconectarConta: async () => { throw erro(CODIGOS.JA_CONECTADO); } }, backendClient);
  await assert.rejects(() => executor(atual), (e) => e.reconciliacaoNecessaria === true);
  assert.deepEqual(fases, ["CONSUMIR", "FALHA_DETERMINISTICA", "INCERTO"]);
});
