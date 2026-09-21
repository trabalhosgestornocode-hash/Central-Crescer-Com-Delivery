// Checkpoint F — inbound: ROTA (validação + persistência idempotente + quarentena), REPO (memória e Supabase com RPC falsa), defesa em profundidade
// (provider/service) e a MIGRATION 090 (estática + paridade de vocabulário). Sem rede e sem banco: o que exige Postgres real fica em
// test/whatsapp-inbound-migration-pg.test.js (pula sozinho sem INBOUND_PG_URL).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import { createServer } from "node:http";
import { exigirHmac, assinarRequisicao, _resetarNonces } from "../src/modules/comunicacao/gateway/whatsappGateway.hmac.js";
import { criarWhatsappGatewayRouter } from "../src/modules/comunicacao/gateway/whatsappGateway.routes.js";
import { criarRepoEmMemoria, criarRepoSupabase } from "../src/modules/comunicacao/gateway/whatsappGateway.repo.js";
import { criarBaileysGatewayProvider } from "../src/modules/comunicacao/providers/baileysGateway.provider.js";
import { criarWhatsAppService } from "../src/modules/comunicacao/whatsapp.service.js";
import { ORIGENS_TIPO, ORIGENS_JID_TIPO, MOTIVOS_FALHA_DECRYPT, ESTADOS_INBOUND } from "../src/modules/comunicacao/inbound/inbound.contrato.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const SEGREDO = "s".repeat(32);
const ORG = "org-inbound-1";
const ORG2 = "org-inbound-2";
const semTelefone = { telefoneE164: null, telefoneOrigem: null };
let seq = 0;
const evento = (extra = {}) => ({
  contratoInbound: 1, providerMessageId: `MSG${++seq}`, origemTipo: "LIVE", origemJidTipo: "direct_pn", fromMe: false,
  telefoneE164: "+5511999990000", telefoneOrigem: "JID_PN", falhaDecrypt: false, motivoFalhaDecrypt: null, stubSistema: false,
  recebidoEm: new Date().toISOString(), ...extra,
});

