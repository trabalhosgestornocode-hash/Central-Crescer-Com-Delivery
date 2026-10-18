// iFood — múltiplas conexões: o REPOSITÓRIO real (supabase falso). Payloads, filtros de tenant, seleção em código e tolerância à
// ordem de publicação (código no ar antes da migration 124). Sem rede e sem banco.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const ORG = "00000000-0000-0000-0000-000000000001";
const SACI = "00000000-0000-0000-0000-0000000000a1";
const NORTH = "00000000-0000-0000-0000-0000000000b2";
const M_SACI = "aaaaaaaa-1111-4111-8111-00000000000a";
const M_REAL = "ea100000-0000-4000-8000-00000000bbbb";

const { supabase } = await import("../src/config/supabase.js");
const repoReal = await import("../src/modules/ifood/ifood.repository.js");
const orderRepo = await import("../src/modules/ifood/ifoodOrder.repository.js");
const erro = (codigo) => (e) => e?.codigo === codigo;

/** supabase falso: registra cada operação e devolve `respostas` na ordem (uma por consulta terminal). */
function fakeSupabase(respostas) {
  const chamadas = [];
  const inserts = [];
  const original = supabase.from;
  supabase.from = (tabela) => {
    const reg = { tabela, ops: [] };
    chamadas.push(reg);
    const q = new Proxy({}, {
      get(_, op) {
        if (op === "then") return (res, rej) => Promise.resolve(respostas.shift() ?? { data: [], error: null }).then(res, rej);
        return (...args) => {
          reg.ops.push([op, ...args]);
          if (op === "insert") inserts.push(args[0]);
          if (op === "maybeSingle" || op === "single") return Promise.resolve(respostas.shift() ?? { data: null, error: null });
          return q;
        };
      },
    });
    return q;
  };
  return { chamadas, inserts, restaurar: () => { supabase.from = original; } };
}
const tem = (reg, ...op) => reg.ops.some((o) => op.every((v, i) => o[i] === v));

