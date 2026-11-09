// Modelo PURO da tela de Fichas Técnicas (sem DOM, sem fetch): filtros, rótulos em português claro e selos.
// Os dados vêm de GET /api/v1/produtos/catalogo/fichas — aqui só se organiza o que o servidor calculou.

export const CATEGORIAS_FICHA = [
  { id: "todas", rotulo: "Todas" },
  { id: "DOCES", rotulo: "Doces" },
  { id: "SALGADOS", rotulo: "Salgados" },
  { id: "BEBIDAS", rotulo: "Bebidas" },
  { id: "sem", rotulo: "Sem categoria" },
];

export const NATUREZAS = [
  { id: "todas", rotulo: "Produtos e preparações" },
  { id: "produto_final", rotulo: "Produtos finais (vendidos)" },
  { id: "preparacao", rotulo: "Preparações (usadas em outras receitas)" },
];

export const SITUACOES = [
  { id: "todas", rotulo: "Todas as situações" },
  { id: "prontas", rotulo: "Prontas para homologar" },
  { id: "incompletas", rotulo: "Incompletas (precisam de correção)" },
  { id: "pendentes", rotulo: "Pendentes de homologação" },
  { id: "homologadas", rotulo: "Homologadas" },
];

/** Por que uma homologação deixou de valer — em linguagem de quem usa o sistema. */
const MOTIVOS = {
  composicao_alterada: "A composição da receita foi alterada depois da homologação.",
  rendimento_alterado: "O rendimento da receita foi alterado depois da homologação.",
  custo_manual_alterado: "O custo manual foi alterado depois da homologação.",
  custo_alterado: "O custo mudou mais de 0,5% desde a homologação (por exemplo, por reajuste de preço de insumo).",
  reaberta_manualmente: "A homologação foi reaberta por um administrador.",
};
export const rotuloMotivo = (m) => (m ? (MOTIVOS[m] ?? m) : "");

/** Pendências da carga: texto claro + o que fazer. `bloqueia` = impede homologar/CMV até corrigir. */
const PENDENCIAS = {
  preco_ausente_ou_zero: { texto: "Insumo sem preço de compra informado.", acao: "Informe o preço em Insumos.", bloqueia: true },
  insumo_sem_custo: { texto: "Usa insumo sem custo.", acao: "Informe o preço do insumo.", bloqueia: true },
  preparacao_incompleta: { texto: "Usa uma preparação que ainda está incompleta.", acao: "Complete a preparação primeiro.", bloqueia: true },
  linha_sem_quantidade: { texto: "Um ingrediente da planilha estava sem quantidade e não foi importado.", acao: "Adicione o ingrediente com a quantidade correta.", bloqueia: true },
  componente_nao_encontrado: { texto: "Um ingrediente da planilha não existe no cadastro e não foi importado.", acao: "Cadastre o insumo (ou corrija o nome) e adicione à ficha.", bloqueia: true },
  linha_com_erro_na_planilha: { texto: "A planilha tinha erro de fórmula neste item.", acao: "Confira o item na ficha.", bloqueia: true },
  sem_rendimento: { texto: "A receita não informa quanto rende.", acao: "Informe o rendimento.", bloqueia: true },
  sem_componentes: { texto: "Nenhum ingrediente válido foi importado.", acao: "Monte a ficha.", bloqueia: true },
  custo_planilha_invalido: { texto: "O custo na planilha original estava inválido.", acao: "Confira a ficha antes de homologar.", bloqueia: true },
  ciclo_na_receita: { texto: "A receita usa a si mesma (direta ou indiretamente).", acao: "Remova o item circular.", bloqueia: true },
  layout_inesperado: { texto: "A aba da planilha estava fora do padrão.", acao: "Confira a ficha item a item.", bloqueia: true },
  valores_divergentes: { texto: "Este insumo tinha preços diferentes entre as planilhas.", acao: "Confirme o preço vigente em Insumos.", bloqueia: false },
  unidade_inferida: { texto: "A unidade foi deduzida pelo sistema (rótulo da planilha inconsistente).", acao: "Confirme a unidade em Insumos.", bloqueia: false },
  unidade_ambigua: { texto: "A unidade do insumo é ambígua (kg ou g?).", acao: "Confirme a unidade em Insumos.", bloqueia: false },
  unidade_ausente: { texto: "O insumo veio sem unidade.", acao: "Informe a unidade em Insumos.", bloqueia: false },
  unidade_rendimento_ausente: { texto: "A preparação não informa a unidade do rendimento.", acao: "Informe a unidade (g, ml ou un).", bloqueia: false },
  nome_repetido_na_categoria: { texto: "Existe outra ficha com o mesmo nome nesta categoria.", acao: "Confira se não é duplicada.", bloqueia: false },
  nome_repetido_entre_categorias: { texto: "Existe ficha com o mesmo nome em outra categoria.", acao: "Confira se são produtos diferentes.", bloqueia: false },
  nome_repetido_receita_diferente: { texto: "Existe preparação com o mesmo nome e receita diferente.", acao: "Confira qual é a correta.", bloqueia: false },
  linha_duplicada_somada: { texto: "Um ingrediente aparecia mais de uma vez; as quantidades foram somadas.", acao: "Confira a quantidade total.", bloqueia: false },
  mao_de_obra_invalida: { texto: "Mão de obra da planilha sem minutos válidos.", acao: "Informe a mão de obra, se quiser acompanhá-la.", bloqueia: false },
  mao_de_obra_sem_custo_minuto: { texto: "Mão de obra sem custo por minuto.", acao: "Informe o custo da mão de obra.", bloqueia: false },
  desperdicio_nao_importado: { texto: "A planilha tinha desperdício percentual, que o sistema ainda não calcula.", acao: "Ajuste as quantidades se necessário.", bloqueia: false },
  custo_difere_da_planilha: { texto: "O custo recalculado difere da planilha original.", acao: "Confira antes de homologar.", bloqueia: false },
};
export function descreverPendencia(p) {
  const base = PENDENCIAS[p?.codigo] ?? { texto: p?.codigo ?? "Pendência", acao: "", bloqueia: false };
  return { codigo: p?.codigo ?? null, texto: base.texto, acao: base.acao, bloqueia: base.bloqueia, detalhe: p?.detalhe ?? null };
}

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function categoriaDoItem(i) { return i.categoria ?? "sem"; }

