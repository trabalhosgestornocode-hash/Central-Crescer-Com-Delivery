// Migration 100 — INTEGRAÇÃO contra o banco de TESTE (RPC/constraints reais): responsável de comunicação por
// EMPRESA, regressão do caso Jailton, cancelamento por pendência resolvida, regra 10:00/10:30 e isolamento entre empresas.
// Rodar (só contra o projeto de TESTE, com a 100 aplicada):
//   node --experimental-vm-modules --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-100-integracao.test.js
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, criarUnidade, criarContaComPerfil, apagarConta, vincularUsuarioUnidade, migracao082Aplicada, migracao088Aplicada } from "./helpers/comunicacao-fixtures.js";
import * as alertasRepo from "../src/modules/comunicacao/comunicacao.alertas.repo.js";
import * as filaRepo from "../src/modules/comunicacao/comunicacao.fila.repo.js";
import { agendarEnviosPendentes, detectarESincronizarAlertas, processarProximoLote } from "../src/modules/comunicacao/comunicacao.alertas.service.js";
import { definirModo, modoAtual } from "../src/modules/comunicacao/comunicacao.config.js";
import { criarWhatsAppService } from "../src/modules/comunicacao/whatsapp.service.js";
import { criarFakeProvider } from "../src/modules/comunicacao/providers/fake.provider.js";
import { MODOS, TIPOS_ALERTA, SEVERIDADE, STATUS_ALERTA, STATUS_MENSAGEM } from "../src/modules/comunicacao/comunicacao.constants.js";
import * as svc from "../src/modules/administrativo/administrativo.comunicacao.service.js";

const PULAR = motivoPularIntegracao();
const tag = `c100${Date.now()}`;
const TIPO = TIPOS_ALERTA.DASHBOARD_IFOOD_D1;
const AUTOR = { contaId: null, perfilId: null, nome: "Teste 100" };

let pronto = false;
let GRUPO, MOGI, OUTRA;               // empresas (organizacoes)
let unGrupo = [], unMogi, unOutra;    // unidades
let jailton;                          // { contaId, perfilId } — tem ACESSO às três empresas
let foneGrupo, foneOutra;
let ceGrupo, ceOutra;                 // { contatoEmpresaId }
let modoOriginal = null, limitesOriginais = null, ttlOriginal = null;
const telefones = [];

const fone = (n) => { const t = `+55119${String(Date.now()).slice(-6)}${String(n).padStart(2, "0")}`; telefones.push(t); return t; };

// Quarta-feira 16/09/2026; America/Sao_Paulo = UTC-3 (sem DST). D-1 = 2026-09-15.
const local = (hhmm, dia = "2026-09-16") => new Date(`${dia}T${hhmm}:00-03:00`);
const D1 = "2026-09-15";
const D3 = "2026-09-13";
const TZ = "America/Sao_Paulo";

before(async () => {
  if (PULAR) return;
  const tabela = await supabase.from("comunicacao_contatos_empresa").select("id").limit(0);
  if (tabela.error || !(await migracao082Aplicada()) || !(await migracao088Aplicada())) return; // 100 ausente -> PULA
  pronto = true;

  modoOriginal = await modoAtual();
  limitesOriginais = (await supabase.from("comunicacao_configuracoes").select("valor").eq("chave", "limites").maybeSingle()).data?.valor ?? null;
  ttlOriginal = (await supabase.from("comunicacao_configuracoes").select("valor").eq("chave", "ttl_horas").maybeSingle()).data?.valor ?? null;
  await supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: { max_proativas_por_minuto: 5, max_proativas_por_minuto_por_organizacao: 1000, max_por_contato_por_dia: 50 } }, { onConflict: "chave" });
  // datas dos cenários são fixas no passado: TTL enorme para a mensagem não expirar pelo relógio real do banco
  await supabase.from("comunicacao_configuracoes").upsert({ chave: "ttl_horas", valor: 200000 }, { onConflict: "chave" });

  GRUPO = await criarOrganizacao(`TESTE ${tag} Grupo Jailton e Vanessa`);
  MOGI = await criarOrganizacao(`TESTE ${tag} Subway Centro - Mogi Mirim - SP`);
  OUTRA = await criarOrganizacao(`TESTE ${tag} Outra Empresa`);
  unGrupo = [await criarUnidade(GRUPO, "Loja 1"), await criarUnidade(GRUPO, "Loja 2"), await criarUnidade(GRUPO, "Matriz")];
  unMogi = await criarUnidade(MOGI, `Matriz TESTE ${tag} Subway Centro - Mogi Mirim - SP`);
  unOutra = await criarUnidade(OUTRA, "Loja Outra");

  // Jailton: perfil com ACESSO ativo a TODAS as empresas e a unidades (exatamente o cenário de produção)
  jailton = await criarContaComPerfil(tag, "jailton");
  await supabase.from("perfis_operacionais").update({ nome: "Jailton Matos" }).eq("id", jailton.perfilId);
  await vincularUsuarioUnidade({ perfilId: jailton.perfilId, organizacaoId: GRUPO, unidadeId: unGrupo[0] });
  await vincularUsuarioUnidade({ perfilId: jailton.perfilId, organizacaoId: MOGI, unidadeId: unMogi });
  await vincularUsuarioUnidade({ perfilId: jailton.perfilId, organizacaoId: OUTRA, unidadeId: unOutra });

  // responsáveis CADASTRADOS pelo caminho real do painel (service -> repo -> banco)
  foneGrupo = fone(1); foneOutra = fone(2);
  ceGrupo = await svc.salvarResponsavel({ organizacaoId: GRUPO, nome: "Jailton Matos", telefoneE164: foneGrupo }, AUTOR);
  ceOutra = await svc.salvarResponsavel({ organizacaoId: OUTRA, nome: "Responsável Outra", telefoneE164: foneOutra }, AUTOR);
  for (const [org, ce] of [[GRUPO, ceGrupo], [OUTRA, ceOutra]]) {
    await svc.validarResponsavel({ organizacaoId: org, contatoEmpresaId: ce.contatoEmpresaId, confirmacaoExplicita: true }, AUTOR);
    await svc.atualizarConfiguracao({ organizacaoId: org, timezone: TZ, tiposPermitidos: [TIPO] }, AUTOR);
    // habilita direto no banco (fixture): a ação humana + gates do piloto (093/definirHabilitacao) têm testes próprios; aqui o foco é o motor.
    const hb = await supabase.from("comunicacao_habilitacoes").update({ habilitado: true }).eq("organizacao_id", org);
    if (hb.error) throw new Error("fixture habilitar: " + hb.error.message);
  }
  await definirModo(MODOS.NORMAL, {});
});

after(async () => {
  if (!pronto) return;
  if (modoOriginal) await definirModo(modoOriginal, {}).catch(() => {});
  if (limitesOriginais) await supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: limitesOriginais }, { onConflict: "chave" });
  if (ttlOriginal !== null) await supabase.from("comunicacao_configuracoes").upsert({ chave: "ttl_horas", valor: ttlOriginal }, { onConflict: "chave" });
  else await supabase.from("comunicacao_configuracoes").delete().eq("chave", "ttl_horas");
  for (const org of [GRUPO, MOGI, OUTRA]) await apagarOrganizacao(org); // cascade: responsáveis, habilitações, alertas, mensagens
  if (jailton) await apagarConta(jailton.contaId);
  await supabase.from("contatos_whatsapp").delete().in("telefone_e164", telefones);
});

