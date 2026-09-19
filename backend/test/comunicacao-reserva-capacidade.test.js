// D.3-D — RESERVA ATÔMICA de capacidade (comunicacao_reservar_envio, migration 088), contra o banco de TESTE.
// Prova a corrida "dois workers veem 4/5 e ambos enviam" e o que CONSOME capacidade (SENDING, SENT,
// DELIVERED, READ, DELIVERY_UNKNOWN) versus o que não consome (CANCELLED, BLOCKED, FAILED pré-envio,
// SCHEDULED, PROCESSING). Cooldown = organização + unidade + tipo (não o telefone). O provider NUNCA é
// chamado fora de INICIADO.
// Rodar: node --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-reserva-capacidade.test.js
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, criarContaComPerfil, apagarConta, vincularUsuarioUnidade,
  migracao082Aplicada, migracao088Aplicada,
} from "./helpers/comunicacao-fixtures.js";
import * as filaRepo from "../src/modules/comunicacao/comunicacao.fila.repo.js";
import * as contatosRepo from "../src/modules/comunicacao/comunicacao.contatos.repo.js";
import { processarJobReivindicado } from "../src/modules/comunicacao/comunicacao.alertas.service.js";
import { definirModo, modoAtual } from "../src/modules/comunicacao/comunicacao.config.js";
import { criarWhatsAppService } from "../src/modules/comunicacao/whatsapp.service.js";
import { criarFakeProvider } from "../src/modules/comunicacao/providers/fake.provider.js";
import { MODOS, RESULTADO_RESERVA as R, STATUS_MENSAGEM as S } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
const tag = `comcap${Date.now()}`;
const HORA = 3600_000;
const DIA = 24 * HORA;
const inicioDoDia = () => new Date(Date.now() - 12 * HORA); // "hoje" = últimas 12h (independe do fuso/horário do CI)

let migracaoOk = true;
let modoOriginal = null;
let orgA = null, orgB = null, unidadeA = null, unidadeA2 = null, unidadeB = null;
let contaId = null, perfilId = null;
const contatos = []; // ids criados (limpeza)
let contatoP = null;  // contato principal

const HABILITADA = async () => ({
  empresaHabilitada: true, tipoPermitido: true, empresaPausada: false, pausadoAte: null, pausadoMotivo: null,
  timezone: "America/Fortaleza", janelas: null, configHorarioValida: true, fonte: "TESTE",
});
// janela SEMPRE aberta (00:00–23:59, todos os dias): o relógio real do CI nunca decide o resultado
const SEMPRE_ABERTA = { seg_sex: { inicio: "00:00", fim: "23:59" }, sab: { inicio: "00:00", fim: "23:59" }, dom: { inicio: "00:00", fim: "23:59" } };
const HABILITADA_SEMPRE = async () => ({ ...(await HABILITADA()), janelas: SEMPRE_ABERTA });

async function novoContato() {
  const c = await contatosRepo.criarOuObterContato({ telefoneE164: `+551196${String(Date.now() + contatos.length * 7919).slice(-7)}` });
  await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).eq("id", c.id);
  await contatosRepo.vincularPerfil({ contatoId: c.id, perfilOperacionalId: perfilId, principal: false });
  contatos.push(c.id);
  return c.id;
}

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada());
  if (!migracaoOk) return;
  modoOriginal = await modoAtual();
  orgA = await criarOrganizacao("TESTE capacidade A — descartável");
  orgB = await criarOrganizacao("TESTE capacidade B — descartável");
  unidadeA = await criarUnidade(orgA, "Unidade Cap A1");
  unidadeA2 = await criarUnidade(orgA, "Unidade Cap A2");
  unidadeB = await criarUnidade(orgB, "Unidade Cap B1");
  const conta = await criarContaComPerfil(tag, "dest");
  contaId = conta.contaId; perfilId = conta.perfilId;
  await vincularUsuarioUnidade({ perfilId, organizacaoId: orgA, unidadeId: unidadeA });
  contatoP = await novoContato();
});

