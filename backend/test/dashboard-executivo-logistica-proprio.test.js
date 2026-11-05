// Dashboard Executivo × logística própria Foody — bloco informativo atrás de flag (desligada por padrão).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { montarLogisticaProprio, logisticaProprioOpcional, logisticaProprioNoDashboardPermitida } =
  await import("../src/modules/dashboard-executivo/dashboardExecutivo.logisticaProprio.js");

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORG = "00000000-0000-0000-0000-000000000001", UNI = "00000000-0000-0000-0000-0000000000a1";
const ORG_A = "e7216085-1ece-45dc-bc41-d74f11a88e40", UNI_A = "4d3b75bd-79b5-4335-ae5b-a183580c3555";
const ON = { FOODY_CENTRAL_DASHBOARD_ENABLED: "true", FOODY_CENTRAL_DASHBOARD_UNIDADES: UNI };

// Valores FICTÍCIOS no formato dos fechamentos (Subway), reduzidos ao que o bloco lê.
const f = (competencia, versao, status, estado, custo, prevista, entregues, org = ORG, uni = UNI) => ({
  organizacao_id: org, unidade_id: uni, competencia, versao, status, estado_valores: estado,
  indicadores: { operacao: "subway", subway: { custoLogisticoProprio: custo, taxasPrevistasSemEntregador: prevista, proprio: { pedidos: entregues, entregues } } },
});
const SUBWAY = [
  f("2026-10-31", 1, "PRELIMINAR", "PROVISORIO", 701, 202, 80), f("2026-10-31", 2, "CONSOLIDADO", "SINCRONIZADO", 740, 210, 85),
  f("2026-11-01", 1, "PRELIMINAR", "PROVISORIO", 478, 209, 60), f("2026-11-01", 2, "CONSOLIDADO", "SINCRONIZADO", 486, 216, 65),
  f("2026-11-03", 1, "PRELIMINAR", "PROVISORIO", 303, 114, 35),
  f("2026-11-04", 1, "CONSOLIDADO", "SINCRONIZADO", 406, 209, 50),
];

describe("flag", () => {
  test("desligada por padrão: nada é lido e a resposta fica idêntica", async () => {
    let leituras = 0;
    for (const env of [{}, { FOODY_CENTRAL_DASHBOARD_ENABLED: "true" }, { FOODY_CENTRAL_DASHBOARD_UNIDADES: UNI }, { ...ON, FOODY_CENTRAL_DASHBOARD_ENABLED: "false" }]) {
      const r = await logisticaProprioOpcional({ env, organizacaoId: ORG, unidadeId: UNI, de: "2026-11-01", ate: "2026-11-30", ler: async () => { leituras++; return []; } });
      assert.deepEqual(r, {});
    }
    assert.equal(leituras, 0);
  });
  test("só unidades da allowlist", () => {
    assert.equal(logisticaProprioNoDashboardPermitida(ON, UNI), true);
    assert.equal(logisticaProprioNoDashboardPermitida(ON, UNI_A), false);
    assert.equal(logisticaProprioNoDashboardPermitida({ ...ON, FOODY_CENTRAL_DASHBOARD_UNIDADES: "lixo" }, UNI), false);
  });
});

describe("cálculo", () => {
  test("usa só a última versão e só dias definitivos; pendente fica fora dos valores", () => {
    const b = montarLogisticaProprio({ fechamentos: SUBWAY, de: "2026-10-31", ate: "2026-11-04", modeloLogistico: "marketplace" });
    assert.equal(b.custoAtribuido, 740 + 486 + 406); // 31/10 v2 + 01/11 v2 + 04/11; 03/11 (PRELIMINAR) fora
    assert.equal(b.taxaPrevista, 210 + 216 + 209);
    assert.deepEqual(b.dias, { definitivos: 3, pendentes: 1, incompletos: 0 });
    assert.equal(b.parcial, true);
    assert.equal(b.entregasProprias, 85 + 65 + 50);
    assert.equal(b.custoMedioPorEntrega, Math.round((1632 / 200) * 100) / 100);
    assert.equal(b.modeloLogistico, "marketplace");
  });
  test("grandezas que não existem são null com motivo — nunca inventadas", () => {
    const b = montarLogisticaProprio({ fechamentos: SUBWAY, de: "2026-10-31", ate: "2026-11-04" });
    assert.equal(b.taxaCobradaCliente, null); assert.ok(b.taxaCobradaClienteMotivo);
    assert.equal(b.pagamentoConciliado, null); assert.ok(b.pagamentoConciliadoMotivo);
  });
  test("sem nenhum dia definitivo: valores null (não zero)", () => {
    const b = montarLogisticaProprio({ fechamentos: [SUBWAY[4]], de: "2026-11-03", ate: "2026-11-03" });
    assert.equal(b.custoAtribuido, null); assert.equal(b.taxaPrevista, null); assert.equal(b.custoMedioPorEntrega, null);
  });
  test("declara que não soma ao resultado oficial", () => {
    const b = montarLogisticaProprio({ fechamentos: SUBWAY, de: "2026-10-31", ate: "2026-11-04" });
    assert.equal(b.somadoAoResultadoOficial, false);
    assert.match(b.aviso, /Taxas de entregadores/);
  });
  test("respeita o período pedido", () => {
    const b = montarLogisticaProprio({ fechamentos: SUBWAY, de: "2026-11-01", ate: "2026-11-01" });
    assert.equal(b.custoAtribuido, 486);
  });
});

