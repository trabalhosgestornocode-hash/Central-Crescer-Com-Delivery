// Juros por competência × pagos no período; ponte painel (SAIPOS) → base gerencial; registro/importação de faturamento por canal.
// Dados 100% SINTÉTICOS (valores pensados para reproduzir a mecânica, não os números reais).
import { test } from "node:test";
import assert from "node:assert/strict";
import { acrescimoDaObrigacao, jurosDoMes } from "../../src/financeiro-calculos/contasPagar.js";
import { comporPonte, nomeDoCanal } from "../../src/financeiro-calculos/canaisVenda.js";
import * as vendas from "../../src/modules/gestao-financeira/dominio/vendasCanal.service.js";
import { painel } from "../../src/modules/gestao-financeira/dominio/painel.service.js";

const ctx = { organizacaoId: "00000000-0000-4000-8000-000000000001", unidadeId: "00000000-0000-4000-8000-000000000002", usuarioId: "00000000-0000-4000-8000-000000000003" };

// ------------------------------------------------------------------ juros
const obr = (id, comp, venc, original, status = "aberta", extra = {}) => ({ id, descricao: `Contabilidade ${comp}`, competencia: `${comp}-01`, vencimento: venc, valor_original_centavos: original, status, ...extra });
const pg = (id, data, valor, status = "ativo") => ({ id, data_pagamento: data, valor_centavos: valor, status });

test("acréscimo = total pago − original, somando TODOS os pagamentos; parcial nunca vira desconto nem acréscimo", () => {
  const a = acrescimoDaObrigacao(obr("a", "2026-08", "2026-08-10", 81000), [pg("1", "2026-09-02", 83241)]);
  assert.equal(a.acrescimoCentavos, 2241); assert.equal(a.percentualBps, 277); assert.equal(a.natureza, "presumido"); assert.equal(a.quitada, false);
  const dois = acrescimoDaObrigacao(obr("b", "2026-08", "2026-08-10", 100000), [pg("1", "2026-09-01", 60000), pg("2", "2026-09-20", 41000)]);
  assert.equal(dois.acrescimoCentavos, 1000, "soma dos dois pagamentos");
  assert.deepEqual(dois.porPagamento.map((x) => x.acrescimoCentavos), [0, 1000], "o excesso é do pagamento que ultrapassa o original");
  const parcial = acrescimoDaObrigacao(obr("c", "2026-09", "2026-09-10", 100000), [pg("1", "2026-09-12", 40000)]);
  assert.equal(parcial.acrescimoCentavos, 0); assert.equal(parcial.parcialAberta, true, "pagamento parcial é saldo em aberto, não desconto");
  assert.equal(acrescimoDaObrigacao(obr("d", "2026-09", "2026-09-10", 100000), [pg("1", "2026-09-12", 120000, "cancelado")]).acrescimoCentavos, 0, "pagamento cancelado não conta");
  assert.equal(acrescimoDaObrigacao(obr("e", "2026-09", "2026-09-10", 100000, "quitada", { classificacao_diferenca: "multa" }), [pg("1", "2026-09-12", 100500)]).natureza, "multa", "classificação confirmada é respeitada");
});

test("juros do mês: separa PAGOS NO MÊS da COMPETÊNCIA (43,41 das duas obrigações, só 22,41 pagos em setembro)", () => {
  const itens = [
    { obrigacao: obr("c8", "2026-08", "2026-08-10", 81000), pagamentos: [pg("p1", "2026-09-02", 83241)] },       // juros 22,41 — pagos em setembro
    { obrigacao: obr("c9", "2026-09", "2026-09-10", 81000), pagamentos: [pg("p2", "2026-10-01", 83100)] },       // juros 21,00 — pagos em outubro
  ];
  const set = jurosDoMes(itens, "2026-09");
  assert.equal(set.pagosNoMes.totalCentavos, 2241, "pago em setembro");
  assert.equal(set.daCompetencia.totalCentavos, 2100, "juros das obrigações de competência setembro");
  assert.equal(set.totalRelacionadasCentavos, 4341, "total das duas obrigações");
  assert.equal(set.relacionadas.length, 2);
  assert.equal(set.pagosNoMes.presumidoCentavos, 2241, "continua presumido até alguém classificar");
  const out = jurosDoMes(itens, "2026-10");
  assert.equal(out.pagosNoMes.totalCentavos, 2100); assert.equal(out.daCompetencia.totalCentavos, 0);
  assert.equal(jurosDoMes(itens, "2026-07").relacionadas.length, 0, "mês sem relação não traz nada");
  assert.equal(jurosDoMes([{ obrigacao: obr("x", "2026-09", "2026-09-10", 100000, "cancelada"), pagamentos: [pg("1", "2026-09-12", 120000)] }], "2026-09").totalRelacionadasCentavos, 0, "obrigação cancelada fora");
});

