// JANELA CRÍTICA D-1 — Checkpoint H.4-A.4, itens 24-25. Testes determinísticos
// com relógio injetado (Date fixo passado como parâmetro — nenhuma função
// aqui lê o relógio real). Cobre a matriz de horários pedida em pelo menos
// dois timezones IANA. PURO — sem rede, sem banco.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dentroDaJanelaLocal } from "../src/modules/comunicacao/comunicacao.horario.js";
import {
  ESTAGIO_CRITICO, CUTOFF_CRITICO, estagioCriticoElegivel, estagioCriticoAtual,
  depoisDoCutoffCritico, proximoInstanteCritico,
} from "../src/modules/comunicacao/comunicacao.horarioCritico.js";

const JANELA_NORMAL = { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: { inicio: "08:00", fim: "13:00" }, dom: null };

// 22/09/2026 é terça-feira. Horários locais construídos via offset fixo
// verificável (America/Sao_Paulo e America/Manaus são UTC-3/UTC-4 SEM DST —
// ver comunicacao.horario.js: nunca aritmética manual de offset em produção,
// mas aqui, no teste, construir o instante UTC a partir de um offset FIXO e
// conhecido é a forma mais direta de fixar "19:30 local" sem depender de
// nenhuma lib de calendário — a função testada é que faz a conversão real).
const SP = "America/Sao_Paulo";   // UTC-3
const MANAUS = "America/Manaus";  // UTC-4
const utcSP = (hLocal, m = 0) => new Date(Date.UTC(2026, 8, 22, hLocal + 3, m));
const utcManaus = (hLocal, m = 0) => new Date(Date.UTC(2026, 8, 22, hLocal + 4, m));

for (const [tz, utc, nome] of [[SP, utcSP, "America/Sao_Paulo"], [MANAUS, utcManaus, "America/Manaus"]]) {
  describe(`Matriz de horários — ${nome} (item 24-25)`, () => {
    test("17:59 -> política normal (dentro da janela comercial)", () => {
      assert.equal(dentroDaJanelaLocal(utc(17, 59), tz, JANELA_NORMAL), true);
      assert.equal(estagioCriticoAtual(utc(17, 59), tz), null);
    });

    test("18:01 -> normal fechado; crítico ainda não disparável", () => {
      assert.equal(dentroDaJanelaLocal(utc(18, 1), tz, JANELA_NORMAL), false);
      assert.equal(estagioCriticoAtual(utc(18, 1), tz), null);
    });

    test("19:30-20:00 -> CRITICO_1 elegível (início inclusivo, fim exclusivo)", () => {
      assert.equal(estagioCriticoElegivel(utc(19, 30), tz, ESTAGIO_CRITICO.CRITICO_1), true);
      assert.equal(estagioCriticoElegivel(utc(19, 59), tz, ESTAGIO_CRITICO.CRITICO_1), true);
      assert.equal(estagioCriticoElegivel(utc(20, 0), tz, ESTAGIO_CRITICO.CRITICO_1), false);
      assert.equal(estagioCriticoAtual(utc(19, 45), tz), ESTAGIO_CRITICO.CRITICO_1);
    });

    test("21:00 -> nenhum novo estágio (fora de ambas as faixas)", () => {
      assert.equal(estagioCriticoAtual(utc(21, 0), tz), null);
    });

    test("22:15-22:45 -> CRITICO_FINAL elegível (início inclusivo, fim exclusivo)", () => {
      assert.equal(estagioCriticoElegivel(utc(22, 15), tz, ESTAGIO_CRITICO.CRITICO_FINAL), true);
      assert.equal(estagioCriticoElegivel(utc(22, 44), tz, ESTAGIO_CRITICO.CRITICO_FINAL), true);
      assert.equal(estagioCriticoElegivel(utc(22, 45), tz, ESTAGIO_CRITICO.CRITICO_FINAL), false);
      assert.equal(estagioCriticoAtual(utc(22, 30), tz), ESTAGIO_CRITICO.CRITICO_FINAL);
    });

    test("23:31 -> depois do cutoff, nenhum envio novo", () => {
      assert.equal(depoisDoCutoffCritico(utc(23, 31), tz), true);
      assert.equal(estagioCriticoAtual(utc(23, 31), tz), null);
    });

    test("23:29 -> ainda antes do cutoff (limite exato, item 8)", () => {
      assert.equal(depoisDoCutoffCritico(utc(23, 29), tz), false);
      assert.equal(depoisDoCutoffCritico(utc(23, 30), tz), true, "cutoff é inclusivo — às 23:30 já não se agenda mais");
    });

    test("00:01 do dia seguinte -> nenhum estágio ativo (a regra crítica do dia anterior encerrou)", () => {
      const proximoDia = new Date(utc(0, 1).getTime() + 24 * 60 * 60 * 1000);
      assert.equal(estagioCriticoAtual(proximoDia, tz), null);
      assert.equal(depoisDoCutoffCritico(proximoDia, tz), false);
    });
  });
}

