// Validação do Dashboard com os números OFICIAIS de setembro/2026 (apresentação da contadora): um único Faturamento bruto gerencial, composição por canal,
// ajuste iFood estimado e pendente, e a Central de Conferências mostrando o ajuste. Dados do teste = os valores publicados; nada aqui toca produção.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as vendas from "../../src/modules/gestao-financeira/dominio/vendasCanal.service.js";
import { painel } from "../../src/modules/gestao-financeira/dominio/painel.service.js";
import { listar as central } from "../../src/modules/gestao-financeira/dominio/conferencias.service.js";

const ctx = { organizacaoId: "00000000-0000-4000-8000-000000000001", unidadeId: "00000000-0000-4000-8000-000000000002", usuarioId: "00000000-0000-4000-8000-000000000003" };
const PLANO = [{ id: "c-rec", nome: "RECEBIMENTO", papel: "receita_operacional", tipo: "X", ativo: true }, { id: "c-ins", nome: "INSUMOS - FRUTAS", papel: "custo_variavel", tipo: "X", ativo: true }];
const SETEMBRO = { mes: "2026-09", fonte: "Apresentação oficial da contabilidade 09/2026 · SAIPOS", canais: [
  { canal: "Balcão", origemTecnica: "Açaí no Grau", vendasQtd: 1650, valorPainel: "50409.53", valorGerencial: "50409.53" },
  { canal: "iFood", origemTecnica: "integration-ifood", vendasQtd: 801, valorPainel: "31540.18", valorGerencial: "30752.03" },
  { canal: "Anota Aí", origemTecnica: "integration-api-int-sale", vendasQtd: 57, valorPainel: "2776.31", valorGerencial: "2021.82" }],
  ajustes: [{ canal: "iFood", tipo: "estimativa", valor: "-788.15", descricao: "Taxa de entrega e descontos do iFood (estimado)" },
    { canal: "Anota Aí", tipo: "taxa_entrega", valor: "-549.00", descricao: "Taxas de entrega do Anota Aí" }, { canal: "Anota Aí", tipo: "desconto", valor: "-205.49", descricao: "Descontos do Anota Aí" }] };

function ambiente() {
  const canais = [], ajustes = []; let n = 0; const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const repo = {
    listarReferencias: async () => [{ tipo: "venda", data: "2026-09-05", valor_centavos: 8318338 }],   // vendas diárias: o bruto oficial do mês
    listarVendasCanal: async (_c, { competencia } = {}) => canais.filter((r) => r.status === "ativa" && (!competencia || r.competencia === competencia)),
    listarVendasAjustes: async (_c, { competencia } = {}) => ajustes.filter((r) => r.status === "ativa" && (!competencia || r.competencia === competencia)),
    inserirVendaCanal: async (_c, l) => { const r = { id: id(), status: "ativa", ...l }; canais.push(r); return r; },
    inserirVendaAjuste: async (_c, l) => { const r = { id: id(), status: "ativa", ...l }; ajustes.push(r); return r; },
    atualizarVendaCanal: async (_c, i, campos) => Object.assign(canais.find((x) => x.id === i), campos),
    atualizarVendaAjuste: async (_c, i, campos) => Object.assign(ajustes.find((x) => x.id === i), campos),
    listarPlanoContas: async () => PLANO, listarContas: async () => [{ id: "k1", nome: "BANCO", ativo: true }], listarAberturas: async () => [], listarTodosLancamentos: async () => [], listarObrigacoes: async () => [], listarPagamentos: async () => [],
    listarFornecedores: async () => [], listarVinculosSaidas: async () => [], bloqueiosFechamentoRpc: async () => [], listarRateios: async () => [], listarParcelasRateio: async () => [], listarReferenciasOficiais: async () => [], listarAuditoria: async () => [],
  };
  return { repo, db: undefined, hoje: () => "2026-11-09", agora: () => "2026-11-09T12:00:00Z", ajustes };
}

