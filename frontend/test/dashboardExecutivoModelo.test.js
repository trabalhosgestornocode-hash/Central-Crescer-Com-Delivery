// Helpers PUROS do modelo logístico temporal no Dashboard iFood (dashboardExecutivoModelo.js).
// Sem DOM. Rodar: node --test frontend/test/dashboardExecutivoModelo.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  fmtDiaMes, fmtDataCompleta, linhasSegmentos, avisoDivisaoIndisponivel, modeloDaData,
  textoAplicacaoVigencia, textoDeclaracaoHistorica, vesperaIso, modeloOposto, avisoLancamentoMensalBloqueado,
} from "../src/dashboardExecutivoModelo.js";

// Mesmo formato de backend descreverPeriodo() — setembro/2026, Marketplace 01–12 e Full Service desde 13/09.
const misto = {
  tipo: "misto", misto: true, rotulo: "Operação mista",
  segmentos: [
    { modelo: "marketplace", rotulo: "Marketplace", inicio: "2026-09-01", fim: "2026-09-12", emAberto: false },
    { modelo: "full_service", rotulo: "Full Service", inicio: "2026-09-13", fim: "2026-09-30", emAberto: true },
  ],
  divisaoDisponivel: true, divisaoMotivo: null, divisaoDetalhe: null,
};

describe("linhasSegmentos — 'Marketplace: 01/09 a 12/09 · Full Service: desde 13/09'", () => {
  test("cada regime com o seu intervalo; o último em aberto vira 'desde'", () => {
    assert.deepEqual(linhasSegmentos(misto), ["Marketplace: 01/09 a 12/09", "Full Service: desde 13/09"]);
  });
  test("sem período / sem segmentos: lista vazia", () => {
    assert.deepEqual(linhasSegmentos(null), []);
    assert.deepEqual(linhasSegmentos({ segmentos: [] }), []);
  });
});

describe("modeloDaData — o formulário do dia usa o modelo DAQUELE dia", () => {
  test("10/09 = Marketplace (mostra Entregadores); 14/09 = Full Service (esconde)", () => {
    assert.equal(modeloDaData(misto, "2026-09-10", "misto"), "marketplace");
    assert.equal(modeloDaData(misto, "2026-09-14", "misto"), "full_service");
    assert.equal(modeloDaData(misto, "2026-09-12", "misto"), "marketplace");
    assert.equal(modeloDaData(misto, "2026-09-13", "misto"), "full_service");
  });
  test("mês simples / sem modeloPeriodo: usa o fallback (comportamento anterior)", () => {
    assert.equal(modeloDaData(undefined, "2026-09-10", "full_service"), "full_service");
    const simples = { misto: false, segmentos: [{ modelo: "marketplace", inicio: "2026-08-01", fim: "2026-08-31", emAberto: false }] };
    assert.equal(modeloDaData(simples, "2026-08-15", "x"), "marketplace");
    assert.equal(modeloDaData(simples, "2026-09-15", "fallback"), "fallback");
  });
});

describe("avisoDivisaoIndisponivel", () => {
  test("divisão disponível ou mês simples: sem aviso", () => {
    assert.equal(avisoDivisaoIndisponivel(misto), null);
    assert.equal(avisoDivisaoIndisponivel({ misto: false }), null);
    assert.equal(avisoDivisaoIndisponivel(undefined), null);
  });
  test("sem dado ainda: mensagem própria, sem alarme de inconsistência", () => {
    const a = avisoDivisaoIndisponivel({ ...misto, divisaoDisponivel: false, divisaoMotivo: "sem_dado", divisaoDetalhe: { ultimoValorValido: null } });
    assert.match(a, /Ainda não há dados suficientes/);
    assert.match(a, /Taxas de Entregadores/);
  });
  test("suspeito e não conciliável têm mensagens próprias, com contexto do último valor confiável quando houver", () => {
    const suspeito = avisoDivisaoIndisponivel({
      ...misto, divisaoDisponivel: false, divisaoMotivo: "suspeito",
      divisaoDetalhe: { ultimoValorValido: { valor: 9253, data: "2026-09-17" } },
    });
    assert.match(suspeito, /valor suspeito/);
    assert.match(suspeito, /9\.253,00/);
    assert.match(suspeito, /17\/09\/2026/);
    assert.match(avisoDivisaoIndisponivel({ ...misto, divisaoDisponivel: false, divisaoMotivo: "nao_conciliavel" }), /não pôde ser conciliada/);
  });
  test("os demais indicadores continuam disponíveis — a mensagem nunca diz 'mês inteiro'", () => {
    const a = avisoDivisaoIndisponivel({ ...misto, divisaoDisponivel: false, divisaoMotivo: "suspeito", divisaoDetalhe: {} });
    assert.match(a, /demais indicadores continuam disponíveis/);
  });
});

