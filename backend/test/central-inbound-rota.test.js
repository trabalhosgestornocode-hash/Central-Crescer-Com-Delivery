// Central de Comunicação — a ROTA `POST /eventos/mensagem-recebida` com o inbox ligado: HMAC → contrato → resolução do autorizado → conversa.
// Garante: conteúdo NUNCA vai ao razão técnico (090) nem ao provider/automação; telefone de desconhecido NUNCA é gravado no razão; falha do inbox não
// derruba o razão técnico. Repo em memória + fake DB; sem rede/banco reais.
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { exigirHmac, assinarRequisicao } from "../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";
import { criarWhatsappGatewayRouter } from "../src/modules/comunicacao/gateway/whatsappGateway.routes.js";
import { criarRepoEmMemoria } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";
import { processarInbound, _zerarMetricas } from "../src/modules/comunicacao/comunicacao.inbox.service.js";
import { criarFakeDb, linhaRoster } from "./helpers/central-fake-db.js";

const SEGREDO = "s".repeat(32);
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const CAMINHO = "/internal/comunicacao/eventos/mensagem-recebida";
const evento = (o = {}) => ({
  contratoInbound: 1, providerMessageId: "MSG-" + Math.random().toString(36).slice(2, 10), origemTipo: "LIVE", origemJidTipo: "direct_pn", fromMe: false,
  telefoneE164: "+5511999990001", telefoneOrigem: "JID_PN", falhaDecrypt: false, motivoFalhaDecrypt: null, stubSistema: false,
  recebidoEm: new Date().toISOString(), tipoConteudo: "texto", texto: "Olá, equipe", ...o,
});

