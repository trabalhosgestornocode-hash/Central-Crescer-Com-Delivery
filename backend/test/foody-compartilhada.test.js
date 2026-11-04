// Conexão Foody COMPARTILHADA (migration 148): distribuição por operação, triagem estrita, isolamento multi-tenant, um uid ativo
// em um só tenant, fechamentos independentes e o serviço de aprovação dupla / decisão de triagem. Banco FALSO em memória e API
// FALSA: nenhuma rede, nenhum banco real, nenhum dado real (pedidos sintéticos).
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { criarRepositorioFoody } from "../src/modules/foody/foody.repository.js";
import { sincronizarCompetencia } from "../src/modules/foody/foody.sync.service.js";
import { gerarFechamentoLogistico, sincronizarEFechar } from "../src/modules/foody/foody.fechamento.service.js";
import { criarSegurancaFoody } from "../src/modules/foody/foody.seguranca.js";
import { prepararConexao } from "../src/modules/foody/foody.conexao.js";
import { criarClienteFoody } from "../src/modules/foody/foody.client.js";
import {
  proporDestino, aprovarDestino, revogarDestino, decidirTriagem, listarTriagem, atorDeAcesso, ehAdminDaOrganizacao,
} from "../src/modules/foody/foody.compartilhamento.service.js";
import { CATALOGO_OPERACAO } from "../src/modules/foody/foody.catalogo-operacao.js";
import { criarFakeDb } from "./helpers/fake-db-foody.js";
import { pedidoApi, ORG_A, UNI_A, ORG_B, UNI_B, SEGREDO_TESTE, TOKEN_TESTE } from "./helpers/foody-fixtures.js";

const ORG_C = "33333333-3333-4333-8333-333333333333"; // organização do Açaí (destino)
const UNI_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "2026-10-25";
const AGORA = () => new Date("2026-10-26T15:00:00Z");
const seguranca = criarSegurancaFoody(SEGREDO_TESTE);
const ENV = { FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_UNIDADES: UNI_A, FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED: "true", FOODY_CENTRAL_ADMIN_ENABLED: "true" };
const CX = `cx-${UNI_A}`;

const SUB = "1x Sub Frango Teriyaki 15cm";               // linha de catálogo Subway
const ACAI = "1x Açaí Premium 500ml";                    // termo validado do Açaí
const PALETA = "1x Paleta Morango";                      // catálogo Açaí (paletas são só do Açaí)
const DESCONHECIDO = "1x Produto Novo Misterioso";       // não está no catálogo nem tem termo

let db, repo, api;
function criarApi(lista) {
  const chamadas = [];
  return {
    lista, chamadas,
    criarCliente: ({ token }) => criarClienteFoody({
      token, esperar: async () => {},
      fetch: async (url, init) => {
        chamadas.push({ url, metodo: init.method });
        if (token !== TOKEN_TESTE) return { ok: false, status: 401, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => structuredClone(api.lista) };
      },
    }),
  };
}
const deps = (env = ENV) => ({ env, repo, seguranca, criarCliente: api.criarCliente, agora: AGORA, log: () => {} });
const sync = (env) => sincronizarCompetencia({ organizacaoId: ORG_A, unidadeId: UNI_A, competencia: D }, deps(env));
const pedidos = () => db.tabelas.foody_pedidos;
const ativos = (uid) => pedidos().filter((p) => p.foody_uid === uid && p.roteamento_ativo !== false);
const destino = (extra = {}) => ({ id: "dst-1", conexao_id: CX, organizacao_id: ORG_C, unidade_id: UNI_C, operacao: "acai_no_grau",
  estado: "ATIVO", organizacao_titular_id: ORG_A, aprovado_titular_por: "a", ...extra });