after(async () => {
  if (modoOriginal) await definirModo(modoOriginal, {}).catch(() => {});
  if (contatos.length) {
    await supabase.from("comunicacao_mensagens").delete().in("contato_id", contatos);
    await supabase.from("contatos_whatsapp").delete().in("id", contatos);
  }
  if (contaId) await apagarConta(contaId);
  await apagarOrganizacao(orgA);
  await apagarOrganizacao(orgB);
});

beforeEach(async () => {
  if (PULAR_INTEGRACAO || !migracaoOk) return;
  await supabase.from("comunicacao_mensagens").delete().in("organizacao_id", [orgA, orgB]);
});

let seq = 0;
/** Insere uma mensagem crua (fixture) e devolve a linha. `campos` sobrescreve estado/colunas. */
async function inserir({ org = orgA, unidade = unidadeA, contato = contatoP, tipo = `tipo_${tag}_${++seq}`, campos = {} } = {}) {
  const { data, error } = await supabase.from("comunicacao_mensagens").insert({
    organizacao_id: org, unidade_id: unidade, contato_id: contato, destinatario_perfil_id: perfilId, canal: "whatsapp", direcao: "saida",
    tipo, conteudo: "aviso", idempotency_key: `cap-${tag}-${++seq}`, status: S.SCHEDULED, disponivel_em: new Date(Date.now() - 60_000).toISOString(),
    ...campos,
  }).select("*").single();
  if (error) throw new Error(`fixture: ${error.message}`);
  return data;
}
/** Uma mensagem em PROCESSING, com o token do claim já gravado (o worker "w"). */
async function emProcessamento(opts = {}) {
  const worker = opts.worker ?? `w-${tag}`;
  return inserir({ ...opts, campos: {
    status: S.PROCESSING, claimed_by: worker, claimed_at: new Date().toISOString(),
    claim_expira_em: new Date(Date.now() + 120_000).toISOString(), claim_geracao: 1, ...(opts.campos ?? {}),
  } });
}
const tok = (m) => ({ id: m.id, worker: m.claimed_by, claimGeracao: m.claim_geracao });
const reservar = (m, over = {}) => filaRepo.reservarEnvio({
  ...tok(m), leaseSegundos: 90, cooldownHoras: null, maxPorContatoDia: 100000, maxPorMinuto: 100000, maxPorMinutoOrganizacao: 100000, inicioDia: inicioDoDia(), ...over,
});
const linha = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("id", id).single()).data;
const contagem = (rs) => rs.reduce((m, r) => ({ ...m, [r.resultado]: (m[r.resultado] ?? 0) + 1 }), {});
/** capacidade por minuto da FROTA livre? (a taxa por minuto é global — outra suíte enviando agora a consumiria) */
async function frotaSemEnviosNoUltimoMinuto() {
  const desde = new Date(Date.now() - 65_000).toISOString();
  const { count } = await supabase.from("comunicacao_mensagens").select("id", { count: "exact", head: true })
    .eq("direcao", "saida").in("status", [S.SENDING, S.SENT, S.DELIVERED, S.READ, S.DELIVERY_UNKNOWN])
    .or(`enviado_em.gte.${desde},entrega_incerta_em.gte.${desde},claimed_at.gte.${desde}`);
  return (count ?? 0) === 0;
}

/** Quantas mensagens da FROTA consomem a taxa por minuto agora (mesmo predicado da RPC). */
async function consumoGlobalNoUltimoMinuto() {
  const desde = new Date(Date.now() - 60_000).toISOString();
  const { count } = await supabase.from("comunicacao_mensagens").select("id", { count: "exact", head: true })
    .eq("direcao", "saida").in("status", [S.SENDING, S.SENT, S.DELIVERED, S.READ, S.DELIVERY_UNKNOWN])
    .or(`enviado_em.gte.${desde},entrega_incerta_em.gte.${desde},claimed_at.gte.${desde}`);
  return count ?? 0;
}
const consumoRecente = (org, unidade) => inserir({ org, unidade, campos: { status: S.SENT, enviado_em: new Date().toISOString() } });

