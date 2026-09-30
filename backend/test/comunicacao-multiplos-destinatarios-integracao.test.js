// VÁRIOS DESTINATÁRIOS por empresa (migration 104) — PIPELINE REAL contra o Supabase de TESTE (descartável): agendamento transacional por
// destinatário, idempotência por alerta+destinatário+propósito (inclusive sob concorrência), cooldown/limites separados (destinatário × empresa),
// falha/opt-out/desativação INDIVIDUAIS, status agregado do alerta (máquina de estados formal), reforço por destinatário, jitter por destinatário,
// KILL SWITCH (modo=DISABLED) e DRY-RUN somente leitura.
// PULA (não falha) sem credencial de banco descartável / sem a migration 104.
// Rodar: node --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-multiplos-destinatarios-integracao.test.js
import { test, describe, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, migracao082Aplicada, migracao088Aplicada, migracao104Aplicada,
  criarDestinatarioEmpresa, apagarDestinatarioEmpresa, habilitarEmpresaMulti, definirTetoDestinatariosT, restaurarTetoDestinatariosT,
} from "./helpers/comunicacao-fixtures.js";
import * as alertasRepo from "../src/modules/comunicacao/comunicacao.alertas.repo.js";
import * as filaRepo from "../src/modules/comunicacao/comunicacao.fila.repo.js";
import {
  processarProximoLote, processarJobReivindicado, agendarEnviosPendentes, agendarReforcosPendentes, agendarAvisosTardiosD1,
} from "../src/modules/comunicacao/comunicacao.alertas.service.js";
import { definirModo, modoAtual } from "../src/modules/comunicacao/comunicacao.config.js";
import { criarWhatsAppService, ModoDesabilitadoError } from "../src/modules/comunicacao/whatsapp.service.js";
import { criarFakeProvider } from "../src/modules/comunicacao/providers/fake.provider.js";
import { enviarMensagemTeste } from "../src/modules/comunicacao/comunicacao.teste.js";
import { simularCiclo } from "../src/modules/comunicacao/comunicacao.dryrun.js";
import { calcularInstanteDeEnvio } from "../src/modules/comunicacao/comunicacao.disponibilidade.js";
import { chaveDeJitter } from "../src/modules/comunicacao/comunicacao.adiamento.js";
import { chaveIdempotenciaDestinatario } from "../src/modules/comunicacao/comunicacao.reforco.js";
import { MODOS, TIPOS_ALERTA, SEVERIDADE, STATUS_ALERTA as SA, STATUS_MENSAGEM as SM } from "../src/modules/comunicacao/comunicacao.constants.js";
import { randomUUID } from "node:crypto";

const PULAR_INTEGRACAO = motivoPularIntegracao();
const TIPO = TIPOS_ALERTA.DASHBOARD_IFOOD_D1;
const HORA = 3_600_000;
const MIN = 60_000;
// Quarta 16/09/2026 10:00 em Fortaleza (dentro da janela comercial). D-1 = 2026-09-15; usamos uma referência antiga para não esperar a disponibilidade do iFood.
const AGORA = new Date("2026-09-16T13:00:00Z");
const DOMINGO = new Date("2026-09-20T13:00:00Z");
const DATA_ANTIGA = "2026-09-10";
const LIMITES = { max_proativas_por_minuto: 1000, max_proativas_por_minuto_por_organizacao: 1000, max_por_contato_por_dia: 3, max_por_organizacao_por_dia: 1000 };

let migracaoOk = true;
let modoOriginal = null, limitesOriginais = null, tetoOriginal = null;
let orgA = null, orgB = null, unidadeA = null, unidadeA2 = null, unidadeB = null;
let criados = [];
let seqData = 0;

const sk = (t) => t.skip(PULAR_INTEGRACAO || "migration 104 ainda não aplicada — pulando.");
const definirLimites = (l) => supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: l }, { onConflict: "chave" });

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada()) && (await migracao104Aplicada());
  if (!migracaoOk) return;
  modoOriginal = await modoAtual();
  limitesOriginais = (await supabase.from("comunicacao_configuracoes").select("valor").eq("chave", "limites").maybeSingle()).data?.valor ?? null;
  tetoOriginal = await definirTetoDestinatariosT(50);
  orgA = await criarOrganizacao("TESTE multiplos A — descartável");
  orgB = await criarOrganizacao("TESTE multiplos B — descartável");
  unidadeA = await criarUnidade(orgA, "Unidade M A1");
  unidadeA2 = await criarUnidade(orgA, "Unidade M A2");
  unidadeB = await criarUnidade(orgB, "Unidade M B1");
});

after(async () => {
  if (modoOriginal) await definirModo(modoOriginal, {}).catch(() => {});
  if (limitesOriginais) await definirLimites(limitesOriginais);
  await restaurarTetoDestinatariosT(tetoOriginal);
  for (const d of criados) await apagarDestinatarioEmpresa(d);
  await apagarOrganizacao(orgA); await apagarOrganizacao(orgB);
});

beforeEach(async () => {
  if (PULAR_INTEGRACAO || !migracaoOk) return;
  await definirLimites(LIMITES);
  await definirModo(MODOS.NORMAL, {});
  await supabase.from("comunicacao_mensagens").delete().in("organizacao_id", [orgA, orgB]);
  await supabase.from("comunicacao_alertas").delete().in("organizacao_id", [orgA, orgB]);
  await supabase.from("comunicacao_habilitacoes").delete().in("organizacao_id", [orgA, orgB]);
  await supabase.from("comunicacao_contatos_empresa").delete().in("organizacao_id", [orgA, orgB]);
  await habilitarEmpresaMulti(orgA);
});

afterEach(async () => {
  if (PULAR_INTEGRACAO || !migracaoOk) return;
  for (const d of criados) await apagarDestinatarioEmpresa(d);
  criados = [];
});

