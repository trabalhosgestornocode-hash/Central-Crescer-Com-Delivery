// Events do iFood — o poller só enxerga as unidades de IFOOD_ORDER_PILOT_UNITS (Checkpoint 6D).
//
// Antes: a lista do piloto só barrava o OAuth `order`; o poller consultava TODA conexão com credencial `order`
// (distribuído) ou TODA conexão com merchant (centralizado). Como o polling mantém a loja aberta no iFood,
// uma loja fora do piloto podia ser consultada, ter eventos reconhecidos e pedidos gravados.
//
// Agora (fail-closed): lista vazia = nenhuma loja; fora da lista = sem polling, sem token, sem ACK, sem
// reprocessamento. O critério é SEMPRE `unidade_id` da conexão. Nada é apagado quando a lista muda.
//
// Sem rede e sem banco: cliente, token e repositório falsos. Nenhum pedido real é consultado ou reconhecido.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SACI = "5ac15ac1-0000-4000-8000-0000000000a1";     // unidade do piloto (id fictício)
const OUTRA = "07a07a07-0000-4000-8000-0000000000b2";    // unidade conectada, FORA do piloto
const TERCEIRA = "3e3e3e3e-0000-4000-8000-0000000000c3";
process.env.IFOOD_ORDER_PILOT_UNITS = SACI;              // lido pelo config no boot (teste do padrão do runtime)

const clienteReal = await import("../src/modules/ifood/ifoodEvents.client.js");
const { criarPoller } = await import("../src/modules/ifood/ifoodEvents.poller.js");
const { reprocessarPendentes } = await import("../src/modules/ifood/ifoodEvents.service.js");
const tokenService = await import("../src/modules/ifood/ifoodToken.service.js");
const { IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");
const { criarRepoEmMemoria, criarRelogio, criarClienteFake, criarTokenFake, erroIfood, ev } = await import("./helpers/ifood-events-fakes.js");

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(path.join(AQUI, "..", p), "utf8");

const ORG_1 = "0f000001-0000-4000-8000-000000000001";
const ORG_2 = "0f000002-0000-4000-8000-000000000002";
const M_SACI = "aaaaaaaa-0000-4000-8000-00000000000a";
const M_OUTRA = "bbbbbbbb-0000-4000-8000-00000000000b";
const M_TERCEIRA = "cccccccc-0000-4000-8000-00000000000c";
const C_SACI = { id: "con-saci", organizacao_id: ORG_1, unidade_id: SACI, merchant_id: M_SACI };
const C_OUTRA = { id: "con-outra", organizacao_id: ORG_2, unidade_id: OUTRA, merchant_id: M_OUTRA };
const C_TERCEIRA = { id: "con-terceira", organizacao_id: ORG_1, unidade_id: TERCEIRA, merchant_id: M_TERCEIRA };

/** Responde ao polling conforme os merchants pedidos (nunca devolve loja que não foi pedida). */
const respostasPorMerchant = (mapa) => Array.from({ length: 40 }, () => ({ merchantIds }) => merchantIds.flatMap((m) => {
  const r = mapa[m];
  return (typeof r === "function" ? r() : r) ?? [];
}));
const umaVez = (lista) => { let usada = false; return () => { if (usada) return []; usada = true; return lista; }; };

function montar({ escopo = "conexao", conexoes = [C_SACI, C_OUTRA], piloto = [SACI], respostas, holder = "worker-1", repo, relogio, ...resto } = {}) {
  relogio ??= repo?.relogio ?? criarRelogio();
  repo ??= criarRepoEmMemoria({ relogio, conexoes });
  const client = criarClienteFake(clienteReal, { respostasPolling: respostas ?? respostasPorMerchant({}) });
  const original = client.confirmarEventos;
  client.confirmarEventos = async (a) => { repo.chamadas.push("ACK"); return original(a); };
  const token = criarTokenFake({ escopo });
  const logs = [];
  const log = (nivel, evento, dados) => logs.push({ nivel, evento, dados });
  const lista = { atual: [...piloto] };   // mutável: simula a configuração depois de um restart
  const poller = criarPoller({ repo, token, client, holder, agora: relogio.agora, log, leaseTtlS: 90, unidadesPiloto: () => lista.atual, ...resto });
  return { repo, client, token, poller, relogio, logs, lista };
}
const merchantsConsultados = (client) => [...new Set(client.polls.flatMap((p) => p.merchantIds))].sort();
const idsReconhecidos = (client) => client.acks.flatMap((a) => a.eventIds).sort();
const eventoPendente = (id, c, orderId) => ({
  event_id: id, merchant_id: c.merchant_id, order_id: orderId, event_code: "PLC", event_full_code: "PLACED",
  event_created_at: "2026-09-27T12:01:00.000Z", organizacao_id: c.organizacao_id, unidade_id: c.unidade_id, conexao_id: c.id,
  received_at: "2026-09-27T12:01:05.000Z", processing_status: "RECEBIDO", payload: { id }, payload_hash: "h",
});

// ===========================================================================
// 1. ALLOWLIST VAZIA
// ===========================================================================
for (const escopo of ["conexao", "app"]) {
  test(`1. allowlist vazia (${escopo}): nenhuma loja é consultada, nenhum token é pedido, nenhum ACK`, async () => {
    const { repo, client, token, poller, logs } = montar({ escopo, piloto: [], respostas: respostasPorMerchant({ [M_SACI]: [ev("e1", "PLC")], [M_OUTRA]: [ev("e2", "PLC", { merchantId: M_OUTRA })] }) });
    const r = await poller.executarCiclo();
    assert.equal(r.estado, "SEM_MERCHANTS");
    assert.equal(r.foraDoPiloto, 2);
    assert.equal(client.polls.length, 0, "não chama o iFood");
    assert.equal(token.chamadas.length, 0, "não pede nem renova token");
    assert.equal(client.acks.length, 0);
    assert.equal(repo.eventos.size, 0); assert.equal(repo.pedidos.size, 0);
    assert.deepEqual(repo.filtrosPendentes, [[]], "reprocessamento recebe a lista vazia (não lê evento nenhum)");
    assert.ok(logs.some((l) => l.evento === "events.conexoes_fora_do_piloto" && l.dados.quantidade === 2));
    assert.ok(!JSON.stringify(logs).includes(M_SACI) && !JSON.stringify(logs).includes(SACI), "log sem merchant/unidade");
  });
}

test("1. sem fonte de allowlist (token service sem a lista): fail-closed, igual a lista vazia", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [C_SACI, C_OUTRA] });
  const client = criarClienteFake(clienteReal, { respostasPolling: respostasPorMerchant({ [M_SACI]: [ev("e1", "PLC")] }) });
  const token = criarTokenFake({ escopo: "app" });
  const poller = criarPoller({ repo, token, client, holder: "w", agora: relogio.agora, log: () => {} });
  assert.equal((await poller.executarCiclo()).estado, "SEM_MERCHANTS");
  assert.equal(client.polls.length + token.chamadas.length + client.acks.length, 0);
  for (const invalida of [null, undefined]) {
    const p = criarPoller({ repo, token, client, holder: "w", agora: relogio.agora, log: () => {}, unidadesPiloto: () => invalida });
    assert.equal((await p.executarCiclo()).estado, "SEM_MERCHANTS");
  }
  assert.equal(client.polls.length, 0);
});

