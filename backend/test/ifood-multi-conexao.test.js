// iFood — MÚLTIPLAS CONEXÕES por unidade (finalidade): Financial de homologação + Order de produção na MESMA unidade (Subway North Shopping).
//
// Sem rede e sem banco: repositórios em memória com a MESMA seleção do repositório real (escolherConexao), token e cliente de Events falsos.
// Nenhuma chamada ao iFood, nenhum OAuth real. As garantias de banco (índices, triggers, rollback) estão em ifood-multi-conexao-pg.test.js.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SACI, NORTH, ORG, OUTRA_ORG, UN_OUTRA_ORG, GESTOR } from "./helpers/ifood-vinculo-fakes.js";
process.env.IFOOD_ORDER_PILOT_UNITS = `${SACI},${NORTH},${UN_OUTRA_ORG}`;
process.env.IFOOD_FINANCIAL_HOMOLOGATION_UNITS = NORTH;                 // a North tem a loja de TESTE no Financial
process.env.IFOOD_ORDER_CLIENT_ID = "order-client-id-de-teste";
process.env.IFOOD_ORDER_CLIENT_SECRET = "order-client-secret-de-teste";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id-real";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret-real";
process.env.IFOOD_TEST_CLIENT_ID = "test-app-id";
process.env.IFOOD_TEST_CLIENT_SECRET = "test-app-secret";
process.env.IFOOD_TOKEN_SECRET = "segredo-de-teste-com-mais-de-16-caracteres";

