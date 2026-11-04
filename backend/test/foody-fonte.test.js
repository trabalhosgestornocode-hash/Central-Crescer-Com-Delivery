// Fase C — fonte única por dia (Excel × Foody), quatro grandezas separadas e ponte do Parser atrás de flag.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolverFontePorDia, ultimaVersaoPorDia, FONTE } from "../src/modules/foody/foody.fonte.js";
import { carregarFonteLogistica, fonteFoodyNoParserPermitida } from "../src/modules/parser-food-delivery/parserFoodDelivery.foody.js";
import { resumoConciliacao } from "../src/modules/parser-food-delivery/parserFoodDelivery.calc.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORG = "11111111-1111-4111-8111-111111111111", UNI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OUTRA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const pedido = (dia, taxa, extra = {}) => ({ dataHora: `${dia}T12:00:00`, situacao: "Finalizado", taxaEntregador: taxa, statusConciliacao: "incluido", entregador: "Ana", ...extra });
const fech = (competencia, versao, status, total, extra = {}) => ({ organizacao_id: ORG, unidade_id: UNI, competencia, versao, status, estado_valores: "SINCRONIZADO",
  indicadores: { subway: { total, custoLogisticoProprio: total.taxasValidas - 1 } }, ...extra });
const T = (pedidos, taxasBrutas, taxasValidas, entregues = pedidos) => ({ pedidos, entregues, taxasBrutas, taxasValidas });

