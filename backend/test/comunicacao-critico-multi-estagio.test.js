// Checkpoint H.4-A.6 — fundação SQL multi-estágio D-1 crítico (migration 091),
// contra o banco de TESTE. Mesmo padrão de comunicacao-ttl-unknown-reconciliacao.test.js:
// PULA sem credencial/migration (nunca falha "vermelho" por ausência de infra).
//
// NÃO testado contra Postgres real neste checkpoint (nenhum banco descartável
// disponível no ambiente em que este arquivo foi escrito) — ver relatório
// H.4-A.6, itens 29-30. Este arquivo roda de verdade assim que houver
// DATABASE_TESTE_URL/.env.test-integracao configurados com a migration 091
// aplicada, e PULA (não falha) sem isso — mesmo contrato dos arquivos irmãos.
//
// Rodar: node --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-critico-multi-estagio.test.js
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, criarDestinatario, apagarDestinatario, habilitarOrganizacao,
  migracao082Aplicada, migracao088Aplicada, migracao091Aplicada,
} from "./helpers/comunicacao-fixtures.js";
import * as alertasRepo from "../src/modules/comunicacao/comunicacao.alertas.repo.js";
import { STATUS_ALERTA as SA, STATUS_MENSAGEM as SM, TIPOS_ALERTA, SEVERIDADE } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
const TIPO = TIPOS_ALERTA.DASHBOARD_IFOOD_D1;
const tag = `comcrit${Date.now()}`;

let migracaoOk = true;
let orgA = null, unidadeA = null, dest = null;

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada()) && (await migracao091Aplicada());
  if (!migracaoOk) return;
  orgA = await criarOrganizacao("TESTE critico-multi-estagio — descartável");
  unidadeA = await criarUnidade(orgA, "Unidade Crítico A1");
  dest = await criarDestinatario({ organizacaoId: orgA, unidadeId: unidadeA, tag });
  await habilitarOrganizacao(orgA, dest);
});

after(async () => {
  await apagarOrganizacao(orgA);
  await apagarDestinatario(dest);
});

beforeEach(async () => {
  if (PULAR_INTEGRACAO || !migracaoOk) return;
  await supabase.from("comunicacao_alertas").delete().eq("organizacao_id", orgA);
  await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
});

let seq = 0;
async function novoAlerta(dataReferencia = "2026-09-21") {
  const { alerta } = await alertasRepo.criarOuEscalonarAlerta({
    organizacaoId: orgA, unidadeId: unidadeA, tipoAlerta: TIPO, dataReferencia, destinatarioPerfilId: null,
    severidade: SEVERIDADE.ATENCAO, motivo: "1 dia(s) pendente(s)", metadados: { unidade_nome: "Loja Crítico", empresa_nome: "Rede Crítico" },
  });
  return alerta;
}

function chaveNormal(alertaId) { return `wa:alerta:${alertaId}:v1`; }
function chaveCritica(alertaId, estagio) { return `wa:alerta:${alertaId}:${estagio === "critico_1" ? "critico1" : "criticofinal"}:v1`; }

async function inserirMensagem({ alertaId, status, estagio = null, idempotencyKey, extra = {} }) {
  const { data, error } = await supabase.from("comunicacao_mensagens").insert({
    alerta_id: alertaId, organizacao_id: orgA, unidade_id: unidadeA, contato_id: dest.contatoId,
    destinatario_perfil_id: dest.perfilId, canal: "whatsapp", direcao: "saida", tipo: TIPO,
    conteudo: "aviso de teste", idempotency_key: idempotencyKey, status,
    metadados: estagio ? { estagio } : {}, disponivel_em: new Date().toISOString(), ...extra,
  }).select("*").single();
  if (error) throw new Error(`fixture: ${error.message}`);
  return data;
}

async function statusDoAlerta(alertaId) {
  const { data } = await supabase.from("comunicacao_alertas").select("status").eq("id", alertaId).single();
  return data?.status;
}

function chamarCritica(alertaId, estagio, { idempotencyKey } = {}) {
  return supabase.rpc("comunicacao_agendar_mensagem_critica", {
    p_alerta_id: alertaId, p_estagio: estagio, p_conteudo: "conteudo de teste",
    p_idempotency_key: idempotencyKey ?? chaveCritica(alertaId, estagio),
    p_disponivel_em: new Date().toISOString(), p_expira_em: null, p_max_tentativas: 5,
  });
}

