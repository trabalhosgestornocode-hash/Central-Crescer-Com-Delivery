// MOVA — Execução 08: H-1 (falhas gerais sem unidade) e isolamento financeiro com tentativas NEGATIVAS de usar configuração
// de produção. PostgreSQL LOCAL de teste; dados sintéticos; IA e WhatsApp simulados.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { ACAO, ErroFinanceiro, comandos, criarConcessoesMemoria, planoDeContas } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ctx, montar } from "../financeiro-v2/helpers/cenario.js";
import { criarControle, criarMova, instalarConfiguracao, validarConfiguracao } from "../../src/modules/mova-financeiro/index.js";
import { ACOES_MOVA, CONSULTAS_MOVA, executarAcaoMova } from "../../src/modules/fv2-integracao/movaRotas.js";
import { EXTRATOR_DESLIGADO, criarRouterMovaIsolado, iniciarMovaEmbutido, lerConfiguracaoMova, montarMova } from "../../src/modules/fv2-integracao/mova.js";
import { assinarRequisicao } from "../../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";
import { criarBancoMova, motivoParaPularMova } from "./helpers/banco.js";

const PULAR = motivoParaPularMova();
const t = (nome, fn) => test(nome, { skip: PULAR }, fn);
const ORG = "dddddddd-0000-4000-8000-000000000001";
const ALFA = "dddddddd-0000-4000-8000-0000000000a1";
const GAMA = "dddddddd-0000-4000-8000-0000000000c1";
const SERVICO = "eeeeeeee-0000-4000-8000-0000000000aa";
const CONVERSA_ALFA = "5500000000777@s.whatsapp.net";
const CONVERSA_GAMA = "120363000000000001@g.us";
const fontes = { situacao: "CONFIRMADA", sistemaDeLoja: "SWF", plataformas: ["IFOOD"] };
const CONFIG = {
  modo: "HOMOLOGACAO", identidadeServico: { usuarioId: SERVICO },
  unidades: [
    { organizacaoId: ORG, unidadeId: ALFA, nome: "Unidade Teste Alfa", apelidos: ["alfa"], fontes },
    { organizacaoId: ORG, unidadeId: GAMA, nome: "Unidade Teste Gama", apelidos: ["gama"], fontes },
  ],
  gruposAutorizados: [{ grupoId: CONVERSA_ALFA, unidades: [ALFA] }, { grupoId: CONVERSA_GAMA, unidades: [GAMA] }],
};
const FINANCEIRO = { ACAO, ErroFinanceiro, validarObrigacao: comandos.validarObrigacao, categoriaProvisoria: planoDeContas.CATEGORIA_DESPESA_A_CLASSIFICAR };
const SEGREDO_TEXTO = "SEGREDO-FICTICIO-NAO-PODE-VAZAR-123";
let seq = 0;
const msg = (grupoId, x = {}) => ({ contratoMova: 1, eventoId: `bly:E8${++seq}`, mensagemId: `E8${seq}`, grupoId, participanteId: grupoId.endsWith("@g.us") ? "100000000000001@lid" : grupoId, telefoneE164: null, nomeExibicao: null, fromMe: false, tipo: "TEXTO", texto: `paguei 12 reais ${SEGREDO_TEXTO}`, respostaA: null, midia: null, recebidoEm: AGORA.toISOString(), origemTipo: "LIVE", ...x });

async function cenario({ extrator = EXTRATOR_DESLIGADO } = {}) {
  const m = montar({ escopos: [ALFA, GAMA].map((unidadeId) => ({ organizacaoId: ORG, unidadeId })) });
  const { pool } = await criarBancoMova();
  await instalarConfiguracao(pool, validarConfiguracao(CONFIG));
  const logs = [];
  const registrar = (e) => logs.push(JSON.stringify(e));
  const controle = criarControle({ pool, cacheMs: 0 });
  const mova = criarMova({ configuracao: CONFIG, nucleo: m.nucleo, concessoes: criarConcessoesMemoria([]), financeiro: FINANCEIRO, pool, relogio: () => AGORA, controle, extrator, registrar });
  const enviar = async (p) => { const r = await mova.receptor.receber(p); await mova.receptor.trabalhar(); return r; };
  return { m, pool, mova, enviar, logs };
}
const ver = (u, perms) => ctx(ORG, u, perms);

