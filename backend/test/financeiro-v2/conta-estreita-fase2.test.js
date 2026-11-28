// 28/11 — FASE 2 do MOVA Operador Financeiro (migração 0037): reclassificar a compra, ajustar valor, mudar competência e cancelar
// (compra inteira ou parcela), cada operação com a SUA ação estreita, sobre a mesma lógica oficial do núcleo. Dados SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { homologarComRessalvas, montarComCadastros, rejeita } from "./helpers/cenario.js";

export const R = [ACAO.VER, ACAO.RECLASSIFICAR_CONTA_A_PAGAR];
export const A = [ACAO.VER, ACAO.AJUSTAR_CONTA_A_PAGAR];
export const M = [ACAO.VER, ACAO.MOVER_COMPETENCIA_CONTA_A_PAGAR];
export const C = [ACAO.VER, ACAO.CANCELAR_CONTA_A_PAGAR];
export const compra = (x = {}) => ({ contraparteNova: { tipo: "FORNECEDOR", nome: "Loja Sintética F2" }, categoria: "IMOBILIZADO", descricao: "Freezer sintético",
  competencia: "2026-10", dataEmissao: "2026-10-15", parcelas: [{ vencimento: "2026-11-15", valorCentavos: 30000 }, { vencimento: "2026-12-15", valorCentavos: 30000 }, { vencimento: "2027-01-15", valorCentavos: 30000 }],
  fonte: { sistema: "MANUAL", idExterno: `MOVA:f2-${randomUUID()}` }, ...x });
export const versoesDe = (rs) => Object.fromEntries(rs.map((r) => [r.id, r.versao]));
const just = "Pedido e confirmado no WhatsApp (sintético).";

async function cenario() {
  const m = await montarComCadastros();
  const conta = await m.nucleo.registrarContaParcelada(m.c, compra());
  const ler = async () => {
    const os = (await m.nucleo.consultarRegistros(m.c, { tipo: "OBRIGACAO" })).filter((o) => o.grupoId === conta.obrigacoes[0].grupoId).sort((x, y) => x.parcela.numero - y.parcela.numero);
    const ls = await m.nucleo.consultarRegistros(m.c, { tipo: "LANCAMENTO" });
    return { os, l: ls.find((x) => x.id === conta.lancamento.id), ls };
  };
  const como = (acoes) => ({ ...m.c, permissoes: acoes });
  const pagar = async (o) => m.nucleo.registrarPagamentoPorComprovante({ ...m.c, permissoes: [ACAO.VER, ACAO.BAIXAR_POR_COMPROVANTE, ACAO.ENVIAR_DOCUMENTO] }, { obrigacaoId: o.id, valorCentavos: 10000, dataPagamento: "2026-10-15",
    idTransacao: `E${randomUUID().replace(/-/g, "").slice(0, 26)}`, justificativa: "Pagamento parcial (sintético).", confirmar: true, comprovanteSemArquivo: { hashSha256: randomUUID().replace(/-/g, "").padEnd(64, "0"), tipoMime: "application/pdf", tamanhoBytes: 1 } });
  return { m, conta, ler, como, pagar };
}

test("F2-1 reclassificar: a COMPRA inteira muda de categoria (um lançamento), sem tocar valor, parcelas ou competência; versão confirmada; sem ação estreita, nada", async () => {
  const s = await cenario();
  let { os, l } = await s.ler();
  const r = await s.m.nucleo.reclassificarContaAPagar(s.como(R), { obrigacaoId: os[1].id, categoria: "MANUTENCAO", versoes: versoesDe([...os, l]), justificativa: just });
  assert.deepEqual([r.lancamento.categoria, r.lancamento.natureza, r.lancamento.valorCentavos, r.lancamento.competencia], ["MANUTENCAO", "DESPESA", 90000, "2026-10"]);
  assert.deepEqual(r.impacto.de, { categoria: "IMOBILIZADO", natureza: "PATRIMONIAL" });
  ({ os, l } = await s.ler());
  assert.ok(os.every((o) => o.valorBaseCentavos === 30000 && o.situacao === "ABERTA"));
  await rejeita(s.m.nucleo.reclassificarContaAPagar(s.como(R), { obrigacaoId: os[0].id, categoria: "INSUMOS", versoes: versoesDe([...os, { ...l, versao: l.versao - 1 }]), justificativa: just }), CODIGO.CONFLITO_VERSAO);
  await rejeita(s.m.nucleo.reclassificarContaAPagar(s.como(R), { obrigacaoId: os[0].id, categoria: "EMPRESTIMOS_E_FINANCIAMENTOS", versoes: versoesDe([...os, l]), justificativa: just }), CODIGO.CATEGORIA_INVALIDA);
  await rejeita(s.m.nucleo.reclassificarContaAPagar(s.como([ACAO.VER, ACAO.CORRIGIR_CONTA_A_PAGAR]), { obrigacaoId: os[0].id, categoria: "INSUMOS", versoes: versoesDe([...os, l]), justificativa: just }), CODIGO.PERMISSAO_INSUFICIENTE);
});

