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
  REFERENCIA_SALDO, caixaEBancos, calendarioFinanceiro, contasAPagar, contasAReceber, fluxoDeCaixa, preparar, resumoFinanceiro, teoricoDaSessao, tituloAPagar, tituloAReceber,
} from "../dominio/tesouraria.js";
import {
  validarAberturaDeCaixa, validarDetalheDeTitulo, validarFechamentoDeCaixa, validarFiltroAPagar, validarFiltroAReceber, validarFiltroCaixaEBancos,
  validarFiltroCalendario, validarFiltroFluxo, validarFiltroResumo, validarOperacaoDeCaixa, validarSaldoDeConta,
} from "../contratos/tesouraria.js";
import { baseNaTransacao } from "./base.js";
import { operacoesDeCaixa } from "./caixa.js";
import { exigirEquivalencia } from "./cargaDaCompetencia.js";

const ROTULO = Object.freeze({ ENTRADA: "Entrada de dinheiro", SAIDA: "Saída de dinheiro", SANGRIA: "Sangria", SUPRIMENTO: "Suprimento" });

/** @param {{cargaCompleta?: boolean}} [opcoes] cargaCompleta: SÓ para testes de equivalência (referência: lê tudo, como antes da 07B) */
export function operacoesDeTesouraria(b, { cargaCompleta = false, conferirCarga = false } = {}) {
  /** Registros do escopo usados pelas consultas. O repositório já filtra por organização + unidade. */
  async function carregar(cx, tx) {
    const l = (tipo) => tx.listar(cx, tipo);
    return {
      contas: await l(TIPO.CONTA), saldos: await l(TIPO.SALDO_CONTA), movimentacoes: await l(TIPO.MOVIMENTACAO), transferencias: await l(TIPO.TRANSFERENCIA),
      liquidacoes: await l(TIPO.LIQUIDACAO), obrigacoes: await l(TIPO.OBRIGACAO), recebiveis: await l(TIPO.RECEBIVEL), contrapartes: await l(TIPO.CONTRAPARTE),
      lancamentos: await l(TIPO.LANCAMENTO), categorias: await l(TIPO.CATEGORIA), ajustes: await l(TIPO.AJUSTE), correspondencias: await l(TIPO.CORRESPONDENCIA),
      sessoes: await l(TIPO.SESSAO_CAIXA), documentos: await l(TIPO.DOCUMENTO), vinculos: await l(TIPO.VINCULO_DOCUMENTAL), pagamentos: await l(TIPO.PAGAMENTO_VENDA),
      competencias: await l(TIPO.COMPETENCIA), propostas: await l(TIPO.PROPOSTA),
    };
  }
  // 08D: no modo de conferência (testes), cada consulta calcula também com a carga completa e exige igualdade.
  const consulta = (validar, calcular, carregador = carregarTesouraria, tela = "tesouraria") => (ctx, e) => {
    const filtro = validar(e);
    return b.consultar(ctx, async (cx, tx) => {
      const hoje = b.hoje();
      const r = calcular(await (cargaCompleta ? carregar : carregador)(cx, tx), hoje, filtro);
      if (conferirCarga && !cargaCompleta) exigirEquivalencia(r, calcular(await carregar(cx, tx), hoje, filtro), tela);
      return r;
    });
  };

  // ------------------------------------------------------------------------------------------------- 07B: carga dirigida
  // Contas a pagar/receber carregavam TODAS as tabelas do histórico (vendas, pagamentos, propostas...). Agora cada tela
  // lê só as tabelas que usa e, nelas, só as linhas ligadas aos títulos (filtro por id NO BANCO, paginado). As MESMAS
  // funções de dominio/tesouraria.js calculam o resultado — a equivalência com a carga completa é provada em teste.
  const unicos = (lista) => [...new Set(lista.filter(Boolean))];
  async function ligados(cx, tx, tipo, campo, ids) {
    if (!ids.length) return [];
    const saida = [];
    for (let i = 0; i < ids.length; i += 200) { // o contrato da porta aceita até 200 valores em `em`
      const lote = ids.slice(i, i + 200);
      for (let deslocamento = 0; ; deslocamento += 500) {
        const pg = await tx.paginar(cx, tipo, { em: { [campo]: lote }, limite: 500, deslocamento, contar: false }); // 08D: sem contagem
        saida.push(...pg.itens);
        if (pg.itens.length < 500) break;
      }
    }
    return saida;
  }
  /**
   * 08D — carga dirigida de Caixa e Bancos, Fluxo de Caixa, Calendário e Visão Geral (resumo). São POSIÇÕES NA DATA: usam
   * de verdade todos os títulos, todas as movimentações (saldo desde a âncora) e os saldos informados. O que NÃO usam
   * deixa de ser lido inteiro: lançamentos (só os dos títulos e ajustes), pagamentos de venda (só os ligados a
   * movimentações), propostas (só as bancárias, que trazem a categoria sugerida do extrato) e conciliações (só as
   * divergentes, que marcam títulos). Equivalência provada no modo de conferência.
   */
  async function carregarTesouraria(cx, tx) {
    const l = (tipo, filtro) => tx.listar(cx, tipo, filtro);
    const [obrigacoes, recebiveis, movimentacoes, ajustes] = [await l(TIPO.OBRIGACAO), await l(TIPO.RECEBIVEL), await l(TIPO.MOVIMENTACAO), await l(TIPO.AJUSTE)];
    return {
      contas: await l(TIPO.CONTA), saldos: await l(TIPO.SALDO_CONTA), movimentacoes, transferencias: await l(TIPO.TRANSFERENCIA), liquidacoes: await l(TIPO.LIQUIDACAO),
      obrigacoes, recebiveis, contrapartes: await l(TIPO.CONTRAPARTE), categorias: await l(TIPO.CATEGORIA), ajustes, sessoes: await l(TIPO.SESSAO_CAIXA),
      documentos: await l(TIPO.DOCUMENTO), vinculos: await l(TIPO.VINCULO_DOCUMENTAL), competencias: await l(TIPO.COMPETENCIA),
      lancamentos: await ligados(cx, tx, TIPO.LANCAMENTO, "id", unicos([...obrigacoes.map((o) => o.lancamentoId), ...ajustes.map((a) => a.lancamentoId)])),
      pagamentos: await ligados(cx, tx, TIPO.PAGAMENTO_VENDA, "id", unicos(movimentacoes.map((m) => m.pagamentoId))),
      propostas: await l(TIPO.PROPOSTA, { onde: { operacao: "MOVIMENTACAO_BANCARIA" } }),
      correspondencias: await l(TIPO.CORRESPONDENCIA, { onde: { situacao: "DIVERGENTE" } }),
    };
  }

  /** Liquidações dos títulos, as movimentações que as pagaram e as OUTRAS liquidações dessas mesmas movimentações. */
  async function pagamentosDosTitulos(cx, tx, ids) {
    const diretas = await ligados(cx, tx, TIPO.LIQUIDACAO, "alvoId", ids);
    const movIds = unicos(diretas.map((q) => q.movimentacaoId));
    return { liquidacoes: await ligados(cx, tx, TIPO.LIQUIDACAO, "movimentacaoId", movIds), movimentacoes: await ligados(cx, tx, TIPO.MOVIMENTACAO, "id", movIds) };
  }
  async function documentosDosRegistros(cx, tx, registros) {
    const vinculos = await ligados(cx, tx, TIPO.VINCULO_DOCUMENTAL, "registroId", unicos(registros.map((r) => r.id)));
    const ids = unicos([...vinculos.map((v) => v.documentoId), ...registros.flatMap((r) => [...(r.documentoIds ?? []), r.documentoId])]);
    return { vinculos, documentos: await ligados(cx, tx, TIPO.DOCUMENTO, "id", ids) };
  }
  const cadastros = async (cx, tx) => ({
    contas: await tx.listar(cx, TIPO.CONTA), contrapartes: await tx.listar(cx, TIPO.CONTRAPARTE),
    categorias: await tx.listar(cx, TIPO.CATEGORIA), competencias: await tx.listar(cx, TIPO.COMPETENCIA),
  });
  async function carregarContasAPagar(cx, tx) {
    const obrigacoes = await tx.listar(cx, TIPO.OBRIGACAO);
    const { liquidacoes, movimentacoes } = await pagamentosDosTitulos(cx, tx, obrigacoes.map((o) => o.id));
    const lancamentos = await ligados(cx, tx, TIPO.LANCAMENTO, "id", unicos(obrigacoes.map((o) => o.lancamentoId)));
    return { ...(await cadastros(cx, tx)), obrigacoes, liquidacoes, movimentacoes, lancamentos, ...(await documentosDosRegistros(cx, tx, [...obrigacoes, ...movimentacoes])) };
  }
  async function carregarContasAReceber(cx, tx) {
    const recebiveis = await tx.listar(cx, TIPO.RECEBIVEL);
    const ids = recebiveis.map((r) => r.id);
    const { liquidacoes, movimentacoes } = await pagamentosDosTitulos(cx, tx, ids);
    const ajustes = await ligados(cx, tx, TIPO.AJUSTE, "alvoId", ids);
    const lancamentos = await ligados(cx, tx, TIPO.LANCAMENTO, "id", unicos(ajustes.map((a) => a.lancamentoId)));
    const correspondencias = await tx.listar(cx, TIPO.CORRESPONDENCIA, { onde: { situacao: "DIVERGENTE" } });
    return { ...(await cadastros(cx, tx)), recebiveis, liquidacoes, movimentacoes, ajustes, lancamentos, correspondencias, ...(await documentosDosRegistros(cx, tx, [...recebiveis, ...movimentacoes])) };
  }

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
    consultarContasAPagar: consulta(validarFiltroAPagar, contasAPagar, carregarContasAPagar, "contas a pagar"),
    consultarContasAReceber: consulta(validarFiltroAReceber, contasAReceber, carregarContasAReceber, "contas a receber"),
    consultarCaixaEBancos: consulta(validarFiltroCaixaEBancos, caixaEBancos, carregarTesouraria, "caixa e bancos"),
    consultarFluxoDeCaixa: consulta(validarFiltroFluxo, fluxoDeCaixa, carregarTesouraria, "fluxo de caixa"),
    consultarCalendarioFinanceiro: consulta(validarFiltroCalendario, calendarioFinanceiro, carregarTesouraria, "calendário"),
    consultarResumoFinanceiro: consulta(validarFiltroResumo, resumoFinanceiro, carregarTesouraria, "visão geral (resumo)"),

    /** Conta a pagar → parcelas do mesmo grupo → pagamentos → documentos → histórico. */
    detalharContaAPagar(ctx, e) {
      const { id } = validarDetalheDeTitulo(e);
      return b.consultar(ctx, async (cx, tx) => {
        const p = preparar(await (cargaCompleta ? carregar : carregarContasAPagar)(cx, tx));
        if (conferirCarga && !cargaCompleta) {
          const r = (q) => { const x = q.obrigacaoPorId.get(id); return x ? [tituloAPagar(q, x, b.hoje()), q.obrigacoes.filter((y) => y.grupoId === x.grupoId).map((y) => tituloAPagar(q, y, b.hoje())), q.lancamentoPorId.get(x.lancamentoId) ?? null] : null; };
          exigirEquivalencia(r(p), r(preparar(await carregar(cx, tx))), "detalhe a pagar");
        }
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
        const p = preparar(await (cargaCompleta ? carregar : carregarContasAReceber)(cx, tx));
        if (conferirCarga && !cargaCompleta) {
          const t = (q) => { const x = q.recebivelPorId.get(id); return x ? tituloAReceber(q, x, b.hoje()) : null; };
          exigirEquivalencia(t(p), t(preparar(await carregar(cx, tx))), "detalhe a receber");
        }
        const r = p.recebivelPorId.get(id);
        if (!r) falhar(CODIGO.NAO_ENCONTRADO, "Conta a receber não encontrada.");
        return { dataBase: b.hoje(), titulo: tituloAReceber(p, r, b.hoje()), historico: await historicoDe(cx, tx, TIPO.RECEBIVEL, id) };
      });
    },

    // ------------------------------------------------------------------------------------------------ saldo informado
    /**
     * Registra o saldo de uma conta numa data, com REFERÊNCIA explícita: início do dia (antes dos movimentos do dia) ou fim
     * do dia (depois deles). É o ponto de partida do saldo calculado — só movimentos POSTERIORES à referência se somam a
     * ele. Um segundo saldo informado não corrige nada: a diferença para o calculado aparece na consulta como divergência.
     */
    registrarSaldoDeConta(ctx, entrada) {
      const c = validarSaldoDeConta(entrada);
      const impressao = JSON.stringify(c);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        const chave = c.referencia === REFERENCIA_SALDO.FIM_DO_DIA ? `saldo:${c.contaId}:${c.data}:fim` : `saldo:${c.contaId}:${c.data}`;
        const existente = await b.jaRegistrado(tx, cx, TIPO.SALDO_CONTA, chave, impressao);
        if (existente) return { saldo: existente, repetido: true };
        const conta = await b.obterOuFalhar(tx, cx, TIPO.CONTA, c.contaId, "Conta financeira");
        if (conta.tipo === TIPO_CONTA.CAIXA_FISICO && c.valorCentavos < 0) falhar(CODIGO.VALOR_INVALIDO, "Caixa físico não tem saldo negativo.", { campo: "valorCentavos" });
        b.exigirNaoFutura(c.data, "data");
        // 07: extrato que chega depois do fechamento é evidência legítima; a competência do saldo recebe a marca de auditoria.
        await b.exigirCompetenciasDoVinculo(tx, cx, { referenciadas: [competenciaDe(c.data)], motivo: "saldo informado" });
        // O fim do dia de hoje ainda não aconteceu: um "saldo final" de hoje deixaria de fora movimentos que ainda virão.
        if (c.referencia === REFERENCIA_SALDO.FIM_DO_DIA && c.data >= b.hoje()) falhar(CODIGO.DATA_INVALIDA, "Saldo de fim do dia só para dias já encerrados.", { campo: "data" });
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
