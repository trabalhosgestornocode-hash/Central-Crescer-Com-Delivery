// Cofre de documentos do Financeiro: bucket privado simulado + verificador antimalware (servidor clamd SIMULADO por TCP, protocolo INSTREAM real).
// Tudo sintético. Cobre: formato/tamanho, quarentena, liberação, infectado, verificador fora do ar, isolamento por unidade, hash, bucket público.
import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { criarCofreDocumentosSupabase, validarDocumento, ESTADO_ARQUIVO } from "../../src/modules/fv2-integracao/cofreDocumentos.js";
import { criarVerificadorClamd, verificadorDesligado } from "../../src/modules/fv2-integracao/verificadorAntimalware.js";
import { conferirCofre } from "../../src/modules/financeiro-v2/contratos/cofre.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const UN_A = "22222222-2222-4222-8222-222222222222";
const UN_B = "33333333-3333-4333-8333-333333333333";
const pdf = (m) => new Uint8Array(Buffer.from(`%PDF-1.4\n% comprovante sintetico ${m}\n%%EOF\n`));
const EICAR = new Uint8Array(Buffer.from("%PDF-1.4\n% EICAR-STANDARD-ANTIVIRUS-TEST-FILE\n%%EOF\n"));

/** Storage do Supabase simulado (bucket privado por padrão). */
function supabaseFalso({ publico = false } = {}) {
  const arquivos = new Map();
  const storage = {
    async getBucket() { return { data: { public: publico }, error: null }; },
    from() {
      return {
        async list(dir, { search } = {}) { return { data: [...arquivos.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => ({ name: k.slice(dir.length + 1) })).filter((x) => !search || x.name === search), error: null }; },
        async upload(k, c) { if (arquivos.has(k)) return { error: { message: "The resource already exists" } }; arquivos.set(k, Uint8Array.from(c)); return { error: null }; },
        async download(k) { const c = arquivos.get(k); return c ? { data: { arrayBuffer: async () => c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength), type: "" }, error: null } : { data: null, error: { message: "not found" } }; },
        async remove(ks) { for (const k of ks) arquivos.delete(k); return { error: null }; },
      };
    },
  };
  return { storage, arquivos };
}

/** clamd simulado: INSTREAM real; acha "EICAR" no fluxo. */
function clamdFalso({ derrubar = false } = {}) {
  const servidor = net.createServer((s) => {
    if (derrubar) return s.destroy();
    const partes = [];
    s.on("data", (d) => partes.push(d));
    s.on("end", () => {});
    const talvez = setInterval(() => {
      const b = Buffer.concat(partes);
      if (b.length >= 4 && b.subarray(b.length - 4).equals(Buffer.alloc(4))) { clearInterval(talvez); s.end(b.includes("EICAR") ? "stream: Win.Test.EICAR_HDB-1 FOUND\0" : "stream: OK\0"); }
    }, 5);
  });
  return new Promise((r) => servidor.listen(0, "127.0.0.1", () => r({ porta: servidor.address().port, fechar: () => new Promise((f) => servidor.close(f)) })));
}

const esc = (u) => ({ organizacaoId: ORG, unidadeId: u });

