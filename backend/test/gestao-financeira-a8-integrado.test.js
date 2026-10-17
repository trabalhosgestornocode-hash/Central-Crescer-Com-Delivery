// A8 — HTTP INTEGRADO com o GATE REAL (requireFinanceiro/autorizarAcaoFinanceira) e o DOMÍNIO REAL do Agente 2 (B7 conciliação, B8 fechamento,
// cancelamento atômico de transferência). Repositório em memória, dados 100% sintéticos, loopback. A prova no banco real está no ciclo SQL
// (docs/gestao-financeira/08-integracao-a8.md): concorrência de verdade com duas sessões, privilégios, rollback.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { requireFinanceiro, autorizarAcaoFinanceira } from "../src/middlewares/financeiro.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";

const { criarDominioRouter } = await import("../src/modules/gestao-financeira/dominio/rotas.js");
const cadastros = await import("../src/modules/gestao-financeira/dominio/cadastros.service.js");
const lanc = await import("../src/modules/gestao-financeira/dominio/lancamentos.service.js");
const per = await import("../src/modules/gestao-financeira/dominio/periodos.service.js");
const { criarRepoMemoria } = await import("./financeiro/helpers/repoMemoria.js");

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = U(1), UNI = U(2), ORG_B = U(3), UNI_B = U(4), PERFIL = U(5), USER = U(6);
const ctxDe = (org = ORG, uni = UNI) => ({ organizacaoId: org, unidadeId: uni, usuarioId: USER });
const conc = (nivel, o = {}) => ({ organizacao_id: ORG, unidade_id: UNI, nivel, somente_financeiro: false, revogada_em: null, expira_em: null, ...o });

