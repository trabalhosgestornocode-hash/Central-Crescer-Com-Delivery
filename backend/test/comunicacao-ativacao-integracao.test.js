// Habilitação da organização piloto (H.4-B.1) — INTEGRAÇÃO contra o Supabase de TESTE (migration 093 aplicada):
// a RPC atômica comunicacao_habilitar_organizacao_piloto (gates + advisory lock) e o service do Painel
// (habilitar/desabilitar) com AUDITORIA REAL de ator humano.
// PULA (não falha) sem credencial de banco descartável / sem as migrations 082-088-093.
// Rodar: node --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-ativacao-integracao.test.js
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, criarDestinatario, apagarDestinatario, habilitarOrganizacao,
  migracao082Aplicada, migracao088Aplicada,
} from "./helpers/comunicacao-fixtures.js";
import { definirHabilitacao } from "../src/modules/administrativo/administrativo.comunicacao.service.js";
import { definirModo, modoAtual } from "../src/modules/comunicacao/comunicacao.config.js";
import { MODOS } from "../src/modules/comunicacao/comunicacao.constants.js";
import { ACOES } from "../src/shared/auditoria.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
const tag = `comativ${Date.now()}`;
let migracaoOk = true;
let modoOriginal = null;
let orgA = null, orgB = null, destA = null, destB = null;
let telefoneA = null;

async function migracao093Aplicada() {
  const s = await supabase.rpc("comunicacao_habilitar_organizacao_piloto", { p_organizacao_id: "00000000-0000-0000-0000-000000000000", p_ator_perfil_id: null });
  return !s.error;
}
const rpc = (org, ator = null) => supabase.rpc("comunicacao_habilitar_organizacao_piloto", { p_organizacao_id: org, p_ator_perfil_id: ator });
const habilitada = async (org) => (await supabase.from("comunicacao_habilitacoes").select("habilitado").eq("organizacao_id", org).single()).data.habilitado;
const totalHabilitadas = async () => (await supabase.from("comunicacao_habilitacoes").select("organizacao_id", { count: "exact", head: true }).eq("habilitado", true)).count;

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada()) && (await migracao093Aplicada());
  if (!migracaoOk) return;
  modoOriginal = await modoAtual();
  orgA = await criarOrganizacao("TESTE ativacao A — descartável");
  orgB = await criarOrganizacao("TESTE ativacao B — descartável");
  const uA = await criarUnidade(orgA, "Unidade A"), uB = await criarUnidade(orgB, "Unidade B");
  destA = await criarDestinatario({ organizacaoId: orgA, unidadeId: uA, tag, sufixo: "a" });
  destB = await criarDestinatario({ organizacaoId: orgB, unidadeId: uB, tag, sufixo: "b" });
  telefoneA = (await supabase.from("contatos_whatsapp").select("telefone_e164").eq("id", destA.contatoId).single()).data.telefone_e164;
});

after(async () => {
  if (modoOriginal) await definirModo(modoOriginal, {}).catch(() => {});
  if (orgA) await supabase.from("comunicacao_habilitacoes").update({ habilitado: false }).eq("organizacao_id", orgA);
  if (orgB) await supabase.from("comunicacao_habilitacoes").update({ habilitado: false }).eq("organizacao_id", orgB);
  await apagarOrganizacao(orgA); await apagarOrganizacao(orgB);
  await apagarDestinatario(destA); await apagarDestinatario(destB);
});

beforeEach(async (t) => {
  if (PULAR_INTEGRACAO || !migracaoOk) return;
  await definirModo(MODOS.DISABLED, {});
  await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).in("id", [destA.contatoId, destB.contatoId]);
  await habilitarOrganizacao(orgA, destA, { habilitado: false });
  await habilitarOrganizacao(orgB, destB, { habilitado: false });
});

const sk = (t) => t.skip(PULAR_INTEGRACAO || "migrations 082/088/093 ainda não aplicadas — pulando.");

