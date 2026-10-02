// Cache de retry (src/retryCache.js) — o getMessage do Baileys 6.7.24 com o banco como fonte da verdade.
// Itens 1–12 do checkpoint "WhatsApp Retry Resend" (o 7 — isolamento entre organizações — mora no backend:
// backend/test/whatsapp-retry-cache-routes.test.js e o teste em Postgres real, porque o Gateway não conhece organização).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { proto, generateWAMessageContent } from "baileys";
import { criarCacheRetry, criarCacheTtl, hashId, tipoJid, tipoDispositivo, RETRY_PAYLOAD_MAX_BYTES } from "../src/retryCache.js";
import { derivarChave, decriptarBytes, normalizarChave } from "../src/crypto.js";
import { criarBackendRetryFalso, erroBackendFora, erroRotaAusente } from "../test-support/backendRetryFalso.js";

const CHAVE = randomBytes(32).toString("base64");
const TEXTO = "Alerta Crescer: conteúdo-que-nunca-pode-vazar 4321";
const ID = "3EB0ABCDEF0123456789AB";
const DESTINO = "5511987654321@s.whatsapp.net";
const DESTINO_LID = "123456789012345@lid";
const H = 60 * 60 * 1000;

async function mensagemReal(texto = TEXTO) { return generateWAMessageContent({ text: texto }, {}); }

function montar({ habilitado = true, backend, relogio, maxReenvios, ttlHoras, lease } = {}) {
  const tempo = relogio ?? { t: 1_800_000_000_000 };
  const be = backend ?? criarBackendRetryFalso({ agora: () => tempo.t });
  const eventos = [];
  const cache = criarCacheRetry({
    backendClient: be, chaveEncriptacaoEnv: CHAVE, providerInstanceId: "default",
    obterContextoLease: () => (lease === null ? null : { ...be.lease }), habilitado, ttlHoras, maxReenvios,
    emitir: (nivel, evento, dados) => eventos.push({ nivel, evento, dados }), agora: () => tempo.t, esperaPendenteMs: 200, atrasoRetentativaMs: 5,
  });
  return { cache, be, eventos, tempo };
}
const chave = (extra = {}) => ({ remoteJid: DESTINO, id: ID, fromMe: true, participant: DESTINO, ...extra });
const como = (m) => proto.Message.toObject(m);

