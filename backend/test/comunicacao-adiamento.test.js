// D.3-D — ADIAMENTO com HORÁRIO REAL (comunicacao.adiamento.js), função PURA: relógio FIXO em UTC,
// nenhum teste depende do horário atual nem do fuso da máquina.
// Janela padrão da suíte: seg–sex 08:00–18:00, sáb 08:00–13:00, dom fechado (a global do banco).
// Rodar: node --test test/comunicacao-adiamento.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  calcularDisponivelEm, chaveDeJitter, MOTIVO_DA_RESERVA,
  ADIAMENTO_MINIMO_MS, ESPERA_CONFIG_INVALIDA_MS, ESPERA_RATE_LIMIT_MINUTO_MS,
} from "../src/modules/comunicacao/comunicacao.adiamento.js";
import { MOTIVOS_BLOQUEIO } from "../src/modules/comunicacao/comunicacao.constants.js";

const MIN = 60_000;
const JANELAS = { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: { inicio: "08:00", fim: "13:00" }, dom: null };
// Janela PRÓPRIA da organização do exemplo do pedido: segunda a sexta 08–18 (sem sábado/domingo).
const SEG_SEX = { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: null, dom: null };
const FORTALEZA = "America/Fortaleza"; // UTC-3, sem DST
const NY = "America/New_York";          // com DST
const chave = (n = "a") => chaveDeJitter({ idempotencyKey: `wa:alerta:${n}:v1`, dataLogica: "2026-09-10", organizacaoId: "org-1" });
const adiar = (over) => calcularDisponivelEm({ adiamentoMs: 15 * MIN, timezone: FORTALEZA, janelas: JANELAS, chave: chave(), ...over });
const z = (iso) => new Date(iso);
/** o instante está em [inicio, inicio+spread)? (jitter sempre para a frente, dentro da janela) */
const naFaixa = (d, inicioIso, spreadMs = 30 * MIN) => d.getTime() >= z(inicioIso).getTime() && d.getTime() < z(inicioIso).getTime() + spreadMs;

describe("próximo instante permitido — janela comercial no timezone da ORGANIZAÇÃO", () => {
  test("janela seg–sex 08–18 (exemplo do pedido): sexta 18:30 locais -> segunda 08:00 LOCAL (11:00Z) + jitter, nunca sábado/domingo", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, janelas: SEG_SEX, agora: z("2026-09-18T21:30:00Z") });
    assert.ok(naFaixa(r, "2026-09-21T11:00:00Z"), r.toISOString());
  });

  test("janela GLOBAL (com sábado 08–13): sexta 18:30 locais -> SÁBADO 08:00 local (11:00Z) + jitter", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, agora: z("2026-09-18T21:30:00Z") });
    assert.ok(naFaixa(r, "2026-09-19T11:00:00Z"), r.toISOString());
  });

  test("segunda ANTES da abertura (06:00 locais) -> segunda 08:00 local (+ jitter), no mesmo dia", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, agora: z("2026-09-21T09:00:00Z") });
    assert.ok(naFaixa(r, "2026-09-21T11:00:00Z"), r.toISOString());
  });

  test("sábado depois do fechamento (13:00 local) -> segunda 08:00 (domingo fechado é pulado)", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, agora: z("2026-09-19T16:30:00Z") }); // sáb 13:30 local
    assert.ok(naFaixa(r, "2026-09-21T11:00:00Z"), r.toISOString());
  });

  test("domingo -> segunda 08:00 local", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, agora: z("2026-09-20T13:00:00Z") });
    assert.ok(naFaixa(r, "2026-09-21T11:00:00Z"), r.toISOString());
  });

  test("sábado dentro da janela curta (08–13) volta na própria janela; sexta 17:50 + 15min cruza o fechamento -> sábado (global) / segunda (seg–sex)", () => {
    const sab = adiar({ motivo: MOTIVOS_BLOQUEIO.PROVIDER_OFFLINE, agora: z("2026-09-19T14:00:00Z") }); // sáb 11:00 local +15
    assert.equal(sab.toISOString(), "2026-09-19T14:15:00.000Z");
    const sexGlobal = adiar({ motivo: MOTIVOS_BLOQUEIO.PROVIDER_OFFLINE, agora: z("2026-09-18T20:50:00Z") }); // sex 17:50 local +15 = 18:05
    assert.ok(naFaixa(sexGlobal, "2026-09-19T11:00:00Z"), sexGlobal.toISOString());
    const sexSeg = adiar({ motivo: MOTIVOS_BLOQUEIO.PROVIDER_OFFLINE, janelas: SEG_SEX, agora: z("2026-09-18T20:50:00Z") });
    assert.ok(naFaixa(sexSeg, "2026-09-21T11:00:00Z"), sexSeg.toISOString());
  });

  test("VIRADA de dia: dia UTC != dia local. Domingo 23:00 local (= segunda 02:00Z) -> segunda 08:00 LOCAL (11:00Z), não 08:00Z", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, agora: z("2026-09-21T02:00:00Z") });
    assert.ok(r.getTime() >= z("2026-09-21T11:00:00Z").getTime(), `${r.toISOString()} caiu antes da abertura LOCAL (usou a hora UTC/do servidor?)`);
    assert.ok(naFaixa(r, "2026-09-21T11:00:00Z"));
    // quarta 23:30 local (= quinta 02:30Z) -> quinta 08:00 local
    const q = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, agora: z("2026-09-17T02:30:00Z") });
    assert.ok(naFaixa(q, "2026-09-17T11:00:00Z"), q.toISOString());
  });

  test("DENTRO da janela: motivo transitório sem horário próprio -> agora + espera, EXATO (sem jitter)", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.PROVIDER_OFFLINE, agora: z("2026-09-16T13:00:00Z") }); // qua 10:00 local
    assert.equal(r.toISOString(), "2026-09-16T13:15:00.000Z");
    assert.equal(adiar({ motivo: MOTIVOS_BLOQUEIO.COOLDOWN, agora: z("2026-09-16T13:00:00Z"), adiamentoMs: 40 * MIN }).toISOString(), "2026-09-16T13:40:00.000Z");
  });
});