beforeEach(async () => {
  if (!pronto) return;
  await supabase.from("comunicacao_mensagens").delete().in("organizacao_id", [GRUPO, MOGI, OUTRA]);
  await supabase.from("comunicacao_alertas").delete().in("organizacao_id", [GRUPO, MOGI, OUTRA]);
});

const ce = async (id) => (await supabase.from("comunicacao_contatos_empresa").select("*").eq("id", id).single()).data;
const msgs = async (org) => (await supabase.from("comunicacao_mensagens").select("*").eq("organizacao_id", org)).data ?? [];
const habilitacaoDe = async (org) => (await supabase.from("comunicacao_habilitacoes").select("*").eq("organizacao_id", org).single()).data;

async function novoAlerta(org, unidade, dataReferencia) {
  const { alerta } = await alertasRepo.criarOuEscalonarAlerta({
    organizacaoId: org, unidadeId: unidade, tipoAlerta: TIPO, dataReferencia, destinatarioPerfilId: null,
    severidade: SEVERIDADE.ATENCAO, motivo: "1 dia(s) pendente(s)", metadados: { unidade_nome: "Loja" },
  });
  return alerta;
}
const rpc = (alerta, extra = {}) => filaRepo.agendarMensagemDoAlerta({
  alertaId: alerta.id, tipo: TIPO, conteudo: "aviso", idempotencyKey: `wa:alerta:${alerta.id}:v1`,
  disponivelEm: new Date(Date.now() - 60_000), expiraEm: new Date(Date.now() + 3600_000), ...extra,
});
function providerComSpy() {
  const provider = criarFakeProvider();
  const chamadas = [];
  const original = provider.sendText.bind(provider);
  provider.sendText = async (args) => { chamadas.push(args); return original(args); };
  // (gate de identidade da conta conectada, aba Conexão/097: fail-closed sem ele — aqui a conta está "confirmada")
  return { chamadas, whatsAppService: criarWhatsAppService({ provider, identidadeConfirmada: async () => true }) };
}
const lote = (whatsAppService, agora, extra = {}) => processarProximoLote({ limite: 20, worker: "t100", whatsAppService, agora, ...extra });
const pulaSePreciso = (t) => { if (!pronto) { t.skip("100 não aplicada neste banco (ou alvo não confirmado como TESTE) — pulando."); return true; } return false; };

describe("1) CASO JAILTON — acesso a várias empresas NÃO vira responsável de comunicação (banco real)", { skip: PULAR }, () => {
  test("Jailton é responsável SOMENTE do Grupo; Mogi Mirim (onde ele tem acesso e unidade) fica sem responsável", async (t) => {
    if (pulaSePreciso(t)) return;
    // EVIDÊNCIA 1: o acesso existe nas três empresas (a causa raiz do bug)
    const { data: acessos } = await supabase.from("usuarios_organizacoes").select("organizacao_id").eq("perfil_id", jailton.perfilId).eq("ativo", true);
    assert.deepEqual(acessos.map((a) => a.organizacao_id).sort(), [GRUPO, MOGI, OUTRA].sort(), "Jailton tem acesso ativo às 3 empresas");
    const { data: acessosUnid } = await supabase.from("usuarios_unidades").select("unidade_id").eq("perfil_id", jailton.perfilId);
    assert.ok(acessosUnid.some((a) => a.unidade_id === unMogi), "e à unidade Matriz de Mogi Mirim");

    // EVIDÊNCIA 2: a camada de comunicação só tem responsável no Grupo
    const { data: linhas } = await supabase.from("comunicacao_contatos_empresa").select("organizacao_id, nome, tipo, ativo").in("organizacao_id", [GRUPO, MOGI, OUTRA]);
    const porOrg = Object.fromEntries(linhas.map((l) => [l.organizacao_id, l.nome]));
    assert.equal(porOrg[GRUPO], "Jailton Matos");
    assert.equal(porOrg[MOGI], undefined, "Mogi Mirim NÃO tem responsável");
    assert.equal(porOrg[OUTRA], "Responsável Outra");

    // EVIDÊNCIA 3: o que a aba Empresas / Visão Geral devolvem (mesmo payload que a UI renderiza)
    const lista = await svc.organizacoes({});
    const grupo = lista.find((e) => e.organizacaoId === GRUPO), mogi = lista.find((e) => e.organizacaoId === MOGI);
    assert.equal(grupo.responsavel.nome, "Jailton Matos");
    assert.equal(grupo.whatsappStatus, "VALIDADO");
    assert.equal(mogi.responsavel, null);
    assert.equal(mogi.whatsappStatus, "NAO_CADASTRADO");
    assert.doesNotMatch(JSON.stringify(mogi), /Jailton/);
    const detMogi = await svc.detalheOrganizacao({ organizacaoId: MOGI });
    assert.equal(detMogi.configuracao.destinatario, null);
    assert.doesNotMatch(JSON.stringify(detMogi), /Jailton/);
    console.log("[EVIDENCIA-JAILTON]", JSON.stringify({ grupo: { nome: grupo.nome.replace(tag, "…"), responsavel: grupo.responsavel.nome, whatsapp: grupo.whatsappStatus }, mogi: { nome: mogi.nome.replace(tag, "…"), responsavel: mogi.responsavel, whatsapp: mogi.whatsappStatus }, acessoJailtonEmpresas: acessos.length }));
  });

  test("trocar unidade/perfil/acessos do Jailton NÃO altera nenhum responsável", async (t) => {
    if (pulaSePreciso(t)) return;
    const antes = JSON.stringify((await svc.organizacoes({})).filter((e) => [GRUPO, MOGI, OUTRA].includes(e.organizacaoId)));
    await supabase.from("usuarios_unidades").delete().eq("perfil_id", jailton.perfilId).eq("unidade_id", unMogi); // "trocou de unidade"
    await supabase.from("perfis_operacionais").update({ ativo: false }).eq("id", jailton.perfilId);          // "perfil ativo diferente"
    await supabase.from("usuarios_organizacoes").update({ ativo: false }).eq("perfil_id", jailton.perfilId).eq("organizacao_id", GRUPO);
    try {
      const depois = JSON.stringify((await svc.organizacoes({})).filter((e) => [GRUPO, MOGI, OUTRA].includes(e.organizacaoId)));
      assert.equal(depois, antes);
      // e o agendamento continua indo para o responsável cadastrado, sem depender do perfil/acesso do Jailton
      const alerta = await novoAlerta(GRUPO, unGrupo[0], D1);
      assert.equal((await rpc(alerta)).acao, "CRIADA");
      assert.equal((await msgs(GRUPO))[0].telefone_snapshot, foneGrupo);
    } finally {
      await supabase.from("perfis_operacionais").update({ ativo: true }).eq("id", jailton.perfilId);
      await supabase.from("usuarios_organizacoes").update({ ativo: true }).eq("perfil_id", jailton.perfilId).eq("organizacao_id", GRUPO);
      await supabase.from("usuarios_unidades").insert({ usuario_id: jailton.contaId, unidade_id: unMogi, perfil_id: jailton.perfilId, ativo: true });
    }
  });
});