describe("cache de retry — registrar e recuperar", () => {
  test("1. envio persiste a mensagem: o backend recebe SÓ ciphertext + HMAC do destino, com TTL e teto, sob a lease", async () => {
    const { cache, be } = montar();
    const r = await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO });
    assert.equal(r.status, "persistido");
    const p = be.chamadas.salvar[0];
    assert.match(p.payloadCifrado, /^r1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    assert.equal(p.payloadVersao, "r1");
    assert.match(p.destinoHash, /^[0-9a-f]{64}$/);
    assert.equal(p.destinoLidHash, null);
    assert.equal(p.ttlSegundos, 168 * 3600);
    assert.equal(p.maxReenvios, 15);
    assert.equal(p.gatewayProcessId, be.lease.gatewayProcessId);
    assert.equal(p.leaseEpoch, be.lease.leaseEpoch);
    assert.equal(be.linhas.size, 1);
  });

  test("2/3. getMessage encontra a mensagem e devolve EXATAMENTE o proto.Message enviado (mesmos bytes)", async () => {
    const { cache } = montar();
    const original = await mensagemReal();
    await cache.registrarEnvio({ providerMessageId: ID, mensagem: original, destinoJid: DESTINO });
    const devolvida = await cache.obterMensagemParaRetry(chave());
    assert.ok(devolvida instanceof proto.Message, "contrato do Baileys: proto.IMessage");
    assert.deepEqual(como(devolvida), como(original));
    assert.deepEqual(Buffer.from(proto.Message.encode(devolvida).finish()), Buffer.from(proto.Message.encode(original).finish()));
    assert.notEqual(devolvida, original, "nunca a MESMA referência que o chamador ainda pode mutar");
  });

  test("5. restart do PROCESSO simulado: memória vazia, o banco responde (fonte=banco)", async () => {
    const tempo = { t: 1_800_000_000_000 };
    const be = criarBackendRetryFalso({ agora: () => tempo.t });
    const a = montar({ backend: be, relogio: tempo });
    await a.cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO });
    const b = montar({ backend: be, relogio: tempo }); // processo novo: memória zerada, mesma chave mestra (env)
    assert.equal(b.cache._memoria.size, 0);
    const m = await b.cache.obterMensagemParaRetry(chave());
    assert.equal(como(m).extendedTextMessage.text, TEXTO);
    assert.equal(b.eventos.find((e) => e.evento === "whatsapp.retry.message_found").dados.fonte, "banco");
  });

  test("6. mensagem expirada não é devolvida (banco E memória respeitam o TTL)", async () => {
    const { cache, tempo, eventos, be } = montar({ ttlHoras: 2 });
    await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO });
    tempo.t += 2 * H + 1;
    assert.equal(await cache.obterMensagemParaRetry(chave()), undefined);
    assert.equal(eventos.at(-1).dados.motivo, "expirada");
    assert.equal(be.linhas.size, 0, "o backend apaga a linha expirada ao consumir");
  });

  test("8. providerMessageId errado ⇒ undefined (e o motivo é registrado, sem o id em claro)", async () => {
    const { cache, eventos } = montar();
    await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO });
    assert.equal(await cache.obterMensagemParaRetry(chave({ id: "3EB0FFFFFFFFFFFFFFFFFF" })), undefined);
    const ev = eventos.at(-1);
    assert.equal(ev.evento, "whatsapp.retry.message_missing");
    assert.equal(ev.dados.motivo, "nao_encontrada");
    assert.equal(ev.dados.idHash, hashId("3EB0FFFFFFFFFFFFFFFFFF"));
    assert.ok(!JSON.stringify(eventos).includes("3EB0FFFFFFFFFFFFFFFFFF"));
  });

  test("9. o 'banco' guarda conteúdo CIFRADO: sem texto em claro; só decifra com a subchave E o contexto certos", async () => {
    const { cache, be } = montar();
    await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO });
    const gravado = JSON.stringify([...be.linhas.values()]);
    assert.ok(!gravado.includes(TEXTO));
    assert.ok(!gravado.includes(Buffer.from(TEXTO).toString("base64")));
    assert.ok(!gravado.includes("5511987654321"), "nem o telefone do destino");
    const { payloadCifrado } = be.linhas.get(ID);
    const sub = derivarChave(normalizarChave(CHAVE), "crescer/whatsapp/retry-cache/payload/v1");
    assert.equal(proto.Message.toObject(proto.Message.decode(decriptarBytes(payloadCifrado, sub, `r1|default|${ID}`))).extendedTextMessage.text, TEXTO);
    assert.throws(() => decriptarBytes(payloadCifrado, sub, "r1|default|3EB0OUTROID000000000000"), "AAD de outra mensagem não decifra (linha trocada no banco)");
    assert.throws(() => decriptarBytes(payloadCifrado, normalizarChave(CHAVE), `r1|default|${ID}`), "a chave do auth state, sem derivação, não decifra");
  });

  test("9b. IV nunca reutilizado: a mesma mensagem cifrada duas vezes gera ciphertexts e IVs diferentes", async () => {
    const be = criarBackendRetryFalso();
    const a = montar({ backend: be });
    const m = await mensagemReal();
    await a.cache.registrarEnvio({ providerMessageId: ID, mensagem: m, destinoJid: DESTINO });
    await a.cache.registrarEnvio({ providerMessageId: "3EB0ABCDEF0123456789AC", mensagem: m, destinoJid: DESTINO });
    const [p1, p2] = be.chamadas.salvar.map((c) => c.payloadCifrado.split(":"));
    assert.notEqual(p1[1], p2[1], "IVs distintos");
    assert.notEqual(p1[3], p2[3]);
  });

  test("10. cada reenvio servido incrementa o contador no banco", async () => {
    const { cache, be } = montar();
    await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO });
    cache._memoria.clear(); // força o caminho do banco
    await cache.obterMensagemParaRetry(chave());
    assert.equal(be.linhas.get(ID).reenvios, 1);
    await cache.obterMensagemParaRetry(chave({ participant: "5511987654321:2@s.whatsapp.net", remoteJid: "5511987654321:2@s.whatsapp.net" }));
    assert.equal(be.linhas.get(ID).reenvios, 2);
  });

  test("11. teto de reenvios respeitado (banco ESGOTADA ⇒ undefined + whatsapp.retry.exhausted); a memória também respeita", async () => {
    const { cache, eventos, be } = montar({ maxReenvios: 2 });
    await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO });
    assert.ok(await cache.obterMensagemParaRetry(chave()));
    assert.ok(await cache.obterMensagemParaRetry(chave()));
    assert.equal(await cache.obterMensagemParaRetry(chave()), undefined);
    assert.equal(eventos.at(-1).evento, "whatsapp.retry.exhausted");
    // backend fora: a memória aplica o MESMO teto (já serviu 2 ⇒ nada)
    be.falharProximas("consumir", 1, erroBackendFora);
    assert.equal(await cache.obterMensagemParaRetry(chave()), undefined);
    assert.equal(cache.metricas().esgotado, 2);
  });

  test("12 (memória). entradas expiradas saem da memória a cada novo registro", async () => {
    const { cache, tempo } = montar({ ttlHoras: 1 });
    await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO });
    tempo.t += H + 1;
    await cache.registrarEnvio({ providerMessageId: "3EB0ABCDEF0123456789AC", mensagem: await mensagemReal(), destinoJid: DESTINO });
    assert.deepEqual([...cache._memoria.keys()], ["3EB0ABCDEF0123456789AC"]);
  });
});

