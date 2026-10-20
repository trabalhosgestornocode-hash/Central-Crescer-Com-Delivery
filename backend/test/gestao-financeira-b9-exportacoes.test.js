// B9 — exportações HTTP com o GATE REAL e o domínio real do Agente 2 (repositório em memória, dados sintéticos, loopback).
// Revisão do Agente 1: autorização, isolamento por unidade, neutralização de fórmulas, cabeçalhos de download, formato e dados parciais.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { requireFinanceiro, autorizarAcaoFinanceira } from "../src/middlewares/financeiro.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";

const { criarDominioRouter } = await import("../src/modules/gestao-financeira/dominio/rotas.js");
const cadastros = await import("../src/modules/gestao-financeira/dominio/cadastros.service.js");
const lanc = await import("../src/modules/gestao-financeira/dominio/lancamentos.service.js");
const { criarRepoMemoria } = await import("./financeiro/helpers/repoMemoria.js");

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = U(1), UNI = U(2), UNI_B = U(4), PERFIL = U(5), USER = U(6);
const ctx = { organizacaoId: ORG, unidadeId: UNI, usuarioId: USER };
const conc = (nivel, o = {}) => ({ organizacao_id: ORG, unidade_id: UNI, nivel, somente_financeiro: false, revogada_em: null, expira_em: null, ...o });
const PER = "de=2026-08-01&ate=2026-08-31";

async function servir({ nivel, impersonando = false, concessao }, fn) {
  const repo = criarRepoMemoria();
  const c = concessao === undefined ? conc(nivel) : concessao;
  const leitor = { moduloEmpresa: async () => true, moduloUnidade: async () => true, concessao: async () => c };
  const app = express(); app.use(express.json());
  app.use((req, _s, next) => { req.user = { id: USER }; req.tenant = { organizacaoId: ORG, unidadeId: UNI }; req.acesso = { perfilId: PERFIL, papel: "organization_admin", impersonando }; next(); });
  app.use("/fin", requireFinanceiro(leitor), criarDominioRouter({ autorizar: autorizarAcaoFinanceira, deps: { repo, db: undefined } }));
  app.use(errorHandler);
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); const buf = Buffer.from(await r.arrayBuffer()); return { status: r.status, h: r.headers, buf, txt: buf.toString("utf8") }; };
  try { return await fn(get, repo); } finally { srv.close(); }
}
const codigo = (r) => { try { return JSON.parse(r.txt)?.details?.codigo; } catch { return undefined; } };

async function semear(repo) {
  const d = { repo, db: undefined };
  const cat = await cadastros.criarCategoria(ctx, { tipo: "RECEITA", natureza: "RECEBIMENTO", nome: "VENDAS", papel: "receita_operacional" }, d);
  const conta = await cadastros.criarConta(ctx, { nome: "=CAIXA", tipoConta: "banco" }, d);
  for (const descricao of ["=HYPERLINK(\"http://x\",\"a\")", "+SOMA(1;2)", "-2+3", "@cmd", "Venda comum"]) {
    await lanc.criarLancamento(ctx, { contaId: conta.id, categoriaId: cat.id, descricao, sentido: "entrada", valor: 10.5, dataMovimento: "2026-08-10" }, d);
  }
  return { cat, conta };
}

