// Execução 10 — verificador REAL de segundo fator (apoiado na validação do provedor) e configuração da integração
// (desligada por padrão; incompleta = desligada). Tokens e contas SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verificadorHs256 } from "../../src/modules/financeiro-v2/index.js";
import { criarMfaPeloProvedor, lerPayloadSemConfiar, verificarAssinaturaPeloProvedor } from "../../src/modules/fv2-integracao/mfaPeloProvedor.js";
import { lerConfiguracaoFv2 } from "../../src/modules/fv2-integracao/index.js";
import { SEGREDO_SINTETICO, tokenSintetico } from "./helpers/tokens.js";

const CONTA = "dddddddd-0000-4000-8000-0000000000c1";
const OUTRA = "dddddddd-0000-4000-8000-0000000000c2";
const agora = Date.now();
const relogio = () => new Date(agora);
const assinatura = verificadorHs256(SEGREDO_SINTETICO);
/** provedor sintético: valida assinatura/expiração e pode "revogar" sessões */
const revogadas = new Set();
const obterUsuario = async (t) => { const p = assinatura(t); return p && p.exp * 1000 > agora && !revogadas.has(p.session_id) ? { id: p.sub } : null; };
const mfa = criarMfaPeloProvedor({ obterUsuario, relogio });
const tk = (o = {}) => tokenSintetico({ agoraMs: agora, conta: CONTA, ...o });

test("10 — MFA pelo provedor: só passa token que o PROVEDOR aceita, da mesma conta, com fator recente em amr", async () => {
  assert.deepEqual(await mfa.provar({ tokenDeAcesso: tk(), contaId: CONTA }).then((r) => [r.ok, r.metodo]), [true, "totp"]);
  const motivo = async (t, conta = CONTA) => (await mfa.provar({ tokenDeAcesso: t, contaId: conta })).motivo;
  assert.equal(await motivo(tk({ metodo: null })), "MFA_SEM_SEGUNDO_FATOR", "só senha");
  assert.equal(await motivo(tk({ aal: "aal1" })), "MFA_REQUERIDA", "aal1");
  assert.equal(await motivo(tk({ fatorHaS: 7200, iatHaS: 5 })), "REAUTENTICACAO_RECENTE", "aal2 com token novo NÃO prova recência: o carimbo do fator é de 2 h");
  assert.equal(await motivo(tk({ carimboEmMs: true })), "MFA_CARIMBO_INCOERENTE", "carimbo em ms não é convertido por adivinhação");
  assert.equal(await motivo(tk(), OUTRA), "MFA_DE_OUTRA_CONTA", "fator de uma conta não prova a outra");
  assert.equal(await motivo(tk({ segredo: "segredo-que-o-provedor-nao-reconhece-0123456789" })), "MFA_ASSINATURA_INVALIDA");
  assert.equal(await motivo(tk({ expEmS: -5 })), "MFA_ASSINATURA_INVALIDA", "expirado (o provedor recusa)");
  revogadas.add("sessao-do-provedor-sintetica");
  assert.equal(await motivo(tk()), "MFA_ASSINATURA_INVALIDA", "sessão revogada no provedor");
  revogadas.clear();
  assert.equal(await motivo(""), "MFA_SEM_TOKEN");
});

test("10 — a porta exige a validação do provedor: payload sem provedor nunca vira prova", async () => {
  assert.throws(() => verificarAssinaturaPeloProvedor({}), /validação do provedor/);
  const falso = verificarAssinaturaPeloProvedor({ obterUsuario: async () => ({ id: OUTRA }) });
  assert.equal(await falso(tk()), null, "provedor diz outra conta → nada");
  const quebrado = verificarAssinaturaPeloProvedor({ obterUsuario: async () => { throw new Error("rede"); } });
  assert.equal(await quebrado(tk()), null, "provedor indisponível → nada (falha fechada)");
  assert.equal(lerPayloadSemConfiar("a.b"), null);
});

test("10 — configuração: desligada por padrão; incompleta ou com chave curta = desligada (nada é conectado)", () => {
  assert.deepEqual(lerConfiguracaoFv2({}), { habilitado: false, motivo: "DESLIGADO" });
  assert.equal(lerConfiguracaoFv2({ FV2_HABILITADO: "true" }).habilitado, false, "só o valor exato 1 liga");
  assert.deepEqual(lerConfiguracaoFv2({ FV2_HABILITADO: "1", FV2_APP_DATABASE_URL: "postgres://x" }).faltando, ["FV2_GATEWAY_URL", "FV2_GATEWAY_CHAVE"]);
  assert.equal(lerConfiguracaoFv2({ FV2_HABILITADO: "1", FV2_APP_DATABASE_URL: "x", FV2_GATEWAY_URL: "https://g", FV2_GATEWAY_CHAVE: "curta" }).habilitado, false);
  const ok = lerConfiguracaoFv2({ FV2_HABILITADO: "1", FV2_APP_DATABASE_URL: "x", FV2_GATEWAY_URL: "https://g", FV2_GATEWAY_CHAVE: "k".repeat(40), FV2_APP_POOL_MAX: "50" });
  assert.equal(ok.habilitado, true);
  assert.equal(ok.poolMax, 8, "pool limitado (o banco do projeto tem 60 conexões)");
  // a integração nunca recebe a credencial da autoridade
  assert.ok(!("autoridadeUrl" in ok));
});
