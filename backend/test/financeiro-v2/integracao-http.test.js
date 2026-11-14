// Execução 10 — ROTAS do Financeiro v2 na plataforma, de ponta a ponta no PostgreSQL ISOLADO (schema dedicado):
// sessão da plataforma (simulada no formato de requireAuth + requireContexto) → rotas → adaptador → GATEWAY real em
// processo (credencial da autoridade do ambiente isolado, canal assinado, token conferido no "provedor" sintético) →
// banco. Dados e identidades SINTÉTICOS.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import {
  ACAO, alterarLiberacaoPostgres, criarAdaptadorDaPlataforma, criarLiberacoesPostgres, criarNucleoFinanceiro, criarRepositorioPostgres, verificadorHs256,
} from "../../src/modules/financeiro-v2/index.js";
import { criarRotasFinanceiroV2 } from "../../src/modules/fv2-integracao/rotas.js";
import { criarClienteDoGateway } from "../../src/modules/fv2-integracao/clienteGateway.js";
import { criarConcessoesDaSessao } from "../../src/modules/fv2-integracao/portasPlataforma.js";
import { criarMfaPeloProvedor } from "../../src/modules/fv2-integracao/mfaPeloProvedor.js";
import { CABECALHO, assinarPedido } from "../../src/modules/fv2-integracao/canalGateway.js";
import { criarGateway } from "../../src/fv2-gateway/gateway.js";
import { criarAutoridadeCoLocalizada } from "../../src/modules/fv2-integracao/autoridadeCoLocalizada.js";
import { ORG_A, UNI_A, UNI_A2, ORG_B, UNI_B } from "./helpers/cenario.js";
import { abrirPool, criarAutoridadeDeTeste, criarBancoDeTeste, motivoParaPular } from "./helpers/postgres.js";
import { SEGREDO_SINTETICO, tokenSintetico } from "./helpers/tokens.js";

const pular = { skip: motivoParaPular() };
const CHAVE = "chave-sintetica-do-canal-de-teste-0123456789abcdef";
const CONTA = "dddddddd-0000-4000-8000-0000000000c1";
const PESSOA = "dddddddd-0000-4000-8000-0000000000a1";
const CONTA_SEM = "dddddddd-0000-4000-8000-0000000000c2";
const PESSOA_SEM = "dddddddd-0000-4000-8000-0000000000a2";
const CONTA_COMP = "dddddddd-0000-4000-8000-0000000000c3";
const PESSOA_COMP = "dddddddd-0000-4000-8000-0000000000a3";
const ADMIN = "dddddddd-0000-4000-8000-0000000000c9";
const CONTA_NADA = "dddddddd-0000-4000-8000-0000000000c4";
const PESSOA_NADA = "dddddddd-0000-4000-8000-0000000000a4";
const ESCOPOS = [{ organizacaoId: ORG_A, unidadeId: UNI_A }, { organizacaoId: ORG_A, unidadeId: UNI_A2 }, { organizacaoId: ORG_B, unidadeId: UNI_B }];

/** "Provedor de identidade" sintético: só aceita tokens assinados com o segredo de teste. */
const provedor = verificadorHs256(SEGREDO_SINTETICO);
const obterUsuario = async (token) => { const p = provedor(token); return p && p.exp * 1000 > Date.now() ? { id: p.sub } : null; };
/** Vínculos da plataforma (memória): pessoa → conta, unidades; conta compartilhada tem 2 pessoas. */
const VINCULOS = { [PESSOA]: { conta: CONTA, unidades: [UNI_A, UNI_A2] }, [PESSOA_SEM]: { conta: CONTA_SEM, unidades: [UNI_A] }, [PESSOA_COMP]: { conta: CONTA_COMP, unidades: [UNI_A] }, [PESSOA_NADA]: { conta: CONTA_NADA, unidades: [UNI_A] } };
const vinculos = {
  contaDoPerfil: async ({ perfilId }) => VINCULOS[perfilId]?.conta ?? null,
  perfisAtivosDaConta: async ({ contaId }) => (contaId === CONTA_COMP ? 2 : Object.values(VINCULOS).filter((v) => v.conta === contaId).length),
  unidadesDoPerfil: async ({ perfilId, organizacaoId }) => (organizacaoId === ORG_A ? VINCULOS[perfilId]?.unidades ?? [] : []),
};

