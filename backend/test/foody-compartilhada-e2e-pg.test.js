// Ponta a ponta da conexão COMPARTILHADA contra Postgres LOCAL e DESCARTÁVEL (schema real 068..145): repositório, sincronização,
// fechamentos e serviço de aprovação/triagem REAIS, com todas as triggers, checks e o índice global da 144/145 valendo.
// Só a API Foody é falsa. Só roda com CHECKLIST_PERFIL_PG_URL local; senão é PULADO. Dados 100% fictícios.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55431/postgres node --test test/foody-compartilhada-e2e-pg.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { motivoPular, criarBancoDescartavel, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal } from "./helpers/schema-real-pg.js";
import { criarClientePg } from "./helpers/pg-supabase-mini.js";
import { criarRepositorioFoody } from "../src/modules/foody/foody.repository.js";
import { sincronizarEFechar } from "../src/modules/foody/foody.fechamento.service.js";
import { criarSegurancaFoody } from "../src/modules/foody/foody.seguranca.js";
import { prepararConexao } from "../src/modules/foody/foody.conexao.js";
import { criarClienteFoody } from "../src/modules/foody/foody.client.js";
import { proporDestino, aprovarDestino, revogarDestino, decidirTriagem } from "../src/modules/foody/foody.compartilhamento.service.js";
import { pedidoApi, SEGREDO_TESTE, TOKEN_TESTE } from "./helpers/foody-fixtures.js";

const ORG_T = "11111111-1111-4111-8111-111111111111", UNI_T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_D = "22222222-2222-4222-8222-222222222222", UNI_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ADM_T = "a1000000-0000-4000-8000-000000000001", ADM_D = "a2000000-0000-4000-8000-000000000002";
const OPS_T = "a3000000-0000-4000-8000-000000000003";
const D = "2026-10-25";
const AGORA = () => new Date("2026-10-26T15:00:00Z");
const ENV = { FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_UNIDADES: UNI_T, FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED: "true", FOODY_CENTRAL_ADMIN_ENABLED: "true" };
const ator = (perfilId, organizacaoId) => ({ perfilId, papel: "organization_admin", impersonando: false, organizacaoId });

