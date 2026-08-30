// FASE E — validação multiempresa (backend).
//
// Simula DUAS empresas com DUAS unidades cada, num banco em memória, e passa
// as MESMAS funções de service que as rotas usam. Prova, sem rede:
//   * Dados da Unidade nunca cruzam empresa nem unidade;
//   * editar uma unidade não toca as outras (nem histórico);
//   * Metas de CMV são por unidade (25/30 na A1, default na A2, 40/45 na B1);
//   * catálogo de tabelas é por empresa ("AERO A" é da B, não global);
//   * associação em massa nunca sobrescreve cargo existente e cargo é por
//     empresa (mesmo usuário, cargos diferentes);
//   * "Usuários e Permissões" lista vínculo de empresa E de unidade, isolado.
//
// Rodar: node --test test/fase-e-multiempresa.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  obterDados, atualizarDados, obterMetasCmv, salvarMetasCmv, obterTabelasComerciais,
} from "../src/modules/unidade/unidade.service.js";
import { catalogoTabelasComerciais } from "../src/shared/tabelaComercial.js";
import { associarEmpresasLote } from "../src/modules/plataforma/plataforma.usuarios.service.js";
import { listarUsuarios } from "../src/modules/usuarios/usuarios.service.js";

// ---------------------------------------------------------------------------
// Identificadores
const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const A1 = "aaaaaaaa-0000-4000-8000-0000000000a1";
const A2 = "aaaaaaaa-0000-4000-8000-0000000000a2";
const B1 = "bbbbbbbb-0000-4000-8000-0000000000b1";
const B2 = "bbbbbbbb-0000-4000-8000-0000000000b2";
const U_A = "10000000-0000-4000-8000-00000000000a"; // vínculo de empresa A
const U_B = "20000000-0000-4000-8000-00000000000b"; // vínculo de empresa B
const U_Z = "30000000-0000-4000-8000-00000000000z".replace("z", "c"); // só unidade A1
const SUPER = "99999999-0000-4000-8000-000000000099";

// ---------------------------------------------------------------------------
// Fake Supabase — cobre select/eq/in/not/order/maybeSingle/single/update/upsert/insert
// e "await direto" (thenable) para as queries que não terminam em maybeSingle.
function criarDb(estado) {
  const chamadas = [];
  return {
    _estado: estado,
    chamadas,
    from(tabela) {
      const ctx = { tabela, op: "select", eq: {}, ins: [], notNull: [], patch: null, row: null };
      const run = (single) => {
        chamadas.push({ tabela, op: ctx.op, eq: { ...ctx.eq } });
        const linhas = estado[tabela] ?? (estado[tabela] = []);
        const filtra = (l) =>
          Object.entries(ctx.eq).every(([k, v]) => l[k] === v)
          && ctx.ins.every(({ col, vals }) => vals.includes(l[col]))
          && ctx.notNull.every((c) => l[c] != null);

        if (ctx.op === "update") {
          const alvo = linhas.find(filtra);
          if (!alvo) return Promise.resolve({ data: null, error: null });
          Object.assign(alvo, ctx.patch);
          return Promise.resolve({ data: { ...alvo }, error: null });
        }
        if (ctx.op === "upsert") {
          const chave = "unidade_id";
          let alvo = linhas.find((l) => l[chave] === ctx.row[chave]);
          if (!alvo) { alvo = {}; linhas.push(alvo); }
          Object.assign(alvo, ctx.row);
          return Promise.resolve({ data: { ...alvo }, error: null });
        }
        if (ctx.op === "insert") {
          const arr = Array.isArray(ctx.row) ? ctx.row : [ctx.row];
          for (const r of arr) {
            const dup = linhas.some((l) => l.usuario_id === r.usuario_id && l.organizacao_id === r.organizacao_id);
            if (dup) return Promise.resolve({ error: { message: "duplicate key value violates unique constraint" } });
          }
          linhas.push(...arr.map((r) => ({ ...r })));
          return Promise.resolve({ error: null });
        }
        const achados = linhas.filter(filtra).map((l) => ({ ...l }));
        return Promise.resolve({ data: single ? (achados[0] ?? null) : achados, error: null });
      };
      const builder = {
        select() { return builder; },
        update(p) { ctx.op = "update"; ctx.patch = p; return builder; },
        upsert(r) { ctx.op = "upsert"; ctx.row = r; return builder; },
        insert(r) { ctx.op = "insert"; ctx.row = r; return run(false); },
        eq(c, v) { ctx.eq[c] = v; return builder; },
        in(c, vals) { ctx.ins.push({ col: c, vals }); return builder; },
        not(c) { ctx.notNull.push(c); return builder; },
        order() { return run(false); },
        maybeSingle() { return run(true); },
        single() { return run(true); },
        then(res, rej) { return run(false).then(res, rej); },
      };
      return builder;
    },
  };
}

