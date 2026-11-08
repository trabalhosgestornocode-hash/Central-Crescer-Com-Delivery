// Composição dos indicadores, DRE em árvore, rótulo "Entregadores Próprios (Motoboys)" e conciliação da categoria. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { painel, dreReferencia } from "../../src/modules/gestao-financeira/dominio/painel.service.js";
import * as rel from "../../src/modules/gestao-financeira/dominio/relatorios.service.js";
import { conciliarCategoria, conferir, piorSituacao, SITUACAO } from "../../src/financeiro-calculos/composicao.js";
import { rotuloCategoria, planoParaExibicao, organizacoesEntregadoresProprios, ENTREGADORES_PROPRIOS } from "../../src/financeiro-calculos/rotulosCategorias.js";

const ORG = "00000000-0000-4000-8000-000000000001", OUTRA = "00000000-0000-4000-8000-000000000009";
const ctx = { organizacaoId: ORG, unidadeId: "00000000-0000-4000-8000-000000000002", usuarioId: "00000000-0000-4000-8000-000000000003" };
const ENV_LIGADO = { FINANCEIRO_ROTULOS_ENTREGADORES_ORGANIZACOES: ORG };
const cat = (id, nome, papel) => ({ id, nome, papel, tipo: "X", ativo: true });
const PLANO = [cat("c-rec", "RECEBIMENTO DE CLIENTE", "receita_operacional"), cat("c-ins", "INSUMOS - FRUTAS", "custo_variavel"), cat("c-fre", "FRETE", "custo_variavel"),
  cat("c-sal", "SALARIO", "despesa_pessoal"), cat("c-sim", "SIMPLES NACIONAL", "tributo"), cat("c-dia", "DIARIA", "despesa_pessoal")];

// Cenário: 4 obrigações de FRETE (entregadores). o1 = semana de ago paga em set; o2 = semana de set paga em set; o3 = RATEADA (2 meses) paga em set;
// o4 = RATEADA paga em out. Livro-caixa de set tem 20 centavos de lançamento sem pagamento correspondente.
const obr = (id, cat_, desc, comp, venc, valor) => ({ id, fornecedor_id: "f1", categoria_id: cat_, descricao: desc, competencia: comp, vencimento: venc, valor_original_centavos: valor, status: "aberta" });
const OBRIGACOES = [
  obr("o1", "c-fre", "Entregas ref. semana de agosto", "2026-08-01", "2026-09-02", 250000),
  obr("o2", "c-fre", "Entregas semana 07 a 13/09", "2026-09-01", "2026-09-16", 160000),
  obr("o3", "c-fre", "Entregas 31/08 a 06/09", "2026-09-01", "2026-09-09", 240000),
  obr("o4", "c-fre", "Entregas 28/09 a 04/10", "2026-09-01", "2026-10-07", 140000),
  obr("o5", "c-ins", "frutas", "2026-09-01", "2026-09-10", 300000),
  obr("o6", "c-sim", "simples", "2026-08-01", "2026-09-20", 50000),
];
const pg = (id, o, data, valor) => ({ id, obrigacao_id: o, conta_id: "k1", data_pagamento: data, valor_centavos: valor, status: "ativo" });
const PAGAMENTOS = [pg("p1", "o1", "2026-09-02", 250000), pg("p2", "o2", "2026-09-16", 160000), pg("p3", "o3", "2026-09-09", 240000), pg("p4", "o4", "2026-10-07", 140000), pg("p6", "o6", "2026-09-20", 50000)];
const RATEIOS = [{ id: "r1", obrigacao_id: "o3", status: "proposto", criterio: "producao" }, { id: "r2", obrigacao_id: "o4", status: "proposto", criterio: "producao" }];
const PARCELAS = [
  { rateio_id: "r1", competencia: "2026-08-01", valor_centavos: 200000 }, { rateio_id: "r1", competencia: "2026-09-01", valor_centavos: 40000 },
  { rateio_id: "r2", competencia: "2026-09-01", valor_centavos: 50000 }, { rateio_id: "r2", competencia: "2026-10-01", valor_centavos: 90000 },
];
const LANC_FRETE = [
  { id: "l1", conta_id: "k1", categoria_id: "c-fre", sentido: "saida", valor_centavos: 252000, data_movimento: "2026-09-02", status: "realizado", descricao: "FRETE - semana ago" },   // 2.000 a mais que o pagamento
  { id: "l2", conta_id: "k1", categoria_id: "c-fre", sentido: "saida", valor_centavos: 160000, data_movimento: "2026-09-16", status: "realizado", descricao: "FRETE - semana 07 a 13" },
  { id: "l3", conta_id: "k1", categoria_id: "c-fre", sentido: "saida", valor_centavos: 240000, data_movimento: "2026-09-09", status: "realizado", descricao: "FRETE - 31/08 a 06/09" },
];
const repo = () => ({
  listarPlanoContas: async () => PLANO,
  listarContas: async () => [{ id: "k1", nome: "BANCO", ativo: true }],
  listarAberturas: async () => [{ conta_id: "k1", data_referencia: "2026-09-01", valor_centavos: 100000 }],
  listarTodosLancamentos: async () => [{ id: "e1", conta_id: "k1", categoria_id: "c-rec", sentido: "entrada", valor_centavos: 5000000, data_movimento: "2026-09-05", status: "realizado", descricao: "repasse" }, ...LANC_FRETE],
  listarReferencias: async () => [{ tipo: "venda", data: "2026-09-05", valor_centavos: 6000000 }, { tipo: "dinheiro", data: "2026-09-05", valor_centavos: 500000 }],
  listarObrigacoes: async () => OBRIGACOES, listarPagamentos: async () => PAGAMENTOS,
  listarFornecedores: async () => [{ id: "f1", nome: "Entregador Sintético" }],
  listarVinculosSaidas: async () => [], bloqueiosFechamentoRpc: async () => [],
  listarRateios: async () => RATEIOS, listarParcelasRateio: async () => PARCELAS,
});
const deps = (env = ENV_LIGADO) => ({ repo: repo(), db: undefined, hoje: () => "2026-11-06", env });

