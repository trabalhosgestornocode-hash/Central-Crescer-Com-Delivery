// Fase 05 (doc 43) — resumo da área SAIPOS (Presencial e Anota Aí) para a tela "Canais de faturamento → SAIPOS".
// Só leitura. Faturamento = vendas ativas dos canais BALCAO (Presencial) e ANOTA_AI; pedidos iFood/99Food do relatório
// SAIPOS aparecem SÓ como conferência (nunca somados). Ausência de dados ≠ zero confirmado.
import { CODIGO, falhar } from "../dominio/erros.js";
import { ESTADO_PROPOSTA, SITUACAO_REGISTRO_FONTE, SITUACAO_VENDA, TIPO } from "../dominio/catalogos.js";
import { exigirData } from "../dominio/tempo.js";
import { semCamposDesconhecidos } from "../dominio/validacao.js";

const CANAIS_SAIPOS = ["BALCAO", "ANOTA_AI"];

export function operacoesDoCanalSaipos(b) {
  return {
    consultarCanalSaipos(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, ["periodoInicio", "periodoFim"], "consulta");
      const inicio = exigirData(entrada.periodoInicio, "periodoInicio");
      const fim = exigirData(entrada.periodoFim, "periodoFim");
      if (fim < inicio) falhar(CODIGO.ENTRADA_INVALIDA, "Período invertido.");
      const no = (d) => d >= inicio && d <= fim;
      return b.consultar(ctx, async (cx, tx) => {
        const vendas = (await tx.listar(cx, TIPO.VENDA, { onde: { situacao: SITUACAO_VENDA.ATIVA } })).filter((v) => CANAIS_SAIPOS.includes(v.canal) && no(v.dataVenda));
        const porCanal = Object.fromEntries(CANAIS_SAIPOS.map((canal) => {
          const lista = vendas.filter((v) => v.canal === canal);
          const daFonte = (s) => lista.filter((v) => (v.fonte?.sistema ?? "MANUAL") === s);
          return [canal, {
            vendas: lista.length, brutoCentavos: lista.length ? lista.reduce((s, v) => s + v.brutoCentavos, 0) : null,
            descontosCentavos: lista.reduce((s, v) => s + (v.descontosCentavos ?? 0), 0),
            semPagamento: { vendas: lista.filter((v) => !v.pagamentoIds?.length).length, valorCentavos: lista.filter((v) => !v.pagamentoIds?.length).reduce((s, v) => s + v.brutoCentavos, 0) },
            porOrigem: { SAIPOS: daFonte("SAIPOS").length, MANUAL: daFonte("MANUAL").length },
            dias: [...new Set(lista.map((v) => v.dataVenda))].length,
          }];
        }));
        // Pedidos de plataformas no relatório SAIPOS: SÓ conferência (o faturamento delas vem das fontes oficiais).
        const pedidos = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "SAIPOS", tipoRegistro: "PEDIDO" } }))
          .filter((r) => r.situacao === SITUACAO_REGISTRO_FONTE.ATIVO && no(r.dataReferencia) && !r.dados?.cancelado);
        const soConferencia = Object.fromEntries(["IFOOD", "NOVENTA_E_NOVE_FOOD"].map((k) => {
          const l = pedidos.filter((r) => r.dados?.canal === k);
          return [k, { pedidos: l.length, totalCentavos: l.reduce((s, r) => s + r.valorCentavos, 0) }];
        }));
        const importacoes = (await tx.listar(cx, TIPO.IMPORTACAO, { onde: { fonte: "SAIPOS" } }))
          .filter((i) => i.periodoInicio <= fim && inicio <= i.periodoFim)
          .sort((a, x) => String(x.criadoEm).localeCompare(String(a.criadoEm)))
          .map((i) => ({ id: i.id, tipoRelatorio: i.tipoRelatorio, periodoInicio: i.periodoInicio, periodoFim: i.periodoFim, estado: i.estado, criadoEm: i.criadoEm, documentoId: i.documentoId ?? null }));
        const idsImp = new Set(importacoes.map((i) => i.id));
        const propostas = (await tx.listar(cx, TIPO.PROPOSTA, { onde: { fonte: "SAIPOS" } })).filter((p) => idsImp.has(p.importacaoId));
        const abertas = propostas.filter((p) => [ESTADO_PROPOSTA.PROPOSTA, ESTADO_PROPOSTA.AGUARDANDO_REVISAO, ESTADO_PROPOSTA.AGUARDANDO_EVIDENCIA, ESTADO_PROPOSTA.APROVADA].includes(p.estado));
        const divergencias = {};
        for (const p of propostas.filter((x) => x.estado !== ESTADO_PROPOSTA.REJEITADA && x.estado !== ESTADO_PROPOSTA.SUBSTITUIDA)) {
          for (const d of p.divergencias ?? []) {
            divergencias[d.codigo] ??= { codigo: d.codigo, quantidade: 0, valorCentavos: 0, exemplo: d.mensagem };
            divergencias[d.codigo].quantidade += 1;
            divergencias[d.codigo].valorCentavos += p.valorCentavos ?? 0;
          }
        }
        const comImportacao = new Set(vendas.filter((v) => v.fonte?.sistema === "SAIPOS").map((v) => v.dataVenda));
        return {
          periodoInicio: inicio, periodoFim: fim, canais: porCanal, soConferencia, importacoes,
          propostas: { abertas: abertas.length, porEstado: Object.fromEntries(Object.values(ESTADO_PROPOSTA).map((e) => [e, propostas.filter((p) => p.estado === e).length]).filter(([, n]) => n)) },
          divergencias: Object.values(divergencias).sort((a, x) => x.quantidade - a.quantidade), diasComImportacao: comImportacao.size,
          observacao: "Presencial e Anota Aí vêm da SAIPOS. Pedidos iFood e 99Food do relatório SAIPOS ficam só para conferência: o faturamento deles vem das fontes oficiais.",
        };
      });
    },
  };
}
