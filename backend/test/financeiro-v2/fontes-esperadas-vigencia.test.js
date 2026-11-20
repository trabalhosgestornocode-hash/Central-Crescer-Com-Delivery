// Relatórios ESPERADOS da competência derivados das fontes de faturamento REAIS da unidade (e da vigência histórica).
// Subway (SWF): nunca espera SAIPOS/Anota Aí. Açaí (SAIPOS): como sempre. Competência passada mantém o sistema que valia nela.
// Dados 100% sintéticos, em memória (ou Postgres de teste com FV2_REPOSITORIO=postgres).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO } from "../../src/modules/financeiro-v2/dominio/contexto.js";
import { esperadasDaCompetencia, fontesVigentesNaCompetencia } from "../../src/modules/financeiro-v2/dominio/conferencias.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ORG_A, ORG_B, UNI_A, UNI_A2, UNI_B, ctx, montar } from "./helpers/cenario.js";

const JUST = "configuração de teste";
const nomes = (lista) => lista.map((x) => x.tipoRelatorio).sort();
const configurar = async (n, c, fontes) => {
  await ESCRITAS["/configuracoes/unidade"].fazer(n, c, { nomeExibicao: "Unidade de teste", justificativa: JUST }).catch(() => {});
  return n.configurarFontesDeFaturamento(c, { fontes, justificativa: JUST });
};
const esperados = async (n, c, competencia) => {
  const r = await CONSULTAS["/conferencias"](n, c, { competencia });
  return { semDocumento: nomes(r.fontes.semDocumento), comDocumento: nomes(r.fontes.comDocumento) };
};
const SAIPOS = ["SAIPOS_FATURAMENTO_POR_DIA", "SAIPOS_FORMAS_PAGAMENTO"];
const SWF = ["SWF_ANALISE_FATURAMENTO", "SWF_PAGAMENTOS"];
const COMUNS = ["STONE_VENDAS", "UNICRED_EXTRATO"];

test("unidade SEM configuração: padrão histórico (SAIPOS), exatamente como antes — nada de SWF", async () => {
  const n = montar().nucleo;
  const { semDocumento } = await esperados(n, ctx(ORG_A, UNI_A), "2026-10");
  assert.deepEqual(semDocumento, [...SAIPOS, ...COMUNS].sort());
});

