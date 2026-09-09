// Regras PURAS (sem I/O) da camada de AJUSTES OPERACIONAIS do Parser Food
// Delivery — mesmo espírito de parserFoodDelivery.calc.js. Testável sem
// banco. Nunca lê/escreve: só compõe o "custo real com entregadores" a
// partir do resumo já calculado do iFood + a lista de lançamentos.
//
// REGRA DE OURO: `parser_fd_importacoes.taxas_validas` (o número do iFood)
// NUNCA é alterado aqui nem em lugar nenhum — a Central de Performance
// continua lendo o valor exclusivamente do iFood. O custo real é um
// NÚMERO NOVO, exposto só nas telas/endpoints do Parser.

import { chaveEntregador } from "./parserFoodDelivery.calc.js";

/**
 * Normalização ÚNICA de nome de entregador — a MESMA chave de agregação do
 * iFood (chaveEntregador). Usada tanto pelo cadastro mestre
 * (parserFoodDelivery.entregadores.js) quanto pela dedup do índice único
 * (unidade_id, nome_chave). Pura: sem I/O.
 * @param {unknown} nome
 * @returns {{ nome: string, chave: string }}
 */
export function normalizarNomeEntregador(nome) {
  const limpo = String(nome ?? "").trim().replace(/\s+/g, " ");
  return { nome: limpo, chave: chaveEntregador(limpo) };
}

export const ORIGEM_LANCAMENTO = {
  MANUAL: "manual",
  TAXA_ADICIONAL: "taxa_adicional",
  AVULSO: "avulso",
};

/** Rótulo em pt-BR de cada origem — usado em badges e na composição. */
export const ROTULO_ORIGEM = {
  ifood: "iFood",
  manual: "Manual",
  taxa_adicional: "Taxa adicional",
  avulso: "Avulso",
};

// Catálogo fechado de motivos — o frontend recebe estes valores por
// /catalogos e o backend valida contra eles. `outro` sempre exige
// `motivoDescricao` (validado no service).
export const MOTIVOS_TAXA_ADICIONAL = [
  { valor: "endereco_incorreto", rotulo: "Endereço incorreto" },
  { valor: "tentativa_entrega", rotulo: "Tentativa de entrega" },
  { valor: "cliente_ausente", rotulo: "Cliente ausente" },
  { valor: "reentrega", rotulo: "Reentrega" },
  { valor: "pedido_reatribuido", rotulo: "Pedido reatribuído" },
  { valor: "deslocamento_sem_conclusao", rotulo: "Deslocamento sem conclusão" },
  { valor: "retorno_a_loja", rotulo: "Retorno à loja" },
  { valor: "erro_operacional", rotulo: "Erro operacional" },
  { valor: "outro", rotulo: "Outro" },
];

export const MOTIVOS_AVULSO = [
  { valor: "buscar_paes", rotulo: "Buscar pães" },
  { valor: "buscar_insumos", rotulo: "Buscar insumos" },
  { valor: "buscar_mercadoria", rotulo: "Buscar mercadoria" },
  { valor: "transferencia_entre_unidades", rotulo: "Transferência entre unidades" },
  { valor: "entrega_particular", rotulo: "Entrega particular" },
  { valor: "documentos", rotulo: "Documentos" },
  { valor: "servico_operacional", rotulo: "Serviço operacional" },
  { valor: "outro", rotulo: "Outro" },
];

// Motivo default de uma entrega manual comum (item 5 do pedido) — não é um
// "erro", é só a marca de que a linha foi incluída à mão.
export const MOTIVO_MANUAL_PADRAO = "inclusao_manual";

const CATALOGO_POR_ORIGEM = {
  [ORIGEM_LANCAMENTO.TAXA_ADICIONAL]: MOTIVOS_TAXA_ADICIONAL,
  [ORIGEM_LANCAMENTO.AVULSO]: MOTIVOS_AVULSO,
};

/** Motivo é obrigatório e do catálogo para taxa_adicional e avulso; opcional (livre/padrão) para manual. */
export function motivoObrigatorio(origem) {
  return origem === ORIGEM_LANCAMENTO.TAXA_ADICIONAL || origem === ORIGEM_LANCAMENTO.AVULSO;
}

