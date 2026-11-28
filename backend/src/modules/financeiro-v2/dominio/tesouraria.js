// Regras PURAS de tesouraria (Execução 06A): contas a pagar, contas a receber, caixa e bancos, calendário e fluxo de caixa.
//
// Tudo aqui é LEITURA dos registros que o núcleo já grava — nenhuma fórmula cria receita, despesa ou saldo:
//   * pagar/receber  → saldo dos títulos (obrigações e recebíveis); a situação exibida é derivada, nunca gravada;
//   * caixa e bancos → saldo = saldo informado (âncora documentada) + movimentações válidas; sem âncora o saldo é DESCONHECIDO;
//   * fluxo          → realizado (movimentações efetivas) e previsto (títulos em aberto) NUNCA se misturam;
//   * transferência interna não é entrada nem saída do consolidado; movimentação sem vínculo NÃO vira receita/despesa pelo sinal.
// Dinheiro sempre em centavos inteiros. Desconhecido é `null`, nunca zero.
import {
  NATUREZA_MOVIMENTACAO as NM, SENTIDO, SITUACAO_CONCILIACAO, SITUACAO_CORRESPONDENCIA, SITUACAO_LIQUIDACAO, SITUACAO_MOVIMENTACAO,
  SITUACAO_SESSAO_CAIXA, SITUACAO_TITULO, TIPO, TIPO_CONTA, ESTADO_COMPETENCIA,
} from "./catalogos.js";
import { somar, somarLista, subtrair } from "./dinheiro.js";

/** Situação de conciliação que a pessoa vê: saída toda vinculada a contas a pagar = conciliada; parte vinculada = parcial. */
export function conciliacaoEfetiva(m) {
  if (m.situacaoConciliacao !== "NAO_CONCILIADA" || m.sentido !== "SAIDA") return m.situacaoConciliacao;
  const alocado = m.alocadoCentavos ?? 0;
  return alocado <= 0 ? m.situacaoConciliacao : alocado >= m.valorCentavos ? "CONCILIADA" : "PARCIAL";
}
import { competenciaDe, diaDaSemana, diaNoMes, inicioDaSemana, primeiroDiaDe, somarDias, somarMeses, ultimoDiaDe } from "./tempo.js";

const enumerar = (...v) => Object.freeze(Object.fromEntries(v.map((x) => [x, x])));

export const SITUACAO_A_PAGAR = enumerar("EM_ABERTO", "PARCIALMENTE_PAGO", "PAGO", "VENCIDO", "CANCELADO", "AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA");
export const SITUACAO_A_RECEBER = enumerar("A_RECEBER", "PARCIALMENTE_RECEBIDO", "RECEBIDO", "ATRASADO", "SEM_PREVISAO_CONFIAVEL", "EM_DIVERGENCIA", "CANCELADO");
/** Recebimento direto (cliente/contraparte), recebível de operadora (nascido de venda) e repasse (demonstrativo da processadora). */
export const TIPO_DE_RECEBIVEL = enumerar("RECEBIMENTO_DIRETO", "RECEBIVEL_DE_OPERADORA", "REPASSE");
export const VINCULO_MOVIMENTO = enumerar(
  "TRANSFERENCIA_INTERNA", "RECEBIMENTO_DIRETO_DE_VENDA", "DEVOLUCAO_A_CLIENTE", "PAGAMENTO_DE_OBRIGACAO", "RECEBIMENTO_DE_TITULO", "SEM_VINCULO",
);
export const GRANULARIDADE = enumerar("DIA", "SEMANA", "MES");
export const SITUACAO_SALDO = enumerar("CALCULADO", "DESCONHECIDO");
/**
 * Referência de um saldo informado (auditoria A.1 da 06B). INICIO_DO_DIA = saldo antes de qualquer movimento do dia
 * ("saldo anterior" do extrato); FIM_DO_DIA = saldo depois de todos os movimentos do dia ("saldo final"). O saldo de
 * FIM_DO_DIA já contém os movimentos daquela data: eles NUNCA são somados de novo.
 */
export const REFERENCIA_SALDO = enumerar("INICIO_DO_DIA", "FIM_DO_DIA");
/**
 * Categoria do sistema para despesa/obrigação de natureza AINDA NÃO comprovada: fica fora da DRE até ser classificada.
 * (Na 06A, "OUTRAS_DESPESAS" era tratada como provisória aqui, mas a DRE a contava como despesa confirmada — corrigido na 06B.)
 */
export const CATEGORIA_PROVISORIA = "DESPESAS_A_CLASSIFICAR";
/** Classificação econômica exibida, separada da sugestão do banco (que nunca classifica nada). */
export const CLASSIFICACAO_ECONOMICA = enumerar("CONFIRMADA", "PENDENTE_DE_CLASSIFICACAO", "PATRIMONIAL", "NAO_SE_APLICA");

const indice = (lista) => new Map(lista.map((x) => [x.id, x]));
const agrupar = (lista, chave) => {
  const mapa = new Map();
  for (const x of lista) {
    const k = chave(x);
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(x);
  }
  return mapa;
};
const valida = (m) => m.situacao !== SITUACAO_MOVIMENTACAO.ESTORNADA;
/**
 * 09C — quantos movimentos uma lista representa. A carga dirigida de Caixa e Bancos pode trazer, FORA do período
 * consultado, RESUMOS DIÁRIOS somados no banco (um por conta, sentido e dia, só válidos: `quantidade` = movimentos
 * somados). Somas são idênticas (o resumo carrega o total do dia); contagens somam `quantidade`.
 */
const quantos = (lista) => lista.reduce((n, m) => n + (m.resumoDiario ? m.quantidade : 1), 0);
const sinal = (m) => (m.sentido === SENTIDO.ENTRADA ? m.valorCentavos : -m.valorCentavos);
const validoDaLiquidacao = (q) => subtrair(q.valorCentavos, q.estornadoCentavos ?? 0);
const FORMAS = Object.freeze({ DINHEIRO: "em dinheiro", PIX: "por Pix", DEBITO: "no débito", CREDITO: "no crédito", VALE: "em vale", OUTRA: "" });
const somarOuNulo = (valores) => (valores.some((v) => v === null) ? null : somar(...valores));

/** Índices de apoio, montados uma vez por consulta. */
export function preparar(d) {
  const liquidacoes = (d.liquidacoes ?? []).filter((q) => q.situacao !== SITUACAO_LIQUIDACAO.ESTORNADA && validoDaLiquidacao(q) > 0);
  const docsPorRegistro = agrupar(d.vinculos ?? [], (v) => `${v.registroTipo}:${v.registroId}`);
  const divergentes = new Set();
  for (const c of d.correspondencias ?? []) {
    if (c.situacao !== SITUACAO_CORRESPONDENCIA.DIVERGENTE) continue;
    for (const r of [...(c.ladoA ?? []), ...(c.ladoB ?? [])]) divergentes.add(`${r.tipo}:${r.id}`);
  }
  return {
    ...d,
    contaPorId: indice(d.contas ?? []), contrapartePorId: indice(d.contrapartes ?? []), lancamentoPorId: indice(d.lancamentos ?? []),
    movPorId: indice(d.movimentacoes ?? []), documentoPorId: indice(d.documentos ?? []), pagamentoPorId: indice(d.pagamentos ?? []),
    transferenciaPorId: indice(d.transferencias ?? []), obrigacaoPorId: indice(d.obrigacoes ?? []), recebivelPorId: indice(d.recebiveis ?? []),
    categoriaPorCodigo: new Map((d.categorias ?? []).map((c) => [c.codigo, c])),
    liquidacoesPorAlvo: agrupar(liquidacoes, (q) => q.alvoId), liquidacoesPorMov: agrupar(liquidacoes, (q) => q.movimentacaoId),
    ajustesPorAlvo: agrupar(d.ajustes ?? [], (a) => a.alvoId), docsPorRegistro, divergentes,
    homologadas: new Set((d.competencias ?? []).filter((c) => c.estado === ESTADO_COMPETENCIA.FECHAMENTO_HOMOLOGADO).map((c) => c.competencia)),
    // Sugestão do extrato (palavras do histórico) de cada movimentação nascida de proposta bancária. Só SUGESTÃO.
    categoriaBancariaPorMov: new Map((d.propostas ?? []).flatMap((pr) => (pr.categoriaBancaria
      ? (pr.efeitos ?? []).filter((e) => e.tipo === TIPO.MOVIMENTACAO).map((e) => [e.id, pr.categoriaBancaria]) : []))),
  };
}

/** Documentos de um registro: os citados nele + os vinculados. Só referência, tipo e descrição — nunca arquivo ou caminho. */
export function documentosDe(p, tipo, registro) {
  const ids = new Set([...(registro.documentoIds ?? []), ...(registro.documentoId ? [registro.documentoId] : [])]);
  for (const v of p.docsPorRegistro.get(`${tipo}:${registro.id}`) ?? []) ids.add(v.documentoId);
  return [...ids].map((id) => {
    const doc = p.documentoPorId.get(id);
    return { referencia: id, tipo: doc?.tipo ?? null, descricao: doc?.descricao ?? null };
  });
}

export function paginar(itens, pagina = 1, tamanho = 50) {
  const total = itens.length;
  const paginas = Math.max(1, Math.ceil(total / tamanho));
  const atual = Math.min(Math.max(1, pagina), paginas);
  const inicio = (atual - 1) * tamanho;
  return { itens: itens.slice(inicio, inicio + tamanho), paginacao: { pagina: atual, tamanho, total, paginas } };
}