beforeEach(() => {
  db = criarFakeDb({ unidades: { [UNI_A]: ORG_A, [UNI_B]: ORG_B, [UNI_C]: ORG_C } });
  repo = criarRepositorioFoody(db);
  db.tabelas.foody_conexoes.push({ id: CX, ...prepararConexao({ organizacaoId: ORG_A, unidadeId: UNI_A, token: TOKEN_TESTE }, seguranca), status: "ATIVA" });
  db.tabelas.foody_conexao_destinos.push(destino());
  api = criarApi([
    pedidoApi({ uid: "s1", orderDetails: SUB, courierFee: 10, orderTotal: 40, date: `${D}T11:00:00-03:00` }),
    pedidoApi({ uid: "c1", orderDetails: ACAI, courierFee: 7, orderTotal: 30, date: `${D}T12:00:00-03:00` }),
    pedidoApi({ uid: "c2", orderDetails: PALETA, courierFee: 5, orderTotal: 12, date: `${D}T12:30:00-03:00` }),
    pedidoApi({ uid: "t1", orderDetails: `${SUB}\n${DESCONHECIDO}`, courierFee: 9, orderTotal: 55, date: `${D}T13:00:00-03:00` }),
  ]);
});

describe("distribuição por operação (destino ATIVO + flag)", () => {
  test("Subway na titular, Açaí no destino (dados completos), item desconhecido na TRIAGEM sem dado comercial", async () => {
    const r = await sync();
    const [s1] = ativos("s1"), [c1] = ativos("c1"), [c2] = ativos("c2"), [t1] = ativos("t1");
    assert.deepEqual([s1.unidade_id, s1.organizacao_id, s1.operacao, s1.destino_id], [UNI_A, ORG_A, "subway", null]);
    assert.equal(s1.valor_total, 40);
    for (const c of [c1, c2]) {
      assert.deepEqual([c.unidade_id, c.organizacao_id, c.operacao, c.destino_id], [UNI_C, ORG_C, "acai_no_grau", "dst-1"]);
      assert.ok(c.detalhes_pedido && c.valor_total != null, "o destino recebe o próprio pedido completo");
    }
    assert.deepEqual([t1.unidade_id, t1.operacao, t1.triagem_motivo, t1.destino_id], [UNI_A, "triagem", "ITEM_DESCONHECIDO", null]);
    assert.equal(t1.valor_total, null); assert.equal(t1.forma_pagamento, null); assert.equal(t1.taxa_entrega, null);
    assert.ok(t1.detalhes_pedido, "triagem guarda os itens para a decisão");
    assert.deepEqual(r.compartilhamento.distribuicao, { titular: 1, minimo: 0, triagem: 1, destinos: { acai_no_grau: 2 }, reclassificados: 0, decididosNaTriagem: 0 });
    assert.equal(r.compartilhamento.catalogoVersao, CATALOGO_OPERACAO.versao);
    assert.ok(r.cobertura.pendencias.some((p) => p.codigo === "TRIAGEM_PENDENTE" && p.quantidade === 1));
    const exec = db.tabelas.foody_sync_execucoes[0];
    assert.equal(exec.pedidos_triagem, 1); assert.equal(exec.catalogo_versao, CATALOGO_OPERACAO.versao);
    assert.equal(exec.unidade_id, UNI_A, "a execução é da titular");
  });
  test("AJUSTE OBRIGATÓRIO: item conhecido + item desconhecido nunca vai para a operação conhecida", async () => {
    api.lista = [
      pedidoApi({ uid: "x1", orderDetails: `${SUB}\n${DESCONHECIDO}`, date: `${D}T11:00:00-03:00` }),
      pedidoApi({ uid: "x2", orderDetails: `${ACAI}\n${DESCONHECIDO}`, date: `${D}T11:10:00-03:00` }),
      pedidoApi({ uid: "x3", orderDetails: `${SUB}\n${ACAI}`, date: `${D}T11:20:00-03:00` }),
      pedidoApi({ uid: "x4", orderDetails: "", date: `${D}T11:30:00-03:00` }),
    ];
    await sync();
    const motivos = ["x1", "x2", "x3", "x4"].map((u) => { const [p] = ativos(u); return [p.operacao, p.triagem_motivo, p.unidade_id]; });
    assert.deepEqual(motivos, [["triagem", "ITEM_DESCONHECIDO", UNI_A], ["triagem", "ITEM_DESCONHECIDO", UNI_A],
      ["triagem", "CONFLITO", UNI_A], ["triagem", "SEM_EVIDENCIA", UNI_A]]);
    assert.equal(pedidos().filter((p) => p.unidade_id === UNI_C).length, 0, "nada vai ao destino sem evidência segura");
  });
  test("o tenant titular nunca guarda dado comercial do Açaí; o destino nunca recebe pedido Subway", async () => {
    await sync();
    for (const p of pedidos().filter((x) => x.unidade_id === UNI_A)) {
      assert.notEqual(p.operacao, "acai_no_grau");
      if (p.operacao === "triagem") assert.equal(p.valor_total, null);
    }
    assert.ok(pedidos().filter((x) => x.unidade_id === UNI_C).every((p) => p.operacao === "acai_no_grau" && p.organizacao_id === ORG_C));
  });
  test("idempotente: 2ª sync igual não regrava nada", async () => {
    await sync();
    const ups = db.chamadas.filter((c) => c.op === "upsert").length;
    const r2 = await sync();
    assert.deepEqual([r2.contagens.inseridos, r2.contagens.atualizados, r2.contagens.inalterados], [0, 0, 4]);
    assert.equal(db.chamadas.filter((c) => c.op === "upsert").length, ups);
  });
  test("pedido que sumiu da API vira ausente em QUALQUER tenant da conexão (também no destino)", async () => {
    await sync();
    api.lista = api.lista.filter((o) => o.uid !== "c1");
    const r = await sync();
    assert.ok(r.cobertura.pendencias.some((p) => p.codigo === "PEDIDO_AUSENTE_NA_API" && p.quantidade === 1));
    assert.equal(r.cobertura.completa, false);
  });
});