describe("Checkpoint H.4-A.6 — item 3: função NORMAL permanece intacta", { skip: PULAR_INTEGRACAO }, () => {
  test("comunicacao_agendar_mensagem_alerta continua criando a mensagem normal exatamente como antes", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const { data, error } = await supabase.rpc("comunicacao_agendar_mensagem_alerta", {
      p_alerta_id: alerta.id, p_tipo: TIPO, p_conteudo: "normal", p_idempotency_key: chaveNormal(alerta.id),
      p_disponivel_em: new Date().toISOString(), p_expira_em: null, p_max_tentativas: 5,
    });
    assert.equal(error, null);
    assert.equal(data.acao, "CRIADA");
    assert.equal(await statusDoAlerta(alerta.id), SA.SCHEDULED);
  });
});

describe("Checkpoint H.4-A.6 — item 10: estágio inválido é recusado (fail-closed)", { skip: PULAR_INTEGRACAO }, () => {
  test("estágio fora de {critico_1, critico_final} -> ESTAGIO_INVALIDO, nada é criado", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const { data } = await chamarCritica(alerta.id, "normal");
    assert.equal(data.acao, "ESTAGIO_INVALIDO");
    const { data: msgs } = await supabase.from("comunicacao_mensagens").select("id").eq("alerta_id", alerta.id);
    assert.equal(msgs.length, 0);
  });
});

describe("Checkpoint H.4-A.6 — item 11: só dashboard_ifood_d1", { skip: PULAR_INTEGRACAO }, () => {
  test("alerta de outro tipo_alerta -> TIPO_NAO_SUPORTADO", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    await supabase.from("comunicacao_alertas").update({ tipo_alerta: "outro_tipo_qualquer" }).eq("id", alerta.id);
    const { data } = await chamarCritica(alerta.id, "critico_1");
    assert.equal(data.acao, "TIPO_NAO_SUPORTADO");
  });
});

describe("Checkpoint H.4-A.6 — itens 15-16-17: supersede atômico (NORMAL/CRITICO_1 -> CANCELLED, nunca DELETE)", { skip: PULAR_INTEGRACAO }, () => {
  test("NORMAL SCHEDULED + chega CRITICO_1 legítimo -> NORMAL vira CANCELLED/SUPERSEDED_BY_CRITICO_1, CRITICO_1 vira SCHEDULED, alerta=SCHEDULED", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const normal = await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, idempotencyKey: chaveNormal(alerta.id) });
    const { data } = await chamarCritica(alerta.id, "critico_1");
    assert.equal(data.acao, "CRIADA");
    assert.equal(data.supersedeu, true);

    const { data: normalAtualizado } = await supabase.from("comunicacao_mensagens").select("status, erro").eq("id", normal.id).single();
    assert.equal(normalAtualizado.status, SM.CANCELLED);
    assert.equal(normalAtualizado.erro, "SUPERSEDED_BY_CRITICO_1");

    const { data: critico1 } = await supabase.from("comunicacao_mensagens").select("status, metadados").eq("id", data.mensagem_id).single();
    assert.equal(critico1.status, SM.SCHEDULED);
    assert.equal(critico1.metadados.estagio, "critico_1");
    assert.equal(await statusDoAlerta(alerta.id), SA.SCHEDULED);

    // nunca DELETE — a linha superada continua existindo, íntegra.
    const { data: todas } = await supabase.from("comunicacao_mensagens").select("id").eq("alerta_id", alerta.id);
    assert.equal(todas.length, 2);
  });

  test("CRITICO_1 SCHEDULED + chega CRITICO_FINAL legítimo -> CRITICO_1 vira CANCELLED/SUPERSEDED_BY_CRITICO_FINAL", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const c1 = await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, estagio: "critico_1", idempotencyKey: chaveCritica(alerta.id, "critico_1") });
    const { data } = await chamarCritica(alerta.id, "critico_final");
    assert.equal(data.acao, "CRIADA");

    const { data: c1Atualizado } = await supabase.from("comunicacao_mensagens").select("status, erro").eq("id", c1.id).single();
    assert.equal(c1Atualizado.status, SM.CANCELLED);
    assert.equal(c1Atualizado.erro, "SUPERSEDED_BY_CRITICO_FINAL");
  });

  test("item 17: CANCELLED por SUPERSEDED nunca reabre o alerta para DETECTED", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, idempotencyKey: chaveNormal(alerta.id) });
    await chamarCritica(alerta.id, "critico_1");
    // se o trigger tratasse SUPERSEDED como EXPIRADA, o alerta voltaria a DETECTED aqui.
    assert.equal(await statusDoAlerta(alerta.id), SA.SCHEDULED);
  });
});

