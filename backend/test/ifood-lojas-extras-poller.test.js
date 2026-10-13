// Lojas ADICIONAIS por conexão (migration 117) — o POLLER, sem rede e sem banco (repositório em memória que espelha a semântica
// das funções SQL). Caso de uso: Subway Sanduíches (loja principal) + Subway Saladas (adicional) na MESMA unidade e credencial.
//
// Prova: comportamento IDÊNTICO sem lojas adicionais; loja adicional entra no MESMO polling da conexão (um pedido, um header); tenant
// sempre da conexão; `pendente`/`bloqueada`/`desativada` nunca são consultadas; 403 bloqueia de forma PERSISTENTE (inclusive após
// reiniciar) e não se repete a cada ciclo; a falha da Saladas não interrompe a Sanduíches; tentativas de verificação limitadas.
//
// Rodar: node --experimental-vm-modules --test test/ifood-lojas-extras-poller.test.js
import test from "node:test";
import assert from "node:assert/strict";

import * as clienteReal from "../src/modules/ifood/ifoodEvents.client.js";
import { criarPoller, montarGrupos } from "../src/modules/ifood/ifoodEvents.poller.js";
import { IFOOD_EVENTS } from "../src/modules/ifood/ifood.constants.js";
import {
  criarRepoEmMemoria, criarRelogio, criarClienteFake, criarTokenFake, erroIfood,
  ev, M_A, M_B, ORG_A, UN_A, CONEXAO_A, CONEXAO_B, pilotoDe } from "./helpers/ifood-events-fakes.js";

export const M_SALADAS = "04a17bf5-b9e6-4693-a862-a5715e9f9374";
const M_OUTRA = "cccccccc-0000-4000-8000-00000000000c";

/** Espelha as funções SQL da migration 117 (mesmas regras de estado), com injeção de falha por método. */
export function comLojas(repo, linhas) {
  const lojas = linhas.map((l, i) => ({ id: `loja-${i + 1}`, conexao_id: CONEXAO_A.id, organizacao_id: ORG_A, unidade_id: UN_A, estado: "pendente", rotulo: null, verificacoes: 0, ...l }));
  repo.lojas = lojas;
  const falha = (nome) => { if (repo.falharLojas?.[nome] > 0) { repo.falharLojas[nome] -= 1; throw new Error(`falha injetada em ${nome}`); } };
  repo.falharLojas = {};
  repo.listarLojasExtrasParaPolling = async ({ conexaoIds }) => {
    falha("listar");
    repo.chamadas.push("listarLojasExtras");
    return lojas.filter((l) => conexaoIds.includes(l.conexao_id) && ["ativa", "liberada"].includes(l.estado)).map((l) => ({ ...l }));
  };
  repo.iniciarVerificacaoLoja = async ({ id, max }) => {
    falha("iniciar");
    const l = lojas.find((x) => x.id === id);
    if (!l) return "nao_encontrada";
    if (l.estado !== "liberada") return "estado_invalido";
    if (l.verificacoes >= Math.max(max, 1)) { Object.assign(l, { estado: "bloqueada", bloqueio_motivo: "TENTATIVAS_ESGOTADAS", bloqueios: (l.bloqueios ?? 0) + 1 }); return "bloqueada"; }
    l.verificacoes += 1;
    return "ok";
  };
  repo.marcarLojaAtiva = async ({ id }) => {
    falha("ativar");
    const l = lojas.find((x) => x.id === id);
    if (!l || l.estado !== "liberada") return false;
    l.estado = "ativa";
    return true;
  };
  repo.bloquearLoja = async ({ id, motivo }) => {
    falha("bloquear");
    const l = lojas.find((x) => x.id === id);
    if (!l || !["liberada", "ativa"].includes(l.estado)) return false;
    Object.assign(l, { estado: "bloqueada", bloqueio_motivo: motivo, bloqueios: (l.bloqueios ?? 0) + 1 });
    return true;
  };
  return lojas;
}

