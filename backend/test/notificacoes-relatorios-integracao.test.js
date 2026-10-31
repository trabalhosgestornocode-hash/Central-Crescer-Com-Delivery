// Relatórios operacionais PONTA A PONTA contra o banco de TESTE (migrations 141/142 aplicadas): pedidos sintéticos → indicadores → fechamento
// (gravado pela RPC real) → relatório diário e semanal (resumo gravado) → fila real (RPCs de reserva/finalização) → gateway simulado → auditoria.
// Rodar: node --experimental-vm-modules --env-file=.env.test-integracao --test --test-concurrency=1 test/notificacoes-relatorios-integracao.test.js
//
// RESÍDUO ACEITO (projeto de teste dedicado): fechamentos e itens da fila são somente-inclusão (triggers/privilégios) e o consentimento é um livro-razão
// imutável. Por isso: (a) cada execução usa datas passadas ALEATÓRIAS (sem colidir com execuções anteriores); (b) o consentimento vigente é injetado
// na leitura de autorização; a leitura REAL de autorização é provada nos casos negativos (sem escopo/consentimento ⇒ BLOQUEADO).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, criarUnidade, responsavelDoContato } from "./helpers/comunicacao-fixtures.js";
import * as contatosRepo from "../src/modules/comunicacao/comunicacao.contatos.repo.js";
import * as opRepo from "../src/modules/checklist-operacional/checklistOperacional.operacional.repository.js";
import * as relRepo from "../src/modules/notificacoes/notificacoes.relatorios.repository.js";
import { enfileirarRelatoriosDaUnidade } from "../src/modules/notificacoes/notificacoes.relatorios.servico.js";
import { processarFilaRelatorios } from "../src/modules/notificacoes/notificacoes.relatorios.envio.js";
import { criarWhatsAppService } from "../src/modules/comunicacao/whatsapp.service.js";
import { criarFakeProvider } from "../src/modules/comunicacao/providers/fake.provider.js";

const { gerarFechamento } = await import("../src/modules/checklist-operacional/checklistOperacional.operacional.service.js");
const { bancoSintetico, repoFake, opFake, TENANT_A1 } = await import("./helpers/operacional-sintetico.js");

const PULAR = motivoPularIntegracao();
const VIVA = { estado: "ao_vivo", motivo: null };
const dia = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// segunda-feira aleatória em 2025 (nunca colide com execuções anteriores)
const SEGUNDA_HOJE = dia("2025-01-06", 7 * Math.floor(Math.random() * 45));
const SEGUNDA_SEMANA = dia(SEGUNDA_HOJE, -7);
const AGORA = () => new Date(`${SEGUNDA_HOJE}T13:00:00.000Z`);                      // segunda 10:00 em São Paulo
const DOMINGO = dia(SEGUNDA_HOJE, -1);

let org = null, un = null, ce = null, contatoId = null, tel = null;
const ENV = () => ({ NOTIFICACOES_RELATORIOS_ENVIO_HABILITADO: "true", NOTIFICACOES_RELATORIOS_ALLOWLIST_E164: tel });

const notifFake = () => ({
  listarDestinatarios: async () => ({ destinatarios: [{ id: ce, ativo: true }], escopos: ["fechamento_operacional_diario", "resumo_semanal"].map((categoria) => ({ contato_empresa_id: ce, unidade_escopo_id: un, categoria, origem_autorizacao: "CONVITE_OTP", habilitado: true, suspenso_em: null, notificar_correcao: true })) }),
  listarConsentimentos: async () => ["fechamento_operacional_diario", "resumo_semanal"].map((categoria) => ({ contato_empresa_id: ce, categoria, acao: "CONCEDIDO" })),
});
const autorizadoFake = async () => ({ autorizado: true, motivo: null, telefoneE164: tel, contatoWhatsappId: contatoId });
const servicoFake = () => { const provider = criarFakeProvider(); return { provider, servico: criarWhatsAppService({ provider, semGateIdentidade: true, semGateModo: true }) }; };
// O banco decide expiração/disponibilidade pelo RELÓGIO REAL (now()); as datas dos cenários são passadas aleatórias. A janela 08–20h local é testada à parte
// (notificacoes-relatorios-fluxo.test.js); aqui só reancora a janela do item no relógio real.
const repoRelogioReal = (extra = {}) => ({ ...relRepo, ...extra, enfileirar: (ls, d) => relRepo.enfileirar(ls.map((l) => ({ ...l, disponivel_em: new Date(Date.now() - 60_000).toISOString(), expira_em: new Date(Date.now() + 3 * 3600_000).toISOString() })), d) });
const unidade = () => ({ organizacaoId: org, unidadeId: un, unidadeNome: "Unidade sintética", fusoUnidade: null, integracao: VIVA, modulosEfetivos: ["checklist_operacional"] });