// ------------------------------------------------------------------------------------------------------ contas a pagar

/**
 * Execução 17 — duas dimensões INDEPENDENTES: situação do PAGAMENTO (em aberto, parcial, pago, pago por comprovante) e
 * situação da CONCILIAÇÃO bancária (não conciliado, pendente, conciliado com extrato). "Pago por comprovante" nunca é
 * "conciliado": só a saída do extrato ligada ao pagamento concilia.
 */
export function dimensoesDoPagamento(o, pagamentos) {
  const validos = pagamentos.filter((x) => x.valorCentavos > 0);
  const pendentes = validos.filter((x) => x.conciliacaoBancaria === "CONCILIACAO_PENDENTE");
  const situacaoPagamento = o.situacao === SITUACAO_TITULO.CANCELADA ? "CANCELADO"
    : o.liquidadoCentavos === 0 ? "EM_ABERTO"
      : o.saldoCentavos > 0 ? "PARCIALMENTE_PAGO"
        : validos.some((x) => x.origem === "COMPROVANTE") ? "PAGO_POR_COMPROVANTE" : "PAGO";
  const situacaoConciliacao = validos.length === 0 ? "NAO_CONCILIADO" : pendentes.length ? "CONCILIACAO_PENDENTE" : "CONCILIADO_COM_EXTRATO";
  return { situacaoPagamento, situacaoConciliacao, aConciliarCentavos: pendentes.reduce((s, x) => s + x.valorCentavos, 0) };
}

export function situacaoAPagar(o, hoje, { provisoria = false } = {}) {
  if (o.situacao === SITUACAO_TITULO.CANCELADA) return SITUACAO_A_PAGAR.CANCELADO;
  if (o.saldoCentavos === 0) return SITUACAO_A_PAGAR.PAGO;
  // Vencimento passado NUNCA marca como pago: só muda a situação para vencido enquanto houver saldo.
  if (o.vencimento < hoje) return SITUACAO_A_PAGAR.VENCIDO;
  if (provisoria) return SITUACAO_A_PAGAR.AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA;
  return o.liquidadoCentavos > 0 ? SITUACAO_A_PAGAR.PARCIALMENTE_PAGO : SITUACAO_A_PAGAR.EM_ABERTO;
}

/** Pagamentos do dia agrupados pela SAÍDA (baixa agrupada = várias contas, um pagamento), sem perder cada conta. */
export function agruparPorSaida(pagos) {
  const grupos = new Map();
  for (const g of pagos) {
    const k = g.movimentacaoId ?? `conta:${g.tituloId}:${grupos.size}`;
    if (!grupos.has(k)) grupos.set(k, { movimentacaoId: g.movimentacaoId ?? null, conta: g.conta ?? null, itens: [] });
    grupos.get(k).itens.push(g);
  }
  return [...grupos.values()].map((x) => ({ ...x, valorCentavos: somarLista(x.itens, (g) => g.valorCentavos) }));
}

function pagamentosDoTitulo(p, tituloId) {
  return (p.liquidacoesPorAlvo.get(tituloId) ?? []).map((q) => {
    const mov = p.movPorId.get(q.movimentacaoId);
    return {
      liquidacaoId: q.id, movimentacaoId: q.movimentacaoId, data: q.dataEfetiva, valorCentavos: validoDaLiquidacao(q),
      conta: mov ? p.contaPorId.get(mov.contaId)?.nome ?? null : null, valorDaMovimentacaoCentavos: mov?.valorCentavos ?? null,
      titulosNaMesmaMovimentacao: q.movimentacaoId ? (p.liquidacoesPorMov.get(q.movimentacaoId) ?? []).length : 0,
      documentos: mov ? documentosDe(p, TIPO.MOVIMENTACAO, mov) : [],
      // Execução 17: pagamento por COMPROVANTE (sem saída do extrato) × pago com a saída do extrato.
      origem: q.origemDoVinculo === "COMPROVANTE" ? "COMPROVANTE" : "MOVIMENTACAO",
      conciliacaoBancaria: q.movimentacaoId ? "CONCILIADO_COM_EXTRATO" : "CONCILIACAO_PENDENTE",
      idTransacao: q.idTransacao ?? null,
    };
  }).sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
}

export function tituloAPagar(p, o, hoje) {
  const lancamento = p.lancamentoPorId.get(o.lancamentoId) ?? null;
  const categoria = lancamento ? p.categoriaPorCodigo.get(lancamento.categoria) ?? null : null;
  const fornecedor = p.contrapartePorId.get(o.contraparteId) ?? null;
  const documentos = documentosDe(p, TIPO.OBRIGACAO, o);
  const provisoria = !lancamento || lancamento.categoria === CATEGORIA_PROVISORIA;
  const classificacaoEconomica = provisoria ? CLASSIFICACAO_ECONOMICA.PENDENTE_DE_CLASSIFICACAO : lancamento.natureza === "PATRIMONIAL" ? CLASSIFICACAO_ECONOMICA.PATRIMONIAL : CLASSIFICACAO_ECONOMICA.CONFIRMADA;
  const situacao = situacaoAPagar(o, hoje, { provisoria });
  const pagamentos = pagamentosDoTitulo(p, o.id);
  const emAberto = o.situacao !== SITUACAO_TITULO.CANCELADA && o.saldoCentavos > 0;
  const pendencias = [];
  if (emAberto && documentos.length === 0) pendencias.push("SEM_DOCUMENTO");
  if (emAberto && provisoria) pendencias.push("CLASSIFICACAO_PROVISORIA");
  return {
    id: o.id, grupoId: o.grupoId, versao: o.versao, // 28/11: a versão vista (a correção estreita confere que a conta não mudou desde o resumo)
    fornecedor: fornecedor ? { id: fornecedor.id, nome: fornecedor.nome, tipo: fornecedor.tipo } : null,
    descricao: o.descricao, categoria: lancamento ? { codigo: lancamento.categoria, nome: categoria?.nome ?? lancamento.categoria } : null,
    classificacao: lancamento?.classificacao ?? null, natureza: lancamento?.natureza ?? null,
    // Obrigação CONSTITUÍDA (título registrado) — nunca confundir com previsão recorrente estimada.
    registro: "OBRIGACAO_CONSTITUIDA", classificacaoEconomica,
    efeitoNaDre: classificacaoEconomica === CLASSIFICACAO_ECONOMICA.CONFIRMADA ? "NA_LINHA_DA_CATEGORIA" : classificacaoEconomica === CLASSIFICACAO_ECONOMICA.PATRIMONIAL ? "FORA_DO_RESULTADO" : "FORA_ATE_CLASSIFICAR",
    competencia: o.competencia, competenciaHomologada: p.homologadas.has(o.competencia), dataEmissao: o.dataEmissao, vencimento: o.vencimento,
    parcela: o.parcela, recorrencia: o.recorrencia ?? null,
    valorOriginalCentavos: o.valorBaseCentavos, ajustesCentavos: o.ajustesCentavos, pagoCentavos: o.liquidadoCentavos, saldoCentavos: o.saldoCentavos,
    situacao, vencido: emAberto && o.vencimento < hoje, pendencias, documentos, pagamentos,
    ...dimensoesDoPagamento(o, pagamentos),
    origem: o.fonte?.sistema ?? "MANUAL",
    // 27/11: o que a pessoa disse ao relatar a conta (ex.: composição do empréstimo) e a forma de pagamento informada
    observacao: o.observacao ?? null, formaPagamentoInformada: o.formaPagamento ?? null,
  };
}

const naFaixa = (data, de, ate) => (!de || (data !== null && data >= de)) && (!ate || (data !== null && data <= ate));
const ordenarPorData = (campo) => (a, b) => {
  const [x, y] = [a[campo] ?? "9999-12-31", b[campo] ?? "9999-12-31"];
  return x < y ? -1 : x > y ? 1 : String(a.descricao ?? "").localeCompare(String(b.descricao ?? ""));
};
const resumirPor = (itens, chave, valor) => {
  const mapa = new Map();
  for (const i of itens) {
    const k = chave(i);
    const atual = mapa.get(k) ?? { quantidade: 0, saldoCentavos: 0 };
    mapa.set(k, { quantidade: atual.quantidade + 1, saldoCentavos: somar(atual.saldoCentavos, valor(i)) });
  }
  return Object.fromEntries(mapa);
};

/**
 * Contas a pagar. Os totais cobrem TODO o conjunto filtrado (não só a página). Título cancelado não entra em total.
 * @param {{competencia?, vencimentoDe?, vencimentoAte?, contraparteId?, categoria?, situacao?, pagina?, tamanho?}} filtro
 */
