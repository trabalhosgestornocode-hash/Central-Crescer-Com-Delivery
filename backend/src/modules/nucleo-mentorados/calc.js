// NÚCLEO MENTORADOS — motor de cálculo PURO (sem banco, sem rede).
//
// Regras que este arquivo garante (e os testes cobram):
//   * dinheiro em CENTAVOS inteiros; nunca soma float de reais;
//   * ausência de dado = null, nunca 0; um mês sem o indicador fica FORA do numerador E do denominador;
//   * percentual agregado = Σ componente ÷ Σ vendas dos MESMOS meses (ponderado), nunca média de percentuais mensais;
//   * variação percentual (%) ≠ variação em pontos percentuais (p.p.);
//   * cada mês vem de UMA fonte (planilha OU Dashboard iFood); a outra vira divergência, nunca soma;
//   * período comparável só com a mesma quantidade de meses e cobertura completa; senão, sem variação e com o motivo;
//   * "vendas" aqui = vendas no iFood (extrato), não o faturamento total da empresa.

export const CAMPOS = Object.freeze({
  valorVendas: { rotulo: "Vendas no iFood", tipo: "reais" },
  taxasComissoes: { rotulo: "Taxas e comissões", tipo: "reais" },
  servicosPromocoes: { rotulo: "Serviços e promoções", tipo: "reais" },
  taxasEntregadores: { rotulo: "Taxas dos entregadores", tipo: "reais" },
  qtdPedidos: { rotulo: "Pedidos", tipo: "quantidade" },
  valorVendasDesempenho: { rotulo: "Vendas (aba Desempenho)", tipo: "reais" },
  novosClientes: { rotulo: "Novos clientes", tipo: "quantidade" },
});
const CAMPOS_REAIS = Object.keys(CAMPOS).filter((c) => CAMPOS[c].tipo === "reais");

// ---------------------------------------------------------------------------
// Meses
// ---------------------------------------------------------------------------
const RE_YM = /^(\d{4})-(\d{2})/;

