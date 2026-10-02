// Painel iFood — hierarquia Operação/Dados/Loja, card Eventos e o HTML REAL do painel (montarHtmlPainel)
// em cada cenário do piloto. Sem DOM, sem rede: só o retrato do GET /status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { derivarEstadoEvents, derivarEstadoIntegracao, APP_ROTULO } from "../src/ifoodEstado.js";
import { montarHtmlPainel } from "../src/ifood.js";

const AGORA = "2026-10-02T12:00:00.000Z";
const merchant = { idMascarado: "55c8****7040", nome: "Loja X", razaoSocial: "Loja X LTDA" };
const appsOk = { analytics: { conectado: true, status: "ativa" }, financial: { conectado: true, status: "ativa" } };
const orderNaoConectado = { configurado: true, conectado: false, status: null, erroAtual: null };
const orderConectado = { configurado: true, conectado: true, status: "ativa", ultimaAutenticacao: AGORA, ultimoEvento: AGORA, ultimoPedido: AGORA, erroAtual: null };

const NAO_PILOTO = { status: "ativa", merchant, apps: appsOk, order: null, eventosRecebimento: { estado: "disabled" }, conectadaEm: AGORA, atencao: { total: 0 } };
const PILOTO_SEM_ORDER = { ...NAO_PILOTO, order: orderNaoConectado };
const PILOTO_CONECTADO = { ...NAO_PILOTO, order: orderConectado, eventosRecebimento: { estado: "active", ultimoCicloOkEm: AGORA } };

// ---------------------------------------------------------------------------
// Card Eventos (linguagem operacional)
// ---------------------------------------------------------------------------
test("Eventos: desligado no ambiente -> 'Desativado' (prioridade sobre qualquer outro estado)", () => {
  for (const order of [null, orderNaoConectado, orderConectado]) {
    assert.equal(derivarEstadoEvents({ estado: "disabled" }, order).rotulo, "Desativado");
  }
  assert.equal(derivarEstadoEvents(undefined, null).rotulo, "Desativado", "sem informação = desativado, nunca 'erro'");
});

test("Eventos: ligado mas sem Order conectado -> 'Aguardando conexão Order'", () => {
  for (const order of [null, orderNaoConectado]) {
    assert.equal(derivarEstadoEvents({ estado: "active" }, order).rotulo, "Aguardando conexão Order");
  }
});

test("Eventos: estados técnicos viram linguagem de operação (nada de waiting_lease/degraded na tela)", () => {
  const casos = {
    active: "Ativo", starting: "Aguardando processamento", waiting_lease: "Aguardando processamento",
    degraded: "Atenção", stopping: "Atenção", stopped: "Atenção", algo_novo: "Atenção",
  };
  for (const [tecnico, rotulo] of Object.entries(casos)) {
    const ev = derivarEstadoEvents({ estado: tecnico, ultimoCicloOkEm: AGORA }, orderConectado);
    assert.equal(ev.rotulo, rotulo, tecnico);
    assert.ok(!JSON.stringify(ev).includes(tecnico) || tecnico === "active", `${tecnico} não pode aparecer ao cliente`);
  }
});

test("Eventos: erro de recebimento do Order (worker inativo) aparece aqui como 'Atenção' com a mensagem", () => {
  const ev = derivarEstadoEvents({ estado: "active" }, { ...orderConectado, erroAtual: { codigo: "WORKER_INATIVO", mensagem: "O recebimento de eventos não está ativo." } });
  assert.equal(ev.rotulo, "Atenção");
  assert.equal(ev.aviso, "O recebimento de eventos não está ativo.");
});

test("Eventos conectado: só 'Último evento recebido' e 'Última sincronização' (dados que já existem)", () => {
  const ev = derivarEstadoEvents({ estado: "active", ultimoCicloOkEm: AGORA }, orderConectado);
  assert.deepEqual(ev.linhas.map((l) => l[0]), ["Último evento recebido", "Última sincronização"]);
});

test("Dados: rótulos 'Desempenho / Analytics' e 'Financeiro'", () => {
  assert.equal(APP_ROTULO.analytics, "Desempenho / Analytics");
  assert.equal(APP_ROTULO.financial, "Financeiro");
});

