// ABA CONEXÃO — estados, QR (geração, expiração, renovação, sigilo), confirmação da conta, desconexão, troca de número, permissão específica, trava de operação
// concorrente e auditoria. O Gateway é simulado por um objeto mutável; nenhuma rede, nenhum banco real.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  derivarEstado, statusIdentidade, hashTelefone, estado, iniciar, qr, novoQr, confirmar, cancelar, desconectar, trocar, definirIdentidade, temPermissaoConexao,
  identidadeConfirmada, resumoIdentidade, _zerarCachePerfil, _zerarQrAuditados, NOME_AGENTE, ESTADOS, ROTULO_ESTADO,
} from "../src/modules/administrativo/administrativo.comunicacao.conexao.js";
import { criarFakeDb } from "./helpers/central-fake-db.js";
import { instalarExecutorTeste } from "./helpers/gateway-operacao.js";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AGORA = new Date("2026-09-24T15:00:00.000Z");
const seg = (n) => new Date(AGORA.getTime() + n * 1000).toISOString();
const TEL = "+5511987654321";
const QR_SEGREDO = "2@SEGREDO-DO-QR-NAO-PODE-VAZAR,aaa,bbb";
const OP = { contaId: uuid(7), perfilId: uuid(8), nome: "Camila Operadora", email: "camila@crescer.com", superadmin: false, painelAdministrativo: true };
const SUPER = { ...OP, contaId: uuid(9), superadmin: true, painelAdministrativo: false };
// Ator SEM SuperAdmin e SEM Painel Administrativo — o router já barra antes (403); aqui prova a defesa em profundidade do service.
const SEM_PERMISSAO = { ...OP, contaId: uuid(10), painelAdministrativo: false };

