// Faturamento bruto por canal (nome amigável, origem técnica, conferência com o bruto oficial) e redesign do DRE (resumo, pendências específicas).
// Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { painel, dreReferencia } from "../../src/modules/gestao-financeira/dominio/painel.service.js";
import { comporPorCanal, CANAIS_CONHECIDOS } from "../../src/financeiro-calculos/canaisVenda.js";

const ORG = "00000000-0000-4000-8000-000000000001";
const ctx = { organizacaoId: ORG, unidadeId: "00000000-0000-4000-8000-000000000002", usuarioId: "00000000-0000-4000-8000-000000000003" };
const cat = (id, nome, papel) => ({ id, nome, papel, tipo: "X", ativo: true });
const PLANO = [cat("c-rec", "RECEBIMENTO", "receita_operacional"), cat("c-ins", "INSUMOS - FRUTAS", "custo_variavel"), cat("c-fre", "FRETE", "custo_variavel"), cat("c-sim", "SIMPLES NACIONAL", "tributo"), cat("c-sal", "SALARIO", "despesa_pessoal")];
const obr = (id, c, desc, comp, venc, valor) => ({ id, fornecedor_id: "f1", categoria_id: c, descricao: desc, competencia: comp, vencimento: venc, valor_original_centavos: valor, status: "aberta" });
const OBR = [obr("o1", "c-fre", "Entregas semana 1", "2026-09-01", "2026-09-10", 100000), obr("o2", "c-fre", "Entregas rateada", "2026-09-01", "2026-09-20", 60000), obr("o3", "c-ins", "frutas", "2026-09-01", "2026-09-10", 300000), obr("o4", "c-sim", "simples", "2026-08-01", "2026-09-20", 50000), obr("o5", "c-sal", "salário", "2026-08-01", "2026-09-05", 200000)];
const PAG = [{ id: "p1", obrigacao_id: "o1", conta_id: "k1", data_pagamento: "2026-09-10", valor_centavos: 100000, status: "ativo" }, { id: "p4", obrigacao_id: "o4", conta_id: "k1", data_pagamento: "2026-09-20", valor_centavos: 50000, status: "ativo" }, { id: "p5", obrigacao_id: "o5", conta_id: "k1", data_pagamento: "2026-09-05", valor_centavos: 200000, status: "ativo" }];
// bruto oficial 6.000,00; canais do relatório somam 6.100,00 (diferença de 100,00 a MAIS)
const CANAIS = [{ origem: "integration-ifood", centavos: 250000 }, { origem: "Açaí no Grau", centavos: 330000 }, { origem: "integration-api-int-sale", centavos: 30000 }];
const repo = (canais) => ({
  listarPlanoContas: async () => PLANO, listarContas: async () => [{ id: "k1", nome: "BANCO", ativo: true }], listarAberturas: async () => [{ conta_id: "k1", data_referencia: "2026-09-01", valor_centavos: 0 }],
  listarTodosLancamentos: async () => [{ id: "e1", conta_id: "k1", categoria_id: "c-rec", sentido: "entrada", valor_centavos: 500000, data_movimento: "2026-09-05", status: "realizado" }],
  listarReferencias: async () => [{ tipo: "venda", data: "2026-09-05", valor_centavos: 600000 }],
  listarObrigacoes: async () => OBR, listarPagamentos: async () => PAG, listarFornecedores: async () => [{ id: "f1", nome: "Forn" }],
  listarVinculosSaidas: async () => [], bloqueiosFechamentoRpc: async () => [],
  listarRateios: async () => [{ id: "r1", obrigacao_id: "o2", status: "proposto", criterio: "producao" }], listarParcelasRateio: async () => [{ rateio_id: "r1", competencia: "2026-09-01", valor_centavos: 25000 }, { rateio_id: "r1", competencia: "2026-10-01", valor_centavos: 35000 }],
  ...(canais ? { listarVendasPorCanal: async () => canais } : {}),
});
const deps = (canais, env = { FINANCEIRO_ROTULOS_ENTREGADORES_ORGANIZACOES: ORG }) => ({ repo: repo(canais), db: undefined, hoje: () => "2026-11-06", env });
const R = (c) => (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 });

test("canais: nomes amigáveis pelo mapeamento informado, origem técnica preservada, ordem Balcão · Anota Aí · iFood", () => {
  const c = comporPorCanal(CANAIS, 600000);
  assert.deepEqual(c.canais.map((x) => x.canal), ["Balcão", "Anota Aí", "iFood"]);
  assert.deepEqual(c.canais.map((x) => x.origens[0]), ["Açaí no Grau", "integration-api-int-sale", "integration-ifood"]);
  assert.equal(CANAIS_CONHECIDOS.length, 3);
  assert.equal(c.somaCentavos, 610000); assert.equal(c.diferencaCentavos, 10000); assert.equal(c.confere, false);
});

test("canais: soma igual ao bruto confere; origem desconhecida NÃO é adivinhada; sem bruto não há diferença calculada", () => {
  assert.equal(comporPorCanal([{ origem: "integration-ifood", centavos: 100 }, { origem: "Açaí no Grau", centavos: 200 }], 300).confere, true);
  const x = comporPorCanal([{ origem: "marketplace-novo", centavos: 500 }], 500);
  assert.deepEqual(x.naoMapeados, ["marketplace-novo"]); assert.equal(x.canais[0].mapeado, false); assert.equal(x.canais[0].canal, "marketplace-novo");
  assert.equal(comporPorCanal(CANAIS, null).diferencaCentavos, null);
});

