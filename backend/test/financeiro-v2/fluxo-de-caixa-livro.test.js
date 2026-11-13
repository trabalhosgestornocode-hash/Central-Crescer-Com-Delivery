// Execução 08B — FLUXO DE CAIXA conferido contra um LIVRO INDEPENDENTE (valores fictícios, escritos à mão).
// O esperado de cada período é somado AQUI, item por item, a partir da lista do livro — nunca pela fórmula do motor.
// Data-base (hoje): 15/10/2026. Roda em memória e no PostgreSQL isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { montarComCadastros, obrigacao } from "./helpers/cenario.js";

// ------------------------------------------------------------------------------------------------ LIVRO (à mão)
// Saldos de referência (início de 01/10): banco 500,00; caixa 100,00. Movimentos de setembro NÃO entram (estão antes).
// REALIZADO em outubro (até hoje):
const REALIZADO = [
  { data: "2026-10-02", conta: "caixa", sentido: "ENTRADA", valor: 3000, o: "venda em dinheiro" },
  { data: "2026-10-03", conta: "banco", sentido: "ENTRADA", valor: 2000, o: "venda Pix" },
  { data: "2026-10-05", conta: "banco", sentido: "SAIDA", valor: 8000, o: "aluguel pago" },
  { data: "2026-10-08", conta: "banco", sentido: "ENTRADA", valor: 4000, o: "recebimento PARCIAL do Stone de setembro" },
  { data: "2026-10-09", conta: "banco", sentido: "SAIDA", valor: 3000, o: "parcela 1/3 de insumos" },
  { data: "2026-10-12", conta: "banco", sentido: "SAIDA", valor: 500, o: "saída sem classificação" },
];
// Transferência interna caixa → banco 25,00 em 06/10: fora do realizado; consolidado inalterado.
const TRANSFERENCIA = { data: "2026-10-06", valor: 2500 };
// Saldos: banco 500 + 20 − 80 + 25 + 40 − 30 − 5 = 470,00; caixa 100 + 30 − 25 = 105,00; consolidado 575,00 (início 600,00).
const SALDO = { bancoHoje: 47000, caixaHoje: 10500, consolidadoInicio: 60000, consolidadoHoje: 57500 };
// PREVISTO de hoje até 31/10:
//   energia 12,00 vencida em 10/10 e não paga → aparece HOJE como "vencida em aberto";
//   água 7,00 vence 25/10; internet RECORRENTE (dia 20, último 15,00) → 20/10 ESTIMADA (não é dívida);
//   recebível com previsão documentada 50,00 em 28/10; Stone restante 20,00 SEM previsão → nenhuma data inventada;
//   parcelas 2/3 e 3/3 vencem em novembro e dezembro (fora); a 1/3 já paga NÃO volta.
const PREVISTO = [
  { data: "2026-10-15", sentido: "SAIDA", valor: 1200, natureza: "CONTA_VENCIDA_EM_ABERTO" },
  { data: "2026-10-20", sentido: "SAIDA", valor: 1500, natureza: "RECORRENCIA_PREVISTA", estimado: true },
  { data: "2026-10-25", sentido: "SAIDA", valor: 700, natureza: "CONTA_A_PAGAR" },
  { data: "2026-10-28", sentido: "ENTRADA", valor: 5000 },
];
// Projeção em 31/10 = 575,00 + 50,00 − 12,00 − 15,00 − 7,00 = 591,00 (parcial: estimativa + recebível sem previsão).
const PROJETADO_31_10 = 59100;
const SEM_PREVISAO = 2000;

const somaDoLivro = (lista, sentido, de, ate) => lista.filter((i) => i.sentido === sentido && i.data >= de && i.data <= ate).reduce((s, i) => s + i.valor, 0);

