// Camada central Foody — sincronização, isolamento multi-tenant, deduplicação/idempotência, versionamento do fechamento e
// agendador. Banco FALSO em memória (helpers/fake-db-foody.js) e API FALSA: nenhuma rede, nenhum banco real.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { criarRepositorioFoody } from "../src/modules/foody/foody.repository.js";
import { sincronizarCompetencia } from "../src/modules/foody/foody.sync.service.js";
import { gerarFechamentoLogistico, sincronizarEFechar } from "../src/modules/foody/foody.fechamento.service.js";
import { criarAgendadorFoody, executarCicloFoody } from "../src/modules/foody/foody.agendador.js";
import { criarSegurancaFoody, foodyLog } from "../src/modules/foody/foody.seguranca.js";
import { prepararConexao } from "../src/modules/foody/foody.conexao.js";
import { criarClienteFoody } from "../src/modules/foody/foody.client.js";
import { criarFakeDb } from "./helpers/fake-db-foody.js";
import { pedidoApi, ORG_A, UNI_A, ORG_B, UNI_B, SEGREDO_TESTE, TOKEN_TESTE } from "./helpers/foody-fixtures.js";

const D = "2026-10-25";
const AGORA = () => new Date("2026-10-26T15:00:00Z");
const seguranca = criarSegurancaFoody(SEGREDO_TESTE);
const ENV = { FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_UNIDADES: `${UNI_A},${UNI_B}` };
const TOKEN_B = "tok_TESTE_unidade_B_9876543210";

let db, repo, api, logs;
/** API falsa: por token, devolve a lista do dia; registra cada chamada. */
function criarApi() {
  const dados = new Map([[TOKEN_TESTE, []], [TOKEN_B, []]]);
  const chamadas = [];
  return {
    dados, chamadas,
    criarCliente: ({ token }) => criarClienteFoody({
      token, esperar: async () => {},
      fetch: async (url, init) => {
        chamadas.push({ url, metodo: init.method, token: init.headers.Authorization });
        if (!dados.has(token)) return { ok: false, status: 401, json: async () => ({}) };
        const lista = dados.get(token);
        if (lista instanceof Error) throw lista;
        return { ok: true, status: 200, json: async () => structuredClone(lista) };
      },
    }),
  };
}
function semear(unidadeId, organizacaoId, token, extra = {}) {
  db.tabelas.foody_conexoes.push({ id: `cx-${unidadeId}`, ...prepararConexao({ organizacaoId, unidadeId, token, pontoColetaEsperado: "Subway Saci" }, seguranca), status: "ATIVA", ...extra });
}
const deps = () => ({ env: ENV, repo, seguranca, criarCliente: api.criarCliente, agora: AGORA, log: (n, e, d, o = {}) => foodyLog(n, e, d, { ...o, saida: (l) => logs.push(l) }) });
const sync = (p = {}) => sincronizarCompetencia({ organizacaoId: ORG_A, unidadeId: UNI_A, competencia: D, ...p }, deps());

beforeEach(() => {
  db = criarFakeDb({ unidades: { [UNI_A]: ORG_A, [UNI_B]: ORG_B } });
  repo = criarRepositorioFoody(db);
  api = criarApi();
  logs = [];
  semear(UNI_A, ORG_A, TOKEN_TESTE);
  semear(UNI_B, ORG_B, TOKEN_B);
  api.dados.set(TOKEN_TESTE, [
    pedidoApi({ uid: "a1", entregador: "A", courierFee: 10, date: `${D}T11:00:00-03:00` }),
    pedidoApi({ uid: "a2", entregador: "A", courierFee: 12, date: `${D}T12:00:00-03:00` }),
    pedidoApi({ uid: "a3", entregador: "B", courierFee: 10, orderDetails: "Açaí Premium", date: `${D}T13:00:00-03:00` }),
  ]);
  api.dados.set(TOKEN_B, [pedidoApi({ uid: "b1", entregador: "Z", courierFee: 20, date: `${D}T10:00:00-03:00` })]);
});

