// Diagnóstico DETERMINÍSTICO das fichas técnicas — base do painel de saúde e da Central de Pendências.
//
// Puro (sem I/O): recebe o grafo de custo.js (carregarGrafo) e devolve pendências acionáveis, agrupadas por
// CAUSA-RAIZ. Não altera dado, não arredonda, não transforma desconhecido em zero. Não depende do nome/ID da
// empresa: o comportamento muda só pelos dados (homologacao='nao_aplicavel' = ficha padronizada de franquia,
// tipo/vendavel/unidade_rendimento da própria ficha).
//
// Regra central de rendimento: numa preparação por PESO/VOLUME, o lote não pode render uma fração mínima da
// massa dos seus componentes. Ex.: 2.700 g de ingredientes e rendimento "2,6 g"
// -> o valor está em kg (2.600 g) e o custo por grama fica 1.000× maior. Só SINALIZA; nunca corrige sozinho.

const DIM = { g: ["massa", 1], kg: ["massa", 1000], ml: ["volume", 1], l: ["volume", 1000] };
const ativa = (f) => f.ativo !== false;

/** Abaixo disto (rendimento ÷ massa dos componentes) o rendimento é tratado como erro de unidade provável. */
export const RAZAO_RENDIMENTO_MIN = 0.05;
/** Acima disto, aviso (expansão improvável sem água/ar declarados — ex.: gelato com overrun deve ser conferido). */
export const RAZAO_RENDIMENTO_MAX = 3;

export const CRITICIDADE = { critica: 3, alta: 2, media: 1, info: 0 };

/** Texto educativo de cada tipo de pendência: o que é, por que importa, como corrigir. */
export const CATALOGO_PENDENCIAS = {
  rendimento_unidade_suspeita: {
    criticidade: "critica", onde: "Rendimento e porcionamento",
    problema: "O rendimento parece estar em uma unidade diferente da informada (ex.: 2,6 kg digitado como 2,6 g).",
    impacto: "O custo por grama/ml é dividido por um número ~1.000× menor e contamina todos os produtos que usam esta preparação.",
    correcao: "Pese o lote pronto e informe o rendimento na unidade indicada (ex.: 2.600 g). Os produtos dependentes são recalculados.",
  },
  rendimento_expansao_alta: {
    criticidade: "media", onde: "Rendimento e porcionamento",
    problema: "O lote rende bem mais do que a soma dos ingredientes pesados.",
    impacto: "Pode ser legítimo (água, gelo, incorporação de ar), mas se for erro o custo unitário fica subestimado.",
    correcao: "Confira se algum ingrediente (água, por exemplo) não foi lançado ou se o rendimento foi digitado a mais.",
  },
  rendimento_sem_unidade: {
    criticidade: "alta", onde: "Rendimento e porcionamento",
    problema: "Preparação usada por peso/volume sem unidade de rendimento.",
    impacto: "Quem usa a preparação não sabe se a quantidade é em g, ml ou unidade.",
    correcao: "Informe se o lote rende em gramas, mililitros ou unidades.",
  },
  insumo_sem_custo: {
    criticidade: "critica", onde: "Insumos e embalagens",
    problema: "Insumo sem preço de compra válido.",
    impacto: "O custo da ficha fica incompleto (o sistema não presume custo zero) e o CMV não é exibido.",
    correcao: "Cadastre o preço e a quantidade da embalagem do insumo uma única vez — todas as fichas que o usam são recalculadas.",
  },
  insumo_inativo: {
    criticidade: "alta", onde: "Ingredientes",
    problema: "A ficha usa um insumo desativado.",
    impacto: "O custo pode estar baseado em um preço que não é mais praticado.",
    correcao: "Substitua pelo insumo vigente ou reative-o.",
  },
  preparacao_comprometida: {
    criticidade: "alta", onde: "Preparações utilizadas",
    problema: "Uma preparação usada nesta ficha tem pendência crítica.",
    impacto: "O custo herdado da preparação não é confiável.",
    correcao: "Corrija a preparação indicada; esta ficha é recalculada automaticamente.",
  },
  sem_componentes: {
    criticidade: "alta", onde: "Ingredientes",
    problema: "Ficha sem nenhum ingrediente ativo.",
    impacto: "Não há custo calculável.",
    correcao: "Adicione os ingredientes, preparações e embalagens do produto.",
  },
  ciclo: {
    criticidade: "critica", onde: "Preparações utilizadas",
    problema: "Dependência circular entre preparações (A usa B, que usa A).",
    impacto: "O custo não pode ser calculado.",
    correcao: "Remova a preparação que faz a receita depender de si mesma.",
  },
  quantidade_invalida: {
    criticidade: "alta", onde: "Ingredientes",
    problema: "Linha com quantidade zerada ou inválida.",
    impacto: "O componente não entra no custo.",
    correcao: "Informe a quantidade usada ou remova a linha.",
  },
  pendencia_carga: {
    criticidade: "alta", onde: "Origem (planilha importada)",
    problema: "A importação registrou um item que precisa de conferência (linha descartada, nome sem correspondência ou custo inválido na planilha).",
    impacto: "A ficha pode estar sem um componente que existia na planilha original.",
    correcao: "Compare a ficha com a planilha, ajuste o que faltar e marque as pendências da carga como conferidas.",
  },
  sem_preco_venda: {
    criticidade: "media", onde: "Preço de venda e canais",
    problema: "Produto vendável sem preço de venda.",
    impacto: "Não é possível calcular CMV % nem margem.",
    correcao: "Informe o preço de venda nos canais em que o produto é vendido.",
  },
};

