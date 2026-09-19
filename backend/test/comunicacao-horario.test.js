// D.3-D — horário por organização (timezone IANA, janela local, próximo instante permitido, DST, jitter).
// Funções PURAS: relógio sempre FIXO (nenhum teste depende do horário atual nem do fuso da máquina).
// Rodar: node --test test/comunicacao-horario.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  timezoneValido, partesLocais, instanteDeLocal, janelasValidas, dentroDaJanelaLocal, proximoInstantePermitido,
  fimDaJanelaLocal, inicioDoDiaLocal, inicioDoProximoDiaLocal, aplicarJitterNaJanela, proximoHorarioDeEnvio,
  inteiroDeterministico, ConfiguracaoHorarioInvalida,
} from "../src/modules/comunicacao/comunicacao.horario.js";

const FOR = "America/Fortaleza"; // UTC-3, sem DST
const NY = "America/New_York";   // com DST
const SP = "America/Sao_Paulo";
const JANELAS = { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: { inicio: "08:00", fim: "13:00" }, dom: null };
const z = (iso) => new Date(iso);
const iso = (d) => d.toISOString().replace(".000Z", "Z");
const SEMANA_SO = { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: null, dom: null }; // sem sábado

describe("timezone IANA", () => {
  test("aceita nomes IANA reais", () => {
    for (const tz of [FOR, NY, SP, "UTC", "Europe/London", "Asia/Kolkata"]) assert.equal(timezoneValido(tz), true, tz);
  });
  test("recusa offsets, lixo e vazio — nunca assume UTC em silêncio", () => {
    for (const tz of ["-03:00", "+03:00", "UTC+3", "GMT-3", "Mars/Base", "", "   ", null, undefined, 3, {}, "America/Fortaleza; drop"]) {
      assert.equal(timezoneValido(tz), false, String(tz));
    }
  });
  test("recusa aliases de offset fixo (EST/GMT/Etc/GMT+3): exige Região/Cidade ou UTC", () => {
    for (const tz of ["EST", "MST", "HST", "GMT", "Etc/GMT+3", "etc/gmt-3"]) assert.equal(timezoneValido(tz), false, tz);
    assert.equal(timezoneValido("America/Fortaleza"), true);
    assert.equal(timezoneValido("UTC"), true);
  });
  test("qualquer função de horário com timezone inválido LANÇA CONFIG_INVALIDA (fail-closed)", () => {
    for (const tz of ["-03:00", "Mars/Base", null]) {
      assert.throws(() => proximoInstantePermitido(z("2026-09-16T13:00:00Z"), tz, JANELAS), (e) => e instanceof ConfiguracaoHorarioInvalida && e.codigo === "CONFIG_INVALIDA");
      assert.throws(() => dentroDaJanelaLocal(z("2026-09-16T13:00:00Z"), tz, JANELAS), ConfiguracaoHorarioInvalida);
      assert.throws(() => partesLocais(z("2026-09-16T13:00:00Z"), tz), ConfiguracaoHorarioInvalida);
    }
  });
});

describe("janelas", () => {
  test("janelasValidas", () => {
    assert.equal(janelasValidas(JANELAS), true);
    assert.equal(janelasValidas({ dom: { inicio: "02:30", fim: "05:00" } }), true, "basta um dia aberto");
    for (const j of [null, undefined, {}, [], "x", { seg_sex: null, sab: null, dom: null }, { seg_sex: { inicio: "18:00", fim: "08:00" } },
      { seg_sex: { inicio: "08:00", fim: "08:00" } }, { seg_sex: { inicio: "8:00", fim: "18:00" } }, { seg_sex: { inicio: "08:00" } }, { seg_sex: { inicio: "25:00", fim: "26:00" } }]) {
      assert.equal(janelasValidas(j), false, JSON.stringify(j));
    }
  });
  test("janela inválida lança CONFIG_INVALIDA", () => {
    assert.throws(() => dentroDaJanelaLocal(z("2026-09-16T13:00:00Z"), FOR, {}), ConfiguracaoHorarioInvalida);
    assert.throws(() => proximoInstantePermitido(z("2026-09-16T13:00:00Z"), FOR, { seg_sex: { inicio: "18:00", fim: "08:00" } }), ConfiguracaoHorarioInvalida);
  });
});

