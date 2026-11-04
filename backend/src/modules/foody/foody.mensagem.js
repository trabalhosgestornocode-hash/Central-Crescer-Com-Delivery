// Bloco LOGÍSTICO (Foody) dos relatórios diário e semanal do Checklist — PURO (sem banco, rede nem relógio).
//
//   * Cada empresa vê só os PRÓPRIOS indicadores: o bloco recebe apenas os fechamentos do tenant do relatório (Subway na Subway,
//     Açaí no Açaí, pelo bloco da operação gravada no fechamento). Outras operações e triagem nunca aparecem.
//   * Valores em R$ só para quem tem permissão financeira (`incluirValores`); os demais recebem só contagens.
//   * O bloco carrega a VERSÃO usada ("fechamento logístico v2"): é uma fotografia do momento do enfileiramento. Uma versão nova
//     depois disso NÃO gera mensagem corretiva (a chave de idempotência continua sendo a do fechamento do Checklist).
//   * Sem dado pessoal: nenhum nome, telefone, hash de entregador ou identificador interno.
const STATUS_USAVEL = new Set(["CONSOLIDADO", "CORRIGIDO", "INCOMPLETO"]);
const moeda = (n) => `R$ ${Number(n ?? 0).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
export const TITULO_BLOCO = "*Logística (Foody)*";

export function ultimaVersao(fechamentos, competencia) {
  let m = null;
  for (const f of fechamentos ?? []) {
    if (String(f.competencia).slice(0, 10) !== competencia) continue;
    if (!m || Number(f.versao) > Number(m.versao)) m = f;
  }
  return m;
}

function bloco(indicadores) {
  if (!indicadores) return null;
  const op = indicadores.operacao ?? "subway";
  return indicadores[op] ?? null;
}

function rotuloEstado(f) {
  if (f.status === "INCOMPLETO") return "dados incompletos";
  return f.estado_valores === "SINCRONIZADO" || f.estado_valores === "CONCILIADO" || f.estado_valores === "CUSTO_REAL" ? "valores sincronizados" : "valores provisórios";
}

/** @returns {string[]|null} linhas do bloco diário, ou null quando não há fechamento usável do dia */
export function linhasLogisticaDiaria({ fechamentos, competencia, incluirValores = false }) {
  const f = ultimaVersao(fechamentos, competencia);
  if (!f || !STATUS_USAVEL.has(f.status)) return null;
  const b = bloco(f.indicadores);
  if (!b?.total) return null;
  const t = b.total;
  const linhas = [`${TITULO_BLOCO} — fechamento logístico v${Number(f.versao)}, ${rotuloEstado(f)}`,
    `• Entregas: ${Number(t.entregues ?? 0)} de ${Number(t.pedidos ?? 0)} pedidos com entregador`];
  if (Number(t.cancelados) > 0) linhas.push(`• Cancelados: ${Number(t.cancelados)}`);
  if (incluirValores) {
    linhas.push(`• Taxa válida: ${moeda(t.taxasValidas)} (bruta ${moeda(t.taxasBrutas)})`);
    if (b.custoLogisticoProprio != null) linhas.push(`• Custo atribuído a entregadores próprios: ${moeda(b.custoLogisticoProprio)}`);
  }
  return linhas;
}

/** Semana: soma só a última versão de cada dia; dias sem fechamento são declarados (nunca estimados). */
export function linhasLogisticaSemanal({ fechamentos, dias, incluirValores = false }) {
  let pedidos = 0, entregues = 0, taxaValida = 0, taxaBruta = 0, custo = 0, cobertos = 0, provisorio = false;
  for (const d of dias ?? []) {
    const f = ultimaVersao(fechamentos, d);
    if (!f || !STATUS_USAVEL.has(f.status) || f.status === "INCOMPLETO") continue;
    const b = bloco(f.indicadores); if (!b?.total) continue;
    cobertos++;
    pedidos += Number(b.total.pedidos ?? 0); entregues += Number(b.total.entregues ?? 0);
    taxaValida += Number(b.total.taxasValidas ?? 0); taxaBruta += Number(b.total.taxasBrutas ?? 0); custo += Number(b.custoLogisticoProprio ?? 0);
    if (rotuloEstado(f) !== "valores sincronizados") provisorio = true;
  }
  if (!cobertos) return null;
  const linhas = [`${TITULO_BLOCO} — ${cobertos} de ${(dias ?? []).length} dias${provisorio ? ", valores provisórios" : ""}`,
    `• Entregas: ${entregues} de ${pedidos} pedidos com entregador`];
  if (incluirValores) {
    linhas.push(`• Taxa válida: ${moeda(taxaValida)} (bruta ${moeda(taxaBruta)})`);
    linhas.push(`• Custo atribuído a entregadores próprios: ${moeda(custo)}`);
  }
  return linhas;
}

/** Quem recebe valores em R$: só os papéis com acesso financeiro do cadastro de destinatários. */
export const PAPEIS_COM_VALORES = Object.freeze(["principal", "financeiro"]);
export const recebeValores = (tipo) => PAPEIS_COM_VALORES.includes(String(tipo ?? ""));
