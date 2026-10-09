// Aviso de Realtime dos pedidos iFood (Checklist Operacional — Checkpoint 2).
//
// Prova que o aviso é um EFEITO COLATERAL inofensivo do processamento homologado:
//   * só depois de persistir, só para unidades cujos pedidos mudaram, um por unidade;
//   * evento duplicado (reentrega) e merchant desconhecido não avisam ninguém;
//   * falha (síncrona, assíncrona) ou lentidão do destino não muda resultado, ACK nem resumo;
//   * o Broadcast vai SÓ para o tópico privado da unidade, com payload sem pedido/merchant/cliente.
// Repositório em memória (helpers/ifood-events-fakes.js); `fetch` falso. Sem banco, sem rede, sem iFood.
//
// Rodar: node --experimental-vm-modules --test test/ifood-pedidos-aviso-realtime.test.js

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "teste";
process.env.SUPABASE_ANON_KEY ??= "teste";

const { processarLote, reprocessarPendentes } = await import("../src/modules/ifood/ifoodEvents.service.js");
const aviso = await import("../src/modules/ifood/ifoodPedidosAviso.js");
const { emitirEventoRealtime } = await import("../src/modules/realtime/emitirEvento.js");
const { criarRepoEmMemoria, ev, M_A, M_B, ORG_A, UN_A, ORG_B, UN_B, CONEXAO_A, CONEXAO_B } = await import("./helpers/ifood-events-fakes.js");

const silencio = () => {};
const AMBOS = () => new Map([CONEXAO_A, CONEXAO_B].map((c) => [c.merchant_id, c]));
const lote = (repo, brutos, conexoes = AMBOS()) =>
  processarLote({ eventosBrutos: brutos, conexoesPorMerchant: conexoes, repo, agora: repo.relogio.agora, log: silencio });
const esperarMicrotarefas = () => new Promise((r) => setImmediate(r));

const FLAG = aviso.FLAG_CHECKLIST_REALTIME;
let recebidos;
beforeEach(() => {
  aviso._resetAvisoPedidosParaTeste();
  process.env[FLAG] = "true";                 // a maioria dos casos testa o caminho LIGADO; os da flag mexem nela
  recebidos = [];
  aviso.registrarDestinoAvisoPedidos((t) => { recebidos.push(t); });
});
afterEach(() => { aviso._resetAvisoPedidosParaTeste(); delete process.env[FLAG]; });

describe("flag IFOOD_CHECKLIST_REALTIME_ENABLED (ponto central)", () => {
  test("AUSENTE: desligado — nenhum aviso, mesmo com destino registrado", async () => {
    delete process.env[FLAG];
    assert.equal(aviso.checklistRealtimeHabilitado(), false);
    assert.equal(aviso.avisarPedidosAtualizados([{ organizacaoId: ORG_A, unidadeId: UN_A }]), 0);
    await lote(criarRepoEmMemoria(), [ev("e1", "PLC", { min: 1 })]);
    assert.deepEqual(recebidos, []);
  });

  test("valores não reconhecidos NÃO ligam: false, 0, 1, TRUE, ' true', vazio", async () => {
    for (const v of ["false", "0", "1", "TRUE", " true", "", "yes"]) {
      process.env[FLAG] = v;
      assert.equal(aviso.checklistRealtimeHabilitado(), false, `valor ${JSON.stringify(v)}`);
      assert.equal(aviso.avisarPedidosAtualizados([{ organizacaoId: ORG_A, unidadeId: UN_A }]), 0);
    }
    await lote(criarRepoEmMemoria(), [ev("e1", "PLC", { min: 1 })]);
    assert.deepEqual(recebidos, []);
  });

  test("LIGADA (literal 'true'): aviso publicado para a unidade certa", async () => {
    process.env[FLAG] = "true";
    await lote(criarRepoEmMemoria(), [ev("e1", "PLC", { min: 1 })]);
    assert.deepEqual(recebidos, [{ organizacaoId: ORG_A, unidadeId: UN_A }]);
  });

  test("desligada não muda NADA do processamento (resultado, ACK e pedido iguais aos com a flag ligada)", async () => {
    process.env[FLAG] = "true";
    const ligado = criarRepoEmMemoria();
    const a = await lote(ligado, [ev("e1", "PLC", { min: 1 }), ev("e2", "CFM", { min: 2 })]);
    process.env[FLAG] = "false";
    const desligado = criarRepoEmMemoria();
    const b = await lote(desligado, [ev("e1", "PLC", { min: 1 }), ev("e2", "CFM", { min: 2 })]);
    assert.deepEqual(b.idsParaAck, a.idsParaAck);
    assert.deepEqual(b.resumo, a.resumo);
    assert.equal(desligado.pedidos.get("order-1").status_oficial, ligado.pedidos.get("order-1").status_oficial);
  });

  test("o host (runtime.js) só registra o destino com a flag ligada", async () => {
    const { montarRuntimeEventsIfood } = await import("../src/worker-ifood/runtime.js");
    const cfg = { intervaloMs: 30_000, leaseTtlS: 90 };
    aviso._resetAvisoPedidosParaTeste();
    await montarRuntimeEventsIfood({ env: {}, cfg });
    assert.equal(aviso.estadoAvisoPedidos({}).destinoRegistrado, false, "flag ausente: nada registrado");
    await montarRuntimeEventsIfood({ env: { [FLAG]: "false" }, cfg });
    assert.equal(aviso.estadoAvisoPedidos({}).destinoRegistrado, false);
    await montarRuntimeEventsIfood({ env: { [FLAG]: "true" }, cfg });
    assert.equal(aviso.estadoAvisoPedidos({}).destinoRegistrado, true);
    await montarRuntimeEventsIfood({ env: {}, cfg });
    assert.equal(aviso.estadoAvisoPedidos({}).destinoRegistrado, false, "religar sem a flag limpa o destino");
  });
});