const sessao = ({ conta = CONTA, pessoa = PESSOA, unidade = UNI_A, org = ORG_A, expira = Date.now() + 3600_000, extra = {} } = {}) => ({
  user: { id: conta, ativo: true, senhaProvisoria: false, aal: "aal2" },
  tenant: { organizacaoId: org, unidadeId: unidade },
  acesso: { sessionId: `sessao-${pessoa}-${unidade}`, expiraEm: new Date(expira).toISOString(), perfilId: pessoa, papel: "finance", impersonando: false, impersonadoPor: null, empresa: { id: org }, unidade: { id: unidade }, ...extra },
});

let ambiente;
const fechar = [];
after(() => { for (const f of fechar) f(); });
async function montar() {
  if (ambiente) return ambiente;
  const b = await criarBancoDeTeste(ESCOPOS);
  const poolApp = await abrirPool(b.urlApp, { max: 4 });
  const poolAut = await abrirPool(b.urlAutoridade, { max: 2 });
  // Carga sintética (como a PESSOA, com a fixture de concessão do ambiente de teste) — NUNCA pela rota.
  const semente = criarRepositorioPostgres({ pool: poolApp, sessoes: criarAutoridadeDeTeste({ urlAutoridade: b.urlAutoridade, urlAdmin: b.urlAdmin }) });
  const n = criarNucleoFinanceiro({ repositorio: semente, escoposAutorizados: ESCOPOS });
  const c = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: PESSOA, permissoes: Object.values(ACAO) };
  await n.implantarPlanoDeContas(c, { modelo: "ACAITERIA" });
  const conta = await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco Sintético da Rota" });
  await n.registrarSaldoDeConta(c, { contaId: conta.id, data: "2026-10-01", valorCentavos: 123456 });
  // Liberação: empresa A e SÓ a unidade A (pela autoridade, com prova sintética de 2º fator do administrador).
  const prova = { ok: true, contaId: ADMIN, segundoFatorEm: Date.now() - 60_000 };
  const ato = (unidadeId) => ({ organizacaoId: ORG_A, unidadeId, ativa: true, atorContaId: ADMIN, justificativa: "Liberação sintética do teste de rotas (Execução 10).", provaDeSegundoFator: prova });
  await alterarLiberacaoPostgres(poolAut, ato(null));
  await alterarLiberacaoPostgres(poolAut, ato(UNI_A));
  // Gateway real em processo
  const eventos = [];
  const mfa = criarMfaPeloProvedor({ obterUsuario });
  const servidorGateway = createServer(criarGateway({ poolAutoridade: poolAut, chave: CHAVE, obterUsuario, mfa, registrar: (e) => eventos.push(e) }));
  await new Promise((r) => { servidorGateway.listen(0, "127.0.0.1", r); });
  const urlGateway = `http://127.0.0.1:${servidorGateway.address().port}`;
  const repositorio = criarRepositorioPostgres({ pool: poolApp, sessoes: criarClienteDoGateway({ url: urlGateway, chave: CHAVE }) });
  const adaptador = criarAdaptadorDaPlataforma({ liberacoes: criarLiberacoesPostgres({ poolApp }), vinculos, concessoes: criarConcessoesDaSessao({ repositorio }), mfa });
  // "Plataforma": as sessões vêm de um mapa do teste (no app real: requireAuth + requireContexto)
  const app = express();
  app.use((req, _res, next) => { const s = JSON.parse(req.header("x-teste-sessao") ?? "null"); if (s) Object.assign(req, s); next(); });
  app.use("/ligado", criarRotasFinanceiroV2({ habilitado: true, dependencias: () => ({ repositorio, adaptador, vinculos }) }));
  app.use("/escrita", criarRotasFinanceiroV2({ habilitado: true, escritaHabilitada: true, dependencias: () => ({ repositorio, adaptador, vinculos: { ...vinculos, nomesDosPerfis: async ({ perfilIds }) => new Map(perfilIds.map((x) => [x, x === PESSOA ? "Pessoa Sintética" : null])) } }) }));
  // MODO CO-LOCALIZADO (um só serviço): a mesma regra da autoridade, no processo, com o pool PRÓPRIO da autoridade
  const repoLocal = criarRepositorioPostgres({ pool: poolApp, sessoes: criarAutoridadeCoLocalizada({ poolAutoridade: poolAut, obterUsuario, mfa }) });
  const adaptadorLocal = criarAdaptadorDaPlataforma({ liberacoes: criarLiberacoesPostgres({ poolApp }), vinculos, concessoes: criarConcessoesDaSessao({ repositorio: repoLocal }), mfa });
  app.use("/local", criarRotasFinanceiroV2({ habilitado: true, dependencias: () => ({ repositorio: repoLocal, adaptador: adaptadorLocal, vinculos }) }));
  app.use("/desligado", criarRotasFinanceiroV2({ habilitado: false, dependencias: () => { throw new Error("não deveria criar nada desligado"); } }));
  const servidorApp = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const urlApp = `http://127.0.0.1:${servidorApp.address().port}`;
  fechar.push(() => servidorGateway.close(), () => servidorApp.close());
  ambiente = { urlApp, urlGateway, eventos, poolApp };
  return ambiente;
}