describe("RPC comunicacao_habilitar_organizacao_piloto (093)", { skip: PULAR_INTEGRACAO }, () => {
  test("tudo válido -> HABILITADA; de novo -> JA_HABILITADA (idempotente)", async (t) => {
    if (!migracaoOk) return sk(t);
    if ((await totalHabilitadas()) > 0) return t.skip("há outra organização habilitada no banco de teste");
    assert.equal((await rpc(orgA)).data.acao, "HABILITADA");
    assert.equal(await habilitada(orgA), true);
    assert.equal((await rpc(orgA)).data.acao, "JA_HABILITADA");
  });

  test("modo global != DISABLED -> MODO_NAO_DESABILITADO, nada muda", async (t) => {
    if (!migracaoOk) return sk(t);
    await definirModo(MODOS.NORMAL, {});
    assert.equal((await rpc(orgA)).data.acao, "MODO_NAO_DESABILITADO");
    assert.equal(await habilitada(orgA), false);
    await definirModo(MODOS.DISABLED, {});
  });

  test("organização sem linha de configuração -> SEM_CONFIGURACAO", async (t) => {
    if (!migracaoOk) return sk(t);
    const org = await criarOrganizacao("TESTE ativacao sem config — descartável");
    try { assert.equal((await rpc(org)).data.acao, "SEM_CONFIGURACAO"); } finally { await apagarOrganizacao(org); }
  });

  test("OUTRA organização já habilitada -> OUTRA_ORGANIZACAO_HABILITADA (piloto = 1 empresa)", async (t) => {
    if (!migracaoOk) return sk(t);
    if ((await totalHabilitadas()) > 0) return t.skip("há outra organização habilitada no banco de teste");
    assert.equal((await rpc(orgA)).data.acao, "HABILITADA");
    assert.equal((await rpc(orgB)).data.acao, "OUTRA_ORGANIZACAO_HABILITADA");
    assert.equal(await habilitada(orgB), false);
  });

  test("destinatário sem consentimento / não verificado / com opt-out -> DESTINATARIO_INELEGIVEL", async (t) => {
    if (!migracaoOk) return sk(t);
    for (const campos of [{ consentimento: false }, { verificado: false }, { opt_out: true }]) {
      await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false, ...campos }).eq("id", destA.contatoId);
      assert.equal((await rpc(orgA)).data.acao, "DESTINATARIO_INELEGIVEL", JSON.stringify(campos));
      assert.equal(await habilitada(orgA), false);
    }
  });

  test("timezone / tipo / destinatário ausentes -> recusa específica", async (t) => {
    if (!migracaoOk) return sk(t);
    await supabase.from("comunicacao_habilitacoes").update({ tipos_permitidos: [] }).eq("organizacao_id", orgA);
    assert.equal((await rpc(orgA)).data.acao, "TIPO_AUSENTE");
    await supabase.from("comunicacao_habilitacoes").update({ tipos_permitidos: ["dashboard_ifood_d1"], timezone: null }).eq("organizacao_id", orgA);
    assert.equal((await rpc(orgA)).data.acao, "TIMEZONE_AUSENTE");
  });

  test("CONCORRÊNCIA: 2 organizações x 5 chamadas simultâneas -> exatamente 1 organização habilitada no banco", async (t) => {
    if (!migracaoOk) return sk(t);
    if ((await totalHabilitadas()) > 0) return t.skip("há outra organização habilitada no banco de teste");
    const rs = await Promise.all([...Array(5).fill(orgA), ...Array(5).fill(orgB)].map((o) => rpc(o)));
    const acoes = rs.map((r) => r.data?.acao ?? r.error?.message);
    assert.equal(acoes.filter((a) => a === "HABILITADA").length, 1, JSON.stringify(acoes));
    assert.equal(await totalHabilitadas(), 1);
  });

  test("EXECUTE só para service_role (anon/authenticated não chamam)", async (t) => {
    if (!migracaoOk) return sk(t);
    const anon = await import("@supabase/supabase-js").then(({ createClient }) => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } }));
    const r = await anon.rpc("comunicacao_habilitar_organizacao_piloto", { p_organizacao_id: orgA, p_ator_perfil_id: null });
    assert.ok(r.error, "anon não pode executar");
    assert.equal(await habilitada(orgA), false);
  });
});

describe("service do Painel (habilitar/desabilitar) com auditoria REAL de ator humano", { skip: PULAR_INTEGRACAO }, () => {
  const envOk = () => ({ COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: telefoneA });
  const autor = () => ({ contaId: destA.contaId, perfilId: destA.perfilId, nome: "Operador Teste", email: "operador@teste.local" });
  const auditoria = async (acao, org) => (await supabase.from("plataforma_auditoria").select("*").eq("acao", acao).eq("organizacao_id", org).order("created_at", { ascending: false })).data ?? [];

  test("habilitar (piloto ok) -> habilitado=true e auditoria COMUNICACAO_ORGANIZACAO_HABILITADA com o ATOR humano; sem telefone", async (t) => {
    if (!migracaoOk) return sk(t);
    if ((await totalHabilitadas()) > 0) return t.skip("há outra organização habilitada no banco de teste");
    const r = await definirHabilitacao({ organizacaoId: orgA, habilitado: true, confirmacaoExplicita: true }, autor(), { env: envOk() });
    assert.deepEqual(r, { organizacaoId: orgA, habilitado: true, alterou: true });
    assert.equal(await habilitada(orgA), true);
    const [linha] = await auditoria(ACOES.COMUNICACAO_ORGANIZACAO_HABILITADA, orgA);
    assert.ok(linha, "auditoria gravada");
    assert.equal(linha.ator_id, destA.contaId);
    assert.equal(linha.ator_email, "operador@teste.local");
    assert.equal(linha.perfil_id, destA.perfilId);
    assert.equal(linha.detalhes.para, true);
    assert.doesNotMatch(JSON.stringify(linha), new RegExp(telefoneA.replace("+", "\\+")));
  });

  test("piloto desligado no runtime -> 409 PILOTO_INATIVO, nada habilitado, nenhuma auditoria", async (t) => {
    if (!migracaoOk) return sk(t);
    const auditoriasAntes = (await auditoria(ACOES.COMUNICACAO_ORGANIZACAO_HABILITADA, orgA)).length; // plataforma_auditoria é append-only
    await assert.rejects(() => definirHabilitacao({ organizacaoId: orgA, habilitado: true, confirmacaoExplicita: true }, autor(), { env: {} }), (e) => e.statusCode === 409 && e.details?.codigo === "PILOTO_INATIVO");
    assert.equal(await habilitada(orgA), false);
    assert.equal((await auditoria(ACOES.COMUNICACAO_ORGANIZACAO_HABILITADA, orgA)).length, auditoriasAntes, "nenhuma auditoria nova");
  });

  test("desabilitar -> habilitado=false SEM gates e auditoria COMUNICACAO_ORGANIZACAO_DESABILITADA", async (t) => {
    if (!migracaoOk) return sk(t);
    await supabase.from("comunicacao_habilitacoes").update({ habilitado: true }).eq("organizacao_id", orgA);
    const r = await definirHabilitacao({ organizacaoId: orgA, habilitado: false }, autor(), { env: {} });
    assert.deepEqual(r, { organizacaoId: orgA, habilitado: false, alterou: true });
    assert.equal(await habilitada(orgA), false);
    const [linha] = await auditoria(ACOES.COMUNICACAO_ORGANIZACAO_DESABILITADA, orgA);
    assert.ok(linha);
    assert.equal(linha.ator_id, destA.contaId);
  });
});