function montar({ nivel, impersonando = false, concessao, autorizar = autorizarAcaoFinanceira, gateReal = true }) {
  const repo = criarRepoMemoria();
  const c = concessao === undefined ? conc(nivel) : concessao;
  const leitor = { moduloEmpresa: async () => true, moduloUnidade: async () => true, concessao: async () => (typeof c === "function" ? c() : c) };
  const app = express(); app.use(express.json());
  app.use((req, _s, next) => { req.user = { id: USER }; req.tenant = { organizacaoId: ORG, unidadeId: UNI }; req.acesso = { perfilId: PERFIL, papel: "organization_admin", impersonando }; next(); });
  const dominio = criarDominioRouter({ autorizar, deps: { repo, db: undefined } });
  if (gateReal) app.use("/fin", requireFinanceiro(leitor), dominio); else app.use("/fin", dominio);
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
const codigo = (r) => r.json?.details?.codigo;

/** Duas contas, categorias (receita + transferência) e uma transferência vinculada. */
async function semearTransferencia(repo, data = "2026-08-10") {
  const d = { repo, db: undefined }; const ctx = ctxDe();
  const cat = await cadastros.criarCategoria(ctx, { tipo: "RECEITA", natureza: "RECEBIMENTO", nome: "VENDAS", papel: "receita_operacional" }, d);
  const tr = await cadastros.criarCategoria(ctx, { tipo: "TRANSFERENCIA", natureza: "ENTRE CONTAS", nome: "ENTRE CONTAS", papel: "transferencia" }, d);
  const a = await cadastros.criarConta(ctx, { nome: "ADQ", tipoConta: "adquirente" }, d);
  const b = await cadastros.criarConta(ctx, { nome: "BANCO", tipoConta: "banco" }, d);
  await lanc.criarTransferencia(ctx, { contaOrigemId: a.id, contaDestinoId: b.id, valor: 500, data, descricao: "Repasse" }, d);
  const par = repo._t.transf[0];
  return { cat, tr, a, b, par, pernas: [par.lancamento_saida_id, par.lancamento_entrada_id] };
}
const estadoPar = (repo, par) => ({ par: repo._t.transf.find((x) => x.id === par.id)?.status, pernas: [par.lancamento_saida_id, par.lancamento_entrada_id].map((id) => repo._t.lanc.find((l) => l.id === id)?.status) });
const auditoriaDe = (repo, ids) => repo._t.aud.filter((a) => ids.includes(a.entidade_id));

describe("cancelamento atômico de transferência", () => {
  for (const nivel of ["leitura", "operador"]) {
    test(`${nivel}: 403 PERMISSAO_INSUFICIENTE e o par permanece intacto`, () => servir({ nivel }, async (c, repo) => {
      const { par } = await semearTransferencia(repo);
      const r = await c("POST", `/fin/transferencias/${par.id}/cancelar`, { motivo: "Lançada em duplicidade" });
      assert.equal(r.status, 403); assert.equal(codigo(r), "FINANCEIRO_PERMISSAO_INSUFICIENTE");
      assert.deepEqual(estadoPar(repo, par), { par: "vinculada", pernas: ["realizado", "realizado"] });
    }));
  }
  test("gestor SEM motivo (ausente, vazio, curto) → 400; nada muda", () => servir({ nivel: "gestor" }, async (c, repo) => {
    const { par } = await semearTransferencia(repo);
    for (const corpo of [{}, { motivo: "" }, { motivo: "curto" }]) assert.equal((await c("POST", `/fin/transferencias/${par.id}/cancelar`, corpo)).status, 400);
    assert.deepEqual(estadoPar(repo, par), { par: "vinculada", pernas: ["realizado", "realizado"] });
  }));
  test("gestor + motivo: as DUAS pernas e o par mudam juntos; nada é excluído; auditoria (antes/depois) das 3 linhas", () => servir({ nivel: "gestor" }, async (c, repo) => {
    const { par, pernas } = await semearTransferencia(repo);
    const antes = repo._t.lanc.length;
    const r = await c("POST", `/fin/transferencias/${par.id}/cancelar`, { motivo: "Lançada em duplicidade" });
    assert.equal(r.status, 200);
    assert.deepEqual(estadoPar(repo, par), { par: "cancelada", pernas: ["cancelado", "cancelado"] });
    assert.equal(repo._t.lanc.length, antes, "nenhum lançamento excluído");
    assert.equal(repo._t.transf.length, 1, "o par é preservado (cancelado), não apagado");
    const aud = auditoriaDe(repo, [par.id, ...pernas]).filter((a) => /update/.test(a.acao));
    assert.equal(aud.length, 3);
    assert.ok(aud.every((a) => a.antes && a.depois && a.antes.status !== a.depois.status));
  }));
  test("idempotente: repetir devolve jaCancelada e NÃO duplica a auditoria", () => servir({ nivel: "gestor" }, async (c, repo) => {
    const { par, pernas } = await semearTransferencia(repo);
    await c("POST", `/fin/transferencias/${par.id}/cancelar`, { motivo: "Primeira vez, duplicada" });
    const n = auditoriaDe(repo, [par.id, ...pernas]).length;
    const r2 = await c("POST", `/fin/transferencias/${par.id}/cancelar`, { motivo: "Segunda tentativa qualquer" });
    assert.equal(r2.status, 200); assert.equal(r2.json.data.jaCancelada, true);
    assert.equal(auditoriaDe(repo, [par.id, ...pernas]).length, n);
  }));
  test("período FECHADO em qualquer das pernas: recusado e NADA muda (sem cancelamento parcial)", () => servir({ nivel: "gestor" }, async (c, repo) => {
    const { par } = await semearTransferencia(repo, "2026-08-10");
    repo.fecharPeriodo(ctxDe(), "2026-08");
    const r = await c("POST", `/fin/transferencias/${par.id}/cancelar`, { motivo: "Tentativa em mês fechado" });
    assert.ok(r.status >= 400, `status ${r.status}`);
    assert.deepEqual(estadoPar(repo, par), { par: "vinculada", pernas: ["realizado", "realizado"] });
  }));
  test("cancelar UMA perna vinculada pelo endpoint de lançamento é recusado (400 FIN_TRANSFERENCIA_VINCULADA) e o par fica intacto", () => servir({ nivel: "gestor" }, async (c, repo) => {
    const { par, pernas } = await semearTransferencia(repo);
    const r = await c("POST", `/fin/lancamentos/${pernas[0]}/cancelar`, { motivo: "Tentando cancelar só uma perna" });
    assert.equal(r.status, 400); assert.equal(codigo(r), "FIN_TRANSFERENCIA_VINCULADA");
    assert.deepEqual(estadoPar(repo, par), { par: "vinculada", pernas: ["realizado", "realizado"] });
  }));
  test("desvincular exige `conciliar` (leitura/operador → 403) e motivo; as pernas seguem ATIVAS", async () => {
    await servir({ nivel: "operador" }, async (c, repo) => {
      const { par } = await semearTransferencia(repo);
      assert.equal((await c("POST", `/fin/transferencias/${par.id}/desvincular`, { motivo: "Pareamento incorreto aqui" })).status, 403);
    });
    await servir({ nivel: "gestor" }, async (c, repo) => {
      const { par } = await semearTransferencia(repo);
      assert.equal((await c("POST", `/fin/transferencias/${par.id}/desvincular`, { motivo: "curto" })).status, 400);
      const ok = await c("POST", `/fin/transferencias/${par.id}/desvincular`, { motivo: "Pareamento incorreto aqui" });
      assert.equal(ok.status, 200);
      assert.deepEqual(repo._t.lanc.map((l) => l.status), ["realizado", "realizado"], "as duas pernas continuam ativas");
    });
  });
  test("impersonação, sem concessão, e revogação entre chamadas → bloqueados", async () => {
    await servir({ nivel: "gestor", impersonando: true }, async (c, repo) => {
      const { par } = await semearTransferencia(repo);
      const r = await c("POST", `/fin/transferencias/${par.id}/cancelar`, { motivo: "Impersonando alguem" });
      assert.equal(r.status, 403); assert.equal(codigo(r), "FINANCEIRO_BLOQUEADO_IMPERSONACAO");
      assert.deepEqual(estadoPar(repo, par), { par: "vinculada", pernas: ["realizado", "realizado"] });
    });
    await servir({ concessao: null }, async (c, repo) => {
      const { par } = await semearTransferencia(repo);
      assert.equal(codigo(await c("POST", `/fin/transferencias/${par.id}/cancelar`, { motivo: "Sem concessao nenhuma" })), "FINANCEIRO_SEM_CONCESSAO");
    });
    let atual = conc("gestor");
    await servir({ concessao: () => atual }, async (c, repo) => {
      const { par } = await semearTransferencia(repo);
      atual = null;
      assert.equal((await c("POST", `/fin/transferencias/${par.id}/cancelar`, { motivo: "Revogada no meio" })).status, 403);
      assert.equal(estadoPar(repo, par).par, "vinculada");
    });
  });
  test("outra empresa/unidade: o par alheio não é encontrado e permanece intacto", () => servir({ nivel: "gestor" }, async (c, repo) => {
    const d = { repo, db: undefined }; const alheio = ctxDe(ORG_B, UNI_B);
    await cadastros.criarCategoria(alheio, { tipo: "TRANSFERENCIA", natureza: "ENTRE CONTAS", nome: "ENTRE CONTAS", papel: "transferencia" }, d);
    const a = await cadastros.criarConta(alheio, { nome: "X", tipoConta: "banco" }, d); const b = await cadastros.criarConta(alheio, { nome: "Y", tipoConta: "banco" }, d);
    await lanc.criarTransferencia(alheio, { contaOrigemId: a.id, contaDestinoId: b.id, valor: 10, data: "2026-08-10" }, d);
    const par = repo._t.transf[0];
    const r = await c("POST", `/fin/transferencias/${par.id}/cancelar`, { motivo: "Tentando cancelar de outra unidade" });
    assert.ok(r.status === 400 || r.status === 404, `status ${r.status}`);
    assert.equal(repo._t.transf[0].status ?? "vinculada", "vinculada");
  }));
  test("CONCORRÊNCIA: dois cancelamentos simultâneos → ambos 200, estado coerente, auditoria uma vez por registro", () => servir({ nivel: "gestor" }, async (c, repo) => {
    const { par, pernas } = await semearTransferencia(repo);
    const [r1, r2] = await Promise.all([1, 2].map((k) => c("POST", `/fin/transferencias/${par.id}/cancelar`, { motivo: `Cancelamento simultâneo ${k}` })));
    assert.deepEqual([r1.status, r2.status], [200, 200]);
    assert.equal([r1, r2].filter((r) => r.json.data.jaCancelada === true).length, 1);
    assert.deepEqual(estadoPar(repo, par), { par: "cancelada", pernas: ["cancelado", "cancelado"] });
    for (const id of [par.id, ...pernas]) assert.equal(auditoriaDe(repo, [id]).filter((a) => /update/.test(a.acao)).length, 1, id);
  }));
  test("CONCORRÊNCIA: cancelar × desvincular → estado final NUNCA misto (ou par cancelado com pernas canceladas, ou par desfeito com pernas ativas)", () => servir({ nivel: "gestor" }, async (c, repo) => {
    const { par } = await semearTransferencia(repo);
    await Promise.all([c("POST", `/fin/transferencias/${par.id}/cancelar`, { motivo: "Cancelando o par inteiro" }), c("POST", `/fin/transferencias/${par.id}/desvincular`, { motivo: "Desfazendo o pareamento" })]);
    const pernas = repo._t.lanc.map((l) => l.status);
    const existe = repo._t.transf.some((x) => x.id === par.id);
    const coerente = (existe && repo._t.transf[0].status === "cancelada" && pernas.every((s) => s === "cancelado")) || (!existe && pernas.every((s) => s === "realizado"));
    assert.ok(coerente, JSON.stringify({ existe, pernas }));
  }));
});

describe("fechamento mensal (B8)", () => {
  const MES = "2026-08";
  async function semearMes(repo) {
    const d = { repo, db: undefined }; const ctx = ctxDe();
    const cat = await cadastros.criarCategoria(ctx, { tipo: "RECEITA", natureza: "RECEBIMENTO", nome: "VENDAS", papel: "receita_operacional" }, d);
    const conta = await cadastros.criarConta(ctx, { nome: "CAIXA", tipoConta: "caixa_fisico" }, d);
    await lanc.criarLancamento(ctx, { contaId: conta.id, categoriaId: cat.id, descricao: "Venda", sentido: "entrada", valor: 100, dataMovimento: `${MES}-05` }, d);
    return { cat, conta };
  }
  const previa = async (c) => (await c("GET", `/fin/periodos/${MES}/pre-fechamento`)).json.data;

  test("pré-fechamento: leitura consulta; fechar exige `fechar` (leitura/operador → 403; gestor fecha com confirmação)", async () => {
    for (const nivel of ["leitura", "operador"]) {
      await servir({ nivel }, async (c, repo) => {
        await semearMes(repo);
        assert.equal((await c("GET", `/fin/periodos/${MES}/pre-fechamento`)).status, 200);
        const p = await previa(c);
        const r = await c("POST", `/fin/periodos/${MES}/fechar`, { confirmo: true, versao: p.periodo.versao, fingerprint: p.fingerprint });
        assert.equal(r.status, 403); assert.equal(codigo(r), "FINANCEIRO_PERMISSAO_INSUFICIENTE");
      });
    }
    await servir({ nivel: "gestor" }, async (c, repo) => {
      await semearMes(repo);
      const p = await previa(c);
      assert.equal((await c("POST", `/fin/periodos/${MES}/fechar`, { versao: p.periodo.versao, fingerprint: p.fingerprint })).status, 400, "sem `confirmo` é recusado");
      const r = await c("POST", `/fin/periodos/${MES}/fechar`, { confirmo: true, versao: p.periodo.versao, fingerprint: p.fingerprint });
      assert.equal(r.status, 200); assert.equal(r.json.data.status, "fechado"); assert.ok(r.json.data.snapshot);
      assert.ok(repo._t.aud.some((a) => a.entidade === "fin_periodos" && a.depois?.status === "fechado"), "fechamento auditado");
    });
  });
  test("409 quando os dados mudam ENTRE a prévia e a confirmação; o período continua aberto", () => servir({ nivel: "gestor" }, async (c, repo) => {
    const { conta, cat } = await semearMes(repo);
    const p = await previa(c);
    const novo = await c("POST", "/fin/lancamentos", { contaId: conta.id, categoriaId: cat.id, descricao: "Chegou depois", sentido: "entrada", valor: 50, dataMovimento: `${MES}-20` });
    assert.equal(novo.status, 201);
    const r = await c("POST", `/fin/periodos/${MES}/fechar`, { confirmo: true, versao: p.periodo.versao, fingerprint: p.fingerprint });
    assert.equal(r.status, 409); assert.equal(codigo(r), "FIN_PERIODO_CONFLITO_DADOS");
    assert.equal(repo._t.per.find((x) => x.mes === `${MES}-01`).status, "aberto");
  }));
  test("409 com versão do período desatualizada", () => servir({ nivel: "gestor" }, async (c, repo) => {
    await semearMes(repo);
    const p = await previa(c);
    repo._t.per.find((x) => x.mes === `${MES}-01`).versao += 1;     // outra operação alterou o período
    const r = await c("POST", `/fin/periodos/${MES}/fechar`, { confirmo: true, versao: p.periodo.versao, fingerprint: p.fingerprint });
    assert.equal(r.status, 409); assert.equal(codigo(r), "FIN_PERIODO_CONFLITO_VERSAO");
  }));
  test("pendências BLOQUEIAM o fechamento (política padrão); reconhecer sem política aprovada não basta", () => servir({ nivel: "gestor" }, async (c, repo) => {
    const { conta } = await semearMes(repo);
    await c("POST", "/fin/lancamentos", { contaId: conta.id, descricao: "PIX a identificar", sentido: "entrada", valor: 30, dataMovimento: `${MES}-12` });   // sem categoria => pendente
    const p = await previa(c);
    assert.equal(p.avaliacao.pode, false); assert.ok(p.pendencias.total >= 1);
    for (const extra of [{}, { reconhecoPendencias: true }]) {
      const r = await c("POST", `/fin/periodos/${MES}/fechar`, { confirmo: true, versao: p.periodo.versao, fingerprint: p.fingerprint, ...extra });
      assert.ok(r.status >= 400 && r.status !== 200, `status ${r.status}`);
    }
    assert.equal(repo._t.per.find((x) => x.mes === `${MES}-01`).status, "aberto");
  }));
  test("mês FECHADO bloqueia escrita (lançamento, edição, referência de conciliação) e preserva o snapshot", () => servir({ nivel: "gestor" }, async (c, repo) => {
    const { conta, cat } = await semearMes(repo);
    const p = await previa(c);
    await c("POST", `/fin/periodos/${MES}/fechar`, { confirmo: true, versao: p.periodo.versao, fingerprint: p.fingerprint });
    const snap = JSON.stringify(repo._t.per.find((x) => x.mes === `${MES}-01`).snapshot);
    const base = { contaId: conta.id, categoriaId: cat.id, descricao: "Tardio", sentido: "entrada", valor: 10, dataMovimento: `${MES}-25` };
    assert.ok((await c("POST", "/fin/lancamentos", base)).status >= 400);
    const id = repo._t.lanc[0].id;
    assert.ok((await c("PATCH", `/fin/lancamentos/${id}`, { descricao: "alterada" })).status >= 400);
    assert.ok((await c("POST", "/fin/conciliacao/referencias", { itens: [{ data: `${MES}-10`, tipo: "venda", canal: "STONE", valor: 10 }] })).status >= 400);
    assert.equal(repo._t.lanc.length, 1);
    assert.equal(JSON.stringify(repo._t.per.find((x) => x.mes === `${MES}-01`).snapshot), snap, "snapshot intacto");
  }));
  test("REABERTURA permanece DESABILITADA: nenhum nível a concede (403) e o período continua fechado", async () => {
    for (const nivel of ["gestor", "operador", "leitura"]) {
      await servir({ nivel }, async (c, repo) => {
        await semearMes(repo); repo.fecharPeriodo(ctxDe(), MES);
        const r = await c("POST", `/fin/periodos/${MES}/reabrir`, { versao: 2, motivo: "Preciso corrigir um lançamento" });
        assert.equal(r.status, 403); assert.equal(codigo(r), "FINANCEIRO_PERMISSAO_INSUFICIENTE", nivel);
        assert.equal(repo._t.per.find((x) => x.mes === `${MES}-01`).status, "fechado");
      });
    }
  });
  test("REABERTURA fail-closed também no SERVIÇO: sem a habilitação explícita, responde 403 REABERTURA_NAO_HABILITADA e nada muda", async () => {
    const repo = criarRepoMemoria(); await semearMes(repo); repo.fecharPeriodo(ctxDe(), MES);
    await assert.rejects(per.reabrir(ctxDe(), MES, { versao: 2, motivo: "Motivo suficientemente longo" }, { repo, db: undefined }), (e) => e.statusCode === 403 && e.details?.codigo === "REABERTURA_NAO_HABILITADA");
    assert.equal(repo._t.per.find((x) => x.mes === `${MES}-01`).status, "fechado");
  });
  test("impersonação e sem concessão: fechar bloqueado", async () => {
    await servir({ nivel: "gestor", impersonando: true }, async (c, repo) => {
      await semearMes(repo);
      const r = await c("POST", `/fin/periodos/${MES}/fechar`, { confirmo: true, versao: 1, fingerprint: "x" });
      assert.equal(r.status, 403); assert.equal(codigo(r), "FINANCEIRO_BLOQUEADO_IMPERSONACAO");
    });
    await servir({ concessao: null }, async (c) => assert.equal(codigo(await c("POST", `/fin/periodos/${MES}/fechar`, { confirmo: true, versao: 1, fingerprint: "x" })), "FINANCEIRO_SEM_CONCESSAO"));
  });
  test("política de pendências (LD-008): ninguém liga; desligar é no-op; GET fixo; reabertura sem caminho HTTP aberto", async () => {
    await servir({ nivel: "operador" }, async (c) => assert.equal((await c("PUT", "/fin/periodos/politica", { permiteFecharComPendencias: true })).status, 403));
    await servir({ nivel: "gestor" }, async (c) => {
      for (const corpo of [{ permiteFecharComPendencias: true }, { permiteFecharComPendencias: true, notaAprovacao: "Aprovado pela diretoria hoje", confirmoAprovacao: true }]) {
        const r = await c("PUT", "/fin/periodos/politica", corpo);
        assert.equal(r.status, 403); assert.equal(codigo(r), "POLITICA_EXCEPCIONAL_DESABILITADA");
      }
      assert.equal((await c("PUT", "/fin/periodos/politica", { permiteFecharComPendencias: false })).status, 200);
      const g = await c("GET", "/fin/periodos/politica");
      assert.equal(g.status, 200); assert.equal(g.json.data.permiteFecharComPendencias, false); assert.equal(g.json.data.excecaoFechamentoHabilitada, false);
      const reab = await c("POST", `/fin/periodos/${MES}/reabrir`, { motivo: "tentativa de reabrir periodo fechado", versao: 1 });
      assert.ok([403, 404].includes(reab.status), `reabertura deve falhar fechada, veio ${reab.status}`);
    });
  });
});

describe("conciliação (B7)", () => {
  const MES = "2026-08";
  async function semearVenda(repo, { vincularCanal = true } = {}) {
    const d = { repo, db: undefined }; const ctx = ctxDe();
    const cat = await cadastros.criarCategoria(ctx, { tipo: "RECEITA", natureza: "RECEBIMENTO", nome: "VENDAS", papel: "receita_operacional" }, d);
    const conta = await cadastros.criarConta(ctx, { nome: "ADQ", tipoConta: "adquirente" }, d);
    if (vincularCanal) await cadastros.atualizarConta(ctx, conta.id, { canalReferencia: "STONE" }, d);   // vínculo EXPLÍCITO conta↔canal
    await lanc.criarLancamento(ctx, { contaId: conta.id, categoriaId: cat.id, descricao: "Recebimento", sentido: "entrada", valor: 900, dataMovimento: `${MES}-05` }, d);
  }
  test("SEM referência: estado `sem_referencia` (não vira zero nem pendência inventada)", () => servir({ nivel: "leitura" }, async (c, repo) => {
    await semearVenda(repo);
    const r = await c("GET", `/fin/conciliacao/resumo?mes=${MES}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.resumo.semReferencia, true);
    assert.deepEqual(r.json.data.resumo.contagemPorEstado, { sem_referencia: 1 });
    assert.equal(r.json.data.resumo.pendenciasAbertas, 0);
    assert.deepEqual(r.json.data.referencias, []);
  }));
  test("referência DIVERGENTE: `pendente_identificacao` — NUNCA classificada sozinha (nenhum 'prazo' automático)", () => servir({ nivel: "gestor" }, async (c, repo) => {
    await semearVenda(repo);
    // a ponte só compara com AMBAS as referências do canal (venda e taxa); taxa 0 é "zero informado", não ausência
    const reg = await c("POST", "/fin/conciliacao/referencias", { itens: [{ data: `${MES}-05`, tipo: "venda", canal: "STONE", valor: 1000 }, { data: `${MES}-05`, tipo: "taxa", canal: "STONE", valor: 0 }] });
    assert.equal(reg.status, 201);
    const r = (await c("GET", `/fin/conciliacao/resumo?mes=${MES}`)).json.data;
    assert.deepEqual(r.resumo.contagemPorEstado, { pendente_identificacao: 1 });
    assert.equal(r.resumo.pendenciasAbertas, 1);
    assert.equal(repo._t.resol.length, 0, "nenhuma resolução foi criada automaticamente");
  }));
  test("sem vínculo explícito conta↔canal a referência NÃO é associada por nome (continua sem_referencia — nada é inferido)", () => servir({ nivel: "gestor" }, async (c, repo) => {
    await semearVenda(repo, { vincularCanal: false });
    await c("POST", "/fin/conciliacao/referencias", { itens: [{ data: `${MES}-05`, tipo: "venda", canal: "STONE", valor: 1000 }] });
    const r = (await c("GET", `/fin/conciliacao/resumo?mes=${MES}`)).json.data;
    assert.deepEqual(r.resumo.contagemPorEstado, { sem_referencia: 1 });
    assert.equal(r.resumo.pendenciasAbertas, 0);
  }));
  test("referência com valor ZERO informado ≠ ausência de referência", () => servir({ nivel: "gestor" }, async (c, repo) => {
    await semearVenda(repo);
    await c("POST", "/fin/conciliacao/referencias", { itens: [{ data: `${MES}-06`, tipo: "taxa", canal: "STONE", valor: 0 }] });
    const r = (await c("GET", `/fin/conciliacao/resumo?mes=${MES}`)).json.data;
    assert.equal(r.resumo.semReferencia, false); assert.equal(r.resumo.referenciasNoMes, 1);
  }));
  test("registrar referência e classificar exigem `conciliar` (leitura/operador → 403); impersonação bloqueada", async () => {
    for (const nivel of ["leitura", "operador"]) {
      await servir({ nivel }, async (c) => {
        assert.equal((await c("POST", "/fin/conciliacao/referencias", { itens: [{ data: `${MES}-05`, tipo: "venda", valor: 10 }] })).status, 403);
        assert.equal((await c("POST", "/fin/conciliacao/resolucoes", { escopo: "ponte_mensal", chave: `${MES}-01`, classificacao: "prazo", valor: 1, nota: "nota qualquer" })).status, 403);
      });
    }
    await servir({ nivel: "gestor", impersonando: true }, async (c) => {
      const r = await c("GET", `/fin/conciliacao/resumo?mes=${MES}`);
      assert.equal(r.status, 403); assert.equal(codigo(r), "FINANCEIRO_BLOQUEADO_IMPERSONACAO");
    });
  });
  test("classificação manual exige nota e fica registrada; sem nota é recusada", () => servir({ nivel: "gestor" }, async (c, repo) => {
    await semearVenda(repo);
    await c("POST", "/fin/conciliacao/referencias", { itens: [{ data: `${MES}-05`, tipo: "venda", canal: "STONE", valor: 1000 }] });
    const sem = await c("POST", "/fin/conciliacao/resolucoes", { escopo: "ponte_mensal", chave: `${MES}-01`, classificacao: "prazo", valor: 100 });
    assert.equal(sem.status, 400);
    assert.equal(repo._t.resol.length, 0);
  }));
});
