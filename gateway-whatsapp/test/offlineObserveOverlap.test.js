// C.9.7 — observador da fila offline + identidade efêmera: histograma SEGURO de attrs.offline e evento `inbound.offline_overlap`
// (sobreposição entre gerações de socket), com relógio/timer falsos e o logsafe REAL. Só diagnóstico: nada aqui altera o fluxo.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { criarObservadorOffline, classificarValorOffline, CLASSES_VALOR_OFFLINE, FASE } from "../src/offlineObserve.js";
import { criarIdentidadeOffline, MOTIVOS_NAO_COMPARAVEL, ESPECIES_IDENTIDADE } from "../src/offlineIdentidade.js";
import { sanitizar } from "../src/logsafe.js";

const S = 1000;
const aqui = dirname(fileURLToPath(import.meta.url));
const SEGREDO = Buffer.alloc(32, 0x33);
const FROM = "5511999990000@s.whatsapp.net";

/** observador (relógio/timer falsos) + identidade real, ligados COMO O WIRING liga: aoNo no observador; registrar só para nós offline */
function criar({ extra = {}, id = {}, comIdentidade = true, identidadeCustom } = {}) {
  let t = 1_700_000_000_000; const eventos = []; const timers = []; const est = { buffer: true, aberto: true };
  const idt = identidadeCustom ?? (comIdentidade ? criarIdentidadeOffline({ segredo: SEGREDO, ...id }) : undefined);
  const obs = criarObservadorOffline({
    agora: () => t, emitir: (n, e, d) => eventos.push({ n, e, d }), obterEpoch: () => 7,
    agendar: (fn, ms) => { const h = { fn, ms, cancelado: false, unref() {} }; timers.push(h); return h; }, cancelar: (h) => { h.cancelado = true; },
    identidade: idt, ...extra,
  });
  const api = {
    obs, idt, eventos, est, g: null,
    avancar: (ms) => { t += ms; },
    agora: () => t,
    nova() { api.g = obs.novaGeracao({ lerBufferAtivo: () => est.buffer, lerSocketAberto: () => est.aberto }); return api.g; },
    passar(ms) { t += ms; obs.aoAtividade(api.g); obs.tick(api.g); },
    preview(attrs = { count: "100" }) { obs.aoPreview(api.g, { tag: "ib", attrs: {}, content: [{ tag: "offline_preview", attrs }] }); },
    /** um nó, como o wiring o trata: observador sempre; identidade só se offline (truthy) */
    no(i, { especie = "message", offlineAttr = "0", idadeS = 3 * 3600, tipo = "group", from = FROM, type = "text" } = {}) {
      obs.aoNo(api.g, { especie, tipo, offlineAttr, t: String(Math.floor(t / 1000) - idadeS) });
      if (offlineAttr) idt?.registrar?.(api.g, especie, { type, id: `ID-${i}`, from });
    },
    nos(n, opcoes = {}, inicio = 0) { for (let i = inicio; i < inicio + n; i++) api.no(i, opcoes); },
    upsert(n = 1) { for (let i = 0; i < n; i++) obs.aoUpsert(api.g, true); },
    porNome: (n) => eventos.filter((e) => e.e === n),
  };
  api.nova();
  return api;
}

