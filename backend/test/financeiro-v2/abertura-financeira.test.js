// Abertura financeira (doc 29) — formulários que faltavam: plano, contas, saldos de abertura, títulos ANTERIORES (opção B,
// posição patrimonial), recebíveis, caixa físico. Exercita as MESMAS ações da plataforma (escritas.js) sobre o núcleo real.
// Dados SINTÉTICOS. Roda em memória e, com FV2_REPOSITORIO=postgres, no banco isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { CATEGORIA_TITULOS_ANTERIORES } from "../../src/modules/financeiro-v2/dominio/planoDeContas.js";
import { ESCRITAS, SEM_ANEXO, vesperaDaCompetencia } from "../../src/modules/fv2-integracao/escritas.js";
import { UNI_A2, ORG_A, ctx, montar, rejeita } from "./helpers/cenario.js";

const RELOGIO = () => new Date("2026-11-20T15:00:00.000Z"); // depois da abertura proposta (01/11/2026)
const COMP = "2026-11";
/** Sem receita/despesa: o indicador fica vazio (nada registrado) ou zero (só registros fora do resultado). Nunca outro valor. */
const semEfeito = (ind, k) => assert.ok(ind[k].valorCentavos === null || ind[k].valorCentavos === 0, `${k} sem efeito (veio ${ind[k].valorCentavos})`);
const acao = (nucleo, c) => async (caminho, corpo) => {
  const e = ESCRITAS[caminho];
  assert.ok(e, `ação ${caminho} existe`);
  for (const k of Object.keys(corpo)) assert.ok(e.campos.includes(k), `${caminho} aceita ${k}`);
  return e.fazer(nucleo, c, corpo);
};
async function preparar() {
  const m = montar({ relogio: RELOGIO });
  const c = ctx();
  const A = acao(m.nucleo, c);
  const unicred = await A("/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Unicred", instituicao: "Unicred" });
  const caixa = await A("/configuracoes/conta/criar", { tipo: "CAIXA_FISICO", nome: "Caixa físico" });
  await A("/abertura/configurar", { competencia: COMP }); // abertura PERSISTIDA (0022): proposta 11/2026, corte 31/10
  return { ...m, c, A, unicred, caixa };
}

test("plano ACAITERIA: implantação só com o modelo redigitado, idempotente, e a categoria patrimonial dos títulos anteriores", async () => {
  const m = montar({ relogio: RELOGIO, plano: false });
  const c = ctx();
  const A = acao(m.nucleo, c);
  await rejeita(A("/configuracoes/implantar-plano", { modelo: "ACAITERIA" }), CODIGO.CONFIRMACAO_EXIGIDA);
  await rejeita(A("/configuracoes/implantar-plano", { modelo: "ACAITERIA", modeloConfirmado: "acaiteria" }), CODIGO.CONFIRMACAO_EXIGIDA);
  const r = await A("/configuracoes/implantar-plano", { modelo: "ACAITERIA", modeloConfirmado: "ACAITERIA" });
  assert.ok(r.criadas.includes(CATEGORIA_TITULOS_ANTERIORES) && r.criadas.includes("ENTREGADORES_PROPRIOS") && r.criadas.includes("INSUMOS"));
  const total = r.total;
  const de_novo = await A("/configuracoes/implantar-plano", { modelo: "ACAITERIA", modeloConfirmado: "ACAITERIA" });
  assert.deepEqual([de_novo.criadas, de_novo.total], [[], total], "reimplantar não duplica nada");
  const plano = await m.nucleo.consultarPlanoDeContas(c);
  const patrimoniais = plano.find((g) => g.codigo === "MOVIMENTACOES_PATRIMONIAIS");
  const anteriores = patrimoniais.filhas.find((x) => x.codigo === CATEGORIA_TITULOS_ANTERIORES);
  assert.deepEqual([anteriores.natureza, anteriores.doSistema, anteriores.aceitaLancamento], ["PATRIMONIAL", true, true]);
  // Hierarquia e categorias gerenciais preservadas: Custos com as filhas da açaiteria; Motoboys em Despesas comerciais.
  const custos = plano.find((g) => g.codigo === "CUSTOS_OPERACIONAIS");
  assert.ok(custos.filhas.find((x) => x.codigo === "INSUMOS").filhas.some((x) => x.codigo === "FRUTAS"));
  assert.ok(plano.find((g) => g.codigo === "DESPESAS_COMERCIAIS").filhas.some((x) => x.codigo === "ENTREGADORES_PROPRIOS" && x.nome === "Entregadores Próprios (Motoboys)"));
  // Categoria do sistema não pode ser inativada (os títulos anteriores dependem dela).
  await rejeita(m.nucleo.alterarCategoria(c, { codigo: CATEGORIA_TITULOS_ANTERIORES, mudancas: { ativa: false }, justificativa: "teste" }), CODIGO.CATEGORIA_INVALIDA);
});

