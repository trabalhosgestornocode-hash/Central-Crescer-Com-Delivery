// Fase 04 (doc 42) — fechamento manual de caixa: registro (com correção auditada) e consulta com a comparação diária.
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, SITUACAO_VENDA, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { calcularFechamento, compararDia, validarFechamentoManual } from "../dominio/fechamentoManual.js";
import { competenciaDe, exigirData } from "../dominio/tempo.js";
import { semCamposDesconhecidos } from "../dominio/validacao.js";

const chaveDoFechamento = (data, caixa) => `fechamento-caixa:${data}:${caixa.trim().toUpperCase()}`;

export function operacoesDeFechamentoManual(b) {
  return {
    /**
     * Registra o fechamento de UM caixa num dia. Repetir igual não faz nada; com valores diferentes é CORREÇÃO (exige
     * justificativa; a versão anterior fica no histórico). Nenhum efeito financeiro.
     */
    registrarFechamentoManual(ctx, entrada) {
      const f = validarFechamentoManual(entrada);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        b.exigirNaoFutura(f.data, "data");
        await b.exigirCompetenciaEditavel(tx, cx, competenciaDe(f.data));
        const chave = chaveDoFechamento(f.data, f.caixa);
        const { justificativa, data, caixa, observacao, ...resto } = f;
        const dados = { ...resto, ...calcularFechamento(f), origem: "MANUAL", registradoPor: cx.usuarioId };
        const impressao = JSON.stringify({ data, caixa, observacao, ...resto });
        const existente = await tx.buscarPorChave(cx, TIPO.FECHAMENTO_CAIXA, chave);
        if (existente) {
          if (existente.impressao === impressao) return { fechamento: existente, repetido: true };
          if (!justificativa) falhar(CODIGO.ENTRADA_INVALIDA, "Este caixa já tem fechamento neste dia: para corrigir, informe a justificativa (a versão anterior fica no histórico).", { campo: "justificativa" });
          const corrigido = await b.alterar(tx, cx, TIPO.FECHAMENTO_CAIXA, existente, { dados: { ...dados, registradoPor: existente.dados.registradoPor, corrigidoPor: cx.usuarioId }, observacao, impressao, situacao: "REGISTRADO" }, EVENTO_HISTORICO.CORRECAO, justificativa);
          return { fechamento: corrigido, repetido: false, corrigido: true };
        }
        const novo = await b.criar(tx, cx, TIPO.FECHAMENTO_CAIXA, { data, caixa, situacao: "REGISTRADO", dados, observacao, chaveIdempotencia: chave, impressao });
        return { fechamento: novo, repetido: false };
      });
    },

    /** Fechamentos do período, agrupados por dia, com a comparação contra as vendas do dia (Presencial e Anota Aí). */
    consultarFechamentoManual(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, ["periodoInicio", "periodoFim"], "consulta");
      const inicio = exigirData(entrada.periodoInicio, "periodoInicio");
      const fim = exigirData(entrada.periodoFim, "periodoFim");
      if (fim < inicio) falhar(CODIGO.ENTRADA_INVALIDA, "Período invertido.");
      return b.consultar(ctx, async (cx, tx) => {
        const fechamentos = (await tx.listar(cx, TIPO.FECHAMENTO_CAIXA)).filter((f) => f.data >= inicio && f.data <= fim);
        const vendas = (await tx.listar(cx, TIPO.VENDA, { onde: { situacao: SITUACAO_VENDA.ATIVA } })).filter((v) => v.dataVenda >= inicio && v.dataVenda <= fim && (v.canal === "BALCAO" || v.canal === "ANOTA_AI"));
        const ids = new Set(vendas.map((v) => v.id));
        const pagamentos = (await tx.listar(cx, TIPO.PAGAMENTO_VENDA)).filter((p) => ids.has(p.vendaId) && p.situacao === "VALIDO");
        const porVenda = new Map();
        for (const p of pagamentos) { if (!porVenda.has(p.vendaId)) porVenda.set(p.vendaId, []); porVenda.get(p.vendaId).push(p); }
        const datas = [...new Set([...fechamentos.map((f) => f.data), ...vendas.map((v) => v.dataVenda)])].sort();
        const dias = datas.map((data) => {
          const doDia = fechamentos.filter((f) => f.data === data).sort((a, x) => a.caixa.localeCompare(x.caixa));
          const vendasDoDia = vendas.filter((v) => v.dataVenda === data).map((v) => ({ ...v, pagamentos: porVenda.get(v.id) ?? [] }));
          return { data, fechamentos: doDia, ...compararDia({ fechamentos: doDia, vendas: vendasDoDia }) };
        });
        return { periodoInicio: inicio, periodoFim: fim, dias };
      });
    },
  };
}
