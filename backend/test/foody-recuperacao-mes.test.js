// "Preencher mês" — prévia de recuperação (SOMENTE LEITURA). Banco FALSO e API Foody FALSA: nenhuma rede, nenhum banco real.
// Prova: consulta a origem só nos dias que precisam; não grava nada; zero pedidos ≠ dia zerado; mês não vira "completo" por
// ter alguns dias; erro de conta interrompe; cache evita chamadas repetidas; mesmas travas da sincronização manual.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { criarRepositorioFoody } from "../src/modules/foody/foody.repository.js";
import { previaRecuperacaoMes, SITUACAO_DIA, criarEstadoSyncManual } from "../src/modules/foody/foody.sync.manual.js";
import { criarSegurancaFoody } from "../src/modules/foody/foody.seguranca.js";
import { prepararConexao } from "../src/modules/foody/foody.conexao.js";
import { criarClienteFoody } from "../src/modules/foody/foody.client.js";
import { criarFakeDb } from "./helpers/fake-db-foody.js";
import { pedidoApi, ORG_A, UNI_A, ORG_B, UNI_B, SEGREDO_TESTE, TOKEN_TESTE } from "./helpers/foody-fixtures.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGORA = () => new Date("2026-10-15T15:00:00Z"); // hoje em Brasília = 15/10
const seguranca = criarSegurancaFoody(SEGREDO_TESTE);
const ENV = { FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_ADMIN_ENABLED: "true", FOODY_CENTRAL_UNIDADES: UNI_A };
const ADMIN = { perfilId: "a1000000-0000-4000-8000-000000000001", papel: "organization_admin", impersonando: false, organizacaoId: ORG_A };

let db, repo, porDia, chamadas, status;
const criarCliente = ({ token }) => criarClienteFoody({
  token, esperar: async () => {},
  fetch: async (url, init) => {
    chamadas.push({ url: String(url), metodo: init.method });
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    const u = new URL(String(url));
    const dia = u.searchParams.get("startDate").slice(0, 10);
    return { ok: true, status: 200, json: async () => structuredClone(porDia[dia] ?? []) };
  },
});
const previa = (p = {}, d = {}) => previaRecuperacaoMes({ ator: ADMIN, tenant: { organizacaoId: ORG_A, unidadeId: UNI_A }, mes: "2026-09", ...p },
  { env: ENV, repo, seguranca, agora: AGORA, criarCliente, estado: criarEstadoSyncManual({ emCurso: new Set() }), ...d });
const fechamento = (competencia, status, estado = "SINCRONIZADO", pendencias = []) => db.tabelas.foody_fechamentos_logisticos.push({
  id: `f-${competencia}`, organizacao_id: ORG_A, unidade_id: UNI_A, competencia, versao: 1, status, estado_valores: estado, pendencias });

beforeEach(() => {
  db = criarFakeDb({ unidades: { [UNI_A]: ORG_A, [UNI_B]: ORG_B } });
  repo = criarRepositorioFoody(db);
  chamadas = []; status = 200;
  db.tabelas.foody_conexoes.push({ id: `cx-${UNI_A}`, ...prepararConexao({ organizacaoId: ORG_A, unidadeId: UNI_A, token: TOKEN_TESTE, pontoColetaEsperado: "Subway Saci" }, seguranca), status: "ATIVA" });
  porDia = {
    "2026-09-03": [pedidoApi({ uid: "s1", entregador: "A", courierFee: 10, date: "2026-09-03T11:00:00-03:00" }),
      pedidoApi({ uid: "s2", entregador: null, courierFee: 9, date: "2026-09-03T12:00:00-03:00" })],
    "2026-09-04": [pedidoApi({ uid: "s3", entregador: "B", courierFee: 12.5, date: "2026-09-04T19:00:00-03:00" })],
  };
});

describe("travas (iguais às da sincronização manual)", () => {
  test("flags, permissão, unidade e mês inválido recusados antes de qualquer chamada", async () => {
    await assert.rejects(previa({}, { env: { ...ENV, FOODY_CENTRAL_ADMIN_ENABLED: "false" } }), (e) => e.codigo === "DESLIGADO");
    await assert.rejects(previa({ tenant: { organizacaoId: ORG_B, unidadeId: UNI_B } }), (e) => e.codigo === "DESLIGADO");
    await assert.rejects(previa({ ator: { ...ADMIN, papel: "unit_manager" } }), (e) => e.codigo === "SEM_PERMISSAO");
    await assert.rejects(previa({ ator: { ...ADMIN, impersonando: true } }), (e) => e.codigo === "SEM_PERMISSAO");
    await assert.rejects(previa({ ator: { ...ADMIN, organizacaoId: ORG_B } }), (e) => e.codigo === "SEM_PERMISSAO");
    for (const mes of ["2026-13", "2026-9", "x", ""]) await assert.rejects(previa({ mes }), (e) => e.codigo === "PARAMETRO_INVALIDO", mes);
    assert.equal(chamadas.length, 0);
  });
});

