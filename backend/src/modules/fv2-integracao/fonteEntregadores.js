// PONTE parser Foody → Financeiro v2 (somente leitura). Reutiliza a MESMA análise do Dashboard Operacional (analisarPeriodo):
// uma fonte por dia (planilha ou Foody), classificação de cancelamentos, correções manuais e lançamentos operacionais.
// Nenhum pedido é copiado nem gravado; nenhum dado do parser é alterado. O resultado fica até 60 s em memória por semana.
import { ehCancelado } from "../parser-food-delivery/parserFoodDelivery.calc.js";

const paraCentavos = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));
const TIPO_DO_LANCAMENTO = Object.freeze({ manual: "ENTREGA_MANUAL", taxa_adicional: "TAXA_ADICIONAL", avulso: "MOVIMENTACAO_OPERACIONAL" });

/** Pedidos e lançamentos da análise do parser → linhas neutras do Financeiro. Pura. */
export function linhasDaAnalise(analise, chaveDe) {
  const entregas = (analise.pedidos ?? []).map((p) => {
    const cancelado = ehCancelado(p.situacao);
    const decisao = p.classificacaoEfetiva ?? p.classificacaoCancelamento ?? null;
    return {
      id: `pedido:${p.numeroPedido}|${String(p.dataHora).slice(0, 10)}`, tipo: "ENTREGA", entregadorChave: chaveDe(p.entregador), entregadorNome: String(p.entregador).trim().replace(/\s+/g, " "), entregadorId: p.entregadorId ?? null,
      data: String(p.dataHora).slice(0, 10), numeroPedido: p.numeroPedido ?? null, situacao: p.situacao ?? null, valorCentavos: paraCentavos(p.taxaEntregador),
      elegivel: p.statusConciliacao !== "excluido", emRevisao: cancelado && decisao === "revisar" && !p.classificacaoOverrideEm, motivo: cancelado ? "Cancelado com direito à taxa" : null,
    };
  });
  const lancamentos = (analise.lancamentos ?? []).filter((l) => !l.excluido).map((l) => ({
    id: `lancamento:${l.id}`, tipo: TIPO_DO_LANCAMENTO[l.origem] ?? "AJUSTE", entregadorChave: l.entregadorChave, entregadorNome: l.entregadorNome, entregadorId: l.entregadorId ?? null, data: l.data,
    numeroPedido: l.numeroPedido ?? null, situacao: l.situacao ?? null, valorCentavos: paraCentavos(l.valor), elegivel: !(l.origem === "manual" && l.classificacao === "nao_recebe_taxa"), emRevisao: false, motivo: l.motivoRotulo ?? null,
  }));
  return [...entregas, ...lancamentos];
}

/**
 * @param {{db:object, analisar?:Function, cobertura?:Function, chaveDe?:Function, agora?:()=>number, validadeMs?:number}} p
 *   `analisar`, `cobertura` e `chaveDe` são injetáveis para teste; por padrão vêm do módulo do parser (carregado só no primeiro uso).
 */
export function criarFonteEntregadores({ db, analisar, cobertura, chaveDe, agora = () => Date.now(), validadeMs = 60_000 }) {
  const cache = new Map();
  async function dependencias() {
    if (analisar && cobertura && chaveDe) return { analisar, cobertura, chaveDe };
    const [servico, foody, calc] = await Promise.all([import("../parser-food-delivery/parserFoodDelivery.service.js"), import("../parser-food-delivery/parserFoodDelivery.foodyPedidos.js"), import("../parser-food-delivery/parserFoodDelivery.calc.js")]);
    return { analisar: analisar ?? servico.analisarPeriodo, cobertura: cobertura ?? foody.carregarCoberturaFoody, chaveDe: chaveDe ?? calc.chaveEntregador };
  }
  async function ler({ organizacaoId, unidadeId, inicio, fim }) {
    const d = await dependencias();
    const c = await d.cobertura({ db, organizacaoId, unidadeId, dataInicio: inicio, dataFim: fim });
    if (!c) return { disponivel: false, motivo: "PARSER_FOODY_DESLIGADO_NA_UNIDADE", dias: [], entregas: [] };
    if (c.erro) return { disponivel: false, motivo: c.erro, dias: [], entregas: [] };
    const analise = await d.analisar({ organizacaoId, unidadeId, dataInicio: inicio, dataFim: fim });
    if (analise.fonteFoodyPedidos?.erro) return { disponivel: false, motivo: analise.fonteFoodyPedidos.erro, dias: [], entregas: [] };
    return {
      disponivel: true, atualizadoEm: analise.fonteFoodyPedidos?.ultimaSincronizacao ?? null, entregas: linhasDaAnalise(analise, d.chaveDe),
      dias: c.dias.map((x) => ({ data: x.data, fonte: x.fonte, provisorio: x.provisorio, aberto: x.aberto, triagem: x.triagem })),
    };
  }
  return Object.freeze({
    async apurar(p) {
      const chave = `${p.organizacaoId}|${p.unidadeId}|${p.inicio}|${p.fim}`;
      const guardado = cache.get(chave);
      if (guardado && guardado.ate > agora()) return guardado.valor;
      const valor = await ler(p);
      if (cache.size > 200) cache.clear();
      cache.set(chave, { valor, ate: agora() + validadeMs });
      return valor;
    },
  });
}
