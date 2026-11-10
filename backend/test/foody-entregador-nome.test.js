// Nome do entregador (flag FOODY_CENTRAL_ENTREGADOR_NOME_ENABLED + migration 160). Banco e API FALSOS: nenhuma rede.
// Prova: desligada = idêntico ao anterior (sem coluna, mesmo hash); ligada = nome guardado; reprocessar preenche o nome
// SEM duplicar; nome nunca em logs nem na resposta da sincronização; o Parser mostra o nome.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sanearPedidoApi, hashConteudoPedido } from "../src/modules/foody/foody.adapter.js";
import { entregadorNomePermitido } from "../src/modules/foody/foody.flags.js";
import { criarRepositorioFoody } from "../src/modules/foody/foody.repository.js";
import { sincronizarCompetencia } from "../src/modules/foody/foody.sync.service.js";
import { criarSegurancaFoody } from "../src/modules/foody/foody.seguranca.js";
import { prepararConexao } from "../src/modules/foody/foody.conexao.js";
import { criarClienteFoody } from "../src/modules/foody/foody.client.js";
import { linhaFoodyParaParser, carregarPedidosFoody } from "../src/modules/parser-food-delivery/parserFoodDelivery.foodyPedidos.js";
import { criarFakeDb } from "./helpers/fake-db-foody.js";
import { pedidoApi, ORG_A, UNI_A, SEGREDO_TESTE, TOKEN_TESTE } from "./helpers/foody-fixtures.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const seguranca = criarSegurancaFoody(SEGREDO_TESTE);
const D = "2026-10-25";
const AGORA = () => new Date("2026-10-26T15:00:00Z");
const BASE = { FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_UNIDADES: UNI_A };
const COM_NOME = { ...BASE, FOODY_CENTRAL_ENTREGADOR_NOME_ENABLED: "true" };
const NOME = "Carlos Entregador Fictício";

describe("saneamento e hash", () => {
  const o = () => pedidoApi({ uid: "u1", entregador: NOME, date: `${D}T12:00:00-03:00` });
  test("flag desligada: registro SEM a chave entregador_nome e hash idêntico ao de antes", () => {
    const sem = sanearPedidoApi(o(), { hashEntregador: seguranca.hashEntregador }).registro;
    assert.equal(Object.prototype.hasOwnProperty.call(sem, "entregador_nome"), false);
    const { fonte_hash: _h, ...semHash } = sem;
    assert.equal(sem.fonte_hash, hashConteudoPedido(semHash));
    assert.equal(entregadorNomePermitido({}), false);
    assert.equal(entregadorNomePermitido({ FOODY_CENTRAL_ENTREGADOR_NOME_ENABLED: "1" }), false);
  });
  test("flag ligada: nome guardado (aparado, até 120), hash muda só pelo nome; sem entregador = null", () => {
    const sem = sanearPedidoApi(o(), { hashEntregador: seguranca.hashEntregador }).registro;
    const com = sanearPedidoApi(o(), { hashEntregador: seguranca.hashEntregador, guardarNome: true }).registro;
    assert.equal(com.entregador_nome, NOME);
    assert.equal(com.entregador_hash, sem.entregador_hash, "o hash do entregador não muda");
    assert.notEqual(com.fonte_hash, sem.fonte_hash, "o conteúdo muda: a próxima sincronização atualiza a linha");
    const semEntregador = sanearPedidoApi(pedidoApi({ uid: "u2", entregador: null, date: `${D}T12:00:00-03:00` }), { hashEntregador: seguranca.hashEntregador, guardarNome: true }).registro;
    assert.equal(semEntregador.entregador_nome, null);
    const longo = sanearPedidoApi(pedidoApi({ uid: "u3", entregador: `  ${"x".repeat(200)}  `, date: `${D}T12:00:00-03:00` }), { hashEntregador: seguranca.hashEntregador, guardarNome: true }).registro;
    assert.ok(longo.entregador_nome.length <= 120);
  });
});