describe("cache de retry — robustez e segurança", () => {
  test("retry que chega ANTES do registro terminar espera o envio (janela observada de 0,5–1,5 s)", async () => {
    const { cache } = montar();
    cache.marcarEnvioIniciado(ID);
    const p = cache.obterMensagemParaRetry(chave());
    await new Promise((r) => setTimeout(r, 30));
    await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO });
    assert.equal(como(await p).extendedTextMessage.text, TEXTO);
  });

  test("backend fora do ar ou rota ainda ausente (rolling deploy): a memória deste processo cobre; sem memória ⇒ undefined", async () => {
    const { cache, be, eventos } = montar();
    be.falharProximas("salvar", 1, erroRotaAusente);
    const r = await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO });
    assert.equal(r.status, "falhou");
    assert.equal(eventos.find((e) => e.evento === "whatsapp.retry.cache_persistencia_falhou").dados.capacidadeAusente, true);
    be.falharProximas("consumir", 1, erroBackendFora);
    assert.ok(await cache.obterMensagemParaRetry(chave()), "memória cobre a queda do backend");
    assert.equal(eventos.find((e) => e.evento === "whatsapp.retry.message_found").dados.fonte, "memoria_backend_indisponivel");
    // backend volta respondendo NAO_ENCONTRADA (gravação tinha falhado): ainda serve da memória
    assert.ok(await cache.obterMensagemParaRetry(chave()));
    cache._memoria.clear();
    be.falharProximas("consumir", 1, erroBackendFora);
    assert.equal(await cache.obterMensagemParaRetry(chave()), undefined);
  });

  test("falha transitória na gravação é retentada UMA vez; lease perdida nunca é retentada", async () => {
    const { cache, be } = montar();
    be.falharProximas("salvar", 1, erroBackendFora);
    const r = await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO });
    assert.equal(r.status, "persistido");
    assert.equal(be.chamadas.salvar.length, 2);
    // processo que perdeu a lease (epoch antigo): o backend recusa (409 stale) e NÃO há retentativa
    const epochAntigo = { ...be.lease };
    be.trocarDono({ leaseEpoch: 99 });
    const stale = criarCacheRetry({ backendClient: be, chaveEncriptacaoEnv: CHAVE, obterContextoLease: () => epochAntigo, habilitado: true, emitir: () => {}, atrasoRetentativaMs: 5 });
    const antes = be.chamadas.salvar.length;
    const r2 = await stale.registrarEnvio({ providerMessageId: "3EB0ABCDEF0123456789AC", mensagem: await mensagemReal(), destinoJid: DESTINO });
    assert.equal(r2.status, "falhou");
    assert.equal(be.chamadas.salvar.length - antes, 1, "uma única tentativa");
  });

  test("destino divergente: o conteúdo NUNCA é reenviado a outro usuário (PN), e LID só quando conhecido", async () => {
    const { cache, eventos } = montar();
    await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO, destinoLid: DESTINO_LID });
    assert.equal(await cache.obterMensagemParaRetry(chave({ remoteJid: "5511900000000@s.whatsapp.net", participant: "5511900000000@s.whatsapp.net" })), undefined);
    assert.equal(eventos.at(-1).dados.motivo, "destino_divergente");
    assert.equal(await cache.obterMensagemParaRetry(chave({ remoteJid: "999999999999999@lid", participant: "999999999999999@lid" })), undefined);
    assert.ok(await cache.obterMensagemParaRetry(chave({ remoteJid: "123456789012345:3@lid", participant: "123456789012345:3@lid" })), "LID conhecido e igual");
    assert.ok(await cache.obterMensagemParaRetry(chave({ remoteJid: "5511987654321:2@s.whatsapp.net" })), "sufixo de aparelho não importa");
    assert.equal(await cache.obterMensagemParaRetry(chave({ remoteJid: "120363000000000001@g.us" })), undefined, "grupo nunca (não enviamos para grupo)");
  });

  test("LID desconhecido no envio: serve, mas marca destinoVerificado=false (medido em lidNaoVerificado)", async () => {
    const { cache, eventos } = montar();
    await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO });
    assert.ok(await cache.obterMensagemParaRetry(chave({ remoteJid: DESTINO_LID, participant: DESTINO_LID })));
    assert.equal(eventos.find((e) => e.evento === "whatsapp.retry.message_found").dados.destinoVerificado, false);
    assert.equal(cache.metricas().lidNaoVerificado, 1);
  });

  test("nada é registrado sem conteúdo, para destino não-PN ou acima do teto de tamanho", async () => {
    const { cache, be } = montar();
    assert.equal((await cache.registrarEnvio({ providerMessageId: ID, mensagem: undefined, destinoJid: DESTINO })).status, "ignorado");
    assert.equal((await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO_LID })).status, "ignorado");
    const enorme = await mensagemReal("x".repeat(RETRY_PAYLOAD_MAX_BYTES + 10));
    assert.equal((await cache.registrarEnvio({ providerMessageId: ID, mensagem: enorme, destinoJid: DESTINO })).status, "ignorado");
    assert.equal(be.chamadas.salvar.length, 0);
  });

  test("FLAG desligada: socket idêntico ao de antes (opcoesSocket = {}), nada gravado, getMessage não serve nada", async () => {
    const { cache, be } = montar({ habilitado: false });
    assert.deepEqual(cache.opcoesSocket(), {});
    assert.equal((await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO })).status, "desligado");
    assert.equal(be.chamadas.salvar.length, 0);
    assert.equal(await cache.obterMensagemParaRetry(chave()), undefined);
    // desligada não exige chave válida (nada é cifrado)
    assert.doesNotThrow(() => criarCacheRetry({ backendClient: be, chaveEncriptacaoEnv: "invalida", habilitado: false }));
  });

  test("FLAG ligada: getMessage + msgRetryCounterCache com escopo de PROCESSO (o mesmo objeto para todo socket)", () => {
    const { cache } = montar();
    const a = cache.opcoesSocket(); const b = cache.opcoesSocket();
    assert.equal(typeof a.getMessage, "function");
    assert.equal(a.msgRetryCounterCache, b.msgRetryCounterCache);
    for (const m of ["get", "set", "del", "flushAll"]) assert.equal(typeof a.msgRetryCounterCache[m], "function", `CacheStore.${m}`);
  });

  test("logs: nunca texto, telefone, JID, payload ou id em claro", async () => {
    const { cache, eventos, be } = montar();
    await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO, destinoLid: DESTINO_LID });
    await cache.obterMensagemParaRetry(chave());
    await cache.obterMensagemParaRetry(chave({ remoteJid: "5511900000000@s.whatsapp.net" }));
    const tudo = JSON.stringify(eventos);
    for (const proibido of [TEXTO, "5511987654321", "123456789012345", ID, be.linhas.get(ID).payloadCifrado, be.linhas.get(ID).destinoHash]) {
      assert.ok(!tudo.includes(proibido), `vazou: ${proibido.slice(0, 12)}…`);
    }
  });
});

