// Configuração central do frontend (escalável — adicionar itens aqui reflete no app)
export const API_BASE = ""; // mesma origem (backend serve o front)

// DEFAULT OFICIAL do sistema para os limites de CMV (%). Só o ponto de
// partida: a config REAL é por unidade (unidade_config / cmvConfig.js).
// Alinhado à planilha de referência: Saudável < 32% · Atenção 32–40% · Crítico ≥ 40%.
export const CMV_LIMITES = { saudavel: 32, atencao: 40 };

// Comissão por canal (espelha canais_venda no banco) — usada no simulador de preço
export const COMISSAO = { balcao: 0, ifood: 0.27, uber: 0.15, app: 0, outro: 0 };

// (removidos nesta fase, por serem taxonomia/dados fixos de UM tenant:
//   * TABELAS — a lista de tabelas comerciais agora vem do backend, por
//     empresa (o que ela tem preço cadastrado): state.tabelasDisponiveis,
//     origem GET /api/v1/unidade/tabelas-comerciais -> catalogo.
//   * IFOOD_LOJA — nome/URL da loja no iFood era hardcoded da Subway. A
//     vitrine (cardapio.js) era código órfão e foi removida; a integração
//     iFood real é por unidade, no módulo próprio.)

// Ordem das seções da sidebar
export const SECOES = ["OPERAÇÃO", "INTEGRAÇÕES", "INTELIGÊNCIA", "SISTEMA"];

// Módulo que faz de GATE-PAI de uma seção inteira do menu. Se a empresa/unidade
// do contexto não tem o módulo, a seção some por completo (título + todos os
// itens) e as rotas dela ficam inacessíveis — mesmo que um item interno tenha
// o próprio módulo habilitado (ex.: `agente_ia` sem `inteligencia` = seção
// oculta). Consumido por app.js#montarMenu e router.js#acessivel; o bloqueio
// real de dado está na API (backend/src/routes.js — requireModulo).
export const SECAO_MODULO = {
  "INTELIGÊNCIA": "inteligencia",
};

// Itens da sidebar. tipo: pagina | construcao | integracao | integracoes
//
// `modulo`: id do módulo contratável (ver backend/src/shared/modulos.js) que
// controla se este item aparece para a empresa logada. Item sem `modulo`
// (Agente de IA, Relatórios, Integrações-hub, Configurações) fica sempre
// visível — a Crescer não gateia infraestrutura do sistema, só as
// funcionalidades de OPERAÇÃO/INTEGRAÇÕES que o SuperAdmin provisiona por
// empresa (ver frontend/src/sessao.js#temModulo e app.js#montarMenu).
// `icon` é um nome do conjunto de ícones SVG compartilhado (ver icons.js),
// não emoji — rebrand visual: sidebar sem emoji, mesmo estilo de traço da
// tela de login. `logo` (imagem) tem prioridade sobre `icon` (ver
// app.js#montarMenu) — usado tanto para logotipo real de integração quanto
// para os ícones de arte própria da unidade em /assets (ícones "neon"
// vermelho/preto pedidos para a seção OPERAÇÃO — autorizado usar todos,
// incluindo os 4 com arte de marca de terceiro, ciente do alcance
// multiempresa do menu).
export const MENU = [
  { id: "dashboard",     label: "Dashboard",       icon: "bar-chart", logo: "/assets/menu-dashboard.png", tipo: "pagina",      secao: "OPERAÇÃO", modulo: "dashboard" },
  { id: "produtos",      label: "Produtos / CMV",  icon: "grid", logo: "/assets/menu-produtos-cmv.png", tipo: "pagina",      secao: "OPERAÇÃO", modulo: "products_cmv" },
  { id: "insumos",       label: "Insumos",         icon: "tag", logo: "/assets/menu-insumos.png", tipo: "insumos",     secao: "OPERAÇÃO", modulo: "ingredients" },
  { id: "estoque",       label: "Estoque",         icon: "package", logo: "/assets/menu-estoque.png", tipo: "construcao",  secao: "OPERAÇÃO", modulo: "inventory" },
  { id: "vendas",        label: "Vendas",          icon: "receipt", logo: "/assets/menu-vendas.png", tipo: "vendas",      secao: "OPERAÇÃO", modulo: "sales" },
  { id: "dashboard-executivo", label: "Dashboard iFood", icon: "trending-up", logo: "/assets/menu-dashboard-ifood.png", tipo: "dashboard-executivo", secao: "OPERAÇÃO", modulo: "ifood_dashboard" },
  { id: "bonificacao-mensal", label: "Bonificação Mensal", icon: "award", logo: "/assets/menu-bonificacao-mensal.png", tipo: "bonificacao-mensal", secao: "OPERAÇÃO", modulo: "monthly_bonus" },
  { id: "parser-food-delivery", label: "Parser Food Delivery", icon: "truck", logo: "/assets/menu-parser-food-delivery.png", tipo: "parser-food-delivery", secao: "OPERAÇÃO", modulo: "parser_food_delivery" },
  { id: "distribuidoras",label: "Distribuidoras",  icon: "truck", logo: "/assets/menu-distribuidoras.png", tipo: "construcao",  secao: "OPERAÇÃO", modulo: "distributors" },
  { id: "martinbrower",  label: "Martin Brower",   icon: "package", tipo: "martinbrower", integ: "martinbrower", secao: "INTEGRAÇÕES", modulo: "martin_brower" },
  { id: "swfast",        label: "SWFast / PDV",    icon: "credit-card", tipo: "integracao",  integ: "swfast",       secao: "INTEGRAÇÕES", modulo: "swfast" },
  { id: "ifood",         label: "iFood",           icon: "truck", tipo: "ifood",        integ: "ifood",        secao: "INTEGRAÇÕES", modulo: "ifood" },
  { id: "cocacola",      label: "Coca-Cola",       icon: "tag", tipo: "integracao",  integ: "cocacola",     secao: "INTEGRAÇÕES", modulo: "coca_cola" },
  { id: "claudiahortifruti", label: "Cláudia Hortifruti", icon: "tag", tipo: "integracao", integ: "claudiahortifruti", secao: "INTEGRAÇÕES", modulo: "hortifruti" },
  { id: "ia",            label: "Agente Crescer",  icon: "bot", tipo: "agente",      secao: "INTELIGÊNCIA", modulo: "agente_ia" },
  { id: "relatorios",    label: "Relatórios",      icon: "pie-chart", tipo: "construcao",  secao: "INTELIGÊNCIA" },
  { id: "integracoes",   label: "Integrações",     icon: "link", tipo: "integracoes", secao: "INTELIGÊNCIA" },
  { id: "configuracoes", label: "Configurações",   icon: "settings", tipo: "configuracoes", secao: "SISTEMA" },
];