describe("DST — sempre pelas regras IANA do runtime, nunca offset manual", () => {
  test("America/New_York, virada de PRIMAVERA (DST começa dom 08/03/2026): sexta 06/03 18:30 EST -> segunda 09/03 08:00 EDT = 12:00Z (não 13:00Z)", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, timezone: NY, janelas: SEG_SEX, agora: z("2026-03-06T23:30:00Z") });
    assert.ok(naFaixa(r, "2026-03-09T12:00:00Z"), r.toISOString());
  });

  test("America/New_York, volta de OUTONO (DST termina dom 01/11/2026): sexta 30/10 18:30 EDT -> segunda 02/11 08:00 EST = 13:00Z (não 12:00Z)", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, timezone: NY, janelas: SEG_SEX, agora: z("2026-10-30T22:30:00Z") });
    assert.ok(naFaixa(r, "2026-11-02T13:00:00Z"), r.toISOString());
  });

  test("timezone SEM DST (Fortaleza) tem o MESMO offset em janeiro e julho; New_York muda", () => {
    const jan = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, agora: z("2026-01-04T13:00:00Z") }); // dom
    const jul = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, agora: z("2026-07-05T13:00:00Z") }); // dom
    assert.ok(naFaixa(jan, "2026-01-05T11:00:00Z"), jan.toISOString());
    assert.ok(naFaixa(jul, "2026-07-06T11:00:00Z"), jul.toISOString());
    const nyJan = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, timezone: NY, agora: z("2026-01-04T13:00:00Z") });
    const nyJul = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, timezone: NY, agora: z("2026-07-05T13:00:00Z") });
    assert.ok(naFaixa(nyJan, "2026-01-05T13:00:00Z"), nyJan.toISOString()); // EST
    assert.ok(naFaixa(nyJul, "2026-07-06T12:00:00Z"), nyJul.toISOString()); // EDT
  });
});

