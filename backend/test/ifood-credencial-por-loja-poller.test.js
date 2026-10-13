// Credenciais INDEPENDENTES por loja (migration 118) — o POLLER, sem rede e sem banco (repositório em memória).
// Caso de uso: Subway Sanduíches (principal, credencial da conexão) + Subway Saladas (adicional com credencial PRÓPRIA) na MESMA unidade.
//
// Prova: sem loja própria nada muda; a Sanduíches é sempre o primeiro grupo; cada merchant está em UM grupo só e é consultado/reconhecido com o
// token do SEU titular; falha de autenticação, 403, 429 e erro de ACK da Saladas não interrompem a Sanduíches; loja com credencial própria em
// reauth NUNCA cai para o token da conexão; lease único e fencing seguem valendo ao reiniciar.
//
// Rodar: node --experimental-vm-modules --test test/ifood-credencial-por-loja-poller.test.js
import test from "node:test";
import assert from "node:assert/strict";

import * as clienteReal from "../src/modules/ifood/ifoodEvents.client.js";
import { criarPoller } from "../src/modules/ifood/ifoodEvents.poller.js";
import {
  criarRepoEmMemoria, criarRelogio, criarClienteFake, erroIfood, ev, M_A, ORG_A, UN_A, CONEXAO_A, pilotoDe } from "./helpers/ifood-events-fakes.js";

const M_SAL = "04a17bf5-b9e6-4693-a862-a5715e9f9374";
const TOK_CONEXAO = "tok-da-conexao";
const tokLoja = (id) => `tok-da-loja-${id}`;

/** Token fake que ENTREGA um token por titular e registra quem o pediu (conexão ou loja). `falhas[chave]` lança no pedido do token. */
function tokenFake({ falhas = {} } = {}) {
  const chamadas = [];
  return {
    chamadas, falhas,
    escopoDoToken: () => "conexao",
    async comAccessTokenValido({ conexaoId, lojaId, appType, fn }) {
      chamadas.push({ conexaoId, lojaId: lojaId ?? null, appType });
      const f = falhas[lojaId ?? "conexao"];
      if (f) throw f;
      return fn(lojaId ? tokLoja(lojaId) : TOK_CONEXAO);
    },
  };
}

/** Lojas adicionais em memória: mesma semântica do repositório real (credencial_propria/credencial_status vêm do titular). */
function comLojas(repo, linhas) {
  const lojas = linhas.map((l, i) => ({
    id: `loja-${i + 1}`, conexao_id: CONEXAO_A.id, organizacao_id: ORG_A, unidade_id: UN_A, estado: "ativa", rotulo: null, verificacoes: 0,
    credencial_propria: false, ...l,
  }));
  repo.lojas = lojas;
  repo.listarLojasExtrasParaPolling = async ({ conexaoIds }) => lojas.filter((l) => conexaoIds.includes(l.conexao_id) && ["ativa", "liberada"].includes(l.estado)).map((l) => ({ ...l }));
  repo.iniciarVerificacaoLoja = async ({ id }) => { const l = lojas.find((x) => x.id === id); if (l?.estado !== "liberada") return "estado_invalido"; l.verificacoes += 1; return "ok"; };
  repo.marcarLojaAtiva = async ({ id }) => { const l = lojas.find((x) => x.id === id); if (l?.estado !== "liberada") return false; l.estado = "ativa"; return true; };
  repo.bloquearLoja = async ({ id, motivo }) => { const l = lojas.find((x) => x.id === id); if (!l) return false; Object.assign(l, { estado: "bloqueada", bloqueio_motivo: motivo }); return true; };
  return lojas;
}
const propria = (extra = {}) => ({ merchant_id: M_SAL, credencial_propria: true, credencial_status: "ativa", ...extra });

function montar({ respostas = [], falhasAck = [], falhas = {}, holder = "worker-1", repo, relogio } = {}) {
  relogio ??= repo?.relogio ?? criarRelogio();
  repo ??= criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  const client = criarClienteFake(clienteReal, { respostasPolling: respostas, falhasAck });
  const token = tokenFake({ falhas });
  const logs = [];
  const log = (nivel, evento, dados) => logs.push({ nivel, evento, ...dados });
  const poller = criarPoller({ repo, token, client, holder, agora: relogio.agora, log, leaseTtlS: 90, unidadesPiloto: pilotoDe(repo) });
  const ciclo = async (avancarS = 30) => { const r = await poller.executarCiclo(); relogio.avancarS(avancarS); return r; };
  return { repo, client, token, poller, relogio, logs, ciclo };
}
const eventosDeLog = (logs, nome) => logs.filter((l) => l.evento === nome);
const PLC = (id, orderId, merchantId, min = 1) => ev(id, "PLC", { orderId, merchantId, min });