describe("travas antes de qualquer chamada à API", () => {
  test("flag desligada / unidade fora da allowlist: nada é lido nem gravado", async () => {
    for (const env of [{}, { FOODY_CENTRAL_ENABLED: "true" }, { FOODY_CENTRAL_ENABLED: "false", FOODY_CENTRAL_UNIDADES: UNI_A }]) {
      await assert.rejects(sincronizarCompetencia({ organizacaoId: ORG_A, unidadeId: UNI_A, competencia: D }, { ...deps(), env }), (e) => e.codigo === "DESLIGADO");
    }
    assert.equal(api.chamadas.length, 0); assert.equal(db.chamadas.length, 0);
  });
  test("dia aberto recusado; dia congelado só com reprocessamento + motivo", async () => {
    await assert.rejects(sync({ competencia: "2026-10-26" }), (e) => e.codigo === "COMPETENCIA_ABERTA");
    await assert.rejects(sync({ competencia: "2026-10-20" }), (e) => e.codigo === "COMPETENCIA_CONGELADA");
    await assert.rejects(sync({ competencia: "2026-10-20", origem: "reprocessamento" }), (e) => e.codigo === "COMPETENCIA_CONGELADA");
    api.dados.set(TOKEN_TESTE, []);
    const r = await sync({ competencia: "2026-10-20", origem: "reprocessamento", motivo: "conferência do gestor" });
    assert.equal(r.contagens.unicos, 0);
  });
  test("conexão pausada, ausente ou com token trocado: recusa sem chamar a API", async () => {
    db.tabelas.foody_conexoes[0].status = "PAUSADA";
    await assert.rejects(sync(), (e) => e.codigo === "CONEXAO_INATIVA");
    db.tabelas.foody_conexoes[0].status = "ATIVA";
    db.tabelas.foody_conexoes[0].token_impressao = "000000000000";
    await assert.rejects(sync(), (e) => e.codigo === "TOKEN_DIVERGENTE");
    db.tabelas.foody_conexoes.splice(0, 1);
    await assert.rejects(sync(), (e) => e.codigo === "SEM_CONEXAO");
    assert.equal(api.chamadas.length, 0);
  });
});

