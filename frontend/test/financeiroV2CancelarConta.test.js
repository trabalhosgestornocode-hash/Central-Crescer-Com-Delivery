// Cancelar conta a pagar pela ficha da conta (aberta pela Lista e pelo Calendário). Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blocoCancelar, detalheAPagar } from "../financeiro-v2/telasTesouraria.js";

const t = (o = {}) => ({ id: "aaaaaaaa-0000-4000-8000-000000000001", situacao: "EM_ABERTO", pagoCentavos: 0, saldoCentavos: 2400, ...o });
const PODE = { permissoes: ["financeiro_v2.ver", "financeiro_v2.cancelar"] };

test("aparece só com a permissão de cancelar, em conta sem pagamento e não cancelada", () => {
  const html = blocoCancelar(t(), { parcelas: [] }, PODE);
  assert.match(html, /\/api\/fv2\/acoes\/obrigacoes\/cancelar/);
  assert.match(html, /name="obrigacao" value="aaaaaaaa-0000-4000-8000-000000000001"/);
  assert.match(html, /name="justificativa"[^>]*required/);
  assert.equal(blocoCancelar(t(), {}, { permissoes: ["financeiro_v2.ver"] }), "", "sem permissão");
  assert.equal(blocoCancelar(t({ pagoCentavos: 100 }), {}, PODE), "", "com pagamento vinculado");
  assert.equal(blocoCancelar(t({ situacao: "CANCELADO" }), {}, PODE), "", "já cancelada");
  assert.match(blocoCancelar(t(), { parcelas: [{}, {}, {}] }, PODE), /das 3 parcelas/);
});
test("a ficha da conta (Lista e Calendário) inclui o cancelamento", () => {
  const d = { titulo: { ...t(), fornecedor: { nome: "F" }, descricao: "Conta", vencimento: "2026-11-11", valorOriginalCentavos: 2400, pagamentos: [], documentos: [], dataEmissao: "2026-11-11", competencia: "2026-11" }, parcelas: [], historico: [] };
  assert.match(detalheAPagar(d, PODE), /Cancelar esta conta/);
  assert.doesNotMatch(detalheAPagar(d, { permissoes: ["financeiro_v2.ver"] }), /Cancelar esta conta/);
});
