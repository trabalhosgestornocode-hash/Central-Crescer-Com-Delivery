// Execução 10 — ROTAS do Financeiro v2 na plataforma, de ponta a ponta no PostgreSQL ISOLADO (schema dedicado):
// sessão da plataforma (simulada no formato de requireAuth + requireContexto) → rotas → adaptador → GATEWAY real em
// processo (credencial da autoridade do ambiente isolado, canal assinado, token conferido no "provedor" sintético) →
// banco. Dados e identidades SINTÉTICOS.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import {
  ACAO, CODIGO, alterarLiberacaoPostgres, criarAdaptadorDaPlataforma, criarLiberacoesPostgres, criarNucleoFinanceiro, criarRepositorioPostgres, verificadorHs256,
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
const PESSOA_ADMIN = "dddddddd-0000-4000-8000-0000000000a9";
const ESCOPOS = [{ organizacaoId: ORG_A, unidadeId: UNI_A }, { organizacaoId: ORG_A, unidadeId: UNI_A2 }, { organizacaoId: ORG_B, unidadeId: UNI_B }];

/** "Provedor de identidade" sintético: só aceita tokens assinados com o segredo de teste. */
const provedor = verificadorHs256(SEGREDO_SINTETICO);
const obterUsuario = async (token) => { const p = provedor(token); return p && p.exp * 1000 > Date.now() ? { id: p.sub } : null; };
/** Vínculos da plataforma (memória): pessoa → conta, unidades; conta compartilhada tem 2 pessoas. */
const VINCULOS = { [PESSOA]: { conta: CONTA, unidades: [UNI_A, UNI_A2] }, [PESSOA_SEM]: { conta: CONTA_SEM, unidades: [UNI_A] }, [PESSOA_COMP]: { conta: CONTA_COMP, unidades: [UNI_A, UNI_A2] }, [PESSOA_NADA]: { conta: CONTA_NADA, unidades: [UNI_A] }, [PESSOA_ADMIN]: { conta: ADMIN, unidades: [UNI_A, UNI_A2] } };
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
  // ATIVAÇÃO: administrador da EMPRESA (só a conta ADMIN), candidatos = pessoas com vínculo na unidade
  const administracao = {
    autoridadeSobre: async ({ contaId }) => (contaId === ADMIN ? { tipo: "ADMIN_EMPRESA" } : null),
    contaDoPerfil: vinculos.contaDoPerfil,
    pessoasDaUnidade: async ({ unidadeId }) => Object.entries(VINCULOS).filter(([, v]) => v.unidades.includes(unidadeId)).map(([perfilId, v]) => ({ perfilId, nome: `Pessoa ${perfilId.slice(-2)}`, contaId: v.conta })),
  };
  app.use("/ativacao", criarRotasFinanceiroV2({ habilitado: true, provisionamentoHabilitado: true, dependencias: () => ({ repositorio: repoLocal, adaptador: adaptadorLocal, vinculos, liberacoes: criarLiberacoesPostgres({ poolApp }), mfa, poolAutoridade: poolAut, administracao }) }));
  app.use("/local", criarRotasFinanceiroV2({ habilitado: true, dependencias: () => ({ repositorio: repoLocal, adaptador: adaptadorLocal, vinculos }) }));
  // PRODUÇÃO com escrita ligada (só para o teste da abertura): co-localizado + FV2_ESCRITA_HABILITADA=1
  app.use("/localescrita", criarRotasFinanceiroV2({ habilitado: true, escritaHabilitada: true, dependencias: () => ({ repositorio: repoLocal, adaptador: adaptadorLocal, vinculos }) }));
  app.use("/desligado", criarRotasFinanceiroV2({ habilitado: false, dependencias: () => { throw new Error("não deveria criar nada desligado"); } }));
  const servidorApp = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const urlApp = `http://127.0.0.1:${servidorApp.address().port}`;
  fechar.push(() => servidorGateway.close(), () => servidorApp.close());
  ambiente = { urlApp, urlGateway, eventos, poolApp, poolAut, dono: await abrirPool(b.urlAdmin, { max: 2 }) };
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

