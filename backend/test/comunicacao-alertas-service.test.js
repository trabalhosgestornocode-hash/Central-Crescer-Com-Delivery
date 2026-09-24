// Integração — orquestração completa (alertas.repo + fila.repo + policy +
// FakeProvider) contra o Supabase REAL DE TESTE. Cobre dedup real (teste 4),
// cancelamento por regularização (teste 5), revalidação pós-claim (teste 6),
// isolamento entre organizações (teste 16), a prova de que nada chega ao
// provider sem passar pelo Policy Engine (teste 18) e — D.3 — fencing entre
// workers, resultado INCERTO sem retry, consentimento/empresa/modo
// fail-closed e bloqueio permanente × transitório.
// Rodar: node --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-alertas-service.test.js
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, criarContaComPerfil, apagarConta,
  vincularUsuarioUnidade, migracao082Aplicada, habilitarOrganizacao,
} from "./helpers/comunicacao-fixtures.js";
import * as alertasRepo from "../src/modules/comunicacao/comunicacao.alertas.repo.js";
import * as filaRepo from "../src/modules/comunicacao/comunicacao.fila.repo.js";
import * as contatosRepo from "../src/modules/comunicacao/comunicacao.contatos.repo.js";
import * as tentativasRepo from "../src/modules/comunicacao/comunicacao.tentativas.repo.js";
import { processarProximoLote, processarJobReivindicado, agendarEnviosPendentes } from "../src/modules/comunicacao/comunicacao.alertas.service.js";
import { definirModo, modoAtual } from "../src/modules/comunicacao/comunicacao.config.js";
import { resolverHabilitacaoEmpresa } from "../src/modules/comunicacao/comunicacao.habilitacao.js";
import { criarWhatsAppService } from "../src/modules/comunicacao/whatsapp.service.js";
import { criarFakeProvider } from "../src/modules/comunicacao/providers/fake.provider.js";
import { MODOS, TIPOS_ALERTA, SEVERIDADE, STATUS_ALERTA, STATUS_MENSAGEM } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
let migracaoOk = true;
let modoOriginal = null;
const tag = `comalertas${Date.now()}`;

let orgA = null, orgB = null, unidadeA = null;
let contaId = null, perfilId = null, contatoId = null;

// Instantes UTC EXPLÍCITOS (nunca `new Date(y, m, d, h)`, que depende do fuso da máquina que roda o teste).
// Timezone da organização de teste: America/Fortaleza (UTC-3, sem DST).
// Quarta-feira 16/09/2026 10:00 em Fortaleza — dentro da janela comercial (seg–sex 08–18) SEMPRE.
const AGORA_UTIL = new Date("2026-09-16T13:00:00Z");
// Domingo 20/09/2026 10:00 em Fortaleza — sem expediente.
const AGORA_DOMINGO = new Date("2026-09-20T13:00:00Z");
const HABILITADA = async () => ({
  empresaHabilitada: true, tipoPermitido: true, empresaPausada: false, pausadoAte: null, pausadoMotivo: null,
  destinatarioContatoId: "contato-de-teste", destinatarioPerfilId: "perfil-de-teste",
  timezone: "America/Fortaleza", janelas: null, configHorarioValida: true, fonte: "TESTE",
});
// Limites da suíte: a camada por ORGANIZAÇÃO (padrão 3/min) não pode mascarar os cenários que enviam várias mensagens
// da mesma org; a global e a cota diária ficam nos padrões antigos. Restaurados ao valor original no fim.
const LIMITES_TESTE = { max_proativas_por_minuto: 5, max_proativas_por_minuto_por_organizacao: 1000, max_por_contato_por_dia: 3 };
let limitesOriginais = null;

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = await migracao082Aplicada();
  if (!migracaoOk) return;
  const col = await supabase.from("comunicacao_mensagens").select("claim_geracao").limit(0);
  const probe = await supabase.rpc("comunicacao_iniciar_envio", { p_id: "00000000-0000-0000-0000-000000000000", p_worker: "probe", p_claim_geracao: 1 });
  if (col.error || probe.error) { migracaoOk = false; return; } // migration 087 (claim × attempt) ausente

  modoOriginal = await modoAtual();
  limitesOriginais = (await supabase.from("comunicacao_configuracoes").select("valor").eq("chave", "limites").maybeSingle()).data?.valor ?? null;
  await supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: LIMITES_TESTE }, { onConflict: "chave" });
  orgA = await criarOrganizacao("TESTE comunicacao-alertas A — descartável");
  orgB = await criarOrganizacao("TESTE comunicacao-alertas B — descartável");
  unidadeA = await criarUnidade(orgA, "Unidade A1");

  const conta = await criarContaComPerfil(tag, "dest");
  contaId = conta.contaId; perfilId = conta.perfilId;
  await vincularUsuarioUnidade({ perfilId, organizacaoId: orgA, unidadeId: unidadeA });

  const contato = await contatosRepo.criarOuObterContato({ telefoneE164: `+551199${String(Date.now()).slice(-7)}` });
  contatoId = contato.id;
  await definirContato({ verificado: true, consentimento: true, opt_out: false });
  await contatosRepo.vincularPerfil({ contatoId, perfilOperacionalId: perfilId, principal: true });
});

after(async () => {
  if (modoOriginal) await definirModo(modoOriginal, {}).catch(() => {});
  if (limitesOriginais) await supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: limitesOriginais }, { onConflict: "chave" });
  if (contatoId) {
    await supabase.from("comunicacao_mensagens").delete().eq("contato_id", contatoId);
    await supabase.from("contatos_whatsapp").delete().eq("id", contatoId);
  }
  if (contaId) await apagarConta(contaId);
  await apagarOrganizacao(orgA);
  await apagarOrganizacao(orgB);
});

beforeEach(async () => {
  if (PULAR_INTEGRACAO || !migracaoOk) return;
  // isolamento entre testes: sem resíduo de cooldown/rate limit de um teste anterior.
  await supabase.from("comunicacao_mensagens").delete().eq("contato_id", contatoId);
  await definirContato({ verificado: true, consentimento: true, opt_out: false });
});

const definirContato = (campos) => supabase.from("contatos_whatsapp").update(campos).eq("id", contatoId);
const linha = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("id", id).single()).data;
const statusAlerta = async (id) => (await supabase.from("comunicacao_alertas").select("status").eq("id", id).single()).data.status;

async function novoAlertaDetected(organizacaoId, unidadeId, dataReferencia, overrides = {}) {
  return alertasRepo.criarOuEscalonarAlerta({
    organizacaoId, unidadeId, tipoAlerta: TIPOS_ALERTA.DASHBOARD_IFOOD_D1, dataReferencia,
    destinatarioPerfilId: null, severidade: SEVERIDADE.ATENCAO, motivo: "2 dias pendente(s)",
    ...overrides,
  });
}