// ===========================================================================
test("SÓ a Sanduíches (sem lojas adicionais): um grupo, token da conexão, nenhum `lojaId` — idêntico ao de antes", async () => {
  const m = montar({ respostas: [[PLC("s1", "o-sand", M_A)]] });
  const r = await m.ciclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(m.client.polls.map((p) => [p.merchantIds, p.accessToken]), [[[M_A], TOK_CONEXAO]]);
  assert.ok(m.token.chamadas.every((c) => c.lojaId === null));
  assert.deepEqual(m.client.acks.map((a) => [a.eventIds, a.accessToken]), [[["s1"], TOK_CONEXAO]]);
});

test("DUAS lojas, credenciais INDEPENDENTES: a Sanduíches é o 1º grupo; cada merchant é consultado e reconhecido com o token do SEU titular", async () => {
  const m = montar({ respostas: [[PLC("s1", "o-sand", M_A)], [PLC("d1", "o-sal", M_SAL)]] });
  const [loja] = comLojas(m.repo, [propria()]);
  const r = await m.ciclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(m.client.polls.map((p) => [p.merchantIds, p.accessToken]), [[[M_A], TOK_CONEXAO], [[M_SAL], tokLoja(loja.id)]]);
  assert.deepEqual(m.client.acks.map((a) => [a.eventIds, a.accessToken]), [[["s1"], TOK_CONEXAO], [["d1"], tokLoja(loja.id)]]);
  // as duas na MESMA unidade, com a origem por merchant
  assert.deepEqual([m.repo.pedidos.get("o-sand"), m.repo.pedidos.get("o-sal")].map((p) => [p.organizacao_id, p.unidade_id, p.merchant_id]),
    [[ORG_A, UN_A, M_A], [ORG_A, UN_A, M_SAL]]);
  assert.equal(m.repo.pedidos.size, 2, "sem duplicidade");
});

test("credencial COMPARTILHADA (loja sem credencial própria): um polling só, [principal, loja], token da conexão — como na 117", async () => {
  const m = montar({ respostas: [[PLC("s1", "o-sand", M_A), PLC("d1", "o-sal", M_SAL)]] });
  comLojas(m.repo, [{ merchant_id: M_SAL }]);
  await m.ciclo();
  assert.deepEqual(m.client.polls.map((p) => [p.merchantIds, p.accessToken]), [[[M_A, M_SAL], TOK_CONEXAO]]);
  assert.ok(m.token.chamadas.every((c) => c.lojaId === null));
});

test("os dois modos juntos (uma loja compartilhada + uma própria): cada merchant em UM grupo só, sem consulta duplicada", async () => {
  const OUTRA = "cccccccc-0000-4000-8000-00000000000c";
  const m = montar({ respostas: [[], []] });
  comLojas(m.repo, [{ merchant_id: OUTRA }, propria()]);
  await m.ciclo();
  const todos = m.client.polls.flatMap((p) => p.merchantIds);
  assert.deepEqual([...todos].sort(), [M_A, M_SAL, OUTRA].sort());
  assert.equal(new Set(todos).size, todos.length, "nenhum merchant consultado em dois grupos");
  assert.deepEqual(m.client.polls[0].merchantIds, [M_A, OUTRA], "a conexão (Sanduíches) vem antes");
});

test("merchant repetido (loja igual à principal, ou linha duplicada) nunca entra em dois grupos", async () => {
  const m = montar({ respostas: [[], []] });
  comLojas(m.repo, [propria({ merchant_id: M_A }), propria(), propria()]);
  await m.ciclo();
  const todos = m.client.polls.flatMap((p) => p.merchantIds);
  assert.deepEqual([...todos].sort(), [M_A, M_SAL].sort());
});