const dest = async (nome, extra = {}, org = orgA) => { const d = await criarDestinatarioEmpresa({ organizacaoId: org, nome, ...extra }); criados.push(d); return d; };
const novoAlerta = async ({ org = orgA, unidade = unidadeA, data = null } = {}) => {
  const { alerta } = await alertasRepo.criarOuEscalonarAlerta({
    organizacaoId: org, unidadeId: unidade, tipoAlerta: TIPO, dataReferencia: data ?? `2026-08-${String(1 + (++seqData % 27)).padStart(2, "0")}`, destinatarioPerfilId: null,
    severidade: SEVERIDADE.ATENCAO, motivo: "3 dia(s) pendente(s)", metadados: { unidade_nome: "Loja Multi", empresa_nome: "Rede Multi" },
  });
  return alerta;
};
const msgsDoAlerta = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("alerta_id", id).order("created_at")).data ?? [];
const statusAlerta = async (id) => (await supabase.from("comunicacao_alertas").select("status").eq("id", id).single()).data.status;
const linha = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("id", id).single()).data;
const agendar = (agora = AGORA, extra = {}) => agendarEnviosPendentes({ organizacaoId: orgA, agora, ...extra });
/** Torna as mensagens do alerta claimáveis JÁ e com TTL futuro (o relógio real do banco decide o claim; `AGORA` é só o instante lógico da política). */
const liberar = (alertaId) => supabase.from("comunicacao_mensagens")
  .update({ disponivel_em: new Date(Date.now() - MIN).toISOString(), expira_em: new Date(Date.now() + 2 * HORA).toISOString() }).eq("alerta_id", alertaId).eq("status", SM.SCHEDULED);

/** FakeProvider com SPY por chamada (telefone + chave) e falha injetável POR TELEFONE. */
function provedor({ falhar = {} } = {}) {
  const provider = criarFakeProvider();
  const chamadas = [];
  const original = provider.sendText.bind(provider);
  provider.sendText = async (args) => {
    chamadas.push(args);
    const f = falhar[args.telefoneE164];
    if (f) { const e = new Error(f.mensagem ?? "falha injetada"); e.permanente = !!f.permanente; e.preEnvio = !!f.preEnvio; throw e; }
    return original(args);
  };
  return { provider, chamadas, whatsAppService: criarWhatsAppService({ provider, semGateIdentidade: true, semGateModo: true }) };
}
const lote = (whatsAppService, extra = {}) => processarProximoLote({
  limite: 20, worker: "multi", whatsAppService, agora: AGORA, verificarPendenciaAindaExiste: async () => true, ...extra,
});
const porMsg = (rs, id) => rs.find((r) => r.id === id);

