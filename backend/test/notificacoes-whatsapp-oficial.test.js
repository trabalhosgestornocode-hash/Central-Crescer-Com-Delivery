// WhatsApp Cloud API oficial (OTP) — homologação SINTÉTICA: Graph API falsa, nenhuma rede, nenhum envio real.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.NOTIFICACOES_SEGREDO_MESTRE = "segredo-de-teste-da-central-0123456789abcdef";
const ofi = await import("../src/modules/notificacoes/notificacoes.whatsappOficial.js");
const envio = await import("../src/modules/notificacoes/notificacoes.envio.js");
const seg = await import("../src/modules/notificacoes/notificacoes.segredos.js");

const CRED = { WHATSAPP_CLOUD_PHONE_NUMBER_ID: "1234567890", WHATSAPP_CLOUD_TOKEN: "token-ficticio", WHATSAPP_CLOUD_TEMPLATE_OTP: "codigo_verificacao" };
const OFICIAL = { ...CRED, NOTIFICACOES_OTP_TRANSPORTE: "oficial", NOTIFICACOES_OTP_OFICIAL_AUTORIZADO: "true", NODE_ENV: "production" };
const NUM = "+5511912345678";

const resp = (status, corpo = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo });

describe("modo oficial: desligado por padrão, duas chaves + credenciais", () => {
  test("sem a 2ª chave, sem credenciais ou com o tipo errado → desligado", () => {
    assert.equal(envio.modoTransporte({ ...OFICIAL, NOTIFICACOES_OTP_OFICIAL_AUTORIZADO: undefined }), "desligado");
    assert.equal(envio.modoTransporte({ ...OFICIAL, WHATSAPP_CLOUD_TOKEN: "" }), "desligado");
    assert.equal(envio.modoTransporte({ ...OFICIAL, WHATSAPP_CLOUD_API_VERSION: "latest" }), "desligado");
    assert.equal(envio.modoTransporte({ NOTIFICACOES_OTP_TRANSPORTE: "baileys", ...CRED }), "desligado");
    assert.equal(envio.modoTransporte({}), "desligado");
    assert.equal(envio.modoTransporte(OFICIAL), "oficial");
  });
  test("capacidades: oficial = envio real, nunca 'simulado'; simulação e desligado seguem como antes", () => {
    assert.deepEqual(envio.capacidades(OFICIAL), { modo: "oficial", otp: true, simulado: false, envioReal: true });
    assert.deepEqual(envio.capacidades({}), { modo: "desligado", otp: false, simulado: false, envioReal: false });
    assert.deepEqual(envio.capacidades({ NOTIFICACOES_OTP_TRANSPORTE: "simulacao", NOTIFICACOES_AMBIENTE_ISOLADO: "true", NODE_ENV: "test" }), { modo: "simulacao", otp: true, simulado: true, envioReal: false });
  });
  test("credenciais faltando só devolve NOMES", () => {
    assert.deepEqual(ofi.credenciaisFaltando({ WHATSAPP_CLOUD_TOKEN: "x" }), ["WHATSAPP_CLOUD_PHONE_NUMBER_ID", "WHATSAPP_CLOUD_TEMPLATE_OTP"]);
  });
});

