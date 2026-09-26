// D.3-D — ATOMICIDADE alerta -> mensagem, IDEMPOTÊNCIA e HORÁRIO REAL do agendamento
// (migration 088), contra o banco de TESTE. Inclui a MUTAÇÃO obrigatória: falha injetada NO MEIO da
// transação (entre criar a mensagem e mover o alerta para SCHEDULED) => rollback total.
// Rodar (o teste de injeção de falha precisa também de DATABASE_TESTE_URL + psql; sem eles ele PULA):
//   node --env-file=.env --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-agendamento-atomico.test.js
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { agendarMensagemT, responsavelDoContato } from "./helpers/comunicacao-fixtures.js";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { motivoIndisponivel as motivoSemPsql, executarSqlNoBancoDeTeste } from "./helpers/psql-teste.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, criarDestinatario, apagarDestinatario, habilitarOrganizacao,
  migracao082Aplicada, migracao088Aplicada,
} from "./helpers/comunicacao-fixtures.js";
import * as alertasRepo from "../src/modules/comunicacao/comunicacao.alertas.repo.js";
import * as filaRepo from "../src/modules/comunicacao/comunicacao.fila.repo.js";
import { agendarEnviosPendentes } from "../src/modules/comunicacao/comunicacao.alertas.service.js";
import { TIPOS_ALERTA, SEVERIDADE, STATUS_ALERTA, STATUS_MENSAGEM } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
const SEM_PSQL = motivoSemPsql();
const TIPO = TIPOS_ALERTA.DASHBOARD_IFOOD_D1;
const tag = `comatom${Date.now()}`;
const HORA = 3600_000;
const MIN = 60_000;

let migracaoOk = true;
let orgA = null, orgB = null, unidadeA = null, unidadeB = null;
let destA = null, destA2 = null, destB = null; // destinatários EXPLÍCITOS (A = o configurado, A2 = outro elegível não selecionado, B = da outra org)

const HABILITADA = async () => ({
  empresaHabilitada: true, tipoPermitido: true, empresaPausada: false, pausadoAte: null, pausadoMotivo: null,
  destinatarioContatoId: "contato-de-teste", destinatarioContatoEmpresaId: "ce-de-teste", destinatarioPerfilId: "perfil-de-teste",
  timezone: "America/Fortaleza", janelas: null, configHorarioValida: true, fonte: "TESTE",
});

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada());
  if (!migracaoOk) return;
  orgA = await criarOrganizacao("TESTE agendamento-atomico A — descartável");
  orgB = await criarOrganizacao("TESTE agendamento-atomico B — descartável");
  unidadeA = await criarUnidade(orgA, "Unidade Atômica A1");
  unidadeB = await criarUnidade(orgB, "Unidade Atômica B1");
  destA = await criarDestinatario({ organizacaoId: orgA, unidadeId: unidadeA, tag, sufixo: "a" });
  destA2 = await criarDestinatario({ organizacaoId: orgA, unidadeId: unidadeA, tag, sufixo: "a2" });
  destB = await criarDestinatario({ organizacaoId: orgB, unidadeId: unidadeB, tag, sufixo: "b" });
});

after(async () => {
  removerFalha();
  await apagarOrganizacao(orgA); // cascade: alertas, mensagens, habilitação
  await apagarOrganizacao(orgB);
  for (const d of [destA, destA2, destB]) await apagarDestinatario(d);
});

// isolamento entre testes: alertas/mensagens de um teste (cascade) nunca entram na contagem do seguinte.
beforeEach(async () => {
  if (PULAR_INTEGRACAO || !migracaoOk) return;
  await supabase.from("comunicacao_alertas").delete().in("organizacao_id", [orgA, orgB]);
  await supabase.from("comunicacao_mensagens").delete().in("organizacao_id", [orgA, orgB]);
  // estado-base de TODO teste: contatos elegíveis e SEM habilitação (cada teste habilita o que precisa)
  for (const d of [destA, destA2, destB]) await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).eq("id", d.contatoId);
  await supabase.from("comunicacao_habilitacoes").delete().in("organizacao_id", [orgA, orgB]);
});

