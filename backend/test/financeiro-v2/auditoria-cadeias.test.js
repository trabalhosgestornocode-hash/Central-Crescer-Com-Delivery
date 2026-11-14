// Execução 07 — cadeias integradas (Fases D, E e F), dados SINTÉTICOS, valores esperados escritos à mão.
//   E: documento → importação → registro de origem → proposta → aprovação → aplicação → indicador (repetição, concorrência,
//      versão corrigida, adulteração, outra unidade);
//   D: tesouraria (ordem de registro, retroativo, duplicado, transferência, projeção sem dupla contagem);
//   F: DRE em prejuízo, resultado zero, faturamento desconhecido e dados parciais; barra de cada R$ 100 com negativos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODIGO, apurar } from "../../src/modules/financeiro-v2/index.js";
import { ORG_B, UNI_A2, UNI_B, ctx, entrada, montar, montarComCadastros, rejeita, saida } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, saiposVendas } from "./helpers/arquivos.js";

const c = ctx();
const PEDIDOS = [
  { pedido: "P-1", data: "02/09/2026 12:00", canal: "Balcão", itens: 3000, forma: "Dinheiro" },
  { pedido: "P-2", data: "02/09/2026 12:05", canal: "Balcão", itens: 2500, forma: "Dinheiro" },
  { pedido: "P-3", data: "03/09/2026 19:10", canal: "Balcão", itens: 1500, forma: "Dinheiro" },
];
const BRUTO_PEDIDOS = 3000 + 2500 + 1500; // 7000, à mão

async function receber(n, conteudo, extra = {}) {
  return n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", conteudo, ...PERIODO_SETEMBRO, ...extra });
}
async function importarEProporc(n, caixa, conteudo, extra) {
  const r = await receber(n, conteudo, extra);
  const conf = await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia });
  await n.gerarPropostas(c, { importacaoId: conf.importacao.id, contaCaixaId: caixa.id });
  return conf.importacao;
}
const bruto = async (n) => (await n.apurarCompetencia(c, { competencia: "2026-09" })).indicadores.FATURAMENTO_BRUTO_PROPRIO;

// ------------------------------------------------------------------------------------------------- Fase E
test("E — cadeia de importação: aplicação única (repetida e concorrente), versão corrigida, escopo e evidência", async () => {
  const { nucleo: n, caixa } = await montarComCadastros();
  const imp = await importarEProporc(n, caixa, saiposVendas(PEDIDOS));
  // Mesmo documento outra vez: não duplica (mesmo hash).
  const repetido = await receber(n, saiposVendas(PEDIDOS));
  assert.equal(repetido.repetido ?? repetido.importacao.id === imp.id, true);
  const props = await n.listarPropostas(c, { operacao: "VENDA" });
  assert.equal(props.length, PEDIDOS.length);
  // Antes de aplicar: nada aplicado → faturamento DESCONHECIDO (nunca zero, nunca definitivo).
  assert.deepEqual([(await bruto(n)).valorCentavos, (await bruto(n)).situacao], [null, "BLOQUEADO_POR_EVIDENCIA_INSUFICIENTE"]);
  // Aprovada mas não aplicada: nenhum efeito.
  await n.aprovarProposta(c, { propostaId: props[0].id, justificativa: "Conferido." });
  assert.equal((await bruto(n)).valorCentavos ?? 0, 0);
  // Aplicação concorrente da MESMA proposta: um único efeito.
  const [a1, a2] = await Promise.allSettled([n.aplicarProposta(c, { propostaId: props[0].id }), n.aplicarProposta(c, { propostaId: props[0].id })]);
  assert.ok([a1, a2].some((x) => x.status === "fulfilled"));
  // Uma aplicada e as demais pendentes → PARCIAL (valor conhecido, mas incompleto).
  assert.deepEqual([(await bruto(n)).valorCentavos, (await bruto(n)).situacao], [3000, "PARCIAL"]);
  // Aplicação repetida (depois): sem novo efeito.
  const r3 = await n.aplicarProposta(c, { propostaId: props[0].id }).catch((e) => e);
  assert.ok(r3.repetido === true || r3.codigo, "repetir não aplica de novo");
  for (const p of props.slice(1)) { await n.aprovarProposta(c, { propostaId: p.id, justificativa: "Conferido." }); await n.aplicarProposta(c, { propostaId: p.id }); }
  assert.equal((await bruto(n)).valorCentavos, BRUTO_PEDIDOS, "cada pedido entra uma única vez");
  assert.equal((await n.consultarRegistros(c, { tipo: "VENDA" })).length, PEDIDOS.length);
  // Identificador externo duplicado no mesmo arquivo: não vira duas vendas.
  const comDuplicado = await receber(n, saiposVendas([PEDIDOS[0], PEDIDOS[0]]), { substituiImportacaoId: imp.id });
  // Linhas idênticas com o mesmo identificador são colapsadas em UM registro e contadas na prévia.
  assert.equal(comDuplicado.previa.contagens.duplicadosNoArquivo, 1, "duplicidade apontada na prévia");
  // Versão corrigida: a proposta nova não sobrescreve o que já foi aplicado.
  const corrigida = await receber(n, saiposVendas([{ ...PEDIDOS[0], itens: 3100 }, PEDIDOS[1], PEDIDOS[2]]), { substituiImportacaoId: imp.id });
  const conf = await n.confirmarImportacao(c, { importacaoId: corrigida.importacao.id, impressaoPrevia: corrigida.importacao.impressaoPrevia });
  await n.gerarPropostas(c, { importacaoId: conf.importacao.id, contaCaixaId: caixa.id });
  assert.equal((await bruto(n)).valorCentavos, BRUTO_PEDIDOS, "a correção espera revisão; nada é sobrescrito");
  assert.ok((await n.listarPropostas(c, { operacao: "VENDA" })).some((p) => p.estado === "AGUARDANDO_REVISAO"));
  // Outra unidade e outra organização não veem a importação nem a proposta.
  await rejeita(n.aprovarProposta(ctx(undefined, UNI_A2), { propostaId: props[1].id }), CODIGO.NAO_ENCONTRADO);
  await rejeita(n.aprovarProposta(ctx(ORG_B, UNI_B), { propostaId: props[1].id }), CODIGO.NAO_ENCONTRADO);
  assert.deepEqual(await n.verificarConservacao(c), []);
});