describe("resiliência do aviso", () => {
  const deferido = () => { let resolve; let reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };

  test("RAJADA na mesma unidade: no máximo um envio em voo + um pendente (nunca uma fila)", async () => {
    const envios = [];
    aviso.registrarDestinoAvisoPedidos((t) => { const d = deferido(); envios.push({ t, d }); return d.promise; });
    for (let i = 0; i < 50; i += 1) aviso.avisarPedidosAtualizados([{ organizacaoId: ORG_A, unidadeId: UN_A }]);
    assert.equal(envios.length, 1, "um em voo");
    envios[0].d.resolve(); await esperarMicrotarefas();
    assert.equal(envios.length, 2, "as 49 viraram UM pendente");
    envios[1].d.resolve(); await esperarMicrotarefas();
    assert.equal(envios.length, 2);
    assert.equal(aviso.estadoAvisoPedidos().emVoo, 0);
  });

  test("rajada de várias unidades: cada uma no próprio tópico, sem misturar tenant", async () => {
    const envios = [];
    aviso.registrarDestinoAvisoPedidos((t) => { envios.push(t); });
    aviso.avisarPedidosAtualizados([{ organizacaoId: ORG_A, unidadeId: UN_A }, { organizacaoId: ORG_B, unidadeId: UN_B }, { organizacaoId: ORG_A, unidadeId: UN_A }]);
    await esperarMicrotarefas();
    assert.deepEqual(envios, [{ organizacaoId: ORG_A, unidadeId: UN_A }, { organizacaoId: ORG_B, unidadeId: UN_B }]);
  });

  test("limite global de envios simultâneos: o excedente é descartado com log (o polling recupera)", async () => {
    const logs = [];
    const pendurados = [];
    aviso.registrarDestinoAvisoPedidos(() => { const d = deferido(); pendurados.push(d); return d.promise; });
    const muitos = Array.from({ length: aviso.MAX_EM_VOO + 5 }, (_, i) => ({ organizacaoId: ORG_A, unidadeId: `un-${i}` }));
    aviso.avisarPedidosAtualizados(muitos, { log: (...a) => logs.push(a) });
    assert.equal(pendurados.length, aviso.MAX_EM_VOO);
    assert.equal(aviso.estadoAvisoPedidos().descartadosPorLimite, 5);
    assert.ok(logs.some(([n, c]) => n === "warn" && c === "pedidos.aviso_descartado_limite"));
    for (const d of pendurados) d.resolve();
    await esperarMicrotarefas();
    assert.equal(aviso.estadoAvisoPedidos().emVoo, 0);
  });

  test("envio que nunca responde libera a vaga no prazo (sem travar a unidade)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const logs = [];
    let chamadas = 0;
    aviso.registrarDestinoAvisoPedidos(() => { chamadas += 1; return new Promise(() => {}); });
    aviso.avisarPedidosAtualizados([{ organizacaoId: ORG_A, unidadeId: UN_A }], { log: (...a) => logs.push(a) });
    assert.equal(aviso.estadoAvisoPedidos().emVoo, 1);
    t.mock.timers.tick(aviso.PRAZO_ENVIO_MS);
    await esperarMicrotarefas();
    assert.equal(aviso.estadoAvisoPedidos().emVoo, 0);
    assert.ok(logs.some(([, c, d]) => c === "pedidos.aviso_falhou" && /sem resposta/.test(d.erro)));
    aviso.avisarPedidosAtualizados([{ organizacaoId: ORG_A, unidadeId: UN_A }], { log: () => {} });
    assert.equal(chamadas, 2, "a unidade volta a ser avisada");
  });

  test("nenhuma rejeição fica sem tratamento (síncrona, assíncrona, log que lança)", async () => {
    const naoTratadas = [];
    const ouvir = (e) => naoTratadas.push(e);
    process.on("unhandledRejection", ouvir);
    try {
      aviso.registrarDestinoAvisoPedidos(() => Promise.reject(new Error("broadcast recusado")));
      aviso.avisarPedidosAtualizados([{ organizacaoId: ORG_A, unidadeId: UN_A }], { log: () => {} });
      aviso.registrarDestinoAvisoPedidos(() => { throw new Error("síncrono"); });
      aviso.avisarPedidosAtualizados([{ organizacaoId: ORG_B, unidadeId: UN_B }], { log: () => {} });
      aviso.registrarDestinoAvisoPedidos(() => Promise.reject(new Error("x")));
      aviso.avisarPedidosAtualizados([{ organizacaoId: ORG_A, unidadeId: "un-z" }], { log: () => { throw new Error("log quebrado"); } });
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", ouvir);
    }
    assert.deepEqual(naoTratadas, []);
  });
});