export function contasAPagar(d, hoje, filtro = {}) {
  const p = preparar(d);
  const todos = p.obrigacoes.map((o) => tituloAPagar(p, o, hoje));
  const itens = todos.filter((t) => (!filtro.competencia || t.competencia === filtro.competencia) && naFaixa(t.vencimento, filtro.vencimentoDe, filtro.vencimentoAte)
    && (!filtro.contraparteId || t.fornecedor?.id === filtro.contraparteId) && (!filtro.categoria || t.categoria?.codigo === filtro.categoria)
    && (!filtro.situacao || t.situacao === filtro.situacao)).sort(ordenarPorData("vencimento"));
  const vivos = itens.filter((t) => t.situacao !== SITUACAO_A_PAGAR.CANCELADO);
  const porFornecedor = [...agrupar(vivos, (t) => t.fornecedor?.id ?? "").values()].map((g) => ({
    fornecedor: g[0].fornecedor, quantidade: g.length, saldoCentavos: somarLista(g, (t) => t.saldoCentavos),
    vencidoCentavos: somarLista(g.filter((t) => t.vencido), (t) => t.saldoCentavos),
  })).sort((a, b) => b.saldoCentavos - a.saldoCentavos);
  return {
    dataBase: hoje, quantidade: itens.length,
    totais: {
      registros: vivos.length,
      originalCentavos: somarLista(vivos, (t) => t.valorOriginalCentavos), ajustesCentavos: somarLista(vivos, (t) => t.ajustesCentavos),
      pagoCentavos: somarLista(vivos, (t) => t.pagoCentavos), saldoCentavos: somarLista(vivos, (t) => t.saldoCentavos),
      vencidoCentavos: somarLista(vivos.filter((t) => t.vencido), (t) => t.saldoCentavos),
      semDocumento: vivos.filter((t) => t.pendencias.includes("SEM_DOCUMENTO")).length,
      porSituacao: resumirPor(itens, (t) => t.situacao, (t) => (t.situacao === SITUACAO_A_PAGAR.CANCELADO ? 0 : t.saldoCentavos)),
    },
    porFornecedor,
    filtros: {
      fornecedores: [...new Map(todos.filter((t) => t.fornecedor).map((t) => [t.fornecedor.id, t.fornecedor])).values()],
      categorias: [...new Map(todos.filter((t) => t.categoria).map((t) => [t.categoria.codigo, t.categoria])).values()],
    },
    ...paginar(itens, filtro.pagina, filtro.tamanho),
    recorrenciasSemRegistro: recorrencias(p, hoje, hoje).semRegistro,
  };
}

// ---------------------------------------------------------------------------------------------------- contas a receber

export function situacaoAReceber(r, hoje, { divergente = false, previsaoConfiavel = false } = {}) {
  if (r.situacao === SITUACAO_TITULO.CANCELADA) return SITUACAO_A_RECEBER.CANCELADO;
  if (r.saldoCentavos === 0) return SITUACAO_A_RECEBER.RECEBIDO;
  if (divergente) return SITUACAO_A_RECEBER.EM_DIVERGENCIA;
  if (r.dataPrevista && r.dataPrevista < hoje) return SITUACAO_A_RECEBER.ATRASADO;
  // Data de repasse de processadora NÃO se presume: sem previsão documentada, o título fica "sem previsão confiável".
  if (!previsaoConfiavel) return SITUACAO_A_RECEBER.SEM_PREVISAO_CONFIAVEL;
  return r.liquidadoCentavos > 0 ? SITUACAO_A_RECEBER.PARCIALMENTE_RECEBIDO : SITUACAO_A_RECEBER.A_RECEBER;
}

export function tituloAReceber(p, r, hoje) {
  const contraparte = r.contraparteId ? p.contrapartePorId.get(r.contraparteId) ?? null : null;
  const documentos = documentosDe(p, TIPO.RECEBIVEL, r);
  const previsaoConfiavel = Boolean(r.dataPrevista) && documentos.length > 0;
  const situacao = situacaoAReceber(r, hoje, { divergente: p.divergentes.has(`${TIPO.RECEBIVEL}:${r.id}`), previsaoConfiavel });
  const esperado = somar(r.valorBaseCentavos, r.ajustesCentavos);
  const recebimentos = pagamentosDoTitulo(p, r.id);
  const tipo = r.contraparteId ? TIPO_DE_RECEBIVEL.RECEBIMENTO_DIRETO : r.vendaId ? TIPO_DE_RECEBIVEL.RECEBIVEL_DE_OPERADORA : TIPO_DE_RECEBIVEL.REPASSE;
  const ultimo = recebimentos.length ? recebimentos[recebimentos.length - 1].data : null;
  return {
    id: r.id, tipo, origem: r.vendaId ? "VENDA" : "AVULSO", vendaId: r.vendaId ?? null,
    devedor: r.processador ? { tipo: "PROCESSADORA", nome: r.processador } : { tipo: contraparte?.tipo ?? "OUTRO", nome: contraparte?.nome ?? null },
    canal: r.canal ?? null, forma: r.forma ?? null, descricao: r.descricao ?? null, competencia: r.competencia, competenciaHomologada: p.homologadas.has(r.competencia),
    valorOriginalCentavos: r.brutoCentavos, deducoesCentavos: subtrair(r.brutoCentavos, esperado), esperadoCentavos: esperado,
    recebidoCentavos: r.liquidadoCentavos, saldoCentavos: r.saldoCentavos,
    vencimentoPrevisto: r.dataPrevista ?? null, previsaoConfiavel, dataDeLiquidacao: r.saldoCentavos === 0 && r.situacao !== SITUACAO_TITULO.CANCELADA ? ultimo : null,
    situacao, documentos, recebimentos,
    composicao: {
      brutoCentavos: r.brutoCentavos,
      retencoes: (r.retencoes ?? []).map((x) => ({ categoria: x.categoria, nome: p.categoriaPorCodigo.get(x.categoria)?.nome ?? x.categoria, valorCentavos: x.valorCentavos, descricao: x.descricao ?? null })),
      ajustes: (p.ajustesPorAlvo.get(r.id) ?? []).map((a) => {
        const l = a.lancamentoId ? p.lancamentoPorId.get(a.lancamentoId) : null;
        return { motivo: a.motivo, valorCentavos: a.valorCentavos, categoria: l?.categoria ?? null, nome: l ? p.categoriaPorCodigo.get(l.categoria)?.nome ?? l.categoria : null };
      }),
      esperadoCentavos: esperado,
    },
  };
}

const emAbertoAReceber = (t) => t.situacao !== SITUACAO_A_RECEBER.CANCELADO && t.saldoCentavos > 0;
/** Só entra no fluxo PREVISTO o que tem previsão documentada e ainda não venceu. */
const previsivel = (t) => emAbertoAReceber(t) && [SITUACAO_A_RECEBER.A_RECEBER, SITUACAO_A_RECEBER.PARCIALMENTE_RECEBIDO].includes(t.situacao);

/** @param {{competencia?, previstoDe?, previstoAte?, processador?, canal?, tipo?, situacao?, pagina?, tamanho?}} filtro */
export function contasAReceber(d, hoje, filtro = {}) {
  const p = preparar(d);
  const todos = p.recebiveis.map((r) => tituloAReceber(p, r, hoje));
  const itens = todos.filter((t) => (!filtro.competencia || t.competencia === filtro.competencia) && naFaixa(t.vencimentoPrevisto, filtro.previstoDe, filtro.previstoAte)
    && (!filtro.processador || (t.devedor.tipo === "PROCESSADORA" && t.devedor.nome === filtro.processador)) && (!filtro.canal || t.canal === filtro.canal)
    && (!filtro.tipo || t.tipo === filtro.tipo) && (!filtro.situacao || t.situacao === filtro.situacao)).sort(ordenarPorData("vencimentoPrevisto"));
  const vivos = itens.filter((t) => t.situacao !== SITUACAO_A_RECEBER.CANCELADO);
  const saldoDe = (sit) => somarLista(vivos.filter((t) => t.situacao === sit), (t) => t.saldoCentavos);
  const porDevedor = [...agrupar(vivos, (t) => `${t.devedor.tipo}|${t.devedor.nome}`).values()].map((g) => ({
    devedor: g[0].devedor, quantidade: g.length, saldoCentavos: somarLista(g, (t) => t.saldoCentavos),
  })).sort((a, b) => b.saldoCentavos - a.saldoCentavos);
  return {
    dataBase: hoje, quantidade: itens.length,
    totais: {
      registros: vivos.length,
      originalCentavos: somarLista(vivos, (t) => t.valorOriginalCentavos), deducoesCentavos: somarLista(vivos, (t) => t.deducoesCentavos),
      esperadoCentavos: somarLista(vivos, (t) => t.esperadoCentavos), recebidoCentavos: somarLista(vivos, (t) => t.recebidoCentavos),
      saldoCentavos: somarLista(vivos, (t) => t.saldoCentavos), atrasadoCentavos: saldoDe(SITUACAO_A_RECEBER.ATRASADO),
      semPrevisaoCentavos: saldoDe(SITUACAO_A_RECEBER.SEM_PREVISAO_CONFIAVEL), emDivergenciaCentavos: saldoDe(SITUACAO_A_RECEBER.EM_DIVERGENCIA),
      comPrevisaoCentavos: somarLista(vivos.filter(previsivel), (t) => t.saldoCentavos),
      porSituacao: resumirPor(itens, (t) => t.situacao, (t) => (t.situacao === SITUACAO_A_RECEBER.CANCELADO ? 0 : t.saldoCentavos)),
      porTipo: resumirPor(vivos, (t) => t.tipo, (t) => t.saldoCentavos),
    },
    porDevedor,
    ...paginar(itens, filtro.pagina, filtro.tamanho),
  };
}


/**
 * 09C — POSIÇÃO DE CONTAS A RECEBER NO FIM DA COMPETÊNCIA `competencia` (dia D = último dia do mês).
 * Mesma conservação dos títulos (saldo = base − Σ(liquidação − estornado) + Σ ajustes), mas só com o que existia em D:
 *   - entram os recebíveis da competência ou anteriores; CANCELADOS ficam fora (cancelamento é correção e retroage —
 *     e só é permitido com a competência aberta);
 *   - esperado = base + ajustes de competência ≤ C;
 *   - recebido até D = liquidações com data ≤ D, menos os estornos delas com data ≤ D (pagamento de outubro não muda a
 *     posição de 30/09; estorno de outubro também não);
 *   - em aberto em D = saldo na data > 0. Para D no presente, o saldo na data é o saldo gravado do título (testado).
 */