describe("cota diária por contato — DOIS workers, uma única vaga", { skip: PULAR_INTEGRACAO }, () => {
  test("limite 5, já existem 4: A e B reservam SIMULTANEAMENTE -> só UM consome a 5ª vaga; o outro recebe RATE_LIMIT_DIA (provider 0 chamadas)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    for (let i = 0; i < 4; i++) await inserir({ campos: { status: S.SENT, enviado_em: new Date().toISOString() } });
    const a = await emProcessamento({ worker: "w-A" });
    const b = await emProcessamento({ worker: "w-B" });
    const [ra, rb] = await Promise.all([reservar(a, { maxPorContatoDia: 5 }), reservar(b, { maxPorContatoDia: 5 })]);
    assert.deepEqual(contagem([ra, rb]), { [R.INICIADO]: 1, [R.RATE_LIMIT_DIA]: 1 }, JSON.stringify([ra.resultado, rb.resultado]));
    const vencedor = ra.resultado === R.INICIADO ? a : b;
    const perdedor = vencedor === a ? b : a;
    assert.equal((await linha(vencedor.id)).status, S.SENDING);
    assert.equal((await linha(vencedor.id)).tentativas, 1, "o attempt nasce na reserva");
    const p = await linha(perdedor.id);
    assert.equal(p.status, S.PROCESSING, "quem perdeu a vaga NÃO é movido para SENDING");
    assert.equal(p.tentativas, 0);
  });

  test("10 workers competem por 2 vagas restantes (limite 5, 3 existentes) -> exatamente 2 INICIADO e 8 RATE_LIMIT_DIA — repetido 3x", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    for (let rodada = 1; rodada <= 3; rodada++) {
      await supabase.from("comunicacao_mensagens").delete().in("organizacao_id", [orgA]);
      for (let i = 0; i < 3; i++) await inserir({ campos: { status: S.DELIVERED, enviado_em: new Date().toISOString() } });
      const jobs = [];
      for (let i = 0; i < 10; i++) jobs.push(await emProcessamento({ worker: `w-${i}` }));
      const rs = await Promise.all(jobs.map((j) => reservar(j, { maxPorContatoDia: 5 })));
      assert.deepEqual(contagem(rs), { [R.INICIADO]: 2, [R.RATE_LIMIT_DIA]: 8 }, `rodada ${rodada}: ${JSON.stringify(contagem(rs))}`);
      const { count } = await supabase.from("comunicacao_mensagens").select("id", { count: "exact", head: true }).eq("contato_id", contatoP).eq("status", S.SENDING);
      assert.equal(count, 2, `rodada ${rodada}: houve ${count} em SENDING`);
    }
  });

  test("NO PIPELINE: 2 jobs concorrentes do mesmo contato com 1 vaga -> o provider é chamado UMA vez; o outro é ADIADO (zero attempts)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await definirModo(MODOS.NORMAL, {});
    await supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: { max_proativas_por_minuto: 100000, max_proativas_por_minuto_por_organizacao: 100000, max_por_contato_por_dia: 5 } }, { onConflict: "chave" });
    try {
      for (let i = 0; i < 4; i++) await inserir({ campos: { status: S.SENT, enviado_em: new Date().toISOString() } });
      const a = await emProcessamento({ worker: "pipe-A" });
      const b = await emProcessamento({ worker: "pipe-B" });
      const provider = criarFakeProvider();
      const chamadas = [];
      const original = provider.sendText.bind(provider);
      provider.sendText = async (args) => { chamadas.push(args); return original(args); };
      const whatsAppService = criarWhatsAppService({ provider });
      const ctx = { whatsAppService, agora: new Date(), adiamentoMs: 900_000, verificarPendenciaAindaExiste: async () => true, resolverHabilitacao: HABILITADA_SEMPRE };
      const rs = await Promise.all([processarJobReivindicado(a, ctx), processarJobReivindicado(b, ctx)]);
      assert.equal(chamadas.length, 1, `o provider foi chamado ${chamadas.length}x — a 5ª vaga foi vendida duas vezes`);
      assert.deepEqual(rs.map((r) => r.resultado).sort(), ["ADIADO", "ENVIADO"], JSON.stringify(rs));
      const adiado = rs.find((r) => r.resultado === "ADIADO");
      assert.equal(adiado.motivo, "RATE_LIMIT");
      const idAdiado = adiado.id;
      const l = await linha(idAdiado);
      assert.equal(l.status, S.SCHEDULED);
      assert.equal(l.tentativas, 0, "adiar por capacidade não consome attempt");
      assert.ok(new Date(l.disponivel_em).getTime() > Date.now(), "próximo instante REAL (00:00 do dia seguinte local + abertura)");
    } finally {
      await supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: { max_proativas_por_minuto: 5, max_proativas_por_minuto_por_organizacao: 3, max_por_contato_por_dia: 3 } }, { onConflict: "chave" });
      await definirModo(modoOriginal ?? MODOS.DISABLED, {});
    }
  });
});

