// Reforço de PRAZO FINAL D-1 — INTEGRAÇÃO contra o Supabase de TESTE (migration 092 aplicada): a RPC
// comunicacao_agendar_reforco_alerta, o TRIGGER corrigido (reforço não propaga status ao alerta),
// concorrência/idempotência e o PIPELINE REAL (claim -> JIT do reforço -> policy -> reservar_envio ->
// gateway -> FakeProvider): pendência resolvida, gates de janela/dia/D-1/espaçamento, rate-limit,
// DUPLICATE por propósito, contato/empresa.
// PULA (não falha) sem credencial de banco descartável / sem migrations 082-088-092.
// Rodar: node --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-reforco-integracao.test.js
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, criarDestinatario, apagarDestinatario, habilitarOrganizacao,
  migracao082Aplicada, migracao088Aplicada, migracao092Aplicada,
} from "./helpers/comunicacao-fixtures.js";
import * as alertasRepo from "../src/modules/comunicacao/comunicacao.alertas.repo.js";
import { processarProximoLote, agendarReforcosPendentes } from "../src/modules/comunicacao/comunicacao.alertas.service.js";
import { definirModo, modoAtual } from "../src/modules/comunicacao/comunicacao.config.js";
import { criarWhatsAppService } from "../src/modules/comunicacao/whatsapp.service.js";
import { criarFakeProvider } from "../src/modules/comunicacao/providers/fake.provider.js";
import { MODOS, TIPOS_ALERTA, SEVERIDADE, STATUS_ALERTA as SA, STATUS_MENSAGEM as SM } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
const TIPO = TIPOS_ALERTA.DASHBOARD_IFOOD_D1;
const tag = `comreforco${Date.now()}`;

// Horário LOCAL (Fortaleza = UTC-3, sem DST) de setembro/2026 -> instante UTC. Quarta 16, quinta 17, sábado 19, domingo 20.
const LOCAL = (dia, hhmm) => new Date(Date.UTC(2026, 8, dia, Number(hhmm.slice(0, 2)) + 3, Number(hhmm.slice(3))));
const QUA = (hhmm) => LOCAL(16, hhmm);
const AGORA = QUA("20:30");                       // dentro da janela do reforço (20:00–22:00)
const ENVIO_INICIAL = QUA("17:00").toISOString(); // 1ª mensagem enviada 3h30 antes (cooldown NORMAL de 8h ainda estaria ativo)

let migracaoOk = true;
let modoOriginal = null, limitesOriginais = null;
let orgA = null, unidadeA = null, dest = null;

const definirLimites = (l) => supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: l }, { onConflict: "chave" });
const LIMITES = { max_proativas_por_minuto: 1000, max_proativas_por_minuto_por_organizacao: 1000, max_por_contato_por_dia: 3 };

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada()) && (await migracao092Aplicada());
  if (!migracaoOk) return;
  modoOriginal = await modoAtual();
  limitesOriginais = (await supabase.from("comunicacao_configuracoes").select("valor").eq("chave", "limites").maybeSingle()).data?.valor ?? null;
  orgA = await criarOrganizacao("TESTE reforco — descartável");
  unidadeA = await criarUnidade(orgA, "Unidade Reforço A1");
  dest = await criarDestinatario({ organizacaoId: orgA, unidadeId: unidadeA, tag });
  await habilitarOrganizacao(orgA, dest);
});

after(async () => {
  if (modoOriginal) await definirModo(modoOriginal, {}).catch(() => {});
  if (limitesOriginais) await definirLimites(limitesOriginais);
  await apagarOrganizacao(orgA);
  await apagarDestinatario(dest);
});

beforeEach(async () => {
  if (PULAR_INTEGRACAO || !migracaoOk) return;
  await definirLimites(LIMITES);
  await definirModo(MODOS.NORMAL, {});
  await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
  await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", orgA);
  await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).eq("id", dest.contatoId);
  await habilitarOrganizacao(orgA, dest);
});

const chaveInicial = (id) => `wa:alerta:${id}:v1`;
const chaveReforco = (id) => `wa:alerta:${id}:reforco:v1`;
const linha = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("id", id).single()).data;
const statusAlerta = async (id) => (await supabase.from("comunicacao_alertas").select("status").eq("id", id).single()).data.status;
const mensagensDoAlerta = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("alerta_id", id)).data;
const atualizarMsg = (id, campos) => supabase.from("comunicacao_mensagens").update(campos).eq("id", id);