// ------------------------------------------------------------------------------------------------ H-1
t("H1-1/4 IA desligada gera falha identificável; administrador com configurar vê as falhas gerais (só metadados)", async () => {
  const s = await cenario();
  await s.enviar(msg(CONVERSA_ALFA));
  const r = await CONSULTAS_MOVA["/mova/falhas-gerais"]({ ctx: ver(ALFA, [ACAO.VER, ACAO.CONFIGURAR]), mova: s.mova });
  assert.equal(r.total, 1);
  assert.deepEqual(r.porTipo, { FALHA_LEITURA: 1 });
  assert.equal(r.itens[0].motivo, "EXTRATOR_FALHOU:IA_DESLIGADA");
  assert.equal(r.itens[0].reprocessavel, true);
  assert.deepEqual(Object.keys(r.itens[0]).sort(), ["em", "estado", "eventoId", "motivo", "reprocessavel", "tentativas", "tipo"]);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SEGREDO_TEXTO), "conteúdo nunca sai");
});

t("H1-2 sem configurar (participante/consulta/aprovador comum) não vê falhas gerais", async () => {
  const s = await cenario();
  await s.enviar(msg(CONVERSA_ALFA));
  for (const p of [[ACAO.VER], [ACAO.VER, ACAO.APROVAR, ACAO.APLICAR, ACAO.REGISTRAR]]) {
    await assert.rejects(CONSULTAS_MOVA["/mova/falhas-gerais"]({ ctx: ver(ALFA, p), mova: s.mova }), { codigoHttp: 403 });
  }
});

t("H1-3 unidade limitada não recebe falhas (gerais nem da fila) de conversas de outra unidade; nem reprocessa", async () => {
  const s = await cenario();
  await s.enviar(msg(CONVERSA_GAMA));
  const alfa = ver(ALFA, [ACAO.VER, ACAO.CONFIGURAR, ACAO.APROVAR]);
  assert.equal((await CONSULTAS_MOVA["/mova/falhas-gerais"]({ ctx: alfa, mova: s.mova })).total, 0);
  assert.equal((await CONSULTAS_MOVA["/mova/falhas-gerais"]({ ctx: ver(GAMA, [ACAO.CONFIGURAR]), mova: s.mova })).total, 1);
  // falha de FILA em GAMA: invisível e não reprocessável por ALFA
  await s.pool.query("update mova.fila set estado = 'FALHOU', ultimo_erro = 'IA_INDISPONIVEL'");
  assert.deepEqual((await CONSULTAS_MOVA["/mova/erros"]({ ctx: alfa, mova: s.mova })).itens, []);
  assert.equal((await CONSULTAS_MOVA["/mova/erros"]({ ctx: ver(GAMA, [ACAO.VER]), mova: s.mova })).itens.length, 1);
  const ev = (await s.pool.query("select evento_id from mova.fila")).rows[0].evento_id;
  await assert.rejects(executarAcaoMova(ACOES_MOVA["/mova/reprocessar"], { ctx: alfa, mova: s.mova, b: { eventoId: ev } }), { codigoHttp: 404 });
  assert.equal((await s.pool.query("select estado from mova.fila")).rows[0].estado, "FALHOU", "nada mudou");
});