describe("JITTER determinístico e limitado pela janela", () => {
  const agora = z("2026-09-20T13:00:00Z"); // domingo -> abertura de segunda
  const ofKey = (n, over = {}) => adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, agora, chave: chave(n), ...over }).getTime();

  test("mesma mensagem (mesma chave) -> SEMPRE o mesmo instante, em 200 reavaliações", () => {
    const primeiro = ofKey("evento-1");
    for (let i = 0; i < 200; i++) assert.equal(ofKey("evento-1"), primeiro);
  });

  test("chaves diferentes espalham os envios da abertura (não caem todos às 08:00 em ponto)", () => {
    const offsets = new Set();
    for (let i = 0; i < 60; i++) offsets.add(ofKey(`evento-${i}`) - z("2026-09-21T11:00:00Z").getTime());
    assert.ok(offsets.size >= 40, `só ${offsets.size} offsets distintos em 60 chaves`);
    for (const o of offsets) assert.ok(o >= 0 && o < 30 * MIN, `offset ${o} fora de [0, 30min)`);
  });

  test("a chave inclui organização e data lógica: mesma idempotency_key em outra organização/dia dá outro offset", () => {
    const base = chaveDeJitter({ idempotencyKey: "wa:alerta:X:v1", dataLogica: "2026-09-10", organizacaoId: "org-1" });
    assert.notEqual(base, chaveDeJitter({ idempotencyKey: "wa:alerta:X:v1", dataLogica: "2026-09-10", organizacaoId: "org-2" }));
    assert.notEqual(base, chaveDeJitter({ idempotencyKey: "wa:alerta:X:v1", dataLogica: "2026-09-11", organizacaoId: "org-1" }));
    assert.equal(base, chaveDeJitter({ idempotencyKey: "wa:alerta:X:v1", dataLogica: "2026-09-10", organizacaoId: "org-1" }));
  });

  test("o jitter NUNCA passa do fechamento: janela de 10 minutos + spread de 30 -> sempre dentro de [08:00, 08:10)", () => {
    const curta = { seg_sex: { inicio: "08:00", fim: "08:10" }, sab: null, dom: null };
    for (let i = 0; i < 300; i++) {
      const r = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, janelas: curta, agora, chave: chave(`k-${i}`) });
      assert.ok(r.getTime() >= z("2026-09-21T11:00:00Z").getTime() && r.getTime() < z("2026-09-21T11:10:00Z").getTime(), r.toISOString());
    }
  });

  test("teto de jitter configurável (jitterMaxMs) é respeitado", () => {
    for (let i = 0; i < 100; i++) {
      const r = adiar({ motivo: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW, agora, chave: chave(`t-${i}`), jitterMaxMs: 5 * MIN });
      assert.ok(naFaixa(r, "2026-09-21T11:00:00Z", 5 * MIN), r.toISOString());
    }
  });

  test("nenhum Math.random() no cálculo de horário/adiamento (auditável e reproduzível)", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "modules", "comunicacao");
    for (const f of ["comunicacao.adiamento.js", "comunicacao.horario.js"]) {
      const codigo = readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      assert.ok(!/Math\.random|crypto\.random|randomUUID|Date\.now\(|new Date\(\)/.test(codigo), `${f} lê o relógio ou sorteia`);
    }
  });
});

