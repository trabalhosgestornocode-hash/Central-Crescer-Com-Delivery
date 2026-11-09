// Central de conferências: pendências reais num lugar só, comparação com a apresentação oficial e explicação de diferenças. Dados SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { listar, explicarDiferenca } from "../../src/modules/gestao-financeira/dominio/conferencias.service.js";

const ctx = { organizacaoId: "00000000-0000-4000-8000-000000000001", unidadeId: "00000000-0000-4000-8000-000000000002", usuarioId: "00000000-0000-4000-8000-000000000003" };
const cat = (id, nome, papel) => ({ id, nome, papel, tipo: "X", ativo: true });
const PLANO = [cat("c-rec", "RECEBIMENTO", "receita_operacional"), cat("c-ins", "INSUMOS - FRUTAS", "custo_variavel"), cat("c-ben", "BENEFICIOS", "despesa_pessoal"), cat("c-sal", "SALARIO", "despesa_pessoal")];
const obr = (id, c, desc, comp, venc, valor, status = "aberta") => ({ id, fornecedor_id: "f1", categoria_id: c, descricao: desc, competencia: comp, vencimento: venc, valor_original_centavos: valor, status });
// bruto 100.000,00; insumos 30.000,00 (competência set); salário 20.000,00 pago; "benefícios" 80,00 vencida em set SEM pagamento
const OBR = [obr("o1", "c-ins", "frutas", "2026-09-01", "2026-09-10", 3000000), obr("o2", "c-sal", "folha", "2026-08-01", "2026-09-05", 2000000), obr("o3", "c-ben", "Saude do trabalhador 08/2026", "2026-08-01", "2026-09-10", 8000)];
const PAG = [{ id: "p2", obrigacao_id: "o2", conta_id: "k1", data_pagamento: "2026-09-05", valor_centavos: 2000000, status: "ativo" }];
const base = (extra = {}) => ({
  listarPlanoContas: async () => PLANO, listarContas: async () => [{ id: "k1", nome: "BANCO", ativo: true }], listarAberturas: async () => [], listarTodosLancamentos: async () => [],
  listarReferencias: async () => [{ tipo: "venda", data: "2026-09-05", valor_centavos: 10000000 }], listarObrigacoes: async () => OBR, listarPagamentos: async () => PAG, listarFornecedores: async () => [{ id: "f1", nome: "F" }],
  listarVinculosSaidas: async () => [], bloqueiosFechamentoRpc: async () => [], listarRateios: async () => [{ id: "r1", obrigacao_id: "o1", status: "proposto", criterio: "producao", justificativa: "produção atravessa o mês", valor_elegivel_centavos: 3000000 }],
  listarParcelasRateio: async () => [{ rateio_id: "r1", competencia: "2026-09-01", valor_centavos: 2000000 }, { rateio_id: "r1", competencia: "2026-10-01", valor_centavos: 1000000 }],
  listarVendasCanal: async () => [{ id: "v1", canal: "iFood", origem_tecnica: "integration-ifood", vendas_qtd: 5, valor_painel_centavos: 10100000, valor_gerencial_centavos: 10000000, granularidade: "mensal", fonte: "t", competencia: "2026-09-01" }],
  listarVendasAjustes: async () => [{ id: "a1", canal: "iFood", tipo: "estimativa", valor_centavos: -100000, descricao: "ajuste estimado", estado: "estimado", competencia: "2026-09-01" }],
  listarReferenciasOficiais: async () => [
    { indicador: "faturamentoBruto", rotulo: "Faturamento bruto", valorCentavos: 10000000, fonte: "apresentação" },
    { indicador: "despesas", rotulo: "Despesas", valorCentavos: 2008000, fonte: "apresentação" },
    { indicador: "resultadoGerencial", rotulo: "Lucro", valorCentavos: 5992000, fonte: "apresentação" },
    { indicador: "custos", rotulo: "Custos", valorCentavos: 2500000, fonte: "apresentação" }],
  listarAuditoria: async () => [{ id: "x", entidade: "fin_vendas_ajustes", entidade_id: "a1", acao: "update", created_at: "2026-11-07T10:00:00Z", ator_id: "u" }, { id: "y", entidade: "fin_contas", entidade_id: "k", acao: "insert", created_at: "2026-11-07T10:00:00Z", ator_id: "u" }],
  ...extra,
});
const deps = (extra) => ({ repo: base(extra), db: undefined, hoje: () => "2026-11-06", env: {} });

