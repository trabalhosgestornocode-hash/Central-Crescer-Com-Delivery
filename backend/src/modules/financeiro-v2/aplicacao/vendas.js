// Vendas e seus pagamentos.
//
// Uma venda válida gera UMA receita, não importa quantos pagamentos tenha. Cada pagamento é um registro próprio e tem
// três dimensões independentes: forma (dinheiro, Pix, débito...), processador (Stone, iFood... ou nenhum) e conta de entrada.
//   com processador → nasce um RECEBÍVEL contra o processador (o dinheiro ainda não é da empresa);
//   sem processador → dinheiro/Pix direto: NÃO há recebível. Com conta informada, a entrada na conta é registrada já;
//                     sem conta, o extrato a trará depois e a conciliação fará o vínculo com a venda.
// Canal não decide nada disso: venda iFood pode ser paga na Stone, venda de balcão pode ser Pix direto.
import { CODIGO, falhar } from "../dominio/erros.js";
import {
  ALVO_ESTORNO, ALVO_LIQUIDACAO, EVENTO_HISTORICO, FORMA_PAGAMENTO, MOTIVO_ESTORNO, NATUREZA_MOVIMENTACAO, SENTIDO,
  CANAL, SITUACAO_CONCILIACAO, SITUACAO_MOVIMENTACAO, SITUACAO_PAGAMENTO, SITUACAO_TITULO, SITUACAO_VENDA, TIPO, TIPO_CONTA,
} from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { somar, somarLista, subtrair } from "../dominio/dinheiro.js";
import { CATEGORIA_DE_VENDA, CATEGORIA_DESCONTO_A_CLASSIFICAR, CATEGORIA_DEVOLUCAO } from "../dominio/planoDeContas.js";
import { competenciaDe } from "../dominio/tempo.js";
import { aplicarAjuste } from "../dominio/titulos.js";
import { MODALIDADE_DA_FORMA, SITUACAO_TAXA_ESTIMADA, calcularTaxaEstimada, resumoPorModalidade } from "../dominio/operadoras.js";
import { exigirData } from "../dominio/tempo.js";
import { exigirUmDe, semCamposDesconhecidos } from "../dominio/validacao.js";
import { validarCancelamentoVenda, validarEstornoDePagamento, validarPagamentoDeVenda, validarVenda } from "../contratos/comandos.js";
import { tituloNovo } from "./base.js";

const restante = (p) => subtrair(p.valorCentavos, p.estornadoCentavos);
/** Pendente = receita − descontos próprios (loja/pendente) − devolvido − pago. Subsídio de terceiro conta como pago (recebível dele). */
const pendenteDe = (v) => subtrair(subtrair(subtrair(v.brutoCentavos, v.descontosCentavos ?? 0), v.devolvidoCentavos), v.pagoCentavos);
const situacaoDoPagamento = (p) => {
  if (p.estornadoCentavos === 0) return SITUACAO_PAGAMENTO.VALIDO;
  return p.estornadoCentavos === p.valorCentavos ? SITUACAO_PAGAMENTO.ESTORNADO : SITUACAO_PAGAMENTO.ESTORNADO_PARCIAL;
};

/**
 * Pagamentos VÁLIDOS das vendas ativas do período (data da venda), com a taxa ESTIMADA gravada e o recebido CONFIRMADO. É a
 * base dos cards por modalidade e do calendário de faturamento: uma só fonte para os dois (nada é recalculado em outro lugar).
 */
