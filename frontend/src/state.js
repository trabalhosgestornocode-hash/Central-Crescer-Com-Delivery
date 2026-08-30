// Estado global do app. Único ponto de verdade da UI.

import { registrarResetDeContexto } from "./contextoEscopo.js";

/**
 * @typedef {object} Sessao
 * @property {{id: string, nome: string, email: string, superadmin: boolean}|null} usuario
 * @property {boolean} superadmin
 * @property {Array<object>} acessos           empresas/unidades disponíveis
 * @property {Array<{id: string, nome: string, cidade: string|null}>} unidadesDaEmpresa  unidades da empresa do contexto ATUAL, escolhíveis no seletor global (ver sessao.js#listarUnidadesContexto)
 * @property {{id: string, nome: string, logoUrl: string|null, status: string}|null} empresa
 * @property {{id: string, nome: string}|null} unidade
 * @property {string|null} papel
 * @property {string|null} papelRotulo
 * @property {string[]} permissoes
 * @property {string[]} modulos          módulos contratados pela empresa atual
 * @property {boolean} impersonando
 */

export const state = {
  // Sessão e contexto. O `usuario` é a identidade (login); `empresa`/`unidade`
  // são o contexto escolhido depois. Antes, `usuario` era um e-mail solto e
  // `unidade` era a string fixa "Matriz" — as duas coisas viraram estado real.
  /** @type {Sessao} */
  sessao: {
    usuario: null,
    superadmin: false,
    acessos: [],
    unidadesDaEmpresa: [],
    empresa: null,
    unidade: null,
    papel: null,
    papelRotulo: null,
    permissoes: [],
    modulos: [],
    impersonando: false,
  },

  // navegação
  rota: "dashboard",
  telaAdmin: "dashboard",

  // filtros globais — canal é o único filtro "de verdade" aqui.
  //
  // A TABELA nunca é mais um filtro solto: a fonte de verdade é a tabela
  // OFICIAL da unidade (unidades.tabela_balcao/tabela_ifood, resolvida pelo
  // backend — nunca adivinhada aqui). `tabelasOficiais` é preenchida ao
  // entrar na unidade (ver app.js#mostrarApp); `tabelaComparacao` só existe
  // quando o usuário pede explicitamente para "ver outra tabela" — nesse
  // caso é SÓ estado de sessão (sessionStorage, ver comparacaoTabela.js),
  // nunca grava nada na unidade. Ver Configurações → Tabelas Comerciais para
  // a troca REAL da tabela oficial.
  canal: "balcao",
  tabelasOficiais: { balcao: null, ifood: null },
  // Catálogo de tabelas que a EMPRESA tem preço (opções do dropdown
  // "Comparar" e do seletor de nova tabela oficial). Vem do backend por
  // empresa — nunca uma lista global hardcoded. Preenchido em app.js#mostrarApp.
  tabelasDisponiveis: { balcao: [], ifood: [] },
  tabelaComparacao: null,

  // filtros da tabela de produtos (client-side)
  busca: "",
  filtroStatus: "todos", // todos | saudavel | atencao | critico

  // dados
  linhas: [],           // linhas de CMV mescladas com categoria
  carregando: false,
  erro: null,
  erroCodigo: null,      // ex.: "TABELA_NAO_CONFIGURADA" — ver app.js#carregar
  atualizadoEm: null,

  // "O que a tela mostra agora" — só o que o Agente Crescer precisa pra
  // montar o Page Context (ver agentePageContext.js), nunca mais que isso
  // (nunca id, custo ou preço). Ponte deliberada por `state` (em vez de
  // agentePageContext.js importar dashboardExecutivo.js/parserFoodDelivery.js
  // direto): evita import circular com agentePainel.js, que essas telas
  // também importam (pros botões contextuais). Cada view escreve só o que é
  // dela; agentePageContext.js só lê.
  detalheAberto: { produto: null, insumo: null, pedido: null, attentionPoint: null },
  periodoDashboardExecutivo: { ano: null, mes: null },
  contextoParser: { aba: null, ano: null, mes: null },
};

// Trocar de unidade/empresa zera TUDO o que é dado de negócio aqui.
// `state.linhas` (CMV/produtos) é o caso mais grave: sem este reset, o
// primeiro render depois da troca ainda desenhava a tabela da unidade
// anterior — e entre empresas diferentes isso é dado de outro cliente na
// tela. Filtros de tela também voltam ao padrão: um filtro de busca que
// sobrevive à troca faz a unidade nova parecer vazia sem explicar por quê.
//
// O que NÃO é resetado: `sessao` (quem sou eu / onde estou agora — acabou de
// ser preenchido pela troca) e `rota` (para onde navegar é decisão de
// app.js#mostrarApp, que manda para o dashboard).
registrarResetDeContexto(() => {
  state.linhas = [];
  state.carregando = false;
  state.erro = null;
  state.erroCodigo = null;
  state.atualizadoEm = null;
  state.busca = "";
  state.filtroStatus = "todos";
  state.detalheAberto = { produto: null, insumo: null, pedido: null, attentionPoint: null };
  state.periodoDashboardExecutivo = { ano: null, mes: null };
  state.contextoParser = { aba: null, ano: null, mes: null };
  // Tabela oficial/comparação são dados da UNIDADE — nunca atravessam uma
  // troca de contexto. `tabelasOficiais` é repreenchida por app.js#mostrarApp
  // assim que a unidade nova é conhecida; `tabelaComparacao` só volta se
  // (e somente se) a mesma unidade tinha uma comparação salva na sessão do
  // navegador (ver comparacaoTabela.js) — nunca a de outra unidade.
  state.canal = "balcao";
  state.tabelasOficiais = { balcao: null, ifood: null };
  state.tabelasDisponiveis = { balcao: [], ifood: [] };
  state.tabelaComparacao = null;
});

/** Tabela efetivamente em uso no canal atual — comparação se houver, senão a oficial. Null = nada resolvido ainda/sem configuração. */
export function tabelaAtiva() {
  return state.tabelaComparacao ?? state.tabelasOficiais[state.canal] ?? null;
}

/** A tela está mostrando uma tabela diferente da oficial da unidade? */
export function emComparacao() {
  return state.tabelaComparacao != null && state.tabelaComparacao !== state.tabelasOficiais[state.canal];
}

// Retorna as linhas aplicando busca + filtro de status (não altera o estado)
export function linhasFiltradas() {
  const termo = state.busca.trim().toLowerCase();
  return state.linhas.filter((r) => {
    const passaBusca = !termo || String(r.nome ?? "").toLowerCase().includes(termo);
    if (!passaBusca) return false;
    if (state.filtroStatus === "todos") return true;
    return r._status?.chave === state.filtroStatus;
  });
}
