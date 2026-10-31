// Integração da consolidação por telefone com o lote do D-1 — protocolo contra um PIPELINE FALSO fiel ao contrato (avaliar → reservar → enviar →
// finalizar). DESLIGADA e não conectada ao worker; o pipeline real NÃO é tocado. Aqui se provam: os 7 destinatários multiempresa, nenhum relatório
// omitido (conservação, inclusive por propriedade), autorização relida no envio, revogações e falhas, e a decisão sobre o teto por telefone.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processarLoteConsolidado, consolidacaoLigada, DESTINO } from "../src/modules/comunicacao/comunicacao.consolidacao.integracao.js";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ON = { COMUNICACAO_CONSOLIDACAO_POR_TELEFONE: "true" };
const BOM = { registroAtivo: true, revogado: false, categoriaHabilitada: true, optOutContato: false, empresaHabilitada: true, empresaPausadaAte: null, escopoUnidades: null };
const job = (n, over = {}) => ({ id: `m${n}`, contato_id: "CW-X", gate: "ok", ...over });
const sete = (over = () => ({})) => [1, 2, 3, 4, 5, 6, 7].map((n) => job(n, over(n)));
const conteudoDe = (id) => `Relatório ${id}: 2 pendências.`;

/** Pipeline falso: portões por `job.gate`, estado por id (mutável), teto por telefone com a semântica escolhida, provider e finalização gravando tudo. */
function pipeline({ semanticaTeto = "consolidada", teto = 3, estados = {}, falhaReserva = new Set(), falhaEnvio = null, falhaFinalizar = new Set(), falhaEstado = new Set(), falhaAvaliar = new Set() } = {}) {
  const w = { chamadas: [], enviados: [], finais: new Map(), contagemTeto: new Map(), gruposContados: new Set() };
  const rastro = (nome) => w.chamadas.push(nome);
  const portas = {
    avaliar: async (j) => {
      rastro(`avaliar:${j.id}`);
      if (falhaAvaliar.has(j.id)) throw new Error("falha interna");
      if (j.gate !== "ok") return { pronto: false, resultado: j.gate };
      return { pronto: true, item: { id: j.id, idempotencyKey: `wa:${j.id}`, contatoWhatsappId: j.contato_id, organizacaoId: `org-${j.id}`, empresa: `Empresa ${j.id}`, unidade: `Unidade ${j.id}`, unidadeId: `un-${j.id}`, conteudo: conteudoDe(j.id) } };
    },
    relerEstado: async (item) => { rastro(`estado:${item.id}`); if (falhaEstado.has(item.id)) throw new Error("estado indisponível"); return { ...BOM, ...(estados[item.id] ?? {}) }; },
    reservar: async (j, ctx) => {
      rastro(`reservar:${j.id}`);
      if (falhaReserva.has(j.id)) throw new Error("banco indisponível");
      const t = j.contato_id; const n = w.contagemTeto.get(t) ?? 0;
      if (semanticaTeto === "cada") { if (n >= teto) return { iniciado: false, resultado: "RATE_LIMIT_DIA" }; w.contagemTeto.set(t, n + 1); }
      else if (ctx.consolidado) { const k = `${t}`; if (!w.gruposContados.has(k)) { if (n >= teto) return { iniciado: false, resultado: "RATE_LIMIT_DIA" }; w.gruposContados.add(k); w.contagemTeto.set(t, n + 1); } }
      else { if (n >= teto) return { iniciado: false, resultado: "RATE_LIMIT_DIA" }; w.contagemTeto.set(t, n + 1); }
      return { iniciado: true, tentativa: 1 };
    },
    enviar: async (p) => { rastro(`enviar:${p.ids.join("+")}`); w.enviados.push(p); const f = falhaEnvio?.(p); if (f) throw f; return { providerMessageId: `wamid.${w.enviados.length}` }; },
    finalizar: async (j, tentativa, r) => { rastro(`finalizar:${j.id}`); if (falhaFinalizar.has(j.id)) throw new Error("banco indisponível"); w.finais.set(j.id, { ...r, tentativa }); },
  };
  w.portas = portas;
  return w;
}
const roda = (w, jobs, extra = {}) => processarLoteConsolidado({ jobs, env: ON, portas: w.portas, agora: () => new Date("2026-11-02T14:00:00Z"), ...extra });

