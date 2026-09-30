// ENSAIO COM DADOS LEGADOS DE PRODUÇÃO (gate do rollout da migration 104).
// Em produção existem mensagens históricas SEM `contato_empresa_id` (anteriores à migration 100/104) e com as idempotências antigas
//   wa:alerta:<id>:v1          (inicial)
//   wa:alerta:<id>:reforco:v1  (reforço)
// O modelo novo (uma mensagem por destinatário) NÃO pode recriar nem a inicial nem o reforço dessas mensagens, o vínculo tem de ser por `contato_id`, e
// nenhuma idempotência histórica pode ser alterada. Se este teste falhar, o rollout é BLOQUEADO.
// Banco de TESTE descartável (nunca produção). PULA sem credencial/sem a migration 104.
// Rodar: node --env-file=.env --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-legado-producao-integracao.test.js
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, migracao082Aplicada, migracao088Aplicada, migracao104Aplicada,
  criarDestinatarioEmpresa, apagarDestinatarioEmpresa, habilitarEmpresaMulti, definirTetoDestinatariosT, restaurarTetoDestinatariosT,
} from "./helpers/comunicacao-fixtures.js";
import * as filaRepo from "../src/modules/comunicacao/comunicacao.fila.repo.js";
import * as alertasRepo from "../src/modules/comunicacao/comunicacao.alertas.repo.js";
import { agendarEnviosPendentes, agendarReforcosPendentes, agendarAvisosTardiosD1 } from "../src/modules/comunicacao/comunicacao.alertas.service.js";
import { TIPOS_ALERTA, SEVERIDADE } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR = motivoPularIntegracao();
const TIPO = TIPOS_ALERTA.DASHBOARD_IFOOD_D1;
const HORA = 3_600_000;
// quarta 16/09/2026; horário local de Fortaleza = UTC-3
const QUA = (hhmm) => new Date(Date.UTC(2026, 8, 16, Number(hhmm.slice(0, 2)) + 3, Number(hhmm.slice(3))));
let migracaoOk = true;
let orgA = null, uniA = null, tetoOriginal = null;
let criados = [];
let seq = 0;

before(async () => {
  if (PULAR) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada()) && (await migracao104Aplicada());
  if (!migracaoOk) return;
  tetoOriginal = await definirTetoDestinatariosT(50);
  orgA = await criarOrganizacao("TESTE legado-producao — descartável");
  uniA = await criarUnidade(orgA, "Loja Legado");
});
after(async () => {
  if (PULAR || !migracaoOk) return;
  await restaurarTetoDestinatariosT(tetoOriginal);
  await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
  await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", orgA);
  await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", orgA);
  for (const d of criados) await apagarDestinatarioEmpresa(d);
  await apagarOrganizacao(orgA);
});
beforeEach(async () => {
  if (PULAR || !migracaoOk) return;
  await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
  await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", orgA);
  await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", orgA);
  for (const d of criados) await apagarDestinatarioEmpresa(d);
  criados = [];
  await habilitarEmpresaMulti(orgA);
});
const pular = (t) => { if (!migracaoOk) { t.skip("migration 104 ainda não aplicada — pulando."); return true; } return false; };

const dest = async (nome) => { const d = await criarDestinatarioEmpresa({ organizacaoId: orgA, nome }); criados.push(d); return d; };
const novoAlerta = async (data = "2026-09-15") => (await alertasRepo.criarOuEscalonarAlerta({
  organizacaoId: orgA, unidadeId: uniA, tipoAlerta: TIPO, dataReferencia: `${data}`, destinatarioPerfilId: null, severidade: SEVERIDADE.ATENCAO,
  motivo: "3 dia(s) pendente(s)", metadados: { unidade_nome: "Loja Legado", empresa_nome: "Rede Legado" },
})).alerta;

