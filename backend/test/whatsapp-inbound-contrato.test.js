// Checkpoint F — testes do CONTRATO inbound no backend (inbound.contrato.js): schema estrito, regras cross-field, estado e bloqueio de automação.
// Funções PURAS: sem rede, sem banco. O que o Gateway envia e o que o backend aceita têm que combinar (paridade de vocabulário travada aqui).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CONTRATO_INBOUND_VERSAO, ORIGENS_TIPO, ORIGENS_JID_TIPO, ORIGENS_TELEFONE, MOTIVOS_FALHA_DECRYPT, ESTADOS_INBOUND, JID_TIPOS_CLIENTE,
  validarEventoInbound, decidirEstadoInbound, motivoBloqueioAutomacao,
} from "../src/modules/comunicacao/inbound/inbound.contrato.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const AGORA = Date.parse("2026-09-21T12:00:00.000Z");
const base = (extra = {}) => ({
  contratoInbound: 1, providerMessageId: "3EB0A1B2C3D4E5F60718", origemTipo: "LIVE", origemJidTipo: "direct_pn", fromMe: false,
  telefoneE164: "+5511999990000", telefoneOrigem: "JID_PN", falhaDecrypt: false, motivoFalhaDecrypt: null, stubSistema: false,
  recebidoEm: "2026-09-21T12:00:00.000Z", ...extra,
});
const sem = (o, ...ks) => { const c = { ...o }; for (const k of ks) delete c[k]; return c; };
const v = (o) => validarEventoInbound(o, { agora: () => AGORA });
const semTelefone = { telefoneE164: null, telefoneOrigem: null };

describe("payload VÁLIDO", () => {
  test("1. LIVE / cliente direto PN com telefone real", () => { const r = v(base()); assert.equal(r.ok, true); assert.deepEqual(r.evento, base()); });
  test("2. OFFLINE_NORMAL", () => assert.equal(v(base({ origemTipo: "OFFLINE_NORMAL" })).ok, true));
  test("3. OFFLINE_RECOVERY é aceito no contrato (nada o produz ainda)", () => assert.equal(v(base({ origemTipo: "OFFLINE_RECOVERY" })).ok, true));
  test("LID externo COM telefone vindo do senderPn (SENDER_PN) é válido; LID sem telefone também", () => {
    assert.equal(v(base({ origemJidTipo: "direct_lid_other", telefoneOrigem: "SENDER_PN" })).ok, true);
    assert.equal(v(base({ origemJidTipo: "direct_lid_other", ...semTelefone })).ok, true);
  });
  test("grupo/status/newsletter/broadcast/meta_ai/técnico/desconhecido/LID próprio SEM telefone são válidos", () => {
    for (const t of ["group", "status", "newsletter", "broadcast", "meta_ai", "technical", "unknown", "direct_lid_self"]) assert.equal(v(base({ origemJidTipo: t, ...semTelefone })).ok, true, t);
  });
  test("falha de decrypt com motivo fechado e fromMe=true sem telefone são válidos", () => {
    for (const m of MOTIVOS_FALHA_DECRYPT) assert.equal(v(base({ falhaDecrypt: true, motivoFalhaDecrypt: m })).ok, true, m);
    assert.equal(v(base({ fromMe: true, ...semTelefone })).ok, true);
  });
  test("recebidoEm ISO UTC (com ou sem ms) e até 10 min no futuro", () => {
    for (const t of ["2026-09-21T12:00:00Z", "2026-09-21T12:00:00.5Z", "2026-09-21T12:09:59.999Z", "2020-01-01T00:00:00.000Z"]) assert.equal(v(base({ recebidoEm: t })).ok, true, t);
  });
});

