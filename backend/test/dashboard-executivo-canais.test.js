import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ESTRUTURA, ESCOPO_ENTREGADORES, SITUACAO_CANAL,
  estruturaDaUnidade, escopoEntregadoresDaUnidade, estruturaDoDia, canaisParticipantes,
  desempenhoAnteriorPorCanal, snapshotFinanceiroAnteriorPorCanal,
  normalizarCanais, consolidarCanais, corpoConsolidado, resumoConsolidado, linhasCanaisParaGravacao,
  diffCanais, etapaIncompletaMulticanal, composicaoCanaisDoMes, escopoEntregadoresDoDia, valorCanalParaApi,
} from "../src/modules/dashboard-executivo/dashboardExecutivo.canais.js";
import { normalizarDadosLancamento } from "../src/modules/dashboard-executivo/dashboardExecutivo.service.js";

// Lançamento multicanal do Dashboard iFood (migration 108) — funções puras.
// Cenários numerados conforme o plano aprovado (Checkpoint A).

const SANDUICHES = { id: "11111111-1111-4111-8111-111111111111", nome: "Sanduíches", ordem: 0, ativo: true };
const SALADAS = { id: "22222222-2222-4222-8222-222222222222", nome: "Saladas", ordem: 1, ativo: true };
const OUTRA_UNIDADE = "33333333-3333-4333-8333-333333333333";
const PARTICIPANTES = [SANDUICHES, SALADAS];

const CTX = {
  participantes: PARTICIPANTES, situacaoUnidade: "normal", statusAlvo: "finalizado", exigirFinanceiro: true,
  escopoEntregadores: ESCOPO_ENTREGADORES.UNIDADE,
};

const comVendas = (canal, valores) => ({ canalId: canal.id, situacaoCanal: SITUACAO_CANAL.COM_VENDAS, ...valores });
const FIN_SAND = { qtdVendas: 500, valorVendasBruto: 22000, novosClientes: 40, valorVendasIfood: 22914.53, taxasComissoes: 2978.89, servicosPromocoes: 1145.73, ajustesFavorLoja: 10, ajustesContraLoja: 5 };
const FIN_SAL = { qtdVendas: 50, valorVendasBruto: 4000, novosClientes: 8, valorVendasIfood: 3767.76, taxasComissoes: 489.81, servicosPromocoes: 188.39 };

const consolidar = (canais, taxasEntregadoresUnidade = 1200) =>
  consolidarCanais(canais, { escopoEntregadores: ESCOPO_ENTREGADORES.UNIDADE, taxasEntregadoresUnidade });

// ---------------------------------------------------------------------------
// Estrutura (cenários 1, 15, 16, 17)
// ---------------------------------------------------------------------------
test("1/17: unidade sem configuração é padrão (nenhuma unidade vira multicanal por baixo)", () => {
  assert.equal(estruturaDaUnidade(null), ESTRUTURA.PADRAO);
  assert.equal(estruturaDaUnidade(undefined), ESTRUTURA.PADRAO);
  assert.equal(estruturaDaUnidade({ estrutura: "padrao" }), ESTRUTURA.PADRAO);
  assert.equal(estruturaDaUnidade({ estrutura: "qualquer" }), ESTRUTURA.PADRAO);
  assert.equal(estruturaDaUnidade({ estrutura: "multicanal" }), ESTRUTURA.MULTICANAL);
  assert.equal(escopoEntregadoresDaUnidade(null), ESCOPO_ENTREGADORES.UNIDADE);
  assert.equal(escopoEntregadoresDaUnidade({ taxas_entregadores_escopo: "canal" }), ESCOPO_ENTREGADORES.CANAL);
});

test("15: lançamento antigo (sem estrutura gravada) abre como padrão mesmo com a unidade multicanal", () => {
  assert.equal(estruturaDoDia({ lancamento: { id: "x" }, config: { estrutura: "multicanal" } }), ESTRUTURA.PADRAO);
  assert.equal(estruturaDoDia({ lancamento: { estrutura_lancamento: "padrao" }, config: { estrutura: "multicanal" } }), ESTRUTURA.PADRAO);
});