test("contas financeiras: Unicred e caixa físico sem saldo presumido; sem duplicidade (reenvio, variação de grafia, concorrência)", async () => {
  const { nucleo, c, A, unicred, caixa } = await preparar();
  assert.ok(!ESCRITAS["/configuracoes/conta/criar"].campos.some((k) => /saldo|valor/i.test(k)), "o cadastro não aceita saldo");
  assert.deepEqual([unicred.tipo, unicred.ativa, caixa.tipo], ["BANCARIA", true, "CAIXA_FISICO"]);
  const reenvio = await A("/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Unicred", instituicao: "Unicred" });
  assert.deepEqual([reenvio.id, reenvio.repetido], [unicred.id, true]);
  const grafia = await A("/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "  unicréd ", instituicao: "Unicred" });
  assert.equal(grafia.id, unicred.id, "maiúsculas, acento e espaços não criam outra conta");
  await rejeita(A("/configuracoes/conta/criar", { tipo: "CAIXA_FISICO", nome: "UNICRED" }), CODIGO.CONFLITO_IDEMPOTENCIA);
  const simultaneas = await Promise.all(Array.from({ length: 5 }, () => A("/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Conta de recebíveis", instituicao: "Banco Sintético" })));
  assert.equal(new Set(simultaneas.map((x) => x.id)).size, 1, "5 envios simultâneos = 1 conta");
  const cb = await nucleo.consultarCaixaEBancos(c, { inicio: "2026-11-01", fim: "2026-11-20" });
  assert.equal(cb.contas.length, 3);
  for (const x of cb.contas) assert.equal(x.saldoFinalCentavos, null, "sem saldo informado, o saldo é DESCONHECIDO (nunca zero)");
  // Permissão: quem não configura não cadastra conta; outra unidade não vê as contas desta.
  await rejeita(acao(nucleo, ctx(ORG_A, undefined, [ACAO.CONSULTAR]))("/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Outra" }), CODIGO.PERMISSAO_INSUFICIENTE);
  assert.equal((await nucleo.consultarCaixaEBancos(ctx(ORG_A, UNI_A2), { inicio: "2026-11-01", fim: "2026-11-20" })).contas.length, 0);
});