describe("prévia de setembro", () => {
  test("classifica cada dia pela origem e pelo banco; nada é gravado; só GET", async () => {
    fechamento("2026-09-01", "CONSOLIDADO");
    fechamento("2026-09-02", "PRELIMINAR", "PROVISORIO", [{ codigo: "TRIAGEM_PENDENTE", quantidade: 2 }]);
    fechamento("2026-09-04", "INCOMPLETO", "PROVISORIO");
    const antes = JSON.stringify(db.tabelas);
    const r = await previa();
    assert.equal(JSON.stringify(db.tabelas), antes, "a prévia não grava nada");
    assert.ok(!db.chamadas.some((c) => c.op && c.op !== "select"), "só leituras no banco");
    assert.ok(chamadas.every((c) => c.metodo === "GET"));
    const s = Object.fromEntries(r.dias.map((d) => [d.competencia, d.situacao]));
    assert.equal(s["2026-09-01"], SITUACAO_DIA.COMPLETO);
    assert.equal(s["2026-09-02"], SITUACAO_DIA.PROVISORIO);
    assert.equal(s["2026-09-03"], SITUACAO_DIA.RECUPERAVEL);
    assert.equal(s["2026-09-04"], SITUACAO_DIA.PARCIAL);
    assert.equal(s["2026-09-05"], SITUACAO_DIA.SEM_PEDIDOS_NA_ORIGEM, "zero pedidos não vira dia zerado nem recuperável");
    assert.equal(r.dias.length, 30);
    // a origem só é consultada nos dias sem fechamento definitivo/provisório (30 − 2)
    assert.equal(chamadas.length, 28);
    assert.deepEqual(r.recuperar, ["2026-09-03", "2026-09-04"]);
    assert.equal(r.totais.completos, 1); assert.equal(r.totais.provisorios, 1);
    assert.equal(r.totais.recuperaveis, 1); assert.equal(r.totais.parciais, 1);
    assert.equal(r.totais.semPedidosNaOrigem, 26);
    assert.equal(r.totais.pedidosNaOrigem, 3);
    assert.deepEqual(r.totais.comEntregador, { subway: 2 });
    assert.deepEqual(r.totais.taxasPrevistasCentavos, { subway: 2250 }, "só pedidos com entregador; sem entregador fica fora");
  });
  test("resposta sem dado pessoal nem identificador de pedido", async () => {
    const r = JSON.stringify(await previa());
    for (const proibido of ["s1", "Maria", "Interfone", "courierName", TOKEN_TESTE]) assert.ok(!r.includes(proibido), proibido);
  });
  test("mês do dia em curso: hoje e futuro ficam 'aberto' e não são consultados", async () => {
    const r = await previa({ mes: "2026-10" });
    const aberto = r.dias.filter((d) => d.situacao === SITUACAO_DIA.ABERTO).map((d) => d.competencia);
    assert.equal(aberto[0], "2026-10-15");
    assert.equal(aberto.length, 17);
    assert.equal(chamadas.length, 14);
  });
  test("falha de autenticação interrompe: demais dias 'não consultado' (nunca 'sem pedidos')", async () => {
    status = 401;
    const r = await previa();
    assert.equal(r.interrompidoPor, "AUTENTICACAO");
    assert.equal(r.dias[0].situacao, SITUACAO_DIA.INDISPONIVEL);
    assert.ok(r.dias.slice(1).every((d) => d.situacao === SITUACAO_DIA.NAO_CONSULTADO));
    assert.equal(r.totais.semPedidosNaOrigem, 0);
    assert.deepEqual(r.recuperar, []);
  });
  test("cache: repetir em seguida não chama a API de novo", async () => {
    const estado = criarEstadoSyncManual({ emCurso: new Set() });
    await previa({}, { estado });
    const n = chamadas.length;
    const r2 = await previa({}, { estado });
    assert.equal(r2.emCache, true);
    assert.equal(chamadas.length, n);
  });
});

describe("estrutural", () => {
  test("rota da prévia: GET, mesmo orçamento e mesmo tratamento de erro; a prévia não importa gravação nem fechamento", () => {
    const rotas = readFileSync(join(RAIZ, "src", "modules", "foody-admin", "foodyAdmin.sync.routes.js"), "utf8");
    assert.match(rotas, /router\.get\("\/previa-mes", limite, asyncHandler/);
    const m = readFileSync(join(RAIZ, "src", "modules", "foody", "foody.sync.manual.js"), "utf8");
    const bloco = m.slice(m.indexOf("export async function previaRecuperacaoMes"));
    assert.doesNotMatch(bloco, /gravarPedidos|abrirExecucao|registrarFechamento|executar\(|sincronizarEFechar|\.insert\(|\.update\(|\.upsert\(/);
  });
});