// ---------------------------------------------------------------------------
// HTML real do painel
// ---------------------------------------------------------------------------
const ordemDe = (html, ids) => ids.map((id) => html.indexOf(`id="${id}"`));

test("hierarquia: status geral -> OPERAÇÃO -> DADOS -> LOJA VINCULADA; texto de abertura novo", () => {
  const html = montarHtmlPainel(NAO_PILOTO);
  const pos = ordemDe(html, ["ifood-status-pill", "ifood-operacao", "ifood-dados", "ifood-loja"]);
  assert.ok(pos.every((p) => p > -1), JSON.stringify(pos));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, "ordem visual");
  assert.match(html, /centralizar pedidos, eventos e dados da operação/);
  assert.doesNotMatch(html, /Nesta fase só a conexão/);
  assert.doesNotMatch(html, /migrations?/i);
  assert.match(html, /Operação/); assert.match(html, /Dados/); assert.match(html, /Loja iFood vinculada/);
});

test("unidade NÃO piloto: Pedidos 'Ainda não disponível', sem botão de Order e sem 'Ver pedidos'; Eventos 'Desativado'", () => {
  const html = montarHtmlPainel(NAO_PILOTO);
  assert.match(html, /Ainda não disponível para esta unidade/);
  assert.doesNotMatch(html, /conectar_order/);
  assert.doesNotMatch(html, /ifood-abrir-pedidos/);
  assert.match(html, /id="ifood-events-pill">Desativado/);
});

test("unidade piloto sem Order: 'Não conectado' + botão 'Conectar pedidos' (só com loja vinculada)", () => {
  const html = montarHtmlPainel(PILOTO_SEM_ORDER);
  assert.match(html, /id="ifood-order-pill">Não conectado/);
  assert.match(html, /data-acao="conectar_order">Conectar pedidos</);
  assert.doesNotMatch(html, /ifood-abrir-pedidos/, "sem Order conectado não há lista de pedidos");
  const semLoja = montarHtmlPainel({ ...PILOTO_SEM_ORDER, merchant: null });
  assert.doesNotMatch(semLoja, /conectar_order/);
  assert.match(semLoja, /Vincule a loja iFood desta unidade para conectar os pedidos/);
});

test("unidade piloto conectada: Pedidos 'Conectado', Eventos 'Ativo', último evento na loja, 'Ver pedidos' disponível", () => {
  const html = montarHtmlPainel(PILOTO_CONECTADO);
  assert.match(html, /id="ifood-order-pill">Conectado/);
  assert.match(html, /id="ifood-events-pill">Ativo/);
  assert.match(html, /ifood-abrir-pedidos/);
  assert.doesNotMatch(html, /conectar_order/);
  const loja = html.slice(html.indexOf('id="ifood-loja"'));
  assert.match(loja, /Último evento recebido/);
});

test("badges sem poluição: 1 badge geral + 1 por módulo (Pedidos, Eventos, Analytics, Financeiro)", () => {
  const html = montarHtmlPainel(PILOTO_SEM_ORDER);
  const pills = html.match(/class="pill /g) ?? [];
  assert.equal(pills.length, 5, "geral + 4 módulos");
});

test("Analytics/Financial sem regressão: estado geral e ações continuam os mesmos", () => {
  for (const s of [NAO_PILOTO, PILOTO_SEM_ORDER, PILOTO_CONECTADO]) {
    const e = derivarEstadoIntegracao(s);
    assert.equal(e.chave, "conectado", "Order nunca muda o estado geral");
    assert.match(montarHtmlPainel(s), /data-acao="desconectar"/);
  }
  const nada = montarHtmlPainel({ status: "nao_conectado", merchant: null, apps: { analytics: {}, financial: {} }, order: null, atencao: { total: 0 } });
  assert.match(nada, /data-acao="conectar">Conectar iFood</, "assistente Analytics/Financial intacto");
  assert.doesNotMatch(nada, /conectar_order/);
});

test("nada técnico/sensível no HTML do cliente: sem lease, holder, TTL, token ou client id", () => {
  for (const s of [NAO_PILOTO, PILOTO_SEM_ORDER, PILOTO_CONECTADO]) {
    const html = montarHtmlPainel(s);
    assert.doesNotMatch(html, /lease|holder|TTL|waiting_lease|degraded|client_?id|accessToken|Bearer/i);
  }
});