describe("cada motivo transitório calcula o seu próprio horário", () => {
  test("EMPRESA_PAUSADA: volta em `pausado_ate` (sábado 12:00 local, dentro da janela -> instante exato)", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.EMPRESA_PAUSADA, agora: z("2026-09-16T13:00:00Z"), pausadoAte: z("2026-09-19T15:00:00Z") });
    assert.equal(r.toISOString(), "2026-09-19T15:00:00.000Z");
  });

  test("EMPRESA_PAUSADA: pausa que termina FORA da janela (sexta 18:30 local) -> abertura da segunda + jitter", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.EMPRESA_PAUSADA, agora: z("2026-09-16T13:00:00Z"), pausadoAte: z("2026-09-18T21:30:00Z"), janelas: SEG_SEX });
    assert.ok(naFaixa(r, "2026-09-21T11:00:00Z"), r.toISOString());
  });

  test("EMPRESA_PAUSADA com pausa já vencida/ausente cai na espera padrão (nunca no passado)", () => {
    const agora = z("2026-09-16T13:00:00Z");
    for (const pausadoAte of [z("2026-09-16T12:00:00Z"), null]) {
      const r = adiar({ motivo: MOTIVOS_BLOQUEIO.EMPRESA_PAUSADA, agora, pausadoAte });
      assert.equal(r.toISOString(), "2026-09-16T13:15:00.000Z");
    }
  });

  test("RATE_LIMIT por DIA: só depois de zerar a cota (00:00 do PRÓXIMO dia local) -> abertura de quinta + jitter", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.RATE_LIMIT, ratePorDia: true, agora: z("2026-09-16T13:00:00Z") });
    assert.ok(naFaixa(r, "2026-09-17T11:00:00Z"), r.toISOString());
    // pela virada local, não UTC: quarta 22:00 local (= quinta 01:00Z) zera à 00:00 de QUINTA local (03:00Z)
    const virada = adiar({ motivo: MOTIVOS_BLOQUEIO.RATE_LIMIT, ratePorDia: true, agora: z("2026-09-17T01:00:00Z") });
    assert.ok(virada.getTime() >= z("2026-09-17T03:00:00Z").getTime());
    assert.ok(naFaixa(virada, "2026-09-17T11:00:00Z"), virada.toISOString());
  });

  test("RATE_LIMIT por MINUTO: espera curta (a taxa esvazia sozinha), dentro da janela", () => {
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.RATE_LIMIT, ratePorDia: false, agora: z("2026-09-16T13:00:00Z") });
    assert.equal(r.getTime() - z("2026-09-16T13:00:00Z").getTime(), ESPERA_RATE_LIMIT_MINUTO_MS);
  });

  test("CONFIG_INVALIDA / timezone inválido/ausente / janelas ausentes: espera LONGA e fixa — nunca UTC assumido", () => {
    const agora = z("2026-09-16T13:00:00Z");
    for (const over of [{ timezone: null }, { timezone: "Mars/Olympus" }, { timezone: "-03:00" }, { janelas: null }, { janelas: { seg_sex: null, sab: null, dom: null } }]) {
      const r = adiar({ motivo: MOTIVOS_BLOQUEIO.CONFIG_INVALIDA, agora, ...over });
      assert.equal(r.getTime() - agora.getTime(), ESPERA_CONFIG_INVALIDA_MS, JSON.stringify(over));
    }
    // motivo qualquer sem horário confiável: usa só a espera pedida (sem inventar janela)
    const r = adiar({ motivo: MOTIVOS_BLOQUEIO.PROVIDER_OFFLINE, agora, timezone: null });
    assert.equal(r.getTime() - agora.getTime(), 15 * MIN);
  });

  test("NUNCA antes de agora + 1 min (o banco impõe o mesmo mínimo), mesmo com espera 0/negativa", () => {
    const agora = z("2026-09-16T13:00:00Z");
    for (const adiamentoMs of [0, -5000, 1]) {
      const r = adiar({ motivo: MOTIVOS_BLOQUEIO.PROVIDER_OFFLINE, agora, adiamentoMs });
      assert.ok(r.getTime() >= agora.getTime() + ADIAMENTO_MINIMO_MS, `${adiamentoMs} -> ${r.toISOString()}`);
    }
  });

  test("resultado da RESERVA atômica mapeia para o vocabulário de bloqueio da política", () => {
    assert.equal(MOTIVO_DA_RESERVA.COOLDOWN, MOTIVOS_BLOQUEIO.COOLDOWN);
    assert.equal(MOTIVO_DA_RESERVA.RATE_LIMIT_DIA, MOTIVOS_BLOQUEIO.RATE_LIMIT);
    assert.equal(MOTIVO_DA_RESERVA.RATE_LIMIT_MINUTO, MOTIVOS_BLOQUEIO.RATE_LIMIT);
    assert.equal(MOTIVO_DA_RESERVA.RATE_LIMIT_MINUTO_ORGANIZACAO, MOTIVOS_BLOQUEIO.RATE_LIMIT, "a camada por organização também adia (transitório)");
    assert.equal(Object.keys(MOTIVO_DA_RESERVA).length, 4);
    // todo resultado de bloqueio da RPC (exceto INICIADO/POSSE_PERDIDA/EXPIRADA, tratados à parte) precisa de motivo mapeado
    for (const resultado of ["COOLDOWN", "RATE_LIMIT_DIA", "RATE_LIMIT_MINUTO", "RATE_LIMIT_MINUTO_ORGANIZACAO"]) assert.ok(MOTIVO_DA_RESERVA[resultado], `${resultado} sem motivo`);
    assert.throws(() => { MOTIVO_DA_RESERVA.OUTRO = "x"; }, TypeError, "o mapa é congelado");
  });
});
