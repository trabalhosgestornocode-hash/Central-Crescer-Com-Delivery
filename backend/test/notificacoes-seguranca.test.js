// Central de Notificações — segurança (D-4), transporte só simulado e arquitetura.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const SEGREDO = "segredo-de-teste-da-central-0123456789abcdef";
process.env.NOTIFICACOES_SEGREDO_MESTRE = SEGREDO;
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET ?? "segredo-ifood-teste-0123456789";

const cripto = await import("../src/shared/cripto.js");
const seg = await import("../src/modules/notificacoes/notificacoes.segredos.js");
const basico = await import("../src/modules/notificacoes/notificacoes.basico.js");
const envio = await import("../src/modules/notificacoes/notificacoes.envio.js");

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

describe("cifra autenticada genérica (D-4)", () => {
  const chave = crypto.randomBytes(32);
  const c = cripto.criarCifraAutenticada(chave);
  test("ida e volta; IV aleatório (o mesmo número cifra diferente a cada vez)", () => {
    const a = c.cifrar("+5511912345678", "telefone");
    const b = c.cifrar("+5511912345678", "telefone");
    assert.notEqual(a, b);
    assert.equal(c.decifrar(a, "telefone"), "+5511912345678");
    assert.ok(!a.includes("5511912345678"));
  });
  test("AAD amarra ao campo: cifrado de telefone não decifra como e-mail", () => {
    assert.throws(() => c.decifrar(c.cifrar("x@y.com", "email"), "telefone"));
  });
  test("adulteração detectada (tag GCM)", () => {
    const [v, iv, tag, ct] = c.cifrar("+5511912345678", "telefone").split(":");
    const ruim = Buffer.from(ct, "base64url"); ruim[0] ^= 1;
    assert.throws(() => c.decifrar([v, iv, tag, ruim.toString("base64url")].join(":"), "telefone"));
  });
  test("chave errada não decifra; chave inválida é recusada", () => {
    const outro = cripto.criarCifraAutenticada(crypto.randomBytes(32));
    assert.throws(() => outro.decifrar(c.cifrar("abc", "telefone"), "telefone"));
    assert.throws(() => cripto.criarCifraAutenticada(Buffer.alloc(16)));
  });
  test("a cifra do iFood continua a mesma (formato v1, sem AAD)", () => {
    cripto._resetarChaveCache();
    const x = cripto.cifrar("token-ifood");
    assert.match(x, /^v1:/);
    assert.equal(cripto.decifrar(x), "token-ifood");
  });
});

describe("segredos da Central (HKDF, HMAC, fail-closed)", () => {
  beforeEach(() => { process.env.NOTIFICACOES_SEGREDO_MESTRE = SEGREDO; seg._resetarSegredos(); });
  test("sem segredo (ou curto) a Central fica indisponível — nada é guardado em claro", () => {
    delete process.env.NOTIFICACOES_SEGREDO_MESTRE; seg._resetarSegredos();
    assert.equal(seg.segredosDisponiveis(), false);
    assert.throws(() => seg.cifrarTelefone("+5511912345678"), /indisponível/);
    process.env.NOTIFICACOES_SEGREDO_MESTRE = "curto"; seg._resetarSegredos();
    assert.equal(seg.segredosDisponiveis(), false);
  });
  test("HMAC estável para dedupe; domínios separados (telefone × e-mail × OTP)", () => {
    assert.equal(seg.hmacTelefone("+5511912345678"), seg.hmacTelefone("+5511912345678"));
    assert.match(seg.hmacTelefone("+5511912345678"), /^[0-9a-f]{64}$/);
    assert.notEqual(seg.hmacTelefone("+5511912345678"), seg.hmacEmail("+5511912345678"));
    assert.notEqual(seg.hmacCodigo("d1", "123456"), seg.hmacCodigo("d2", "123456"), "o mesmo código em outro desafio dá outro HMAC");
  });
  test("o HMAC não é o SHA-256 simples do número (depende do segredo)", () => {
    const simples = crypto.createHash("sha256").update("tel:+5511912345678").digest("hex");
    assert.notEqual(seg.hmacTelefone("+5511912345678"), simples);
  });
  test("comparação segura: iguais, diferentes, tamanhos diferentes, vazios", () => {
    assert.equal(seg.compararSeguro("ab", "ab"), true);
    assert.equal(seg.compararSeguro("ab", "ac"), false);
    assert.equal(seg.compararSeguro("ab", "abc"), false);
    assert.equal(seg.compararSeguro("", ""), false);
  });
  test("cifra de telefone e e-mail com chave própria (não decifra com a do iFood)", () => {
    const t = seg.cifrarTelefone("+5511912345678");
    assert.equal(seg.decifrarTelefone(t), "+5511912345678");
    assert.match(t, /^k1:/);
    assert.throws(() => cripto.decifrar(t));
  });
});

