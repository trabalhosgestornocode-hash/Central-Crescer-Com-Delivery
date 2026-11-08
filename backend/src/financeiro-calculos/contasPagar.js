// Contas a pagar (Financeiro 2.0) — regras PURAS, sem banco. Dinheiro em CENTAVOS inteiros; percentuais em pontos-base (1% = 100 bps).
// Espelha as regras que o banco impõe na migration 151 (o banco é a autoridade; aqui só se calcula para exibir e sugerir).
//
// Regra central (evita juros falsos): a diferença é Σ pagamentos ATIVOS − valor original, e SÓ existe quando a obrigação está QUITADA.
//   > 0 → "juros/acréscimo presumido" até alguém classificar (juros | multa | tarifa | outro);
//   < 0 → "a verificar" até alguém classificar como desconto (pagamento parcial NUNCA vira desconto sozinho);
//   obrigação aberta com pagamento → é parcial (saldo em aberto), não tem diferença.
import { razaoEmBps, somar } from "./dinheiro.js";

/** Tolerâncias aprovadas (decisão 6). As mesmas da SQL (fin2_tolerancia_centavos/dias). */
export const TOLERANCIA = Object.freeze({ centavos: 1, dias: 1 });

export const NATUREZAS_ACRESCIMO = Object.freeze(["juros", "multa", "tarifa", "outro"]);

const ativos = (pags) => (pags ?? []).filter((p) => (p.status ?? "ativo") === "ativo");
const n = (v) => Number(v);

/** Dias corridos entre duas datas ISO (b − a). */
export function diasEntre(a, b) {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 864e5);
}

export function ultimoPagamento(pags) {
  const d = ativos(pags).map((p) => p.data_pagamento).sort();
  return d.length ? d[d.length - 1] : null;
}

/**
 * @param {{valor_original_centavos:number|string, status:string, classificacao_diferenca?:string|null}} obr
 * @param {Array<{valor_centavos:number|string, status?:string, data_pagamento:string}>} pags
 */
export function diferenca(obr, pags) {
  const orig = n(obr.valor_original_centavos);
  const pago = somar(ativos(pags).map((p) => n(p.valor_centavos)));
  const saldoAberto = obr.status === "aberta" ? Math.max(0, orig - pago) : 0;
  if (obr.status !== "quitada") return { pagoCentavos: pago, saldoAbertoCentavos: saldoAberto, diferencaCentavos: null, percentualBps: null, natureza: null };
  const dif = pago - orig;
  let natureza = null;
  if (dif > 0) natureza = obr.classificacao_diferenca && NATUREZAS_ACRESCIMO.includes(obr.classificacao_diferenca) ? obr.classificacao_diferenca : "presumido";
  else if (dif < 0) natureza = obr.classificacao_diferenca === "desconto" ? "desconto" : "a_verificar";
  return { pagoCentavos: pago, saldoAbertoCentavos: 0, diferencaCentavos: dif, percentualBps: dif === 0 ? 0 : razaoEmBps(dif, orig), natureza };
}

/** Situação na data-base (AAAA-MM-DD). */
export function situacao(obr, pags, dataBase) {
  if (obr.status === "cancelada") return "cancelada";
  const d = diferenca(obr, pags);
  if (obr.status === "quitada") return d.diferencaCentavos > 0 ? "paga_com_acrescimo" : d.diferencaCentavos < 0 ? "paga_a_menor" : "paga";
  const vencida = obr.vencimento < dataBase;
  if (d.pagoCentavos > 0) return d.pagoCentavos >= n(obr.valor_original_centavos) ? "quitacao_pendente" : vencida ? "parcial_vencida" : "parcial";
  return vencida ? "vencida" : "a_vencer";
}

/** Dias de atraso: quitada → último pagamento − vencimento; aberta e vencida → data-base − vencimento. Nunca negativo. */
export function diasAtraso(obr, pags, dataBase) {
  if (obr.status === "cancelada") return 0;
  const ref = obr.status === "quitada" ? (obr.data_quitacao ?? ultimoPagamento(pags)) : dataBase;
  return ref ? Math.max(0, diasEntre(obr.vencimento, ref)) : 0;
}

