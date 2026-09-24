// PRIMEIRO AVISO TARDIO D-1 (H.4-B.2) — INTEGRAÇÃO contra o Supabase de TESTE (migration 094 aplicada): a RPC
// comunicacao_agendar_aviso_tardio_d1, o trigger (a INICIAL tardia continua dona de comunicacao_alertas.status),
// concorrência (30 RPCs; scheduler NORMAL × TARDIO), e o PIPELINE REAL (claim -> JIT do aviso tardio -> policy ->
// reservar_envio -> gateway -> FakeProvider): pendência resolvida, gates de janela/dia/D-1, opt-out, empresa,
// allowlist do piloto, rate-limit, dois workers, zero reforço no mesmo dia.
// PULA (não falha) sem credencial de banco descartável / sem as migrations 082-088-092-094.
// Rodar: node --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-aviso-tardio-integracao.test.js
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, criarDestinatario, apagarDestinatario, habilitarOrganizacao,
  migracao082Aplicada, migracao088Aplicada,
} from "./helpers/comunicacao-fixtures.js";
import * as alertasRepo from "../src/modules/comunicacao/comunicacao.alertas.repo.js";
import {
  processarProximoLote, agendarAvisosTardiosD1, agendarReforcosPendentes, agendarEnviosPendentes,
} from "../src/modules/comunicacao/comunicacao.alertas.service.js";
import { definirModo, modoAtual } from "../src/modules/comunicacao/comunicacao.config.js";
import { criarWhatsAppService } from "../src/modules/comunicacao/whatsapp.service.js";
import { criarFakeProvider } from "../src/modules/comunicacao/providers/fake.provider.js";
import { MODOS, TIPOS_ALERTA, SEVERIDADE, STATUS_ALERTA as SA, STATUS_MENSAGEM as SM } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
const TIPO = TIPOS_ALERTA.DASHBOARD_IFOOD_D1;
const tag = `comtardio${Date.now()}`;

// Horário LOCAL (Fortaleza = UTC-3, sem DST) de setembro/2026 -> instante UTC. Quarta 16 (D-1 = 15), domingo 20 (D-1 = 19).
const LOCAL = (dia, hhmm) => new Date(Date.UTC(2026, 8, dia, Number(hhmm.slice(0, 2)) + 3, Number(hhmm.slice(3))));
const QUA = (hhmm) => LOCAL(16, hhmm);
const AGORA = QUA("20:30"); // dentro da janela tardia 20:00–22:00

let migracaoOk = true;
let modoOriginal = null, limitesOriginais = null;
let orgA = null, unidadeA = null, dest = null, telefone = null;

const definirLimites = (l) => supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: l }, { onConflict: "chave" });
const LIMITES = { max_proativas_por_minuto: 1000, max_proativas_por_minuto_por_organizacao: 1000, max_por_contato_por_dia: 3 };

async function migracao094Aplicada() {
  const s = await supabase.rpc("comunicacao_agendar_aviso_tardio_d1", {
    p_alerta_id: "00000000-0000-0000-0000-000000000000", p_conteudo: "probe", p_idempotency_key: "probe",
    p_disponivel_em: new Date().toISOString(), p_expira_em: null, p_max_tentativas: 1,
  });
  return !s.error;
}

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada()) && (await migracao094Aplicada());
  if (!migracaoOk) return;
  modoOriginal = await modoAtual();
  limitesOriginais = (await supabase.from("comunicacao_configuracoes").select("valor").eq("chave", "limites").maybeSingle()).data?.valor ?? null;
  orgA = await criarOrganizacao("TESTE aviso-tardio — descartável");
  unidadeA = await criarUnidade(orgA, "Unidade Tardio A1");
  dest = await criarDestinatario({ organizacaoId: orgA, unidadeId: unidadeA, tag });
  await habilitarOrganizacao(orgA, dest);
  telefone = (await supabase.from("contatos_whatsapp").select("telefone_e164").eq("id", dest.contatoId).single()).data.telefone_e164;
});

after(async () => {
  delete process.env.COMUNICACAO_PILOTO_ENABLED; delete process.env.COMUNICACAO_PILOTO_TELEFONES_E164;
  if (modoOriginal) await definirModo(modoOriginal, {}).catch(() => {});
  if (limitesOriginais) await definirLimites(limitesOriginais);
  await apagarOrganizacao(orgA);
  await apagarDestinatario(dest);
});