// ---------------------------------------------------------------------------
describe("agendamento POR DESTINATÁRIO — transacional e idempotente", { skip: PULAR_INTEGRACAO }, () => {
  test("uma mensagem INDIVIDUAL por destinatário elegível; inelegíveis (opt-out, sem categoria, inativo, não autorizado) NÃO recebem", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João"), maria = await dest("Maria");
    await dest("OptOut", { optOut: true }); await dest("SemCategoria", { categorias: [] }); await dest("Inativo", { ativo: false }); await dest("NaoAutorizado", { validado: false });
    const alerta = await novoAlerta();
    const r = await agendar();
    assert.equal(r.agendados, 2, JSON.stringify(r));
    const msgs = await msgsDoAlerta(alerta.id);
    assert.deepEqual(msgs.map((m) => m.contato_empresa_id).sort(), [joao.contatoEmpresaId, maria.contatoEmpresaId].sort());
    for (const m of msgs) {
      assert.equal(m.idempotency_key, chaveIdempotenciaDestinatario({ alertaId: alerta.id, contatoEmpresaId: m.contato_empresa_id }));
      assert.equal(m.status, SM.SCHEDULED);
      assert.equal(m.unidade_id, unidadeA);
      assert.match(m.conteudo, /Loja Multi/);
    }
    assert.equal(await statusAlerta(alerta.id), SA.SCHEDULED);
    // repetir o ciclo N vezes NUNCA cria outra (o alerta já não está DETECTED)
    for (let i = 0; i < 5; i++) assert.equal((await agendar()).agendados, 0);
    assert.equal((await msgsDoAlerta(alerta.id)).length, 2);
  });

  test("CONCORRÊNCIA: 20 chamadas simultâneas da RPC para o mesmo alerta -> exatamente UMA mensagem por destinatário", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João"), maria = await dest("Maria");
    const alerta = await novoAlerta();
    const itens = [joao, maria].map((d) => ({ contatoEmpresaId: d.contatoEmpresaId, conteudo: "aviso", disponivelEm: new Date(Date.now() - MIN), expiraEm: new Date(Date.now() + HORA) }));
    const rs = await Promise.all(Array.from({ length: 20 }, () => filaRepo.agendarMensagensDoAlerta({ alertaId: alerta.id, proposito: "inicial", itens })));
    const criadas = rs.flatMap((r) => r.itens ?? []).filter((i) => i.acao === "CRIADA").length;
    assert.equal(criadas, 2, JSON.stringify(rs.map((r) => r.acao)));
    assert.equal((await msgsDoAlerta(alerta.id)).length, 2);
    // e com o alerta forçado de volta a DETECTED (resíduo/expiração): cada destinatário -> JA_EXISTIA, nada novo
    await supabase.from("comunicacao_alertas").update({ status: SA.DETECTED }).eq("id", alerta.id);
    const de_novo = await filaRepo.agendarMensagensDoAlerta({ alertaId: alerta.id, proposito: "inicial", itens });
    assert.deepEqual(de_novo.itens.map((i) => i.acao), ["JA_EXISTIA", "JA_EXISTIA"]);
    assert.equal((await msgsDoAlerta(alerta.id)).length, 2);
  });

  test("DOIS 'ciclos' (workers) do scheduler ao mesmo tempo sobre o mesmo alerta -> 2 mensagens no total, uma por destinatário", async (t) => {
    if (!migracaoOk) return sk(t);
    await dest("João"); await dest("Maria");
    const alerta = await novoAlerta();
    const rs = await Promise.all(Array.from({ length: 6 }, () => agendar()));
    assert.equal(rs.reduce((n, r) => n + r.agendados, 0), 2, JSON.stringify(rs));
    assert.equal((await msgsDoAlerta(alerta.id)).length, 2);
  });

  test("uma mensagem já enviada ao João NUNCA impede a Maria de receber o mesmo alerta (e o João não recebe duas vezes)", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João");
    const alerta = await novoAlerta();
    assert.equal((await agendar()).agendados, 1);
    // a Maria é cadastrada depois; o alerta continua sendo o MESMO evento lógico
    const maria = await dest("Maria");
    await supabase.from("comunicacao_alertas").update({ status: SA.DETECTED }).eq("id", alerta.id);
    const r = await filaRepo.agendarMensagensDoAlerta({
      alertaId: alerta.id, proposito: "inicial",
      itens: [joao, maria].map((d) => ({ contatoEmpresaId: d.contatoEmpresaId, conteudo: "aviso", disponivelEm: new Date(), expiraEm: new Date(Date.now() + HORA) })),
    });
    const porDest = Object.fromEntries(r.itens.map((i) => [i.contato_empresa_id, i.acao]));
    assert.equal(porDest[joao.contatoEmpresaId], "JA_EXISTIA", "o João não recebe duas vezes");
    assert.equal(porDest[maria.contatoEmpresaId], "CRIADA", "a Maria recebe o mesmo alerta");
    assert.equal((await msgsDoAlerta(alerta.id)).length, 2);
  });

  test("o banco revalida a elegibilidade: um item de destinatário INELEGÍVEL ou de OUTRA empresa é recusado, sem criar nada", async (t) => {
    if (!migracaoOk) return sk(t);
    const optout = await dest("OptOut", { optOut: true });
    const deB = await dest("DeB", {}, orgB);
    const alerta = await novoAlerta();
    const r = await filaRepo.agendarMensagensDoAlerta({
      alertaId: alerta.id, proposito: "inicial",
      itens: [optout, deB].map((d) => ({ contatoEmpresaId: d.contatoEmpresaId, conteudo: "x", disponivelEm: new Date(), expiraEm: null })),
    });
    assert.equal(r.acao, "OK");
    assert.deepEqual(r.itens.map((i) => i.acao), ["DESTINATARIO_INELEGIVEL", "DESTINATARIO_INEXISTENTE"]);
    assert.equal((await msgsDoAlerta(alerta.id)).length, 0);
    assert.equal(await statusAlerta(alerta.id), SA.DETECTED);
  });

  test("JITTER por destinatário: fora da janela cada um cai num horário PRÓPRIO e DETERMINÍSTICO (não todos às 08:00 em ponto)", async (t) => {
    if (!migracaoOk) return sk(t);
    const ds = [await dest("A"), await dest("B"), await dest("C"), await dest("D")];
    const alerta = await novoAlerta();
    await agendar(DOMINGO);
    const msgs = await msgsDoAlerta(alerta.id);
    assert.equal(msgs.length, 4);
    const horarios = msgs.map((m) => new Date(m.disponivel_em).getTime());
    assert.ok(new Set(horarios).size >= 2, `todos no mesmo instante: ${msgs.map((m) => m.disponivel_em)}`);
    const janelas = { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: { inicio: "08:00", fim: "13:00" }, dom: null };
    const disponibilidade = { dados_disponiveis_apos: "10:00", envios_permitidos_apos: "10:30" };
    for (const m of msgs) {
      const esperado = calcularInstanteDeEnvio({
        base: DOMINGO, timezone: "America/Fortaleza", janelas, dataReferencia: alerta.data_referencia, disponibilidade,
        chave: chaveDeJitter({ idempotencyKey: m.idempotency_key, dataLogica: alerta.data_referencia, organizacaoId: orgA }), spreadMaxMs: 30 * MIN,
      });
      assert.equal(new Date(m.disponivel_em).getTime(), esperado.getTime(), "o horário é função pura (chave do destinatário + data + empresa): reprodutível");
    }
    assert.ok(ds.length === 4);
  });
});