test("16: dia multicanal continua multicanal depois que a unidade volta a padrão", () => {
  assert.equal(estruturaDoDia({ lancamento: { estrutura_lancamento: "multicanal" }, config: { estrutura: "padrao" } }), ESTRUTURA.MULTICANAL);
  assert.equal(estruturaDoDia({ lancamento: { estrutura_lancamento: "multicanal" }, config: null }), ESTRUTURA.MULTICANAL);
  // Dia ainda não lançado segue a configuração atual.
  assert.equal(estruturaDoDia({ lancamento: null, config: { estrutura: "multicanal" } }), ESTRUTURA.MULTICANAL);
  assert.equal(estruturaDoDia({ lancamento: null, config: null }), ESTRUTURA.PADRAO);
});

test("16: canal desativado continua participando no mês em que já tem valor; ordem estável", () => {
  const inativo = { ...SALADAS, ativo: false };
  const extra = { id: "44444444-4444-4444-8444-444444444444", nome: "Açaí", ordem: 1, ativo: true };
  assert.deepEqual(canaisParticipantes([inativo, SANDUICHES]).map((c) => c.nome), ["Sanduíches"]);
  assert.deepEqual(canaisParticipantes([inativo, SANDUICHES], new Set([SALADAS.id])).map((c) => c.nome), ["Sanduíches", "Saladas"]);
  assert.deepEqual(canaisParticipantes([inativo, extra, SANDUICHES], [SALADAS.id]).map((c) => c.nome), ["Sanduíches", "Açaí", "Saladas"]);
});

// ---------------------------------------------------------------------------
// Consolidação (cenários 2, 3, 6, 7, 8, 9, 10, 11)
// ---------------------------------------------------------------------------
test("3/6: ambos com vendas — somáveis somam, sem resíduo de ponto flutuante", () => {
  const canais = normalizarCanais([comVendas(SANDUICHES, FIN_SAND), comVendas(SALADAS, FIN_SAL)], CTX);
  const c = consolidar(canais);
  assert.equal(c.qtdVendas, 550);
  assert.equal(c.valorVendasBruto, 26000);
  assert.equal(c.novosClientes, 48);
  assert.equal(c.valorVendasIfood, 26682.29);
  assert.equal(c.taxasComissoes, 3468.7);
  assert.equal(c.servicosPromocoes, 1334.12);
  assert.equal(c.ajustesFavorLoja, 10);
  assert.equal(c.ajustesContraLoja, 5);
});

test("7/8: taxa de entregadores compartilhada entra UMA vez e nunca nos canais", () => {
  const canais = normalizarCanais([comVendas(SANDUICHES, FIN_SAND), comVendas(SALADAS, FIN_SAL)], CTX);
  assert.ok(canais.every((c) => c.taxasEntregadores === null));
  assert.equal(consolidar(canais, 1200).taxasEntregadores, 1200);
  assert.ok(linhasCanaisParaGravacao(canais).every((l) => l.taxas_entregadores === null));
});

test("8: mandar taxa de entregadores dentro de um canal no escopo 'unidade' é recusado (evita duplicar)", () => {
  assert.throws(
    () => normalizarCanais([comVendas(SANDUICHES, { ...FIN_SAND, taxasEntregadores: 600 }), comVendas(SALADAS, FIN_SAL)], CTX),
    /compartilhadas pela unidade/,
  );
});

test("escopo 'canal': entregadores por canal exigidos ao finalizar e somados", () => {
  const ctx = { ...CTX, escopoEntregadores: ESCOPO_ENTREGADORES.CANAL };
  assert.throws(() => normalizarCanais([comVendas(SANDUICHES, FIN_SAND), comVendas(SALADAS, FIN_SAL)], ctx), /Sanduíches: Taxas de entregadores/);
  const canais = normalizarCanais([
    comVendas(SANDUICHES, { ...FIN_SAND, taxasEntregadores: 1000.1 }), comVendas(SALADAS, { ...FIN_SAL, taxasEntregadores: 200.2 }),
  ], ctx);
  assert.equal(consolidarCanais(canais, { escopoEntregadores: ESCOPO_ENTREGADORES.CANAL, taxasEntregadoresUnidade: 999 }).taxasEntregadores, 1200.3);
});