// ------------------------------------------------------------------ rótulo por empresa
test("FRETE vira Entregadores Próprios SÓ nas empresas liberadas; o nome gravado e o id permanecem", () => {
  const r = rotuloCategoria({ organizacaoId: ORG, nome: "FRETE", papel: "custo_variavel" }, ENV_LIGADO);
  assert.equal(r.nome, "Entregadores Próprios (Motoboys)");
  assert.equal(r.nomeOriginal, "FRETE");
  assert.match(r.explicacao, /entregadores próprios/i);
  assert.match(r.explicacao, /fretes de fornecedores/);
  const outra = rotuloCategoria({ organizacaoId: OUTRA, nome: "FRETE", papel: "custo_variavel" }, ENV_LIGADO);
  assert.equal(outra.nome, "FRETE"); assert.equal(outra.renomeada, false);
  const plano = planoParaExibicao(ORG, PLANO, ENV_LIGADO);
  assert.equal(plano.find((c) => c.id === "c-fre").nome, "Entregadores Próprios (Motoboys)");
  assert.equal(plano.find((c) => c.id === "c-fre").papel, "custo_variavel");
  assert.equal(PLANO.find((c) => c.id === "c-fre").nome, "FRETE", "o plano original não é mutado");
});

test("fail-closed: sem variável, vazia ou inválida ninguém é renomeado; só FRETE de custo variável é afetado", () => {
  for (const env of [{}, { FINANCEIRO_ROTULOS_ENTREGADORES_ORGANIZACOES: "" }, { FINANCEIRO_ROTULOS_ENTREGADORES_ORGANIZACOES: "*" }, { FINANCEIRO_ROTULOS_ENTREGADORES_ORGANIZACOES: "todas" }]) {
    assert.equal(organizacoesEntregadoresProprios(env).size, 0);
    assert.equal(rotuloCategoria({ organizacaoId: ORG, nome: "FRETE", papel: "custo_variavel" }, env).renomeada, false);
  }
  assert.equal(rotuloCategoria({ organizacaoId: ORG, nome: "FRETE", papel: "despesa_fixa" }, ENV_LIGADO).renomeada, false, "FRETE com outra natureza não é renomeado");
  assert.equal(rotuloCategoria({ organizacaoId: ORG, nome: "FRETE FORNECEDOR", papel: "custo_variavel" }, ENV_LIGADO).renomeada, false);
  assert.equal(rotuloCategoria({ organizacaoId: ORG, nome: "INSUMOS - FRUTAS", papel: "custo_variavel" }, ENV_LIGADO).renomeada, false);
  assert.equal(ENTREGADORES_PROPRIOS.distincoes.length, 3, "distingue entregadores próprios, plataformas e fretes de fornecedores");
});

