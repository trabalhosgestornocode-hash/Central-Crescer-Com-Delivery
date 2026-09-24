// CENTRAL DE COMUNICAÇÃO — contra POSTGRES REAL de TESTE (nenhum fake de banco). Cobre, com o cliente Supabase de verdade e as migrations 096/097 aplicadas:
// inbound autorizado × desconhecido, conversas (um telefone / várias unidades), isolamento entre conexões/organizações, envio manual (gates + outbox + RPCs fenced),
// gate de conta confirmada (manual, teste, provider), retenção real (purga), conexão (permissão, trava, QR fora do banco/auditoria, desconectar, trocar conta).
// PULA (não falha) sem banco descartável ou sem as migrations 096/097. Rodar: ver docs/comunicacao-central-conversas.md (env de TESTE; NUNCA o .env de produção).
import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, criarUnidade, criarDestinatario, apagarDestinatario, criarContaComPerfil, apagarConta, migracao082Aplicada } from "./helpers/comunicacao-fixtures.js";
import { processarInbound, DESTINO, _zerarMetricas } from "../src/modules/comunicacao/comunicacao.inbox.service.js";
import { purgarVencidas } from "../src/modules/comunicacao/comunicacao.inbox.repo.js";
import { criarWhatsAppService, IdentidadeNaoConfirmadaError } from "../src/modules/comunicacao/whatsapp.service.js";
import { criarGateIdentidade, hashTelefone, identidadeConfirmada } from "../src/modules/comunicacao/comunicacao.identidade.js";
import * as conversas from "../src/modules/administrativo/administrativo.comunicacao.conversas.js";
import * as conexao from "../src/modules/administrativo/administrativo.comunicacao.conexao.js";
import * as teste from "../src/modules/administrativo/administrativo.comunicacao.teste.js";

const PULAR = motivoPularIntegracao();
const tag = `cpr${Date.now()}`;
const AGORA = () => new Date();
const uuid = () => crypto.randomUUID();
const TEL_CONECTADO = "+5511987650001";
const TEL_OUTRO = "+5511987650002";
const QR_SEGREDO = "2@QR-SEGREDO-REAL-NAO-PODE-VAZAR,abc123,xyz789";

let migracaoOk = true;
let conA = null, conB = null;                 // organizações da CONEXÃO (donas do inbox)
let uA1 = null, uA2 = null, uB1 = null;
let destA = null, destB = null;
let telA = null, telB = null;
const extras = { contas: [], contatos: [] };

const ev = (o = {}) => ({
  contratoInbound: 1, providerMessageId: `WA-${uuid().slice(0, 12)}`, origemTipo: "LIVE", origemJidTipo: "direct_pn", fromMe: false, telefoneE164: telA, telefoneOrigem: "JID_PN",
  falhaDecrypt: false, motivoFalhaDecrypt: null, stubSistema: false, recebidoEm: new Date().toISOString(), tipoConteudo: "texto", texto: "mensagem de teste real", ...o,
});
const dep = (org, extra = {}) => ({ supabase, env: {}, organizacaoConexaoId: org, agora: AGORA, lerPendencias: async () => ({ unidades: [] }), ...extra });
const inbox = async (org, filtro = {}) => (await supabase.from("comunicacao_inbox_mensagens").select("*").eq("organizacao_id", org).match(filtro)).data ?? [];
const identLinha = async (org) => (await supabase.from("whatsapp_identidade").select("*").eq("organizacao_id", org).eq("provider_instance_id", "default").maybeSingle()).data;
const rejeita = (p, status, codigo) => assert.rejects(p, (e) => { assert.equal(e.statusCode ?? e.status, status, e.message); if (codigo) assert.equal(e.details?.codigo ?? e.detalhes?.codigo, codigo); return true; });

async function conectarNoBanco(org, { telefone = TEL_CONECTADO, status = "CONNECTED", idade = 5 } = {}) {
  const linha = { organizacao_id: org, provider_instance_id: "default", status, telefone_e164: telefone, last_seen_at: new Date(Date.now() - idade * 1000).toISOString(), connected_at: new Date().toISOString(), desired_connection_state: "CONNECTED" };
  const { error } = await supabase.from("whatsapp_conexoes").upsert(linha, { onConflict: "organizacao_id,provider_instance_id" });
  assert.equal(error, null, error?.message);
}
async function confirmarNoBanco(org, telefone = TEL_CONECTADO, extra = {}) {
  const { error } = await supabase.from("whatsapp_identidade").upsert({ organizacao_id: org, provider_instance_id: "default", status: "CONFIRMADA", telefone_hash: hashTelefone(telefone), confirmado_em: new Date().toISOString(), ambiente: "TESTE", ...extra }, { onConflict: "organizacao_id,provider_instance_id" });
  assert.equal(error, null, error?.message);
}
const limparConexao = async (org) => { await supabase.from("whatsapp_identidade").delete().eq("organizacao_id", org); await supabase.from("whatsapp_conexoes").delete().eq("organizacao_id", org); };

