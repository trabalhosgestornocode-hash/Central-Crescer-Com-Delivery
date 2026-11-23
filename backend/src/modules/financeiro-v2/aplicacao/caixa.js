// Operações FINANCEIRAS (dinheiro): movimentações de conta, liquidações de títulos, transferências internas e seus estornos.
// Nenhuma delas cria lançamento econômico — é isso que impede despesa/receita em dobro e resultado artificial.
// Estorno nunca apaga: o registro original fica, marcado, e nasce um registro de ESTORNO que aponta para ele.
import { CODIGO, falhar } from "../dominio/erros.js";
import {
  ALVO_ESTORNO, ALVO_LIQUIDACAO, EVENTO_HISTORICO, NATUREZA_MOVIMENTACAO, SENTIDO, SITUACAO_CONCILIACAO, SITUACAO_LIQUIDACAO,
  SITUACAO_MOVIMENTACAO, SITUACAO_TRANSFERENCIA, TIPO,
} from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { somar, somarLista, subtrair } from "../dominio/dinheiro.js";
import { competenciaDe } from "../dominio/tempo.js";
import { aplicarLiquidacao, reverterLiquidacao } from "../dominio/titulos.js";
import {
  validarEstornoLiquidacao, validarEstornoMovimentacao, validarEstornoTransferencia, validarLiquidacao, validarMovimentacao, validarTransferencia,
} from "../contratos/comandos.js";
import { exigirPagamentoLiberado } from "./guardaEntregadores.js";
import { exigirSemComprovantePendente } from "./baixaPorComprovante.js";

const tipoDoAlvo = (alvoTipo) => (alvoTipo === ALVO_LIQUIDACAO.OBRIGACAO ? TIPO.OBRIGACAO : TIPO.RECEBIVEL);

