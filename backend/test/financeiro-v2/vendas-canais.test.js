// Fase E — 3 (ausência de efeitos duplicados) e 11 (canal × forma de pagamento × processador).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO, catalogos } from "../../src/modules/financeiro-v2/index.js";
import { ctx, montar, montarComCadastros, obrigacao, rejeita } from "./helpers/cenario.js";

const vendaMista = (extra = {}) => ({
  canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: 10000,
  pagamentos: [
    { forma: "DINHEIRO", valorCentavos: 2500 },
    { forma: "CREDITO", processador: "STONE", valorCentavos: 6000 },
    { forma: "VALE", processador: "OPERADORA_BENEFICIOS", valorCentavos: 1500 },
  ],
  fonte: { sistema: "SAIPOS", idExterno: "PED-100" }, ...extra,
});
const total = async (nucleo, c, indicador) => (await nucleo.consultarComposicao(c, { indicador, competencia: "2026-09" })).totalCentavos;

test("canal, forma de pagamento e processador são catálogos independentes", () => {
  const { CANAL, FORMA_PAGAMENTO, PROCESSADOR, TIPO_CONTA } = catalogos;
  assert.deepEqual(Object.keys(CANAL), ["BALCAO", "IFOOD", "ANOTA_AI", "OUTRO"]);
  assert.deepEqual(Object.keys(FORMA_PAGAMENTO), ["DINHEIRO", "PIX", "DEBITO", "CREDITO", "VALE", "OUTRA"]);
  assert.ok(Object.keys(PROCESSADOR).includes("STONE") && Object.keys(PROCESSADOR).includes("MAQUINA_TERCEIROS"));
  // Processadores não são contas financeiras.
  assert.deepEqual(Object.keys(TIPO_CONTA), ["BANCARIA", "CAIXA_FISICO"]);
  for (const p of Object.keys(PROCESSADOR)) assert.ok(!Object.keys(TIPO_CONTA).includes(p));
});

test("uma venda com várias formas de pagamento pertence a um único canal e gera UMA receita", async () => {
  const { nucleo } = montar();
  const c = ctx();
  const r = await nucleo.registrarVenda(c, vendaMista());
  assert.equal(r.venda.canal, "BALCAO");
  assert.equal(r.venda.pagamentos.length, 3);
  assert.equal(r.lancamento.natureza, "RECEITA");
  assert.equal(r.lancamento.valorCentavos, 10000);
  assert.deepEqual(r.lancamento.origem, { tipo: "VENDA", id: r.venda.id });
  // Recebível só para o que passa por processador; dinheiro não vira "a receber".
  assert.deepEqual(r.recebiveis.map((x) => [x.processador, x.forma, x.saldoCentavos, x.canal]), [["STONE", "CREDITO", 6000, "BALCAO"], ["OPERADORA_BENEFICIOS", "VALE", 1500, "BALCAO"]]);
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 10000);
  assert.equal(await total(nucleo, c, "SALDO_A_RECEBER"), 7500);
  assert.equal(await total(nucleo, c, "ENTRADAS_DE_CAIXA"), 0); // vender não é receber
});

test("venda iFood paga online: canal IFOOD, forma CREDITO, processador IFOOD — três dimensões", async () => {
  const { nucleo } = montar();
  const r = await nucleo.registrarVenda(ctx(), { canal: "IFOOD", dataVenda: "2026-09-11", brutoCentavos: 4200, pagamentos: [{ forma: "CREDITO", processador: "IFOOD", valorCentavos: 4200 }], fonte: { sistema: "IFOOD", idExterno: "ORD-1" } });
  assert.equal(r.venda.canal, "IFOOD");
  assert.equal(r.venda.pagamentos[0].forma, "CREDITO");
  assert.equal(r.recebiveis[0].processador, "IFOOD");
  // Venda iFood paga na entrega em máquina própria: mesmo canal, outro processador.
  const r2 = await nucleo.registrarVenda(ctx(), { canal: "IFOOD", dataVenda: "2026-09-11", brutoCentavos: 3000, pagamentos: [{ forma: "DEBITO", processador: "STONE", valorCentavos: 3000 }], fonte: { sistema: "IFOOD", idExterno: "ORD-2" } });
  assert.equal(r2.venda.canal, "IFOOD");
  assert.equal(r2.recebiveis[0].processador, "STONE");
});

