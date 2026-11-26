// Limites APROVADOS (25/11) recuperados pelo motor de autonomia por organização/unidade/operação (dados sintéticos de mesmo formato).
import assert from "node:assert/strict";
import { test } from "node:test";
import { decidirAutonomia } from "../../src/modules/mova-financeiro/dominio/autonomia.js";

const AC = ["e7216085-1ece-45dc-bc41-d74f11a88e40", "4d3b75bd-79b5-4335-ae5b-a183580c3555"];
const SW = ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-0000000000a1"];
const P = (id, operacao, [o, u], limiteCentavos) => ({ id, operacao, organizacaoId: o, unidadeId: u, nivel: "APLICAR_AUTOMATICO", limiteCentavos, vigenteDe: "2026-11-25", vigenteAte: null, revogadaEm: null });
const politicas = [
  ...[["BAIXA_DOCUMENTAL", 3000000], ["DESPESA_DOCUMENTAL", 3000000], ["JUROS_DOCUMENTAL", 100000], ["PRESTACAO_DE_SANGRIA", 100000]].map(([op, l], i) => P(`s${i}`, op, SW, l)),
  ...[["BAIXA_DOCUMENTAL", 1000000], ["DESPESA_DOCUMENTAL", 1000000], ["JUROS_DOCUMENTAL", 50000], ["PRESTACAO_DE_SANGRIA", 100000]].map(([op, l], i) => P(`a${i}`, op, AC, l)),
];
const ok = { apto: true, situacao: "PIX_CONCLUIDO", motivos: [], comIdentificador: true };
const dec = (op, [o, u], valorCentavos, comprovante = ok) => decidirAutonomia({ politicas, operacao: op, organizacaoId: o, unidadeId: u, valorCentavos, hoje: "2026-11-26", comprovante });

test("POL-1 Subway e Açaí: cada unidade acha a SUA política (id) e respeita o limite aprovado; sem identificador da transação rebaixa; acima do limite rebaixa", () => {
  for (const [nome, un, limite, juros] of [["Subway", SW, 3000000, 100000], ["Açaí", AC, 1000000, 50000]]) {
    for (const op of ["DESPESA_DOCUMENTAL", "BAIXA_DOCUMENTAL"]) {
      const d = dec(op, un, limite);
      assert.equal(d.nivel, "APLICAR_AUTOMATICO", `${nome} ${op}`);
      assert.ok(d.politicaId.startsWith(un === SW ? "s" : "a"), "política da própria unidade");
      assert.notEqual(dec(op, un, limite + 1).nivel, "APLICAR_AUTOMATICO", `${nome} ${op} acima do limite`);
    }
    assert.equal(dec("JUROS_DOCUMENTAL", un, juros).nivel, "APLICAR_AUTOMATICO");
    assert.notEqual(dec("JUROS_DOCUMENTAL", un, juros + 1).nivel, "APLICAR_AUTOMATICO");
    const sem = dec("DESPESA_DOCUMENTAL", un, 46430, { ...ok, comIdentificador: false });
    assert.equal(sem.nivel, "APLICAR_COM_CONFIRMACAO");
    assert.ok(sem.motivos.includes("SEM_IDENTIFICADOR_DA_TRANSACAO"));
  }
  // política de uma unidade nunca vale para outra
  assert.equal(dec("DESPESA_DOCUMENTAL", [AC[0], SW[1]], 1000).nivel, "SOMENTE_PROPOR");
});
