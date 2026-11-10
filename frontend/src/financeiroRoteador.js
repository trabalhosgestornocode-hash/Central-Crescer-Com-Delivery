// Roteador das páginas do Dashboard Financeiro.
//
// Antes de pintar QUALQUER página, consulta GET /gestao-financeira/status: é a prova atual (relida no banco) de que a
// concessão continua vigente. Se o backend negar (revogação, expiração, módulo desligado), o setor financeiro é
// abandonado na hora — a UI nunca decide sozinha. As páginas reais são do Agente 2 (financeiro/<pagina>.js).
import { state } from "./state.js";
import { el, escapeHtml } from "./utils.js";
import { http } from "./sessao.js";
import { MENU_FINANCEIRO } from "./financeiroMenu.js";
import { ESTADO_FINANCEIRO, CARREGAMENTO_NEUTRO, consumirStatusPreResolvido, ehRecusaDeAcesso } from "./financeiroAcesso.js";
import { chaveDoContexto } from "./setores.js";

/**
 * @param {string} rotaId
 * @param {{ aoPerderAcesso: () => void }} opcoes chamado quando o backend nega o acesso financeiro
 */
export async function renderPaginaFinanceira(rotaId, { aoPerderAcesso }) {
  const item = MENU_FINANCEIRO.find((m) => m.id === rotaId) ?? MENU_FINANCEIRO[0];
  const alvo = el("#view");
  // Interface ainda não resolvida (loading/erro/recusa): nenhuma página financeira é montada — quem decide é o shell.
  if (state.financeiroEstado !== ESTADO_FINANCEIRO.FINANCEIRO_2 && state.financeiroEstado !== ESTADO_FINANCEIRO.LEGADO) return;
  const rotaNoInicio = state.rota;

  // 1ª página depois da entrada no setor: reaproveita o status que o shell ACABOU de consultar (uma vez, mesmo
  // contexto, recente). Nas demais navegações o acesso é reconferido no servidor a cada página, como sempre.
  let status = consumirStatusPreResolvido(chaveDoContexto(state.sessao));
  if (!status) {
    alvo.innerHTML = CARREGAMENTO_NEUTRO;
    try {
      status = (await http.get("/api/v1/gestao-financeira/status")).data;
    } catch (e) {
      if (state.rota !== rotaNoInicio) return;
      if (ehRecusaDeAcesso(e)) return aoPerderAcesso();
      alvo.innerHTML = estado("Não foi possível confirmar seu acesso financeiro agora.", "Tente novamente em instantes.");
      return;
    }
  }
  if (state.rota !== rotaNoInicio) return; // o usuário navegou enquanto a consulta rodava
  if (item.fin2 && status?.financeiro2 !== true) { // feature flag: o servidor decide; a UI nunca abre a página por conta própria
    alvo.innerHTML = estado(`${escapeHtml(item.label)} — indisponível`, "Esta área ainda não está liberada para a sua empresa.");
    return;
  }

  let modulo = null;
  if (!alvo.querySelector(".fin-carregando")) alvo.innerHTML = CARREGAMENTO_NEUTRO;
  try {
    // O nome do arquivo vem do menu fixo acima, nunca de entrada do usuário.
    modulo = await import(`./financeiro/${item.pagina}.js`);
  } catch { /* página ainda não entregue */ }
  if (state.rota !== rotaNoInicio) return;

  if (typeof modulo?.render === "function") {
    alvo.innerHTML = "";
    await modulo.render(alvo, { rota: item, nivel: status.nivel, permissoes: status.permissoes ?? [], sessao: state.sessao });
    if (status?.financeiro2 === true && state.rota === rotaNoInicio) {   // barra global (+ Novo lançamento · Conferências) só no Financeiro 2.0
      try { (await import("./financeiro/acoesGlobais.js")).montarAcoesGlobais(alvo, { permissoes: status.permissoes ?? [], rotaId: item.id }); } catch { /* a página segue funcionando sem a barra */ }
    }
    return;
  }
  alvo.innerHTML = estado(`${escapeHtml(item.label)} — em construção`, "Esta área do Dashboard Financeiro ainda não está disponível.");
}

function estado(titulo, texto) {
  return `<div class="fin-estado fin-estado--vazio"><h3>${titulo}</h3><p>${escapeHtml(texto)}</p></div>`;
}
