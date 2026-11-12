// Operações ECONÔMICAS: o que a empresa vendeu, deve e tem a receber. Nenhuma delas movimenta dinheiro.
// Cada fato econômico gera UM lançamento; pagar ou receber depois (liquidação) nunca gera outro.
import { CODIGO, falhar } from "../dominio/erros.js";
import { ALVO_LIQUIDACAO, EVENTO_HISTORICO, NATUREZA_LANCAMENTO, SITUACAO_LANCAMENTO, SITUACAO_TITULO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { ratear, somarLista, subtrair } from "../dominio/dinheiro.js";
import { somarMeses } from "../dominio/tempo.js";
import { aplicarAjuste } from "../dominio/titulos.js";
import {
  validarAjuste, validarCancelamentoObrigacao, validarConta, validarContraparte, validarCorrecaoObrigacao, validarObrigacao,
  validarRecebivel, validarReclassificacao, validarVenda,
} from "../contratos/comandos.js";

const titulo = (valorBaseCentavos) => ({ valorBaseCentavos, liquidadoCentavos: 0, ajustesCentavos: 0, saldoCentavos: valorBaseCentavos, situacao: SITUACAO_TITULO.ABERTA });

export function operacoesEconomicas(b) {
  const lancar = (tx, ctx, d) => b.criar(tx, ctx, TIPO.LANCAMENTO, { situacao: SITUACAO_LANCAMENTO.ATIVO, ...d });

  async function exigirDocumentos(tx, ctx, ids) {
    for (const id of ids) await b.obterOuFalhar(tx, ctx, TIPO.DOCUMENTO, id, "Documento");
  }

  return {
    configurarContaFinanceira(ctx, entrada) {
      const c = validarConta(entrada);
      return b.executar(ctx, ACAO.CONFIGURAR, (cx, tx) => b.criar(tx, cx, TIPO.CONTA, { ...c, ativa: true }));
    },

    registrarContraparte(ctx, entrada) {
      const c = validarContraparte(entrada);
      return b.executar(ctx, ACAO.REGISTRAR, (cx, tx) => b.criar(tx, cx, TIPO.CONTRAPARTE, c));
    },

    /** Venda: UM canal, uma ou mais formas de pagamento. Gera a receita (uma vez) e um recebível por pagamento processado. */
    registrarVenda(ctx, entrada) {
      const c = validarVenda(entrada);
      const impressao = JSON.stringify(c);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const chave = b.chaveDe(c.fonte);
        const existente = await b.jaRegistrado(tx, cx, TIPO.VENDA, chave, impressao);
        if (existente) {
          return {
            venda: existente,
            lancamento: await tx.obter(cx, TIPO.LANCAMENTO, existente.lancamentoId),
            recebiveis: await tx.listar(cx, TIPO.RECEBIVEL, (r) => r.vendaId === existente.id),
            repetido: true,
          };
        }
        await b.exigirCompetenciaEditavel(tx, cx, c.competencia);
        const vendaId = b.gerarId();
        const lancamento = await lancar(tx, cx, {
          natureza: NATUREZA_LANCAMENTO.RECEITA, valorCentavos: c.brutoCentavos, moeda: c.moeda, categoria: `VENDA_${c.canal}`,
          descricao: c.descricao ?? `Venda ${c.canal}`, dataOperacao: c.dataVenda, competencia: c.competencia, fonte: c.fonte,
          origem: { tipo: TIPO.VENDA, id: vendaId },
        });
        const venda = await b.criar(tx, cx, TIPO.VENDA, { id: vendaId, ...c, lancamentoId: lancamento.id, chaveIdempotencia: chave, impressao });
        const recebiveis = [];
        for (const [indice, p] of c.pagamentos.entries()) {
          if (!p.processador) continue; // dinheiro/Pix direto: a entrada aparece como movimentação da conta, não como recebível
          recebiveis.push(await b.criar(tx, cx, TIPO.RECEBIVEL, {
            processador: p.processador, contraparteId: null, canal: c.canal, vendaId, pagamentoIndice: indice, forma: p.forma,
            brutoCentavos: p.valorCentavos, moeda: c.moeda, deducoes: [], dataPrevista: null, competencia: c.competencia,
            descricao: null, documentoIds: [], fonte: null, chaveIdempotencia: null, impressao: null, ...titulo(p.valorCentavos),
          }));
        }
        return { venda, lancamento, recebiveis, repetido: false };
      });
    },

    /** Obrigação a pagar. Parcelada: UMA despesa pelo total e N obrigações cujos valores somam exatamente o total. */
    registrarObrigacao(ctx, entrada) {
      const c = validarObrigacao(entrada);
      const impressao = JSON.stringify(c);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const chave = b.chaveDe(c.fonte);
        const existente = await b.jaRegistrado(tx, cx, TIPO.OBRIGACAO, chave ? `${chave}#1` : null, impressao);
        if (existente) {
          return {
            lancamento: await tx.obter(cx, TIPO.LANCAMENTO, existente.lancamentoId),
            obrigacoes: (await tx.listar(cx, TIPO.OBRIGACAO, (o) => o.grupoId === existente.grupoId)).sort((x, y) => x.parcela.numero - y.parcela.numero),
            repetido: true,
          };
        }
        await b.exigirCompetenciaEditavel(tx, cx, c.competencia);
        await b.obterOuFalhar(tx, cx, TIPO.CONTRAPARTE, c.contraparteId, "Contraparte");
        await exigirDocumentos(tx, cx, c.documentoIds);
        const grupoId = b.gerarId();
        const lancamento = await lancar(tx, cx, {
          natureza: NATUREZA_LANCAMENTO.DESPESA, valorCentavos: c.valorOriginalCentavos, moeda: c.moeda, categoria: c.categoria,
          descricao: c.descricao, dataOperacao: c.dataEmissao, competencia: c.competencia, fonte: c.fonte,
          origem: { tipo: TIPO.OBRIGACAO, id: grupoId },
        });
        const valores = ratear(c.valorOriginalCentavos, Array(c.parcelas).fill(1));
        const obrigacoes = [];
        for (const [i, valor] of valores.entries()) {
          obrigacoes.push(await b.criar(tx, cx, TIPO.OBRIGACAO, {
            grupoId, lancamentoId: lancamento.id, contraparteId: c.contraparteId, descricao: c.descricao, moeda: c.moeda,
            competencia: c.competencia, dataEmissao: c.dataEmissao, vencimento: somarMeses(c.vencimento, i),
            parcela: { numero: i + 1, total: c.parcelas }, recorrencia: c.recorrencia, documentoIds: c.documentoIds, fonte: c.fonte,
            chaveIdempotencia: chave ? `${chave}#${i + 1}` : null, impressao: chave ? impressao : null, ...titulo(valor),
          }));
        }
        return { lancamento, obrigacoes, repetido: false };
      });
    },

    /**
     * Recebível avulso (ex.: demonstrativo de repasse). NÃO gera receita — a receita nasce da venda.
     * Cada dedução informada gera UM lançamento de DEDUCAO, com origem no próprio recebível.
     */
    registrarRecebivel(ctx, entrada) {
      const c = validarRecebivel(entrada);
      const impressao = JSON.stringify(c);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const chave = b.chaveDe(c.fonte);
        const existente = await b.jaRegistrado(tx, cx, TIPO.RECEBIVEL, chave, impressao);
        if (existente) return { recebivel: existente, lancamentosDeDeducao: await tx.listar(cx, TIPO.LANCAMENTO, (l) => l.origem?.tipo === TIPO.RECEBIVEL && l.origem.id === existente.id), repetido: true };
        await b.exigirCompetenciaEditavel(tx, cx, c.competencia);
        if (c.contraparteId) await b.obterOuFalhar(tx, cx, TIPO.CONTRAPARTE, c.contraparteId, "Contraparte");
        if (c.vendaId) await b.obterOuFalhar(tx, cx, TIPO.VENDA, c.vendaId, "Venda");
        await exigirDocumentos(tx, cx, c.documentoIds);
        const liquido = subtrair(c.brutoCentavos, somarLista(c.deducoes, (d) => d.valorCentavos));
        const recebivel = await b.criar(tx, cx, TIPO.RECEBIVEL, { ...c, pagamentoIndice: null, forma: null, chaveIdempotencia: chave, impressao: chave ? impressao : null, ...titulo(liquido) });
        const lancamentosDeDeducao = [];
        for (const [indice, d] of c.deducoes.entries()) {
          lancamentosDeDeducao.push(await lancar(tx, cx, {
            natureza: NATUREZA_LANCAMENTO.DEDUCAO, valorCentavos: d.valorCentavos, moeda: c.moeda, categoria: d.tipo,
            descricao: c.descricao ?? d.tipo, dataOperacao: c.dataPrevista, competencia: c.competencia, fonte: c.fonte,
            origem: { tipo: TIPO.RECEBIVEL, id: recebivel.id, deducaoIndice: indice },
          }));
        }
        return { recebivel, lancamentosDeDeducao, repetido: false };
      });
    },

    /**
     * Ajuste documentado no saldo de um título (juros, multa, desconto, taxa descoberta depois).
     * Gera UM lançamento: obrigação → DESPESA (sinal do ajuste); recebível → DEDUCAO (sinal invertido).
     */
    registrarAjuste(ctx, entrada) {
      const c = validarAjuste(entrada);
      return b.executar(ctx, ACAO.CORRIGIR, async (cx, tx) => {
        const tipo = c.alvoTipo === ALVO_LIQUIDACAO.OBRIGACAO ? TIPO.OBRIGACAO : TIPO.RECEBIVEL;
        const alvo = await b.obterOuFalhar(tx, cx, tipo, c.alvoId, "Título");
        const competencia = c.competencia ?? alvo.competencia;
        await b.exigirCompetenciaEditavel(tx, cx, competencia);
        if (c.documentoId) await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, c.documentoId, "Documento");
        const mudancas = aplicarAjuste(alvo, c.valorCentavos);
        const ajusteId = b.gerarId();
        const lancamento = await lancar(tx, cx, {
          natureza: tipo === TIPO.OBRIGACAO ? NATUREZA_LANCAMENTO.DESPESA : NATUREZA_LANCAMENTO.DEDUCAO,
          valorCentavos: tipo === TIPO.OBRIGACAO ? c.valorCentavos : -c.valorCentavos,
          moeda: alvo.moeda, categoria: c.categoria, descricao: c.motivo, dataOperacao: b.hoje(), competencia, fonte: null,
          origem: { tipo: TIPO.AJUSTE, id: ajusteId },
        });
        const ajuste = await b.criar(tx, cx, TIPO.AJUSTE, { id: ajusteId, alvoTipo: c.alvoTipo, alvoId: c.alvoId, valorCentavos: c.valorCentavos, motivo: c.motivo, competencia, documentoId: c.documentoId, lancamentoId: lancamento.id }, c.motivo);
        const alvoAtualizado = await b.alterar(tx, cx, tipo, alvo, mudancas, EVENTO_HISTORICO.AJUSTE, c.motivo);
        return { ajuste, lancamento, alvo: alvoAtualizado };
      });
    },

    /** Correção cadastral de obrigação (vencimento, descrição). Valor não se corrige aqui: usa-se ajuste ou cancelamento. */
    corrigirObrigacao(ctx, entrada) {
      const c = validarCorrecaoObrigacao(entrada);
      return b.executar(ctx, ACAO.CORRIGIR, async (cx, tx) => {
        const atual = await b.obterOuFalhar(tx, cx, TIPO.OBRIGACAO, c.obrigacaoId, "Obrigação");
        if (atual.situacao === SITUACAO_TITULO.CANCELADA) falhar(CODIGO.OPERACAO_INVALIDA, "Obrigação cancelada não pode ser corrigida.");
        if (c.versaoEsperada !== null && c.versaoEsperada !== atual.versao) falhar(CODIGO.CONFLITO_VERSAO, "A obrigação foi alterada por outra operação.");
        if (c.mudancas.vencimento && c.mudancas.vencimento < atual.dataEmissao) falhar(CODIGO.DATA_INVALIDA, "O vencimento não pode ser anterior à emissão.");
        await b.exigirCompetenciaEditavel(tx, cx, atual.competencia);
        return b.alterar(tx, cx, TIPO.OBRIGACAO, atual, c.mudancas, EVENTO_HISTORICO.CORRECAO, c.justificativa);
      });
    },

    /** Cancelamento LÓGICO do grupo inteiro (todas as parcelas + despesa). Recusado se alguma parcela já teve liquidação. */
    cancelarObrigacao(ctx, entrada) {
      const c = validarCancelamentoObrigacao(entrada);
      return b.executar(ctx, ACAO.CANCELAR, async (cx, tx) => {
        const alvo = await b.obterOuFalhar(tx, cx, TIPO.OBRIGACAO, c.obrigacaoId, "Obrigação");
        if (alvo.situacao === SITUACAO_TITULO.CANCELADA) falhar(CODIGO.OPERACAO_INVALIDA, "Obrigação já cancelada.");
        await b.exigirCompetenciaEditavel(tx, cx, alvo.competencia);
        const grupo = await tx.listar(cx, TIPO.OBRIGACAO, (o) => o.grupoId === alvo.grupoId);
        if (grupo.some((o) => o.liquidadoCentavos > 0)) {
          falhar(CODIGO.OPERACAO_INVALIDA, "Há pagamento vinculado. Estorne as liquidações antes de cancelar.");
        }
        const ids = new Set(grupo.map((o) => o.id));
        const ajustes = await tx.listar(cx, TIPO.AJUSTE, (a) => a.alvoTipo === ALVO_LIQUIDACAO.OBRIGACAO && ids.has(a.alvoId));
        const obrigacoes = [];
        for (const o of grupo) obrigacoes.push(await b.alterar(tx, cx, TIPO.OBRIGACAO, o, { situacao: SITUACAO_TITULO.CANCELADA }, EVENTO_HISTORICO.CANCELAMENTO, c.justificativa));
        for (const id of [alvo.lancamentoId, ...ajustes.map((a) => a.lancamentoId)]) {
          const l = await b.obterOuFalhar(tx, cx, TIPO.LANCAMENTO, id, "Lançamento");
          await b.exigirCompetenciaEditavel(tx, cx, l.competencia);
          await b.alterar(tx, cx, TIPO.LANCAMENTO, l, { situacao: SITUACAO_LANCAMENTO.CANCELADO }, EVENTO_HISTORICO.CANCELAMENTO, c.justificativa);
        }
        return { obrigacoes };
      });
    },

    reclassificarLancamento(ctx, entrada) {
      const c = validarReclassificacao(entrada);
      return b.executar(ctx, ACAO.CORRIGIR, async (cx, tx) => {
        const l = await b.obterOuFalhar(tx, cx, TIPO.LANCAMENTO, c.lancamentoId, "Lançamento");
        if (l.situacao !== SITUACAO_LANCAMENTO.ATIVO) falhar(CODIGO.OPERACAO_INVALIDA, "Lançamento cancelado não pode ser reclassificado.");
        await b.exigirCompetenciaEditavel(tx, cx, l.competencia);
        return b.alterar(tx, cx, TIPO.LANCAMENTO, l, { categoria: c.categoria }, EVENTO_HISTORICO.RECLASSIFICACAO, c.justificativa);
      });
    },
  };
}
