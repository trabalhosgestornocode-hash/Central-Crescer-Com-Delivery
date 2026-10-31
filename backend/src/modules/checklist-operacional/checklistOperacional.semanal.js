// Dashboard Operacional — RESUMO SEMANAL (agregação dos fechamentos DIÁRIOS armazenados). Módulo PURO: sem banco, sem rede, sem provider.
//
// Regras (mesmo espírito do fechamento diário):
//   * a semana operacional é segunda a domingo; o resumo só nasce de uma semana ENCERRADA (nunca da semana em curso);
//   * usa SÓ fechamentos já armazenados e válidos (CONSOLIDADO/REVISADO, a versão mais recente de cada dia) — nada é recalculado a partir
//     de eventos, nada é preenchido: dia sem fechamento válido fica de fora e é declarado;
//   * exige cobertura mínima (MIN_DIAS_VALIDOS de 7); abaixo disso a semana é INCOMPLETA e NÃO gera mensagem (nunca vira "sem problema");
//   * médias de tempo são PONDERADAS pelo número de pedidos de cada dia (nunca média de médias); razões somam numeradores e denominadores;
//   * nenhum responsável é atribuído e nenhum dado pessoal entra (os fechamentos não têm nenhum).
import { createHash } from "node:crypto";
import { validarMensagem, LIMITE_CARACTERES } from "./checklistOperacional.whatsapp.js";

export const MIN_DIAS_VALIDOS = 5;
export const STATUS_SEMANA = Object.freeze({ COMPLETA: "COMPLETA", PARCIAL: "PARCIAL", INCOMPLETA: "INCOMPLETA" });
const STATUS_VALIDOS = new Set(["CONSOLIDADO", "REVISADO"]);
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const DIA_MS = 86_400_000;
const paraMs = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const paraIso = (ms) => new Date(ms).toISOString().slice(0, 10);
const dataBr = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const fmt = (v, casas = 1) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas }));
const ND = "não disponível";
const NOMES_DIA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

/** Segunda-feira da semana que contém a data (ISO yyyy-mm-dd). */
export function segundaDaSemana(iso) {
  if (!RE_DATA.test(String(iso))) throw new Error("data inválida");
  const ms = paraMs(iso); const dow = new Date(ms).getUTCDay();   // 0 = domingo
  return paraIso(ms - ((dow + 6) % 7) * DIA_MS);
}
/** Os 7 dias (segunda a domingo) da semana que começa em `segunda`. */
export const diasDaSemana = (segunda) => Array.from({ length: 7 }, (_, i) => paraIso(paraMs(segunda) + i * DIA_MS));
/** Última semana ENCERRADA em relação a `hojeIso` (a semana em curso nunca é resumida). */
export const ultimaSemanaEncerrada = (hojeIso) => paraIso(paraMs(segundaDaSemana(hojeIso)) - 7 * DIA_MS);

/** Do conjunto de versões armazenadas, a MAIS RECENTE VÁLIDA de cada dia da semana. */
export function fechamentosValidosDaSemana(segunda, versoes) {
  const dias = diasDaSemana(segunda); const porDia = new Map();
  for (const f of versoes ?? []) {
    if (!f || !dias.includes(f.competencia) || !STATUS_VALIDOS.has(f.status) || !f.indicadores) continue;
    const atual = porDia.get(f.competencia);
    if (!atual || Number(f.versao) > Number(atual.versao)) porDia.set(f.competencia, f);
  }
  return dias.map((d) => ({ dia: d, fechamento: porDia.get(d) ?? null }));
}

const soma = (xs) => xs.reduce((s, x) => s + (Number(x) || 0), 0);
function tempoPonderado(dias, chave) {
  const ok = dias.map((d) => d.fechamento.indicadores[chave]).filter((t) => t?.estado === "calculado" && Number(t.amostras) > 0 && Number.isFinite(Number(t.media)));
  const n = soma(ok.map((t) => t.amostras));
  if (!n) return { estado: "indisponivel", amostras: 0, media: null };
  return { estado: "calculado", amostras: n, media: soma(ok.map((t) => Number(t.media) * Number(t.amostras))) / n, diasComDado: ok.length };
}