describe("envio pelo modelo de autenticação", () => {
  beforeEach(() => ofi._limparIdempotencia());
  test("corpo do modelo: código no corpo e no botão, número sem '+', idioma padrão pt_BR", async () => {
    let chamada;
    const r = await ofi.enviarCodigoOficial({ desafioId: "d1", para: NUM, codigo: "123456" }, { env: OFICIAL, fetchImpl: async (u, o) => { chamada = { u, o, corpo: JSON.parse(o.body) }; return resp(200, { messages: [{ id: "wamid.X" }] }); } });
    assert.deepEqual([r.entregue, r.provedorId], [true, "wamid.X"]);
    assert.equal(chamada.u, "https://graph.facebook.com/v21.0/1234567890/messages");
    assert.equal(chamada.o.headers.Authorization, "Bearer token-ficticio");
    assert.equal(chamada.corpo.to, "5511912345678");
    assert.equal(chamada.corpo.template.name, "codigo_verificacao");
    assert.equal(chamada.corpo.template.language.code, "pt_BR");
    assert.equal(chamada.corpo.template.components[0].parameters[0].text, "123456");
    assert.equal(chamada.corpo.template.components[1].sub_type, "url");
  });
  test("mesmo desafio nunca envia duas vezes (idempotência); recusa definitiva libera novo pedido", async () => {
    let n = 0;
    const f = async () => { n++; return resp(200, { messages: [{ id: "w" }] }); };
    await ofi.enviarCodigoOficial({ desafioId: "d2", para: NUM, codigo: "111111" }, { env: OFICIAL, fetchImpl: f });
    const r2 = await ofi.enviarCodigoOficial({ desafioId: "d2", para: NUM, codigo: "111111" }, { env: OFICIAL, fetchImpl: f });
    assert.deepEqual([n, r2.motivo], [1, "JA_ENVIADO"]);
    const recusa = await ofi.enviarCodigoOficial({ desafioId: "d3", para: NUM, codigo: "222222" }, { env: OFICIAL, fetchImpl: async () => resp(400) });
    assert.equal(recusa.motivo, "RECUSADO_PELO_PROVEDOR");
    const de_novo = await ofi.enviarCodigoOficial({ desafioId: "d3", para: NUM, codigo: "222222" }, { env: OFICIAL, fetchImpl: async () => resp(200, { messages: [{ id: "w2" }] }) });
    assert.equal(de_novo.entregue, true);
  });
  test("erros do provedor viram códigos fixos, sem repetição automática; timeout/rede NÃO repete (não sabemos se saiu)", async () => {
    const casos = [[401, "CREDENCIAL_RECUSADA"], [403, "CREDENCIAL_RECUSADA"], [429, "LIMITE_DO_PROVEDOR"], [500, "PROVEDOR_INDISPONIVEL"], [131030, "PROVEDOR_INDISPONIVEL"]];
    for (const [status, motivo] of casos) {
      let n = 0;
      const r = await ofi.enviarCodigoOficial({ desafioId: `e${status}`, para: NUM, codigo: "333333" }, { env: OFICIAL, fetchImpl: async () => { n++; return resp(status > 600 ? 503 : status); } });
      assert.deepEqual([r.entregue, r.motivo, n], [false, motivo, 1], String(status));
    }
    let n = 0;
    const t = await ofi.enviarCodigoOficial({ desafioId: "rede", para: NUM, codigo: "444444" }, { env: OFICIAL, fetchImpl: async () => { n++; throw new Error("ECONNRESET"); } });
    assert.deepEqual([t.motivo, n], ["SEM_RESPOSTA", 1]);
    const t2 = await ofi.enviarCodigoOficial({ desafioId: "rede", para: NUM, codigo: "444444" }, { env: OFICIAL, fetchImpl: async () => { n++; return resp(200, { messages: [{ id: "x" }] }); } });
    assert.deepEqual([t2.motivo, n], ["JA_ENVIADO", 1]);
  });
  test("dados inválidos nunca chegam ao provedor; sem credenciais nada é chamado", async () => {
    let n = 0; const f = async () => { n++; return resp(200); };
    assert.equal((await ofi.enviarCodigoOficial({ desafioId: "x1", para: NUM, codigo: "12" }, { env: OFICIAL, fetchImpl: f })).motivo, "DADOS_INVALIDOS");
    assert.equal((await ofi.enviarCodigoOficial({ desafioId: "x2", para: "123", codigo: "123456" }, { env: OFICIAL, fetchImpl: f })).motivo, "DADOS_INVALIDOS");
    assert.equal((await ofi.enviarCodigoOficial({ desafioId: "x3", para: NUM, codigo: "123456" }, { env: {}, fetchImpl: f })).motivo, "CREDENCIAIS_INCOMPLETAS");
    assert.equal(n, 0);
  });
});

describe("entregarCodigoOtp no modo oficial: nem número nem código nos logs", () => {
  beforeEach(() => ofi._limparIdempotencia());
  test("entrega pelo adaptador e registra só o id do desafio", async () => {
    const logs = [];
    const orig = { log: console.log, warn: console.warn };
    console.log = (...a) => logs.push(a.join(" ")); console.warn = (...a) => logs.push(a.join(" "));
    const fetchOriginal = globalThis.fetch;
    let corpoEnviado;
    globalThis.fetch = async (u, o) => { corpoEnviado = JSON.parse(o.body); return resp(200, { messages: [{ id: "wamid.Z" }] }); };
    try {
      const r = await envio.entregarCodigoOtp({ desafioId: "des-1", telefoneCifrado: seg.cifrarTelefone(NUM), telefoneHmac: seg.hmacTelefone(NUM), codigo: "654321" }, { env: OFICIAL });
      assert.deepEqual([r.entregue, r.simulado], [true, false]);
      assert.equal(corpoEnviado.to, "5511912345678");
    } finally { console.log = orig.log; console.warn = orig.warn; globalThis.fetch = fetchOriginal; }
    const tudo = logs.join("\n");
    assert.ok(tudo.includes("des-1"));
    assert.ok(!tudo.includes("654321") && !tudo.includes("5511912345678") && !tudo.includes("token-ficticio"), "sem número, código ou token nos logs");
    assert.equal(envio._ultimoCodigoSimulado({ desafioId: "des-1" }), null, "nada vai para a caixa de simulação");
  });
  test("desligado: nada é chamado", async () => {
    const fetchOriginal = globalThis.fetch; let n = 0; globalThis.fetch = async () => { n++; return resp(200); };
    try {
      const r = await envio.entregarCodigoOtp({ desafioId: "des-2", telefoneCifrado: seg.cifrarTelefone(NUM), telefoneHmac: seg.hmacTelefone(NUM), codigo: "654321" }, { env: { ...OFICIAL, NOTIFICACOES_OTP_OFICIAL_AUTORIZADO: "false" } });
      assert.deepEqual([r.entregue, r.motivo, n], [false, "TRANSPORTE_DESLIGADO", 0]);
    } finally { globalThis.fetch = fetchOriginal; }
  });
});

