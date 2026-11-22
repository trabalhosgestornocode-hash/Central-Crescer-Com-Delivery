// 17B — diagnóstico SOMENTE LEITURA dos grupos da conta (para o proprietário escolher o grupo do MOVA).
// Não envia nada; estar no grupo não é autorização; números completos de participantes NUNCA saem.
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { diagnosticarGruposDaConta } from "../src/grupoInterno.js";
import { CODIGOS } from "../src/errors.js";

const G1 = "120363000000000001@g.us", G2 = "120363000000000002@g.us";
const sock = (grupos, extra = {}) => ({ user: { id: "5511999990000:1@s.whatsapp.net", lid: "100000000000001:1@lid" }, groupFetchAllParticipating: mock.fn(async () => grupos), sendMessage: mock.fn(async () => { throw new Error("NÃO PODE ENVIAR"); }), ...extra });
const grupos = () => ({
  [G2]: { id: G2, subject: "Zeta (sintético)", size: 2, addressingMode: "pn", announce: true, participants: [
    { id: "5511987650001@s.whatsapp.net", jid: "5511987650001@s.whatsapp.net", admin: "superadmin" }, { id: "5511987650002@s.whatsapp.net", jid: "5511987650002@s.whatsapp.net", admin: null }] },
  [G1]: { id: G1, subject: "Alfa (sintético)", size: 4, addressingMode: "lid", announce: false, isCommunity: false, participants: [
    { id: "5511999990000@s.whatsapp.net", jid: "5511999990000@s.whatsapp.net", lid: "100000000000001@lid", admin: "admin" },
    { id: "200000000000002@lid", lid: "200000000000002@lid", admin: "admin" },
    { id: "200000000000003@lid", jid: "5511987650003@s.whatsapp.net", lid: "200000000000003@lid", admin: null },
    { id: "200000000000004@lid", lid: "200000000000004@lid", admin: null }] },
  "naoGrupo@s.whatsapp.net": { id: "naoGrupo@s.whatsapp.net", subject: "ignorado", participants: [] },
});

describe("17B diagnóstico de grupos", () => {
  test("resume por grupo (nome, id, tamanho, endereçamento, admins, PN/LID) ordenado por nome; ignora ids que não são grupo", async () => {
    const s = sock(grupos());
    const r = await diagnosticarGruposDaConta({ socket: s });
    assert.deepEqual(r.map((g) => g.jid), [G1, G2]);
    const [a, z] = r;
    assert.deepEqual([a.nome, a.participantes, a.enderecamento, a.somenteAdminsEnviam, a.administradores, a.contaEhAdmin], ["Alfa (sintético)", 4, "lid", false, 2, true]);
    assert.deepEqual([a.comNumero, a.comLid, a.somenteLid], [2, 4, 2]);
    assert.deepEqual(a.adminsFinais, ["••0000", "somente-LID"]);
    assert.deepEqual([z.nome, z.participantes, z.enderecamento, z.somenteAdminsEnviam, z.administradores, z.contaEhAdmin], ["Zeta (sintético)", 2, "pn", true, 1, false]);
    assert.deepEqual(z.adminsFinais, ["••0001"]);
    assert.equal(s.sendMessage.mock.callCount(), 0, "diagnóstico nunca envia");
    assert.equal(s.groupFetchAllParticipating.mock.callCount(), 1);
  });

  test("NUNCA devolve número completo de participante nem LID: só contagens e os 4 últimos dígitos dos administradores", async () => {
    const texto = JSON.stringify(await diagnosticarGruposDaConta({ socket: sock(grupos()) }));
    for (const completo of ["5511987650001", "5511987650002", "5511987650003", "5511999990000", "200000000000002", "200000000000003", "200000000000004", "100000000000001"]) {
      assert.ok(!texto.includes(completo), `vazou ${completo}`);
    }
    assert.ok(!/@s\.whatsapp\.net|@lid/.test(texto), "nenhum JID de pessoa na saída");
  });

  test("limite de grupos, nome ausente e tamanho derivado dos participantes", async () => {
    const muitos = Object.fromEntries(Array.from({ length: 5 }, (_, i) => { const id = `1203630000000001${i}0@g.us`; return [id, { id, subject: i === 0 ? "" : `G${i}`, participants: [{ id: "1@s.whatsapp.net" }] }]; }));
    const r = await diagnosticarGruposDaConta({ socket: sock(muitos), max: 3 });
    assert.equal(r.length, 3);
    assert.ok(r.every((g) => g.participantes === 1));
    assert.equal(r.find((g) => g.nome === null)?.nome ?? null, null);
  });

  test("falhas viram erro de consulta (nunca exceção solta): socket sem a função, timeout e resposta ilegível", async () => {
    await assert.rejects(diagnosticarGruposDaConta({ socket: {} }), (e) => e.codigo === CODIGOS.CONSULTA_GRUPO_FALHOU);
    await assert.rejects(diagnosticarGruposDaConta({ socket: { groupFetchAllParticipating: () => new Promise(() => {}) }, timeoutMs: 20 }), (e) => e.codigo === CODIGOS.CONSULTA_GRUPO_FALHOU);
    await assert.rejects(diagnosticarGruposDaConta({ socket: { groupFetchAllParticipating: async () => null } }), (e) => e.codigo === CODIGOS.CONSULTA_GRUPO_FALHOU);
  });
});