function montar({ respostas = [], repo, conexoes = [CONEXAO_A], holder = "worker-1", escopo = "conexao" } = {}) {
  const relogio = repo?.relogio ?? criarRelogio();
  repo ??= criarRepoEmMemoria({ relogio, conexoes });
  const client = criarClienteFake(clienteReal, { respostasPolling: respostas });
  const token = criarTokenFake({ escopo });
  const logs = [];
  const log = (nivel, evento, dados) => logs.push({ nivel, evento, ...dados });
  const poller = criarPoller({ repo, token, client, holder, agora: relogio.agora, log, leaseTtlS: 90, unidadesPiloto: pilotoDe(repo) });
  const ciclo = async () => { const r = await poller.executarCiclo(); relogio.avancarS(30); return r; };
  return { repo, client, token, poller, relogio, logs, ciclo };
}
const eventosDeLog = (logs, nome) => logs.filter((l) => l.evento === nome);

// ===========================================================================
// COMPORTAMENTO IDÊNTICO sem loja adicional
// ===========================================================================
test("sem funções de lojas no repositório (versão anterior do repo): polling só da principal, nada muda", async () => {
  const m = montar({ respostas: [[ev("e1", "PLC", { min: 1 })]] });
  assert.equal(typeof m.repo.listarLojasExtrasParaPolling, "undefined");
  const r = await m.ciclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_A]]);
});

test("com as funções mas SEM nenhuma loja cadastrada: header idêntico ao de antes ([principal])", async () => {
  const m = montar({ respostas: [[ev("e1", "PLC", { min: 1 })]] });
  comLojas(m.repo, []);
  const r = await m.ciclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_A]]);
  assert.ok(m.repo.chamadas.includes("listarLojasExtras"));
  assert.equal(m.repo.pedidos.get("order-1").merchant_id, M_A);
});

test("montarGrupos: sem extras é idêntico; com extras junta principal + adicionais na MESMA conexão (e nos lotes do escopo 'app')", () => {
  const con = [{ id: "c1", merchant_id: M_A }, { id: "c2", merchant_id: M_B }];
  assert.deepEqual(montarGrupos(con, "conexao"), [{ conexaoId: "c1", merchantIds: [M_A] }, { conexaoId: "c2", merchantIds: [M_B] }]);
  const extras = new Map([["c1", [M_SALADAS]]]);
  assert.deepEqual(montarGrupos(con, "conexao", 100, extras), [{ conexaoId: "c1", merchantIds: [M_A, M_SALADAS] }, { conexaoId: "c2", merchantIds: [M_B] }]);
  assert.deepEqual(montarGrupos(con, "app", 100, extras), [{ conexaoId: null, merchantIds: [M_A, M_SALADAS, M_B] }]);
});

// ===========================================================================
// DUAS LOJAS na mesma unidade
// ===========================================================================
test("loja adicional ATIVA: mesmo polling (um pedido, header com as duas), eventos das duas no MESMO tenant, ACK único", async () => {
  const m = montar({
    respostas: [[
      ev("s1", "PLC", { orderId: "o-sand", merchantId: M_A, min: 1 }),
      ev("d1", "PLC", { orderId: "o-sal", merchantId: M_SALADAS, min: 1 }),
      ev("d2", "CFM", { orderId: "o-sal", merchantId: M_SALADAS, min: 2 }),
    ]],
  });
  comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "ativa", rotulo: "Saladas" }]);
  const r = await m.ciclo();
  assert.equal(r.estado, "OK");
  assert.equal(m.client.polls.length, 1, "UM polling para a conexão, não um por loja");
  assert.deepEqual(m.client.polls[0].merchantIds, [M_A, M_SALADAS]);
  assert.deepEqual(m.client.acks.map((a) => [...a.eventIds].sort()), [["d1", "d2", "s1"]]);
  for (const o of ["o-sand", "o-sal"]) { assert.equal(m.repo.pedidos.get(o).organizacao_id, ORG_A); assert.equal(m.repo.pedidos.get(o).unidade_id, UN_A); }
  assert.equal(m.repo.pedidos.get("o-sal").merchant_id, M_SALADAS, "a origem (merchant) fica gravada no pedido");
  assert.equal(m.repo.pedidos.get("o-sal").status_oficial, "CONFIRMED");
  assert.equal(m.repo.lojas[0].verificacoes, 0, "loja ATIVA não conta tentativa");
});

test("a mesma ordem de pedido nunca duplica: reentrega do evento da Saladas é idempotente", async () => {
  const e = ev("d1", "PLC", { orderId: "o-sal", merchantId: M_SALADAS, min: 1 });
  const m = montar({ respostas: [[e], [e]] });
  comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "ativa" }]);
  await m.ciclo(); await m.ciclo();
  assert.equal([...m.repo.pedidos.values()].filter((p) => p.order_id === "o-sal").length, 1);
  assert.equal(m.repo.eventos.size, 1);
});

