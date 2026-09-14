import { state } from "./state.js";
import { MENU, SECAO_MODULO } from "./config.js";
import { el, els, toast } from "./utils.js";
import { temModulo } from "./sessao.js";
import * as views from "./views.js";
import { renderConfiguracoes } from "./configuracoes.js";
import { renderVendas } from "./vendas.js";
import { renderMartinBrower } from "./martinbrower.js";
import { renderInsumos } from "./insumos.js";
import { renderDashboardExecutivo } from "./dashboardExecutivo.js";
import { renderBonificacaoMensal } from "./bonificacaoMensal.js";
import { renderParserFoodDelivery } from "./parserFoodDelivery.js";
import { renderAgente } from "./agente.js";
import { sincronizarContextoPainel } from "./agentePainel.js";
import { resetScrollLock } from "./scrollLock.js";

/**
 * Um item da sidebar está liberado para a empresa do contexto atual?
 * Duas barreiras, nesta ordem:
 *   1. gate-pai da SEÇÃO (SECAO_MODULO) — ex.: sem `inteligencia`, nenhum item
 *      da seção "INTELIGÊNCIA" passa, mesmo que tenha módulo próprio;
 *   2. módulo do próprio item (ex.: `agente_ia`).
 */
const acessivel = (item) => {
  const gateSecao = SECAO_MODULO[item.secao];
  if (gateSecao && !temModulo(gateSecao)) return false;
  return !item.modulo || temModulo(item.modulo);
};

/**
 * Primeira rota que a empresa atual pode ver — usado como destino de entrada
 * (login) e como fallback quando a rota corrente perde o acesso (módulo
 * revogado). "configuracoes" nunca é gateado por módulo, então sempre existe
 * uma rota de saída: nunca cai num loop de redirecionamento.
 */
export function primeiraRotaAcessivel() {
  return MENU.find(acessivel)?.id ?? "configuracoes";
}

// Navega para uma rota da sidebar
export function irPara(rotaId) {
  const alvo = MENU.find((m) => m.id === rotaId) || MENU[0];
  const item = acessivel(alvo) ? alvo : (MENU.find((m) => m.id === primeiraRotaAcessivel()) ?? MENU[0]);
  state.rota = item.id;
  el("#page-title").textContent = item.label;
  els("#menu li").forEach((li) => li.classList.toggle("ativo", li.dataset.rota === item.id));
  el("#app").classList.remove("menu-aberto"); // fecha sidebar no mobile
  renderRotaAtual();
}

// Renderiza a view da rota atual (chamado também após (re)carregar dados)
export function renderRotaAtual() {
  // Rede de segurança global: toda troca de rota do app do tenant zera
  // qualquer trava de scroll pendente (ver scrollLock.js) — mesmo que a tela
  // que travou não tenha passado pelo próprio fechar(). Sem isso, um overlay
  // esquecido travado deixava a rolagem presa até o F5.
  resetScrollLock();
  const item = MENU.find((m) => m.id === state.rota) || MENU[0];

  // Defesa em profundidade: o menu já esconde o que a empresa não contratou
  // (montarMenu, em app.js), mas um estado inconsistente (módulo revogado com
  // a página já aberta, ou `state.rota` mexido por fora) não deve renderizar
  // dado nenhum — a API recusaria de qualquer forma. Redireciona em vez de
  // mostrar uma tela vazia sem explicação.
  if (!acessivel(item)) {
    toast(`Módulo "${item.label}" não disponível para esta empresa.`);
    irPara(primeiraRotaAcessivel());
    return;
  }

  switch (item.tipo) {
    case "pagina":
      if (item.id === "produtos") views.renderProdutos();
      else views.renderDashboard();
      break;
    case "integracoes":
      views.renderIntegracoes();
      break;
    case "integracao":
      views.renderIntegracaoDetalhe(item.integ, item.label);
      break;
    case "configuracoes":
      renderConfiguracoes();
      break;
    case "vendas":
      renderVendas();
      break;
    case "insumos":
      renderInsumos();
      break;
    case "dashboard-executivo":
      renderDashboardExecutivo();
      break;
    case "bonificacao-mensal":
      renderBonificacaoMensal();
      break;
    case "parser-food-delivery":
      renderParserFoodDelivery();
      break;
    case "agente":
      renderAgente();
      break;
    case "martinbrower":
      renderMartinBrower();
      break;
    case "construcao":
      views.renderConstrucao(item.id, item.label);
      break;
    default:
      views.renderDashboard();
  }

  // Painel global do Agente Crescer (se montado/aberto): NUNCA recriado por
  // uma navegação — só atualiza o indicador de contexto/sugestões pra
  // refletir a tela nova (ver agentePainel.js). Chamado sempre, mesmo com o
  // painel fechado: é barato (só recalcula texto) e evita esquecer de
  // sincronizar quando o usuário abrir o painel depois.
  sincronizarContextoPainel();
}
