// Integração F3 — PRÉVIA do Fechamento Mensal Visio (2 relatórios) + roteamento
// de obterMes(). Mesmo padrão de bonificacao-mensal-service.test.js: roda contra
// o Supabase configurado, SEMPRE numa unidade DE TESTE isolada (migration 041),
// e só quando o alvo é comprovadamente descartável (preflight-integracao).
//
// F4: a confirmação existe (congela a competência via RPC). Só funciona se a
// migration 075 estiver aplicada no ALVO de teste; sem ela o serviço devolve
// um erro claro ("não está disponível neste ambiente"). O fluxo transacional
// completo (confirmar → snapshot v1 → imutável → reabrir → refechar v2 →
// bloqueio de edição) é provado no nível de BANCO em migration-075.test.js
// (cenário D, contra um Postgres efêmero).
//
// Rodar: npm run test:integracao
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  processarImportacaoFechamentoMensal, obterMes, reabrirCompetencia, consolidarAcompanhamentoDiario,
} from "../src/modules/bonificacao-mensal/bonificacaoMensal.service.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";

const PULAR = motivoPularIntegracao();
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SACI_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SACI_UNIDADE_ID = "00000000-0000-0000-0000-0000000000b1"; // unidade de teste (migration 041)
const USUARIO = { id: null, nome: "teste automatizado (bonificacao-mensal-fechamento-mensal.test.js)" };
const ANO = 2099, MES = 3;

const b64 = (f) => readFileSync(join(FIXTURES, f)).toString("base64");
// visio-vendas.pdf = "Relatório de Vendas"; visio-loja.pdf = "Relatório de Produtos".
const payloadOk = (over = {}) => ({
  ano: ANO, mes: MES,
  vendas: { nomeArquivo: "visio-vendas.pdf", conteudoBase64: b64("visio-vendas.pdf") },
  produtos: { nomeArquivo: "visio-loja.pdf", conteudoBase64: b64("visio-loja.pdf") },
  produtosCanalConfirmado: true, periodoConfirmadoUsuario: true,
  ...over,
});

describe("F3 — prévia do Fechamento Mensal Visio", { skip: PULAR }, () => {
  test("2 PDFs válidos → prévia OK (não persiste), com resultado oficial canônico", async () => {
    const r = await processarImportacaoFechamentoMensal({
      organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO,
      payload: payloadOk(), confirmar: false,
    });
    assert.equal(r.persistido, false);
    assert.equal(r.competencia.ano, ANO);
    // VENDAS mensal → faturamento e ticket
    assert.equal(r.vendas.faturamento, 10655.71);
    assert.equal(r.vendas.ticketMedio, 47.57);
    assert.equal(r.vendas.quantidadeVendas, 224);
    assert.ok(Array.isArray(r.vendas.metodosPagamento) && r.vendas.metodosPagamento.length >= 1);
    // PRODUTOS mensal → mix
    assert.equal(r.produtos.sanduichesSaladas, 132);
    assert.equal(r.produtos.bebidas, 56);
    assert.equal(r.produtos.torque, 53.33);
    assert.equal(r.produtos.totalItens, 550);
    // resultado oficial canônico: faturamento/ticket do Vendas, mix do Produtos
    assert.equal(r.resultadoOficial.indicadores.faturamento.valorAtual, 10655.71);
    assert.equal(r.resultadoOficial.indicadores.ticket_medio.valorAtual, 47.57);
    assert.ok(Math.abs(r.resultadoOficial.indicadores.bebidas.valorAtual - (56 / 132) * 100) < 1e-6);
    assert.equal(r.resultadoOficial.indicadores.bebidas.fonte, "relatorio_mensal");
    assert.equal(r.resultadoOficial.indicadores.cmv.fonte, "manual");
    assert.equal(r.resultadoOficial.origem, "fechamento_mensal_direto");
    // classificação de acompanhamento — mês de teste vazio → SEM_ACOMPANHAMENTO
    assert.equal(r.acompanhamento.tipo, "SEM_ACOMPANHAMENTO");
    assert.equal(r.acompanhamento.diasComAcompanhamento, 0);
    // validação
    assert.ok(Array.isArray(r.validacao.bloqueios));
    assert.ok(Array.isArray(r.validacao.alertas));
  });

  test("consolidarAcompanhamentoDiario num mês SEM acompanhamento → recusado", async () => {
    await assert.rejects(
      () => consolidarAcompanhamentoDiario({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, ano: ANO, mes: MES }),
      (e) => { assert.match(e.message, /não tem acompanhamento diário|migration 075/i); return true; },
    );
  });

  test("faltando um PDF → bloqueio", async () => {
    await assert.rejects(
      () => processarImportacaoFechamentoMensal({
        organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO,
        payload: payloadOk({ vendas: undefined }), confirmar: false,
      }),
      (e) => { assert.match(e.message, /Relatório de Vendas/i); return true; },
    );
  });

  test("relatório trocado (Produtos no slot de Vendas) → bloqueio", async () => {
    await assert.rejects(
      () => processarImportacaoFechamentoMensal({
        organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO,
        payload: payloadOk({ vendas: { nomeArquivo: "visio-loja.pdf", conteudoBase64: b64("visio-loja.pdf") } }),
        confirmar: false,
      }),
      (e) => { assert.match(e.message, /relatório de produtos/i); return true; },
    );
  });

  test("checkbox de canal ausente → prontoParaConfirmar=false (bloqueio de confirmação)", async () => {
    const r = await processarImportacaoFechamentoMensal({
      organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO,
      payload: payloadOk({ produtosCanalConfirmado: false }), confirmar: false,
    });
    assert.equal(r.prontoParaConfirmar, false);
    assert.match(r.validacao.bloqueios.join(" "), /filtro Loja\/Balcão/);
  });

  test("confirmar → congela a competência (ou erro claro se a migration 075 não estiver no alvo)", async () => {
    try {
      const r = await processarImportacaoFechamentoMensal({
        organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO,
        payload: payloadOk(), confirmar: true,
      });
      // 075 aplicada no alvo → congelou
      assert.equal(r.persistido, true);
      assert.equal(r.competencia.status, "fechada");
      assert.ok(r.competencia.versao >= 1);
      // obterMes agora serve o snapshot congelado
      const mes = await obterMes({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, ano: ANO, mes: MES });
      assert.equal(mes.congelado, true);
      assert.equal(mes.podeEditarDiario, false);
      assert.equal(mes.origemResultado, "fechamento_mensal_direto");
      // reabrir volta ao cálculo ao vivo
      await reabrirCompetencia({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, ano: ANO, mes: MES, motivo: "teste automatizado" });
      const mes2 = await obterMes({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, ano: ANO, mes: MES });
      assert.equal(mes2.congelado, false);
      assert.equal(mes2.origemResultado, "ao_vivo");
    } catch (e) {
      // 075 NÃO aplicada no alvo → mensagem clara, nada persistido
      assert.match(e.message, /migration 075 não aplicada|não está disponível neste ambiente|não dá para confirmar/i);
    }
  });

  test("obterMes da unidade de teste → cálculo AO VIVO quando a competência está aberta", async () => {
    // (roda antes de qualquer confirmação, ou depois de reabrir)
    const comp = await obterMes({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, ano: ANO, mes: MES });
    if (comp.congelado) return; // um teste anterior deixou fechada — coberto acima
    assert.equal(comp.origemResultado, "ao_vivo");
    assert.equal(comp.podeEditarDiario, true);
    assert.equal(comp.fechamentoMensal, null);
    assert.ok(comp.indicadores && comp.resumo && comp.elegibilidade);
  });
});
