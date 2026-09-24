// H.4-B.5 — TESTE CONTROLADO de comunicação (Painel Administrativo) contra o banco de TESTE, com um WhatsAppService FALSO (nenhum WhatsApp real).
// Cobre: autorização/ator, confirmação, todos os gates (fail-closed), 1 provider call, duplo clique, concorrência (20×), limite, SENT→DELIVERED→READ via
// receipts (095), auditoria, não-criação/alteração de alerta, telefone mascarado, e o bug "salvar configuração desabilita a empresa".
// PULA (não falha) sem credencial de banco descartável / sem as migrations 082-088-092-095.
// Rodar: node --env-file=.env --env-file=.env.test-integracao --test --test-concurrency=1 test/administrativo-comunicacao-teste-integracao.test.js
import { test, describe, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, criarDestinatario, apagarDestinatario, habilitarOrganizacao,
  migracao082Aplicada, migracao088Aplicada, migracao092Aplicada,
} from "./helpers/comunicacao-fixtures.js";
import * as alertasRepo from "../src/modules/comunicacao/comunicacao.alertas.repo.js";
import { criarRepoSupabase } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";
import { TIPOS_ALERTA, SEVERIDADE } from "../src/modules/comunicacao/comunicacao.constants.js";
import * as teste from "../src/modules/administrativo/administrativo.comunicacao.teste.js";
import * as central from "../src/modules/administrativo/administrativo.comunicacao.central.js";
import * as servico from "../src/modules/administrativo/administrativo.comunicacao.service.js";
import { textoDoTeste } from "../src/modules/comunicacao/comunicacao.teste.js";

const PULAR = motivoPularIntegracao();
const tag = `comteste${Date.now()}`;
const uuid = () => crypto.randomUUID();
let migracaoOk = true;
let orgA = null, orgB = null, uniA = null, uniB = null, dest = null, destB = null, telefone = null;
let autor = null;
let seq = 0;
const gatewayRepo = criarRepoSupabase();

const TEXTO_ESPERADO = (nome) => `Mensagem de teste — Crescer com Delivery.\n\nEste é um teste de comunicação da unidade ${nome}.\n\nNenhuma ação é necessária.\n\n— Crescer com Delivery`;

function servicoFalso(impl) {
  const enviarTexto = mock.fn(impl ?? (async () => ({ providerMessageId: `3EB0TESTE${Date.now()}${++seq}`, enviadoEm: new Date().toISOString() })));
  return { enviarTexto, identidadeConfirmada: async () => true };
}
const envOk = () => ({ COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: telefone, WHATSAPP_GATEWAY_URL: "http://gateway.invalid", WHATSAPP_GATEWAY_SECRET: "x" });
const depsBase = (extra = {}) => ({
  env: envOk(), estadoGateway: { estado: "conectado" }, identidadeConfirmada: true, lerModo: async () => "DISABLED", whatsAppService: servicoFalso(), ...extra,
});
const req = (extra = {}) => ({ organizacaoId: orgA, unidadeId: uniA, testeId: uuid(), confirmacaoExplicita: true, ...extra });
const linha = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("id", id).single()).data;
const acoesDe = async (id) => ((await supabase.from("plataforma_auditoria").select("acao, detalhes, ator_id, ator_email").eq("entidade_id", id)).data ?? []);
const rejeita = (p, status, codigo) => assert.rejects(p, (e) => { assert.equal(e.statusCode ?? e.status, status); if (codigo) assert.equal(e.details?.codigo ?? e.detalhes?.codigo, codigo); return true; });

