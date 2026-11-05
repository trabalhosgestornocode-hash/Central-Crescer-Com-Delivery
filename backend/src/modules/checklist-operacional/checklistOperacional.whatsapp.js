// Dashboard Operacional 2.0 — MENSAGEM DE WHATSAPP do fechamento (geração, validação e transporte SIMULADO).
//
// NESTA FASE NÃO EXISTE ENVIO REAL. Este módulo:
//   * NÃO importa whatsapp.service.js, provider, Baileys nem o gateway (teste arquitetural garante);
//   * só conhece o transporte `noop`: `criarTransporte` recusa qualquer outro nome, inclusive por variável de ambiente;
//   * a simulação é registrada em operacional_mensagens_simuladas (transporte = 'noop' por CHECK no banco) e NUNCA conta como
//     mensagem entregue — o histórico real (comunicacao_mensagens) não é tocado.
//
// Formato (v2): cabeçalho com unidade e situação, seções em negrito com marcadores "•", rodapé em itálico — sintaxe nativa do WhatsApp.
// As negociações do iFood aparecem como CHAMADOS (apresentação; nada interno é renomeado).
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
  PRELIMINAR: "Fechamento PRELIMINAR (números parciais)", CONSOLIDADO: "Fechamento consolidado", REVISADO: "Fechamento REVISADO (corrige versão anterior)",
  INCOMPLETO: "Fechamento INCOMPLETO (dados insuficientes)",
});
/** Rótulo da situação exibido na mensagem (a validação exige que ele apareça). */
export const rotuloStatus = (status) => ROTULO_STATUS[status] ?? `Fechamento ${status}`;