describe("dentro / fora da janela (horário LOCAL da organização)", () => {
  // Fortaleza = UTC-3.  quarta 2026-09-16, sábado 19, domingo 20, segunda 21.
  const casos = [
    ["antes da abertura (07:59 local, quarta)", "2026-09-16T10:59:00Z", false],
    ["na abertura (08:00 local)", "2026-09-16T11:00:00Z", true],
    ["dentro (10:00 local)", "2026-09-16T13:00:00Z", true],
    ["último minuto (17:59 local)", "2026-09-16T20:59:00Z", true],
    ["fechamento é EXCLUSIVO (18:00 local)", "2026-09-16T21:00:00Z", false],
    ["depois da janela (22:00 local)", "2026-09-17T01:00:00Z", false],
    ["sábado 12:59 (dentro)", "2026-09-19T15:59:00Z", true],
    ["sábado 13:00 (fora)", "2026-09-19T16:00:00Z", false],
    ["sábado à tarde", "2026-09-19T17:00:00Z", false],
    ["domingo, meio do dia", "2026-09-20T13:00:00Z", false],
    ["segunda antes da abertura (07:00 local)", "2026-09-21T10:00:00Z", false],
  ];
  for (const [nome, instante, esperado] of casos) {
    test(`${nome} -> ${esperado}`, () => assert.equal(dentroDaJanelaLocal(z(instante), FOR, JANELAS), esperado));
  }
  test("VIRADA DE DIA: 02:30Z de sábado (UTC) ainda é sexta 23:30 em Fortaleza — a decisão usa o dia LOCAL", () => {
    const i = z("2026-09-19T02:30:00Z");
    assert.equal(i.getUTCDay(), 6, "em UTC já é sábado");
    const p = partesLocais(i, FOR);
    assert.deepEqual([p.ano, p.mes, p.dia, p.hora, p.minuto, p.diaSemana], [2026, 9, 18, 23, 30, 5]);
    assert.equal(dentroDaJanelaLocal(i, FOR, JANELAS), false, "23:30 de sexta está fora");
    // e um instante que em UTC é "domingo cedo" mas em Fortaleza é sábado de manhã DENTRO da janela:
    assert.equal(dentroDaJanelaLocal(z("2026-09-19T11:30:00Z"), FOR, JANELAS), true, "sábado 08:30 local");
  });
  test("o mesmo instante decide diferente em fusos diferentes", () => {
    const i = z("2026-09-16T13:00:00Z"); // 10:00 em Fortaleza, 09:00 em NY (EDT: 09:00), 22:00 em Tóquio
    assert.equal(dentroDaJanelaLocal(i, FOR, JANELAS), true);
    assert.equal(dentroDaJanelaLocal(i, NY, JANELAS), true);
    assert.equal(dentroDaJanelaLocal(i, "Asia/Tokyo", JANELAS), false);
  });
});