// ===========================================================================
// ISOLAMENTO DE FALHAS
// ===========================================================================
test("credencial própria em `reauth_required`: a Saladas NÃO é consultada (nem com o token da conexão), não conta verificação e a Sanduíches segue", async () => {
  const m = montar({ respostas: [[PLC("s1", "o-sand", M_A)]] });
  const [loja] = comLojas(m.repo, [propria({ estado: "liberada", credencial_status: "reauth_required" })]);
  const r = await m.ciclo();
  assert.equal(r.estado, "OK");
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_A]]);
  assert.equal(loja.verificacoes, 0, "nenhuma tentativa de verificação gasta");
  assert.equal(r.conexoesIgnoradas.length, 1);
  assert.equal(r.conexoesIgnoradas[0].lojaId, loja.id);
  assert.equal(eventosDeLog(m.logs, "events.loja_ignorada").length, 1);
  assert.equal(m.repo.pedidos.get("o-sand").status_oficial, "PLACED");
});

test("falha de AUTENTICAÇÃO da Saladas: ciclo PARCIAL, a Sanduíches é persistida e reconhecida normalmente", async () => {
  const m = montar({ respostas: [[PLC("s1", "o-sand", M_A)], []], falhas: { "loja-1": erroIfood("IFOOD_REFRESH_FALHOU") } });
  comLojas(m.repo, [propria()]);
  const r = await m.ciclo();
  assert.equal(r.estado, "PARCIAL");
  assert.deepEqual(r.conexoesComFalha.map((f) => [f.etapa, f.codigo]), [["autenticacao", "IFOOD_REFRESH_FALHOU"]]);
  assert.deepEqual(m.client.acks.map((a) => a.eventIds), [["s1"]]);
  assert.equal(m.repo.pedidos.get("o-sand").status_oficial, "PLACED");
});

test("falha de autenticação da SANDUÍCHES não impede a Saladas (e o ciclo é PARCIAL)", async () => {
  const m = montar({ respostas: [[PLC("d1", "o-sal", M_SAL)]], falhas: { conexao: erroIfood("IFOOD_REFRESH_FALHOU") } });
  comLojas(m.repo, [propria()]);
  const r = await m.ciclo();
  assert.equal(r.estado, "PARCIAL");
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_SAL]]);
  assert.equal(m.repo.pedidos.get("o-sal").status_oficial, "PLACED");
});

test("403 da Saladas (credencial própria): a loja é BLOQUEADA, a Sanduíches segue, e a loja nunca mais é consultada", async () => {
  const m = montar({ respostas: [[PLC("s1", "o-sand", M_A)], erroIfood("IFOOD_MERCHANT_SEM_PERMISSAO", { unauthorizedMerchants: [M_SAL] }), [], []] });
  const [loja] = comLojas(m.repo, [propria()]);
  const r = await m.ciclo();
  assert.equal(r.estado, "OK");
  assert.equal(loja.estado, "bloqueada");
  assert.equal(loja.bloqueio_motivo, "SEM_AUTORIZACAO");
  assert.deepEqual(m.client.acks.map((a) => a.eventIds), [["s1"]]);
  await m.ciclo(); await m.ciclo();
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_A], [M_SAL], [M_A], [M_A]]);
});

test("429 da SALADAS: NÃO encerra o ciclo (Sanduíches já reconhecida, detalhes seguem), a loja entra em pausa e volta depois", async () => {
  const m = montar({ respostas: [[PLC("s1", "o-sand", M_A)], erroIfood("IFOOD_RATE_LIMITED"), [], [], [PLC("d1", "o-sal", M_SAL)]] });
  comLojas(m.repo, [propria()]);
  const r = await m.ciclo();
  assert.equal(r.estado, "PARCIAL", "429 de loja própria é falha da loja, não do ciclo");
  assert.deepEqual(m.client.acks.map((a) => a.eventIds), [["s1"]]);
  assert.equal(eventosDeLog(m.logs, "events.rate_limited").length, 1);

  await m.ciclo();                                                    // 30 s depois: a loja ainda está em pausa
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_A], [M_SAL], [M_A]]);
  assert.equal(eventosDeLog(m.logs, "events.loja_em_pausa").length, 1);

  await m.ciclo(120);                                                 // passada a pausa
  await m.ciclo();
  assert.deepEqual(m.client.polls.at(-1).merchantIds, [M_SAL]);
  assert.equal(m.repo.pedidos.get("o-sal")?.status_oficial, "PLACED");
});

test("429 da SANDUÍCHES (1º grupo) mantém o comportamento de sempre: ciclo encerrado, a Saladas não é consultada neste ciclo", async () => {
  const m = montar({ respostas: [erroIfood("IFOOD_RATE_LIMITED"), []] });
  comLojas(m.repo, [propria()]);
  const r = await m.ciclo();
  assert.equal(r.estado, "RATE_LIMITED");
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_A]]);
});

