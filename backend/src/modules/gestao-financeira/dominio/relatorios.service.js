// Projeções financeiras (regime de caixa) sobre o motor. Tudo é RECALCULADO a cada chamada a partir dos lançamentos:
// nenhum indicador é gravado nem copiado de constante.
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";
import { periodo, enumerado, bad } from "./validacao.js";
import { apurar, saldosPorConta, INDICADORES, validarParesTransferencia } from "../../../financeiro-calculos/motor.js";
import { paraEntradaMotor, aberturasComoLancamentos, montarDre, compararDres, rankingCategorias, serieMovimento, movimentoPorConta } from "../../../financeiro-calculos/relatorios.js";
import { formatarBps, formatarCentavos } from "../../../financeiro-calculos/dinheiro.js";

const padrao = { repo: repositorio, db: undefined };

async function carregar(ctx, { de, ate }, deps) {
  const [lancs, cats, contas, aberturas] = await Promise.all([
    deps.repo.listarTodosLancamentos(ctx, { de, ate }, deps.db),
    deps.repo.listarPlanoContas(ctx, deps.db),
    deps.repo.listarContas(ctx, deps.db),
    deps.repo.listarAberturas(ctx, deps.db),
  ]);
  const categoriasPorId = new Map(cats.map((c) => [c.id, c]));
  return { lancs, cats, categoriasPorId, contas, aberturas };
}

/** Entrada do motor para o período: lançamentos classificados + aberturas do período como "saldo anterior". */
function entradaMotor(base, { de, ate }) {
  const mov = paraEntradaMotor(base.lancs, base.categoriasPorId);
  return { mov, comAberturas: [...mov, ...aberturasComoLancamentos(base.aberturas, de, ate)] };
}

function pendencias(base) {
  const semCategoria = base.lancs.filter((l) => !l.categoria_id && l.status !== "cancelado");
  const pendentes = base.lancs.filter((l) => l.classificacao_pendente && l.status !== "cancelado");
  return { semCategoria: semCategoria.length, pendentes: pendentes.length, valorPendenteCentavos: pendentes.reduce((s, l) => s + Number(l.valor_centavos), 0) };
}

function contasSemAbertura(base) {
  const comAb = new Set(base.aberturas.map((a) => a.conta_id));
  return base.contas.filter((c) => c.ativo && !comAb.has(c.id)).map((c) => ({ id: c.id, nome: c.nome }));
}

export async function visaoGeral(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const p = periodo(q);
  const base = await carregar(c, p, deps);
  const { mov, comAberturas } = entradaMotor(base, p);
  const r = apurar(comAberturas);
  const semAb = contasSemAbertura(base);
  const movSaldo = p.de ? paraEntradaMotor((await carregar(c, { de: undefined, ate: p.ate }, deps)).lancs, base.categoriasPorId) : mov;
  const saldos = saldosPorConta(base.contas.filter((x) => x.ativo), abrirMapa(base.aberturas), aposAbertura(movSaldo, base.aberturas));
  const pend = pendencias(base);
  const vazio = base.lancs.length === 0;
  return {
    regime: r.regime, periodo: p, vazio,
    indicadores: { ...r, ponteResultadoCaixa: r.ponteResultadoCaixa },
    saldosPorConta: { ...saldos, conciliado: false, rotulo: "Saldo calculado a partir dos lançamentos; NÃO conciliado com extrato externo." },
    aberturasDesconhecidas: semAb,
    saldoFinalParcial: semAb.length > 0,
    pendencias: pend,
    alertas: [
      ...(pend.pendentes ? [{ nivel: "atencao", codigo: "PENDENCIAS_CLASSIFICACAO", texto: `${pend.pendentes} lançamento(s) com classificação pendente.` }] : []),
      ...(semAb.length ? [{ nivel: "atencao", codigo: "ABERTURA_DESCONHECIDA", texto: `Saldo de abertura desconhecido: ${semAb.map((x) => x.nome).join(", ")}. Saldos dessas contas são parciais.` }] : []),
      ...(!r.ponteResultadoCaixa.fecha ? [{ nivel: "erro", codigo: "PONTE_NAO_FECHA", texto: "A ponte resultado→caixa não fecha: há lançamentos sem classificação." }] : []),
    ],
    serie: serieMovimento(mov, { agrupar: "dia" }),
    movimentoPorConta: movimentoPorConta(mov, base.contas),
    destaque: r.apresentacao,
  };
}

/** Movimentos anteriores à data da abertura da conta já estão embutidos no saldo de abertura. */
function aposAbertura(mov, aberturas) {
  const dataAb = new Map();
  for (const a of aberturas) if (!dataAb.has(a.conta_id) || String(a.data_referencia) > dataAb.get(a.conta_id)) dataAb.set(a.conta_id, String(a.data_referencia));
  return mov.filter((l) => !dataAb.has(l.contaId) || String(l.data) >= dataAb.get(l.contaId));
}

function abrirMapa(aberturas) {
  // abertura mais recente por conta
  const m = new Map();
  for (const a of [...aberturas].sort((x, y) => String(x.data_referencia).localeCompare(String(y.data_referencia)))) m.set(a.conta_id, Number(a.valor_centavos));
  return m;
}

