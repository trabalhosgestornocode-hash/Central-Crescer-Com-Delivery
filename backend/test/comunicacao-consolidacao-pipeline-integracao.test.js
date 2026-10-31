// Consolidação por telefone, PONTA A PONTA contra o banco de TESTE: pipeline REAL (processarJobReivindicado com o hook), RPC REAL
// comunicacao_reservar_envio (migration 140), finalizarEnvio real e o gateway simulado (fake.provider).
// Rodar: node --experimental-vm-modules --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-consolidacao-pipeline-integracao.test.js
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, criarUnidade, criarContaComPerfil, apagarConta, migracao082Aplicada, migracao088Aplicada } from "./helpers/comunicacao-fixtures.js";
import { responsavelDoContato, definirTetoDestinatariosT, restaurarTetoDestinatariosT, apagarDestinatariosDasEmpresasT, categoriaParaTipoT, limparCategoriasDeTesteT } from "./helpers/comunicacao-fixtures.js";
import * as contatosRepo from "../src/modules/comunicacao/comunicacao.contatos.repo.js";
import { processarJobReivindicado } from "../src/modules/comunicacao/comunicacao.alertas.service.js";
import { processarLoteComConsolidacao } from "../src/modules/comunicacao/comunicacao.consolidacao.pipeline.js";
import { definirModo, modoAtual } from "../src/modules/comunicacao/comunicacao.config.js";
import { criarWhatsAppService } from "../src/modules/comunicacao/whatsapp.service.js";
import { criarFakeProvider } from "../src/modules/comunicacao/providers/fake.provider.js";
import { MOTIVO_DA_RESERVA } from "../src/modules/comunicacao/comunicacao.adiamento.js";
import { MODOS, STATUS_MENSAGEM as S } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR = motivoPularIntegracao();
const tag = `cons${Date.now()}`;
const ON = { COMUNICACAO_CONSOLIDACAO_POR_TELEFONE: "true" };
const SEMPRE_ABERTA = { seg_sex: { inicio: "00:00", fim: "23:59" }, sab: { inicio: "00:00", fim: "23:59" }, dom: { inicio: "00:00", fim: "23:59" } };
const HABILITADA = async () => ({ empresaHabilitada: true, tipoPermitido: true, envioAutomatico: true, empresaPausada: false, pausadoAte: null, pausadoMotivo: null, timezone: "America/Fortaleza", janelas: SEMPRE_ABERTA, configHorarioValida: true, fonte: "TESTE" });

let modoOriginal = null, tetoOriginal = null, limitesOriginais = null, migracaoOk = true, contaId = null, perfilId = null, contatoId = null;
const orgs = []; const unidades = [];
let seq = 0;

before(async () => {
  if (PULAR) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada());
  const { error } = await supabase.from("comunicacao_mensagens").select("consolidacao_chave").limit(1);
  if (error) { migracaoOk = false; return; }      // sem a migration 140 não há o que testar
  modoOriginal = await modoAtual();
  tetoOriginal = await definirTetoDestinatariosT(200);
  limitesOriginais = (await supabase.from("comunicacao_configuracoes").select("valor").eq("chave", "limites").maybeSingle()).data?.valor ?? null;
  await supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: { max_proativas_por_minuto: 100000, max_proativas_por_minuto_por_organizacao: 100000, max_por_contato_por_dia: 3 } }, { onConflict: "chave" });
  await definirModo(MODOS.NORMAL, {});
  for (let i = 1; i <= 7; i++) { const o = await criarOrganizacao(`TESTE consolidacao ${i} — descartável`); orgs.push(o); unidades.push(await criarUnidade(o, `Loja ${i}`)); }
  const conta = await criarContaComPerfil(tag, "dest"); contaId = conta.contaId; perfilId = conta.perfilId;
  const c = await contatosRepo.criarOuObterContato({ telefoneE164: `+551197${String(Date.now()).slice(-7)}` });
  await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).eq("id", c.id);
  contatoId = c.id;
});
after(async () => {
  if (PULAR) return;
  if (modoOriginal) await definirModo(modoOriginal, {}).catch(() => {});
  if (limitesOriginais) await supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: limitesOriginais }, { onConflict: "chave" });
  else await supabase.from("comunicacao_configuracoes").delete().eq("chave", "limites");
  await restaurarTetoDestinatariosT(tetoOriginal);
  await limparCategoriasDeTesteT();
  if (contatoId) { await supabase.from("comunicacao_mensagens").delete().eq("contato_id", contatoId); await supabase.from("contatos_whatsapp").delete().eq("id", contatoId); }
  if (contaId) await apagarConta(contaId);
  for (const o of orgs) await apagarOrganizacao(o);
});
beforeEach(async () => {
  if (PULAR || !migracaoOk) return;
  await supabase.from("comunicacao_mensagens").delete().in("organizacao_id", orgs);
  await apagarDestinatariosDasEmpresasT(orgs);
});