function fatorPara(unidadeOrigem, unidadeAlvo) {
  const a = DIM[unidadeOrigem]; const b = DIM[unidadeAlvo];
  if (!a || !b || a[0] !== b[0]) return null; // nunca converte massa↔volume↔unidade sem fator explícito
  return a[1] / b[1];
}

/**
 * Massa/volume dos componentes do lote na unidade do rendimento. Considera só linhas na mesma dimensão;
 * devolve também a fração de linhas comparáveis (para não acusar uma receita com muitos itens em "un").
 * @returns {{massa: number, comparaveis: number, total: number}}
 */
export function massaDoLote(produtoId, grafo) {
  const un = grafo.unidadeRendimentoById?.get(produtoId);
  let massa = 0; let comparaveis = 0; let total = 0;
  for (const f of grafo.fichaByProd.get(produtoId) ?? []) {
    if (!ativa(f)) continue;
    total += 1;
    const unLinha = f.insumo_id
      ? grafo.insumoById.get(f.insumo_id)?.unidade_medida
      : grafo.unidadeRendimentoById?.get(f.subproduto_id);
    const fator = fatorPara(unLinha, un);
    const q = Number(f.quantidade);
    if (fator == null || !Number.isFinite(q) || q <= 0) continue;
    massa += q * fator; comparaveis += 1;
  }
  return { massa, comparaveis, total };
}

/**
 * Plausibilidade do rendimento de uma preparação por peso/volume.
 * @returns {null|{codigo: string, razao: number, massa: number, sugestao: number|null}}
 */
export function avaliarRendimento({ rendimento, unidade, massa, comparaveis, total }) {
  if (!DIM[unidade]) return null;
  const r = Number(rendimento);
  if (!Number.isFinite(r) || r <= 0 || !(massa > 0)) return null;
  if (comparaveis < Math.max(1, total * 0.6)) return null; // poucos itens comparáveis: sem base para afirmar
  const razao = r / massa;
  if (razao < RAZAO_RENDIMENTO_MIN) {
    const x1000 = r * 1000; // hipótese mais comum: valor em kg/l digitado na unidade g/ml
    const plausivel = x1000 / massa >= 0.3 && x1000 / massa <= 1.5;
    return { codigo: "rendimento_unidade_suspeita", razao, massa, sugestao: plausivel ? x1000 : null };
  }
  if (razao > RAZAO_RENDIMENTO_MAX) return { codigo: "rendimento_expansao_alta", razao, massa, sugestao: null };
  return null;
}

