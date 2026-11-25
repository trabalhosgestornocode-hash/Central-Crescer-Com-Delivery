// MOVA CORE — auxiliares de LEITURA compartilhados pelo catálogo e pela análise (módulo próprio: sem import circular).
import { combina } from "./resolucao.js";

// F3: o casamento termo × cadastro é a camada de resolução (flexão, acento, digitação, abreviação, sufixo societário)
export const bate = (termo, ...textos) => combina(termo, ...textos);

const MEMO = Symbol.for("mova-core.memoDeLeituras");
/** Porta com memória de leituras desta MENSAGEM (a próxima mensagem lê de novo: nada fica velho). */
export const comMemoDeLeituras = (porta) => (porta?.[MEMO] ? porta : Object.assign(Object.create(porta), { [MEMO]: new Map() }));
/**
 * 25/11 (homologação real): dentro de UMA mensagem, a mesma leitura (op + escopo + entrada) é feita UMA vez e compartilhada
 * entre as ferramentas, inclusive quando pedidas em paralelo (a promessa em voo é reaproveitada). Falha não fica guardada.
 */
export function lerUmaVez(porta, chaveBase, ler) {
  const memo = porta?.[MEMO];
  if (!memo) return ler();
  if (!memo.has(chaveBase)) { const p = ler(); memo.set(chaveBase, p); p.catch(() => memo.delete(chaveBase)); }
  return memo.get(chaveBase);
}

/** Lê TODAS as páginas de uma consulta paginada (teto de páginas: nunca uma varredura sem fim). */
export async function todasAsPaginas(porta, op, escopo, entrada, { tamanho = 100, maxPaginas = 20 } = {}) {
  const chave = `${op}|${escopo.organizacaoId}|${escopo.unidadeId}|${escopo.usuarioId}|${JSON.stringify(entrada ?? {})}|${tamanho}`;
  return lerUmaVez(porta, chave, async () => {
    const itens = [];
    let primeira = null;
    for (let pagina = 1; pagina <= maxPaginas; pagina++) {
      const r = await porta.ler(op, escopo, { ...entrada, pagina, tamanho });
      primeira ??= r;
      itens.push(...(r?.itens ?? []));
      if (!r?.paginacao || pagina >= r.paginacao.paginas) return { ...primeira, itens, truncado: false };
    }
    return { ...primeira, itens, truncado: true };
  });
}

const DIA_MS = 86_400_000;
const diasEntre = (de, ate) => Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / DIA_MS);
/**
 * 25/11 — SITUAÇÃO DO VENCIMENTO calculada pelo CÓDIGO (nunca pelo modelo), com a data de hoje no fuso de Fortaleza:
 * LIQUIDADA (saldo zero), CANCELADA, VENCIDA (vencimento antes de hoje com saldo), VENCE_HOJE, A_VENCER, SEM_VENCIMENTO.
 * Pagamento parcial não tira do vencido: vale o SALDO.
 */
export function situacaoDoVencimento(t, hoje) {
  if (t.situacao === "CANCELADO") return { situacaoDoVencimento: "CANCELADA", diasEmAtraso: null };
  if ((t.saldoCentavos ?? 0) <= 0) return { situacaoDoVencimento: "LIQUIDADA", diasEmAtraso: null };
  if (!t.vencimento) return { situacaoDoVencimento: "SEM_VENCIMENTO", diasEmAtraso: null };
  if (!hoje) return { situacaoDoVencimento: t.vencido ? "VENCIDA" : "A_VENCER", diasEmAtraso: null };
  const d = diasEntre(t.vencimento, hoje);
  if (d > 0) return { situacaoDoVencimento: "VENCIDA", diasEmAtraso: d };
  if (d === 0) return { situacaoDoVencimento: "VENCE_HOJE", diasEmAtraso: 0 };
  return { situacaoDoVencimento: "A_VENCER", diasEmAtraso: null, venceEmDias: -d };
}

export const itemAPagar = (t, hoje = null) => {
  const base = {
    id: t.id, fornecedor: t.fornecedor?.nome ?? null, descricao: t.descricao ?? null, categoria: t.categoria?.nome ?? t.categoria?.codigo ?? null, categoriaCodigo: t.categoria?.codigo ?? null,
    competencia: t.competencia ?? null, vencimento: t.vencimento ?? null, situacao: t.situacao,
    valorCentavos: t.valorOriginalCentavos ?? t.valorCentavos ?? null, pagoCentavos: t.pagoCentavos ?? null, saldoCentavos: t.saldoCentavos ?? null,
    parcela: t.parcela?.numero && t.parcela?.total > 1 ? `${t.parcela.numero}/${t.parcela.total}` : null, // 1/1 não é parcelamento
  };
  const v = situacaoDoVencimento({ ...base, vencido: Boolean(t.vencido) }, hoje);
  return { ...base, ...v, vencido: v.situacaoDoVencimento === "VENCIDA" };
};