describe("registro do aviso (puro)", () => {
  test("sem destino registrado: no-op (padrão com Events desligado e nos testes homologados)", () => {
    aviso.registrarDestinoAvisoPedidos(null);
    assert.equal(aviso.avisarPedidosAtualizados([{ organizacaoId: ORG_A, unidadeId: UN_A }]), 0);
  });

  test("um aviso por unidade, mesmo com vários pedidos/eventos dela; tenant incompleto é ignorado", () => {
    const n = aviso.avisarPedidosAtualizados([
      { organizacaoId: ORG_A, unidadeId: UN_A }, { organizacaoId: ORG_A, unidadeId: UN_A },
      { organizacaoId: ORG_B, unidadeId: UN_B }, { organizacaoId: ORG_A, unidadeId: null },
    ]);
    assert.equal(n, 2);
    assert.deepEqual(recebidos, [{ organizacaoId: ORG_A, unidadeId: UN_A }, { organizacaoId: ORG_B, unidadeId: UN_B }]);
  });

  test("destino que lança (síncrono) ou rejeita (assíncrono) nunca propaga: só log", async () => {
    const logs = [];
    aviso.registrarDestinoAvisoPedidos(() => { throw new Error("boom síncrono"); });
    assert.doesNotThrow(() => aviso.avisarPedidosAtualizados([{ organizacaoId: ORG_A, unidadeId: UN_A }], { log: (...a) => logs.push(a) }));
    aviso.registrarDestinoAvisoPedidos(() => Promise.reject(new Error("boom assíncrono")));
    aviso.avisarPedidosAtualizados([{ organizacaoId: ORG_A, unidadeId: UN_A }], { log: (...a) => logs.push(a) });
    await esperarMicrotarefas();
    assert.equal(logs.length, 2);
    assert.ok(logs.every(([nivel, codigo]) => nivel === "warn" && codigo === "pedidos.aviso_falhou"));
  });
});

