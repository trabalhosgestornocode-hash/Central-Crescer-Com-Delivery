// Policy Engine — 100% função pura, sem banco. Cobre os motivos de bloqueio
// pedidos e a prioridade entre eles.
// Rodar: node --test test/comunicacao-policy.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { avaliarEnvio } from "../src/modules/comunicacao/comunicacao.policy.js";
import { MODOS, MOTIVOS_BLOQUEIO, MOTIVOS_BLOQUEIO_TRANSITORIOS, bloqueioEhTransitorio } from "../src/modules/comunicacao/comunicacao.constants.js";

/** Snapshot "tudo permitido" — cada teste só desvia o campo que quer provar. */
const BASE = () => ({
  modo: MODOS.NORMAL,
  ehProativo: true,
  contatoExiste: true,
  telefoneVerificado: true,
  optOut: false,
  consentimento: true,
  destinatarioAtivo: true,
  vinculoValido: true,
  empresaHabilitada: true,
  tipoPermitido: true,
  pendenciaAindaExiste: true,
  duplicado: false,
  cooldownAtivo: false,
  dentroDaJanela: true,
  rateLimitExcedido: false,
  providerConectado: true,
});

describe("comunicacao.policy — avaliarEnvio", () => {
  test("teste 7 — NORMAL permite envio elegível", () => {
    const r = avaliarEnvio(BASE());
    assert.deepEqual(r, { allowed: true, reason: null });
  });

  test("teste 8 — REACTIVE_ONLY bloqueia mensagem proativa", () => {
    const r = avaliarEnvio({ ...BASE(), modo: MODOS.REACTIVE_ONLY, ehProativo: true });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.REACTIVE_ONLY_BLOQUEIA_PROATIVO });
  });

  test("REACTIVE_ONLY permite resposta (não-proativa)", () => {
    const r = avaliarEnvio({ ...BASE(), modo: MODOS.REACTIVE_ONLY, ehProativo: false });
    assert.equal(r.allowed, true);
  });

  test("teste 9 — DISABLED bloqueia proativo", () => {
    const r = avaliarEnvio({ ...BASE(), modo: MODOS.DISABLED, ehProativo: true });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.DISABLED });
  });

  test("teste 9 — DISABLED bloqueia também o que não é proativo (processamento externo)", () => {
    const r = avaliarEnvio({ ...BASE(), modo: MODOS.DISABLED, ehProativo: false });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.DISABLED });
  });

  test("teste 10 — opt-out bloqueia proativo", () => {
    const r = avaliarEnvio({ ...BASE(), optOut: true });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.OPT_OUT });
  });

  test("teste 11 — cooldown bloqueia repetição", () => {
    const r = avaliarEnvio({ ...BASE(), cooldownAtivo: true });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.COOLDOWN });
  });

  test("teste 19 — telefone (contato) sem vínculo real não concede permissão", () => {
    // contato existe e está verificado — mas o perfil não tem vínculo real
    // com a organização/unidade deste envio. O telefone sozinho não basta.
    const r = avaliarEnvio({ ...BASE(), vinculoValido: false });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.SEM_VINCULO });
  });

  test("sem contato resolvido -> NO_PHONE", () => {
    const r = avaliarEnvio({ ...BASE(), contatoExiste: false });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.NO_PHONE });
  });

  test("telefone não verificado -> PHONE_NOT_VERIFIED", () => {
    const r = avaliarEnvio({ ...BASE(), telefoneVerificado: false });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.PHONE_NOT_VERIFIED });
  });

  test("destinatário inativo -> USER_INACTIVE", () => {
    const r = avaliarEnvio({ ...BASE(), destinatarioAtivo: false });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.USER_INACTIVE });
  });

  test("pendência já resolvida (proativo) -> PENDING_RESOLVED", () => {
    const r = avaliarEnvio({ ...BASE(), pendenciaAindaExiste: false });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.PENDING_RESOLVED });
  });

  test("pendência resolvida não bloqueia mensagem NÃO proativa (resposta)", () => {
    const r = avaliarEnvio({ ...BASE(), ehProativo: false, pendenciaAindaExiste: false });
    assert.equal(r.allowed, true);
  });

  test("duplicado -> DUPLICATE", () => {
    const r = avaliarEnvio({ ...BASE(), duplicado: true });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.DUPLICATE });
  });

  test("fora da janela comercial -> OUTSIDE_ALLOWED_WINDOW", () => {
    const r = avaliarEnvio({ ...BASE(), dentroDaJanela: false });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.OUTSIDE_ALLOWED_WINDOW });
  });

  test("rate limit excedido -> RATE_LIMIT", () => {
    const r = avaliarEnvio({ ...BASE(), rateLimitExcedido: true });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.RATE_LIMIT });
  });

  test("provider offline -> PROVIDER_OFFLINE", () => {
    const r = avaliarEnvio({ ...BASE(), providerConectado: false });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.PROVIDER_OFFLINE });
  });

  test("modo seguro (circuito) -> SAFE_MODE", () => {
    const r = avaliarEnvio({ ...BASE(), modoSeguro: true });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.SAFE_MODE });
  });

  test("prioridade: DISABLED vence sobre qualquer outro motivo", () => {
    const r = avaliarEnvio({ ...BASE(), modo: MODOS.DISABLED, optOut: true, cooldownAtivo: true, dentroDaJanela: false });
    assert.equal(r.reason, MOTIVOS_BLOQUEIO.DISABLED);
  });

  test("prioridade: OPT_OUT vence sobre COOLDOWN/janela", () => {
    const r = avaliarEnvio({ ...BASE(), optOut: true, cooldownAtivo: true, dentroDaJanela: false });
    assert.equal(r.reason, MOTIVOS_BLOQUEIO.OPT_OUT);
  });
});