test("loja `pendente`, `bloqueada` ou `desativada` NUNCA é consultada (mesmo se o repositório as devolvesse)", async () => {
  const m = montar({ respostas: [[], [], []] });
  comLojas(m.repo, [
    { merchant_id: M_SALADAS, estado: "pendente" },
    { merchant_id: M_OUTRA, estado: "bloqueada", bloqueio_motivo: "SEM_AUTORIZACAO" },
    { merchant_id: "dddddddd-0000-4000-8000-00000000000d", estado: "desativada" },
  ]);
  // Defesa em profundidade: um repositório "frouxo" que devolva todas as linhas não consegue incluí-las.
  m.repo.listarLojasExtrasParaPolling = async () => m.repo.lojas.map((l) => ({ ...l }));
  await m.ciclo(); await m.ciclo(); await m.ciclo();
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_A], [M_A], [M_A]]);
});

test("loja adicional de OUTRO tenant na conexão é ignorada (tenant da loja = tenant da conexão)", async () => {
  const m = montar({ respostas: [[]] });
  comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "ativa", unidade_id: "un-outra" }, { merchant_id: M_OUTRA, estado: "ativa", organizacao_id: "org-outra" }]);
  await m.ciclo();
  assert.deepEqual(m.client.polls[0].merchantIds, [M_A]);
});

test("merchant adicional igual ao da principal, ou já de OUTRA conexão, não duplica nem vaza entre unidades", async () => {
  const m = montar({ respostas: [[]], conexoes: [CONEXAO_A, CONEXAO_B] });
  comLojas(m.repo, [{ merchant_id: M_A, estado: "ativa" }, { merchant_id: M_B, estado: "ativa" }]);
  await m.ciclo();
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds).sort(), [[M_A], [M_B]]);
});

test("loja adicional de conexão FORA do piloto não é consultada; nenhum token é pedido para ela", async () => {
  const m = montar({ respostas: [[]] });
  comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "ativa" }]);
  m.poller = criarPoller({ repo: m.repo, token: m.token, client: m.client, holder: "w2", agora: m.relogio.agora, log: () => {}, leaseTtlS: 90, unidadesPiloto: () => ["outra-unidade"] });
  const r = await m.poller.executarCiclo();
  assert.equal(r.estado, "SEM_MERCHANTS");
  assert.equal(m.client.polls.length, 0);
  assert.equal(m.token.chamadas.length, 0);
});

test("conexão `reauth_required` é pulada com as lojas dela: nada é consultado", async () => {
  const m = montar({ respostas: [[]], conexoes: [{ ...CONEXAO_A, credOrder: "reauth_required" }] });
  comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "ativa" }]);
  const r = await m.ciclo().catch((e) => e);
  assert.equal(m.client.polls.length, 0);
  assert.ok(r instanceof Error || r.estado === "SEM_CONEXOES_APTAS");
});

// ===========================================================================
// VERIFICAÇÃO SUPERVISIONADA (liberada -> ativa | bloqueada)
// ===========================================================================
test("loja `liberada`: conta UMA tentativa, entra no polling e, aceita pelo iFood, vira `ativa` — eventos processados, nada descartado", async () => {
  const m = montar({ respostas: [[ev("d1", "PLC", { orderId: "o-sal", merchantId: M_SALADAS, min: 1 })], []] });
  const [loja] = comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "liberada", liberada_em: "x" }]);
  await m.ciclo();
  assert.deepEqual(m.client.polls[0].merchantIds, [M_A, M_SALADAS]);
  assert.equal(loja.estado, "ativa");
  assert.equal(loja.verificacoes, 1);
  assert.ok(m.repo.pedidos.get("o-sal"), "o evento real da Saladas foi gravado (não foi descartado)");
  assert.ok(m.repo.eventos.get("d1").acknowledged_at, "e reconhecido normalmente");
  assert.equal(eventosDeLog(m.logs, "events.loja_extra_ativada").length, 1);
  await m.ciclo();                                           // 2º ciclo: já ativa — não conta tentativa
  assert.equal(loja.verificacoes, 1);
  assert.deepEqual(m.client.polls[1].merchantIds, [M_A, M_SALADAS]);
});

