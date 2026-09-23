import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatarMensagemPendencia, formatarMensagemCriticaD1, formatarMensagemUltimoLembreteD1 } from "../src/modules/comunicacao/comunicacao.template.js";

// Checkpoint H.4-A.1, item 3 — cobertura do template revisado para o
// primeiro piloto (sem insinuar que o Agente Crescer já responde).
//
// Checkpoint H.4-A.3.2, itens 7-10: removida a contagem "há N dia(s)" (o
// diasPendentes de administrativo.monitores.js conta backlog ANTES do D-1,
// não o próprio D-1 — um gap de 1 dia rendia "há 0 dias"). O texto agora
// cita a DATA de referência e nunca depende de diasPendentes.

describe("formatarMensagemPendencia — Checkpoint H.4-A.3.2 (texto sem 'há N dias')", () => {
  test("data 21/09/2026 convertida para pt-BR, unidade Subway Saci — Matriz", () => {
    const texto = formatarMensagemPendencia({ unidadeNome: "Subway Saci — Matriz", pendenciaMaisAntiga: "2026-09-21" });
    assert.match(texto, /unidade Subway Saci — Matriz possui um lançamento pendente/);
    assert.match(texto, /referente ao dia 21\/09\/2026/);
  });

  test("diasPendentes=0 nunca aparece no texto ('há 0 dias' banido)", () => {
    const texto = formatarMensagemPendencia({ unidadeNome: "Subway Saci — Matriz", diasPendentes: 0, pendenciaMaisAntiga: "2026-09-21" });
    assert.doesNotMatch(texto, /há \d+ dia/);
    assert.match(texto, /referente ao dia 21\/09\/2026/);
  });

  test("diasPendentes=1, diasPendentes=5 e diasPendentes ausente produzem o MESMO texto (a informação principal nunca depende de N)", () => {
    const base = { unidadeNome: "Subway Saci — Matriz", pendenciaMaisAntiga: "2026-09-21" };
    const semN = formatarMensagemPendencia(base);
    const comUm = formatarMensagemPendencia({ ...base, diasPendentes: 1 });
    const comCinco = formatarMensagemPendencia({ ...base, diasPendentes: 5 });
    const comZero = formatarMensagemPendencia({ ...base, diasPendentes: 0 });
    assert.equal(semN, comUm);
    assert.equal(semN, comCinco);
    assert.equal(semN, comZero);
  });

  test("sem pendenciaMaisAntiga: omite a cláusula de data inteira (sem 'referente ao dia' solto)", () => {
    const texto = formatarMensagemPendencia({ unidadeNome: "Subway Saci — Matriz", pendenciaMaisAntiga: null });
    assert.doesNotMatch(texto, /referente ao dia/);
    assert.match(texto, /Crescer com Delivery\. Por favor/);
  });

  test("nome da unidade aparece no texto", () => {
    const texto = formatarMensagemPendencia({ unidadeNome: "Loja Ipiranga", pendenciaMaisAntiga: "2026-09-20" });
    assert.match(texto, /unidade Loja Ipiranga possui/);
  });

  test("unidadeNome ausente/null: usa travessão, nunca 'undefined' ou 'null' no texto", () => {
    const texto = formatarMensagemPendencia({ unidadeNome: null, pendenciaMaisAntiga: undefined });
    assert.doesNotMatch(texto, /undefined/);
    assert.doesNotMatch(texto, /null/);
    assert.match(texto, /unidade — possui/);
  });

  test("texto final não insinua continuidade de conversa (H.4-A.1, item 2) e traz CTA + assinatura", () => {
    const texto = formatarMensagemPendencia({ unidadeNome: "Loja Centro", pendenciaMaisAntiga: "2026-09-21" });
    assert.doesNotMatch(texto, /posso te mostrar/);
    assert.match(texto, /Por favor, acesse o sistema para verificar e regularizar a pendência\./);
    assert.match(texto, /— Crescer com Delivery$/);
  });

  test("preview e pipeline usam a MESMA função — mesma entrada produz exatamente o mesmo texto", () => {
    const entrada = { unidadeNome: "Loja Centro", pendenciaMaisAntiga: "2026-09-18" };
    const textoPipeline = formatarMensagemPendencia(entrada);
    const textoPreview = formatarMensagemPendencia({ ...entrada });
    assert.equal(textoPreview, textoPipeline);
  });
});