/** @returns {boolean} true se `motivo` é aceito para `origem`. */
export function motivoValido(origem, motivo) {
  const catalogo = CATALOGO_POR_ORIGEM[origem];
  if (!catalogo) return true; // manual: qualquer chave (o service normaliza ausência p/ MOTIVO_MANUAL_PADRAO)
  return catalogo.some((m) => m.valor === motivo);
}

export function rotuloMotivo(origem, motivo) {
  if (motivo === MOTIVO_MANUAL_PADRAO) return "Inclusão manual";
  const catalogo = CATALOGO_POR_ORIGEM[origem] || [];
  return catalogo.find((m) => m.valor === motivo)?.rotulo || motivo || "—";
}

const arredondar = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Um lançamento manual só entra no custo quando REPRESENTA um pagamento:
 * classificacao 'nao_recebe_taxa' zera a contribuição (mesma semântica de
 * um cancelado sem taxa no iFood). taxa_adicional e avulso sempre entram.
 */
export function lancamentoEntraNoCusto(l) {
  if (l.excluido) return false;
  if (l.origem === ORIGEM_LANCAMENTO.MANUAL && l.classificacao === "nao_recebe_taxa") return false;
  return true;
}

/**
 * Compõe o CUSTO REAL COM ENTREGADORES do período/importação, mantendo a
 * separação por origem (item 10 do pedido).
 * @param {{ taxasIfood?: number|null, lancamentos?: Array<object> }} p
 *   `lancamentos` já no formato da API (ver paraApiLancamento no service).
 * @returns {{
 *   ifood:number, taxasAdicionais:number, manuais:number, avulsos:number,
 *   total:number, ajustesManuais:number,
 *   porOrigem: Array<{origem:string, rotulo:string, valor:number, qtd:number}>,
 *   porMotivo: Array<{origem:string, motivo:string, rotulo:string, valor:number, qtd:number}>,
 *   qtdPedidosComTaxaAdicional:number, valorMedioTaxaAdicional:number|null,
 *   topEntregadoresExtras: Array<{entregador:string, valor:number, qtd:number}>
 * }}
 */
export function comporCustoReal({ taxasIfood = 0, lancamentos = [] } = {}) {
  const ativos = (lancamentos || []).filter((l) => !l.excluido);
  const soma = (pred) => arredondar(ativos.filter(pred).reduce((s, l) => s + (lancamentoEntraNoCusto(l) ? Number(l.valor) || 0 : 0), 0));

  const ifood = arredondar(taxasIfood || 0);
  const taxasAdicionais = soma((l) => l.origem === ORIGEM_LANCAMENTO.TAXA_ADICIONAL);
  const manuais = soma((l) => l.origem === ORIGEM_LANCAMENTO.MANUAL);
  const avulsos = soma((l) => l.origem === ORIGEM_LANCAMENTO.AVULSO);
  const ajustesManuais = arredondar(taxasAdicionais + manuais + avulsos);
  const total = arredondar(ifood + ajustesManuais);

  const porOrigem = [
    { origem: "ifood", rotulo: ROTULO_ORIGEM.ifood, valor: ifood, qtd: null },
    { origem: "taxa_adicional", rotulo: ROTULO_ORIGEM.taxa_adicional, valor: taxasAdicionais, qtd: ativos.filter((l) => l.origem === "taxa_adicional").length },
    { origem: "manual", rotulo: ROTULO_ORIGEM.manual, valor: manuais, qtd: ativos.filter((l) => l.origem === "manual").length },
    { origem: "avulso", rotulo: ROTULO_ORIGEM.avulso, valor: avulsos, qtd: ativos.filter((l) => l.origem === "avulso").length },
  ];

  const motivoMap = new Map();
  for (const l of ativos) {
    if (!lancamentoEntraNoCusto(l)) continue;
    const chave = `${l.origem}|${l.motivo || "—"}`;
    const item = motivoMap.get(chave) || { origem: l.origem, motivo: l.motivo || "—", rotulo: rotuloMotivo(l.origem, l.motivo), valor: 0, qtd: 0 };
    item.valor = arredondar(item.valor + (Number(l.valor) || 0));
    item.qtd += 1;
    motivoMap.set(chave, item);
  }

  const extras = ativos.filter((l) => l.origem === ORIGEM_LANCAMENTO.TAXA_ADICIONAL);
  const pedidosComExtra = new Set(extras.map((l) => l.numeroPedido).filter(Boolean));
  const valorExtraTotal = extras.reduce((s, l) => s + (Number(l.valor) || 0), 0);

  const porEntregadorExtra = new Map();
  for (const l of ativos) {
    if (l.origem === ORIGEM_LANCAMENTO.MANUAL && l.classificacao === "nao_recebe_taxa") continue;
    const nome = (l.entregadorNome || l.entregadorNomeSnapshot || "—").trim();
    const item = porEntregadorExtra.get(nome) || { entregador: nome, valor: 0, qtd: 0 };
    item.valor = arredondar(item.valor + (Number(l.valor) || 0));
    item.qtd += 1;
    porEntregadorExtra.set(nome, item);
  }

  return {
    ifood, taxasAdicionais, manuais, avulsos, total, ajustesManuais,
    porOrigem,
    porMotivo: [...motivoMap.values()].sort((a, b) => b.valor - a.valor),
    qtdPedidosComTaxaAdicional: pedidosComExtra.size,
    valorMedioTaxaAdicional: extras.length ? arredondar(valorExtraTotal / extras.length) : null,
    topEntregadoresExtras: [...porEntregadorExtra.values()].sort((a, b) => b.valor - a.valor).slice(0, 5),
  };
}

