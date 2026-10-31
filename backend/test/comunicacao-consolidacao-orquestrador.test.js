// Orquestrador da consolidação por telefone — DESLIGADO e não conectado ao worker. Tudo por injeção (provider/estado/finalização falsos):
// vários destinatários no mesmo telefone, tamanho das mensagens, falhas parciais e alterações de permissão ENTRE o agendamento e o envio.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enviarConsolidado, consolidacaoLigada, RESULTADO } from "../src/modules/comunicacao/comunicacao.consolidacao.orquestrador.js";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOM = { registroAtivo: true, revogado: false, categoriaHabilitada: true, optOutContato: false, empresaHabilitada: true, empresaPausadaAte: null, escopoUnidades: null };
const item = (n, over = {}) => ({ id: `m${n}`, idempotencyKey: `wa:d1:${n}`, contatoWhatsappId: "CW-X", organizacaoId: `org-${n}`, empresa: `Empresa ${n}`, unidade: `Unidade ${n}`, unidadeId: `un-${n}`,
  conteudo: `Relatório ${n}: 2 pendências.`, ...over });
const sete = (over = (n) => ({})) => [1, 2, 3, 4, 5, 6, 7].map((n) => item(n, over(n)));

/** Mundo falso: estado por id (mutável entre agendar e enviar), provider que grava envios, finalização que grava resultados. */
function mundo({ estados = {}, falhaEnvio = null, falhaFinalizar = new Set(), falhaEstado = new Set() } = {}) {
  const w = { enviados: [], finais: new Map(), chamadasFinalizar: 0 };
  w.lerEstado = async (it) => { if (falhaEstado.has(it.id)) throw new Error("estado indisponível"); return { ...BOM, ...(estados[it.id] ?? {}) }; };
  w.enviar = async (p) => {
    w.enviados.push(p);
    const f = falhaEnvio?.(p); if (f) throw f;
    return { providerMessageId: `wamid.${w.enviados.length}` };
  };
  w.finalizar = async (id, r) => { w.chamadasFinalizar++; if (falhaFinalizar.has(id)) throw new Error("banco indisponível"); w.finais.set(id, r); };
  return w;
}
const roda = (w, itens, extra = {}) => enviarConsolidado({ itens, lerEstado: w.lerEstado, enviar: w.enviar, finalizar: w.finalizar, agora: () => new Date("2026-11-02T14:00:00Z"), ...extra });

describe("desligada por padrão", () => {
  test("a flag só liga com 'true' explícito; nada no código de produção usa o orquestrador", () => {
    for (const v of [undefined, "", "false", "1", "sim", null]) assert.equal(consolidacaoLigada({ COMUNICACAO_CONSOLIDACAO_POR_TELEFONE: v }), false, String(v));
    assert.equal(consolidacaoLigada({}), false);
    assert.equal(consolidacaoLigada({ COMUNICACAO_CONSOLIDACAO_POR_TELEFONE: " TRUE " }), true);
    const usos = ["comunicacao.alertas.service.js", "comunicacao.entrega.js", "comunicacao.fila.repo.js", "comunicacao.policy.js", "whatsapp.service.js", "comunicacao.manual.js"]
      .filter((f) => /consolidacao/.test(readFileSync(path.join(RAIZ, "src/modules/comunicacao", f), "utf8")));
    assert.deepEqual(usos, []);
    const src = readFileSync(path.join(RAIZ, "src/modules/comunicacao/comunicacao.consolidacao.orquestrador.js"), "utf8");
    assert.doesNotMatch(src, /^import .*(supabase|provider|fila|policy|worker|whatsapp\.service|config)/im);
  });
});

