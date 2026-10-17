// Ponta a ponta (HTTP → rotas → serviços → motor), com repositório em memória e planilha SINTÉTICA gerada na hora.
// Prova: importação idempotente, reordenação, duplicata legítima, pares só com confirmação, isolamento entre unidades, período fechado.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import XLSX from "xlsx";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "teste-local-nao-e-segredo";
process.env.SUPABASE_ANON_KEY = "teste-local-nao-e-segredo";
const { criarDominioRouter } = await import("../../src/modules/gestao-financeira/dominio/rotas.js");
const { criarRepoMemoria } = await import("./helpers/repoMemoria.js");

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TODAS = ["ver", "lancar", "editar", "conciliar", "fechar", "configurar", "excluir"].map((a) => `gestao_financeira.${a}`);
const serial = (iso) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000) + 25569;

function planilha(ordem = (x) => x) {
  const cab = ["DATA", "LANÇAMENTOS", "ENTRADA", "SAIDA", "TIPO", "NATUREZA", "CATEGORIA", "CONTA"];
  const linhas = ordem([
    [serial("2026-09-01"), "VENDAS DO DIA", 5000, 0, "RECEITA", "RECEBIMENTO DE CLIENTE", "RECEBIMENTO DE CLIENTE", "BANCO"],
    [serial("2026-09-02"), "COMPRA INSUMOS", 0, 1500, "CUSTO", "VARIAVEL", "INSUMOS", "BANCO"],
    [serial("2026-09-03"), "ALUGUEL", 0, 800, "DESPESA", "FIXA", "ALUGUEL", "BANCO"],
    [serial("2026-09-04"), "TARIFA", 0, 1.63, "DESPESA", "FINANCEIRAS", "TARIFAS", "BANCO"],
    [serial("2026-09-04"), "TARIFA", 0, 1.63, "DESPESA", "FINANCEIRAS", "TARIFAS", "BANCO"],
    [serial("2026-09-05"), "PIX ENVIADO", 0, 120, "DESPESA", "VARIAVEL", "PIX A IDENTIFICAR", "BANCO"],
    [serial("2026-09-06"), "TRANSFERENCIA CARTEIRA → BANCO", 300, 0, "TRANSFERENCIA", "TRANSFERENCIA ENTRE CONTAS", "ENTRE CONTAS", "BANCO"],
    [serial("2026-09-06"), "TRANSFERENCIA CARTEIRA → BANCO", 0, 300, "TRANSFERENCIA", "TRANSFERENCIA ENTRE CONTAS", "ENTRE CONTAS", "CARTEIRA"],
    [serial("2026-09-07"), "PAGAMENTO TERCEIRO", 0, 90, "TRANSFERENCIA", "TRANSFERENCIA ENTRE CONTAS", "ENTRE CONTAS", "CARTEIRA"],
    [serial("2026-09-01"), "SALDO MÊS ANTERIOR - BANCO", 100, 0, "SALDO ANTERIOR", "SALDO ANTERIOR", "SALDO ANTERIOR", "BANCO"],
  ]);
  const ws = XLSX.utils.aoa_to_sheet([["TOTAL DO FILTRO →", 5000 + 300 + 100, 1500 + 800 + 1.63 + 1.63 + 120 + 300 + 90], [], cab, ...linhas]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "FLUXO DE CAIXA");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }).toString("base64");
}