describe("um pedido nunca ativo em dois tenants", () => {
  test("decisão de triagem move o pedido: a linha antiga é DESATIVADA (mínima) antes da nova ser gravada", async () => {
    await sync();
    db.tabelas.foody_triagem_decisoes.push({ id: "dec1", conexao_id: CX, organizacao_id: ORG_A, unidade_id: UNI_A, foody_uid: "t1",
      operacao_decidida: "acai_no_grau", decidido_por: "x", motivo: "conferido no Gestor", decidido_em: "2026-10-26T10:00:00Z" });
    const r = await sync();
    assert.equal(r.compartilhamento.distribuicao.reclassificados, 1);
    assert.equal(r.compartilhamento.distribuicao.decididosNaTriagem, 1);
    const linhas = pedidos().filter((p) => p.foody_uid === "t1");
    const antiga = linhas.find((p) => p.unidade_id === UNI_A), nova = linhas.find((p) => p.unidade_id === UNI_C);
    assert.equal(antiga.roteamento_ativo, false); assert.equal(antiga.roteamento_motivo, "RECLASSIFICADO");
    assert.equal(antiga.detalhes_pedido, null, "linha desativada sem dado comercial");
    assert.equal(nova.roteamento_ativo, true); assert.equal(nova.destino_id, "dst-1"); assert.equal(nova.organizacao_id, ORG_C);
    assert.equal(ativos("t1").length, 1);
    assert.ok(!r.cobertura.pendencias.some((p) => p.codigo === "TRIAGEM_PENDENTE"));
    // A ordem é sempre desativar → gravar (senão o índice global recusaria).
    const idxDesat = db.chamadas.findIndex((c) => c.tabela === "foody_pedidos" && c.op === "update" && c.valor?.roteamento_ativo === false);
    const idxGrav = db.chamadas.findLastIndex((c) => c.tabela === "foody_pedidos" && c.op === "upsert");
    assert.ok(idxDesat >= 0 && idxDesat < idxGrav);
  });
  test("a última decisão vale; voltar para Subway reativa a linha da titular e desativa a do destino", async () => {
    await sync();
    const dec = (id, op, em) => db.tabelas.foody_triagem_decisoes.push({ id, conexao_id: CX, organizacao_id: ORG_A, unidade_id: UNI_A,
      foody_uid: "t1", operacao_decidida: op, decidido_por: "x", motivo: "conferência", decidido_em: em });
    dec("d1", "acai_no_grau", "2026-10-26T10:00:00Z");
    await sync();
    dec("d2", "subway", "2026-10-26T11:00:00Z");
    await sync();
    const [a] = ativos("t1");
    assert.deepEqual([a.unidade_id, a.operacao, a.valor_total], [UNI_A, "subway", 55]);
    assert.equal(pedidos().find((p) => p.foody_uid === "t1" && p.unidade_id === UNI_C).roteamento_ativo, false);
  });
  test("o banco (fake do índice global) recusa um segundo uid ativo na conexão", async () => {
    await sync();
    db.tabelas.foody_pedidos.push({ ...ativos("s1")[0], id: "dup", unidade_id: UNI_C, organizacao_id: ORG_C });
    await assert.rejects(sync(), (e) => e.codigo === "INTEGRIDADE");
    assert.equal(ativos("s1").length, 2, "nada é desativado nem regravado quando a invariante já está quebrada");
  });
  test("destino REVOGADO: linhas do destino são desativadas e o Açaí volta à regra da 147 (mínimo na titular)", async () => {
    await sync();
    db.tabelas.foody_conexao_destinos[0].estado = "REVOGADO";
    const r = await sync();
    const [c1] = ativos("c1");
    assert.deepEqual([c1.unidade_id, c1.operacao, c1.detalhes_pedido, c1.valor_total, c1.destino_id], [UNI_A, "acai_no_grau", null, null, null]);
    assert.ok(pedidos().filter((p) => p.unidade_id === UNI_C).every((p) => p.roteamento_ativo === false && p.valor_total === null));
    assert.deepEqual(r.compartilhamento.destinos, []);
    assert.equal(r.compartilhamento.catalogoVersao, null, "sem destino ativo, a classificação volta a ser a do Parser");
  });
});

