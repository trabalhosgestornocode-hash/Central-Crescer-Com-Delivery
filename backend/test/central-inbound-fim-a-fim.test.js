// Central de Comunicação — INBOUND de ponta a ponta (incidente 2026-09-25: respostas de clientes nunca apareciam na Central).
// Prova o contrato de TODO o caminho a jusante do Gateway, só com dependências em memória:
//   POST /internal/comunicacao/eventos/mensagem-recebida (HMAC) → contrato → roster → inbox (fake da 096) → API da conversa (obterConversa/listarConversas).
// Sem rede real, sem banco. Complementa (não repete) central-inbound-rota / central-inbox / whatsapp-inbound-contrato / whatsapp-inbound-persistencia / central-conversas.
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { exigirHmac, assinarRequisicao } from "../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";
import { criarWhatsappGatewayRouter } from "../src/modules/comunicacao/gateway/whatsappGateway.routes.js";
import { criarRepoEmMemoria } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";
import { processarInbound, metricasInbox, _zerarMetricas } from "../src/modules/comunicacao/comunicacao.inbox.service.js";
import { obterConversa, listarConversas } from "../src/modules/administrativo/administrativo.comunicacao.conversas.js";
import { criarFakeDb, linhaRoster } from "./helpers/central-fake-db.js";

const SEGREDO = "s".repeat(32);
const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const CAMINHO = "/internal/comunicacao/eventos/mensagem-recebida";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const C_MARIA = uuid(201); const C_JOAO = uuid(202); const C_ANA = uuid(203); const C_ANA_SEM9 = uuid(204);
const TEL_MARIA = "+5511999990001"; const TEL_JOAO = "+5511999990002"; const TEL_ANA = "+5521988887777"; const TEL_ANA_SEM9 = "+552188887777";
const TEL_DESCONHECIDO = "+5511777776666";

const evento = (o = {}) => ({
  contratoInbound: 1, providerMessageId: "MSG-" + Math.random().toString(36).slice(2, 12), origemTipo: "LIVE", origemJidTipo: "direct_pn", fromMe: false,
  telefoneE164: TEL_MARIA, telefoneOrigem: "JID_PN", falhaDecrypt: false, motivoFalhaDecrypt: null, stubSistema: false,
  recebidoEm: new Date().toISOString(), tipoConteudo: "texto", texto: "Oi, já lancei o dashboard", ...o,
});
const minutosAtras = (n) => new Date(Date.now() - n * 60_000).toISOString();

const ROSTER = [
  linhaRoster({ contato_id: C_MARIA, telefone_e164: TEL_MARIA, perfil_id: "p1", perfil_nome: "Maria Souza", organizacao_id: "o1", organizacao_nome: "Rede Sabor", unidade_id: "u1", unidade_nome: "Centro" }),
  linhaRoster({ contato_id: C_JOAO, telefone_e164: TEL_JOAO, perfil_id: "p2", perfil_nome: "João Lima", organizacao_id: "o2", organizacao_nome: "Doce Vale", unidade_id: "u3", unidade_nome: "Norte", papel: "unit_manager" }),
];