// ---------------------------------------------------------------------------
// D.3-C — FAIL-CLOSED: consentimento, empresa/tipo, modo, campos ausentes.
// ---------------------------------------------------------------------------
describe("comunicacao.policy — consentimento explícito (D.3-C)", () => {
  test("consentimento=true + verificado + !opt_out + empresa/tipo habilitados -> elegível", () => {
    assert.deepEqual(avaliarEnvio(BASE()), { allowed: true, reason: null });
  });

  for (const [nome, valor] of [["false", false], ["null", null], ["undefined", undefined], ["string 'true'", "true"], ["número 1", 1]]) {
    test(`consentimento=${nome} -> NO_CONSENT (só o booleano true consente)`, () => {
      const r = avaliarEnvio({ ...BASE(), consentimento: valor });
      assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.NO_CONSENT });
    });
  }

  test("opt_out=false NÃO é consentimento: quem nunca pediu para parar mas nunca consentiu não recebe proativo", () => {
    const r = avaliarEnvio({ ...BASE(), optOut: false, consentimento: undefined });
    assert.equal(r.reason, MOTIVOS_BLOQUEIO.NO_CONSENT);
  });

  test("consentimento e opt-out são condições DISTINTAS: opt_out=true bloqueia mesmo com consentimento=true", () => {
    const r = avaliarEnvio({ ...BASE(), consentimento: true, optOut: true });
    assert.deepEqual(r, { allowed: false, reason: MOTIVOS_BLOQUEIO.OPT_OUT });
  });

  test("resposta NÃO proativa (o contato escreveu primeiro) não exige consentimento proativo", () => {
    const r = avaliarEnvio({ ...BASE(), ehProativo: false, consentimento: false, empresaHabilitada: false, tipoPermitido: false });
    assert.equal(r.allowed, true);
  });

  test("`ehProativo` ausente/não-booleano é tratado como PROATIVO (o caso mais restritivo)", () => {
    for (const v of [undefined, null, "false", 0]) {
      const r = avaliarEnvio({ ...BASE(), ehProativo: v, consentimento: false });
      assert.equal(r.reason, MOTIVOS_BLOQUEIO.NO_CONSENT, `ehProativo=${String(v)}`);
    }
  });

  test("prioridade: OPT_OUT e PHONE_NOT_VERIFIED vêm antes de NO_CONSENT", () => {
    assert.equal(avaliarEnvio({ ...BASE(), optOut: true, consentimento: false }).reason, MOTIVOS_BLOQUEIO.OPT_OUT);
    assert.equal(avaliarEnvio({ ...BASE(), telefoneVerificado: false, consentimento: false }).reason, MOTIVOS_BLOQUEIO.PHONE_NOT_VERIFIED);
  });
});

describe("comunicacao.policy — verificação e opt-out estritos (D.3-C)", () => {
  for (const [nome, valor] of [["false", false], ["null", null], ["undefined", undefined]]) {
    test(`verificado=${nome} -> PHONE_NOT_VERIFIED (antes só o literal false bloqueava)`, () => {
      assert.equal(avaliarEnvio({ ...BASE(), telefoneVerificado: valor }).reason, MOTIVOS_BLOQUEIO.PHONE_NOT_VERIFIED);
    });
  }
  for (const [nome, valor] of [["true", true], ["null", null], ["undefined", undefined]]) {
    test(`opt_out=${nome} -> OPT_OUT (só o literal false libera)`, () => {
      assert.equal(avaliarEnvio({ ...BASE(), optOut: valor }).reason, MOTIVOS_BLOQUEIO.OPT_OUT);
    });
  }
});