test("reenviar a mesma venda não duplica receita nem recebíveis", async () => {
  const { nucleo } = montar();
  const c = ctx();
  const a = await nucleo.registrarVenda(c, vendaMista());
  const b = await nucleo.registrarVenda(c, vendaMista());
  const d = await nucleo.registrarVenda(c, vendaMista());
  assert.equal(a.repetido, false);
  assert.ok(b.repetido && d.repetido);
  assert.equal(b.venda.id, a.venda.id);
  assert.equal(b.lancamento.id, a.lancamento.id);
  assert.equal(b.recebiveis.length, 2);
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 10000);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "VENDA" })).length, 1);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" })).length, 1);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "RECEBIVEL" })).length, 2);
});

test("mesma origem com conteúdo diferente é conflito, nunca sobrescrita silenciosa", async () => {
  const { nucleo } = montar();
  const c = ctx();
  await nucleo.registrarVenda(c, vendaMista());
  const alterada = vendaMista({ brutoCentavos: 10100, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 10100 }] });
  await rejeita(nucleo.registrarVenda(c, alterada), CODIGO.CONFLITO_IDEMPOTENCIA);
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 10000);
});

test("a mesma venda vista no PDV e no processador não vira duas vendas", async () => {
  const { nucleo } = montar();
  const c = ctx();
  await nucleo.registrarVenda(c, vendaMista());
  // O relatório do processador (e o extrato do banco) descreve o PAGAMENTO da venda: não pode originar venda.
  for (const sistema of ["STONE", "UNICRED", "FOODY", "OUTRO"]) {
    await rejeita(nucleo.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: 6000, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 6000 }], fonte: { sistema, idExterno: "TX-9" } }), CODIGO.FONTE_NAO_ORIGINA_VENDA);
  }
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 10000);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "VENDA" })).length, 1);
});

test("pagamentos que não fecham com o bruto e combinações inválidas são recusados", async () => {
  const { nucleo } = montar();
  const c = ctx();
  await rejeita(nucleo.registrarVenda(c, vendaMista({ brutoCentavos: 10001 })), CODIGO.PAGAMENTOS_NAO_FECHAM);
  await rejeita(nucleo.registrarVenda(c, vendaMista({ pagamentos: [{ forma: "DINHEIRO", processador: "STONE", valorCentavos: 10000 }] })), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.registrarVenda(c, vendaMista({ canal: "STONE" })), CODIGO.ENTRADA_INVALIDA); // processador não é canal
  await rejeita(nucleo.registrarVenda(c, vendaMista({ pagamentos: [{ forma: "STONE", valorCentavos: 10000 }] })), CODIGO.ENTRADA_INVALIDA); // processador não é forma
  await rejeita(nucleo.registrarVenda(c, vendaMista({ pagamentos: [{ forma: "PIX", processador: "BALCAO", valorCentavos: 10000 }] })), CODIGO.ENTRADA_INVALIDA); // canal não é processador
  await rejeita(nucleo.registrarVenda(c, vendaMista({ pagamentos: [] })), CODIGO.ENTRADA_INVALIDA);
  await rejeita(nucleo.registrarVenda(c, vendaMista({ fonte: { sistema: "SAIPOS" } })), CODIGO.ENTRADA_INVALIDA); // sem id externo não há como deduplicar
  await rejeita(nucleo.registrarVenda(c, vendaMista({ fonte: undefined })), CODIGO.ENTRADA_INVALIDA);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "VENDA" })).length, 0);
});