export function posicaoAReceberEm(d, competencia, filtro = {}) {
  const p = preparar(d);
  const D = ultimoDiaDe(competencia);
  const estornosPorLiquidacao = agrupar((d.estornos ?? []).filter((e) => e.alvoTipo === "LIQUIDACAO"), (e) => e.alvoId);
  const liquidacoesPorRecebivel = agrupar((d.liquidacoes ?? []).filter((q) => q.alvoTipo === "RECEBIVEL"), (q) => q.alvoId);
  const itens = [];
  for (const r of p.recebiveis) {
    if (r.situacao === SITUACAO_TITULO.CANCELADA || r.competencia > competencia) continue;
    const ajustes = (p.ajustesPorAlvo.get(r.id) ?? []).filter((a) => (a.competencia ?? r.competencia) <= competencia);
    const esperado = somar(r.valorBaseCentavos, ...ajustes.map((a) => a.valorCentavos));
    let recebido = 0;
    let recebidoDepois = 0;
    for (const q of liquidacoesPorRecebivel.get(r.id) ?? []) {
      if (q.dataEfetiva <= D) {
        const estornadoAteD = somarLista((estornosPorLiquidacao.get(q.id) ?? []).filter((e) => e.dataEfetiva <= D), (e) => e.valorCentavos);
        recebido = somar(recebido, subtrair(q.valorCentavos, estornadoAteD));
      } else {
        recebidoDepois = somar(recebidoDepois, subtrair(q.valorCentavos, q.estornadoCentavos ?? 0));
      }
    }
    const saldo = subtrair(esperado, recebido);
    if (saldo <= 0) continue;
    const contraparte = r.contraparteId ? p.contrapartePorId.get(r.contraparteId) ?? null : null;
    itens.push({
      id: r.id, competencia: r.competencia, devedor: r.processador ? { tipo: "PROCESSADORA", nome: r.processador } : { tipo: contraparte?.tipo ?? "OUTRO", nome: contraparte?.nome ?? null },
      canal: r.canal ?? null, descricao: r.descricao ?? null, vencimentoPrevisto: r.dataPrevista ?? null,
      esperadoNaDataCentavos: esperado, recebidoAteADataCentavos: recebido, saldoNaDataCentavos: saldo, recebidoDepoisCentavos: recebidoDepois,
      vencidoNaData: Boolean(r.dataPrevista && r.dataPrevista < D), semPrevisao: !r.dataPrevista, saldoAtualCentavos: r.saldoCentavos,
    });
  }
  itens.sort((a, b) => String(a.vencimentoPrevisto ?? "9999").localeCompare(String(b.vencimentoPrevisto ?? "9999")) || String(a.id).localeCompare(String(b.id)));
  return {
    competencia, data: D, quantidade: itens.length,
    totais: {
      saldoNaDataCentavos: somarLista(itens, (t) => t.saldoNaDataCentavos), vencidoNaDataCentavos: somarLista(itens.filter((t) => t.vencidoNaData), (t) => t.saldoNaDataCentavos),
      semPrevisaoCentavos: somarLista(itens.filter((t) => t.semPrevisao), (t) => t.saldoNaDataCentavos), recebidoDepoisCentavos: somarLista(itens, (t) => t.recebidoDepoisCentavos),
    },
    ...paginar(itens, filtro.pagina, filtro.tamanho),
  };
}

// ------------------------------------------------------------------------------------------------------ caixa e bancos

/**
 * Ponto do tempo a partir do qual uma âncora vale: o INÍCIO do dia `inicioEfetivo`. Saldo de fim do dia D equivale ao
 * saldo de início de D+1 — por isso os movimentos de D não entram de novo.
 */
export const inicioEfetivoDe = (s) => (s.referencia === REFERENCIA_SALDO.FIM_DO_DIA ? somarDias(s.data, 1) : s.data);
const ancorasDa = (p, contaId) => (p.saldos ?? []).filter((s) => s.contaId === contaId)
  .map((s) => ({ ...s, referencia: s.referencia ?? REFERENCIA_SALDO.INICIO_DO_DIA, inicioEfetivo: inicioEfetivoDe(s) }))
  .sort((a, b) => (a.inicioEfetivo < b.inicioEfetivo ? -1 : a.inicioEfetivo > b.inicioEfetivo ? 1 : a.referencia === REFERENCIA_SALDO.FIM_DO_DIA ? -1 : 1));
const movimentosDa = (p, contaId) => p.movimentacoes.filter((m) => m.contaId === contaId && valida(m));
/** Movimentos a partir do início do dia `de` (exclusive do que a âncora já contém) até a véspera de `ate`. */
const movimentosEntre = (p, contaId, de, ate) => movimentosDa(p, contaId).filter((m) => m.dataEfetiva >= de && m.dataEfetiva < ate);

/** Saldo no INÍCIO do dia: âncora mais recente até a data + movimentações POSTERIORES à referência dela até a véspera. Sem âncora → null. */
export function saldoNoInicioDe(p, contaId, data) {
  const ancora = ancorasDa(p, contaId).filter((s) => s.inicioEfetivo <= data).pop();
  if (!ancora) return null;
  return somar(ancora.valorCentavos, ...movimentosEntre(p, contaId, ancora.inicioEfetivo, data).map(sinal));
}
/** Saldo no FIM do dia. */
export const saldoNoFimDe = (p, contaId, data) => saldoNoInicioDe(p, contaId, somarDias(data, 1));

/** Explica uma movimentação pelo que ela LIQUIDA ou representa — nunca pelo sinal do valor. */
export function movimentoLegivel(p, m) {
  const conta = p.contaPorId.get(m.contaId);
  const pendencias = [];
  let vinculo = { tipo: VINCULO_MOVIMENTO.SEM_VINCULO };
  let titulo = m.sentido === SENTIDO.ENTRADA ? "Entrada sem vínculo identificado" : "Saída sem vínculo identificado";
  const liquidacoes = p.liquidacoesPorMov.get(m.id) ?? [];
  if (m.transferenciaId) {
    const t = p.transferenciaPorId.get(m.transferenciaId);
    const outra = t ? p.contaPorId.get(m.sentido === SENTIDO.SAIDA ? t.contaDestinoId : t.contaOrigemId) : null;
    vinculo = { tipo: VINCULO_MOVIMENTO.TRANSFERENCIA_INTERNA, transferenciaId: m.transferenciaId, contraConta: outra?.nome ?? null };
    titulo = m.sentido === SENTIDO.SAIDA ? `Transferência para ${outra?.nome ?? "outra conta"}` : `Transferência de ${outra?.nome ?? "outra conta"}`;
  } else if (m.pagamentoId) {
    const pag = p.pagamentoPorId.get(m.pagamentoId);
    const devolucao = m.natureza === NM.DEVOLUCAO;
    vinculo = { tipo: devolucao ? VINCULO_MOVIMENTO.DEVOLUCAO_A_CLIENTE : VINCULO_MOVIMENTO.RECEBIMENTO_DIRETO_DE_VENDA, vendaId: pag?.vendaId ?? null, forma: pag?.forma ?? null };
    titulo = devolucao ? "Devolução a cliente" : `Venda recebida ${FORMAS[pag?.forma] ?? ""}`.trim();
  } else if (liquidacoes.length) {
    const saida = m.sentido === SENTIDO.SAIDA;
    const titulos = liquidacoes.map((q) => {
      const alvo = saida ? p.obrigacaoPorId.get(q.alvoId) : p.recebivelPorId.get(q.alvoId);
      const parte = saida ? p.contrapartePorId.get(alvo?.contraparteId)?.nome : alvo?.processador ?? p.contrapartePorId.get(alvo?.contraparteId)?.nome;
      return { tipo: q.alvoTipo, id: q.alvoId, valorCentavos: validoDaLiquidacao(q), parte: parte ?? null, descricao: alvo?.descricao ?? null };
    });
    vinculo = { tipo: saida ? VINCULO_MOVIMENTO.PAGAMENTO_DE_OBRIGACAO : VINCULO_MOVIMENTO.RECEBIMENTO_DE_TITULO, titulos, agrupado: titulos.length > 1 };
    const um = titulos[0];
    if (saida) titulo = titulos.length > 1 ? `Pagamento de ${titulos.length} contas` : `Pagamento — ${[um.parte, um.descricao].filter(Boolean).join(" · ") || "conta a pagar"}`;
    else titulo = titulos.length > 1 ? `Repasse agrupado — ${titulos.length} títulos` : `Recebimento — ${um.parte ?? "título a receber"}`;
    if (m.alocadoCentavos < m.valorCentavos) pendencias.push("PARCIALMENTE_VINCULADO");
  } else if (valida(m)) {
    pendencias.push("SEM_VINCULO");
  }
  // Separação (auditoria A.2): a categoria SUGERIDA pelo histórico do banco nunca é classificação econômica. Sem vínculo,
  // a saída/entrada fica PENDENTE DE CLASSIFICAÇÃO — e fora da DRE — mesmo que a sugestão diga "tarifa" ou "boleto".
  const classificacaoEconomica = vinculo.tipo === VINCULO_MOVIMENTO.TRANSFERENCIA_INTERNA ? CLASSIFICACAO_ECONOMICA.NAO_SE_APLICA
    : vinculo.tipo === VINCULO_MOVIMENTO.SEM_VINCULO ? CLASSIFICACAO_ECONOMICA.PENDENTE_DE_CLASSIFICACAO : CLASSIFICACAO_ECONOMICA.CONFIRMADA;
  return {
    id: m.id, data: m.dataEfetiva, conta: conta ? { id: conta.id, nome: conta.nome, tipo: conta.tipo } : null, sentido: m.sentido, valorCentavos: m.valorCentavos,
    natureza: m.natureza, titulo, descricaoOriginal: m.descricao ?? null, vinculo, categoriaBancariaSugerida: p.categoriaBancariaPorMov?.get(m.id) ?? null, classificacaoEconomica, naoVinculadoCentavos: liquidacoes.length ? subtrair(m.valorCentavos, m.alocadoCentavos) : null,
    situacao: m.situacao, situacaoConciliacao: conciliacaoEfetiva(m), documentos: documentosDe(p, TIPO.MOVIMENTACAO, m), fonte: m.fonte?.sistema ?? null, pendencias,
  };
}

