// Testes de `associarEmpresasLote` (plataforma.usuarios.service.js).
// Unit test SEM rede: injeta um fake do supabase e um auditar noop.
//
// Cobre os cenários do pedido:
//   1. associar 1 empresa;
//   2. associar 3 de uma vez;
//   3. 3 com o MESMO cargo;
//   4. 3 com cargos DIFERENTES;
//   5. NUNCA altera cargo de vínculo já existente (recusa 409, não grava);
//   6. impede duplicidade dentro do payload;
//   7. atomicidade: se o insert falha, nada é gravado;
//   8. empresa inexistente na seleção → 400.
//
// Rodar: node --test test/plataforma-associar-lote.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { associarEmpresasLote } from "../src/modules/plataforma/plataforma.usuarios.service.js";

const U = "11111111-1111-4111-8111-111111111111";
const ORG1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORG2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ORG3 = "cccccccc-3333-4333-8333-cccccccccccc";

function fakeSupabase(estado, { insertError } = {}) {
  const chamadas = [];
  return {
    chamadas,
    from(tabela) {
      const ctx = { tabela, op: "select", filtros: {}, inFiltro: null, inseridos: null };
      const builder = {
        select() { return builder; },
        insert(rows) { ctx.op = "insert"; ctx.inseridos = rows; return resolver(); },
        eq(c, v) { ctx.filtros[c] = v; return builder; },
        in(c, arr) { ctx.inFiltro = { col: c, valores: arr }; return builder; },
        maybeSingle() { return resolver(); },
        then(res, rej) { return resolver().then(res, rej); }, // await direto (sem maybeSingle)
      };
      function match(l) {
        const okEq = Object.entries(ctx.filtros).every(([k, v]) => l[k] === v);
        const okIn = !ctx.inFiltro || ctx.inFiltro.valores.includes(l[ctx.inFiltro.col]);
        return okEq && okIn;
      }
      function resolver() {
        chamadas.push({ tabela, op: ctx.op, filtros: { ...ctx.filtros }, inFiltro: ctx.inFiltro, inseridos: ctx.inseridos });
        const linhas = estado[tabela] ?? [];
        if (ctx.op === "insert") {
          if (insertError) return Promise.resolve({ error: { message: insertError } });
          estado[tabela] = linhas.concat(ctx.inseridos);
          return Promise.resolve({ error: null });
        }
        const achados = linhas.filter(match);
        // maybeSingle vs lista: devolvemos ambos os formatos de forma tolerante
        return Promise.resolve({ data: ctx.inFiltro ? achados : (achados[0] ?? null), error: null });
      }
      return builder;
    },
  };
}

const noopAuditar = async () => {};
const req = {
  user: { id: "00000000-0000-4000-8000-000000000000", email: "super@x.com" },
  headers: {}, socket: {}, header: () => null,
};
const base = () => ({
  perfis: [{ id: U, nome: "João" }],
  organizacoes: [{ id: ORG1, nome: "Empresa 1" }, { id: ORG2, nome: "Empresa 2" }, { id: ORG3, nome: "Empresa 3" }],
  usuarios_organizacoes: [],
});