export function operacoesDeCaixa(b) {
  async function contaAtiva(tx, ctx, id) {
    const conta = await b.obterOuFalhar(tx, ctx, TIPO.CONTA, id, "Conta financeira");
    if (!conta.ativa) falhar(CODIGO.OPERACAO_INVALIDA, "Conta financeira inativa.");
    return conta;
  }

  const movimento = (d) => ({ ...d, pagamentoId: null, estornoId: null, alocadoCentavos: 0, situacao: SITUACAO_MOVIMENTACAO.VALIDA, situacaoConciliacao: SITUACAO_CONCILIACAO.NAO_CONCILIADA });

  const registrarEstorno = (tx, cx, d, justificativa) => b.criar(tx, cx, TIPO.ESTORNO, {
    motivo: null, justificativa, dataEfetiva: b.hoje(), documentoId: null, lancamentoId: null, movimentacaoId: null, ...d,
  }, justificativa);

  /** Anula o registro de UMA movimentação, sem apagar. Só quando nada depende dela. */
  async function anularMovimentacao(tx, cx, mov, estornoId, justificativa) {
    if (mov.situacao === SITUACAO_MOVIMENTACAO.ESTORNADA) falhar(CODIGO.OPERACAO_INVALIDA, "Movimentação já estornada.");
    if (mov.alocadoCentavos > 0) falhar(CODIGO.ESTORNO_EXIGE_COMPENSACAO, "Há títulos liquidados com esta movimentação. Estorne as liquidações antes.");
    if (mov.situacaoConciliacao !== SITUACAO_CONCILIACAO.NAO_CONCILIADA) {
      falhar(CODIGO.ESTORNO_EXIGE_COMPENSACAO, "A movimentação está conciliada. Revise a conciliação antes de estorná-la.");
    }
    await b.exigirCompetenciaEditavel(tx, cx, competenciaDe(mov.dataEfetiva));
    return b.alterar(tx, cx, TIPO.MOVIMENTACAO, mov, { situacao: SITUACAO_MOVIMENTACAO.ESTORNADA, estornoId }, EVENTO_HISTORICO.ESTORNO, justificativa);
  }

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
        if (mov.situacao === SITUACAO_MOVIMENTACAO.ESTORNADA) falhar(CODIGO.LIQUIDACAO_INCOMPATIVEL, "Movimentação estornada não liquida títulos.");
        if (mov.pagamentoId) {
          falhar(CODIGO.LIQUIDACAO_INCOMPATIVEL, "Esta movimentação já representa um pagamento direto de venda (ou sua devolução): não liquida títulos.");
        }
        // 06D: a liquidação é um fato da competência da MOVIMENTAÇÃO (precisa aceitar escrita). O título pode ser de uma
        // competência anterior já homologada (venda de setembro recebida em outubro): ele só muda a posição financeira
        // (pago/saldo), nunca o resultado econômico — permitido e registrado como atualização posterior ao fechamento.
        const compsDosTitulos = [];
        for (const a of c.alocacoes) compsDosTitulos.push((await tx.obter(cx, tipoDoAlvo(a.alvoTipo), a.alvoId))?.competencia ?? null);
        await b.exigirCompetenciasDoVinculo(tx, cx, { gravadas: [competenciaDe(mov.dataEfetiva)], referenciadas: compsDosTitulos, motivo: "liquidação de título" });
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
          if (tipo === TIPO.OBRIGACAO) await exigirPagamentoLiberado(tx, cx, alvo);
          if (tipo === TIPO.OBRIGACAO) await exigirSemComprovantePendente(tx, cx, alvo.id, a.valorCentavos); // Execução 17: concilia, não baixa de novo
          const mudancas = aplicarLiquidacao(alvo, a.valorCentavos);
          liquidacoes.push(await b.criar(tx, cx, TIPO.LIQUIDACAO, { movimentacaoId: mov.id, alvoTipo: a.alvoTipo, alvoId: a.alvoId, valorCentavos: a.valorCentavos, estornadoCentavos: 0, dataEfetiva: mov.dataEfetiva, situacao: SITUACAO_LIQUIDACAO.VALIDA }));
          titulos.push(await b.alterar(tx, cx, tipo, alvo, mudancas, EVENTO_HISTORICO.LIQUIDACAO));
        }
        const movimentacao = await b.alterar(tx, cx, TIPO.MOVIMENTACAO, mov, { alocadoCentavos: somar(mov.alocadoCentavos, total) }, EVENTO_HISTORICO.LIQUIDACAO);
        return { movimentacao, liquidacoes, titulos };
      });
    },

    /**
     * Estorno TOTAL (sem valor) ou PARCIAL (com valor) de uma liquidação. A liquidação original é preservada e devolve
     * o saldo ao título e à movimentação. Os vínculos documentais e conciliações do original não são tocados.
     */
    estornarLiquidacao(ctx, entrada) {
      const c = validarEstornoLiquidacao(entrada);
      return b.executar(ctx, ACAO.CANCELAR, async (cx, tx) => {
        const liq = await b.obterOuFalhar(tx, cx, TIPO.LIQUIDACAO, c.liquidacaoId, "Liquidação");
        const valido = subtrair(liq.valorCentavos, liq.estornadoCentavos ?? 0);
        if (liq.situacao === SITUACAO_LIQUIDACAO.ESTORNADA || valido === 0) falhar(CODIGO.OPERACAO_INVALIDA, "Liquidação já estornada.");
        const valor = c.valorCentavos ?? valido;
        if (valor > valido) falhar(CODIGO.OPERACAO_INVALIDA, "O estorno supera o valor ainda válido da liquidação.", { validoCentavos: valido });
        const tipo = tipoDoAlvo(liq.alvoTipo);
        await b.exigirCompetenciasDoVinculo(tx, cx, { gravadas: [competenciaDe(liq.dataEfetiva)], referenciadas: [(await tx.obter(cx, tipo, liq.alvoId))?.competencia ?? null], motivo: "estorno de liquidação" });
        if (c.documentoId) await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, c.documentoId, "Documento");
        const alvo = await b.obterOuFalhar(tx, cx, tipo, liq.alvoId, "Título");
        // Execução 17: pagamento por comprovante ainda sem conciliação não tem movimentação (nada a devolver ao alocado).
        const mov = liq.movimentacaoId ? await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, liq.movimentacaoId, "Movimentação") : null;
        const estornado = somar(liq.estornadoCentavos ?? 0, valor);
        const situacao = estornado === liq.valorCentavos ? SITUACAO_LIQUIDACAO.ESTORNADA : SITUACAO_LIQUIDACAO.ESTORNADA_PARCIAL;
        const liquidacao = await b.alterar(tx, cx, TIPO.LIQUIDACAO, liq, { estornadoCentavos: estornado, situacao }, EVENTO_HISTORICO.ESTORNO, c.justificativa);
        const titulo = await b.alterar(tx, cx, tipo, alvo, reverterLiquidacao(alvo, valor), EVENTO_HISTORICO.ESTORNO, c.justificativa);
        const movimentacao = mov ? await b.alterar(tx, cx, TIPO.MOVIMENTACAO, mov, { alocadoCentavos: subtrair(mov.alocadoCentavos, valor) }, EVENTO_HISTORICO.ESTORNO, c.justificativa) : null;
        const estorno = await registrarEstorno(tx, cx, { alvoTipo: ALVO_ESTORNO.LIQUIDACAO, alvoId: liq.id, valorCentavos: valor, documentoId: c.documentoId }, c.justificativa);
        return { estorno, liquidacao, titulo, movimentacao };
      });
    },

    /**
     * Anula uma movimentação registrada indevidamente (ex.: linha lançada em duplicidade). Permitido só quando nada
     * depende dela: sem liquidação válida, sem conciliação, sem vínculo com venda e fora de transferência.
     * Estorno feito PELO BANCO não é isto: ele aparece no extrato como outra movimentação.
     */
    estornarMovimentacao(ctx, entrada) {
      const c = validarEstornoMovimentacao(entrada);
      return b.executar(ctx, ACAO.CANCELAR, async (cx, tx) => {
        const mov = await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, c.movimentacaoId, "Movimentação");
        if (mov.transferenciaId) falhar(CODIGO.OPERACAO_INVALIDA, "Perna de transferência não se estorna sozinha: use estornarTransferencia.");
        if (mov.pagamentoId) falhar(CODIGO.OPERACAO_INVALIDA, "Movimentação de pagamento de venda: use estornarPagamentoDeVenda.");
        const estornoId = b.gerarId();
        const movimentacao = await anularMovimentacao(tx, cx, mov, estornoId, c.justificativa);
        const estorno = await registrarEstorno(tx, cx, { id: estornoId, alvoTipo: ALVO_ESTORNO.MOVIMENTACAO, alvoId: mov.id, valorCentavos: mov.valorCentavos }, c.justificativa);
        return { estorno, movimentacao };
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
          situacao: SITUACAO_TRANSFERENCIA.VALIDA, chaveIdempotencia: chave, impressao: chave ? impressao : null,
        });
        return { transferencia, saida, entrada: entradaMov, repetido: false };
      });
    },

    /** Estorna a transferência INTEIRA: as duas pernas são anuladas juntas (nunca uma só). */
    estornarTransferencia(ctx, entrada) {
      const c = validarEstornoTransferencia(entrada);
      return b.executar(ctx, ACAO.CANCELAR, async (cx, tx) => {
        const t = await b.obterOuFalhar(tx, cx, TIPO.TRANSFERENCIA, c.transferenciaId, "Transferência");
        if (t.situacao === SITUACAO_TRANSFERENCIA.ESTORNADA) falhar(CODIGO.OPERACAO_INVALIDA, "Transferência já estornada.");
        const estornoId = b.gerarId();
        const saida = await anularMovimentacao(tx, cx, await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, t.saidaId, "Movimentação"), estornoId, c.justificativa);
        const entradaMov = await anularMovimentacao(tx, cx, await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, t.entradaId, "Movimentação"), estornoId, c.justificativa);
        const transferencia = await b.alterar(tx, cx, TIPO.TRANSFERENCIA, t, { situacao: SITUACAO_TRANSFERENCIA.ESTORNADA }, EVENTO_HISTORICO.ESTORNO, c.justificativa);
        const estorno = await registrarEstorno(tx, cx, { id: estornoId, alvoTipo: ALVO_ESTORNO.TRANSFERENCIA, alvoId: t.id, valorCentavos: t.valorCentavos }, c.justificativa);
        return { estorno, transferencia, saida, entrada: entradaMov };
      });
    },
  };
}
