// F4 (MOVA CORE §12) — PRESTAÇÃO DE CONTAS DA SANGRIA no núcleo do Financeiro v2. Dados SINTÉTICOS. Roda em memória e, com
// FV2_REPOSITORIO=postgres, no banco isolado de homologação.
// Princípio: a retirada NÃO é despesa antes do destino. Despesa paga com o dinheiro da retirada = conta + liquidação contra a
// PRÓPRIA saída da sangria (nenhuma segunda saída); troco = entrada DEVOLUCAO no mesmo caixa; pendente calculado pelo código.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ctx, montarComCadastros, obrigacao } from "./helpers/cenario.js";

const DIA = "2026-10-14";
async function cenario({ abrir = true, prazoHoras } = {}) {
  const m = await montarComCadastros();
  const n = m.nucleo; const c = m.c;
  if (prazoHoras !== undefined) await n.configurarUnidade?.(c, { prazoPrestacaoSangriaHoras: prazoHoras }).catch(() => null);
  const { sessao } = await n.abrirCaixa(c, { contaId: m.caixa.id, dataAbertura: DIA, saldoContadoCentavos: 10000 });
  const sangria = async (valor, descricao = "Comprar grampos") => {
    const r = await n.registrarOperacaoDeCaixa(c, { sessaoId: sessao.id, operacao: "SANGRIA", valorCentavos: valor, data: DIA, descricao });
    return r.operacao.movimentacaoId;
  };
  if (!abrir) await n.fecharCaixa(c, { sessaoId: sessao.id, dataFechamento: DIA, contadoCentavos: 10000, justificativa: "fechamento sintético", confirmar: true });
  return { ...m, n, c, sessao, sangria };
}
const despesa = (m, movId, valor, chave, extra = {}) => m.n.registrarDespesaDaSangria(m.c, {
  sessaoId: m.sessao.id, movimentacaoId: movId, chave, justificativa: "Compra de grampos para a cozinha (sintético)", confirmar: true,
  obrigacao: obrigacao(m.fornecedor.id, { valorOriginalCentavos: valor, categoria: "INSUMOS", descricao: "Grampos (sintético)", competencia: "2026-10", dataEmissao: DIA, vencimento: DIA }), ...extra,
});
const troco = (m, movId, valor, chave, extra = {}) => m.n.registrarTrocoDaSangria(m.c, { sessaoId: m.sessao.id, movimentacaoId: movId, chave, valorCentavos: valor, data: DIA, confirmar: true, ...extra });
const retrato = async (m) => {
  const regs = async (tipo) => m.n.consultarRegistros(m.c, { tipo });
  const movs = await regs("MOVIMENTACAO");
  return {
    contas: (await regs("OBRIGACAO")).length, despesas: (await regs("LANCAMENTO")).filter((l) => l.natureza === "DESPESA" && l.situacao === "ATIVO").length,
    saidas: movs.filter((x) => x.sentido === "SAIDA").length, entradas: movs.filter((x) => x.sentido === "ENTRADA").length, receitas: (await regs("LANCAMENTO")).filter((l) => l.natureza === "RECEITA").length,
  };
};

test("SG-A grampos: retirada de R$ 15, compra de R$ 12, troco de R$ 3 ⇒ PRESTADA; uma despesa de R$ 12, nenhuma 2ª saída, troco não é receita", async () => {
  const m = await cenario();
  const mov = await m.sangria(1500);
  const antes = await retrato(m);
  let p = (await m.n.consultarPrestacaoDeSangrias(m.c)).itens[0];
  assert.deepEqual([p.estado, p.pendenteCentavos, p.valorCentavos], ["AGUARDANDO_DESTINO", 1500, 1500], "a retirada sozinha NÃO é despesa");
  assert.equal(antes.despesas, 0);
  const d = await despesa(m, mov, 1200, "MOVA:grampos-despesa-1");
  assert.deepEqual([d.repetido, d.obrigacao.situacao, d.obrigacao.saldoCentavos, d.prestacao.estado, d.prestacao.pendenteCentavos, d.efeito.novasSaidas], [false, "QUITADA", 0, "PARCIAL", 300, 0]);
  const t = await troco(m, mov, 300, "MOVA:grampos-troco-1");
  assert.deepEqual([t.prestacao.estado, t.prestacao.pendenteCentavos, t.prestacao.trocoDevolvidoCentavos, t.prestacao.despesasCentavos], ["PRESTADA", 0, 300, 1200]);
  const depois = await retrato(m);
  assert.deepEqual([depois.contas - antes.contas, depois.despesas - antes.despesas, depois.saidas - antes.saidas, depois.entradas - antes.entradas, depois.receitas - antes.receitas], [1, 1, 0, 1, 0]);
  p = (await m.n.consultarPrestacaoDeSangrias(m.c, { somentePendentes: true }));
  assert.equal(p.itens.length, 0);
});