describe("POST /eventos/mensagem-recebida — contrato, persistência idempotente e quarentena", () => {
  let servidor, baseUrl, servidor2, baseUrl2, repo, provider, servico, recebidosProvider, recebidosServico;

  before(async () => {
    repo = criarRepoEmMemoria();
    provider = criarBaileysGatewayProvider({ gatewayUrl: "http://unused.invalid", segredoHmac: SEGREDO });
    servico = criarWhatsAppService({ provider });
    recebidosProvider = []; recebidosServico = [];
    provider.onMessage((m) => recebidosProvider.push(m));                    // handler DIRETO no provider (o caminho mais fraco)
    servico.onMensagemRecebida((m) => recebidosServico.push(m));             // handler via service (o caminho do futuro Agente)
    const montar = (org) => { const app = express(); app.use("/internal/comunicacao", express.raw({ type: "*/*", limit: 256 * 1024 }), exigirHmac(SEGREDO), criarWhatsappGatewayRouter({ repo, organizacaoId: org, provider })); return app; };
    await new Promise((r) => { servidor = createServer(montar(ORG)).listen(0, r); });
    await new Promise((r) => { servidor2 = createServer(montar(ORG2)).listen(0, r); });
    baseUrl = `http://127.0.0.1:${servidor.address().port}`; baseUrl2 = `http://127.0.0.1:${servidor2.address().port}`;
  });
  after(() => { servidor.close(); servidor2.close(); });

  async function postar(corpoObj, url = baseUrl) {
    _resetarNonces();
    const corpo = JSON.stringify(corpoObj); const caminho = "/internal/comunicacao/eventos/mensagem-recebida";
    const headers = assinarRequisicao({ segredo: SEGREDO, metodo: "POST", caminho, corpo }); headers["Content-Type"] = "application/json";
    const r = await fetch(`${url}${caminho}`, { method: "POST", headers, body: corpo });
    return { status: r.status, corpo: await r.json() };
  }
  const zerar = () => { recebidosProvider.length = 0; recebidosServico.length = 0; };

  test("1. LIVE válido ⇒ 200, persistido como RECEIVED, e é o ÚNICO tipo que chega aos handlers (provider e service)", async () => {
    zerar(); const e = evento();
    const r = await postar(e);
    assert.deepEqual([r.status, r.corpo], [200, { ok: true, duplicada: false, estado: "RECEIVED" }]);
    assert.equal(recebidosProvider.length, 1); assert.equal(recebidosServico.length, 1); assert.equal(recebidosProvider[0].providerMessageId, e.providerMessageId);
    assert.equal(repo._inbound(ORG).find((x) => x.providerMessageId === e.providerMessageId).estado, "RECEIVED");
  });

  test("10. DUPLICATA ⇒ uma persistência lógica, estado original preservado e NENHUMA ação duplicada", async () => {
    zerar(); const e = evento(); const antes = repo._inbound(ORG).length;
    assert.equal((await postar(e)).corpo.duplicada, false);
    const r2 = await postar({ ...e, origemTipo: "OFFLINE_RECOVERY" });            // mesma mensagem, agora reentregue por "recovery"
    assert.deepEqual([r2.status, r2.corpo], [200, { ok: true, duplicada: true, estado: "RECEIVED" }]);
    assert.equal(repo._inbound(ORG).length, antes + 1);
    assert.equal(repo._inbound(ORG).find((x) => x.providerMessageId === e.providerMessageId).origemTipo, "LIVE", "a repetição não sobrescreve");
    assert.equal(recebidosProvider.length, 1, "o handler só rodou na 1ª vez"); assert.equal(recebidosServico.length, 1);
  });

  test("2/14. OFFLINE_NORMAL ⇒ HISTORICO; OFFLINE_RECOVERY ⇒ QUARANTINED — NUNCA chegam a handler algum", async () => {
    zerar();
    const a = await postar(evento({ origemTipo: "OFFLINE_NORMAL" })); const b = await postar(evento({ origemTipo: "OFFLINE_RECOVERY" }));
    assert.deepEqual([a.status, a.corpo.estado, b.status, b.corpo.estado], [200, "HISTORICO", 200, "QUARANTINED"]);
    assert.deepEqual([recebidosProvider.length, recebidosServico.length], [0, 0]);
  });

  test("15/16. fromMe ⇒ IGNORED (nunca cria contato de cliente); falha de decrypt ⇒ QUARANTINED (não é mensagem conversacional); stub de sistema ⇒ IGNORED", async () => {
    zerar();
    const a = await postar(evento({ fromMe: true, ...semTelefone }));
    const b = await postar(evento({ falhaDecrypt: true, motivoFalhaDecrypt: "bad_mac" }));
    const c = await postar(evento({ stubSistema: true }));
    assert.deepEqual([a.corpo.estado, b.corpo.estado, c.corpo.estado], ["IGNORED", "QUARANTINED", "IGNORED"]);
    assert.deepEqual([recebidosProvider.length, recebidosServico.length], [0, 0]);
    for (const r of repo._inbound(ORG).filter((x) => x.fromMe)) assert.equal(r.telefoneE164, null, "fromMe não guarda telefone");
  });

  test("grupo/status/newsletter/broadcast/LID próprio ⇒ IGNORED (LIVE, mas não é cliente direto); LID externo sem telefone ⇒ RECEIVED", async () => {
    zerar();
    for (const t of ["group", "status", "newsletter", "broadcast", "direct_lid_self", "meta_ai", "technical", "unknown"]) assert.equal((await postar(evento({ origemJidTipo: t, ...semTelefone }))).corpo.estado, "IGNORED", t);
    assert.equal(recebidosProvider.length, 0);
    assert.equal((await postar(evento({ origemJidTipo: "direct_lid_other", ...semTelefone }))).corpo.estado, "RECEIVED");
    assert.equal(recebidosProvider.length, 1, "cliente direto por LID (sem telefone) é elegível");
  });

  test("4. enum inválido ⇒ 400 com CÓDIGO fechado; nada persistido, nenhum handler", async () => {
    zerar(); const antes = repo._inbound(ORG).length;
    const r = await postar(evento({ origemTipo: "recovery" }));
    assert.deepEqual([r.status, r.corpo], [400, { error: "mensagem_recebida_invalida", campo: "origemTipo" }]);
    assert.equal(repo._inbound(ORG).length, antes); assert.equal(recebidosProvider.length, 0);
  });

  test("5/6/7. LID/grupo/status com telefone fabricado ⇒ 400 (LID de 15 dígitos incluso); o payload legado (só id+telefone) também é recusado", async () => {
    zerar(); const antes = repo._inbound(ORG).length;
    const casos = [
      evento({ origemJidTipo: "direct_lid_other", telefoneE164: "+100000000000001", telefoneOrigem: "JID_PN" }),
      evento({ origemJidTipo: "direct_lid_other", telefoneE164: "+100000000000001", telefoneOrigem: null }),
      evento({ origemJidTipo: "group", telefoneE164: "+5511999990000", telefoneOrigem: "JID_PN" }),
      evento({ origemJidTipo: "status", telefoneE164: "+5511999990000", telefoneOrigem: "SENDER_PN" }),
      { providerMessageId: "m1", telefoneE164: "+5511999990000" },
    ];
    for (const c of casos) assert.equal((await postar(c)).status, 400);
    assert.equal(repo._inbound(ORG).length, antes); assert.deepEqual([recebidosProvider.length, recebidosServico.length], [0, 0]);
  });

  test("8/9. falhaDecrypt sem motivo e motivo sem falhaDecrypt ⇒ 400", async () => {
    assert.equal((await postar(evento({ falhaDecrypt: true }))).corpo.campo, "falha_sem_motivo");
    assert.equal((await postar(evento({ motivoFalhaDecrypt: "bad_mac" }))).corpo.campo, "motivo_sem_falha");
  });

  test("11. CROSS-ORG: a mesma mensagem em outra organização é OUTRA linha; organizacao_id no corpo é recusado (o org vem da config do backend)", async () => {
    const e = evento();
    assert.equal((await postar(e, baseUrl)).corpo.duplicada, false); assert.equal((await postar(e, baseUrl2)).corpo.duplicada, false);
    assert.equal(repo._inbound(ORG).filter((x) => x.providerMessageId === e.providerMessageId).length, 1);
    assert.equal(repo._inbound(ORG2).filter((x) => x.providerMessageId === e.providerMessageId).length, 1);
    const inj = await postar({ ...evento(), organizacao_id: ORG2 });
    assert.deepEqual([inj.status, inj.corpo.campo], [400, "campo_desconhecido"]);
    assert.equal((await postar(e, baseUrl)).corpo.duplicada, true, "dentro da mesma org continua duplicada");
  });

  test("a resposta nunca ecoa id, telefone nem valores do payload (só ok/duplicada/estado ou um código de erro)", async () => {
    const e = evento({ providerMessageId: "ID-SECRETO-12345" });
    const r = await postar(e); assert.ok(!JSON.stringify(r).includes("ID-SECRETO") && !JSON.stringify(r).includes("5511999990000"));
    const ruim = await postar({ ...e, telefoneE164: "lixo-5511999990000" }); assert.ok(!JSON.stringify(ruim).includes("5511999990000"));
  });

  test("defesa em profundidade: provider e service bloqueiam MESMO chamados direto com evento não elegível (recovery, offline, fromMe, falha, grupo, legado)", () => {
    zerar();
    const ruins = [evento({ origemTipo: "OFFLINE_RECOVERY" }), evento({ origemTipo: "OFFLINE_NORMAL" }), evento({ fromMe: true, ...semTelefone }), evento({ falhaDecrypt: true, motivoFalhaDecrypt: "bad_mac" }),
      evento({ origemJidTipo: "group", ...semTelefone }), { providerMessageId: "x", telefoneE164: "+5511999990000" }, null, undefined, "x", { ...evento(), estado: "QUARANTINED" }];
    for (const m of ruins) assert.doesNotThrow(() => provider._receberEventoMensagem(m));
    assert.deepEqual([recebidosProvider.length, recebidosServico.length], [0, 0]);
    provider._receberEventoMensagem(evento());
    assert.deepEqual([recebidosProvider.length, recebidosServico.length], [1, 1]);
  });
});

