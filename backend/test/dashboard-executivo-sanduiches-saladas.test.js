// CRITÉRIO DE ACEITE do Dashboard iFood "Sanduíches + Saladas" (Checkpoint F):
// SANDUÍCHES R$ 20.000 + SALADAS R$ 5.000 => o Dashboard INTEIRO da unidade se
// comporta como uma operação de R$ 25.000.
//
// Chama os services REAIS (criar lançamento + Visão Geral do mês) com o
// cliente supabase apontado para um banco fake em memória
// (test/helpers/bancoFakeMemoria.js) — sem rede, sem banco real. A RPC de
// gravação é emulada com as regras do SQL (validado à parte num Postgres
// efêmero). Duas unidades no mesmo mês:
//   A = Sanduíches e Saladas lançados separadamente (multicanal);
//   B = modo padrão, com os TOTAIS de R$ 25.000 digitados direto.
// A Visão Geral de A precisa ser IGUAL à de B em tudo que é funcional.
//
// Rodar: node --test test/dashboard-executivo-sanduiches-saladas.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "teste";
process.env.SUPABASE_ANON_KEY ??= "teste";

const { supabase } = await import("../src/config/supabase.js");
const { criarBancoFake } = await import("./helpers/bancoFakeMemoria.js");
const svc = await import("../src/modules/dashboard-executivo/dashboardExecutivo.service.js");
const { CANAIS_SANDUICHES_SALADAS } = await import("../src/modules/dashboard-executivo/dashboardExecutivo.canais.js");

const ORG = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SAND = "c0000000-0000-4000-8000-00000000000a";
const SAL = "c0000000-0000-4000-8000-00000000000b";
const TAB = "lancamentos_financeiros_diarios";
const FILHOS = "lancamentos_financeiros_canais";
const DATA = "2026-09-01";

// Metas globais Marketplace vigentes (migrations 024 + 077).
const METAS = [["taxas_comissoes", 0.13, 0.13], ["servicos_promocoes", 0.05, 0.07], ["taxas_entregadores", 0.12, 0.15], ["total_deducoes", 0.30, 0.35]]
  .map(([indicador, meta_ideal, limite]) => ({ organizacao_id: null, unidade_id: null, indicador, modelo_logistico: "marketplace", meta_ideal, limite }));

function rpcLancamento(a, banco) {
  const res = banco.inserir(TAB, { ...a.p_lancamento, organizacao_id: a.p_organizacao_id, unidade_id: a.p_unidade_id, estrutura_lancamento: "multicanal" });
  if (res.error) throw Object.assign(new Error(res.error.message), { code: "23505" });
  for (const c of a.p_canais) banco.inserir(FILHOS, { ...c, organizacao_id: a.p_organizacao_id, unidade_id: a.p_unidade_id, lancamento_id: res.linha.id });
  return structuredClone(res.linha);
}

let banco;
let mesA;
let mesB;
const fetchOriginal = globalThis.fetch;