describe("Checkpoint H.4-A.6 — itens 19-20: PROCESSING/SENDING/DELIVERY_UNKNOWN bloqueiam (fail-closed, sem corrida)", { skip: PULAR_INTEGRACAO }, () => {
  for (const status of [SM.PROCESSING, SM.SENDING, SM.DELIVERY_UNKNOWN]) {
    test(`mensagem existente em ${status} -> ENTREGA_EM_CURSO, nada novo é criado`, async (t) => {
      if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
      const alerta = await novoAlerta();
      await inserirMensagem({ alertaId: alerta.id, status, idempotencyKey: chaveNormal(alerta.id) });
      const { data } = await chamarCritica(alerta.id, "critico_1");
      assert.equal(data.acao, "ENTREGA_EM_CURSO");
      const { data: msgs } = await supabase.from("comunicacao_mensagens").select("id").eq("alerta_id", alerta.id);
      assert.equal(msgs.length, 1, "nenhuma segunda linha deve ter sido criada");
    });
  }
});

describe("Checkpoint H.4-A.6 — item 21: FAILED permanente permite o próximo estágio", { skip: PULAR_INTEGRACAO }, () => {
  test("NORMAL FAILED -> CRITICO_1 pode ser criado normalmente", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    await inserirMensagem({ alertaId: alerta.id, status: SM.FAILED, idempotencyKey: chaveNormal(alerta.id), extra: { erro_permanente: true } });
    const { data } = await chamarCritica(alerta.id, "critico_1");
    assert.equal(data.acao, "CRIADA");
  });
});

describe("Checkpoint H.4-A.6 — item 22: SENT/DELIVERED/READ permitem o próximo estágio", { skip: PULAR_INTEGRACAO }, () => {
  for (const status of [SM.SENT, SM.DELIVERED, SM.READ]) {
    test(`NORMAL ${status} -> CRITICO_1 ainda pode ser criado (entrega não significa pendência resolvida)`, async (t) => {
      if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
      const alerta = await novoAlerta();
      await inserirMensagem({ alertaId: alerta.id, status, idempotencyKey: chaveNormal(alerta.id), extra: { enviado_em: new Date().toISOString() } });
      const { data } = await chamarCritica(alerta.id, "critico_1");
      assert.equal(data.acao, "CRIADA");
    });
  }
});

describe("Checkpoint H.4-A.6 — item 30: estágio fora de ordem é recusado (fail-closed)", { skip: PULAR_INTEGRACAO }, () => {
  test("CRITICO_FINAL já existe -> pedido tardio de critico_1 -> ESTAGIO_JA_SUPERADO", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    await inserirMensagem({ alertaId: alerta.id, status: SM.SENT, estagio: "critico_final", idempotencyKey: chaveCritica(alerta.id, "critico_final"), extra: { enviado_em: new Date().toISOString() } });
    const { data } = await chamarCritica(alerta.id, "critico_1", { idempotencyKey: `wa:alerta:${alerta.id}:critico1-tardio:v1` });
    assert.equal(data.acao, "ESTAGIO_JA_SUPERADO");
  });
});

describe("Checkpoint H.4-A.6 — item 12/13: idempotência — chamada repetida da MESMA chave nunca duplica", { skip: PULAR_INTEGRACAO }, () => {
  test("mesma idempotency_key duas vezes -> JA_EXISTIA na segunda, uma linha só", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const chave = chaveCritica(alerta.id, "critico_1");
    const r1 = await chamarCritica(alerta.id, "critico_1", { idempotencyKey: chave });
    assert.equal(r1.data.acao, "CRIADA");
    const r2 = await chamarCritica(alerta.id, "critico_1", { idempotencyKey: chave });
    assert.equal(r2.data.acao, "JA_EXISTIA");
    assert.equal(r2.data.mensagem_id, r1.data.mensagem_id);
    const { data: msgs } = await supabase.from("comunicacao_mensagens").select("id").eq("alerta_id", alerta.id);
    assert.equal(msgs.length, 1);
  });
});