test("SG-B várias despesas numa retirada, prestação parcial e comprovante depois; o pendente nunca fica negativo", async () => {
  const m = await cenario();
  const mov = await m.sangria(5000, "Compras do dia");
  await despesa(m, mov, 1800, "MOVA:compras-1");
  const r2 = await despesa(m, mov, 2000, "MOVA:compras-2");
  assert.deepEqual([r2.prestacao.estado, r2.prestacao.pendenteCentavos, r2.prestacao.despesas.length, r2.prestacao.comprovantesPendentes], ["PARCIAL", 1200, 2, 2]);
  await assert.rejects(despesa(m, mov, 1300, "MOVA:compras-3"), (e) => e.codigo === CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO && e.detalhes?.pendenteCentavos === 1200);
  await assert.rejects(troco(m, mov, 1300, "MOVA:compras-troco"), (e) => e.codigo === CODIGO.VALOR_INVALIDO);
  const ok = await troco(m, mov, 1200, "MOVA:compras-troco-2");
  assert.equal(ok.prestacao.estado, "PRESTADA");
});

test("SG-C caixa FECHADO ou sangria inexistente: troco recusado com o motivo; saída que não é sangria não presta contas", async () => {
  const m = await cenario();
  const mov = await m.sangria(1500);
  await m.n.fecharCaixa(m.c, { sessaoId: m.sessao.id, dataFechamento: DIA, contadoCentavos: 8500, justificativa: "fechamento sintético", confirmar: true });
  await assert.rejects(troco(m, mov, 300, "MOVA:troco-fechado"), (e) => e.codigo === CODIGO.OPERACAO_INVALIDA && e.detalhes?.motivo === "CAIXA_FECHADO");
  // a despesa não depende do caixa aberto (o dinheiro já saiu): registra-se contra a saída da sangria
  const d = await despesa(m, mov, 1200, "MOVA:grampos-fechado");
  assert.equal(d.prestacao.pendenteCentavos, 300);
  const outraSaida = (await m.n.registrarMovimentacao(m.c, { contaId: m.caixa.id, dataEfetiva: DIA, sentido: "SAIDA", valorCentavos: 900, natureza: "OUTRA", descricao: "outra saída" })).movimentacao;
  await assert.rejects(despesa(m, outraSaida.id, 500, "MOVA:nao-sangria"), (e) => e.codigo === CODIGO.OPERACAO_INVALIDA && e.detalhes?.motivo === "NAO_E_SANGRIA");
  await assert.rejects(despesa(m, "00000000-0000-4000-8000-000000000000", 500, "MOVA:inexistente"), (e) => [CODIGO.NAO_ENCONTRADO, CODIGO.OPERACAO_INVALIDA].includes(e.codigo) || /não encontrad/i.test(e.message));
});

test("SG-D idempotência: repetir a MESMA chave devolve o que existe; mesma chave com outro conteúdo é recusada", async () => {
  const m = await cenario();
  const mov = await m.sangria(1500);
  const a = await despesa(m, mov, 1200, "MOVA:idem-1");
  const meio = await retrato(m);
  const b = await despesa(m, mov, 1200, "MOVA:idem-1");
  assert.deepEqual([b.repetido, b.despesa.obrigacaoId], [true, a.despesa.obrigacaoId]);
  assert.deepEqual(await retrato(m), meio, "nada duplicado");
  await assert.rejects(despesa(m, mov, 1100, "MOVA:idem-1"), (e) => e.codigo === CODIGO.CONFLITO_IDEMPOTENCIA);
  const t1 = await troco(m, mov, 300, "MOVA:idem-troco");
  const t2 = await troco(m, mov, 300, "MOVA:idem-troco");
  assert.deepEqual([t2.repetido, t2.devolucao.movimentacaoId], [true, t1.devolucao.movimentacaoId]);
});