before(async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  banco = criarBancoFake({
    tabelas: {
      unidades: [A, B].map((id) => ({ id, organizacao_id: ORG, nome: id === A ? "Subway Saci — Matriz" : "Unidade padrão", modelo_logistico_ifood: "marketplace", eh_teste: false, ativo: true })),
      metas_indicadores: METAS,
      dashboard_ifood_unidade_config: [{ unidade_id: A, organizacao_id: ORG, estrutura: "multicanal", taxas_entregadores_escopo: "unidade" }],
      dashboard_ifood_canais: [
        { id: SAND, organizacao_id: ORG, unidade_id: A, nome: CANAIS_SANDUICHES_SALADAS[0], ordem: 0, ativo: true },
        { id: SAL, organizacao_id: ORG, unidade_id: A, nome: CANAIS_SANDUICHES_SALADAS[1], ordem: 1, ativo: true },
      ],
      dashboard_ifood_desbloqueios: [A, B].map((u) => ({ organizacao_id: ORG, unidade_id: u, data_referencia: DATA, tipo: "financeiro_dashboard_ifood", status: "ativo" })),
    },
    defaults: { [TAB]: { estrutura_lancamento: "padrao", escopo_entregadores_lancamento: null, origem_lancamento: "diario" } },
    unicos: { [TAB]: [["unidade_id", "data_lancamento"]] },
    rpcs: { dashboard_ifood_salvar_lancamento_multicanal: rpcLancamento },
  }).instalar(supabase);

  const usuario = { id: null, nome: "Teste", email: "t@x.com" };
  const acesso = { permissoes: [] };
  const canal = (canalId, q, b, n, v, t, s, af, ac) => ({ canalId, situacaoCanal: "com_vendas", qtdVendas: q, valorVendasBruto: b, novosClientes: n, valorVendasIfood: v, taxasComissoes: t, servicosPromocoes: s, ajustesFavorLoja: af, ajustesContraLoja: ac });
  await svc.criarLancamento({ organizacaoId: ORG, unidadeIdSessao: A, acesso, usuario, dados: {
    data: DATA, situacao: "normal", status: "finalizado", taxasEntregadores: 3000, confirmarAvisos: true,
    canais: [canal(SAND, 400, 20000, 50, 20000, 2200, 2000, 100, 50), canal(SAL, 100, 5000, 10, 5000, 550, 500, 0, 0)],
  } });
  await svc.criarLancamento({ organizacaoId: ORG, unidadeIdSessao: B, acesso, usuario, dados: {
    data: DATA, situacao: "normal", status: "finalizado", confirmarAvisos: true,
    qtdVendas: 500, valorVendasBruto: 25000, novosClientes: 60, valorVendasIfood: 25000, taxasComissoes: 2750, servicosPromocoes: 2500,
    taxasEntregadores: 3000, ajustesFavorLoja: 100, ajustesContraLoja: 50,
  } });
  mesA = await svc.obterMes({ organizacaoId: ORG, unidadeIdSessao: A, mes: 9, ano: 2026 });
  mesB = await svc.obterMes({ organizacaoId: ORG, unidadeIdSessao: B, mes: 9, ano: 2026 });
});
after(() => { banco?.restaurar(supabase); globalThis.fetch = fetchOriginal; });

const perto = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
/** Remove só o que identifica a unidade/linha e o detalhe opcional por canal. */
const funcional = (o) => JSON.parse(JSON.stringify(o, (k, v) => ([
  "unidadeId", "id", "lancamentoId", "nome", "createdAt", "updatedAt", "finalizadoEm", "created_at", "updated_at", "finalizado_em",
  "unidade_id", "estrutura_lancamento", "escopo_entregadores_lancamento", "composicaoCanais",
].includes(k) ? undefined : v)));