t("H1-5 reprocessar falha geral: auditado, sem duplicar evento; repetir é recusado; nova leitura volta a decidir uma vez", async () => {
  let leituras = 0;
  const extrator = { async extrair() { leituras += 1; throw Object.assign(new Error("x"), { codigo: "IA_DESLIGADA" }); } };
  const s = await cenario({ extrator });
  await s.enviar(msg(CONVERSA_ALFA));
  const adm = ver(ALFA, [ACAO.VER, ACAO.CONFIGURAR]);
  const ev = (await CONSULTAS_MOVA["/mova/falhas-gerais"]({ ctx: adm, mova: s.mova })).itens[0].eventoId;
  await assert.rejects(executarAcaoMova(ACOES_MOVA["/mova/reprocessar"], { ctx: ver(ALFA, [ACAO.VER, ACAO.APROVAR]), mova: s.mova, b: { eventoId: ev } }), { codigoHttp: 404 }, "sem configurar");
  const [a, b] = await Promise.allSettled([1, 2].map(() => executarAcaoMova(ACOES_MOVA["/mova/reprocessar"], { ctx: adm, mova: s.mova, b: { eventoId: ev } })));
  assert.equal([a, b].filter((x) => x.status === "fulfilled").length, 1, "concorrente: só um libera");
  await s.mova.receptor.trabalhar();
  assert.equal(leituras, 2, "uma leitura nova, não duas");
  const n = (await s.pool.query("select count(*)::int n from mova.evento where evento_id = $1", [ev])).rows[0].n;
  assert.equal(n, 1, "evento não duplicado");
  assert.deepEqual((await s.pool.query("select decisao from mova.decisao where evento_id = $1 order by seq", [ev])).rows.map((x) => x.decisao), ["FALHA_LEITURA", "REPROCESSAR", "FALHA_LEITURA"]);
  assert.equal((await s.pool.query("select count(*)::int n from mova.auditoria where acao = 'FALHA_GERAL_REPROCESSADA'")).rows[0].n, 1);
  // reentrega do mesmo evento pelo Gateway depois disso continua DUPLICADO
  assert.equal((await s.mova.receptor.receber(msg(CONVERSA_ALFA, { eventoId: ev, mensagemId: ev.slice(4) }))).status, "DUPLICADO");
});

t("H1-6 logs do processamento não revelam o conteúdo da mensagem", async () => {
  const s = await cenario();
  await s.enviar(msg(CONVERSA_ALFA));
  await s.enviar(msg("120363000000000999@g.us"));
  assert.ok(s.logs.length > 0);
  for (const l of s.logs) assert.doesNotMatch(l, new RegExp(SEGREDO_TEXTO));
});

// ------------------------------------------------------------------------------------------------ isolamento: configuração de produção
const PROD_LIKE = { MOVA_HABILITADO: "1", MOVA_DATABASE_URL: "postgres://banco-de-producao", MOVA_SERVICO_USUARIO_ID: SERVICO, MOVA_RECEBIMENTO_HABILITADO: "1", MOVA_PROCESSAMENTO_HABILITADO: "1",
  MOVA_MODO: "HOMOLOGACAO", MOVA_AMBIENTE: "homologacao", MOVA_HOMOLOGACAO_MARCADOR: "marcador-teste-01", MOVA_GATEWAY_SECRET: "s".repeat(40), WHATSAPP_GATEWAY_SECRET: "p".repeat(40) };

t("ISO-1 banco sem a marca (como o de produção): o MOVA NÃO monta — nada é lido nem escrito", async () => {
  const { pool } = await criarBancoMova();
  const cfg = lerConfiguracaoMova(PROD_LIKE);
  let consultasAoFinanceiro = 0;
  const repositorio = new Proxy({}, { get: () => { consultasAoFinanceiro += 1; return () => { throw new Error("não deveria"); }; } });
  await assert.rejects(montarMova({ cfg, pool, repositorio, verificarBancoFinanceiro: async () => {} }), { codigo: "BANCO_NAO_E_DE_HOMOLOGACAO" });
  assert.equal(consultasAoFinanceiro, 0);
  assert.equal((await pool.query("select count(*)::int n from mova.controle")).rows[0].n, 1, "nada além do estado inicial");
});

t("ISO-2 Financeiro sem a marca (produção) com MOVA marcado: recusa antes de qualquer leitura financeira", async () => {
  const { pool } = await criarBancoMova();
  const banco = (await pool.query("select current_database() d")).rows[0].d;
  await pool.query(`comment on database ${banco} is 'MOVA_HOMOLOGACAO:marcador-teste-01'`);
  const cfg = lerConfiguracaoMova(PROD_LIKE);
  await assert.rejects(montarMova({ cfg, pool, repositorio: {}, verificarBancoFinanceiro: async () => { throw Object.assign(new Error("x"), { codigo: "BANCO_NAO_E_DE_HOMOLOGACAO" }); } }), { codigo: "BANCO_NAO_E_DE_HOMOLOGACAO" });
});

