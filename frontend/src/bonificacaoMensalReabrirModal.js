// Modal "Reabrir fechamento" — volta uma competência FECHADA ao cálculo ao
// vivo. Só monta o payload { ano, mes, motivo }; a regra vive no backend
// (bonificacaoMensal.service.js#reabrirCompetencia + RPC
// bonificacao_reabrir_competencia): motivo obrigatório (>= 3), nada é apagado
// (o snapshot da versão vigente continua no histórico), a fórmula da
// Bonificação não muda. Rota: POST /bonificacao-mensal/fechamento-mensal/reabrir.
import { escapeHtml, toast } from "./utils.js";
import { bonifFechamentoMensalReabrir } from "./api.js";

let ov = null;
function fecharOverlay() { ov?.remove(); ov = null; document.removeEventListener("keydown", onEsc); }
function onEsc(e) { if (e.key === "Escape") fecharOverlay(); }
function overlay(html) {
  fecharOverlay();
  ov = document.createElement("div"); ov.className = "modal-overlay";
  ov.innerHTML = `<div class="modal bm-modal">${html}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) fecharOverlay(); });
  document.body.appendChild(ov); document.addEventListener("keydown", onEsc);
  return ov.querySelector(".modal");
}

/** Motivo é obrigatório — mesma regra do backend (>= 3 caracteres, sem espaços nas pontas). */
export function podeConfirmarReabertura(motivo) {
  return String(motivo ?? "").trim().length >= 3;
}

export function reabrirModalHtml(competenciaLabel) {
  return `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>♻️ Reabrir fechamento — ${escapeHtml(competenciaLabel || "")}</h2></div>
    <div class="bm-imp-form">
      <p class="dex-diag-vazio">A competência volta a ser calculada <b>ao vivo</b> e fica aberta para um novo lançamento. O snapshot atual <b>não é apagado</b> — continua no histórico. Um novo fechamento gera uma nova versão.</p>
      <label class="cfg-campo"><span>Motivo da reabertura *</span>
        <textarea id="bm-reabrir-motivo" rows="3" maxlength="500" placeholder="Ex.: PDF de Vendas estava com o período errado; refazer o fechamento."></textarea>
      </label>
      <div class="vd-imp-msg" id="bm-reabrir-msg" hidden></div>
    </div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="bm-reabrir-cancelar">Cancelar</button>
      <button class="btn btn-primary" id="bm-reabrir-confirmar" disabled>Reabrir fechamento</button>
    </div>`;
}

/**
 * @param {{ ano:number, mes:number, competenciaLabel:string, onReaberto:Function,
 *   _reabrir?:Function }} p  `_reabrir` é ponto de injeção só para teste.
 */
export function abrirReabrirFechamentoModal({ ano, mes, competenciaLabel, onReaberto, _reabrir = bonifFechamentoMensalReabrir }) {
  const m = overlay(reabrirModalHtml(competenciaLabel));
  const motivoEl = m.querySelector("#bm-reabrir-motivo");
  const confirmar = m.querySelector("#bm-reabrir-confirmar");
  const msg = m.querySelector("#bm-reabrir-msg");
  const setMsg = (t) => { msg.hidden = false; msg.className = "vd-imp-msg erro"; msg.textContent = t; };

  const atualizar = () => { confirmar.disabled = !podeConfirmarReabertura(motivoEl.value); };
  motivoEl.addEventListener("input", atualizar);
  atualizar();

  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#bm-reabrir-cancelar").addEventListener("click", fecharOverlay);

  let emAndamento = false;
  confirmar.addEventListener("click", async () => {
    if (emAndamento || !podeConfirmarReabertura(motivoEl.value)) return;
    emAndamento = true;
    confirmar.disabled = true;
    const txt = confirmar.textContent;
    confirmar.textContent = "Reabrindo…";
    msg.hidden = true;
    try {
      const { data } = await _reabrir({ ano, mes, motivo: motivoEl.value.trim() });
      toast("Fechamento reaberto — competência aberta para novo lançamento ✅");
      fecharOverlay();
      onReaberto?.(data);
    } catch (e) {
      setMsg("Erro: " + e.message);
      emAndamento = false;
      confirmar.disabled = false;
      confirmar.textContent = txt;
    }
  });

  return m;
}