describe("formatarMensagemCriticaD1 — Checkpoint H.4-A.4, item 11 (ESTÁGIO 1)", () => {
  test("texto traz nome da unidade, data e tom de urgência real", () => {
    const texto = formatarMensagemCriticaD1({ unidadeNome: "Subway Saci — Matriz", pendenciaMaisAntiga: "2026-09-21" });
    assert.match(texto, /unidade Subway Saci — Matriz ainda possui o lançamento referente ao dia 21\/09\/2026 pendente/);
    assert.match(texto, /precisa ser regularizado hoje para evitar a perda da possibilidade de preenchimento desse período/);
  });

  test("nunca menciona Agente Crescer / resposta automática / 'posso te ajudar'", () => {
    const texto = formatarMensagemCriticaD1({ unidadeNome: "Loja X", pendenciaMaisAntiga: "2026-09-21" });
    assert.doesNotMatch(texto, /agente crescer|posso te (ajudar|mostrar)|responder automaticamente/i);
  });

  test("é semanticamente distinto do lembrete normal (texto diferente, não é o mesmo template reaproveitado por engano)", () => {
    const normal = formatarMensagemPendencia({ unidadeNome: "Loja X", pendenciaMaisAntiga: "2026-09-21" });
    const critico = formatarMensagemCriticaD1({ unidadeNome: "Loja X", pendenciaMaisAntiga: "2026-09-21" });
    assert.notEqual(normal, critico);
  });

  test("sem data: omite a cláusula, nunca 'undefined'/'null', unidade ausente usa travessão", () => {
    const texto = formatarMensagemCriticaD1({ unidadeNome: null, pendenciaMaisAntiga: null });
    assert.doesNotMatch(texto, /undefined|null/);
    assert.match(texto, /unidade — ainda possui o lançamento pendente/);
  });
});

describe("formatarMensagemUltimoLembreteD1 — Checkpoint H.4-A.4, item 12 (ESTÁGIO FINAL)", () => {
  test("texto traz nome da unidade e data, nunca diz 'última chance'", () => {
    const texto = formatarMensagemUltimoLembreteD1({ unidadeNome: "Subway Saci — Matriz", pendenciaMaisAntiga: "2026-09-21" });
    assert.match(texto, /Último lembrete de hoje: o lançamento da unidade Subway Saci — Matriz referente ao dia 21\/09\/2026 continua pendente/);
    assert.doesNotMatch(texto, /última chance/i);
  });

  test("nunca menciona Agente Crescer / resposta automática", () => {
    const texto = formatarMensagemUltimoLembreteD1({ unidadeNome: "Loja X", pendenciaMaisAntiga: "2026-09-21" });
    assert.doesNotMatch(texto, /agente crescer|posso te (ajudar|mostrar)|responder automaticamente/i);
  });

  test("distinto do template normal e do crítico estágio 1", () => {
    const normal = formatarMensagemPendencia({ unidadeNome: "Loja X", pendenciaMaisAntiga: "2026-09-21" });
    const critico1 = formatarMensagemCriticaD1({ unidadeNome: "Loja X", pendenciaMaisAntiga: "2026-09-21" });
    const final = formatarMensagemUltimoLembreteD1({ unidadeNome: "Loja X", pendenciaMaisAntiga: "2026-09-21" });
    assert.notEqual(final, normal);
    assert.notEqual(final, critico1);
  });

  test("sem data: omite a cláusula graciosamente, nunca 'undefined'/'null'", () => {
    const texto = formatarMensagemUltimoLembreteD1({ unidadeNome: "Loja X", pendenciaMaisAntiga: null });
    assert.doesNotMatch(texto, /undefined|null/);
  });
});