describe("Checkpoint H.4-A.6 — item 13/32/33: concorrência — 30 chamadas simultâneas -> 1 mensagem lógica", { skip: PULAR_INTEGRACAO }, () => {
  test("30x critico_1 concorrentes para o mesmo alerta -> exatamente 1 CRIADA, 29 JA_EXISTIA", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const chave = chaveCritica(alerta.id, "critico_1");
    const respostas = await Promise.all(Array.from({ length: 30 }, () => chamarCritica(alerta.id, "critico_1", { idempotencyKey: chave })));
    const acoes = respostas.map((r) => r.data.acao);
    assert.equal(acoes.filter((a) => a === "CRIADA").length, 1);
    assert.equal(acoes.filter((a) => a === "JA_EXISTIA").length, 29);
    const { data: msgs } = await supabase.from("comunicacao_mensagens").select("id").eq("alerta_id", alerta.id);
    assert.equal(msgs.length, 1);
  });

  test("30x critico_final concorrentes, depois de critico_1 já existir e ter sido superado -> exatamente 1 CRIADA a mais (2 mensagens críticas no total)", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    await chamarCritica(alerta.id, "critico_1");
    const chaveFinal = chaveCritica(alerta.id, "critico_final");
    const respostas = await Promise.all(Array.from({ length: 30 }, () => chamarCritica(alerta.id, "critico_final", { idempotencyKey: chaveFinal })));
    const acoes = respostas.map((r) => r.data.acao);
    assert.equal(acoes.filter((a) => a === "CRIADA").length, 1);
    assert.equal(acoes.filter((a) => a === "JA_EXISTIA").length, 29);
    const { data: msgs } = await supabase.from("comunicacao_mensagens").select("id, status, metadados").eq("alerta_id", alerta.id);
    assert.equal(msgs.length, 2, "critico_1 (agora CANCELLED/superado) + critico_final (SCHEDULED)");
  });
});

describe("Checkpoint H.4-A.6 — item 33: restart/scheduler tenta de novo -> nunca uma segunda CRITICO_1", { skip: PULAR_INTEGRACAO }, () => {
  test("scheduler reexecuta depois de CRITICO_1 já SENT -> JA_EXISTIA, nenhuma segunda linha", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const chave = chaveCritica(alerta.id, "critico_1");
    const r1 = await chamarCritica(alerta.id, "critico_1", { idempotencyKey: chave });
    await supabase.from("comunicacao_mensagens").update({ status: SM.SENT, enviado_em: new Date().toISOString() }).eq("id", r1.data.mensagem_id);
    const r2 = await chamarCritica(alerta.id, "critico_1", { idempotencyKey: chave });
    assert.equal(r2.data.acao, "JA_EXISTIA");
  });
});