describe("isolamento multi-tenant", () => {
  test("token cifrado de B copiado para a conexão de A não decifra (AAD da unidade)", async () => {
    db.tabelas.foody_conexoes[0].token_cifrado = db.tabelas.foody_conexoes[1].token_cifrado;
    await assert.rejects(sync(), (e) => e.codigo === "TOKEN_INVALIDO");
    assert.equal(api.chamadas.length, 0);
  });
  test("organização errada para a unidade não encontra conexão (filtro por org E unidade)", async () => {
    await assert.rejects(sincronizarCompetencia({ organizacaoId: ORG_B, unidadeId: UNI_A, competencia: D }, deps()), (e) => e.codigo === "SEM_CONEXAO");
    assert.equal(api.chamadas.length, 0);
  });
  test("cada unidade usa o PRÓPRIO token e grava só no próprio tenant", async () => {
    await sync();
    await sincronizarCompetencia({ organizacaoId: ORG_B, unidadeId: UNI_B, competencia: D }, deps());
    assert.deepEqual(api.chamadas.map((c) => c.token), [TOKEN_TESTE, TOKEN_B]);
    const p = db.tabelas.foody_pedidos;
    assert.deepEqual(p.filter((x) => x.unidade_id === UNI_A).map((x) => x.foody_uid).sort(), ["a1", "a2", "a3"]);
    assert.deepEqual(p.filter((x) => x.unidade_id === UNI_B).map((x) => x.foody_uid), ["b1"]);
    assert.ok(p.every((x) => (x.unidade_id === UNI_A ? x.organizacao_id === ORG_A : x.organizacao_id === ORG_B)));
    // Toda consulta do repositório filtrou por organizacao_id E unidade_id
    for (const c of db.chamadas.filter((c) => c.tabela && c.op !== "insert" && c.op !== "upsert")) {
      const ks = c.filtros.map(([, k]) => k);
      assert.ok(ks.includes("organizacao_id") && ks.includes("unidade_id"), `${c.tabela}/${c.op} sem filtro de tenant`);
    }
  });
  test("pedido de Açaí da conta Subway fica na unidade Subway, marcado como outra operação — nunca vai a outro tenant", async () => {
    await sync();
    const acai = db.tabelas.foody_pedidos.find((x) => x.foody_uid === "a3");
    assert.equal(acai.operacao, "acai_no_grau"); assert.equal(acai.unidade_id, UNI_A); assert.equal(acai.organizacao_id, ORG_A);
  });
  test("pedido de outro ponto de coleta não é gravado, mas NUNCA em silêncio: cobertura incompleta e fechamento INCOMPLETO", async () => {
    api.dados.get(TOKEN_TESTE).push(pedidoApi({ uid: "x9", entregador: "A", pontoColeta: "Outra Loja", date: `${D}T20:00:00-03:00` }));
    const r = await sync();
    assert.equal(r.contagens.pontoDivergente, 1);
    assert.ok(!db.tabelas.foody_pedidos.some((x) => x.foody_uid === "x9"));
    assert.deepEqual(r.cobertura.pendencias.find((p) => p.codigo === "PONTO_COLETA_DIVERGENTE"), { codigo: "PONTO_COLETA_DIVERGENTE", quantidade: 1, pontosVistos: ["Outra Loja"] });
    assert.equal(r.cobertura.completa, false);
    assert.equal(db.tabelas.foody_sync_execucoes.at(-1).pedidos_ponto_divergente, 1);
    const f = await gerarFechamentoLogistico({ organizacaoId: ORG_A, unidadeId: UNI_A, competencia: D, sync: r }, deps());
    assert.equal(f.status, "INCOMPLETO"); assert.equal(f.estadoValores, "PROVISORIO");
    assert.ok(f.pendencias.some((p) => p.codigo === "PONTO_COLETA_DIVERGENTE"));
  });
  test("ponto de coleta compara sem caixa/acento/espaço; renomeação cosmética não perde pedido", async () => {
    api.dados.get(TOKEN_TESTE).push(pedidoApi({ uid: "x8", entregador: "A", pontoColeta: "  SUBWAY   saci ", date: `${D}T20:00:00-03:00` }));
    const r = await sync();
    assert.equal(r.contagens.pontoDivergente, 0); assert.equal(r.cobertura.completa, true);
    assert.ok(db.tabelas.foody_pedidos.some((x) => x.foody_uid === "x8"));
  });
  test("sem ponto de coleta esperado na conexão (padrão): nenhum filtro, todo pedido da conta é da unidade", async () => {
    db.tabelas.foody_conexoes[0].ponto_coleta_esperado = null;
    api.dados.get(TOKEN_TESTE).push(pedidoApi({ uid: "x7", entregador: "A", pontoColeta: "Outra Loja", date: `${D}T20:00:00-03:00` }));
    const r = await sync();
    assert.equal(r.contagens.pontoDivergente, 0);
    assert.ok(db.tabelas.foody_pedidos.some((x) => x.foody_uid === "x7"));
  });
  test("o repositório recusa linha com tenant diferente do contexto", async () => {
    await assert.rejects(repo.gravarPedidos({ organizacaoId: ORG_A, unidadeId: UNI_A }, [{ organizacao_id: ORG_B, unidade_id: UNI_B, foody_uid: "z" }]), (e) => e.codigo === "TENANT_DIVERGENTE");
    await assert.rejects(repo.obterConexao({ organizacaoId: ORG_A }), (e) => e.codigo === "TENANT_AUSENTE");
  });
  test("o banco (fake das triggers) recusa unidade de outra organização", async () => {
    await assert.rejects(repo.abrirExecucao({ organizacaoId: ORG_A, unidadeId: UNI_B }, { conexao_id: "x", competencia: D }), /não pertence/);
  });
});