/** Saldo teórico de uma sessão de caixa físico até `ate`: abertura contada + movimentações válidas da conta no intervalo. */
export function teoricoDaSessao(movimentacoes, sessao, ate) {
  const doPeriodo = movimentacoes.filter((m) => m.contaId === sessao.contaId && valida(m) && m.dataEfetiva >= sessao.dataAbertura && m.dataEfetiva <= ate);
  const entradasCentavos = somarLista(doPeriodo.filter((m) => m.sentido === SENTIDO.ENTRADA), (m) => m.valorCentavos);
  const saidasCentavos = somarLista(doPeriodo.filter((m) => m.sentido === SENTIDO.SAIDA), (m) => m.valorCentavos);
  return { entradasCentavos, saidasCentavos, teoricoCentavos: subtrair(somar(sessao.saldoAberturaCentavos, entradasCentavos), saidasCentavos) };
}

function sessaoLegivel(p, s, hoje) {
  const fechada = s.situacao === SITUACAO_SESSAO_CAIXA.FECHADA;
  const atual = teoricoDaSessao(p.movimentacoes, s, fechada ? s.dataFechamento : hoje);
  return {
    id: s.id, conta: p.contaPorId.get(s.contaId)?.nome ?? null, situacao: s.situacao, dataAbertura: s.dataAbertura, saldoAberturaCentavos: s.saldoAberturaCentavos,
    operacoes: s.operacoes ?? [], entradasCentavos: atual.entradasCentavos, saidasCentavos: atual.saidasCentavos, teoricoAtualCentavos: atual.teoricoCentavos,
    dataFechamento: s.dataFechamento ?? null, teoricoCentavos: s.teoricoCentavos ?? null, contadoCentavos: s.contadoCentavos ?? null,
    diferencaCentavos: s.diferencaCentavos ?? null, justificativa: s.justificativa ?? null,
    // Movimentação lançada depois do fechamento com data dentro da sessão: o teórico mudou; a contagem registrada NÃO é reescrita.
    alteradaAposFechamento: fechada && atual.teoricoCentavos !== s.teoricoCentavos,
  };
}

function contaNoPeriodo(p, conta, inicio, fim, hoje) {
  const movs = movimentosDa(p, conta.id).filter((m) => m.dataEfetiva >= inicio && m.dataEfetiva <= fim);
  const soma = (filtro) => somarLista(movs.filter(filtro), (m) => m.valorCentavos);
  const entradasCentavos = soma((m) => m.sentido === SENTIDO.ENTRADA);
  const saidasCentavos = soma((m) => m.sentido === SENTIDO.SAIDA);
  const saldoInicialCentavos = saldoNoInicioDe(p, conta.id, inicio);
  const ancoras = ancorasDa(p, conta.id);
  // O saldo final sempre parte do saldo informado mais recente até `fim` (se houver um dentro do período, ele prevalece).
  const saldoFinalCentavos = saldoNoFimDe(p, conta.id, fim);
  // Conciliação de saldos: cada saldo informado depois do primeiro é comparado com o calculado a partir do anterior, só com
  // os movimentos POSTERIORES à referência do anterior. Lançamento atrasado (registrado depois, com data no intervalo)
  // entra uma única vez — no intervalo da sua data. A diferença NÃO é ajustada: vira divergência visível.
  const conferenciasDeSaldo = ancoras.slice(1).map((a, i) => {
    const anterior = ancoras[i];
    const movs = movimentosEntre(p, conta.id, anterior.inicioEfetivo, a.inicioEfetivo);
    const calculado = somar(anterior.valorCentavos, ...movs.map(sinal));
    const diferenca = subtrair(a.valorCentavos, calculado);
    return {
      data: a.data, referencia: a.referencia, anterior: { data: anterior.data, referencia: anterior.referencia, valorCentavos: anterior.valorCentavos },
      informadoCentavos: a.valorCentavos, calculadoCentavos: calculado, diferencaCentavos: diferenca, movimentosConsiderados: quantos(movs),
      situacao: diferenca === 0 ? "CONFERE" : "DIVERGENTE", documentos: documentosDe(p, TIPO.SALDO_CONTA, a),
    };
  });
  // Movimentos com data ANTERIOR à primeira referência já estão dentro do saldo informado: nunca são somados a ele.
  const anterioresAReferencia = ancoras.length ? quantos(movimentosDa(p, conta.id).filter((m) => m.dataEfetiva < ancoras[0].inicioEfetivo)) : 0;
  const semVinculo = movs.filter((m) => !m.transferenciaId && !m.pagamentoId && !(p.liquidacoesPorMov.get(m.id) ?? []).length);
  const conc = (sit) => movs.filter((m) => conciliacaoEfetiva(m) === sit).length;
  const ultima = ancoras.filter((a) => a.inicioEfetivo <= somarDias(fim, 1)).pop() ?? null;
  return {
    id: conta.id, nome: conta.nome, tipo: conta.tipo, instituicao: conta.instituicao ?? null, ativa: conta.ativa,
    saldoInicialCentavos, entradasCentavos, saidasCentavos, saldoFinalCentavos,
    transferenciasRecebidasCentavos: soma((m) => m.transferenciaId && m.sentido === SENTIDO.ENTRADA),
    transferenciasEnviadasCentavos: soma((m) => m.transferenciaId && m.sentido === SENTIDO.SAIDA),
    situacaoDoSaldo: saldoFinalCentavos === null ? SITUACAO_SALDO.DESCONHECIDO : SITUACAO_SALDO.CALCULADO,
    saldoInformado: ultima ? { data: ultima.data, referencia: ultima.referencia, valorCentavos: ultima.valorCentavos, observacao: ultima.observacao ?? null, documentos: documentosDe(p, TIPO.SALDO_CONTA, ultima) } : null,
    conferenciasDeSaldo, saldosDivergentes: conferenciasDeSaldo.filter((x) => x.situacao === "DIVERGENTE").length, movimentosAnterioresAReferencia: anterioresAReferencia, movimentacoes: movs.length,
    // Diferenças de contagem das sessões FECHADAS no período: só informadas; o saldo da conta não é ajustado por elas.
    diferencasDeCaixaNaoAjustadasCentavos: conta.tipo === TIPO_CONTA.CAIXA_FISICO
      ? somarLista((p.sessoes ?? []).filter((s) => s.contaId === conta.id && s.dataFechamento && s.dataFechamento >= inicio && s.dataFechamento <= fim), (s) => s.diferencaCentavos ?? 0)
      : null,
    conciliacao: { conciliadas: conc(SITUACAO_CONCILIACAO.CONCILIADA), parciais: conc(SITUACAO_CONCILIACAO.PARCIAL), naoConciliadas: conc(SITUACAO_CONCILIACAO.NAO_CONCILIADA) },
    pendencias: { semVinculo: semVinculo.length, semVinculoCentavos: somarLista(semVinculo, (m) => m.valorCentavos) },
    // Sessão ABERTA do caixa, qualquer que seja o período da tela (abrir/operar/fechar não pode depender do filtro de datas).
    sessaoAberta: conta.tipo === TIPO_CONTA.CAIXA_FISICO ? ((p.sessoes ?? []).filter((s) => s.contaId === conta.id && s.situacao === SITUACAO_SESSAO_CAIXA.ABERTA).map((s) => ({ id: s.id, dataAbertura: s.dataAbertura }))[0] ?? null) : null,
    sessoesDeCaixa: conta.tipo === TIPO_CONTA.CAIXA_FISICO
      ? (p.sessoes ?? []).filter((s) => s.contaId === conta.id && s.dataAbertura <= fim && (s.dataFechamento ?? hoje) >= inicio).sort((a, b) => (a.dataAbertura < b.dataAbertura ? 1 : -1)).map((s) => sessaoLegivel(p, s, hoje))
      : [],
  };
}

