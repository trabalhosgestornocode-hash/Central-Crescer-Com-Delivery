// Lançamento MULTICANAL do Dashboard iFood — backend (Checkpoint D).
// Chama os SERVICES DE VERDADE (criar/atualizar/excluir/GET por data/GET mês/
// reset) com o cliente `supabase` apontado para um banco FAKE em memória
// (test/helpers/bancoFakeMemoria.js) — sem rede, sem banco real, sem `vm`.
// A RPC `dashboard_ifood_salvar_lancamento_multicanal` é emulada aqui com as
// mesmas regras do SQL e de forma transacional (o helper desfaz tudo se ela
// lançar); o SQL de verdade foi validado à parte num Postgres efêmero (PGlite).
//
// Datas em 2026-09 (mês passado e fechado). Dia com Financeiro elegível =
// dia com desbloqueio administrativo ativo (determinístico, não depende de
// "ontem").
//
// Rodar: node --test test/dashboard-executivo-multicanal-service.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "teste";
process.env.SUPABASE_ANON_KEY ??= "teste";

const { supabase } = await import("../src/config/supabase.js");
const { criarBancoFake } = await import("./helpers/bancoFakeMemoria.js");
const svc = await import("../src/modules/dashboard-executivo/dashboardExecutivo.service.js");

const ORG = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const UNI = "11111111-1111-4111-8111-111111111111";      // multicanal
const UNI_P = "22222222-2222-4222-8222-222222222222";    // padrão (sem configuração)
const UNI_X = "33333333-3333-4333-8333-333333333333";    // outra unidade
const CA = "c0000000-0000-4000-8000-00000000000a";
const CB = "c0000000-0000-4000-8000-00000000000b";
const CC = "c0000000-0000-4000-8000-00000000000c";       // inativo
const CX = "c0000000-0000-4000-8000-0000000000ff";       // canal da outra unidade
const TAB = "lancamentos_financeiros_diarios";
const FILHOS = "lancamentos_financeiros_canais";
const USUARIO = { id: null, nome: "Teste", email: "t@x.com" };
const CORRIGIR = { permissoes: ["dashboard_executivo.corrigir"] };
const SEM_PERM = { permissoes: [] };

// --- emulação da RPC de lançamento (mesmas regras da migration 108 §6) -----
const erro = (msg, code = "P0001") => Object.assign(new Error(msg), { code });
const COLS = ["situacao", "motivo_sem_operacao", "observacao", "qtd_vendas", "valor_vendas_bruto", "novos_clientes", "valor_vendas_ifood",
  "taxas_comissoes", "servicos_promocoes", "taxas_entregadores", "ajustes_favor_loja", "ajustes_contra_loja", "justificativa_ajuste"];
const OPCIONAIS = ["status", "finalizado_em", "usuario_id", "usuario_nome", "usuario_email"];
const COLS_FILHO = ["situacao_canal", "qtd_vendas", "valor_vendas_bruto", "novos_clientes", "valor_vendas_ifood", "taxas_comissoes",
  "servicos_promocoes", "taxas_entregadores", "ajustes_favor_loja", "ajustes_contra_loja"];
let falharRpcDepoisDoPai = false;

function rpcLancamento(a, banco) {
  if (!Array.isArray(a.p_canais) || !a.p_canais.length) throw erro("CANAIS_OBRIGATORIOS: informe os valores dos canais.");
  const r = a.p_lancamento;
  let linha;
  if (!a.p_lancamento_id) {
    if (!["unidade", "canal"].includes(r.escopo_entregadores_lancamento)) throw erro("ESCOPO_OBRIGATORIO: informe o escopo.");
    const novo = { organizacao_id: a.p_organizacao_id, unidade_id: a.p_unidade_id, data_lancamento: r.data_lancamento,
      estrutura_lancamento: "multicanal", escopo_entregadores_lancamento: r.escopo_entregadores_lancamento, status: r.status ?? "rascunho" };
    for (const c of [...COLS, ...OPCIONAIS]) if (c in r) novo[c] = r[c];
    const res = banco.inserir(TAB, novo);
    if (res.error) throw erro(res.error.message, "23505");
    linha = banco.tabelas[TAB].find((l) => l.id === res.linha.id);
  } else {
    linha = banco.tabelas[TAB].find((l) => l.id === a.p_lancamento_id && l.organizacao_id === a.p_organizacao_id && l.unidade_id === a.p_unidade_id);
    if (!linha) throw erro("LANCAMENTO_NAO_ENCONTRADO");
    if (linha.estrutura_lancamento !== "multicanal") throw erro("LANCAMENTO_NAO_MULTICANAL: padrão.");
    if (!a.p_versao || linha.updated_at !== a.p_versao) throw erro("LANCAMENTO_DESATUALIZADO");
    const ids = new Set(a.p_canais.map((c) => c.canal_id));
    if (banco.tabelas[FILHOS]?.some((f) => f.lancamento_id === linha.id && !ids.has(f.canal_id))) throw erro("CANAL_AUSENTE: canal sumiu.");
    for (const c of COLS) linha[c] = r[c] ?? null;
    for (const c of OPCIONAIS) if (c in r) linha[c] = r[c];
    linha.updated_at = banco.agora();
  }
  if (falharRpcDepoisDoPai) throw erro("falha simulada no meio da RPC");
  for (const c of a.p_canais) {
    const canal = banco.tabelas.dashboard_ifood_canais.find((k) => k.id === c.canal_id && k.unidade_id === a.p_unidade_id);
    if (!canal) throw erro("insert or update on table violates foreign key constraint lfc_canal_fk", "23503");
    const existente = (banco.tabelas[FILHOS] ??= []).find((f) => f.lancamento_id === linha.id && f.canal_id === c.canal_id);
    const valores = Object.fromEntries(COLS_FILHO.map((k) => [k, c[k] ?? null]));
    if (existente) Object.assign(existente, valores);
    else banco.inserir(FILHOS, { organizacao_id: a.p_organizacao_id, unidade_id: a.p_unidade_id, lancamento_id: linha.id, canal_id: c.canal_id, ...valores });
  }
  return structuredClone(linha);
}

