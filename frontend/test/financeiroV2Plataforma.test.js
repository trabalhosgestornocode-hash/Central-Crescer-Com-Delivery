// Execução 10 — interface do Financeiro v2 no MODO PLATAFORMA: rotas reais, credenciais da Crescer, estados de erro sem
// dado sintético, e a decisão do Dashboard Financeiro (v2 só na unidade liberada; nunca os dois).
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarTransportePlataforma, emModoPlataforma, estadoDoErro, traduzirEndereco } from "../financeiro-v2/plataforma.js";
import { criarConsultor, definirTransporte, enviar } from "../financeiro-v2/consulta.js";
import { ENDERECO_FINANCEIRO_V2, resolverFinanceiroV2 } from "../src/financeiroAcesso.js";

test("10 — modo plataforma só com ?modo=plataforma; endereços da demonstração viram as rotas reais", () => {
  assert.equal(emModoPlataforma("?modo=plataforma"), true);
  assert.equal(emModoPlataforma(""), false);
  assert.equal(emModoPlataforma("?modo=PLATAFORMA"), false);
  assert.equal(traduzirEndereco("/api/fv2/sessao"), "/api/v1/financeiro-v2/sessao");
  assert.equal(traduzirEndereco("/api/fv2/dre?competencia=2026-10&unidade=x"), "/api/v1/financeiro-v2/api/dre?competencia=2026-10&unidade=x");
  assert.equal(traduzirEndereco("/api/fv2/conferencias/pendencias?competencia=2026-10"), "/api/v1/financeiro-v2/api/conferencias/pendencias?competencia=2026-10");
  assert.equal(traduzirEndereco("/api/fv2/acoes/obrigacoes/registrar"), "/api/v1/financeiro-v2/acoes/obrigacoes/registrar");
  assert.equal(traduzirEndereco("/api/fv2/administracao/contexto"), "/api/v1/financeiro-v2/administracao/contexto");
  for (const u of ["/api/fv2/login", "/api/fv2/logout", "/api/fv2/documentos/arquivo?id=1", "/api/v1/outra", "https://exemplo.test/api/fv2/dre"]) assert.equal(traduzirEndereco(u), null, u);
});

test("10 — transporte: credenciais da plataforma, sem cabeçalhos da demonstração; sem login/contexto nada é enviado", async () => {
  const chamadas = [];
  const fetchFn = async (url, op) => { chamadas.push({ url, op }); return new Response(JSON.stringify({ ok: 1 }), { status: 200 }); };
  const t = criarTransportePlataforma({ credenciais: async () => ({ token: "tok", contexto: "ctx" }), fetchFn });
  await t("/api/fv2/dre?competencia=2026-10", { headers: { accept: "application/json", "x-fv2-demo-sessao": "gestor", "x-fv2-csrf": "abc" } });
  assert.equal(chamadas[0].url, "/api/v1/financeiro-v2/api/dre?competencia=2026-10");
  assert.deepEqual(chamadas[0].op.headers, { accept: "application/json", Authorization: "Bearer tok", "x-context-token": "ctx" });
  const semLogin = criarTransportePlataforma({ credenciais: async () => ({ token: null, contexto: "ctx" }), fetchFn });
  assert.equal((await semLogin("/api/fv2/dre")).status, 401);
  const semCtx = criarTransportePlataforma({ credenciais: async () => ({ token: "tok", contexto: null }), fetchFn });
  assert.equal((await semCtx("/api/fv2/dre")).status, 409);
  const quebrado = criarTransportePlataforma({ credenciais: async () => { throw new Error("x"); }, fetchFn });
  assert.equal((await quebrado("/api/fv2/dre")).status, 401);
  assert.equal((await t("/api/fv2/documentos/arquivo?id=1")).status, 404);
  await t("/api/fv2/acoes/obrigacoes/registrar", { method: "POST", headers: {}, body: JSON.stringify({ descricao: "x", unidade: "outra", confirmar: true }) });
  assert.deepEqual(JSON.parse(chamadas.at(-1).op.body), { descricao: "x" }, "unidade e confirmação da tela não vão ao servidor");
  assert.equal(chamadas.length, 2, "sem login/contexto/endereço permitido nada saiu para a rede");
});

