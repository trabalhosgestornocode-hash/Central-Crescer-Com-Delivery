// MOVA — privados AUTORIZADOS (operação). Números FICTÍCIOS (5500000000xxx); os reais só existem no ambiente.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIRMACAO_PRIVADOS, MAX_PRIVADOS, criarVerificadorDeContatos, lerPrivadosMova } from "../src/movaPrivados.js";
import { criarEncaminhadorMova } from "../src/movaGrupo.js";

const A = "5500000000701"; const B = "5500000000702"; const X = "5500000000799";
const jid = (n) => `${n}@s.whatsapp.net`;
const LID = { [A]: "200000000000701@lid", [B]: "200000000000702@lid" };
const G = "120363000000000001@g.us";
// onWhatsApp por número: A e B existem (com LID); X existe mas não está na lista.
const socketFake = () => { const s = { chamadas: 0, onWhatsApp: async (d) => { s.chamadas += 1; return [{ exists: true, jid: jid(d), lid: LID[d] ?? null }]; } }; return s; };
const msg = (key, message = { conversation: "quanto entrou ontem?" }) => ({ key: { id: `P${Math.random().toString(36).slice(2, 12)}`, fromMe: false, ...key }, pushName: "Pessoa", messageTimestamp: 1763800000, message });

test("configuração: desligada por padrão e sem a confirmação exata; formato inválido ou lista longa derruba o boot", () => {
  assert.deepEqual(lerPrivadosMova({}), { ativo: false, motivo: "SEM_PRIVADOS" });
  assert.deepEqual(lerPrivadosMova({ lista: `${A},${B}` }), { ativo: false, motivo: "SEM_CONFIRMACAO_DE_MODO" });
  assert.deepEqual(lerPrivadosMova({ lista: `${A},${B}`, confirmacao: "sim" }), { ativo: false, motivo: "SEM_CONFIRMACAO_DE_MODO" });
  const ok = lerPrivadosMova({ lista: ` ${A}, ${B},${A} `, confirmacao: CONFIRMACAO_PRIVADOS });
  assert.equal(ok.ativo, true);
  assert.deepEqual([...ok.telefones], [`+${A}`, `+${B}`], "sem duplicados");
  assert.throws(() => lerPrivadosMova({ lista: `+${A}`, confirmacao: CONFIRMACAO_PRIVADOS }), /E\.164/);
  assert.throws(() => lerPrivadosMova({ lista: "5500000000701@s.whatsapp.net", confirmacao: CONFIRMACAO_PRIVADOS }), /E\.164/);
  const muitos = Array.from({ length: MAX_PRIVADOS + 1 }, (_, i) => `55000000${String(10000 + i)}`).join(",");
  assert.throws(() => lerPrivadosMova({ lista: muitos, confirmacao: CONFIRMACAO_PRIVADOS }), /no máximo/);
});

test("identidade por contato: cada mensagem é atribuída a QUEM enviou (PN, LID ou chat LID com senderPn); fora da lista ⇒ null", async () => {
  const v = criarVerificadorDeContatos({ telefonesE164: [`+${A}`, `+${B}`] });
  const s = socketFake();
  assert.equal((await v.quemEnviou(msg({ remoteJid: jid(A) }), s)).jid, jid(A));
  assert.equal((await v.quemEnviou(msg({ remoteJid: LID[B] }), s)).jid, jid(B));
  assert.equal((await v.quemEnviou(msg({ remoteJid: "300000000000009@lid", senderPn: jid(B) }), s)).jid, jid(B));
  assert.equal(await v.quemEnviou(msg({ remoteJid: jid(X) }), s), null);
  assert.equal(await v.quemEnviou(msg({ remoteJid: "300000000000009@lid" }), s), null);
  assert.equal(await v.quemEnviou(msg({ remoteJid: jid(A), fromMe: true }), s), null);
  assert.equal(await v.quemEnviou(msg({ remoteJid: G, participant: jid(A) }), s), null);
  assert.equal(s.chamadas, 2, "resolve cada número uma vez por socket");
  assert.equal((await v.identidadeDoDestino(jid(B), s)).lid, LID[B], "envio usa o LID do PRÓPRIO destino");
  assert.equal(await v.identidadeDoDestino(jid(X), s), null);
  assert.equal(await v.jidAutorizadoParaEnvio(jid(X), s), false);
  assert.equal(await v.jidAutorizadoParaEnvio(`${A}:4@s.whatsapp.net`, s), true);
});

test("fail-closed: se o WhatsApp não confirma um número, só ele fica fora; os demais seguem", async () => {
  const v = criarVerificadorDeContatos({ telefonesE164: [`+${A}`, `+${B}`] });
  const s = { onWhatsApp: async (d) => (d === A ? [] : [{ exists: true, jid: jid(d), lid: null }]) };
  assert.equal(await v.quemEnviou(msg({ remoteJid: jid(A) }), s), null);
  assert.equal((await v.quemEnviou(msg({ remoteJid: jid(B) }), s)).jid, jid(B));
  assert.equal(await v.jidAutorizadoParaEnvio(jid(A), s), false);
  assert.throws(() => criarVerificadorDeContatos({ telefonesE164: [] }), /lista vazia/);
});

test("encaminhador: cada privado autorizado vira evento da PRÓPRIA conversa; outros privados nunca passam; grupos iguais", async () => {
  const enviados = [];
  const v = criarVerificadorDeContatos({ telefonesE164: [`+${A}`, `+${B}`] });
  const enc = criarEncaminhadorMova({ grupos: [G], notificar: async (p) => enviados.push(p), contatoHomologacao: v });
  const s = socketFake();
  await Promise.all(enc.aoMensagens([
    msg({ remoteJid: jid(A) }), msg({ remoteJid: LID[B] }), msg({ remoteJid: jid(X) }),
    msg({ remoteJid: G, participant: LID[A], participantPn: jid(A) }),
  ], { socket: s }));
  const porConversa = {}; for (const p of enviados) (porConversa[p.grupoId] ??= []).push(p);
  assert.equal(porConversa[jid(A)].length, 1);
  assert.equal(porConversa[jid(A)][0].participanteId, jid(A));
  assert.equal(porConversa[jid(A)][0].telefoneE164, `+${A}`);
  assert.equal(porConversa[jid(B)].length, 1);
  assert.equal(porConversa[jid(B)][0].telefoneE164, `+${B}`);
  assert.equal(porConversa[jid(X)], undefined, "privado fora da lista não vai ao MOVA");
  assert.equal(porConversa[G][0].participanteId, LID[A]);
  assert.equal(porConversa[G][0].telefoneE164, `+${A}`, "no grupo, o telefone vem só do PN explícito");
  // mesma mensagem entregue de novo (reconexão) ⇒ não repete no processo
  const repetida = msg({ remoteJid: jid(A) });
  await Promise.all(enc.aoMensagens([repetida], { socket: s }));
  await Promise.all(enc.aoMensagens([repetida], { socket: s }));
  assert.equal(enviados.filter((p) => p.mensagemId === repetida.key.id).length, 1);
});
