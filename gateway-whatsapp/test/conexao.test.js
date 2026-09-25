// Aba CONEXÃO — o que o Gateway expõe: metadados do QR (nunca o valor em log/heartbeat), status enriquecido, perfil da PRÓPRIA conta (sem inventar campo),
// e a desconexão de conta (logout best-effort + reset já existente). Reutiliza a sessão Baileys atual: nenhum segundo mecanismo.
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import express from "express";
import { createServer } from "node:http";
import { criarSessaoBaileys, STATUS_CONEXAO } from "../src/baileysSession.js";
import { exigirHmac, assinarRequisicao } from "../src/hmac.js";
import { criarRotas } from "../src/routes.js";

const AUTH_ID = "11111111-1111-4111-8111-111111111111";
const QR1 = "2@QR-PRIMEIRO-SEGREDO-DE-TESTE,abc,def";
const QR2 = "2@QR-SEGUNDO-SEGREDO-DE-TESTE,ghi,jkl";
const SEGREDO = "s".repeat(32);

function fabricaFalsa(extra = {}) {
  const criados = [];
  const fabrica = () => {
    const socket = Object.assign({
      ev: new EventEmitter(), ws: new EventEmitter(), user: { id: "5511987654321:3@s.whatsapp.net", name: "Crescer Teste" },
      onWhatsApp: mock.fn(async (d) => [{ jid: `${d}@s.whatsapp.net`, exists: true }]),
      profilePictureUrl: mock.fn(async () => "https://pps.whatsapp.net/v/foto.jpg?e=1"),
      fetchStatus: mock.fn(async () => [{ id: "x", status: { status: "Automação de delivery" } }]),
      getBusinessProfile: mock.fn(async () => undefined),
      logout: mock.fn(async () => { socket.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } }); }),
      sendMessage: mock.fn(async () => ({ key: { id: "x" } })), readMessages: mock.fn(async () => {}), end: mock.fn(async () => {}),
    }, extra);
    criados.push(socket); return socket;
  };
  fabrica.criados = criados; return fabrica;
}
function authFalso() {
  let creds = null;
  return {
    async carregar() { return { status: "absent" }; }, inicializarCreds(c) { creds = c; }, invalidarLocal: mock.fn(() => { creds = null; }),
    comoAuthState() { return { creds, keys: { get: async () => ({}), set: async () => {} } }; },
    async aoAtualizarCreds(d) { if (creds) Object.assign(creds, d); else creds = d; },
    async aguardarPersistenciasPendentes() {}, obterAuthSessionIdAtual() { return AUTH_ID; }, cancelarRetries() {},
  };
}
const backendFalso = () => ({
  notificarHeartbeat: mock.fn(async () => {}), notificarMensagemRecebida: mock.fn(async () => {}), notificarStatusProvider: mock.fn(async () => ({ ok: true })),
  definirEstadoDesejado: mock.fn(async () => ({ ok: true })), obterEstadoSessao: mock.fn(async () => ({ status: "DISCONNECTED", desiredConnectionState: "DISCONNECTED" })),
  resetarAuthState: mock.fn(async () => ({ ok: true })), confirmarAuthState: mock.fn(async () => ({})),
});
const leaseFalso = () => ({ souLeader: () => true, contexto: () => ({ gatewayProcessId: "proc", leaseEpoch: 12 }), notificarPerdaExterna: mock.fn(async () => {}) });

async function sessao(extraSocket = {}, { conectar = true, abrir = true } = {}) {
  const fabricaSocket = fabricaFalsa(extraSocket);
  const backendClient = backendFalso(); const auth = authFalso();
  const s = criarSessaoBaileys({
    authAdapter: auth, backendClient, config: { reconnect: { baseMs: 10, tetoMs: 40 }, heartbeatMs: 1_000_000, providerInstanceId: "t", gatewayVersion: "9.9.9", logoutTimeoutMs: 200, perfilTimeoutMs: 200 },
    fabricaSocket, DisconnectReasonLoggedOut: 401, leaseManager: leaseFalso(),
  });
  if (conectar) await s.conectar();
  const socket = fabricaSocket.criados[0];
  if (conectar && abrir) {
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("creds.update", { registered: true });
    await new Promise((r) => setImmediate(r));
  }
  return { s, socket, backendClient, auth, fabricaSocket };
}
async function capturandoLogs(fn) {
  const linhas = []; const ol = console.log; const oe = console.error; const ow = console.warn;
  console.log = (l) => linhas.push(String(l)); console.error = (l) => linhas.push(String(l)); console.warn = (l) => linhas.push(String(l));
  try { await fn(); } finally { console.log = ol; console.error = oe; console.warn = ow; }
  return linhas;
}