test("saldos de abertura: véspera da competência, FIM_DO_DIA, origem obrigatória, sem afirmar anexo; reenvio e conflito", async () => {
  const { nucleo, c, A, unicred, caixa } = await preparar();
  assert.equal(vesperaDaCompetencia(COMP), "2026-10-31");
  await rejeita(A("/abertura/saldo", { conta: unicred.id, valor: "1.234,56" }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(A("/abertura/configurar", { competencia: "2026-13" }), CODIGO.ENTRADA_INVALIDA);
  const s = (await A("/abertura/saldo", { conta: unicred.id, valor: "1.234,56", origem: "Extrato Unicred de 31/10 (sintético)" })).saldo;
  assert.deepEqual([s.data, s.referencia, s.valorCentavos], ["2026-10-31", "FIM_DO_DIA", 123456]);
  assert.ok(s.observacao.includes("Extrato Unicred de 31/10") && s.observacao.includes(SEM_ANEXO) && !s.documentoId, "referência externa, sem anexo");
  assert.ok(s.criadoPor, "quem registrou fica gravado");
  assert.equal((await A("/abertura/saldo", { conta: unicred.id, valor: "1.234,56", origem: "Extrato Unicred de 31/10 (sintético)" })).repetido, true);
  await rejeita(A("/abertura/saldo", { conta: unicred.id, valor: "1.234,57", origem: "Extrato Unicred de 31/10 (sintético)" }), CODIGO.CONFLITO_IDEMPOTENCIA);
  await A("/abertura/saldo", { conta: caixa.id, valor: "350,00", origem: "Contagem do caixa em 31/10 (sintética)" });
  await rejeita(A("/abertura/saldo", { conta: caixa.id, valor: "-1,00", origem: "Contagem sintética" }), CODIGO.VALOR_INVALIDO);
  const cb = await nucleo.consultarCaixaEBancos(c, { inicio: "2026-11-01", fim: "2026-11-20" });
  assert.deepEqual(cb.contas.map((x) => [x.nome, x.saldoFinalCentavos]).sort(), [["Caixa físico", 35000], ["Unicred", 123456]]);
  // Saldo de abertura não é receita: a DRE do mês de início segue vazia.
  assert.equal((await nucleo.apurarCompetencia(c, { competencia: COMP })).indicadores.RESULTADO_GERENCIAL.valorCentavos, null);
});

test("títulos ANTERIORES (opção B): posição patrimonial, fora da DRE; pagos/recebidos depois não viram despesa nem receita", async () => {
  const { nucleo, c, A, unicred } = await preparar();
  await A("/abertura/saldo", { conta: unicred.id, valor: "1.000,00", origem: "Extrato Unicred de 31/10 (sintético)" });
  const chave = randomUUID();
  const corpo = { fornecedorNovo: "Fornecedor Sintético A", descricao: "NF 101 (sintética)", valor: "500,00", dataEmissao: "2026-10-20", vencimento: "2026-11-10", origem: "Lista de contas a pagar em 31/10", chave };
  const o = await A("/abertura/obrigacao-anterior", corpo);
  assert.deepEqual([o.lancamento.categoria, o.lancamento.natureza, o.obrigacoes.length, o.obrigacoes[0].vencimento, o.obrigacoes[0].saldoCentavos], [CATEGORIA_TITULOS_ANTERIORES, "PATRIMONIAL", 1, "2026-11-10", 50000]);
  assert.ok(o.obrigacoes[0].descricao.includes(SEM_ANEXO));
  // Reenvio (clique duplo) devolve o mesmo título e não cria outro fornecedor; conteúdo diferente com a mesma chave = conflito.
  const [r1, r2] = await Promise.all([A("/abertura/obrigacao-anterior", corpo), A("/abertura/obrigacao-anterior", corpo)]);
  assert.deepEqual([r1.repetido, r2.repetido, r1.obrigacoes[0].id], [true, true, o.obrigacoes[0].id]);
  await rejeita(A("/abertura/obrigacao-anterior", { ...corpo, valor: "501,00" }), CODIGO.CONFLITO_IDEMPOTENCIA);
  // Emissão dentro da competência de início NÃO é título anterior (nem fornecedor órfão fica gravado).
  await rejeita(A("/abertura/obrigacao-anterior", { ...corpo, chave: randomUUID(), fornecedorNovo: "Órfão Sintético", dataEmissao: "2026-11-01" }), CODIGO.DATA_INVALIDA);
  const pagar = await nucleo.consultarContasAPagar(c, {});
  assert.equal(pagar.itens.length, 1);
  // Segundo título do MESMO fornecedor (grafia diferente): mesmo cadastro, nenhum fornecedor repetido. Cancelado em seguida.
  const o2 = await A("/abertura/obrigacao-anterior", { ...corpo, chave: randomUUID(), fornecedorNovo: " fornecedor sintético A ", descricao: "NF 102 (sintética)", valor: "120,00" });
  assert.equal(o2.obrigacoes[0].contraparteId, o.obrigacoes[0].contraparteId);
  await nucleo.cancelarObrigacao(c, { obrigacaoId: o2.obrigacoes[0].id, justificativa: "Cancelamento sintético do segundo título." });
  assert.ok(!JSON.stringify(pagar).includes("Órfão Sintético"), "nenhum fornecedor órfão");

  const rec = await A("/abertura/recebivel-anterior", { processador: "IFOOD", descricao: "Repasse iFood da semana de 27/10 (sintético)", valor: "800,00", dataOrigem: "2026-10-28", vencimento: "2026-11-05", origem: "Demonstrativo iFood (sintético)", chave: randomUUID() });
  assert.deepEqual([rec.recebivel.anteriorAAbertura, rec.recebivel.dataOrigem, rec.recebivel.saldoCentavos, rec.lancamentosDeRetencao.length], [true, "2026-10-28", 80000, 0]);
  await rejeita(A("/abertura/recebivel-anterior", { processador: "STONE", descricao: "Agenda Stone", valor: "10,00", dataOrigem: "2026-11-01", origem: "Agenda Stone (sintética)", chave: randomUUID() }), CODIGO.DATA_INVALIDA);
  await rejeita(nucleo.registrarRecebivel(c, { processador: "STONE", brutoCentavos: 1000, competencia: COMP, anteriorAAbertura: true, dataOrigem: "2026-10-30", retencoes: [{ categoria: "TAXAS_STONE", valorCentavos: 10 }] }), CODIGO.ENTRADA_INVALIDA);

  const antes = await nucleo.apurarCompetencia(c, { competencia: COMP });
  assert.equal(antes.indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos, null, "só patrimoniais: a DRE continua SEM registros (nunca R$ 0,00 confirmado)");
  assert.equal(antes.indicadores.RESULTADO_GERENCIAL.valorCentavos, null);
  semEfeito(antes.indicadores, "RESULTADO_GERENCIAL");
  semEfeito(antes.indicadores, "FATURAMENTO_BRUTO_PROPRIO");
  assert.deepEqual(antes.dre.foraDoResultado.patrimoniais.map((x) => [x.categoria, x.valorCentavos]), [[CATEGORIA_TITULOS_ANTERIORES, 50000]]);

  // Depois da abertura: paga a dívida antiga e recebe o repasse antigo pela Unicred.
  await nucleo.pagarContaAPagar(c, { obrigacaoId: o.obrigacoes[0].id, contaId: unicred.id, dataEfetiva: "2026-11-10", valorCentavos: 50000 });
  const e = await nucleo.registrarMovimentacao(c, { contaId: unicred.id, dataEfetiva: "2026-11-05", sentido: "ENTRADA", valorCentavos: 80000, natureza: "RECEBIMENTO", descricao: "Repasse iFood (sintético)" });
  await nucleo.registrarLiquidacao(c, { movimentacaoId: e.movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: rec.recebivel.id, valorCentavos: 80000 }] });
  const depois = await nucleo.apurarCompetencia(c, { competencia: COMP });
  for (const k of ["RESULTADO_GERENCIAL", "FATURAMENTO_BRUTO_PROPRIO", "DESPESAS_OPERACIONAIS", "CUSTOS_OPERACIONAIS"]) semEfeito(depois.indicadores, k);
  assert.equal((await nucleo.consultarContasAPagar(c, {})).totais.saldoCentavos, 0);
  assert.equal((await nucleo.consultarContasAReceber(c, {})).totais.saldoCentavos, 0);
  const cb = await nucleo.consultarCaixaEBancos(c, { inicio: "2026-11-01", fim: "2026-11-20", contaId: unicred.id });
  assert.equal(cb.contas[0].saldoFinalCentavos, 100000 - 50000 + 80000, "saldo = abertura − pagamento + recebimento");
});

