// VENDAS E RECEBIMENTOS (Execução 06B) — regras PURAS de consulta do ciclo de uma venda:
//   venda → pagamento → transação no processador → taxa → recebível → repasse → crédito bancário → conciliação.
//
// Tudo aqui é LEITURA dos registros que o núcleo já grava. Princípios:
//   * faturamento e resultado vêm do MOTOR DE APURAÇÃO (dominio/apuracao.js) — nada de "segunda DRE";
//   * contas a receber vêm de tituloAReceber (dominio/tesouraria.js) — os mesmos valores em qualquer tela;
//   * pagamento ≠ recebível ≠ repasse ≠ crédito bancário: cada etapa só aparece concluída com o registro que a prova;
//   * agregado diário (SAIPOS) é um total do dia: nunca vira pedidos, nunca ganha canal ou forma por suposição;
//   * transação de processador sem pedido NÃO vira venda; aparece como divergência;
//   * desconhecido é `null`/pendente, nunca zero nem "concluído".
// Dinheiro sempre em centavos inteiros. Frações de centavo (taxas Stone) aparecem em milionésimos de real, com a regra
// de arredondamento usada — o valor gravado é o arredondado.
import {
  CLASSIFICACAO as K, NATUREZA_LANCAMENTO as N, SITUACAO_CONCILIACAO, SITUACAO_LANCAMENTO, SITUACAO_MOVIMENTACAO, SITUACAO_PAGAMENTO,
  SITUACAO_SESSAO_CAIXA, SITUACAO_VENDA, TIPO, TIPO_CONTA,
} from "./catalogos.js";
import { somar, somarLista, subtrair } from "./dinheiro.js";
import { apurar, SEM_CANAL } from "./apuracao.js";
import { CATEGORIA_DESCONTO_A_CLASSIFICAR, CATEGORIA_VENDA_AGREGADA } from "./planoDeContas.js";
import { competenciaDe } from "./tempo.js";
import { SITUACAO_A_RECEBER, documentosDe, paginar, preparar as prepararTesouraria, tituloAReceber } from "./tesouraria.js";

const enumerar = (...v) => Object.freeze(Object.fromEntries(v.map((x) => [x, x])));

export const TIPO_OPERACAO = enumerar("VENDA", "AGREGADO_DIARIO");
export const SITUACAO_OPERACAO = enumerar(
  "AGUARDANDO_PAGAMENTO", "AGUARDANDO_RECEBIMENTO", "RECEBIDA_SEM_COMPROVACAO", "RECEBIDA_E_COMPROVADA", "EM_DIVERGENCIA", "CANCELADA", "AGREGADA_SEM_DETALHE",
);
export const CONFIABILIDADE = enumerar("DOCUMENTADA", "REGISTRADA_SEM_DOCUMENTO", "AGREGADA_SEM_DETALHE", "COM_PENDENCIA");
export const TIPO_COMPONENTE = enumerar(
  "DESCONTO_DA_LOJA", "DESCONTO_FINANCIADOR_NAO_COMPROVADO", "SUBSIDIO_DE_TERCEIRO", "DEVOLUCAO",
  "TAXA_DE_PROCESSAMENTO", "COMISSAO", "ANUNCIO", "MENSALIDADE", "ENCARGO_FINANCEIRO", "AJUSTE_COMERCIAL", "ESTORNO", "OUTRO_AJUSTE",
);
/** Componentes que são CUSTO do recebimento retido pelo processador (não são desconto comercial). */
export const CUSTOS_DO_RECEBIMENTO = Object.freeze(["TAXA_DE_PROCESSAMENTO", "COMISSAO", "ANUNCIO", "MENSALIDADE", "ENCARGO_FINANCEIRO", "AJUSTE_COMERCIAL", "OUTRO_AJUSTE"]);
export const COMPROVACAO = enumerar("CONCILIADA", "EXTRATO_BANCARIO", "CONTAGEM_DE_CAIXA", "SEM_COMPROVACAO");
export const SITUACAO_RECEBIMENTO = enumerar("NAO_RECEBIDO", "PARCIALMENTE_RECEBIDO", "RECEBIDO_SEM_COMPROVACAO", "RECEBIDO_E_COMPROVADO", "CANCELADO");
export const ETAPA = enumerar(
  "VENDA_REGISTRADA", "PAGAMENTO_INFORMADO", "TRANSACAO_PROCESSADA", "TAXA_IDENTIFICADA", "RECEBIVEL_FORMADO", "REPASSE_INFORMADO",
  "CREDITO_BANCARIO_IDENTIFICADO", "CONCILIACAO_CONFIRMADA", "ESTORNO", "CANCELAMENTO",
);
export const SITUACAO_ETAPA = enumerar("CONCLUIDA", "PENDENTE", "NAO_SE_APLICA");
export const DIVERGENCIA_VENDA = enumerar(
  "VENDA_SEM_PAGAMENTO", "PAGAMENTO_INCOMPATIVEL", "TRANSACAO_SEM_PEDIDO", "RECEBIVEL_SEM_REPASSE", "RECEBIVEL_ATRASADO", "REPASSE_INFORMADO_SEM_CREDITO",
  "CREDITO_SEM_COMPROVACAO_BANCARIA", "RECEBIMENTO_DIRETO_NAO_IDENTIFICADO", "TAXA_OU_VALOR_DIVERGENTE", "DESCONTO_SEM_FINANCIADOR", "VENDA_SEM_CANAL",
  "TOTAIS_DE_RELATORIOS_DIFERENTES", "SOBREPOSICAO_AGREGADO_PEDIDOS",
);
export const FORMA_DESCONHECIDA = "DESCONHECIDA";
export const SEM_PROCESSADOR = "SEM_PROCESSADOR";
export { SEM_CANAL };

// ---------------------------------------------------------------------------------------------------- textos de gestão
const CANAL_TXT = Object.freeze({ BALCAO: "no Balcão", IFOOD: "no iFood", ANOTA_AI: "pelo Anota AI", OUTRO: "em outro canal" });
const FORMA_TXT = Object.freeze({ DINHEIRO: "dinheiro", PIX: "Pix", DEBITO: "cartão de débito", CREDITO: "cartão de crédito", VALE: "vale-refeição/alimentação" });
export const PROCESSADOR_TXT = Object.freeze({ STONE: "Stone", IFOOD: "iFood", ANOTA_AI: "Anota AI", OPERADORA_BENEFICIOS: "Operadora de benefícios", MAQUINA_TERCEIROS: "Máquina de terceiros", OUTRO: "Outro processador" });
const SISTEMA_TXT = Object.freeze({ SAIPOS: "SAIPOS", IFOOD: "iFood", ANOTA_AI: "Anota AI", STONE: "Stone", UNICRED: "Unicred", FOODY: "Foody", MANUAL: "Registro manual", OUTRO: "Outra fonte" });
const DIA = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
/** Forma em linguagem de gestão. "OUTRA" é DESCONHECIDA: nunca vira cartão, Pix ou dinheiro por suposição. */
export function formaLegivel(forma, processador) {
  if (FORMA_TXT[forma]) return FORMA_TXT[forma];
  return processador ? `pago pelo ${PROCESSADOR_TXT[processador] ?? processador} (forma não detalhada)` : "forma não informada";
}
const microsTexto = (m) => `${Math.trunc(m / 1000000)},${String(m % 1000000).padStart(6, "0")}`;

// ---------------------------------------------------------------------------------------------------------- índices
const agrupar = (lista, chave) => {
  const mapa = new Map();
  for (const x of lista) { const k = chave(x); if (!mapa.has(k)) mapa.set(k, []); mapa.get(k).push(x); }
  return mapa;
};
const validoDaLiquidacao = (q) => subtrair(q.valorCentavos, q.estornadoCentavos ?? 0);
const restanteDoPagamento = (pg) => (pg.situacao === SITUACAO_PAGAMENTO.CANCELADO ? 0 : subtrair(pg.valorCentavos, pg.estornadoCentavos ?? 0));
const ordenarPor = (campo, desc = false) => (a, b) => {
  const [x, y] = [a[campo] ?? "", b[campo] ?? ""];
  return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1);
};

/** Índices montados UMA vez por consulta; reaproveita os da tesouraria (mesmas regras de títulos e documentos). */
export function prepararVendas(d) {
  const p = prepararTesouraria(d);
  const propostas = d.propostas ?? [];
  const propostaPorEfeito = new Map();
  for (const pr of propostas) for (const e of pr.efeitos ?? []) propostaPorEfeito.set(e.id, pr);
  // Taxas Stone em milionésimos: a proposta aplicada guarda o valor exato e o arredondado de cada ajuste que criou.
  const fracaoPorAjuste = new Map();
  for (const pr of propostas.filter((x) => x.operacao === "PAGAMENTO_STONE" && x.estado === "APLICADA")) {
    const ajustes = (pr.efeitos ?? []).filter((e) => e.tipo === TIPO.AJUSTE);
    // A data da taxa é a da TRANSAÇÃO no relatório (não a data em que o ajuste foi digitado/aplicado).
    (pr.comando?.taxas ?? []).forEach((t, i) => { if (ajustes[i] && Number.isSafeInteger(t.micros)) fracaoPorAjuste.set(ajustes[i].id, { ...t, data: pr.dataOperacao ?? null, fonte: pr.fonte ?? null }); });
  }
  return {
    p, propostas, propostaPorEfeito, fracaoPorAjuste,
    propostaPorId: new Map(propostas.map((x) => [x.id, x])),
    registroPorId: new Map((d.registros ?? []).map((r) => [r.id, r])),
    pagamentosPorVenda: agrupar(d.pagamentos ?? [], (x) => x.vendaId),
    recebiveisPorVenda: agrupar((d.recebiveis ?? []).filter((r) => r.vendaId), (r) => r.vendaId),
    estornosPorPagamento: agrupar((d.estornos ?? []).filter((e) => e.alvoTipo === "PAGAMENTO_VENDA"), (e) => e.alvoId),
    lancamentosDeVenda: agrupar((d.lancamentos ?? []).filter((l) => l.origem?.tipo === TIPO.VENDA || l.origem?.vendaId), (l) => l.origem?.vendaId ?? l.origem.id),
    categoriaPorCodigo: p.categoriaPorCodigo,
  };
}