describe("POST /eventos/mensagem-recebida — Central", () => {
  let servidor; let baseUrl; let repo; let db; let recebidosPeloProvider; let inboxQuebrado; let roteador = (_q, _r, n) => n();
  const provider = { _receberEventoMensagem: (e) => recebidosPeloProvider.push(e) };
  const inbox = { processarInbound: (p) => (inboxQuebrado ? Promise.reject(new Error("relation does not exist")) : processarInbound(p, { supabase: db, env: {} })) };

  before(async () => {
    const app = express();
    app.use("/internal/comunicacao", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), (req, res, next) => roteador(req, res, next));
    servidor = createServer(app);
    await new Promise((r) => servidor.listen(0, r));
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(() => servidor.close());
  beforeEach(() => {
    _zerarMetricas(); repo = criarRepoEmMemoria(); recebidosPeloProvider = []; inboxQuebrado = false;
    db = criarFakeDb({ comunicacao_roster_autorizado: [linhaRoster({ unidade_id: "u1", unidade_nome: "Centro" })] });
    roteador = criarWhatsappGatewayRouter({ repo, organizacaoId: ORG_ID, provider, inbox });
  });

  const enviar = (corpo) => {
    const texto = JSON.stringify(corpo);
    const headers = assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: CAMINHO, corpo: texto }); headers["Content-Type"] = "application/json";
    return fetch(`${baseUrl}${CAMINHO}`, { method: "POST", headers, body: texto });
  };
  const inboxDoDb = () => db.tabelas.comunicacao_inbox_mensagens ?? [];

  test("responsável autorizado: 200, entra na conversa E no razão técnico (com telefone, SEM conteúdo)", async () => {
    const r = await enviar(evento());
    assert.equal(r.status, 200);
    assert.equal(inboxDoDb().length, 1);
    assert.equal(inboxDoDb()[0].texto, "Olá, equipe");
    const razao = repo._inbound(ORG_ID);
    assert.equal(razao.length, 1);
    assert.equal(razao[0].telefoneE164, "+5511999990001");
    assert.ok(!JSON.stringify(razao).includes("Olá, equipe"), "o razão técnico nunca guarda o conteúdo");
    assert.ok(!("texto" in razao[0]) && !("tipoConteudo" in razao[0]));
  });

  test("o provider/automação recebe o evento SEM texto nem tipoConteudo", async () => {
    await enviar(evento());
    assert.equal(recebidosPeloProvider.length, 1);
    assert.ok(!("texto" in recebidosPeloProvider[0]) && !("tipoConteudo" in recebidosPeloProvider[0]));
    assert.ok(!JSON.stringify(recebidosPeloProvider).includes("Olá, equipe"));
  });

  test("DESCONHECIDO: 200, nenhuma conversa, e o razão técnico NÃO guarda o telefone dele", async () => {
    const r = await enviar(evento({ telefoneE164: "+5511888880000", texto: "quem é você" }));
    assert.equal(r.status, 200);
    assert.equal(inboxDoDb().length, 0);
    const razao = repo._inbound(ORG_ID);
    assert.equal(razao.length, 1, "o evento técnico continua registrado (métrica/idempotência)");
    assert.deepEqual([razao[0].telefoneE164, razao[0].telefoneOrigem], [null, null]);
    const tudo = JSON.stringify({ razao, db: db.tabelas });
    assert.ok(!tudo.includes("quem é você") && !tudo.includes("888880000"));
  });

  test("grupo / status / broadcast: 200, ignorados, nada na conversa", async () => {
    for (const t of ["group", "status", "broadcast", "newsletter"]) {
      const r = await enviar(evento({ origemJidTipo: t, telefoneE164: null, telefoneOrigem: null, tipoConteudo: "outro", texto: null }));
      assert.equal(r.status, 200, t);
    }
    assert.equal(inboxDoDb().length, 0);
  });

  test("duplicata (mesmo id): uma linha na conversa e uma no razão", async () => {
    const e = evento({ providerMessageId: "DUP-1" });
    await enviar(e); await enviar(e);
    assert.equal(inboxDoDb().length, 1);
    assert.equal(repo._inbound(ORG_ID).length, 1);
  });

  test("Gateway ANTIGO (sem tipoConteudo/texto) continua aceito e nada entra na conversa", async () => {
    const e = evento(); delete e.tipoConteudo; delete e.texto;
    assert.equal((await enviar(e)).status, 200);
    assert.equal(inboxDoDb().length, 0);
    assert.equal(repo._inbound(ORG_ID).length, 1);
  });

  test("contrato estrito: texto em evento sem telefone, texto em fromMe, tipo inválido e chave desconhecida ⇒ 400 e nada é gravado", async () => {
    const ruins = [
      evento({ telefoneE164: null, telefoneOrigem: null }),
      evento({ fromMe: true, telefoneE164: null, telefoneOrigem: null }),
      evento({ tipoConteudo: "video" }),
      evento({ tipoConteudo: "midia", texto: "legenda" }),
      evento({ texto: "a\u0000b" }),
      evento({ texto: "x".repeat(4097) }),
      { ...evento(), organizacao_id: "outra-org" },
    ];
    for (const e of ruins) assert.equal((await enviar(e)).status, 400, JSON.stringify(e).slice(0, 80));
    assert.equal(inboxDoDb().length, 0);
    assert.equal(repo._inbound(ORG_ID).length, 0);
  });

  test("falha do inbox (ex.: migration 096 ainda não aplicada) NÃO derruba o razão técnico e NÃO grava o telefone", async () => {
    inboxQuebrado = true;
    const linhas = [];
    const original = console.error; console.error = (l) => linhas.push(String(l));
    let r;
    try { r = await enviar(evento({ texto: "SEGREDO-NO-LOG" })); } finally { console.error = original; }
    assert.equal(r.status, 200);
    const razao = repo._inbound(ORG_ID);
    assert.equal(razao.length, 1);
    assert.deepEqual([razao[0].telefoneE164, razao[0].telefoneOrigem], [null, null], "fail-closed: sem decisão, não guarda o telefone");
    assert.ok(linhas.some((l) => l.includes("central.inbox_falhou")));
    assert.ok(!linhas.join("\n").includes("SEGREDO-NO-LOG") && !linhas.join("\n").includes("999990001"), "o log de falha nunca traz conteúdo nem telefone");
  });

  test("sem HMAC ⇒ 401", async () => {
    const r = await fetch(`${baseUrl}${CAMINHO}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(evento()) });
    assert.equal(r.status, 401);
    assert.equal(inboxDoDb().length, 0);
  });
});