describe("próximo instante permitido (adiamento com horário REAL)", () => {
  const casos = [
    ["sexta 18:30 local -> SÁBADO 08:00 (o sábado está aberto)", "2026-09-18T21:30:00Z", "2026-09-19T11:00:00Z"],
    ["sexta 23:30 local (sábado em UTC) -> sábado 08:00 local", "2026-09-19T02:30:00Z", "2026-09-19T11:00:00Z"],
    ["sábado 14:00 -> segunda 08:00", "2026-09-19T17:00:00Z", "2026-09-21T11:00:00Z"],
    ["domingo 10:00 -> segunda 08:00", "2026-09-20T13:00:00Z", "2026-09-21T11:00:00Z"],
    ["segunda 07:00 (antes da abertura) -> segunda 08:00", "2026-09-21T10:00:00Z", "2026-09-21T11:00:00Z"],
    ["quarta 19:00 -> quinta 08:00", "2026-09-16T22:00:00Z", "2026-09-17T11:00:00Z"],
    ["sexta 17:59 (dentro) -> o PRÓPRIO instante", "2026-09-18T20:59:00Z", "2026-09-18T20:59:00Z"],
    ["sábado 12:59 (dentro) -> o PRÓPRIO instante", "2026-09-19T15:59:00Z", "2026-09-19T15:59:00Z"],
    ["sábado 13:00 -> segunda 08:00", "2026-09-19T16:00:00Z", "2026-09-21T11:00:00Z"],
  ];
  for (const [nome, entrada, esperado] of casos) {
    test(nome, () => assert.equal(iso(proximoInstantePermitido(z(entrada), FOR, JANELAS)), esperado));
  }
  test("janela só seg–sex: sexta 18:30 local -> SEGUNDA 08:00 local (exemplo do contrato)", () => {
    assert.equal(iso(proximoInstantePermitido(z("2026-09-18T21:30:00Z"), FOR, SEMANA_SO)), "2026-09-21T11:00:00Z");
    assert.equal(iso(proximoInstantePermitido(z("2026-09-19T02:30:00Z"), FOR, SEMANA_SO)), "2026-09-21T11:00:00Z", "sexta 23:30 local (sábado em UTC)");
    assert.equal(iso(proximoInstantePermitido(z("2026-09-19T17:00:00Z"), FOR, SEMANA_SO)), "2026-09-21T11:00:00Z");
  });
  test("resultado sempre >= entrada e sempre DENTRO da janela (varredura de 14 dias, de 30 em 30 min)", () => {
    for (let t = z("2026-09-14T00:00:00Z").getTime(); t < z("2026-09-28T00:00:00Z").getTime(); t += 30 * 60_000) {
      const r = proximoInstantePermitido(new Date(t), FOR, JANELAS);
      assert.ok(r.getTime() >= t);
      assert.equal(dentroDaJanelaLocal(r, FOR, JANELAS), true, `${new Date(t).toISOString()} -> ${r.toISOString()}`);
    }
  });
  test("nenhuma janela aberta nos próximos dias -> CONFIG_INVALIDA (nunca trava)", () => {
    assert.throws(() => proximoInstantePermitido(z("2026-09-16T13:00:00Z"), FOR, { dom: { inicio: "08:00", fim: "09:00" } }, { limiteDias: 3 }), ConfiguracaoHorarioInvalida);
  });
  test("fimDaJanelaLocal / inicio do dia local / próximo dia local", () => {
    assert.equal(iso(fimDaJanelaLocal(z("2026-09-16T13:00:00Z"), FOR, JANELAS)), "2026-09-16T21:00:00Z");
    assert.equal(fimDaJanelaLocal(z("2026-09-16T22:00:00Z"), FOR, JANELAS), null);
    assert.equal(iso(inicioDoDiaLocal(z("2026-09-19T02:30:00Z"), FOR)), "2026-09-18T03:00:00Z", "00:00 de sexta em Fortaleza");
    assert.equal(iso(inicioDoProximoDiaLocal(z("2026-09-19T02:30:00Z"), FOR)), "2026-09-19T03:00:00Z");
  });
});

