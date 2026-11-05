// Administração da integração Foody pela tela (149) — rotas REAIS (criarFoodyAdminRouter) sobre o banco FALSO com o mesmo
// contrato da função foody_conexao_administrar. A versão real do banco é exercitada em foody-admin-pg.test.js.
// Cobre: flags (administração ≠ sincronização), permissões, impersonação, proteção do token, ciclo da conexão, dupla contagem,
// compartilhamento (proposta restrita, dois atos, mesma pessoa), isolamento entre empresas e triagem.
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { criarFoodyAdminRouter } from "../src/modules/foody-admin/foodyAdmin.routes.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";
import { permissoesDoPapel } from "../src/shared/permissoes.js";
import { criarSegurancaFoody } from "../src/modules/foody/foody.seguranca.js";
import { criarFakeDb } from "./helpers/fake-db-foody.js";
import { SEGREDO_TESTE } from "./helpers/foody-fixtures.js";

const ORG_T = "11111111-1111-4111-8111-111111111111", UNI_T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";   // titular (Subway)
const UNI_T2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";                                                // outra unidade da titular
const ORG_D = "22222222-2222-4222-8222-222222222222", UNI_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";   // destino (Açaí)
const ORG_X = "33333333-3333-4333-8333-333333333333", UNI_X = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";   // terceira, sem vínculo
const ADM_T = "a1000000-0000-4000-8000-000000000001", ADM_D = "a2000000-0000-4000-8000-000000000002";
const DUPLO = "a5000000-0000-4000-8000-000000000005", GER_T = "a3000000-0000-4000-8000-000000000003";
const ADM_X = "a4000000-0000-4000-8000-000000000004";
const TOKEN = "foody_tok_TESTE_nao_real_0123456789";
const TOKEN2 = "foody_tok_TESTE_outro_9876543210";

const NOMES_ORG = { [ORG_T]: "Grupo Titular", [ORG_D]: "Açaí Destino", [ORG_X]: "Empresa Terceira" };
const NOMES_UNI = { [UNI_T]: "Loja Titular", [UNI_T2]: "Loja Titular 2", [UNI_D]: "Loja Açaí", [UNI_X]: "Loja Terceira" };
const UNIS_DA_ORG = { [ORG_T]: [UNI_T, UNI_T2], [ORG_D]: [UNI_D], [ORG_X]: [UNI_X] };
// Vínculos ATIVOS (qualquer papel) — o que a tela usa para listar destinos possíveis.
const MEMBROS = { [ADM_T]: [ORG_T, ORG_D], [ADM_D]: [ORG_D], [DUPLO]: [ORG_T, ORG_D], [GER_T]: [ORG_T], [ADM_X]: [ORG_X] };

const plataforma = {
  nomes: async ({ organizacoes, unidades }) => ({ organizacoes: new Map(organizacoes.map((o) => [o, NOMES_ORG[o]])), unidades: new Map(unidades.map((u) => [u, NOMES_UNI[u]])) }),
  organizacoesDoPerfil: async (p) => (MEMBROS[p] ?? []).map((o) => ({ id: o, nome: NOMES_ORG[o] })),
  unidadesDaOrganizacao: async (o) => (UNIS_DA_ORG[o] ?? []).map((u) => ({ id: u, nome: NOMES_UNI[u] })),
};

let db, env, servidor, base, chamadasExternas, eventos, rodada = 0;
const fetchOriginal = globalThis.fetch;

let auditoriaFalha = 0;
function montar() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", (req, _res, next) => {
    const h = (k) => req.headers[`x-teste-${k}`];
    const papel = h("papel") ?? "organization_admin";
    req.user = { id: `u-${rodada}-${h("perfil")}` };
    req.tenant = { organizacaoId: h("org"), unidadeId: h("unidade") || null };
    req.acesso = { perfilId: h("impersonando") ? null : h("perfil"), papel, permissoes: permissoesDoPapel(papel), modulos: [],
      impersonando: Boolean(h("impersonando")), impersonadoPor: h("impersonando") ? "super" : null, empresa: { id: h("org"), nome: "x", status: "ativa" } };
    next();
  });
  app.use("/api/v1/integracoes/foody", criarFoodyAdminRouter({ db, env, plataforma, seguranca: () => criarSegurancaFoody(env.FOODY_CENTRAL_SECRET),
    agora: () => new Date("2026-11-05T12:00:00Z"),
    auditoria: async (e) => { if (auditoriaFalha > 0) { auditoriaFalha--; return false; } eventos.push(structuredClone(e)); return true; },
    auditoriaRegistrada: async (_acao, _entidade, id) => eventos.some((x) => x.entidadeId === id) }));
  app.use(errorHandler);
  return app;
}