/** "AAAA-MM[-DD]" | Date -> "AAAA-MM". Lança em entrada inválida (erro de programação, não de dado). */
export function ymDe(v) {
  if (v instanceof Date) return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}`;
  const m = RE_YM.exec(String(v ?? ""));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new TypeError(`mês inválido: ${v}`);
  return `${m[1]}-${m[2]}`;
}

export function somarMeses(ym, n) {
  const [a, m] = ymDe(ym).split("-").map(Number);
  const t = a * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

/** Quantidade de meses de `de` até `ate`, inclusive (0 se ate < de). */
export function distanciaMeses(de, ate) {
  const [a1, m1] = ymDe(de).split("-").map(Number);
  const [a2, m2] = ymDe(ate).split("-").map(Number);
  return Math.max(0, (a2 * 12 + m2) - (a1 * 12 + m1) + 1);
}

export function listaMeses(de, ate) {
  const n = distanciaMeses(de, ate);
  return Array.from({ length: n }, (_, i) => somarMeses(de, i));
}

const NOMES_MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
export const rotuloMes = (ym) => { const [a, m] = ymDe(ym).split("-"); return `${NOMES_MES[Number(m) - 1]}/${a.slice(2)}`; };
export const rotuloIntervalo = (de, ate) => `${rotuloMes(de)} – ${rotuloMes(ate)}`;

// ---------------------------------------------------------------------------
// Números
// ---------------------------------------------------------------------------

/** Reais (number|string|null) -> centavos inteiros | null. String vazia / NaN = null (ausente, não zero). */
export function centavos(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
export const reais = (c) => (c == null ? null : c / 100);
const inteiro = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

/** Razão em % com 4 casas (ex.: 25.7826). null quando a base é ausente ou zero. */
export function pct(parte, base) {
  if (parte == null || base == null || base === 0) return null;
  return Math.round((parte / base) * 1e6) / 1e4;
}

/** Variação de um VALOR: absoluta e percentual. Percentual null quando a base é ausente/zero. */
export function variacao(atual, anterior) {
  if (atual == null || anterior == null) return { absoluta: null, percentual: null };
  return { absoluta: atual - anterior, percentual: anterior === 0 ? null : Math.round(((atual - anterior) / Math.abs(anterior)) * 1e6) / 1e4 };
}

/** Diferença entre dois PERCENTUAIS, em pontos percentuais. */
export function pontosPercentuais(atualPct, anteriorPct) {
  if (atualPct == null || anteriorPct == null) return null;
  return Math.round((atualPct - anteriorPct) * 1e4) / 1e4;
}

// ---------------------------------------------------------------------------
// Normalização das fontes -> mês canônico (centavos / inteiros / null)
// ---------------------------------------------------------------------------

/** Linha de `mentoria_historico_mensal` (snake_case, reais) -> mês canônico. */
export function mesDaImportacao(r) {
  return {
    mes: ymDe(r.mes),
    valorVendas: centavos(r.valor_vendas),
    taxasComissoes: centavos(r.taxas_comissoes),
    servicosPromocoes: centavos(r.servicos_promocoes),
    taxasEntregadores: centavos(r.taxas_entregadores),
    qtdPedidos: inteiro(r.qtd_pedidos),
    valorVendasDesempenho: centavos(r.valor_vendas_desempenho),
    novosClientes: inteiro(r.novos_clientes),
    precificacaoPct: r.precificacao_pct == null ? null : Number(r.precificacao_pct),
  };
}

/** Reais já consolidados (ex.: snapshot do Dashboard iFood) -> mês canônico. */
export function mesCanonico(mes, v) {
  return {
    mes: ymDe(mes),
    valorVendas: centavos(v.valorVendas),
    taxasComissoes: centavos(v.taxasComissoes),
    servicosPromocoes: centavos(v.servicosPromocoes),
    taxasEntregadores: centavos(v.taxasEntregadores),
    qtdPedidos: inteiro(v.qtdPedidos),
    valorVendasDesempenho: centavos(v.valorVendasDesempenho),
    novosClientes: inteiro(v.novosClientes),
    precificacaoPct: v.precificacaoPct ?? null,
  };
}

const TOLERANCIA_CENTAVOS = 100; // divergência abaixo de R$ 1,00 é arredondamento, não conflito

/** Escolha vigente para o mês e o grupo: a criada por último entre as ativas que cobrem o mês. */
export function escolhaVigente(escolhas, mes, grupo) {
  let vigente = null;
  for (const e of escolhas ?? []) {
    if (e.grupo !== grupo || e.revogada) continue;
    if (mes < ymDe(e.inicio) || mes > ymDe(e.fim)) continue;
    if (!vigente || String(e.criadaEm ?? "") >= String(vigente.criadaEm ?? "")) vigente = e;
  }
  return vigente;
}

/**
 * Grupos de campos que vêm do MESMO relatório do iFood. Dentro de um grupo, um mês usa uma única fonte (nunca mistura
 * campo a campo, nunca soma). Os grupos são independentes: o extrato financeiro pode vir da planilha e a aba
 * Desempenho do Dashboard iFood quando a planilha não a tem.
 */
export const GRUPOS = Object.freeze({
  financeiro: { chave: "valorVendas", campos: ["valorVendas", "taxasComissoes", "servicosPromocoes", "taxasEntregadores"] },
  desempenho: { chave: "qtdPedidos", campos: ["qtdPedidos", "valorVendasDesempenho", "novosClientes"] },
});

/**
 * Consolida a série mensal. Para cada mês e cada grupo, a fonte preferida vence quando tem o campo-chave do grupo;
 * senão, a outra. A fonte não usada nunca é somada — gera `divergencias` (quando as duas têm o grupo) ou fica
 * registrada como origem complementar (`fontes.desempenho` diferente de `fonte`).
 * @param {{importacao: object[], dashboard: object[], preferencia?: 'importacao'|'dashboard_ifood'}} p
 * @returns {{meses: object[], divergencias: object[]}}
 */
export function consolidarSerie({ importacao = [], dashboard = [], preferencia = "dashboard_ifood", escolhas = [] }) {
  const porFonte = { importacao: new Map(), dashboard_ifood: new Map() };
  for (const m of importacao) porFonte.importacao.set(m.mes, m);
  for (const m of dashboard) porFonte.dashboard_ifood.set(m.mes, m);
  const outra = preferencia === "importacao" ? "dashboard_ifood" : "importacao";
  const todos = [...new Set([...porFonte.importacao.keys(), ...porFonte.dashboard_ifood.keys()])].sort();

  const meses = [];
  const divergencias = [];
  for (const mes of todos) {
    const lados = { [preferencia]: porFonte[preferencia].get(mes), [outra]: porFonte[outra].get(mes) };
    const saida = { mes, fontes: {}, escolhas: {} };
    for (const [nomeGrupo, g] of Object.entries(GRUPOS)) {
      const temGrupo = (m) => m && m[g.chave] != null;
      // Escolha explícita do administrador (a mais recente que cobre o mês) vence a preferência padrão,
      // desde que a fonte escolhida tenha o dado; sem dado, vale a regra padrão e a escolha fica marcada.
      const escolha = escolhaVigente(escolhas, mes, nomeGrupo);
      const padrao = temGrupo(lados[preferencia]) ? preferencia : temGrupo(lados[outra]) ? outra : null;
      const fonte = escolha && temGrupo(lados[escolha.fonte]) ? escolha.fonte : padrao;
      if (escolha) saida.escolhas[nomeGrupo] = { id: escolha.id, aplicada: fonte === escolha.fonte };
      for (const c of g.campos) saida[c] = fonte ? lados[fonte][c] ?? null : null;
      saida.fontes[nomeGrupo] = fonte;
      const descartada = fonte === preferencia ? outra : preferencia;
      // Divergência só quando as DUAS fontes trazem o grupo (ausência de um lado é complemento, não conflito).
      if (!fonte || !temGrupo(lados[descartada])) continue;
      for (const campo of g.campos) {
        const a = lados[fonte][campo], b = lados[descartada][campo];
        if (a == null && b == null) continue;
        const limite = CAMPOS[campo].tipo === "reais" ? TOLERANCIA_CENTAVOS : 0;
        if (a == null || b == null || Math.abs(a - b) > limite) {
          divergencias.push({ mes, campo, grupo: nomeGrupo, rotulo: CAMPOS[campo].rotulo, tipo: CAMPOS[campo].tipo,
            usado: { fonte, valor: a ?? null }, descartado: { fonte: descartada, valor: b ?? null },
            diferenca: a != null && b != null ? a - b : null,
            // Resolvida = um administrador escolheu, com justificativa, qual fonte vale para este mês e grupo.
            resolvidaPor: escolha && fonte === escolha.fonte ? escolha.id : null });
        }
      }
    }
    const base = lados[saida.fontes.financeiro] ?? lados[preferencia] ?? lados[outra];
    saida.precificacaoPct = base?.precificacaoPct ?? null;
    saida.fonte = saida.fontes.financeiro ?? saida.fontes.desempenho;
    meses.push(saida);
  }
  return { meses, divergencias };
}

// ---------------------------------------------------------------------------
// Períodos
// ---------------------------------------------------------------------------

/**
 * Períodos equivalentes a partir da data REAL de entrada. O mês de entrada é o 1º mês da mentoria.
 *   antes  = 12 meses imediatamente anteriores à entrada
 *   ciclo k = 12 meses a partir de entrada + 12·(k−1); o ciclo em curso é PARCIAL (só meses fechados)
 * Cada ciclo traz `referencia`: o intervalo equivalente (mesmos meses do calendário, um ano antes) para
 * comparação justa — num ciclo parcial de N meses, a referência também tem N meses.
 * @param {{dataEntrada: string, ultimoMesFechado: string}} p ultimoMesFechado = último mês encerrado (nunca o corrente)
 */
export function periodosDaMentoria({ dataEntrada, ultimoMesFechado }) {
  const entrada = ymDe(dataEntrada);
  const antes = { id: "antes", rotulo: "Antes da mentoria", inicio: somarMeses(entrada, -12), fim: somarMeses(entrada, -1), meses: 12, parcial: false };
  const ciclos = [];
  if (ultimoMesFechado && ymDe(ultimoMesFechado) >= entrada) {
    for (let k = 1; ; k++) {
      const inicio = somarMeses(entrada, 12 * (k - 1));
      if (inicio > ymDe(ultimoMesFechado)) break;
      const decorridos = Math.min(12, distanciaMeses(inicio, ultimoMesFechado));
      const fim = somarMeses(inicio, decorridos - 1);
      const refInicio = somarMeses(inicio, -12);
      ciclos.push({
        id: `ciclo${k}`, ordem: k,
        rotulo: k === 1 ? "1º ano de mentoria" : `${k}º ano de mentoria`,
        inicio, fim, meses: decorridos, parcial: decorridos < 12,
        referencia: { id: k === 1 ? "antes" : `ciclo${k - 1}`, inicio: refInicio, fim: somarMeses(refInicio, decorridos - 1), meses: decorridos },
      });
      if (k > 50) break; // trava de sanidade
    }
  }
  return { entrada, antes, ciclos, mesesDeMentoria: ciclos.reduce((s, c) => s + c.meses, 0) };
}

// ---------------------------------------------------------------------------
// Agregação de um intervalo
// ---------------------------------------------------------------------------

function somaOndeTodos(meses, campos, alvo) {
  let soma = 0, n = 0;
  for (const m of meses) {
    if (campos.every((c) => m[c] != null)) { soma += m[alvo]; n++; }
  }
  return n ? { soma, meses: n } : { soma: null, meses: 0 };
}

/** Percentual ponderado de um conjunto de componentes sobre vendas, só nos meses com TODOS presentes. */
function pctPonderado(meses, componentes) {
  let num = 0, den = 0, n = 0;
  for (const m of meses) {
    if (m.valorVendas == null || componentes.some((c) => m[c] == null)) continue;
    num += componentes.reduce((s, c) => s + m[c], 0);
    den += m.valorVendas;
    n++;
  }
  return { pct: n ? pct(num, den) : null, meses: n, numerador: n ? num : null, base: n ? den : null };
}

/**
 * Agrega um intervalo [inicio, fim] da série consolidada.
 * @param {object[]} serie meses canônicos (consolidarSerie().meses)
 */
export function agregar(serie, inicio, fim) {
  const esperados = listaMeses(inicio, fim);
  const porMes = new Map(serie.map((m) => [m.mes, m]));
  const meses = esperados.map((ym) => porMes.get(ym) ?? { mes: ym });
  const totais = {};
  for (const campo of Object.keys(CAMPOS)) {
    const r = somaOndeTodos(meses, [campo], campo);
    totais[campo] = { total: r.soma, mesesComDado: r.meses, mesesEsperados: esperados.length, completo: r.meses === esperados.length };
  }
  const vendas = totais.valorVendas;
  const ticket = (() => {
    const v = somaOndeTodos(meses, ["qtdPedidos", "valorVendasDesempenho"], "valorVendasDesempenho");
    const q = somaOndeTodos(meses, ["qtdPedidos", "valorVendasDesempenho"], "qtdPedidos");
    return { valor: v.soma != null && q.soma ? Math.round(v.soma / q.soma) : null, meses: q.meses };
  })();
  const promoComVendas = somaOndeTodos(meses, ["valorVendas", "servicosPromocoes"], "valorVendas");
  const promo = somaOndeTodos(meses, ["valorVendas", "servicosPromocoes"], "servicosPromocoes");
  return {
    inicio, fim, mesesEsperados: esperados.length,
    totais,
    mediaMensalVendas: vendas.total != null ? Math.round(vendas.total / vendas.mesesComDado) : null,
    percentuais: {
      taxasComissoes: pctPonderado(meses, ["taxasComissoes"]),
      servicosPromocoes: pctPonderado(meses, ["servicosPromocoes"]),
      taxasMaisServicos: pctPonderado(meses, ["taxasComissoes", "servicosPromocoes"]),
      taxasEntregadores: pctPonderado(meses, ["taxasEntregadores"]),
      custosIfoodTotal: pctPonderado(meses, ["taxasComissoes", "servicosPromocoes", "taxasEntregadores"]),
    },
    ticketMedio: ticket,
    // R$ vendidos para cada R$ 1 em serviços e promoções (correlação, não causalidade).
    vendasPorRealPromocao: promo.soma && promo.soma > 0 ? Math.round((promoComVendas.soma / promo.soma) * 100) / 100 : null,
    meses,
  };
}

// ---------------------------------------------------------------------------
// Comparativo entre dois intervalos agregados
// ---------------------------------------------------------------------------

/** Indicadores do comparativo, na ordem da apresentação. */
export const INDICADORES = [
  { chave: "valorVendas", rotulo: "Vendas no iFood", tipo: "reais", melhor: "maior", de: (a) => a.totais.valorVendas },
  { chave: "mediaMensalVendas", rotulo: "Média mensal de vendas", tipo: "reais", melhor: "maior", de: (a) => ({ total: a.mediaMensalVendas, mesesComDado: a.totais.valorVendas.mesesComDado, completo: a.totais.valorVendas.completo }) },
  { chave: "taxasComissoes", rotulo: "Taxas e comissões", tipo: "reais", melhor: "neutro", de: (a) => a.totais.taxasComissoes },
  { chave: "servicosPromocoes", rotulo: "Serviços e promoções", tipo: "reais", melhor: "neutro", de: (a) => a.totais.servicosPromocoes },
  { chave: "taxasEntregadores", rotulo: "Taxas dos entregadores", tipo: "reais", melhor: "neutro", de: (a) => a.totais.taxasEntregadores },
  { chave: "pctTaxasComissoes", rotulo: "Taxas e comissões / vendas", tipo: "percentual", melhor: "menor", de: (a) => pctComoTotal(a, "taxasComissoes") },
  { chave: "pctServicosPromocoes", rotulo: "Serviços e promoções / vendas", tipo: "percentual", melhor: "menor", de: (a) => pctComoTotal(a, "servicosPromocoes") },
  { chave: "pctTaxasMaisServicos", rotulo: "Taxas, comissões, serviços e promoções / vendas", tipo: "percentual", melhor: "menor", de: (a) => pctComoTotal(a, "taxasMaisServicos") },
  { chave: "pctTaxasEntregadores", rotulo: "Entregadores / vendas", tipo: "percentual", melhor: "menor", de: (a) => pctComoTotal(a, "taxasEntregadores") },
  { chave: "pctCustosIfoodTotal", rotulo: "Custos iFood + entregadores / vendas", tipo: "percentual", melhor: "menor", de: (a) => pctComoTotal(a, "custosIfoodTotal") },
  { chave: "qtdPedidos", rotulo: "Pedidos", tipo: "quantidade", melhor: "maior", de: (a) => a.totais.qtdPedidos },
  { chave: "ticketMedio", rotulo: "Ticket médio", tipo: "reais", melhor: "maior", de: (a) => ({ total: a.ticketMedio.valor, mesesComDado: a.ticketMedio.meses, completo: a.ticketMedio.meses === a.mesesEsperados }) },
  { chave: "novosClientes", rotulo: "Novos clientes", tipo: "quantidade", melhor: "maior", de: (a) => a.totais.novosClientes },
];

function pctComoTotal(a, chave) {
  const p = a.percentuais[chave];
  return { total: p.pct, mesesComDado: p.meses, completo: p.meses === a.mesesEsperados, numerador: p.numerador, base: p.base };
}

/**
 * Compara `atual` × `referencia` (ambos de `agregar`). Só calcula variação quando os dois lados têm o
 * indicador em TODOS os meses (mesma janela): senão devolve os valores com `comparavel:false` e o motivo.
 */
export function comparar(atual, referencia) {
  if (atual.mesesEsperados !== referencia.mesesEsperados) {
    throw new RangeError("comparar: períodos de tamanhos diferentes (normalize antes)");
  }
  return INDICADORES.map((ind) => {
    const a = ind.de(atual), r = ind.de(referencia);
    const comparavel = a.completo && r.completo && a.total != null && r.total != null;
    let motivo = null;
    if (!comparavel) {
      const faltam = [];
      if (!r.completo) faltam.push(`referência com ${r.mesesComDado} de ${referencia.mesesEsperados} meses`);
      if (!a.completo) faltam.push(`período atual com ${a.mesesComDado} de ${atual.mesesEsperados} meses`);
      motivo = faltam.length ? `Dados incompletos: ${faltam.join("; ")}.` : "Sem dados.";
    }
    const v = comparavel ? variacao(a.total, r.total) : { absoluta: null, percentual: null };
    const pp = comparavel && ind.tipo === "percentual" ? pontosPercentuais(a.total, r.total) : null;
    let leitura = null;
    if (comparavel && ind.melhor !== "neutro") {
      const delta = ind.tipo === "percentual" ? pp : v.absoluta;
      leitura = delta === 0 ? "estavel" : (delta > 0) === (ind.melhor === "maior") ? "melhora" : "piora";
    }
    return {
      chave: ind.chave, rotulo: ind.rotulo, tipo: ind.tipo,
      referencia: r.total, atual: a.total,
      cobertura: { referencia: r.mesesComDado, atual: a.mesesComDado, esperados: atual.mesesEsperados },
      comparavel, motivo,
      // percentual: variação relativa só faz sentido para valores; em indicadores percentuais vale o p.p.
      variacaoAbsoluta: ind.tipo === "percentual" ? null : v.absoluta,
      variacaoPercentual: ind.tipo === "percentual" ? null : v.percentual,
      pontosPercentuais: pp,
      leitura,
    };
  });
}

/** Comparação mês contra mês (mês × anterior) e ano contra ano (mês × mesmo mês do ano anterior), só vendas. */
export function evolucaoMensal(serie) {
  const porMes = new Map(serie.map((m) => [m.mes, m]));
  return serie.map((m) => {
    const ant = porMes.get(somarMeses(m.mes, -1));
    const aa = porMes.get(somarMeses(m.mes, -12));
    return {
      mes: m.mes, fonte: m.fonte ?? null,
      valorVendas: m.valorVendas,
      pctTaxasMaisServicos: m.valorVendas != null && m.taxasComissoes != null && m.servicosPromocoes != null
        ? pct(m.taxasComissoes + m.servicosPromocoes, m.valorVendas) : null,
      mom: variacao(m.valorVendas, ant?.valorVendas ?? null),
      yoy: variacao(m.valorVendas, aa?.valorVendas ?? null),
    };
  });
}

/**
 * Saldo de precificação do mês: proteção de preço (% a mais no iFood) − custos iFood + entregadores (%).
 * NÃO é lucro: é só a folga entre o acréscimo de preço e as deduções do iFood.
 */
export function saldoPrecificacao(m) {
  if (m.precificacaoPct == null || m.valorVendas == null || m.taxasComissoes == null || m.servicosPromocoes == null) return null;
  const custos = m.taxasComissoes + m.servicosPromocoes + (m.taxasEntregadores ?? 0);
  const custoPct = pct(custos, m.valorVendas);
  return { protecaoPct: m.precificacaoPct, custosPct: custoPct, saldoPp: pontosPercentuais(m.precificacaoPct, custoPct), entregadoresInformados: m.taxasEntregadores != null };
}

/**
 * Metas × realizado (p.p.). `metas` = { taxasComissoes: 13, servicosPromocoes: 5, taxasMaisServicos: 18, ... } (% máximos).
 */
export function metasVersusRealizado(agregado, metas = {}) {
  const mapa = { taxasComissoes: "Taxas e comissões", servicosPromocoes: "Serviços e promoções", taxasMaisServicos: "Taxas + serviços e promoções", taxasEntregadores: "Entregadores", custosIfoodTotal: "Total com entregadores" };
  return Object.entries(mapa).filter(([k]) => metas[k] != null).map(([k, rotulo]) => {
    const real = agregado.percentuais[k]?.pct ?? null;
    const dif = pontosPercentuais(real, metas[k]);
    return { chave: k, rotulo, meta: metas[k], realizado: real, diferencaPp: dif, dentro: dif == null ? null : dif <= 0, meses: agregado.percentuais[k]?.meses ?? 0 };
  });
}

/** Alertas de qualidade de dados e de contrato (nunca conclusões de causalidade). */
export function alertas({ participante, periodos, agregados, divergencias = [], hojeIso, cicloDestaque = null }) {
  const lista = [];
  if (!participante.data_renovacao) lista.push({ nivel: "info", codigo: "SEM_RENOVACAO", texto: "Data de renovação contratual não cadastrada." });
  else if (hojeIso) {
    const dias = Math.round((Date.parse(participante.data_renovacao) - Date.parse(hojeIso)) / 864e5);
    if (dias >= 0 && dias <= 60) lista.push({ nivel: "atencao", codigo: "RENOVACAO_PROXIMA", texto: `Renovação em ${dias} ${dias === 1 ? "dia" : "dias"} (${participante.data_renovacao.split("-").reverse().join("/")}).` });
    if (dias < 0) lista.push({ nivel: "atencao", codigo: "RENOVACAO_VENCIDA", texto: "Data de renovação já passou." });
  }
  const antes = agregados.antes;
  if (antes && !antes.totais.valorVendas.completo) {
    lista.push({ nivel: "atencao", codigo: "ANTES_INCOMPLETO", texto: `Período anterior à mentoria com ${antes.totais.valorVendas.mesesComDado} de 12 meses de vendas.` });
  }
  if (!periodos.ciclos.length) lista.push({ nivel: "info", codigo: "SEM_MES_FECHADO", texto: "Ainda não há mês de mentoria encerrado." });
  const atual = periodos.ciclos.at(-1);
  if (atual?.parcial) lista.push({ nivel: "info", codigo: "CICLO_PARCIAL", texto: `${atual.rotulo} em curso: ${atual.meses} de 12 meses (comparativo parcial).` });
  // Cobertura medida no ciclo em destaque (o último completo), não num parcial de 1–2 meses.
  const ref = cicloDestaque ?? atual;
  const ag = ref ? agregados[ref.id] : null;
  if (ag) {
    for (const campo of ["qtdPedidos", "novosClientes", "taxasEntregadores"]) {
      const t = ag.totais[campo];
      if (!t.completo) lista.push({ nivel: "info", codigo: `INCOMPLETO_${campo.toUpperCase()}`, texto: `${CAMPOS[campo].rotulo}: ${t.mesesComDado} de ${t.mesesEsperados} ${t.mesesEsperados === 1 ? "mês" : "meses"} informados no ${ref.rotulo}.` });
    }
  }
  const abertas = new Set(divergencias.filter((d) => !d.resolvidaPor).map((d) => d.mes));
  const resolvidas = new Set(divergencias.filter((d) => d.resolvidaPor).map((d) => d.mes));
  if (abertas.size) lista.push({ nivel: "atencao", codigo: "DIVERGENCIA_FONTES", texto: `Planilha e Dashboard iFood divergem em ${abertas.size} ${abertas.size === 1 ? "mês" : "meses"} sem escolha de fonte registrada.` });
  else if (resolvidas.size) lista.push({ nivel: "info", codigo: "DIVERGENCIA_RESOLVIDA", texto: `Divergências entre planilha e Dashboard iFood em ${resolvidas.size} ${resolvidas.size === 1 ? "mês" : "meses"} usam a fonte escolhida e justificada (aba Histórico).` });
  return lista;
}

/** Monta tudo de uma vez para um mentorado (usado pela listagem, pelo perfil e pelo snapshot da apresentação). */
export function analisar({ participante, serie, divergencias = [], metas = {}, hojeIso, mudancas = [] }) {
  const ultimoMesFechado = somarMeses(ymDe(hojeIso), -1);
  const comVendas = serie.filter((m) => m.valorVendas != null && m.mes <= ultimoMesFechado).map((m) => m.mes);
  const ultimoComDado = comVendas.length ? comVendas.at(-1) : null;
  const mudancasOrd = normalizarMudancas(mudancas);
  // Data de entrada pendente: nenhum período é presumido; só a série e os alertas.
  if (!participante.data_entrada) {
    return {
      mesCorrente: ymDe(hojeIso), periodos: { entrada: null, antes: null, ciclos: [], mesesDeMentoria: 0 },
      ultimoMesComDado: ultimoComDado, comparativos: [], comparativoPrincipal: -1, evolucao: evolucaoMensal(serie),
      metas: [], mudancas: mudancasOrd,
      alertas: [{ nivel: "atencao", codigo: "ENTRADA_PENDENTE", texto: "Data de entrada na mentoria não confirmada: comparativos indisponíveis até o cadastro." },
        ...alertas({ participante, periodos: { ciclos: [] }, agregados: {}, divergencias, hojeIso })],
    };
  }
  const periodos = periodosDaMentoria({ dataEntrada: participante.data_entrada, ultimoMesFechado: ultimoComDado ?? ultimoMesFechado });
  const agregados = { antes: agregar(serie, periodos.antes.inicio, periodos.antes.fim) };
  const comparativos = [];
  for (const c of periodos.ciclos) {
    agregados[c.id] = agregar(serie, c.inicio, c.fim);
    const ref = agregar(serie, c.referencia.inicio, c.referencia.fim);
    const indicadores = protegerEstruturaDeCustos(comparar(agregados[c.id], ref), mudancasOrd, c.referencia.inicio, c.fim);
    comparativos.push({ ciclo: c, referenciaAgregada: resumoAgregado(ref), atualAgregado: resumoAgregado(agregados[c.id]), indicadores });
  }
  const cicloAtual = periodos.ciclos.at(-1) ?? null;
  // Comparativo de destaque: o último ciclo completo; sem nenhum completo, o parcial em curso.
  const completos = comparativos.map((c, i) => (c.ciclo.parcial ? -1 : i)).filter((i) => i >= 0);
  const principal = completos.length ? completos.at(-1) : comparativos.length - 1;
  const cicloDestaque = comparativos[principal]?.ciclo ?? null;
  return {
    // Mês corrente (ainda em andamento): fica fora dos períodos e as telas o marcam como parcial.
    mesCorrente: ymDe(hojeIso),
    periodos,
    ultimoMesComDado: ultimoComDado,
    comparativos,
    comparativoPrincipal: principal,
    evolucao: evolucaoMensal(serie),
    // Metas avaliadas no mesmo ciclo de destaque (nunca num parcial de 1–2 meses quando há um ciclo completo).
    metas: cicloAtual ? marcarMetasComMudanca(metasVersusRealizado(agregados[cicloDestaque?.id ?? cicloAtual.id], metas), mudancasOrd, cicloDestaque ?? cicloAtual) : [],
    mudancas: mudancasOrd,
    alertas: [...alertas({ participante, periodos, agregados, divergencias, hojeIso, cicloDestaque }),
      ...mudancasOrd.map((m) => ({ nivel: "info", codigo: "MUDANCA_OPERACIONAL", texto: `${m.texto}: custos de entregadores antes e depois não são comparáveis.` }))],
  };
}

// ---------------------------------------------------------------------------
// Mudanças de modelo operacional (ex.: Marketplace -> Full Service)
// ---------------------------------------------------------------------------
export const ROTULO_MODELO = { marketplace: "Marketplace", full_service: "Full Service", misto: "Misto", outro: "Outro modelo" };
/** Indicadores cuja estrutura de custos muda com o modelo operacional (entregadores entram ou saem). */
export const INDICADORES_ESTRUTURA = new Set(["taxasEntregadores", "pctTaxasEntregadores", "pctCustosIfoodTotal"]);

export function normalizarMudancas(lista = []) {
  return lista.filter((m) => m && m.mes && m.para)
    .map((m) => ({ mes: ymDe(m.mes), de: m.de ?? null, para: m.para, titulo: m.titulo ?? null,
      texto: `${m.de ? `${ROTULO_MODELO[m.de] ?? m.de} → ` : "Mudança para "}${ROTULO_MODELO[m.para] ?? m.para} em ${rotuloMes(m.mes)}` }))
    .sort((a, b) => a.mes.localeCompare(b.mes));
}

/**
 * Uma mudança de modelo dentro da janela comparada (depois do início da referência e até o fim do período atual)
 * mistura estruturas de custos: os indicadores de entregadores deixam de ser comparáveis. Ausência de entregadores
 * depois de virar Full Service NUNCA é lida como economia.
 */
export function protegerEstruturaDeCustos(indicadores, mudancas, inicioRef, fimAtual) {
  const dentro = mudancas.filter((m) => m.mes > inicioRef && m.mes <= fimAtual);
  if (!dentro.length) return indicadores;
  const motivo = `Estrutura de custos mudou (${dentro.map((m) => m.texto).join("; ")}): entregadores não são comparáveis entre os períodos.`;
  return indicadores.map((i) => (INDICADORES_ESTRUTURA.has(i.chave)
    ? { ...i, comparavel: false, motivo, variacaoAbsoluta: null, variacaoPercentual: null, pontosPercentuais: null, leitura: null, estruturaMudou: true }
    : i));
}

function marcarMetasComMudanca(metas, mudancas, ciclo) {
  const dentro = ciclo ? mudancas.filter((m) => m.mes > ciclo.inicio && m.mes <= ciclo.fim) : [];
  if (!dentro.length) return metas;
  return metas.map((m) => (["taxasEntregadores", "custosIfoodTotal"].includes(m.chave)
    ? { ...m, contexto: `Ciclo mistura modelos (${dentro.map((x) => x.texto).join("; ")}).` } : m));
}

/** Versão serializável do agregado (sem a lista de meses). */
export function resumoAgregado(a) {
  const { meses: _m, ...resto } = a;
  return resto;
}

export { CAMPOS_REAIS };