test("faturamento bruto: composição por canal, divergência com o valor EXATO da diferença e sem ajustar o bruto oficial", async () => {
  const p = await painel(ctx, { mes: "2026-09" }, deps(CANAIS));
  const c = p.composicao.faturamentoBruto;
  assert.equal(c.valorCentavos, 600000, "o bruto oficial não é alterado para coincidir com os canais");
  assert.deepEqual(c.componentes.map((x) => [x.rotulo, x.centavos]), [["Balcão", 330000], ["Anota Aí", 30000], ["iFood", 250000]]);
  assert.deepEqual(c.componentes.map((x) => x.origemTecnica[0]), ["Açaí no Grau", "integration-api-int-sale", "integration-ifood"], "origem técnica em área secundária");
  assert.equal(c.situacao, "divergente");
  assert.equal(c.canalConferencia.diferencaCentavos, 10000); assert.equal(c.canalConferencia.somaCentavos, 610000);
  assert.ok(c.alertas.some((t) => t.includes(`R$ ${R(10000)}`) && /MAIS/.test(t) && t.includes(`R$ ${R(600000)}`)), c.alertas.join("|"));
  assert.ok(!c.faltam.length, "com relatório por canal não diz mais 'sem canal informado'");
  assert.ok(!c.componentes.some((x) => /sem canal/.test(x.rotulo)));
  assert.ok(c.notas.some((t) => /pedidos individuais|Registros individuais/.test(t)), "diz que o registro por pedido não existe");
});

test("faturamento bruto: canais que fecham com o bruto → confirmado e sem alerta; sem relatório por canal mantém a explicação do que falta", async () => {
  const fecha = [{ origem: "Açaí no Grau", centavos: 400000 }, { origem: "integration-ifood", centavos: 200000 }];
  const c = (await painel(ctx, { mes: "2026-09" }, deps(fecha))).composicao.faturamentoBruto;
  assert.equal(c.situacao, "confirmado"); assert.equal(c.canalConferencia.confere, true); assert.equal(c.alertas.length, 0);
  const sem = (await painel(ctx, { mes: "2026-09" }, deps(null))).composicao.faturamentoBruto;
  assert.ok(sem.faltam.some((t) => /canal/i.test(t))); assert.match(sem.componentes[0].rotulo, /sem canal informado/);
});

test("DRE: a regra geral NÃO é repetida nas linhas; só pendência específica (rateio proposto) marca a categoria", async () => {
  const d = await dreReferencia(ctx, { mes: "2026-09" }, deps(null));
  assert.equal(d.regrasAprovadas, false);
  const folhas = []; const varre = (ns) => ns.forEach((n) => { if (n.filhos?.length) varre(n.filhos); else folhas.push(n); }); varre(d.arvore.filter((n) => n.id !== "bruto"));
  assert.ok(d.arvore.every((n) => n.situacao === "confirmado"), "totais sem selo de regra geral");
  const pend = folhas.filter((n) => n.situacao === "pendente_contadora");
  assert.deepEqual(pend.map((n) => n.rotulo), ["Entregadores Próprios (Motoboys)"], "só a categoria com rateio proposto");
  assert.match(pend[0].nota, /rateio/);
  assert.equal(folhas.find((n) => n.acao === "conciliacao")?.rotulo, "Entregadores Próprios (Motoboys)", "ponte do livro-caixa fica DENTRO da categoria");
});

test("DRE: resumo executivo e árvore usam os mesmos números; gráfico (resumo) fecha em 100% do bruto", async () => {
  const d = await dreReferencia(ctx, { mes: "2026-09" }, deps(null));
  const no = (id) => d.arvore.find((n) => n.id === id);
  assert.equal(d.resumo.custos.centavos, no("custos").centavos); assert.equal(d.resumo.deducoes.centavos, no("deducoes").centavos);
  assert.equal(d.resumo.despesas.centavos, no("variaveis").centavos + no("fixas").centavos);
  assert.equal(d.resumo.resultado.centavos, no("resultado").centavos); assert.equal(d.resumo.liquido.centavos, no("liquido").centavos);
  const R_ = d.resumo;
  assert.equal(R_.deducoes.centavos + R_.custos.centavos + R_.despesas.centavos + R_.resultado.centavos, R_.bruto.centavos, "deduções + custos + despesas + resultado = bruto");
  assert.equal(R_.custos.pctBrutoBps, no("custos").pctBrutoBps);
});

test("DRE: sem a regra de rótulo a categoria segue como FRETE e o resumo é idêntico (nada muda no cálculo)", async () => {
  const a = await dreReferencia(ctx, { mes: "2026-09" }, deps(null)), b = await dreReferencia(ctx, { mes: "2026-09" }, deps(null, {}));
  assert.deepEqual(a.resumo, b.resumo);
  assert.ok(b.grupos.flatMap((g) => g.linhas).some((l) => l.descricao === "FRETE"));
});