describe("taxa por minuto — concorrência", { skip: PULAR_INTEGRACAO }, () => {
  test("limite 1/min, 6 workers (contatos diferentes) simultâneos -> NUNCA mais de UM INICIADO (exatamente 1 se a frota estava ociosa)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const ociosa = await frotaSemEnviosNoUltimoMinuto();
    const jobs = [];
    for (let i = 0; i < 6; i++) jobs.push(await emProcessamento({ worker: `wm-${i}`, contato: await novoContato() }));
    const rs = await Promise.all(jobs.map((j) => reservar(j, { maxPorMinuto: 1 })));
    const c = contagem(rs);
    assert.ok((c[R.INICIADO] ?? 0) <= 1, `mais de um envio no mesmo minuto: ${JSON.stringify(c)}`);
    if (ociosa) assert.deepEqual(c, { [R.INICIADO]: 1, [R.RATE_LIMIT_MINUTO]: 5 });
    else assert.equal((c[R.INICIADO] ?? 0) + (c[R.RATE_LIMIT_MINUTO] ?? 0), 6);
  });
});

describe("DUAS camadas de taxa por minuto — global E organização (ambas precisam ter vaga)", { skip: PULAR_INTEGRACAO }, () => {
  test("A) ORGANIZAÇÃO: limite org 5, já consumiu 4; dois workers da MESMA org simultâneos -> exatamente 1 INICIADO e 1 RATE_LIMIT_MINUTO_ORGANIZACAO", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    for (let i = 0; i < 4; i++) await consumoRecente(orgA, unidadeA);
    const a = await emProcessamento({ worker: "og-A", contato: await novoContato() });
    const b = await emProcessamento({ worker: "og-B", contato: await novoContato() });
    const rs = await Promise.all([reservar(a, { maxPorMinutoOrganizacao: 5 }), reservar(b, { maxPorMinutoOrganizacao: 5 })]);
    assert.deepEqual(contagem(rs), { [R.INICIADO]: 1, [R.RATE_LIMIT_MINUTO_ORGANIZACAO]: 1 }, JSON.stringify(rs.map((x) => x.resultado)));
    const { count } = await supabase.from("comunicacao_mensagens").select("id", { count: "exact", head: true }).eq("organizacao_id", orgA).eq("status", S.SENDING);
    assert.equal(count, 1, "a organização foi oversubscribed");
  });

  test("B) GLOBAL: limite global 10, já existem 9 de organizações DIFERENTES; dois workers (uma org cada) simultâneos -> exatamente 1 INICIADO e 1 RATE_LIMIT_MINUTO", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const base = await consumoGlobalNoUltimoMinuto(); // a taxa global é da frota inteira: mede o que já existe fora desta suíte
    for (let i = 0; i < 5; i++) await consumoRecente(orgA, unidadeA);
    for (let i = 0; i < 4; i++) await consumoRecente(orgB, unidadeB);
    const limiteGlobal = base + 10; // 9 desta suíte + `base` de fora => resta exatamente UMA vaga
    const a = await emProcessamento({ worker: "gl-A", contato: await novoContato() });
    const b = await emProcessamento({ org: orgB, unidade: unidadeB, worker: "gl-B", contato: await novoContato() });
    const rs = await Promise.all([reservar(a, { maxPorMinuto: limiteGlobal }), reservar(b, { maxPorMinuto: limiteGlobal })]);
    assert.deepEqual(contagem(rs), { [R.INICIADO]: 1, [R.RATE_LIMIT_MINUTO]: 1 }, JSON.stringify(rs.map((x) => x.resultado)));
  });

  test("C) global COM vaga mas ORGANIZAÇÃO esgotada -> bloqueia a org (RATE_LIMIT_MINUTO_ORGANIZACAO) e NÃO a outra org (fairness)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    for (let i = 0; i < 3; i++) await consumoRecente(orgA, unidadeA);
    const a1 = await emProcessamento({ worker: "c-A1", contato: await novoContato() });
    const a2 = await emProcessamento({ worker: "c-A2", contato: await novoContato() });
    const b = await emProcessamento({ org: orgB, unidade: unidadeB, worker: "c-B", contato: await novoContato() });
    const rs = await Promise.all([reservar(a1, { maxPorMinutoOrganizacao: 3, maxPorMinuto: 100000 }), reservar(a2, { maxPorMinutoOrganizacao: 3, maxPorMinuto: 100000 }), reservar(b, { maxPorMinutoOrganizacao: 3, maxPorMinuto: 100000 })]);
    assert.equal(rs[0].resultado, R.RATE_LIMIT_MINUTO_ORGANIZACAO);
    assert.equal(rs[1].resultado, R.RATE_LIMIT_MINUTO_ORGANIZACAO);
    assert.equal(rs[2].resultado, R.INICIADO, "uma empresa esgotada não pode consumir/bloquear a capacidade das outras");
    assert.equal((await linha(a1.id)).status, S.PROCESSING, "bloqueado por capacidade NÃO vira SENDING");
    assert.equal((await linha(a1.id)).tentativas, 0);
  });

  test("D) ORGANIZAÇÃO com vaga mas GLOBAL esgotado -> bloqueia (RATE_LIMIT_MINUTO), 0 attempts", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const base = await consumoGlobalNoUltimoMinuto();
    for (let i = 0; i < 4; i++) await consumoRecente(orgB, unidadeB); // a org A está ZERADA
    const a1 = await emProcessamento({ worker: "d-A1", contato: await novoContato() });
    const a2 = await emProcessamento({ worker: "d-A2", contato: await novoContato() });
    const rs = await Promise.all([reservar(a1, { maxPorMinuto: base + 4, maxPorMinutoOrganizacao: 5 }), reservar(a2, { maxPorMinuto: base + 4, maxPorMinutoOrganizacao: 5 })]);
    assert.deepEqual(contagem(rs), { [R.RATE_LIMIT_MINUTO]: 2 }, JSON.stringify(rs.map((x) => x.resultado)));
    for (const j of [a1, a2]) assert.equal((await linha(j.id)).tentativas, 0);
  });

  test("as DUAS liberadas -> INICIADO; sem vaga em qualquer uma o provider não é chamado (no pipeline: ADIADO por RATE_LIMIT, 0 attempts)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const a = await emProcessamento({ worker: "ok-A", contato: await novoContato() });
    assert.equal((await reservar(a, { maxPorMinuto: 100000, maxPorMinutoOrganizacao: 100000 })).resultado, R.INICIADO);
    await definirModo(MODOS.NORMAL, {});
    await supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: { max_proativas_por_minuto: 100000, max_proativas_por_minuto_por_organizacao: 1, max_por_contato_por_dia: 100000 } }, { onConflict: "chave" });
    try {
      // já há 1 SENDING na org A (acima): o limite da ORGANIZAÇÃO (1) está esgotado
      const b = await emProcessamento({ worker: "ok-B", contato: await novoContato() });
      const provider = criarFakeProvider();
      const chamadas = [];
      const original = provider.sendText.bind(provider);
      provider.sendText = async (args) => { chamadas.push(args); return original(args); };
      const r = await processarJobReivindicado(b, { whatsAppService: criarWhatsAppService({ provider }), agora: new Date(), adiamentoMs: 900_000, verificarPendenciaAindaExiste: async () => true, resolverHabilitacao: HABILITADA_SEMPRE });
      assert.equal(chamadas.length, 0, "o provider foi chamado apesar da organização esgotada");
      assert.equal(r.resultado, "ADIADO");
      assert.equal(r.motivo, "RATE_LIMIT");
      assert.equal((await linha(b.id)).tentativas, 0);
    } finally {
      await supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: { max_proativas_por_minuto: 5, max_proativas_por_minuto_por_organizacao: 3, max_por_contato_por_dia: 3 } }, { onConflict: "chave" });
      await definirModo(modoOriginal ?? MODOS.DISABLED, {});
    }
  });
});

