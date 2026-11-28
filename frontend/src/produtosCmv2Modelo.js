// Produtos / CMV 2.0 — modelo PURO da tela (sem DOM): rótulos, formatação, orientação contextual e filtros.
// Os números vêm SEMPRE da API (motor do backend); aqui só se apresenta.

export const AREAS = [
  { id: "visao", rotulo: "Visão geral" },
  { id: "produtos", rotulo: "Produtos" },
  { id: "preparacoes", rotulo: "Preparações" },
  { id: "insumos", rotulo: "Insumos e embalagens" },
  { id: "pendencias", rotulo: "Central de pendências" },
  { id: "precificacao", rotulo: "Precificação" },
];

export const SITUACAO = {
  inconsistente: { rotulo: "Inconsistente", tom: "bad", texto: "Tem um erro que distorce o custo." },
  incompleta: { rotulo: "Incompleta", tom: "warn", texto: "Falta informação para fechar o custo." },
  aguardando_revisao: { rotulo: "Sem pendências", tom: "ok", texto: "Pronta para revisão e homologação." },
  necessita_revisao: { rotulo: "Precisa de nova revisão", tom: "warn", texto: "Algo mudou depois da homologação." },
  homologada: { rotulo: "Homologada", tom: "info", texto: "Custo oficial aprovado." },
  padronizada: { rotulo: "Padronizada", tom: "muted", texto: "Ficha da franquia." },
  rascunho: { rotulo: "Rascunho", tom: "muted", texto: "Ainda em preenchimento." },
};

export const CRITICIDADE_ROTULO = { critica: "Crítica", alta: "Alta", media: "Média", info: "Informativa" };
export const CONFIANCA_ROTULO = { alta: "Confiança alta", media: "Confiança média", baixa: "Confiança baixa", nenhuma: "Sem sugestão" };

/** Moeda com precisão adaptada: custos por grama (R$ 0,0149) não viram R$ 0,01. */
export function moeda(v, { unidade = null } = {}) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const abs = Math.abs(n);
  const casas = abs === 0 ? 2 : abs < 0.1 ? 4 : abs < 1 ? 3 : 2;
  const s = n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: casas, maximumFractionDigits: casas });
  return unidade ? `${s}/${unidade}` : s;
}

export function numero(v, casas = 2) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas });
}

export function pct(v, casas = 0) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return `${Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas })}%`;
}

/** Rótulo da unidade do rendimento, no singular/plural certo. */
export function unidadeRend(u, n = 2) {
  const m = { g: "g", kg: "kg", ml: "ml", l: "L", un: n === 1 ? "unidade" : "unidades" };
  return m[u] ?? (n === 1 ? "unidade" : "unidades");
}

/** Barra de situação: segmentos na ordem de leitura (problema → pronto). */
export function segmentosSituacao(porSituacao = {}) {
  const ordem = ["inconsistente", "incompleta", "necessita_revisao", "aguardando_revisao", "homologada", "padronizada"];
  const total = ordem.reduce((s, k) => s + (porSituacao[k] ?? 0), 0);
  return ordem.filter((k) => porSituacao[k]).map((k) => ({ chave: k, qtd: porSituacao[k], pct: total ? (porSituacao[k] / total) * 100 : 0, ...SITUACAO[k] }));
}

/** Frase de abertura da visão geral — o resultado, não um rótulo. */
export function fraseSaude(saude) {
  const r = saude?.resumo;
  const total = (r?.produtos_finais ?? 0) + (r?.preparacoes ?? 0);
  if (!total) return { titulo: "Nenhuma ficha cadastrada ainda", sub: "Comece pela preparação que mais se repete no cardápio: ela vira base para vários produtos." };
  const confiavel = saude.dimensoes?.custo_confiavel ?? r.fichas_sem_pendencia;
  if (saude.perfil?.modelo === "franquia_padronizada") {
    return { titulo: `${confiavel} de ${total} fichas da franquia com custo calculado`, sub: "As receitas vêm padronizadas. Aqui você acompanha custos de aquisição, preços e margens." };
  }
  return { titulo: `${confiavel} de ${total} fichas com custo confiável`, sub: confiavel === total ? "Todas as fichas fecham o custo. Revise e homologue para oficializar o CMV." : `${total - confiavel} ainda dependem de correções — comece pelas causas que afetam mais produtos.` };
}

export function filtrarProdutos(itens, { busca = "", situacao = "todas", tipo = "todos" } = {}) {
  const q = busca.trim().toLocaleLowerCase("pt-BR");
  return itens.filter((p) => (!q || p.nome.toLocaleLowerCase("pt-BR").includes(q))
    && (situacao === "todas" || p.situacao === situacao)
    && (tipo === "todos" || (tipo === "preparacao" ? p.tipo === "submontagem" : p.tipo !== "submontagem")));
}

export function filtrarCausas(causas, { criticidade = "todas", codigo = "todos" } = {}) {
  return causas.filter((c) => (criticidade === "todas" || c.criticidade === criticidade) && (codigo === "todos" || c.codigo === codigo));
}

// ------------------------------------------------------------------ assistente
export const ETAPA_ROTULO = {
  identificacao: "Identificação", ingredientes: "Ingredientes e preparações", aproveitamento: "Aproveitamento e perdas",
  porcionamento: "Rendimento e porções", complementares: "Embalagens e custos complementares", precos: "Preços e canais", revisao: "Revisão",
};