describe("classificarValorOffline: inteiros 0-99 exatos; todo o resto só como CLASSE (o valor nunca sai)", () => {
  test("tabela: canônicos 0-99 saem exatos; 100+/ruído/identificadores viram classes por ESTRUTURA", () => {
    const tabela = [
      ["0", { tipo: "int", valor: 0 }], ["1", { tipo: "int", valor: 1 }], ["2", { tipo: "int", valor: 2 }], ["9", { tipo: "int", valor: 9 }], ["10", { tipo: "int", valor: 10 }], ["57", { tipo: "int", valor: 57 }], ["99", { tipo: "int", valor: 99 }],
      [5, { tipo: "int", valor: 5 }],
      ["100", "int_3dig"], ["999", "int_3dig"], ["007", "int_3dig"], ["1000", "int_4dig"], ["12345", "int_5_6dig"], ["123456", "int_5_6dig"], ["1234567", "int_7_9dig"], ["123456789", "int_7_9dig"],
      ["1726876800", "int_10mais_dig"], ["1726876800123", "int_10mais_dig"], ["5511999990000", "int_10mais_dig"],
      ["01", "int_nao_canonico"], ["00", "int_nao_canonico"], ["-5", "negativo"], ["-0", "negativo"], ["1.5", "decimal"], [".5", "decimal"], ["-2.25", "decimal"],
      ["", "vazio"], [undefined, "ausente"], [null, "ausente"], [{}, "tipo_nao_string"], [[], "tipo_nao_string"], [() => 1, "tipo_nao_string"],
      ["abc", "texto_curto"], [" 5", "texto_curto"], ["5 ", "texto_curto"], ["1e9", "texto_curto"], ["０", "texto_curto"], [true, "texto_curto"], ["0x1F", "texto_curto"],
      ["5511999990000@s.whatsapp.net", "texto_longo"], ["100000000000001@lid", "texto_longo"], ["120363000000000001@g.us", "texto_longo"], ["5511999990000:12@s.whatsapp.net", "texto_longo"],
      ["123e4567-e89b-12d3-a456-426614174000", "texto_longo"], ["abcdef0123456789ABCDEF", "texto_longo"], ["SGVsbG8gd29ybGQ=", "texto_longo"], ["deadbeefdeadbeefdeadbeef", "texto_longo"], ["uma string arbitraria qualquer", "texto_longo"],
    ];
    for (const [entrada, esperado] of tabela) {
      const r = classificarValorOffline(entrada);
      assert.deepEqual(r, typeof esperado === "string" ? { tipo: "classe", nome: esperado } : esperado, `entrada: ${String(typeof entrada === "function" ? "fn" : JSON.stringify(entrada))}`);
    }
  });

  test("PROPRIEDADE: só há 2 formas de saída — int 0..99 canônico ou uma classe do vocabulário; nenhum caractere do valor sobra", () => {
    const amostras = ["0", "99", "100", "abc", "5511999990000", "x@y", "", "-3", "1.2", "0099", "8".repeat(40), "a".repeat(400), "９９", "1_000", "1,5", "\u0000", "0\n", "\t7"];
    for (const a of amostras) {
      const r = classificarValorOffline(a);
      assert.ok(r.tipo === "int" ? Number.isInteger(r.valor) && r.valor >= 0 && r.valor <= 99 && String(r.valor) === a : CLASSES_VALOR_OFFLINE.includes(r.nome), JSON.stringify(a));
      assert.deepEqual(Object.keys(r).sort(), r.tipo === "int" ? ["tipo", "valor"] : ["nome", "tipo"]);
    }
    assert.equal(Object.isFrozen(CLASSES_VALOR_OFFLINE), true);
  });
});