/** Mensagem HISTÓRICA no formato de produção: sem contato_empresa_id, com a chave antiga e status final. */
async function inserirLegada({ alerta, contatoId, proposito = "inicial", status = "SENT", enviadoEm = QUA("15:00"), erro = null }) {
  const chave = proposito === "reforco" ? `wa:alerta:${alerta.id}:reforco:v1` : `wa:alerta:${alerta.id}:v1`;
  // como no pipeline original: nasce SCHEDULED e transita (o trigger de status do alerta só dispara em UPDATE)
  const { data, error } = await supabase.from("comunicacao_mensagens").insert({
    alerta_id: alerta.id, organizacao_id: orgA, unidade_id: uniA, contato_id: contatoId, contato_empresa_id: null, canal: "whatsapp", direcao: "saida",
    tipo: TIPO, conteudo: "mensagem histórica", idempotency_key: chave, status: "SCHEDULED", metadados: proposito === "reforco" ? { proposito: "reforco" } : {},
    disponivel_em: new Date(enviadoEm.getTime() - HORA).toISOString(), max_tentativas: 3,
  }).select("*").single();
  assert.equal(error, null, error?.message);
  if (status !== "SCHEDULED") {
    const patch = { status, erro, ...(["SENT", "DELIVERED", "READ"].includes(status) ? { enviado_em: enviadoEm.toISOString() } : {}) };
    const { error: e2 } = await supabase.from("comunicacao_mensagens").update(patch).eq("id", data.id);
    assert.equal(e2, null, e2?.message);
  }
  return { id: data.id, chave };
}
const msgs = async (alertaId) => (await supabase.from("comunicacao_mensagens").select("*").eq("alerta_id", alertaId).order("created_at")).data ?? [];
const instantaneo = async (alertaId) => (await msgs(alertaId)).map((m) => ({ id: m.id, chave: m.idempotency_key, status: m.status, ce: m.contato_empresa_id, contato: m.contato_id, updated: m.updated_at, enviado: m.enviado_em }));
const chaves = async (alertaId) => (await msgs(alertaId)).map((m) => m.idempotency_key).sort();