const { criarAmbiente } = await import("./helpers/ifood-vinculo-fakes.js");
const F = await import("../src/modules/ifood/ifoodFinalidade.js");
const { decidirDestinoOAuth } = await import("../src/modules/ifood/ifoodConexaoDestino.js");
const auth = await import("../src/modules/ifood/ifoodAuth.service.js");
const conexaoSvc = await import("../src/modules/ifood/ifoodConnection.service.js");
const vinculoSvc = await import("../src/modules/ifood/ifoodMerchantVinculo.service.js");
const eventosRepo = await import("../src/modules/ifood/ifoodEvents.repository.js");
const clienteReal = await import("../src/modules/ifood/ifoodEvents.client.js");
const { criarPoller } = await import("../src/modules/ifood/ifoodEvents.poller.js");
const { ifoodErro, IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");
const { criarRepoEmMemoria, criarRelogio, criarClienteFake, criarTokenFake, ev, pilotoDe } = await import("./helpers/ifood-events-fakes.js");

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(path.join(AQUI, "..", p), "utf8");
const erro = (codigo) => (e) => e?.codigo === codigo;

const M_SACI = "aaaaaaaa-1111-4111-8111-00000000000a";
const M_TESTE = "7e570000-0000-4000-8000-00000000aaaa";    // loja de TESTE da North (homologação do Financial)
const M_REAL = "ea100000-0000-4000-8000-00000000bbbb";     // loja REAL da North
const M_OUTRO = "cccccccc-3333-4333-8333-00000000000c";

// ===========================================================================
// 1. Seleção de conexão por finalidade (pura)
// ===========================================================================
describe("escolherConexao — sem ambiguidade e sem depender da ordem", () => {
  const leg = { id: "l", status: "ativa", finalidade: "legado" };
  const fin = { id: "f", status: "ativa", finalidade: "financeiro_homologacao" };
  const ped = { id: "p", status: "ativa", finalidade: "pedidos_producao" };
  const sem = { id: "s", status: "ativa" };   // linha sem a coluna (124 ausente) = legado

  test("finalidade exata, em QUALQUER ordem dos registros", () => {
    for (const lista of [[fin, ped], [ped, fin]]) {
      assert.equal(F.escolherConexao(lista, "financeiro_homologacao").id, "f");
      assert.equal(F.escolherConexao(lista, "pedidos_producao").id, "p");
    }
  });
  test("legada serve a qualquer finalidade SÓ quando é a única viva; linha sem a coluna conta como legada", () => {
    assert.equal(F.escolherConexao([leg], "pedidos_producao").id, "l");
    assert.equal(F.escolherConexao([leg], "financeiro_homologacao").id, "l");
    assert.equal(F.escolherConexao([sem], "pedidos_producao").id, "s");
    assert.equal(F.escolherConexao([leg, ped], "financeiro_homologacao"), null, "legada + outra: nada é adivinhado");
    assert.equal(F.escolherConexao([fin], "pedidos_producao"), null, "a financeira NUNCA serve pedidos");
    assert.equal(F.escolherConexao([ped], "financeiro_homologacao"), null);
  });
  test("revogadas não contam; sem finalidade: única = ela, várias = ambígua", () => {
    assert.equal(F.escolherConexao([{ ...ped, status: "revogada" }, fin], "pedidos_producao"), null);
    assert.equal(F.escolherConexao([fin]).id, "f");
    assert.equal(F.escolherConexao([]), null);
    assert.throws(() => F.escolherConexao([fin, ped]), erro("IFOOD_CONEXAO_AMBIGUA"));
    assert.throws(() => F.escolherConexao([ped, { ...ped, id: "p2" }], "pedidos_producao"), erro("IFOOD_CONEXAO_AMBIGUA"));
  });
  test("app x finalidade: order só em pedidos; financial/analytics só no financeiro; legado aceita todos", () => {
    assert.equal(F.finalidadeDoApp("order"), "pedidos_producao");
    assert.equal(F.finalidadeDoApp("financial"), "financeiro_homologacao");
    assert.equal(F.finalidadeDoApp("analytics"), "financeiro_homologacao");
    assert.equal(F.appPermitidoNaFinalidade("pedidos_producao", "order"), true);
    assert.equal(F.appPermitidoNaFinalidade("pedidos_producao", "financial"), false);
    assert.equal(F.appPermitidoNaFinalidade("financeiro_homologacao", "order"), false);
    assert.equal(F.appPermitidoNaFinalidade("financeiro_homologacao", "analytics"), true);
    assert.equal(F.appPermitidoNaFinalidade("legado", "order"), true);
    assert.equal(F.conexaoServePedidos(fin), false);
    assert.equal(F.conexaoServePedidos(ped), true);
    assert.equal(F.conexaoServePedidos(leg), true);
    assert.equal(F.ambienteDaFinalidade("pedidos_producao"), "producao");
    assert.equal(F.ambienteDaFinalidade("financeiro_homologacao"), "homologacao");
  });
});

describe("decidirDestinoOAuth", () => {
  const leg = { id: "l", status: "ativa", finalidade: "legado" };
  const fin = { id: "f", status: "ativa", finalidade: "financeiro_homologacao" };
  const ped = { id: "p", status: "ativa", finalidade: "pedidos_producao" };
  test("unidade que NÃO separa: sem conexão, nasce `legado` (idêntico ao de antes); com a legada, reaproveita", async () => {
    assert.deepEqual(await decidirDestinoOAuth({ appType: "order", vivas: [], separa: false }), { acao: "criar", finalidade: "legado" });
    assert.deepEqual(await decidirDestinoOAuth({ appType: "financial", vivas: [], separa: false }), { acao: "criar", finalidade: "legado" });
    assert.equal((await decidirDestinoOAuth({ appType: "order", vivas: [leg], separa: false })).conexao.id, "l");
  });
  test("unidade que separa: cada app vai para a SUA conexão; a nova nasce com a finalidade do app", async () => {
    assert.deepEqual(await decidirDestinoOAuth({ appType: "order", vivas: [fin], separa: true }), { acao: "criar", finalidade: "pedidos_producao" });
    assert.deepEqual(await decidirDestinoOAuth({ appType: "financial", vivas: [ped], separa: true }), { acao: "criar", finalidade: "financeiro_homologacao" });
    assert.equal((await decidirDestinoOAuth({ appType: "order", vivas: [fin, ped], separa: true })).conexao.id, "p");
    assert.equal((await decidirDestinoOAuth({ appType: "financial", vivas: [fin, ped], separa: true })).conexao.id, "f");
  });
  test("Order numa conexão legada SEM credencial Order de unidade que separa: exige rotulagem (nunca cai na loja de teste)", async () => {
    await assert.rejects(decidirDestinoOAuth({ appType: "order", vivas: [leg], separa: true, temCredencialOrder: async () => false }), erro("IFOOD_CONEXAO_LEGADA_ROTULAR"));
    // reautorizar um Order que JÁ existe na legada segue normal
    assert.equal((await decidirDestinoOAuth({ appType: "order", vivas: [leg], separa: true, temCredencialOrder: async () => true })).conexao.id, "l");
    // o Financial na legada de uma unidade que separa continua (é a conexão de teste atual)
    assert.equal((await decidirDestinoOAuth({ appType: "financial", vivas: [leg], separa: true })).conexao.id, "l");
  });
  test("legada + outra conexão: ambíguo para quem não tem finalidade exata; unidade sem separação e com pedidos separados recusa o Financial", async () => {
    await assert.rejects(decidirDestinoOAuth({ appType: "financial", vivas: [leg, ped], separa: true }), erro("IFOOD_CONEXAO_LEGADA_ROTULAR"));
    await assert.rejects(decidirDestinoOAuth({ appType: "financial", vivas: [ped], separa: false }), erro("IFOOD_FINALIDADE_NAO_SUPORTADA"));
  });
});

// ===========================================================================
// Ambiente em memória: North (teste + real), Saci (legado), outra empresa
// ===========================================================================
function ambiente({ northRotulada = true, northReal = true } = {}) {
  const a = criarAmbiente({ piloto: [SACI, NORTH, UN_OUTRA_ORG] });
  const saci = a.conectar({ unidadeId: SACI, apps: ["order", "financial", "analytics"], merchantId: M_SACI, id: "con-saci" });
  const teste = a.conectar({ unidadeId: NORTH, apps: ["financial", "analytics"], merchantId: M_TESTE, id: "con-north-teste", ...(northRotulada ? { finalidade: "financeiro_homologacao" } : {}) });
  const real = northReal ? a.conectar({ unidadeId: NORTH, apps: ["order"], merchantId: M_REAL, id: "con-north-real", finalidade: "pedidos_producao" }) : null;
  const outra = a.conectar({ unidadeId: UN_OUTRA_ORG, organizacaoId: OUTRA_ORG, apps: ["order"], merchantId: M_OUTRO, id: "con-outra" });
  return { a, saci, teste, real, outra };
}
const copia = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
// 2. OAuth: associado à conexão certa
// ---------------------------------------------------------------------------
function depsOAuth(a) {
  const estado = { sessoes: [], posts: [], tokensSalvos: [], trocas: [] };
  const repo = {
    ...a.repo,
    async expirarSessoesVencidas() {},
    async criarSessaoOAuth(d) {
      const s = { id: `sess-${estado.sessoes.length + 1}`, status: "pending", unidade_id: d.unidadeId, organizacao_id: d.organizacaoId, app_type: d.appType, finalidade: d.finalidade ?? null,
        authorization_code_verifier_cifrado: d.verifierCifrado, expira_em: d.expiraEm, verification_url: null, verification_url_complete: null };
      estado.sessoes.push(s);
      return s;
    },
    async obterSessaoOAuth({ organizacaoId, unidadeId, sessaoId, appType }) {
      const s = estado.sessoes.find((x) => x.id === sessaoId && x.organizacao_id === organizacaoId && x.unidade_id === unidadeId && (!appType || x.app_type === appType));
      if (!s) throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA);
      return s;
    },
    async reivindicarSessaoOAuth() { return true; },
    async fecharSessaoOAuth({ sessaoId, status }) { estado.sessoes.find((x) => x.id === sessaoId).status = status; },
    // mesma semântica do repositório real: da finalidade; só cria a dessa finalidade
    async criarConexao({ organizacaoId, unidadeId, finalidade }) {
      const c = { id: `con-nova-${a.conexoes.length}`, organizacao_id: organizacaoId, unidade_id: unidadeId, merchant_id: null, merchant_nome: null, merchant_razao_social: null, status: "pendente",
        ...(finalidade && finalidade !== "legado" ? { finalidade, ambiente: F.ambienteDaFinalidade(finalidade) } : {}) };
      a.conexoes.push(c);
      return { ...c };
    },
    async obterOuCriarConexao(p) { return (await this.obterConexaoViva(p)) ?? this.criarConexao(p); },
  };
  const http = { async postForm(rota, corpo) { estado.posts.push({ rota, corpo }); return { userCode: "ABCD-EFGH", authorizationCodeVerifier: "verifier-de-teste", expiresIn: 600 }; } };
  const tokenReal = a.deps.token;
  const token = {
    appTypesDoOAuth: () => ["analytics", "financial", "order"],
    orderLiberadoParaUnidade: (u) => [SACI, NORTH, UN_OUTRA_ORG].includes(u),
    credenciaisDoApp: (appType, { unidadeId } = {}) => ({ clientId: `${appType}-${unidadeId === NORTH && appType !== "order" ? "teste" : "real"}`, clientSecret: "s", origem: unidadeId === NORTH && appType !== "order" ? "test" : "app" }),
    async trocarAuthorizationCodePorToken(t) { estado.trocas.push({ appType: t.appType, unidadeId: t.unidadeId }); return { accessToken: "a", refreshToken: "r", expiresIn: 10_800 }; },
    async salvarTokens({ conexaoId, appType }) {
      estado.tokensSalvos.push({ conexaoId, appType });
      const c = a.conexoes.find((x) => x.id === conexaoId);
      const k = a.credenciais.find((x) => x.conexao_id === conexaoId && x.app_type === appType);
      if (k) Object.assign(k, { status: "ativa" }); else a.credenciais.push({ conexao_id: c.id, app_type: appType, status: "ativa", expira_em: new Date(a.relogio.ms + 3_600_000).toISOString(), atualizado_em: new Date(a.relogio.ms).toISOString() });
    },
    validacaoMerchantManualHabilitada: tokenReal.validacaoMerchantManualHabilitada,
  };
  return { estado, deps: { repo, http, token } };
}
const iniciar = (d, unidadeId, appType, organizacaoId = ORG) => auth.iniciarConexao({ organizacaoId, unidadeId, appType, usuarioId: GESTOR, deps: d.deps });
const concluir = (d, unidadeId, appType, sessaoId, organizacaoId = ORG) => auth.concluirAutorizacao({ organizacaoId, unidadeId, appType, sessaoId, authorizationCode: "codigo-do-portal", usuarioId: GESTOR, deps: d.deps });

