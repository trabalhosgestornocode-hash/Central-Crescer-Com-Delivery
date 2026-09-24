// Central de Comunicação — INBOUND: só responsável AUTORIZADO vira conversa. Desconhecido, grupo, status, broadcast, recovery, fromMe e falha de decrypt são ignorados.
// Sem rede, sem banco (fake em memória com a semântica das funções SQL da 096).
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { processarInbound, metricasInbox, _zerarMetricas, DESTINO } from "../src/modules/comunicacao/comunicacao.inbox.service.js";
import { retencaoDias } from "../src/modules/comunicacao/comunicacao.inbox.repo.js";
import { criarFakeDb, linhaRoster } from "./helpers/central-fake-db.js";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const TEL = "+5511999990001";
const evento = (o = {}) => ({
  contratoInbound: 1, providerMessageId: "MSG-1", origemTipo: "LIVE", origemJidTipo: "direct_pn", fromMe: false, telefoneE164: TEL, telefoneOrigem: "JID_PN",
  falhaDecrypt: false, motivoFalhaDecrypt: null, stubSistema: false, recebidoEm: new Date().toISOString(), tipoConteudo: "texto", texto: "Bom dia, tudo certo por aqui", ...o,
});
const dbCom = (linhas = [linhaRoster()]) => criarFakeDb({ comunicacao_roster_autorizado: linhas });
const rodar = (db, ev, extra = {}) => processarInbound({ organizacaoId: ORG, evento: ev }, { supabase: db, env: {}, ...extra });
const mensagens = (db) => db.tabelas.comunicacao_inbox_mensagens ?? [];

beforeEach(() => _zerarMetricas());

describe("contato AUTORIZADO", () => {
  test("mensagem de responsável cadastrado aparece na conversa (persistida com o contato)", async () => {
    const db = dbCom();
    const r = await rodar(db, evento());
    assert.deepEqual([r.destino, r.contatoId, r.inserido], [DESTINO.INBOX, "c1", true]);
    assert.equal(mensagens(db).length, 1);
    assert.deepEqual([mensagens(db)[0].contato_id, mensagens(db)[0].texto, mensagens(db)[0].tipo_conteudo, mensagens(db)[0].organizacao_id], ["c1", "Bom dia, tudo certo por aqui", "texto", ORG]);
  });

  test("dois vínculos (duas unidades/empresas) do MESMO telefone ⇒ UMA conversa (um contato_id)", async () => {
    const db = dbCom([
      linhaRoster({ organizacao_id: "o1", organizacao_nome: "Loja Centro", unidade_id: "u1", unidade_nome: "Centro" }),
      linhaRoster({ organizacao_id: "o1", organizacao_nome: "Loja Centro", unidade_id: "u2", unidade_nome: "Praia" }),
      linhaRoster({ organizacao_id: "o2", organizacao_nome: "Outra Rede", unidade_id: "u3", unidade_nome: "Norte" }),
    ]);
    const r = await rodar(db, evento());
    assert.equal(r.destino, DESTINO.INBOX);
    assert.equal(mensagens(db).length, 1);
    assert.equal(new Set(mensagens(db).map((m) => m.contato_id)).size, 1);
  });

  test("idempotente: o mesmo providerMessageId duas vezes ⇒ uma linha; a segunda devolve inserido=false", async () => {
    const db = dbCom();
    assert.equal((await rodar(db, evento())).inserido, true);
    assert.equal((await rodar(db, evento())).inserido, false);
    assert.equal(mensagens(db).length, 1);
  });

  test("mídia vira só um marcador: tipo 'midia', SEM texto", async () => {
    const db = dbCom();
    await rodar(db, evento({ providerMessageId: "M2", tipoConteudo: "midia", texto: null }));
    assert.deepEqual([mensagens(db)[0].tipo_conteudo, mensagens(db)[0].texto], ["midia", null]);
  });

  test("LID de outro contato COM telefone real (SENDER_PN) também é resolvido", async () => {
    const db = dbCom();
    const r = await rodar(db, evento({ origemJidTipo: "direct_lid_other", telefoneOrigem: "SENDER_PN" }));
    assert.equal(r.destino, DESTINO.INBOX);
  });

  test("OFFLINE_NORMAL entra (é entrega normal do WhatsApp), OFFLINE_RECOVERY nunca", async () => {
    const db = dbCom();
    assert.equal((await rodar(db, evento({ providerMessageId: "A", origemTipo: "OFFLINE_NORMAL" }))).destino, DESTINO.INBOX);
    assert.deepEqual(await rodar(db, evento({ providerMessageId: "B", origemTipo: "OFFLINE_RECOVERY" })), { destino: DESTINO.IGNORADO, motivo: "recovery" });
    assert.equal(mensagens(db).length, 1);
  });
});

