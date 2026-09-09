// Integração — o override MANUAL de classificação (recebe / não recebe taxa)
// sobrevive a uma reimportação do período (item 15 do pedido: "estratégia
// idempotente"). Antes da migration 079 o override morava numa coluna da
// linha do pedido e sumia num delete+reimport; agora vive em
// parser_fd_pedido_overrides com identidade estável.
// Rodar: npm run test:integracao
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
const PULAR = motivoPularIntegracao();
import { randomUUID } from "node:crypto";
import { supabase } from "../src/config/supabase.js";
import { obterImportacao, alterarClassificacaoCancelamento } from "../src/modules/parser-food-delivery/parserFoodDelivery.service.js";

const ORG = "00000000-0000-0000-0000-000000000001";
const UN = "00000000-0000-0000-0000-0000000000b1";
const USUARIO = { id: null, nome: "teste automatizado (parser-food-delivery-override-reimport.test.js)" };

const impIds = [];
const NUM = "OVR-1";
const DATA_HORA = "2026-05-02T18:30:00Z";

async function importarComCancelado({ statusInicial = "cancelado_com_taxa" }) {
  const impId = randomUUID();
  const pedId = randomUUID();
  const { error: eImp } = await supabase.from("parser_fd_importacoes").insert({
    id: impId, organizacao_id: ORG, unidade_id: UN, periodo_inicio: "2026-05-01", periodo_fim: "2026-05-07",
    nome_arquivo: "ovr.xls", hash_arquivo: `ovr-${impId}`, total_pedidos: 1, pedidos_subway: 1, coluna_detalhes_encontrada: true,
    entregues: 0, cancelados: 1, cancelados_com_taxa: 1, cancelados_sem_taxa: 0,
    cancelados_recebem_taxa: 1, cancelados_nao_recebem_taxa: 0, cancelados_revisao: 0,
    taxas_brutas: 10, taxas_descartadas: 0, taxas_validas: 10, codigos_sem_taxa: [], status: "concluida", usuario_nome: USUARIO.nome,
  });
  if (eImp) throw new Error(`insert importacao falhou: ${eImp.message}`);
  const { error: ePed } = await supabase.from("parser_fd_pedidos").insert({
    id: pedId, importacao_id: impId, organizacao_id: ORG, unidade_id: UN, numero_pedido: NUM,
    data_hora: DATA_HORA, situacao: "Cancelado", entregador: "Bruno", taxa_entregador: 10, valor_total_pedido: 40,
    operacao: "subway", status_conciliacao: statusInicial, classificacao_cancelamento: "revisar",
    classificacao_original: "revisar", classificacao_nivel_confianca: "inconclusiva", classificacao_regra: "regra_contraditorio",
    dados_brutos: {},
  });
  if (ePed) throw new Error(`insert pedido falhou: ${ePed.message}`);
  impIds.push(impId);
  return { impId, pedId };
}

after(async () => {
  for (const id of impIds) {
    await supabase.from("parser_fd_pedidos").delete().eq("importacao_id", id);
    await supabase.from("parser_fd_importacoes").delete().eq("id", id);
  }
  await supabase.from("parser_fd_pedido_overrides").delete().eq("unidade_id", UN).eq("numero_pedido", NUM);
  await supabase.from("parser_fd_auditoria").delete().eq("unidade_id", UN).eq("acao", "classificacao_alterada").eq("numero_pedido", NUM);
});

describe("Override de classificação sobrevive a reimportação", { skip: PULAR }, () => {
  test("recebe -> não recebe permanece após delete + reimport do período", async () => {
    const { impId, pedId } = await importarComCancelado({ statusInicial: "cancelado_com_taxa" });

    await alterarClassificacaoCancelamento({
      organizacaoId: ORG, unidadeId: UN, importacaoId: impId, pedidoId: pedId,
      classificacaoFinal: "nao_recebe_taxa", motivo: "conferência: entregador não coletou", usuario: USUARIO,
    });

    let det = await obterImportacao({ organizacaoId: ORG, unidadeId: UN, importacaoId: impId });
    assert.equal(det.pedidos[0].classificacaoEfetiva, "nao_recebe_taxa");
    assert.equal(det.resumo.taxasValidas, 0, "taxa do cancelado passa a ser descartada");

    // Simula reimportação: apaga a importação e recria com o mesmo pedido/chave.
    await supabase.from("parser_fd_pedidos").delete().eq("importacao_id", impId);
    await supabase.from("parser_fd_importacoes").delete().eq("id", impId);
    impIds.splice(impIds.indexOf(impId), 1);

    const reimport = await importarComCancelado({ statusInicial: "cancelado_com_taxa" });
    det = await obterImportacao({ organizacaoId: ORG, unidadeId: UN, importacaoId: reimport.impId });
    assert.equal(det.pedidos[0].classificacaoEfetiva, "nao_recebe_taxa", "override foi preservado pela tabela de overrides");
    assert.equal(det.pedidos[0].classificacaoOverrideEm != null, true);
    assert.equal(det.resumo.taxasValidas, 0);
  });

  test("não recebe -> recebe também persiste", async () => {
    const { impId, pedId } = await importarComCancelado({ statusInicial: "excluido" });
    await alterarClassificacaoCancelamento({
      organizacaoId: ORG, unidadeId: UN, importacaoId: impId, pedidoId: pedId,
      classificacaoFinal: "recebe_taxa", motivo: "entregador comprovou o deslocamento", usuario: USUARIO,
    });
    const det = await obterImportacao({ organizacaoId: ORG, unidadeId: UN, importacaoId: impId });
    assert.equal(det.pedidos[0].classificacaoEfetiva, "recebe_taxa");
    assert.equal(det.resumo.taxasValidas, 10);

    const { data } = await supabase.from("parser_fd_pedido_overrides").select("*").eq("unidade_id", UN).eq("numero_pedido", NUM).single();
    assert.equal(data.classificacao_final, "recebe_taxa");
  });
});
