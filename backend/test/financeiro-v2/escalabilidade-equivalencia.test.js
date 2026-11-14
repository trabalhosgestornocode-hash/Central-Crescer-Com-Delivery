// Execução 09C — PROVA DE EQUIVALÊNCIA das cargas dirigidas novas (Caixa e Bancos com resumos diários somados no banco,
// Contas a Receber por competência e POSIÇÃO A RECEBER no fim da competência) contra a carga COMPLETA de referência,
// no MESMO repositório, mês a mês, em históricos de 1, 3, 12 e 48 meses. Roda em memória e, com FV2_REPOSITORIO=postgres,
// no banco isolado. Dados SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, UNI_A2, ctx, montarComCadastros, prepararHomologacao } from "./helpers/cenario.js";

const relogio = () => AGORA; // data-base 2026-10-15
const mesesAte = (ultimo, qtd) => Array.from({ length: qtd }, (_, i) => { const [a, m] = ultimo.split("-").map(Number); const t = a * 12 + (m - 1) - (qtd - 1 - i); return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; });
const ultimoDia = (comp) => { const [a, m] = comp.split("-").map(Number); return `${comp}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`; };

/**
 * Histórico sintético de `meses` meses terminando em 2026-09 (mais outubro, o mês corrente):
 * vendas no cartão (recebíveis), repasses agrupados no mês seguinte, pagamento parcial que nunca completa (títulos antigos
 * em aberto), transferências caixa→banco, saldo informado no fim de cada mês (às vezes divergente), estorno parcial de
 * liquidação, movimento retroativo, competência homologada e outra reaberta, e uma segunda unidade.
 */