// ---------------------------------------------------------------------------
describe("envio POR DESTINATÁRIO — independência, falhas, limites e cooldown", { skip: PULAR_INTEGRACAO }, () => {
  test("João e Maria são enviados no MESMO lote: cooldown é POR destinatário (o envio ao João não adia a Maria); cada telefone recebe uma vez", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João"), maria = await dest("Maria");
    const alerta = await novoAlerta();
    await agendar(); await liberar(alerta.id);
    const { chamadas, whatsAppService } = provedor();
    const rs = await lote(whatsAppService);
    const msgs = await msgsDoAlerta(alerta.id);
    assert.equal(rs.filter((r) => r.resultado === "ENVIADO").length, 2, JSON.stringify(rs));
    assert.deepEqual(chamadas.map((c) => c.telefoneE164).sort(), [joao.telefone, maria.telefone].sort());
    assert.ok(msgs.every((m) => m.status === SM.SENT));
    assert.equal(await statusAlerta(alerta.id), SA.SENT);
    // mais um lote NÃO reenvia (idempotência)
    await lote(whatsAppService);
    assert.equal(chamadas.length, 2);
  });

  test("FALHA PERMANENTE de UM destinatário não impede os demais; o alerta fica SENT (um sucesso), a falha fica na mensagem", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João"), maria = await dest("Maria"), pedro = await dest("Pedro");
    const alerta = await novoAlerta();
    await agendar(); await liberar(alerta.id);
    const { chamadas, whatsAppService } = provedor({ falhar: { [maria.telefone]: { permanente: true, preEnvio: true, mensagem: "numero invalido" } } });
    const rs = await lote(whatsAppService);
    const msgs = await msgsDoAlerta(alerta.id);
    const de = (d) => msgs.find((m) => m.contato_empresa_id === d.contatoEmpresaId);
    assert.equal(de(joao).status, SM.SENT);
    assert.equal(de(pedro).status, SM.SENT);
    assert.equal(de(maria).status, SM.FAILED);
    assert.equal(rs.filter((r) => r.resultado === "ENVIADO").length, 2);
    assert.equal(chamadas.length, 3);
    assert.equal(await statusAlerta(alerta.id), SA.SENT, "João enviado + Maria falhou permanentemente: o alerta NÃO fica FAILED nem regride");
  });

  test("FALHA TRANSITÓRIA (pré-envio) de UM destinatário -> só ele volta a SCHEDULED com backoff; os demais NÃO são reenviados", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João"), maria = await dest("Maria");
    const alerta = await novoAlerta();
    await agendar(); await liberar(alerta.id);
    const { chamadas, whatsAppService } = provedor({ falhar: { [maria.telefone]: { preEnvio: true, mensagem: "gateway indisponivel" } } });
    const rs = await lote(whatsAppService);
    const msgs = await msgsDoAlerta(alerta.id);
    const mMaria = msgs.find((m) => m.contato_empresa_id === maria.contatoEmpresaId), mJoao = msgs.find((m) => m.contato_empresa_id === joao.contatoEmpresaId);
    assert.equal(porMsg(rs, mMaria.id)?.resultado, "FALHOU_RETRY");
    assert.equal(mMaria.status, SM.SCHEDULED);
    assert.equal(mMaria.tentativas, 1);
    assert.equal(mJoao.status, SM.SENT);
    await lote(whatsAppService);
    assert.equal(chamadas.filter((c) => c.telefoneE164 === joao.telefone).length, 1, "retry NÃO duplica o envio ao João");
    assert.equal(await statusAlerta(alerta.id), SA.SCHEDULED, "Maria ainda a caminho: o alerta não está 'concluído'");
  });

  test("OPT-OUT, DESATIVAÇÃO e CATEGORIA desabilitada DEPOIS de agendado: só o afetado é bloqueado; os demais são enviados", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João"), maria = await dest("Maria"), pedro = await dest("Pedro"), ana = await dest("Ana");
    const alerta = await novoAlerta();
    await agendar(); await liberar(alerta.id);
    await supabase.from("contatos_whatsapp").update({ opt_out: true }).eq("id", joao.contatoId);
    await supabase.from("comunicacao_contatos_empresa").update({ ativo: false }).eq("id", pedro.contatoEmpresaId);
    await supabase.from("comunicacao_destinatario_categorias").update({ habilitado: false }).eq("contato_empresa_id", ana.contatoEmpresaId);
    const { chamadas, whatsAppService } = provedor();
    const rs = await lote(whatsAppService);
    const msgs = await msgsDoAlerta(alerta.id);
    const de = (d) => msgs.find((m) => m.contato_empresa_id === d.contatoEmpresaId);
    assert.equal(porMsg(rs, de(joao).id).motivo, "OPT_OUT");
    assert.equal(porMsg(rs, de(pedro).id).motivo, "USER_INACTIVE");
    assert.equal(porMsg(rs, de(ana).id).motivo, "CATEGORIA_NAO_PERMITIDA");
    assert.equal(de(maria).status, SM.SENT);
    assert.deepEqual(chamadas.map((c) => c.telefoneE164), [maria.telefone]);
    assert.equal(await statusAlerta(alerta.id), SA.SENT);
  });

  test("envio automático DESLIGADO depois de agendado -> NENHUM destinatário é enviado (ENVIO_AUTOMATICO_DESLIGADO), provider 0", async (t) => {
    if (!migracaoOk) return sk(t);
    await dest("João"); await dest("Maria");
    const alerta = await novoAlerta();
    await agendar(); await liberar(alerta.id);
    await supabase.from("comunicacao_habilitacoes").update({ envio_automatico: false }).eq("organizacao_id", orgA);
    const { chamadas, whatsAppService } = provedor();
    const rs = await lote(whatsAppService);
    assert.equal(chamadas.length, 0);
    assert.ok(rs.length >= 2 && rs.every((r) => r.resultado === "BLOQUEADO" && r.motivo === "ENVIO_AUTOMATICO_DESLIGADO"), JSON.stringify(rs));
    assert.equal(await statusAlerta(alerta.id), SA.BLOCKED);
  });

  test("empresa habilitada SEM envio automático NÃO agenda; com envio automático mas SEM destinatário elegível também não", async (t) => {
    if (!migracaoOk) return sk(t);
    await dest("João");
    const alerta = await novoAlerta();
    await supabase.from("comunicacao_habilitacoes").update({ envio_automatico: false }).eq("organizacao_id", orgA);
    const r1 = await agendar();
    assert.equal(r1.agendados, 0);
    assert.equal(r1.envioAutomaticoDesligado, 1);
    await supabase.from("comunicacao_habilitacoes").update({ envio_automatico: true }).eq("organizacao_id", orgA);
    await supabase.from("comunicacao_contatos_empresa").update({ ativo: false }).eq("organizacao_id", orgA);
    const r2 = await agendar();
    assert.equal(r2.agendados, 0);
    assert.ok(r2.destinatarioInelegivel >= 1, JSON.stringify(r2));
    assert.equal((await msgsDoAlerta(alerta.id)).length, 0);
    assert.equal(await statusAlerta(alerta.id), SA.DETECTED);
  });

  test("LIMITE POR EMPRESA/dia (limite_diario_org=2) com 3 destinatários: só 2 saem; o 3º é ADIADO para o dia seguinte — um alerta não vira explosão", async (t) => {
    if (!migracaoOk) return sk(t);
    await dest("João"); await dest("Maria"); await dest("Pedro");
    await supabase.from("comunicacao_habilitacoes").update({ limite_diario_org: 2 }).eq("organizacao_id", orgA);
    const alerta = await novoAlerta();
    await agendar(); await liberar(alerta.id);
    const { chamadas, whatsAppService } = provedor();
    const rs = await lote(whatsAppService);
    assert.equal(chamadas.length, 2, JSON.stringify(rs));
    const adiada = rs.find((r) => r.resultado === "ADIADO");
    assert.ok(adiada, JSON.stringify(rs));
    assert.equal(adiada.motivo, "RATE_LIMIT");
    assert.ok(new Date(adiada.disponivelEm).getTime() - AGORA.getTime() >= 6 * HORA, "adiado para o dia seguinte (a cota diária zera à meia-noite local)");
    const msgs = await msgsDoAlerta(alerta.id);
    assert.equal(msgs.filter((m) => m.status === SM.SENT).length, 2);
    assert.equal(msgs.filter((m) => m.status === SM.SCHEDULED).length, 1);
  });

  test("LIMITE POR DESTINATÁRIO/dia (=1) é distinto do limite da empresa: cada destinatário envia 1 e o 2º alerta de CADA um é adiado", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João"), maria = await dest("Maria");
    await definirLimites({ ...LIMITES, max_por_contato_por_dia: 1 });
    const a1 = await novoAlerta({ unidade: unidadeA }), a2 = await novoAlerta({ unidade: unidadeA2 });
    await agendar(); await liberar(a1.id); await liberar(a2.id);
    const { chamadas, whatsAppService } = provedor();
    const rs = await lote(whatsAppService);
    assert.equal(chamadas.length, 2, JSON.stringify(rs));
    assert.deepEqual([...new Set(chamadas.map((c) => c.telefoneE164))].sort(), [joao.telefone, maria.telefone].sort(), "1 mensagem para cada destinatário");
    assert.equal(rs.filter((r) => r.resultado === "ADIADO").length, 2);
  });

  test("COOLDOWN por destinatário: o MESMO destinatário não recebe outro alerta da mesma unidade/tipo dentro do cooldown", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João");
    const a1 = await novoAlerta({ unidade: unidadeA }), a2 = await novoAlerta({ unidade: unidadeA });
    await agendar(); await liberar(a1.id); await liberar(a2.id);
    const { chamadas, whatsAppService } = provedor();
    const rs = await lote(whatsAppService);
    assert.equal(chamadas.length, 1, JSON.stringify(rs));
    assert.equal(rs.filter((r) => r.resultado === "ADIADO" && r.motivo === "COOLDOWN").length, 1);
    assert.equal(chamadas[0].telefoneE164, joao.telefone);
  });
});