// --- montagem do cenário ------------------------------------------------------
let banco;
let eventos;
const fetchOriginal = globalThis.fetch;

const metas = (modelo) => ["taxas_comissoes", "servicos_promocoes", "taxas_entregadores", "total_deducoes"]
  .map((indicador) => ({ organizacao_id: null, unidade_id: null, indicador, modelo_logistico: modelo, meta_ideal: 0.1, limite: 0.2 }));

function montar({ escopo = "unidade", modelo = "marketplace", lancamentos = [], valores = [], desbloqueios = ["2026-09-01", "2026-09-02", "2026-09-03"], comCanalInativo = true } = {}) {
  banco = criarBancoFake({
    tabelas: {
      unidades: [
        { id: UNI, organizacao_id: ORG, nome: "Unidade Multicanal", modelo_logistico_ifood: modelo, eh_teste: true, ativo: true },
        { id: UNI_P, organizacao_id: ORG, nome: "Unidade Padrão", modelo_logistico_ifood: modelo, eh_teste: false, ativo: true },
        { id: UNI_X, organizacao_id: ORG, nome: "Outra", modelo_logistico_ifood: modelo, eh_teste: false, ativo: true },
      ],
      metas_indicadores: [...metas("marketplace"), ...metas("full_service")],
      dashboard_ifood_unidade_config: [{ unidade_id: UNI, organizacao_id: ORG, estrutura: "multicanal", taxas_entregadores_escopo: escopo }],
      dashboard_ifood_canais: [
        { id: CA, organizacao_id: ORG, unidade_id: UNI, nome: "Canal A", ordem: 0, ativo: true },
        { id: CB, organizacao_id: ORG, unidade_id: UNI, nome: "Canal B", ordem: 1, ativo: true },
        ...(comCanalInativo ? [{ id: CC, organizacao_id: ORG, unidade_id: UNI, nome: "Canal C", ordem: 2, ativo: false }] : []),
        { id: CX, organizacao_id: ORG, unidade_id: UNI_X, nome: "Canal X", ordem: 0, ativo: true },
      ],
      [TAB]: lancamentos,
      [FILHOS]: valores,
      dashboard_ifood_desbloqueios: desbloqueios.map((d) => ({ organizacao_id: ORG, unidade_id: UNI, data_referencia: d, tipo: "financeiro_dashboard_ifood", status: "ativo" })),
    },
    defaults: { [TAB]: { estrutura_lancamento: "padrao", escopo_entregadores_lancamento: null, origem_lancamento: "diario" } },
    unicos: { [TAB]: [["unidade_id", "data_lancamento"]] },
    cascatas: [
      { pai: TAB, filho: FILHOS, fk: "lancamento_id" },
      { pai: TAB, filho: "lancamentos_financeiros_auditoria", fk: "lancamento_id" },
    ],
    rpcs: { dashboard_ifood_salvar_lancamento_multicanal: rpcLancamento },
  }).instalar(supabase);
  eventos = [];
  globalThis.fetch = async (_url, o) => { eventos.push(JSON.parse(o.body).tipo); return { ok: true, status: 200 }; };
  return banco;
}

beforeEach(() => { falharRpcDepoisDoPai = false; });
afterEach(() => { banco?.restaurar(supabase); globalThis.fetch = fetchOriginal; });