const token = (conta = CONTA, o = {}) => tokenSintetico({ agoraMs: Date.now(), conta, ...o });
async function get(caminho, { s = sessao(), t = token(s.user.id), metodo = "GET", corpo, tipo = "application/json" } = {}) {
  const { urlApp } = await montar();
  const r = await fetch(`${urlApp}${caminho}`, { method: metodo, headers: { authorization: `Bearer ${t}`, "x-teste-sessao": JSON.stringify(s), ...(corpo !== undefined ? { "content-type": tipo } : {}) }, ...(corpo !== undefined ? { body: typeof corpo === "string" ? corpo : JSON.stringify(corpo) } : {}) });
  return { status: r.status, corpo: await r.json() };
}
const PERIODO = "?inicio=2026-10-01&fim=2026-10-31";

test("10 — desligado (padrão): /status diz não liberado, consultas 404, nada é criado; escrita 405", pular, async () => {
  assert.deepEqual((await get("/desligado/status")).corpo, { liberado: false, disponivel: false, operavel: false, motivo: "FINANCEIRO_V2_DESLIGADO" });
  assert.equal((await get(`/desligado/api/caixa-e-bancos${PERIODO}`)).status, 404);
  assert.equal((await get("/desligado/api/caixa-e-bancos", { metodo: "POST" })).status, 405);
  assert.equal((await get("/ligado/api/caixa-e-bancos", { metodo: "POST" })).status, 405, "somente leitura nesta fase");
});

test("10 — pessoa com concessão na unidade liberada: status operável e a consulta lê do banco pelo gateway", pular, async () => {
  const { eventos } = await montar();
  assert.deepEqual((await get("/ligado/status")).corpo, { liberado: true, disponivel: true, operavel: true, motivo: null });
  const r = await get(`/ligado/api/caixa-e-bancos${PERIODO}`);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.ok(r.corpo.contas.some((c) => c.nome === "Banco Sintético da Rota"));
  assert.ok(eventos.some((e) => e.tipo === "SESSAO_EMITIDA" && e.pessoa === PESSOA && e.unidadeId === UNI_A && e.validadeSegundos <= 900));
  assert.ok(!JSON.stringify(eventos).includes(token().split(".")[0] + "."), "nenhum token nos registros do gateway");
  for (const caminho of ["/ligado/api/contas-a-pagar", "/ligado/api/contas-a-receber", "/ligado/api/visao-geral?competencia=2026-10", "/ligado/api/dre?competencia=2026-10", "/ligado/api/conferencias?competencia=2026-10", "/ligado/api/permissoes"]) {
    assert.equal((await get(caminho)).status, 200, caminho);
  }
});

