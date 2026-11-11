// Distância em raio (flag FOODY_CENTRAL_DISTANCIA_ENABLED + migration 161). Banco e API FALSOS: nenhuma rede.
// Prova: desligada = idêntico ao anterior (sem coluna, mesmo hash); ligada = km calculado das coordenadas, guardado SEM as
// coordenadas; reprocessar preenche na MESMA linha; coordenada ausente/implausível = null (nunca zero); o Parser usa o raio.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sanearPedidoApi, hashConteudoPedido, distanciaRaioKm, paraPedidoParser } from "../src/modules/foody/foody.adapter.js";
import { distanciaPermitida } from "../src/modules/foody/foody.flags.js";
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
const COM_DIST = { ...BASE, FOODY_CENTRAL_DISTANCIA_ENABLED: "true" };
// Loja e cliente fictícios: 0,01° de latitude ≈ 1,11 km.
const LOJA = { lat: -10.0, lng: -50.0 };
const comCoordenadas = (o, entrega = { lat: -10.01, lng: -50.0 }, coleta = LOJA) => {
  o.collectionPoint = { ...o.collectionPoint, coordinates: coleta };
  o.deliveryPoint = { ...o.deliveryPoint, coordinates: entrega };
  return o;
};

describe("cálculo", () => {
  test("haversine em km com 2 casas", () => {
    assert.equal(distanciaRaioKm(comCoordenadas({})), 1.11);
    assert.equal(distanciaRaioKm(comCoordenadas({}, { lat: -10.0, lng: -50.0 })), 0);
    assert.equal(distanciaRaioKm(comCoordenadas({}, { lat: "-10.02", lng: "-50.0" })), 2.22, "aceita número em texto");
  });
  test("coordenada ausente, inválida, (0,0) ou implausível = null, nunca zero", () => {
    assert.equal(distanciaRaioKm({}), null);
    assert.equal(distanciaRaioKm(comCoordenadas({}, null)), null);
    assert.equal(distanciaRaioKm(comCoordenadas({}, { lat: null, lng: -50 })), null);
    assert.equal(distanciaRaioKm(comCoordenadas({}, { lat: 0, lng: 0 })), null);
    assert.equal(distanciaRaioKm(comCoordenadas({}, { lat: 95, lng: -50 })), null);
    assert.equal(distanciaRaioKm(comCoordenadas({}, { lat: -12, lng: -50 })), null, "≈ 222 km: coordenada errada");
  });
});

describe("saneamento e hash", () => {
  const o = () => comCoordenadas(pedidoApi({ uid: "u1", date: `${D}T12:00:00-03:00` }));
  test("flag desligada: sem a chave e hash idêntico ao de antes", () => {
    const sem = sanearPedidoApi(o(), { hashEntregador: seguranca.hashEntregador }).registro;
    assert.equal(Object.prototype.hasOwnProperty.call(sem, "distancia_raio_km"), false);
    const { fonte_hash: _h, ...semHash } = sem;
    assert.equal(sem.fonte_hash, hashConteudoPedido(semHash));
    assert.equal(distanciaPermitida({}), false);
    assert.equal(distanciaPermitida({ FOODY_CENTRAL_DISTANCIA_ENABLED: "1" }), false);
  });
  test("flag ligada: guarda só o km; nenhuma coordenada ou endereço no registro", () => {
    const sem = sanearPedidoApi(o(), { hashEntregador: seguranca.hashEntregador }).registro;
    const com = sanearPedidoApi(o(), { hashEntregador: seguranca.hashEntregador, guardarDistancia: true }).registro;
    assert.equal(com.distancia_raio_km, 1.11);
    assert.notEqual(com.fonte_hash, sem.fonte_hash);
    const json = JSON.stringify(com);
    assert.doesNotMatch(json, /-10\.01|-50|coordinates|lat|lng|Rua do Cliente/);
    assert.equal(paraPedidoParser(com).distanciaRaioKm, 1.11);
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
    lista = [comCoordenadas(pedidoApi({ uid: "a1", date: `${D}T11:00:00-03:00` })), pedidoApi({ uid: "a2", date: `${D}T12:00:00-03:00` })];
  });
  test("flag desligada: nenhuma linha recebe a coluna", async () => {
    await sync(BASE);
    assert.ok(db.tabelas.foody_pedidos.every((r) => !Object.prototype.hasOwnProperty.call(r, "distancia_raio_km")));
  });
  test("ligar e reprocessar: km na MESMA linha (sem duplicar); sem coordenada = null; repetir fica inalterado", async () => {
    await sync(BASE);
    const r2 = await sync(COM_DIST);
    assert.deepEqual([r2.contagens.inseridos, r2.contagens.atualizados], [0, 2]);
    assert.equal(db.tabelas.foody_pedidos.length, 2);
    assert.equal(db.tabelas.foody_pedidos.find((r) => r.foody_uid === "a1").distancia_raio_km, 1.11);
    assert.equal(db.tabelas.foody_pedidos.find((r) => r.foody_uid === "a2").distancia_raio_km, null);
    const r3 = await sync(COM_DIST);
    assert.deepEqual([r3.contagens.inseridos, r3.contagens.atualizados, r3.contagens.inalterados], [0, 0, 2]);
    assert.ok(!logs.join("\n").includes("-10.01"));
  });
});

