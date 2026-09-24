// GATE DE CONTA CONFIRMADA — "CONNECTED sozinho NÃO basta". Cobre TODOS os caminhos que podem chamar o provider: política do worker, WhatsAppService (o único chamador),
// teste controlado, worker embutido e a regra de identidade em si (vinculada ao hash da conta concreta). Sem rede, sem banco real (o Postgres real é coberto em central-postgres-real.test.js).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { avaliarEnvio } from "../src/modules/comunicacao/comunicacao.policy.js";
import { MODOS, MOTIVOS_BLOQUEIO, bloqueioEhTransitorio } from "../src/modules/comunicacao/comunicacao.constants.js";
import { criarWhatsAppService, IdentidadeNaoConfirmadaError } from "../src/modules/comunicacao/whatsapp.service.js";
import { identidadeConfirmada, resumoIdentidade, hashTelefone, criarGateIdentidade } from "../src/modules/comunicacao/comunicacao.identidade.js";
import { criarFakeDb } from "./helpers/central-fake-db.js";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const AGORA = new Date("2026-09-24T15:00:00.000Z");
const seg = (n) => new Date(AGORA.getTime() + n * 1000).toISOString();
const TEL_A = "+5511987654321";
const TEL_B = "+5511911112222";

const BASE = (o = {}) => ({
  modo: MODOS.NORMAL, ehProativo: true, contatoExiste: true, telefoneVerificado: true, optOut: false, consentimento: true, destinatarioAtivo: true, vinculoValido: true,
  empresaHabilitada: true, tipoPermitido: true, empresaPausada: false, configHorarioValida: true, pendenciaAindaExiste: true, duplicado: false, cooldownAtivo: false,
  dentroDaJanela: true, rateLimitExcedido: false, providerConectado: true, identidadeConfirmada: true, telefoneNaAllowlistPiloto: true, ...o,
});

function providerFalso() {
  const chamadas = [];
  const p = {
    async connect() {}, async disconnect() {}, async getStatus() { return { conectado: true }; },
    async sendText(a) { chamadas.push(["texto", a]); return { providerMessageId: "P1" }; },
    async sendImage(a) { chamadas.push(["imagem", a]); return { providerMessageId: "P2" }; },
    async sendDocument(a) { chamadas.push(["documento", a]); return { providerMessageId: "P3" }; },
    onMessage() {}, async markAsRead() {}, async getMessageStatus() { return { status: "SENT" }; },
  };
  return { p, chamadas };
}
const envio = { telefoneE164: TEL_A, texto: "oi", urlImagem: "https://x.invalid/a.png", urlDocumento: "https://x.invalid/a.pdf", idempotencyKey: "k1" };

describe("política: identidadeConfirmada é obrigatória (fail-closed, proativo E reativo)", () => {
  test("liberada só com identidadeConfirmada === true", () => {
    assert.deepEqual(avaliarEnvio(BASE()), { allowed: true, reason: null });
  });
  test("false, ausente, null, 'true', 1 ⇒ IDENTIDADE_NAO_CONFIRMADA", () => {
    for (const v of [false, undefined, null, "true", 1, {}]) {
      const r = avaliarEnvio(BASE({ identidadeConfirmada: v }));
      assert.deepEqual([r.allowed, r.reason], [false, MOTIVOS_BLOQUEIO.IDENTIDADE_NAO_CONFIRMADA], String(v));
    }
    const semCampo = BASE(); delete semCampo.identidadeConfirmada;
    assert.equal(avaliarEnvio(semCampo).reason, MOTIVOS_BLOQUEIO.IDENTIDADE_NAO_CONFIRMADA);
  });
  test("vale também para resposta reativa (ehProativo=false) — nenhum envio escapa", () => {
    const r = avaliarEnvio(BASE({ ehProativo: false, modo: MODOS.REACTIVE_ONLY, identidadeConfirmada: false }));
    assert.equal(r.allowed, false);
  });
  test("é bloqueio TRANSITÓRIO (adia sem consumir tentativa), não terminal", () => {
    assert.equal(bloqueioEhTransitorio(MOTIVOS_BLOQUEIO.IDENTIDADE_NAO_CONFIRMADA), true);
  });
  test("provider offline continua tendo precedência (motivo mais específico primeiro)", () => {
    assert.equal(avaliarEnvio(BASE({ providerConectado: false, identidadeConfirmada: false })).reason, MOTIVOS_BLOQUEIO.PROVIDER_OFFLINE);
  });
});