test("9: ticket médio consolidado = Σ bruto ÷ Σ pedidos (nunca média dos tickets)", () => {
  const canais = normalizarCanais([comVendas(SANDUICHES, FIN_SAND), comVendas(SALADAS, FIN_SAL)], CTX);
  const r = resumoConsolidado(consolidar(canais));
  assert.equal(r.ticketMedio, 26000 / 550);
  assert.notEqual(r.ticketMedio, (22000 / 500 + 4000 / 50) / 2);
});

test("10/11: percentuais e receita líquida recalculados sobre o consolidado", () => {
  const canais = normalizarCanais([comVendas(SANDUICHES, FIN_SAND), comVendas(SALADAS, FIN_SAL)], CTX);
  const c = consolidar(canais, 1200);
  const r = resumoConsolidado(c);
  const base = 26682.29;
  const totalDed = 3468.7 + 1334.12 + 1200 + 5;
  assert.ok(Math.abs(r.totalDeducoes - totalDed) < 1e-9);
  assert.ok(Math.abs(r.percentuais.taxasComissoes - (3468.7 / base) * 100) < 1e-9);
  assert.ok(Math.abs(r.percentuais.servicosPromocoes - (1334.12 / base) * 100) < 1e-9);
  assert.ok(Math.abs(r.percentuais.taxasEntregadores - (1200 / base) * 100) < 1e-9);
  assert.ok(Math.abs(r.percentuais.totalDeducoes - (totalDed / base) * 100) < 1e-9);
  assert.ok(Math.abs(r.receitaLiquida - (base - totalDed + 10)) < 1e-9);
  // Nunca a média simples dos percentuais de cada canal.
  const mediaSimples = ((2978.89 / 22914.53) + (489.81 / 3767.76)) / 2 * 100;
  assert.ok(Math.abs(r.percentuais.taxasComissoes - mediaSimples) > 1e-6);
});

test("ajustes: canal sem ajuste (vazio) não anula a soma do outro; nenhum ajuste = null", () => {
  const canais = normalizarCanais([comVendas(SANDUICHES, FIN_SAND), comVendas(SALADAS, FIN_SAL)], CTX);
  assert.equal(canais[1].ajustesFavorLoja, null);
  assert.equal(consolidar(canais).ajustesFavorLoja, 10);
  const semAjuste = normalizarCanais([comVendas(SANDUICHES, FIN_SAL), comVendas(SALADAS, FIN_SAL)], CTX);
  assert.equal(consolidar(semAjuste).ajustesFavorLoja, null);
});

// ---------------------------------------------------------------------------
// Sem vendas / não informado (cenários 4, 5)
// ---------------------------------------------------------------------------
const ANTERIOR = new Map([
  [SANDUICHES.id, { conhecido: true, qtdVendas: 480, valorVendasBruto: 21000, novosClientes: 38 }],
  [SALADAS.id, { conhecido: true, qtdVendas: 50, valorVendasBruto: 4000, novosClientes: 8 }],
]);

test("4: Saladas sem vendas repete o acumulado do canal (delta 0), nunca grava 0 no acumulado", () => {
  const canais = normalizarCanais([
    comVendas(SANDUICHES, FIN_SAND),
    { canalId: SALADAS.id, situacaoCanal: "sem_vendas", qtdVendas: 0, valorVendasBruto: 0, valorVendasIfood: 3767.76, taxasComissoes: 489.81, servicosPromocoes: 188.39 },
  ], { ...CTX, desempenhoAnterior: ANTERIOR });
  const sal = canais[1];
  assert.equal(sal.situacaoCanal, "sem_vendas");
  assert.equal(sal.qtdVendas, 50);
  assert.equal(sal.valorVendasBruto, 4000);
  assert.equal(sal.novosClientes, 8);
  assert.equal(consolidar(canais).qtdVendas, 550);
});