// ---------------------------------------------------------------------------
describe("STATUS AGREGADO do alerta — máquina de estados formal (precedência R0..R6)", { skip: PULAR_INTEGRACAO }, () => {
  const agregado = async (alertaId) => (await supabase.rpc("comunicacao_status_agregado_alerta", { p_alerta_id: alertaId })).data;

  test("tabela de precedência: pendente > sucesso (READ>DELIVERED>SENT) > incerto > FAILED > BLOCKED > expiradas", async (t) => {
    if (!migracaoOk) return sk(t);
    const ds = [await dest("A"), await dest("B"), await dest("C")];
    const alerta = await novoAlerta();
    const casos = [
      [[], null],
      [["SENT", "SCHEDULED"], "SCHEDULED"], [["SENT", "PROCESSING"], "SCHEDULED"], [["SENT", "SENDING"], "SCHEDULED"], [["READ", "SCHEDULED", "FAILED"], "SCHEDULED"],
      [["SENT", "SENT"], "SENT"], [["SENT", "DELIVERED"], "DELIVERED"], [["DELIVERED", "READ"], "READ"], [["READ", "SENT", "FAILED"], "READ"],
      [["SENT", "FAILED"], "SENT"], [["SENT", "BLOCKED"], "SENT"], [["SENT", "CANCELLED"], "SENT"], [["SENT", "DELIVERY_UNKNOWN"], "SENT"],
      [["DELIVERY_UNKNOWN", "FAILED"], null], [["DELIVERY_UNKNOWN"], null],
      [["FAILED", "FAILED"], "FAILED"], [["FAILED", "BLOCKED"], "FAILED"],
      [["BLOCKED", "BLOCKED"], "BLOCKED"], [["BLOCKED", "CANCELLED"], "BLOCKED"],
      [["CANCELLED", "CANCELLED"], "DETECTED"],
    ];
    for (const [statuses, esperado] of casos) {
      await supabase.from("comunicacao_mensagens").delete().eq("alerta_id", alerta.id);
      for (const [i, status] of statuses.entries()) {
        const { error } = await supabase.from("comunicacao_mensagens").insert({
          alerta_id: alerta.id, organizacao_id: orgA, unidade_id: unidadeA, contato_id: ds[i].contatoId, contato_empresa_id: ds[i].contatoEmpresaId, canal: "whatsapp", direcao: "saida",
          tipo: TIPO, conteudo: "x", idempotency_key: `agg-${randomUUID()}`, status, erro: status === "CANCELLED" ? "EXPIRADA" : null, disponivel_em: new Date().toISOString(),
        });
        assert.equal(error, null, error?.message);
      }
      assert.equal(await agregado(alerta.id), esperado, JSON.stringify(statuses));
    }
    // o REFORÇO nunca entra na conta
    await supabase.from("comunicacao_mensagens").delete().eq("alerta_id", alerta.id);
    const { error: eRef } = await supabase.from("comunicacao_mensagens").insert([
      { alerta_id: alerta.id, organizacao_id: orgA, unidade_id: unidadeA, contato_id: ds[0].contatoId, contato_empresa_id: ds[0].contatoEmpresaId, canal: "whatsapp", direcao: "saida", tipo: TIPO, conteudo: "x", idempotency_key: `agg-${randomUUID()}`, status: "FAILED", metadados: {}, disponivel_em: new Date().toISOString() },
      { alerta_id: alerta.id, organizacao_id: orgA, unidade_id: unidadeA, contato_id: ds[0].contatoId, contato_empresa_id: ds[0].contatoEmpresaId, canal: "whatsapp", direcao: "saida", tipo: TIPO, conteudo: "x", idempotency_key: `agg-${randomUUID()}`, status: "SENT", metadados: { proposito: "reforco" }, disponivel_em: new Date().toISOString() },
    ]);
    assert.equal(eRef, null, eRef?.message);
    assert.equal(await agregado(alerta.id), "FAILED", "reforço SENT não transforma a inicial FAILED em sucesso");
  });

  test("TRIGGER: João enviado + Maria pendente -> o alerta NÃO fica 'concluído'; Maria falha permanente -> SENT (coerente); reprocessar não muda", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João"), maria = await dest("Maria");
    const alerta = await novoAlerta();
    await agendar();
    const [m1, m2] = await msgsDoAlerta(alerta.id);
    const mJoao = m1.contato_empresa_id === joao.contatoEmpresaId ? m1 : m2, mMaria = mJoao.id === m1.id ? m2 : m1;
    await supabase.from("comunicacao_mensagens").update({ status: SM.SENT, enviado_em: new Date().toISOString() }).eq("id", mJoao.id);
    assert.equal(await statusAlerta(alerta.id), SA.SCHEDULED, "Maria ainda pendente");
    await supabase.from("comunicacao_mensagens").update({ status: SM.FAILED, falhou_em: new Date().toISOString(), erro_permanente: true }).eq("id", mMaria.id);
    assert.equal(await statusAlerta(alerta.id), SA.SENT);
    await supabase.from("comunicacao_mensagens").update({ status: SM.DELIVERED }).eq("id", mJoao.id);
    assert.equal(await statusAlerta(alerta.id), SA.DELIVERED);
    // um "novo processamento" da mesma mensagem falha nunca regride o alerta
    await supabase.from("comunicacao_mensagens").update({ erro: "outra vez" }).eq("id", mMaria.id);
    assert.equal(await statusAlerta(alerta.id), SA.DELIVERED);
  });

  test("RESOLVED é protegido: nenhum evento de mensagem reabre um alerta resolvido", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João");
    const alerta = await novoAlerta();
    await agendar();
    const [m] = await msgsDoAlerta(alerta.id);
    await alertasRepo.resolverAlerta(alerta.id);
    await supabase.from("comunicacao_mensagens").update({ status: SM.SENT, enviado_em: new Date().toISOString() }).eq("id", m.id);
    assert.equal(await statusAlerta(alerta.id), SA.RESOLVED);
    assert.ok(joao);
  });
});