describe("processarLote → aviso", () => {
  test("evento processado e PERSISTIDO gera aviso da unidade do pedido (só depois de gravar)", async () => {
    const repo = criarRepoEmMemoria();
    aviso.registrarDestinoAvisoPedidos((t) => { recebidos.push({ ...t, pedidoGravado: repo.pedidos.get("order-1")?.status_oficial ?? null }); });
    await lote(repo, [ev("e1", "PLC", { min: 1 })]);
    assert.deepEqual(recebidos, [{ organizacaoId: ORG_A, unidadeId: UN_A, pedidoGravado: "PLACED" }]);
  });

  test("lote com vários eventos da mesma unidade: UM aviso", async () => {
    const repo = criarRepoEmMemoria();
    await lote(repo, [ev("e1", "PLC", { min: 1 }), ev("e2", "CFM", { min: 2 }), ev("e3", "PLC", { min: 1, orderId: "order-2" })]);
    assert.deepEqual(recebidos, [{ organizacaoId: ORG_A, unidadeId: UN_A }]);
  });

  test("evento DUPLICADO (reentrega) não gera aviso nem muda o pedido", async () => {
    const repo = criarRepoEmMemoria();
    await lote(repo, [ev("e1", "PLC", { min: 1 })]);
    const antes = JSON.stringify(repo.pedidos.get("order-1"));
    recebidos = [];
    const r = await lote(repo, [ev("e1", "PLC", { min: 1 })]);
    assert.equal(r.resumo.reentregas, 1);
    assert.deepEqual(recebidos, []);
    assert.equal(JSON.stringify(repo.pedidos.get("order-1")), antes);
  });

  test("cada unidade recebe só o aviso dela; merchant sem conexão (quarentena) não avisa ninguém", async () => {
    const repo = criarRepoEmMemoria();
    await lote(repo, [
      ev("a1", "PLC", { min: 1, merchantId: M_A, orderId: "oa" }),
      ev("b1", "PLC", { min: 1, merchantId: M_B, orderId: "ob" }),
      ev("x1", "PLC", { min: 1, merchantId: "merchant-desconhecido", orderId: "ox" }),
    ]);
    assert.deepEqual(recebidos.sort((x, y) => x.unidadeId.localeCompare(y.unidadeId)), [
      { organizacaoId: ORG_A, unidadeId: UN_A }, { organizacaoId: ORG_B, unidadeId: UN_B },
    ]);
  });

  test("falha do Realtime NÃO muda resultado, ACK, resumo nem o pedido gravado", async () => {
    const semAviso = criarRepoEmMemoria();
    aviso.registrarDestinoAvisoPedidos(null);
    const base = await lote(semAviso, [ev("e1", "PLC", { min: 1 }), ev("e2", "CFM", { min: 2 })]);

    const comFalha = criarRepoEmMemoria();
    aviso.registrarDestinoAvisoPedidos(() => Promise.reject(new Error("Realtime fora do ar")));
    const r = await lote(comFalha, [ev("e1", "PLC", { min: 1 }), ev("e2", "CFM", { min: 2 })]);
    await esperarMicrotarefas();

    assert.deepEqual(r.idsParaAck, base.idsParaAck);
    assert.deepEqual(r.resumo, base.resumo);
    assert.equal(comFalha.pedidos.get("order-1").status_oficial, semAviso.pedidos.get("order-1").status_oficial);
    assert.ok([...comFalha.eventos.values()].every((e) => e.processing_status === "PROCESSADO"), "nada marcado para reprocessar");
  });

  test("destino LENTO (nunca responde) não segura o lote: o ACK sai do mesmo jeito", async () => {
    aviso.registrarDestinoAvisoPedidos(() => new Promise(() => {}));
    const repo = criarRepoEmMemoria();
    const r = await Promise.race([
      lote(repo, [ev("e1", "PLC", { min: 1 })]),
      new Promise((_, rej) => setTimeout(() => rej(new Error("processarLote ficou esperando o Realtime")), 2000)),
    ]);
    assert.deepEqual(r.idsParaAck, ["e1"]);
  });

  test("reprocessamento de evento que tinha falhado também avisa a unidade", async () => {
    const repo = criarRepoEmMemoria();
    repo.falhar.garantirPedido = 1;                       // a 1ª aplicação falha: evento fica FALHOU
    await lote(repo, [ev("e1", "PLC", { min: 1 })]);
    assert.equal(repo.eventos.get("e1").processing_status, "FALHOU");
    assert.deepEqual(recebidos, [], "o que falhou não avisa");
    await reprocessarPendentes({ repo, agora: repo.relogio.agora, log: silencio });
    assert.equal(repo.eventos.get("e1").processing_status, "PROCESSADO");
    assert.deepEqual(recebidos, [{ organizacaoId: ORG_A, unidadeId: UN_A }]);
  });
});

