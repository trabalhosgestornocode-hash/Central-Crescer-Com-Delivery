// Simulador de precificação por canal — puro. NUNCA grava preço. Reaproveita as condições comerciais da empresa
// (cmv.condicoes.js: frações comissao/taxas/promocao/tributos + outras deduções).
//
// Definições (metodologia preservada: CMV = custo de ingredientes/embalagens; mão de obra à parte):
//   CMV %                 = custo ÷ preço
//   margem bruta          = preço − custo
//   deduções variáveis    = preço × (comissão + taxas + promoção + tributos + outras %) + custos fixos por pedido do canal
//   margem de contribuição= preço − custo − deduções variáveis   (NÃO é lucro líquido: faltam despesas fixas)
//   preço p/ meta de CMV  = custo ÷ meta
//   preço p/ margem de contribuição alvo m: preço = (custo + fixos) ÷ (1 − deduções% − m)

const frac = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? 0 : Number(x));

/**
 * @param {{custo: number|null, preco?: number|null, metaCmv?: number|null, margemContribuicaoAlvo?: number|null,
 *          maoDeObra?: number|null, condicao?: {comissao?: number, taxas?: number, promocao?: number, tributos?: number,
 *          outras_deducoes?: Array<{nome: string, pct: number}>, entrega_responsavel?: string|null, entrega_custo?: number|null}|null}} e
 */
export function simularPreco(e) {
  const custo = e.custo == null ? null : Number(e.custo);
  if (custo == null || !Number.isFinite(custo)) return { disponivel: false, motivo: "Custo da ficha indisponível ou não confiável: corrija as pendências antes de precificar." };
  const c = e.condicao ?? null;
  // Formato de cmv.condicoes.js: outras_deducoes = [{nome, pct}] (fração); entrega_custo = R$ por pedido (só entrega própria).
  const outrasPct = (c?.outras_deducoes ?? []).reduce((s, d) => s + frac(d.pct), 0);
  const fixos = c?.entrega_responsavel === "loja" ? frac(c?.entrega_custo) : 0;
  const pct = { comissao: frac(c?.comissao), taxas: frac(c?.taxas), promocao: frac(c?.promocao), tributos: frac(c?.tributos), outras: outrasPct };
  const deducoesPct = pct.comissao + pct.taxas + pct.promocao + pct.tributos + pct.outras;
  const preco = e.preco != null && Number(e.preco) > 0 ? Number(e.preco) : null;
  const meta = e.metaCmv != null && Number(e.metaCmv) > 0 && Number(e.metaCmv) < 1 ? Number(e.metaCmv) : null;
  const alvo = e.margemContribuicaoAlvo != null && Number.isFinite(Number(e.margemContribuicaoAlvo)) ? Number(e.margemContribuicaoAlvo) : null;
  const out = {
    disponivel: true, custo, preco, condicao_configurada: !!c, deducoes_pct: deducoesPct, deducoes_fixas: fixos, componentes_pct: pct,
    cmv_pct: null, margem_bruta: null, margem_bruta_pct: null, deducoes_valor: null, margem_contribuicao: null, margem_contribuicao_pct: null,
    preco_para_meta_cmv: meta ? custo / meta : null,
    preco_para_margem_alvo: alvo != null && 1 - deducoesPct - alvo > 0 ? (custo + fixos) / (1 - deducoesPct - alvo) : null,
    mao_de_obra: e.maoDeObra ?? null,
    avisos: [],
  };
  if (!c) out.avisos.push("Condições comerciais do canal não configuradas: a margem de contribuição desconsidera comissões e taxas.");
  if (alvo != null && 1 - deducoesPct - alvo <= 0) out.avisos.push("As deduções do canal somadas à margem alvo chegam a 100%: não existe preço que atinja essa margem.");
  if (preco) {
    out.cmv_pct = (custo / preco) * 100;
    out.margem_bruta = preco - custo; out.margem_bruta_pct = (out.margem_bruta / preco) * 100;
    out.deducoes_valor = preco * deducoesPct + fixos;
    out.margem_contribuicao = preco - custo - out.deducoes_valor;
    out.margem_contribuicao_pct = (out.margem_contribuicao / preco) * 100;
    if (out.margem_contribuicao < 0) out.avisos.push("Margem de contribuição negativa: cada venda neste canal não cobre o custo e as deduções variáveis.");
  }
  return out;
}