// ---------------------------------------------------------------------------
describe("REFORÇO e AVISO TARDIO por destinatário", { skip: PULAR_INTEGRACAO }, () => {
  const QUA = (hhmm) => new Date(Date.UTC(2026, 8, 16, Number(hhmm.slice(0, 2)) + 3, Number(hhmm.slice(3))));

  test("reforço: só quem JÁ recebeu a inicial hoje há >= 2h (João e Maria; o Pedro, com a inicial FAILED, não); repetir não duplica", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João"), maria = await dest("Maria"), pedro = await dest("Pedro");
    const alerta = await novoAlerta({ data: "2026-09-15" });
    await supabase.from("comunicacao_habilitacoes").update({ envio_automatico: true }).eq("organizacao_id", orgA);
    await agendar(QUA("11:00"));
    const msgs = await msgsDoAlerta(alerta.id);
    assert.equal(msgs.length, 3, "a inicial de D-1 (às 11:00) é agendada para os 3");
    const de = (d) => msgs.find((m) => m.contato_empresa_id === d.contatoEmpresaId);
    for (const d of [joao, maria]) await supabase.from("comunicacao_mensagens").update({ status: SM.SENT, enviado_em: QUA("15:00").toISOString() }).eq("id", de(d).id);
    await supabase.from("comunicacao_mensagens").update({ status: SM.FAILED, falhou_em: QUA("15:00").toISOString() }).eq("id", de(pedro).id);
    const r1 = await agendarReforcosPendentes({ organizacaoId: orgA, agora: QUA("20:30") });
    assert.equal(r1.agendados, 2, JSON.stringify(r1));
    assert.equal(r1.primeiraNaoEnviada, 1);
    const reforcos = (await msgsDoAlerta(alerta.id)).filter((m) => m.metadados?.proposito === "reforco");
    assert.deepEqual(reforcos.map((m) => m.contato_empresa_id).sort(), [joao.contatoEmpresaId, maria.contatoEmpresaId].sort());
    for (const m of reforcos) assert.equal(m.idempotency_key, chaveIdempotenciaDestinatario({ alertaId: alerta.id, contatoEmpresaId: m.contato_empresa_id, proposito: "reforco" }));
    const rs = await Promise.all(Array.from({ length: 5 }, () => agendarReforcosPendentes({ organizacaoId: orgA, agora: QUA("20:30") })));
    assert.equal(rs.reduce((n, r) => n + r.agendados, 0), 0);
    assert.equal((await msgsDoAlerta(alerta.id)).filter((m) => m.metadados?.proposito === "reforco").length, 2);
  });

  test("aviso tardio: uma 1ª mensagem por destinatário elegível na janela 20:00–22:00 (origem prazo_final_d1); repetir não duplica", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João"), maria = await dest("Maria");
    await dest("OptOut", { optOut: true });
    const alerta = await novoAlerta({ data: "2026-09-15" });
    const rs = await Promise.all(Array.from({ length: 5 }, () => agendarAvisosTardiosD1({ organizacaoId: orgA, agora: QUA("20:30") })));
    assert.equal(rs.reduce((n, r) => n + r.agendados, 0), 2, JSON.stringify(rs));
    const msgs = await msgsDoAlerta(alerta.id);
    assert.deepEqual(msgs.map((m) => m.contato_empresa_id).sort(), [joao.contatoEmpresaId, maria.contatoEmpresaId].sort());
    for (const m of msgs) {
      assert.deepEqual(m.metadados, { proposito: "inicial", origem: "prazo_final_d1" });
      assert.equal(new Date(m.expira_em).toISOString(), QUA("22:30").toISOString());
    }
  });
});

