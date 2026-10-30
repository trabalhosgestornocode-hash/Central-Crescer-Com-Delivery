// Dashboard Operacional 2.0 — REDAÇÃO do diagnóstico (camada de IA sobre o motor determinístico).
//
// A IA recebe SÓ os achados já comprovados (checklistOperacional.diagnostico.js) e devolve dois textos curtos: o diagnóstico
// em linguagem gerencial e UMA ação, escolhida entre as ações da biblioteca. Ela não cria achados, números, causas,
// responsáveis, eventos nem impactos. Garantias:
//   * DESLIGADA por padrão (OPERACIONAL_DIAGNOSTICO_IA_ENABLED=true liga); sem chave, sem cota ou com erro → texto determinístico;
//   * cota por organização pela MESMA reserva atômica do Agente Crescer (agente_reservar_quota) — fail-closed;
//   * VERIFICAÇÃO da saída: todo número do texto precisa existir nos achados; a ação precisa ser uma das ações dos achados;
//     palavras de causa/culpa são recusadas. Reprovou → texto determinístico (e o motivo fica registrado);
//   * nenhum dado pessoal entra no prompt (os achados não têm nenhum).

import { textoDeterministico } from "./checklistOperacional.diagnostico.js";

export const COTA_DIARIA_IA_POR_ORGANIZACAO = 60;
const PROIBIDAS = /\b(culpa|culpad[oa]s?|respons[aá]vel\s+pel[oa]|por\s+causa\s+d[eoa]s?|devido\s+(a|ao|à)|causad[oa]\s+por|porque)\b/i;

export const iaHabilitada = (env = process.env) => env.OPERACIONAL_DIAGNOSTICO_IA_ENABLED === "true";

/** Números de um texto, normalizados ("1.234,5" e "1234.5" → "1234.5"). Horas "19h" contam como 19. */
export function numerosDo(texto) {
  const out = new Set();
  for (const m of String(texto ?? "").matchAll(/\d+(?:[.,]\d+)*/g)) {
    let s = m[0];
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");   // pt-BR com decimal
    else s = s.replace(/[.,](?=\d{3}\b)/g, "");                             // separador de milhar
    const n = Number(s);
    if (Number.isFinite(n)) out.add(String(n));
  }
  return out;
}

/** A saída da IA só pode conter números que já estão nos achados. */
export function verificarRedacao({ diagnostico, acao }, diag) {
  const permitidos = new Set();
  for (const a of diag.achados.length ? diag.achados : [diag.principal]) {
    for (const campo of [a.fato, a.titulo, a.referencia, String(a.amostra ?? "")]) for (const n of numerosDo(campo)) permitidos.add(n);
  }
  const problemas = [];
  for (const n of numerosDo(diagnostico)) if (!permitidos.has(n)) problemas.push(`número sem evidência: ${n}`);
  const acoesValidas = new Set((diag.achados.length ? diag.achados : [diag.principal]).map((a) => a.acao).filter(Boolean));
  if (!acoesValidas.has(acao)) problemas.push("ação fora da biblioteca dos achados");
  if (PROIBIDAS.test(diagnostico) || PROIBIDAS.test(acao)) problemas.push("atribuição de causa ou culpa");
  if (!diagnostico || diagnostico.length > 600) problemas.push("diagnóstico vazio ou longo demais");
  return { ok: problemas.length === 0, problemas };
}

const SISTEMA = [
  "Você redige o diagnóstico de um fechamento operacional diário de restaurante, para o gerente.",
  "Use SOMENTE os achados fornecidos (JSON). Não acrescente números, percentuais, causas, culpados, motivos, eventos ou impactos financeiros.",
  "Não use as palavras 'porque', 'devido a', 'causado por', 'culpa' ou 'responsável'. Fatos, não explicações.",
  "Responda APENAS com JSON: {\"diagnostico\": \"até 2 frases, português do Brasil\", \"acao\": \"copie EXATAMENTE uma das ações dos achados\"}.",
].join(" ");

/**
 * @param {{diag: object, organizacaoId: string, unidadeId: string}} p
 * @param {{env?: object, enviarMensagem?: Function, reservarQuota?: Function, registrarUso?: Function}} deps
 * @returns {Promise<{diagnostico: string, acao: string, origem: 'ia'|'deterministico', motivoFallback?: string, problemas?: string[]}>}
 */
export async function redigirDiagnostico({ diag, organizacaoId, unidadeId }, deps = {}) {
  const base = textoDeterministico(diag);
  const env = deps.env ?? process.env;
  if (!iaHabilitada(env)) return { ...base, motivoFallback: "ia_desligada" };
  if (!deps.enviarMensagem || !deps.reservarQuota) return { ...base, motivoFallback: "ia_sem_dependencias" };

  const reserva = await deps.reservarQuota([{ escopo: "org", chave: `operacional-fechamento:${organizacaoId}`, janelaSegundos: 86_400, limite: COTA_DIARIA_IA_POR_ORGANIZACAO }])
    .catch(() => ({ resultado: "falha_infra" }));
  if (reserva?.resultado !== "ok") return { ...base, motivoFallback: `cota_${reserva?.resultado ?? "indisponivel"}` };

  const achados = (diag.achados.length ? diag.achados : [diag.principal]).map((a) => ({
    titulo: a.titulo, fato: a.fato, referencia: a.referencia, amostra: a.amostra, severidade: a.severidade, confianca: a.confianca, acao: a.acao,
  }));
  const inicio = Date.now();
  let resposta;
  try {
    resposta = await deps.enviarMensagem({ system: SISTEMA, messages: [{ role: "user", content: JSON.stringify({ achados }) }], tools: [] });
  } catch (e) {
    return { ...base, motivoFallback: "ia_erro" };
  } finally {
    // Uso registrado como no Agente Crescer (custo por organização); falha de registro nunca derruba o fechamento.
    if (deps.registrarUso && resposta) {
      Promise.resolve(deps.registrarUso({ organizacaoId, unidadeId, model: resposta.model ?? null, usage: resposta.usage ?? null, durationMs: Date.now() - inicio })).catch(() => {});
    }
  }
  const texto = (resposta?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("").trim();
  let saida;
  try { saida = JSON.parse(texto.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return { ...base, motivoFallback: "ia_resposta_invalida" }; }
  const redacao = { diagnostico: String(saida?.diagnostico ?? "").trim(), acao: String(saida?.acao ?? "").trim() };
  const v = verificarRedacao(redacao, diag);
  if (!v.ok) return { ...base, motivoFallback: "ia_reprovada_na_verificacao", problemas: v.problemas };
  return { ...redacao, origem: "ia" };
}
