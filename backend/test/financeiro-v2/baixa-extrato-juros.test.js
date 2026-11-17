// Baixa pelo extrato com JURO/MULTA: a saída é maior que a conta e a pessoa classifica a diferença.
// A diferença vira AJUSTE da própria conta (despesa financeira, competência do pagamento), na mesma transação da baixa.
// Dados SINTÉTICOS. Roda em memória (sem banco).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ORG_A, UNI_A, ctx, montarComCadastros, obrigacao, saida } from "./helpers/cenario.js";

const OUT = "2026-10";
const CATEGORIA = "JUROS_E_MULTAS_DE_FORNECEDORES";
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% comprovante sintetico ${randomUUID()}\n%%EOF\n`);

/** Conta de R$ 810,00 e saída de R$ 827,82 (a diferença é R$ 17,82). */
async function cenario(valorConta = 81000, valorSaida = 82782) {
  const m = await montarComCadastros();
  const g = await m.cofre.guardar(m.c, { conteudo: pdf(), tipoMime: "application/pdf" });
  const doc = (await m.nucleo.registrarDocumento(m.c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-10-05", descricao: "Comprovante sintético" })).documento;
  const conta = (await m.nucleo.registrarObrigacao(m.c, obrigacao(m.fornecedor.id, { valorOriginalCentavos: valorConta, competencia: OUT, dataEmissao: "2026-10-01", vencimento: "2026-10-30", descricao: "Contador Outubro/2026" }))).obrigacoes[0];
  const mov = (await m.nucleo.registrarMovimentacao(m.c, saida(m.banco.id, valorSaida, { dataEfetiva: "2026-10-05", fonte: { sistema: "UNICRED", idExterno: `EXT-${randomUUID().slice(0, 8)}` } }))).movimentacao;
  return { ...m, n: m.nucleo, conta, mov, doc };
}
const vincular = (n, c, mov, doc, valorCentavos, contaId, extra = {}) => n.vincularPagamentoDoExtrato(c, {
  movimentacaoId: mov.id, versaoMovimentacao: mov.versao, alocacoes: [{ obrigacaoId: contaId, valorCentavos }], documentoId: doc.id,
  justificativa: "Pago conforme o extrato de 05/10/2026 (sintético).", confirmar: true, ...extra,
});
const lancamentosDeJuros = async (n, c) => (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((l) => l.categoria === CATEGORIA && l.situacao === "ATIVO");

test("juros: a diferença da saída vira ajuste da conta — conta quita, saída fica toda vinculada, DRE recebe a despesa financeira", async () => {
  const { n, c, conta, mov, doc } = await cenario();
  const antes = await n.apurarCompetencia(c, { competencia: OUT });
  const r = await vincular(n, c, mov, doc, 82782, conta.id, { jurosCentavos: 1782 });
  assert.equal(r.repetido, false);
  assert.deepEqual([r.titulos[0].situacao, r.titulos[0].saldoCentavos, r.titulos[0].ajustesCentavos], ["QUITADA", 0, 1782]);
  assert.deepEqual([r.efeito.novasSaidas, r.efeito.jurosCentavos, r.efeito.disponivelDepoisCentavos], [0, 1782, 0]);
  const juros = await lancamentosDeJuros(n, c);
  assert.equal(juros.length, 1);
  assert.deepEqual([juros[0].valorCentavos, juros[0].competencia, juros[0].classificacao], [1782, OUT, "DESPESAS_FINANCEIRAS"]);
  const depois = await n.apurarCompetencia(c, { competencia: OUT });
  assert.equal(depois.indicadores.RESULTADO_GERENCIAL.valorCentavos, antes.indicadores.RESULTADO_GERENCIAL.valorCentavos - 1782, "só o juro reduz o resultado: a despesa original de R$ 810,00 não é contada de novo");
  assert.equal((await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).length, 1, "nenhuma saída nova");
  assert.deepEqual(await n.verificarConservacao(c), []);
  const hist = await n.consultarHistorico(c, { registroTipo: "OBRIGACAO", registroId: conta.id });
  assert.ok(hist.some((h) => h.evento === "AJUSTE" && /Juros\/multa/.test(h.justificativa ?? "")));
});

test("juros: confirmar de novo não duplica o ajuste nem a baixa", async () => {
  const { n, c, conta, mov, doc } = await cenario();
  await vincular(n, c, mov, doc, 82782, conta.id, { jurosCentavos: 1782 });
  const rep = await vincular(n, c, mov, doc, 82782, conta.id, { jurosCentavos: 1782 });
  assert.equal(rep.repetido, true);
  assert.equal((await lancamentosDeJuros(n, c)).length, 1);
  assert.equal((await n.consultarRegistros(c, { tipo: "LIQUIDACAO" })).length, 1);
  assert.equal((await n.consultarRegistros(c, { tipo: "AJUSTE" })).length, 1);
});

test("juros: sem classificar, a diferença continua sendo saída a classificar (nada é inventado)", async () => {
  const { n, c, conta, mov, doc } = await cenario();
  const r = await vincular(n, c, mov, doc, 81000, conta.id);
  assert.deepEqual([r.titulos[0].situacao, r.efeito.disponivelDepoisCentavos, r.efeito.novasDespesas], ["QUITADA", 1782, 0]);
  assert.equal((await lancamentosDeJuros(n, c)).length, 0);
});

test("juros: exige também a permissão de corrigir; sem ela nada é gravado", async () => {
  const { n, conta, mov, doc } = await cenario();
  const semCorrigir = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.VINCULAR_PAGAMENTO, ACAO.REGISTRAR]);
  await assert.rejects(vincular(n, semCorrigir, mov, doc, 82782, conta.id, { jurosCentavos: 1782 }), (e) => e.codigo === CODIGO.PERMISSAO_INSUFICIENTE && /corrigir/.test(e.message));
  const tudo = ctx();
  assert.equal((await n.consultarRegistros(tudo, { tipo: "LIQUIDACAO" })).length, 0);
  assert.equal((await n.consultarRegistros(tudo, { tipo: "AJUSTE" })).length, 0);
  assert.equal((await n.detalharContaAPagar(tudo, { id: conta.id })).titulo.saldoCentavos, 81000);
});

test("juros: só quando a baixa quita a conta; o juro não pode ser o valor inteiro; saída precisa cobrir os dois valores", async () => {
  const { n, c, conta, mov, doc } = await cenario();
  await assert.rejects(vincular(n, c, mov, doc, 50000, conta.id, { jurosCentavos: 1782 }), (e) => e.codigo === CODIGO.ENTRADA_INVALIDA && /quita a conta/.test(e.message));
  await assert.rejects(vincular(n, c, mov, doc, 1782, conta.id, { jurosCentavos: 1782 }), (e) => e.codigo === CODIGO.ENTRADA_INVALIDA);
  await assert.rejects(vincular(n, c, mov, doc, 83000, conta.id, { jurosCentavos: 2000 }), (e) => e.codigo === CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO);
  assert.equal((await lancamentosDeJuros(n, c)).length, 0);
  assert.equal((await n.detalharContaAPagar(c, { id: conta.id })).titulo.saldoCentavos, 81000);
});

test("juros: acima de 10% do valor da conta exige justificativa detalhada", async () => {
  const { n, c, conta, mov, doc } = await cenario(50000, 60000); // juro de R$ 100,00 = 20% da conta
  await assert.rejects(vincular(n, c, mov, doc, 60000, conta.id, { jurosCentavos: 10000, justificativa: "Pago pelo extrato." }), (e) => e.codigo === CODIGO.ENTRADA_INVALIDA && e.detalhes?.motivo === "JUROS_ACIMA_DO_USUAL");
  assert.equal((await lancamentosDeJuros(n, c)).length, 0);
  const ok = await vincular(n, c, mov, doc, 60000, conta.id, { jurosCentavos: 10000, justificativa: "Multa contratual por atraso confirmada com o fornecedor por telefone." });
  assert.equal(ok.titulos[0].situacao, "QUITADA");
  assert.equal((await lancamentosDeJuros(n, c)).length, 1);
});

test("juros: a prévia mostra a sobra e o que acontece, sem escolher nada sozinha", async () => {
  const { n, c, conta, mov } = await cenario();
  const p = await n.previaDoVinculoDoExtrato(c, { obrigacaoId: conta.id, movimentacaoId: mov.id });
  assert.equal(p.escolhida.valorPropostoCentavos, 81000, "a proposta continua sendo só a conta");
  assert.deepEqual([p.escolhida.juros.sobraCentavos, p.escolhida.juros.categoria, p.escolhida.juros.competencia, p.escolhida.juros.acimaDoLimite, p.escolhida.juros.voceTemPermissao], [1782, "Juros e multas pagos a fornecedores", OUT, false, true]);
  const exato = await cenario(81000, 81000);
  const q = await exato.n.previaDoVinculoDoExtrato(exato.c, { obrigacaoId: exato.conta.id, movimentacaoId: exato.mov.id });
  assert.equal(q.escolhida.juros, null);
});

test("juros: quem só tem 'vincular pagamento' e 'corrigir' consegue classificar (a categoria nasce sob demanda; sem registrar)", async () => {
  const { n, conta, mov, doc } = await cenario();
  const so2 = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.VINCULAR_PAGAMENTO, ACAO.CORRIGIR]);
  const r = await vincular(n, so2, mov, doc, 82782, conta.id, { jurosCentavos: 1782 });
  assert.equal(r.titulos[0].situacao, "QUITADA");
  assert.equal((await lancamentosDeJuros(n, ctx())).length, 1);
});