describe("Checkpoint H.4-A.6 — itens 6-7-8-9: trigger stage-aware, out-of-order, prioridade > created_at", { skip: PULAR_INTEGRACAO }, () => {
  test("item 9: NORMAL sem metadados.estagio é tratado como NORMAL (prioridade 0) — compatibilidade histórica sem backfill", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const normal = await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, idempotencyKey: chaveNormal(alerta.id) }); // metadados: {} (sem 'estagio')
    await supabase.from("comunicacao_mensagens").update({ status: SM.SENT, enviado_em: new Date().toISOString() }).eq("id", normal.id);
    assert.equal(await statusDoAlerta(alerta.id), SA.SENT, "trigger legado continua funcionando para mensagem sem estágio");
  });

  test("item 6-7: NORMAL=SENT, CRITICO_1=SCHEDULED, receipt tardio NORMAL->DELIVERED -> alerta NÃO regride, continua refletindo CRITICO_1", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const normal = await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, idempotencyKey: chaveNormal(alerta.id) });
    await supabase.from("comunicacao_mensagens").update({ status: SM.SENT, enviado_em: new Date().toISOString() }).eq("id", normal.id);
    assert.equal(await statusDoAlerta(alerta.id), SA.SENT);

    await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, estagio: "critico_1", idempotencyKey: chaveCritica(alerta.id, "critico_1") });
    assert.equal(await statusDoAlerta(alerta.id), SA.SCHEDULED, "criar a mensagem crítica não move o alerta sozinho — só o UPDATE da própria linha crítica move");

    // receipt tardio do NORMAL (evento fora de ordem)
    await supabase.from("comunicacao_mensagens").update({ status: SM.DELIVERED }).eq("id", normal.id);
    assert.equal(await statusDoAlerta(alerta.id), SA.SCHEDULED, "H.4-A.5, item 3: um evento tardio do NORMAL nunca pode sobrescrever o estágio mais prioritário (CRITICO_1)");
  });

  test("item 4/8: NORMAL=SENT, CRITICO_1=SENT, CRITICO_FINAL=SCHEDULED; depois NORMAL->DELIVERED e CRITICO_1->READ (fora de ordem) -> alerta continua refletindo CRITICO_FINAL", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const normal = await inserirMensagem({ alertaId: alerta.id, status: SM.SENT, idempotencyKey: chaveNormal(alerta.id), extra: { enviado_em: new Date().toISOString() } });
    const c1 = await inserirMensagem({ alertaId: alerta.id, status: SM.SENT, estagio: "critico_1", idempotencyKey: chaveCritica(alerta.id, "critico_1"), extra: { enviado_em: new Date().toISOString() } });
    await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, estagio: "critico_final", idempotencyKey: chaveCritica(alerta.id, "critico_final") });

    await supabase.from("comunicacao_mensagens").update({ status: SM.DELIVERED }).eq("id", normal.id);
    await supabase.from("comunicacao_mensagens").update({ status: SM.READ }).eq("id", c1.id);
    assert.equal(await statusDoAlerta(alerta.id), SA.SCHEDULED, "nem o NORMAL nem o CRITICO_1 tardios podem regredir/sobrescrever o CRITICO_FINAL, que ainda está em aberto");
  });
});

describe("Checkpoint H.4-A.6 — item 18: EXPIRADA em multi-estágio", { skip: PULAR_INTEGRACAO }, () => {
  test("A) NORMAL EXPIRADA sem crítico -> comportamento legado preservado (alerta volta a DETECTED)", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const normal = await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, idempotencyKey: chaveNormal(alerta.id) });
    await supabase.from("comunicacao_mensagens").update({ status: SM.CANCELLED, erro: "EXPIRADA" }).eq("id", normal.id);
    assert.equal(await statusDoAlerta(alerta.id), SA.DETECTED);
  });

  test("B) NORMAL EXPIRADA, mas CRITICO_1 já existe -> NORMAL NÃO pode colocar o alerta em DETECTED", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const normal = await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, idempotencyKey: chaveNormal(alerta.id) });
    await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, estagio: "critico_1", idempotencyKey: chaveCritica(alerta.id, "critico_1") });
    await supabase.from("comunicacao_mensagens").update({ status: SM.CANCELLED, erro: "EXPIRADA" }).eq("id", normal.id);
    assert.equal(await statusDoAlerta(alerta.id), SA.SCHEDULED, "CRITICO_1 continua no controle — NORMAL expirado não reabre o alerta");
  });

  test("C) CRITICO_1 EXPIRADA, CRITICO_FINAL já existe -> CRITICO_1 não controla mais o agregado", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const c1 = await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, estagio: "critico_1", idempotencyKey: chaveCritica(alerta.id, "critico_1") });
    await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, estagio: "critico_final", idempotencyKey: chaveCritica(alerta.id, "critico_final") });
    await supabase.from("comunicacao_mensagens").update({ status: SM.CANCELLED, erro: "EXPIRADA" }).eq("id", c1.id);
    assert.equal(await statusDoAlerta(alerta.id), SA.SCHEDULED);
  });

  test("D) estágio de MAIOR prioridade expira e não há estágio posterior -> alerta reabre para DETECTED, e o NORMAL não duplica (idempotência já cobre)", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    // NORMAL já terminal (SENT) e único estágio crítico já superado — o mais alto criado é critico_final.
    await inserirMensagem({ alertaId: alerta.id, status: SM.SENT, idempotencyKey: chaveNormal(alerta.id), extra: { enviado_em: new Date().toISOString() } });
    const final = await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, estagio: "critico_final", idempotencyKey: chaveCritica(alerta.id, "critico_final") });
    await supabase.from("comunicacao_mensagens").update({ status: SM.CANCELLED, erro: "EXPIRADA" }).eq("id", final.id);
    assert.equal(await statusDoAlerta(alerta.id), SA.DETECTED);

    // Reprocessar o NORMAL com a MESMA chave de sempre não duplica (idempotência da função normal, intocada).
    const { data } = await supabase.rpc("comunicacao_agendar_mensagem_alerta", {
      p_alerta_id: alerta.id, p_tipo: TIPO, p_conteudo: "normal", p_idempotency_key: chaveNormal(alerta.id),
      p_disponivel_em: new Date().toISOString(), p_expira_em: null, p_max_tentativas: 5,
    });
    assert.equal(data.acao, "JA_EXISTIA");
  });
});