async function novoAlerta(dataReferencia = "2026-09-15") {
  const { alerta } = await alertasRepo.criarOuEscalonarAlerta({
    organizacaoId: orgA, unidadeId: unidadeA, tipoAlerta: TIPO, dataReferencia, destinatarioPerfilId: null,
    severidade: SEVERIDADE.ATENCAO, motivo: "1 dia(s) pendente(s)", metadados: { unidade_nome: "Loja Reforço" },
  });
  return alerta;
}

async function inserirMensagem({ alertaId, status, idempotencyKey, proposito = null, enviadoEm = null, extra = {} }) {
  const { data, error } = await supabase.from("comunicacao_mensagens").insert({
    alerta_id: alertaId, organizacao_id: orgA, unidade_id: unidadeA, contato_id: dest.contatoId,
    destinatario_perfil_id: dest.perfilId, canal: "whatsapp", direcao: "saida", tipo: TIPO,
    conteudo: "aviso de teste", idempotency_key: idempotencyKey, status,
    metadados: proposito ? { proposito } : {}, disponivel_em: new Date(Date.now() - 60_000).toISOString(),
    ...(enviadoEm ? { enviado_em: enviadoEm } : {}), ...extra,
  }).select("*").single();
  if (error) throw new Error(`fixture: ${error.message}`);
  return data;
}

/** Alerta cujo 1º aviso JÁ saiu (mensagem inicial SENT + alerta SENT) — o pré-requisito do reforço. */
async function alertaComPrimeiroEnviado({ enviadoEm = ENVIO_INICIAL, dataReferencia } = {}) {
  const alerta = await novoAlerta(dataReferencia);
  const inicial = await inserirMensagem({ alertaId: alerta.id, status: SM.SENT, idempotencyKey: chaveInicial(alerta.id), enviadoEm });
  await alertasRepo.atualizarStatusAlerta(alerta.id, SA.SENT);
  return { alerta, inicial };
}

const chamarReforco = (alertaId, { chave, disponivelEm = new Date(Date.now() - 60_000), expiraEm = null } = {}) =>
  supabase.rpc("comunicacao_agendar_reforco_alerta", {
    p_alerta_id: alertaId, p_conteudo: "reforço de teste", p_idempotency_key: chave ?? chaveReforco(alertaId),
    p_disponivel_em: disponivelEm.toISOString(), p_expira_em: expiraEm ? expiraEm.toISOString() : null, p_max_tentativas: 5,
  });

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
  limite: 20, worker: "teste-reforco", whatsAppService, agora: AGORA,
  verificarPendenciaAindaExiste: async () => true, resolverHabilitacao: HAB(), ...extra,
});
const sk = (t) => t.skip(PULAR_INTEGRACAO || "migrations 082/088/092 ainda não aplicadas — pulando.");