/** Produtos que formam ciclo (alcançam a si mesmos pelas preparações). */
export function produtosEmCiclo(grafo) {
  const emCiclo = new Set();
  const estado = new Map(); // 1 = visitando, 2 = concluído
  const pilha = [];
  const visitar = (pid) => {
    estado.set(pid, 1); pilha.push(pid);
    for (const f of grafo.fichaByProd.get(pid) ?? []) {
      if (!ativa(f) || !f.subproduto_id) continue;
      const s = f.subproduto_id;
      if (estado.get(s) === 1) { for (let i = pilha.indexOf(s); i < pilha.length; i += 1) emCiclo.add(pilha[i]); }
      else if (!estado.has(s)) visitar(s);
    }
    pilha.pop(); estado.set(pid, 2);
  };
  for (const pid of grafo.fichaByProd.keys()) if (!estado.has(pid)) visitar(pid);
  return emCiclo;
}

/**
 * Diagnóstico completo da organização.
 * @param {object} grafo de carregarGrafo()
 * @param {{precoVendaPorProduto?: Map<string, number|null>}} [opcoes] preço vigente (qualquer canal) por produto
 */
export function diagnosticarOrganizacao(grafo, { precoVendaPorProduto = new Map(), pendenciasCarga = null } = {}) {
  const ciclos = produtosEmCiclo(grafo);
  const porProduto = new Map(); // id -> [{codigo, detalhe, causa}]
  const raizes = new Map(); // chave da causa -> {codigo, alvo, nome, detalhe, sugestao, diretos:Set}
  const add = (pid, item) => { if (!porProduto.has(pid)) porProduto.set(pid, []); porProduto.get(pid).push(item); };
  const raiz = (chave, base) => { if (!raizes.has(chave)) raizes.set(chave, { ...base, chave, diretos: new Set() }); return raizes.get(chave); };

  for (const p of grafo.produtos) {
    if (p.ativo === false) continue;
    const linhas = (grafo.fichaByProd.get(p.id) ?? []).filter(ativa);
    if (!linhas.length) add(p.id, { codigo: "sem_componentes", causa: `prod:${p.id}` });
    if (ciclos.has(p.id)) add(p.id, { codigo: "ciclo", causa: `ciclo:${p.id}` });
    // Pendências PRÓPRIAS da carga (a propagação pelas preparações é feita abaixo, como as demais).
    const carga = pendenciasCarga?.(p.id);
    if (carga?.length) add(p.id, { codigo: "pendencia_carga", causa: `prod:${p.id}`, detalhe: [...new Set(carga.map((x) => x.codigo))] });
    for (const f of linhas) {
      const q = Number(f.quantidade);
      if (!Number.isFinite(q) || q <= 0) add(p.id, { codigo: "quantidade_invalida", causa: `prod:${p.id}`, detalhe: f.id });
      if (f.insumo_id) {
        const ins = grafo.insumoById.get(f.insumo_id);
        const preco = ins?.preco_unitario == null ? null : Number(ins.preco_unitario);
        if (ins?.custo_zero_declarado !== true && (preco == null || !(preco > 0))) {
          raiz(`ins:${f.insumo_id}`, { codigo: "insumo_sem_custo", alvo: { tipo: "insumo", id: f.insumo_id }, nome: ins?.nome ?? "?" }).diretos.add(p.id);
          add(p.id, { codigo: "insumo_sem_custo", causa: `ins:${f.insumo_id}`, detalhe: ins?.nome ?? "?" });
        } else if (ins?.ativo === false) {
          add(p.id, { codigo: "insumo_inativo", causa: `prod:${p.id}`, detalhe: ins.nome });
        }
      }
    }
    const un = grafo.unidadeRendimentoById?.get(p.id) ?? null;
    if (p.tipo === "submontagem" && p.homologacao !== "nao_aplicavel" && !un) {
      add(p.id, { codigo: "rendimento_sem_unidade", causa: `prod:${p.id}` });
    }
    const aval = avaliarRendimento({ rendimento: p.rendimento, unidade: un, ...massaDoLote(p.id, grafo) });
    if (aval) {
      raiz(`rend:${p.id}`, { codigo: aval.codigo, alvo: { tipo: "produto", id: p.id }, nome: p.nome,
        detalhe: { rendimento: Number(p.rendimento), unidade: un, massa_componentes: aval.massa, razao: aval.razao, sugestao: aval.sugestao } }).diretos.add(p.id);
      add(p.id, { codigo: aval.codigo, causa: `rend:${p.id}`, detalhe: { rendimento: Number(p.rendimento), unidade: un, massa_componentes: aval.massa, sugestao: aval.sugestao } });
    }
    if (p.vendavel !== false && p.tipo !== "submontagem" && precoVendaPorProduto.size) {
      const pv = precoVendaPorProduto.get(p.id);
      if (!(Number(pv) > 0)) add(p.id, { codigo: "sem_preco_venda", causa: `prod:${p.id}` });
    }
  }

  // Propagação: quem usa (direta ou indiretamente) uma preparação com pendência crítica herda a pendência.
  // (pendência de carga também propaga: a homologação existente já bloqueia quem usa preparação com carga não conferida)
  const criticosDiretos = new Set([...porProduto].filter(([, l]) => l.some((x) => CATALOGO_PENDENCIAS[x.codigo].criticidade === "critica" || x.codigo === "pendencia_carga")).map(([id]) => id));
  const usadoPor = new Map();
  for (const [pid, linhas] of grafo.fichaByProd) for (const f of linhas) if (ativa(f) && f.subproduto_id) {
    if (!usadoPor.has(f.subproduto_id)) usadoPor.set(f.subproduto_id, new Set());
    usadoPor.get(f.subproduto_id).add(pid);
  }
  const afetadosPor = (ids) => {
    const vistos = new Set(); const fila = [...ids];
    while (fila.length) { const x = fila.pop(); for (const u of usadoPor.get(x) ?? []) if (!vistos.has(u)) { vistos.add(u); fila.push(u); } }
    return vistos;
  };
  for (const id of criticosDiretos) {
    for (const u of afetadosPor([id])) {
      const lista = porProduto.get(u) ?? [];
      if (!lista.some((x) => x.codigo === "preparacao_comprometida" && x.detalhe === id)) add(u, { codigo: "preparacao_comprometida", causa: `prod:${id}`, detalhe: id });
    }
  }

  const nomeDe = (id) => grafo.nomeProdById.get(id) ?? "?";
  const causasRaiz = [...raizes.values()].map((r) => {
    const impactados = new Set([...r.diretos, ...afetadosPor(r.diretos)]);
    return { ...r, diretos: [...r.diretos], impactados: [...impactados], qtd_impactados: impactados.size,
      criticidade: CATALOGO_PENDENCIAS[r.codigo].criticidade, ...CATALOGO_PENDENCIAS[r.codigo] };
  }).sort((a, b) => CRITICIDADE[b.criticidade] - CRITICIDADE[a.criticidade] || b.qtd_impactados - a.qtd_impactados);

  const produtos = grafo.produtos.filter((p) => p.ativo !== false).map((p) => {
    const pend = porProduto.get(p.id) ?? [];
    const pior = pend.reduce((m, x) => Math.max(m, CRITICIDADE[CATALOGO_PENDENCIAS[x.codigo].criticidade]), -1);
    const situacao = situacaoFicha({ produto: p, pendencias: pend, pior });
    return { id: p.id, nome: nomeDe(p.id), tipo: p.tipo, vendavel: p.vendavel !== false, homologacao: p.homologacao ?? "nao_aplicavel", situacao, pendencias: pend };
  });
  return { produtos, causasRaiz, resumo: resumir(produtos, grafo, causasRaiz) };
}