describe("Parser", () => {
  const linha = (extra) => ({ organizacao_id: ORG_A, unidade_id: UNI_A, foody_uid: "u", numero_pedido: "1", data_hora: `${D}T11:00:00`,
    status_foody: "closed", situacao: "Finalizado", operacao: "subway", entregador_presente: true, entregador_hash: "abcdef1234", ...extra });
  test("usa o raio guardado; ausente continua null (nunca zero)", () => {
    assert.equal(linhaFoodyParaParser(linha({ distancia_raio_km: "1.51" })).distancia_raio_km, 1.51);
    assert.equal(linhaFoodyParaParser(linha({})).distancia_raio_km, null);
    assert.equal(linhaFoodyParaParser(linha({ distancia_raio_km: null })).distancia_raio_km, null);
  });
  test("a coluna só é pedida ao banco com a flag ligada", async () => {
    const pedidos = [];
    const db = { from(t) { const api = { select(c) { if (t === "foody_pedidos") pedidos.push(c); return api; },
      eq: () => api, gte: () => api, lte: () => api, lt: () => api, order: () => api, range: () => api, limit: () => api,
      then: (res) => Promise.resolve({ data: [], error: null }).then(res) }; return api; } };
    const base = { db, organizacaoId: ORG_A, unidadeId: UNI_A, dataInicio: D, dataFim: D };
    const PARSER = { FOODY_CENTRAL_PARSER_PEDIDOS_ENABLED: "true", FOODY_CENTRAL_PARSER_PEDIDOS_UNIDADES: UNI_A };
    await carregarPedidosFoody({ ...base, env: PARSER });
    await carregarPedidosFoody({ ...base, env: { ...PARSER, FOODY_CENTRAL_DISTANCIA_ENABLED: "true", FOODY_CENTRAL_ENTREGADOR_NOME_ENABLED: "true" } });
    assert.doesNotMatch(pedidos[0], /distancia_raio_km|entregador_nome/);
    assert.match(pedidos[1], /distancia_raio_km/);
    assert.match(pedidos[1], /entregador_nome/);
  });
});

describe("migration 161", () => {
  test("só adiciona a coluna anulável com CHECK; nada de dados, RLS ou grants; rollback remove", () => {
    const sql = readFileSync(join(RAIZ, "..", "database", "migrations", "161_foody_pedidos_distancia_raio.sql"), "utf8").split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join("\n");
    assert.match(sql, /^\s*begin;\s*\nset local lock_timeout = '5s';/m);
    assert.match(sql, /add column if not exists distancia_raio_km numeric\(6,2\);/);
    assert.match(sql, /distancia_raio_km >= 0 and distancia_raio_km <= 100/);
    assert.doesNotMatch(sql, /\b(update|insert|delete|grant|policy|default)\b/i);
    assert.match(readFileSync(join(RAIZ, "..", "database", "migrations", "161_rollback.sql"), "utf8"), /drop column if exists distancia_raio_km/);
  });
});
