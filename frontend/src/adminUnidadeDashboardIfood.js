// Aba "Dashboard iFood" da página de detalhe da unidade (Painel SuperAdmin).
// Produto simplificado (Checkpoint F): UMA opção por unidade —
// "Considerar Sanduíches + Saladas no Dashboard iFood".
//
// O SuperAdmin não escolhe nomes, quantidade, ordem nem escopo: ao ligar, o
// backend (plataforma.dashboardIfood.service.js) garante exatamente Sanduíches
// e Saladas, com a taxa de entregadores sempre da unidade. Desligar volta o
// formulário padrão para os próximos lançamentos; o histórico fica intacto.
import { el, escapeHtml, toast } from "./utils.js";
import { adminApi } from "./adminApi.js";

let dados = null;

/** Corpo da aba (chamado por adminUnidadeDetalhe.js#CORPOS). */
export async function corpoDashboardIfood(unidadeId) {
  dados = await adminApi.dashboardIfoodDaUnidade(unidadeId);
  return `<div id="ud-dif">${htmlFormulario()}</div>`;
}

/** Corpo do PUT — só a opção e a versão lida (concorrência otimista). */
export function corpoParaSalvar(sanduichesSaladas, versao) {
  return { sanduichesSaladas: !!sanduichesSaladas, versao };
}

function htmlStatusModulo() {
  const m = dados.modulo;
  const motivo = m.ativo ? ""
    : !m.disponivelNaEmpresa ? "A empresa não tem o módulo Dashboard iFood."
      : "O módulo não está habilitado para esta unidade.";
  return `
    <fieldset class="adm-modulos-grupo">
      <legend>Status do módulo</legend>
      <div class="ud-dif-linha">
        <span>Dashboard iFood ${m.ativo ? '<span class="pill ok">Ativo</span>' : '<span class="pill muted">Inativo</span>'}</span>
        <button class="btn btn-ghost btn-sm" id="ud-dif-acessos" type="button">Gerenciar na aba Acessos</button>
      </div>
      ${motivo ? `<p class="adm-nota ud-dif-nota">${escapeHtml(motivo)} A opção abaixo pode ser preparada mesmo assim — só passa a valer quando o módulo estiver ativo.</p>` : ""}
    </fieldset>`;
}

function htmlFormulario() {
  if (dados.migracaoPendente) {
    return `${htmlStatusModulo()}
      <div class="adm-aviso adm-aviso--info">A opção Sanduíches + Saladas ainda não está disponível neste ambiente.
      Esta unidade segue no lançamento padrão.</div>`;
  }
  const ligado = dados.sanduichesSaladas;
  return `
    ${htmlStatusModulo()}
    <fieldset class="adm-modulos-grupo">
      <legend>Lançamento diário</legend>
      <label class="adm-assoc adm-assoc--check ud-dif-opcao">
        <input type="checkbox" id="ud-dif-sanduiches-saladas" ${ligado ? "checked" : ""} />
        <span><b>Considerar Sanduíches + Saladas no Dashboard iFood</b>
          <small>Quando ativado, o lançamento diário passa a considerar separadamente Sanduíches e Saladas e consolida os dois no resultado da unidade. A taxa de entregadores continua sendo informada uma única vez.</small></span>
      </label>
      <p class="adm-nota ud-dif-nota">Vale para os próximos lançamentos desta unidade. Dias já lançados continuam exatamente como foram registrados — desativar não apaga nada.</p>
    </fieldset>
    <div class="adm-secao-acoes adm-secao-acoes--fim">
      <button class="btn btn-primary btn-sm" id="ud-dif-salvar" type="button">Salvar configuração</button>
    </div>`;
}

/**
 * @param {{unidadeId: string, irParaAcessos: () => void, salvar: (fn: () => Promise<unknown>, msg: string) => Promise<void>}} ctx
 */
export function ligarDashboardIfood(ctx) {
  if (!el("#ud-dif") || !dados) return;
  el("#ud-dif-acessos")?.addEventListener("click", ctx.irParaAcessos);
  if (dados.migracaoPendente) return;
  el("#ud-dif-salvar")?.addEventListener("click", () => {
    const marcado = !!el("#ud-dif-sanduiches-saladas")?.checked;
    if (marcado === dados.sanduichesSaladas) { toast("Nenhuma alteração para salvar."); return; }
    return ctx.salvar(
      () => adminApi.salvarDashboardIfoodDaUnidade(ctx.unidadeId, corpoParaSalvar(marcado, dados.versao)),
      marcado ? "Sanduíches + Saladas ativado para esta unidade." : "Sanduíches + Saladas desativado — próximos lançamentos no modo padrão.",
    );
  });
}