test("1. padrão do runtime: a lista vem de IFOOD_ORDER_PILOT_UNITS pelo token service (e o runtime não a substitui)", async () => {
  assert.deepEqual(tokenService.unidadesPilotoOrder(), [SACI]);
  tokenService.unidadesPilotoOrder().push(OUTRA);
  assert.deepEqual(tokenService.unidadesPilotoOrder(), [SACI], "devolve cópia: ninguém amplia a lista em memória");

  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [C_SACI, C_OUTRA] });
  const client = criarClienteFake(clienteReal, { respostasPolling: respostasPorMerchant({}) });
  const token = { ...criarTokenFake({ escopo: "conexao" }), unidadesPilotoOrder: tokenService.unidadesPilotoOrder };
  await criarPoller({ repo, token, client, holder: "w", agora: relogio.agora, log: () => {} }).executarCiclo();
  assert.deepEqual(merchantsConsultados(client), [M_SACI]);

  const runtime = ler("src/worker-ifood/runtime.js");
  assert.match(runtime, /criarPoller\(\{ repo, token: tokenService, holder/);
  assert.ok(!/unidadesPiloto/.test(runtime), "o runtime não injeta outra lista");
});

// ===========================================================================
// 2. SOMENTE A UNIDADE DO PILOTO
// ===========================================================================
test("2. somente a unidade do piloto conectada e autorizada: ciclo completo (poll, grava, processa, ACK)", async () => {
  const { repo, client, token, poller } = montar({
    conexoes: [C_SACI], respostas: respostasPorMerchant({ [M_SACI]: umaVez([ev("e1", "PLC", { orderId: "o-saci" })]) }),
  });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(merchantsConsultados(client), [M_SACI]);
  assert.deepEqual(idsReconhecidos(client), ["e1"]);
  assert.equal(repo.pedidos.get("o-saci").unidade_id, SACI);
  assert.ok(token.chamadas.every((c) => c.conexaoId === "con-saci" && c.appType === "order"));
});

test("2. o id da unidade é comparado normalizado (maiúsculas na conexão ou na lista não mudam o resultado)", async () => {
  const a = montar({ conexoes: [{ ...C_SACI, unidade_id: SACI.toUpperCase() }, C_OUTRA] });
  await a.poller.executarCiclo();
  assert.deepEqual(merchantsConsultados(a.client), [M_SACI]);
  const b = montar({ piloto: [SACI.toUpperCase()] });
  await b.poller.executarCiclo();
  assert.deepEqual(merchantsConsultados(b.client), [M_SACI]);
});