test("10 — consultas e ações usam o transporte único; falha devolve código e motivo (nunca dado)", async () => {
  definirTransporte(async () => new Response(JSON.stringify({ erro: "PERMISSAO_INSUFICIENTE", motivo: "SEM_CONCESSAO", mensagem: "Sem concessão." }), { status: 403 }));
  const r = await criarConsultor().consultar("/api/fv2/dre");
  assert.deepEqual(r, { ok: false, status: 403, erro: "PERMISSAO_INSUFICIENTE", motivo: "SEM_CONCESSAO", mensagem: "Sem concessão." });
  const a = await enviar("/api/fv2/acoes/x", {});
  assert.equal(a.ok, false);
  assert.equal(a.motivo, "SEM_CONCESSAO");
  definirTransporte((...x) => fetch(...x));
});

test("10 — estados da tela a partir do erro real", () => {
  const e = (r) => estadoDoErro(r).tipo;
  assert.equal(e({ status: 401 }), "sem-sessao");
  assert.equal(e({ status: 403, motivo: "SESSAO_EXPIRADA" }), "sem-sessao");
  assert.match(estadoDoErro({ status: 404, erro: "FINANCEIRO_V2_DESLIGADO" }).mensagem, /desativado/);
  assert.match(estadoDoErro({ status: 403, motivo: "UNIDADE_NAO_LIBERADA" }).mensagem, /não está liberado/);
  assert.match(estadoDoErro({ status: 403, motivo: "SEM_CONCESSAO" }).mensagem, /não tem permissão/);
  assert.match(estadoDoErro({ status: 503, erro: "AUTORIZACAO_FINANCEIRA_INDISPONIVEL" }).mensagem, /indisponível/);
  assert.match(estadoDoErro({ status: 403, motivo: "MFA_SEM_SEGUNDO_FATOR" }).mensagem, /segundo fator/);
  assert.match(estadoDoErro({ status: 403, motivo: "REAUTENTICACAO_RECENTE" }).mensagem, /10 minutos/);
  assert.equal(e({ status: 403, erro: "ESCRITA_DESLIGADA", mensagem: "x" }), "negado");
  assert.equal(e({ status: 500, mensagem: "falhou" }), "erro");
});

test("10 — Dashboard Financeiro: v2 só com status liberado; desligado/não liberado segue como hoje; falha = erro (nunca legado)", async () => {
  const http = (data, falha = false) => ({ get: async (url) => { assert.equal(url, "/api/v1/financeiro-v2/status"); if (falha) throw new Error("rede"); return { data }; } });
  assert.deepEqual(await resolverFinanceiroV2(http({ liberado: false, disponivel: false, operavel: false, motivo: "FINANCEIRO_V2_DESLIGADO" })), { ok: true, liberado: false, operavel: false, motivo: "FINANCEIRO_V2_DESLIGADO" });
  assert.deepEqual(await resolverFinanceiroV2(http({ liberado: true, disponivel: true, operavel: true, motivo: null })), { ok: true, liberado: true, operavel: true, motivo: null });
  assert.equal((await resolverFinanceiroV2(http({ liberado: true, disponivel: true, operavel: false, motivo: "SEM_CONCESSAO" }))).operavel, false);
  assert.deepEqual(await resolverFinanceiroV2(http(null, true)), { ok: false });
  assert.deepEqual(await resolverFinanceiroV2(http({ liberado: "sim" })), { ok: false }, "resposta malformada não vira legado");
  assert.equal(ENDERECO_FINANCEIRO_V2, "/financeiro-v2/?modo=plataforma#/visao-geral");
});