describe("resolverFontePorDia — um dia, uma fonte", () => {
  const excelDias = [pedido("2026-11-01", 10), pedido("2026-11-01", 8), pedido("2026-11-01", 5, { situacao: "Cancelado", statusConciliacao: "excluido" })];
  const base = (fechamentos, custoReal = null, extraExcel = []) => resolverFontePorDia({ de: "2026-11-01", ate: "2026-11-04",
    excel: { pedidosElegiveis: [...excelDias, ...extraExcel], todos: [...excelDias, ...extraExcel], resumoPorDia: resumoConciliacao, custoReal }, fechamentos });

  test("dia com Excel E Foody conta só o Excel (Foody vira conferência); nada é somado duas vezes", () => {
    const r = base([fech("2026-11-01", 1, "CONSOLIDADO", T(3, 23, 18))]);
    const d1 = r.dias[0];
    assert.equal(d1.fonte, FONTE.EXCEL);
    assert.deepEqual([d1.pedidos, d1.taxaBruta, d1.taxaValida], [3, 23, 18]);
    assert.deepEqual(d1.foodyIgnorado, { versao: 1, status: "CONSOLIDADO" });
    assert.equal(r.totais.diasComAsDuasFontes, 1);
    assert.equal(r.totais.pedidos, 3, "não 6");
    assert.equal(r.totais.taxaBruta, 23, "não 46");
  });
  test("dia só com Foody completo entra; INCOMPLETO aparece fora do total; sem nada = SEM_DADOS", () => {
    const r = base([fech("2026-11-02", 1, "CONSOLIDADO", T(4, 40, 30)), fech("2026-11-03", 1, "INCOMPLETO", T(9, 90, 90))]);
    assert.deepEqual(r.dias.map((d) => d.fonte), [FONTE.EXCEL, FONTE.FOODY, FONTE.FOODY_INCOMPLETO, FONTE.SEM_DADOS]);
    assert.deepEqual(r.totais.dias, { excel: 1, foody: 1, foodyPendente: 0, foodyIncompleto: 1, semDados: 1 });
    assert.equal(r.totais.diasForaDoTotal, 1);
    assert.equal(r.totais.pedidos, 3 + 4);
    assert.equal(r.totais.taxaBruta, 23 + 40);
    assert.equal(r.totais.taxaValida, 18 + 30);
  });
  test("só a ÚLTIMA versão do fechamento conta (versões antigas são histórico)", () => {
    const r = base([fech("2026-11-02", 1, "CONSOLIDADO", T(4, 40, 30)), fech("2026-11-02", 2, "CORRIGIDO", T(5, 50, 45))]);
    assert.deepEqual([r.dias[1].versao, r.dias[1].pedidos, r.dias[1].taxaValida], [2, 5, 45]);
    assert.equal(ultimaVersaoPorDia([{ competencia: "2026-11-02", versao: 3 }, { competencia: "2026-11-02", versao: 1 }]).get("2026-11-02").versao, 3);
  });
  test("quatro grandezas: atribuído só quando tudo é Foody; custo real só quando tudo é Excel", () => {
    const misto = base([fech("2026-11-02", 1, "CONSOLIDADO", T(4, 40, 30))], { total: 99 });
    assert.equal(misto.totais.custoLogisticoAtribuido, null, "Excel não distingue o tipo de entregador");
    assert.equal(misto.totais.custoRealConciliado, null, "misturaria fontes");
    assert.equal(misto.dias[1].custoLogisticoAtribuido, 29);
    const soExcel = base([], { total: 31.5 });
    assert.equal(soExcel.totais.custoRealConciliado, 31.5);
    const soFoody = resolverFontePorDia({ de: "2026-11-02", ate: "2026-11-02", excel: { pedidosElegiveis: [], todos: [], resumoPorDia: resumoConciliacao },
      fechamentos: [fech("2026-11-02", 1, "CONSOLIDADO", T(4, 40, 30))] });
    assert.equal(soFoody.totais.custoLogisticoAtribuido, 29);
    assert.equal(soFoody.totais.custoRealConciliado, null);
  });
  test("dia com Excel só de outra operação/sem entregador ainda é dia do Excel (Foody não preenche o buraco)", () => {
    const r = resolverFontePorDia({ de: "2026-11-02", ate: "2026-11-02", excel: { pedidosElegiveis: [], todos: [pedido("2026-11-02", 7, { operacao: "acai_no_grau" })], resumoPorDia: resumoConciliacao },
      fechamentos: [fech("2026-11-02", 1, "CONSOLIDADO", T(4, 40, 30))] });
    assert.equal(r.dias[0].fonte, FONTE.EXCEL);
    assert.equal(r.totais.pedidos, 0);
  });
  test("distância é complemento do Excel; dia Foody marca distanciaDisponivel=false", () => {
    const r = base([fech("2026-11-02", 1, "CONSOLIDADO", T(4, 40, 30))], null, [pedido("2026-11-01", 3, { distanciaRaioKm: 2.5 })]);
    assert.equal(r.dias[0].distanciaDisponivel, true);
    assert.equal(r.dias[1].distanciaDisponivel, false);
    assert.equal(r.totais.valoresProvisorios, false);
  });
  test("pendência nunca entra no total: PRELIMINAR e CORRIGIDO/PROVISORIO viram FOODY_PENDENTE com os códigos", () => {
    const r = base([
      fech("2026-11-02", 1, "PRELIMINAR", T(4, 40, 30), { estado_valores: "PROVISORIO", pendencias: [{ codigo: "TRIAGEM_PENDENTE", quantidade: 2 }] }),
      fech("2026-11-03", 2, "CORRIGIDO", T(6, 60, 50), { estado_valores: "PROVISORIO", pendencias: [{ codigo: "CANCELAMENTO_EM_REVISAO" }] }),
      fech("2026-11-04", 1, "CONSOLIDADO", T(1, 10, 10), { estado_valores: "PROVISORIO" }),
    ]);
    assert.deepEqual(r.dias.map((d) => d.fonte), [FONTE.EXCEL, FONTE.FOODY_PENDENTE, FONTE.FOODY_PENDENTE, FONTE.FOODY_PENDENTE]);
    assert.deepEqual(r.dias[1].pendencias, ["TRIAGEM_PENDENTE"]); assert.deepEqual(r.dias[2].pendencias, ["CANCELAMENTO_EM_REVISAO"]);
    assert.deepEqual(r.totais.dias, { excel: 1, foody: 0, foodyPendente: 3, foodyIncompleto: 0, semDados: 0 });
    assert.equal(r.totais.pedidos, 3, "só o Excel"); assert.equal(r.totais.taxaBruta, 23); assert.equal(r.totais.diasForaDoTotal, 3);
    assert.equal(r.totais.valoresProvisorios, false, "nenhum provisório somado");
    assert.equal(r.totais.custoLogisticoAtribuido, null);
  });
  test("Açaí (tenant destino): usa o bloco da operação gravada no fechamento", () => {
    const r = resolverFontePorDia({ de: "2026-11-02", ate: "2026-11-02", operacao: "acai_no_grau", excel: { pedidosElegiveis: [], todos: [], resumoPorDia: resumoConciliacao },
      fechamentos: [{ competencia: "2026-11-02", versao: 1, status: "CONSOLIDADO", estado_valores: "SINCRONIZADO",
        indicadores: { operacao: "acai_no_grau", acai_no_grau: { total: T(2, 14, 14), custoLogisticoProprio: 14 } } }] });
    assert.deepEqual([r.dias[0].pedidos, r.dias[0].taxaBruta], [2, 14]);
  });
});

