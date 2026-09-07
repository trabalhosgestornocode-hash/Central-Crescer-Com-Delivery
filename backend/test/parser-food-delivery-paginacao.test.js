// Testes de regressão do bug de truncamento em 1000 linhas — PostgREST
// (`db.max_rows`, 1000 neste projeto) trunca silenciosamente qualquer
// select() em `parser_fd_pedidos` sem `.range()` explícito. Isso fazia a
// Visão Geral (recalculada em obterImportacao, lendo o banco de volta)
// divergir do Histórico (calculado em memória em confirmarImportacao, nunca
// lido de volta) para qualquer importação com mais de 1000 pedidos — caso
// real: detailed-report-1787664300148.xls, 1330 pedidos, Visão Geral
// mostrava R$6.709 em vez de R$8.608. Ver buscarTodosPedidos() em
// parserFoodDelivery.service.js.
//
// Roda contra o MESMO Supabase de produção (mesmo padrão de
// bonificacao-mensal-service.test.js: não existe banco de teste isolado
// pra este módulo) — usa a unidade DE TESTE dedicada (migration 041),
// NUNCA a unidade real da Subway Saci, e apaga tudo que cria ao final.
// Rodar: node --env-file=.env --test test/parser-food-delivery-paginacao.test.js
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
// Fase P0.4: esta suite exercita um service real; NAO roda contra producao.
const PULAR_INTEGRACAO = motivoPularIntegracao();
import { randomUUID } from "node:crypto";
import { supabase } from "../src/config/supabase.js";
import {
  obterImportacao, listarImportacoes, editarCodigosSemTaxa, alterarClassificacaoCancelamento, analisarPeriodo,
} from "../src/modules/parser-food-delivery/parserFoodDelivery.service.js";

const SACI_ORG_ID = "00000000-0000-0000-0000-000000000001";
// Unidade DE TESTE dedicada (migration 041) — NUNCA a unidade real da Subway
// Saci (00000000-0000-0000-0000-0000000000a1, a mesma do caso real investigado).
const UNIDADE_TESTE_ID = "00000000-0000-0000-0000-0000000000b1";
const USUARIO = { id: null, nome: "teste automatizado (parser-food-delivery-paginacao.test.js)" };
const TAXA_PADRAO = 10;

const importacoesCriadas = [];

/**
 * Cria uma importação sintética já "concluída" com N pedidos elegíveis
 * (Subway + com entregador, todos "Entregue", taxa fixa) — dispensa parsear
 * um arquivo real só para testar paginação. `situacaoCanceladaNoIndice`
 * marca UM pedido como cancelado (com entregador, mantendo a taxa por
 * padrão) para os testes de edição/override.
 */
async function criarImportacao(n, { prefixo, situacaoCanceladaNoIndice = null } = {}) {
  const id = randomUUID();
  const { error: eImp } = await supabase.from("parser_fd_importacoes").insert({
    id, organizacao_id: SACI_ORG_ID, unidade_id: UNIDADE_TESTE_ID,
    periodo_inicio: "2026-01-01", periodo_fim: "2026-01-07",
    nome_arquivo: `teste-paginacao-${prefixo}.xls`, hash_arquivo: `hash-${prefixo}-${id}`,
    total_pedidos: n, pedidos_subway: n, pedidos_acai: 0, pedidos_revisao: 0, pedidos_sem_entregador: 0,
    coluna_detalhes_encontrada: true,
    entregues: situacaoCanceladaNoIndice == null ? n : n - 1,
    cancelados: situacaoCanceladaNoIndice == null ? 0 : 1,
    cancelados_com_taxa: situacaoCanceladaNoIndice == null ? 0 : 1, cancelados_sem_taxa: 0,
    cancelados_recebem_taxa: 0, cancelados_nao_recebem_taxa: 0, cancelados_revisao: 0,
    taxas_brutas: TAXA_PADRAO * n, taxas_descartadas: 0, taxas_validas: TAXA_PADRAO * n,
    codigos_sem_taxa: [], status: "concluida", usuario_nome: USUARIO.nome,
  });
  if (eImp) throw new Error(`Falha ao criar importação de teste (${prefixo}): ${eImp.message}`);
  importacoesCriadas.push(id);

  let pedidoCanceladoId = null;
  const linhas = Array.from({ length: n }, (_, i) => {
    const cancelado = i === situacaoCanceladaNoIndice;
    const row = {
      id: randomUUID(),
      importacao_id: id, organizacao_id: SACI_ORG_ID, unidade_id: UNIDADE_TESTE_ID,
      numero_pedido: `${prefixo}-${i}`, data_hora: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      situacao: cancelado ? "Cancelado" : "Entregue", entregador: "Entregador Teste",
      taxa_entregador: TAXA_PADRAO, valor_total_pedido: 50,
      operacao: "subway", status_conciliacao: cancelado ? "cancelado_com_taxa" : "incluido",
      dados_brutos: { linha: i },
    };
    if (cancelado) pedidoCanceladoId = row.id;
    return row;
  });
  for (let i = 0; i < linhas.length; i += 500) {
    const { error } = await supabase.from("parser_fd_pedidos").insert(linhas.slice(i, i + 500));
    if (error) throw new Error(`Falha ao inserir pedidos de teste (${prefixo}, offset ${i}): ${error.message}`);
  }
  return { importacaoId: id, pedidoCanceladoId, numeroPedidoCancelado: situacaoCanceladaNoIndice == null ? null : `${prefixo}-${situacaoCanceladaNoIndice}` };
}