test("10 — recusas da plataforma: unidade não liberada, impersonação, exibição, conta compartilhada, sem concessão, expirada, outra empresa", pular, async () => {
  const caso = async (s, esperado, motivo, t) => {
    const r = await get(`/ligado/api/caixa-e-bancos${PERIODO}`, { s, ...(t ? { t } : {}) });
    assert.equal(r.status, esperado, `${motivo}: ${JSON.stringify(r.corpo)}`);
    if (motivo) assert.equal(r.corpo.motivo, motivo);
    assert.ok(!JSON.stringify(r.corpo).includes("Banco Sintético"), "nenhum dado vaza na recusa");
  };
  await caso(sessao({ unidade: UNI_A2 }), 403, "UNIDADE_NAO_LIBERADA");
  await caso(sessao({ extra: { impersonando: true, impersonadoPor: ADMIN } }), 403, "IMPERSONACAO");
  await caso(sessao({ extra: { papel: "display_operator" } }), 403, "PERFIL_DE_EXIBICAO");
  await caso(sessao({ conta: CONTA_COMP, pessoa: PESSOA_COMP }), 403, "CONTA_COMPARTILHADA");
  await caso(sessao({ conta: CONTA_SEM, pessoa: PESSOA_SEM }), 403, "SEM_CONCESSAO"); // o BANCO recusou a sessão (FV020)
  await caso(sessao({ expira: Date.now() - 1000 }), 401, "SESSAO_EXPIRADA");
  await caso(sessao({ org: ORG_B, unidade: UNI_B }), 403, "EMPRESA_NAO_LIBERADA");
  // pessoa de OUTRA conta com este login (contexto adulterado)
  await caso(sessao({ pessoa: PESSOA_SEM }), 403, "PESSOA_SEM_IDENTIDADE");
  // token de outra conta (defesa em profundidade na rota; em produção requireAuth deriva a conta do próprio token)
  await caso(sessao(), 401, "TOKEN_DE_OUTRA_CONTA", token(CONTA_SEM));
  const status = await get("/ligado/status", { s: sessao({ unidade: UNI_A2 }) });
  assert.deepEqual(status.corpo, { liberado: false, disponivel: false, operavel: false, motivo: "UNIDADE_NAO_LIBERADA" }, "unidade não liberada segue no financeiro atual");
  assert.equal((await get("/ligado/api/caixa-e-bancos?inicio=2026-10-01&inicio=2026-10-02&fim=2026-10-31")).status, 400, "parâmetro repetido");
});