// ---------------------------------------------------------------------------
describe("RPC comunicacao_agendar_reforco_alerta (092)", { skip: PULAR_INTEGRACAO }, () => {
  test("alerta inexistente -> ALERTA_INEXISTENTE", async (t) => {
    if (!migracaoOk) return sk(t);
    assert.equal((await chamarReforco("00000000-0000-0000-0000-000000000000", { chave: "x" })).data.acao, "ALERTA_INEXISTENTE");
  });

  test("chave que não é a do reforço do alerta -> CHAVE_INVALIDA (impossível criar um 2º reforço com outra chave)", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado();
    assert.equal((await chamarReforco(alerta.id, { chave: `wa:alerta:${alerta.id}:reforco:v2` })).data.acao, "CHAVE_INVALIDA");
    assert.equal((await chamarReforco(alerta.id, { chave: chaveInicial(alerta.id) })).data.acao, "CHAVE_INVALIDA");
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 1, "nada criado além da inicial");
  });

  test("alerta que NÃO chegou ao 1º envio (DETECTED/SCHEDULED/BLOCKED/FAILED/RESOLVED) -> ALERTA_SEM_PRIMEIRO_ENVIO", async (t) => {
    if (!migracaoOk) return sk(t);
    const alerta = await novoAlerta();
    assert.equal((await chamarReforco(alerta.id)).data.acao, "ALERTA_SEM_PRIMEIRO_ENVIO");
    for (const s of [SA.SCHEDULED, SA.BLOCKED, SA.FAILED, SA.RESOLVED]) {
      await supabase.from("comunicacao_alertas").update({ status: s }).eq("id", alerta.id);
      assert.equal((await chamarReforco(alerta.id)).data.acao, "ALERTA_SEM_PRIMEIRO_ENVIO", s);
    }
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 0);
  });

  test("alerta SENT mas a 1ª mensagem não existe / DELIVERY_UNKNOWN -> nunca CRIADA", async (t) => {
    if (!migracaoOk) return sk(t);
    const alerta = await novoAlerta();
    await supabase.from("comunicacao_alertas").update({ status: SA.SENT }).eq("id", alerta.id);
    assert.equal((await chamarReforco(alerta.id)).data.acao, "PRIMEIRA_MENSAGEM_NAO_ENVIADA");
    await inserirMensagem({ alertaId: alerta.id, status: SM.DELIVERY_UNKNOWN, idempotencyKey: chaveInicial(alerta.id) });
    assert.notEqual((await chamarReforco(alerta.id)).data.acao, "CRIADA");
  });

  test("1ª mensagem enviada -> CRIADA: SCHEDULED, proposito=reforco, tipo do alerta, destinatário da habilitação; alerta continua SENT", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado();
    const { data, error } = await chamarReforco(alerta.id);
    assert.equal(error, null);
    assert.equal(data.acao, "CRIADA");
    const m = await linha(data.mensagem_id);
    assert.equal(m.status, SM.SCHEDULED);
    assert.equal(m.idempotency_key, chaveReforco(alerta.id));
    assert.equal(m.metadados.proposito, "reforco");
    assert.equal(m.tipo, TIPO);
    assert.equal(m.contato_id, dest.contatoId);
    assert.equal(m.destinatario_perfil_id, dest.perfilId);
    assert.equal(await statusAlerta(alerta.id), SA.SENT);
  });

  test("a RPC NORMAL (088) continua intacta: alerta já SENT -> nunca cria outra mensagem inicial", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado();
    const { data } = await supabase.rpc("comunicacao_agendar_mensagem_alerta", {
      p_alerta_id: alerta.id, p_tipo: TIPO, p_conteudo: "x", p_idempotency_key: `wa:alerta:${alerta.id}:v9`,
      p_disponivel_em: new Date().toISOString(), p_expira_em: null, p_max_tentativas: 5,
    });
    assert.notEqual(data.acao, "CRIADA");
  });

  test("segunda chamada (retry/restart) -> JA_EXISTIA, nenhuma linha nova", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado();
    const r1 = (await chamarReforco(alerta.id)).data, r2 = (await chamarReforco(alerta.id)).data;
    assert.equal(r1.acao, "CRIADA");
    assert.equal(r2.acao, "JA_EXISTIA");
    assert.equal(r2.mensagem_id, r1.mensagem_id);
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 2);
  });

  test("30 chamadas CONCORRENTES -> exatamente 1 CRIADA, 29 JA_EXISTIA, 1 única linha de reforço", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado();
    const rs = await Promise.all(Array.from({ length: 30 }, () => chamarReforco(alerta.id)));
    const acoes = rs.map((r) => r.data?.acao);
    assert.equal(acoes.filter((a) => a === "CRIADA").length, 1, JSON.stringify(rs.map((r) => r.error?.message ?? r.data?.acao)));
    assert.equal(acoes.filter((a) => a === "JA_EXISTIA").length, 29);
    assert.equal((await mensagensDoAlerta(alerta.id)).filter((m) => m.metadados?.proposito === "reforco").length, 1);
  });

  test("entrega em curso do alerta (PROCESSING/SENDING/DELIVERY_UNKNOWN) -> ENTREGA_EM_CURSO", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado();
    const outra = await inserirMensagem({ alertaId: alerta.id, status: SM.PROCESSING, idempotencyKey: `wa:alerta:${alerta.id}:outra`, proposito: "reforco" });
    assert.equal((await chamarReforco(alerta.id)).data.acao, "ENTREGA_EM_CURSO");
    await supabase.from("comunicacao_mensagens").delete().eq("id", outra.id);
  });

  test("empresa desabilitada / tipo não permitido / sem destinatário / contato inelegível -> não cria (mesmas regras da 088)", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado();
    await supabase.from("comunicacao_habilitacoes").update({ habilitado: false }).eq("organizacao_id", orgA);
    assert.equal((await chamarReforco(alerta.id)).data.acao, "NAO_HABILITADA");
    await habilitarOrganizacao(orgA, dest, { tipos_permitidos: ["outro_tipo"] });
    assert.equal((await chamarReforco(alerta.id)).data.acao, "TIPO_NAO_PERMITIDO");
    await habilitarOrganizacao(orgA, dest);
    for (const campos of [{ opt_out: true }, { consentimento: false }, { verificado: false }]) {
      await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false, ...campos }).eq("id", dest.contatoId);
      assert.equal((await chamarReforco(alerta.id)).data.acao, "DESTINATARIO_INELEGIVEL", JSON.stringify(campos));
    }
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 1, "nenhum reforço foi criado");
  });
});