describe("OAuth: a autorização só se associa à conexão da sua finalidade", () => {
  test("North com a conexão de teste ainda `legado`: o Order é RECUSADO antes de qualquer chamada ao iFood (nunca cai na loja de teste)", async () => {
    const { a } = ambiente({ northRotulada: false, northReal: false });
    const d = depsOAuth(a);
    const antes = copia(a.conexoes);
    await assert.rejects(iniciar(d, NORTH, "order"), erro("IFOOD_CONEXAO_LEGADA_ROTULAR"));
    assert.equal(d.estado.posts.length, 0);
    assert.deepEqual(a.conexoes, antes);
  });

  test("North rotulada: o Order cria a conexão `pedidos_producao` NOVA e grava a credencial SÓ nela; a de teste fica intacta", async () => {
    const { a, teste } = ambiente({ northReal: false });
    const d = depsOAuth(a);
    const testeAntes = copia(teste);
    const credTesteAntes = copia(a.credenciais.filter((k) => k.conexao_id === teste.id));
    const ini = await iniciar(d, NORTH, "order");
    assert.equal(d.estado.sessoes[0].finalidade, "pedidos_producao", "a sessão carrega a finalidade da conexão-alvo");
    assert.equal(d.estado.posts[0].corpo.clientId, "order-real", "o app de pedidos — nunca o app de teste");
    const fim = await concluir(d, NORTH, "order", ini.sessionId);
    assert.equal(fim.status, "authorized");
    const nova = a.conexoes.find((c) => c.unidade_id === NORTH && c.finalidade === "pedidos_producao");
    assert.ok(nova, "conexão de pedidos criada");
    assert.equal(nova.ambiente, "producao");
    assert.equal(nova.merchant_id, null, "o OAuth não vincula loja");
    assert.deepEqual(d.estado.tokensSalvos, [{ conexaoId: nova.id, appType: "order" }]);
    assert.deepEqual(a.conexoes.find((c) => c.id === teste.id), testeAntes, "a conexão de teste não mudou");
    assert.deepEqual(a.credenciais.filter((k) => k.conexao_id === teste.id), credTesteAntes, "credenciais de teste intactas");
    assert.equal(a.conexoes.filter((c) => c.unidade_id === NORTH && c.status !== "revogada").length, 2);
  });

  test("Financial da North (reautorização) vai para a conexão financeira — sem criar outra", async () => {
    const { a, teste } = ambiente();
    const d = depsOAuth(a);
    const ini = await iniciar(d, NORTH, "financial");
    assert.equal(d.estado.sessoes[0].finalidade, "financeiro_homologacao");
    assert.equal(d.estado.posts[0].corpo.clientId, "financial-teste", "app de teste, como sempre");
    await concluir(d, NORTH, "financial", ini.sessionId);
    assert.deepEqual(d.estado.tokensSalvos, [{ conexaoId: teste.id, appType: "financial" }]);
    assert.equal(a.conexoes.filter((c) => c.unidade_id === NORTH).length, 2, "nenhuma conexão nova");
  });

  test("Order da North com as duas conexões: a reautorização e a proteção da credencial valem para a de pedidos, nunca para a de teste", async () => {
    const { a, real, teste } = ambiente();
    const d = depsOAuth(a);
    const lidas = [];
    const original = d.deps.repo.obterCredencial;
    d.deps.repo.obterCredencial = async (p) => { lidas.push(p.conexaoId); return original.call(a.repo, p); };
    const ini = await iniciar(d, NORTH, "order");
    // token opaco (sem prova de escopo) numa credencial Order existente: a PROTEÇÃO recusa e nada é gravado — mas na conexão certa
    await assert.rejects(concluir(d, NORTH, "order", ini.sessionId), erro("IFOOD_CREDENCIAL_SEM_COBERTURA"));
    assert.ok(lidas.includes(real.id), "a proteção olhou a credencial Order da conexão de pedidos");
    assert.ok(!lidas.includes(teste.id), "e nunca a da conexão de teste");
    assert.deepEqual(d.estado.tokensSalvos, []);
  });

  test("sessão adulterada para outra finalidade: não conclui, o código NÃO é trocado e a sessão é encerrada", async () => {
    const { a } = ambiente();
    const d = depsOAuth(a);
    const ini = await iniciar(d, NORTH, "order");
    d.estado.sessoes[0].finalidade = "financeiro_homologacao";   // tentativa de apontar a autorização do Order para a conexão financeira
    await assert.rejects(concluir(d, NORTH, "order", ini.sessionId), erro("IFOOD_LOJA_OAUTH_INVALIDO"));
    assert.equal(d.estado.trocas.length, 0);
    assert.deepEqual(d.estado.tokensSalvos, []);
    assert.equal(d.estado.sessoes[0].status, "failed");
  });

  test("sessão de uma unidade/empresa não conclui em outra", async () => {
    const { a } = ambiente();
    const d = depsOAuth(a);
    const ini = await iniciar(d, NORTH, "order");
    await assert.rejects(concluir(d, UN_OUTRA_ORG, "order", ini.sessionId, OUTRA_ORG), erro("IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA"));
    await assert.rejects(concluir(d, SACI, "order", ini.sessionId), erro("IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA"));
  });

  test("Saci (legado, fora da lista do Financial de homologação): Order e Financial reautorizam a MESMA conexão, sem criar nada", async () => {
    const { a, saci } = ambiente();
    const d = depsOAuth(a);
    const antes = a.conexoes.length;
    const lidas = [];
    const original = d.deps.repo.obterCredencial;
    d.deps.repo.obterCredencial = async (p) => { lidas.push(p.conexaoId); return original.call(a.repo, p); };
    const iniO = await iniciar(d, SACI, "order");
    await assert.rejects(concluir(d, SACI, "order", iniO.sessionId), erro("IFOOD_CREDENCIAL_SEM_COBERTURA"));   // proteção do Order (token opaco): igual a antes
    assert.ok(lidas.every((c) => c === saci.id));
    const iniF = await iniciar(d, SACI, "financial");
    await concluir(d, SACI, "financial", iniF.sessionId);
    assert.deepEqual(d.estado.tokensSalvos, [{ conexaoId: saci.id, appType: "financial" }]);
    assert.equal(a.conexoes.length, antes);
    assert.equal(a.conexoes.find((c) => c.id === saci.id).finalidade, undefined, "continua `legado` (sem rótulo)");
  });

  test("unidade nova (sem conexão, fora da lista): o Order cria conexão `legado` — idêntico ao comportamento anterior", async () => {
    const a = criarAmbiente({ piloto: [SACI, UN_OUTRA_ORG] });
    const d = depsOAuth(a);
    const ini = await iniciar(d, UN_OUTRA_ORG, "order", OUTRA_ORG);
    await concluir(d, UN_OUTRA_ORG, "order", ini.sessionId, OUTRA_ORG);
    assert.equal(a.conexoes.length, 1);
    assert.equal(a.conexoes[0].finalidade, undefined);
    assert.equal(a.conexoes[0].unidade_id, UN_OUTRA_ORG);
  });

  test("o serviço de OAuth não importa a allowlist do Financial de homologação (só o módulo de destino)", () => {
    const s = ler("src/modules/ifood/ifoodAuth.service.js");
    assert.doesNotMatch(s, /ifoodFinancialHomologacao|financialHomologacaoUnidades|IFOOD_FINANCIAL_HOMOLOGATION_UNITS|usarHomologacaoFinancial/);
    assert.match(ler("src/modules/ifood/ifoodConexaoDestino.js"), /unidadeEmHomologacaoFinancial/);
  });
});

