// Testes de `listarMargensOficialOuComparacao` (cmv.service.js) — o ponto de
// entrada único que Dashboard comum e Produtos/CMV usam para resolver qual
// tabela mostrar. Unit test, sem rede/Supabase: `resolverTabela` e
// `listarMargens` são injetados (mesmo padrão de agente-produtos-cmv-tools.test.js).
//
// Rodar: node --env-file-if-exists=.env --test test/cmv-tabela-oficial.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { listarMargensOficialOuComparacao } from "../src/modules/cmv/cmv.service.js";

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const UNIDADE_ID = "44444444-4444-4444-8444-444444444444";

describe("listarMargensOficialOuComparacao", () => {
  test("sem tabela de comparação: usa a tabela OFICIAL da unidade (balcão)", async () => {
    let argsMargens = null;
    const deps = {
      resolverTabela: async ({ unidadeId, canal }) => {
        assert.equal(unidadeId, UNIDADE_ID);
        assert.equal(canal, "balcao");
        return { canal: "balcao", tabelaOficial: "E" };
      },
      listarMargens: async (a) => { argsMargens = a; return [{ tabela: "E" }]; },
    };
    const r = await listarMargensOficialOuComparacao({ organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, canal: "balcao" }, deps);
    assert.equal(argsMargens.tabela, "E");
    assert.equal(r.tabela, "E");
    assert.equal(r.tabelaOficial, "E");
    assert.equal(r.comparando, false);
  });

  test("sem tabela de comparação: usa a tabela OFICIAL da unidade (iFood)", async () => {
    const deps = {
      resolverTabela: async ({ canal }) => ({ canal, tabelaOficial: "Z4" }),
      listarMargens: async (a) => [{ tabela: a.tabela }],
    };
    const r = await listarMargensOficialOuComparacao({ organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, canal: "ifood" }, deps);
    assert.equal(r.canal, "ifood");
    assert.equal(r.tabela, "Z4");
  });

  test("tabela de comparação informada: usa a tabela pedida, nunca a oficial — mas devolve as duas", async () => {
    let argsMargens = null;
    const deps = {
      resolverTabela: async () => ({ canal: "balcao", tabelaOficial: "E" }),
      listarMargens: async (a) => { argsMargens = a; return [{ tabela: "A" }]; },
    };
    const r = await listarMargensOficialOuComparacao(
      { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, canal: "balcao", tabelaComparacao: "A" }, deps,
    );
    assert.equal(argsMargens.tabela, "A");
    assert.equal(r.tabela, "A");
    assert.equal(r.tabelaOficial, "E"); // a comparação NUNCA apaga a informação da oficial
    assert.equal(r.comparando, true);
  });

  test("comparação nunca sobrescreve/consulta a unidade — resolverTabela é chamado só para rotular", async () => {
    let chamouListarMargens = 0;
    const deps = {
      resolverTabela: async () => ({ canal: "balcao", tabelaOficial: "E" }),
      listarMargens: async () => { chamouListarMargens++; return []; },
    };
    await listarMargensOficialOuComparacao(
      { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, canal: "balcao", tabelaComparacao: "A" }, deps,
    );
    assert.equal(chamouListarMargens, 1); // 1 única consulta, com a tabela de comparação — nunca 1 por tabela
  });

  test("sem tabela oficial configurada: erro controlado, NUNCA cai para a primeira tabela/lista tudo", async () => {
    let chamouListarMargens = false;
    const deps = {
      resolverTabela: async () => ({ canal: "balcao", tabelaOficial: null }),
      listarMargens: async () => { chamouListarMargens = true; return []; },
    };
    await assert.rejects(
      () => listarMargensOficialOuComparacao({ organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, canal: "balcao" }, deps),
      (err) => {
        assert.equal(err.codigo, "TABELA_NAO_CONFIGURADA");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
    assert.equal(chamouListarMargens, false);
  });

  test("sem unidade selecionada (sessão só de organização): erro controlado diferente de 'não configurada'", async () => {
    const deps = {
      resolverTabela: async ({ unidadeId }) => { assert.equal(unidadeId, null); return { canal: "balcao", tabelaOficial: null }; },
      listarMargens: async () => [],
    };
    await assert.rejects(
      () => listarMargensOficialOuComparacao({ organizacaoId: ORG_ID, unidadeId: null, canal: "balcao" }, deps),
      (err) => {
        assert.equal(err.codigo, "UNIDADE_NAO_SELECIONADA");
        return true;
      },
    );
  });

  test("canal ausente/ inválido normaliza para 'balcao' — nunca quebra nem manda undefined pro banco", async () => {
    let canalRecebido = null;
    const deps = {
      resolverTabela: async ({ canal }) => { canalRecebido = canal; return { canal: "balcao", tabelaOficial: "E" }; },
      listarMargens: async () => [],
    };
    const r = await listarMargensOficialOuComparacao({ organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, canal: "qualquer-coisa" }, deps);
    assert.equal(canalRecebido, "balcao");
    assert.equal(r.canal, "balcao");
  });
});

describe("empresa própria (sem modelo inicial Subway) não exige tabela comercial", () => {
  const semTabela = async ({ canal }) => ({ canal, tabelaOficial: null });
  const listarMargens = async (a) => { listarMargens.chamadas.push(a); return [{ produto_id: "p1", canal: a.canal, tabela: null, preco: 20 }]; };
  listarMargens.chamadas = [];

  test("sem tabela oficial e sem exigência: devolve os preços do canal (sem filtrar tabela), sem erro", async () => {
    const r = await listarMargensOficialOuComparacao({ organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, canal: "ifood" },
      { resolverTabela: semTabela, listarMargens, exigeTabela: async () => false });
    assert.deepEqual(listarMargens.chamadas.at(-1), { organizacaoId: ORG_ID, canal: "ifood" });
    assert.deepEqual(r, { data: [{ produto_id: "p1", canal: "ifood", tabela: null, preco: 20 }], canal: "ifood", tabela: null, tabelaOficial: null, comparando: false, exigeTabela: false });
  });

  test("franquia (exige tabela) sem tabela oficial continua com TABELA_NAO_CONFIGURADA", async () => {
    await assert.rejects(
      listarMargensOficialOuComparacao({ organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, canal: "balcao" },
        { resolverTabela: semTabela, listarMargens, exigeTabela: async () => true }),
      (e) => e.codigo === "TABELA_NAO_CONFIGURADA");
  });

  test("sem unidade selecionada continua pedindo a unidade, mesmo em empresa própria", async () => {
    await assert.rejects(
      listarMargensOficialOuComparacao({ organizacaoId: ORG_ID, unidadeId: null, canal: "balcao" },
        { resolverTabela: semTabela, listarMargens, exigeTabela: async () => false }),
      (e) => e.codigo === "UNIDADE_NAO_SELECIONADA");
  });
});
