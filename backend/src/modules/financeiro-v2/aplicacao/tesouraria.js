// Tesouraria (Execução 06A): consultas de contas a pagar/receber, caixa e bancos, calendário, fluxo de caixa e resumo da
// Visão Geral — todas somente leitura e todas calculadas pelas MESMAS regras de dominio/tesouraria.js.
// Escritas novas: saldo INFORMADO de conta (âncora documentada) e sessão de caixa físico (abertura, operações, fechamento).
// Nenhuma delas cria lançamento econômico; diferença de caixa é registrada e NUNCA ajustada automaticamente.
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, NATUREZA_MOVIMENTACAO, OPERACAO_CAIXA, SENTIDO, SITUACAO_SESSAO_CAIXA, TIPO, TIPO_CONTA } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { subtrair } from "../dominio/dinheiro.js";
import { competenciaDe } from "../dominio/tempo.js";
import {
  caixaEBancos, calendarioFinanceiro, contasAPagar, contasAReceber, fluxoDeCaixa, preparar, resumoFinanceiro, teoricoDaSessao, tituloAPagar, tituloAReceber,
} from "../dominio/tesouraria.js";
import {
  validarAberturaDeCaixa, validarDetalheDeTitulo, validarFechamentoDeCaixa, validarFiltroAPagar, validarFiltroAReceber, validarFiltroCaixaEBancos,
  validarFiltroCalendario, validarFiltroFluxo, validarFiltroResumo, validarOperacaoDeCaixa, validarSaldoDeConta,
} from "../contratos/tesouraria.js";
import { baseNaTransacao } from "./base.js";
import { operacoesDeCaixa } from "./caixa.js";

const ROTULO = Object.freeze({ ENTRADA: "Entrada de dinheiro", SAIDA: "Saída de dinheiro", SANGRIA: "Sangria", SUPRIMENTO: "Suprimento" });