describe("Sanduíches R$ 20.000 + Saladas R$ 5.000 = unidade de R$ 25.000", () => {
  test("13: linha consolidada gravada = soma dos dois + entregadores UMA vez", () => {
    const l = banco.tabelas[TAB].find((x) => x.unidade_id === A);
    assert.deepEqual(
      [l.qtd_vendas, l.valor_vendas_bruto, l.novos_clientes, l.valor_vendas_ifood, l.taxas_comissoes, l.servicos_promocoes, l.taxas_entregadores, l.ajustes_favor_loja, l.ajustes_contra_loja],
      [500, 25000, 60, 25000, 2750, 2500, 3000, 100, 50],
    );
    assert.ok(banco.tabelas[FILHOS].filter((f) => f.lancamento_id === l.id).every((f) => f.taxas_entregadores === null), "entregadores nunca dentro de Sanduíches/Saladas");
  });

  test("13: cards da Visão Geral (unidade A)", () => {
    const c = mesA.cards;
    assert.equal(c.faturamento.valor, 25000);
    assert.equal(c.ticketMedio.valor, 50);
    assert.equal(c.novosClientes.valor, 60);
    assert.equal(c.taxasComissoes.valor, 2750); perto(c.taxasComissoes.percentual, 11, "% taxas");
    assert.equal(c.servicosPromocoes.valor, 2500); perto(c.servicosPromocoes.percentual, 10, "% serviços");
    assert.equal(c.taxasEntregadores.valor, 3000); perto(c.taxasEntregadores.percentual, 12, "% entregadores");
    assert.equal(c.ajustesFavor.valor, 100);
    assert.equal(c.ajustesContra.valor, 50);
    // Regras ATUAIS: indicador Total = taxas + serviços + entregadores (Marketplace);
    // receita = vendas − (taxas + serviços + entregadores + ajustes contra) + ajustes a favor.
    assert.equal(c.totalDeducoes.valor, 8250); perto(c.totalDeducoes.percentual, 33, "% total");
    assert.equal(c.receitaLiquida.valor, 16800); perto(c.receitaLiquida.percentual, 67.2, "% receita");
  });

  test("15: metas, limites e status calculados sobre o consolidado", () => {
    const ind = mesA.indicadoresRentabilidade;
    const linha = (k) => [Math.round(ind[k].atual * 100) / 100, ind[k].metaIdeal, Math.round(ind[k].limite * 100) / 100, ind[k].status.label];
    assert.deepEqual(linha("taxas_comissoes"), [11, 13, 13, "Dentro da Meta"]);
    assert.deepEqual(linha("servicos_promocoes"), [10, 5, 7, "Atenção"]);
    assert.deepEqual(linha("taxas_entregadores"), [12, 12, 15, "Dentro da Meta"]);
    assert.deepEqual(linha("total_deducoes"), [33, 30, 35, "Dentro do Limite"]);
    // Se o Dashboard enxergasse só Sanduíches, entregadores (15%) e total (36%) mudariam de status:
    assert.notEqual(Math.round((3000 / 20000) * 100), 12);
  });

  test("16: gráficos, projeção, desempenho e evolução usam o consolidado", () => {
    assert.deepEqual(mesA.graficos.comparativoPercentuais.map((g) => [g.indicador, Math.round(g.atual * 100) / 100]),
      [["taxas_comissoes", 11], ["servicos_promocoes", 10], ["taxas_entregadores", 12], ["total_deducoes", 33]]);
    assert.deepEqual(mesA.graficos.composicaoDeducoes.map((g) => g.valor), [2750, 2500, 3000, 50]);
    assert.equal(mesA.projecao.mediaDiaria, 25000);
    assert.equal(mesA.desempenhoOperacional.acumulado, 25000);
    assert.equal(mesA.desempenhoOperacional.acumuladoQtdVendas, 500);
    assert.equal(mesA.desempenhoOperacional.acumuladoNovosClientes, 60);
    assert.equal(mesA.snapshotsFinanceiros.find((p) => p.data === DATA).valor, 25000);
  });

  test("14/15/16: Visão Geral de A (Sanduíches + Saladas) ≡ B (R$ 25.000 lançados direto) em TODAS as seções funcionais", () => {
    const a = funcional(mesA);
    const b = funcional(mesB);
    const diferentes = Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    assert.deepEqual(diferentes, []);
    for (const secao of ["cards", "indicadoresRentabilidade", "graficos", "projecao", "desempenhoOperacional", "snapshotsFinanceiros", "diagnostico", "resumoPreenchimento"]) {
      assert.ok(secao in a, `seção ${secao} presente`);
    }
  });

  test("a composição por canal é só detalhe e fecha com o total", () => {
    const comp = mesA.composicaoCanais.financeiro;
    assert.deepEqual(comp.canais.map((c) => [c.nome, c.valorVendasIfood, Math.round(c.participacaoVendasPct)]), [["Sanduíches", 20000, 80], ["Saladas", 5000, 20]]);
    assert.equal("composicaoCanais" in mesB, false, "unidade padrão não ganha campo novo");
  });
});
