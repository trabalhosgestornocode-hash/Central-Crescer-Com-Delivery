// Achado L-1 (auditoria do Agente 2): os SETORES de navegação de TODOS os usuários (GET /api/v1/sessao/setores) dependem
// da concessão do financeiro ANTIGO (`gestao_financeira_concessoes`). Estes testes fixam, com perfis sintéticos:
//   - o escopo operacional de cada perfil hoje;
//   - que "somente financeiro" só vale enquanto a concessão antiga existe (comportamento INTENCIONAL — por isso a
//     remoção do legado sem uma fonte substituta devolveria o setor operacional a esses usuários);
//   - que a falta da tabela antiga FALHA FECHADO (erro, nunca setor a mais);
//   - um ALARME: se a fonte de "somente financeiro" mudar ou sumir, este arquivo falha até o plano 24b ser atualizado.
// Nada aqui apaga ou altera o legado. A remoção é a fase F5/F6 do doc 24b, com autorização própria.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PERMISSOES as P } from "../src/shared/permissoes.js";
import { calcularSetores } from "../src/shared/setores.js";
import { resolverAcessoFinanceiro } from "../src/middlewares/financeiro.js";

const T = { organizacaoId: "o1", unidadeId: "u1" };
const MODS = ["dashboard", "produtos", "gestao_financeira"];
const OPS = [P.DASHBOARD_VER, P.PRODUTOS_VER];
const conc = (o = {}) => ({ organizacao_id: "o1", unidade_id: "u1", nivel: "operador", revogada_em: null, expira_em: null, somente_financeiro: false, ...o });
const leitor = (c) => ({ moduloEmpresa: async () => true, moduloUnidade: async () => true, concessao: async () => c });
/** O que a rota de setores faz (sessao.controller.js), com o leitor sintético no lugar do banco. */
async function setoresDe(perfil, c) {
  const acesso = { perfilId: "p1", impersonando: false, papel: perfil.papel ?? "unit_manager", permissoes: perfil.permissoes, modulos: perfil.modulos ?? MODS, ...perfil.acesso };
  const fin = await resolverAcessoFinanceiro(acesso, T, leitor(c));
  return calcularSetores({ permissoes: acesso.permissoes, modulos: acesso.modulos, impersonando: acesso.impersonando, financeiroOk: fin.ok, somenteFinanceiro: fin.ok && fin.somenteFinanceiro });
}

const PERFIS = {
  operadorDaLoja: { permissoes: OPS },
  gerenteComFinanceiro: { permissoes: OPS },
  somenteFinanceiro: { permissoes: OPS }, // tem permissões operacionais no perfil, mas a concessão restringe
  exibicaoTv: { papel: "display_operator", permissoes: [P.CHECKLIST_VISUALIZAR] },
  suporteImpersonando: { permissoes: OPS, acesso: { impersonando: true } },
};

test("L-1 — perfis sintéticos: escopo de navegação HOJE (com a concessão antiga)", async () => {
  assert.deepEqual(await setoresDe(PERFIS.operadorDaLoja, null), ["operacional"]);
  assert.deepEqual(await setoresDe(PERFIS.gerenteComFinanceiro, conc()), ["financeiro", "operacional"]);
  assert.deepEqual(await setoresDe(PERFIS.somenteFinanceiro, conc({ somente_financeiro: true })), ["financeiro"], "exclusivamente financeiro NÃO vê o operacional");
  assert.deepEqual(await setoresDe(PERFIS.exibicaoTv, conc()), ["operacional"], "TV da loja nunca vê o financeiro");
  assert.deepEqual(await setoresDe(PERFIS.suporteImpersonando, conc({ somente_financeiro: true })), ["operacional"], "impersonação nunca vê o financeiro");
});

test("L-1 — RISCO fixado: sem a concessão antiga, o usuário 'somente financeiro' passa a ver o operacional", async () => {
  // Revogar ou APAGAR a linha da concessão antiga tem o mesmo efeito. É por isso que a remoção do legado (24b F5/F6)
  // exige antes uma fonte substituta de "somente financeiro" (decisão D-24b-1/D-24b-6) e o teste de aceite P17.
  assert.deepEqual(await setoresDe(PERFIS.somenteFinanceiro, conc({ somente_financeiro: true, revogada_em: "2026-11-01" })), ["operacional"]);
  assert.deepEqual(await setoresDe(PERFIS.somenteFinanceiro, null), ["operacional"]);
});

test("L-1 — tabela antiga ausente FALHA FECHADO: erro na rota (500), nunca setor a mais", async () => {
  const sumiu = { moduloEmpresa: async () => true, moduloUnidade: async () => true, concessao: async () => { throw Object.assign(new Error('relation "gestao_financeira_concessoes" does not exist'), { code: "42P01" }); } };
  await assert.rejects(resolverAcessoFinanceiro({ perfilId: "p1", impersonando: false, papel: "unit_manager" }, T, sumiu), (e) => e.code === "42P01");
});

test("L-1 — ALARME: a fonte de 'somente financeiro' continua sendo a concessão antiga (mudou? atualize o 24b e o P17)", () => {
  const ler = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  assert.match(ler("../src/middlewares/financeiro.js"), /from\("gestao_financeira_concessoes"\)[\s\S]*somente_financeiro/);
  assert.match(ler("../src/modules/sessao/sessao.controller.js"), /resolverAcessoFinanceiro\(req\.acesso, req\.tenant\)[\s\S]*somenteFinanceiro: fin\.ok && fin\.somenteFinanceiro/);
  assert.match(ler("../src/shared/setores.js"), /from "\.\/gestaoFinanceira\.permissoes\.js"/);
  assert.match(ler("../../docs/financeiro-v2/24b-substituicao-financeiro-antigo.md"), /L-1/, "o plano de substituição registra a dependência L-1");
});