// ---------------------------------------------------------------------------
describe("KILL SWITCH — modo=DISABLED: nenhum envio REAL chega ao provider, por nenhum caminho", { skip: PULAR_INTEGRACAO }, () => {
  test("PRECEDÊNCIA: empresa habilitada + envio automático + destinatários ativos + alertas existentes + mensagens agendadas, e DISABLED -> lote não envia (provider 0)", async (t) => {
    if (!migracaoOk) return sk(t);
    await dest("João"); await dest("Maria");
    const alerta = await novoAlerta();
    await agendar(); await liberar(alerta.id);
    await definirModo(MODOS.DISABLED, {});
    const { chamadas, whatsAppService } = provedor();
    assert.deepEqual(await lote(whatsAppService), [], "processarProximoLote nem reivindica em DISABLED");
    assert.equal(chamadas.length, 0);
    assert.ok((await msgsDoAlerta(alerta.id)).every((m) => m.status === SM.SCHEDULED), "as mensagens ficam intactas esperando o operador");
  });

  test("um job JÁ reivindicado quando o modo vira DISABLED é ADIADO pela política (DISABLED), sem consumir tentativa e sem provider", async (t) => {
    if (!migracaoOk) return sk(t);
    await dest("João");
    const alerta = await novoAlerta();
    await agendar(); await liberar(alerta.id);
    const [job] = await filaRepo.claimJobs({ limite: 1, worker: "kill" });
    assert.ok(job);
    await definirModo(MODOS.DISABLED, {});
    const { chamadas, whatsAppService } = provedor();
    const r = await processarJobReivindicado(job, { whatsAppService, agora: AGORA, verificarPendenciaAindaExiste: async () => true });
    assert.equal(r.resultado, "ADIADO");
    assert.equal(r.motivo, "DISABLED");
    assert.equal(chamadas.length, 0);
    assert.equal((await linha(job.id)).tentativas, 0);
  });

  test("FRONTEIRA FINAL do provider: com o serviço REAL lendo o modo do banco, enviarTexto em DISABLED lança e o provider NÃO é chamado; ao religar, envia", async (t) => {
    if (!migracaoOk) return sk(t);
    const provider = criarFakeProvider();
    const chamadas = [];
    const original = provider.sendText.bind(provider);
    provider.sendText = async (a) => { chamadas.push(a); return original(a); };
    const servico = criarWhatsAppService({ provider, semGateIdentidade: true, modoAtual });
    await definirModo(MODOS.DISABLED, {});
    await assert.rejects(() => servico.enviarTexto({ telefoneE164: "+5562991234567", texto: "x", idempotencyKey: "kill-1" }), ModoDesabilitadoError);
    assert.equal(chamadas.length, 0);
    await definirModo(MODOS.NORMAL, {});
    await servico.enviarTexto({ telefoneE164: "+5562991234567", texto: "x", idempotencyKey: "kill-2" });
    assert.equal(chamadas.length, 1);
  });

  test("TESTE CONTROLADO em DISABLED: MODO_NAO_PERMITIDO, mensagem cancelada, provider 0 (sem exceção escondida)", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João");
    await definirModo(MODOS.DISABLED, {});
    const { chamadas, whatsAppService } = provedor();
    const r = await enviarMensagemTeste({
      testeId: randomUUID(), organizacaoId: orgA, unidadeId: unidadeA, contatoId: joao.contatoId, contatoEmpresaId: joao.contatoEmpresaId, telefoneE164: joao.telefone,
      texto: "teste", limite: 100, whatsAppService, modoAtual: () => modoAtual(),
    });
    assert.equal(r.resultado, "MODO_NAO_PERMITIDO");
    assert.equal(chamadas.length, 0);
    assert.equal((await linha(r.mensagemId)).status, SM.CANCELLED);
    assert.equal((await linha(r.mensagemId)).erro, "MODO_DISABLED");
  });

  test("com o serviço REAL (modo lido do banco) o lote completo em DISABLED também não envia — e em NORMAL envia normalmente", async (t) => {
    if (!migracaoOk) return sk(t);
    await dest("João");
    const alerta = await novoAlerta();
    await agendar(); await liberar(alerta.id);
    const provider = criarFakeProvider();
    const chamadas = [];
    const original = provider.sendText.bind(provider);
    provider.sendText = async (a) => { chamadas.push(a); return original(a); };
    const servico = criarWhatsAppService({ provider, semGateIdentidade: true, modoAtual });
    await definirModo(MODOS.DISABLED, {});
    await lote(servico);
    assert.equal(chamadas.length, 0);
    await definirModo(MODOS.NORMAL, {});
    await lote(servico);
    assert.equal(chamadas.length, 1);
  });
});

