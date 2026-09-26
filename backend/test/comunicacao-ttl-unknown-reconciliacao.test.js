// D.3-D-R — TTL/expiração (a MENSAGEM expira, a PENDÊNCIA não), DELIVERY_UNKNOWN (transporte: fica na mensagem,
// nunca vira status do alerta), reconciliação humana (contrato), resolução de pendência e "pendencias() UMA vez
// por lote/ciclo" (migration 088), contra o banco de TESTE.
// Rodar: node --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-ttl-unknown-reconciliacao.test.js
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { agendarMensagemT, responsavelDoContato } from "./helpers/comunicacao-fixtures.js";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, criarDestinatario, apagarDestinatario, habilitarOrganizacao,
  migracao082Aplicada, migracao088Aplicada,
} from "./helpers/comunicacao-fixtures.js";
import * as alertasRepo from "../src/modules/comunicacao/comunicacao.alertas.repo.js";
import * as filaRepo from "../src/modules/comunicacao/comunicacao.fila.repo.js";
import * as contatosRepo from "../src/modules/comunicacao/comunicacao.contatos.repo.js";
import {
  processarProximoLote, processarJobReivindicado, agendarEnviosPendentes, detectarESincronizarAlertas, executarCiclo,
} from "../src/modules/comunicacao/comunicacao.alertas.service.js";
import { definirModo, modoAtual } from "../src/modules/comunicacao/comunicacao.config.js";
import { criarWhatsAppService } from "../src/modules/comunicacao/whatsapp.service.js";
import { criarFakeProvider } from "../src/modules/comunicacao/providers/fake.provider.js";
import { MODOS, TIPOS_ALERTA, SEVERIDADE, STATUS_ALERTA as SA, STATUS_MENSAGEM as SM } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
const TIPO = TIPOS_ALERTA.DASHBOARD_IFOOD_D1;
const tag = `comttl${Date.now()}`;
const HORA = 3600_000;
const DIA = 24 * HORA;

let migracaoOk = true;
let modoOriginal = null;
let orgA = null, orgB = null, unidadeA = null, perfilId = null, contatoId = null, destPrincipal = null;
const extras = [];

// janela SEMPRE aberta (o relógio real do CI nunca decide): 00:00–23:59, todos os dias
const SEMPRE = { seg_sex: { inicio: "00:00", fim: "23:59" }, sab: { inicio: "00:00", fim: "23:59" }, dom: { inicio: "00:00", fim: "23:59" } };
const HABILITADA = async () => ({
  empresaHabilitada: true, tipoPermitido: true, empresaPausada: false, pausadoAte: null, pausadoMotivo: null,
  destinatarioContatoId: "contato-de-teste", destinatarioContatoEmpresaId: "ce-de-teste", destinatarioPerfilId: "perfil-de-teste",
  timezone: "America/Fortaleza", janelas: SEMPRE, configHorarioValida: true, fonte: "TESTE",
});

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada());
  if (!migracaoOk) return;
  modoOriginal = await modoAtual();
  orgA = await criarOrganizacao("TESTE ttl-unknown A — descartável");
  orgB = await criarOrganizacao("TESTE ttl-unknown B — descartável");
  unidadeA = await criarUnidade(orgA, "Unidade TTL A1");
  destPrincipal = await criarDestinatario({ organizacaoId: orgA, unidadeId: unidadeA, tag, sufixo: "dest" });
  perfilId = destPrincipal.perfilId; contatoId = destPrincipal.contatoId;
});

after(async () => {
  if (modoOriginal) await definirModo(modoOriginal, {}).catch(() => {});
  if (extras.length) {
    await supabase.from("comunicacao_mensagens").delete().in("contato_id", extras);
    await supabase.from("contatos_whatsapp").delete().in("id", extras);
  }
  await apagarOrganizacao(orgA);
  await apagarOrganizacao(orgB);
  await apagarDestinatario(destPrincipal);
});

beforeEach(async () => {
  if (PULAR_INTEGRACAO || !migracaoOk) return;
  await supabase.from("comunicacao_alertas").delete().in("organizacao_id", [orgA, orgB]);
  await supabase.from("comunicacao_mensagens").delete().in("organizacao_id", [orgA, orgB]);
  await supabase.from("comunicacao_habilitacoes").delete().in("organizacao_id", [orgA, orgB]); // cada teste habilita o que precisa
  await definirModo(MODOS.NORMAL, {});
});

async function novoContato() {
  const c = await contatosRepo.criarOuObterContato({ telefoneE164: `+551195${String(Date.now() + extras.length * 7919).slice(-7)}` });
  await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).eq("id", c.id);
  await contatosRepo.vincularPerfil({ contatoId: c.id, perfilOperacionalId: perfilId, principal: false });
  extras.push(c.id);
  return c.id;
}

let seq = 0;
async function novoAlerta({ organizacaoId = orgA, unidadeId = unidadeA, data = `2026-06-${String(10 + (++seq % 18)).padStart(2, "0")}` } = {}) {
  const { alerta } = await alertasRepo.criarOuEscalonarAlerta({
    organizacaoId, unidadeId, tipoAlerta: TIPO, dataReferencia: data, destinatarioPerfilId: null,
    severidade: SEVERIDADE.ATENCAO, motivo: "2 dia(s) pendente(s)", metadados: { unidade_nome: "Loja TTL", empresa_nome: "Rede TTL" },
  });
  return alerta;
}
/** Alerta SCHEDULED + mensagem SCHEDULED elegível já (contato próprio: sem cota/cooldown compartilhados). */
async function alertaComMensagem({ campos = {}, contato, tipo } = {}) {
  const alerta = await novoAlerta();
  const c = contato ?? await novoContato();
  const { data, error } = await supabase.from("comunicacao_mensagens").insert({
    alerta_id: alerta.id, organizacao_id: orgA, unidade_id: unidadeA, contato_id: c, contato_empresa_id: await responsavelDoContato({ organizacaoId: orgA, contatoId: c, perfilId }), destinatario_perfil_id: perfilId, canal: "whatsapp", direcao: "saida",
    tipo: tipo ?? `tipo_${tag}_${++seq}`, conteudo: "aviso", idempotency_key: `wa:alerta:${alerta.id}:v1`, status: SM.SCHEDULED,
    disponivel_em: new Date(Date.now() - 60_000).toISOString(), ...campos,
  }).select("*").single();
  if (error) throw new Error(`fixture: ${error.message}`);
  await alertasRepo.atualizarStatusAlerta(alerta.id, SA.SCHEDULED);
  return { alerta, job: data };
}
const linha = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("id", id).single()).data;
const statusAlerta = async (id) => (await supabase.from("comunicacao_alertas").select("status").eq("id", id).single()).data.status;
const msgsDoAlerta = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("alerta_id", id)).data ?? [];