// Dia 01 multicanal já finalizado (A: 1000 / B: 100), base dos acumulados.
const ID_D1 = "d1000000-0000-4000-8000-000000000001";
const dia1 = (extra = {}) => ({
  id: ID_D1, organizacao_id: ORG, unidade_id: UNI, data_lancamento: "2026-09-01", situacao: "normal", status: "finalizado",
  estrutura_lancamento: "multicanal", escopo_entregadores_lancamento: "unidade", origem_lancamento: "diario",
  qtd_vendas: 110, valor_vendas_bruto: 4400, novos_clientes: 11, valor_vendas_ifood: 1100, taxas_comissoes: 110,
  servicos_promocoes: 55, taxas_entregadores: 40, ajustes_favor_loja: null, ajustes_contra_loja: null, ...extra,
});
const filhosDia1 = () => [
  { organizacao_id: ORG, unidade_id: UNI, lancamento_id: ID_D1, canal_id: CA, situacao_canal: "com_vendas", qtd_vendas: 100, valor_vendas_bruto: 4000, novos_clientes: 10, valor_vendas_ifood: 1000, taxas_comissoes: 100, servicos_promocoes: 50, taxas_entregadores: null, ajustes_favor_loja: null, ajustes_contra_loja: null },
  { organizacao_id: ORG, unidade_id: UNI, lancamento_id: ID_D1, canal_id: CB, situacao_canal: "com_vendas", qtd_vendas: 10, valor_vendas_bruto: 400, novos_clientes: 1, valor_vendas_ifood: 100, taxas_comissoes: 10, servicos_promocoes: 5, taxas_entregadores: null, ajustes_favor_loja: null, ajustes_contra_loja: null },
];

const ctx = (unidade = UNI) => ({ organizacaoId: ORG, unidadeIdSessao: unidade, usuario: USUARIO });
const fin = (vendas, taxas, servicos, extra = {}) => ({ valorVendasIfood: vendas, taxasComissoes: taxas, servicosPromocoes: servicos, ...extra });
const comVendas = (canalId, valores) => ({ canalId, situacaoCanal: "com_vendas", ...valores });
const criar = (body, opts = {}) => svc.criarLancamento({ ...ctx(opts.unidade), acesso: opts.acesso ?? SEM_PERM, dados: body });
const atualizar = (id, body, acesso = SEM_PERM) => svc.atualizarLancamento({ ...ctx(), acesso, id, dados: body });
const linhaDoDia = (data, unidade = UNI) => banco.tabelas[TAB].find((l) => l.unidade_id === unidade && l.data_lancamento === data);
const filhosDe = (id) => (banco.tabelas[FILHOS] ?? []).filter((f) => f.lancamento_id === id);
const chamadasRpc = () => banco.log.filter((l) => l.rpc === "dashboard_ifood_salvar_lancamento_multicanal");
const escritasDiretas = () => banco.log.filter((l) => l.tabela === TAB && l.op !== "select");

/** Dia 02 completo: A 2000/26 pedidos... (somas fáceis de conferir). */
const corpoDia2 = (extra = {}) => ({
  data: "2026-09-02", situacao: "normal", status: "finalizado", taxasEntregadores: 120,
  canais: [
    comVendas(CA, { qtdVendas: 500, valorVendasBruto: 22000, novosClientes: 40, ...fin(22914.53, 2978.89, 1145.73, { ajustesFavorLoja: 10, ajustesContraLoja: 5 }) }),
    comVendas(CB, { qtdVendas: 50, valorVendasBruto: 4000, novosClientes: 8, ...fin(3767.76, 489.81, 188.39) }),
  ],
  ...extra,
});

// ---------------------------------------------------------------------------
describe("1 — unidade padrão continua no caminho atual", () => {
  test("criar numa unidade sem configuração: insert direto, nenhuma RPC, nenhum valor por canal", async () => {
    montar();
    const r = await criar({ data: "2026-09-01", situacao: "normal", status: "rascunho", qtdVendas: 5, valorVendasBruto: 100 }, { unidade: UNI_P });
    assert.equal(r.multicanal, undefined);
    assert.equal(chamadasRpc().length, 0);
    assert.equal(escritasDiretas().filter((l) => l.op === "insert").length, 1);
    assert.equal(linhaDoDia("2026-09-01", UNI_P).estrutura_lancamento, "padrao");
    assert.equal((banco.tabelas[FILHOS] ?? []).length, 0);
  });

  test("payload com `canais` numa unidade padrão é recusado", async () => {
    montar();
    await assert.rejects(criar({ data: "2026-09-01", situacao: "normal", canais: [] }, { unidade: UNI_P }), /não usa lançamento por canais/);
  });

  test("GET por data de unidade padrão não traz o bloco `multicanal`", async () => {
    montar();
    const r = await svc.obterLancamentoPorData({ ...ctx(UNI_P), data: "2026-09-01" });
    assert.equal("multicanal" in r, false);
  });

  test("15/16: dia ANTIGO padrão numa unidade que virou multicanal continua padrão ao editar", async () => {
    montar({ lancamentos: [{ ...dia1(), estrutura_lancamento: "padrao", escopo_entregadores_lancamento: null }], valores: [] });
    const antes = linhaDoDia("2026-09-01");
    const porData = await svc.obterLancamentoPorData({ ...ctx(), data: "2026-09-01" });
    assert.equal("multicanal" in porData, false, "abre como foi criado");
    await atualizar(ID_D1, { situacao: "normal", status: "rascunho", observacao: "obs", qtdVendas: 110, valorVendasBruto: 4400, novosClientes: 11,
      valorVendasIfood: 1100, taxasComissoes: 110, servicosPromocoes: 55, taxasEntregadores: 40, seVersao: antes.updated_at });
    assert.equal(chamadasRpc().length, 0);
    assert.equal(linhaDoDia("2026-09-01").estrutura_lancamento, "padrao");
    await assert.rejects(atualizar(ID_D1, { situacao: "normal", canais: [] }), /não foi lançado por canais/);
  });
});