beforeEach(async () => {
  if (PULAR_INTEGRACAO || !migracaoOk) return;
  delete process.env.COMUNICACAO_PILOTO_ENABLED; delete process.env.COMUNICACAO_PILOTO_TELEFONES_E164;
  await definirLimites(LIMITES);
  await definirModo(MODOS.NORMAL, {});
  await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
  await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", orgA);
  await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).eq("id", dest.contatoId);
  await habilitarOrganizacao(orgA, dest);
});

const chaveInicial = (id) => `wa:alerta:${id}:v1`;
const linha = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("id", id).single()).data;
const statusAlerta = async (id) => (await supabase.from("comunicacao_alertas").select("status").eq("id", id).single()).data.status;
const mensagensDoAlerta = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("alerta_id", id)).data;
const atualizarMsg = (id, campos) => supabase.from("comunicacao_mensagens").update(campos).eq("id", id);

async function novoAlerta(dataReferencia = "2026-09-15") {
  const { alerta } = await alertasRepo.criarOuEscalonarAlerta({
    organizacaoId: orgA, unidadeId: unidadeA, tipoAlerta: TIPO, dataReferencia, destinatarioPerfilId: null,
    severidade: SEVERIDADE.ATENCAO, motivo: "1 dia(s) pendente(s)", metadados: { unidade_nome: "Loja Tardio" },
  });
  return alerta;
}

const chamarTardio = (alertaId, { chave, disponivelEm = new Date(Date.now() - 60_000), expiraEm = null } = {}) =>
  supabase.rpc("comunicacao_agendar_aviso_tardio_d1", {
    p_alerta_id: alertaId, p_conteudo: "aviso tardio de teste", p_idempotency_key: chave ?? chaveInicial(alertaId),
    p_disponivel_em: disponivelEm.toISOString(), p_expira_em: expiraEm ? expiraEm.toISOString() : null, p_max_tentativas: 5,
  });
const chamarNormal = (alertaId) => supabase.rpc("comunicacao_agendar_mensagem_alerta", {
  p_alerta_id: alertaId, p_tipo: TIPO, p_conteudo: "inicial normal", p_idempotency_key: chaveInicial(alertaId),
  p_disponivel_em: new Date(Date.now() - 60_000).toISOString(), p_expira_em: null, p_max_tentativas: 5,
});

async function inserirMensagem({ alertaId, status, idempotencyKey, proposito = null, enviadoEm = null, extra = {} }) {
  const { data, error } = await supabase.from("comunicacao_mensagens").insert({
    alerta_id: alertaId, organizacao_id: orgA, unidade_id: unidadeA, contato_id: dest.contatoId,
    destinatario_perfil_id: dest.perfilId, canal: "whatsapp", direcao: "saida", tipo: TIPO,
    conteudo: "msg de teste", idempotency_key: idempotencyKey, status,
    metadados: proposito ? { proposito } : {}, disponivel_em: new Date(Date.now() - 60_000).toISOString(),
    ...(enviadoEm ? { enviado_em: enviadoEm } : {}), ...extra,
  }).select("*").single();
  if (error) throw new Error(`fixture: ${error.message}`);
  return data;
}

const HAB = (extra = {}) => async () => ({
  empresaHabilitada: true, tipoPermitido: true, empresaPausada: false, pausadoAte: null, pausadoMotivo: null,
  destinatarioContatoId: dest.contatoId, destinatarioPerfilId: dest.perfilId,
  timezone: "America/Fortaleza", janelas: null, configHorarioValida: true, fonte: "TESTE", ...extra,
});
function criarProviderComSpy() {
  const provider = criarFakeProvider();
  const chamadas = [];
  const original = provider.sendText.bind(provider);
  provider.sendText = async (args) => { chamadas.push(args); return original(args); };
  return { provider, chamadas, whatsAppService: criarWhatsAppService({ provider, semGateIdentidade: true }) };
}
const lote = (whatsAppService, extra = {}) => processarProximoLote({
  limite: 20, worker: "teste-tardio", whatsAppService, agora: AGORA,
  verificarPendenciaAindaExiste: async () => true, resolverHabilitacao: HAB(), ...extra,
});
const sk = (t) => t.skip(PULAR_INTEGRACAO || "migrations 082/088/094 ainda não aplicadas — pulando.");
const meu = (rs, id) => rs.find((r) => r.id === id);