describe("histograma de attrs.offline no observador (por espécie, cruzado com a idade)", () => {
  test("message: bins exatos por valor com a distribuição de idade; receipt/notification só contagem; attrOffline legado continua igual", () => {
    const a = criar(); a.preview();
    a.nos(5, { offlineAttr: "0", idadeS: 3 * 3600 }); a.nos(2, { offlineAttr: "1", idadeS: 3 * 3600 }, 10); a.nos(4, { offlineAttr: "2", idadeS: 30 * 3600 }, 20); a.no(30, { offlineAttr: "57", idadeS: 3 * 3600 });
    a.nos(3, { especie: "receipt", offlineAttr: "0" }, 40); a.no(50, { especie: "notification", offlineAttr: "0" });
    const e = a.obs.estado();
    const msg = e.attrOfflineValores.find((x) => x.especie === "message"); const rec = e.attrOfflineValores.find((x) => x.especie === "receipt"); const not = e.attrOfflineValores.find((x) => x.especie === "notification");
    const idade = (lt2h, h2a24, gt24h, sem) => [{ nome: "lt2h", n: lt2h }, { nome: "h2a24", n: h2a24 }, { nome: "gt24h", n: gt24h }, { nome: "sem", n: sem }];
    assert.deepEqual(msg.bins, [
      { tipo: "int", valor: 0, n: 5, idade: idade(0, 5, 0, 0) },
      { tipo: "int", valor: 2, n: 4, idade: idade(0, 0, 4, 0) },
      { tipo: "int", valor: 1, n: 2, idade: idade(0, 2, 0, 0) },
      { tipo: "int", valor: 57, n: 1, idade: idade(0, 1, 0, 0) },
    ]);
    assert.equal(msg.binsOmitidos, 0);
    assert.deepEqual(rec.bins, [{ tipo: "int", valor: 0, n: 3 }]); assert.deepEqual(not.bins, [{ tipo: "int", valor: 0, n: 1 }]);
    assert.deepEqual(e.attrOffline.message, { missing: 0, empty: 0, zero: 5, one: 2, other: 5 }, "o bucket legado não mudou");
  });

  test("valores vivos/ausentes também entram (classe 'ausente'/'vazio'); a idade agrupa lt2h / h2a24 / gt24h / sem", () => {
    const a = criar();
    a.no(1, { offlineAttr: null, idadeS: 30 }); a.no(2, { offlineAttr: "", idadeS: 90 * 60 }); a.no(3, { offlineAttr: "1", idadeS: 300 * 3600 });
    a.obs.aoNo(a.g, { especie: "message", tipo: "group", offlineAttr: "1", t: undefined });
    const msg = a.obs.estado().attrOfflineValores.find((x) => x.especie === "message");
    const por = Object.fromEntries(msg.bins.map((b) => [b.tipo === "int" ? `i:${b.valor}` : `c:${b.nome}`, b]));
    assert.deepEqual(por["c:ausente"].idade, [{ nome: "lt2h", n: 1 }, { nome: "h2a24", n: 0 }, { nome: "gt24h", n: 0 }, { nome: "sem", n: 0 }]);
    assert.deepEqual(por["c:vazio"].idade, [{ nome: "lt2h", n: 1 }, { nome: "h2a24", n: 0 }, { nome: "gt24h", n: 0 }, { nome: "sem", n: 0 }]);
    assert.deepEqual(por["i:1"].idade, [{ nome: "lt2h", n: 0 }, { nome: "h2a24", n: 0 }, { nome: "gt24h", n: 1 }, { nome: "sem", n: 1 }], "t ausente ⇒ 'sem'");
  });

  test("valores MALICIOSOS/sensíveis: nenhum vira valor nos eventos (logsafe real) — só a CLASSE", () => {
    const a = criar(); a.preview();
    const sujos = ["5511999990000", "5511999990000@s.whatsapp.net", "100000000000001@lid", "1726876800", "1726876800123", "123e4567-e89b-12d3-a456-426614174000", "abcdef0123456789ABCDEF", "SGVsbG8gd29ybGQ=", "deadbeefdeadbeefdeadbeef", "PALAVRA-ARBITRARIA-SECRETA", "TOKEN_XYZ_123456"];
    sujos.forEach((v, i) => { a.no(i, { offlineAttr: v }); a.no(i + 100, { offlineAttr: v, especie: "receipt" }); });
    a.upsert(3); a.passar(31 * S); a.obs.aoMarcador(a.g, 1); a.obs.aoFechado(a.g);
    assert.ok(a.eventos.length >= 4);
    const proibidos = ["5511999990000", "s.whatsapp.net", "@lid", "1726876800", "123e4567", "abcdef0123456789", "SGVsbG8", "deadbeef", "PALAVRA", "SECRETA", "TOKEN_XYZ", "123456"];
    for (const x of a.eventos) {
      const linha = JSON.stringify(sanitizar({ evento: x.e, ...x.d }));
      for (const p of proibidos) assert.ok(!linha.includes(p), `${x.e} vazou ${p}`);
      assert.ok(!linha.includes("REDACTED"), `${x.e}: campo mascarado`);
      assert.ok(!/\d{9,}/.test(linha), `${x.e}: número longo`);
    }
    const msg = a.obs.estado().attrOfflineValores.find((x) => x.especie === "message");
    const classes = new Set(msg.bins.map((b) => b.nome)); assert.deepEqual([...classes].sort(), ["int_10mais_dig", "texto_longo"]);
    assert.equal(msg.bins.reduce((s, b) => s + b.n, 0), 11);
  });

  test("teto de bins: no máximo 24 distintos por espécie; o excedente só é CONTADO", () => {
    const a = criar();
    for (let v = 0; v < 30; v++) a.no(v, { offlineAttr: String(v) });
    const msg = a.obs.estado().attrOfflineValores.find((x) => x.especie === "message");
    assert.equal(msg.bins.length, 24); assert.equal(msg.binsOmitidos, 6); assert.equal(msg.bins.reduce((s, b) => s + b.n, 0) + msg.binsOmitidos, 30);
    a.no(99, { offlineAttr: "3" });                            // bin já existente continua contando mesmo com o teto cheio
    assert.equal(a.obs.estado().attrOfflineValores.find((x) => x.especie === "message").bins.find((b) => b.valor === 3).n, 2);
  });

  test("é POR GERAÇÃO: o histograma e a idade zeram no socket novo (para comparar socket 1 × socket 2)", () => {
    const a = criar(); a.nos(10, { offlineAttr: "2", idadeS: 30 * 3600 });
    assert.equal(a.obs.estado().attrOfflineValores[0].bins[0].n, 10);
    a.nova(); a.nos(3, { offlineAttr: "0", idadeS: 3 * 3600 });
    const e = a.obs.estado();
    assert.deepEqual(e.attrOfflineValores[0].bins.map((b) => [b.valor, b.n]), [[0, 3]]); assert.equal(e.idade.offline.gt24h, 0); assert.equal(e.idade.offline.h2a24, 3);
  });
});