// ---------------------------------------------------------------------------
describe("2/3, 10, 11, 14–18, 34 — dois canais com vendas, consolidado no servidor", () => {
  test("gravação atômica numa RPC; consolidado = soma dos canais; derivados recalculados", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    const r = await criar(corpoDia2());
    assert.equal(chamadasRpc().length, 1);
    assert.equal(escritasDiretas().length, 0, "nenhuma escrita multicanal fora da RPC");
    const l = linhaDoDia("2026-09-02");
    assert.deepEqual([l.estrutura_lancamento, l.escopo_entregadores_lancamento], ["multicanal", "unidade"]);
    assert.equal(l.qtd_vendas, 550);
    assert.equal(l.valor_vendas_bruto, 26000);
    assert.equal(l.novos_clientes, 48);
    assert.equal(l.valor_vendas_ifood, 26682.29);
    assert.equal(l.taxas_comissoes, 3468.7);
    assert.equal(l.servicos_promocoes, 1334.12);
    assert.equal(l.taxas_entregadores, 120, "11: compartilhada entra uma vez");
    assert.equal(l.ajustes_favor_loja, 10);
    assert.equal(l.ajustes_contra_loja, 5);
    const fs = filhosDe(l.id);
    assert.equal(fs.length, 2);
    assert.ok(fs.every((f) => f.taxas_entregadores === null), "11: nunca dentro do canal");
    assert.equal(fs.find((f) => f.canal_id === CA).valor_vendas_ifood, 22914.53, "10: financeiro por canal");
    // 14–18: derivados do consolidado (nunca média de canais).
    const c = r.lancamento.calculado;
    assert.equal(c.ticketMedio, 26000 / 550);
    const totalDed = 3468.7 + 1334.12 + 120 + 5;
    assert.ok(Math.abs(c.totalDeducoes - totalDed) < 1e-9);
    assert.ok(Math.abs(c.percentuais.taxasComissoes - (3468.7 / 26682.29) * 100) < 1e-9);
    assert.ok(Math.abs(c.percentuais.taxasEntregadores - (120 / 26682.29) * 100) < 1e-9);
    assert.ok(Math.abs(c.receitaLiquida - (26682.29 - totalDed + 10)) < 1e-9);
    assert.equal(r.multicanal.canais.length, 2);
    assert.deepEqual(eventos.filter((e) => e === "dashboard_ifood.lancamento_criado").length, 2);
  });

  test("34: consolidado enviado pelo cliente é ignorado — vale sempre a soma dos canais", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    await criar(corpoDia2({ valorVendasIfood: 1, qtdVendas: 1, taxasComissoes: 0 }));
    const [chamada] = chamadasRpc();
    const soma = (col) => chamada.args.p_canais.reduce((s, f) => s + Math.round(Number(f[col]) * 100), 0) / 100;
    assert.equal(chamada.args.p_lancamento.valor_vendas_ifood, soma("valor_vendas_ifood"));
    assert.equal(chamada.args.p_lancamento.qtd_vendas, soma("qtd_vendas"));
    assert.equal(chamada.args.p_lancamento.taxas_comissoes, soma("taxas_comissoes"));
    assert.equal(linhaDoDia("2026-09-02").valor_vendas_ifood, 26682.29);
  });

  test("11: taxa de entregadores dentro de um canal no escopo 'unidade' é recusada e nada é gravado", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    const corpo = corpoDia2();
    corpo.canais[0].taxasEntregadores = 60;
    await assert.rejects(criar(corpo), /compartilhadas pela unidade/);
    assert.equal(linhaDoDia("2026-09-02"), undefined);
  });

  test("11: escopo 'unidade' + Marketplace exige a taxa compartilhada ao finalizar dia com Financeiro", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    await assert.rejects(criar(corpoDia2({ taxasEntregadores: undefined })), /Taxas de entregadores/);
  });
});