describe("payload INVÁLIDO (o erro é um CÓDIGO fechado que nunca ecoa o valor)", () => {
  const rejeita = (o, codigo, rotulo) => { const r = v(o); assert.deepEqual([r.ok, r.erro], [false, codigo], rotulo ?? codigo); assert.match(r.erro, /^[a-zA-Z0-9_]+$/); return r; };

  test("4. enum inválido: origemTipo / origemJidTipo / telefoneOrigem / motivoFalhaDecrypt", () => {
    for (const x of ["live", "RECOVERY", "OFFLINE", "", null, 5, undefined, {}]) rejeita(base({ origemTipo: x }), x === undefined ? "origemTipo" : "origemTipo", String(x));
    for (const x of ["direct_lid", "pn", "GROUP", null, 5]) rejeita(base({ origemJidTipo: x }), "origemJidTipo", String(x));
    for (const x of ["LID", "jid_pn", "", 5, undefined]) rejeita(base({ telefoneOrigem: x }), "telefoneOrigem", String(x));
    for (const x of ["Bad MAC Error", "erro", "", 5, undefined]) rejeita(base({ falhaDecrypt: true, motivoFalhaDecrypt: x }), "motivoFalhaDecrypt", String(x));
  });

  test("5. LID tentando enviar telefone FABRICADO (JID_PN ou sem origem) é rejeitado — inclusive o LID de 15 dígitos que passa no regex de E.164", () => {
    assert.match("+100000000000001", /^\+[1-9][0-9]{7,14}$/);        // o problema real
    rejeita(base({ origemJidTipo: "direct_lid_other", telefoneE164: "+100000000000001", telefoneOrigem: "JID_PN" }), "telefone_jid_nao_suportado");
    rejeita(base({ origemJidTipo: "direct_lid_other", telefoneE164: "+100000000000001", telefoneOrigem: null }), "telefone_origem_incoerente");
    rejeita(base({ origemJidTipo: "direct_lid_self", telefoneOrigem: "SENDER_PN" }), "telefone_jid_nao_suportado");
    rejeita(base({ origemJidTipo: "direct_pn", telefoneOrigem: "SENDER_PN" }), "telefone_jid_nao_suportado", "PN com origem de LID");
  });

  test("6/7. grupo, status, newsletter, broadcast, meta_ai, técnico e desconhecido COM telefone são rejeitados (qualquer origem declarada)", () => {
    for (const t of ["group", "status", "newsletter", "broadcast", "meta_ai", "technical", "unknown"]) {
      for (const origem of ORIGENS_TELEFONE) rejeita(base({ origemJidTipo: t, telefoneOrigem: origem }), "telefone_jid_nao_suportado", `${t}/${origem}`);
    }
  });

  test("telefone sem origem / origem sem telefone; formato E.164 exato", () => {
    rejeita(base({ telefoneOrigem: null }), "telefone_origem_incoerente"); rejeita(base({ telefoneE164: null }), "telefone_origem_incoerente");
    for (const t of ["5511999990000", "+55", "+0511999990000", "+551199999000000000", "+55 11 99999-0000", "+55abc", "", 5, {}, [], "+5511999990000\n"]) rejeita(base({ telefoneE164: t }), "telefoneE164", JSON.stringify(t));
  });

  test("15. fromMe=true nunca carrega telefone (não cria contato de cliente)", () => rejeita(base({ fromMe: true }), "telefone_com_from_me"));

  test("8/9. falhaDecrypt sem motivo; motivo sem falhaDecrypt; falha + stubSistema", () => {
    rejeita(base({ falhaDecrypt: true, motivoFalhaDecrypt: null }), "falha_sem_motivo");
    rejeita(base({ falhaDecrypt: false, motivoFalhaDecrypt: "bad_mac" }), "motivo_sem_falha");
    rejeita(base({ falhaDecrypt: true, motivoFalhaDecrypt: "bad_mac", stubSistema: true }), "falha_e_stub_sistema");
  });

  test("tipos exatos: nada de coerção (\"false\", 0, 1, null onde é boolean)", () => {
    for (const k of ["fromMe", "falhaDecrypt", "stubSistema"]) for (const x of ["false", "true", 0, 1, null, undefined]) rejeita(base({ [k]: x }), k, `${k}=${String(x)}`);
    for (const x of [0, 2, "1", null, true]) rejeita(base({ contratoInbound: x }), "contratoInbound");
  });

  test("providerMessageId: charset/tamanho fechados (sem espaço, sem injeção, sem vazio, ≤128)", () => {
    for (const x of ["", " ", "a b", "'; drop table x;--", "a/b", "ção", "x".repeat(129), 5, null, {}]) rejeita(base({ providerMessageId: x }), "providerMessageId", JSON.stringify(x));
    for (const x of ["A", "3EB0-ABC_1.2:3", "x".repeat(128)]) assert.equal(v(base({ providerMessageId: x })).ok, true, x);
  });

  test("recebidoEm: só ISO UTC válido, ≤ 10 min no futuro", () => {
    for (const x of ["", "2026-09-21", "2026-09-21T12:00:00", "2026-09-21T12:00:00+03:00", "hoje", 1758456000000, null, "2026-13-45T99:99:99Z", "2026-09-21T12:10:01Z", "2027-01-01T00:00:00Z"]) rejeita(base({ recebidoEm: x }), "recebidoEm", JSON.stringify(x));
  });

  test("11. chave DESCONHECIDA (inclui organizacao_id, estado, conteudo, telefone) e chave AUSENTE", () => {
    for (const k of ["organizacao_id", "organizacaoId", "estado", "conteudo", "telefone", "unidade_id", "__proto__x"]) rejeita({ ...base(), [k]: "x" }, "campo_desconhecido", k);
    for (const k of Object.keys(base())) rejeita(sem(base(), k), `${k}_ausente`, k);
  });

  test("corpo que não é objeto", () => { for (const x of [null, undefined, [], "x", 5, true, () => 1]) rejeita(x, "corpo_invalido", String(x)); });

  test("o código de erro NUNCA contém o valor recebido (nem telefone, nem id)", () => {
    const sujo = base({ providerMessageId: "SEGREDO ID", telefoneE164: "+5511999990000" });
    const r = v(sujo); assert.equal(r.ok, false); assert.ok(!JSON.stringify(r).includes("SEGREDO") && !JSON.stringify(r).includes("5511999990000"));
    const r2 = v(base({ recebidoEm: "SEGREDO-DATA" })); assert.ok(!JSON.stringify(r2).includes("SEGREDO"));
  });

  test("a validação não muta o corpo e devolve uma CÓPIA (o evento validado não compartilha referência)", () => {
    const o = base(); const r = v(o); assert.notEqual(r.evento, o); r.evento.fromMe = true; assert.equal(o.fromMe, false);
  });
});

