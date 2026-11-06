// Menu do setor FINANCEIRO — contrato com o Agente 2 (docs/gestao-financeira/00-contrato-agente1-agente2.md).
//
// Cada item tem um `id` (rota interna) e um `pagina`: o arquivo `frontend/src/financeiro/<pagina>.js` (do Agente 2) que
// exporta `render(container, ctx)`. Enquanto o arquivo não existe, o roteador mostra "Em construção" — nunca finge
// que a funcionalidade está pronta. O menu pertence ao Agente 1; o CONTEÚDO das páginas ao Agente 2.

export const SECAO_FINANCEIRO = "FINANCEIRO";

// `fin2: true` = Financeiro 2.0, atrás de FEATURE FLAG do servidor (GET /gestao-financeira/status → financeiro2). Nasce OCULTO no menu.
/** @type {Array<{id:string,label:string,icon:string,pagina:string,secao:string,tipo:'financeiro',fin2?:boolean}>} */
export const MENU_FINANCEIRO = [
  { id: "fin-visao-geral",   label: "Visão Geral",             icon: "bar-chart",   pagina: "visao-geral" },
  { id: "fin-contas-a-pagar", label: "Contas a Pagar",         icon: "wallet",      pagina: "contas-a-pagar", fin2: true },
  { id: "fin-conciliacao-saidas", label: "Conciliação de Saídas", icon: "list-checks", pagina: "conciliacao-saidas", fin2: true },
  { id: "fin-juros",         label: "Juros e Encargos",        icon: "calculator",  pagina: "juros", fin2: true },
  { id: "fin-fluxo-de-caixa", label: "Fluxo de Caixa",         icon: "trending-up", pagina: "fluxo-de-caixa" },
  { id: "fin-contas",        label: "Contas Financeiras",      icon: "credit-card", pagina: "contas" },
  { id: "fin-conciliacao",   label: "Conciliação",             icon: "receipt",     pagina: "conciliacao" },
  { id: "fin-dre",           label: "DRE Gerencial",           icon: "pie-chart",   pagina: "dre" },
  { id: "fin-indicadores",   label: "Indicadores",             icon: "activity",    pagina: "indicadores" },
  { id: "fin-categorias",    label: "Análise de Categorias",   icon: "tag",         pagina: "categorias" },
  { id: "fin-plano-de-contas", label: "Plano de Contas",       icon: "grid",        pagina: "plano-de-contas" },
  { id: "fin-periodos",      label: "Períodos",                icon: "award",       pagina: "periodos" },
  { id: "fin-importacao",    label: "Importação",              icon: "package",     pagina: "importacao" },
  { id: "fin-relatorios",    label: "Relatórios",              icon: "link",        pagina: "relatorios" },
  { id: "fin-configuracoes", label: "Configurações Financeiras", icon: "settings",  pagina: "configuracoes" },
  // Financeiro 2.0 — painel, receitas e DRE de referência (atrás do mesmo feature flag)
  { id: "fin-painel",        label: "Visão Geral",             icon: "bar-chart",   pagina: "painel", fin2: true },
  { id: "fin-receitas",      label: "Receitas e Vendas",       icon: "trending-up", pagina: "receitas", fin2: true },
  { id: "fin-dre-referencia", label: "DRE Gerencial de Referência", icon: "pie-chart", pagina: "dre-referencia", fin2: true },
  // 152 — rateios, contas a receber, dívidas e empréstimos
  { id: "fin-rateios",       label: "Rateios por Competência", icon: "grid",        pagina: "rateios", fin2: true },
  { id: "fin-contas-a-receber", label: "Contas a Receber",     icon: "wallet",      pagina: "contas-a-receber", fin2: true },
  { id: "fin-dividas",       label: "Dívidas e Empréstimos",   icon: "credit-card", pagina: "dividas", fin2: true },
].map((i) => ({ ...i, secao: SECAO_FINANCEIRO, tipo: "financeiro" }));

// Com o Financeiro 2.0 LIGADO, o menu é organizado nos seis módulos (sem remover nenhuma tela existente).
// Desligado, o menu acima continua idêntico (lista simples).
export const MODULOS_FINANCEIRO = Object.freeze([
  { id: "visao", rotulo: "Visão Geral", itens: ["fin-painel"] },
  { id: "receitas", rotulo: "Receitas e Vendas", itens: ["fin-receitas", "fin-contas-a-receber"] },
  { id: "despesas", rotulo: "Despesas e Pagamentos", itens: ["fin-contas-a-pagar", "fin-juros", "fin-dividas"] },
  { id: "caixa", rotulo: "Caixa e Conciliação", itens: ["fin-visao-geral", "fin-fluxo-de-caixa", "fin-contas", "fin-conciliacao", "fin-conciliacao-saidas"] },
  { id: "resultados", rotulo: "Custos e Resultados", itens: ["fin-dre-referencia", "fin-rateios", "fin-dre", "fin-indicadores", "fin-categorias"] },
  { id: "controle", rotulo: "Controle e Relatórios", itens: ["fin-periodos", "fin-importacao", "fin-relatorios", "fin-plano-de-contas", "fin-configuracoes"] },
]);
/** Rótulos no menu agrupado (a Visão Geral de caixa passa a se chamar Resumo de Caixa ao lado do painel 2.0). */
export const ROTULOS_AGRUPADOS = Object.freeze({ "fin-visao-geral": "Resumo de Caixa", "fin-dre": "DRE de Caixa" });