export async function itensDoLiquidoEsperado(tx, cx, { inicio, fim, canal = null }) {
  const vendas = (await tx.listar(cx, TIPO.VENDA, { onde: { situacao: SITUACAO_VENDA.ATIVA, ...(canal ? { canal } : {}) } }))
    .filter((v) => v.dataVenda >= inicio && v.dataVenda <= fim);
  const ids = new Set(vendas.map((v) => v.id));
  const daVenda = new Map(vendas.map((v) => [v.id, v]));
  const pagamentos = (await tx.listar(cx, TIPO.PAGAMENTO_VENDA)).filter((p) => ids.has(p.vendaId) && p.situacao === SITUACAO_PAGAMENTO.VALIDO);
  const recebiveis = new Map((await tx.listar(cx, TIPO.RECEBIVEL)).filter((r) => ids.has(r.vendaId)).map((r) => [r.id, r]));
  return pagamentos.map((p) => {
    const t = p.taxaEstimada;
    const modalidade = t?.modalidade ?? MODALIDADE_DA_FORMA[p.forma] ?? p.forma;
    const rec = p.recebivelId ? recebiveis.get(p.recebivelId) : null;
    // Recebido CONFIRMADO: entrada no caixa/conta (pagamento direto) ou liquidação registrada no recebível. Nunca presumido.
    const recebidoCentavos = p.movimentacaoId ? p.valorCentavos : rec && rec.liquidadoCentavos > 0 ? rec.liquidadoCentavos : null;
    const v = daVenda.get(p.vendaId);
    return {
      modalidade, bandeira: modalidade === "PIX" ? (p.operadora ?? t?.operadora ?? p.processador ?? "DIRETO") : (t?.bandeira ?? p.bandeira ?? null), brutoCentavos: p.valorCentavos,
      situacao: t?.situacao ?? SITUACAO_TAXA_ESTIMADA.NAO_SE_APLICA, taxaCentavos: t?.taxaCentavos ?? null, liquidoEsperadoCentavos: t?.liquidoEsperadoCentavos ?? null, operadora: p.operadora ?? null, recebidoCentavos,
      venda: { id: v.id, data: v.dataVenda, descricao: v.descricao ?? null, canal: v.canal, fonte: v.fonte?.sistema ?? null }, descricaoOriginal: p.descricaoOriginal ?? null,
    };
  });
}