// ------------------------------------------------------------------------------------------- LISTA DETERMINÍSTICA
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const reais = (c) => BRL.format((c ?? 0) / 100).replace(/ /g, " ");
export const dataBr = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "sem data");
export const SEM_FORNECEDOR = "Sem fornecedor identificado";
export function rotuloDoVencimento(t) {
  switch (t.situacaoDoVencimento) {
    case "VENCIDA": return t.diasEmAtraso ? `vencida há ${t.diasEmAtraso} ${t.diasEmAtraso === 1 ? "dia" : "dias"}` : "vencida";
    case "VENCE_HOJE": return "vence hoje";
    case "A_VENCER": return "a vencer";
    case "LIQUIDADA": return "paga";
    case "CANCELADA": return "cancelada";
    default: return "sem vencimento";
  }
}
function linhaDaConta(t, { comFornecedor = true } = {}) {
  const partes = [`venc. ${dataBr(t.vencimento)}`];
  if (comFornecedor) partes.push(t.fornecedor ?? SEM_FORNECEDOR);
  if (t.descricao && t.descricao !== t.fornecedor) partes.push(t.descricao + (t.parcela && !String(t.descricao).includes(t.parcela) ? ` (parcela ${t.parcela})` : ""));
  const parcial = (t.pagoCentavos ?? 0) > 0 && (t.saldoCentavos ?? 0) > 0 ? ` (pago ${reais(t.pagoCentavos)} de ${reais(t.valorCentavos)})` : "";
  const valor = (t.saldoCentavos ?? 0) > 0 ? reais(t.saldoCentavos) : reais(t.valorCentavos);
  return `• ${partes.join(" · ")} — ${valor}${parcial} · ${rotuloDoVencimento(t)}`;
}
const somaSaldo = (lista) => lista.reduce((s, t) => s + (t.saldoCentavos ?? 0), 0);
/**
 * Lista COMPLETA de contas formatada pelo CÓDIGO, dividida em mensagens de até `porMensagem` contas (WhatsApp legível).
 * Cada parte diz "parte i de n"; a última traz o total conferido. Página = recorte de `porPagina` contas (continuidade).
 */
export function formatarListaDeContas(itens, { titulo, agruparPor = "NENHUM", pagina = 1, porPagina = 120, porMensagem = 25, totais }) {
  const paginas = Math.max(1, Math.ceil(itens.length / porPagina));
  const p = Math.min(Math.max(1, pagina), paginas);
  const recorte = itens.slice((p - 1) * porPagina, p * porPagina);
  const linhas = [];
  if (agruparPor === "FORNECEDOR") {
    const grupos = new Map();
    for (const t of recorte) { const k = t.fornecedor ?? SEM_FORNECEDOR; grupos.set(k, [...(grupos.get(k) ?? []), t]); }
    const ordenados = [...grupos.entries()].sort((a, b) => somaSaldo(b[1]) - somaSaldo(a[1]) || a[0].localeCompare(b[0], "pt-BR"));
    for (const [nome, lista] of ordenados) {
      const vencido = somaSaldo(lista.filter((t) => t.vencido));
      linhas.push({ cabecalho: true, texto: `*${nome}* — ${lista.length} ${lista.length === 1 ? "conta" : "contas"}, ${reais(somaSaldo(lista))}${vencido ? ` (vencido ${reais(vencido)})` : ""}` });
      for (const t of lista) linhas.push({ texto: linhaDaConta(t, { comFornecedor: false }) });
    }
  } else for (const t of recorte) linhas.push({ texto: linhaDaConta(t) });
  // divide pela quantidade de CONTAS; um cabeçalho de grupo nunca fica sozinho no fim de uma parte
  const partes = [];
  let atual = []; let contas = 0;
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    if (!l.cabecalho) contas++;
    if (l.cabecalho && contas >= porMensagem && atual.length) { partes.push(atual); atual = []; contas = 0; }
    atual.push(l.texto);
    if (!l.cabecalho && contas >= porMensagem && linhas[i + 1] && !linhas[i + 1].cabecalho) { partes.push(atual); atual = []; contas = 0; }
  }
  if (atual.length) partes.push(atual);
  const n = partes.length;
  const inicio = recorte.length ? (p - 1) * porPagina + 1 : 0; const fim = (p - 1) * porPagina + recorte.length;
  const blocos = partes.map((ls, i) => {
    const cab = `${titulo}${paginas > 1 ? ` — contas ${inicio} a ${fim} de ${itens.length}` : ""}${n > 1 ? ` (parte ${i + 1} de ${n})` : ""}`;
    const rodape = i === n - 1
      ? `\nTotal${paginas > 1 ? " de todas as contas do filtro" : ""}: ${totais.quantidade} ${totais.quantidade === 1 ? "conta" : "contas"}, ${reais(totais.saldoCentavos)} em aberto${totais.vencidoCentavos ? ` (${reais(totais.vencidoCentavos)} vencido)` : ""}.${p < paginas ? ` Faltam as contas ${fim + 1} a ${itens.length}: peça "continuar" para receber.` : ` Lista completa (${itens.length} ${itens.length === 1 ? "conta" : "contas"}).`}`
      : "";
    return `${cab}\n${ls.join("\n")}${rodape}`;
  });
  return { blocos, pagina: p, paginas, inicio, fim, total: itens.length };
}