/** Alerta + mensagem SCHEDULED já elegível para claim. */
async function alertaComMensagem(dataReferencia, extra = {}) {
  const { alerta } = await novoAlertaDetected(orgA, unidadeA, dataReferencia);
  const job = await filaRepo.agendarMensagem({
    alertaId: alerta.id, organizacaoId: orgA, unidadeId: unidadeA, contatoId, destinatarioPerfilId: perfilId,
    tipo: alerta.tipo_alerta, conteudo: "aviso de pendência", idempotencyKey: `wa:alerta:${alerta.id}:v1`,
    disponivelEm: new Date(Date.now() - 60_000), ...extra,
  });
  return { alerta, job };
}
async function limpar(...pares) {
  for (const { alerta, job } of pares) {
    if (job) await supabase.from("comunicacao_mensagens").delete().eq("id", job.id);
    if (alerta) await supabase.from("comunicacao_alertas").delete().eq("id", alerta.id);
  }
}

/** FakeProvider com um SPY que conta as chamadas REAIS a sendText (o fake deduplica por chave e mascararia uma chamada dupla). */
function criarProviderComSpy() {
  const provider = criarFakeProvider();
  const chamadas = [];
  const original = provider.sendText.bind(provider);
  provider.sendText = async (args) => { chamadas.push(args); return original(args); };
  return { provider, chamadas, whatsAppService: criarWhatsAppService({ provider, semGateIdentidade: true }) };
}

const lote = (whatsAppService, extra = {}) => processarProximoLote({
  limite: 20, worker: "teste", whatsAppService, agora: AGORA_UTIL,
  verificarPendenciaAindaExiste: async () => true, resolverHabilitacao: HABILITADA, ...extra,
});

describe("comunicacao — orquestração (alertas + fila + policy + provider)", { skip: PULAR_INTEGRACAO }, () => {
  test("teste 4 — a MESMA pendência processada duas vezes gera um único alerta", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    const data = "2026-09-01";
    const r1 = await novoAlertaDetected(orgA, unidadeA, data);
    const r2 = await novoAlertaDetected(orgA, unidadeA, data);
    assert.equal(r1.criado, true);
    assert.equal(r2.criado, false);
    assert.equal(r1.alerta.id, r2.alerta.id);

    const { count } = await supabase.from("comunicacao_alertas").select("id", { count: "exact", head: true })
      .eq("organizacao_id", orgA).eq("unidade_id", unidadeA).eq("data_referencia", data);
    assert.equal(count, 1);

    await supabase.from("comunicacao_alertas").delete().eq("id", r1.alerta.id);
  });

  test("escalonamento: severidade diferente na mesma chave atualiza em vez de duplicar", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    const data = "2026-09-02";
    const r1 = await novoAlertaDetected(orgA, unidadeA, data, { severidade: SEVERIDADE.ATENCAO });
    const r2 = await novoAlertaDetected(orgA, unidadeA, data, { severidade: SEVERIDADE.CRITICO });
    assert.equal(r2.escalonado, true);
    assert.equal(r2.alerta.id, r1.alerta.id);
    assert.equal(r2.alerta.severidade, SEVERIDADE.CRITICO);
    await supabase.from("comunicacao_alertas").delete().eq("id", r1.alerta.id);
  });

  test("teste 5 — pendência resolvida ANTES do processamento cancela a mensagem agendada", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    const { alerta } = await novoAlertaDetected(orgA, unidadeA, "2026-09-03");
    const job = await filaRepo.agendarMensagem({
      alertaId: alerta.id, organizacaoId: orgA, unidadeId: unidadeA, contatoId, destinatarioPerfilId: perfilId,
      tipo: alerta.tipo_alerta, conteudo: "aviso de pendência", idempotencyKey: `wa:alerta:${alerta.id}:v1`,
      disponivelEm: new Date(Date.now() + 3600_000), // ainda não é hora — como no exemplo do pedido (09:12)
    });

    // a pendência é regularizada antes de o job sequer virar elegível para claim.
    const canceladas = await filaRepo.cancelarPendentesPorAlerta(alerta.id);
    await alertasRepo.resolverAlerta(alerta.id);

    assert.equal(canceladas.length, 1);
    assert.equal((await linha(job.id)).status, STATUS_MENSAGEM.CANCELLED);
    assert.equal(await statusAlerta(alerta.id), STATUS_ALERTA.RESOLVED);
    await limpar({ alerta, job });
  });

  test("teste 6 — pendência resolvida DEPOIS do claim mas ANTES do envio é revalidada e cancela ESTA mensagem (não envia aviso obsoleto)", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-09-04");
    const { provider, chamadas, whatsAppService } = criarProviderComSpy();
    const resultados = await lote(whatsAppService, { worker: "teste-6", verificarPendenciaAindaExiste: async () => false });

    const meu = resultados.find((r) => r.id === par.job.id);
    assert.equal(meu?.resultado, "CANCELADO_PENDENCIA_RESOLVIDA");
    assert.equal(chamadas.length, 0, "não deveria ter chamado o provider — pendência já não existia");
    assert.equal(provider.mensagensEnviadas.length, 0);
    assert.equal(await statusAlerta(par.alerta.id), STATUS_ALERTA.RESOLVED);
    // (bug antigo: o cancelamento só tocava mensagens SCHEDULED, então a linha em PROCESSING
    //  ficava presa e voltava a ser reivindicada quando o lease vencia)
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.CANCELLED);
    await limpar(par);
  });

  test("teste 16 — organização A nunca lê/processa alertas da organização B", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    const { alerta: alertaA } = await novoAlertaDetected(orgA, unidadeA, "2026-09-07");
    const { alerta: alertaB } = await novoAlertaDetected(orgB, null, "2026-09-07");

    const ativosA = await alertasRepo.listarAlertasAtivos({ organizacaoId: orgA, tipoAlerta: TIPOS_ALERTA.DASHBOARD_IFOOD_D1 });
    assert.ok(ativosA.some((a) => a.id === alertaA.id));
    assert.ok(!ativosA.some((a) => a.id === alertaB.id), "vazou um alerta da organização B para a consulta escopada em A");

    const ativosB = await alertasRepo.listarAlertasAtivos({ organizacaoId: orgB, tipoAlerta: TIPOS_ALERTA.DASHBOARD_IFOOD_D1 });
    assert.ok(!ativosB.some((a) => a.id === alertaA.id), "vazou um alerta da organização A para a consulta escopada em B");

    await supabase.from("comunicacao_alertas").delete().in("id", [alertaA.id, alertaB.id]);
  });
});

