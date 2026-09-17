// Integração — prova, contra o Supabase REAL, que a UNIQUE NULLS NOT
// DISTINCT da migration 082 impede duplicidade lógica mesmo com
// unidade_id/destinatario_perfil_id NULOS (o defeito que uma UNIQUE comum
// teria: cada NULL contaria como distinto).
//
// PULA se a migration 082 ainda não foi aplicada, ou se o Supabase
// configurado não é comprovadamente descartável — mesmo padrão de
// agente-conversas-isolamento.test.js.
// Rodar: node --env-file=.env --test test/comunicacao-dedup-constraint.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, migracao082Aplicada } from "./helpers/comunicacao-fixtures.js";
import { TIPOS_ALERTA, SEVERIDADE } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
let migracaoOk = true;
let orgId = null;

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = await migracao082Aplicada();
  if (!migracaoOk) return;
  orgId = await criarOrganizacao("TESTE comunicacao-dedup — descartável");
});

after(async () => { await apagarOrganizacao(orgId); });

describe("comunicacao_alertas — dedup real no banco (UNIQUE NULLS NOT DISTINCT)", { skip: PULAR_INTEGRACAO }, () => {
  test("teste 3 — duas linhas com unidade_id NULL e mesma chave lógica são recusadas pelo banco", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");

    const linha = {
      organizacao_id: orgId, unidade_id: null,
      tipo_alerta: TIPOS_ALERTA.DASHBOARD_IFOOD_D1, data_referencia: "2026-09-15",
      destinatario_perfil_id: null, severidade: SEVERIDADE.ATENCAO,
    };
    const primeira = await supabase.from("comunicacao_alertas").insert(linha).select("id").single();
    assert.ifError(primeira.error);

    const segunda = await supabase.from("comunicacao_alertas").insert(linha);
    assert.ok(segunda.error, "esperava que o banco recusasse a segunda linha (mesma chave, unidade_id NULL nas duas)");
    assert.equal(segunda.error.code, "23505"); // unique_violation

    await supabase.from("comunicacao_alertas").delete().eq("id", primeira.data.id);
  });

  test("destinatario_perfil_id NULL nas duas também é tratado como igual (não só unidade_id)", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");

    const linha = {
      organizacao_id: orgId, unidade_id: null,
      tipo_alerta: TIPOS_ALERTA.DASHBOARD_IFOOD_D1, data_referencia: "2026-09-16",
      destinatario_perfil_id: null, severidade: SEVERIDADE.CRITICO,
    };
    const a = await supabase.from("comunicacao_alertas").insert(linha).select("id").single();
    assert.ifError(a.error);
    const b = await supabase.from("comunicacao_alertas").insert(linha);
    assert.equal(b.error?.code, "23505");
    await supabase.from("comunicacao_alertas").delete().eq("id", a.data.id);
  });

  test("data_referencia diferente NÃO é duplicidade (chave lógica realmente distinta)", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");

    const base = { organizacao_id: orgId, unidade_id: null, tipo_alerta: TIPOS_ALERTA.DASHBOARD_IFOOD_D1, destinatario_perfil_id: null, severidade: SEVERIDADE.ATENCAO };
    const a = await supabase.from("comunicacao_alertas").insert({ ...base, data_referencia: "2026-09-10" }).select("id").single();
    const b = await supabase.from("comunicacao_alertas").insert({ ...base, data_referencia: "2026-09-11" }).select("id").single();
    assert.ifError(a.error);
    assert.ifError(b.error); // duas linhas válidas — datas diferentes
    await supabase.from("comunicacao_alertas").delete().in("id", [a.data.id, b.data.id]);
  });
});