// ---------------------------------------------------------------------------
describe("trigger da 088 corrigido pela 092: reforço NÃO sobrescreve comunicacao_alertas.status", { skip: PULAR_INTEGRACAO }, () => {
  /** alerta com inicial (SENT) + reforço PROCESSING (proposito=reforco); `statusAlertaInicial` força o status agregado. */
  async function cenario(statusAlertaInicial = SA.SENT) {
    const { alerta, inicial } = await alertaComPrimeiroEnviado();
    const reforco = await inserirMensagem({ alertaId: alerta.id, status: SM.PROCESSING, idempotencyKey: chaveReforco(alerta.id), proposito: "reforco" });
    await supabase.from("comunicacao_alertas").update({ status: statusAlertaInicial }).eq("id", alerta.id);
    return { alerta, inicial, reforco };
  }

  test("A) inicial READ + reforço SENT -> alerta continua READ (não regride)", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta, reforco } = await cenario(SA.READ);
    await atualizarMsg(reforco.id, { status: SM.SENT, enviado_em: new Date().toISOString() });
    assert.equal(await statusAlerta(alerta.id), SA.READ);
  });
  test("B) inicial SENT + reforço DELIVERED -> alerta continua SENT", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta, reforco } = await cenario();
    await atualizarMsg(reforco.id, { status: SM.DELIVERED });
    assert.equal(await statusAlerta(alerta.id), SA.SENT);
  });
  test("C) inicial SENT + reforço FAILED -> alerta continua SENT", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta, reforco } = await cenario();
    await atualizarMsg(reforco.id, { status: SM.FAILED });
    assert.equal(await statusAlerta(alerta.id), SA.SENT);
  });
  test("D) reforço EXPIRADA -> alerta NÃO volta a DETECTED (nem estando SCHEDULED/PROCESSING)", async (t) => {
    if (!migracaoOk) return sk(t);
    for (const s of [SA.SENT, SA.SCHEDULED, SA.PROCESSING]) {
      await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
      await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", orgA);
      const { alerta, reforco } = await cenario(s);
      await atualizarMsg(reforco.id, { status: SM.CANCELLED, erro: "EXPIRADA" });
      assert.equal(await statusAlerta(alerta.id), s, s);
    }
  });
  test("E) reforço BLOCKED -> não altera o alerta", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta, reforco } = await cenario();
    await atualizarMsg(reforco.id, { status: SM.BLOCKED, erro: "RATE_LIMIT_DIA" });
    assert.equal(await statusAlerta(alerta.id), SA.SENT);
  });
  test("F) inicial SENT -> DELIVERED -> alerta DELIVERED (semântica legada preservada)", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta, inicial } = await cenario();
    await atualizarMsg(inicial.id, { status: SM.DELIVERED });
    assert.equal(await statusAlerta(alerta.id), SA.DELIVERED);
  });
  test("G) inicial DELIVERED -> READ -> alerta READ (semântica legada preservada)", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta, inicial } = await cenario();
    await atualizarMsg(inicial.id, { status: SM.DELIVERED });
    await atualizarMsg(inicial.id, { status: SM.READ });
    assert.equal(await statusAlerta(alerta.id), SA.READ);
  });
  test("legado da inicial intacto: FAILED -> alerta FAILED; EXPIRADA com alerta SCHEDULED -> DETECTED", async (t) => {
    if (!migracaoOk) return sk(t);
    const a = await cenario();
    await atualizarMsg(a.inicial.id, { status: SM.FAILED });
    assert.equal(await statusAlerta(a.alerta.id), SA.FAILED);
    const alerta2 = await novoAlerta("2026-09-14");
    const m2 = await inserirMensagem({ alertaId: alerta2.id, status: SM.SCHEDULED, idempotencyKey: chaveInicial(alerta2.id) });
    await supabase.from("comunicacao_alertas").update({ status: SA.SCHEDULED }).eq("id", alerta2.id);
    await atualizarMsg(m2.id, { status: SM.CANCELLED, erro: "EXPIRADA" });
    assert.equal(await statusAlerta(alerta2.id), SA.DETECTED);
  });
  test("RESOLVED continua possível: reforço SCHEDULED + resolverAlerta -> RESOLVED, e um SENT tardio do reforço não o reabre", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta, reforco } = await cenario();
    await atualizarMsg(reforco.id, { status: SM.SCHEDULED });
    await alertasRepo.resolverAlerta(alerta.id);
    assert.equal(await statusAlerta(alerta.id), SA.RESOLVED);
    await atualizarMsg(reforco.id, { status: SM.SENT, enviado_em: new Date().toISOString() });
    assert.equal(await statusAlerta(alerta.id), SA.RESOLVED);
  });
});