t("ISO-3 segredo do canal igual ao de produção: rota MOVA não existe (HTTP 404) e o worker não inicia", async () => {
  const env = { ...PROD_LIKE, MOVA_GATEWAY_SECRET: "p".repeat(40) };
  assert.equal(criarRouterMovaIsolado(env), null);
  assert.equal((await iniciarMovaEmbutido({ env })).motivo, "CONFIGURACAO_CONTRADITORIA");
  const app = express(); const r = criarRouterMovaIsolado(env); if (r) app.use("/internal/mova", r);
  const srv = http.createServer(app); await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    const corpo = JSON.stringify(msg(CONVERSA_ALFA)); const caminho = "/internal/mova/eventos/mova-grupo";
    const st = await fetch(`http://127.0.0.1:${srv.address().port}${caminho}`, { method: "POST", headers: { "content-type": "application/json", ...assinarRequisicao({ segredo: "p".repeat(40), metodo: "POST", caminho, corpo }) }, body: corpo }).then((x) => x.status);
    assert.equal(st, 404);
  } finally { await new Promise((ok) => srv.close(ok)); }
});

t("ISO-4 modo/ambiente de produção ou banco compartilhado sem homologação: bloqueia", () => {
  for (const x of [{ MOVA_AMBIENTE: "producao" }, { MOVA_MODO: "PRODUCAO" }, { MOVA_HOMOLOGACAO_MARCADOR: "" }]) assert.equal(lerConfiguracaoMova({ ...PROD_LIKE, ...x }).habilitado, false, JSON.stringify(x));
  assert.equal(lerConfiguracaoMova({ ...PROD_LIKE, MOVA_MODO: "", MOVA_AMBIENTE: "", MOVA_HOMOLOGACAO_MARCADOR: "", FV2_APP_DATABASE_URL: PROD_LIKE.MOVA_DATABASE_URL }).contradicoes.includes("BANCO_COMPARTILHADO_FORA_DA_HOMOLOGACAO"), true);
});

t("ISO-10 identidade de serviço só lê: aplicar/configurar/reprocessar com o contexto do serviço é recusado", async () => {
  const s = await cenario();
  const servico = ctx(ORG, ALFA, [ACAO.VER], SERVICO);
  await assert.rejects(executarAcaoMova(ACOES_MOVA["/mova/controle"], { ctx: servico, controle: criarControle({ pool: s.pool }), b: { suspenso: false } }), { codigoHttp: 403 });
  await assert.rejects(CONSULTAS_MOVA["/mova/falhas-gerais"]({ ctx: servico, mova: s.mova }), { codigoHttp: 403 });
  await assert.rejects(executarAcaoMova(ACOES_MOVA["/mova/aplicar"], { ctx: servico, mova: s.mova, nucleo: s.m.nucleo, b: { propostaId: "dddddddd-0000-4000-8000-00000000ffff" } }));
});