describe("desligada por padrão", () => {
  test("flag desligada: devolve null e NENHUMA porta é tocada (o chamador segue o caminho de hoje)", async () => {
    const w = pipeline();
    for (const env of [{}, { COMUNICACAO_CONSOLIDACAO_POR_TELEFONE: "false" }, { COMUNICACAO_CONSOLIDACAO_POR_TELEFONE: "1" }]) {
      assert.equal(await processarLoteConsolidado({ jobs: sete(), env, portas: w.portas }), null);
    }
    assert.deepEqual(w.chamadas, []);
    assert.equal(consolidacaoLigada({}), false);
  });
  test("ninguém no código de produção usa a integração; o módulo só importa a consolidação pura", () => {
    const usos = ["comunicacao.alertas.service.js", "comunicacao.entrega.js", "comunicacao.fila.repo.js", "comunicacao.policy.js", "whatsapp.service.js", "comunicacao.manual.js"]
      .filter((f) => /consolidacao/.test(readFileSync(path.join(RAIZ, "src/modules/comunicacao", f), "utf8")));
    assert.deepEqual(usos, []);
    const src = readFileSync(path.join(RAIZ, "src/modules/comunicacao/comunicacao.consolidacao.integracao.js"), "utf8");
    assert.deepEqual([...src.matchAll(/^import .* from "(.*)";/gm)].map((m) => m[1]), ["./comunicacao.consolidacao.js"]);
  });
});

describe("os 7 destinatários multiempresa do mesmo telefone", () => {
  test("teto contando a mensagem CONSOLIDADA uma vez: UM envio com os 7 relatórios completos; os 7 terminam ENVIADO com o mesmo provider id", async () => {
    const w = pipeline({ semanticaTeto: "consolidada" }); const r = await roda(w, sete());
    assert.equal(w.enviados.length, 1);
    for (let n = 1; n <= 7; n++) assert.ok(w.enviados[0].texto.includes(`*Empresa m${n} — Unidade m${n}*\n${conteudoDe(`m${n}`)}`), `relatório ${n}`);
    assert.ok([...r.destinos.values()].every((d) => d.destino === DESTINO.ENVIADO));
    assert.ok([...w.finais.values()].every((f) => f.resultado === "SENT" && f.providerMessageId === "wamid.1" && f.consolidadaEm));
    assert.equal(w.contagemTeto.get("CW-X"), 1, "o telefone consumiu UMA unidade do teto");
  });
  test("SEMÂNTICA ATUAL do teto (cada componente conta): só 3 reservam; os outros 4 ficam NAO_RESERVADO (RATE_LIMIT_DIA) — por isso consolidar exige decidir o teto", async () => {
    const w = pipeline({ semanticaTeto: "cada", teto: 3 }); const r = await roda(w, sete());
    const por = (d) => [...r.destinos].filter(([, v]) => v.destino === d).map(([id]) => id).sort();
    assert.deepEqual(por(DESTINO.ENVIADO), ["m1", "m2", "m3"]);
    assert.deepEqual(por(DESTINO.NAO_RESERVADO), ["m4", "m5", "m6", "m7"]);
    assert.ok(!w.enviados[0].texto.includes("m4"), "quem não reservou nunca entra no texto");
  });
  test("a reserva vem ANTES do envio e os portões ANTES da reserva (ordem do protocolo)", async () => {
    const w = pipeline(); await roda(w, [job(1), job(2)]);
    const idx = (p) => w.chamadas.findIndex((c) => c.startsWith(p));
    assert.ok(idx("avaliar:m1") < idx("avaliar:m2") && idx("avaliar:m2") < idx("estado:m1") && idx("estado:m2") < idx("reservar:m1") && idx("reservar:m2") < idx("enviar:") && idx("enviar:") < idx("finalizar:"));
  });
});

