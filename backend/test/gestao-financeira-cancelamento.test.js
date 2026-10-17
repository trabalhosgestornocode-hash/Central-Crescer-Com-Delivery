// Permissão `gestao_financeira.cancelar` (A7.1): matriz por nível + comportamento obrigatório do cancelamento, com o GATE REAL
// e o DOMÍNIO REAL (repositório em memória, dados sintéticos, HTTP em loopback). Banco real: ver ciclo SQL do checkpoint.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { PERMISSOES } from "../src/shared/permissoes.js";
import { PERM_FIN, PERMISSOES_FINANCEIRAS, permissoesDoNivelFinanceiro, NIVEIS_FINANCEIRO } from "../src/shared/gestaoFinanceira.permissoes.js";
import { requireFinanceiro, autorizarAcaoFinanceira } from "../src/middlewares/financeiro.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";

const { criarDominioRouter } = await import("../src/modules/gestao-financeira/dominio/rotas.js");
const { ACAO } = await import("../src/modules/gestao-financeira/dominio/contexto.js");
const cadastros = await import("../src/modules/gestao-financeira/dominio/cadastros.service.js");
const lanc = await import("../src/modules/gestao-financeira/dominio/lancamentos.service.js");
const { criarRepoMemoria } = await import("./financeiro/helpers/repoMemoria.js");

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = U(1), UNI = U(2), ORG_B = U(3), UNI_B = U(4), PERFIL = U(5), USER = U(6);

describe("matriz de permissões (catálogo financeiro)", () => {
  test("`cancelar` existe com o nome exato e é INDEPENDENTE de `excluir`", () => {
    assert.equal(PERM_FIN.CANCELAR, "gestao_financeira.cancelar");
    assert.notEqual(PERM_FIN.CANCELAR, PERM_FIN.EXCLUIR);
  });
  test("matriz por nível, exatamente como decidido", () => {
    assert.deepEqual(permissoesDoNivelFinanceiro("leitura"), ["gestao_financeira.ver"]);
    assert.deepEqual(permissoesDoNivelFinanceiro("operador"), ["gestao_financeira.ver", "gestao_financeira.lancar", "gestao_financeira.editar"]);
    assert.deepEqual(new Set(permissoesDoNivelFinanceiro("gestor")), new Set([
      "gestao_financeira.ver", "gestao_financeira.lancar", "gestao_financeira.editar", "gestao_financeira.conciliar",
      "gestao_financeira.cancelar", "gestao_financeira.fechar", "gestao_financeira.configurar"]));
  });
  test("NENHUM nível concede `excluir` nem `reabrir`", () => {
    for (const n of NIVEIS_FINANCEIRO) {
      const p = permissoesDoNivelFinanceiro(n);
      assert.ok(!p.includes(PERM_FIN.EXCLUIR) && !p.includes(PERM_FIN.REABRIR), n);
    }
  });
  test("só leitura < operador < gestor (cada nível contém o anterior)", () => {
    const [l, o, g] = ["leitura", "operador", "gestor"].map((n) => new Set(permissoesDoNivelFinanceiro(n)));
    assert.ok([...l].every((p) => o.has(p)) && [...o].every((p) => g.has(p)));
  });
  test("`cancelar` NÃO entra no catálogo operacional (organization_admin herdaria)", () => {
    assert.ok(!Object.values(PERMISSOES).some((p) => p.startsWith("gestao_financeira.")));
  });
  test("o catálogo do domínio (ACAO) é um subconjunto exato do catálogo financeiro — sem permissão inventada", () => {
    for (const v of Object.values(ACAO)) assert.ok(PERMISSOES_FINANCEIRAS.includes(v), v);
    assert.equal(ACAO.CANCELAR, PERM_FIN.CANCELAR);
  });
  test("a rota de cancelamento exige `cancelar` (e não `excluir`)", async () => {
    const exigidas = [];
    criarDominioRouter({ autorizar: (acao) => { exigidas.push(acao); return (_q, _r, n) => n(); }, deps: { repo: {} } });
    assert.ok(exigidas.includes(PERM_FIN.CANCELAR));
    const porRota = []; const r = criarDominioRouter({ autorizar: (a) => { porRota.push(a); return (_q, _s, n) => n(); }, deps: { repo: {} } });
    const idx = r.stack.findIndex((l) => l.route?.path === "/lancamentos/:id/cancelar");
    assert.ok(idx >= 0);
    assert.equal(porRota[idx], PERM_FIN.CANCELAR);
  });
  test("não existe nenhuma rota DELETE no domínio (exclusão física indisponível)", () => {
    const r = criarDominioRouter({ autorizar: () => (_q, _s, n) => n(), deps: { repo: {} } });
    const metodos = r.stack.flatMap((l) => (l.route ? Object.keys(l.route.methods) : []));
    assert.ok(!metodos.includes("delete"));
  });
});

