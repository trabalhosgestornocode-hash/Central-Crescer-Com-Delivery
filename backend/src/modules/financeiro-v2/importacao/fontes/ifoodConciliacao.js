// IFOOD — Relatório de Conciliação Financeira oficial (layout real: uma linha por MOVIMENTO, não por venda).
// Um pedido tem várias linhas; a cesta se repete em todas e entra UMA vez. Linhas idênticas são movimentos distintos
// (o saldo do iFood só fecha com todas elas): o motor as mantém separadas pelo número de ocorrência.
// Ler não lança nada. Data prevista de repasse é previsão: só o extrato bancário confirma o recebimento.
import { ehData } from "../../dominio/tempo.js";
import { centavos, rotulo } from "../leitor.js";
import { DIVERGENCIA, diferenca } from "../motor.js";
import { classificarPorPalavras, col, definirFonte } from "./comum.js";

export const COMPONENTE_CONCILIACAO = Object.freeze({
  ENTRADA: "ENTRADA", PROMOCAO_LOJA: "PROMOCAO_LOJA", PROMOCAO_IFOOD: "PROMOCAO_IFOOD", PROMOCAO_REDE: "PROMOCAO_REDE", COMISSAO: "COMISSAO", TRANSACAO: "TRANSACAO",
  TAXA_DO_CLIENTE: "TAXA_DO_CLIENTE", ENTREGA_SOB_DEMANDA: "ENTREGA_SOB_DEMANDA", ANUNCIOS: "ANUNCIOS",
});
const C = COMPONENTE_CONCILIACAO;

const componenteDe = (descricao) => classificarPorPalavras(descricao, [
  [C.ENTRADA, [/^entrada financeira$/]],
  [C.PROMOCAO_LOJA, ["custeada pela loja"]],
  [C.PROMOCAO_IFOOD, ["custeada pelo ifood"]],
  // Subsídio da REDE (franqueadora) ao preço do pedido: paga parte da cesta que o cliente não pagou. Como a promoção do iFood,
  // compõe a cesta (já no faturamento) e não é receita adicional — contá-lo de novo duplicaria o faturamento. Fica visível à parte.
  [C.PROMOCAO_REDE, ["custeada pela rede"]],
  [C.COMISSAO, ["comissao do ifood"]],
  [C.TRANSACAO, ["taxa de transacao"]],
  // Pagas pelo cliente, embutidas na Entrada Financeira e retidas pelo iFood: não são receita nem despesa da loja.
  [C.TAXA_DO_CLIENTE, ["taxa de servico ifood cobrada do cliente", "taxa de conveniencia por pagamento parcelado", "taxa entrega ifood"]],
  [C.ENTREGA_SOB_DEMANDA, ["entrega sob demanda"]],
  [C.ANUNCIOS, ["pacote de anuncios"]],
]);