describe("repo em memória (inbound próprio)", () => {
  test("persiste com o estado decidido; duplicata idempotente; organizacaoId obrigatório", async () => {
    const repo = criarRepoEmMemoria(); const e = evento({ origemTipo: "OFFLINE_RECOVERY" });
    assert.deepEqual(await repo.registrarMensagemRecebida("o1", e), { duplicada: false, estado: "QUARANTINED" });
    assert.deepEqual(await repo.registrarMensagemRecebida("o1", { ...e, origemTipo: "LIVE" }), { duplicada: true, estado: "QUARANTINED" });
    assert.deepEqual(await repo.registrarMensagemRecebida("o2", e), { duplicada: false, estado: "QUARANTINED" });
    for (const ruim of [undefined, null, "", 5]) await assert.rejects(() => repo.registrarMensagemRecebida(ruim, evento()));
    const r = repo._inbound("o1")[0]; assert.ok(!("status" in r) && !("conteudo" in r) && !("SCHEDULED" in r), "nada de outbox/conteúdo");
  });
});

describe("repo Supabase (RPC falsa): atômico no banco, org só do parâmetro", () => {
  const fake = (resp) => { const chamadas = []; return { chamadas, supabase: { rpc: async (nome, args) => { chamadas.push([nome, args]); return typeof resp === "function" ? resp(nome, args) : resp; } } }; };

  test("chama SÓ whatsapp_inbound_registrar com o estado decidido no Node e o org do parâmetro; mapeia inserido/duplicada", async () => {
    const repo = criarRepoSupabase(); const e = evento({ origemTipo: "OFFLINE_NORMAL" });
    const f = fake({ data: [{ inserido: true, estado_atual: "HISTORICO" }], error: null });
    assert.deepEqual(await repo.registrarMensagemRecebida("11111111-1111-1111-1111-111111111111", e, { supabase: f.supabase }), { duplicada: false, estado: "HISTORICO" });
    assert.equal(f.chamadas.length, 1); const [nome, args] = f.chamadas[0];
    assert.equal(nome, "whatsapp_inbound_registrar");
    assert.deepEqual(args, {
      p_organizacao_id: "11111111-1111-1111-1111-111111111111", p_provider_message_id: e.providerMessageId, p_origem_tipo: "OFFLINE_NORMAL", p_origem_jid_tipo: "direct_pn",
      p_telefone_e164: "+5511999990000", p_telefone_origem: "JID_PN", p_from_me: false, p_falha_decrypt: false, p_motivo_falha_decrypt: null, p_stub_sistema: false,
      p_estado: "HISTORICO", p_recebido_em: e.recebidoEm,
    });
    const dup = fake({ data: [{ inserido: false, estado_atual: "RECEIVED" }], error: null });
    assert.deepEqual(await repo.registrarMensagemRecebida("o", e, { supabase: dup.supabase }), { duplicada: true, estado: "RECEIVED" });
  });

  test("o payload não consegue sobrescrever o organizacao_id; recovery/fromMe/falha vão como QUARANTINED/IGNORED; erro do banco e resposta malformada viram erro (nunca sucesso silencioso)", async () => {
    const repo = criarRepoSupabase();
    const f = fake({ data: [{ inserido: true, estado_atual: "QUARANTINED" }], error: null });
    await repo.registrarMensagemRecebida("org-do-config", { ...evento({ origemTipo: "OFFLINE_RECOVERY" }), organizacao_id: "org-injetado" }, { supabase: f.supabase });
    assert.equal(f.chamadas[0][1].p_organizacao_id, "org-do-config"); assert.equal(f.chamadas[0][1].p_estado, "QUARANTINED");
    await repo.registrarMensagemRecebida("o", evento({ fromMe: true, ...semTelefone }), { supabase: f.supabase }); assert.equal(f.chamadas[1][1].p_estado, "IGNORED");
    await repo.registrarMensagemRecebida("o", evento({ falhaDecrypt: true, motivoFalhaDecrypt: "sem_sessao" }), { supabase: f.supabase }); assert.equal(f.chamadas[2][1].p_estado, "QUARANTINED");
    await assert.rejects(() => repo.registrarMensagemRecebida("o", evento(), { supabase: fake({ data: null, error: { message: "boom" } }).supabase }));
    for (const ruim of [[], [{}], [{ inserido: "sim", estado_atual: "RECEIVED" }], [{ inserido: true }], null]) await assert.rejects(() => repo.registrarMensagemRecebida("o", evento(), { supabase: fake({ data: ruim, error: null }).supabase }), undefined, JSON.stringify(ruim));
    for (const ruim of [undefined, null, ""]) await assert.rejects(() => repo.registrarMensagemRecebida(ruim, evento(), { supabase: f.supabase }));
  });
});

