// CARGA DIRIGIDA POR COMPETÊNCIA (Execução 08C) — Vendas, Recebimentos consolidados, Central, Pendências e Fechamento.
//
// Antes: cada uma dessas telas lia o histórico INTEIRO do escopo (todas as vendas, pagamentos, lançamentos, propostas...).
// Agora lê, NO BANCO e por lotes:
//   1. cadastros e tabelas de controle pequenas (categorias, contas, saldos informados, sessões de caixa, contrapartes,
//      competências, documentos, importações, divergências entre relatórios, transferências);
//   2. as SEMENTES da competência (vendas, lançamentos, recebíveis, obrigações, ajustes por competência; movimentações do
//      período — desde a âncora de saldo que o cálculo do período usa —; conciliações da competência e as divergentes);
//   3. o FECHO DOS VÍNCULOS, nos dois sentidos, até não aparecer registro novo: venda ⇄ pagamentos ⇄ recebíveis ⇄
//      liquidações ⇄ movimentações ⇄ estornos; título → ajustes → lançamentos; lançamento → origem (venda, recebível,
//      ajuste, obrigação, proposta). Assim a venda de setembro recebida em outubro, a obrigação paga no mês seguinte, o
//      estorno posterior, o pagamento agregado e o recebível parcialmente liquidado continuam inteiros;
//   4. propostas, pedidos importados e vínculos documentais das competências TOCADAS pelos registros carregados.
// As MESMAS funções puras calculam o resultado; a ordem de cada tabela é a de gravação (a mesma de `listar`).
// A equivalência com a carga completa é provada em teste (memória e PostgreSQL) — e pode ser conferida em toda a suíte.
import { TIPO } from "../dominio/catalogos.js";
import { CODIGO, falhar } from "../dominio/erros.js";
import { ORDEM_DE_GRAVACAO } from "../contratos/repositorio.js";
import { competenciaDe, primeiroDiaDe, somarDias, somarMeses, ultimoDiaDe } from "../dominio/tempo.js";
import { inicioEfetivoDe } from "../dominio/tesouraria.js";

const LOTE = 200; // a porta aceita até 200 valores em `em`
const PAGINA = 500;
const ordenar = (lista) => lista.sort((a, b) => (a[ORDEM_DE_GRAVACAO] ?? 0) - (b[ORDEM_DE_GRAVACAO] ?? 0));

async function todasAsPaginas(tx, cx, tipo, consulta) {
  const saida = [];
  for (let deslocamento = 0; ; deslocamento += PAGINA) {
    // 08D: sem contagem total (uma consulta a menos por página); página incompleta = fim.
    const pg = await tx.paginar(cx, tipo, { ...consulta, limite: PAGINA, deslocamento, contar: false });
    saida.push(...pg.itens);
    if (pg.itens.length < PAGINA) return saida;
  }
}

/** Registros cujo `campo` está na lista (lotes de 200, cada lote paginado no banco). */
export async function porLista(tx, cx, tipo, campo, valores, extra = {}) {
  const lista = [...new Set(valores.filter((v) => v !== null && v !== undefined))];
  const saida = [];
  for (let i = 0; i < lista.length; i += LOTE) saida.push(...await todasAsPaginas(tx, cx, tipo, { ...extra, em: { ...(extra.em ?? {}), [campo]: lista.slice(i, i + LOTE) } }));
  return saida;
}

/** Competências (AAAA-MM) que cobrem o intervalo de datas. */
function competenciasEntre(inicio, fim) {
  const lista = [];
  for (let c = competenciaDe(inicio); c <= competenciaDe(fim); c = competenciaDe(somarMeses(primeiroDiaDe(c), 1))) lista.push(c);
  return lista;
}

/**
 * Início das movimentações necessárias ao período: para cada conta, a âncora de saldo que vale no início do período e a
 * âncora anterior a cada saldo informado DENTRO do período (conferência de saldo). Sem âncora, o início do período.
 */