// ---------------------------------------------------------------------------
// 3. Status por conexão e desconexão independente
// ---------------------------------------------------------------------------
describe("status: cada conexão separada, sem segredo; unidade legada com a resposta de sempre", () => {
  test("North: topo = Financial de homologação (loja de teste); bloco Order = loja REAL; `conexoes` lista as duas com identidade própria", async () => {
    const { a, teste, real } = ambiente();
    const s = await conexaoSvc.obterStatus({ organizacaoId: ORG, unidadeId: NORTH, deps: a.deps });
    assert.equal(s.conectado, true);
    assert.equal(s.merchant.idMascarado.endsWith(M_TESTE.slice(-4)), true, "o topo mostra a loja de teste");
    assert.equal(s.order.merchant.idMascarado.endsWith(M_REAL.slice(-4)), true, "o Order mostra a loja real");
    assert.equal(s.order.conectado, true);
    assert.equal(s.apps.financial.conectado, true);
    assert.equal(s.conexoes.length, 2);
    const fin = s.conexoes.find((c) => c.finalidade === "financeiro_homologacao");
    const ped = s.conexoes.find((c) => c.finalidade === "pedidos_producao");
    assert.equal(fin.id, teste.id); assert.equal(fin.ambiente, "homologacao"); assert.deepEqual(Object.keys(fin.credenciais).sort(), ["analytics", "financial"]);
    assert.equal(ped.id, real.id); assert.equal(ped.ambiente, "producao"); assert.deepEqual(Object.keys(ped.credenciais), ["order"]);
    const json = JSON.stringify(s);
    assert.ok(!json.includes(M_TESTE) && !json.includes(M_REAL), "merchant sempre mascarado");
    assert.doesNotMatch(json, /clientSecret|accessToken|refreshToken|access_token|refresh_token|authorizationCode|verifier|_cifrado/i);
  });

  test("North só com o Financial de homologação: o bloco Order NÃO herda a loja de teste", async () => {
    const { a } = ambiente({ northReal: false });
    const s = await conexaoSvc.obterStatus({ organizacaoId: ORG, unidadeId: NORTH, deps: a.deps });
    assert.equal(s.merchant.idMascarado.endsWith(M_TESTE.slice(-4)), true);
    assert.equal(s.order.conectado, false);
    assert.equal(s.order.merchant, null);
    assert.equal(s.order.lojaValidada, false);
    assert.equal(s.conexoes.length, 1);
    assert.equal(s.conexoes[0].finalidade, "financeiro_homologacao");
  });

  test("North antes de rotular (legada): resposta de sempre, sem `conexoes`", async () => {
    const { a } = ambiente({ northRotulada: false, northReal: false });
    const s = await conexaoSvc.obterStatus({ organizacaoId: ORG, unidadeId: NORTH, deps: a.deps });
    assert.equal(s.conexoes, undefined);
    assert.equal(s.merchant.idMascarado.endsWith(M_TESTE.slice(-4)), true);
  });

  test("Saci (legado): sem `conexoes`; Order e Financial da mesma conexão, exatamente como antes", async () => {
    const { a } = ambiente();
    const s = await conexaoSvc.obterStatus({ organizacaoId: ORG, unidadeId: SACI, deps: a.deps });
    assert.equal(s.conexoes, undefined);
    assert.equal(s.order.conectado, true);
    assert.equal(s.order.merchant.idMascarado, s.merchant.idMascarado);
    assert.equal(s.apps.financial.conectado, true);
  });

  test("outra empresa não enxerga as conexões da North (status é por tenant)", async () => {
    const { a } = ambiente();
    const s = await conexaoSvc.obterStatus({ organizacaoId: OUTRA_ORG, unidadeId: NORTH, deps: a.deps });
    assert.equal(s.status, "nao_conectado");
    assert.equal(s.conexoes, undefined);
  });
});