describe("inbound NUNCA toca a outbox (comunicacao_mensagens / claim / SCHEDULED)", () => {
  const src = (p) => readFileSync(join(aqui, "..", "src", "modules", "comunicacao", ...p), "utf8").replace(/\r\n/g, "\n");
  const semComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const corpoDe = (s, inicio, fim) => { const i = s.indexOf(inicio); assert.ok(i >= 0, inicio); return s.slice(i, s.indexOf(fim, i)); };

  test("os caminhos de inbound (contrato, repo, rota) não referenciam comunicacao_*, claim nem SCHEDULED", () => {
    const repoFonte = semComentarios(src(["gateway", "whatsappGateway.repo.js"]));
    const memoria = corpoDe(repoFonte, "async registrarMensagemRecebida(organizacaoId, evento) {", "_snapshot:");
    const supa = corpoDe(repoFonte, "async registrarMensagemRecebida(organizacaoId, evento, deps = {}) {", "async adquirirLease(");
    const rota = corpoDe(semComentarios(src(["gateway", "whatsappGateway.routes.js"])), 'router.post("/eventos/mensagem-recebida"', 'router.post("/eventos/status-provider"');
    const contrato = semComentarios(src(["inbound", "inbound.contrato.js"]));
    for (const [nome, trecho] of [["repo memória", memoria], ["repo supabase", supa], ["rota", rota], ["contrato", contrato]]) {
      assert.ok(!/comunicacao_|claim|SCHEDULED|comunicacao_mensagens/i.test(trecho), `${nome} referencia a outbox`);
    }
    assert.ok(/whatsapp_inbound_registrar/.test(supa) && !/\.from\(/.test(supa), "só a RPC própria; nenhuma tabela por .from()");
  });

  test("o inbound só sai da rota para o provider pelo caminho elegível (motivoBloqueioAutomacao === null) e o provider/service repetem a checagem", () => {
    const rota = corpoDe(semComentarios(src(["gateway", "whatsappGateway.routes.js"])), 'router.post("/eventos/mensagem-recebida"', 'router.post("/eventos/status-provider"');
    assert.ok(/motivoBloqueioAutomacao\(\{ \.\.\.v\.evento, estado: r\.estado \}\) === null/.test(rota) && /!r\.duplicada/.test(rota));
    assert.ok(/motivoBloqueioAutomacao\(mensagem\) !== null\) return;/.test(semComentarios(src(["providers", "baileysGateway.provider.js"]))));
    assert.ok(/motivoBloqueioAutomacao\(mensagem\) === null\) handler\(mensagem\)/.test(semComentarios(src(["whatsapp.service.js"]))));
  });
});