test("setembro/2026: o faturamento principal é R$ 83.183,38 e a composição por canal bate com a apresentação", async () => {
  const d = ambiente();
  await vendas.importar(ctx, SETEMBRO, d);
  for (const a of d.ajustes.filter((x) => x.canal === "Anota Aí")) await vendas.confirmarAjuste(ctx, a.id, { evidencia: "Apresentação oficial da contabilidade 09/2026, slide 3" }, d);   // o do iFood segue ESTIMADO
  const p = await painel(ctx, { mes: "2026-09" }, d);
  const c = p.composicao.faturamentoBruto;
  assert.equal(c.valorCentavos, 8318338, "R$ 83.183,38"); assert.equal(c.rotulo, "Faturamento bruto");
  const por = Object.fromEntries(c.componentes.map((x) => [x.rotulo, x]));
  assert.equal(por["Balcão"].centavos, 5040953); assert.equal(por["Anota Aí"].centavos, 202182); assert.equal(por["iFood"].centavos, 3075203);
  assert.deepEqual([por["Balcão"], por["Anota Aí"], por["iFood"]].map((x) => (x.pctBrutoBps / 100).toFixed(2)), ["60.60", "2.43", "36.97"]);
  assert.equal(Object.values(por).reduce((s, x) => s + x.pctBrutoBps, 0) >= 9999 && Object.values(por).reduce((s, x) => s + x.pctBrutoBps, 0) <= 10001, true, "os percentuais somam 100%");
  assert.equal(Object.values(por).reduce((s, x) => s + x.centavos, 0), c.valorCentavos);
  assert.equal(c.conferencia.confere, true); assert.equal(c.canalConferencia.confere, true); assert.equal(c.canalConferencia.diferencaCentavos, 0);
  assert.match(c.formula, /base gerencial por canal = total do painel \(SAIPOS\) \+ ajustes; coincide com as vendas diárias do mês/);
  assert.match(c.origem, /Vendas diárias \(total oficial\)/);
});

test("o ajuste estimado do iFood (R$ 788,15) continua PENDENTE, nunca confirmado, e o total do painel (R$ 84.726,02) só existe na composição", async () => {
  const d = ambiente();
  await vendas.importar(ctx, SETEMBRO, d);
  const ifood = d.ajustes.find((x) => x.canal === "iFood");
  for (const a of d.ajustes.filter((x) => x.canal === "Anota Aí")) await vendas.confirmarAjuste(ctx, a.id, { evidencia: "Apresentação oficial da contabilidade 09/2026, slide 3" }, d);
  assert.equal(ifood.estado, "estimado"); assert.equal(ifood.valor_centavos, -78815); assert.ok(!ifood.confirmado_por && !ifood.confirmado_em, "importar não confirma nada");
  const p = await painel(ctx, { mes: "2026-09" }, d);
  const c = p.composicao.faturamentoBruto;
  assert.equal(c.componentes.find((x) => x.rotulo === "iFood").situacao, "pendente_contadora");
  assert.equal(c.pendencias.length, 1); assert.match(c.pendencias[0], /788,15/); assert.match(c.pendencias[0], /iFood/); assert.match(c.pendencias[0], /estimado/);
  assert.equal(c.visoes.painel.totalCentavos, 8472602, "R$ 84.726,02 existe apenas como 'Total do painel (SAIPOS)' dentro da composição completa");
  assert.equal(p.indicadores.faturamentoBruto.valorCentavos ?? p.indicadores.faturamentoBruto, 8318338, "o indicador usado pelo painel e pela DRE é o gerencial");
});

test("Central de Conferências mostra o ajuste iFood como ESTIMADO, com responsável e evidência necessária, e não existe aprovação automática", async () => {
  const d = ambiente();
  await vendas.importar(ctx, SETEMBRO, d);
  for (const a of d.ajustes.filter((x) => x.canal === "Anota Aí")) await vendas.confirmarAjuste(ctx, a.id, { evidencia: "Apresentação oficial da contabilidade 09/2026, slide 3" }, d);
  const c = await central(ctx, { mes: "2026-09" }, d);
  const aj = c.pendencias.find((x) => x.tipo === "ajuste_vendas" && x.canal === "iFood");
  assert.ok(aj, "o ajuste estimado do iFood aparece na Central"); assert.equal(aj.valorCentavos, -78815); assert.equal(aj.status, "estimado"); assert.match(aj.responsavel, /Portal do Parceiro/);
  assert.match(aj.evidenciaNecessaria, /taxa de entrega e descontos/); assert.equal(aj.acao.permissao, "classificar");
  assert.equal(c.pendencias.filter((x) => x.tipo === "ajuste_vendas" && x.canal === "iFood").length, 1, "sem duplicar");
  assert.equal(c.pendencias.every((x) => x.status !== "confirmado"), true);
  const c2 = await central(ctx, { mes: "2026-09" }, d);
  assert.deepEqual(c2.pendencias.map((x) => x.id), c.pendencias.map((x) => x.id), "listar não altera nada");
  assert.ok(!d.ajustes.find((x) => x.canal === "iFood").confirmado_por, "continua sem confirmação após as consultas");
});