describe("desconexão: afeta SÓ a conexão escolhida", () => {
  test("sem `conexaoId` e com duas conexões vivas: RECUSA (nada de \"desconectar tudo\"); nada muda", async () => {
    const { a } = ambiente();
    const antes = copia({ c: a.conexoes, k: a.credenciais });
    await assert.rejects(conexaoSvc.desconectar({ organizacaoId: ORG, unidadeId: NORTH, usuarioId: GESTOR, deps: a.deps }), erro("IFOOD_CONEXAO_AMBIGUA"));
    assert.deepEqual(copia({ c: a.conexoes, k: a.credenciais }), antes);
  });

  test("desconectar a de PEDIDOS: revoga só ela e apaga só as credenciais dela; o Financial de homologação segue intacto", async () => {
    const { a, teste, real } = ambiente();
    const testeAntes = copia(a.conexoes.find((c) => c.id === teste.id));
    const credTesteAntes = copia(a.credenciais.filter((k) => k.conexao_id === teste.id));
    const r = await conexaoSvc.desconectar({ organizacaoId: ORG, unidadeId: NORTH, usuarioId: GESTOR, conexaoId: real.id, deps: a.deps });
    assert.equal(r.ok, true); assert.equal(r.jaDesconectado, false);
    assert.equal(a.conexoes.find((c) => c.id === real.id).status, "revogada");
    assert.equal(a.credenciais.filter((k) => k.conexao_id === real.id).length, 0);
    assert.deepEqual(a.conexoes.find((c) => c.id === teste.id), testeAntes);
    assert.deepEqual(a.credenciais.filter((k) => k.conexao_id === teste.id), credTesteAntes);
    // idempotente
    assert.equal((await conexaoSvc.desconectar({ organizacaoId: ORG, unidadeId: NORTH, usuarioId: GESTOR, conexaoId: real.id, deps: a.deps })).jaDesconectado, true);
    // e agora, com uma só viva, o pedido sem id vale para ela
    const s = await conexaoSvc.obterStatus({ organizacaoId: ORG, unidadeId: NORTH, deps: a.deps });
    assert.equal(s.order.conectado, false);
  });

  test("desconectar a FINANCEIRA: a de pedidos (e o recebimento) seguem intactos", async () => {
    const { a, teste, real } = ambiente();
    const realAntes = copia(a.conexoes.find((c) => c.id === real.id));
    await conexaoSvc.desconectar({ organizacaoId: ORG, unidadeId: NORTH, usuarioId: GESTOR, conexaoId: teste.id, deps: a.deps });
    assert.equal(a.conexoes.find((c) => c.id === teste.id).status, "revogada");
    assert.deepEqual(a.conexoes.find((c) => c.id === real.id), realAntes);
    assert.equal(a.credenciais.filter((k) => k.conexao_id === real.id).length, 1);
  });

  test("`conexaoId` de outra unidade ou de outra empresa: não encontrada, nada muda", async () => {
    const { a, saci, outra } = ambiente();
    const antes = copia({ c: a.conexoes, k: a.credenciais });
    await assert.rejects(conexaoSvc.desconectar({ organizacaoId: ORG, unidadeId: NORTH, usuarioId: GESTOR, conexaoId: saci.id, deps: a.deps }), erro("IFOOD_CONEXAO_NAO_ENCONTRADA"));
    await assert.rejects(conexaoSvc.desconectar({ organizacaoId: ORG, unidadeId: NORTH, usuarioId: GESTOR, conexaoId: outra.id, deps: a.deps }), erro("IFOOD_CONEXAO_NAO_ENCONTRADA"));
    assert.deepEqual(copia({ c: a.conexoes, k: a.credenciais }), antes);
  });

  test("Saci (uma conexão legada): desconectar sem `conexaoId` segue como sempre", async () => {
    const { a, saci } = ambiente();
    const r = await conexaoSvc.desconectar({ organizacaoId: ORG, unidadeId: SACI, usuarioId: GESTOR, deps: a.deps });
    assert.equal(r.jaDesconectado, false);
    assert.equal(a.conexoes.find((c) => c.id === saci.id).status, "revogada");
  });

  test("o controller só aceita `conexaoId` UUID e repassa; a rota DELETE existente é a mesma", () => {
    const ctrl = ler("src/modules/ifood/ifood.controller.js");
    assert.match(ctrl, /validarConexaoId/);
    assert.match(ler("src/modules/ifood/ifood.validators.js"), /export function validarConexaoId/);
    assert.match(ler("src/modules/ifood/ifood.routes.js"), /ifoodRouter\.delete\("\/", gerenciar, controller\.desconectar\)/);
  });
});

