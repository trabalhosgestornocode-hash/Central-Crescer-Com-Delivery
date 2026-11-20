// MOVA — homologação PRIVADA no Gateway (Execução 04B). Números FICTÍCIOS (5500000000xxx); o número real só existe no ambiente.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CONFIRMACAO_HOMOLOGACAO, criarVerificadorDeContato, lerContatoHomologacao } from "../src/movaHomologacao.js";
import { criarEncaminhadorMova } from "../src/movaGrupo.js";
import { criarSessaoBaileys } from "../src/baileysSession.js";
import { CODIGOS } from "../src/errors.js";

const TEL = "5500000000777";
const JID = `${TEL}@s.whatsapp.net`;
const LID = "200000000000777@lid";
const OUTRO = "5500000000888@s.whatsapp.net";
const G = "120363000000000001@g.us";
const socketFake = (resposta = [{ exists: true, jid: JID, lid: LID }]) => { const s = { chamadas: 0, onWhatsApp: async () => { s.chamadas += 1; return resposta; } }; return s; };
const msg = (key, message = { conversation: "boleto de teste, alfa" }) => ({ key: { id: `H${Math.random().toString(36).slice(2, 12)}`, fromMe: false, ...key }, pushName: "Contato Teste", messageTimestamp: 1792076400, message });

test("configuração: desligada por padrão; sem a confirmação exata de modo continua desligada; formato inválido derruba o boot", () => {
  assert.deepEqual(lerContatoHomologacao({}), { ativo: false, motivo: "SEM_CONTATO" });
  assert.deepEqual(lerContatoHomologacao({ contato: TEL }), { ativo: false, motivo: "SEM_CONFIRMACAO_DE_MODO" });
  assert.deepEqual(lerContatoHomologacao({ contato: TEL, confirmacao: "sim" }), { ativo: false, motivo: "SEM_CONFIRMACAO_DE_MODO" });
  assert.deepEqual(lerContatoHomologacao({ contato: TEL, confirmacao: CONFIRMACAO_HOMOLOGACAO }), { ativo: true, telefoneE164: `+${TEL}` });
  assert.throws(() => lerContatoHomologacao({ contato: "+55 00 0000", confirmacao: CONFIRMACAO_HOMOLOGACAO }), /E\.164/);
});

test("identidade verificada pelo WhatsApp: aceita JID canônico, LID do contato e chat LID com senderPn; recusa os demais", async () => {
  const v = criarVerificadorDeContato({ telefoneE164: `+${TEL}` });
  const s = socketFake();
  assert.equal(await v.mensagemDoContato(msg({ remoteJid: JID }), s), true);
  assert.equal(await v.mensagemDoContato(msg({ remoteJid: `${TEL}:3@s.whatsapp.net` }), s), true);       // com device
  assert.equal(await v.mensagemDoContato(msg({ remoteJid: LID }), s), true);
  assert.equal(await v.mensagemDoContato(msg({ remoteJid: "300000000000001@lid", senderPn: JID }), s), true);
  assert.equal(await v.mensagemDoContato(msg({ remoteJid: OUTRO }), s), false);                          // outro contato
  assert.equal(await v.mensagemDoContato(msg({ remoteJid: "300000000000001@lid" }), s), false);         // LID desconhecido
  assert.equal(await v.mensagemDoContato(msg({ remoteJid: JID, fromMe: true }), s), false);             // própria conta
  assert.equal(await v.mensagemDoContato(msg({ remoteJid: G, participant: JID }), s), false);           // grupo não é privado
  assert.equal(s.chamadas, 1, "resolve uma vez por socket");
  const novo = socketFake();
  await v.mensagemDoContato(msg({ remoteJid: JID }), novo);
  assert.equal(novo.chamadas, 1, "reconexão (socket novo) resolve de novo");
});

test("fail-closed: WhatsApp não confirma o número ⇒ nada passa (nem o JID 'declarado')", async () => {
  const v = criarVerificadorDeContato({ telefoneE164: `+${TEL}` });
  assert.equal(await v.mensagemDoContato(msg({ remoteJid: JID }), socketFake([{ exists: false }])), false);
  assert.equal(await v.mensagemDoContato(msg({ remoteJid: JID }), socketFake([{ exists: true, jid: OUTRO }])), false);
});

test("encaminhador: contato verificado vira evento privado; outro contato e privado sem homologação são ignorados; grupos seguem iguais", async () => {
  const enviados = [];
  const v = criarVerificadorDeContato({ telefoneE164: `+${TEL}` });
  const s = socketFake();
  const enc = criarEncaminhadorMova({ grupos: [G], notificar: async (p) => enviados.push(p), contatoHomologacao: v, baixarMidia: async () => Buffer.from("%PDF-ficticio") });
  await Promise.all(enc.aoMensagens([
    msg({ remoteJid: LID }), msg({ remoteJid: OUTRO }), msg({ remoteJid: JID, fromMe: true }),
    msg({ remoteJid: JID }, { documentMessage: { mimetype: "application/pdf", fileName: "teste.pdf", caption: "boleto ficticio" } }),
    msg({ remoteJid: G, participant: "100000000000001@lid" }),
  ], { socket: s }));
  const privados = enviados.filter((p) => p.grupoId === JID);
  assert.equal(privados.length, 2);
  assert.ok(privados.every((p) => p.participanteId === JID && p.telefoneE164 === `+${TEL}`));
  assert.equal(privados.find((p) => p.tipo === "DOCUMENTO").midia.base64.length > 0, true);
  assert.equal(enviados.filter((p) => p.grupoId === G).length, 1);
  assert.equal(enviados.some((p) => p.grupoId === OUTRO), false);
  const semHomolog = criarEncaminhadorMova({ grupos: [G], notificar: async (p) => enviados.push(p) });
  const antes = enviados.length;
  await Promise.all(semHomolog.aoMensagens([msg({ remoteJid: JID })], { socket: s }));
  assert.equal(enviados.length, antes, "sem homologação, nenhuma conversa privada passa");
});

test("envio: só ao contato verificado, só com envio ligado; nunca a outro contato", async () => {
  const fab = () => ({ ev: new EventEmitter(), ws: new EventEmitter(), user: null, end: async () => {} });
  const v = criarVerificadorDeContato({ telefoneE164: `+${TEL}` });
  const mk = (config, mova) => criarSessaoBaileys({ authAdapter: { comoAuthState: () => ({}) }, backendClient: {}, config: { providerInstanceId: "t", ...config }, fabricaSocket: fab, DisconnectReasonLoggedOut: 401, agendar: () => 0, cancelar: () => {}, mova });
  await assert.rejects(mk({}, { contatoHomologacao: v }).enviarGrupoMova({ grupoJid: JID, texto: "x" }), (e) => e.codigo === CODIGOS.GRUPO_NAO_AUTORIZADO);
  await assert.rejects(mk({ movaEnvioHabilitado: true }, null).enviarGrupoMova({ grupoJid: JID, texto: "x" }), (e) => e.codigo === CODIGOS.GRUPO_NAO_AUTORIZADO);
  await assert.rejects(mk({ movaEnvioHabilitado: true }, { contatoHomologacao: v }).enviarGrupoMova({ grupoJid: JID, texto: "x" }), (e) => e.codigo === CODIGOS.NAO_CONECTADO);
  assert.equal(await v.jidAutorizadoParaEnvio(OUTRO, socketFake()), false);
  assert.equal(await v.jidAutorizadoParaEnvio(JID, socketFake()), true);
});
