// Dashboard Operacional 2.0 — MENSAGEM DE WHATSAPP do fechamento (geração, validação e transporte SIMULADO).
//
// NESTA FASE NÃO EXISTE ENVIO REAL. Este módulo:
//   * NÃO importa whatsapp.service.js, provider, Baileys nem o gateway (teste arquitetural garante);
//   * só conhece o transporte `noop`: `criarTransporte` recusa qualquer outro nome, inclusive por variável de ambiente;
//   * a simulação é registrada em operacional_mensagens_simuladas (transporte = 'noop' por CHECK no banco) e NUNCA conta como
//     mensagem entregue — o histórico real (comunicacao_mensagens) não é tocado.
//
// A mensagem usa SÓ os números do fechamento armazenado (mesma versão do PDF/Excel/Dashboard). Indicador indisponível aparece
// como "não disponível" — nunca é inventado. Nenhum dado de cliente entra (não existe na projeção).

import { createHash } from "node:crypto";

export const LIMITE_CARACTERES = 1500;           // objetiva para celular (o gateway aceitaria 4096)
export const TRANSPORTE_SIMULADO = "noop";
export const STATUS_SIMULACAO = Object.freeze({
  SIMULATED: "SIMULATED", READY_FOR_REVIEW: "READY_FOR_REVIEW", BLOCKED: "BLOCKED", ERROR: "ERROR",
});

const ROTULO_STATUS = Object.freeze({
  PRELIMINAR: "PRELIMINAR (números parciais)", CONSOLIDADO: "CONSOLIDADO", REVISADO: "REVISADO (corrige versão anterior)",
  INCOMPLETO: "INCOMPLETO (dados insuficientes)",
});