/** @param {{inicio:string, fim:string, contaId?:string, pagina?, tamanho?}} filtro período já validado */
export function caixaEBancos(d, hoje, filtro) {
  const p = preparar(d);
  const contas = p.contas.filter((c) => !filtro.contaId || c.id === filtro.contaId).map((c) => contaNoPeriodo(p, c, filtro.inicio, filtro.fim, hoje));
  const ids = new Set(contas.map((c) => c.id));
  const doPeriodo = p.movimentacoes.filter((m) => ids.has(m.contaId) && m.dataEfetiva >= filtro.inicio && m.dataEfetiva <= filtro.fim);
  // No consolidado de TODAS as contas, as duas pernas de cada transferência interna se anulam: não são entrada nem saída.
  const consolidaTudo = !filtro.contaId;
  const externas = doPeriodo.filter((m) => valida(m) && !(consolidaTudo && m.transferenciaId));
  const movimentos = doPeriodo.map((m) => movimentoLegivel(p, m)).sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
  const tipoDe = (tipo) => contas.filter((c) => c.tipo === tipo && c.ativa);
  const saldoDe = (lista) => (lista.length ? somarOuNulo(lista.map((c) => c.saldoFinalCentavos)) : null);
  return {
    dataBase: hoje, periodo: { inicio: filtro.inicio, fim: filtro.fim }, contas,
    consolidado: {
      saldoInicialCentavos: contas.length ? somarOuNulo(contas.map((c) => c.saldoInicialCentavos)) : null,
      entradasCentavos: somarLista(externas.filter((m) => m.sentido === SENTIDO.ENTRADA), (m) => m.valorCentavos),
      saidasCentavos: somarLista(externas.filter((m) => m.sentido === SENTIDO.SAIDA), (m) => m.valorCentavos),
      transferenciasInternasCentavos: consolidaTudo ? somarLista(doPeriodo.filter((m) => valida(m) && m.transferenciaId && m.sentido === SENTIDO.SAIDA), (m) => m.valorCentavos) : null,
      saldoFinalCentavos: contas.length ? somarOuNulo(contas.map((c) => c.saldoFinalCentavos)) : null,
      saldoBancarioCentavos: saldoDe(tipoDe(TIPO_CONTA.BANCARIA)), saldoCaixaFisicoCentavos: saldoDe(tipoDe(TIPO_CONTA.CAIXA_FISICO)),
      contasSemSaldoInformado: contas.filter((c) => c.situacaoDoSaldo === SITUACAO_SALDO.DESCONHECIDO).map((c) => c.nome),
    },
    pendencias: { saldosDivergentes: somarLista(contas, (c) => c.saldosDivergentes), semVinculo: movimentos.filter((m) => m.pendencias.includes("SEM_VINCULO")).length, parcialmenteVinculadas: movimentos.filter((m) => m.pendencias.includes("PARCIALMENTE_VINCULADO")).length },
    ...(() => { const pg = paginar(movimentos, filtro.pagina, filtro.tamanho); return { movimentos: pg.itens, paginacao: pg.paginacao }; })(),
  };
}

// --------------------------------------------------------------------------------------------------------- recorrências

/**
 * Ocorrências FUTURAS de obrigações recorrentes (mensais), até `ate`. É projeção de consulta: nada é gravado.
 * Sem duplicidade: o mês que já tem a obrigação real da série não recebe projeção. Mês passado sem obrigação vira alerta
 * (`semRegistro`), nunca valor previsto.
 */
export function recorrencias(p, hoje, ate) {
  // Série = fornecedor + categoria + dia do mês (a descrição NÃO entra: "Aluguel" e "Aluguel de dezembro" são a mesma
  // série — antes da 06B elas viravam duas séries e a previsão do mês seguinte saía em dobro).
  const categoriaDe = (o) => p.lancamentoPorId.get(o.lancamentoId)?.categoria ?? "";
  const series = agrupar(p.obrigacoes.filter((o) => o.recorrencia && o.situacao !== SITUACAO_TITULO.CANCELADA && (o.parcela?.total ?? 1) === 1),
    (o) => `${o.contraparteId}|${categoriaDe(o)}|${o.recorrencia.diaDoMes}`);
  // Mês já CONSTITUÍDO = existe qualquer obrigação (recorrente ou não, inclusive cancelada) do mesmo fornecedor e categoria
  // vencendo nele. Previsão e obrigação constituída nunca convivem no mesmo mês (pode subestimar, nunca duplica).
  const constituidos = new Set(p.obrigacoes.map((o) => `${o.contraparteId}|${categoriaDe(o)}|${competenciaDe(o.vencimento)}`));
  const previstas = [];
  const semRegistro = [];
  for (const [chave, lista] of series) {
    const ultima = lista.reduce((a, o) => (o.vencimento > a.vencimento ? o : a));
    const meses = { has: (mes) => constituidos.has(`${ultima.contraparteId}|${categoriaDe(ultima)}|${mes}`) };
    const fornecedor = p.contrapartePorId.get(ultima.contraparteId)?.nome ?? null;
    let mes = competenciaDe(ultima.vencimento);
    for (let i = 0; i < 36; i += 1) {
      mes = competenciaDe(somarMeses(primeiroDiaDe(mes), 1));
      const data = diaNoMes(mes, ultima.recorrencia.diaDoMes);
      if (data > ate && data > hoje) break;
      if (meses.has(mes)) continue;
      // ESTIMATIVA: valor = último valor da série. Não é obrigação, não tem documento e não entra em contas a pagar.
      const item = {
        serie: chave, data, valorCentavos: ultima.valorBaseCentavos, fornecedor, descricao: ultima.descricao, baseadoNoVencimento: ultima.vencimento,
        estimado: true, registro: "PREVISAO_RECORRENTE", base: "ULTIMO_VALOR_DA_SERIE", obrigacaoConstituida: false,
      };
      if (data <= hoje) semRegistro.push(item);
      else previstas.push(item);
    }
  }
  const porData = (a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0);
  return { previstas: previstas.sort(porData), semRegistro: semRegistro.sort(porData) };
}

// ------------------------------------------------------------------------------------------------------ fluxo de caixa

const NATUREZA_DO_VINCULO = Object.freeze({
  [VINCULO_MOVIMENTO.RECEBIMENTO_DIRETO_DE_VENDA]: "RECEBIMENTO_DIRETO_DE_VENDA", [VINCULO_MOVIMENTO.RECEBIMENTO_DE_TITULO]: "RECEBIMENTO_DE_TITULO",
  [VINCULO_MOVIMENTO.PAGAMENTO_DE_OBRIGACAO]: "PAGAMENTO_DE_OBRIGACAO", [VINCULO_MOVIMENTO.DEVOLUCAO_A_CLIENTE]: "DEVOLUCAO_A_CLIENTE", [VINCULO_MOVIMENTO.SEM_VINCULO]: "SEM_VINCULO",
});

function periodos(inicio, fim, granularidade) {
  const chaveDe = (data) => (granularidade === GRANULARIDADE.DIA ? data : granularidade === GRANULARIDADE.SEMANA ? inicioDaSemana(data) : primeiroDiaDe(competenciaDe(data)));
  const lista = [];
  for (let dia = inicio; dia <= fim; dia = somarDias(dia, 1)) {
    const chave = chaveDe(dia);
    const ultimo = lista[lista.length - 1];
    if (ultimo && ultimo.chave === chave) ultimo.fim = dia;
    else lista.push({ chave, inicio: dia, fim: dia });
  }
  return lista;
}

/**
 * Fluxo de caixa de TODAS as contas da unidade no período.
 *   realizado → movimentações válidas até hoje, sem transferências internas;
 *   previsto  → saldo em aberto de títulos com data: contas a pagar (vencimento), recebíveis com previsão DOCUMENTADA e
 *               recorrências; contas vencidas em aberto entram na data de hoje (ainda precisam ser pagas);
 *   projeção  → saldo disponível de hoje + previsto. Como o previsto só usa SALDO EM ABERTO, nada do realizado é contado
 *               de novo. Recebível sem previsão confiável fica FORA e torna a projeção parcial.
 * @param {{inicio:string, fim:string, granularidade:string}} filtro
 */