describe("autorização revalidada no envio, revogações e portões", () => {
  test("revogado ENTRE o agendamento e o envio: nem reserva, nem texto, nem finalização; destino EXCLUIDO_POR_AUTORIZACAO", async () => {
    const w = pipeline({ estados: { m3: { revogado: true }, m5: { optOutContato: false, categoriaHabilitada: false } } }); const r = await roda(w, sete());
    assert.ok(!w.chamadas.includes("reservar:m3") && !w.chamadas.includes("reservar:m5"));
    assert.ok(!w.enviados[0].texto.includes("m3") && !w.enviados[0].texto.includes("m5"));
    assert.deepEqual([r.destinos.get("m3").destino, r.destinos.get("m3").detalhe, r.destinos.get("m5").detalhe], [DESTINO.EXCLUIDO_POR_AUTORIZACAO, "REVOGADO", "CATEGORIA_DESABILITADA"]);
    assert.deepEqual([w.enviados[0].ids.length, w.finais.has("m3")], [5, false]);
  });
  test("opt-out (SAIR) do telefone: nada é reservado nem enviado; todos EXCLUIDO_POR_AUTORIZACAO", async () => {
    const w = pipeline({ estados: Object.fromEntries(sete().map((j) => [j.id, { optOutContato: true }])) }); const r = await roda(w, sete());
    assert.deepEqual([w.enviados.length, w.chamadas.some((c) => c.startsWith("reservar"))], [0, false]);
    assert.ok([...r.destinos.values()].every((d) => d.destino === DESTINO.EXCLUIDO_POR_AUTORIZACAO && d.detalhe === "OPT_OUT"));
  });
  test("portão do pipeline (alerta encerrado, adiado, fora da janela) fica de fora e já tem destino próprio; os outros saem", async () => {
    const w = pipeline(); const r = await roda(w, sete((n) => (n === 2 ? { gate: "CANCELADO_ALERTA_ENCERRADO" } : n === 4 ? { gate: "ADIADO" } : {})));
    assert.deepEqual([r.destinos.get("m2").destino, r.destinos.get("m2").detalhe, r.destinos.get("m4").detalhe], [DESTINO.TERMINAL_NA_AVALIACAO, "CANCELADO_ALERTA_ENCERRADO", "ADIADO"]);
    assert.deepEqual(w.enviados[0].ids.sort(), ["m1", "m3", "m5", "m6", "m7"]);
  });
  test("falha ao reler o estado: o job VOLTA ao fluxo individual (nada se perde); falha de reserva: fora do texto, ERRO_INTERNO, os outros saem", async () => {
    const w = pipeline({ falhaEstado: new Set(["m2"]), falhaReserva: new Set(["m4"]) }); const r = await roda(w, [job(1), job(2), job(3), job(4)]);
    assert.deepEqual(r.individuais.map((j) => j.id), ["m2"]);
    assert.equal(r.destinos.get("m2").destino, DESTINO.DEVOLVIDO_AO_FLUXO_INDIVIDUAL);
    assert.equal(r.destinos.get("m4").destino, DESTINO.ERRO_INTERNO);
    assert.deepEqual(w.enviados[0].ids.sort(), ["m1", "m3"]);
  });
});

describe("falhas de envio", () => {
  test("falha PROVADA pré-envio: nenhum SENT; cada componente é finalizado com RETRY (volta ao fluxo individual); o outro telefone ainda sai", async () => {
    const w = pipeline({ falhaEnvio: (p) => (p.contatoWhatsappId === "CW-X" ? Object.assign(new Error("NOT_CONNECTED"), { preEnvio: true }) : null) });
    const r = await roda(w, [job(1), job(2), job(3, { contato_id: "CW-Y" }), job(4, { contato_id: "CW-Y" })]);
    assert.deepEqual([w.finais.get("m1").resultado, w.finais.get("m2").resultado, w.finais.get("m3").resultado], ["RETRY", "RETRY", "SENT"]);
    assert.deepEqual([r.destinos.get("m1").destino, r.destinos.get("m3").destino], [DESTINO.DEVOLVIDO_AO_FLUXO_INDIVIDUAL, DESTINO.ENVIADO]);
  });
  test("INCERTO (timeout/5xx): todos DELIVERY_UNKNOWN e UMA chamada só — nunca reenvio", async () => {
    const w = pipeline({ falhaEnvio: () => new Error("socket hang up") }); const r = await roda(w, sete());
    assert.equal(w.enviados.length, 1);
    assert.ok([...w.finais.values()].every((f) => f.resultado === "DELIVERY_UNKNOWN") && w.finais.size === 7);
    assert.ok([...r.destinos.values()].every((d) => d.destino === DESTINO.INCERTO));
    const t = pipeline({ falhaEnvio: () => Object.assign(new Error("timeout"), { preEnvio: true, _timeout: true }) });
    assert.equal((await roda(t, [job(1), job(2)])).destinos.get("m1").destino, DESTINO.INCERTO);
  });
  test("depois de ENVIADO, falha ao finalizar um componente não reenvia e não derruba os outros", async () => {
    const w = pipeline({ falhaFinalizar: new Set(["m4"]) }); await roda(w, sete());
    assert.deepEqual([w.enviados.length, w.finais.size, w.finais.has("m4")], [1, 6, false]);
  });
});