describe("4) contato errado / empresa errada — direto no banco/RPC", { skip: PULAR }, () => {
  test("RPC feliz grava SNAPSHOT (empresa, contato, telefone, data) e unidade só do alerta", async (t) => {
    if (pulaSePreciso(t)) return;
    const alerta = await novoAlerta(GRUPO, unGrupo[1], D1);
    const r = await rpc(alerta);
    assert.equal(r.acao, "CRIADA");
    const m = (await msgs(GRUPO))[0];
    assert.equal(m.organizacao_id, GRUPO);
    assert.equal(m.empresa_nome_snapshot, `TESTE ${tag} Grupo Jailton e Vanessa`);
    assert.equal(m.contato_nome_snapshot, "Jailton Matos");
    assert.equal(m.telefone_snapshot, foneGrupo);
    assert.equal(m.contato_empresa_id, ceGrupo.contatoEmpresaId);
    assert.equal(String(m.data_referencia).slice(0, 10), D1);
    assert.equal(m.unidade_id, unGrupo[1], "unidade só porque o ALERTA é dessa unidade");
    assert.equal(m.destinatario_perfil_id, null, "o responsável não é perfil/usuário");
  });

  test("o alerta da Empresa B só usa o responsável da B; o da A nunca aparece no envio da B", async (t) => {
    if (pulaSePreciso(t)) return;
    const aB = await novoAlerta(OUTRA, unOutra, D1);
    assert.equal((await rpc(aB)).acao, "CRIADA");
    const m = (await msgs(OUTRA))[0];
    assert.equal(m.telefone_snapshot, foneOutra);
    assert.equal(m.contato_nome_snapshot, "Responsável Outra");
    assert.notEqual(m.telefone_snapshot, foneGrupo);
  });

  test("o BANCO recusa apontar a habilitação da Empresa B para o responsável da Empresa A (FK composta)", async (t) => {
    if (pulaSePreciso(t)) return;
    const hA = await habilitacaoDe(GRUPO);
    const r = await supabase.from("comunicacao_habilitacoes")
      .update({ destinatario_contato_empresa_id: ceGrupo.contatoEmpresaId, destinatario_contato_id: hA.destinatario_contato_id }).eq("organizacao_id", OUTRA);
    assert.ok(r.error, "deveria ter sido recusado");
    assert.match(String(r.error.code) + r.error.message, /23503|22023|foreign key|violates|outra empresa/i); // trigger (22023) ou FK (23503): o banco recusa nos dois níveis
    assert.equal((await habilitacaoDe(OUTRA)).destinatario_contato_empresa_id, ceOutra.contatoEmpresaId, "a linha não pode ter mudado");
  });

  test("contato INATIVO não agenda (DESTINATARIO_INELEGIVEL) e nenhuma mensagem nasce", async (t) => {
    if (pulaSePreciso(t)) return;
    await supabase.from("comunicacao_contatos_empresa").update({ ativo: false }).eq("id", ceGrupo.contatoEmpresaId);
    try {
      const alerta = await novoAlerta(GRUPO, unGrupo[0], D1);
      assert.equal((await rpc(alerta)).acao, "DESTINATARIO_INELEGIVEL");
      assert.equal((await msgs(GRUPO)).length, 0);
    } finally { await supabase.from("comunicacao_contatos_empresa").update({ ativo: true }).eq("id", ceGrupo.contatoEmpresaId); }
  });

  test("telefone NÃO validado não agenda (status do responsável e flags do contato)", async (t) => {
    if (pulaSePreciso(t)) return;
    const original = await ce(ceGrupo.contatoEmpresaId);
    for (const status of ["AGUARDANDO_VALIDACAO", "NAO_VALIDADO", "ERRO"]) {
      await supabase.from("comunicacao_contatos_empresa").update({ whatsapp_status: status }).eq("id", ceGrupo.contatoEmpresaId);
      const alerta = await novoAlerta(GRUPO, unGrupo[0], D1);
      assert.equal((await rpc(alerta)).acao, "DESTINATARIO_INELEGIVEL", status);
      await supabase.from("comunicacao_alertas").delete().eq("id", alerta.id);
    }
    await supabase.from("comunicacao_contatos_empresa").update({ whatsapp_status: "VALIDADO" }).eq("id", original.id);
    // consentimento/verificado do registro do telefone também vetam
    for (const campo of [{ consentimento: false }, { verificado: false }, { opt_out: true }]) {
      await supabase.from("contatos_whatsapp").update(campo).eq("id", original.contato_whatsapp_id);
      const alerta = await novoAlerta(GRUPO, unGrupo[0], D1);
      assert.equal((await rpc(alerta)).acao, "DESTINATARIO_INELEGIVEL", JSON.stringify(campo));
      await supabase.from("comunicacao_alertas").delete().eq("id", alerta.id);
      await supabase.from("contatos_whatsapp").update({ consentimento: true, verificado: true, opt_out: false }).eq("id", original.contato_whatsapp_id);
    }
    assert.equal((await msgs(GRUPO)).length, 0);
  });

  test("responsável de OUTRA empresa com o MESMO telefone não contamina: cada empresa tem seu vínculo e sua validação", async (t) => {
    if (pulaSePreciso(t)) return;
    // Outra empresa cadastra o MESMO número do Grupo: nasce AGUARDANDO_VALIDACAO (a validação é por empresa)
    const r = await svc.salvarResponsavel({ organizacaoId: MOGI, nome: "Mesmo Telefone", telefoneE164: foneGrupo }, AUTOR);
    const c = await ce(r.contatoEmpresaId);
    assert.equal(c.organizacao_id, MOGI);
    assert.equal(c.whatsapp_status, "AGUARDANDO_VALIDACAO");
    assert.equal((await ce(ceGrupo.contatoEmpresaId)).whatsapp_status, "VALIDADO", "a validação do Grupo não muda");
    // sem habilitação em Mogi (habilitado=false): não agenda, mesmo o telefone estando validado noutra empresa
    const alerta = await novoAlerta(MOGI, unMogi, D1);
    assert.equal((await rpc(alerta)).acao, "NAO_HABILITADA");
    await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", MOGI); // primeiro a habilitação (FK)
    await supabase.from("comunicacao_contatos_empresa").delete().eq("id", r.contatoEmpresaId);
  });
});