const noopAuditar = async () => {};
const tokenTenant = (organizacaoId, unidadeId) => ({
  tenant: { organizacaoId, unidadeId },
  user: { id: "someuser", email: "x@y.z" },
});
const reqSuper = { user: { id: SUPER, email: "super@x.com" }, headers: {}, socket: {}, header: () => null };

function estadoBase() {
  return {
    organizacoes: [
      { id: ORG_A, nome: "Empresa A" },
      { id: ORG_B, nome: "Empresa B" },
    ],
    unidades: [
      { id: A1, organizacao_id: ORG_A, nome: "A — Matriz", cnpj: "11111111111111", endereco: "Rua A1", telefone: null, responsavel: "Alice", email: "a1@a.com", cidade: "MOC", estado: "MG", ativo: true, tabela_balcao: "E", tabela_ifood: null },
      { id: A2, organizacao_id: ORG_A, nome: "A — Filial", cnpj: "22222222222222", endereco: "Rua A2", telefone: null, responsavel: "Aline", email: "a2@a.com", cidade: "MOC", estado: "MG", ativo: true, tabela_balcao: "F", tabela_ifood: null },
      { id: B1, organizacao_id: ORG_B, nome: "B — Matriz", cnpj: "33333333333333", endereco: "Rua B1", telefone: null, responsavel: "Bruno", email: "b1@b.com", cidade: "SP", estado: "SP", ativo: true, tabela_balcao: "AERO A", tabela_ifood: null },
      { id: B2, organizacao_id: ORG_B, nome: "B — Filial", cnpj: "44444444444444", endereco: "Rua B2", telefone: null, responsavel: "Bia", email: "b2@b.com", cidade: "SP", estado: "SP", ativo: true, tabela_balcao: "AERO A", tabela_ifood: null },
    ],
    unidade_config: [
      { unidade_id: A1, cmv_saudavel: 25, cmv_atencao: 30, meta_fat_dia: 1000, meta_fat_mes: null, margem_minima: null },
      { unidade_id: B1, cmv_saudavel: 40, cmv_atencao: 45, meta_fat_dia: null, meta_fat_mes: null, margem_minima: null },
      // A2 e B2: sem linha → defaults do sistema (32/40)
    ],
    vw_produto_margem: [
      { organizacao_id: ORG_A, canal: "balcao", tabela: "E" },
      { organizacao_id: ORG_A, canal: "balcao", tabela: "F" },
      { organizacao_id: ORG_A, canal: "ifood", tabela: "Z1" },
      { organizacao_id: ORG_B, canal: "balcao", tabela: "AERO A" }, // taxonomia da B — não é global
    ],
    perfis: [
      { id: U_A, nome: "Usuário A", email: "ua@x.com", ativo: true },
      { id: U_B, nome: "Usuário B", email: "ub@x.com", ativo: true },
      { id: U_Z, nome: "Usuário Z", email: "uz@x.com", ativo: true },
    ],
    usuarios_organizacoes: [
      { usuario_id: U_A, organizacao_id: ORG_A, papel: "operations", ativo: true, created_at: "2026-01-01" },
      { usuario_id: U_B, organizacao_id: ORG_B, papel: "finance", ativo: true, created_at: "2026-01-02" },
    ],
    usuarios_unidades: [
      { usuario_id: U_Z, unidade_id: A1, papel: "unit_manager", ativo: true, created_at: "2026-02-01" },
    ],
  };
}

let estado, db;
beforeEach(() => { estado = estadoBase(); db = criarDb(estado); });

