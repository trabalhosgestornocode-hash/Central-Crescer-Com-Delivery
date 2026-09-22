// Modal de troca de modelo logístico COM data de vigência (Dashboard iFood).
// Nunca há troca retroativa silenciosa: a data é obrigatória e o texto de
// aplicação é sempre exibido antes de confirmar.
import { el, escapeHtml, toast } from "./utils.js";
import { dashExecAtualizarModeloLogistico } from "./api.js";
import { ROTULO_MODELO, textoAplicacaoVigencia, textoDeclaracaoHistorica, modeloOposto } from "./dashboardExecutivoModelo.js";

const hojeLocalIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * `declararInicio`: a unidade JÁ opera em `modeloAtual` (trocou no passado sem data registrada) — em vez
 * de trocar de modelo, informa DESDE QUANDO o modelo atual vale (antes disso era o modelo oposto).
 * @param {{unidadeId: string, modeloAtual: 'marketplace'|'full_service', modeloSugerido?: string, declararInicio?: boolean, onSalvo: () => void, onCancelar?: () => void}} p
 */
export function abrirTrocaModeloModal({ unidadeId, modeloAtual, modeloSugerido, declararInicio = false, onSalvo, onCancelar }) {
  const hoje = hojeLocalIso();
  const novoPadrao = modeloSugerido ?? (modeloAtual === "marketplace" ? "full_service" : "marketplace");
  const ov = document.createElement("div");
  ov.className = "modal-overlay";
  ov.innerHTML = `<div class="modal dex-modal">
    <h3>${declararInicio ? "Informar quando o modelo atual começou" : "Alterar modelo logístico"}</h3>
    <p class="muted">Modelo atual: <b>${escapeHtml(ROTULO_MODELO[modeloAtual] ?? modeloAtual)}</b></p>
    <div class="cfg-campo"><label for="dex-troca-modelo"><span>${declararInicio ? "Modelo (o atual)" : "Novo modelo"}</span></label>
      <select id="dex-troca-modelo" ${declararInicio ? "disabled" : ""}>
        ${Object.entries(ROTULO_MODELO).map(([v, r]) => `<option value="${v}" ${v === (declararInicio ? modeloAtual : novoPadrao) ? "selected" : ""}>${r}</option>`).join("")}
      </select></div>
    <div class="cfg-campo"><label for="dex-troca-data"><span>${declararInicio ? "Vale desde" : "Válido a partir de"}</span></label>
      <input id="dex-troca-data" type="date" max="${hoje}" value="${hoje}" required></div>
    <div class="cfg-campo"><label for="dex-troca-motivo"><span>Motivo (opcional)</span></label>
      <input id="dex-troca-motivo" type="text" maxlength="500"></div>
    <p class="dex-troca-aviso" id="dex-troca-aviso" role="status"></p>
    <div class="modal-acoes">
      <button class="btn btn-ghost" type="button" id="dex-troca-cancelar">Cancelar</button>
      <button class="btn btn-primary" type="button" id="dex-troca-confirmar">Confirmar alteração</button>
    </div>
  </div>`;
  document.body.appendChild(ov);

  const fechar = (cancelou) => { ov.remove(); document.removeEventListener("keydown", onEsc); if (cancelou) onCancelar?.(); };
  const onEsc = (e) => { if (e.key === "Escape") fechar(true); };
  document.addEventListener("keydown", onEsc);
  ov.addEventListener("click", (e) => { if (e.target === ov) fechar(true); });

  const atualizarAviso = () => {
    const data = el("#dex-troca-data").value;
    el("#dex-troca-aviso").textContent = declararInicio ? textoDeclaracaoHistorica(modeloAtual, data) : textoAplicacaoVigencia(data, hoje);
  };
  el("#dex-troca-data").addEventListener("input", atualizarAviso);
  atualizarAviso();
  el("#dex-troca-cancelar").addEventListener("click", () => fechar(true));

  el("#dex-troca-confirmar").addEventListener("click", async () => {
    const modeloLogistico = el("#dex-troca-modelo").value;
    const vigenciaInicio = el("#dex-troca-data").value;
    if (!vigenciaInicio) { toast("Informe a data de vigência."); return; }
    const botao = el("#dex-troca-confirmar");
    botao.disabled = true;
    try {
      const r = await dashExecAtualizarModeloLogistico(unidadeId, {
        modeloLogistico, vigenciaInicio, motivo: el("#dex-troca-motivo").value.trim() || undefined,
        // Declaração histórica: o modelo de hoje não muda; explicita qual era o anterior.
        ...(declararInicio ? { modeloAnterior: modeloOposto(modeloAtual) } : {}),
      });
      toast(r?.data?.mudou === false
        ? `A unidade já opera em ${ROTULO_MODELO[modeloLogistico] ?? modeloLogistico}; nada foi alterado.`
        : r?.data?.declaracaoHistorica
          ? `Registrado: ${ROTULO_MODELO[modeloLogistico] ?? modeloLogistico} desde ${vigenciaInicio.split("-").reverse().join("/")}.`
          : `Modelo alterado para ${ROTULO_MODELO[modeloLogistico] ?? modeloLogistico} a partir de ${vigenciaInicio.split("-").reverse().join("/")}.`);
      fechar(false);
      await onSalvo?.();
    } catch (e) {
      botao.disabled = false;
      toast("Erro: " + e.message);
    }
  });
}