export async function dre(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const p = periodo(q);
  const base = await carregar(c, p, deps);
  const { comAberturas } = entradaMotor(base, p);
  const atual = montarDre(comAberturas, base.categoriasPorId);
  let comparacao = null;
  const pc = periodo({ de: q?.compararDe, ate: q?.compararAte });
  if (pc.de || pc.ate) {
    const base2 = await carregar(c, pc, deps);
    const anterior = montarDre(entradaMotor(base2, pc).comAberturas, base2.categoriasPorId);
    comparacao = { periodo: pc, linhas: compararDres(atual, anterior), parcial: anterior.parcial };
  }
  return { periodo: p, vazio: base.lancs.length === 0, ...atual, apuracao: undefined, resumo: { parcial: atual.parcial, ponteFecha: atual.apuracao.ponteResultadoCaixa.fecha }, comparacao };
}

export async function indicadores(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const p = periodo(q);
  const base = await carregar(c, p, deps);
  const r = apurar(entradaMotor(base, p).comAberturas);
  const valor = {
    receitaOperacional: { centavos: r.receitaOperacional },
    custosVariaveis: { centavos: r.custosVariaveis },
    margemContribuicao: { centavos: r.margemContribuicao },
    margemContribuicaoPct: { bps: r.margemContribuicaoBps, texto: formatarBps(r.margemContribuicaoBps) },
    resultadoGerencial: { centavos: r.resultadoGerencial },
    margemLiquidaPct: { bps: r.margemLiquidaBps, texto: formatarBps(r.margemLiquidaBps) },
    pontoEquilibrio: { centavos: r.pontoEquilibrio },
    geracaoCaixaOperacional: { centavos: r.resultadoGerencial },
    variacaoCaixa: { centavos: r.variacaoCaixa },
    saldoFinal: { centavos: r.saldoFinal },
  };
  const semAb = contasSemAbertura(base);
  return {
    periodo: p, vazio: base.lancs.length === 0, regime: r.regime,
    itens: INDICADORES.map((i) => {
      const v = valor[i.id];
      const indisponivel = v == null || v.centavos === null || v.bps === null;
      const parcial = r.parcial || (i.id === "saldoFinal" && semAb.length > 0);
      return { ...i, valor: v ?? null, texto: v?.centavos != null ? formatarCentavos(v.centavos) : (v?.texto ?? null), status: indisponivel ? "indisponivel" : parcial ? "parcial" : "ok" };
    }),
    ponteResultadoCaixa: r.ponteResultadoCaixa,
  };
}

export async function categorias(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const p = periodo(q);
  const base = await carregar(c, p, deps);
  const { mov } = entradaMotor(base, p);
  return { periodo: p, vazio: base.lancs.length === 0, regime: "caixa", ...rankingCategorias(mov, base.categoriasPorId) };
}

/** Extrato interno de uma conta no período: lançamentos + saldo corrente calculado (parcial se a abertura é desconhecida). */
export async function extratoConta(ctx, contaId, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const p = periodo(q);
  const base = await carregar(c, { de: undefined, ate: p.ate }, deps);
  const conta = base.contas.find((x) => x.id === contaId);
  if (!conta) throw bad("Conta não encontrada.", "CONTA_INEXISTENTE");
  const ab = base.aberturas.filter((a) => a.conta_id === contaId).sort((a, b) => String(a.data_referencia).localeCompare(String(b.data_referencia))).at(-1) ?? null;
  const ls = base.lancs.filter((l) => l.conta_id === contaId && l.status === "realizado" && (!ab || l.data_movimento >= ab.data_referencia)).sort((a, b) => String(a.data_movimento).localeCompare(String(b.data_movimento)) || String(a.id).localeCompare(String(b.id)));
  let corrente = ab ? Number(ab.valor_centavos) : 0;
  const linhas = ls.map((l) => { corrente += l.sentido === "entrada" ? Number(l.valor_centavos) : -Number(l.valor_centavos); return { ...l, saldoCorrenteCentavos: corrente }; });
  const visiveis = p.de ? linhas.filter((l) => l.data_movimento >= p.de) : linhas;
  return { conta, aberturaCentavos: ab ? Number(ab.valor_centavos) : null, aberturaData: ab?.data_referencia ?? null, parcial: !ab, conciliado: false, saldoCentavos: ab ? corrente : null, saldoSemAberturaCentavos: ab ? null : corrente, linhas: visiveis };
}

/** Integridade: pares defeituosos e totais que não fecham — para a tela de pendências e para os testes de homologação. */
export async function integridade(ctx, q, deps = padrao) {
  const c = exigirContexto(ctx);
  const p = periodo(q);
  const base = await carregar(c, p, deps);
  const { comAberturas } = entradaMotor(base, p);
  const r = apurar(comAberturas);
  const transf = await deps.repo.listarTransferencias(c, deps.db);
  const legs = new Map();
  for (const t of transf) { legs.set(t.lancamento_saida_id, t.id); legs.set(t.lancamento_entrada_id, t.id); }
  const comPar = paraEntradaMotor(base.lancs, base.categoriasPorId).map((l) => ({ ...l, parId: legs.get(l.id) ?? null }));
  return { ponteFecha: r.ponteResultadoCaixa.fecha, diferencaPonteCentavos: r.ponteResultadoCaixa.diferenca, violacoesPares: validarParesTransferencia(comPar), semClassificacao: r.contagem.semPapel };
}

export const _paraTeste = { entradaMotor, abrirMapa };
export { enumerado };