test("CD-1 formato e tamanho: só PDF/PNG/JPEG/WEBP reais; PDF com conteúdo ativo e arquivo vazio/grande são recusados", () => {
  assert.equal(validarDocumento(pdf("a")), "application/pdf");
  assert.equal(validarDocumento(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), "image/png");
  assert.equal(validarDocumento(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
  assert.throws(() => validarDocumento(new Uint8Array()), /vazio/);
  assert.throws(() => validarDocumento(new Uint8Array(Buffer.from("MZ executavel disfarcado de comprovante.pdf"))), /Formato não aceito/);
  assert.throws(() => validarDocumento(new Uint8Array(Buffer.from("%PDF-1.4 /JavaScript (app.alert)"))), /conteúdo ativo/);
  assert.throws(() => validarDocumento(new Uint8Array(10 * 1024 * 1024 + 1).fill(1)), /Formato|limite/);
});

test("CD-2 antimalware LIMPO: entra em quarentena, é liberado, lido de volta e conferido; mesmo arquivo = repetido (sem duplicar)", async () => {
  const { storage, arquivos } = supabaseFalso();
  const clam = await clamdFalso();
  const cofre = criarCofreDocumentosSupabase({ supabase: { storage }, bucket: "fv2-documentos", scanner: criarVerificadorClamd({ host: "127.0.0.1", porta: clam.porta }) });
  const g = await cofre.guardar(esc(UN_A), { conteudo: pdf("c2") });
  assert.equal(g.estado, ESTADO_ARQUIVO.LIBERADO);
  assert.deepEqual([...arquivos.keys()].map((k) => k.split("/")[0]), ["liberados"], "nada sobra na quarentena");
  const lido = await cofre.ler(esc(UN_A), g.arquivoId);
  assert.equal(lido.hashSha256, g.hashSha256);
  const de_novo = await cofre.guardar(esc(UN_A), { conteudo: pdf("c2") });
  assert.equal(de_novo.repetido, true);
  assert.equal(arquivos.size, 1);
  assert.equal(conferirCofre(cofre).ok, true, "a porta pública do cofre continua sem exclusão nem link");
  await clam.fechar();
});

test("CD-3 INFECTADO: recusado, nunca disponibilizado, não é lido, e reenviar continua recusado", async () => {
  const { storage, arquivos } = supabaseFalso();
  const clam = await clamdFalso();
  const cofre = criarCofreDocumentosSupabase({ supabase: { storage }, bucket: "b", scanner: criarVerificadorClamd({ host: "127.0.0.1", porta: clam.porta }) });
  await assert.rejects(() => cofre.guardar(esc(UN_A), { conteudo: EICAR }), /malicioso/);
  assert.deepEqual([...arquivos.keys()].map((k) => k.split("/")[0]), ["infectados"]);
  const id = `cofre:${[...arquivos.keys()][0].split("/").pop()}`;
  await assert.rejects(() => cofre.ler(esc(UN_A), id), /não encontrado/i);
  assert.equal(await cofre.existe(esc(UN_A), id), false);
  await assert.rejects(() => cofre.guardar(esc(UN_A), { conteudo: EICAR }), /malicioso/);
  await clam.fechar();
});

test("CD-4 verificador FORA DO AR / não configurado: fica em QUARENTENA (existe, mas não abre); depois liberado pela revarredura", async () => {
  const { storage, arquivos } = supabaseFalso();
  let scanner = verificadorDesligado;
  const cofre = criarCofreDocumentosSupabase({ supabase: { storage }, bucket: "b", scanner: { verificar: (c) => scanner.verificar(c) } });
  const g = await cofre.guardar(esc(UN_A), { conteudo: pdf("c4") });
  assert.equal(g.estado, ESTADO_ARQUIVO.QUARENTENA);
  assert.equal(await cofre.existe(esc(UN_A), g.arquivoId), true, "a ficha pode ser vinculada");
  assert.deepEqual((await cofre.conferirEmQuarentena(esc(UN_A), g.arquivoId)).hashSha256, g.hashSha256);
  await assert.rejects(() => cofre.ler(esc(UN_A), g.arquivoId), /em verificação/);
  const clam = await clamdFalso();
  scanner = criarVerificadorClamd({ host: "127.0.0.1", porta: clam.porta });
  assert.deepEqual(await cofre.verificarQuarentena([esc(UN_A)]), { liberados: 1, infectados: 0, pendentes: 0 });
  assert.equal((await cofre.ler(esc(UN_A), g.arquivoId)).hashSha256, g.hashSha256);
  assert.deepEqual([...arquivos.keys()].map((k) => k.split("/")[0]), ["liberados"]);
  await clam.fechar();
  // servidor que derruba a conexão = indisponível, nunca "limpo"
  const ruim = await clamdFalso({ derrubar: true });
  const v = criarVerificadorClamd({ host: "127.0.0.1", porta: ruim.porta, tempoMs: 500 });
  assert.equal((await v.verificar(pdf("x"))).estado, "INDISPONIVEL");
  await ruim.fechar();
});

test("CD-5 isolamento por unidade, hash adulterado e bucket público", async () => {
  const { storage, arquivos } = supabaseFalso();
  const limpo = { verificar: async () => ({ estado: "LIMPO" }) };
  const cofre = criarCofreDocumentosSupabase({ supabase: { storage }, bucket: "b", scanner: limpo });
  const g = await cofre.guardar(esc(UN_A), { conteudo: pdf("c5") });
  assert.equal(await cofre.existe(esc(UN_B), g.arquivoId), false, "a unidade B não enxerga o arquivo da A");
  await assert.rejects(() => cofre.ler(esc(UN_B), g.arquivoId), /não encontrado/i);
  const chave = [...arquivos.keys()][0];
  arquivos.set(chave, pdf("adulterado"));
  await assert.rejects(() => cofre.ler(esc(UN_A), g.arquivoId), /não confere/);
  const publico = supabaseFalso({ publico: true });
  const c2 = criarCofreDocumentosSupabase({ supabase: { storage: publico.storage }, bucket: "b", scanner: limpo });
  await assert.rejects(() => c2.guardar(esc(UN_A), { conteudo: pdf("p") }), /armazenamento privado/);
  assert.throws(() => criarCofreDocumentosSupabase({ supabase: { storage }, bucket: "b" }), /verificador/);
});