// ---------------------------------------------------------------------------------------------- comprovação de créditos
/**
 * Como um crédito em conta está comprovado. Conciliado/extrato provam o dinheiro no banco; contagem de caixa (sessão
 * fechada que cobre a data) prova o dinheiro na gaveta. Movimentação digitada sem nada disso é "sem comprovação".
 */
export function comprovacaoDe(p, m) {
  if (!m) return null;
  if (m.situacaoConciliacao === SITUACAO_CONCILIACAO.CONCILIADA) return COMPROVACAO.CONCILIADA;
  if (m.fonte?.sistema === "UNICRED" || documentosDe(p, TIPO.MOVIMENTACAO, m).some((x) => x.tipo === "EXTRATO_BANCARIO")) return COMPROVACAO.EXTRATO_BANCARIO;
  const conta = p.contaPorId.get(m.contaId);
  if (conta?.tipo === TIPO_CONTA.CAIXA_FISICO && (p.sessoes ?? []).some((s) => s.contaId === conta.id && s.situacao === SITUACAO_SESSAO_CAIXA.FECHADA
    && s.dataAbertura <= m.dataEfetiva && s.dataFechamento >= m.dataEfetiva)) return COMPROVACAO.CONTAGEM_DE_CAIXA;
  return COMPROVACAO.SEM_COMPROVACAO;
}
const comprovado = (c) => c && c !== COMPROVACAO.SEM_COMPROVACAO;

function creditoLegivel(p, m, valorCentavos, extra = {}) {
  const conta = p.contaPorId.get(m.contaId);
  return {
    data: m.dataEfetiva, valorCentavos, conta: conta?.nome ?? null, tipoDeConta: conta?.tipo ?? null, movimentacaoId: m.id, valorDaMovimentacaoCentavos: m.valorCentavos,
    fonte: m.fonte?.sistema ?? "MANUAL", descricaoOriginal: m.descricao ?? null, comprovacao: comprovacaoDe(p, m), situacaoConciliacao: m.situacaoConciliacao,
    documentos: documentosDe(p, TIPO.MOVIMENTACAO, m), ...extra,
  };
}

// ---------------------------------------------------------------------------------------------- componentes (taxas/descontos)
function tipoPorClassificacao(classificacao, natureza) {
  if (natureza === N.DEDUCAO) return TIPO_COMPONENTE.AJUSTE_COMERCIAL;
  return ({
    [K.DESPESAS_RECEBIMENTO_PROCESSAMENTO]: TIPO_COMPONENTE.TAXA_DE_PROCESSAMENTO, [K.DESPESAS_COMERCIAIS]: TIPO_COMPONENTE.COMISSAO,
    [K.MARKETING]: TIPO_COMPONENTE.ANUNCIO, [K.DESPESAS_PLATAFORMAS]: TIPO_COMPONENTE.MENSALIDADE, [K.DESPESAS_FINANCEIRAS]: TIPO_COMPONENTE.ENCARGO_FINANCEIRO,
  })[classificacao] ?? TIPO_COMPONENTE.OUTRO_AJUSTE;
}
/** Linha da DRE em que o lançamento do componente entra (ou nenhuma). A DRE continua sendo a do motor de apuração. */
function linhaDaDre(l) {
  if (!l || l.situacao !== SITUACAO_LANCAMENTO.ATIVO) return null;
  if (l.categoria === "DESPESAS_A_CLASSIFICAR") return "FORA_ATE_CLASSIFICAR";
  if (l.natureza === N.DEDUCAO) return "DEDUCOES_COMERCIAIS";
  if (l.natureza === N.PATRIMONIAL) return "FORA_DO_RESULTADO";
  if (l.classificacao === K.CUSTOS_OPERACIONAIS) return "CUSTOS_OPERACIONAIS";
  if (l.classificacao === K.DESPESAS_FINANCEIRAS) return "RESULTADO_FINANCEIRO";
  if (l.classificacao === K.OUTROS_EFEITOS_GERENCIAIS) return "DEMAIS_EFEITOS_GERENCIAIS";
  return "DESPESAS_OPERACIONAIS";
}

/** Retenções e ajustes de um recebível: o que o processador cobra/abate do repasse. */
function componentesDoRecebivel(ix, r) {
  const { p } = ix;
  const nome = (codigo) => p.categoriaPorCodigo.get(codigo)?.nome ?? codigo;
  const daRetencao = (r.retencoes ?? []).map((x) => {
    const cat = p.categoriaPorCodigo.get(x.categoria);
    return {
      tipo: tipoPorClassificacao(cat?.classificacao, cat?.natureza), categoria: x.categoria, nome: nome(x.categoria), valorCentavos: x.valorCentavos, origem: "RETENCAO_DO_REPASSE",
      linhaDaDre: cat?.natureza === N.DEDUCAO ? "DEDUCOES_COMERCIAIS" : "DESPESAS_OPERACIONAIS", fracao: null, documentos: documentosDe(p, TIPO.RECEBIVEL, r),
      data: null, registradoEm: r.criadoEm?.slice(0, 10) ?? null, fonte: "DEMONSTRATIVO", competencia: r.competencia,
    };
  });
  const dosAjustes = (p.ajustesPorAlvo.get(r.id) ?? []).map((a) => {
    const l = a.lancamentoId ? p.lancamentoPorId.get(a.lancamentoId) : null;
    const fr = ix.fracaoPorAjuste.get(a.id);
    return {
      tipo: a.estornoId ? TIPO_COMPONENTE.ESTORNO : l ? tipoPorClassificacao(l.classificacao, l.natureza) : TIPO_COMPONENTE.OUTRO_AJUSTE,
      categoria: l?.categoria ?? null, nome: l ? nome(l.categoria) : a.estornoId ? "Estorno do pagamento" : "Ajuste sem lançamento",
      // Positivo = valor que REDUZ o repasse (taxa, comissão, estorno); negativo = valor que aumenta.
      valorCentavos: -a.valorCentavos, origem: "AJUSTE_DOCUMENTADO", motivo: a.motivo ?? null, linhaDaDre: linhaDaDre(l),
      fracao: fr ? { exatoMilionesimos: fr.micros, exatoReais: microsTexto(fr.micros), registradoCentavos: fr.valorCentavos, arredondamento: "METADE_PARA_CIMA", temFracao: fr.micros % 10000 !== 0 } : null,
      documentos: a.documentoId ? documentosDe(p, TIPO.AJUSTE, { id: a.id, documentoId: a.documentoId }) : documentosDe(p, TIPO.AJUSTE, a),
      // Data efetiva só quando a fonte a informa (relatório do processador); a data de registro é outra coisa e vem separada.
      data: fr?.data ?? null, registradoEm: a.criadoEm?.slice(0, 10) ?? null, fonte: fr?.fonte ?? null, competencia: a.competencia ?? r.competencia,
    };
  });
  return [...daRetencao, ...dosAjustes];
}