function providerComSpy() {
  const provider = criarFakeProvider();
  const chamadas = [];
  const original = provider.sendText.bind(provider);
  provider.sendText = async (a) => { chamadas.push(a); return original(a); };
  return { provider, chamadas, whatsAppService: criarWhatsAppService({ provider, semGateIdentidade: true }) };
}
const lote = (whatsAppService, extra = {}) => processarProximoLote({
  limite: 20, worker: `ttl-${tag}`, whatsAppService, agora: new Date(), verificarPendenciaAindaExiste: async () => true, resolverHabilitacao: HABILITADA, ...extra,
});
const ctxJob = (whatsAppService, extra = {}) => ({ whatsAppService, agora: new Date(), adiamentoMs: 900_000, verificarPendenciaAindaExiste: async () => true, resolverHabilitacao: HABILITADA, ...extra });
const emProcessamento = async (id, worker = `w-${tag}`) => {
  const { data } = await supabase.from("comunicacao_mensagens").update({
    status: SM.PROCESSING, claimed_by: worker, claimed_at: new Date().toISOString(), claim_expira_em: new Date(Date.now() + 120_000).toISOString(), claim_geracao: 1,
  }).eq("id", id).select("*").single();
  return data;
};

describe("TTL — mensagem velha nunca é enviada", { skip: PULAR_INTEGRACAO }, () => {
  test("SCHEDULED com expira_em < agora: o lote a CANCELA (CANCELLED/EXPIRADA) sem NUNCA reivindicá-la — 0 claims, 0 attempts, provider 0 chamadas; a PENDÊNCIA (alerta) continua ATIVA", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const velha = await alertaComMensagem({ campos: { expira_em: new Date(Date.now() - 1000).toISOString() } });
    const { chamadas, whatsAppService } = providerComSpy();
    const r = await lote(whatsAppService);
    assert.equal(r.some((x) => x.id === velha.job.id), false, "a expirada foi reivindicada/processada");
    const l = await linha(velha.job.id);
    assert.equal(l.status, SM.CANCELLED);
    assert.equal(l.erro, "EXPIRADA");
    assert.equal(l.claim_geracao, 0, "nunca chegou a PROCESSING");
    assert.equal(l.tentativas, 0);
    assert.equal(chamadas.length, 0);
    assert.equal(await statusAlerta(velha.alerta.id), SA.DETECTED, "a mensagem expirou, a pendência NÃO: o alerta segue ativo (DETECTED = sem mensagem viva)");
  });

  test("a varredura só cancela o que EXPIROU: uma mensagem válida no MESMO lote é enviada normalmente", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const velha = await alertaComMensagem({ campos: { expira_em: new Date(Date.now() - 1000).toISOString() } });
    const boa = await alertaComMensagem({ campos: { expira_em: new Date(Date.now() + HORA).toISOString() } });
    const semTtl = await alertaComMensagem({ campos: { expira_em: null } });
    const { chamadas, whatsAppService } = providerComSpy();
    const r = await lote(whatsAppService);
    assert.equal(r.find((x) => x.id === boa.job.id)?.resultado, "ENVIADO");
    assert.equal(r.find((x) => x.id === semTtl.job.id)?.resultado, "ENVIADO");
    assert.equal(chamadas.length, 2);
    assert.equal((await linha(velha.job.id)).status, SM.CANCELLED);
  });

  test("PROCESSING com lease vencido E TTL vencido (worker morto): também é cancelada, nunca reprocessada", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const m = await alertaComMensagem({ campos: { expira_em: new Date(Date.now() - 1000).toISOString() } });
    await supabase.from("comunicacao_mensagens").update({ status: SM.PROCESSING, claimed_by: "morto", claim_geracao: 1, claim_expira_em: new Date(Date.now() - 5000).toISOString() }).eq("id", m.job.id);
    const { chamadas, whatsAppService } = providerComSpy();
    await lote(whatsAppService);
    const l = await linha(m.job.id);
    assert.equal(l.status, SM.CANCELLED);
    assert.equal(l.erro, "EXPIRADA");
    assert.equal(l.tentativas, 0);
    assert.equal(chamadas.length, 0);
  });

  test("SENDING e DELIVERY_UNKNOWN NUNCA são cancelados por TTL (podem já ter saído)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const passado = new Date(Date.now() - 1000).toISOString();
    const a = await alertaComMensagem({ campos: { expira_em: passado } });
    await supabase.from("comunicacao_mensagens").update({ status: SM.DELIVERY_UNKNOWN, entrega_incerta_em: new Date().toISOString(), claimed_by: "w", claim_geracao: 1, tentativas: 1 }).eq("id", a.job.id);
    const b = await alertaComMensagem({ campos: { expira_em: passado } });
    await supabase.from("comunicacao_mensagens").update({ status: SM.SENDING, claimed_by: "w", claim_geracao: 1, tentativas: 1, claimed_at: new Date().toISOString(), claim_expira_em: new Date(Date.now() + 60_000).toISOString() }).eq("id", b.job.id);
    const { chamadas, whatsAppService } = providerComSpy();
    await lote(whatsAppService);
    assert.equal((await linha(a.job.id)).status, SM.DELIVERY_UNKNOWN);
    assert.equal((await linha(b.job.id)).status, SM.SENDING);
    assert.equal(chamadas.length, 0);
  });

  test("FRONTEIRA (relógio do BANCO): o job foi reivindicado ainda válido, o TTL vence antes de enviar -> CANCELADO_EXPIRADA, provider 0 chamadas, 0 attempts", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const m = await alertaComMensagem({ campos: { expira_em: new Date(Date.now() + HORA).toISOString() } });
    const job = await emProcessamento(m.job.id); // o worker segura o job com expira_em ainda no futuro
    await supabase.from("comunicacao_mensagens").update({ expira_em: new Date(Date.now() - 1000).toISOString() }).eq("id", m.job.id); // vence depois do claim
    const { chamadas, whatsAppService } = providerComSpy();
    const r = await processarJobReivindicado(job, ctxJob(whatsAppService));
    assert.equal(r.resultado, "CANCELADO_EXPIRADA");
    assert.equal(chamadas.length, 0);
    const l = await linha(m.job.id);
    assert.deepEqual([l.status, l.erro, l.tentativas], [SM.CANCELLED, "EXPIRADA", 0]);
    assert.equal(await statusAlerta(m.alerta.id), SA.DETECTED, "a expiração da MENSAGEM não cancela a pendência");
  });

  test("atalho antes de qualquer trabalho: o job já carrega expira_em vencido -> cancela com o token do claim", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const m = await alertaComMensagem();
    const job = await emProcessamento(m.job.id);
    const { chamadas, whatsAppService } = providerComSpy();
    const r = await processarJobReivindicado({ ...job, expira_em: new Date(Date.now() - 1000).toISOString() }, ctxJob(whatsAppService));
    assert.equal(r.resultado, "CANCELADO_EXPIRADA");
    assert.equal(chamadas.length, 0);
    assert.equal((await linha(m.job.id)).status, SM.CANCELLED);
    assert.equal(await statusAlerta(m.alerta.id), SA.DETECTED);
  });

  test("worker que perdeu a posse não cancela por TTL (POSSE_PERDIDA) — token errado nunca encerra a linha de outro", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const m = await alertaComMensagem();
    const job = await emProcessamento(m.job.id);
    await supabase.from("comunicacao_mensagens").update({ claim_geracao: 2, claimed_by: "outro-worker" }).eq("id", m.job.id);
    const { chamadas, whatsAppService } = providerComSpy();
    const r = await processarJobReivindicado({ ...job, expira_em: new Date(Date.now() - 1000).toISOString() }, ctxJob(whatsAppService));
    assert.equal(r.resultado, "POSSE_PERDIDA");
    assert.equal((await linha(m.job.id)).status, SM.PROCESSING, "a linha do outro worker foi mexida");
    assert.equal(chamadas.length, 0);
  });
});

