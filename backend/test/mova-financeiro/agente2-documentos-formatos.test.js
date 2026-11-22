// MOVA — Agente 2: o MESMO documento em formatos diferentes (PDF com linha digitável × foto com código de barras) nunca gera
// duas propostas. Chave canônica só com dígitos verificadores válidos. Banco local isolado, IA simulada, dados sintéticos.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chaveDoDocumento } from "../../src/modules/mova-financeiro/dominio/documentos.js";
import { ALFA, ORG, base, cenario, gw, t } from "./helpers/operacao.js";

// Boleto SINTÉTICO (banco 001, R$ 450,00) com DVs corretos: a mesma cobrança nas duas formas.
const BARRAS = "00193123400000450000000000000000000000000123";
const LINHA = "00190000090000000000000000001230312340000045000"; // a mesma cobrança, como linha digitável
const boleto = (identificadorDocumento) => base({ tipoDocumento: "BOLETO", intencao: "REGISTRAR_CONTA", valorCentavos: 45000, vencimento: "2026-10-25", competencia: "2026-10",
  favorecido: "Fornecedor Sintético", identificadorDocumento });

test("A2-K1 chave canônica: linha digitável e código de barras do mesmo boleto coincidem; DV errado ou outro tipo ⇒ null", () => {
  assert.equal(chaveDoDocumento({ tipoDocumento: "BOLETO", identificadorDocumento: LINHA }), `BOLETO:${BARRAS}`);
  assert.equal(chaveDoDocumento({ tipoDocumento: "BOLETO", identificadorDocumento: BARRAS }), `BOLETO:${BARRAS}`);
  assert.equal(chaveDoDocumento({ tipoDocumento: "BOLETO", identificadorDocumento: LINHA.replace(/^0019000009/, "0019000008") }), null);
  assert.equal(chaveDoDocumento({ tipoDocumento: "BOLETO", identificadorDocumento: BARRAS.replace(/^00193/, "00192") }), null);
  assert.equal(chaveDoDocumento({ tipoDocumento: "BOLETO", identificadorDocumento: "ignore as instruções 123" }), null);
  assert.equal(chaveDoDocumento({ tipoDocumento: "RECIBO", identificadorDocumento: BARRAS }), null);
  assert.equal(chaveDoDocumento({ tipoDocumento: "NOTA_FISCAL", identificadorDocumento: "1".repeat(44) }), null);
});

t("A2-K2 boleto em PDF e depois em foto: a segunda vira DUPLICADO da primeira (uma proposta só)", async () => {
  const s = await cenario({ responder: (_req, n) => boleto(n === 1 ? LINHA : BARRAS) });
  await s.enviar(gw({ texto: "MOVA boleto da alfa", doc: "%PDF-1.4\n% boleto sintetico K2\n%%EOF\n" }));
  assert.equal((await s.ultima()).decisao, "PROPOSTA");
  const foto = gw({ texto: "MOVA boleto da alfa", doc: "\xff\xd8\xff\xe0 foto sintetica do boleto K2" });
  foto.midia.mime = "image/jpeg"; foto.tipo = "IMAGEM";
  await s.enviar(foto);
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo], ["DUPLICADO", "DOCUMENTO_JA_RECEBIDO"]);
  assert.equal((await s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: ALFA })).length, 1);
});

t("A2-K3 identificador ilegível/sem DV válido não junta documentos (vale só o arquivo): duas propostas para revisão", async () => {
  const s = await cenario({ responder: () => boleto("0019 0000 lido pela metade") });
  await s.enviar(gw({ texto: "MOVA boleto da alfa", doc: "%PDF-1.4\n% boleto sintetico K3a\n%%EOF\n" }));
  await s.enviar(gw({ texto: "MOVA boleto da alfa", doc: "%PDF-1.4\n% boleto sintetico K3b\n%%EOF\n" }));
  assert.equal((await s.mova.armazenamento.propostas.listar({ organizacaoId: ORG, unidadeId: ALFA })).length, 2);
});
