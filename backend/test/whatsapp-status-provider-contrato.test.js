// H.4-B.4 — contrato das confirmações de entrega do provider + máquina monotônica + paridade Gateway ↔ backend ↔ SQL (095).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validarEventoStatusProvider, proximoStatusMensagem, CONTRATO_STATUS_VERSAO, STATUS_PROVIDER_EVENTO, RESULTADOS_STATUS_PROVIDER,
} from "../src/modules/comunicacao/comunicacao.statusProvider.js";
import { criarObservadorEntrega, STATUS_EVENTO as GW_STATUS, CONTRATO_STATUS_VERSAO as GW_VERSAO } from "../../gateway-whatsapp/src/entregaProvider.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const ok = (extra = {}) => ({ contratoStatus: 1, providerMessageId: "3EB0ABCDEF0123456789", status: "DELIVERED", ...extra });

describe("validarEventoStatusProvider", () => {
  test("aceita o contrato mínimo e o completo; normaliza opcionais para null", () => {
    assert.deepEqual(validarEventoStatusProvider(ok()), { ok: true, evento: { providerMessageId: "3EB0ABCDEF0123456789", status: "DELIVERED", ocorridoEm: null, ackTipo: null, erroCodigo: null } });
    const r = validarEventoStatusProvider(ok({ status: "PROVIDER_ERROR", erroCodigo: "479", ackTipo: "ack_erro", ocorridoEm: "2026-09-23T20:00:00.000Z" }), { agora: () => Date.parse("2026-09-23T20:00:01Z") });
    assert.equal(r.ok, true); assert.equal(r.evento.erroCodigo, "479");
  });
  test("erros são CÓDIGOS fechados que nunca ecoam o valor recebido", () => {
    const casos = [
      [null, "corpo_invalido"], [[], "corpo_invalido"], ["x", "corpo_invalido"],
      [{}, "contratoStatus_ausente"], [{ contratoStatus: 1 }, "providerMessageId_ausente"], [{ contratoStatus: 1, providerMessageId: "a" }, "status_ausente"],
      [ok({ contratoStatus: "1" }), "contratoStatus"], [ok({ providerMessageId: "" }), "providerMessageId"], [ok({ providerMessageId: "a".repeat(129) }), "providerMessageId"],
      [ok({ providerMessageId: "ab cd" }), "providerMessageId"], [ok({ providerMessageId: 5 }), "providerMessageId"],
      [ok({ status: "SENT" }), "status"], [ok({ status: "delivered" }), "status"], [ok({ status: 3 }), "status"],
      [ok({ ocorridoEm: "2026-09-23 20:00:00" }), "ocorridoEm"], [ok({ ocorridoEm: 123 }), "ocorridoEm"], [ok({ ocorridoEm: "2999-01-01T00:00:00.000Z" }), "ocorridoEm"],
      [ok({ ackTipo: "com espaço" }), "ackTipo"], [ok({ ackTipo: 7 }), "ackTipo"],
      [ok({ status: "PROVIDER_ERROR" }), "erroCodigo_ausente"], [ok({ status: "PROVIDER_ERROR", erroCodigo: "'; drop table" }), "erroCodigo"],
      [ok({ erroCodigo: "479" }), "erroCodigo_incoerente"],
      [ok({ organizacao_id: "x" }), "campo_desconhecido"], [ok({ mensagem_id: "x" }), "campo_desconhecido"], [ok({ estado: "READ" }), "campo_desconhecido"],
    ];
    for (const [corpo, esperado] of casos) {
      const r = validarEventoStatusProvider(corpo);
      assert.deepEqual(r, { ok: false, erro: esperado }, JSON.stringify(corpo));
    }
  });
});