// ===========================================================================
describe("FASE E — Dados da Unidade: isolamento empresa e unidade", () => {
  test("A1 e B1 nunca cruzam", async () => {
    const a = await obterDados({ unidadeId: A1 }, { supabase: db });
    const b = await obterDados({ unidadeId: B1 }, { supabase: db });
    assert.equal(a.nome, "A — Matriz");
    assert.equal(a.responsavel, "Alice");
    assert.equal(b.nome, "B — Matriz");
    assert.equal(b.responsavel, "Bruno");
    assert.notEqual(a.cnpj, b.cnpj);
  });

  test("editar A1 não toca A2, B1 nem B2", async () => {
    const antes = JSON.stringify(estado.unidades.filter((u) => u.id !== A1));
    await atualizarDados(tokenTenant(ORG_A, A1),
      { nome: "A — Matriz (nova)", responsavel: "Alice 2", email: "novo@a.com" },
      { supabase: db, auditarReq: noopAuditar });
    const depois = JSON.stringify(estado.unidades.filter((u) => u.id !== A1));
    assert.equal(antes, depois, "outras unidades intactas");
    assert.equal(estado.unidades.find((u) => u.id === A1).nome, "A — Matriz (nova)");
  });

  test("corpo com unidadeId de outra unidade é ignorado — edita a do token", async () => {
    await atualizarDados(tokenTenant(ORG_A, A1),
      { nome: "hack", unidadeId: B1, organizacaoId: ORG_B },
      { supabase: db, auditarReq: noopAuditar });
    assert.equal(estado.unidades.find((u) => u.id === B1).nome, "B — Matriz", "B1 intacta");
    assert.equal(estado.unidades.find((u) => u.id === A1).nome, "hack", "editou A1 (token)");
  });

  test("status é read-only no tenant (ativo do corpo ignorado)", async () => {
    const r = await atualizarDados(tokenTenant(ORG_A, A1),
      { nome: "x", ativo: false, status: "inativa" },
      { supabase: db, auditarReq: noopAuditar });
    assert.equal(r.status, "ativa");
    assert.equal(r.statusEditavel, false);
    assert.equal(estado.unidades.find((u) => u.id === A1).ativo, true);
  });

  test("troca de contexto: cada chamada resolve pelo id do token (sem cache)", async () => {
    const r1 = await obterDados({ unidadeId: A1 }, { supabase: db });
    const r2 = await obterDados({ unidadeId: A2 }, { supabase: db });
    assert.equal(r1.nome, "A — Matriz");
    assert.equal(r2.nome, "A — Filial");
  });
});

// ===========================================================================
describe("FASE E — Metas de CMV por unidade", () => {
  test("A1=25/30 (persistido), A2=32/40 (default), B1=40/45", async () => {
    const a1 = await obterMetasCmv({ unidadeId: A1 }, { supabase: db });
    const a2 = await obterMetasCmv({ unidadeId: A2 }, { supabase: db });
    const b1 = await obterMetasCmv({ unidadeId: B1 }, { supabase: db });
    assert.deepEqual([a1.cmvSaudavel, a1.cmvAtencao, a1.persistido], [25, 30, true]);
    assert.deepEqual([a2.cmvSaudavel, a2.cmvAtencao, a2.persistido], [32, 40, false]);
    assert.deepEqual([b1.cmvSaudavel, b1.cmvAtencao, b1.persistido], [40, 45, true]);
  });

  test("mesmo CMV%, status diferente conforme a unidade (classificação idêntica ao statusCmv)", async () => {
    const classify = (pct, { cmvSaudavel, cmvAtencao }) =>
      pct <= cmvSaudavel ? "saudavel" : pct <= cmvAtencao ? "atencao" : "critico";
    const a1 = await obterMetasCmv({ unidadeId: A1 }, { supabase: db }); // 25/30
    const a2 = await obterMetasCmv({ unidadeId: A2 }, { supabase: db }); // 32/40
    const b1 = await obterMetasCmv({ unidadeId: B1 }, { supabase: db }); // 40/45
    assert.equal(classify(33, a1), "critico", "33% é crítico na A1 (>30)");
    assert.equal(classify(33, a2), "atencao", "33% é atenção na A2 (<40)");
    assert.equal(classify(33, b1), "saudavel", "33% é saudável na B1 (<40)");
  });

  test("salvar metas de A1 não altera A2 nem B1", async () => {
    await salvarMetasCmv(tokenTenant(ORG_A, A1), { cmvSaudavel: 20, cmvAtencao: 24 },
      { supabase: db, auditarReq: noopAuditar });
    const b1 = estado.unidade_config.find((c) => c.unidade_id === B1);
    assert.deepEqual([b1.cmv_saudavel, b1.cmv_atencao], [40, 45], "B1 intacta");
    assert.ok(!estado.unidade_config.some((c) => c.unidade_id === A2), "A2 continua sem linha");
    const a1 = estado.unidade_config.find((c) => c.unidade_id === A1);
    assert.deepEqual([a1.cmv_saudavel, a1.cmv_atencao], [20, 24]);
  });

  test("salvar metas de A2 (que não tinha linha) cria a linha só dela", async () => {
    await salvarMetasCmv(tokenTenant(ORG_A, A2), { cmvSaudavel: 31, cmvAtencao: 37 },
      { supabase: db, auditarReq: noopAuditar });
    assert.ok(estado.unidade_config.some((c) => c.unidade_id === A2));
    assert.equal(estado.unidade_config.filter((c) => c.unidade_id === A2).length, 1);
  });
});