test("4 (decisão 2): canal sem vendas em dia D-1 continua exigindo o acumulado financeiro do extrato", () => {
  assert.throws(() => normalizarCanais([
    comVendas(SANDUICHES, FIN_SAND), { canalId: SALADAS.id, situacaoCanal: "sem_vendas" },
  ], { ...CTX, desempenhoAnterior: ANTERIOR }), /Saladas: Valor das vendas \(iFood\)/);
});

test("5 (decisão 3): canal não informado bloqueia FINALIZAR em dia com Financeiro elegível", () => {
  assert.throws(() => normalizarCanais([
    comVendas(SANDUICHES, FIN_SAND), { canalId: SALADAS.id, situacaoCanal: "nao_informado" },
  ], CTX), (e) => e.statusCode === 400 && e.details?.canalNaoInformado === true && /"Saladas" está como "Não informado"/.test(e.message));
});

test("5/12: canal não informado é aceito em RASCUNHO e o consolidado fica não informado (nunca soma parcial)", () => {
  const canais = normalizarCanais([
    comVendas(SANDUICHES, FIN_SAND), { canalId: SALADAS.id, situacaoCanal: "nao_informado", qtdVendas: 99 },
  ], { ...CTX, statusAlvo: "rascunho" });
  assert.equal(canais[1].qtdVendas, null);
  assert.equal(canais[1].valorVendasIfood, null);
  const c = consolidar(canais);
  assert.equal(c.qtdVendas, null);
  assert.equal(c.valorVendasIfood, null);
  assert.equal(c.ajustesFavorLoja, null);
  assert.equal(resumoConsolidado(c).ticketMedio, null);
  assert.equal(resumoConsolidado(c).receitaLiquida, null);
});

test("dia sem Financeiro elegível: canal não informado pode finalizar (Desempenho é opcional)", () => {
  const canais = normalizarCanais([
    comVendas(SANDUICHES, { qtdVendas: 500, valorVendasBruto: 22000 }), { canalId: SALADAS.id, situacaoCanal: "nao_informado" },
  ], { ...CTX, exigirFinanceiro: false });
  assert.equal(consolidar(canais, null).qtdVendas, null);
  assert.equal(consolidar(canais, null).valorVendasIfood, null);
});

test("R$ 0,00 informado é diferente de não informado", () => {
  const zero = { qtdVendas: 0, valorVendasBruto: 0, novosClientes: 0, valorVendasIfood: 0, taxasComissoes: 0, servicosPromocoes: 0 };
  const canais = normalizarCanais([comVendas(SANDUICHES, FIN_SAND), comVendas(SALADAS, zero)], CTX);
  assert.equal(canais[1].valorVendasIfood, 0);
  assert.equal(consolidar(canais).valorVendasIfood, 22914.53);
  assert.equal(consolidar(canais).qtdVendas, 500);
});

test("unidade 'Sem operação'/'Zero vendas': sem pergunta por canal — todos sem_vendas, acumulado repetido, financeiro 0 sintético", () => {
  for (const situacaoUnidade of ["sem_operacao", "zero_vendas"]) {
    const canais = normalizarCanais(undefined, { ...CTX, situacaoUnidade, desempenhoAnterior: ANTERIOR });
    assert.deepEqual(canais.map((c) => c.situacaoCanal), ["sem_vendas", "sem_vendas"]);
    assert.equal(canais[0].qtdVendas, 480);
    assert.equal(canais[1].valorVendasBruto, 4000);
    assert.equal(canais[0].valorVendasIfood, 0);
    assert.equal(canais[0].taxasEntregadores, null);
  }
});

test("unidade 'Sem operação': valores mandados no corpo são ignorados", () => {
  const canais = normalizarCanais(
    [{ canalId: SANDUICHES.id, situacaoCanal: "com_vendas", qtdVendas: 999 }],
    { ...CTX, situacaoUnidade: "sem_operacao", desempenhoAnterior: ANTERIOR },
  );
  assert.equal(canais[0].qtdVendas, 480);
  assert.equal(canais.length, 2);
});