describe("máquina monotônica (espelho da RPC 095)", () => {
  const tabela = [
    // atual, evento, elegivel, avanca, novo
    ["SENT", "DELIVERED", true, true, "DELIVERED"],
    ["SENT", "READ", true, true, "READ"],                    // READ implica entrega
    ["DELIVERED", "READ", true, true, "READ"],
    ["DELIVERED", "DELIVERED", true, false, "DELIVERED"],    // duplicado
    ["READ", "READ", true, false, "READ"],                   // duplicado
    ["READ", "DELIVERED", true, false, "READ"],              // atrasado: NÃO regride
  ];
  for (const [atual, ev, elegivel, avanca, novo] of tabela) {
    test(`${atual} + ${ev} => ${avanca ? "avança para " + novo : "sem mudança (" + novo + ")"}`, () => {
      assert.deepEqual(proximoStatusMensagem(atual, ev), { elegivel, avanca, novo });
    });
  }
  test("estados fora da cadeia NUNCA são tocados por receipt; SERVER_ACK/PROVIDER_ERROR/desconhecido não avançam nada", () => {
    for (const st of ["SCHEDULED", "PROCESSING", "SENDING", "DELIVERY_UNKNOWN", "FAILED", "CANCELLED", "BLOCKED", "QUALQUER"]) {
      for (const ev of ["DELIVERED", "READ"]) assert.deepEqual(proximoStatusMensagem(st, ev), { elegivel: false, avanca: false, novo: st }, `${st}+${ev}`);
    }
    for (const ev of ["SERVER_ACK", "PROVIDER_ERROR", "SENT", "x", undefined]) assert.equal(proximoStatusMensagem("SENT", ev).avanca, false);
  });
  test("nenhuma sequência de eventos jamais REGRIDE o status (todas as permutações de 3 eventos, com repetição)", () => {
    const rank = { SENT: 1, DELIVERED: 2, READ: 3 };
    const evs = ["DELIVERED", "READ"];
    const seqs = [];
    for (const a of evs) for (const b of evs) for (const c of evs) for (const d of evs) seqs.push([a, b, c, d]);
    for (const seq of seqs) {
      let st = "SENT";
      for (const e of seq) { const p = proximoStatusMensagem(st, e); assert.ok(rank[p.novo] >= rank[st], seq.join(",")); st = p.novo; }
      assert.equal(st, seq.includes("READ") ? "READ" : "DELIVERED", seq.join(","));
    }
  });
});

describe("paridade Gateway ↔ backend ↔ SQL", () => {
  test("vocabulário e versão do contrato são idênticos", () => {
    assert.deepEqual([...GW_STATUS], [...STATUS_PROVIDER_EVENTO]);
    assert.equal(GW_VERSAO, CONTRATO_STATUS_VERSAO);
  });
  test("TODO payload que o observador do Gateway produz é aceito pelo validador do backend (ws, ev, grupo, erro)", async () => {
    const payloads = [];
    const obs = criarObservadorEntrega({ notificar: async (p) => { payloads.push(p); return { resultado: "APLICADO" }; }, emitir() {} });
    for (const id of ["A", "B", "C", "D", "E", "F"]) obs.rastrear({ providerMessageId: `3EB0${id}` });
    obs.aoAckWs({ attrs: { id: "3EB0A", class: "message", t: "1700000000", from: "5511888880001@s.whatsapp.net" } });
    obs.aoAckWs({ attrs: { id: "3EB0B", class: "message", error: "479" } });
    obs.aoAckWs({ attrs: { id: "3EB0C", class: "message", error: "estranho!" } });
    obs.aoReceiptWs({ attrs: { id: "3EB0D", type: "read", t: "1700000000" } });
    obs.aoMessagesUpdate([{ key: { id: "3EB0E", fromMe: true }, update: { status: 3 } }]);
    obs.aoMessageReceiptUpdate([{ key: { id: "3EB0F", fromMe: true }, receipt: { readTimestamp: 1_700_000_000 } }]);
    await new Promise((r) => setImmediate(r));
    assert.equal(payloads.length, 6);
    for (const p of payloads) { const v = validarEventoStatusProvider(p); assert.equal(v.ok, true, JSON.stringify(p) + JSON.stringify(v)); }
  });
  test("a migration 095 aceita exatamente os 4 status e devolve exatamente os resultados que o backend conhece", () => {
    const sql = readFileSync(join(aqui, "..", "..", "database", "migrations", "095_comunicacao_status_provider.sql"), "utf8").replace(/\r\n/g, "\n");
    for (const s of STATUS_PROVIDER_EVENTO) assert.ok(sql.includes(`'${s}'`), s);
    const usados = new Set([...sql.matchAll(/'resultado', '([A-Z_]+)'/g)].map((m) => m[1]));
    assert.deepEqual([...usados].sort(), [...RESULTADOS_STATUS_PROVIDER].sort());
  });
});