// ---------------------------------------------------------------------------
describe("DRY-RUN — somente leitura: identifica, seleciona, gera a mensagem e NÃO cria nada nem chama o provider", { skip: PULAR_INTEGRACAO }, () => {
  const contagens = async () => {
    const q = async (tabela, filtro) => (await supabase.from(tabela).select("*", { count: "exact", head: true }).in(filtro, [orgA, orgB])).count;
    return {
      alertas: await q("comunicacao_alertas", "organizacao_id"), mensagens: await q("comunicacao_mensagens", "organizacao_id"),
      habilitacoes: await q("comunicacao_habilitacoes", "organizacao_id"), destinatarios: await q("comunicacao_contatos_empresa", "organizacao_id"),
      categorias: await q("comunicacao_destinatario_categorias", "organizacao_id"),
      tentativas: (await supabase.from("comunicacao_tentativas").select("*", { count: "exact", head: true })).count,
    };
  };
  const pendencias = (extra = {}) => async () => ({
    d1: "2026-09-15", total: 1,
    unidades: [{ organizacaoId: orgA, unidadeId: unidadeA, unidadeNome: "Loja Multi", empresaNome: "Rede Multi", criticidade: "atencao", pendenciaMaisAntiga: DATA_ANTIGA, diasPendentes: 3, ...extra }],
    organizacoesMonitoradas: [orgA],
  });

  test("com 2 destinatários elegíveis + bloqueados: relata cada etapa, gera as mensagens que SERIAM enviadas e não altera NADA (nem em DISABLED)", async (t) => {
    if (!migracaoOk) return sk(t);
    const joao = await dest("João"), maria = await dest("Maria");
    await dest("OptOut", { optOut: true }); await dest("SemCategoria", { categorias: [] });
    await definirModo(MODOS.DISABLED, {}); // DISABLED + dry-run = permitido
    const antes = await contagens();
    const r = await simularCiclo({ organizacaoId: orgA, agora: AGORA, lerPendencias: pendencias() });
    const depois = await contagens();
    assert.deepEqual(depois, antes, "o dry-run alterou o banco");
    assert.equal(r.dryRun, true);
    assert.equal(r.providerChamado, false);
    assert.equal(r.mensagensCriadas, 0);
    assert.equal(r.modoGlobal, "DISABLED");
    assert.equal(r.envioRealPermitido, false);
    assert.equal(r.alertas.length, 1);
    const a = r.alertas[0];
    assert.equal(a.empresa_elegivel, true);
    assert.equal(a.destinatarios_avaliados, 4);
    assert.equal(a.destinatarios_elegiveis, 2);
    assert.deepEqual(a.destinatarios_bloqueados.map((b) => b.motivo).sort(), ["CATEGORIA_NAO_HABILITADA", "OPT_OUT"]);
    assert.equal(a.mensagens_que_seriam_geradas.length, 2);
    assert.deepEqual(a.mensagens_que_seriam_geradas.map((m) => m.nome).sort(), ["João", "Maria"]);
    for (const m of a.mensagens_que_seriam_geradas) { assert.match(m.texto, /Loja Multi/); assert.ok(m.horarioEstimado); assert.doesNotMatch(JSON.stringify(m), /\+55\d{11}/, "telefone mascarado"); }
    const passos = a.destinatarios.find((d) => d.nome === "João").passos.map((p) => p.etapa);
    assert.deepEqual(passos, ["ALERTA_DETECTADO", "EMPRESA_ELEGIVEL", "DESTINATARIO_ELEGIVEL", "HORARIO", "COOLDOWN", "LIMITE_DESTINATARIO_DIA", "LIMITE_ORGANIZACAO_DIA", "IDEMPOTENCIA", "MENSAGEM_GERADA", "ENVIO_BLOQUEADO_PELO_DRY_RUN"]);
    assert.ok(joao && maria);
  });

  test("NÃO consome idempotência/limite/cooldown: depois de N dry-runs o agendamento REAL ainda cria exatamente 1 mensagem por destinatário", async (t) => {
    if (!migracaoOk) return sk(t);
    await dest("João"); await dest("Maria");
    const alerta = await novoAlerta({ data: DATA_ANTIGA });
    for (let i = 0; i < 4; i++) await simularCiclo({ organizacaoId: orgA, agora: AGORA, lerPendencias: pendencias() });
    assert.equal((await msgsDoAlerta(alerta.id)).length, 0);
    assert.equal((await agendar()).agendados, 2);
    // agora a idempotência existe de verdade e o dry-run a enxerga (sem tocá-la)
    const r = await simularCiclo({ organizacaoId: orgA, agora: AGORA, lerPendencias: pendencias() });
    const passosIdem = r.alertas[0].destinatarios.map((d) => d.passos.find((p) => p.etapa === "IDEMPOTENCIA")?.ok);
    assert.ok(passosIdem.every((ok) => ok === false), JSON.stringify(passosIdem));
    assert.equal((await msgsDoAlerta(alerta.id)).length, 2);
  });

  test("empresa SEM envio automático / desabilitada: reporta os motivos e não simula mensagens", async (t) => {
    if (!migracaoOk) return sk(t);
    await dest("João");
    await supabase.from("comunicacao_habilitacoes").update({ envio_automatico: false }).eq("organizacao_id", orgA);
    const r = await simularCiclo({ organizacaoId: orgA, agora: AGORA, lerPendencias: pendencias() });
    assert.equal(r.alertas[0].empresa_elegivel, false);
    assert.ok(r.alertas[0].motivos_empresa.includes("ENVIO_AUTOMATICO_DESLIGADO"));
    assert.equal(r.alertas[0].mensagens_que_seriam_geradas.length, 0);
    await supabase.from("comunicacao_habilitacoes").update({ habilitado: false, envio_automatico: false }).eq("organizacao_id", orgA);
    const r2 = await simularCiclo({ organizacaoId: orgA, agora: AGORA, lerPendencias: pendencias() });
    assert.ok(r2.alertas[0].motivos_empresa.includes("EMPRESA_DESABILITADA"));
  });

  test("empresa habilitada mas SEM destinatários: NÃO é elegível (Configuração incompleta) e nada seria enviado", async (t) => {
    if (!migracaoOk) return sk(t);
    const r = await simularCiclo({ organizacaoId: orgA, agora: AGORA, lerPendencias: pendencias() });
    assert.equal(r.alertas[0].empresa_elegivel, false);
    assert.ok(r.alertas[0].motivos_empresa.includes("SEM_DESTINATARIOS"));
    assert.equal(r.alertas[0].mensagens_que_seriam_geradas.length, 0);
  });
});