// ---------------------------------------------------------------------------
describe("scheduler agendarReforcosPendentes — contra o banco real (Política B)", { skip: PULAR_INTEGRACAO }, () => {
  const rodar = (agora, extra = {}) => agendarReforcosPendentes({ organizacaoId: orgA, agora, ...extra });

  test("20:30 + D-1 de hoje + 1ª há 3h30 -> cria 1 (expira 22:30 locais); de novo e 10 concorrentes -> não duplica", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado();
    const r1 = await rodar(AGORA);
    assert.equal(r1.agendados, 1, JSON.stringify(r1));
    const r2 = await rodar(AGORA);
    assert.equal(r2.agendados, 0);
    assert.equal(r2.jaExistiam, 1);
    const rs = await Promise.all(Array.from({ length: 10 }, () => rodar(AGORA)));
    assert.equal(rs.reduce((n, r) => n + r.agendados, 0), 0);
    const reforcos = (await mensagensDoAlerta(alerta.id)).filter((m) => m.metadados?.proposito === "reforco");
    assert.equal(reforcos.length, 1);
    assert.equal(reforcos[0].idempotency_key, chaveReforco(alerta.id));
    assert.match(reforcos[0].conteudo, /^Último lembrete de hoje/);
    assert.equal(new Date(reforcos[0].expira_em).toISOString(), QUA("22:30").toISOString(), "expira às 22:30 locais");
    const d = new Date(reforcos[0].disponivel_em);
    assert.ok(d >= AGORA && d < QUA("22:00"), "horário dentro da janela 20:00–22:00");
  });

  test("10 execuções concorrentes desde o início -> exatamente 1 reforço", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado();
    const rs = await Promise.all(Array.from({ length: 10 }, () => rodar(AGORA)));
    assert.equal(rs.reduce((n, r) => n + r.agendados, 0), 1, JSON.stringify(rs));
    assert.equal((await mensagensDoAlerta(alerta.id)).filter((m) => m.metadados?.proposito === "reforco").length, 1);
  });

  test("RESTART no meio da janela (20:30 -> 21:15): o reforço existente não é duplicado", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado();
    assert.equal((await rodar(AGORA)).agendados, 1);
    const depois = await rodar(QUA("21:15"));
    assert.equal(depois.agendados, 0);
    assert.equal(depois.jaExistiam, 1);
    assert.equal((await mensagensDoAlerta(alerta.id)).filter((m) => m.metadados?.proposito === "reforco").length, 1);
  });

  test("fora da janela (16:30 comercial, 19:59, 22:00, 22:30) -> nada criado", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado();
    for (const hhmm of ["16:30", "19:59", "22:00", "22:30"]) assert.equal((await rodar(QUA(hhmm))).agendados, 0, hhmm);
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 1);
  });

  test("domingo -> nada criado", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado({ enviadoEm: LOCAL(20, "17:00").toISOString(), dataReferencia: "2026-09-19" });
    assert.equal((await rodar(LOCAL(20, "20:30"))).agendados, 0);
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 1);
  });

  test("backlog antigo (D-6) -> nada criado (só o D-1 que vence hoje)", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado({ dataReferencia: "2026-09-10" });
    const r = await rodar(AGORA);
    assert.equal(r.agendados, 0);
    assert.equal(r.foraDoPrazoD1, 1);
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 1);
  });

  test("espaçamento < 2h desde a inicial -> nada criado", async (t) => {
    if (!migracaoOk) return sk(t);
    await alertaComPrimeiroEnviado({ enviadoEm: QUA("19:00").toISOString() });
    const r = await rodar(AGORA);
    assert.equal(r.agendados, 0);
    assert.equal(r.espacamentoPendente, 1);
  });

  test("organização desabilitada (habilitação REAL) -> nada criado", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado();
    await supabase.from("comunicacao_habilitacoes").update({ habilitado: false }).eq("organizacao_id", orgA);
    const r = await rodar(AGORA);
    assert.equal(r.agendados, 0);
    assert.equal(r.semHabilitacao, 1);
    assert.equal((await mensagensDoAlerta(alerta.id)).length, 1);
  });
});