test("explicarDiferenca: só explica quando bate exatamente com um item (ou soma de dois); senão diz que não há explicação", () => {
  const cand = [{ descricao: "A", valorCentavos: 8000, motivo: "m" }, { descricao: "B", valorCentavos: 500, motivo: "m" }];
  assert.match(explicarDiferenca(-8000, cand).texto, /^A /);
  assert.equal(explicarDiferenca(8500, cand).tipo, "soma");
  assert.equal(explicarDiferenca(1234, cand), null, "sem coincidência exata, não inventa causa");
  assert.equal(explicarDiferenca(0, cand), null);
});

test("central: reúne ajuste estimado, rateio proposto e conta vencida sem pagamento; a regra geral vem UMA vez, à parte", async () => {
  const c = await listar(ctx, { mes: "2026-09" }, deps());
  assert.equal(c.geral.length, 1); assert.equal(c.geral[0].id, "metodologia");
  const tipos = c.pendencias.map((p) => p.tipo);
  assert.ok(tipos.includes("ajuste_vendas") && tipos.includes("rateios") && tipos.includes("conta_sem_pagamento"), tipos.join(","));
  assert.equal(c.total, c.pendencias.length, "o contador não inclui o aviso geral");
  const aj = c.pendencias.find((p) => p.tipo === "ajuste_vendas");
  assert.equal(aj.acao.caminho, "/vendas-ajustes/a1/confirmar"); assert.deepEqual(aj.acao.exige, ["evidencia"]); assert.equal(aj.acao.permissao, "classificar");
  const rat = c.pendencias.find((p) => p.tipo === "rateios");
  assert.equal(rat.itens[0].caminhoAprovar, "/rateios/r1/aprovar"); assert.equal(rat.acao.permissao, "classificar"); assert.equal(rat.acao.metodo, "TELA");
  const venc = c.pendencias.find((p) => p.tipo === "conta_sem_pagamento" && p.valorCentavos === 8000);
  assert.equal(venc.valorCentavos, 8000); assert.match(venc.descricao, /não presume a origem bancária/);
  assert.equal(venc.acao.metodo, "IR", "registrar pagamento leva à tela de Contas a Pagar; nada é gravado aqui");
});

test("central: nada vira confirmado por listar — a lista só lê (ajuste continua estimado; sem escrita)", async () => {
  let escreveu = false;
  const d = deps({ inserirVendaAjuste: async () => { escreveu = true; }, atualizarVendaAjuste: async () => { escreveu = true; }, aprovarRateioRpc: async () => { escreveu = true; } });
  await listar(ctx, { mes: "2026-09" }, d);
  assert.equal(escreveu, false);
});

test("comparação com a apresentação: confere o que bate, explica a diferença de despesas/lucro e o efeito derivado no ponto de equilíbrio", async () => {
  const c = await listar(ctx, { mes: "2026-09" }, deps());
  const x = (i) => c.comparacao.find((r) => r.indicador === i);
  assert.equal(x("faturamentoBruto").confere, true);
  assert.equal(x("despesas").diferencaCentavos, 2000000 - 2008000, "sistema − apresentação");
  assert.match(x("despesas").explicacao, /Saude do trabalhador 08\/2026/);
  assert.match(x("resultadoGerencial").explicacao, /Saude do trabalhador 08\/2026/);
  assert.equal(c.resumoComparacao.total, 4); assert.equal(c.resumoComparacao.divergentes, 3);
  assert.equal(x("custos").sistemaCentavos, 2000000, "custos do sistema = parcela de setembro do rateio (20.000,00), não os 30.000,00 da conta");
  assert.equal(x("custos").confere, false); assert.match(x("custos").explicacao, /Sem explicação automática/, "diferença sem causa conhecida é dita assim");
});

