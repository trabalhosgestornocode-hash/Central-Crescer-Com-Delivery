// Camada central Foody — testes de unidade das partes PURAS (sem banco, sem rede).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lerFlagsFoody, unidadePermitida, agendamentoPermitido } from "../src/modules/foody/foody.flags.js";
import { janelaDoDia, paraParede, competenciasParaSincronizar, situacaoCompetencia, validarCompetencia } from "../src/modules/foody/foody.periodo.js";
import { criarSegurancaFoody, impressaoToken, foodyLog, redigir, FoodyConfigErro } from "../src/modules/foody/foody.seguranca.js";
import { criarClienteFoody, FoodyApiErro } from "../src/modules/foody/foody.client.js";
import { sanearPedidoApi, paraPedidoParser, classificarTipoEntregador } from "../src/modules/foody/foody.adapter.js";
import { calcularFechamentoLogistico } from "../src/modules/foody/foody.fechamento.calc.js";
import { decidirStatus } from "../src/modules/foody/foody.fechamento.service.js";
import { prepararConexao } from "../src/modules/foody/foody.conexao.js";
import { pedidoApi, UNI_A, UNI_B, ORG_A, SEGREDO_TESTE, TOKEN_TESTE } from "./helpers/foody-fixtures.js";

const seg = criarSegurancaFoody(SEGREDO_TESTE);
const hashEntregador = seg.hashEntregador;
const sanear = (o) => sanearPedidoApi(o, { hashEntregador }).registro;
const COB_OK = { completa: true, janelaInicio: "a", janelaFim: "b", paginas: 1, pedidosUnicos: 1, pendencias: [] };

describe("flags (fail-closed)", () => {
  test("ausentes = tudo desligado", () => {
    const f = lerFlagsFoody({});
    assert.equal(f.habilitado, false); assert.equal(f.agendadorHabilitado, false); assert.equal(f.unidades.size, 0);
    assert.equal(unidadePermitida({}, UNI_A), false); assert.equal(agendamentoPermitido({}), false);
  });
  test("só 'true' exato liga; allowlist ignora lixo; unidade fora da lista é recusada", () => {
    const env = { FOODY_CENTRAL_ENABLED: "TRUE ", FOODY_CENTRAL_UNIDADES: `${UNI_A}, lixo, ;drop` };
    assert.equal(unidadePermitida(env, UNI_A), true);
    assert.equal(unidadePermitida(env, UNI_B), false);
    assert.equal(unidadePermitida({ ...env, FOODY_CENTRAL_ENABLED: "1" }, UNI_A), false);
    assert.equal(agendamentoPermitido(env), false, "sem a flag do agendador");
    assert.equal(agendamentoPermitido({ ...env, FOODY_CENTRAL_AGENDADOR_ENABLED: "true" }), true);
    assert.equal(agendamentoPermitido({ FOODY_CENTRAL_ENABLED: "true", FOODY_CENTRAL_AGENDADOR_ENABLED: "true" }), false, "allowlist vazia");
  });
});