/**
 * Painel de juros e encargos (contas a pagar). Considera só obrigações QUITADAS com acréscimo (diferença > 0).
 * Juros de EMPRÉSTIMO não passam por aqui (outra natureza; outro módulo).
 * @param {Array<{obrigacao:object, pagamentos:object[], fornecedor?:string, categoria?:string}>} itens
 */
export function painelJuros(itens) {
  const tot = { presumido: 0, juros: 0, multa: 0, tarifa: 0, outro: 0 };
  const porFornecedor = new Map(), porCategoria = new Map(), porMes = new Map();
  const linhas = [];
  let comAtraso = 0;
  for (const { obrigacao: o, pagamentos: p, fornecedor, categoria } of itens) {
    const d = diferenca(o, p);
    if (!(d.diferencaCentavos > 0)) continue;
    tot[d.natureza] += d.diferencaCentavos;
    const atraso = diasAtraso(o, p);
    if (atraso > 0) comAtraso += 1;
    const mes = (o.data_quitacao ?? ultimoPagamento(p)).slice(0, 7);
    for (const [mapa, chave] of [[porFornecedor, fornecedor ?? "—"], [porCategoria, categoria ?? "—"], [porMes, mes]]) mapa.set(chave, (mapa.get(chave) ?? 0) + d.diferencaCentavos);
    linhas.push({ obrigacaoId: o.id, fornecedor: fornecedor ?? null, categoria: categoria ?? null, vencimento: o.vencimento, dataQuitacao: o.data_quitacao ?? null, diasAtraso: atraso,
      valorOriginalCentavos: n(o.valor_original_centavos), pagoCentavos: d.pagoCentavos, acrescimoCentavos: d.diferencaCentavos, percentualBps: d.percentualBps, natureza: d.natureza });
  }
  const ord = (m) => [...m.entries()].map(([chave, centavos]) => ({ chave, centavos })).sort((a, b) => b.centavos - a.centavos || String(a.chave).localeCompare(String(b.chave)));
  const confirmados = tot.juros + tot.multa + tot.tarifa + tot.outro;
  return {
    totais: { presumidoCentavos: tot.presumido, jurosCentavos: tot.juros, multaCentavos: tot.multa, tarifaCentavos: tot.tarifa, outroCentavos: tot.outro, confirmadoCentavos: confirmados, totalCentavos: confirmados + tot.presumido },
    porFornecedor: ord(porFornecedor), porCategoria: ord(porCategoria), porMes: ord(porMes).sort((a, b) => a.chave.localeCompare(b.chave)),
    contasPagasComAtraso: comAtraso, linhas: linhas.sort((a, b) => b.acrescimoCentavos - a.acrescimoCentavos),
  };
}

/** Combinações de k elementos (k pequeno; a lista é limitada pelo chamador). */
function* combinacoes(lista, k, inicio = 0, atual = []) {
  if (atual.length === k) { yield atual; return; }
  for (let i = inicio; i <= lista.length - (k - atual.length); i++) yield* combinacoes(lista, k, i + 1, [...atual, lista[i]]);
}

/**
 * Sugestões de vínculo pagamento ⇄ saída do extrato. CONSERVADOR: só sugere quando o par (ou o grupo) é ÚNICO; ambiguidade não vira
 * sugestão (fica para vínculo manual). Nada aqui confirma nada: toda sugestão nasce "sugerido" e depende de confirmação humana.
 * @param {{pagamentos:Array<{id,conta_id,data_pagamento,valor_centavos}>, saidas:Array<{id,conta_id,data_movimento,valor_centavos}>, tolerancia?:{centavos:number,dias:number}, maxGrupo?:number}} p
 */
