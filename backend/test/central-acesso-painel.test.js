// REGRA DE ACESSO DA CENTRAL DE COMUNICAÇÃO (HTTP, router REAL, sem banco/rede):
//   * quem tem acesso ao Painel Administrativo tem, na Comunicação, a MESMA visão e as MESMAS ações do SuperAdmin — inclusive
//     conectar/QR/confirmar/cancelar/desconectar/trocar/reconciliar da Conexão — sem permissão adicional (única fonte: requirePainelAdministrativo);
//   * quem não é do Painel não entra em nada; leitura nunca recebe token, QR, id de operação, efeito_token nem telefone completo;
//   * nenhuma ação da Central depende de permissão extra (a antiga `comunicacao:gerenciar_conexao` deixou de existir).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { administrativoRouter } from "../src/modules/administrativo/administrativo.routes.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";
import { criarFakeDb, linhaRoster } from "./helpers/central-fake-db.js";
import { instalarExecutorTeste } from "./helpers/gateway-operacao.js";
import { _zerarCachePerfil } from "../src/modules/administrativo/administrativo.comunicacao.conexao.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = uuid(1); const C1 = uuid(101); const OPERACAO = uuid(500); const TOKEN = uuid(600); const AUTH = uuid(700);
const TEL_COMPLETO = "+5511987650040";
const QR = "2@SEGREDO-ACESSO-QR,abc";
const AGORA = new Date("2026-09-24T15:00:00.000Z");

const COMUM = { id: uuid(11), email: "comum@t.com", nome: "Comum", painelAdministrativo: false, superadmin: false };
const PAINEL = { id: uuid(12), email: "painel@t.com", nome: "Painel", painelAdministrativo: true, superadmin: false };
const SUPER = { id: uuid(14), email: "super@t.com", nome: "Super", painelAdministrativo: false, superadmin: true };   // bypass: nem precisa do flag do Painel

function chamar({ user, metodo = "GET", path, corpo, adminDeps }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  if (adminDeps) app.locals.adminDeps = adminDeps;
  app.use("/administrativo", administrativoRouter);
  app.use(errorHandler);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const req = http.request({ host: "127.0.0.1", port: server.address().port, path, method: metodo, headers: corpo ? { "Content-Type": "application/json" } : {} }, (res) => {
        let body = ""; res.on("data", (c) => { body += c; });
        res.on("end", () => { server.close(); let json = null; try { json = body ? JSON.parse(body) : null; } catch { /* corpo não-JSON */ } resolve({ status: res.statusCode, headers: res.headers, texto: body, json }); });
      });
      req.on("error", (e) => { server.close(); reject(e); });
      if (corpo) req.write(JSON.stringify(corpo));
      req.end();
    });
  });
}

