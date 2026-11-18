// Retiradas de caixa da SAIPOS → despesa paga em dinheiro (fornecedor "Sangrias", categoria Outras despesas, Caixa da loja).
// Reproduz o cenário real: parte das retiradas JÁ foi lançada à mão pela equipe (mesma data e valor) e NÃO pode ser duplicada.
// Dados 100% SINTÉTICOS. Roda em memória e no PostgreSQL local. Hoje (relógio do teste) = 25/11/2026.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ORG_A, UNI_A, UNI_A2, ctx, homologarComRessalvas, montar, rejeita } from "./helpers/cenario.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const HOJE = () => new Date("2026-11-25T15:00:00.000Z");
const CAB = ["Vencimento", "Emissão", "Pagamento", "Conta", "Método de Pagamento", "Categoria", "Valor", "Pago", "Fornecedor", "Descrição"];
const linha = (dia, valor, descricao = "Retirada de Frente de Caixa", mes = "11") => { const d = `${dia}/${mes}/2026`; return [d, d, d, "Cofre", null, "Frente de Caixa", valor, "Sim", null, descricao]; };
const b64 = (linhas) => Buffer.from(xlsx([{ nome: "Financeiro", linhas: [CAB, ...linhas] }])).toString("base64");
/** 9 retiradas em 7 dias (08 e 12 têm duas): total R$ 361,75. */
const RETIRADAS = () => [linha("04", 20), linha("06", 75.5), linha("08", 100), linha("08", 40), linha("09", 18), linha("11", 12.25), linha("12", 25), linha("12", 26), linha("15", 45)];

