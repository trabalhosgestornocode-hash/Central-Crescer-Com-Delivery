// 28/11 — MOVA Operador Financeiro, FASE 2: operações ESTREITAS sobre conta a pagar EXISTENTE (migração 0037). Cada uma reutiliza a
// operação oficial do núcleo (mesmas regras, mesmo histórico) com uma ação própria e limites próprios; nada é sobrescrito nem apagado.
//   * reclassificarContaAPagar  — categoria da COMPRA inteira (o lançamento é único): mesma checagem da reclassificação oficial.
//   * ajustarValorDeContaAPagar — valor CORRETO de uma parcela: a diferença vira AJUSTE documentado (registrarAjuste); o valor original fica.
//   * moverCompetenciaDeContaAPagar — competência da compra (lançamento + parcelas) entre dois períodos abertos; caixa e datas intactos.
//   * cancelarContaAPagar       — GRUPO (compra inteira: parcelas + lançamento, como cancelarObrigacao) ou PARCELA (parcela cancelada
//                                 + ajuste negativo auditado do valor dela; o fato econômico original fica, a DRE fica líquida).
// Comum: conta de despesa (ou equipamento — IMOBILIZADO), lançamento ativo, período ABERTO ou em fechamento PRELIMINAR (com
// pendências ou homologado ⇒ Central); conjunto de parcelas e versões CONFIRMADOS (nada entra, sai ou mudou depois do resumo);
// pagamento, ajuste anterior ou parcela cancelada que torne a operação ambígua ⇒ revisão humana (OPERACAO_INVALIDA).
import { CODIGO, falhar } from "../dominio/erros.js";
import { ALVO_LIQUIDACAO, ESTADO_COMPETENCIA, EVENTO_HISTORICO, NATUREZA_LANCAMENTO, SITUACAO_LANCAMENTO, SITUACAO_TITULO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { valorDoLancamentoDeAjuste } from "../dominio/planoDeContas.js";
import { aplicarAjuste } from "../dominio/titulos.js";
import { ehProvisoria, exigeEvidencia, exigirReclassificacaoValida } from "../dominio/reclassificacao.js";
import { validarAjusteDeContaAPagar, validarCancelamentoDeContaAPagar, validarMudancaDeCompetencia, validarReclassificacaoDeConta } from "../contratos/comandos.js";

export const REVISAO_HUMANA = "Esta conta precisa de revisão humana na Central Financeira";
const PERIODOS_ESTREITOS = [ESTADO_COMPETENCIA.ABERTA, ESTADO_COMPETENCIA.FECHAMENTO_PRELIMINAR];

export function operacoesDeContaAPagarEstreita(b) {
  const elegivelNoLancamento = (l) => l?.situacao === SITUACAO_LANCAMENTO.ATIVO && l.origem?.tipo === TIPO.OBRIGACAO
    && (l.natureza === NATUREZA_LANCAMENTO.DESPESA || (l.natureza === NATUREZA_LANCAMENTO.PATRIMONIAL && l.categoria === "IMOBILIZADO"));

  /** Conta-alvo, o lançamento da compra e TODAS as parcelas do grupo (ordenadas). */
  async function carregar(tx, cx, obrigacaoId) {
    const alvo = await b.obterOuFalhar(tx, cx, TIPO.OBRIGACAO, obrigacaoId, "Conta a pagar");
    const lancamento = await b.obterOuFalhar(tx, cx, TIPO.LANCAMENTO, alvo.lancamentoId, "Lançamento");
    if (!elegivelNoLancamento(lancamento)) falhar(CODIGO.OPERACAO_INVALIDA, `${REVISAO_HUMANA}: proteção própria (empréstimo, parcelamento, entre empresas ou outra patrimonial) ou compra cancelada.`, { categoria: lancamento.categoria });
    const grupo = (await tx.listar(cx, TIPO.OBRIGACAO, { onde: { grupoId: alvo.grupoId } })).sort((x, y) => x.parcela.numero - y.parcela.numero);
    return { alvo, lancamento, grupo };
  }
  /** Período elegível para a operação estreita (aberto ou preliminar) + trava compartilhada da competência (nunca atravessa homologação). */
  async function exigirPeriodo(tx, cx, competencia) {
    const atual = await b.competenciaAtual(tx, cx, competencia);
    if (atual && !PERIODOS_ESTREITOS.includes(atual.estado)) falhar(CODIGO.COMPETENCIA_HOMOLOGADA, `O período ${competencia} está em fechamento: a alteração é pela Central.`, { competencia, estado: atual.estado });
    await b.exigirCompetenciaEditavel(tx, cx, competencia);
  }
  /** O conjunto confirmado é EXATAMENTE o atual (ids e versões). */
  function exigirVersoes(versoes, registros) {
    const ids = Object.keys(versoes);
    if (ids.length !== registros.length || registros.some((r) => versoes[r.id] !== r.versao)) falhar(CODIGO.CONFLITO_VERSAO, "A conta mudou depois do resumo. Confira de novo.", { confirmadas: ids.length, atuais: registros.length });
  }
  const semPagamento = (o) => o.situacao === SITUACAO_TITULO.ABERTA && o.liquidadoCentavos === 0;
  const limpa = (o) => o.ajustesCentavos === 0;

  return {
    /** Categoria da COMPRA inteira (lançamento único). Grupo sem ajuste nem parcela cancelada (senão os ajustes ficariam na categoria antiga). */
    reclassificarContaAPagar(ctx, entrada) {
      const c = validarReclassificacaoDeConta(entrada);
      return b.executar(ctx, ACAO.RECLASSIFICAR_CONTA_A_PAGAR, async (cx, tx) => {
        const { lancamento: l, grupo } = await carregar(tx, cx, c.obrigacaoId);
        exigirVersoes(c.versoes, [...grupo, l]);
        if (grupo.some((o) => o.situacao === SITUACAO_TITULO.CANCELADA || !limpa(o))) falhar(CODIGO.OPERACAO_INVALIDA, `${REVISAO_HUMANA}: a compra tem parcela cancelada ou ajuste.`);
        if (l.categoria === c.categoria) return { lancamento: l, repetido: true };
        await exigirPeriodo(tx, cx, l.competencia);
        const categoria = await b.categoriaLancavel(tx, cx, c.categoria);
        if (ehProvisoria(categoria.codigo) || !(categoria.natureza === NATUREZA_LANCAMENTO.DESPESA || (categoria.natureza === NATUREZA_LANCAMENTO.PATRIMONIAL && categoria.codigo === "IMOBILIZADO"))) {
          falhar(CODIGO.CATEGORIA_INVALIDA, "Pelo WhatsApp a categoria nova é de despesa ou compra de equipamentos.", { categoria: categoria.codigo });
        }
        exigirReclassificacaoValida(l, categoria);
        if (exigeEvidencia(l, categoria) && !(l.evidenciaDeClassificacao ?? []).length && !grupo.some((o) => (o.documentoIds ?? []).length)) {
          falhar(CODIGO.EVIDENCIA_EXIGIDA, "Esta categoria exige documento: vincule a evidência pela Central.", { categoria: categoria.codigo });
        }
        const lancamento = await b.alterar(tx, cx, TIPO.LANCAMENTO, l, { categoriaId: categoria.id, categoria: categoria.codigo, classificacao: categoria.classificacao, natureza: categoria.natureza },
          EVENTO_HISTORICO.RECLASSIFICACAO, c.justificativa);
        return { lancamento, repetido: false, impacto: { competencia: l.competencia, valorCentavos: l.valorCentavos, de: { categoria: l.categoria, natureza: l.natureza }, para: { categoria: categoria.codigo, natureza: categoria.natureza } } };
      });
    },

    /** Valor CORRETO de UMA parcela: diferença = ajuste documentado (lançamento próprio, mesma categoria e competência da compra). */
    ajustarValorDeContaAPagar(ctx, entrada) {
      const c = validarAjusteDeContaAPagar(entrada);
      return b.executar(ctx, ACAO.AJUSTAR_CONTA_A_PAGAR, async (cx, tx) => {
        const { alvo, lancamento: l } = await carregar(tx, cx, c.obrigacaoId);
        // a parcela E o lançamento da compra (categoria, competência e valor da compra) como vistos no resumo
        exigirVersoes({ [alvo.id]: c.versaoEsperada, [l.id]: c.versaoLancamento }, [alvo, l]);
        if (![SITUACAO_TITULO.ABERTA, SITUACAO_TITULO.PARCIAL].includes(alvo.situacao)) falhar(CODIGO.OPERACAO_INVALIDA, `${REVISAO_HUMANA}: a parcela está ${alvo.situacao.toLowerCase()}.`);
        const anterior = alvo.valorBaseCentavos + alvo.ajustesCentavos;
        const diferenca = c.valorCorretoCentavos - anterior;
        if (diferenca === 0) return { semMudanca: true, obrigacao: alvo, anteriorCentavos: anterior, corretoCentavos: c.valorCorretoCentavos, diferencaCentavos: 0 };
        // nunca abaixo do que já foi pago; igual ao pago quitaria a conta por ajuste ⇒ revisão humana
        if (c.valorCorretoCentavos <= alvo.liquidadoCentavos) falhar(CODIGO.OPERACAO_INVALIDA, `${REVISAO_HUMANA}: o valor correto não pode ser igual ou menor que o já pago.`, { pagoCentavos: alvo.liquidadoCentavos });
        await exigirPeriodo(tx, cx, l.competencia);
        const categoria = await b.categoriaLancavel(tx, cx, l.categoria);
        const ajusteId = b.gerarId();
        const lanc = await b.lancar(tx, cx, categoria, {
          valorCentavos: valorDoLancamentoDeAjuste(true, categoria.natureza, diferenca), moeda: alvo.moeda, descricao: c.justificativa, dataOperacao: b.hoje(), competencia: l.competencia,
          canal: alvo.canal ?? null, retidoNoRepasse: false, origem: { tipo: TIPO.AJUSTE, id: ajusteId },
        }, { documentado: false });
        const ajuste = await b.criar(tx, cx, TIPO.AJUSTE, { id: ajusteId, alvoTipo: ALVO_LIQUIDACAO.OBRIGACAO, alvoId: alvo.id, valorCentavos: diferenca, motivo: c.justificativa, competencia: l.competencia, documentoId: null, lancamentoId: lanc.id, estornoId: null }, c.justificativa);
        const obrigacao = await b.alterar(tx, cx, TIPO.OBRIGACAO, alvo, aplicarAjuste(alvo, diferenca), EVENTO_HISTORICO.AJUSTE, c.justificativa);
        if (obrigacao.situacao !== alvo.situacao || obrigacao.saldoCentavos <= 0) falhar(CODIGO.OPERACAO_INVALIDA, `${REVISAO_HUMANA}: o ajuste mudaria a situação da conta.`);
        return { semMudanca: false, obrigacao, ajuste, lancamento: lanc, anteriorCentavos: anterior, corretoCentavos: c.valorCorretoCentavos, diferencaCentavos: diferenca };
      });
    },

    /** Competência da COMPRA (lançamento + todas as parcelas) para outro período aberto. Sem pagamento, ajuste nem parcela cancelada. */
    moverCompetenciaDeContaAPagar(ctx, entrada) {
      const c = validarMudancaDeCompetencia(entrada);
      return b.executar(ctx, ACAO.MOVER_COMPETENCIA_CONTA_A_PAGAR, async (cx, tx) => {
        const { lancamento: l, grupo } = await carregar(tx, cx, c.obrigacaoId);
        exigirVersoes(c.versoes, [...grupo, l]);
        if (!grupo.every((o) => semPagamento(o) && limpa(o))) falhar(CODIGO.OPERACAO_INVALIDA, `${REVISAO_HUMANA}: a compra tem pagamento, ajuste ou parcela cancelada.`);
        if (l.competencia === c.competencia) return { repetido: true, lancamento: l, obrigacoes: grupo };
        for (const comp of [l.competencia, c.competencia].sort()) await exigirPeriodo(tx, cx, comp);
        const obrigacoes = [];
        for (const o of grupo) obrigacoes.push(await b.alterar(tx, cx, TIPO.OBRIGACAO, o, { competencia: c.competencia }, EVENTO_HISTORICO.CORRECAO, c.justificativa));
        const lancamento = await b.alterar(tx, cx, TIPO.LANCAMENTO, l, { competencia: c.competencia }, EVENTO_HISTORICO.CORRECAO, c.justificativa);
        return { repetido: false, lancamento, obrigacoes, impacto: { de: l.competencia, para: c.competencia, valorCentavos: l.valorCentavos, categoria: l.categoria, natureza: l.natureza } };
      });
    },

    /** GRUPO: compra inteira (parcelas + lançamento + lançamentos de ajuste). PARCELA: só ela, com ajuste negativo auditado do valor dela. */
    cancelarContaAPagar(ctx, entrada) {
      const c = validarCancelamentoDeContaAPagar(entrada);
      return b.executar(ctx, ACAO.CANCELAR_CONTA_A_PAGAR, async (cx, tx) => {
        const { alvo, lancamento: l, grupo } = await carregar(tx, cx, c.obrigacaoId);
        const vivas = grupo.filter((o) => o.situacao !== SITUACAO_TITULO.CANCELADA);
        if (c.abrangencia === "GRUPO") {
          exigirVersoes(c.versoes, [...vivas, l]);
          if (!vivas.every(semPagamento) || grupo.some((o) => o.liquidadoCentavos > 0)) falhar(CODIGO.OPERACAO_INVALIDA, `${REVISAO_HUMANA}: a compra tem pagamento (estorno e cancelamento pela Central).`);
          await exigirPeriodo(tx, cx, l.competencia);
          for (const comp of [...new Set(vivas.map((o) => o.competencia))]) if (comp !== l.competencia) await exigirPeriodo(tx, cx, comp);
          const obrigacoes = [];
          for (const o of vivas) obrigacoes.push(await b.alterar(tx, cx, TIPO.OBRIGACAO, o, { situacao: SITUACAO_TITULO.CANCELADA }, EVENTO_HISTORICO.CANCELAMENTO, c.justificativa));
          for (const o of grupo) for (const a of await tx.listar(cx, TIPO.AJUSTE, { onde: { alvoTipo: ALVO_LIQUIDACAO.OBRIGACAO, alvoId: o.id } })) if (a.lancamentoId) await b.cancelarLancamento(tx, cx, a.lancamentoId, c.justificativa);
          const lancamento = await b.cancelarLancamento(tx, cx, l.id, c.justificativa);
          return { abrangencia: "GRUPO", obrigacoes, lancamento, valorCentavos: vivas.reduce((s, o) => s + o.valorBaseCentavos + o.ajustesCentavos, 0) };
        }
        // PARCELA: só a escolhida; a compra continua (outras parcelas intactas)
        exigirVersoes(c.versoes, [alvo, l]); // a parcela E o lançamento da compra (impacto mostrado no resumo)
        if (!semPagamento(alvo)) falhar(CODIGO.OPERACAO_INVALIDA, `${REVISAO_HUMANA}: a parcela tem pagamento ou já está cancelada.`);
        if (vivas.length < 2) falhar(CODIGO.OPERACAO_INVALIDA, "É a única parcela da compra: cancele a compra inteira.");
        await exigirPeriodo(tx, cx, l.competencia);
        const valor = alvo.valorBaseCentavos + alvo.ajustesCentavos;
        const categoria = await b.categoriaLancavel(tx, cx, l.categoria);
        const ajusteId = b.gerarId();
        const motivo = `Cancelamento da parcela ${alvo.parcela.numero}/${alvo.parcela.total}: ${c.justificativa}`.slice(0, 500);
        const lanc = await b.lancar(tx, cx, categoria, {
          valorCentavos: valorDoLancamentoDeAjuste(true, categoria.natureza, -valor), moeda: alvo.moeda, descricao: motivo, dataOperacao: b.hoje(), competencia: l.competencia,
          canal: alvo.canal ?? null, retidoNoRepasse: false, origem: { tipo: TIPO.AJUSTE, id: ajusteId },
        }, { documentado: false });
        const ajuste = await b.criar(tx, cx, TIPO.AJUSTE, { id: ajusteId, alvoTipo: ALVO_LIQUIDACAO.OBRIGACAO, alvoId: alvo.id, valorCentavos: -valor, motivo, competencia: l.competencia, documentoId: null, lancamentoId: lanc.id, estornoId: null }, motivo);
        const obrigacao = await b.alterar(tx, cx, TIPO.OBRIGACAO, alvo, { ...aplicarAjuste(alvo, -valor), situacao: SITUACAO_TITULO.CANCELADA }, EVENTO_HISTORICO.CANCELAMENTO, motivo);
        return { abrangencia: "PARCELA", obrigacoes: [obrigacao], ajuste, lancamentoDoAjuste: lanc, valorCentavos: valor };
      });
    },
  };
}