const msgsDoAlerta = async (alertaId) => (await supabase.from("comunicacao_mensagens").select("*").eq("alerta_id", alertaId)).data ?? [];
const statusAlerta = async (id) => (await supabase.from("comunicacao_alertas").select("status").eq("id", id).single()).data.status;
const linhaAlerta = async (id) => (await supabase.from("comunicacao_alertas").select("*").eq("id", id).single()).data;

async function novoAlerta(dataReferencia, { organizacaoId = orgA, unidadeId = unidadeA, metadados } = {}) {
  const { alerta } = await alertasRepo.criarOuEscalonarAlerta({
    organizacaoId, unidadeId, tipoAlerta: TIPO, dataReferencia, destinatarioPerfilId: null,
    severidade: SEVERIDADE.ATENCAO, motivo: "2 dia(s) pendente(s)", metadados: metadados ?? { unidade_nome: "Unidade Atômica A1", empresa_nome: "Empresa Teste" },
  });
  return alerta;
}
// O destinatário NÃO é parâmetro: o banco o lê da habilitação da organização do alerta.
const paramsAgendar = (alerta, extra = {}) => ({
  alertaId: alerta.id, tipo: TIPO, conteudo: "aviso",
  idempotencyKey: `wa:alerta:${alerta.id}:v1`, disponivelEm: new Date(Date.now() + HORA), expiraEm: new Date(Date.now() + 25 * HORA), ...extra,
});

// --- injeção de falha (TEST only, escopada à organização do teste) ---
const NOME_TRIGGER = "trg_teste_falha_agendamento_atomico";
function injetarFalha(organizacaoId) {
  const r = executarSqlNoBancoDeTeste(`
    create or replace function comunicacao_teste_falha_agendamento() returns trigger language plpgsql as $f$
    begin raise exception 'FALHA INJETADA no meio da transacao (teste de atomicidade)'; end; $f$;
    drop trigger if exists ${NOME_TRIGGER} on comunicacao_alertas;
    create trigger ${NOME_TRIGGER} before update on comunicacao_alertas for each row
      when (old.status = 'DETECTED' and new.status = 'SCHEDULED' and old.organizacao_id = '${organizacaoId}')
      execute function comunicacao_teste_falha_agendamento();`);
  assert.ok(r.ok, `não consegui injetar a falha: ${r.stderr}`);
}
function removerFalha() {
  if (SEM_PSQL) return;
  try { executarSqlNoBancoDeTeste(`drop trigger if exists ${NOME_TRIGGER} on comunicacao_alertas; drop function if exists comunicacao_teste_falha_agendamento();`); } catch { /* best effort */ }
}