// ---------------------------------------------------------------------------
describe("12, 13 — escopo por canal e Full Service", () => {
  test("12 (Checkpoint F): dia NOVO usa sempre taxa da unidade — mesmo com configuração legada 'canal'", async () => {
    montar({ escopo: "canal" });
    const corpo = corpoDia2({ data: "2026-09-01", taxasEntregadores: undefined });
    corpo.canais[0].taxasEntregadores = 100.1;
    await assert.rejects(criar(corpo), /compartilhadas pela unidade/, "entregadores dentro de um canal são recusados");
    await criar(corpoDia2({ data: "2026-09-01", taxasEntregadores: 120 }));
    const l = linhaDoDia("2026-09-01");
    assert.equal(l.escopo_entregadores_lancamento, "unidade");
    assert.equal(l.taxas_entregadores, 120);
    assert.ok(filhosDe(l.id).every((f) => f.taxas_entregadores === null));
    const porData = await svc.obterLancamentoPorData({ ...ctx(), data: "2026-09-02" });
    assert.equal(porData.multicanal.taxasEntregadoresEscopo, "unidade");
  });

  test("12: dia JÁ gravado com escopo 'canal' mantém o escopo dele (histórico nunca é reinterpretado)", async () => {
    montar({ lancamentos: [dia1({ escopo_entregadores_lancamento: "canal" })], valores: filhosDia1() });
    const r = await svc.obterLancamentoPorData({ ...ctx(), data: "2026-09-01" });
    assert.equal(r.multicanal.taxasEntregadoresEscopo, "canal");
  });

  test("13: Full Service — entregadores não exigido (regra atual de aplicabilidade preservada)", async () => {
    montar({ modelo: "full_service" });
    await criar(corpoDia2({ data: "2026-09-01", taxasEntregadores: undefined }));
    assert.equal(linhaDoDia("2026-09-01").taxas_entregadores, null);
  });

  test("escopo é do DIA: trocar a configuração depois não reinterpreta o dia ao editar", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    banco.tabelas.dashboard_ifood_unidade_config[0].taxas_entregadores_escopo = "canal";
    const r = await svc.obterLancamentoPorData({ ...ctx(), data: "2026-09-01" });
    assert.equal(r.multicanal.taxasEntregadoresEscopo, "unidade");
  });
});