before(async () => {
  if (PULAR) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada()) && (await migracao092Aplicada());
  if (!migracaoOk) return;
  orgA = await criarOrganizacao("TESTE comunicacao-teste A — descartável");
  orgB = await criarOrganizacao("TESTE comunicacao-teste B — descartável");
  uniA = await criarUnidade(orgA, "Unidade Matriz Teste");
  uniB = await criarUnidade(orgB, "Unidade B1");
  dest = await criarDestinatario({ organizacaoId: orgA, unidadeId: uniA, tag, sufixo: "a" });
  destB = await criarDestinatario({ organizacaoId: orgB, unidadeId: uniB, tag, sufixo: "b" });
  telefone = (await supabase.from("contatos_whatsapp").select("telefone_e164").eq("id", dest.contatoId).single()).data.telefone_e164;
  autor = { contaId: dest.contaId, perfilId: dest.perfilId, nome: "Operador Teste", email: `${tag}@example.com` };
});
after(async () => {
  await supabase.from("comunicacao_mensagens").delete().in("organizacao_id", [orgA, orgB].filter(Boolean));
  await apagarOrganizacao(orgA); await apagarOrganizacao(orgB);
  await apagarDestinatario(dest); await apagarDestinatario(destB);
});
beforeEach(async () => {
  if (PULAR || !migracaoOk) return;
  await supabase.from("comunicacao_mensagens").delete().in("organizacao_id", [orgA, orgB]);
  await supabase.from("comunicacao_alertas").delete().in("organizacao_id", [orgA, orgB]);
  await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).eq("id", dest.contatoId);
  await habilitarOrganizacao(orgA, dest, { habilitado: false });
});
const pular = (t) => { if (!migracaoOk) { t.skip("migrations 082-088-092 não aplicadas — pulando."); return true; } return false; };

describe("TESTE CONTROLADO — autorização, confirmação e gates (fail-closed: provider = 0)", { skip: PULAR }, () => {
  test("sem operador identificado => 401; sem confirmação explícita => 400; ids inválidos => 400", async (t) => {
    if (pular(t)) return;
    const d = depsBase();
    await rejeita(teste.enviarTeste(req(), null, d), 401);
    await rejeita(teste.enviarTeste(req(), { contaId: null }, d), 401);
    await rejeita(teste.enviarTeste(req({ confirmacaoExplicita: undefined }), autor, d), 400, "CONFIRMACAO_OBRIGATORIA");
    await rejeita(teste.enviarTeste(req({ confirmacaoExplicita: "true" }), autor, d), 400, "CONFIRMACAO_OBRIGATORIA");
    await rejeita(teste.enviarTeste(req({ testeId: "nao-e-uuid" }), autor, d), 400);
    await rejeita(teste.enviarTeste(req({ unidadeId: undefined }), autor, d), 400);
    assert.equal(d.whatsAppService.enviarTexto.mock.callCount(), 0);
  });

  test("modo NORMAL (ou qualquer valor diferente de DISABLED) bloqueia o teste", async (t) => {
    if (pular(t)) return;
    for (const modo of ["NORMAL", "REACTIVE_ONLY", "qualquer"]) {
      const d = depsBase({ lerModo: async () => modo });
      await rejeita(teste.enviarTeste(req(), autor, d), 409, "MODO_NAO_DISABLED");
      assert.equal(d.whatsAppService.enviarTexto.mock.callCount(), 0, modo);
    }
    assert.equal((await supabase.from("comunicacao_mensagens").select("id").eq("tipo", "teste_comunicacao").in("organizacao_id", [orgA])).data.length, 0, "nenhuma mensagem criada");
  });

  test("gateway offline / instável / desconhecido bloqueia; WhatsApp não configurado bloqueia", async (t) => {
    if (pular(t)) return;
    for (const estado of ["desconectado", "instavel", "desconhecido"]) {
      const d = depsBase({ estadoGateway: { estado } });
      await rejeita(teste.enviarTeste(req(), autor, d), 409, "GATEWAY_INDISPONIVEL");
      assert.equal(d.whatsAppService.enviarTexto.mock.callCount(), 0);
    }
    await rejeita(teste.enviarTeste(req(), autor, depsBase({ whatsAppService: null })), 409, "WHATSAPP_NAO_CONFIGURADO");
  });

  test("destinatário: sem consentimento / não verificado / opt-out / sem destinatário bloqueiam", async (t) => {
    if (pular(t)) return;
    const casos = [[{ consentimento: false }, "SEM_CONSENTIMENTO"], [{ verificado: false }, "NAO_VERIFICADO"], [{ opt_out: true }, "OPT_OUT"]];
    for (const [campos, codigo] of casos) {
      await supabase.from("contatos_whatsapp").update(campos).eq("id", dest.contatoId);
      const d = depsBase();
      await rejeita(teste.enviarTeste(req(), autor, d), 409, codigo);
      assert.equal(d.whatsAppService.enviarTexto.mock.callCount(), 0, codigo);
      await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).eq("id", dest.contatoId);
    }
    await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", orgA);
    await rejeita(teste.enviarTeste(req(), autor, depsBase()), 409, "SEM_DESTINATARIO");
  });

  test("piloto: fora da allowlist / piloto inativo / allowlist vazia ou malformada bloqueiam", async (t) => {
    if (pular(t)) return;
    const variacoes = [
      { COMUNICACAO_PILOTO_TELEFONES_E164: "+5511900000001" },
      { COMUNICACAO_PILOTO_ENABLED: "false" },
      { COMUNICACAO_PILOTO_TELEFONES_E164: "" },
      { COMUNICACAO_PILOTO_TELEFONES_E164: "telefone-invalido" },
    ];
    for (const v of variacoes) {
      const d = depsBase({ env: { ...envOk(), ...v } });
      await rejeita(teste.enviarTeste(req(), autor, d), 409, "FORA_DA_ALLOWLIST");
      assert.equal(d.whatsAppService.enviarTexto.mock.callCount(), 0, JSON.stringify(v));
    }
  });

  test("unidade de OUTRA empresa ou inexistente bloqueia; empresa inexistente => 404", async (t) => {
    if (pular(t)) return;
    const d = depsBase();
    await rejeita(teste.enviarTeste(req({ unidadeId: uniB }), autor, d), 409, "UNIDADE_INVALIDA");
    await rejeita(teste.enviarTeste(req({ unidadeId: uuid() }), autor, d), 409, "UNIDADE_INVALIDA");
    await rejeita(teste.enviarTeste(req({ organizacaoId: uuid() }), autor, d), 404);
    assert.equal(d.whatsAppService.enviarTexto.mock.callCount(), 0);
  });
});

