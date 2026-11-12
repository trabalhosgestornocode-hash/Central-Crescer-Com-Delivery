// Apuração por competência: carrega os registros do escopo e entrega o MESMO resultado para DRE, Visão Geral e
// composição ("Ver composição completa"). A impressão permite reproduzir e comparar apurações.
import { createHash } from "node:crypto";
import { CODIGO, falhar } from "../dominio/erros.js";
import { TIPO } from "../dominio/catalogos.js";
import { exigirCompetencia } from "../dominio/tempo.js";
import { semCamposDesconhecidos } from "../dominio/validacao.js";
import { apurar } from "../dominio/apuracao.js";

const canonico = (v) => (Array.isArray(v) ? `[${v.map(canonico).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));

export function operacoesDeApuracao(b) {
  async function calcular(cx, tx, competencia) {
    const listar = (tipo) => tx.listar(cx, tipo);
    const dados = {
      lancamentos: await listar(TIPO.LANCAMENTO), categorias: await listar(TIPO.CATEGORIA), vendas: await listar(TIPO.VENDA), propostas: await listar(TIPO.PROPOSTA),
      obrigacoes: await listar(TIPO.OBRIGACAO), movimentacoes: await listar(TIPO.MOVIMENTACAO), recebiveis: await listar(TIPO.RECEBIVEL), ajustes: await listar(TIPO.AJUSTE),
      competencias: await listar(TIPO.COMPETENCIA),
    };
    const r = apurar(dados, { competencia, escopo: { organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId }, apuradoEm: b.agora() });
    return { ...r, impressao: createHash("sha256").update(canonico({ entradas: r.entradas, metodologia: r.metodologia, competencia })).digest("hex") };
  }
  const entrada = (e, extras = []) => {
    semCamposDesconhecidos(e, ["competencia", ...extras], "apuracao");
    return exigirCompetencia(e.competencia);
  };
  return {
    /** DRE Gerencial completa + todos os indicadores + "cada R$ 100" da competência. */
    apurarCompetencia(ctx, e) {
      const comp = entrada(e);
      return b.consultar(ctx, (cx, tx) => calcular(cx, tx, comp));
    },
    /** Visão Geral: os MESMOS objetos da apuração (nenhuma fórmula própria). */
    apurarVisaoGeral(ctx, e) {
      const comp = entrada(e);
      return b.consultar(ctx, async (cx, tx) => {
        const r = await calcular(cx, tx, comp);
        return {
          competencia: comp, impressao: r.impressao, faturamentoBruto: r.indicadores.FATURAMENTO_BRUTO_PROPRIO,
          faturamentoLiquidoGerencial: r.indicadores.FATURAMENTO_LIQUIDO_GERENCIAL, resultadoGerencial: r.indicadores.RESULTADO_GERENCIAL, cadaCem: r.cadaCem,
        };
      });
    },
    /** "Ver composição completa" de um indicador: a mesma árvore que sustenta o cálculo. */
    composicaoDoIndicador(ctx, e) {
      const comp = entrada(e, ["codigo"]);
      return b.consultar(ctx, async (cx, tx) => {
        const r = await calcular(cx, tx, comp);
        const ind = r.indicadores[e.codigo];
        if (!ind) falhar(CODIGO.ENTRADA_INVALIDA, "Indicador desconhecido.", { codigo: typeof e.codigo === "string" ? e.codigo.slice(0, 60) : null });
        return ind;
      });
    },
  };
}
