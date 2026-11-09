// CMV TEÓRICO sobre o que foi EFETIVAMENTE vendido no iFood — núcleo PURO (sem banco).
//
//   CMV teórico = Σ (quantidade vendida × custo técnico unitário do produto vinculado)
//                 ÷ Σ (receita dos itens vinculados)
//
// Princípios (pedidos pelo cliente):
//   * NÃO inventa vendas, taxas nem custos. O que não tem correspondência é LISTADO, não estimado.
//   * Item só é "vinculado" por evidência: código do PDV (externalCode) igual ao codigo_pdv do produto,
//     ou nome idêntico e ÚNICO entre os produtos vendáveis. Nome ambíguo => sem correspondência.
//   * Ficha incompleta nunca entra no CMV; ficha não homologada entra só no CMV "técnico", nunca no homologado.
//   * Margem após comissão só existe se a empresa configurou a comissão do canal (senão null + parcial).
//   * Sem cobertura mínima => indisponível, com o motivo (nada de número enganoso).

import { custoTotalProduto, resumoProduto } from "../produtos/custo.js";

export const COBERTURA_MINIMA_PADRAO = 0.5; // abaixo de 50% da receita vinculada, o indicador é marcado como parcial

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null));
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const cod = (s) => { const t = String(s ?? "").trim().toUpperCase(); return t === "" ? null : t; };

/** Índices de busca sobre os produtos vendáveis ativos da ORGANIZAÇÃO. */
export function indexarProdutos(produtos) {
  const porCodigo = new Map(); const porNome = new Map();
  for (const p of produtos ?? []) {
    if (p.ativo === false || p.vendavel === false) continue;
    const c = cod(p.codigo_pdv);
    if (c) porCodigo.set(c, [...(porCodigo.get(c) ?? []), p]);
    const n = norm(p.nome);
    if (n) porNome.set(n, [...(porNome.get(n) ?? []), p]);
  }
  return { porCodigo, porNome };
}

/** @returns {{produto: object|null, motivo: string|null}} */
export function vincularItem({ codigo, nome }, idx) {
  const c = cod(codigo);
  if (c) {
    const achados = idx.porCodigo.get(c) ?? [];
    if (achados.length === 1) return { produto: achados[0], motivo: null };
    if (achados.length > 1) return { produto: null, motivo: "codigo_ambiguo" };
  }
  const n = norm(nome);
  const porNome = n ? (idx.porNome.get(n) ?? []) : [];
  if (porNome.length === 1) return { produto: porNome[0], motivo: null };
  if (porNome.length > 1) return { produto: null, motivo: "nome_ambiguo" };
  return { produto: null, motivo: c ? "codigo_nao_cadastrado" : "sem_correspondencia" };
}

/**
 * @param {{
 *   pedidos: Array<{order_id: string, items: any}>,      // SÓ concluídos e não-teste, da organização/unidade certas (o chamador filtra)
 *   produtos: Array<object>,                              // produtos da organização
 *   grafo: object,                                        // produtos/custo.js#carregarGrafo (da MESMA organização)
 *   comissaoCanal?: number|null,                          // fração; null = não configurada
 *   limiteCmvPct?: number|null,                           // acima disto o produto é sinalizado como desfavorável
 *   coberturaMinima?: number
 * }} p
 */