test("10 — ATIVAÇÃO: administrador da empresa com TOTP recente provisiona a 1ª administração (nunca a si mesmo, nunca duas) e libera SÓ a unidade da sessão; revogação volta ao financeiro atual", pular, async () => {
  const adm = (extra = {}) => sessao({ conta: ADMIN, pessoa: PESSOA_ADMIN, unidade: UNI_A2, ...extra });
  const tkAdm = (o = {}) => token(ADMIN, { fatorHaS: 30, ...o });
  // quem não é administrador da empresa não vê nem faz nada
  assert.equal((await get("/ativacao/administracao/contexto", { s: sessao({ unidade: UNI_A2 }) })).corpo.motivo, "SEM_AUTORIDADE_ADMINISTRATIVA");
  // contexto: unidade da SESSÃO, candidatos com vínculo (sem o próprio atestante)
  const ctx = await get("/ativacao/administracao/contexto", { s: adm(), t: tkAdm() });
  assert.equal(ctx.status, 200, JSON.stringify(ctx.corpo));
  assert.equal(ctx.corpo.unidade.id, UNI_A2);
  assert.deepEqual(ctx.corpo.liberacao, { empresa: true, unidade: false });
  assert.ok(ctx.corpo.candidatos.some((c) => c.perfilId === PESSOA && c.contaPessoal === true));
  assert.ok(ctx.corpo.candidatos.some((c) => c.perfilId === PESSOA_COMP && c.contaPessoal === false), "conta compartilhada aparece marcada");
  assert.ok(!ctx.corpo.candidatos.some((c) => c.perfilId === PESSOA_ADMIN), "o atestante não aparece");
  const prov = (corpo, o = {}) => get("/ativacao/administracao/provisionar", { metodo: "POST", corpo, s: adm(), t: tkAdm(o) });
  const ato = { perfilId: PESSOA, justificativa: "Administradora financeira inicial indicada pela gestão (sintético).", evidencia: "Ata sintética 001" };
  // sem 2º fator recente, autoconcessão e conta compartilhada: recusados
  assert.equal((await prov(ato, { metodo: null })).corpo.codigo, "FV2_PROVISIONAMENTO_RECUSADO", "sem 2º fator recente");
  assert.ok([403, 409].includes((await prov({ ...ato, perfilId: PESSOA_ADMIN })).status), "autoconcessão");
  assert.ok([403, 409].includes((await prov({ ...ato, perfilId: PESSOA_COMP })).status), "conta compartilhada");
  assert.equal((await prov({ ...ato, unidadeId: UNI_A })).corpo.codigo, "CAMPO_DESCONHECIDO", "a unidade nunca vem do corpo");
  // provisiona e não deixa provisionar de novo
  const ok = await prov(ato);
  assert.equal(ok.status, 200, JSON.stringify(ok.corpo));
  assert.ok((await prov({ ...ato, perfilId: PESSOA_NADA })).status >= 400, "a unidade já tem administrador");
  // antes da liberação, a pessoa provisionada ainda vê o financeiro atual
  assert.equal((await get("/ativacao/status", { s: sessao({ unidade: UNI_A2 }) })).corpo.liberado, false);
  const lib = (corpo, o = {}) => get("/ativacao/administracao/liberacao", { metodo: "POST", corpo, s: adm(), t: tkAdm(o) });
  const J = "Ativação controlada da unidade 2 (sintética) aprovada.";
  assert.equal((await lib({ ativa: true, justificativa: J }, { metodo: null })).corpo.motivo, "MFA_SEM_SEGUNDO_FATOR");
  assert.equal((await lib({ ativa: true, justificativa: "curta" })).corpo.codigo, "JUSTIFICATIVA_INSUFICIENTE");
  const ligada = await lib({ ativa: true, justificativa: J });
  assert.equal(ligada.status, 200, JSON.stringify(ligada.corpo));
  assert.deepEqual(ligada.corpo.liberacao, { empresa: true, unidade: true });
  assert.deepEqual((await get("/ativacao/status", { s: sessao({ unidade: UNI_A2 }) })).corpo, { liberado: true, disponivel: true, operavel: true, motivo: null });
  assert.equal((await get(`/ativacao/api/caixa-e-bancos${PERIODO}`, { s: sessao({ unidade: UNI_A2 }) })).status, 200, "consulta liberada (sem dados presumidos)");
  // revogação
  const desligada = await lib({ ativa: false, justificativa: "Revogação sintética da ativação da unidade 2." });
  assert.deepEqual(desligada.corpo.liberacao, { empresa: true, unidade: false });
  assert.equal((await get("/ativacao/status", { s: sessao({ unidade: UNI_A2 }) })).corpo.liberado, false, "volta ao financeiro atual");
  // chave desligada (padrão): nada do procedimento responde
  assert.equal((await get("/local/administracao/contexto", { s: adm(), t: tkAdm() })).status, 404);
});

