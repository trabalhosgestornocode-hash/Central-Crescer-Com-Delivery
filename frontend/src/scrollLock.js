// Trava de scroll do body — ponto ÚNICO no frontend que manipula
// `document.body.classList` para impedir a rolagem de fundo (usado hoje pelo
// painel deslizante de cards do Painel Administrativo no mobile, ver
// `ligarCardsResumo` em painelAdmViews.js).
//
// Por que existe este módulo em vez de cada tela mexer direto no body:
//   1. CONTADOR, não booleano — duas travas concorrentes (ex.: dois overlays
//      abertos ao mesmo tempo, um aninhado no outro) não se destravam uma à
//      outra. A trava só some quando TODAS as chamadas correspondentes já
//      destravaram.
//   2. `resetScrollLock()` — rede de segurança para quando o código que abriu
//      a trava é abandonado sem passar pelo fechar() (o usuário navega para
//      outra tela clicando num item de dentro do próprio painel, back/forward,
//      exceção no meio do caminho, etc.). Chamado nos pontos onde uma tela
//      inteira é substituída: `renderViewPadm` (painelAdmViews.js),
//      `sairDoPainelAdministrativo` (painelAdm.js) e `renderRotaAtual`
//      (router.js, rede de segurança global do app inteiro).
//
// Bug que isso corrige: sem o reset na troca de tela, um `travar(true)` que
// nunca chamava `travar(false)` deixava `overflow: hidden` preso no body até
// o F5 (que reinicia todo o estado do módulo) — a rolagem só voltava depois
// de recarregar a página.
let contador = 0;

function aplicar() {
  try { document.body?.classList?.toggle("scroll-travado", contador > 0); } catch { /* fake DOM em teste */ }
}

/** Trava o scroll do body. Cada chamada precisa de uma `destravarScroll()` correspondente. */
export function travarScroll() {
  contador += 1;
  aplicar();
}

/** Destrava uma trava. Chamada extra sem trava correspondente é no-op seguro (nunca fica negativo). */
export function destravarScroll() {
  contador = Math.max(0, contador - 1);
  aplicar();
}

/** Zera todas as travas pendentes, mesmo as abandonadas sem destravar. Ver comentário do módulo. */
export function resetScrollLock() {
  contador = 0;
  aplicar();
}

/** Só para teste: contador atual de travas. */
export function _travasAtivas() {
  return contador;
}