export function operacoesDeVendas(b) {
  async function contaDeEntrada(tx, cx, contaId, forma) {
    const conta = await b.obterOuFalhar(tx, cx, TIPO.CONTA, contaId, "Conta financeira");
    if (!conta.ativa) falhar(CODIGO.OPERACAO_INVALIDA, "Conta financeira inativa.");
    const esperado = forma === FORMA_PAGAMENTO.DINHEIRO ? TIPO_CONTA.CAIXA_FISICO : TIPO_CONTA.BANCARIA;
    if (conta.tipo !== esperado) {
      falhar(CODIGO.OPERACAO_INVALIDA, "Dinheiro entra no caixa físico; os demais recebimentos diretos entram em conta bancária.", { forma, tipoDaConta: conta.tipo });
    }
    return conta;
  }

  const movimento = (d) => ({
    moeda: "BRL", descricao: null, documentoId: null, fonte: null, transferenciaId: null, pagamentoId: null, estornoId: null,
    chaveIdempotencia: null, impressao: null, alocadoCentavos: 0, situacao: SITUACAO_MOVIMENTACAO.VALIDA,
    situacaoConciliacao: SITUACAO_CONCILIACAO.NAO_CONCILIADA, ...d,
  });

  /** Cria UM pagamento e o efeito financeiro que ele tem (recebível, entrada em conta ou nada). */
  async function criarPagamento(tx, cx, venda, p, indice, extra = {}) {
    const pagamentoId = b.gerarId();
    const dataPagamento = p.dataPagamento ?? venda.dataVenda;
    let recebivel = null;
    let movimentacao = null;
    if (p.processador) {
      recebivel = await b.criar(tx, cx, TIPO.RECEBIVEL, {
        processador: p.processador, contraparteId: null, canal: venda.canal, vendaId: venda.id, pagamentoId, pagamentoIndice: indice, forma: p.forma,
        // 07: com data de pagamento informada, o recebível é um fato do mês do pagamento; sem ela, o da venda.
        brutoCentavos: p.valorCentavos, moeda: venda.moeda, retencoes: [], dataPrevista: null, competencia: p.dataPagamento ? competenciaDe(p.dataPagamento) : venda.competencia,
        descricao: null, documentoIds: [], fonte: null, chaveIdempotencia: null, impressao: null, ...tituloNovo(p.valorCentavos),
      });
    } else if (p.contaId) {
      await contaDeEntrada(tx, cx, p.contaId, p.forma);
      b.exigirNaoFutura(dataPagamento, "dataPagamento");
      await b.exigirCompetenciaEditavel(tx, cx, competenciaDe(dataPagamento));
      movimentacao = await b.criar(tx, cx, TIPO.MOVIMENTACAO, movimento({
        contaId: p.contaId, dataEfetiva: dataPagamento, sentido: SENTIDO.ENTRADA, valorCentavos: p.valorCentavos, moeda: venda.moeda,
        natureza: NATUREZA_MOVIMENTACAO.RECEBIMENTO, descricao: `Recebimento direto de venda (${p.forma})`, pagamentoId,
      }));
    }
    // Fase 02: taxa ESTIMADA (tabela vigente na data da VENDA, versão gravada). Informativa: não lança despesa nem muda o
    // recebível — a tarifa da DRE é a efetivamente cobrada (doc 36). Só pagamentos com processador adquirente.
    const taxaEstimada = p.processador
      ? calcularTaxaEstimada({ config: await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade"), data: venda.dataVenda, processador: p.processador, operadora: p.operadora ?? null, forma: p.forma, bandeira: p.bandeira ?? null, brutoCentavos: p.valorCentavos })
      : null;
    const detalhe = {
      ...(p.bandeira ? { bandeira: p.bandeira } : {}), ...(p.descricaoOriginal ? { descricaoOriginal: p.descricaoOriginal } : {}),
      ...(taxaEstimada && taxaEstimada.situacao !== SITUACAO_TAXA_ESTIMADA.NAO_SE_APLICA ? { operadora: taxaEstimada.operadora, taxaEstimada } : p.operadora ? { operadora: p.operadora } : {}),
    };
    const pagamento = await b.criar(tx, cx, TIPO.PAGAMENTO_VENDA, {
      id: pagamentoId, vendaId: venda.id, indice, forma: p.forma, processador: p.processador, valorCentavos: p.valorCentavos, estornadoCentavos: 0,
      moeda: venda.moeda, dataPagamento, contaId: p.contaId ?? null, recebivelId: recebivel?.id ?? null, movimentacaoId: movimentacao?.id ?? null,
      situacao: SITUACAO_PAGAMENTO.VALIDO, chaveIdempotencia: null, impressao: null, ...detalhe, ...extra,
    });
    return { pagamento, recebivel, movimentacao };
  }

  const pagamentosDa = async (tx, cx, vendaId) => (await tx.listar(cx, TIPO.PAGAMENTO_VENDA, { onde: { vendaId } })).sort((x, y) => x.indice - y.indice);

  return {
    /**
     * Fase 02 — cards por modalidade × bandeira do período (data da VENDA): bruto, taxa ESTIMADA, líquido esperado e
     * percentual efetivo (dos totais). Estimativa ≠ recebido: nada aqui é conciliação nem despesa. Canal opcional.
     */
    consultarLiquidoEsperado(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, ["periodoInicio", "periodoFim", "canal", "modalidade", "chave"], "consulta");
      const inicio = exigirData(entrada.periodoInicio, "periodoInicio");
      const fim = exigirData(entrada.periodoFim, "periodoFim");
      if (fim < inicio) falhar(CODIGO.ENTRADA_INVALIDA, "Período invertido.");
      const canal = entrada.canal ? exigirUmDe(entrada.canal, CANAL, "canal") : null;
      return b.consultar(ctx, async (cx, tx) => {
        const itens = await itensDoLiquidoEsperado(tx, cx, { inicio, fim, canal });
        const base = { periodoInicio: inicio, periodoFim: fim, canal, natureza: "ESTIMATIVA", observacao: "Taxa estimada pela tabela vigente na data da venda. Não é despesa lançada nem valor recebido." };
        // Detalhe de um card: os pagamentos (e vendas) que compõem o total da modalidade/bandeira (ou operadora, no Pix).
        if (entrada.modalidade) {
          const lista = itens.filter((x) => x.modalidade === String(entrada.modalidade) && (!entrada.chave || (x.bandeira ?? "—") === String(entrada.chave)))
            .sort((a, x) => a.venda.data.localeCompare(x.venda.data));
          return { ...base, modalidade: String(entrada.modalidade), chave: entrada.chave ?? null, itens: lista.slice(0, 500), total: lista.length };
        }
        // Total do canal (todas as modalidades) calculado AQUI: a tela não soma dinheiro.
        const [total] = itens.length ? resumoPorModalidade(itens.map((x) => ({ ...x, modalidade: "TOTAL", bandeira: "TOTAL" }))) : [null];
        return { ...base, modalidades: resumoPorModalidade(itens), total };
      });
    },

    /** Venda: UM canal, zero ou mais pagamentos. Gera a receita (uma única vez) e o efeito de cada pagamento. */
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
            pagamentos: await pagamentosDa(tx, cx, existente.id),
            recebiveis: (await tx.listar(cx, TIPO.RECEBIVEL, { onde: { vendaId: existente.id } })).sort((x, y) => x.pagamentoIndice - y.pagamentoIndice),
            movimentacoes: await tx.listar(cx, TIPO.MOVIMENTACAO, (m) => m.pagamentoId && m.natureza === NATUREZA_MOVIMENTACAO.RECEBIMENTO && existente.pagamentoIds.includes(m.pagamentoId)),
            repetido: true,
          };
        }
        await b.exigirCompetenciaEditavel(tx, cx, c.competencia);
        const vendaId = b.gerarId();
        const categoria = await b.categoriaDoSistema(tx, cx, CATEGORIA_DE_VENDA[c.canal]);
        const lancamento = await b.lancar(tx, cx, categoria, {
          valorCentavos: c.brutoCentavos, moeda: c.moeda, descricao: c.descricao ?? `Venda ${c.canal}`, dataOperacao: c.dataVenda,
          competencia: c.competencia, fonte: c.fonte, canal: c.canal, origem: { tipo: TIPO.VENDA, id: vendaId },
        });
        // Descontos com efeito PRÓPRIO: da loja → dedução comercial; financiador não comprovado → dedução a classificar.
        const descontos = c.composicao?.descontos ?? [];
        // Subsídio de terceiro só é DIREITO A RECEBER com documento que comprove o ressarcimento.
        const comprovado = (d) => d.financiador === "TERCEIRO" && Boolean(d.documentoId);
        for (const d of descontos.filter(comprovado)) await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, d.documentoId, "Documento do subsídio");
        for (const d of descontos.filter((x) => !comprovado(x))) {
          const cat = d.financiador === "LOJA" ? await b.categoriaLancavel(tx, cx, "DESCONTOS_COMERCIAIS") : await b.categoriaDoSistema(tx, cx, CATEGORIA_DESCONTO_A_CLASSIFICAR);
          const financiador = d.financiador === "TERCEIRO" ? "TERCEIRO_NAO_COMPROVADO" : d.financiador;
          await b.lancar(tx, cx, cat, {
            valorCentavos: d.valorCentavos, moeda: c.moeda, descricao: d.descricao ?? `Desconto na venda (${financiador.toLowerCase()})`, dataOperacao: c.dataVenda,
            competencia: c.competencia, fonte: c.fonte, canal: c.canal,
            origem: { tipo: TIPO.VENDA, id: vendaId, componente: "DESCONTO", financiador, terceiro: d.terceiro ?? null, documentoId: d.documentoId ?? null },
          });
        }
        // Subsídio COMPROVADO: não reduz a receita; o terceiro paga essa parte (recebível dele, com o documento).
        const subsidios = descontos.filter(comprovado).map((d) => ({ forma: "OUTRA", processador: d.terceiro, valorCentavos: d.valorCentavos }));
        const todosPagamentos = [...c.pagamentos, ...subsidios];
        const base = { id: vendaId, canal: c.canal, dataVenda: c.dataVenda, competencia: c.competencia, moeda: c.moeda };
        const criados = [];
        for (const [indice, p] of todosPagamentos.entries()) criados.push(await criarPagamento(tx, cx, base, p, indice));
        const venda = await b.criar(tx, cx, TIPO.VENDA, {
          ...base, brutoCentavos: c.brutoCentavos, pagamentos: todosPagamentos, pagamentoParcial: c.pagamentoParcial === true, fonte: c.fonte,
          descricao: c.descricao, lancamentoId: lancamento.id, situacao: SITUACAO_VENDA.ATIVA,
          pagoCentavos: somarLista(todosPagamentos, (p) => p.valorCentavos), devolvidoCentavos: 0,
          descontosCentavos: somarLista(descontos.filter((x) => !comprovado(x)), (d) => d.valorCentavos), composicao: c.composicao ?? null,
          pagamentoIds: criados.map((x) => x.pagamento.id), chaveIdempotencia: chave, impressao,
        });
        return {
          venda, lancamento, pagamentos: criados.map((x) => x.pagamento), recebiveis: criados.map((x) => x.recebivel).filter(Boolean),
          movimentacoes: criados.map((x) => x.movimentacao).filter(Boolean), repetido: false,
        };
      });
    },

    /** Complemento posterior: novo pagamento de uma venda que ainda tem valor pendente. Não cria receita. */
    registrarPagamentoDeVenda(ctx, entrada) {
      const c = validarPagamentoDeVenda(entrada);
      const impressao = JSON.stringify(c);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const chave = b.chaveDe(c.fonte, `${c.vendaId}|`);
        const existente = await b.jaRegistrado(tx, cx, TIPO.PAGAMENTO_VENDA, chave, impressao);
        if (existente) return { pagamento: existente, venda: await tx.obter(cx, TIPO.VENDA, existente.vendaId), repetido: true };
        const venda = await b.obterOuFalhar(tx, cx, TIPO.VENDA, c.vendaId, "Venda");
        if (venda.situacao !== SITUACAO_VENDA.ATIVA) falhar(CODIGO.OPERACAO_INVALIDA, "Venda cancelada não recebe pagamento.");
        if (c.valorCentavos > pendenteDe(venda)) {
          falhar(CODIGO.PAGAMENTOS_NAO_FECHAM, "O pagamento supera o valor pendente da venda.", { pendenteCentavos: pendenteDe(venda) });
        }
        // 07: pagamento posterior é fato do mês do pagamento (precisa aceitar escrita); a venda, se de mês homologado, só muda
        // a posição (pago) — auditado como atualização posterior.
        const dataDoPagamento = c.dataPagamento ?? venda.dataVenda;
        b.exigirNaoFutura(dataDoPagamento, "dataPagamento");
        await b.exigirCompetenciasDoVinculo(tx, cx, { gravadas: [competenciaDe(dataDoPagamento)], referenciadas: [venda.competencia], motivo: "pagamento posterior de venda" });
        const criado = await criarPagamento(tx, cx, venda, { ...c, dataPagamento: dataDoPagamento }, venda.pagamentoIds.length, { chaveIdempotencia: chave, impressao: chave ? impressao : null });
        const vendaAtualizada = await b.alterar(tx, cx, TIPO.VENDA, venda, {
          pagoCentavos: somar(venda.pagoCentavos, c.valorCentavos), pagamentoIds: [...venda.pagamentoIds, criado.pagamento.id],
        }, EVENTO_HISTORICO.PAGAMENTO);
        return { ...criado, venda: vendaAtualizada, repetido: false };
      });
    },

    /**
     * Estorno total ou parcial de UM pagamento de venda. O pagamento original é preservado; nasce um registro de ESTORNO
     * que aponta para ele.
     *   DEVOLUCAO_AO_CLIENTE  → gera uma dedução comercial (a receita original não é apagada) e, se o dinheiro já tinha
     *                           entrado em conta, uma SAÍDA de devolução.
     *   CORRECAO_DE_PAGAMENTO → sem efeito no resultado; a venda volta a ter valor pendente para um novo pagamento.
     * Pagamento com processador: reduz o recebível. Se o repasse já foi recebido, o estorno é recusado até que a
     * liquidação seja estornada (operação compensatória).
     */
    estornarPagamentoDeVenda(ctx, entrada) {
      const c = validarEstornoDePagamento(entrada);
      return b.executar(ctx, ACAO.CANCELAR, async (cx, tx) => {
        const pag = await b.obterOuFalhar(tx, cx, TIPO.PAGAMENTO_VENDA, c.pagamentoId, "Pagamento");
        if (pag.situacao === SITUACAO_PAGAMENTO.CANCELADO || restante(pag) === 0) falhar(CODIGO.OPERACAO_INVALIDA, "Este pagamento não tem valor a estornar.");
        const valor = c.valorCentavos ?? restante(pag);
        if (valor > restante(pag)) falhar(CODIGO.OPERACAO_INVALIDA, "O estorno supera o valor ainda válido do pagamento.", { restanteCentavos: restante(pag) });
        const venda = await b.obterOuFalhar(tx, cx, TIPO.VENDA, pag.vendaId, "Venda");
        if (venda.situacao !== SITUACAO_VENDA.ATIVA) falhar(CODIGO.OPERACAO_INVALIDA, "A venda está cancelada.");
        const dataEfetiva = c.dataEfetiva ?? b.hoje();
        b.exigirNaoFutura(dataEfetiva, "dataEfetiva");
        const competencia = competenciaDe(dataEfetiva);
        // 07: o estorno é um fato do mês da data efetiva (precisa aceitar escrita). Venda e recebível de um mês homologado
        // só mudam a POSIÇÃO (pago, devolvido, saldo devido): atualização posterior auditada, sem tocar o resultado de lá.
        const recebivelDoPagamento = pag.recebivelId ? await tx.obter(cx, TIPO.RECEBIVEL, pag.recebivelId) : null;
        await b.exigirCompetenciasDoVinculo(tx, cx, { gravadas: [competencia], referenciadas: [venda.competencia, recebivelDoPagamento?.competencia], motivo: "estorno de pagamento de venda" });
        if (c.documentoId) await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, c.documentoId, "Documento");
        const devolucao = c.motivo === MOTIVO_ESTORNO.DEVOLUCAO_AO_CLIENTE;
        const estornoId = b.gerarId();

        let lancamento = null;
        if (devolucao) {
          const categoria = await b.categoriaDoSistema(tx, cx, CATEGORIA_DEVOLUCAO);
          lancamento = await b.lancar(tx, cx, categoria, {
            valorCentavos: valor, moeda: venda.moeda, descricao: c.justificativa, dataOperacao: dataEfetiva, competencia, canal: venda.canal,
            origem: { tipo: TIPO.ESTORNO, id: estornoId, vendaId: venda.id },
          });
        }

        let recebivel = null;
        let movimentacao = null;
        if (pag.recebivelId) {
          const atual = await b.obterOuFalhar(tx, cx, TIPO.RECEBIVEL, pag.recebivelId, "Recebível");
          if (valor > atual.saldoCentavos) {
            falhar(CODIGO.ESTORNO_EXIGE_COMPENSACAO, "O repasse deste pagamento já foi recebido. Estorne a liquidação antes de estornar o pagamento.", { saldoCentavos: atual.saldoCentavos });
          }
          await b.criar(tx, cx, TIPO.AJUSTE, {
            alvoTipo: ALVO_LIQUIDACAO.RECEBIVEL, alvoId: atual.id, valorCentavos: -valor, motivo: c.justificativa, competencia,
            documentoId: c.documentoId, lancamentoId: null, estornoId,
          }, c.justificativa);
          recebivel = await b.alterar(tx, cx, TIPO.RECEBIVEL, atual, aplicarAjuste(atual, -valor), EVENTO_HISTORICO.ESTORNO, c.justificativa);
        } else if (pag.movimentacaoId) {
          const original = await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, pag.movimentacaoId, "Movimentação");
          if (devolucao) {
            const conta = await contaDeEntrada(tx, cx, c.contaId ?? original.contaId, pag.forma);
            movimentacao = await b.criar(tx, cx, TIPO.MOVIMENTACAO, movimento({
              contaId: conta.id, dataEfetiva, sentido: SENTIDO.SAIDA, valorCentavos: valor, moeda: venda.moeda, natureza: NATUREZA_MOVIMENTACAO.DEVOLUCAO,
              descricao: c.justificativa, documentoId: c.documentoId, pagamentoId: pag.id, estornoId,
            }), c.justificativa);
          } else {
            // Correção: a entrada registrada estava errada. Ela é anulada por inteiro (não existe "meia entrada errada").
            if (valor !== pag.valorCentavos) falhar(CODIGO.OPERACAO_INVALIDA, "Correção de pagamento recebido direto em conta deve ser total.");
            if (original.situacaoConciliacao !== SITUACAO_CONCILIACAO.NAO_CONCILIADA) {
              falhar(CODIGO.ESTORNO_EXIGE_COMPENSACAO, "A entrada deste pagamento já está conciliada com o extrato: trate como devolução ou revise a conciliação.");
            }
            await b.exigirCompetenciaEditavel(tx, cx, competenciaDe(original.dataEfetiva));
            movimentacao = await b.alterar(tx, cx, TIPO.MOVIMENTACAO, original, { situacao: SITUACAO_MOVIMENTACAO.ESTORNADA, estornoId }, EVENTO_HISTORICO.ESTORNO, c.justificativa);
          }
        }

        const estornado = somar(pag.estornadoCentavos, valor);
        const pagamento = await b.alterar(tx, cx, TIPO.PAGAMENTO_VENDA, pag, { estornadoCentavos: estornado, situacao: situacaoDoPagamento({ ...pag, estornadoCentavos: estornado }) }, EVENTO_HISTORICO.ESTORNO, c.justificativa);
        const vendaAtualizada = await b.alterar(tx, cx, TIPO.VENDA, venda, {
          pagoCentavos: subtrair(venda.pagoCentavos, valor), devolvidoCentavos: devolucao ? somar(venda.devolvidoCentavos, valor) : venda.devolvidoCentavos,
        }, EVENTO_HISTORICO.ESTORNO, c.justificativa);
        const estorno = await b.criar(tx, cx, TIPO.ESTORNO, {
          id: estornoId, alvoTipo: ALVO_ESTORNO.PAGAMENTO_VENDA, alvoId: pag.id, valorCentavos: valor, motivo: c.motivo, justificativa: c.justificativa,
          dataEfetiva, documentoId: c.documentoId, lancamentoId: lancamento?.id ?? null, movimentacaoId: movimentacao?.id ?? null,
        }, c.justificativa);
        return { estorno, pagamento, venda: vendaAtualizada, lancamento, recebivel, movimentacao };
      });
    },

    /**
     * Cancelamento LÓGICO da venda: a venda, a receita e os pagamentos continuam gravados, marcados como cancelados.
     * Recusado enquanto houver dinheiro efetivamente recebido sem a operação compensatória:
     *   repasse já liquidado → estornar a liquidação antes;   dinheiro já em conta → estornar o pagamento (devolução) antes.
     */
    cancelarVenda(ctx, entrada) {
      const c = validarCancelamentoVenda(entrada);
      return b.executar(ctx, ACAO.CANCELAR, async (cx, tx) => {
        const venda = await b.obterOuFalhar(tx, cx, TIPO.VENDA, c.vendaId, "Venda");
        if (venda.situacao !== SITUACAO_VENDA.ATIVA) falhar(CODIGO.OPERACAO_INVALIDA, "Venda já cancelada.");
        await b.exigirCompetenciaEditavel(tx, cx, venda.competencia);
        const pagamentos = [];
        const recebiveis = [];
        for (const pag of await pagamentosDa(tx, cx, venda.id)) {
          if (pag.situacao === SITUACAO_PAGAMENTO.CANCELADO || restante(pag) === 0) { pagamentos.push(pag); continue; }
          if (pag.recebivelId) {
            const r = await b.obterOuFalhar(tx, cx, TIPO.RECEBIVEL, pag.recebivelId, "Recebível");
            if (r.liquidadoCentavos > 0) falhar(CODIGO.ESTORNO_EXIGE_COMPENSACAO, "Há repasse já recebido desta venda. Estorne a liquidação antes de cancelar.");
            recebiveis.push(await b.alterar(tx, cx, TIPO.RECEBIVEL, r, { situacao: SITUACAO_TITULO.CANCELADA }, EVENTO_HISTORICO.CANCELAMENTO, c.justificativa));
            for (const a of await tx.listar(cx, TIPO.AJUSTE, { onde: { alvoTipo: ALVO_LIQUIDACAO.RECEBIVEL, alvoId: r.id } })) {
              if (a.lancamentoId) await b.cancelarLancamento(tx, cx, a.lancamentoId, c.justificativa);
            }
          } else if (pag.movimentacaoId) {
            falhar(CODIGO.ESTORNO_EXIGE_COMPENSACAO, "Há dinheiro desta venda já recebido em conta. Estorne o pagamento (devolução) antes de cancelar.");
          }
          pagamentos.push(await b.alterar(tx, cx, TIPO.PAGAMENTO_VENDA, pag, { situacao: SITUACAO_PAGAMENTO.CANCELADO }, EVENTO_HISTORICO.CANCELAMENTO, c.justificativa));
        }
        const lancamento = await b.cancelarLancamento(tx, cx, venda.lancamentoId, c.justificativa);
        // Devoluções já lançadas desta venda deixam de reduzir receita: a receita inteira foi cancelada.
        const devolucoes = await tx.listar(cx, TIPO.LANCAMENTO, (l) => l.origem?.tipo === TIPO.ESTORNO && l.origem.vendaId === venda.id);
        for (const l of devolucoes) await b.cancelarLancamento(tx, cx, l.id, c.justificativa);
        // Descontos lançados desta venda também deixam de valer (efeito compensatório completo).
        const deducoes = await tx.listar(cx, TIPO.LANCAMENTO, (l) => l.origem?.tipo === TIPO.VENDA && l.origem.id === venda.id && l.origem.componente === "DESCONTO" && l.situacao === "ATIVO");
        for (const l of deducoes) await b.cancelarLancamento(tx, cx, l.id, c.justificativa);
        const cancelada = await b.alterar(tx, cx, TIPO.VENDA, venda, { situacao: SITUACAO_VENDA.CANCELADA, pagoCentavos: 0, devolvidoCentavos: 0 }, EVENTO_HISTORICO.CANCELAMENTO, c.justificativa);
        return { venda: cancelada, lancamento, pagamentos, recebiveis };
      });
    },
  };
}
