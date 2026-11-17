// Fase 07 (doc 44) — áreas iFood e 99Food: SOMENTE fontes oficiais de cada plataforma. Só leitura; totais calculados aqui.
//   - iFood: reaproveita o DEMONSTRATIVO OFICIAL (doc 38): receita do canal, recebível com as retenções (comissões, taxa do
//     pagamento online, mensalidade, serviços/promoções a classificar), ajuste e repasses (liquidações do recebível);
//   - 99Food: ainda sem relatório oficial → nada é presumido: cada número fica "depende do relatório oficial";
//   - pedidos e cancelamentos: o demonstrativo não traz contagem → "depende do relatório de pedidos" (nunca zero). Os pedidos
//     do relatório SAIPOS aparecem À PARTE, só para conferência;
//   - PRELIMINAR × CONFIRMADO: valor do demonstrativo = confirmado pela fonte; repasse = previsto até haver liquidação registrada.
import { CODIGO, falhar } from "../dominio/erros.js";
import { SITUACAO_REGISTRO_FONTE, TIPO } from "../dominio/catalogos.js";
import { exigirCompetencia } from "../dominio/tempo.js";
import { semCamposDesconhecidos } from "../dominio/validacao.js";

const CATEGORIAS = Object.freeze({
  COMISSOES_IFOOD: "comissoesCentavos", TAXAS_DE_PROCESSAMENTO: "taxasCentavos", MENSALIDADE_IFOOD: "mensalidadesCentavos", DESCONTOS_A_CLASSIFICAR: "descontosEPromocoesCentavos",
});
const soma = (l, f) => l.reduce((s, x) => s + (f(x) ?? 0), 0);

/**
 * Demonstrativos OFICIAIS do iFood já registrados (um por período), com as retenções, o repasse previsto e o recebido.
 * Compartilhado pela área iFood e pelo calendário de faturamento: o período do demonstrativo NUNCA é repartido por dia.
 */
export async function demonstrativosDoIfood(tx, cx, hoje) {
  const lancs = (await tx.listar(cx, TIPO.LANCAMENTO, { onde: { canal: "IFOOD" } })).filter((l) => l.demonstrativoIfood && l.situacao === "ATIVO");
  const recebiveis = new Map((await tx.listar(cx, TIPO.RECEBIVEL, { onde: { processador: "IFOOD" } })).map((r) => [r.id, r]));
  const demonstrativo = (l) => {
    const r = recebiveis.get(l.demonstrativoIfood.recebivelId) ?? null;
    const ret = Object.fromEntries(Object.values(CATEGORIAS).map((k) => [k, 0]));
    for (const x of r?.retencoes ?? []) { const k = CATEGORIAS[x.categoria]; if (k) ret[k] += x.valorCentavos; }
    const previsto = r ? r.valorBaseCentavos + (r.ajustesCentavos ?? 0) : null;
    const recebido = r ? r.liquidadoCentavos : null;
    return {
      id: l.id, periodoInicio: l.demonstrativoIfood.periodoInicio, periodoFim: l.demonstrativoIfood.periodoFim, competencia: l.competencia, registradoEm: l.criadoEm,
      brutoCentavos: l.valorCentavos, ...ret, ajustesCentavos: r?.ajustesCentavos ?? 0, liquidoInformadoCentavos: l.demonstrativoIfood.liquidoInformadoCentavos ?? null,
      repassePrevistoCentavos: previsto, repasseRecebidoCentavos: recebido, saldoAReceberCentavos: r ? r.saldoCentavos : null, dataPrevista: r?.dataPrevista ?? null,
      situacaoRepasse: !r ? "SEM_RECEBIVEL" : r.saldoCentavos === 0 ? "RECEBIDO" : recebido > 0 ? "PARCIAL" : r.dataPrevista && r.dataPrevista < hoje ? "ATRASADO" : "PREVISTO",
    };
  };
  const todos = lancs.map(demonstrativo).sort((a, x) => String(x.periodoFim).localeCompare(String(a.periodoFim)));
  return todos;
}