test("10 — gateway: canal assinado (sem assinatura, adulterado, repetido), escopo diferente da sessão e MFA real nas finalidades sensíveis", pular, async () => {
  const { urlGateway, eventos } = await montar();
  const pedir = async ({ corpoObj, t = token(), cab = null, corpoTexto = null, caminho = "/v1/sessoes" }) => {
    const corpo = corpoTexto ?? JSON.stringify(corpoObj);
    const h = cab ?? assinarPedido({ chave: CHAVE, caminho, corpo });
    const r = await fetch(`${urlGateway}${caminho}`, { method: "POST", headers: { "content-type": "application/json", [CABECALHO.TOKEN]: t, ...h }, body: corpo });
    return { status: r.status, corpo: await r.json() };
  };
  const s = { user: { id: CONTA, ativo: true }, tenant: { organizacaoId: ORG_A, unidadeId: UNI_A }, acesso: sessao().acesso };
  const base = (finalidade = "OPERACAO", escopo = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: PESSOA }) => ({ sessao: s, escopo, permissoes: [], contaPessoal: true, finalidade });
  assert.equal((await pedir({ corpoObj: base() })).status, 200);
  assert.equal((await pedir({ corpoObj: base(), cab: {} })).corpo.motivo, "CANAL_INSTANTE_FORA_DA_JANELA");
  const corpo = JSON.stringify(base());
  const h = assinarPedido({ chave: CHAVE, caminho: "/v1/sessoes", corpo });
  assert.equal((await pedir({ corpoTexto: corpo.replace(PESSOA, PESSOA_SEM), cab: h })).corpo.motivo, "CANAL_ASSINATURA_INVALIDA");
  assert.equal((await pedir({ corpoTexto: corpo, cab: h })).status, 200);
  assert.equal((await pedir({ corpoTexto: corpo, cab: h })).corpo.motivo, "CANAL_NONCE_REPETIDO");
  assert.equal((await pedir({ corpoObj: base("OPERACAO", { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: PESSOA_SEM }) })).corpo.motivo, "ESCOPO_DIFERENTE_DA_SESSAO");
  assert.equal((await pedir({ corpoObj: base("OPERACAO", { organizacaoId: ORG_A, unidadeId: UNI_A2, usuarioId: PESSOA }) })).corpo.motivo, "UNIDADE_DIFERENTE_DA_SESSAO");
  assert.equal((await pedir({ corpoObj: { ...base(), contaPessoal: false } })).corpo.motivo, "CONTA_COMPARTILHADA");
  // finalidade SENSÍVEL: só com segundo fator RECENTE da mesma conta, provado pelo token conferido no provedor
  assert.equal((await pedir({ corpoObj: base("ACAO_SENSIVEL"), t: token(CONTA, { metodo: null }) })).corpo.motivo, "SEM_PROVA_DE_SEGUNDO_FATOR", "só senha");
  assert.equal((await pedir({ corpoObj: base("ACAO_SENSIVEL"), t: token(CONTA, { fatorHaS: 7200, iatHaS: 10 }) })).corpo.motivo, "SEM_PROVA_DE_SEGUNDO_FATOR", "token renovado agora com fator de 2 h atrás");
  assert.equal((await pedir({ corpoObj: base("ACAO_SENSIVEL"), t: token(CONTA, { aal: "aal1" }) })).corpo.motivo, "SEM_PROVA_DE_SEGUNDO_FATOR", "aal1");
  const sensivel = await pedir({ corpoObj: base("ACAO_SENSIVEL"), t: token(CONTA, { fatorHaS: 30 }) });
  assert.equal(sensivel.status, 200);
  assert.ok(eventos.some((e) => e.tipo === "SESSAO_EMITIDA" && e.finalidade === "ACAO_SENSIVEL" && e.segundoFator === true && e.validadeSegundos <= 300));
  assert.equal((await pedir({ corpoObj: base(), t: token(CONTA_SEM) })).corpo.motivo, "TOKEN_DE_OUTRA_CONTA");
  assert.equal((await pedir({ corpoObj: base(), t: tokenSintetico({ agoraMs: Date.now(), conta: CONTA, segredo: "outro-segredo-que-nao-e-do-provedor-xxxxxxxx" }) })).corpo.motivo, "TOKEN_DO_USUARIO_INVALIDO", "assinatura que o provedor não reconhece");
  assert.equal((await pedir({ corpoObj: base(), t: token(CONTA, { expEmS: -10 }) })).corpo.motivo, "TOKEN_DO_USUARIO_INVALIDO", "token expirado");
  // provisionamento sem fator recente é recusado antes do banco
  assert.equal((await pedir({ caminho: "/v1/provisionamentos", corpoObj: { sessao: s, ato: { atestanteId: CONTA } }, t: token(CONTA, { metodo: null }) })).status, 403);
  assert.equal((await fetch(`${urlGateway}/v1/outra`, { method: "POST" })).status, 404);
});