test("SG-E CONCORRÊNCIA: duas prestações simultâneas que juntas passam do valor ⇒ só uma entra (trava na saída da sangria)", async () => {
  const m = await cenario();
  const mov = await m.sangria(1500);
  const rs = await Promise.allSettled([despesa(m, mov, 1000, "MOVA:conc-1"), despesa(m, mov, 1000, "MOVA:conc-2")]);
  assert.deepEqual(rs.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const p = (await m.n.consultarPrestacaoDeSangrias(m.c)).itens[0];
  assert.deepEqual([p.despesasCentavos, p.pendenteCentavos], [1000, 500]);
});

test("SG-F estorno/correção: estornar a liquidação devolve o valor ao pendente (nenhum ajuste manual)", async () => {
  const m = await cenario();
  const mov = await m.sangria(1500);
  const d = await despesa(m, mov, 1200, "MOVA:estorno-1");
  await m.n.estornarLiquidacao(m.c, { liquidacaoId: d.despesa.liquidacaoId, justificativa: "Valor errado: refazer (sintético)" });
  const p = (await m.n.consultarPrestacaoDeSangrias(m.c)).itens[0];
  assert.deepEqual([p.despesasCentavos, p.pendenteCentavos, p.estado], [0, 1500, "AGUARDANDO_DESTINO"]);
});

test("SG-G PRAZO configurável: passou do prazo com pendente ⇒ ATRASADA; padrão 48 h", async () => {
  const m = await cenario();
  await m.sangria(1500);
  const p = await m.n.consultarPrestacaoDeSangrias(m.c);
  assert.equal(p.prazoHoras, 48);
  const { retratoDaPrestacao } = await import("../../src/modules/financeiro-v2/aplicacao/prestacaoDeSangria.js");
  const op = { descricao: "x", registradoEm: "2026-10-14T10:00:00.000Z" }; const mv = { id: "m", dataEfetiva: DIA, valorCentavos: 1500, alocadoCentavos: 0, situacao: "VALIDA" };
  assert.equal(retratoDaPrestacao({ operacao: op, mov: mv }, { agora: "2026-10-16T09:59:00.000Z", prazoHoras: 48 }).estado, "AGUARDANDO_DESTINO");
  assert.equal(retratoDaPrestacao({ operacao: op, mov: mv }, { agora: "2026-10-16T10:01:00.000Z", prazoHoras: 48 }).estado, "ATRASADA");
  assert.equal(retratoDaPrestacao({ operacao: op, mov: mv }, { agora: "2026-10-14T13:00:00.000Z", prazoHoras: 2 }).estado, "ATRASADA", "prazo da unidade");
  assert.equal(retratoDaPrestacao({ operacao: op, mov: { ...mv, alocadoCentavos: 1500 } }, { agora: "2026-12-01T00:00:00.000Z", prazoHoras: 48 }).estado, "PRESTADA", "prestada não atrasa");
});

test("SG-H PERMISSÃO: sem `registrar` não presta contas; outra unidade não enxerga a sangria", async () => {
  const m = await cenario();
  const mov = await m.sangria(1500);
  const soVer = { ...m.c, permissoes: [ACAO.VER] };
  await assert.rejects(m.n.registrarDespesaDaSangria(soVer, { sessaoId: m.sessao.id, movimentacaoId: mov, chave: "MOVA:sem-perm", justificativa: "Compra de grampos sintética", confirmar: true, obrigacao: obrigacao(m.fornecedor.id, { valorOriginalCentavos: 100 }) }), (e) => e.codigo === CODIGO.PERMISSAO_INSUFICIENTE);
  const outra = ctx(m.c.organizacaoId, "aaaaaaaa-0000-4000-8000-0000000000a2");
  await assert.rejects(m.n.registrarDespesaDaSangria(outra, { sessaoId: m.sessao.id, movimentacaoId: mov, chave: "MOVA:outra-uni", justificativa: "Compra de grampos sintética", confirmar: true, obrigacao: obrigacao(m.fornecedor.id, { valorOriginalCentavos: 100 }) }), (e) => e.codigo !== undefined);
  await assert.rejects(despesa(m, mov, 1200, "MOVA:sem-confirmar", { confirmar: false }), (e) => e.codigo === CODIGO.CONFIRMACAO_EXIGIDA);
});