/**
 * Funde o ranking de entregadores do iFood (agruparPorEntregador) com os
 * lançamentos — soma as taxas por origem no card de cada entregador e cria
 * uma entrada nova para quem só aparece em lançamentos. Casamento por nome
 * NORMALIZADO (mesma `chaveEntregador` do iFood) OU por `entregadorId`.
 * @param {Array<object>} entregadoresIfood saída de agruparPorEntregador (+ campo `chave`)
 * @param {Array<object>} lancamentos formato da API
 * @returns {Array<object>} cada item ganha `taxasAdicionais/manuais/avulsos/custoTotal/somenteLancamentos`
 */
export function mesclarEntregadores(entregadoresIfood = [], lancamentos = []) {
  const porChave = new Map();
  for (const e of entregadoresIfood || []) {
    porChave.set(e.chave || chaveEntregador(e.entregador), {
      ...e, taxasAdicionais: 0, manuais: 0, avulsos: 0,
      custoTotal: arredondar(e.taxasValidas), somenteLancamentos: false,
    });
  }
  for (const l of lancamentos || []) {
    if (l.excluido) continue;
    const nome = (l.entregadorNome || l.entregadorNomeSnapshot || "").trim();
    const chave = l.entregadorChave || chaveEntregador(nome);
    if (!chave) continue;
    let alvo = porChave.get(chave);
    if (!alvo) {
      alvo = {
        entregador: nome || "—", chave, entregadorId: l.entregadorId || null,
        totalPedidos: 0, entregues: 0, canceladosComTaxa: 0, canceladosSemTaxa: 0, canceladosRevisao: 0,
        taxasValidas: 0, taxasAdicionais: 0, manuais: 0, avulsos: 0, custoTotal: 0, somenteLancamentos: true,
      };
      porChave.set(chave, alvo);
    }
    const contribui = lancamentoEntraNoCusto(l) ? Number(l.valor) || 0 : 0;
    if (l.origem === ORIGEM_LANCAMENTO.TAXA_ADICIONAL) alvo.taxasAdicionais = arredondar(alvo.taxasAdicionais + contribui);
    else if (l.origem === ORIGEM_LANCAMENTO.MANUAL) alvo.manuais = arredondar(alvo.manuais + contribui);
    else if (l.origem === ORIGEM_LANCAMENTO.AVULSO) alvo.avulsos = arredondar(alvo.avulsos + contribui);
    alvo.custoTotal = arredondar(alvo.custoTotal + contribui);
  }
  return [...porChave.values()];
}