describe("cache de retry — observabilidade e métricas", () => {
  test("whatsapp.retry.received: tipos PN/LID/NONE, aparelho, conta própria, count, sem identificadores", () => {
    const { cache, eventos } = montar();
    const ws = { handlers: {}, on(n, f) { this.handlers[n] = f; } };
    cache.observarSocket({ ws }, { obterGeracaoSocket: () => 9, obterIdentidade: () => ({ pnUser: "5511999990000", lidUser: "100000000000001" }) });
    ws.handlers["CB:receipt"]({ tag: "receipt", attrs: { id: ID, type: "retry", from: "123456789012345:2@lid" }, content: [{ tag: "retry", attrs: { count: "2", id: ID } }, { tag: "keys", attrs: {} }] });
    ws.handlers["CB:receipt"]({ tag: "receipt", attrs: { id: ID, type: "retry", from: "5511999990000:3@s.whatsapp.net", recipient: DESTINO }, content: [{ tag: "retry", attrs: { count: "1" } }] });
    ws.handlers["CB:receipt"]({ tag: "receipt", attrs: { id: ID, from: DESTINO } }); // receipt comum: ignorado
    const rec = eventos.filter((e) => e.evento === "whatsapp.retry.received").map((e) => e.dados);
    assert.equal(rec.length, 2);
    assert.deepEqual(
      { r: rec[0].remoteJidType, p: rec[0].participantType, d: rec[0].dispositivo, c: rec[0].retryCount, k: rec[0].comChaves, propria: rec[0].deContaPropria, fromMe: rec[0].fromMe, g: rec[0].socketGeneration },
      { r: "LID", p: "NONE", d: "companion", c: 2, k: true, propria: false, fromMe: true, g: 9 },
    );
    assert.equal(rec[1].deContaPropria, true, "retry pedido por aparelho da NOSSA conta");
    assert.equal(rec[1].recipientType, "PN");
    assert.ok(!JSON.stringify(eventos).includes("123456789012345"));
  });

  test("logger do Baileys: 4 mensagens exatas viram eventos (resend_sent, resend_failed, exhausted, ignorado), sem argumentos", async () => {
    const { cache, eventos } = montar();
    const chamadas = [];
    const base = { level: "silent", child: () => base, ...Object.fromEntries(["trace", "debug", "info", "warn", "error", "fatal"].map((n) => [n, (...a) => chamadas.push([n, a])])) };
    const l = cache.envolverLogger(base).child({ class: "x" });
    await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO });
    await cache.obterMensagemParaRetry(chave());
    l.debug({ msgId: ID }, "sending message to 2 devices");
    l.debug({ msgId: "OUTRO_ENVIO_NORMAL" }, "sending message to 3 devices");
    l.error({ key: { remoteJid: DESTINO }, ids: [ID], trace: "x" }, "error in sending message again");
    l.info({ attrs: {}, key: {} }, "will not send message again, as sent too many times");
    l.info({ attrs: {}, key: {} }, "recv retry for not fromMe message");
    const nomes = eventos.map((e) => e.evento);
    assert.equal(nomes.filter((n) => n === "whatsapp.retry.resend_sent").length, 1, "só o reenvio em curso conta");
    assert.equal(eventos.find((e) => e.evento === "whatsapp.retry.resend_sent").dados.dispositivos, 2);
    assert.ok(nomes.includes("whatsapp.retry.resend_failed"));
    assert.ok(nomes.includes("whatsapp.retry.exhausted"));
    assert.ok(nomes.includes("whatsapp.retry.ignorado_nao_fromme"));
    assert.equal(chamadas.length, 5, "o logger original continua recebendo tudo");
    assert.ok(!JSON.stringify(eventos).includes("5511987654321"));
  });

  test("12 (métricas). retry_received/hit/miss/resend/exhausted e cache_hit_rate", async () => {
    const { cache } = montar();
    await cache.registrarEnvio({ providerMessageId: ID, mensagem: await mensagemReal(), destinoJid: DESTINO });
    await cache.obterMensagemParaRetry(chave());
    await cache.obterMensagemParaRetry(chave());
    await cache.obterMensagemParaRetry(chave({ id: "3EB0FFFFFFFFFFFFFFFFFF" }));
    const m = cache.metricas();
    assert.equal(m.cacheHit, 2);
    assert.equal(m.cacheMiss, 1);
    assert.equal(m.reenvioSolicitado, 2);
    assert.equal(m.cacheHitRate, 0.667);
    assert.equal(m.habilitado, true);
  });

  test("emitirMetricas só emite quando algo mudou (ou forçado)", () => {
    const { cache, eventos } = montar();
    cache.emitirMetricas(); cache.emitirMetricas();
    assert.equal(eventos.filter((e) => e.evento === "whatsapp.retry.metricas").length, 1);
    cache.emitirMetricas({ forcar: true });
    assert.equal(eventos.filter((e) => e.evento === "whatsapp.retry.metricas").length, 2);
  });
});

