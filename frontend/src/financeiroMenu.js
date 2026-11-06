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
].map((i) => ({ ...i, secao: SECAO_FINANCEIRO, tipo: "financeiro" }));