async function unidade({ comCaixa = true } = {}) {
  const { nucleo: n } = montar({ relogio: HOJE });
  const W = (k, b, x = c) => ESCRITAS[k].fazer(n, x, b);
  await W("/configuracoes/unidade", { nomeExibicao: "Unidade sintética", justificativa: "Teste." });
  const caixa = comCaixa ? await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa da loja" }) : null;
  const subir = (linhas, ini = "2026-11-01", fim = "2026-11-17", x = c) => W("/importacao/receber", { tipoRelatorio: "SAIPOS_MOVIMENTOS_CAIXA", periodoInicio: ini, periodoFim: fim, arquivoBase64: b64(linhas), nomeArquivo: "f.xlsx" }, x);
  const importar = async (linhas, ini, fim) => { const r = await subir(linhas, ini, fim); return (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas." })).importacao; };
  /** Conta lançada À MÃO pela equipe: fornecedor "SANGRIAS" (maiúsculas, como no real), Outras despesas, paga em dinheiro pelo caixa. */
  let fornecedor = null;
  const manual = async (data, valor, descricao = "compra de espátula (lançada à mão)") => {
    fornecedor ??= await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "SANGRIAS" });
    const o = (await n.registrarObrigacao(c, { contraparteId: fornecedor.id, valorOriginalCentavos: valor, categoria: "OUTRAS_DESPESAS", descricao, competencia: data.slice(0, 7), dataEmissao: data, vencimento: data })).obrigacoes[0];
    await n.pagarContaAPagar(c, { obrigacaoId: o.id, contaId: caixa.id, dataEfetiva: data, valorCentavos: valor });
    return o;
  };
  const previa = (x = c, ini = "2026-11-01", fim = "2026-11-30") => CONSULTAS["/sangrias-despesa"](n, x, { periodoInicio: ini, periodoFim: fim });
  const lancar = (x = c, ini = "2026-11-01", fim = "2026-11-30", extra = {}) => W("/movimentos-caixa/lancar-despesas", { periodoInicio: ini, periodoFim: fim, ...extra }, x);
  const contasDoFornecedor = async () => (await n.consultarRegistros(c, { tipo: "OBRIGACAO" })).filter((o) => o.contraparteId === fornecedor?.id);
  const estado = async () => ({
    obrigacoes: (await n.consultarRegistros(c, { tipo: "OBRIGACAO" })).length, movimentacoes: (await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).length,
    lancamentos: (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((l) => l.situacao === "ATIVO").length,
  });
  const resultado = async () => (await n.apurarCompetencia(c, { competencia: "2026-11" })).indicadores.RESULTADO_GERENCIAL.valorCentavos;
  return { n, W, caixa, importar, manual, previa, lancar, contasDoFornecedor, estado, resultado, fornecedorAtual: () => fornecedor };
}

test("importar NÃO lança nada; a prévia separa o que já foi lançado à mão (mesma data e valor) do que é novo", async () => {
  const { importar, manual, previa, estado } = await unidade();
  await manual("2026-11-06", 7550, "compra de espátula + chaves");
  await manual("2026-11-09", 1800, "Pilhas para controle");
  await manual("2026-11-11", 1225, "Taxas");
  const antes = await estado();
  await importar(RETIRADAS());
  assert.deepEqual(await estado(), antes, "importar não cria conta, pagamento nem lançamento");
  const p = await previa();
  assert.deepEqual([p.itens.length, p.resumo.novas.quantidade, p.resumo.jaLancadasManualmente.quantidade, p.resumo.jaLancadasPelaImportacao.quantidade], [9, 6, 3, 0]);
  assert.deepEqual(p.itens.filter((i) => i.situacao === "JA_LANCADA_MANUALMENTE").map((i) => [i.data, i.valorCentavos]), [["2026-11-06", 7550], ["2026-11-09", 1800], ["2026-11-11", 1225]]);
  assert.equal(p.resumo.novas.totalCentavos, 2000 + 10000 + 4000 + 2500 + 2600 + 4500);
  assert.deepEqual([p.conta.nome, p.fornecedor, p.categoria], ["Caixa da loja", "Sangrias", "OUTRAS_DESPESAS"]);
  assert.match(p.efeito, /Entra na DRE em Outras despesas/);
});

test("lançar: cria só as NOVAS como conta paga em dinheiro pelo Caixa da loja, no mesmo fornecedor, com a DRE refletindo só elas; repetir não lança de novo", async () => {
  const { n, caixa, importar, manual, previa, lancar, contasDoFornecedor, estado, resultado, fornecedorAtual } = await unidade();
  await manual("2026-11-06", 7550);
  await manual("2026-11-09", 1800);
  await manual("2026-11-11", 1225);
  await importar(RETIRADAS());
  const antes = await estado();
  const resultadoAntes = await resultado();
  const r = await lancar();
  assert.deepEqual([r.lancadas.length, r.falhas.length, r.jaLancadas], [6, 0, 3]);
  const depois = await estado();
  assert.deepEqual([depois.obrigacoes - antes.obrigacoes, depois.movimentacoes - antes.movimentacoes, depois.lancamentos - antes.lancamentos], [6, 6, 6], "6 contas, 6 saídas do caixa, 6 lançamentos de despesa");
  // O mesmo fornecedor (não cria um segundo "Sangrias"); todas quitadas; categoria Outras despesas; pagas em dinheiro pelo caixa na própria data.
  const contas = await contasDoFornecedor();
  assert.equal(contas.length, 9);
  assert.ok(contas.every((o) => o.situacao === "QUITADA" && o.saldoCentavos === 0));
  assert.equal((await n.consultarRegistros(c, { tipo: "CONTRAPARTE" })).filter((x) => /sangrias/i.test(x.nome)).length, 1, "reaproveita o fornecedor");
  assert.equal(fornecedorAtual().nome, "SANGRIAS");
  const novas = contas.filter((o) => o.fonte?.sistema === "SAIPOS");
  assert.equal(novas.length, 6);
  const lanc = (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).filter((l) => novas.some((o) => o.lancamentoId === l.id));
  assert.ok(lanc.every((l) => l.categoria === "OUTRAS_DESPESAS" && l.competencia === "2026-11"));
  const saidas = (await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).filter((m) => m.contaId === caixa.id && m.sentido === "SAIDA" && /SAIPOS|Retirada/.test(m.descricao ?? ""));
  assert.equal(saidas.length, 6);
  assert.equal(await resultado(), resultadoAntes - (2000 + 10000 + 4000 + 2500 + 2600 + 4500), "a DRE cai só pelas 6 novas (as 3 manuais já estavam nela)");
  // Aparecem como PAGAS no calendário do Contas a Pagar, no dia da retirada.
  const cal = await CONSULTAS["/calendario"](n, c, { mes: "2026-11" });
  const dia08 = cal.dias.find((d) => d.data === "2026-11-08");
  assert.deepEqual(dia08.pagamentos.map((x) => x.valorCentavos).sort((a, z) => a - z), [4000, 10000]);
  assert.equal(dia08.pagamentos.every((x) => /Sangrias|SANGRIAS/i.test(x.fornecedor ?? "")), true);
  // Idempotente.
  const de_novo = await lancar();
  assert.deepEqual([de_novo.lancadas.length, de_novo.jaLancadas], [0, 9]);
  assert.deepEqual(await estado(), depois, "repetir não lança nada");
  const p = await previa();
  assert.deepEqual([p.resumo.novas.quantidade, p.resumo.jaLancadasPelaImportacao.quantidade, p.resumo.jaLancadasManualmente.quantidade], [0, 6, 3]);
  assert.deepEqual(await n.verificarConservacao(c), []);
});

test("casamento 1 para 1: duas retiradas iguais no dia exigem duas contas; com uma lançada à mão, só a outra é nova", async () => {
  const { importar, manual, previa, lancar, contasDoFornecedor } = await unidade();
  await manual("2026-11-05", 1000);
  await importar([linha("05", 10), linha("05", 10)], "2026-11-05", "2026-11-05");
  const p = await previa("2026-11-05", "2026-11-05").catch(() => null);
  const q = await previa(undefined, "2026-11-05", "2026-11-05");
  assert.deepEqual([q.resumo.novas.quantidade, q.resumo.jaLancadasManualmente.quantidade], [1, 1]);
  void p;
  await lancar(undefined, "2026-11-05", "2026-11-05");
  assert.equal((await contasDoFornecedor()).length, 2, "1 manual + 1 da importação (não 3)");
});

test("sem lançamento prévio: cria o fornecedor Sangrias uma vez e reutiliza nas demais retiradas", async () => {
  const { n, importar, lancar, contasDoFornecedor, estado } = await unidade();
  await importar(RETIRADAS());
  const r = await lancar();
  assert.equal(r.lancadas.length, 9);
  const fornecedores = (await n.consultarRegistros(c, { tipo: "CONTRAPARTE" })).filter((x) => /sangrias/i.test(x.nome));
  assert.equal(fornecedores.length, 1);
  assert.equal(fornecedores[0].nome, "Sangrias");
  assert.equal((await estado()).obrigacoes, 9);
  void contasDoFornecedor;
});

test("reforço, transferência, desconhecido e 'não pago' NÃO viram despesa", async () => {
  const { importar, previa, lancar, estado } = await unidade();
  await importar([linha("06", -20, "Reforço de Frente de Caixa"), linha("07", 50, "Transferência entre caixas"), linha("08", -5, "Algo sem classificação"), linha("09", 30, "Retirada de Frente de Caixa")]);
  const p = await previa();
  assert.deepEqual(p.itens.map((i) => [i.data, i.valorCentavos]), [["2026-11-09", 3000]], "só a retirada classificada entra na prévia");
  const r = await lancar();
  assert.equal(r.lancadas.length, 1);
  assert.equal((await estado()).obrigacoes, 1);
});

test("permissões: ver consulta a prévia; só quem registra lança; sem caixa físico não lança; outra unidade não vê nem recebe lançamentos", async () => {
  const { n, W, importar, previa, lancar, estado } = await unidade();
  await importar(RETIRADAS());
  const soVer = ctx(ORG_A, UNI_A, [ACAO.VER]);
  assert.equal((await previa(soVer)).voceTemPermissao, false);
  await rejeita(lancar(soVer), CODIGO.PERMISSAO_INSUFICIENTE);
  assert.equal((await estado()).obrigacoes, 0, "nada foi lançado");
  const outra = ctx(ORG_A, UNI_A2);
  await W("/configuracoes/unidade", { nomeExibicao: "Outra unidade", justificativa: "Teste." }, outra);
  assert.equal((await previa(outra)).itens.length, 0, "outra unidade da mesma empresa não vê as retiradas");
  await lancar();
  assert.equal((await previa(outra)).itens.length, 0);
  assert.equal((await n.consultarRegistros(outra, { tipo: "OBRIGACAO" })).length, 0, "e não recebe nenhuma conta");
});

test("sem caixa físico cadastrado: a prévia explica e o lançamento é recusado sem gravar nada", async () => {
  const { importar, previa, lancar, estado } = await unidade({ comCaixa: false });
  await importar(RETIRADAS());
  const p = await previa();
  assert.equal(p.conta, null);
  assert.match(p.motivoSemCaixa, /caixa físico/);
  await rejeita(lancar(), CODIGO.OPERACAO_INVALIDA);
  assert.equal((await estado()).obrigacoes, 0);
});

test("competência homologada: a retirada desse mês falha com motivo, as outras são lançadas (cada uma é atômica)", async () => {
  const { n, importar, lancar, estado, previa } = await unidade();
  await importar([linha("20", 30, "Retirada de Frente de Caixa", "10"), linha("04", 20)], "2026-10-01", "2026-11-17");
  const h = await homologarComRessalvas(n, c, "2026-10");
  assert.equal(h.estado, "FECHAMENTO_HOMOLOGADO", "outubro está homologado: não aceita escrita");
  const r = await lancar(c, "2026-10-01", "2026-11-30");
  assert.deepEqual([r.lancadas.length, r.falhas.length, r.falhas[0].data], [1, 1, "2026-10-20"]);
  assert.ok(r.falhas[0].motivo.length > 10, "o motivo é dito");
  assert.deepEqual([r.lancadas[0].data, (await estado()).obrigacoes], ["2026-11-04", 1], "só a de novembro foi lançada, e inteira (conta + pagamento)");
  const p = await previa(c, "2026-10-01", "2026-11-30");
  assert.deepEqual([p.resumo.novas.quantidade, p.resumo.jaLancadasPelaImportacao.quantidade], [1, 1], "a de outubro continua NOVA (pendente), a de novembro já foi lançada");
});

// ============================ Como o dono realmente lançou: outros fornecedores e conta que SOMA retiradas ============================
async function cenarioDoDono() {
  const u = await unidade();
  const { n, caixa } = u;
  const fornecedores = new Map();
  const doFornecedor = async (nome) => { if (!fornecedores.has(nome)) fornecedores.set(nome, await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome })); return fornecedores.get(nome); };
  /** Conta lançada à mão em QUALQUER fornecedor, paga em dinheiro pelo caixa na data. */
  const lancadaPeloDono = async (nome, data, valor, descricao, contaId = caixa.id, categoria = "OUTRAS_DESPESAS") => {
    const f = await doFornecedor(nome);
    const o = (await n.registrarObrigacao(c, { contraparteId: f.id, valorOriginalCentavos: valor, categoria, descricao, competencia: data.slice(0, 7), dataEmissao: data, vencimento: data })).obrigacoes[0];
    await n.pagarContaAPagar(c, { obrigacaoId: o.id, contaId, dataEfetiva: data, valorCentavos: valor });
    return o;
  };
  return { ...u, lancadaPeloDono };
}