describe("PRODUTO — a MENSAGEM expira, a PENDÊNCIA não (ciclo completo)", { skip: PULAR_INTEGRACAO }, () => {
  const snapshotCom = () => ({
    d1: "2026-06-01", total: 1, organizacoesMonitoradas: [orgA],
    unidades: [{ organizacaoId: orgA, unidadeId: unidadeA, criticidade: SEVERIDADE.ATENCAO, pendenciaMaisAntiga: "2026-06-01", diasPendentes: 2, unidadeNome: "Loja TTL", empresaNome: "Rede TTL", pendenciaHerdada: false }],
  });
  const snapshotSem = () => ({ d1: "2026-06-01", total: 0, unidades: [], organizacoesMonitoradas: [orgA] });
  const ciclo = (whatsAppService, snapshot, extra = {}) => executarCiclo({
    whatsAppService, agora: new Date(), organizacaoId: orgA, worker: `prod-${tag}`, resolverHabilitacao: HABILITADA, lerPendencias: async () => snapshot, ...extra,
  });

  test("pendência existe -> mensagem expira -> CANCELLED/EXPIRADA -> alerta CONTINUA ATIVO -> provider 0 -> ciclos repetidos NÃO criam :v2; depois a pendência some -> alerta RESOLVED", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await habilitarOrganizacao(orgA, { contatoId, perfilId });
    const { chamadas, whatsAppService } = providerComSpy();
    // agenda pelo caminho REAL (detectar -> agendar atômico), com o envio no futuro para o lote não enviá-la ainda
    await detectarESincronizarAlertas({ pendenciasSnapshot: snapshotCom() });
    const { data: alerta } = await supabase.from("comunicacao_alertas").select("*").eq("organizacao_id", orgA).eq("data_referencia", "2026-06-01").single();
    const ag = await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2030-06-05T13:00:00Z"), resolverHabilitacao: HABILITADA });
    assert.equal(ag.agendados, 1, JSON.stringify(ag));
    const [msg] = await msgsDoAlerta(alerta.id);
    assert.equal(msg.status, SM.SCHEDULED);
    assert.equal(await statusAlerta(alerta.id), SA.SCHEDULED);
    // a mensagem envelhece (TTL vencido) enquanto a pendência CONTINUA existindo
    await supabase.from("comunicacao_mensagens").update({ disponivel_em: new Date(Date.now() - 2 * HORA).toISOString(), expira_em: new Date(Date.now() - 1000).toISOString() }).eq("id", msg.id);

    for (let i = 1; i <= 3; i++) {
      const c = await ciclo(whatsAppService, snapshotCom());
      assert.equal(c.deteccao.resolvidos, 0, `ciclo ${i}: resolveu uma pendência que ainda existe`);
      assert.equal(c.agendamento.agendados, 0, `ciclo ${i}: criou uma mensagem nova (:v2) sozinho`);
    }
    const l = await linha(msg.id);
    assert.deepEqual([l.status, l.erro, l.tentativas, l.claim_geracao], [SM.CANCELLED, "EXPIRADA", 0, 0], "a mensagem expirada nunca foi reivindicada/tentada");
    assert.equal(chamadas.length, 0, "o provider foi chamado por uma mensagem expirada");
    assert.equal(await statusAlerta(alerta.id), SA.DETECTED, "o alerta continua representando a pendência ativa (não CANCELLED/RESOLVED)");
    assert.equal((await msgsDoAlerta(alerta.id)).length, 1, "nasceu outra mensagem para o mesmo evento");
    assert.equal((await supabase.from("comunicacao_alertas").select("id", { count: "exact", head: true }).eq("organizacao_id", orgA).eq("data_referencia", "2026-06-01")).count, 1);
    // o agendamento reconhece a mensagem expirada e NÃO recria
    const re = await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date(), resolverHabilitacao: HABILITADA });
    assert.equal(re.mensagensExpiradas, 1, JSON.stringify(re));
    assert.equal(re.agendados, 0);

    // TTL + resolução: a pendência some -> RESOLVED (e assim fica)
    const fim = await ciclo(whatsAppService, snapshotSem());
    assert.equal(fim.deteccao.resolvidos, 1);
    assert.equal(await statusAlerta(alerta.id), SA.RESOLVED);
    assert.equal((await linha(msg.id)).status, SM.CANCELLED, "a mensagem expirada continua CANCELLED/EXPIRADA");
    assert.equal(chamadas.length, 0);
    assert.equal((await msgsDoAlerta(alerta.id)).length, 1);
  });

  test("a expiração NUNCA cancela nem resolve a pendência, mesmo com muitos lotes: só `pendencias()` resolve", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const par = await alertaComMensagem({ campos: { expira_em: new Date(Date.now() - 1000).toISOString() } });
    const { chamadas, whatsAppService } = providerComSpy();
    for (let i = 0; i < 4; i++) await lote(whatsAppService);
    assert.equal(await statusAlerta(par.alerta.id), SA.DETECTED);
    assert.equal(chamadas.length, 0);
    assert.notEqual(await statusAlerta(par.alerta.id), SA.CANCELLED);
    assert.equal((await supabase.from("comunicacao_alertas").select("cancelado_em, resolvido_em").eq("id", par.alerta.id).single()).data.cancelado_em, null);
  });
});