describe("DST (timezone IANA, sem cálculo manual de offset)", () => {
  test("NY, salto de primavera (2026-03-08): sexta 19:00 EST -> segunda 08:00 EDT = 12:00Z (offset mudou de -5 para -4)", () => {
    const r = proximoInstantePermitido(z("2026-03-07T00:00:00Z"), NY, SEMANA_SO); // sexta 19:00 EST
    assert.equal(iso(r), "2026-03-09T12:00:00Z");
    assert.equal(partesLocais(r, NY).hora, 8);
  });
  test("NY, volta de outono (2026-11-01): sexta 19:00 EDT -> segunda 08:00 EST = 13:00Z", () => {
    const r = proximoInstantePermitido(z("2026-10-30T23:00:00Z"), NY, SEMANA_SO);
    assert.equal(iso(r), "2026-11-02T13:00:00Z");
    assert.equal(partesLocais(r, NY).hora, 8);
  });
  test("a MESMA hora local (08:00) corresponde a instantes UTC diferentes antes/depois do DST", () => {
    const antes = proximoInstantePermitido(z("2026-03-06T05:00:00Z"), NY, JANELAS); // sexta 00:00 EST
    const depois = proximoInstantePermitido(z("2026-03-10T05:00:00Z"), NY, JANELAS); // terça 01:00 EDT
    assert.equal(iso(antes), "2026-03-06T13:00:00Z");
    assert.equal(iso(depois), "2026-03-10T12:00:00Z");
  });
  test("hora local INEXISTENTE (02:30 no salto de primavera) -> primeiro instante válido depois (03:30 EDT)", () => {
    const j = { dom: { inicio: "02:30", fim: "05:00" } };
    const r = proximoInstantePermitido(z("2026-03-08T04:00:00Z"), NY, j); // sábado 23:00 EST
    assert.equal(iso(r), "2026-03-08T07:30:00Z");
    assert.equal(iso(instanteDeLocal(NY, 2026, 3, 8, 2, 30)), "2026-03-08T07:30:00Z");
  });
  test("hora local REPETIDA (01:30 na volta de outono) -> a PRIMEIRA ocorrência (EDT)", () => {
    const j = { dom: { inicio: "01:30", fim: "05:00" } };
    const r = proximoInstantePermitido(z("2026-11-01T03:00:00Z"), NY, j); // sábado 23:00 EDT
    assert.equal(iso(r), "2026-11-01T05:30:00Z");
  });
  test("Brasil COM DST (regra histórica de 2018): 00:00 de 2018-11-04 em São Paulo não existia -> 01:00 BRST = 03:00Z", () => {
    assert.equal(iso(instanteDeLocal(SP, 2018, 11, 4, 0, 0)), "2018-11-04T03:00:00Z");
    assert.equal(iso(instanteDeLocal(SP, 2018, 11, 3, 12, 0)), "2018-11-03T15:00:00Z", "dia anterior: BRT (UTC-3)");
    assert.equal(iso(instanteDeLocal(SP, 2018, 11, 5, 12, 0)), "2018-11-05T14:00:00Z", "dia seguinte: BRST (UTC-2)");
  });
  test("instanteDeLocal é a inversa de partesLocais (varredura de 2 anos, NY, de 6 em 6 horas)", () => {
    for (let t = z("2026-01-01T00:00:00Z").getTime(); t < z("2028-01-01T00:00:00Z").getTime(); t += 6 * 3600_000) {
      const p = partesLocais(new Date(t), NY);
      const volta = instanteDeLocal(NY, p.ano, p.mes, p.dia, p.hora, p.minuto).getTime();
      const ref = Math.floor(t / 60_000) * 60_000;
      assert.ok(volta === ref || volta === ref - 3600_000, `${new Date(t).toISOString()} -> ${new Date(volta).toISOString()}`); // volta ambígua: 1ª ocorrência
    }
  });
});