// ---------- Insumos / Ficha técnica ----------
// "Categoria" do insumo = enum tipo_insumo do banco (espelha o backend).
export const CATEGORIAS_INSUMO = [
  ["proteina", "Proteína"], ["queijo", "Queijo"], ["molho", "Molho"], ["vegetal", "Vegetal"],
  ["pao", "Pão"], ["embalagem", "Embalagem"], ["bebida", "Bebida"], ["descartavel", "Descartável"],
  ["doce", "Doce"], ["chips", "Chips"], ["outro", "Outro"],
];
export const CATEGORIA_INSUMO_ROTULO = Object.fromEntries(CATEGORIAS_INSUMO);

// Unidades-base suportadas na 1ª versão (unidade, massa, volume).
export const UNIDADES_BASE = [
  ["un", "unidade"], ["g", "grama"], ["kg", "quilograma"], ["ml", "mililitro"], ["l", "litro"],
];
export const UNIDADE_ROTULO = { ...Object.fromEntries(UNIDADES_BASE), fatia: "fatia", porcao: "porção", folha: "folha" };

// Sugestões de forma de compra (campo descritivo — não é unidade de medida).
export const FORMAS_COMPRA = ["caixa", "pacote", "saco", "garrafa", "bandeja", "fardo", "unidade"];

// Status possíveis de integração
export const STATUS_INTEGRACAO = {
  conectado:     { label: "Conectado",              classe: "ok" },
  planejamento:  { label: "Em planejamento",        classe: "warn" },
  futuro:        { label: "Futuramente conectado",  classe: "info" },
  nao_conectado: { label: "Não conectado",          classe: "muted" },
};

// O CATÁLOGO de integrações (descrições, features, status, arquitetura) SAIU
// daqui: é informação interna/estratégica e agora é servido só pelo backend,
// atrás do módulo `inteligencia` (GET /api/v1/inteligencia/integracoes — ver
// backend/src/modules/inteligencia/inteligencia.catalogo.js). O frontend não
// guarda mais cópia nem fallback: sem o módulo, a página Integrações nem carrega.
//
// O que fica aqui é só o mínimo para o menu: o LOGO das integrações que têm
// item próprio na seção operacional "INTEGRAÇÕES" (e o do Dashboard iFood).
// Caminhos de imagem pública em /assets — nada sensível.
export const INTEGRACOES_LOGOS = {
  ifood: "/assets/menu-dashboard-ifood.png",
  swfast: "/assets/menu-swfast.png",
  martinbrower: "/assets/menu-martinbrower.png",
  cocacola: "/assets/menu-cocacola.png",
  claudiahortifruti: "/assets/menu-claudiahortifruti.png",
};