async function cenario() {
  const m = await montarComCadastros();
  const { nucleo: n, c, banco, caixa, fornecedor, cofre } = m;
  const pagar = async (o, valor, data) => {
    const mov = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: data, sentido: "SAIDA", valorCentavos: valor, natureza: "PAGAMENTO" })).movimentacao;
    await n.registrarLiquidacao(c, { movimentacaoId: mov.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: o.id, valorCentavos: valor }] });
  };
  // Setembro (antes da âncora): internet recorrente paga, venda Stone a receber.
  const internet = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 1500, categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS", descricao: "Internet", competencia: "2026-09", dataEmissao: "2026-09-01", vencimento: "2026-09-20", recorrencia: { periodicidade: "MENSAL", diaDoMes: 20 } }))).obrigacoes[0];
  await pagar(internet, 1500, "2026-09-20");
  const stone = (await n.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-25", brutoCentavos: 6000, fonte: { sistema: "MANUAL", idExterno: "FX-1" }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 6000 }] })).recebiveis[0];
  // Âncoras.
  await n.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-01", valorCentavos: 50000 });
  await n.registrarSaldoDeConta(c, { contaId: caixa.id, data: "2026-10-01", valorCentavos: 10000 });
  // Outubro realizado.
  await n.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-10-02", brutoCentavos: 3000, fonte: { sistema: "MANUAL", idExterno: "FX-2" }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 3000, contaId: caixa.id }] });
  await n.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-10-03", brutoCentavos: 2000, fonte: { sistema: "MANUAL", idExterno: "FX-3" }, pagamentos: [{ forma: "PIX", valorCentavos: 2000, contaId: banco.id }] });
  const aluguel = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 8000, descricao: "Aluguel de outubro", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-05" }))).obrigacoes[0];
  await pagar(aluguel, 8000, "2026-10-05");
  await n.registrarTransferencia(c, { contaOrigemId: caixa.id, contaDestinoId: banco.id, valorCentavos: TRANSFERENCIA.valor, dataEfetiva: TRANSFERENCIA.data });
  const credito = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-10-08", sentido: "ENTRADA", valorCentavos: 4000, natureza: "RECEBIMENTO" })).movimentacao;
  await n.registrarLiquidacao(c, { movimentacaoId: credito.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: stone.id, valorCentavos: 4000 }] });
  const parcelas = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 9000, parcelas: 3, descricao: "Insumos parcelados", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-09" }))).obrigacoes;
  await pagar(parcelas[0], 3000, "2026-10-09");
  await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-10-12", sentido: "SAIDA", valorCentavos: 500, natureza: "OUTRA" });
  // Pendentes.
  await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 1200, categoria: "EMBALAGENS", descricao: "Energia", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-10" }));
  await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 700, categoria: "EMBALAGENS", descricao: "Água", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-25" }));
  const g = await cofre.guardar(c, { conteudo: new TextEncoder().encode("%PDF-1.4\n% agenda sintética de repasse\n%%EOF\n"), tipoMime: "application/pdf" });
  const agenda = (await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-10-10", descricao: "Agenda de repasse" })).documento;
  await n.registrarRecebivel(c, { processador: "IFOOD", canal: "IFOOD", brutoCentavos: 5000, competencia: "2026-10", dataPrevista: "2026-10-28", documentoIds: [agenda.id], fonte: { sistema: "IFOOD", idExterno: "FX-REP" } });
  return { ...m, parcelas };
}

