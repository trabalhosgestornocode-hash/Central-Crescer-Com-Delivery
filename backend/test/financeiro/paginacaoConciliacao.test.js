// F-4: o PostgREST devolve no máximo 1000 linhas por requisição. As referências e as resoluções da conciliação precisam ser lidas por páginas;
// antes, `.limit(5000)` truncava em silêncio (no Supabase, em 1000) e a conciliação da aplicação divergia da do banco (fechamento bloqueado com 409).
import { test } from "node:test";
import assert from "node:assert/strict";
import { listarReferencias, listarResolucoes } from "../../src/modules/gestao-financeira/dominio/repositorio.conciliacao.js";

const CTX = { organizacaoId: "00000000-0000-4000-8000-000000000001", unidadeId: "00000000-0000-4000-8000-000000000002", usuarioId: "00000000-0000-4000-8000-000000000006" };

/** db falso com a semântica relevante do PostgREST: filtros ignorados, ordem preservada, `range` respeitado e TETO de 1000 linhas por requisição. */
function dbFalso(total) {
  const linhas = Array.from({ length: total }, (_, i) => ({ id: `id-${String(i).padStart(6, "0")}` }));
  const chamadas = [];
  const consulta = () => {
    const q = { ini: 0, fim: Infinity, lim: Infinity };
    const api = {
      select: () => api, eq: () => api, gte: () => api, lte: () => api, order: () => api,
      range: (a, b) => { q.ini = a; q.fim = b; return api; },
      limit: (n) => { q.lim = n; return api; },
      then: (res) => { chamadas.push({ ...q }); const fim = Math.min(q.fim + 1, q.ini + q.lim, q.ini + 1000); return Promise.resolve({ data: linhas.slice(q.ini, fim), error: null }).then(res); },
    };
    return api;
  };
  return { db: { from: () => consulta() }, chamadas };
}

for (const [nome, fn] of [["referências", (db) => listarReferencias(CTX, { mes: "2026-08" }, db)], ["resoluções", (db) => listarResolucoes(CTX, { mes: "2026-08" }, db)]]) {
  test(`${nome}: lê TODAS as linhas em páginas (5 001 linhas, teto de 1000 por requisição)`, async () => {
    const { db, chamadas } = dbFalso(5001);
    const r = await fn(db);
    assert.equal(r.length, 5001, "nenhuma linha pode ser perdida");
    assert.equal(new Set(r.map((x) => x.id)).size, 5001, "sem duplicatas entre páginas");
    assert.equal(chamadas.length, 6, "5 páginas cheias + 1 parcial");
  });
  test(`${nome}: exatamente 1000 linhas faz uma requisição extra vazia e para`, async () => {
    const { db, chamadas } = dbFalso(1000);
    assert.equal((await fn(db)).length, 1000);
    assert.equal(chamadas.length, 2);
  });
  test(`${nome}: mês vazio`, async () => {
    const { db } = dbFalso(0);
    assert.deepEqual(await fn(db), []);
  });
}
