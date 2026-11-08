// Faturamento por CANAL de venda — núcleo PURO. Traduz a ORIGEM técnica do relatório de vendas por canal para o nome amigável e confere a soma
// dos canais contra o faturamento bruto OFICIAL da competência. Nunca ajusta valor: se não fecha, a diferença exata é exposta.
//
// Mapeamento (informado pelo responsável do Açaí no Grau): a própria loja = Balcão; a API de integração de vendas = Anota Aí; integração iFood = iFood.
// Origem que não consta aqui NÃO é adivinhada: aparece com o nome técnico, marcada como "origem não mapeada".
const sa = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export const CANAIS_CONHECIDOS = Object.freeze([
  { origem: "Açaí no Grau", canal: "Balcão", ordem: 1, descricao: "Vendas feitas na própria loja (origem registrada com o nome da loja)." },
  { origem: "integration-api-int-sale", canal: "Anota Aí", ordem: 2, descricao: "Pedidos que chegam pela integração do Anota Aí." },
  { origem: "integration-ifood", canal: "iFood", ordem: 3, descricao: "Pedidos que chegam pela integração do iFood." },
]);
const POR_ORIGEM = new Map(CANAIS_CONHECIDOS.map((c) => [sa(c.origem), c]));

/**
 * @param {Array<{origem:string, centavos:number, pedidos?:number}>} linhas  totais por origem técnica (do relatório)
 * @param {number|null} brutoOficialCentavos faturamento bruto oficial da competência (vendas diárias)
 */
export function comporPorCanal(linhas, brutoOficialCentavos) {
  const agrupado = new Map();
  for (const l of linhas ?? []) {
    const conhecido = POR_ORIGEM.get(sa(l.origem));
    const chave = conhecido?.canal ?? `origem:${l.origem}`;
    const x = agrupado.get(chave) ?? { canal: conhecido?.canal ?? String(l.origem), mapeado: Boolean(conhecido), ordem: conhecido?.ordem ?? 99, descricao: conhecido?.descricao ?? "Origem não mapeada para um canal: aparece com o nome técnico.", origens: [], centavos: 0, pedidos: 0 };
    x.centavos += Number(l.centavos); x.pedidos += Number(l.pedidos ?? 0); x.origens.push(l.origem); agrupado.set(chave, x);
  }
  const canais = [...agrupado.values()].sort((a, b) => a.ordem - b.ordem || b.centavos - a.centavos);
  const soma = canais.reduce((s, c) => s + c.centavos, 0);
  const diferenca = brutoOficialCentavos == null ? null : soma - brutoOficialCentavos;   // positivo = canais somam MAIS que o bruto oficial
  return { canais, somaCentavos: soma, brutoOficialCentavos, diferencaCentavos: diferenca, confere: diferenca === 0, naoMapeados: canais.filter((c) => !c.mapeado).map((c) => c.canal) };
}

/** Nome amigável do canal a partir da origem técnica (usa o mapeamento conhecido; senão mantém o nome informado). */
export const nomeDoCanal = (canalOuOrigem) => POR_ORIGEM.get(sa(canalOuOrigem))?.canal ?? String(canalOuOrigem);

/**
 * PONTE entre o total do PAINEL de origem (ex.: SAIPOS) e a BASE da DRE gerencial, canal a canal. Puro; nada é ajustado para fechar.
 *   painel + Σ ajustes (com sinal) = gerencial   (por canal e no total)
 * Ajuste NÃO é taxa financeira nem dedução da DRE: é a diferença entre dois totais de VENDAS (ex.: taxa de entrega e desconto que o
 * painel soma e a base gerencial não). Por isso nunca entra em "Deduções" (evita dedução duplicada).
 * @param canais   [{id, canal, origemTecnica, vendasQtd, painelCentavos, gerencialCentavos, granularidade, fonte, observacao}]
 * @param ajustes  [{id, canal, tipo, valorCentavos, descricao, estado:'confirmado'|'estimado', evidencia}]
 * @param brutoOficialCentavos faturamento bruto oficial do mês (vendas diárias do Saci) — a base gerencial deve coincidir com ele
 */
export function comporPonte({ canais, ajustes, brutoOficialCentavos }) {
  const ativos = (ajustes ?? []);
  const itens = (canais ?? []).map((c) => {
    const nome = nomeDoCanal(c.canal);
    const aj = ativos.filter((a) => nomeDoCanal(a.canal) === nome);
    const somaAj = aj.reduce((s, a) => s + Number(a.valorCentavos), 0);
    const esperado = Number(c.painelCentavos) + somaAj;
    return { ...c, canal: nome, ajustes: aj, ajustesCentavos: somaAj, painelCentavos: Number(c.painelCentavos), gerencialCentavos: Number(c.gerencialCentavos), fechaCanal: esperado === Number(c.gerencialCentavos),
      diferencaCanalCentavos: Number(c.gerencialCentavos) - esperado, pendente: aj.some((a) => a.estado === "estimado"), explicacao: CANAIS_CONHECIDOS.find((k) => k.canal === nome)?.descricao ?? null };
  }).sort((a, b) => (CANAIS_CONHECIDOS.find((k) => k.canal === a.canal)?.ordem ?? 99) - (CANAIS_CONHECIDOS.find((k) => k.canal === b.canal)?.ordem ?? 99));
  const canaisNomes = new Set(itens.map((i) => i.canal));
  const ajustesSemCanal = ativos.filter((a) => !canaisNomes.has(nomeDoCanal(a.canal)));   // ajuste de um canal que não foi registrado: nunca se perde em silêncio
  const painel = itens.reduce((s, i) => s + i.painelCentavos, 0);
  const gerencial = itens.reduce((s, i) => s + i.gerencialCentavos, 0);
  const somaAjustes = itens.reduce((s, i) => s + i.ajustesCentavos, 0);
  const ponte = [{ id: "painel", tipo: "painel", rotulo: "Total do painel por canal (SAIPOS)", centavos: painel },
    ...ativos.filter((a) => canaisNomes.has(nomeDoCanal(a.canal))).map((a) => ({ id: a.id, tipo: "ajuste", canal: nomeDoCanal(a.canal), ajusteTipo: a.tipo, rotulo: a.descricao, centavos: Number(a.valorCentavos), estado: a.estado, evidencia: a.evidencia ?? null })),
    { id: "gerencial", tipo: "gerencial", rotulo: "Faturamento base da DRE gerencial", centavos: gerencial }];
  const estimados = ativos.filter((a) => a.estado === "estimado");
  const diferencaBase = brutoOficialCentavos == null ? null : gerencial - brutoOficialCentavos;
  return {
    canais: itens, ajustes: ativos, ajustesSemCanal, painelCentavos: painel, gerencialCentavos: gerencial, ajustesCentavos: somaAjustes,
    ponte, ponteFecha: painel + somaAjustes === gerencial && itens.every((i) => i.fechaCanal) && ajustesSemCanal.length === 0,
    estimadosCentavos: estimados.reduce((s, a) => s + Number(a.valorCentavos), 0), pendentes: estimados,
    brutoOficialCentavos, diferencaBaseCentavos: diferencaBase, baseConfere: diferencaBase === 0,
    granularidades: [...new Set(itens.map((i) => i.granularidade))],
  };
}
