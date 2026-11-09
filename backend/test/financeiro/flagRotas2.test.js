// Garantia de publicação: com a feature flag do Financeiro 2.0 DESLIGADA (padrão), toda rota que depende das migrations 152–155 responde 404 e
// NENHUMA rota sem trava toca tabela/coluna/função dessas migrations. O backend pode então ser implantado antes ou depois das migrations sem efeito para ninguém.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { criarDominioRouter } from "../../src/modules/gestao-financeira/dominio/rotas.js";

const passa = () => (_req, _res, next) => next();
const router = criarDominioRouter({ autorizar: passa, deps: { repo: {}, db: undefined }, financeiro2: () => false });
const rotas = router.stack.filter((l) => l.route).map((l) => ({ metodos: Object.keys(l.route.methods).join(","), caminho: l.route.path, camadas: l.route.stack.map((x) => x.handle.name) }));
const SEM_TRAVA_PERMITIDAS = /^\/(plano-contas|contas|aberturas|lancamentos|transferencias|relatorios|importacoes|conciliacao|periodos|fornecedores|configuracoes|auditoria)(\/|$)/;
const NOVAS = ["/painel", "/busca", "/receitas", "/dre-referencia", "/conferencias", "/vendas-canal", "/vendas-ajustes", "/vendas-diarias", "/rateios", "/recebiveis", "/recebimentos", "/dividas", "/divida-eventos",
  "/contas-pagar", "/conciliacao-saidas", "/transferencias/multiplas", "/transferencias/vincular-multipla", "/pendencias-documentais"];

test("toda rota do Financeiro 2.0 (inclusive a conciliação 1:N) está atrás da flag", () => {
  const novas = rotas.filter((r) => NOVAS.some((p) => r.caminho === p || r.caminho.startsWith(p + "/") || r.caminho.startsWith(p + ":")));
  assert.ok(novas.length >= 30, `rotas novas encontradas: ${novas.length}`);
  const sem = novas.filter((r) => !r.camadas.includes("so2")).map((r) => `${r.metodos} ${r.caminho}`);
  assert.deepEqual(sem, [], `rotas do Financeiro 2.0 SEM a trava da flag: ${sem.join("; ")}`);
});

test("nenhuma rota sem trava é nova: só as do núcleo 120–122 (que já existem em produção)", () => {
  const livres = rotas.filter((r) => !r.camadas.includes("so2"));
  const fora = livres.filter((r) => !SEM_TRAVA_PERMITIDAS.test(r.caminho)).map((r) => `${r.metodos} ${r.caminho}`);
  assert.deepEqual(fora, [], `rota sem trava fora do núcleo: ${fora.join("; ")}`);
  const multipla = livres.filter((r) => /multipla/.test(r.caminho));
  assert.deepEqual(multipla, [], "a conciliação 1:N não pode ficar sem a trava da flag");
});

test("o código das rotas sem trava não referencia objetos das migrations 153–155", () => {
  const dir = fileURLToPath(new URL("../../src/modules/gestao-financeira/dominio/", import.meta.url));
  for (const f of ["relatorios.service.js", "tabelas.service.js", "conciliacao.service.js", "periodos.service.js", "importacao.service.js"]) {
    let t = ""; try { t = readFileSync(dir + f, "utf8"); } catch { continue; }
    assert.doesNotMatch(t, /fin_vendas_canal|fin_vendas_ajustes|fin_transferencias_multiplas|origem_pagamento|terceiro_nome/, `${f} usa objetos das migrations 153–155`);
  }
});