/** @param {Array<object>} itens @param {{categoria?: string, natureza?: string, situacao?: string, busca?: string}} f */
export function filtrarFichas(itens, f = {}) {
  const { categoria = "todas", natureza = "todas", situacao = "todas", busca = "" } = f;
  const termo = norm(busca);
  return (itens ?? []).filter((i) => {
    if (categoria !== "todas" && categoriaDoItem(i) !== categoria) return false;
    if (natureza !== "todas" && i.natureza !== natureza) return false;
    if (situacao === "prontas" && !i.pode_homologar) return false;
    if (situacao === "incompletas" && i.ficha_completa) return false;
    if (situacao === "pendentes" && i.homologacao !== "pendente") return false;
    if (situacao === "homologadas" && i.homologacao !== "homologada") return false;
    if (termo && !norm(i.nome).includes(termo)) return false;
    return true;
  });
}

/** Contagens para as abas de categoria (respeitando os OUTROS filtros, para o número bater com a lista). */
export function contarPorCategoria(itens, f = {}) {
  const base = { ...f, categoria: "todas" };
  const lista = filtrarFichas(itens, base);
  const c = { todas: lista.length };
  for (const i of lista) c[categoriaDoItem(i)] = (c[categoriaDoItem(i)] ?? 0) + 1;
  return c;
}

/** Selo de homologação do item: texto, classe do pill e detalhe (quem/quando/por que). */
export function seloHomologacao(i, fmtData = (d) => d) {
  if (i.homologacao === "nao_aplicavel") return { texto: "Sem controle", classe: "muted", detalhe: "Cadastro manual: não passa por homologação." };
  if (i.homologacao === "homologada") {
    const quem = i.homologado_por_nome ? ` por ${i.homologado_por_nome}` : "";
    const quando = i.homologado_em ? ` em ${fmtData(i.homologado_em)}` : "";
    return { texto: "Homologada", classe: "ok", detalhe: `Homologada${quem}${quando}.` };
  }
  if (!i.ficha_completa) return { texto: "Incompleta", classe: "bad", detalhe: "A ficha tem pendências que impedem a homologação." };
  return { texto: "Pendente", classe: "warn", detalhe: i.homologacao_motivo ? rotuloMotivo(i.homologacao_motivo) : "Aguardando conferência de um administrador." };
}

/** Rótulo do custo: por porção (produto vendido) ou por g/ml/unidade (preparação usada em outras receitas). */
export function rotuloCusto(i) {
  if (i.natureza === "produto_final") return "por porção";
  const u = { g: "grama", ml: "ml", un: "unidade", kg: "kg", l: "litro" }[i.unidade_rendimento];
  return u ? `por ${u}` : "por unidade de rendimento";
}

export function pendenciasDoItem(i) {
  const lista = (i.pendencias ?? []).map(descreverPendencia);
  return { bloqueantes: lista.filter((p) => p.bloqueia), avisos: lista.filter((p) => !p.bloqueia) };
}

/** Ids prontos para homologar dentro de uma lista (já filtrada pela tela). */
export const idsProntos = (itens) => (itens ?? []).filter((i) => i.pode_homologar).map((i) => i.id);
