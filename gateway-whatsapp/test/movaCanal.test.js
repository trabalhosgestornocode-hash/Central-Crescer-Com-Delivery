// MOVA — canal isolado (Execução 05): configuração fail-closed, segredo próprio, nova tentativa limitada, limite de taxa.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAMINHO_EVENTO_MOVA, criarCanalMova, lerCanalMova } from "../src/movaCanal.js";

const S = "s".repeat(40);
test("configuração: sem canal, incompleto, segredo curto/igual ao principal, sem https ⇒ MOVA desligado", () => {
  assert.equal(lerCanalMova({}).motivo, "SEM_CANAL");
  assert.equal(lerCanalMova({ url: "https://h" }).motivo, "CANAL_INCOMPLETO");
  assert.equal(lerCanalMova({ url: "https://h", segredo: "curto" }).motivo, "SEGREDO_CURTO");
  assert.equal(lerCanalMova({ url: "https://h", segredo: S, segredoPrincipal: S }).motivo, "SEGREDO_IGUAL_AO_PRINCIPAL");
  assert.equal(lerCanalMova({ url: "http://exemplo.com", segredo: S }).motivo, "URL_SEM_HTTPS");
  assert.equal(lerCanalMova({ url: "nada", segredo: S }).motivo, "URL_INVALIDA");
  assert.deepEqual(lerCanalMova({ url: "https://homolog.exemplo/", segredo: S, segredoPrincipal: "p".repeat(40) }), { ativo: true, url: "https://homolog.exemplo", segredo: S });
});

test("entrega: assina com o segredo do MOVA, nonce novo por tentativa; 5xx/rede re-tenta com limite; 4xx não", async () => {
  const chamadas = []; let respostas = [0, 503, 202];
  const fetchFn = async (url, o) => { chamadas.push({ url, h: o.headers }); const st = respostas.shift(); if (st === 0) throw new Error("rede"); return { status: st }; };
  const canal = criarCanalMova({ url: "https://h", segredo: S, fetchFn, esperar: async () => {} });
  assert.deepEqual(await canal.notificar({ a: 1 }), { entregue: true, status: 202 });
  assert.equal(chamadas.length, 3);
  assert.equal(chamadas[0].url, `https://h${CAMINHO_EVENTO_MOVA}`);
  assert.equal(new Set(chamadas.map((c) => JSON.stringify(c.h))).size, 3, "assinatura nova a cada tentativa");
  respostas = [500, 500, 500];
  assert.equal((await canal.notificar({})).motivo, "INDISPONIVEL");
  respostas = [401];
  assert.equal((await canal.notificar({})).motivo, "RECUSADO");
});

test("limite de taxa: excesso descartado sem chamar o backend; nunca lança", async () => {
  let n = 0; let agora = 0;
  const canal = criarCanalMova({ url: "https://h", segredo: S, maxPorMinuto: 2, relogio: () => agora, fetchFn: async () => { n += 1; return { status: 202 }; } });
  await canal.notificar({}); await canal.notificar({});
  assert.equal((await canal.notificar({})).motivo, "LIMITE_DE_TAXA");
  assert.equal(n, 2);
  agora = 61_000;
  assert.equal((await canal.notificar({})).entregue, true);
});