test("contas a receber do período: cliente novo na mesma transação; repasse de processador recusado (nasce da venda)", async () => {
  const { nucleo, c, A } = await preparar();
  await rejeita(A("/recebiveis/registrar", { processador: "STONE", valor: "100,00", competencia: COMP }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(A("/recebiveis/registrar", { clienteNovo: "Cliente Sintético", processador: "IFOOD", valor: "1,00", competencia: COMP }), CODIGO.ENTRADA_INVALIDA);
  await rejeita(A("/recebiveis/registrar", { clienteNovo: "Cliente Órfão", valor: "abc", competencia: COMP }), CODIGO.VALOR_INVALIDO);
  const chave = randomUUID();
  const corpo = { clienteNovo: "Cliente Sintético", descricao: "Encomenda faturada (sintética)", valor: "250,00", competencia: COMP, vencimento: "2026-11-30", chave };
  const [x, y] = await Promise.all([A("/recebiveis/registrar", corpo), A("/recebiveis/registrar", corpo)]);
  assert.equal(x.recebivel.id, y.recebivel.id);
  assert.ok(x.recebivel.contraparteId && !("contraparteNova" in x.recebivel));
  const r = await nucleo.consultarContasAReceber(c, {});
  assert.equal(r.itens.length, 1);
  assert.ok(!JSON.stringify(r).includes("Cliente Órfão"));
  semEfeito((await nucleo.apurarCompetencia(c, { competencia: COMP })).indicadores, "FATURAMENTO_BRUTO_PROPRIO");
});

test("caixa físico: abertura com o contado (não é faturamento), operações idempotentes e concorrentes, fechamento", async () => {
  const { nucleo, c, A, caixa, unicred } = await preparar();
  const { sessao } = await A("/caixa/abrir", { conta: caixa.id, data: "2026-11-01", contado: "350,00", observacao: "Contagem de abertura (sintética)" });
  assert.equal(sessao.saldoAberturaCentavos, 35000);
  await rejeita(A("/caixa/abrir", { conta: caixa.id, data: "2026-11-02", contado: "0,00" }), CODIGO.OPERACAO_INVALIDA);
  await rejeita(A("/caixa/abrir", { conta: unicred.id, data: "2026-11-02", contado: "0,00" }), CODIGO.OPERACAO_INVALIDA);
  const chave = randomUUID();
  const op = { sessao: sessao.id, operacao: "SAIDA", valor: "20,00", data: "2026-11-02", descricao: "Gás (sintético)", chave };
  const rs = await Promise.all([A("/caixa/operacao", op), A("/caixa/operacao", op), A("/caixa/operacao", op)]);
  assert.equal(rs.filter((r) => !r.repetido).length, 1, "3 envios do mesmo formulário = 1 operação");
  await rejeita(A("/caixa/operacao", { ...op, valor: "21,00" }), CODIGO.CONFLITO_IDEMPOTENCIA);
  await A("/caixa/operacao", { sessao: sessao.id, operacao: "SANGRIA", valor: "100,00", data: "2026-11-02", descricao: "Depósito (sintético)", contraConta: unicred.id, chave: randomUUID() });
  const r = await nucleo.consultarCaixaEBancos(c, { inicio: "2026-11-01", fim: "2026-11-20", contaId: caixa.id });
  assert.equal(r.contas[0].sessoesDeCaixa[0].operacoes.length, 2);
  // Teórico = 350 − 20 − 100 = 230; contado 230 → sem diferença.
  const f = await A("/caixa/fechar", { sessao: sessao.id, data: "2026-11-02", contado: "230,00" });
  assert.deepEqual([f.teoricoCentavos, f.diferencaCentavos], [23000, 0]);
  const dre = await nucleo.apurarCompetencia(c, { competencia: COMP });
  semEfeito(dre.indicadores, "FATURAMENTO_BRUTO_PROPRIO");
  semEfeito(dre.indicadores, "RESULTADO_GERENCIAL");
});

