import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { avaliarMfaRecente, carimboDeSegundoFator, JANELA_MFA_RECENTE_MS } from "../src/shared/mfaRecente.js";
import {
  avaliarLiberacaoDeConcessoes, validarNovaConcessao, validarRevogacao, garantirSemAutoconcessao,
} from "../src/modules/gestao-financeira/concessoes.dominio.js";
import { exigirLiberacaoDeConcessoes } from "../src/modules/gestao-financeira/concessoes.routes.js";

const U = (o = {}) => ({ aal: "aal2", mfaEm: Date.now() - 60_000, ...o });
const ON = { FINANCEIRO_CONCESSOES_HABILITADAS: "true" };
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const corpoOk = () => ({ organizacaoId: ID(1), unidadeId: ID(2), perfilId: ID(3), nivel: "operador", motivo: "Contratação do analista financeiro" });

describe("MFA recente", () => {
  test("extrai o 2º fator mais recente do amr (timestamps em segundos)", () => {
    const amr = [{ method: "password", timestamp: 1000 }, { method: "totp", timestamp: 1500 }, { method: "totp", timestamp: 1200 }];
    assert.equal(carimboDeSegundoFator(amr), 1_500_000);
    assert.equal(carimboDeSegundoFator([{ method: "password", timestamp: 1000 }]), null);
    assert.equal(carimboDeSegundoFator(undefined), null);
    assert.equal(carimboDeSegundoFator(["totp"]), null);
  });
  test("AAL2 com 2º fator dentro de 10 min passa", () => {
    assert.deepEqual(avaliarMfaRecente(U()), { ok: true });
  });
  test("aal1 => MFA_REQUERIDA, mesmo com mfaEm recente", () => {
    assert.equal(avaliarMfaRecente(U({ aal: "aal1" })).codigo, "MFA_REQUERIDA");
    assert.equal(avaliarMfaRecente({}).codigo, "MFA_REQUERIDA");
  });
  test("2º fator antigo, ausente ou no futuro => REAUTENTICACAO_RECENTE", () => {
    const agora = Date.now();
    assert.equal(avaliarMfaRecente(U({ mfaEm: agora - JANELA_MFA_RECENTE_MS - 1000 }), agora).codigo, "REAUTENTICACAO_RECENTE");
    assert.equal(avaliarMfaRecente(U({ mfaEm: null })).codigo, "REAUTENTICACAO_RECENTE");
    assert.equal(avaliarMfaRecente(U({ mfaEm: agora + 3_600_000 }), agora).codigo, "REAUTENTICACAO_RECENTE");
  });
});

describe("liberação dos endpoints de concessão (falha fechada)", () => {
  test("sem a flag, bloqueia mesmo com AAL2 recente", () => {
    const r = avaliarLiberacaoDeConcessoes(U(), {});
    assert.equal(r.ok, false); assert.equal(r.codigo, "CONCESSOES_BLOQUEADAS"); assert.equal(r.status, 403);
  });
  test("flag com valor diferente de 'true' continua bloqueando", () => {
    for (const x of ["1", "TRUE", "yes", ""]) assert.equal(avaliarLiberacaoDeConcessoes(U(), { FINANCEIRO_CONCESSOES_HABILITADAS: x }).ok, false);
  });
  test("com a flag, ainda exige MFA recente", () => {
    assert.equal(avaliarLiberacaoDeConcessoes(U({ aal: "aal1" }), ON).codigo, "MFA_REQUERIDA");
    assert.equal(avaliarLiberacaoDeConcessoes(U({ mfaEm: 1 }), ON).codigo, "REAUTENTICACAO_RECENTE");
    assert.equal(avaliarLiberacaoDeConcessoes(U(), ON).ok, true);
  });
  test("middleware: por padrão (sem env) devolve 403 CONCESSOES_BLOQUEADAS e não chama o handler", () => {
    const antes = process.env.FINANCEIRO_CONCESSOES_HABILITADAS;
    delete process.env.FINANCEIRO_CONCESSOES_HABILITADAS;
    try {
      let erro; exigirLiberacaoDeConcessoes({ user: U() }, {}, (e) => { erro = e; });
      assert.equal(erro.statusCode, 403); assert.equal(erro.details.codigo, "CONCESSOES_BLOQUEADAS");
    } finally { if (antes !== undefined) process.env.FINANCEIRO_CONCESSOES_HABILITADAS = antes; }
  });
});