/** Gateway falso (NENHUM WhatsApp real): registra chamadas e é mutável como o Baileys. */
function gatewayFalso() {
  const g = { chamadas: [], live: { status: "DISCONNECTED", qrDisponivel: false, reconectando: false }, qr: { qr: null, ordem: 0 }, perfil: { disponivel: true, nome: "Crescer Teste", telefoneE164: TEL_CONECTADO, tipoConta: "DESCONHECIDO" } };
  g.enviarTexto = mock.fn(async () => ({ providerMessageId: `3EB0REAL${Date.now()}`, enviadoEm: new Date().toISOString() }));
  g.svc = {
    identidadeConfirmada: async () => true,
    enviarTexto: g.enviarTexto,
    buscarFotoPerfil: async () => ({ url: null, motivo: "sem_foto" }),
    conexaoStatus: async () => ({ ...g.live }),
    conexaoQr: async () => ({ ...g.qr, geradoEm: new Date().toISOString(), expiraEm: new Date(Date.now() + 55000).toISOString(), svg: g.qr.qr ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"></svg>` : null }),
    conexaoPerfil: async () => g.perfil,
    conexaoConectar: async () => { g.chamadas.push("conectar"); g.live = { ...g.live, status: "CONNECTING" }; return { ok: true }; },
    conexaoDesconectarConta: async () => { g.chamadas.push("desconectarConta"); g.live = { status: "DISCONNECTED", qrDisponivel: false, reconectando: false }; return { ok: true }; },
    conexaoEncerrar: async () => { g.chamadas.push("encerrar"); g.live = { status: "DISCONNECTED", qrDisponivel: false, reconectando: false }; return { ok: true }; },
  };
  g.mostrarQr = (ordem = 1) => { g.live = { status: "CONNECTING", qrDisponivel: true, reconectando: false }; g.qr = { qr: QR_SEGREDO, ordem }; };
  g.conectou = async (org, telefone = TEL_CONECTADO) => { g.live = { status: "CONNECTED", qrDisponivel: false, reconectando: false }; g.qr = { qr: null, ordem: 0 }; g.perfil = { ...g.perfil, telefoneE164: telefone }; await conectarNoBanco(org, { telefone }); };
  return g;
}

before(async () => {
  if (PULAR) return;
  const probes = await Promise.all([supabase.from("comunicacao_inbox_mensagens").select("id").limit(0), supabase.from("whatsapp_identidade").select("organizacao_id").limit(0), supabase.from("comunicacao_roster_autorizado").select("contato_id").limit(0)]);
  migracaoOk = (await migracao082Aplicada()) && probes.every((p) => !p.error);
  if (!migracaoOk) return;
  conA = await criarOrganizacao(`TESTE ${tag} A (conexão + clientes)`); conB = await criarOrganizacao(`TESTE ${tag} B (conexão + clientes)`);
  uA1 = await criarUnidade(conA, "A Loja 1"); uA2 = await criarUnidade(conA, "A Loja 2"); uB1 = await criarUnidade(conB, "B Loja 1");
  destA = await criarDestinatario({ organizacaoId: conA, unidadeId: uA1, tag, sufixo: "a" });
  destB = await criarDestinatario({ organizacaoId: conB, unidadeId: uB1, tag, sufixo: "b" });
  // um SEGUNDO vínculo de unidade para o mesmo responsável A (um telefone, duas unidades)
  const { data: perfil } = await supabase.from("perfis_operacionais").select("conta_id").eq("id", destA.perfilId).single();
  await supabase.from("usuarios_unidades").insert({ usuario_id: perfil.conta_id, unidade_id: uA2, perfil_id: destA.perfilId, ativo: true });
  telA = (await supabase.from("contatos_whatsapp").select("telefone_e164").eq("id", destA.contatoId).single()).data.telefone_e164;
  telB = (await supabase.from("contatos_whatsapp").select("telefone_e164").eq("id", destB.contatoId).single()).data.telefone_e164;
});

after(async () => {
  if (PULAR || !migracaoOk) return;
  const orgs = [conA, conB].filter(Boolean);
  await supabase.from("comunicacao_mensagens").delete().in("organizacao_id", orgs);
  await supabase.from("comunicacao_inbox_mensagens").delete().in("organizacao_id", orgs);
  for (const o of orgs) await limparConexao(o);
  await supabase.from("plataforma_auditoria").delete().in("organizacao_id", orgs);
  for (const c of extras.contatos) await supabase.from("contatos_whatsapp").delete().eq("id", c);
  for (const c of extras.contas) await apagarConta(c);
  await apagarOrganizacao(conA); await apagarOrganizacao(conB);
  await apagarDestinatario(destA); await apagarDestinatario(destB);
});

beforeEach(async () => {
  if (PULAR || !migracaoOk) return;
  _zerarMetricas(); conexao._zerarCachePerfil?.(); conexao._zerarQrAuditados?.();
  await supabase.from("comunicacao_inbox_mensagens").delete().in("organizacao_id", [conA, conB]);
  await supabase.from("comunicacao_inbox_leituras").delete().in("organizacao_id", [conA, conB]);
  await supabase.from("comunicacao_mensagens").delete().in("organizacao_id", [conA, conB]);
  await limparConexao(conA); await limparConexao(conB);
});

const inserir = async (tabela, linha) => { const r = await supabase.from(tabela).insert(linha); assert.equal(r.error, null, `insert em ${tabela}: ${r.error?.message}`); return r; };
const saidaAntiga = (org, texto, extra = {}) => ({ organizacao_id: org, contato_id: destA.contatoId, direcao: "saida", tipo: "manual", conteudo: texto, status: "SENT", idempotency_key: `wa:manual:${crypto.randomUUID()}:v1`, disponivel_em: new Date().toISOString(), ...extra });

const pular = (t) => (PULAR || !migracaoOk ? { skip: PULAR || "096/097 ausentes neste banco" } : t);

describe("INBOUND autorizado (banco real)", pular({}), () => {
  test("responsável cadastrado: mensagem persistida com o contato, na organização da CONEXÃO", async () => {
    const r = await processarInbound({ organizacaoId: conA, evento: ev({ providerMessageId: "WA-OK-1" }) }, dep(conA));
    assert.deepEqual([r.destino, r.contatoId, r.inserido], [DESTINO.INBOX, destA.contatoId, true]);
    const linhas = await inbox(conA);
    assert.equal(linhas.length, 1);
    assert.deepEqual([linhas[0].contato_id, linhas[0].texto, linhas[0].tipo_conteudo, linhas[0].origem_tipo], [destA.contatoId, "mensagem de teste real", "texto", "LIVE"]);
  });

  test("idempotente: o mesmo providerMessageId duas vezes ⇒ UMA linha (unique real)", async () => {
    const e = ev({ providerMessageId: "WA-DUP" });
    assert.equal((await processarInbound({ organizacaoId: conA, evento: e }, dep(conA))).inserido, true);
    assert.equal((await processarInbound({ organizacaoId: conA, evento: e }, dep(conA))).inserido, false);
    assert.equal((await inbox(conA)).length, 1);
  });

  test("NÚMERO DESCONHECIDO: ignorado — sem conversa, sem mensagem persistida, sem contato criado, sem busca", async () => {
    const desconhecido = "+5511955550009";
    const r = await processarInbound({ organizacaoId: conA, evento: ev({ providerMessageId: "WA-UNK", telefoneE164: desconhecido, texto: "quem sou eu" }) }, dep(conA));
    assert.equal(r.destino, DESTINO.IGNORADO);
    assert.equal((await inbox(conA)).length, 0, "nenhuma linha no inbox");
    const { count } = await supabase.from("contatos_whatsapp").select("id", { count: "exact", head: true }).eq("telefone_e164", desconhecido);
    assert.equal(count, 0, "o contato não é criado");
    const busca = await conversas.listarConversas({ busca: "quem sou eu" }, dep(conA));
    assert.equal(busca.itens.length, 0);
    const hist = await conversas.historicoGeral({ busca: "quem sou eu" }, dep(conA));
    assert.equal(JSON.stringify(hist).includes("quem sou eu"), false, "não aparece no histórico");
  });

  test("grupo, status, broadcast e newsletter: ignorados (nada persistido)", async () => {
    for (const tipo of ["group", "status_broadcast", "broadcast", "newsletter"]) {
      const r = await processarInbound({ organizacaoId: conA, evento: ev({ providerMessageId: `WA-${tipo}`, origemJidTipo: tipo }) }, dep(conA));
      assert.equal(r.destino, DESTINO.IGNORADO, tipo);
    }
    assert.equal((await inbox(conA)).length, 0);
  });

  test("OFFLINE_RECOVERY nunca entra; fromMe e falha de decrypt são ignorados", async () => {
    for (const o of [{ origemTipo: "OFFLINE_RECOVERY" }, { fromMe: true }, { falhaDecrypt: true, motivoFalhaDecrypt: "x" }, { stubSistema: true }]) {
      assert.equal((await processarInbound({ organizacaoId: conA, evento: ev({ providerMessageId: `WA-${uuid().slice(0, 8)}`, ...o }) }, dep(conA))).destino, DESTINO.IGNORADO, JSON.stringify(o));
    }
    assert.equal((await inbox(conA)).length, 0);
  });

  test("mídia vira só o marcador (tipo 'midia', texto NULL) — a constraint real aceita", async () => {
    const r = await processarInbound({ organizacaoId: conA, evento: ev({ providerMessageId: "WA-MIDIA", tipoConteudo: "midia", texto: null }) }, dep(conA));
    assert.equal(r.destino, DESTINO.INBOX);
    const [l] = await inbox(conA);
    assert.deepEqual([l.tipo_conteudo, l.texto], ["midia", null]);
  });

  test("perfil INATIVO ⇒ deixa de ser autorizado no MESMO instante (sem cache): a mensagem seguinte é ignorada", async () => {
    await supabase.from("perfis_operacionais").update({ ativo: false }).eq("id", destB.perfilId);
    try {
      const r = await processarInbound({ organizacaoId: conA, evento: ev({ providerMessageId: "WA-INAT", telefoneE164: telB }) }, dep(conA));
      assert.equal(r.destino, DESTINO.IGNORADO);
    } finally { await supabase.from("perfis_operacionais").update({ ativo: true }).eq("id", destB.perfilId); }
  });
});

describe("CONVERSAS (banco real)", pular({}), () => {
  test("um telefone ligado a DUAS unidades ⇒ UMA conversa, com as duas unidades", async () => {
    await processarInbound({ organizacaoId: conA, evento: ev({ providerMessageId: "WA-C1" }) }, dep(conA));
    const lista = await conversas.listarConversas({}, dep(conA));
    const minhas = lista.itens.filter((c) => c.contatoId === destA.contatoId);
    assert.equal(minhas.length, 1, "uma única conversa");
    assert.deepEqual(minhas[0].unidades.map((u) => u.nome).sort(), ["A Loja 1", "A Loja 2"]);
    assert.equal(minhas[0].naoLidas, 1);
    assert.match(minhas[0].telefoneMascarado, /\*|•|…/, "telefone mascarado");
    assert.equal(JSON.stringify(lista).includes(telA), false, "o telefone completo nunca sai da API");
  });

  test("histórico: últimas 24h por padrão; ordem cronológica entre entrada e saída; mais antigas só sob pedido", async () => {
    const h = (n) => new Date(Date.now() - n * 3600_000).toISOString();
    await inserir("comunicacao_inbox_mensagens", [
      { organizacao_id: conA, contato_id: destA.contatoId, provider_message_id: "H-30h", origem_tipo: "LIVE", tipo_conteudo: "texto", texto: "há 30h", recebido_em: h(30) },
      { organizacao_id: conA, contato_id: destA.contatoId, provider_message_id: "H-5h", origem_tipo: "LIVE", tipo_conteudo: "texto", texto: "há 5h", recebido_em: h(5) },
      { organizacao_id: conA, contato_id: destA.contatoId, provider_message_id: "H-1h", origem_tipo: "LIVE", tipo_conteudo: "texto", texto: "há 1h", recebido_em: h(1) },
    ]);
    await inserir("comunicacao_mensagens", saidaAntiga(conA, "saída 3h", { created_at: h(3), updated_at: h(3), enviado_em: h(3) }));
    const padrao = await conversas.obterConversa({ contatoId: destA.contatoId }, { contaId: uuid() }, dep(conA));
    const textos = padrao.mensagens.map((m) => m.texto);
    assert.deepEqual(textos, ["há 5h", "saída 3h", "há 1h"], "24h por padrão, entrada e saída intercaladas em ordem cronológica");
    assert.equal(padrao.temMaisAntigas, true);
    const ampla = await conversas.obterConversa({ contatoId: destA.contatoId, horas: 72 }, { contaId: uuid() }, dep(conA));
    assert.deepEqual(ampla.mensagens.map((m) => m.texto), ["há 30h", "há 5h", "saída 3h", "há 1h"]);
  });

  test("conversa de um contato que NÃO é do roster ⇒ 404 (indistinguível de inexistente)", async () => {
    const { data: c } = await supabase.from("contatos_whatsapp").insert({ telefone_e164: "+5511955550111" }).select("id").single();
    extras.contatos.push(c.id);
    await rejeita(conversas.obterConversa({ contatoId: c.id }, { contaId: uuid() }, dep(conA)), 404);
  });

  test("marcar lida: por (conexão, contato) — zera as não lidas da conexão A e NÃO as da B", async () => {
    await processarInbound({ organizacaoId: conA, evento: ev({ providerMessageId: "WA-L-A" }) }, dep(conA));
    await processarInbound({ organizacaoId: conB, evento: ev({ providerMessageId: "WA-L-B" }) }, dep(conB));
    const nao = async (org) => (await conversas.listarConversas({}, dep(org))).itens.find((c) => c.contatoId === destA.contatoId)?.naoLidas;
    assert.deepEqual([await nao(conA), await nao(conB)], [1, 1]);
    await conversas.marcarLida({ contatoId: destA.contatoId }, { perfilId: destA.perfilId }, dep(conA));
    assert.deepEqual([await nao(conA), await nao(conB)], [0, 1], "a leitura na A não zerou a B");
  });
});

describe("ISOLAMENTO entre conexões/organizações (banco real)", pular({}), () => {
  test("A não lê B e B não lê A: mensagens, conversas e histórico são particionados pela organização da conexão", async () => {
    await processarInbound({ organizacaoId: conA, evento: ev({ providerMessageId: "WA-ISO-A", texto: "SEGREDO-DA-A" }) }, dep(conA));
    await processarInbound({ organizacaoId: conB, evento: ev({ providerMessageId: "WA-ISO-B", telefoneE164: telB, texto: "SEGREDO-DA-B" }) }, dep(conB));
    const vistoPorA = JSON.stringify([await conversas.listarConversas({}, dep(conA)), await conversas.obterConversa({ contatoId: destA.contatoId }, { contaId: uuid() }, dep(conA)), await conversas.historicoGeral({}, dep(conA))]);
    const vistoPorB = JSON.stringify([await conversas.listarConversas({}, dep(conB)), await conversas.obterConversa({ contatoId: destB.contatoId }, { contaId: uuid() }, dep(conB)), await conversas.historicoGeral({}, dep(conB))]);
    assert.ok(vistoPorA.includes("SEGREDO-DA-A") && !vistoPorA.includes("SEGREDO-DA-B"), "A só vê o que é da A");
    assert.ok(vistoPorB.includes("SEGREDO-DA-B") && !vistoPorB.includes("SEGREDO-DA-A"), "B só vê o que é da B");
  });

  test("B não consegue ler as mensagens de um contato que só falou com a A (mesmo pedindo o contato pelo id)", async () => {
    await processarInbound({ organizacaoId: conA, evento: ev({ providerMessageId: "WA-ISO-2", texto: "SO-DA-A" }) }, dep(conA));
    const c = await conversas.obterConversa({ contatoId: destA.contatoId, horas: 720 }, { contaId: uuid() }, dep(conB));
    assert.equal(JSON.stringify(c).includes("SO-DA-A"), false);
  });

  test("A não altera B: marcar lida / identidade / trava de operação são independentes", async () => {
    const svc = gatewayFalso();
    await confirmarNoBanco(conB, TEL_OUTRO); await conectarNoBanco(conB, { telefone: TEL_OUTRO });
    await supabase.rpc("whatsapp_operacao_iniciar", { p_organizacao_id: conA, p_provider_instance_id: "default", p_tipo: "CONECTAR", p_por: null, p_ttl_segundos: 300 });
    const b = await identLinha(conB);
    assert.equal(b.operacao_id, null, "a trava da A não prendeu a B");
    assert.equal(b.status, "CONFIRMADA");
    assert.equal(await identidadeConfirmada({ supabase, organizacaoConexaoId: conB, env: {}, agora: AGORA }), true);
    assert.equal(await identidadeConfirmada({ supabase, organizacaoConexaoId: conA, env: {}, agora: AGORA }), false, "a confirmação da B nunca vale para a A");
    assert.equal(svc.enviarTexto.mock.callCount(), 0);
  });

  test("a organização A não cria relação indevida na B: inbox exige o contato do roster (constraint/RPC do banco)", async () => {
    const { error } = await supabase.rpc("comunicacao_inbox_registrar", { p_organizacao_id: conA, p_contato_id: uuid(), p_provider_message_id: "X-FORJADO", p_origem_tipo: "LIVE", p_tipo_conteudo: "texto", p_texto: "forjado", p_recebido_em: new Date().toISOString(), p_retencao_dias: 30 });
    assert.ok(error, "contato fora do roster é recusado pelo banco");
    assert.equal((await inbox(conA)).length, 0);
  });
});

describe("GATE de conta confirmada — banco real (manual, teste, provider)", pular({}), () => {
  const envPiloto = () => ({ COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: telA, WHATSAPP_GATEWAY_URL: "http://gateway.invalid", WHATSAPP_GATEWAY_SECRET: "x" });
  const autor = () => ({ contaId: destA.contaId, perfilId: destA.perfilId, nome: "Operadora", email: `${tag}@example.com` });
  const manual = (svc, extra = {}) => conversas.enviarMensagem({ contatoId: destA.contatoId, envioId: uuid(), texto: "Bom dia" }, autor(), dep(conA, { env: envPiloto(), estadoGateway: { estado: "conectado" }, whatsAppService: svc.svc, ...extra }));
  const saidas = async () => (await supabase.from("comunicacao_mensagens").select("*").eq("contato_id", destA.contatoId)).data ?? [];

  test("CONNECTED + conta CONFIRMADA (mesmo hash) ⇒ envia: 1 provider call, 1 linha no outbox SENT, ator humano, origem manual_painel", async () => {
    const g = gatewayFalso(); await conectarNoBanco(conA); await confirmarNoBanco(conA);
    const r = await manual(g);
    assert.deepEqual([r.resultado, r.status], ["ENVIADO", "SENT"]);
    assert.equal(g.enviarTexto.mock.callCount(), 1);
    const [linha] = await saidas();
    assert.deepEqual([linha.status, linha.direcao], ["SENT", "saida"]);
    assert.equal(linha.contato_id, destA.contatoId);
  });

  test("duplo clique (mesmo envioId) ⇒ UMA mensagem e UM provider call (idempotência real no banco)", async () => {
    const g = gatewayFalso(); await conectarNoBanco(conA); await confirmarNoBanco(conA);
    const envioId = uuid();
    const [r1, r2, r3] = await Promise.all([1, 2, 3].map(() => conversas.enviarMensagem({ contatoId: destA.contatoId, envioId, texto: "uma só" }, autor(), dep(conA, { env: envPiloto(), estadoGateway: { estado: "conectado" }, whatsAppService: g.svc }))));
    assert.equal(g.enviarTexto.mock.callCount(), 1, "provider chamado UMA vez");
    assert.equal((await saidas()).length, 1);
    assert.ok([r1, r2, r3].filter((r) => r.jaExistia).length >= 1);
  });

  test("CONNECTED SOZINHO não basta: sem registro de identidade ⇒ 409 CONEXAO_NAO_CONFIRMADA, provider = 0, nenhuma linha no outbox", async () => {
    const g = gatewayFalso(); await conectarNoBanco(conA);
    await rejeita(manual(g), 409);
    assert.equal(g.enviarTexto.mock.callCount(), 0);
    assert.equal((await saidas()).length, 0);
    const pode = (await conversas.obterConversa({ contatoId: destA.contatoId }, autor(), dep(conA, { env: envPiloto(), estadoGateway: { estado: "conectado" }, whatsAppService: g.svc }))).envio;
    assert.equal(pode.podeEnviar, false);
    assert.ok(pode.bloqueios.some((b) => b.codigo === "CONEXAO_NAO_CONFIRMADA"), "a tela recebe o motivo estável");
  });

  test("durante WAITING_QR / CONNECTING / PENDENTE / OUTRA CONTA / TROCA / DESCONECTADO ⇒ provider = 0 (manual, teste controlado e o próprio serviço)", async () => {
    const cenarios = [
      ["CONNECTING (QR à espera)", async () => { await conectarNoBanco(conA, { status: "CONNECTING" }); await confirmarNoBanco(conA); }],
      ["identidade PENDENTE_CONFIRMACAO", async () => { await conectarNoBanco(conA); await supabase.from("whatsapp_identidade").upsert({ organizacao_id: conA, provider_instance_id: "default", status: "PENDENTE_CONFIRMACAO", telefone_hash: hashTelefone(TEL_CONECTADO) }, { onConflict: "organizacao_id,provider_instance_id" }); }],
      ["OUTRA CONTA conectada (hash difere)", async () => { await conectarNoBanco(conA, { telefone: TEL_OUTRO }); await confirmarNoBanco(conA, TEL_CONECTADO); }],
      ["TROCA de conta em andamento (identidade zerada)", async () => { await conectarNoBanco(conA, { status: "CONNECTING", telefone: null }); await supabase.from("whatsapp_identidade").upsert({ organizacao_id: conA, provider_instance_id: "default", status: "SEM_CONTA", telefone_hash: null, confirmado_em: null }, { onConflict: "organizacao_id,provider_instance_id" }); }],
      ["DESCONECTADO", async () => { await conectarNoBanco(conA, { status: "DISCONNECTED" }); await confirmarNoBanco(conA); }],
      ["heartbeat VELHO (conectado por inércia)", async () => { await conectarNoBanco(conA, { idade: 900 }); await confirmarNoBanco(conA); }],
    ];
    for (const [nome, montar] of cenarios) {
      await limparConexao(conA); await montar();
      const g = gatewayFalso();
      await rejeita(manual(g), 409);
      const provider = { getStatus: async () => ({ conectado: true }), sendText: mock.fn(async () => ({ providerMessageId: "P" })), sendImage: async () => ({}), sendDocument: async () => ({}), connect: async () => {}, disconnect: async () => {}, onMessage() {}, markAsRead: async () => {}, getMessageStatus: async () => ({}) };
      const real = criarWhatsAppService({ provider, identidadeConfirmada: criarGateIdentidade({ supabase, env: {}, organizacaoConexaoId: conA, agora: AGORA }) });
      await assert.rejects(() => real.enviarTexto({ telefoneE164: telA, texto: "x", idempotencyKey: "k" }), IdentidadeNaoConfirmadaError, nome);
      assert.equal(provider.sendText.mock.callCount(), 0, `${nome}: provider = 0`);
      assert.equal(g.enviarTexto.mock.callCount(), 0, `${nome}: nada saiu`);
    }
    assert.equal((await saidas()).length, 0, "nenhuma linha de saída em nenhum cenário");
  });

  test("restart da MESMA conta preserva a confirmação; conta DIFERENTE invalida; voltar à conta confirmada revalida", async () => {
    const dp = { supabase, env: {}, organizacaoConexaoId: conA, agora: AGORA };
    await conectarNoBanco(conA); await confirmarNoBanco(conA);
    assert.equal(await identidadeConfirmada(dp), true);
    await conectarNoBanco(conA, { status: "CONNECTING" });               // restart
    assert.equal(await identidadeConfirmada(dp), false, "durante o restart bloqueia");
    await conectarNoBanco(conA);                                        // voltou, mesma conta
    assert.equal(await identidadeConfirmada(dp), true, "mesma conta: confirmação preservada, sem reconfirmar");
    await conectarNoBanco(conA, { telefone: TEL_OUTRO });                // outra conta
    assert.equal(await identidadeConfirmada(dp), false, "conta diferente invalida");
    await conectarNoBanco(conA);                                        // a confirmada volta
    assert.equal(await identidadeConfirmada(dp), true);
  });

  test("TESTE CONTROLADO também exige conta confirmada (preparo mostra o bloqueio; envio 409; provider = 0)", async () => {
    const g = gatewayFalso(); await conectarNoBanco(conA);
    const { data: contato } = await supabase.from("contatos_whatsapp").select("telefone_e164").eq("id", destA.contatoId).single();
    await supabase.from("comunicacao_habilitacoes").upsert({ organizacao_id: conA, habilitado: false, tipos_permitidos: ["dashboard_ifood_d1"], timezone: "America/Fortaleza", destinatario_contato_id: destA.contatoId, destinatario_perfil_id: destA.perfilId }, { onConflict: "organizacao_id" });
    const deps = dep(conA, { env: envPiloto(), estadoGateway: { estado: "conectado" }, lerModo: async () => "DISABLED", whatsAppService: g.svc });
    const preparo = await teste.preparoTeste({ organizacaoId: conA, unidadeId: uA1 }, deps);
    assert.equal(preparo.podeEnviar, false);
    assert.ok(preparo.bloqueios.some((b) => b.codigo === "CONEXAO_NAO_CONFIRMADA"));
    await rejeita(teste.enviarTeste({ organizacaoId: conA, unidadeId: uA1, testeId: uuid(), confirmacaoExplicita: true }, autor(), deps), 409, "CONEXAO_NAO_CONFIRMADA");
    assert.equal(g.enviarTexto.mock.callCount(), 0);
    assert.equal(contato.telefone_e164, telA);
    await supabase.from("comunicacao_habilitacoes").delete().eq("organizacao_id", conA);
  });
});

describe("RETENÇÃO de 30 dias — purga REAL (banco real)", pular({}), () => {
  const dia = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  const ins = (id, org, dias) => ({ organizacao_id: org, contato_id: destA.contatoId, provider_message_id: id, origem_tipo: "LIVE", tipo_conteudo: "texto", texto: id, recebido_em: dia(dias) });

  test("leitura nunca mostra texto vencido, mesmo ANTES da purga", async () => {
    await inserir("comunicacao_inbox_mensagens", [ins("R-VELHA", conA, 31), ins("R-NOVA", conA, 2)]);
    const c = await conversas.obterConversa({ contatoId: destA.contatoId, horas: 720 }, { contaId: uuid() }, dep(conA));
    assert.deepEqual(c.mensagens.map((m) => m.texto), ["R-NOVA"]);
    const lista = await conversas.listarConversas({}, dep(conA));
    assert.notEqual(lista.itens.find((i) => i.contatoId === destA.contatoId)?.ultimaMensagem?.previa, "R-VELHA");
    assert.equal((await inbox(conA)).length, 2, "ainda existe fisicamente até a purga");
  });

  test("purgarVencidas apaga só o vencido (de qualquer organização), devolve a contagem e é idempotente", async () => {
    await inserir("comunicacao_inbox_mensagens", [ins("R-A-VELHA", conA, 40), ins("R-B-VELHA", conB, 35), ins("R-A-BORDA", conA, 29), ins("R-A-NOVA", conA, 0)]);
    const n = await purgarVencidas({ dias: 30, limite: 5000 }, { supabase });
    assert.ok(n >= 2, `removidas=${n}`);
    const restantes = [...(await inbox(conA)), ...(await inbox(conB))].map((l) => l.provider_message_id).sort();
    assert.deepEqual(restantes, ["R-A-BORDA", "R-A-NOVA"]);
    assert.equal(await purgarVencidas({ dias: 30 }, { supabase }), 0);
  });

  test("a purga NUNCA toca histórico de saída (outbox), contatos nem auditoria", async () => {
    await inserir("comunicacao_mensagens", saidaAntiga(conA, "saída antiga", { created_at: dia(90), updated_at: dia(90) }));
    await inserir("comunicacao_inbox_mensagens", ins("R-VELHA-2", conA, 60));
    await purgarVencidas({ dias: 30 }, { supabase });
    const { count } = await supabase.from("comunicacao_mensagens").select("id", { count: "exact", head: true }).eq("contato_id", destA.contatoId);
    assert.equal(count, 1, "o outbox não é purgado");
    const { count: contatos } = await supabase.from("contatos_whatsapp").select("id", { count: "exact", head: true }).eq("id", destA.contatoId);
    assert.equal(contatos, 1);
  });

  test("registro de nova mensagem também purga o vencido da própria organização (camada oportunista)", async () => {
    await inserir("comunicacao_inbox_mensagens", ins("R-OPORT", conA, 50));
    await processarInbound({ organizacaoId: conA, evento: ev({ providerMessageId: "WA-OPORT-NOVA" }) }, dep(conA));
    assert.equal((await inbox(conA, { provider_message_id: "R-OPORT" })).length, 0);
  });
});

describe("CONEXÃO — permissão, trava, QR, confirmação, desconexão e troca (banco real)", pular({}), () => {
  const OP_SEM = () => ({ contaId: destB.contaId, perfilId: destB.perfilId, nome: "Sem Permissão", email: `${tag}-sem@example.com`, superadmin: false });
  const OP_COM = () => ({ contaId: destA.contaId, perfilId: destA.perfilId, nome: "Com Permissão", email: `${tag}-com@example.com`, superadmin: false });
  const SUPER = () => ({ contaId: uuid(), perfilId: null, nome: "Super", email: `${tag}-super@example.com`, superadmin: true });
  const depsCon = (g, org = conA, extra = {}) => dep(org, { whatsAppService: g.svc, ...extra });
  const auditorias = async (org) => (await supabase.from("plataforma_auditoria").select("acao, detalhes, ator_email").eq("organizacao_id", org)).data ?? [];
  const varrer = async (org) => JSON.stringify({
    ident: await identLinha(org), conex: (await supabase.from("whatsapp_conexoes").select("*").eq("organizacao_id", org)).data,
    aud: await auditorias(org), inbox: await inbox(org), msgs: (await supabase.from("comunicacao_mensagens").select("*").eq("organizacao_id", org)).data,
  });

  before(async () => { if (!PULAR && migracaoOk) await supabase.from("painel_adm_permissoes").upsert({ usuario_id: destA.contaId, permissao: conexao.PERMISSAO_CONEXAO }, { onConflict: "usuario_id,permissao" }); });
  after(async () => { if (!PULAR && migracaoOk) await supabase.from("painel_adm_permissoes").delete().eq("usuario_id", destA.contaId); });

  test("permissão ESPECÍFICA (tabela real): sem ela 403 (mesmo com acesso à Central); com ela ou SuperAdmin, ok", async () => {
    const g = gatewayFalso();
    await rejeita(conexao.iniciar(OP_SEM(), depsCon(g)), 403);
    assert.deepEqual(g.chamadas, [], "nenhuma ação chegou ao Gateway");
    assert.equal(await conexao.temPermissaoConexao(OP_SEM(), depsCon(g)), false);
    assert.equal(await conexao.temPermissaoConexao(OP_COM(), depsCon(g)), true);
    assert.equal(await conexao.temPermissaoConexao(SUPER(), depsCon(g)), true);
    const st = await conexao.estado(OP_SEM(), depsCon(g));
    assert.equal(st.permissoes.gerenciar, false);
    assert.equal(st.operacao, null, "quem não gerencia não vê a operação");
  });

  test("UMA operação de conexão por vez: duas tentativas simultâneas ⇒ 1 vence, a outra 409 OPERACAO_EM_ANDAMENTO", async () => {
    const g = gatewayFalso();
    const r = await Promise.allSettled([conexao.iniciar(OP_COM(), depsCon(g)), conexao.iniciar(SUPER(), depsCon(g))]);
    const ok = r.filter((x) => x.status === "fulfilled"); const ko = r.filter((x) => x.status === "rejected");
    assert.equal(ok.length, 1); assert.equal(ko.length, 1);
    assert.equal(ko[0].reason.statusCode, 409);
    assert.equal(ko[0].reason.details?.codigo, "OPERACAO_EM_ANDAMENTO");
    assert.equal(g.chamadas.filter((c) => c === "conectar").length, 1, "só uma sessão foi aberta");
  });

  test("fluxo completo: iniciar → QR → escanear → PENDENTE → confirmar → CONFIRMADA; o QR NÃO está em nenhuma tabela nem na auditoria", async () => {
    const g = gatewayFalso();
    const { operacaoId } = await conexao.iniciar(OP_COM(), depsCon(g));
    g.mostrarQr(1);
    const q = await conexao.qr({ operacaoId }, OP_COM(), depsCon(g));
    assert.ok(q.svg, "o assistente recebe o SVG");
    assert.equal(JSON.stringify(q).includes(QR_SEGREDO), false, "nunca a string crua do QR");
    assert.equal(await identidadeConfirmada({ supabase, env: {}, organizacaoConexaoId: conA, agora: AGORA }), false, "enquanto aguarda: bloqueado");
    await g.conectou(conA);
    const pend = await conexao.estado(OP_COM(), depsCon(g));
    assert.equal(pend.identidade.status, "PENDENTE_CONFIRMACAO", "escanear NÃO conclui em silêncio");
    assert.equal(await identidadeConfirmada({ supabase, env: {}, organizacaoConexaoId: conA, agora: AGORA }), false, "pendente: bloqueado");
    await conexao.confirmar({ operacaoId, utilizarComoAgente: true, ambiente: "TESTE" }, OP_COM(), depsCon(g));
    const ok = await conexao.estado(OP_COM(), depsCon(g));
    assert.deepEqual([ok.identidade.status, ok.identidade.agenteCrescer, ok.identidade.nomeOperacional], ["CONFIRMADA", true, "Agente Crescer"]);
    assert.equal(await identidadeConfirmada({ supabase, env: {}, organizacaoConexaoId: conA, agora: AGORA }), true);
    const ident = await identLinha(conA);
    assert.equal(ident.telefone_hash, hashTelefone(TEL_CONECTADO), "a confirmação está vinculada ao HASH da conta concreta");
    assert.equal(ident.operacao_id, null, "a trava foi liberada");
    const tudo = await varrer(conA);
    assert.equal(tudo.includes(QR_SEGREDO), false, "QR não persistido (identidade, conexão, auditoria, inbox, outbox)");
    assert.equal(tudo.includes("QR-SEGREDO"), false);
    assert.equal(JSON.stringify([await identLinha(conA), await auditorias(conA)]).includes(TEL_CONECTADO), false, "telefone completo nunca na identidade/auditoria");
    const acoes = (await auditorias(conA)).map((a) => a.acao);
    for (const a of ["WHATSAPP_CONEXAO_INICIADA", "WHATSAPP_QR_GERADO", "WHATSAPP_CONECTADO"]) assert.ok(acoes.includes(a), `auditou ${a}`);
  });

  test("cancelar após escanear = reset: a conta não confirmada NUNCA envia", async () => {
    const g = gatewayFalso();
    const { operacaoId } = await conexao.iniciar(OP_COM(), depsCon(g));
    g.mostrarQr(1); await g.conectou(conA);
    await conexao.cancelar({ operacaoId }, OP_COM(), depsCon(g));
    assert.ok(g.chamadas.includes("desconectarConta") || g.chamadas.includes("encerrar"), "a sessão foi encerrada no Gateway");
    assert.equal(await identidadeConfirmada({ supabase, env: {}, organizacaoConexaoId: conA, agora: AGORA }), false);
  });

  test("DESCONECTAR: exige confirmação explícita; zera a identidade e o auth (Gateway), e PRESERVA conversas, histórico, destinatários e auditoria", async () => {
    const g = gatewayFalso();
    await conectarNoBanco(conA); await confirmarNoBanco(conA, TEL_CONECTADO, { nome_operacional: "Agente Crescer" }); g.live = { status: "CONNECTED", qrDisponivel: false, reconectando: false };
    await processarInbound({ organizacaoId: conA, evento: ev({ providerMessageId: "WA-PRES" }) }, dep(conA));
    await inserir("comunicacao_mensagens", saidaAntiga(conA, "histórico de saída"));
    await rejeita(conexao.desconectar({ confirmacaoExplicita: false }, OP_COM(), depsCon(g)), 400);
    assert.equal(g.chamadas.includes("desconectarConta"), false, "sem confirmação nada foi feito");
    await conexao.desconectar({ confirmacaoExplicita: true }, OP_COM(), depsCon(g));
    assert.ok(g.chamadas.includes("desconectarConta"), "o auth do Gateway foi removido/invalidado");
    const ident = await identLinha(conA);
    assert.deepEqual([ident.status, ident.telefone_hash, ident.confirmado_em], ["SEM_CONTA", null, null]);
    assert.equal(await identidadeConfirmada({ supabase, env: {}, organizacaoConexaoId: conA, agora: AGORA }), false);
    assert.equal((await inbox(conA)).length, 1, "conversas preservadas");
    const { count } = await supabase.from("comunicacao_mensagens").select("id", { count: "exact", head: true }).eq("organizacao_id", conA);
    assert.equal(count, 1, "histórico de saída preservado");
    const { count: contatos } = await supabase.from("contatos_whatsapp").select("id", { count: "exact", head: true }).in("id", [destA.contatoId, destB.contatoId]);
    assert.equal(contatos, 2, "destinatários preservados");
    const acoes = (await auditorias(conA)).map((a) => a.acao);
    assert.ok(acoes.includes("WHATSAPP_DESCONECTADO"), "a auditoria registra e é preservada");
  });

  test("TROCAR CONTA: o envio fica bloqueado durante a transição e só volta depois que a NOVA identidade é confirmada", async () => {
    const g = gatewayFalso();
    await conectarNoBanco(conA); await confirmarNoBanco(conA); g.live = { status: "CONNECTED", qrDisponivel: false, reconectando: false };
    assert.equal(await identidadeConfirmada({ supabase, env: {}, organizacaoConexaoId: conA, agora: AGORA }), true);
    const { operacaoId } = await conexao.trocar({ confirmacaoExplicita: true }, OP_COM(), depsCon(g));
    assert.equal(await identidadeConfirmada({ supabase, env: {}, organizacaoConexaoId: conA, agora: AGORA }), false, "transição: bloqueado");
    g.mostrarQr(1);
    assert.equal(await identidadeConfirmada({ supabase, env: {}, organizacaoConexaoId: conA, agora: AGORA }), false, "aguardando QR: bloqueado");
    await g.conectou(conA, TEL_OUTRO);
    assert.equal(await identidadeConfirmada({ supabase, env: {}, organizacaoConexaoId: conA, agora: AGORA }), false, "nova conta ainda não confirmada: bloqueado");
    await conexao.confirmar({ operacaoId, ambiente: "TESTE" }, OP_COM(), depsCon(g));
    assert.equal(await identidadeConfirmada({ supabase, env: {}, organizacaoConexaoId: conA, agora: AGORA }), true, "nova identidade confirmada: libera");
    assert.equal((await identLinha(conA)).telefone_hash, hashTelefone(TEL_OUTRO), "vinculada à conta NOVA");
    await conectarNoBanco(conA, { telefone: TEL_CONECTADO });
    assert.equal(await identidadeConfirmada({ supabase, env: {}, organizacaoConexaoId: conA, agora: AGORA }), false, "a conta ANTIGA voltando exige nova confirmação");
  });

  test("auditoria: ator humano registrado, sem QR/segredo, e uma falha do Gateway é auditada como FALHOU", async () => {
    const g = gatewayFalso();
    g.svc.conexaoConectar = async () => { throw new Error("BAILEYS_GATEWAY_HTTP_500: gateway caiu"); };
    await assert.rejects(() => conexao.iniciar(OP_COM(), depsCon(g)));
    const aud = await auditorias(conA);
    const falhou = aud.find((a) => a.acao === "WHATSAPP_CONEXAO_FALHOU");
    assert.ok(falhou, "WHATSAPP_CONEXAO_FALHOU auditado");
    assert.equal(falhou.ator_email, `${tag}-com@example.com`);
    assert.equal(JSON.stringify(aud).includes(QR_SEGREDO), false);
    assert.equal((await identLinha(conA))?.operacao_id ?? null, null, "a falha liberou a trava");
  });
});
