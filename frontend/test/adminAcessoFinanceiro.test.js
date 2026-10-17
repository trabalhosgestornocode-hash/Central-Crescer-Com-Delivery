// Modelo da tela "Acesso Financeiro" do SuperAdmin — puro, sem DOM nem rede.
// Rodar: node --test frontend/test/adminAcessoFinanceiro.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  estadoDaEscrita, validarFormularioConcessao, montarCorpoConcessao, situacaoDe, podeRevogar, validarMotivoRevogacao, NIVEIS,
} from "../src/adminAcessoFinanceiroModelo.js";
import { adminApi } from "../src/adminApi.js";

const perfis = [{ id: "p1", propria: false }, { id: "eu", propria: true }];
const ok = { perfilId: "p1", nivel: "operador", motivo: "Contratação do analista financeiro" };

describe("estado das escritas (falha fechada)", () => {
  test("só `escritaLiberada === true` libera", () => {
    assert.equal(estadoDaEscrita({ escritaLiberada: true }).liberada, true);
    for (const x of [undefined, null, {}, { escritaLiberada: "true" }, { escritaLiberada: 1 }, "ok"]) assert.equal(estadoDaEscrita(x).liberada, false);
  });
  test("bloqueado traz código e mensagem do servidor, ou padrões", () => {
    const e = estadoDaEscrita({ escritaLiberada: false, codigo: "MFA_REQUERIDA", mensagem: "Exige MFA" });
    assert.deepEqual([e.liberada, e.codigo, e.mensagem], [false, "MFA_REQUERIDA", "Exige MFA"]);
    assert.equal(estadoDaEscrita(undefined).codigo, "CONCESSOES_BLOQUEADAS");
  });
});

describe("formulário de concessão", () => {
  test("válido", () => assert.deepEqual(validarFormularioConcessao(ok, { perfis }), { ok: true, erros: [] }));
  test("autoconcessão é recusada na tela (e no servidor)", () => {
    const r = validarFormularioConcessao({ ...ok, perfilId: "eu" }, { perfis });
    assert.equal(r.ok, false); assert.match(r.erros[0], /Autoconcessão/);
  });
  test("perfil fora da lista de elegíveis, nível inválido, motivo curto e expiração passada", () => {
    assert.match(validarFormularioConcessao({ ...ok, perfilId: "outro" }, { perfis }).erros[0], /perfil/i);
    assert.equal(validarFormularioConcessao({ ...ok, nivel: "root" }, { perfis }).ok, false);
    assert.equal(validarFormularioConcessao({ ...ok, motivo: "curto" }, { perfis }).ok, false);
    assert.equal(validarFormularioConcessao({ ...ok, expiraEm: "2020-01-01" }, { perfis }).ok, false);
    assert.equal(validarFormularioConcessao({ ...ok, expiraEm: "2099-01-01" }, { perfis }).ok, true);
  });
  test("o corpo enviado nunca leva concedente e normaliza a expiração", () => {
    const c = montarCorpoConcessao({ organizacaoId: "o", unidadeId: "u", ...ok, motivo: "  Motivo válido aqui  ", expiraEm: "2099-01-01", somenteFinanceiro: true, concedidaPor: "x" });
    assert.equal(c.motivo, "Motivo válido aqui"); assert.equal(c.somenteFinanceiro, true);
    assert.ok(!("concedidaPor" in c) && !("concedida_por" in c));
    assert.match(c.expiraEm, /^2099-01-0\dT/);
  });
  test("três níveis oferecidos", () => assert.deepEqual(NIVEIS.map((n) => n.valor), ["leitura", "operador", "gestor"]));
});

describe("situação e revogação", () => {
  const agora = Date.parse("2026-06-01T00:00:00Z");
  test("revogada > expirada > ativa (calculado quando o servidor não envia)", () => {
    assert.equal(situacaoDe({ revogada_em: "2026-01-01", expira_em: "2020-01-01" }, agora), "revogada");
    assert.equal(situacaoDe({ expira_em: "2026-05-01T00:00:00Z" }, agora), "expirada");
    assert.equal(situacaoDe({ expira_em: "2026-07-01T00:00:00Z" }, agora), "ativa");
    assert.equal(situacaoDe({ situacao: "revogada" }, agora), "revogada");
  });
  test("revogada não pode ser revogada de novo; expirada ainda pode (limpa o registro)", () => {
    assert.equal(podeRevogar({ revogada_em: "2026-01-01" }), false);
    assert.equal(podeRevogar({ expira_em: "2020-01-01" }), true);
  });
  test("motivo da revogação exige 10+ caracteres", () => {
    assert.equal(validarMotivoRevogacao("curto").ok, false);
    assert.equal(validarMotivoRevogacao("Mudou de função na empresa").ok, true);
  });
});

describe("cliente HTTP usa SÓ os endpoints existentes", () => {
  test("métodos presentes", () => {
    for (const m of ["concessoesEstado", "concessoesLista", "concessoesPerfis", "concessoesAuditoria", "conceder", "revogarConcessao"]) {
      assert.equal(typeof adminApi[m], "function", m);
    }
  });
});