/** Descontos da venda (composição) e devoluções: o que reduz o valor cobrado ou a receita. */
function componentesDaVenda(ix, v) {
  const { p } = ix;
  const lancs = ix.lancamentosDeVenda.get(v.id) ?? [];
  const deducoes = lancs.filter((l) => l.origem?.componente === "DESCONTO");
  const usados = new Set();
  const descontos = (v.composicao?.descontos ?? []).map((dsc) => {
    const terceiroComprovado = dsc.financiador === "TERCEIRO" && Boolean(dsc.documentoId);
    // Lançamento correspondente (mesmo valor, ainda não usado) — o subsídio comprovado não tem lançamento: não reduz receita.
    const l = terceiroComprovado ? null : deducoes.find((x) => !usados.has(x.id) && x.valorCentavos === dsc.valorCentavos);
    if (l) usados.add(l.id);
    const tipo = dsc.financiador === "LOJA" ? TIPO_COMPONENTE.DESCONTO_DA_LOJA : terceiroComprovado ? TIPO_COMPONENTE.SUBSIDIO_DE_TERCEIRO : TIPO_COMPONENTE.DESCONTO_FINANCIADOR_NAO_COMPROVADO;
    return {
      tipo, financiador: terceiroComprovado ? "TERCEIRO_COMPROVADO" : dsc.financiador === "TERCEIRO" ? "TERCEIRO_NAO_COMPROVADO" : dsc.financiador, terceiro: dsc.terceiro ?? null,
      nome: dsc.descricao ?? null, valorCentavos: dsc.valorCentavos, origem: "COMPOSICAO_DA_VENDA", categoria: l?.categoria ?? null,
      linhaDaDre: terceiroComprovado ? "NENHUMA_SUBSIDIO_A_RECEBER" : linhaDaDre(l), provisoria: tipo === TIPO_COMPONENTE.DESCONTO_FINANCIADOR_NAO_COMPROVADO,
      fracao: null, documentos: dsc.documentoId ? [{ referencia: dsc.documentoId, tipo: p.documentoPorId.get(dsc.documentoId)?.tipo ?? null, descricao: p.documentoPorId.get(dsc.documentoId)?.descricao ?? null }] : [],
      data: v.dataVenda, competencia: v.competencia,
    };
  });
  const devolucoes = lancs.filter((l) => l.origem?.tipo === TIPO.ESTORNO).map((l) => ({
    tipo: TIPO_COMPONENTE.DEVOLUCAO, financiador: "LOJA", terceiro: null, nome: l.descricao ?? "Devolução ao cliente", valorCentavos: l.valorCentavos, origem: "ESTORNO_DE_PAGAMENTO",
    categoria: l.categoria, linhaDaDre: linhaDaDre(l), provisoria: false, fracao: null, documentos: [], data: l.dataOperacao, competencia: l.competencia,
  }));
  return { descontos, devolucoes };
}

// ---------------------------------------------------------------------------------------------- recebível → repasse → crédito
/** Cadeia de UM recebível: esperado, taxas, repasse informado, créditos (com comprovação), saldo e situação. */
export function cadeiaDoRecebivel(ix, r, hoje) {
  const { p } = ix;
  const t = tituloAReceber(p, r, hoje);
  const creditos = (p.liquidacoesPorAlvo.get(r.id) ?? []).map((q) => {
    const m = p.movPorId.get(q.movimentacaoId);
    return m ? creditoLegivel(p, m, validoDaLiquidacao(q), { data: q.dataEfetiva ?? m.dataEfetiva, titulosNoMesmoCredito: (p.liquidacoesPorMov.get(q.movimentacaoId) ?? []).length }) : null;
  }).filter(Boolean).sort(ordenarPor("data"));
  const repasseDocs = t.documentos.filter((x) => x.tipo === "DEMONSTRATIVO_REPASSE");
  const comprovadoC = somarLista(creditos.filter((c) => comprovado(c.comprovacao)), (c) => c.valorCentavos);
  const semComprovacaoC = somarLista(creditos.filter((c) => !comprovado(c.comprovacao)), (c) => c.valorCentavos);
  let situacaoRecebimento;
  if (t.situacao === SITUACAO_A_RECEBER.CANCELADO) situacaoRecebimento = SITUACAO_RECEBIMENTO.CANCELADO;
  else if (t.recebidoCentavos === 0 && t.saldoCentavos > 0) situacaoRecebimento = SITUACAO_RECEBIMENTO.NAO_RECEBIDO;
  else if (t.saldoCentavos > 0) situacaoRecebimento = SITUACAO_RECEBIMENTO.PARCIALMENTE_RECEBIDO;
  else situacaoRecebimento = semComprovacaoC > 0 ? SITUACAO_RECEBIMENTO.RECEBIDO_SEM_COMPROVACAO : SITUACAO_RECEBIMENTO.RECEBIDO_E_COMPROVADO;
  const componentes = componentesDoRecebivel(ix, r);
  return {
    id: r.id, tipo: t.tipo, vendaId: r.vendaId ?? null, processador: r.processador ?? null, canal: r.canal ?? null, canalComprovado: Boolean(r.canal),
    forma: r.forma ?? null, descricao: r.descricao ?? null, competencia: r.competencia,
    // Formação = data do pagamento que gerou o direito (quando nasce de venda); avulso só tem a data de registro.
    formadoEm: r.pagamentoId ? p.pagamentoPorId.get(r.pagamentoId)?.dataPagamento ?? null : null, registradoEm: r.criadoEm?.slice(0, 10) ?? null,
    brutoCentavos: r.brutoCentavos, componentes,
    custosCentavos: somarLista(componentes.filter((c) => CUSTOS_DO_RECEBIMENTO.includes(c.tipo)), (c) => c.valorCentavos),
    esperadoCentavos: t.esperadoCentavos, liquidadoCentavos: t.recebidoCentavos, saldoCentavos: t.saldoCentavos,
    dataPrevista: t.vencimentoPrevisto, previsaoConfiavel: t.previsaoConfiavel,
    // A data só é "confiável" com documento do processador; data digitada sem documento é mostrada como tal; sem data, nada é inventado.
    origemDaPrevisao: t.previsaoConfiavel ? "DOCUMENTO_DO_PROCESSADOR" : t.vencimentoPrevisto ? "DATA_SEM_DOCUMENTO" : "SEM_PREVISAO",
    dataEfetiva: t.dataDeLiquidacao, situacaoTitulo: t.situacao, situacaoRecebimento,
    repasse: { informado: repasseDocs.length > 0, documentos: repasseDocs },
    creditos, recebidoComprovadoCentavos: comprovadoC, recebidoSemComprovacaoCentavos: semComprovacaoC,
    documentos: t.documentos,
  };
}

// ---------------------------------------------------------------------------------------------------- operação de venda
function identificadorDe(fonte) {
  if (!fonte) return "Sem identificador";
  return `${SISTEMA_TXT[fonte.sistema] ?? fonte.sistema} · ${fonte.idExterno ?? "sem código"}`;
}

/** Pagamento com destino explícito: recebível (processador), conta (recebimento direto) ou nenhum destino registrado ainda. */
function pagamentoLegivel(ix, v, pg, subsidio) {
  const { p } = ix;
  const m = pg.movimentacaoId ? p.movPorId.get(pg.movimentacaoId) : null;
  const evid = ix.propostaPorEfeito.get(pg.id);
  const valido = restanteDoPagamento(pg);
  return {
    id: pg.id, indice: pg.indice, data: pg.dataPagamento, forma: pg.forma, formaLegivel: formaLegivel(pg.forma, pg.processador), formaConhecida: Boolean(FORMA_TXT[pg.forma]),
    processador: pg.processador ?? null, valorCentavos: pg.valorCentavos, estornadoCentavos: pg.estornadoCentavos ?? 0, validoCentavos: valido, situacao: pg.situacao, subsidio,
    destino: pg.recebivelId ? "RECEBIVEL" : pg.movimentacaoId ? "CONTA" : "SEM_DESTINO_REGISTRADO", recebivelId: pg.recebivelId ?? null,
    credito: m && m.situacao === SITUACAO_MOVIMENTACAO.VALIDA ? creditoLegivel(p, m, valido) : null,
    // Evidência do processador (ex.: transação Stone aplicada). Sem ela, a transação não aparece como processada.
    evidencia: evid ? { sistema: evid.fonte, identificador: evid.comando?.fonte?.idExterno ?? null, documentos: (evid.documentoIds ?? []).map((id) => ({ referencia: id, tipo: p.documentoPorId.get(id)?.tipo ?? null, descricao: p.documentoPorId.get(id)?.descricao ?? null })) } : null,
  };
}

function documentosDaVenda(ix, v) {
  const { p } = ix;
  const pr = ix.propostaPorEfeito.get(v.id);
  const ids = new Set(pr?.documentoIds ?? []);
  const lista = documentosDe(p, TIPO.VENDA, v);
  for (const id of ids) if (!lista.some((x) => x.referencia === id)) lista.push({ referencia: id, tipo: p.documentoPorId.get(id)?.tipo ?? null, descricao: p.documentoPorId.get(id)?.descricao ?? null });
  return lista;
}

