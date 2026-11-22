// MOVA — retrato dos membros atuais do grupo (groupMetadata, somente leitura) enviado junto do evento como `membrosGrupo`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarRetratoDeMembros } from "../src/grupoInterno.js";
import { criarEncaminhadorMova } from "../src/movaGrupo.js";

const GRUPO = "120363000000000201@g.us";
const conta = { id: "5500000000082:7@s.whatsapp.net", lid: "900000000000082:7@lid" };
const socketCom = (participants, extra = {}) => {
  let chamadas = 0;
  return { user: conta, get chamadas() { return chamadas; }, async groupMetadata(jid) { chamadas++; assert.equal(jid, GRUPO); return { id: GRUPO, participants }; }, ...extra };
};

test("RM1 prefere o JID de telefone, cai para o LID, tira a própria conta (PN ou LID) e não repete", async () => {
  const s = socketCom([
    { id: "111111111111111@lid", jid: "5500000000201@s.whatsapp.net" },
    { id: "222222222222222@lid", phoneNumber: "5500000000202:3@s.whatsapp.net" },
    { id: "333333333333333@lid" },
    { id: "900000000000082@lid", jid: "5500000000082@s.whatsapp.net" }, // a própria conta
    { id: "5500000000201@s.whatsapp.net" },                                // repetido
  ]);
  const r = await criarRetratoDeMembros({ agora: () => Date.parse("2026-11-22T17:00:00Z") })(GRUPO, s);
  assert.deepEqual(r.membros, ["5500000000201@s.whatsapp.net", "5500000000202@s.whatsapp.net", "333333333333333@lid"]);
  assert.equal(r.verificadoEm, "2026-11-22T17:00:00.000Z");
});

test("RM2 membro sem identidade reconhecível, falha ou timeout do WhatsApp ⇒ null (nada comprovado)", async () => {
  assert.equal(await criarRetratoDeMembros()(GRUPO, socketCom([{ id: "5500000000201@s.whatsapp.net" }, { id: "lixo" }])), null);
  assert.equal(await criarRetratoDeMembros()(GRUPO, { user: conta, async groupMetadata() { throw new Error("item-not-found"); } }), null);
  assert.equal(await criarRetratoDeMembros({ timeoutMs: 10 })(GRUPO, { user: conta, groupMetadata: () => new Promise(() => {}) }), null);
  assert.equal(await criarRetratoDeMembros()(GRUPO, socketCom([{ id: "900000000000082@lid" }])), null, "só a própria conta ⇒ sem membros");
  assert.equal(await criarRetratoDeMembros()("nao-e-grupo", socketCom([])), null);
});

test("RM3 cache curto por grupo e por socket: não consulta o WhatsApp a cada mensagem; socket novo consulta de novo", async () => {
  let agora = 1_000_000;
  const retratar = criarRetratoDeMembros({ cacheMs: 60_000, agora: () => agora });
  const s = socketCom([{ id: "5500000000201@s.whatsapp.net" }]);
  await retratar(GRUPO, s); await retratar(GRUPO, s);
  assert.equal(s.chamadas, 1);
  agora += 61_000; await retratar(GRUPO, s);
  assert.equal(s.chamadas, 2);
  const outro = socketCom([{ id: "5500000000201@s.whatsapp.net" }]);
  await retratar(GRUPO, outro);
  assert.equal(outro.chamadas, 1);
});

const msg = (remoteJid, participant = "5500000000201@s.whatsapp.net") => ({ key: { id: "ABC123", remoteJid, participant, fromMe: false }, message: { conversation: "MOVA, contas a pagar da semana" }, messageTimestamp: 1795000000 });

test("RM4 encaminhador anexa membrosGrupo só em grupo; falha do retrato ⇒ evento segue SEM o campo", async () => {
  const enviados = [];
  const e = criarEncaminhadorMova({ grupos: [GRUPO], notificar: async (p) => { enviados.push(p); }, retratarMembros: async () => ({ membros: ["5500000000201@s.whatsapp.net"], verificadoEm: "2026-11-22T17:00:00.000Z" }) });
  await Promise.all(e.aoMensagens([msg(GRUPO)], { socket: {} }));
  assert.deepEqual(enviados[0].membrosGrupo, { membros: ["5500000000201@s.whatsapp.net"], verificadoEm: "2026-11-22T17:00:00.000Z" });
  const sem = [];
  const logs = [];
  const f = criarEncaminhadorMova({ grupos: [GRUPO], notificar: async (p) => { sem.push(p); }, retratarMembros: async () => { throw new Error("x"); }, log: (n, ev) => logs.push(ev) });
  await Promise.all(f.aoMensagens([msg(GRUPO)], { socket: {} }));
  assert.equal(sem.length, 1);
  assert.equal("membrosGrupo" in sem[0], false);
  assert.ok(logs.includes("mova.retrato_membros_indisponivel"));
  const antigo = [];
  const g = criarEncaminhadorMova({ grupos: [GRUPO], notificar: async (p) => { antigo.push(p); } });
  await Promise.all(g.aoMensagens([msg(GRUPO)], { socket: {} }));
  assert.equal("membrosGrupo" in antigo[0], false, "sem retratarMembros o contrato fica igual ao anterior");
});