describe("DELIVERY_UNKNOWN — TRANSPORTE fica na mensagem; o ALERTA segue sendo a pendência de NEGÓCIO", { skip: PULAR_INTEGRACAO }, () => {
  async function gerarUnknown() {
    const par = await alertaComMensagem();
    const { provider, chamadas, whatsAppService } = providerComSpy();
    provider.falharProximoEnvio({ mensagem: "conexão caiu durante o envio" }); // ambíguo => INCERTO
    const r = await lote(whatsAppService);
    assert.equal(r.find((x) => x.id === par.job.id)?.resultado, "ENTREGA_INCERTA");
    assert.equal(chamadas.length, 1);
    return { ...par, whatsAppService, chamadas };
  }

  test("envio ambíguo: a mensagem vira DELIVERY_UNKNOWN e o ALERTA NÃO muda (continua a pendência ativa); DELIVERY_UNKNOWN nem existe no domínio do alerta", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const { alerta, job } = await gerarUnknown();
    assert.equal((await linha(job.id)).status, SM.DELIVERY_UNKNOWN);
    assert.equal(await statusAlerta(alerta.id), SA.SCHEDULED, "o alerta assumiu um estado de transporte");
    assert.equal(SA.DELIVERY_UNKNOWN, undefined, "STATUS_ALERTA não pode conhecer DELIVERY_UNKNOWN");
    const invalido = await supabase.from("comunicacao_alertas").update({ status: "DELIVERY_UNKNOWN" }).eq("id", alerta.id);
    assert.ok(invalido.error, "o banco aceitou DELIVERY_UNKNOWN como status de alerta");
  });

  test("UNKNOWN + pendência PERSISTENTE: alerta continua ativo, nenhum agendamento/:v2/lembrete, o provider não é chamado de novo — e o rate limit/cooldown continuam contando", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await habilitarOrganizacao(orgA, { contatoId, perfilId }); // habilitação REAL: a RPC recusa por causa do UNKNOWN, não por falta dela
    const { alerta, job, chamadas, whatsAppService } = await gerarUnknown();
    // 1) o scheduler não faz nada (o alerta não está mais DETECTED)
    const r = await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date(), resolverHabilitacao: HABILITADA });
    assert.equal(r.agendados, 0);
    assert.equal(await statusAlerta(alerta.id), SA.SCHEDULED, "a pendência continua ativa");
    // 2) PIOR CASO: alerta forçado a DETECTED + tentativa de :v2 -> a RPC recusa por causa da mensagem UNKNOWN
    await supabase.from("comunicacao_alertas").update({ status: SA.DETECTED }).eq("id", alerta.id);
    const v2 = await filaRepo.agendarMensagemDoAlerta({
      alertaId: alerta.id, tipo: TIPO, conteudo: "lembrete", idempotencyKey: `wa:alerta:${alerta.id}:v2`,
      disponivelEm: new Date(), expiraEm: new Date(Date.now() + DIA),
    });
    assert.equal(v2.acao, "ENTREGA_DESCONHECIDA");
    assert.equal((await msgsDoAlerta(alerta.id)).length, 1, "nasceu uma segunda mensagem para o evento");
    // 3) a mesma pendência que continua NÃO cria outro alerta (o UNKNOWN segue ativo) e o lote não reenvia nada
    await supabase.from("comunicacao_alertas").update({ status: SA.SCHEDULED }).eq("id", alerta.id);
    const { alerta: mesmo, criado } = await alertasRepo.criarOuEscalonarAlerta({
      organizacaoId: orgA, unidadeId: unidadeA, tipoAlerta: TIPO, dataReferencia: alerta.data_referencia, destinatarioPerfilId: null, severidade: SEVERIDADE.ATENCAO,
    });
    assert.equal(criado, false);
    assert.equal(mesmo.id, alerta.id);
    await supabase.from("comunicacao_mensagens").update({ disponivel_em: new Date(Date.now() - DIA).toISOString(), claim_expira_em: new Date(Date.now() - DIA).toISOString() }).eq("id", job.id);
    assert.equal((await lote(whatsAppService)).some((x) => x.id === job.id), false);
    assert.equal(chamadas.length, 1, "houve segundo envio");
    assert.equal((await linha(job.id)).status, SM.DELIVERY_UNKNOWN);
  });

  test("defesa em profundidade: uma SEGUNDA mensagem do mesmo alerta (linha legada, :v2) enquanto há UNKNOWN é BLOQUEADA (DUPLICATE) e o provider não é chamado; o ALERTA não é marcado BLOCKED por causa dela", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const { alerta, job, chamadas, whatsAppService } = await gerarUnknown();
    const { data: v2, error } = await supabase.from("comunicacao_mensagens").insert({
      alerta_id: alerta.id, organizacao_id: orgA, unidade_id: unidadeA, ...(await (async () => { const cv = await novoContato(); return { contato_id: cv, contato_empresa_id: await responsavelDoContato({ organizacaoId: orgA, contatoId: cv, perfilId }) }; })()), destinatario_perfil_id: perfilId,
      canal: "whatsapp", direcao: "saida", tipo: `tipo_v2_${tag}`, conteudo: "lembrete", idempotency_key: `wa:alerta:${alerta.id}:v2`,
      status: SM.SCHEDULED, disponivel_em: new Date(Date.now() - 60_000).toISOString(),
    }).select("*").single();
    assert.equal(error, null, error?.message);
    const r = (await lote(whatsAppService)).find((x) => x.id === v2.id);
    assert.equal(r?.resultado, "BLOQUEADO", JSON.stringify(r));
    assert.equal(r?.motivo, "DUPLICATE");
    assert.equal(chamadas.length, 1, "o :v2 foi enviado apesar do UNKNOWN do mesmo evento");
    assert.equal((await linha(v2.id)).status, SM.BLOCKED);
    assert.equal((await linha(job.id)).status, SM.DELIVERY_UNKNOWN);
    assert.equal(await statusAlerta(alerta.id), SA.SCHEDULED, "o bloqueio do :v2 (DUPLICATE) não pode marcar a PENDÊNCIA como BLOCKED");
  });

  test("UNKNOWN + pendência que DESAPARECE: alerta RESOLVED, a mensagem CONTINUA DELIVERY_UNKNOWN (exige reconciliação), nenhum envio novo; a reconciliação tardia não reabre o alerta", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await habilitarOrganizacao(orgA, { contatoId, perfilId });
    const { alerta, job, chamadas, whatsAppService } = await gerarUnknown();
    const r = await detectarESincronizarAlertas({ pendenciasSnapshot: { unidades: [], organizacoesMonitoradas: [orgA], d1: "2026-06-01" } });
    assert.equal(r.resolvidos, 1, "a incerteza de TRANSPORTE impediu reconhecer que a pendência de NEGÓCIO acabou");
    assert.equal(await statusAlerta(alerta.id), SA.RESOLVED);
    const l = await linha(job.id);
    assert.equal(l.status, SM.DELIVERY_UNKNOWN, "a mensagem UNKNOWN foi tocada: continua exigindo reconciliação");
    assert.equal(l.tentativas, 1);
    // nenhum envio novo por causa disso: agendador, lote e varredura
    assert.equal((await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date(), resolverHabilitacao: HABILITADA })).agendados, 0);
    await supabase.from("comunicacao_mensagens").update({ disponivel_em: new Date(Date.now() - DIA).toISOString(), claim_expira_em: new Date(Date.now() - DIA).toISOString() }).eq("id", job.id);
    assert.equal((await lote(whatsAppService)).some((x) => x.id === job.id), false);
    assert.equal(chamadas.length, 1, "houve segundo envio");
    assert.equal((await msgsDoAlerta(alerta.id)).length, 1);
    // a reconciliação humana depois: a mensagem vira SENT, o alerta segue RESOLVED (nunca "ressuscita")
    await filaRepo.reconciliarEntrega({ id: job.id, operadorPerfilId: perfilId, resultado: "ENVIADA", motivo: "Confirmado no aparelho do gerente" });
    assert.equal((await linha(job.id)).status, SM.SENT);
    assert.equal(await statusAlerta(alerta.id), SA.RESOLVED);
    // guardas do repositório: só terminais são protegidos (não há mais estado especial de transporte)
    assert.equal(await alertasRepo.resolverAlerta(alerta.id), false);
    assert.equal(await alertasRepo.atualizarStatusAlerta(alerta.id, SA.BLOCKED), false);
  });

  test("a varredura de SENDING com lease vencido move a MENSAGEM para DELIVERY_UNKNOWN; o alerta segue ativo (SCHEDULED)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const par = await alertaComMensagem();
    await supabase.from("comunicacao_mensagens").update({ status: SM.SENDING, claimed_by: "w", claim_geracao: 1, tentativas: 1, claimed_at: new Date(Date.now() - 300_000).toISOString(), claim_expira_em: new Date(Date.now() - 5000).toISOString() }).eq("id", par.job.id);
    const varridas = await filaRepo.expirarEntregasIncertas({ worker: "varredura" });
    assert.ok(varridas.some((m) => m.id === par.job.id));
    assert.equal((await linha(par.job.id)).status, SM.DELIVERY_UNKNOWN);
    assert.equal(await statusAlerta(par.alerta.id), SA.SCHEDULED, "a varredura de transporte não pode mexer no estado de negócio do alerta");
  });

  test("confirmação TARDIA do mesmo attempt (UNKNOWN -> SENT) atualiza o alerta para SENT; um alerta já RESOLVED nunca é 'ressuscitado'", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const par = await alertaComMensagem();
    await supabase.from("comunicacao_mensagens").update({ status: SM.SENDING, claimed_by: "w", claim_geracao: 1, tentativas: 1, claim_expira_em: new Date(Date.now() - 5000).toISOString() }).eq("id", par.job.id);
    await filaRepo.expirarEntregasIncertas({ worker: "varredura" });
    const fin = await filaRepo.finalizarEnvio({ id: par.job.id, worker: "w", claimGeracao: 1, tentativa: 1, resultado: "SENT", providerMessageId: "prov-1" });
    assert.equal(fin?.status, SM.SENT);
    assert.equal(await statusAlerta(par.alerta.id), SA.SENT);

    // alerta RESOLVED + mensagem que termina depois: o alerta continua RESOLVED
    const outra = await alertaComMensagem();
    await supabase.from("comunicacao_mensagens").update({ status: SM.SENDING, claimed_by: "w", claim_geracao: 1, tentativas: 1, claim_expira_em: new Date(Date.now() + 60_000).toISOString() }).eq("id", outra.job.id);
    await detectarESincronizarAlertas({ pendenciasSnapshot: { unidades: [], organizacoesMonitoradas: [orgA], d1: "2026-06-01" } });
    assert.equal(await statusAlerta(outra.alerta.id), SA.RESOLVED);
    assert.equal((await linha(outra.job.id)).status, SM.SENDING, "uma mensagem SENDING nunca é cancelada fisicamente");
    await filaRepo.finalizarEnvio({ id: outra.job.id, worker: "w", claimGeracao: 1, tentativa: 1, resultado: "SENT" });
    assert.equal(await statusAlerta(outra.alerta.id), SA.RESOLVED, "o callback tardio ressuscitou um alerta RESOLVED");
  });
});