export function operacoesDoCanalPlataforma(b) {
  return {
    consultarCanalPlataforma(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, ["canal", "competencia"], "consulta");
      const canal = String(entrada.canal ?? "").toUpperCase();
      if (!["IFOOD", "NOVENTA_E_NOVE_FOOD"].includes(canal)) falhar(CODIGO.ENTRADA_INVALIDA, "canal: IFOOD ou NOVENTA_E_NOVE_FOOD.", { campo: "canal" });
      const competencia = exigirCompetencia(entrada.competencia);
      return b.consultar(ctx, async (cx, tx) => {
        const hoje = b.hoje();
        // Pedidos das plataformas no relatório SAIPOS: só conferência (nunca faturamento).
        const pedidosSaipos = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "SAIPOS", tipoRegistro: "PEDIDO", competencia } }))
          .filter((r) => r.situacao === SITUACAO_REGISTRO_FONTE.ATIVO && r.dados?.canal === canal);
        const conferenciaSaipos = {
          pedidos: pedidosSaipos.filter((r) => !r.dados.cancelado).length, cancelados: pedidosSaipos.filter((r) => r.dados.cancelado).length,
          totalCentavos: soma(pedidosSaipos.filter((r) => !r.dados.cancelado), (r) => r.valorCentavos), natureza: "SO_CONFERENCIA",
        };
        if (canal === "NOVENTA_E_NOVE_FOOD") {
          return {
            canal, competencia, fonteOficial: null, situacao: "SEM_FONTE_OFICIAL", dependeDeRelatorioOficial: true,
            totais: null, demonstrativos: [], historico: [], conferenciaSaipos,
            pendencias: [{ codigo: "RELATORIO_OFICIAL_AUSENTE", mensagem: "Sem relatório oficial da 99Food: faturamento, comissões, taxas e repasses dependem da amostra real do arquivo (nada é presumido)." }],
          };
        }
        const todos = await demonstrativosDoIfood(tx, cx, hoje);
        const daCompetencia = todos.filter((d) => d.competencia === competencia);
        // Receita do canal iFood que NÃO veio do demonstrativo (ex.: venda SAIPOS anterior à regra, lançamento manual): sinalizada.
        const foraDaFonte = (await tx.listar(cx, TIPO.LANCAMENTO, { onde: { canal: "IFOOD", competencia } }))
          .filter((l) => l.situacao === "ATIVO" && l.categoria === "VENDA_IFOOD" && !l.demonstrativoIfood);
        const outrasOrigens = { lancamentos: foraDaFonte.length, valorCentavos: soma(foraDaFonte, (l) => l.valorCentavos), porSistema: Object.fromEntries([...new Set(foraDaFonte.map((l) => l.fonte?.sistema ?? "SEM_FONTE"))].map((k) => [k, soma(foraDaFonte.filter((l) => (l.fonte?.sistema ?? "SEM_FONTE") === k), (l) => l.valorCentavos)])) };
        const pendencias = [];
        if (foraDaFonte.length) pendencias.push({ codigo: "RECEITA_IFOOD_FORA_DA_FONTE_OFICIAL", mensagem: `${foraDaFonte.length} lançamento(s) de receita iFood nesta competência não vieram do demonstrativo oficial (origens: ${Object.keys(outrasOrigens.porSistema).join(", ")}). Revisar: a regra é faturamento iFood só pela fonte oficial; a correção depende de autorização.`, valorCentavos: outrasOrigens.valorCentavos });
        if (!daCompetencia.length) pendencias.push({ codigo: "DEMONSTRATIVO_AUSENTE", mensagem: "Sem demonstrativo oficial do iFood nesta competência: o faturamento do canal não está confirmado (não é zero)." });
        for (const d of daCompetencia.filter((x) => x.situacaoRepasse === "ATRASADO")) pendencias.push({ codigo: "REPASSE_ATRASADO", mensagem: `Repasse do período ${d.periodoInicio} a ${d.periodoFim} previsto para ${d.dataPrevista} ainda com saldo.`, valorCentavos: d.saldoAReceberCentavos });
        if (conferenciaSaipos.pedidos && !daCompetencia.length) pendencias.push({ codigo: "PEDIDOS_SEM_FONTE_OFICIAL", mensagem: `${conferenciaSaipos.pedidos} pedido(s) iFood no relatório SAIPOS sem demonstrativo oficial correspondente.` });
        const totais = daCompetencia.length ? {
          brutoCentavos: soma(daCompetencia, (d) => d.brutoCentavos), comissoesCentavos: soma(daCompetencia, (d) => d.comissoesCentavos), taxasCentavos: soma(daCompetencia, (d) => d.taxasCentavos),
          mensalidadesCentavos: soma(daCompetencia, (d) => d.mensalidadesCentavos), descontosEPromocoesCentavos: soma(daCompetencia, (d) => d.descontosEPromocoesCentavos),
          ajustesCentavos: soma(daCompetencia, (d) => d.ajustesCentavos), repassePrevistoCentavos: soma(daCompetencia, (d) => d.repassePrevistoCentavos),
          repasseRecebidoCentavos: soma(daCompetencia, (d) => d.repasseRecebidoCentavos), saldoAReceberCentavos: soma(daCompetencia, (d) => d.saldoAReceberCentavos),
          pedidos: null, cancelamentos: null, observacaoPedidos: "O demonstrativo oficial não traz contagem de pedidos e cancelamentos: depende do relatório oficial de pedidos.",
        } : null;
        return {
          canal, competencia, fonteOficial: "Demonstrativo oficial do iFood", situacao: daCompetencia.length ? (totais.saldoAReceberCentavos === 0 ? "CONFIRMADO" : "CONFIRMADO_COM_REPASSE_PENDENTE") : "PRELIMINAR",
          dependeDeRelatorioOficial: false, totais, demonstrativos: daCompetencia, historico: todos, conferenciaSaipos, outrasOrigens, pendencias,
        };
      });
    },
  };
}
