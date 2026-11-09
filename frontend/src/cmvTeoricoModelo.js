// CMV teórico do iFood — modelo PURO do painel (sem DOM/fetch). Tudo aqui é ESTIMATIVA sobre itens vendidos e fichas
// técnicas: nunca é apresentado como resultado financeiro conciliado.

export const AVISO_ESTIMATIVA = "Estimativa calculada sobre os itens vendidos e as fichas técnicas. Não é resultado financeiro conciliado.";

/** Primeiro e último dia do mês (AAAA-MM-DD) — o backend limita o período a 92 dias. */
export function periodoDoMes(mes, ano) {
  const m = String(mes).padStart(2, "0");
  const ultimo = new Date(Date.UTC(Number(ano), Number(mes), 0)).getUTCDate();
  return { de: `${ano}-${m}-01`, ate: `${ano}-${m}-${String(ultimo).padStart(2, "0")}` };
}

const MOTIVOS_INDISPONIVEL = {
  sem_pedidos_no_periodo: "Não há pedidos concluídos do iFood neste período.",
  pedidos_sem_detalhe_de_itens: "Os pedidos do período ainda não têm o detalhe dos itens vendidos (o sistema ainda não buscou esses dados no iFood).",
  nenhum_item_vinculado_a_produto: "Nenhum item vendido foi vinculado a um produto do catálogo. Cadastre o código do PDV dos produtos (igual ao código do item no iFood) ou use o mesmo nome.",
  nenhuma_ficha_completa_entre_os_vinculados: "Os produtos vinculados ainda não têm ficha técnica completa (há insumo sem custo ou ficha vazia).",
};
export const rotuloMotivoIndisponivel = (m) => MOTIVOS_INDISPONIVEL[m] ?? m;

const MOTIVOS_VINCULO = {
  codigo_nao_cadastrado: "Código do item não existe nos produtos",
  nome_ambiguo: "Mais de um produto com este nome",
  codigo_ambiguo: "Mais de um produto com este código",
  sem_correspondencia: "Sem código e sem produto com o mesmo nome",
};
export const rotuloMotivoVinculo = (m) => MOTIVOS_VINCULO[m] ?? m ?? "Sem correspondência";

const SINAIS = { cmv_acima_do_limite: "CMV acima do limite", margem_negativa_apos_comissao: "Prejuízo após a comissão" };
export const rotuloSinal = (s) => SINAIS[s] ?? s;

/** Situação geral do indicador: indisponível / parcial / estimado. Sempre "estimado" no melhor caso. */
export function situacaoIndicador(d) {
  if (!d || d.indisponivel) return { chave: "indisponivel", texto: "Indisponível", classe: "bad", detalhe: (d?.motivos_indisponivel ?? []).map(rotuloMotivoIndisponivel).join(" ") };
  if (d.parcial) {
    const por = [];
    if ((d.cobertura?.pct_receita_vinculada ?? 0) < 50) por.push(`apenas ${Math.round(d.cobertura?.pct_receita_vinculada ?? 0)}% da receita dos itens foi vinculada a produtos`);
    if (d.cobertura?.produtos_ficha_incompleta > 0) por.push(`${d.cobertura.produtos_ficha_incompleta} produto(s) com ficha incompleta ficaram de fora`);
    return { chave: "parcial", texto: "Parcial", classe: "warn", detalhe: `Resultado parcial: ${por.join("; ") || "dados incompletos"}.` };
  }
  return { chave: "estimado", texto: "Estimado", classe: "ok", detalhe: AVISO_ESTIMATIVA };
}

/** Selo da ficha de um produto vendido. */
export function seloFichaProduto(p) {
  if (p.custo_unitario == null) return { texto: "Ficha incompleta", classe: "bad" };
  if (p.homologacao === "homologada" || p.homologacao === "nao_aplicavel") return { texto: p.homologacao === "homologada" ? "Homologada" : "Cadastro manual", classe: "ok" };
  return { texto: "Pendente de homologação", classe: "warn" };
}

/** Cartões do topo. `homologado` e `margem` mostram "—" quando não há base (nunca zero). */
export function cartoes(d) {
  const c = d?.cobertura ?? {};
  return {
    cmv: d && !d.indisponivel ? d.cmv_teorico_pct : null,
    cmvHomologado: d?.cmv_teorico_homologado_pct ?? null,
    coberturaPct: c.pct_receita_vinculada ?? null,
    homologadoPct: c.pct_receita_com_custo_homologado ?? null,
    produtosVinculados: c.produtos_vinculados ?? 0,
    fichasIncompletas: c.produtos_ficha_incompleta ?? 0,
    semCorrespondencia: (d?.sem_correspondencia ?? []).length,
    comissaoConsiderada: d?.comissao_considerada ?? null,
  };
}

/** Separa produtos vendidos em grupos para a tela. */
export function agruparProdutos(d) {
  const lista = d?.produtos ?? [];
  return {
    comCusto: lista.filter((p) => p.custo_unitario != null),
    incompletos: lista.filter((p) => p.custo_unitario == null),
    desfavoraveis: lista.filter((p) => p.desfavoravel),
    homologados: lista.filter((p) => p.custo_homologado),
  };
}