export function fluxoDeCaixa(d, hoje, filtro) {
  const p = preparar(d);
  const { inicio, fim, granularidade } = filtro;
  const fimRealizado = fim < hoje ? fim : hoje;
  const realizados = p.movimentacoes.filter((m) => valida(m) && !m.transferenciaId && m.dataEfetiva >= inicio && m.dataEfetiva <= fimRealizado).map((m) => {
    const v = movimentoLegivel(p, m);
    return { data: m.dataEfetiva, sentido: m.sentido, valorCentavos: m.valorCentavos, natureza: NATUREZA_DO_VINCULO[v.vinculo.tipo], titulo: v.titulo, movimentacaoId: m.id };
  });
  const previstos = [];
  if (fim >= hoje) {
    const desde = inicio > hoje ? inicio : hoje;
    for (const o of p.obrigacoes) {
      if (o.situacao === SITUACAO_TITULO.CANCELADA || o.saldoCentavos <= 0) continue;
      const vencida = o.vencimento < hoje;
      const data = vencida ? hoje : o.vencimento;
      if (data < desde || data > fim) continue;
      previstos.push({ data, sentido: SENTIDO.SAIDA, valorCentavos: o.saldoCentavos, natureza: vencida ? "CONTA_VENCIDA_EM_ABERTO" : "CONTA_A_PAGAR", titulo: [p.contrapartePorId.get(o.contraparteId)?.nome, o.descricao].filter(Boolean).join(" · "), vencimentoOriginal: o.vencimento, registroTipo: TIPO.OBRIGACAO, registroId: o.id, estimado: false });
    }
    for (const r of recorrencias(p, hoje, fim).previstas) {
      if (r.data < desde) continue;
      previstos.push({ data: r.data, sentido: SENTIDO.SAIDA, valorCentavos: r.valorCentavos, natureza: "RECORRENCIA_PREVISTA", titulo: [r.fornecedor, r.descricao].filter(Boolean).join(" · "), registroTipo: null, registroId: null, estimado: true });
    }
  }
  const recebiveis = p.recebiveis.map((r) => tituloAReceber(p, r, hoje)).filter(emAbertoAReceber);
  for (const t of recebiveis.filter(previsivel)) {
    if (fim < hoje || t.vencimentoPrevisto < (inicio > hoje ? inicio : hoje) || t.vencimentoPrevisto > fim) continue;
    previstos.push({ data: t.vencimentoPrevisto, sentido: SENTIDO.ENTRADA, valorCentavos: t.saldoCentavos, natureza: t.tipo, titulo: `A receber — ${t.devedor.nome ?? "devedor"}`, registroTipo: TIPO.RECEBIVEL, registroId: t.id, estimado: false });
  }
  const semPrevisao = recebiveis.filter((t) => !previsivel(t)).map((t) => ({ registroId: t.id, devedor: t.devedor.nome, situacao: t.situacao, saldoCentavos: t.saldoCentavos, vencimentoPrevisto: t.vencimentoPrevisto }));
  previstos.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));

  const ativas = p.contas.filter((c) => c.ativa);
  const saldoConsolidado = (fn) => (ativas.length ? somarOuNulo(ativas.map((c) => fn(c.id))) : null);
  const saldoInicialCentavos = saldoConsolidado((id) => saldoNoInicioDe(p, id, inicio));
  const saldoAtualCentavos = saldoConsolidado((id) => saldoNoFimDe(p, id, hoje));
  const total = (lista, sentido) => somarLista(lista.filter((i) => i.sentido === sentido), (i) => i.valorCentavos);
  const porNatureza = (lista) => Object.fromEntries([...agrupar(lista, (i) => i.natureza)].map(([k, g]) => [k, somarLista(g, (i) => (i.sentido === SENTIDO.ENTRADA ? i.valorCentavos : -i.valorCentavos))]));

  let acumuladoRealizado = 0;
  let acumuladoPrevisto = 0;
  const serie = periodos(inicio, fim, granularidade).map((b) => {
    const doRealizado = realizados.filter((i) => i.data >= b.inicio && i.data <= b.fim);
    const doPrevisto = previstos.filter((i) => i.data >= b.inicio && i.data <= b.fim);
    const r = { entradasCentavos: total(doRealizado, SENTIDO.ENTRADA), saidasCentavos: total(doRealizado, SENTIDO.SAIDA) };
    const v = { entradasCentavos: total(doPrevisto, SENTIDO.ENTRADA), saidasCentavos: total(doPrevisto, SENTIDO.SAIDA) };
    acumuladoRealizado = somar(acumuladoRealizado, subtrair(r.entradasCentavos, r.saidasCentavos));
    acumuladoPrevisto = somar(acumuladoPrevisto, subtrair(v.entradasCentavos, v.saidasCentavos));
    const jaComecou = b.inicio <= hoje;
    return {
      ...b, tipo: b.fim < hoje ? "REALIZADO" : b.inicio > hoje ? "PREVISTO" : "ATUAL", realizado: r, previsto: v,
      // Saldo JÁ disponível (só realizado) — existe até hoje (no período atual, é o saldo de hoje); depois disso o que há é
      // projeção, mostrada em campo separado.
      saldoRealizadoCentavos: jaComecou && saldoInicialCentavos !== null ? somar(saldoInicialCentavos, acumuladoRealizado) : null,
      saldoProjetadoCentavos: b.fim >= hoje && saldoAtualCentavos !== null ? somar(saldoAtualCentavos, acumuladoPrevisto) : null,
    };
  });

  const motivos = [];
  if (saldoAtualCentavos === null) motivos.push("SALDO_DISPONIVEL_DESCONHECIDO");
  if (semPrevisao.length) motivos.push("RECEBIVEIS_SEM_PREVISAO_CONFIAVEL");
  if (previstos.some((i) => i.estimado)) motivos.push("INCLUI_RECORRENCIAS_ESTIMADAS");
  const variacaoPrevista = subtrair(total(previstos, SENTIDO.ENTRADA), total(previstos, SENTIDO.SAIDA));
  return {
    dataBase: hoje, periodo: { inicio, fim, granularidade }, saldoInicialCentavos, saldoAtualCentavos,
    realizado: {
      ate: fimRealizado, entradasCentavos: total(realizados, SENTIDO.ENTRADA), saidasCentavos: total(realizados, SENTIDO.SAIDA),
      variacaoCentavos: subtrair(total(realizados, SENTIDO.ENTRADA), total(realizados, SENTIDO.SAIDA)), porNatureza: porNatureza(realizados),
      saldoFinalCentavos: saldoInicialCentavos !== null && inicio <= hoje ? somar(saldoInicialCentavos, subtrair(total(realizados, SENTIDO.ENTRADA), total(realizados, SENTIDO.SAIDA))) : null,
      transferenciasInternasAnuladasCentavos: somarLista(p.movimentacoes.filter((m) => valida(m) && m.transferenciaId && m.sentido === SENTIDO.SAIDA && m.dataEfetiva >= inicio && m.dataEfetiva <= fimRealizado), (m) => m.valorCentavos),
    },
    previsto: {
      aplicavel: fim >= hoje, entradasCentavos: total(previstos, SENTIDO.ENTRADA), saidasCentavos: total(previstos, SENTIDO.SAIDA), variacaoCentavos: variacaoPrevista,
      porNatureza: porNatureza(previstos), itens: previstos,
    },
    semPrevisao: { quantidade: semPrevisao.length, saldoCentavos: somarLista(semPrevisao, (i) => i.saldoCentavos), itens: semPrevisao },
    // Execução 17: pago POR COMPROVANTE e ainda sem a saída do extrato. NÃO entra no realizado nem no saldo (nenhuma saída
    // fictícia); é informado à parte para o caixa não parecer maior do que é. Some quando o extrato concilia a mesma baixa.
    pagosPorComprovanteSemExtrato: (() => {
      const l = (p.liquidacoes ?? []).filter((q) => q.situacao !== SITUACAO_LIQUIDACAO.ESTORNADA && !q.movimentacaoId && q.alvoTipo === TIPO.OBRIGACAO);
      return { quantidade: l.length, totalCentavos: somarLista(l, (q) => validoDaLiquidacao(q)) };
    })(),
    projecao: {
      aplicavel: fim >= hoje, saldoBaseCentavos: saldoAtualCentavos, ate: fim,
      saldoProjetadoCentavos: fim >= hoje && saldoAtualCentavos !== null ? somar(saldoAtualCentavos, variacaoPrevista) : null,
      parcial: fim >= hoje && motivos.length > 0, motivos: fim >= hoje ? motivos : [],
    },
    serie,
  };
}

// ---------------------------------------------------------------------------------------------------------- calendário

/** Calendário financeiro do mês: o que vence, o que venceu e segue em aberto, o que foi pago e as recorrências previstas. */
export function calendarioFinanceiro(d, hoje, { mes }) {
  const p = preparar(d);
  const [inicio, fim] = [primeiroDiaDe(mes), ultimoDiaDe(mes)];
  const titulos = p.obrigacoes.map((o) => tituloAPagar(p, o, hoje)).filter((t) => t.situacao !== SITUACAO_A_PAGAR.CANCELADO);
  const porVencimento = agrupar(titulos.filter((t) => t.vencimento >= inicio && t.vencimento <= fim), (t) => t.vencimento);
  const pagamentos = titulos.flatMap((t) => t.pagamentos.filter((g) => g.data >= inicio && g.data <= fim).map((g) => ({ data: g.data, valorCentavos: g.valorCentavos, conta: g.conta, movimentacaoId: g.movimentacaoId ?? null, tituloId: t.id, fornecedor: t.fornecedor?.nome ?? null, descricao: t.descricao })));
  const porPagamento = agrupar(pagamentos, (g) => g.data);
  const porRecorrencia = agrupar(recorrencias(p, hoje, fim).previstas.filter((r) => r.data >= inicio), (r) => r.data);
  const resumo = (t) => ({ id: t.id, fornecedor: t.fornecedor?.nome ?? null, descricao: t.descricao, categoria: t.categoria?.nome ?? null, parcela: t.parcela, vencimento: t.vencimento, valorOriginalCentavos: t.valorOriginalCentavos, pagoCentavos: t.pagoCentavos, saldoCentavos: t.saldoCentavos, situacao: t.situacao, recorrente: Boolean(t.recorrencia) });
  const dias = [];
  for (let dia = inicio; dia <= fim; dia = somarDias(dia, 1)) {
    const doDia = porVencimento.get(dia) ?? [];
    const abertos = doDia.filter((t) => t.saldoCentavos > 0);
    const vencidos = abertos.filter((t) => t.vencido);
    const aVencer = abertos.filter((t) => !t.vencido);
    const pagos = porPagamento.get(dia) ?? [];
    const recorrentes = porRecorrencia.get(dia) ?? [];
    dias.push({
      data: dia, diaDaSemana: diaDaSemana(dia), hoje: dia === hoje,
      aVencer: { quantidade: aVencer.length, saldoCentavos: somarLista(aVencer, (t) => t.saldoCentavos) },
      vencidas: { quantidade: vencidos.length, saldoCentavos: somarLista(vencidos, (t) => t.saldoCentavos) },
      pagas: { quantidade: pagos.length, valorCentavos: somarLista(pagos, (g) => g.valorCentavos) },
      recorrentesPrevistas: { quantidade: recorrentes.length, valorCentavos: somarLista(recorrentes, (r) => r.valorCentavos) },
      emAbertoCentavos: somarLista(abertos, (t) => t.saldoCentavos),
      titulos: doDia.map(resumo), pagamentos: pagos, recorrentes, pagamentosAgrupados: agruparPorSaida(pagos),
    });
  }
  const soma = (fn) => somarLista(dias, fn);
  return {
    dataBase: hoje, mes, inicio, fim, dias,
    totais: {
      aVencerCentavos: soma((x) => x.aVencer.saldoCentavos), vencidoCentavos: soma((x) => x.vencidas.saldoCentavos), pagoCentavos: soma((x) => x.pagas.valorCentavos),
      emAbertoCentavos: soma((x) => x.emAbertoCentavos), recorrentePrevistoCentavos: soma((x) => x.recorrentesPrevistas.valorCentavos),
      titulos: soma((x) => x.titulos.length),
    },
  };
}