describe("QR: metadados, expiração e sigilo", () => {
  test("1º QR vive ~60 s e os seguintes ~20 s; a ordem sobe; o valor só sai por obterQrAtual()", async () => {
    const { s, socket } = await sessao({}, { abrir: false });
    assert.deepEqual(s.infoQr(), { geradoEm: null, expiraEm: null, ordem: 0 });
    socket.ev.emit("connection.update", { qr: QR1 });
    const a = s.infoQr();
    assert.equal(a.ordem, 1); assert.equal(Date.parse(a.expiraEm) - Date.parse(a.geradoEm), 60_000);
    socket.ev.emit("connection.update", { qr: QR2 });
    const b = s.infoQr();
    assert.equal(b.ordem, 2); assert.equal(Date.parse(b.expiraEm) - Date.parse(b.geradoEm), 20_000);
    assert.equal(s.obterQrAtual(), QR2, "o QR novo substitui o anterior");
    assert.ok(!JSON.stringify(s.infoQr()).includes("SEGREDO"), "os metadados nunca trazem o valor");
  });

  test("status enriquecido: aguardando QR ⇒ qrDisponivel; ao conectar o QR DESAPARECE na hora", async () => {
    const { s, socket } = await sessao({}, { abrir: false });
    socket.ev.emit("connection.update", { qr: QR1 });
    let st = await s.getStatus();
    assert.deepEqual([st.status, st.qrDisponivel, st.reconectando], [STATUS_CONEXAO.CONNECTING, true, false]);
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("creds.update", { registered: true });
    await new Promise((r) => setImmediate(r));
    st = await s.getStatus();
    assert.equal(st.qrDisponivel, false);
    assert.equal(s.obterQrAtual(), null);
    assert.deepEqual(s.infoQr(), { geradoEm: null, expiraEm: null, ordem: 0 });
  });

  test("o QR nunca aparece em log nem em nenhum payload enviado ao backend", async () => {
    const ctx = {};
    const logs = await capturandoLogs(async () => {
      const r = await sessao({}, { abrir: false }); Object.assign(ctx, r);
      r.socket.ev.emit("connection.update", { qr: QR1 });
      r.socket.ev.emit("connection.update", { qr: QR2 });
      await new Promise((x) => setImmediate(x));
    });
    assert.ok(!logs.join("\n").includes("SEGREDO"), "log sem QR");
    for (const nome of ["notificarHeartbeat", "definirEstadoDesejado", "notificarMensagemRecebida", "notificarStatusProvider"]) {
      assert.ok(!JSON.stringify(ctx.backendClient[nome].mock.calls.map((c) => c.arguments)).includes("SEGREDO"), nome);
    }
  });

  test("close com QR pendente limpa o QR (ele expira com o socket que o gerou)", async () => {
    const { s, socket } = await sessao({}, { abrir: false });
    socket.ev.emit("connection.update", { qr: QR1 });
    socket.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 408 } } } });
    assert.equal(s.obterQrAtual(), null);
    assert.equal(s.infoQr().ordem, 0);
  });

  test("um fechamento registra o motivo (vocabulário fechado) para a aba", async () => {
    const { s, socket } = await sessao();
    socket.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 428 } } } });
    const st = await s.getStatus();
    assert.equal(typeof st.ultimoFechamento.razao, "string");
    assert.equal(st.ultimoFechamento.codigo, 428);
    assert.ok(Number.isFinite(Date.parse(st.ultimoFechamento.em)));
  });
});