test("pagar uma obrigação não cria segunda despesa; receber um repasse não cria segunda receita", async () => {
  const { nucleo, c, banco, fornecedor } = await montarComCadastros();
  const { obrigacoes: [ob] } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { fonte: { sistema: "MANUAL", idExterno: "NF-1" } }));
  const venda = await nucleo.registrarVenda(c, vendaMista());
  const antes = { despesas: await total(nucleo, c, "DESPESAS"), receita: await total(nucleo, c, "RECEITA_BRUTA"), lancamentos: (await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" })).length };
  assert.deepEqual(antes, { despesas: 100000, receita: 10000, lancamentos: 2 });

  const pg = await nucleo.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-20", sentido: "SAIDA", valorCentavos: 100000, natureza: "PAGAMENTO", fonte: { sistema: "UNICRED", idExterno: "EXT-1" } });
  await nucleo.registrarLiquidacao(c, { movimentacaoId: pg.movimentacao.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 100000 }] });
  const rp = await nucleo.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-12", sentido: "ENTRADA", valorCentavos: 6000, natureza: "RECEBIMENTO", fonte: { sistema: "UNICRED", idExterno: "EXT-2" } });
  await nucleo.registrarLiquidacao(c, { movimentacaoId: rp.movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: venda.recebiveis[0].id, valorCentavos: 6000 }] });

  assert.equal(await total(nucleo, c, "DESPESAS"), antes.despesas);
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), antes.receita);
  assert.equal((await nucleo.consultarRegistros(c, { tipo: "LANCAMENTO" })).length, antes.lancamentos);
  assert.equal(await total(nucleo, c, "SAIDAS_DE_CAIXA"), 100000);
  assert.equal(await total(nucleo, c, "ENTRADAS_DE_CAIXA"), 6000);

  // Reimportar a mesma linha de extrato e a mesma obrigação não duplica nada.
  const pg2 = await nucleo.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-09-20", sentido: "SAIDA", valorCentavos: 100000, natureza: "PAGAMENTO", fonte: { sistema: "UNICRED", idExterno: "EXT-1" } });
  const ob2 = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { fonte: { sistema: "MANUAL", idExterno: "NF-1" } }));
  assert.ok(pg2.repetido && ob2.repetido);
  assert.equal(pg2.movimentacao.id, pg.movimentacao.id);
  assert.equal(await total(nucleo, c, "SAIDAS_DE_CAIXA"), 100000);
  assert.equal(await total(nucleo, c, "DESPESAS"), 100000);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("composição: todo total é a soma dos registros que o explicam", async () => {
  const { nucleo, c, fornecedor } = await montarComCadastros();
  await nucleo.registrarVenda(c, vendaMista());
  await nucleo.registrarVenda(c, vendaMista({ fonte: { sistema: "SAIPOS", idExterno: "PED-101" }, dataVenda: "2026-09-11" }));
  await nucleo.registrarVenda(c, vendaMista({ fonte: { sistema: "SAIPOS", idExterno: "PED-200" }, dataVenda: "2026-10-01" })); // outra competência
  await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 4500 }));
  for (const indicador of ["RECEITA_BRUTA", "DESPESAS", "DEDUCOES", "RESULTADO_ECONOMICO", "SALDO_A_PAGAR", "SALDO_A_RECEBER", "ENTRADAS_DE_CAIXA", "VARIACAO_DE_CAIXA"]) {
    const comp = await nucleo.consultarComposicao(c, { indicador, competencia: "2026-09" });
    assert.equal(comp.totalCentavos, comp.itens.reduce((a, i) => a + i.sinal * i.valorCentavos, 0), indicador);
    assert.ok(comp.definicao.length > 10);
    assert.ok(comp.itens.every((i) => i.registroId && i.registroTipo && i.parte));
  }
  assert.equal(await total(nucleo, c, "RECEITA_BRUTA"), 20000);
  assert.equal(await total(nucleo, c, "RESULTADO_ECONOMICO"), 15500);
  await rejeita(nucleo.consultarComposicao(c, { indicador: "FORMULA_DA_TELA", competencia: "2026-09" }), CODIGO.ENTRADA_INVALIDA);
});