describe("helpers", () => {
  test("tipoJid / tipoDispositivo / hashId nunca expõem o identificador", () => {
    assert.equal(tipoJid(DESTINO), "PN");
    assert.equal(tipoJid(DESTINO_LID), "LID");
    assert.equal(tipoJid("120363000000000001@g.us"), "GROUP");
    assert.equal(tipoJid("status@broadcast"), "OUTRO");
    assert.equal(tipoJid(undefined), "NONE");
    assert.equal(tipoDispositivo("5511987654321:2@s.whatsapp.net"), "companion");
    assert.equal(tipoDispositivo(DESTINO), "primario");
    assert.match(hashId(ID), /^[0-9a-f]{12}$/);
  });

  test("criarCacheTtl (msgRetryCounterCache): TTL e teto de entradas", () => {
    const t = { t: 0 };
    const c = criarCacheTtl({ ttlMs: 1000, maxEntradas: 2, agora: () => t.t });
    c.set("a", 1); c.set("b", 2); c.set("c", 3);
    assert.equal(c.get("a"), undefined, "teto: a mais antiga sai");
    assert.equal(c.get("c"), 3);
    t.t = 1001;
    assert.equal(c.get("c"), undefined, "expirou");
    c.set("d", 4); c.del("d"); assert.equal(c.get("d"), undefined);
    c.set("e", 5); c.flushAll(); assert.equal(c.tamanho, 0);
  });
});