// -------------------------------------------------------------------------------------------- dinheiro em espécie

/**
 * DINHEIRO EM ESPÉCIE no período (doc 33). Não é canal nem receita: é a forma de pagamento "dinheiro" e o seu caminho no
 * caixa físico. Separa o que costuma ser confundido:
 *   - vendasEmDinheiro: pagamentos de venda na forma DINHEIRO pela DATA DO PAGAMENTO (o que o cliente pagou em espécie);
 *   - recebidoNoCaixa: desses, o que efetivamente ENTROU no caixa físico (movimento ligado ao pagamento);
 *   - semEntradaNoCaixa: venda em dinheiro sem entrada no caixa (pendência de conferência, nunca presumida);
 *   - outrasEntradas / suprimentos: entradas no caixa que não são venda (não viram receita);
 *   - depositosNoBanco: saídas do caixa para conta bancária própria (transferência interna, nunca receita nem despesa);
 *   - sangriasERetiradas: saídas do caixa sem destino em conta própria; pagamentosEmEspecie: demais saídas.
 * Movimentos estornados não contam; transferência interna nunca é receita. Por dia, para conferir com a contagem do caixa.
 */
export function dinheiroEmEspecie(d, { inicio, fim }) {
  const tipoDe = new Map((d.contas ?? []).map((c) => [c.id, c.tipo]));
  const transf = new Map((d.transferencias ?? []).map((t) => [t.id, t]));
  const noPeriodo = (data) => Boolean(data) && data >= inicio && data <= fim;
  const pagamentos = (d.pagamentosEmDinheiro ?? d.pagamentos ?? []).filter((p) => p.forma === "DINHEIRO" && noPeriodo(p.dataPagamento));
  const valido = (p) => subtrair(p.valorCentavos, p.estornadoCentavos ?? 0);
  const movs = (d.movimentacoes ?? []).filter((m) => !m.resumoDiario && tipoDe.get(m.contaId) === TIPO_CONTA.CAIXA_FISICO
    && m.situacao === SITUACAO_MOVIMENTACAO.VALIDA && noPeriodo(m.dataEfetiva));
  const destinoBancario = (m) => { const t = m.transferenciaId ? transf.get(m.transferenciaId) : null; return t ? tipoDe.get(m.sentido === SENTIDO.SAIDA ? t.contaDestinoId : t.contaOrigemId) === TIPO_CONTA.BANCARIA : false; };
  const grupo = (m) => {
    if (m.sentido === SENTIDO.ENTRADA) return m.pagamentoId ? "recebidoNoCaixa" : m.transferenciaId || /^Suprimento:/.test(m.descricao ?? "") ? "suprimentos" : "outrasEntradas";
    if (m.transferenciaId && destinoBancario(m)) return "depositosNoBanco";
    if (m.transferenciaId || /^Sangria:/.test(m.descricao ?? "")) return "sangriasERetiradas";
    return "pagamentosEmEspecie";
  };
  const zerado = () => ({ recebidoNoCaixa: 0, suprimentos: 0, outrasEntradas: 0, depositosNoBanco: 0, sangriasERetiradas: 0, pagamentosEmEspecie: 0 });
  const totais = zerado();
  const porDia = new Map();
  const dia = (data) => { if (!porDia.has(data)) porDia.set(data, { data, vendasEmDinheiro: 0, ...zerado() }); return porDia.get(data); };
  for (const m of movs) { const g = grupo(m); totais[g] = somar(totais[g], m.valorCentavos); dia(m.dataEfetiva)[g] = somar(dia(m.dataEfetiva)[g], m.valorCentavos); }
  const vendas = somarLista(pagamentos, valido);
  for (const p of pagamentos) dia(p.dataPagamento).vendasEmDinheiro = somar(dia(p.dataPagamento).vendasEmDinheiro, valido(p));
  const semEntrada = pagamentos.filter((p) => !p.movimentacaoId && valido(p) > 0);
  const temCaixa = (d.contas ?? []).some((c) => c.tipo === TIPO_CONTA.CAIXA_FISICO);
  return {
    periodo: { inicio, fim }, situacao: !pagamentos.length && !movs.length ? "SEM_REGISTROS" : "CALCULADO", temCaixaFisico: temCaixa,
    vendasEmDinheiroCentavos: vendas, ...Object.fromEntries(Object.entries(totais).map(([k, v]) => [`${k}Centavos`, v])),
    semEntradaNoCaixa: { quantidade: semEntrada.length, valorCentavos: somarLista(semEntrada, valido) },
    porDia: [...porDia.values()].sort((a, b) => a.data.localeCompare(b.data)),
    observacao: "Dinheiro é forma de pagamento, não canal: as vendas em dinheiro já estão no faturamento do canal (Balcão, iFood ou Anota Aí). Depósito do caixa no banco é transferência interna — nunca receita nova.",
  };
}

// -------------------------------------------------------------------------------------------- resumo para a Visão Geral

/**
 * Indicadores financeiros da Visão Geral. Cada número é o MESMO das consultas detalhadas (mesmas funções), nunca recalculado
 * por tela. Posições (saldos e títulos em aberto) são da data-base (hoje); o fluxo realizado é o do mês da competência.
 */
export function resumoFinanceiro(d, hoje, { competencia }) {
  const [inicio, fim] = [primeiroDiaDe(competencia), ultimoDiaDe(competencia)];
  const bancos = caixaEBancos(d, hoje, { inicio: hoje, fim: hoje, pagina: 1, tamanho: 1 });
  const pagar = contasAPagar(d, hoje, { pagina: 1, tamanho: 1 });
  const receber = contasAReceber(d, hoje, { pagina: 1, tamanho: 1 });
  const doMes = fluxoDeCaixa(d, hoje, { inicio, fim, granularidade: GRANULARIDADE.MES });
  const horizonte = somarDias(hoje, 30);
  const proximos = fluxoDeCaixa(d, hoje, { inicio: hoje, fim: horizonte, granularidade: GRANULARIDADE.MES });
  const conta = (tipo) => bancos.contas.filter((c) => c.tipo === tipo && c.ativa).map((c) => ({ nome: c.nome, saldoCentavos: c.saldoFinalCentavos, situacao: c.situacaoDoSaldo, saldoInformadoEm: c.saldoInformado?.data ?? null }));
  const saldo = (valor, contas) => ({ valorCentavos: valor, situacao: contas.length === 0 ? "SEM_CONTA" : valor === null ? SITUACAO_SALDO.DESCONHECIDO : SITUACAO_SALDO.CALCULADO, contas });
  const posicao = (registros, campos) => (registros === 0 ? { situacao: "SEM_REGISTROS", ...Object.fromEntries(Object.keys(campos).map((k) => [k, null])) } : { situacao: "CALCULADO", ...campos });
  return {
    dataBase: hoje, competencia,
    saldoBancario: saldo(bancos.consolidado.saldoBancarioCentavos, conta(TIPO_CONTA.BANCARIA)),
    saldoCaixaFisico: saldo(bancos.consolidado.saldoCaixaFisicoCentavos, conta(TIPO_CONTA.CAIXA_FISICO)),
    contasAPagar: { registros: pagar.totais.registros, ...posicao(pagar.totais.registros, { saldoCentavos: pagar.totais.saldoCentavos, vencidoCentavos: pagar.totais.vencidoCentavos }) },
    // 09C: a carga dirigida do resumo lê só os recebíveis EM ABERTO e traz do banco a CONTAGEM dos não cancelados
    // (pagos incluídos), que é o que decide "sem registros" × "calculado". Sem ela, conta os carregados (como antes).
    contasAReceber: {
      registros: d.recebiveisNaoCancelados ?? receber.totais.registros,
      ...posicao(d.recebiveisNaoCancelados ?? receber.totais.registros, { saldoCentavos: receber.totais.saldoCentavos, atrasadoCentavos: receber.totais.atrasadoCentavos, semPrevisaoCentavos: receber.totais.semPrevisaoCentavos, comPrevisaoCentavos: receber.totais.comPrevisaoCentavos }),
    },
    previsto30Dias: { ate: horizonte, entradasCentavos: proximos.previsto.entradasCentavos, saidasCentavos: proximos.previsto.saidasCentavos, parcial: proximos.projecao.parcial, motivos: proximos.projecao.motivos },
    fluxoDeCaixa: {
      realizadoNaCompetencia: { entradasCentavos: doMes.realizado.entradasCentavos, saidasCentavos: doMes.realizado.saidasCentavos, variacaoCentavos: doMes.realizado.variacaoCentavos, ate: doMes.realizado.ate, movimentacoes: doMes.realizado.entradasCentavos + doMes.realizado.saidasCentavos > 0 },
      saldoProjetado30DiasCentavos: proximos.projecao.saldoProjetadoCentavos, parcial: proximos.projecao.parcial, motivos: proximos.projecao.motivos,
    },
    pendencias: { movimentacoesSemVinculo: caixaEBancos(d, hoje, { inicio, fim, pagina: 1, tamanho: 1 }).pendencias.semVinculo, recorrenciasSemRegistro: pagar.recorrenciasSemRegistro.length },
    dinheiroEmEspecie: dinheiroEmEspecie(d, { inicio, fim }),
  };
}