const fmt = (v, casas = 1) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas }));
const brl = (v) => (v == null ? null : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const dataBr = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const hh = (h) => `${String(h).padStart(2, "0")}h`;
const ND = "não disponível";

function linhaTempo(t) {
  if (!t || t.estado !== "calculado") return `${t?.nome ?? "Etapa"}: ${ND}`;
  const meta = t.meta == null ? "sem meta" : `meta ${fmt(t.meta)} min`;
  const sinal = t.desvioDaMetaMin == null ? "" : t.desvioDaMetaMin > 0 ? ` ⚠️ +${fmt(t.desvioDaMetaMin)}` : " ✅";
  return `${t.nome}: ${fmt(t.media)} min (${meta}; ${t.amostras} pedidos)${sinal}`;
}

/**
 * @param {{fechamento: object, unidadeNome?: string|null, link?: string|null}} p  `fechamento` = linha armazenada
 *   (indicadores, diagnostico, status, competencia, versao). `link` só entra se for URL https válida.
 */
export function gerarMensagem({ fechamento, unidadeNome = null, link = null }) {
  const i = fechamento.indicadores;
  const d = fechamento.diagnostico ?? {};
  const p = i.pedidos;
  const a = i.atrasos;
  const c = i.cancelamentos;
  const ds = i.disputas;
  const de = i.descontos;
  const cl = i.clientes;
  const motivos = (c.motivos ?? []).slice(0, 2).map((m) => `${m.descricao ?? m.codigo} (${m.quantidade})`);
  const picos = (i.movimento.picos ?? []).slice(0, 2).map((h) => `${hh(h.hora)}–${hh((h.hora + 1) % 24)} (${h.pedidos})`);

  const linhas = [
    "*CRESCER COM DELIVERY*",
    "Fechamento operacional",
    `${unidadeNome ? `${unidadeNome} · ` : ""}${dataBr(fechamento.competencia)} · v${fechamento.versao}`,
    `Situação: *${ROTULO_STATUS[fechamento.status] ?? fechamento.status}*`,
    "",
    "*PEDIDOS*",
    `Recebidos: ${p.recebidos} · Concluídos no dia: ${p.concluidosNoDia} · Cancelados no dia: ${p.canceladosNoDia}`,
    "",
    "*TEMPOS (médias)*",
    linhaTempo(i.preparo), linhaTempo(i.entrega), linhaTempo(i.vida),
    "",
    "*ATRASOS*",
    a.pedidosAvaliados ? `${a.pedidosAtrasados} de ${a.pedidosAvaliados} pedidos (${fmt(a.pct)}%)${a.principalEtapa ? ` · mais atrasos em: ${a.principalEtapa.nome.toLowerCase()}` : ""}` : `Sem pedidos avaliados contra meta (${ND}).`,
    "",
    "*MOVIMENTO*",
    picos.length ? `Pico: ${picos.join(", ")}` : `Sem pedidos no dia.`,
    "",
    "*CANCELAMENTOS*",
    c.total ? `${c.total} no dia${motivos.length ? ` · ${motivos.join("; ")}` : ""}` : "Nenhum cancelamento no dia.",
    "",
    "*DISPUTAS*",
    `Abertas: ${ds.abertasNoDia} · Expiradas: ${ds.expiradasNoDia}${ds.pendentesAgora ? ` · Aguardando resposta: ${ds.pendentesAgora}` : ""}`,
    "",
    "*DESCONTOS*",
    de.pedidosNaBase ? `Financiados pela loja: ${brl(de.loja)} em ${de.pedidosComDescontoLoja} pedidos (valor operacional)` : `${ND}`,
    "",
    "*CLIENTES*",
    cl.base && (cl.novos + cl.recorrentes) ? `Novos: ${cl.novos} · Recorrentes: ${cl.recorrentes}${cl.semInformacao ? ` · Sem informação: ${cl.semInformacao}` : ""}` : `${ND}`,
    "",
    "*DIAGNÓSTICO*",
    d.texto?.diagnostico ?? d.principal?.fato ?? ND,
    "",
    "*AÇÃO RECOMENDADA*",
    d.texto?.acao ?? d.principal?.acao ?? ND,
  ];
  if (typeof link === "string" && /^https:\/\/[^\s]+$/.test(link)) linhas.push("", "*RELATÓRIO COMPLETO*", link);
  return linhas.join("\n");
}

// Padrões que NUNCA podem sair numa mensagem: telefone, e-mail, CPF, UUID (id interno/orderId).
const PADROES_PROIBIDOS = Object.freeze([
  { codigo: "TELEFONE", re: /(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/ },
  { codigo: "EMAIL", re: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { codigo: "CPF", re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/ },
  { codigo: "ID_INTERNO", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
]);

/** @returns {{ok: boolean, problemas: {codigo: string, mensagem: string}[], tamanho: number}} */
export function validarMensagem(texto, { fechamento } = {}) {
  const problemas = [];
  const t = String(texto ?? "");
  if (!t.trim()) problemas.push({ codigo: "VAZIA", mensagem: "Mensagem vazia." });
  if (t.length > LIMITE_CARACTERES) problemas.push({ codigo: "LONGA_DEMAIS", mensagem: `Mensagem com ${t.length} caracteres (limite ${LIMITE_CARACTERES}).` });
  for (const p of PADROES_PROIBIDOS) if (p.re.test(t)) problemas.push({ codigo: `DADO_PROIBIDO_${p.codigo}`, mensagem: "A mensagem contém um padrão de dado pessoal ou identificador interno." });
  if (fechamento && !t.includes(fechamento.status)) problemas.push({ codigo: "SEM_STATUS", mensagem: "A mensagem precisa informar a situação do fechamento." });
  if (fechamento && !fechamento.indicadores) problemas.push({ codigo: "SEM_INDICADORES", mensagem: "Fechamento sem indicadores." });
  return { ok: problemas.length === 0, problemas, tamanho: t.length };
}

/** Chave de idempotência da simulação: mesmo fechamento + mesma mensagem = mesma tentativa (nunca duplicada). */
export const chaveSimulacao = (fechamentoId, texto) => `whatsapp-sim:${fechamentoId}:${createHash("sha256").update(String(texto)).digest("hex").slice(0, 32)}`;

/** O ÚNICO transporte desta funcionalidade. Não faz rede, não grava, não chama provider. */
export const transporteNoop = Object.freeze({
  nome: TRANSPORTE_SIMULADO,
  real: false,
  async enviar() { return { simulado: true, entregue: false }; },
});

/** Recusa qualquer transporte que não seja o simulado (proteção contra disparo acidental em jobs, testes e agendamentos). */
export function criarTransporte(nome = TRANSPORTE_SIMULADO) {
  if (nome !== TRANSPORTE_SIMULADO) {
    const e = new Error(`Transporte "${nome}" recusado: o fechamento operacional só simula envios nesta fase.`);
    e.codigo = "TRANSPORTE_REAL_BLOQUEADO";
    throw e;
  }
  return transporteNoop;
}