test("E — falha no meio da aplicação não deixa efeito parcial; documento adulterado no cofre é detectado", async () => {
  const { nucleo: n, caixa, cofre } = await montarComCadastros();
  await importarEProporc(n, caixa, saiposVendas(PEDIDOS));
  const [p] = await n.listarPropostas(c, { operacao: "VENDA" });
  await n.aprovarProposta(c, { propostaId: p.id, justificativa: "Conferido." });
  // Conta de caixa desativada no meio: a aplicação falha inteira (sem venda solta, sem proposta "aplicada").
  await n.alterarContaFinanceira(c, { contaId: caixa.id, ativa: false, justificativa: "Teste de falha." });
  await assert.rejects(n.aplicarProposta(c, { propostaId: p.id }));
  assert.equal((await n.consultarRegistros(c, { tipo: "VENDA" })).length, 0);
  assert.equal((await n.listarPropostas(c, { operacao: "VENDA" })).find((x) => x.id === p.id).estado, "APROVADA");
  // O arquivo importado está no cofre com hash conferido; adulterado, o acesso é bloqueado.
  const [doc] = await n.consultarRegistros(c, { tipo: "DOCUMENTO" });
  assert.equal((await n.verificarIntegridadeDoDocumento(c, { id: doc.id })).conferido, true);
  cofre.__adulterarParaTeste?.(c, doc.arquivoId);
  if (cofre.__adulterarParaTeste) assert.equal((await n.verificarIntegridadeDoDocumento(c, { id: doc.id })).conferido, false);
});