// ---------------------------------------------------------------------------
describe("RPC comunicacao_agendar_aviso_tardio_d1 (094)", { skip: PULAR_INTEGRACAO }, () => {
  test("cria a 1ª mensagem: chave …:v1, SCHEDULED, proposito=inicial, origem=prazo_final_d1; o alerta vai a SCHEDULED; repetir -> JA_EXISTIA", async (t) => {
    if (!migracaoOk) return sk(t);
    const alerta = await novoAlerta();
    const r1 = (await chamarTardio(alerta.id)).data;
    assert.equal(r1.acao, "CRIADA");
    const m = await linha(r1.mensagem_id);
    assert.equal(m.idempotency_key, chaveInicial(alerta.id));
    assert.equal(m.status, SM.SCHEDULED);
    assert.deepEqual(m.metadados, { proposito: "inicial", origem: "prazo_final_d1" });
    assert.equal(m.tipo, TIPO);
    assert.equal(m.contato_id, dest.contatoId);
    assert.equal(await statusAlerta(alerta.id), SA.SCHEDULED);
    const r2 = (await chamarTardio(alerta.id)).data;
    assert.equal(r2.acao, "JA_EXISTIA");
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 1);
  });

  test("chave que não é exatamente wa:alerta:{id}:v1 -> CHAVE_INVALIDA (nenhuma 2ª identidade 'tardio')", async (t) => {
    if (!migracaoOk) return sk(t);
    const alerta = await novoAlerta();
    for (const chave of [`wa:alerta:${alerta.id}:tardio:v1`, `wa:alerta:${alerta.id}:v2`, `wa:alerta:${alerta.id}:reforco:v1`]) {
      assert.equal((await chamarTardio(alerta.id, { chave })).data.acao, "CHAVE_INVALIDA", chave);
    }
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 0);
  });

  test("alerta inexistente / alerta que não está DETECTED -> recusa", async (t) => {
    if (!migracaoOk) return sk(t);
    assert.equal((await chamarTardio("00000000-0000-0000-0000-000000000000", { chave: "x" })).data.acao, "ALERTA_INEXISTENTE");
    const alerta = await novoAlerta();
    await supabase.from("comunicacao_alertas").update({ status: SA.SENT }).eq("id", alerta.id);
    assert.equal((await chamarTardio(alerta.id)).data.acao, "ALERTA_NAO_DETECTED");
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 0);
  });

  test("inicial NORMAL já existe (mesma chave) -> JA_EXISTIA; inicial com OUTRA chave -> INICIAL_JA_EXISTE; nunca 2 iniciais", async (t) => {
    if (!migracaoOk) return sk(t);
    const a1 = await novoAlerta("2026-09-15");
    assert.equal((await chamarNormal(a1.id)).data.acao, "CRIADA");
    assert.equal((await chamarTardio(a1.id)).data.acao, "JA_EXISTIA");
    assert.equal((await mensagensDoAlerta(a1.id)).length, 1);

    const a2 = await novoAlerta("2026-09-14");
    await inserirMensagem({ alertaId: a2.id, status: SM.CANCELLED, idempotencyKey: `wa:alerta:${a2.id}:outra-chave`, extra: { erro: "X" } });
    assert.equal((await chamarTardio(a2.id)).data.acao, "INICIAL_JA_EXISTE");
    assert.equal((await mensagensDoAlerta(a2.id)).length, 1);
  });

  test("a inicial anterior EXPIROU -> MENSAGEM_EXPIRADA: nunca recria (nem hoje à noite)", async (t) => {
    if (!migracaoOk) return sk(t);
    const alerta = await novoAlerta();
    await inserirMensagem({ alertaId: alerta.id, status: SM.CANCELLED, idempotencyKey: chaveInicial(alerta.id), extra: { erro: "EXPIRADA" } });
    assert.equal((await chamarTardio(alerta.id)).data.acao, "MENSAGEM_EXPIRADA");
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 1);
  });

  test("30 chamadas CONCORRENTES -> exatamente 1 CRIADA, 29 JA_EXISTIA, 1 única mensagem", async (t) => {
    if (!migracaoOk) return sk(t);
    const alerta = await novoAlerta();
    const rs = await Promise.all(Array.from({ length: 30 }, () => chamarTardio(alerta.id)));
    const acoes = rs.map((r) => r.data?.acao ?? r.error?.message);
    assert.equal(acoes.filter((a) => a === "CRIADA").length, 1, JSON.stringify(acoes));
    assert.equal(acoes.filter((a) => a === "JA_EXISTIA").length, 29);
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 1);
  });

  test("CORRIDA scheduler NORMAL (RPC 088) × TARDIO (RPC 094): 15+15 simultâneas -> exatamente UMA mensagem wa:alerta:{id}:v1", async (t) => {
    if (!migracaoOk) return sk(t);
    const alerta = await novoAlerta();
    const rs = await Promise.all([...Array(15).fill(0).map(() => chamarNormal(alerta.id)), ...Array(15).fill(0).map(() => chamarTardio(alerta.id))]);
    const criadas = rs.filter((r) => r.data?.acao === "CRIADA");
    assert.equal(criadas.length, 1, JSON.stringify(rs.map((r) => r.data?.acao ?? r.error?.message)));
    const msgs = await mensagensDoAlerta(alerta.id);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].idempotency_key, chaveInicial(alerta.id));
  });

  test("empresa desabilitada / contato sem consentimento, não verificado ou com opt-out -> não cria nada", async (t) => {
    if (!migracaoOk) return sk(t);
    const alerta = await novoAlerta();
    await supabase.from("comunicacao_habilitacoes").update({ habilitado: false }).eq("organizacao_id", orgA);
    assert.equal((await chamarTardio(alerta.id)).data.acao, "NAO_HABILITADA");
    await habilitarOrganizacao(orgA, dest);
    for (const campos of [{ opt_out: true }, { consentimento: false }, { verificado: false }]) {
      await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false, ...campos }).eq("id", dest.contatoId);
      assert.equal((await chamarTardio(alerta.id)).data.acao, "DESTINATARIO_INELEGIVEL", JSON.stringify(campos));
    }
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("trigger: o aviso tardio é a INICIAL e continua dona de comunicacao_alertas.status", { skip: PULAR_INTEGRACAO }, () => {
  async function comTardio(dataReferencia) {
    const alerta = await novoAlerta(dataReferencia);
    const r = (await chamarTardio(alerta.id)).data;
    assert.equal(r.acao, "CRIADA");
    await atualizarMsg(r.mensagem_id, { status: SM.PROCESSING });
    return { alerta, id: r.mensagem_id };
  }
  test("SENT -> DELIVERED -> READ propagam ao alerta; FAILED também (não cai na guarda do reforço)", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta, id } = await comTardio();
    await atualizarMsg(id, { status: SM.SENT, enviado_em: QUA("20:10").toISOString() });
    assert.equal(await statusAlerta(alerta.id), SA.SENT);
    await atualizarMsg(id, { status: SM.DELIVERED });
    assert.equal(await statusAlerta(alerta.id), SA.DELIVERED);
    await atualizarMsg(id, { status: SM.READ });
    assert.equal(await statusAlerta(alerta.id), SA.READ);
    const b = await comTardio("2026-09-14");
    await atualizarMsg(b.id, { status: SM.FAILED });
    assert.equal(await statusAlerta(b.alerta.id), SA.FAILED);
  });
  test("EXPIRADA da inicial tardia reabre o alerta a DETECTED (semântica legada da inicial) e a mensagem NUNCA é recriada", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta, id } = await comTardio();
    await supabase.from("comunicacao_alertas").update({ status: SA.SCHEDULED }).eq("id", alerta.id);
    await atualizarMsg(id, { status: SM.CANCELLED, erro: "EXPIRADA" });
    assert.equal(await statusAlerta(alerta.id), SA.DETECTED);
    assert.equal((await chamarTardio(alerta.id)).data.acao, "MENSAGEM_EXPIRADA");
  });
});