describe("TESTE CONTROLADO — envio (1 provider call), idempotência, concorrência e limite", { skip: PULAR }, () => {
  test("DISABLED permite: 1 provider call com o texto EXATO, mensagem PRÓPRIA (sem alerta, tipo/propósito de teste), SENT e attempt 1", async (t) => {
    if (pular(t)) return;
    const d = depsBase();
    const r = await teste.enviarTeste(req(), autor, d);
    assert.equal(r.resultado, "ENVIADO"); assert.equal(r.jaExistia, false);
    assert.equal(d.whatsAppService.enviarTexto.mock.callCount(), 1);
    const chamada = d.whatsAppService.enviarTexto.mock.calls[0].arguments[0];
    assert.equal(chamada.telefoneE164, telefone);
    assert.equal(chamada.texto, TEXTO_ESPERADO("Unidade Matriz Teste"));
    assert.equal(chamada.texto, textoDoTeste("Unidade Matriz Teste"));
    assert.match(chamada.idempotencyKey, /^wa:teste:[0-9a-f-]{36}:v1$/);
    const m = await linha(r.mensagemId);
    assert.equal(m.status, "SENT"); assert.equal(m.tentativas, 1); assert.equal(m.max_tentativas, 1);
    assert.equal(m.alerta_id, null); assert.equal(m.tipo, "teste_comunicacao");
    assert.equal(m.metadados.proposito, "teste"); assert.equal(m.metadados.origem, "teste_painel");
    assert.ok(m.provider_message_id && m.enviado_em);
    assert.equal(m.direcao, "saida"); assert.equal(m.unidade_id, uniA); assert.equal(m.contato_id, dest.contatoId);
  });

  test("duplo clique (mesmo testeId, sequencial): 1 provider call; a 2ª devolve a mensagem existente sem gates nem envio", async (t) => {
    if (pular(t)) return;
    const d = depsBase(); const pedido = req();
    const a = await teste.enviarTeste(pedido, autor, d);
    const b = await teste.enviarTeste(pedido, autor, d);
    assert.equal(d.whatsAppService.enviarTexto.mock.callCount(), 1);
    assert.equal(b.jaExistia, true); assert.equal(b.mensagemId, a.mensagemId);
    assert.equal((await supabase.from("comunicacao_mensagens").select("id").eq("tipo", "teste_comunicacao").eq("organizacao_id", orgA)).data.length, 1);
  });

  test("CONCORRÊNCIA: 20 chamadas simultâneas do MESMO teste => exatamente 1 provider call e 1 mensagem", async (t) => {
    if (pular(t)) return;
    const d = depsBase(); const pedido = req();
    const rs = await Promise.all(Array.from({ length: 20 }, () => teste.enviarTeste(pedido, autor, d)));
    assert.equal(d.whatsAppService.enviarTexto.mock.callCount(), 1, "provider chamado mais de uma vez");
    assert.equal(rs.filter((r) => r.jaExistia === false).length, 1);
    assert.equal(new Set(rs.map((r) => r.mensagemId)).size, 1);
    assert.equal((await supabase.from("comunicacao_mensagens").select("id").eq("tipo", "teste_comunicacao").eq("organizacao_id", orgA)).data.length, 1);
  });

  test("LIMITE (1): 6 testes DIFERENTES simultâneos => 1 provider call; os demais recusados/cancelados ANTES do envio", async (t) => {
    if (pular(t)) return;
    const d = depsBase();
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => teste.enviarTeste(req(), autor, d)));
    assert.equal(d.whatsAppService.enviarTexto.mock.callCount(), 1);
    assert.equal(rs.filter((r) => r.status === "fulfilled" && r.value.resultado === "ENVIADO").length, 1);
    for (const r of rs.filter((x) => x.status === "rejected")) assert.equal(r.reason.details?.codigo ?? r.reason.detalhes?.codigo, "LIMITE_TESTE_ATINGIDO");
    const vivas = (await supabase.from("comunicacao_mensagens").select("status").eq("tipo", "teste_comunicacao").eq("organizacao_id", orgA).not("status", "in", "(CANCELLED,BLOCKED)")).data;
    assert.equal(vivas.length, 1, "só UMA mensagem de teste permanece contabilizada");
  });

  test("2º teste (id novo) depois do 1º => LIMITE_TESTE_ATINGIDO, sem provider", async (t) => {
    if (pular(t)) return;
    const d = depsBase();
    await teste.enviarTeste(req(), autor, d);
    await rejeita(teste.enviarTeste(req(), autor, d), 409, "LIMITE_TESTE_ATINGIDO");
    assert.equal(d.whatsAppService.enviarTexto.mock.callCount(), 1);
  });

  test("falha do provider ANTES do envio (destinatário inexistente/não verificado/consulta falhou): FAILED, 1 chamada, NUNCA retry nem reenvio", async (t) => {
    if (pular(t)) return;
    const codigos = [
      ["WHATSAPP_GATEWAY_RECIPIENT_NOT_ON_WHATSAPP", { preEnvio: true, permanente: true }],
      ["WHATSAPP_GATEWAY_RECIPIENT_UNVERIFIED", { preEnvio: true, permanente: true }],
      ["WHATSAPP_GATEWAY_RECIPIENT_LOOKUP_FAILED", { preEnvio: true }],   // RETRYAVEL na classificação — mas o teste NUNCA reenvia
    ];
    for (const [codigo, marcas] of codigos) {
      await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
      const svc = servicoFalso(async () => { throw Object.assign(new Error(`BAILEYS_GATEWAY_HTTP: ${codigo}`), marcas); });
      const d = depsBase({ whatsAppService: svc });
      const pedido = req();
      const r = await teste.enviarTeste(pedido, autor, d);
      assert.equal(r.resultado, "FALHOU", codigo);
      const m = await linha(r.mensagemId);
      assert.equal(m.status, "FAILED", codigo); assert.equal(m.tentativas, 1);
      const de_novo = await teste.enviarTeste(pedido, autor, d);
      assert.equal(de_novo.jaExistia, true);
      assert.equal(svc.enviarTexto.mock.callCount(), 1, "sem retry");
      const acoes = (await acoesDe(r.mensagemId)).map((a) => a.acao);
      assert.ok(acoes.includes("COMUNICACAO_TESTE_INICIADO") && acoes.includes("COMUNICACAO_TESTE_FALHOU"), codigo);
    }
  });

  test("resultado INCERTO (timeout/erro de transporte): DELIVERY_UNKNOWN, sem retry, sem reenvio", async (t) => {
    if (pular(t)) return;
    const svc = servicoFalso(async () => { throw new Error("BAILEYS_GATEWAY_TIMEOUT: sem resposta"); });
    const d = depsBase({ whatsAppService: svc }); const pedido = req();
    const r = await teste.enviarTeste(pedido, autor, d);
    assert.equal(r.resultado, "ENTREGA_INCERTA");
    assert.equal((await linha(r.mensagemId)).status, "DELIVERY_UNKNOWN");
    await teste.enviarTeste(pedido, autor, d);
    assert.equal(svc.enviarTexto.mock.callCount(), 1);
  });

  test("a mensagem de teste NÃO é reivindicável pelo worker (PROCESSING com lease + TTL): o claim global não a devolve", async (t) => {
    if (pular(t)) return;
    // cria a mensagem de teste MAS trava antes do envio: o provider não responde até liberarmos
    let libera; const preso = new Promise((r) => { libera = r; });
    const svc = servicoFalso(async () => { await preso; return { providerMessageId: `3EB0LIVRE${Date.now()}` }; });
    const d = depsBase({ whatsAppService: svc });
    const emVoo = teste.enviarTeste(req(), autor, d);
    await new Promise((r) => setTimeout(r, 400));
    const { data } = await supabase.rpc("comunicacao_claim_mensagens", { p_limite: 50, p_worker: "worker-hostil", p_lease_segundos: 30 });
    assert.equal((data ?? []).filter((m) => m.tipo === "teste_comunicacao").length, 0, "o worker NÃO pode reivindicar a mensagem de teste");
    libera(); await emVoo;
  });
});

