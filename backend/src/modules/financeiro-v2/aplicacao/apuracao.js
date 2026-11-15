// Apuração por competência: carrega os registros do escopo e entrega o MESMO resultado para DRE, Visão Geral e
// composição ("Ver composição completa"). A impressão permite reproduzir e comparar apurações.
import { createHash } from "node:crypto";
import { CODIGO, falhar } from "../dominio/erros.js";
import { TIPO } from "../dominio/catalogos.js";
import { exigirCompetencia, primeiroDiaDe, ultimoDiaDe } from "../dominio/tempo.js";
import { semCamposDesconhecidos } from "../dominio/validacao.js";
import { apurar } from "../dominio/apuracao.js";

/** Impressão (sha256) de uma apuração: depende só das entradas, da metodologia e da competência — nunca do estado nem da hora. */
export const impressaoDaApuracao = (r, competencia) => createHash("sha256").update(canonico({ entradas: r.entradas, metodologia: r.metodologia, competencia })).digest("hex");
const canonico = (v) => (Array.isArray(v) ? `[${v.map(canonico).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));

export function operacoesDeApuracao(b) {
  async function calcular(cx, tx, competencia) {
    const listar = (tipo) => tx.listar(cx, tipo);
    // 07 (desempenho): a apuração de UM mês só lê os registros DESSE mês — filtrados no banco. Antes lia o histórico
    // inteiro (o tempo crescia com os meses acumulados). Lançamentos, vendas, propostas, títulos e ajustes que a apuração
    // cruza pertencem sempre à competência do lançamento; movimentações, pelo período do mês (paginado no banco).
    const doMes = (tipo) => tx.listar(cx, tipo, { onde: { competencia } });
    const movimentacoesDoMes = async () => {
      const saida = [];
      for (let deslocamento = 0; ; deslocamento += 500) {
        const pg = await tx.paginar(cx, TIPO.MOVIMENTACAO, { desde: { dataEfetiva: primeiroDiaDe(competencia) }, ate: { dataEfetiva: ultimoDiaDe(competencia) }, limite: 500, deslocamento, ordem: [{ campo: "dataEfetiva" }] });
        saida.push(...pg.itens);
        if (saida.length >= pg.total || !pg.itens.length) return saida;
      }
    };
    const dados = {
      lancamentos: await doMes(TIPO.LANCAMENTO), categorias: await listar(TIPO.CATEGORIA), vendas: await doMes(TIPO.VENDA), propostas: await doMes(TIPO.PROPOSTA),
      obrigacoes: await doMes(TIPO.OBRIGACAO), movimentacoes: await movimentacoesDoMes(), recebiveis: await doMes(TIPO.RECEBIVEL), ajustes: await doMes(TIPO.AJUSTE),
      competencias: await listar(TIPO.COMPETENCIA),
    };
    const r = apurar(dados, { competencia, escopo: { organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId }, apuradoEm: b.agora() });
    // 06D: competência homologada → a versão homologada (retrato imutável) acompanha a apuração atual, com a conferência
    // de reprodutibilidade. A tela apresenta a versão homologada; a atual só aparece como comparação.
    const impressao = impressaoDaApuracao(r, competencia);
    const estado = dados.competencias.find((x) => x.competencia === competencia);
    let versaoHomologada = null;
    if (estado?.estado === "FECHAMENTO_HOMOLOGADO") {
      const versoes = await tx.listar(cx, TIPO.VERSAO_FECHAMENTO, { onde: { competencia, tipo: "HOMOLOGADA" } });
      const v = versoes.sort((a, b) => b.numero - a.numero)[0] ?? null;
      if (v) versaoHomologada = { numero: v.numero, decididoEm: v.decididoEm, metodologiaVersao: v.metodologiaVersao, impressao: v.impressao, reproduz: v.impressao === impressao, apuracao: v.apuracao };
    }
    // 07: competência homologada com retrato completo → a APRESENTAÇÃO (indicadores, DRE, composição, cada R$ 100) vem da
    // versão homologada, congelada; a apuração atual fica só como conferência (impressão, `atual`).
    if (versaoHomologada?.apuracao?.completo) {
      const v = versaoHomologada.apuracao;
      return {
        ...r, impressao, versaoHomologada, fonteDaApresentacao: "VERSAO_HOMOLOGADA",
        indicadores: v.indicadores, dre: { ...v.dre, estadoDaCompetencia: "FECHAMENTO_HOMOLOGADO" }, cadaCem: v.cadaCem ?? r.cadaCem,
        atual: { impressao, indicadores: r.indicadores },
      };
    }
    return { ...r, impressao, versaoHomologada, fonteDaApresentacao: "APURACAO_ATUAL" };
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
          receitaLiquidaComercial: r.indicadores.RECEITA_LIQUIDA_COMERCIAL,
          // doc 39: os quatro números da Visão Geral saem do MESMO cálculo da DRE (a tela não faz conta).
          deducoesComerciaisCentavos: r.indicadores.DEDUCOES_COMERCIAIS?.valorCentavos ?? null,
          custosEDespesasCentavos: r.indicadores.RECEITA_LIQUIDA_COMERCIAL?.valorCentavos != null && r.indicadores.RESULTADO_GERENCIAL?.valorCentavos != null
            ? r.indicadores.RECEITA_LIQUIDA_COMERCIAL.valorCentavos - r.indicadores.RESULTADO_GERENCIAL.valorCentavos : null,
          fonteDaApresentacao: r.fonteDaApresentacao, versaoHomologada: r.versaoHomologada ? { numero: r.versaoHomologada.numero, decididoEm: r.versaoHomologada.decididoEm, reproduz: r.versaoHomologada.reproduz } : null,
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
        return { ...ind, fonte: r.fonteDaApresentacao, versaoHomologada: r.versaoHomologada ? { numero: r.versaoHomologada.numero, decididoEm: r.versaoHomologada.decididoEm } : null };
      });
    },
  };
}