// ------------------------------------------------------------------------------------------------ privilégio mínimo real
t("PRIV — fluxo completo como mova_app (papel da aplicação, não dono): orçamento reserva/conclui, recebe, processa e consulta", async () => {
  const { pool, banco } = await criarBancoMova();
  await instalarConfiguracao(pool, validarConfiguracao(CONFIG)); // administrativo: dono
  const { ambiente } = await import("../financeiro-v2/helpers/postgres.js");
  const { urlDoBanco } = await import("../../scripts/fv2/ambiente.mjs");
  const pg = (await import("pg")).default;
  const comoApp = new pg.Pool({ connectionString: urlDoBanco(ambiente().urlAdmin, banco), max: 3 });
  comoApp.on("connect", (c) => { c.query("set role mova_app"); });
  try {
    assert.equal((await comoApp.query("select current_user u")).rows[0].u, "mova_app");
    const { criarOrcamentoIa, clienteComOrcamento, criarExtratorAnthropic } = await import("../../src/modules/mova-financeiro/index.js");
    const orcamento = criarOrcamentoIa({ pool: comoApp });
    const id = await orcamento.reservar();
    await orcamento.concluir(id, { modelo: "claude-opus-5-5", entrada: 100, saida: 10 });
    const leitura = { legivel: true, tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", unidadeSugerida: null, documentoDestinatario: null, valorCentavos: 1200, dataPagamento: "2026-10-12", dataEmissao: null, vencimento: null, competencia: null, favorecido: "Mercado Teste", identificadorDocumento: null, categoriaSugerida: null, natureza: "DESPESA", consulta: null, confianca: "ALTA" };
    const cliente = { beta: { messages: { create: async () => ({ model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: JSON.stringify(leitura) }] }) } } };
    const m = montar({ escopos: [ALFA, GAMA].map((unidadeId) => ({ organizacaoId: ORG, unidadeId })) });
    const controle = criarControle({ pool: comoApp, cacheMs: 0 });
    const ref = {};
    ref.mova = criarMova({ configuracao: CONFIG, nucleo: m.nucleo, concessoes: criarConcessoesMemoria([]), financeiro: FINANCEIRO, pool: comoApp, relogio: () => AGORA, controle,
      extrator: criarExtratorAnthropic({ cliente: clienteComOrcamento(cliente, { orcamento, controle }), obterEvidencia: (r) => ref.mova.evidencias.obter(r), relogio: () => AGORA }) });
    assert.equal((await ref.mova.receptor.receber(msg(CONVERSA_ALFA, { texto: "paguei 12 reais, alfa" }))).status, "ENFILEIRADO");
    await ref.mova.receptor.trabalhar();
    const r = await orcamento.resumo();
    assert.equal(r.chamadas, 2, "reserva + chamada real (simulada) contadas");
    const dec = (await pool.query("select decisao, motivo from mova.decisao order by seq desc limit 1")).rows[0];
    assert.notEqual(dec.motivo, "EXTRATOR_FALHOU:ORCAMENTO_INDISPONIVEL", JSON.stringify(dec));
    assert.equal((await ref.mova.consultas.caixaDeEntrada({ organizacaoId: ORG, unidadeId: ALFA })).itens.length, 1);
    await CONSULTAS_MOVA["/mova/falhas-gerais"]({ ctx: ver(ALFA, [ACAO.CONFIGURAR]), mova: ref.mova });
    await CONSULTAS_MOVA["/mova/estado"]({ ctx: ver(ALFA, [ACAO.VER]), mova: ref.mova, controle, orcamento });
    await assert.rejects(comoApp.query("update mova.orcamento_ia set limite_chamadas = 999"), { code: "42501" }, "aplicação não altera o próprio limite");
  } finally { await comoApp.end(); }
});

t("AUTO — leituras do worker passam pelo contexto de automação (sessão da identidade de serviço), nunca direto", async () => {
  const { pool, banco } = await criarBancoMova();
  await pool.query(`comment on database ${banco} is 'MOVA_HOMOLOGACAO:marcador-teste-01'`);
  await instalarConfiguracao(pool, validarConfiguracao(CONFIG));
  const m = montar({ escopos: [ALFA, GAMA].map((unidadeId) => ({ organizacaoId: ORG, unidadeId })) });
  const dentro = [];
  let ativo = false;
  const comAutomacao = async (fn) => { ativo = true; try { return await fn(); } finally { ativo = false; } };
  const repositorio = Object.freeze(Object.fromEntries(Object.entries(m.repositorio).map(([k, v]) => [k, typeof v === "function" ? (...a) => { dentro.push(ativo); return v.apply(m.repositorio, a); } : v])));
  const cfg = lerConfiguracaoMova({ ...PROD_LIKE, MOVA_GATEWAY_SECRET: "s".repeat(40) });
  const r = await montarMova({ cfg, pool, repositorio, comAutomacao, verificarBancoFinanceiro: async () => {} });
  await r.mova.porta.contasAPagarAbertas({ organizacaoId: ORG, unidadeId: ALFA, usuarioId: SERVICO }).catch(() => {});
  assert.ok(dentro.length > 0, "o repositório foi usado");
  assert.ok(dentro.every(Boolean), "toda leitura dentro do contexto de automação");
});