describe("telefone sem par e tamanho", () => {
  test("telefone com UM job (ou sem contato) segue o fluxo individual: nenhuma porta é chamada para ele", async () => {
    const w = pipeline(); const r = await roda(w, [job(1), job(2, { contato_id: "CW-Y" }), job(3, { contato_id: null })]);
    assert.deepEqual(r.individuais.map((j) => j.id).sort(), ["m1", "m2", "m3"]);
    assert.deepEqual(w.chamadas, []);
  });
  test("não cabe numa mensagem: várias, ids disjuntos, chaves distintas, nada cortado; cada uma reservada antes", async () => {
    const w = pipeline();
    const grandes = sete(); const p = w.portas.avaliar; w.portas.avaliar = async (j) => { const a = await p(j); if (a.pronto) a.item.conteudo = "x".repeat(300) + j.id; return a; };
    await roda(w, grandes, { maxCaracteres: 700 });
    assert.ok(w.enviados.length > 1 && w.enviados.every((e) => e.texto.length <= 700));
    assert.equal(new Set(w.enviados.flatMap((e) => e.ids)).size, 7);
    assert.equal(new Set(w.enviados.map((e) => e.idempotencyKey)).size, w.enviados.length);
    for (const e of w.enviados) for (const id of e.ids) assert.ok(e.texto.includes("x".repeat(300) + id));
  });
});

describe("PROPRIEDADE — conservação com cenários aleatórios (nenhum relatório omitido nem duplicado)", () => {
  function prng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
  test("300 cenários: todo job termina em exatamente um destino; ENVIADO só em uma mensagem, com o conteúdo inteiro; excluído/barrado nunca aparece no texto", async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = prng(seed); const pick = (a) => a[Math.floor(rnd() * a.length)];
      const n = 1 + Math.floor(rnd() * 12);
      const jobs = Array.from({ length: n }, (_, i) => job(i + 1, { contato_id: pick(["CW-A", "CW-B", "CW-C"]), gate: rnd() < 0.15 ? pick(["ADIADO", "BLOQUEADO", "CANCELADO_ALERTA_ENCERRADO"]) : "ok" }));
      const estados = {}; const falhaReserva = new Set(); const falhaEstado = new Set(); const falhaFinalizar = new Set(); const falhaAvaliar = new Set();
      for (const j of jobs) {
        if (rnd() < 0.15) estados[j.id] = pick([{ revogado: true }, { optOutContato: true }, { categoriaHabilitada: false }, { empresaHabilitada: false }, { registroAtivo: false }]);
        if (rnd() < 0.05) falhaReserva.add(j.id); if (rnd() < 0.05) falhaEstado.add(j.id); if (rnd() < 0.05) falhaFinalizar.add(j.id); if (rnd() < 0.03) falhaAvaliar.add(j.id);
      }
      const modo = pick(["ok", "ok", "pre", "incerto"]);
      const w = pipeline({ semanticaTeto: pick(["consolidada", "cada"]), teto: 1 + Math.floor(rnd() * 4), estados, falhaReserva, falhaEstado, falhaFinalizar, falhaAvaliar,
        falhaEnvio: modo === "ok" ? null : (p) => (p.ids[0] > "m5" ? (modo === "pre" ? Object.assign(new Error("x"), { preEnvio: true }) : new Error("y")) : null) });
      const r = await roda(w, jobs, { maxCaracteres: pick([500, 1500, 3500]) });
      const individuais = new Set(r.individuais.map((j) => j.id));
      for (const j of jobs) {
        const emDestinos = r.destinos.has(j.id); const emInd = individuais.has(j.id);
        // devolvido por estado indisponível está nos dois (destino + individuais): conta como UM desfecho (volta ao fluxo individual)
        assert.ok(emDestinos || emInd, `seed ${seed}: ${j.id} sem desfecho`);
        if (emDestinos && emInd) assert.equal(r.destinos.get(j.id).destino, DESTINO.DEVOLVIDO_AO_FLUXO_INDIVIDUAL, `seed ${seed}: ${j.id} em dois desfechos`);
      }
      const ids = w.enviados.flatMap((e) => e.ids);
      assert.equal(new Set(ids).size, ids.length, `seed ${seed}: componente em mais de uma mensagem`);
      assert.equal(new Set(w.enviados.map((e) => e.idempotencyKey)).size, w.enviados.length, `seed ${seed}: chave repetida`);
      for (const e of w.enviados) {
        assert.ok(e.texto.length <= 4096);
        for (const id of e.ids) assert.ok(e.texto.includes(conteudoDe(id)), `seed ${seed}: relatório ${id} incompleto`);
      }
      const textoTotal = w.enviados.map((e) => e.texto).join("\n");
      for (const [id, d] of r.destinos) {
        if (d.destino === DESTINO.EXCLUIDO_POR_AUTORIZACAO || d.destino === DESTINO.NAO_RESERVADO || d.destino === DESTINO.TERMINAL_NA_AVALIACAO) assert.ok(!textoTotal.includes(conteudoDe(id)), `seed ${seed}: ${id} (${d.destino}) apareceu num texto`);
        if (d.destino === DESTINO.ENVIADO) assert.ok(ids.includes(id), `seed ${seed}: ${id} ENVIADO sem mensagem`);
      }
    }
  });
});