describe("RECONCILIAÇÃO humana de DELIVERY_UNKNOWN (contrato backend; sem reenvio automático)", { skip: PULAR_INTEGRACAO }, () => {
  async function unknown() {
    const par = await alertaComMensagem();
    await supabase.from("comunicacao_mensagens").update({ status: SM.DELIVERY_UNKNOWN, entrega_incerta_em: new Date().toISOString(), claimed_by: "w", claim_geracao: 1, tentativas: 1 }).eq("id", par.job.id);
    return par;
  }

  test("ENVIADA: UNKNOWN -> SENT com operador, motivo e timestamp gravados; o alerta acompanha (SENT)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const par = await unknown();
    const r = await filaRepo.reconciliarEntrega({ id: par.job.id, operadorPerfilId: perfilId, resultado: "ENVIADA", motivo: "Confirmado com o gerente no telefone" });
    assert.equal(r.acao, "RECONCILIADA");
    const l = await linha(par.job.id);
    assert.equal(l.status, SM.SENT);
    assert.ok(l.enviado_em);
    assert.equal(l.metadados.reconciliacao.operador, perfilId);
    assert.equal(l.metadados.reconciliacao.resultado, "ENVIADA");
    assert.equal(l.metadados.reconciliacao.motivo, "Confirmado com o gerente no telefone");
    assert.ok(l.metadados.reconciliacao.em, "timestamp");
    assert.equal(await statusAlerta(par.alerta.id), SA.SENT);
  });

  test("NAO_ENVIADA: UNKNOWN -> FAILED (nunca SCHEDULED): NÃO é retry da mesma tentativa, não gera outra mensagem e o claim não a pega", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const par = await unknown();
    const r = await filaRepo.reconciliarEntrega({ id: par.job.id, operadorPerfilId: perfilId, resultado: "NAO_ENVIADA", motivo: "Cliente informou que nada chegou" });
    assert.equal(r.acao, "RECONCILIADA");
    const l = await linha(par.job.id);
    assert.equal(l.status, SM.FAILED);
    assert.equal(l.erro, "RECONCILIADA_NAO_ENVIADA");
    assert.equal(l.erro_permanente, true);
    assert.equal(l.metadados.reconciliacao.resultado, "NAO_ENVIADA");
    assert.equal(await statusAlerta(par.alerta.id), SA.FAILED);
    // sem reenvio automático de nenhum tipo
    const { chamadas, whatsAppService } = providerComSpy();
    assert.equal((await lote(whatsAppService)).some((x) => x.id === par.job.id), false);
    assert.equal((await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date(), resolverHabilitacao: HABILITADA })).agendados, 0);
    assert.equal((await msgsDoAlerta(par.alerta.id)).length, 1, "a reconciliação gerou outra mensagem sozinha");
    assert.equal(chamadas.length, 0);
    assert.equal((await linha(par.job.id)).status, SM.FAILED);
  });

  test("exige operador (existente e ativo), motivo (>= 5 caracteres) e resultado válido — tudo recusado sem tocar a mensagem", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const par = await unknown();
    const base = { id: par.job.id, operadorPerfilId: perfilId, resultado: "ENVIADA", motivo: "motivo válido" };
    for (const [nome, over] of [
      ["sem operador", { operadorPerfilId: null }],
      ["operador inexistente", { operadorPerfilId: "00000000-0000-0000-0000-000000000000" }],
      ["sem motivo", { motivo: null }],
      ["motivo curto", { motivo: "ok" }],
      ["motivo em branco", { motivo: "      " }],
      ["resultado inválido", { resultado: "TALVEZ" }],
      ["retry disfarçado", { resultado: "REENVIAR" }],
    ]) {
      await assert.rejects(() => filaRepo.reconciliarEntrega({ ...base, ...over }), undefined, nome);
      assert.equal((await linha(par.job.id)).status, SM.DELIVERY_UNKNOWN, `${nome}: a mensagem foi tocada`);
    }
    // operador inativo
    await supabase.from("perfis_operacionais").update({ ativo: false }).eq("id", perfilId);
    try { await assert.rejects(() => filaRepo.reconciliarEntrega(base), undefined, "operador inativo"); }
    finally { await supabase.from("perfis_operacionais").update({ ativo: true }).eq("id", perfilId); }
    assert.equal((await linha(par.job.id)).status, SM.DELIVERY_UNKNOWN);
  });

  test("só reconcilia DELIVERY_UNKNOWN: mensagem em outro estado (ou já reconciliada) -> NAO_ENCONTRADA_OU_NAO_UNKNOWN, nada muda", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const sent = await alertaComMensagem({ campos: { status: SM.SENT, enviado_em: new Date().toISOString() } });
    const r = await filaRepo.reconciliarEntrega({ id: sent.job.id, operadorPerfilId: perfilId, resultado: "NAO_ENVIADA", motivo: "tentando reverter um SENT" });
    assert.equal(r.acao, "NAO_ENCONTRADA_OU_NAO_UNKNOWN");
    assert.equal((await linha(sent.job.id)).status, SM.SENT);

    const par = await unknown();
    await filaRepo.reconciliarEntrega({ id: par.job.id, operadorPerfilId: perfilId, resultado: "ENVIADA", motivo: "primeira reconciliação" });
    const segunda = await filaRepo.reconciliarEntrega({ id: par.job.id, operadorPerfilId: perfilId, resultado: "NAO_ENVIADA", motivo: "segunda tentativa (deve falhar)" });
    assert.equal(segunda.acao, "NAO_ENCONTRADA_OU_NAO_UNKNOWN");
    assert.equal((await linha(par.job.id)).status, SM.SENT, "uma reconciliação foi sobrescrita por outra");
  });
});