describe("D.3-C — modo fail-closed (portão antes do claim)", { skip: PULAR_INTEGRACAO }, () => {
  test("teste 18a — DISABLED: NADA é reivindicado, a mensagem fica SCHEDULED intacta e o provider nunca é chamado", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.DISABLED, {});
    assert.equal(await modoAtual(), MODOS.DISABLED, "definirModo(DISABLED) precisa REALMENTE desligar (bug: gravava aspas embutidas)");
    const par = await alertaComMensagem("2026-09-05");
    const { chamadas, whatsAppService } = criarProviderComSpy();

    const resultados = await lote(whatsAppService, { worker: "teste-18a" });
    assert.deepEqual(resultados, [], "em DISABLED o worker não processa nada");
    assert.equal(chamadas.length, 0);
    const msg = await linha(par.job.id);
    assert.equal(msg.status, STATUS_MENSAGEM.SCHEDULED, "a mensagem NÃO pode ser reivindicada, bloqueada nem perdida");
    assert.equal(msg.tentativas, 0, "e nem consumir tentativa");

    await definirModo(MODOS.NORMAL, {});
    await limpar(par);
  });

  test("REACTIVE_ONLY também não processa proativos", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.REACTIVE_ONLY, {});
    const par = await alertaComMensagem("2026-09-08");
    const { chamadas, whatsAppService } = criarProviderComSpy();
    assert.deepEqual(await lote(whatsAppService), []);
    assert.equal(chamadas.length, 0);
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.SCHEDULED);
    await definirModo(MODOS.NORMAL, {});
    await limpar(par);
  });

  test("regressão do JSON duplo: definirModo grava o jsonb string CRU (sem aspas embutidas)", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    for (const m of Object.values(MODOS)) {
      await definirModo(m, {});
      const { data } = await supabase.from("comunicacao_configuracoes").select("valor").eq("chave", "modo").single();
      assert.equal(data.valor, m, `valor bruto de ${m} = ${JSON.stringify(data.valor)}`);
      assert.equal(await modoAtual(), m);
    }
    await definirModo(MODOS.NORMAL, {});
  });

  test("valor de `modo` corrompido no banco (aspas embutidas, desconhecido, número, null) -> modoAtual()=DISABLED e NADA é processado", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    const par = await alertaComMensagem("2026-09-09");
    const { chamadas, whatsAppService } = criarProviderComSpy();
    for (const corrompido of ['"NORMAL"', "ACTIVE", "normal", "", 1, true, ["NORMAL"], { modo: "NORMAL" }]) {
      const w = await supabase.from("comunicacao_configuracoes").update({ valor: corrompido }).eq("chave", "modo");
      assert.equal(w.error, null, `falha ao gravar o valor corrompido ${JSON.stringify(corrompido)}`);
      assert.equal(await modoAtual(), MODOS.DISABLED, `valor ${JSON.stringify(corrompido)}`);
      assert.deepEqual(await lote(whatsAppService), [], `valor ${JSON.stringify(corrompido)}`);
    }
    assert.equal(chamadas.length, 0);
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.SCHEDULED);
    await definirModo(MODOS.NORMAL, {});
    await limpar(par);
  });

  test("teste 18b — caminho feliz: aprovado (modo NORMAL + consentimento + verificado + empresa habilitada), o provider RECEBE exatamente 1 chamada", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-09-06");
    const { provider, chamadas, whatsAppService } = criarProviderComSpy();

    const resultados = await lote(whatsAppService, { worker: "teste-18b" });
    const meu = resultados.find((r) => r.id === par.job.id);
    assert.equal(meu?.resultado, "ENVIADO");
    assert.equal(meu?.registrado, true);
    assert.equal(chamadas.length, 1);
    assert.equal(provider.mensagensEnviadas[0].telefoneE164, (await contatosRepo.obterContato(contatoId)).telefone_e164);
    const msg = await linha(par.job.id);
    assert.equal(msg.status, STATUS_MENSAGEM.SENT);
    assert.ok(msg.provider_message_id);
    assert.equal(await statusAlerta(par.alerta.id), STATUS_ALERTA.SENT);
    await limpar(par);
  });
});

describe("D.3-C — consentimento e habilitação fail-closed (nenhum destes envia)", { skip: PULAR_INTEGRACAO }, () => {
  async function esperarBloqueio(par, motivo, opcoes = {}) {
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const resultados = await lote(whatsAppService, opcoes);
    const meu = resultados.find((r) => r.id === par.job.id);
    assert.equal(meu?.resultado, "BLOQUEADO", JSON.stringify(meu));
    assert.equal(meu?.motivo, motivo);
    assert.equal(chamadas.length, 0, `${motivo}: o provider foi chamado`);
    const msg = await linha(par.job.id);
    assert.equal(msg.status, STATUS_MENSAGEM.BLOCKED, "decisão sobre o destinatário/empresa é PERMANENTE");
    assert.equal(msg.erro, motivo);
    assert.equal(await statusAlerta(par.alerta.id), STATUS_ALERTA.BLOCKED);
  }

  test("consentimento=false -> BLOQUEADO NO_CONSENT (BLOCKED terminal)", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    await definirContato({ consentimento: false });
    const par = await alertaComMensagem("2026-09-10");
    await esperarBloqueio(par, "NO_CONSENT");
    await limpar(par);
  });

  test("opt_out=true (mesmo com consentimento=true) -> BLOQUEADO OPT_OUT", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    await definirContato({ opt_out: true, consentimento: true });
    const par = await alertaComMensagem("2026-09-11");
    await esperarBloqueio(par, "OPT_OUT");
    await limpar(par);
  });

  test("telefone não verificado -> BLOQUEADO PHONE_NOT_VERIFIED", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    await definirContato({ verificado: false });
    const par = await alertaComMensagem("2026-09-12");
    await esperarBloqueio(par, "PHONE_NOT_VERIFIED");
    await limpar(par);
  });

  test("PADRÃO DE PRODUÇÃO: sem estrutura de habilitação, NENHUMA empresa está habilitada -> EMPRESA_DESABILITADA (mesmo com tudo o mais ok)", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-09-13");
    // sem injetar `resolverHabilitacao`: usa o padrão real (fechado).
    await esperarBloqueio(par, "EMPRESA_DESABILITADA", { resolverHabilitacao: resolverHabilitacaoEmpresa });
    await limpar(par);
  });

  test("empresa habilitada mas tipo de alerta NÃO permitido -> BLOQUEADO TIPO_NAO_PERMITIDO", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-09-14");
    await esperarBloqueio(par, "TIPO_NAO_PERMITIDO", { resolverHabilitacao: async () => ({ empresaHabilitada: true, tipoPermitido: false }) });
    await limpar(par);
  });

  test("resolvedor de habilitação que devolve lixo/undefined/lança -> nunca libera (bloqueia ou erro interno, sem envio)", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-09-15");
    const { chamadas, whatsAppService } = criarProviderComSpy();
    for (const resolver of [async () => undefined, async () => ({}), async () => ({ empresaHabilitada: "true", tipoPermitido: 1 }), async () => { throw new Error("boom"); }]) {
      await lote(whatsAppService, { resolverHabilitacao: resolver });
    }
    assert.equal(chamadas.length, 0);
    await limpar(par);
  });

});