// ---------------------------------------------------------------------------
// 4. Vínculo manual do merchant: só na conexão de pedidos
// ---------------------------------------------------------------------------
describe("vínculo manual do merchant (Order) usa SÓ a conexão de pedidos", () => {
  test("North só com o Financial de homologação: informar a loja real é recusado (não grava na conexão de teste)", async () => {
    const { a, teste } = ambiente({ northReal: false });
    await assert.rejects(vinculoSvc.informarMerchant(a.p({ unidadeId: NORTH, merchantId: M_REAL })), erro("IFOOD_ORDER_NAO_CONECTADO"));
    assert.equal(a.linhas.length, 0);
    assert.equal(a.conexoes.find((c) => c.id === teste.id).merchant_id, M_TESTE);
  });

  test("North com a conexão de pedidos ainda sem loja: o vínculo nasce na conexão de PEDIDOS; a loja de teste não é tocada", async () => {
    const { a, teste } = ambiente({ northReal: false });
    const ped = a.conectar({ unidadeId: NORTH, apps: ["order"], merchantId: null, id: "con-north-ped", finalidade: "pedidos_producao" });
    const r = await vinculoSvc.informarMerchant(a.p({ unidadeId: NORTH, merchantId: M_REAL }));
    assert.equal(r.vinculo.estado, "informado");
    assert.equal(a.linhas[0].conexao_id, ped.id);
    assert.equal(a.conexoes.find((c) => c.id === teste.id).merchant_id, M_TESTE);
  });

  test("o merchant de TESTE não pode ser informado na conexão de pedidos (já vinculado à outra)", async () => {
    const { a } = ambiente({ northReal: false });
    a.conectar({ unidadeId: NORTH, apps: ["order"], merchantId: null, id: "con-north-ped", finalidade: "pedidos_producao" });
    await assert.rejects(vinculoSvc.informarMerchant(a.p({ unidadeId: NORTH, merchantId: M_TESTE })), erro("IFOOD_VINCULO_DUPLICADO"));
  });

  test("cancelar o vínculo informado da North não toca a Saci nem a loja de teste", async () => {
    const { a, teste } = ambiente({ northReal: false });
    a.conectar({ unidadeId: NORTH, apps: ["order"], merchantId: null, id: "con-north-ped", finalidade: "pedidos_producao" });
    await vinculoSvc.informarMerchant(a.p({ unidadeId: NORTH, merchantId: M_REAL }));
    const r = await vinculoSvc.cancelarMerchantInformado(a.p({ unidadeId: NORTH }));
    assert.equal(r.cancelados, 1);
    assert.equal(a.conexoes.find((c) => c.id === teste.id).status, "ativa");
  });
});