function inicioDasMovimentacoes(saldos, contas, inicio, fim) {
  let menor = inicio;
  for (const conta of contas) {
    const ancoras = saldos.filter((s) => s.contaId === conta.id).map((s) => inicioEfetivoDe(s)).sort();
    const vigente = ancoras.filter((x) => x <= inicio).at(-1);
    if (vigente && vigente < menor) menor = vigente;
    const dentro = ancoras.findIndex((x) => x > inicio && x <= somarDias(fim, 1));
    if (dentro > 0 && ancoras[dentro - 1] < menor) menor = ancoras[dentro - 1];
  }
  return menor;
}

/**
 * @param {object} tx transação de leitura
 * @param {object} cx contexto (escopo)
 * @param {string[]} competencias competências pedidas pela tela
 * @returns {Promise<object>} o mesmo formato de `carregarRegistros` (todas as chaves), só com o necessário
 */
export async function carregarDaCompetencia(tx, cx, competencias) {
  const comps = [...new Set(competencias)].sort();
  const inicio = primeiroDiaDe(comps[0]);
  const fim = ultimoDiaDe(comps.at(-1));
  const l = (tipo, filtro) => tx.listar(cx, tipo, filtro);

  // 1. cadastros e controle (pequenos; crescem pouco com o tempo)
  const d = {
    categorias: await l(TIPO.CATEGORIA), contas: await l(TIPO.CONTA), saldos: await l(TIPO.SALDO_CONTA), sessoes: await l(TIPO.SESSAO_CAIXA),
    contrapartes: await l(TIPO.CONTRAPARTE), competencias: await l(TIPO.COMPETENCIA), documentos: await l(TIPO.DOCUMENTO), importacoes: await l(TIPO.IMPORTACAO),
    divergenciasFonte: await l(TIPO.DIVERGENCIA_FONTE), transferencias: await l(TIPO.TRANSFERENCIA),
  };

  // 2. sementes
  const mapas = Object.fromEntries(["vendas", "pagamentos", "recebiveis", "obrigacoes", "lancamentos", "liquidacoes", "movimentacoes", "ajustes", "estornos", "propostas"].map((k) => [k, new Map()]));
  const novos = Object.fromEntries(Object.keys(mapas).map((k) => [k, []]));
  const juntar = (k, lista) => { for (const r of lista) if (!mapas[k].has(r.id)) { mapas[k].set(r.id, r); novos[k].push(r); } };
  const desde = inicioDasMovimentacoes(d.saldos, d.contas, inicio, fim);
  juntar("vendas", await porLista(tx, cx, TIPO.VENDA, "competencia", comps));
  juntar("lancamentos", await porLista(tx, cx, TIPO.LANCAMENTO, "competencia", comps));
  juntar("recebiveis", await porLista(tx, cx, TIPO.RECEBIVEL, "competencia", comps));
  juntar("obrigacoes", await porLista(tx, cx, TIPO.OBRIGACAO, "competencia", comps));
  juntar("ajustes", await porLista(tx, cx, TIPO.AJUSTE, "competencia", comps));
  juntar("propostas", await porLista(tx, cx, TIPO.PROPOSTA, "competencia", comps));
  juntar("movimentacoes", await todasAsPaginas(tx, cx, TIPO.MOVIMENTACAO, { desde: { dataEfetiva: desde }, ate: { dataEfetiva: fim } }));
  juntar("liquidacoes", await todasAsPaginas(tx, cx, TIPO.LIQUIDACAO, { desde: { dataEfetiva: inicio }, ate: { dataEfetiva: fim } }));
  juntar("estornos", await todasAsPaginas(tx, cx, TIPO.ESTORNO, { desde: { dataEfetiva: inicio }, ate: { dataEfetiva: fim } }));

  // 3. fecho dos vínculos (nos dois sentidos) até não haver registro novo
  const ids = (lista, campo) => lista.map((r) => r[campo]);
  for (let volta = 0; Object.values(novos).some((x) => x.length); volta += 1) {
    const n = Object.fromEntries(Object.entries(novos).map(([k, v]) => [k, v]));
    for (const k of Object.keys(novos)) novos[k] = [];
    const pedir = [];
    const p = (k, tipo, campo, valores) => { if (valores.some((v) => v !== null && v !== undefined)) pedir.push([k, tipo, campo, valores]); };
    p("pagamentos", TIPO.PAGAMENTO_VENDA, "vendaId", ids(n.vendas, "id"));
    p("recebiveis", TIPO.RECEBIVEL, "vendaId", ids(n.vendas, "id"));
    p("lancamentos", TIPO.LANCAMENTO, "id", ids(n.vendas, "lancamentoId"));
    p("lancamentos", TIPO.LANCAMENTO, "origem.vendaId", ids(n.vendas, "id"));
    p("lancamentos", TIPO.LANCAMENTO, "origem.id", [...ids(n.vendas, "id"), ...ids(n.recebiveis, "id"), ...ids(n.ajustes, "id"), ...ids(n.obrigacoes, "grupoId"), ...ids(n.propostas, "id"), ...ids(n.estornos, "id")]);
    p("movimentacoes", TIPO.MOVIMENTACAO, "id", [...ids(n.pagamentos, "movimentacaoId"), ...ids(n.liquidacoes, "movimentacaoId"), ...ids(n.estornos, "movimentacaoId"), ...n.estornos.filter((e) => e.alvoTipo === "MOVIMENTACAO").map((e) => e.alvoId)]);
    p("movimentacoes", TIPO.MOVIMENTACAO, "pagamentoId", ids(n.pagamentos, "id"));
    p("recebiveis", TIPO.RECEBIVEL, "id", [...ids(n.pagamentos, "recebivelId"), ...n.liquidacoes.filter((q) => q.alvoTipo === "RECEBIVEL").map((q) => q.alvoId), ...n.ajustes.filter((a) => a.alvoTipo === "RECEBIVEL").map((a) => a.alvoId)]);
    p("obrigacoes", TIPO.OBRIGACAO, "id", [...n.liquidacoes.filter((q) => q.alvoTipo === "OBRIGACAO").map((q) => q.alvoId), ...n.ajustes.filter((a) => a.alvoTipo === "OBRIGACAO").map((a) => a.alvoId)]);
    p("obrigacoes", TIPO.OBRIGACAO, "grupoId", [...ids(n.obrigacoes, "grupoId"), ...n.lancamentos.filter((x) => x.origem?.tipo === TIPO.OBRIGACAO).map((x) => x.origem.id)]);
    p("vendas", TIPO.VENDA, "id", [...ids(n.recebiveis, "vendaId"), ...ids(n.pagamentos, "vendaId"), ...n.lancamentos.map((x) => x.origem?.vendaId ?? (x.origem?.tipo === TIPO.VENDA ? x.origem.id : null))]);
    p("pagamentos", TIPO.PAGAMENTO_VENDA, "id", [...ids(n.recebiveis, "pagamentoId"), ...ids(n.movimentacoes, "pagamentoId"), ...n.estornos.filter((e) => e.alvoTipo === "PAGAMENTO_VENDA").map((e) => e.alvoId)]);
    p("liquidacoes", TIPO.LIQUIDACAO, "alvoId", [...ids(n.recebiveis, "id"), ...ids(n.obrigacoes, "id")]);
    p("liquidacoes", TIPO.LIQUIDACAO, "movimentacaoId", ids(n.movimentacoes, "id"));
    p("liquidacoes", TIPO.LIQUIDACAO, "id", n.estornos.filter((e) => e.alvoTipo === "LIQUIDACAO").map((e) => e.alvoId));
    p("ajustes", TIPO.AJUSTE, "alvoId", [...ids(n.recebiveis, "id"), ...ids(n.obrigacoes, "id")]);
    p("ajustes", TIPO.AJUSTE, "id", n.lancamentos.filter((x) => x.origem?.tipo === TIPO.AJUSTE).map((x) => x.origem.id));
    p("lancamentos", TIPO.LANCAMENTO, "id", [...ids(n.obrigacoes, "lancamentoId"), ...ids(n.ajustes, "lancamentoId"), ...ids(n.estornos, "lancamentoId")]);
    p("estornos", TIPO.ESTORNO, "alvoId", [...ids(n.pagamentos, "id"), ...ids(n.liquidacoes, "id"), ...ids(n.movimentacoes, "id")]);
    p("estornos", TIPO.ESTORNO, "id", [...ids(n.movimentacoes, "estornoId"), ...ids(n.ajustes, "estornoId"), ...n.lancamentos.filter((x) => x.origem?.tipo === TIPO.ESTORNO).map((x) => x.origem.id)]);
    p("recebiveis", TIPO.RECEBIVEL, "id", n.lancamentos.filter((x) => x.origem?.tipo === TIPO.RECEBIVEL).map((x) => x.origem.id));
    p("propostas", TIPO.PROPOSTA, "id", n.lancamentos.filter((x) => x.origem?.tipo === TIPO.PROPOSTA).map((x) => x.origem.id));
    for (const [k, tipo, campo, valores] of pedir) {
      const faltam = campo === "id" ? valores.filter((v) => v && !mapas[k].has(v)) : valores;
      if (faltam.length) juntar(k, await porLista(tx, cx, tipo, campo, faltam));
    }
    if (volta > 50) break; // salvaguarda: o fecho converge em poucas voltas (cada volta só segue registros novos)
  }

  // 4. competências tocadas → propostas e pedidos importados dessas competências; vínculos documentais dos registros
  const tocadas = new Set([...comps, ...competenciasEntre(desde, fim)]);
  for (const k of ["vendas", "recebiveis", "obrigacoes", "lancamentos", "ajustes"]) for (const r of mapas[k].values()) if (r.competencia) tocadas.add(r.competencia);
  for (const m of mapas.movimentacoes.values()) if (m.dataEfetiva) tocadas.add(competenciaDe(m.dataEfetiva));
  juntar("propostas", await porLista(tx, cx, TIPO.PROPOSTA, "competencia", [...tocadas].filter((c) => !comps.includes(c))));
  const registros = await porLista(tx, cx, TIPO.REGISTRO_FONTE, "competencia", [...tocadas].sort(), { onde: { tipoRegistro: "PEDIDO" } });
  const lista = (k) => ordenar([...mapas[k].values()]);
  const saida = {
    ...d,
    vendas: lista("vendas"), pagamentos: lista("pagamentos"), recebiveis: lista("recebiveis"), obrigacoes: lista("obrigacoes"), lancamentos: lista("lancamentos"),
    liquidacoes: lista("liquidacoes"), movimentacoes: lista("movimentacoes"), ajustes: lista("ajustes"), estornos: lista("estornos"), propostas: lista("propostas"),
    registros: ordenar([...new Map(registros.map((r) => [r.id, r])).values()]),
  };
  const todosOsIds = [...new Set(["vendas", "pagamentos", "recebiveis", "obrigacoes", "lancamentos", "liquidacoes", "movimentacoes", "ajustes", "estornos", "propostas"].flatMap((k) => saida[k].map((r) => r.id)).concat(d.saldos.map((s) => s.id), d.contas.map((c) => c.id), d.sessoes.map((s) => s.id), d.transferencias.map((t) => t.id)))];
  saida.vinculos = ordenar([...new Map((await porLista(tx, cx, TIPO.VINCULO_DOCUMENTAL, "registroId", todosOsIds)).map((v) => [v.id, v])).values()]);
  // Conciliações: as da competência (pela competência dos registros ou da conciliação) e TODAS as divergentes (marcam títulos).
  const corr = [
    ...await porLista(tx, cx, TIPO.CORRESPONDENCIA, "competencia", comps),
    ...await porLista(tx, cx, TIPO.CORRESPONDENCIA, "competenciaDaConciliacao", comps),
    ...await todasAsPaginas(tx, cx, TIPO.CORRESPONDENCIA, { onde: { situacao: "DIVERGENTE" } }),
  ];
  saida.correspondencias = ordenar([...new Map(corr.map((c) => [c.id, c])).values()]);
  return saida;
}