test("F2-2 ajustar valor: anterior, correto e diferença; ajuste documentado (o original fica); nunca abaixo do pago; parcela paga/quitada ⇒ revisão humana", async () => {
  const s = await cenario();
  let { os } = await s.ler();
  const r = await s.m.nucleo.ajustarValorDeContaAPagar(s.como(A), { obrigacaoId: os[1].id, valorCorretoCentavos: 32500, versaoEsperada: os[1].versao, versaoLancamento: (await s.ler()).l.versao, justificativa: just });
  assert.deepEqual([r.anteriorCentavos, r.corretoCentavos, r.diferencaCentavos, r.obrigacao.valorBaseCentavos, r.obrigacao.ajustesCentavos, r.obrigacao.saldoCentavos], [30000, 32500, 2500, 30000, 2500, 32500]);
  assert.deepEqual([r.lancamento.categoria, r.lancamento.valorCentavos, r.lancamento.competencia, r.lancamento.origem.tipo], ["IMOBILIZADO", 2500, "2026-10", "AJUSTE"]);
  ({ os } = await s.ler());
  const red = await s.m.nucleo.ajustarValorDeContaAPagar(s.como(A), { obrigacaoId: os[1].id, valorCorretoCentavos: 29000, versaoEsperada: os[1].versao, versaoLancamento: (await s.ler()).l.versao, justificativa: just });
  assert.deepEqual([red.anteriorCentavos, red.diferencaCentavos, red.obrigacao.saldoCentavos], [32500, -3500, 29000]);
  // com pagamento parcial: correto abaixo (ou igual) ao pago ⇒ revisão humana; acima ⇒ ajusta e continua PARCIAL
  await s.pagar(os[0]);
  ({ os } = await s.ler());
  await rejeita(s.m.nucleo.ajustarValorDeContaAPagar(s.como(A), { obrigacaoId: os[0].id, valorCorretoCentavos: 10000, versaoEsperada: os[0].versao, versaoLancamento: (await s.ler()).l.versao, justificativa: just }), CODIGO.OPERACAO_INVALIDA);
  const parcial = await s.m.nucleo.ajustarValorDeContaAPagar(s.como(A), { obrigacaoId: os[0].id, valorCorretoCentavos: 31000, versaoEsperada: os[0].versao, versaoLancamento: (await s.ler()).l.versao, justificativa: just });
  assert.deepEqual([parcial.obrigacao.situacao, parcial.obrigacao.saldoCentavos], ["PARCIAL", 21000]);
  const igual = await s.m.nucleo.ajustarValorDeContaAPagar(s.como(A), { obrigacaoId: os[2].id, valorCorretoCentavos: 30000, versaoEsperada: os[2].versao, versaoLancamento: (await s.ler()).l.versao, justificativa: just });
  assert.equal(igual.semMudanca, true);
});