/**
 * @param {string} segunda  segunda-feira da semana
 * @param {Array<object>} versoes  versões armazenadas dos fechamentos diários da unidade (qualquer ordem)
 * @param {{minimoDias?: number}} [opcoes]
 */
export function resumirSemana(segunda, versoes, { minimoDias = MIN_DIAS_VALIDOS } = {}) {
  const porDia = fechamentosValidosDaSemana(segunda, versoes);
  const validos = porDia.filter((d) => d.fechamento);
  const ausentes = porDia.filter((d) => !d.fechamento).map((d) => d.dia);
  const status = validos.length < minimoDias ? STATUS_SEMANA.INCOMPLETA : validos.length === 7 ? STATUS_SEMANA.COMPLETA : STATUS_SEMANA.PARCIAL;
  const base = { semanaInicio: segunda, semanaFim: diasDaSemana(segunda)[6], status, diasValidos: validos.length, diasAusentes: ausentes, minimoDias };
  if (status === STATUS_SEMANA.INCOMPLETA) return { ...base, indicadores: null, hash: hashDe(base, []) };

  const I = (d) => d.fechamento.indicadores;
  const avaliados = soma(validos.map((d) => I(d).atrasos?.pedidosAvaliados));
  const atrasados = soma(validos.map((d) => I(d).atrasos?.pedidosAtrasados));
  const motivos = new Map();
  for (const d of validos) for (const m of I(d).cancelamentos?.motivos ?? []) { const k = m.descricao ?? m.codigo; motivos.set(k, (motivos.get(k) ?? 0) + (Number(m.quantidade) || 0)); }
  const recebidosPorDia = validos.map((d) => ({ dia: d.dia, recebidos: Number(I(d).pedidos?.recebidos) || 0 }));
  const maior = [...recebidosPorDia].sort((a, b) => b.recebidos - a.recebidos || a.dia.localeCompare(b.dia))[0];
  const indicadores = {
    pedidos: { recebidos: soma(validos.map((d) => I(d).pedidos?.recebidos)), concluidos: soma(validos.map((d) => I(d).pedidos?.concluidosNoDia)), cancelados: soma(validos.map((d) => I(d).pedidos?.canceladosNoDia)) },
    preparo: tempoPonderado(validos, "preparo"), entrega: tempoPonderado(validos, "entrega"), vida: tempoPonderado(validos, "vida"),
    atrasos: { pedidosAvaliados: avaliados, pedidosAtrasados: atrasados, pct: avaliados ? (atrasados / avaliados) * 100 : null },
    cancelamentos: { total: soma(validos.map((d) => I(d).cancelamentos?.total)), motivos: [...motivos].map(([descricao, quantidade]) => ({ descricao, quantidade })).sort((a, b) => b.quantidade - a.quantidade || a.descricao.localeCompare(b.descricao)).slice(0, 3) },
    disputas: { abertas: soma(validos.map((d) => I(d).disputas?.abertasNoDia)), expiradas: soma(validos.map((d) => I(d).disputas?.expiradasNoDia)) },
    descontosLoja: { valor: soma(validos.map((d) => I(d).descontos?.loja)), pedidos: soma(validos.map((d) => I(d).descontos?.pedidosComDescontoLoja)) },
    diaDeMaiorMovimento: maior && maior.recebidos > 0 ? { dia: maior.dia, recebidos: maior.recebidos } : null,
  };
  return { ...base, indicadores, hash: hashDe(base, validos) };
}
// o hash muda se mudar qualquer versão de qualquer dia usada (uma correção diária gera um resumo REVISADO, nunca silencioso)
const hashDe = (base, validos) => createHash("sha256").update(JSON.stringify([base.semanaInicio, base.status, validos.map((d) => [d.dia, d.fechamento.id ?? null, d.fechamento.versao ?? null, d.fechamento.hash_conteudo ?? null])])).digest("hex").slice(0, 32);

