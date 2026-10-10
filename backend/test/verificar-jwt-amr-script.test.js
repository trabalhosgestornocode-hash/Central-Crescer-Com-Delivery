// Auditoria do script de verificação do JWT (backend/scripts/verificar-jwt-amr.mjs): roda com o ambiente VAZIO (não carrega
// .env nem segredos), lê só a entrada padrão e NUNCA imprime o token nem valores de claims.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const aqui = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(aqui, "..", "scripts", "verificar-jwt-amr.mjs");
const SEGREDO = "SEGREDO-NAO-PODE-VAZAR-123";
const jwtCom = (claims) => `cab.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${SEGREDO}assinatura`;
const rodar = (entrada, args = []) => spawnSync(process.execPath, [SCRIPT, ...args], { input: entrada, encoding: "utf8", env: { PATH: process.env.PATH } });
const agoraS = () => Math.floor(Date.now() / 1000);

describe("verificar-jwt-amr.mjs", () => {
  test("funciona com o ambiente VAZIO e não importa config/env nem dotenv (não carrega segredo nenhum)", () => {
    const fonte = readFileSync(SCRIPT, "utf8");
    assert.match(fonte, /carimboAutenticacao\.js/);
    assert.doesNotMatch(fonte.replace(/^\s*\/\/.*$/gm, ""), /config\/env|dotenv|process\.env|renovacaoExibicao|contextToken|fetch\(|https?:\/\//);
    const pura = readFileSync(join(aqui, "..", "src", "shared", "carimboAutenticacao.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(pura, /\bimport\b/, "a função do carimbo não tem dependências");
  });

  test("com amr[].timestamp: exit 0, mostra só nomes de claims e idades; NÃO imprime o token, o segredo, o sub nem o e-mail", () => {
    const t = agoraS();
    const r = rodar(jwtCom({ sub: "usuario-secreto-uuid", email: "pessoa@exemplo.test", aal: "aal1", iat: t - 60, exp: t + 3600, amr: [{ method: "password", timestamp: t - 7200 }] }));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /RESULTADO: carimbo OK — autenticado há 120 min/);
    assert.match(r.stdout, /objetos \{method, timestamp\}/);
    for (const proibido of [SEGREDO, "usuario-secreto-uuid", "pessoa@exemplo.test", "cab."]) assert.ok(!r.stdout.includes(proibido) && !r.stderr.includes(proibido), `vazou: ${proibido}`);
  });

  test("sem amr, amr só de strings, carimbo do futuro/ inválido: exit 1 (sem carimbo utilizável, fail-closed)", () => {
    const t = agoraS();
    for (const claims of [{ aal: "aal1" }, { amr: ["pwd"] }, { amr: [{ method: "password" }] }, { amr: [{ method: "password", timestamp: "ontem" }] }, { amr: [{ method: "password", timestamp: -5 }] }]) {
      const r = rodar(jwtCom({ iat: t, exp: t + 60, ...claims }));
      assert.equal(r.status, 1, JSON.stringify(claims) + r.stdout);
      assert.match(r.stdout, /SEM carimbo utilizável/);
    }
  });

  test("entrada que não é JWT / payload ilegível: exit 2, sem eco da entrada", () => {
    for (const entrada of ["lixo-sem-pontos-SEGREDO", `a.${SEGREDO}.c`]) {
      const r = rodar(entrada);
      assert.equal(r.status, 2);
      assert.ok(!r.stdout.includes(SEGREDO) && !r.stderr.includes(SEGREDO));
    }
  });

  test("usa o carimbo MAIS RECENTE (MFA depois do login conta como autenticação) e aceita 'Bearer ' na frente", () => {
    const t = agoraS();
    const r = rodar(`Bearer ${jwtCom({ aal: "aal2", iat: t, exp: t + 60, amr: [{ method: "password", timestamp: t - 36000 }, { method: "totp", timestamp: t - 600 }] })}`);
    assert.equal(r.status, 0); assert.match(r.stdout, /autenticado há 10 min/);
  });

  describe("modo de comparação (2ª execução, depois do refresh)", () => {
    const login = agoraS() - 7200;                                           // autenticou há 2 h
    const iso = (s) => new Date(s * 1000).toISOString();
    const token = (carimbo, iat) => jwtCom({ aal: "aal1", iat, exp: iat + 3600, amr: [{ method: "password", timestamp: carimbo }] });

    test("carimbo IGUAL e iat avançou (houve refresh): ESTÁVEL, exit 0", () => {
      const r = rodar(token(login, agoraS() - 30), [`--carimbo-esperado=${iso(login)}`, `--iat-anterior=${iso(agoraS() - 3600)}`]);
      assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /ESTÁVEL/); assert.match(r.stdout, /houve refresh/);
    });
    test("carimbo MUDOU depois do refresh: INSTÁVEL, exit 1 (o teto de 20 h não é confiável)", () => {
      const r = rodar(token(agoraS() - 60, agoraS() - 30), [`--carimbo-esperado=${iso(login)}`, `--iat-anterior=${iso(agoraS() - 3600)}`]);
      assert.equal(r.status, 1); assert.match(r.stdout, /INSTÁVEL/);
    });
    test("iat NÃO avançou (mesmo token): não prova nada — exit 1 com aviso", () => {
      const iat = agoraS() - 3600;
      const r = rodar(token(login, iat), [`--carimbo-esperado=${iso(login)}`, `--iat-anterior=${iso(iat)}`]);
      assert.equal(r.status, 1); assert.match(r.stdout, /iat NÃO avançou/);
    });
    test("argumento inválido: exit 2; e a saída continua sem token/segredo", () => {
      const r = rodar(token(login, agoraS()), ["--carimbo-esperado=ontem"]);
      assert.equal(r.status, 2);
      for (const p of [SEGREDO, "cab."]) assert.ok(!r.stdout.includes(p) && !r.stderr.includes(p));
    });
  });
});