describe("vários destinatários no mesmo telefone", () => {
  test("7 blocos ⇒ UM envio; os 7 componentes terminam SENT com o MESMO provider id; texto com os 7 relatórios completos", async () => {
    const w = mundo(); const r = await roda(w, sete());
    assert.equal(w.enviados.length, 1);
    assert.match(w.enviados[0].idempotencyKey, /^cons:[0-9a-f]{32}$/);
    for (let n = 1; n <= 7; n++) assert.ok(w.enviados[0].texto.includes(`*Empresa ${n} — Unidade ${n}*\nRelatório ${n}: 2 pendências.`));
    assert.equal(w.finais.size, 7);
    assert.ok([...w.finais.values()].every((f) => f.resultado === RESULTADO.SENT && f.providerMessageId === "wamid.1"));
    assert.deepEqual([r.enviadas.length, r.devolvidos.length, r.incertos.length, r.excluidos.length], [1, 0, 0, 0]);
  });
  test("telefones diferentes ⇒ um envio por telefone, cada um só com os próprios blocos", async () => {
    const w = mundo(); await roda(w, [item(1), item(2), item(3, { contatoWhatsappId: "CW-Y" }), item(4, { contatoWhatsappId: "CW-Y" })]);
    const por = Object.fromEntries(w.enviados.map((e) => [e.contatoWhatsappId, e]));
    assert.deepEqual(por["CW-X"].ids.sort(), ["m1", "m2"]); assert.deepEqual(por["CW-Y"].ids.sort(), ["m3", "m4"]);
    assert.ok(!por["CW-X"].texto.includes("Empresa 3") && !por["CW-Y"].texto.includes("Empresa 1"));
  });
  test("bloco único: mantém a chave de idempotência ORIGINAL e o texto original (igual ao de hoje)", async () => {
    const w = mundo(); await roda(w, [item(1)]);
    assert.deepEqual([w.enviados[0].idempotencyKey, w.enviados[0].texto], ["wa:d1:1", "Relatório 1: 2 pendências."]);
  });
});

describe("alterações de permissão ENTRE o agendamento e o envio (estado relido na hora)", () => {
  test("registro revogado depois de agendar: sai do texto, NÃO é finalizado e os outros 6 saem; a chave muda (outro conjunto)", async () => {
    const cheio = mundo(); await roda(cheio, sete());
    const w = mundo({ estados: { m3: { revogado: true } } }); const r = await roda(w, sete());
    assert.ok(!w.enviados[0].texto.includes("Empresa 3") && w.enviados[0].ids.length === 6);
    assert.ok(!w.finais.has("m3") && w.finais.size === 6);
    assert.deepEqual(r.excluidos.map((e) => [e.id, e.motivo]), [["m3", "REVOGADO"]]);
    assert.notEqual(w.enviados[0].idempotencyKey, cheio.enviados[0].idempotencyKey);
  });
  test("opt-out (SAIR) depois de agendar: NADA sai para aquele telefone; o outro telefone segue", async () => {
    const w = mundo({ estados: { m1: { optOutContato: true }, m2: { optOutContato: true } } });
    const r = await roda(w, [item(1), item(2), item(3, { contatoWhatsappId: "CW-Y" })]);
    assert.deepEqual(w.enviados.map((e) => e.contatoWhatsappId), ["CW-Y"]);
    assert.equal(r.excluidos.filter((e) => e.motivo === "OPT_OUT").length, 2);
  });
  test("empresa pausada/desabilitada/unidade fora do escopo: só o bloco daquela empresa é retirado", async () => {
    const w = mundo({ estados: { m2: { empresaPausadaAte: "2026-11-03T00:00:00Z" }, m4: { empresaHabilitada: false }, m5: { escopoUnidades: ["outra"] } } });
    const r = await roda(w, sete());
    assert.deepEqual(w.enviados[0].ids.sort(), ["m1", "m3", "m6", "m7"]);
    assert.deepEqual(r.excluidos.map((e) => e.motivo).sort(), ["EMPRESA_NAO_HABILITADA", "EMPRESA_PAUSADA", "UNIDADE_FORA_DO_ESCOPO"]);
  });
  test("falha ao ler o estado de um bloco: ele fica de fora (fail-closed) e VOLTA para o fluxo individual; os demais saem", async () => {
    const w = mundo({ falhaEstado: new Set(["m2"]) }); const r = await roda(w, [item(1), item(2), item(3)]);
    assert.deepEqual(w.enviados[0].ids.sort(), ["m1", "m3"]);
    assert.deepEqual(r.devolvidos, [{ ids: ["m2"], motivo: "ESTADO_INDISPONIVEL" }]);
  });
});