/**
 * Situação de governança da ficha (estado gravado + diagnóstico). 'nao_aplicavel' = ficha padronizada (franquia),
 * fora do fluxo de homologação: só reporta pendência crítica, nunca muda o processo dela.
 */
export function situacaoFicha({ produto, pendencias, pior }) {
  const h = produto.homologacao ?? "nao_aplicavel";
  if (pior >= CRITICIDADE.critica) return "inconsistente";
  if (pendencias.some((x) => ["sem_componentes", "quantidade_invalida", "insumo_inativo", "rendimento_sem_unidade", "preparacao_comprometida", "pendencia_carga"].includes(x.codigo))) return "incompleta";
  if (h === "nao_aplicavel") return "padronizada";
  if (h === "homologada") return "homologada";
  if (h === "pendente" && produto.homologacao_motivo) return "necessita_revisao";
  return "aguardando_revisao";
}

/**
 * Elegibilidade para homologação pelo diagnóstico COMPLETO (inclui preparações aninhadas — o critério antigo olhava só
 * o 1º nível). Bloqueia pendência crítica ou de completude; preço de venda NÃO é exigido (a ficha pode ser concluída
 * sem preço, e a rentabilidade fica explicitamente indisponível). Ficha padronizada (franquia) não entra no fluxo.
 * @param {{situacao: string, pendencias: Array<{codigo: string}>}} item de diagnosticarOrganizacao().produtos
 */