/** mensagem em PROCESSING, reivindicada pelo worker `w`, de uma empresa/loja (índice) para o contato único */
async function emProcessamento(i, { worker = `w-${tag}`, campos = {} } = {}) {
  const tipo = `tipo_${tag}`;
  const ce = await responsavelDoContato({ organizacaoId: orgs[i], contatoId, perfilId });
  await categoriaParaTipoT(orgs[i], ce, tipo);
  const { data, error } = await supabase.from("comunicacao_mensagens").insert({
    organizacao_id: orgs[i], unidade_id: unidades[i], contato_id: contatoId, contato_empresa_id: ce, destinatario_perfil_id: perfilId, canal: "whatsapp", direcao: "saida",
    tipo, conteudo: `Relatório sintético da loja ${i + 1}: ${i + 1} pendência(s).`, idempotency_key: `${tag}-${++seq}`, status: S.PROCESSING, disponivel_em: new Date(Date.now() - 60_000).toISOString(),
    claimed_by: worker, claimed_at: new Date().toISOString(), claim_expira_em: new Date(Date.now() + 120_000).toISOString(), claim_geracao: 1,
    expira_em: new Date(Date.now() + 24 * 3600_000).toISOString(), ...campos,
  }).select("*").single();
  if (error) throw new Error(`fixture: ${error.message}`);
  return data;
}
const linha = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("id", id).single()).data;
const servico = () => { const provider = criarFakeProvider(); return { provider, whatsAppService: criarWhatsAppService({ provider, semGateIdentidade: true, semGateModo: true }) }; };
const opcoes = (whatsAppService) => ({ whatsAppService, agora: new Date(), adiamentoMs: 900_000, verificarPendenciaAindaExiste: async () => true, resolverHabilitacao: HABILITADA });