async function historico(meses) {
  const m = await montarComCadastros();
  const { nucleo: n, c, banco, caixa } = m;
  const comps = [...mesesAte("2026-09", meses), "2026-10"];
  await n.registrarSaldoDeConta(c, { contaId: banco.id, data: `${comps[0]}-01`, valorCentavos: 100000 });
  await n.registrarSaldoDeConta(c, { contaId: caixa.id, data: `${comps[0]}-01`, valorCentavos: 20000 });
  // conta a pagar ANTIGA paga pela metade no próprio mês (fica em aberto; o pagamento está fora dos meses seguintes)
  const ob = (await n.registrarObrigacao(c, { contraparteId: m.fornecedor.id, valorOriginalCentavos: 5000, categoria: "INSUMOS", descricao: "Compra antiga (sintética)", competencia: comps[0], dataEmissao: `${comps[0]}-02`, vencimento: `${comps[0]}-20` })).obrigacoes[0];
  const pagto = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: `${comps[0]}-25`, sentido: "SAIDA", valorCentavos: 2000, natureza: "PAGAMENTO" })).movimentacao;
  await n.registrarLiquidacao(c, { movimentacaoId: pagto.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: ob.id, valorCentavos: 2000 }] });
  let anteriores = [];
  const liquidacoes = [];
  for (const [i, comp] of comps.entries()) {
    // DUAS tarifas no PRIMEIRO dia do mês, mesma conta e sentido (o resumo diário soma 2 movimentos num dia; o 1º dia é a
    // fronteira entre o resumo anterior ao período e os movimentos do período). Saída sem classificação é pendência que
    // impede homologar: não nos meses que o cenário homologa.
    if (comp !== "2026-07" && comp !== "2026-08") for (const v of [13, 17]) await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: `${comp}-01`, sentido: "SAIDA", valorCentavos: v, natureza: "OUTRA", descricao: "Tarifa (sintética)" });
    // repasse AGRUPADO dos recebíveis do mês anterior (um deles só pela METADE: fica em aberto para sempre)
    if (anteriores.length) {
      const parcial = i % 4 === 1 ? anteriores[0] : null;
      const alocacoes = anteriores.map((r) => ({ alvoTipo: "RECEBIVEL", alvoId: r.id, valorCentavos: r === parcial ? Math.floor(r.saldoCentavos / 2) : r.saldoCentavos }));
      const total = alocacoes.reduce((s, a) => s + a.valorCentavos, 0);
      const mov = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: `${comp}-10`, sentido: "ENTRADA", valorCentavos: total, natureza: "RECEBIMENTO" })).movimentacao;
      const r = await n.registrarLiquidacao(c, { movimentacaoId: mov.id, alocacoes });
      liquidacoes.push(...(r.liquidacoes ?? []));
    }
    if (comp === "2026-10") break;
    anteriores = [];
    for (let k = 0; k < 3; k += 1) {
      const v = await n.registrarVenda(c, { canal: "BALCAO", dataVenda: `${comp}-0${k + 3}`, brutoCentavos: 1000 + 37 * k + i, fonte: { sistema: "MANUAL", idExterno: `H-${comp}-${k}` }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 1000 + 37 * k + i }] });
      anteriores.push(v.recebiveis[0]);
    }
    if (i % 3 === 2) await n.registrarTransferencia(c, { contaOrigemId: caixa.id, contaDestinoId: banco.id, valorCentavos: 500, dataEfetiva: `${comp}-12`, descricao: "Depósito (sintético)" });
    // saldo informado no fim do mês: igual ao calculado (CONFERE) e, a cada 6 meses, divergente (+R$ 1,00)
    const cb = await n.consultarCaixaEBancos(c, { inicio: `${comp}-01`, fim: ultimoDia(comp) });
    const calc = cb.contas.find((x) => x.id === banco.id).saldoFinalCentavos;
    if (calc !== null) await n.registrarSaldoDeConta(c, { contaId: banco.id, data: ultimoDia(comp), referencia: "FIM_DO_DIA", valorCentavos: calc + (i % 6 === 5 ? 100 : 0) });
  }
  // estorno PARCIAL de uma liquidação antiga, feito hoje (2026-10-15): não muda a posição dos meses anteriores
  if (liquidacoes.length > 1) await n.estornarLiquidacao(c, { liquidacaoId: liquidacoes[0].id, valorCentavos: 100, justificativa: "Estorno sintético parcial." });
  // movimento RETROATIVO (lançado agora com data num mês antigo e aberto)
  const meio = comps[Math.floor((comps.length - 1) / 2)]; // nunca o mês corrente (data no futuro)
  await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: `${meio}-20`, sentido: "SAIDA", valorCentavos: 77, natureza: "OUTRA", descricao: "Retroativo sintético" });
  // movimento ESTORNADO (não entra em saldo nem em resumo diário) e recebível CANCELADO (não entra na contagem nem na posição)
  const errado = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: `${meio}-21`, sentido: "SAIDA", valorCentavos: 55, natureza: "OUTRA", descricao: "Lançado por engano" })).movimentacao;
  await n.estornarMovimentacao(c, { movimentacaoId: errado.id, justificativa: "Duplicado (sintético)." });
  const avulso = await n.registrarRecebivel(c, { processador: "STONE", brutoCentavos: 700, competencia: meio, descricao: "Recebível registrado por engano (sintético)" });
  await n.cancelarRecebivel(c, { recebivelId: (avulso.recebivel ?? avulso).id, justificativa: "Registrado por engano (sintético)." });
  // outra unidade (escopo próprio): não pode aparecer na unidade A
  const c2 = ctx(ORG_A, UNI_A2);
  const banco2 = await n.configurarContaFinanceira(c2, { tipo: "BANCARIA", nome: "Banco A2" });
  await n.registrarSaldoDeConta(c2, { contaId: banco2.id, data: `${comps[0]}-01`, valorCentavos: 5000 });
  await n.registrarVenda(c2, { canal: "BALCAO", dataVenda: `${comps[0]}-05`, brutoCentavos: 999, fonte: { sistema: "MANUAL", idExterno: "A2-1" }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 999 }] });
  return { ...m, comps, c2 };
}