describe("associarEmpresasLote", () => {
  test("1 — associa uma empresa", async () => {
    const estado = base();
    const r = await associarEmpresasLote(req, U, { itens: [{ organizacaoId: ORG1, papel: "operations" }] },
      { supabase: fakeSupabase(estado), auditar: noopAuditar });
    assert.equal(r.criadas.length, 1);
    assert.equal(estado.usuarios_organizacoes.length, 1);
    assert.equal(estado.usuarios_organizacoes[0].organizacao_id, ORG1);
    assert.equal(estado.usuarios_organizacoes[0].papel, "operations");
    assert.equal(estado.usuarios_organizacoes[0].ativo, true);
  });

  test("2 e 3 — associa três de uma vez com o MESMO cargo (atômico)", async () => {
    const estado = base();
    const itens = [ORG1, ORG2, ORG3].map((o) => ({ organizacaoId: o, papel: "viewer" }));
    const r = await associarEmpresasLote(req, U, { itens }, { supabase: fakeSupabase(estado), auditar: noopAuditar });
    assert.equal(r.criadas.length, 3);
    assert.equal(estado.usuarios_organizacoes.length, 3);
    assert.ok(estado.usuarios_organizacoes.every((v) => v.papel === "viewer"));
  });

  test("4 — três com cargos DIFERENTES, cada empresa com o seu", async () => {
    const estado = base();
    const itens = [
      { organizacaoId: ORG1, papel: "operations" },
      { organizacaoId: ORG2, papel: "finance" },
      { organizacaoId: ORG3, papel: "organization_admin" },
    ];
    await associarEmpresasLote(req, U, { itens }, { supabase: fakeSupabase(estado), auditar: noopAuditar });
    const porOrg = Object.fromEntries(estado.usuarios_organizacoes.map((v) => [v.organizacao_id, v.papel]));
    assert.equal(porOrg[ORG1], "operations");
    assert.equal(porOrg[ORG2], "finance");
    assert.equal(porOrg[ORG3], "organization_admin");
  });

  test("5 — NUNCA altera cargo de vínculo existente: recusa 409 e não grava nada", async () => {
    const estado = base();
    estado.usuarios_organizacoes = [{ usuario_id: U, organizacao_id: ORG2, papel: "organization_admin", ativo: true }];
    const itens = [
      { organizacaoId: ORG1, papel: "operations" },
      { organizacaoId: ORG2, papel: "viewer" }, // tentativa de rebaixar um admin
    ];
    await assert.rejects(
      () => associarEmpresasLote(req, U, { itens }, { supabase: fakeSupabase(estado), auditar: noopAuditar }),
      (e) => {
        assert.equal(e.statusCode, 409);
        assert.ok(Array.isArray(e.details?.jaAssociadas));
        assert.equal(e.details.jaAssociadas[0].organizacaoId, ORG2);
        return true;
      },
    );
    // Vínculo de ORG2 intacto; ORG1 não foi criado.
    assert.equal(estado.usuarios_organizacoes.length, 1);
    assert.equal(estado.usuarios_organizacoes[0].papel, "organization_admin");
  });

  test("6 — empresa repetida no payload → 400", async () => {
    await assert.rejects(
      () => associarEmpresasLote(req, U, { itens: [
        { organizacaoId: ORG1, papel: "viewer" }, { organizacaoId: ORG1, papel: "finance" },
      ] }, { supabase: fakeSupabase(base()), auditar: noopAuditar }),
      /repetida/,
    );
  });

  test("7 — atomicidade: insert falha → nada gravado, erro propagado", async () => {
    const estado = base();
    const db = fakeSupabase(estado, { insertError: "duplicate key value violates unique constraint" });
    await assert.rejects(
      () => associarEmpresasLote(req, U, { itens: [{ organizacaoId: ORG1, papel: "viewer" }] }, { supabase: db, auditar: noopAuditar }),
      (e) => { assert.equal(e.statusCode, 409); return true; },
    );
    assert.equal(estado.usuarios_organizacoes.length, 0);
  });

  test("8 — empresa inexistente na seleção → 400", async () => {
    await assert.rejects(
      () => associarEmpresasLote(req, U, { itens: [{ organizacaoId: "99999999-9999-4999-8999-999999999999", papel: "viewer" }] },
        { supabase: fakeSupabase(base()), auditar: noopAuditar }),
      /não existem/,
    );
  });

  test("lista vazia → 400", async () => {
    await assert.rejects(
      () => associarEmpresasLote(req, U, { itens: [] }, { supabase: fakeSupabase(base()), auditar: noopAuditar }),
      /ao menos uma empresa/,
    );
  });
});