const comoT = { perfil: ADM_T, org: ORG_T, unidade: UNI_T };
const comoD = { perfil: ADM_D, org: ORG_D, unidade: UNI_D };
const comoX = { perfil: ADM_X, org: ORG_X, unidade: UNI_X };
async function api(metodo, caminho, { como = comoT, corpo } = {}) {
  const headers = { "content-type": "application/json" };
  for (const [k, v] of Object.entries(como)) if (v !== undefined && v !== null) headers[`x-teste-${k}`] = String(v);
  const r = await fetchOriginal(`${base}/api/v1/integracoes/foody${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const texto = await r.text();
  for (const perfil of [ADM_T, ADM_D, DUPLO, GER_T, ADM_X]) assert.ok(!texto.includes(perfil), `${metodo} ${caminho}: id de perfil na resposta`);
  let json = null; try { json = JSON.parse(texto); } catch { /* corpo vazio */ }
  return { status: r.status, json, texto, cache: r.headers.get("cache-control") };
}
const cadastrar = (como = comoT, token = TOKEN) => api("POST", "/conexao", { como, corpo: { token, pontoColetaEsperado: "Loja Titular" } });

before(async () => {
  // Qualquer fetch que não seja para o servidor local de teste = tentativa de coleta (proibida nesta camada).
  globalThis.fetch = (url, ...r) => {
    if (!String(url).startsWith("http://127.0.0.1:")) chamadasExternas.push(String(url));
    return fetchOriginal(url, ...r);
  };
});
after(() => { globalThis.fetch = fetchOriginal; servidor?.close(); });
beforeEach(async () => {
  chamadasExternas = []; eventos = []; rodada += 1;
  db = criarFakeDb({ unidades: { [UNI_T]: ORG_T, [UNI_T2]: ORG_T, [UNI_D]: ORG_D, [UNI_X]: ORG_X },
    admins: [[ADM_T, ORG_T], [ADM_D, ORG_D], [DUPLO, ORG_T], [DUPLO, ORG_D], [ADM_X, ORG_X]] });
  env = { FOODY_CENTRAL_ADMIN_ENABLED: "true", FOODY_CENTRAL_SECRET: SEGREDO_TESTE };   // SEM nenhuma flag de sincronização
  servidor?.close();
  servidor = montar().listen(0);
  await new Promise((r) => servidor.once("listening", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

describe("flags: administração separada da sincronização", () => {
  test("administração desligada: tudo 404 (sem revelar nada), menos as revogações", async () => {
    env.FOODY_CENTRAL_ADMIN_ENABLED = "true";
    assert.equal((await cadastrar()).status, 201);
    env.FOODY_CENTRAL_ADMIN_ENABLED = "false";
    for (const [m, c] of [["GET", "/estado"], ["POST", "/conexao/ativar"], ["GET", "/destinos-possiveis"]]) {
      const r = await api(m, c);
      assert.equal(r.status, 404, `${m} ${c}`); assert.equal(r.json.codigo, "DESLIGADO");
    }
    assert.equal((await cadastrar()).status, 404);
    const rev = await api("POST", "/conexao/revogar", { corpo: { motivo: "desligando a integração" } });
    assert.equal(rev.status, 200, "revogar funciona com a administração desligada"); assert.equal(rev.json.data.status, "REVOGADA");
  });
  test("ativar a conexão com a sincronização desligada NÃO coleta nada: nenhuma chamada externa, nenhuma execução", async () => {
    await cadastrar();
    const r = await api("POST", "/conexao/ativar");
    assert.equal(r.status, 200); assert.equal(r.json.data.status, "ATIVA");
    const e = await api("GET", "/estado");
    assert.deepEqual(e.json.data.sincronizacao, { coletaHabilitada: false, agendadorHabilitado: false, distribuicaoHabilitada: false });
    assert.deepEqual(chamadasExternas, []);
    assert.equal(db.tabelas.foody_sync_execucoes.length, 0); assert.equal(db.tabelas.foody_pedidos.length, 0);
  });
  test("mesmo com as flags de sincronização LIGADAS, nenhuma rota da administração dispara coleta", async () => {
    Object.assign(env, { FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_UNIDADES: UNI_T, FOODY_CENTRAL_AGENDADOR_ENABLED: "true" });
    await cadastrar(); await api("POST", "/conexao/ativar"); await api("GET", "/estado");
    assert.deepEqual(chamadasExternas, []); assert.equal(db.tabelas.foody_sync_execucoes.length, 0);
    assert.equal((await api("GET", "/estado")).json.data.sincronizacao.coletaHabilitada, true, "a tela só INFORMA o estado da sync");
  });
});

describe("permissões e impersonação", () => {
  test("sem integracoes.gerenciar (viewer, financeiro): 403 em tudo", async () => {
    for (const papel of ["viewer", "finance", "operations"]) {
      assert.equal((await api("GET", "/estado", { como: { ...comoT, papel } })).status, 403, papel);
      assert.equal((await cadastrar({ ...comoT, papel })).status, 403, papel);
    }
  });
  test("gestor de unidade vê o estado (somente leitura) e não executa nenhuma ação", async () => {
    const como = { perfil: GER_T, org: ORG_T, unidade: UNI_T, papel: "unit_manager" };
    const e = await api("GET", "/estado", { como });
    assert.equal(e.status, 200); assert.equal(e.json.data.podeAdministrar, false);
    const r = await cadastrar(como);
    assert.equal(r.status, 403); assert.equal(r.json.codigo, "SEM_PERMISSAO");
    assert.equal(db.tabelas.foody_conexoes.length, 0);
  });
  test("papel de admin na sessão não basta: o banco recusa quem não é admin ATIVO hoje (papel perdido depois do login)", async () => {
    db.papeis.delete(`${ADM_T}|${ORG_T}`);
    const r = await cadastrar();
    assert.equal(r.status, 403); assert.equal(r.json.codigo, "SEM_PERMISSAO"); assert.equal(db.tabelas.foody_conexoes.length, 0);
  });
  test("superadmin em impersonação: consulta o estado, nenhuma escrita (403 antes do serviço)", async () => {
    await cadastrar();
    const imp = { org: ORG_T, unidade: UNI_T, impersonando: "1" };
    const e = await api("GET", "/estado", { como: imp });
    assert.equal(e.status, 200); assert.equal(e.json.data.podeAdministrar, false); assert.equal(e.json.data.impersonando, true);
    for (const [m, c, corpo] of [["POST", "/conexao", { token: TOKEN2 }], ["POST", "/conexao/ativar"], ["POST", "/conexao/revogar", { motivo: "suporte" }],
      ["POST", "/compartilhamentos", { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" }]]) {
      const r = await api(m, c, { como: imp, corpo });
      assert.equal(r.status, 403, `${m} ${c}`);
    }
    assert.equal(db.tabelas.foody_conexoes[0].status, "PAUSADA");
  });
  test("contexto sem unidade (visão consolidada): estado responde, cadastro pede a unidade", async () => {
    const como = { perfil: ADM_T, org: ORG_T };
    assert.equal((await api("GET", "/estado", { como })).json.data.conexao, null);
    const r = await cadastrar(como);
    assert.equal(r.status, 400); assert.equal(r.json.codigo, "SEM_UNIDADE");
  });
});

describe("proteção do token", () => {
  test("o token nunca volta: nem no cadastro, nem no estado, nem na auditoria; no banco só cifrado (AAD da unidade)", async () => {
    const r = await cadastrar();
    assert.equal(r.status, 201); assert.equal(r.cache, "no-store");
    assert.ok(!r.texto.includes(TOKEN)); assert.ok(!/token_cifrado|k1:/.test(r.texto));
    const e = await api("GET", "/estado");
    assert.ok(!e.texto.includes(TOKEN)); assert.ok(!/token_cifrado|tokenCifrado|"k1:/.test(e.texto));
    assert.match(e.json.data.conexao.impressaoFinal, /^[0-9a-f]{4}$/, "só o final da impressão (hash), para conferir");
    const linha = db.tabelas.foody_conexoes[0];
    assert.ok(!JSON.stringify(linha).includes(TOKEN));
    const seg = criarSegurancaFoody(SEGREDO_TESTE);
    assert.equal(seg.decifrarToken(linha.token_cifrado, UNI_T), TOKEN);
    assert.throws(() => seg.decifrarToken(linha.token_cifrado, UNI_T2), "cifrado para uma unidade não abre em outra");
  });
  test("token inválido: 400 sem eco do valor; token na URL não existe como rota", async () => {
    for (const t of ["curto", "tem espaço no meio 123", "", "x".repeat(600)]) {
      const r = await cadastrar(comoT, t);
      assert.equal(r.status, 400, t.slice(0, 20)); assert.equal(r.json.codigo, "TOKEN_INVALIDO");
      if (t) assert.ok(!r.texto.includes(t));
    }
    assert.equal((await api("GET", `/conexao?token=${TOKEN}`)).status, 404);
  });
  test("sem a chave de proteção no ambiente: 503 SEGREDO_AUSENTE e nada é gravado", async () => {
    delete env.FOODY_CENTRAL_SECRET;
    const r = await cadastrar();
    assert.equal(r.status, 503); assert.equal(r.json.codigo, "SEGREDO_AUSENTE"); assert.equal(db.tabelas.foody_conexoes.length, 0);
    assert.equal((await api("GET", "/estado")).json.data.segredoConfigurado, false);
  });
  test("limite de tentativas de token por usuário (429)", async () => {
    const como = { ...comoX, perfil: "a9000000-0000-4000-8000-0000000000aa" };
    let ultimo;
    for (let i = 0; i < 11; i++) ultimo = await cadastrar(como, "curto");
    assert.equal(ultimo.status, 429);
  });
});

describe("ciclo da conexão e auditoria", () => {
  test("cadastrar → PAUSADA; ativar; ativar de novo é SEM_MUDANCA; pausar; revogar exige motivo; reconectar", async () => {
    assert.equal((await cadastrar()).json.data.status, "PAUSADA");
    assert.equal((await cadastrar()).json.codigo, "CONEXAO_EXISTENTE");
    assert.equal((await api("POST", "/conexao/ativar")).json.data.status, "ATIVA");
    assert.equal((await api("POST", "/conexao/ativar")).json.data.resultado, "SEM_MUDANCA");
    assert.equal((await api("POST", "/conexao/pausar", { corpo: { motivo: "conferência" } })).json.data.status, "PAUSADA");
    const semMotivo = await api("POST", "/conexao/revogar", { corpo: {} });
    assert.equal(semMotivo.status, 400); assert.equal(semMotivo.json.codigo, "MOTIVO_INVALIDO");
    assert.equal((await api("POST", "/conexao/revogar", { corpo: { motivo: "token vazado" } })).json.data.status, "REVOGADA");
    assert.equal((await api("POST", "/conexao/ativar")).json.codigo, "CONEXAO_REVOGADA");
    const rec = await cadastrar(comoT, TOKEN2);
    assert.equal(rec.status, 201); assert.equal(rec.json.data.evento, "RECONECTADA");
    const ev = (await api("GET", "/estado")).json.data.eventos.filter((e) => e.tipo === "conexao").map((e) => `${e.evento}:${e.ator}`).reverse();
    assert.deepEqual(ev, ["CADASTRADA:voce", "ATIVADA:voce", "PAUSADA:voce", "REVOGADA:voce", "RECONECTADA:voce"]);
    assert.equal(db.tabelas.foody_conexoes.length, 1, "reconexão reaproveita a linha (histórico preservado)");
  });
  test("a auditoria de uma empresa mostra outro administrador como 'outro', nunca o id", async () => {
    await cadastrar();
    const outro = await api("GET", "/estado", { como: { perfil: DUPLO, org: ORG_T, unidade: UNI_T } });
    assert.equal(outro.json.data.eventos[0].ator, "outro");
    assert.ok(!outro.texto.includes(ADM_T), "nenhum id de perfil sai para a tela");
  });
});

describe("dupla contagem", () => {
  test("a mesma conta (token) não conecta em duas unidades", async () => {
    await cadastrar();
    const r = await cadastrar({ perfil: ADM_T, org: ORG_T, unidade: UNI_T2 });
    assert.equal(r.status, 409); assert.equal(r.json.codigo, "CONTA_JA_CONECTADA");
  });
  test("unidade que é DESTINO vivo não cadastra conexão própria; com compartilhamento vivo o token não troca", async () => {
    await cadastrar(); await api("POST", "/conexao/ativar");
    assert.equal((await api("POST", "/compartilhamentos", { corpo: { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" } })).status, 201);
    const r = await cadastrar(comoD, TOKEN2);
    assert.equal(r.status, 409); assert.equal(r.json.codigo, "DESTINO_VIVO");
    const t = await api("POST", "/conexao/token", { corpo: { token: TOKEN2 } });
    assert.equal(t.status, 409); assert.equal(t.json.codigo, "COMPARTILHAMENTO_VIVO");
    assert.equal((await api("POST", "/conexao/token", { corpo: { token: TOKEN } })).json.data.resultado, "SEM_MUDANCA", "mesmo token: nada muda");
  });
});

describe("compartilhamento entre organizações", () => {
  const propor = (como = comoT, corpo = { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" }) => api("POST", "/compartilhamentos", { como, corpo });
  test("destinos possíveis: só as empresas em que o próprio administrador tem vínculo (nunca a lista da plataforma)", async () => {
    const r = await api("GET", "/destinos-possiveis");
    assert.deepEqual(r.json.data, [{ organizacaoId: ORG_D, nome: "Açaí Destino", unidades: [{ id: UNI_D, nome: "Loja Açaí" }] }]);
    assert.ok(!r.texto.includes("Empresa Terceira"));
    assert.deepEqual((await api("GET", "/destinos-possiveis", { como: comoX })).json.data, []);
  });
  test("proposta para empresa fora da lista é recusada (id arbitrário não passa)", async () => {
    await cadastrar(); await api("POST", "/conexao/ativar");
    const r = await propor(comoT, { organizacaoId: ORG_X, unidadeId: UNI_X, operacao: "acai_no_grau" });
    assert.equal(r.status, 403); assert.equal(r.json.codigo, "DESTINO_NAO_PERMITIDO");
    assert.equal((await propor(comoT, { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "subway" })).json.codigo, "OPERACAO_INVALIDA");
    assert.equal(db.tabelas.foody_conexao_destinos.length, 0);
  });
  test("dois atos: titular propõe, destino aprova no próprio contexto; a titular não aprova pelo destino", async () => {
    await cadastrar(); await api("POST", "/conexao/ativar");
    const p = await propor();
    assert.equal(p.status, 201); assert.equal(p.json.data.estado, "PENDENTE");
    const id = p.json.data.id;
    assert.equal((await api("POST", `/compartilhamentos/${id}/aprovar`)).status, 403, "contexto da titular");
    const eD = (await api("GET", "/estado", { como: comoD })).json.data;
    const v = eD.compartilhamentos.find((x) => x.id === id);
    assert.equal(v.papel, "destino"); assert.equal(v.podeAprovar, true);
    assert.deepEqual([v.titular.organizacao, v.titular.unidade, v.destino.unidade], ["Grupo Titular", "Loja Titular", "Loja Açaí"]);
    const a = await api("POST", `/compartilhamentos/${id}/aprovar`, { como: comoD });
    assert.equal(a.status, 200); assert.equal(a.json.data.estado, "ATIVO");
    const eT = (await api("GET", "/estado")).json.data.compartilhamentos[0];
    assert.deepEqual([eT.papel, eT.estado, eT.mesmaPessoa, eT.podeAprovar], ["titular", "ATIVO", false, false]);
  });
  test("a mesma pessoa, admin legítima das duas, aprova em dois atos e a tela marca 'mesma pessoa'", async () => {
    const duploT = { perfil: DUPLO, org: ORG_T, unidade: UNI_T }, duploD = { perfil: DUPLO, org: ORG_D, unidade: UNI_D };
    await cadastrar(duploT); await api("POST", "/conexao/ativar", { como: duploT });
    const id = (await propor(duploT)).json.data.id;
    assert.equal((await api("POST", `/compartilhamentos/${id}/aprovar`, { como: duploT })).status, 403);
    const eD = (await api("GET", "/estado", { como: duploD })).json.data.compartilhamentos[0];
    assert.equal(eD.propostoPorVoce, true);
    assert.equal((await api("POST", `/compartilhamentos/${id}/aprovar`, { como: duploD })).json.data.estado, "ATIVO");
    assert.equal((await api("GET", "/estado", { como: duploD })).json.data.compartilhamentos[0].mesmaPessoa, true);
  });
  test("revogação: qualquer um dos lados, com motivo; revogar a conexão derruba o compartilhamento", async () => {
    await cadastrar(); await api("POST", "/conexao/ativar");
    const id = (await propor()).json.data.id;
    await api("POST", `/compartilhamentos/${id}/aprovar`, { como: comoD });
    assert.equal((await api("POST", `/compartilhamentos/${id}/revogar`, { como: comoD, corpo: {} })).json.codigo, "MOTIVO_INVALIDO");
    assert.equal((await api("POST", `/compartilhamentos/${id}/revogar`, { como: comoX, corpo: { motivo: "intruso" } })).status, 403);
    await api("POST", "/conexao/revogar", { corpo: { motivo: "encerrando a conta" } });
    assert.equal(db.tabelas.foody_conexao_destinos[0].estado, "REVOGADO");
  });
});

describe("isolamento entre empresas", () => {
  test("terceira empresa não vê nem toca o vínculo, a conexão nem a triagem da outra", async () => {
    await cadastrar(); await api("POST", "/conexao/ativar");
    const id = (await api("POST", "/compartilhamentos", { corpo: { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" } })).json.data.id;
    const eX = await api("GET", "/estado", { como: comoX });
    assert.equal(eX.json.data.conexao, null); assert.deepEqual(eX.json.data.compartilhamentos, []); assert.deepEqual(eX.json.data.eventos, []);
    for (const nome of ["Grupo Titular", "Loja Titular", "Açaí Destino"]) assert.ok(!eX.texto.includes(nome), nome);
    assert.equal((await api("POST", `/compartilhamentos/${id}/aprovar`, { como: comoX })).status, 403);
    const cx = db.tabelas.foody_conexoes[0].id;
    for (const c of ["/triagem/dias", "/triagem/decisoes", "/triagem?competencia=2026-11-04"]) {
      assert.equal((await api("GET", `/conexoes/${cx}${c}`, { como: comoX })).status, 403, c);
    }
    assert.equal((await api("GET", "/conexoes/nao-e-uuid/triagem/dias")).status, 400);
  });
  test("destino PENDENTE ainda não vê a triagem (só depois de aprovar)", async () => {
    await cadastrar(); await api("POST", "/conexao/ativar");
    await api("POST", "/compartilhamentos", { corpo: { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" } });
    const cx = db.tabelas.foody_conexoes[0].id;
    assert.equal((await api("GET", `/conexoes/${cx}/triagem/dias`, { como: comoD })).status, 403);
  });
});

describe("triagem", () => {
  async function cenario() {
    await cadastrar(); await api("POST", "/conexao/ativar");
    const id = (await api("POST", "/compartilhamentos", { corpo: { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" } })).json.data.id;
    await api("POST", `/compartilhamentos/${id}/aprovar`, { como: comoD });
    const cx = db.tabelas.foody_conexoes[0].id;
    for (const [uid, comp, det, mot] of [["t1", "2026-11-04", "produto novo misterioso", "ITEM_DESCONHECIDO"], ["t2", "2026-11-04", null, "CONFLITO"], ["t3", "2026-11-03", "outro novo", "ITEM_DESCONHECIDO"]]) {
      db.tabelas.foody_pedidos.push({ id: uid, organizacao_id: ORG_T, unidade_id: UNI_T, conexao_id: cx, foody_uid: uid, numero_pedido: `#${uid}`, competencia: comp,
        data_hora: `${comp}T12:00:00-03:00`, operacao: "triagem", roteamento_ativo: true, detalhes_pedido: det, triagem_motivo: mot,
        operacao_motivo: "1 por catálogo, 1 desconhecida", catalogo_versao: "2026-11-03.1", situacao: "Finalizado", valor_total: null });
    }
    return cx;
  }
  test("dias com contagem; lista só com o mínimo; decisão justificada vira pendente e entra no histórico", async () => {
    const cx = await cenario();
    assert.deepEqual((await api("GET", `/conexoes/${cx}/triagem/dias`, { como: comoD })).json.data,
      [{ competencia: "2026-11-04", quantidade: 2 }, { competencia: "2026-11-03", quantidade: 1 }]);
    const l = (await api("GET", `/conexoes/${cx}/triagem?competencia=2026-11-04`, { como: comoD })).json.data;
    assert.deepEqual(l.map((x) => [x.foodyUid, x.linhasSemEvidencia]), [["t1", ["produto novo misterioso"]], ["t2", []]]);
    assert.ok(!JSON.stringify(l).match(/valor|pagamento|entregador/i));
    assert.equal((await api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { como: comoD, corpo: { operacao: "acai_no_grau", motivo: "x" } })).json.codigo, "MOTIVO_INVALIDO");
    const d = await api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { como: comoD, corpo: { operacao: "acai_no_grau", motivo: "conferido no Gestor" } });
    assert.equal(d.status, 201); assert.equal(d.json.data.aplicacao, "PROXIMA_SINCRONIZACAO"); assert.equal(d.json.data.competencia, "2026-11-04");
    const l2 = (await api("GET", `/conexoes/${cx}/triagem?competencia=2026-11-04`, { como: comoT })).json.data;
    assert.deepEqual(l2.find((x) => x.foodyUid === "t1").decisaoPendente, { operacao: "acai_no_grau", decididoEm: l2.find((x) => x.foodyUid === "t1").decisaoPendente.decididoEm, porVoce: false });
    const h = (await api("GET", `/conexoes/${cx}/triagem/decisoes`, { como: comoT })).json.data;
    assert.deepEqual(h.map((x) => [x.foodyUid, x.operacao, x.motivo, x.porVoce]), [["t1", "acai_no_grau", "conferido no Gestor", false]]);
    assert.ok(!JSON.stringify(h).includes(ADM_D), "quem decidiu sai só como 'você' ou 'outro'");
    assert.equal((await api("GET", `/conexoes/${cx}/triagem?competencia=04-11-2026`)).json.codigo, "COMPETENCIA_INVALIDA");
  });
  test("auditoria: cada decisão gera UM evento em plataforma_auditoria (org de quem agiu, ator, pedido, decisão, justificativa, hora) sem dado comercial", async () => {
    const cx = await cenario();
    const dD = await api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { como: comoD, corpo: { operacao: "acai_no_grau", motivo: "conferido no Gestor" } });
    const dT = await api("POST", `/conexoes/${cx}/triagem/t3/decisao`, { como: comoT, corpo: { operacao: "subway", motivo: "Subway conferido no Excel" } });
    assert.equal(eventos.length, 2);
    const [eD, eT] = eventos;
    assert.deepEqual([eD.acao, eD.atorTipo, eD.entidade, eD.entidadeId, eD.organizacaoId, eD.perfilId], ["foody.triagem_decidida", "usuario", "foody_triagem_decisoes", dD.json.data.id, ORG_D, ADM_D]);
    assert.deepEqual(eD.detalhes, { conexao_id: cx, organizacao_titular_id: ORG_T, unidade_id: UNI_T, foody_uid: "t1", competencia: "2026-11-04",
      operacao_decidida: "acai_no_grau", motivo: "conferido no Gestor", catalogo_versao: eD.detalhes.catalogo_versao, decidido_em: eD.detalhes.decidido_em });
    assert.ok(eD.detalhes.decidido_em && /^\d{4}-\d{2}-\d{2}\.\d+$/.test(eD.detalhes.catalogo_versao));
    assert.deepEqual([eT.organizacaoId, eT.perfilId, eT.entidadeId, eT.detalhes.operacao_decidida], [ORG_T, ADM_T, dT.json.data.id, "subway"], "cada empresa audita no próprio tenant");
    assert.doesNotMatch(JSON.stringify(eventos), /misterioso|valor|pagamento|entregador|token/i, "nada de item, valor ou segredo no evento");
    const linha = db.tabelas.foody_triagem_decisoes.find((x) => x.id === dD.json.data.id);
    assert.deepEqual([linha.decidido_por, linha.motivo, linha.operacao_decidida], [ADM_D, "conferido no Gestor", "acai_no_grau"], "a tabela imutável continua sendo a fonte");
  });
  test("reenvio idêntico (clique repetido) não duplica linha nem evento; decisão diferente grava e audita de novo", async () => {
    const cx = await cenario();
    const corpo = { operacao: "subway", motivo: "Subway conferido no Excel" };
    const a = await api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { como: comoT, corpo });
    const b = await api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { como: comoT, corpo: { ...corpo, motivo: "  Subway conferido no Excel " } });
    assert.deepEqual([a.status, a.json.data.repetida, b.status, b.json.data.repetida, b.json.data.id], [201, false, 201, true, a.json.data.id]);
    assert.equal(db.tabelas.foody_triagem_decisoes.length, 1); assert.equal(eventos.length, 1);
    const c = await api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { como: comoT, corpo: { operacao: "subway", motivo: "revisado de novo no Excel" } });
    const d = await api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { como: comoD, corpo });
    assert.deepEqual([c.json.data.repetida, d.json.data.repetida], [false, false], "outra justificativa ou outra pessoa = nova decisão");
    assert.equal(db.tabelas.foody_triagem_decisoes.length, 3); assert.equal(eventos.length, 3);
  });
  test("recusadas (impersonação, terceira empresa, gestor, sem justificativa, pedido inexistente) não gravam linha nem evento", async () => {
    const cx = await cenario();
    const corpo = { operacao: "subway", motivo: "Subway conferido no Excel" };
    for (const [como, status] of [[{ org: ORG_T, unidade: UNI_T, impersonando: "1" }, 403], [comoX, 403],
      [{ perfil: GER_T, org: ORG_T, unidade: UNI_T, papel: "unit_manager" }, 403]]) {
      assert.equal((await api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { como, corpo })).status, status, JSON.stringify(como));
    }
    assert.equal((await api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { corpo: { operacao: "subway" } })).json.codigo, "MOTIVO_INVALIDO");
    assert.equal((await api("POST", `/conexoes/${cx}/triagem/nao-existe/decisao`, { corpo })).status, 404);
    assert.deepEqual([db.tabelas.foody_triagem_decisoes.length, eventos.length], [0, 0]);
  });
  test("compatibilidade: decisão antiga (sem evento, como as 3 de 02/11 em produção) segue válida; reenviá-la igual não duplica", async () => {
    const cx = await cenario();
    db.tabelas.foody_triagem_decisoes.push({ id: "dec-antiga", conexao_id: cx, organizacao_id: ORG_T, unidade_id: UNI_T, foody_uid: "t1",
      operacao_decidida: "subway", decidido_por: ADM_T, motivo: "itens da subway", catalogo_versao: "2026-11-03.1", decidido_em: "2026-11-05T00:55:22Z" });
    const h = (await api("GET", `/conexoes/${cx}/triagem/decisoes`)).json.data;
    assert.deepEqual(h.map((x) => [x.foodyUid, x.operacao, x.porVoce]), [["t1", "subway", true]]);
    const r = await api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { corpo: { operacao: "subway", motivo: "itens da subway" } });
    assert.deepEqual([r.json.data.repetida, r.json.data.id, db.tabelas.foody_triagem_decisoes.length], [true, "dec-antiga", 1]);
    assert.deepEqual([r.json.data.auditoria, eventos.length], ["REGISTRADA", 1], "o reenvio pela mesma pessoa completa o rastro que faltava");
    const r2 = await api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { corpo: { operacao: "subway", motivo: "itens da subway" } });
    assert.deepEqual([r2.json.data.auditoria, eventos.length, db.tabelas.foody_triagem_decisoes.length], ["JA_REGISTRADA", 1, 1]);
  });
  test("concorrência: dois POST idênticos SIMULTÂNEOS gravam UMA decisão e UM evento (o segundo volta como repetida)", async () => {
    const cx = await cenario();
    const corpo = { operacao: "subway", motivo: "Subway conferido no Excel" };
    const rs = await Promise.all([1, 2, 3].map(() => api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { como: comoT, corpo })));
    assert.deepEqual(rs.map((r) => r.status), [201, 201, 201]);
    assert.deepEqual(rs.map((r) => r.json.data.repetida).sort(), [false, true, true]);
    assert.equal(new Set(rs.map((r) => r.json.data.id)).size, 1);
    assert.deepEqual([db.tabelas.foody_triagem_decisoes.length, eventos.length], [1, 1]);
  });
  test("auditoria confiável: falha na gravação do evento → resposta 'PENDENTE' e o reenvio idêntico grava o evento (sem duplicar)", async () => {
    const cx = await cenario();
    const corpo = { operacao: "subway", motivo: "Subway conferido no Excel" };
    auditoriaFalha = 1;
    const a = await api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { como: comoT, corpo });
    assert.deepEqual([a.status, a.json.data.auditoria, eventos.length, db.tabelas.foody_triagem_decisoes.length], [201, "PENDENTE", 0, 1]);
    const b = await api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { como: comoT, corpo });
    assert.deepEqual([b.json.data.repetida, b.json.data.auditoria, eventos.length, db.tabelas.foody_triagem_decisoes.length], [true, "REGISTRADA", 1, 1]);
    assert.equal(eventos[0].entidadeId, a.json.data.id);
    const c = await api("POST", `/conexoes/${cx}/triagem/t1/decisao`, { como: comoT, corpo });
    assert.deepEqual([c.json.data.auditoria, eventos.length], ["JA_REGISTRADA", 1]);
  });
});