describe("agendamento ATÔMICO alerta -> mensagem (RPC comunicacao_agendar_mensagem_alerta)", { skip: PULAR_INTEGRACAO }, () => {
  beforeEach(async () => {
    if (PULAR_INTEGRACAO || !migracaoOk) return;
    await habilitarOrganizacao(orgA, destA);
  });

  test("caminho normal: cria a mensagem E move o alerta DETECTED -> SCHEDULED na mesma operação", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const alerta = await novoAlerta("2026-08-01");
    assert.equal(alerta.status, STATUS_ALERTA.DETECTED);
    const r = await filaRepo.agendarMensagemDoAlerta(paramsAgendar(alerta));
    assert.equal(r.acao, "CRIADA");
    assert.equal(await statusAlerta(alerta.id), STATUS_ALERTA.SCHEDULED);
    const msgs = await msgsDoAlerta(alerta.id);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].id, r.mensagem_id);
    assert.equal(msgs[0].status, STATUS_MENSAGEM.SCHEDULED);
    assert.equal(msgs[0].organizacao_id, orgA, "a mensagem herda a organização do ALERTA");
    assert.equal(msgs[0].unidade_id, unidadeA);
    assert.equal(msgs[0].contato_id, destA.contatoId, "o destinatário é o CONFIGURADO na habilitação");
    assert.equal(msgs[0].destinatario_perfil_id, destA.perfilId);
    assert.ok(msgs[0].expira_em, "TTL gravado");
  });

  test("IDEMPOTÊNCIA: 30 chamadas CONCORRENTES para o mesmo alerta/chave -> exatamente UMA mensagem (1 CRIADA + 29 JA_EXISTIA)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const alerta = await novoAlerta("2026-08-02");
    const resultados = await Promise.all(Array.from({ length: 30 }, () => filaRepo.agendarMensagemDoAlerta(paramsAgendar(alerta))));
    const contagem = resultados.reduce((m, r) => ({ ...m, [r.acao]: (m[r.acao] ?? 0) + 1 }), {});
    assert.deepEqual(contagem, { CRIADA: 1, JA_EXISTIA: 29 });
    assert.equal(new Set(resultados.map((r) => r.mensagem_id)).size, 1, "as chamadas devolveram mensagens diferentes");
    assert.equal((await msgsDoAlerta(alerta.id)).length, 1);
    assert.equal(await statusAlerta(alerta.id), STATUS_ALERTA.SCHEDULED);
  });

  test("o scheduler repetido 100x (sequencial) gera no máximo UMA mensagem por alerta", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const alerta = await novoAlerta("2026-08-03");
    let criadas = 0;
    for (let i = 0; i < 100; i++) {
      const r = await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z"), resolverHabilitacao: HABILITADA });
      criadas += r.agendados;
    }
    assert.equal(criadas, 1);
    assert.equal((await msgsDoAlerta(alerta.id)).length, 1);
  });

  test("a idempotency_key mantém a identidade do evento (`wa:alerta:<id>:v1`) — nunca um UUID aleatório", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const alerta = await novoAlerta("2026-08-04");
    await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z"), resolverHabilitacao: HABILITADA });
    const [m] = await msgsDoAlerta(alerta.id);
    assert.equal(m.idempotency_key, `wa:alerta:${alerta.id}:v1`);
  });

  test("CONFLITO de idempotency_key: a chave já pertence à mensagem de OUTRO alerta -> CHAVE_EM_USO, nada muda", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const a1 = await novoAlerta("2026-08-05");
    const a2 = await novoAlerta("2026-08-06");
    await filaRepo.agendarMensagemDoAlerta(paramsAgendar(a1));
    const r = await filaRepo.agendarMensagemDoAlerta(paramsAgendar(a2, { idempotencyKey: `wa:alerta:${a1.id}:v1` }));
    assert.equal(r.acao, "CHAVE_EM_USO");
    assert.equal((await msgsDoAlerta(a2.id)).length, 0, "criou mensagem para o alerta 2 com a chave do alerta 1");
    assert.equal(await statusAlerta(a2.id), STATUS_ALERTA.DETECTED, "o alerta 2 não pode virar SCHEDULED sem mensagem");
  });

  test("alerta que NÃO está DETECTED (ex.: já RESOLVED) não agenda nada; alerta inexistente idem", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const alerta = await novoAlerta("2026-08-07");
    await alertasRepo.resolverAlerta(alerta.id);
    const r = await filaRepo.agendarMensagemDoAlerta(paramsAgendar(alerta));
    assert.equal(r.acao, "ALERTA_NAO_DETECTED");
    assert.equal((await msgsDoAlerta(alerta.id)).length, 0);
    const fantasma = await filaRepo.agendarMensagemDoAlerta(paramsAgendar({ id: "00000000-0000-0000-0000-000000000000" }));
    assert.equal(fantasma.acao, "ALERTA_INEXISTENTE");
  });

  test("MUTAÇÃO: falha INJETADA entre criar a mensagem e atualizar o alerta -> ROLLBACK TOTAL (0 mensagens, alerta continua DETECTED); depois de removida a falha, o scheduler cria exatamente UMA", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    if (SEM_PSQL) return t.skip(`${SEM_PSQL}`);
    const alerta = await novoAlerta("2026-08-08");
    injetarFalha(orgA);
    try {
      await assert.rejects(
        () => agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z"), resolverHabilitacao: HABILITADA }),
        /FALHA INJETADA/,
        "a falha injetada NÃO disparou — o teste seria vazio (o trigger não pegou a transição)",
      );
      // metade da operação NÃO pode ter ficado
      assert.equal((await msgsDoAlerta(alerta.id)).length, 0, "ficou uma mensagem ÓRFÃ (o INSERT não foi desfeito)");
      assert.equal(await statusAlerta(alerta.id), STATUS_ALERTA.DETECTED, "o alerta mudou de estado apesar da falha");
    } finally {
      removerFalha();
    }
    // reexecução do scheduler: uma mensagem, alerta SCHEDULED
    const r = await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z"), resolverHabilitacao: HABILITADA });
    assert.equal(r.agendados, 1);
    assert.equal((await msgsDoAlerta(alerta.id)).length, 1);
    assert.equal(await statusAlerta(alerta.id), STATUS_ALERTA.SCHEDULED);
    for (let i = 0; i < 5; i++) await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z"), resolverHabilitacao: HABILITADA });
    assert.equal((await msgsDoAlerta(alerta.id)).length, 1, "reexecuções criaram mensagens extras");
  });

  test("MUTAÇÃO/CONTRASTE: a sequência ANTIGA (alerta SCHEDULED, depois criar a mensagem) deixa alerta ÓRFÃO quando o 2º passo falha; a RPC atômica não deixa nada", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const CONTATO_INEXISTENTE = "00000000-0000-0000-0000-00000000dead"; // o INSERT da mensagem viola a FK
    // 1) o fluxo antigo, reproduzido: dois passos independentes
    const antigo = await novoAlerta("2026-08-20");
    await alertasRepo.atualizarStatusAlerta(antigo.id, STATUS_ALERTA.SCHEDULED);
    await assert.rejects(() => agendarMensagemT({ ...paramsAgendar(antigo), organizacaoId: orgA, unidadeId: unidadeA, contatoId: CONTATO_INEXISTENTE }));
    assert.equal(await statusAlerta(antigo.id), STATUS_ALERTA.SCHEDULED, "pré-condição do contraste: o fluxo antigo deixa o alerta SCHEDULED");
    assert.equal((await msgsDoAlerta(antigo.id)).length, 0, "...sem NENHUMA mensagem (órfão)");

    // 2) a operação atômica com o MESMO defeito: nada muda
    const novo = await novoAlerta("2026-08-21");
    // defeito no INSERT da mensagem (max_tentativas = 0 viola o CHECK): a RPC inteira desfaz
    await assert.rejects(() => filaRepo.agendarMensagemDoAlerta(paramsAgendar(novo, { maxTentativas: 0 })));
    assert.equal(await statusAlerta(novo.id), STATUS_ALERTA.DETECTED, "a RPC atômica deixou o alerta pela metade");
    assert.equal((await msgsDoAlerta(novo.id)).length, 0);
  });

  test("REPARO: alerta ainda DETECTED com a mensagem JÁ existente (resíduo do fluxo antigo, não atômico) é reparado para SCHEDULED sem duplicar", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const alerta = await novoAlerta("2026-08-09");
    const antiga = await agendarMensagemT({ ...paramsAgendar(alerta), organizacaoId: orgA, unidadeId: unidadeA, contatoId: destA.contatoId, destinatarioPerfilId: destA.perfilId });
    assert.equal(await statusAlerta(alerta.id), STATUS_ALERTA.DETECTED, "pré-condição: o insert cru não move o alerta");
    const r = await filaRepo.agendarMensagemDoAlerta(paramsAgendar(alerta));
    assert.equal(r.acao, "JA_EXISTIA");
    assert.equal(r.mensagem_id, antiga.id);
    assert.equal(await statusAlerta(alerta.id), STATUS_ALERTA.SCHEDULED);
    assert.equal((await msgsDoAlerta(alerta.id)).length, 1);
  });
});