// ---------------------------------------------------------------------------
// Entrada inválida / isolamento (cenários 21, 22)
// ---------------------------------------------------------------------------
test("21/22: canal de outra unidade (fora dos participantes) é recusado", () => {
  assert.throws(() => normalizarCanais([
    comVendas(SANDUICHES, FIN_SAND), comVendas(SALADAS, FIN_SAL), { canalId: OUTRA_UNIDADE, situacaoCanal: "com_vendas" },
  ], CTX), /não pertence a esta unidade/);
});

test("todo canal participante precisa vir exatamente uma vez", () => {
  assert.throws(() => normalizarCanais([comVendas(SANDUICHES, FIN_SAND)], CTX), /Informe a situação do canal "Saladas"/);
  assert.throws(() => normalizarCanais([comVendas(SANDUICHES, FIN_SAND), comVendas(SANDUICHES, FIN_SAND)], CTX), /mais de uma vez/);
  assert.throws(() => normalizarCanais(null, CTX), /Informe os valores de cada canal/);
  assert.throws(() => normalizarCanais([comVendas(SANDUICHES, FIN_SAND)], { ...CTX, participantes: [] }), /não tem canais configurados/);
  assert.throws(() => normalizarCanais([{ canalId: "nao-e-uuid" }], CTX), /Canal inválido/);
  assert.throws(() => normalizarCanais([
    comVendas(SANDUICHES, FIN_SAND), { canalId: SALADAS.id, situacaoCanal: "talvez" },
  ], CTX), /Situação do canal "Saladas" inválido/);
  assert.throws(() => normalizarCanais([
    comVendas(SANDUICHES, { ...FIN_SAND, valorVendasIfood: -1 }), comVendas(SALADAS, FIN_SAL),
  ], CTX), /Sanduíches: Valor das vendas/);
});

test("quantidades são inteiras", () => {
  const canais = normalizarCanais([comVendas(SANDUICHES, { ...FIN_SAND, qtdVendas: 500.9 }), comVendas(SALADAS, FIN_SAL)], CTX);
  assert.equal(canais[0].qtdVendas, 500);
});

// ---------------------------------------------------------------------------
// Acumulado anterior por canal (troca de estrutura no meio do mês)
// ---------------------------------------------------------------------------
const pai = (id, data, extra = {}) => ({ id, data_lancamento: data, situacao: "normal", origem_lancamento: "diario", estrutura_lancamento: "multicanal", ...extra });
const filho = (lancamentoId, canalId, extra = {}) => ({ lancamento_id: lancamentoId, canal_id: canalId, ...extra });

test("acumulado anterior do canal: último valor do próprio canal no mês", () => {
  const m = desempenhoAnteriorPorCanal({
    linhasDoMes: [pai("a", "2026-10-01"), pai("b", "2026-10-02")],
    linhasCanaisDoMes: [
      filho("a", SANDUICHES.id, { qtd_vendas: 10, valor_vendas_bruto: 400, novos_clientes: 1 }),
      filho("b", SANDUICHES.id, { qtd_vendas: 25, valor_vendas_bruto: 1000, novos_clientes: 3 }),
      filho("a", SALADAS.id, { qtd_vendas: 2, valor_vendas_bruto: 80, novos_clientes: 0 }),
    ],
    antesDeDataIso: "2026-10-03", canalIds: [SANDUICHES.id, SALADAS.id],
  });
  assert.deepEqual(m.get(SANDUICHES.id), { conhecido: true, qtdVendas: 25, valorVendasBruto: 1000, novosClientes: 3 });
  assert.deepEqual(m.get(SALADAS.id), { conhecido: true, qtdVendas: 2, valorVendasBruto: 80, novosClientes: 0 });
});

test("canal começando o mês (sem dia padrão antes) parte de zero", () => {
  const m = desempenhoAnteriorPorCanal({ linhasDoMes: [], linhasCanaisDoMes: [], antesDeDataIso: "2026-10-01", canalIds: [SALADAS.id] });
  assert.deepEqual(m.get(SALADAS.id), { conhecido: true, qtdVendas: 0, valorVendasBruto: 0, novosClientes: 0 });
});

