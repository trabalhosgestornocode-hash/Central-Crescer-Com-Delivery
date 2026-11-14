// Execução 07B — a CARGA DIRIGIDA das telas (só as tabelas usadas e só as linhas ligadas aos títulos, filtradas no banco)
// produz EXATAMENTE o mesmo resultado que a carga completa do histórico (referência: cargaCompletaDeReferencia). Vários
// meses, títulos pagos em parte, uma saída pagando dois títulos, documentos, recorrência, cancelamento, ajustes, filtros e
// páginas. Roda em memória e no PostgreSQL isolado. Dados sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, montarComCadastros, obrigacao, saida } from "./helpers/cenario.js";

async function cenarioDeVariosMeses() {
  const m = await montarComCadastros();
  const { nucleo: n, c, banco, caixa, fornecedor, cofre } = m;
  const outro = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Segundo fornecedor" });
  const doc = async (descricao) => {
    const g = await cofre.guardar(c, { conteudo: new TextEncoder().encode(`%PDF-1.4\n% ${descricao}\n%%EOF\n`), tipoMime: "application/pdf" });
    return (await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-09-15", descricao })).documento;
  };
  let k = 0;
  for (const [mes, dia] of [["2026-06", "10"], ["2026-07", "12"], ["2026-08", "14"], ["2026-09", "03"], ["2026-10", "05"]]) {
    const o1 = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { competencia: mes, dataEmissao: `${mes}-02`, vencimento: `${mes}-20`, valorOriginalCentavos: 3000 + k, parcelas: 2 }))).obrigacoes[0];
    const o2 = (await n.registrarObrigacao(c, obrigacao(outro.id, { competencia: mes, dataEmissao: `${mes}-03`, vencimento: `${mes}-25`, valorOriginalCentavos: 1800, categoria: "EMBALAGENS", descricao: "Embalagem" }))).obrigacoes[0];
    // Uma saída pagando DOIS títulos (titulosNaMesmaMovimentacao) e com documento vinculado.
    const mov = (await n.registrarMovimentacao(c, saida(banco.id, 2300, { dataEfetiva: `${mes}-${mes === "2026-10" ? "06" : "21"}` }))).movimentacao;
    await n.registrarLiquidacao(c, { movimentacaoId: mov.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: o1.id, valorCentavos: 1500 }, { alvoTipo: "OBRIGACAO", alvoId: o2.id, valorCentavos: 800 }] });
    const d = await doc(`Comprovante ${mes}`);
    await n.vincularDocumento(c, { documentoId: d.id, registroTipo: "MOVIMENTACAO", registroId: mov.id }).catch(() => {});
    await n.vincularDocumento(c, { documentoId: d.id, registroTipo: "OBRIGACAO", registroId: o2.id }).catch(() => {});
    // Vendas com recebível (Stone com taxa; iFood) e uma em dinheiro.
    const v = await n.registrarVenda(c, { canal: "BALCAO", dataVenda: `${mes}-${dia}`, brutoCentavos: 5000 + k, fonte: { sistema: "MANUAL", idExterno: `EQ-${(k += 1)}` }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 5000 + k - 1 }] });
    await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: v.recebiveis[0].id, valorCentavos: -120, motivo: "Taxa", categoria: "TAXAS_STONE" });
    await n.registrarVenda(c, { canal: "IFOOD", dataVenda: `${mes}-${dia}`, brutoCentavos: 4200, fonte: { sistema: "MANUAL", idExterno: `EQ-${(k += 1)}` }, pagamentos: [{ forma: "OUTRA", processador: "IFOOD", valorCentavos: 4200 }] });
    await n.registrarVenda(c, { canal: "BALCAO", dataVenda: `${mes}-${dia}`, brutoCentavos: 900, fonte: { sistema: "MANUAL", idExterno: `EQ-${(k += 1)}` }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 900, contaId: caixa.id }] });
    // Recebimento parcial do Stone do mês anterior.
    if (mes !== "2026-06") {
      const [aberto] = (await n.consultarRegistros(c, { tipo: "RECEBIVEL" })).filter((r) => r.processador === "STONE" && r.saldoCentavos > 0);
      const ent = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: `${mes}-${dia}`, sentido: "ENTRADA", valorCentavos: 1000, natureza: "RECEBIMENTO" })).movimentacao;
      await n.registrarLiquidacao(c, { movimentacaoId: ent.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: aberto.id, valorCentavos: 1000 }] });
    }
  }
  // Recorrência e cancelamento.
  await n.registrarObrigacao(c, obrigacao(fornecedor.id, { competencia: "2026-08", dataEmissao: "2026-08-01", vencimento: "2026-08-10", valorOriginalCentavos: 2500, categoria: "ALUGUEL", descricao: "Aluguel", recorrencia: { frequencia: "MENSAL", diaDoMes: 10 } })).catch(() => {});
  const cancelavel = (await n.registrarObrigacao(c, obrigacao(outro.id, { competencia: "2026-09", vencimento: "2026-09-28", valorOriginalCentavos: 700, descricao: "Cancelável" }))).obrigacoes[0];
  await n.cancelarObrigacao?.(c, { id: cancelavel.id, justificativa: "Lançada em dobro (sintético)." }).catch(() => {});
  return { ...m, outro };
}

