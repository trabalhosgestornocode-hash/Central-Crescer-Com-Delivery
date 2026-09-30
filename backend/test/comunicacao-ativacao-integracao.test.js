// Habilitação da EMPRESA e ENVIO AUTOMÁTICO (fim do piloto, migration 104) — INTEGRAÇÃO contra o Supabase de TESTE:
// as RPCs atômicas comunicacao_habilitar_organizacao / comunicacao_definir_envio_automatico (gates + lock) e os services do Painel
// (habilitar/desabilitar/ligar/desligar) com AUDITORIA REAL de ator humano.
// Regras provadas: várias empresas podem estar habilitadas ao mesmo tempo (sem "1 empresa"); habilitar NÃO liga o envio automático; ligar exige empresa
// habilitada + destinatário elegível; desabilitar a empresa desliga o automático; modo global NÃO é pré-requisito (o kill switch é o modo, não a habilitação).
// PULA (não falha) sem credencial de banco descartável / sem a migration 104.
// Rodar: node --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-ativacao-integracao.test.js
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, criarDestinatario, apagarDestinatario, habilitarOrganizacao,
  migracao082Aplicada, migracao088Aplicada, migracao104Aplicada,
} from "./helpers/comunicacao-fixtures.js";
import { definirHabilitacao } from "../src/modules/administrativo/administrativo.comunicacao.service.js";
import { definirEnvioAutomatico } from "../src/modules/administrativo/administrativo.comunicacao.empresa.js";
import { definirModo, modoAtual } from "../src/modules/comunicacao/comunicacao.config.js";
import { MODOS } from "../src/modules/comunicacao/comunicacao.constants.js";
import { ACOES } from "../src/shared/auditoria.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
const tag = `comativ${Date.now()}`;
let migracaoOk = true;
let modoOriginal = null;
let orgA = null, orgB = null, destA = null, destB = null;
let telefoneA = null;

const hab = (org) => supabase.rpc("comunicacao_habilitar_organizacao", { p_organizacao_id: org, p_ator_perfil_id: null });
const auto = (org, ligar) => supabase.rpc("comunicacao_definir_envio_automatico", { p_organizacao_id: org, p_ligar: ligar, p_ator_perfil_id: null });
const estado = async (org) => (await supabase.from("comunicacao_habilitacoes").select("habilitado, envio_automatico").eq("organizacao_id", org).single()).data;
const habilitada = async (org) => (await estado(org)).habilitado;

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada()) && (await migracao104Aplicada());
  if (!migracaoOk) return;
  modoOriginal = await modoAtual();
  orgA = await criarOrganizacao("TESTE ativacao A — descartável");
  orgB = await criarOrganizacao("TESTE ativacao B — descartável");
  const uA = await criarUnidade(orgA, "Unidade A"), uB = await criarUnidade(orgB, "Unidade B");
  destA = await criarDestinatario({ organizacaoId: orgA, unidadeId: uA, tag, sufixo: "a" });
  destB = await criarDestinatario({ organizacaoId: orgB, unidadeId: uB, tag, sufixo: "b" });
  telefoneA = (await supabase.from("contatos_whatsapp").select("telefone_e164").eq("id", destA.contatoId).single()).data.telefone_e164;
});

after(async () => {
  if (modoOriginal) await definirModo(modoOriginal, {}).catch(() => {});
  await apagarOrganizacao(orgA); await apagarOrganizacao(orgB);
  await apagarDestinatario(destA); await apagarDestinatario(destB);
});

beforeEach(async () => {
  if (PULAR_INTEGRACAO || !migracaoOk) return;
  await definirModo(MODOS.DISABLED, {});
  await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).in("id", [destA.contatoId, destB.contatoId]);
  await habilitarOrganizacao(orgA, destA, { habilitado: false });
  await habilitarOrganizacao(orgB, destB, { habilitado: false });
});

const sk = (t) => t.skip(PULAR_INTEGRACAO || "migration 104 ainda não aplicada — pulando.");