test("16: unidade que virou multicanal no meio do mês — acumulado do canal é DESCONHECIDO (null, nunca 0)", () => {
  const m = desempenhoAnteriorPorCanal({
    linhasDoMes: [pai("p", "2026-10-05", { estrutura_lancamento: "padrao", qtd_vendas: 300 })],
    linhasCanaisDoMes: [], antesDeDataIso: "2026-10-10", canalIds: [SALADAS.id],
  });
  assert.deepEqual(m.get(SALADAS.id), { conhecido: false, qtdVendas: null, valorVendasBruto: null, novosClientes: null });
  // "Sem vendas" nesse caso deixa o desempenho do canal não informado.
  const canais = normalizarCanais(
    [comVendas(SANDUICHES, FIN_SAND), { canalId: SALADAS.id, situacaoCanal: "sem_vendas", ...FIN_SAL }],
    { ...CTX, desempenhoAnterior: m },
  );
  assert.equal(canais[1].qtdVendas, null);
  assert.equal(consolidar(canais).qtdVendas, null);
  assert.equal(consolidar(canais).valorVendasIfood, 26682.29);
});

test("acumulado de outro mês nunca é herdado", () => {
  const m = desempenhoAnteriorPorCanal({
    linhasDoMes: [pai("s", "2026-09-30")],
    linhasCanaisDoMes: [filho("s", SANDUICHES.id, { qtd_vendas: 900 })],
    antesDeDataIso: "2026-10-01", canalIds: [SANDUICHES.id],
  });
  assert.equal(m.get(SANDUICHES.id).qtdVendas, 0);
});

test("pré-preenchimento: último snapshot financeiro do canal, ignorando dias sem operação", () => {
  const m = snapshotFinanceiroAnteriorPorCanal({
    linhasDoMes: [pai("a", "2026-10-02"), pai("b", "2026-10-03", { situacao: "sem_operacao" })],
    linhasCanaisDoMes: [
      filho("a", SALADAS.id, { valor_vendas_ifood: 3000, taxas_comissoes: 390 }),
      filho("b", SALADAS.id, { valor_vendas_ifood: 0, taxas_comissoes: 0 }),
    ],
    antesDeDataIso: "2026-10-04", canalIds: [SALADAS.id, SANDUICHES.id],
  });
  assert.equal(Number(m.get(SALADAS.id).valor_vendas_ifood), 3000);
  assert.equal(m.get(SANDUICHES.id), null);
});

// ---------------------------------------------------------------------------
// Integração com a normalização consolidada existente (cenários 2, 13)
// ---------------------------------------------------------------------------
test("2: consolidado passa pela normalizarDadosLancamento existente sem mudança de regra", () => {
  const body = {
    situacao: "normal", status: "finalizado", observacao: "ok", taxasEntregadores: 1200,
    canais: [comVendas(SANDUICHES, FIN_SAND), comVendas(SALADAS, FIN_SAL)],
  };
  const canais = normalizarCanais(body.canais, CTX);
  const consolidado = consolidarCanais(canais, { escopoEntregadores: ESCOPO_ENTREGADORES.UNIDADE, taxasEntregadoresUnidade: body.taxasEntregadores });
  const corpo = corpoConsolidado(body, consolidado);
  assert.equal(corpo.canais, undefined);
  const dados = normalizarDadosLancamento(corpo, { exigirFinanceiro: true, desempenhoAnterior: null });
  assert.equal(dados.valorVendasIfood, 26682.29);
  assert.equal(dados.taxasEntregadores, 1200);
  assert.equal(dados.qtdVendas, 550);
  assert.equal(dados.observacao, "ok");
});

