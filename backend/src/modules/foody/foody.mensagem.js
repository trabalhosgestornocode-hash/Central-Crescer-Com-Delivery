// Bloco LOGÍSTICO (Foody) dos relatórios diário e semanal do Checklist — PURO (sem banco, rede nem relógio).
//
//   * Cada empresa vê só os PRÓPRIOS indicadores: o bloco recebe apenas os fechamentos do tenant do relatório (Subway na Subway,
//     Açaí no Açaí, pelo bloco da operação gravada no fechamento). Outras operações e triagem nunca aparecem.
//   * Valores em R$ só para quem tem permissão financeira (`incluirValores`); os demais recebem só contagens.
//   * O bloco carrega a VERSÃO usada ("fechamento logístico v2"): é uma fotografia do momento do enfileiramento. Uma versão nova
//     depois disso NÃO gera mensagem corretiva (a chave de idempotência continua sendo a do fechamento do Checklist).
//   * Sem dado pessoal: nenhum nome, telefone, hash de entregador ou identificador interno.
//   * Pendência NUNCA parece fechamento: só o fechamento DEFINITIVO (fechamentoDefinitivo — status E estado) mostra R$ e entra
//     na soma semanal. PRELIMINAR / PROVISORIO / INCOMPLETO aparecem como "não fechado", só com contagens e a quantidade de
//     pendências; a semana declara quantos dias ficaram fora da soma.
import { fechamentoDefinitivo } from "./foody.constants.js";

const STATUS_CONHECIDO = new Set(["CONSOLIDADO", "CORRIGIDO", "INCOMPLETO", "PRELIMINAR"]);
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
  if (fechamentoDefinitivo(f)) return "valores sincronizados";
  if (f.status === "INCOMPLETO") return "dados incompletos, não fechado";
  return "preliminar com pendências, não fechado";
}
const qtdPendencias = (f) => (Array.isArray(f.pendencias) ? f.pendencias.length : 0);

/** @returns {string[]|null} linhas do bloco diário, ou null quando não há fechamento do dia */
export function linhasLogisticaDiaria({ fechamentos, competencia, incluirValores = false }) {
  const f = ultimaVersao(fechamentos, competencia);
  if (!f || !STATUS_CONHECIDO.has(f.status)) return null;
  const b = bloco(f.indicadores);
  if (!b?.total) return null;
  const t = b.total;
  const definitivo = fechamentoDefinitivo(f);
  const linhas = [`${TITULO_BLOCO} — fechamento logístico v${Number(f.versao)}, ${rotuloEstado(f)}`,
    `• Entregas: ${Number(t.entregues ?? 0)} de ${Number(t.pedidos ?? 0)} pedidos com entregador`];
  if (Number(t.cancelados) > 0) linhas.push(`• Cancelados: ${Number(t.cancelados)}`);
  if (!definitivo) {
    const n = qtdPendencias(f);
    linhas.push(`• Pendências em aberto: ${n > 0 ? n : "a revisar"}`);
    if (incluirValores) linhas.push("• Valores em R$ só após o fechamento definitivo");
    return linhas;
  }
  if (incluirValores) {
    linhas.push(`• Taxa válida: ${moeda(t.taxasValidas)} (bruta ${moeda(t.taxasBrutas)})`);
    if (b.custoLogisticoProprio != null) linhas.push(`• Custo atribuído a entregadores próprios: ${moeda(b.custoLogisticoProprio)}`);
  }
  return linhas;
}

/** Semana: soma só a última versão DEFINITIVA de cada dia; dias pendentes/incompletos são declarados fora da soma (nunca estimados). */
export function linhasLogisticaSemanal({ fechamentos, dias, incluirValores = false }) {
  let pedidos = 0, entregues = 0, taxaValida = 0, taxaBruta = 0, custo = 0, cobertos = 0, foraDaSoma = 0;
  for (const d of dias ?? []) {
    const f = ultimaVersao(fechamentos, d);
    if (!f || !STATUS_CONHECIDO.has(f.status)) continue;
    const b = bloco(f.indicadores); if (!b?.total) continue;
    if (!fechamentoDefinitivo(f)) { foraDaSoma++; continue; }
    cobertos++;
    pedidos += Number(b.total.pedidos ?? 0); entregues += Number(b.total.entregues ?? 0);
    taxaValida += Number(b.total.taxasValidas ?? 0); taxaBruta += Number(b.total.taxasBrutas ?? 0); custo += Number(b.custoLogisticoProprio ?? 0);
  }
  if (!cobertos && !foraDaSoma) return null;
  const linhas = [`${TITULO_BLOCO} — ${cobertos} de ${(dias ?? []).length} dias fechados`];
  if (foraDaSoma) linhas.push(`• Fora da soma: ${foraDaSoma} ${foraDaSoma === 1 ? "dia" : "dias"} com pendência ou dados incompletos`);
  if (!cobertos) return linhas;
  linhas.push(`• Entregas: ${entregues} de ${pedidos} pedidos com entregador`);
  if (incluirValores) {
    linhas.push(`• Taxa válida: ${moeda(taxaValida)} (bruta ${moeda(taxaBruta)})`);
    linhas.push(`• Custo atribuído a entregadores próprios: ${moeda(custo)}`);
  }
  return linhas;
}

/** Quem recebe valores em R$: só os papéis com acesso financeiro do cadastro de destinatários. */
export const PAPEIS_COM_VALORES = Object.freeze(["principal", "financeiro"]);
export const recebeValores = (tipo) => PAPEIS_COM_VALORES.includes(String(tipo ?? ""));
