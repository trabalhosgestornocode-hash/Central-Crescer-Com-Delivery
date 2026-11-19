// CONFERÊNCIA DO SWF (Subway): cruza os relatórios 76 (canais), 03 (formas de pagamento) e 45 (análise por dia) do mesmo
// período. Só leitura: nada é lançado, repartido por dia ou presumido.
//
//   - Balcão (76) é o único faturamento reconhecido pelo SWF; iFood e 99Food do 76 são conferência com as fontes oficiais.
//   - Formas "recebidas pela loja" (03: cartão, dinheiro, Pix) incluem pedidos de plataforma pagos na entrega. A diferença
//     para o Balcão fica PENDENTE DE INVESTIGAÇÃO: não se presume que seja exatamente esse pagamento na entrega.
//   - O 45 tem valores por dia, mas de TODOS os canais juntos: é controle do dia, nunca faturamento do Balcão.
import { ESTADO_IMPORTACAO, ESTADO_PROPOSTA, SITUACAO_REGISTRO_FONTE, TIPO } from "../dominio/catalogos.js";
import { somar, subtrair } from "../dominio/dinheiro.js";
import { exigirCompetencia, primeiroDiaDe, ultimoDiaDe } from "../dominio/tempo.js";
import { semCamposDesconhecidos } from "../dominio/validacao.js";
import { RELATORIOS_SWF, SWF_ANALISE_FATURAMENTO, SWF_CANAIS, SWF_PAGAMENTOS } from "../importacao/fontes/swf.js";
import { fontesDaUnidade } from "./fontesDeFaturamento.js";

const VALIDAS = [ESTADO_IMPORTACAO.IMPORTADO, ESTADO_IMPORTACAO.IMPORTADO_COM_PENDENCIAS];
const CANAIS = ["BALCAO", "IFOOD", "NOVENTA_E_NOVE_FOOD"];

