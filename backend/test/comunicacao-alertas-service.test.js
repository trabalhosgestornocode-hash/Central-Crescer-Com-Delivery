// Integração — orquestração completa (alertas.repo + fila.repo +
// policy + FakeProvider) contra o Supabase REAL. Cobre dedup real (teste
// 4), cancelamento por regularização (teste 5), revalidação pós-claim
// (teste 6), isolamento entre organizações (teste 16), e a prova de que
// nada chega ao provider sem passar pelo Policy Engine (teste 18).
// Rodar: node --env-file=.env --test test/comunicacao-alertas-service.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, criarContaComPerfil, apagarConta,
  vincularUsuarioUnidade, migracao082Aplicada,
} from "./helpers/comunicacao-fixtures.js";
import * as alertasRepo from "../src/modules/comunicacao/comunicacao.alertas.repo.js";
import * as filaRepo from "../src/modules/comunicacao/comunicacao.fila.repo.js";
import * as contatosRepo from "../src/modules/comunicacao/comunicacao.contatos.repo.js";
import { processarProximoLote } from "../src/modules/comunicacao/comunicacao.alertas.service.js";
import { definirModo, modoAtual } from "../src/modules/comunicacao/comunicacao.config.js";
import { criarWhatsAppService } from "../src/modules/comunicacao/whatsapp.service.js";
import { criarFakeProvider } from "../src/modules/comunicacao/providers/fake.provider.js";
import { MODOS, TIPOS_ALERTA, SEVERIDADE, STATUS_ALERTA, STATUS_MENSAGEM } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
let migracaoOk = true;
let modoOriginal = null;
const tag = `comalertas${Date.now()}`;

let orgA = null, orgB = null, unidadeA = null;
let contaId = null, perfilId = null, contatoId = null;

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = await migracao082Aplicada();
  if (!migracaoOk) return;

  modoOriginal = await modoAtual();
  orgA = await criarOrganizacao("TESTE comunicacao-alertas A — descartável");
  orgB = await criarOrganizacao("TESTE comunicacao-alertas B — descartável");
  unidadeA = await criarUnidade(orgA, "Unidade A1");

  const conta = await criarContaComPerfil(tag, "dest");
  contaId = conta.contaId; perfilId = conta.perfilId;
  await vincularUsuarioUnidade({ perfilId, organizacaoId: orgA, unidadeId: unidadeA });

  const contato = await contatosRepo.criarOuObterContato({ telefoneE164: `+551199${String(Date.now()).slice(-7)}` });
  contatoId = contato.id;
  await supabase.from("contatos_whatsapp").update({ verificado: true }).eq("id", contatoId);
  await contatosRepo.vincularPerfil({ contatoId, perfilOperacionalId: perfilId, principal: true });
});

after(async () => {
  if (modoOriginal) await definirModo(modoOriginal, {}).catch(() => {});
  if (contatoId) await supabase.from("contatos_whatsapp").delete().eq("id", contatoId);
  if (contaId) await apagarConta(contaId);
  await apagarOrganizacao(orgA);
  await apagarOrganizacao(orgB);
});

async function novoAlertaDetected(organizacaoId, unidadeId, dataReferencia, overrides = {}) {
  return alertasRepo.criarOuEscalonarAlerta({
    organizacaoId, unidadeId, tipoAlerta: TIPOS_ALERTA.DASHBOARD_IFOOD_D1, dataReferencia,
    destinatarioPerfilId: null, severidade: SEVERIDADE.ATENCAO, motivo: "2 dias pendente(s)",
    ...overrides,
  });
}