export function elegibilidadeHomologacao(item) {
  if (item.situacao === "padronizada" || item.homologacao === "nao_aplicavel") return { elegivel: false, motivos: ["Ficha padronizada da franquia: fora do fluxo de homologação."] };
  if (item.situacao === "homologada") return { elegivel: false, motivos: ["Já homologada."] };
  const motivos = [...new Set(item.pendencias.filter((x) => x.codigo !== "sem_preco_venda").map((x) => CATALOGO_PENDENCIAS[x.codigo].problema))];
  return { elegivel: motivos.length === 0, motivos };
}

/**
 * As cinco dimensões que NÃO se confundem: completude da receita, confiabilidade do custo, preço comercial,
 * CMV % e rentabilidade. Uma ficha correta sem preço é "completa e confiável", mas sem CMV/rentabilidade.
 */
export function dimensoesDaFicha(item, { temPreco, temCondicoesCanal }) {
  const cods = new Set(item.pendencias.map((x) => x.codigo));
  const completa = !["sem_componentes", "quantidade_invalida", "rendimento_sem_unidade"].some((c) => cods.has(c));
  const custoConfiavel = completa && ![...cods].some((c) => ["critica", "alta"].includes(CATALOGO_PENDENCIAS[c].criticidade) && c !== "sem_preco_venda");
  return {
    receita_completa: completa,
    custo_confiavel: custoConfiavel,
    preco_comercial: !!temPreco,
    cmv_disponivel: custoConfiavel && !!temPreco,
    rentabilidade_disponivel: custoConfiavel && !!temPreco && !!temCondicoesCanal,
  };
}

const semPendenciaTecnica = (p) => !p.pendencias.some((x) => x.codigo !== "sem_preco_venda");

function resumir(produtos, grafo, causasRaiz) {
  const conta = (f) => produtos.filter(f).length;
  const insumosAtivos = [...grafo.insumoById.values()].filter((i) => i.ativo !== false);
  const insumosSemCusto = insumosAtivos.filter((i) => i.custo_zero_declarado !== true && !(Number(i.preco_unitario) > 0)).length;
  return {
    produtos_finais: conta((p) => p.tipo !== "submontagem"),
    preparacoes: conta((p) => p.tipo === "submontagem"),
    por_situacao: produtos.reduce((m, p) => ({ ...m, [p.situacao]: (m[p.situacao] ?? 0) + 1 }), {}),
    insumos: grafo.insumoById.size,
    insumos_sem_custo: insumosSemCusto,
    insumos_custo_zero_declarado: insumosAtivos.filter((i) => i.custo_zero_declarado === true).length,
    homologadas: conta((p) => p.situacao === "homologada"),
    elegiveis_homologacao: conta((p) => elegibilidadeHomologacao(p).elegivel),
    rendimentos_suspeitos: causasRaiz.filter((c) => c.codigo === "rendimento_unidade_suspeita").length,
    sem_preco_venda: conta((p) => p.pendencias.some((x) => x.codigo === "sem_preco_venda")),
    // Qualidade TÉCNICA (receita + custo). Preço comercial é dimensão à parte: não reduz a qualidade da ficha.
    fichas_sem_pendencia: conta(semPendenciaTecnica),
    qualidade_pct: produtos.length ? (conta(semPendenciaTecnica) / produtos.length) * 100 : null,
  };
}