// ---- gatilho na SESSÃO: roda UMA vez por processo depois de conectar, só com a flag; nunca envia
import { EventEmitter } from "node:events";
import { criarSessaoBaileys } from "../src/baileysSession.js";

const AUTH_ID = "11111111-1111-4111-8111-111111111111";
function authFalso() {
  let creds = null;
  return {
    async carregar() { return creds ? { status: "loaded", registered: true, authConfirmado: true } : { status: "absent" }; },
    inicializarCreds(c) { creds = c; }, invalidarLocal() { creds = null; },
    comoAuthState() { return { creds, keys: { get: async () => ({}), set: async () => {} } }; },
    async aoAtualizarCreds(d) { if (creds) Object.assign(creds, d); else creds = d; },
    async aguardarPersistenciasPendentes() {}, async garantirPersistido() { return { status: "limpo" }; }, obterAuthSessionIdAtual() { return AUTH_ID; },
  };
}
const backendFalso = () => ({
  notificarHeartbeat: mock.fn(async () => {}), notificarMensagemRecebida: mock.fn(async () => {}), notificarStatusProvider: mock.fn(async () => ({ ok: true, resultado: "APLICADO" })),
  definirEstadoDesejado: mock.fn(async () => ({ ok: true })), obterEstadoSessao: mock.fn(async () => ({})), resetarAuthState: mock.fn(async () => ({ ok: true })), confirmarAuthState: mock.fn(async () => ({})),
});
async function sessaoComDiagnostico(diagnosticoGrupos) {
  const criados = [];
  const fabrica = (opcoes) => { const s = { opcoes, ev: new EventEmitter(), ws: new EventEmitter(), user: { id: "5511999990000:1@s.whatsapp.net" }, onWhatsApp: mock.fn(async () => []),
    groupFetchAllParticipating: mock.fn(async () => grupos()), sendMessage: mock.fn(async () => { throw new Error("NÃO PODE ENVIAR"); }), readMessages: mock.fn(async () => {}), end: mock.fn(async () => {}) }; criados.push(s); return s; };
  const lease = { souLeader: () => true, contexto: () => ({ gatewayProcessId: "p", leaseEpoch: 1 }), notificarPerdaExterna: mock.fn(async () => {}) };
  const sessao = criarSessaoBaileys({ authAdapter: authFalso(), backendClient: backendFalso(), fabricaSocket: fabrica, DisconnectReasonLoggedOut: 401, leaseManager: lease,
    config: { reconnect: { baseMs: 5, tetoMs: 10 }, heartbeatMs: 1_000_000, providerInstanceId: "d", gatewayVersion: "0", diagnosticoGrupos, diagnosticoGruposAtrasoMs: 5 } });
  await sessao.conectar();
  const abrir = async (s) => { s.ev.emit("connection.update", { connection: "open" }); s.ev.emit("creds.update", { registered: true }); await new Promise((r) => setImmediate(r)); };
  await abrir(criados[0]);
  return { sessao, criados, abrir };
}
describe("17B diagnóstico de grupos na sessão", () => {
  test("flag LIGADA: consulta os grupos UMA vez depois de conectar (mesmo reabrindo a conexão) e nunca envia", async () => {
    const { sessao, criados, abrir } = await sessaoComDiagnostico(true);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(criados[0].groupFetchAllParticipating.mock.callCount(), 1);
    await abrir(criados[0]); await new Promise((r) => setTimeout(r, 60));
    assert.equal(criados[0].groupFetchAllParticipating.mock.callCount(), 1, "uma vez por processo");
    assert.equal(criados[0].sendMessage.mock.callCount(), 0);
    await sessao.desconectar();
  });
  test("flag DESLIGADA (padrão): nunca consulta", async () => {
    const { sessao, criados } = await sessaoComDiagnostico(false);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(criados[0].groupFetchAllParticipating.mock.callCount(), 0);
    await sessao.desconectar();
  });
});