// ===========================================================================
describe("FASE E — Catálogo de tabelas por empresa", () => {
  test('"AERO A" é da Empresa B — nunca aparece para a Empresa A', async () => {
    const a = await catalogoTabelasComerciais({ organizacaoId: ORG_A }, { supabaseClient: db });
    const b = await catalogoTabelasComerciais({ organizacaoId: ORG_B }, { supabaseClient: db });
    assert.deepEqual(a.balcao, ["E", "F"]);
    assert.deepEqual(a.ifood, ["Z1"]);
    assert.deepEqual(b.balcao, ["AERO A"]);
    assert.ok(!a.balcao.includes("AERO A"), "A não vê AERO A");
    assert.ok(!b.balcao.includes("E") && !b.balcao.includes("F"), "B não vê E/F");
  });

  test("obterTabelasComerciais: valor atual da unidade + catálogo da empresa", async () => {
    const a1 = await obterTabelasComerciais({ unidadeId: A1, organizacaoId: ORG_A }, { supabase: db });
    assert.equal(a1.tabelaBalcao, "E");
    assert.deepEqual(a1.catalogo.balcao, ["E", "F"]);
    const b1 = await obterTabelasComerciais({ unidadeId: B1, organizacaoId: ORG_B }, { supabase: db });
    assert.equal(b1.tabelaBalcao, "AERO A");
    assert.deepEqual(b1.catalogo.balcao, ["AERO A"]);
  });
});

// ===========================================================================
describe("FASE E — Associação em massa: cargo é por empresa, nunca sobrescreve", () => {
  test("associar U_A à Empresa B (novo) — mantém operations em A, ganha finance em B", async () => {
    await associarEmpresasLote(reqSuper, U_A, { itens: [{ organizacaoId: ORG_B, papel: "finance" }] },
      { supabase: db, auditar: noopAuditar });
    const emA = estado.usuarios_organizacoes.find((v) => v.usuario_id === U_A && v.organizacao_id === ORG_A);
    const emB = estado.usuarios_organizacoes.find((v) => v.usuario_id === U_A && v.organizacao_id === ORG_B);
    assert.equal(emA.papel, "operations", "cargo em A não mudou");
    assert.equal(emB.papel, "finance", "cargo em B é o novo (diferente de A)");
  });

  test("lote com empresa já associada → 409 e NADA gravado", async () => {
    await assert.rejects(
      () => associarEmpresasLote(reqSuper, U_A, {
        itens: [{ organizacaoId: ORG_B, papel: "viewer" }, { organizacaoId: ORG_A, papel: "viewer" }],
      }, { supabase: db, auditar: noopAuditar }),
      (e) => { assert.equal(e.statusCode, 409); return true; },
    );
    const emA = estado.usuarios_organizacoes.find((v) => v.usuario_id === U_A && v.organizacao_id === ORG_A);
    assert.equal(emA.papel, "operations", "cargo em A intacto");
    assert.ok(!estado.usuarios_organizacoes.some((v) => v.usuario_id === U_A && v.organizacao_id === ORG_B),
      "vínculo com B não foi criado (operação inteira recusada)");
  });
});

// ===========================================================================
describe("FASE E — Usuários e Permissões: isolamento + merge empresa/unidade", () => {
  test("listar A: usuário de empresa + usuário só de unidade; nunca o de B", async () => {
    const lista = await listarUsuarios({ organizacaoId: ORG_A }, { supabase: db });
    const ids = lista.map((u) => u.id);
    assert.ok(ids.includes(U_A), "vínculo de empresa aparece");
    assert.ok(ids.includes(U_Z), "vínculo só de unidade aparece");
    assert.ok(!ids.includes(U_B), "usuário da Empresa B não vaza");

    const z = lista.find((u) => u.id === U_Z);
    assert.equal(z.origem, "unidade");
    assert.equal(z.papel, null);
    assert.equal(z.gerenciavelAqui, false);
    assert.equal(z.unidades[0].unidadeNome, "A — Matriz");
    assert.equal(z.unidades[0].papel, "unit_manager");
  });

  test("listar B: só o usuário de B", async () => {
    const lista = await listarUsuarios({ organizacaoId: ORG_B }, { supabase: db });
    assert.deepEqual(lista.map((u) => u.id), [U_B]);
    assert.equal(lista[0].papel, "finance");
    assert.equal(lista[0].origem, "empresa");
  });

  test("usuário com vínculo em A e B aparece uma vez em cada, com o cargo daquela empresa", async () => {
    estado.usuarios_organizacoes.push({ usuario_id: U_A, organizacao_id: ORG_B, papel: "viewer", ativo: true, created_at: "2026-03-01" });
    const listaA = await listarUsuarios({ organizacaoId: ORG_A }, { supabase: db });
    const listaB = await listarUsuarios({ organizacaoId: ORG_B }, { supabase: db });
    assert.equal(listaA.filter((u) => u.id === U_A).length, 1);
    assert.equal(listaB.filter((u) => u.id === U_A).length, 1);
    assert.equal(listaA.find((u) => u.id === U_A).papel, "operations");
    assert.equal(listaB.find((u) => u.id === U_A).papel, "viewer");
  });
});
