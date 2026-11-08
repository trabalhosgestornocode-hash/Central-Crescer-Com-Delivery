// Pagamento com ORIGEM (conta · origem pendente · pago por terceiro), vínculos de transferência interna e diferenças de períodos. SINTÉTICO.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as obr from "../../src/modules/gestao-financeira/dominio/obrigacoes.service.js";
import { listar } from "../../src/modules/gestao-financeira/dominio/conferencias.service.js";
import { sugerirTransferencias, ehTransferenciaProvavel } from "../../src/financeiro-calculos/transferenciasInternas.js";

const ACAO = { LANCAR: "gestao_financeira.lancar", CONCILIAR: "gestao_financeira.conciliar", CLASSIFICAR: "gestao_financeira.classificar" };
const ctx = { organizacaoId: "00000000-0000-4000-8000-000000000001", unidadeId: "00000000-0000-4000-8000-000000000002", usuarioId: "00000000-0000-4000-8000-000000000003" };
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PLANO = [{ id: U(10), nome: "BENEFICIOS", papel: "despesa_pessoal", ativo: true }, { id: U(11), nome: "INSUMOS - DISTRIBUIDORA", papel: "custo_variavel", ativo: true }, { id: U(12), nome: "RECEBIMENTO", papel: "receita_operacional", ativo: true }];
const OB = (id, c, desc, comp, venc, valor) => ({ id: U(id), fornecedor_id: U(50), categoria_id: U(c), descricao: desc, competencia: comp, vencimento: venc, valor_original_centavos: valor, status: "aberta" });

function mock() {
  const obrs = [OB(1, 10, "Saude do trabalhador 08/2026", "2026-08-01", "2026-09-10", 8000), OB(2, 11, "Distribuidora 28/08", "2026-09-01", "2026-09-04", 663360)];
  const pags = [];
  return {
    obrs, pags,
    repo: {
      listarObrigacoes: async () => obrs, listarPagamentos: async () => pags, listarFornecedores: async () => [{ id: U(50), nome: "F" }], listarPlanoContas: async () => PLANO,
      listarContas: async () => [{ id: U(20), nome: "UNICRED", ativo: true }], listarVinculosSaidas: async () => [], listarAuditoria: async () => [],
      obterObrigacao: async (_c, id) => obrs.find((o) => o.id === id), listarDividas: async () => [{ id: U(30), credor: "Francisca (sócia)", status: "ativa" }, { id: U(31), credor: "Antiga", status: "quitada" }],
      inserirPagamento: async (_c, p) => { const r = { id: U(100 + pags.length), status: "ativo", ...p }; pags.push(r); return r; },
      obterPagamento: async (_c, id) => pags.find((p) => p.id === id), atualizarPagamento: async (_c, id, campos) => Object.assign(pags.find((p) => p.id === id), campos),
      quitarObrigacaoRpc: async (_c, id) => { obrs.find((o) => o.id === id).status = "quitada"; },
    },
    db: undefined, hoje: () => "2026-11-07",
  };
}

test("origem pendente: reconhece o pagamento sem conta, nasce provisório mesmo para quem confirma, exige fonte escrita e NÃO quita", async () => {
  const d = mock();
  await assert.rejects(() => obr.registrarPagamento(ctx, U(1), { data: "2026-09-11", valor: "80", origemPagamento: "origem_pendente", observacao: "curto" }, d, { permissoes: [ACAO.LANCAR, ACAO.CONCILIAR] }), /fonte|10 caracteres/i);
  await assert.rejects(() => obr.registrarPagamento(ctx, U(1), { data: "2026-09-11", valor: "80", origemPagamento: "origem_pendente", observacao: "Apresentação 09/2026 slide 12", quitar: true }, d, { permissoes: [ACAO.LANCAR, ACAO.CONCILIAR] }), /não quita/i);
  const r = await obr.registrarPagamento(ctx, U(1), { data: "2026-09-11", valor: "80", origemPagamento: "origem_pendente", observacao: "Apresentação 09/2026 slide 12: pago em 11/09, conta não informada." }, d, { permissoes: [ACAO.LANCAR, ACAO.CONCILIAR] });
  const p = d.pags[0];
  assert.equal(p.origem_pagamento, "origem_pendente"); assert.equal(p.conta_id, null); assert.equal(p.provisorio, true, "provisório mesmo com permissão de confirmar");
  assert.equal(r.pagamentos[0].origemPagamento, "origem_pendente"); assert.equal(r.pagamentos[0].conta, null);
  assert.equal(r.valorOriginalCentavos, 8000);
  await assert.rejects(() => obr.quitar(ctx, U(1), d), /origem pendente/i);
});