describe("sincronização", () => {
  let db, repo, lista, logs;
  const criarCliente = ({ token }) => criarClienteFoody({ token, esperar: async () => {},
    fetch: async () => (token === TOKEN_TESTE ? { ok: true, status: 200, json: async () => structuredClone(lista) } : { ok: false, status: 401, json: async () => ({}) }) });
  const sync = (env) => sincronizarCompetencia({ organizacaoId: ORG_A, unidadeId: UNI_A, competencia: D },
    { env, repo, seguranca, criarCliente, agora: AGORA, log: (_n, e, d) => logs.push(JSON.stringify({ e, d })) });
  beforeEach(() => {
    db = criarFakeDb({ unidades: { [UNI_A]: ORG_A } });
    repo = criarRepositorioFoody(db);
    logs = [];
    db.tabelas.foody_conexoes.push({ id: `cx-${UNI_A}`, ...prepararConexao({ organizacaoId: ORG_A, unidadeId: UNI_A, token: TOKEN_TESTE, pontoColetaEsperado: "Subway Saci" }, seguranca), status: "ATIVA" });
    lista = [pedidoApi({ uid: "a1", entregador: NOME, date: `${D}T11:00:00-03:00` }), pedidoApi({ uid: "a2", entregador: null, date: `${D}T12:00:00-03:00` })];
  });
  test("flag desligada: nenhuma linha recebe a coluna (comportamento anterior)", async () => {
    await sync(BASE);
    assert.ok(db.tabelas.foody_pedidos.every((r) => !Object.prototype.hasOwnProperty.call(r, "entregador_nome")));
  });
  test("ligar a flag e reprocessar: o nome é preenchido na MESMA linha (sem duplicar); repetir fica inalterado", async () => {
    await sync(BASE);
    const r2 = await sync(COM_NOME);
    // Primeira passada com a flag: TODAS as linhas do dia são regravadas uma vez (o nome, ou null explícito, entra no conteúdo).
    assert.deepEqual([r2.contagens.inseridos, r2.contagens.atualizados], [0, 2]);
    assert.equal(db.tabelas.foody_pedidos.length, 2);
    assert.equal(db.tabelas.foody_pedidos.find((r) => r.foody_uid === "a1").entregador_nome, NOME);
    assert.equal(db.tabelas.foody_pedidos.find((r) => r.foody_uid === "a2").entregador_nome, null);
    const r3 = await sync(COM_NOME);
    assert.deepEqual([r3.contagens.inseridos, r3.contagens.atualizados, r3.contagens.inalterados], [0, 0, 2]);
  });
  test("o nome nunca aparece em logs nem na resposta da sincronização", async () => {
    const r = await sync(COM_NOME);
    assert.ok(!JSON.stringify(r).includes("Carlos"));
    assert.ok(!logs.join("\n").includes("Carlos"));
  });
});

describe("Parser", () => {
  const linha = (extra) => ({ organizacao_id: ORG_A, unidade_id: UNI_A, foody_uid: "u", numero_pedido: "1", data_hora: `${D}T11:00:00`,
    status_foody: "closed", situacao: "Finalizado", operacao: "acai_no_grau", entregador_presente: true, entregador_hash: "abcdef1234", ...extra });
  test("mostra o nome quando guardado; sem nome, o rótulo neutro de antes; sem entregador, nada", () => {
    assert.equal(linhaFoodyParaParser(linha({ entregador_nome: "  Ana Fictícia " })).entregador, "Ana Fictícia");
    assert.equal(linhaFoodyParaParser(linha({ entregador_nome: null })).entregador, "Entregador Foody abcdef");
    assert.equal(linhaFoodyParaParser(linha({})).entregador, "Entregador Foody abcdef");
    assert.equal(linhaFoodyParaParser(linha({ entregador_presente: false, entregador_nome: "X" })).entregador, null);
  });
  test("a coluna só é pedida ao banco com a flag ligada (sem a migration, a flag desligada não quebra a leitura)", async () => {
    const pedidos = [];
    const db = { from(t) { const q = { t }; const api = { select(c) { q.c = c; if (t === "foody_pedidos") pedidos.push(c); return api; },
      eq: () => api, gte: () => api, lte: () => api, lt: () => api, order: () => api, range: () => api, limit: () => api,
      then: (res) => Promise.resolve({ data: [], error: null }).then(res) }; return api; } };
    const base = { db, organizacaoId: ORG_A, unidadeId: UNI_A, dataInicio: D, dataFim: D };
    const PARSER = { FOODY_CENTRAL_PARSER_PEDIDOS_ENABLED: "true", FOODY_CENTRAL_PARSER_PEDIDOS_UNIDADES: UNI_A };
    await carregarPedidosFoody({ ...base, env: PARSER });
    await carregarPedidosFoody({ ...base, env: { ...PARSER, FOODY_CENTRAL_ENTREGADOR_NOME_ENABLED: "true" } });
    assert.doesNotMatch(pedidos[0], /entregador_nome/);
    assert.match(pedidos[1], /entregador_nome/);
  });
});

describe("migration 160", () => {
  test("só adiciona a coluna anulável (com CHECK de tamanho e coerência); nada de dados, RLS ou grants; rollback remove", () => {
    const sql = readFileSync(join(RAIZ, "..", "database", "migrations", "160_foody_pedidos_entregador_nome.sql"), "utf8").split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join("\n");
    assert.match(sql, /^\s*begin;\s*\nset local lock_timeout = '5s';/m);
    assert.match(sql, /alter table public\.foody_pedidos add column if not exists entregador_nome text;/);
    assert.match(sql, /length\(entregador_nome\) between 1 and 120 and entregador_presente/);
    assert.doesNotMatch(sql, /\b(update|insert|delete|grant|policy|default)\b/i);
    const rb = readFileSync(join(RAIZ, "..", "database", "migrations", "160_rollback.sql"), "utf8");
    assert.match(rb, /drop column if exists entregador_nome/);
  });
});
