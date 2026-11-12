// Fechamento de competência e consultas (composição, histórico, conservação).
import {
  ESTADO_COMPETENCIA, EVENTO_HISTORICO, NATUREZA_LANCAMENTO, NATUREZA_MOVIMENTACAO, SENTIDO, SITUACAO_LANCAMENTO,
  SITUACAO_MOVIMENTACAO, SITUACAO_PAGAMENTO, SITUACAO_TITULO, SITUACAO_TRANSFERENCIA, SITUACAO_VENDA, TIPO,
} from "../dominio/catalogos.js";
import { autorizar, exigirContexto } from "../dominio/contexto.js";
import { somarLista, subtrair } from "../dominio/dinheiro.js";
import { acaoDaTransicao } from "../dominio/fechamento.js";
import { compor } from "../dominio/indicadores.js";
import { saldoDe } from "../dominio/titulos.js";
import { exigirCompetencia } from "../dominio/tempo.js";
import { exigirUmDe } from "../dominio/validacao.js";
import { validarConsultaComposicao, validarConsultaHistorico, validarMudancaDeEstado } from "../contratos/comandos.js";

export function operacoesDeCompetencia(b, { repositorio, politica }) {
  return {
    /** Muda o estado de fechamento. A ação exigida depende da transição (fechar, homologar ou revisar). */
    async alterarEstadoDaCompetencia(ctxBruto, entrada) {
      const c = validarMudancaDeEstado(entrada);
      const ctx = exigirContexto(ctxBruto);
      politica.exigir(ctx);
      return repositorio.transacao(async (tx) => {
        // Trava EXCLUSIVA: espera as escritas em andamento nesta competência terminarem e barra as próximas até decidir.
        await tx.travar(ctx, `competencia:${c.competencia}`, "EXCLUSIVA");
        const atual = await b.competenciaAtual(tx, ctx, c.competencia);
        const estadoAtual = atual?.estado ?? ESTADO_COMPETENCIA.ABERTA;
        autorizar(ctx, acaoDaTransicao(estadoAtual, c.novoEstado, c));
        const reabertura = c.novoEstado === ESTADO_COMPETENCIA.ABERTA;
        const dados = {
          competencia: c.competencia, estado: c.novoEstado, metodologia: c.metodologia ?? atual?.metodologia ?? null, pendencias: c.pendencias,
          revisoes: (atual?.revisoes ?? 0) + (reabertura ? 1 : 0), decididoPor: ctx.usuarioId, decididoEm: b.agora(),
        };
        if (!atual) return b.criar(tx, ctx, TIPO.COMPETENCIA, dados, c.justificativa);
        return b.alterar(tx, ctx, TIPO.COMPETENCIA, atual, dados, EVENTO_HISTORICO.MUDANCA_ESTADO, c.justificativa);
      }, { escopo: ctx });
    },

    consultarCompetencia(ctx, entrada) {
      const competencia = exigirCompetencia(entrada?.competencia);
      return b.consultar(ctx, async (cx, tx) => {
        const c = await b.competenciaAtual(tx, cx, competencia);
        return c ?? { competencia, estado: ESTADO_COMPETENCIA.ABERTA, metodologia: null, pendencias: [], revisoes: 0 };
      });
    },

    /** Total de um indicador + TODOS os registros que o compõem (definição central em dominio/indicadores.js). */
    consultarComposicao(ctx, entrada) {
      const c = validarConsultaComposicao(entrada);
      return b.consultar(ctx, async (cx, tx) => compor(c.indicador, c.competencia, {
        lancamentos: await tx.listar(cx, TIPO.LANCAMENTO),
        movimentacoes: await tx.listar(cx, TIPO.MOVIMENTACAO),
        obrigacoes: await tx.listar(cx, TIPO.OBRIGACAO),
        recebiveis: await tx.listar(cx, TIPO.RECEBIVEL),
      }, { canal: c.canal, classificacao: c.classificacao }));
    },

    consultarHistorico(ctx, entrada) {
      const c = validarConsultaHistorico(entrada);
      return b.consultar(ctx, (cx, tx) => tx.listarHistorico(cx, { onde: { registroTipo: c.registroTipo, registroId: c.registroId } }));
    },

    consultarRegistros(ctx, entrada) {
      const tipo = exigirUmDe(entrada?.tipo, TIPO, "tipo");
      return b.consultar(ctx, (cx, tx) => tx.listar(cx, tipo));
    },

    /**
     * Auditoria das invariantes sobre os dados gravados. Lista vazia = tudo fecha.
     * As mesmas regras também são protegidas no banco (restrições e gatilhos da migração 0001).
     */
    verificarConservacao(ctx) {
      return b.consultar(ctx, async (cx, tx) => {
        const violacoes = [];
        const erro = (regra, tipo, id) => violacoes.push({ regra, registroTipo: tipo, registroId: id });
        const valido = (l) => subtrair(l.valorCentavos, l.estornadoCentavos ?? 0);
        const liquidacoes = await tx.listar(cx, TIPO.LIQUIDACAO);
        const ajustes = await tx.listar(cx, TIPO.AJUSTE);
        const movimentacoes = await tx.listar(cx, TIPO.MOVIMENTACAO);
        const lancamentos = await tx.listar(cx, TIPO.LANCAMENTO);

        for (const tipo of [TIPO.OBRIGACAO, TIPO.RECEBIVEL]) {
          for (const t of await tx.listar(cx, tipo)) {
            const liquidado = somarLista(liquidacoes.filter((l) => l.alvoTipo === tipo && l.alvoId === t.id), valido);
            const ajustado = somarLista(ajustes.filter((a) => a.alvoTipo === tipo && a.alvoId === t.id), (a) => a.valorCentavos);
            if (t.liquidadoCentavos !== liquidado) erro("LIQUIDADO_DIFERE_DAS_LIQUIDACOES", tipo, t.id);
            if (t.ajustesCentavos !== ajustado) erro("AJUSTES_DIFEREM_DOS_REGISTROS", tipo, t.id);
            if (t.saldoCentavos !== saldoDe(t) || t.saldoCentavos < 0) erro("SALDO_NAO_FECHA", tipo, t.id);
            if (t.situacao === SITUACAO_TITULO.QUITADA && t.saldoCentavos !== 0) erro("QUITADA_COM_SALDO", tipo, t.id);
          }
        }
        for (const m of movimentacoes) {
          const alocado = somarLista(liquidacoes.filter((l) => l.movimentacaoId === m.id), valido);
          if (m.situacao === SITUACAO_MOVIMENTACAO.ESTORNADA && alocado > 0) erro("MOVIMENTACAO_ESTORNADA_LIQUIDANDO", TIPO.MOVIMENTACAO, m.id);
          if (m.pagamentoId && alocado > 0) erro("PAGAMENTO_DIRETO_LIQUIDANDO_TITULO", TIPO.MOVIMENTACAO, m.id);
          if (m.alocadoCentavos !== alocado || alocado > m.valorCentavos) erro("ALOCACAO_DA_MOVIMENTACAO_NAO_FECHA", TIPO.MOVIMENTACAO, m.id);
          if (m.natureza === NATUREZA_MOVIMENTACAO.TRANSFERENCIA_INTERNA && (alocado > 0 || !m.transferenciaId)) erro("TRANSFERENCIA_LIQUIDANDO_TITULO", TIPO.MOVIMENTACAO, m.id);
        }
        for (const t of await tx.listar(cx, TIPO.TRANSFERENCIA)) {
          const s = movimentacoes.find((m) => m.id === t.saidaId);
          const e = movimentacoes.find((m) => m.id === t.entradaId);
          const estornadas = [s, e].filter((m) => m?.situacao === SITUACAO_MOVIMENTACAO.ESTORNADA).length;
          if (estornadas !== (t.situacao === SITUACAO_TRANSFERENCIA.ESTORNADA ? 2 : 0)) erro("TRANSFERENCIA_COM_PERNA_SOLTA", TIPO.TRANSFERENCIA, t.id);
          const ok = s && e && s.sentido === SENTIDO.SAIDA && e.sentido === SENTIDO.ENTRADA && s.valorCentavos === t.valorCentavos
            && e.valorCentavos === t.valorCentavos && s.contaId !== e.contaId && s.transferenciaId === t.id && e.transferenciaId === t.id;
          if (!ok) erro("TRANSFERENCIA_SEM_PAR", TIPO.TRANSFERENCIA, t.id);
        }
        const pagamentos = await tx.listar(cx, TIPO.PAGAMENTO_VENDA);
        for (const v of await tx.listar(cx, TIPO.VENDA)) {
          const receitas = lancamentos.filter((l) => l.origem?.tipo === TIPO.VENDA && l.origem.id === v.id && l.natureza === NATUREZA_LANCAMENTO.RECEITA && l.situacao === SITUACAO_LANCAMENTO.ATIVO);
          if (v.situacao === SITUACAO_VENDA.CANCELADA) {
            if (receitas.length !== 0) erro("VENDA_CANCELADA_COM_RECEITA", TIPO.VENDA, v.id);
            continue;
          }
          const daVenda = pagamentos.filter((p) => p.vendaId === v.id && p.situacao !== SITUACAO_PAGAMENTO.CANCELADO);
          const pago = somarLista(daVenda, (p) => subtrair(p.valorCentavos, p.estornadoCentavos));
          const devolucoes = lancamentos.filter((l) => l.origem?.tipo === TIPO.ESTORNO && l.origem.vendaId === v.id && l.situacao === SITUACAO_LANCAMENTO.ATIVO);
          if (pago !== v.pagoCentavos || pago + v.devolvidoCentavos > v.brutoCentavos) erro("PAGAMENTOS_NAO_FECHAM", TIPO.VENDA, v.id);
          if (!v.pagamentoParcial && v.devolvidoCentavos === 0 && pago !== v.brutoCentavos && daVenda.every((p) => p.estornadoCentavos === 0)) erro("PAGAMENTOS_NAO_FECHAM", TIPO.VENDA, v.id);
          if (somarLista(devolucoes, (l) => l.valorCentavos) !== v.devolvidoCentavos) erro("DEVOLUCAO_DIFERE_DOS_LANCAMENTOS", TIPO.VENDA, v.id);
          if (receitas.length !== 1 || receitas[0].valorCentavos !== v.brutoCentavos) erro("VENDA_SEM_RECEITA_UNICA", TIPO.VENDA, v.id);
        }
        for (const p of pagamentos) {
          if (p.recebivelId && p.movimentacaoId) erro("PAGAMENTO_COM_DOIS_EFEITOS", TIPO.PAGAMENTO_VENDA, p.id);
          if (p.processador && !p.recebivelId) erro("PAGAMENTO_PROCESSADO_SEM_RECEBIVEL", TIPO.PAGAMENTO_VENDA, p.id);
          if (!p.processador && p.recebivelId) erro("PAGAMENTO_DIRETO_COM_RECEBIVEL", TIPO.PAGAMENTO_VENDA, p.id);
        }
        for (const l of lancamentos) if (!l.categoriaId || !l.classificacao) erro("LANCAMENTO_SEM_CLASSIFICACAO", TIPO.LANCAMENTO, l.id);
        const origensDeCaixa = [TIPO.MOVIMENTACAO, TIPO.LIQUIDACAO, TIPO.TRANSFERENCIA];
        for (const l of lancamentos) if (!l.origem || origensDeCaixa.includes(l.origem.tipo)) erro("LANCAMENTO_ORIGINADO_DE_CAIXA", TIPO.LANCAMENTO, l.id);
        return violacoes;
      });
    },
  };
}
