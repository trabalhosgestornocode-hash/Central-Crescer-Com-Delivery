// Relatórios ESPERADOS da competência derivados da configuração REAL da unidade: fontes (com vigência histórica), operadoras e contas.
// Subway (SWF): nunca espera SAIPOS/Anota Aí; Stone/Unicred só com operadora/conta configurada. Unidade sem configuração: como sempre.
// São CONTROLES DOCUMENTAIS: nunca bloqueiam a homologação. Dados 100% sintéticos (memória, ou Postgres de teste com FV2_REPOSITORIO=postgres).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO } from "../../src/modules/financeiro-v2/dominio/contexto.js";
import { esperadasDaCompetencia, fontesVigentesNaCompetencia } from "../../src/modules/financeiro-v2/dominio/conferencias.js";
import { EFEITO_NO_RESULTADO, EFEITO_POR_CODIGO } from "../../src/modules/financeiro-v2/dominio/ressalvas.js";
import { CONSULTAS } from "../../src/modules/fv2-integracao/consultas.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ORG_A, ORG_B, UNI_A, UNI_A2, UNI_B, ctx, montar } from "./helpers/cenario.js";

const JUST = "configuração de teste";
const nomes = (lista) => lista.map((x) => x.tipoRelatorio).sort();
const configurar = async (n, c, fontes) => {
  await ESCRITAS["/configuracoes/unidade"].fazer(n, c, { nomeExibicao: "Unidade de teste", justificativa: JUST }).catch(() => {});
  return n.configurarFontesDeFaturamento(c, { fontes, justificativa: JUST });
};
const stone = (n, c, extra = {}) => n.registrarOperadora(c, { codigo: "STONE", nome: "Stone", processador: "STONE", inicio: "2026-01-01", modalidades: ["DEBITO"], justificativa: JUST, ...extra });
const unicred = (n, c) => n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Conta Unicred", instituicao: "Unicred" });
const esperados = async (n, c, competencia) => nomes((await CONSULTAS["/conferencias"](n, c, { competencia })).fontes.semDocumento);
const faltantesDe = async (n, c, competencia) => {
  const pend = await CONSULTAS["/conferencias/pendencias"](n, c, { competencia });
  return (pend.itens ?? pend.pendencias ?? []).filter((p) => p.codigo === "FONTE_SEM_DOCUMENTO");
};
const SAIPOS = ["SAIPOS_FATURAMENTO_POR_DIA", "SAIPOS_FORMAS_PAGAMENTO"];
const SWF = ["SWF_ANALISE_FATURAMENTO", "SWF_PAGAMENTOS"];
const COMUNS = ["STONE_VENDAS", "UNICRED_EXTRATO"];
const ord = (...l) => l.flat().sort();

test("unidade SEM configuração: padrão histórico, exatamente como antes (SAIPOS + Stone + Unicred), mesmo sem operadora/conta", async () => {
  const n = montar().nucleo;
  assert.deepEqual(await esperados(n, ctx(ORG_A, UNI_A), "2026-10"), ord(SAIPOS, COMUNS));
});