describe("DESTINATÁRIO EXPLÍCITO — o agendamento nunca escolhe \"o primeiro contato\"", { skip: PULAR_INTEGRACAO }, () => {
  test("organização SEM habilitação (nenhuma linha) -> NAO_HABILITADA: nenhuma mensagem, o alerta segue DETECTED, mesmo com contatos elegíveis existindo", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const alerta = await novoAlerta("2026-08-30");
    const r = await filaRepo.agendarMensagemDoAlerta(paramsAgendar(alerta));
    assert.equal(r.acao, "NAO_HABILITADA");
    assert.equal((await msgsDoAlerta(alerta.id)).length, 0);
    assert.equal(await statusAlerta(alerta.id), STATUS_ALERTA.DETECTED);
  });

  test("DOIS contatos elegíveis, NENHUM explicitamente selecionado (habilitada=false, sem destinatário) -> nada é escolhido: 0 mensagens", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await supabase.from("comunicacao_habilitacoes").insert({ organizacao_id: orgA, habilitado: false, tipos_permitidos: [TIPO], timezone: "America/Fortaleza" });
    const alerta = await novoAlerta("2026-08-31");
    assert.equal((await filaRepo.agendarMensagemDoAlerta(paramsAgendar(alerta))).acao, "NAO_HABILITADA");
    const r = await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z") });
    assert.equal(r.agendados, 0);
    assert.equal((await msgsDoAlerta(alerta.id)).length, 0, "algum contato foi escolhido sem seleção explícita");
  });

  test("destinatário EXPLICITAMENTE selecionado (o SEGUNDO elegível) -> a mensagem vai SÓ para ele, mesmo com o outro elegível e mais antigo", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await habilitarOrganizacao(orgA, destA2);
    const alerta = await novoAlerta("2026-09-01");
    const r = await filaRepo.agendarMensagemDoAlerta(paramsAgendar(alerta));
    assert.equal(r.acao, "CRIADA");
    const [m] = await msgsDoAlerta(alerta.id);
    assert.equal(m.contato_id, destA2.contatoId);
    assert.equal(m.destinatario_perfil_id, destA2.perfilId);
    assert.notEqual(m.contato_id, destA.contatoId);
  });

  for (const [nome, preparar, restaurar] of [
    ["SEM consentimento", (d) => supabase.from("contatos_whatsapp").update({ consentimento: false }).eq("id", d.contatoId), null],
    ["NÃO verificado", (d) => supabase.from("contatos_whatsapp").update({ verificado: false }).eq("id", d.contatoId), null],
    ["em OPT-OUT", (d) => supabase.from("contatos_whatsapp").update({ opt_out: true }).eq("id", d.contatoId), null],
    // migration 091: o responsável é da EMPRESA — desativá-lo ou não validar o WhatsApp veta; o PERFIL/acesso do usuário não decide nada
    ["com o RESPONSÁVEL da empresa INATIVO", (d) => supabase.from("comunicacao_contatos_empresa").update({ ativo: false }).eq("id", d.contatoEmpresaId), (d) => supabase.from("comunicacao_contatos_empresa").update({ ativo: true }).eq("id", d.contatoEmpresaId)],
    ["com o WhatsApp do responsável NÃO VALIDADO", (d) => supabase.from("comunicacao_contatos_empresa").update({ whatsapp_status: "AGUARDANDO_VALIDACAO" }).eq("id", d.contatoEmpresaId), (d) => supabase.from("comunicacao_contatos_empresa").update({ whatsapp_status: "VALIDADO" }).eq("id", d.contatoEmpresaId)],
  ]) {
    test(`destinatário configurado ${nome} -> DESTINATARIO_INELEGIVEL: nenhuma mensagem e o alerta segue DETECTED`, async (t) => {
      if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
      await habilitarOrganizacao(orgA, destA);
      const alerta = await novoAlerta("2026-09-02");
      await preparar(destA);
      try {
        const r = await filaRepo.agendarMensagemDoAlerta(paramsAgendar(alerta));
        assert.equal(r.acao, "DESTINATARIO_INELEGIVEL", JSON.stringify(r));
        assert.equal((await msgsDoAlerta(alerta.id)).length, 0);
        assert.equal(await statusAlerta(alerta.id), STATUS_ALERTA.DETECTED);
        const ciclo = await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z") });
        assert.equal(ciclo.agendados, 0);
        assert.ok(ciclo.destinatarioInelegivel >= 1, JSON.stringify(ciclo));
      } finally {
        if (restaurar) await restaurar(destA);
      }
    });
  }

  for (const [nome, preparar, restaurar] of [
    ["perfil (usuário) INATIVO", (d) => supabase.from("perfis_operacionais").update({ ativo: false }).eq("id", d.perfilId), (d) => supabase.from("perfis_operacionais").update({ ativo: true }).eq("id", d.perfilId)],
    ["acesso do usuário à organização DESATIVADO", (d) => supabase.from("usuarios_organizacoes").update({ ativo: false }).eq("perfil_id", d.perfilId), (d) => supabase.from("usuarios_organizacoes").update({ ativo: true }).eq("perfil_id", d.perfilId)],
  ]) {
    test(`(091) ${nome}: NÃO altera o responsável — o agendamento continua indo ao responsável da empresa`, async (t) => {
      if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
      await habilitarOrganizacao(orgA, destA);
      const alerta = await novoAlerta("2026-09-02");
      await preparar(destA);
      try {
        const r = await filaRepo.agendarMensagemDoAlerta(paramsAgendar(alerta));
        assert.equal(r.acao, "CRIADA", JSON.stringify(r));
        const [m] = await msgsDoAlerta(alerta.id);
        assert.equal(m.contato_id, destA.contatoId);
        assert.equal(m.contato_empresa_id, destA.contatoEmpresaId);
      } finally { await restaurar(destA); }
    });
  }

  test("CROSS-ORG: o contato/perfil da organização B NUNCA é usado pela A — nem por configuração (recusada) nem pelo agendamento", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const recusa = await supabase.from("comunicacao_habilitacoes").insert({ organizacao_id: orgA, habilitado: true, tipos_permitidos: [TIPO], timezone: "America/Fortaleza", destinatario_contato_id: destB.contatoId, destinatario_perfil_id: destB.perfilId });
    assert.ok(recusa.error, "o banco aceitou o destinatário da organização B na A");
    await habilitarOrganizacao(orgB, destB);
    await habilitarOrganizacao(orgA, destA);
    const alertaA = await novoAlerta("2026-09-03");
    const alertaB = await novoAlerta("2026-09-03", { organizacaoId: orgB, unidadeId: unidadeB });
    assert.equal((await filaRepo.agendarMensagemDoAlerta(paramsAgendar(alertaA))).acao, "CRIADA");
    assert.equal((await filaRepo.agendarMensagemDoAlerta(paramsAgendar(alertaB))).acao, "CRIADA");
    assert.equal((await msgsDoAlerta(alertaA.id))[0].contato_id, destA.contatoId);
    assert.equal((await msgsDoAlerta(alertaB.id))[0].contato_id, destB.contatoId);
  });

  test("tipo fora de tipos_permitidos -> TIPO_NAO_PERMITIDO (o banco decide, não o chamador)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await habilitarOrganizacao(orgA, destA, { tipos_permitidos: ["outro_tipo"] });
    const alerta = await novoAlerta("2026-09-04");
    assert.equal((await filaRepo.agendarMensagemDoAlerta(paramsAgendar(alerta))).acao, "TIPO_NAO_PERMITIDO");
    assert.equal((await msgsDoAlerta(alerta.id)).length, 0);
  });
});

