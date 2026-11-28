// Prévia da REVISÃO DE RENDIMENTOS suspeitos (D2) — pura, sem I/O. Nunca aplica: só descreve, sugere quando há
// fundamento e mede o impacto. A aplicação é transacional no banco (fn_corrigir_rendimentos, migration 163).
//
// Hipóteses avaliadas (não se presume que todo caso é kg→g):
//   H1 "kg digitado como g": rendimento × 1000 fica entre 70% e 105% da massa dos componentes (perda de cocção típica).
//   H2 "kg digitado como g, com perda/ganho atípico": ×1000 entre 30% e 150% → sugere, confiança baixa.
//   H3 sem hipótese numérica: rendimento × 1000 fora da faixa (ex.: 1,4 → 1.400 g para 560 g de
//      ingredientes = 278%: NÃO é sugerido; pode ser nº de porções, peso do peixe inteiro, etc.). Exige pesagem.

import { custoTotalProduto, produtosAfetadosPorProduto } from "./custo.js";
import { massaDoLote, avaliarRendimento } from "./diagnostico.js";

/** Classifica a hipótese ×1000. @returns {{sugestao: number|null, confianca: 'alta'|'media'|'baixa'|'nenhuma', causa: string}} */
export function hipoteseRendimento({ rendimento, unidade, massa }) {
  const x = rendimento * 1000; const r = massa > 0 ? x / massa : null;
  const maior = unidade === "g" ? "kg" : "litros";
  if (r == null) return { sugestao: null, confianca: "nenhuma", causa: "Sem massa comparável dos ingredientes." };
  if (r >= 0.7 && r <= 1.05) return { sugestao: x, confianca: "alta", causa: `Valor provavelmente em ${maior}: ${x} ${unidade} = ${(r * 100).toFixed(0)}% da massa dos ingredientes (perda de preparo usual).` };
  if (r >= 0.5 && r < 0.7) return { sugestao: x, confianca: "media", causa: `Provável ${maior} com perda de preparo alta (${(r * 100).toFixed(0)}% da massa). Confirme pesando o lote.` };
  if (r >= 0.3 && r <= 1.5) return { sugestao: x, confianca: "baixa", causa: `${x} ${unidade} seria ${(r * 100).toFixed(0)}% da massa — fora do usual; só aplique após pesar.` };
  return { sugestao: null, confianca: "nenhuma", causa: `Nem ${rendimento} nem ${x} ${unidade} são compatíveis com ${Math.round(massa)} ${unidade} de ingredientes (${(r * 100).toFixed(0)}% ×1000). Pode ser nº de porções ou peso de outra etapa — exige pesagem do lote pronto.` };
}

/**
 * @param {object} grafo de carregarGrafo()
 * @param {{origemPorProduto?: Map<string, object>, sobrescritas?: Map<string, number>}} [o]
 *   sobrescritas: valor editado pelo usuário por produto (a prévia recalcula com ele)
 */
