// OTP pelo Baileys — HOMOLOGAÇÃO SINTÉTICA: provider falso do projeto + whatsapp.service REAL (kill switch e gate de identidade), reservas
// em memória, nenhuma rede, nenhum envio real. A prova de banco (concorrência, cota, prioridade do D-1) está em testes-seguros/pg/otp_baileys_138.sh.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import express from "express";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.NOTIFICACOES_SEGREDO_MESTRE = "segredo-de-teste-da-central-0123456789abcdef";
const otp = await import("../src/modules/comunicacao/comunicacao.otp.js");
const envio = await import("../src/modules/notificacoes/notificacoes.envio.js");
const seg = await import("../src/modules/notificacoes/notificacoes.segredos.js");
const basico = await import("../src/modules/notificacoes/notificacoes.basico.js");
const titular = await import("../src/modules/notificacoes/notificacoes.titular.service.js");
const { criarWhatsAppService } = await import("../src/modules/comunicacao/whatsapp.service.js");
const { criarFakeProvider } = await import("../src/modules/comunicacao/providers/fake.provider.js");
const { ApiError } = await import("../src/shared/ApiError.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const NUM = "+5511912345678";
const GW = { WHATSAPP_GATEWAY_URL: "http://127.0.0.1:9", WHATSAPP_GATEWAY_SECRET: "segredo-gateway-ficticio" };
const BAILEYS = { NOTIFICACOES_OTP_TRANSPORTE: "baileys", NOTIFICACOES_OTP_BAILEYS_AUTORIZADO: "true", NODE_ENV: "production", ...GW };

/** Reservas em memória com a MESMA semântica do banco (dedupe por desafio, estado final imutável). */
function repoFalso({ resultado = "RESERVADO", falhaReserva = false } = {}) {
  const linhas = new Map(); const chamadas = [];
  return {
    linhas, chamadas,
    reservarEnvioOtp: async (p) => { chamadas.push(["reservar", p.desafioId]); if (falhaReserva) throw new Error("db fora"); if (linhas.has(p.desafioId)) return "JA_RESERVADO"; if (resultado === "RESERVADO") linhas.set(p.desafioId, { status: "ENVIANDO" }); return resultado; },
    registrarResultadoOtp: async (p) => { const l = linhas.get(p.desafioId); if (!l || l.status !== "ENVIANDO") return false; Object.assign(l, { status: p.status, motivo: p.motivo }); return true; },
  };
}
const servicoComFake = (opts = {}) => {
  const provider = criarFakeProvider(opts.provider);
  const servico = criarWhatsAppService({ provider, semGateIdentidade: opts.semGateIdentidade ?? true, modoAtual: async () => opts.modo ?? "NORMAL" });
  return { provider, servico };
};
const enviar = (desafioId, ctx, extra = {}) => otp.enviarOtpBaileys({ desafioId, telefoneE164: NUM, codigo: "654321" }, { env: BAILEYS, repo: ctx.repo, obterServico: async () => ctx.servico, timeoutMs: 300, ...extra });

describe("modo baileys: desligado por padrão; três condições", () => {
  test("exige NOTIFICACOES_OTP_TRANSPORTE=baileys + AUTORIZADO=true + gateway configurado; qualquer falta → desligado", () => {
    assert.equal(envio.modoTransporte(BAILEYS), "baileys");
    assert.equal(envio.modoTransporte({ ...BAILEYS, NOTIFICACOES_OTP_BAILEYS_AUTORIZADO: undefined }), "desligado");
    assert.equal(envio.modoTransporte({ ...BAILEYS, WHATSAPP_GATEWAY_URL: "" }), "desligado");
    assert.equal(envio.modoTransporte({ ...BAILEYS, WHATSAPP_GATEWAY_SECRET: " " }), "desligado");
    assert.equal(envio.modoTransporte({ NOTIFICACOES_OTP_TRANSPORTE: "baileys", ...GW }), "desligado");
    assert.equal(envio.modoTransporte({}), "desligado");
    assert.deepEqual(envio.capacidades(BAILEYS), { modo: "baileys", otp: true, simulado: false, envioReal: true });
  });
});

describe("envio: fila lógica, deduplicação e classificação de falhas", () => {
  test("sucesso: 1 envio pelo whatsapp.service, chave otp:<desafio>, texto com o código, reserva vira ENVIADO", async () => {
    const ctx = { repo: repoFalso(), ...servicoComFake() };
    const r = await enviar("d-ok", ctx);
    assert.deepEqual([r.entregue, r.motivo], [true, null]);
    assert.equal(ctx.provider.mensagensEnviadas.length, 1);
    const m = ctx.provider.mensagensEnviadas[0];
    assert.deepEqual([m.idempotencyKey, m.telefoneE164, /654321/.test(m.texto), /5 minutos/.test(m.texto)], ["otp:d-ok", NUM, true, true]);
    assert.equal(ctx.repo.linhas.get("d-ok").status, "ENVIADO");
  });
  test("o mesmo desafio nunca envia duas vezes (inclusive chamadas simultâneas = duas instâncias)", async () => {
    const ctx = { repo: repoFalso(), ...servicoComFake() };
    const rs = await Promise.all(Array.from({ length: 6 }, () => enviar("d-dup", ctx)));
    assert.equal(rs.filter((r) => r.entregue).length, 1);
    assert.ok(rs.filter((r) => !r.entregue).every((r) => r.motivo === "JA_ENVIADO"));
    assert.equal(ctx.provider.mensagensEnviadas.length, 1);
  });
  test("cota própria, saturação e prioridade do D-1: NADA sai e o motivo é fixo", async () => {
    for (const [resultado, motivo] of [["LIMITE_ATINGIDO", "LIMITE_OTP"], ["SATURADO", "SATURADO"], ["ADIADO_PRIORIDADE_D1", "PRIORIDADE_D1"]]) {
      const ctx = { repo: repoFalso({ resultado }), ...servicoComFake() };
      const r = await enviar(`d-${resultado}`, ctx);
      assert.deepEqual([r.entregue, r.motivo, ctx.provider.mensagensEnviadas.length], [false, motivo, 0]);
    }
  });
  test("sem reserva (banco fora) ou resposta desconhecida → fail-closed, nada sai", async () => {
    const a = { repo: repoFalso({ falhaReserva: true }), ...servicoComFake() };
    assert.deepEqual([(await enviar("d-x", a)).motivo, a.provider.mensagensEnviadas.length], ["RESERVA_INDISPONIVEL", 0]);
    const b = { repo: repoFalso({ resultado: "QUALQUER" }), ...servicoComFake() };
    assert.deepEqual([(await enviar("d-y", b)).motivo, b.provider.mensagensEnviadas.length], ["RESERVA_INDISPONIVEL", 0]);
  });
  test("kill switch: modo DISABLED e conta não confirmada bloqueiam ANTES do provider (FALHOU, nada sai)", async () => {
    const a = { repo: repoFalso(), ...servicoComFake({ modo: "DISABLED" }) };
    assert.deepEqual([(await enviar("d-k", a)).motivo, a.provider.mensagensEnviadas.length, a.repo.linhas.get("d-k").status], ["MODO_DESABILITADO", 0, "FALHOU"]);
    const b = { repo: repoFalso(), ...servicoComFake({ semGateIdentidade: false }) };
    assert.deepEqual([(await enviar("d-i", b)).motivo, b.provider.mensagensEnviadas.length], ["CONEXAO_NAO_CONFIRMADA", 0]);
  });
  test("gateway não configurado → FALHOU sem chamar nada", async () => {
    const repo = repoFalso();
    const r = await otp.enviarOtpBaileys({ desafioId: "d-g", telefoneE164: NUM, codigo: "654321" }, { env: BAILEYS, repo, obterServico: async () => null });
    assert.deepEqual([r.entregue, r.motivo, repo.linhas.get("d-g").status], [false, "GATEWAY_NAO_CONFIGURADO", "FALHOU"]);
  });
  test("desconexão (provado pré-envio) → FALHOU; número sem WhatsApp → FALHOU permanente; ambos sem repetição", async () => {
    const a = { repo: repoFalso(), ...servicoComFake() };
    a.provider.falharProximoEnvio({ mensagem: "WHATSAPP_GATEWAY_NOT_CONNECTED", preEnvio: true });
    const ra = await enviar("d-desc", a);
    assert.deepEqual([ra.entregue, ra.motivo, a.repo.linhas.get("d-desc").status, ra.incerta], [false, "GATEWAY_DESCONECTADO", "FALHOU", undefined]);
    const b = { repo: repoFalso(), ...servicoComFake() };
    b.provider.falharProximoEnvio({ mensagem: "WHATSAPP_GATEWAY_RECIPIENT_NOT_ON_WHATSAPP", preEnvio: true, permanente: true });
    const rb = await enviar("d-sem", b);
    assert.deepEqual([rb.entregue, rb.motivo], [false, "NUMERO_SEM_WHATSAPP"]);
  });
  test("resultado incerto (erro desconhecido ou timeout) → INCERTO, o desafio segue válido, NUNCA reenvio automático", async () => {
    const a = { repo: repoFalso(), ...servicoComFake() };
    a.provider.falharProximoEnvio({ mensagem: "socket hang up" });
    const ra = await enviar("d-inc", a);
    assert.deepEqual([ra.entregue, ra.incerta, ra.motivo, a.repo.linhas.get("d-inc").status], [true, true, "ENTREGA_INCERTA", "INCERTO"]);
    assert.equal((await enviar("d-inc", a)).motivo, "JA_ENVIADO", "repetir o mesmo desafio não reenvia");
    const lento = { repo: repoFalso(), servico: { enviarTexto: () => new Promise(() => {}) } };
    const rl = await enviar("d-timeout", lento, { timeoutMs: 40 });
    assert.deepEqual([rl.entregue, rl.incerta, lento.repo.linhas.get("d-timeout").status], [true, true, "INCERTO"]);
  });
  test("resultado nunca sobrescreve um estado final; falha ao gravar o resultado não derruba o envio", async () => {
    const ctx = { repo: repoFalso(), ...servicoComFake() };
    await enviar("d-fin", ctx);
    assert.equal(await ctx.repo.registrarResultadoOtp({ desafioId: "d-fin", status: "FALHOU", motivo: "X" }), false);
    const quebrado = { ...repoFalso(), registrarResultadoOtp: async () => { throw new Error("db fora"); } };
    const r = await enviar("d-q", { repo: quebrado, ...servicoComFake() });
    assert.equal(r.entregue, true);
  });
  test("lista autorizada (homologação real): número fora da lista é recusado ANTES de qualquer reserva ou envio", async () => {
    const ctx = { repo: repoFalso(), ...servicoComFake() };
    const env = { ...BAILEYS, NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164: "+5511900000001, +5511900000002" };
    const r = await otp.enviarOtpBaileys({ desafioId: "d-al", telefoneE164: NUM, codigo: "654321" }, { env, repo: ctx.repo, obterServico: async () => ctx.servico });
    assert.deepEqual([r.motivo, ctx.repo.chamadas.length, ctx.provider.mensagensEnviadas.length], ["FORA_DA_LISTA_AUTORIZADA", 0, 0]);
    const ok = await otp.enviarOtpBaileys({ desafioId: "d-al2", telefoneE164: "+5511900000002", codigo: "654321" }, { env, repo: ctx.repo, obterServico: async () => ctx.servico });
    assert.equal(ok.entregue, true);
  });
  test("dados inválidos nunca chegam ao banco nem ao provider", async () => {
    const ctx = { repo: repoFalso(), ...servicoComFake() };
    for (const p of [{ telefoneE164: NUM, codigo: "12" }, { telefoneE164: "5511912345678", codigo: "123456" }, { telefoneE164: "+1", codigo: "123456" }])
      assert.equal((await otp.enviarOtpBaileys({ desafioId: "d-v", ...p }, { env: BAILEYS, repo: ctx.repo, obterServico: async () => ctx.servico })).motivo, "DADOS_INVALIDOS");
    assert.deepEqual([ctx.repo.chamadas.length, ctx.provider.mensagensEnviadas.length], [0, 0]);
  });
  test("limites do ambiente: valores inválidos voltam ao padrão seguro", () => {
    assert.deepEqual(otp.limitesDoAmbiente({}), { maxHora: 30, maxDia: 150, maxSimultaneos: 3 });
    assert.deepEqual(otp.limitesDoAmbiente({ NOTIFICACOES_OTP_MAX_HORA: "abc", NOTIFICACOES_OTP_MAX_DIA: "-1", NOTIFICACOES_OTP_MAX_SIMULTANEOS: "999" }), { maxHora: 30, maxDia: 150, maxSimultaneos: 3 });
    assert.deepEqual(otp.limitesDoAmbiente({ NOTIFICACOES_OTP_MAX_HORA: "5" }).maxHora, 5);
  });
});

describe("entregarCodigoOtp no modo baileys: logs sem número, código ou segredo", () => {
  test("decifra o número só aqui, repassa o E.164 em memória e registra apenas desafio/motivo", async () => {
    const logs = []; const o = { log: console.log, warn: console.warn }; console.log = (...a) => logs.push(a.join(" ")); console.warn = console.log;
    let recebido;
    try {
      const r = await envio.entregarCodigoOtp({ desafioId: "des-1", telefoneCifrado: seg.cifrarTelefone(NUM), telefoneHmac: seg.hmacTelefone(NUM), codigo: "654321" },
        { env: BAILEYS, enviarBaileys: async (p) => { recebido = p; return { entregue: false, motivo: "PRIORIDADE_D1" }; } });
      assert.deepEqual([r.entregue, r.motivo], [false, "PRIORIDADE_D1"]);
    } finally { console.log = o.log; console.warn = o.warn; }
    assert.deepEqual([recebido.telefoneE164, recebido.codigo], [NUM, "654321"]);
    const tudo = logs.join("\n");
    assert.ok(tudo.includes("des-1") && tudo.includes("PRIORIDADE_D1"));
    assert.ok(!tudo.includes("654321") && !tudo.includes("5511912345678") && !tudo.includes("segredo-gateway"), "sem código, número ou segredo no log");
  });
  test("desligado: nada é chamado", async () => {
    let n = 0;
    const r = await envio.entregarCodigoOtp({ desafioId: "des-2", telefoneCifrado: seg.cifrarTelefone(NUM), telefoneHmac: "h", codigo: "654321" }, { env: { ...BAILEYS, NOTIFICACOES_OTP_BAILEYS_AUTORIZADO: "false" }, enviarBaileys: async () => { n++; return { entregue: true }; } });
    assert.deepEqual([r.entregue, r.motivo, n], [false, "TRANSPORTE_DESLIGADO", 0]);
  });
});

describe("titular: cota/prioridade viram 'aguarde', nunca 'erro'; consentimento segue separado", () => {
  function montar() {
    const token = basico.gerarToken(); const desafios = [];
    const convite = { id: randomUUID(), organizacao_id: "00000000-0000-4000-8000-00000000a001", nome: "Carla", telefone_cifrado: seg.cifrarTelefone(NUM), telefone_hmac: seg.hmacTelefone(NUM),
      unidades_pretendidas: ["u1"], categorias_pretendidas: ["pendencia_d1"], status: "PENDENTE", expira_em: new Date(Date.now() + 3_600_000).toISOString(), token_hash: basico.hashToken(token) };
    const repo = { obterConvitePorToken: async (h) => (h === convite.token_hash ? convite : null),
      criarDesafio: async (p) => { const d = { id: p.id ?? randomUUID() }; desafios.push(d); return { resultado: "CRIADO", desafio_id: d.id }; } };
    return { repo, token, desafios };
  }
  test("PRIORIDADE_D1/SATURADO → AGUARDE; LIMITE_OTP → LIMITE; outras falhas → INDISPONIVEL; sucesso → ok sem código", async () => {
    for (const [motivo, esperado] of [["PRIORIDADE_D1", "AGUARDE"], ["SATURADO", "AGUARDE"], ["LIMITE_OTP", "LIMITE"], ["GATEWAY_DESCONECTADO", "INDISPONIVEL"]]) {
      const { repo, token } = montar();
      const r = await titular.pedirCodigoConvite({ token, ip: "1.1.1.1", deps: { repo, auditar: async () => {}, env: BAILEYS, entregarCodigoOtp: async () => ({ entregue: false, motivo }) } });
      assert.deepEqual([r.ok, r.motivo], [false, esperado], motivo);
    }
    const { repo, token } = montar();
    const ok = await titular.pedirCodigoConvite({ token, ip: "1.1.1.1", deps: { repo, auditar: async () => {}, env: BAILEYS, entregarCodigoOtp: async () => ({ entregue: true, incerta: true }) } });
    assert.equal(ok.ok, true); assert.ok(!("codigo" in ok));
  });
  test("termo em rascunho nunca gera consentimento REAL (modo baileys), mesmo com o telefone verificado", async () => {
    const { repo, token } = montar(); let gravou = false;
    repo.termoVigente = async () => ({ versao: 1, rascunho: true }); repo.consentir = async () => { gravou = true; return {}; };
    await assert.rejects(titular.consentirConvite({ token, desafio: "d", categorias: ["pendencia_d1"], termoVersao: 1, ip: "1.1.1.1", deps: { repo, auditar: async () => {}, env: BAILEYS } }),
      (e) => e.statusCode === 409 && JSON.stringify(e).includes("TERMO_NAO_APROVADO"));
    assert.equal(gravou, false);
  });
});

describe("503 intencional × falha real (errorHandler em produção)", () => {
  // processo filho com NODE_ENV=production de verdade (emProducao é fixado na importação)
  const roteiro = `
    import express from "express"; import http from "node:http";
    const { ApiError } = await import("./src/shared/ApiError.js"); const { errorHandler } = await import("./src/middlewares/errorHandler.js");
    const casos = { a: new ApiError(503, "Verificação por WhatsApp indisponível no momento.", { codigo: "VERIFICACAO_INDISPONIVEL" }),
      b: new Error("ECONNREFUSED postgres://usuario:senha@host/db"), c: new ApiError(503, "detalhe interno com segredo", { motivo: "x" }),
      d: new ApiError(503, "x", { codigo: "com espaço; <script>" }) };
    const out = {}; console.error = () => {};
    for (const [k, err] of Object.entries(casos)) {
      const app = express(); app.get("/", () => { throw err; }); app.use(errorHandler);
      const s = await new Promise((ok) => { const x = http.createServer(app).listen(0, "127.0.0.1", () => ok(x)); });
      const r = await fetch("http://127.0.0.1:" + s.address().port + "/"); out[k] = { status: r.status, corpo: await r.json() }; s.close();
    }
    process.stdout.write("@@" + JSON.stringify(out));`;
  test("ApiError 503 com código de negócio expõe mensagem e código; erro comum segue genérico; código fora do vocabulário nunca é refletido", () => {
    const saida = execFileSync(process.execPath, ["--input-type=module", "-e", roteiro], { cwd: path.join(RAIZ, ".."), encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production", SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "ficticio_service_role_key_0123456789abcdef", SUPABASE_ANON_KEY: "ficticio_anon_key_0123456789abcdef0123" } });
    const r = JSON.parse(saida.slice(saida.indexOf("@@") + 2));
    assert.deepEqual([r.a.status, r.a.corpo.codigo, /indisponível/.test(r.a.corpo.error)], [503, "VERIFICACAO_INDISPONIVEL", true]);
    assert.deepEqual([r.b.status, r.b.corpo.error.includes("postgres://"), r.b.corpo.codigo], [500, false, undefined]);
    assert.ok(!r.c.corpo.error.includes("segredo") && r.c.corpo.codigo === undefined, "503 sem código de negócio continua mascarado");
    assert.ok(!JSON.stringify(r.d).includes("script"), "código fora do vocabulário nunca é refletido");
  });
});

describe("arquitetura", () => {
  const arquivos = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? arquivos(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []);
  const ler = (f) => readFileSync(path.join(RAIZ, f), "utf8");
  test("só notificacoes.envio.js chega a comunicacao.otp.js; a ponte não importa fila, política, worker nem chama o provider direto", () => {
    const quem = arquivos(RAIZ).filter((f) => /comunicacao\.otp(\.repo)?\.js["']/.test(readFileSync(f, "utf8"))).map((f) => path.basename(f)).sort();
    assert.deepEqual(quem, ["comunicacao.otp.js", "notificacoes.envio.js"]);
    const s = ler("modules/comunicacao/comunicacao.otp.js");
    assert.doesNotMatch(s, /from\s+["'][^"']*(comunicacao\.fila|comunicacao\.policy|comunicacao\.manual|comunicacao\.alertas|worker-comunicacao|comunicacao\.destinatarios|comunicacao\.contatos)/);
    assert.doesNotMatch(s, /\.(sendText|sendImage|sendDocument)\(/, "o envio só passa por whatsapp.service#enviarTexto");
    assert.doesNotMatch(s, /decifrarTelefone|comunicacao_mensagens|from\("comunicacao_/, "a ponte nunca decifra número nem toca a fila do D-1");
  });
  test("a Central nunca envia notificação por esta ponte: só o código OTP (nenhum outro módulo da Central a usa)", () => {
    const usos = arquivos(path.join(RAIZ, "modules/notificacoes")).filter((f) => /enviarOtpBaileys|comunicacao\.otp/.test(readFileSync(f, "utf8"))).map((f) => path.basename(f));
    assert.deepEqual(usos, ["notificacoes.envio.js"]);
  });
  test("migration 138 não escreve na fila do D-1 nem guarda número/código/texto", () => {
    const sql = readFileSync(path.join(RAIZ, "../../database/migrations/138_notificacoes_otp_envios.sql"), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.doesNotMatch(sql, /(insert\s+into|update|delete\s+from)\s+comunicacao_mensagens/i);
    assert.doesNotMatch(sql, /telefone|codigo_|\btexto\b|conteudo/i, "só id do desafio, estado e motivo fixo");
  });
});