export function calcularCmvTeorico({ pedidos, produtos, grafo, comissaoCanal = null, limiteCmvPct = null, coberturaMinima = COBERTURA_MINIMA_PADRAO }) {
  const idx = indexarProdutos(produtos);
  const porProduto = new Map(); // produto_id -> acumulador
  const semCorrespondencia = new Map(); // chave -> {nome, codigo, quantidade, receita, motivo, origem}
  const adicionaisSemCorr = { itens: 0, quantidade: 0, receita: 0 };
  let receitaTotal = 0; let itensTotal = 0; let itensInvalidos = 0; let pedidosComItens = 0; let pedidosSemItens = 0;

  const registrar = (alvo, { quantidade, receita, produto }) => {
    const a = porProduto.get(produto.id) ?? { produto, quantidade: 0, receita: 0 };
    a.quantidade += quantidade; a.receita += receita; porProduto.set(produto.id, a);
    void alvo;
  };

  for (const ped of pedidos ?? []) {
    const itens = Array.isArray(ped.items) ? ped.items : [];
    if (!itens.length) { pedidosSemItens += 1; continue; }
    pedidosComItens += 1;
    for (const it of itens) {
      const q = num(it?.quantity);
      if (q == null || q <= 0) { itensInvalidos += 1; continue; }
      const receita = num(it?.price) ?? (num(it?.unitPrice) != null ? num(it.unitPrice) * q : 0);
      itensTotal += 1; receitaTotal += receita;
      const { produto, motivo } = vincularItem({ codigo: it?.externalCode, nome: it?.name }, idx);
      if (produto) registrar("item", { quantidade: q, receita, produto });
      else {
        const chave = `${cod(it?.externalCode) ?? ""}|${norm(it?.name)}`;
        const s = semCorrespondencia.get(chave) ?? { nome: String(it?.name ?? "Item sem nome").trim(), codigo: cod(it?.externalCode), quantidade: 0, receita: 0, motivo };
        s.quantidade += q; s.receita += receita; semCorrespondencia.set(chave, s);
      }
      // Adicionais (variações): só entram quando casam com um produto; senão ficam apenas contados.
      for (const op of Array.isArray(it?.options) ? it.options : []) {
        const oq = num(op?.quantity); if (oq == null || oq <= 0) continue;
        const total = oq * q; const rec = num(op?.price) ?? 0;
        const { produto: pOp } = vincularItem({ codigo: op?.externalCode, nome: op?.name }, idx);
        if (pOp) registrar("opcao", { quantidade: total, receita: rec, produto: pOp });
        else { adicionaisSemCorr.itens += 1; adicionaisSemCorr.quantidade += total; adicionaisSemCorr.receita += rec; }
      }
    }
  }

  const linhas = [];
  let custoBase = 0; let receitaBase = 0; let custoHom = 0; let receitaHom = 0;
  let incompletos = 0; let receitaIncompleta = 0;
  for (const a of porProduto.values()) {
    const res = resumoProduto({ produtoId: a.produto.id, grafo, precoVenda: a.quantidade > 0 ? a.receita / a.quantidade : null });
    const fichaIntegra = !["sem_componentes", "insumo_sem_custo", "insumo_inativo"].includes(res.status_ficha.chave);
    const custoUnit = custoTotalProduto(a.produto.id, grafo);
    const precoMedio = a.quantidade > 0 ? a.receita / a.quantidade : null;
    const homologado = fichaIntegra && res.homologacao !== "pendente";
    const custoTotal = fichaIntegra ? a.quantidade * custoUnit : null;
    const cmv = fichaIntegra && a.receita > 0 ? (custoTotal / a.receita) * 100 : null;
    const margemBruta = cmv == null ? null : 100 - cmv;
    const margemAposComissao = cmv == null || comissaoCanal == null ? null : 100 - cmv - comissaoCanal * 100;
    if (fichaIntegra) {
      custoBase += custoTotal; receitaBase += a.receita;
      if (homologado) { custoHom += custoTotal; receitaHom += a.receita; }
    } else { incompletos += 1; receitaIncompleta += a.receita; }
    const sinais = [];
    if (cmv != null && limiteCmvPct != null && cmv > limiteCmvPct) sinais.push("cmv_acima_do_limite");
    if (margemAposComissao != null && margemAposComissao < 0) sinais.push("margem_negativa_apos_comissao");
    linhas.push({
      produto_id: a.produto.id, nome: a.produto.nome, quantidade: a.quantidade, receita: a.receita,
      preco_medio_praticado: precoMedio, custo_unitario: fichaIntegra ? custoUnit : null, custo_total: custoTotal,
      cmv_pct: cmv, margem_bruta_pct: margemBruta, margem_apos_comissao_pct: margemAposComissao,
      status_ficha: res.status_ficha, homologacao: res.homologacao, custo_homologado: homologado,
      sinais, desfavoravel: sinais.length > 0,
    });
  }
  linhas.sort((x, y) => y.receita - x.receita);

  const receitaVinculada = linhas.reduce((s, l) => s + l.receita, 0);
  const cobertura = receitaTotal > 0 ? receitaVinculada / receitaTotal : null;
  const motivos = [];
  if (pedidosComItens + pedidosSemItens === 0) motivos.push("sem_pedidos_no_periodo");
  else if (pedidosComItens === 0) motivos.push("pedidos_sem_detalhe_de_itens");
  if (itensTotal > 0 && linhas.length === 0) motivos.push("nenhum_item_vinculado_a_produto");
  if (linhas.length > 0 && receitaBase === 0) motivos.push("nenhuma_ficha_completa_entre_os_vinculados");
  const indisponivel = receitaBase <= 0;
  const parcial = !indisponivel && ((cobertura ?? 0) < coberturaMinima || incompletos > 0);

  return {
    indisponivel, parcial, motivos_indisponivel: indisponivel ? motivos : [],
    cmv_teorico_pct: indisponivel ? null : (custoBase / receitaBase) * 100,
    cmv_teorico_homologado_pct: receitaHom > 0 ? (custoHom / receitaHom) * 100 : null,
    comissao_considerada: comissaoCanal, margem_apos_comissao_disponivel: comissaoCanal != null,
    cobertura: {
      pedidos_com_itens: pedidosComItens, pedidos_sem_itens: pedidosSemItens, itens_total: itensTotal, itens_invalidos: itensInvalidos,
      receita_total_itens: receitaTotal, receita_vinculada: receitaVinculada, pct_receita_vinculada: cobertura == null ? null : cobertura * 100,
      produtos_vinculados: linhas.length, produtos_ficha_incompleta: incompletos, receita_ficha_incompleta: receitaIncompleta,
      pct_receita_com_custo_homologado: receitaTotal > 0 ? (receitaHom / receitaTotal) * 100 : null,
    },
    produtos: linhas,
    desfavoraveis: linhas.filter((l) => l.desfavoravel).map((l) => ({ produto_id: l.produto_id, nome: l.nome, sinais: l.sinais, cmv_pct: l.cmv_pct })),
    sem_correspondencia: [...semCorrespondencia.values()].sort((a, b) => b.receita - a.receita),
    adicionais_sem_correspondencia: adicionaisSemCorr,
  };
}