test("erro no ACK da Saladas: os eventos dela voltam no próximo polling; a Sanduíches já foi reconhecida e persistida", async () => {
  const m = montar({ respostas: [[PLC("s1", "o-sand", M_A)], [PLC("d1", "o-sal", M_SAL)]], falhasAck: [null, erroIfood("IFOOD_INDISPONIVEL")] });
  comLojas(m.repo, [propria()]);
  const r = await m.ciclo();
  assert.equal(r.estado, "PARCIAL");
  assert.deepEqual(m.client.acks.map((a) => a.eventIds), [["s1"]]);
  assert.equal(m.repo.pedidos.get("o-sal").status_oficial, "PLACED", "persistido antes do ACK");
  assert.equal(m.repo.eventos.get("d1").acknowledged_at ?? null, null, "sem ACK: o evento continua pendente de reconhecimento");
});

// ===========================================================================
// LIBERAÇÃO e LEASE
// ===========================================================================
test("loja `liberada` com credencial própria ativa: conta a tentativa, é consultada com o token dela e vira `ativa`", async () => {
  const m = montar({ respostas: [[], []] });
  const [loja] = comLojas(m.repo, [propria({ estado: "liberada" })]);
  await m.ciclo();
  assert.equal(loja.verificacoes, 1);
  assert.equal(loja.estado, "ativa");
  assert.equal(m.client.polls[1].accessToken, tokLoja(loja.id));
});

test("loja `pendente` (mesmo com credencial própria) nunca é consultada: autorizar não habilita o polling", async () => {
  const m = montar({ respostas: [[], []] });
  comLojas(m.repo, [propria({ estado: "pendente" })]);
  await m.ciclo();
  assert.deepEqual(m.client.polls.map((p) => p.merchantIds), [[M_A]]);
  assert.ok(m.token.chamadas.every((c) => c.lojaId === null));
});

test("lease único e reinício: outro worker não consulta nada enquanto há titular; após o vencimento assume e consulta os DOIS grupos", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  comLojas(repo, [propria()]);
  const w1 = montar({ repo, relogio, respostas: [[], []], holder: "w1" });
  const w2 = montar({ repo, relogio, respostas: [[], []], holder: "w2" });
  await w1.ciclo(0);
  const bloqueado = await w2.ciclo(0);
  assert.equal(bloqueado.estado, "LEASE_DE_OUTRO");
  assert.equal(w2.client.polls.length, 0, "sem lease: nenhum token pedido, nenhum polling");
  assert.equal(w2.token.chamadas.length, 0);
  relogio.avancarS(100);                                              // o lease de w1 venceu (TTL 90 s) — reinício/queda de w1
  const r = await w2.ciclo(0);
  assert.equal(r.estado, "OK");
  assert.deepEqual(w2.client.polls.map((p) => p.merchantIds), [[M_A], [M_SAL]]);
});

test("lease perdido antes do ACK de uma loja própria: nenhum ACK sai e o ciclo para (fencing)", async () => {
  const relogio = criarRelogio();
  const repo = criarRepoEmMemoria({ relogio, conexoes: [CONEXAO_A] });
  comLojas(repo, [propria()]);
  const m = montar({ repo, relogio, respostas: [[], [PLC("d1", "o-sal", M_SAL)]] });
  const original = repo.adquirirLease.bind(repo);
  let n = 0;
  repo.adquirirLease = async (a) => { n += 1; return n >= 2 ? { adquirido: false, holder: "outro", leaseAte: null, geracao: 9 } : original(a); };   // 1ª: ciclo; 2ª: renovação antes do ACK
  const r = await m.ciclo();
  assert.equal(r.estado, "LEASE_PERDIDO");
  assert.equal(m.client.acks.length, 0);
});

test("o log nunca carrega token: nem o da conexão nem o da loja", async () => {
  const m = montar({ respostas: [[PLC("s1", "o-sand", M_A)], erroIfood("IFOOD_RATE_LIMITED")] });
  const [loja] = comLojas(m.repo, [propria()]);
  await m.ciclo();
  const texto = JSON.stringify(m.logs);
  assert.ok(!texto.includes(TOK_CONEXAO) && !texto.includes(tokLoja(loja.id)));
});