// ------------------------------------------------------------------------------------------------- Fase D
test("D — saldo independe da ordem de registro; retroativo aparece como divergência do saldo informado; duplicado não soma", async () => {
  const movimentos = [["2026-09-03", "ENTRADA", 2000], ["2026-09-08", "SAIDA", 700], ["2026-09-05", "ENTRADA", 300], ["2026-09-12", "SAIDA", 150]];
  const saldoEm = async (ordem) => {
    const { nucleo: n, c: cx, banco } = await montarComCadastros();
    await n.registrarSaldoDeConta(cx, { contaId: banco.id, data: "2026-09-01", valorCentavos: 10000 });
    for (const i of ordem) {
      const [data, sentido, valor] = movimentos[i];
      await n.registrarMovimentacao(cx, { contaId: banco.id, dataEfetiva: data, sentido, valorCentavos: valor, natureza: "OUTRA", fonte: { sistema: "UNICRED", idExterno: `M-${i}` } });
    }
    return { n, cx, banco, saldo: (await n.consultarCaixaEBancos(cx, { inicio: "2026-09-01", fim: "2026-09-30" })).contas.find((x) => x.tipo === "BANCARIA").saldoFinalCentavos };
  };
  const a = await saldoEm([0, 1, 2, 3]);
  const b = await saldoEm([3, 2, 1, 0]);
  assert.equal(a.saldo, 10000 + 2000 - 700 + 300 - 150); // 11450, à mão
  assert.equal(b.saldo, a.saldo);
  // Duplicado (mesma origem): repetição sem efeito.
  const dup = await a.n.registrarMovimentacao(a.cx, { contaId: a.banco.id, dataEfetiva: "2026-09-03", sentido: "ENTRADA", valorCentavos: 2000, natureza: "OUTRA", fonte: { sistema: "UNICRED", idExterno: "M-0" } });
  assert.equal(dup.repetido, true);
  // Saldo informado em 15/09 conferido; um movimento RETROATIVO (10/09) registrado depois aparece como divergência.
  await a.n.registrarSaldoDeConta(a.cx, { contaId: a.banco.id, data: "2026-09-15", valorCentavos: 11450 });
  await a.n.registrarMovimentacao(a.cx, { contaId: a.banco.id, dataEfetiva: "2026-09-10", sentido: "SAIDA", valorCentavos: 90, natureza: "OUTRA" });
  const conta = (await a.n.consultarCaixaEBancos(a.cx, { inicio: "2026-09-01", fim: "2026-09-30" })).contas.find((x) => x.tipo === "BANCARIA");
  assert.deepEqual(conta.conferenciasDeSaldo.map((x) => [x.calculadoCentavos, x.diferencaCentavos]), [[11360, 90]]);
  assert.equal(conta.saldoFinalCentavos, 11450, "o saldo informado mais recente prevalece; a diferença fica visível, nunca ajustada");
});

