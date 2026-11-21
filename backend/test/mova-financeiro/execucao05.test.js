// MOVA — Execução 05: preparação de deploy seguro. Controles em tempo real, orçamento persistente da IA, banco de produção
// recusado, configuração contraditória, canal HMAC isolado, expiração/repetição, integridade das evidências e reversão.
// Tudo no PostgreSQL LOCAL de teste; nada toca produção. Dados sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync, readdirSync } from "node:fs";
import { ACAO, ErroFinanceiro, comandos, criarConcessoesMemoria, planoDeContas } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ctx, montar } from "../financeiro-v2/helpers/cenario.js";
import {
  clienteComOrcamento, criarControle, criarEnviadorDeRespostas, criarExtratorAnthropic, criarMova, criarOrcamentoIa, instalarConfiguracao, validarConfiguracao,
} from "../../src/modules/mova-financeiro/index.js";
import { CONSULTAS_MOVA, ACOES_MOVA, executarAcaoMova } from "../../src/modules/fv2-integracao/movaRotas.js";
import { criarRouterMovaIsolado, exigirBancoDeHomologacao, iniciarMovaEmbutido, lerConfiguracaoMova, montarMova } from "../../src/modules/fv2-integracao/mova.js";
import { assinarRequisicao } from "../../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";
import { criarBancoMova, motivoParaPularMova, poolInterrompivel } from "./helpers/banco.js";

const PULAR = motivoParaPularMova();
const t = (nome, fn) => test(nome, { skip: PULAR }, fn);
const ORG = "dddddddd-0000-4000-8000-000000000001";
const ALFA = "dddddddd-0000-4000-8000-0000000000a1";
const GAMA = "dddddddd-0000-4000-8000-0000000000c1";
const SERVICO = "eeeeeeee-0000-4000-8000-0000000000aa";
const CONTATO = "5500000000777@s.whatsapp.net";
const SEG_MOVA = "m".repeat(40);
const SEG_PRINCIPAL = "p".repeat(40);
const CONFIG = {
  modo: "HOMOLOGACAO", identidadeServico: { usuarioId: SERVICO },
  unidades: [
    { organizacaoId: ORG, unidadeId: ALFA, nome: "Unidade Teste Alfa", apelidos: ["alfa"], fontes: { situacao: "CONFIRMADA", sistemaDeLoja: "SWF", plataformas: ["IFOOD"] } },
    { organizacaoId: ORG, unidadeId: GAMA, nome: "Unidade Teste Gama", apelidos: ["gama"], fontes: { situacao: "CONFIRMADA", sistemaDeLoja: "SAIPOS", plataformas: ["IFOOD"] } },
  ],
  gruposAutorizados: [{ grupoId: CONTATO, unidades: [ALFA, GAMA] }],
};
const FINANCEIRO = { ACAO, ErroFinanceiro, validarObrigacao: comandos.validarObrigacao, categoriaProvisoria: planoDeContas.CATEGORIA_DESPESA_A_CLASSIFICAR };
const ENV = { MOVA_HABILITADO: "1", MOVA_DATABASE_URL: "postgres://homolog", MOVA_SERVICO_USUARIO_ID: SERVICO };
const leitura = (x) => ({ legivel: true, tipoDocumento: "COMPROVANTE_PAGAMENTO", intencao: "INFORMAR_PAGAMENTO", unidadeSugerida: null, documentoDestinatario: null, valorCentavos: 1200, dataPagamento: "2026-10-12", dataEmissao: null, vencimento: null, competencia: null, favorecido: "Mercado Teste", identificadorDocumento: null, categoriaSugerida: null, natureza: "DESPESA", consulta: null, confianca: "ALTA", ...x });
let seq = 0;
const msg = (x = {}) => ({ contratoMova: 1, eventoId: `bly:E5${++seq}`, mensagemId: `E5${seq}`, grupoId: CONTATO, participanteId: CONTATO, telefoneE164: "+5500000000777", nomeExibicao: null, fromMe: false, tipo: "TEXTO", texto: "paguei, alfa", respostaA: null, midia: null, recebidoEm: AGORA.toISOString(), origemTipo: "LIVE", ...x });