test("origem pendente: depois de informada a conta, vira pagamento normal (uma vez)", async () => {
  const d = mock();
  await obr.registrarPagamento(ctx, U(1), { data: "2026-09-11", valor: "80", origemPagamento: "origem_pendente", observacao: "Apresentação 09/2026 slide 12: pago em 11/09." }, d, { permissoes: [ACAO.LANCAR] });
  const pid = d.pags[0].id;
  await assert.rejects(() => obr.resolverOrigemPagamento(ctx, pid, { contaId: U(99) }, d), /Conta não encontrada/);
  await obr.resolverOrigemPagamento(ctx, pid, { contaId: U(20) }, d);
  assert.equal(d.pags[0].origem_pagamento, "conta"); assert.equal(d.pags[0].conta_id, U(20)); assert.match(d.pags[0].observacao, /Conta de saída informada depois: UNICRED/);
  await assert.rejects(() => obr.resolverOrigemPagamento(ctx, pid, { contaId: U(20) }, d), /origem pendente/i, "não se resolve duas vezes");
});

test("pago por terceiro: exige dívida ATIVA de reembolso, não cria conta de saída e quita sem duplicar o custo", async () => {
  const d = mock();
  const base = { data: "2026-09-05", valor: "6633.60", origemPagamento: "terceiro", observacao: "Sócia pagou com a conta pessoal; reembolso na dívida da sócia (DEV-012)." };
  await assert.rejects(() => obr.registrarPagamento(ctx, U(2), base, d, { permissoes: [ACAO.LANCAR] }), /dívida/i);
  await assert.rejects(() => obr.registrarPagamento(ctx, U(2), { ...base, dividaId: U(31) }, d, { permissoes: [ACAO.LANCAR] }), /dívida ativa/i);
  const r = await obr.registrarPagamento(ctx, U(2), { ...base, dividaId: U(30), terceiro: "Francisca (sócia)", quitar: true }, d, { permissoes: [ACAO.LANCAR, ACAO.CONCILIAR] });
  const p = d.pags[0];
  assert.equal(p.origem_pagamento, "terceiro"); assert.equal(p.conta_id, null); assert.equal(p.divida_id, U(30)); assert.equal(p.terceiro_nome, "Francisca (sócia)");
  assert.equal(r.status, "quitada", "a obrigação deixa de estar em aberto");
  assert.equal(r.pagamentos[0].dividaId, U(30));
});

test("pagamento com conta continua exigindo a conta (comportamento antigo preservado)", async () => {
  const d = mock();
  await assert.rejects(() => obr.registrarPagamento(ctx, U(1), { data: "2026-09-11", valor: "80" }, d, { permissoes: [ACAO.LANCAR] }), /contaId/i);
  await obr.registrarPagamento(ctx, U(1), { data: "2026-09-11", valor: "80", contaId: U(20) }, d, { permissoes: [ACAO.LANCAR] });
  assert.equal(d.pags[0].origem_pagamento, "conta"); assert.equal(d.pags[0].conta_id, U(20));
});

// ------------------------------------------------------------------ sugestão de transferências internas
const L = (id, conta, data, valor, desc = "TRANSFERENCIA ENTRE CONTAS") => ({ id, conta_id: conta, data_movimento: data, valor_centavos: valor, descricao: desc });
test("transferências: 1 para 1, soma de várias entradas, ambíguo e sem contrapartida — nunca confirma", () => {
  const saidas = [L("s1", "stone", "2026-09-06", 82167), L("s2", "stone", "2026-09-04", 99392), L("s3", "stone", "2026-09-10", 50000), L("s4", "stone", "2026-09-20", 77700)];
  const entradas = [L("e1", "unicred", "2026-09-08", 82167), L("e2", "unicred", "2026-09-04", 81850), L("e3", "unicred", "2026-09-04", 17542),
    L("e4", "unicred", "2026-09-10", 50000), L("e5", "unicred", "2026-09-11", 50000)];   // e4 e e5 igualam s3 → ambíguo
  const p = Object.fromEntries(sugerirTransferencias(saidas, entradas).map((x) => [x.saida.id, x]));
  assert.equal(p.s1.status, "um_para_um"); assert.deepEqual(p.s1.contrapartidas.map((e) => e.id), ["e1"]);
  assert.equal(p.s2.status, "um_para_varios"); assert.deepEqual(p.s2.contrapartidas.map((e) => e.id).sort(), ["e2", "e3"]); assert.equal(p.s2.contrapartidas.reduce((a, e) => a + e.valor_centavos, 0), 99392);
  assert.equal(p.s3.status, "ambiguo"); assert.deepEqual(p.s3.contrapartidas, [], "ambíguo não propõe vínculo"); assert.equal(p.s3.alternativas.length, 2);
  assert.equal(p.s4.status, "sem_contrapartida");
});