// ---------------------------------------------------------------------------
describe("4, 5, 6, 7, 8, 9 — situações por canal e participantes", () => {
  test("4/7: um canal sem vendas repete o PRÓPRIO acumulado de Desempenho (delta 0), Financeiro continua exigido", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    const corpo = corpoDia2();
    corpo.canais[1] = { canalId: CB, situacaoCanal: "sem_vendas", qtdVendas: 0, valorVendasBruto: 0 };
    await assert.rejects(criar(corpo), /Canal B: Valor das vendas \(iFood\)/, "decisão 2: extrato continua exigido");
    corpo.canais[1] = { canalId: CB, situacaoCanal: "sem_vendas", ...fin(100, 10, 5) };
    await criar(corpo);
    const b = filhosDe(linhaDoDia("2026-09-02").id).find((f) => f.canal_id === CB);
    assert.deepEqual([b.situacao_canal, b.qtd_vendas, b.valor_vendas_bruto, b.novos_clientes], ["sem_vendas", 10, 400, 1]);
    assert.equal(linhaDoDia("2026-09-02").qtd_vendas, 510);
  });

  test("7: unidade 'Não funcionou' — sem pergunta por canal; todos sem_vendas com acumulado repetido", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    await criar({ data: "2026-09-02", situacao: "sem_operacao", status: "finalizado", motivoSemOperacao: "Feriado" });
    const fs = filhosDe(linhaDoDia("2026-09-02").id);
    assert.deepEqual(fs.map((f) => [f.canal_id, f.situacao_canal, f.qtd_vendas]).sort(), [[CA, "sem_vendas", 100], [CB, "sem_vendas", 10]]);
    assert.equal(linhaDoDia("2026-09-02").qtd_vendas, 110);
  });

  test("5/22: 'não informado' é aceito em RASCUNHO; consolidado fica não informado (null), nunca soma parcial", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    const corpo = corpoDia2({ status: "rascunho" });
    corpo.canais[1] = { canalId: CB, situacaoCanal: "nao_informado" };
    await criar(corpo);
    const l = linhaDoDia("2026-09-02");
    assert.equal(l.status, "rascunho");
    assert.equal(l.valor_vendas_ifood, null);
    assert.equal(l.qtd_vendas, null);
    const b = filhosDe(l.id).find((f) => f.canal_id === CB);
    assert.equal(b.situacao_canal, "nao_informado");
    assert.equal(b.valor_vendas_ifood, null);
  });

  test("6: 'não informado' bloqueia FINALIZAR em dia com Financeiro elegível — nada persiste", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    const corpo = corpoDia2();
    corpo.canais[1] = { canalId: CB, situacaoCanal: "nao_informado" };
    await assert.rejects(criar(corpo), (e) => e.statusCode === 400 && e.details?.canalNaoInformado === true);
    assert.equal(linhaDoDia("2026-09-02"), undefined);
    assert.equal(chamadasRpc().length, 0);
  });

  test("6: sem Financeiro elegível (sem desbloqueio, não é ontem), 'não informado' pode finalizar", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1(), desbloqueios: [] });
    await criar({ data: "2026-09-02", situacao: "normal", status: "finalizado", canais: [
      comVendas(CA, { qtdVendas: 200, valorVendasBruto: 8000 }), { canalId: CB, situacaoCanal: "nao_informado" },
    ] });
    const l = linhaDoDia("2026-09-02");
    assert.equal(l.status, "finalizado");
    assert.equal(l.valor_vendas_ifood, null);
  });

  test("8: primeiro dia multicanal no meio do mês — 'sem vendas' sem acumulado próprio fica não informado (null)", async () => {
    montar({ lancamentos: [{ ...dia1(), estrutura_lancamento: "padrao", escopo_entregadores_lancamento: null }], valores: [] });
    const corpo = corpoDia2();
    corpo.canais[1] = { canalId: CB, situacaoCanal: "sem_vendas", ...fin(3767.76, 489.81, 188.39) };
    await criar(corpo);
    const l = linhaDoDia("2026-09-02");
    const b = filhosDe(l.id).find((f) => f.canal_id === CB);
    assert.equal(b.qtd_vendas, null);
    assert.equal(l.qtd_vendas, null, "consolidado de Desempenho também não informado");
    assert.equal(l.valor_vendas_ifood, 26682.29, "Financeiro (extrato do mês) segue normal");
  });

  test("9/33: canal desativado com dado no mês continua participando; omiti-lo é recusado", async () => {
    const filhoC = { organizacao_id: ORG, unidade_id: UNI, lancamento_id: ID_D1, canal_id: CC, situacao_canal: "com_vendas", qtd_vendas: 1, valor_vendas_bruto: 10, novos_clientes: 0, valor_vendas_ifood: 10, taxas_comissoes: 1, servicos_promocoes: 0, taxas_entregadores: null, ajustes_favor_loja: null, ajustes_contra_loja: null };
    montar({ lancamentos: [dia1({ valor_vendas_ifood: 1110 })], valores: [...filhosDia1(), filhoC] });
    await assert.rejects(criar(corpoDia2()), /Informe a situação do canal "Canal C"/);
    const corpo = corpoDia2();
    corpo.canais.push({ canalId: CC, situacaoCanal: "sem_vendas", ...fin(10, 1, 0) });
    await criar(corpo);
    assert.equal(filhosDe(linhaDoDia("2026-09-02").id).length, 3);
  });

  test("canal inativo SEM dado no mês não participa (e não pode ser enviado)", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    const corpo = corpoDia2();
    corpo.canais.push({ canalId: CC, situacaoCanal: "sem_vendas", ...fin(0, 0, 0) });
    await assert.rejects(criar(corpo), /não pertence a esta unidade ou não participa/);
  });

  test("32: canal de outra unidade é recusado antes do banco", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    const corpo = corpoDia2();
    corpo.canais.push(comVendas(CX, fin(1, 0, 0)));
    await assert.rejects(criar(corpo), /não pertence a esta unidade/);
    assert.equal(chamadasRpc().length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("19, 20 — queda de acumulado por canal e consolidada", () => {
  test("19: queda MATERIAL só num canal (consolidado sobe) exige confirmação reforçada + justificativa e é auditada", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    const corpo = {
      data: "2026-09-02", situacao: "normal", status: "finalizado", taxasEntregadores: 50,
      canais: [comVendas(CA, fin(500, 110, 55)), comVendas(CB, fin(900, 20, 10))],
    };
    await assert.rejects(criar(corpo), (e) => e.statusCode === 400 && e.details?.confirmacaoReforcadaNecessaria === true
      && e.details.sinaisQuedaMaterial.some((s) => s.campo === `canal:${CA}:valorVendasIfood` && /Canal A/.test(s.mensagem)));
    assert.equal(linhaDoDia("2026-09-02"), undefined);
    await criar({ ...corpo, confirmarQuedaMaterial: true, justificativaQuedaAcumulado: "Estorno do iFood no canal A" });
    const aud = banco.tabelas.lancamentos_financeiros_auditoria.find((a) => a.campo === `canal:${CA}:valorVendasIfood_queda_confirmada`);
    assert.ok(aud);
    assert.deepEqual([aud.valor_anterior, aud.valor_novo, aud.motivo], ["1000", "500", "Estorno do iFood no canal A"]);
  });

  test("20: queda do CONSOLIDADO continua avaliada como hoje (campo sem prefixo de canal)", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    const corpo = {
      data: "2026-09-02", situacao: "normal", status: "finalizado", taxasEntregadores: 50,
      canais: [comVendas(CA, fin(800, 110, 55)), comVendas(CB, fin(90, 10, 5))],
      confirmarAvisos: true,   // a queda LEVE do canal B passa pelo aviso comum primeiro (fluxo de sempre)
    };
    await assert.rejects(criar(corpo), (e) => e.details?.sinaisQuedaMaterial?.some((s) => s.campo === "valorVendasIfood")
      && e.details.sinaisQuedaMaterial.some((s) => s.campo === `canal:${CA}:valorVendasIfood`));
  });
});

