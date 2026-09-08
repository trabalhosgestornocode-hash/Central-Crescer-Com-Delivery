// Tooltip de informação (ícone "i" — `.vd-tip[data-tip]`) usado em cards de
// várias telas (Dashboard iFood, Vendas, simulador de preço...).
//
// Antes disto o balão era um `::after` posicionado em relação ao próprio
// ícone (CSS puro). Isso quebrava sempre que um ancestral tinha
// `overflow: hidden` (é o caso de `.card` — usado nos cards da Visão Geral,
// que recorta o balão) ou um stacking context que colocava outro elemento
// por cima. Aumentar z-index não resolve isso — o corte é do `overflow`, não
// de sobreposição.
//
// A correção estrutural: o balão vira UM elemento só, anexado direto no
// `<body>` (portal) e reposicionado via `getBoundingClientRect` toda vez que
// aparece. Fora do container do card, `overflow: hidden` dele não afeta mais
// o balão. Funciona igual em qualquer tela — um mecanismo só, sem duplicar
// CSS/JS por página.
let tipEl = null;
let alvoAtual = null;
let intervaloChecagem = null;

function garantirTip() {
  if (tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.className = "vd-tip-flutuante";
  tipEl.setAttribute("role", "tooltip");
  tipEl.hidden = true;
  document.body.appendChild(tipEl);
  return tipEl;
}

/** Posiciona o balão perto do ícone, sem deixar vazar pelas bordas da tela —
 * mesma ideia do `::after` original (colado acima, alinhado à direita do
 * ícone), mas com reposicionamento automático quando não há espaço. */
function posicionar(alvo) {
  const tip = garantirTip();
  const margem = 8;
  const r = alvo.getBoundingClientRect();
  const tipR = tip.getBoundingClientRect();

  let top = r.top - tipR.height - margem;
  let seta = "baixo"; // balão acima do ícone → seta aponta pra baixo
  if (top < margem) {
    top = r.bottom + margem; // sem espaço acima: mostra abaixo
    seta = "cima";
  }
  top = Math.min(top, window.innerHeight - tipR.height - margem);

  let left = r.right - tipR.width;
  left = Math.max(margem, Math.min(left, window.innerWidth - tipR.width - margem));

  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.dataset.seta = seta;
  // Posição horizontal da setinha: sempre aponta pro ícone, mesmo quando o
  // balão desliza pra não vazar da tela.
  const setaX = Math.max(10, Math.min(r.left + r.width / 2 - left, tipR.width - 10));
  tip.style.setProperty("--vd-tip-seta-x", `${setaX}px`);
}

function pararChecagem() {
  if (intervaloChecagem) { clearInterval(intervaloChecagem); intervaloChecagem = null; }
}

/** O DOM por trás do ícone pode ser substituído (re-render de tela) sem o
 * mouse sair dele — não dispara `mouseout`. Confere periodicamente se o
 * ícone com foco/hover ainda existe; some sem depender de nenhum evento. */
function iniciarChecagem() {
  pararChecagem();
  intervaloChecagem = setInterval(() => {
    if (alvoAtual && !document.body.contains(alvoAtual)) esconder(alvoAtual);
  }, 250);
}

// Alvo válido: qualquer `.vd-tip` com conteúdo (texto simples OU HTML estruturado).
const alvoDe = (target) => target?.closest?.(".vd-tip[data-tip], .vd-tip[data-tip-html]") ?? null;

function mostrar(alvo) {
  const html = alvo.getAttribute("data-tip-html");
  const texto = alvo.getAttribute("data-tip");
  if (!html && !texto) return;
  const tip = garantirTip();
  alvoAtual = alvo;
  if (html) { tip.innerHTML = html; tip.classList.add("vd-tip-flutuante--rico"); }
  else { tip.textContent = texto; tip.classList.remove("vd-tip-flutuante--rico"); }
  tip.hidden = false;
  posicionar(alvo);
  iniciarChecagem();
}

function esconder(alvo) {
  if (alvo && alvoAtual && alvo !== alvoAtual) return; // hover/foco já passou pra outro ícone
  if (tipEl) tipEl.hidden = true;
  alvoAtual = null;
  pararChecagem();
}

/** Chame uma vez no boot da aplicação. Delegação em `document` — funciona
 * para qualquer `.vd-tip` que existir agora ou vier a existir depois de um
 * re-render, sem precisar religar nada por tela. */
export function initTooltips() {
  document.addEventListener("mouseover", (e) => {
    const alvo = alvoDe(e.target);
    if (alvo) mostrar(alvo);
  });
  document.addEventListener("mouseout", (e) => {
    const alvo = alvoDe(e.target);
    if (alvo && !alvo.contains(e.relatedTarget)) esconder(alvo);
  });
  // Teclado: foco (Tab) mostra, perda de foco esconde — mesmo comportamento
  // de hover, acessível sem mouse.
  document.addEventListener("focusin", (e) => {
    const alvo = alvoDe(e.target);
    if (alvo) mostrar(alvo);
  });
  document.addEventListener("focusout", (e) => {
    const alvo = alvoDe(e.target);
    if (alvo) esconder(alvo);
  });
  // Toque/clique: tocar no ícone abre; tocar em qualquer outro lugar fecha.
  // O balão tem pointer-events:none, então um clique nunca cai nele.
  document.addEventListener("click", (e) => {
    const alvo = alvoDe(e.target);
    if (alvo) mostrar(alvo);
    else if (alvoAtual) esconder(alvoAtual);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && alvoAtual) { esconder(alvoAtual); return; }
    // role="button": Enter/Espaço no ícone com foco abre/fecha.
    const alvo = alvoDe(e.target);
    if (alvo && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      alvo === alvoAtual ? esconder(alvo) : mostrar(alvo);
    }
  });
  // Scroll ou resize invalidam a posição calculada — some em vez de mostrar
  // o balão flutuando longe do ícone (mesmo padrão de tooltips nativos).
  window.addEventListener("scroll", () => { if (alvoAtual) esconder(alvoAtual); }, true);
  window.addEventListener("resize", () => { if (alvoAtual) esconder(alvoAtual); });
}