describe("inbound.offline_overlap", () => {
  const sobrepor = (a) => a.porNome("inbound.offline_overlap");

  test("1ª geração: sem anterior ⇒ evento com comparavel=false / sem_geracao_anterior; a 2ª (mesmos nós) ⇒ overlap 100% e o preview.count entre gerações", () => {
    const a = criar();
    a.preview({ count: "5666", message: "3278", receipt: "1632", notification: "740", call: "2", status: "13", appdata: "0" });
    a.nos(100); a.upsert(80); a.passar(31 * S);
    assert.equal(sobrepor(a).length, 1); const d1 = sobrepor(a)[0].d;
    assert.deepEqual([d1.gatilho, d1.comparavel, d1.motivo, d1.previousGeneration, d1.currentGeneration, d1.currentCount, d1.overlapCount, d1.previewAnterior, d1.previewCountDelta, d1.observeOnly, d1.RECOVERY_PATH_USED],
      ["stall", false, "sem_geracao_anterior", null, 1, 100, null, null, null, true, false]);
    assert.deepEqual(d1.previewAtual, [{ nome: "count", valor: 5666 }, { nome: "message", valor: 3278 }, { nome: "receipt", valor: 1632 }, { nome: "notification", valor: 740 }, { nome: "call", valor: 2 }, { nome: "status", valor: 13 }, { nome: "appdata", valor: 0 }]);
    a.obs.aoFechado(a.g); assert.equal(sobrepor(a).length, 1, "a contagem não mudou: o fechamento NÃO reemite");
    a.nova(); a.preview({ count: "5564", message: "3200", receipt: "1600", notification: "764", call: "0", status: "0", appdata: "0" });
    a.nos(100); a.upsert(80); a.passar(31 * S);
    const d2 = sobrepor(a).at(-1).d;
    assert.deepEqual([d2.gatilho, d2.comparavel, d2.previousGeneration, d2.currentGeneration, d2.geracoesEntre, d2.previousCount, d2.currentCount, d2.overlapCount, d2.newCount, d2.missingCount, d2.overlapPct, d2.newPct, d2.overlapIdOnlyPct, d2.seenInRetainedCount, d2.unseenInRetainedCount],
      ["stall", true, 1, 2, 1, 100, 100, 100, 0, 0, 100, 0, 100, 100, 0]);
    assert.equal(d2.previewCountDelta, -102, "5564 − 5666: o count desceu"); assert.equal(d2.previewAnterior.find((p) => p.nome === "count").valor, 5666);
    assert.equal(d2.idadeOfflineAnterior.find((b) => b.nome === "h2a24").n, 100, "idade da geração anterior junto");
    assert.equal(d2.idadeOffline.find((b) => b.nome === "h2a24").n, 100);
  });

  test("nós NOVOS: outra fatia da fila ⇒ overlap 0 / novos 100%, e o count do preview pode subir (delta positivo)", () => {
    const a = criar(); a.preview({ count: "5666" }); a.nos(100); a.upsert(5); a.passar(31 * S); a.nova();
    a.preview({ count: "5700" }); a.nos(100, {}, 5000); a.upsert(5); a.passar(31 * S);
    const d = sobrepor(a).at(-1).d;
    assert.deepEqual([d.overlapCount, d.newCount, d.missingCount, d.overlapPct, d.newPct, d.missingPct, d.previewCountDelta], [0, 100, 100, 0, 100, 100, 34]);
  });

  test("gatilho FECHAMENTO (socket cai antes do stall) e MARCADOR; reemissão só se a contagem mudou; no máximo 3 por geração", () => {
    const a = criar(); a.nos(10); a.obs.aoFechado(a.g);
    assert.deepEqual(sobrepor(a).map((x) => x.d.gatilho), ["fechamento"]);
    const b = criar(); b.preview(); b.nos(10); b.upsert(3); b.passar(31 * S);                   // emissão 1 (stall)
    b.nos(2, {}, 100); b.upsert(1); b.passar(31 * S);                                          // retomada + novo stall com 12 ⇒ emissão 2
    b.nos(1, {}, 200); b.obs.aoMarcador(b.g, 3);                                                // 13 ⇒ emissão 3 (marcador)
    b.nos(1, {}, 300); b.obs.aoFechado(b.g);                                                    // 14, mas o teto de 3 já foi atingido
    assert.deepEqual(sobrepor(b).map((x) => [x.d.gatilho, x.d.currentCount]), [["stall", 10], ["stall", 12], ["marcador", 13]]);
    const c = criar(); c.preview(); c.nos(10); c.upsert(3); c.passar(31 * S); c.obs.aoMarcador(c.g, 1); c.obs.aoFechado(c.g);
    assert.equal(sobrepor(c).length, 1, "mesma contagem em stall, marcador e fechamento ⇒ 1 evento só");
  });

  test("SEM nós offline (só preview, ou só nós vivos) não emite nada; nó vivo (attrs.offline ausente) não entra na identidade", () => {
    const a = criar(); a.preview(); a.no(1, { offlineAttr: null }); a.no(2, { offlineAttr: "" }); a.obs.aoFechado(a.g);
    assert.equal(sobrepor(a).length, 0); assert.equal(a.idt.estado().atualCount, 0);
  });

  test("geração fechada pela SEGUINTE (o Baileys reabriu o socket sem 'close' nem stall) ainda emite o fechamento, com a identidade da geração antiga intacta", () => {
    const a = criar(); a.preview({ count: "50" }); a.nos(12);
    assert.equal(sobrepor(a).length, 0);
    a.nova();
    assert.deepEqual(sobrepor(a).map((x) => [x.d.gatilho, x.d.socketGeneration, x.d.currentCount]), [["fechamento", 1, 12]]);
    a.nos(12); a.obs.aoFechado(a.g);
    const d = sobrepor(a).at(-1).d; assert.deepEqual([d.socketGeneration, d.previousGeneration, d.overlapPct], [2, 1, 100]);
  });

  test("uma geração vazia no meio não some com a anterior: previousGeneration=1 e geracoesEntre=2, preview anterior da geração 1", () => {
    const a = criar(); a.preview({ count: "500" }); a.nos(20); a.obs.aoFechado(a.g);
    a.nova(); a.preview({ count: "480" }); a.obs.aoFechado(a.g);
    a.nova(); a.preview({ count: "470" }); a.nos(20); a.obs.aoFechado(a.g);
    const d = sobrepor(a).at(-1).d;
    assert.deepEqual([d.previousGeneration, d.currentGeneration, d.geracoesEntre, d.overlapPct, d.previewCountDelta, d.previewAnterior.find((p) => p.nome === "count").valor], [1, 3, 2, 100, -30, 500]);
  });

  test("só o 1º preview da geração conta e só números (count/message/...): atributo sensível/desconhecido nunca vira previewAtual", () => {
    const a = criar();
    a.preview({ count: "180", message: "150", jid: "5511999990000@s.whatsapp.net", fone: "5511999990000", tok: "abcdef0123456789ABCDEF", modo: "recent", status: "recent", call: "5511999990000", receipt: "true", extra: "42" });
    a.preview({ count: "9999" });
    a.nos(3); a.obs.aoFechado(a.g);
    const d = sobrepor(a)[0].d;
    assert.deepEqual(d.previewAtual, [{ nome: "count", valor: 180 }, { nome: "message", valor: 150 }]);
    assert.deepEqual(a.obs.estado().previewNumerico, { count: 180, message: 150 });
  });

  test("por espécie (message/receipt/notification) e frouxa × estrita saem como contagens", () => {
    const a = criar(); a.preview(); a.nos(10); a.nos(4, { especie: "receipt" }, 100); a.obs.aoFechado(a.g);
    a.nova(); a.preview(); a.nos(6); a.nos(4, { especie: "receipt" }, 100); a.nos(2, { especie: "notification" }, 300); a.obs.aoFechado(a.g);
    const d = sobrepor(a).at(-1).d;
    assert.deepEqual(d.porEspecie, [{ nome: "message", currentCount: 6, overlapCount: 6, newCount: 0 }, { nome: "receipt", currentCount: 4, overlapCount: 4, newCount: 0 }, { nome: "notification", currentCount: 2, overlapCount: 0, newCount: 2 }]);
    a.nova(); a.preview(); a.nos(5, { from: "100000000000001@lid" }); a.obs.aoFechado(a.g);
    const e = sobrepor(a).at(-1).d; assert.deepEqual([e.overlapPct, e.overlapIdOnlyPct], [0, 100], "mesmos ids, outro endereço: estrita 0%, frouxa 100%");
  });

  test("segurança do evento (logsafe REAL): esquema fechado, vocabulário fechado, nenhum id/from/impressão/segredo, nenhum campo mascarado", () => {
    const a = criar(); a.preview({ count: "100" }); a.nos(30); a.upsert(3); a.passar(31 * S); a.nova(); a.preview({ count: "90" }); a.nos(20); a.nos(10, {}, 700); a.upsert(3); a.passar(31 * S);
    const ev = sobrepor(a).at(-1);
    assert.deepEqual(Object.keys(ev.d).sort(), [
      "RECOVERY_PATH_USED", "comparavel", "currentCount", "currentGeneration", "currentIdOnlyCount", "currentTruncado", "descartadosPorLimite", "duplicadosNoSocket", "epoch", "gatilho", "geracoesEntre", "geracoesRetidasNoProcesso",
      "idadeOffline", "idadeOfflineAnterior", "missingCount", "missingIdOnlyCount", "missingIdOnlyPct", "missingPct", "motivo", "newCount", "newIdOnlyCount", "newIdOnlyPct", "newPct", "observeOnly", "overlapCount", "overlapIdOnlyCount", "overlapIdOnlyPct", "overlapPct",
      "porEspecie", "previewAnterior", "previewAtual", "previewCountDelta", "previousCount", "previousGeneration", "previousIdOnlyCount", "previousTruncado", "seenInRetainedCount", "semIdentidade", "socketGeneration", "unseenInRetainedCount",
    ]);
    const vocab = new Set([...Object.values(FASE), "stall", "marcador", "fechamento", ...MOTIVOS_NAO_COMPARAVEL, ...ESPECIES_IDENTIDADE, "count", "message", "receipt", "notification", "call", "status", "appdata", "lt1m", "m1a5", "m5a30", "m30a120", "h2a24", "gt24h", "ausente", "invalido"]);
    const visitar = (v, c) => {
      if (v === null || typeof v === "number" || typeof v === "boolean") return;
      if (typeof v === "string") { assert.ok(vocab.has(v), `string fora do vocabulário em ${c}: ${v}`); return; }
      if (Array.isArray(v)) { v.forEach((x, i) => visitar(x, `${c}[${i}]`)); return; }
      for (const [k, x] of Object.entries(v)) visitar(x, `${c}.${k}`);
    };
    visitar(ev.d, "inbound.offline_overlap");
    const h = (dominio, itens) => createHmac("sha256", SEGREDO).update(JSON.stringify([dominio, ...itens])).digest();
    const formas = (b) => [b.toString("base64"), b.subarray(0, 16).toString("base64"), b.toString("hex"), b.subarray(0, 16).toString("hex"), b.toString("base64url"), b.subarray(0, 16).toString("base64url")];
    const proibidos = [SEGREDO.toString("hex"), SEGREDO.toString("base64"), "ID-", "5511999990000", "s.whatsapp.net", "@lid", ...formas(h("estrita", ["message", "text", "ID-3", FROM, ""])), ...formas(h("frouxa", ["message", "ID-3"]))];
    for (const x of a.eventos) {
      const linha = JSON.stringify(sanitizar({ evento: x.e, ...x.d }));
      for (const p of proibidos) assert.ok(!linha.includes(p), `${x.e} vazou ${p}`);
      assert.ok(!linha.includes("REDACTED"), `${x.e}: campo mascarado`); assert.ok(!/\d{9,}/.test(linha), `${x.e}: número longo`);
    }
  });

  test("SEM identidade injetada não há evento de sobreposição e o histograma segue funcionando; identidade que LANÇA nunca interfere no observador", () => {
    const sem = criar({ comIdentidade: false }); sem.preview(); sem.nos(10); sem.upsert(3); sem.passar(31 * S); sem.obs.aoFechado(sem.g);
    assert.equal(sem.porNome("inbound.offline_overlap").length, 0); assert.ok(sem.porNome("inbound.offline_stalled_observed").length === 1);
    assert.ok(sem.obs.estado().attrOfflineValores[0].bins.length >= 1);
    const quebrada = { novaGeracao() { throw new Error("x"); }, comparar() { throw new Error("y"); } };
    const b = criar({ identidadeCustom: quebrada });
    assert.doesNotThrow(() => { b.preview(); b.nos(5); b.upsert(3); b.passar(31 * S); b.nova(); b.nos(2); b.obs.aoMarcador(b.g, 1); b.obs.aoFechado(b.g); });
    assert.equal(b.porNome("inbound.offline_overlap").length, 0); assert.equal(b.porNome("inbound.offline_stalled_observed").length, 1, "o stall continua sendo observado");
    for (const lixo of [null, undefined, "lixo", { currentCount: 0 }]) {
      const c = criar({ identidadeCustom: { novaGeracao() {}, comparar: () => lixo } }); assert.doesNotThrow(() => { c.preview(); c.nos(3); c.upsert(3); c.passar(31 * S); c.obs.aoFechado(c.g); });
      assert.equal(c.porNome("inbound.offline_overlap").length, 0);
    }
  });

  test("a máquina de estados/watchdog NÃO muda com a identidade ligada: mesmas fases, contadores e eventos de stall/estado", () => {
    const roteiro = (a) => { a.preview(); a.nos(30); a.upsert(20); a.passar(31 * S); for (let i = 0; i < 60; i++) a.passar(1 * S); a.nos(2, {}, 500); a.upsert(1); a.obs.aoMarcador(a.g, 4); a.obs.aoFechado(a.g); };
    const com = criar(); const sem = criar({ comIdentidade: false }); roteiro(com); roteiro(sem);
    const limpar = (a) => a.eventos.filter((e) => e.e !== "inbound.offline_overlap").map((e) => ({ e: e.e, d: e.d }));
    assert.deepEqual(limpar(com), limpar(sem));
    assert.deepEqual(com.obs.metricas().stallEventos, sem.obs.metricas().stallEventos);
  });
});