describe("INBOUND ponta a ponta — Central", () => {
  let servidor; let baseUrl; let repo; let db; let recebidosPeloProvider; let roteador = (_q, _r, n) => n();
  const provider = { _receberEventoMensagem: (e) => recebidosPeloProvider.push(e) };
  const inbox = { processarInbound: (p) => processarInbound(p, { supabase: db, env: {} }) };
  const deps = () => ({ supabase: db, env: {}, organizacaoConexaoId: ORG_ID, whatsAppService: null, estadoGateway: { estado: "conectado" }, lerPendencias: async () => ({ unidades: [] }), auditar: async () => {}, identidadeConfirmada: true });

  before(async () => {
    const app = express();
    app.use("/internal/comunicacao", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), (req, res, next) => roteador(req, res, next));
    servidor = createServer(app);
    await new Promise((r) => servidor.listen(0, r));
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(() => servidor.close());
  beforeEach(() => {
    _zerarMetricas(); repo = criarRepoEmMemoria(); recebidosPeloProvider = [];
    db = criarFakeDb({ comunicacao_roster_autorizado: ROSTER.map((l) => ({ ...l })), comunicacao_mensagens: [], comunicacao_inbox_mensagens: [], comunicacao_inbox_leituras: [], contatos_whatsapp: [], whatsapp_conexoes: [] });
    roteador = criarWhatsappGatewayRouter({ repo, organizacaoId: ORG_ID, provider, inbox });
  });

  const enviarBruto = (texto) => {
    const headers = assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: CAMINHO, corpo: texto }); headers["Content-Type"] = "application/json";
    return fetch(`${baseUrl}${CAMINHO}`, { method: "POST", headers, body: texto });
  };
  const enviar = (corpo) => enviarBruto(JSON.stringify(corpo));
  /** Envia e devolve { status, texto (corpo cru), json, logs (tudo que foi para o console durante a chamada) }. */
  async function enviarComLogs(corpo) {
    const logs = []; const orig = {};
    for (const n of ["log", "info", "warn", "error", "debug"]) { orig[n] = console[n]; console[n] = (...a) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); }
    try {
      const r = await enviar(corpo); const texto = await r.text();
      let json = null; try { json = JSON.parse(texto); } catch { /* corpo não-JSON */ }
      return { status: r.status, texto, json, logs: logs.join("\n") };
    } finally { for (const n of Object.keys(orig)) console[n] = orig[n]; }
  }
  const conversa = (contatoId, extra = {}) => obterConversa({ contatoId, ...extra }, { contaId: "operador" }, deps());
  const inboxDoDb = () => db.tabelas.comunicacao_inbox_mensagens ?? [];
  const saida = (o = {}) => ({
    id: uuid(Math.floor(Math.random() * 1e9)), organizacao_id: "o1", unidade_id: "u1", contato_id: C_MARIA, tipo: "manual", conteudo: "Bom dia, Maria!", status: "DELIVERED",
    created_at: minutosAtras(10), disponivel_em: minutosAtras(10), enviado_em: minutosAtras(10), entregue_em: minutosAtras(9), lido_em: null, falhou_em: null, erro: null,
    metadados: {}, updated_at: minutosAtras(9), direcao: "saida", ...o,
  });

  // -------------------------------------------------------------------------------------------------
  describe("(1) resposta de contato AUTORIZADO chega à conversa dele, em ordem com a saída", () => {
    test("POST assinado ⇒ 200; a API da conversa devolve direcao 'entrada' com o texto, entre as saídas, na ordem cronológica", async () => {
      db.tabelas.comunicacao_mensagens.push(
        saida({ id: uuid(9001), conteudo: "Bom dia, Maria!", enviado_em: minutosAtras(10), created_at: minutosAtras(10), entregue_em: minutosAtras(9) }),
        saida({ id: uuid(9002), conteudo: "Conseguiu ver o painel?", enviado_em: minutosAtras(1), created_at: minutosAtras(1), entregue_em: null, status: "SENT" }),
      );
      const r = await enviar(evento({ providerMessageId: "RESP-1", texto: "Vi sim, obrigada!", recebidoEm: minutosAtras(5) }));
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, duplicada: false, estado: "RECEIVED" });

      const c = await conversa(C_MARIA);
      assert.deepEqual(c.mensagens.map((m) => [m.direcao, m.texto]), [
        ["saida", "Bom dia, Maria!"], ["entrada", "Vi sim, obrigada!"], ["saida", "Conseguiu ver o painel?"],
      ], "ordem cronológica (mais antiga primeiro)");
      const e = c.mensagens.find((m) => m.direcao === "entrada");
      assert.deepEqual([e.tipo, e.origem, e.categoria], ["texto", "contato", "recebida"]);
      assert.equal(c.contato.whatsappConfirmado, true, "uma resposta real confirma que o número usa WhatsApp");
    });

    test("a resposta NÃO aparece na conversa de outro contato do roster", async () => {
      await enviar(evento({ texto: "mensagem só da Maria" }));
      const doJoao = await conversa(C_JOAO);
      assert.deepEqual(doJoao.mensagens, []);
      assert.ok(!JSON.stringify(doJoao).includes("mensagem só da Maria"));
    });

    test("a lista de conversas passa a mostrar a Maria (entrada é a última mensagem, 1 não lida) e continua sem o João", async () => {
      await enviar(evento({ texto: "Olá pela lista" }));
      const l = await listarConversas({}, deps());
      assert.deepEqual(l.itens.map((c) => c.nome), ["Maria Souza"]);
      assert.deepEqual([l.itens[0].ultimaMensagem.direcao, l.itens[0].ultimaMensagem.previa, l.itens[0].naoLidas], ["entrada", "Olá pela lista", 1]);
    });

    test("várias respostas em sequência: cada uma vira UMA bolha, na ordem de recebidoEm (não na ordem de chegada ao servidor)", async () => {
      await enviar(evento({ providerMessageId: "B", texto: "segunda", recebidoEm: minutosAtras(2) }));
      await enviar(evento({ providerMessageId: "A", texto: "primeira", recebidoEm: minutosAtras(4) }));
      await enviar(evento({ providerMessageId: "C", texto: "terceira", recebidoEm: minutosAtras(1) }));
      assert.deepEqual((await conversa(C_MARIA)).mensagens.map((m) => m.texto), ["primeira", "segunda", "terceira"]);
    });

    test("mídia recebida aparece como bolha tipo 'midia' SEM texto", async () => {
      await enviar(evento({ providerMessageId: "MID-1", tipoConteudo: "midia", texto: null }));
      const m = (await conversa(C_MARIA)).mensagens;
      assert.equal(m.length, 1);
      assert.deepEqual([m[0].direcao, m[0].tipo, m[0].texto], ["entrada", "midia", null]);
    });

    test("a conversa é limitada à organização da CONEXÃO: inbox gravado sob outra org não aparece", async () => {
      db.tabelas.comunicacao_inbox_mensagens.push({ id: uuid(7001), organizacao_id: uuid(999), contato_id: C_MARIA, provider_message_id: "OUTRA-ORG", origem_tipo: "LIVE", tipo_conteudo: "texto", texto: "de outra org", recebido_em: minutosAtras(3), created_at: minutosAtras(3) });
      await enviar(evento({ texto: "da org da conexão" }));
      assert.deepEqual((await conversa(C_MARIA)).mensagens.map((m) => m.texto), ["da org da conexão"]);
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe("(2) contato NÃO autorizado: ignorado, nada gravado, nada em conversa nenhuma", () => {
    test("200, nenhuma linha de inbox, nenhuma conversa de ninguém, lista vazia e o id dele não vira conversa (404)", async () => {
      const r = await enviar(evento({ telefoneE164: TEL_DESCONHECIDO, texto: "quem é você" }));
      assert.equal(r.status, 200);
      assert.equal(inboxDoDb().length, 0);
      for (const id of [C_MARIA, C_JOAO]) assert.deepEqual((await conversa(id)).mensagens, []);
      assert.deepEqual((await listarConversas({}, deps())).itens, []);
      assert.equal(metricasInbox().ignorados.nao_autorizado, 1);
      await assert.rejects(() => conversa(uuid(99999)), (e) => e.statusCode === 404);
      assert.ok(!JSON.stringify({ db: db.tabelas, razao: repo._inbound(ORG_ID) }).includes("quem é você"));
      assert.ok(!recebidosPeloProvider.some((e) => "texto" in e), "o provider nunca recebe conteúdo");
    });

    test("número no roster com formato parecido mas diferente (troca de 1 dígito) também é desconhecido", async () => {
      await enviar(evento({ telefoneE164: "+5511999990003" }));
      assert.equal(inboxDoDb().length, 0);
      assert.equal(metricasInbox().ignorados.nao_autorizado, 1);
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe("(3) entrega duplicada do mesmo providerMessageId", () => {
    test("a segunda entrega responde 200 duplicada:true; exatamente UMA linha e UMA bolha", async () => {
      const e = evento({ providerMessageId: "DUP-FIM-A-FIM", texto: "só uma vez" });
      const r1 = await (await enviar(e)).json();
      const r2 = await enviar(e); const j2 = await r2.json();
      assert.equal(r2.status, 200);
      assert.equal(r1.duplicada, false);
      assert.equal(j2.duplicada, true);
      assert.equal(inboxDoDb().length, 1);
      assert.deepEqual((await conversa(C_MARIA)).mensagens.map((m) => m.texto), ["só uma vez"]);
    });

    test("duplicata com o texto ALTERADO não sobrescreve nem cria segunda bolha (a primeira gravação vence)", async () => {
      await enviar(evento({ providerMessageId: "DUP-2", texto: "original" }));
      await enviar(evento({ providerMessageId: "DUP-2", texto: "adulterado" }));
      assert.deepEqual((await conversa(C_MARIA)).mensagens.map((m) => m.texto), ["original"]);
    });

    test("entregas concorrentes do mesmo id ⇒ uma única bolha", async () => {
      const e = evento({ providerMessageId: "DUP-CONC" });
      const rs = await Promise.all([enviar(e), enviar(e), enviar(e)]);
      assert.ok(rs.every((r) => r.status === 200));
      assert.equal(inboxDoDb().length, 1);
      assert.equal((await conversa(C_MARIA)).mensagens.length, 1);
    });

    test("o MESMO providerMessageId de dois contatos diferentes: o segundo é duplicata (id é único por organização, não por contato) — nunca duplica bolha", async () => {
      await enviar(evento({ providerMessageId: "MESMO-ID", telefoneE164: TEL_MARIA, texto: "da Maria" }));
      await enviar(evento({ providerMessageId: "MESMO-ID", telefoneE164: TEL_JOAO, texto: "do João" }));
      assert.equal(inboxDoDb().length, 1);
      assert.equal((await conversa(C_JOAO)).mensagens.length, 0, "a mensagem do João com id repetido não é atribuída a ninguém");
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe("(4) formas de JID / telefone", () => {
    test("direct_pn + JID_PN com E.164 EXATO do roster ⇒ conversa do contato certo (o outro contato do roster não recebe)", async () => {
      await enviar(evento({ telefoneE164: TEL_JOAO, texto: "sou o João" }));
      assert.deepEqual((await conversa(C_JOAO)).mensagens.map((m) => m.texto), ["sou o João"]);
      assert.deepEqual((await conversa(C_MARIA)).mensagens, []);
    });

    test("evento só com @lid (sem telefone): 200, ignorado 'sem_telefone', nada gravado, nada na conversa de ninguém", async () => {
      const r = await enviar(evento({ origemJidTipo: "direct_lid_other", telefoneE164: null, telefoneOrigem: null, tipoConteudo: "outro", texto: null }));
      assert.equal((await enviar(evento({ providerMessageId: "LID-TXT", origemJidTipo: "direct_lid_other", telefoneE164: null, telefoneOrigem: null }))).status, 400, "texto sem telefone real nem chega ao inbox (contrato)");
      assert.equal(r.status, 200);
      assert.equal(metricasInbox().ignorados.sem_telefone, 1);
      assert.equal(inboxDoDb().length, 0);
      for (const id of [C_MARIA, C_JOAO]) assert.deepEqual((await conversa(id)).mensagens, []);
    });

    test("LID + telefone real derivado do senderPn (direct_lid_other + SENDER_PN) ⇒ vira a conversa do contato dono desse telefone", async () => {
      const r = await enviar(evento({ origemJidTipo: "direct_lid_other", telefoneOrigem: "SENDER_PN", telefoneE164: TEL_MARIA, texto: "via senderPn" }));
      assert.equal(r.status, 200);
      assert.deepEqual((await conversa(C_MARIA)).mensagens.map((m) => [m.direcao, m.texto]), [["entrada", "via senderPn"]]);
    });

    test("telefone declarado com origem incoerente (LID + JID_PN, PN + SENDER_PN) ⇒ 400 e nada gravado (não dá para 'forçar' um telefone)", async () => {
      for (const extra of [{ origemJidTipo: "direct_lid_other", telefoneOrigem: "JID_PN" }, { origemJidTipo: "direct_pn", telefoneOrigem: "SENDER_PN" }, { origemJidTipo: "direct_lid_self" }]) {
        assert.equal((await enviar(evento(extra))).status, 400, JSON.stringify(extra));
      }
      assert.equal(inboxDoDb().length, 0);
      assert.equal(repo._inbound(ORG_ID).length, 0);
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe("(5)/(6) normalização do telefone brasileiro (9º dígito)", () => {
    test("LIMITAÇÃO CONHECIDA: 9º dígito não é normalizado — resposta sem o 9 de um contato cadastrado COM o 9 é ignorada como não autorizada e NINGUÉM recebe a mensagem", async () => {
      // cadastrado: +55 11 9 9999-0001 (13 dígitos). Resposta chega como +55 11 9999-0001 (12 dígitos, forma antiga, E.164 válido).
      const r = await enviar(evento({ telefoneE164: "+551199990001", texto: "resposta na forma antiga" }));
      assert.equal(r.status, 200);
      assert.equal(metricasInbox().ignorados.nao_autorizado, 1);
      assert.equal(metricasInbox().aceitos, 0);
      assert.equal(inboxDoDb().length, 0);
      for (const id of [C_MARIA, C_JOAO]) assert.deepEqual((await conversa(id)).mensagens, [], "nunca atribui ao contato 'parecido'");
      assert.ok(!JSON.stringify(db.tabelas).includes("resposta na forma antiga"));
    });

    test("LIMITAÇÃO CONHECIDA (inverso): contato cadastrado SEM o 9 e resposta COM o 9 ⇒ também ignorada, sem mis-atribuição", async () => {
      db.tabelas.comunicacao_roster_autorizado.push(linhaRoster({ contato_id: C_ANA_SEM9, telefone_e164: TEL_ANA_SEM9, perfil_id: "p9", perfil_nome: "Ana Antiga", organizacao_id: "o3", organizacao_nome: "Grão Forte", unidade_id: "u9", unidade_nome: "Sul" }));
      const r = await enviar(evento({ telefoneE164: TEL_ANA, texto: "com nove" }));
      assert.equal(r.status, 200);
      assert.equal(inboxDoDb().length, 0);
      for (const id of [C_MARIA, C_JOAO, C_ANA_SEM9]) assert.deepEqual((await conversa(id)).mensagens, []);
    });

    test("mesma pessoa cadastrada nas DUAS formas (dois contatos): a resposta que casa EXATAMENTE com uma só vai para ela, nunca para a outra", async () => {
      db.tabelas.comunicacao_roster_autorizado.push(
        linhaRoster({ contato_id: C_ANA, telefone_e164: TEL_ANA, perfil_id: "p3", perfil_nome: "Ana Nove", organizacao_id: "o3", organizacao_nome: "Grão Forte", unidade_id: "u4", unidade_nome: "Sul" }),
        linhaRoster({ contato_id: C_ANA_SEM9, telefone_e164: TEL_ANA_SEM9, perfil_id: "p4", perfil_nome: "Ana Oito", organizacao_id: "o3", organizacao_nome: "Grão Forte", unidade_id: "u5", unidade_nome: "Praia" }),
      );
      await enviar(evento({ providerMessageId: "ANA-9", telefoneE164: TEL_ANA, texto: "forma com nove" }));
      await enviar(evento({ providerMessageId: "ANA-8", telefoneE164: TEL_ANA_SEM9, texto: "forma sem nove" }));
      assert.deepEqual((await conversa(C_ANA)).mensagens.map((m) => m.texto), ["forma com nove"]);
      assert.deepEqual((await conversa(C_ANA_SEM9)).mensagens.map((m) => m.texto), ["forma sem nove"]);
      for (const id of [C_MARIA, C_JOAO]) assert.deepEqual((await conversa(id)).mensagens, []);
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe("(7) tenant, contrato estrito e vazamento de segredos", () => {
    test("o payload não escolhe a organização nem o contato: organizacao_id / organizacaoId / contato_id / contatoId ⇒ 400 'campo_desconhecido', nada gravado", async () => {
      for (const chave of ["organizacao_id", "organizacaoId", "contato_id", "contatoId", "estado"]) {
        const r = await enviarComLogs({ ...evento(), [chave]: uuid(555) });
        assert.equal(r.status, 400, chave);
        assert.deepEqual(r.json, { error: "mensagem_recebida_invalida", campo: "campo_desconhecido" }, chave);
      }
      assert.equal(inboxDoDb().length, 0);
      assert.equal(repo._inbound(ORG_ID).length, 0);
    });

    test("a linha gravada leva SEMPRE a organização da config do backend (e o contato do roster), nunca algo vindo do corpo", async () => {
      await enviar(evento({ providerMessageId: "ORG-CFG" }));
      assert.deepEqual([inboxDoDb()[0].organizacao_id, inboxDoDb()[0].contato_id], [ORG_ID, C_MARIA]);
      assert.equal(repo._inbound(ORG_ID).length, 1);
      assert.equal(repo._inbound(uuid(999)).length, 0);
    });

    test("payload malformado ⇒ 400 com CÓDIGO fechado, corpo só com {error,campo}, sem ecoar valores nem telefone", async () => {
      const lixo = "VALOR-SENSIVEL-XYZ";
      const casos = [
        [{ telefoneE164: "+55 (11) 99999-0001" }, "telefoneE164"],
        [{ providerMessageId: `id com espaço ${lixo}` }, "providerMessageId"],
        [{ origemTipo: lixo }, "origemTipo"],
        [{ recebidoEm: `ontem ${lixo}` }, "recebidoEm"],
        [{ fromMe: "false" }, "fromMe"],
        [{ tipoConteudo: lixo }, "tipoConteudo"],
        [{ texto: "" }, "texto"],
        [{ contratoInbound: 2 }, "contratoInbound"],
      ];
      for (const [extra, campo] of casos) {
        const r = await enviarComLogs(evento(extra));
        assert.equal(r.status, 400, campo);
        assert.deepEqual(r.json, { error: "mensagem_recebida_invalida", campo });
        assert.match(r.json.campo, /^[A-Za-z0-9_]+$/);
        for (const proibido of [lixo, "999990001", "5511"]) assert.ok(!r.texto.includes(proibido) && !r.logs.includes(proibido), `${campo}: eco de ${proibido}`);
      }
      const ausente = evento(); delete ausente.fromMe;
      assert.deepEqual((await enviarComLogs(ausente)).json, { error: "mensagem_recebida_invalida", campo: "fromMe_ausente" });
      for (const corpo of ["nao-e-json", "[]", "null", "42", '"texto"']) assert.equal((await enviarBruto(corpo)).status, 400, corpo);
      assert.equal(inboxDoDb().length, 0);
      assert.equal(repo._inbound(ORG_ID).length, 0);
    });

    test("respostas (sucesso, duplicata, ignorado, erro) e logs NUNCA contêm o segredo HMAC, a assinatura, tokens nem o telefone completo", async () => {
      const cenarios = [
        evento({ providerMessageId: "VAZ-1" }),                                 // autorizado
        evento({ providerMessageId: "VAZ-1" }),                                 // duplicata
        evento({ providerMessageId: "VAZ-2", telefoneE164: TEL_DESCONHECIDO }), // desconhecido
        evento({ providerMessageId: "VAZ-3", origemTipo: "OFFLINE_RECOVERY" }), // recovery
        { ...evento({ providerMessageId: "VAZ-4" }), organizacao_id: "x" },     // 400
      ];
      const headers = assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho: CAMINHO, corpo: "{}" });
      const assinaturas = Object.values(headers).map(String).filter((s) => s.length >= 16);
      for (const c of cenarios) {
        const r = await enviarComLogs(c);
        const tudo = r.texto + "\n" + r.logs;
        for (const proibido of [SEGREDO, "Bearer", "token", TEL_MARIA, TEL_DESCONHECIDO, TEL_MARIA.slice(1), TEL_DESCONHECIDO.slice(1), ...assinaturas]) {
          assert.ok(!tudo.toLowerCase().includes(String(proibido).toLowerCase()), `vazou ${String(proibido).slice(0, 6)}… em ${c.providerMessageId}`);
        }
      }
    });

    test("a API da conversa expõe só o telefone MASCARADO do contato (nunca o E.164 completo) e nunca o segredo", async () => {
      await enviar(evento());
      const corpo = JSON.stringify(await conversa(C_MARIA)) + JSON.stringify(await listarConversas({}, deps()));
      assert.ok(!corpo.includes(TEL_MARIA) && !corpo.includes(TEL_MARIA.slice(1)) && !corpo.includes(SEGREDO));
      assert.ok((await conversa(C_MARIA)).contato.telefoneMascarado, "há telefone mascarado para a UI");
    });

    test("falha do inbox: log só com nome do erro, sem texto nem telefone, e a conversa fica vazia (fail-closed) com 200 ao Gateway", async () => {
      roteador = criarWhatsappGatewayRouter({ repo, organizacaoId: ORG_ID, provider, inbox: { processarInbound: () => Promise.reject(new Error(`falha em ${TEL_MARIA} texto SEGREDO-TXT`)) } });
      const r = await enviarComLogs(evento({ texto: "SEGREDO-TXT" }));
      assert.equal(r.status, 200);
      assert.ok(!r.logs.includes("SEGREDO-TXT") && !r.logs.includes("999990001") && !r.texto.includes("999990001"));
      assert.deepEqual((await conversa(C_MARIA)).mensagens, []);
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe("(8) origem: OFFLINE_RECOVERY descartado, OFFLINE_NORMAL aceito", () => {
    test("pela rota: OFFLINE_NORMAL entra na conversa; OFFLINE_RECOVERY responde 200 mas é descartado pelo inbox (sem bolha, sem telefone no razão técnico)", async () => {
      const rn = await enviar(evento({ providerMessageId: "OFF-N", origemTipo: "OFFLINE_NORMAL", texto: "chegou offline normal" }));
      const rr = await enviar(evento({ providerMessageId: "OFF-R", origemTipo: "OFFLINE_RECOVERY", texto: "recuperada do histórico" }));
      assert.deepEqual([rn.status, rr.status], [200, 200]);
      assert.deepEqual((await conversa(C_MARIA)).mensagens.map((m) => m.texto), ["chegou offline normal"]);
      assert.equal(metricasInbox().ignorados.recovery, 1);
      assert.equal(inboxDoDb().length, 1);
      const razaoRecovery = repo._inbound(ORG_ID).find((x) => x.providerMessageId === "OFF-R");
      assert.ok(razaoRecovery, "o razão técnico registra o evento (quarentena)");
      assert.equal(razaoRecovery.estado, "QUARANTINED");
      assert.deepEqual([razaoRecovery.telefoneE164, razaoRecovery.telefoneOrigem], [null, null]);
      assert.ok(!JSON.stringify(db.tabelas).includes("recuperada do histórico"));
      assert.deepEqual(recebidosPeloProvider, [], "nem offline nem recovery chegam à automação");
    });

    test("a mesma mensagem reentregue depois como OFFLINE_RECOVERY não cria segunda bolha nem apaga a primeira", async () => {
      await enviar(evento({ providerMessageId: "REPLAY", origemTipo: "LIVE", texto: "ao vivo" }));
      await enviar(evento({ providerMessageId: "REPLAY", origemTipo: "OFFLINE_RECOVERY", texto: "ao vivo" }));
      assert.deepEqual((await conversa(C_MARIA)).mensagens.map((m) => m.texto), ["ao vivo"]);
    });
  });
});