export function operacaoDeVenda(ix, v, hoje) {
  const { p } = ix;
  const totalOriginal = (v.pagamentos ?? []).length;
  const subsidios = (v.composicao?.descontos ?? []).filter((x) => x.financiador === "TERCEIRO" && x.documentoId).length;
  const pagamentos = (ix.pagamentosPorVenda.get(v.id) ?? []).slice().sort((a, b) => a.indice - b.indice)
    .map((pg) => pagamentoLegivel(ix, v, pg, pg.indice < totalOriginal && pg.indice >= totalOriginal - subsidios));
  const recebiveis = (ix.recebiveisPorVenda.get(v.id) ?? []).slice().sort((a, b) => (a.pagamentoIndice ?? 0) - (b.pagamentoIndice ?? 0)).map((r) => cadeiaDoRecebivel(ix, r, hoje));
  const { descontos, devolucoes } = componentesDaVenda(ix, v);
  const cancelada = v.situacao === SITUACAO_VENDA.CANCELADA;
  const descontosCentavos = somarLista(descontos, (x) => x.valorCentavos);
  const pendente = cancelada ? 0 : subtrair(subtrair(subtrair(v.brutoCentavos, v.descontosCentavos ?? 0), v.devolvidoCentavos ?? 0), v.pagoCentavos);
  const deConsumidor = pagamentos.filter((x) => !x.subsidio);
  const formas = [...new Set(deConsumidor.filter((x) => x.situacao !== SITUACAO_PAGAMENTO.CANCELADO).map((x) => x.forma))];
  const processadores = [...new Set(pagamentos.filter((x) => x.processador && x.situacao !== SITUACAO_PAGAMENTO.CANCELADO).map((x) => x.processador))];
  // Recebimento direto (sem processador): crédito na conta quando há conta; sem conta, aguarda identificação no extrato.
  const diretos = pagamentos.filter((x) => !x.processador && x.validoCentavos > 0);
  const diretoComCredito = diretos.filter((x) => x.credito);
  const diretoSemDestino = cancelada ? [] : diretos.filter((x) => !x.credito);
  const vivos = recebiveis.filter((r) => r.situacaoRecebimento !== SITUACAO_RECEBIMENTO.CANCELADO);
  const recebidoComprovado = somar(somarLista(vivos, (r) => r.recebidoComprovadoCentavos), somarLista(diretoComCredito.filter((x) => comprovado(x.credito.comprovacao)), (x) => x.validoCentavos));
  const recebidoSemComprovacao = somar(somarLista(vivos, (r) => r.recebidoSemComprovacaoCentavos), somarLista(diretoComCredito.filter((x) => !comprovado(x.credito.comprovacao)), (x) => x.validoCentavos));
  const aReceber = somar(somarLista(vivos, (r) => r.saldoCentavos), somarLista(diretoSemDestino, (x) => x.validoCentavos));
  const divergente = vivos.some((r) => r.situacaoTitulo === SITUACAO_A_RECEBER.EM_DIVERGENCIA) || pendente < 0;
  let situacao;
  if (cancelada) situacao = SITUACAO_OPERACAO.CANCELADA;
  else if (divergente) situacao = SITUACAO_OPERACAO.EM_DIVERGENCIA;
  else if (pendente > 0) situacao = SITUACAO_OPERACAO.AGUARDANDO_PAGAMENTO;
  else if (aReceber > 0) situacao = SITUACAO_OPERACAO.AGUARDANDO_RECEBIMENTO;
  else situacao = recebidoSemComprovacao > 0 ? SITUACAO_OPERACAO.RECEBIDA_SEM_COMPROVACAO : SITUACAO_OPERACAO.RECEBIDA_E_COMPROVADA;

  const pr = ix.propostaPorEfeito.get(v.id);
  const registro = (pr?.registroIds ?? []).map((id) => ix.registroPorId.get(id)).find(Boolean) ?? null;
  const documentos = documentosDaVenda(ix, v);
  const pendencias = [];
  if (!cancelada && pendente > 0) pendencias.push("PAGAMENTO_PENDENTE");
  if (!cancelada && descontos.some((x) => x.provisoria)) pendencias.push("DESCONTO_SEM_FINANCIADOR");
  if (!cancelada && deConsumidor.some((x) => !x.formaConhecida)) pendencias.push("FORMA_NAO_DETALHADA");
  if (!cancelada && diretoSemDestino.length) pendencias.push("CREDITO_DIRETO_NAO_IDENTIFICADO");
  if (divergente) pendencias.push("EM_DIVERGENCIA");
  const motivosConfiabilidade = [];
  if (!documentos.length) motivosConfiabilidade.push("SEM_DOCUMENTO_DE_ORIGEM");
  for (const x of pendencias) motivosConfiabilidade.push(x);
  const nivel = pendencias.length ? CONFIABILIDADE.COM_PENDENCIA : documentos.length ? CONFIABILIDADE.DOCUMENTADA : CONFIABILIDADE.REGISTRADA_SEM_DOCUMENTO;
  const canalTxt = `Venda ${CANAL_TXT[v.canal] ?? ""}`.trim();
  // Venda cancelada mantém no título como FOI paga (os pagamentos cancelados continuam no histórico).
  const formasTxt = [...new Set(deConsumidor.filter((x) => cancelada || x.situacao !== SITUACAO_PAGAMENTO.CANCELADO).map((x) => x.formaLegivel))];
  const titulo = !formasTxt.length ? `${canalTxt} — sem pagamento registrado` : formasTxt.length === 1 ? `${canalTxt} — ${formasTxt[0]}` : `${canalTxt} — pagamento misto (${formasTxt.join(" + ")})`;
  const comp = v.composicao;
  return {
    id: v.id, tipo: TIPO_OPERACAO.VENDA, identificador: identificadorDe(v.fonte), titulo,
    data: v.dataVenda, horario: registro?.dados?.hora ?? null, competencia: v.competencia, canal: v.canal, canalComprovado: true,
    canceladaEm: cancelada ? v.atualizadoEm?.slice(0, 10) ?? null : null,
    valores: {
      brutoProprioCentavos: v.brutoCentavos,
      receita: comp ? { produtosCentavos: comp.itensCentavos, acrescimosCentavos: comp.acrescimosCentavos, servicosCentavos: comp.servicosCentavos } : null,
      acrescimosCentavos: comp ? comp.acrescimosCentavos : null, descontosCentavos, cobradoDoConsumidorCentavos: subtrair(v.brutoCentavos, descontosCentavos),
      devolvidoCentavos: v.devolvidoCentavos ?? 0, pagoCentavos: v.pagoCentavos, pendenteDePagamentoCentavos: pendente,
      custosDoRecebimentoCentavos: somarLista(vivos, (r) => r.custosCentavos),
      aReceberCentavos: aReceber, recebidoComprovadoCentavos: recebidoComprovado, recebidoSemComprovacaoCentavos: recebidoSemComprovacao,
    },
    descontos, devolucoes, situacao, formas, processadores, formaDesconhecida: !formas.length || deConsumidor.some((x) => !x.formaConhecida),
    pagamentos, recebiveis, diretoSemDestinoCentavos: somarLista(diretoSemDestino, (x) => x.validoCentavos),
    original: { sistema: v.fonte?.sistema ?? null, identificador: v.fonte?.idExterno ?? null, descricao: v.descricao ?? null, canal: registro?.dados?.canalOriginal ?? null, forma: registro?.dados?.formaOriginal ?? null, horario: registro?.dados?.hora ?? null },
    documentos, pendencias, confiabilidade: { nivel, motivos: motivosConfiabilidade }, propostaId: pr?.id ?? null,
  };
}

/** Receita agregada do dia (relatório sem pedidos): total, descontos e líquido do relatório — sem canal, forma ou processador. */
export function operacaoAgregada(ix, l) {
  const { p } = ix;
  const pr = l.origem?.tipo === TIPO.PROPOSTA ? ix.propostaPorId.get(l.origem.id) : null;
  const c = pr?.comando ?? {};
  const deducao = (p.lancamentos ?? []).find((x) => x.origem?.tipo === TIPO.PROPOSTA && x.origem.id === pr?.id && x.categoria === CATEGORIA_DESCONTO_A_CLASSIFICAR);
  const cancelada = l.situacao !== SITUACAO_LANCAMENTO.ATIVO;
  const descontos = deducao ? [{
    tipo: TIPO_COMPONENTE.DESCONTO_FINANCIADOR_NAO_COMPROVADO, financiador: "PENDENTE", terceiro: null, nome: "Descontos do dia (relatório agregado)", valorCentavos: deducao.valorCentavos,
    origem: "RELATORIO_AGREGADO", categoria: deducao.categoria, linhaDaDre: linhaDaDre(deducao), provisoria: true, fracao: null, documentos: [], data: l.dataOperacao, competencia: l.competencia,
  }] : [];
  const descontosCentavos = somarLista(descontos, (x) => x.valorCentavos);
  const documentos = (pr?.documentoIds ?? []).map((id) => ({ referencia: id, tipo: p.documentoPorId.get(id)?.tipo ?? null, descricao: p.documentoPorId.get(id)?.descricao ?? null }));
  return {
    id: l.id, tipo: TIPO_OPERACAO.AGREGADO_DIARIO, identificador: `${SISTEMA_TXT[pr?.fonte] ?? "Relatório"} · total do dia ${DIA(l.dataOperacao)}`,
    titulo: `Faturamento agregado do dia ${DIA(l.dataOperacao)} — sem pedidos individuais`,
    data: l.dataOperacao, horario: null, competencia: l.competencia, canal: null, canalComprovado: false,
    valores: {
      brutoProprioCentavos: l.valorCentavos, receita: null, acrescimosCentavos: null, descontosCentavos,
      cobradoDoConsumidorCentavos: Number.isSafeInteger(c.valorCentavos) ? c.valorCentavos : subtrair(l.valorCentavos, descontosCentavos),
      devolvidoCentavos: 0, pagoCentavos: null, pendenteDePagamentoCentavos: null, custosDoRecebimentoCentavos: null,
      aReceberCentavos: null, recebidoComprovadoCentavos: null, recebidoSemComprovacaoCentavos: null,
    },
    quantidadeDeVendas: c.quantidadeVendas ?? null, metodologia: c.metodologia ?? null,
    explicacao: "O relatório traz só o total do dia. Não há pedidos, canal, forma de pagamento nem processador: nada disso é presumido. Quando o relatório por pedido for importado, ele SUBSTITUI este total (nunca soma junto).",
    descontos, devolucoes: [], situacao: cancelada ? SITUACAO_OPERACAO.CANCELADA : SITUACAO_OPERACAO.AGREGADA_SEM_DETALHE,
    formas: [], processadores: [], formaDesconhecida: true, pagamentos: [], recebiveis: [], diretoSemDestinoCentavos: 0,
    original: { sistema: pr?.fonte ?? null, identificador: null, descricao: l.descricao ?? null, canal: null, forma: null, horario: null },
    documentos, pendencias: cancelada ? [] : ["SEM_GRANULARIDADE", "CANAL_NAO_IDENTIFICADO", ...(descontos.length ? ["DESCONTO_SEM_FINANCIADOR"] : [])],
    confiabilidade: { nivel: CONFIABILIDADE.AGREGADA_SEM_DETALHE, motivos: ["RELATORIO_AGREGADO_POR_DIA"] }, propostaId: pr?.id ?? null,
  };
}