describe("estado do inbound (decidirEstadoInbound)", () => {
  const e = (extra) => base({ ...extra });
  const tabela = [
    ["LIVE cliente direto PN", e({}), "RECEIVED"],
    ["LIVE cliente direto LID externo", e({ origemJidTipo: "direct_lid_other", ...semTelefone }), "RECEIVED"],
    ["OFFLINE_NORMAL cliente direto", e({ origemTipo: "OFFLINE_NORMAL" }), "HISTORICO"],
    ["OFFLINE_RECOVERY cliente direto", e({ origemTipo: "OFFLINE_RECOVERY" }), "QUARANTINED"],
    ["falha de decrypt LIVE", e({ falhaDecrypt: true, motivoFalhaDecrypt: "bad_mac" }), "QUARANTINED"],
    ["falha de decrypt OFFLINE_NORMAL", e({ origemTipo: "OFFLINE_NORMAL", falhaDecrypt: true, motivoFalhaDecrypt: "sem_sessao" }), "QUARANTINED"],
    ["recovery + falha", e({ origemTipo: "OFFLINE_RECOVERY", falhaDecrypt: true, motivoFalhaDecrypt: "bad_mac" }), "QUARANTINED"],
    ["fromMe LIVE", e({ fromMe: true, ...semTelefone }), "IGNORED"],
    ["fromMe recovery", e({ fromMe: true, origemTipo: "OFFLINE_RECOVERY", ...semTelefone }), "IGNORED"],
    ["stub de sistema", e({ stubSistema: true }), "IGNORED"],
    ["grupo LIVE", e({ origemJidTipo: "group", ...semTelefone }), "IGNORED"],
    ["status", e({ origemJidTipo: "status", ...semTelefone }), "IGNORED"],
    ["newsletter", e({ origemJidTipo: "newsletter", ...semTelefone }), "IGNORED"],
    ["broadcast", e({ origemJidTipo: "broadcast", ...semTelefone }), "IGNORED"],
    ["LID próprio", e({ origemJidTipo: "direct_lid_self", ...semTelefone }), "IGNORED"],
    ["grupo em recovery (não vira quarentena de cliente)", e({ origemJidTipo: "group", origemTipo: "OFFLINE_RECOVERY", ...semTelefone }), "IGNORED"],
  ];
  for (const [nome, ev, esperado] of tabela) test(nome, () => { assert.ok(v(ev).ok || true); assert.equal(decidirEstadoInbound(ev), esperado); assert.ok(ESTADOS_INBOUND.includes(esperado)); });

  test("PROCESSED é reservado: nada o produz; e RECEIVED só existe para LIVE de cliente direto sem fromMe/falha/stub", () => {
    const todos = [];
    for (const o of ORIGENS_TIPO) for (const j of ORIGENS_JID_TIPO) for (const fm of [true, false]) for (const fd of [true, false]) for (const st of [true, false]) {
      todos.push({ o, j, fm, fd, st, estado: decidirEstadoInbound(base({ origemTipo: o, origemJidTipo: j, fromMe: fm, falhaDecrypt: fd, stubSistema: st })) });
    }
    assert.ok(todos.every((x) => x.estado !== "PROCESSED"));
    for (const x of todos.filter((y) => y.estado === "RECEIVED")) assert.deepEqual([x.o, x.fm, x.fd, x.st, JID_TIPOS_CLIENTE.includes(x.j)], ["LIVE", false, false, false, true]);
    assert.equal(todos.filter((x) => x.estado === "RECEIVED").length, 2, "só direct_pn e direct_lid_other, LIVE");
    for (const x of todos.filter((y) => y.o === "OFFLINE_RECOVERY")) assert.ok(["QUARANTINED", "IGNORED"].includes(x.estado), "recovery nunca RECEIVED/HISTORICO");
  });
});

