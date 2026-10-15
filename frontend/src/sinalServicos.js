// Seletor de sinal (+)/(−) de "Serviços e promoções" no Dashboard iFood.
//
// CONVENÇÃO (migration 119): o valor gravado/enviado continua significando
// CUSTO — positivo = dedução (como sempre foi), negativo = crédito a favor
// da loja. Na tela o usuário digita só o valor ABSOLUTO e escolhe o sinal
// como no extrato do iFood:
//
//   (−) vermelho  custo / desconto      -> grava  +valor
//   (+) verde     crédito a favor loja  -> grava  −valor
//
// Este módulo é o ÚNICO ponto que converte tela <-> valor gravado. O estado
// dos formulários guarda sempre o valor GRAVADO (com sinal); prévias,
// conferência e payload usam esse número direto, sem reaplicar sinal. Como
// `paraArmazenado` sempre parte do absoluto, chamá-la de novo sobre um valor
// já convertido nunca inverte o sinal duas vezes.
import { escapeHtml, fmtMoeda } from "./utils.js";
import { formatarMoedaBRL, numeroDecimal } from "./numeroDecimal.js";

export const SINAL_CUSTO = "-";
export const SINAL_CREDITO = "+";

const vazio = (v) => v === "" || v == null;

/** Sinal exibido para um valor gravado: negativo = crédito (+); resto (inclui vazio e 0) = custo (−). */
export function sinalDoArmazenado(valor) {
  if (vazio(valor)) return SINAL_CUSTO;
  const n = numeroDecimal(valor);
  return Number.isFinite(n) && n < 0 ? SINAL_CREDITO : SINAL_CUSTO;
}

/** Valor absoluto para o input; vazio continua vazio. */
export function absDoArmazenado(valor) {
  if (vazio(valor)) return "";
  const n = numeroDecimal(valor);
  return Number.isFinite(n) ? Math.abs(n) : "";
}

/**
 * Texto digitado (absoluto, já mascarado ou número) + sinal escolhido ->
 * valor gravado. Vazio -> "" (não informado, nunca 0); inválido -> NaN (a
 * validação do formulário barra); zero nunca vira "-0".
 */
export function paraArmazenado(valorDigitado, sinal) {
  if (vazio(valorDigitado)) return "";
  const n = numeroDecimal(valorDigitado);
  if (!Number.isFinite(n)) return Number.NaN;
  const abs = Math.abs(n);
  if (abs === 0) return 0;
  return sinal === SINAL_CREDITO ? -abs : abs;
}

/** Valor gravado para leitura: crédito vira "+R$ 50,00 (crédito)"; custo segue o formato de sempre. */
export function fmtServicosPromocoes(valor) {
  const n = vazio(valor) ? Number.NaN : numeroDecimal(valor);
  if (Number.isFinite(n) && n < 0) return `+${fmtMoeda(Math.abs(n))} (crédito)`;
  return fmtMoeda(valor);
}

/**
 * Input de moeda + botões (+)/(−). `atributosInput` entra cru no <input>
 * (id, data-campo...) — só valores controlados pelo código, nunca do usuário.
 */
export function campoServicosHtml({ rotulo, valorArmazenado, sinal = sinalDoArmazenado(valorArmazenado), atributosInput = "", ajuda = "" }) {
  const s = sinal === SINAL_CREDITO ? SINAL_CREDITO : SINAL_CUSTO;
  const botao = (valor, simbolo, titulo) => `<button type="button" class="dex-sinal-btn" data-sinal-btn="${valor}" aria-pressed="${s === valor}" aria-label="${titulo}" title="${titulo}">${simbolo}</button>`;
  return `
    <div class="cfg-campo dex-sinal-campo" data-sinal="${s}">
      <span>${rotulo}</span>
      <div class="dex-sinal-linha">
        <div class="dex-sinal-valor">
          <span class="dex-sinal-prefixo" aria-hidden="true">${s === SINAL_CREDITO ? "+" : "−"}</span>
          <input type="text" inputmode="decimal" data-moeda ${atributosInput} value="${escapeHtml(formatarMoedaBRL(absDoArmazenado(valorArmazenado)))}" placeholder="R$ 0,00" aria-label="${escapeHtml(rotulo.replace(/<[^>]*>/g, ""))}">
        </div>
        <div class="dex-sinal" role="group" aria-label="Sinal do valor">
          ${botao(SINAL_CREDITO, "+", "Positivo: crédito a favor da loja")}
          ${botao(SINAL_CUSTO, "−", "Negativo: custo / desconto")}
        </div>
      </div>
      <small class="cfg-campo-ajuda">${ajuda || "Digite só o valor. <b>−</b> custo/desconto · <b>+</b> crédito a favor da loja."}</small>
    </div>`;
}

/**
 * Liga os botões de um `campoServicosHtml`. A troca de sinal atualiza a
 * aparência na hora e devolve (via `aoAlterarSinal`) o sinal novo — quem
 * chama recalcula o valor gravado com `paraArmazenado(input.value, sinal)`.
 */
export function ligarSeletorSinal(campo, { aoAlterarSinal } = {}) {
  if (!campo) return;
  const prefixo = campo.querySelector(".dex-sinal-prefixo");
  campo.querySelectorAll("[data-sinal-btn]").forEach((btn) => btn.addEventListener("click", () => {
    const sinal = btn.dataset.sinalBtn;
    if (campo.getAttribute("data-sinal") === sinal) return;
    campo.setAttribute("data-sinal", sinal);
    campo.querySelectorAll("[data-sinal-btn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sinalBtn === sinal)));
    if (prefixo) prefixo.textContent = sinal === SINAL_CREDITO ? "+" : "−";
    aoAlterarSinal?.(sinal);
  }));
}