test("F2-3 mudar competência: lançamento e TODAS as parcelas juntos; vencimentos intactos; períodos homologados ou compra com pagamento/ajuste ⇒ recusa", async () => {
  const s = await cenario();
  let { os, l } = await s.ler();
  const r = await s.m.nucleo.moverCompetenciaDeContaAPagar(s.como(M), { obrigacaoId: os[0].id, competencia: "2026-11", versoes: versoesDe([...os, l]), justificativa: just });
  assert.deepEqual(r.impacto, { de: "2026-10", para: "2026-11", valorCentavos: 90000, categoria: "IMOBILIZADO", natureza: "PATRIMONIAL" });
  ({ os, l } = await s.ler());
  assert.ok(l.competencia === "2026-11" && os.every((o) => o.competencia === "2026-11"));
  assert.deepEqual(os.map((o) => o.vencimento), ["2026-11-15", "2026-12-15", "2027-01-15"], "vencimentos intactos");
  // destino homologado: recusa
  const s2 = await cenario();
  let x = await s2.ler();
  await homologarComRessalvas(s2.m.nucleo, s2.m.c, "2026-09");
  await rejeita(s2.m.nucleo.moverCompetenciaDeContaAPagar(s2.como(M), { obrigacaoId: x.os[0].id, competencia: "2026-09", versoes: versoesDe([...x.os, x.l]), justificativa: just }), CODIGO.COMPETENCIA_HOMOLOGADA);
  await s2.pagar(x.os[0]);
  x = await s2.ler();
  await rejeita(s2.m.nucleo.moverCompetenciaDeContaAPagar(s2.como(M), { obrigacaoId: x.os[0].id, competencia: "2026-11", versoes: versoesDe([...x.os, x.l]), justificativa: just }), CODIGO.OPERACAO_INVALIDA);
});

test("F2-4 cancelar: PARCELA (só ela, ajuste negativo auditado, a DRE fica líquida) e depois a COMPRA inteira; com pagamento ⇒ revisão humana; nada é apagado", async () => {
  const s = await cenario();
  let { os, l, ls } = await s.ler();
  const p = await s.m.nucleo.cancelarContaAPagar(s.como(C), { obrigacaoId: os[2].id, abrangencia: "PARCELA", versoes: versoesDe([os[2], l]), justificativa: just });
  assert.deepEqual([p.obrigacoes[0].situacao, p.obrigacoes[0].saldoCentavos, p.ajuste.valorCentavos, p.lancamentoDoAjuste.valorCentavos], ["CANCELADA", 0, -30000, -30000]);
  ({ os, l, ls } = await s.ler());
  assert.deepEqual(os.map((o) => o.situacao), ["ABERTA", "ABERTA", "CANCELADA"], "as outras parcelas intactas");
  const liquidoNaDre = ls.filter((x) => x.situacao === "ATIVO" && x.categoria === "IMOBILIZADO").reduce((t, x) => t + x.valorCentavos, 0);
  assert.equal(liquidoNaDre, 60000, "o original (R$ 900) fica, com o ajuste de −R$ 300");
  // a compra inteira (as vivas + o lançamento); a parcela já cancelada e o ajuste dela também saem do resultado
  const g = await s.m.nucleo.cancelarContaAPagar(s.como(C), { obrigacaoId: os[0].id, abrangencia: "GRUPO", versoes: versoesDe([os[0], os[1], l]), justificativa: just });
  assert.equal(g.lancamento.situacao, "CANCELADO");
  ({ os, ls } = await s.ler());
  assert.ok(os.every((o) => o.situacao === "CANCELADA"));
  assert.equal(ls.filter((x) => x.situacao === "ATIVO" && x.categoria === "IMOBILIZADO").length, 0);
  assert.equal(ls.filter((x) => x.categoria === "IMOBILIZADO").length, 2, "nada apagado: original e ajuste continuam, cancelados");
  // com pagamento: recusa (parcela e compra)
  const s2 = await cenario();
  let y = await s2.ler();
  await s2.pagar(y.os[0]);
  y = await s2.ler();
  await rejeita(s2.m.nucleo.cancelarContaAPagar(s2.como(C), { obrigacaoId: y.os[0].id, abrangencia: "PARCELA", versoes: versoesDe([y.os[0], y.l]), justificativa: just }), CODIGO.OPERACAO_INVALIDA);
  await rejeita(s2.m.nucleo.cancelarContaAPagar(s2.como(C), { obrigacaoId: y.os[1].id, abrangencia: "GRUPO", versoes: versoesDe([...y.os, y.l]), justificativa: just }), CODIGO.OPERACAO_INVALIDA);
  // compra com UMA parcela: cancelar a parcela ⇒ "cancele a compra inteira"
  const s3 = await cenario();
  const uma = await s3.m.nucleo.registrarContaParcelada(s3.m.c, compra({ parcelas: [{ vencimento: "2026-11-15", valorCentavos: 5000 }] }));
  await rejeita(s3.m.nucleo.cancelarContaAPagar(s3.como(C), { obrigacaoId: uma.obrigacoes[0].id, abrangencia: "PARCELA", versoes: versoesDe([...uma.obrigacoes, uma.lancamento]), justificativa: just }), CODIGO.OPERACAO_INVALIDA);
});