describe("ponte do Parser (parserFoodDelivery.foody.js)", () => {
  const dbFalso = (linhas, erro = null) => { const chamadas = []; const b = { chamadas, from(t) { chamadas.push(t); return b; }, select() { return b; }, eq(k, v) { chamadas.push([k, v]); return b; },
    gte() { return b; }, lte() { return b; }, order() { return b; }, limit: async () => ({ data: linhas, error: erro }) }; return b; };
  const args = (db, env) => ({ db, env, organizacaoId: ORG, unidadeId: UNI, dataInicio: "2026-11-01", dataFim: "2026-11-02",
    pedidosElegiveis: [], todos: [], resumoPorDia: resumoConciliacao, custoReal: null });
  test("flag desligada (ou unidade fora da lista): null e NENHUMA consulta", async () => {
    for (const env of [{}, { FOODY_CENTRAL_PARSER_ENABLED: "true" }, { FOODY_CENTRAL_PARSER_ENABLED: "true", FOODY_CENTRAL_PARSER_UNIDADES: OUTRA },
      { FOODY_CENTRAL_PARSER_ENABLED: "1", FOODY_CENTRAL_PARSER_UNIDADES: UNI }]) {
      const db = dbFalso([]);
      assert.equal(await carregarFonteLogistica(args(db, env)), null);
      assert.deepEqual(db.chamadas, []);
    }
    assert.equal(fonteFoodyNoParserPermitida({ FOODY_CENTRAL_PARSER_ENABLED: "true", FOODY_CENTRAL_PARSER_UNIDADES: `${OUTRA}, ${UNI}` }, UNI), true);
  });
  const ON = { FOODY_CENTRAL_PARSER_ENABLED: "true", FOODY_CENTRAL_PARSER_UNIDADES: UNI };
  test("ligada: lê só fechamentos da organização+unidade do contexto", async () => {
    const db = dbFalso([fech("2026-11-02", 1, "CONSOLIDADO", T(4, 40, 30))]);
    const r = await carregarFonteLogistica(args(db, ON));
    assert.deepEqual(db.chamadas, ["foody_fechamentos_logisticos", ["organizacao_id", ORG], ["unidade_id", UNI]]);
    assert.equal(r.dias[1].fonte, FONTE.FOODY);
  });
  test("linha de outro tenant ou erro de banco: bloco com erro, Parser segue", async () => {
    assert.deepEqual(await carregarFonteLogistica(args(dbFalso([{ ...fech("2026-11-02", 1, "CONSOLIDADO", T(1, 1, 1)), unidade_id: OUTRA }]), ON)), { erro: "FONTE_FOODY_TENANT_DIVERGENTE" });
    assert.deepEqual(await carregarFonteLogistica(args(dbFalso(null, { message: "x" }), ON)), { erro: "FONTE_FOODY_INDISPONIVEL" });
    const quebra = { from() { throw new Error("rede"); } };
    assert.deepEqual(await carregarFonteLogistica(args(quebra, ON)), { erro: "FONTE_FOODY_INDISPONIVEL" });
  });
  test("estrutural: ponte só lê (select), só foody_fechamentos_logisticos, só importa o resolvedor puro", () => {
    const s = readFileSync(join(RAIZ, "src", "modules", "parser-food-delivery", "parserFoodDelivery.foody.js"), "utf8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(s, /\.(insert|update|upsert|delete|rpc)\(/);
    assert.deepEqual([...s.matchAll(/\.from\(\s*["'`]([\w.]+)["'`]/g)].map((m) => m[1]), ["foody_fechamentos_logisticos"]);
    assert.deepEqual([...s.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]), ["../foody/foody.fonte.js"]);
    const servico = readFileSync(join(RAIZ, "src", "modules", "parser-food-delivery", "parserFoodDelivery.service.js"), "utf8");
    assert.match(servico, /\.\.\.\(fonteLogistica \? \{ fonteLogistica \} : \{\}\),/, "bloco só aparece quando a ponte devolve algo");
    assert.equal((servico.match(/carregarFonteLogistica\(/g) ?? []).length, 1, "só em analisarPeriodo");
  });
});
