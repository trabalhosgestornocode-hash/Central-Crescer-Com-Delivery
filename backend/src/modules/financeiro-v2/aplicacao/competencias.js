// Fechamento de competência e consultas (composição, histórico, conservação).
import {
  ESTADO_COMPETENCIA, EVENTO_HISTORICO, NATUREZA_LANCAMENTO, NATUREZA_MOVIMENTACAO, SENTIDO, SITUACAO_LANCAMENTO,
  SITUACAO_LIQUIDACAO, SITUACAO_TITULO, TIPO,
} from "../dominio/catalogos.js";
import { autorizar, exigirContexto } from "../dominio/contexto.js";
import { somarLista } from "../dominio/dinheiro.js";
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
      });
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
      }));
    },

    consultarHistorico(ctx, entrada) {
      const c = validarConsultaHistorico(entrada);
      return b.consultar(ctx, (cx, tx) => tx.listarHistorico(cx, (h) => h.registroTipo === c.registroTipo && h.registroId === c.registroId));
    },

    consultarRegistros(ctx, entrada) {
      const tipo = exigirUmDe(entrada?.tipo, TIPO, "tipo");
      return b.consultar(ctx, (cx, tx) => tx.listar(cx, tipo));
    },

    /**
     * Auditoria das invariantes sobre os dados gravados. Lista vazia = tudo fecha.
     * É a mesma verificação que o adaptador PostgreSQL deverá reproduzir em SQL.
     */
    verificarConservacao(ctx) {
      return b.consultar(ctx, async (cx, tx) => {
        const violacoes = [];
        const erro = (regra, tipo, id) => violacoes.push({ regra, registroTipo: tipo, registroId: id });
        const liquidacoes = (await tx.listar(cx, TIPO.LIQUIDACAO)).filter((l) => l.situacao === SITUACAO_LIQUIDACAO.VALIDA);
        const ajustes = await tx.listar(cx, TIPO.AJUSTE);
        const movimentacoes = await tx.listar(cx, TIPO.MOVIMENTACAO);
        const lancamentos = await tx.listar(cx, TIPO.LANCAMENTO);

        for (const tipo of [TIPO.OBRIGACAO, TIPO.RECEBIVEL]) {
          for (const t of await tx.listar(cx, tipo)) {
            const liquidado = somarLista(liquidacoes.filter((l) => l.alvoTipo === tipo && l.alvoId === t.id), (l) => l.valorCentavos);
            const ajustado = somarLista(ajustes.filter((a) => a.alvoTipo === tipo && a.alvoId === t.id), (a) => a.valorCentavos);
            if (t.liquidadoCentavos !== liquidado) erro("LIQUIDADO_DIFERE_DAS_LIQUIDACOES", tipo, t.id);
            if (t.ajustesCentavos !== ajustado) erro("AJUSTES_DIFEREM_DOS_REGISTROS", tipo, t.id);
            if (t.saldoCentavos !== saldoDe(t) || t.saldoCentavos < 0) erro("SALDO_NAO_FECHA", tipo, t.id);
            if (t.situacao === SITUACAO_TITULO.QUITADA && t.saldoCentavos !== 0) erro("QUITADA_COM_SALDO", tipo, t.id);
          }
        }
        for (const m of movimentacoes) {
          const alocado = somarLista(liquidacoes.filter((l) => l.movimentacaoId === m.id), (l) => l.valorCentavos);
          if (m.alocadoCentavos !== alocado || alocado > m.valorCentavos) erro("ALOCACAO_DA_MOVIMENTACAO_NAO_FECHA", TIPO.MOVIMENTACAO, m.id);
          if (m.natureza === NATUREZA_MOVIMENTACAO.TRANSFERENCIA_INTERNA && (alocado > 0 || !m.transferenciaId)) erro("TRANSFERENCIA_LIQUIDANDO_TITULO", TIPO.MOVIMENTACAO, m.id);
        }
        for (const t of await tx.listar(cx, TIPO.TRANSFERENCIA)) {
          const s = movimentacoes.find((m) => m.id === t.saidaId);
          const e = movimentacoes.find((m) => m.id === t.entradaId);
          const ok = s && e && s.sentido === SENTIDO.SAIDA && e.sentido === SENTIDO.ENTRADA && s.valorCentavos === t.valorCentavos
            && e.valorCentavos === t.valorCentavos && s.contaId !== e.contaId && s.transferenciaId === t.id && e.transferenciaId === t.id;
          if (!ok) erro("TRANSFERENCIA_SEM_PAR", TIPO.TRANSFERENCIA, t.id);
        }
        for (const v of await tx.listar(cx, TIPO.VENDA)) {
          if (somarLista(v.pagamentos, (p) => p.valorCentavos) !== v.brutoCentavos) erro("PAGAMENTOS_NAO_FECHAM", TIPO.VENDA, v.id);
          const receitas = lancamentos.filter((l) => l.origem?.tipo === TIPO.VENDA && l.origem.id === v.id && l.natureza === NATUREZA_LANCAMENTO.RECEITA && l.situacao === SITUACAO_LANCAMENTO.ATIVO);
          if (receitas.length !== 1 || receitas[0].valorCentavos !== v.brutoCentavos) erro("VENDA_SEM_RECEITA_UNICA", TIPO.VENDA, v.id);
        }
        const origensDeCaixa = [TIPO.MOVIMENTACAO, TIPO.LIQUIDACAO, TIPO.TRANSFERENCIA];
        for (const l of lancamentos) if (!l.origem || origensDeCaixa.includes(l.origem.tipo)) erro("LANCAMENTO_ORIGINADO_DE_CAIXA", TIPO.LANCAMENTO, l.id);
        return violacoes;
      });
    },
  };
}
