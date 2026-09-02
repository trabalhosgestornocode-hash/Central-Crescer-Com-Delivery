// L2 / H1 — fluxo TENANT ("Equipe desta empresa"): atualizarUsuario /
// excluirUsuario NUNCA podem tocar o perfil-irmão da mesma conta.
//
// A tela tenant não distingue perfis de uma mesma conta (`:id` é a CONTA,
// `listarUsuarios` mostra 1 linha por `usuario_id`). Portanto:
//   * 1 vínculo (usuario_id, org)  -> opera, escopando pela PK da linha;
//   * 2+ vínculos                  -> RECUSA (VINCULO_AMBIGUO_MULTIPERFIL),
//                                     sem tocar nenhuma linha.
//
// Rodar: node --test test/tenant-usuarios-isolamento.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { atualizarUsuario, excluirUsuario } from "../src/modules/usuarios/usuarios.service.js";
import { ApiError } from "../src/shared/ApiError.js";

const CONTA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "22222222-2222-4222-8222-222222222222"; // perfil-irmão da mesma conta
const OUTRO_ADMIN = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const SOLIC = "11111111-1111-4111-8111-111111111111"; // quem faz a ação (≠ alvo)
const ORG_X = "33333333-3333-4333-8333-333333333333";
const ORG_Y = "3a3a3a3a-3a3a-4a3a-8a3a-3a3a3a3a3a3a";
const UNI_1 = "44444444-4444-4444-8444-444444444444";