export function previaRevisaoRendimentos(grafo, { origemPorProduto = new Map(), sobrescritas = new Map() } = {}) {
  const itens = [];
  for (const p of grafo.produtos) {
    if (p.ativo === false || p.tipo !== "submontagem" || p.homologacao === "nao_aplicavel") continue;
    const unidade = grafo.unidadeRendimentoById?.get(p.id);
    const lote = massaDoLote(p.id, grafo);
    const aval = avaliarRendimento({ rendimento: p.rendimento, unidade, ...lote });
    if (aval?.codigo !== "rendimento_unidade_suspeita") continue;
    const rend = Number(p.rendimento);
    const hip = hipoteseRendimento({ rendimento: rend, unidade, massa: lote.massa });
    const proposto = sobrescritas.has(p.id) ? Number(sobrescritas.get(p.id)) : hip.sugestao;
    const dependentes = produtosAfetadosPorProduto(p.id, grafo).filter((id) => id !== p.id);
    const custoAntes = custoTotalProduto(p.id, grafo);
    let custoDepois = null; const impacto = [];
    if (proposto > 0) {
      const antesDeps = new Map(dependentes.map((id) => [id, custoTotalProduto(id, grafo)]));
      const original = grafo.rendimentoById.get(p.id);
      grafo.rendimentoById.set(p.id, proposto);
      try {
        custoDepois = custoTotalProduto(p.id, grafo);
        for (const id of dependentes) {
          const depois = custoTotalProduto(id, grafo);
          impacto.push({ id, nome: grafo.nomeProdById.get(id) ?? "?", custo_antes: antesDeps.get(id), custo_depois: depois, variacao: depois - antesDeps.get(id) });
        }
      } finally { grafo.rendimentoById.set(p.id, original); }
    }
    const origem = origemPorProduto.get(p.id);
    itens.push({
      produto_id: p.id, nome: p.nome, unidade, rendimento_atual: rend,
      massa_ingredientes: lote.massa, linhas_comparaveis: lote.comparaveis, linhas_total: lote.total,
      origem: origem ? { arquivo: origem.referencia?.fontes?.[0]?.arquivo ?? null, aba: origem.referencia?.fontes?.[0]?.aba ?? null, rendimento_planilha: origem.referencia?.rendimento_planilha ?? null } : null,
      causa: hip.causa, sugestao: hip.sugestao, confianca: hip.confianca, rendimento_proposto: proposto ?? null, editado: sobrescritas.has(p.id),
      custo_unitario_antes: custoAntes, custo_unitario_depois: custoDepois,
      custo_lote: custoAntes * rend,
      dependentes: dependentes.length,
      impacto_dependentes: impacto.sort((a, b) => Math.abs(b.variacao) - Math.abs(a.variacao)),
      reducao_custo_dependentes: impacto.reduce((s, x) => s + (x.custo_antes - x.custo_depois), 0),
    });
  }
  return itens.sort((a, b) => b.dependentes - a.dependentes || a.nome.localeCompare(b.nome));
}

/**
 * Validação do lote ANTES de chamar o banco (o banco revalida tudo). Recusa item fora da prévia, valor inválido,
 * sem justificativa, ou valor que continua implausível sem confirmação explícita.
 */
export function validarLoteRendimentos(itensPedidos, previa) {
  const porId = new Map(previa.map((x) => [x.produto_id, x]));
  const erros = [];
  if (!Array.isArray(itensPedidos) || !itensPedidos.length) return ["Selecione ao menos uma preparação."];
  if (itensPedidos.length > 200) return ["No máximo 200 correções por lote."];
  const vistos = new Set();
  for (const it of itensPedidos) {
    const p = porId.get(it?.produto_id);
    if (!p) { erros.push(`Preparação ${it?.produto_id} não está na revisão de rendimentos desta unidade.`); continue; }
    if (vistos.has(p.produto_id)) { erros.push(`${p.nome}: repetida no lote.`); continue; }
    vistos.add(p.produto_id);
    const novo = Number(it.rendimento_novo);
    if (!Number.isFinite(novo) || novo <= 0) erros.push(`${p.nome}: rendimento novo inválido.`);
    if (Number(it.rendimento_atual) !== p.rendimento_atual) erros.push(`${p.nome}: o rendimento mudou desde a prévia — atualize a revisão.`);
    if (!String(it.justificativa ?? "").trim()) erros.push(`${p.nome}: informe a justificativa (ex.: "lote pesado em 28/11: 2.610 g").`);
    if (Number.isFinite(novo) && novo > 0) {
      const ainda = avaliarRendimento({ rendimento: novo, unidade: p.unidade, massa: p.massa_ingredientes, comparaveis: p.linhas_comparaveis, total: p.linhas_total });
      if (ainda?.codigo === "rendimento_unidade_suspeita" && it.confirmar_implausivel !== true) erros.push(`${p.nome}: ${novo} ${p.unidade} continua implausível para ${Math.round(p.massa_ingredientes)} ${p.unidade} de ingredientes.`);
    }
  }
  return erros;
}