async function conferir(meses, { homologar = false } = {}) {
  const h = await historico(meses);
  const { nucleo: dirigido, c, comps } = h;
  if (homologar && comps.length > 3) {
    // Meses DENTRO da vigência da metodologia (antes dela a homologação é recusada, como deve) e sem a divergência de
    // saldo proposital: julho homologado; agosto homologado e REABERTO.
    for (const comp of ["2026-07", "2026-08"]) {
      await prepararHomologacao(dirigido, c, comp);
      await dirigido.alterarEstadoDaCompetencia(c, { competencia: comp, novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Sintética.", confirmar: true });
    }
    await dirigido.alterarEstadoDaCompetencia(c, { competencia: "2026-08", novoEstado: "ABERTA", confirmar: true, justificativa: "Reabertura sintética." });
  }
  const completo = criarNucleoFinanceiro({ repositorio: h.repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio, cofre: h.cofre, cargaCompletaDeReferencia: true });
  for (const comp of comps) {
    const f = { inicio: `${comp}-01`, fim: ultimoDia(comp) };
    assert.deepEqual(await dirigido.consultarCaixaEBancos(c, { ...f, tamanho: 100 }), await completo.consultarCaixaEBancos(c, { ...f, tamanho: 100 }), `caixa ${comp}`);
    assert.deepEqual(await dirigido.consultarCaixaEBancos(c, { ...f, contaId: h.banco.id, tamanho: 100 }), await completo.consultarCaixaEBancos(c, { ...f, contaId: h.banco.id, tamanho: 100 }), `caixa banco ${comp}`);
    assert.deepEqual(await dirigido.consultarContasAReceber(c, { competencia: comp, tamanho: 100 }), await completo.consultarContasAReceber(c, { competencia: comp, tamanho: 100 }), `a receber ${comp}`);
    assert.deepEqual(await dirigido.consultarPosicaoAReceber(c, { competencia: comp, tamanho: 100 }), await completo.consultarPosicaoAReceber(c, { competencia: comp, tamanho: 100 }), `posição ${comp}`);
    assert.deepEqual(await dirigido.consultarResumoFinanceiro(c, { competencia: comp }), await completo.consultarResumoFinanceiro(c, { competencia: comp }), `visão geral ${comp}`);
  }
  // período que atravessa meses (até 3 meses)
  const f = { inicio: `${comps[Math.max(0, comps.length - 3)]}-15`, fim: "2026-10-14" };
  assert.deepEqual(await dirigido.consultarCaixaEBancos(c, { ...f, tamanho: 100 }), await completo.consultarCaixaEBancos(c, { ...f, tamanho: 100 }), "caixa entre meses");
  return h;
}

for (const meses of [1, 3, 12]) {
  test(`09C — equivalência dirigida × completa, mês a mês: histórico de ${meses} mês(es)`, { timeout: 600000 }, async () => { await conferir(meses, { homologar: meses >= 12 }); });
}
test("09C — equivalência dirigida × completa: histórico de 48 meses (com competência homologada e outra reaberta)", { timeout: 1800000 }, async () => { await conferir(48, { homologar: true }); });

test("09C — posição histórica a receber: pagamento e estorno posteriores não mudam o passado; título antigo em aberto não se perde; hoje = saldo gravado", { timeout: 600000 }, async () => {
  const h = await historico(12);
  const { nucleo: n, c, comps } = h;
  const set = await n.consultarPosicaoAReceber(c, { competencia: "2026-09", tamanho: 100 });
  const out = await n.consultarPosicaoAReceber(c, { competencia: "2026-10", tamanho: 100 });
  // recebíveis de setembro pagos em outubro: em aberto em 30/09, recebidos depois
  const deSetembro = set.itens.filter((t) => t.competencia === "2026-09");
  assert.equal(deSetembro.length, 3);
  assert.ok(deSetembro.every((t) => t.recebidoAteADataCentavos === 0 && t.recebidoDepoisCentavos > 0));
  assert.ok(!out.itens.some((t) => t.competencia === "2026-09" && t.saldoNaDataCentavos === t.esperadoNaDataCentavos), "pagos em outubro saem da posição de outubro");
  // títulos ANTIGOS ainda pendentes (pagos pela metade) aparecem em todas as posições posteriores
  const antigos = out.itens.filter((t) => t.competencia < comps[comps.length - 4]);
  assert.ok(antigos.length > 0, "há títulos antigos em aberto");
  for (const t of antigos) assert.ok(set.itens.some((x) => x.id === t.id), "o título antigo também está em aberto em 30/09");
  // posição no mês corrente (D = 31/10, depois de todos os fatos) = saldo gravado de cada título
  assert.ok(out.itens.every((t) => t.saldoNaDataCentavos === t.saldoAtualCentavos), "hoje, posição = saldo gravado");
  // o estorno parcial de HOJE (R$ 1,00) muda só a posição do mês corrente
  const estornado = out.itens.find((t) => t.competencia === comps[0]);
  const antes = set.itens.find((t) => t.id === estornado?.id);
  assert.ok(estornado && antes, "o título com liquidação estornada está em aberto nas duas posições");
  assert.equal(estornado.saldoNaDataCentavos - antes.saldoNaDataCentavos, 100);
  const abertosHoje = (await n.consultarContasAReceber(c, { tamanho: 100 })).itens.filter((t) => t.saldoCentavos > 0 && t.situacao !== "CANCELADO");
  assert.deepEqual(out.itens.map((t) => t.id).sort(), abertosHoje.map((t) => t.id).sort());
  // outra unidade nunca aparece
  assert.ok(!out.itens.some((t) => t.competencia && h.c2 && t.id === undefined));
  const daA2 = await n.consultarPosicaoAReceber(h.c2, { competencia: "2026-10", tamanho: 100 });
  assert.equal(daA2.itens.length, 1);
  assert.ok(!daA2.itens.some((t) => out.itens.some((x) => x.id === t.id)));
});
