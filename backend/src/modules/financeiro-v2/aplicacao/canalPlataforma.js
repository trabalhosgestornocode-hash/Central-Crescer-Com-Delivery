// Fase 07 (doc 44) — áreas iFood e 99Food: SOMENTE fontes oficiais de cada plataforma. Só leitura; totais calculados aqui.
//   - iFood: reaproveita o DEMONSTRATIVO OFICIAL (doc 38): receita do canal, recebível com as retenções (comissões, taxa do
//     pagamento online, mensalidade, serviços/promoções a classificar), ajuste e repasses (liquidações do recebível);
//   - 99Food: ainda sem relatório oficial → nada é presumido: cada número fica "depende do relatório oficial";
//   - pedidos e cancelamentos: o demonstrativo não traz contagem → "depende do relatório de pedidos" (nunca zero). Os pedidos
//     do relatório SAIPOS aparecem À PARTE, só para conferência;
//   - PRELIMINAR × CONFIRMADO: valor do demonstrativo = confirmado pela fonte; repasse = previsto até haver liquidação registrada.
import { CODIGO, falhar } from "../dominio/erros.js";
import { SITUACAO_REGISTRO_FONTE, TIPO } from "../dominio/catalogos.js";
import { exigirCompetencia, primeiroDiaDe, ultimoDiaDe } from "../dominio/tempo.js";
import { semCamposDesconhecidos } from "../dominio/validacao.js";
import { leituraDaConciliacaoIfood } from "./conciliacaoIfood.js";
import { leituraDoRelatorio99Food } from "./relatorio99Food.js";

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
          const relatorio = await leituraDoRelatorio99Food(tx, cx, { inicio: primeiroDiaDe(competencia), fim: ultimoDiaDe(competencia) });
          if (relatorio) {
            const dias = [...relatorio.porDia.values()];
            const aplicados = dias.filter((x) => x.aplicado);
            const v = (k) => soma(aplicados, (x) => x[k]);
            const pendencias = [];
            if (aplicados.length < dias.length) pendencias.push({ codigo: "RELATORIO_NAO_APLICADO", mensagem: `${dias.length - aplicados.length} dia(s) do relatório oficial ainda não aplicado(s) ao Financeiro: fora dos totais abaixo.` });
            if (v("diasDivergentes")) pendencias.push({ codigo: "REPASSE_99FOOD_EM_CONFERENCIA", mensagem: `${v("diasDivergentes")} dia(s) com resultado preliminar diferente do repasse informado. Soma absoluta das diferenças em conferência:`, valorCentavos: v("somaAbsolutaDiferencasCentavos") });
            if (aplicados.length) pendencias.push({ codigo: "REPASSE_SEM_CICLO", mensagem: "O relatório não informa data nem ciclo do repasse: nada foi marcado como a receber ou recebido." });
            if (relatorio.conferenciaSaipos.diasSoNaSaipos.length) pendencias.push({ codigo: "PEDIDOS_99FOOD_SO_NA_SAIPOS", mensagem: `${relatorio.conferenciaSaipos.diasSoNaSaipos.length} dia(s) com pedidos 99Food só na SAIPOS: o relatório oficial não traz esses dias.` });
            if (relatorio.conferenciaSaipos.diasDivergentes.length) pendencias.push({ codigo: "DIFERENCA_SAIPOS_99FOOD", mensagem: `${relatorio.conferenciaSaipos.diasDivergentes.length} dia(s) com diferença entre a SAIPOS e o relatório oficial: pendente de conferência.` });
            const ate = dias.map((d) => d.data).sort();
            return {
              canal, competencia, fonteOficial: "Relatório oficial da 99Food", situacao: relatorio.situacao, dependeDeRelatorioOficial: false,
              totais: aplicados.length ? {
                brutoCentavos: v("itensCentavos"), comissoesCentavos: v("comissaoCentavos"), taxasCentavos: v("processamentoCentavos"), mensalidadesCentavos: null, descontosEPromocoesCentavos: null, ajustesCentavos: null, marketingCentavos: v("marketingCentavos"), recompensasCentavos: v("recompensasCentavos"), receitaOfertaCentavos: v("receitaOfertaCentavos"),
                resultadoPreliminarCentavos: v("composicaoCentavos"), diferencaRepasseCentavos: v("diferencaRepasseCentavos"), diasDivergentes: v("diasDivergentes"), somaAbsolutaDiferencasCentavos: v("somaAbsolutaDiferencasCentavos"), repassePrevistoCentavos: v("repasseCentavos"), repasseRecebidoCentavos: 0, saldoAReceberCentavos: null, pedidos: v("quantidade"), cancelamentos: null, observacaoPedidos: "Vendas informadas por dia no relatório oficial, sem pedidos individuais.",
              } : null,
              demonstrativos: [], historico: aplicados.length ? [{ periodoInicio: ate[0], periodoFim: ate.at(-1), brutoCentavos: v("itensCentavos"), repassePrevistoCentavos: v("repasseCentavos"), repasseRecebidoCentavos: null, situacaoRepasse: "SEM_CICLO" }] : [], conferenciaSaipos, pendencias, relatorio99Food: { loja: relatorio.lojas[0] ?? null, divergencias: relatorio.divergencias, conferenciaSaipos: relatorio.conferenciaSaipos, diasImportados: dias.length, diasAplicados: aplicados.length },
            };
          }
          return {
            canal, competencia, fonteOficial: null, situacao: "SEM_FONTE_OFICIAL", dependeDeRelatorioOficial: true,
            totais: null, demonstrativos: [], historico: [], conferenciaSaipos,
            pendencias: [{ codigo: "RELATORIO_OFICIAL_AUSENTE", mensagem: "Sem relatório oficial da 99Food nesta competência: faturamento, comissões, taxas e repasses dependem da importação do arquivo Dados da loja (nada é presumido)." }],
          };
        }
        const todos = await demonstrativosDoIfood(tx, cx, hoje);
        const daCompetencia = todos.filter((d) => d.competencia === competencia);
        // Receita do canal iFood que NÃO veio do demonstrativo (ex.: venda SAIPOS anterior à regra, lançamento manual): sinalizada.
        const foraDaFonte = (await tx.listar(cx, TIPO.LANCAMENTO, { onde: { canal: "IFOOD", competencia } }))
          .filter((l) => l.situacao === "ATIVO" && l.categoria === "VENDA_IFOOD" && !l.demonstrativoIfood && !l.conciliacaoIfood);
        const outrasOrigens = { lancamentos: foraDaFonte.length, valorCentavos: soma(foraDaFonte, (l) => l.valorCentavos), porSistema: Object.fromEntries([...new Set(foraDaFonte.map((l) => l.fonte?.sistema ?? "SEM_FONTE"))].map((k) => [k, soma(foraDaFonte.filter((l) => (l.fonte?.sistema ?? "SEM_FONTE") === k), (l) => l.valorCentavos)])) };
        const conciliacao = await leituraDaConciliacaoIfood(tx, cx, { inicio: primeiroDiaDe(competencia), fim: ultimoDiaDe(competencia), hoje });
        const pendencias = [];
        if (conciliacao) {
          // Só o que foi aplicado entra nos totais; demonstrativo válido de outros dias da competência soma, sem repetir período.
          const dias = [...conciliacao.porDia.values()];
          const aplicados = dias.filter((x) => x.aplicado);
          const v = (k) => soma(aplicados, (x) => x[k]);
          const dem = (k) => soma(daCompetencia, (x) => x[k]);
          const recebiveis = [...conciliacao.recebiveis.values()].filter((r) => r.competencia === competencia);
          const previsto = soma(recebiveis, (r) => r.valorBaseCentavos) + dem("repassePrevistoCentavos");
          const recebido = soma(recebiveis, (r) => r.liquidadoCentavos) + dem("repasseRecebidoCentavos");
          const naoAplicados = dias.length - aplicados.length;
          if (naoAplicados) pendencias.push({ codigo: "CONCILIACAO_NAO_APLICADA", mensagem: `${naoAplicados} dia(s) do relatório oficial ainda não aplicado(s) ao Financeiro: fora dos totais abaixo.` });
          if (conciliacao.conferenciaSaipos.diferencaCentavos) pendencias.push({ codigo: "DIFERENCA_SAIPOS_IFOOD", mensagem: "Diferença entre SAIPOS e relatório oficial do iFood: pendente de conferência.", valorCentavos: conciliacao.conferenciaSaipos.diferencaCentavos });
          if (foraDaFonte.length) pendencias.push({ codigo: "RECEITA_IFOOD_FORA_DA_FONTE_OFICIAL", mensagem: `${foraDaFonte.length} lançamento(s) de receita iFood não vieram do relatório oficial.`, valorCentavos: soma(foraDaFonte, (l) => l.valorCentavos) });
          return {
            canal, competencia, fonteOficial: "Relatório de Conciliação Financeira do iFood", situacao: conciliacao.situacao, dependeDeRelatorioOficial: false,
            totais: aplicados.length || daCompetencia.length ? {
              brutoCentavos: v("faturamentoCentavos") + dem("brutoCentavos"), produtosCentavos: v("produtosCentavos"), entregasCentavos: v("entregasCentavos"), comissoesCentavos: v("comissoesCentavos") + dem("comissoesCentavos"), taxasCentavos: v("taxasCentavos") + dem("taxasCentavos"), mensalidadesCentavos: dem("mensalidadesCentavos"),
              descontosEPromocoesCentavos: v("descontosCentavos") + dem("descontosEPromocoesCentavos"), ajustesCentavos: dem("ajustesCentavos") - v("ajustesCentavos"), liquidoCentavos: v("liquidoCentavos") + dem("liquidoInformadoCentavos"), recebidoDiretoCentavos: conciliacao.resumo.recebidoDiretoCentavos,
              repassePrevistoCentavos: previsto, repasseRecebidoCentavos: recebido, saldoAReceberCentavos: previsto - recebido, pedidos: v("pedidos") - v("pedidosCancelados"), cancelamentos: v("pedidosCancelados"), observacaoPedidos: "Pedidos e cancelamentos do relatório oficial de conciliação.",
            } : null,
            demonstrativos: daCompetencia, historico: todos, conferenciaSaipos, outrasOrigens, pendencias, conciliacao: { conferenciaSaipos: conciliacao.conferenciaSaipos, repasses: conciliacao.resumo.repasses, diasImportados: dias.length, diasAplicados: aplicados.length },
          };
        }
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