// ===========================================================================
// 3. DUAS LOJAS CONECTADAS, UMA AUTORIZADA
// ===========================================================================
test("3. duas lojas conectadas, só uma autorizada: a outra não é consultada, não recebe pedido nem ACK", async () => {
  const { repo, client, token, poller, logs } = montar({
    respostas: respostasPorMerchant({
      [M_SACI]: umaVez([ev("e1", "PLC", { orderId: "o-saci" })]),
      [M_OUTRA]: umaVez([ev("e2", "PLC", { orderId: "o-outra", merchantId: M_OUTRA })]),
    }),
  });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.equal(r.grupos, 1, "só a conexão autorizada vira grupo de polling");
  assert.deepEqual(merchantsConsultados(client), [M_SACI]);
  assert.deepEqual(token.chamadas.map((c) => c.conexaoId).filter((c) => c !== "con-saci"), [], "token só da conexão autorizada");
  assert.deepEqual(idsReconhecidos(client), ["e1"]);
  assert.deepEqual([...repo.pedidos.keys()], ["o-saci"]);
  assert.deepEqual([...repo.eventos.values()].map((e) => e.unidade_id), [SACI]);
  assert.ok(logs.some((l) => l.evento === "events.conexoes_fora_do_piloto" && l.dados.quantidade === 1));
});

test("3. a falha da loja fora do piloto nem acontece: ela não entra em conexoesComFalha nem em conexoesIgnoradas", async () => {
  const { poller } = montar({ conexoes: [C_SACI, { ...C_OUTRA, credOrder: "reauth_required" }] });
  const r = await poller.executarCiclo();
  assert.deepEqual(r.conexoesComFalha, []); assert.deepEqual(r.conexoesIgnoradas, []);
});

test("3. empresa, merchant ou conexão na lista NÃO autorizam a unidade (só o id da unidade vale)", async () => {
  for (const intruso of [C_OUTRA.organizacao_id, C_OUTRA.merchant_id, C_OUTRA.id, ORG_1]) {
    for (const escopo of ["conexao", "app"]) {
      const { client, poller } = montar({ escopo, piloto: [SACI, intruso] });
      await poller.executarCiclo();
      assert.deepEqual(merchantsConsultados(client), [M_SACI], `${escopo}: ${intruso} não pode liberar a outra loja`);
    }
  }
  // Mesma empresa da unidade do piloto, outra unidade: continua fora.
  const { client, poller } = montar({ conexoes: [C_SACI, C_TERCEIRA] });
  await poller.executarCiclo();
  assert.deepEqual(merchantsConsultados(client), [M_SACI]);
});

test("3. conexão nova (outra unidade) que aparece depois NÃO entra sozinha no piloto", async () => {
  const { repo, client, poller } = montar({ conexoes: [C_SACI] });
  await poller.executarCiclo();
  repo.conexoes.push(C_OUTRA, C_TERCEIRA);
  const r = await poller.executarCiclo();
  assert.equal(r.grupos, 1);
  assert.deepEqual(merchantsConsultados(client), [M_SACI]);
});

// ===========================================================================
// 4. LOJA REMOVIDA DA ALLOWLIST
// ===========================================================================
test("4. loja removida da lista: o ciclo seguinte não a consulta mais; o que já foi gravado fica intacto", async () => {
  let rodada = 0;
  const { repo, client, poller, lista } = montar({
    piloto: [SACI, OUTRA],
    respostas: respostasPorMerchant({
      [M_SACI]: () => [ev(`s${rodada}`, "PLC", { orderId: `o-saci-${rodada}` })],
      [M_OUTRA]: () => [ev(`x${rodada}`, "PLC", { orderId: `o-outra-${rodada}`, merchantId: M_OUTRA })],
    }),
  });
  rodada = 1;
  await poller.executarCiclo();
  assert.deepEqual(merchantsConsultados(client), [M_OUTRA, M_SACI].sort());
  const pedidoAntes = structuredClone(repo.pedidos.get("o-outra-1"));
  const eventoAntes = structuredClone(repo.eventos.get("x1"));

  lista.atual = [SACI];                       // configuração nova (em produção: depois do restart/deploy)
  client.polls.length = 0; client.acks.length = 0;
  rodada = 2;
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(merchantsConsultados(client), [M_SACI]);
  assert.deepEqual(idsReconhecidos(client), ["s2"]);
  assert.deepEqual(repo.pedidos.get("o-outra-1"), pedidoAntes, "pedido da loja removida não é alterado");
  assert.deepEqual(repo.eventos.get("x1"), eventoAntes, "evento da loja removida não é alterado nem apagado");
  assert.equal(repo.pedidos.has("o-outra-2"), false);

  lista.atual = [];                           // lista esvaziada: para tudo
  client.polls.length = 0;
  assert.equal((await poller.executarCiclo()).estado, "SEM_MERCHANTS");
  assert.equal(client.polls.length, 0);
  assert.equal(repo.pedidos.size, 3, "nada foi descartado");
});