describe("Checkpoint H.4-A.6 — item 31: regressão legada — sem NENHUMA mensagem crítica, fluxo idêntico ao de antes", { skip: PULAR_INTEGRACAO }, () => {
  test("DETECTED -> SCHEDULED -> SENT -> DELIVERED -> READ, exatamente como antes da 091", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    assert.equal(await statusDoAlerta(alerta.id), SA.DETECTED);
    const { data } = await supabase.rpc("comunicacao_agendar_mensagem_alerta", {
      p_alerta_id: alerta.id, p_tipo: TIPO, p_conteudo: "normal", p_idempotency_key: chaveNormal(alerta.id),
      p_disponivel_em: new Date().toISOString(), p_expira_em: null, p_max_tentativas: 5,
    });
    assert.equal(await statusDoAlerta(alerta.id), SA.SCHEDULED);
    await supabase.from("comunicacao_mensagens").update({ status: SM.SENT, enviado_em: new Date().toISOString() }).eq("id", data.mensagem_id);
    assert.equal(await statusDoAlerta(alerta.id), SA.SENT);
    await supabase.from("comunicacao_mensagens").update({ status: SM.DELIVERED }).eq("id", data.mensagem_id);
    assert.equal(await statusDoAlerta(alerta.id), SA.DELIVERED);
    await supabase.from("comunicacao_mensagens").update({ status: SM.READ }).eq("id", data.mensagem_id);
    assert.equal(await statusDoAlerta(alerta.id), SA.READ);
  });
});

describe("Checkpoint H.4-A.6 — item 19: alertasRepo.atualizarStatusAlertaPorMensagem respeita a mesma prioridade", { skip: PULAR_INTEGRACAO }, () => {
  test("mensagem de estágio inferior tenta gravar BLOCKED depois que um estágio superior já existe -> IGNORADO_ESTAGIO_SUPERADO, alerta preservado", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const normal = await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, idempotencyKey: chaveNormal(alerta.id) });
    await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, estagio: "critico_1", idempotencyKey: chaveCritica(alerta.id, "critico_1") });
    // simula um veto de política tardio sobre a mensagem NORMAL, já superada pelo CRITICO_1
    const atualizou = await alertasRepo.atualizarStatusAlertaPorMensagem(normal.id, SA.BLOCKED);
    assert.equal(atualizou, false);
    assert.equal(await statusDoAlerta(alerta.id), SA.SCHEDULED);
  });

  test("mensagem do estágio mais prioritário grava BLOCKED normalmente", async (t) => {
    if (!migracaoOk) return t.skip(PULAR_INTEGRACAO ?? "migration 091 ainda não aplicada — pulando.");
    const alerta = await novoAlerta();
    const normal = await inserirMensagem({ alertaId: alerta.id, status: SM.SCHEDULED, idempotencyKey: chaveNormal(alerta.id) });
    const atualizou = await alertasRepo.atualizarStatusAlertaPorMensagem(normal.id, SA.BLOCKED);
    assert.equal(atualizou, true);
    assert.equal(await statusDoAlerta(alerta.id), SA.BLOCKED);
  });
});

// Sem skip: revisão estática pura, não depende de banco nenhum.
describe("Checkpoint H.4-A.6 — item 28: JIT — mensagem crítica usa o MESMO caminho de revalidação (grep estático)", () => {
  test("nenhuma função nova cria um provider path alternativo (revisão estática)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const codigo = fs.readFileSync(path.join(__dirname, "..", "src", "modules", "comunicacao", "comunicacao.alertas.repo.js"), "utf8");
    assert.doesNotMatch(codigo, /whatsapp\.service|providers\/|criarWhatsAppService/, "o repo de alertas nunca pode chamar o provider diretamente");
  });
});
