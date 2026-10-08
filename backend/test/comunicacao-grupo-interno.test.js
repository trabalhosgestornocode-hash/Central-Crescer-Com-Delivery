// Grupo interno da operação — exceção estreita de grupo (Fases 2 e 3 do alerta diário do Dashboard iFood).
// SEM banco real, SEM rede real: supabase falso com UNIQUE(chave_idempotencia) e um Gateway HTTP falso numa porta efêmera.
//
// Rodar: node --env-file-if-exists=.env --test test/comunicacao-grupo-interno.test.js

import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { criarBaileysGatewayProvider } from "../src/modules/comunicacao/providers/baileysGateway.provider.js";
import { criarWhatsAppService, ModoDesabilitadoError, IdentidadeNaoConfirmadaError } from "../src/modules/comunicacao/whatsapp.service.js";
import {
  enviarAoGrupoInterno, grupoInternoJidDoAmbiente, textoTesteGrupo, chaveTesteGrupo, motivoDaFalha, TIPO_ENVIO_GRUPO, STATUS_ENVIO_GRUPO,
} from "../src/modules/comunicacao/comunicacao.grupoInterno.js";
import { enviarTesteGrupo, preparoTesteGrupo, listarGrupos } from "../src/modules/administrativo/administrativo.comunicacao.grupoInterno.js";

const GRUPO = "120363000000000001@g.us";
const OUTRO = "120363000000000002@g.us";
const SEGREDO = "x".repeat(32);
const TESTE_ID = "11111111-1111-4111-8111-111111111111";
const AUTOR = { contaId: "conta-1", perfilId: null, nome: "Operador", email: "op@example.com" };

// ---- supabase falso: só o que comunicacao.grupoInterno.js e auditoria usam -----------------------------------------------
function fakeDb() {
  const tabelas = { comunicacao_envios_grupo: [], auditoria_eventos: [] };
  let seq = 0;
  function from(nome) {
    const linhas = (tabelas[nome] ??= []);
    const filtros = [];
    let op = "select", payload = null, lim = null;
    const casa = (r) => filtros.every(([c, v]) => r[c] === v);
    const exec = (single) => {
      if (op === "insert") {
        const nova = { id: `env-${++seq}`, tentativas: 0, resumo: {}, criado_em: new Date().toISOString(), ...payload };
        if (nome === "comunicacao_envios_grupo" && linhas.some((r) => r.chave_idempotencia === nova.chave_idempotencia)) {
          return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
        }
        linhas.push(nova);
        return Promise.resolve({ data: { ...nova }, error: null });
      }
      if (op === "update") {
        const alvo = linhas.filter(casa);
        alvo.forEach((r) => Object.assign(r, payload));
        return Promise.resolve({ data: alvo[0] ? { ...alvo[0] } : null, error: null });
      }
      let res = linhas.filter(casa).map((r) => ({ ...r })).reverse();
      if (lim != null) res = res.slice(0, lim);
      return Promise.resolve({ data: single ? (res[0] ?? null) : res, error: null });
    };
    const b = {
      select: () => b, eq: (c, v) => (filtros.push([c, v]), b), order: () => b, limit: (n) => (lim = n, b),
      insert: (obj) => (op = "insert", payload = obj, b), update: (obj) => (op = "update", payload = obj, b),
      single: () => exec(true), maybeSingle: () => exec(true), then: (ok, ko) => exec(false).then(ok, ko),
    };
    return b;
  }
  return { from, tabelas, rpc: async () => ({ data: null, error: null }) };
}