describe("D.3 — bloqueio TRANSITÓRIO adia (não vira BLOCKED terminal)", { skip: PULAR_INTEGRACAO }, () => {
  async function esperarAdiado(par, motivo, opcoes = {}, provider) {
    const { chamadas, whatsAppService } = provider ?? criarProviderComSpy();
    const resultados = await lote(whatsAppService, opcoes);
    const meu = resultados.find((r) => r.id === par.job.id);
    assert.equal(meu?.resultado, "ADIADO", JSON.stringify(meu));
    assert.equal(meu?.motivo, motivo);
    assert.equal(chamadas.length, 0);
    const msg = await linha(par.job.id);
    assert.equal(msg.status, STATUS_MENSAGEM.SCHEDULED, "adiada, NÃO bloqueada");
    assert.ok(new Date(msg.disponivel_em).getTime() > Date.now() + 30_000, "disponivel_em no futuro");
    assert.notEqual(await statusAlerta(par.alerta.id), STATUS_ALERTA.BLOCKED);
    return msg;
  }

  test("fora da janela (domingo) -> ADIADO OUTSIDE_ALLOWED_WINDOW", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-09-16");
    await esperarAdiado(par, "OUTSIDE_ALLOWED_WINDOW", { agora: AGORA_DOMINGO });
    await limpar(par);
  });

  test("Gateway offline (getStatus.conectado=false) -> ADIADO PROVIDER_OFFLINE; e getStatus que LANÇA também vira offline (não erro do job)", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-09-17");
    const p1 = criarProviderComSpy();
    p1.provider.definirConectado(false);
    await esperarAdiado(par, "PROVIDER_OFFLINE", {}, p1);

    await supabase.from("comunicacao_mensagens").update({ disponivel_em: new Date(Date.now() - 1000).toISOString() }).eq("id", par.job.id);
    const p2 = criarProviderComSpy();
    p2.provider.getStatus = async () => { throw new Error("gateway fora do ar"); };
    await esperarAdiado(par, "PROVIDER_OFFLINE", {}, p2);
    await limpar(par);
  });

  test("CONNECTED sozinho NÃO basta: conta não confirmada (gate false, sem gate ou gate que lança) -> ADIADO IDENTIDADE_NAO_CONFIRMADA, provider = 0, sem consumir tentativa", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-09-18");
    for (const gate of [async () => false, null, async () => { throw new Error("banco fora"); }]) {
      const provider = criarFakeProvider(); const chamadas = [];
      provider.sendText = async (a) => { chamadas.push(a); return { providerMessageId: "X" }; };
      const whatsAppService = criarWhatsAppService({ provider, identidadeConfirmada: gate });
      const msg = await esperarAdiado(par, "IDENTIDADE_NAO_CONFIRMADA", {}, { chamadas, whatsAppService });
      assert.equal(msg.tentativas, 0, "adiar não consome tentativa");
      await supabase.from("comunicacao_mensagens").update({ disponivel_em: new Date(Date.now() - 1000).toISOString() }).eq("id", par.job.id);
    }
    // com a conta CONFIRMADA o mesmo job segue e o provider é chamado UMA vez
    const provider = criarFakeProvider(); const chamadas = [];
    const original = provider.sendText.bind(provider);
    provider.sendText = async (a) => { chamadas.push(a); return original(a); };
    const resultados = await lote(criarWhatsAppService({ provider, identidadeConfirmada: async () => true }));
    assert.equal(resultados.find((r) => r.id === par.job.id)?.resultado, "ENVIADO");
    assert.equal(chamadas.length, 1);
    await limpar(par);
  });

  test("cooldown: um envio recente SENT ao mesmo contato/tipo -> ADIADO COOLDOWN", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const anterior = await alertaComMensagem("2026-09-18");
    await supabase.from("comunicacao_mensagens").update({ status: "SENT", enviado_em: new Date().toISOString() }).eq("id", anterior.job.id);
    const par = await alertaComMensagem("2026-09-19");
    await esperarAdiado(par, "COOLDOWN");
    await limpar(anterior, par);
  });

  test("DELIVERY_UNKNOWN e SENDING CONSOMEM cooldown: uma mensagem que pode já ter saído não libera outra igual", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    for (const [estado, campos] of [
      ["DELIVERY_UNKNOWN", { entrega_incerta_em: new Date().toISOString() }],
      ["SENDING", { claimed_by: "w-fora", claimed_at: new Date().toISOString(), claim_expira_em: new Date(Date.now() + 60_000).toISOString(), tentativas: 1 }],
    ]) {
      const anterior = await alertaComMensagem(`2026-10-0${estado === "SENDING" ? 2 : 1}`);
      await supabase.from("comunicacao_mensagens").update({ status: estado, ...campos }).eq("id", anterior.job.id);
      const par = await alertaComMensagem(`2026-10-1${estado === "SENDING" ? 2 : 1}`);
      await esperarAdiado(par, "COOLDOWN");
      await limpar(anterior, par);
    }
  });

  test("rate limit por contato/dia contando DELIVERY_UNKNOWN -> ADIADO RATE_LIMIT", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-10-20");
    // 3 = max_por_contato_por_dia padrão; tipos DIFERENTES para não acionar o cooldown antes
    const resid = [];
    for (let i = 0; i < 3; i++) {
      resid.push(await filaRepo.agendarMensagem({ organizacaoId: orgA, unidadeId: unidadeA, contatoId, tipo: `outro_tipo_${i}`, conteudo: "x", idempotencyKey: `rl-${Date.now()}-${i}`, disponivelEm: new Date(Date.now() + 3600_000) }));
    }
    await supabase.from("comunicacao_mensagens").update({ status: "DELIVERY_UNKNOWN", entrega_incerta_em: new Date().toISOString() }).in("id", resid.map((r) => r.id));
    await esperarAdiado(par, "RATE_LIMIT");
    await limpar(par);
  });

  test("deferimentos REPETIDOS não consomem attempt nem viram BLOCKED/FAILED — mesmo com max_tentativas=1 e sem linha em comunicacao_tentativas", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-10-21", { maxTentativas: 1 });
    const { chamadas, whatsAppService } = criarProviderComSpy();
    for (let i = 1; i <= 5; i++) {
      const resultados = await lote(whatsAppService, { agora: AGORA_DOMINGO });
      assert.equal(resultados.find((r) => r.id === par.job.id)?.resultado, "ADIADO", `rodada ${i}`);
      const l = await linha(par.job.id);
      assert.equal(l.status, STATUS_MENSAGEM.SCHEDULED, `rodada ${i}: virou ${l.status}`);
      assert.equal(l.tentativas, 0, `rodada ${i}: o deferimento consumiu attempt`);
      assert.equal(l.claim_geracao, i, "um claim novo a cada rodada");
      await supabase.from("comunicacao_mensagens").update({ disponivel_em: new Date(Date.now() - 1000).toISOString() }).eq("id", par.job.id);
    }
    assert.equal(chamadas.length, 0);
    assert.deepEqual(await tentativasRepo.listarTentativas(par.job.id), [], "nada foi tentado: não pode haver linha de tentativa");
    // e a mensagem continua enviável no primeiro horário permitido
    const r = await lote(whatsAppService, { agora: AGORA_UTIL });
    assert.equal(r.find((x) => x.id === par.job.id)?.resultado, "ENVIADO");
    assert.equal((await linha(par.job.id)).tentativas, 1);
    assert.equal(chamadas.length, 1);
    await limpar(par);
  });
});

