// Testes de "Dados da Unidade" e "Metas e Limites de CMV" pelo tenant
// (unidade.service.js). Unit test SEM rede: injeta um fake do supabase.
//
// Cobre:
//   * obterDados / atualizarDados sempre pela unidade do Context Token
//     (req.tenant.unidadeId) — nunca por id vindo do corpo;
//   * status é read-only no tenant (statusEditavel: false, ativo ignorado);
//   * obterMetasCmv devolve defaults do sistema quando não há unidade_config;
//   * salvarMetasCmv faz upsert por unidade_id e valida faixas coerentes;
//   * uma unidade nunca escreve na config de outra.
//
// Rodar: node --test test/unidade-dados.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  obterDados, atualizarDados, obterMetasCmv, salvarMetasCmv, DEFAULTS_METAS_CMV,
} from "../src/modules/unidade/unidade.service.js";

const UNIDADE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UNIDADE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// --- fake mínimo do cliente supabase -----------------------------------
// Cada `.from(tabela)` devolve um builder que registra a operação e resolve
// com o que o teste configurou em `tabelas[tabela]`.
function fakeSupabase(estado) {
  const chamadas = [];
  return {
    chamadas,
    from(tabela) {
      const ctx = { tabela, op: "select", filtros: {}, patch: null, upsertRow: null };
      const builder = {
        select() { return builder; },
        update(p) { ctx.op = "update"; ctx.patch = p; return builder; },
        upsert(row, opts) { ctx.op = "upsert"; ctx.upsertRow = row; ctx.upsertOpts = opts; return builder; },
        eq(col, val) { ctx.filtros[col] = val; return builder; },
        maybeSingle() { return resolver(); },
        single() { return resolver(); },
      };
      function resolver() {
        chamadas.push({ ...ctx, filtros: { ...ctx.filtros } });
        const linhas = estado[tabela] ?? [];
        if (ctx.op === "select") {
          const achado = linhas.find((l) => Object.entries(ctx.filtros).every(([k, v]) => l[k] === v)) ?? null;
          return Promise.resolve({ data: achado, error: null });
        }
        if (ctx.op === "update") {
          const alvo = linhas.find((l) => Object.entries(ctx.filtros).every(([k, v]) => l[k] === v));
          if (!alvo) return Promise.resolve({ data: null, error: null });
          Object.assign(alvo, ctx.patch);
          return Promise.resolve({ data: { ...alvo }, error: null });
        }
        if (ctx.op === "upsert") {
          const key = ctx.upsertRow.unidade_id;
          let alvo = linhas.find((l) => l.unidade_id === key);
          if (!alvo) { alvo = {}; linhas.push(alvo); estado[tabela] = linhas; }
          Object.assign(alvo, ctx.upsertRow);
          return Promise.resolve({ data: { ...alvo }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }
      return builder;
    },
  };
}

const noopAuditar = async () => {};
const reqComTenant = (unidadeId) => ({ tenant: { unidadeId }, user: { id: "u-1", email: "a@b.c" } });

describe("Dados da Unidade (tenant)", () => {
  test("obterDados lê a unidade do Context Token e status vem read-only", async () => {
    const db = fakeSupabase({
      unidades: [
        { id: UNIDADE_A, nome: "Loja A", cnpj: null, endereco: "Rua 1", telefone: null,
          responsavel: "Ana", email: "loja.a@x.com", cidade: "MOC", estado: "MG", ativo: true },
      ],
    });
    const r = await obterDados({ unidadeId: UNIDADE_A }, { supabase: db });
    assert.equal(r.nome, "Loja A");
    assert.equal(r.responsavel, "Ana");
    assert.equal(r.email, "loja.a@x.com");
    assert.equal(r.status, "ativa");
    assert.equal(r.statusEditavel, false);
    assert.equal(db.chamadas[0].filtros.id, UNIDADE_A);
  });

  test("obterDados sem unidade no contexto → 400", async () => {
    await assert.rejects(() => obterDados({ unidadeId: null }, { supabase: fakeSupabase({}) }),
      /Selecione uma unidade/);
  });

  test("atualizarDados grava só na unidade do token e ignora status/ativo do corpo", async () => {
    const estado = {
      unidades: [
        { id: UNIDADE_A, nome: "A", ativo: true, responsavel: null, email: null },
        { id: UNIDADE_B, nome: "B", ativo: true, responsavel: "NÃO MEXER", email: "b@b.b" },
      ],
    };
    const db = fakeSupabase(estado);
    const r = await atualizarDados(
      reqComTenant(UNIDADE_A),
      { nome: "A2", responsavel: "Bia", email: "a@a.co", ativo: false, status: "inativa", unidadeId: UNIDADE_B },
      { supabase: db, auditarReq: noopAuditar },
    );
    assert.equal(r.nome, "A2");
    assert.equal(r.responsavel, "Bia");
    assert.equal(r.status, "ativa", "ativo:false do corpo foi ignorado");
    // Unidade B intacta
    assert.equal(estado.unidades[1].responsavel, "NÃO MEXER");
    assert.equal(estado.unidades[1].nome, "B");
    // O update foi filtrado por id = UNIDADE_A (token), não UNIDADE_B (corpo)
    const upd = db.chamadas.find((c) => c.op === "update");
    assert.equal(upd.filtros.id, UNIDADE_A);
    assert.ok(!("ativo" in upd.patch));
  });

  test("atualizarDados sem nenhum campo → 400", async () => {
    await assert.rejects(() => atualizarDados(reqComTenant(UNIDADE_A), {}, { supabase: fakeSupabase({ unidades: [] }) }),
      /Nada para atualizar/);
  });

  test("atualizarDados com e-mail inválido → 400", async () => {
    await assert.rejects(
      () => atualizarDados(reqComTenant(UNIDADE_A), { email: "não-é-email" }, { supabase: fakeSupabase({ unidades: [{ id: UNIDADE_A, ativo: true }] }) }),
      /E-mail da loja inválido/,
    );
  });
});

describe("Metas e Limites de CMV (tenant)", () => {
  test("obterMetasCmv sem linha → defaults do sistema", async () => {
    const r = await obterMetasCmv({ unidadeId: UNIDADE_A }, { supabase: fakeSupabase({ unidade_config: [] }) });
    assert.equal(r.cmvSaudavel, DEFAULTS_METAS_CMV.cmvSaudavel);
    assert.equal(r.cmvAtencao, DEFAULTS_METAS_CMV.cmvAtencao);
    assert.equal(r.metaFatDia, null);
    assert.equal(r.persistido, false);
  });

  test("obterMetasCmv com linha → valores persistidos daquela unidade", async () => {
    const db = fakeSupabase({
      unidade_config: [
        { unidade_id: UNIDADE_A, cmv_saudavel: 28, cmv_atencao: 35, meta_fat_dia: 1500, meta_fat_mes: 45000, margem_minima: 20 },
        { unidade_id: UNIDADE_B, cmv_saudavel: 99, cmv_atencao: 99 },
      ],
    });
    const r = await obterMetasCmv({ unidadeId: UNIDADE_A }, { supabase: db });
    assert.equal(r.cmvSaudavel, 28);
    assert.equal(r.cmvAtencao, 35);
    assert.equal(r.metaFatDia, 1500);
    assert.equal(r.persistido, true);
  });

  test("salvarMetasCmv cria a linha da unidade do token (upsert por unidade_id)", async () => {
    const estado = { unidade_config: [] };
    const db = fakeSupabase(estado);
    const r = await salvarMetasCmv(
      reqComTenant(UNIDADE_A),
      { cmvSaudavel: 30, cmvAtencao: 38, metaFatDia: 2000 },
      { supabase: db, auditarReq: noopAuditar },
    );
    assert.equal(r.cmvSaudavel, 30);
    assert.equal(r.cmvAtencao, 38);
    assert.equal(r.metaFatDia, 2000);
    assert.equal(estado.unidade_config.length, 1);
    assert.equal(estado.unidade_config[0].unidade_id, UNIDADE_A);
  });

  test("salvarMetasCmv rejeita saudável > atenção", async () => {
    await assert.rejects(
      () => salvarMetasCmv(reqComTenant(UNIDADE_A), { cmvSaudavel: 50, cmvAtencao: 40 }, { supabase: fakeSupabase({ unidade_config: [] }) }),
      /saudável não pode ser maior/,
    );
  });

  test("salvarMetasCmv de uma unidade não toca a config de outra", async () => {
    const estado = {
      unidade_config: [{ unidade_id: UNIDADE_B, cmv_saudavel: 10, cmv_atencao: 20 }],
    };
    const db = fakeSupabase(estado);
    await salvarMetasCmv(reqComTenant(UNIDADE_A), { cmvSaudavel: 33 }, { supabase: db, auditarReq: noopAuditar });
    const b = estado.unidade_config.find((l) => l.unidade_id === UNIDADE_B);
    assert.equal(b.cmv_saudavel, 10, "config da unidade B intacta");
    const upsert = db.chamadas.find((c) => c.op === "upsert");
    assert.equal(upsert.upsertRow.unidade_id, UNIDADE_A);
  });
});
