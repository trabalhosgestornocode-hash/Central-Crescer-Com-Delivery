// Vendas e Recebimentos (Execução 06B): consultas SOMENTE LEITURA sobre os registros do núcleo, calculadas pelas regras
// puras de dominio/vendasRecebimentos.js. Faturamento vem do motor de apuração; títulos a receber vêm da tesouraria.
// Nenhuma escrita nova: esta área não cria, altera nem concilia nada.
import { CODIGO, falhar } from "../dominio/erros.js";
import { TIPO } from "../dominio/catalogos.js";
import { somar, somarLista } from "../dominio/dinheiro.js";
import { competenciaDe, primeiroDiaDe, somarMeses } from "../dominio/tempo.js";
import {
  CUSTOS_DO_RECEBIMENTO, SITUACAO_OPERACAO, SITUACAO_RECEBIMENTO, TIPO_COMPONENTE, TIPO_OPERACAO, atendeFiltro, cadeiaDoRecebivel, composicaoIfood,
  divergenciasDeVendas, linhaDoTempoDaVenda, linhaDoTempoDoRecebivel, montarVisao, paginar, processadoresDe, resumoDeVendas,
} from "../dominio/vendasRecebimentos.js";
import {
  validarDetalheDeVenda, validarFiltroDeDivergencias, validarFiltroDePagamentos, validarFiltroDeRecebiveis, validarFiltroDeTaxas, validarFiltroDeVendas,
} from "../contratos/vendasRecebimentos.js";
import { SEM_CANAL } from "../dominio/apuracao.js";

/** Competências cobertas pelo filtro (para a apuração central). */
function competenciasDo(f) {
  if (f.competencia) return [f.competencia];
  const lista = [];
  for (let c = competenciaDe(f.inicio); c <= competenciaDe(f.fim); c = competenciaDe(somarMeses(primeiroDiaDe(c), 1))) lista.push(c);
  return lista;
}
/** Item compacto da lista de vendas (o detalhe completo vem de detalharVenda). */
const itemDeVenda = (o) => ({
  id: o.id, tipo: o.tipo, identificador: o.identificador, titulo: o.titulo, data: o.data, horario: o.horario, competencia: o.competencia, canal: o.canal, canalComprovado: o.canalComprovado,
  valores: o.valores, situacao: o.situacao, formas: o.formas, processadores: o.processadores, formaDesconhecida: o.formaDesconhecida,
  confiabilidade: o.confiabilidade, pendencias: o.pendencias, quantidadeDeVendas: o.quantidadeDeVendas ?? null, recebiveis: o.recebiveis.length, pagamentos: o.pagamentos.length,
});
const resumoDaVenda = (o) => ({ id: o.id, tipo: o.tipo, identificador: o.identificador, titulo: o.titulo, data: o.data, canal: o.canal, situacao: o.situacao });