test("4. mudança da lista DURANTE um ciclo: o ciclo em andamento termina com a lista com que começou", async () => {
  const h = montar({ piloto: [SACI, OUTRA] });
  h.client.respostasPolling.length = 0;
  h.client.respostasPolling.push(
    () => { h.lista.atual = []; return [ev("s1", "PLC", { orderId: "o-saci" })]; },          // muda no meio do 1º grupo
    () => [ev("x1", "PLC", { orderId: "o-outra", merchantId: M_OUTRA })],
  );
  const r = await h.poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(idsReconhecidos(h.client), ["s1", "x1"], "o ciclo já iniciado conclui (persistir antes do ACK preservado)");
  h.client.polls.length = 0;
  assert.equal((await h.poller.executarCiclo()).estado, "SEM_MERCHANTS", "o ciclo seguinte já usa a lista nova");
  assert.equal(h.client.polls.length, 0);
});

// ===========================================================================
// 5. MERCHANT SEM CONEXÃO ORDER
// ===========================================================================
test("5. unidade na lista mas sem credencial Order (só analytics/financial): não é consultada", async () => {
  const { client, token, poller } = montar({ conexoes: [{ ...C_SACI, credOrder: null }, C_OUTRA] });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "SEM_MERCHANTS");
  assert.equal(client.polls.length + token.chamadas.length, 0);
});

test("5. unidade na lista com Order em reauth_required: monitorada, sem chamada ao iFood", async () => {
  const { client, token, poller } = montar({ conexoes: [{ ...C_SACI, credOrder: "reauth_required" }, C_OUTRA] });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "SEM_CONEXOES_APTAS");
  assert.deepEqual(r.conexoesIgnoradas.map((c) => [c.conexaoId, c.motivo]), [["con-saci", "reauth_required"]]);
  assert.equal(client.polls.length + token.chamadas.length, 0);
});

test("5. unidade na lista sem conexão nenhuma: nada a consultar (a lista sozinha não cria polling)", async () => {
  const { client, poller } = montar({ conexoes: [C_OUTRA] });
  assert.equal((await poller.executarCiclo()).estado, "SEM_MERCHANTS");
  assert.equal(client.polls.length, 0);
});

// ===========================================================================
// 6. MODO CENTRALIZADO
// ===========================================================================
test("6. centralizado: o lote de merchants só leva as unidades do piloto", async () => {
  const { repo, client, token, poller } = montar({
    escopo: "app", conexoes: [C_SACI, C_OUTRA, C_TERCEIRA],
    respostas: respostasPorMerchant({
      [M_SACI]: umaVez([ev("e1", "PLC", { orderId: "o-saci" })]),
      [M_OUTRA]: umaVez([ev("e2", "PLC", { orderId: "o-outra", merchantId: M_OUTRA })]),
      [M_TERCEIRA]: umaVez([ev("e3", "PLC", { orderId: "o-terceira", merchantId: M_TERCEIRA })]),
    }),
  });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(client.polls.map((p) => p.merchantIds), [[M_SACI]]);
  assert.ok(token.chamadas.every((c) => c.conexaoId === null), "token do app (sem conexão)");
  assert.deepEqual(idsReconhecidos(client), ["e1"]);
  assert.deepEqual([...repo.pedidos.keys()], ["o-saci"]);
});

test("6. centralizado com duas unidades autorizadas: as duas, e só elas", async () => {
  const { client, poller } = montar({ escopo: "app", conexoes: [C_SACI, C_OUTRA, C_TERCEIRA], piloto: [SACI, TERCEIRA] });
  await poller.executarCiclo();
  assert.deepEqual(client.polls.map((p) => [...p.merchantIds].sort()), [[M_SACI, M_TERCEIRA].sort()]);
});

test("6. centralizado: se o iFood devolver evento de loja NOSSA fora do piloto, ele não é gravado nem reconhecido", async () => {
  const { repo, client, poller, logs } = montar({
    escopo: "app",
    respostas: [[ev("e1", "PLC", { orderId: "o-saci" }), ev("e2", "PLC", { orderId: "o-outra", merchantId: M_OUTRA })]],
  });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.equal(r.eventosForaDoPiloto, 1);
  assert.deepEqual(idsReconhecidos(client), ["e1"], "sem ACK do evento da loja fora do piloto");
  assert.equal(repo.eventos.has("e2"), false); assert.equal(repo.pedidos.has("o-outra"), false);
  assert.ok(logs.some((l) => l.evento === "events.evento_fora_do_piloto" && l.dados.quantidade === 1));
});

test("6. só evento de loja fora do piloto no lote: nada gravado, nenhum ACK", async () => {
  const { repo, client, poller } = montar({ escopo: "app", respostas: [[ev("e2", "PLC", { orderId: "o-outra", merchantId: M_OUTRA })]] });
  await poller.executarCiclo();
  assert.equal(client.acks.length, 0); assert.equal(repo.eventos.size, 0);
});

test("6. merchant totalmente desconhecido (sem conexão): comportamento de antes preservado (quarentena + ACK)", async () => {
  const { repo, client, poller } = montar({ escopo: "app", respostas: [[ev("e9", "PLC", { merchantId: "dddddddd-0000-4000-8000-00000000000d" })]] });
  await poller.executarCiclo();
  assert.equal(repo.eventos.get("e9").processing_status, "MERCHANT_DESCONHECIDO");
  assert.deepEqual(idsReconhecidos(client), ["e9"]);
});