describe("consolidação por telefone — pipeline real + RPC da 140 + gateway simulado", { skip: PULAR }, () => {
  test("7 empresas, MESMO telefone, teto 3: UMA mensagem física com os 7 relatórios; 7 linhas SENT (mesmo provider id e chave); o telefone consumiu uma vaga", async (t) => {
    if (!migracaoOk) return t.skip("migration 140 ainda não aplicada no banco alvo");
    const jobs = []; for (let i = 0; i < 7; i++) jobs.push(await emProcessamento(i));
    const { provider, whatsAppService } = servico();
    const r = await processarLoteComConsolidacao({ jobs, opcoes: opcoes(whatsAppService), env: ON });
    assert.equal(provider.mensagensEnviadas.length, 1, "uma chamada ao gateway");
    for (let i = 1; i <= 7; i++) assert.ok(provider.mensagensEnviadas[0].texto.includes(`Relatório sintético da loja ${i}: ${i} pendência(s).`), `relatório ${i}`);
    assert.ok(provider.mensagensEnviadas[0].texto.includes("*TESTE consolidacao 1 — descartável — Loja 1*"));
    assert.deepEqual(r.individuais, []);
    const linhas = await Promise.all(jobs.map((j) => linha(j.id)));
    assert.ok(linhas.every((l) => l.status === S.SENT && l.tentativas === 1));
    assert.equal(new Set(linhas.map((l) => l.provider_message_id)).size, 1);
    assert.equal(new Set(linhas.map((l) => l.consolidacao_chave)).size, 1); assert.ok(linhas[0].consolidacao_chave);
  });

  test("TETO GLOBAL de 3 mensagens FÍSICAS: 1 consolidada (4 empresas) + 2 individuais passam; a 4ª física é adiada (RATE_LIMIT_DIA) — provider 3 chamadas", async (t) => {
    if (!migracaoOk) return t.skip("migration 140 ainda não aplicada no banco alvo");
    const { provider, whatsAppService } = servico();
    const grupo = []; for (let i = 0; i < 4; i++) grupo.push(await emProcessamento(i));
    await processarLoteComConsolidacao({ jobs: grupo, opcoes: opcoes(whatsAppService), env: ON });
    const resultados = [];
    for (const i of [4, 5, 6]) resultados.push(await processarJobReivindicado(await emProcessamento(i), opcoes(whatsAppService)));
    assert.deepEqual(resultados.map((r) => r.resultado), ["ENVIADO", "ENVIADO", "ADIADO"]);
    assert.equal(provider.mensagensEnviadas.length, 3);
    assert.equal(resultados[2].motivo, MOTIVO_DA_RESERVA.RATE_LIMIT_DIA);
  });

  test("falha pré-envio no gateway: nenhum SENT, todas voltam a SCHEDULED com 1 tentativa (retry de hoje); nada é enviado", async (t) => {
    if (!migracaoOk) return t.skip("migration 140 ainda não aplicada no banco alvo");
    const jobs = []; for (let i = 0; i < 3; i++) jobs.push(await emProcessamento(i));
    const { provider, whatsAppService } = servico(); provider.falharProximoEnvio({ mensagem: "recusou", preEnvio: true });
    await processarLoteComConsolidacao({ jobs, opcoes: opcoes(whatsAppService), env: ON });
    assert.equal(provider.mensagensEnviadas.length, 0);
    for (const j of jobs) { const l = await linha(j.id); assert.equal(l.status, S.SCHEDULED); assert.equal(l.tentativas, 1); assert.equal(l.provider_message_id, null); }
  });

  test("falha AMBÍGUA: todas em DELIVERY_UNKNOWN, uma só chamada, nunca reenvio", async (t) => {
    if (!migracaoOk) return t.skip("migration 140 ainda não aplicada no banco alvo");
    const jobs = []; for (let i = 0; i < 3; i++) jobs.push(await emProcessamento(i));
    const { provider, whatsAppService } = servico(); provider.falharProximoEnvio({ mensagem: "timeout" });
    await processarLoteComConsolidacao({ jobs, opcoes: opcoes(whatsAppService), env: ON });
    for (const j of jobs) assert.equal((await linha(j.id)).status, S.DELIVERY_UNKNOWN);
    assert.equal(provider.mensagensEnviadas.length, 0);
  });

  test("opt-out do contato: o pipeline barra TODAS antes de reservar; nada é enviado nem reservado", async (t) => {
    if (!migracaoOk) return t.skip("migration 140 ainda não aplicada no banco alvo");
    const jobs = []; for (let i = 0; i < 3; i++) jobs.push(await emProcessamento(i));
    await supabase.from("contatos_whatsapp").update({ opt_out: true }).eq("id", contatoId);
    try {
      const { provider, whatsAppService } = servico();
      await processarLoteComConsolidacao({ jobs, opcoes: opcoes(whatsAppService), env: ON });
      assert.equal(provider.mensagensEnviadas.length, 0);
      for (const j of jobs) { const l = await linha(j.id); assert.notEqual(l.status, S.SENT); assert.equal(l.tentativas, 0); assert.equal(l.consolidacao_chave, null); }
    } finally { await supabase.from("contatos_whatsapp").update({ opt_out: false }).eq("id", contatoId); }
  });

  test("flag desligada: devolve todos como individuais e não toca nenhuma linha", async (t) => {
    if (!migracaoOk) return t.skip("migration 140 ainda não aplicada no banco alvo");
    const jobs = []; for (let i = 0; i < 3; i++) jobs.push(await emProcessamento(i));
    const { provider, whatsAppService } = servico();
    const r = await processarLoteComConsolidacao({ jobs, opcoes: opcoes(whatsAppService), env: {} });
    assert.equal(r.individuais.length, 3); assert.equal(provider.mensagensEnviadas.length, 0);
    for (const j of jobs) assert.equal((await linha(j.id)).status, S.PROCESSING);
  });

  test("DOIS workers concorrentes sobre os mesmos jobs: cada relatório sai UMA vez só", async (t) => {
    if (!migracaoOk) return t.skip("migration 140 ainda não aplicada no banco alvo");
    const jobs = []; for (let i = 0; i < 4; i++) jobs.push(await emProcessamento(i));
    const { provider, whatsAppService } = servico();
    await Promise.all([processarLoteComConsolidacao({ jobs, opcoes: opcoes(whatsAppService), env: ON }), processarLoteComConsolidacao({ jobs, opcoes: opcoes(whatsAppService), env: ON })]);
    const todos = provider.mensagensEnviadas.map((m) => m.texto).join(" | ");
    for (let i = 1; i <= 4; i++) assert.equal(todos.split(`loja ${i}:`).length - 1, 1, `relatório ${i} duplicado`);
    for (const j of jobs) assert.equal((await linha(j.id)).tentativas, 1);
  });
});