const fmt = (v, casas = 1) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas }));
const brl = (v) => (v == null ? null : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const dataBr = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const hh = (h) => `${String(h).padStart(2, "0")}h`;
const ND = "não disponível";
const ETAPAS = ["preparo", "entrega", "vida"];
const ROTULO_TEMPO = { preparo: "Tempo médio de preparo", entrega: "Tempo médio de entrega", vida: "Tempo total do pedido" };
const ORDINAL_PICO = ["Maior pico", "Segundo pico", "Terceiro pico"];
export const RODAPE = "_Crescer com Delivery | Inteligência operacional_";

// NOMENCLATURA PARA O CLIENTE: as negociações do iFood (internamente "disputas", tabela ifood_disputas) aparecem como CHAMADOS.
// Só a apresentação muda; nenhum identificador interno é renomeado. Expiração ≠ "sem resposta": o dado comprova só o desfecho EXPIRED.
export const TERMO_INTERNO_PROIBIDO = /disput/i;
export const RECOMENDACAO_CHAMADOS = Object.freeze({
  DISPUTAS_PENDENTES: "Responda os chamados abertos no Gestor de Pedidos do iFood antes do vencimento do prazo.",
  DISPUTAS_EXPIRADAS: "Reforce o acompanhamento da Plataforma de Negociação do iFood, especialmente nos horários de maior movimento, para evitar chamados com prazo expirado.",
});
export const pontoChamadosExpirados = (n) => (n === 1 ? "Um chamado atingiu o prazo de expiração." : `${n} chamados atingiram o prazo de expiração.`);
export const pontoChamadosPendentes = (n) => (n === 1 ? "Um chamado aguarda resposta dentro do prazo." : `${n} chamados aguardam resposta dentro do prazo.`);
export const PONTO_SEM_METAS = "Metas de tempo não configuradas.";
/** Nome da unidade sem caracteres que quebram a formatação do WhatsApp. */
export const nomeSeguro = (s) => (s == null ? null : String(s).replace(/[*_~`]/g, "").trim() || null);
const MAX_PONTOS = 5;

function linhaTempo(etapa, t) {
  if (!t || t.estado !== "calculado") return `• ${ROTULO_TEMPO[etapa]}: ${ND}`;
  return `• ${ROTULO_TEMPO[etapa]}: ${fmt(t.media)} min${t.meta == null ? "" : ` (meta ${fmt(t.meta)} min)`}`;
}

/** Achados de natureza financeira: só vão a quem recebe INDICADORES FINANCEIROS (`incluirFinanceiro`). */
export const ACHADOS_FINANCEIROS = Object.freeze(["DESCONTO_LOJA_ELEVADO"]);
const ehFinanceiro = (a) => ACHADOS_FINANCEIROS.includes(String(a?.codigo ?? ""));

/** Pontos de atenção: chamados (pelos indicadores) + achados do diagnóstico armazenado (exceto os de chamados, já cobertos) + metas. */
function pontosDeAtencao(i, d, incluirFinanceiro = true) {
  const pontos = [];
  const ds = i.disputas ?? {};
  if (ds.pendentesAgora > 0) pontos.push(pontoChamadosPendentes(ds.pendentesAgora));
  if (ds.expiradasNoDia > 0) pontos.push(pontoChamadosExpirados(ds.expiradasNoDia));
  for (const a of d.achados ?? []) {
    if (!a?.titulo || String(a.codigo ?? "").startsWith("DISPUTAS_") || TERMO_INTERNO_PROIBIDO.test(a.titulo)) continue;
    if (!incluirFinanceiro && ehFinanceiro(a)) continue;
    pontos.push(`${a.titulo}.`);
  }
  const lista = pontos.slice(0, ETAPAS.every((e) => i[e]?.meta == null) ? MAX_PONTOS - 1 : MAX_PONTOS);
  if (ETAPAS.every((e) => i[e]?.meta == null)) lista.push(PONTO_SEM_METAS);
  return lista.length ? lista : ["Nenhum desvio relevante identificado com os dados disponíveis."];
}

/** Recomendação: a ação do achado principal (biblioteca aprovada); para chamados, o texto com a nomenclatura do cliente. */
function recomendacao(d, incluirFinanceiro = true) {
  if (!incluirFinanceiro && ehFinanceiro(d.principal)) {
    // Achado principal financeiro: usa a ação do primeiro achado não financeiro (nunca cita valor), senão "não disponível".
    const alt = (d.achados ?? []).find((a) => a?.acao && !ehFinanceiro(a) && !String(a.codigo ?? "").startsWith("DISPUTAS_"));
    return alt && !TERMO_INTERNO_PROIBIDO.test(alt.acao) ? alt.acao : ND;
  }
  const codigo = d.principal?.codigo;
  if (codigo && RECOMENDACAO_CHAMADOS[codigo]) return RECOMENDACAO_CHAMADOS[codigo];
  const texto = d.texto?.acao ?? d.principal?.acao ?? null;
  return texto && !TERMO_INTERNO_PROIBIDO.test(texto) ? texto : ND;
}

/**
 * @param {{fechamento: object, unidadeNome?: string|null, link?: string|null, incluirFinanceiro?: boolean}} p  `fechamento` = linha armazenada
 *   (indicadores, diagnostico, status, competencia, versao). `link` só entra se for URL https válida.
 *   `incluirFinanceiro=false` remove a seção INDICADORES FINANCEIROS inteira (destinatário sem acesso financeiro).
 */
export function gerarMensagem({ fechamento, unidadeNome = null, link = null, incluirFinanceiro = true }) {
  const i = fechamento.indicadores;
  const d = fechamento.diagnostico ?? {};
  const p = i.pedidos;
  const a = i.atrasos;
  const c = i.cancelamentos;
  const ds = i.disputas;
  const de = i.descontos;
  const cl = i.clientes;
  const nome = nomeSeguro(unidadeNome);
  const motivos = (c.motivos ?? []).slice(0, 2).map((m) => `${m.descricao ?? m.codigo}: ${m.quantidade}`);
  const picos = (i.movimento.picos ?? []).slice(0, 2).map((h, k) => `• ${ORDINAL_PICO[k]}: ${hh(h.hora)} às ${hh((h.hora + 1) % 24)} — ${h.pedidos} ${h.pedidos === 1 ? "pedido" : "pedidos"}`);

  const linhas = [
    "*CRESCER COM DELIVERY*",
    "*RELATÓRIO OPERACIONAL DIÁRIO*",
    "",
    ...(nome ? [`*${nome}*`] : []),
    `${dataBr(fechamento.competencia)} | ${rotuloStatus(fechamento.status)}`,
    "",
    "*RESUMO DO DIA*",
    `• Pedidos recebidos: ${p.recebidos}`,
    `• Pedidos concluídos: ${p.concluidosNoDia}`,
    `• Cancelamentos: ${p.canceladosNoDia}${p.canceladosNoDia && motivos.length ? ` (${motivos.join("; ")})` : ""}`,
    "",
    "*DESEMPENHO OPERACIONAL*",
    ...ETAPAS.map((e) => linhaTempo(e, i[e])),
    ...(a.pedidosAvaliados ? [`• Pedidos acima da meta: ${a.pedidosAtrasados} de ${a.pedidosAvaliados} (${fmt(a.pct)}%)`] : []),
    "",
    "*MOVIMENTO*",
    ...(picos.length ? picos : ["• Sem pedidos no dia."]),
    "",
    "*CLIENTES*",
    ...(cl.base && (cl.novos + cl.recorrentes)
      ? [`• Novos: ${cl.novos}`, `• Recorrentes: ${cl.recorrentes}`, ...(cl.semInformacao ? [`• Sem informação: ${cl.semInformacao}`] : [])]
      : [`• ${ND}`]),
    "",
    ...(incluirFinanceiro ? [
      "*INDICADORES FINANCEIROS*",
      ...(de.pedidosNaBase
        ? [`• Descontos financiados pela loja: ${brl(de.loja)}`, `• Pedidos com desconto: ${de.pedidosComDescontoLoja}`]
        : [`• Descontos financiados pela loja: ${ND}`]),
      "",
    ] : []),
    "*CHAMADOS*",
    `• Abertos no dia: ${ds.abertasNoDia}`,
    `• Com prazo expirado: ${ds.expiradasNoDia}`,
    "",
    "*PONTOS DE ATENÇÃO*",
    ...pontosDeAtencao(i, d, incluirFinanceiro).map((t) => `• ${t}`),
    "",
    "*RECOMENDAÇÃO*",
    recomendacao(d, incluirFinanceiro),
  ];
  if (typeof link === "string" && /^https:\/\/[^\s]+$/.test(link)) linhas.push("", "*RELATÓRIO COMPLETO*", link);
  linhas.push("", RODAPE);
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
  if (TERMO_INTERNO_PROIBIDO.test(t)) problemas.push({ codigo: "TERMO_INTERNO", mensagem: "Use CHAMADOS na mensagem ao cliente (o termo interno não pode aparecer)." });
  if (fechamento && !t.includes(rotuloStatus(fechamento.status))) problemas.push({ codigo: "SEM_STATUS", mensagem: "A mensagem precisa informar a situação do fechamento." });
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