describe("MIGRATION 090 (estática)", () => {
  const raiz = join(aqui, "..", "..", "database", "migrations");
  const sql = readFileSync(join(raiz, "090_whatsapp_inbound_mensagens.sql"), "utf8").replace(/\r\n/g, "\n");
  const codigo = sql.replace(/--[^\n]*/g, "").replace(/comment on [^;]*;/gi, "");
  const lista = (nome) => { const m = codigo.match(new RegExp(`constraint ${nome} check \\((?:[a-z_]+ is null or )?[a-z_]+ in \\(([^)]*)\\)`, "i")); assert.ok(m, nome); return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]); };

  test("tabela própria, multi-tenant, sem conteúdo, com unicidade (organizacao_id, provider_message_id), RLS e privilégios revogados", () => {
    assert.ok(/create table if not exists whatsapp_inbound_mensagens/.test(codigo));
    assert.ok(/organizacao_id\s+uuid not null references organizacoes\(id\) on delete cascade/.test(codigo));
    assert.ok(/constraint whatsapp_inbound_unico unique \(organizacao_id, provider_message_id\)/.test(codigo));
    assert.ok(/alter table whatsapp_inbound_mensagens enable row level security;/.test(codigo));
    assert.ok(/revoke all on whatsapp_inbound_mensagens from public, anon, authenticated;/.test(codigo));
    assert.ok(!/\b(conteudo|texto|mensagem_texto|payload|body)\b/i.test(codigo.replace(/whatsapp_inbound_mensagens/g, "")), "sem coluna de conteúdo");
    assert.ok(!/comunicacao_|claim/i.test(codigo), "nada da outbox");
  });

  test("função de insert idempotente: on conflict do nothing, SECURITY INVOKER (padrão), só service_role executa", () => {
    assert.ok(/create or replace function whatsapp_inbound_registrar\(/.test(codigo) && /on conflict \(organizacao_id, provider_message_id\) do nothing/.test(codigo));
    assert.ok(!/security definer/i.test(codigo));
    assert.ok(/revoke all on function whatsapp_inbound_registrar\([^)]*\) from public, anon, authenticated;/.test(codigo));
    assert.ok(/grant execute on function whatsapp_inbound_registrar\([^)]*\) to service_role;/.test(codigo));
  });

  test("CHECKs do banco espelham as regras do contrato (telefone×origem×fromMe, falha×motivo, política de estado)", () => {
    for (const c of ["whatsapp_inbound_unico", "whatsapp_inbound_id_formato", "whatsapp_inbound_origem_tipo", "whatsapp_inbound_jid_tipo", "whatsapp_inbound_estado", "whatsapp_inbound_motivo",
      "whatsapp_inbound_telefone_formato", "whatsapp_inbound_telefone_origem_valor", "whatsapp_inbound_telefone_par", "whatsapp_inbound_telefone_coerente", "whatsapp_inbound_falha_motivo",
      "whatsapp_inbound_falha_ou_stub", "whatsapp_inbound_estado_elegivel", "whatsapp_inbound_estado_historico", "whatsapp_inbound_from_me_ignorado", "whatsapp_inbound_falha_quarentena", "whatsapp_inbound_recovery_quarentena"]) {
      assert.ok(codigo.includes(`constraint ${c}`), c);
    }
    assert.ok(/whatsapp_inbound_telefone_coerente check \(\s*telefone_e164 is null or \(\s*from_me = false and \(\s*\(origem_jid_tipo = 'direct_pn' and telefone_origem = 'JID_PN'\) or\s*\(origem_jid_tipo = 'direct_lid_other' and telefone_origem = 'SENDER_PN'\)/.test(codigo));
    assert.ok(/estado not in \('RECEIVED', 'PROCESSED'\) or \(\s*origem_tipo = 'LIVE' and from_me = false and falha_decrypt = false and stub_sistema = false/.test(codigo));
    assert.ok(/check \(falha_decrypt = \(motivo_falha_decrypt is not null\)\)/.test(codigo));
  });

  test("vocabulários do SQL = vocabulários do contrato (nada diverge)", () => {
    assert.deepEqual(lista("whatsapp_inbound_origem_tipo"), [...ORIGENS_TIPO]);
    assert.deepEqual(lista("whatsapp_inbound_jid_tipo"), [...ORIGENS_JID_TIPO]);
    assert.deepEqual(lista("whatsapp_inbound_estado"), [...ESTADOS_INBOUND]);
    assert.deepEqual(lista("whatsapp_inbound_motivo"), [...MOTIVOS_FALHA_DECRYPT]);
  });

  test("rollback remove a função e a tabela; o número 090 não colide com a 088 da origem/main", () => {
    const rb = readFileSync(join(raiz, "090_rollback.sql"), "utf8");
    assert.ok(/drop function if exists whatsapp_inbound_registrar\(/.test(rb) && /drop table if exists whatsapp_inbound_mensagens;/.test(rb));
  });
});
