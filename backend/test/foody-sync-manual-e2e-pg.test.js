// Sincronização MANUAL ponta a ponta contra Postgres LOCAL e DESCARTÁVEL (schema real, 147/148/149 com triggers e checks).
// Repositório, sincronização, fechamentos e aprovação REAIS; só a API Foody é falsa. Dados 100% fictícios.
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:56431/postgres node --test test/foody-sync-manual-e2e-pg.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { motivoPular, criarBancoDescartavel, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal } from "./helpers/schema-real-pg.js";
import { criarClientePg } from "./helpers/pg-supabase-mini.js";
import { criarRepositorioFoody } from "../src/modules/foody/foody.repository.js";
import { criarSegurancaFoody } from "../src/modules/foody/foody.seguranca.js";
import { prepararConexao } from "../src/modules/foody/foody.conexao.js";
import { criarClienteFoody } from "../src/modules/foody/foody.client.js";
import { proporDestino, aprovarDestino } from "../src/modules/foody/foody.compartilhamento.service.js";
import { solicitarSyncManual, criarEstadoSyncManual, LIMITES_SYNC_MANUAL } from "../src/modules/foody/foody.sync.manual.js";
import { pedidoApi, SEGREDO_TESTE, TOKEN_TESTE } from "./helpers/foody-fixtures.js";

const ORG_T = "11111111-1111-4111-8111-111111111111", UNI_T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_D = "22222222-2222-4222-8222-222222222222", UNI_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ADM_T = "a1000000-0000-4000-8000-000000000001", ADM_D = "a2000000-0000-4000-8000-000000000002";
const D1 = "2026-11-04", D2 = "2026-11-03";
const AGORA = () => new Date("2026-11-05T12:00:00Z");
const ENV = { FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_UNIDADES: UNI_T, FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED: "true", FOODY_CENTRAL_ADMIN_ENABLED: "true" };
const ator = (perfilId, organizacaoId) => ({ perfilId, papel: "organization_admin", impersonando: false, organizacaoId });