describe("perfilConta() — a própria conta, sem inventar", () => {
  test("mudança de geração durante a consulta descarta o perfil antigo", async () => {
    const r = await sessao();
    let geracao = "geracao-a";
    r.auth.obterAuthSessionIdAtual = () => geracao;
    r.socket.profilePictureUrl = async () => { geracao = "geracao-b"; return null; };
    assert.deepEqual(await r.s.perfilConta(), { disponivel: false, motivo: "sessao_alterada" });
  });
  test("identificador LID numérico nunca é apresentado como telefone", async () => {
    const { s } = await sessao({ user: { id: "123456789012:1@lid", name: "Conta de teste" } });
    assert.equal((await s.perfilConta()).telefoneE164, null);
  });
  test("conectado: nome, número (sem o sufixo de dispositivo), foto https, recado; tipo DESCONHECIDO sem evidência de Business", async () => {
    const { s } = await sessao();
    const p = await s.perfilConta();
    assert.deepEqual([p.disponivel, p.nome, p.telefoneE164, p.fotoUrl, p.descricao, p.tipoConta],
      [true, "Crescer Teste", "+5511987654321", "https://pps.whatsapp.net/v/foto.jpg?e=1", "Automação de delivery", "DESCONHECIDO"]);
  });

  test("Business só com evidência (perfil comercial devolvido ou verifiedName)", async () => {
    const a = await (await sessao({ getBusinessProfile: mock.fn(async () => ({ description: "Loja oficial" })) })).s.perfilConta();
    assert.equal(a.tipoConta, "BUSINESS");
    const b = await (await sessao({ user: { id: "5511987654321:1@s.whatsapp.net", verifiedName: "Empresa Verificada" } })).s.perfilConta();
    assert.deepEqual([b.tipoConta, b.nome], ["BUSINESS", "Empresa Verificada"]);
  });

  test("foto/recado indisponíveis ou lentos ⇒ null (nada inventado), sem lançar", async () => {
    const semNada = await (await sessao({
      profilePictureUrl: mock.fn(async () => { throw Object.assign(new Error("x"), { data: 404 }); }), fetchStatus: mock.fn(async () => { throw new Error("boom"); }),
      getBusinessProfile: mock.fn(() => new Promise(() => {})),
    })).s.perfilConta();
    assert.deepEqual([semNada.disponivel, semNada.fotoUrl, semNada.descricao, semNada.tipoConta], [true, null, null, "DESCONHECIDO"]);
    const foraDoAr = await (await sessao({ profilePictureUrl: mock.fn(async () => "http://inseguro/x.jpg") })).s.perfilConta();
    assert.equal(foraDoAr.fotoUrl, null, "só https");
  });

  test("API ausente no socket (versão sem fetchStatus/getBusinessProfile) ⇒ campos null, sem lançar", async () => {
    const r = await sessao({ fetchStatus: undefined, getBusinessProfile: undefined, profilePictureUrl: undefined });
    const p = await r.s.perfilConta();
    assert.deepEqual([p.disponivel, p.fotoUrl, p.descricao], [true, null, null]);
  });

  test("desconectado ⇒ { disponivel:false, motivo }; nunca devolve credencial/chave", async () => {
    const semConexao = await sessao({}, { conectar: false });
    assert.deepEqual(await semConexao.s.perfilConta(), { disponivel: false, motivo: "nao_conectado" });
    const { s } = await sessao();
    const txt = JSON.stringify(await s.perfilConta());
    assert.ok(!/creds|noise|signal|identityKey|privateKey|token|secret/i.test(txt));
  });
});

describe("desconectarConta()", () => {
  test("conectado: chama logout() UMA vez e depois o reset (auth do Gateway invalidado, desired=DISCONNECTED)", async () => {
    const { s, socket, backendClient, auth } = await sessao();
    const r = await s.desconectarConta();
    assert.deepEqual(r, { ok: true, desvinculado: true });
    assert.equal(socket.logout.mock.callCount(), 1);
    assert.ok(backendClient.definirEstadoDesejado.mock.calls.some((c) => c.arguments[0].desiredConnectionState === "DISCONNECTED"));
    assert.equal(backendClient.resetarAuthState.mock.callCount(), 1);
    assert.equal(auth.invalidarLocal.mock.callCount(), 1);
    assert.equal((await s.getStatus()).status, STATUS_CONEXAO.DISCONNECTED);
  });

  test("logout rejeitado já assentado permite reset; logout pendente NÃO permite avançar a sessão", async () => {
    const falha = await sessao({ logout: mock.fn(async () => { throw new Error("rede"); }) });
    assert.deepEqual(await falha.s.desconectarConta(), { ok: true, desvinculado: false });
    assert.equal(falha.backendClient.resetarAuthState.mock.callCount(), 1);
    const lento = await sessao({ logout: mock.fn(() => new Promise(() => {})) });
    await assert.rejects(() => lento.s.desconectarConta(), (e) => e.logoutPendente === true);
    assert.equal(lento.backendClient.resetarAuthState.mock.callCount(), 0);
  });

  test("desvincular:false apenas reseta (não chama logout); sem conexão também não chama logout", async () => {
    const a = await sessao();
    await a.s.desconectarConta({ desvincular: false });
    assert.equal(a.socket.logout.mock.callCount(), 0);
    const b = await sessao({}, { conectar: false });
    await b.s.desconectarConta();
    assert.equal(b.backendClient.resetarAuthState.mock.callCount(), 1);
  });

  test("não apaga nada do histórico: o Gateway nem conhece o histórico (só chama auth/desired/heartbeat)", async () => {
    const { s, backendClient } = await sessao();
    await s.desconectarConta();
    const chamados = Object.entries(backendClient).filter(([, f]) => f.mock?.callCount() > 0).map(([n]) => n).sort();
    assert.ok(chamados.every((n) => ["definirEstadoDesejado", "notificarHeartbeat", "resetarAuthState", "confirmarAuthState", "obterEstadoSessao"].includes(n)), chamados.join(","));
  });
});