describe("período (hora de parede, startDate inclusivo, endDate exclusivo)", () => {
  test("janela do dia vai de D 00:00 até D+1 00:00 em -03:00 (inclusive virada de mês/ano)", () => {
    assert.deepEqual(janelaDoDia("2026-09-12"), { inicio: "2026-09-12T00:00:00-03:00", fim: "2026-09-13T00:00:00-03:00" });
    assert.deepEqual(janelaDoDia("2026-12-31"), { inicio: "2026-12-31T00:00:00-03:00", fim: "2027-01-01T00:00:00-03:00" });
    assert.throws(() => janelaDoDia("2026-02-30"));
    assert.equal(validarCompetencia("2026-13-01"), false);
  });
  test("paraParede converte qualquer fuso para Brasília e preserva -03:00 sem mexer", () => {
    assert.equal(paraParede("2026-09-12T19:03:11-03:00"), "2026-09-12T19:03:11");
    assert.equal(paraParede("2026-09-12T22:03:11Z"), "2026-09-12T19:03:11");
    assert.equal(paraParede("2026-09-13T02:30:00+00:00"), "2026-09-12T23:30:00");
    assert.equal(paraParede(null), null); assert.equal(paraParede(""), null); assert.equal(paraParede("lixo"), null);
  });
  test("D-1..D-3 e congelamento", () => {
    const agora = new Date("2026-10-26T15:00:00Z"); // 12:00 em Brasília
    assert.deepEqual(competenciasParaSincronizar(agora), ["2026-10-25", "2026-10-24", "2026-10-23"]);
    assert.equal(situacaoCompetencia("2026-10-26", agora), "FUTURA_OU_ABERTA");
    assert.equal(situacaoCompetencia("2026-10-23", agora), "REPROCESSAVEL");
    assert.equal(situacaoCompetencia("2026-10-22", agora), "CONGELADA");
    // 01:00 UTC = 22:00 do dia anterior em Brasília: "hoje" ainda é o dia anterior.
    assert.deepEqual(competenciasParaSincronizar(new Date("2026-10-26T01:00:00Z"))[0], "2026-10-24");
  });
});

describe("segurança", () => {
  test("sem segredo forte falha fechado", () => {
    assert.throws(() => criarSegurancaFoody(undefined), FoodyConfigErro);
    assert.throws(() => criarSegurancaFoody("curto"), FoodyConfigErro);
  });
  test("token cifrado para uma unidade NÃO decifra em outra; cifrado nunca contém o token", () => {
    const c = seg.cifrarToken(TOKEN_TESTE, UNI_A);
    assert.ok(!c.includes(TOKEN_TESTE));
    assert.match(c, /^k1:/);
    assert.equal(seg.decifrarToken(c, UNI_A), TOKEN_TESTE);
    assert.throws(() => seg.decifrarToken(c, UNI_B));
    assert.throws(() => criarSegurancaFoody(`${SEGREDO_TESTE}-outro`).decifrarToken(c, UNI_A));
  });
  test("impressão é 12 hex estável e não revela o token", () => {
    const i = impressaoToken(TOKEN_TESTE);
    assert.match(i, /^[0-9a-f]{12}$/); assert.equal(i, impressaoToken(` ${TOKEN_TESTE} `)); assert.ok(!TOKEN_TESTE.includes(i));
  });
  test("HMAC do entregador: estável à caixa/acento/espaço, 16 hex, depende do segredo", () => {
    assert.equal(hashEntregador("José  da Silva"), hashEntregador("jose da silva"));
    assert.match(hashEntregador("José"), /^[0-9a-f]{16}$/);
    assert.notEqual(hashEntregador("José"), criarSegurancaFoody(`${SEGREDO_TESTE}-x`).hashEntregador("José"));
    assert.equal(hashEntregador("  "), null);
  });
  test("foodyLog redige o token literal e chaves sensíveis em qualquer profundidade", () => {
    const linhas = [];
    foodyLog("error", "x", { msg: `falhou com ${TOKEN_TESTE}`, headers: { Authorization: TOKEN_TESTE }, aninhado: [{ t: TOKEN_TESTE }] },
      { segredos: [TOKEN_TESTE], saida: (l) => linhas.push(l) });
    assert.equal(linhas.length, 1); assert.ok(!linhas[0].includes(TOKEN_TESTE)); assert.match(linhas[0], /REDACTED/);
    assert.equal(redigir("abc", ["abc"]), "abc", "segredos curtos demais não são usados (evita redigir texto comum)");
  });
  test("prepararConexao nasce PAUSADA, cifrada e com impressão", () => {
    const l = prepararConexao({ organizacaoId: ORG_A, unidadeId: UNI_A, token: TOKEN_TESTE, pontoColetaEsperado: "Subway Saci" }, seg);
    assert.equal(l.status, "PAUSADA"); assert.ok(!JSON.stringify(l).includes(TOKEN_TESTE));
    assert.equal(seg.decifrarToken(l.token_cifrado, UNI_A), TOKEN_TESTE); assert.equal(l.token_impressao, impressaoToken(TOKEN_TESTE));
  });
});

