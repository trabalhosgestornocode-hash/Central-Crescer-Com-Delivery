// Roteador das páginas do Dashboard Financeiro.
//
// Antes de pintar QUALQUER página, consulta GET /gestao-financeira/status: é a prova atual (relida no banco) de que a
// concessão continua vigente. Se o backend negar (revogação, expiração, módulo desligado), o setor financeiro é
// abandonado na hora — a UI nunca decide sozinha. As páginas reais são do Agente 2 (financeiro/<pagina>.js).
import { state } from "./state.js";
import { el, escapeHtml } from "./utils.js";
import { http } from "./sessao.js";
import { MENU_FINANCEIRO } from "./financeiroMenu.js";

/**
 * @param {string} rotaId
 * @param {{ aoPerderAcesso: () => void }} opcoes chamado quando o backend nega o acesso financeiro
 */
export async function renderPaginaFinanceira(rotaId, { aoPerderAcesso }) {
  const item = MENU_FINANCEIRO.find((m) => m.id === rotaId) ?? MENU_FINANCEIRO[0];
  const alvo = el("#view");
  alvo.innerHTML = `<div class="fin-estado" role="status">Carregando…</div>`;
  const rotaNoInicio = state.rota;

  let status;
  try {
    status = (await http.get("/api/v1/gestao-financeira/status")).data;
  } catch (e) {
    if (state.rota !== rotaNoInicio) return;
    if (e?.status === 403 || e?.status === 409 || /^FINANCEIRO_/.test(e?.details?.codigo ?? e?.codigo ?? "")) return aoPerderAcesso();
    alvo.innerHTML = estado("Não foi possível confirmar seu acesso financeiro agora.", "Tente novamente em instantes.");
    return;
  }
  if (state.rota !== rotaNoInicio) return; // o usuário navegou enquanto a consulta rodava

  let modulo = null;
  try {
    // O nome do arquivo vem do menu fixo acima, nunca de entrada do usuário.
    modulo = await import(`./financeiro/${item.pagina}.js`);
  } catch { /* página ainda não entregue */ }
  if (state.rota !== rotaNoInicio) return;

  if (typeof modulo?.render === "function") {
    alvo.innerHTML = "";
    await modulo.render(alvo, { rota: item, nivel: status.nivel, permissoes: status.permissoes ?? [], sessao: state.sessao });
    return;
  }
  alvo.innerHTML = estado(`${escapeHtml(item.label)} — em construção`, "Esta área do Dashboard Financeiro ainda não está disponível.");
}

function estado(titulo, texto) {
  return `<div class="fin-estado fin-estado--vazio"><h3>${titulo}</h3><p>${escapeHtml(texto)}</p></div>`;
}