async function ambiente() {
  const repo = criarRepoMemoria();
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  // gate de teste: o tenant vem de um cabeçalho SÓ NO TESTE (em produção vem do Context Token via Agente 1)
  const gate = (acao) => (req, _res, next) => {
    const t = req.headers["x-t"] ?? "A";
    const perms = (req.headers["x-perms"] ?? TODAS.join(",")).split(",");
    req.financeiro = { organizacaoId: t === "A" ? U(1) : U(11), unidadeId: t === "A" ? U(2) : U(12), permissoes: perms };
    req.user = { id: U(3) };
    if (!perms.includes(acao)) return next(Object.assign(new Error("Permissão financeira insuficiente."), { statusCode: 403 }));
    next();
  };
  app.use("/fin", criarDominioRouter({ exigirPermissao: gate, deps: { repo, db: undefined } }));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, details: err.details }));
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/fin`;
  const chamar = async (metodo, caminho, corpo, tenant = "A", perms) => {
    const r = await fetch(base + caminho, { method: metodo, headers: { "content-type": "application/json", "x-t": tenant, ...(perms ? { "x-perms": perms } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { repo, chamar, fechar: () => new Promise((ok) => srv.close(ok)) };
}

test("importação ponta a ponta: prévia não grava; pares só com confirmação; reimportar e reordenar não duplicam; DRE recalculada", async () => {
  const a = await ambiente();
  try {
    let r = await a.chamar("POST", "/importacoes/previa", { nomeArquivo: "livro.xlsx", conteudoBase64: planilha() });
    assert.equal(r.status, 201);
    const prev = r.corpo.data;
    assert.equal(prev.resumo.lancamentos, 9);
    assert.equal(prev.resumo.saldos, 1);
    assert.equal(prev.resumo.conferencia.confere, true);
    assert.equal(prev.resumo.aIdentificar, 1);
    assert.equal(prev.resumo.identicas, 2);
    assert.deepEqual(prev.resumo.contasSemAbertura, ["CARTEIRA"]);
    assert.equal(a.repo._t.lanc.length, 0, "a prévia não grava lançamentos");
    assert.equal(prev.pares.length, 1);
    assert.equal(prev.pares[0].confirmado, false);

    // sem confirmação explícita não grava
    r = await a.chamar("POST", `/importacoes/${prev.id}/confirmar`, {});
    assert.equal(r.status, 400);
    assert.equal(a.repo._t.lanc.length, 0);

    // confirmar par de alta confiança (ação humana) e depois a importação
    r = await a.chamar("POST", `/importacoes/${prev.id}/pares`, { confirmarAltaConfianca: true });
    assert.equal(r.corpo.data.resumo.paresConfirmados, 1);
    r = await a.chamar("POST", `/importacoes/${prev.id}/confirmar`, { confirmo: true });
    assert.equal(r.status, 200);
    assert.equal(r.corpo.data.reconciliacao.confere, true);
    assert.equal(r.corpo.data.reconciliacao.gravados, 9);
    assert.equal(a.repo._t.lanc.filter((l) => l.descricao === "TARIFA").length, 2, "duplicata legítima preservada");
    assert.equal(a.repo._t.transf.length, 1);
    const pend = a.repo._t.lanc.filter((l) => l.classificacao_pendente).map((l) => l.descricao).sort();
    assert.deepEqual(pend, ["PAGAMENTO TERCEIRO", "PIX ENVIADO"], "pendências preservadas; as pernas pareadas deixam de ser pendentes");

    // reimportar o MESMO arquivo e uma versão com linhas reordenadas: nada novo
    for (const arq of [planilha(), planilha((l) => [...l].reverse())]) {
      const p2 = (await a.chamar("POST", "/importacoes/previa", { conteudoBase64: arq })).corpo.data;
      assert.equal(p2.resumo.novos, 0);
      assert.equal(p2.resumo.existentes, 9);
      const c2 = (await a.chamar("POST", `/importacoes/${p2.id}/confirmar`, { confirmo: true })).corpo.data;
      assert.equal(c2.reconciliacao.gravados, 0);
    }
    assert.equal(a.repo._t.lanc.length, 9);

    // relatórios recalculados do que foi gravado (regime de caixa)
    const dre = (await a.chamar("GET", "/relatorios/dre?de=2026-09-01&ate=2026-09-30")).corpo.data;
    const L = (id) => dre.linhas.find((l) => l.id === id);
    assert.equal(L("receita").centavos, 500000);
    assert.equal(L("custos").centavos, 150000);
    assert.equal(L("desp_fixas").centavos, 80000);
    assert.equal(L("desp_financeiras").centavos, 326);
    assert.equal(L("desp_variaveis").centavos, 12000);
    assert.equal(L("resultado").centavos, 500000 - 150000 - 12000 - 80000 - 326);
    assert.equal(dre.regime.id, "caixa");
    const v = (await a.chamar("GET", "/relatorios/visao-geral?de=2026-09-01&ate=2026-09-30")).corpo.data;
    assert.equal(v.saldoFinalParcial, true, "CARTEIRA sem abertura");
    assert.equal(v.saldosPorConta.totalCentavos, null);
    assert.equal(v.pendencias.pendentes, 2);
    const ig = (await a.chamar("GET", "/relatorios/integridade?de=2026-09-01&ate=2026-09-30")).corpo.data;
    assert.deepEqual(ig.violacoesPares, []);
  } finally { await a.fechar(); }
});

test("linha editada no arquivo vira possível alteração; sem aceite o original fica e a nova não entra", async () => {
  const a = await ambiente();
  try {
    const p1 = (await a.chamar("POST", "/importacoes/previa", { conteudoBase64: planilha() })).corpo.data;
    await a.chamar("POST", `/importacoes/${p1.id}/confirmar`, { confirmo: true });
    const editado = planilha((l) => l.map((x) => (x[1] === "ALUGUEL" ? [x[0], "ALUGUEL SALA 2", ...x.slice(2)] : x)));
    const p2 = (await a.chamar("POST", "/importacoes/previa", { conteudoBase64: editado })).corpo.data;
    assert.equal(p2.resumo.possiveisAlteracoes, 1);
    assert.equal(p2.resumo.ausentesNoArquivo, 1);
    const c = (await a.chamar("POST", `/importacoes/${p2.id}/confirmar`, { confirmo: true })).corpo.data;
    assert.equal(c.reconciliacao.gravados, 0);
    assert.equal(c.reconciliacao.naoImportadasPorAlteracao, 1);
    assert.ok(a.repo._t.lanc.some((l) => l.descricao === "ALUGUEL"), "original preservado (nada excluído)");
    assert.ok(!a.repo._t.lanc.some((l) => l.descricao === "ALUGUEL SALA 2"));
  } finally { await a.fechar(); }
});

test("isolamento: outra unidade não vê nem altera dados; mesmas chaves não colidem entre unidades", async () => {
  const a = await ambiente();
  try {
    const p = (await a.chamar("POST", "/importacoes/previa", { conteudoBase64: planilha() })).corpo.data;
    await a.chamar("POST", `/importacoes/${p.id}/confirmar`, { confirmo: true });
    const ls = (await a.chamar("GET", "/lancamentos?limite=50", null, "B")).corpo.data;
    assert.equal(ls.total, 0);
    assert.deepEqual((await a.chamar("GET", "/contas", null, "B")).corpo.data, []);
    const idDeA = a.repo._t.lanc[0].id;
    assert.equal((await a.chamar("PATCH", `/lancamentos/${idDeA}`, { descricao: "invadido" }, "B")).status, 400);
    assert.equal((await a.chamar("GET", `/importacoes/${p.id}`, null, "B")).status, 404);
    assert.equal((await a.chamar("POST", `/importacoes/${p.id}/confirmar`, { confirmo: true }, "B")).status, 404);
    // a unidade B importa o mesmo arquivo: tudo é novo para ela
    const pb = (await a.chamar("POST", "/importacoes/previa", { conteudoBase64: planilha() }, "B")).corpo.data;
    assert.equal(pb.resumo.novos, 9);
    await a.chamar("POST", `/importacoes/${pb.id}/confirmar`, { confirmo: true }, "B");
    assert.equal(a.repo._t.lanc.filter((l) => l.unidade_id === U(12)).length, 9);
    assert.equal(a.repo._t.lanc.filter((l) => l.unidade_id === U(2)).length, 9);
    const dreB = (await a.chamar("GET", "/relatorios/dre?de=2026-09-01&ate=2026-09-30", null, "B")).corpo.data;
    assert.equal(dreB.linhas.find((l) => l.id === "receita").centavos, 500000);
  } finally { await a.fechar(); }
});

test("permissões: leitura não escreve; operador não confirma importação; ver não cancela", async () => {
  const a = await ambiente();
  try {
    const leitura = "gestao_financeira.ver";
    assert.equal((await a.chamar("GET", "/lancamentos", null, "A", leitura)).status, 200);
    assert.equal((await a.chamar("POST", "/lancamentos", {}, "A", leitura)).status, 403);
    assert.equal((await a.chamar("POST", "/importacoes/previa", { conteudoBase64: planilha() }, "A", leitura)).status, 403);
    const operador = "gestao_financeira.ver,gestao_financeira.lancar";
    const p = (await a.chamar("POST", "/importacoes/previa", { conteudoBase64: planilha() }, "A", operador));
    assert.equal(p.status, 201);
    assert.equal((await a.chamar("POST", `/importacoes/${p.corpo.data.id}/confirmar`, { confirmo: true }, "A", operador)).status, 403);
    assert.equal((await a.chamar("POST", `/importacoes/${p.corpo.data.id}/pares`, { confirmarAltaConfianca: true }, "A", operador)).status, 403);
  } finally { await a.fechar(); }
});

test("lançamento manual: reclassificar sem motivo é recusado; mês fechado bloqueia; histórico registra antes/depois", async () => {
  const a = await ambiente();
  try {
    const conta = (await a.chamar("POST", "/contas", { nome: "caixa", tipoConta: "caixa_fisico" })).corpo.data;
    const c1 = (await a.chamar("POST", "/plano-contas", { tipo: "despesa", natureza: "fixa", nome: "luz", papel: "despesa_fixa" })).corpo.data;
    const c2 = (await a.chamar("POST", "/plano-contas", { tipo: "despesa", natureza: "variavel", nome: "outras", papel: "despesa_variavel" })).corpo.data;
    const l = (await a.chamar("POST", "/lancamentos", { contaId: conta.id, categoriaId: c1.id, descricao: "conta de luz", sentido: "saida", valor: "123,45", dataMovimento: "2026-09-10" })).corpo.data;
    assert.equal(l.valor_centavos, 12345);
    assert.equal((await a.chamar("PATCH", `/lancamentos/${l.id}`, { categoriaId: c2.id })).status, 400);
    assert.equal((await a.chamar("PATCH", `/lancamentos/${l.id}`, { categoriaId: c2.id, notaRevisao: "era variável" })).status, 200);
    const h = (await a.chamar("GET", `/auditoria?entidade=fin_lancamentos&entidadeId=${l.id}`)).corpo.data;
    assert.equal(h.length, 2);
    assert.equal(h[0].antes.categoria_id, c1.id);
    assert.equal(h[0].depois.categoria_id, c2.id);
    assert.equal((await a.chamar("PATCH", `/plano-contas/${c2.id}`, { papel: "despesa_fixa" })).status, 400); // categoria em uso
    a.repo.fecharPeriodo({ organizacaoId: U(1), unidadeId: U(2), usuarioId: U(3) }, "2026-09");
    assert.equal((await a.chamar("PATCH", `/lancamentos/${l.id}`, { descricao: "x" })).status, 400);
    assert.equal((await a.chamar("POST", "/lancamentos", { contaId: conta.id, descricao: "novo", sentido: "saida", valor: "1", dataMovimento: "2026-09-11" })).status, 400);
  } finally { await a.fechar(); }
});