describe("B9 — exportação (gate real)", () => {
  for (const nivel of ["leitura", "operador", "gestor"]) {
    test(`${nivel}: exporta CSV com cabeçalhos de download seguros e fórmulas neutralizadas`, () => servir({ nivel }, async (get, repo) => {
      await semear(repo);
      const r = await get(`/fin/relatorios/tabelas/movimentacoes/exportar?formato=csv&${PER}`);
      assert.equal(r.status, 200, r.txt.slice(0, 200));
      assert.match(r.h.get("content-disposition"), /^attachment; filename="[A-Za-z0-9._-]+\.csv"$/);
      assert.equal(r.h.get("cache-control"), "no-store");
      assert.equal(r.h.get("x-content-type-options"), "nosniff");
      assert.ok(Number(r.h.get("x-linhas")) >= 5);
      assert.equal(r.buf[0], 0xef, "BOM UTF-8 para o Excel"); // EF BB BF
      // nenhuma célula começa com gatilho de fórmula
      for (const linha of r.txt.replace(/^﻿/, "").split("\r\n").filter(Boolean)) {
        for (const celula of linha.split(";")) {
          const v = celula.replace(/^"|"$/g, "");
          assert.doesNotMatch(v, /^[=+@\t\r]/, `célula perigosa: ${v}`);
        }
      }
      assert.ok(r.txt.includes("'=HYPERLINK"), "o texto original é preservado com apóstrofo");
    }));
  }

  test("XLSX é um zip válido (PK) e vem como anexo", () => servir({ nivel: "leitura" }, async (get, repo) => {
    await semear(repo);
    const r = await get(`/fin/relatorios/tabelas/movimentacoes/exportar?formato=xlsx&${PER}`);
    assert.equal(r.status, 200);
    assert.equal(r.buf[0], 0x50); assert.equal(r.buf[1], 0x4b);
    assert.match(r.h.get("content-disposition"), /^attachment; filename="[A-Za-z0-9._-]+\.xlsx"$/);
  }));

  test("formato inválido e relatório inexistente falham (sem arquivo)", () => servir({ nivel: "gestor" }, async (get) => {
    assert.equal((await get(`/fin/relatorios/tabelas/movimentacoes/exportar?formato=pdf&${PER}`)).status, 400);
    assert.ok([400, 404].includes((await get(`/fin/relatorios/tabelas/nao-existe/exportar?formato=csv&${PER}`)).status));
  }));

  test("isolamento: unidadeId de outra unidade → 403 UNIDADE_FORA_DO_CONTEXTO (tela e exportação); a própria unidade passa", () => servir({ nivel: "gestor" }, async (get, repo) => {
    await semear(repo);
    for (const rota of ["", "/exportar?formato=csv&"]) {
      const sep = rota ? "" : "?";
      const r = await get(`/fin/relatorios/tabelas/movimentacoes${rota}${sep}unidadeId=${UNI_B}&${PER}`);
      assert.equal(r.status, 403, rota); assert.equal(codigo(r), "UNIDADE_FORA_DO_CONTEXTO");
    }
    assert.equal((await get(`/fin/relatorios/tabelas/movimentacoes/exportar?formato=csv&unidadeId=${UNI}&${PER}`)).status, 200);
  }));

  test("o conteúdo exportado é só da unidade do contexto (lançamento de outra unidade nunca aparece)", () => servir({ nivel: "gestor" }, async (get, repo) => {
    await semear(repo);
    const outra = { organizacaoId: ORG, unidadeId: UNI_B, usuarioId: USER };
    const d = { repo, db: undefined };
    const cat = await cadastros.criarCategoria(outra, { tipo: "RECEITA", natureza: "RECEBIMENTO", nome: "VENDAS B", papel: "receita_operacional" }, d);
    const conta = await cadastros.criarConta(outra, { nome: "CONTA SECRETA DA OUTRA UNIDADE", tipoConta: "banco" }, d);
    await lanc.criarLancamento(outra, { contaId: conta.id, categoriaId: cat.id, descricao: "VENDA DA OUTRA UNIDADE", sentido: "entrada", valor: 99, dataMovimento: "2026-08-11" }, d);
    const r = await get(`/fin/relatorios/tabelas/movimentacoes/exportar?formato=csv&${PER}`);
    assert.equal(r.status, 200);
    assert.ok(!r.txt.includes("OUTRA UNIDADE") && !r.txt.includes("SECRETA"));
  }));

  test("sem concessão / impersonação / perfil sem acesso: 403 e NENHUM byte de arquivo", async () => {
    for (const [cfg, cod] of [[{ nivel: "x", concessao: null }, "FINANCEIRO_SEM_CONCESSAO"], [{ nivel: "gestor", impersonando: true }, "FINANCEIRO_BLOQUEADO_IMPERSONACAO"]]) {
      await servir(cfg, async (get) => {
        const r = await get(`/fin/relatorios/tabelas/movimentacoes/exportar?formato=csv&${PER}`);
        assert.equal(r.status, 403); assert.equal(codigo(r), cod);
        assert.equal(r.h.get("content-disposition"), null);
        assert.ok(!r.txt.includes(";"), "sem conteúdo tabular");
      });
    }
  });

  test("catálogo e tela também exigem o gate; tela de movimentações informa meta (parcial/avisos) sem inventar números", () => servir({ nivel: "leitura" }, async (get, repo) => {
    const cat = await get("/fin/relatorios/tabelas/catalogo");
    assert.equal(cat.status, 200);
    assert.ok(JSON.parse(cat.txt).data.length >= 7);
    await semear(repo);
    const t = await get(`/fin/relatorios/tabelas/movimentacoes?${PER}`);
    assert.equal(t.status, 200);
    assert.ok("meta" in JSON.parse(t.txt).data || "meta" in JSON.parse(t.txt));
  }));
});