test("o DRE de referência e a árvore exibem o novo nome, sem alterar valores nem classificação", async () => {
  const antes = await dreReferencia(ctx, { mes: "2026-09" }, deps({}));
  const depois = await dreReferencia(ctx, { mes: "2026-09" }, deps());
  assert.deepEqual(depois.indicadores, antes.indicadores, "renomear não muda nenhum número");
  const linhaAntes = antes.grupos.flatMap((g) => g.linhas).find((l) => l.descricao === "FRETE");
  const linhaDepois = depois.grupos.flatMap((g) => g.linhas).find((l) => l.descricao === "Entregadores Próprios (Motoboys)");
  assert.ok(linhaAntes && linhaDepois);
  assert.equal(linhaDepois.centavos, linhaAntes.centavos);
  assert.equal(linhaDepois.nomeOriginal, "FRETE");
  assert.equal(linhaDepois.criterio, linhaAntes.criterio);
  const entregas = depois.arvore.find((n) => n.id === "custos").filhos.find((n) => n.id === "entregas");
  assert.equal(entregas.filhos[0].rotulo, "Entregadores Próprios (Motoboys)");
  assert.equal(entregas.filhos[0].nomeOriginal, "FRETE");
  assert.ok(entregas.filhos[0].explicacao);
  assert.ok(depois.regras.some((r) => r.categoria === "Entregadores Próprios (Motoboys)" && r.nomeOriginal === "FRETE"));
});

test("outra empresa continua vendo FRETE (não há renomeação global)", async () => {
  const d = await dreReferencia({ ...ctx, organizacaoId: OUTRA }, { mes: "2026-09" }, deps());
  assert.ok(d.grupos.flatMap((g) => g.linhas).some((l) => l.descricao === "FRETE"));
  assert.equal(d.conciliacaoEntregadores, null);
});

test("DRE de caixa e ranking de categorias usam o nome exibido, mas o fechamento (carregarBase padrão) segue o gravado", async () => {
  const dreCx = await rel.dre(ctx, { de: "2026-09-01", ate: "2026-09-30" }, deps());
  const nomes = dreCx.linhas.flatMap((l) => (l.detalhes ?? []).map((x) => x.nome));
  assert.ok(nomes.includes("Entregadores Próprios (Motoboys)"), "detalhe do DRE de caixa");
  assert.ok(!nomes.includes("FRETE"));
  const rk = await rel.categorias(ctx, { de: "2026-09-01", ate: "2026-09-30" }, deps());
  assert.ok(rk.itens.some((i) => i.nome === "Entregadores Próprios (Motoboys)"));
  const base = await rel.carregarBase(ctx, { de: "2026-09-01", ate: "2026-09-30" }, deps());
  assert.equal(base.categoriasPorId.get("c-fre").nome, "FRETE", "fechamento de período usa o nome gravado");
  const valorCaixa = dreCx.linhas.find((l) => l.id === "custos").detalhes.find((x) => x.nome === "Entregadores Próprios (Motoboys)").centavos;
  const semRotulo = await rel.dre(ctx, { de: "2026-09-01", ate: "2026-09-30" }, deps({}));
  assert.equal(semRotulo.linhas.find((l) => l.id === "custos").detalhes.find((x) => x.nome === "FRETE").centavos, valorCaixa);
});

