// Operações FINANCEIRAS (dinheiro): movimentações de conta, liquidações de títulos e transferências internas.
// Nenhuma delas cria lançamento econômico — é isso que impede despesa/receita em dobro e resultado artificial.
import { CODIGO, falhar } from "../dominio/erros.js";
import {
  ALVO_LIQUIDACAO, EVENTO_HISTORICO, NATUREZA_MOVIMENTACAO, SENTIDO, SITUACAO_CONCILIACAO, SITUACAO_LIQUIDACAO, TIPO,
} from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { somar, somarLista, subtrair } from "../dominio/dinheiro.js";
import { competenciaDe } from "../dominio/tempo.js";
import { aplicarLiquidacao, reverterLiquidacao } from "../dominio/titulos.js";
import { validarEstornoLiquidacao, validarLiquidacao, validarMovimentacao, validarTransferencia } from "../contratos/comandos.js";

const tipoDoAlvo = (alvoTipo) => (alvoTipo === ALVO_LIQUIDACAO.OBRIGACAO ? TIPO.OBRIGACAO : TIPO.RECEBIVEL);

export function operacoesDeCaixa(b) {
  async function contaAtiva(tx, ctx, id) {
    const conta = await b.obterOuFalhar(tx, ctx, TIPO.CONTA, id, "Conta financeira");
    if (!conta.ativa) falhar(CODIGO.OPERACAO_INVALIDA, "Conta financeira inativa.");
    return conta;
  }

  const movimento = (d) => ({ ...d, alocadoCentavos: 0, situacaoConciliacao: SITUACAO_CONCILIACAO.NAO_CONCILIADA });

  return {
    registrarMovimentacao(ctx, entrada) {
      const c = validarMovimentacao(entrada);
      const impressao = JSON.stringify(c);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const chave = b.chaveDe(c.fonte, `${c.contaId}|`);
        const existente = await b.jaRegistrado(tx, cx, TIPO.MOVIMENTACAO, chave, impressao);
        if (existente) return { movimentacao: existente, repetido: true };
        b.exigirNaoFutura(c.dataEfetiva, "dataEfetiva");
        await b.exigirCompetenciaEditavel(tx, cx, competenciaDe(c.dataEfetiva));
        await contaAtiva(tx, cx, c.contaId);
        if (c.documentoId) await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, c.documentoId, "Documento");
        const movimentacao = await b.criar(tx, cx, TIPO.MOVIMENTACAO, movimento({ ...c, transferenciaId: null, chaveIdempotencia: chave, impressao: chave ? impressao : null }));
        return { movimentacao, repetido: false };
      });
    },

    /**
     * Liga UMA movimentação a UM OU MAIS títulos. Saída quita obrigações; entrada quita recebíveis.
     * O total alocado nunca passa do valor da movimentação e cada parcela nunca passa do saldo do título.
     * Tudo ou nada: se uma alocação falhar, nenhuma é gravada.
     */
    registrarLiquidacao(ctx, entrada) {
      const c = validarLiquidacao(entrada);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const mov = await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, c.movimentacaoId, "Movimentação");
        if (mov.natureza === NATUREZA_MOVIMENTACAO.TRANSFERENCIA_INTERNA) {
          falhar(CODIGO.LIQUIDACAO_INCOMPATIVEL, "Transferência interna não paga nem recebe títulos.");
        }
        await b.exigirCompetenciaEditavel(tx, cx, competenciaDe(mov.dataEfetiva));
        const total = somarLista(c.alocacoes, (a) => a.valorCentavos);
        if (somar(mov.alocadoCentavos, total) > mov.valorCentavos) {
          falhar(CODIGO.LIQUIDACAO_EXCEDE_MOVIMENTACAO, "O total alocado supera o valor da movimentação.", { disponivelCentavos: subtrair(mov.valorCentavos, mov.alocadoCentavos) });
        }
        const esperado = mov.sentido === SENTIDO.SAIDA ? ALVO_LIQUIDACAO.OBRIGACAO : ALVO_LIQUIDACAO.RECEBIVEL;
        const liquidacoes = [];
        const titulos = [];
        for (const a of c.alocacoes) {
          if (a.alvoTipo !== esperado) falhar(CODIGO.LIQUIDACAO_INCOMPATIVEL, "Saída só liquida obrigação; entrada só liquida recebível.");
          const tipo = tipoDoAlvo(a.alvoTipo);
          const alvo = await b.obterOuFalhar(tx, cx, tipo, a.alvoId, "Título");
          const mudancas = aplicarLiquidacao(alvo, a.valorCentavos);
          liquidacoes.push(await b.criar(tx, cx, TIPO.LIQUIDACAO, { movimentacaoId: mov.id, alvoTipo: a.alvoTipo, alvoId: a.alvoId, valorCentavos: a.valorCentavos, dataEfetiva: mov.dataEfetiva, situacao: SITUACAO_LIQUIDACAO.VALIDA }));
          titulos.push(await b.alterar(tx, cx, tipo, alvo, mudancas, EVENTO_HISTORICO.LIQUIDACAO));
        }
        const movimentacao = await b.alterar(tx, cx, TIPO.MOVIMENTACAO, mov, { alocadoCentavos: somar(mov.alocadoCentavos, total) }, EVENTO_HISTORICO.LIQUIDACAO);
        return { movimentacao, liquidacoes, titulos };
      });
    },

    /** Estorno preserva a liquidação (marcada ESTORNADA) e devolve o saldo ao título e à movimentação. */
    estornarLiquidacao(ctx, entrada) {
      const c = validarEstornoLiquidacao(entrada);
      return b.executar(ctx, ACAO.CANCELAR, async (cx, tx) => {
        const liq = await b.obterOuFalhar(tx, cx, TIPO.LIQUIDACAO, c.liquidacaoId, "Liquidação");
        if (liq.situacao !== SITUACAO_LIQUIDACAO.VALIDA) falhar(CODIGO.OPERACAO_INVALIDA, "Liquidação já estornada.");
        await b.exigirCompetenciaEditavel(tx, cx, competenciaDe(liq.dataEfetiva));
        const tipo = tipoDoAlvo(liq.alvoTipo);
        const alvo = await b.obterOuFalhar(tx, cx, tipo, liq.alvoId, "Título");
        const mov = await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, liq.movimentacaoId, "Movimentação");
        const liquidacao = await b.alterar(tx, cx, TIPO.LIQUIDACAO, liq, { situacao: SITUACAO_LIQUIDACAO.ESTORNADA }, EVENTO_HISTORICO.ESTORNO, c.justificativa);
        const titulo = await b.alterar(tx, cx, tipo, alvo, reverterLiquidacao(alvo, liq.valorCentavos), EVENTO_HISTORICO.ESTORNO, c.justificativa);
        const movimentacao = await b.alterar(tx, cx, TIPO.MOVIMENTACAO, mov, { alocadoCentavos: subtrair(mov.alocadoCentavos, liq.valorCentavos) }, EVENTO_HISTORICO.ESTORNO, c.justificativa);
        return { liquidacao, titulo, movimentacao };
      });
    },

    /** Transferência entre contas da MESMA unidade: saída + entrada de mesmo valor, vinculadas, gravadas juntas. Sem lançamento. */
    registrarTransferencia(ctx, entrada) {
      const c = validarTransferencia(entrada);
      const impressao = JSON.stringify(c);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const chave = b.chaveDe(c.fonte);
        const existente = await b.jaRegistrado(tx, cx, TIPO.TRANSFERENCIA, chave, impressao);
        if (existente) {
          return { transferencia: existente, saida: await tx.obter(cx, TIPO.MOVIMENTACAO, existente.saidaId), entrada: await tx.obter(cx, TIPO.MOVIMENTACAO, existente.entradaId), repetido: true };
        }
        b.exigirNaoFutura(c.dataEfetiva, "dataEfetiva");
        await b.exigirCompetenciaEditavel(tx, cx, competenciaDe(c.dataEfetiva));
        await contaAtiva(tx, cx, c.contaOrigemId);
        await contaAtiva(tx, cx, c.contaDestinoId);
        const transferenciaId = b.gerarId();
        const perna = (contaId, sentido) => b.criar(tx, cx, TIPO.MOVIMENTACAO, movimento({
          contaId, dataEfetiva: c.dataEfetiva, sentido, valorCentavos: c.valorCentavos, moeda: c.moeda,
          natureza: NATUREZA_MOVIMENTACAO.TRANSFERENCIA_INTERNA, descricao: c.descricao, documentoId: null, fonte: c.fonte,
          transferenciaId, chaveIdempotencia: null, impressao: null,
        }));
        const saida = await perna(c.contaOrigemId, SENTIDO.SAIDA);
        const entradaMov = await perna(c.contaDestinoId, SENTIDO.ENTRADA);
        const transferencia = await b.criar(tx, cx, TIPO.TRANSFERENCIA, {
          id: transferenciaId, contaOrigemId: c.contaOrigemId, contaDestinoId: c.contaDestinoId, valorCentavos: c.valorCentavos, moeda: c.moeda,
          dataEfetiva: c.dataEfetiva, descricao: c.descricao, saidaId: saida.id, entradaId: entradaMov.id, fonte: c.fonte,
          chaveIdempotencia: chave, impressao: chave ? impressao : null,
        });
        return { transferencia, saida, entrada: entradaMov, repetido: false };
      });
    },
  };
}