test("CASO REAL: contas em outros fornecedores e uma conta que é a SOMA de duas retiradas NÃO são lançadas de novo — só as realmente novas", async () => {
  const { n, importar, previa, lancar, estado, resultado, lancadaPeloDono } = await cenarioDoDono();
  await lancadaPeloDono("SANGRIAS", "2026-11-06", 7550, "compra de espátula + chaves");
  await lancadaPeloDono("Fornecedor A", "2026-11-08", 14000, "Diária Evento + Diária Operador", undefined, "SALARIOS_E_ENCARGOS"); // = 100 + 40 do dia 08, numa conta só, em OUTRA categoria (diária)
  await lancadaPeloDono("SANGRIAS", "2026-11-09", 1800, "Pilhas + taxa do entregador");
  await lancadaPeloDono("SANGRIAS", "2026-11-11", 1225, "Taxas");
  await lancadaPeloDono("Fornecedor B", "2026-11-12", 2500, "Taxas do entregador"); // = 25 do dia 12
  await lancadaPeloDono("Fornecedor C", "2026-11-12", 2600, "descartáveis"); // = 26 do dia 12
  await importar(RETIRADAS());
  const p = await previa();
  const por = (data) => p.itens.filter((i) => i.data === data);
  assert.deepEqual(p.itens.filter((i) => i.situacao === "NOVA").map((i) => [i.data, i.valorCentavos]), [["2026-11-04", 2000], ["2026-11-15", 4500]], "só o dia 04 e o dia 15 são novos");
  assert.deepEqual(por("2026-11-08").map((i) => [i.situacao, i.fornecedorDaConta, i.valorDaContaCentavos, i.retiradasNaConta]), [["JA_LANCADA_EM_CONTA_UNICA", "Fornecedor A", 14000, 2], ["JA_LANCADA_EM_CONTA_UNICA", "Fornecedor A", 14000, 2]], "120+50 do dono = 100+40 aqui: uma conta, duas retiradas");
  assert.deepEqual(por("2026-11-08").map((i) => i.categoriaDaConta), ["Salários e encargos", "Salários e encargos"], "a diária está em outra categoria: a tela mostra qual, e NÃO a lança como Outras despesas");
  assert.equal(por("2026-11-06")[0].categoriaDaConta, "Outras despesas");
  assert.deepEqual(por("2026-11-12").map((i) => [i.situacao, i.fornecedorDaConta]), [["JA_LANCADA_MANUALMENTE", "Fornecedor B"], ["JA_LANCADA_MANUALMENTE", "Fornecedor C"]], "cada uma já está em outro fornecedor");
  assert.deepEqual(por("2026-11-06").map((i) => [i.situacao, i.fornecedorDaConta]), [["JA_LANCADA_MANUALMENTE", "SANGRIAS"]]);
  assert.deepEqual([p.resumo.novas.quantidade, p.resumo.novas.totalCentavos, p.resumo.jaLancadasManualmente.quantidade, p.resumo.emContaUnica.quantidade], [2, 6500, 7, 2]);
  const antes = await estado();
  const resultadoAntes = await resultado();
  const r = await lancar();
  assert.deepEqual([r.lancadas.length, r.falhas.length, r.jaLancadas], [2, 0, 7]);
  const depois = await estado();
  assert.deepEqual([depois.obrigacoes - antes.obrigacoes, depois.movimentacoes - antes.movimentacoes, depois.lancamentos - antes.lancamentos], [2, 2, 2], "só 2 contas novas: nada duplicado");
  assert.equal(await resultado(), resultadoAntes - 6500, "a DRE cai só pelas 2 novas");
  assert.deepEqual([(await previa()).resumo.novas.quantidade, (await previa()).resumo.jaLancadasPelaImportacao.quantidade], [0, 2]);
  assert.deepEqual((await lancar()).lancadas, [], "repetir não lança nada");
  assert.deepEqual(await n.verificarConservacao(c), []);
});