describe("jitter DETERMINÍSTICO", () => {
  const ABERTURA = z("2026-09-21T11:00:00Z"); // segunda 08:00 em Fortaleza
  const FECHAMENTO = z("2026-09-21T21:00:00Z");
  test("mesma chave -> mesmo horário, sempre (auditável/reproduzível)", () => {
    const a = aplicarJitterNaJanela(ABERTURA, FOR, JANELAS, "wa:alerta:abc:v1|2026-09-21|org1");
    for (let i = 0; i < 20; i++) assert.equal(aplicarJitterNaJanela(ABERTURA, FOR, JANELAS, "wa:alerta:abc:v1|2026-09-21|org1").getTime(), a.getTime());
  });
  test("chaves diferentes espalham os envios; nunca antes da abertura, nunca além do spread, nunca depois do fechamento", () => {
    const vistos = new Set();
    for (let i = 0; i < 300; i++) {
      const r = aplicarJitterNaJanela(ABERTURA, FOR, JANELAS, `chave-${i}`);
      assert.ok(r.getTime() >= ABERTURA.getTime());
      assert.ok(r.getTime() <= ABERTURA.getTime() + 30 * 60_000);
      assert.ok(r.getTime() < FECHAMENTO.getTime());
      vistos.add(r.getTime());
    }
    assert.ok(vistos.size > 100, `pouca dispersão: ${vistos.size} valores distintos em 300 chaves`);
  });
  test("janela CURTA limita o spread (nunca ultrapassa o fechamento, deixa 1 min de folga)", () => {
    const curta = { seg_sex: { inicio: "08:00", fim: "08:10" } };
    for (let i = 0; i < 200; i++) {
      const r = aplicarJitterNaJanela(ABERTURA, FOR, curta, `k${i}`);
      assert.ok(r.getTime() <= ABERTURA.getTime() + 9 * 60_000, `${i}: ${r.toISOString()}`);
      assert.equal(dentroDaJanelaLocal(r, FOR, curta), true);
    }
  });
  test("perto do fechamento (sem folga) o jitter é ZERO; fora da janela devolve o instante intacto", () => {
    const quaseFim = z("2026-09-21T20:59:30Z");
    assert.equal(aplicarJitterNaJanela(quaseFim, FOR, JANELAS, "x").getTime(), quaseFim.getTime());
    const fora = z("2026-09-20T13:00:00Z");
    assert.equal(aplicarJitterNaJanela(fora, FOR, JANELAS, "x").getTime(), fora.getTime());
  });
  test("proximoHorarioDeEnvio: já dentro da janela -> envia já (sem jitter); fora -> abertura + jitter dentro da janela", () => {
    const dentro = proximoHorarioDeEnvio(z("2026-09-16T13:00:00Z"), FOR, JANELAS, "k");
    assert.equal(dentro.adiado, false);
    assert.equal(iso(dentro.instante), "2026-09-16T13:00:00Z");
    const fora = proximoHorarioDeEnvio(z("2026-09-18T21:30:00Z"), FOR, SEMANA_SO, "k");
    assert.equal(fora.adiado, true);
    assert.ok(fora.instante.getTime() >= z("2026-09-21T11:00:00Z").getTime() && fora.instante.getTime() <= z("2026-09-21T11:30:00Z").getTime());
    assert.equal(dentroDaJanelaLocal(fora.instante, FOR, SEMANA_SO), true);
  });
  test("inteiroDeterministico: estável, dentro do módulo, módulo inválido -> 0", () => {
    assert.equal(inteiroDeterministico("a", 1000), inteiroDeterministico("a", 1000));
    for (let i = 0; i < 100; i++) { const v = inteiroDeterministico(`k${i}`, 7); assert.ok(v >= 0 && v < 7); }
    assert.equal(inteiroDeterministico("a", 0), 0);
    assert.equal(inteiroDeterministico("a", -5), 0);
  });
});

describe("arquitetura estática do módulo de horário", () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "modules", "comunicacao", "comunicacao.horario.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  test("sem aleatoriedade, sem relógio e sem hora local do servidor", () => {
    for (const proibido of [/Math\.random/, /Date\.now\(/, /new Date\(\)/, /\.getHours\(/, /\.getDay\(/, /\.getMinutes\(/, /\.setHours\(/, /getTimezoneOffset/]) {
      assert.doesNotMatch(src, proibido, String(proibido));
    }
  });
});