describe("2) pendência resolvida antes do envio => a mensagem NUNCA sai", { skip: PULAR }, () => {
  test("D-1 pendente -> agendada -> D-1 preenchido ANTES do horário de envio -> cancelada; provider recebe ZERO chamadas", async (t) => {
    if (pulaSePreciso(t)) return;
    const agora = local("10:45");
    const alerta = await novoAlerta(GRUPO, unGrupo[0], D1);
    const ag = await agendarEnviosPendentes({ organizacaoId: GRUPO, agora });
    assert.equal(ag.agendados, 1, JSON.stringify(ag));
    const antes = (await msgs(GRUPO))[0];
    assert.equal(antes.status, STATUS_MENSAGEM.SCHEDULED);

    // o cliente PREENCHE o D-1: a pendência some do snapshot da rodada seguinte
    const det = await detectarESincronizarAlertas({ pendenciasSnapshot: { unidades: [], d1: D1, organizacoesMonitoradas: [GRUPO] } });
    assert.equal(det.resolvidos, 1);
    assert.equal(det.detalheResolvidos[0].mensagensCanceladas, 1);

    const { chamadas, whatsAppService } = providerComSpy();
    const r = await lote(whatsAppService, agora, { pendenciasSnapshot: { unidades: [], d1: D1 } });
    assert.equal(r.filter((x) => x.resultado === "ENVIADO").length, 0);
    assert.equal(chamadas.length, 0);
    const depois = (await msgs(GRUPO))[0];
    assert.equal(depois.status, STATUS_MENSAGEM.CANCELLED, "estado final da mensagem: CANCELLED");
    assert.equal((await supabase.from("comunicacao_alertas").select("status").eq("id", alerta.id).single()).data.status, STATUS_ALERTA.RESOLVED, "alerta RESOLVED");
  });

  test("resolvida DEPOIS do claim e ANTES do envio (revalidação no job): CANCELADO_PENDENCIA_RESOLVIDA, provider ZERO", async (t) => {
    if (pulaSePreciso(t)) return;
    const agora = local("10:45");
    const alerta = await novoAlerta(GRUPO, unGrupo[0], D1);
    assert.equal((await agendarEnviosPendentes({ organizacaoId: GRUPO, agora })).agendados, 1);
    const { chamadas, whatsAppService } = providerComSpy();
    const r = await lote(whatsAppService, agora, { pendenciasSnapshot: { unidades: [], d1: D1 } }); // já sem a pendência
    assert.equal(r.find((x) => x.resultado === "CANCELADO_PENDENCIA_RESOLVIDA") ? 1 : 0, 1, JSON.stringify(r));
    assert.equal(chamadas.length, 0);
    assert.equal((await msgs(GRUPO))[0].status, STATUS_MENSAGEM.CANCELLED);
    assert.equal((await supabase.from("comunicacao_alertas").select("status").eq("id", alerta.id).single()).data.status, STATUS_ALERTA.RESOLVED);
  });

  test("CONTROLE POSITIVO: com a pendência ainda existindo, a mesma fila ENVIA (1 chamada, ao telefone do responsável DA EMPRESA)", async (t) => {
    if (pulaSePreciso(t)) return;
    const agora = local("10:45");
    const alerta = await novoAlerta(GRUPO, unGrupo[0], D1);
    assert.equal((await agendarEnviosPendentes({ organizacaoId: GRUPO, agora })).agendados, 1);
    const { chamadas, whatsAppService } = providerComSpy();
    const snapshot = { unidades: [{ organizacaoId: GRUPO, unidadeId: unGrupo[0], criticidade: SEVERIDADE.ATENCAO }], d1: D1 };
    const r = await lote(whatsAppService, agora, { pendenciasSnapshot: snapshot });
    assert.equal(r.filter((x) => x.resultado === "ENVIADO").length, 1, JSON.stringify(r));
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].telefoneE164, foneGrupo);
    assert.equal((await msgs(GRUPO))[0].status, STATUS_MENSAGEM.SENT);
    void alerta;
  });

  test("telefone trocado depois do agendamento invalida a mensagem na fila (nunca vai para o número novo não validado)", async (t) => {
    if (pulaSePreciso(t)) return;
    const agora = local("10:45");
    await novoAlerta(GRUPO, unGrupo[0], D1);
    assert.equal((await agendarEnviosPendentes({ organizacaoId: GRUPO, agora })).agendados, 1);
    const novoFone = fone(3);
    await svc.salvarResponsavel({ organizacaoId: GRUPO, nome: "Jailton Matos", telefoneE164: novoFone }, AUTOR); // volta a AGUARDANDO_VALIDACAO
    const { chamadas, whatsAppService } = providerComSpy();
    const snapshot = { unidades: [{ organizacaoId: GRUPO, unidadeId: unGrupo[0], criticidade: SEVERIDADE.ATENCAO }], d1: D1 };
    const r = await lote(whatsAppService, agora, { pendenciasSnapshot: snapshot });
    assert.equal(chamadas.length, 0);
    assert.equal(r.filter((x) => x.resultado === "BLOQUEADO").length, 1, JSON.stringify(r));
    // restaura: telefone original, validado
    const cur = await svc.salvarResponsavel({ organizacaoId: GRUPO, nome: "Jailton Matos", telefoneE164: foneGrupo }, AUTOR);
    await svc.validarResponsavel({ organizacaoId: GRUPO, contatoEmpresaId: cur.contatoEmpresaId, confirmacaoExplicita: true }, AUTOR);
    assert.equal((await habilitacaoDe(GRUPO)).habilitado, true, "habilitado preservado durante todo o vai-e-vem");
    ceGrupo = { contatoEmpresaId: cur.contatoEmpresaId };
  });
});

describe("3) regra 10:00 / 10:30 — banco real", { skip: PULAR }, () => {
  async function agenda(hhmm, ref) {
    await novoAlerta(GRUPO, unGrupo[0], ref);
    return agendarEnviosPendentes({ organizacaoId: GRUPO, agora: local(hhmm) });
  }
  for (const hhmm of ["08:00", "09:59", "10:00", "10:15", "10:29"]) {
    test(`${hhmm} com D-1 pendente: NÃO agenda e nenhuma mensagem entra na fila`, async (t) => {
      if (pulaSePreciso(t)) return;
      const r = await agenda(hhmm, D1);
      assert.equal(r.agendados, 0, JSON.stringify(r));
      assert.equal(r.aguardandoDisponibilidadeIfood, 1);
      assert.equal((await msgs(GRUPO)).length, 0);
    });
  }
  for (const hhmm of ["10:30", "10:45"]) {
    test(`${hhmm} com D-1 ainda pendente: entra no fluxo (mensagem criada, não antes de ${hhmm})`, async (t) => {
      if (pulaSePreciso(t)) return;
      const r = await agenda(hhmm, D1);
      assert.equal(r.agendados, 1, JSON.stringify(r));
      const [m] = await msgs(GRUPO);
      assert.equal(m.status, STATUS_MENSAGEM.SCHEDULED);
      assert.ok(new Date(m.disponivel_em).getTime() >= local(hhmm).getTime());
    });
  }
  test("pendência ANTERIOR a D-1 (D-3) não é bloqueada às 08:00 — segue só a janela comercial", async (t) => {
    if (pulaSePreciso(t)) return;
    const r = await agenda("08:00", D3);
    assert.equal(r.agendados, 1, JSON.stringify(r));
    assert.equal(r.aguardandoDisponibilidadeIfood, 0);
  });
  test("mensagem D-1 já na fila NÃO é enviada entre 10:00 e 10:29 (adiada), e sai a partir de 10:30", async (t) => {
    if (pulaSePreciso(t)) return;
    const alerta = await novoAlerta(GRUPO, unGrupo[0], D1);
    await filaRepo.agendarMensagem({
      alertaId: alerta.id, organizacaoId: GRUPO, unidadeId: unGrupo[0], contatoId: (await ce(ceGrupo.contatoEmpresaId)).contato_whatsapp_id,
      contatoEmpresaId: ceGrupo.contatoEmpresaId, telefoneSnapshot: foneGrupo, empresaNomeSnapshot: "x", contatoNomeSnapshot: "Jailton Matos", dataReferencia: D1,
      tipo: TIPO, conteudo: "aviso", idempotencyKey: `wa:alerta:${alerta.id}:v1`, disponivelEm: new Date(Date.now() - 60_000),
    });
    const snapshot = { unidades: [{ organizacaoId: GRUPO, unidadeId: unGrupo[0], criticidade: SEVERIDADE.ATENCAO }], d1: D1 };
    const { chamadas, whatsAppService } = providerComSpy();
    const cedo = await lote(whatsAppService, local("10:15"), { pendenciasSnapshot: snapshot });
    assert.equal(cedo.length, 1);
    assert.equal(cedo[0].resultado, "ADIADO");
    assert.equal(cedo[0].motivo, "OUTSIDE_ALLOWED_WINDOW");
    assert.equal(chamadas.length, 0, "às 10:15 nada é enviado");
    // (o banco impõe disponivel_em >= now()+1min; o instante local >= 10:30 é provado nos testes unitários de calcularDisponivelEm)
    assert.equal((await msgs(GRUPO))[0].status, STATUS_MENSAGEM.SCHEDULED, "continua na fila, não foi enviada nem bloqueada");
    // simula a passagem do tempo até o novo horário: torna a mensagem elegível para claim de novo
    await supabase.from("comunicacao_mensagens").update({ disponivel_em: new Date(Date.now() - 60_000).toISOString() }).eq("organizacao_id", GRUPO);
    const tarde = await lote(whatsAppService, local("10:45"), { pendenciasSnapshot: snapshot });
    assert.equal(tarde.filter((x) => x.resultado === "ENVIADO").length, 1, JSON.stringify(tarde));
    assert.equal(chamadas.length, 1);
  });
});

