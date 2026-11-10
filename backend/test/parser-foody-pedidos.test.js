// Ponte Parser ← foody_pedidos (parserFoodDelivery.foodyPedidos.js): flag fail-closed, uma fonte por dia, isolamento, nulos.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  carregarPedidosFoody, pedidosFoodyNoParserPermitidos, diasCobertosPorPlanilha, linhaFoodyParaParser, operacaoFoodyParaParser,
  fonteFoodyParaApi, ORIGEM_FOODY_API, compararPlanilhaComFoody,
} from "../src/modules/parser-food-delivery/parserFoodDelivery.foodyPedidos.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORG = "11111111-1111-4111-8111-111111111111";
const UNI = "22222222-2222-4222-8222-222222222222";
const OUTRA = "33333333-3333-4333-8333-333333333333";
const ON = { FOODY_CENTRAL_PARSER_PEDIDOS_ENABLED: "true", FOODY_CENTRAL_PARSER_PEDIDOS_UNIDADES: UNI };

function pedido(uid, dataHora, extra = {}) {
  return {
    organizacao_id: ORG, unidade_id: UNI, foody_uid: uid, numero_pedido: `N${uid}`, data_hora: dataHora, status_foody: "closed",
    situacao: "Finalizado", taxa_entregador: "10.00", valor_total: "55.90", forma_pagamento: "Pg. Online", detalhes_pedido: "1x Item",
    operacao: "subway", operacao_motivo: null, entregador_presente: true, entregador_hash: "abcdef1234", data_aceito: dataHora,
    data_pronto: null, data_despachado: null, data_coletado: null, data_entregue: null, data_finalizado: null, data_cancelado: null,
    prazo_entrega: null, cancelamento_razao: null, cancelamento_justificativa: null, sincronizado_em: "2026-11-10T13:26:00+00:00", ...extra,
  };
}

/** Cliente falso: registra filtros e devolve as linhas da tabela pedida (sem aplicar filtros — o código confere o tenant). */
function dbFalso(tabelas, { erroEm } = {}) {
  const chamadas = [];
  return {
    chamadas,
    from(tabela) {
      const q = { tabela, filtros: [] };
      chamadas.push(q);
      const api = {
        select() { return api; },
        eq(c, v) { q.filtros.push(["eq", c, v]); return api; },
        gte(c, v) { q.filtros.push(["gte", c, v]); return api; },
        lte(c, v) { q.filtros.push(["lte", c, v]); return api; },
        lt(c, v) { q.filtros.push(["lt", c, v]); return api; },
        order() { return api; },
        range(a, b) { q.range = [a, b]; return api; },
        then(res, rej) {
          if (erroEm === tabela) return Promise.resolve({ data: null, error: { message: "x" } }).then(res, rej);
          const linhas = tabelas[tabela] ?? [];
          const fatia = q.range ? linhas.slice(q.range[0], q.range[1] + 1) : linhas;
          return Promise.resolve({ data: fatia, error: null }).then(res, rej);
        },
      };
      return api;
    },
  };
}

const args = (db, env = ON) => ({ db, env, organizacaoId: ORG, unidadeId: UNI, dataInicio: "2026-11-07", dataFim: "2026-11-09" });

describe("flag e allowlist (fail-closed)", () => {
  test("desligada ou unidade fora da lista: devolve null SEM consultar nada", async () => {
    for (const env of [{}, { FOODY_CENTRAL_PARSER_PEDIDOS_ENABLED: "1", FOODY_CENTRAL_PARSER_PEDIDOS_UNIDADES: UNI },
      { FOODY_CENTRAL_PARSER_PEDIDOS_ENABLED: "true", FOODY_CENTRAL_PARSER_PEDIDOS_UNIDADES: OUTRA },
      { FOODY_CENTRAL_PARSER_PEDIDOS_ENABLED: "true" }]) {
      const db = dbFalso({});
      assert.equal(await carregarPedidosFoody(args(db, env)), null);
      assert.equal(db.chamadas.length, 0);
    }
    assert.equal(pedidosFoodyNoParserPermitidos({ ...ON, FOODY_CENTRAL_PARSER_PEDIDOS_UNIDADES: ` ${OUTRA} , ${UNI.toUpperCase()} ` }, UNI), true);
  });
  test("independente das flags antigas do Parser (FOODY_CENTRAL_PARSER_ENABLED não liga esta ponte)", () => {
    assert.equal(pedidosFoodyNoParserPermitidos({ FOODY_CENTRAL_PARSER_ENABLED: "true", FOODY_CENTRAL_PARSER_UNIDADES: UNI }, UNI), false);
  });
});