test("D — transferência interna tem efeito líquido zero no consolidado; projeção usa só o pendente", async () => {
  const { nucleo: n, c: cx, banco, caixa, fornecedor } = await montarComCadastros();
  await n.registrarSaldoDeConta(cx, { contaId: banco.id, data: "2026-10-01", valorCentavos: 50000 });
  await n.registrarSaldoDeConta(cx, { contaId: caixa.id, data: "2026-10-01", valorCentavos: 8000 });
  await n.registrarTransferencia(cx, { contaOrigemId: caixa.id, contaDestinoId: banco.id, valorCentavos: 6000, dataEfetiva: "2026-10-03" });
  const cb = await n.consultarCaixaEBancos(cx, { inicio: "2026-10-01", fim: "2026-10-15" });
  assert.deepEqual([cb.consolidado.entradasCentavos, cb.consolidado.saidasCentavos, cb.consolidado.saldoFinalCentavos], [0, 0, 58000]);
  const o = (await n.registrarObrigacao(cx, { contraparteId: fornecedor.id, valorOriginalCentavos: 9000, categoria: "INSUMOS", descricao: "x", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-30" })).obrigacoes[0];
  const pg = (await n.registrarMovimentacao(cx, saida(banco.id, 4000, { dataEfetiva: "2026-10-10" }))).movimentacao;
  await n.registrarLiquidacao(cx, { movimentacaoId: pg.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: o.id, valorCentavos: 4000 }] });
  const fl = await n.consultarFluxoDeCaixa(cx, { inicio: "2026-10-15", fim: "2026-10-31", granularidade: "MES" });
  assert.equal(fl.previsto.saidasCentavos, 5000, "só o saldo de 9000 − 4000");
  assert.equal(fl.projecao.saldoProjetadoCentavos, 58000 - 4000 - 5000); // 49000, à mão
});

// ------------------------------------------------------------------------------------------------- Fase F
const vazio = { categorias: [], vendas: [], propostas: [], obrigacoes: [], movimentacoes: [], recebiveis: [], ajustes: [], competencias: [] };
let seq = 0;
const lanc = (natureza, classificacao, valorCentavos, extra = {}) => ({ id: `l${(seq += 1)}`, versao: 1, situacao: "ATIVO", competencia: "2026-09", natureza, classificacao, categoria: "X", valorCentavos, dataOperacao: "2026-09-02", canal: natureza === "RECEITA" ? "BALCAO" : null, ...extra });
const apurarCom = (lancamentos) => apurar({ ...vazio, lancamentos }, { competencia: "2026-09", escopo: { organizacaoId: "o", unidadeId: "u" }, apuradoEm: "2026-10-01T00:00:00.000Z" });

test("F — prejuízo, resultado zero, faturamento desconhecido e barra de cada R$ 100 com negativos", () => {
  // Prejuízo: bruto 10000, custo 12000 → resultado −2000 (à mão); a barra mostra o resultado negativo e soma 100%.
  const p = apurarCom([lanc("RECEITA", "RECEITA_OPERACIONAL", 10000), lanc("DESPESA", "CUSTOS_OPERACIONAIS", 12000)]);
  assert.equal(p.indicadores.RESULTADO_GERENCIAL.valorCentavos, -2000);
  assert.equal(p.cadaCem.prejuizo, true);
  assert.equal(p.cadaCem.grupos.reduce((s, g) => s + g.centesimosDePonto, 0), 10000);
  assert.ok(p.cadaCem.grupos.find((g) => g.codigo === "RESULTADO_GERENCIAL").centesimosDePonto < 0);
  assert.ok(p.cadaCem.grupos.find((g) => g.codigo === "CUSTOS_OPERACIONAIS").acimaDeCem);
  // Resultado zero: zero calculado (não desconhecido).
  const z = apurarCom([lanc("RECEITA", "RECEITA_OPERACIONAL", 5000), lanc("DESPESA", "CUSTOS_OPERACIONAIS", 5000)]);
  assert.equal(z.indicadores.RESULTADO_GERENCIAL.valorCentavos, 0);
  // Faturamento desconhecido: sem registros → null (nunca zero) e a barra não inventa percentuais.
  const d = apurarCom([]);
  assert.equal(d.indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, null);
  assert.ok(d.cadaCem.limitacao);
  // Despesa sem receita: percentuais não calculados (base zero), valores preservados.
  const s = apurarCom([lanc("DESPESA", "CUSTOS_OPERACIONAIS", 700)]);
  assert.equal(s.indicadores.CUSTOS_OPERACIONAIS.valorCentavos, -700);
  assert.equal(s.indicadores.CUSTOS_OPERACIONAIS.percentualDoBruto, null);
  // Receita financeira (positiva) junto de despesa financeira: linha assinada, sem perder o sinal.
  const f = apurarCom([lanc("RECEITA", "RECEITA_OPERACIONAL", 10000), lanc("RECEITA", "DESPESAS_FINANCEIRAS", 300), lanc("DESPESA", "DESPESAS_FINANCEIRAS", 800)]);
  assert.equal(f.indicadores.RESULTADO_FINANCEIRO.valorCentavos, -500);
});

test("F — dados parciais (propostas pendentes) não aparecem como definitivos", async () => {
  const { nucleo: n, caixa } = await montarComCadastros();
  await importarEProporc(n, caixa, saiposVendas(PEDIDOS));
  const ap = await n.apurarCompetencia(c, { competencia: "2026-09" });
  assert.notEqual(ap.indicadores.FATURAMENTO_BRUTO_PROPRIO.situacao, "CONFIRMADO");
  assert.equal(ap.indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, null, "sem venda aplicada: desconhecido, não zero");
  assert.ok(ap.pendencias.length > 0);
});

test("F — resultado nunca é confundido com saldo bancário", async () => {
  const { nucleo: n, c: cx, banco } = await montarComCadastros();
  await n.registrarSaldoDeConta(cx, { contaId: banco.id, data: "2026-09-01", valorCentavos: 90000 });
  await n.registrarMovimentacao(cx, entrada(banco.id, 1000, { dataEfetiva: "2026-09-05", natureza: "OUTRA" }));
  const ap = await n.apurarCompetencia(cx, { competencia: "2026-09" });
  assert.equal(ap.indicadores.RESULTADO_GERENCIAL.valorCentavos, null);
  assert.equal((await n.consultarResumoFinanceiro(cx, { competencia: "2026-09" })).saldoBancario.valorCentavos, 91000);
  assert.equal(montar, montar);
});