// ---------------------------------------------------------------- cliente
function fetchFalso(paginas, { registro = [] } = {}) {
  let i = 0;
  return async (url, init) => {
    registro.push({ url, init });
    const r = typeof paginas === "function" ? paginas(url, i) : paginas[i];
    i++;
    if (r instanceof Error) throw r;
    if (typeof r === "number") return { ok: false, status: r, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
}
const semEspera = async () => {};

describe("cliente Foody (somente GET)", () => {
  test("toda chamada é GET em /orders? com Authorization; nunca há corpo", async () => {
    const registro = [];
    const c = criarClienteFoody({ token: TOKEN_TESTE, fetch: fetchFalso([[pedidoApi()]], { registro }), esperar: semEspera });
    const r = await c.listarPedidos(janelaDoDia("2026-10-25"));
    assert.equal(r.pedidos.length, 1);
    assert.equal(registro.length, 1);
    assert.equal(registro[0].init.method, "GET"); assert.equal(registro[0].init.body, undefined);
    assert.equal(registro[0].init.headers.Authorization, TOKEN_TESTE);
    assert.match(registro[0].url, /^https:\/\/app\.foodydelivery\.com\/rest\/1\.2\/orders\?startDate=2026-10-25T00%3A00%3A00-03%3A00&endDate=2026-10-26T00%3A00%3A00-03%3A00$/);
  });
  test("paginação: recomeça no date do último, deduplica a fronteira por uid", async () => {
    const p1 = Array.from({ length: 3 }, (_, k) => pedidoApi({ uid: `u${k}`, date: `2026-10-25T1${k}:00:00-03:00` }));
    const p2 = [pedidoApi({ uid: "u2", date: "2026-10-25T12:00:00-03:00" }), pedidoApi({ uid: "u3", date: "2026-10-25T13:00:00-03:00" })];
    const registro = [];
    const c = criarClienteFoody({ token: TOKEN_TESTE, fetch: fetchFalso([p1, p2], { registro }), esperar: semEspera, tamanhoPagina: 3 });
    const r = await c.listarPedidos(janelaDoDia("2026-10-25"));
    assert.deepEqual(r.pedidos.map((p) => p.uid), ["u0", "u1", "u2", "u3"]);
    assert.deepEqual(r.cobertura, { inicio: "2026-10-25T00:00:00-03:00", fim: "2026-10-26T00:00:00-03:00", paginas: 2, recebidos: 5, unicos: 4, semUid: 0 });
    assert.match(decodeURIComponent(registro[1].url), /startDate=2026-10-25T12:00:00-03:00&endDate=2026-10-26T00:00:00-03:00/);
  });
  test("página cheia sem avanço de data = erro (nunca cobertura parcial silenciosa)", async () => {
    const mesmo = Array.from({ length: 2 }, (_, k) => pedidoApi({ uid: `m${k}`, date: "2026-10-25T00:00:00-03:00" }));
    const c = criarClienteFoody({ token: TOKEN_TESTE, fetch: fetchFalso([mesmo]), esperar: semEspera, tamanhoPagina: 2 });
    await assert.rejects(c.listarPedidos(janelaDoDia("2026-10-25")), (e) => e.codigo === "PAGINACAO_SEM_PROGRESSO");
  });
  test("401 não é retentado e o erro não contém o token; 429/5xx são retentados com espera", async () => {
    const reg1 = [];
    const c1 = criarClienteFoody({ token: TOKEN_TESTE, fetch: fetchFalso([401, 401], { registro: reg1 }), esperar: semEspera });
    await assert.rejects(c1.listarPedidos(janelaDoDia("2026-10-25")), (e) => e instanceof FoodyApiErro && e.codigo === "AUTENTICACAO" && !e.message.includes(TOKEN_TESTE));
    assert.equal(reg1.length, 1);
    const esperas = [];
    const c2 = criarClienteFoody({ token: TOKEN_TESTE, fetch: fetchFalso([429, 503, [pedidoApi()]]), esperar: async (ms) => { esperas.push(ms); } });
    assert.equal((await c2.listarPedidos(janelaDoDia("2026-10-25"))).pedidos.length, 1);
    assert.equal(esperas.length, 4, "2 backoffs + 2 espaçamentos");
  });
  test("erro de rede com o token na mensagem é redigido", async () => {
    const c = criarClienteFoody({ token: TOKEN_TESTE, fetch: fetchFalso([new Error(`ECONNRESET ${TOKEN_TESTE}`), new Error(`x ${TOKEN_TESTE}`), new Error(TOKEN_TESTE)]), esperar: semEspera });
    await assert.rejects(c.listarPedidos(janelaDoDia("2026-10-25")), (e) => e.codigo === "REDE" && !e.message.includes(TOKEN_TESTE));
  });
  test("resposta que não é lista = RESPOSTA_INVALIDA; janela invertida recusada; sem token recusado", async () => {
    const c = criarClienteFoody({ token: TOKEN_TESTE, fetch: fetchFalso([{ erro: 1 }]), esperar: semEspera });
    await assert.rejects(c.listarPedidos(janelaDoDia("2026-10-25")), (e) => e.codigo === "RESPOSTA_INVALIDA");
    await assert.rejects(c.listarPedidos({ inicio: "2026-10-26T00:00:00-03:00", fim: "2026-10-25T00:00:00-03:00" }), RangeError);
    assert.throws(() => criarClienteFoody({ token: "" }), FoodyApiErro);
  });
});

// ---------------------------------------------------------------- adaptador
describe("adaptador (lista branca, sem dado pessoal)", () => {
  test("nenhum dado pessoal sobrevive ao saneamento", () => {
    const r = sanear(pedidoApi({ entregador: "Entregador Ficticio A" }));
    const json = JSON.stringify(r);
    for (const proibido of ["Maria", "Cliente Fictício", "98888", "90000", "exemplo.invalid", "Rua", "Interfone", "Entregador Ficticio", "-23.5", "campoNovoQualquer"]) {
      assert.ok(!json.includes(proibido), `vazou: ${proibido}`);
    }
    assert.match(r.entregador_hash, /^[0-9a-f]{16}$/);
    assert.equal(r.ponto_coleta, "Subway Saci");
    assert.match(r.fonte_hash, /^[0-9a-f]{64}$/);
  });
  test("mapeia status, pagamento, razão e campos não documentados, em hora de parede", () => {
    const r = sanear(pedidoApi({ status: "cancelled", date: "2026-10-25T23:59:59-03:00", cancelledDate: "2026-10-26T03:10:00Z",
      acceptanceDate: "2026-10-25T23:00:00-03:00", cancellationReason: "ifood_cancellation", cancellationText: "cliente desistiu", paymentMethod: "card" }));
    assert.equal(r.situacao, "Cancelado"); assert.equal(r.competencia, "2026-10-25"); assert.equal(r.data_hora, "2026-10-25T23:59:59");
    assert.equal(r.data_cancelado, "2026-10-26T00:10:00"); assert.equal(r.data_aceito, "2026-10-25T23:00:00");
    assert.equal(r.cancelamento_razao, "Cancelamento proveniente do IFood"); assert.equal(r.cancelamento_justificativa, "cliente desistiu");
    assert.equal(r.forma_pagamento, "Cartão");
  });
  test("courierType em catálogo fechado; sem nome = sem_entregador mesmo com taxa prevista", () => {
    assert.equal(classificarTipoEntregador({ courierName: "x", courierType: "internal" }), "proprio");
    assert.equal(classificarTipoEntregador({ courierName: "x", courierType: "INTERNAL" }), "proprio");
    assert.equal(classificarTipoEntregador({ courierName: "x", courierType: "external" }), "nao_classificado");
    assert.equal(classificarTipoEntregador({ courierName: "x" }), "nao_classificado");
    assert.equal(classificarTipoEntregador({ courierName: " ", courierType: "internal" }), "sem_entregador");
    const r = sanear(pedidoApi({ entregador: null, courierFee: 9 }));
    assert.equal(r.entregador_tipo, "sem_entregador"); assert.equal(r.entregador_hash, null); assert.equal(r.taxa_entregador, 9);
  });
  test("pedido malformado vira erro classificado, nunca exceção", () => {
    assert.deepEqual(sanearPedidoApi(null, { hashEntregador }), { erro: "PEDIDO_INVALIDO" });
    assert.equal(sanearPedidoApi({ id: "1", date: "2026-10-25T10:00:00-03:00" }, { hashEntregador }).erro, "SEM_UID");
    assert.equal(sanearPedidoApi({ uid: "u", date: "2026-10-25T10:00:00-03:00" }, { hashEntregador }).erro, "SEM_NUMERO");
    assert.equal(sanearPedidoApi({ uid: "u", id: "1", date: "x" }, { hashEntregador }).erro, "SEM_DATA");
  });
  test("hash de conteúdo muda com o conteúdo e ignora campo novo/pessoal", () => {
    const base = pedidoApi({ uid: "h1", id: "77" });
    const a = sanear(base).fonte_hash;
    assert.equal(sanear({ ...base, notes: "outro texto", customer: { customerName: "Outro" }, novo: 1 }).fonte_hash, a);
    assert.notEqual(sanear({ ...base, courierFee: 11 }).fonte_hash, a);
    assert.notEqual(sanear({ ...base, status: "cancelled" }).fonte_hash, a);
  });
  test("paraPedidoParser entrega os nomes de campo do Parser", () => {
    const p = paraPedidoParser(sanear(pedidoApi({ collectedDate: "2026-10-25T12:10:00-03:00" })));
    for (const k of ["numeroPedido", "dataHora", "situacao", "entregador", "taxaEntregador", "detalhesPedido", "dataColetado", "dataCancelado", "dataChegadaEntrega", "justificativaCancelamento"]) {
      assert.ok(k in p, k);
    }
    assert.equal(p.dataChegadaEntrega, null);
  });
});

// ---------------------------------------------------------------- cálculo
describe("fechamento logístico (regras do Parser + decisões aprovadas)", () => {
  const D = "2026-10-25";
  const dia = (h) => `${D}T${h}-03:00`;
  const cenario = () => [
    // Subway, entregador próprio A: 2 entregues + 1 cancelado depois da coleta (recebe taxa)
    pedidoApi({ entregador: "A", courierFee: 10, date: dia("11:00:00"), collectedDate: dia("11:20:00"), deliveryDate: dia("11:40:00") }),
    pedidoApi({ entregador: "A", courierFee: 12, date: dia("12:00:00"), collectedDate: dia("12:20:00"), deliveryDate: dia("12:40:00") }),
    pedidoApi({ entregador: "A", courierFee: 8, status: "cancelled", date: dia("13:00:00"), collectedDate: dia("13:10:00"), cancelledDate: dia("13:30:00") }),
    // Subway, entregador próprio B: cancelado antes da coleta (não recebe)
    pedidoApi({ entregador: "B", courierFee: 9, status: "cancelled", date: dia("14:00:00"), acceptanceDate: dia("14:05:00"), cancelledDate: dia("14:10:00") }),
    // Subway, entregador NÃO classificado
    pedidoApi({ entregador: "C", courierType: "external", courierFee: 15, date: dia("15:00:00"), collectedDate: dia("15:10:00"), deliveryDate: dia("15:30:00") }),
    // Subway sem entregador, com taxa prevista
    pedidoApi({ entregador: null, courierFee: 7, date: dia("16:00:00") }),
    // Açaí despachado por entregador próprio da conta Subway
    pedidoApi({ entregador: "A", courierFee: 10, orderDetails: "1x Açaí Premium 500ml", date: dia("17:00:00") }),
    pedidoApi({ entregador: "B", courierFee: 11, orderDetails: "Monte seu Açaí & Cremes", date: dia("18:00:00") }),
    // Operação em dúvida (sub + açaí no mesmo pedido)
    pedidoApi({ entregador: "A", courierFee: 6, orderDetails: "1x Sub 15cm + 1x Açaí 300ml", date: dia("19:00:00") }),
    // Outro dia (não entra)
    pedidoApi({ entregador: "A", courierFee: 99, date: "2026-10-26T00:00:00-03:00" }),
  ].map(sanear);

  test("totais Subway, separação próprio × não classificado, sem entregador fora", () => {
    const f = calcularFechamentoLogistico(cenario(), { competencia: D, cobertura: COB_OK });
    const s = f.indicadores.subway;
    assert.equal(f.indicadores.pedidosNaConta, 9);
    assert.equal(s.pedidos, 6); assert.equal(s.semEntregador, 1); assert.equal(s.taxasPrevistasSemEntregador, 7); assert.equal(s.elegiveis, 5);
    assert.equal(s.total.taxasBrutas, 54); assert.equal(s.total.taxasDescartadas, 9); assert.equal(s.total.taxasValidas, 45);
    assert.equal(s.proprio.pedidos, 4); assert.equal(s.proprio.taxasValidas, 30); assert.equal(s.custoLogisticoProprio, 30);
    assert.equal(s.proprio.entregues, 2); assert.equal(s.proprio.custoMedioPorEntrega, 15);
    assert.equal(s.naoClassificado.pedidos, 1); assert.equal(s.naoClassificado.taxasValidas, 15);
    assert.deepEqual(s.regrasCancelamento, { regra_coleta: 1, regra_sem_coleta: 1 });
    assert.equal(s.entregadores.length, 2);
    assert.ok(s.entregadores.every((e) => /^[0-9a-f]{16}$/.test(e.entregadorHash)));
  });
  test("Açaí: bloco separado com quantidade e taxas, NUNCA somado à Subway", () => {
    const f = calcularFechamentoLogistico(cenario(), { competencia: D, cobertura: COB_OK });
    assert.deepEqual(Object.keys(f.outrasOperacoes), ["acai_no_grau"]);
    const a = f.outrasOperacoes.acai_no_grau;
    assert.equal(a.pedidos, 2); assert.equal(a.comEntregador, 2); assert.equal(a.taxasIdentificadas, 21); assert.equal(a.somadoAoCustoDaUnidade, false);
    assert.deepEqual(a.porTipoEntregador, { proprio: { pedidos: 2, taxas: 21 } });
    // Sem o Açaí e sem a operação em dúvida, o total da Subway é o mesmo.
    const semOutros = calcularFechamentoLogistico(cenario().filter((r) => r.operacao === "subway"), { competencia: D, cobertura: COB_OK });
    assert.deepEqual(semOutros.indicadores.subway, f.indicadores.subway);
  });
  test("pendências e estado de valor: PROVISORIO com decisão pendente; SINCRONIZADO sem pendência", () => {
    const f = calcularFechamentoLogistico(cenario(), { competencia: D, cobertura: COB_OK });
    assert.equal(f.status, "CONSOLIDADO"); assert.equal(f.estadoValores, "PROVISORIO");
    assert.deepEqual(f.pendencias.map((p) => p.codigo).sort(), ["ENTREGADOR_NAO_CLASSIFICADO", "OPERACAO_EM_DUVIDA"]);
    assert.equal(f.indicadores.estadoPorValor.taxasBrutas, "SINCRONIZADO"); assert.equal(f.indicadores.estadoPorValor.custoReal, null);
    const limpo = calcularFechamentoLogistico(cenario().slice(0, 4), { competencia: D, cobertura: COB_OK });
    assert.equal(limpo.estadoValores, "SINCRONIZADO"); assert.deepEqual(limpo.pendencias, []);
  });
  test("cancelamento sem horário do cancelamento cai em REVISAR (motor do Parser) e deixa PROVISORIO", () => {
    const r = [sanear(pedidoApi({ entregador: "A", status: "cancelled", collectedDate: dia("10:00:00") }))];
    const f = calcularFechamentoLogistico(r, { competencia: D, cobertura: COB_OK });
    assert.equal(f.indicadores.subway.total.canceladosRevisao, 1); assert.equal(f.estadoValores, "PROVISORIO");
    assert.ok(f.pendencias.some((p) => p.codigo === "CANCELAMENTO_EM_REVISAO"));
  });
  test("cobertura incompleta = INCOMPLETO e PROVISORIO", () => {
    const f = calcularFechamentoLogistico(cenario(), { competencia: D, cobertura: { ...COB_OK, completa: false, pendencias: [{ codigo: "PEDIDO_MALFORMADO", quantidade: 1 }] } });
    assert.equal(f.status, "INCOMPLETO"); assert.equal(f.estadoValores, "PROVISORIO");
    assert.ok(f.pendencias.some((p) => p.codigo === "PEDIDO_MALFORMADO"));
  });
  test("hash determinístico: independe da ordem de entrada; muda quando um valor muda", () => {
    const a = calcularFechamentoLogistico(cenario(), { competencia: D, cobertura: COB_OK }).hash;
    assert.equal(calcularFechamentoLogistico(cenario().reverse(), { competencia: D, cobertura: COB_OK }).hash, a);
    const mudado = cenario(); mudado[0] = { ...mudado[0], taxa_entregador: 10.5 };
    assert.notEqual(calcularFechamentoLogistico(mudado, { competencia: D, cobertura: COB_OK }).hash, a);
  });
  test("nenhum dado pessoal no resultado do fechamento", () => {
    const json = JSON.stringify(calcularFechamentoLogistico(cenario(), { competencia: D, cobertura: COB_OK }));
    for (const p of ["Entregador Ficticio", "Cliente", "Rua", "9888", "\"A\"", "\"B\""]) assert.ok(!json.includes(p), p);
  });
  test("decidirStatus: consolidado que muda vira CORRIGIDO com motivo; igual mantém; incompleto fica incompleto", () => {
    assert.deepEqual(decidirStatus({ status: "CONSOLIDADO", hash: "h1" }, null, null), { status: "CONSOLIDADO", motivo: null });
    assert.equal(decidirStatus({ status: "CONSOLIDADO", hash: "h2" }, { status: "CONSOLIDADO", hash_conteudo: "h1" }).status, "CORRIGIDO");
    assert.ok(decidirStatus({ status: "CONSOLIDADO", hash: "h2" }, { status: "CONSOLIDADO", hash_conteudo: "h1" }).motivo);
    assert.equal(decidirStatus({ status: "CONSOLIDADO", hash: "h1" }, { status: "CORRIGIDO", hash_conteudo: "h1" }).status, "CORRIGIDO");
    assert.equal(decidirStatus({ status: "INCOMPLETO", hash: "h1" }, { status: "CONSOLIDADO", hash_conteudo: "h0" }).status, "INCOMPLETO");
  });
});

describe("revisão de segurança — regressões F1/F4/F5 e integridade financeira", () => {
  const D = "2026-10-25";
  const dia = (h) => `${D}T${h}-03:00`;
  test("F1: outra operação perde os dados comerciais; dúvida e Subway mantêm os detalhes", () => {
    const acai = sanear(pedidoApi({ orderDetails: "Açaí Premium 500ml", orderTotal: 40, deliveryFee: 6, paymentMethod: "money", cancellationText: "x", cancellationReason: "other" }));
    assert.equal(acai.operacao, "acai_no_grau");
    for (const k of ["detalhes_pedido", "valor_total", "taxa_entrega", "forma_pagamento", "cancelamento_razao", "cancelamento_justificativa"]) assert.equal(acai[k], null, k);
    assert.doesNotMatch(acai.operacao_motivo, /açaí|acai|premium/i);
    assert.equal(acai.taxa_entregador, 10);
    const duvida = sanear(pedidoApi({ orderDetails: "1x Sub 15cm + 1x Açaí 300ml", orderTotal: 40 }));
    assert.equal(duvida.operacao, "revisao_necessaria"); assert.ok(duvida.detalhes_pedido); assert.equal(duvida.valor_total, 40);
    assert.ok(sanear(pedidoApi({})).detalhes_pedido);
  });
  test("F4: página fora da ordem de data é recusada pelo cliente", async () => {
    const pag = [pedidoApi({ uid: "o1", date: dia("12:00:00") }), pedidoApi({ uid: "o2", date: dia("11:00:00") })];
    const c = criarClienteFoody({ token: TOKEN_TESTE, fetch: async () => ({ ok: true, status: 200, json: async () => pag }), esperar: async () => {} });
    await assert.rejects(c.listarPedidos(janelaDoDia(D)), (e) => e.codigo === "ORDENACAO_INESPERADA");
  });
  test("F5: Subway por padrão (sem termo de nenhuma operação) é contado e exposto, sem alterar o estado (paridade com o Parser)", () => {
    const r = [
      pedidoApi({ entregador: "A", courierFee: 10, orderDetails: "1x Sub Frango 15cm", date: dia("11:00:00") }),
      pedidoApi({ entregador: "A", courierFee: 7, orderDetails: "2x Cookie gotas de chocolate", date: dia("12:00:00") }),
    ].map(sanear);
    const f = calcularFechamentoLogistico(r, { competencia: D, cobertura: COB_OK });
    assert.equal(f.indicadores.subway.elegiveisSemEvidenciaDeOperacao, 1);
    assert.deepEqual(f.pendencias, [{ codigo: "OPERACAO_POR_PADRAO", quantidade: 1, informativa: true, taxasBrutas: 7 }]);
    assert.equal(f.estadoValores, "SINCRONIZADO");
    assert.equal(f.indicadores.subway.total.taxasValidas, 17, "continua somado à Subway, como no Parser");
  });
  test("integridade: cada pedido cai em exatamente UM grupo; Subway = próprio + não classificado; outra operação fora dos totais", () => {
    const r = [
      pedidoApi({ entregador: "A", courierFee: 10, date: dia("10:00:00") }),
      pedidoApi({ entregador: "C", courierType: "external", courierFee: 15, date: dia("10:10:00") }),
      pedidoApi({ entregador: null, courierFee: 7, date: dia("10:20:00") }),
      pedidoApi({ entregador: "A", courierFee: 11, orderDetails: "Açaí 300ml", date: dia("10:30:00") }),
      pedidoApi({ entregador: null, courierFee: 4, orderDetails: "Açaí 500ml", date: dia("10:40:00") }),
      pedidoApi({ entregador: "A", courierFee: 6, orderDetails: "1x Sub + 1x Açaí", date: dia("10:50:00") }),
      pedidoApi({ entregador: "A", courierFee: 9, status: "cancelled", acceptanceDate: dia("11:00:00"), cancelledDate: dia("11:05:00"), date: dia("11:00:00") }),
    ].map(sanear);
    const f = calcularFechamentoLogistico(r, { competencia: D, cobertura: COB_OK });
    const s = f.indicadores.subway, o = f.outrasOperacoes.acai_no_grau;
    assert.equal(s.pedidos + f.indicadores.operacaoEmDuvida.pedidos + o.pedidos, f.indicadores.pedidosNaConta);
    assert.equal(s.elegiveis + s.semEntregador, s.pedidos);
    assert.equal(s.proprio.pedidos + s.naoClassificado.pedidos, s.elegiveis);
    assert.equal(s.proprio.taxasBrutas + s.naoClassificado.taxasBrutas, s.total.taxasBrutas);
    assert.equal(s.proprio.taxasValidas + s.naoClassificado.taxasValidas, s.total.taxasValidas);
    assert.equal(s.total.taxasBrutas, 34); assert.equal(s.total.taxasValidas, 25); assert.equal(s.custoLogisticoProprio, 10);
    assert.equal(o.taxasIdentificadas, 11, "só quem tinha entregador; a taxa prevista sem entregador (4) não entra");
    assert.equal(o.somadoAoCustoDaUnidade, false);
    const somaEntregadores = s.entregadores.reduce((x, e) => x + e.taxasValidas, 0);
    assert.equal(Math.round(somaEntregadores * 100) / 100, s.proprio.taxasValidas);
  });
});