export function operacoesDeVendasERecebimentos(b) {
  async function carregar(cx, tx) {
    const l = (tipo, filtro) => tx.listar(cx, tipo, filtro);
    return {
      vendas: await l(TIPO.VENDA), pagamentos: await l(TIPO.PAGAMENTO_VENDA), recebiveis: await l(TIPO.RECEBIVEL), ajustes: await l(TIPO.AJUSTE),
      lancamentos: await l(TIPO.LANCAMENTO), categorias: await l(TIPO.CATEGORIA), liquidacoes: await l(TIPO.LIQUIDACAO), movimentacoes: await l(TIPO.MOVIMENTACAO),
      estornos: await l(TIPO.ESTORNO), documentos: await l(TIPO.DOCUMENTO), vinculos: await l(TIPO.VINCULO_DOCUMENTAL), propostas: await l(TIPO.PROPOSTA),
      // Só os pedidos importados (para horário e dados originais); o restante dos registros de fonte não é necessário aqui.
      registros: await l(TIPO.REGISTRO_FONTE, { onde: { tipoRegistro: "PEDIDO" } }),
      correspondencias: await l(TIPO.CORRESPONDENCIA), divergenciasFonte: await l(TIPO.DIVERGENCIA_FONTE), competencias: await l(TIPO.COMPETENCIA),
      contas: await l(TIPO.CONTA), sessoes: await l(TIPO.SESSAO_CAIXA), contrapartes: await l(TIPO.CONTRAPARTE), obrigacoes: await l(TIPO.OBRIGACAO),
      transferencias: await l(TIPO.TRANSFERENCIA),
    };
  }
  /** Monta a visão do escopo para o filtro (apuração central só das competências do filtro). */
  function visao(cx, tx, f) {
    return carregar(cx, tx).then((d) => {
      const comps = competenciasDo(f);
      const v = montarVisao(d, b.hoje(), { escopo: { organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId }, apuradoEm: b.agora(), competencias: comps });
      const ops = v.ops.filter((o) => atendeFiltro(o, f));
      const apuracao = comps.length === 1 ? v.apuracoes.get(comps[0]) : null;
      return { ...v, d, ops, apuracao, resumo: resumoDeVendas(ops, apuracao, f) };
    });
  }
  /** Recebíveis avulsos de processador (sem venda: ex. vale-refeição) que atendem ao filtro (sem forma/situação de venda). */
  const avulsosDo = (avulsos, f) => avulsos.filter((r) => (!f.competencia || r.competencia === f.competencia)
    && (!f.inicio || r.competencia >= competenciaDe(f.inicio)) && (!f.fim || r.competencia <= competenciaDe(f.fim))
    && (!f.processador || r.processador === f.processador) && (!f.canal || (r.canal ?? SEM_CANAL) === f.canal)
    // Sem venda não há forma, situação de venda nem identificador de pedido: esses filtros os excluem.
    && !f.forma && !f.situacao && !f.identificador);

  return {
    /** Lista de vendas (individuais e agregadas) com resumo, paginação e filtros disponíveis. */
    consultarVendas(ctx, e) {
      const f = validarFiltroDeVendas(e);
      return b.consultar(ctx, async (cx, tx) => {
        const v = await visao(cx, tx, f);
        const pg = paginar(v.ops.map(itemDeVenda), f.pagina, f.tamanho);
        const todas = v.ops;
        return {
          dataBase: b.hoje(), filtro: f, resumo: v.resumo, itens: pg.itens, paginacao: pg.paginacao,
          disponiveis: {
            canais: [...new Set(todas.map((o) => o.canal ?? SEM_CANAL))], formas: [...new Set(todas.flatMap((o) => o.formas))],
            processadores: [...new Set(todas.flatMap((o) => o.processadores))], situacoes: [...new Set(todas.map((o) => o.situacao))],
          },
        };
      });
    },

    /** Pagamentos das vendas (forma × processador × destino), consolidado por processador e transações sem venda. */
    consultarPagamentosDeVendas(ctx, e) {
      const f = validarFiltroDePagamentos(e);
      return b.consultar(ctx, async (cx, tx) => {
        const v = await visao(cx, tx, f);
        const vendas = v.ops.filter((o) => o.tipo === TIPO_OPERACAO.VENDA);
        const pagamentos = vendas.flatMap((o) => o.pagamentos.map((pg) => ({ ...pg, venda: resumoDaVenda(o), recebimento: o.recebiveis.find((r) => r.id === pg.recebivelId)?.situacaoRecebimento ?? null })))
          .filter((pg) => (!f.forma || pg.forma === f.forma || (f.forma === "DESCONHECIDA" && !pg.formaConhecida)) && (!f.processador || (f.processador === "SEM_PROCESSADOR" ? !pg.processador : pg.processador === f.processador)))
          .sort((a, b2) => (a.data < b2.data ? 1 : a.data > b2.data ? -1 : 0));
        const vivos = pagamentos.filter((pg) => pg.validoCentavos > 0);
        const agrupar = (chave) => Object.values(vivos.reduce((acc, pg) => {
          const k = chave(pg);
          acc[k] ??= { chave: k, quantidade: 0, valorCentavos: 0 };
          acc[k].quantidade += 1;
          acc[k].valorCentavos = somar(acc[k].valorCentavos, pg.validoCentavos);
          return acc;
        }, {})).sort((x, y) => y.valorCentavos - x.valorCentavos);
        const semVenda = v.semVenda.filter((t) => (!f.competencia || t.competencia === f.competencia) && (!f.inicio || t.data >= f.inicio) && (!f.fim || t.data <= f.fim) && (!f.processador || t.processador === f.processador));
        const pg = paginar(pagamentos, f.pagina, f.tamanho);
        return {
          dataBase: b.hoje(), filtro: f, resumo: v.resumo, itens: pg.itens, paginacao: pg.paginacao,
          totais: { pagamentos: vivos.length, validoCentavos: somarLista(vivos, (x) => x.validoCentavos), estornadoCentavos: somarLista(pagamentos, (x) => x.estornadoCentavos) },
          porForma: agrupar((x) => (x.formaConhecida ? x.forma : "DESCONHECIDA")), porProcessador: agrupar((x) => x.processador ?? "SEM_PROCESSADOR"),
          processadores: processadoresDe(v.ix, vendas, avulsosDo(v.avulsos, f), semVenda), ifood: composicaoIfood(vendas),
          transacoesSemVenda: semVenda,
          agregadosSemPagamento: v.ops.filter((o) => o.tipo === TIPO_OPERACAO.AGREGADO_DIARIO && o.situacao !== SITUACAO_OPERACAO.CANCELADA).length,
        };
      });
    },

    /** Taxas, comissões e descontos de cada venda e recebível, com a linha da DRE e a fração de centavo quando houver. */
    consultarTaxasEDescontos(ctx, e) {
      const f = validarFiltroDeTaxas(e);
      return b.consultar(ctx, async (cx, tx) => {
        const v = await visao(cx, tx, f);
        const ativas = v.ops.filter((o) => o.situacao !== SITUACAO_OPERACAO.CANCELADA);
        const itens = [
          ...ativas.flatMap((o) => [...o.descontos, ...o.devolucoes].map((c) => ({ ...c, venda: resumoDaVenda(o), processador: null, canal: o.canal }))),
          ...ativas.flatMap((o) => o.recebiveis.flatMap((r) => r.componentes.map((c) => ({ ...c, venda: resumoDaVenda(o), processador: r.processador, canal: o.canal, recebivelId: r.id })))),
          ...avulsosDo(v.avulsos, f).flatMap((r) => r.componentes.map((c) => ({ ...c, venda: null, processador: r.processador, canal: r.canal, recebivelId: r.id }))),
        ].filter((c) => !f.tipoComponente || c.tipo === f.tipoComponente).sort((a, b2) => ((a.data ?? "") < (b2.data ?? "") ? 1 : -1));
        const porTipo = itens.reduce((acc, c) => ({ ...acc, [c.tipo]: somar(acc[c.tipo] ?? 0, c.valorCentavos) }), {});
        const porLinha = itens.reduce((acc, c) => (c.linhaDaDre ? { ...acc, [c.linhaDaDre]: somar(acc[c.linhaDaDre] ?? 0, c.valorCentavos) } : acc), {});
        const pg = paginar(itens, f.pagina, f.tamanho);
        const deducoes = [TIPO_COMPONENTE.DESCONTO_DA_LOJA, TIPO_COMPONENTE.DESCONTO_FINANCIADOR_NAO_COMPROVADO, TIPO_COMPONENTE.DEVOLUCAO];
        return {
          dataBase: b.hoje(), filtro: f, resumo: v.resumo, itens: pg.itens, paginacao: pg.paginacao, porTipo, porLinhaDaDre: porLinha,
          totais: {
            descontosComerciaisCentavos: somarLista(itens.filter((c) => deducoes.includes(c.tipo)), (c) => c.valorCentavos),
            subsidiosCentavos: somarLista(itens.filter((c) => c.tipo === TIPO_COMPONENTE.SUBSIDIO_DE_TERCEIRO), (c) => c.valorCentavos),
            custosDoRecebimentoCentavos: somarLista(itens.filter((c) => CUSTOS_DO_RECEBIMENTO.includes(c.tipo)), (c) => c.valorCentavos),
            comFracaoDeCentavo: itens.filter((c) => c.fracao?.temFracao).length,
          },
          regraDeArredondamento: "Taxas informadas em milionésimos de real são registradas em centavos com arredondamento METADE PARA CIMA (0,5 centavo sobe). O valor exato fica preservado ao lado do registrado.",
        };
      });
    },

    /** Cadeia venda → recebível → repasse → crédito, e os créditos (repasses) agrupados por movimentação. */
    consultarRecebiveisERepasses(ctx, e) {
      const f = validarFiltroDeRecebiveis(e);
      return b.consultar(ctx, async (cx, tx) => {
        const v = await visao(cx, tx, f);
        const daVenda = v.ops.filter((o) => o.tipo === TIPO_OPERACAO.VENDA).flatMap((o) => o.recebiveis.map((r) => ({ ...r, venda: resumoDaVenda(o) })));
        const todos = [...daVenda, ...avulsosDo(v.avulsos, f).map((r) => ({ ...r, venda: null }))]
          .filter((r) => (!f.recebimento || r.situacaoRecebimento === f.recebimento) && (!f.processador || r.processador === f.processador));
        const vivos = todos.filter((r) => r.situacaoRecebimento !== SITUACAO_RECEBIMENTO.CANCELADO);
        // Créditos (repasses) — uma linha por movimentação, com quantos títulos e vendas ela liquida (repasse agrupado).
        const porMov = new Map();
        for (const r of vivos) for (const c of r.creditos) {
          const atual = porMov.get(c.movimentacaoId) ?? { ...c, valorCentavos: 0, titulos: [], vendas: new Set() };
          atual.valorCentavos = somar(atual.valorCentavos, c.valorCentavos);
          atual.titulos.push({ recebivelId: r.id, processador: r.processador, valorCentavos: c.valorCentavos, venda: r.venda });
          if (r.venda) atual.vendas.add(r.venda.id);
          porMov.set(c.movimentacaoId, atual);
        }
        const creditos = [...porMov.values()].map((c) => ({ ...c, vendas: c.vendas.size, naoVinculadoNestaVisaoCentavos: c.valorDaMovimentacaoCentavos - c.valorCentavos })).sort((a, b2) => (a.data < b2.data ? 1 : -1));
        const pg = paginar(todos.sort((a, b2) => ((a.dataPrevista ?? "9999") < (b2.dataPrevista ?? "9999") ? -1 : 1)), f.pagina, f.tamanho);
        return {
          dataBase: b.hoje(), filtro: f, resumo: v.resumo, itens: pg.itens, paginacao: pg.paginacao, creditos,
          totais: {
            recebiveis: vivos.length, brutoCentavos: somarLista(vivos, (r) => r.brutoCentavos), custosCentavos: somarLista(vivos, (r) => r.custosCentavos),
            esperadoCentavos: somarLista(vivos, (r) => r.esperadoCentavos), liquidadoCentavos: somarLista(vivos, (r) => r.liquidadoCentavos), saldoCentavos: somarLista(vivos, (r) => r.saldoCentavos),
            comPrevisaoDocumentadaCentavos: somarLista(vivos.filter((r) => r.previsaoConfiavel), (r) => r.saldoCentavos), semPrevisaoCentavos: somarLista(vivos.filter((r) => !r.previsaoConfiavel), (r) => r.saldoCentavos),
            recebidoComprovadoCentavos: somarLista(vivos, (r) => r.recebidoComprovadoCentavos), recebidoSemComprovacaoCentavos: somarLista(vivos, (r) => r.recebidoSemComprovacaoCentavos),
            porSituacao: vivos.reduce((acc, r) => ({ ...acc, [r.situacaoRecebimento]: (acc[r.situacaoRecebimento] ?? 0) + 1 }), {}),
          },
        };
      });
    },

    /** Divergências de vendas e recebimentos: descrição, impacto, fonte, período, motivo, evidência, situação e próxima ação. */
    consultarDivergenciasDeVendas(ctx, e) {
      const f = validarFiltroDeDivergencias(e);
      return b.consultar(ctx, async (cx, tx) => {
        const v = await visao(cx, tx, f);
        const noPeriodo = (x) => (!f.competencia || x.competencia === f.competencia) && (!f.inicio || !x.periodo.inicio || x.periodo.inicio >= f.inicio) && (!f.fim || !x.periodo.inicio || x.periodo.inicio <= f.fim);
        const semVenda = v.semVenda.filter((t) => (!f.processador || t.processador === f.processador));
        const todas = divergenciasDeVendas(v.ix, v.ops, avulsosDo(v.avulsos, f), semVenda, [...v.apuracoes.values()], b.hoje()).filter(noPeriodo);
        const lista = todas.filter((x) => !f.codigo || x.codigo === f.codigo);
        const pg = paginar(lista, f.pagina, f.tamanho);
        return {
          dataBase: b.hoje(), filtro: f, resumo: v.resumo, itens: pg.itens, paginacao: pg.paginacao,
          porCodigo: todas.reduce((acc, x) => ({ ...acc, [x.codigo]: { quantidade: (acc[x.codigo]?.quantidade ?? 0) + 1, valorCentavos: somar(acc[x.codigo]?.valorCentavos ?? 0, x.valorCentavos ?? 0) } }), {}),
          abertas: todas.filter((x) => x.situacao !== "INFORMATIVA" && x.situacao !== "RESOLVIDA").length,
        };
      });
    },

    /** Detalhe completo da venda (ou do agregado do dia) com a linha do tempo e o histórico. */
    detalharVenda(ctx, e) {
      const { id } = validarDetalheDeVenda(e);
      return b.consultar(ctx, async (cx, tx) => {
        const d = await carregar(cx, tx);
        const v = montarVisao(d, b.hoje(), { escopo: { organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId }, apuradoEm: b.agora() });
        const op = v.ops.find((o) => o.id === id);
        if (!op) falhar(CODIGO.NAO_ENCONTRADO, "Venda não encontrada.");
        const historico = op.tipo === TIPO_OPERACAO.VENDA ? (await tx.listarHistorico(cx, { onde: { registroTipo: TIPO.VENDA, registroId: id } })).map((h) => ({ evento: h.evento, em: h.em, justificativa: h.justificativa ?? null })) : [];
        return { dataBase: b.hoje(), operacao: op, linhaDoTempo: linhaDoTempoDaVenda(op, v.ix), historico };
      });
    },

    /** Ciclo de UM recebível (de venda ou avulso): composição, repasse, créditos, conciliação e linha do tempo. */
    detalharRecebimento(ctx, e) {
      const { id } = validarDetalheDeVenda(e);
      return b.consultar(ctx, async (cx, tx) => {
        const d = await carregar(cx, tx);
        const v = montarVisao(d, b.hoje(), { escopo: { organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId }, apuradoEm: b.agora() });
        const bruto = d.recebiveis.find((r) => r.id === id);
        if (!bruto) falhar(CODIGO.NAO_ENCONTRADO, "Recebível não encontrado.");
        const r = cadeiaDoRecebivel(v.ix, bruto, b.hoje());
        const op = r.vendaId ? v.ops.find((o) => o.id === r.vendaId) : null;
        const historico = (await tx.listarHistorico(cx, { onde: { registroTipo: TIPO.RECEBIVEL, registroId: id } })).map((h) => ({ evento: h.evento, em: h.em, justificativa: h.justificativa ?? null }));
        return { dataBase: b.hoje(), recebivel: r, venda: op ? resumoDaVenda(op) : null, linhaDoTempo: linhaDoTempoDoRecebivel(r), historico };
      });
    },
  };
}