describe("o que CONSOME capacidade (e o que não)", { skip: PULAR_INTEGRACAO }, () => {
  const consomem = [
    ["SENDING", { status: S.SENDING, claimed_by: "w-x", claimed_at: () => new Date().toISOString(), claim_expira_em: () => new Date(Date.now() + 60_000).toISOString(), tentativas: 1 }],
    ["SENT", { status: S.SENT, enviado_em: () => new Date().toISOString() }],
    ["DELIVERED", { status: S.DELIVERED, enviado_em: () => new Date().toISOString(), entregue_em: () => new Date().toISOString() }],
    ["READ", { status: S.READ, enviado_em: () => new Date().toISOString(), lido_em: () => new Date().toISOString() }],
    ["DELIVERY_UNKNOWN", { status: S.DELIVERY_UNKNOWN, entrega_incerta_em: () => new Date().toISOString() }],
  ];
  const materializar = (c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === "function" ? v() : v]));

  for (const [nome, campos] of consomem) {
    test(`${nome} CONSOME a cota diária (limite 1: a próxima é RATE_LIMIT_DIA)`, async (t) => {
      if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
      await inserir({ campos: materializar(campos) });
      const m = await emProcessamento();
      assert.equal((await reservar(m, { maxPorContatoDia: 1 })).resultado, R.RATE_LIMIT_DIA, nome);
      assert.equal((await linha(m.id)).status, S.PROCESSING);
    });
  }

  test("CANCELLED (antes de enviar), BLOCKED, FAILED pré-envio, SCHEDULED e outro PROCESSING NÃO consomem: com limite 1 a reserva passa", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    for (const campos of [{ status: S.CANCELLED }, { status: S.BLOCKED }, { status: S.FAILED, falhou_em: new Date().toISOString() }, { status: S.SCHEDULED }, { status: S.PROCESSING, claimed_by: "w-o", claim_geracao: 1, claim_expira_em: new Date(Date.now() + 60_000).toISOString() }]) {
      await inserir({ campos });
    }
    const m = await emProcessamento();
    const r = await reservar(m, { maxPorContatoDia: 1, maxPorMinuto: 100000 });
    assert.equal(r.resultado, R.INICIADO, `estado que não deveria consumir barrou: ${r.resultado}`);
  });

  test("UNKNOWN nunca deixa de consumir capacidade: um DELIVERY_UNKNOWN de 3 DIAS atrás ainda BLOQUEIA o cooldown do mesmo tipo/unidade (sem limite de tempo)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const tipo = `tipo_unk_${tag}`;
    await inserir({ tipo, contato: await novoContato(), campos: { status: S.DELIVERY_UNKNOWN, entrega_incerta_em: new Date(Date.now() - 3 * DIA).toISOString() } });
    const m = await emProcessamento({ tipo });
    assert.equal((await reservar(m, { cooldownHoras: 8 })).resultado, R.COOLDOWN);
  });
});