// ---------------------------------------------------------------------------
// 6b. AS QUATRO SITUAÇÕES DE MERCHANT (o iFood devolvendo loja que não foi pedida) — quarentena e ACK
// ---------------------------------------------------------------------------
const M_FANTASMA = "dddddddd-0000-4000-8000-00000000000d";
for (const escopo of ["conexao", "app"]) {
  test(`6b. (${escopo}) conhecido fora do piloto / desconhecido / outra empresa / sem unidade válida: tratamento de cada um`, async () => {
    const M_SEM_UNIDADE = "eeeeeeee-0000-4000-8000-00000000000e";
    const C_SEM_UNIDADE = { id: "con-sem-unidade", organizacao_id: ORG_1, unidade_id: null, merchant_id: M_SEM_UNIDADE };
    const { repo, client, poller, logs } = montar({
      escopo, conexoes: [C_SACI, C_OUTRA, C_SEM_UNIDADE],
      respostas: [[
        ev("ok", "PLC", { orderId: "o-saci" }),                                              // unidade do piloto
        ev("fora", "PLC", { orderId: "o-outra", merchantId: M_OUTRA }),                       // conhecido, fora do piloto (e de outra empresa)
        ev("fantasma", "PLC", { orderId: "o-fantasma", merchantId: M_FANTASMA }),            // sem conexão nenhuma
        ev("sem-unidade", "PLC", { orderId: "o-sem-unidade", merchantId: M_SEM_UNIDADE }),   // conexão sem unidade válida
      ], []],
    });
    const r = await poller.executarCiclo();
    assert.equal(r.estado, "OK");
    assert.deepEqual(client.polls[0].merchantIds, [M_SACI], "só a loja do piloto foi pedida");
    // gravados: o do piloto (processado) e o totalmente desconhecido (quarentena, sem tenant)
    assert.deepEqual([...repo.eventos.keys()].sort(), ["fantasma", "ok"]);
    assert.equal(repo.eventos.get("ok").processing_status, "PROCESSADO");
    assert.deepEqual([repo.eventos.get("fantasma").processing_status, repo.eventos.get("fantasma").organizacao_id, repo.eventos.get("fantasma").unidade_id],
      ["MERCHANT_DESCONHECIDO", null, null]);
    // ACK: só o que foi gravado. Loja nossa fora do piloto (ou sem unidade válida) NUNCA é reconhecida.
    assert.deepEqual(idsReconhecidos(client), ["fantasma", "ok"]);
    assert.equal(r.eventosForaDoPiloto, 2);
    // pedidos: só o da unidade do piloto, no tenant da conexão (nunca o do payload)
    assert.deepEqual([...repo.pedidos.keys()], ["o-saci"]);
    assert.deepEqual([repo.pedidos.get("o-saci").organizacao_id, repo.pedidos.get("o-saci").unidade_id], [ORG_1, SACI]);
    assert.ok(!JSON.stringify(logs).includes(M_OUTRA) && !JSON.stringify(logs).includes(M_FANTASMA), "merchant nunca inteiro no log");
  });
}

test("6b. evento em quarentena (merchant desconhecido) nunca é reprocessado nem vira pedido, mesmo se a loja for conectada depois", async () => {
  const h = montar({ escopo: "app", respostas: [[ev("fantasma", "PLC", { orderId: "o-fantasma", merchantId: M_FANTASMA })]] });
  await h.poller.executarCiclo();
  h.repo.conexoes.push({ id: "con-nova", organizacao_id: ORG_2, unidade_id: TERCEIRA, merchant_id: M_FANTASMA });
  h.lista.atual = [SACI, TERCEIRA];
  await h.poller.executarCiclo();
  assert.equal(h.repo.eventos.get("fantasma").processing_status, "MERCHANT_DESCONHECIDO");
  assert.equal(h.repo.pedidos.size, 0);
});

test("6b. payload dizendo outra empresa/unidade não muda o tenant nem libera loja fora do piloto", async () => {
  const forjado = { organizacao_id: ORG_1, unidade_id: SACI, organizacaoId: ORG_1, unidadeId: SACI, metadata: { unidade_id: SACI } };
  const h = montar({ escopo: "app", respostas: [[ev("x1", "PLC", { orderId: "o-outra", merchantId: M_OUTRA, ...forjado })]] });
  await h.poller.executarCiclo();
  assert.equal(h.repo.eventos.size + h.repo.pedidos.size + h.client.acks.length, 0);
});

test("6b. distribuído: a conexão do piloto nunca reconhece nem grava evento de loja fora do piloto que venha no polling dela", async () => {
  const h = montar({ respostas: [[ev("x1", "PLC", { orderId: "o-outra", merchantId: M_OUTRA }), ev("s1", "PLC", { orderId: "o-saci" })]] });
  await h.poller.executarCiclo();
  assert.deepEqual(idsReconhecidos(h.client), ["s1"]);
  assert.deepEqual([...h.repo.pedidos.keys()], ["o-saci"]);
  assert.deepEqual([...new Set(h.token.chamadas.map((c) => c.conexaoId))], ["con-saci"]);
});