// ------------------------------------------------------------------ ponte por canal
const CANAIS = [
  { id: "c1", canal: "Balcão", origemTecnica: "Açaí no Grau", vendasQtd: 10, painelCentavos: 500000, gerencialCentavos: 500000, granularidade: "mensal" },
  { id: "c2", canal: "iFood", origemTecnica: "integration-ifood", vendasQtd: 8, painelCentavos: 315000, gerencialCentavos: 307000, granularidade: "mensal" },
  { id: "c3", canal: "Anota Aí", origemTecnica: "integration-api-int-sale", vendasQtd: 5, painelCentavos: 28000, gerencialCentavos: 20000, granularidade: "mensal" },
];
const AJ = [
  { id: "a1", canal: "iFood", tipo: "estimativa", valorCentavos: -8000, descricao: "Taxa de entrega e descontos do iFood (estimado)", estado: "estimado" },
  { id: "a2", canal: "Anota Aí", tipo: "taxa_entrega", valorCentavos: -5000, descricao: "Taxas de entrega", estado: "confirmado" },
  { id: "a3", canal: "Anota Aí", tipo: "desconto", valorCentavos: -3000, descricao: "Descontos", estado: "confirmado" },
];

test("ponte: painel + ajustes = base gerencial (por canal e no total) e confere com o bruto oficial", () => {
  const p = comporPonte({ canais: CANAIS, ajustes: AJ, brutoOficialCentavos: 827000 });
  assert.equal(p.painelCentavos, 843000); assert.equal(p.ajustesCentavos, -16000); assert.equal(p.gerencialCentavos, 827000);
  assert.equal(p.ponteFecha, true); assert.equal(p.baseConfere, true); assert.equal(p.diferenciaBaseCentavos, undefined);
  assert.deepEqual(p.canais.map((c) => c.canal), ["Balcão", "Anota Aí", "iFood"]);
  assert.deepEqual(p.ponte.map((x) => x.tipo), ["painel", "ajuste", "ajuste", "ajuste", "gerencial"]);
  assert.equal(p.estimadosCentavos, -8000); assert.equal(p.pendentes.length, 1, "só o ajuste estimado fica pendente");
  assert.equal(p.canais.find((c) => c.canal === "iFood").pendente, true); assert.equal(p.canais.find((c) => c.canal === "Anota Aí").pendente, false);
});

test("ponte: divergências ficam expostas (ajuste que falta, canal sem registro, base ≠ bruto oficial) — nada é ajustado", () => {
  const semAjuste = comporPonte({ canais: CANAIS, ajustes: AJ.slice(0, 2), brutoOficialCentavos: 827000 });
  assert.equal(semAjuste.ponteFecha, false, "falta um ajuste → a ponte não fecha");
  assert.equal(semAjuste.canais.find((c) => c.canal === "Anota Aí").diferencaCanalCentavos, -3000);
  const orfao = comporPonte({ canais: CANAIS, ajustes: [...AJ, { id: "z", canal: "Rappi", tipo: "outro", valorCentavos: -100, descricao: "x", estado: "estimado" }], brutoOficialCentavos: 827000 });
  assert.equal(orfao.ajustesSemCanal.length, 1); assert.equal(orfao.ponteFecha, false, "ajuste de canal não registrado não se perde em silêncio");
  const base = comporPonte({ canais: CANAIS, ajustes: AJ, brutoOficialCentavos: 830000 });
  assert.equal(base.baseConfere, false); assert.equal(base.diferencaBaseCentavos, -3000);
  assert.equal(nomeDoCanal("integration-ifood"), "iFood"); assert.equal(nomeDoCanal("Açaí no Grau"), "Balcão"); assert.equal(nomeDoCanal("canal novo"), "canal novo");
});

