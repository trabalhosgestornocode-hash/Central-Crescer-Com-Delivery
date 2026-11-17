// doc 38 — DEMONSTRATIVO OFICIAL DO IFOOD do período (decisão do proprietário: o faturamento do canal iFood vem do
// relatório do iFood, não da integração SAIPOS). Numa transação: receita do canal iFood (valor das vendas), recebível do
// iFood com as retenções do demonstrativo (comissões, taxa de pagamento, mensalidade, serviços e promoções) e o ajuste
// positivo; o saldo do recebível é o faturamento líquido da plataforma — liquidado pelos REPASSES, nunca tratado como
// depósito. Confere a identidade do demonstrativo; idempotente por período; nunca convive com vendas/agregados iFood do
// período (granularidade única); a diferença para a SAIPOS fica como pendência (nada é lançado para "fechar").
import { CODIGO, falhar } from "../dominio/erros.js";
import { ESTADO_PROPOSTA, OPERACAO_PROPOSTA, SITUACAO_LANCAMENTO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { exigirCentavos, somarLista, subtrair } from "../dominio/dinheiro.js";
import { CATEGORIA_DE_VENDA, CATEGORIA_DESCONTO_A_CLASSIFICAR } from "../dominio/planoDeContas.js";
import { competenciaDe, exigirData } from "../dominio/tempo.js";
import { exigirTexto, semCamposDesconhecidos } from "../dominio/validacao.js";
import { baseNaTransacao } from "./base.js";
import { operacoesEconomicas } from "./economico.js";

export const chaveDoDemonstrativoIfood = (inicio, fim) => `demonstrativo-ifood:${inicio}:${fim}`;

/** Demonstrativo iFood ATIVO que cobre a data (para a granularidade única na formação). */
export async function demonstrativoIfoodQueCobre(tx, cx, data) {
  const ls = await tx.listar(cx, TIPO.LANCAMENTO, { onde: { competencia: competenciaDe(data), categoria: CATEGORIA_DE_VENDA.IFOOD, situacao: SITUACAO_LANCAMENTO.ATIVO } });
  return ls.find((l) => l.demonstrativoIfood && l.demonstrativoIfood.periodoInicio <= data && data <= l.demonstrativoIfood.periodoFim) ?? null;
}

/** Valida e normaliza. `exigirFechar:false` devolve também o demonstrativo que NÃO fecha (para a prévia mostrar a diferença). */
function validar(e, { exigirFechar = true } = {}) {
  semCamposDesconhecidos(e, ["periodoInicio", "periodoFim", "vendasCentavos", "comissoesCentavos", "taxaPagamentoCentavos", "mensalidadeCentavos", "servicosEPromocoesCentavos", "ajustesCentavos", "liquidoInformadoCentavos", "origem", "justificativa"], "demonstrativoIfood");
  const c = {
    periodoInicio: exigirData(e.periodoInicio, "periodoInicio"), periodoFim: exigirData(e.periodoFim, "periodoFim"),
    vendasCentavos: exigirCentavos(e.vendasCentavos, "vendasCentavos", { positivo: true }),
    comissoesCentavos: exigirCentavos(e.comissoesCentavos ?? 0, "comissoesCentavos"), taxaPagamentoCentavos: exigirCentavos(e.taxaPagamentoCentavos ?? 0, "taxaPagamentoCentavos"),
    mensalidadeCentavos: exigirCentavos(e.mensalidadeCentavos ?? 0, "mensalidadeCentavos"), servicosEPromocoesCentavos: exigirCentavos(e.servicosEPromocoesCentavos ?? 0, "servicosEPromocoesCentavos"),
    ajustesCentavos: exigirCentavos(e.ajustesCentavos ?? 0, "ajustesCentavos"), liquidoInformadoCentavos: exigirCentavos(e.liquidoInformadoCentavos, "liquidoInformadoCentavos"),
    origem: exigirTexto(e.origem, "origem", { max: 300 }), justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }),
  };
  if (c.periodoFim < c.periodoInicio || competenciaDe(c.periodoInicio) !== competenciaDe(c.periodoFim)) falhar(CODIGO.DATA_INVALIDA, "O período do demonstrativo fica dentro de uma competência.", { campo: "periodoFim" });
  const calculado = subtrair(c.vendasCentavos, somarLista([c.comissoesCentavos, c.taxaPagamentoCentavos, c.mensalidadeCentavos, c.servicosEPromocoesCentavos], (x) => x)) + c.ajustesCentavos;
  if (exigirFechar && calculado !== c.liquidoInformadoCentavos) falhar(CODIGO.ENTRADA_INVALIDA, "O demonstrativo não fecha: vendas − taxas e comissões − serviços e promoções + ajustes ≠ faturamento líquido informado.", { calculadoCentavos: calculado, informadoCentavos: c.liquidoInformadoCentavos });
  return { ...c, calculadoCentavos: calculado };
}