// ---------------- HTTP: gate real + domínio real ----------------
function montar({ nivel, impersonando = false, org = ORG, uni = UNI, concessao }) {
  const repo = criarRepoMemoria();
  const c = concessao === undefined ? { organizacao_id: org, unidade_id: uni, nivel, somente_financeiro: false, revogada_em: null, expira_em: null } : concessao;
  const leitor = { moduloEmpresa: async () => true, moduloUnidade: async () => true, concessao: async () => (typeof c === "function" ? c() : c) };
  const app = express(); app.use(express.json());
  app.use((req, _s, next) => { req.user = { id: USER }; req.tenant = { organizacaoId: org, unidadeId: uni }; req.acesso = { perfilId: PERFIL, papel: "organization_admin", impersonando }; next(); });
  app.use("/fin", requireFinanceiro(leitor), criarDominioRouter({ autorizar: autorizarAcaoFinanceira, deps: { repo, db: undefined } }));
  app.use(errorHandler);
  return { app, repo };
}
async function servir(cfg, fn) {
  const { app, repo } = montar(cfg);
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const chamar = (m, p, corpo) => fetch(base + p, { method: m, headers: { "Content-Type": "application/json" }, ...(corpo ? { body: JSON.stringify(corpo) } : {}) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  try { return await fn(chamar, repo); } finally { srv.close(); }
}
const ctxDe = (org = ORG, uni = UNI) => ({ organizacaoId: org, unidadeId: uni, usuarioId: USER });
/** Semeia uma conta, uma categoria e um lançamento realizado pelos serviços reais; devolve o id do lançamento. */
async function semear(repo, { org = ORG, uni = UNI, data = "2026-10-05" } = {}) {
  const d = { repo, db: undefined }; const ctx = ctxDe(org, uni);
  const cat = await cadastros.criarCategoria(ctx, { tipo: "RECEITA", natureza: "RECEBIMENTO", nome: "VENDAS", papel: "receita_operacional" }, d);
  const conta = await cadastros.criarConta(ctx, { nome: "CAIXA", tipoConta: "caixa_fisico" }, d);
  const l = await lanc.criarLancamento(ctx, { contaId: conta.id, categoriaId: cat.id, descricao: "Venda", sentido: "entrada", valor: 100, dataMovimento: data }, d);
  return l.id;
}
const codigo = (r) => r.json?.details?.codigo;

describe("cancelamento por nível (HTTP, gate + domínio reais)", () => {
  for (const nivel of ["leitura", "operador"]) {
    test(`${nivel}: bloqueado (403 FINANCEIRO_PERMISSAO_INSUFICIENTE) e o lançamento permanece realizado`, () =>
      servir({ nivel }, async (c, repo) => {
        const id = await semear(repo);
        const r = await c("POST", `/fin/lancamentos/${id}/cancelar`, { motivo: "Lançamento duplicado" });
        assert.equal(r.status, 403); assert.equal(codigo(r), "FINANCEIRO_PERMISSAO_INSUFICIENTE");
        assert.equal(repo._t.lanc.find((x) => x.id === id).status, "realizado");
      }));
  }
  test("gestor: cancela com motivo → status 'cancelado', motivo registrado e transição AUDITADA (antes/depois)", () =>
    servir({ nivel: "gestor" }, async (c, repo) => {
      const id = await semear(repo);
      const r = await c("POST", `/fin/lancamentos/${id}/cancelar`, { motivo: "Lançamento duplicado" });
      assert.equal(r.status, 200); assert.equal(r.json.data.status, "cancelado");
      assert.match(r.json.data.nota_revisao, /Cancelado: Lançamento duplicado/);
      const aud = repo._t.aud.filter((a) => a.entidade_id === id && a.acao === "fin_lancamentos.update");
      assert.equal(aud.length, 1);
      assert.equal(aud[0].antes.status, "realizado"); assert.equal(aud[0].depois.status, "cancelado");
      assert.equal(repo._t.lanc.length, 1, "nada foi excluído");
    }));
  test("gestor SEM motivo (ausente, vazio ou só espaços) → 400 e nada muda", () =>
    servir({ nivel: "gestor" }, async (c, repo) => {
      const id = await semear(repo);
      for (const corpo of [{}, { motivo: "" }, { motivo: "   " }]) assert.equal((await c("POST", `/fin/lancamentos/${id}/cancelar`, corpo)).status, 400);
      assert.equal(repo._t.lanc[0].status, "realizado");
    }));
  test("gestor em período FECHADO: cancelamento comum recusado e nada muda", () =>
    servir({ nivel: "gestor" }, async (c, repo) => {
      const id = await semear(repo, { data: "2026-09-10" });
      repo.fecharPeriodo(ctxDe(), "2026-09");   // helper do repositório em memória (mesma regra do banco: mês fechado é intocável)
      const r = await c("POST", `/fin/lancamentos/${id}/cancelar`, { motivo: "Correção" });
      assert.ok(r.status >= 400, `status ${r.status}`);
      assert.equal(repo._t.lanc[0].status, "realizado");
    }));
  test("impersonação: bloqueada mesmo com concessão de gestor", () =>
    servir({ nivel: "gestor", impersonando: true }, async (c, repo) => {
      const id = await semear(repo);
      const r = await c("POST", `/fin/lancamentos/${id}/cancelar`, { motivo: "Teste" });
      assert.equal(r.status, 403); assert.equal(codigo(r), "FINANCEIRO_BLOQUEADO_IMPERSONACAO");
    }));
  test("sem concessão (administrador sem concessão) → 403 FINANCEIRO_SEM_CONCESSAO", () =>
    servir({ concessao: null }, async (c, repo) => {
      const id = await semear(repo);
      const r = await c("POST", `/fin/lancamentos/${id}/cancelar`, { motivo: "Teste" });
      assert.equal(r.status, 403); assert.equal(codigo(r), "FINANCEIRO_SEM_CONCESSAO");
    }));
  test("autorização verificada A CADA chamada: revogada entre duas tentativas, a segunda é negada", async () => {
    let atual = { organizacao_id: ORG, unidade_id: UNI, nivel: "gestor", somente_financeiro: false, revogada_em: null, expira_em: null };
    await servir({ concessao: () => atual }, async (c, repo) => {
      const a = await semear(repo); const ctx = ctxDe(); const d = { repo, db: undefined };
      const [conta] = await cadastros.listarContas(ctx, d); const [cat] = await cadastros.listarPlanoContas(ctx, d);
      const b = (await lanc.criarLancamento(ctx, { contaId: conta.id, categoriaId: cat.id, descricao: "Outra", sentido: "entrada", valor: 50, dataMovimento: "2026-10-06" }, d)).id;
      assert.equal((await c("POST", `/fin/lancamentos/${a}/cancelar`, { motivo: "Primeira" })).status, 200);
      atual = null;
      assert.equal((await c("POST", `/fin/lancamentos/${b}/cancelar`, { motivo: "Segunda" })).status, 403);
      assert.equal(repo._t.lanc.find((x) => x.id === b).status, "realizado");
    });
  });
  test("concessão de OUTRA empresa/unidade não autoriza", () =>
    servir({ concessao: { organizacao_id: ORG_B, unidade_id: UNI_B, nivel: "gestor", somente_financeiro: false, revogada_em: null, expira_em: null } }, async (c, repo) => {
      const id = await semear(repo);
      assert.equal((await c("POST", `/fin/lancamentos/${id}/cancelar`, { motivo: "Teste" })).status, 403);
    }));
  test("isolamento: gestor da unidade A não cancela lançamento de OUTRA unidade/empresa (id desconhecido no escopo)", () =>
    servir({ nivel: "gestor" }, async (c, repo) => {
      const alheio = await semear(repo, { org: ORG_B, uni: UNI_B });
      const r = await c("POST", `/fin/lancamentos/${alheio}/cancelar`, { motivo: "Tentativa" });
      assert.ok(r.status === 400 || r.status === 404, `status ${r.status}`);
      assert.equal(repo._t.lanc.find((x) => x.id === alheio).status, "realizado");
    }));
  test("cancelar duas vezes é idempotente e não duplica a auditoria", () =>
    servir({ nivel: "gestor" }, async (c, repo) => {
      const id = await semear(repo);
      await c("POST", `/fin/lancamentos/${id}/cancelar`, { motivo: "Primeira vez" });
      const r2 = await c("POST", `/fin/lancamentos/${id}/cancelar`, { motivo: "Segunda vez" });
      assert.equal(r2.status, 200);
      assert.equal(repo._t.aud.filter((a) => a.entidade_id === id && a.acao === "fin_lancamentos.update").length, 1);
    }));
});