describe("D.3-A — resultado do envio: INCERTO nunca faz retry; RETRYAVEL/PERMANENTE tratados", { skip: PULAR_INTEGRACAO }, () => {
  test("erro AMBÍGUO (sem marcação) -> DELIVERY_UNKNOWN; reprocessar NÃO reenvia (nem com o tempo, nem com lease vencido, nem com a varredura)", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-10-22");
    const { provider, chamadas, whatsAppService } = criarProviderComSpy();
    provider.falharProximoEnvio({ mensagem: "conexão caiu durante o envio" }); // sem preEnvio/permanente

    const r1 = await lote(whatsAppService);
    assert.equal(r1.find((r) => r.id === par.job.id)?.resultado, "ENTREGA_INCERTA");
    assert.equal(chamadas.length, 1);
    const msg = await linha(par.job.id);
    assert.equal(msg.status, STATUS_MENSAGEM.DELIVERY_UNKNOWN);
    assert.ok(msg.entrega_incerta_em);
    const tentativas = await tentativasRepo.listarTentativas(par.job.id);
    assert.equal(tentativas.at(-1).resultado, "DELIVERY_UNKNOWN");
    assert.equal(tentativas.at(-1).erro_classificacao, "INCERTO");

    // "restart do worker", "scheduler roda de novo", "cooldown passa", "lease expira", "varredura":
    await supabase.from("comunicacao_mensagens").update({ disponivel_em: new Date(Date.now() - 86_400_000).toISOString(), claim_expira_em: new Date(Date.now() - 86_400_000).toISOString() }).eq("id", par.job.id);
    await filaRepo.expirarEntregasIncertas({ worker: "varredura" });
    const r2 = await lote(whatsAppService);
    const r3 = await lote(whatsAppService);
    assert.equal(r2.some((r) => r.id === par.job.id), false);
    assert.equal(r3.some((r) => r.id === par.job.id), false);
    assert.equal(chamadas.length, 1, "DELIVERY_UNKNOWN foi reenviado — duplicidade");
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.DELIVERY_UNKNOWN);
    await limpar(par);
  });

  test("falha PRÉ-ENVIO comprovada (preEnvio) -> FALHOU_RETRY: volta a SCHEDULED com backoff; nada foi enviado", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-10-23");
    const { provider, whatsAppService, chamadas } = criarProviderComSpy();
    provider.falharProximoEnvio({ mensagem: "conexão recusada", preEnvio: true });
    const r = await lote(whatsAppService);
    assert.equal(r.find((x) => x.id === par.job.id)?.resultado, "FALHOU_RETRY");
    assert.equal(chamadas.length, 1);
    assert.equal(provider.mensagensEnviadas.length, 0);
    const msg = await linha(par.job.id);
    assert.equal(msg.status, STATUS_MENSAGEM.SCHEDULED);
    assert.ok(new Date(msg.disponivel_em).getTime() > Date.now() + 20_000);
    await limpar(par);
  });

  test("falha PERMANENTE -> FALHOU_DEFINITIVO: FAILED, alerta FAILED, não reivindicável", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-10-24");
    const { provider, whatsAppService } = criarProviderComSpy();
    provider.falharProximoEnvio({ mensagem: "número inválido", permanente: true, preEnvio: true });
    const r = await lote(whatsAppService);
    assert.equal(r.find((x) => x.id === par.job.id)?.resultado, "FALHOU_DEFINITIVO");
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.FAILED);
    assert.equal(await statusAlerta(par.alerta.id), STATUS_ALERTA.FAILED);
    assert.equal((await lote(whatsAppService)).some((x) => x.id === par.job.id), false);
    await limpar(par);
  });

  test("provider CONFIRMOU o envio mas o registro SENT falha no banco: NÃO reclassifica nem reenvia; fica SENDING -> varredura -> DELIVERY_UNKNOWN", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-10-25");
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const supabaseQueFalhaAoFinalizar = new Proxy(supabase, {
      get(alvo, prop) {
        if (prop === "rpc") return (nome, args) => nome === "comunicacao_finalizar_envio" ? Promise.resolve({ data: null, error: { message: "banco indisponível (simulado)" } }) : alvo.rpc(nome, args);
        const v = alvo[prop];
        return typeof v === "function" ? v.bind(alvo) : v;
      },
    });
    const r = await processarProximoLote({
      limite: 20, worker: "teste-reg", whatsAppService, agora: AGORA_UTIL,
      verificarPendenciaAindaExiste: async () => true, resolverHabilitacao: HABILITADA,
    }, { supabase: supabaseQueFalhaAoFinalizar });
    const meu = r.find((x) => x.id === par.job.id);
    assert.equal(meu?.resultado, "ENVIADO");
    assert.equal(meu?.registrado, false);
    assert.equal(chamadas.length, 1);
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.SENDING, "não pode virar SCHEDULED (retry) nem FAILED");

    await supabase.from("comunicacao_mensagens").update({ claim_expira_em: new Date(Date.now() - 5000).toISOString() }).eq("id", par.job.id);
    await filaRepo.expirarEntregasIncertas({ worker: "varredura" });
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.DELIVERY_UNKNOWN);
    await lote(whatsAppService);
    assert.equal(chamadas.length, 1, "houve segundo envio");
    await limpar(par);
  });

  test("attempts reais já esgotados NÃO é enviado -> FALHOU_TENTATIVAS_ESGOTADAS (FAILED, não BLOCKED)", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-10-26", { maxTentativas: 1 });
    // estado (defensivo): SCHEDULED com o único attempt já consumido — não deveria existir, mas nunca pode enviar
    await supabase.from("comunicacao_mensagens").update({ tentativas: 1 }).eq("id", par.job.id);
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const r = await lote(whatsAppService);
    assert.equal(r.find((x) => x.id === par.job.id)?.resultado, "FALHOU_TENTATIVAS_ESGOTADAS");
    assert.equal(chamadas.length, 0);
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.FAILED);
    await limpar(par);
  });
});