after(async () => {
  for (const id of importacoesCriadas) {
    await supabase.from("parser_fd_pedidos").delete().eq("importacao_id", id);
    await supabase.from("parser_fd_importacoes").delete().eq("id", id);
  }
});

// ---------------------------------------------------------------------------
// obterImportacao() — Visão Geral não pode mais truncar em 1000 linhas.
// 999/1000/1001 cobrem a fronteira EXATA do limite antigo (db.max_rows do
// PostgREST); 1300 reproduz a ordem de grandeza do caso real.
// ---------------------------------------------------------------------------
describe("obterImportacao() (Visão Geral) reflete TODOS os pedidos, não só os primeiros 1000", { skip: PULAR_INTEGRACAO }, () => {
  for (const n of [999, 1000, 1001, 1300]) {
    test(`importação com ${n} pedidos`, async () => {
      const { importacaoId } = await criarImportacao(n, { prefixo: `OI${n}` });
      const { resumo, pedidos } = await obterImportacao({ organizacaoId: SACI_ORG_ID, unidadeId: UNIDADE_TESTE_ID, importacaoId });

      assert.equal(pedidos.length, n, `esperava ${n} pedidos elegíveis na Visão Geral, veio ${pedidos.length} — sinal de truncamento`);
      assert.equal(resumo.totalPedidos, n);
      assert.equal(resumo.taxasBrutas, n * TAXA_PADRAO);
      assert.equal(resumo.taxasValidas, n * TAXA_PADRAO);

      // Consistência Histórico × Visão Geral: reaproveita esta MESMA
      // importação de 1300 pedidos (>1000) em vez de duplicar a carga —
      // listarImportacoes() (Histórico, lê a linha persistida) e
      // obterImportacao() (Visão Geral, recalculada) precisam concordar.
      if (n === 1300) {
        const historico = await listarImportacoes({ organizacaoId: SACI_ORG_ID, unidadeId: UNIDADE_TESTE_ID });
        const linhaHistorico = historico.find((h) => h.id === importacaoId);
        assert.ok(linhaHistorico, "importação de teste não apareceu no Histórico");
        assert.equal(linhaHistorico.totalPedidos, resumo.totalPedidos, "Histórico.totalPedidos != Visão Geral.resumo.totalPedidos");
        assert.equal(linhaHistorico.taxasBrutas, resumo.taxasBrutas, "Histórico.taxasBrutas != Visão Geral.resumo.taxasBrutas");
        assert.equal(linhaHistorico.taxasDescartadas, resumo.taxasDescartadas, "Histórico.taxasDescartadas != Visão Geral.resumo.taxasDescartadas");
        assert.equal(linhaHistorico.taxasValidas, resumo.taxasValidas, "Histórico.taxasValidas != Visão Geral.resumo.taxasValidas — a divergência do caso real voltou");
      }
    });
  }
});

// ---------------------------------------------------------------------------
// editarCodigosSemTaxa() — recalcula e SOBRESCREVE o resumo persistido.
// Numa importação >1000 pedidos, precisa continuar considerando todos eles
// (senão o valor hoje correto no banco seria corrompido para um valor
// truncado — risco descrito no relatório de investigação).
// ---------------------------------------------------------------------------
describe("editarCodigosSemTaxa() em importação >1000 pedidos", { skip: PULAR_INTEGRACAO }, () => {
  test("marcar um código como \"sem taxa\" recalcula sobre TODOS os 1050 pedidos, não só os primeiros 1000", async () => {
    const n = 1050;
    const { importacaoId, numeroPedidoCancelado } = await criarImportacao(n, { prefixo: "ED", situacaoCanceladaNoIndice: n - 1 });

    const resultado = await editarCodigosSemTaxa({
      organizacaoId: SACI_ORG_ID, unidadeId: UNIDADE_TESTE_ID, importacaoId,
      novosCodigos: [numeroPedidoCancelado], usuario: USUARIO,
    });

    assert.equal(resultado.resumo.totalPedidos, n, "resumo não considerou todos os pedidos — sinal de truncamento");
    assert.equal(resultado.resumo.cancelados, 1);
    assert.equal(resultado.resumo.canceladosSemTaxa, 1);
    assert.equal(resultado.resumo.taxasBrutas, n * TAXA_PADRAO);
    assert.equal(resultado.resumo.taxasDescartadas, TAXA_PADRAO);
    assert.equal(resultado.resumo.taxasValidas, n * TAXA_PADRAO - TAXA_PADRAO);

    // O que fica GRAVADO em parser_fd_importacoes precisa bater com o
    // resumo — é exatamente esse campo que o Histórico exibe depois.
    const { data: persistido } = await supabase.from("parser_fd_importacoes").select("*").eq("id", importacaoId).single();
    assert.equal(persistido.taxas_brutas, n * TAXA_PADRAO);
    assert.equal(persistido.taxas_validas, n * TAXA_PADRAO - TAXA_PADRAO);
  });
});