describe("TESTE CONTROLADO — nenhum alerta é criado/alterado; mensagem histórica intacta; telefone mascarado", { skip: PULAR }, () => {
  test("o teste não cria alerta D-1 nem altera um alerta histórico (status e updated_at idênticos)", async (t) => {
    if (pular(t)) return;
    const { alerta } = await alertasRepo.criarOuEscalonarAlerta({
      organizacaoId: orgA, unidadeId: uniA, tipoAlerta: TIPOS_ALERTA.DASHBOARD_IFOOD_D1, dataReferencia: "2026-09-22", destinatarioPerfilId: null,
      severidade: SEVERIDADE.ATENCAO, motivo: "historico", metadados: {},
    });
    await supabase.from("comunicacao_alertas").update({ status: "SENT" }).eq("id", alerta.id);
    const historica = (await supabase.from("comunicacao_mensagens").insert({
      organizacao_id: orgA, unidade_id: uniA, alerta_id: alerta.id, contato_id: dest.contatoId, tipo: TIPOS_ALERTA.DASHBOARD_IFOOD_D1, conteudo: "historica", idempotency_key: `wa:alerta:${alerta.id}:v1`,
      status: "SENT", disponivel_em: new Date().toISOString(), enviado_em: new Date().toISOString(), provider_message_id: `3EB0HIST${Date.now()}`, tentativas: 1,
    }).select("*").single()).data;
    const antesAlerta = (await supabase.from("comunicacao_alertas").select("*").eq("id", alerta.id).single()).data;
    const totalAlertas = (await supabase.from("comunicacao_alertas").select("id").eq("organizacao_id", orgA)).data.length;

    const r = await teste.enviarTeste(req(), autor, depsBase());
    assert.equal(r.resultado, "ENVIADO");
    const testeMsg = await linha(r.mensagemId);
    // receipts do TESTE não mexem no alerta histórico
    await gatewayRepo.registrarStatusProvider(orgA, { providerMessageId: testeMsg.provider_message_id, status: "DELIVERED" });
    await gatewayRepo.registrarStatusProvider(orgA, { providerMessageId: testeMsg.provider_message_id, status: "READ" });

    const depoisAlerta = (await supabase.from("comunicacao_alertas").select("*").eq("id", alerta.id).single()).data;
    assert.deepEqual(depoisAlerta, antesAlerta, "alerta histórico intacto");
    assert.equal((await supabase.from("comunicacao_alertas").select("id").eq("organizacao_id", orgA)).data.length, totalAlertas, "nenhum alerta novo");
    const histDepois = await linha(historica.id);
    assert.equal(histDepois.status, "SENT"); assert.equal(histDepois.updated_at, historica.updated_at, "mensagem histórica intacta");
  });

  test("preparo do modal: telefone SEM o número completo, preview EXATO, bloqueios explicados, limite", async (t) => {
    if (pular(t)) return;
    const p = await teste.preparoTeste({ organizacaoId: orgA }, depsBase());
    assert.equal(p.podeEnviar, true); assert.deepEqual(p.bloqueios, []);
    assert.equal(p.unidade.unidadeId, uniA, "a unidade Matriz é a padrão");
    assert.equal(p.previewTexto, TEXTO_ESPERADO("Unidade Matriz Teste"));
    assert.match(p.contato.telefoneMascarado, /^\*{8}\d{2}$/);
    assert.deepEqual(p.limite, { usados: 0, maximo: 1 });
    assert.equal(JSON.stringify(p).includes(telefone), false, "telefone completo vazou");
    assert.equal(JSON.stringify(p).includes(telefone.slice(-8)), false, "os 8 últimos dígitos vazaram");
    const bloqueado = await teste.preparoTeste({ organizacaoId: orgA }, depsBase({ lerModo: async () => "NORMAL", estadoGateway: { estado: "desconectado" } }));
    assert.equal(bloqueado.podeEnviar, false);
    assert.deepEqual(bloqueado.bloqueios.map((b) => b.codigo).slice(0, 2), ["MODO_NAO_DISABLED", "GATEWAY_INDISPONIVEL"]);
    assert.ok(bloqueado.bloqueios.every((b) => b.mensagem.length > 10));
  });

  test("auditoria: INICIADO e ENVIADO com ator humano (id, e-mail, perfil) e telefone mascarado — nunca o número nem o texto", async (t) => {
    if (pular(t)) return;
    const r = await teste.enviarTeste(req(), autor, depsBase());
    const auds = await acoesDe(r.mensagemId);
    const nomes = auds.map((a) => a.acao).sort();
    assert.deepEqual(nomes, ["COMUNICACAO_TESTE_ENVIADO", "COMUNICACAO_TESTE_INICIADO"]);
    for (const a of auds) { assert.equal(a.ator_id, autor.contaId); assert.equal(a.ator_email, autor.email); assert.equal(a.detalhes.perfil_nome, "Operador Teste"); }
    const bruto = JSON.stringify(auds);
    assert.equal(bruto.includes(telefone), false); assert.equal(bruto.includes("Mensagem de teste"), false);
    assert.match(auds[0].detalhes.telefone_mascarado, /^\*{8}\d{2}$/);
  });
});