test("08B — fluxo de caixa = livro independente: mês, semana, dia, período, conta e consolidado; projeção e invariantes", async () => {
  const { nucleo: n, c } = await cenario();
  const out = await n.consultarFluxoDeCaixa(c, { inicio: "2026-10-01", fim: "2026-10-31", granularidade: "MES" });
  // Realizado do mês.
  assert.deepEqual([out.realizado.entradasCentavos, out.realizado.saidasCentavos], [somaDoLivro(REALIZADO, "ENTRADA", "2026-10-01", "2026-10-15"), somaDoLivro(REALIZADO, "SAIDA", "2026-10-01", "2026-10-15")]);
  assert.deepEqual([out.realizado.entradasCentavos, out.realizado.saidasCentavos], [9000, 11500]);
  assert.equal(out.realizado.transferenciasInternasAnuladasCentavos, TRANSFERENCIA.valor);
  assert.deepEqual([out.saldoInicialCentavos, out.saldoAtualCentavos, out.realizado.saldoFinalCentavos], [SALDO.consolidadoInicio, SALDO.consolidadoHoje, SALDO.consolidadoHoje]);
  // Previsto do mês: itens, naturezas, nada inventado, parcela paga não volta.
  const itens = out.previsto.itens.map((i) => ({ data: i.data, sentido: i.sentido, valor: i.valorCentavos, natureza: i.natureza, estimado: i.estimado }));
  for (const e of PREVISTO) assert.ok(itens.some((i) => i.data === e.data && i.sentido === e.sentido && i.valor === e.valor && (!e.natureza || i.natureza === e.natureza)), `previsto ${e.data} ${e.valor}`);
  assert.equal(itens.length, PREVISTO.length, "nenhum previsto além do livro (a parcela 1/3 paga não volta)");
  assert.equal(out.previsto.entradasCentavos, somaDoLivro(PREVISTO, "ENTRADA", "2026-10-15", "2026-10-31"));
  assert.equal(out.previsto.saidasCentavos, somaDoLivro(PREVISTO, "SAIDA", "2026-10-15", "2026-10-31"));
  assert.equal(out.projecao.saldoProjetadoCentavos, PROJETADO_31_10);
  assert.equal(out.projecao.parcial, true);
  assert.ok(out.projecao.motivos.includes("RECEBIVEIS_SEM_PREVISAO_CONFIAVEL") && out.projecao.motivos.includes("INCLUI_RECORRENCIAS_ESTIMADAS"));
  assert.equal(out.semPrevisao.saldoCentavos, SEM_PREVISAO);
  assert.ok(out.semPrevisao.itens.every((i) => !i.vencimentoPrevisto), "recebível sem previsão não ganha data");
  // Recorrência estimada NÃO vira dívida: contas a pagar não a contém.
  const ap = await n.consultarContasAPagar(c, {});
  assert.equal(ap.totais.saldoCentavos, 1200 + 700 + 3000 + 3000, "pendentes reais: energia, água e parcelas 2/3 e 3/3");
  // Séries por DIA e SEMANA e um período personalizado: cada bucket = soma do livro dentro dos limites devolvidos.
  for (const granularidade of ["DIA", "SEMANA"]) {
    const s = await n.consultarFluxoDeCaixa(c, { inicio: "2026-10-01", fim: "2026-10-31", granularidade });
    let acumulado = 0;
    for (const b of s.serie) {
      const ent = somaDoLivro(REALIZADO, "ENTRADA", b.inicio, b.fim < "2026-10-15" ? b.fim : "2026-10-15");
      const sai = somaDoLivro(REALIZADO, "SAIDA", b.inicio, b.fim < "2026-10-15" ? b.fim : "2026-10-15");
      assert.deepEqual([b.realizado.entradasCentavos, b.realizado.saidasCentavos], [ent, sai], `${granularidade} ${b.inicio}`);
      acumulado += ent - sai;
      if (b.inicio <= "2026-10-15") assert.equal(b.saldoRealizadoCentavos, SALDO.consolidadoInicio + acumulado, `${granularidade} saldo ${b.inicio}`);
      assert.deepEqual([b.previsto.entradasCentavos, b.previsto.saidasCentavos], [somaDoLivro(PREVISTO, "ENTRADA", b.inicio, b.fim), somaDoLivro(PREVISTO, "SAIDA", b.inicio, b.fim)], `${granularidade} previsto ${b.inicio}`);
    }
  }
  const p = await n.consultarFluxoDeCaixa(c, { inicio: "2026-10-03", fim: "2026-10-09", granularidade: "MES" });
  assert.deepEqual([p.realizado.entradasCentavos, p.realizado.saidasCentavos], [somaDoLivro(REALIZADO, "ENTRADA", "2026-10-03", "2026-10-09"), somaDoLivro(REALIZADO, "SAIDA", "2026-10-03", "2026-10-09")]);
  // Conta individual e consolidado.
  const cb = await n.consultarCaixaEBancos(c, { inicio: "2026-10-01", fim: "2026-10-15" });
  const conta = (tipo) => cb.contas.find((x) => x.tipo === tipo);
  assert.deepEqual([conta("BANCARIA").saldoFinalCentavos, conta("CAIXA_FISICO").saldoFinalCentavos], [SALDO.bancoHoje, SALDO.caixaHoje]);
  assert.equal(conta("BANCARIA").saldoFinalCentavos + conta("CAIXA_FISICO").saldoFinalCentavos, SALDO.consolidadoHoje, "transferência interna não altera o consolidado");
  // Recebimento de outubro não é caixa de setembro; setembro sem âncora tem saldo DESCONHECIDO (não zero).
  const set = await n.consultarFluxoDeCaixa(c, { inicio: "2026-09-01", fim: "2026-09-30", granularidade: "MES" });
  assert.deepEqual([set.realizado.entradasCentavos, set.realizado.saidasCentavos], [0, 1500]);
  assert.equal(set.saldoInicialCentavos, null);
});

test("08B — fluxo de caixa: saldo NEGATIVO aparece como é; conta sem âncora deixa a projeção desconhecida (nunca zero)", async () => {
  const { nucleo: n, c, banco, caixa } = await montarComCadastros();
  await n.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-01", valorCentavos: 1000 });
  await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: "2026-10-05", sentido: "SAIDA", valorCentavos: 1500, natureza: "OUTRA" });
  const cb = await n.consultarCaixaEBancos(c, { inicio: "2026-10-01", fim: "2026-10-15", contaId: banco.id });
  assert.equal(cb.contas[0].saldoFinalCentavos, -500, "saldo negativo não é escondido nem zerado");
  // O caixa físico não tem âncora → consolidado desconhecido → projeção desconhecida e marcada como parcial.
  const f = await n.consultarFluxoDeCaixa(c, { inicio: "2026-10-01", fim: "2026-10-31", granularidade: "MES" });
  assert.equal(f.saldoAtualCentavos, null);
  assert.equal(f.projecao.saldoProjetadoCentavos, null);
  assert.ok(f.projecao.motivos.includes("SALDO_DISPONIVEL_DESCONHECIDO"));
  assert.ok(caixa.id);
});
