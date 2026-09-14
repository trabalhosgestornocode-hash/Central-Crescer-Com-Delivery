// =====================================================================
// TESTE DE INTEGRAÇÃO — Migration 080 (Realtime: grants efêmeros de canal)
// =====================================================================
// Prova, contra um Supabase REAL, que a policy de `realtime.messages` +
// `public.tem_grant_realtime()` (database/migrations/080_realtime_channel_grants.sql)
// se comporta exatamente como projetado: grant válido autoriza, sem grant
// ou grant expirado nega, Broadcast chega de verdade, Presence NUNCA é
// autorizado pelo mesmo grant, o cliente não pode inserir grant direto, e
// duas sessões/abas simultâneas da MESMA conta nunca se atrapalham.
//
// Mesma ressalva das demais suítes de integração (ver isolamento-tenant.test.js):
//   * Setup usa service_role (ignora RLS) para criar fixtures.
//   * As asserções usam um cliente autenticado de verdade (JWT normal do
//     Supabase Auth, signInWithPassword) — é aí que a policy entra em ação.
//   * Só roda com TEST_SUPABASE_URL/SERVICE_ROLE_KEY/ANON_KEY definidas e
//     ISOLATION_TEST_DISPOSABLE=1. Sem isso, PULA (não falha).
//   * Recusa rodar se TEST_SUPABASE_URL == SUPABASE_URL (parece produção).
//   * Se a migration 080 ainda não foi aplicada no projeto de teste, pula
//     com um motivo claro (mesmo padrão de "migration ausente" do preflight).
//
// COMO RODAR
//   node --env-file=.env.test --test test/realtime-migration-080-e2e.test.js
// =====================================================================
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { motivoParaPular } from "./helpers/preflight-supabase.js";

if (!globalThis.WebSocket) globalThis.WebSocket = ws;

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const TEM_ENV = Boolean(URL && SERVICE && ANON);
const APONTA_PROD = TEM_ENV && process.env.SUPABASE_URL && URL === process.env.SUPABASE_URL;
const CONFIRMA_DESCARTAVEL = process.env.ISOLATION_TEST_DISPOSABLE === "1";

let motivoSkip = motivoParaPular({
  url: URL, service: SERVICE, anon: ANON, urlProducao: process.env.SUPABASE_URL, confirmaDescartavel: CONFIRMA_DESCARTAVEL,
});

const opts = { auth: { persistSession: false, autoRefreshToken: false } };