test("transferências: mesma conta não pareia; fora da janela não pareia; a mesma entrada para duas saídas vira ambígua", () => {
  assert.equal(sugerirTransferencias([L("a", "stone", "2026-09-06", 100)], [L("x", "stone", "2026-09-07", 100)])[0].status, "sem_contrapartida");
  assert.equal(sugerirTransferencias([L("a", "stone", "2026-09-06", 100)], [L("x", "unicred", "2026-09-20", 100)])[0].status, "sem_contrapartida");
  assert.equal(sugerirTransferencias([L("a", "stone", "2026-09-06", 100)], [L("x", "unicred", "2026-09-05", 100)])[0].status, "sem_contrapartida", "entrada antes da saída não pareia");
  const dup = sugerirTransferencias([L("a", "stone", "2026-09-06", 100), L("b", "stone", "2026-09-06", 100)], [L("x", "unicred", "2026-09-07", 100)]);
  assert.deepEqual(dup.map((x) => x.status), ["ambiguo", "ambiguo"]);
  assert.equal(ehTransferenciaProvavel({ descricao: "TRANSFERENCIA ENTRE CONTAS - AF" }), true); assert.equal(ehTransferenciaProvavel({ descricao: "Compra de frutas" }), false);
});

// ------------------------------------------------------------------ central: origem pendente, juros com sugestão, rateios agrupados, períodos
function base(extra = {}) {
  const obrs = [
    { id: U(1), fornecedor_id: U(50), categoria_id: U(10), descricao: "Saude do trabalhador 08/2026", competencia: "2026-08-01", vencimento: "2026-09-10", valor_original_centavos: 8000, status: "aberta" },
    { id: U(3), fornecedor_id: U(50), categoria_id: U(11), descricao: "Compra agosto paga em setembro", competencia: "2026-08-01", vencimento: "2026-09-02", valor_original_centavos: 100000, status: "aberta" },
    { id: U(4), fornecedor_id: U(50), categoria_id: U(11), descricao: "Compra setembro paga em outubro", competencia: "2026-09-01", vencimento: "2026-10-02", valor_original_centavos: 200000, status: "aberta" },
    { id: U(5), fornecedor_id: U(50), categoria_id: U(11), descricao: "Distribuidora 28/08", competencia: "2026-09-01", vencimento: "2026-09-04", valor_original_centavos: 700000, status: "quitada" },
    { id: U(6), fornecedor_id: U(50), categoria_id: U(10), descricao: "Contabilidade 08/2026", competencia: "2026-08-01", vencimento: "2026-08-10", valor_original_centavos: 81000, status: "aberta" },
  ];
  const pg = (id, o, data, valor, extra2 = {}) => ({ id: U(id), obrigacao_id: o, conta_id: U(20), data_pagamento: data, valor_centavos: valor, status: "ativo", origem_pagamento: "conta", ...extra2 });
  const pags = [pg(100, U(1), "2026-09-11", 8000, { conta_id: null, origem_pagamento: "origem_pendente", provisorio: true, observacao: "Apresentação slide 12: conta não informada." }),
    pg(101, U(3), "2026-09-02", 100000), pg(102, U(4), "2026-10-02", 200000),
    pg(103, U(5), "2026-09-05", 700000, { conta_id: null, origem_pagamento: "terceiro", terceiro_nome: "Francisca", divida_id: U(30) }),
    pg(104, U(6), "2026-09-02", 83241)];
  return {
    listarPlanoContas: async () => PLANO, listarContas: async () => [{ id: U(20), nome: "UNICRED", ativo: true }, { id: U(21), nome: "STONE", ativo: true }], listarAberturas: async () => [],
    listarTodosLancamentos: async () => [L("sa", U(21), "2026-09-06", 82167), L("en", U(20), "2026-09-08", 82167)].map((l, i) => ({ ...l, sentido: i ? "entrada" : "saida", status: "realizado", categoria_id: null })),
    listarTransferencias: async () => [], listarReferencias: async () => [{ tipo: "venda", data: "2026-09-05", valor_centavos: 10000000 }], listarObrigacoes: async () => obrs, listarPagamentos: async () => pags, listarFornecedores: async () => [{ id: U(50), nome: "F" }],
    listarVinculosSaidas: async () => [], bloqueiosFechamentoRpc: async () => [], listarAuditoria: async () => [],
    listarRateios: async () => [{ id: "r1", obrigacao_id: U(5), status: "proposto", criterio: "dias_consumo", justificativa: "3 dias de setembro", valor_elegivel_centavos: 700000, origem_documental: "apresentação slide 9" }],
    listarParcelasRateio: async () => [{ rateio_id: "r1", competencia: "2026-08-01", valor_centavos: 400000 }, { rateio_id: "r1", competencia: "2026-09-01", valor_centavos: 300000 }],
    listarVendasCanal: async () => [{ id: "v1", canal: "iFood", origem_tecnica: "integration-ifood", vendas_qtd: 5, valor_painel_centavos: 10100000, valor_gerencial_centavos: 10000000, granularidade: "mensal", fonte: "t", competencia: "2026-09-01" }],
    listarVendasAjustes: async () => [{ id: "a1", canal: "iFood", tipo: "estimativa", valor_centavos: -100000, descricao: "ajuste estimado", estado: "estimado", competencia: "2026-09-01" }],
    listarReferenciasOficiais: async () => [], ...extra,
  };
}
const deps = (extra) => ({ repo: base(extra), db: undefined, hoje: () => "2026-11-07", env: {} });