test("6b. scripts de desenvolvimento: nenhum contorna a allowlist por omissão", () => {
  const check = ler("scripts/ifood-events-check.mjs");
  assert.match(check, /criarRepoEmMemoria/);                                  // tenant fictício, em memória
  assert.match(check, /unidadesPiloto: \(\) => repo\.conexoes\.map\(\(c\) => c\.unidade_id\)/);
  for (const nome of ["ifood-events-e2e-centralized.mjs", "ifood-order-e2e-centralized.mjs", "ifood-order-action-e2e-centralized.mjs"]) {
    const s = ler(`scripts/${nome}`);
    assert.match(s, /criarPoller\(\{ repo, token: tokenService/, nome);
    assert.ok(!/unidadesPiloto/.test(s), `${nome}: banco real de teste -> usa a allowlist do ambiente (fail-closed)`);
  }
});

// ===========================================================================
// 7. RENOVAÇÃO DE TOKEN FORA DA LISTA
// ===========================================================================
test("7. token: nenhuma chamada (nem renovação) para conexão fora da lista, em vários ciclos", async () => {
  const { token, poller } = montar({ conexoes: [C_SACI, C_OUTRA, C_TERCEIRA] });
  for (let i = 0; i < 5; i += 1) await poller.executarCiclo();
  assert.ok(token.chamadas.length >= 5);
  assert.deepEqual([...new Set(token.chamadas.map((c) => c.conexaoId))], ["con-saci"]);
});

test("7. token expirado da loja fora da lista não é renovado nem derruba o ciclo da loja autorizada", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [C_SACI, C_OUTRA] });
  const client = criarClienteFake(clienteReal, { respostasPolling: respostasPorMerchant({ [M_SACI]: umaVez([ev("e1", "PLC")]) }) });
  const renovacoes = [];
  const token = {
    escopoDoToken: () => "conexao",
    async comAccessTokenValido({ conexaoId, fn }) {
      renovacoes.push(conexaoId);                                  // todo acesso ao token passa por aqui (inclui refresh)
      if (conexaoId !== "con-saci") throw erroIfood("IFOOD_REFRESH_FALHOU");
      return fn("tok");
    },
  };
  const poller = criarPoller({ repo, token, client, holder: "w", agora: relogio.agora, log: () => {}, unidadesPiloto: () => [SACI] });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual([...new Set(renovacoes)], ["con-saci"]);
  assert.deepEqual(r.conexoesComFalha, []);
});

test("7. a trava do token existe no código: fora do escopo do ciclo lança IFOOD_ORDER_PILOTO_NAO_HABILITADO antes do token", () => {
  const fonte = ler("src/modules/ifood/ifoodEvents.poller.js");
  const trava = fonte.slice(fonte.indexOf("const comToken ="), fonte.indexOf("async function pollGrupo"));
  assert.match(trava, /autorizadas\.has\(grupo\.conexaoId\)/);
  assert.match(trava, /merchantIds\.every\(\(m\) => merchantsAutorizados\.has\(m\)\)/);
  assert.ok(trava.indexOf("IFOOD_ORDER_PILOTO_NAO_HABILITADO") < trava.indexOf("token.comAccessTokenValido"), "a recusa vem antes de pedir o token");
  assert.equal((fonte.match(/token\.comAccessTokenValido/g) ?? []).length, 2, "um único ponto de acesso ao token (1 uso + 1 menção no cabeçalho)");
  assert.ok(IFOOD_ERROS.IFOOD_ORDER_PILOTO_NAO_HABILITADO);
});

// ===========================================================================
// 8. MÚLTIPLOS WORKERS E LEASE
// ===========================================================================
test("8. dois workers: só o titular do lease consulta; o outro não chama o iFood; os dois respeitam a lista", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [C_SACI, C_OUTRA] });
  const a = montar({ repo, relogio, holder: "A" });
  const b = montar({ repo, relogio, holder: "B" });
  assert.equal((await a.poller.executarCiclo()).estado, "OK");
  assert.equal((await b.poller.executarCiclo()).estado, "LEASE_DE_OUTRO");
  assert.equal(b.client.polls.length + b.token.chamadas.length, 0);
  relogio.avancarS(91);                                                       // lease de A venceu
  assert.equal((await b.poller.executarCiclo()).estado, "OK");
  assert.equal(repo.lease.holder, "B");
  assert.deepEqual(merchantsConsultados(a.client), [M_SACI]);
  assert.deepEqual(merchantsConsultados(b.client), [M_SACI]);
});

test("8. ciclos concorrentes dos dois workers: uma só consulta por rodada, nunca a loja fora da lista", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [C_SACI, C_OUTRA] });
  const a = montar({ repo, relogio, holder: "A" });
  const b = montar({ repo, relogio, holder: "B" });
  const estados = (await Promise.all([a.poller.executarCiclo(), b.poller.executarCiclo()])).map((r) => r.estado).sort();
  assert.deepEqual(estados, ["LEASE_DE_OUTRO", "OK"]);
  assert.equal(a.client.polls.length + b.client.polls.length, 1);
  assert.deepEqual([...merchantsConsultados(a.client), ...merchantsConsultados(b.client)], [M_SACI]);
});