test("403 na loja adicional: tira SÓ ela, a Sanduíches segue no mesmo ciclo, a loja é BLOQUEADA e não é mais consultada", async () => {
  const m = montar({
    respostas: [erroIfood("IFOOD_MERCHANT_SEM_PERMISSAO", { unauthorizedMerchants: [M_SALADAS] }), [ev("s1", "PLC", { orderId: "o-sand", merchantId: M_A, min: 1 })], [], [], []],
  });
  const [loja] = comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "liberada", liberada_em: "x" }]);
  const r = await m.ciclo();
  assert.equal(r.estado, "OK", "a falha da Saladas não derruba o ciclo");
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_A, M_SALADAS], [M_A]]);
  assert.equal(m.repo.pedidos.get("o-sand").status_oficial, "PLACED", "a Sanduíches foi processada");
  assert.ok(m.repo.eventos.get("s1").acknowledged_at);
  assert.equal(loja.estado, "bloqueada");
  assert.equal(loja.bloqueio_motivo, "SEM_AUTORIZACAO");
  const antes = m.client.polls.length;
  await m.ciclo(); await m.ciclo(); await m.ciclo();
  assert.deepEqual(m.client.polls.slice(antes).map((p) => p.merchantIds), [[M_A], [M_A], [M_A]], "o 403 NÃO se repete a cada ciclo");
  assert.equal(eventosDeLog(m.logs, "events.loja_extra_bloqueada").length, 1);
});

test("bloqueio PERSISTENTE: um poller NOVO (restart/deploy) com o mesmo banco continua sem consultar a loja bloqueada", async () => {
  const m = montar({ respostas: [erroIfood("IFOOD_MERCHANT_SEM_PERMISSAO", { unauthorizedMerchants: [M_SALADAS] }), []] });
  comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "ativa" }]);
  await m.ciclo();
  assert.equal(m.repo.lojas[0].estado, "bloqueada");
  const novo = criarPoller({ repo: m.repo, token: criarTokenFake({ escopo: "conexao" }), client: criarClienteFake(clienteReal, { respostasPolling: [[], [], []] }), holder: "worker-2",
    agora: m.relogio.agora, log: () => {}, leaseTtlS: 90, unidadesPiloto: pilotoDe(m.repo) });
  m.relogio.avancarS(200);                                   // o lease do primeiro venceu
  for (let i = 0; i < 3; i += 1) { await novo.executarCiclo(); m.relogio.avancarS(30); }
  assert.equal(m.repo.lojas[0].estado, "bloqueada");
});

test("se GRAVAR o bloqueio falhar, a loja recusada NÃO volta ao polling neste processo (memória) — sem repetir a infração", async () => {
  const m = montar({ respostas: [erroIfood("IFOOD_MERCHANT_SEM_PERMISSAO", { unauthorizedMerchants: [M_SALADAS] }), [], [], [], []] });
  comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "ativa" }]);
  m.repo.falharLojas.bloquear = 99;
  await m.ciclo();
  assert.equal(m.repo.lojas[0].estado, "ativa", "o banco não pôde gravar");
  assert.equal(eventosDeLog(m.logs, "events.loja_extra_bloqueio_nao_gravado").length, 1);
  await m.ciclo(); await m.ciclo();
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_A, M_SALADAS], [M_A], [M_A], [M_A]]);
});

test("verificação com falhas NÃO-403 (rede/5xx): no máximo 3 tentativas e então `bloqueada` (TENTATIVAS_ESGOTADAS) — sem consulta infinita", async () => {
  const falhas = Array.from({ length: 6 }, () => new Error("rede caiu"));
  const m = montar({ respostas: [...falhas] });
  const [loja] = comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "liberada", liberada_em: "x" }]);
  for (let i = 0; i < 5; i += 1) await m.ciclo().catch(() => null);
  assert.equal(IFOOD_EVENTS.lojaExtraMaxVerificacoes, 3);
  assert.equal(loja.verificacoes, 3);
  assert.equal(loja.estado, "bloqueada");
  assert.equal(loja.bloqueio_motivo, "TENTATIVAS_ESGOTADAS");
  assert.equal(m.client.polls.filter((p) => p.merchantIds.includes(M_SALADAS)).length, 3, "a loja entrou em exatamente 3 consultas");
});