async function cenario({ pool: poolDado, limiteChamadas } = {}) {
  const m = montar({ escopos: [ALFA, GAMA].map((unidadeId) => ({ organizacaoId: ORG, unidadeId })) });
  const pool = poolDado ?? (await criarBancoMova()).pool;
  await instalarConfiguracao(pool, validarConfiguracao(CONFIG));
  if (limiteChamadas !== undefined) await pool.query("update mova.orcamento_ia set limite_chamadas = $1", [limiteChamadas]);
  const chamadasIa = [];
  const real = { beta: { messages: { async create(req) { chamadasIa.push(req); return { model: "claude-haiku-5-5", stop_reason: "end_turn", usage: { input_tokens: 4000, output_tokens: 500 }, content: [{ type: "text", text: JSON.stringify(leitura({})) }] }; } } } };
  const controle = criarControle({ pool, cacheMs: 0 });
  const orcamento = criarOrcamentoIa({ pool });
  const ref = {};
  ref.mova = criarMova({ configuracao: CONFIG, nucleo: m.nucleo, concessoes: criarConcessoesMemoria([]), financeiro: FINANCEIRO, pool, relogio: () => AGORA, controle,
    extrator: criarExtratorAnthropic({ cliente: clienteComOrcamento(real, { orcamento, controle }), obterEvidencia: (r) => ref.mova.evidencias.obter(r), relogio: () => AGORA }) });
  const enviar = async (p) => { const r = await ref.mova.receptor.receber(p); await ref.mova.receptor.trabalhar(); return r; };
  return { m, pool, mova: ref.mova, controle, orcamento, chamadasIa, enviar };
}

// ------------------------------------------------------------------------------------------------ configuração
test("01/14/15 MOVA desligado por padrão; credenciais ausentes e configurações contraditórias BLOQUEIAM", () => {
  assert.deepEqual(lerConfiguracaoMova({}), { habilitado: false, motivo: "DESLIGADO" });
  assert.equal(criarRouterMovaIsolado({}), null);
  assert.deepEqual(lerConfiguracaoMova({ MOVA_HABILITADO: "1" }).motivo, "CONFIGURACAO_INCOMPLETA");
  assert.equal(lerConfiguracaoMova({ ...ENV, MOVA_SUSPENSO: "1", MOVA_RECEBIMENTO_HABILITADO: "1" }).motivo, "SUSPENSO");
  const c = (x) => lerConfiguracaoMova({ ...ENV, ...x }).contradicoes ?? [];
  assert.deepEqual(c({ MOVA_PROCESSAMENTO_HABILITADO: "1" }), ["PROCESSAMENTO_SEM_RECEBIMENTO"]);
  assert.ok(c({ MOVA_IA_HABILITADA: "1" }).includes("IA_SEM_PROCESSAMENTO"));
  assert.ok(c({ MOVA_ENVIO_HABILITADO: "1" }).includes("ENVIO_SEM_GATEWAY"));
  assert.deepEqual(c({ MOVA_RECEBIMENTO_HABILITADO: "1" }), ["CANAL_SEM_SEGREDO"]);
  assert.ok(c({ MOVA_RECEBIMENTO_HABILITADO: "1", MOVA_GATEWAY_SECRET: SEG_PRINCIPAL, WHATSAPP_GATEWAY_SECRET: SEG_PRINCIPAL }).includes("SEGREDO_IGUAL_AO_PRINCIPAL"));
  assert.deepEqual(c({ MOVA_MODO: "HOMOLOGACAO", MOVA_AMBIENTE: "homologacao" }), ["HOMOLOGACAO_INCOMPLETA"]);
  assert.deepEqual(c({ MOVA_MODO: "HOMOLOGACAO", MOVA_AMBIENTE: "homologacao", MOVA_HOMOLOGACAO_MARCADOR: "curto" }), ["MARCADOR_INVALIDO"]);
  assert.deepEqual(c({ MOVA_MODO: "PRODUCAO" }), ["MODO_DESCONHECIDO"]);
  assert.ok(c({ FV2_APP_DATABASE_URL: "postgres://homolog" }).includes("BANCO_COMPARTILHADO_FORA_DA_HOMOLOGACAO"));
  const ok = lerConfiguracaoMova({ ...ENV, MOVA_MODO: "HOMOLOGACAO", MOVA_AMBIENTE: "homologacao", MOVA_HOMOLOGACAO_MARCADOR: "marcador-teste-01", MOVA_RECEBIMENTO_HABILITADO: "1", MOVA_PROCESSAMENTO_HABILITADO: "1", MOVA_IA_HABILITADA: "1", MOVA_ENVIO_HABILITADO: "1", MOVA_GATEWAY_URL: "https://gw", MOVA_GATEWAY_SECRET: SEG_MOVA });
  assert.deepEqual([ok.habilitado, ok.modo, ok.recebimento, ok.processamento, ok.ia, ok.envio], [true, "HOMOLOGACAO", true, true, true, true]);
});