describe("peças puras: telefone, OTP, token e log seguro", () => {
  test("WhatsApp internacional: nacional BR vira +55; celular exige 9; inválidos dão null", () => {
    assert.equal(basico.validarWhatsapp("(11) 91234-5678"), "+5511912345678");
    assert.equal(basico.validarWhatsapp("+5511912345678"), "+5511912345678");
    assert.equal(basico.validarWhatsapp("+14155550123"), "+14155550123");
    assert.equal(basico.validarWhatsapp("(11) 3123-4567"), null, "fixo não é WhatsApp de celular");
    assert.equal(basico.validarWhatsapp("123"), null);
    assert.equal(basico.validarWhatsapp(""), null);
    assert.equal(basico.validarWhatsapp("+5511812345678"), null);
  });
  test("máscara nunca mostra o número completo", () => {
    const m = basico.mascarar("+5511912345678");
    assert.equal(m, "+551********78");
    assert.ok(!m.includes("91234"));
  });
  test("código OTP: 6 dígitos, CSPRNG, zeros à esquerda preservados, distribuição sem viés grosseiro", () => {
    const vistos = new Set(); const primeiros = new Array(10).fill(0);
    for (let i = 0; i < 4000; i++) { const c = basico.gerarCodigoOtp(); assert.match(c, /^[0-9]{6}$/); vistos.add(c); primeiros[Number(c[0])]++; }
    assert.ok(vistos.size > 3900, "praticamente sem repetição em 4000 amostras");
    for (const n of primeiros) assert.ok(n > 280 && n < 520, `dígito inicial enviesado: ${primeiros}`);
    assert.match(readFileSync(path.join(RAIZ, "modules/notificacoes/notificacoes.basico.js"), "utf8"), /crypto\.randomInt/);
  });
  test("token de link: 32 bytes base64url; só o SHA-256 vai ao banco", () => {
    const t = basico.gerarToken();
    assert.equal(basico.tokenValido(t), true);
    assert.match(basico.hashToken(t), /^[0-9a-f]{64}$/);
    assert.notEqual(basico.hashToken(t), t);
    assert.equal(basico.tokenValido("curto"), false);
  });
  test("log seguro: sem telefone, código, token, segredo, e-mail ou cifrado", () => {
    const s = basico.sanitizarParaLog({ telefone: "+5511912345678", codigo: "123456", token: "abc", email: "a@b.com", telefone_cifrado: "k1:x",
      texto: "ligue para +55 11 91234-5678 agora", desafio: "id-1" });
    const txt = JSON.stringify(s);
    for (const proibido of ["91234", "123456", "a@b.com", "k1:x"]) assert.ok(!txt.includes(proibido), proibido);
    assert.equal(s.desafio, "id-1");
  });
});