/** Mensagem do resumo semanal (objetiva, ≤ 1500). Semana INCOMPLETA NÃO gera mensagem. */
export function gerarMensagemSemanal({ resumo, unidadeNome = null }) {
  if (!resumo || resumo.status === STATUS_SEMANA.INCOMPLETA || !resumo.indicadores) return null;
  const i = resumo.indicadores;
  const tempo = (nome, t) => (t.estado === "calculado" ? `${nome}: ${fmt(t.media)} min (${t.amostras} pedidos)` : `${nome}: ${ND}`);
  const situacao = resumo.status === STATUS_SEMANA.COMPLETA ? "SEMANA COMPLETA (7/7 dias)" : `SEMANA PARCIAL (${resumo.diasValidos}/7 dias; sem fechamento válido: ${resumo.diasAusentes.map((d) => `${NOMES_DIA[new Date(paraMs(d)).getUTCDay()]} ${dataBr(d)}`).join(", ")})`;
  const linhas = [
    "*CRESCER COM DELIVERY*", "Resumo semanal",
    `${unidadeNome ? `${unidadeNome} · ` : ""}${dataBr(resumo.semanaInicio)} a ${dataBr(resumo.semanaFim)}`,
    `Situação: *${situacao}*`, "",
    "*PEDIDOS*", `Recebidos: ${i.pedidos.recebidos} · Concluídos: ${i.pedidos.concluidos} · Cancelados: ${i.pedidos.cancelados}`,
    i.diaDeMaiorMovimento ? `Maior movimento: ${NOMES_DIA[new Date(paraMs(i.diaDeMaiorMovimento.dia)).getUTCDay()]} ${dataBr(i.diaDeMaiorMovimento.dia)} (${i.diaDeMaiorMovimento.recebidos})` : "Sem pedidos na semana.", "",
    "*TEMPOS (médias ponderadas)*", tempo("Preparo", i.preparo), tempo("Entrega", i.entrega), tempo("Vida do pedido", i.vida), "",
    "*ATRASOS*", i.atrasos.pedidosAvaliados ? `${i.atrasos.pedidosAtrasados} de ${i.atrasos.pedidosAvaliados} pedidos (${fmt(i.atrasos.pct)}%)` : `Sem pedidos avaliados contra meta (${ND}).`, "",
    "*CANCELAMENTOS*", i.cancelamentos.total ? `${i.cancelamentos.total} na semana · ${i.cancelamentos.motivos.map((m) => `${m.descricao} (${m.quantidade})`).join("; ")}` : "Nenhum cancelamento na semana.", "",
    "*DISPUTAS*", `Abertas: ${i.disputas.abertas} · Expiradas: ${i.disputas.expiradas}`,
  ];
  return linhas.join("\n");
}

/** Validação da mensagem semanal: mesmos bloqueios do diário (telefone, e-mail, CPF, UUID, tamanho) + exige a situação da semana. */
export function validarMensagemSemanal(texto, resumo) {
  const v = validarMensagem(texto);
  const problemas = [...v.problemas];
  if (resumo && !String(texto ?? "").includes("SEMANA")) problemas.push({ codigo: "SEM_STATUS", mensagem: "A mensagem precisa informar a situação da semana." });
  return { ok: problemas.length === 0, problemas, tamanho: v.tamanho, limite: LIMITE_CARACTERES };
}

/** Chave de idempotência por unidade + semana + destinatário + conteúdo: a mesma semana/versão nunca vai duas vezes ao mesmo destinatário. */
export const chaveSemanal = (unidadeId, semanaInicio, destinatarioId, resumoHash) => `wa:sem:${unidadeId}:${semanaInicio}:${destinatarioId}:${resumoHash}`;