/** Gateway falso, mutável: cada teste move o estado como o Baileys faria. */
function gatewayFalso() {
  const g = {
    live: { status: "DISCONNECTED", qrDisponivel: false, reconectando: false, tentativasReconexao: 0, ultimoFechamento: null },
    qr: { qr: null, geradoEm: null, expiraEm: null, ordem: 0 },
    perfil: { disponivel: true, nome: "Crescer Teste", telefoneE164: TEL, fotoUrl: "https://pps.whatsapp.net/v/x.jpg", descricao: "Automação de delivery", tipoConta: "DESCONHECIDO" },
    chamadas: [], falhar: {},
  };
  const reg = (n) => { g.chamadas.push(n); if (g.falhar[n]) throw g.falhar[n]; };
  g.svc = {
    conexaoStatus: async () => { reg("status"); if (g.inalcancavel) throw new Error("ECONNREFUSED"); return { ...g.live }; },
    conexaoQr: async () => { reg("qr"); return { ...g.qr, svg: g.qr.qr ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" data-ordem="${g.qr.ordem}"></svg>` : null }; },
    conexaoPerfil: async () => { reg("perfil"); return g.perfil; },
    conexaoConectar: async () => { reg("conectar"); g.live = { ...g.live, status: "CONNECTING" }; return { ok: true }; },
    conexaoDesconectarConta: async () => { reg("desconectarConta"); g.live = { ...g.live, status: "DISCONNECTED", qrDisponivel: false }; return { ok: true, desvinculado: true }; },
    conexaoEncerrar: async () => { reg("encerrar"); g.live = { ...g.live, status: "DISCONNECTED", qrDisponivel: false }; return { ok: true }; },
  };
  g.mostrarQr = (valor, ordem) => { g.live = { ...g.live, status: "CONNECTING", qrDisponivel: true }; g.qr = { qr: valor, geradoEm: seg(-5), expiraEm: seg(ordem === 1 ? 55 : 15), ordem }; };
  g.conectou = () => { g.live = { ...g.live, status: "CONNECTED", qrDisponivel: false }; g.qr = { qr: null, geradoEm: null, expiraEm: null, ordem: 0 }; };
  return g;
}

function montar({ conexoes, identidade, g = gatewayFalso() } = {}) {
  const db = criarFakeDb({
    whatsapp_conexoes: conexoes ?? [{ organizacao_id: ORG, provider_instance_id: "default", status: "DISCONNECTED", telefone_e164: null, connected_at: null, disconnected_at: null, last_seen_at: seg(-20), lease_expires_at: seg(30), gateway_version: "1.2.3", last_error_class: null, desired_connection_state: "DISCONNECTED" }],
    whatsapp_identidade: identidade ?? [],
    comunicacao_mensagens: [{ id: "m1" }], comunicacao_inbox_mensagens: [{ id: "i1" }], contatos_whatsapp: [{ id: "c1" }],
  }, { agora: () => AGORA.getTime() });
  const auditorias = [];
  const deps = { supabase: db, env: {}, agora: () => AGORA, organizacaoConexaoId: ORG, whatsAppService: g.svc, auditar: async (e) => auditorias.push(e) };
  instalarExecutorTeste(g.svc, deps);
  const conectou = g.conectou;
  g.conectou = () => {
    conectou(); g.perfil.authSessionId = uuid(700);
    Object.assign(db.tabelas.whatsapp_conexoes[0], { status: "CONNECTED", telefone_e164: g.perfil.telefoneE164, auth_session_id: g.perfil.authSessionId, auth_confirmado: true, connected_at: seg(-1), last_seen_at: seg(0) });
  };
  return { db, deps, g, auditorias };
}
const rejeita = (fn, status, codigo) => assert.rejects(fn, (e) => e.statusCode === status && (codigo === undefined || e.details?.codigo === codigo), `esperava ${status} ${codigo ?? ""}`);
const acoes = (a) => a.map((x) => x.acao);

beforeEach(() => { _zerarCachePerfil(); _zerarQrAuditados(); });

describe("confirmação persistente e operação obsoleta", () => {
  const preparar = async () => {
    const m = montar();
    const { operacaoId } = await iniciar(OP, m.deps);
    m.g.conectou();
    return { ...m, operacaoId };
  };
  test("operação expirada e retomada por QR são recusadas sem gravação", async () => {
    const m = await preparar();
    m.db.tabelas.whatsapp_identidade[0].operacao_expira_em = seg(-1);
    await rejeita(() => confirmar({ operacaoId: m.operacaoId }, OP, m.deps), 409);
    await rejeita(() => qr({ operacaoId: m.operacaoId }, OP, m.deps), 409);
    assert.notEqual(m.db.tabelas.whatsapp_identidade[0].status, "CONFIRMADA");
  });
  test("confirmação depois do cancelamento é recusada", async () => {
    const m = await preparar();
    await cancelar({ operacaoId: m.operacaoId }, OP, m.deps);
    await rejeita(() => confirmar({ operacaoId: m.operacaoId }, OP, m.deps), 409);
    assert.equal(m.db.tabelas.whatsapp_identidade[0].status, "SEM_CONTA");
  });
  test("B assume durante consulta do perfil: A não grava identidade e não encerra B", async () => {
    const m = await preparar();
    const linha = m.db.tabelas.whatsapp_identidade[0];
    linha.telefone_hash = hashTelefone("+12025550100");
    const hashAnterior = linha.telefone_hash;
    let liberar, entrou;
    const barreira = new Promise((r) => { liberar = r; });
    const consulta = new Promise((r) => { entrou = r; });
    m.g.svc.conexaoPerfil = async () => { entrou(); await barreira; return m.g.perfil; };
    const pendente = confirmar({ operacaoId: m.operacaoId }, OP, m.deps);
    const rejeitada = rejeita(() => pendente, 409, "OPERACAO_INVALIDA");
    await consulta;
    linha.operacao_expira_em = seg(-1);
    const { data } = await m.db.rpc("whatsapp_operacao_iniciar", { p_organizacao_id: ORG, p_provider_instance_id: "default", p_tipo: "TROCAR", p_por: OP.perfilId });
    const b = data[0].operacao_id;
    assert.notEqual(b, m.operacaoId);
    liberar(); await rejeitada;
    assert.equal(linha.operacao_id, b);
    assert.equal(linha.operacao_tipo, "TROCAR");
    assert.equal(linha.telefone_hash, hashAnterior);
    const antes = m.g.chamadas.length;
    await rejeita(() => cancelar({ operacaoId: m.operacaoId }, OP, m.deps), 409);
    assert.equal(m.g.chamadas.length, antes);
  });
  test("confirmações simultâneas têm uma única decisão válida", async () => {
    const m = await preparar();
    const r = await Promise.allSettled([confirmar({ operacaoId: m.operacaoId }, OP, m.deps), confirmar({ operacaoId: m.operacaoId }, OP, m.deps)]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(m.auditorias.filter((x) => x.acao === "WHATSAPP_CONECTADO").length, 1);
  });
  test("erro do perfil vivo não confirma identidade", async () => {
    const m = await preparar();
    m.g.svc.conexaoPerfil = async () => { throw new Error("gateway indisponível"); };
    await rejeita(() => confirmar({ operacaoId: m.operacaoId }, OP, m.deps), 409, "SEM_IDENTIDADE");
    assert.notEqual(m.db.tabelas.whatsapp_identidade[0].status, "CONFIRMADA");
  });
  test("geração da conexão mudou durante perfil: rejeita mesmo telefone", async () => {
    const m = await preparar();
    m.g.svc.conexaoPerfil = async () => { m.db.tabelas.whatsapp_conexoes[0].auth_session_id = uuid(701); return m.g.perfil; };
    await rejeita(() => confirmar({ operacaoId: m.operacaoId }, OP, m.deps), 409, "OPERACAO_INVALIDA");
  });
});

test("cancelamento atrasado não desconecta uma conta já confirmada", async () => {
  const m = montar();
  const { operacaoId } = await iniciar(OP, m.deps);
  m.g.conectou();
  await confirmar({ operacaoId }, OP, m.deps);
  const chamadasAntes = m.g.chamadas.length;
  await rejeita(() => cancelar({ operacaoId }, OP, m.deps), 409, "OPERACAO_INVALIDA");
  assert.equal(m.g.chamadas.length, chamadasAntes);
  assert.equal(m.db.tabelas.whatsapp_identidade[0].status, "CONFIRMADA");
});

test("QR de operação expirada é recusado antes de consultar o Gateway", async () => {
  const m = montar();
  const { operacaoId } = await iniciar(OP, m.deps);
  m.db.tabelas.whatsapp_identidade[0].operacao_expira_em = seg(-1);
  const chamadasAntes = m.g.chamadas.length;
  await rejeita(() => qr({ operacaoId }, OP, m.deps), 409, "OPERACAO_INVALIDA");
  assert.equal(m.g.chamadas.length, chamadasAntes);
});

test("confirmar sem telefone vivo não reutiliza telefone antigo do heartbeat", async () => {
  const m = montar();
  const { operacaoId } = await iniciar(OP, m.deps);
  m.g.conectou();
  m.g.perfil.telefoneE164 = null;
  m.db.tabelas.whatsapp_conexoes[0].telefone_e164 = TEL;
  await rejeita(() => confirmar({ operacaoId }, OP, m.deps), 409, "SEM_IDENTIDADE");
  assert.notEqual(m.db.tabelas.whatsapp_identidade[0].status, "CONFIRMADA");
});

test("cache de perfil não mistura organizações nem reutiliza conta anterior após troca", async () => {
  const a = montar(); a.g.conectou();
  const b = montar(); b.g.conectou();
  b.deps.organizacaoConexaoId = uuid(200);
  b.g.perfil = { ...b.g.perfil, nome: "Outra conta", telefoneE164: "+5511900000002" };
  assert.equal((await estado(SUPER, a.deps)).conta.nome, "Crescer Teste");
  assert.equal((await estado(SUPER, b.deps)).conta.nome, "Outra conta");
  a.db.tabelas.whatsapp_conexoes[0].telefone_e164 = TEL;
  a.db.tabelas.whatsapp_conexoes[0].connected_at = seg(-60);
  await estado(SUPER, a.deps);
  a.db.tabelas.whatsapp_conexoes[0].telefone_e164 = "+5511900000003";
  a.db.tabelas.whatsapp_conexoes[0].connected_at = seg(-1);
  a.g.perfil = { ...a.g.perfil, nome: "Conta substituída", telefoneE164: "+5511900000003" };
  assert.equal((await estado(SUPER, a.deps)).conta.nome, "Conta substituída");
});

describe("estados (derivarEstado)", () => {
  const db = (o = {}) => ({ status: "CONNECTED", last_seen_at: seg(-30), ...o });
  test("os 6 estados existem e têm rótulo amigável", () => {
    assert.deepEqual([...ESTADOS].sort(), ["AUTH_ERROR", "CONNECTED", "CONNECTING", "DISCONNECTED", "RECONNECTING", "WAITING_QR"]);
    assert.deepEqual(ROTULO_ESTADO, { CONNECTED: "Conectado", DISCONNECTED: "Desconectado", CONNECTING: "Conectando", WAITING_QR: "Aguardando leitura do QR Code", RECONNECTING: "Reconectando", AUTH_ERROR: "Sessão inválida" });
  });
  test("Gateway responde: CONNECTED / DISCONNECTED / CONNECTING / WAITING_QR / RECONNECTING / AUTH_ERROR", () => {
    const d = (live) => derivarEstado({ live, agora: AGORA });
    assert.equal(d({ status: "CONNECTED" }), "CONNECTED");
    assert.equal(d({ status: "DISCONNECTED" }), "DISCONNECTED");
    assert.equal(d({ status: "CONNECTING" }), "CONNECTING");
    assert.equal(d({ status: "CONNECTING", qrDisponivel: true }), "WAITING_QR");
    assert.equal(d({ status: "CONNECTING", reconectando: true }), "RECONNECTING");
    assert.equal(d({ status: "DISCONNECTED", reconectando: true }), "RECONNECTING");
    assert.equal(d({ status: "LOGGED_OUT" }), "AUTH_ERROR");
    assert.equal(d({ status: "QUALQUER-COISA" }), "DISCONNECTED");
  });
  test("QR com reconexão pendente: o QR vence (o operador precisa escanear)", () => {
    assert.equal(derivarEstado({ live: { status: "CONNECTING", qrDisponivel: true, reconectando: true }, agora: AGORA }), "WAITING_QR");
  });
  test("SEM Gateway só o banco conta: CONNECTED com heartbeat velho ⇒ Desconectado; LOGGED_OUT ⇒ Sessão inválida", () => {
    assert.equal(derivarEstado({ live: null, db: db(), agora: AGORA }), "CONNECTED");
    assert.equal(derivarEstado({ live: null, db: db({ last_seen_at: seg(-600) }), agora: AGORA }), "DISCONNECTED");
    assert.equal(derivarEstado({ live: null, db: db({ last_seen_at: null }), agora: AGORA }), "DISCONNECTED");
    assert.equal(derivarEstado({ live: null, db: db({ status: "LOGGED_OUT" }), agora: AGORA }), "AUTH_ERROR");
    assert.equal(derivarEstado({ live: null, db: null, agora: AGORA }), "DISCONNECTED");
  });
  test("statusIdentidade: só CONFIRMADA quando o número conectado é o confirmado", () => {
    const ident = { status: "CONFIRMADA", telefone_hash: hashTelefone(TEL) };
    assert.equal(statusIdentidade({ conectado: true, identidade: ident, telefoneAtual: TEL }), "CONFIRMADA");
    assert.equal(statusIdentidade({ conectado: true, identidade: ident, telefoneAtual: "+5511900000000" }), "PENDENTE_CONFIRMACAO", "outro número");
    assert.equal(statusIdentidade({ conectado: true, identidade: null, telefoneAtual: TEL }), "PENDENTE_CONFIRMACAO");
    assert.equal(statusIdentidade({ conectado: false, identidade: ident, telefoneAtual: TEL }), "SEM_CONTA");
  });
});

describe("estado (GET)", () => {
  test("desconectado: sem conta, sem foto, sem número; a permissão aparece; nada de segredo", async () => {
    const { deps } = montar();
    const e = await estado(OP, deps);
    assert.deepEqual([e.estado, e.rotulo, e.conectado, e.conta, e.permissoes.gerenciar, e.identidade.status], ["DISCONNECTED", "Desconectado", false, null, true, "SEM_CONTA"]);
  });

  test("conectado: foto, nome, número MASCARADO, tipo, descrição, gateway, heartbeat, conexão e saúde", async () => {
    const g = gatewayFalso(); g.conectou();
    const { deps } = montar({ g, conexoes: [{ organizacao_id: ORG, provider_instance_id: "default", status: "CONNECTED", telefone_e164: TEL, connected_at: seg(-3600), disconnected_at: seg(-7200), last_seen_at: seg(-20), lease_expires_at: seg(30), gateway_version: "1.2.3" }] });
    const e = await estado(OP, deps);
    assert.deepEqual([e.estado, e.conectado, e.conta.nome, e.conta.fotoUrl, e.conta.telefoneMascarado, e.conta.tipoContaRotulo, e.conta.descricao, e.conta.iniciais],
      ["CONNECTED", true, "Crescer Teste", "https://pps.whatsapp.net/v/x.jpg", "********21", "Tipo não identificado", "Automação de delivery", "CT"]);
    assert.deepEqual([e.saude.rotulo, e.saude.conectadoEm, e.saude.ultimoSinalEm], ["Saudável", seg(-3600), seg(-20)]);
    assert.deepEqual([e.tecnico.gateway, e.tecnico.socket, e.tecnico.versao, e.tecnico.sessaoValida, e.tecnico.ultimaConexaoEm], ["Respondendo", "Aberto", "1.2.3", true, seg(-3600)]);
    const txt = JSON.stringify(e);
    assert.ok(!txt.includes("5511987654321") && !txt.includes(TEL), "telefone completo nunca sai");
    assert.ok(!/auth|signal|creds|token|secret|hmac|noise|privateKey/i.test(txt.replace(/"sessaoValida"|"gateway"/g, "")), "nenhum segredo");
  });

  test("foto indisponível ⇒ fotoUrl null (a interface usa as iniciais); descrição ausente ⇒ null (nada inventado)", async () => {
    const g = gatewayFalso(); g.conectou(); g.perfil = { disponivel: true, nome: "Loja X", telefoneE164: TEL, fotoUrl: null, descricao: null, tipoConta: "BUSINESS" };
    const { deps } = montar({ g, conexoes: [{ organizacao_id: ORG, provider_instance_id: "default", status: "CONNECTED", telefone_e164: TEL, last_seen_at: seg(-5) }] });
    const e = await estado(OP, deps);
    assert.deepEqual([e.conta.fotoUrl, e.conta.descricao, e.conta.tipoContaRotulo, e.conta.iniciais], [null, null, "WhatsApp Business", "LX"]);
  });

  test("perfil indisponível não derruba o estado (a conexão segue valendo)", async () => {
    const g = gatewayFalso(); g.conectou(); g.falhar.perfil = new Error("timeout");
    const { deps } = montar({ g, conexoes: [{ organizacao_id: ORG, provider_instance_id: "default", status: "CONNECTED", telefone_e164: TEL, last_seen_at: seg(-5) }] });
    const e = await estado(OP, deps);
    assert.deepEqual([e.estado, e.conta.nome, e.conta.fotoUrl, e.conta.telefoneMascarado], ["CONNECTED", null, null, "********21"]);
  });

  test("Gateway inalcançável ⇒ usa o banco e sinaliza semSinal", async () => {
    const g = gatewayFalso(); g.inalcancavel = true;
    const { deps } = montar({ g, conexoes: [{ organizacao_id: ORG, provider_instance_id: "default", status: "CONNECTED", telefone_e164: TEL, last_seen_at: seg(-5) }] });
    const e = await estado(OP, deps);
    assert.deepEqual([e.estado, e.semSinal, e.tecnico.gateway], ["CONNECTED", true, "Sem resposta"]);
  });

  test("reconectando e sessão inválida (auth_error) aparecem como tais, com o motivo da última desconexão", async () => {
    const g = gatewayFalso(); g.live = { status: "CONNECTING", qrDisponivel: false, reconectando: true, tentativasReconexao: 2, ultimoFechamento: { em: seg(-10), razao: "connectionLost", codigo: 408 } };
    const r = await estado(OP, montar({ g }).deps);
    assert.deepEqual([r.estado, r.reconectando, r.tecnico.tentativasReconexao, r.tecnico.motivoUltimaDesconexao, r.saude.id], ["RECONNECTING", true, 2, "A conexão com o WhatsApp caiu", "atencao"]);
    const g2 = gatewayFalso(); g2.live = { status: "LOGGED_OUT", ultimoFechamento: { em: seg(-10), razao: "loggedOut", codigo: 401 } };
    const a = await estado(OP, montar({ g: g2 }).deps);
    assert.deepEqual([a.estado, a.rotulo, a.tecnico.motivoUltimaDesconexao], ["AUTH_ERROR", "Sessão inválida", "A conta foi desvinculada pelo aparelho"]);
  });

  test("identidade INTERNA separada do número: ambiente e nome operacional só valem para o número confirmado", async () => {
    const g = gatewayFalso(); g.conectou();
    const conexoes = [{ organizacao_id: ORG, provider_instance_id: "default", status: "CONNECTED", telefone_e164: TEL, last_seen_at: seg(-5) }];
    const base = { organizacao_id: ORG, provider_instance_id: "default", ambiente: "PRODUCAO", nome_operacional: NOME_AGENTE, status: "CONFIRMADA", confirmado_em: seg(-100) };
    const mesmo = await estado(OP, montar({ g, conexoes, identidade: [{ ...base, telefone_hash: hashTelefone(TEL) }] }).deps);
    assert.deepEqual([mesmo.identidade.status, mesmo.identidade.nomeOperacional, mesmo.identidade.agenteCrescer, mesmo.identidade.ambienteRotulo], ["CONFIRMADA", "Agente Crescer", true, "Produção"]);
    _zerarCachePerfil();
    const outro = await estado(OP, montar({ g, conexoes, identidade: [{ ...base, telefone_hash: hashTelefone("+5511900000000") }] }).deps);
    assert.deepEqual([outro.identidade.status, outro.identidade.nomeOperacional, outro.identidade.agenteCrescer], ["PENDENTE_CONFIRMACAO", null, false], "outro número: o nome NÃO acompanha");
  });

  test("ator sem SuperAdmin e sem Painel (defesa em profundidade) lê o estado e VÊ a operação em andamento, mas sem o id que permitiria agir", async () => {
    const ident = [{ organizacao_id: ORG, provider_instance_id: "default", ambiente: "TESTE", status: "SEM_CONTA", operacao_id: uuid(50), operacao_tipo: "CONECTAR", operacao_expira_em: seg(200) }];
    const { deps } = montar({ identidade: ident });
    assert.equal((await estado(OP, deps)).operacao.tipo, "CONECTAR");
    const sem = await estado(SEM_PERMISSAO, deps);
    assert.equal(sem.permissoes.gerenciar, false);
    assert.equal(sem.operacao.tipo, "CONECTAR"); assert.equal(sem.operacao.podeReconciliar, false);
    assert.equal("id" in sem.operacao, false, "o id da operação só sai para quem gerencia");
    assert.equal(JSON.stringify(sem).includes(uuid(50)), false);
    assert.equal((await estado(OP, deps)).operacao.id, uuid(50), "quem gerencia continua recebendo o id");
  });
});

describe("permissão da Conexão = mesma regra da Comunicação (SuperAdmin OU Painel Administrativo)", () => {
  test("SuperAdmin passa; usuário do Painel Administrativo passa SEM permissão extra; o resto NÃO", async () => {
    assert.equal(await temPermissaoConexao(SUPER), true);
    assert.equal(await temPermissaoConexao(OP), true);
    assert.equal(await temPermissaoConexao(SEM_PERMISSAO), false);
    assert.equal(await temPermissaoConexao({}), false);
    assert.equal(await temPermissaoConexao(null), false);
  });

  test("FAIL-CLOSED: só o booleano `true` explícito concede (valores truthy não passam) e o banco nunca é consultado", async () => {
    for (const valor of ["true", 1, "sim", {}, []]) {
      assert.equal(await temPermissaoConexao({ ...SEM_PERMISSAO, painelAdministrativo: valor }), false, `painelAdministrativo=${JSON.stringify(valor)}`);
      assert.equal(await temPermissaoConexao({ ...SEM_PERMISSAO, superadmin: valor }), false, `superadmin=${JSON.stringify(valor)}`);
    }
  });

  test("TODA ação e o QR recusam quem não tem a permissão (403) — sem chamar o Gateway, sem auditar, sem trava", async () => {
    const { deps, g, auditorias, db } = montar();
    const chamadasIniciais = g.chamadas.length;
    const ident = uuid(60);
    await rejeita(() => iniciar(SEM_PERMISSAO, deps), 403);
    await rejeita(() => qr({ operacaoId: ident }, SEM_PERMISSAO, deps), 403);
    await rejeita(() => confirmar({ operacaoId: ident }, SEM_PERMISSAO, deps), 403);
    await rejeita(() => cancelar({ operacaoId: ident }, SEM_PERMISSAO, deps), 403);
    await rejeita(() => desconectar({ confirmacaoExplicita: true }, SEM_PERMISSAO, deps), 403);
    await rejeita(() => trocar({ confirmacaoExplicita: true }, SEM_PERMISSAO, deps), 403);
    await rejeita(() => definirIdentidade({ ambiente: "PRODUCAO" }, SEM_PERMISSAO, deps), 403);
    assert.equal(g.chamadas.length, chamadasIniciais);
    assert.equal(auditorias.length, 0);
    assert.equal((db.tabelas.whatsapp_identidade ?? []).length, 0, "nenhuma trava foi criada");
  });

  test("sem ator identificado ⇒ 401", async () => {
    const { deps } = montar();
    await rejeita(() => iniciar({}, deps), 401);
    await rejeita(() => iniciar(null, deps), 401);
  });
});

describe("conectar: iniciar → QR → escanear → identificar → confirmar", () => {
  test("iniciar: cria a operação, chama o /connect do Gateway UMA vez e audita CONEXAO_INICIADA", async () => {
    const { deps, g, auditorias } = montar();
    const r = await iniciar(OP, deps);
    assert.match(r.operacaoId, /^[0-9a-f-]{36}$/);
    assert.equal(g.chamadas.filter((c) => c === "conectar").length, 1);
    assert.deepEqual(acoes(auditorias), ["WHATSAPP_CONEXAO_INICIADA"]);
    assert.deepEqual([auditorias[0].atorId, auditorias[0].perfilId, auditorias[0].perfilNome, auditorias[0].atorEmail], [OP.contaId, OP.perfilId, OP.nome, OP.email]);
  });

  test("já conectado ⇒ 409 JA_CONECTADO (o caminho é Trocar número); nada é criado", async () => {
    const g = gatewayFalso(); g.conectou();
    const { deps, auditorias } = montar({ g });
    await rejeita(() => iniciar(OP, deps), 409, "JA_CONECTADO");
    assert.equal(auditorias.length, 0);
  });

  test("erro após consumo do token ⇒ 409, auditoria e trava INCERTA preservada", async () => {
    const g = gatewayFalso(); g.falhar.conectar = new Error("BAILEYS_GATEWAY_UNREACHABLE: ECONNREFUSED");
    const { deps, auditorias, db } = montar({ g });
    await rejeita(() => iniciar(OP, deps), 409, "CONEXAO_INDISPONIVEL");
    assert.deepEqual(acoes(auditorias), ["WHATSAPP_CONEXAO_INICIADA", "WHATSAPP_CONEXAO_FALHOU"]);
    assert.equal(db.tabelas.whatsapp_identidade[0].efeito_estado, "INCERTO");
    await assert.rejects(() => iniciar(OP, deps));
  });

  test("gerar QR: o valor chega ao operador com permissão; audita QR_GERADO UMA vez por QR (só a ORDEM, nunca o valor)", async () => {
    const { deps, g, auditorias } = montar();
    const { operacaoId } = await iniciar(OP, deps);
    g.mostrarQr(QR_SEGREDO, 1);
    const a = await qr({ operacaoId }, OP, deps);
    assert.deepEqual([a.estado, a.rotulo, a.disponivel, a.ordem, a.identificada], ["WAITING_QR", "Aguardando leitura do QR Code", true, 1, false]);
    assert.match(a.svg, /^<svg /);
    assert.ok(!JSON.stringify(a).includes("SEGREDO"), "o navegador recebe só o desenho, NUNCA a string crua do QR");
    assert.equal(a.segundosRestantes, 55);
    await qr({ operacaoId }, OP, deps); await qr({ operacaoId }, OP, deps);
    assert.equal(auditorias.filter((x) => x.acao === "WHATSAPP_QR_GERADO").length, 1, "polling não repete a auditoria");
    assert.deepEqual(auditorias.find((x) => x.acao === "WHATSAPP_QR_GERADO").detalhes, { operacao_id: operacaoId, ordem: 1 });
  });

  test("QR expirado: sem QR e segundosRestantes=0 (o operador vê 'Gerar novo QR Code'); novo QR ⇒ nova ordem e nova auditoria", async () => {
    const { deps, g, auditorias } = montar();
    const { operacaoId } = await iniciar(OP, deps);
    g.mostrarQr(QR_SEGREDO, 1); await qr({ operacaoId }, OP, deps);
    g.live = { ...g.live, qrDisponivel: false }; g.qr = { qr: null, geradoEm: null, expiraEm: null, ordem: 0 };   // expirou/fechou
    const exp = await qr({ operacaoId }, OP, deps);
    assert.deepEqual([exp.disponivel, exp.svg, exp.segundosRestantes, exp.ordem, exp.estado], [false, null, 0, 0, "CONNECTING"]);
    g.mostrarQr("2@OUTRO-QR-SEGREDO,ccc", 2); g.qr.geradoEm = seg(-2);
    const novo = await qr({ operacaoId }, OP, deps);
    assert.deepEqual([novo.disponivel, novo.ordem, /data-ordem="2"/.test(novo.svg)], [true, 2, true]);
    assert.deepEqual(auditorias.filter((x) => x.acao === "WHATSAPP_QR_GERADO").map((x) => x.detalhes.ordem), [1, 2]);
  });

  test("o QR NUNCA aparece em auditoria, nem em log (console), nem em erro", async () => {
    const linhas = []; const ol = console.log; const oe = console.error; const ow = console.warn;
    console.log = (l) => linhas.push(String(l)); console.error = (l) => linhas.push(String(l)); console.warn = (l) => linhas.push(String(l));
    let auditorias;
    try {
      const { deps, g, auditorias: a } = montar(); auditorias = a;
      const { operacaoId } = await iniciar(OP, deps);
      g.mostrarQr(QR_SEGREDO, 1); await qr({ operacaoId }, OP, deps);
      g.conectou(); await qr({ operacaoId }, OP, deps);
      await cancelar({ operacaoId }, OP, deps);
    } finally { console.log = ol; console.error = oe; console.warn = ow; }
    assert.ok(!JSON.stringify(auditorias).includes("SEGREDO"));
    assert.ok(!linhas.join("\n").includes("SEGREDO"));
  });

  test("a operação errada (ou expirada/de outro operador) não vê o QR (409)", async () => {
    const { deps, g } = montar();
    await iniciar(OP, deps); g.mostrarQr(QR_SEGREDO, 1);
    await rejeita(() => qr({ operacaoId: uuid(77) }, OP, deps), 409, "OPERACAO_INVALIDA");
    await rejeita(() => qr({ operacaoId: "nao-uuid" }, OP, deps), 400);
  });

  test("QR escaneado: o QR DESAPARECE da resposta na hora e a conta é IDENTIFICADA (foto, nome, número mascarado) — sem concluir em silêncio", async () => {
    const { deps, g } = montar();
    const { operacaoId } = await iniciar(OP, deps);
    g.mostrarQr(QR_SEGREDO, 1); g.conectou();
    const r = await qr({ operacaoId }, OP, deps);
    assert.deepEqual([r.estado, r.disponivel, r.svg, r.identificada, r.conta.nome, r.conta.telefoneMascarado, r.conta.fotoUrl], ["CONNECTED", false, null, true, "Crescer Teste", "********21", "https://pps.whatsapp.net/v/x.jpg"]);
    assert.ok(!JSON.stringify(r).includes("SEGREDO") && !JSON.stringify(r).includes("5511987654321"));
    // conectada, mas ainda NÃO confirmada: o envio manual fica bloqueado
    assert.equal(await identidadeConfirmada(deps), false);
  });

  test("confirmar: grava a identidade (hash do número, quem confirmou, ambiente), audita CONECTADO, libera a trava e o envio passa a valer", async () => {
    const g2 = gatewayFalso(); const m = montar({ g: g2, conexoes: [{ organizacao_id: ORG, provider_instance_id: "default", status: "DISCONNECTED", telefone_e164: null, last_seen_at: seg(-5) }] });
    const op = await iniciar(OP, m.deps);
    g2.mostrarQr(QR_SEGREDO, 1); g2.conectou();
    m.db.tabelas.whatsapp_conexoes[0].status = "CONNECTED"; m.db.tabelas.whatsapp_conexoes[0].telefone_e164 = TEL;
    const e = await confirmar({ operacaoId: op.operacaoId, utilizarComoAgente: false, ambiente: "TESTE" }, OP, m.deps);
    assert.deepEqual([e.identidade.status, e.identidade.ambiente, e.identidade.nomeOperacional], ["CONFIRMADA", "TESTE", null]);
    const linha = m.db.tabelas.whatsapp_identidade[0];
    assert.deepEqual([linha.status, linha.telefone_hash, linha.confirmado_por, linha.operacao_id], ["CONFIRMADA", hashTelefone(TEL), OP.perfilId, null]);
    assert.ok(!JSON.stringify(linha).includes("987654321"), "o número não é guardado");
    assert.deepEqual(acoes(m.auditorias), ["WHATSAPP_CONEXAO_INICIADA", "WHATSAPP_CONECTADO"]);
    assert.deepEqual(m.auditorias[1].detalhes, { operacao_id: op.operacaoId, telefone_mascarado: "********21", ambiente: "TESTE", agente_crescer: false, tipo_conta: "DESCONHECIDO" });
    assert.equal(await identidadeConfirmada(m.deps), true);
  });

  test("'Utilizar como Agente Crescer' marca o nome operacional — e só nessa confirmação", async () => {
    const g = gatewayFalso(); const m = montar({ g });
    const { operacaoId } = await iniciar(OP, m.deps);
    g.conectou(); m.db.tabelas.whatsapp_conexoes[0].status = "CONNECTED"; m.db.tabelas.whatsapp_conexoes[0].telefone_e164 = TEL;
    const e = await confirmar({ operacaoId, utilizarComoAgente: true, ambiente: "PRODUCAO" }, OP, m.deps);
    assert.deepEqual([e.identidade.agenteCrescer, e.identidade.nomeOperacional, e.identidade.ambienteRotulo], [true, NOME_AGENTE, "Produção"]);
    const resumo = await resumoIdentidade(m.deps);
    assert.deepEqual([resumo.confirmada, resumo.nomeOperacional, resumo.ambiente], [true, NOME_AGENTE, "PRODUCAO"]);
  });

  test("confirmar sem estar conectado ⇒ 409 NAO_CONECTADO; ambiente inválido ⇒ 400; nada é gravado", async () => {
    const m = montar();
    const { operacaoId } = await iniciar(OP, m.deps);
    await rejeita(() => confirmar({ operacaoId }, OP, m.deps), 409, "NAO_CONECTADO");
    await rejeita(() => confirmar({ operacaoId, ambiente: "HOMOLOG" }, OP, m.deps), 400, "AMBIENTE_INVALIDO");
    assert.notEqual(m.db.tabelas.whatsapp_identidade[0].status, "CONFIRMADA");
  });

  test("cancelar depois de escanear DESFAZ a sessão (reset no Gateway), limpa a identidade e audita DESCONECTADO", async () => {
    const g = gatewayFalso(); const m = montar({ g });
    const { operacaoId } = await iniciar(OP, m.deps); g.conectou();
    const e = await cancelar({ operacaoId }, OP, m.deps);
    assert.equal(g.chamadas.filter((c) => c === "desconectarConta").length, 1);
    assert.deepEqual([e.estado, m.db.tabelas.whatsapp_identidade[0].operacao_id], ["DISCONNECTED", null]);
    assert.deepEqual(acoes(m.auditorias), ["WHATSAPP_CONEXAO_INICIADA", "WHATSAPP_DESCONECTADO"]);
  });

  test("cancelar o assistente ANTES de escanear encerra o pareamento e audita CONEXAO_FALHOU (cancelada_pelo_operador)", async () => {
    const g = gatewayFalso(); const m = montar({ g });
    const { operacaoId } = await iniciar(OP, m.deps); g.mostrarQr(QR_SEGREDO, 1);
    await cancelar({ operacaoId }, OP, m.deps);
    assert.equal(g.chamadas.filter((c) => c === "encerrar").length, 1);
    assert.equal(m.auditorias.at(-1).acao, "WHATSAPP_CONEXAO_FALHOU");
    assert.equal(m.auditorias.at(-1).detalhes.motivo, "cancelada_pelo_operador");
    assert.ok(!JSON.stringify(m.auditorias).includes("SEGREDO"));
  });
});

describe("novo QR (o QR expirou)", () => {
  test("reabre o pareamento na MESMA operação: fecha o que estava preso e chama o /connect UMA vez; nunca uma segunda sessão", async () => {
    const g = gatewayFalso(); const m = montar({ g });
    const { operacaoId } = await iniciar(OP, m.deps);
    g.live = { ...g.live, status: "CONNECTING", qrDisponivel: false };           // pareamento preso sem QR
    g.chamadas.length = 0;
    assert.deepEqual(await novoQr({ operacaoId }, OP, m.deps), { ok: true });
    assert.deepEqual(g.chamadas.filter((c) => ["encerrar", "conectar"].includes(c)), ["encerrar", "conectar"]);
    assert.equal(m.db.tabelas.whatsapp_identidade[0].operacao_id, operacaoId, "mesma trava");
  });
  test("socket já fechado (DISCONNECTED): só reconecta; já CONNECTED ⇒ 409; operação errada ⇒ 409; sem permissão ⇒ 403", async () => {
    const g = gatewayFalso(); const m = montar({ g });
    const { operacaoId } = await iniciar(OP, m.deps);
    g.live = { ...g.live, status: "DISCONNECTED" }; g.chamadas.length = 0;
    await novoQr({ operacaoId }, OP, m.deps);
    assert.deepEqual(g.chamadas.filter((c) => ["encerrar", "conectar"].includes(c)), ["conectar"]);
    g.conectou();
    await rejeita(() => novoQr({ operacaoId }, OP, m.deps), 409, "JA_CONECTADO");
    await rejeita(() => novoQr({ operacaoId: uuid(77) }, OP, m.deps), 409, "OPERACAO_INVALIDA");
    await rejeita(() => novoQr({ operacaoId }, SEM_PERMISSAO, m.deps), 403);
  });
  test("Gateway recusa ⇒ 409 amigável e auditoria CONEXAO_FALHOU (sem segredo)", async () => {
    const g = gatewayFalso(); const m = montar({ g });
    const { operacaoId } = await iniciar(OP, m.deps);
    g.live = { ...g.live, status: "DISCONNECTED" }; g.falhar.conectar = new Error("BAILEYS_GATEWAY_UNREACHABLE");
    await rejeita(() => novoQr({ operacaoId }, OP, m.deps), 409, "CONEXAO_INDISPONIVEL");
    assert.equal(m.auditorias.at(-1).acao, "WHATSAPP_CONEXAO_FALHOU");
  });
});

describe("desconectar", () => {
  const conectada = () => {
    const g = gatewayFalso(); g.conectou();
    return montar({ g, conexoes: [{ organizacao_id: ORG, provider_instance_id: "default", status: "CONNECTED", telefone_e164: TEL, last_seen_at: seg(-5) }],
      identidade: [{ organizacao_id: ORG, provider_instance_id: "default", ambiente: "PRODUCAO", nome_operacional: NOME_AGENTE, status: "CONFIRMADA", telefone_hash: hashTelefone(TEL), confirmado_em: seg(-100) }] });
  };

  test("exige confirmação explícita: sem ela ⇒ 400 e NADA acontece", async () => {
    const m = conectada();
    for (const c of [undefined, false, "true", 1, null]) await rejeita(() => desconectar({ confirmacaoExplicita: c }, OP, m.deps), 400, "CONFIRMACAO_OBRIGATORIA");
    assert.equal(m.g.chamadas.filter((c) => c === "desconectarConta").length, 0);
    assert.equal(m.auditorias.length, 0);
  });

  test("com confirmação: desconecta a conta no Gateway, limpa a identidade (nome operacional inclusive) e audita DESCONECTADO", async () => {
    const m = conectada();
    const e = await desconectar({ confirmacaoExplicita: true }, OP, m.deps);
    assert.equal(m.g.chamadas.filter((c) => c === "desconectarConta").length, 1);
    const linha = m.db.tabelas.whatsapp_identidade[0];
    assert.deepEqual([e.estado, linha.status, linha.telefone_hash, linha.nome_operacional, linha.operacao_id], ["DISCONNECTED", "SEM_CONTA", null, null, null]);
    assert.equal(linha.ambiente, "PRODUCAO", "o ambiente é configuração interna e permanece");
    assert.deepEqual(acoes(m.auditorias), ["WHATSAPP_DESCONECTADO"]);
    assert.equal(m.auditorias[0].detalhes.telefone_mascarado, "********21");
  });

  test("NUNCA apaga o histórico de comunicação: nenhuma tabela de mensagens/contatos/inbox é tocada", async () => {
    const m = conectada();
    await desconectar({ confirmacaoExplicita: true }, OP, m.deps);
    const tocadas = new Set(m.db.consultas.filter((c) => c.modo !== "select").map((c) => c.tabela));
    for (const t of ["comunicacao_mensagens", "comunicacao_inbox_mensagens", "comunicacao_inbox_leituras", "contatos_whatsapp", "comunicacao_tentativas"]) assert.ok(!tocadas.has(t), `não pode escrever em ${t}`);
    assert.equal(m.db.tabelas.comunicacao_mensagens.length, 1);
    assert.equal(m.db.tabelas.comunicacao_inbox_mensagens.length, 1);
  });

  test("Gateway falha ao desconectar ⇒ identidade preservada, resultado INCERTO e trava mantida", async () => {
    const m = conectada(); m.g.falhar.desconectarConta = new Error("BAILEYS_GATEWAY_HTTP_500");
    await rejeita(() => desconectar({ confirmacaoExplicita: true }, OP, m.deps), 409, "DESCONECTAR_FALHOU");
    const linha = m.db.tabelas.whatsapp_identidade[0];
    assert.deepEqual([linha.status, linha.nome_operacional, linha.efeito_estado], ["CONFIRMADA", NOME_AGENTE, "INCERTO"]);
    assert.equal(m.auditorias.at(-1).acao, "WHATSAPP_CONEXAO_FALHOU");
  });
});

describe("trocar número", () => {
  test("sequência segura: desconecta a conta atual ANTES de gerar o QR; nunca há duas sessões ao mesmo tempo", async () => {
    const g = gatewayFalso(); g.conectou();
    const m = montar({ g, conexoes: [{ organizacao_id: ORG, provider_instance_id: "default", status: "CONNECTED", telefone_e164: TEL, last_seen_at: seg(-5) }],
      identidade: [{ organizacao_id: ORG, provider_instance_id: "default", ambiente: "TESTE", nome_operacional: NOME_AGENTE, status: "CONFIRMADA", telefone_hash: hashTelefone(TEL), confirmado_em: seg(-9) }] });
    const r = await trocar({ confirmacaoExplicita: true }, OP, m.deps);
    assert.deepEqual(g.chamadas.filter((c) => ["desconectarConta", "conectar"].includes(c)), ["desconectarConta", "conectar"], "ordem: desconectar → conectar");
    assert.ok(r.operacaoId);
    assert.equal(m.db.tabelas.whatsapp_identidade[0].operacao_id, r.operacaoId, "a trava continua até confirmar o novo número");
    assert.deepEqual([m.db.tabelas.whatsapp_identidade[0].status, m.db.tabelas.whatsapp_identidade[0].nome_operacional], ["SEM_CONTA", null]);
    assert.deepEqual(acoes(m.auditorias), ["WHATSAPP_CONEXAO_INICIADA", "WHATSAPP_DESCONECTADO"]);
    assert.equal(m.auditorias[1].detalhes.motivo, "troca_de_numero");
  });

  test("exige confirmação explícita; e enquanto a troca está em andamento, iniciar/desconectar/trocar de novo ⇒ 409", async () => {
    const g = gatewayFalso(); g.conectou();
    const m = montar({ g });
    await rejeita(() => trocar({}, OP, m.deps), 400, "CONFIRMACAO_OBRIGATORIA");
    await trocar({ confirmacaoExplicita: true }, OP, m.deps);
    await rejeita(() => trocar({ confirmacaoExplicita: true }, OP, m.deps), 409, "OPERACAO_EM_ANDAMENTO");
    await rejeita(() => desconectar({ confirmacaoExplicita: true }, OP, m.deps), 409, "OPERACAO_EM_ANDAMENTO");
    await rejeita(() => iniciar(OP, m.deps), 409);
    assert.equal(g.chamadas.filter((c) => c === "desconectarConta").length, 1, "as tentativas concorrentes não chegaram ao Gateway");
  });

  test("falha ao gerar QR depois de desconectar ⇒ 409, auditoria e reconciliação pendente", async () => {
    const g = gatewayFalso(); g.conectou(); g.falhar.conectar = new Error("BAILEYS_GATEWAY_UNREACHABLE");
    const m = montar({ g });
    await rejeita(() => trocar({ confirmacaoExplicita: true }, OP, m.deps), 409, "TROCAR_FALHOU");
    assert.equal(m.auditorias.at(-1).acao, "WHATSAPP_CONEXAO_FALHOU");
    assert.equal(m.db.tabelas.whatsapp_identidade[0].efeito_estado, "INCERTO");
  });

  test("trocar para OUTRO número: a confirmação e o nome operacional antigos não valem para ele", async () => {
    const g = gatewayFalso(); const m = montar({ g });
    let { operacaoId } = await iniciar(OP, m.deps); g.conectou();
    m.db.tabelas.whatsapp_conexoes[0].status = "CONNECTED"; m.db.tabelas.whatsapp_conexoes[0].telefone_e164 = TEL;
    await confirmar({ operacaoId, utilizarComoAgente: true }, OP, m.deps);
    assert.equal((await resumoIdentidade(m.deps)).nomeOperacional, NOME_AGENTE);
    // outro número aparece conectado por fora do fluxo
    m.db.tabelas.whatsapp_conexoes[0].telefone_e164 = "+5511911112222"; _zerarCachePerfil();
    const r = await resumoIdentidade(m.deps);
    assert.deepEqual([r.status, r.confirmada, r.nomeOperacional], ["PENDENTE_CONFIRMACAO", false, null]);
    assert.equal(await identidadeConfirmada(m.deps), false);
    void operacaoId;
  });
});

describe("duas tentativas concorrentes", () => {
  test("dois iniciar em PARALELO ⇒ um vence, o outro 409; o Gateway recebe UM /connect", async () => {
    const m = montar();
    const rs = await Promise.allSettled([iniciar(OP, m.deps), iniciar(OP, m.deps), iniciar(OP, m.deps)]);
    assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(rs.filter((r) => r.status === "rejected" && r.reason.statusCode === 409 && r.reason.details.codigo === "OPERACAO_EM_ANDAMENTO").length, 2);
    assert.equal(m.g.chamadas.filter((c) => c === "conectar").length, 1);
  });

  test("dois operadores diferentes: o segundo é recusado enquanto a operação do primeiro está ativa; ao encerrar, pode começar", async () => {
    const outro = { ...OP, contaId: uuid(11), perfilId: uuid(12) };
    const m = montar();
    const { operacaoId } = await iniciar(OP, m.deps);
    await rejeita(() => iniciar(outro, m.deps), 409, "OPERACAO_EM_ANDAMENTO");
    await cancelar({ operacaoId }, OP, m.deps);
    await assert.doesNotReject(() => iniciar(outro, m.deps));
  });

  test("uma trava EXPIRADA não bloqueia para sempre (o banco a libera pelo relógio)", async () => {
    const m = montar({ identidade: [{ organizacao_id: ORG, provider_instance_id: "default", ambiente: "TESTE", status: "SEM_CONTA", operacao_id: uuid(90), operacao_tipo: "CONECTAR", operacao_expira_em: seg(-1) }] });
    await assert.doesNotReject(() => iniciar(OP, m.deps));
  });
});

describe("identidade interna", () => {
  const confirmada = async () => {
    const g = gatewayFalso(); const m = montar({ g });
    const { operacaoId } = await iniciar(OP, m.deps); g.conectou();
    m.db.tabelas.whatsapp_conexoes[0].status = "CONNECTED"; m.db.tabelas.whatsapp_conexoes[0].telefone_e164 = TEL;
    await confirmar({ operacaoId, utilizarComoAgente: false }, OP, m.deps);
    m.auditorias.length = 0; return m;
  };

  test("definir ambiente e marcar/desmarcar Agente Crescer numa conta CONFIRMADA; audita IDENTIDADE_DEFINIDA", async () => {
    const m = await confirmada();
    let e = await definirIdentidade({ agenteCrescer: true, ambiente: "PRODUCAO" }, OP, m.deps);
    assert.deepEqual([e.identidade.agenteCrescer, e.identidade.ambiente], [true, "PRODUCAO"]);
    e = await definirIdentidade({ agenteCrescer: false }, OP, m.deps);
    assert.deepEqual([e.identidade.agenteCrescer, e.identidade.nomeOperacional], [false, null]);
    assert.deepEqual(acoes(m.auditorias), ["WHATSAPP_IDENTIDADE_DEFINIDA", "WHATSAPP_IDENTIDADE_DEFINIDA"]);
  });

  test("conta NÃO confirmada não pode ser marcada como Agente Crescer (409); valores inválidos ⇒ 400", async () => {
    const m = montar();
    await rejeita(() => definirIdentidade({ agenteCrescer: true }, OP, m.deps), 409, "CONTA_NAO_CONFIRMADA");
    await rejeita(() => definirIdentidade({ ambiente: "X" }, OP, m.deps), 400, "AMBIENTE_INVALIDO");
    await rejeita(() => definirIdentidade({ agenteCrescer: "sim" }, OP, m.deps), 400, "VALOR_INVALIDO");
  });
});

describe("auditoria e sigilo", () => {
  test("uma jornada completa gera exatamente os eventos esperados, todos com ator humano, e NENHUM com QR/segredo/telefone completo", async () => {
    const g = gatewayFalso(); const m = montar({ g });
    const { operacaoId } = await iniciar(OP, m.deps);
    g.mostrarQr(QR_SEGREDO, 1); await qr({ operacaoId }, OP, m.deps);
    g.conectou(); m.db.tabelas.whatsapp_conexoes[0].status = "CONNECTED"; m.db.tabelas.whatsapp_conexoes[0].telefone_e164 = TEL;
    await confirmar({ operacaoId, utilizarComoAgente: true }, OP, m.deps);
    await desconectar({ confirmacaoExplicita: true }, OP, m.deps);
    assert.deepEqual(acoes(m.auditorias), ["WHATSAPP_CONEXAO_INICIADA", "WHATSAPP_QR_GERADO", "WHATSAPP_CONECTADO", "WHATSAPP_DESCONECTADO"]);
    for (const a of m.auditorias) assert.deepEqual([a.atorId, a.perfilId, a.atorEmail], [OP.contaId, OP.perfilId, OP.email]);
    const txt = JSON.stringify(m.auditorias);
    assert.ok(!txt.includes("SEGREDO") && !txt.includes("5511987654321") && !txt.includes(hashTelefone(TEL)));
    assert.ok(!/auth|creds|signal|token|hmac/i.test(txt));
  });
});