describe("COOLDOWN = organização + unidade + tipo (nunca o telefone global)", { skip: PULAR_INTEGRACAO }, () => {
  const tipo = () => `tipo_cd_${tag}_${++seq}`;
  const recente = () => ({ status: S.SENT, enviado_em: new Date(Date.now() - HORA).toISOString() });

  test("outro CONTATO, mesma organização+unidade+tipo, enviado há 1h -> COOLDOWN (pendência persistente não vira mensagem nova)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const tp = tipo();
    await inserir({ tipo: tp, contato: await novoContato(), campos: recente() });
    const m = await emProcessamento({ tipo: tp });
    assert.equal((await reservar(m, { cooldownHoras: 8 })).resultado, R.COOLDOWN);
  });

  test("mesmo CONTATO mas OUTRA unidade da mesma organização -> NÃO há cooldown", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const tp = tipo();
    await inserir({ tipo: tp, unidade: unidadeA2, campos: recente() });
    const m = await emProcessamento({ tipo: tp });
    assert.equal((await reservar(m, { cooldownHoras: 8 })).resultado, R.INICIADO);
  });

  test("mesmo tipo em OUTRA organização (mesmo contato) -> NÃO há cooldown (cross-org)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const tp = tipo();
    await inserir({ tipo: tp, org: orgB, unidade: unidadeB, campos: recente() });
    const m = await emProcessamento({ tipo: tp });
    assert.equal((await reservar(m, { cooldownHoras: 8 })).resultado, R.INICIADO);
  });

  test("outro TIPO na mesma unidade -> NÃO há cooldown", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await inserir({ tipo: tipo(), campos: recente() });
    const m = await emProcessamento({ tipo: tipo() });
    assert.equal((await reservar(m, { cooldownHoras: 8 })).resultado, R.INICIADO);
  });

  test("SENT FORA da janela do cooldown (há 9h, cooldown 8h) -> passa; dentro (há 1h) -> bloqueia", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const tp = tipo();
    await inserir({ tipo: tp, campos: { status: S.SENT, enviado_em: new Date(Date.now() - 9 * HORA).toISOString() } });
    const a = await emProcessamento({ tipo: tp });
    assert.equal((await reservar(a, { cooldownHoras: 8 })).resultado, R.INICIADO);
    // agora o `a` está SENDING: outro job do mesmo escopo é barrado por ele
    const b = await emProcessamento({ tipo: tp });
    assert.equal((await reservar(b, { cooldownHoras: 8 })).resultado, R.COOLDOWN, "SENDING conta para o cooldown");
  });

  test("COOLDOWN concorrente: 2 jobs do MESMO escopo reservam juntos -> só um INICIADO", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const tp = tipo();
    const a = await emProcessamento({ tipo: tp, worker: "cd-A" });
    const b = await emProcessamento({ tipo: tp, worker: "cd-B", contato: await novoContato() });
    const rs = await Promise.all([reservar(a, { cooldownHoras: 8 }), reservar(b, { cooldownHoras: 8 })]);
    assert.deepEqual(contagem(rs), { [R.INICIADO]: 1, [R.COOLDOWN]: 1 });
  });
});