describe("TESTE CONTROLADO — SENT → DELIVERED → READ pelos receipts (095) e acompanhamento", { skip: PULAR }, () => {
  test("statusTeste: SENT nunca aparece como entregue; DELIVERED e READ chegam; duplicado/fora de ordem/desconhecido não alteram; auditoria ENTREGUE/LIDO 1x", async (t) => {
    if (pular(t)) return;
    const r = await teste.enviarTeste(req(), autor, depsBase());
    const pid = (await linha(r.mensagemId)).provider_message_id;
    let s = await teste.statusTeste({ mensagemId: r.mensagemId }, autor, depsBase());
    assert.equal(s.situacao, "ENVIADO_AO_PROVEDOR"); assert.equal(s.status, "SENT"); assert.equal(s.entregueEm, null);

    assert.equal((await gatewayRepo.registrarStatusProvider(orgA, { providerMessageId: "OUTRO-ID-DESCONHECIDO", status: "READ" })).resultado, "NAO_ENCONTRADA");
    assert.equal((await teste.statusTeste({ mensagemId: r.mensagemId }, autor, depsBase())).situacao, "ENVIADO_AO_PROVEDOR", "receipt de outro id não altera este teste");

    await gatewayRepo.registrarStatusProvider(orgA, { providerMessageId: pid, status: "SERVER_ACK" });
    s = await teste.statusTeste({ mensagemId: r.mensagemId }, autor, depsBase());
    assert.equal(s.situacao, "ENVIADO_AO_PROVEDOR"); assert.ok(s.servidorAceitouEm);

    await gatewayRepo.registrarStatusProvider(orgA, { providerMessageId: pid, status: "DELIVERED" });
    await gatewayRepo.registrarStatusProvider(orgA, { providerMessageId: pid, status: "DELIVERED" });   // duplicado
    s = await teste.statusTeste({ mensagemId: r.mensagemId }, autor, depsBase());
    assert.equal(s.situacao, "ENTREGUE"); assert.ok(s.entregueEm); assert.equal(s.lidoEm, null);

    await gatewayRepo.registrarStatusProvider(orgA, { providerMessageId: pid, status: "READ" });
    await gatewayRepo.registrarStatusProvider(orgA, { providerMessageId: pid, status: "DELIVERED" });   // atrasado
    s = await teste.statusTeste({ mensagemId: r.mensagemId }, autor, depsBase());
    assert.equal(s.situacao, "LIDO"); assert.ok(s.lidoEm);
    await teste.statusTeste({ mensagemId: r.mensagemId }, autor, depsBase());   // polling repetido

    const nomes = (await acoesDe(r.mensagemId)).map((a) => a.acao).sort();
    assert.deepEqual(nomes, ["COMUNICACAO_TESTE_ENTREGUE", "COMUNICACAO_TESTE_ENVIADO", "COMUNICACAO_TESTE_INICIADO", "COMUNICACAO_TESTE_LIDO"], "ENTREGUE/LIDO exatamente 1 vez");
  });

  test("statusTeste só existe para mensagem de TESTE (uma mensagem operacional => 404); sem entrega ainda mostra segundosDesdeEnvio", async (t) => {
    if (pular(t)) return;
    const op = (await supabase.from("comunicacao_mensagens").insert({
      organizacao_id: orgA, unidade_id: uniA, contato_id: dest.contatoId, tipo: TIPOS_ALERTA.DASHBOARD_IFOOD_D1, conteudo: "op", idempotency_key: `t:${uuid()}`,
      status: "SENT", disponivel_em: new Date().toISOString(), enviado_em: new Date().toISOString(), provider_message_id: `3EB0OP${Date.now()}`,
    }).select("id").single()).data;
    await rejeita(teste.statusTeste({ mensagemId: op.id }, autor, depsBase()), 404);
    const r = await teste.enviarTeste(req(), autor, depsBase());
    const s = await teste.statusTeste({ mensagemId: r.mensagemId }, autor, depsBase());
    assert.equal(typeof s.segundosDesdeEnvio, "number");
    assert.equal(s.idAbreviado.length, 9); assert.match(s.providerMessageIdAbreviado, /^.{8}…$/);
  });
});