// ---------------------------------------------------------------------------
describe("scheduler agendarAvisosTardiosD1 — contra o banco real", { skip: PULAR_INTEGRACAO }, () => {
  const rodar = (agora, extra = {}) => agendarAvisosTardiosD1({ organizacaoId: orgA, agora, ...extra });

  test("20:30 + D-1 de hoje -> cria 1 (expira 22:30, texto tardio); de novo e 10 concorrentes -> não duplica; restart às 21:15 idem", async (t) => {
    if (!migracaoOk) return sk(t);
    const alerta = await novoAlerta();
    const r1 = await rodar(AGORA);
    assert.equal(r1.agendados, 1, JSON.stringify(r1));
    assert.equal((await rodar(AGORA)).agendados, 0);
    const rs = await Promise.all(Array.from({ length: 10 }, () => rodar(AGORA)));
    assert.equal(rs.reduce((n, r) => n + r.agendados, 0), 0);
    assert.equal((await rodar(QUA("21:15"))).agendados, 0, "restart no meio da janela");
    const msgs = await mensagensDoAlerta(alerta.id);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].idempotency_key, chaveInicial(alerta.id));
    assert.deepEqual(msgs[0].metadados, { proposito: "inicial", origem: "prazo_final_d1" });
    assert.match(msgs[0].conteudo, /^Olá! Atenção: o lançamento da unidade Loja Tardio referente ao dia 15\/09\/2026 ainda consta pendente/);
    assert.equal(new Date(msgs[0].expira_em).toISOString(), QUA("22:30").toISOString());
    const d = new Date(msgs[0].disponivel_em);
    assert.ok(d >= AGORA && d < QUA("22:00"));
  });

  test("10 execuções concorrentes desde o início -> exatamente 1 mensagem", async (t) => {
    if (!migracaoOk) return sk(t);
    const alerta = await novoAlerta();
    const rs = await Promise.all(Array.from({ length: 10 }, () => rodar(AGORA)));
    assert.equal(rs.reduce((n, r) => n + r.agendados, 0), 1, JSON.stringify(rs));
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 1);
  });

  test("fora da janela (19:59, 22:00, 22:30, 18:30), domingo e backlog -> nada criado", async (t) => {
    if (!migracaoOk) return sk(t);
    const alerta = await novoAlerta();
    for (const hhmm of ["18:30", "19:59", "22:00", "22:30"]) assert.equal((await rodar(QUA(hhmm))).agendados, 0, hhmm);
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 0);
    await supabase.from("comunicacao_alertas").delete().eq("id", alerta.id);
    const dom = await novoAlerta("2026-09-19");
    assert.equal((await rodar(LOCAL(20, "20:30"))).agendados, 0, "domingo");
    const antigo = await novoAlerta("2026-09-10");
    const r = await rodar(AGORA);
    assert.equal(r.agendados, 0, JSON.stringify(r));
    assert.equal((await mensagensDoAlerta(antigo.id)).length + (await mensagensDoAlerta(dom.id)).length, 0);
  });

  test("NORMAL depois das 18:00 não agenda o D-1 de hoje para amanhã; a janela tardia é quem cria (exatamente 1 mensagem)", async (t) => {
    if (!migracaoOk) return sk(t);
    const alerta = await novoAlerta();
    const n = await agendarEnviosPendentes({ organizacaoId: orgA, agora: QUA("19:00"), resolverHabilitacao: HAB() });
    assert.equal(n.aguardaJanelaTardia, 1, JSON.stringify(n));
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 0);
    assert.equal((await rodar(AGORA)).agendados, 1);
    // depois disso o normal, se rodar de novo, não cria nada (alerta já SCHEDULED)
    const n2 = await agendarEnviosPendentes({ organizacaoId: orgA, agora: QUA("20:45"), resolverHabilitacao: HAB() });
    assert.equal(n2.agendados, 0);
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 1);
  });

  test("organização desabilitada (habilitação REAL) -> nada criado", async (t) => {
    if (!migracaoOk) return sk(t);
    const alerta = await novoAlerta();
    await supabase.from("comunicacao_habilitacoes").update({ habilitado: false }).eq("organizacao_id", orgA);
    const r = await rodar(AGORA);
    assert.equal(r.agendados, 0);
    assert.equal(r.semHabilitacao, 1);
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 0);
  });

  test("ZERO REFORÇO no mesmo dia: tardia enviada às 20:10 -> às 21:59 o espaçamento de 2h não vale; às 22:00 a janela fechou", async (t) => {
    if (!migracaoOk) return sk(t);
    const alerta = await novoAlerta();
    const { data } = await chamarTardio(alerta.id);
    await atualizarMsg(data.mensagem_id, { status: SM.PROCESSING });
    await atualizarMsg(data.mensagem_id, { status: SM.SENT, enviado_em: QUA("20:10").toISOString() });
    assert.equal(await statusAlerta(alerta.id), SA.SENT);
    const a = await agendarReforcosPendentes({ organizacaoId: orgA, agora: QUA("21:59"), resolverHabilitacao: HAB() });
    assert.equal(a.agendados, 0, JSON.stringify(a));
    assert.equal(a.espacamentoPendente, 1);
    const b = await agendarReforcosPendentes({ organizacaoId: orgA, agora: QUA("22:00"), resolverHabilitacao: HAB() });
    assert.equal(b.agendados, 0);
    assert.equal((await mensagensDoAlerta(alerta.id)).filter((m) => m.metadados?.proposito === "reforco").length, 0);
  });
});