test("carga dirigida em LOTES: mais de 200 títulos (limite de valores por consulta da porta) continua idêntica", async () => {
  const m = await montarComCadastros();
  const { nucleo: n, c, banco, fornecedor } = m;
  const pagos = [];
  for (let i = 0; i < 205; i += 1) {
    const o = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 1000 + i, descricao: `Lote ${i}` }))).obrigacoes[0];
    if (i % 50 === 0) pagos.push(o);
  }
  const mov = (await n.registrarMovimentacao(c, saida(banco.id, pagos.reduce((s, o) => s + o.valorBaseCentavos, 0)))).movimentacao;
  await n.registrarLiquidacao(c, { movimentacaoId: mov.id, alocacoes: pagos.map((o) => ({ alvoTipo: "OBRIGACAO", alvoId: o.id, valorCentavos: o.valorBaseCentavos })) });
  const referencia = criarNucleoFinanceiro({ repositorio: m.repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cargaCompletaDeReferencia: true });
  for (const f of [{}, { tamanho: 50, pagina: 5 }, { situacao: "PAGO" }]) {
    assert.deepEqual(await n.consultarContasAPagar(c, f), await referencia.consultarContasAPagar(c, f), JSON.stringify(f));
  }
  assert.equal((await n.consultarContasAPagar(c, { situacao: "PAGO" })).totais.registros, pagos.length);
});

test("Contas a Pagar e Contas a Receber: carga dirigida = carga completa, com filtros e páginas", async () => {
  const m = await cenarioDeVariosMeses();
  const { c, fornecedor } = m;
  const referencia = criarNucleoFinanceiro({ repositorio: m.repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: m.cofre, cargaCompletaDeReferencia: true });
  const filtrosAPagar = [{}, { tamanho: 3, pagina: 2 }, { competencia: "2026-08" }, { vencimentoDe: "2026-07-01", vencimentoAte: "2026-09-30" }, { contraparteId: fornecedor.id }, { categoria: "EMBALAGENS" }, { situacao: "VENCIDO" }, { situacao: "PAGO" }, { situacao: "CANCELADO" }];
  for (const f of filtrosAPagar) {
    const [dirigida, completa] = [await m.nucleo.consultarContasAPagar(c, f), await referencia.consultarContasAPagar(c, f)];
    assert.deepEqual(dirigida, completa, `a pagar ${JSON.stringify(f)}`);
  }
  const ap = await m.nucleo.consultarContasAPagar(c, {});
  assert.ok(ap.totais.registros >= 10 && ap.itens.some((t) => t.pagamentos.some((p) => p.titulosNaMesmaMovimentacao === 2)) && ap.itens.some((t) => t.documentos.length), "o cenário exercita pagamentos compartilhados e documentos");
  const filtrosAReceber = [{}, { tamanho: 2, pagina: 3 }, { competencia: "2026-09" }, { processador: "STONE" }, { canal: "IFOOD" }, { situacao: "SEM_PREVISAO_CONFIAVEL" }, { situacao: "RECEBIDO" }];
  for (const f of filtrosAReceber) {
    const [dirigida, completa] = [await m.nucleo.consultarContasAReceber(c, f), await referencia.consultarContasAReceber(c, f)];
    assert.deepEqual(dirigida, completa, `a receber ${JSON.stringify(f)}`);
  }
  const ar = await m.nucleo.consultarContasAReceber(c, {});
  assert.ok(ar.itens.some((t) => t.recebimentos.length) && ar.itens.some((t) => t.composicao.ajustes.length), "o cenário exercita recebimentos e ajustes");
});