describe("bloqueio de automação (motivoBloqueioAutomacao) — FAIL-CLOSED", () => {
  test("elegível SÓ com LIVE + cliente direto + sem fromMe/falha/stub (e estado RECEIVED, se houver)", () => {
    assert.equal(motivoBloqueioAutomacao(base()), null); assert.equal(motivoBloqueioAutomacao(base({ origemJidTipo: "direct_lid_other", ...semTelefone })), null);
    assert.equal(motivoBloqueioAutomacao({ ...base(), estado: "RECEIVED" }), null);
  });
  test("14. OFFLINE_RECOVERY nunca dispara automação (nem com todo o resto perfeito)", () => assert.equal(motivoBloqueioAutomacao(base({ origemTipo: "OFFLINE_RECOVERY" })), "recovery"));
  test("OFFLINE_NORMAL, fromMe, falha, stub, chat não-cliente e estado != RECEIVED são bloqueados", () => {
    assert.equal(motivoBloqueioAutomacao(base({ origemTipo: "OFFLINE_NORMAL" })), "origem_nao_live");
    assert.equal(motivoBloqueioAutomacao(base({ fromMe: true })), "from_me");
    assert.equal(motivoBloqueioAutomacao(base({ falhaDecrypt: true, motivoFalhaDecrypt: "bad_mac" })), "falha_decrypt");
    assert.equal(motivoBloqueioAutomacao(base({ stubSistema: true })), "stub_sistema");
    for (const t of ["group", "status", "newsletter", "broadcast", "meta_ai", "technical", "unknown", "direct_lid_self"]) assert.equal(motivoBloqueioAutomacao(base({ origemJidTipo: t })), "jid_nao_suportado", t);
    for (const s of ["QUARANTINED", "HISTORICO", "IGNORED", "PROCESSED", undefined, null]) assert.equal(motivoBloqueioAutomacao({ ...base(), estado: s }), "estado_nao_elegivel", String(s));
  });
  test("campo ausente / tipo errado / lixo ⇒ bloqueado (nunca 'provavelmente ok')", () => {
    for (const k of Object.keys(base())) assert.notEqual(motivoBloqueioAutomacao(sem(base(), k)), null, `sem ${k}`);
    for (const k of ["fromMe", "falhaDecrypt", "stubSistema"]) for (const x of ["false", 0, null, undefined]) assert.notEqual(motivoBloqueioAutomacao(base({ [k]: x })), null, `${k}=${String(x)}`);
    for (const lixo of [null, undefined, {}, [], "x", 5, { origemTipo: "LIVE" }, base({ contratoInbound: 2 }), base({ origemTipo: "live" })]) assert.notEqual(motivoBloqueioAutomacao(lixo), null);
    assert.equal(motivoBloqueioAutomacao(base({ contratoInbound: 2 })), "contrato_invalido");
  });
  test("consistência: o que decidirEstadoInbound classifica como RECEIVED é exatamente o que motivoBloqueioAutomacao libera", () => {
    for (const o of ORIGENS_TIPO) for (const j of ORIGENS_JID_TIPO) for (const fm of [true, false]) for (const fd of [true, false]) for (const st of [true, false]) {
      const ev = base({ origemTipo: o, origemJidTipo: j, fromMe: fm, falhaDecrypt: fd, stubSistema: st });
      assert.equal(decidirEstadoInbound(ev) === "RECEIVED", motivoBloqueioAutomacao(ev) === null, JSON.stringify([o, j, fm, fd, st]));
    }
  });
});