describe("proximoInstanteCritico — jitter limitado pela PRÓPRIA faixa (item 9)", () => {
  test("já dentro da faixa -> instante calculado nunca ultrapassa o fim da faixa (nem no limite do jitter)", () => {
    const chave = "alerta-x|2026-09-21|org-1";
    const instante = proximoInstanteCritico(utcSP(19, 30), SP, ESTAGIO_CRITICO.CRITICO_1, chave);
    assert.ok(instante instanceof Date);
    assert.ok(estagioCriticoElegivel(instante, SP, ESTAGIO_CRITICO.CRITICO_1), "o instante calculado precisa continuar dentro da própria faixa");
  });

  test("antes da faixa abrir -> calcula a partir da ABERTURA da faixa (nunca antes)", () => {
    const chave = "alerta-y|2026-09-21|org-1";
    const instante = proximoInstanteCritico(utcSP(10, 0), SP, ESTAGIO_CRITICO.CRITICO_1, chave);
    assert.ok(estagioCriticoElegivel(instante, SP, ESTAGIO_CRITICO.CRITICO_1));
  });

  test("faixa de hoje já fechou -> null (nunca agenda para o dia seguinte — cada estágio é do seu próprio dia)", () => {
    const chave = "alerta-z|2026-09-21|org-1";
    assert.equal(proximoInstanteCritico(utcSP(20, 30), SP, ESTAGIO_CRITICO.CRITICO_1, chave), null);
    assert.equal(proximoInstanteCritico(utcSP(23, 0), SP, ESTAGIO_CRITICO.CRITICO_FINAL, chave), null);
  });

  test("determinístico: mesma chave -> mesmo instante, sempre", () => {
    const chave = "alerta-w|2026-09-21|org-1";
    const a = proximoInstanteCritico(utcSP(19, 30), SP, ESTAGIO_CRITICO.CRITICO_1, chave);
    const b = proximoInstanteCritico(utcSP(19, 30), SP, ESTAGIO_CRITICO.CRITICO_1, chave);
    assert.equal(a.getTime(), b.getTime());
  });

  test("chaves diferentes -> instantes plausivelmente diferentes (espalhamento, nunca todos no mesmo minuto)", () => {
    const instantes = new Set();
    for (let i = 0; i < 8; i++) {
      instantes.add(proximoInstanteCritico(utcSP(19, 30), SP, ESTAGIO_CRITICO.CRITICO_1, `alerta-${i}|2026-09-21|org-1`).getTime());
    }
    assert.ok(instantes.size > 1, "chaves diferentes devem produzir horários diferentes na maioria dos casos");
  });

  test("estágio desconhecido -> null, nunca lança", () => {
    assert.equal(proximoInstanteCritico(utcSP(19, 30), SP, "estagio-invalido", "chave"), null);
  });
});

describe("Documentação viva: cutoff nunca ultrapassado por nenhuma faixa (item 8-9)", () => {
  test("ambas as faixas terminam antes do cutoff", () => {
    const fimCritico1 = 20 * 60 + 0;
    const fimCriticoFinal = 22 * 60 + 45;
    const cutoff = CUTOFF_CRITICO.hora * 60 + CUTOFF_CRITICO.minuto;
    assert.ok(fimCritico1 < cutoff);
    assert.ok(fimCriticoFinal < cutoff);
  });
});