describe("repositório de conexões iFood", () => {
  test("listarConexoesVivas: tenant em todo filtro, só vivas, ordem ESTÁVEL definida em código (criação, id) — nunca 'a primeira que vier'", async () => {
    const f = fakeSupabase([{ data: [{ id: "b", criado_em: "2026-10-02" }, { id: "c", criado_em: "2026-10-01" }, { id: "a", criado_em: "2026-10-02" }], error: null }]);
    try {
      const r = await repoReal.listarConexoesVivas({ organizacaoId: ORG, unidadeId: NORTH });
      assert.deepEqual(r.map((c) => c.id), ["c", "a", "b"], "criação, depois id — independe da ordem devolvida pelo banco");
      const c = f.chamadas[0];
      assert.equal(c.tabela, "ifood_conexoes");
      assert.ok(tem(c, "eq", "organizacao_id", ORG) && tem(c, "eq", "unidade_id", NORTH) && tem(c, "neq", "status", "revogada"));
      assert.ok(!c.ops.some((o) => o[0] === "order"), "sem dependência de coluna de ordenação no banco");
      await assert.rejects(repoReal.listarConexoesVivas({ organizacaoId: ORG, unidadeId: null }), "sem tenant é erro");
    } finally { f.restaurar(); }
  });

  test("obterConexaoViva por finalidade escolhe em código (mesma resposta em qualquer ordem); duas do mesmo tipo = ambígua", async () => {
    const ped = { id: "p", status: "ativa", finalidade: "pedidos_producao" };
    const fin = { id: "f", status: "ativa", finalidade: "financeiro_homologacao" };
    const f = fakeSupabase([
      { data: [ped, fin], error: null }, { data: [fin, ped], error: null },
      { data: [{ ...ped, id: "x1" }, { ...ped, id: "x2" }], error: null },
    ]);
    try {
      assert.equal((await repoReal.obterConexaoViva({ organizacaoId: ORG, unidadeId: NORTH, finalidade: "financeiro_homologacao" })).id, "f");
      assert.equal((await repoReal.obterConexaoViva({ organizacaoId: ORG, unidadeId: NORTH, finalidade: "pedidos_producao" })).id, "p");
      await assert.rejects(repoReal.obterConexaoViva({ organizacaoId: ORG, unidadeId: NORTH, finalidade: "pedidos_producao" }), erro("IFOOD_CONEXAO_AMBIGUA"));
    } finally { f.restaurar(); }
  });

  test("criarConexao: finalidade/ambiente só vão no INSERT quando explícitos e não-legados (`legado` = payload idêntico ao de antes)", async () => {
    const f = fakeSupabase([{ data: { id: "n" }, error: null }, { data: { id: "n" }, error: null }, { data: { id: "n" }, error: null }]);
    try {
      await repoReal.criarConexao({ organizacaoId: ORG, unidadeId: NORTH, criadoPor: "u" });
      await repoReal.criarConexao({ organizacaoId: ORG, unidadeId: NORTH, criadoPor: "u", finalidade: "legado" });
      await repoReal.criarConexao({ organizacaoId: ORG, unidadeId: NORTH, criadoPor: "u", finalidade: "pedidos_producao" });
    } finally { f.restaurar(); }
    assert.deepEqual(f.inserts[0], { organizacao_id: ORG, unidade_id: NORTH, status: "pendente", criado_por: "u" });
    assert.deepEqual(f.inserts[1], f.inserts[0]);
    assert.deepEqual(f.inserts[2], { ...f.inserts[0], finalidade: "pedidos_producao", ambiente: "producao" });
  });

  test("obterOuCriarConexao: duas autorizações simultâneas — a 2ª bate no índice único e usa a conexão que a 1ª criou (sem 500)", async () => {
    const criada = { id: "criada-pela-1a", status: "pendente", finalidade: "pedidos_producao" };
    const f = fakeSupabase([
      { data: [], error: null },                                                                                                  // ainda não existe
      { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "uq_ifood_conexao_unidade_finalidade_viva"' } },
      { data: [criada], error: null },                                                                                            // a 1ª já criou
    ]);
    try {
      const r = await repoReal.obterOuCriarConexao({ organizacaoId: ORG, unidadeId: NORTH, criadoPor: "u", finalidade: "pedidos_producao" });
      assert.equal(r.id, "criada-pela-1a");
    } finally { f.restaurar(); }
    const g = fakeSupabase([{ data: [], error: null }, { data: null, error: { code: "XX000", message: "outro erro" } }]);
    try {
      await assert.rejects(repoReal.obterOuCriarConexao({ organizacaoId: ORG, unidadeId: NORTH, criadoPor: "u", finalidade: "pedidos_producao" }), /outro erro/);
    } finally { g.restaurar(); }
  });

  test("criarSessaoOAuth: grava a finalidade; sem a coluna (124 ausente) repete sem ela — a reautorização não depende da ordem de publicação", async () => {
    const f = fakeSupabase([
      { data: { id: "s1" }, error: null },
      { data: null, error: { code: "PGRST204", message: "Could not find the 'finalidade' column" } },
      { data: { id: "s2" }, error: null },
      { data: null, error: { code: "23505", message: "outro erro" } },
    ]);
    const base = { organizacaoId: ORG, unidadeId: NORTH, appType: "order", userCode: "u", verifierCifrado: "v", expiraEm: "2026-10-17T00:00:00Z", criadoPor: "x" };
    try {
      await repoReal.criarSessaoOAuth({ ...base, finalidade: "pedidos_producao" });
      assert.equal(f.inserts[0].finalidade, "pedidos_producao");
      const r = await repoReal.criarSessaoOAuth({ ...base, finalidade: "pedidos_producao" });   // coluna ausente -> repete
      assert.equal(r.id, "s2");
      assert.equal(f.inserts[1].finalidade, "pedidos_producao");
      assert.ok(!("finalidade" in f.inserts[2]), "a repetição vai sem a coluna");
      await assert.rejects(repoReal.criarSessaoOAuth({ ...base, finalidade: "pedidos_producao" }), /outro erro/);   // outros erros sobem
    } finally { f.restaurar(); }
  });

  test("cancelarSessoesPendentes: só os apps da conexão desconectada (a autorização em curso da outra não é tocada)", async () => {
    const f = fakeSupabase([{ data: [], error: null }, { data: [], error: null }]);
    try {
      await repoReal.cancelarSessoesPendentes({ organizacaoId: ORG, unidadeId: NORTH, appTypes: ["order"] });
      await repoReal.cancelarSessoesPendentes({ organizacaoId: ORG, unidadeId: NORTH });
    } finally { f.restaurar(); }
    assert.ok(f.chamadas[0].ops.some((o) => o[0] === "in" && o[1] === "app_type" && o[2].join() === "order"));
    assert.ok(!f.chamadas[1].ops.some((o) => o[0] === "in"), "sem appTypes: todas as pendentes, como antes");
  });
});

describe("repositório de pedidos: resolução do token por merchant", () => {
  test("a conexão financeira de homologação NUNCA resolve token de pedidos (filtro por finalidade, tenant e status)", async () => {
    const f = fakeSupabase([{ data: { id: "c-real", organizacao_id: ORG, unidade_id: NORTH, merchant_id: M_REAL }, error: null }]);
    try {
      const r = await orderRepo.obterConexaoAtivaDoMerchant({ organizacaoId: ORG, unidadeId: NORTH, merchantId: M_REAL });
      assert.equal(r.id, "c-real");
      const c = f.chamadas[0];
      assert.ok(tem(c, "neq", "finalidade", "financeiro_homologacao"));
      assert.ok(tem(c, "eq", "merchant_id", M_REAL) && tem(c, "eq", "unidade_id", NORTH) && tem(c, "eq", "organizacao_id", ORG) && tem(c, "eq", "status", "ativa"));
    } finally { f.restaurar(); }
  });

  test("as migrations 124/125 e os scripts de rotulagem NÃO tocam pedidos, eventos, credenciais nem merchants (preservação dos registros existentes)", async () => {
    const { readFileSync } = await import("node:fs");
    const dir = new URL("../../database/", import.meta.url);
    const sem = (t) => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join("\n");
    for (const f of ["migrations/124_ifood_conexao_finalidade.sql", "migrations/125_ifood_conexao_remove_indice_unidade.sql", "operacoes/ifood-conexao-rotular.sql", "operacoes/ifood-conexao-rotular-rollback.sql"]) {
      const sql = sem(readFileSync(new URL(f, dir), "utf8"));
      assert.doesNotMatch(sql, /ifood_pedidos|ifood_eventos|ifood_pedido_acoes|ifood_merchant_vinculos/, f);
      assert.doesNotMatch(sql, /\b(delete\s+from|truncate)\b/i, f);
      assert.doesNotMatch(sql, /drop\s+table/i, f);
    }
    // a 124 só ALTERA ifood_conexoes/ifood_oauth_sessoes com colunas novas; nenhum UPDATE de dados existentes
    const m124 = sem(readFileSync(new URL("migrations/124_ifood_conexao_finalidade.sql", dir), "utf8"));
    assert.doesNotMatch(m124, /\bupdate\s+\w+\s+set\b/i);
    assert.doesNotMatch(m124, /ifood_credenciais\s+(set|drop)|alter\s+table\s+ifood_credenciais/i);
    // a rotulagem só muda finalidade e ambiente
    const rot = sem(readFileSync(new URL("operacoes/ifood-conexao-rotular.sql", dir), "utf8"));
    assert.match(rot, /update ifood_conexoes\s+set finalidade = :'finalidade',\s+ambiente = case/);
    assert.doesNotMatch(rot, /merchant_id\s*=|status\s*=\s*'|ifood_credenciais\s+set/i);
  });

  test("código no ar antes da 124 (coluna ausente): repete sem o filtro — o token da Saci continua resolvendo", async () => {
    const f = fakeSupabase([
      { data: null, error: { code: "42703", message: "column ifood_conexoes.finalidade does not exist" } },
      { data: { id: "c-saci", organizacao_id: ORG, unidade_id: SACI, merchant_id: M_SACI }, error: null },
    ]);
    try {
      const r = await orderRepo.obterConexaoAtivaDoMerchant({ organizacaoId: ORG, unidadeId: SACI, merchantId: M_SACI });
      assert.equal(r.id, "c-saci");
      assert.ok(!tem(f.chamadas[1], "neq", "finalidade"));
    } finally { f.restaurar(); }
  });
});