// ---------------------------------------------------------------------------
// alterarClassificacaoCancelamento() — mesmo risco de sobrescrita que
// editarCodigosSemTaxa(), numa importação >1000 pedidos.
// ---------------------------------------------------------------------------
describe("alterarClassificacaoCancelamento() em importação >1000 pedidos", { skip: PULAR_INTEGRACAO }, () => {
  test("override manual de UM cancelamento recalcula sobre TODOS os 1050 pedidos, não só os primeiros 1000", async () => {
    const n = 1050;
    const { importacaoId, pedidoCanceladoId } = await criarImportacao(n, { prefixo: "AC", situacaoCanceladaNoIndice: 0 });

    const resultado = await alterarClassificacaoCancelamento({
      organizacaoId: SACI_ORG_ID, unidadeId: UNIDADE_TESTE_ID, importacaoId,
      pedidoId: pedidoCanceladoId, classificacaoFinal: "nao_recebe_taxa",
      motivo: "teste automatizado — override em importação >1000 pedidos", usuario: USUARIO,
    });

    assert.equal(resultado.resumo.totalPedidos, n, "resumo não considerou todos os pedidos — sinal de truncamento");
    assert.equal(resultado.resumo.canceladosSemTaxa, 1);
    assert.equal(resultado.resumo.taxasBrutas, n * TAXA_PADRAO);
    assert.equal(resultado.resumo.taxasDescartadas, TAXA_PADRAO);
    assert.equal(resultado.resumo.taxasValidas, n * TAXA_PADRAO - TAXA_PADRAO);

    const { data: persistido } = await supabase.from("parser_fd_importacoes").select("*").eq("id", importacaoId).single();
    assert.equal(persistido.taxas_brutas, n * TAXA_PADRAO);
    assert.equal(persistido.taxas_validas, n * TAXA_PADRAO - TAXA_PADRAO);
  });
});

// Exercita o join PostgREST real, limites inclusivos e sobreposição, usando
// a mesma unidade descartável e cleanup da suíte de regressão existente.
test("analisarPeriodo: 1387 pedidos, dois arquivos sobrepostos e virada de mês", { skip: PULAR_INTEGRACAO }, async () => {
  const prefixo = "PER" + Date.now();
  const a = await criarImportacao(1387, { prefixo });
  const b = await criarImportacao(1, { prefixo: prefixo + "B", situacaoCanceladaNoIndice: 0 });
  const conferir = ({ error }) => { if (error) throw new Error(error.message); };
  conferir(await supabase.from("parser_fd_pedidos").update({ data_hora: "2026-04-30T00:00:00Z" }).eq("importacao_id", a.importacaoId));
  conferir(await supabase.from("parser_fd_pedidos").update({ data_hora: "2026-05-01T23:59:59.999Z" }).eq("importacao_id", a.importacaoId).eq("numero_pedido", prefixo + "-1386"));
  conferir(await supabase.from("parser_fd_pedidos").update({ numero_pedido: prefixo + "-0", data_hora: "2026-04-30T00:00:00Z" }).eq("importacao_id", b.importacaoId));
  const alvo = { organizacaoId: SACI_ORG_ID, unidadeId: UNIDADE_TESTE_ID, dataInicio: "2026-04-30", dataFim: "2026-05-01" };
  const d = await analisarPeriodo(alvo);
  assert.equal(d.resumo.totalPedidos, 1387);
  assert.equal(d.pedidos.length, 1387);
  assert.equal(d.resumo.cancelados, 1);
  assert.equal(d.duplicadosSobrepostos, 1);
  assert.equal(d.pedidos.find((p) => p.numeroPedido === prefixo + "-0").importacaoId, b.importacaoId);
  assert.equal(d.resumo.taxasValidas, 13870);
  const dia = await analisarPeriodo({ ...alvo, dataFim: "2026-04-30" });
  assert.equal(dia.resumo.totalPedidos, 1386);
  const vazio = await analisarPeriodo({ ...alvo, dataInicio: "2026-05-02", dataFim: "2026-05-02" });
  assert.equal(vazio.resumo.totalPedidos, 0);
});