/** Outros demonstrativos ATIVOS que cobrem dias deste período (períodos diferentes): somariam a receita duas vezes. */
async function demonstrativosQueSobrepoem(tx, cx, c, chave) {
  return (await tx.listar(cx, TIPO.LANCAMENTO, { onde: { canal: "IFOOD" } }))
    .filter((l) => l.situacao === SITUACAO_LANCAMENTO.ATIVO && l.demonstrativoIfood && l.chaveIdempotencia !== chave
      && l.demonstrativoIfood.periodoInicio <= c.periodoFim && c.periodoInicio <= l.demonstrativoIfood.periodoFim);
}
/** Vendas/agregados iFood da SAIPOS já aplicados no período (granularidade única). */
async function vendasIfoodAplicadasNoPeriodo(tx, cx, c) {
  return [...await tx.listar(cx, TIPO.PROPOSTA, { onde: { operacao: OPERACAO_PROPOSTA.VENDA, estado: ESTADO_PROPOSTA.APLICADA } }), ...await tx.listar(cx, TIPO.PROPOSTA, { onde: { operacao: OPERACAO_PROPOSTA.VENDA_AGREGADA, estado: ESTADO_PROPOSTA.APLICADA } })]
    .filter((p) => p.comando?.canal === "IFOOD" && (p.comando.periodoInicio ? p.comando.periodoInicio <= c.periodoFim && c.periodoInicio <= p.comando.periodoFim : p.dataOperacao >= c.periodoInicio && p.dataOperacao <= c.periodoFim));
}