describe("deduplicação e idempotência", () => {
  test("1ª execução insere; 2ª igual não regrava nada; mudança na API atualiza só o pedido mudado", async () => {
    const r1 = await sync();
    assert.deepEqual([r1.contagens.inseridos, r1.contagens.atualizados, r1.contagens.inalterados], [3, 0, 0]);
    const upserts1 = db.chamadas.filter((c) => c.op === "upsert").length;
    const r2 = await sync();
    assert.deepEqual([r2.contagens.inseridos, r2.contagens.atualizados, r2.contagens.inalterados], [0, 0, 3]);
    assert.equal(db.chamadas.filter((c) => c.op === "upsert").length, upserts1, "sem upsert quando nada mudou");
    api.dados.get(TOKEN_TESTE)[0].courierFee = 11;
    const r3 = await sync();
    assert.deepEqual([r3.contagens.inseridos, r3.contagens.atualizados, r3.contagens.inalterados], [0, 1, 2]);
    const a1 = db.tabelas.foody_pedidos.find((x) => x.foody_uid === "a1");
    assert.equal(a1.taxa_entregador, 11); assert.equal(a1.primeira_execucao_id, r1.execucaoId); assert.equal(a1.ultima_execucao_id, r3.execucaoId);
    assert.equal(db.tabelas.foody_pedidos.length, 3);
  });
  test("uid repetido na mesma resposta (fronteira de página) conta uma vez", async () => {
    const l = api.dados.get(TOKEN_TESTE); l.push(structuredClone(l[0]));
    const r = await sync();
    assert.equal(r.contagens.recebidos, 4); assert.equal(r.contagens.unicos, 3); assert.equal(db.tabelas.foody_pedidos.length, 3);
  });
  test("pedido que sumiu da API NÃO é apagado: vira pendência PEDIDO_AUSENTE_NA_API", async () => {
    await sync();
    api.dados.get(TOKEN_TESTE).pop();
    const r = await sync();
    assert.equal(db.tabelas.foody_pedidos.length, 3);
    assert.deepEqual(r.cobertura.pendencias.find((p) => p.codigo === "PEDIDO_AUSENTE_NA_API"), { codigo: "PEDIDO_AUSENTE_NA_API", quantidade: 1 });
  });
  test("pedido malformado: cobertura incompleta, demais pedidos gravados", async () => {
    api.dados.get(TOKEN_TESTE).push({ uid: "sem-data", id: "1" });
    const r = await sync();
    assert.equal(r.cobertura.completa, false); assert.equal(db.tabelas.foody_pedidos.length, 3);
  });
  test("falha da API: execução FALHOU com código, conexão marcada, erro e logs sem token", async () => {
    api.dados.set(TOKEN_TESTE, new Error(`ECONNRESET ${TOKEN_TESTE}`));
    await assert.rejects(sync(), (e) => e.codigo === "REDE" && !e.message.includes(TOKEN_TESTE));
    const ex = db.tabelas.foody_sync_execucoes.at(-1);
    assert.equal(ex.status, "FALHOU"); assert.equal(ex.erro_codigo, "REDE");
    assert.equal(db.tabelas.foody_conexoes[0].ultimo_erro_codigo, "REDE");
    assert.ok(logs.every((l) => !l.includes(TOKEN_TESTE)));
  });
  test("nada gravado contém o token nem dado pessoal", async () => {
    await sync();
    const tudo = JSON.stringify({ p: db.tabelas.foody_pedidos, e: db.tabelas.foody_sync_execucoes });
    for (const x of [TOKEN_TESTE, "Cliente Fictício", "98888", "90000", "Interfone", "exemplo.invalid", "Entregador Ficticio"]) assert.ok(!tudo.includes(x), x);
  });
});

describe("fechamento logístico versionado", () => {
  const fechar = async (p = {}) => {
    const s = await sync(p);
    return gerarFechamentoLogistico({ organizacaoId: ORG_A, unidadeId: UNI_A, competencia: D, sync: s, ...p }, deps());
  };
  test("REGISTRADO → SEM_MUDANCA → CORRIGIDO (com motivo) quando a API muda", async () => {
    const f1 = await fechar();
    assert.equal(f1.resultado, "REGISTRADO"); assert.equal(f1.versao, 1); assert.equal(f1.status, "CONSOLIDADO");
    const f2 = await fechar();
    assert.equal(f2.resultado, "SEM_MUDANCA"); assert.equal(f2.versao, 1);
    api.dados.get(TOKEN_TESTE)[1].courierFee = 15;
    const f3 = await fechar();
    assert.equal(f3.resultado, "REGISTRADO"); assert.equal(f3.versao, 2); assert.equal(f3.status, "CORRIGIDO");
    const linhas = db.tabelas.foody_fechamentos_logisticos;
    assert.equal(linhas.length, 2); assert.ok(linhas[1].motivo); assert.equal(linhas[1].substitui_id, linhas[0].id);
    assert.equal(linhas[1].sync_execucao_id, db.tabelas.foody_sync_execucoes.at(-1).id);
  });
  test("Açaí no bloco outras_operacoes, fora do custo da Subway", async () => {
    const f = await fechar();
    assert.equal(f.indicadores.subway.custoLogisticoProprio, 22);
    assert.equal(f.outrasOperacoes.acai_no_grau.taxasIdentificadas, 10);
    assert.equal(f.outrasOperacoes.acai_no_grau.somadoAoCustoDaUnidade, false);
  });
  test("fechamento exige a sync da MESMA competência e flag ligada", async () => {
    const s = await sync();
    await assert.rejects(gerarFechamentoLogistico({ organizacaoId: ORG_A, unidadeId: UNI_A, competencia: "2026-10-24", sync: s }, deps()), (e) => e.codigo === "SEM_SYNC");
    await assert.rejects(gerarFechamentoLogistico({ organizacaoId: ORG_A, unidadeId: UNI_A, competencia: D, sync: s }, { ...deps(), env: {} }), (e) => e.codigo === "DESLIGADO");
  });
  test("fechamento de A não enxerga pedidos de B", async () => {
    await sincronizarCompetencia({ organizacaoId: ORG_B, unidadeId: UNI_B, competencia: D }, deps());
    const f = await fechar();
    assert.equal(f.indicadores.pedidosNaConta, 3);
  });
});

