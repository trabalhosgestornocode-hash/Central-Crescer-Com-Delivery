// Fase G / H1 — ISOLAMENTO COMPORTAMENTAL entre perfis irmãos da MESMA conta.
//
// Diferente de perfis-crud-multi.test.js (scans de fonte), aqui roda a lógica
// real de atualizarVinculo / removerVinculo / atualizarVinculoUnidade /
// removerVinculoUnidade contra um FAKE do supabase, provando que uma operação
// no PERFIL INICIAL (perfil_id == conta_id) NUNCA toca a linha de um perfil
// irmão — o bug H1, latente pós-migration 063.
//
// Cenários (do pedido de correção):
//   A) atualizar P0 (Empresa X / Admin) não altera P2 (Empresa X / Viewer);
//   B) remover Empresa X de P0 deixa a linha de P2 intacta;
//   C) remover Empresa X de P2 deixa P0 intacto;
//   D) unidades diferentes da mesma empresa — mexer na de P0 não toca a de P2;
//   E) MESMA unidade pós-063 — remover vínculo de P0 mantém o de P2;
//   + sessões revogadas SEMPRE escopadas por perfilId (nunca a conta);
//   + M4: SuperAdmin configura vínculo de perfil INATIVO (sem ativá-lo);
//   + CASO 6/7: perfil de outra conta / inexistente -> 404;
//   + pré-060 (sem a coluna perfil_id) -> degrada para o caminho legado.
//
// Rodar: node --test test/perfis-vinculo-isolamento.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  atualizarVinculo, removerVinculo,
  atualizarVinculoUnidade, removerVinculoUnidade,
} from "../src/modules/plataforma/plataforma.usuarios.service.js";
import { ApiError } from "../src/shared/ApiError.js";

const CONTA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // P0 — perfil inicial: perfil_id == conta_id
const P2 = "22222222-2222-4222-8222-222222222222";    // perfil irmão
const OUTRA_CONTA = "99999999-9999-4999-8999-999999999999";
const ORG_X = "33333333-3333-4333-8333-333333333333";
const UNI_1 = "44444444-4444-4444-8444-444444444444";
const UNI_2 = "55555555-5555-4555-8555-555555555555";

const req = {
  user: { id: "00000000-0000-4000-8000-000000000000", email: "super@x.com" },
  headers: {}, socket: {}, header: () => null,
};

/** Fake mínimo do supabase-js: update/delete/select/eq/in/single/maybeSingle. */
function fakeDb(state, { semPerfilId = false } = {}) {
  function tabelaApi(tabela) {
    const ctx = { op: "select", filtros: [], inFiltro: null, payload: null };
    const rows = () => (state[tabela] ||= []);
    const casa = (r) =>
      ctx.filtros.every(([c, val]) => r[c] === val) &&
      (!ctx.inFiltro || ctx.inFiltro.vals.includes(r[ctx.inFiltro.col]));
    const usaPerfilId = () => ctx.filtros.some(([c]) => c === "perfil_id") || ctx.inFiltro?.col === "perfil_id";

    function resolver(modo) {
      if (semPerfilId && usaPerfilId()) {
        return Promise.resolve({ data: null, error: { message: `column ${tabela}.perfil_id does not exist` } });
      }
      const alvo = rows().filter(casa);
      if (ctx.op === "update") for (const r of alvo) Object.assign(r, ctx.payload);
      else if (ctx.op === "delete") state[tabela] = rows().filter((r) => !casa(r));

      if (modo === "single") {
        return alvo.length === 1
          ? Promise.resolve({ data: { ...alvo[0] }, error: null })
          : Promise.resolve({ data: null, error: { message: `multiple (or no) rows returned: ${alvo.length}` } });
      }
      if (modo === "maybeSingle") {
        return Promise.resolve({ data: alvo[0] ? { ...alvo[0] } : null, error: null });
      }
      return Promise.resolve({ data: alvo.map((r) => ({ ...r })), error: null });
    }

    const builder = {
      select() { return builder; },
      update(p) { ctx.op = "update"; ctx.payload = p; return builder; },
      delete() { ctx.op = "delete"; return builder; },
      eq(c, val) { ctx.filtros.push([c, val]); return builder; },
      in(c, vals) { ctx.inFiltro = { col: c, vals }; return builder; },
      maybeSingle() { return resolver("maybeSingle"); },
      single() { return resolver("single"); },
      then(res, rej) { return resolver("list").then(res, rej); },
    };
    return builder;
  }
  return { from: tabelaApi };
}

const noop = async () => {};