export function operacoesDoDemonstrativoIfood(b) {
  return {
    /**
     * PRÉVIA do demonstrativo oficial: o mesmo conferimento do registro, sem gravar nada. Mostra período, valores, a conta que fecha
     * (ou a diferença), o repasse previsto, o que bloqueia e o que fica como pendência. Só `podeConfirmar` libera o registro.
     */
    previaDoDemonstrativoIfood(ctx, entrada) {
      let c;
      try { c = validar(entrada, { exigirFechar: false }); } catch (e) { return Promise.resolve({ valido: false, erro: e?.message ?? "Dados inválidos.", campo: e?.detalhes?.campo ?? null, podeConfirmar: false }); }
      const competencia = competenciaDe(c.periodoInicio);
      return b.consultar(ctx, async (cx, tx) => {
        const chave = chaveDoDemonstrativoIfood(c.periodoInicio, c.periodoFim);
        const bloqueios = [];
        const pendencias = [];
        const fecha = c.calculadoCentavos === c.liquidoInformadoCentavos;
        if (!fecha) bloqueios.push({ codigo: "NAO_FECHA", mensagem: "O demonstrativo não fecha: vendas − comissões − taxa de pagamento − mensalidade − serviços e promoções + ajustes é diferente do líquido informado.", calculadoCentavos: c.calculadoCentavos, informadoCentavos: c.liquidoInformadoCentavos });
        const ja = await tx.buscarPorChave(cx, TIPO.LANCAMENTO, chave);
        let jaRegistrado = false;
        if (ja && ja.situacao === SITUACAO_LANCAMENTO.ATIVO) {
          if (ja.valorCentavos !== c.vendasCentavos || ja.demonstrativoIfood?.liquidoInformadoCentavos !== c.liquidoInformadoCentavos) bloqueios.push({ codigo: "OUTROS_VALORES_NO_MESMO_PERIODO", mensagem: "Já há demonstrativo iFood deste período com outros valores." });
          else jaRegistrado = true;
        } else if (ja) bloqueios.push({ codigo: "PERIODO_CANCELADO", mensagem: "O demonstrativo deste período foi cancelado: registre de novo só após revisão." });
        if (!ja) {
          const sobrepostos = await demonstrativosQueSobrepoem(tx, cx, c, chave);
          if (sobrepostos.length) bloqueios.push({ codigo: "PERIODO_SOBREPOSTO", mensagem: `O período se sobrepõe ao demonstrativo de ${sobrepostos[0].demonstrativoIfood.periodoInicio} a ${sobrepostos[0].demonstrativoIfood.periodoFim}: o faturamento seria somado duas vezes.` });
          const saipos = await vendasIfoodAplicadasNoPeriodo(tx, cx, c);
          if (saipos.length) bloqueios.push({ codigo: "VENDAS_IFOOD_DA_SAIPOS_APLICADAS", mensagem: "Já há vendas iFood aplicadas a partir da SAIPOS neste período: a SAIPOS não é a fonte do iFood. Reverta-as antes de usar o demonstrativo oficial." });
          try { await b.exigirCompetenciaEditavel(tx, cx, competencia); } catch (e) { bloqueios.push({ codigo: "COMPETENCIA_NAO_EDITAVEL", mensagem: e?.message ?? "A competência não aceita novos lançamentos." }); }
        }
        if (c.servicosEPromocoesCentavos > 0) pendencias.push({ codigo: "SERVICOS_E_PROMOCOES_A_CLASSIFICAR", mensagem: "Serviços e promoções ficam como dedução a classificar: o demonstrativo não os decompõe." });
        if (c.ajustesCentavos < 0) pendencias.push({ codigo: "AJUSTE_NEGATIVO_NAO_LANCADO", mensagem: "Ajuste negativo não é lançado automaticamente: o repasse previsto no sistema ficará maior que o líquido informado até alguém tratar o ajuste." });
        pendencias.push({ codigo: "DETALHE_DIARIO_DEPENDE_DO_RELATORIO_DE_PEDIDOS", mensagem: "O demonstrativo cobre o período inteiro. O detalhamento por dia depende do relatório oficial de pedidos (ainda não suportado)." });
        return {
          valido: true, periodoInicio: c.periodoInicio, periodoFim: c.periodoFim, competencia, origem: c.origem,
          faturamentoCentavos: c.vendasCentavos, comissoesCentavos: c.comissoesCentavos, taxasCentavos: c.taxaPagamentoCentavos, mensalidadeCentavos: c.mensalidadeCentavos,
          servicosEPromocoesCentavos: c.servicosEPromocoesCentavos, ajustesCentavos: c.ajustesCentavos, liquidoInformadoCentavos: c.liquidoInformadoCentavos, liquidoCalculadoCentavos: c.calculadoCentavos,
          diferencaCentavos: c.liquidoInformadoCentavos - c.calculadoCentavos, fecha,
          repasse: { previstoCentavos: c.liquidoInformadoCentavos, dataPrevista: c.periodoFim, observacao: "É o que o iFood deve repassar. Não é depósito: o recebimento só é confirmado pelo extrato." },
          jaRegistrado, bloqueios, pendencias, podeConfirmar: bloqueios.length === 0 && !jaRegistrado,
        };
      });
    },

    registrarDemonstrativoIfood(ctx, entrada) {
      const c = validar(entrada);
      const competencia = competenciaDe(c.periodoInicio);
      return b.executar(ctx, ACAO.REGISTRAR, async (cx, tx) => {
        await tx.travar(cx, `formacao-competencia:${competencia}`, "EXCLUSIVA");
        const chave = chaveDoDemonstrativoIfood(c.periodoInicio, c.periodoFim);
        const ja = await tx.buscarPorChave(cx, TIPO.LANCAMENTO, chave);
        if (ja && ja.situacao === SITUACAO_LANCAMENTO.ATIVO) {
          if (ja.valorCentavos !== c.vendasCentavos || ja.demonstrativoIfood?.liquidoInformadoCentavos !== c.liquidoInformadoCentavos) falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "Já há demonstrativo iFood deste período com outros valores.");
          return { receita: ja, repetido: true };
        }
        if (ja) falhar(CODIGO.OPERACAO_INVALIDA, "O demonstrativo deste período foi cancelado: registre de novo só após revisão.");
        await b.exigirCompetenciaEditavel(tx, cx, competencia);
        // Um período diferente que se sobrepõe a outro demonstrativo ativo somaria o faturamento duas vezes.
        const sobrepostos = await demonstrativosQueSobrepoem(tx, cx, c, chave);
        if (sobrepostos.length) falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "O período se sobrepõe a outro demonstrativo iFood já registrado: o mesmo faturamento seria somado duas vezes.", { periodoInicio: sobrepostos[0].demonstrativoIfood.periodoInicio, periodoFim: sobrepostos[0].demonstrativoIfood.periodoFim });
        // Granularidade única: nenhuma venda nem agregado do iFood aplicados no período.
        const conflitos = await vendasIfoodAplicadasNoPeriodo(tx, cx, c);
        if (conflitos.length) falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "Já há vendas iFood aplicadas no período (SAIPOS): reverta o agregado antes de usar o demonstrativo oficial.", { propostaId: conflitos[0].id });
        const n = operacoesEconomicas(baseNaTransacao(b, tx, cx));
        const fonte = { sistema: "IFOOD", idExterno: chave };
        const retencoes = [
          [c.comissoesCentavos, "COMISSOES_IFOOD", "Comissões iFood (demonstrativo oficial)"],
          [c.taxaPagamentoCentavos, "TAXAS_DE_PROCESSAMENTO", "Taxa de transação do pagamento online (demonstrativo oficial)"],
          [c.mensalidadeCentavos, "MENSALIDADE_IFOOD", "Mensalidade iFood (demonstrativo oficial)"],
          [c.servicosEPromocoesCentavos, CATEGORIA_DESCONTO_A_CLASSIFICAR, "Serviços e promoções iFood — a classificar (sem decomposição no demonstrativo)"],
        ].filter(([v]) => v > 0).map(([valorCentavos, categoria, descricao]) => ({ valorCentavos, categoria, descricao }));
        const r = await n.registrarRecebivel(cx, {
          processador: "IFOOD", brutoCentavos: c.vendasCentavos, retencoes, competencia, dataPrevista: c.periodoFim,
          descricao: `Faturamento iFood ${c.periodoInicio} a ${c.periodoFim} (demonstrativo oficial; liquidado pelos repasses)`, fonte,
        });
        const categoria = await b.categoriaDoSistema(tx, cx, CATEGORIA_DE_VENDA.IFOOD);
        const receita = await b.lancar(tx, cx, categoria, {
          valorCentavos: c.vendasCentavos, moeda: "BRL", descricao: `Vendas iFood de ${c.periodoInicio} a ${c.periodoFim} (demonstrativo oficial do iFood)`,
          dataOperacao: c.periodoFim, competencia, fonte: { sistema: "IFOOD", idExterno: `${chave}:receita` }, canal: "IFOOD",
          origem: { tipo: TIPO.RECEBIVEL, id: r.recebivel.id }, chaveIdempotencia: chave, impressao: null,
          demonstrativoIfood: { periodoInicio: c.periodoInicio, periodoFim: c.periodoFim, origem: c.origem, justificativa: c.justificativa, liquidoInformadoCentavos: c.liquidoInformadoCentavos, recebivelId: r.recebivel.id },
        });
        let ajuste = null;
        if (c.ajustesCentavos > 0) ajuste = await n.registrarAjuste(cx, { alvoTipo: "RECEBIVEL", alvoId: r.recebivel.id, valorCentavos: c.ajustesCentavos, motivo: "Ajustes positivos do demonstrativo oficial do iFood", categoria: "OUTRAS_RECEITAS" });
        return { receita, recebivel: ajuste?.recebivel ?? r.recebivel, retencoes: r.lancamentosDeRetencao, ajuste: ajuste?.lancamento ?? null, repetido: false };
      });
    },
  };
}