describe("GUARDA ESTRUTURAL do wiring de identidade (nenhum material bruto no observador; só registro)", () => {
  const tira = (s) => s.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const observador = tira(readFileSync(join(aqui, "..", "src", "offlineObserve.js"), "utf8"));
  const wiring = tira(readFileSync(join(aqui, "..", "src", "inboundScope.js"), "utf8"));

  test("o observador só chama identidade.novaGeracao e identidade.comparar; nunca `registrar` (o material bruto não passa por ele) nem lê attrs de stanza", () => {
    const usados = new Set([...observador.matchAll(/\bidentidade\??\.(\w+)/g)].map((m) => m[1]));
    assert.deepEqual([...usados].sort(), ["comparar", "novaGeracao"]);
    assert.ok(!/registrar/.test(observador), "o observador não registra impressões");
    assert.ok(!/\.from\b|\.participant\b|\bremoteJid\b|\.attrs\??\.(id|from|participant|recipient|author)\b/.test(observador), "o observador não lê from/participant/id de stanza (só o nó do preview e o offlineAttr/t que recebe prontos)");
  });

  test("no wiring, a identidade só é chamada por `registrar` (dentro do tratador de stanza, só para nó OFFLINE) e `estado` (tamanhos)", () => {
    const usados = new Set([...wiring.matchAll(/\bidentidadeOffline\??\.(\w+)/g)].map((m) => m[1]));
    assert.deepEqual([...usados].sort(), ["estado", "registrar"]);
    const chamadas = [...wiring.matchAll(/identidadeOffline\.registrar\(([^;]*)\);/g)];
    assert.equal(chamadas.length, 1);
    // Checkpoint G: o resultado (classificação "novo"/"duplicado"/...) agora também alimenta o motor de recovery
    // (progresso útil), mas o GATE (só nó offline) e o MATERIAL (type/id/from/participant, nunca mais) são os mesmos.
    assert.ok(/if \(identidadeOffline && node\?\.attrs\?\.offline\) \{\s*const classificacaoIdentidade = identidadeOffline\.registrar\(g, especie, \{ type: node\.attrs\.type, id: node\.attrs\.id, from: node\.attrs\.from, participant: node\.attrs\.participant \}\);/.test(wiring), "gate offline + material fechado (type/id/from/participant)");
    for (const proibido of [/\.content\b[^;]*registrar|registrar\([^)]*\.content/, /registrar\([^)]*(message|conversation|caption|text)\b/i]) assert.ok(!proibido.test(wiring), `material proibido: ${proibido}`);
  });

  test("o log de boot (inbound.escopo) prova operacionalmente que a identidade está ligada: offlineIdentidade = estadoIdentidade() !== undefined", () => {
    const server = tira(readFileSync(join(aqui, "..", "src", "server.js"), "utf8"));
    assert.ok(/offlineObserve: inbound\.offlineObserve, offlineIdentidade: inbound\.estadoIdentidade\(\) !== undefined,/.test(server));
  });

  test("a identidade só existe com o observador (offlineObserve) e pode ser desligada; o restante do observador não muda de interface", () => {
    assert.ok(/const identidadeOffline = diagHabilitado && offlineObserve && identidadeLigada !== false \? criarIdentidadeOffline\(identidadeOpcoes\) : undefined/.test(wiring));
    const usadosObs = new Set([...wiring.matchAll(/\bobservador\??\.(\w+)/g)].map((m) => m[1]));
    for (const u of usadosObs) assert.ok(["novaGeracao", "aoAtividade", "aoPreview", "aoNo", "aoUpsert", "aoFlush", "aoMarcador", "aoFechado", "estado", "metricas", "parar"].includes(u), `método inesperado: ${u}`);
  });
});
