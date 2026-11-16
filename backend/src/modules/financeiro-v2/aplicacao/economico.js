// Operações ECONÔMICAS de títulos: o que a empresa deve e tem a receber. Nenhuma delas movimenta dinheiro.
// Cada fato econômico gera UM lançamento; pagar ou receber depois (liquidação) nunca gera outro.
// A natureza de cada lançamento vem da CATEGORIA do plano de contas — nunca do fato de ter sido "descontado do repasse".
import { CODIGO, falhar } from "../dominio/erros.js";
import { ALVO_LIQUIDACAO, EVENTO_HISTORICO, NATUREZA_LANCAMENTO, SITUACAO_LANCAMENTO, SITUACAO_TITULO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { ratear, somarLista, subtrair } from "../dominio/dinheiro.js";
import { CATEGORIA_DESPESA_A_CLASSIFICAR, CATEGORIA_TITULOS_ANTERIORES, valorDoLancamentoDeAjuste } from "../dominio/planoDeContas.js";
import { somarMeses } from "../dominio/tempo.js";
import { aplicarAjuste } from "../dominio/titulos.js";
import {
  validarAjuste, validarCancelamentoObrigacao, validarCancelamentoRecebivel, validarConta, validarContraparte, validarCorrecaoLancamento,
  validarCorrecaoObrigacao, validarObrigacao, validarRecebivel,
} from "../contratos/comandos.js";
import { tituloNovo } from "./base.js";

const DO_SISTEMA_NA_OBRIGACAO = Object.freeze([CATEGORIA_DESPESA_A_CLASSIFICAR, CATEGORIA_TITULOS_ANTERIORES]);
/** "Unicred ", "unicred" e "Unicréd" são a mesma conta. */
const nomeNormalizado = (t) => String(t ?? "").normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

export function operacoesEconomicas(b) {
  /** Cancela os lançamentos nascidos de ajustes de um conjunto de títulos (juros, taxas, descontos). */
  async function cancelarLancamentosDeAjustes(tx, cx, alvoTipo, ids, justificativa) {
    for (const id of ids) {
      for (const a of await tx.listar(cx, TIPO.AJUSTE, { onde: { alvoTipo, alvoId: id } })) {
        if (a.lancamentoId) await b.cancelarLancamento(tx, cx, a.lancamentoId, justificativa);
      }
    }
  }

  /** Abertura configurada, em andamento e da MESMA competência (posição de abertura nunca entra em outra competência). */
  async function exigirAberturaPara(tx, cx, competencia) {
    const ab = await tx.buscarPorChave(cx, TIPO.ABERTURA, "abertura");
    if (!ab) falhar(CODIGO.OPERACAO_INVALIDA, "Configure a abertura financeira (competência de início) antes de registrar títulos anteriores.", { motivo: "ABERTURA_NAO_CONFIGURADA" });
    if (ab.situacao !== "CONFIGURADA") falhar(CODIGO.OPERACAO_INVALIDA, "A abertura já foi concluída: novos títulos anteriores exigem reabri-la.", { motivo: "ABERTURA_CONCLUIDA" });
    if (competencia !== ab.competenciaInicio) falhar(CODIGO.OPERACAO_INVALIDA, `Título anterior entra na competência de início da abertura (${ab.competenciaInicio}).`, { motivo: "COMPETENCIA_DIFERENTE_DA_ABERTURA" });
    return ab;
  }

  /** Fornecedor/cliente digitado no formulário: reaproveita o MESMO cadastro (tipo + nome normalizado), nunca duplica. */
  async function contraparteDoFormulario(tx, cx, nova) {
    await tx.travar(cx, "contrapartes", "EXCLUSIVA");
    const igual = (await tx.listar(cx, TIPO.CONTRAPARTE)).find((x) => x.tipo === nova.tipo && nomeNormalizado(x.nome) === nomeNormalizado(nova.nome));
    return igual ?? b.criar(tx, cx, TIPO.CONTRAPARTE, nova);
  }

  return {
    /**
     * Cadastra uma conta (Unicred, caixa físico, outras). Nunca recebe saldo: saldo é registrado à parte, com referência.
     * Sem duplicidade: dentro da trava da unidade, o mesmo nome (sem diferença de maiúsculas, acentos ou espaços) já
     * cadastrado devolve a conta existente quando é a MESMA conta (reenvio) e é recusado quando difere no tipo/instituição.
     */
    configurarContaFinanceira(ctx, entrada) {
      const c = validarConta(entrada);
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        await tx.travar(cx, "contas-financeiras", "EXCLUSIVA");
        const igual = (await tx.listar(cx, TIPO.CONTA)).find((x) => nomeNormalizado(x.nome) === nomeNormalizado(c.nome));
        if (igual) {
          if (igual.tipo === c.tipo && (igual.instituicao ?? null) === (c.instituicao ?? null)) return { ...igual, repetido: true };
          falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "Já existe uma conta com este nome. Use outro nome ou altere a conta existente.", { contaId: igual.id });
        }
        return b.criar(tx, cx, TIPO.CONTA, { ...c, ativa: true });
      });
    },

    registrarContraparte(ctx, entrada) {
      const c = validarContraparte(entrada);
      return b.executar(ctx, ACAO.REGISTRAR, (cx, tx) => b.criar(tx, cx, TIPO.CONTRAPARTE, c));
    },

    /**
     * Obrigação a pagar. Parcelada: UM lançamento pelo total e N obrigações cujos valores somam exatamente o total.
     * A categoria decide a natureza: despesa/custo, dedução (tributo sobre venda) ou patrimonial (sem efeito no resultado).
     */
    registrarObrigacao(ctx, entrada) {
      const c = validarObrigacao(entrada);
      const impressao = JSON.stringify(c);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const chave = b.chaveDe(c.fonte);
        const existente = await b.jaRegistrado(tx, cx, TIPO.OBRIGACAO, chave ? `${chave}#1` : null, impressao);
        if (existente) {
          return {
            lancamento: await tx.obter(cx, TIPO.LANCAMENTO, existente.lancamentoId),
            obrigacoes: (await tx.listar(cx, TIPO.OBRIGACAO, { onde: { grupoId: existente.grupoId } })).sort((x, y) => x.parcela.numero - y.parcela.numero),
            repetido: true,
          };
        }
        await b.exigirCompetenciaEditavel(tx, cx, c.competencia);
        // Abertura (opção B): a dívida anterior é POSIÇÃO INICIAL do passivo, nunca despesa da competência de início. Só com a
        // abertura CONFIGURADA da unidade (competência e corte persistidos), nunca pelo que veio no formulário.
        if (c.categoria === CATEGORIA_TITULOS_ANTERIORES) {
          const ab = await exigirAberturaPara(tx, cx, c.competencia);
          if (c.dataEmissao > ab.dataDeCorte) falhar(CODIGO.DATA_INVALIDA, `Título anterior à abertura tem emissão até ${ab.dataDeCorte} (data de corte).`, { campo: "dataEmissao" });
          if (c.parcelas !== 1 || c.recorrencia) falhar(CODIGO.ENTRADA_INVALIDA, "Título anterior à abertura entra um por documento, pelo saldo em aberto (sem parcelar nem repetir).", { campo: "parcelas" });
        }
        // doc 33: o identificador (NF, boleto) vale para QUALQUER conta a pagar — é o que torna inequívoca a baixa pelo extrato.
        if (c.contraparteNova) c.contraparteId = (await contraparteDoFormulario(tx, cx, c.contraparteNova)).id; // mesma transação
        else await b.obterOuFalhar(tx, cx, TIPO.CONTRAPARTE, c.contraparteId, "Contraparte");
        await b.exigirDocumentos(tx, cx, c.documentoIds);
        // "A classificar" e "títulos anteriores" são categorias do sistema: existem mesmo em plano implantado antes delas.
        const categoria = DO_SISTEMA_NA_OBRIGACAO.includes(c.categoria) ? await b.categoriaDoSistema(tx, cx, c.categoria) : await b.categoriaLancavel(tx, cx, c.categoria);
        if (categoria.natureza === NATUREZA_LANCAMENTO.RECEITA) {
          falhar(CODIGO.CATEGORIA_INVALIDA, "Uma obrigação a pagar não pode ser classificada como receita.", { categoria: categoria.codigo });
        }
        const grupoId = b.gerarId();
        const lancamento = await b.lancar(tx, cx, categoria, {
          valorCentavos: c.valorOriginalCentavos, moeda: c.moeda, descricao: c.descricao, dataOperacao: c.dataEmissao,
          competencia: c.competencia, fonte: c.fonte, origem: { tipo: TIPO.OBRIGACAO, id: grupoId },
        }, { documentado: c.documentoIds.length > 0 });
        const valores = ratear(c.valorOriginalCentavos, Array(c.parcelas).fill(1));
        const obrigacoes = [];
        for (const [i, valor] of valores.entries()) {
          obrigacoes.push(await b.criar(tx, cx, TIPO.OBRIGACAO, {
            grupoId, lancamentoId: lancamento.id, contraparteId: c.contraparteId, descricao: c.descricao, moeda: c.moeda,
            competencia: c.competencia, dataEmissao: c.dataEmissao, vencimento: somarMeses(c.vencimento, i),
            parcela: { numero: i + 1, total: c.parcelas }, recorrencia: c.recorrencia, documentoIds: c.documentoIds, fonte: c.fonte,
            ...(c.identificador ? { identificador: c.identificador } : {}),
            chaveIdempotencia: chave ? `${chave}#${i + 1}` : null, impressao: chave ? impressao : null, ...tituloNovo(valor),
          }));
        }
        return { lancamento, obrigacoes, repetido: false };
      });
    },

    /**
     * Recebível avulso (ex.: demonstrativo de repasse). NÃO gera receita — a receita nasce da venda.
     * Cada RETENÇÃO gera UM lançamento na categoria informada: a natureza econômica é a da categoria
     * (comissão = despesa comercial, taxa = despesa de recebimento, desconto comercial = dedução...).
     * O lançamento fica marcado como `retidoNoRepasse`, o que permite a visão de faturamento líquido do canal
     * sem contar o mesmo valor duas vezes no resultado.
     */
    registrarRecebivel(ctx, entrada) {
      const c = validarRecebivel(entrada);
      const impressao = JSON.stringify(c);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const chave = b.chaveDe(c.fonte);
        const existente = await b.jaRegistrado(tx, cx, TIPO.RECEBIVEL, chave, impressao);
        if (existente) {
          const lancamentosDeRetencao = await tx.listar(cx, TIPO.LANCAMENTO, (l) => l.origem?.tipo === TIPO.RECEBIVEL && l.origem.id === existente.id);
          return { recebivel: existente, lancamentosDeRetencao, repetido: true };
        }
        await b.exigirCompetenciaEditavel(tx, cx, c.competencia);
        if (c.anteriorAAbertura) {
          const ab = await exigirAberturaPara(tx, cx, c.competencia);
          if (c.dataOrigem > ab.dataDeCorte) falhar(CODIGO.DATA_INVALIDA, `Título anterior à abertura tem origem até ${ab.dataDeCorte} (data de corte).`, { campo: "dataOrigem" });
        }
        if (c.contraparteNova) c.contraparteId = (await contraparteDoFormulario(tx, cx, c.contraparteNova)).id; // mesma transação
        else if (c.contraparteId) await b.obterOuFalhar(tx, cx, TIPO.CONTRAPARTE, c.contraparteId, "Contraparte");
        let canal = c.canal;
        if (c.vendaId) {
          const venda = await b.obterOuFalhar(tx, cx, TIPO.VENDA, c.vendaId, "Venda");
          canal ??= venda.canal;
        }
        await b.exigirDocumentos(tx, cx, c.documentoIds);
        const categorias = [];
        for (const r of c.retencoes) {
          const categoria = await b.categoriaLancavel(tx, cx, r.categoria);
          if (categoria.natureza === NATUREZA_LANCAMENTO.RECEITA) {
            falhar(CODIGO.CATEGORIA_INVALIDA, "Uma retenção do repasse não pode ser classificada como receita.", { categoria: categoria.codigo });
          }
          categorias.push(categoria);
        }
        const liquido = subtrair(c.brutoCentavos, somarLista(c.retencoes, (d) => d.valorCentavos));
        const { contraparteNova: _nova, ...dados } = c; // o cadastro novo já virou contraparteId
        const recebivel = await b.criar(tx, cx, TIPO.RECEBIVEL, { ...dados, canal, pagamentoId: null, forma: null, chaveIdempotencia: chave, impressao: chave ? impressao : null, ...tituloNovo(liquido) });
        const lancamentosDeRetencao = [];
        for (const [indice, r] of c.retencoes.entries()) {
          lancamentosDeRetencao.push(await b.lancar(tx, cx, categorias[indice], {
            valorCentavos: r.valorCentavos, moeda: c.moeda, descricao: r.descricao ?? c.descricao ?? categorias[indice].nome,
            dataOperacao: c.dataPrevista, competencia: c.competencia, fonte: c.fonte, canal, retidoNoRepasse: true,
            origem: { tipo: TIPO.RECEBIVEL, id: recebivel.id, retencaoIndice: indice },
          }, { documentado: c.documentoIds.length > 0 }));
        }
        return { recebivel, lancamentosDeRetencao, repetido: false };
      });
    },

    /**
     * Ajuste documentado no saldo de um título (juros, multa, desconto, taxa descoberta depois).
     * Gera UM lançamento na categoria informada; o sinal segue a natureza da categoria.
     */
    registrarAjuste(ctx, entrada) {
      const c = validarAjuste(entrada);
      return b.executar(ctx, ACAO.CORRIGIR, async (cx, tx) => {
        const ehObrigacao = c.alvoTipo === ALVO_LIQUIDACAO.OBRIGACAO;
        const tipo = ehObrigacao ? TIPO.OBRIGACAO : TIPO.RECEBIVEL;
        const alvo = await b.obterOuFalhar(tx, cx, tipo, c.alvoId, "Título");
        const competencia = c.competencia ?? alvo.competencia;
        // 07: o lançamento do ajuste nasce na competência informada (precisa aceitar escrita); o título de um mês homologado
        // só muda a posição — atualização posterior auditada.
        await b.exigirCompetenciasDoVinculo(tx, cx, { gravadas: [competencia], referenciadas: [alvo.competencia], motivo: "ajuste de título" });
        if (c.documentoId) await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, c.documentoId, "Documento");
        const categoria = await b.categoriaLancavel(tx, cx, c.categoria);
        const mudancas = aplicarAjuste(alvo, c.valorCentavos);
        const ajusteId = b.gerarId();
        const lancamento = await b.lancar(tx, cx, categoria, {
          valorCentavos: valorDoLancamentoDeAjuste(ehObrigacao, categoria.natureza, c.valorCentavos),
          moeda: alvo.moeda, descricao: c.motivo, dataOperacao: b.hoje(), competencia, canal: alvo.canal ?? null,
          retidoNoRepasse: !ehObrigacao, origem: { tipo: TIPO.AJUSTE, id: ajusteId },
        }, { documentado: Boolean(c.documentoId) });
        const ajuste = await b.criar(tx, cx, TIPO.AJUSTE, { id: ajusteId, alvoTipo: c.alvoTipo, alvoId: c.alvoId, valorCentavos: c.valorCentavos, motivo: c.motivo, competencia, documentoId: c.documentoId, lancamentoId: lancamento.id, estornoId: null }, c.motivo);
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
        if (c.mudancas.contraparteId) await b.obterOuFalhar(tx, cx, TIPO.CONTRAPARTE, c.mudancas.contraparteId, "Fornecedor");
        const corrigida = await b.alterar(tx, cx, TIPO.OBRIGACAO, atual, c.mudancas, EVENTO_HISTORICO.CORRECAO, c.justificativa);
        // A descrição aparece também no lançamento da despesa: os dois andam juntos (cada um com o seu histórico).
        if (c.mudancas.descricao && atual.lancamentoId) {
          const l = await b.obterOuFalhar(tx, cx, TIPO.LANCAMENTO, atual.lancamentoId, "Lançamento");
          if (l.descricao !== c.mudancas.descricao) await b.alterar(tx, cx, TIPO.LANCAMENTO, l, { descricao: c.mudancas.descricao }, EVENTO_HISTORICO.CORRECAO, c.justificativa);
        }
        return corrigida;
      });
    },

    /** Cancelamento LÓGICO do grupo inteiro (todas as parcelas + lançamento). Recusado se alguma parcela já teve liquidação. */
    cancelarObrigacao(ctx, entrada) {
      const c = validarCancelamentoObrigacao(entrada);
      return b.executar(ctx, ACAO.CANCELAR, async (cx, tx) => {
        const alvo = await b.obterOuFalhar(tx, cx, TIPO.OBRIGACAO, c.obrigacaoId, "Obrigação");
        if (alvo.situacao === SITUACAO_TITULO.CANCELADA) falhar(CODIGO.OPERACAO_INVALIDA, "Obrigação já cancelada.");
        await b.exigirCompetenciaEditavel(tx, cx, alvo.competencia);
        const grupo = await tx.listar(cx, TIPO.OBRIGACAO, { onde: { grupoId: alvo.grupoId } });
        if (grupo.some((o) => o.liquidadoCentavos > 0)) {
          falhar(CODIGO.ESTORNO_EXIGE_COMPENSACAO, "Há pagamento vinculado. Estorne as liquidações antes de cancelar.");
        }
        const obrigacoes = [];
        for (const o of grupo) obrigacoes.push(await b.alterar(tx, cx, TIPO.OBRIGACAO, o, { situacao: SITUACAO_TITULO.CANCELADA }, EVENTO_HISTORICO.CANCELAMENTO, c.justificativa));
        await b.cancelarLancamento(tx, cx, alvo.lancamentoId, c.justificativa);
        await cancelarLancamentosDeAjustes(tx, cx, ALVO_LIQUIDACAO.OBRIGACAO, grupo.map((o) => o.id), c.justificativa);
        return { obrigacoes };
      });
    },

    /**
     * Cancela um recebível AVULSO ainda não liquidado, com suas retenções e ajustes. Nada é apagado.
     * Recebível nascido de pagamento de venda não se cancela sozinho: estorna-se o pagamento ou cancela-se a venda.
     */
    cancelarRecebivel(ctx, entrada) {
      const c = validarCancelamentoRecebivel(entrada);
      return b.executar(ctx, ACAO.CANCELAR, async (cx, tx) => {
        const alvo = await b.obterOuFalhar(tx, cx, TIPO.RECEBIVEL, c.recebivelId, "Recebível");
        if (alvo.situacao === SITUACAO_TITULO.CANCELADA) falhar(CODIGO.OPERACAO_INVALIDA, "Recebível já cancelado.");
        if (alvo.pagamentoId) falhar(CODIGO.OPERACAO_INVALIDA, "Este recebível pertence a um pagamento de venda: estorne o pagamento ou cancele a venda.");
        if (alvo.liquidadoCentavos > 0) falhar(CODIGO.ESTORNO_EXIGE_COMPENSACAO, "Há recebimento vinculado. Estorne as liquidações antes de cancelar.");
        await b.exigirCompetenciaEditavel(tx, cx, alvo.competencia);
        const recebivel = await b.alterar(tx, cx, TIPO.RECEBIVEL, alvo, { situacao: SITUACAO_TITULO.CANCELADA }, EVENTO_HISTORICO.CANCELAMENTO, c.justificativa);
        const lancamentos = await tx.listar(cx, TIPO.LANCAMENTO, (l) => l.origem?.tipo === TIPO.RECEBIVEL && l.origem.id === alvo.id);
        for (const l of lancamentos) await b.cancelarLancamento(tx, cx, l.id, c.justificativa);
        await cancelarLancamentosDeAjustes(tx, cx, ALVO_LIQUIDACAO.RECEBIVEL, [alvo.id], c.justificativa);
        return { recebivel };
      });
    },

    // Reclassificação (mudar a categoria de um lançamento) vive em aplicacao/reclassificacao.js desde a Execução 08C:
    // permissão própria (financeiro_v2.reclassificar), prévia de impacto, versão obrigatória e evidência.

    /** Correção cadastral de lançamento (descrição, data da operação), com antes/depois e justificativa no histórico. */
    corrigirLancamento(ctx, entrada) {
      const c = validarCorrecaoLancamento(entrada);
      return b.executar(ctx, ACAO.CORRIGIR, async (cx, tx) => {
        const l = await b.obterOuFalhar(tx, cx, TIPO.LANCAMENTO, c.lancamentoId, "Lançamento");
        if (l.situacao !== SITUACAO_LANCAMENTO.ATIVO) falhar(CODIGO.OPERACAO_INVALIDA, "Lançamento cancelado não pode ser corrigido.");
        await b.exigirCompetenciaEditavel(tx, cx, l.competencia);
        return b.alterar(tx, cx, TIPO.LANCAMENTO, l, c.mudancas, EVENTO_HISTORICO.CORRECAO, c.justificativa);
      });
    },
  };
}