/** Todas as operações de venda do escopo: vendas individuais + receitas agregadas por dia. */
export function operacoesDeVenda(ix, hoje) {
  const vendas = (ix.p.vendas ?? []).map((v) => operacaoDeVenda(ix, v, hoje));
  const agregadas = (ix.p.lancamentos ?? []).filter((l) => l.categoria === CATEGORIA_VENDA_AGREGADA && l.origem?.tipo === TIPO.PROPOSTA).map((l) => operacaoAgregada(ix, l));
  const chave = (o) => `${o.data}|${o.horario ?? ""}|${o.id}`;
  return [...vendas, ...agregadas].sort((a, b) => (chave(a) < chave(b) ? 1 : chave(a) > chave(b) ? -1 : 0));
}

// ---------------------------------------------------------------------------------------------------------- filtros
export function atendeFiltro(op, f = {}) {
  if (f.competencia && op.competencia !== f.competencia) return false;
  if (f.inicio && op.data < f.inicio) return false;
  if (f.fim && op.data > f.fim) return false;
  if (f.canal && (op.canal ?? SEM_CANAL) !== f.canal) return false;
  if (f.forma && (f.forma === FORMA_DESCONHECIDA ? !op.formaDesconhecida : !op.formas.includes(f.forma))) return false;
  if (f.processador && (f.processador === SEM_PROCESSADOR ? op.tipo !== TIPO_OPERACAO.VENDA || op.processadores.length > 0 : !op.processadores.includes(f.processador))) return false;
  if (f.situacao && op.situacao !== f.situacao) return false;
  if (f.valorMinimoCentavos !== null && f.valorMinimoCentavos !== undefined && op.valores.brutoProprioCentavos < f.valorMinimoCentavos) return false;
  if (f.valorMaximoCentavos !== null && f.valorMaximoCentavos !== undefined && op.valores.brutoProprioCentavos > f.valorMaximoCentavos) return false;
  if (f.identificador && !op.identificador.toLowerCase().includes(f.identificador.toLowerCase())) return false;
  return true;
}
const soFiltroDeCompetencia = (f) => ["inicio", "fim", "canal", "forma", "processador", "situacao", "valorMinimoCentavos", "valorMaximoCentavos", "identificador"].every((k) => f[k] === null || f[k] === undefined || f[k] === "");

// ---------------------------------------------------------------------------------------------------------- resumo
/**
 * Resumo superior. Faturamento e deduções da competência vêm do MOTOR DE APURAÇÃO (mesmo número da DRE). Os demais totais
 * (cobrado, custos do recebimento, a receber, recebido) são operacionais e têm metodologia própria, explicada aqui.
 */
export function resumoDeVendas(ops, apuracao, filtro) {
  const vivas = ops.filter((o) => o.situacao !== SITUACAO_OPERACAO.CANCELADA);
  const vendas = vivas.filter((o) => o.tipo === TIPO_OPERACAO.VENDA);
  const soma = (lista, fn) => somarLista(lista, (o) => fn(o) ?? 0);
  const custosPorTipo = {};
  for (const o of vendas) for (const r of o.recebiveis) for (const c of r.componentes.filter((x) => CUSTOS_DO_RECEBIMENTO.includes(x.tipo))) custosPorTipo[c.tipo] = somar(custosPorTipo[c.tipo] ?? 0, c.valorCentavos);
  const fb = apuracao?.indicadores?.FATURAMENTO_BRUTO_PROPRIO ?? null;
  const brutoListado = soma(vivas, (o) => o.valores.brutoProprioCentavos);
  return {
    operacoes: vivas.length, vendasIndividuais: vendas.length, agregadosDiarios: vivas.length - vendas.length, canceladas: ops.length - vivas.length,
    brutoProprioCentavos: vivas.length ? brutoListado : null,
    descontosCentavos: vivas.length ? soma(vivas, (o) => o.valores.descontosCentavos) : null,
    cobradoDoConsumidorCentavos: vivas.length ? soma(vivas, (o) => o.valores.cobradoDoConsumidorCentavos) : null,
    custosDoRecebimentoCentavos: vendas.length ? soma(vendas, (o) => o.valores.custosDoRecebimentoCentavos) : null, custosPorTipo,
    aReceberCentavos: vendas.length ? soma(vendas, (o) => o.valores.aReceberCentavos) : null,
    recebidoComprovadoCentavos: vendas.length ? soma(vendas, (o) => o.valores.recebidoComprovadoCentavos) : null,
    recebidoSemComprovacaoCentavos: vendas.length ? soma(vendas, (o) => o.valores.recebidoSemComprovacaoCentavos) : null,
    // Receita agregada não tem pagamento/recebível rastreável: entra no bruto, mas fica FORA dos totais de recebimento.
    agregadoSemRastreioCentavos: soma(vivas.filter((o) => o.tipo === TIPO_OPERACAO.AGREGADO_DIARIO), (o) => o.valores.brutoProprioCentavos),
    dre: fb ? {
      competencia: apuracao.competencia, faturamentoBrutoCentavos: fb.valorCentavos, situacao: fb.situacao,
      porCanal: fb.porCanal.map((c) => ({ canal: c.canal, valorCentavos: c.valorCentavos, comprovado: c.comprovado })),
      deducoesComerciaisCentavos: apuracao.indicadores.DEDUCOES_COMERCIAIS?.valorCentavos ?? null,
    } : null,
    // Conferência explícita com a DRE: só faz sentido quando o filtro é apenas a competência.
    conferenciaComDre: fb && soFiltroDeCompetencia(filtro) ? { brutoListadoCentavos: vivas.length ? brutoListado : null, faturamentoDaDreCentavos: fb.valorCentavos, confere: (vivas.length ? brutoListado : null) === fb.valorCentavos } : null,
    metodologia: {
      brutoProprio: "Σ valor bruto próprio (produtos + acréscimos + serviços da loja) das operações não canceladas. Com filtro só de competência, é o MESMO número da DRE.",
      descontos: "Σ descontos da composição de cada venda (loja, terceiro e financiador não comprovado) e dos relatórios agregados.",
      cobrado: "Bruto próprio − descontos: o que o consumidor pagou (não é receita líquida nem depósito).",
      custosDoRecebimento: "Σ taxas, comissões, anúncios, mensalidades e encargos retidos nos recebíveis das vendas listadas. Não é desconto comercial.",
      aReceber: "Saldo em aberto dos recebíveis das vendas + recebimentos diretos ainda sem crédito identificado.",
      recebido: "Créditos vinculados às vendas. 'Comprovado' = conciliado, do extrato bancário ou coberto por contagem de caixa fechada.",
    },
  };
}

// ---------------------------------------------------------------------------------------------------------- linha do tempo
const evento = (etapa, situacao, extra = {}) => ({ etapa, situacao, data: null, fonte: null, documentos: [], valorCentavos: null, descricao: "", ...extra });
const ORDEM_ETAPA = Object.fromEntries(Object.values(ETAPA).map((e, i) => [e, i]));

