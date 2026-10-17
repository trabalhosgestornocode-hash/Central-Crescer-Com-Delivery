// Checklist Operacional — isolamento e migration contra o SUPABASE DE TESTE (projeto dedicado e descartável, NUNCA produção).
//
// PULA sozinho a menos que o Supabase configurado seja comprovadamente descartável (helpers/preflight-integracao.js:
// SUPABASE_URL === TEST_SUPABASE_URL ou INTEGRACAO_SUPABASE_DESCARTAVEL=1). A parte da migration exige ainda o banco de teste direto
// (DATABASE_TESTE_URL do MESMO projeto, guardas de helpers/psql-teste.js) e `psql`.
//
// Rodar (a partir do worktree; as credenciais ficam no .env.test-integracao da pasta principal, nunca copiadas):
//   DATABASE_TESTE_URL=<url do banco de teste> node --experimental-vm-modules --env-file=<...>/backend/.env.test-integracao \
//     --test test/checklist-operacional-supabase-teste.test.js
//
// Cria SÓ dados fictícios marcados com __CHECKLIST_ISO__<tag> e remove tudo no fim (pedidos, unidades, empresas). A migration do módulo é
// aplicada e DESFEITA no projeto de teste (o catálogo volta ao estado em que estava).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { motivoIndisponivel } from "./helpers/psql-teste.js";
import { assertBancoDeTeste } from "./helpers/db-teste.js";

const PULAR = motivoPularIntegracao();
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const MIG = path.join(AQUI, "..", "..", "database", "migrations");
const TAG = `__CHECKLIST_ISO__${Date.now()}`;
const AGORA = new Date("2026-10-09T15:00:00.000Z");
const min = (m) => new Date(AGORA.getTime() - m * 60_000).toISOString();

