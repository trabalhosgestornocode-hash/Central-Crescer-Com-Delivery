// Policy Engine — 100% função pura, sem banco. Cobre os motivos de bloqueio
// pedidos e a prioridade entre eles.
// Rodar: node --test test/comunicacao-policy.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { avaliarEnvio } from "../src/modules/comunicacao/comunicacao.policy.js";
import { MODOS, MOTIVOS_BLOQUEIO } from "../src/modules/comunicacao/comunicacao.constants.js";

/** Snapshot "tudo permitido" — cada teste só desvia o campo que quer provar. */
const BASE = () => ({
  modo: MODOS.NORMAL,
  ehProativo: true,
  contatoExiste: true,
  telefoneVerificado: true,
  optOut: false,
  destinatarioAtivo: true,
  vinculoValido: true,
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
