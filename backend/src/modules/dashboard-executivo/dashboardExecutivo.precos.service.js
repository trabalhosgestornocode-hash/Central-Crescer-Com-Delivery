import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { carregarGrafo, resumoProduto } from "../produtos/custo.js";
import { resolverTabelasComerciaisUnidade } from "../../shared/tabelaComercial.js";
import { condicoesComerciais, deducoesConfiguradas } from "../cmv/cmv.condicoes.js";
async function localizarProdutoReferencia(organizacaoId, nomeBusca) {
  const { data, error } = await supabase
    .from("produtos")
    .select("id, nome, tamanho, custo_manual, ativo")
    .eq("organizacao_id", organizacaoId)
    .eq("ativo", true)
    .ilike("nome", `%${nomeBusca.split(" ")[0]}%`); // 1º termo (ex.: "Churrasco") — filtro amplo, refinado abaixo
  if (error) throw ApiError.internal(error.message);

  return selecionarProdutoReferencia(data ?? [], nomeBusca);
}

export function selecionarProdutoReferencia(candidatos, nomeBusca = "Churrasco 15cm") {
  const termo = nomeBusca.replace(/\s+/g, "");
  return candidatos.find((p) => p.nome.replace(/\s+/g, "").toLowerCase() === termo.toLowerCase())
    ?? candidatos.find((p) => p.tamanho === "15cm" && /churrasco/i.test(p.nome))
    ?? candidatos.find((p) => /15\s*cm/i.test(p.nome)) ?? null;
}

// Chamado após a validação da unidade e organização pelo serviço do Dashboard.
/**
 * Produto escolhido pelo usuário (id), restrito à ORGANIZAÇÃO do contexto, vendável e ativo.
 * Retorna null se não existir/for de outra empresa — nunca vaza produto alheio.
 */
export async function localizarProdutoPorId(organizacaoId, produtoId) {
  const { data, error } = await supabase.from("produtos").select("id, nome, tamanho, custo_manual, ativo, vendavel")
    .eq("organizacao_id", organizacaoId).eq("id", produtoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data && data.ativo !== false && data.vendavel !== false ? data : null;
}

// Sem `produtoId` o comportamento é o LEGADO (produto de referência "Churrasco 15cm" — Subways, resultados inalterados).
// Com `produtoId` a proteção usa o produto escolhido e, na falta de deduções APURADAS no mês, as condições
// COMERCIAIS CONFIGURADAS pela própria empresa para o iFood (nunca as de outra organização).
export async function carregarPrecosRentabilidade({ organizacaoId, unidadeId, tabelaBalcao, tabelaIfood, produtoId }) {
  const oficiais = await resolverTabelasComerciaisUnidade({ unidadeId });
  const tabelas = {
    balcao: v.textoOpcional(tabelaBalcao, "Tabela Balcão", { max: 20 }) ?? oficiais.tabelaBalcao,
    ifood: v.textoOpcional(tabelaIfood, "Tabela iFood", { max: 20 }) ?? oficiais.tabelaIfood,
  };
  const produto = produtoId ? await localizarProdutoPorId(organizacaoId, v.uuid(produtoId, "Produto")) : await localizarProdutoReferencia(organizacaoId, "Churrasco 15cm");
  const grafo = produto ? await carregarGrafo(organizacaoId) : null;
  const lados = {};
  for (const canal of ["balcao", "ifood"]) {
    let row = null;
    if (produto && tabelas[canal]) {
      const { data, error } = await supabase.from("produto_precos").select("preco, desatualizado")
        .eq("produto_id", produto.id).eq("canal", canal).eq("tabela", tabelas[canal]).maybeSingle();
      if (error) throw ApiError.internal(error.message);
      row = data;
    }
    const valor = row?.preco != null ? Number(row.preco) : null;
    const preco = Number.isFinite(valor) && valor > 0 ? valor : null;
    const resumo = produto ? resumoProduto({ produtoId: produto.id, grafo, precoVenda: preco, custoManual: produto.custo_manual }) : null;
    const custo = resumo?.status_ficha?.chave !== "insumo_sem_custo" && Number.isFinite(resumo?.custo) && resumo.custo >= 0 ? resumo.custo : null;
    lados[canal] = { canal, tabela: tabelas[canal], preco, custo,
      cmvPct: preco != null && custo != null && Number.isFinite(resumo?.cmv_pct) ? resumo.cmv_pct : null,
      precoDesatualizado: row?.desatualizado ?? null, statusFicha: resumo?.status_ficha ?? null,
      indisponivel: !produto ? (produtoId ? "Produto não encontrado nesta empresa." : "Produto de referência indisponível nesta empresa. Selecione um produto para simular.") : !tabelas[canal] ? "Tabela oficial não configurada para este canal." : preco == null ? "Preço indisponível nesta tabela." : custo == null ? "Custo da ficha técnica indisponível." : null };
  }
  let configuradas;
  if (produtoId) {
    const cond = await condicoesComerciais({ organizacaoId });
    configuradas = deducoesConfiguradas(cond.canais.find((c) => c.canal === "ifood") ?? null);
  }
  return { oficiais, tabelas, produto: produto ? { id: produto.id, nome: produto.nome } : null, ...lados,
    ...(produtoId ? { produtoSelecionado: true, deducoesConfiguradas: configuradas } : {}) };
}