test("Subway (SWF): espera SWF 45/03 + Stone/Unicred e NUNCA SAIPOS; o Açaí e outra organização não mudam", async () => {
  const n = montar().nucleo;
  await configurar(n, ctx(ORG_A, UNI_A2), ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  const sub = await esperados(n, ctx(ORG_A, UNI_A2), "2026-10");
  assert.deepEqual(sub.semDocumento, [...SWF, ...COMUNS].sort());
  assert.ok(!JSON.stringify(sub).includes("SAIPOS"), "nenhuma pendência SAIPOS na Subway");
  // a Central e as pendências da Subway também não citam SAIPOS/Anota Aí nos itens de relatório faltante
  const pend = await CONSULTAS["/conferencias/pendencias"](n, ctx(ORG_A, UNI_A2), { competencia: "2026-10" });
  const faltantes = (pend.itens ?? pend.pendencias ?? []).filter((p) => p.codigo === "FONTE_SEM_DOCUMENTO");
  assert.ok(faltantes.length > 0 && faltantes.every((p) => !/SAIPOS|Anota/i.test(`${p.titulo} ${p.motivo}`)), "pendências de relatório faltante da Subway são só SWF/Stone/Unicred");
  // isolamento: a unidade irmã (SEM configuração própria) e outra organização seguem no SAIPOS
  assert.deepEqual((await esperados(n, ctx(ORG_A, UNI_A), "2026-10")).semDocumento, [...SAIPOS, ...COMUNS].sort());
  await configurar(n, ctx(ORG_B, UNI_B), ["SAIPOS", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  assert.deepEqual((await esperados(n, ctx(ORG_B, UNI_B), "2026-10")).semDocumento, [...SAIPOS, ...COMUNS].sort());
});

test("Açaí configurado explicitamente com SAIPOS + iFood + 99Food: segue esperando SAIPOS (Presencial e Anota Aí vêm do mesmo relatório)", async () => {
  const n = montar().nucleo;
  await configurar(n, ctx(ORG_A, UNI_A), ["SAIPOS", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  assert.deepEqual((await esperados(n, ctx(ORG_A, UNI_A), "2026-10")).semDocumento, [...SAIPOS, ...COMUNS].sort());
});

test("vigência histórica: competência passada mantém o sistema que valia nela; a troca vale a partir de quando foi gravada", async () => {
  let agora = new Date("2026-10-15T15:00:00.000Z");
  const n = montar({ relogio: () => agora }).nucleo;
  const c = ctx(ORG_A, UNI_A);
  await configurar(n, c, ["SAIPOS", "IFOOD", "NOVENTA_E_NOVE_FOOD"]); // 15/10/2026: SAIPOS
  agora = new Date("2026-12-10T15:00:00.000Z");
  await configurar(n, c, ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"]); // 10/12/2026: passa a SWF
  agora = new Date("2026-12-20T15:00:00.000Z");
  assert.deepEqual((await esperados(n, c, "2026-10")).semDocumento, [...SAIPOS, ...COMUNS].sort(), "outubro: SAIPOS (histórico preservado)");
  assert.deepEqual((await esperados(n, c, "2026-11")).semDocumento, [...SAIPOS, ...COMUNS].sort(), "novembro terminou antes da troca: SAIPOS");
  assert.deepEqual((await esperados(n, c, "2026-12")).semDocumento, [...SWF, ...COMUNS].sort(), "dezembro (troca em 10/12, competência termina depois): SWF");
  assert.deepEqual((await esperados(n, c, "2027-01")).semDocumento, [...SWF, ...COMUNS].sort());
});

test("a configuração da Subway vale desde sempre: competências anteriores à gravação também não esperam SAIPOS", async () => {
  let agora = new Date("2026-11-19T15:00:00.000Z");
  const n = montar({ relogio: () => agora }).nucleo;
  const c = ctx(ORG_A, UNI_A2);
  await configurar(n, c, ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  for (const comp of ["2026-08", "2026-09", "2026-10", "2026-11"]) assert.ok(!JSON.stringify(await esperados(n, c, comp)).includes("SAIPOS"), comp);
});

test("domínio puro: sem vigências = padrão; vigência por competência; SWF só quando em vigor", () => {
  assert.deepEqual(fontesVigentesNaCompetencia({}, "2026-10"), ["SAIPOS", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  assert.deepEqual(nomes(esperadasDaCompetencia({}, "2026-10")), [...SAIPOS, ...COMUNS].sort());
  const d = { vigenciasDeFontes: [{ desde: null, fontes: ["SAIPOS", "IFOOD"] }, { desde: "2026-12-10", fontes: ["SWF", "IFOOD"] }] };
  assert.deepEqual(fontesVigentesNaCompetencia(d, "2026-11"), ["SAIPOS", "IFOOD"]);
  assert.deepEqual(fontesVigentesNaCompetencia(d, "2026-12"), ["SWF", "IFOOD"]);
  assert.deepEqual(nomes(esperadasDaCompetencia(d, "2026-12")), [...SWF, ...COMUNS].sort());
});

test("nada de valor/receita/DRE é tocado: a apuração da Subway é idêntica com ou sem a configuração de fontes esperadas", async () => {
  const n = montar().nucleo;
  const c = ctx(ORG_A, UNI_A2, [ACAO.VER]);
  const apurar = async () => JSON.stringify([await CONSULTAS["/dre"](n, c, { competencia: "2026-10" }), await CONSULTAS["/visao-geral"](n, c, { competencia: "2026-10" })]);
  const antes = await apurar();
  await configurar(n, ctx(ORG_A, UNI_A2), ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  const depois = await apurar();
  assert.equal(depois, antes);
});