describe("Broadcast: só o tópico privado da unidade, payload mínimo", () => {
  const capturar = () => {
    const chamadas = [];
    const fetchImpl = async (url, init) => { chamadas.push({ url, corpo: JSON.parse(init.body), headers: init.headers }); return { ok: true, status: 202 }; };
    return { chamadas, fetchImpl };
  };

  test("somenteUnidade: um único POST privado, no tópico unidade:<id>", async () => {
    const { chamadas, fetchImpl } = capturar();
    await emitirEventoRealtime({ tipo: aviso.EVENTO_PEDIDOS_ATUALIZADOS, organizacaoId: ORG_A, unidadeId: UN_A }, { fetchImpl, somenteUnidade: true });
    assert.equal(chamadas.length, 1);
    assert.match(chamadas[0].url, new RegExp(`/broadcast/${encodeURIComponent(`unidade:${UN_A}`)}/events/evento_dominio\\?private=true$`));
    assert.doesNotMatch(chamadas[0].url, /empresa/);
  });

  test("payload só com tipo, organização, unidade e horário — sem pedido, merchant, cliente ou token", async () => {
    const { chamadas, fetchImpl } = capturar();
    await emitirEventoRealtime({ tipo: aviso.EVENTO_PEDIDOS_ATUALIZADOS, organizacaoId: ORG_A, unidadeId: UN_A }, { fetchImpl, somenteUnidade: true });
    assert.deepEqual(Object.keys(chamadas[0].corpo).sort(), ["emitidoEm", "organizacaoId", "tipo", "unidadeId"]);
    assert.ok(!JSON.stringify(chamadas[0].corpo).match(/order|merchant|customer|token/i));
  });

  test("somenteUnidade sem unidade: não publica nada (nunca cai no canal da empresa)", async () => {
    const { chamadas, fetchImpl } = capturar();
    await emitirEventoRealtime({ tipo: aviso.EVENTO_PEDIDOS_ATUALIZADOS, organizacaoId: ORG_A, unidadeId: null }, { fetchImpl, somenteUnidade: true });
    assert.equal(chamadas.length, 0);
  });

  test("padrão inalterado para quem já usa (Dashboard iFood): empresa + unidade", async () => {
    const { chamadas, fetchImpl } = capturar();
    await emitirEventoRealtime({ tipo: "dashboard_ifood.lancamento_criado", organizacaoId: ORG_A, unidadeId: UN_A }, { fetchImpl });
    assert.equal(chamadas.length, 2);
  });

  test("o host do Events (runtime.js) registra o destino SÓ no tópico da unidade, com o tipo oficial", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync(new URL("../src/worker-ifood/runtime.js", import.meta.url), "utf8");
    // Dentro do ramo da flag, com o tipo oficial e SÓ o tópico da unidade (com prazo próprio no POST).
    assert.match(fonte, /if \(aviso\.checklistRealtimeHabilitado\(env\)\) \{[\s\S]*?aviso\.registrarDestinoAvisoPedidos\(\(\{ organizacaoId, unidadeId \}\) => emitirEventoRealtime\(\s*\n\s*\{ tipo: aviso\.EVENTO_PEDIDOS_ATUALIZADOS, organizacaoId, unidadeId \},\s*\n\s*\{\s*\n\s*somenteUnidade: true,\s*\n\s*fetchImpl: fetchComPrazo,/);
    assert.equal((fonte.match(/registrarDestinoAvisoPedidos\(/g) ?? []).length, 2, "um registro (flag ligada) e uma limpeza (desligada)");
    assert.match(fonte, /\} else \{\s*\n\s*aviso\.registrarDestinoAvisoPedidos\(null\);/);
  });

  test("Broadcast recusado (ex.: 500) não lança — só log", async () => {
    const logs = [];
    await assert.doesNotReject(() => emitirEventoRealtime(
      { tipo: aviso.EVENTO_PEDIDOS_ATUALIZADOS, organizacaoId: ORG_A, unidadeId: UN_A },
      { fetchImpl: async () => ({ ok: false, status: 500 }), somenteUnidade: true, log: (m) => logs.push(m) },
    ));
    assert.equal(logs.length, 1);
  });
});