/** Central inteira sobre o fake DB: conexão CONECTADA com operação e efeito INCERTO em curso (o pior caso para vazamento). */
function montar() {
  const agoraIso = AGORA.toISOString();
  const db = criarFakeDb({
    comunicacao_roster_autorizado: [linhaRoster({ contato_id: C1, telefone_e164: "+5511999990001", perfil_nome: "Maria Souza", organizacao_id: uuid(2), organizacao_nome: "Rede Sabor", unidade_id: uuid(3), unidade_nome: "Centro" })],
    comunicacao_mensagens: [], comunicacao_inbox_mensagens: [], comunicacao_inbox_leituras: [], contatos_whatsapp: [],
    whatsapp_conexoes: [{ organizacao_id: ORG, provider_instance_id: "default", status: "CONNECTED", telefone_e164: TEL_COMPLETO, auth_session_id: AUTH, auth_confirmado: true, last_seen_at: agoraIso, connected_at: agoraIso, lease_expires_at: new Date(AGORA.getTime() + 60_000).toISOString(), gateway_version: "0.1.0" }],
    whatsapp_identidade: [{
      organizacao_id: ORG, provider_instance_id: "default", ambiente: "TESTE", status: "SEM_CONTA", operacao_id: OPERACAO, operacao_tipo: "DESCONECTAR", operacao_expira_em: new Date(AGORA.getTime() + 200_000).toISOString(),
      efeito_token: TOKEN, efeito_acao: "DESCONECTAR", efeito_estado: "INCERTO", efeito_auth_session_id: AUTH, efeito_atualizado_em: new Date(AGORA.getTime() - 600_000).toISOString(),
      efeito_incerto_desde: new Date(AGORA.getTime() - 600_000).toISOString(), efeito_verificado_em: null, efeito_verificacoes: 0, efeito_ultimo_resultado: null,
    }],
  });
  // A decisão da reconciliação é do RPC (banco): aqui só registramos o que o backend enviou.
  const rpcs = [];
  const rpcOriginal = db.rpc.bind(db);
  db.rpc = async (nome, args) => {
    if (nome === "whatsapp_operacao_reconciliar") { rpcs.push(args); return { data: [{ decisao: "AINDA_INCERTO", motivo: "gateway_indisponivel", acao: "DESCONECTAR" }], error: null }; }
    return rpcOriginal(nome, args);
  };
  const chamadas = [];
  const svc = {
    conexaoStatus: async () => ({ status: "CONNECTED", qrDisponivel: false, reconectando: false }),
    conexaoQr: async () => ({ qr: QR, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"></svg>', geradoEm: agoraIso, expiraEm: agoraIso, ordem: 1 }),
    conexaoPerfil: async () => ({ disponivel: true, nome: "Conta Teste", telefoneE164: TEL_COMPLETO, authSessionId: AUTH, tipoConta: "DESCONHECIDO" }),
    conexaoConectar: async () => { chamadas.push("conectar"); }, conexaoDesconectarConta: async () => { chamadas.push("desconectar"); }, conexaoEncerrar: async () => { chamadas.push("encerrar"); },
    identidadeConfirmada: async () => false,
  };
  const deps = {
    supabase: db, env: {}, agora: () => AGORA, organizacaoConexaoId: ORG, whatsAppService: svc, estadoGateway: { estado: "conectado" },
    lerPendencias: async () => ({ unidades: [] }), auditar: async () => {}, identidadeConfirmada: false,
    resumoIdentidade: async () => ({ status: "PENDENTE_CONFIRMACAO", confirmada: false, ambiente: "TESTE", nomeOperacional: null }),
    resumo: async () => ({ gateway: { estado: "conectado" }, worker: { estado: "habilitado" }, comunicacao: { modo: "NORMAL" }, piloto: { ativo: false, quantidadeDestinos: 0 }, backend: { online: true, versao: "abc1234" }, entrega: { estado: "operacional" } }),
    organizacoes: async () => [], modoAtual: async () => "NORMAL", configuracaoOperacional: async () => ({ janelaComercial: { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: null, dom: null } }),
  };
  instalarExecutorTeste(svc, deps);
  return { deps, db, chamadas, rpcs };
}

const A = "/administrativo/comunicacao";
/** As abas da Central: TODAS de leitura. */
const LEITURAS_DA_CENTRAL = [
  ["Visão Geral", `${A}/central/visao-geral`], ["Automações", `${A}/central/automacoes`], ["Destinatários", `${A}/central/destinatarios`], ["Histórico", `${A}/central/historico`],
  ["Diagnóstico/status", `${A}/central/diagnostico`], ["Atualizações", `${A}/central/atualizacoes`], ["Conversas (lista)", `${A}/conversas`], ["Conversa", `${A}/conversas/${C1}`], ["Conexão", `${A}/conexao`],
];
/** Ações SENSÍVEIS de conexão: mesma autorização do resto da Comunicação (Painel Administrativo OU SuperAdmin). */
const ACOES_DE_CONEXAO = [
  ["GET", `${A}/conexao/qr?operacaoId=${OPERACAO}`], ["POST", `${A}/conexao/iniciar`, {}], ["POST", `${A}/conexao/novo-qr`, { operacaoId: OPERACAO }], ["POST", `${A}/conexao/confirmar`, { operacaoId: OPERACAO }],
  ["POST", `${A}/conexao/cancelar`, { operacaoId: OPERACAO }], ["POST", `${A}/conexao/desconectar`, { confirmacaoExplicita: true }], ["POST", `${A}/conexao/trocar`, { confirmacaoExplicita: true }],
  ["POST", `${A}/conexao/reconciliar`, {}], ["PUT", `${A}/conexao/identidade`, { ambiente: "TESTE" }],
];
/** Outras leituras e AÇÕES da Central. */
const OUTRAS_LEITURAS = [`${A}/resumo`, `${A}/organizacoes`, `${A}/fila`, `${A}/historico`, `${A}/mensagens`, `${A}/configuracao-operacional`, `${A}/ativacao`, `${A}/teste/preparo`];
const OUTRAS_ACOES = [
  ["PUT", `${A}/organizacoes/${uuid(2)}/habilitacao`, { habilitar: false, confirmacaoExplicita: true }], ["PUT", `${A}/modo`, { modo: "DISABLED", confirmacaoExplicita: true }],
  ["POST", `${A}/teste`, {}], ["POST", `${A}/conversas/${C1}/mensagens`, { texto: "oi" }], ["PUT", `${A}/organizacoes/${uuid(2)}/configuracao`, {}],
  ["POST", `${A}/organizacoes/${uuid(2)}/consentimento`, {}], ["POST", `${A}/conversas/${C1}/lida`, {}],
];
const MSG_PERMISSAO_CONEXAO = /gerenciar a conex/i;

describe("Central — quem NÃO é do Painel Administrativo: tudo bloqueado", () => {
  for (const [nome, path] of LEITURAS_DA_CENTRAL) {
    test(`GET ${nome}: usuário comum ⇒ 403; sem usuário ⇒ recusado`, async () => {
      const { deps } = montar();
      assert.equal((await chamar({ user: COMUM, path, adminDeps: deps })).status, 403);
      assert.ok([401, 403].includes((await chamar({ user: null, path, adminDeps: deps })).status));
    });
  }
  test("ações sensíveis e demais ações da Central também ⇒ 403 para o usuário comum, e o Gateway nunca é tocado", async () => {
    const { deps, chamadas } = montar();
    for (const [metodo, path, corpo] of [...ACOES_DE_CONEXAO, ...OUTRAS_ACOES]) assert.equal((await chamar({ user: COMUM, metodo, path, corpo, adminDeps: deps })).status, 403, `${metodo} ${path}`);
    for (const path of OUTRAS_LEITURAS) assert.equal((await chamar({ user: COMUM, path, adminDeps: deps })).status, 403, path);
    assert.deepEqual(chamadas, []);
  });
});

describe("Central — usuário do Painel Administrativo (não-SA): VÊ e AGE exatamente como o SuperAdmin", () => {
  for (const [nome, path] of LEITURAS_DA_CENTRAL) {
    test(`GET ${nome}: 200 sem permissão adicional`, async () => {
      const { deps } = montar();
      _zerarCachePerfil();
      const r = await chamar({ user: PAINEL, path, adminDeps: deps });
      assert.equal(r.status, 200, r.texto.slice(0, 300));
      assert.ok(r.json?.data !== undefined);
    });
  }

  test("as demais leituras da Central autorizam o Painel", async () => {
    const { deps } = montar();
    for (const path of OUTRAS_LEITURAS) {
      const r = await chamar({ user: PAINEL, path, adminDeps: deps });
      assert.ok(![401, 403].includes(r.status), `${path} => ${r.status}`);
    }
  });

  test("Conexão: gerencia (permissoes.gerenciar=true, id da operação, podeReconciliar) — ainda sem token, QR, telefone completo nem session id", async () => {
    const { deps } = montar();
    _zerarCachePerfil();
    const r = await chamar({ user: PAINEL, path: `${A}/conexao`, adminDeps: deps });
    assert.equal(r.status, 200);
    const d = r.json.data;
    assert.equal(d.permissoes.gerenciar, true);
    assert.equal(d.estado, "CONNECTED");
    assert.match(d.conta.telefoneMascarado, /\*+40$/);
    assert.equal(d.operacao.id, OPERACAO); assert.equal(d.operacao.tipo, "DESCONECTAR"); assert.equal(d.operacao.podeReconciliar, true);
    assert.equal(d.reconciliacao.reconciliacaoNecessaria, true); assert.equal(d.reconciliacao.acao, "DESCONECTAR");
    for (const segredo of [TOKEN, AUTH, TEL_COMPLETO, TEL_COMPLETO.slice(1), "SEGREDO", "efeito_token", "efeitoToken", "auth_state", "authSession"]) assert.equal(r.texto.includes(segredo), false, `vazou: ${segredo}`);
  });

  test("Conexão: NENHUMA ação sensível é negada por permissão (nunca 401/403)", async () => {
    for (const [metodo, path, corpo] of ACOES_DE_CONEXAO) {
      const { deps } = montar();
      _zerarCachePerfil();
      const r = await chamar({ user: PAINEL, metodo, path, corpo, adminDeps: deps });
      assert.ok(![401, 403].includes(r.status), `${metodo} ${path} => ${r.status} ${r.texto.slice(0, 200)}`);
      assert.doesNotMatch(r.texto, MSG_PERMISSAO_CONEXAO, path);
      assert.ok(!r.texto.includes("SEGREDO") && !r.texto.includes(TOKEN));
    }
  });

  test("QR: nunca 403; sai com no-store e sem o valor cru", async () => {
    const { deps } = montar();
    _zerarCachePerfil();
    const qr = await chamar({ user: PAINEL, path: `${A}/conexao/qr?operacaoId=${OPERACAO}`, adminDeps: deps });
    assert.ok([200, 409].includes(qr.status), `qr => ${qr.status}`);   // 409 = operação com efeito pendente (regra da 098); jamais 403
    assert.equal(qr.headers["cache-control"] ?? "no-store", "no-store");
    assert.ok(!qr.texto.includes("SEGREDO"));
  });

  test("reconciliar: o Painel dispara; a DECISÃO vem do RPC — o corpo do usuário é ignorado (não escolhe CONCLUIDO/ABORTADO)", async () => {
    const { deps, rpcs } = montar();
    _zerarCachePerfil();
    const r = await chamar({ user: PAINEL, metodo: "POST", path: `${A}/conexao/reconciliar`, corpo: { decisao: "CONCLUIDO", resultado: "CONCLUIDO" }, adminDeps: deps });
    assert.equal(r.status, 200, r.texto.slice(0, 300));
    assert.equal(r.json.data.decisao, "AINDA_INCERTO");
    assert.equal(rpcs.length, 1);
    assert.deepEqual(Object.keys(rpcs[0]).filter((k) => /decis|result|token/i.test(k)), [], "o backend não repassa nenhuma escolha do usuário");
    assert.equal(JSON.stringify(rpcs[0]).includes("CONCLUIDO"), false);
  });
});

describe("Central — SuperAdmin e Painel Administrativo: visão e permissões IDÊNTICAS", () => {
  test("SuperAdmin lê tudo mesmo sem o flag do Painel, gerencia a conexão e reconcilia", async () => {
    const { deps, rpcs } = montar();
    _zerarCachePerfil();
    for (const [nome, path] of LEITURAS_DA_CENTRAL) assert.equal((await chamar({ user: SUPER, path, adminDeps: deps })).status, 200, nome);
    const e = await chamar({ user: SUPER, path: `${A}/conexao`, adminDeps: deps });
    assert.equal(e.json.data.permissoes.gerenciar, true); assert.equal(e.json.data.operacao.id, OPERACAO);
    const r = await chamar({ user: SUPER, metodo: "POST", path: `${A}/conexao/reconciliar`, corpo: {}, adminDeps: deps });
    assert.equal(r.status, 200); assert.equal(rpcs.length, 1);
  });

  test("mesmo status HTTP em TODAS as rotas (leituras e ações) e o mesmo estado de Conexão", async () => {
    const rotas = [...LEITURAS_DA_CENTRAL.map(([, p]) => ["GET", p]), ...OUTRAS_LEITURAS.map((p) => ["GET", p]), ...ACOES_DE_CONEXAO, ...OUTRAS_ACOES];
    for (const [metodo, path, corpo] of rotas) {
      const status = [];
      for (const user of [SUPER, PAINEL]) {
        const { deps } = montar();
        _zerarCachePerfil();
        status.push((await chamar({ user, metodo, path, corpo, adminDeps: deps })).status);
      }
      assert.equal(status[1], status[0], `${metodo} ${path}: SuperAdmin=${status[0]} Painel=${status[1]}`);
    }
    const estados = [];
    for (const user of [SUPER, PAINEL]) { const { deps } = montar(); _zerarCachePerfil(); estados.push((await chamar({ user, path: `${A}/conexao`, adminDeps: deps })).json.data); }
    assert.deepEqual(estados[1].permissoes, estados[0].permissoes);
    assert.deepEqual(estados[1].operacao, estados[0].operacao);
  });
});

describe("Central — outras ações e guardas de fonte única de autorização", () => {
  test("o Painel chega às outras ações sem 401/403 de permissão", async () => {
    const { deps } = montar();
    for (const [metodo, path, corpo] of OUTRAS_ACOES) {
      const r = await chamar({ user: PAINEL, metodo, path, corpo, adminDeps: deps });
      assert.notEqual(r.status, 403, `${metodo} ${path}`);
      assert.doesNotMatch(r.texto, MSG_PERMISSAO_CONEXAO, `${metodo} ${path}`);
      assert.notEqual(r.status, 401);
    }
  });
  test("guarda estática: nenhuma permissão paralela — ninguém no src consulta painel_adm_permissoes/gerenciar_conexao; só a Conexão usa temPermissaoConexao", () => {
    const raiz = join(aqui, "..", "src");
    const arquivos = []; const varrer = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) varrer(p); else if (p.endsWith(".js")) arquivos.push(p); } };
    varrer(raiz);
    const semComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const rel = (p) => p.slice(raiz.length + 1).replace(/\\/g, "/");
    const usam = arquivos.filter((p) => /temPermissaoConexao|exigirPermissao/.test(semComentarios(readFileSync(p, "utf8")))).map(rel);
    assert.deepEqual(usam, ["modules/administrativo/administrativo.comunicacao.conexao.js"]);
    const paralela = arquivos.filter((p) => /painel_adm_permissoes|gerenciar_conexao|PERMISSAO_CONEXAO/.test(semComentarios(readFileSync(p, "utf8")))).map(rel);
    assert.deepEqual(paralela, [], "a Conexão não pode voltar a depender de uma segunda fonte de permissão");
  });
  test("guarda estática: TODA rota de comunicação nasce atrás do requirePainelAdministrativo (router inteiro)", () => {
    const src = readFileSync(join(aqui, "..", "src", "modules", "administrativo", "administrativo.routes.js"), "utf8");
    assert.match(src, /administrativoRouter\.use\(requirePainelAdministrativo\)/);
    assert.ok(src.indexOf("administrativoRouter.use(requirePainelAdministrativo)") < src.indexOf('"/comunicacao/'));
  });
});