describe("avisoLancamentoMensalBloqueado — bloqueio preventivo (backend continua sendo a proteção real)", () => {
  test("período misto sem lote ainda: bloqueia com mensagem orientando lançar por dia", () => {
    const a = avisoLancamentoMensalBloqueado(misto, false);
    assert.match(a, /Lançamento mensal indisponível para este período/);
    assert.match(a, /Marketplace e Full Service/);
    assert.match(a, /individualmente/);
  });
  test("período misto MAS já existe lote (só pôde ter sido criado num único regime): não bloqueia", () => {
    assert.equal(avisoLancamentoMensalBloqueado(misto, true), null);
  });
  test("mês simples (não misto): não bloqueia, mesmo sem lote", () => {
    assert.equal(avisoLancamentoMensalBloqueado({ misto: false }, false), null);
    assert.equal(avisoLancamentoMensalBloqueado(undefined, false), null);
  });
});

describe("texto do modal — a alteração nunca é silenciosamente retroativa", () => {
  test("informa a data e que os dados anteriores permanecem no modelo da época", () => {
    const t = textoAplicacaoVigencia("2026-09-13", "2026-09-19");
    assert.match(t, /Esta alteração será aplicada aos dados a partir de 13\/09\/2026\./);
    assert.match(t, /Os dados anteriores permanecerão vinculados ao modelo logístico vigente naquele período\./);
  });
  test("data anterior a hoje avisa que lançamentos já feitos serão relidos; data de hoje não", () => {
    assert.match(textoAplicacaoVigencia("2026-09-13", "2026-09-19"), /anterior a hoje/);
    assert.doesNotMatch(textoAplicacaoVigencia("2026-09-19", "2026-09-19"), /anterior a hoje/);
  });
  test("sem data: pede a data", () => {
    assert.match(textoAplicacaoVigencia("", "2026-09-19"), /Informe a data/);
  });
});

describe("declaração histórica (unidade que já trocou sem data registrada — ex.: Subway Feiraguay)", () => {
  test("Full Service desde 13/09: dados até 12/09 = Marketplace, dali em diante = Full Service", () => {
    const t = textoDeclaracaoHistorica("full_service", "2026-09-13");
    assert.match(t, /até 12\/09\/2026 passarão a ser interpretados como Marketplace/);
    assert.match(t, /a partir de 13\/09\/2026 como Full Service/);
    assert.match(t, /lançamentos não são alterados/);
  });
  test("virada de mês/ano na véspera", () => {
    assert.equal(vesperaIso("2026-10-01"), "2026-09-30");
    assert.equal(vesperaIso("2027-01-01"), "2026-12-31");
    assert.equal(vesperaIso("2026-03-01"), "2026-02-28");
  });
  test("modeloOposto e formatação de datas", () => {
    assert.equal(modeloOposto("marketplace"), "full_service");
    assert.equal(modeloOposto("full_service"), "marketplace");
    assert.equal(fmtDiaMes("2026-09-05"), "05/09");
    assert.equal(fmtDataCompleta("2026-09-05"), "05/09/2026");
    assert.equal(fmtDiaMes(null), "—");
  });
});
