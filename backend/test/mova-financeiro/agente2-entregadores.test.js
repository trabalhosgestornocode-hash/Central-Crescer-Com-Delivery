// MOVA — Agente 2, Frente D: rotina semanal dos entregadores (pura, sem banco, sem rede, sem envio). Dados sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { identificarEntregador, mensagemCobrancaNota, mensagemSemanal, pendenciaDeNota, precisaCobrarNota, validarEntregadores } from "../../src/modules/mova-financeiro/dominio/entregadores.js";

const ALFA = "eeeeeeee-0000-4000-8000-0000000000a1";
const BETA = "eeeeeeee-0000-4000-8000-0000000000b1";
const LISTA = validarEntregadores([
  { unidadeId: ALFA, chave: "ent-sint-1", telefoneE164: "+5500900000001", privado: "5500900000001@s.whatsapp.net", nome: "Entregador Um" },
  { unidadeId: ALFA, chave: "ent-sint-2", telefoneE164: "+5500900000002", privado: "5500900000002@s.whatsapp.net" },
  { unidadeId: BETA, chave: "ent-sint-1b", telefoneE164: "+5500900000001", privado: "5500900000001@s.whatsapp.net" },
]);
const F = (x = {}) => ({ semanaInicio: "2026-10-05", semanaFim: "2026-10-11", prazoDaNota: "2026-10-13", vencimento: "2026-10-15", entregas: 42, valorCentavos: 63000,
  ajustesCentavos: 0, situacaoDocumental: "AGUARDANDO_NF", duplicidade: null, entregador: { chave: "ent-sint-1", nome: "Entregador Um" }, ...x });

test("A2-D1 lista fechada: telefone repetido na unidade é recusado; mesma pessoa em duas unidades só é identificada com a unidade", () => {
  assert.throws(() => validarEntregadores([LISTA[0], { ...LISTA[0], chave: "x" }]), /repetido/);
  assert.equal(identificarEntregador(LISTA, { privado: "5500900000001@s.whatsapp.net" }), null);
  assert.equal(identificarEntregador(LISTA, { privado: "5500900000001@s.whatsapp.net", unidadeId: ALFA }).chave, "ent-sint-1");
  assert.equal(identificarEntregador(LISTA, { telefoneE164: "+5500900000002" }).chave, "ent-sint-2");
  assert.equal(identificarEntregador(LISTA, { privado: "5500999999999@s.whatsapp.net" }), null);
});

test("A2-D2 mensagem de segunda: só o próprio fechamento; pede NF com prazo; nada sai com duplicidade em aberto", () => {
  const m = mensagemSemanal(F());
  assert.match(m, /Olá, Entregador! .*05\/10\/2026 a 11\/10\/2026/);
  assert.match(m, /42 entrega\(s\) — R\$ 630,00/);
  assert.match(m, /até 13\/10\/2026/);
  assert.equal(mensagemSemanal(F({ duplicidade: { situacao: "ABERTA" } })), null);
  assert.match(mensagemSemanal(F({ situacaoDocumental: "LIBERADO_PAGAMENTO" })), /pagamento liberado/);
});

test("A2-D3 cobrança da NF: só pendente/rejeitada, a partir de 2 dias do prazo; texto muda depois do prazo", () => {
  assert.equal(precisaCobrarNota(F(), "2026-10-10"), false);
  assert.equal(precisaCobrarNota(F(), "2026-10-11"), true);
  assert.equal(precisaCobrarNota(F({ situacaoDocumental: "NF_RECEBIDA" }), "2026-10-14"), false);
  assert.match(mensagemCobrancaNota(F(), "2026-10-14"), /venceu o prazo/);
  assert.match(mensagemCobrancaNota(F(), "2026-10-12"), /até 13\/10/);
});

test("A2-D4 nota recebida: vira pendência de anexo (sem escrita); recusa outro entregador, não-PDF e semana liberada", () => {
  const outro = identificarEntregador(LISTA, { telefoneE164: "+5500900000002" });
  const pdf = { mime: "application/pdf", referencia: "mova/evidencias/sint-1", sha256: "a".repeat(64) };
  assert.equal(pendenciaDeNota({ entregador: outro, fechamento: F(), midia: pdf }).motivo, "FECHAMENTO_DE_OUTRO_ENTREGADOR");
  const dono = LISTA[0];
  assert.equal(pendenciaDeNota({ entregador: dono, fechamento: F(), midia: { ...pdf, mime: "image/jpeg" } }).motivo, "NOTA_PRECISA_SER_PDF");
  assert.equal(pendenciaDeNota({ entregador: dono, fechamento: F({ situacaoDocumental: "LIBERADO_PAGAMENTO" }), midia: pdf }).motivo, "PAGAMENTO_JA_LIBERADO");
  const r = pendenciaDeNota({ entregador: dono, fechamento: F(), midia: pdf, recebidoEm: "2026-10-12T10:00:00Z" });
  assert.equal(r.ok, true);
  assert.deepEqual([r.pendencia.tipo, r.pendencia.entregador, r.pendencia.inicio, r.pendencia.operacaoOficial], ["ANEXAR_NOTA_DO_ENTREGADOR", "ent-sint-1", "2026-10-05", "anexarDocumentoDoEntregador"]);
});
