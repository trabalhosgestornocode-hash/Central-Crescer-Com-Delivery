// QUANTIDADE DE ENTREGAS nas linhas de entrega da DRE (somente leitura; nenhum cálculo financeiro da DRE muda).
//
//   * ENTREGADORES_PROPRIOS — semanas FECHADAS que compõem a linha (entregas guardadas no fechamento semanal); sem
//     nenhuma conta na linha, cai na contagem ao vivo do parser Foody (provisória). Parser Foody (mesma porta e mesma regra da área Entregadores Próprios):
//     conta só itens do tipo ENTREGA elegíveis e com entregador; cancelado só conta quando o parser o manteve com direito
//     à taxa. Lançamentos manuais, taxas adicionais, ajustes e PIX nunca contam como entrega. Itens repetidos (mesmo id)
//     contam uma vez.
//   * ENTREGA_SOB_DEMANDA — fonte oficial: Conciliação Financeira do iFood. Conta PEDIDOS distintos cuja cobrança líquida
//     de entrega sob demanda ficou maior que zero na competência (cobrança estornada por inteiro não conta).
//   * ENTREGAS_TERCEIRIZADAS — quantidade informada na descrição de cada lançamento da categoria (ex.: "(159 ENTREGAS)"),
//     somada; lançamento sem quantidade deixa o total parcial (decisão do usuário em 24/11/2026).
//
// Situações: COM_DADOS (quantidade pode ser 0), SEM_DADOS (fonte integrada, mas nada importado na competência),
// SEM_FONTE (não existe fonte oficial integrada) e INDISPONIVEL (a fonte não respondeu).
import { SITUACAO_REGISTRO_FONTE, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { consolidar } from "../dominio/entregadoresProprios.js";
import { exigirCompetencia, primeiroDiaDe, ultimoDiaDe } from "../dominio/tempo.js";
import { semCamposDesconhecidos } from "../dominio/validacao.js";

export const SITUACAO_QUANTIDADE = Object.freeze({ COM_DADOS: "COM_DADOS", SEM_DADOS: "SEM_DADOS", SEM_FONTE: "SEM_FONTE", INDISPONIVEL: "INDISPONIVEL" });
const S = SITUACAO_QUANTIDADE;
const RELATORIO_CONCILIACAO_IFOOD = "IFOOD_CONCILIACAO";

/** Entregas próprias a partir da apuração do parser (linhas neutras). Pura. */
export function contarEntregasProprias(apuracao, { inicio, fim }) {
  if (!apuracao?.disponivel) return { situacao: S.INDISPONIVEL, quantidade: null, motivo: apuracao?.motivo ?? "SEM_RESPOSTA", fonte: "FOODY" };
  const unicas = new Map();
  for (const e of apuracao.entregas ?? []) if (e.data >= inicio && e.data <= fim && !unicas.has(e.id)) unicas.set(e.id, e);
  const grupos = consolidar([...unicas.values()]);
  const quantidade = grupos.reduce((s, g) => s + g.entregas, 0);
  const dias = (apuracao.dias ?? []).filter((d) => d.data >= inicio && d.data <= fim);
  const provisorio = dias.some((d) => d.provisorio || d.aberto || d.triagem) || [...unicas.values()].some((e) => e.emRevisao);
  if (!quantidade && !dias.some((d) => d.fonte)) return { situacao: S.SEM_DADOS, quantidade: null, fonte: "FOODY", provisorio: false };
  return { situacao: S.COM_DADOS, quantidade, fonte: "FOODY", provisorio, atualizadoEm: apuracao.atualizadoEm ?? null };
}

/** Pedidos com entrega sob demanda cobrada (líquida > 0) nos movimentos da Conciliação iFood. Pura. */
export function contarEntregasSobDemanda(movimentos) {
  if (!movimentos.length) return { situacao: S.SEM_DADOS, quantidade: null, fonte: "IFOOD_CONCILIACAO" };
  const porPedido = new Map();
  for (const r of movimentos) {
    if (r.dados?.componente !== "ENTREGA_SOB_DEMANDA" || !r.dados?.pedido) continue;
    porPedido.set(r.dados.pedido, (porPedido.get(r.dados.pedido) ?? 0) + r.valorCentavos); // cobrança é negativa
  }
  const cobrados = [...porPedido.values()].filter((v) => v < 0);
  return { situacao: S.COM_DADOS, quantidade: cobrados.length, fonte: "IFOOD_CONCILIACAO", valorCentavos: -cobrados.reduce((s, v) => s + v, 0) };
}

// "HASTAG ENTREGAS DE 02/11 A 08/11 (159 ENTREGAS)" → 159. Só número seguido de "entrega(s)"; datas e valores não casam.
const QUANTIDADE_NA_DESCRICAO = /(?:^|[^\d.,/])(\d{1,6})\s*entregas?\b/i;
export const quantidadeNaDescricao = (texto) => { const m = QUANTIDADE_NA_DESCRICAO.exec(String(texto ?? "")); return m ? Number(m[1]) : null; };

/**
 * Entregas terceirizadas: a quantidade vem da DESCRIÇÃO de cada lançamento da categoria (ex.: "(159 ENTREGAS)"), como a
 * empresa de entregas cobra. Lançamento de valor positivo sem quantidade na descrição deixa o total PARCIAL (nunca é
 * presumido); ajustes negativos (correções de valor) não mudam a quantidade. Pura.
 */
export function contarEntregasTerceirizadas(lancamentos) {
  const ativos = lancamentos.filter((l) => l.situacao === "ATIVO");
  if (!ativos.length) return { situacao: S.SEM_DADOS, quantidade: null, fonte: "DESCRICAO_DOS_LANCAMENTOS" };
  let quantidade = 0; let comQuantidade = 0; let semQuantidade = 0;
  for (const l of ativos) {
    const q = quantidadeNaDescricao(l.descricao);
    if (q !== null) { quantidade += q; comQuantidade += 1; } else if (l.valorCentavos > 0) semQuantidade += 1;
  }
  if (!comQuantidade) return { situacao: S.SEM_DADOS, quantidade: null, fonte: "DESCRICAO_DOS_LANCAMENTOS", semQuantidade };
  return { situacao: S.COM_DADOS, quantidade, fonte: "DESCRICAO_DOS_LANCAMENTOS", parcial: semQuantidade > 0, lancamentos: comQuantidade, semQuantidade };
}

/** Entregas das semanas fechadas que compõem a linha Entregadores Próprios da competência. null = nenhuma conta na linha. Pura. */
export function contarEntregasDasSemanasFechadas(lancamentos, obrigacoes, fechamentos) {
  const ativos = lancamentos.filter((l) => l.situacao === "ATIVO" && l.valorCentavos > 0);
  if (!ativos.length) return null;
  const obrigacaoDoLancamento = new Map(obrigacoes.map((o) => [o.lancamentoId, o.id]));
  const fechamentoDaObrigacao = new Map(fechamentos.map((f) => [f.obrigacaoId, f]));
  let quantidade = 0; let semFechamento = 0;
  for (const l of ativos) {
    const f = fechamentoDaObrigacao.get(obrigacaoDoLancamento.get(l.id));
    if (f) quantidade += f.entregas ?? 0; else semFechamento += 1;
  }
  return { situacao: S.COM_DADOS, quantidade, fonte: "SEMANAS_FECHADAS", provisorio: false, parcial: semFechamento > 0, semQuantidade: semFechamento };
}

export function operacoesDeQuantidadesDeEntregas(b, { fonte = null } = {}) {
  return {
    /** Quantidade de entregas por linha de entrega da DRE, na competência e unidade do contexto. Nunca falha por fonte externa. */
    async quantidadesDeEntregas(ctx, e = {}) {
      semCamposDesconhecidos(e, ["competencia"], "entregas");
      const comp = exigirCompetencia(e.competencia);
      const cx0 = b.autorizarContexto(ctx, ACAO.VER);
      const inicio = primeiroDiaDe(comp);
      const ultimo = ultimoDiaDe(comp);
      const hoje = b.hoje();
      const fim = ultimo < hoje ? ultimo : hoje;
      let proprios;
      if (!fonte) proprios = { situacao: S.SEM_FONTE, quantidade: null, fonte: "FOODY", motivo: "FONTE_NAO_CONFIGURADA" };
      else if (inicio > hoje) proprios = { situacao: S.SEM_DADOS, quantidade: null, fonte: "FOODY", provisorio: false };
      else {
        let apuracao;
        try { apuracao = await fonte.apurar({ organizacaoId: cx0.organizacaoId, unidadeId: cx0.unidadeId, inicio, fim }); } catch { apuracao = { disponivel: false, motivo: "FALHA_NA_LEITURA" }; }
        proprios = apuracao?.motivo === "PARSER_FOODY_DESLIGADO_NA_UNIDADE" ? { situacao: S.SEM_FONTE, quantidade: null, fonte: "FOODY", motivo: apuracao.motivo } : contarEntregasProprias(apuracao, { inicio, fim });
      }
      const { sobDemanda, terceirizadas, semanas } = await b.consultar(ctx, async (cx, tx) => ({
        sobDemanda: contarEntregasSobDemanda(await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "IFOOD", tipoRelatorio: RELATORIO_CONCILIACAO_IFOOD, competencia: comp, situacao: SITUACAO_REGISTRO_FONTE.ATIVO } })),
        terceirizadas: contarEntregasTerceirizadas(await tx.listar(cx, TIPO.LANCAMENTO, { onde: { competencia: comp, categoria: "ENTREGAS_TERCEIRIZADAS" } })),
        semanas: contarEntregasDasSemanasFechadas(
          await tx.listar(cx, TIPO.LANCAMENTO, { onde: { competencia: comp, categoria: "ENTREGADORES_PROPRIOS" } }),
          await tx.listar(cx, TIPO.OBRIGACAO), await tx.listar(cx, TIPO.FECHAMENTO_ENTREGADOR)),
      }));
      // 24/11/2026 (pedido do usuário): a quantidade é a das SEMANAS FECHADAS que formam o valor da linha (o fechamento
      // semanal guarda as entregas). Sem nenhuma conta na linha da competência, mostra a contagem do parser (provisória).
      if (semanas) proprios = semanas;
      return {
        competencia: comp,
        linhas: {
          ENTREGADORES_PROPRIOS: proprios,
          ENTREGAS_TERCEIRIZADAS: terceirizadas,
          ENTREGA_SOB_DEMANDA: sobDemanda,
        },
      };
    },
  };
}