test("10 — sessão e AÇÕES: escrita só com a chave própria, JSON estrito, operação comum grava pelo gateway; sensíveis exigem 2º fator recente; homologar aguarda a matriz", pular, async () => {
  const ses = await get("/escrita/sessao");
  assert.equal(ses.status, 200);
  assert.equal(ses.corpo.modo, "PLATAFORMA");
  assert.deepEqual(ses.corpo.unidades.map((u) => u.id), [UNI_A], "a unidade é a da sessão, nunca a do cliente");
  assert.ok(ses.corpo.unidades[0].permissoes.includes(ACAO.VER));
  const pessoas = await get("/escrita/api/pessoas");
  assert.equal(pessoas.status, 200);
  assert.ok(pessoas.corpo.pessoas.some((x) => x.perfil === PESSOA && x.nome === "Pessoa Sintética"));
  const obrig = { descricao: "Conta sintética pela rota", valor: "1.234,56", categoria: "INSUMOS", competencia: "2026-10", dataEmissao: "2026-10-02", vencimento: "2026-10-20", fornecedorNovo: "Fornecedor Sintético da Rota" };
  // escrita desligada (padrão)
  assert.equal((await get("/ligado/acoes/obrigacoes/registrar", { metodo: "POST", corpo: obrig })).corpo.codigo, "ESCRITA_DESLIGADA");
  // formato
  assert.equal((await get("/escrita/acoes/obrigacoes/registrar", { metodo: "POST", corpo: "descricao=x", tipo: "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await get("/escrita/acoes/obrigacoes/registrar", { metodo: "POST", corpo: { ...obrig, unidade: UNI_A2 } })).corpo.codigo, "CAMPO_DESCONHECIDO", "a unidade nunca vem do corpo");
  // operação comum: grava e aparece na consulta
  const r = await get("/escrita/acoes/obrigacoes/registrar", { metodo: "POST", corpo: obrig });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  const lista = await get("/escrita/api/contas-a-pagar?competencia=2026-10");
  assert.ok(lista.corpo.itens.some((i) => i.valorOriginalCentavos === 123456 || i.valorCentavos === 123456 || JSON.stringify(i).includes("Conta sintética pela rota")));
  // pessoa sem concessão não grava
  assert.equal((await get("/escrita/acoes/obrigacoes/registrar", { metodo: "POST", corpo: obrig, s: sessao({ conta: CONTA_SEM, pessoa: PESSOA_SEM }) })).status, 403);
  // sensível sem 2º fator / com fator antigo → recusa; com fator recente passa da barreira (o núcleo decide o resto)
  const conceder = { usuario: PESSOA_SEM, justificativa: "Concessão sintética de teste da rota.", acao_ver: true };
  const semFator = await get("/escrita/acoes/permissoes/conceder", { metodo: "POST", corpo: conceder, t: token(CONTA, { metodo: null }) });
  assert.equal(semFator.status, 403);
  assert.equal(semFator.corpo.motivo, "MFA_SEM_SEGUNDO_FATOR");
  assert.equal((await get("/escrita/acoes/permissoes/conceder", { metodo: "POST", corpo: conceder, t: token(CONTA, { fatorHaS: 7200, iatHaS: 5 }) })).corpo.motivo, "REAUTENTICACAO_RECENTE");
  const comFator = await get("/escrita/acoes/permissoes/conceder", { metodo: "POST", corpo: conceder, t: token(CONTA, { fatorHaS: 20 }) });
  assert.ok(!String(comFator.corpo.motivo ?? "").startsWith("MFA") && comFator.corpo.motivo !== "REAUTENTICACAO_RECENTE", JSON.stringify(comFator.corpo));
  // homologar: bloqueado pela matriz ANTES de qualquer coisa; reabrir exige 2º fator
  assert.equal((await get("/escrita/acoes/fechamento/alterar", { metodo: "POST", corpo: { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "x" }, t: token(CONTA, { fatorHaS: 20 }) })).corpo.codigo, "HOMOLOGACAO_AGUARDA_MATRIZ");
  assert.equal((await get("/escrita/acoes/fechamento/alterar", { metodo: "POST", corpo: { competencia: "2026-09", novoEstado: "ABERTA", justificativa: "Reabertura sintética." }, t: token(CONTA, { metodo: null }) })).corpo.motivo, "MFA_SEM_SEGUNDO_FATOR");
  // cofre desligado: envio de arquivo indisponível
  assert.equal((await get("/escrita/acoes/documentos/enviar", { metodo: "POST", corpo: {} })).status, 503);
});

test("10 — modo CO-LOCALIZADO (um só serviço): mesma regra da autoridade — consulta, recusas da plataforma e do banco", pular, async () => {
  const r = await get(`/local/api/caixa-e-bancos${PERIODO}`);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.ok(r.corpo.contas.some((c) => c.nome === "Banco Sintético da Rota"));
  const semConc = await get(`/local/api/caixa-e-bancos${PERIODO}`, { s: sessao({ conta: CONTA_NADA, pessoa: PESSOA_NADA }) });
  assert.equal(semConc.corpo.motivo, "SEM_CONCESSAO", `o banco recusa sem concessão (FV020): ${JSON.stringify(semConc)}`);
  assert.equal((await get(`/local/api/caixa-e-bancos${PERIODO}`, { s: sessao({ extra: { impersonando: true, impersonadoPor: ADMIN } }) })).status, 403);
  assert.equal((await get(`/local/api/caixa-e-bancos${PERIODO}`, { s: sessao({ conta: CONTA_COMP, pessoa: PESSOA_COMP }) })).corpo.motivo, "CONTA_COMPARTILHADA");
  assert.equal((await get(`/local/api/caixa-e-bancos${PERIODO}`, { s: sessao({ unidade: UNI_A2 }) })).corpo.motivo, "UNIDADE_NAO_LIBERADA");
  assert.equal((await get("/local/acoes/obrigacoes/registrar", { metodo: "POST", corpo: {} })).corpo.codigo, "ESCRITA_DESLIGADA", "consulta apenas");
});
