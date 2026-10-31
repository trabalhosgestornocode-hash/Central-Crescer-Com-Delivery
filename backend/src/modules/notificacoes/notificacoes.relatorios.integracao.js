// Leitura da INTEGRAÇÃO REAL de uma unidade para os relatórios operacionais (somente leitura, somente banco local — não chama o iFood).
//
// Reaproveita EXATAMENTE a lógica do Checklist Operacional (`derivarEstadoIntegracao`): a conexão de PEDIDOS da unidade
// (finalidade `pedidos_producao`; uma conexão só de Financial nunca a substitui), a credencial `order`, o lease do recebimento
// (renovado há ≤ 120 s) e o último evento DESTA loja. O vínculo pedido ↔ unidade é o de `operacional_pedidos`/`ifood_pedidos`
// (organização + unidade, validado por trigger); aqui só se decide se a integração está VIVA. Falha ao ler = não verificada (fail-closed).
import * as ifoodRepoReal from "../ifood/ifood.repository.js";
import { derivarEstadoIntegracao } from "../checklist-operacional/checklistOperacional.service.js";
import { modulosEfetivosDaUnidade } from "../../shared/modulos.js";
import { filtrarUnidadesComChecklist, motivoDeIntegracao, MOTIVO } from "./notificacoes.relatorios.js";

/** @returns {Promise<{estado: string, motivo: string|null, ultimoEventoEm: string|null, ultimaSincronizacao: string|null}|null>} null = não foi possível verificar */
export async function lerIntegracaoDaUnidade({ organizacaoId, unidadeId, agora = () => new Date(), deps = {} }) {
  const ir = deps.ifoodRepo ?? ifoodRepoReal;
  try {
    const conexao = await ir.obterConexaoViva({ organizacaoId, unidadeId, finalidade: "pedidos_producao" });
    let credencialOrder = null; let observabilidade = null;
    if (conexao?.id) {
      credencialOrder = ((await ir.listarCredenciaisDaConexao({ conexaoId: conexao.id })) ?? []).find((c) => c.app_type === "order") ?? null;
      if (conexao.merchant_id) observabilidade = await ir.obterObservabilidadeOrder({ organizacaoId, unidadeId, merchantId: conexao.merchant_id });
    }
    const outraConexaoViva = !conexao && typeof ir.listarConexoesVivas === "function" ? ((await ir.listarConexoesVivas({ organizacaoId, unidadeId })) ?? []).length > 0 : false;
    return derivarEstadoIntegracao({ conexao, credencialOrder, observabilidade, agoraMs: agora().getTime(), outraConexaoViva });
  } catch { return null; }
}

/**
 * Das unidades candidatas, só as que têm o Checklist Operacional ativo E integração iFood de pedidos ao vivo.
 * Cada recusada traz o motivo distinto (sem módulo / não ativada / desconectada / não verificada) e a integração lida.
 * (Pedidos reais e dado válido são avaliados depois, sobre o fechamento: `elegibilidadeDiaria` e `planejarResumoSemanal`.)
 */
export async function unidadesComIntegracaoViva(unidades, { agora = () => new Date(), deps = {} } = {}) {
  const modulosDe = deps.modulosDe ?? modulosEfetivosDaUnidade;
  const { elegiveis: comModulo, recusadas } = await filtrarUnidadesComChecklist(unidades, { modulosDe });
  const vivas = [];
  for (const u of comModulo) {
    const integracao = await lerIntegracaoDaUnidade({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, agora, deps });
    const motivo = integracao ? motivoDeIntegracao(integracao) : MOTIVO.INTEGRACAO_NAO_VERIFICADA;
    if (motivo) recusadas.push({ ...u, motivo, integracao }); else vivas.push({ ...u, integracao });
  }
  return { elegiveis: vivas, recusadas };
}