test("reconhecimento pelo pagamento em DINHEIRO do caixa: conta paga pelo BANCO com o mesmo valor, ou pagamento em dinheiro de outro valor, NÃO bloqueiam uma retirada nova", async () => {
  const { n, importar, previa, lancadaPeloDono } = await cenarioDoDono();
  const banco = await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco sintético", instituicao: "Banco" });
  await lancadaPeloDono("Fornecedor D", "2026-11-04", 2000, "pago pelo BANCO, não pelo caixa", banco.id); // mesmo valor da retirada de 04, mas não é dinheiro do caixa
  await lancadaPeloDono("Fornecedor E", "2026-11-15", 9999, "outra compra em dinheiro, valor diferente");
  await importar(RETIRADAS());
  const p = await previa();
  assert.deepEqual(p.itens.filter((i) => i.situacao === "NOVA").map((i) => i.data), ["2026-11-04", "2026-11-06", "2026-11-08", "2026-11-08", "2026-11-09", "2026-11-11", "2026-11-12", "2026-11-12", "2026-11-15"], "nenhuma foi reconhecida por engano");
});

test("a soma só vale com o MESMO dia e valor exato; conta de dia diferente não casa; a mesma conta não cobre duas vezes", async () => {
  const { importar, previa, lancadaPeloDono } = await cenarioDoDono();
  await lancadaPeloDono("Fornecedor F", "2026-11-09", 14000, "mesmo valor da soma do dia 08, mas em outro dia");
  await lancadaPeloDono("Fornecedor G", "2026-11-08", 14000, "soma do dia 08");
  await importar(RETIRADAS());
  const p = await previa();
  assert.deepEqual(p.itens.filter((i) => i.data === "2026-11-08").map((i) => i.fornecedorDaConta), ["Fornecedor G", "Fornecedor G"]);
  assert.deepEqual(p.itens.filter((i) => i.data === "2026-11-09").map((i) => i.situacao), ["NOVA"], "a conta de 140,00 do dia 09 não cobre a retirada de 18,00 do dia 09");
});