describe("conexão compartilhada ponta a ponta — Postgres real", { skip: motivoPular, timeout: 900_000 }, () => {
  let b, repo, conexaoId;
  const seguranca = criarSegurancaFoody(SEGREDO_TESTE);
  const lista = [
    pedidoApi({ uid: "s1", orderDetails: "1x Sub Frango Teriyaki 15cm", courierFee: 10, orderTotal: 40, date: `${D}T11:00:00-03:00` }),
    pedidoApi({ uid: "c1", orderDetails: "1x Açaí Premium 500ml", courierFee: 7, orderTotal: 30, date: `${D}T12:00:00-03:00` }),
    pedidoApi({ uid: "t1", orderDetails: "1x Sub Frango Teriyaki 15cm\n1x Produto Novo Misterioso", courierFee: 9, orderTotal: 55, date: `${D}T13:00:00-03:00` }),
  ];
  const criarCliente = ({ token }) => criarClienteFoody({ token, esperar: async () => {},
    fetch: async () => (token === TOKEN_TESTE ? { ok: true, status: 200, json: async () => structuredClone(lista) } : { ok: false, status: 401, json: async () => ({}) }) });
  const deps = () => ({ env: ENV, repo, seguranca, criarCliente, agora: AGORA, log: (n, e, d) => { if (e === "foody.sync.falha") console.error("FALHA", d.erro?.message ?? d.erro); } });
  const svc = () => ({ env: ENV, repo, agora: AGORA });
  const q = (texto) => { const r = psqlSync(b.url, texto); assert.equal(r.ok, true, r.err); return r.out.trim(); };
  const ciclo = () => sincronizarEFechar({ organizacaoId: ORG_T, unidadeId: UNI_T, competencia: D }, deps());
  const ativo = (uid) => q(`select unidade_id || '|' || organizacao_id || '|' || operacao || '|' || coalesce(valor_total::text, '-')
    from foody_pedidos where foody_uid = '${uid}' and roteamento_ativo;`);

  before(() => {
    b = criarBancoDescartavel("foody145e2e");
    assert.deepEqual(construirSchemaReal(b.url), []);
    for (const [org, uni] of [[ORG_T, UNI_T], [ORG_D, UNI_D]]) {
      q(`insert into organizacoes (id, nome) values ('${org}', 'org ${org.slice(0, 4)}');
         insert into unidades (id, organizacao_id, nome) values ('${uni}', '${org}', 'unidade ${uni.slice(0, 4)}');`);
    }
    for (const [pid, org, papel] of [[ADM_T, ORG_T, "organization_admin"], [ADM_D, ORG_D, "organization_admin"], [OPS_T, ORG_T, "operations"]]) {
      q(`insert into auth.users (id, email) values ('${pid}', 'u${pid.slice(0, 4)}@teste.invalid');
         insert into perfis (id, nome, email) values ('${pid}', 'perfil', 'u${pid.slice(0, 4)}@teste.invalid');
         insert into perfis_operacionais (id, conta_id, nome) values ('${pid}', '${pid}', 'perfil');
         insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${pid}', '${pid}', '${org}', '${papel}');`);
    }
    repo = criarRepositorioFoody(criarClientePg(b.url));
  });
  after(() => b?.derrubar?.());

  test("conexão da titular e vínculo com APROVAÇÃO DUPLA conferida pelo banco", async () => {
    const linha = { ...prepararConexao({ organizacaoId: ORG_T, unidadeId: UNI_T, token: TOKEN_TESTE }, seguranca), status: "ATIVA" };
    const c = criarClientePg(b.url);
    const { data, error } = await c.from("foody_conexoes").insert(linha).select("id").single();
    assert.equal(error, null); conexaoId = data.id;
    // Quem NÃO é admin no banco é recusado mesmo que o ator diga que é (defesa em profundidade).
    await assert.rejects(proporDestino({ ator: ator(OPS_T, ORG_T), conexaoId, destino: { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" } }, svc()),
      (e) => e.codigo === "SEM_PERMISSAO" && /Administrador ativo da organização/.test(e.message));
    const p = await proporDestino({ ator: ator(ADM_T, ORG_T), conexaoId, destino: { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" } }, svc());
    assert.equal(p.estado, "PENDENTE");
    // Sem a aprovação do destino nada é distribuído: a sync segue a regra da 144 (Açaí mínimo na titular).
    await ciclo();
    assert.equal(ativo("c1"), `${UNI_T}|${ORG_T}|acai_no_grau|-`);
    const a = await aprovarDestino({ ator: ator(ADM_D, ORG_D), destinoId: p.id }, svc());
    assert.equal(a.estado, "ATIVO");
    assert.equal(q(`select string_agg(evento, ',' order by evento) from foody_destinos_eventos;`), "APROVADO_DESTINO,APROVADO_TITULAR,ATIVADO,ATIVADO,PROPOSTO");
    // Cada evento no tenant de quem agiu; a ativação fica registrada nas duas organizações.
    assert.equal(q(`select string_agg(evento || '@' || organizacao_id, ',' order by evento, organizacao_id) from foody_destinos_eventos where evento <> 'ATIVADO';`),
      `APROVADO_DESTINO@${ORG_D},APROVADO_TITULAR@${ORG_T},PROPOSTO@${ORG_T}`);
    assert.equal(q(`select count(distinct organizacao_id) from foody_destinos_eventos where evento = 'ATIVADO';`), "2");
  });

  test("distribuição real: Subway na titular, Açaí no destino (completo), triagem na titular sem valor; 2 fechamentos PROVISÓRIOS", async () => {
    const r = await ciclo();
    assert.equal(ativo("s1"), `${UNI_T}|${ORG_T}|subway|40.00`);
    assert.equal(ativo("c1"), `${UNI_D}|${ORG_D}|acai_no_grau|30.00`);
    assert.equal(ativo("t1"), `${UNI_T}|${ORG_T}|triagem|-`);
    assert.equal(q(`select count(*) from foody_pedidos where foody_uid = 'c1' and unidade_id = '${UNI_T}' and not roteamento_ativo and roteamento_motivo = 'RECLASSIFICADO' and detalhes_pedido is null;`), "1");
    assert.equal(r.fechamentosDestino[0].resultado, "REGISTRADO");
    const f = q(`select string_agg(unidade_id || ':' || estado_valores || ':' || (indicadores->>'operacao'), ',' order by unidade_id) from foody_fechamentos_logisticos
      where competencia = '${D}' and versao = (select max(versao) from foody_fechamentos_logisticos x where x.unidade_id = foody_fechamentos_logisticos.unidade_id and x.competencia = '${D}');`);
    assert.equal(f, `${UNI_T}:PROVISORIO:subway,${UNI_D}:PROVISORIO:acai_no_grau`);
    assert.equal(q(`select pedidos_triagem from foody_sync_execucoes order by iniciado_em desc, id limit 1;`), "1");
  });

  test("decisão de triagem (admin do destino) → o pedido muda de organização sem nunca ficar ativo em duas", async () => {
    await decidirTriagem({ ator: ator(ADM_D, ORG_D), conexaoId, foodyUid: "t1", operacao: "acai_no_grau", motivo: "conferido no Gestor" }, svc());
    await ciclo();
    assert.equal(ativo("t1"), `${UNI_D}|${ORG_D}|acai_no_grau|55.00`);
    assert.equal(q(`select count(*) from (select conexao_id, foody_uid from foody_pedidos where roteamento_ativo group by 1, 2 having count(*) > 1) x;`), "0");
    const est = q(`select string_agg(distinct estado_valores, ',') from foody_fechamentos_logisticos f where versao = (select max(versao) from foody_fechamentos_logisticos x where x.unidade_id = f.unidade_id);`);
    assert.equal(est, "SINCRONIZADO");
    assert.equal(q(`select (indicadores->'acai_no_grau'->>'custoLogisticoProprio') from foody_fechamentos_logisticos where unidade_id = '${UNI_D}' order by versao desc limit 1;`), "16");
    assert.equal(q(`select (indicadores->'subway'->>'custoLogisticoProprio') from foody_fechamentos_logisticos where unidade_id = '${UNI_T}' order by versao desc limit 1;`), "10");
  });

  test("isolamento: nenhum dado comercial do Açaí na titular; nenhum Subway no destino; tenants conferidos", () => {
    assert.equal(q(`select count(*) from foody_pedidos where unidade_id = '${UNI_T}' and operacao = 'acai_no_grau' and (valor_total is not null or detalhes_pedido is not null);`), "0");
    assert.equal(q(`select count(*) from foody_pedidos where unidade_id = '${UNI_D}' and (operacao <> 'acai_no_grau' or organizacao_id <> '${ORG_D}');`), "0");
    assert.equal(q(`select count(*) from foody_triagem_decisoes where organizacao_id = '${ORG_T}' and unidade_id = '${UNI_T}';`), "1");
  });

  test("revogação (admin da titular): o destino perde a distribuição; Açaí volta ao mínimo na titular; só a titular fecha", async () => {
    const destinoId = q(`select id from foody_conexao_destinos where estado = 'ATIVO';`);
    await revogarDestino({ ator: ator(ADM_T, ORG_T), destinoId, motivo: "encerramento da parceria" }, svc());
    const antes = Number(q(`select count(*) from foody_fechamentos_logisticos where unidade_id = '${UNI_D}';`));
    const r = await ciclo();
    assert.deepEqual(r.fechamentosDestino, []);
    assert.equal(Number(q(`select count(*) from foody_fechamentos_logisticos where unidade_id = '${UNI_D}';`)), antes, "histórico do destino preservado, nada novo");
    assert.equal(ativo("c1"), `${UNI_T}|${ORG_T}|acai_no_grau|-`);
    assert.equal(q(`select count(*) from foody_pedidos where unidade_id = '${UNI_D}' and roteamento_ativo;`), "0");
    assert.equal(q(`select count(*) from foody_pedidos where unidade_id = '${UNI_D}' and valor_total is not null;`), "0");
  });
});