describe("uma fonte por dia", () => {
  test("dias cobertos pelo período da planilha são recortados ao intervalo consultado", () => {
    const d = diasCobertosPorPlanilha([{ periodo_inicio: "2026-11-01", periodo_fim: "2026-11-07" }, { periodo_inicio: "2026-11-20", periodo_fim: "2026-11-21" }], "2026-11-06", "2026-11-09");
    assert.deepEqual([...d].sort(), ["2026-11-06", "2026-11-07"]);
  });
  test("pedido Foody de dia com planilha é descartado; dias sem planilha entram", async () => {
    const db = dbFalso({
      parser_fd_importacoes: [{ organizacao_id: ORG, unidade_id: UNI, periodo_inicio: "2026-11-07", periodo_fim: "2026-11-07" }],
      foody_pedidos: [pedido("a", "2026-11-07T20:00:00"), pedido("b", "2026-11-08T12:00:00"), pedido("c", "2026-11-09T23:59:59")],
    });
    const r = await carregarPedidosFoody(args(db));
    assert.deepEqual(r.linhas.map((l) => l.numero_pedido), ["Nb", "Nc"]);
    assert.deepEqual(r.diasFoody, ["2026-11-08", "2026-11-09"]);
    assert.deepEqual(r.diasPlanilha, ["2026-11-07"]);
    assert.equal(r.operacaoPropria, "subway");
    // filtros de tenant presentes em TODAS as consultas
    for (const q of db.chamadas) {
      assert.ok(q.filtros.some(([op, c, v]) => op === "eq" && c === "organizacao_id" && v === ORG), q.tabela);
      assert.ok(q.filtros.some(([op, c, v]) => op === "eq" && c === "unidade_id" && v === UNI), q.tabela);
    }
  });
});

describe("isolamento e falhas", () => {
  test("linha de outra unidade/organização derruba a fonte (nunca mistura)", async () => {
    const db = dbFalso({ foody_pedidos: [pedido("a", "2026-11-08T12:00:00", { unidade_id: OUTRA })] });
    assert.deepEqual(await carregarPedidosFoody(args(db)), { erro: "FONTE_FOODY_TENANT_DIVERGENTE" });
    const db2 = dbFalso({ parser_fd_importacoes: [{ organizacao_id: OUTRA, unidade_id: UNI, periodo_inicio: "2026-11-01", periodo_fim: "2026-11-01" }] });
    assert.deepEqual(await carregarPedidosFoody(args(db2)), { erro: "FONTE_FOODY_TENANT_DIVERGENTE" });
  });
  test("erro de leitura vira { erro } (o Parser segue só com a planilha)", async () => {
    for (const t of ["parser_fd_importacoes", "foody_conexao_destinos", "foody_pedidos"]) {
      assert.deepEqual(await carregarPedidosFoody(args(dbFalso({}, { erroEm: t }))), { erro: "FONTE_FOODY_INDISPONIVEL" });
    }
  });
  test("destino com duas operações ativas é ambíguo (não chuta)", async () => {
    const db = dbFalso({ foody_conexao_destinos: [
      { organizacao_id: ORG, unidade_id: UNI, operacao: "acai_no_grau", estado: "ATIVO" },
      { organizacao_id: ORG, unidade_id: UNI, operacao: "subway", estado: "ATIVO" }] });
    assert.deepEqual(await carregarPedidosFoody(args(db)), { erro: "FONTE_FOODY_OPERACAO_AMBIGUA" });
  });
});

describe("operação própria (Açaí como destino)", () => {
  test("unidade destino ATIVA de acai_no_grau passa a ter o Açaí como operação própria", async () => {
    const db = dbFalso({
      foody_conexao_destinos: [{ organizacao_id: ORG, unidade_id: UNI, operacao: "acai_no_grau", estado: "ATIVO" }],
      foody_pedidos: [pedido("a", "2026-11-08T12:00:00", { operacao: "acai_no_grau" })],
    });
    const r = await carregarPedidosFoody(args(db));
    assert.equal(r.operacaoPropria, "acai_no_grau");
    assert.equal(r.linhas[0].operacao, "acai_no_grau");
  });
  test("catálogo fechado de operação: desconhecida/triagem vira revisão", () => {
    assert.equal(operacaoFoodyParaParser("triagem"), "revisao_necessaria");
    assert.equal(operacaoFoodyParaParser("pizza"), "revisao_necessaria");
  });
});