test("abertura — ESCRITA no modo CO-LOCALIZADO (produção): identidade, concessão, escopo/RLS, auditoria, idempotência, transação, concorrência, revogação e desligamento imediatos", pular, async () => {
  const { dono, poolAut } = await montar();
  const contar = async (q, p = []) => Number((await dono.query(q, p)).rows[0].n);
  const W = (caminho, corpo, o = {}) => get(`/localescrita/acoes${caminho}`, { metodo: "POST", corpo, ...o });
  // plano: idempotente (já implantado na semente) — repetir não cria nada
  const plano = await W("/configuracoes/implantar-plano", { modelo: "ACAITERIA", modeloConfirmado: "ACAITERIA" });
  assert.equal(plano.status, 200, JSON.stringify(plano.corpo));
  const categorias = await contar("select count(*) n from financeiro_v2.fv2_categoria where unidade_id = $1", [UNI_A]);
  await W("/configuracoes/implantar-plano", { modelo: "ACAITERIA", modeloConfirmado: "ACAITERIA" });
  assert.equal(await contar("select count(*) n from financeiro_v2.fv2_categoria where unidade_id = $1", [UNI_A]), categorias);
  // saldo de abertura: grava com autoria individual e histórico; repetir é idempotente; 5 envios simultâneos = 1 registro
  const contas = await get(`/local/api/caixa-e-bancos${PERIODO}`);
  const conta = contas.corpo.contas.find((c) => c.nome === "Banco Sintético da Rota").id;
  const saldo = { conta, data: "2026-10-31", referencia: "FIM_DO_DIA", valor: "2.500,00", observacao: "Saldo sintético conferido com extrato sintético." };
  const r1 = await W("/saldos/registrar", saldo);
  assert.equal(r1.status, 200, JSON.stringify(r1.corpo));
  await Promise.all(Array.from({ length: 5 }, () => W("/saldos/registrar", saldo)));
  assert.equal(await contar("select count(*) n from financeiro_v2.fv2_saldo_conta where conta_id = $1 and data = '2026-10-31'", [conta]), 1, "idempotente e sem duplicar sob concorrência");
  assert.equal(await contar("select count(*) n from financeiro_v2.fv2_saldo_conta s join financeiro_v2.fv2_historico h on h.registro_id = s.id where s.conta_id = $1 and s.data = '2026-10-31' and h.usuario_id = $2", [conta, PESSOA]), 1, "auditoria com a pessoa individual");
  // mesmo dia/conta com OUTRO valor: conflito, nunca sobrescreve
  assert.ok((await W("/saldos/registrar", { ...saldo, valor: "9,99" })).status >= 400);
  // transação: obrigação inválida não grava nada
  const antes = await contar("select count(*) n from financeiro_v2.fv2_obrigacao");
  assert.ok((await W("/obrigacoes/registrar", { descricao: "Inválida", valor: "10,00", categoria: "NAO_EXISTE", competencia: "2026-10", dataEmissao: "2026-10-02", vencimento: "2026-10-20", fornecedor: "dddddddd-0000-4000-8000-00000000ffff" })).status >= 400);
  assert.equal(await contar("select count(*) n from financeiro_v2.fv2_obrigacao"), antes);
  const fornecedores = await contar("select count(*) n from financeiro_v2.fv2_contraparte");
  assert.ok((await W("/obrigacoes/registrar", { descricao: "Inválida", valor: "10,00", categoria: "NAO_EXISTE", competencia: "2026-10", dataEmissao: "2026-10-02", vencimento: "2026-10-20", fornecedorNovo: "Fornecedor Órfão Sintético" })).status >= 400);
  assert.equal(await contar("select count(*) n from financeiro_v2.fv2_contraparte"), fornecedores, "fornecedor novo + obrigação inválida: nada fica gravado");
  // reenvio do MESMO formulário (mesma chave): 1 obrigação e 1 fornecedor, nunca duplicados — mesmo com envios simultâneos
  const form = { descricao: "Boleto sintético de abertura", valor: "321,00", categoria: "INSUMOS", competencia: "2026-10", dataEmissao: "2026-10-05", vencimento: "2026-11-05", fornecedorNovo: "Fornecedor Sintético da Abertura", chave: "eeeeeeee-0000-4000-8000-000000000001" };
  const obrigacoes = await contar("select count(*) n from financeiro_v2.fv2_obrigacao");
  const respostas = await Promise.all([W("/obrigacoes/registrar", form), W("/obrigacoes/registrar", form), W("/obrigacoes/registrar", form)]);
  assert.ok(respostas.every((x) => x.status === 200), JSON.stringify(respostas.map((x) => x.corpo)));
  assert.equal(await contar("select count(*) n from financeiro_v2.fv2_obrigacao"), obrigacoes + 1);
  assert.equal(await contar("select count(*) n from financeiro_v2.fv2_contraparte"), fornecedores + 1);
  assert.ok((await W("/obrigacoes/registrar", { ...form, valor: "999,00" })).status >= 400, "mesma chave com outro conteúdo: conflito, nunca sobrescreve");
  // escopo: a unidade nunca vem do corpo; unidade não liberada e outra empresa recusadas; RLS: nada da unidade A visto pela B
  assert.equal((await W("/saldos/registrar", { ...saldo, unidade: UNI_A2 })).corpo.codigo, "CAMPO_DESCONHECIDO");
  assert.equal((await W("/saldos/registrar", saldo, { s: sessao({ unidade: UNI_A2 }) })).corpo.motivo, "UNIDADE_NAO_LIBERADA");
  assert.ok((await W("/saldos/registrar", saldo, { s: sessao({ org: ORG_B, unidade: UNI_B }) })).status >= 400);
  // sem concessão / impersonação / conta compartilhada: recusados
  assert.equal((await W("/saldos/registrar", saldo, { s: sessao({ conta: CONTA_NADA, pessoa: PESSOA_NADA }) })).corpo.motivo, "SEM_CONCESSAO");
  assert.equal((await W("/saldos/registrar", saldo, { s: sessao({ extra: { impersonando: true, impersonadoPor: ADMIN } }) })).status, 403);
  assert.equal((await W("/saldos/registrar", saldo, { s: sessao({ conta: CONTA_COMP, pessoa: PESSOA_COMP }) })).corpo.motivo, "CONTA_COMPARTILHADA");
  // sensível (conceder) exige TOTP recente também no co-localizado
  const conceder = { usuario: PESSOA_NADA, justificativa: "Concessão sintética para testar a revogação imediata.", acao_ver: true, acao_registrar: true };
  assert.equal((await W("/permissoes/conceder", conceder, { t: token(CONTA, { metodo: null }) })).corpo.motivo, "MFA_SEM_SEGUNDO_FATOR");
  const concedida = await W("/permissoes/conceder", conceder, { t: token(CONTA, { fatorHaS: 20 }) });
  assert.equal(concedida.status, 200, JSON.stringify(concedida.corpo));
  const sNada = sessao({ conta: CONTA_NADA, pessoa: PESSOA_NADA });
  assert.equal((await W("/saldos/registrar", { ...saldo, data: "2026-10-30" }, { s: sNada })).status, 200, "a concessão vale na hora");
  // revogação: vale na PRÓXIMA requisição (o banco derruba as sessões da pessoa)
  const rev = await W("/permissoes/revogar", { usuario: PESSOA_NADA, justificativa: "Revogação sintética imediata (teste da abertura)." }, { t: token(CONTA, { fatorHaS: 20 }) });
  assert.equal(rev.status, 200, JSON.stringify(rev.corpo));
  assert.equal((await W("/saldos/registrar", { ...saldo, data: "2026-10-29" }, { s: sNada })).corpo.motivo, "SEM_CONCESSAO");
  // desligamento imediato pela LIBERAÇÃO (sem deploy): desligar a unidade recusa a próxima escrita; religar volta
  const prova = { ok: true, contaId: ADMIN, segundoFatorEm: Date.now() - 60_000 };
  const lib = (ativa) => alterarLiberacaoPostgres(poolAut, { organizacaoId: ORG_A, unidadeId: UNI_A, ativa, atorContaId: ADMIN, justificativa: "Desligamento sintético para o teste da abertura.", provaDeSegundoFator: prova });
  await lib(false);
  assert.equal((await W("/saldos/registrar", { ...saldo, data: "2026-10-28" })).corpo.motivo, "UNIDADE_NAO_LIBERADA");
  await lib(true);
  assert.equal((await W("/saldos/registrar", { ...saldo, data: "2026-10-28" })).status, 200);
  // chave geral desligada: nada responde
  assert.equal((await get("/desligado/acoes/saldos/registrar", { metodo: "POST", corpo: saldo })).status, 404);
  // auditoria de concessões: conceder e revogar registrados com o ator individual
  assert.equal(await contar("select count(*) n from financeiro_v2.fv2_auditoria_concessao where usuario_alvo = $1 and ator = $2", [PESSOA_NADA, PESSOA]), 2);
});