test("central: origem pendente com seletor de contas, juros com SUGESTÃO (nada aplicado), rateios agrupados e checklist do iFood", async () => {
  const c = await listar(ctx, { mes: "2026-09" }, deps());
  const por = (t) => c.pendencias.filter((p) => p.tipo === t);
  const op = por("origem_pendente")[0];
  assert.equal(op.valorCentavos, 8000); assert.equal(op.acao.caminho, `/contas-pagar/pagamentos/${U(100)}/origem`); assert.deepEqual(op.acao.exige, ["contaId"]); assert.equal(op.contas.length, 2);
  assert.match(op.descricao, /não há saída bancária registrada nem conciliação/);
  const j = por("juros_presumido")[0];
  assert.equal(j.sugestao.natureza, "juros"); assert.match(j.sugestao.evidencia, /slide 6/); assert.match(j.acao.rotulo, /quitar e classificar/i);
  assert.equal(j.acao.caminho, `/contas-pagar/${U(6)}/quitar-e-classificar`); assert.match(j.acao.permissao, /classificar \+ conciliar/);
  const rt = por("rateios"); assert.equal(rt.length, 1, "uma única tela de aprovação"); assert.equal(rt[0].itens.length, 1);
  assert.equal(rt[0].itens[0].parcelas.length, 2); assert.equal(rt[0].itens[0].evidencia, "apresentação slide 9"); assert.equal(rt[0].itens[0].caminhoAprovar, "/rateios/r1/aprovar");
  const aj = por("ajuste_vendas")[0];
  assert.ok(aj.checklist.precisaInformar.length >= 4); assert.match(aj.checklist.onde, /Portal do Parceiro/); assert.match(aj.checklist.conta, /R\$ 1\.000,00/);
  assert.match(aj.checklist.comoConfirmar, /NÃO confirme/); assert.equal(aj.acao.exige[0], "evidencia");
  const tr = por("transferencias_internas")[0];
  assert.equal(tr.linhas.length, 1); assert.equal(tr.linhas[0].status, "um_para_um"); assert.equal(tr.linhas[0].vincular.caminho, "/transferencias/vincular");
  assert.ok(!por("conta_sem_pagamento").some((p) => p.valorCentavos === 8000), "a saúde do trabalhador não é mais 'conta sem pagamento'");
});

test("períodos: contas do mês anterior pagas no mês (parcela de rateio, sem o que a sócia pagou) e do mês pagas no seguinte", async () => {
  const c = await listar(ctx, { mes: "2026-09" }, deps());
  // anterior pago no mês: compra de agosto integral 1.000,00 + parcela de AGOSTO do rateio da Distribuidora ficaria fora porque foi paga por TERCEIRO
  assert.equal(c.periodos.anteriorPagaNoMes.totalCentavos, 100000);
  assert.deepEqual(c.periodos.anteriorPagaNoMes.itens.map((i) => i.descricao), ["Compra agosto paga em setembro"]);
  assert.equal(c.periodos.mesPagoDepois.totalPagoCentavos, 200000); assert.equal(c.periodos.mesPagoDepois.totalNoResultadoCentavos, 200000);
  assert.equal(c.periodos.mesAnterior, "2026-08"); assert.equal(c.periodos.mesSeguinte, "2026-10");
  const d2 = await listar(ctx, { mes: "2026-09" }, deps({ listarReferenciasOficiais: async () => [{ indicador: "contasAnteriorPagasNoMes", rotulo: "Contas de agosto pagas em setembro", valorCentavos: 100000 }, { indicador: "contasMesPagasDepois", rotulo: "Contas de setembro pagas em outubro", valorCentavos: 200001 }] }));
  assert.equal(d2.comparacao.find((x) => x.indicador === "contasAnteriorPagasNoMes").confere, true);
  assert.equal(d2.comparacao.find((x) => x.indicador === "contasMesPagasDepois").confere, false, "1 centavo de diferença aparece, não é arredondado");
});