test("01 worker não inicia com o MOVA desligado ou sem processamento", async () => {
  assert.deepEqual(await iniciarMovaEmbutido({ env: {} }), { habilitado: false, motivo: "DESLIGADO" });
  assert.deepEqual(await iniciarMovaEmbutido({ env: { ...ENV } }), { habilitado: false, motivo: "PROCESSAMENTO_DESLIGADO" });
});

// ------------------------------------------------------------------------------------------------ banco de produção
t("17 tentativa de usar banco que não é o de homologação: recusada (o MOVA não monta)", async () => {
  const { pool } = await criarBancoMova();
  const cfg = { ...lerConfiguracaoMova({ ...ENV, MOVA_MODO: "HOMOLOGACAO", MOVA_AMBIENTE: "homologacao", MOVA_HOMOLOGACAO_MARCADOR: "marcador-teste-01" }) };
  await assert.rejects(exigirBancoDeHomologacao(pool, cfg.marcador), { codigo: "BANCO_NAO_E_DE_HOMOLOGACAO" });
  await assert.rejects(montarMova({ cfg, pool, repositorio: {}, verificarBancoFinanceiro: async () => {} }), { codigo: "BANCO_NAO_E_DE_HOMOLOGACAO" });
  const banco = (await pool.query("select current_database() as d")).rows[0].d;
  await pool.query(`comment on database ${banco} is 'MOVA_HOMOLOGACAO:marcador-teste-01'`);
  await exigirBancoDeHomologacao(pool, cfg.marcador);
  await assert.rejects(montarMova({ cfg, pool, repositorio: {}, verificarBancoFinanceiro: async () => { throw Object.assign(new Error("x"), { codigo: "BANCO_NAO_E_DE_HOMOLOGACAO" }); } }), { codigo: "BANCO_NAO_E_DE_HOMOLOGACAO" }, "Financeiro de produção também recusado");
  await assert.rejects(montarMova({ cfg, pool, repositorio: {} }), { codigo: "BANCO_FINANCEIRO_NAO_VERIFICADO" });
});

// ------------------------------------------------------------------------------------------------ orçamento
t("19 orçamento da IA: persistente; ao esgotar, nenhuma chamada nova (e conta reservas se o processo cair)", async () => {
  const s = await cenario({ limiteChamadas: 2 });
  await s.enviar(msg({ texto: "paguei 12 reais de gás, alfa" }));
  await s.enviar(msg({ texto: "paguei 13 reais de gás, alfa" }));
  await s.enviar(msg({ texto: "paguei 14 reais de gás, alfa" }));
  assert.equal(s.chamadasIa.length, 2, "a terceira não chega ao provedor");
  assert.match((await s.mova.armazenamento.historico.todos()).at(-1).motivo, /ORCAMENTO_ESGOTADO/);
  const r = await s.orcamento.resumo();
  assert.deepEqual([r.chamadas, r.tokensEntrada, r.tokensSaida], [2, 8000, 1000]);
  assert.equal(r.custoUsd, 0.0013); // Haiku 5.5: 2 × (4000×0,10 + 500×0,50) µUS$
  // limite de custo: reserva de US$ 0,10 não cabe em US$ 0,10 já com US$ 0,0013 gastos
  await s.pool.query("update mova.orcamento_ia set limite_chamadas = 100, limite_custo_microusd = 100000");
  await s.enviar(msg({ texto: "paguei 15 reais, alfa" }));
  assert.equal(s.chamadasIa.length, 2);
});

