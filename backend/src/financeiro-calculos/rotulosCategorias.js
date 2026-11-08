// Nome de EXIBIÇÃO de categorias do plano de contas, por empresa (organização). PURO e sem banco.
// O identificador, o nome gravado e o histórico NUNCA mudam: só a apresentação (Visão Geral, DRE, gráficos, relatórios, detalhes).
//
// Regra atual: a categoria "FRETE" (papel custo_variavel) vira "Entregadores Próprios (Motoboys)" SOMENTE nas organizações listadas em
// FINANCEIRO_ROTULOS_ENTREGADORES_ORGANIZACOES (UUIDs separados por vírgula). Ausente/vazia/inválida = ninguém é renomeado (fail-closed),
// porque em outras empresas "FRETE" pode ser frete de fornecedor. Não existe curinga. Nenhum UUID de empresa fica no código.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sa = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();

export const ENTREGADORES_PROPRIOS = Object.freeze({
  chave: "entregadores_proprios",
  nome: "Entregadores Próprios (Motoboys)",
  descricao: "Representa os pagamentos aos entregadores próprios da operação do Açaí no Grau. Não deve ser confundido com fretes de fornecedores, taxas de entrega do iFood ou outras despesas logísticas.",
  distincoes: Object.freeze([
    "Entregadores próprios: pessoas pagas pela empresa para entregar (esta categoria).",
    "Logística de plataformas: taxas de entrega cobradas pelo iFood e similares (aparecem nas taxas e comissões, não aqui).",
    "Fretes de fornecedores: transporte de mercadoria comprada (não pertencem a esta categoria).",
  ]),
});

export function organizacoesEntregadoresProprios(env = process.env) {
  return new Set(String(env?.FINANCEIRO_ROTULOS_ENTREGADORES_ORGANIZACOES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)));
}

/**
 * Apresentação de uma categoria. Devolve sempre `nomeOriginal` (o gravado) e `nome` (o exibido); `explicacao` só quando há regra.
 * @param {{organizacaoId:string, nome:string, papel?:string}} cat
 */
export function rotuloCategoria(cat, env = process.env) {
  const original = cat?.nome ?? "";
  const aplica = typeof cat?.organizacaoId === "string" && UUID.test(cat.organizacaoId) && organizacoesEntregadoresProprios(env).has(cat.organizacaoId.toLowerCase())
    && sa(original) === "FRETE" && cat.papel === "custo_variavel";
  if (!aplica) return { nome: original, nomeOriginal: original, renomeada: false, explicacao: null, chave: null, distincoes: [] };
  return { nome: ENTREGADORES_PROPRIOS.nome, nomeOriginal: original, renomeada: true, explicacao: ENTREGADORES_PROPRIOS.descricao, chave: ENTREGADORES_PROPRIOS.chave, distincoes: ENTREGADORES_PROPRIOS.distincoes };
}

/** Mapa nome-gravado → apresentação, para uma lista de categorias de UMA organização. */
export function rotulosDoPlano(organizacaoId, plano, env = process.env) {
  return new Map(plano.map((c) => [c.nome, rotuloCategoria({ organizacaoId, nome: c.nome, papel: c.papel }, env)]));
}

/** Cópia do plano com `nome` de exibição e `nomeOriginal`; `id` e `papel` intactos. */
export function planoParaExibicao(organizacaoId, plano, env = process.env) {
  return plano.map((c) => { const r = rotuloCategoria({ organizacaoId, nome: c.nome, papel: c.papel }, env); return r.renomeada ? { ...c, nome: r.nome, nomeOriginal: r.nomeOriginal, explicacao: r.explicacao } : c; });
}
