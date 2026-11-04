// PARIDADE Foody × Parser (relatório Excel importado) de UMA conta, por dia. Função PURA: recebe as linhas já lidas e devolve
// contagens, somas e divergências. Não lê banco, não grava nada e não tem dado pessoal na saída (só número do pedido, que é
// identificador operacional, e no máximo 10 por categoria).
//
// Chave de pareamento: número do pedido + hora de parede (19 caracteres) — a mesma identidade do Parser (o número sozinho não é
// único, migration 040). Sem par exato, pareia pelo número quando ele é ÚNICO no dia dos dois lados (diferença de horário vira
// divergência de horário, não "pedido sumido").
// Hora: o Parser legado grava a hora de parede em timestamptz como se fosse UTC ("…T19:03:11Z" = 19:03 em Brasília); a Foody grava
// a hora de parede sem fuso. As duas viram "AAAA-MM-DDTHH:MM:SS" sem conversão.
//
// Critério de aceite do dia (PARIDADE): nenhum pedido só de um lado, situação e taxa do entregador iguais em todos os pares e
// nenhuma troca Subway ↔ Açaí. Pedido em triagem na Foody não reprova o dia (é pendência humana), mas é contado.
//
// Categorias SEPARADAS (nenhuma esconde a outra):
//   - taxa logística: pares com taxa diferente + soma da diferença (Foody − Parser) + taxa de pedido só de um lado + taxa ausente
//     na Foody (a API não trouxe valor — continua divergência, não é "zero");
//   - cancelamento: cancelado num lado e não no outro (CANCELAMENTO_DIVERGENTE) é distinto de outra situação divergente;
//     contagem de cancelados (e cancelados COM taxa) em cada lado;
//   - triagem: pedidos em triagem na Foody e em revisão no Parser, contados à parte;
//   - limitações conhecidas da API (LIMITACOES_API): o que a comparação NÃO consegue provar, sempre declarado no resumo.

/** Limitações conhecidas da API Foody (auditoria 03/11) que a paridade não consegue verificar — vão sempre no resumo. */
export const LIMITACOES_API = Object.freeze([
  { codigo: "SEM_DATA_CANCELAMENTO", efeito: "a API não informa quando o pedido foi cancelado: o cancelado entra no dia do pedido" },
  { codigo: "SEM_ORIGEM_PEDIDO", efeito: "a API não informa o canal de origem: não há conferência por canal" },
  { codigo: "ENTREGADOR_SO_HASH", efeito: "nome do entregador não é guardado: não há conferência por entregador" },
  { codigo: "VALOR_MINIMO_TITULAR", efeito: "pedido de outra operação sem destino fica com valor nulo na titular: valor do pedido não é comparado" },
]);

const AMOSTRA = 10;
const TOL_CENTAVOS = 0.005;
const TOL_HORARIO_S = 60;