describe("isolamento e travas", () => {
  test("flag de compartilhamento DESLIGADA: destinos nem são lidos; comportamento idêntico à 147", async () => {
    const env = { ...ENV, FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED: "false" };
    const r = await sync(env);
    assert.equal(db.chamadas.filter((c) => c.tabela === "foody_conexao_destinos").length, 0);
    assert.equal(r.compartilhamento, undefined);
    assert.equal(pedidos().filter((p) => p.unidade_id === UNI_C).length, 0);
    const [c1] = ativos("c1");
    assert.deepEqual([c1.unidade_id, c1.detalhes_pedido, c1.valor_total], [UNI_A, null, null]);
    assert.equal(ativos("t1")[0].operacao, "subway", "sem compartilhamento vale a regra do Parser (paridade)");
  });
  test("destino de OUTRA conexão/titular devolvido pelo banco aborta antes da API", async () => {
    // Dois destinos ATIVOS para a mesma operação (o banco impede; a aplicação também recusa).
    db.tabelas.foody_conexao_destinos.push(destino({ id: "dst-x" }));
    await assert.rejects(sync(), (e) => e.codigo === "DESTINO_INVALIDO");
    db.tabelas.foody_conexao_destinos.splice(1);
    // Destino que a titular seria ela mesma.
    db.tabelas.foody_conexao_destinos[0].unidade_id = UNI_A; db.tabelas.foody_conexao_destinos[0].organizacao_id = ORG_A;
    await assert.rejects(sync(), (e) => e.codigo === "DESTINO_INVALIDO");
    const repoFalso = { ...repo, listarDestinosDaConexao: async () => [destino({ conexao_id: "cx-outra" })] };
    await assert.rejects(sincronizarCompetencia({ organizacaoId: ORG_A, unidadeId: UNI_A, competencia: D }, { ...deps(), repo: repoFalso }),
      (e) => e.codigo === "TENANT_DIVERGENTE");
    assert.equal(api.chamadas.length, 0);
  });
  test("linha da conexão em tenant NÃO autorizado (B) aborta a sincronização", async () => {
    await sync();
    const s1 = pedidos().find((p) => p.foody_uid === "s1");
    s1.unidade_id = UNI_B; s1.organizacao_id = ORG_B;
    await assert.rejects(sync(), (e) => e.codigo === "TENANT_DIVERGENTE");
  });
  test("a unidade de destino não sincroniza sozinha (fora da allowlist e sem conexão própria)", async () => {
    await assert.rejects(sincronizarCompetencia({ organizacaoId: ORG_C, unidadeId: UNI_C, competencia: D }, deps()), (e) => e.codigo === "DESLIGADO");
    const env = { ...ENV, FOODY_CENTRAL_UNIDADES: `${UNI_A},${UNI_C}` };
    await assert.rejects(sincronizarCompetencia({ organizacaoId: ORG_C, unidadeId: UNI_C, competencia: D }, deps(env)), (e) => e.codigo === "SEM_CONEXAO");
  });
});