/** Carga COMPLETA do histórico do escopo (referência das provas de equivalência; também usada por consultas de detalhe). */
export async function carregarRegistros(tx, cx) {
  const l = (tipo, filtro) => tx.listar(cx, tipo, filtro);
  return {
    vendas: await l(TIPO.VENDA), pagamentos: await l(TIPO.PAGAMENTO_VENDA), recebiveis: await l(TIPO.RECEBIVEL), ajustes: await l(TIPO.AJUSTE),
    lancamentos: await l(TIPO.LANCAMENTO), categorias: await l(TIPO.CATEGORIA), liquidacoes: await l(TIPO.LIQUIDACAO), movimentacoes: await l(TIPO.MOVIMENTACAO),
    estornos: await l(TIPO.ESTORNO), documentos: await l(TIPO.DOCUMENTO), vinculos: await l(TIPO.VINCULO_DOCUMENTAL), propostas: await l(TIPO.PROPOSTA),
    registros: await l(TIPO.REGISTRO_FONTE, { onde: { tipoRegistro: "PEDIDO" } }), correspondencias: await l(TIPO.CORRESPONDENCIA),
    divergenciasFonte: await l(TIPO.DIVERGENCIA_FONTE), competencias: await l(TIPO.COMPETENCIA), contas: await l(TIPO.CONTA), saldos: await l(TIPO.SALDO_CONTA),
    sessoes: await l(TIPO.SESSAO_CAIXA), contrapartes: await l(TIPO.CONTRAPARTE), obrigacoes: await l(TIPO.OBRIGACAO), transferencias: await l(TIPO.TRANSFERENCIA),
    importacoes: await l(TIPO.IMPORTACAO),
  };
}