// ------------------------------------------------------------------ conciliação da categoria (a diferença entre caixa e gerencial)
test("conciliação: do livro-caixa ao DRE gerencial cada degrau é calculado e a ponte fecha ao centavo", async () => {
  const d = await dreReferencia(ctx, { mes: "2026-09" }, deps());
  const c = d.conciliacaoEntregadores;
  assert.ok(c);
  const caixa = 252000 + 160000 + 240000;
  assert.equal(c.partidaCentavos, caixa, "livro-caixa de setembro");
  // gerencial = o2 (competência set, sem rateio: valor original) + parcelas de set dos rateios
  assert.equal(c.gerencialCentavos, 160000 + 40000 + 50000);
  assert.equal(c.confere, true, "a soma dos degraus fecha com o gerencial");
  assert.equal(c.diferencaCentavos, 0);
  const degrau = (id) => c.degraus.find((x) => x.id === id);
  assert.equal(degrau("livro_sem_vinculo").centavos, -2000, "lançamento do livro-caixa sem pagamento correspondente");
  assert.equal(degrau("outra_competencia").centavos, -250000, "pago em set, competência de agosto");
  assert.equal(degrau("rateadas_pago_menos_parcela").centavos, -(240000 - 40000) + 50000, "rateada paga: sobra do pago acima da parcela; rateada ainda não paga: parcela a mais");
  assert.equal(c.partidaCentavos + c.degraus.reduce((s, x) => s + x.centavos, 0), c.gerencialCentavos);
  assert.equal(c.nomeOriginal, "FRETE");
  assert.equal(c.categoria, "Entregadores Próprios (Motoboys)");
});

test("conciliarCategoria: ponte vazia quando caixa e competência coincidem; diferença residual fica exposta", () => {
  const base = { mes: "2026-09", obrigacoes: [{ id: "a", descricao: "x", competencia: "2026-09-01", valorCentavos: 1000, status: "aberta" }], pagamentos: [{ obrigacaoId: "a", data: "2026-09-10", valorCentavos: 1000 }], parcelasRateio: [], rateadas: new Set() };
  const ok = conciliarCategoria({ ...base, livroCaixaCentavos: 1000, gerencialCentavos: 1000 });
  assert.equal(ok.confere, true); assert.deepEqual(ok.degraus, []);
  const errado = conciliarCategoria({ ...base, livroCaixaCentavos: 1000, gerencialCentavos: 1500 });
  assert.equal(errado.confere, false); assert.equal(errado.diferencaCentavos, 500, "o que não é explicado aparece, nunca é escondido");
});

// ------------------------------------------------------------------ composição dos indicadores
test("composição: cada indicador de soma confere (componentes = total) e carrega fórmula, origem e situação", async () => {
  const p = await painel(ctx, { mes: "2026-09" }, deps());
  for (const id of ["faturamentoBruto", "faturamentoLiquido", "cmv", "custos", "despesas", "resultadoGerencial", "margemContribuicao", "recebimentos", "contasAPagar", "deducoes"]) {
    const c = p.composicao[id];
    assert.ok(c, id); assert.ok(c.formula && c.origem, `${id}: fórmula e origem`);
    assert.ok(Object.values(SITUACAO).includes(c.situacao), `${id}: situação`);
    if (c.conferencia?.confere != null) assert.equal(c.conferencia.confere, true, `${id}: soma dos componentes = total (dif ${c.conferencia.diferencaCentavos})`);
  }
  assert.equal(p.composicao.faturamentoLiquido.valorCentavos, p.indicadores.faturamentoLiquido.valorCentavos);
  assert.equal(p.composicao.resultadoGerencial.valorCentavos, p.indicadores.resultadoGerencial.valorCentavos);
});