describe("resolução de pendência (snapshot do ciclo)", { skip: PULAR_INTEGRACAO }, () => {
  const snapshotSem = (orgs) => ({ unidades: [], organizacoesMonitoradas: orgs, d1: "2026-06-01" });
  const snapshotCom = (over = {}) => ({
    d1: "2026-06-01", organizacoesMonitoradas: [orgA],
    unidades: [{ organizacaoId: orgA, unidadeId: unidadeA, criticidade: SEVERIDADE.ATENCAO, pendenciaMaisAntiga: "2026-06-01", diasPendentes: 2, unidadeNome: "Loja TTL", empresaNome: "Rede TTL", pendenciaHerdada: false, ...over }],
  });

  test("pendência sumiu: alerta RESOLVED e mensagem SCHEDULED CANCELLED (nunca enviada)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const par = await alertaComMensagem({ campos: { disponivel_em: new Date(Date.now() + HORA).toISOString() } });
    const r = await detectarESincronizarAlertas({ pendenciasSnapshot: snapshotSem([orgA]) });
    assert.equal(r.resolvidos, 1);
    assert.equal(r.detalheResolvidos[0].mensagensCanceladas, 1);
    assert.equal(await statusAlerta(par.alerta.id), SA.RESOLVED);
    assert.equal((await linha(par.job.id)).status, SM.CANCELLED);
  });

  test("organização que ZEROU as pendências (não aparece mais em `unidades`) também tem os alertas resolvidos", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const par = await alertaComMensagem();
    // o snapshot monitorou A mas não lista nenhuma unidade com problema
    assert.equal((await detectarESincronizarAlertas({ pendenciasSnapshot: snapshotSem([orgA]) })).resolvidos, 1);
    assert.equal(await statusAlerta(par.alerta.id), SA.RESOLVED);
  });

  test("CROSS-ORG: um snapshot que NÃO monitorou a organização A nunca resolve os alertas dela", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const par = await alertaComMensagem();
    const r = await detectarESincronizarAlertas({ pendenciasSnapshot: snapshotSem([orgB]) });
    assert.equal(r.resolvidos, 0);
    assert.equal(await statusAlerta(par.alerta.id), SA.SCHEDULED);
    assert.equal((await linha(par.job.id)).status, SM.SCHEDULED);
  });

  test("mensagem PROCESSING de um alerta resolvido: a sincronização não a toca; o próprio job a cancela (ALERTA_ENCERRADO) e o provider nunca é chamado", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const par = await alertaComMensagem();
    const job = await emProcessamento(par.job.id);
    await detectarESincronizarAlertas({ pendenciasSnapshot: snapshotSem([orgA]) });
    assert.equal(await statusAlerta(par.alerta.id), SA.RESOLVED);
    assert.equal((await linha(par.job.id)).status, SM.PROCESSING, "a sincronização mexeu numa linha que um worker segura");
    const { chamadas, whatsAppService } = providerComSpy();
    const r = await processarJobReivindicado(job, ctxJob(whatsAppService));
    assert.equal(r.resultado, "CANCELADO_ALERTA_ENCERRADO");
    assert.equal((await linha(par.job.id)).status, SM.CANCELLED);
    assert.equal(chamadas.length, 0, "enviou o aviso de um alerta já resolvido");
  });

  test("a mesma pendência que PERSISTE (alerta já RESOLVED de mesma chave) não vira erro nem evento novo", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const alerta = await novoAlerta({ data: "2026-06-01" });
    await alertasRepo.resolverAlerta(alerta.id);
    const r = await detectarESincronizarAlertas({ pendenciasSnapshot: snapshotCom() });
    assert.equal(r.criados, 0);
    assert.equal(r.terminaisIgnorados, 1);
    const { count } = await supabase.from("comunicacao_alertas").select("id", { count: "exact", head: true }).eq("organizacao_id", orgA).eq("data_referencia", "2026-06-01");
    assert.equal(count, 1);
    assert.equal((await msgsDoAlerta(alerta.id)).length, 0);
  });

  test("criarOuEscalonarAlerta com alerta terminal de mesma chave: devolve {terminal:true}, nunca lança erro interno (23505)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const alerta = await novoAlerta({ data: "2026-06-02" });
    await supabase.from("comunicacao_alertas").update({ status: SA.CANCELLED, cancelado_em: new Date().toISOString() }).eq("id", alerta.id); // cancelamento de NEGÓCIO (fora do TTL)
    const r = await alertasRepo.criarOuEscalonarAlerta({ organizacaoId: orgA, unidadeId: unidadeA, tipoAlerta: TIPO, dataReferencia: "2026-06-02", destinatarioPerfilId: null, severidade: SEVERIDADE.ATENCAO });
    assert.equal(r.terminal, true);
    assert.equal(r.criado, false);
    assert.equal(r.alerta.id, alerta.id);
  });

  test("um snapshot com a pendência cria o alerta com os nomes (metadados) e o segundo processamento não duplica", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const r1 = await detectarESincronizarAlertas({ pendenciasSnapshot: snapshotCom({ pendenciaMaisAntiga: "2026-06-03" }) });
    const r2 = await detectarESincronizarAlertas({ pendenciasSnapshot: snapshotCom({ pendenciaMaisAntiga: "2026-06-03" }) });
    assert.equal(r1.criados, 1);
    assert.equal(r2.criados, 0);
    const { data } = await supabase.from("comunicacao_alertas").select("metadados").eq("organizacao_id", orgA).eq("data_referencia", "2026-06-03").single();
    assert.equal(data.metadados.unidade_nome, "Loja TTL");
    assert.equal(data.metadados.empresa_nome, "Rede TTL");
  });
});