// ---------------------------------------------------------------------------
describe("21–25 — rascunho, retomada, edição, concorrência e auditoria", () => {
  async function rascunhoDia2() {
    const corpo = corpoDia2({ status: "rascunho" });
    corpo.canais[1] = { canalId: CB, situacaoCanal: "nao_informado" };
    await criar(corpo);
    return linhaDoDia("2026-09-02");
  }

  test("23/29: retomar rascunho — GET por data devolve estrutura, canais, valores, anteriores, consolidado e etapa", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    await rascunhoDia2();
    const r = await svc.obterLancamentoPorData({ ...ctx(), data: "2026-09-02" });
    const m = r.multicanal;
    assert.equal(m.estruturaDia, "multicanal");
    assert.deepEqual(m.canais.map((c) => c.nome), ["Canal A", "Canal B"]);
    assert.equal(m.valores.find((x) => x.canalId === CB).situacaoCanal, "nao_informado");
    assert.equal(m.valores.find((x) => x.canalId === CA).valorVendasIfood, 22914.53);
    assert.deepEqual(m.anteriores.find((x) => x.canalId === CB).desempenho, { conhecido: true, qtdVendas: 10, valorVendasBruto: 400, novosClientes: 1 });
    assert.equal(m.anteriores.find((x) => x.canalId === CA).financeiro.valorVendasIfood, 1000, "pré-preenchimento do extrato");
    assert.equal(m.consolidado.valorVendasIfood, null);
    assert.equal(m.etapaIncompleta, "financeiro");
    assert.equal(r.lancamento.status, "rascunho");
  });

  test("29: GET por data de dia NOVO numa unidade multicanal já traz canais e etapa inicial", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    const r = await svc.obterLancamentoPorData({ ...ctx(), data: "2026-09-02" });
    assert.equal(r.lancamento, null);
    assert.equal(r.multicanal.estruturaDia, "multicanal");
    assert.deepEqual(r.multicanal.valores, []);
    assert.equal(r.multicanal.etapaIncompleta, "situacao");
  });

  test("22: completar o rascunho e finalizar (sem permissão de correção: completar campo vazio não é correção)", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    const l = await rascunhoDia2();
    await atualizar(l.id, { ...corpoDia2(), seVersao: l.updated_at });
    const depois = linhaDoDia("2026-09-02");
    assert.equal(depois.status, "finalizado");
    assert.equal(depois.valor_vendas_ifood, 26682.29);
  });

  test("21: concorrência — versão velha recebe 409 e não sobrescreve a composição; sem versão é recusado", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    const l = await rascunhoDia2();
    const versaoLida = l.updated_at;                                     // as duas telas abriram aqui
    await atualizar(l.id, { ...corpoDia2({ status: "rascunho" }), seVersao: versaoLida });   // 1º salva
    const composicao = JSON.stringify(filhosDe(l.id));
    const outro = corpoDia2({ status: "rascunho" });
    outro.canais[0].valorVendasIfood = 1;
    await assert.rejects(atualizar(l.id, { ...outro, seVersao: versaoLida }), (e) => e.statusCode === 409);   // 2º com tela velha
    assert.equal(JSON.stringify(filhosDe(l.id)), composicao);
    await assert.rejects(atualizar(l.id, { ...outro, seVersao: undefined }), /Versão do lançamento ausente/);
  });

  test("24/25: edição de dia FINALIZADO — exige permissão + motivo; recalcula consolidado; auditoria por canal e consolidada", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    await criar(corpoDia2());
    const l = linhaDoDia("2026-09-02");
    const corrigido = corpoDia2();
    corrigido.canais[1].valorVendasIfood = 3800;
    await assert.rejects(atualizar(l.id, { ...corrigido, seVersao: l.updated_at }), (e) => e.statusCode === 403);
    await assert.rejects(atualizar(l.id, { ...corrigido, seVersao: l.updated_at }, CORRIGIR), /Motivo da correção/);
    await atualizar(l.id, { ...corrigido, seVersao: l.updated_at, motivo: "extrato corrigido" }, CORRIGIR);
    const depois = linhaDoDia("2026-09-02");
    assert.equal(depois.valor_vendas_ifood, 26714.53, "consolidado recalculado pelo servidor");
    assert.equal(depois.status, "finalizado");
    const aud = banco.tabelas.lancamentos_financeiros_auditoria.filter((a) => a.lancamento_id === l.id && a.motivo === "extrato corrigido");
    assert.deepEqual(aud.map((a) => [a.campo, a.valor_anterior, a.valor_novo]).sort(), [
      [`canal:${CB}:valor_vendas_ifood`, "3767.76", "3800"],
      ["valor_vendas_ifood", "26682.29", "26714.53"],
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("26–28, 35 — exclusão, reset e falha da RPC", () => {
  test("26/27: excluir dia multicanal — canais saem pela FK e o snapshot guarda a composição", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    await svc.excluirLancamento({ ...ctx(), usuario: USUARIO, id: ID_D1, motivo: "teste de exclusão" });
    assert.equal(linhaDoDia("2026-09-01"), undefined);
    assert.equal(filhosDe(ID_D1).length, 0, "nenhum órfão");
    const [exc] = banco.tabelas.lancamentos_financeiros_exclusoes;
    assert.equal(exc.lancamento_snapshot.estrutura_lancamento, "multicanal");
    assert.deepEqual(exc.lancamento_snapshot.canais_valores.map((f) => [f.canal_id, f.valor_vendas_ifood]).sort(), [[CA, 1000], [CB, 100]]);
  });

  test("27: exclusão de dia padrão mantém o snapshot de sempre (sem `canais_valores`)", async () => {
    montar({ lancamentos: [{ ...dia1(), estrutura_lancamento: "padrao", escopo_entregadores_lancamento: null }] });
    await svc.excluirLancamento({ ...ctx(), usuario: USUARIO, id: ID_D1, motivo: "teste de exclusão" });
    assert.equal("canais_valores" in banco.tabelas.lancamentos_financeiros_exclusoes[0].lancamento_snapshot, false);
  });

  test("28: reset de teste remove dias, canais e auditoria desses dias — sem órfãos", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    await criar(corpoDia2());
    const id2 = linhaDoDia("2026-09-02").id;
    await svc.executarResetTeste({ ...ctx(), data: "2026-09-01", usuario: USUARIO });
    assert.equal(banco.tabelas[TAB].filter((l) => l.unidade_id === UNI).length, 0);
    assert.equal((banco.tabelas[FILHOS] ?? []).filter((f) => [ID_D1, id2].includes(f.lancamento_id)).length, 0);
    assert.equal(banco.tabelas.lancamentos_financeiros_auditoria.filter((a) => [ID_D1, id2].includes(a.lancamento_id)).length, 0);
  });

  test("35: falha da RPC no meio — nenhuma linha consolidada, nenhum canal, nenhuma auditoria, nenhum Realtime", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    falharRpcDepoisDoPai = true;
    await assert.rejects(criar(corpoDia2()));
    assert.equal(linhaDoDia("2026-09-02"), undefined);
    assert.equal((banco.tabelas[FILHOS] ?? []).length, 2, "só os canais do dia 01");
    assert.equal((banco.tabelas.lancamentos_financeiros_auditoria ?? []).length, 0);
    assert.deepEqual(eventos, []);
  });
});