test("8. durante um deploy (instâncias com listas diferentes): cada uma só usa a própria lista; vazia mantém o lease sem consultar", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [C_SACI, C_OUTRA] });
  const nova = montar({ repo, relogio, holder: "nova", piloto: [] });
  const antiga = montar({ repo, relogio, holder: "antiga", piloto: [SACI] });
  assert.equal((await nova.poller.executarCiclo()).estado, "SEM_MERCHANTS");     // titular, lista vazia
  assert.equal((await antiga.poller.executarCiclo()).estado, "LEASE_DE_OUTRO");  // a antiga não consulta por cima
  assert.equal(nova.client.polls.length + antiga.client.polls.length, 0);
});

test("8. lease perdido antes do ACK continua barrando o ACK (fencing preservado com a lista)", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [C_SACI, C_OUTRA] });
  const a = montar({ repo, relogio, holder: "A", respostas: [() => { relogio.avancarS(120); return [ev("e1", "PLC")]; }] });
  const b = montar({ repo, relogio, holder: "B" });
  const original = repo.inserirEventos;
  repo.inserirEventos = async (l) => { const r = await original(l); await b.poller.executarCiclo(); return r; };   // B assume no meio
  const r = await a.poller.executarCiclo();
  assert.equal(r.estado, "LEASE_PERDIDO");
  assert.equal(a.client.acks.length, 0);
});

// ===========================================================================
// 9. PROCESSAMENTO PENDENTE APÓS MUDANÇA DE ESCOPO
// ===========================================================================
test("9. pendentes: só os da unidade do piloto são reprocessados; os da outra ficam como estão (nada apagado)", async () => {
  const h = montar({});
  await h.repo.inserirEventos([eventoPendente("p-saci", C_SACI, "o-saci"), eventoPendente("p-outra", C_OUTRA, "o-outra")]);
  const antes = structuredClone(h.repo.eventos.get("p-outra"));
  const r = await h.poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(h.repo.filtrosPendentes.at(-1), [SACI]);
  assert.equal(h.repo.eventos.get("p-saci").processing_status, "PROCESSADO");
  assert.equal(h.repo.pedidos.get("o-saci").status_oficial, "PLACED");
  assert.deepEqual(h.repo.eventos.get("p-outra"), antes, "evento da unidade fora do piloto: intacto (status, tentativas, payload)");
  assert.equal(h.repo.pedidos.has("o-outra"), false, "nenhum pedido criado para a unidade fora do piloto");

  h.lista.atual = [SACI, OUTRA];              // a unidade volta ao piloto: o pendente é retomado, sem perda
  await h.poller.executarCiclo();
  assert.equal(h.repo.eventos.get("p-outra").processing_status, "PROCESSADO");
  assert.equal(h.repo.pedidos.get("o-outra").unidade_id, OUTRA);
});

test("9. pendentes com a lista vazia: nada é lido nem alterado", async () => {
  const h = montar({ piloto: [] });
  await h.repo.inserirEventos([eventoPendente("p-saci", C_SACI, "o-saci")]);
  const antes = structuredClone(h.repo.eventos.get("p-saci"));
  await h.poller.executarCiclo();
  assert.deepEqual(h.repo.eventos.get("p-saci"), antes);
  assert.equal(h.repo.pedidos.size, 0);
});

test("9. trava dupla no service: mesmo que a consulta devolva linha de outra unidade, ela não é processada", async () => {
  const repo = criarRepoEmMemoria({ conexoes: [C_SACI, C_OUTRA] });
  await repo.inserirEventos([eventoPendente("p-saci", C_SACI, "o-saci"), eventoPendente("p-outra", C_OUTRA, "o-outra")]);
  const semFiltro = repo.listarEventosPendentes;
  repo.listarEventosPendentes = (limite, max) => semFiltro(limite, max);       // consulta "esquece" o filtro
  const r = await reprocessarPendentes({ repo, log: () => {}, unidades: [SACI] });
  assert.equal(r.tentados, 1);
  assert.equal(repo.eventos.get("p-outra").processing_status, "RECEBIDO");
  assert.equal(repo.pedidos.has("o-outra"), false);
});

test("9. reprocessarPendentes sem `unidades` (uso fora do poller): comportamento de antes", async () => {
  const repo = criarRepoEmMemoria({ conexoes: [C_SACI, C_OUTRA] });
  await repo.inserirEventos([eventoPendente("p-saci", C_SACI, "o-saci"), eventoPendente("p-outra", C_OUTRA, "o-outra")]);
  assert.equal((await reprocessarPendentes({ repo, log: () => {} })).tentados, 2);
  assert.deepEqual(repo.filtrosPendentes, [undefined]);
});

