// Tool "consultar_checklist_operacional" — indicadores HISTÓRICOS de tempo dos pedidos iFood (Dashboard Operacional).
//
// REGRA DE OURO (código calcula, IA interpreta): reaproveita checklistOperacional.service.js#obterDashboard — o MESMO
// cálculo da tela, do PDF e do Excel. A tool só resume o resultado para o modelo: nenhum número novo é calculado aqui.
// As análises vêm com a natureza separada (fato / hipótese / recomendação); o modelo é instruído a manter a separação
// e a nunca atribuir causa que os dados não mostram.
//
// Tenant SEMPRE do contexto do backend; o modelo controla só o período e a etapa. Módulo: checklist_operacional (migration
// 123); a execução também aceita ifood enquanto houver sessões abertas antes dela — a mesma regra do gate da API.
import { MODULOS } from "../../../shared/modulos.js";
import { PERMISSOES } from "../../../shared/permissoes.js";
import { garantirAcessoModulo, garantirPermissao } from "../agenteAcesso.js";
import * as checklistService from "../../checklist-operacional/checklistOperacional.service.js";

export const definicao = {
  name: "consultar_checklist_operacional",
  description:
    "Consulta os indicadores operacionais de TEMPO dos pedidos iFood da unidade (Checklist Operacional): pedidos acompanhados, tempo médio, mediano e P90 de preparo, entrega e vida do pedido, % dentro da meta vigente, atrasos, maior atraso, demanda por horário e comparação com o período anterior equivalente, mais as análises automáticas. Use para perguntas como \"como foi o preparo esta semana?\", \"em que horário mais atrasamos?\" ou \"melhoramos em relação ao mês passado?\". REGRAS: use só os números retornados (nunca estime); 'constatacao' é fato medido, 'hipotese' NÃO é comprovada e deve ser apresentada como possibilidade, 'recomendacao' é sugestão; não atribua causas que os dados não mostram; respeite os avisos de 'qualidade' (dados parciais, sem meta vigente, só pedidos de entrega). Período: hoje, ontem, semana (segunda até hoje), mes (dia 1 até hoje) ou personalizado com inicio/fim (AAAA-MM-DD, até 92 dias).",
  input_schema: {
    type: "object",
    properties: {
      periodo: { type: "string", enum: ["hoje", "ontem", "semana", "mes", "personalizado"] },
      inicio: { type: "string", description: "AAAA-MM-DD (só com periodo=personalizado)." },
      fim: { type: "string", description: "AAAA-MM-DD (só com periodo=personalizado)." },
      etapa: { type: "string", enum: ["todas", "preparo", "entrega", "vida"] },
    },
    required: ["periodo"],
    additionalProperties: false,
  },
};

/**
 * @param {{periodo: string, inicio?: string, fim?: string, etapa?: string}} input
 * @param {{organizacaoId: string, unidadeId: string|null, acesso: object}} contexto
 */
export async function executar(input, { organizacaoId, unidadeId, acesso }, deps = { obterDashboard: checklistService.obterDashboard }) {
  // Mesma régua do gate da API (routes.js): módulo próprio checklist_operacional OU ifood (sessões abertas antes da 123).
  garantirAcessoModulo(acesso, acesso?.modulos?.includes(MODULOS.CHECKLIST_OPERACIONAL) ? MODULOS.CHECKLIST_OPERACIONAL : MODULOS.IFOOD);
  garantirPermissao(acesso, PERMISSOES.CHECKLIST_VISUALIZAR);
  if (!unidadeId) return { disponivel: false, motivo: "O Checklist Operacional é por unidade: selecione uma unidade no seletor do topo." };
  const d = await deps.obterDashboard({
    organizacaoId, unidadeId,
    filtro: { periodo: input?.periodo, inicio: input?.inicio, fim: input?.fim, etapa: input?.etapa },
  });
  return resumirParaModelo(d);
}

/** Recorte enxuto do payload (sem listas longas de pedidos). Pura. */
export function resumirParaModelo(d) {
  const r = d.resumo;
  return {
    disponivel: true,
    periodo: d.periodo,
    etapas: d.etapas,
    totais: { pedidos: r.pedidos, concluidos: r.concluidos, cancelados: r.cancelados, pedidosAtrasados: r.pedidosAtrasados, pctPedidosAtrasados: r.pctPedidosAtrasados },
    porEtapa: Object.fromEntries(d.etapas.map((e) => {
      const x = r.porEtapa[e];
      return [e, { amostras: x.amostras, mediaMin: x.media, medianaMin: x.mediana, p90Min: x.p90, pctDentroDaMeta: x.pctDentro, atrasos: x.atrasos, maiorAtraso: x.maiorAtraso && { excedenteMin: x.maiorAtraso.excedenteMin, pedido: x.maiorAtraso.displayId } }];
    })),
    comparacao: d.comparacao,
    horasComMaisPedidos: [...d.demandaPorHora].sort((a, b) => b.pedidos - a.pedidos).slice(0, 5).filter((h) => h.pedidos > 0),
    metasAplicaveis: d.metasAplicaveis,
    analises: (d.analises?.itens ?? []).map((a) => ({
      titulo: a.titulo, severidade: a.severidade, constatacao: a.constatacao, referencia: a.referencia, ocorrencias: a.ocorrencias,
      hipotese: a.hipotese, recomendacao: a.recomendacao,
    })),
    regrasNaoAvaliadas: d.analises?.naoAvaliadas ?? [],
    qualidade: { avisos: d.qualidade.avisos, coberturaDesde: d.qualidade.coberturaDesde },
    checklistItens: d.checklistItens,
  };
}