/**
 * Primeiro caminho em que dois resultados diferem (comparação ESTRITA e profunda de dados: tipos, chaves, ordem de listas,
 * Map/Set pelo conteúdo). Nulo quando são iguais.
 */
export function primeiraDiferenca(a, b, caminho = "$") {
  if (Object.is(a, b)) return null;
  const tipo = (x) => (x === null ? "null" : Array.isArray(x) ? "array" : x instanceof Map ? "map" : x instanceof Set ? "set" : typeof x);
  const ta = tipo(a);
  const resumo = () => `${caminho} (${String(JSON.stringify(a)).slice(0, 120)} × ${String(JSON.stringify(b)).slice(0, 120)})`;
  if (ta !== tipo(b) || !["array", "map", "set", "object"].includes(ta)) return resumo();
  if (ta === "map" || ta === "set") return primeiraDiferenca([...a], [...b], caminho);
  if (ta === "array" && a.length !== b.length) return `${caminho}.length (${a.length} × ${b.length})`;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ta === "object" && (ka.length !== kb.length || ka.some((k) => !Object.prototype.hasOwnProperty.call(b, k)))) return `${caminho} (chaves ${ka.join(",").slice(0, 120)} × ${kb.join(",").slice(0, 120)})`;
  for (const k of ka) {
    const d = primeiraDiferenca(a[k], b[k], `${caminho}.${k}`);
    if (d) return d;
  }
  return null;
}

/** Falha fechada se a carga dirigida produzir resultado diferente da completa (modo de conferência dos testes). */
export function exigirEquivalencia(dirigida, completa, tela) {
  const caminho = primeiraDiferenca(dirigida, completa);
  if (caminho) falhar(CODIGO.INTEGRIDADE_VIOLADA, `Carga dirigida diverge da carga completa (${tela}).`, { tela, caminho });
}

/**
 * Registros para as competências pedidas. `cargaCompleta`: referência (lê tudo). `conferir`: calcula o DERIVADO com as
 * duas cargas e exige igualdade (só testes — custa o dobro).
 */
export async function registrosDaCompetencia(tx, cx, competencias, { cargaCompleta = false, conferir = false, derivar = null, tela = "" } = {}) {
  if (cargaCompleta) return carregarRegistros(tx, cx);
  const d = await carregarDaCompetencia(tx, cx, competencias);
  if (conferir && derivar) exigirEquivalencia(derivar(d), derivar(await carregarRegistros(tx, cx)), tela);
  return d;
}