/** Centavos → "R$ 1.234,56" (só para mensagens). */
const reais = (c) => {
  const d = String(c < 0 ? -c : c).padStart(3, "0"); // centavos inteiros, só texto
  const inteiro = d.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${c < 0 ? "−" : ""}R$ ${inteiro},${d.slice(-2)}`;
};
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

const novoTotal = () => ({ pedidos: 0, pedidosCancelados: 0, movimentos: 0, itensCentavos: 0, entregaLojaCentavos: 0, promocaoLojaCentavos: 0, promocaoIfoodCentavos: 0, promocaoRedeCentavos: 0, comissaoCentavos: 0, transacaoCentavos: 0, sobDemandaCentavos: 0, anunciosCentavos: 0, taxasDoClienteCentavos: 0, classificadosCentavos: 0, semClassificacaoCentavos: 0, liquidoCentavos: 0 });
function acumular(alvo, parcela) { for (const k of Object.keys(alvo)) alvo[k] += parcela[k] ?? 0; return alvo; }

/** Chaves das decisões de classificação: uma por descrição desconhecida e uma por pedido sem a venda original. */
export const chaveDeDescricao = (descricao) => `descricao:${rotulo(descricao)}`;
export const chaveDePedidoSemVenda = (pedido) => `pedido-sem-venda:${pedido}`;
/** O leitor aceita variações do cabeçalho; a cópia da linha guarda o rótulo exatamente como veio no arquivo. */
function valorDoSaldo(r) {
  const coluna = Object.keys(r.original ?? {}).find((k) => rotulo(k) === "valor transacao");
  return centavos(r.original?.[coluna], "valor_transacao");
}
const CAMPO_SEM_PEDIDO = Object.freeze({ [C.COMISSAO]: "comissaoCentavos", [C.TRANSACAO]: "transacaoCentavos", [C.ENTREGA_SOB_DEMANDA]: "sobDemandaCentavos", [C.ANUNCIOS]: "anunciosCentavos" });
const CAMPO_DO_PEDIDO = Object.freeze({ [C.ENTRADA]: "entrada", [C.PROMOCAO_LOJA]: "promoLoja", [C.PROMOCAO_IFOOD]: "promoIfood", [C.PROMOCAO_REDE]: "promoRede", [C.COMISSAO]: "comissao", [C.TRANSACAO]: "transacao", [C.ENTREGA_SOB_DEMANDA]: "sobDemanda", [C.ANUNCIOS]: "anuncios", [C.TAXA_DO_CLIENTE]: "taxasCliente" });

/**
 * Consolida os movimentos por pedido, dia e repasse. Cada componente entra uma vez; a cesta, uma vez por pedido.
 * Pedido sem a linha de venda nos movimentos recebidos não gera receita: o valor fica pendente até a venda original ser
 * importada ou até uma decisão autorizada. Lançamento desconhecido nunca some: fica pendente, com o valor, até ser classificado.
 * @param {object} [o]
 * @param {boolean} [o.conferirSaldos] confere o saldo informado (só faz sentido dentro de um único arquivo)
 * @param {Map<string,string>} [o.classificacoes] chave da pendência → código da categoria decidida
 */
export function consolidarConciliacaoIfood(registros, { conferirSaldos = true, classificacoes = new Map() } = {}) {
  const divergencias = [];
  const pedidos = new Map();
  const dias = new Map();
  const classificadosDoDia = new Map();
  const ciclosDoDia = new Map();
  const pendentes = new Map();
  const repasses = new Map();
  const saldos = new Map();
  const total = novoTotal();
  const pedidosRecebidosDireto = new Set();
  let recebidoDiretoCentavos = 0;
  let foraDoRepasseCentavos = 0;
  const noDia = (dia, parcela) => { acumular(total, parcela); dias.set(dia, acumular(dias.get(dia) ?? novoTotal(), parcela)); };
  const anotarCiclos = (dia, ciclos) => { const s = ciclosDoDia.get(dia) ?? new Set(); for (const c of ciclos) s.add(c); ciclosDoDia.set(dia, s); };
  /** Valor sem regra própria: entra no líquido e vai para a categoria decidida ou para a lista de pendências. */
  function alocar(dia, { chave, tipo, descricao, valor, movimentos = 0 }) {
    const categoria = classificacoes.get(chave);
    if (categoria) {
      const doDia = classificadosDoDia.get(dia) ?? {};
      doDia[categoria] = (doDia[categoria] ?? 0) + valor;
      classificadosDoDia.set(dia, doDia);
    } else {
      const p = pendentes.get(chave) ?? { chave, tipo, descricao, quantidade: 0, valorCentavos: 0 };
      p.quantidade += 1; p.valorCentavos += valor;
      pendentes.set(chave, p);
    }
    noDia(dia, { movimentos, liquidoCentavos: valor, [categoria ? "classificadosCentavos" : "semClassificacaoCentavos"]: valor });
  }
  for (const r of registros) {
    const d = r.dados;
    const dataDaLinha = r.data ?? r.dataReferencia; // na leitura do banco o campo se chama dataReferencia
    if (d.componente === "NAO_RECONHECIDO" && !classificacoes.has(chaveDeDescricao(d.descricaoOriginal))) divergencias.push({ codigo: DIVERGENCIA.VALOR_A_CLASSIFICAR, mensagem: `Lançamento "${d.descricaoOriginal}" sem classificação definida.`, linha: r.linha });
    if (d.competenciaInformada !== r.competencia) divergencias.push({ codigo: DIVERGENCIA.PERIODO_DO_DOCUMENTO, mensagem: `Competência ${d.competenciaInformada} diferente da data do faturamento.`, linha: r.linha });
    // O saldo de um ciclo aberto cresce a cada exportação: fica fora da identidade do movimento e só confere dentro do arquivo.
    const informado = conferirSaldos ? valorDoSaldo(r) : 0;
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
    const semRegra = !CAMPO_DO_PEDIDO[d.componente];
    if (semRegra && !d.impactaRepasse) foraDoRepasseCentavos += r.valorCentavos;
    if (!d.pedido) {
      anotarCiclos(dataDaLinha, [chaveRepasse]);
      const campo = CAMPO_SEM_PEDIDO[d.componente];
      if (campo) noDia(dataDaLinha, { movimentos: 1, [campo]: r.valorCentavos, liquidoCentavos: r.valorCentavos });
      else {
        if (!semRegra && !d.impactaRepasse && d.componente !== C.ENTRADA) foraDoRepasseCentavos += r.valorCentavos;
        alocar(dataDaLinha, { chave: chaveDeDescricao(d.descricaoOriginal), tipo: "LANCAMENTO_DESCONHECIDO", descricao: d.descricaoOriginal, valor: r.valorCentavos, movimentos: 1 });
      }
      continue;
    }
    const p = pedidos.get(d.pedido) ?? { curto: d.pedidoCurto, data: d.dataPedido, ultimoMovimento: dataDaLinha, cestaCentavos: d.cestaCentavos, fatos: new Set(), ciclos: new Set(), desconhecidos: [], movimentos: 0, entrada: 0, entradaParcial: 0, promoLoja: 0, promoIfood: 0, comissao: 0, transacao: 0, sobDemanda: 0, anuncios: 0, taxasCliente: 0 };
    if (p.cestaCentavos !== d.cestaCentavos) divergencias.push({ codigo: DIVERGENCIA.TOTAL_NAO_CONFERE, mensagem: "Pedido com valores de cesta diferentes entre as linhas.", linha: r.linha });
    if (dataDaLinha > p.ultimoMovimento) p.ultimoMovimento = dataDaLinha;
    p.movimentos += 1;
    p.fatos.add(rotulo(d.fatoGerador));
    p.ciclos.add(chaveRepasse);
    const campo = CAMPO_DO_PEDIDO[d.componente];
    if (campo) p[campo] = (p[campo] ?? 0) + r.valorCentavos;
    else p.desconhecidos.push({ chave: chaveDeDescricao(d.descricaoOriginal), tipo: "LANCAMENTO_DESCONHECIDO", descricao: d.descricaoOriginal, valor: r.valorCentavos });
    if (d.componente === C.ENTRADA && rotulo(d.fatoGerador) === "cancelamento parcial") p.entradaParcial += r.valorCentavos;
    pedidos.set(d.pedido, p);
  }
  if (conferirSaldos) for (const [id, s] of saldos) if (s.soma !== s.informado) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, `A soma das linhas do saldo ${id} não fecha com o valor informado pelo iFood.`, s.informado, s.soma));
  const situacoes = { VENDA: 0, CANCELADO_TOTAL: 0, CANCELADO_PARCIAL: 0, SEM_VENDA_ORIGINAL: 0 };
  let cestaInformadaCentavos = 0;
  const listaDePedidos = [];
  for (const [pedido, p] of pedidos) {
    const temVenda = p.fatos.has("venda");
    const cancelado = p.fatos.has("cancelamento total");
    const promoRede = p.promoRede ?? 0;
    const financeiro = p.entrada + p.promoIfood + promoRede + p.taxasCliente + p.comissao + p.transacao;
    const dia = temVenda ? p.data : p.ultimoMovimento;
    anotarCiclos(dia, p.ciclos);
    for (const x of p.desconhecidos) alocar(dia, x);
    if (!temVenda) {
      situacoes.SEM_VENDA_ORIGINAL += 1;
      if (financeiro) alocar(dia, { chave: chaveDePedidoSemVenda(pedido), tipo: "PEDIDO_SEM_VENDA_ORIGINAL", descricao: `Pedido ${p.curto ?? pedido} sem a venda original nos relatórios importados`, valor: financeiro });
      noDia(dia, { movimentos: p.movimentos, sobDemandaCentavos: p.sobDemanda, anunciosCentavos: p.anuncios, liquidoCentavos: p.sobDemanda + p.anuncios });
      listaDePedidos.push({ pedido, data: dia, cancelado, semVenda: true, itensCentavos: 0 });
      continue;
    }
    situacoes[cancelado ? "CANCELADO_TOTAL" : p.fatos.has("cancelamento parcial") ? "CANCELADO_PARCIAL" : "VENDA"] += 1;
    cestaInformadaCentavos += p.cestaCentavos;
    if (cancelado && financeiro) divergencias.push({ codigo: DIVERGENCIA.LINHA_NAO_FECHA, mensagem: `Pedido ${p.curto ?? pedido} cancelado com saldo restante: conferir antes de aplicar.` });
    const itens = cancelado ? 0 : p.cestaCentavos + p.entradaParcial;
    // A entrega da loja não vem em coluna própria: é o que o cliente pagou além dos itens, das promoções e das taxas retidas.
    const entrega = cancelado ? 0 : p.entrada - itens - p.promoLoja + p.promoIfood + promoRede + p.taxasCliente;
    // A mensagem identifica o pedido e a composição (só leitura): sem isso não há como auditar a divergência. Nenhum cálculo muda.
    if (entrega < 0) divergencias.push({ codigo: DIVERGENCIA.LINHA_NAO_FECHA, mensagem: `Pedido ${p.curto ?? pedido} com composição negativa de entrega: entrada ${reais(p.entrada)} − itens ${reais(itens)} − promoção da loja ${reais(p.promoLoja)} + promoção do iFood ${reais(p.promoIfood)} + subsídio da rede ${reais(promoRede)} + taxas do cliente ${reais(p.taxasCliente)} = ${reais(entrega)}. Conferir.`, pedido: p.curto ?? pedido });
    noDia(dia, {
      pedidos: 1, pedidosCancelados: cancelado ? 1 : 0, movimentos: p.movimentos, itensCentavos: itens, entregaLojaCentavos: entrega, promocaoLojaCentavos: cancelado ? 0 : p.promoLoja, promocaoIfoodCentavos: p.promoIfood, promocaoRedeCentavos: promoRede,
      comissaoCentavos: cancelado ? 0 : p.comissao, transacaoCentavos: cancelado ? 0 : p.transacao, sobDemandaCentavos: p.sobDemanda, anunciosCentavos: p.anuncios, taxasDoClienteCentavos: p.taxasCliente,
      liquidoCentavos: (cancelado ? financeiro : itens + entrega + p.promoLoja + p.comissao + p.transacao) + p.sobDemanda + p.anuncios,
    });
    listaDePedidos.push({ pedido, data: dia, cancelado, semVenda: false, itensCentavos: itens });
  }
  const repassePrevistoCentavos = [...repasses.values()].reduce((s, r) => s + r.previstoCentavos, 0);
  const esperado = repassePrevistoCentavos + recebidoDiretoCentavos + foraDoRepasseCentavos;
  if (total.liquidoCentavos !== esperado) divergencias.push(diferenca(DIVERGENCIA.TOTAL_NAO_CONFERE, "O líquido não fecha com repasse previsto + recebido direto.", esperado, total.liquidoCentavos));
  return {
    divergencias,
    pedidos: listaDePedidos,
    resumo: {
      movimentos: registros.length, situacoes, cestaInformadaCentavos, total, recebidoDiretoCentavos, pedidosRecebidosDireto: pedidosRecebidosDireto.size, repassePrevistoCentavos, saldos: saldos.size,
      pendenciasDeClassificacao: [...pendentes.values()].filter((p) => p.valorCentavos !== 0).sort((a, x) => a.chave.localeCompare(x.chave)),
      dias: [...dias.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([data, v]) => ({ data, ...v, classificados: classificadosDoDia.get(data) ?? {}, ciclos: [...(ciclosDoDia.get(data) ?? [])].sort() })),
      repasses: [...repasses.values()].sort((a, b) => a.dataPrevista.localeCompare(b.dataPrevista)).map((r) => ({ ...r, saldos: r.saldos.size })),
    },
  };
}