describe("falhas parciais", () => {
  test("falha PROVADA pré-envio de um grupo: nada é finalizado, os ids VOLTAM ao fluxo individual (nenhum aviso se perde) e o outro telefone ainda sai", async () => {
    const w = mundo({ falhaEnvio: (p) => (p.contatoWhatsappId === "CW-X" ? Object.assign(new Error("WHATSAPP_GATEWAY_NOT_CONNECTED"), { preEnvio: true }) : null) });
    const r = await roda(w, [item(1), item(2), item(3, { contatoWhatsappId: "CW-Y" })]);
    assert.deepEqual(r.devolvidos, [{ ids: ["m1", "m2"], motivo: "FALHA_PRE_ENVIO" }]);
    assert.deepEqual([...w.finais.keys()], ["m3"]);
    assert.equal(r.enviadas.length, 1);
  });
  test("resultado INCERTO (timeout/5xx): todos os componentes DELIVERY_UNKNOWN e NUNCA reenvio (1 chamada só)", async () => {
    const w = mundo({ falhaEnvio: () => Object.assign(new Error("socket hang up"), {}) });
    const r = await roda(w, sete());
    assert.equal(w.enviados.length, 1);
    assert.equal(w.finais.size, 7);
    assert.ok([...w.finais.values()].every((f) => f.resultado === RESULTADO.DELIVERY_UNKNOWN));
    assert.equal(r.incertos.length, 1);
    const timeout = mundo({ falhaEnvio: () => Object.assign(new Error("timeout"), { preEnvio: true, _timeout: true }) });
    const r2 = await roda(timeout, [item(1), item(2)]);
    assert.deepEqual([r2.incertos.length, r2.devolvidos.length], [1, 0]);
  });
  test("depois de ENVIADO, falha ao finalizar UM componente não reenvia: é registrada e os outros são finalizados", async () => {
    const w = mundo({ falhaFinalizar: new Set(["m4"]) }); const r = await roda(w, sete());
    assert.equal(w.enviados.length, 1);
    assert.deepEqual(r.falhasAoFinalizar, [{ id: "m4", resultado: "SENT" }]);
    assert.equal(w.finais.size, 6);
  });
  test("um grupo que falha (incerto) não impede os demais telefones", async () => {
    const w = mundo({ falhaEnvio: (p) => (p.contatoWhatsappId === "CW-X" ? new Error("reset") : null) });
    const r = await roda(w, [item(1), item(2), item(3, { contatoWhatsappId: "CW-Y" })]);
    assert.deepEqual([r.incertos.length, r.enviadas.length], [1, 1]);
  });
});

describe("tamanho e idempotência", () => {
  test("não cabe numa mensagem ⇒ várias, com ids disjuntos, chaves distintas e nenhum relatório cortado; reprocessar dá as MESMAS chaves", async () => {
    const grandes = sete((n) => ({ conteudo: "x".repeat(300) + n }));
    const a = mundo(); await roda(a, grandes, { maxCaracteres: 700 });
    const b = mundo(); await roda(b, grandes, { maxCaracteres: 700 });
    assert.ok(a.enviados.length > 1 && a.enviados.every((e) => e.texto.length <= 700));
    assert.equal(new Set(a.enviados.flatMap((e) => e.ids)).size, 7);
    assert.equal(new Set(a.enviados.map((e) => e.idempotencyKey)).size, a.enviados.length);
    assert.deepEqual(a.enviados.map((e) => e.idempotencyKey), b.enviados.map((e) => e.idempotencyKey));
    for (const e of a.enviados) for (const id of e.ids) assert.ok(e.texto.includes("x".repeat(300) + Number(id.slice(1))));
  });
  test("a ORDEM de entrada não muda texto nem chave (determinístico)", async () => {
    const a = mundo(); await roda(a, sete()); const b = mundo(); await roda(b, sete().reverse());
    assert.deepEqual([a.enviados[0].texto, a.enviados[0].idempotencyKey], [b.enviados[0].texto, b.enviados[0].idempotencyKey]);
  });
  test("entrada vazia ou nula não envia nada", async () => {
    const w = mundo(); for (const itens of [[], null, undefined]) await roda(w, itens);
    assert.equal(w.enviados.length, 0);
  });
});