test("sem conseguir CONTAR a tentativa (banco), a loja liberada NÃO é consultada", async () => {
  const m = montar({ respostas: [[], []] });
  comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "liberada", liberada_em: "x" }]);
  m.repo.falharLojas.iniciar = 1;
  await m.ciclo();
  assert.deepEqual(m.client.polls[0].merchantIds, [M_A]);
  await m.ciclo();                                           // banco voltou: agora conta e consulta
  assert.deepEqual(m.client.polls[1].merchantIds, [M_A, M_SALADAS]);
});

test("falhar ao gravar `ativa` não derruba o ciclo nem o recebimento", async () => {
  const m = montar({ respostas: [[ev("d1", "PLC", { orderId: "o-sal", merchantId: M_SALADAS, min: 1 })]] });
  comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "liberada", liberada_em: "x" }]);
  m.repo.falharLojas.ativar = 1;
  const r = await m.ciclo();
  assert.equal(r.estado, "OK");
  assert.ok(m.repo.pedidos.get("o-sal"));
  assert.equal(eventosDeLog(m.logs, "events.loja_extra_ativacao_nao_gravada").length, 1);
});

// ===========================================================================
// FALHA SEGURA: a Sanduíches nunca depende da tabela
// ===========================================================================
test("tabela inexistente / banco falhando ao listar lojas: ciclo normal só com a principal e UM aviso (não um por ciclo)", async () => {
  const m = montar({ respostas: [[ev("s1", "PLC", { min: 1 })], [], []] });
  comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "ativa" }]);
  m.repo.falharLojas.listar = 99;
  const r = await m.ciclo(); await m.ciclo(); await m.ciclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_A], [M_A], [M_A]]);
  assert.equal(eventosDeLog(m.logs, "events.lojas_extras_indisponiveis").length, 1);
  assert.equal(m.repo.eventos.get("s1").processing_status, "PROCESSADO");
});

test("403 da PRINCIPAL continua como antes (não bloqueia nada nas lojas adicionais)", async () => {
  const m = montar({ respostas: [erroIfood("IFOOD_MERCHANT_SEM_PERMISSAO", { unauthorizedMerchants: [M_A] }), []] });
  comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "ativa" }]);
  await m.ciclo();
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_A, M_SALADAS], [M_SALADAS]]);
  assert.equal(m.repo.lojas[0].estado, "ativa");
});

test("evento de merchant que NÃO foi pedido/mapeado continua indo para a quarentena (como antes)", async () => {
  const m = montar({ respostas: [[ev("x1", "PLC", { orderId: "o-x", merchantId: "loja-fantasma", min: 1 })]] });
  comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "ativa" }]);
  await m.ciclo();
  assert.equal(m.repo.eventos.get("x1").processing_status, "MERCHANT_DESCONHECIDO");
  assert.equal(m.repo.pedidos.has("o-x"), false);
});

// ===========================================================================
// DETALHES DO PEDIDO (Order Details) da loja adicional: mesmo token da conexão, tenant da conexão
// ===========================================================================
test("detalhes da Saladas: buscados com o token da MESMA conexão; número/tipo gravados no pedido da unidade", async () => {
  const buscas = [];
  const client = { async buscarDetalhesPedido({ accessToken, orderId }) {
    buscas.push({ accessToken, orderId });
    return { id: orderId, displayId: "7001", orderType: "DELIVERY", orderTiming: "IMMEDIATE", salesChannel: "IFOOD", category: "FOOD", createdAt: t0(),
      merchant: { id: M_SALADAS, name: "Subway Saladas - Saci" }, total: { subTotal: 10, deliveryFee: 0, additionalFees: 0, benefits: 0, orderAmount: 10 }, delivery: { deliveredBy: "MERCHANT" } };
  } };
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  comLojas(repo, [{ merchant_id: M_SALADAS, estado: "ativa", rotulo: "Saladas" }]);
  const token = criarTokenFake({ escopo: "conexao" });
  const cli = criarClienteFake(clienteReal, { respostasPolling: [[ev("d1", "PLC", { orderId: "o-sal", merchantId: M_SALADAS, min: 1 })]] });
  const poller = criarPoller({ repo, token, client: cli, holder: "w", agora: relogio.agora, log: () => {}, leaseTtlS: 90, unidadesPiloto: pilotoDe(repo), detalhes: { client } });
  const r = await poller.executarCiclo();
  assert.equal(r.estado, "OK");
  assert.equal(buscas.length, 1);
  assert.equal(buscas[0].orderId, "o-sal");
  assert.ok(token.chamadas.every((c) => c.conexaoId === CONEXAO_A.id), "nenhum token de outra conexão");
  const p = repo.pedidos.get("o-sal");
  assert.equal(p.details_status, "OK");
  assert.equal(p.unidade_id, UN_A);
  assert.equal(p.merchant_id, M_SALADAS);
});

