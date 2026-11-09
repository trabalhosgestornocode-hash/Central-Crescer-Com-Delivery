// Condições comerciais da EMPRESA por canal (comissão, taxas, promoções, tributos, entrega, outras deduções).
//
// Fonte única: `canais_venda` DA ORGANIZAÇÃO do contexto (nunca de outra, nunca um padrão embutido).
// Canal não configurado simplesmente NÃO aparece em `canais` (aparece em `ausentes`) — o simulador e o
// dashboard então marcam o cálculo como PARCIAL em vez de assumir percentual. Campo NULL = "não configurado",
// jamais zero: quem não tem taxa informa 0 de forma explícita.
// Percentuais trafegam como FRAÇÃO (0.27 = 27%), igual ao banco; a tela converte.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

export const CANAIS = ["balcao", "ifood", "uber", "app", "outro"];
export const RESPONSAVEIS_ENTREGA = ["loja", "plataforma", "terceiro"];
const MAX_OUTRAS = 10;

const frac = (v) => { const n = v === null || v === undefined || v === "" ? null : Number(v); return Number.isFinite(n) ? n : null; };
const validaFrac = (n) => n != null && n >= 0 && n < 1;

/** Puro: molda as linhas de canais_venda para a resposta da API. */
export function moldarCondicoes(linhas) {
  const canais = (linhas ?? [])
    .filter((l) => l.ativo !== false)
    .map((l) => ({
      canal: l.canal, comissao: Number(l.comissao_pct),
      taxas: frac(l.taxas_pct), promocao: frac(l.promocao_pct), tributos: frac(l.tributos_pct),
      entrega_responsavel: l.entrega_responsavel ?? null, entrega_custo: frac(l.entrega_custo),
      outras_deducoes: Array.isArray(l.outras_deducoes) ? l.outras_deducoes : [],
      observacao: l.observacao ?? null, atualizado_em: l.updated_at ?? null,
    }))
    .filter((c) => validaFrac(c.comissao))
    .sort((a, b) => a.canal.localeCompare(b.canal));
  const presentes = new Set(canais.map((c) => c.canal));
  return { configurado: canais.length > 0, canais, ausentes: CANAIS.filter((c) => !presentes.has(c)) };
}

/**
 * Deduções para a margem estimada do iFood a partir da configuração da empresa. NUNCA assume valor:
 * exige comissão E taxas E promoções informadas (0 explícito vale). Tributos/entrega/outras ficam de fora
 * desta conta (o simulador de preço as considera à parte, quando informadas).
 * @returns {{taxasComissoesPct: number|null, servicosPromocoesPct: number|null, motivo: string|null}}
 */
export function deducoesConfiguradas(cond) {
  if (!cond) return { taxasComissoesPct: null, servicosPromocoesPct: null, motivo: "canal_sem_condicoes" };
  if (cond.taxas == null || cond.promocao == null) return { taxasComissoesPct: null, servicosPromocoesPct: null, motivo: "informe_taxas_e_promocoes" };
  return { taxasComissoesPct: (cond.comissao + cond.taxas) * 100, servicosPromocoesPct: cond.promocao * 100, motivo: null };
}