describe("BUG do piloto — salvar a configuração NÃO altera `habilitado`", { skip: PULAR }, () => {
  test("empresa HABILITADA continua habilitada depois de salvar configuração (timezone/tipos/pausa); configuração incompleta é recusada, nada muda", async (t) => {
    if (pular(t)) return;
    await habilitarOrganizacao(orgA, dest, { habilitado: true });
    const antes = (await supabase.from("comunicacao_habilitacoes").select("habilitado, destinatario_contato_id").eq("organizacao_id", orgA).single()).data;
    assert.equal(antes.habilitado, true);
    await servico.atualizarConfiguracao({ organizacaoId: orgA, timezone: "America/Sao_Paulo", tiposPermitidos: ["dashboard_ifood_d1"] }, autor);
    await servico.atualizarConfiguracao({ organizacaoId: orgA, pausadoAte: null, pausadoMotivo: null }, autor);
    const depois = (await supabase.from("comunicacao_habilitacoes").select("habilitado, timezone, destinatario_contato_id").eq("organizacao_id", orgA).single()).data;
    assert.equal(depois.habilitado, true, "salvar a configuração desabilitou a empresa");
    assert.equal(depois.timezone, "America/Sao_Paulo"); assert.equal(depois.destinatario_contato_id, antes.destinatario_contato_id);
    await rejeita(servico.atualizarConfiguracao({ organizacaoId: orgA, tiposPermitidos: [] }, autor), 400, "CONFIG_INCOMPLETA_HABILITADA");
    assert.equal((await supabase.from("comunicacao_habilitacoes").select("habilitado").eq("organizacao_id", orgA).single()).data.habilitado, true);
    await rejeita(servico.atualizarConfiguracao({ organizacaoId: orgA, habilitado: true }, autor), 400, "HABILITACAO_NAO_PERMITIDA");
  });

  test("empresa DESABILITADA continua desabilitada (salvar configuração nunca habilita)", async (t) => {
    if (pular(t)) return;
    await servico.atualizarConfiguracao({ organizacaoId: orgA, timezone: "America/Fortaleza" }, autor);
    assert.equal((await supabase.from("comunicacao_habilitacoes").select("habilitado").eq("organizacao_id", orgA).single()).data.habilitado, false);
  });

  test("empresa SEM linha de habilitação: salvar cria a linha com habilitado=false (default do banco)", async (t) => {
    if (pular(t)) return;
    await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", orgB);
    await servico.atualizarConfiguracao({ organizacaoId: orgB, timezone: "America/Sao_Paulo" }, autor);
    assert.equal((await supabase.from("comunicacao_habilitacoes").select("habilitado").eq("organizacao_id", orgB).single()).data.habilitado, false);
  });
});