describe("pendencias() UMA vez por lote/ciclo", { skip: PULAR_INTEGRACAO }, () => {
  /** supabase que CONTA quantas vezes `avaliarFrota` leu o catálogo de módulos (uma vez por leitura de pendencias()). */
  function comContagem() {
    const contagem = { leiturasDaFrota: 0 };
    const proxy = new Proxy(supabase, {
      get(alvo, prop) {
        if (prop === "from") return (tabela) => { if (tabela === "organizacao_modulos") contagem.leiturasDaFrota += 1; return alvo.from(tabela); };
        const v = alvo[prop];
        return typeof v === "function" ? v.bind(alvo) : v;
      },
    });
    return { contagem, proxy };
  }

  test("lote com 4 jobs de alertas: `pendencias()` é lido EXATAMENTE 1 vez (não 4)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const pares = [];
    for (let i = 0; i < 4; i++) pares.push(await alertaComMensagem());
    const { contagem, proxy } = comContagem();
    const { whatsAppService } = providerComSpy();
    const r = await processarProximoLote({
      limite: 20, worker: `pend-${tag}`, whatsAppService, agora: new Date(), resolverHabilitacao: HABILITADA, // SEM `verificarPendenciaAindaExiste`: usa o snapshot do lote
    }, { supabase: proxy });
    const meus = r.filter((x) => pares.some((p) => p.job.id === x.id));
    assert.equal(meus.length, 4);
    assert.equal(contagem.leiturasDaFrota, 1, `leu a frota ${contagem.leiturasDaFrota}x para 4 jobs`);
  });

  test("com o snapshot do CICLO já em mãos, o lote não lê a frota nenhuma vez; e sem nenhum job, também não", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const par = await alertaComMensagem();
    const { contagem, proxy } = comContagem();
    const { chamadas, whatsAppService } = providerComSpy();
    const snapshot = { d1: "2026-06-01", unidades: [{ organizacaoId: orgA, unidadeId: unidadeA, criticidade: SEVERIDADE.ATENCAO }], organizacoesMonitoradas: [orgA] };
    const r = await processarProximoLote({ limite: 20, worker: `snap-${tag}`, whatsAppService, agora: new Date(), resolverHabilitacao: HABILITADA, pendenciasSnapshot: snapshot }, { supabase: proxy });
    assert.equal(r.find((x) => x.id === par.job.id)?.resultado, "ENVIADO");
    assert.equal(chamadas.length, 1);
    assert.equal(contagem.leiturasDaFrota, 0);
    // fila vazia -> nenhuma leitura da frota
    const vazio = comContagem();
    await processarProximoLote({ limite: 20, worker: `vazio-${tag}`, whatsAppService, agora: new Date(), resolverHabilitacao: HABILITADA }, { supabase: vazio.proxy });
    assert.equal(vazio.contagem.leiturasDaFrota, 0);
  });

  test("CICLO completo (detectar -> agendar -> processar): UMA leitura da frota; o alerta nasce do snapshot, vira mensagem, é enviado e termina SENT", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await habilitarOrganizacao(orgA, { contatoId, perfilId }); // destinatário EXPLÍCITO (o banco o lê)
    let leituras = 0;
    const snapshot = {
      dataReferencia: "2026-06-05", d1: "2026-06-04", total: 1, organizacoesMonitoradas: [orgA],
      unidades: [{ organizacaoId: orgA, unidadeId: unidadeA, criticidade: SEVERIDADE.ATENCAO, pendenciaMaisAntiga: "2026-06-04", diasPendentes: 3, unidadeNome: "Loja Ciclo", empresaNome: "Rede Ciclo", pendenciaHerdada: false }],
    };
    const { chamadas, whatsAppService, provider } = providerComSpy();
    const r = await executarCiclo({
      whatsAppService, agora: new Date(), organizacaoId: orgA, worker: `ciclo-${tag}`, resolverHabilitacao: HABILITADA,
      lerPendencias: async () => { leituras += 1; return snapshot; },
    });
    assert.equal(leituras, 1, "o ciclo leu a frota mais de uma vez");
    assert.equal(r.snapshot.d1, "2026-06-04");
    assert.equal(r.deteccao.criados, 1);
    assert.equal(r.agendamento.agendados, 1);
    const enviado = r.lote.filter((x) => x.resultado === "ENVIADO");
    assert.ok(enviado.length >= 1, JSON.stringify(r.lote));
    const { data: alerta } = await supabase.from("comunicacao_alertas").select("*").eq("organizacao_id", orgA).eq("data_referencia", "2026-06-04").single();
    assert.equal(alerta.status, SA.SENT);
    const msgs = await msgsDoAlerta(alerta.id);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].status, SM.SENT);
    assert.match(provider.mensagensEnviadas.at(-1).texto, /Loja Ciclo/);
    assert.equal(chamadas.length, 1);
    assert.equal(msgs[0].contato_id, contatoId, "enviou para quem NÃO é o destinatário configurado");
    // o segundo ciclo com a MESMA pendência não gera nada novo (cooldown/idempotência/alerta ativo)
    let leituras2 = 0;
    const r2 = await executarCiclo({
      whatsAppService, agora: new Date(), organizacaoId: orgA, worker: `ciclo2-${tag}`, resolverHabilitacao: HABILITADA,
      lerPendencias: async () => { leituras2 += 1; return snapshot; },
    });
    assert.equal(leituras2, 1);
    assert.equal(r2.deteccao.criados, 0);
    assert.equal(r2.agendamento.agendados, 0);
    assert.equal(chamadas.length, 1, "a pendência persistente gerou um segundo envio");
    assert.equal((await msgsDoAlerta(alerta.id)).length, 1);
  });

  test("DESTINATÁRIO no ciclo: dois contatos elegíveis e NENHUM selecionado -> 0 mensagens, 0 envios; com um EXPLICITAMENTE selecionado -> só ele", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const outro = await criarDestinatario({ organizacaoId: orgA, unidadeId: unidadeA, tag, sufixo: "outro" }); // 2º contato elegível da mesma organização
    try {
      const snapshot = { dataReferencia: "2026-06-10", d1: "2026-06-09", total: 1, organizacoesMonitoradas: [orgA],
        unidades: [{ organizacaoId: orgA, unidadeId: unidadeA, criticidade: SEVERIDADE.ATENCAO, pendenciaMaisAntiga: "2026-06-09", diasPendentes: 2, unidadeNome: "Loja D", empresaNome: "Rede D", pendenciaHerdada: false }] };
      const { chamadas, whatsAppService } = providerComSpy();
      // organização com linha de habilitação FECHADA e nenhum destinatário selecionado (habilitada exigiria um)
      await supabase.from("comunicacao_habilitacoes").insert({ organizacao_id: orgA, habilitado: false, tipos_permitidos: [TIPO], timezone: "America/Fortaleza" });
      const r1 = await executarCiclo({ whatsAppService, agora: new Date(), organizacaoId: orgA, worker: `dest-${tag}`, lerPendencias: async () => snapshot }); // resolvedor REAL
      assert.equal(r1.agendamento.agendados, 0);
      assert.equal(chamadas.length, 0, "enviou sem destinatário configurado");
      assert.equal((await supabase.from("comunicacao_mensagens").select("id", { count: "exact", head: true }).eq("organizacao_id", orgA)).count, 0);
      // seleciona EXPLICITAMENTE o segundo
      await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", orgA);
      await habilitarOrganizacao(orgA, outro);
      const r2 = await executarCiclo({ whatsAppService, agora: new Date(), organizacaoId: orgA, worker: `dest2-${tag}`, resolverHabilitacao: HABILITADA, lerPendencias: async () => snapshot });
      assert.equal(r2.agendamento.agendados, 1, JSON.stringify(r2.agendamento));
      const [m] = (await supabase.from("comunicacao_mensagens").select("contato_id").eq("organizacao_id", orgA)).data;
      assert.equal(m.contato_id, outro.contatoId, "a mensagem foi para o contato errado");
      assert.notEqual(m.contato_id, contatoId);
    } finally {
      // a habilitação aponta para o contato (FK sem cascade, de propósito): remove-a antes, senão o contato/conta não saem
      await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", orgA);
      await apagarDestinatario(outro);
    }
  });
});
