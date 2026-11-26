// Conferência OPCIONAL com a planilha real de um mentorado (só local — o repositório é público, então nem o arquivo
// nem os valores de referência ficam no código). Sem as variáveis, o teste é PULADO (não é falha).
//
//   NUCLEO_PLANILHA_REFERENCIA = caminho do .xlsx
//   NUCLEO_REFERENCIA_JSON     = {"entrada":"AAAA-MM","antes":{"vendas":..,"taxas":..,"servicos":..},
//                                 "durante":{"vendas":..,"taxas":..,"servicos":..},
//                                 "crescimentoPct":..,"participacaoAntesPct":..,"participacaoDurantePct":..,"reducaoPp":..}
//
// Rodar: node --test test/nucleo-mentorados/referencia-real.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { lerPlanilhaHistorico } from "../../src/modules/nucleo-mentorados/leitorPlanilha.js";
import * as C from "../../src/modules/nucleo-mentorados/calc.js";

const caminho = process.env.NUCLEO_PLANILHA_REFERENCIA;
const ref = process.env.NUCLEO_REFERENCIA_JSON ? JSON.parse(process.env.NUCLEO_REFERENCIA_JSON) : null;
const pular = !caminho || !ref ? "NUCLEO_PLANILHA_REFERENCIA/NUCLEO_REFERENCIA_JSON ausentes — PULADO" : !existsSync(caminho) ? "planilha não encontrada — PULADO" : false;

test("planilha real reproduz os números de referência do mentor", { skip: pular }, () => {
  const lido = lerPlanilhaHistorico(readFileSync(caminho), { arquivoNome: caminho });
  const serie = C.consolidarSerie({ importacao: lido.meses.map(C.mesDaImportacao) }).meses;
  const p = C.periodosDaMentoria({ dataEntrada: ref.entrada, ultimoMesFechado: serie.at(-1).mes });
  const antes = C.agregar(serie, p.antes.inicio, p.antes.fim);
  const dur = C.agregar(serie, p.ciclos[0].inicio, p.ciclos[0].fim);
  const r$ = (c) => c / 100;
  assert.equal(r$(antes.totais.valorVendas.total), ref.antes.vendas);
  assert.equal(r$(antes.totais.taxasComissoes.total), ref.antes.taxas);
  assert.equal(r$(antes.totais.servicosPromocoes.total), ref.antes.servicos);
  assert.equal(r$(dur.totais.valorVendas.total), ref.durante.vendas);
  assert.equal(r$(dur.totais.taxasComissoes.total), ref.durante.taxas);
  assert.equal(r$(dur.totais.servicosPromocoes.total), ref.durante.servicos);
  const ind = C.comparar(dur, antes);
  assert.equal(ind.find((i) => i.chave === "valorVendas").variacaoPercentual.toFixed(2), ref.crescimentoPct.toFixed(2));
  const ts = ind.find((i) => i.chave === "pctTaxasMaisServicos");
  assert.equal(ts.referencia.toFixed(2), ref.participacaoAntesPct.toFixed(2));
  assert.equal(ts.atual.toFixed(2), ref.participacaoDurantePct.toFixed(2));
  assert.equal(ts.pontosPercentuais.toFixed(2), ref.reducaoPp.toFixed(2));
});