export function sugerirVinculos({ pagamentos, saidas, tolerancia = TOLERANCIA, maxGrupo = 3 }) {
  const tolC = tolerancia.centavos, tolD = tolerancia.dias;
  const perto = (pg, s) => pg.conta_id === s.conta_id && Math.abs(diasEntre(s.data_movimento, pg.data_pagamento)) <= tolD;
  const cand = (pg, s) => perto(pg, s) && Math.abs(n(s.valor_centavos) - n(pg.valor_centavos)) <= tolC;
  const sugestoes = [], ambiguos = [];
  const usadosP = new Set(), usadosS = new Set();
  // 1:1
  for (const s of saidas) {
    const cs = pagamentos.filter((pg) => cand(pg, s));
    if (cs.length !== 1) { if (cs.length > 1) ambiguos.push({ lancamentoId: s.id, motivo: "mais_de_um_pagamento_compativel", candidatos: cs.map((x) => x.id) }); continue; }
    const pg = cs[0];
    const outras = saidas.filter((x) => cand(pg, x));
    if (outras.length !== 1) { ambiguos.push({ pagamentoId: pg.id, motivo: "mais_de_uma_saida_compativel", candidatos: outras.map((x) => x.id) }); continue; }
    const dif = n(s.valor_centavos) - n(pg.valor_centavos), dias = Math.abs(diasEntre(s.data_movimento, pg.data_pagamento));
    sugestoes.push({ regra: dif === 0 && dias === 0 ? "exato" : "data_proxima", lancamentoId: s.id, pagamentoIds: [pg.id], alocacoes: [{ pagamentoId: pg.id, valorCentavos: n(pg.valor_centavos) }], diferencaCentavos: dif, diasDiferenca: dias });
    usadosP.add(pg.id); usadosS.add(s.id);
  }
  // agrupado: 1 saída ⇄ 2..maxGrupo pagamentos da MESMA conta, todos dentro da janela de datas, soma dentro da tolerância
  for (const s of saidas) {
    if (usadosS.has(s.id) || ambiguos.some((a) => a.lancamentoId === s.id)) continue;
    const livres = pagamentos.filter((pg) => !usadosP.has(pg.id) && perto(pg, s) && n(pg.valor_centavos) < n(s.valor_centavos) + tolC).slice(0, 12);
    const achados = [];
    for (let k = 2; k <= Math.min(maxGrupo, livres.length); k++) {
      for (const g of combinacoes(livres, k)) if (Math.abs(n(s.valor_centavos) - somar(g.map((x) => n(x.valor_centavos)))) <= tolC) achados.push(g);
    }
    if (achados.length === 1) {
      const g = achados[0]; const soma = somar(g.map((x) => n(x.valor_centavos)));
      sugestoes.push({ regra: "agrupado", lancamentoId: s.id, pagamentoIds: g.map((x) => x.id), alocacoes: g.map((x) => ({ pagamentoId: x.id, valorCentavos: n(x.valor_centavos) })),
        diferencaCentavos: n(s.valor_centavos) - soma, diasDiferenca: Math.max(...g.map((x) => Math.abs(diasEntre(s.data_movimento, x.data_pagamento)))) });
      g.forEach((x) => usadosP.add(x.id)); usadosS.add(s.id);
    } else if (achados.length > 1) ambiguos.push({ lancamentoId: s.id, motivo: "mais_de_um_grupo_compativel", candidatos: achados.map((g) => g.map((x) => x.id)) });
  }
  return { sugestoes, ambiguos };
}

/** Dentro da tolerância? (decide se a confirmação exige justificativa — a mesma regra que o banco aplica). */
export const dentroDaTolerancia = (difCentavos, dias, tol = TOLERANCIA) => Math.abs(difCentavos) <= tol.centavos && Math.abs(dias) <= tol.dias;

// ---------------------------------------------------------------- acréscimos por COMPETÊNCIA × pagos no PERÍODO
/**
 * Acréscimo presumido de UMA obrigação = max(0, Σ pagamentos ativos − valor original), considerando TODOS os pagamentos vinculados.
 * O excesso é atribuído ao(s) pagamento(s) que ultrapassam o original, em ordem de data (o pagamento que "cruza" o original e os seguintes),
 * para saber em que MÊS o acréscimo foi pago. Pagamento parcial (soma < original) NUNCA vira desconto nem acréscimo: é saldo em aberto.
 * `quitada` informa a situação da obrigação (acréscimo em obrigação ainda aberta é presumido e fica sinalizado).
 */