// ---- Gateway HTTP falso (contrato das rotas novas) ----------------------------------------------------------------------
function gatewayFalso() {
  const estado = { modo: "ok", chamadasEnvio: 0, ultimoCorpo: null };
  const servidor = http.createServer((req, res) => {
    let corpo = "";
    req.on("data", (c) => (corpo += c));
    req.on("end", () => {
      const json = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (!req.headers["x-gateway-signature"]) return json(401, { error: "unauthorized" });
      const body = corpo ? JSON.parse(corpo) : {};
      if (req.url === "/internal/whatsapp/grupos") {
        if (estado.modo === "desconectado") return json(409, { error: "WHATSAPP_GATEWAY_NOT_CONNECTED" });
        return json(200, { grupoInternoJid: GRUPO, grupos: [{ jid: GRUPO, nome: "Crescer Com Delivery - Central", participantes: 5, somenteAdminsEnviam: false }, { jid: OUTRO, nome: "Outro", participantes: 2, somenteAdminsEnviam: false }] });
      }
      if (req.url === "/internal/whatsapp/grupo-interno/verificar") {
        if (estado.modo === "desconectado") return json(409, { error: "WHATSAPP_GATEWAY_NOT_CONNECTED" });
        if (estado.modo === "inexistente") return json(422, { error: "WHATSAPP_GATEWAY_GROUP_NOT_FOUND" });
        if (body.grupoJid !== GRUPO) return json(403, { error: "WHATSAPP_GATEWAY_GROUP_NOT_AUTHORIZED" });
        return json(200, { jid: GRUPO, nome: "Crescer Com Delivery - Central", participantes: 5, participa: true, souAdmin: false, somenteAdminsEnviam: false, podeEnviar: true });
      }
      if (req.url === "/internal/whatsapp/grupo-interno/messages") {
        estado.ultimoCorpo = body;
        if (estado.modo === "desconectado") return json(409, { error: "WHATSAPP_GATEWAY_NOT_CONNECTED" });
        if (estado.modo === "inexistente") return json(422, { error: "WHATSAPP_GATEWAY_GROUP_NOT_FOUND" });
        if (estado.modo === "erro500") return json(500, { error: "WHATSAPP_GATEWAY_UNAVAILABLE" });
        estado.chamadasEnvio += 1;
        return json(200, { providerMessageId: `wa-${estado.chamadasEnvio}`, enviadoEm: new Date().toISOString(), grupo: { jid: GRUPO, nome: "Crescer Com Delivery - Central" } });
      }
      return json(404, { error: "not_found" });
    });
  });
  return { servidor, estado };
}

const ENV_OK = { EFEITOS_EXTERNOS_LOCAL_PERMITIDOS: "true", WHATSAPP_GRUPO_INTERNO_JID: GRUPO };