describe("sincronização manual ponta a ponta — Postgres real", { skip: motivoPular, timeout: 900_000 }, () => {
  let b, repo, chamadas = 0, status = 200;
  const seguranca = criarSegurancaFoody(SEGREDO_TESTE);
  const dia = (d) => [
    pedidoApi({ uid: `${d}-s1`, orderDetails: "1x Sub Frango Teriyaki 15cm", courierFee: 10, orderTotal: 40, date: `${d}T11:00:00-03:00` }),
    pedidoApi({ uid: `${d}-a1`, orderDetails: "1x Açaí Premium 500ml", courierFee: 7, orderTotal: 30, date: `${d}T12:00:00-03:00` }),
    pedidoApi({ uid: `${d}-t1`, orderDetails: "1x Sub Frango Teriyaki 15cm\n1x Produto Novo Misterioso", courierFee: 9, orderTotal: 55, date: `${d}T13:00:00-03:00` }),
    pedidoApi({ uid: `${d}-x1`, status: "cancelled", cancellationReason: "other", orderDetails: "1x Sub Frango Teriyaki 15cm", courierFee: 10, orderTotal: 40,
      date: `${d}T14:00:00-03:00`, cancelledDate: `${d}T14:05:00-03:00` }),
  ];
  const todos = [...dia(D1), ...dia(D2)];
  const criarCliente = ({ token, ...r }) => criarClienteFoody({ token, ...r, esperar: async () => {}, fetch: async (url, init) => {
    chamadas++;
    assert.equal(init.method, "GET"); assert.equal(init.body, undefined);
    if (status !== 200 || token !== TOKEN_TESTE) return { ok: false, status: status === 200 ? 401 : status, json: async () => ({}) };
    const u = new URL(url); const ini = Date.parse(u.searchParams.get("startDate")), fim = Date.parse(u.searchParams.get("endDate"));
    return { ok: true, status: 200, json: async () => structuredClone(todos.filter((o) => Date.parse(o.date) >= ini && Date.parse(o.date) < fim)) };
  } });
  const q = (texto) => { const r = psqlSync(b.url, texto); assert.equal(r.ok, true, r.err); return r.out.trim(); };
  const estado = criarEstadoSyncManual();
  const manual = (competencias, extra = {}) => solicitarSyncManual({ ator: ator(ADM_T, ORG_T), tenant: { organizacaoId: ORG_T, unidadeId: UNI_T }, competencias, ...extra },
    { env: ENV, repo, seguranca, criarCliente, agora: AGORA, estado, log: () => {}, ...(extra.deps ?? {}) });

  before(async () => {
    b = criarBancoDescartavel("foodysyncmanual");
    assert.deepEqual(construirSchemaReal(b.url), []);
    for (const [org, uni] of [[ORG_T, UNI_T], [ORG_D, UNI_D]]) {
      q(`insert into organizacoes (id, nome) values ('${org}', 'org ${org.slice(0, 4)}');
         insert into unidades (id, organizacao_id, nome) values ('${uni}', '${org}', 'unidade ${uni.slice(0, 4)}');`);
    }
    for (const [pid, org] of [[ADM_T, ORG_T], [ADM_D, ORG_D], [ADM_T, ORG_D]]) {
      q(`insert into auth.users (id, email) values ('${pid}', 'u${pid.slice(0, 4)}@teste.invalid') on conflict do nothing;
         insert into perfis (id, nome, email) values ('${pid}', 'perfil', 'u${pid.slice(0, 4)}@teste.invalid') on conflict do nothing;
         insert into perfis_operacionais (id, conta_id, nome) values ('${pid}', '${pid}', 'perfil') on conflict do nothing;
         insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${pid}', '${pid}', '${org}', 'organization_admin');`);
    }
    repo = criarRepositorioFoody(criarClientePg(b.url));
    const linha = { ...prepararConexao({ organizacaoId: ORG_T, unidadeId: UNI_T, token: TOKEN_TESTE }, seguranca), status: "ATIVA" };
    const { data, error } = await criarClientePg(b.url).from("foody_conexoes").insert(linha).select("id").single();
    assert.equal(error, null);
    const svc = { env: ENV, repo, agora: AGORA };
    const p = await proporDestino({ ator: ator(ADM_T, ORG_T), conexaoId: data.id, destino: { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" } }, svc);
    assert.equal((await aprovarDestino({ ator: ator(ADM_D, ORG_D), destinoId: p.id }, svc)).estado, "ATIVO");
  });
  after(() => b?.derrubar?.());

  test("dois dias: distribuição Subway/Açaí/triagem, fechamentos independentes por organização, autor = perfil do admin", async () => {
    const r = await manual([D1, D2]);
    assert.deepEqual(r.dias.map((d) => [d.competencia, d.erro ?? "ok"]), [[D2, "ok"], [D1, "ok"]]);
    for (const d of r.dias) {
      assert.equal(d.contagens.unicos, 4); assert.equal(d.contagens.inseridos, 4);
      assert.deepEqual(d.distribuicao.destinos, { acai_no_grau: 1 }); assert.equal(d.distribuicao.triagem, 1);
      assert.equal(d.fechamento.resultado, "REGISTRADO"); assert.equal(d.fechamentosDestino[0].resultado, "REGISTRADO");
    }
    assert.equal(q(`select count(*) from foody_pedidos where roteamento_ativo and unidade_id = '${UNI_D}' and organizacao_id = '${ORG_D}' and operacao = 'acai_no_grau';`), "2");
    assert.equal(q(`select count(*) from foody_pedidos where roteamento_ativo and unidade_id = '${UNI_T}';`), "6");
    assert.equal(q(`select count(*) from (select conexao_id, foody_uid from foody_pedidos where roteamento_ativo group by 1,2 having count(*) > 1) x;`), "0");
    assert.equal(q(`select string_agg(distinct origem || ':' || gerado_por, ',') from foody_fechamentos_logisticos;`), `manual:${ADM_T}`);
    assert.equal(q(`select count(*) from foody_fechamentos_logisticos where unidade_id = '${UNI_D}';`), "2");
    assert.equal(q(`select count(*) from foody_fechamentos_logisticos where unidade_id = '${UNI_T}';`), "2");
    assert.equal(q(`select string_agg(status || '/' || origem, ',' order by competencia) from foody_sync_execucoes;`), "CONCLUIDA/manual,CONCLUIDA/manual");
  });

  test("repetir: nada novo (SEM_MUDANCA no banco real), nenhum pedido ou versão a mais", async () => {
    const antes = q(`select count(*) || '/' || (select count(*) from foody_fechamentos_logisticos) from foody_pedidos;`);
    const r = await manual([D1]);
    assert.equal(r.dias[0].contagens.inalterados, 4);
    assert.equal(r.dias[0].fechamento.resultado, "SEM_MUDANCA"); assert.equal(r.dias[0].fechamentosDestino[0].resultado, "SEM_MUDANCA");
    assert.equal(q(`select count(*) || '/' || (select count(*) from foody_fechamentos_logisticos) from foody_pedidos;`), antes);
  });

  test("concorrência pelo banco: EM_ANDAMENTO recente bloqueia; abandonado vira FALHOU/ABANDONADA (constraint real aceita)", async () => {
    const cx = q(`select id from foody_conexoes limit 1;`);
    q(`insert into foody_sync_execucoes (organizacao_id, unidade_id, conexao_id, competencia, janela_inicio, janela_fim, origem, regra_versao, iniciado_em)
       values ('${ORG_T}', '${UNI_T}', '${cx}', '${D2}', '${D2}T03:00:00Z', '${D1}T03:00:00Z', 'agendado', 1, '2026-11-05T11:50:00Z');`);
    await assert.rejects(manual([D1]), (e) => e.codigo === "CONCORRENCIA");
    q(`update foody_sync_execucoes set iniciado_em = '2026-11-05T08:00:00Z' where status = 'EM_ANDAMENTO';`);
    const r = await manual([D1]);
    assert.equal(r.dias[0].erro, undefined);
    assert.equal(q(`select count(*) from foody_sync_execucoes where status = 'FALHOU' and erro_codigo = 'ABANDONADA';`), "1");
    assert.equal(q(`select count(*) from foody_sync_execucoes where status = 'EM_ANDAMENTO';`), "0");
  });

  test("trava vê as EM_ANDAMENTO da UNIDADE (mesmo escopo do índice da 150), não só da conexão atual", async () => {
    // Hoje 147 garante uma conexão por unidade (uq_foody_conexoes_unidade), então os escopos coincidem; o alinhamento é defensivo.
    assert.equal(q(`select count(*) from pg_constraint where conname = 'uq_foody_conexoes_unidade';`), "1");
    const cx = q(`select id from foody_conexoes limit 1;`);
    q(`insert into foody_sync_execucoes (organizacao_id, unidade_id, conexao_id, competencia, janela_inicio, janela_fim, origem, regra_versao, iniciado_em)
       values ('${ORG_T}', '${UNI_T}', '${cx}', '${D2}', '${D2}T03:00:00Z', '${D1}T03:00:00Z', 'agendado', 1, '2026-11-05T08:00:00Z');`);
    const vistas = await repo.listarExecucoesEmAndamento({ organizacaoId: ORG_T, unidadeId: UNI_T }, "00000000-0000-4000-8000-000000000000");
    assert.equal(vistas.length, 1, "conexaoId não filtra");
    const r = await manual([D1]);
    assert.equal(r.dias[0].erro, undefined);
    assert.equal(q(`select count(*) from foody_sync_execucoes where status = 'EM_ANDAMENTO';`), "0");
  });

  test("teto de pedidos: execução FALHOU/LIMITE_PEDIDOS e nenhum pedido novo gravado", async () => {
    const antes = q(`select count(*) from foody_pedidos;`);
    todos.push(pedidoApi({ uid: "novo-limite", date: `${D1}T20:00:00-03:00` }));
    const r = await manual([D1], { deps: { limites: { ...LIMITES_SYNC_MANUAL, maxPedidosPorDia: 2 } } });
    assert.equal(r.dias[0].erro, "LIMITE_PEDIDOS");
    assert.equal(q(`select count(*) from foody_pedidos;`), antes);
    assert.equal(q(`select count(*) from foody_sync_execucoes where status = 'FALHOU' and erro_codigo = 'LIMITE_PEDIDOS';`), "1");
    todos.pop();
  });

  test("API recusa (401): dia falha, conexão marca AUTENTICACAO, demais dias não executam", async () => {
    status = 401;
    const r = await manual([D2, D1]);
    status = 200;
    assert.deepEqual(r.dias.map((d) => d.erro), ["AUTENTICACAO", "NAO_EXECUTADO"]);
    assert.equal(q(`select ultimo_erro_codigo from foody_conexoes;`), "AUTENTICACAO");
  });

  test("nenhuma tabela fora de foody_* foi escrita pela coleta", () => {
    assert.equal(q(`select count(*) from organizacoes;`), "2");
    assert.equal(q(`select count(*) from unidades;`), "2");
    assert.ok(chamadas > 0);
  });
});