/** Puro: valida e normaliza o corpo de gravação. Lança ApiError.badRequest com mensagem em pt-BR. */
export function validarCondicao(body) {
  const b = body && typeof body === "object" ? body : {};
  if (!CANAIS.includes(b.canal)) throw ApiError.badRequest(`Canal inválido. Use: ${CANAIS.join(", ")}.`);
  const comissao = frac(b.comissao);
  if (!validaFrac(comissao)) throw ApiError.badRequest("Informe a comissão do canal (use 0 se não houver), entre 0% e menos de 100%.");
  const opc = (k, rotulo) => { const n = frac(b[k]); if (b[k] !== null && b[k] !== undefined && b[k] !== "" && !validaFrac(n)) throw ApiError.badRequest(`${rotulo} deve estar entre 0% e menos de 100%.`); return n; };
  const taxas = opc("taxas", "Taxas"); const promocao = opc("promocao", "Promoções"); const tributos = opc("tributos", "Tributos");
  const entrega_responsavel = b.entrega_responsavel === null || b.entrega_responsavel === undefined || b.entrega_responsavel === "" ? null : b.entrega_responsavel;
  if (entrega_responsavel !== null && !RESPONSAVEIS_ENTREGA.includes(entrega_responsavel)) throw ApiError.badRequest("Responsável pela entrega inválido (loja, plataforma ou terceiro).");
  const entrega_custo = frac(b.entrega_custo);
  if (b.entrega_custo !== null && b.entrega_custo !== undefined && b.entrega_custo !== "" && (entrega_custo == null || entrega_custo < 0 || entrega_custo > 1000)) throw ApiError.badRequest("Custo de entrega inválido.");
  if (entrega_custo != null && entrega_responsavel !== "loja" && entrega_custo > 0) throw ApiError.badRequest("Custo de entrega por pedido só se aplica quando a loja é a responsável pela entrega.");
  const outras = Array.isArray(b.outras_deducoes) ? b.outras_deducoes : [];
  if (outras.length > MAX_OUTRAS) throw ApiError.badRequest(`No máximo ${MAX_OUTRAS} outras deduções.`);
  const outras_deducoes = outras.map((o) => {
    const nome = String(o?.nome ?? "").trim(); const pct = frac(o?.pct);
    if (!nome || nome.length > 60) throw ApiError.badRequest("Cada dedução precisa de um nome (até 60 caracteres).");
    if (!validaFrac(pct)) throw ApiError.badRequest(`A dedução "${nome}" deve estar entre 0% e menos de 100%.`);
    return { nome, pct };
  });
  const observacao = b.observacao ? String(b.observacao).trim().slice(0, 300) : null;
  return { canal: b.canal, comissao_pct: comissao, taxas_pct: taxas, promocao_pct: promocao, tributos_pct: tributos, entrega_responsavel, entrega_custo, outras_deducoes, observacao };
}

export async function condicoesComerciais({ organizacaoId }) {
  const { data, error } = await supabase.from("canais_venda").select("*").eq("organizacao_id", organizacaoId);
  if (error) throw ApiError.internal(error.message);
  return moldarCondicoes(data);
}

/** Grava as condições de UM canal da organização do contexto (upsert), com auditoria antes/depois. */
export async function salvarCondicao({ organizacaoId, body, usuario }) {
  const linha = validarCondicao(body);
  const { data: antes, error: eA } = await supabase.from("canais_venda").select("*").eq("organizacao_id", organizacaoId).eq("canal", linha.canal).maybeSingle();
  if (eA) throw ApiError.internal(eA.message);
  const payload = { ...linha, organizacao_id: organizacaoId, ativo: true, updated_at: new Date().toISOString() };
  const { error } = await supabase.from("canais_venda").upsert(payload, { onConflict: "organizacao_id,canal" });
  if (error) {
    if (/column|schema cache|does not exist/i.test(error.message)) throw ApiError.badRequest("Condições comerciais indisponíveis neste ambiente (migration 158 não aplicada).");
    throw ApiError.badRequest(error.message);
  }
  // Auditoria best-effort: nunca derruba o salvar.
  const snap = (r) => r && ({ comissao: Number(r.comissao_pct), taxas: frac(r.taxas_pct), promocao: frac(r.promocao_pct), tributos: frac(r.tributos_pct), entrega_responsavel: r.entrega_responsavel ?? null, entrega_custo: frac(r.entrega_custo), outras_deducoes: r.outras_deducoes ?? [], observacao: r.observacao ?? null });
  const { error: eH } = await supabase.from("canais_venda_historico").insert({
    organizacao_id: organizacaoId, canal: linha.canal, antes: snap(antes) ?? null, depois: snap(payload),
    usuario_id: null, usuario_nome: usuario?.nome ?? usuario?.email ?? null,
  });
  if (eH) console.warn("[condicoes] histórico não registrado:", eH.message);
  return condicoesComerciais({ organizacaoId });
}

export async function historicoCondicoes({ organizacaoId, limite = 30 }) {
  const { data, error } = await supabase.from("canais_venda_historico").select("canal, antes, depois, usuario_nome, created_at")
    .eq("organizacao_id", organizacaoId).order("created_at", { ascending: false }).limit(Math.min(Math.max(Number(limite) || 30, 1), 100));
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}