test("Subway (SWF) com operadora não-Stone e banco não-Unicred: espera SÓ o SWF 45/03 — nada de SAIPOS, Stone ou Unicred", async () => {
  const n = montar().nucleo;
  const c = ctx(ORG_A, UNI_A2);
  await configurar(n, c, ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  await n.registrarOperadora(c, { codigo: "PAGBANK", nome: "PagBank", processador: "PAGBANK", inicio: "2026-01-01", modalidades: ["DEBITO"], justificativa: JUST });
  await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Outro banco", instituicao: "Outro" });
  assert.deepEqual(await esperados(n, c, "2026-10"), ord(SWF));
  const faltantes = await faltantesDe(n, c, "2026-10");
  assert.equal(faltantes.length, 2);
  assert.ok(faltantes.every((p) => !/SAIPOS|Anota|Stone|Unicred/i.test(`${p.titulo} ${p.motivo}`)));
});

test("Subway com operadora Stone e conta Unicred: passa a esperar Stone e Unicred; operadora encerrada antes da competência não conta", async () => {
  const n = montar().nucleo;
  const c = ctx(ORG_A, UNI_A2);
  await configurar(n, c, ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  await stone(n, c, { encerramento: "2026-09-30" });
  await n.registrarOperadora(c, { codigo: "PAGBANK", nome: "PagBank", processador: "PAGBANK", inicio: "2026-10-01", modalidades: ["DEBITO"], justificativa: JUST });
  assert.deepEqual(await esperados(n, c, "2026-10"), ord(SWF), "fontes configuradas: sem conta Unicred não há Unicred; Stone encerrada em 30/09 não é esperada em outubro (troca para PagBank)");
  assert.deepEqual(await esperados(n, c, "2026-09"), ord(SWF, "STONE_VENDAS"), "em setembro a Stone estava ativa");
  await unicred(n, c);
  assert.deepEqual(await esperados(n, c, "2026-10"), ord(SWF, "UNICRED_EXTRATO"));
});

test("isolamento: configurar a Subway não muda a unidade irmã nem outra organização", async () => {
  const n = montar().nucleo;
  await configurar(n, ctx(ORG_A, UNI_A2), ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  await stone(n, ctx(ORG_A, UNI_A2));
  assert.deepEqual(await esperados(n, ctx(ORG_A, UNI_A), "2026-10"), ord(SAIPOS, COMUNS));
  await configurar(n, ctx(ORG_B, UNI_B), ["SAIPOS", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  await stone(n, ctx(ORG_B, UNI_B));
  await unicred(n, ctx(ORG_B, UNI_B));
  assert.deepEqual(await esperados(n, ctx(ORG_B, UNI_B), "2026-10"), ord(SAIPOS, COMUNS));
});

test("Açaí configurado (SAIPOS) com Stone e Unicred: segue esperando SAIPOS + Stone + Unicred", async () => {
  const n = montar().nucleo;
  const c = ctx(ORG_A, UNI_A);
  await configurar(n, c, ["SAIPOS", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  await stone(n, c);
  await unicred(n, c);
  assert.deepEqual(await esperados(n, c, "2026-10"), ord(SAIPOS, COMUNS));
});

test("vigência histórica: competência passada mantém o sistema que valia nela; a troca vale a partir de quando foi gravada", async () => {
  let agora = new Date("2026-10-15T15:00:00.000Z");
  const n = montar({ relogio: () => agora }).nucleo;
  const c = ctx(ORG_A, UNI_A);
  await configurar(n, c, ["SAIPOS", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  await stone(n, c);
  await unicred(n, c);
  agora = new Date("2026-12-10T15:00:00.000Z");
  await configurar(n, c, ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  agora = new Date("2026-12-20T15:00:00.000Z");
  assert.deepEqual(await esperados(n, c, "2026-10"), ord(SAIPOS, COMUNS));
  assert.deepEqual(await esperados(n, c, "2026-11"), ord(SAIPOS, COMUNS));
  assert.deepEqual(await esperados(n, c, "2026-12"), ord(SWF, COMUNS));
});

test("como em produção (19/11): Subway com SWF+iFood+99Food, sem operadora e com conta Unicred → SWF 45/03 + Unicred, nada de SAIPOS nem Stone, desde sempre", async () => {
  const n = montar({ relogio: () => new Date("2026-11-19T15:00:00.000Z") }).nucleo;
  const c = ctx(ORG_A, UNI_A2);
  await configurar(n, c, ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  await unicred(n, c);
  for (const comp of ["2026-08", "2026-09", "2026-10", "2026-11"]) assert.deepEqual(await esperados(n, c, comp), ord(SWF, "UNICRED_EXTRATO"), comp);
});

test("como em produção: Açaí sem fontes gravadas, Stone encerrada em 16/11 e PagBank desde 17/11 → SAIPOS sempre; Stone até novembro, não em dezembro", async () => {
  const n = montar({ relogio: () => new Date("2026-12-05T15:00:00.000Z") }).nucleo;
  const c = ctx(ORG_A, UNI_A);
  await ESCRITAS["/configuracoes/unidade"].fazer(n, c, { nomeExibicao: "Açaí sintético", justificativa: JUST });
  await stone(n, c, { encerramento: "2026-11-16" });
  await n.registrarOperadora(c, { codigo: "PAGBANK", nome: "PagBank", processador: "PAGBANK", inicio: "2026-11-17", modalidades: ["DEBITO"], justificativa: JUST });
  await unicred(n, c);
  assert.deepEqual(await esperados(n, c, "2026-11"), ord(SAIPOS, COMUNS));
  assert.deepEqual(await esperados(n, c, "2026-12"), ord(SAIPOS, "UNICRED_EXTRATO"));
});

test("SWF 45/03 faltando são controles documentais: sem efeito no fechamento e fora dos impedimentos de homologação", async () => {
  assert.equal(EFEITO_POR_CODIGO.FONTE_SEM_DOCUMENTO, EFEITO_NO_RESULTADO.SEM_EFEITO);
  const n = montar().nucleo;
  const c = ctx(ORG_A, UNI_A2);
  await configurar(n, c, ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  const faltantes = await faltantesDe(n, c, "2026-10");
  assert.ok(faltantes.length > 0);
  for (const p of faltantes) assert.notEqual(p.efeitoNoFechamento, "BLOQUEIA", p.titulo);
  const fech = await CONSULTAS["/conferencias/fechamento"](n, c, { competencia: "2026-10" });
  assert.ok(!JSON.stringify(fech.impedimentos ?? fech.fechamento?.impedimentos ?? []).includes("FONTE_SEM_DOCUMENTO"));
});

test("domínio puro: sem vigências = padrão; vigência por competência; Stone/Unicred só configurados", () => {
  assert.deepEqual(fontesVigentesNaCompetencia({}, "2026-10"), ["SAIPOS", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  assert.deepEqual(nomes(esperadasDaCompetencia({}, "2026-10")), ord(SAIPOS, COMUNS));
  const d = { vigenciasDeFontes: [{ desde: null, fontes: ["SAIPOS", "IFOOD"] }, { desde: "2026-12-10", fontes: ["SWF", "IFOOD"] }], operadorasDaUnidade: [], contas: [] };
  assert.deepEqual(fontesVigentesNaCompetencia(d, "2026-11"), ["SAIPOS", "IFOOD"]);
  assert.deepEqual(nomes(esperadasDaCompetencia(d, "2026-12")), ord(SWF));
  assert.deepEqual(nomes(esperadasDaCompetencia({ operadorasDaUnidade: [], contas: [] }, "2026-12")), ord(SAIPOS, COMUNS), "nada configurado: padrão histórico");
  assert.deepEqual(nomes(esperadasDaCompetencia({ operadorasDaUnidade: [{ processador: "PAGBANK", inicio: "2026-01-01" }], contas: [] }, "2026-12")), ord(SAIPOS, "UNICRED_EXTRATO"), "só operadoras configuradas: Stone pela operadora; Unicred pelo padrão");
  const d2 = { ...d, operadorasDaUnidade: [{ processador: "STONE", situacao: "INATIVA", inicio: "2026-01-01" }], contas: [{ tipo: "BANCARIA", nome: "Outro" }, { tipo: "CAIXA_FISICO", nome: "Unicred caixa" }] };
  assert.deepEqual(nomes(esperadasDaCompetencia(d2, "2026-12")), ord(SWF), "operadora inativa e conta Unicred que não é bancária não contam");
});

test("nada de valor/receita/DRE é tocado: DRE e Visão Geral idênticas com ou sem a configuração", async () => {
  const n = montar().nucleo;
  const c = ctx(ORG_A, UNI_A2, [ACAO.VER]);
  const apurar = async () => JSON.stringify([await CONSULTAS["/dre"](n, c, { competencia: "2026-10" }), await CONSULTAS["/visao-geral"](n, c, { competencia: "2026-10" })]);
  const antes = await apurar();
  await configurar(n, ctx(ORG_A, UNI_A2), ["SWF", "IFOOD", "NOVENTA_E_NOVE_FOOD"]);
  assert.equal(await apurar(), antes);
});