t("11 banco indisponível ao reservar: a IA NÃO é chamada (conservador)", async () => {
  const { pool } = await criarBancoMova();
  const q = poolInterrompivel(pool);
  const orc = criarOrcamentoIa({ pool: q.pool });
  let chamou = 0;
  const cli = clienteComOrcamento({ beta: { messages: { create: async () => { chamou += 1; return {}; } } } }, { orcamento: orc });
  await instalarConfiguracao(pool, validarConfiguracao(CONFIG));
  q.estado.fora = true;
  await assert.rejects(cli.beta.messages.create({}), { codigo: "ORCAMENTO_INDISPONIVEL" });
  assert.equal(chamou, 0);
});

// ------------------------------------------------------------------------------------------------ reversão funcional
t("20 reversão funcional em tempo real: cada interruptor e a suspensão geral desligam a etapa sem reiniciar nada", async () => {
  const s = await cenario();
  await s.controle.alterar({ recebimento: false }, { autor: "teste", motivo: "piloto" });
  assert.deepEqual(await s.mova.receptor.receber(msg()), { status: "IGNORADO", motivo: "RECEBIMENTO_DESLIGADO" });
  await s.controle.alterar({ recebimento: true, processamento: false }, { autor: "teste" });
  assert.equal((await s.mova.receptor.receber(msg())).status, "ENFILEIRADO");
  assert.equal(await s.mova.receptor.trabalhar(), 0);
  assert.equal((await s.mova.fila.listar()).length, 1, "evento fica intacto na fila");
  await s.controle.alterar({ processamento: true, ia: false }, { autor: "teste" });
  await s.mova.receptor.trabalhar();
  assert.equal(s.chamadasIa.length, 0, "IA desligada: nenhuma chamada");
  assert.match((await s.mova.armazenamento.historico.todos()).at(-1).motivo, /IA_DESLIGADA_NO_CONTROLE/);
  await s.controle.alterar({ ia: true }, { autor: "teste" });
  const enviados = [];
  const enviador = criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, controle: s.controle, habilitado: true, enviar: async (r) => { enviados.push(r); return { providerMessageId: "PROV0001" }; } });
  await s.controle.alterar({ envio: false }, { autor: "teste" });
  assert.deepEqual(await enviador.enviarPendentes(), { enviadas: 0, desligado: true });
  await s.controle.alterar({ envio: true, suspenso: true }, { autor: "teste", motivo: "parar tudo" });
  assert.deepEqual(await enviador.enviarPendentes(), { enviadas: 0, desligado: true });
  assert.equal((await s.mova.receptor.receber(msg())).motivo, "RECEBIMENTO_DESLIGADO");
  assert.equal(enviados.length, 0);
  assert.ok((await s.pool.query("select count(*)::int n from mova.auditoria where acao = 'CONTROLE_ALTERADO'")).rows[0].n >= 5);
});

t("20 rota de controle exige financeiro_v2.configurar", async () => {
  const s = await cenario();
  await assert.rejects(executarAcaoMova(ACOES_MOVA["/mova/controle"], { ctx: ctx(ORG, ALFA, [ACAO.VER, ACAO.APROVAR]), controle: s.controle, b: { suspenso: true } }), { codigoHttp: 403 });
  const r = await executarAcaoMova(ACOES_MOVA["/mova/controle"], { ctx: ctx(ORG, ALFA, [ACAO.CONFIGURAR]), controle: s.controle, b: { suspenso: true, motivo: "teste" } });
  assert.equal(r.suspenso, true);
});

