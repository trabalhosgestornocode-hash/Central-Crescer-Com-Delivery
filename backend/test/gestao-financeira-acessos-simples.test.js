// Gestão simples de acessos do Financeiro (uma tela por unidade): regras puras — validação do pedido, plano de
// mudanças sobre as concessões ativas e motivo automático da auditoria. Sem banco, sem rede.
// Rodar: node --test test/gestao-financeira-acessos-simples.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validarAcessosDaUnidade, planejarAcessos, motivoAutomatico, MOTIVO_MIN, LIMITE_ACESSOS_POR_GRAVACAO,
} from "../src/modules/gestao-financeira/concessoes.dominio.js";
import { concessoesRouter } from "../src/modules/gestao-financeira/concessoes.routes.js";

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("validação do pedido da tela", () => {
  test("corpo válido: liga/desliga e níveis; 'Sem acesso' vira null", () => {
    const r = validarAcessosDaUnidade({ habilitado: true, acessos: [
      { perfilId: ID(1), nivel: "leitura" }, { perfilId: ID(2), nivel: "gestor" }, { perfilId: ID(3), nivel: null },
      { perfilId: ID(4), nivel: "sem_acesso" }, { perfilId: ID(5), nivel: "" },
    ] });
    assert.equal(r.habilitado, true);
    assert.deepEqual(r.acessos.map((a) => a.nivel), ["leitura", "gestor", null, null, null]);
  });
  test("habilitado precisa ser booleano de verdade", () => {
    for (const h of [undefined, "true", 1, null]) assert.throws(() => validarAcessosDaUnidade({ habilitado: h, acessos: [] }), /Financeiro/);
  });
  test("nível fora do catálogo, perfil inválido, perfil repetido e lista ausente são recusados", () => {
    assert.throws(() => validarAcessosDaUnidade({ habilitado: true, acessos: [{ perfilId: ID(1), nivel: "admin" }] }), /Nível/);
    assert.throws(() => validarAcessosDaUnidade({ habilitado: true, acessos: [{ perfilId: "x", nivel: "leitura" }] }), /Perfil/);
    assert.throws(() => validarAcessosDaUnidade({ habilitado: true, acessos: [{ perfilId: ID(1), nivel: "leitura" }, { perfilId: ID(1), nivel: "gestor" }] }), /mais de uma vez/);
    assert.throws(() => validarAcessosDaUnidade({ habilitado: true }), /lista/);
    assert.throws(() => validarAcessosDaUnidade(null));
  });
  test("limite de usuários por gravação", () => {
    const muitos = Array.from({ length: LIMITE_ACESSOS_POR_GRAVACAO + 1 }, (_, i) => ({ perfilId: ID(i + 1), nivel: null }));
    assert.throws(() => validarAcessosDaUnidade({ habilitado: true, acessos: muitos }), /No máximo/);
  });
  test("campos extras (concedente, unidade, organização) não passam adiante", () => {
    const r = validarAcessosDaUnidade({ habilitado: false, concedidaPor: ID(9), acessos: [{ perfilId: ID(1), nivel: "operador", concedida_por: ID(9), unidadeId: ID(7) }] });
    assert.deepEqual(r, { habilitado: false, acessos: [{ perfilId: ID(1), nivel: "operador" }] });
  });
});

describe("plano de mudanças", () => {
  const elegiveis = [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "p4" }];
  const ativas = [{ id: "c2", perfil_id: "p2", nivel: "leitura" }, { id: "c3", perfil_id: "p3", nivel: "gestor" }, { id: "cx", perfil_id: "px", nivel: "operador" }];

  test("conceder, alterar, revogar e manter numa única passada", () => {
    const p = planejarAcessos({ ativas, elegiveis, pedido: [
      { perfilId: "p1", nivel: "operador" },  // sem concessão -> conceder
      { perfilId: "p2", nivel: "gestor" },    // leitura -> gestor
      { perfilId: "p3", nivel: null },        // gestor -> sem acesso
      { perfilId: "p4", nivel: null },        // já sem acesso
    ] });
    assert.deepEqual(p.conceder, [{ perfilId: "p1", nivel: "operador" }]);
    assert.deepEqual(p.alterar, [{ concessaoId: "c2", perfilId: "p2", de: "leitura", para: "gestor" }]);
    assert.deepEqual(p.revogar, [{ concessaoId: "c3", perfilId: "p3", de: "gestor" }]);
    assert.equal(p.inalterados, 1);
  });
  test("mesmo nível não gera escrita; perfil ausente do pedido não é tocado", () => {
    const p = planejarAcessos({ ativas, elegiveis, pedido: [{ perfilId: "p3", nivel: "gestor" }] });
    assert.deepEqual([p.conceder.length, p.alterar.length, p.revogar.length, p.inalterados], [0, 0, 0, 1]);
  });
  test("perfil fora da unidade nunca recebe acesso (recusa a gravação inteira)", () => {
    assert.throws(() => planejarAcessos({ ativas, elegiveis, pedido: [{ perfilId: "intruso", nivel: "leitura" }] }),
      (e) => e.statusCode === 400 && e.details.codigo === "PERFIL_NAO_ELEGIVEL");
    // ...nem ganha nível novo por ter tido concessão antes de perder o vínculo
    assert.throws(() => planejarAcessos({ ativas, elegiveis, pedido: [{ perfilId: "px", nivel: "gestor" }] }), /vínculo/);
  });
  test("acesso de quem perdeu o vínculo pode ser removido", () => {
    const p = planejarAcessos({ ativas, elegiveis, pedido: [{ perfilId: "px", nivel: null }] });
    assert.deepEqual(p.revogar, [{ concessaoId: "cx", perfilId: "px", de: "operador" }]);
  });
});

describe("motivo automático da auditoria", () => {
  const ator = { id: ID(9), email: "dono@exemplo.invalid" };
  test("cada ação tem texto próprio, com quem fez, sempre acima do mínimo do banco", () => {
    for (const [acao, nivel] of [["conceder", "leitura"], ["alterar", "gestor"], ["revogar", null]]) {
      const m = motivoAutomatico(acao, ator, nivel);
      assert.ok(m.length >= MOTIVO_MIN, m); assert.match(m, /dono@exemplo\.invalid/);
    }
    assert.match(motivoAutomatico("revogar", ator), /removido/);
    assert.match(motivoAutomatico("alterar", ator, "gestor"), /gestor/);
  });
  test("sem e-mail usa o id da conta", () => {
    assert.match(motivoAutomatico("conceder", { id: ID(9) }, "operador"), new RegExp(ID(9)));
  });
});

describe("rotas da gestão simples", () => {
  const rotas = concessoesRouter.stack.filter((c) => c.route).map((c) => ({ caminho: c.route.path, metodos: Object.keys(c.route.methods), pilha: c.route.stack.map((s) => s.name) }));
  test("GET e PUT por unidade existem", () => {
    assert.ok(rotas.some((r) => r.caminho === "/unidades/:unidadeId/acessos" && r.metodos.includes("get")));
    assert.ok(rotas.some((r) => r.caminho === "/unidades/:unidadeId/acessos" && r.metodos.includes("put")));
  });
  test("toda ESCRITA passa pela chave geral (exigirLiberacaoDeConcessoes)", () => {
    for (const r of rotas.filter((x) => x.metodos.some((m) => ["post", "put", "patch", "delete"].includes(m)))) {
      assert.ok(r.pilha.includes("exigirLiberacaoDeConcessoes"), `${r.metodos} ${r.caminho}`);
    }
  });
});
