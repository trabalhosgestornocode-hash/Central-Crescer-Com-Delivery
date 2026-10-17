import { test } from "node:test";
import assert from "node:assert/strict";
import { PERMISSOES, permissoesDoPapel } from "../src/shared/permissoes.js";
import { PERM_FIN, concessaoVigente, permissoesDoNivelFinanceiro } from "../src/shared/gestaoFinanceira.permissoes.js";
import { resolverAcessoFinanceiro } from "../src/middlewares/financeiro.js";

const T = { organizacaoId: "o1", unidadeId: "u1" };
const conc = (o = {}) => ({ organizacao_id: "o1", unidade_id: "u1", nivel: "operador", revogada_em: null, expira_em: null, ...o });
const leitor = ({ emp = true, uni = true, c = conc() } = {}) => ({
  moduloEmpresa: async () => emp, moduloUnidade: async () => uni, concessao: async () => c,
});
const acesso = (o = {}) => ({ perfilId: "p1", impersonando: false, papel: "organization_admin", ...o });

test("organization_admin NÃO herda permissões financeiras", () => {
  assert.ok(!Object.values(PERMISSOES).some((p) => p.startsWith("gestao_financeira.")));
  assert.ok(!permissoesDoPapel("organization_admin").some((p) => p.startsWith("gestao_financeira.")));
});

test("concessão válida libera conforme o nível", async () => {
  const r = await resolverAcessoFinanceiro(acesso(), T, leitor());
  assert.equal(r.ok, true);
  assert.deepEqual(r.permissoes, [PERM_FIN.VER, PERM_FIN.LANCAR]);
});

test("admin sem concessão é barrado", async () => {
  assert.equal((await resolverAcessoFinanceiro(acesso(), T, leitor({ c: null }))).codigo, "FINANCEIRO_SEM_CONCESSAO");
});

test("impersonação bloqueada mesmo com tudo habilitado", async () => {
  assert.equal((await resolverAcessoFinanceiro(acesso({ impersonando: true }), T, leitor())).codigo, "FINANCEIRO_BLOQUEADO_IMPERSONACAO");
});

test("empresa ou unidade sem o módulo bloqueia", async () => {
  assert.equal((await resolverAcessoFinanceiro(acesso(), T, leitor({ emp: false }))).codigo, "FINANCEIRO_NAO_HABILITADO");
  assert.equal((await resolverAcessoFinanceiro(acesso(), T, leitor({ uni: false }))).codigo, "FINANCEIRO_NAO_HABILITADO");
});

test("revogada, expirada, outra unidade/org e nível inválido não valem", () => {
  assert.equal(concessaoVigente(conc({ revogada_em: "2026-01-01" }), T), false);
  assert.equal(concessaoVigente(conc({ expira_em: "2026-01-01" }), T, Date.parse("2026-02-01")), false);
  assert.equal(concessaoVigente(conc({ unidade_id: "u2" }), T), false);
  assert.equal(concessaoVigente(conc({ organizacao_id: "o2" }), T), false);
  assert.equal(concessaoVigente(conc({ nivel: "root" }), T), false);
  assert.deepEqual(permissoesDoNivelFinanceiro("root"), []);
});

test("sem unidade (consolidado) ou sem perfil falha fechada", async () => {
  assert.equal((await resolverAcessoFinanceiro(acesso(), { ...T, unidadeId: null }, leitor())).ok, false);
  assert.equal((await resolverAcessoFinanceiro(acesso({ perfilId: null }), T, leitor())).ok, false);
});

test("erro de leitura propaga (o middleware responde 500, nunca libera)", async () => {
  const l = { ...leitor(), concessao: async () => { throw new Error("db"); } };
  await assert.rejects(resolverAcessoFinanceiro(acesso(), T, l));
});

import { calcularSetores } from "../src/shared/setores.js";
test("setores: operacional puro, ambos, impersonação sem financeiro", () => {
  assert.deepEqual(calcularSetores({ permissoes: ["dashboard.ver"], impersonando: false, financeiroOk: false }), ["operacional"]);
  assert.deepEqual(calcularSetores({ permissoes: ["dashboard.ver"], impersonando: false, financeiroOk: true }), ["financeiro", "operacional"]);
  assert.deepEqual(calcularSetores({ permissoes: ["dashboard.ver"], impersonando: true, financeiroOk: true }), ["operacional"]);
  assert.deepEqual(calcularSetores({ permissoes: [], impersonando: false, financeiroOk: true }), ["financeiro"]);
});