describe("fechamentos logísticos independentes", () => {
  test("uma sync → um fechamento por organização, cada um só com a própria operação; triagem deixa os dois PROVISÓRIOS", async () => {
    const r = await sincronizarEFechar({ organizacaoId: ORG_A, unidadeId: UNI_A, competencia: D }, deps());
    const f = db.tabelas.foody_fechamentos_logisticos;
    assert.equal(f.length, 2);
    const fa = f.find((x) => x.unidade_id === UNI_A), fc = f.find((x) => x.unidade_id === UNI_C);
    assert.equal(fa.organizacao_id, ORG_A); assert.equal(fc.organizacao_id, ORG_C);
    assert.equal(fa.indicadores.operacao, "subway"); assert.equal(fc.indicadores.operacao, "acai_no_grau");
    assert.equal(fa.indicadores.subway.pedidos, 1); assert.equal(fa.indicadores.subway.custoLogisticoProprio, 10);
    assert.equal(fc.indicadores.acai_no_grau.pedidos, 2); assert.equal(fc.indicadores.acai_no_grau.custoLogisticoProprio, 12);
    assert.equal(fa.indicadores.acai_no_grau, undefined); assert.equal(fc.indicadores.subway, undefined);
    assert.deepEqual(fa.outras_operacoes, {}, "nenhum Açaí no fechamento da Subway");
    assert.equal(fa.indicadores.triagem.pedidosNesteTenant, 1); assert.equal(fa.indicadores.triagem.somadoAoCustoDaUnidade, false);
    for (const x of [fa, fc]) {
      assert.equal(x.estado_valores, "PROVISORIO");
      assert.ok(x.pendencias.some((p) => p.codigo === "TRIAGEM_PENDENTE"));
      assert.equal(x.sync_execucao_id, r.sync.execucaoId);
    }
    assert.notEqual(fa.execucao_id, fc.execucao_id);
    assert.deepEqual(r.fechamentosDestino.map((x) => [x.unidadeId, x.resultado]), [[UNI_C, "REGISTRADO"]]);
  });
  test("decidida a triagem, os dois fecham SINCRONIZADO e a taxa do pedido decidido vai só para quem ficou com ele", async () => {
    await sincronizarEFechar({ organizacaoId: ORG_A, unidadeId: UNI_A, competencia: D }, deps());
    db.tabelas.foody_triagem_decisoes.push({ id: "d1", conexao_id: CX, organizacao_id: ORG_A, unidade_id: UNI_A, foody_uid: "t1",
      operacao_decidida: "subway", decidido_por: "x", motivo: "conferido", decidido_em: "2026-10-26T12:00:00Z" });
    await sincronizarEFechar({ organizacaoId: ORG_A, unidadeId: UNI_A, competencia: D }, deps());
    const ult = (u) => db.tabelas.foody_fechamentos_logisticos.filter((x) => x.unidade_id === u).sort((a, b) => b.versao - a.versao)[0];
    assert.equal(ult(UNI_A).estado_valores, "SINCRONIZADO"); assert.equal(ult(UNI_C).estado_valores, "SINCRONIZADO");
    assert.equal(ult(UNI_A).indicadores.subway.custoLogisticoProprio, 19);
    assert.equal(ult(UNI_C).indicadores.acai_no_grau.custoLogisticoProprio, 12);
  });
  test("fechamento do destino recusado sem a sync da titular que o traga como destino ativo", async () => {
    const s = await sync();
    await assert.rejects(gerarFechamentoLogistico({ organizacaoId: ORG_C, unidadeId: UNI_C, competencia: D, sync: { ...s, compartilhamento: undefined } }, deps()),
      (e) => e.codigo === "DESLIGADO");
    await assert.rejects(gerarFechamentoLogistico({ organizacaoId: ORG_B, unidadeId: UNI_C, competencia: D, sync: s }, deps()), (e) => e.codigo === "DESLIGADO");
    const off = { ...ENV, FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED: "false" };
    await assert.rejects(gerarFechamentoLogistico({ organizacaoId: ORG_C, unidadeId: UNI_C, competencia: D, sync: s }, deps(off)), (e) => e.codigo === "DESLIGADO");
  });
  test("erro no fechamento do destino não impede o da titular", async () => {
    const repoFalho = { ...repo, registrarFechamento: async (t, p) => {
      if (t.unidadeId === UNI_C) { const e = new Error("x"); e.codigo = "BANCO"; throw e; }
      return repo.registrarFechamento(t, p);
    } };
    const r = await sincronizarEFechar({ organizacaoId: ORG_A, unidadeId: UNI_A, competencia: D }, { ...deps(), repo: repoFalho });
    assert.equal(r.fechamento.resultado, "REGISTRADO");
    assert.deepEqual(r.fechamentosDestino, [{ unidadeId: UNI_C, operacao: "acai_no_grau", erro: "BANCO" }]);
  });
});