test("13: o cliente nunca impõe o consolidado — valores de unidade no corpo são sobrescritos pela soma", () => {
  const canais = normalizarCanais([comVendas(SANDUICHES, FIN_SAND), comVendas(SALADAS, FIN_SAL)], CTX);
  const corpo = corpoConsolidado({ situacao: "normal", valorVendasIfood: 1, qtdVendas: 1 }, consolidar(canais));
  assert.equal(corpo.valorVendasIfood, 26682.29);
  assert.equal(corpo.qtdVendas, 550);
});

test("consolidado não informado chega como ausente (undefined) na normalização, nunca 0", () => {
  const canais = normalizarCanais([
    comVendas(SANDUICHES, FIN_SAND), { canalId: SALADAS.id, situacaoCanal: "nao_informado" },
  ], { ...CTX, statusAlvo: "rascunho" });
  const corpo = corpoConsolidado({ situacao: "normal", status: "rascunho" }, consolidar(canais, null));
  assert.equal(corpo.valorVendasIfood, undefined);
  const dados = normalizarDadosLancamento(corpo, { exigirFinanceiro: true, desempenhoAnterior: null });
  assert.equal(dados.valorVendasIfood, null);
  assert.equal(dados.qtdVendas, null);
});

test("linhas para gravação usam as colunas do banco", () => {
  const [linha] = linhasCanaisParaGravacao(normalizarCanais([comVendas(SANDUICHES, FIN_SAND), comVendas(SALADAS, FIN_SAL)], CTX));
  assert.deepEqual(Object.keys(linha).sort(), [
    "ajustes_contra_loja", "ajustes_favor_loja", "canal_id", "novos_clientes", "qtd_vendas", "servicos_promocoes",
    "situacao_canal", "taxas_comissoes", "taxas_entregadores", "valor_vendas_bruto", "valor_vendas_ifood",
  ]);
  assert.equal(linha.canal_id, SANDUICHES.id);
  assert.equal(linha.valor_vendas_ifood, 22914.53);
});

// ---------------------------------------------------------------------------
// Checkpoint D — funções de apoio ao service
// ---------------------------------------------------------------------------
test("D: diffCanais — só o que mudou; completar campo vazio não é correção", () => {
  const antes = [{ canal_id: "a", situacao_canal: "com_vendas", valor_vendas_ifood: "100.00", qtd_vendas: null }];
  const depois = [{ canal_id: "a", situacao_canal: "com_vendas", valor_vendas_ifood: 100, qtd_vendas: 5 },
    { canal_id: "b", situacao_canal: "sem_vendas", valor_vendas_ifood: 7 }];
  const m = diffCanais(antes, depois);
  assert.deepEqual(m.map((x) => [x.canalId, x.coluna, x.exigeCorrecao]), [
    ["a", "qtd_vendas", false], ["b", "situacao_canal", false], ["b", "valor_vendas_ifood", false],
  ]);
  assert.deepEqual(diffCanais(antes, [{ ...depois[0], valor_vendas_ifood: 90, qtd_vendas: null }]).map((x) => [x.coluna, x.exigeCorrecao]), [["valor_vendas_ifood", true]]);
});

test("D: etapaIncompletaMulticanal — situação, financeiro (canal ou compartilhado) e conferência", () => {
  const base = { situacao: "normal", mostrarFinanceiro: true, escopoEntregadores: "unidade", taxasEntregadoresUnidade: 10 };
  const ok = { situacaoCanal: "com_vendas", valorVendasIfood: 1, taxasComissoes: 0, servicosPromocoes: 0 };
  assert.equal(etapaIncompletaMulticanal({ ...base, situacao: null, canais: [] }), "situacao");
  assert.equal(etapaIncompletaMulticanal({ ...base, situacao: "sem_operacao", motivoSemOperacao: null, canais: [] }), "situacao");
  assert.equal(etapaIncompletaMulticanal({ ...base, situacao: "zero_vendas", canais: [] }), "conferencia");
  assert.equal(etapaIncompletaMulticanal({ ...base, canais: [ok, { situacaoCanal: null }] }), "situacao");
  assert.equal(etapaIncompletaMulticanal({ ...base, canais: [ok, { situacaoCanal: "nao_informado" }] }), "financeiro");
  assert.equal(etapaIncompletaMulticanal({ ...base, taxasEntregadoresUnidade: null, canais: [ok, ok] }), "financeiro");
  assert.equal(etapaIncompletaMulticanal({ ...base, taxasEntregadoresUnidade: null, entregadoresAplicavel: false, canais: [ok, ok] }), "conferencia");
  assert.equal(etapaIncompletaMulticanal({ ...base, mostrarFinanceiro: false, canais: [ok, { situacaoCanal: "nao_informado" }] }), "conferencia");
});