// ---------------------------------------------------------------------------
describe("pipeline real do reforço: claim -> JIT -> policy -> reserva -> provider", { skip: PULAR_INTEGRACAO }, () => {
  async function alertaComReforcoPronto(opts = {}) {
    const par = await alertaComPrimeiroEnviado(opts);
    const { data } = await chamarReforco(par.alerta.id);
    assert.equal(data.acao, "CRIADA");
    return { ...par, reforcoId: data.mensagem_id };
  }
  const meu = (rs, id) => rs.find((r) => r.id === id);

  test("REFORÇO é enviado UMA vez às 20:30 (inicial já SENT não o torna DUPLICATE; cooldown normal 8h NÃO o bloqueia); alerta e inicial intactos", async (t) => {
    if (!migracaoOk) return sk(t);
    const p = await alertaComReforcoPronto();
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const rs = await lote(whatsAppService);
    assert.equal(meu(rs, p.reforcoId)?.resultado, "ENVIADO", JSON.stringify(rs));
    assert.equal(chamadas.length, 1);
    assert.match(JSON.stringify(chamadas[0]), /reforço de teste/, "o provider recebe o conteúdo persistido do reforço");
    const m = await linha(p.reforcoId);
    assert.equal(m.status, SM.SENT);
    assert.equal(m.metadados.proposito, "reforco");
    assert.equal((await linha(p.inicial.id)).status, SM.SENT);
    assert.equal(await statusAlerta(p.alerta.id), SA.SENT, "o reforço enviado não mexe no alerta (trigger corrigido)");
  });

  test("JIT RESOLVIDO: reforço SCHEDULED + cliente lança o Dashboard -> CANCELADO_PENDENCIA_RESOLVIDA, provider 0, alerta RESOLVED", async (t) => {
    if (!migracaoOk) return sk(t);
    const p = await alertaComReforcoPronto();
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const rs = await lote(whatsAppService, { verificarPendenciaAindaExiste: async () => false });
    assert.equal(meu(rs, p.reforcoId)?.resultado, "CANCELADO_PENDENCIA_RESOLVIDA");
    assert.equal(chamadas.length, 0);
    assert.equal((await linha(p.reforcoId)).status, SM.CANCELLED);
    assert.equal(await statusAlerta(p.alerta.id), SA.RESOLVED);
  });

  test("JIT: fora da janela do reforço (16:30 comercial, 19:30, 22:00, cutoff 22:31) -> cancelado TERMINAL, provider 0", async (t) => {
    if (!migracaoOk) return sk(t);
    for (const hhmm of ["16:30", "19:30", "22:00", "22:31"]) {
      await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
      await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", orgA);
      const p = await alertaComReforcoPronto();
      const { chamadas, whatsAppService } = criarProviderComSpy();
      const r = meu(await lote(whatsAppService, { agora: QUA(hhmm) }), p.reforcoId);
      assert.equal(r?.resultado, "CANCELADO_REFORCO_FORA_DE_CONDICAO", `${hhmm}: ${JSON.stringify(r)}`);
      assert.equal(r.motivo, "REFORCO_FORA_DA_JANELA");
      assert.equal(chamadas.length, 0, hhmm);
      assert.equal((await linha(p.reforcoId)).status, SM.CANCELLED);
    }
  });

  test("JIT: domingo -> cancelado, provider 0", async (t) => {
    if (!migracaoOk) return sk(t);
    const p = await alertaComReforcoPronto({ enviadoEm: LOCAL(20, "17:00").toISOString(), dataReferencia: "2026-09-19" });
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const r = meu(await lote(whatsAppService, { agora: LOCAL(20, "20:30") }), p.reforcoId);
    assert.equal(r?.resultado, "CANCELADO_REFORCO_FORA_DE_CONDICAO", JSON.stringify(r));
    assert.equal(r.motivo, "REFORCO_FORA_DA_JANELA");
    assert.equal(chamadas.length, 0);
  });

  test("JIT: prazo não é hoje (backlog D-6 / o dia seguinte) -> cancelado, nunca vira cobrança de outro dia", async (t) => {
    if (!migracaoOk) return sk(t);
    const p = await alertaComReforcoPronto({ dataReferencia: "2026-09-10" });
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const r = meu(await lote(whatsAppService), p.reforcoId);
    assert.equal(r?.resultado, "CANCELADO_REFORCO_FORA_DE_CONDICAO", JSON.stringify(r));
    assert.equal(r.motivo, "REFORCO_PRAZO_NAO_E_HOJE");
    const q = await alertaComReforcoPronto({ dataReferencia: "2026-09-15" }); // mesma mensagem 'amanhã': quinta 20:30 -> o prazo era ontem
    const r2 = meu(await lote(whatsAppService, { agora: LOCAL(17, "20:30") }), q.reforcoId);
    assert.equal(r2?.motivo, "REFORCO_PRAZO_NAO_E_HOJE", JSON.stringify(r2));
    assert.equal(chamadas.length, 0);
  });

  test("JIT: 1ª mensagem de outro dia / espaçamento < 2h -> cancelado, provider 0", async (t) => {
    if (!migracaoOk) return sk(t);
    const casos = [
      [{ enviadoEm: QUA("17:00").toISOString().replace("2026-09-16", "2026-09-15") }, "REFORCO_PRIMEIRA_NAO_ENVIADA"],
      [{ enviadoEm: QUA("19:00").toISOString() }, "REFORCO_ESPACAMENTO_INSUFICIENTE"],
    ];
    for (const [opts, motivo] of casos) {
      await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
      await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", orgA);
      const p = await alertaComReforcoPronto(opts);
      const { chamadas, whatsAppService } = criarProviderComSpy();
      const r = meu(await lote(whatsAppService), p.reforcoId);
      assert.equal(r?.resultado, "CANCELADO_REFORCO_FORA_DE_CONDICAO", JSON.stringify(r));
      assert.equal(r.motivo, motivo);
      assert.equal(chamadas.length, 0);
    }
  });

  test("RATE-LIMIT diário soberano: max_por_contato_por_dia=1 e a 1ª já contou -> reforço ADIADO, provider 0 (o cooldown null não é bypass)", async (t) => {
    if (!migracaoOk) return sk(t);
    await definirLimites({ ...LIMITES, max_por_contato_por_dia: 1 });
    const p = await alertaComReforcoPronto();
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const r = meu(await lote(whatsAppService), p.reforcoId);
    assert.equal(r?.resultado, "ADIADO", JSON.stringify(r));
    assert.equal(chamadas.length, 0);
    // o adiamento (para outro dia) nunca vira envio: no dia seguinte o JIT cancela (prazo não é mais hoje)
    // o banco sempre adia no MÍNIMO para now()+1min (relógio real); a linha é antecipada só para o teste poder reivindicá-la de novo.
    await atualizarMsg(p.reforcoId, { disponivel_em: new Date(Date.now() - 60_000).toISOString(), claimed_by: null, claim_expira_em: null });
    const rsAmanha = await lote(whatsAppService, { agora: LOCAL(17, "20:30") });
    const amanha = meu(rsAmanha, p.reforcoId);
    assert.equal(amanha?.resultado, "CANCELADO_REFORCO_FORA_DE_CONDICAO", JSON.stringify(amanha));
    assert.equal(chamadas.length, 0);
  });

  test("segunda mensagem INICIAL do mesmo alerta (1ª já SENT) continua BLOQUEADA como DUPLICATE", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado();
    const segunda = await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, idempotencyKey: `wa:alerta:${alerta.id}:v-dup` });
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const r = meu(await lote(whatsAppService), segunda.id);
    assert.equal(r?.resultado, "BLOQUEADO", JSON.stringify(r));
    assert.equal(r.motivo, "DUPLICATE");
    assert.equal(chamadas.length, 0);
  });

  test("SEGUNDO reforço (1º reforço já SENT) continua BLOQUEADO como DUPLICATE", async (t) => {
    if (!migracaoOk) return sk(t);
    const { alerta } = await alertaComPrimeiroEnviado();
    await inserirMensagem({ alertaId: alerta.id, status: SM.SENT, idempotencyKey: chaveReforco(alerta.id), proposito: "reforco", enviadoEm: QUA("20:10").toISOString() });
    const segundo = await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, idempotencyKey: `wa:alerta:${alerta.id}:reforco:v-dup`, proposito: "reforco" });
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const r = meu(await lote(whatsAppService), segundo.id);
    assert.equal(r?.resultado, "BLOQUEADO", JSON.stringify(r));
    assert.equal(r.motivo, "DUPLICATE");
    assert.equal(chamadas.length, 0);
  });

  test("veto do reforço (contato com opt-out) -> BLOQUEADO e o status do ALERTA continua SENT", async (t) => {
    if (!migracaoOk) return sk(t);
    const p = await alertaComReforcoPronto();
    await supabase.from("contatos_whatsapp").update({ opt_out: true }).eq("id", dest.contatoId);
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const r = meu(await lote(whatsAppService), p.reforcoId);
    assert.equal(r?.resultado, "BLOQUEADO", JSON.stringify(r));
    assert.equal(chamadas.length, 0);
    assert.equal(await statusAlerta(p.alerta.id), SA.SENT);
  });

  test("contato não verificado / sem consentimento -> BLOQUEADO, provider 0", async (t) => {
    if (!migracaoOk) return sk(t);
    for (const campos of [{ verificado: false }, { consentimento: false }]) {
      await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
      await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", orgA);
      await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).eq("id", dest.contatoId);
      const p = await alertaComReforcoPronto();
      await supabase.from("contatos_whatsapp").update(campos).eq("id", dest.contatoId);
      const { chamadas, whatsAppService } = criarProviderComSpy();
      const r = meu(await lote(whatsAppService), p.reforcoId);
      assert.equal(r?.resultado, "BLOQUEADO", `${JSON.stringify(campos)} ${JSON.stringify(r)}`);
      assert.equal(chamadas.length, 0);
    }
  });

  test("empresa desabilitada no JIT -> BLOQUEADO (EMPRESA_DESABILITADA), provider 0", async (t) => {
    if (!migracaoOk) return sk(t);
    const p = await alertaComReforcoPronto();
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const r = meu(await lote(whatsAppService, { resolverHabilitacao: HAB({ empresaHabilitada: false }) }), p.reforcoId);
    assert.equal(r?.resultado, "BLOQUEADO", JSON.stringify(r));
    assert.equal(r.motivo, "EMPRESA_DESABILITADA");
    assert.equal(chamadas.length, 0);
  });

  test("dois workers concorrentes sobre o mesmo reforço -> o provider é chamado no máximo UMA vez", async (t) => {
    if (!migracaoOk) return sk(t);
    const p = await alertaComReforcoPronto();
    const { chamadas, whatsAppService } = criarProviderComSpy();
    await Promise.all([lote(whatsAppService, { worker: "w1" }), lote(whatsAppService, { worker: "w2" })]);
    assert.equal(chamadas.length, 1);
    assert.equal((await linha(p.reforcoId)).status, SM.SENT);
  });
});