describe("validação da concessão", () => {
  test("corpo válido é normalizado e carrega o concedente", () => {
    const r = validarNovaConcessao(corpoOk(), ID(9));
    assert.equal(r.nivel, "operador"); assert.equal(r.concedida_por, ID(9)); assert.equal(r.somente_financeiro, false); assert.equal(r.expira_em, null);
  });
  test("motivo curto, nível inválido, uuid inválido e expiração no passado são recusados", () => {
    assert.throws(() => validarNovaConcessao({ ...corpoOk(), motivo: "curto" }, ID(9)), /Motivo/);
    assert.throws(() => validarNovaConcessao({ ...corpoOk(), nivel: "root" }, ID(9)), /Nível/);
    assert.throws(() => validarNovaConcessao({ ...corpoOk(), perfilId: "x" }, ID(9)), /Perfil/);
    assert.throws(() => validarNovaConcessao({ ...corpoOk(), expiraEm: "2020-01-01" }, ID(9)), /Expiração/);
    assert.throws(() => validarNovaConcessao(null, ID(9)));
  });
  test("expiração futura é aceita e normalizada em ISO", () => {
    const r = validarNovaConcessao({ ...corpoOk(), expiraEm: "2099-01-01T00:00:00Z" }, ID(9));
    assert.equal(r.expira_em, "2099-01-01T00:00:00.000Z");
  });
  test("o cliente não consegue forçar o concedente nem o concedido_em", () => {
    const r = validarNovaConcessao({ ...corpoOk(), concedida_por: ID(7), concedidaPor: ID(7) }, ID(9));
    assert.equal(r.concedida_por, ID(9));
  });
  test("autoconcessão proibida; perfil inexistente => 404", () => {
    assert.throws(() => garantirSemAutoconcessao(ID(9), ID(9)), (e) => e.statusCode === 403 && e.details.codigo === "AUTOCONCESSAO_PROIBIDA");
    assert.throws(() => garantirSemAutoconcessao(null, ID(9)), (e) => e.statusCode === 404);
    assert.doesNotThrow(() => garantirSemAutoconcessao(ID(8), ID(9)));
  });
  test("revogação exige motivo", () => {
    assert.throws(() => validarRevogacao({}), /Motivo/);
    assert.throws(() => validarRevogacao({ motivo: "curto" }), /Motivo/);
    assert.equal(validarRevogacao({ motivo: "Mudou de função na empresa" }).motivo, "Mudou de função na empresa");
  });
});

import { situacaoDaConcessao, montarPerfisElegiveis } from "../src/modules/gestao-financeira/concessoes.dominio.js";
describe("situação e elegibilidade (tela do SuperAdmin)", () => {
  test("revogada vence expirada; expirada vence ativa", () => {
    const agora = Date.parse("2026-06-01T00:00:00Z");
    assert.equal(situacaoDaConcessao({ revogada_em: "2026-01-01", expira_em: "2020-01-01" }, agora), "revogada");
    assert.equal(situacaoDaConcessao({ expira_em: "2026-05-01T00:00:00Z" }, agora), "expirada");
    assert.equal(situacaoDaConcessao({ expira_em: "2026-07-01T00:00:00Z" }, agora), "ativa");
    assert.equal(situacaoDaConcessao({}, agora), "ativa");
  });
  test("elegíveis: só perfil ativo com vínculo ativo; exibição fora; própria conta marcada", () => {
    const r = montarPerfisElegiveis({
      perfis: [{ id: "p1", conta_id: "c1", nome: "Ana" }, { id: "p2", conta_id: "c2", nome: "TV" }, { id: "p3", conta_id: "c3", nome: "Sem vínculo" }, { id: "p4", conta_id: "c4", nome: "Eu" }, { id: "p5", conta_id: "c5", nome: "Inativo" }],
      contas: { c1: { email: "ana@x" }, c4: { email: "eu@x" } },
      vinculosUnidade: [{ usuario_id: "c1", papel: null, ativo: true }, { usuario_id: "c2", papel: "display_operator", ativo: true }, { usuario_id: "c5", papel: "viewer", ativo: false }],
      vinculosEmpresa: [{ usuario_id: "c4", papel: "organization_admin", ativo: true }],
    }, "c4");
    assert.deepEqual(r.map((p) => [p.id, p.propria]), [["p1", false], ["p4", true]]);
  });
  test("conta só com vínculo de exibição não é elegível", () => {
    const r = montarPerfisElegiveis({ perfis: [{ id: "p", conta_id: "c", nome: "TV" }], contas: {}, vinculosUnidade: [{ usuario_id: "c", papel: "display_operator", ativo: true }], vinculosEmpresa: [] }, "x");
    assert.deepEqual(r, []);
  });
});