describe("5) empresa com várias unidades — UMA vez na aba Empresas", { skip: PULAR }, () => {
  test("Grupo (3 unidades) aparece uma vez com unidades=3; há UM responsável (não 3); unidades fazem parte da pendência, não do cadastro", async (t) => {
    if (pulaSePreciso(t)) return;
    const lista = await svc.organizacoes({});
    const nossas = lista.filter((e) => [GRUPO, MOGI, OUTRA].includes(e.organizacaoId));
    assert.equal(nossas.length, 3);
    assert.equal(lista.filter((e) => e.organizacaoId === GRUPO).length, 1);
    assert.equal(lista.find((e) => e.organizacaoId === GRUPO).unidadesMonitoradas, 3);
    const { data } = await supabase.from("comunicacao_contatos_empresa").select("id").eq("organizacao_id", GRUPO);
    assert.equal(data.length, 1);
    assert.ok(!nossas.some((e) => /Loja \d|Matriz TESTE/.test(e.nome)), "unidades nunca viram linhas de empresa");
  });
});

describe("8) integridade da migration 100 (constraints reais)", { skip: PULAR }, () => {
  const base = () => ({ organizacao_id: MOGI, nome: "X", telefone_e164: fone(9), tipo: "principal", whatsapp_status: "AGUARDANDO_VALIDACAO", ativo: true });
  test("organizacao_id é obrigatório", async (t) => {
    if (pulaSePreciso(t)) return;
    const { organizacao_id, ...sem } = base();
    const r = await supabase.from("comunicacao_contatos_empresa").insert(sem);
    assert.equal(r.error?.code, "23502");
  });
  test("no máximo UM principal ATIVO por empresa; secundário/financeiro podem coexistir; telefone ativo não repete na empresa", async (t) => {
    if (pulaSePreciso(t)) return;
    const a = await supabase.from("comunicacao_contatos_empresa").insert(base()).select("id").single();
    assert.ok(!a.error, a.error?.message);
    const b = await supabase.from("comunicacao_contatos_empresa").insert({ ...base(), nome: "Y" });
    assert.equal(b.error?.code, "23505", "segundo principal ativo deve ser recusado");
    const c = await supabase.from("comunicacao_contatos_empresa").insert({ ...base(), nome: "Fin", tipo: "financeiro" }).select("id").single();
    assert.ok(!c.error, "financeiro coexiste: " + c.error?.message);
    const d = await supabase.from("comunicacao_contatos_empresa").insert({ ...base(), nome: "Rep", tipo: "operacional", telefone_e164: (await ce(a.data.id)).telefone_e164 });
    assert.equal(d.error?.code, "23505", "mesmo telefone ativo na mesma empresa");
    await supabase.from("comunicacao_contatos_empresa").update({ ativo: false }).eq("id", a.data.id);
    const e = await supabase.from("comunicacao_contatos_empresa").insert({ ...base(), nome: "Novo principal" }).select("id").single();
    assert.ok(!e.error, "com o anterior inativo, um novo principal é aceito: " + e.error?.message);
    await supabase.from("comunicacao_contatos_empresa").delete().eq("organizacao_id", MOGI);
  });
  test("checks: VALIDADO exige data; telefone E.164; nome não vazio; tipo/status fechados", async (t) => {
    if (pulaSePreciso(t)) return;
    for (const dados of [{ whatsapp_status: "VALIDADO" }, { telefone_e164: "123" }, { nome: "  " }, { tipo: "gerente" }, { whatsapp_status: "TALVEZ" }]) {
      const r = await supabase.from("comunicacao_contatos_empresa").insert({ ...base(), ...dados });
      assert.equal(r.error?.code, "23514", JSON.stringify(dados));
    }
  });
  test("habilitação recusa responsável INATIVO (trigger) e o par (contato, responsável) tem de coincidir", async (t) => {
    if (pulaSePreciso(t)) return;
    await supabase.from("comunicacao_contatos_empresa").update({ ativo: false }).eq("id", ceOutra.contatoEmpresaId);
    const h = await habilitacaoDe(OUTRA);
    const r = await supabase.from("comunicacao_habilitacoes").update({ timezone: "America/Fortaleza" }).eq("organizacao_id", OUTRA);
    assert.ok(r.error, "atualizar habilitação apontando para responsável inativo deve ser recusado");
    await supabase.from("comunicacao_contatos_empresa").update({ ativo: true }).eq("id", ceOutra.contatoEmpresaId);
    const par = await supabase.from("comunicacao_habilitacoes").update({ destinatario_contato_id: null }).eq("organizacao_id", OUTRA);
    assert.ok(par.error, "contato e responsável andam juntos (trigger 22023 ou check destinatario_coerente 23514)");
    assert.equal((await habilitacaoDe(OUTRA)).destinatario_contato_id, h.destinatario_contato_id);
  });
});

// ============================================================================================================
// Novos cenários sobre a base 099 (reforço, aviso tardio, habilitação do piloto, roster/Central, backfill)
// ============================================================================================================
import * as rosterRepo from "../src/modules/comunicacao/comunicacao.roster.js";