export function acrescimoDaObrigacao(obr, pags) {
  const orig = n(obr.valor_original_centavos);
  const lista = [...ativos(pags)].sort((a, b) => String(a.data_pagamento).localeCompare(String(b.data_pagamento)) || String(a.id ?? "").localeCompare(String(b.id ?? "")));
  const pago = somar(lista.map((p) => n(p.valor_centavos)));
  const total = Math.max(0, pago - orig);
  let acumulado = 0;
  const porPagamento = lista.map((p) => {
    const antes = Math.max(0, acumulado - orig); acumulado += n(p.valor_centavos); const depois = Math.max(0, acumulado - orig);
    return { pagamentoId: p.id ?? null, data: String(p.data_pagamento).slice(0, 10), valorPagoCentavos: n(p.valor_centavos), acrescimoCentavos: depois - antes };
  });
  const natureza = total > 0 ? (obr.classificacao_diferenca && NATUREZAS_ACRESCIMO.includes(obr.classificacao_diferenca) ? obr.classificacao_diferenca : "presumido") : null;
  return { valorOriginalCentavos: orig, pagoCentavos: pago, acrescimoCentavos: total, percentualBps: total > 0 ? razaoEmBps(total, orig) : 0, quitada: obr.status === "quitada", natureza,
    parcialAberta: pago > 0 && pago < orig && obr.status !== "quitada", porPagamento };
}

/**
 * Juros e encargos de um MÊS, em duas leituras que não se misturam:
 *   • pagosNoMes: acréscimo efetivamente PAGO naquele mês (pela data do pagamento);
 *   • daCompetencia: acréscimo das obrigações cuja competência é aquele mês (pago ou não ainda naquele mês);
 *   • relacionadas: todas as obrigações envolvidas em qualquer das duas, com os dois números (a soma delas é o "total das duas obrigações").
 * Juros de empréstimo ficam fora (outra natureza).
 * @param {Array<{obrigacao:object, pagamentos:object[], fornecedor?:string, categoria?:string}>} itens
 */
export function jurosDoMes(itens, mes) {
  const zero = () => ({ presumido: 0, juros: 0, multa: 0, tarifa: 0, outro: 0 });
  const pagos = zero(), comp = zero();
  const relacionadas = [];
  for (const { obrigacao: o, pagamentos: p, fornecedor, categoria } of itens) {
    if (o.status === "cancelada") continue;
    const a = acrescimoDaObrigacao(o, p);
    if (!(a.acrescimoCentavos > 0)) continue;
    const pagoNoMes = a.porPagamento.filter((x) => x.data.startsWith(mes)).reduce((s, x) => s + x.acrescimoCentavos, 0);
    const ehCompetencia = String(o.competencia).slice(0, 7) === mes;
    if (pagoNoMes === 0 && !ehCompetencia) continue;
    pagos[a.natureza] += pagoNoMes; if (ehCompetencia) comp[a.natureza] += a.acrescimoCentavos;
    const datas = a.porPagamento.filter((x) => x.acrescimoCentavos > 0).map((x) => x.data);
    relacionadas.push({ obrigacaoId: o.id, descricao: o.descricao ?? null, fornecedor: fornecedor ?? null, categoria: categoria ?? null, competencia: String(o.competencia).slice(0, 7), vencimento: String(o.vencimento).slice(0, 10),
      pagoEm: datas, valorOriginalCentavos: a.valorOriginalCentavos, pagoCentavos: a.pagoCentavos, acrescimoTotalCentavos: a.acrescimoCentavos, percentualBps: a.percentualBps, natureza: a.natureza, quitada: a.quitada,
      pagoNoMesCentavos: pagoNoMes, daCompetenciaCentavos: ehCompetencia ? a.acrescimoCentavos : 0 });
  }
  const resumo = (t) => { const confirmado = t.juros + t.multa + t.tarifa + t.outro; return { presumidoCentavos: t.presumido, confirmadoCentavos: confirmado, totalCentavos: confirmado + t.presumido, jurosCentavos: t.juros, multaCentavos: t.multa, tarifaCentavos: t.tarifa, outroCentavos: t.outro }; };
  return { mes, pagosNoMes: resumo(pagos), daCompetencia: resumo(comp), totalRelacionadasCentavos: relacionadas.reduce((s, r) => s + r.acrescimoTotalCentavos, 0),
    relacionadas: relacionadas.sort((a, b) => a.competencia.localeCompare(b.competencia) || b.acrescimoTotalCentavos - a.acrescimoTotalCentavos) };
}
