// QUANTIDADE DE ENTREGAS nas linhas de entrega da DRE (somente leitura; nenhum cálculo financeiro da DRE muda).
//
//   * ENTREGADORES_PROPRIOS — fonte oficial: parser Foody (mesma porta e mesma regra da área Entregadores Próprios):
//     conta só itens do tipo ENTREGA elegíveis e com entregador; cancelado só conta quando o parser o manteve com direito
//     à taxa. Lançamentos manuais, taxas adicionais, ajustes e PIX nunca contam como entrega. Itens repetidos (mesmo id)
//     contam uma vez.
//   * ENTREGA_SOB_DEMANDA — fonte oficial: Conciliação Financeira do iFood. Conta PEDIDOS distintos cuja cobrança líquida
//     de entrega sob demanda ficou maior que zero na competência (cobrança estornada por inteiro não conta).
//   * ENTREGAS_TERCEIRIZADAS — não há fonte oficial integrada com a quantidade (a nota da empresa de entregas não é lida):
//     a resposta diz SEM_FONTE, nunca zero.
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
      const sobDemanda = await b.consultar(ctx, async (cx, tx) => contarEntregasSobDemanda(
        (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "IFOOD", tipoRelatorio: RELATORIO_CONCILIACAO_IFOOD, competencia: comp, situacao: SITUACAO_REGISTRO_FONTE.ATIVO } })),
      ));
      return {
        competencia: comp,
        linhas: {
          ENTREGADORES_PROPRIOS: proprios,
          ENTREGAS_TERCEIRIZADAS: { situacao: S.SEM_FONTE, quantidade: null, fonte: null, motivo: "SEM_FONTE_OFICIAL_INTEGRADA" },
          ENTREGA_SOB_DEMANDA: sobDemanda,
        },
      };
    },
  };
}
