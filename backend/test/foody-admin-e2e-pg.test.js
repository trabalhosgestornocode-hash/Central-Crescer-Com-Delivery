// Administração Foody PONTA A PONTA sobre Postgres LOCAL e DESCARTÁVEL (schema real base + 068..146): rotas HTTP REAIS
// (criarFoodyAdminRouter) → serviço → repositório → funções/triggers do banco, com a plataforma real (organizacoes/unidades/
// usuarios_organizacoes). A coleta é a sync REAL com a API Foody FALSA, rodada à parte — a tela nunca a dispara.
// Só roda com CHECKLIST_PERFIL_PG_URL apontando para host local; caso contrário é PULADO. Dados 100% fictícios.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { motivoPular, criarBancoDescartavel, psqlSync } from "./helpers/pg-descartavel.js";
import { construirSchemaReal } from "./helpers/schema-real-pg.js";
import { criarClientePg } from "./helpers/pg-supabase-mini.js";
import { criarRepositorioFoody } from "../src/modules/foody/foody.repository.js";
import { sincronizarEFechar } from "../src/modules/foody/foody.fechamento.service.js";
import { criarSegurancaFoody } from "../src/modules/foody/foody.seguranca.js";
import { criarClienteFoody } from "../src/modules/foody/foody.client.js";
import { criarFoodyAdminRouter } from "../src/modules/foody-admin/foodyAdmin.routes.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";
import { permissoesDoPapel } from "../src/shared/permissoes.js";
import { pedidoApi, SEGREDO_TESTE, TOKEN_TESTE } from "./helpers/foody-fixtures.js";

const ORG_T = "11111111-1111-4111-8111-111111111111", UNI_T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_D = "22222222-2222-4222-8222-222222222222", UNI_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORG_X = "33333333-3333-4333-8333-333333333333", UNI_X = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ADM_T = "a1000000-0000-4000-8000-000000000001", ADM_D = "a2000000-0000-4000-8000-000000000002";
const OPS_T = "a3000000-0000-4000-8000-000000000003", ADM_X = "a4000000-0000-4000-8000-000000000004";
const D = "2026-10-25";
const AGORA = () => new Date("2026-10-26T15:00:00Z");
// A TELA só com a flag de administração; a SYNC (rodada à parte) com as dela.
const ENV_TELA = { FOODY_CENTRAL_ADMIN_ENABLED: "true", FOODY_CENTRAL_SECRET: SEGREDO_TESTE };
const ENV_SYNC = { FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_UNIDADES: UNI_T, FOODY_CENTRAL_COMPARTILHAMENTO_ENABLED: "true" };

