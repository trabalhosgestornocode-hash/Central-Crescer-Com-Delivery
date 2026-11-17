// Aprovar e aplicar numa só transação (17/11/2026): mesmas regras das operações separadas, menos idas ao banco.
// Dados 100% SINTÉTICOS; roda em memória e no PostgreSQL local (FV2_REPOSITORIO=postgres).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ORG_A, TODAS, UNI_A, ctx, montar, rejeita } from "./helpers/cenario.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const CAB = ["Pedido", "Código da loja", "Nome da loja", "Tipo do pedido", "Turno", "Canal de venda", "Id do pedido no parceiro", "Número do pedido no parceiro",
  "Data da venda", "Consumidor", "Tem cupom", "Pagamento", "Está cancelado", "Motivo do cancelamento", "Itens", "Entrega", "Valor Entregador", "Entregador",
  "Bairro", "CEP", "Acréscimo", "Motivo de acréscimo", "Desconto", "Motivo do desconto", "Total", "Total taxa de serviço"];
const ficha = (quando, pagamento, itens) => ["Ficha", null, null, "F", "Dia", null, null, null, quando, "Consumidor não identificado", "N", pagamento, "N", null, itens, null, null, null, null, "", 0, "", 0, "", itens, 0];
const LINHAS = [ficha("01/11/2026 12:00", "Débito Master", 20), ficha("01/11/2026 12:10", "Dinheiro", 15), ficha("02/11/2026 12:00", "Crédito Visa", 30), ficha("02/11/2026 12:10", "Débito Master", 20)];

async function cenario() {
  const m = montar({ relogio: () => new Date("2026-11-20T12:00:00Z") });
  const caixa = await m.nucleo.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const r = await m.nucleo.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "application/octet-stream", conteudo: xlsx([{ nome: "Vendas por período", linhas: [CAB, ...LINHAS] }]), periodoInicio: "2026-11-01", periodoFim: "2026-11-02" });
  const imp = (await m.nucleo.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? { aceitarPendencias: true, justificativa: "Sintético." } : {}) })).importacao;
  await m.nucleo.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  const propostas = await m.nucleo.listarPropostas(c, { importacaoId: imp.id, estado: "PROPOSTA" });
  return { ...m, imp, propostas };
}
const vendas = async (m) => (await m.nucleo.consultarRegistros(c, { tipo: "VENDA" })).filter((v) => v.situacao === "ATIVA");

test("aprova e aplica numa transação: proposta APLICADA, decisão registrada, venda criada; repetir não duplica", async () => {
  const m = await cenario();
  const [p] = m.propostas;
  const r = await m.nucleo.aprovarEAplicarProposta(c, { propostaId: p.id, justificativa: "Lote sintético." });
  assert.equal(r.repetido, false);
  assert.equal(r.proposta.estado, "APLICADA");
  assert.ok(r.proposta.decididoPor && r.proposta.decididoEm, "a aprovação fica registrada");
  const hist = await m.nucleo.consultarHistorico(c, { registroTipo: "PROPOSTA", registroId: p.id });
  assert.deepEqual(hist.filter((h) => h.evento === "MUDANCA_ESTADO").map((h) => h.depois.estado), ["APROVADA", "APLICADA"]);
  assert.equal((await vendas(m)).length, 1);
  const de_novo = await m.nucleo.aprovarEAplicarProposta(c, { propostaId: p.id });
  assert.equal(de_novo.repetido, true);
  assert.equal((await vendas(m)).length, 1);
});

test("o lote pela rota usa a operação combinada e chega ao mesmo resultado (todas aplicadas, nenhuma falha)", async () => {
  const m = await cenario();
  const r = await ESCRITAS["/propostas/aprovar-e-aplicar-prontas"].fazer(m.nucleo, c, { importacao: m.imp.id });
  assert.deepEqual([r.aplicadas, r.falhas.length, r.restantes], [m.propostas.length, 0, 0]);
  assert.equal((await vendas(m)).reduce((s, v) => s + v.brutoCentavos, 0), 8500);
});

test("exige APROVAR e APLICAR: sem uma delas, nada muda", async () => {
  const m = await cenario();
  const [p] = m.propostas;
  for (const sem of [ACAO.APROVAR, ACAO.APLICAR]) {
    await rejeita(m.nucleo.aprovarEAplicarProposta(ctx(ORG_A, UNI_A, TODAS.filter((a) => a !== sem)), { propostaId: p.id }), CODIGO.PERMISSAO_INSUFICIENTE);
  }
  assert.equal((await m.nucleo.listarPropostas(c, { importacaoId: m.imp.id, estado: "PROPOSTA" })).length, m.propostas.length);
  assert.equal((await vendas(m)).length, 0);
});

test("se a aplicação falha (conflito com faturamento provisório do dia), a aprovação também é desfeita", async () => {
  const m = await cenario();
  const caixa = (await m.nucleo.consultarRegistros(c, { tipo: "CONTA" }))[0];
  await m.nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-11-01", brutoCentavos: 999, fonte: { sistema: "MANUAL", idExterno: "faturamento-manual:sintetico" }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 999, contaId: caixa.id }] });
  const doDia1 = m.propostas.find((p) => p.dataOperacao === "2026-11-01");
  await rejeita(m.nucleo.aprovarEAplicarProposta(c, { propostaId: doDia1.id, justificativa: "Lote sintético." }), CODIGO.CONFLITO_IDEMPOTENCIA);
  const depois = (await m.nucleo.listarPropostas(c, { importacaoId: m.imp.id })).find((p) => p.id === doDia1.id);
  assert.equal(depois.estado, "PROPOSTA", "nada ficou pela metade");
});