test("faturamento bruto: sem canal na base NÃO inventa Balcão/iFood/Anota Aí; explica o que falta e não confunde espécie com canal", async () => {
  const c = (await painel(ctx, { mes: "2026-09" }, deps())).composicao.faturamentoBruto;
  assert.equal(c.componentes.length, 1);
  assert.match(c.componentes[0].rotulo, /sem canal informado/);
  assert.equal(c.componentes[0].centavos, c.valorCentavos);
  assert.ok(c.faltam.some((t) => /canal/i.test(t)));
  assert.ok(c.notas.some((t) => /Forma de pagamento não é canal/.test(t)));
  assert.ok(!c.componentes.some((x) => /iFood|Balc|Anota/i.test(x.rotulo)));
});

test("faturamento bruto: com canais registrados, a composição usa os nomes reais e soma o bruto", async () => {
  const d = deps(); const r0 = d.repo.listarReferencias;
  d.repo.listarReferencias = async (...a) => [{ tipo: "venda", canal: "BALCAO", data: "2026-09-05", valor_centavos: 2500000 }, { tipo: "venda", canal: "IFOOD", data: "2026-09-05", valor_centavos: 3500000 }];
  const c = (await painel(ctx, { mes: "2026-09" }, d)).composicao.faturamentoBruto;
  assert.deepEqual(c.componentes.map((x) => [x.rotulo, x.centavos]).sort(), [["BALCAO", 2500000], ["IFOOD", 3500000]].sort());
  assert.equal(c.conferencia.confere, true); assert.equal(c.faltam.length, 0);
  void r0;
});

test("percentual sobre o faturamento bruto e árvore: cada nível é a soma exata do nível abaixo", async () => {
  const dr = await dreReferencia(ctx, { mes: "2026-09" }, deps());
  const bruto = dr.indicadores.faturamentoBruto;
  const custos = dr.arvore.find((n) => n.id === "custos");
  assert.equal(custos.centavos, dr.indicadores.custosTotais);
  assert.equal(custos.pctBrutoBps, Math.round(custos.centavos * 10000 / bruto));
  assert.equal(custos.filhos.reduce((s, f) => s + f.centavos, 0), custos.centavos, "CMV + Entregas = Custos");
  for (const g of dr.arvore.filter((n) => n.filhos?.length)) assert.equal(g.conferencia?.confere ?? true, true, g.id);
  const ent = custos.filhos.find((f) => f.id === "entregas");
  assert.equal(ent.filhos.reduce((s, f) => s + f.centavos, 0), ent.centavos);
  assert.ok(ent.filhos[0].lancamentos.length >= 1, "acesso aos lançamentos de origem");
  assert.ok(ent.filhos[0].lancamentos.every((l) => l.centavos != null && l.tipo));
});

test("sem contas a pagar: indicadores gerenciais saem SEM valor e sem componentes (nunca zero como se fosse dado)", async () => {
  const d = deps(); d.repo.listarObrigacoes = async () => []; d.repo.listarPagamentos = async () => [];
  const p = await painel(ctx, { mes: "2026-09" }, d);
  for (const id of ["custos", "cmv", "resultadoGerencial", "faturamentoLiquido"]) { assert.equal(p.composicao[id].valorCentavos, null, id); assert.equal(p.composicao[id].situacao, SITUACAO.PARCIAL); assert.ok(p.composicao[id].faltam.length); }
});

test("conferir/piorSituacao: divergência é detectada e a pior situação domina", () => {
  assert.equal(conferir(100, [{ centavos: 60 }, { centavos: 39 }]).confere, false);
  assert.equal(conferir(100, [{ centavos: 60 }, { centavos: 40 }]).confere, true);
  assert.equal(conferir(100, [{ centavos: 60 }, { centavos: null }]).confere, null, "parte sem dado: não afirma que confere");
  assert.equal(piorSituacao([SITUACAO.CONFIRMADO, SITUACAO.PENDENTE]), SITUACAO.PENDENTE);
  assert.equal(piorSituacao([SITUACAO.CONFIRMADO, SITUACAO.SEM_DADOS, SITUACAO.PARCIAL]), SITUACAO.SEM_DADOS);
});
