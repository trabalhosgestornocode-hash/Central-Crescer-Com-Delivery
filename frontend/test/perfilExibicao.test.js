// Perfil de EXIBIÇÃO no frontend — regra pura (menu/rotas/entrada) e a ligação dela no router e no app.
// (A autorização de verdade é do backend: `restringirPerfilExibicao`. Aqui é só não oferecer o que a API recusa.)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAPEL_EXIBICAO, ROTAS_DO_PERFIL_EXIBICAO, ehPerfilExibicao, itemPermitidoAoPerfil, rotaInicialDoPerfil,
} from "../src/perfilExibicao.js";
import { MENU } from "../src/config.js";

const SRC = resolve(fileURLToPath(new URL("../src", import.meta.url)));
const ler = (f) => readFileSync(resolve(SRC, f), "utf8");
const exibicao = { papel: "display_operator", permissoes: ["checklist.visualizar"], modulos: ["ifood"] };

describe("perfil de exibição — regra pura", () => {
  test("o papel é o mesmo do backend e só reconhece ESSE papel", () => {
    assert.equal(PAPEL_EXIBICAO, "display_operator");
    assert.equal(ehPerfilExibicao(exibicao), true);
    for (const papel of ["organization_admin", "unit_manager", "finance", "operations", "viewer", undefined, null, "", "Display_Operator"]) {
      assert.equal(ehPerfilExibicao({ papel }), false, String(papel));
    }
    assert.equal(ehPerfilExibicao(null), false);
    assert.equal(ehPerfilExibicao(undefined), false);
  });

  test("de TODO o menu, o perfil de exibição enxerga UM item: o Checklist Operacional", () => {
    const permitidos = MENU.filter((m) => itemPermitidoAoPerfil(m, exibicao)).map((m) => m.id);
    assert.deepEqual(permitidos, ["checklist-operacional"]);
    assert.deepEqual([...ROTAS_DO_PERFIL_EXIBICAO], ["checklist-operacional"]);
    assert.ok(Object.isFrozen(ROTAS_DO_PERFIL_EXIBICAO));
    assert.ok(MENU.length > 10, "o menu real tem muitos itens que ele NÃO vê");
  });

  test("nada administrativo ou financeiro passa: dashboard, vendas, CMV, bonificação, parser, integrações, configurações, agente", () => {
    for (const id of ["dashboard", "produtos", "insumos", "estoque", "vendas", "dashboard-executivo", "bonificacao-mensal", "parser-food-delivery",
      "martinbrower", "ifood", "ia", "relatorios", "integracoes", "configuracoes"]) {
      const item = MENU.find((m) => m.id === id);
      assert.ok(item, `item ${id} existe no menu`);
      assert.equal(itemPermitidoAoPerfil(item, exibicao), false, id);
    }
  });

  test("para os OUTROS papéis nada muda: todo item continua permitido por esta regra", () => {
    for (const papel of ["organization_admin", "unit_manager", "finance", "operations", "viewer"]) {
      for (const m of MENU) assert.equal(itemPermitidoAoPerfil(m, { papel }), true, `${papel} ${m.id}`);
    }
    assert.equal(itemPermitidoAoPerfil(MENU[0], undefined), true);
  });

  test("rota de entrada: Checklist para o perfil de exibição; nenhuma imposição para os demais", () => {
    assert.equal(rotaInicialDoPerfil(exibicao), "checklist-operacional");
    for (const papel of ["organization_admin", "unit_manager", "viewer", undefined]) assert.equal(rotaInicialDoPerfil({ papel }), null);
    assert.equal(rotaInicialDoPerfil(null), null);
  });

  test("o Checklist está de fato no menu (a rota de entrada existe)", () => {
    assert.ok(MENU.some((m) => m.id === "checklist-operacional" && m.tipo === "checklist-operacional"));
  });
});

describe("perfil de exibição — ligação no router e no app", () => {
  const router = ler("router.js");
  const app = ler("app.js");

  test("router.js: o perfil de exibição só alcança o Checklist e a entrada cai nele", () => {
    assert.match(router, /import \{ ehPerfilExibicao, itemPermitidoAoPerfil, rotaInicialDoPerfil \} from "\.\/perfilExibicao\.js"/);
    const acessivel = router.slice(router.indexOf("const acessivel = (item) => {"), router.indexOf("export function primeiraRotaAcessivel"));
    assert.match(acessivel, /if \(ehPerfilExibicao\(state\.sessao\)\) return itemPermitidoAoPerfil\(item, state\.sessao\);/);
    assert.ok(acessivel.indexOf("ehPerfilExibicao") < acessivel.indexOf("SECAO_MODULO"), "a regra do perfil vem ANTES da regra de módulo");
    assert.match(router, /return rotaInicialDoPerfil\(state\.sessao\) \?\? MENU\.find\(acessivel\)\?\.id \?\? "configuracoes";/);
  });

  test("app.js: o menu filtra pelo perfil e esconde troca de empresa/usuário, atualizar e alertas", () => {
    assert.match(app, /exibicao \? itemPermitidoAoPerfil\(m, state\.sessao\)/);
    assert.match(app, /el\("#um-trocar"\)\.hidden = !!impersonando \|\| exibicao;/);
    assert.match(app, /el\("#um2-empresas"\)\.hidden = exibicao;/);
    assert.match(app, /for \(const id of \["#btn-refresh", "#btn-notif"\]\) \{ const n = el\(id\); if \(n\) n\.hidden = exibicaoTopo; \}/);
    assert.match(app, /btnAgente\.hidden = exibicaoTopo \|\| /);
  });

  test("app.js: o shell mínimo do perfil de exibição vem ANTES de qualquer carga que o backend recusaria", () => {
    const mostrarApp = app.slice(app.indexOf("async function mostrarApp"), app.indexOf("// ---------- tela: seleção de unidade ----------"));
    const iBranch = mostrarApp.indexOf("if (ehPerfilExibicao(state.sessao)) {");
    assert.ok(iBranch > 0, "existe o ramo do perfil de exibição");
    for (const carga of ["obterTabelasComerciaisUnidade()", "obterMetasCmvUnidade()", "return carregar()", "montarPainelGlobal()", "popularTabelas()"]) {
      assert.ok(mostrarApp.indexOf(carga) > iBranch, `${carga} só roda depois do ramo (para o perfil de exibição não roda)`);
    }
    const ramo = mostrarApp.slice(iBranch, mostrarApp.indexOf("// Restaura o modo de comparação"));
    assert.match(ramo, /irPara\(rotaInicialDoPerfil\(state\.sessao\)\)/);
    assert.match(ramo, /return;/);
    assert.doesNotMatch(ramo, /carregar\(|obterTabelas|obterMetas|montarPainelGlobal/);
  });
});