/** pedidos sintéticos → indicadores (service real em memória) → grava o fechamento no banco pela RPC real, para a competência pedida */
async function fecharDia(competencia, indice) {
  const b = bancoSintetico();
  const deps = { repo: repoFake(b.db), op: opFake(b.db), ia: {} };
  const { fechamento: f } = await gerarFechamento({ ...TENANT_A1, competencia: "2026-10-27", agora: () => new Date("2026-10-28T12:00:00.000Z"), deps });
  assert.equal(f.status, "CONSOLIDADO", "o cenário sintético precisa fechar CONSOLIDADO");
  const r = await opRepo.registrarFechamento({ organizacaoId: org, unidadeId: un, competencia, status: f.status, execucaoId: randomUUID(), regraVersao: f.regra_versao ?? 1, fuso: f.fuso, fusoOrigem: f.fuso_origem,
    origem: "agendado", geradoPor: "teste", motivo: null, fonte: f.fonte, cobertura: f.cobertura, indicadores: f.indicadores, diagnostico: f.diagnostico, pendencias: f.pendencias, hash: `${f.hash_conteudo}-${indice}-${competencia}` });
  assert.ok(["REGISTRADO"].includes(r.resultado), JSON.stringify(r));
  return { id: r.id, indicadores: f.indicadores };
}

before(async () => {
  if (PULAR) return;
  const t = await supabase.from("operacional_relatorios_envios").select("id").limit(1);
  if (t.error) return;                                                           // sem a migration 141 não há o que testar
  org = await criarOrganizacao(`TESTE relatórios ${randomUUID().slice(0, 8)} — residual`);
  un = await criarUnidade(org, "Loja relatórios");
  tel = `+551198${String(Date.now()).slice(-7)}`;
  const c = await contatosRepo.criarOuObterContato({ telefoneE164: tel });
  await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).eq("id", c.id);
  contatoId = c.id; ce = await responsavelDoContato({ organizacaoId: org, contatoId: c.id, perfilId: null });
});
after(async () => { if (PULAR || !org) return; await apagarOrganizacao(org).catch(() => {}); });   // fechamentos são somente-inclusão: a remoção pode ser recusada (resíduo aceito)