describe("WhatsAppService: nenhum envio chega ao provider sem conta confirmada (provider = 0)", () => {
  test("sem gate injetado ⇒ FAIL-CLOSED: texto, imagem e documento são recusados", async () => {
    const { p, chamadas } = providerFalso();
    const s = criarWhatsAppService({ provider: p });
    for (const f of [() => s.enviarTexto(envio), () => s.enviarImagem(envio), () => s.enviarDocumento(envio)]) await assert.rejects(f, IdentidadeNaoConfirmadaError);
    assert.equal(chamadas.length, 0);
    assert.equal(await s.identidadeConfirmada(), false);
  });
  test("gate false / lança / devolve valor não-booleano ⇒ recusa, provider = 0", async () => {
    for (const gate of [async () => false, async () => { throw new Error("banco fora"); }, async () => "true", async () => 1, async () => undefined, () => null]) {
      const { p, chamadas } = providerFalso();
      const s = criarWhatsAppService({ provider: p, identidadeConfirmada: gate });
      await assert.rejects(() => s.enviarTexto(envio), (e) => e instanceof IdentidadeNaoConfirmadaError && e.code === "CONEXAO_NAO_CONFIRMADA");
      assert.equal(chamadas.length, 0);
    }
  });
  test("gate true ⇒ exatamente UMA chamada ao provider por envio", async () => {
    const { p, chamadas } = providerFalso();
    const s = criarWhatsAppService({ provider: p, identidadeConfirmada: async () => true });
    await s.enviarTexto(envio); await s.enviarImagem(envio); await s.enviarDocumento(envio);
    assert.deepEqual(chamadas.map((c) => c[0]), ["texto", "imagem", "documento"]);
  });
  test("o gate é reavaliado A CADA envio (troca de conta no meio de um lote bloqueia o resto)", async () => {
    const { p, chamadas } = providerFalso(); let ok = true;
    const s = criarWhatsAppService({ provider: p, identidadeConfirmada: async () => ok });
    await s.enviarTexto(envio); ok = false;
    await assert.rejects(() => s.enviarTexto(envio), IdentidadeNaoConfirmadaError);
    assert.equal(chamadas.length, 1);
  });
  test("a recusa ocorre ANTES de qualquer efeito colateral no provider (não chama nem getStatus/connect)", async () => {
    const { p } = providerFalso(); let tocou = 0;
    const p2 = new Proxy(p, { get: (t, k) => (typeof t[k] === "function" ? (...a) => { tocou += 1; return t[k](...a); } : t[k]) });
    const s = criarWhatsAppService({ provider: p2, identidadeConfirmada: async () => false });
    const antes = tocou;
    await assert.rejects(() => s.enviarTexto(envio), IdentidadeNaoConfirmadaError);
    assert.equal(tocou, antes);
  });
  test("semGateIdentidade só existe em TESTES: nenhum arquivo de produção o usa", () => {
    const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const arquivos = []; const varrer = (d) => { for (const n of readdirSync(d)) { const c = join(d, n); statSync(c).isDirectory() ? varrer(c) : c.endsWith(".js") && arquivos.push(c); } };
    varrer(raiz);
    const semComentarios = (t) => t.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join(" ");
    const usos = arquivos.filter((a) => /semGateIdentidade\s*:\s*true/.test(semComentarios(readFileSync(a, "utf8"))));
    assert.deepEqual(usos, [], "código de produção não pode desligar o gate de identidade");
  });
  test("as factories de PRODUÇÃO (ambiente, worker embutido, worker standalone) injetam o gate", () => {
    const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    for (const rel of ["modules/comunicacao/comunicacao.teste.js", "worker-comunicacao/lifecycle.js", "worker-comunicacao/index.js"]) {
      const cod = readFileSync(join(raiz, rel), "utf8");
      assert.match(cod, /identidadeConfirmada:\s*criarGate(Identidade)?\(/, `${rel} precisa injetar o gate`);
    }
  });
});

describe("regra de identidade: vinculada à CONTA concreta (hash), não a um booleano", () => {
  const conexao = (o = {}) => ({ organizacao_id: ORG, provider_instance_id: "default", status: "CONNECTED", telefone_e164: TEL_A, last_seen_at: seg(-20), ...o });
  const identidade = (o = {}) => ({ organizacao_id: ORG, provider_instance_id: "default", status: "CONFIRMADA", telefone_hash: hashTelefone(TEL_A), confirmado_em: seg(-3600), nome_operacional: "Agente Crescer", ...o });
  const deps = (con, ident, extra = {}) => ({ supabase: criarFakeDb({ whatsapp_conexoes: con ? [con] : [], whatsapp_identidade: ident ? [ident] : [] }), env: {}, agora: () => AGORA, organizacaoConexaoId: ORG, ...extra });

  test("conectada + MESMA conta confirmada ⇒ confirmada", async () => {
    assert.equal(await identidadeConfirmada(deps(conexao(), identidade())), true);
  });
  test("restart da MESMA conta (cai e volta, mesmo número) ⇒ a confirmação é preservada", async () => {
    assert.equal(await identidadeConfirmada(deps(conexao({ status: "CONNECTING" }), identidade())), false, "durante o restart: bloqueado");
    assert.equal(await identidadeConfirmada(deps(conexao({ status: "CONNECTED", last_seen_at: seg(-5) }), identidade())), true, "voltou: confirmada de novo, sem reconfirmar");
  });
  test("CONTA DIFERENTE conectada (hash difere) ⇒ NÃO confirmada, mesmo CONNECTED e com registro CONFIRMADA antigo", async () => {
    const r = await resumoIdentidade(deps(conexao({ telefone_e164: TEL_B }), identidade()));
    assert.deepEqual([r.confirmada, r.status], [false, "PENDENTE_CONFIRMACAO"]);
    assert.equal(r.nomeOperacional, null, "o nome operacional não vale para outra conta");
  });
  test("CONNECTED com identidade PENDENTE_CONFIRMACAO ⇒ bloqueado", async () => {
    assert.equal(await identidadeConfirmada(deps(conexao(), identidade({ status: "PENDENTE_CONFIRMACAO", confirmado_em: null }))), false);
  });
  test("CONNECTED sem nenhum registro de identidade ⇒ bloqueado (CONNECTED sozinho não basta)", async () => {
    assert.equal(await identidadeConfirmada(deps(conexao(), null)), false);
  });
  test("durante WAITING_QR / CONNECTING / RECONNECTING / troca de conta / desconectado / sessão inválida ⇒ provider = 0", async () => {
    for (const status of ["CONNECTING", "DISCONNECTED", "LOGGED_OUT"]) assert.equal(await identidadeConfirmada(deps(conexao({ status }), identidade())), false, status);
    assert.equal(await identidadeConfirmada(deps(conexao({ status: "CONNECTING", telefone_e164: null }), identidade({ status: "SEM_CONTA", telefone_hash: null, confirmado_em: null }))), false, "troca de conta em andamento");
  });
  test("heartbeat velho (>2 min) ⇒ não é 'conectado por inércia'", async () => {
    assert.equal(await identidadeConfirmada(deps(conexao({ last_seen_at: seg(-600) }), identidade())), false);
  });
  test("depois de DESCONECTAR (identidade zerada) ⇒ bloqueado; histórico não é tocado pela regra", async () => {
    assert.equal(await identidadeConfirmada(deps(conexao({ status: "DISCONNECTED" }), identidade({ status: "SEM_CONTA", telefone_hash: null, confirmado_em: null }))), false);
  });
  test("fail-closed: sem organização, sem banco ou erro de leitura ⇒ false (nunca lança)", async () => {
    assert.equal(await identidadeConfirmada({ supabase: criarFakeDb({}), env: {}, agora: () => AGORA }), false, "sem org");
    assert.equal(await identidadeConfirmada({ supabase: { from: () => { throw new Error("boom"); } }, env: {}, organizacaoConexaoId: ORG, agora: () => AGORA }), false, "erro");
  });
  test("multi-tenant: a confirmação da organização B nunca vale para a A", async () => {
    const outra = "00000000-0000-4000-8000-0000000000b2";
    const d = deps(conexao(), identidade({ organizacao_id: outra }));
    assert.equal(await identidadeConfirmada(d), false);
  });
  test("o hash NUNCA contém o telefone e é sha256 hex", () => {
    const h = hashTelefone(TEL_A);
    assert.match(h, /^[0-9a-f]{64}$/); assert.ok(!h.includes("5511987654321"));
  });
  test("criarGateIdentidade devolve uma função que integra com o WhatsAppService (ponta a ponta)", async () => {
    const { p, chamadas } = providerFalso();
    const ok = criarWhatsAppService({ provider: p, identidadeConfirmada: criarGateIdentidade(deps(conexao(), identidade())) });
    const bloq = criarWhatsAppService({ provider: p, identidadeConfirmada: criarGateIdentidade(deps(conexao({ telefone_e164: TEL_B }), identidade())) });
    await ok.enviarTexto(envio);
    await assert.rejects(() => bloq.enviarTexto(envio), IdentidadeNaoConfirmadaError);
    assert.equal(chamadas.length, 1);
  });
});
