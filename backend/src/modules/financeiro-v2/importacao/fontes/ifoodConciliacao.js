// IFOOD — Relatório de Conciliação Financeira oficial (layout real: uma linha por MOVIMENTO, não por venda).
// Um pedido tem várias linhas; a cesta se repete em todas e entra UMA vez. Linhas idênticas são movimentos distintos
// (o saldo do iFood só fecha com todas elas): o motor as mantém separadas pelo número de ocorrência.
// Ler não lança nada. Data prevista de repasse é previsão: só o extrato bancário confirma o recebimento.
import { ehData } from "../../dominio/tempo.js";
import { centavos, rotulo } from "../leitor.js";
import { DIVERGENCIA, diferenca } from "../motor.js";
import { classificarPorPalavras, col, definirFonte } from "./comum.js";

export const COMPONENTE_CONCILIACAO = Object.freeze({
  ENTRADA: "ENTRADA", PROMOCAO_LOJA: "PROMOCAO_LOJA", PROMOCAO_IFOOD: "PROMOCAO_IFOOD", COMISSAO: "COMISSAO", TRANSACAO: "TRANSACAO",
  TAXA_DO_CLIENTE: "TAXA_DO_CLIENTE", ENTREGA_SOB_DEMANDA: "ENTREGA_SOB_DEMANDA", ANUNCIOS: "ANUNCIOS",
});
const C = COMPONENTE_CONCILIACAO;

const componenteDe = (descricao) => classificarPorPalavras(descricao, [
  [C.ENTRADA, [/^entrada financeira$/]],
  [C.PROMOCAO_LOJA, ["custeada pela loja"]],
  [C.PROMOCAO_IFOOD, ["custeada pelo ifood"]],
  [C.COMISSAO, ["comissao do ifood"]],
  [C.TRANSACAO, ["taxa de transacao"]],
  // Pagas pelo cliente, embutidas na Entrada Financeira e retidas pelo iFood: não são receita nem despesa da loja.
  [C.TAXA_DO_CLIENTE, ["taxa de servico ifood cobrada do cliente", "taxa de conveniencia por pagamento parcelado", "taxa entrega ifood"]],
  [C.ENTREGA_SOB_DEMANDA, ["entrega sob demanda"]],
  [C.ANUNCIOS, ["pacote de anuncios"]],
]);

const dataDe = (texto) => { const d = String(texto ?? "").slice(0, 10); return ehData(d) ? d : null; };

export const IFOOD_CONCILIACAO = definirFonte({
  fonte: "IFOOD",
  tipoRelatorio: "IFOOD_CONCILIACAO",
  tipoDocumento: "DEMONSTRATIVO_REPASSE",
  descricao: "relatório de conciliação financeira do iFood",
  formatosHomologados: ["xlsx"],
  colunas: {
    competencia: col(["competencia"]), fato: col(["fato_gerador"]), tipo: col(["tipo_lancamento"]), descricao: col(["descricao_lancamento"]),
    valor: col(["valor"]), base: col(["base_calculo"]), percentual: col(["percentual_taxa"]),
    pedido: col(["pedido_associado_ifood"]), pedidoCurto: col(["pedido_associado_ifood_curto"]), criacaoPedido: col(["data_criacao_pedido_associado"]),
    repasse: col(["data_repasse_esperada"]), valorSaldo: col(["valor_transacao"]), loja: col(["loja_id"]), faturamento: col(["data_faturamento"]),
    apuracaoInicio: col(["data_apuracao_inicio"]), apuracaoFim: col(["data_apuracao_fim"]), cesta: col(["valor_cesta_final"]),
    responsavel: col(["responsavel_transacao"]), impacto: col(["impacto_no_repasse"]), saldo: col(["id_saldo"]),
    metodo: col(["metodo_pagamento"], false), motivo: col(["motivo_cancelamento"], false),
  },
  colunasOmitidas: ["cnpj"],
  converter(u) {
    const dia = (campo, opcional = false) => {
      const d = dataDe(u.bruto(campo));
      if (!d && !(opcional && !u.bruto(campo))) u.erro("DATA_INVALIDA", `${campo} não é uma data válida.`, campo);
      return d;
    };
    const valor = u.valor("valor");
    const cesta = u.valor("cesta");
    const base = u.valor("base");
    u.valor("valorSaldo");
    const faturamento = dia("faturamento");
    const apuracaoInicio = dia("apuracaoInicio");
    const apuracaoFim = dia("apuracaoFim");
    const repasse = dia("repasse");
    const pedido = u.bruto("pedido") || null;
    const criacao = dia("criacaoPedido", true);
    const impacto = rotulo(u.bruto("impacto"));
    if (!["sim", "nao"].includes(impacto)) u.erro("VALOR_INVALIDO", "impacto_no_repasse deve ser SIM ou NÃO.", "impacto");
    if (u.erros.length) return null;
    const descricao = u.bruto("descricao");
    return {
      tipoRegistro: "MOVIMENTO_CONCILIACAO", idExterno: null, data: faturamento, valorCentavos: valor,
      dados: {
        componente: componenteDe(descricao) ?? "NAO_RECONHECIDO", descricaoOriginal: descricao, fatoGerador: u.bruto("fato"), tipoLancamento: u.bruto("tipo"),
        competenciaInformada: u.bruto("competencia"), pedido: pedido?.toLowerCase() ?? null, pedidoCurto: u.bruto("pedidoCurto") || null, dataPedido: criacao ?? faturamento,
        cestaCentavos: cesta, baseCalculoCentavos: base, percentualTaxa: u.bruto("percentual"), impactaRepasse: impacto === "sim", responsavel: u.bruto("responsavel"),
        idSaldo: u.bruto("saldo"), apuracaoInicio, apuracaoFim, repasseEsperado: repasse,
        metodoPagamento: u.bruto("metodo") || null, motivoCancelamento: u.bruto("motivo") || null, estabelecimento: u.bruto("loja"),
      },
      identidade: { instante: u.bruto("faturamento"), pedido, fato: u.bruto("fato"), tipo: u.bruto("tipo"), descricao, valor, base, percentual: u.bruto("percentual"), saldo: u.bruto("saldo"), responsavel: u.bruto("responsavel") },
    };
  },
  fechar(registros) {
    const consolidado = consolidarConciliacaoIfood(registros);
    return { controles: { conciliacaoIfood: consolidado.resumo }, divergencias: consolidado.divergencias };
  },
});