test("D: escopo do dia vem do próprio dia (imutável), não da configuração atual", () => {
  assert.equal(escopoEntregadoresDoDia({ lancamento: { escopo_entregadores_lancamento: "canal" }, config: { taxas_entregadores_escopo: "unidade" } }), "canal");
  assert.equal(escopoEntregadoresDoDia({ lancamento: { escopo_entregadores_lancamento: "unidade" }, config: { taxas_entregadores_escopo: "canal" } }), "unidade");
  assert.equal(escopoEntregadoresDoDia({ lancamento: null, config: { taxas_entregadores_escopo: "canal" } }), "canal");
});

test("D: composição do mês — mensal e dia padrão ficam indisponíveis; null nunca vira 0", () => {
  const canais = [{ id: "a", nome: "A", ordem: 0 }, { id: "b", nome: "B", ordem: 1 }];
  const mensal = [{ data_lancamento: "2026-09-01", situacao: "normal", origem_lancamento: "distribuicao_mensal", valor_vendas_ifood: 100, qtd_vendas: 1, valor_vendas_bruto: 50 }];
  assert.equal(composicaoCanaisDoMes({ linhasDoMes: mensal, linhasCanaisDoMes: [], canais }).financeiro.motivo, "lancamento_mensal");
  const padrao = [{ id: "p", data_lancamento: "2026-09-01", situacao: "normal", estrutura_lancamento: "padrao", valor_vendas_ifood: 100 }];
  assert.equal(composicaoCanaisDoMes({ linhasDoMes: padrao, linhasCanaisDoMes: [], canais }).financeiro.motivo, "dia_sem_canais");
  assert.equal(composicaoCanaisDoMes({ linhasDoMes: [], linhasCanaisDoMes: [], canais }).financeiro.motivo, "sem_financeiro");
  const multi = [{ id: "m", data_lancamento: "2026-09-02", situacao: "normal", estrutura_lancamento: "multicanal", escopo_entregadores_lancamento: "unidade",
    valor_vendas_ifood: 300, taxas_entregadores: 12, qtd_vendas: null, valor_vendas_bruto: null }];
  const filhos = [{ lancamento_id: "m", canal_id: "b", situacao_canal: "com_vendas", valor_vendas_ifood: 100 },
    { lancamento_id: "m", canal_id: "a", situacao_canal: "com_vendas", valor_vendas_ifood: 200, taxas_entregadores: null }];
  const c = composicaoCanaisDoMes({ linhasDoMes: multi, linhasCanaisDoMes: filhos, canais });
  assert.deepEqual(c.financeiro.canais.map((x) => [x.nome, x.valorVendasIfood, x.participacaoVendasPct]), [["A", 200, (200 / 300) * 100], ["B", 100, (100 / 300) * 100]]);
  assert.equal(c.financeiro.compartilhado.taxasEntregadores, 12);
  assert.equal(c.financeiro.canais[1].taxasComissoes, null);
  assert.equal(c.desempenho.motivo, "sem_desempenho");
});

test("D: valorCanalParaApi converte numéricos e preserva null", () => {
  assert.deepEqual(valorCanalParaApi({ canal_id: "a", situacao_canal: "nao_informado", valor_vendas_ifood: null, qtd_vendas: "3" }), {
    canalId: "a", situacaoCanal: "nao_informado", qtdVendas: 3, valorVendasBruto: null, novosClientes: null, valorVendasIfood: null,
    taxasComissoes: null, servicosPromocoes: null, taxasEntregadores: null, ajustesFavorLoja: null, ajustesContraLoja: null,
  });
});