describe("RPC comunicacao_habilitar_organizacao (104)", { skip: PULAR_INTEGRACAO }, () => {
  test("tudo válido -> HABILITADA; de novo -> JA_HABILITADA (idempotente); o envio automático continua DESLIGADO", async (t) => {
    if (!migracaoOk) return sk(t);
    assert.equal((await hab(orgA)).data.acao, "HABILITADA");
    assert.deepEqual(await estado(orgA), { habilitado: true, envio_automatico: false });
    assert.equal((await hab(orgA)).data.acao, "JA_HABILITADA");
  });

  test("o modo global NÃO é pré-requisito (104): com modo NORMAL a empresa também é habilitada", async (t) => {
    if (!migracaoOk) return sk(t);
    await definirModo(MODOS.NORMAL, {});
    assert.equal((await hab(orgA)).data.acao, "HABILITADA");
    await definirModo(MODOS.DISABLED, {});
  });

  test("VÁRIAS empresas podem estar habilitadas ao mesmo tempo (acabou o 'piloto = 1 empresa')", async (t) => {
    if (!migracaoOk) return sk(t);
    assert.equal((await hab(orgA)).data.acao, "HABILITADA");
    assert.equal((await hab(orgB)).data.acao, "HABILITADA");
    assert.equal(await habilitada(orgB), true);
  });

  test("organização sem linha de configuração -> SEM_CONFIGURACAO", async (t) => {
    if (!migracaoOk) return sk(t);
    const org = await criarOrganizacao("TESTE ativacao sem config — descartável");
    try { assert.equal((await hab(org)).data.acao, "SEM_CONFIGURACAO"); } finally { await apagarOrganizacao(org); }
  });

  test("destinatário sem consentimento / não verificado / com opt-out -> DESTINATARIO_INELEGIVEL", async (t) => {
    if (!migracaoOk) return sk(t);
    for (const campos of [{ consentimento: false }, { verificado: false }, { opt_out: true }]) {
      await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false, ...campos }).eq("id", destA.contatoId);
      assert.equal((await hab(orgA)).data.acao, "DESTINATARIO_INELEGIVEL", JSON.stringify(campos));
      assert.equal(await habilitada(orgA), false);
    }
  });

  test("empresa SEM nenhum destinatário -> SEM_DESTINATARIO; sem a categoria habilitada -> DESTINATARIO_INELEGIVEL", async (t) => {
    if (!migracaoOk) return sk(t);
    await supabase.from("comunicacao_destinatario_categorias").update({ habilitado: false }).eq("contato_empresa_id", destA.contatoEmpresaId);
    assert.equal((await hab(orgA)).data.acao, "DESTINATARIO_INELEGIVEL");
    await supabase.from("comunicacao_habilitacoes").update({ destinatario_contato_id: null, destinatario_contato_empresa_id: null, destinatario_perfil_id: null }).eq("organizacao_id", orgA); // solta o ponteiro legado (FK)
    await supabase.from("comunicacao_contatos_empresa").delete().eq("organizacao_id", orgA);
    assert.equal((await hab(orgA)).data.acao, "SEM_DESTINATARIO");
    assert.equal(await habilitada(orgA), false);
  });

  test("timezone / tipo ausentes -> recusa específica", async (t) => {
    if (!migracaoOk) return sk(t);
    await supabase.from("comunicacao_habilitacoes").update({ tipos_permitidos: [] }).eq("organizacao_id", orgA);
    assert.equal((await hab(orgA)).data.acao, "TIPO_AUSENTE");
    await supabase.from("comunicacao_habilitacoes").update({ tipos_permitidos: ["dashboard_ifood_d1"], timezone: null }).eq("organizacao_id", orgA);
    assert.equal((await hab(orgA)).data.acao, "TIMEZONE_AUSENTE");
  });

  test("CONCORRÊNCIA: 2 organizações x 5 chamadas simultâneas -> cada uma habilitada UMA vez (1 HABILITADA + 4 JA_HABILITADA por empresa)", async (t) => {
    if (!migracaoOk) return sk(t);
    const rs = await Promise.all([...Array(5).fill(orgA), ...Array(5).fill(orgB)].map((o) => hab(o)));
    const acoes = rs.map((r) => r.data?.acao ?? r.error?.message);
    assert.equal(acoes.filter((a) => a === "HABILITADA").length, 2, JSON.stringify(acoes));
    assert.equal(acoes.filter((a) => a === "JA_HABILITADA").length, 8, JSON.stringify(acoes));
  });

  test("EXECUTE só para service_role (anon/authenticated não chamam nenhuma das RPCs)", async (t) => {
    if (!migracaoOk) return sk(t);
    const anon = await import("@supabase/supabase-js").then(({ createClient }) => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } }));
    for (const [nome, args] of [
      ["comunicacao_habilitar_organizacao", { p_organizacao_id: orgA, p_ator_perfil_id: null }],
      ["comunicacao_habilitar_organizacao_piloto", { p_organizacao_id: orgA, p_ator_perfil_id: null }],
      ["comunicacao_definir_envio_automatico", { p_organizacao_id: orgA, p_ligar: true, p_ator_perfil_id: null }],
      ["comunicacao_agendar_mensagens_alerta", { p_alerta_id: "00000000-0000-0000-0000-000000000000", p_proposito: "inicial", p_origem: null, p_itens: [{}], p_max_tentativas: 1 }],
      ["comunicacao_resolver_destinatarios", { p_organizacao_id: orgA, p_tipo_alerta: "dashboard_ifood_d1" }],
    ]) {
      const r = await anon.rpc(nome, args);
      assert.ok(r.error, `${nome}: anon não pode executar`);
    }
    assert.equal(await habilitada(orgA), false);
  });
});