const rpcDireto = (nome, args) => supabase.rpc(nome, args);

describe("11) BACKFILL — mensagens SCHEDULED que já existiam ANTES da migração continuam válidas (não viram SEM_VINCULO)", { skip: PULAR }, () => {
  async function legada(alerta, contatoWhatsappId, extra = {}) {
    // mensagem no formato PRÉ-100: contato + perfil, SEM contato_empresa_id / snapshot
    return filaRepo.agendarMensagem({
      alertaId: alerta.id, organizacaoId: alerta.organizacao_id, unidadeId: alerta.unidade_id, contatoId: contatoWhatsappId,
      destinatarioPerfilId: jailton.perfilId, tipo: TIPO, conteudo: "aviso legado", idempotencyKey: `wa:alerta:${alerta.id}:v1`,
      disponivelEm: new Date(Date.now() - 60_000), ...extra,
    });
  }

  test("CONTROLE: sem o backfill, uma mensagem legada é BLOQUEADA (SEM_VINCULO) — é exatamente o que a migração evita", async (t) => {
    if (pulaSePreciso(t)) return;
    const alerta = await novoAlerta(GRUPO, unGrupo[2], D1);
    const cw = (await ce(ceGrupo.contatoEmpresaId)).contato_whatsapp_id;
    await legada(alerta, cw);
    const { chamadas, whatsAppService } = providerComSpy();
    const snapshot = { unidades: [{ organizacaoId: GRUPO, unidadeId: unGrupo[2], criticidade: SEVERIDADE.ATENCAO }], d1: D1 };
    const r = await lote(whatsAppService, local("10:45"), { pendenciasSnapshot: snapshot });
    assert.equal(r[0]?.resultado, "BLOQUEADO", JSON.stringify(r));
    // sem contato_empresa_id o responsável não é reconhecido: bloqueio PERMANENTE (BLOCKED), nada é enviado
    assert.ok(["SEM_VINCULO", "PHONE_NOT_VERIFIED", "USER_INACTIVE"].includes(r[0]?.motivo), r[0]?.motivo);
    assert.equal(chamadas.length, 0);
    assert.equal((await msgs(GRUPO))[0].status, "BLOCKED");
  });

  test("as 2 mensagens SCHEDULED legadas são vinculadas ao responsável (com snapshot) e SÃO processadas — nunca SEM_VINCULO; terminais e o 2º contato do Jailton ficam intocados", async (t) => {
    if (pulaSePreciso(t)) return;
    const cw = (await ce(ceGrupo.contatoEmpresaId)).contato_whatsapp_id;
    const a1 = await novoAlerta(GRUPO, unGrupo[0], D1);
    const a2 = await novoAlerta(GRUPO, unGrupo[1], D1);
    const m1 = await legada(a1, cw);
    const m2 = await legada(a2, cw);
    // histórico legado: uma mensagem TERMINAL (SENT) do mesmo contato — não pode ser alterada
    const a3 = await novoAlerta(GRUPO, unGrupo[2], D1);
    const m3 = await legada(a3, cw, { disponivelEm: new Date(Date.now() - 3600_000) });
    await supabase.from("comunicacao_mensagens").update({ status: "SENT" }).eq("id", m3.id);
    // o SEGUNDO contato do Jailton (mesmo perfil, número diferente, sem vínculo de habilitação): NÃO pode ganhar responsável
    const segundo = await supabase.from("contatos_whatsapp").insert({ telefone_e164: fone(11), verificado: true, consentimento: true, opt_out: false }).select("id").single();
    await supabase.from("contatos_whatsapp_perfis").insert({ contato_id: segundo.data.id, perfil_operacional_id: jailton.perfilId, ativo: true, principal: false });

    const antes = await supabase.from("comunicacao_contatos_empresa").select("id").eq("organizacao_id", GRUPO);
    const n = await rpcDireto("comunicacao_vincular_mensagens_ao_responsavel", {});
    assert.equal(n.error, null, n.error?.message);
    assert.equal(n.data, 2, "exatamente as 2 mensagens SCHEDULED");

    for (const id of [m1.id, m2.id]) {
      const m = (await supabase.from("comunicacao_mensagens").select("*").eq("id", id).single()).data;
      assert.equal(m.status, "SCHEDULED");
      assert.equal(m.contato_empresa_id, ceGrupo.contatoEmpresaId);
      assert.equal(m.empresa_nome_snapshot, `TESTE ${tag} Grupo Jailton e Vanessa`);
      assert.equal(m.contato_nome_snapshot, "Jailton Matos");
      assert.equal(m.telefone_snapshot, foneGrupo);
      assert.equal(String(m.data_referencia).slice(0, 10), D1);
      assert.equal(m.conteudo, "aviso legado", "conteúdo/estado/idempotência preservados");
    }
    const terminal = (await supabase.from("comunicacao_mensagens").select("contato_empresa_id, empresa_nome_snapshot, status").eq("id", m3.id).single()).data;
    assert.equal(terminal.contato_empresa_id, null, "mensagem terminal (histórico) NÃO é alterada");
    assert.equal(terminal.empresa_nome_snapshot, null);
    assert.equal(terminal.status, "SENT");
    const depois = await supabase.from("comunicacao_contatos_empresa").select("id").eq("organizacao_id", GRUPO);
    assert.equal(depois.data.length, antes.data.length, "nenhum responsável novo foi criado");
    assert.equal((await supabase.from("comunicacao_contatos_empresa").select("id").eq("contato_whatsapp_id", segundo.data.id)).data.length, 0, "o 2º contato do Jailton NÃO ganha responsável");
    assert.equal((await rpcDireto("comunicacao_vincular_mensagens_ao_responsavel", {})).data, 0, "idempotente: rodar de novo não muda nada");

    // e o motor ENVIA/processa — nunca SEM_VINCULO
    const { chamadas, whatsAppService } = providerComSpy();
    const snapshot = { unidades: [a1, a2].map((a) => ({ organizacaoId: GRUPO, unidadeId: a.unidade_id, criticidade: SEVERIDADE.ATENCAO })), d1: D1 };
    const r = await lote(whatsAppService, local("10:45"), { pendenciasSnapshot: snapshot });
    assert.equal(r.length, 2, JSON.stringify(r));
    assert.ok(!r.some((x) => x.resultado === "BLOQUEADO"), JSON.stringify(r));
    assert.ok(r.some((x) => x.resultado === "ENVIADO"), "ao menos uma sai; a outra pode ser adiada pelo cooldown do MESMO contato: " + JSON.stringify(r));
    assert.ok(r.every((x) => x.resultado === "ENVIADO" || (x.resultado === "ADIADO" && x.motivo === "COOLDOWN")), JSON.stringify(r));
    assert.ok(chamadas.every((c) => c.telefoneE164 === foneGrupo));
    await supabase.from("contatos_whatsapp_perfis").delete().eq("contato_id", segundo.data.id);
    await supabase.from("contatos_whatsapp").delete().eq("id", segundo.data.id);
  });

  test("PROCESSING legada (já reivindicada por um worker antes da migração) também é vinculada; terminal FAILED/BLOCKED não", async (t) => {
    if (pulaSePreciso(t)) return;
    const cw = (await ce(ceGrupo.contatoEmpresaId)).contato_whatsapp_id;
    const a1 = await novoAlerta(GRUPO, unGrupo[0], D1);
    const a2 = await novoAlerta(GRUPO, unGrupo[1], D1);
    const proc = await legada(a1, cw);
    const bloq = await legada(a2, cw);
    const r1 = await supabase.from("comunicacao_mensagens").update({ status: "PROCESSING" }).eq("id", proc.id);
    assert.equal(r1.error, null, r1.error?.message);
    await supabase.from("comunicacao_mensagens").update({ status: "BLOCKED" }).eq("id", bloq.id);
    const n = await rpcDireto("comunicacao_vincular_mensagens_ao_responsavel", {});
    assert.equal(n.error, null, n.error?.message);
    assert.equal(n.data, 1, "só a PROCESSING");
    const m = (await supabase.from("comunicacao_mensagens").select("status, contato_empresa_id, empresa_nome_snapshot, telefone_snapshot").eq("id", proc.id).single()).data;
    assert.deepEqual([m.status, m.contato_empresa_id, m.telefone_snapshot], ["PROCESSING", ceGrupo.contatoEmpresaId, foneGrupo]);
    assert.equal(m.empresa_nome_snapshot, `TESTE ${tag} Grupo Jailton e Vanessa`);
    const b = (await supabase.from("comunicacao_mensagens").select("contato_empresa_id").eq("id", bloq.id).single()).data;
    assert.equal(b.contato_empresa_id, null);
  });
});