const novoTotal = () => ({ pedidos: 0, pedidosCancelados: 0, itensCentavos: 0, entregaLojaCentavos: 0, promocaoLojaCentavos: 0, promocaoIfoodCentavos: 0, comissaoCentavos: 0, transacaoCentavos: 0, sobDemandaCentavos: 0, anunciosCentavos: 0, taxasDoClienteCentavos: 0, liquidoCentavos: 0 });
function acumular(alvo, parcela) { for (const k of Object.keys(alvo)) alvo[k] += parcela[k] ?? 0; return alvo; }

/** Consolida os movimentos por pedido, dia e repasse. Cada componente entra uma vez; a cesta, uma vez por pedido. */
export function consolidarConciliacaoIfood(registros, { conferirSaldos = true } = {}) {
  const divergencias = [];
  const pedidos = new Map();
  const dias = new Map();
  const repasses = new Map();
  const saldos = new Map();
  const total = novoTotal();
  const pedidosRecebidosDireto = new Set();
  let recebidoDiretoCentavos = 0;
  for (const r of registros) {
    const d = r.dados;
    if (d.componente === "NAO_RECONHECIDO") divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `Lançamento "${d.descricaoOriginal}" sem classificação definida.`, linha: r.linha });
    if (d.competenciaInformada !== r.competencia) divergencias.push({ codigo: DIVERGENCIA.PERIODO_DO_DOCUMENTO, mensagem: `Competência ${d.competenciaInformada} diferente da data do faturamento.`, linha: r.linha });
    // O saldo de um ciclo aberto cresce a cada exportação: fica fora da identidade do movimento e só confere dentro do arquivo.
    const informado = conferirSaldos ? centavos(r.original?.valor_transacao, "valor_transacao") : 0;
    const saldo = saldos.get(d.idSaldo) ?? { informado, soma: 0 };
    if (saldo.informado !== informado) divergencias.push({ codigo: DIVERGENCIA.TOTAL_NAO_CONFERE, mensagem: `Saldo ${d.idSaldo} com valores diferentes entre as linhas.`, linha: r.linha });
    if (d.impactaRepasse) saldo.soma += r.valorCentavos;
    saldos.set(d.idSaldo, saldo);
    const chaveRepasse = `${d.apuracaoInicio}|${d.apuracaoFim}|${d.repasseEsperado}`;
    const repasse = repasses.get(chaveRepasse) ?? { apuracaoInicio: d.apuracaoInicio, apuracaoFim: d.apuracaoFim, dataPrevista: d.repasseEsperado, previstoCentavos: 0, saldos: new Set(), situacao: "PREVISTO" };
    if (d.impactaRepasse) repasse.previstoCentavos += r.valorCentavos;
    repasse.saldos.add(d.idSaldo);
    repasses.set(chaveRepasse, repasse);
    if (d.componente === C.ENTRADA && !d.impactaRepasse) { recebidoDiretoCentavos += r.valorCentavos; pedidosRecebidosDireto.add(d.pedido); }
    if (!d.pedido) {
      const parcela = { anunciosCentavos: d.componente === C.ANUNCIOS ? r.valorCentavos : 0, liquidoCentavos: r.valorCentavos };
      acumular(total, parcela);
      const dia = r.data ?? r.dataReferencia; // na leitura do banco o campo se chama dataReferencia
      dias.set(dia, acumular(dias.get(dia) ?? novoTotal(), parcela));
      continue;
    }
    const p = pedidos.get(d.pedido) ?? { data: d.dataPedido, cestaCentavos: d.cestaCentavos, fatos: new Set(), entrada: 0, entradaParcial: 0, promoLoja: 0, promoIfood: 0, comissao: 0, transacao: 0, sobDemanda: 0, taxasCliente: 0 };
    if (p.cestaCentavos !== d.cestaCentavos) divergencias.push({ codigo: DIVERGENCIA.TOTAL_NAO_CONFERE, mensagem: "Pedido com valores de cesta diferentes entre as linhas.", linha: r.linha });
    p.fatos.add(rotulo(d.fatoGerador));
    const campo = { [C.ENTRADA]: "entrada", [C.PROMOCAO_LOJA]: "promoLoja", [C.PROMOCAO_IFOOD]: "promoIfood", [C.COMISSAO]: "comissao", [C.TRANSACAO]: "transacao", [C.ENTREGA_SOB_DEMANDA]: "sobDemanda", [C.TAXA_DO_CLIENTE]: "taxasCliente" }[d.componente];
    if (campo) p[campo] += r.valorCentavos;
    if (d.componente === C.ENTRADA && rotulo(d.fatoGerador) === "cancelamento parcial") p.entradaParcial += r.valorCentavos;
    pedidos.set(d.pedido, p);
  }
  if (conferirSaldos) for (const [id, s] of saldos) if (s.soma !== s.informado) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, `A soma das linhas do saldo ${id} não fecha com o valor informado pelo iFood.`, s.informado, s.soma));
  const situacoes = { VENDA: 0, CANCELADO_TOTAL: 0, CANCELADO_PARCIAL: 0 };
  let cestaInformadaCentavos = 0;
  const listaDePedidos = [];
  for (const [pedido, p] of pedidos) {
    const cancelado = p.fatos.has("cancelamento total");
    situacoes[cancelado ? "CANCELADO_TOTAL" : p.fatos.has("cancelamento parcial") ? "CANCELADO_PARCIAL" : "VENDA"] += 1;
    cestaInformadaCentavos += p.cestaCentavos;
    const itens = cancelado ? 0 : p.cestaCentavos + p.entradaParcial;
    // A entrega da loja não vem em coluna própria: é o que o cliente pagou além dos itens, das promoções e das taxas retidas.
    const entrega = cancelado ? 0 : p.entrada - itens - p.promoLoja + p.promoIfood + p.taxasCliente;
    if (entrega < 0) divergencias.push({ codigo: DIVERGENCIA.LINHA_NAO_FECHA, mensagem: "Pedido com composição negativa de entrega: conferir." });
    const parcela = {
      pedidos: 1, pedidosCancelados: cancelado ? 1 : 0, itensCentavos: itens, entregaLojaCentavos: entrega, promocaoLojaCentavos: p.promoLoja, promocaoIfoodCentavos: p.promoIfood,
      comissaoCentavos: p.comissao, transacaoCentavos: p.transacao, sobDemandaCentavos: p.sobDemanda, taxasDoClienteCentavos: p.taxasCliente,
      liquidoCentavos: itens + entrega + p.promoLoja + p.comissao + p.transacao + p.sobDemanda,
    };
    acumular(total, parcela);
    dias.set(p.data, acumular(dias.get(p.data) ?? novoTotal(), parcela));
    listaDePedidos.push({ pedido, data: p.data, cancelado, itensCentavos: itens });
  }
  const repassePrevistoCentavos = [...repasses.values()].reduce((s, r) => s + r.previstoCentavos, 0);
  if (total.liquidoCentavos !== repassePrevistoCentavos + recebidoDiretoCentavos) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "O líquido não fecha com repasse previsto + recebido direto.", repassePrevistoCentavos + recebidoDiretoCentavos, total.liquidoCentavos));
  return {
    divergencias,
    pedidos: listaDePedidos,
    resumo: {
      movimentos: registros.length, situacoes, cestaInformadaCentavos, total, recebidoDiretoCentavos, pedidosRecebidosDireto: pedidosRecebidosDireto.size, repassePrevistoCentavos, saldos: saldos.size,
      dias: [...dias.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([data, v]) => ({ data, ...v })),
      repasses: [...repasses.values()].sort((a, b) => a.dataPrevista.localeCompare(b.dataPrevista)).map((r) => ({ ...r, saldos: r.saldos.size })),
    },
  };
}