describe("transporte: SÓ simulação, nunca em produção", () => {
  beforeEach(() => envio._limparCaixaSimulada());
  test("padrão = desligado (inclusive sem env)", () => {
    assert.equal(envio.modoTransporte({}), "desligado");
    assert.equal(envio.capacidades({}).otp, false);
    assert.equal(envio.capacidades({}).envioReal, false);
  });
  test("simulação exige ambiente isolado E não-produção", () => {
    assert.equal(envio.modoTransporte({ NOTIFICACOES_OTP_TRANSPORTE: "simulacao" }), "desligado");
    assert.equal(envio.modoTransporte({ NOTIFICACOES_OTP_TRANSPORTE: "simulacao", NOTIFICACOES_AMBIENTE_ISOLADO: "true", NODE_ENV: "production" }), "desligado");
    assert.equal(envio.modoTransporte({ NOTIFICACOES_OTP_TRANSPORTE: "simulacao", NOTIFICACOES_AMBIENTE_ISOLADO: "true", NODE_ENV: "test" }), "simulacao");
    assert.equal(envio.modoTransporte({ NOTIFICACOES_OTP_TRANSPORTE: "baileys", NOTIFICACOES_AMBIENTE_ISOLADO: "true" }), "desligado");
  });
  test("desligado: nada é entregue e nada vai para a caixa", async () => {
    const r = await envio.entregarCodigoOtp({ desafioId: "d", telefoneCifrado: seg.cifrarTelefone("+5511912345678"), telefoneHmac: "h", codigo: "123456" }, { env: {} });
    assert.equal(r.entregue, false);
    assert.equal(envio._ultimoCodigoSimulado({ desafioId: "d" }), null);
  });
  test("simulação: o código só aparece pelo gancho de teste, nunca no log", async () => {
    const logs = []; const orig = console.log; console.log = (x) => logs.push(String(x));
    try {
      const env = { NOTIFICACOES_OTP_TRANSPORTE: "simulacao", NOTIFICACOES_AMBIENTE_ISOLADO: "true", NODE_ENV: "test" };
      const r = await envio.entregarCodigoOtp({ desafioId: "d2", telefoneCifrado: seg.cifrarTelefone("+5511912345678"), telefoneHmac: "h2", codigo: "987654" }, { env });
      assert.deepEqual([r.entregue, r.simulado], [true, true]);
    } finally { console.log = orig; }
    assert.equal(envio._ultimoCodigoSimulado({ desafioId: "d2" }), "987654");
    assert.ok(!logs.join("\n").includes("987654"), "o código não pode ir para o log");
    assert.ok(!logs.join("\n").includes("91234"), "o número não pode ir para o log");
  });
});

describe("arquitetura", () => {
  const arquivos = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? arquivos(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []);
  const notif = arquivos(path.join(RAIZ, "modules/notificacoes"));
  test("nenhum módulo da Central importa gateway, Baileys, provider ou whatsapp.service (OTP nunca pelo transporte não oficial)", () => {
    for (const f of notif) {
      const s = readFileSync(f, "utf8");
      assert.doesNotMatch(s, /from\s+["'][^"']*(gateway|baileys|whatsapp\.service|whatsapp\.provider|providers\/|comunicacao\.manual|comunicacao\.fila)/i, path.basename(f));
    }
  });
  test("só envio.js e titular.service.js decifram o número", () => {
    const todos = arquivos(RAIZ);
    const quem = todos.filter((f) => /decifrarTelefone|decifrarEmail/.test(readFileSync(f, "utf8")) && !f.endsWith("notificacoes.segredos.js")).map((f) => path.basename(f)).sort();
    assert.deepEqual(quem, ["notificacoes.envio.js", "notificacoes.titular.service.js"]);
  });
  test("nenhuma rota pública do titular usa GET (token e código fora da URL) e todas ficam fora do requireAuth", () => {
    const rotas = readFileSync(path.join(RAIZ, "modules/notificacoes/notificacoes.routes.js"), "utf8");
    assert.doesNotMatch(rotas, /titularRouter\.get\(/);
    const app = readFileSync(path.join(RAIZ, "app.js"), "utf8");
    assert.ok(app.indexOf('app.use("/api/publico/notificacoes"') < app.indexOf('app.use("/api/v1", requireAuth)'));
  });
  test("o código OTP nunca é devolvido pela API nem logado (nenhum `codigo` em res.json / log do módulo)", () => {
    for (const f of notif) {
      const s = readFileSync(f, "utf8");
      assert.doesNotMatch(s, /console\.(log|warn|error)\([^)]*codigo/i, path.basename(f));
    }
    const titular = readFileSync(path.join(RAIZ, "modules/notificacoes/notificacoes.titular.service.js"), "utf8");
    assert.doesNotMatch(titular, /return\s*\{[^}]*\bcodigo\b\s*[,}]/, "nenhum retorno com o código");
  });
});
