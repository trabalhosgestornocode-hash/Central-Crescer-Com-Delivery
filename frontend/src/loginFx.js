// Efeitos visuais da tela de login: spotlight que acompanha o cursor, o
// paralaxe mínimo do ecossistema/partículas, e as microinterações de
// erro/loading nos campos. Tudo aqui é puramente decorativo — nunca decide
// nada do fluxo de autenticação, que continua inteiramente em
// sessao.js/app.js. O ciclo do ecossistema (núcleo → pulso → nós → curva →
// Resultados) e a trilha em si são CSS puro (ver styles.css); não há SMIL
// nem timers de JS orquestrando nada disso.

const prefereMenosMovimento = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const temPonteiroFino = () =>
  window.matchMedia("(pointer: fine)").matches;

// Glow que acompanha o cursor nos dois painéis do login (vitrine + form) e
// um paralaxe mínimo (2-4px) no ecossistema/partículas da vitrine. Amplitude
// mínima, só desktop com mouse — em touch/reduced-motion nem liga o
// listener, e o CSS já cai num valor padrão discreto sem JS nenhum.
function iniciarSpotlightCursor() {
  if (prefereMenosMovimento() || !temPonteiroFino()) return;
  const split = document.querySelector("#login-screen .lg-split");
  const vitrine = document.querySelector(".lg-vitrine");
  const formCol = document.querySelector(".lg-form-col");
  const spotVitrine = document.querySelector(".lg-spotlight-vitrine");
  const spotForm = document.querySelector(".lg-spotlight-form");
  if (!split || !vitrine || !formCol) return;

  let pendente = false;
  let ultimoEvento = null;

  const aplicar = () => {
    pendente = false;
    const loginScreen = document.getElementById("login-screen");
    if (!ultimoEvento || !loginScreen || loginScreen.hidden) return;
    const { clientX: x, clientY: y } = ultimoEvento;
    const alvos = [[vitrine, spotVitrine], [formCol, spotForm]];
    for (const [painel, camada] of alvos) {
      const r = painel.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      if (camada) {
        camada.style.setProperty("--mx", `${((x - r.left) / r.width) * 100}%`);
        camada.style.setProperty("--my", `${((y - r.top) / r.height) * 100}%`);
      }
      if (painel === vitrine) {
        // -1..1 a partir do centro do painel — .lg-ecossistema e
        // .lg-particulas leem essas variáveis (herdadas) com seus próprios
        // multiplicadores em px, dando profundidade sem perseguir o mouse.
        vitrine.style.setProperty("--px", `${((((x - r.left) / r.width) - 0.5) * 2).toFixed(3)}`);
        vitrine.style.setProperty("--py", `${((((y - r.top) / r.height) - 0.5) * 2).toFixed(3)}`);
      }
    }
  };

  split.addEventListener("mousemove", (e) => {
    ultimoEvento = e;
    if (!pendente) { pendente = true; requestAnimationFrame(aplicar); }
  }, { passive: true });
}

// Sacode sutilmente os campos quando o login falha — reforço visual do erro,
// a mensagem em si continua vindo de #login-erro (sessao.js/app.js).
export function marcarCamposInvalidos() {
  document.querySelectorAll("#login-form .lg-campo").forEach((campo) => {
    campo.classList.remove("lg-campo--invalido");
    void campo.offsetWidth; // reinicia a animação em erros consecutivos
    campo.classList.add("lg-campo--invalido");
  });
}

export function limparCamposInvalidos() {
  document.querySelectorAll("#login-form .lg-campo--invalido")
    .forEach((campo) => campo.classList.remove("lg-campo--invalido"));
}

export function bloquearCamposLogin(bloquear) {
  ["#login-user", "#login-pass"].forEach((sel) => {
    const campo = document.querySelector(sel);
    if (campo) campo.disabled = bloquear;
  });
}

// Chamada toda vez que a tela de login é exibida (mostrarLogin, em app.js).
// Idempotente: os listeners só são registrados na 1ª chamada — nas
// seguintes (logout -> login de novo) não duplica nada.
let jaIniciado = false;
export function iniciarEfeitosLogin() {
  if (jaIniciado) return;
  jaIniciado = true;
  iniciarSpotlightCursor();
  document.querySelectorAll("#login-user, #login-pass").forEach((campo) => {
    campo.addEventListener("input", limparCamposInvalidos);
  });
}