describe("aprovação dupla e decisões de triagem (serviço)", () => {
  const PERFIL_T = "a1000000-0000-4000-8000-000000000001", PERFIL_C = "c1000000-0000-4000-8000-000000000003";
  const admT = { perfilId: PERFIL_T, papel: "organization_admin", impersonando: false, organizacaoId: ORG_A };
  const admC = { perfilId: PERFIL_C, papel: "organization_admin", impersonando: false, organizacaoId: ORG_C };
  const svc = (env = ENV) => ({ env, repo, agora: AGORA });
  beforeEach(() => { db.tabelas.foody_conexao_destinos.splice(0); });

  test("ator: impersonação, outro papel ou outra organização NÃO contam como admin", () => {
    assert.ok(ehAdminDaOrganizacao(admT, ORG_A));
    assert.ok(!ehAdminDaOrganizacao({ ...admT, impersonando: true }, ORG_A));
    assert.ok(!ehAdminDaOrganizacao({ ...admT, papel: "operations" }, ORG_A));
    assert.ok(!ehAdminDaOrganizacao(admT, ORG_C));
    assert.deepEqual(atorDeAcesso({ perfilId: PERFIL_T, papel: "organization_admin", impersonando: true, empresa: { id: ORG_A } }),
      { perfilId: PERFIL_T, papel: "organization_admin", impersonando: true, organizacaoId: ORG_A });
  });
  test("propor (admin da titular) → PENDENTE com a aprovação da titular; aprovar (admin do destino) → ATIVO", async () => {
    await assert.rejects(proporDestino({ ator: admC, conexaoId: CX, destino: { organizacaoId: ORG_C, unidadeId: UNI_C, operacao: "acai_no_grau" } }, svc()),
      (e) => e.codigo === "SEM_PERMISSAO");
    await assert.rejects(proporDestino({ ator: { ...admT, impersonando: true }, conexaoId: CX, destino: { organizacaoId: ORG_C, unidadeId: UNI_C, operacao: "acai_no_grau" } }, svc()),
      (e) => e.codigo === "SEM_PERMISSAO");
    await assert.rejects(proporDestino({ ator: admT, conexaoId: CX, destino: { organizacaoId: ORG_C, unidadeId: UNI_C, operacao: "subway" } }, svc()),
      (e) => e.codigo === "OPERACAO_INVALIDA");
    await assert.rejects(proporDestino({ ator: admT, conexaoId: CX, destino: { organizacaoId: ORG_A, unidadeId: UNI_A, operacao: "acai_no_grau" } }, svc()),
      (e) => e.codigo === "DESTINO_INVALIDO");
    await assert.rejects(proporDestino({ ator: admT, conexaoId: CX, destino: { organizacaoId: ORG_C, unidadeId: UNI_C, operacao: "acai_no_grau" } },
      svc({ ...ENV, FOODY_CENTRAL_ADMIN_ENABLED: "" })), (e) => e.codigo === "DESLIGADO");
    // Administração e sincronização são SEPARADAS: com a sync inteira desligada, a administração continua (e não coleta nada).
    const soAdmin = { FOODY_CENTRAL_ADMIN_ENABLED: "true" };
    await assert.rejects(proporDestino({ ator: admT, conexaoId: CX, destino: { organizacaoId: ORG_C, unidadeId: UNI_C, operacao: "subway" } }, svc(soAdmin)),
      (e) => e.codigo === "OPERACAO_INVALIDA", "passa da flag com só a administração ligada");
    const p = await proporDestino({ ator: admT, conexaoId: CX, destino: { organizacaoId: ORG_C, unidadeId: UNI_C, operacao: "acai_no_grau" } }, svc());
    const d = db.tabelas.foody_conexao_destinos[0];
    assert.deepEqual([p.estado, d.estado, d.aprovado_titular_por, d.aprovado_destino_por ?? null, d.organizacao_titular_id], ["PENDENTE", "PENDENTE", PERFIL_T, null, ORG_A]);
    await assert.rejects(aprovarDestino({ ator: admT, destinoId: d.id }, svc()), (e) => e.codigo === "SEM_PERMISSAO", "a titular não aprova pelo destino");
    await assert.rejects(aprovarDestino({ ator: { ...admC, impersonando: true }, destinoId: d.id }, svc()), (e) => e.codigo === "SEM_PERMISSAO");
    const a = await aprovarDestino({ ator: admC, destinoId: d.id }, svc());
    assert.equal(a.estado, "ATIVO"); assert.equal(d.aprovado_destino_por, PERFIL_C);
    await assert.rejects(aprovarDestino({ ator: admC, destinoId: d.id }, svc()), (e) => e.codigo === "ESTADO_INVALIDO");
  });
  test("aprovar exige conexão ATIVA; revogar: qualquer uma das duas, com motivo, e é definitivo", async () => {
    await proporDestino({ ator: admT, conexaoId: CX, destino: { organizacaoId: ORG_C, unidadeId: UNI_C, operacao: "acai_no_grau" } }, svc());
    const d = db.tabelas.foody_conexao_destinos[0];
    db.tabelas.foody_conexoes[0].status = "PAUSADA";
    await assert.rejects(aprovarDestino({ ator: admC, destinoId: d.id }, svc()), (e) => e.codigo === "CONEXAO_INATIVA");
    db.tabelas.foody_conexoes[0].status = "ATIVA";
    await aprovarDestino({ ator: admC, destinoId: d.id }, svc());
    const outro = { ...admT, organizacaoId: ORG_B };
    await assert.rejects(revogarDestino({ ator: outro, destinoId: d.id, motivo: "encerrado" }, svc()), (e) => e.codigo === "SEM_PERMISSAO");
    await assert.rejects(revogarDestino({ ator: admC, destinoId: d.id, motivo: "x" }, svc()), (e) => e.codigo === "MOTIVO_INVALIDO");
    const r = await revogarDestino({ ator: admC, destinoId: d.id, motivo: "fim da parceria" }, svc({}));
    assert.equal(r.estado, "REVOGADO"); assert.equal(d.revogado_por, PERFIL_C);
    await assert.rejects(revogarDestino({ ator: admT, destinoId: d.id, motivo: "de novo" }, svc()), (e) => e.codigo === "ESTADO_INVALIDO");
  });
  test("triagem: admin de qualquer organização do vínculo decide; pedido já atribuído só pela organização que o detém", async () => {
    db.tabelas.foody_conexao_destinos.push(destino());
    await sync();
    const lista = await listarTriagem({ ator: admC, conexaoId: CX, competencia: D }, svc());
    assert.deepEqual(lista.map((x) => x.foodyUid), ["t1"]);
    assert.ok(lista.every((x) => !("valor_total" in x) && !("forma_pagamento" in x) && !("valorTotal" in x)));
    await assert.rejects(listarTriagem({ ator: { ...admT, organizacaoId: ORG_B }, conexaoId: CX, competencia: D }, svc()), (e) => e.codigo === "SEM_PERMISSAO");
    // Destino puxando para si um pedido Subway: recusado.
    await assert.rejects(decidirTriagem({ ator: admC, conexaoId: CX, foodyUid: "s1", operacao: "acai_no_grau", motivo: "é nosso" }, svc()),
      (e) => e.codigo === "SEM_PERMISSAO");
    // Titular puxando um pedido do Açaí: recusado.
    await assert.rejects(decidirTriagem({ ator: admT, conexaoId: CX, foodyUid: "c1", operacao: "subway", motivo: "é nosso" }, svc()),
      (e) => e.codigo === "SEM_PERMISSAO");
    await assert.rejects(decidirTriagem({ ator: { ...admC, impersonando: true }, conexaoId: CX, foodyUid: "t1", operacao: "acai_no_grau", motivo: "ok ok" }, svc()),
      (e) => e.codigo === "SEM_PERMISSAO");
    await assert.rejects(decidirTriagem({ ator: admC, conexaoId: CX, foodyUid: "t1", operacao: "triagem", motivo: "ok ok" }, svc()), (e) => e.codigo === "OPERACAO_INVALIDA");
    await assert.rejects(decidirTriagem({ ator: admC, conexaoId: CX, foodyUid: "nao-existe", operacao: "subway", motivo: "ok ok" }, svc()), (e) => e.codigo === "SEM_PEDIDO");
    // O detentor pode soltar o próprio pedido; triagem pode ser decidida por qualquer um dos dois admins.
    await decidirTriagem({ ator: admC, conexaoId: CX, foodyUid: "c1", operacao: "subway", motivo: "era da Subway" }, svc());
    await decidirTriagem({ ator: admT, conexaoId: CX, foodyUid: "t1", operacao: "subway", motivo: "conferido no Gestor" }, svc());
    const decs = db.tabelas.foody_triagem_decisoes;
    assert.equal(decs.length, 2);
    assert.ok(decs.every((x) => x.organizacao_id === ORG_A && x.unidade_id === UNI_A && x.catalogo_versao === CATALOGO_OPERACAO.versao));
    assert.deepEqual(decs.map((x) => x.decidido_por), [PERFIL_C, PERFIL_T]);
  });
});