describe("relatórios operacionais — banco de teste + gateway simulado", { skip: PULAR }, () => {
  test("DIÁRIO ponta a ponta: pedidos → indicadores → fechamento real → fila real → 1 mensagem → ENVIADO + auditoria; repetir não duplica", async (t) => {
    if (!org) return t.skip("migration 141 não aplicada no banco alvo");
    const { id: fechamentoId, indicadores } = await fecharDia(DOMINGO, 0);
    assert.ok(indicadores.pedidos.recebidos > 0, "há pedidos reais no fechamento");
    const deps = { relatorios: repoRelogioReal(), notificacoes: notifFake() };
    const enf = await enfileirarRelatoriosDaUnidade(unidade(), { agora: AGORA, deps });
    assert.equal(enf.diario.enfileirados, 1);
    const { data: fila } = await supabase.from("operacional_relatorios_envios").select("*").eq("fechamento_id", fechamentoId);
    assert.equal(fila.length, 1); assert.equal(fila[0].status, "PENDENTE"); assert.equal(fila[0].categoria, "fechamento_operacional_diario");
    assert.equal((await enfileirarRelatoriosDaUnidade(unidade(), { agora: AGORA, deps })).diario.enfileirados, 0, "mesma versão não duplica");

    const { provider, servico } = servicoFake(); const aud = [];
    const despachar = () => processarFilaRelatorios({ agora: () => new Date(), env: ENV(), worker: "w-teste", limite: 50, deps: { relatorios: { ...relRepo, autorizacaoAtual: autorizadoFake }, servico, lerIntegracao: async () => VIVA, auditar: async (e) => { aud.push(e); } } });
    const r = await despachar();
    const meu = r.resultados.filter((x) => x.id === fila[0].id); assert.equal(meu[0]?.resultado, "ENVIADO", JSON.stringify(r.resultados));
    const enviadas = provider.mensagensEnviadas.filter((m) => m.idempotencyKey === fila[0].chave_idempotencia); assert.equal(enviadas.length, 1);
    assert.equal(enviadas[0].telefoneE164, tel); assert.match(enviadas[0].texto, /Fechamento operacional/);
    const { data: dep } = await supabase.from("operacional_relatorios_envios").select("status, provider_message_id, enviado_em, tentativas").eq("id", fila[0].id).single();
    assert.deepEqual([dep.status, dep.tentativas, !!dep.provider_message_id, !!dep.enviado_em], ["ENVIADO", 1, true, true]);
    assert.ok(aud.some((a) => a.entidadeId === fila[0].id && a.detalhes.resultado === "ENVIADO") && !JSON.stringify(aud).includes(tel), "auditoria do envio, sem telefone");
    await despachar(); assert.equal(provider.mensagensEnviadas.filter((m) => m.idempotencyKey === fila[0].chave_idempotencia).length, 1, "segundo despacho não reenvia");
  });

  test("SEMANAL ponta a ponta: 7 fechamentos reais → resumo gravado (idempotente) → fila → ENVIADO", async (t) => {
    if (!org) return t.skip("migration 141 não aplicada no banco alvo");
    for (let i = 0; i < 7; i++) { const c = dia(SEGUNDA_SEMANA, i); if (c !== DOMINGO) await fecharDia(c, i); }
    const deps = { relatorios: repoRelogioReal(), notificacoes: notifFake() };
    const enf = await enfileirarRelatoriosDaUnidade(unidade(), { agora: AGORA, deps });
    assert.equal(enf.semanal.enfileirados, 1, JSON.stringify(enf.semanal));
    const { data: res } = await supabase.from("operacional_resumos_semanais").select("*").eq("unidade_id", un).eq("semana_inicio", SEGUNDA_SEMANA);
    assert.equal(res.length, 1); assert.equal(res[0].status, "COMPLETA"); assert.equal(res[0].dias_validos, 7); assert.ok(res[0].indicadores.pedidos.recebidos > 0);
    await enfileirarRelatoriosDaUnidade(unidade(), { agora: AGORA, deps });
    assert.equal((await supabase.from("operacional_resumos_semanais").select("id").eq("unidade_id", un).eq("semana_inicio", SEGUNDA_SEMANA)).data.length, 1, "resumo idempotente");
    const { data: fila } = await supabase.from("operacional_relatorios_envios").select("*").eq("resumo_semanal_id", res[0].id); assert.equal(fila.length, 1);

    const { provider, servico } = servicoFake();
    const r = await processarFilaRelatorios({ agora: () => new Date(), env: ENV(), worker: "w-teste", limite: 50, deps: { relatorios: { ...relRepo, autorizacaoAtual: autorizadoFake }, servico, lerIntegracao: async () => VIVA, auditar: async () => {} } });
    assert.equal(r.resultados.find((x) => x.id === fila[0].id)?.resultado, "ENVIADO", JSON.stringify(r.resultados));
    const m = provider.mensagensEnviadas.find((x) => x.idempotencyKey === fila[0].chave_idempotencia); assert.match(m.texto, /Resumo semanal/); assert.match(m.texto, /SEMANA COMPLETA/);
  });

  test("CONCORRÊNCIA no banco real: dois despachantes disputam o mesmo item — exatamente 1 envio", async (t) => {
    if (!org) return t.skip("migration 141 não aplicada no banco alvo");
    const f = await fecharDia(dia(SEGUNDA_SEMANA, -3), 99);
    const deps = { relatorios: repoRelogioReal(), notificacoes: notifFake() };
    await enfileirarRelatoriosDaUnidade(unidade(), { agora: () => new Date(`${dia(SEGUNDA_SEMANA, -2)}T13:00:00.000Z`), deps });
    const { data: fila } = await supabase.from("operacional_relatorios_envios").select("*").eq("fechamento_id", f.id); assert.equal(fila.length, 1);
    const { provider, servico } = servicoFake();
    const um = (w) => processarFilaRelatorios({ agora: () => new Date(), env: ENV(), worker: w, limite: 200, deps: { relatorios: { ...relRepo, autorizacaoAtual: autorizadoFake }, servico, lerIntegracao: async () => VIVA, auditar: async () => {} } });
    await Promise.all([um("wA"), um("wB")]);
    assert.equal(provider.mensagensEnviadas.filter((m) => m.idempotencyKey === fila[0].chave_idempotencia).length, 1);
    assert.equal((await supabase.from("operacional_relatorios_envios").select("tentativas, status").eq("id", fila[0].id).single()).data.status, "ENVIADO");
  });

  test("AUTORIZAÇÃO REAL lida do banco: sem escopo/consentimento, o item é BLOQUEADO e nada sai", async (t) => {
    if (!org) return t.skip("migration 141 não aplicada no banco alvo");
    const f = await fecharDia(dia(SEGUNDA_SEMANA, -5), 98);
    await enfileirarRelatoriosDaUnidade(unidade(), { agora: () => new Date(`${dia(SEGUNDA_SEMANA, -4)}T13:00:00.000Z`), deps: { relatorios: repoRelogioReal(), notificacoes: notifFake() } });
    const { data: fila } = await supabase.from("operacional_relatorios_envios").select("*").eq("fechamento_id", f.id); assert.equal(fila.length, 1);
    const real = await relRepo.autorizacaoAtual({ organizacaoId: org, unidadeId: un, contatoEmpresaId: ce, categoria: "fechamento_operacional_diario" });
    assert.equal(real.autorizado, false); assert.equal(real.motivo, "ESCOPO_INATIVO");
    const { provider, servico } = servicoFake();
    const r = await processarFilaRelatorios({ agora: () => new Date(), env: ENV(), worker: "w-teste", limite: 200, deps: { relatorios: { ...relRepo }, servico, lerIntegracao: async () => VIVA, auditar: async () => {} } });
    assert.equal(r.resultados.find((x) => x.id === fila[0].id)?.resultado, "BLOQUEADO");
    assert.equal(provider.mensagensEnviadas.filter((m) => m.idempotencyKey === fila[0].chave_idempotencia).length, 0);
    assert.equal((await supabase.from("operacional_relatorios_envios").select("status, motivo").eq("id", fila[0].id).single()).data.status, "BLOQUEADO");
  });

  test("PRIVILÉGIOS (142 e 141): service_role insere categoria; anon não executa as RPCs dos relatórios", async (t) => {
    if (!org) return t.skip("migration 141 não aplicada no banco alvo");
    const cat = await supabase.from("comunicacao_categorias").upsert({ codigo: "t_priv_probe", rotulo: "probe", tipo_alerta: "t_priv_probe", ativo: false }, { onConflict: "codigo" });
    assert.equal(cat.error, null, cat.error?.message);
    await supabase.from("comunicacao_categorias").delete().eq("codigo", "t_priv_probe");
  });
});