describe("agendarEnviosPendentes — habilitação PERSISTIDA, horário real e TTL", { skip: PULAR_INTEGRACAO }, () => {
  const habilitar = (organizacaoId, extra = {}) => habilitarOrganizacao(organizacaoId, organizacaoId === orgB ? destB : destA, extra);
  const desabilitar = (organizacaoId) => supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", organizacaoId);

  test("organização SEM habilitação: nenhum agendamento — o alerta continua DETECTED, sem mensagem órfã (fail-closed)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const alerta = await novoAlerta("2026-08-10");
    await desabilitar(orgA);
    const r = await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z") }); // habilitação REAL (sem injeção)
    assert.equal(r.agendados, 0);
    assert.ok(r.semHabilitacao >= 1);
    assert.equal((await msgsDoAlerta(alerta.id)).length, 0);
    assert.equal(await statusAlerta(alerta.id), STATUS_ALERTA.DETECTED);
  });

  test("habilitação real + sexta 18:30 locais: mensagem SCHEDULED no próximo horário permitido (sábado 08:00 local + jitter), com TTL = horário + 24h", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await habilitar(orgA);
    const alerta = await novoAlerta("2026-08-11");
    const sexta1830 = new Date("2026-09-18T21:30:00Z");
    const r = await agendarEnviosPendentes({ organizacaoId: orgA, agora: sexta1830 });
    assert.ok(r.agendados >= 1, JSON.stringify(r));
    const [m] = await msgsDoAlerta(alerta.id);
    const abertura = new Date("2026-09-19T11:00:00Z").getTime(); // sábado 08:00 em Fortaleza (janela global sab 08–13)
    const quando = new Date(m.disponivel_em).getTime();
    assert.ok(quando >= abertura && quando < abertura + 30 * MIN, `disponivel_em=${m.disponivel_em}`);
    assert.equal(new Date(m.expira_em).getTime() - quando, 24 * HORA, "expira_em = disponivel_em + ttl_horas(24h)");
    assert.equal(await statusAlerta(alerta.id), STATUS_ALERTA.SCHEDULED);
    await desabilitar(orgA);
  });

  test("o horário é DETERMINÍSTICO: dois alertas com ids diferentes espalham; o MESMO alerta reagendado nunca muda de horário", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await habilitar(orgA);
    const alertas = [];
    for (let i = 0; i < 6; i++) alertas.push(await novoAlerta(`2026-07-0${i + 1}`));
    const sexta1830 = new Date("2026-09-18T21:30:00Z");
    await agendarEnviosPendentes({ organizacaoId: orgA, agora: sexta1830 });
    const primeiro = new Map();
    for (const a of alertas) primeiro.set(a.id, (await msgsDoAlerta(a.id))[0].disponivel_em);
    assert.ok(new Set(primeiro.values()).size >= 4, "os envios não foram espalhados (jitter)");
    await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date(sexta1830.getTime() + 5 * MIN) });
    for (const a of alertas) assert.equal((await msgsDoAlerta(a.id))[0].disponivel_em, primeiro.get(a.id), "o horário mudou a cada execução");
    await desabilitar(orgA);
  });

  test("tipo NÃO listado, empresa desabilitada, ou registro de OUTRA organização: nenhum agendamento", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await habilitar(orgA, { tipos_permitidos: ["outro_tipo"] });
    const alerta = await novoAlerta("2026-08-12");
    assert.equal((await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z") })).agendados, 0);
    await habilitar(orgA, { habilitado: false, tipos_permitidos: [TIPO] });
    assert.equal((await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z") })).agendados, 0);
    // habilitar a B não habilita a A (e o alerta de A segue sem mensagem)
    await desabilitar(orgA);
    await habilitar(orgB);
    assert.equal((await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z") })).agendados, 0);
    assert.equal((await msgsDoAlerta(alerta.id)).length, 0);
    await desabilitar(orgB);
  });

  test("empresa PAUSADA: agenda no fim da pausa (`pausado_ate`), nunca antes", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const fimDaPausa = new Date("2026-09-19T15:00:00Z"); // sábado 12:00 local, dentro da janela 08–13
    await habilitar(orgA, { pausado_ate: fimDaPausa.toISOString(), pausado_motivo: "manutenção" });
    const alerta = await novoAlerta("2026-08-13");
    const r = await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z") });
    assert.ok(r.agendados >= 1, JSON.stringify(r));
    const [m] = await msgsDoAlerta(alerta.id);
    assert.equal(new Date(m.disponivel_em).getTime(), fimDaPausa.getTime());
    await desabilitar(orgA);
  });

  test("timezone/janela inválidos (resolvedor devolve config inválida): NÃO agenda (configInvalida) e nunca assume UTC", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const alerta = await novoAlerta("2026-08-14");
    const invalida = async () => ({ ...(await HABILITADA()), timezone: "Mars/Olympus", configHorarioValida: false });
    const r = await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z"), resolverHabilitacao: invalida });
    assert.equal(r.agendados, 0);
    assert.ok(r.configInvalida >= 1);
    assert.equal((await msgsDoAlerta(alerta.id)).length, 0);
    assert.equal(await statusAlerta(alerta.id), STATUS_ALERTA.DETECTED);
  });

  test("o texto da mensagem usa o nome da unidade gravado no alerta (metadados)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await habilitar(orgA);
    const alerta = await novoAlerta("2026-08-15", { metadados: { unidade_nome: "Loja Centro", empresa_nome: "Rede Exemplo" } });
    await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z") });
    const [m] = await msgsDoAlerta(alerta.id);
    assert.match(m.conteudo, /Loja Centro/);
  });

  test("CROSS-ORG: o agendamento de A não toca alertas de B (escopo por organizacaoId)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    await habilitar(orgA);
    await habilitar(orgB);
    const alertaB = await novoAlerta("2026-08-16", { organizacaoId: orgB, unidadeId: unidadeB });
    await novoAlerta("2026-08-17");
    await agendarEnviosPendentes({ organizacaoId: orgA, agora: new Date("2026-09-16T13:00:00Z") });
    assert.equal((await msgsDoAlerta(alertaB.id)).length, 0, "o agendamento escopado a A criou mensagem para B");
    assert.equal(await statusAlerta(alertaB.id), STATUS_ALERTA.DETECTED);
    assert.equal((await linhaAlerta(alertaB.id)).organizacao_id, orgB);
  });
});