/** Fake supabase-js: select/update/delete/eq/in/single/maybeSingle. */
function fakeDb(state, { semPerfilId = false } = {}) {
  function tabelaApi(tabela) {
    const ctx = { op: "select", cols: "*", filtros: [], inFiltro: null, payload: null };
    const rows = () => (state[tabela] ||= []);
    const casa = (r) =>
      ctx.filtros.every(([c, val]) => r[c] === val) &&
      (!ctx.inFiltro || ctx.inFiltro.vals.includes(r[ctx.inFiltro.col]));
    const tocaPerfilId = () =>
      ctx.filtros.some(([c]) => c === "perfil_id") || ctx.inFiltro?.col === "perfil_id" || /perfil_id/.test(ctx.cols || "");

    function resolver(modo) {
      if (semPerfilId && tocaPerfilId()) {
        return Promise.resolve({ data: null, error: { message: `column ${tabela}.perfil_id does not exist` } });
      }
      const alvo = rows().filter(casa);
      if (ctx.op === "update") for (const r of alvo) Object.assign(r, ctx.payload);
      else if (ctx.op === "delete") state[tabela] = rows().filter((r) => !casa(r));

      if (modo === "single") {
        return alvo.length === 1
          ? Promise.resolve({ data: { ...alvo[0] }, error: null })
          : Promise.resolve({ data: null, error: { message: `multiple (or no) rows: ${alvo.length}` } });
      }
      if (modo === "maybeSingle") {
        return Promise.resolve({ data: alvo[0] ? { ...alvo[0] } : null, error: null });
      }
      return Promise.resolve({ data: alvo.map((r) => ({ ...r })), error: null });
    }

    const builder = {
      select(cols = "*") { ctx.cols = cols; return builder; },
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

/** Conta A com N vínculos na Empresa X. `perfis` das linhas: [{perfil_id,papel}]. */
function estado({ vinculosX = [], vinculoY = null, unidades = [] } = {}) {
  const uo = vinculosX.map((v, i) => ({
    id: `uo-x-${i}`, usuario_id: CONTA, perfil_id: v.perfil_id, organizacao_id: ORG_X,
    papel: v.papel ?? "viewer", ativo: v.ativo ?? true,
  }));
  if (vinculoY) uo.push({ id: "uo-y", usuario_id: CONTA, perfil_id: vinculoY.perfil_id, organizacao_id: ORG_Y, papel: vinculoY.papel ?? "viewer", ativo: true });
  // um outro administrador em X, para a guarda "último admin" nunca disparar
  uo.push({ id: "uo-x-admin", usuario_id: OUTRO_ADMIN, perfil_id: OUTRO_ADMIN, organizacao_id: ORG_X, papel: "organization_admin", ativo: true });
  return {
    usuarios_organizacoes: uo,
    usuarios_unidades: unidades,
    unidades: [{ id: UNI_1, organizacao_id: ORG_X }],
  };
}

const chamada = (extra = {}) => ({ organizacaoId: ORG_X, id: CONTA, solicitanteId: SOLIC, solicitantePerfilId: SOLIC, ...extra });

describe("tenant atualizarUsuario — 2 perfis na mesma empresa: RECUSA sem tocar nada", () => {
  test("VINCULO_AMBIGUO_MULTIPERFIL (400) e nenhuma linha alterada", async () => {
    const st = estado({ vinculosX: [
      { perfil_id: CONTA, papel: "organization_admin" },
      { perfil_id: P2, papel: "viewer" },
    ] });
    const revog = [];
    await assert.rejects(
      () => atualizarUsuario(chamada({ papel: "viewer" }), { supabase: fakeDb(st), revogar: async (f) => { revog.push(f); return 0; } }),
      (e) => e instanceof ApiError && e.statusCode === 400 && e.details?.codigo === "VINCULO_AMBIGUO_MULTIPERFIL",
    );
    assert.equal(st.usuarios_organizacoes.find((x) => x.perfil_id === CONTA).papel, "organization_admin");
    assert.equal(st.usuarios_organizacoes.find((x) => x.perfil_id === P2).papel, "viewer");
    assert.equal(revog.length, 0, "não revoga sessão ao recusar");
  });
});

describe("tenant excluirUsuario — 2 perfis na mesma empresa: RECUSA sem apagar nada", () => {
  test("VINCULO_AMBIGUO_MULTIPERFIL (400) e nenhuma linha removida", async () => {
    const st = estado({ vinculosX: [
      { perfil_id: CONTA, papel: "viewer" },
      { perfil_id: P2, papel: "viewer" },
    ] });
    await assert.rejects(
      () => excluirUsuario(chamada(), { supabase: fakeDb(st) }),
      (e) => e instanceof ApiError && e.statusCode === 400 && e.details?.codigo === "VINCULO_AMBIGUO_MULTIPERFIL",
    );
    assert.equal(st.usuarios_organizacoes.filter((x) => x.usuario_id === CONTA && x.organizacao_id === ORG_X).length, 2);
  });
});

describe("tenant atualizarUsuario — 1 perfil: opera pela PK, irmão em OUTRA empresa intacto", () => {
  test("troca o cargo em X; a linha da conta em Y não muda; sessão só do perfil de X", async () => {
    const st = estado({
      vinculosX: [{ perfil_id: CONTA, papel: "operations" }],
      vinculoY: { perfil_id: P2, papel: "organization_admin" },
    });
    const revog = [];
    const r = await atualizarUsuario(chamada({ papel: "viewer" }),
      { supabase: fakeDb(st), revogar: async (f) => { revog.push(f); return 2; } });

    assert.equal(r.papel, "viewer");
    assert.equal(st.usuarios_organizacoes.find((x) => x.organizacao_id === ORG_X && x.usuario_id === CONTA).papel, "viewer");
    assert.equal(st.usuarios_organizacoes.find((x) => x.organizacao_id === ORG_Y).papel, "organization_admin", "vínculo em Y intacto");
    assert.deepEqual(revog, [{ perfilId: CONTA, organizacaoId: ORG_X, motivo: "papel_alterado" }]);
  });
});

describe("tenant excluirUsuario — 1 perfil: apaga só a linha (PK) + unidades só desse perfil", () => {
  test("remove o vínculo de X; a unidade do irmão permanece; sessão só do perfil alvo", async () => {
    const st = estado({
      vinculosX: [{ perfil_id: CONTA, papel: "viewer" }],
      unidades: [
        { id: "uu-p0", usuario_id: CONTA, perfil_id: CONTA, unidade_id: UNI_1, papel: null, ativo: true },
        { id: "uu-p2", usuario_id: CONTA, perfil_id: P2, unidade_id: UNI_1, papel: null, ativo: true },
      ],
    });
    const revog = [];
    await excluirUsuario(chamada(), { supabase: fakeDb(st), revogar: async (f) => { revog.push(f); return 1; } });

    assert.equal(st.usuarios_organizacoes.filter((x) => x.usuario_id === CONTA && x.organizacao_id === ORG_X).length, 0);
    assert.equal(st.usuarios_unidades.length, 1);
    assert.equal(st.usuarios_unidades[0].perfil_id, P2, "unidade do irmão não pode ser apagada");
    assert.deepEqual(revog, [{ perfilId: CONTA, organizacaoId: ORG_X, motivo: "acesso_removido" }]);
  });
});

describe("tenant — casos de borda", () => {
  test("0 vínculos na empresa -> 404", async () => {
    const st = estado({ vinculosX: [] });
    await assert.rejects(
      () => atualizarUsuario(chamada({ papel: "viewer" }), { supabase: fakeDb(st) }),
      (e) => e instanceof ApiError && e.statusCode === 404,
    );
  });

  test("pré-060 (sem coluna perfil_id) -> atualizarUsuario opera pela PK", async () => {
    const st = {
      usuarios_organizacoes: [
        { id: "uo-legado", usuario_id: CONTA, organizacao_id: ORG_X, papel: "viewer", ativo: true },
        { id: "uo-adm", usuario_id: OUTRO_ADMIN, organizacao_id: ORG_X, papel: "organization_admin", ativo: true },
      ],
      usuarios_unidades: [], unidades: [{ id: UNI_1, organizacao_id: ORG_X }],
    };
    const r = await atualizarUsuario(chamada({ papel: "operations" }),
      { supabase: fakeDb(st, { semPerfilId: true }), revogar: async () => 0 });
    assert.equal(r.papel, "operations");
    assert.equal(st.usuarios_organizacoes.find((x) => x.id === "uo-legado").papel, "operations");
  });

  test("pré-060 -> excluirUsuario remove pela PK e limpa unidades pelo caminho legado", async () => {
    const st = {
      usuarios_organizacoes: [
        { id: "uo-legado", usuario_id: CONTA, organizacao_id: ORG_X, papel: "viewer", ativo: true },
        { id: "uo-adm", usuario_id: OUTRO_ADMIN, organizacao_id: ORG_X, papel: "organization_admin", ativo: true },
      ],
      usuarios_unidades: [{ id: "uu-legado", usuario_id: CONTA, unidade_id: UNI_1, papel: null, ativo: true }],
      unidades: [{ id: UNI_1, organizacao_id: ORG_X }],
    };
    const revog = [];
    await excluirUsuario(chamada(), { supabase: fakeDb(st, { semPerfilId: true }), revogar: async (f) => { revog.push(f); return 0; } });
    assert.equal(st.usuarios_organizacoes.find((x) => x.id === "uo-legado"), undefined);
    assert.equal(st.usuarios_unidades.length, 0);
    assert.deepEqual(revog, [{ perfilId: CONTA, organizacaoId: ORG_X, motivo: "acesso_removido" }]);
  });

  test("self-edit continua barrado (guarda de auto-rebaixamento)", async () => {
    await assert.rejects(
      () => atualizarUsuario({ organizacaoId: ORG_X, id: CONTA, papel: "viewer", solicitanteId: CONTA, solicitantePerfilId: CONTA },
        { supabase: fakeDb(estado({ vinculosX: [{ perfil_id: CONTA }] })) }),
      (e) => e instanceof ApiError && e.statusCode === 400,
    );
  });
});