// ===========================================================================
// REPOSITÓRIO (migration 117): nomes das funções SQL, parâmetros e tradução de erro
// ===========================================================================
const t0 = () => new Date(Date.parse("2026-09-27T12:00:00.000Z")).toISOString();

test("repositório: chama as funções SQL certas com os parâmetros certos; erro do banco vira ApiError; lista só ativa/liberada da conexão", async () => {
  process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "chave-service-role-de-teste-".padEnd(48, "z");
  process.env.SUPABASE_ANON_KEY ??= "chave-anon-de-teste-".padEnd(48, "a");
  const repoEv = await import("../src/modules/ifood/ifoodEvents.repository.js");
  const { supabase } = await import("../src/config/supabase.js");
  const original = supabase.rpc;
  const chamadas = [];
  try {
    supabase.rpc = async (nome, args) => { chamadas.push([nome, args]); return nome.endsWith("iniciar_verificacao") ? { data: "ok", error: null } : { data: true, error: null }; };
    assert.equal(await repoEv.iniciarVerificacaoLoja({ id: "L1", max: 3 }), "ok");
    assert.equal(await repoEv.marcarLojaAtiva({ id: "L1" }), true);
    assert.equal(await repoEv.bloquearLoja({ id: "L1", motivo: "SEM_AUTORIZACAO" }), true);
    assert.deepEqual(chamadas, [
      ["ifood_loja_iniciar_verificacao", { p_id: "L1", p_max: 3 }],
      ["ifood_loja_marcar_ativa", { p_id: "L1" }],
      ["ifood_loja_bloquear", { p_id: "L1", p_motivo: "SEM_AUTORIZACAO" }],
    ]);
    supabase.rpc = async () => ({ data: null, error: { message: "boom" } });
    await assert.rejects(repoEv.iniciarVerificacaoLoja({ id: "L1", max: 3 }), /boom/);
    await assert.rejects(repoEv.marcarLojaAtiva({ id: "L1" }), /boom/);
    await assert.rejects(repoEv.bloquearLoja({ id: "L1", motivo: "X" }), /boom/);
  } finally { supabase.rpc = original; }

  const filtros = [];
  const db = { from(tabela) {
    const q = { tabela, select(c) { q.colunas = c; return q; }, in(c, v) { filtros.push([c, v]); return q; }, then(ok) { return Promise.resolve({ data: [{ id: "L1" }], error: null }).then(ok); } };
    return q;
  } };
  assert.deepEqual(await repoEv.listarLojasExtrasParaPolling({ conexaoIds: [] , db }), []);
  assert.deepEqual(await repoEv.listarLojasExtrasParaPolling({ conexaoIds: ["C1"], db }), [{ id: "L1" }]);
  assert.deepEqual(filtros, [["conexao_id", ["C1"]], ["estado", ["ativa", "liberada"]]]);
});

test("bloqueio em memória (gravação falhou) cede a uma NOVA liberação supervisionada: vale no ciclo seguinte, sem reiniciar", async () => {
  const m = montar({ respostas: [erroIfood("IFOOD_MERCHANT_SEM_PERMISSAO", { unauthorizedMerchants: [M_SALADAS] }), [], [], []] });
  const [loja] = comLojas(m.repo, [{ merchant_id: M_SALADAS, estado: "liberada", liberada_em: "2026-10-14T10:00:00Z" }]);
  m.repo.falharLojas.bloquear = 1;
  await m.ciclo();                                           // 403; o banco não gravou o bloqueio (continua `liberada`)
  await m.ciclo();                                           // a memória impede a repetição da consulta
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_A, M_SALADAS], [M_A], [M_A]]);
  Object.assign(loja, { estado: "liberada", liberada_em: "2026-10-14T11:00:00Z", verificacoes: 0 });   // o responsável liberou de novo (supervisionado)
  await m.ciclo();
  assert.deepEqual(m.client.polls[3].merchantIds, [M_A, M_SALADAS]);
});