test("9. repositório real: filtro por unidade na consulta e lista vazia sem ir ao banco", () => {
  const fonte = ler("src/modules/ifood/ifoodEvents.repository.js");
  const fn = fonte.slice(fonte.indexOf("export async function listarEventosPendentes"), fonte.indexOf("// PEDIDOS (estrutura mínima)"));
  assert.match(fn, /if \(Array\.isArray\(unidades\) && unidades\.length === 0\) return \[\];/);
  assert.match(fn, /\.in\("unidade_id", unidades\)/);
  assert.ok(!/\.delete\(/.test(fonte), "o repositório de Events não apaga nada");
});

test("9. detalhes de pedidos (Order Details): pedido de unidade fora do piloto não gera chamada ao iFood", async () => {
  const buscas = [];
  const h = montar({
    piloto: [SACI, OUTRA],
    respostas: respostasPorMerchant({ [M_OUTRA]: umaVez([ev("x1", "PLC", { orderId: "o-outra", merchantId: M_OUTRA })]) }),
    detalhes: { client: { buscarDetalhesPedido: async ({ orderId }) => { buscas.push(orderId); throw erroIfood("IFOOD_INDISPONIVEL"); } } },
  });
  const r1 = await h.poller.executarCiclo();
  assert.deepEqual(buscas, ["o-outra"], "com a unidade no piloto, os detalhes são buscados");
  assert.equal(r1.detalhes.erros, 1);
  const pedidoAntes = structuredClone(h.repo.pedidos.get("o-outra"));
  assert.equal(pedidoAntes.details_status, "ERRO", "segue pendente de detalhes");

  h.lista.atual = [SACI];                     // a unidade sai do piloto com detalhes ainda pendentes
  h.relogio.avancarS(6 * 3600);               // muito além de qualquer espera entre tentativas
  const tokensAntes = h.token.chamadas.length;
  const r2 = await h.poller.executarCiclo();
  assert.deepEqual(buscas, ["o-outra"], "nenhuma nova busca de detalhes para a unidade removida");
  assert.equal(r2.detalhes.tentados, 0); assert.equal(r2.detalhes.semConexao, 1);
  assert.ok(h.token.chamadas.slice(tokensAntes).every((c) => c.conexaoId === "con-saci"));
  assert.deepEqual(h.repo.pedidos.get("o-outra"), pedidoAntes, "o pedido não é alterado pela mudança da lista");
});

// ===========================================================================
// 10. ACK SOMENTE QUANDO PERMITIDO E APÓS PERSISTÊNCIA VÁLIDA
// ===========================================================================
test("10. ACK só depois de gravar: a ordem das chamadas é inserir -> ... -> ACK", async () => {
  const { repo, poller } = montar({ respostas: respostasPorMerchant({ [M_SACI]: umaVez([ev("e1", "PLC")]) }) });
  await poller.executarCiclo();
  const inserir = repo.chamadas.indexOf("inserirEventos");
  const ack = repo.chamadas.indexOf("ACK");
  assert.ok(inserir >= 0 && ack > inserir, repo.chamadas.join(","));
  assert.ok(repo.chamadas.indexOf("marcarAck") > ack, "o carimbo de ACK só depois do 202");
});

test("10. persistência falhou: nenhum ACK (o evento volta no próximo polling)", async () => {
  const { repo, client, poller } = montar({ respostas: respostasPorMerchant({ [M_SACI]: () => [ev("e1", "PLC")] }) });
  repo.falhar.inserirEventos = 1;
  await assert.rejects(poller.executarCiclo());
  assert.equal(client.acks.length, 0);
  assert.equal((await poller.executarCiclo()).estado, "OK");
  assert.deepEqual(idsReconhecidos(client), ["e1"]);
});

test("10. ACK nunca inclui evento de unidade fora da lista (distribuído e centralizado)", async () => {
  for (const escopo of ["conexao", "app"]) {
    const { client, poller } = montar({
      escopo, conexoes: [C_SACI, C_OUTRA, C_TERCEIRA],
      respostas: respostasPorMerchant({
        [M_SACI]: umaVez([ev("s1", "PLC", { orderId: "o1" }), ev("s2", "CFM", { orderId: "o1", min: 1 })]),
        [M_OUTRA]: umaVez([ev("x1", "PLC", { orderId: "o2", merchantId: M_OUTRA })]),
        [M_TERCEIRA]: umaVez([ev("t1", "PLC", { orderId: "o3", merchantId: M_TERCEIRA })]),
      }),
    });
    await poller.executarCiclo();
    assert.deepEqual(idsReconhecidos(client), ["s1", "s2"], escopo);
  }
});

test("10. deduplicação preservada: evento reentregue da unidade do piloto não duplica pedido e é reconhecido de novo", async () => {
  const { repo, client, poller } = montar({ respostas: respostasPorMerchant({ [M_SACI]: () => [ev("e1", "PLC", { orderId: "o1" })] }) });
  await poller.executarCiclo();
  const r = await poller.executarCiclo();
  assert.equal(r.novos, 0); assert.equal(r.reentregas, 1);
  assert.equal(repo.eventos.size, 1); assert.equal(repo.pedidos.size, 1);
  assert.equal(client.acks.length, 2);
});

test("10. falha da loja autorizada continua isolada e visível (o erro sobe quando é a única)", async () => {
  const { poller } = montar({ respostas: [erroIfood("IFOOD_INDISPONIVEL")] });
  await assert.rejects(poller.executarCiclo(), (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL);
});