describe("D.3-B — dois workers no PIPELINE completo (a mesma mensagem nunca sai duas vezes)", { skip: PULAR_INTEGRACAO }, () => {
  const ctx = (whatsAppService) => ({
    whatsAppService, agora: AGORA_UTIL, adiamentoMs: 900_000,
    verificarPendenciaAindaExiste: async () => true, resolverHabilitacao: HABILITADA,
  });

  test("A reivindica e trava; o lease vence; B processa e ENVIA; A acorda -> POSSE_PERDIDA, provider chamado UMA vez no total", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-10-27");
    const { chamadas, whatsAppService } = criarProviderComSpy();

    // O envio de B ao mesmo contato acionaria cooldown/rate limit na política de A e A seria adiada por
    // OUTRO caminho (também fenced) — o teste só prova o CAS de `reservarEnvio` se a política de A LIBERAR.
    // Por isso o envio de B é "envelhecido" no banco (independe de diferença de relógio app x banco).
    // A reivindica (mesmo nome "manual" que B usará) e "trava" antes de processar.
    const lotesA = await filaRepo.claimJobs({ limite: 50, worker: "manual", leaseSegundos: 120 });
    const jobA = lotesA.find((j) => j.id === par.job.id);
    assert.equal(jobA.claim_geracao, 1);
    assert.equal(jobA.tentativas, 0, "o claim não cria attempt");
    await supabase.from("comunicacao_mensagens").update({ claim_expira_em: new Date(Date.now() - 5000).toISOString() }).eq("id", par.job.id);

    const rB = await lote(whatsAppService, { worker: "manual" });
    assert.equal(rB.find((r) => r.id === par.job.id)?.resultado, "ENVIADO");
    await supabase.from("comunicacao_mensagens").update({ enviado_em: new Date(Date.now() - 2 * 86_400_000).toISOString() }).eq("id", par.job.id);

    // A acorda e tenta processar o job que carrega na mão (geração 1). A política dela LIBERA;
    // só o CAS de `reservarEnvio` pode impedir o segundo envio.
    const rA = await processarJobReivindicado(jobA, ctx(whatsAppService));
    assert.equal(rA.resultado, "POSSE_PERDIDA", JSON.stringify(rA));
    assert.equal(chamadas.length, 1, "o provider foi chamado por A E por B — duplicidade");
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.SENT);
    await limpar(par);
  });

  test("A já está em SENDING (provider lento) e o lease vence: B NÃO reivindica; a varredura marca UNKNOWN; a confirmação de A vira SENT; provider chamado UMA vez", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-10-28");
    const { provider, chamadas, whatsAppService } = criarProviderComSpy();

    let liberar; const portao = new Promise((r) => { liberar = r; });
    const originalSpy = provider.sendText;
    provider.sendText = async (args) => { const r = await originalSpy(args); await portao; return r; }; // a chamada demora

    const jobA = (await filaRepo.claimJobs({ limite: 50, worker: "w-A", leaseSegundos: 120 })).find((j) => j.id === par.job.id);
    const execA = processarJobReivindicado(jobA, ctx(whatsAppService)); // A vai até o provider e fica esperando
    for (let i = 0; i < 100 && chamadas.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(chamadas.length, 1, "A não chegou ao provider");
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.SENDING);

    await supabase.from("comunicacao_mensagens").update({ claim_expira_em: new Date(Date.now() - 5000).toISOString() }).eq("id", par.job.id);
    const rB = await lote(whatsAppService, { worker: "w-B" });
    assert.equal(rB.some((r) => r.id === par.job.id), false, "B reivindicou uma mensagem em SENDING");
    await filaRepo.expirarEntregasIncertas({ worker: "varredura" });
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.DELIVERY_UNKNOWN);

    liberar(); // o provider finalmente responde: enviou
    const rA = await execA;
    assert.equal(rA.resultado, "ENVIADO");
    assert.equal(rA.registrado, true, "a confirmação tardia do MESMO token deve ser aceita");
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.SENT);
    assert.equal(chamadas.length, 1);
    assert.equal(provider.mensagensEnviadas.length, 1);
    await limpar(par);
  });

  test("dois workers competindo pelo MESMO lote (Promise.all): cada mensagem chama o provider no máximo UMA vez", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    // Um contato POR mensagem: com um contato só, a cota diária (por contato) mascararia a corrida.
    const N = 4;
    const extras = [];
    const pares = [];
    for (let i = 0; i < N; i++) {
      const c = await contatosRepo.criarOuObterContato({ telefoneE164: `+551198${String(Date.now() + i).slice(-7)}` });
      await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).eq("id", c.id);
      await contatosRepo.vincularPerfil({ contatoId: c.id, perfilOperacionalId: perfilId, principal: false });
      extras.push(c.id);
      const { alerta } = await novoAlertaDetected(orgA, unidadeA, `2026-11-0${i + 1}`);
      const job = await filaRepo.agendarMensagem({
        alertaId: alerta.id, organizacaoId: orgA, unidadeId: unidadeA, contatoId: c.id, destinatarioPerfilId: perfilId,
        // cooldown é por organização+unidade+tipo: um tipo por mensagem para o cooldown não mascarar a corrida
        tipo: `${alerta.tipo_alerta}_corrida_${i}`, conteudo: "aviso de pendência", idempotencyKey: `wa:alerta:${alerta.id}:v1`,
        disponivelEm: new Date(Date.now() - 60_000),
      });
      pares.push({ alerta, job });
    }
    const a = criarProviderComSpy();
    const b = criarProviderComSpy();
    const limites = { adiamentoMs: 900_000 };
    await supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: { max_proativas_por_minuto: 100, max_proativas_por_minuto_por_organizacao: 100, max_por_contato_por_dia: 100 } }, { onConflict: "chave" });
    try {
      await Promise.all([
        lote(a.whatsAppService, { worker: "corrida-A", limite: 50, ...limites }),
        lote(b.whatsAppService, { worker: "corrida-B", limite: 50, ...limites }),
      ]);
    } finally {
      await supabase.from("comunicacao_configuracoes").upsert({ chave: "limites", valor: LIMITES_TESTE }, { onConflict: "chave" });
    }
    const todas = [...a.chamadas, ...b.chamadas].map((c) => c.idempotencyKey);
    assert.equal(todas.length, N, `esperava ${N} envios (um por mensagem), houve ${todas.length}`);
    assert.equal(new Set(todas).size, todas.length, "a mesma idempotencyKey foi enviada por dois workers");
    await limpar(...pares);
    await supabase.from("comunicacao_mensagens").delete().in("contato_id", extras);
    await supabase.from("contatos_whatsapp").delete().in("id", extras);
  });
});

