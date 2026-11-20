// Rota de cancelamento de conta a pagar: usa o cancelamento lógico do núcleo (nada é apagado). Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { UNI_A2, ctx, montar, rejeita } from "./helpers/cenario.js";

const c = ctx();
const conta = (n, contexto = c) => n.registrarObrigacao(contexto, { contraparteNova: { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" }, valorOriginalCentavos: 2400, categoria: "OUTRAS_DESPESAS", descricao: "Conta sintética", competencia: "2026-11", dataEmissao: "2026-11-11", vencimento: "2026-11-11" });
const W = (n, corpo, contexto = c) => ESCRITAS["/obrigacoes/cancelar"].fazer(n, contexto, corpo);

test("cancela a conta e o lançamento; repetir é recusado; justificativa obrigatória; campos estritos", async () => {
  const { nucleo: n } = montar({ relogio: () => new Date("2026-11-20T15:00:00.000Z") });
  const { obrigacoes: [o] } = await conta(n);
  assert.deepEqual(ESCRITAS["/obrigacoes/cancelar"].campos, ["obrigacao", "justificativa"]);
  await rejeita(W(n, { obrigacao: o.id }), CODIGO.ENTRADA_INVALIDA);
  const r = await W(n, { obrigacao: o.id, justificativa: "Substituída pelas contas individuais da semana." });
  assert.equal(r.obrigacoes[0].situacao, "CANCELADA");
  const [l] = (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((x) => x.id === o.lancamentoId);
  assert.equal(l.situacao, "CANCELADO", "o lançamento sai da DRE");
  await rejeita(W(n, { obrigacao: o.id, justificativa: "de novo" }), CODIGO.OPERACAO_INVALIDA);
});

test("conta com pagamento vinculado não é cancelada; outra unidade não alcança a conta", async () => {
  const { nucleo: n } = montar({ relogio: () => new Date("2026-11-20T15:00:00.000Z") });
  const { obrigacoes: [o] } = await conta(n);
  await rejeita(W(n, { obrigacao: o.id, justificativa: "Tentativa de outra unidade." }, ctx(c.organizacaoId, UNI_A2)), CODIGO.NAO_ENCONTRADO);
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  await n.pagarContaAPagar(c, { obrigacaoId: o.id, contaId: caixa.id, dataEfetiva: "2026-11-11", valorCentavos: 1000 });
  await rejeita(W(n, { obrigacao: o.id, justificativa: "Tem pagamento." }), CODIGO.ESTORNO_EXIGE_COMPENSACAO);
});