test("central sem referências oficiais: comparação vazia (não inventa)", async () => {
  const c = await listar(ctx, { mes: "2026-09" }, deps({ listarReferenciasOficiais: async () => [] }));
  assert.deepEqual(c.comparacao, []); assert.equal(c.resumoComparacao.total, 0);
});

// ---- Controle de pendências: toda pendência mostra motivo, evidência necessária, responsável e status; nada vira confirmado; sem duplicar ----
test("pendências: cada uma traz motivo, evidência necessária, responsável e status; o ajuste iFood fica ESTIMADO e sem confirmação", async () => {
  const c = await listar(ctx, { mes: "2026-09" }, deps());
  assert.ok(c.pendencias.length >= 3);
  for (const p of c.pendencias) {
    assert.ok(p.motivo, `${p.tipo}: motivo`); assert.ok(p.evidenciaNecessaria, `${p.tipo}: evidência necessária`); assert.ok(p.responsavel, `${p.tipo}: responsável`);
    assert.ok(["pendente", "estimado", "aguardando_comprovacao"].includes(p.status), `${p.tipo}: status ${p.status}`);
    assert.notEqual(p.status, "confirmado");
  }
  const aj = c.pendencias.find((p) => p.tipo === "ajuste_vendas");
  assert.equal(aj.status, "estimado"); assert.equal(aj.valorCentavos, -100000); assert.match(aj.responsavel, /Portal do Parceiro/);
  assert.equal(c.pendencias.find((p) => p.tipo === "conta_sem_pagamento").status, "aguardando_comprovacao");
});

test("pendências: pagamento feito por terceiro e lançamento com classificação pendente entram na central, sem duplicar e sem reclassificar", async () => {
  const lanc = { id: "l1", conta_id: "k1", categoria_id: "c-rec", sentido: "entrada", valor_centavos: 253600, data_movimento: "2026-09-21", status: "realizado", classificacao_pendente: true, descricao: "Pix recebido", nota_revisao: "1.234,00 a identificar" };
  const pagT = { id: "p9", obrigacao_id: "o1", conta_id: null, data_pagamento: "2026-09-12", valor_centavos: 663360, status: "ativo", origem_pagamento: "terceiro", terceiro_nome: "Sócia", observacao: "pago pela sócia" };
  const d = deps({ listarPagamentos: async () => [...PAG, pagT], listarTodosLancamentos: async () => [lanc, { ...lanc, id: "l2", classificacao_pendente: false }, { ...lanc, id: "l3", status: "cancelado" }] });
  const c = await listar(ctx, { mes: "2026-09" }, d);
  const t = c.pendencias.filter((p) => p.tipo === "pagamento_terceiro");
  assert.equal(t.length, 1); assert.equal(t[0].valorCentavos, 663360); assert.equal(t[0].status, "aguardando_comprovacao"); assert.equal(t[0].acao, null, "sem ação de confirmar automática");
  const k = c.pendencias.filter((p) => p.tipo === "classificacao_pendente");
  assert.equal(k.length, 1, "uma pendência agrupada, não uma por lançamento"); assert.equal(k[0].itens.length, 1); assert.equal(k[0].itens[0].id, "l1"); assert.equal(k[0].valorCentavos, 253600); assert.equal(k[0].acao, null);
  const ids = c.pendencias.map((p) => p.id); assert.equal(new Set(ids).size, ids.length, "ids únicos: nenhuma pendência duplicada");
  const c2 = await listar(ctx, { mes: "2026-09" }, d);
  assert.deepEqual(c2.pendencias.map((p) => p.id), ids, "listar duas vezes não cria nem some pendência (somente leitura)");
});