describe("RPC comunicacao_definir_envio_automatico (104) — opt-in explícito", { skip: PULAR_INTEGRACAO }, () => {
  test("ligar exige a empresa HABILITADA; ligar/desligar são idempotentes; desligar é sempre permitido", async (t) => {
    if (!migracaoOk) return sk(t);
    assert.equal((await auto(orgA, true)).data.acao, "EMPRESA_NAO_HABILITADA");
    assert.equal((await auto(orgA, false)).data.acao, "JA_DESLIGADO");
    await hab(orgA);
    assert.equal((await auto(orgA, true)).data.acao, "LIGADO");
    assert.equal((await auto(orgA, true)).data.acao, "JA_LIGADO");
    assert.deepEqual(await estado(orgA), { habilitado: true, envio_automatico: true });
    assert.equal((await auto(orgA, false)).data.acao, "DESLIGADO");
  });

  test("ligar exige ao menos um destinatário ELEGÍVEL (SEM_DESTINATARIO_ELEGIVEL); a empresa sem configuração -> SEM_CONFIGURACAO", async (t) => {
    if (!migracaoOk) return sk(t);
    await hab(orgA);
    await supabase.from("contatos_whatsapp").update({ opt_out: true }).eq("id", destA.contatoId);
    assert.equal((await auto(orgA, true)).data.acao, "SEM_DESTINATARIO_ELEGIVEL");
    assert.equal((await estado(orgA)).envio_automatico, false);
    const org = await criarOrganizacao("TESTE ativacao auto sem config — descartável");
    try { assert.equal((await auto(org, true)).data.acao, "SEM_CONFIGURACAO"); } finally { await apagarOrganizacao(org); }
  });

  test("constraint do banco: envio_automatico=true numa empresa NÃO habilitada é impossível", async (t) => {
    if (!migracaoOk) return sk(t);
    const r = await supabase.from("comunicacao_habilitacoes").update({ envio_automatico: true }).eq("organizacao_id", orgA);
    assert.ok(r.error, "aceitou envio automático numa empresa desabilitada");
    assert.equal((await estado(orgA)).envio_automatico, false);
  });
});