/** Estado padrão: conta com P0 (inicial) e P2 (irmão), AMBOS na Empresa X. */
function estadoBase() {
  return {
    perfis_operacionais: [
      { id: CONTA, conta_id: CONTA, nome: "Operacional Montes Claros", ativo: true },
      { id: P2, conta_id: CONTA, nome: "Jeniffer", ativo: true },
    ],
    usuarios_organizacoes: [
      { id: "uo-p0", usuario_id: CONTA, perfil_id: CONTA, organizacao_id: ORG_X, papel: "organization_admin", ativo: true },
      { id: "uo-p2", usuario_id: CONTA, perfil_id: P2, organizacao_id: ORG_X, papel: "viewer", ativo: true },
    ],
    usuarios_unidades: [],
    unidades: [
      { id: UNI_1, organizacao_id: ORG_X },
      { id: UNI_2, organizacao_id: ORG_X },
    ],
  };
}

describe("H1 — cenário A: atualizar P0 não altera P2 (mesma empresa)", () => {
  test("trocar o cargo de P0 na Empresa X mantém o de P2", async () => {
    const st = estadoBase();
    const revog = [];
    const r = await atualizarVinculo(req, CONTA, ORG_X, { perfilId: CONTA, papel: "finance" },
      { supabase: fakeDb(st), auditar: noop, revogar: async (f) => { revog.push(f); return 0; } });

    assert.equal(r.papel, "finance");
    const p0 = st.usuarios_organizacoes.find((x) => x.perfil_id === CONTA);
    const p2 = st.usuarios_organizacoes.find((x) => x.perfil_id === P2);
    assert.equal(p0.papel, "finance", "P0 deveria ter mudado");
    assert.equal(p2.papel, "viewer", "P2 NÃO pode ter sido tocado");
    assert.equal(p2.ativo, true);
    // sessões: só do perfil P0, nunca da conta
    assert.deepEqual(revog, [{ perfilId: CONTA, organizacaoId: ORG_X, motivo: "papel_alterado" }]);
  });

  test("bloquear (ativo:false) o acesso de P0 não bloqueia P2", async () => {
    const st = estadoBase();
    await atualizarVinculo(req, CONTA, ORG_X, { perfilId: CONTA, ativo: false },
      { supabase: fakeDb(st), auditar: noop, revogar: noop });
    assert.equal(st.usuarios_organizacoes.find((x) => x.perfil_id === CONTA).ativo, false);
    assert.equal(st.usuarios_organizacoes.find((x) => x.perfil_id === P2).ativo, true);
  });
});

describe("H1 — cenário B/C: remover empresa é isolado por perfil", () => {
  test("B) remover Empresa X de P0 -> linha de P2 permanece", async () => {
    const st = estadoBase();
    const revog = [];
    await removerVinculo(req, CONTA, ORG_X, { perfilId: CONTA },
      { supabase: fakeDb(st), auditar: noop, revogar: async (f) => { revog.push(f); return 0; } });

    assert.equal(st.usuarios_organizacoes.length, 1);
    assert.equal(st.usuarios_organizacoes[0].perfil_id, P2);
    assert.deepEqual(revog, [{ perfilId: CONTA, organizacaoId: ORG_X, motivo: "vinculo_removido" }]);
  });

  test("C) remover Empresa X de P2 -> P0 permanece", async () => {
    const st = estadoBase();
    await removerVinculo(req, CONTA, ORG_X, { perfilId: P2 },
      { supabase: fakeDb(st), auditar: noop, revogar: noop });
    assert.equal(st.usuarios_organizacoes.length, 1);
    assert.equal(st.usuarios_organizacoes[0].perfil_id, CONTA);
  });

  test("B) o cleanup de unidades da empresa removida também é escopado por perfil", async () => {
    const st = estadoBase();
    st.usuarios_unidades = [
      { id: "uu-p0", usuario_id: CONTA, perfil_id: CONTA, unidade_id: UNI_1, papel: null, ativo: true },
      { id: "uu-p2", usuario_id: CONTA, perfil_id: P2, unidade_id: UNI_1, papel: null, ativo: true },
    ];
    await removerVinculo(req, CONTA, ORG_X, { perfilId: CONTA },
      { supabase: fakeDb(st), auditar: noop, revogar: noop });
    assert.equal(st.usuarios_unidades.length, 1);
    assert.equal(st.usuarios_unidades[0].perfil_id, P2, "unidade de P2 não pode ser apagada junto");
  });
});

