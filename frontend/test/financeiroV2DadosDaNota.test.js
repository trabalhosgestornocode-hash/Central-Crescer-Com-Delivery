// Dados da nota na ficha do entregador (lidos do PDF da NFS-e ou digitados). Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dadosDaNota } from "../financeiro-v2/telasEntregadores.js";

const base = (nota, extra = {}) => ({ situacaoDocumental: "NF_RECEBIDA", valorCentavos: 22000, semanaInicio: "2026-11-09", semanaFim: "2026-11-15", rotuloSemana: "09 a 15/11/2026", notaVigente: nota, ...extra });
const lida = { numero: "119", emitente: "FULANO (11.222.333/0001-81)", tomador: "EMPRESA (44.555.666/0001-99)", valorCentavos: 22000, leitura: { chaveAcesso: "1".repeat(50), competencia: "2026-11-09", emissao: "2026-11-18", periodo: { inicio: "2026-11-09", fim: "2026-11-15" }, tomador: { nome: "EMPRESA" } } };

test("mostra os dados lidos e confirma quando número, valor e período batem", () => {
  const h = dadosDaNota(base(lida));
  assert.match(h, /lidos do PDF da NFS-e/);
  assert.match(h, /119/); assert.match(h, /R\$\s?220,00/); assert.match(h, /conferem com a semana/);
});
test("avisa valor ausente, valor diferente, tomador não identificado e período diferente", () => {
  assert.match(dadosDaNota(base({ ...lida, valorCentavos: null, leitura: null })), /anexada sem valor/);
  assert.match(dadosDaNota(base({ ...lida, valorCentavos: 21000 })), /diferente do total devido/);
  assert.match(dadosDaNota(base({ ...lida, leitura: { ...lida.leitura, tomador: { naoIdentificado: true } } })), /não identifica o tomador/);
  assert.match(dadosDaNota(base({ ...lida, leitura: { ...lida.leitura, periodo: { inicio: "2026-11-02", fim: "2026-11-08" } } })), /diferente da semana/);
});
test("sem nota vigente ou já liberada, nada aparece", () => {
  assert.equal(dadosDaNota(base(null)), "");
  assert.equal(dadosDaNota(base(lida, { situacaoDocumental: "LIBERADO_PAGAMENTO" })), "");
});
test("mostra por que a nota não foi liberada automaticamente", () => {
  const h = dadosDaNota(base({ ...lida, automatica: { liberada: false, motivos: ["A nota não identifica o tomador."] } }));
  assert.match(h, /Não foi liberada automaticamente/); assert.match(h, /não identifica o tomador/);
  assert.doesNotMatch(dadosDaNota(base({ ...lida, automatica: { liberada: true, motivos: [] } }, { situacaoDocumental: "NF_APROVADA" })), /Não foi liberada/);
});