describe("services do Painel (habilitar/desabilitar/envio automático) com auditoria REAL de ator humano", { skip: PULAR_INTEGRACAO }, () => {
  const autor = () => ({ contaId: destA.contaId, perfilId: destA.perfilId, nome: "Operador Teste", email: "operador@teste.local" });
  const auditoria = async (acao, org) => (await supabase.from("plataforma_auditoria").select("*").eq("acao", acao).eq("organizacao_id", org).order("created_at", { ascending: false })).data ?? [];

  test("habilitar -> habilitado=true (envio automático NÃO) e auditoria COMUNICACAO_ORGANIZACAO_HABILITADA com o ATOR humano; sem telefone", async (t) => {
    if (!migracaoOk) return sk(t);
    const r = await definirHabilitacao({ organizacaoId: orgA, habilitado: true, confirmacaoExplicita: true }, autor(), {});
    assert.deepEqual(r, { organizacaoId: orgA, habilitado: true, alterou: true });
    assert.deepEqual(await estado(orgA), { habilitado: true, envio_automatico: false });
    const [linha] = await auditoria(ACOES.COMUNICACAO_ORGANIZACAO_HABILITADA, orgA);
    assert.ok(linha, "auditoria gravada");
    assert.equal(linha.ator_id, destA.contaId);
    assert.equal(linha.ator_email, "operador@teste.local");
    assert.equal(linha.perfil_id, destA.perfilId);
    assert.equal(linha.detalhes.para, true);
    assert.equal(linha.detalhes.envio_automatico, false);
    assert.doesNotMatch(JSON.stringify(linha), new RegExp(telefoneA.replace("+", "\\+")));
  });

  test("habilitar sem confirmação explícita -> 400; empresa sem destinatário -> 409 SEM_DESTINATARIO; sem variável de piloto NADA muda", async (t) => {
    if (!migracaoOk) return sk(t);
    await assert.rejects(() => definirHabilitacao({ organizacaoId: orgA, habilitado: true }, autor(), {}), (e) => e.statusCode === 400 && e.details?.codigo === "CONFIRMACAO_OBRIGATORIA");
    await supabase.from("comunicacao_habilitacoes").update({ destinatario_contato_id: null, destinatario_contato_empresa_id: null, destinatario_perfil_id: null }).eq("organizacao_id", orgA); // solta o ponteiro legado (FK)
    await supabase.from("comunicacao_contatos_empresa").delete().eq("organizacao_id", orgA);
    await assert.rejects(() => definirHabilitacao({ organizacaoId: orgA, habilitado: true, confirmacaoExplicita: true }, autor(), { env: {} }), (e) => e.statusCode === 409 && e.details?.codigo === "SEM_DESTINATARIO");
    assert.equal(await habilitada(orgA), false);
  });

  test("ligar o envio automático: exige confirmação; audita LIGADO com o ator; desligar não exige e audita DESLIGADO", async (t) => {
    if (!migracaoOk) return sk(t);
    await definirHabilitacao({ organizacaoId: orgA, habilitado: true, confirmacaoExplicita: true }, autor(), {});
    await assert.rejects(() => definirEnvioAutomatico({ organizacaoId: orgA, ligar: true }, autor(), {}), (e) => e.statusCode === 400 && e.details?.codigo === "CONFIRMACAO_OBRIGATORIA");
    assert.equal((await estado(orgA)).envio_automatico, false);
    const r = await definirEnvioAutomatico({ organizacaoId: orgA, ligar: true, confirmacaoExplicita: true }, autor(), {});
    assert.deepEqual(r, { organizacaoId: orgA, envioAutomatico: true, alterou: true });
    const [lig] = await auditoria(ACOES.COMUNICACAO_ENVIO_AUTOMATICO_LIGADO, orgA);
    assert.equal(lig.ator_id, destA.contaId);
    const off = await definirEnvioAutomatico({ organizacaoId: orgA, ligar: false }, autor(), {});
    assert.equal(off.alterou, true);
    assert.ok((await auditoria(ACOES.COMUNICACAO_ENVIO_AUTOMATICO_DESLIGADO, orgA)).length >= 1);
    // empresa inexistente: 404 (nunca cria nada em outra empresa)
    await assert.rejects(() => definirEnvioAutomatico({ organizacaoId: "00000000-0000-4000-8000-00000000abcd", ligar: false }, autor(), {}), (e) => e.statusCode === 404);
  });

  test("ligar sem habilitar -> 409 EMPRESA_NAO_HABILITADA; a empresa B nunca é afetada pela A", async (t) => {
    if (!migracaoOk) return sk(t);
    await assert.rejects(() => definirEnvioAutomatico({ organizacaoId: orgA, ligar: true, confirmacaoExplicita: true }, autor(), {}), (e) => e.statusCode === 409 && e.details?.codigo === "EMPRESA_NAO_HABILITADA");
    await definirHabilitacao({ organizacaoId: orgA, habilitado: true, confirmacaoExplicita: true }, autor(), {});
    await definirEnvioAutomatico({ organizacaoId: orgA, ligar: true, confirmacaoExplicita: true }, autor(), {});
    assert.deepEqual(await estado(orgB), { habilitado: false, envio_automatico: false }, "a config da empresa A vazou para a B");
  });

  test("desabilitar -> habilitado=false E envio_automatico=false, SEM gates, com auditoria (DESABILITADA + envio automático DESLIGADO)", async (t) => {
    if (!migracaoOk) return sk(t);
    await definirHabilitacao({ organizacaoId: orgA, habilitado: true, confirmacaoExplicita: true }, autor(), {});
    await definirEnvioAutomatico({ organizacaoId: orgA, ligar: true, confirmacaoExplicita: true }, autor(), {});
    const antesDesligado = (await auditoria(ACOES.COMUNICACAO_ENVIO_AUTOMATICO_DESLIGADO, orgA)).length;
    const r = await definirHabilitacao({ organizacaoId: orgA, habilitado: false }, autor(), { env: {} });
    assert.deepEqual(r, { organizacaoId: orgA, habilitado: false, alterou: true });
    assert.deepEqual(await estado(orgA), { habilitado: false, envio_automatico: false });
    const [linha] = await auditoria(ACOES.COMUNICACAO_ORGANIZACAO_DESABILITADA, orgA);
    assert.ok(linha);
    assert.equal(linha.ator_id, destA.contaId);
    assert.equal((await auditoria(ACOES.COMUNICACAO_ENVIO_AUTOMATICO_DESLIGADO, orgA)).length, antesDesligado + 1, "desligar a empresa desliga (e audita) o envio automático");
  });
});