// ---------------------------------------------------------------------------
describe("30, 31 — GET mês", () => {
  test("30: unidade padrão — sem `composicaoCanais` (contrato inalterado)", async () => {
    montar({ lancamentos: [{ ...dia1(), unidade_id: UNI_P, estrutura_lancamento: "padrao", escopo_entregadores_lancamento: null }] });
    const r = await svc.obterMes({ ...ctx(UNI_P), mes: 9, ano: 2026 });
    assert.equal("composicaoCanais" in r, false);
    assert.equal(r.cards.faturamento.valor, 1100);
  });

  test("31: unidade multicanal — composição opcional fecha com os cards consolidados", async () => {
    montar({ lancamentos: [dia1()], valores: filhosDia1() });
    await criar(corpoDia2());
    const r = await svc.obterMes({ ...ctx(), mes: 9, ano: 2026 });
    const comp = r.composicaoCanais;
    assert.equal(comp.estruturaUnidade, "multicanal");
    assert.equal(comp.financeiro.disponivel, true);
    assert.equal(comp.financeiro.dataReferencia, "2026-09-02");
    const somaCanais = comp.financeiro.canais.reduce((s, c) => s + Math.round(c.valorVendasIfood * 100), 0) / 100;
    assert.equal(somaCanais, r.cards.faturamento.valor);
    assert.equal(comp.financeiro.compartilhado.taxasEntregadores, 120);
    const pctA = comp.financeiro.canais.find((c) => c.canalId === CA).participacaoVendasPct;
    assert.ok(Math.abs(pctA - (22914.53 / 26682.29) * 100) < 1e-9);
    assert.equal(comp.desempenho.total.ticketMedio, 26000 / 550);
    assert.deepEqual(comp.desempenho.canais.map((c) => c.nome), ["Canal A", "Canal B"]);
  });

  test("31: mês só com dias padrão numa unidade multicanal — composição indisponível com motivo", async () => {
    montar({ lancamentos: [{ ...dia1(), estrutura_lancamento: "padrao", escopo_entregadores_lancamento: null }] });
    const r = await svc.obterMes({ ...ctx(), mes: 9, ano: 2026 });
    assert.deepEqual(r.composicaoCanais.financeiro, { disponivel: false, motivo: "dia_sem_canais" });
  });
});