describe("isolamento e falha", () => {
  test("linha de outra organização/unidade → bloco com erro, nenhum valor", async () => {
    const r = await logisticaProprioOpcional({ env: ON, organizacaoId: ORG, unidadeId: UNI, de: "2026-10-01", ate: "2026-10-31",
      ler: async () => [...SUBWAY, f("2026-10-31", 2, "CONSOLIDADO", "SINCRONIZADO", 44, 5, 4, ORG_A, UNI_A)] });
    assert.deepEqual(r, { logisticaProprio: { erro: "FONTE_FOODY_TENANT_DIVERGENTE" } });
  });
  test("falha de leitura nunca derruba o Dashboard", async () => {
    const r = await logisticaProprioOpcional({ env: ON, organizacaoId: ORG, unidadeId: UNI, de: "2026-10-01", ate: "2026-10-31", ler: async () => { throw new Error("x"); } });
    assert.deepEqual(r, { logisticaProprio: { erro: "FONTE_FOODY_INDISPONIVEL" } });
  });
});

describe("arquitetura (regras oficiais intocadas)", () => {
  const src = (p) => readFileSync(join(RAIZ, p), "utf8");
  test("módulo não importa cálculo oficial nem escreve no banco", () => {
    const m = src("src/modules/dashboard-executivo/dashboardExecutivo.logisticaProprio.js");
    const imports = m.split("\n").filter((l) => l.trimStart().startsWith("import ")).join(" ");
    assert.doesNotMatch(imports, /dashboardExecutivo|calc|metas|rentabilidade|precos/);
    assert.doesNotMatch(m, /\.(insert|update|upsert|delete|rpc)\(/);
  });
  test("calc.js, metas e rentabilidade não referenciam o bloco", () => {
    for (const p of ["calc", "metas.service", "rentabilidade", "precos.service", "diagnostico"]) {
      assert.doesNotMatch(src(`src/modules/dashboard-executivo/dashboardExecutivo.${p}.js`), /logisticaProprio|foody/i, p);
    }
  });
  test("o service só acrescenta a chave opcional no fim da resposta mensal", () => {
    const s = src("src/modules/dashboard-executivo/dashboardExecutivo.service.js");
    assert.equal((s.match(/logisticaProprioOpcional\(/g) ?? []).length, 1);
  });
  test("o modelo logístico chega ao bloco como TEXTO do período (marketplace | full_service | misto), nunca objeto", () => {
    const s = src("src/modules/dashboard-executivo/dashboardExecutivo.service.js");
    assert.match(s, /modeloLogistico: typeof modelo\?\.modeloLogistico === "string" \? modelo\.modeloLogistico : null/);
    assert.doesNotMatch(s, /typeof modelo === "string"/);
  });
});

describe("ponte registrada no portão de arquitetura do Foody", () => {
  test("importa do módulo Foody APENAS foody.constants.js (sem sync, agendador, cliente ou repositório)", () => {
    const m = readFileSync(join(RAIZ, "src/modules/dashboard-executivo/dashboardExecutivo.logisticaProprio.js"), "utf8");
    const imports = [...m.matchAll(/from\s+["']([^"']+)["']/g)].map((x) => x[1]).filter((i) => i.includes("/foody/"));
    assert.deepEqual(imports, ["../foody/foody.constants.js"]);
  });
});