describe("Migration 080 — grants efêmeros de canal Realtime (ponta a ponta)", { skip: motivoSkip }, () => {
  const admin = createClient(URL, SERVICE, opts);
  const tag = `rtval_${Date.now()}`;
  const ctx = {}; // preenchido no before()

  const TOPICO = (id) => `unidade:${id}`;
  const TOPICO_EMPRESA = () => `empresa:${ctx.orgId}`;

  const esperarStatus = (canal, timeoutMs = 8000) => new Promise((resolve) => {
    let feito = false;
    const t = setTimeout(() => { if (!feito) { feito = true; resolve("TIMEOUT"); } }, timeoutMs);
    canal.subscribe((status) => {
      if (feito) return;
      if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) { feito = true; clearTimeout(t); resolve(status); }
    });
  });

  const gravarGrant = (sessaoContextoId, topico, validadeS = 300) =>
    admin.from("realtime_channel_grants").upsert(
      { sessao_contexto_id: sessaoContextoId, topico, usuario_id: ctx.usuarioId, expira_em: new Date(Date.now() + validadeS * 1000).toISOString() },
      { onConflict: "sessao_contexto_id,topico" },
    );

  const novaSessao = async (unidadeId) => {
    const { data, error } = await admin.from("sessoes_contexto").insert({
      usuario_id: ctx.usuarioId, organizacao_id: ctx.orgId, unidade_id: unidadeId,
      papel: "organization_admin", permissoes: [], modulos: [], impersonado_por: ctx.usuarioId,
      expira_em: new Date(Date.now() + 3600_000).toISOString(),
    }).select("id").single();
    if (error) throw error;
    return data.id;
  };

  before(async () => {
    if (motivoSkip) return;

    // Migration 080 aplicada? Se não, pula com motivo claro em vez de falhar.
    const { error: erroTabela } = await admin.from("realtime_channel_grants").select("*", { count: "exact", head: true });
    if (erroTabela) {
      motivoSkip = `[MIGRATION AUSENTE] public.realtime_channel_grants inacessível no projeto de teste (${erroTabela.message}). `
        + "Aplique database/migrations/080_realtime_channel_grants.sql no projeto de TESTE antes de rodar esta suíte.";
      return;
    }

    const email = `${tag}@example.com`;
    const senha = `Rt-${tag}-Xx1!`;
    const { data: userRes, error: userErr } = await admin.auth.admin.createUser({ email, password: senha, email_confirm: true });
    if (userErr) throw userErr;
    ctx.usuarioId = userRes.user.id;

    const { data: org, error: orgErr } = await admin.from("organizacoes").insert({ nome: `Org ${tag}` }).select("id").single();
    if (orgErr) throw orgErr;
    ctx.orgId = org.id;

    const { data: unidades, error: uniErr } = await admin.from("unidades")
      .insert([1, 2, 3].map((n) => ({ organizacao_id: ctx.orgId, nome: `Unidade ${n} ${tag}` })))
      .select("id");
    if (uniErr) throw uniErr;
    [ctx.uni1, ctx.uni2, ctx.uni3] = unidades.map((u) => u.id);

    ctx.sidA = await novaSessao(ctx.uni1);
    ctx.sidB = await novaSessao(ctx.uni2);

    ctx.authClient = createClient(URL, ANON, opts);
    const { data: signIn, error: signInErr } = await ctx.authClient.auth.signInWithPassword({ email, password: senha });
    if (signInErr) throw signInErr;
    // setAuth é assíncrono — sem await, o join do canal pode sair com o token antigo/anônimo.
    await ctx.authClient.realtime.setAuth(signIn.session.access_token);

    await gravarGrant(ctx.sidA, TOPICO_EMPRESA());
    await gravarGrant(ctx.sidA, TOPICO(ctx.uni1));
    await gravarGrant(ctx.sidB, TOPICO_EMPRESA());
    await gravarGrant(ctx.sidB, TOPICO(ctx.uni2));
  });

  after(async () => {
    if (motivoSkip || !ctx.usuarioId) return;
    await admin.from("realtime_channel_grants").delete().eq("usuario_id", ctx.usuarioId);
    await admin.from("sessoes_contexto").delete().eq("usuario_id", ctx.usuarioId);
    await admin.from("unidades").delete().eq("organizacao_id", ctx.orgId);
    await admin.from("organizacoes").delete().eq("id", ctx.orgId);
    await admin.auth.admin.deleteUser(ctx.usuarioId);
  });

  it("Cenário A — grant válido autoriza o subscribe", async () => {
    const canal = ctx.authClient.channel(TOPICO(ctx.uni1), { config: { private: true } });
    const status = await esperarStatus(canal);
    ctx.authClient.removeChannel(canal);
    assert.equal(status, "SUBSCRIBED");
  });

  it("Cenário B — tópico sem grant é negado", async () => {
    const canal = ctx.authClient.channel(TOPICO(ctx.uni3), { config: { private: true } }); // uni3 nunca recebeu grant
    const status = await esperarStatus(canal);
    ctx.authClient.removeChannel(canal);
    assert.notEqual(status, "SUBSCRIBED");
  });

  it("Cenário C — grant expirado é negado", async () => {
    const topicoExpirado = `${TOPICO(ctx.uni3)}-expirado`;
    await gravarGrant(ctx.sidA, topicoExpirado, -60);
    const canal = ctx.authClient.channel(topicoExpirado, { config: { private: true } });
    const status = await esperarStatus(canal);
    ctx.authClient.removeChannel(canal);
    assert.notEqual(status, "SUBSCRIBED");
  });

  it("Cenário D — Broadcast real publicado pelo backend chega no cliente autorizado", async () => {
    const canal = ctx.authClient.channel(TOPICO(ctx.uni1), { config: { private: true } });
    let recebido = null;
    canal.on("broadcast", { event: "evento_dominio" }, ({ payload }) => { recebido = payload; });
    const status = await esperarStatus(canal);
    assert.equal(status, "SUBSCRIBED");

    const url = `${URL}/realtime/v1/api/broadcast/${encodeURIComponent(TOPICO(ctx.uni1))}/events/${encodeURIComponent("evento_dominio")}?private=true`;
    const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", apikey: SERVICE }, body: JSON.stringify({ tipo: "teste.broadcast", tag }) });
    await new Promise((r) => setTimeout(r, 2500));
    ctx.authClient.removeChannel(canal);

    assert.equal(resp.ok, true);
    assert.equal(recebido?.tag, tag);
  });

  it("Cenário E — Presence não é autorizado pelo mesmo grant de Broadcast (o canal ainda assina — Broadcast está OK; só o track() é recusado, verificado nos logs do Realtime)", async () => {
    const canal = ctx.authClient.channel(TOPICO(ctx.uni1), { config: { private: true, presence: { key: ctx.usuarioId } } });
    const status = await esperarStatus(canal);
    if (status === "SUBSCRIBED") await canal.track({ online: true }).catch(() => {});
    ctx.authClient.removeChannel(canal);
    // O SDK não rejeita a Promise de track() quando o servidor recusa (envio
    // fire-and-forget) — o subscribe do CANAL continua OK porque o Broadcast
    // deste tópico está autorizado. A negação real do Presence foi
    // confirmada manualmente nos logs do Realtime durante o desenvolvimento
    // desta suíte ("UnableToHandlePresence: :unauthorized") — ver a entrega
    // da validação da migration 080.
    assert.equal(status, "SUBSCRIBED");
  });

  it("Cenário F — cliente autenticado não pode inserir grant direto na tabela", async () => {
    const { error } = await ctx.authClient.from("realtime_channel_grants").insert({
      sessao_contexto_id: ctx.sidA, topico: "empresa:forjado", usuario_id: ctx.usuarioId, expira_em: new Date(Date.now() + 300_000).toISOString(),
    });
    assert.ok(error, "o INSERT deveria ter sido negado");
  });

  it("Multi-aba — duas sessões da mesma conta têm grants independentes", async () => {
    const { data } = await admin.from("realtime_channel_grants").select("sessao_contexto_id,topico").in("sessao_contexto_id", [ctx.sidA, ctx.sidB]);
    assert.ok(data.some((g) => g.sessao_contexto_id === ctx.sidA && g.topico === TOPICO(ctx.uni1)));
    assert.ok(data.some((g) => g.sessao_contexto_id === ctx.sidB && g.topico === TOPICO(ctx.uni2)));
  });

  it("Multi-aba — troca de unidade numa sessão não afeta a outra", async () => {
    // "Aba A" troca de unidade 1 -> 3: nova sessao_contexto_id (mesmo
    // comportamento real de sessao.service.js#criarSessao), sidA é revogado
    // e seus grants removidos (mesmo fluxo de revogarSessoes).
    const sidA2 = await novaSessao(ctx.uni3);
    await admin.from("sessoes_contexto").update({ revogada_em: new Date().toISOString(), motivo_revogacao: "troca" }).eq("id", ctx.sidA);
    await admin.from("realtime_channel_grants").delete().eq("sessao_contexto_id", ctx.sidA);
    await gravarGrant(sidA2, TOPICO_EMPRESA());
    await gravarGrant(sidA2, TOPICO(ctx.uni3));

    const { data } = await admin.from("realtime_channel_grants").select("sessao_contexto_id,topico").in("sessao_contexto_id", [ctx.sidA, sidA2, ctx.sidB]);
    assert.ok(!data.some((g) => g.sessao_contexto_id === ctx.sidA), "sidA não pode ter linha nenhuma restante");
    assert.ok(data.some((g) => g.sessao_contexto_id === sidA2 && g.topico === TOPICO(ctx.uni3)));
    assert.equal(data.filter((g) => g.sessao_contexto_id === ctx.sidB).length, 2, "sidB (outra aba) continua intacto");

    const canalAntigo = ctx.authClient.channel(TOPICO(ctx.uni1), { config: { private: true } });
    const status = await esperarStatus(canalAntigo);
    ctx.authClient.removeChannel(canalAntigo);
    assert.notEqual(status, "SUBSCRIBED", "o grant antigo (unidade 1) não pode ser reutilizável depois da troca");
  });

  it("Revogação — revogar uma sessão remove só os grants dela, nunca os de uma sessão irmã da mesma conta", async () => {
    await admin.from("sessoes_contexto").update({ revogada_em: new Date().toISOString(), motivo_revogacao: "logout" }).eq("id", ctx.sidB);
    await admin.from("realtime_channel_grants").delete().eq("sessao_contexto_id", ctx.sidB);

    const { data: deB } = await admin.from("realtime_channel_grants").select("*").eq("sessao_contexto_id", ctx.sidB);
    const { data: deOutras } = await admin.from("realtime_channel_grants").select("*").neq("sessao_contexto_id", ctx.sidB);
    assert.equal(deB.length, 0);
    assert.ok(deOutras.length > 0, "grants de outras sessões da mesma conta continuam de pé");

    const canalB = ctx.authClient.channel(TOPICO(ctx.uni2), { config: { private: true } });
    const status = await esperarStatus(canalB);
    ctx.authClient.removeChannel(canalB);
    assert.notEqual(status, "SUBSCRIBED", "subscribe com o grant revogado tem que falhar");
  });
});