// ---------------------------------------------------------------------------
describe("pipeline real do aviso tardio: claim -> JIT -> policy -> reserva -> provider", { skip: PULAR_INTEGRACAO }, () => {
  async function tardioPronto(dataReferencia) {
    const alerta = await novoAlerta(dataReferencia);
    const { data } = await chamarTardio(alerta.id);
    assert.equal(data.acao, "CRIADA");
    return { alerta, id: data.mensagem_id };
  }

  test("às 20:30 o aviso tardio é enviado UMA vez (sem janela comercial); SENT; o alerta SENT (inicial dona do status)", async (t) => {
    if (!migracaoOk) return sk(t);
    const p = await tardioPronto();
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const rs = await lote(whatsAppService);
    assert.equal(meu(rs, p.id)?.resultado, "ENVIADO", JSON.stringify(rs));
    assert.equal(chamadas.length, 1);
    assert.match(JSON.stringify(chamadas[0]), /aviso tardio de teste/);
    assert.equal((await linha(p.id)).status, SM.SENT);
    assert.equal(await statusAlerta(p.alerta.id), SA.SENT);
  });

  test("com o piloto ativo e o destinatário NA allowlist -> enviado; com OUTRO número na allowlist -> BLOQUEADO, provider 0", async (t) => {
    if (!migracaoOk) return sk(t);
    process.env.COMUNICACAO_PILOTO_ENABLED = "true";
    process.env.COMUNICACAO_PILOTO_TELEFONES_E164 = "+5500000000000";
    const p = await tardioPronto();
    const a = criarProviderComSpy();
    const r = meu(await lote(a.whatsAppService), p.id);
    assert.equal(r?.resultado, "BLOQUEADO", JSON.stringify(r));
    assert.equal(a.chamadas.length, 0);
    assert.equal(await statusAlerta(p.alerta.id), SA.BLOCKED);
    await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
    await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", orgA);
    process.env.COMUNICACAO_PILOTO_TELEFONES_E164 = telefone;
    const q = await tardioPronto();
    const b = criarProviderComSpy();
    assert.equal(meu(await lote(b.whatsAppService), q.id)?.resultado, "ENVIADO");
    assert.equal(b.chamadas.length, 1);
  });

  test("piloto ativo com allowlist vazia/malformada -> BLOQUEADO, provider 0 (fail-closed)", async (t) => {
    if (!migracaoOk) return sk(t);
    process.env.COMUNICACAO_PILOTO_ENABLED = "true";
    for (const lista of [undefined, "abc", `${telefone},lixo`]) {
      await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
      await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", orgA);
      if (lista === undefined) delete process.env.COMUNICACAO_PILOTO_TELEFONES_E164; else process.env.COMUNICACAO_PILOTO_TELEFONES_E164 = lista;
      const p = await tardioPronto();
      const { chamadas, whatsAppService } = criarProviderComSpy();
      const r = meu(await lote(whatsAppService), p.id);
      assert.equal(r?.resultado, "BLOQUEADO", `${lista}: ${JSON.stringify(r)}`);
      assert.equal(chamadas.length, 0);
    }
  });

  test("JIT RESOLVIDO: cliente lança o Dashboard antes do provider -> CANCELADO_PENDENCIA_RESOLVIDA, provider 0, alerta RESOLVED", async (t) => {
    if (!migracaoOk) return sk(t);
    const p = await tardioPronto();
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const rs = await lote(whatsAppService, { verificarPendenciaAindaExiste: async () => false });
    assert.equal(meu(rs, p.id)?.resultado, "CANCELADO_PENDENCIA_RESOLVIDA");
    assert.equal(chamadas.length, 0);
    assert.equal((await linha(p.id)).status, SM.CANCELLED);
    assert.equal(await statusAlerta(p.alerta.id), SA.RESOLVED);
  });

  test("JIT: fora da janela tardia (18:30, 19:30, 22:00, cutoff 22:31), domingo e backlog -> CANCELLED/EXPIRADA, provider 0, nunca amanhã", async (t) => {
    if (!migracaoOk) return sk(t);
    const casos = [
      ...["18:30", "19:30", "22:00", "22:31"].map((hhmm) => ({ agora: QUA(hhmm), data: "2026-09-15", motivo: "TARDIO_FORA_DA_JANELA", rotulo: hhmm })),
      { agora: LOCAL(20, "20:30"), data: "2026-09-19", motivo: "TARDIO_FORA_DA_JANELA", rotulo: "domingo" },
      { agora: AGORA, data: "2026-09-10", motivo: "TARDIO_PRAZO_NAO_E_HOJE", rotulo: "backlog" },
      { agora: LOCAL(17, "20:30"), data: "2026-09-15", motivo: "TARDIO_PRAZO_NAO_E_HOJE", rotulo: "no dia seguinte" },
    ];
    for (const c of casos) {
      await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
      await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", orgA);
      const p = await tardioPronto(c.data);
      const { chamadas, whatsAppService } = criarProviderComSpy();
      const r = meu(await lote(whatsAppService, { agora: c.agora }), p.id);
      assert.equal(r?.resultado, "CANCELADO_AVISO_TARDIO_FORA_DE_CONDICAO", `${c.rotulo}: ${JSON.stringify(r)}`);
      assert.equal(r.motivo, c.motivo, c.rotulo);
      assert.equal(chamadas.length, 0, c.rotulo);
      const m = await linha(p.id);
      assert.equal(m.status, SM.CANCELLED);
      assert.equal(m.erro, "EXPIRADA");
    }
  });

  test("opt-out / sem consentimento / não verificado -> BLOQUEADO, provider 0; empresa desabilitada no JIT -> BLOQUEADO", async (t) => {
    if (!migracaoOk) return sk(t);
    for (const campos of [{ opt_out: true }, { consentimento: false }, { verificado: false }]) {
      await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
      await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", orgA);
      await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).eq("id", dest.contatoId);
      const p = await tardioPronto();
      await supabase.from("contatos_whatsapp").update(campos).eq("id", dest.contatoId);
      const { chamadas, whatsAppService } = criarProviderComSpy();
      const r = meu(await lote(whatsAppService), p.id);
      assert.equal(r?.resultado, "BLOQUEADO", `${JSON.stringify(campos)} ${JSON.stringify(r)}`);
      assert.equal(chamadas.length, 0);
      assert.equal(await statusAlerta(p.alerta.id), SA.BLOCKED, "a inicial dona do status: veto vira BLOCKED");
    }
    await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
    await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", orgA);
    await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).eq("id", dest.contatoId);
    const p = await tardioPronto();
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const r = meu(await lote(whatsAppService, { resolverHabilitacao: HAB({ empresaHabilitada: false }) }), p.id);
    assert.equal(r?.resultado, "BLOQUEADO", JSON.stringify(r));
    assert.equal(r.motivo, "EMPRESA_DESABILITADA");
    assert.equal(chamadas.length, 0);
  });

  test("RATE-LIMIT soberano: contato já no limite diário (1/1) -> aviso tardio ADIADO, provider 0", async (t) => {
    if (!migracaoOk) return sk(t);
    await definirLimites({ ...LIMITES, max_por_contato_por_dia: 1 });
    const outro = await novoAlerta("2026-09-14");
    await inserirMensagem({ alertaId: outro.id, status: SM.SENT, idempotencyKey: chaveInicial(outro.id), enviadoEm: QUA("15:00").toISOString() });
    const p = await tardioPronto("2026-09-15");
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const r = meu(await lote(whatsAppService), p.id);
    assert.equal(r?.resultado, "ADIADO", JSON.stringify(r));
    assert.equal(chamadas.length, 0);
  });

  test("dois workers concorrentes sobre o mesmo aviso tardio -> o provider é chamado no máximo UMA vez", async (t) => {
    if (!migracaoOk) return sk(t);
    const p = await tardioPronto();
    const { chamadas, whatsAppService } = criarProviderComSpy();
    await Promise.all([lote(whatsAppService, { worker: "w1" }), lote(whatsAppService, { worker: "w2" })]);
    assert.equal(chamadas.length, 1);
    assert.equal((await linha(p.id)).status, SM.SENT);
  });
});