describe("administração Foody ponta a ponta — HTTP real + Postgres real", { skip: motivoPular, timeout: 900_000 }, () => {
  let b, db, servidor, base, chamadasApi = 0, conexaoId, destinoId;
  const seguranca = criarSegurancaFoody(SEGREDO_TESTE);
  const lista = [
    pedidoApi({ uid: "s1", orderDetails: "1x Sub Frango Teriyaki 15cm", courierFee: 10, orderTotal: 40, date: `${D}T11:00:00-03:00` }),
    pedidoApi({ uid: "c1", orderDetails: "1x Açaí Premium 500ml", courierFee: 7, orderTotal: 30, date: `${D}T12:00:00-03:00` }),
    pedidoApi({ uid: "t1", orderDetails: "1x Sub Frango Teriyaki 15cm\n1x Produto Novo Misterioso", courierFee: 9, orderTotal: 55, date: `${D}T13:00:00-03:00` }),
  ];
  const criarCliente = ({ token }) => criarClienteFoody({ token, esperar: async () => {},
    fetch: async () => { chamadasApi += 1; return token === TOKEN_TESTE ? { ok: true, status: 200, json: async () => structuredClone(lista) } : { ok: false, status: 401, json: async () => ({}) }; } });
  const ciclo = () => sincronizarEFechar({ organizacaoId: ORG_T, unidadeId: UNI_T, competencia: D },
    { env: ENV_SYNC, repo: criarRepositorioFoody(db), seguranca, criarCliente, agora: AGORA, log: () => {} });
  const q = (texto) => { const r = psqlSync(b.url, texto); assert.equal(r.ok, true, r.err); return r.out.trim(); };
  const ativo = (uid) => q(`select unidade_id || '|' || operacao || '|' || coalesce(valor_total::text, '-') from foody_pedidos where foody_uid = '${uid}' and roteamento_ativo;`);

  const comoT = { perfil: ADM_T, org: ORG_T, unidade: UNI_T };
  const comoD = { perfil: ADM_D, org: ORG_D, unidade: UNI_D };
  const respostas = [];
  async function api(metodo, caminho, { como = comoT, corpo } = {}) {
    const headers = { "content-type": "application/json" };
    for (const [k, v] of Object.entries(como)) if (v) headers[`x-teste-${k}`] = String(v);
    const r = await fetch(`${base}/api/v1/integracoes/foody${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const texto = await r.text();
    respostas.push(texto);
    return { status: r.status, json: texto ? JSON.parse(texto) : null };
  }

  before(async () => {
    b = criarBancoDescartavel("foody149e2e");
    assert.deepEqual(construirSchemaReal(b.url), []);
    for (const [org, uni, nome] of [[ORG_T, UNI_T, "Titular"], [ORG_D, UNI_D, "Destino"], [ORG_X, UNI_X, "Terceira"]]) {
      q(`insert into organizacoes (id, nome) values ('${org}', 'Org ${nome}');
         insert into unidades (id, organizacao_id, nome) values ('${uni}', '${org}', 'Loja ${nome}');`);
    }
    for (const [pid, org, papel] of [[ADM_T, ORG_T, "organization_admin"], [ADM_D, ORG_D, "organization_admin"], [OPS_T, ORG_T, "unit_manager"], [ADM_X, ORG_X, "organization_admin"]]) {
      q(`insert into auth.users (id, email) values ('${pid}', 'u${pid.slice(0, 4)}@teste.invalid');
         insert into perfis (id, nome, email) values ('${pid}', 'perfil', 'u${pid.slice(0, 4)}@teste.invalid');
         insert into perfis_operacionais (id, conta_id, nome) values ('${pid}', '${pid}', 'perfil');
         insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${pid}', '${pid}', '${org}', '${papel}');`);
    }
    // O admin da titular também é membro (NÃO admin) do destino: pode PROPOR para lá, não pode APROVAR por lá.
    q(`insert into usuarios_organizacoes (usuario_id, perfil_id, organizacao_id, papel) values ('${ADM_T}', '${ADM_T}', '${ORG_D}', 'operations');`);
    db = criarClientePg(b.url);
    const app = express();
    app.use(express.json());
    app.use("/api/v1", (req, _res, next) => {
      const h = (k) => req.headers[`x-teste-${k}`];
      const papel = h("papel") ?? "organization_admin";
      req.user = { id: `u-${h("perfil")}` };
      req.tenant = { organizacaoId: h("org"), unidadeId: h("unidade") || null };
      req.acesso = { perfilId: h("impersonando") ? null : h("perfil"), papel, permissoes: permissoesDoPapel(papel), modulos: [],
        impersonando: Boolean(h("impersonando")), empresa: { id: h("org"), nome: "x", status: "ativa" } };
      next();
    });
    app.use("/api/v1/integracoes/foody", criarFoodyAdminRouter({ db, env: ENV_TELA, agora: AGORA }));
    app.use(errorHandler);
    servidor = app.listen(0);
    await new Promise((r) => servidor.once("listening", r));
    base = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(() => { servidor?.close(); b?.derrubar?.(); });

  test("cadastro pela tela: token só cifrado no banco (AAD da unidade), nada em claro; nasce PAUSADA; ativar NÃO coleta", async () => {
    assert.equal((await api("POST", "/conexao", { como: { ...comoT, perfil: OPS_T, papel: "unit_manager" }, corpo: { token: TOKEN_TESTE } })).status, 403);
    const r = await api("POST", "/conexao", { corpo: { token: TOKEN_TESTE } });
    assert.equal(r.status, 201, JSON.stringify(r.json)); assert.equal(r.json.data.status, "PAUSADA");
    conexaoId = r.json.data.conexaoId;
    const cif = q(`select token_cifrado from foody_conexoes where id = '${conexaoId}';`);
    assert.ok(!cif.includes(TOKEN_TESTE)); assert.equal(seguranca.decifrarToken(cif, UNI_T), TOKEN_TESTE);
    assert.equal(q(`select count(*) from foody_conexoes_eventos where conexao_id = '${conexaoId}' and position('${TOKEN_TESTE}' in coalesce(motivo, '') || coalesce(token_impressao, '')) > 0;`), "0");
    const a = await api("POST", "/conexao/ativar");
    assert.equal(a.json.data.status, "ATIVA");
    assert.equal(chamadasApi, 0, "nenhuma chamada à API Foody pela tela");
    assert.equal(q("select count(*) from foody_sync_execucoes;"), "0"); assert.equal(q("select count(*) from foody_pedidos;"), "0");
    const e = (await api("GET", "/estado")).json.data;
    assert.equal(e.conexao.status, "ATIVA"); assert.equal(e.sincronizacao.coletaHabilitada, false);
    assert.deepEqual(e.eventos.filter((x) => x.tipo === "conexao").map((x) => x.evento), ["ATIVADA", "CADASTRADA"]);
  });

  test("proposta pela titular, aprovação no contexto do destino (ato separado), nomes reais na tela", async () => {
    const possiveis = (await api("GET", "/destinos-possiveis")).json.data;
    assert.deepEqual(possiveis, [{ organizacaoId: ORG_D, nome: "Org Destino", unidades: [{ id: UNI_D, nome: "Loja Destino" }] }]);
    const p = await api("POST", "/compartilhamentos", { corpo: { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" } });
    assert.equal(p.status, 201, JSON.stringify(p.json)); destinoId = p.json.data.id;
    // Membro do destino, mas não admin de lá: o banco recusa a aprovação mesmo no contexto do destino.
    const falsa = await api("POST", `/compartilhamentos/${destinoId}/aprovar`, { como: { perfil: ADM_T, org: ORG_D, unidade: UNI_D, papel: "organization_admin" } });
    assert.equal(falsa.status, 403, JSON.stringify(falsa.json));
    const eD = (await api("GET", "/estado", { como: comoD })).json.data.compartilhamentos[0];
    assert.deepEqual([eD.papel, eD.estado, eD.podeAprovar, eD.titular.organizacao, eD.titular.unidade], ["destino", "PENDENTE", true, "Org Titular", "Loja Titular"]);
    const a = await api("POST", `/compartilhamentos/${destinoId}/aprovar`, { como: comoD });
    assert.equal(a.status, 200, JSON.stringify(a.json)); assert.equal(a.json.data.estado, "ATIVO");
    assert.equal(q(`select count(*) from foody_destinos_eventos where destino_id = '${destinoId}';`) >= "4", true);
  });

  test("sync à parte distribui; triagem pelo destino com motivo; próxima sync aplica; nunca ativo em duas unidades", async () => {
    await ciclo();
    assert.equal(ativo("c1"), `${UNI_D}|acai_no_grau|30.00`); assert.equal(ativo("t1"), `${UNI_T}|triagem|-`);
    const dias = (await api("GET", `/conexoes/${conexaoId}/triagem/dias`, { como: comoD })).json.data;
    assert.deepEqual(dias, [{ competencia: D, quantidade: 1 }]);
    const l = (await api("GET", `/conexoes/${conexaoId}/triagem?competencia=${D}`, { como: comoD })).json.data;
    assert.equal(l.length, 1); assert.deepEqual(l[0].linhasSemEvidencia, ["produto novo misterioso"]);
    assert.ok(!JSON.stringify(l).match(/55|valor|entregador/i), "triagem sem valor nem dado de entregador");
    const terceira = await api("GET", `/conexoes/${conexaoId}/triagem?competencia=${D}`, { como: { perfil: ADM_X, org: ORG_X, unidade: UNI_X } });
    assert.equal(terceira.status, 403);
    const dec = await api("POST", `/conexoes/${conexaoId}/triagem/t1/decisao`, { como: comoD, corpo: { operacao: "acai_no_grau", motivo: "conferido no Gestor" } });
    assert.equal(dec.status, 201, JSON.stringify(dec.json));
    const hist = (await api("GET", `/conexoes/${conexaoId}/triagem/decisoes`)).json.data;
    assert.deepEqual(hist.map((h) => [h.foodyUid, h.operacao, h.porVoce]), [["t1", "acai_no_grau", false]]);
    await ciclo();
    assert.equal(ativo("t1"), `${UNI_D}|acai_no_grau|55.00`);
    assert.equal(q(`select count(*) from (select conexao_id, foody_uid from foody_pedidos where roteamento_ativo group by 1, 2 having count(*) > 1) x;`), "0");
  });

  test("impersonação só consulta; revogação pela titular derruba a distribuição; token não troca durante o vínculo", async () => {
    const imp = { org: ORG_T, unidade: UNI_T, impersonando: "1" };
    assert.equal((await api("GET", "/estado", { como: imp })).status, 200);
    assert.equal((await api("POST", `/compartilhamentos/${destinoId}/revogar`, { como: imp, corpo: { motivo: "suporte" } })).status, 403);
    const troca = await api("POST", "/conexao/token", { corpo: { token: "outro_token_TESTE_123456" } });
    assert.equal(troca.status, 409); assert.equal(troca.json.codigo, "COMPARTILHAMENTO_VIVO");
    const rev = await api("POST", `/compartilhamentos/${destinoId}/revogar`, { corpo: { motivo: "encerramento da parceria" } });
    assert.equal(rev.status, 200, JSON.stringify(rev.json)); assert.equal(rev.json.data.estado, "REVOGADO");
    await ciclo();
    assert.equal(ativo("c1"), `${UNI_T}|acai_no_grau|-`);
    assert.equal(q(`select count(*) from foody_pedidos where unidade_id = '${UNI_D}' and roteamento_ativo;`), "0");
    const r = await api("POST", "/conexao/revogar", { corpo: { motivo: "fim do piloto" } });
    assert.equal(r.json.data.status, "REVOGADA");
  });

  test("nenhuma resposta HTTP carregou o token, o texto cifrado ou um id de perfil de outra pessoa", () => {
    const tudo = respostas.join("\n");
    assert.ok(!tudo.includes(TOKEN_TESTE)); assert.ok(!/"k1:|token_cifrado|tokenCifrado/.test(tudo));
    const vazou = respostas.filter((t) => t.includes(ADM_D) || t.includes(ADM_X));
    assert.deepEqual(vazou, [], "perfis aparecem só como você/outro");
  });
});