test("abertura — rotas NOVAS no modo CO-LOCALIZADO: contas, saldo de abertura, títulos anteriores, recebíveis e caixa (escrita desligada, escopo, duplicidade, concorrência, transação)", pular, async () => {
  const { dono } = await montar();
  const contar = async (q, p = []) => Number((await dono.query(q, p)).rows[0].n);
  const W = (caminho, corpo, o = {}) => get(`/localescrita/acoes${caminho}`, { metodo: "POST", corpo, ...o });
  const COMP = "2026-11";
  const unicred = { tipo: "BANCARIA", nome: "Unicred Sintética", instituicao: "Unicred" };
  // Produção hoje (FV2_ESCRITA_HABILITADA=0): as rotas novas também só respondem "somente consulta".
  for (const [caminho, corpo] of [["/configuracoes/conta/criar", unicred], ["/caixa/abrir", { conta: "x", data: "2026-11-01", contado: "1,00" }], ["/abertura/obrigacao-anterior", {}]]) {
    assert.equal((await get(`/local/acoes${caminho}`, { metodo: "POST", corpo })).corpo.codigo, "ESCRITA_DESLIGADA");
  }
  // Conta: 5 envios simultâneos = 1 conta; o campo "saldo" não existe; a unidade nunca vem do corpo.
  const contasAntes = await contar("select count(*) n from financeiro_v2.fv2_conta where unidade_id = $1", [UNI_A]);
  const rs = await Promise.all(Array.from({ length: 5 }, () => W("/configuracoes/conta/criar", unicred)));
  assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.corpo)));
  assert.equal(new Set(rs.map((r) => r.corpo.id)).size, 1);
  assert.equal(await contar("select count(*) n from financeiro_v2.fv2_conta where unidade_id = $1", [UNI_A]), contasAntes + 1);
  const conta = rs[0].corpo.id;
  assert.equal((await W("/configuracoes/conta/criar", { ...unicred, saldo: "100,00" })).corpo.codigo, "CAMPO_DESCONHECIDO");
  assert.equal((await W("/configuracoes/conta/criar", { ...unicred, unidade: UNI_A2 })).corpo.codigo, "CAMPO_DESCONHECIDO");
  assert.equal((await W("/configuracoes/conta/criar", unicred, { s: sessao({ unidade: UNI_A2 }) })).corpo.motivo, "UNIDADE_NAO_LIBERADA");
  assert.equal((await W("/configuracoes/conta/criar", unicred, { s: sessao({ conta: CONTA_NADA, pessoa: PESSOA_NADA }) })).corpo.motivo, "SEM_CONCESSAO");
  // Saldo de abertura: origem obrigatória; grava na véspera (31/10) com a pessoa individual.
  assert.equal((await W("/abertura/saldo", { conta, competencia: COMP, valor: "1.000,00" })).status, 400);
  const s = await W("/abertura/saldo", { conta, competencia: COMP, valor: "1.000,00", origem: "Extrato sintético de 31/10" });
  assert.equal(s.status, 200, JSON.stringify(s.corpo));
  assert.deepEqual([s.corpo.saldo.data, s.corpo.saldo.referencia, s.corpo.saldo.criadoPor], ["2026-10-31", "FIM_DO_DIA", PESSOA]);
  // Título anterior: inválido não deixa fornecedor órfão; reenvio simultâneo = 1 título; fora da DRE.
  const forn = () => contar("select count(*) n from financeiro_v2.fv2_contraparte where unidade_id = $1", [UNI_A]);
  const fornAntes = await forn();
  const base = { fornecedorNovo: "Fornecedor Anterior Sintético", descricao: "NF sintética", valor: "300,00", competencia: COMP, dataEmissao: "2026-10-15", vencimento: "2026-11-12", origem: "Lista sintética de 31/10" };
  assert.equal((await W("/abertura/obrigacao-anterior", { ...base, dataEmissao: "2026-11-03", chave: "11111111-1111-4111-8111-111111111111" })).status, 400);
  assert.equal(await forn(), fornAntes, "transação inteira desfeita");
  const ob = { ...base, chave: "22222222-2222-4222-8222-222222222222" };
  const os = await Promise.all([W("/abertura/obrigacao-anterior", ob), W("/abertura/obrigacao-anterior", ob), W("/abertura/obrigacao-anterior", ob)]);
  assert.ok(os.every((r) => r.status === 200), JSON.stringify(os.map((r) => r.corpo)));
  assert.equal(new Set(os.map((r) => r.corpo.obrigacoes[0].id)).size, 1);
  assert.equal(await forn(), fornAntes + 1);
  assert.equal(os[0].corpo.lancamento.natureza, "PATRIMONIAL");
  // Recebível: repasse de processador do período recusado; anterior aceito sem receita.
  assert.equal((await W("/recebiveis/registrar", { processador: "STONE", valor: "10,00", competencia: COMP })).status, 400);
  const rec = await W("/abertura/recebivel-anterior", { processador: "IFOOD", descricao: "Repasse sintético", valor: "400,00", competencia: COMP, dataOrigem: "2026-10-27", origem: "Demonstrativo sintético", chave: "33333333-3333-4333-8333-333333333333" });
  assert.equal(rec.status, 200, JSON.stringify(rec.corpo));
  assert.equal(rec.corpo.lancamentosDeRetencao.length, 0);
  // Caixa físico: abrir com o contado; operação reenviada 3× ao mesmo tempo = 1.
  const caixa = (await W("/configuracoes/conta/criar", { tipo: "CAIXA_FISICO", nome: "Caixa físico sintético" })).corpo.id;
  const ab = await W("/caixa/abrir", { conta: caixa, data: "2026-11-01", contado: "200,00" });
  assert.equal(ab.status, 200, JSON.stringify(ab.corpo));
  const op = { sessao: ab.corpo.sessao.id, operacao: "SAIDA", valor: "15,00", data: "2026-11-01", descricao: "Saída sintética", chave: "44444444-4444-4444-8444-444444444444" };
  const ops = await Promise.all([W("/caixa/operacao", op), W("/caixa/operacao", op), W("/caixa/operacao", op)]);
  assert.ok(ops.every((r) => r.status === 200), JSON.stringify(ops.map((r) => r.corpo)));
  assert.equal(await contar("select count(*) n from financeiro_v2.fv2_movimentacao where conta_id = $1", [caixa]), 1);
  // DRE da competência de início: nada de receita ou despesa nascida da abertura.
  const dre = await get(`/local/api/dre?competencia=${COMP}`);
  assert.equal(dre.status, 200);
  for (const k of ["FATURAMENTO_BRUTO_PROPRIO", "RESULTADO_GERENCIAL"]) assert.ok([null, 0].includes(dre.corpo.indicadores?.[k]?.valorCentavos ?? null), `${k}: ${JSON.stringify(dre.corpo.indicadores?.[k])}`);
  // Plano: sem o nome do modelo redigitado, nada é implantado.
  assert.equal((await W("/configuracoes/implantar-plano", { modelo: "ACAITERIA" })).corpo.codigo, CODIGO.CONFIRMACAO_EXIGIDA);
});