// ------------------------------------------------------------------ serviço: registro/importação sem duplicar
function repoMemoria() {
  const canais = [], ajustes = []; let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  return {
    listarReferencias: async () => [{ tipo: "venda", data: "2026-09-05", valor_centavos: 827000 }],
    listarVendasCanal: async (_c, { competencia } = {}) => canais.filter((r) => r.status === "ativa" && (!competencia || r.competencia === competencia)),
    listarVendasAjustes: async (_c, { competencia } = {}) => ajustes.filter((r) => r.status === "ativa" && (!competencia || r.competencia === competencia)),
    inserirVendaCanal: async (_c, l) => { const r = { id: id(), status: "ativa", ...l }; canais.push(r); return r; },
    inserirVendaAjuste: async (_c, l) => { const r = { id: id(), status: "ativa", ...l }; ajustes.push(r); return r; },
    atualizarVendaCanal: async (_c, i, campos) => { const r = canais.find((x) => x.id === i); if (!r) return null; Object.assign(r, campos); return r; },
    atualizarVendaAjuste: async (_c, i, campos) => { const r = ajustes.find((x) => x.id === i); if (!r) return null; Object.assign(r, campos); return r; },
  };
}
const dps = () => ({ repo: repoMemoria(), db: undefined, agora: () => "2026-11-07T12:00:00Z" });
const IMPORT = { mes: "2026-09", fonte: "Apresentação 09/2026", canais: [
  { canal: "Balcão", origemTecnica: "Açaí no Grau", vendasQtd: 10, valorPainel: "5000.00", valorGerencial: "5000.00" },
  { canal: "iFood", origemTecnica: "integration-ifood", vendasQtd: 8, valorPainel: "3150.00", valorGerencial: "3070.00" },
  { canal: "Anota Aí", origemTecnica: "integration-api-int-sale", valorPainel: "280.00", valorGerencial: "200.00" }],
  ajustes: [{ canal: "iFood", tipo: "estimativa", valor: "-80.00", descricao: "Taxa de entrega e descontos do iFood (estimado)" }, { canal: "Anota Aí", tipo: "taxa_entrega", valor: "-50.00", descricao: "Taxas de entrega" }, { canal: "Anota Aí", tipo: "desconto", valor: "-30.00", descricao: "Descontos" }] };

test("importação é idempotente (reimportar não duplica) e avisa conflito de valores", async () => {
  const d = dps();
  const a = await vendas.importar(ctx, IMPORT, d);
  assert.deepEqual(a.criados, { canais: 3, ajustes: 3 });
  const b = await vendas.importar(ctx, IMPORT, d);
  assert.deepEqual(b.criados, { canais: 0, ajustes: 0 }); assert.deepEqual(b.jaExistentes, { canais: 3, ajustes: 3 });
  const c = await vendas.importar(ctx, { ...IMPORT, canais: [{ ...IMPORT.canais[0], valorPainel: "9999.00" }], ajustes: [] }, d);
  assert.equal(c.conflitos.length, 1); assert.match(c.conflitos[0], /valores diferentes/);
  const v = await vendas.listar(ctx, { mes: "2026-09" }, d);
  assert.equal(v.canais.length, 3); assert.equal(v.ponteFecha, true); assert.equal(v.baseConfere, true);
  assert.equal(v.painelCentavos, 843000);
});

test("registrar canal: um ativo por mês; cancelar exige motivo; ajuste nasce ESTIMADO e só confirma com evidência", async () => {
  const d = dps();
  const r = await vendas.registrarCanal(ctx, { mes: "2026-09", canal: "Balcão", valorPainel: "5000.00", fonte: "manual", granularidade: "mensal" }, d);
  assert.match(r.observacaoFluxo, /Não cria recebimento bancário/); assert.ok(r.mostrarEm.length >= 2);
  await assert.rejects(() => vendas.registrarCanal(ctx, { mes: "2026-09", canal: "Balcão", valorPainel: "1.00", fonte: "manual" }, d), /Já existe faturamento de Balcão/);
  await assert.rejects(() => vendas.cancelarCanal(ctx, r.id, { motivo: "x" }, d), /motivo/i);
  assert.equal((await vendas.cancelarCanal(ctx, r.id, { motivo: "lançado no mês errado" }, d)).id, r.id);
  assert.equal((await vendas.registrarCanal(ctx, { mes: "2026-09", canal: "Balcão", valorPainel: "5000.00", fonte: "manual" }, d)).canal, "Balcão", "depois de cancelar pode registrar de novo");
  const aj = await vendas.registrarAjuste(ctx, { mes: "2026-09", canal: "iFood", tipo: "estimativa", valor: "-80,00", descricao: "estimado" }, d);
  assert.equal(aj.estado, "estimado"); assert.equal(aj.valorCentavos, -8000);
  await assert.rejects(() => vendas.confirmarAjuste(ctx, aj.id, { evidencia: "ok" }, d), /evidência/i);
  const ok = await vendas.confirmarAjuste(ctx, aj.id, { evidencia: "Portal do Parceiro, relatório de setembro" }, d);
  assert.equal(ok.estado, "confirmado");
  await assert.rejects(() => vendas.registrarAjuste(ctx, { mes: "2026-09", canal: "iFood", tipo: "estimativa", valor: "0", descricao: "zero" }, d), /zero/);
  await assert.rejects(() => vendas.registrarCanal(ctx, { mes: "2026-13", canal: "x", valorPainel: "1", fonte: "m" }, d), /mes inválido/);
});