describe("Checklist Operacional — Supabase de TESTE (PostgREST e RLS reais)", { skip: PULAR }, () => {
  let admin; let anon; let repoChecklist; let service;
  const criados = { orgs: [] };
  let A; let B; let A1; let A2; let B1;

  before(async () => {
    const { supabase } = await import("../src/config/supabase.js");
    admin = supabase;
    anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    repoChecklist = await import("../src/modules/checklist-operacional/checklistOperacional.repository.js");
    service = await import("../src/modules/checklist-operacional/checklistOperacional.service.js");

    const org = async (nome) => {
      const { data, error } = await admin.from("organizacoes").insert({ nome: `${TAG} ${nome}`, status: "teste" }).select("id").single();
      assert.ifError(error); criados.orgs.push(data.id); return data.id;
    };
    const unidade = async (organizacao_id, nome) => {
      const { data, error } = await admin.from("unidades").insert({ organizacao_id, nome: `${TAG} ${nome}`, ativo: true }).select("id").single();
      assert.ifError(error); return data.id;
    };
    A = await org("A (com iFood)"); B = await org("B (outra empresa)");
    A1 = await unidade(A, "A1 integrada"); A2 = await unidade(A, "A2 sem integração"); B1 = await unidade(B, "B1");

    const pedido = (org, un, id, display, over = {}) => ({
      organizacao_id: org, unidade_id: un, order_id: `${TAG}-${id}`, merchant_id: `m-${TAG}-${un.slice(0, 4)}`, display_id: display,
      status_oficial: "CONCLUDED", status_oficial_em: min(20), order_type: "DELIVERY", delivery_by: "IFOOD", order_timing: "IMMEDIATE", is_test: false,
      order_created_at: min(60), placed_event_created_at: min(60), confirmed_event_at: min(59), ready_event_at: min(49), dispatch_event_at: min(45),
      primeiro_evento_em: min(60), ...over,
    });
    const { error } = await admin.from("ifood_pedidos").insert([
      pedido(A, A1, "a1", "A101"), pedido(A, A1, "a2", "A102"),
      pedido(A, A1, "a3", "A103", { order_type: "TAKEOUT", dispatch_event_at: null, delivery_by: null }),
      pedido(B, B1, "b1", "B101"), pedido(B, B1, "b2", "B102"), pedido(B, B1, "b3", "B103"),
    ]);
    assert.ifError(error);
  });

  after(async () => {
    for (const id of criados.orgs) {
      try { await admin.from("ifood_pedidos").delete().eq("organizacao_id", id); } catch { /* ignora */ }
      try { await admin.from("organizacoes").delete().eq("id", id); } catch { /* ignora */ }
    }
  });

  const ifoodIntegrado = { obterConexaoViva: async () => ({ id: "c1", status: "ativa", merchant_id: "m" }), listarCredenciaisDaConexao: async () => [{ app_type: "order", status: "ativa" }],
    obterObservabilidadeOrder: async () => ({ disponivel: true, ultimoEvento: min(1), eventosComFalha: 0, lease: { leaseAte: min(-60), atualizadoEm: min(0.2) } }) };
  const ifoodSem = { obterConexaoViva: async () => null, listarCredenciaisDaConexao: async () => [], obterObservabilidadeOrder: async () => null };
  const resumo = (org, un, ifood) => service.obterResumo({ organizacaoId: org, unidadeId: un, agora: () => AGORA, deps: { repo: repoChecklist, ifoodRepo: ifood, pilotoOrder: () => false, env: {} } });

  test("unidade integrada: só os próprios pedidos; tempos novos fecham; retirada sem tempos", async () => {
    const r = await resumo(A, A1, ifoodIntegrado);
    assert.equal(r.modo, "integrado");
    assert.deepEqual(r.ultimosPedidos.map((p) => p.displayId).sort(), ["A101", "A102", "A103"]);
    assert.equal(r.indicadores.vida.decomposta.amostras, 2);
    assert.equal(r.indicadores.vida.decomposta.preparoMediaDia + r.indicadores.vida.decomposta.entregaMediaDia, r.indicadores.vida.decomposta.mediaDia);
    const retirada = r.ultimosPedidos.find((p) => p.displayId === "A103");
    assert.deepEqual([retirada.preparoMin, retirada.entregaMin, retirada.vidaMin], [null, null, null]);
    assert.ok(!JSON.stringify(r).includes("B10"));
  });

  test("mesma empresa, unidade sem integração: não vê nada da integrada", async () => {
    const r = await resumo(A, A2, ifoodSem);
    assert.equal(r.modo, "sem_integracao");
    assert.equal(r.contagemDia.recebidos, 0);
    assert.equal(r.ultimosPedidos.length, 0);
  });

  test("outra empresa vê só os seus; acesso cruzado (org × unidade trocadas) devolve vazio", async () => {
    const b = await resumo(B, B1, ifoodIntegrado);
    assert.deepEqual(b.ultimosPedidos.map((p) => p.displayId).sort(), ["B101", "B102", "B103"]);
    for (const [org, un] of [[B, A1], [A, B1], [B, A2]]) {
      const r = await resumo(org, un, ifoodSem);
      assert.equal(r.contagemDia.recebidos, 0, `${org.slice(0, 4)}/${un.slice(0, 4)}`);
    }
  });

  test("RLS REAL via PostgREST: a chave pública (anon) não lê nem escreve pedidos nem módulos das empresas", async () => {
    const lido = await anon.from("ifood_pedidos").select("order_id").like("order_id", `${TAG}%`);
    assert.deepEqual([lido.error, lido.data], [null, []]);
    const mods = await anon.from("organizacao_modulos").select("modulo_id").in("organizacao_id", criados.orgs);
    assert.deepEqual(mods.data ?? [], []);
    const ins = await anon.from("ifood_pedidos").insert({ organizacao_id: A, unidade_id: A1, order_id: `${TAG}-x`, merchant_id: "m" });
    assert.ok(ins.error, "anon não insere");
  });

  describe("migration do módulo no Supabase de teste (aplica, verifica, desfaz)", () => {
    const motivo = PULAR || motivoIndisponivel();
    const NOME = readdirSync(MIG).find((f) => /^\d+_checklist_operacional_modulo\.sql$/.test(f));
    const ROLL = NOME?.replace(/_checklist_operacional_modulo\.sql$/, "_rollback.sql");
    // Aplica o ARQUIVO (psql -f, UTF-8): passar o SQL por `-c` quebra a codificação dos comentários no Windows. As guardas de banco de teste
    // (motivoIndisponivel/assertBancoDeTeste) valem igual: só roda se DATABASE_TESTE_URL for do MESMO projeto de teste dos testes.
    const PSQL = [process.env.PSQL_PATH, "C:/Program Files/PostgreSQL/17/bin/psql.exe", "C:/Program Files/PostgreSQL/16/bin/psql.exe"].find((c) => c && existsSync(c)) ?? "psql";
    const aplicar = (f) => {
      assert.equal(motivoIndisponivel(), false);
      const { url } = assertBancoDeTeste({ ...process.env, SUPABASE_URL: "" });
      const r = spawnSync(PSQL, [url, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-f", path.join(MIG, f)], { encoding: "utf8", env: { ...process.env, PGCLIENTENCODING: "UTF8" } });
      assert.equal(r.status, 0, (r.stderr ?? "").replace(url, "<url-teste>"));
    };
    const modsDe = async (tabela, col, ids) => { const { data, error } = await admin.from(tabela).select(`${col}, modulo_id`).in(col, ids); assert.ifError(error); return data; };

    test("estado inicial: o módulo não existe no catálogo de teste", { skip: motivo }, async () => {
      const { data } = await admin.from("modulos").select("id").eq("id", "checklist_operacional");
      assert.deepEqual(data, [], "o catálogo de teste não pode ter o módulo antes do teste");
    });

    test("aplica: só a empresa/unidade fictícia que tinha ifood ganha; a outra não; depois rollback e reaplica", { skip: motivo }, async () => {
      // A: ifood na empresa e na unidade A1; B: só dashboard.
      for (const [t, row] of [["organizacao_modulos", { organizacao_id: A, modulo_id: "ifood" }], ["organizacao_modulos", { organizacao_id: B, modulo_id: "dashboard" }], ["unidade_modulos", { unidade_id: A1, modulo_id: "ifood" }], ["unidade_modulos", { unidade_id: B1, modulo_id: "dashboard" }]]) {
        const { error } = await admin.from(t).upsert(row); assert.ifError(error);
      }
      aplicar(NOME);
      const orgs = await modsDe("organizacao_modulos", "organizacao_id", [A, B]);
      const unis = await modsDe("unidade_modulos", "unidade_id", [A1, A2, B1]);
      const tem = (lista, id) => lista.some((r) => (r.organizacao_id ?? r.unidade_id) === id && r.modulo_id === "checklist_operacional");
      assert.deepEqual([tem(orgs, A), tem(orgs, B), tem(unis, A1), tem(unis, A2), tem(unis, B1)], [true, false, true, false, false]);
      const { data: cat } = await admin.from("modulos").select("nome, categoria, ordem").eq("id", "checklist_operacional").single();
      assert.deepEqual(cat, { nome: "Checklist Operacional", categoria: "operacao", ordem: 17 });
      aplicar(NOME);                                            // idempotente
      aplicar(ROLL);
      assert.deepEqual((await admin.from("modulos").select("id").eq("id", "checklist_operacional")).data, []);
      assert.equal((await modsDe("organizacao_modulos", "organizacao_id", [A, B])).some((r) => r.modulo_id === "checklist_operacional"), false);
      assert.equal((await modsDe("organizacao_modulos", "organizacao_id", [A])).some((r) => r.modulo_id === "ifood"), true, "ifood intacto");
      aplicar(NOME);                                            // reaplica depois do rollback
      assert.equal(tem(await modsDe("organizacao_modulos", "organizacao_id", [A]), A), true);
    });

    after(() => {
      // Deixa o catálogo do projeto de teste como estava: sem o módulo (e sem vínculos dele).
      if (motivo) return;
      try { aplicar(ROLL); } catch { /* o próprio teste já falhou; nada mais a fazer */ }
    });
  });
});