export function operacoesDeTesouraria(b) {
  /** Registros do escopo usados pelas consultas. O repositório já filtra por organização + unidade. */
  async function carregar(cx, tx) {
    const l = (tipo) => tx.listar(cx, tipo);
    return {
      contas: await l(TIPO.CONTA), saldos: await l(TIPO.SALDO_CONTA), movimentacoes: await l(TIPO.MOVIMENTACAO), transferencias: await l(TIPO.TRANSFERENCIA),
      liquidacoes: await l(TIPO.LIQUIDACAO), obrigacoes: await l(TIPO.OBRIGACAO), recebiveis: await l(TIPO.RECEBIVEL), contrapartes: await l(TIPO.CONTRAPARTE),
      lancamentos: await l(TIPO.LANCAMENTO), categorias: await l(TIPO.CATEGORIA), ajustes: await l(TIPO.AJUSTE), correspondencias: await l(TIPO.CORRESPONDENCIA),
      sessoes: await l(TIPO.SESSAO_CAIXA), documentos: await l(TIPO.DOCUMENTO), vinculos: await l(TIPO.VINCULO_DOCUMENTAL), pagamentos: await l(TIPO.PAGAMENTO_VENDA),
      competencias: await l(TIPO.COMPETENCIA),
    };
  }
  const consulta = (validar, calcular) => (ctx, e) => {
    const filtro = validar(e);
    return b.consultar(ctx, async (cx, tx) => calcular(await carregar(cx, tx), b.hoje(), filtro));
  };

  /** Histórico de um registro em linguagem de gestão: o que mudou no saldo e na situação, quando e por quê. */
  async function historicoDe(cx, tx, tipo, id) {
    return (await tx.listarHistorico(cx, { onde: { registroTipo: tipo, registroId: id } })).map((h) => ({
      evento: h.evento, em: h.em, justificativa: h.justificativa ?? null,
      saldoAntesCentavos: h.antes?.saldoCentavos ?? null, saldoDepoisCentavos: h.depois?.saldoCentavos ?? null,
      situacaoAntes: h.antes?.situacao ?? null, situacaoDepois: h.depois?.situacao ?? null,
      vencimentoAntes: h.antes && h.antes.vencimento !== h.depois?.vencimento ? h.antes.vencimento ?? null : null, vencimentoDepois: h.antes && h.antes.vencimento !== h.depois?.vencimento ? h.depois?.vencimento ?? null : null,
    }));
  }

  async function sessaoAberta(tx, cx, id) {
    const s = await b.obterOuFalhar(tx, cx, TIPO.SESSAO_CAIXA, id, "Sessão de caixa");
    if (s.situacao !== SITUACAO_SESSAO_CAIXA.ABERTA) falhar(CODIGO.OPERACAO_INVALIDA, "A sessão de caixa já está fechada.");
    return s;
  }

  return {
    // ----------------------------------------------------------------------------------------------------- consultas
    consultarContasAPagar: consulta(validarFiltroAPagar, contasAPagar),
    consultarContasAReceber: consulta(validarFiltroAReceber, contasAReceber),
    consultarCaixaEBancos: consulta(validarFiltroCaixaEBancos, caixaEBancos),
    consultarFluxoDeCaixa: consulta(validarFiltroFluxo, fluxoDeCaixa),
    consultarCalendarioFinanceiro: consulta(validarFiltroCalendario, calendarioFinanceiro),
    consultarResumoFinanceiro: consulta(validarFiltroResumo, resumoFinanceiro),

    /** Conta a pagar → parcelas do mesmo grupo → pagamentos → documentos → histórico. */
    detalharContaAPagar(ctx, e) {
      const { id } = validarDetalheDeTitulo(e);
      return b.consultar(ctx, async (cx, tx) => {
        const p = preparar(await carregar(cx, tx));
        const o = p.obrigacaoPorId.get(id);
        if (!o) falhar(CODIGO.NAO_ENCONTRADO, "Conta a pagar não encontrada.");
        const lancamento = p.lancamentoPorId.get(o.lancamentoId) ?? null;
        return {
          dataBase: b.hoje(), titulo: tituloAPagar(p, o, b.hoje()),
          parcelas: p.obrigacoes.filter((x) => x.grupoId === o.grupoId).sort((x, y) => x.parcela.numero - y.parcela.numero).map((x) => tituloAPagar(p, x, b.hoje())),
          // UM lançamento econômico pelo grupo inteiro: pagar parcelas nunca cria outro.
          lancamento: lancamento ? { valorCentavos: lancamento.valorCentavos, categoria: lancamento.categoria, classificacao: lancamento.classificacao, natureza: lancamento.natureza, competencia: lancamento.competencia, situacao: lancamento.situacao } : null,
          historico: await historicoDe(cx, tx, TIPO.OBRIGACAO, id),
        };
      });
    },

    /** Recebível → composição (bruto, retenções, ajustes) → recebimentos → documentos → histórico. */
    detalharContaAReceber(ctx, e) {
      const { id } = validarDetalheDeTitulo(e);
      return b.consultar(ctx, async (cx, tx) => {
        const p = preparar(await carregar(cx, tx));
        const r = p.recebivelPorId.get(id);
        if (!r) falhar(CODIGO.NAO_ENCONTRADO, "Conta a receber não encontrada.");
        return { dataBase: b.hoje(), titulo: tituloAReceber(p, r, b.hoje()), historico: await historicoDe(cx, tx, TIPO.RECEBIVEL, id) };
      });
    },

    // ------------------------------------------------------------------------------------------------ saldo informado
    /**
     * Registra o saldo de uma conta no INÍCIO de um dia, como informado por extrato ou contagem. É o ponto de partida do
     * saldo calculado; um segundo saldo informado não corrige nada: a diferença para o calculado aparece na consulta.
     */
    registrarSaldoDeConta(ctx, entrada) {
      const c = validarSaldoDeConta(entrada);
      const impressao = JSON.stringify(c);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const chave = `saldo:${c.contaId}:${c.data}`;
        const existente = await b.jaRegistrado(tx, cx, TIPO.SALDO_CONTA, chave, impressao);
        if (existente) return { saldo: existente, repetido: true };
        const conta = await b.obterOuFalhar(tx, cx, TIPO.CONTA, c.contaId, "Conta financeira");
        if (conta.tipo === TIPO_CONTA.CAIXA_FISICO && c.valorCentavos < 0) falhar(CODIGO.VALOR_INVALIDO, "Caixa físico não tem saldo negativo.", { campo: "valorCentavos" });
        b.exigirNaoFutura(c.data, "data");
        if (c.documentoId) await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, c.documentoId, "Documento");
        return { saldo: await b.criar(tx, cx, TIPO.SALDO_CONTA, { ...c, chaveIdempotencia: chave, impressao }), repetido: false };
      });
    },

    // --------------------------------------------------------------------------------------------------- caixa físico
    /** Abre a sessão com o dinheiro CONTADO na gaveta. Uma sessão aberta por caixa; sessões não se sobrepõem em datas. */
    abrirCaixa(ctx, entrada) {
      const c = validarAberturaDeCaixa(entrada);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        await tx.travar(cx, `caixa:${c.contaId}`, "EXCLUSIVA");
        const conta = await b.obterOuFalhar(tx, cx, TIPO.CONTA, c.contaId, "Conta financeira");
        if (conta.tipo !== TIPO_CONTA.CAIXA_FISICO || !conta.ativa) falhar(CODIGO.OPERACAO_INVALIDA, "Sessão de caixa só existe em conta de caixa físico ativa.");
        b.exigirNaoFutura(c.dataAbertura, "dataAbertura");
        await b.exigirCompetenciaEditavel(tx, cx, competenciaDe(c.dataAbertura));
        const sessoes = await tx.listar(cx, TIPO.SESSAO_CAIXA, { onde: { contaId: c.contaId } });
        if (sessoes.some((s) => s.situacao === SITUACAO_SESSAO_CAIXA.ABERTA)) falhar(CODIGO.OPERACAO_INVALIDA, "Já existe uma sessão aberta neste caixa. Feche-a antes de abrir outra.");
        if (sessoes.some((s) => s.dataFechamento >= c.dataAbertura)) falhar(CODIGO.DATA_INVALIDA, "A abertura precisa ser posterior ao último fechamento deste caixa.", { campo: "dataAbertura" });
        const sessao = await b.criar(tx, cx, TIPO.SESSAO_CAIXA, {
          ...c, situacao: SITUACAO_SESSAO_CAIXA.ABERTA, operacoes: [], dataFechamento: null, entradasCentavos: null, saidasCentavos: null,
          teoricoCentavos: null, contadoCentavos: null, diferencaCentavos: null, justificativa: null, fechadoPor: null, fechadoEm: null,
        });
        return { sessao };
      });
    },

    /**
     * Entrada, saída, sangria ou suprimento de dinheiro numa sessão aberta. Cria a movimentação (ou a transferência interna,
     * quando há conta de contrapartida) na MESMA transação. Não classifica como receita nem despesa: dinheiro que sai sem
     * destino identificado fica como movimentação sem vínculo, pendente de classificação.
     */
    registrarOperacaoDeCaixa(ctx, entrada) {
      const c = validarOperacaoDeCaixa(entrada);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const sessao = await sessaoAberta(tx, cx, c.sessaoId);
        if (c.data < sessao.dataAbertura) falhar(CODIGO.DATA_INVALIDA, "A operação não pode ser anterior à abertura do caixa.", { campo: "data" });
        const caixa = operacoesDeCaixa(baseNaTransacao(b, tx, cx));
        const entra = c.operacao === OPERACAO_CAIXA.ENTRADA || c.operacao === OPERACAO_CAIXA.SUPRIMENTO;
        const descricao = `${ROTULO[c.operacao]}: ${c.descricao}`;
        let movimentacaoId = null;
        let transferenciaId = null;
        if (c.contraContaId) {
          const t = await caixa.registrarTransferencia(cx, {
            contaOrigemId: entra ? c.contraContaId : sessao.contaId, contaDestinoId: entra ? sessao.contaId : c.contraContaId,
            valorCentavos: c.valorCentavos, dataEfetiva: c.data, descricao,
          });
          transferenciaId = t.transferencia.id;
        } else {
          const m = await caixa.registrarMovimentacao(cx, {
            contaId: sessao.contaId, dataEfetiva: c.data, sentido: entra ? SENTIDO.ENTRADA : SENTIDO.SAIDA, valorCentavos: c.valorCentavos,
            natureza: NATUREZA_MOVIMENTACAO.OUTRA, descricao,
          });
          movimentacaoId = m.movimentacao.id;
        }
        const operacao = { operacao: c.operacao, valorCentavos: c.valorCentavos, data: c.data, descricao: c.descricao, movimentacaoId, transferenciaId, registradoEm: b.agora() };
        const atualizada = await b.alterar(tx, cx, TIPO.SESSAO_CAIXA, sessao, { operacoes: [...sessao.operacoes, operacao] }, EVENTO_HISTORICO.OPERACAO_DE_CAIXA, descricao);
        return { sessao: atualizada, operacao };
      });
    },

    /**
     * Fecha a sessão comparando o TEÓRICO (abertura + movimentações da conta no período) com o CONTADO. A diferença fica
     * registrada com justificativa obrigatória; nenhum ajuste, lançamento ou movimentação é criado para "zerar" o caixa.
     */
    fecharCaixa(ctx, entrada) {
      const c = validarFechamentoDeCaixa(entrada);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const sessao = await sessaoAberta(tx, cx, c.sessaoId);
        await tx.travar(cx, `caixa:${sessao.contaId}`, "EXCLUSIVA");
        if (c.dataFechamento < sessao.dataAbertura) falhar(CODIGO.DATA_INVALIDA, "O fechamento não pode ser anterior à abertura.", { campo: "dataFechamento" });
        b.exigirNaoFutura(c.dataFechamento, "dataFechamento");
        await b.exigirCompetenciaEditavel(tx, cx, competenciaDe(c.dataFechamento));
        const movimentacoes = await tx.listar(cx, TIPO.MOVIMENTACAO, { onde: { contaId: sessao.contaId } });
        const t = teoricoDaSessao(movimentacoes, sessao, c.dataFechamento);
        const diferencaCentavos = subtrair(c.contadoCentavos, t.teoricoCentavos);
        if (diferencaCentavos !== 0 && !c.justificativa) {
          falhar(CODIGO.ENTRADA_INVALIDA, "Há diferença entre o contado e o teórico: informe a justificativa.", { campo: "justificativa", diferencaCentavos });
        }
        const fechada = await b.alterar(tx, cx, TIPO.SESSAO_CAIXA, sessao, {
          situacao: SITUACAO_SESSAO_CAIXA.FECHADA, dataFechamento: c.dataFechamento, entradasCentavos: t.entradasCentavos, saidasCentavos: t.saidasCentavos,
          teoricoCentavos: t.teoricoCentavos, contadoCentavos: c.contadoCentavos, diferencaCentavos, justificativa: c.justificativa, fechadoPor: cx.usuarioId, fechadoEm: b.agora(),
        }, EVENTO_HISTORICO.FECHAMENTO_DE_CAIXA, c.justificativa);
        return { sessao: fechada, teoricoCentavos: t.teoricoCentavos, contadoCentavos: c.contadoCentavos, diferencaCentavos };
      });
    },
  };
}