// ------------------------------------------------------------------------------------------------ canal HMAC isolado
t("25/26 canal isolado: sem assinatura 401, assinatura com o segredo PRINCIPAL 401, com o do MOVA 202; repetição e expiração 401", async () => {
  const s = await cenario();
  const env = { ...ENV, MOVA_RECEBIMENTO_HABILITADO: "1", MOVA_GATEWAY_SECRET: SEG_MOVA, WHATSAPP_GATEWAY_SECRET: SEG_PRINCIPAL };
  const router = criarRouterMovaIsolado(env, { obterMova: async () => ({ mova: s.mova }) });
  const app = express(); app.use("/internal/mova", router);
  const srv = http.createServer(app); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const caminho = "/internal/mova/eventos/mova-grupo";
  const post = (corpo, headers) => fetch(url + caminho, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: corpo }).then((r) => r.status);
  try {
    const corpo = JSON.stringify(msg());
    assert.equal(await post(corpo, {}), 401);
    assert.equal(await post(corpo, assinarRequisicao({ segredo: SEG_PRINCIPAL, metodo: "POST", caminho, corpo })), 401);
    const h = assinarRequisicao({ segredo: SEG_MOVA, metodo: "POST", caminho, corpo });
    assert.equal(await post(corpo, h), 202);
    assert.equal(await post(corpo, h), 401, "mesmo nonce = repetição recusada");
    const velho = { ...assinarRequisicao({ segredo: SEG_MOVA, metodo: "POST", caminho, corpo }), "X-Gateway-Timestamp": String(Date.now() - 10 * 60_000) };
    assert.equal(await post(corpo, velho), 401, "fora da janela de tempo");
    const outro = JSON.stringify(msg({ grupoId: "120363000000000009@g.us", participanteId: "100000000000001@lid", telefoneE164: null }));
    assert.equal(await post(outro, assinarRequisicao({ segredo: SEG_MOVA, metodo: "POST", caminho, corpo: outro })), 200, "grupo não autorizado: aceito e descartado");
  } finally { await new Promise((r) => srv.close(r)); }
});

// ------------------------------------------------------------------------------------------------ evidências
t("27 evidências: só a unidade dona abre, exige permissão de documentos e conteúdo adulterado é recusado", async () => {
  const s = await cenario();
  const doc = Buffer.from("%PDF-ficticio-e05");
  await s.enviar(msg({ tipo: "DOCUMENTO", texto: "pago, alfa", midia: { mime: "application/pdf", nomeArquivo: null, tamanhoBytes: doc.length, base64: doc.toString("base64") } }));
  const sha = (await s.pool.query("select sha256 from mova.evidencia")).rows[0].sha256;
  const ver = (u, p) => CONSULTAS_MOVA["/mova/arquivo"]({ ctx: ctx(ORG, u, p), mova: s.mova, params: { sha } });
  await assert.rejects(ver(ALFA, [ACAO.VER]), { codigoHttp: 403 });
  await assert.rejects(ver(GAMA, [ACAO.VER, ACAO.DOCUMENTOS]), { codigoHttp: 404 });
  assert.equal(Buffer.from((await ver(ALFA, [ACAO.VER, ACAO.DOCUMENTOS])).base64, "base64").toString(), "%PDF-ficticio-e05");
  await s.pool.query("update mova.evidencia set conteudo = $1", [Buffer.from("adulterado")]);
  await assert.rejects(ver(ALFA, [ACAO.VER, ACAO.DOCUMENTOS]), { codigoHttp: 409, codigo: "EVIDENCIA_ADULTERADA" });
});

// ------------------------------------------------------------------------------------------------ reversão de código
test("21 reversão de código: migrações só ADITIVAS no schema próprio (nada de produção alterado/apagado); app.js volta ao normal sem env", () => {
  const pasta = new URL("../../../database/mova-financeiro/migracoes/", import.meta.url);
  for (const f of readdirSync(pasta)) {
    const sql = readFileSync(new URL(f, pasta), "utf8").replace(/--.*$/gm, "");
    // DELETE/TRUNCATE só em tabelas do schema mova (ex.: expurgo de evidências); DROP só de restrição/coluna-nula/função/gatilho próprios.
    for (const m of sql.matchAll(/(deletes+from|truncate(?:s+table)?)s+([a-z_."]+)/gi)) assert.match(m[2].toLowerCase(), /^mova./, `${f}: ${m[0]}`);
    for (const m of sql.matchAll(/drops+(w+)/gi)) assert.match(m[1].toLowerCase(), /^(constraint|not|function|trigger|policy|index)$/, `${f}: ${m[0]}`);
    assert.doesNotMatch(sql, /\b(public|financeiro_v2|auth)\.\w+/i, `${f} não toca outros schemas`);
    assert.doesNotMatch(sql, /\bdrop\s+(table|schema)\b/i, `${f} sem DROP destrutivo`);
  }
  const app = readFileSync(new URL("../../src/app.js", import.meta.url), "utf8");
  assert.match(app, /const movaIsolado = criarRouterMovaIsolado\(process\.env\);\n\s+if \(movaIsolado\) app\.use/);
});
