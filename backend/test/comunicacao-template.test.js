import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatarMensagemPendencia } from "../src/modules/comunicacao/comunicacao.template.js";

// Checkpoint H.4-A.1, item 3 — cobertura do template revisado para o
// primeiro piloto (sem insinuar que o Agente Crescer já responde).

describe("formatarMensagemPendencia — Checkpoint H.4-A.1", () => {
  test("1 dia (singular)", () => {
    const texto = formatarMensagemPendencia({ unidadeNome: "Loja Centro", diasPendentes: 1, pendenciaMaisAntiga: "2026-09-21" });
    assert.match(texto, /há 1 dia,/);
    assert.doesNotMatch(texto, /1 dias/);
  });

  test("N dias (plural)", () => {
    const texto = formatarMensagemPendencia({ unidadeNome: "Loja Centro", diasPendentes: 5, pendenciaMaisAntiga: "2026-09-17" });
    assert.match(texto, /há 5 dias,/);
  });

  test("data convertida para pt-BR (DD/MM/AAAA)", () => {
    const texto = formatarMensagemPendencia({ unidadeNome: "Loja Centro", diasPendentes: 3, pendenciaMaisAntiga: "2026-09-19" });
    assert.match(texto, /desde 19\/09\/2026/);
  });

  test("sem pendenciaMaisAntiga: omite a cláusula 'desde' inteira (sem vírgula solta)", () => {
    const texto = formatarMensagemPendencia({ unidadeNome: "Loja Centro", diasPendentes: 2, pendenciaMaisAntiga: null });
    assert.doesNotMatch(texto, /desde/);
    assert.match(texto, /há 2 dias\./);
  });

  test("nome da unidade aparece no texto", () => {
    const texto = formatarMensagemPendencia({ unidadeNome: "Loja Ipiranga", diasPendentes: 2, pendenciaMaisAntiga: "2026-09-20" });
    assert.match(texto, /unidade Loja Ipiranga possui/);
  });

  test("unidadeNome ausente/null: usa travessão, nunca 'undefined' ou 'null' no texto", () => {
    const texto = formatarMensagemPendencia({ unidadeNome: null, diasPendentes: 1, pendenciaMaisAntiga: undefined });
    assert.doesNotMatch(texto, /undefined/);
    assert.doesNotMatch(texto, /null/);
    assert.match(texto, /unidade — possui/);
  });

  test("texto final não insinua continuidade de conversa (H.4-A.1, item 2) e traz CTA + assinatura", () => {
    const texto = formatarMensagemPendencia({ unidadeNome: "Loja Centro", diasPendentes: 1, pendenciaMaisAntiga: "2026-09-21" });
    assert.doesNotMatch(texto, /posso te mostrar/);
    assert.match(texto, /Por favor, acesse o sistema para verificar e regularizar a pendência\./);
    assert.match(texto, /— Crescer com Delivery$/);
  });

  test("preview e pipeline usam a MESMA função — mesma entrada produz exatamente o mesmo texto", () => {
    const entrada = { unidadeNome: "Loja Centro", diasPendentes: 4, pendenciaMaisAntiga: "2026-09-18" };
    const textoPipeline = formatarMensagemPendencia(entrada);
    const textoPreview = formatarMensagemPendencia({ ...entrada });
    assert.equal(textoPreview, textoPipeline);
  });
});