/** Leitura consolidada do SWF no intervalo (importações que tocam o intervalo). null = nenhum relatório SWF importado. */
export async function leituraDoSwf(tx, cx, { inicio, fim }) {
  const importacoes = (await tx.listar(cx, TIPO.IMPORTACAO, { onde: { fonte: "OUTRO" } }))
    .filter((i) => RELATORIOS_SWF.includes(i.tipoRelatorio) && VALIDAS.includes(i.estado) && i.periodoInicio <= fim && inicio <= i.periodoFim);
  if (!importacoes.length) return null;
  const ids = new Set(importacoes.map((i) => i.id));
  const registros = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "OUTRO" } }))
    .filter((r) => ids.has(r.importacaoId) && r.situacao === SITUACAO_REGISTRO_FONTE.ATIVO);
  const propostas = (await tx.listar(cx, TIPO.PROPOSTA, { onde: { fonte: "OUTRO" } })).filter((p) => ids.has(p.importacaoId));
  const deImp = (id) => registros.filter((r) => r.importacaoId === id);

  // Dias do 45 (controle diário de todos os canais). A versão mais recente de cada dia prevalece (substituição explícita).
  const porDia = new Map();
  for (const imp of importacoes.filter((i) => i.tipoRelatorio === SWF_ANALISE_FATURAMENTO).sort((a, b) => String(a.criadoEm).localeCompare(String(b.criadoEm)))) {
    for (const r of deImp(imp.id).filter((x) => x.tipoRegistro === "TOTAL_DIA_TODOS_CANAIS")) {
      const d = r.dados;
      porDia.set(r.dataReferencia, {
        importacaoId: imp.id, faturamentoTodosCanaisCentavos: r.valorCentavos, produtosCentavos: d.produtosCentavos, entregasCentavos: d.entregasCentavos,
        descontosCentavos: d.descontosCentavos, combosCentavos: d.combosCentavos, fecha: d.fecha, natureza: "CONTROLE_TODOS_OS_CANAIS",
      });
    }
  }

  // Períodos do 76 e do 03 (cada importação = um período). Um 03 só é comparado ao 76 do MESMO período.
  const periodos = [];
  for (const imp of importacoes.filter((i) => i.tipoRelatorio === SWF_CANAIS)) {
    const regs = deImp(imp.id).filter((x) => x.tipoRegistro === "TOTAL_CANAL");
    const porCanal = Object.fromEntries(CANAIS.map((c) => [c, { valorCentavos: 0, quantidade: 0 }]));
    let naoIdentificadoCentavos = 0;
    for (const r of regs) {
      if (porCanal[r.dados.canal]) { porCanal[r.dados.canal].valorCentavos = somar(porCanal[r.dados.canal].valorCentavos, r.valorCentavos); porCanal[r.dados.canal].quantidade += r.dados.quantidade ?? 0; }
      else naoIdentificadoCentavos = somar(naoIdentificadoCentavos, r.valorCentavos);
    }
    const props = propostas.filter((p) => p.importacaoId === imp.id && p.comando?.canal === "BALCAO");
    const situacaoBalcao = props.some((p) => p.estado === ESTADO_PROPOSTA.APLICADA) ? "APLICADO"
      : props.some((p) => ![ESTADO_PROPOSTA.REJEITADA, ESTADO_PROPOSTA.SUBSTITUIDA].includes(p.estado)) ? "PROPOSTA_ABERTA" : props.length ? "REJEITADO" : "SEM_PROPOSTA";
    const pagamentos = importacoes.find((i) => i.tipoRelatorio === SWF_PAGAMENTOS && i.periodoInicio === imp.periodoInicio && i.periodoFim === imp.periodoFim) ?? null;
    let formas = null;
    if (pagamentos) {
      formas = { importacaoId: pagamentos.id, porGrupo: {}, totalCentavos: 0 };
      for (const r of deImp(pagamentos.id)) { formas.porGrupo[r.dados.grupo] = somar(formas.porGrupo[r.dados.grupo] ?? 0, r.valorCentavos); formas.totalCentavos = somar(formas.totalCentavos, r.valorCentavos); }
    }
    const diasDoPeriodo = [...porDia.entries()].filter(([d]) => d >= imp.periodoInicio && d <= imp.periodoFim);
    const total76 = CANAIS.reduce((s, c) => somar(s, porCanal[c].valorCentavos), naoIdentificadoCentavos);
    const comparacoes = [];
    const comparar = (codigo, descricao, a, b2, explicacao = null) => comparacoes.push({ codigo, descricao, aCentavos: a, bCentavos: b2, diferencaCentavos: subtrair(a, b2), situacao: a === b2 ? "CONFERE" : "PENDENTE_DE_INVESTIGACAO", explicacao });
    if (formas) {
      comparar("TOTAL_76_X_03", "Total do 76 × total das formas de pagamento (03)", total76, formas.totalCentavos);
      const loja = formas.porGrupo.RECEBIDO_PELA_LOJA ?? 0;
      comparar("RECEBIDO_PELA_LOJA_X_BALCAO", "Formas recebidas pela loja (03) × Balcão (76)", loja, porCanal.BALCAO.valorCentavos,
        "Cartão, dinheiro e Pix da loja também recebem pedidos de plataforma pagos na entrega. A diferença não é presumida: confira com o relatório oficial da plataforma (pedidos pagos direto à loja).");
      comparar("IFOOD_76_X_03", "iFood no 76 × iFood pago no app (03)", porCanal.IFOOD.valorCentavos, formas.porGrupo.PLATAFORMA_IFOOD ?? 0, "Pedidos iFood que não foram pagos no app (ex.: pagos na entrega) aparecem nas formas da loja.");
      comparar("NOVENTA_E_NOVE_76_X_03", "99Food no 76 × 99Food pago no app (03)", porCanal.NOVENTA_E_NOVE_FOOD.valorCentavos, formas.porGrupo.PLATAFORMA_99FOOD ?? 0);
    }
    const esperados = Math.round((Date.parse(`${imp.periodoFim}T00:00:00Z`) - Date.parse(`${imp.periodoInicio}T00:00:00Z`)) / 86400000) + 1;
    if (diasDoPeriodo.length === esperados) comparar("TOTAL_76_X_45", "Total do 76 × soma dos dias do 45", total76, diasDoPeriodo.reduce((s, [, d]) => somar(s, d.faturamentoTodosCanaisCentavos), 0));
    periodos.push({
      importacaoId: imp.id, periodoInicio: imp.periodoInicio, periodoFim: imp.periodoFim, porCanal, naoIdentificadoCentavos, totalCentavos: total76,
      balcao: { ...porCanal.BALCAO, situacao: situacaoBalcao, natureza: "RECEITA_DO_PERIODO_SEM_DETALHE_DIARIO" },
      formas, diasDo45: diasDoPeriodo.length, diasNoPeriodo: esperados, comparacoes,
    });
  }
  return { importacoes: importacoes.map((i) => ({ id: i.id, tipoRelatorio: i.tipoRelatorio, periodoInicio: i.periodoInicio, periodoFim: i.periodoFim, estado: i.estado })), porDia, periodos };
}

export function operacoesDaConferenciaSwf(b) {
  return {
    /** Conferência dos relatórios do SWF no mês (76 × 03 × 45). Só leitura. */
    consultarConferenciaSwf(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, ["mes"], "consulta");
      const mes = exigirCompetencia(entrada.mes, "mes");
      return b.consultar(ctx, async (cx, tx) => {
        const config = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        const fontes = fontesDaUnidade(config);
        const leitura = fontes.sistemaDeLoja === "SWF" ? await leituraDoSwf(tx, cx, { inicio: primeiroDiaDe(mes), fim: ultimoDiaDe(mes) }) : null;
        return {
          mes, usaSwf: fontes.sistemaDeLoja === "SWF", fontes: fontes.fontes, importado: Boolean(leitura),
          importacoes: leitura?.importacoes ?? [], periodos: leitura?.periodos ?? [],
          dias: leitura ? [...leitura.porDia.entries()].sort(([a], [c]) => a.localeCompare(c)).map(([data, d]) => ({ data, ...d })) : [],
          regras: [
            "Só o Balcão do relatório 76 é faturamento pelo SWF. iFood e 99Food do SWF servem só para conferir as fontes oficiais.",
            "O relatório 76 é total do período: o Balcão não é repartido por dia.",
            "O relatório 45 tem valores por dia de todos os canais juntos: é controle, não faturamento.",
          ],
        };
      });
    },
  };
}