// ---------------------------------------------------------------------------
// 5. Poller: o merchant de teste jamais é consultado (repositório REAL sobre um banco falso)
// ---------------------------------------------------------------------------
/** Banco falso que executa os filtros usados por listarConexoesElegiveisParaEvents / listarConexoesComMerchant. */
function dbConexoes(conexoes, credenciais, { semColunaFinalidade = false } = {}) {
  return {
    from(tabela) {
      assert.equal(tabela, "ifood_conexoes");
      const f = { eq: [], neq: [], not: [], join: false };
      const q = {
        select(colunas) { f.join = /ifood_credenciais!inner/.test(colunas); return q; },
        eq(c, v) { f.eq.push([c, v]); return q; },
        neq(c, v) { f.neq.push([c, v]); return q; },
        not(c, op, v) { f.not.push([c, op, v]); return q; },
        then(res, rej) {
          if (semColunaFinalidade && f.neq.some(([c]) => c === "finalidade")) return Promise.resolve({ data: null, error: { code: "42703", message: "column ifood_conexoes.finalidade does not exist" } }).then(res, rej);
          const linhas = conexoes.filter((c) => f.eq.every(([col, v]) => col.startsWith("ifood_credenciais.") || c[col] === v)
            && f.neq.every(([col, v]) => (c[col] ?? "legado") !== v) && f.not.every(([col, , v]) => c[col] !== v))
            .map((c) => ({ id: c.id, organizacao_id: c.organizacao_id, unidade_id: c.unidade_id, merchant_id: c.merchant_id,
              ...(f.join ? { ifood_credenciais: credenciais.filter((k) => k.conexao_id === c.id && k.app_type === "order").map((k) => ({ app_type: k.app_type, status: k.status })) } : {}) }))
            .filter((c) => !f.join || c.ifood_credenciais.length > 0);
          return Promise.resolve({ data: linhas, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

describe("repositório de conexões elegíveis (consulta REAL, banco falso)", () => {
  const conexoes = [
    { id: "c-saci", organizacao_id: ORG, unidade_id: SACI, merchant_id: M_SACI, status: "ativa" },                                              // legado
    { id: "c-teste", organizacao_id: ORG, unidade_id: NORTH, merchant_id: M_TESTE, status: "ativa", finalidade: "financeiro_homologacao" },
    { id: "c-real", organizacao_id: ORG, unidade_id: NORTH, merchant_id: M_REAL, status: "ativa", finalidade: "pedidos_producao" },
    { id: "c-pend", organizacao_id: ORG, unidade_id: NORTH, merchant_id: null, status: "pendente", finalidade: "pedidos_producao" },
  ];
  // credencial `order` também na de teste (o banco impede; aqui provamos que a CONSULTA também a exclui)
  const credenciais = [
    { conexao_id: "c-saci", app_type: "order", status: "ativa" }, { conexao_id: "c-real", app_type: "order", status: "reauth_required" },
    { conexao_id: "c-teste", app_type: "order", status: "ativa" }, { conexao_id: "c-teste", app_type: "financial", status: "ativa" },
  ];
  test("elegíveis: legada e pedidos_producao (com o status da credencial); a financeira de homologação NUNCA", async () => {
    const r = await eventosRepo.listarConexoesElegiveisParaEvents({ db: dbConexoes(conexoes, credenciais) });
    assert.deepEqual(r.map((c) => [c.id, c.credencial_order_status]).sort(), [["c-real", "reauth_required"], ["c-saci", "ativa"]]);
    assert.ok(!r.some((c) => c.merchant_id === M_TESTE));
  });
  test("modo centralizado (merchant -> tenant): a financeira de homologação também fica de fora", async () => {
    const r = await eventosRepo.listarConexoesComMerchant({ db: dbConexoes(conexoes, credenciais) });
    assert.deepEqual(r.map((c) => c.id).sort(), ["c-real", "c-saci"]);
  });
  test("código no ar ANTES da migration 124 (sem a coluna): repete sem o filtro — o recebimento da Saci não para", async () => {
    const legadas = conexoes.filter((c) => !c.finalidade);
    const r = await eventosRepo.listarConexoesElegiveisParaEvents({ db: dbConexoes(legadas, credenciais, { semColunaFinalidade: true }) });
    assert.deepEqual(r.map((c) => c.id), ["c-saci"]);
    const r2 = await eventosRepo.listarConexoesComMerchant({ db: dbConexoes(legadas, credenciais, { semColunaFinalidade: true }) });
    assert.deepEqual(r2.map((c) => c.id), ["c-saci"]);
  });
  test("erro do banco que não é de coluna ausente continua subindo", async () => {
    const db = { from: () => ({ select() { return this; }, eq() { return this; }, not() { return this; }, neq() { return this; }, then(res, rej) { return Promise.resolve({ data: null, error: { code: "XX000", message: "db fora" } }).then(res, rej); } }) };
    await assert.rejects(eventosRepo.listarConexoesElegiveisParaEvents({ db }), /db fora/);
  });
});

describe("poller: grupos independentes e NENHUMA consulta ao merchant de teste", () => {
  const BASE = [
    { id: "c-saci", organizacao_id: ORG, unidade_id: SACI, merchant_id: M_SACI, status: "ativa" },
    { id: "c-teste", organizacao_id: ORG, unidade_id: NORTH, merchant_id: M_TESTE, status: "ativa", finalidade: "financeiro_homologacao" },
    { id: "c-real", organizacao_id: ORG, unidade_id: NORTH, merchant_id: M_REAL, status: "ativa", finalidade: "pedidos_producao" },
  ];
  const CREDS = [{ conexao_id: "c-saci", app_type: "order", status: "ativa" }, { conexao_id: "c-real", app_type: "order", status: "ativa" }, { conexao_id: "c-teste", app_type: "financial", status: "ativa" }];

  function montar({ escopo, creds = CREDS, respostas = [] } = {}) {
    const relogio = criarRelogio();
    const repo = criarRepoEmMemoria({ relogio, conexoes: BASE.map(({ finalidade, status, ...c }) => c) });
    const db = dbConexoes(BASE, creds);
    repo.listarConexoesElegiveisParaEvents = () => eventosRepo.listarConexoesElegiveisParaEvents({ db });   // a consulta REAL
    repo.listarConexoesComMerchant = () => eventosRepo.listarConexoesComMerchant({ db });
    const client = criarClienteFake(clienteReal, { respostasPolling: respostas });
    const token = criarTokenFake({ escopo });
    const poller = criarPoller({ repo, token, client, holder: "w1", agora: relogio.agora, log: () => {}, leaseTtlS: 90, unidadesPiloto: pilotoDe(repo) });
    return { repo, client, poller };
  }

  for (const escopo of ["conexao", "app"]) {
    test(`escopo '${escopo}': só os merchants da Saci e da North REAL são consultados; a loja de teste nunca aparece`, async () => {
      const { client, poller } = montar({ escopo, respostas: [[ev("e1", "PLC", { orderId: "o-real", merchantId: M_REAL, min: 1 })], [], []] });
      const r = await poller.executarCiclo();
      assert.equal(r.estado, "OK");
      const consultados = client.polls.flatMap((p) => p.merchantIds);
      assert.ok(consultados.includes(M_SACI) && consultados.includes(M_REAL));
      assert.ok(!consultados.includes(M_TESTE), "o merchant de teste não pode ser consultado (infração no iFood)");
      if (escopo === "conexao") assert.equal(client.polls.length, 2, "um grupo por conexão elegível: Saci e North real, independentes");
    });
  }

  test("evento da loja de TESTE (se chegasse) é MERCHANT_DESCONHECIDO: não vira pedido de nenhuma unidade", async () => {
    const { repo, poller } = montar({ escopo: "app", respostas: [[ev("e-teste", "PLC", { orderId: "o-teste", merchantId: M_TESTE, min: 1 })]] });
    await poller.executarCiclo();
    assert.equal(repo.eventos.get("e-teste").processing_status, "MERCHANT_DESCONHECIDO");
    assert.equal(repo.pedidos.has("o-teste"), false);
  });

  test("a credencial da conexão de pedidos em reauth_required é PULADA sem afetar a Saci (grupos independentes)", async () => {
    const creds = CREDS.map((k) => (k.conexao_id === "c-real" ? { ...k, status: "reauth_required" } : k));
    const { client, poller } = montar({ escopo: "conexao", creds, respostas: [[], []] });
    const r = await poller.executarCiclo();
    assert.equal(r.estado, "OK");
    assert.deepEqual(client.polls.flatMap((p) => p.merchantIds), [M_SACI]);
    assert.equal(r.conexoesIgnoradas.length, 1);
  });

  test("falha de UM grupo não impede o outro (isolamento por grupo)", async () => {
    const { client, poller } = montar({ escopo: "conexao", respostas: [new Error("falha do grupo 1"), []] });
    const r = await poller.executarCiclo().catch((e) => ({ erro: e }));
    assert.ok(!r.erro || r.erro.message === "falha do grupo 1");
    const consultados = client.polls.flatMap((p) => p.merchantIds);
    assert.ok(consultados.includes(M_SACI) && consultados.includes(M_REAL), "os DOIS grupos foram tentados");
    assert.ok(!consultados.includes(M_TESTE));
  });
});

// ---------------------------------------------------------------------------
// 6. Guardas estáticas
// ---------------------------------------------------------------------------
describe("guardas: nenhum consumidor volta a escolher a conexão por ordem ou por 'a única'", () => {
  test("todo obterConexaoViva dos serviços de integração informa a finalidade (ou é o desconectar explícito)", () => {
    const arquivos = ["ifoodAuth.service.js", "ifoodConnection.service.js", "ifoodFinancial.service.js", "ifoodMerchant.service.js", "ifoodMerchantVinculo.service.js", "ifoodConexaoDestino.js"];
    for (const f of arquivos) {
      const src = ler(`src/modules/ifood/${f}`).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      for (const m of src.matchAll(/obterConexaoViva\(\{([^}]*)\}\)/g)) {
        if (f === "ifoodConnection.service.js" && !/finalidade/.test(m[1])) {
          assert.match(src.slice(Math.max(0, m.index - 400), m.index), /else \{|IFOOD_CONEXAO_AMBIGUA|conexaoId/, "o único sem finalidade é o do desconectar sem id (ambíguo se houver mais de uma)");
          continue;
        }
        assert.match(m[1], /finalidade/, `${f}: ${m[0]}`);
      }
    }
    assert.match(ler("src/modules/checklist-operacional/checklistOperacional.service.js"), /obterConexaoViva\(\{ organizacaoId, unidadeId, finalidade: "pedidos_producao" \}\)/);
  });
  test("o repositório nunca usa .maybeSingle() para escolher conexão da unidade (seleção é por finalidade, em código)", () => {
    const src = ler("src/modules/ifood/ifood.repository.js");
    const bloco = src.slice(src.indexOf("export async function listarConexoesVivas"), src.indexOf("export async function obterConexaoDoTenant"));
    assert.doesNotMatch(bloco, /maybeSingle/);
    assert.match(bloco, /escolherConexao/);
  });
});