describe("posse, TTL e fail-closed da reserva", { skip: PULAR_INTEGRACAO }, () => {
  test("token errado (worker, geração) ou lease vencido -> POSSE_PERDIDA, nada muda", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const m = await emProcessamento();
    assert.equal((await reservar(m, { worker: "impostor" })).resultado, R.POSSE_PERDIDA);
    assert.equal((await reservar(m, { claimGeracao: 99 })).resultado, R.POSSE_PERDIDA);
    await supabase.from("comunicacao_mensagens").update({ claim_expira_em: new Date(Date.now() - 1000).toISOString() }).eq("id", m.id);
    assert.equal((await reservar(m)).resultado, R.POSSE_PERDIDA);
    const l = await linha(m.id);
    assert.equal(l.status, S.PROCESSING);
    assert.equal(l.tentativas, 0);
    const inexistente = await filaRepo.reservarEnvio({ id: "00000000-0000-0000-0000-000000000000", worker: "w", claimGeracao: 1, cooldownHoras: null, maxPorContatoDia: 1, maxPorMinuto: 1, maxPorMinutoOrganizacao: 1, inicioDia: new Date() });
    assert.equal(inexistente.resultado, R.POSSE_PERDIDA);
  });

  test("TTL: mensagem com expira_em < agora NUNCA vira SENDING — a reserva a cancela (CANCELLED/EXPIRADA), 0 attempts", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const m = await emProcessamento({ campos: { expira_em: new Date(Date.now() - 1000).toISOString() } });
    const r = await reservar(m);
    assert.equal(r.resultado, R.EXPIRADA);
    assert.equal(r.mensagem, undefined, "EXPIRADA não devolve linha para enviar");
    const l = await linha(m.id);
    assert.equal(l.status, S.CANCELLED);
    assert.equal(l.erro, "EXPIRADA");
    assert.equal(l.tentativas, 0);
  });

  test("expira_em NO FUTURO ou NULL não expira", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const a = await emProcessamento({ campos: { expira_em: new Date(Date.now() + HORA).toISOString() } });
    assert.equal((await reservar(a)).resultado, R.INICIADO);
    const b = await emProcessamento({ campos: { expira_em: null } });
    assert.equal((await reservar(b)).resultado, R.INICIADO);
  });

  test("a reserva é FAIL-CLOSED no cliente: resposta desconhecida/sem linha vira erro, nunca 'iniciado'", async () => {
    const dbQue = (resposta) => ({ rpc: async () => resposta });
    const base = { id: "x", worker: "w", claimGeracao: 1, cooldownHoras: 1, maxPorContatoDia: 1, maxPorMinuto: 1, maxPorMinutoOrganizacao: 1, inicioDia: new Date() };
    await assert.rejects(() => filaRepo.reservarEnvio(base, { supabase: dbQue({ data: null, error: null }) }), /resposta inválida/);
    await assert.rejects(() => filaRepo.reservarEnvio(base, { supabase: dbQue({ data: { resultado: "TALVEZ" }, error: null }) }), /resposta inválida/);
    await assert.rejects(() => filaRepo.reservarEnvio(base, { supabase: dbQue({ data: { resultado: "INICIADO" }, error: null }) }), /sem a linha/);
    await assert.rejects(() => filaRepo.reservarEnvio(base, { supabase: dbQue({ data: null, error: { message: "boom" } }) }), /boom/);
  });
});