describe("transformação de linha", () => {
  test("campos ausentes na API ficam null (nunca zero); entregador vira rótulo neutro; proveniência marcada", () => {
    const l = linhaFoodyParaParser(pedido("u1", "2026-11-08T12:34:56", { taxa_entregador: null, entregador_presente: false, entregador_hash: null }));
    assert.equal(l.id, "foody:u1");
    assert.equal(l.importacao_id, null);
    assert.equal(l.data_hora, "2026-11-08T12:34:56.000Z");
    assert.equal(l.taxa_entregador, null);
    assert.equal(l.entregador, null);
    for (const c of ["data_chegada_entrega", "distancia_raio_km", "distancia_rota_km"]) assert.equal(l[c], null, c);
    assert.equal(l.origem, ORIGEM_FOODY_API);
    const comEntregador = linhaFoodyParaParser(pedido("u2", "2026-11-08 10:00:00"));
    assert.equal(comEntregador.entregador, "Entregador Foody abcdef");
    assert.equal(comEntregador.taxa_entregador, 10);
    assert.equal(comEntregador.data_hora, "2026-11-08T10:00:00.000Z");
  });
  test("fonte sintética descreve a origem automática", () => {
    const f = fonteFoodyParaApi({ dataInicio: "2026-11-07", dataFim: "2026-11-09", diasFoody: ["2026-11-08"], ultimaSincronizacao: "x" });
    assert.equal(f.automatica, true);
    assert.equal(f.periodoInicio, "2026-11-08");
    assert.match(f.nomeArquivo, /Foody Delivery — sincronização automática \(1 dia\)/);
  });
});

describe("sem perda silenciosa (planilha parcial)", () => {
  test("pedidos Foody de dia com planilha são contados por operação (próprios e triagem), não descartados às cegas", async () => {
    const db = dbFalso({
      parser_fd_importacoes: [{ organizacao_id: ORG, unidade_id: UNI, periodo_inicio: "2026-11-08", periodo_fim: "2026-11-08" }],
      foody_pedidos: [pedido("a", "2026-11-08T10:00:00"), pedido("b", "2026-11-08T11:00:00"), pedido("c", "2026-11-08T12:00:00", { operacao: "triagem" }),
        pedido("d", "2026-11-08T13:00:00", { operacao: "acai_no_grau" })],
    });
    const r = await carregarPedidosFoody(args(db));
    assert.equal(r.linhas.length, 0);
    assert.deepEqual(r.foodyPropriosEmDiaDePlanilha, { "2026-11-08": 2 });
    assert.deepEqual(r.foodyTriagemEmDiaDePlanilha, { "2026-11-08": 1 });
  });
  test("planilha com menos pedidos que a Foody vira alerta de planilha parcial; triagem amplia a faixa aceitável", () => {
    const base = { diasPlanilha: ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"] };
    const r = compararPlanilhaComFoody({ ...base,
      planilhaPorDia: { "2026-11-08": 40, "2026-11-09": 95, "2026-11-10": 100, "2026-11-11": 50 },
      foodyPorDia: { "2026-11-08": 90, "2026-11-09": 89, "2026-11-10": 90, "2026-11-11": 0 },
      triagemPorDia: { "2026-11-09": 6, "2026-11-10": 1 } });
    assert.deepEqual(r, [
      { dia: "2026-11-08", planilha: 40, foody: 90, triagem: 0, alerta: "PLANILHA_POSSIVELMENTE_PARCIAL" },
      { dia: "2026-11-10", planilha: 100, foody: 90, triagem: 1, alerta: "FOODY_COM_MENOS_PEDIDOS" },
    ]);
  });
});

describe("estrutural", () => {
  test("ponte só lê (select), nunca grava, não importa modules/foody nem envia mensagens", () => {
    const s = readFileSync(join(RAIZ, "src", "modules", "parser-food-delivery", "parserFoodDelivery.foodyPedidos.js"), "utf8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(s, /\.(insert|update|upsert|delete|rpc)\(/);
    assert.deepEqual([...s.matchAll(/\.from\(\s*["'`]([\w.]+)["'`]/g)].map((m) => m[1]).sort(), ["foody_conexao_destinos", "foody_pedidos", "parser_fd_importacoes"]);
    assert.deepEqual([...s.matchAll(/^import .* from\s+["']([^"']+)["']/gm)].map((m) => m[1]), []);
    assert.doesNotMatch(s, /fetch\(|whatsapp|notifica|comunicacao/i);
    const servico = readFileSync(join(RAIZ, "src", "modules", "parser-food-delivery", "parserFoodDelivery.service.js"), "utf8");
    assert.equal((servico.match(/carregarPedidosFoody\(/g) ?? []).length, 1, "só em analisarPeriodo");
  });
});
