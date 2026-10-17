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
import { requireFinanceiro, exigirPermissaoFinanceira } from "../src/middlewares/financeiro.js";

const OPS = ["dashboard.ver", "produtos.ver"];
const MODS = ["dashboard", "ifood_dashboard"];
const rodar = async (mw, req) => { let erro; await mw(req, {}, (e) => { erro = e; }); return erro; };
const reqDe = (o = {}) => ({ acesso: acesso(), tenant: T, ...o });

test("setores: só operacional (franqueado atual) não vê financeiro", () => {
  assert.deepEqual(calcularSetores({ permissoes: OPS, modulos: MODS, impersonando: false, financeiroOk: false }), ["operacional"]);
});
test("setores: ambos quando há concessão", () => {
  assert.deepEqual(calcularSetores({ permissoes: OPS, modulos: MODS, impersonando: false, financeiroOk: true }), ["financeiro", "operacional"]);
});
test("setores: exclusivamente financeiro (concessão somente_financeiro)", () => {
  assert.deepEqual(calcularSetores({ permissoes: OPS, modulos: [...MODS, "gestao_financeira"], impersonando: false, financeiroOk: true, somenteFinanceiro: true }), ["financeiro"]);
});
test("setores: sem módulo operacional ou sem permissão operacional => não é operacional", () => {
  assert.deepEqual(calcularSetores({ permissoes: OPS, modulos: ["gestao_financeira"], financeiroOk: true }), ["financeiro"]);
  assert.deepEqual(calcularSetores({ permissoes: ["gestao_financeira.ver", "usuarios.ver"], modulos: MODS, financeiroOk: true }), ["financeiro"]);
});
test("setores: nenhum setor autorizado => lista vazia (sem entrada indevida)", () => {
  assert.deepEqual(calcularSetores({ permissoes: [], modulos: [], financeiroOk: false }), []);
  assert.deepEqual(calcularSetores({}), []);
});
test("setores: impersonação nunca enxerga financeiro", () => {
  assert.deepEqual(calcularSetores({ permissoes: OPS, modulos: MODS, impersonando: true, financeiroOk: true }), ["operacional"]);
});
test("setores: somente_financeiro sem financeiro vigente não esconde o operacional", () => {
  assert.deepEqual(calcularSetores({ permissoes: OPS, modulos: MODS, financeiroOk: false, somenteFinanceiro: true }), ["operacional"]);
});

test("concessão de OUTRA organização não vale no tenant atual", async () => {
  const r = await resolverAcessoFinanceiro(acesso(), T, leitor({ c: conc({ organizacao_id: "o2" }) }));
  assert.equal(r.codigo, "FINANCEIRO_SEM_CONCESSAO");
});
test("concessão de unidade de OUTRA organização não vale", async () => {
  const r = await resolverAcessoFinanceiro(acesso(), { organizacaoId: "o1", unidadeId: "u9" }, leitor({ c: conc({ organizacao_id: "o2", unidade_id: "u9" }) }));
  assert.equal(r.ok, false);
});
test("concessão expirada ou revogada recebida do leitor é recusada", async () => {
  const exp = await resolverAcessoFinanceiro(acesso(), T, leitor({ c: conc({ expira_em: "2020-01-01T00:00:00Z" }) }));
  const rev = await resolverAcessoFinanceiro(acesso(), T, leitor({ c: conc({ revogada_em: "2020-01-01T00:00:00Z" }) }));
  assert.equal(exp.ok, false); assert.equal(rev.ok, false);
});
test("revogação vale na requisição seguinte (sem cache): mesma sessão, leitor passa a devolver null", async () => {
  let c = conc(); const l = { moduloEmpresa: async () => true, moduloUnidade: async () => true, concessao: async () => c };
  assert.equal((await resolverAcessoFinanceiro(acesso(), T, l)).ok, true);
  c = null;
  assert.equal((await resolverAcessoFinanceiro(acesso(), T, l)).ok, false);
});
test("perfil de exibição nunca acessa o financeiro, mesmo com concessão gravada", async () => {
  assert.equal((await resolverAcessoFinanceiro(acesso({ papel: "display_operator" }), T, leitor())).ok, false);
});
test("papel não concede: organization_admin e superadmin-impersonando dependem só da concessão", async () => {
  assert.equal((await resolverAcessoFinanceiro(acesso({ papel: "organization_admin" }), T, leitor({ c: null }))).ok, false);
  assert.equal((await resolverAcessoFinanceiro(acesso({ papel: "organization_admin", impersonando: true }), T, leitor())).ok, false);
});
test("middleware: erro de consulta => 500 e NÃO chama o próximo handler como sucesso", async () => {
  const l = { ...leitor(), moduloEmpresa: async () => { throw new Error("db"); } };
  const erro = await rodar(requireFinanceiro(l), reqDe());
  assert.equal(erro?.statusCode, 500);
});
test("middleware: sem concessão => 403 com código; com concessão => passa e preenche req.financeiro", async () => {
  const req = reqDe();
  const negado = await rodar(requireFinanceiro(leitor({ c: null })), req);
  assert.equal(negado.statusCode, 403); assert.equal(negado.details.codigo, "FINANCEIRO_SEM_CONCESSAO");
  const ok = reqDe();
  assert.equal(await rodar(requireFinanceiro(leitor()), ok), undefined);
  assert.deepEqual(ok.financeiro.permissoes, [PERM_FIN.VER, PERM_FIN.LANCAR]);
  assert.equal(ok.financeiro.organizacaoId, "o1");
});
test("exigirPermissaoFinanceira: leitura não lança; ausência de req.financeiro falha fechada", async () => {
  const leit = { financeiro: { permissoes: [PERM_FIN.VER] } };
  assert.equal((await rodar(exigirPermissaoFinanceira(PERM_FIN.LANCAR), leit)).statusCode, 403);
  assert.equal(await rodar(exigirPermissaoFinanceira(PERM_FIN.VER), leit), undefined);
  assert.equal((await rodar(exigirPermissaoFinanceira(PERM_FIN.VER), {})).statusCode, 403);
});