export const NATUREZA = {
  produto_final: { rotulo: "Produto final", texto: "Vai para o cardápio: bolo em fatia, uramaki, copo de gelato.", exemplo: "Ex.: Fatia de bolo" },
  preparacao: { rotulo: "Preparação intermediária", texto: "Feita na cozinha e usada em outros produtos: massa, recheio, arroz de sushi, base de gelato.", exemplo: "Ex.: Creme de confeitaria (rende 2.600 g)" },
  revenda: { rotulo: "Produto de revenda", texto: "Comprado pronto e vendido como veio: refrigerante, água, chocolate embalado.", exemplo: "Ex.: Coca-Cola lata 350 ml" },
};

/**
 * Orientação curta por etapa, com exemplo do tipo de operação. Ensina COMO obter o dado, não só pede o campo.
 * @param {string} etapa @param {string} natureza @param {string} [modelo]
 */
export function ajudaEtapa(etapa, natureza) {
  const prep = natureza === "preparacao";
  const A = {
    identificacao: {
      titulo: "O que é este item?",
      passos: ["Escolha se é produto final, preparação ou revenda — isso define as próximas etapas.", "Use o nome como aparece no cardápio ou na cozinha, para a equipe reconhecer."],
    },
    ingredientes: {
      titulo: "Liste tudo o que entra numa receita completa (um lote)",
      passos: [
        "Pese cada ingrediente na unidade em que você compra ou na unidade da receita: o sistema converte g ↔ kg e ml ↔ L.",
        "Massa e volume não se convertem sozinhos (1 L de leite não é 1 kg). Use a unidade do cadastro do insumo.",
        prep ? "Se a receita usa outra preparação (ex.: ganache dentro do recheio), adicione-a como preparação, não como insumo." : "Bases feitas na casa (arroz temperado, calda) entram como preparação — o custo delas é calculado uma vez e reaproveitado.",
      ],
    },
    aproveitamento: {
      titulo: "Quanto do que você compra realmente vai para a receita?",
      passos: [
        "Ligue a balança, coloque o recipiente vazio e aperte a tara (zera o peso do recipiente).",
        "Pese o ingrediente como chega (peso bruto). Ex.: salmão inteiro 3,2 kg.",
        "Limpe (pele, espinhas, cascas), tare de novo e pese o que sobra (peso líquido). Ex.: 2,0 kg.",
        "O sistema calcula o fator de correção (3,2 ÷ 2,0 = 1,6) e o aproveitamento (62,5%). Não digite os dois: eles vêm dos pesos.",
        "Se o insumo já tem a perda embutida no preço, não aplique de novo aqui — o sistema avisa.",
      ],
    },
    porcionamento: {
      titulo: prep ? "Quanto este lote rende pronto?" : "Em quantas porções o lote é vendido?",
      passos: prep
        ? ["Depois de pronto (cozido, batido, resfriado), tare um recipiente e pese o lote inteiro.", "Informe o número na unidade escolhida: 2.600 g — e não 2,6, que seria pouco mais de 2 gramas.", "O custo por grama = custo do lote ÷ rendimento. Se o resultado parecer alto demais, confira a unidade."]
        : ["Conte quantas unidades, fatias ou porções saem de um lote. Ex.: bolo de 2,4 kg cortado em 12 fatias = rendimento 12.", "Porções por peso? Pese 3 porções servidas e use a média."],
    },
    complementares: {
      titulo: "O que mais vai com o produto?",
      passos: ["Embalagens por canal (caixa de delivery, copo, tampa, sachê) entram como insumo tipo embalagem.", "Mão de obra fica separada do CMV: é registrada à parte para não inflar o custo de ingredientes."],
    },
    precos: {
      titulo: "Por quanto o produto é vendido em cada canal?",
      passos: ["Informe o preço praticado hoje no cardápio de cada canal (balcão, iFood, delivery próprio).", "Não use preço médio de pedidos nem preço promocional — eles distorcem o CMV.", "Sem preço, a ficha pode ser concluída; só o CMV % e a margem ficam indisponíveis."],
    },
    revisao: {
      titulo: "Confira antes de concluir",
      passos: ["O custo é calculado pelo sistema — você não digita o custo final.", "Pendências críticas impedem a homologação; as demais aparecem como aviso."],
    },
  };
  return A[etapa] ?? { titulo: ETAPA_ROTULO[etapa] ?? etapa, passos: [] };
}

/** Progresso da ficha a partir das etapas da recuperação (válidas / aplicáveis). */
export function progressoEtapas(etapas = []) {
  const aplic = etapas.filter((e) => e.etapa !== "revisao");
  const ok = aplic.filter((e) => e.estado === "valida").length;
  return { ok, total: aplic.length, pct: aplic.length ? (ok / aplic.length) * 100 : 0 };
}

/** Texto do resultado de um simulador, sem chamar margem de contribuição de lucro. */
export function leituraSimulacao(s) {
  if (!s?.disponivel) return s?.motivo ?? "Simulação indisponível.";
  if (s.margem_contribuicao == null) return "Informe um preço para ver CMV e margens.";
  const mc = moeda(s.margem_contribuicao);
  return s.margem_contribuicao < 0
    ? `Cada venda neste canal deixa ${mc}: o preço não cobre custo e deduções variáveis.`
    : `Cada venda contribui com ${mc} para pagar as despesas fixas (isso ainda não é lucro).`;
}