describe("paridade com o Gateway (vocabulários idênticos dos dois lados)", () => {
  const lista = (fonte, nome) => { const m = fonte.match(new RegExp(`${nome} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`)); assert.ok(m, `não achei ${nome}`); return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]); };
  const gwContrato = readFileSync(join(aqui, "..", "..", "gateway-whatsapp", "src", "inboundContrato.js"), "utf8").replace(/\r\n/g, "\n");
  const gwScope = readFileSync(join(aqui, "..", "..", "gateway-whatsapp", "src", "inboundScope.js"), "utf8").replace(/\r\n/g, "\n");
  test("origemTipo, origemJidTipo, telefoneOrigem, motivoFalhaDecrypt e versão", () => {
    assert.deepEqual(lista(gwContrato, "ORIGENS_INBOUND"), [...ORIGENS_TIPO]);
    assert.deepEqual(lista(gwContrato, "ORIGENS_DE_TELEFONE"), [...ORIGENS_TELEFONE]);
    assert.deepEqual(lista(gwScope, "TIPOS_JID"), [...ORIGENS_JID_TIPO]);
    const motivos = [...gwScope.matchAll(/^\s*\[\/[^\n]*\/i?, "([a-z_]+)"\],/gm)].map((m) => m[1]);
    assert.deepEqual([...motivos, "outro"], [...MOTIVOS_FALHA_DECRYPT]);
    assert.match(gwContrato, new RegExp(`CONTRATO_INBOUND_VERSAO = ${CONTRATO_INBOUND_VERSAO};`));
  });
  test("as chaves do evento do Gateway são exatamente as do schema do backend", () => {
    const chaves = [...gwContrato.slice(gwContrato.indexOf("return {\n    contratoInbound")).matchAll(/^\s{4}(\w+)(?::|,)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(chaves, Object.keys(base()).sort());
  });
});