describe("12) Jailton com acesso a DEZENAS de empresas NÃO cria responsáveis — só o Grupo o tem como responsável de comunicação", { skip: PULAR }, () => {
  const extras = [];
  after(async () => { for (const o of extras) await apagarOrganizacao(o); });

  test("30 empresas adicionais com acesso do Jailton: nenhuma ganha responsável; roster e Central só reconhecem o Grupo", async (t) => {
    if (pulaSePreciso(t)) return;
    for (let i = 0; i < 30; i++) {
      const o = await criarOrganizacao(`TESTE ${tag} Empresa Extra ${i}`);
      extras.push(o);
      await vincularUsuarioUnidade({ perfilId: jailton.perfilId, organizacaoId: o, unidadeId: null });
    }
    const { data: acessos } = await supabase.from("usuarios_organizacoes").select("organizacao_id").eq("perfil_id", jailton.perfilId).eq("ativo", true);
    assert.ok(acessos.length >= 33, `Jailton tem acesso a ${acessos.length} empresas`);

    // 1) NENHUM responsável nasceu para as empresas extras
    const { data: linhas } = await supabase.from("comunicacao_contatos_empresa").select("organizacao_id, nome").in("organizacao_id", extras);
    assert.deepEqual(linhas, []);
    // 2) o cadastro de responsáveis (todas as empresas do teste): só o Grupo tem "Jailton Matos"
    const { data: todos } = await supabase.from("comunicacao_contatos_empresa").select("organizacao_id, nome").in("organizacao_id", [GRUPO, MOGI, OUTRA, ...extras]);
    assert.deepEqual(todos.filter((c) => c.nome === "Jailton Matos").map((c) => c.organizacao_id), [GRUPO]);
    // 3) a Aba Empresas: só o Grupo tem "Jailton"
    const lista = await svc.organizacoes({});
    const nossas = lista.filter((e) => [GRUPO, MOGI, OUTRA, ...extras].includes(e.organizacaoId));
    assert.equal(nossas.length, 3 + 30);
    assert.deepEqual(nossas.filter((e) => e.responsavel?.nome === "Jailton Matos").map((e) => e.organizacaoId), [GRUPO]);
    assert.ok(nossas.filter((e) => extras.includes(e.organizacaoId)).every((e) => e.responsavel === null && e.whatsappStatus === "NAO_CADASTRADO"));
    // 4) o ROSTER da Central (view 096 redefinida) reconhece o contato SÓ na empresa dele
    const { data: roster } = await supabase.from("comunicacao_roster_autorizado").select("organizacao_id, organizacao_nome, responsavel_nome, unidade_nome").eq("telefone_e164", foneGrupo);
    assert.ok(roster.length >= 1);
    assert.deepEqual([...new Set(roster.map((r) => r.organizacao_id))], [GRUPO]);
    assert.ok(!roster.some((r) => /Mogi Mirim/.test(r.organizacao_nome)), "Mogi Mirim nunca aparece para o Jailton");
    const autorizado = await rosterRepo.buscarAutorizadoPorTelefone(foneGrupo);
    assert.deepEqual(autorizado.organizacoes.map((o) => o.organizacaoId), [GRUPO]);
    assert.equal(autorizado.nome, "Jailton Matos");
    assert.equal(autorizado.unidades.length, 3, "as 3 unidades do Grupo só para EXIBIÇÃO");
  });

  test("um contato que só está ligado ao perfil (contatos_whatsapp_perfis) NÃO é autorizado no roster", async (t) => {
    if (pulaSePreciso(t)) return;
    const solto = await supabase.from("contatos_whatsapp").insert({ telefone_e164: fone(12), verificado: true, consentimento: true, opt_out: false }).select("id, telefone_e164").single();
    await supabase.from("contatos_whatsapp_perfis").insert({ contato_id: solto.data.id, perfil_operacional_id: jailton.perfilId, ativo: true, principal: true });
    try {
      assert.equal(await rosterRepo.buscarAutorizadoPorTelefone(solto.data.telefone_e164), null);
      const { data } = await supabase.from("comunicacao_roster_autorizado").select("contato_id").eq("contato_id", solto.data.id);
      assert.deepEqual(data, []);
    } finally {
      await supabase.from("contatos_whatsapp_perfis").delete().eq("contato_id", solto.data.id);
      await supabase.from("contatos_whatsapp").delete().eq("id", solto.data.id);
    }
  });

  test("responsável INATIVO ou com WhatsApp não validado sai do roster", async (t) => {
    if (pulaSePreciso(t)) return;
    const visivel = async () => (await rosterRepo.buscarAutorizadoPorTelefone(foneOutra)) !== null;
    assert.equal(await visivel(), true);
    await supabase.from("comunicacao_contatos_empresa").update({ whatsapp_status: "AGUARDANDO_VALIDACAO" }).eq("id", ceOutra.contatoEmpresaId);
    assert.equal(await visivel(), false);
    await supabase.from("comunicacao_contatos_empresa").update({ whatsapp_status: "VALIDADO", ativo: false }).eq("id", ceOutra.contatoEmpresaId);
    assert.equal(await visivel(), false);
    await supabase.from("comunicacao_contatos_empresa").update({ ativo: true }).eq("id", ceOutra.contatoEmpresaId);
    assert.equal(await visivel(), true);
  });
});