describe("D.3-R — modo, habilitação e DELIVERY_UNKNOWN (revisão final)", { skip: PULAR_INTEGRACAO }, () => {
  test("linha de `modo` AUSENTE no banco -> DISABLED (default fechado) e nada é processado", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    const par = await alertaComMensagem("2026-11-10");
    const { chamadas, whatsAppService } = criarProviderComSpy();
    await supabase.from("comunicacao_configuracoes").delete().eq("chave", "modo");
    try {
      assert.equal(await modoAtual(), MODOS.DISABLED);
      assert.deepEqual(await lote(whatsAppService), []);
    } finally {
      await supabase.from("comunicacao_configuracoes").upsert({ chave: "modo", valor: MODOS.NORMAL }, { onConflict: "chave" });
    }
    assert.equal(chamadas.length, 0);
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.SCHEDULED);
    await limpar(par);
  });

  test("modo NORMAL válido SÓ prossegue se os demais gates permitirem: consentimento, verificado, opt-out, empresa e tipo — um a um", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const casos = [
      ["consentimento=false", () => definirContato({ consentimento: false }), HABILITADA, "NO_CONSENT"],
      ["verificado=false", () => definirContato({ verificado: false }), HABILITADA, "PHONE_NOT_VERIFIED"],
      ["opt_out=true", () => definirContato({ opt_out: true }), HABILITADA, "OPT_OUT"],
      ["empresa desabilitada", async () => {}, async () => ({ empresaHabilitada: false, tipoPermitido: true }), "EMPRESA_DESABILITADA"],
      ["tipo não permitido", async () => {}, async () => ({ empresaHabilitada: true, tipoPermitido: false }), "TIPO_NAO_PERMITIDO"],
    ];
    for (const [nome, preparar, habilitacao, motivoEsperado] of casos) {
      await definirContato({ verificado: true, consentimento: true, opt_out: false });
      await preparar();
      const par = await alertaComMensagem(`2026-11-1${casos.findIndex((c) => c[0] === nome) + 1}`);
      const { chamadas, whatsAppService } = criarProviderComSpy();
      const r = await lote(whatsAppService, { resolverHabilitacao: habilitacao });
      const meu = r.find((x) => x.id === par.job.id);
      assert.equal(meu?.resultado, "BLOQUEADO", nome);
      assert.equal(meu?.motivo, motivoEsperado, nome);
      assert.equal(chamadas.length, 0, nome);
      assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.BLOCKED, nome);
      assert.equal((await linha(par.job.id)).tentativas, 0, `${nome}: um veto de política não é attempt`);
      await limpar(par);
    }
    // com TUDO liberado, prossegue
    await definirContato({ verificado: true, consentimento: true, opt_out: false });
    const ok = await alertaComMensagem("2026-11-20");
    const { chamadas, whatsAppService } = criarProviderComSpy();
    assert.equal((await lote(whatsAppService)).find((x) => x.id === ok.job.id)?.resultado, "ENVIADO");
    assert.equal(chamadas.length, 1);
    await limpar(ok);
  });

  test("HABILITAÇÃO PADRÃO (nenhum resolvedor injetado): mesmo com modo NORMAL + contato consentido/verificado + tudo o mais ok, NADA é enviado", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-11-21");
    const { chamadas, whatsAppService } = criarProviderComSpy();
    // SEM `resolverHabilitacao`: exercita o wiring padrão de produção de processarProximoLote.
    const r = await processarProximoLote({ limite: 20, worker: "padrao", whatsAppService, agora: AGORA_UTIL, verificarPendenciaAindaExiste: async () => true });
    const meu = r.find((x) => x.id === par.job.id);
    assert.equal(meu?.resultado, "BLOQUEADO");
    assert.equal(meu?.motivo, "EMPRESA_DESABILITADA");
    assert.equal(chamadas.length, 0);
    await limpar(par);
  });

  test("resolverHabilitacaoEmpresa (persistida, migration 088): organização SEM registro, ausente ou desconhecida -> SEMPRE fechada, para qualquer tipo", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    for (const org of [orgA, orgB, "00000000-0000-0000-0000-000000000000", null, undefined]) {
      for (const tipo of [TIPOS_ALERTA.DASHBOARD_IFOOD_D1, "qualquer", null]) {
        const h = await resolverHabilitacaoEmpresa({ organizacaoId: org, tipoAlerta: tipo });
        assert.equal(h.empresaHabilitada, false);
        assert.equal(h.tipoPermitido, false);
        assert.equal(h.configHorarioValida, false);
        assert.ok(["SEM_REGISTRO", "SEM_ORGANIZACAO"].includes(h.fonte), h.fonte);
      }
    }
  });

  test("deferimento no PIPELINE + worker stale: A adia (zero attempts); B reivindica; A (job velho) tenta enviar -> POSSE_PERDIDA; só B envia (attempt 1)", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-11-22");
    const { chamadas, whatsAppService } = criarProviderComSpy();
    const ctx = (agora) => ({ whatsAppService, agora, adiamentoMs: 900_000, verificarPendenciaAindaExiste: async () => true, resolverHabilitacao: HABILITADA });

    const jobA = (await filaRepo.claimJobs({ limite: 50, worker: "manual", leaseSegundos: 120 })).find((j) => j.id === par.job.id);
    const rA1 = await processarJobReivindicado(jobA, ctx(AGORA_DOMINGO)); // fora da janela -> adia
    assert.equal(rA1.resultado, "ADIADO");
    let l = await linha(par.job.id);
    assert.equal(l.tentativas, 0);
    assert.equal(l.status, STATUS_MENSAGEM.SCHEDULED);

    await supabase.from("comunicacao_mensagens").update({ disponivel_em: new Date(Date.now() - 1000).toISOString() }).eq("id", par.job.id);
    const jobB = (await filaRepo.claimJobs({ limite: 50, worker: "manual", leaseSegundos: 120 })).find((j) => j.id === par.job.id);
    assert.equal(jobB.claim_geracao, 2);
    assert.equal(jobB.tentativas, 0, "B obteve outro claim e nenhum attempt existe ainda");

    // A "acorda" com o job velho, agora DENTRO da janela: a política dela libera — só o fencing a impede.
    const rA2 = await processarJobReivindicado(jobA, ctx(AGORA_UTIL));
    assert.equal(rA2.resultado, "POSSE_PERDIDA", JSON.stringify(rA2));
    assert.equal(chamadas.length, 0);
    l = await linha(par.job.id);
    assert.equal(l.status, STATUS_MENSAGEM.PROCESSING, "a linha continua com B");
    assert.equal(l.tentativas, 0);

    const rB = await processarJobReivindicado(jobB, ctx(AGORA_UTIL));
    assert.equal(rB.resultado, "ENVIADO");
    assert.equal(chamadas.length, 1);
    assert.equal((await linha(par.job.id)).tentativas, 1);
    await limpar(par);
  });

  test("DELIVERY_UNKNOWN: nem o agendador, nem a sincronização de alertas, nem o cancelamento por pendência, nem o claim o tocam", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const par = await alertaComMensagem("2026-11-23");
    const { provider, chamadas, whatsAppService } = criarProviderComSpy();
    provider.falharProximoEnvio({ mensagem: "conexão caiu durante o envio" });
    await lote(whatsAppService);
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.DELIVERY_UNKNOWN);

    // NEGÓCIO × TRANSPORTE: a incerteza é da MENSAGEM; o alerta NÃO ganha status de transporte (continua DETECTED aqui,
    // pois o helper cria a mensagem sem passar pelo agendador atômico) — é o PIOR CASO: o agendador re-executa para este
    // alerta. A UNIQUE(idempotency_key) tem de devolver a MESMA linha, sem criar outra e sem mexer no estado.
    assert.equal(await statusAlerta(par.alerta.id), STATUS_ALERTA.DETECTED, "o alerta não pode assumir o estado de transporte");
    await habilitarOrganizacao(orgA, { contatoId, perfilId }); // habilitação REAL (o banco a lê)
    await agendarEnviosPendentes({ organizacaoId: orgA, agora: AGORA_UTIL });
    const { count: totalDoAlerta } = await supabase.from("comunicacao_mensagens").select("id", { count: "exact", head: true }).eq("alerta_id", par.alerta.id);
    assert.equal(totalDoAlerta, 1, "o agendador criou uma SEGUNDA mensagem para o mesmo alerta");
    assert.equal((await linha(par.job.id)).status, STATUS_MENSAGEM.DELIVERY_UNKNOWN, "o agendador mexeu numa mensagem DELIVERY_UNKNOWN");
    // e um segundo ciclo do agendador já não encontra nada DETECTED para este alerta
    assert.equal((await agendarEnviosPendentes({ organizacaoId: orgA, agora: AGORA_UTIL })).agendados, 0);
    await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", orgA);
    // idempotência: reagendar o MESMO alerta devolve a linha existente, sem mexer no estado
    const mesma = await filaRepo.agendarMensagem({ alertaId: par.alerta.id, organizacaoId: orgA, unidadeId: unidadeA, contatoId, tipo: par.alerta.tipo_alerta, conteudo: "x", idempotencyKey: `wa:alerta:${par.alerta.id}:v1`, disponivelEm: new Date() });
    assert.equal(mesma.id, par.job.id);
    assert.equal(mesma.status, STATUS_MENSAGEM.DELIVERY_UNKNOWN);
    // "pendência resolvida": cancelamento só atinge SCHEDULED
    assert.deepEqual(await filaRepo.cancelarPendentesPorAlerta(par.alerta.id), []);
    // "restart" + "lease" + "tempo": novo lote, tempo e lease vencidos, varredura
    await supabase.from("comunicacao_mensagens").update({ disponivel_em: new Date(Date.now() - 86_400_000).toISOString(), claim_expira_em: new Date(Date.now() - 86_400_000).toISOString() }).eq("id", par.job.id);
    await filaRepo.expirarEntregasIncertas({ worker: "varredura" });
    assert.equal((await lote(whatsAppService)).some((x) => x.id === par.job.id), false);
    assert.equal(chamadas.length, 1);
    const l = await linha(par.job.id);
    assert.equal(l.status, STATUS_MENSAGEM.DELIVERY_UNKNOWN);
    assert.equal(l.tentativas, 1);
    await limpar(par);
  });

  test("COOLDOWN: DELIVERY_UNKNOWN e SENDING contam SEM limite de tempo; SENT só dentro da janela; nada disso consome attempt", async (t) => {
    if (!migracaoOk) return t.skip("migrations 082/087 ainda não aplicadas — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const antigo = new Date(Date.now() - 3 * 86_400_000).toISOString(); // 3 dias: fora de qualquer cooldown (8h/4h)
    const casos = [
      ["DELIVERY_UNKNOWN de 3 dias atrás", { status: "DELIVERY_UNKNOWN", entrega_incerta_em: antigo }, true],
      ["SENDING de 3 dias atrás (nunca reconciliado)", { status: "SENDING", claimed_by: "w-morto", claimed_at: antigo, claim_expira_em: antigo, tentativas: 1 }, true],
      ["SENT de 3 dias atrás (fora da janela)", { status: "SENT", enviado_em: antigo }, false],
      ["SENT de agora (dentro da janela)", { status: "SENT", enviado_em: new Date().toISOString() }, true],
    ];
    for (const [nome, campos, deveAdiar] of casos) {
      const anterior = await alertaComMensagem(`2027-01-${String(casos.findIndex((c) => c[0] === nome) + 1).padStart(2, "0")}`);
      await supabase.from("comunicacao_mensagens").update(campos).eq("id", anterior.job.id);
      const par = await alertaComMensagem(`2027-02-${String(casos.findIndex((c) => c[0] === nome) + 1).padStart(2, "0")}`);
      const { chamadas, whatsAppService } = criarProviderComSpy();
      const r = (await lote(whatsAppService)).find((x) => x.id === par.job.id);
      if (deveAdiar) {
        assert.equal(r?.resultado, "ADIADO", nome);
        assert.equal(r?.motivo, "COOLDOWN", nome);
        assert.equal(chamadas.length, 0, nome);
        assert.equal((await linha(par.job.id)).tentativas, 0, nome);
      } else {
        assert.equal(r?.resultado, "ENVIADO", nome);
      }
      await limpar(anterior, par);
      await supabase.from("comunicacao_mensagens").delete().eq("contato_id", contatoId);
    }
  });
});