/** Etapas de UM recebível: taxa, repasse, crédito, conciliação. Etapa sem prova aparece PENDENTE (nunca concluída). */
export function linhaDoTempoDoRecebivel(r) {
  const ev = [];
  const custos = r.componentes.filter((c) => CUSTOS_DO_RECEBIMENTO.includes(c.tipo));
  ev.push(evento(ETAPA.RECEBIVEL_FORMADO, r.situacaoRecebimento === SITUACAO_RECEBIMENTO.CANCELADO ? SITUACAO_ETAPA.NAO_SE_APLICA : SITUACAO_ETAPA.CONCLUIDA, {
    data: r.formadoEm, registradoEm: r.registradoEm, fonte: r.processador, valorCentavos: r.brutoCentavos, documentos: r.documentos,
    descricao: `Direito a receber de ${PROCESSADOR_TXT[r.processador] ?? "processador"} pelo valor bruto${r.situacaoRecebimento === SITUACAO_RECEBIMENTO.CANCELADO ? " (cancelado com a venda)" : ""}.`,
  }));
  if (custos.length) {
    for (const c of custos) {
      ev.push(evento(ETAPA.TAXA_IDENTIFICADA, SITUACAO_ETAPA.CONCLUIDA, {
        data: c.data, registradoEm: c.registradoEm, fonte: c.fonte ?? (c.origem === "RETENCAO_DO_REPASSE" ? "DEMONSTRATIVO" : "MANUAL"), valorCentavos: c.valorCentavos, documentos: c.documentos, descricao: c.nome, fracao: c.fracao,
      }));
    }
  }
  else ev.push(evento(ETAPA.TAXA_IDENTIFICADA, SITUACAO_ETAPA.PENDENTE, { descricao: "Nenhuma taxa informada pelo processador para este recebível (pode não haver, mas não está comprovado)." }));
  ev.push(r.repasse.informado
    ? evento(ETAPA.REPASSE_INFORMADO, SITUACAO_ETAPA.CONCLUIDA, { data: r.dataPrevista, fonte: "DEMONSTRATIVO", documentos: r.repasse.documentos, valorCentavos: r.esperadoCentavos, descricao: "Repasse informado em demonstrativo." })
    : evento(ETAPA.REPASSE_INFORMADO, r.situacaoRecebimento === SITUACAO_RECEBIMENTO.CANCELADO ? SITUACAO_ETAPA.NAO_SE_APLICA : SITUACAO_ETAPA.PENDENTE, { descricao: "Sem demonstrativo de repasse do processador." }));
  for (const c of r.creditos) {
    ev.push(evento(ETAPA.CREDITO_BANCARIO_IDENTIFICADO, SITUACAO_ETAPA.CONCLUIDA, { data: c.data, fonte: c.fonte, documentos: c.documentos, valorCentavos: c.valorCentavos, descricao: `Crédito em ${c.conta ?? "conta"}${c.titulosNoMesmoCredito > 1 ? ` (repasse agrupado com ${c.titulosNoMesmoCredito - 1} outro(s) título(s))` : ""}` }));
    ev.push(evento(ETAPA.CONCILIACAO_CONFIRMADA, comprovado(c.comprovacao) ? SITUACAO_ETAPA.CONCLUIDA : SITUACAO_ETAPA.PENDENTE, { data: comprovado(c.comprovacao) ? c.data : null, fonte: c.comprovacao, valorCentavos: c.valorCentavos, descricao: comprovado(c.comprovacao) ? "Crédito comprovado." : "Crédito registrado sem extrato bancário ou conciliação." }));
  }
  if (r.saldoCentavos > 0 && r.situacaoRecebimento !== SITUACAO_RECEBIMENTO.CANCELADO) {
    ev.push(evento(ETAPA.CREDITO_BANCARIO_IDENTIFICADO, SITUACAO_ETAPA.PENDENTE, { data: null, valorCentavos: r.saldoCentavos, descricao: r.dataPrevista ? `Saldo ainda não creditado (previsto para ${DIA(r.dataPrevista)}${r.previsaoConfiavel ? "" : ", sem documento"}).` : "Saldo ainda não creditado; sem data prevista documentada (não presumida)." }));
  }
  return ev;
}

/** Linha do tempo da venda (pedido → recebimento). Eventos não ocorridos ficam PENDENTES, com a etapa explícita. */
export function linhaDoTempoDaVenda(op, ix) {
  const ev = [];
  ev.push(evento(ETAPA.VENDA_REGISTRADA, SITUACAO_ETAPA.CONCLUIDA, { data: op.data, horario: op.horario, fonte: op.original.sistema, documentos: op.documentos, valorCentavos: op.valores.brutoProprioCentavos, descricao: op.titulo }));
  if (op.tipo === TIPO_OPERACAO.AGREGADO_DIARIO) {
    ev.push(evento(ETAPA.PAGAMENTO_INFORMADO, SITUACAO_ETAPA.PENDENTE, { descricao: "Relatório agregado: formas de pagamento por pedido não informadas." }));
    return ev;
  }
  const consumidor = op.pagamentos.filter((x) => !x.subsidio);
  if (!consumidor.length) ev.push(evento(ETAPA.PAGAMENTO_INFORMADO, op.situacao === SITUACAO_OPERACAO.CANCELADA ? SITUACAO_ETAPA.NAO_SE_APLICA : SITUACAO_ETAPA.PENDENTE, { descricao: "Nenhum pagamento informado." }));
  for (const pg of op.pagamentos) {
    ev.push(evento(ETAPA.PAGAMENTO_INFORMADO, SITUACAO_ETAPA.CONCLUIDA, { data: pg.data, fonte: pg.evidencia?.sistema ?? op.original.sistema, valorCentavos: pg.valorCentavos, descricao: pg.subsidio ? `Subsídio de ${PROCESSADOR_TXT[pg.processador] ?? "terceiro"} (comprovado)` : `Pagamento: ${pg.formaLegivel}` }));
    if (pg.processador && !pg.subsidio) {
      ev.push(pg.evidencia
        ? evento(ETAPA.TRANSACAO_PROCESSADA, SITUACAO_ETAPA.CONCLUIDA, { data: pg.data, fonte: pg.evidencia.sistema, documentos: pg.evidencia.documentos, valorCentavos: pg.valorCentavos, descricao: `Transação ${pg.evidencia.identificador ?? ""} no relatório do processador.`.trim() })
        : evento(ETAPA.TRANSACAO_PROCESSADA, SITUACAO_ETAPA.PENDENTE, { valorCentavos: pg.valorCentavos, descricao: `Sem relatório de ${PROCESSADOR_TXT[pg.processador] ?? "processador"} que comprove a transação.` }));
    }
    if (!pg.processador) {
      ev.push(pg.credito
        ? evento(ETAPA.CREDITO_BANCARIO_IDENTIFICADO, SITUACAO_ETAPA.CONCLUIDA, { data: pg.credito.data, fonte: pg.credito.fonte, documentos: pg.credito.documentos, valorCentavos: pg.validoCentavos, descricao: `Recebido direto em ${pg.credito.conta ?? "conta"}` })
        : evento(ETAPA.CREDITO_BANCARIO_IDENTIFICADO, pg.validoCentavos > 0 ? SITUACAO_ETAPA.PENDENTE : SITUACAO_ETAPA.NAO_SE_APLICA, { valorCentavos: pg.validoCentavos, descricao: "Recebimento direto ainda sem crédito identificado na conta." }));
      if (pg.credito) ev.push(evento(ETAPA.CONCILIACAO_CONFIRMADA, comprovado(pg.credito.comprovacao) ? SITUACAO_ETAPA.CONCLUIDA : SITUACAO_ETAPA.PENDENTE, { data: comprovado(pg.credito.comprovacao) ? pg.credito.data : null, fonte: pg.credito.comprovacao, valorCentavos: pg.validoCentavos, descricao: comprovado(pg.credito.comprovacao) ? "Crédito comprovado." : "Sem extrato, conciliação ou contagem de caixa que comprove." }));
    }
  }
  for (const r of op.recebiveis) for (const e of linhaDoTempoDoRecebivel(r)) ev.push({ ...e, recebivelId: r.id });
  for (const pg of op.pagamentos) for (const es of ix.estornosPorPagamento.get(pg.id) ?? []) {
    ev.push(evento(ETAPA.ESTORNO, SITUACAO_ETAPA.CONCLUIDA, { data: es.dataEfetiva, fonte: "MANUAL", valorCentavos: es.valorCentavos, descricao: `${es.motivo === "DEVOLUCAO_AO_CLIENTE" ? "Devolução ao cliente" : "Correção de pagamento"}: ${es.justificativa ?? ""}`.trim() }));
  }
  if (op.situacao === SITUACAO_OPERACAO.CANCELADA) ev.push(evento(ETAPA.CANCELAMENTO, SITUACAO_ETAPA.CONCLUIDA, { data: op.canceladaEm ?? null, valorCentavos: op.valores.brutoProprioCentavos, descricao: "Venda cancelada: receita, descontos e recebíveis cancelados com histórico." }));
  return ev.map((e, i) => ({ ...e, ordem: i })).sort((a, b) => ORDEM_ETAPA[a.etapa] - ORDEM_ETAPA[b.etapa] || a.ordem - b.ordem).map(({ ordem, ...e }) => e);
}

// ---------------------------------------------------------------------------------------------------------- transações sem venda
/** Transações do processador preservadas SEM venda (nenhuma venda é criada a partir delas). */
export function transacoesSemVenda(ix) {
  const abertas = ["PROPOSTA", "AGUARDANDO_EVIDENCIA", "AGUARDANDO_REVISAO", "APROVADA"];
  return ix.propostas.filter((pr) => pr.operacao === "PAGAMENTO_STONE" && !pr.comando?.vendaId && abertas.includes(pr.estado)).map((pr) => ({
    id: pr.id, processador: pr.comando?.processador ?? "STONE", data: pr.dataOperacao, competencia: pr.competencia, valorCentavos: pr.valorCentavos,
    forma: pr.comando?.forma ?? null, formaLegivel: formaLegivel(pr.comando?.forma, pr.comando?.processador), identificador: identificadorDe(pr.comando?.fonte),
    taxas: (pr.comando?.taxas ?? []).map((t) => ({ categoria: t.categoria, registradoCentavos: t.valorCentavos, exatoMilionesimos: t.micros, exatoReais: microsTexto(t.micros), arredondamento: "METADE_PARA_CIMA", temFracao: t.micros % 10000 !== 0 })),
    motivo: (pr.divergencias ?? []).find((x) => ["SEM_PEDIDO_CORRESPONDENTE", "VINCULO_AMBIGUO"].includes(x.codigo))?.codigo ?? "SEM_PEDIDO_CORRESPONDENTE",
    candidatas: (pr.candidatas ?? []).length, estado: pr.estado,
    documentos: (pr.documentoIds ?? []).map((id) => ({ referencia: id, tipo: ix.p.documentoPorId.get(id)?.tipo ?? null, descricao: ix.p.documentoPorId.get(id)?.descricao ?? null })),
  }));
}

