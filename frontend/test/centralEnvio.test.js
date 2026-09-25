// Central de Comunicação — fluxo de ENVIO manual no frontend (sem DOM): duplo clique não duplica, recusa (4xx) devolve o texto, falha ambígua vira "Tentar de novo" com o
// MESMO envioId, nunca há retry automático.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { executarEnvio, criarTrava, foiRecusa, MSG_AMBIGUA } from "../src/central/centralEnvio.js";
import { mesclarMensagens } from "../src/central/centralModelo.js";

const AGORA = new Date(2026, 8, 24, 15, 0, 0);
const erroHttp = (status, message) => Object.assign(new Error(message), { status });
const apiCom = (fn) => { const chamadas = []; return { chamadas, conversaEnviar: async (id, corpo) => { chamadas.push({ id, corpo }); return fn(id, corpo, chamadas.length); } }; };

describe("executarEnvio", () => {
  test("sucesso: 1 chamada com contato, texto APARADO e envioId; devolve a bolha do servidor com o mesmo envioId", async () => {
    const api = apiCom((id, c) => ({ mensagemId: "m1", status: "SENT", jaExistia: false, mensagem: { id: "srv1", texto: c.texto, status: "SENT", em: AGORA.toISOString() } }));
    const r = await executarEnvio({ api, contatoId: "c1", texto: "  Bom dia  ", envioId: "E1", operador: "Camila", agora: AGORA });
    assert.equal(r.tipo, "ok"); assert.equal(api.chamadas.length, 1);
    assert.deepEqual([api.chamadas[0].id, api.chamadas[0].corpo.envioId, api.chamadas[0].corpo.texto], ["c1", "E1", "Bom dia"]);
    assert.deepEqual([r.mensagem.id, r.mensagem.envioId, r.otimista.status, r.otimista.local], ["srv1", "E1", "SENDING", true]);
  });

  test("JA_EXISTIA (duplo clique que chegou ao servidor): ok sem bolha nova — a tela recarrega e o envioId dedupa", async () => {
    const api = apiCom(() => ({ mensagemId: "m1", status: "SENT", resultado: "JA_EXISTIA", jaExistia: true }));
    const r = await executarEnvio({ api, contatoId: "c1", texto: "oi", envioId: "E1", agora: AGORA });
    assert.deepEqual([r.tipo, r.jaExistia, r.mensagem], ["ok", true, null]);
  });

  test("RECUSA do servidor (4xx: gate, validação, limite de taxa) ⇒ 'recusado' com a mensagem do servidor; o texto pode voltar ao composer", async () => {
    for (const status of [400, 401, 403, 404, 409, 429]) {
      const r = await executarEnvio({ api: apiCom(() => { throw erroHttp(status, "O WhatsApp não está conectado."); }), contatoId: "c1", texto: "oi", envioId: "E", agora: AGORA });
      assert.deepEqual([r.tipo, r.erro], ["recusado", "O WhatsApp não está conectado."], String(status));
    }
  });

  test("falha AMBÍGUA (rede, timeout, 5xx, 408) ⇒ 'ambiguo' com bolha FALHOU + falhaLocal e o mesmo envioId (o servidor pode ter recebido)", async () => {
    for (const err of [new TypeError("Failed to fetch"), erroHttp(500, "x"), erroHttp(502, "x"), erroHttp(503, "x"), erroHttp(408, "x"), Object.assign(new Error("t"), { name: "AbortError" })]) {
      const r = await executarEnvio({ api: apiCom(() => { throw err; }), contatoId: "c1", texto: "oi", envioId: "E7", agora: AGORA });
      assert.equal(r.tipo, "ambiguo");
      assert.deepEqual([r.falha.status, r.falha.falhaLocal, r.falha.envioId, r.erro], ["FAILED", true, "E7", MSG_AMBIGUA]);
    }
  });

  test("a reenvio usa o MESMO envioId: a bolha local de falha é substituída pela definitiva, sem duplicar", async () => {
    const primeira = await executarEnvio({ api: apiCom(() => { throw new TypeError("Failed to fetch"); }), contatoId: "c1", texto: "oi", envioId: "E9", agora: AGORA });
    const api2 = apiCom((id, c) => ({ mensagemId: "m", status: "SENT", mensagem: { id: "srv-9", texto: c.texto, status: "SENT", em: AGORA.toISOString() } }));
    const segunda = await executarEnvio({ api: api2, contatoId: "c1", texto: "oi", envioId: "E9", agora: AGORA });
    assert.equal(api2.chamadas[0].corpo.envioId, "E9");
    const tela = mesclarMensagens([primeira.falha], [segunda.mensagem]);
    assert.deepEqual(tela.map((m) => m.id), ["srv-9"], "uma única mensagem na conversa");
  });

  test("entrada inválida (texto vazio, sem envioId/contato) ⇒ 'invalido' e NENHUMA chamada", async () => {
    const api = apiCom(() => ({}));
    for (const p of [{ texto: "" }, { texto: "   " }, { texto: "x", envioId: "" }, { texto: "x", contatoId: "" }, { texto: null }, { texto: "y".repeat(5000) }]) {
      const r = await executarEnvio({ api, contatoId: "c1", envioId: "E", agora: AGORA, ...p });
      assert.equal(r.tipo, "invalido", JSON.stringify(p).slice(0, 40));
    }
    assert.equal(api.chamadas.length, 0);
  });

  test("NUNCA há retry automático: uma falha ⇒ exatamente uma chamada", async () => {
    const api = apiCom(() => { throw erroHttp(503, "x"); });
    await executarEnvio({ api, contatoId: "c1", texto: "oi", envioId: "E", agora: AGORA });
    assert.equal(api.chamadas.length, 1);
  });

  test("foiRecusa: só 4xx (exceto 408) é recusa comprovada", () => {
    assert.deepEqual([400, 404, 409, 429, 408, 500, 0].map((s) => foiRecusa({ status: s })), [true, true, true, true, false, false, false]);
    assert.equal(foiRecusa(new Error("x")), false); assert.equal(foiRecusa(null), false);
  });
});

describe("trava anti-duplo-clique", () => {
  test("enquanto há um envio em andamento, o segundo clique é recusado; liberar reabre", () => {
    const t = criarTrava();
    assert.equal(t.tentar(), true); assert.equal(t.ativa(), true);
    assert.equal(t.tentar(), false); assert.equal(t.tentar(), false);
    t.liberar(); assert.equal(t.ativa(), false); assert.equal(t.tentar(), true);
  });
  test("três cliques quase simultâneos ⇒ exatamente UM envio dispara", async () => {
    const t = criarTrava(); const api = apiCom(async () => { await new Promise((r) => setTimeout(r, 10)); return { mensagemId: "m", mensagem: null }; });
    const clique = async () => { if (!t.tentar()) return "ignorado"; try { return (await executarEnvio({ api, contatoId: "c", texto: "oi", envioId: "E", agora: AGORA })).tipo; } finally { t.liberar(); } };
    const r = await Promise.all([clique(), clique(), clique()]);
    assert.deepEqual(r.sort(), ["ignorado", "ignorado", "ok"]); assert.equal(api.chamadas.length, 1);
  });
});