describe("agendador (fail-closed, não ligado ao servidor)", () => {
  test("iniciar() recusa sem as duas flags e a allowlist", () => {
    for (const env of [{}, ENV, { ...ENV, FOODY_CENTRAL_AGENDADOR_ENABLED: "true", FOODY_CENTRAL_UNIDADES: "" }]) {
      const a = criarAgendadorFoody({ unidades: [], env, temporizador: { set: () => 1, clear: () => {} } });
      assert.throws(() => a.iniciar(), (e) => e.codigo === "AGENDAMENTO_NAO_PERMITIDO");
      assert.equal(a.ativo, false);
    }
  });
  test("ciclo: D-1..D-3 por unidade; unidade fora da allowlist ignorada; erro de uma não para a outra", async () => {
    const vistos = [];
    const executar = async (p) => {
      vistos.push(`${p.unidadeId.slice(0, 4)}:${p.competencia}:${p.origem}`);
      if (p.unidadeId === UNI_B) { const e = new Error("x"); e.codigo = "AUTENTICACAO"; throw e; }
      return { fechamento: { resultado: "REGISTRADO", status: "CONSOLIDADO", versao: 1 } };
    };
    const env = { ...ENV, FOODY_CENTRAL_AGENDADOR_ENABLED: "true" };
    const r = await executarCicloFoody({ unidades: [{ organizacaoId: ORG_B, unidadeId: UNI_B }, { organizacaoId: ORG_A, unidadeId: UNI_A }, { organizacaoId: ORG_A, unidadeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }], env, agora: AGORA, executar });
    assert.deepEqual(vistos, [`bbbb:2026-10-25:agendado`, `aaaa:2026-10-25:agendado`, `aaaa:2026-10-24:agendado`, `aaaa:2026-10-23:agendado`]);
    assert.equal(r.filter((x) => x.erro === "AUTENTICACAO").length, 1, "AUTENTICACAO interrompe só os dias da própria unidade");
    assert.equal(r.at(-1).erro, "FORA_DA_ALLOWLIST");
  });
  test("ciclo real ponta a ponta (fake): sincroniza e fecha 3 dias da unidade A", async () => {
    const env = { ...ENV, FOODY_CENTRAL_AGENDADOR_ENABLED: "true" };
    const r = await executarCicloFoody({ unidades: [{ organizacaoId: ORG_A, unidadeId: UNI_A }], env, agora: AGORA, executar: sincronizarEFechar, deps: { ...deps(), env } });
    assert.deepEqual(r.map((x) => x.resultado), ["REGISTRADO", "REGISTRADO", "REGISTRADO"]);
    assert.equal(db.tabelas.foody_fechamentos_logisticos.length, 3);
    assert.ok(api.chamadas.every((c) => c.metodo === "GET"));
  });
  test("flag desligada durante a execução: o agendador para sozinho", async () => {
    const env = { ...ENV, FOODY_CENTRAL_AGENDADOR_ENABLED: "true" };
    let agendado = null;
    const a = criarAgendadorFoody({ unidades: [], env, executar: async () => ({}), temporizador: { set: (f) => { agendado = f; return 1; }, clear: () => {} } });
    a.iniciar(); assert.equal(a.ativo, true);
    env.FOODY_CENTRAL_ENABLED = "false";
    await agendado();
    assert.equal(a.ativo, false);
  });
});
