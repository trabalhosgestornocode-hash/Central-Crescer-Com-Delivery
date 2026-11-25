// §3 — SITUAÇÃO DA CONSULTA estruturada: zero real ≠ sem registros ≠ parcial ≠ bloqueado ≠ falha ≠ não calculável ≠ indisponível.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SITUACAO, contarRegistros, marcarFatos, situacaoDoCodigo, situacaoDoResultado } from "../../src/modules/mova-core/situacao.js";
import { verificarFidelidade } from "../../src/modules/mova-core/verificador.js";
import { CATALOGO } from "../../src/modules/mova-core/catalogo.js";

test("SI-01 o código decide a situação: listagem vazia ⇒ SEM_REGISTROS; registros com tudo zero ⇒ VALOR_ZERO; cobertura parcial ⇒ PARCIAL", () => {
  assert.equal(situacaoDoResultado({ dados: { itens: [], totais: { saldoCentavos: 0 } }, fatos: [{ valorCentavos: 0 }] }), SITUACAO.SEM_REGISTROS);
  assert.equal(situacaoDoResultado({ dados: { itens: [{ id: 1 }] }, fatos: [{ valorCentavos: 0, significado: "A_PAGAR_EM_ABERTO" }] }), SITUACAO.VALOR_ZERO);
  assert.equal(situacaoDoResultado({ dados: { itens: [{ id: 1 }] }, fatos: [{ valorCentavos: 54000 }] }), SITUACAO.COMPLETA);
  assert.equal(situacaoDoResultado({ dados: { linhas: [{}], cobertura: { completa: false } }, fatos: [] }), SITUACAO.PARCIAL);
  assert.equal(situacaoDoResultado({ situacao: "NAO_CALCULAVEL", dados: {} }), SITUACAO.NAO_CALCULAVEL, "a ferramenta pode declarar");
  assert.equal(contarRegistros({ tema: "x" }), null, "resultado que não é listagem não vira 'sem registros'");
});

test("SI-02 falhas viram situação: permissão ⇒ BLOQUEADO; rede/banco ⇒ FALHA_TECNICA; argumento inválido não é situação de dado", () => {
  assert.equal(situacaoDoCodigo("SEM_PERMISSAO_PARA_VALORES"), SITUACAO.BLOQUEADO);
  assert.equal(situacaoDoCodigo("FORA_DO_ESCOPO"), SITUACAO.BLOQUEADO);
  assert.equal(situacaoDoCodigo("FINANCEIRO_INDISPONIVEL"), SITUACAO.FALHA_TECNICA);
  assert.equal(situacaoDoCodigo("ARGUMENTO_INVALIDO"), null);
});

test("SI-03 verificador: 'R$ 0,00' apoiado só na soma de uma consulta SEM REGISTROS é reprovado; zero REAL (conta quitada) passa", () => {
  const vazio = marcarFatos([{ valorCentavos: 0, significado: "VALOR_DAS_CONTAS", entidade: "água" }], SITUACAO.SEM_REGISTROS);
  const r = verificarFidelidade("O gasto com água em novembro foi de R$ 0,00.", { fatos: vazio });
  assert.deepEqual(r.violacoes.map((v) => v.tipo), ["ZERO_SEM_REGISTRO"]);
  assert.ok(verificarFidelidade("Não encontrei conta de água em novembro.", { fatos: vazio }).ok);
  const quitada = marcarFatos([{ valorCentavos: 0, significado: "A_PAGAR_EM_ABERTO", entidade: "Joana Prado" }], SITUACAO.VALOR_ZERO);
  assert.ok(verificarFidelidade("Com a Joana Prado, em aberto: R$ 0,00.", { fatos: quitada }).ok);
});

test("SI-04 resultado_do_mes: linha pedida que a apuração não trouxe é NÃO CALCULÁVEL (não zero); presente passa", async () => {
  const cat = CATALOGO;
  const porta = { ler: async () => ({ metodologia: { nome: "DRE" }, indicadores: { F: { codigo: "FATURAMENTO_BRUTO_PROPRIO", nome: "Faturamento Bruto Próprio", valorCentavos: 6230000 } } }) };
  const r = await cat.resultado_do_mes.executar({ porta, escopo: {}, args: { competencia: "2026-11", indicadores: ["cmv"] } });
  assert.equal(r.situacao, "NAO_CALCULAVEL");
  assert.deepEqual(r.dados.indicadoresNaoCalculaveis, ["cmv"]);
  const ok = await cat.resultado_do_mes.executar({ porta, escopo: {}, args: { competencia: "2026-11", indicadores: ["faturamento bruto"] } });
  assert.equal(ok.situacao, undefined);
});