export const parede = (v) => (v == null || v === "" ? null : String(v).replace(" ", "T").slice(0, 19));
const num = (v) => (v == null || v === "" ? null : Number(v));
const igualValor = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < TOL_CENTAVOS);
const arred = (v) => Math.round(v * 100) / 100;
const soma = (xs, campo) => arred(xs.reduce((s, x) => s + (num(x[campo]) ?? 0), 0));
const CANCELADO = "Cancelado";
const porChave = (xs, f) => xs.reduce((m, x) => { const k = f(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
const segundos = (a, b) => Math.abs(Date.parse(`${a}Z`) - Date.parse(`${b}Z`)) / 1000;

/** Operação do Parser no mesmo vocabulário da Foody (revisão do Parser = triagem). */
export const operacaoParser = (op) => (op === "acai_no_grau" ? "acai_no_grau" : op === "revisao_necessaria" ? "triagem" : "subway");
/** Operação EFETIVA da Foody: linha ativa no destino = a operação do destino; na titular, triagem/revisão = triagem. */
export const operacaoFoody = (op) => (op === "acai_no_grau" ? "acai_no_grau" : op === "subway" ? "subway" : "triagem");

/**
 * @param {{competencia:string, foody:Array<object>, parser:Array<object>}} p
 *   foody: linhas ATIVAS de foody_pedidos da conexão (titular + destinos) {numero_pedido, data_hora, situacao, taxa_entregador, valor_total, operacao}
 *   parser: linhas CONSOLIDADAS do Parser (sem sobreposição entre importações) {numero_pedido, data_hora, situacao, taxa_entregador, valor_total_pedido, operacao}
 */
export function compararParidadeDia({ competencia, foody = [], parser = [] }) {
  const F = foody.map((x) => ({ numero: String(x.numero_pedido ?? "").trim(), hora: parede(x.data_hora), situacao: x.situacao ?? null,
    taxa: num(x.taxa_entregador), valor: num(x.valor_total), operacao: operacaoFoody(x.operacao) }));
  const P = parser.map((x) => ({ numero: String(x.numero_pedido ?? "").trim(), hora: parede(x.data_hora), situacao: x.situacao ?? null,
    taxa: num(x.taxa_entregador), valor: num(x.valor_total_pedido), operacao: operacaoParser(x.operacao) }));

  const pares = [];
  const livresF = new Set(F.keys()), livresP = new Set(P.keys());
  const idxP = new Map();
  P.forEach((p, i) => { const k = `${p.numero}|${p.hora}`; if (!idxP.has(k)) idxP.set(k, []); idxP.get(k).push(i); });
  F.forEach((f, i) => {
    const lista = idxP.get(`${f.numero}|${f.hora}`);
    const j = lista?.find((x) => livresP.has(x));
    if (j !== undefined) { pares.push([i, j]); livresF.delete(i); livresP.delete(j); }
  });
  // Segundo passe: número ÚNICO no dia inteiro dos dois lados (contado em TODAS as linhas, não só nas que sobraram), horário diferente.
  const contaNum = (xs) => { const m = new Map(); xs.forEach((x, i) => m.set(x.numero, [...(m.get(x.numero) ?? []), i])); return m; };
  const nF = contaNum(F), nP = contaNum(P);
  for (const [numero, is] of nF) {
    const js = nP.get(numero);
    if (numero && is.length === 1 && js?.length === 1 && livresF.has(is[0]) && livresP.has(js[0])) {
      pares.push([is[0], js[0]]); livresF.delete(is[0]); livresP.delete(js[0]);
    }
  }

  const div = { situacao: [], cancelamento: [], taxa: [], taxaAusenteFoody: [], valor: [], horario: [], trocaOperacao: [], triagemFoody: [] };
  let diferencaTaxaPares = 0;
  for (const [i, j] of pares) {
    const f = F[i], p = P[j];
    if (f.situacao !== p.situacao) ((f.situacao === CANCELADO) !== (p.situacao === CANCELADO) ? div.cancelamento : div.situacao).push(f.numero);
    if (!igualValor(f.taxa, p.taxa)) {
      div.taxa.push(f.numero);
      if (f.taxa == null) div.taxaAusenteFoody.push(f.numero);
      diferencaTaxaPares += (f.taxa ?? 0) - (p.taxa ?? 0);
    }
    // Valor do pedido de OUTRA operação fica mínimo na titular (null) quando não há destino: não é divergência.
    if (f.valor != null && !igualValor(f.valor, p.valor)) div.valor.push(f.numero);
    if (f.hora && p.hora && segundos(f.hora, p.hora) > TOL_HORARIO_S) div.horario.push(f.numero);
    if (f.operacao === "triagem") div.triagemFoody.push(f.numero);
    else if (p.operacao !== "triagem" && f.operacao !== p.operacao) div.trocaOperacao.push(f.numero);
  }
  const soFoody = [...livresF].map((i) => F[i].numero), soParser = [...livresP].map((j) => P[j].numero);
  const amostra = (xs) => ({ quantidade: xs.length, exemplos: xs.slice(0, AMOSTRA) });
  const motivos = [];
  if (soFoody.length) motivos.push("PEDIDO_SO_NA_FOODY");
  if (soParser.length) motivos.push("PEDIDO_SO_NO_PARSER");
  if (div.cancelamento.length) motivos.push("CANCELAMENTO_DIVERGENTE");
  if (div.situacao.length) motivos.push("SITUACAO_DIVERGENTE");
  if (div.taxa.length) motivos.push("TAXA_DIVERGENTE");
  if (div.trocaOperacao.length) motivos.push("TROCA_DE_OPERACAO");
  const cancelados = (xs) => xs.filter((x) => x.situacao === CANCELADO);
  const cancComTaxa = (xs) => cancelados(xs).filter((x) => (x.taxa ?? 0) > TOL_CENTAVOS).length;
  const sF = [...livresF].map((i) => F[i]), sP = [...livresP].map((j) => P[j]);
  return {
    competencia,
    resultado: motivos.length ? "DIVERGENTE" : "PARIDADE",
    motivos,
    contagens: { foody: F.length, parser: P.length, pareados: pares.length, soFoody: soFoody.length, soParser: soParser.length },
    porOperacao: { foody: porChave(F, (x) => x.operacao), parser: porChave(P, (x) => x.operacao) },
    porSituacao: { foody: porChave(F, (x) => x.situacao ?? "—"), parser: porChave(P, (x) => x.situacao ?? "—") },
    somas: { taxaEntregador: { foody: soma(F, "taxa"), parser: soma(P, "taxa"),
      diferencaPares: arred(diferencaTaxaPares), soFoody: soma(sF, "taxa"), soParser: soma(sP, "taxa") } },
    cancelamentos: { foody: cancelados(F).length, parser: cancelados(P).length, comTaxaFoody: cancComTaxa(F), comTaxaParser: cancComTaxa(P) },
    triagem: { foody: F.filter((x) => x.operacao === "triagem").length, parser: P.filter((x) => x.operacao === "triagem").length },
    limitacoes: F.some((x) => x.valor == null) ? ["VALOR_MINIMO_TITULAR"] : [],
    divergencias: {
      soFoody: amostra(soFoody), soParser: amostra(soParser), situacao: amostra(div.situacao), cancelamento: amostra(div.cancelamento),
      taxa: amostra(div.taxa), taxaAusenteFoody: amostra(div.taxaAusenteFoody),
      valor: amostra(div.valor), horario: amostra(div.horario), trocaOperacao: amostra(div.trocaOperacao), triagemFoody: amostra(div.triagemFoody),
    },
  };
}

/** Consolida vários dias: PARIDADE só se TODOS os dias tiverem paridade. */
export function resumirParidade(dias) {
  const div = dias.filter((d) => d.resultado !== "PARIDADE");
  return {
    resultado: dias.length && !div.length ? "PARIDADE" : "DIVERGENTE",
    dias: dias.length, diasComParidade: dias.length - div.length,
    motivos: [...new Set(div.flatMap((d) => d.motivos))].sort(),
    totais: dias.reduce((t, d) => ({ foody: t.foody + d.contagens.foody, parser: t.parser + d.contagens.parser, pareados: t.pareados + d.contagens.pareados,
      soFoody: t.soFoody + d.contagens.soFoody, soParser: t.soParser + d.contagens.soParser,
      trocaOperacao: t.trocaOperacao + d.divergencias.trocaOperacao.quantidade, triagemFoody: t.triagemFoody + d.divergencias.triagemFoody.quantidade }),
    { foody: 0, parser: 0, pareados: 0, soFoody: 0, soParser: 0, trocaOperacao: 0, triagemFoody: 0 }),
    taxaLogistica: dias.reduce((t, d) => ({
      foody: arred(t.foody + d.somas.taxaEntregador.foody), parser: arred(t.parser + d.somas.taxaEntregador.parser),
      diferencaPares: arred(t.diferencaPares + (d.somas.taxaEntregador.diferencaPares ?? 0)),
      paresDivergentes: t.paresDivergentes + d.divergencias.taxa.quantidade,
      ausenteNaFoody: t.ausenteNaFoody + (d.divergencias.taxaAusenteFoody?.quantidade ?? 0) }),
    { foody: 0, parser: 0, diferencaPares: 0, paresDivergentes: 0, ausenteNaFoody: 0 }),
    cancelamentos: dias.reduce((t, d) => ({ foody: t.foody + (d.cancelamentos?.foody ?? 0), parser: t.parser + (d.cancelamentos?.parser ?? 0),
      comTaxaFoody: t.comTaxaFoody + (d.cancelamentos?.comTaxaFoody ?? 0), comTaxaParser: t.comTaxaParser + (d.cancelamentos?.comTaxaParser ?? 0),
      divergentes: t.divergentes + (d.divergencias.cancelamento?.quantidade ?? 0) }),
    { foody: 0, parser: 0, comTaxaFoody: 0, comTaxaParser: 0, divergentes: 0 }),
    triagem: dias.reduce((t, d) => ({ foody: t.foody + (d.triagem?.foody ?? 0), parser: t.parser + (d.triagem?.parser ?? 0) }), { foody: 0, parser: 0 }),
    limitacoes: LIMITACOES_API,
  };
}