// ---------------------------------------------------------------------------------------------------------- processadores
/** Consolidado por processador (Stone, iFood, Anota AI, operadoras de vale e futuros): transação ≠ recebível ≠ repasse ≠ depósito. */
export function processadoresDe(ix, ops, recebiveisAvulsos, semVenda) {
  const mapa = new Map();
  const de = (proc) => {
    if (!mapa.has(proc)) mapa.set(proc, { processador: proc, nome: PROCESSADOR_TXT[proc] ?? proc, transacoes: 0, brutoProcessadoCentavos: 0, custosCentavos: 0, componentes: {}, liquidoEsperadoCentavos: 0, recebiveis: 0, recebidoCentavos: 0, recebidoComprovadoCentavos: 0, recebidoSemComprovacaoCentavos: 0, saldoCentavos: 0, semPrevisaoCentavos: 0, repassesDocumentados: 0, porCanal: {}, transacoesSemVenda: 0, transacoesSemVendaCentavos: 0, divergencias: 0 });
    return mapa.get(proc);
  };
  const somarRecebivel = (a, r) => {
    a.recebiveis += 1;
    a.custosCentavos = somar(a.custosCentavos, r.custosCentavos);
    for (const c of r.componentes) a.componentes[c.tipo] = somar(a.componentes[c.tipo] ?? 0, c.valorCentavos);
    a.liquidoEsperadoCentavos = somar(a.liquidoEsperadoCentavos, r.esperadoCentavos);
    a.recebidoCentavos = somar(a.recebidoCentavos, r.liquidadoCentavos);
    a.recebidoComprovadoCentavos = somar(a.recebidoComprovadoCentavos, r.recebidoComprovadoCentavos);
    a.recebidoSemComprovacaoCentavos = somar(a.recebidoSemComprovacaoCentavos, r.recebidoSemComprovacaoCentavos);
    a.saldoCentavos = somar(a.saldoCentavos, r.saldoCentavos);
    if (r.saldoCentavos > 0 && !r.previsaoConfiavel) a.semPrevisaoCentavos = somar(a.semPrevisaoCentavos, r.saldoCentavos);
    if (r.repasse.informado) a.repassesDocumentados += 1;
    if (r.situacaoTitulo === SITUACAO_A_RECEBER.EM_DIVERGENCIA) a.divergencias += 1;
    const canal = r.canal ?? SEM_CANAL;
    a.porCanal[canal] = somar(a.porCanal[canal] ?? 0, r.brutoCentavos);
  };
  for (const op of ops.filter((o) => o.tipo === TIPO_OPERACAO.VENDA && o.situacao !== SITUACAO_OPERACAO.CANCELADA)) {
    for (const pg of op.pagamentos.filter((x) => x.processador && x.validoCentavos > 0 && !x.subsidio)) {
      const a = de(pg.processador);
      a.transacoes += 1;
      a.brutoProcessadoCentavos = somar(a.brutoProcessadoCentavos, pg.validoCentavos);
    }
    for (const r of op.recebiveis.filter((x) => x.situacaoRecebimento !== SITUACAO_RECEBIMENTO.CANCELADO)) somarRecebivel(de(r.processador), r);
  }
  for (const r of recebiveisAvulsos.filter((x) => x.situacaoRecebimento !== SITUACAO_RECEBIMENTO.CANCELADO)) {
    const a = de(r.processador);
    a.transacoes += 1;
    a.brutoProcessadoCentavos = somar(a.brutoProcessadoCentavos, r.brutoCentavos);
    somarRecebivel(a, r);
  }
  for (const t of semVenda) {
    const a = de(t.processador);
    a.transacoesSemVenda += 1;
    a.transacoesSemVendaCentavos = somar(a.transacoesSemVendaCentavos, t.valorCentavos);
    a.divergencias += 1;
  }
  return [...mapa.values()].map((a) => ({
    ...a,
    // Para o iFood (e plataformas), o detalhamento separa venda, desconto, comissão, anúncio, mensalidade, encargo e ajuste.
    observacao: "Líquido esperado do processador não é lucro e não é depósito: só o crédito identificado na conta é dinheiro recebido.",
  })).sort((x, y) => y.brutoProcessadoCentavos - x.brutoProcessadoCentavos);
}

/** Visão do iFood: bruto próprio, descontos/subsídios, componentes cobrados e repasses, separados (nunca misturados). */
export function composicaoIfood(ops) {
  const vendas = ops.filter((o) => o.tipo === TIPO_OPERACAO.VENDA && o.canal === "IFOOD" && o.situacao !== SITUACAO_OPERACAO.CANCELADA);
  const comp = {};
  for (const o of vendas) for (const r of o.recebiveis.filter((x) => x.processador === "IFOOD")) for (const c of r.componentes) comp[c.tipo] = somar(comp[c.tipo] ?? 0, c.valorCentavos);
  const rec = vendas.flatMap((o) => o.recebiveis.filter((x) => x.processador === "IFOOD"));
  return vendas.length ? {
    vendas: vendas.length, brutoProprioCentavos: somarLista(vendas, (o) => o.valores.brutoProprioCentavos),
    servicosCentavos: somarLista(vendas, (o) => o.valores.receita?.servicosCentavos ?? 0),
    descontosDaLojaCentavos: somarLista(vendas.flatMap((o) => o.descontos.filter((x) => x.tipo === TIPO_COMPONENTE.DESCONTO_DA_LOJA)), (x) => x.valorCentavos),
    descontosAClassificarCentavos: somarLista(vendas.flatMap((o) => o.descontos.filter((x) => x.tipo === TIPO_COMPONENTE.DESCONTO_FINANCIADOR_NAO_COMPROVADO)), (x) => x.valorCentavos),
    subsidiosDeTerceiroCentavos: somarLista(vendas.flatMap((o) => o.descontos.filter((x) => x.tipo === TIPO_COMPONENTE.SUBSIDIO_DE_TERCEIRO)), (x) => x.valorCentavos),
    comissoesCentavos: comp.COMISSAO ?? 0, taxasCentavos: comp.TAXA_DE_PROCESSAMENTO ?? 0, mensalidadesCentavos: comp.MENSALIDADE ?? 0, anunciosCentavos: comp.ANUNCIO ?? 0,
    encargosCentavos: comp.ENCARGO_FINANCEIRO ?? 0, ajustesCentavos: somar(comp.AJUSTE_COMERCIAL ?? 0, comp.OUTRO_AJUSTE ?? 0), estornosCentavos: comp.ESTORNO ?? 0,
    liquidoEsperadoCentavos: somarLista(rec, (r) => r.esperadoCentavos), repassadoCentavos: somarLista(rec, (r) => r.liquidadoCentavos),
    repassadoComprovadoCentavos: somarLista(rec, (r) => r.recebidoComprovadoCentavos), aReceberCentavos: somarLista(rec, (r) => r.saldoCentavos),
    observacao: "Comissões, taxas, anúncios e mensalidades são DESPESAS (não descontos). O líquido do iFood não é lucro e só o crédito na conta é dinheiro recebido.",
  } : null;
}