describe("revisão final: revogar com a administração DESLIGADA continua seguro", () => {
  async function cenarioComVinculo() {
    await cadastrar(); await api("POST", "/conexao/ativar");
    const id = (await api("POST", "/compartilhamentos", { corpo: { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" } })).json.data.id;
    await api("POST", `/compartilhamentos/${id}/aprovar`, { como: comoD });
    env.FOODY_CENTRAL_ADMIN_ENABLED = "false";
    return id;
  }
  test("desligada: só as revogações respondem; aprovar, propor, triagem, estado e cadastro = 404", async () => {
    const id = await cenarioComVinculo();
    const cx = db.tabelas.foody_conexoes[0].id;
    for (const [m, c, como, corpo] of [["GET", "/estado", comoT], ["POST", `/compartilhamentos/${id}/aprovar`, comoD],
      ["POST", "/compartilhamentos", comoT, { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" }],
      ["GET", `/conexoes/${cx}/triagem/dias`, comoD], ["POST", `/conexoes/${cx}/triagem/t1/decisao`, comoD, { operacao: "subway", motivo: "conferido" }],
      ["POST", "/conexao/ativar", comoT], ["POST", "/conexao/pausar", comoT], ["POST", "/conexao/token", comoT, { token: TOKEN2 }]]) {
      const r = await api(m, c, { como, corpo });
      assert.equal(r.status, 404, `${m} ${c}`);
    }
    assert.equal(db.tabelas.foody_conexoes[0].status, "ATIVA", "nada mudou");
  });
  test("desligada: revogar o compartilhamento exige admin do vínculo e motivo; recusa terceira empresa, gestor e impersonação", async () => {
    const id = await cenarioComVinculo();
    assert.equal((await api("POST", `/compartilhamentos/${id}/revogar`, { como: comoX, corpo: { motivo: "intruso" } })).status, 403);
    assert.equal((await api("POST", `/compartilhamentos/${id}/revogar`, { como: { org: ORG_D, unidade: UNI_D, impersonando: "1" }, corpo: { motivo: "suporte" } })).status, 403);
    assert.equal((await api("POST", `/compartilhamentos/${id}/revogar`, { como: { perfil: GER_T, org: ORG_T, unidade: UNI_T, papel: "unit_manager" }, corpo: { motivo: "gestor" } })).status, 403);
    assert.equal((await api("POST", `/compartilhamentos/${id}/revogar`, { como: comoD, corpo: {} })).json.codigo, "MOTIVO_INVALIDO");
    assert.equal(db.tabelas.foody_conexao_destinos[0].estado, "ATIVO", "nenhuma tentativa recusada mudou o vínculo");
    const r = await api("POST", `/compartilhamentos/${id}/revogar`, { como: comoD, corpo: { motivo: "encerrando pelo destino" } });
    assert.equal(r.status, 200); assert.equal(r.json.data.estado, "REVOGADO");
    assert.deepEqual(Object.keys(r.json.data).sort(), ["aprovadoDestinoEm", "aprovadoTitularEm", "conexaoId", "estado", "id", "operacao", "revogadoEm", "revogadoMotivo"]);
  });
  test("desligada: revogar a conexão recusa gestor, impersonação e outra empresa; o admin revoga e o vínculo cai junto", async () => {
    await cenarioComVinculo();
    assert.equal((await api("POST", "/conexao/revogar", { como: { perfil: GER_T, org: ORG_T, unidade: UNI_T, papel: "unit_manager" }, corpo: { motivo: "gestor" } })).status, 403);
    assert.equal((await api("POST", "/conexao/revogar", { como: { org: ORG_T, unidade: UNI_T, impersonando: "1" }, corpo: { motivo: "suporte" } })).status, 403);
    assert.equal((await api("POST", "/conexao/revogar", { como: { perfil: ADM_X, org: ORG_X, unidade: UNI_T }, corpo: { motivo: "intruso" } })).status, 403);
    assert.equal((await api("POST", "/conexao/revogar", { como: comoD, corpo: { motivo: "destino tenta" } })).json.codigo, "SEM_CONEXAO", "o destino não revoga a conexão da titular");
    assert.equal(db.tabelas.foody_conexoes[0].status, "ATIVA");
    const r = await api("POST", "/conexao/revogar", { corpo: { motivo: "encerrando" } });
    assert.equal(r.json.data.status, "REVOGADA"); assert.equal(db.tabelas.foody_conexao_destinos[0].estado, "REVOGADO");
    assert.equal(chamadasExternas.length, 0);
  });
  test("migrations ainda NÃO aplicadas (produção logo após o merge): revogar responde 404 NAO_INSTALADA, nunca 500 nem SQL", async () => {
    const erroPg = (code) => ({ data: null, error: { code, message: "Could not find the table 'public.foody_conexao_destinos' in the schema cache" } });
    const semTabela = {
      from: () => {
        const b = { select: () => b, eq: () => b, in: () => b, order: () => b, range: () => b, limit: () => b, update: () => b,
          maybeSingle: async () => erroPg("PGRST205"), single: async () => erroPg("PGRST205"), then: (ok, ko) => Promise.resolve(erroPg("PGRST205")).then(ok, ko) };
        return b;
      },
      rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.foody_conexao_administrar" } }),
    };
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: `u-nao-instalada-${rodada}` }; req.tenant = { organizacaoId: ORG_T, unidadeId: UNI_T };
      req.acesso = { perfilId: ADM_T, papel: "organization_admin", permissoes: permissoesDoPapel("organization_admin"), impersonando: false, empresa: { id: ORG_T } };
      next();
    });
    app.use("/f", criarFoodyAdminRouter({ db: semTabela, env: {}, plataforma })); app.use(errorHandler);
    const s = app.listen(0); await new Promise((r) => s.once("listening", r));
    try {
      const u = `http://127.0.0.1:${s.address().port}/f`;
      const id = "dddddddd-0000-4000-8000-000000000001";
      for (const [c, corpo] of [["/conexao/revogar", { motivo: "desligando" }], [`/compartilhamentos/${id}/revogar`, { motivo: "desligando" }]]) {
        const r = await fetchOriginal(u + c, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });
        const t = await r.text();
        assert.equal(r.status, 404, `${c}: ${t}`); assert.equal(JSON.parse(t).codigo, "NAO_INSTALADA");
        assert.doesNotMatch(t, /PGRST|schema cache|foody_/);
      }
      assert.equal((await fetchOriginal(u + "/estado")).status, 404, "estado: flag desligada");
    } finally { s.close(); }
  });
});

describe("revisão final: nada de token, pessoa ou dado comercial da OUTRA organização", () => {
  test("o destino vê só nomes do vínculo: sem impressão, ponto de coleta, erro ou eventos da conexão da titular", async () => {
    await api("POST", "/conexao", { corpo: { token: TOKEN, pontoColetaEsperado: "PONTO-PRIVADO-TITULAR" } });
    await api("POST", "/conexao/ativar");
    const id = (await api("POST", "/compartilhamentos", { corpo: { organizacaoId: ORG_D, unidadeId: UNI_D, operacao: "acai_no_grau" } })).json.data.id;
    await api("POST", `/compartilhamentos/${id}/aprovar`, { como: comoD });
    db.tabelas.foody_conexoes[0].ultimo_erro_codigo = "ERRO_PRIVADO_T";
    const impT = (await api("GET", "/estado")).json.data.conexao.impressaoFinal;
    const eD = await api("GET", "/estado", { como: comoD });
    assert.equal(eD.json.data.conexao, null);
    for (const segredo of ["PONTO-PRIVADO-TITULAR", "ERRO_PRIVADO_T", TOKEN, `"impressaoFinal":"${impT}"`]) assert.ok(!eD.texto.includes(segredo), segredo);
    assert.ok(!eD.json.data.eventos.some((e) => e.tipo === "conexao"), "eventos da conexão da titular ficam na titular");
    assert.deepEqual(Object.keys(eD.json.data.compartilhamentos[0].titular).sort(), ["organizacao", "unidade"]);
    const g = await api("GET", "/estado", { como: { perfil: GER_T, org: ORG_T, unidade: UNI_T, papel: "unit_manager" } });
    assert.ok(!g.texto.includes(TOKEN) && !/token_cifrado|tokenCifrado/.test(g.texto));
  });
});