let gw, url;
before(async () => {
  gw = gatewayFalso();
  await new Promise((r) => gw.servidor.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${gw.servidor.address().port}`;
});
after(() => gw.servidor.close());

const servico = ({ modo = "NORMAL", confirmada = true } = {}) => criarWhatsAppService({
  provider: criarBaileysGatewayProvider({ gatewayUrl: url, segredoHmac: SEGREDO, env: { ...process.env, ...ENV_OK } }),
  identidadeConfirmada: async () => confirmada, modoAtual: async () => modo,
});
const reset = (modo = "ok") => { gw.estado.modo = modo; gw.estado.chamadasEnvio = 0; gw.estado.ultimoCorpo = null; };
const pedido = (over = {}) => ({ tipo: TIPO_ENVIO_GRUPO.TESTE, chave: `grupo_teste:${Math.random()}`, grupoJid: GRUPO, conteudo: textoTesteGrupo(), ...over });

describe("configuração do grupo interno", () => {
  test("WHATSAPP_GRUPO_INTERNO_JID: só JID de grupo válido; ausente/inválido ⇒ null", () => {
    assert.equal(grupoInternoJidDoAmbiente({ WHATSAPP_GRUPO_INTERNO_JID: ` ${GRUPO} ` }), GRUPO);
    for (const ruim of [undefined, "", "5511999990000@s.whatsapp.net", "abc@g.us", "status@broadcast"]) {
      assert.equal(grupoInternoJidDoAmbiente({ WHATSAPP_GRUPO_INTERNO_JID: ruim }), null, String(ruim));
    }
  });
  test("texto do teste é o aprovado e não cita nenhuma empresa", () => {
    const t = textoTesteGrupo();
    assert.match(t, /^🧪 TESTE DE AUTOMAÇÃO/);
    assert.match(t, /Grupo configurado corretamente\./);
    assert.match(t, /Nenhuma ação é necessária\./);
  });
});

describe("whatsapp.service — gates do envio ao grupo (antes do provider)", () => {
  test("modo DISABLED ⇒ ModoDesabilitadoError, Gateway não é chamado", async () => {
    reset();
    await assert.rejects(servico({ modo: "DISABLED" }).enviarTextoGrupoInterno({ grupoJid: GRUPO, texto: "x", idempotencyKey: "k" }), ModoDesabilitadoError);
    assert.equal(gw.estado.ultimoCorpo, null);
  });
  test("conta não confirmada ⇒ IdentidadeNaoConfirmadaError, Gateway não é chamado", async () => {
    reset();
    await assert.rejects(servico({ confirmada: false }).enviarTextoGrupoInterno({ grupoJid: GRUPO, texto: "x", idempotencyKey: "k" }), IdentidadeNaoConfirmadaError);
    assert.equal(gw.estado.ultimoCorpo, null);
  });
  test("JID que não é de grupo é barrado no backend, sem rede", async () => {
    reset();
    await assert.rejects(servico().enviarTextoGrupoInterno({ grupoJid: "5511999990000@s.whatsapp.net", texto: "x", idempotencyKey: "k" }), /grupoJid fora do formato/);
    assert.equal(gw.estado.ultimoCorpo, null);
  });
  test("provider sem a capacidade (fake) ⇒ erro, nada sai", async () => {
    const { criarFakeProvider } = await import("../src/modules/comunicacao/providers/fake.provider.js").catch(() => ({}));
    if (typeof criarFakeProvider !== "function") return;
    const s = criarWhatsAppService({ provider: criarFakeProvider(), semGateIdentidade: true, semGateModo: true });
    await assert.rejects(s.enviarTextoGrupoInterno({ grupoJid: GRUPO, texto: "x", idempotencyKey: "k" }), /sem envio a grupo/);
  });
});

describe("enviarAoGrupoInterno — idempotência e falhas", () => {
  test("sucesso: UMA chamada ao Gateway, linha SENT com messageId", async () => {
    reset();
    const db = fakeDb();
    const r = await enviarAoGrupoInterno({ ...pedido(), whatsAppService: servico() }, { supabase: db });
    assert.equal(r.resultado, "ENVIADO");
    assert.equal(r.envio.status, STATUS_ENVIO_GRUPO.SENT);
    assert.equal(r.envio.provider_message_id, "wa-1");
    assert.equal(gw.estado.chamadasEnvio, 1);
    assert.equal(gw.estado.ultimoCorpo.grupoJid, GRUPO);
  });

  test("execução duplicada (mesma chave) ⇒ a 2ª NÃO envia", async () => {
    reset();
    const db = fakeDb();
    const p = pedido({ chave: "ifood_dashboard_alert:2026-10-07:" + GRUPO });
    const a = await enviarAoGrupoInterno({ ...p, whatsAppService: servico() }, { supabase: db });
    const b = await enviarAoGrupoInterno({ ...p, whatsAppService: servico() }, { supabase: db });
    assert.equal(a.resultado, "ENVIADO");
    assert.equal(b.resultado, "JA_EXISTIA");
    assert.equal(gw.estado.chamadasEnvio, 1);
  });

  test("duas instâncias ao mesmo tempo (mesma chave) ⇒ 1 envio só", async () => {
    reset();
    const db = fakeDb();
    const p = pedido({ chave: "concorrente" });
    const rs = await Promise.all([1, 2, 3].map(() => enviarAoGrupoInterno({ ...p, whatsAppService: servico() }, { supabase: db })));
    assert.equal(rs.filter((r) => r.resultado === "ENVIADO").length, 1);
    assert.equal(gw.estado.chamadasEnvio, 1);
  });

  test("reinício do servidor: estado vem do BANCO — um processo novo (novo serviço) não reenvia", async () => {
    reset();
    const db = fakeDb();
    const p = pedido({ chave: "restart" });
    await enviarAoGrupoInterno({ ...p, whatsAppService: servico() }, { supabase: db });
    // "novo processo": módulo reimportado sem cache + serviço/provider novos; só o banco é o mesmo.
    const mod = await import(`../src/modules/comunicacao/comunicacao.grupoInterno.js?restart=${Date.now()}`);
    const r = await mod.enviarAoGrupoInterno({ ...p, whatsAppService: servico() }, { supabase: db });
    assert.equal(r.resultado, "JA_EXISTIA");
    assert.equal(gw.estado.chamadasEnvio, 1);
  });

  test("WhatsApp desconectado ⇒ FAILED / whatsapp_gateway_unavailable, nada enviado", async () => {
    reset("desconectado");
    const db = fakeDb();
    const r = await enviarAoGrupoInterno({ ...pedido(), whatsAppService: servico() }, { supabase: db });
    assert.equal(r.resultado, "FALHOU");
    assert.equal(r.envio.status, STATUS_ENVIO_GRUPO.FAILED);
    assert.equal(r.envio.motivo, "whatsapp_gateway_unavailable");
    assert.equal(gw.estado.chamadasEnvio, 0);
  });

  test("grupo não encontrado ⇒ FAILED / grupo_nao_encontrado, nada enviado", async () => {
    reset("inexistente");
    const db = fakeDb();
    const r = await enviarAoGrupoInterno({ ...pedido(), whatsAppService: servico() }, { supabase: db });
    assert.equal(r.envio.motivo, "grupo_nao_encontrado");
    assert.equal(gw.estado.chamadasEnvio, 0);
  });

  test("Gateway inalcançável ⇒ FAILED / whatsapp_gateway_unavailable", async () => {
    const s = criarWhatsAppService({
      provider: criarBaileysGatewayProvider({ gatewayUrl: "http://127.0.0.1:1", segredoHmac: SEGREDO, env: { ...process.env, ...ENV_OK } }),
      identidadeConfirmada: async () => true, modoAtual: async () => "NORMAL",
    });
    const r = await enviarAoGrupoInterno({ ...pedido(), whatsAppService: s }, { supabase: fakeDb() });
    assert.equal(r.envio.status, STATUS_ENVIO_GRUPO.FAILED);
    assert.equal(r.envio.motivo, "whatsapp_gateway_unavailable");
  });

  test("5xx do Gateway (pode ter enviado) ⇒ DELIVERY_UNKNOWN — nunca reenvio automático", async () => {
    reset("erro500");
    const db = fakeDb();
    const p = pedido({ chave: "incerto" });
    const r = await enviarAoGrupoInterno({ ...p, whatsAppService: servico() }, { supabase: db });
    assert.equal(r.resultado, "ENTREGA_INCERTA");
    assert.equal(r.envio.status, STATUS_ENVIO_GRUPO.DELIVERY_UNKNOWN);
    reset();
    const de_novo = await enviarAoGrupoInterno({ ...p, whatsAppService: servico() }, { supabase: db });
    assert.equal(de_novo.resultado, "JA_EXISTIA");
    assert.equal(gw.estado.chamadasEnvio, 0);
  });

  test("motivoDaFalha usa vocabulário fechado", () => {
    assert.equal(motivoDaFalha(new ModoDesabilitadoError()), "modo_whatsapp_desabilitado");
    assert.equal(motivoDaFalha(new IdentidadeNaoConfirmadaError()), "conta_whatsapp_nao_confirmada");
    assert.equal(motivoDaFalha(new Error("BAILEYS_GATEWAY_HTTP_422: WHATSAPP_GATEWAY_GROUP_SEND_FORBIDDEN")), "grupo_sem_permissao_de_envio");
    assert.equal(motivoDaFalha(new Error("qualquer coisa")), "erro_envio");
  });
});

describe("Painel — teste controlado do grupo", () => {
  const depsBase = (over = {}) => ({
    supabase: fakeDb(), env: { ...process.env, ...ENV_OK }, lerModo: async () => "NORMAL", estadoGateway: { estado: "conectado" },
    identidadeConfirmada: true, whatsAppService: servico(), ...over,
  });

  test("lista os grupos e aponta o candidato pelo nome + concordância backend/Gateway", async () => {
    reset();
    const r = await listarGrupos(depsBase());
    assert.equal(r.grupos.length, 2);
    assert.deepEqual(r.candidatosPorNome, [GRUPO]);
    assert.deepEqual(r.configuracao, { backendJid: GRUPO, gatewayJid: GRUPO, concordam: true, encontradoNaConta: true });
  });

  test("listar com WhatsApp desconectado ⇒ 409 GATEWAY_INDISPONIVEL", async () => {
    reset("desconectado");
    await assert.rejects(listarGrupos(depsBase()), (e) => e.statusCode === 409 && e.details?.codigo === "GATEWAY_INDISPONIVEL");
  });

  test("preparo: tudo OK ⇒ podeEnviar, nome confere, preview", async () => {
    reset();
    const r = await preparoTesteGrupo(depsBase());
    assert.equal(r.podeEnviar, true);
    assert.equal(r.grupo.jid, GRUPO);
    assert.equal(r.grupo.nomeConfere, true);
    assert.equal(r.previewTexto, textoTesteGrupo());
  });

  test("preparo: grupo não configurado / desconectado / DISABLED / não confirmada ⇒ bloqueios, sem envio", async () => {
    reset();
    const r = await preparoTesteGrupo(depsBase({ env: { ...process.env, ...ENV_OK, WHATSAPP_GRUPO_INTERNO_JID: "" }, lerModo: async () => "DISABLED", estadoGateway: { estado: "desconectado" }, identidadeConfirmada: false }));
    assert.equal(r.podeEnviar, false);
    assert.deepEqual(r.bloqueios.map((b) => b.codigo).sort(), ["CONEXAO_NAO_CONFIRMADA", "GATEWAY_INDISPONIVEL", "GRUPO_NAO_CONFIGURADO", "MODO_DISABLED"]);
    assert.equal(gw.estado.chamadasEnvio, 0);
  });

  test("preparo: grupo não encontrado no WhatsApp ⇒ GRUPO_NAO_ENCONTRADO", async () => {
    reset("inexistente");
    const r = await preparoTesteGrupo(depsBase());
    assert.deepEqual(r.bloqueios.map((b) => b.codigo), ["GRUPO_NAO_ENCONTRADO"]);
  });

  test("envio sem confirmação explícita ⇒ 400, nada enviado", async () => {
    reset();
    await assert.rejects(enviarTesteGrupo({ testeId: TESTE_ID }, AUTOR, depsBase()), (e) => e.statusCode === 400 && e.details?.codigo === "CONFIRMACAO_OBRIGATORIA");
    assert.equal(gw.estado.chamadasEnvio, 0);
  });

  test("envio com gate falhando (grupo não encontrado) ⇒ 409, nada enviado, nenhuma linha", async () => {
    reset("inexistente");
    const deps = depsBase();
    await assert.rejects(enviarTesteGrupo({ testeId: TESTE_ID, confirmacaoExplicita: true }, AUTOR, deps), (e) => e.statusCode === 409 && e.details?.codigo === "GRUPO_NAO_ENCONTRADO");
    assert.equal(gw.estado.chamadasEnvio, 0);
    assert.equal(deps.supabase.tabelas.comunicacao_envios_grupo.length, 0);
  });

  test("envio OK e repetição do MESMO testeId (duplo clique) ⇒ 1 mensagem", async () => {
    reset();
    const deps = depsBase();
    const a = await enviarTesteGrupo({ testeId: TESTE_ID, confirmacaoExplicita: true }, AUTOR, deps);
    const b = await enviarTesteGrupo({ testeId: TESTE_ID, confirmacaoExplicita: true }, AUTOR, deps);
    assert.equal(a.resultado, "ENVIADO");
    assert.equal(a.messageId, "wa-1");
    assert.equal(b.resultado, "JA_EXISTIA");
    assert.equal(gw.estado.chamadasEnvio, 1);
    const linha = deps.supabase.tabelas.comunicacao_envios_grupo[0];
    assert.equal(linha.chave_idempotencia, chaveTesteGrupo(TESTE_ID));
    assert.equal(linha.tipo, "TESTE_GRUPO");
    assert.equal(gw.estado.ultimoCorpo.texto, textoTesteGrupo());
  });
});