describe("rotas HMAC da Conexão", () => {
  let servidor; let baseUrl; let falsa;
  before(async () => {
    falsa = {
      obterQrAtual: mock.fn(() => QR1), infoQr: mock.fn(() => ({ geradoEm: "2026-09-24T12:00:00.000Z", expiraEm: "2026-09-24T12:01:00.000Z", ordem: 1 })),
      perfilConta: mock.fn(async () => ({ disponivel: true, nome: "X", telefoneE164: "+5511987654321", fotoUrl: null, descricao: null, tipoConta: "DESCONHECIDO" })),
      desconectarConta: mock.fn(async () => ({ ok: true, desvinculado: true })),
    };
    const app = express();
    app.use("/internal", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), criarRotas(falsa));
    await new Promise((r) => { servidor = createServer(app).listen(0, () => r()); });
    baseUrl = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(() => servidor.close());
  const chamar = (metodo, caminho, corpoObj, { assinar = true } = {}) => {
    const corpo = corpoObj === undefined ? "" : JSON.stringify(corpoObj);
    const headers = assinar ? assinarRequisicao({ segredo: SEGREDO, metodo, caminho, corpo }) : {};
    if (corpo) headers["Content-Type"] = "application/json";
    return fetch(`${baseUrl}${caminho}`, { method: metodo, headers, body: corpo || undefined });
  };

  test("GET /whatsapp/qr: qr + metadados, sem cache", async () => {
    const r = await chamar("GET", "/internal/whatsapp/qr");
    assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
    const corpo = await r.json();
    assert.match(corpo.svg, /^<svg /, "o QR já vem desenhado (SVG) para a aba Conexão");
    const { svg, ...resto } = corpo;
    assert.deepEqual(resto, { qr: QR1, geradoEm: "2026-09-24T12:00:00.000Z", expiraEm: "2026-09-24T12:01:00.000Z", ordem: 1 });
    assert.ok(!svg.includes("PRIMEIRO-SEGREDO"), "o SVG não carrega o texto cru");
  });

  test("GET /whatsapp/perfil e POST /whatsapp/desconectar-conta funcionam com HMAC; desvincular:false é respeitado", async () => {
    const p = await chamar("GET", "/internal/whatsapp/perfil");
    assert.equal(p.status, 200); assert.equal((await p.json()).nome, "X"); assert.equal(p.headers.get("cache-control"), "no-store");
    const d = await chamar("POST", "/internal/whatsapp/desconectar-conta", {});
    assert.deepEqual(await d.json(), { ok: true, desvinculado: true });
    assert.deepEqual(falsa.desconectarConta.mock.calls.at(-1).arguments[0], { desvincular: true });
    await chamar("POST", "/internal/whatsapp/desconectar-conta", { desvincular: false });
    assert.deepEqual(falsa.desconectarConta.mock.calls.at(-1).arguments[0], { desvincular: false });
  });

  test("SEM HMAC as três rotas são recusadas e a sessão nunca é tocada", async () => {
    const antes = [falsa.obterQrAtual, falsa.perfilConta, falsa.desconectarConta].map((f) => f.mock.callCount());
    for (const [m, c] of [["GET", "/internal/whatsapp/qr"], ["GET", "/internal/whatsapp/perfil"], ["POST", "/internal/whatsapp/desconectar-conta"]]) {
      const r = await chamar(m, c, m === "POST" ? {} : undefined, { assinar: false });
      assert.ok([401, 403].includes(r.status), `${m} ${c}`);
    }
    assert.deepEqual([falsa.obterQrAtual, falsa.perfilConta, falsa.desconectarConta].map((f) => f.mock.callCount()), antes);
  });
});
