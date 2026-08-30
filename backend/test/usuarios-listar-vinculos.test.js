// listarUsuarios (tenant) — reflete vínculo por EMPRESA e vínculo direto por
// UNIDADE, sem duplicar quem tem os dois.
//
// Rodar: node --test test/usuarios-listar-vinculos.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { listarUsuarios } from "../src/modules/usuarios/usuarios.service.js";

const ORG = "00000000-0000-4000-8000-000000000001";
const UNID_1 = "00000000-0000-4000-8000-0000000000a1";
const UNID_2 = "00000000-0000-4000-8000-0000000000a2";
const U_ORG = "10000000-0000-4000-8000-000000000001"; // só empresa
const U_UNI = "20000000-0000-4000-8000-000000000002"; // só unidade
const U_AMBOS = "30000000-0000-4000-8000-000000000003"; // os dois

function fakeSupabase(estado) {
  return {
    from(tabela) {
      const ctx = { tabela, filtros: {}, inFiltro: null };
      const builder = {
        select() { return builder; },
        eq(c, v) { ctx.filtros[c] = v; return builder; },
        in(c, arr) { ctx.inFiltro = { col: c, valores: arr }; return builder; },
        order() { return resolver(); },
        then(res, rej) { return resolver().then(res, rej); },
      };
      function resolver() {
        const linhas = (estado[tabela] ?? []).filter((l) => {
          const okEq = Object.entries(ctx.filtros).every(([k, v]) => l[k] === v);
          const okIn = !ctx.inFiltro || ctx.inFiltro.valores.includes(l[ctx.inFiltro.col]);
          return okEq && okIn;
        });
        return Promise.resolve({ data: linhas, error: null });
      }
      return builder;
    },
  };
}

const estadoBase = () => ({
  usuarios_organizacoes: [
    { usuario_id: U_ORG, organizacao_id: ORG, papel: "operations", ativo: true, created_at: "2026-01-01" },
    { usuario_id: U_AMBOS, organizacao_id: ORG, papel: "organization_admin", ativo: true, created_at: "2026-01-02" },
  ],
  unidades: [
    { id: UNID_1, nome: "Loja 1", organizacao_id: ORG },
    { id: UNID_2, nome: "Loja 2", organizacao_id: ORG },
  ],
  usuarios_unidades: [
    { usuario_id: U_UNI, unidade_id: UNID_1, papel: "finance", ativo: true, created_at: "2026-02-01" },
    { usuario_id: U_AMBOS, unidade_id: UNID_2, papel: null, ativo: true, created_at: "2026-02-02" },
  ],
  perfis: [
    { id: U_ORG, nome: "Ana Org", email: "ana@x.com", ativo: true },
    { id: U_UNI, nome: "Bia Uni", email: "bia@x.com", ativo: true },
    { id: U_AMBOS, nome: "Caio Ambos", email: "caio@x.com", ativo: true },
  ],
});

describe("listarUsuarios — empresa + unidade", () => {
  test("inclui quem tem acesso SÓ por unidade", async () => {
    const lista = await listarUsuarios({ organizacaoId: ORG }, { supabase: fakeSupabase(estadoBase()) });
    const bia = lista.find((u) => u.id === U_UNI);
    assert.ok(bia, "usuário só-unidade aparece na listagem");
    assert.equal(bia.origem, "unidade");
    assert.equal(bia.papel, null, "não tem cargo de empresa");
    assert.equal(bia.gerenciavelAqui, false, "o <select> desta tela não mexe nele");
    assert.equal(bia.unidades[0].unidadeNome, "Loja 1");
    assert.equal(bia.unidades[0].papel, "finance");
  });

  test("quem tem os dois vínculos aparece UMA vez, com cargo da empresa", async () => {
    const lista = await listarUsuarios({ organizacaoId: ORG }, { supabase: fakeSupabase(estadoBase()) });
    const caio = lista.filter((u) => u.id === U_AMBOS);
    assert.equal(caio.length, 1, "sem duplicata");
    assert.equal(caio[0].papel, "organization_admin");
    assert.equal(caio[0].origem, "empresa+unidade");
    assert.equal(caio[0].gerenciavelAqui, true);
    // cargo específico da unidade preservado (null = herda)
    const u2 = caio[0].unidades.find((x) => x.unidadeId === UNID_2);
    assert.equal(u2.papel, null);
    assert.equal(u2.papelRotulo, "herda da empresa");
  });

  test("usuário só-empresa continua igual", async () => {
    const lista = await listarUsuarios({ organizacaoId: ORG }, { supabase: fakeSupabase(estadoBase()) });
    const ana = lista.find((u) => u.id === U_ORG);
    assert.equal(ana.origem, "empresa");
    assert.equal(ana.papel, "operations");
    assert.equal(ana.unidades.length, 0);
  });

  test("vínculo de unidade de OUTRA empresa não vaza", async () => {
    const estado = estadoBase();
    estado.usuarios_unidades.push({ usuario_id: "99999999-0000-4000-8000-000000000009", unidade_id: "ffffffff-0000-4000-8000-00000000000f", papel: "viewer", ativo: true, created_at: "2026-03-01" });
    const lista = await listarUsuarios({ organizacaoId: ORG }, { supabase: fakeSupabase(estado) });
    assert.ok(!lista.some((u) => u.id === "99999999-0000-4000-8000-000000000009"));
  });

  test("empresa sem nenhum vínculo → lista vazia", async () => {
    const estado = { usuarios_organizacoes: [], unidades: [], usuarios_unidades: [], perfis: [] };
    const lista = await listarUsuarios({ organizacaoId: ORG }, { supabase: fakeSupabase(estado) });
    assert.deepEqual(lista, []);
  });
});