// ------------------------------------------------------------------ painel: bruto por canal com as duas visões
test("painel: Faturamento bruto traz base gerencial + total do painel + ponte; nada de 'sem canal'; ajuste estimado vira pendência", async () => {
  const d = dps(); await vendas.importar(ctx, IMPORT, d);
  for (const a of (await vendas.listar(ctx, { mes: "2026-09" }, d)).ajustes.filter((x) => x.canal === "Anota Aí")) await vendas.confirmarAjuste(ctx, a.id, { evidencia: "Apresentação da contadora 09/2026, slide 3" }, d);   // o do iFood segue ESTIMADO
  const PLANO = [{ id: "c-rec", nome: "RECEBIMENTO", papel: "receita_operacional", tipo: "X", ativo: true }, { id: "c-ins", nome: "INSUMOS - FRUTAS", papel: "custo_variavel", tipo: "X", ativo: true }];
  Object.assign(d.repo, {
    listarPlanoContas: async () => PLANO, listarContas: async () => [{ id: "k1", nome: "BANCO", ativo: true }], listarAberturas: async () => [], listarTodosLancamentos: async () => [],
    listarObrigacoes: async () => [{ id: "o1", fornecedor_id: "f1", categoria_id: "c-ins", descricao: "frutas", competencia: "2026-09-01", vencimento: "2026-09-10", valor_original_centavos: 100000, status: "aberta" }], listarPagamentos: async () => [],
    listarFornecedores: async () => [{ id: "f1", nome: "F" }], listarVinculosSaidas: async () => [], bloqueiosFechamentoRpc: async () => [] });
  d.hoje = () => "2026-11-06";
  const p = await painel(ctx, { mes: "2026-09" }, d);
  const c = p.composicao.faturamentoBruto;
  assert.equal(c.valorCentavos, 827000);
  assert.deepEqual(c.componentes.map((x) => [x.rotulo, x.centavos]), [["Balcão", 500000], ["Anota Aí", 20000], ["iFood", 307000]], "base gerencial por canal");
  assert.equal(c.conferencia.confere, true, "Σ canais (base gerencial) = bruto oficial");
  assert.equal(c.alertas.length, 0); assert.ok(!c.faltam.length);
  assert.equal(c.visoes.painel.totalCentavos, 843000); assert.equal(c.visoes.gerencial.totalCentavos, 827000);
  assert.equal(c.visoes.ponte.length, 5);
  assert.equal(c.pendencias.length, 1); assert.match(c.pendencias[0], /estimado/);
  assert.ok(c.notas.some((t) => /Consolidação mensal/.test(t)), "dado mensal identificado como consolidação mensal");
  assert.ok(!c.notas.some((t) => /distribu/i.test(t) && /dia/.test(t) && !/não distribui/.test(t)));
  assert.equal(p.composicao.totalVendasCanais.valorCentavos, 843000, "total de vendas por canal = total do painel");
  assert.equal(p.composicao.totalVendasCanais.ponte.length, 5);
  const ifood = c.componentes.find((x) => x.rotulo === "iFood");
  assert.equal(ifood.situacao, "pendente_contadora"); assert.deepEqual(ifood.origemTecnica, ["integration-ifood"]);
  assert.equal(ifood.filhos.reduce((s, f) => s + f.centavos, 0), ifood.centavos, "painel + ajuste = base do canal");
  const bal = c.componentes.find((x) => x.rotulo === "Balcão"); assert.equal(bal.situacao, "confirmado");
});