describe("comunicacao — orquestração (alertas + fila + policy + provider)", { skip: PULAR_INTEGRACAO }, () => {
  test("teste 4 — a MESMA pendência processada duas vezes gera um único alerta", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
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
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    const data = "2026-09-02";
    const r1 = await novoAlertaDetected(orgA, unidadeA, data, { severidade: SEVERIDADE.ATENCAO });
    const r2 = await novoAlertaDetected(orgA, unidadeA, data, { severidade: SEVERIDADE.CRITICO });
    assert.equal(r2.escalonado, true);
    assert.equal(r2.alerta.id, r1.alerta.id);
    assert.equal(r2.alerta.severidade, SEVERIDADE.CRITICO);
    await supabase.from("comunicacao_alertas").delete().eq("id", r1.alerta.id);
  });

  test("teste 5 — pendência resolvida ANTES do processamento cancela a mensagem agendada", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
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
    const { data: msg } = await supabase.from("comunicacao_mensagens").select("status").eq("id", job.id).single();
    assert.equal(msg.status, STATUS_MENSAGEM.CANCELLED);
    const { data: al } = await supabase.from("comunicacao_alertas").select("status").eq("id", alerta.id).single();
    assert.equal(al.status, STATUS_ALERTA.RESOLVED);

    await supabase.from("comunicacao_mensagens").delete().eq("id", job.id);
    await supabase.from("comunicacao_alertas").delete().eq("id", alerta.id);
  });

  test("teste 6 — pendência resolvida DEPOIS do claim mas ANTES do envio é revalidada e cancela (não envia aviso obsoleto)", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const { alerta } = await novoAlertaDetected(orgA, unidadeA, "2026-09-04");
    const job = await filaRepo.agendarMensagem({
      alertaId: alerta.id, organizacaoId: orgA, unidadeId: unidadeA, contatoId, destinatarioPerfilId: perfilId,
      tipo: alerta.tipo_alerta, conteudo: "aviso de pendência", idempotencyKey: `wa:alerta:${alerta.id}:v1`,
      disponivelEm: new Date(Date.now() - 60_000),
    });

    const provider = criarFakeProvider();
    const whatsAppService = criarWhatsAppService({ provider });
    const resultados = await processarProximoLote({
      limite: 5, worker: "teste-6", whatsAppService,
      verificarPendenciaAindaExiste: async () => false, // simula: regularizada entre o claim e agora
    });

    const meu = resultados.find((r) => r.id === job.id);
    assert.equal(meu?.resultado, "CANCELADO_PENDENCIA_RESOLVIDA");
    assert.equal(provider.mensagensEnviadas.length, 0, "não deveria ter enviado nada — pendência já não existia");

    const { data: al } = await supabase.from("comunicacao_alertas").select("status").eq("id", alerta.id).single();
    assert.equal(al.status, STATUS_ALERTA.RESOLVED);

    await supabase.from("comunicacao_mensagens").delete().eq("id", job.id);
    await supabase.from("comunicacao_alertas").delete().eq("id", alerta.id);
  });

  test("teste 18a — Policy Engine bloqueando (DISABLED) impede que QUALQUER coisa chegue ao provider", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    await definirModo(MODOS.DISABLED, {});
    const { alerta } = await novoAlertaDetected(orgA, unidadeA, "2026-09-05");
    const job = await filaRepo.agendarMensagem({
      alertaId: alerta.id, organizacaoId: orgA, unidadeId: unidadeA, contatoId, destinatarioPerfilId: perfilId,
      tipo: alerta.tipo_alerta, conteudo: "aviso de pendência", idempotencyKey: `wa:alerta:${alerta.id}:v1`,
      disponivelEm: new Date(Date.now() - 60_000),
    });

    const provider = criarFakeProvider();
    const whatsAppService = criarWhatsAppService({ provider });
    const resultados = await processarProximoLote({
      limite: 5, worker: "teste-18a", whatsAppService,
      verificarPendenciaAindaExiste: async () => true, // pendência ainda existe — só o MODO bloqueia
    });

    const meu = resultados.find((r) => r.id === job.id);
    assert.equal(meu?.resultado, "BLOQUEADO");
    assert.equal(meu?.motivo, "DISABLED");
    assert.equal(provider.mensagensEnviadas.length, 0);

    const { data: msg } = await supabase.from("comunicacao_mensagens").select("status, erro").eq("id", job.id).single();
    assert.equal(msg.status, STATUS_MENSAGEM.BLOCKED);

    await definirModo(MODOS.NORMAL, {});
    await supabase.from("comunicacao_mensagens").delete().eq("id", job.id);
    await supabase.from("comunicacao_alertas").delete().eq("id", alerta.id);
  });

  test("teste 18b — caminho feliz: aprovado pelo Policy Engine, o provider RECEBE exatamente 1 envio", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    await definirModo(MODOS.NORMAL, {});
    const { alerta } = await novoAlertaDetected(orgA, unidadeA, "2026-09-06");
    const job = await filaRepo.agendarMensagem({
      alertaId: alerta.id, organizacaoId: orgA, unidadeId: unidadeA, contatoId, destinatarioPerfilId: perfilId,
      tipo: alerta.tipo_alerta, conteudo: "aviso de pendência", idempotencyKey: `wa:alerta:${alerta.id}:v1`,
      disponivelEm: new Date(Date.now() - 60_000),
    });

    const provider = criarFakeProvider();
    const whatsAppService = criarWhatsAppService({ provider });
    const resultados = await processarProximoLote({
      limite: 5, worker: "teste-18b", whatsAppService,
      verificarPendenciaAindaExiste: async () => true,
    });

    const meu = resultados.find((r) => r.id === job.id);
    assert.equal(meu?.resultado, "ENVIADO");
    assert.equal(provider.mensagensEnviadas.length, 1);
    assert.equal(provider.mensagensEnviadas[0].telefoneE164, (await contatosRepo.obterContato(contatoId)).telefone_e164);

    await supabase.from("comunicacao_mensagens").delete().eq("id", job.id);
    await supabase.from("comunicacao_alertas").delete().eq("id", alerta.id);
  });

  test("teste 16 — organização A nunca lê/processa alertas da organização B", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
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