// ---------------------------------------------------------------------------------------------------------- divergências
/** Divergências de vendas e recebimentos. Nada é resolvido por proximidade de valores e nenhum ajuste é inventado. */
export function divergenciasDeVendas(ix, ops, recebiveisAvulsos, semVenda, apuracoes, hoje) {
  const lista = [];
  const add = (codigo, x) => lista.push({ codigo, situacao: "ABERTA", evidencias: [], ...x });
  const periodoDe = (data) => ({ inicio: data, fim: data });
  for (const op of ops.filter((o) => o.situacao !== SITUACAO_OPERACAO.CANCELADA)) {
    const ref = { tipo: op.tipo, id: op.id };
    if (op.tipo === TIPO_OPERACAO.AGREGADO_DIARIO) {
      add(DIVERGENCIA_VENDA.VENDA_SEM_CANAL, { titulo: "Faturamento sem canal identificado", valorCentavos: op.valores.brutoProprioCentavos, fonte: op.original.sistema, periodo: periodoDe(op.data), competencia: op.competencia, motivo: "Relatório agregado por dia: não informa canal, pedido nem forma de pagamento.", evidencias: op.documentos, proximaAcao: "Importar o relatório de vendas por pedido do dia (substitui o agregado sem somar).", referencia: ref, situacao: "INFORMATIVA" });
    }
    for (const dsc of op.descontos.filter((x) => x.provisoria)) {
      add(DIVERGENCIA_VENDA.DESCONTO_SEM_FINANCIADOR, { titulo: "Desconto sem financiador confirmado", valorCentavos: dsc.valorCentavos, fonte: op.original.sistema, periodo: periodoDe(op.data), competencia: op.competencia, motivo: "A fonte não informa se o desconto é da loja ou de terceiro: dedução provisória (nunca presumida).", evidencias: op.documentos, proximaAcao: "Confirmar o financiador com o relatório do canal (ex.: apuração iFood) e reclassificar.", referencia: ref });
    }
    if (op.tipo !== TIPO_OPERACAO.VENDA) continue;
    if (op.valores.pendenteDePagamentoCentavos > 0) add(DIVERGENCIA_VENDA.VENDA_SEM_PAGAMENTO, { titulo: "Venda sem pagamento correspondente", valorCentavos: op.valores.pendenteDePagamentoCentavos, fonte: op.original.sistema, periodo: periodoDe(op.data), competencia: op.competencia, motivo: "Faltam pagamentos informados para fechar o valor cobrado.", evidencias: op.documentos, proximaAcao: "Importar o relatório da processadora do dia ou registrar o pagamento com evidência.", referencia: ref });
    if (op.valores.pendenteDePagamentoCentavos < 0) add(DIVERGENCIA_VENDA.PAGAMENTO_INCOMPATIVEL, { titulo: "Pagamentos maiores que o valor cobrado", valorCentavos: -op.valores.pendenteDePagamentoCentavos, fonte: op.original.sistema, periodo: periodoDe(op.data), competencia: op.competencia, motivo: "A soma dos pagamentos supera bruto − descontos − devoluções.", evidencias: op.documentos, proximaAcao: "Revisar os pagamentos vinculados e estornar o registrado em excesso.", referencia: ref });
    if (op.diretoSemDestinoCentavos > 0) add(DIVERGENCIA_VENDA.RECEBIMENTO_DIRETO_NAO_IDENTIFICADO, { titulo: "Recebimento direto sem crédito identificado", valorCentavos: op.diretoSemDestinoCentavos, fonte: op.original.sistema, periodo: periodoDe(op.data), competencia: op.competencia, motivo: "Pagamento sem processador e sem conta de entrada: o crédito ainda não foi localizado.", evidencias: op.documentos, proximaAcao: "Importar o extrato/contagem do caixa e vincular o crédito.", referencia: ref });
    for (const r of op.recebiveis) divergenciasDoRecebivel(r, op.competencia, add, hoje, { tipo: TIPO_OPERACAO.VENDA, id: op.id });
  }
  for (const r of recebiveisAvulsos) divergenciasDoRecebivel(r, r.competencia, add, hoje, { tipo: "RECEBIVEL", id: r.id });
  for (const t of semVenda) {
    add(DIVERGENCIA_VENDA.TRANSACAO_SEM_PEDIDO, { titulo: `Transação ${PROCESSADOR_TXT[t.processador] ?? t.processador} sem pedido correspondente`, valorCentavos: t.valorCentavos, fonte: t.processador, periodo: periodoDe(t.data), competencia: t.competencia, motivo: t.motivo === "VINCULO_AMBIGUO" ? `${t.candidatas} vendas possíveis: o vínculo exige escolha manual.` : "Nenhuma venda do mesmo dia corresponde à transação. Ela NÃO vira venda.", evidencias: t.documentos, proximaAcao: "Importar o relatório por pedido do SAIPOS do dia ou vincular manualmente na revisão da proposta.", referencia: { tipo: "TRANSACAO", id: t.id } });
  }
  for (const dv of (ix.p.divergenciasFonte ?? []).filter((x) => x.estado !== "RESOLVIDA")) {
    add(DIVERGENCIA_VENDA.TOTAIS_DE_RELATORIOS_DIFERENTES, { titulo: "Relatórios do mesmo período com totais diferentes", valorCentavos: Math.abs(dv.diferencaCentavos), fonte: "SAIPOS", periodo: { inicio: dv.periodoInicio, fim: dv.periodoFim }, competencia: competenciaDe(dv.periodoInicio), motivo: `Faturamento por dia × formas de pagamento: ${dv.totais?.diasComDiferenca ?? 0} dia(s) com diferença.`, evidencias: [], proximaAcao: "Explicar a diferença com o relatório por pedido; nenhuma diferença é ajustada automaticamente.", referencia: { tipo: "RELATORIOS", id: dv.id }, situacao: dv.estado });
  }
  for (const ap of apuracoes) for (const pd of (ap?.pendencias ?? []).filter((x) => x.tipo === "SOBREPOSICAO_AGREGADO_PEDIDOS")) {
    add(DIVERGENCIA_VENDA.SOBREPOSICAO_AGREGADO_PEDIDOS, { titulo: "Agregado e pedidos do mesmo dia", valorCentavos: null, fonte: "SAIPOS", periodo: periodoDe(pd.data), competencia: ap.competencia, motivo: pd.mensagem, proximaAcao: "Substituir o agregado pelos pedidos (operação atômica) — nunca manter os dois.", referencia: { tipo: "DIA", id: pd.data } });
  }
  return lista.sort((a, b) => (a.periodo.inicio < b.periodo.inicio ? 1 : a.periodo.inicio > b.periodo.inicio ? -1 : a.codigo.localeCompare(b.codigo)));
}

function divergenciasDoRecebivel(r, competencia, add, hoje, referencia) {
  if (r.situacaoRecebimento === SITUACAO_RECEBIMENTO.CANCELADO) return;
  const fonte = r.processador ?? "Contraparte";
  const nome = PROCESSADOR_TXT[r.processador] ?? "processador";
  const base = { fonte, competencia, evidencias: r.documentos, referencia: { ...referencia, recebivelId: r.id } };
  if (r.situacaoTitulo === SITUACAO_A_RECEBER.EM_DIVERGENCIA) add(DIVERGENCIA_VENDA.TAXA_OU_VALOR_DIVERGENTE, { ...base, titulo: `Valor ou taxa divergente — ${nome}`, valorCentavos: r.saldoCentavos, periodo: { inicio: r.dataPrevista ?? null, fim: r.dataPrevista ?? null }, motivo: "O valor recebido não fecha com o esperado (correspondência marcada como divergente).", proximaAcao: "Conferir o demonstrativo do processador e registrar o ajuste documentado, se houver." });
  if (r.saldoCentavos > 0 && r.liquidadoCentavos === 0 && !r.repasse.informado) add(DIVERGENCIA_VENDA.RECEBIVEL_SEM_REPASSE, { ...base, titulo: `Recebível sem repasse — ${nome}`, valorCentavos: r.saldoCentavos, periodo: { inicio: null, fim: null }, motivo: r.previsaoConfiavel ? "Há previsão documentada, mas nenhum repasse foi creditado ainda." : "Sem demonstrativo de repasse e sem crédito identificado; a data não é presumida.", proximaAcao: `Importar os recebimentos/demonstrativo de ${nome} e o extrato da conta.` });
  if (r.saldoCentavos > 0 && r.repasse.informado && r.liquidadoCentavos === 0) add(DIVERGENCIA_VENDA.REPASSE_INFORMADO_SEM_CREDITO, { ...base, titulo: `Repasse informado sem crédito bancário — ${nome}`, valorCentavos: r.saldoCentavos, periodo: { inicio: r.dataPrevista, fim: r.dataPrevista }, motivo: "O demonstrativo informa o repasse, mas nenhum crédito correspondente foi vinculado.", proximaAcao: "Localizar o crédito no extrato e vincular (sem vínculo por valor aproximado)." });
  if (r.saldoCentavos > 0 && r.dataPrevista && r.dataPrevista < hoje) add(DIVERGENCIA_VENDA.RECEBIVEL_ATRASADO, { ...base, titulo: `Recebimento atrasado — ${nome}`, valorCentavos: r.saldoCentavos, periodo: { inicio: r.dataPrevista, fim: r.dataPrevista }, motivo: "A data prevista passou e o crédito não apareceu.", proximaAcao: "Cobrar o processador ou conferir o extrato do dia previsto." });
  for (const c of r.creditos.filter((x) => !comprovado(x.comprovacao))) add(DIVERGENCIA_VENDA.CREDITO_SEM_COMPROVACAO_BANCARIA, { ...base, titulo: `Repasse sem crédito bancário comprovado — ${nome}`, valorCentavos: c.valorCentavos, periodo: { inicio: c.data, fim: c.data }, motivo: "O recebimento foi registrado, mas não há extrato bancário nem conciliação que o comprove.", proximaAcao: "Importar o extrato da conta do dia e conciliar o crédito.", evidencias: c.documentos, referencia: { ...base.referencia, movimentacaoId: c.movimentacaoId } });
}

// ---------------------------------------------------------------------------------------------------------- API pura
/** Carrega índices, operações e (por competência) a apuração central. */
export function montarVisao(d, hoje, { escopo, apuradoEm, competencias = [] }) {
  const ix = prepararVendas(d);
  const ops = operacoesDeVenda(ix, hoje);
  const avulsos = (d.recebiveis ?? []).filter((r) => !r.vendaId && r.processador).map((r) => cadeiaDoRecebivel(ix, r, hoje));
  const semVenda = transacoesSemVenda(ix);
  const apuracoes = new Map(competencias.map((c) => [c, apurar({ lancamentos: d.lancamentos ?? [], categorias: d.categorias ?? [], vendas: d.vendas ?? [], propostas: d.propostas ?? [], obrigacoes: d.obrigacoes ?? [], movimentacoes: d.movimentacoes ?? [], recebiveis: d.recebiveis ?? [], ajustes: d.ajustes ?? [], competencias: d.competencias ?? [] }, { competencia: c, escopo, apuradoEm })]));
  return { ix, ops, avulsos, semVenda, apuracoes };
}

export { paginar };