// ---------------------------------------------------------------------------
describe("LEGADO DE PRODUÇÃO — mensagens históricas sem contato_empresa_id e chaves antigas", { skip: PULAR }, () => {
  test("INICIAL antiga (contato_empresa_id=null, wa:alerta:<id>:v1) é reconhecida: a RPC devolve JA_EXISTIA por contato_id e NÃO cria outra", async (t) => {
    if (pular(t)) return;
    const jailton = await dest("Jailton");
    const alerta = await novoAlerta();
    const legada = await inserirLegada({ alerta, contatoId: jailton.contatoId });
    assert.equal(legada.chave, `wa:alerta:${alerta.id}:v1`);
    // situação de risco máxima: o alerta ainda DETECTED (o modelo novo tentaria agendar a inicial de novo)
    await supabase.from("comunicacao_alertas").update({ status: "DETECTED" }).eq("id", alerta.id);
    const antes = await instantaneo(alerta.id);
    const r = await filaRepo.agendarMensagensDoAlerta({
      alertaId: alerta.id, proposito: "inicial",
      itens: [{ contatoEmpresaId: jailton.contatoEmpresaId, conteudo: "novo", disponivelEm: new Date(), expiraEm: new Date(Date.now() + 2 * HORA) }],
    });
    assert.deepEqual(r.itens.map((i) => i.acao), ["JA_EXISTIA"], JSON.stringify(r));
    assert.equal(r.itens[0].mensagem_id, legada.id, "aponta para a mensagem histórica");
    assert.deepEqual(await instantaneo(alerta.id), antes, "nada foi criado nem alterado");
    assert.deepEqual(await chaves(alerta.id), [legada.chave], "nenhuma chave nova");
  });

  test("o CICLO do scheduler (agendarEnviosPendentes) sobre alerta com inicial antiga viva não recria a inicial — 0 agendados, 1 mensagem", async (t) => {
    if (pular(t)) return;
    const jailton = await dest("Jailton");
    const alerta = await novoAlerta();
    await inserirLegada({ alerta, contatoId: jailton.contatoId, status: "SENT" });
    await supabase.from("comunicacao_alertas").update({ status: "DETECTED" }).eq("id", alerta.id);
    const rs = await Promise.all(Array.from({ length: 4 }, () => agendarEnviosPendentes({ organizacaoId: orgA, agora: QUA("11:00") })));
    assert.equal(rs.reduce((n, r) => n + r.agendados, 0), 0, JSON.stringify(rs));
    assert.equal((await msgs(alerta.id)).length, 1);
  });

  test("REFORÇO antigo (wa:alerta:<id>:reforco:v1) é reconhecido: o modelo novo não recria o reforço, mesmo dentro da janela de reforço", async (t) => {
    if (pular(t)) return;
    const jailton = await dest("Jailton");
    const alerta = await novoAlerta();
    const ini = await inserirLegada({ alerta, contatoId: jailton.contatoId, status: "SENT", enviadoEm: QUA("15:00") });
    const ref = await inserirLegada({ alerta, contatoId: jailton.contatoId, proposito: "reforco", status: "SENT", enviadoEm: QUA("19:00") });
    assert.equal(ref.chave, `wa:alerta:${alerta.id}:reforco:v1`);
    const antes = await instantaneo(alerta.id);
    const rs = await Promise.all(Array.from({ length: 4 }, () => agendarReforcosPendentes({ organizacaoId: orgA, agora: QUA("20:30") })));
    assert.equal(rs.reduce((n, r) => n + r.agendados, 0), 0, JSON.stringify(rs));
    assert.deepEqual(await instantaneo(alerta.id), antes);
    assert.deepEqual(await chaves(alerta.id), [ini.chave, ref.chave].sort());
    // e diretamente na RPC:
    const r = await filaRepo.agendarMensagensDoAlerta({
      alertaId: alerta.id, proposito: "reforco",
      itens: [{ contatoEmpresaId: jailton.contatoEmpresaId, conteudo: "reforço novo", disponivelEm: new Date(), expiraEm: new Date(Date.now() + HORA) }],
    });
    assert.deepEqual(r.itens.map((i) => i.acao), ["JA_EXISTIA"]);
    assert.equal(r.itens[0].mensagem_id, ref.id);
    assert.equal((await msgs(alerta.id)).length, 2);
  });

  test("inicial antiga ENVIADA e reforço ainda NÃO enviado: só o reforço legítimo nasce (chave nova por destinatário); a inicial antiga fica intacta", async (t) => {
    if (pular(t)) return;
    const jailton = await dest("Jailton");
    const alerta = await novoAlerta();
    const ini = await inserirLegada({ alerta, contatoId: jailton.contatoId, status: "SENT", enviadoEm: QUA("15:00") });
    const antesIni = (await instantaneo(alerta.id))[0];
    const r1 = await agendarReforcosPendentes({ organizacaoId: orgA, agora: QUA("20:30") });
    assert.equal(r1.agendados, 1, JSON.stringify(r1));
    const todas = await msgs(alerta.id);
    assert.equal(todas.length, 2);
    const novo = todas.find((m) => m.metadados?.proposito === "reforco");
    assert.equal(novo.contato_empresa_id, jailton.contatoEmpresaId);
    assert.equal(novo.idempotency_key, `wa:alerta:${alerta.id}:dest:${jailton.contatoEmpresaId}:reforco:v1`);
    assert.deepEqual((await instantaneo(alerta.id)).find((m) => m.id === ini.id), antesIni, "a inicial histórica não foi tocada");
    // repetir não duplica
    const r2 = await agendarReforcosPendentes({ organizacaoId: orgA, agora: QUA("20:30") });
    assert.equal(r2.agendados, 0);
    assert.equal((await msgs(alerta.id)).length, 2);
  });

  test("inicial antiga EXPIRADA (CANCELLED/EXPIRADA) não é recriada (MENSAGEM_EXPIRADA); FAILED antiga também é reconhecida (não vira 2ª tentativa fantasma)", async (t) => {
    if (pular(t)) return;
    const jailton = await dest("Jailton");
    const alerta = await novoAlerta();
    const exp = await inserirLegada({ alerta, contatoId: jailton.contatoId, status: "CANCELLED", erro: "EXPIRADA" });
    await supabase.from("comunicacao_alertas").update({ status: "DETECTED" }).eq("id", alerta.id);
    const r = await filaRepo.agendarMensagensDoAlerta({
      alertaId: alerta.id, proposito: "inicial",
      itens: [{ contatoEmpresaId: jailton.contatoEmpresaId, conteudo: "x", disponivelEm: new Date(), expiraEm: new Date(Date.now() + HORA) }],
    });
    assert.deepEqual(r.itens.map((i) => i.acao), ["MENSAGEM_EXPIRADA"], JSON.stringify(r));
    assert.deepEqual(await chaves(alerta.id), [exp.chave]);
    // FAILED antiga em outro alerta
    const alerta2 = await novoAlerta("2026-09-14");
    await inserirLegada({ alerta: alerta2, contatoId: jailton.contatoId, status: "FAILED", erro: "falha antiga" });
    await supabase.from("comunicacao_alertas").update({ status: "DETECTED" }).eq("id", alerta2.id);
    const r2 = await filaRepo.agendarMensagensDoAlerta({
      alertaId: alerta2.id, proposito: "inicial",
      itens: [{ contatoEmpresaId: jailton.contatoEmpresaId, conteudo: "x", disponivelEm: new Date(), expiraEm: new Date(Date.now() + HORA) }],
    });
    assert.deepEqual(r2.itens.map((i) => i.acao), ["JA_EXISTIA"]);
    assert.equal((await msgs(alerta2.id)).length, 1);
  });

  test("VÍNCULO POR contato_id: o histórico do Jailton não bloqueia a Maria (que ainda não recebeu) e a Maria não 'herda' a mensagem dele", async (t) => {
    if (pular(t)) return;
    const jailton = await dest("Jailton"), maria = await dest("Maria");
    const alerta = await novoAlerta();
    const legada = await inserirLegada({ alerta, contatoId: jailton.contatoId, status: "SENT" });
    await supabase.from("comunicacao_alertas").update({ status: "DETECTED" }).eq("id", alerta.id);
    const r = await filaRepo.agendarMensagensDoAlerta({
      alertaId: alerta.id, proposito: "inicial",
      itens: [jailton, maria].map((d) => ({ contatoEmpresaId: d.contatoEmpresaId, conteudo: "x", disponivelEm: new Date(), expiraEm: new Date(Date.now() + 2 * HORA) })),
    });
    const porDest = Object.fromEntries(r.itens.map((i) => [i.contato_empresa_id, i.acao]));
    assert.equal(porDest[jailton.contatoEmpresaId], "JA_EXISTIA");
    assert.equal(porDest[maria.contatoEmpresaId], "CRIADA");
    const todas = await msgs(alerta.id);
    assert.equal(todas.length, 2);
    assert.equal(todas.find((m) => m.id === legada.id).idempotency_key, legada.chave, "chave histórica intacta");
    assert.equal(todas.find((m) => m.id !== legada.id).contato_empresa_id, maria.contatoEmpresaId);
  });

  test("aviso tardio (D-1 20:00–22:00) também respeita a inicial histórica: 0 agendados", async (t) => {
    if (pular(t)) return;
    const jailton = await dest("Jailton");
    const alerta = await novoAlerta();
    await inserirLegada({ alerta, contatoId: jailton.contatoId, status: "SENT" });
    await supabase.from("comunicacao_alertas").update({ status: "DETECTED" }).eq("id", alerta.id);
    const r = await agendarAvisosTardiosD1({ organizacaoId: orgA, agora: QUA("20:30") });
    assert.equal(r.agendados, 0, JSON.stringify(r));
    assert.equal((await msgs(alerta.id)).length, 1);
  });

  test("NENHUMA idempotência histórica é modificada: depois de TODAS as operações do modelo novo, as linhas antigas têm a mesma chave, status, vínculo e updated_at", async (t) => {
    if (pular(t)) return;
    const jailton = await dest("Jailton");
    const alerta = await novoAlerta();
    await inserirLegada({ alerta, contatoId: jailton.contatoId, status: "SENT", enviadoEm: QUA("15:00") });
    await inserirLegada({ alerta, contatoId: jailton.contatoId, proposito: "reforco", status: "SENT", enviadoEm: QUA("19:00") });
    const antes = await instantaneo(alerta.id);
    await agendarEnviosPendentes({ organizacaoId: orgA, agora: QUA("11:00") });
    await agendarReforcosPendentes({ organizacaoId: orgA, agora: QUA("20:30") });
    await agendarAvisosTardiosD1({ organizacaoId: orgA, agora: QUA("20:30") });
    await supabase.from("comunicacao_alertas").update({ status: "DETECTED" }).eq("id", alerta.id);
    await agendarEnviosPendentes({ organizacaoId: orgA, agora: QUA("11:00") });
    assert.deepEqual(await instantaneo(alerta.id), antes);
    assert.deepEqual(await chaves(alerta.id), [`wa:alerta:${alerta.id}:reforco:v1`, `wa:alerta:${alerta.id}:v1`].sort());
  });
});