describe("MUTAÇÃO — o oráculo da corrida DETECTA a implementação ingênua (SELECT count, depois UPDATE)", { skip: PULAR_INTEGRACAO }, () => {
  test("a reserva NÃO atômica (como era antes: conta e só depois inicia o envio) deixa A e B consumirem a MESMA 5ª vaga; a RPC atômica não", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const STATUS_CONSUMO = [S.SENDING, S.SENT, S.DELIVERED, S.READ, S.DELIVERY_UNKNOWN];
    // barreira: as duas contagens acontecem ANTES de qualquer início de envio (a corrida, tornada determinística)
    let chegaram = 0; let abrir; const barreira = new Promise((r) => { abrir = r; });
    const aguardar = async () => { if (++chegaram === 2) abrir(); await barreira; };

    async function reservaIngenua(m, maxPorContatoDia) {
      const { count } = await supabase.from("comunicacao_mensagens").select("id", { count: "exact", head: true })
        .eq("contato_id", contatoP).neq("id", m.id).in("status", STATUS_CONSUMO).gte("enviado_em", inicioDoDia().toISOString());
      await aguardar(); // ambos viram 4/5
      if ((count ?? 0) >= maxPorContatoDia) return { resultado: R.RATE_LIMIT_DIA };
      return (await filaRepo.iniciarEnvio(tok(m))) ? { resultado: R.INICIADO } : { resultado: R.POSSE_PERDIDA };
    }

    for (let i = 0; i < 4; i++) await inserir({ campos: { status: S.SENT, enviado_em: new Date().toISOString() } });
    const a = await emProcessamento({ worker: "ing-A" });
    const b = await emProcessamento({ worker: "ing-B" });
    const ingenuas = await Promise.all([reservaIngenua(a, 5), reservaIngenua(b, 5)]);
    assert.deepEqual(contagem(ingenuas), { [R.INICIADO]: 2 }, "a implementação ingênua deveria vender a mesma vaga duas vezes (o teste de corrida ficaria cego)");

    // mesma situação com a RPC atômica: uma só passa
    await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
    for (let i = 0; i < 4; i++) await inserir({ campos: { status: S.SENT, enviado_em: new Date().toISOString() } });
    const c = await emProcessamento({ worker: "at-A" });
    const d = await emProcessamento({ worker: "at-B" });
    const atomicas = await Promise.all([reservar(c, { maxPorContatoDia: 5 }), reservar(d, { maxPorContatoDia: 5 })]);
    assert.deepEqual(contagem(atomicas), { [R.INICIADO]: 1, [R.RATE_LIMIT_DIA]: 1 });
  });
});