describe("H1 — cenário D/E: unidades isoladas por perfil", () => {
  test("D) atualizar a unidade de P0 (mesma empresa, unidade diferente) não toca P2", async () => {
    const st = estadoBase();
    st.usuarios_unidades = [
      { id: "uu-p0", usuario_id: CONTA, perfil_id: CONTA, unidade_id: UNI_1, papel: null, ativo: true },
      { id: "uu-p2", usuario_id: CONTA, perfil_id: P2, unidade_id: UNI_2, papel: null, ativo: true },
    ];
    const revog = [];
    await atualizarVinculoUnidade(req, CONTA, UNI_1, { perfilId: CONTA, papel: "finance" },
      { supabase: fakeDb(st), auditar: noop, revogar: async (f) => { revog.push(f); return 0; } });

    assert.equal(st.usuarios_unidades.find((x) => x.unidade_id === UNI_1).papel, "finance");
    assert.equal(st.usuarios_unidades.find((x) => x.unidade_id === UNI_2).papel, null);
    assert.deepEqual(revog, [{ perfilId: CONTA, unidadeId: UNI_1, motivo: "papel_alterado" }]);
  });

  test("E) MESMA unidade pós-063 — remover o vínculo de P0 mantém o de P2", async () => {
    const st = estadoBase();
    st.usuarios_unidades = [
      { id: "uu-p0", usuario_id: CONTA, perfil_id: CONTA, unidade_id: UNI_1, papel: null, ativo: true },
      { id: "uu-p2", usuario_id: CONTA, perfil_id: P2, unidade_id: UNI_1, papel: null, ativo: true },
    ];
    await removerVinculoUnidade(req, CONTA, UNI_1, { perfilId: CONTA },
      { supabase: fakeDb(st), auditar: noop, revogar: noop });
    assert.equal(st.usuarios_unidades.length, 1);
    assert.equal(st.usuarios_unidades[0].perfil_id, P2);
  });
});

describe("H1 — o perfil IRMÃO (não-inicial) já era isolado, e continua", () => {
  test("atualizar P2 revoga sessões só de P2", async () => {
    const st = estadoBase();
    const revog = [];
    await atualizarVinculo(req, CONTA, ORG_X, { perfilId: P2, papel: "operations" },
      { supabase: fakeDb(st), auditar: noop, revogar: async (f) => { revog.push(f); return 0; } });
    assert.equal(st.usuarios_organizacoes.find((x) => x.perfil_id === P2).papel, "operations");
    assert.equal(st.usuarios_organizacoes.find((x) => x.perfil_id === CONTA).papel, "organization_admin");
    assert.deepEqual(revog, [{ perfilId: P2, organizacaoId: ORG_X, motivo: "papel_alterado" }]);
  });
});

describe("M4 — configurar vínculo de perfil INATIVO (sem ativá-lo)", () => {
  test("SuperAdmin edita o vínculo de um perfil desativado; o perfil segue inativo", async () => {
    const st = estadoBase();
    st.perfis_operacionais.find((p) => p.id === P2).ativo = false; // Jeniffer desativada
    const r = await atualizarVinculo(req, CONTA, ORG_X, { perfilId: P2, papel: "finance" },
      { supabase: fakeDb(st), auditar: noop, revogar: noop });
    assert.equal(r.papel, "finance");
    assert.equal(st.perfis_operacionais.find((p) => p.id === P2).ativo, false, "configurar vínculo NÃO ativa o perfil");
  });
});

describe("posse do perfil (CASO 6/7)", () => {
  test("6) perfilId de OUTRA conta -> 404", async () => {
    const st = estadoBase();
    st.perfis_operacionais.push({ id: "77777777-7777-4777-8777-777777777777", conta_id: OUTRA_CONTA, nome: "alheio", ativo: true });
    await assert.rejects(
      () => atualizarVinculo(req, CONTA, ORG_X, { perfilId: "77777777-7777-4777-8777-777777777777", papel: "finance" },
        { supabase: fakeDb(st), auditar: noop, revogar: noop }),
      (e) => e instanceof ApiError && e.statusCode === 404,
    );
  });
  test("7) perfilId inexistente -> 404", async () => {
    const st = estadoBase();
    await assert.rejects(
      () => removerVinculo(req, CONTA, ORG_X, { perfilId: "66666666-6666-4666-8666-666666666666" },
        { supabase: fakeDb(st), auditar: noop, revogar: noop }),
      (e) => e instanceof ApiError && e.statusCode === 404,
    );
  });
});

describe("compat pré-060 — sem a coluna perfil_id, degrada para o caminho legado", () => {
  test("atualizarVinculo do perfil inicial funciona sem a coluna", async () => {
    const st = {
      perfis_operacionais: [],
      usuarios_organizacoes: [{ id: "uo-legado", usuario_id: CONTA, organizacao_id: ORG_X, papel: "viewer", ativo: true }],
      usuarios_unidades: [], unidades: [],
    };
    const r = await atualizarVinculo(req, CONTA, ORG_X, { perfilId: CONTA, papel: "finance" },
      { supabase: fakeDb(st, { semPerfilId: true }), auditar: noop, revogar: noop });
    assert.equal(r.papel, "finance");
    assert.equal(st.usuarios_organizacoes[0].papel, "finance");
  });
});