describe("CENTRAL — histórico completo, filtros, detalhe e empresas", { skip: PULAR }, () => {
  test("mensagens(): todas as origens e status, empresa/unidade por NOME, destinatário mascarado, sem conteúdo; filtros e busca por nome (não por telefone)", async (t) => {
    if (pular(t)) return;
    const r = await teste.enviarTeste(req(), autor, depsBase());
    const inseridas = await supabase.from("comunicacao_mensagens").insert([
      { organizacao_id: orgA, unidade_id: uniA, contato_id: dest.contatoId, tipo: TIPOS_ALERTA.DASHBOARD_IFOOD_D1, conteudo: "segredo-conteudo", idempotency_key: `t:${uuid()}`, status: "DELIVERED", disponivel_em: new Date().toISOString(), enviado_em: new Date().toISOString(), metadados: {} },
      { organizacao_id: orgA, unidade_id: uniA, contato_id: dest.contatoId, tipo: TIPOS_ALERTA.DASHBOARD_IFOOD_D1, conteudo: "segredo-conteudo", idempotency_key: `t:${uuid()}`, status: "SENT", disponivel_em: new Date().toISOString(), enviado_em: new Date().toISOString(), metadados: { proposito: "reforco" } },
      { organizacao_id: orgA, unidade_id: uniA, contato_id: dest.contatoId, tipo: TIPOS_ALERTA.DASHBOARD_IFOOD_D1, conteudo: "segredo-conteudo", idempotency_key: `t:${uuid()}`, status: "READ", disponivel_em: new Date().toISOString(), enviado_em: new Date().toISOString(), metadados: { origem: "prazo_final_d1" } },
    ]);
    assert.equal(inseridas.error, null, inseridas.error?.message);
    const todas = await central.mensagens({ organizacaoId: orgA });
    assert.equal(todas.total, 4);
    assert.deepEqual([...new Set(todas.itens.map((i) => i.origem))].sort(), ["automacao", "aviso_tardio", "reforco", "teste_controlado"]);
    const bruto = JSON.stringify(todas);
    assert.equal(bruto.includes("segredo-conteudo"), false, "conteúdo vazou"); assert.equal(bruto.includes(telefone), false, "telefone completo vazou");
    assert.match(todas.itens[0].destinatario, /^\*{8}\d{2}$/);
    assert.ok(todas.itens.every((i) => i.empresa.includes("TESTE comunicacao-teste A") && i.unidade === "Unidade Matriz Teste"));
    assert.equal((await central.mensagens({ organizacaoId: orgA, origem: "teste_controlado" })).total, 1);
    assert.equal((await central.mensagens({ organizacaoId: orgA, status: "READ" })).total, 1);
    assert.equal((await central.mensagens({ organizacaoId: orgA, unidadeId: uniA })).total, 4);
    assert.equal((await central.mensagens({ organizacaoId: orgB })).total, 0);
    assert.equal((await central.mensagens({ busca: "matriz teste" })).itens.some((i) => i.organizacaoId === orgA), true, "busca por unidade");
    assert.equal((await central.mensagens({ busca: telefone.slice(-8), organizacaoId: orgA })).total, 0, "telefone não é chave de busca");
    assert.equal((await central.mensagens({ organizacaoId: orgA, desde: new Date(Date.now() + 3600_000).toISOString() })).total, 0, "período");
    await rejeita(central.mensagens({ status: "X" }), 400, "STATUS_INVALIDO");
    await rejeita(central.mensagens({ origem: "x" }), 400, "ORIGEM_INVALIDA");
    const d = await central.detalheMensagem({ id: r.mensagemId });
    assert.equal(d.origem, "teste_controlado"); assert.match(d.providerMessageIdAbreviado, /^.{8}…$/); assert.equal(d.tentativasDetalhe.length, 1);
    assert.equal(JSON.stringify(d).includes(telefone), false);
    await rejeita(central.detalheMensagem({ id: uuid() }), 404);
  });

  test("organizacoes(): contato mascarado, consentimento/verificação/opt-out, unidades, última mensagem e próxima ação", async (t) => {
    if (pular(t)) return;
    const r = await teste.enviarTeste(req(), autor, depsBase());
    const lista = await servico.organizacoes({}, { });
    const a = lista.find((o) => o.organizacaoId === orgA);
    assert.equal(a.habilitada, false); assert.equal(a.unidadesMonitoradas, 1);
    assert.deepEqual(a.contato, { telefoneMascarado: a.contato.telefoneMascarado, consentimento: true, verificado: true, optOut: false });
    assert.match(a.contato.telefoneMascarado, /^\*{8}\d{2}$/);
    assert.equal(a.ultimaMensagem.status, "SENT");
    assert.equal(a.proximaAcao, "Habilitar a comunicação desta empresa");
    assert.equal(JSON.stringify(lista).includes(telefone), false);
    assert.ok(r.mensagemId);
  });
});