describe("13) REFORÇO, AVISO TARDIO e HABILITAÇÃO DO PILOTO usam o responsável DA EMPRESA (092/093/094 adaptadas)", { skip: PULAR }, () => {
  const cedo = () => ({ disponivelEm: new Date(Date.now() - 60_000), expiraEm: new Date(Date.now() + 3600_000) });

  test("aviso tardio D-1 (094): cria a 1ª mensagem com o responsável e o snapshot; inativo -> DESTINATARIO_INELEGIVEL; sem responsável -> SEM_DESTINATARIO", async (t) => {
    if (pulaSePreciso(t)) return;
    const alerta = await novoAlerta(GRUPO, unGrupo[0], D1);
    await supabase.from("comunicacao_contatos_empresa").update({ ativo: false }).eq("id", ceGrupo.contatoEmpresaId);
    try {
      assert.equal((await filaRepo.agendarAvisoTardioD1({ alertaId: alerta.id, conteudo: "tardio", ...cedo() })).acao, "DESTINATARIO_INELEGIVEL");
    } finally { await supabase.from("comunicacao_contatos_empresa").update({ ativo: true }).eq("id", ceGrupo.contatoEmpresaId); }
    const r = await filaRepo.agendarAvisoTardioD1({ alertaId: alerta.id, conteudo: "tardio", ...cedo() });
    assert.equal(r.acao, "CRIADA", JSON.stringify(r));
    const [m] = await msgs(GRUPO);
    assert.equal(m.telefone_snapshot, foneGrupo);
    assert.equal(m.contato_nome_snapshot, "Jailton Matos");
    assert.equal(m.contato_empresa_id, ceGrupo.contatoEmpresaId);
    assert.equal(m.metadados?.origem, "prazo_final_d1");
    // empresa habilitada mas SEM responsável apontado (perfil com acesso não conta): SEM_DESTINATARIO
    const cwOutra = (await ce(ceOutra.contatoEmpresaId)).contato_whatsapp_id;
    const sem = await supabase.from("comunicacao_habilitacoes").update({ habilitado: false, destinatario_contato_id: null, destinatario_contato_empresa_id: null }).eq("organizacao_id", OUTRA);
    assert.equal(sem.error, null, sem.error?.message);
    try {
      const aB = await novoAlerta(OUTRA, unOutra, D1);
      assert.equal((await filaRepo.agendarAvisoTardioD1({ alertaId: aB.id, conteudo: "x", ...cedo() })).acao, "NAO_HABILITADA", "empresa sem responsável não pode estar habilitada (constraint habilitado_exige_destinatario)");
    } finally {
      await supabase.from("comunicacao_habilitacoes").update({ destinatario_contato_id: cwOutra, destinatario_contato_empresa_id: ceOutra.contatoEmpresaId, habilitado: true }).eq("organizacao_id", OUTRA);
    }
  });

  test("reforço (092): só depois da 1ª mensagem enviada; usa o responsável da empresa e grava snapshot; responsável inativo -> DESTINATARIO_INELEGIVEL", async (t) => {
    if (pulaSePreciso(t)) return;
    const alerta = await novoAlerta(GRUPO, unGrupo[0], D1);
    assert.equal((await rpc(alerta)).acao, "CRIADA");
    const [primeira] = await msgs(GRUPO);
    assert.equal((await filaRepo.agendarReforcoDoAlerta({ alertaId: alerta.id, conteudo: "reforço", ...cedo() })).acao, "ALERTA_SEM_PRIMEIRO_ENVIO");
    await supabase.from("comunicacao_mensagens").update({ status: "SENT", enviado_em: new Date().toISOString() }).eq("id", primeira.id);
    await supabase.from("comunicacao_contatos_empresa").update({ ativo: false }).eq("id", ceGrupo.contatoEmpresaId);
    try {
      assert.equal((await filaRepo.agendarReforcoDoAlerta({ alertaId: alerta.id, conteudo: "reforço", ...cedo() })).acao, "DESTINATARIO_INELEGIVEL");
    } finally { await supabase.from("comunicacao_contatos_empresa").update({ ativo: true }).eq("id", ceGrupo.contatoEmpresaId); }
    const r = await filaRepo.agendarReforcoDoAlerta({ alertaId: alerta.id, conteudo: "reforço", ...cedo() });
    assert.equal(r.acao, "CRIADA", JSON.stringify(r));
    const reforco = (await msgs(GRUPO)).find((m) => m.metadados?.proposito === "reforco");
    assert.equal(reforco.telefone_snapshot, foneGrupo);
    assert.equal(reforco.contato_empresa_id, ceGrupo.contatoEmpresaId);
    assert.equal(reforco.empresa_nome_snapshot, `TESTE ${tag} Grupo Jailton e Vanessa`);
  });

  test("habilitação atômica do piloto (093): exige o responsável da empresa ATIVO e VALIDADO; perfil com acesso não basta", async (t) => {
    if (pulaSePreciso(t)) return;
    const habilitadasAntes = (await supabase.from("comunicacao_habilitacoes").select("organizacao_id").eq("habilitado", true)).data.map((h) => h.organizacao_id);
    const modoAntes = await modoAtual();
    const emp = await criarOrganizacao(`TESTE ${tag} Piloto`);
    const hab = (org) => supabase.rpc("comunicacao_habilitar_organizacao_piloto", { p_organizacao_id: org, p_ator_perfil_id: null });
    try {
      // o RPC exige: modo DISABLED e nenhuma outra habilitada (as de teste ficam desabilitadas só durante este teste e são restauradas)
      await definirModo(MODOS.DISABLED, {});
      if (habilitadasAntes.length) await supabase.from("comunicacao_habilitacoes").update({ habilitado: false }).in("organizacao_id", habilitadasAntes);
      const r1 = await svc.salvarResponsavel({ organizacaoId: emp, nome: "Resp Piloto", telefoneE164: fone(13) }, AUTOR);
      await svc.atualizarConfiguracao({ organizacaoId: emp, timezone: TZ, tiposPermitidos: [TIPO] }, AUTOR);
      assert.equal((await hab(emp)).data.acao, "DESTINATARIO_INELEGIVEL", "WhatsApp ainda não validado");
      await svc.validarResponsavel({ organizacaoId: emp, contatoEmpresaId: r1.contatoEmpresaId, confirmacaoExplicita: true }, AUTOR);
      await svc.definirAtivoResponsavel({ organizacaoId: emp, contatoEmpresaId: r1.contatoEmpresaId, ativo: false }, AUTOR);
      assert.equal((await hab(emp)).data.acao, "DESTINATARIO_INELEGIVEL", "responsável inativo");
      await svc.definirAtivoResponsavel({ organizacaoId: emp, contatoEmpresaId: r1.contatoEmpresaId, ativo: true }, AUTOR);
      // o Jailton (perfil com acesso) NÃO habilita uma empresa sem responsável: MOGI não tem responsável
      const semResp = (await hab(MOGI)).data.acao;
      assert.ok(["SEM_CONFIGURACAO", "SEM_DESTINATARIO"].includes(semResp), semResp);
      assert.equal((await hab(emp)).data.acao, "HABILITADA");
    } finally {
      await supabase.from("comunicacao_habilitacoes").update({ habilitado: false }).eq("organizacao_id", emp);
      if (habilitadasAntes.length) await supabase.from("comunicacao_habilitacoes").update({ habilitado: true }).in("organizacao_id", habilitadasAntes);
      await definirModo(modoAntes, {});
      await apagarOrganizacao(emp);
    }
  });
});