describe("IGNORADO — nada é persistido", () => {
  const casos = [
    ["contato DESCONHECIDO (fora do roster)", { telefoneE164: "+5511888880000" }, "nao_autorizado"],
    ["grupo", { origemJidTipo: "group", telefoneE164: null, telefoneOrigem: null }, "chat_nao_direto"],
    ["status", { origemJidTipo: "status", telefoneE164: null, telefoneOrigem: null }, "chat_nao_direto"],
    ["broadcast", { origemJidTipo: "broadcast", telefoneE164: null, telefoneOrigem: null }, "chat_nao_direto"],
    ["newsletter", { origemJidTipo: "newsletter", telefoneE164: null, telefoneOrigem: null }, "chat_nao_direto"],
    ["meta_ai", { origemJidTipo: "meta_ai", telefoneE164: null, telefoneOrigem: null }, "chat_nao_direto"],
    ["LID próprio", { origemJidTipo: "direct_lid_self", telefoneE164: null, telefoneOrigem: null }, "chat_nao_direto"],
    ["LID SEM telefone real (nunca adivinha)", { origemJidTipo: "direct_lid_other", telefoneE164: null, telefoneOrigem: null }, "sem_telefone"],
    ["fromMe", { fromMe: true, telefoneE164: null, telefoneOrigem: null }, "from_me"],
    ["falha de decrypt", { falhaDecrypt: true, motivoFalhaDecrypt: "bad_mac", tipoConteudo: "outro", texto: null }, "falha_decrypt"],
    ["stub de sistema", { stubSistema: true, tipoConteudo: "outro", texto: null }, "stub_sistema"],
    ["sem conteúdo aproveitável (reação, enquete...)", { tipoConteudo: "outro", texto: null }, "sem_conteudo"],
    ["evento de Gateway antigo (sem tipoConteudo)", { tipoConteudo: undefined, texto: undefined }, "sem_conteudo"],
  ];
  for (const [rotulo, extra, motivo] of casos) {
    test(`${rotulo} ⇒ ${motivo}, sem conversa e sem texto guardado`, async () => {
      const db = dbCom();
      const ev = evento(extra); for (const k of Object.keys(ev)) if (ev[k] === undefined) delete ev[k];
      assert.deepEqual(await rodar(db, ev), { destino: DESTINO.IGNORADO, motivo });
      assert.equal(mensagens(db).length, 0);
      assert.ok(!db.chamadasRpc.some((c) => c.nome === "comunicacao_inbox_registrar"), "nunca chega a registrar");
    });
  }

  test("desconhecido não deixa NENHUM rastro do texto nem do telefone em nenhuma tabela nem na métrica", async () => {
    const db = dbCom();
    await rodar(db, evento({ telefoneE164: "+5511777770000", texto: "SEGREDO-DO-DESCONHECIDO" }));
    const tudo = JSON.stringify({ t: db.tabelas, m: metricasInbox(), c: db.chamadasRpc });
    assert.ok(!tudo.includes("SEGREDO-DO-DESCONHECIDO"));
    assert.ok(!tudo.includes("777770000"));
  });

  test("entrada lixo nunca lança nem persiste", async () => {
    const db = dbCom();
    for (const ev of [null, undefined, "x", 5, [], {}]) {
      const r = await processarInbound({ organizacaoId: ORG, evento: ev }, { supabase: db });
      assert.equal(r.destino, DESTINO.IGNORADO);
    }
    assert.equal((await processarInbound({ organizacaoId: "", evento: evento() }, { supabase: db })).destino, DESTINO.IGNORADO);
    assert.equal(mensagens(db).length, 0);
  });
});

describe("métrica agregada", () => {
  test("conta por motivo, sem telefone/id/conteúdo", async () => {
    const db = dbCom();
    await rodar(db, evento({ telefoneE164: "+5511888880000" }));
    await rodar(db, evento({ origemJidTipo: "group", telefoneE164: null, telefoneOrigem: null }));
    await rodar(db, evento({ providerMessageId: "OK" }));
    const m = metricasInbox();
    assert.equal(m.ignorados.nao_autorizado, 1); assert.equal(m.ignorados.chat_nao_direto, 1); assert.equal(m.aceitos, 1);
    assert.ok(!JSON.stringify(m).includes("+55"));
  });
});

describe("retenção e purga", () => {
  test("retencaoDias: padrão 30; aceita 1..365; lixo volta ao padrão", () => {
    assert.equal(retencaoDias({}), 30);
    assert.equal(retencaoDias({ COMUNICACAO_INBOX_RETENCAO_DIAS: "7" }), 7);
    for (const x of ["0", "-1", "366", "abc", "1.5", ""]) assert.equal(retencaoDias({ COMUNICACAO_INBOX_RETENCAO_DIAS: x }), 30, x);
  });

  test("ao registrar, mensagens mais velhas que a retenção da organização são purgadas", async () => {
    const velha = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const db = criarFakeDb({
      comunicacao_roster_autorizado: [linhaRoster()],
      comunicacao_inbox_mensagens: [{ id: "x", organizacao_id: ORG, contato_id: "c1", provider_message_id: "VELHA", origem_tipo: "LIVE", tipo_conteudo: "texto", texto: "antiga", recebido_em: velha }],
    });
    await rodar(db, evento({ providerMessageId: "NOVA" }));
    assert.deepEqual(mensagens(db).map((m) => m.provider_message_id), ["NOVA"]);
  });
});