describe("webhook: assinatura, handshake e idempotência", () => {
  const SEGREDO = "app-secret-ficticio";
  const corpo = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [
    { id: "wamid.A", status: "delivered", recipient_id: "5511912345678" }, { id: "wamid.A", status: "read" }, { id: "wamid.B", status: "failed", errors: [{ code: 131026 }] }, { status: "x" }] } }] }] });
  const assinar = (c, s = SEGREDO) => "sha256=" + crypto.createHmac("sha256", s).update(c).digest("hex");
  test("só aceita o corpo CRU com a assinatura correta (timing-safe); adulterar ou trocar o segredo recusa", () => {
    assert.equal(ofi.assinaturaValida(corpo, assinar(corpo), SEGREDO), true);
    assert.equal(ofi.assinaturaValida(corpo + " ", assinar(corpo), SEGREDO), false);
    assert.equal(ofi.assinaturaValida(corpo, assinar(corpo, "outro"), SEGREDO), false);
    for (const ruim of [undefined, "", "sha1=abc", "sha256=", "sha256=zz"]) assert.equal(ofi.assinaturaValida(corpo, ruim, SEGREDO), false, String(ruim));
    assert.equal(ofi.assinaturaValida(corpo, assinar(corpo), ""), false, "sem segredo configurado nada passa");
  });
  test("handshake só devolve o desafio com o token certo", () => {
    assert.equal(ofi.handshakeWebhook({ "hub.mode": "subscribe", "hub.verify_token": "tk", "hub.challenge": "999" }, "tk"), "999");
    assert.equal(ofi.handshakeWebhook({ "hub.mode": "subscribe", "hub.verify_token": "errado", "hub.challenge": "999" }, "tk"), null);
    assert.equal(ofi.handshakeWebhook({ "hub.mode": "subscribe", "hub.verify_token": "tk" }, ""), null);
  });
  test("extração de status: chave estável de idempotência, sem telefone, ignora itens incompletos", () => {
    const a = ofi.extrairStatus(JSON.parse(corpo));
    assert.deepEqual(a.map((x) => x.chave), ["wamid.A:delivered", "wamid.A:read", "wamid.B:failed"]);
    assert.equal(a[2].codigoErro, 131026);
    assert.ok(!JSON.stringify(a).includes("5511912345678"));
    assert.deepEqual(ofi.extrairStatus(JSON.parse(corpo)).map((x) => x.chave), a.map((x) => x.chave), "reentrega do mesmo payload gera as MESMAS chaves");
    assert.deepEqual(ofi.extrairStatus(null), []);
  });
});

describe("consentimento real exige termo aprovado", () => {
  test("termo rascunho (ou ausente) fora da simulação → 409 TERMO_NAO_APROVADO e nada é gravado", async () => {
    const tit = await import("../src/modules/notificacoes/notificacoes.titular.service.js");
    const token = "a".repeat(43);
    for (const termo of [{ versao: 1, rascunho: true }, null]) {
      let gravou = false;
      const convite = { id: "c1", organizacao_id: "o1", status: "VERIFICADO", expira_em: new Date(Date.now() + 3600e3).toISOString(), unidades_pretendidas: ["u1"] };
      const repo = { obterConvitePorToken: async () => convite, termoVigente: async () => termo, consentir: async () => { gravou = true; return {}; } };
      await assert.rejects(tit.consentirConvite({ token, desafio: "d", categorias: [], termoVersao: 1, ip: "1.1.1.1", deps: { env: OFICIAL, repo } }),
        (e) => e.statusCode === 409 && JSON.stringify(e).includes("TERMO_NAO_APROVADO"));
      assert.equal(gravou, false);
    }
  });
});