describe("comunicacao.policy — habilitação por empresa e tipo (D.3-C)", () => {
  for (const [nome, valor] of [["false", false], ["undefined", undefined], ["null", null]]) {
    test(`empresaHabilitada=${nome} -> EMPRESA_DESABILITADA`, () => {
      assert.deepEqual(avaliarEnvio({ ...BASE(), empresaHabilitada: valor }), { allowed: false, reason: MOTIVOS_BLOQUEIO.EMPRESA_DESABILITADA });
    });
    test(`tipoPermitido=${nome} -> TIPO_NAO_PERMITIDO`, () => {
      assert.deepEqual(avaliarEnvio({ ...BASE(), tipoPermitido: valor }), { allowed: false, reason: MOTIVOS_BLOQUEIO.TIPO_NAO_PERMITIDO });
    });
  }
  test("ter telefone cadastrado, verificado e consentido NÃO habilita a empresa", () => {
    const r = avaliarEnvio({ ...BASE(), empresaHabilitada: false });
    assert.equal(r.allowed, false);
  });
});

describe("comunicacao.policy — modo fail-closed (D.3-C)", () => {
  for (const modo of ["ACTIVE", "normal", "Normal", "\"NORMAL\"", "PROACTIVE", "", null, undefined, 1, {}, ["NORMAL"]]) {
    test(`modo desconhecido/corrompido (${JSON.stringify(modo)}) -> MODO_INVALIDO, nunca fail-open`, () => {
      assert.deepEqual(avaliarEnvio({ ...BASE(), modo }), { allowed: false, reason: MOTIVOS_BLOQUEIO.MODO_INVALIDO });
    });
  }
  test("snapshot ausente/undefined/{} bloqueia (não lança)", () => {
    assert.equal(avaliarEnvio(undefined).allowed, false);
    assert.equal(avaliarEnvio(null).allowed, false);
    assert.equal(avaliarEnvio({}).allowed, false);
  });
});

describe("comunicacao.policy — CADA condição obrigatória ausente bloqueia (D.3-C)", () => {
  const OBRIGATORIOS = ["modo", "contatoExiste", "telefoneVerificado", "optOut", "consentimento", "destinatarioAtivo", "vinculoValido",
    "empresaHabilitada", "tipoPermitido", "pendenciaAindaExiste", "duplicado", "cooldownAtivo", "dentroDaJanela", "rateLimitExcedido", "providerConectado"];
  for (const campo of OBRIGATORIOS) {
    test(`sem \`${campo}\` -> bloqueado (nunca "provavelmente ok")`, () => {
      const s = BASE(); delete s[campo];
      const r = avaliarEnvio(s);
      assert.equal(r.allowed, false, `omitir ${campo} liberou o envio`);
      assert.ok(r.reason, "todo bloqueio traz um motivo do vocabulário fechado");
      assert.ok(Object.values(MOTIVOS_BLOQUEIO).includes(r.reason));
    });
  }
  test("modoSeguro é opcional (o circuito ainda não existe): ausente NÃO bloqueia, mas `true` bloqueia", () => {
    assert.equal(avaliarEnvio(BASE()).allowed, true);
    assert.equal(avaliarEnvio({ ...BASE(), modoSeguro: true }).reason, MOTIVOS_BLOQUEIO.SAFE_MODE);
  });
});

describe("comunicacao — bloqueio PERMANENTE × TRANSITÓRIO (D.3, item 14)", () => {
  const PERMANENTES = ["OPT_OUT", "NO_CONSENT", "NO_PHONE", "PHONE_NOT_VERIFIED", "USER_INACTIVE", "SEM_VINCULO", "CONTATO_AMBIGUO", "EMPRESA_DESABILITADA", "TIPO_NAO_PERMITIDO", "PENDING_RESOLVED", "DUPLICATE"];
  const TRANSITORIOS = ["DISABLED", "MODO_INVALIDO", "REACTIVE_ONLY_BLOQUEIA_PROATIVO", "COOLDOWN", "OUTSIDE_ALLOWED_WINDOW", "RATE_LIMIT", "SAFE_MODE", "PROVIDER_OFFLINE"];

  test("todo motivo do vocabulário está classificado (nenhum esquecido)", () => {
    assert.deepEqual([...PERMANENTES, ...TRANSITORIOS].sort(), Object.values(MOTIVOS_BLOQUEIO).sort());
  });
  for (const m of PERMANENTES) test(`${m} é PERMANENTE (BLOCKED terminal)`, () => assert.equal(bloqueioEhTransitorio(m), false));
  for (const m of TRANSITORIOS) test(`${m} é TRANSITÓRIO (adia, nunca BLOCKED terminal)`, () => assert.equal(bloqueioEhTransitorio(m), true));
  test("motivo desconhecido -> tratado como PERMANENTE (o mais conservador)", () => {
    assert.equal(bloqueioEhTransitorio("MOTIVO_NOVO"), false);
    assert.equal(bloqueioEhTransitorio(undefined), false);
    assert.equal(MOTIVOS_BLOQUEIO_TRANSITORIOS.size, TRANSITORIOS.length);
  });
});
