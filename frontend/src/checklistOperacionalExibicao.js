// Checklist Operacional — MODOS DE EXIBIÇÃO (Televisão e Tablet) e tela cheia.
//
// Os dois modos são APRESENTAÇÕES do mesmo dashboard: mesmo resumo, mesmo sincronizador, mesmo aviso do
// Realtime, mesmo HTML de conteúdo. O modo só escolhe a classe da raiz (o CSS reorganiza os cards) e se as
// listas longas são paginadas na altura da tela (TV, páginas alternando a cada 10 s) ou crescem com rolagem
// vertical (Tablet). Todos os itens ficam no DOM nos dois modos: a paginação só escolhe quais aparecem.
//
// Tela cheia é pedida no clique (gesto do usuário), mas é só apresentação: se o navegador recusar ou não
// tiver a API (ex.: iPhone), o modo continua imersivo dentro da página e a tela oferece tentar de novo.
// Nunca finge que entrou em tela cheia: o estado vem sempre do próprio navegador (`fullscreenElement`).
// Também não é barreira de segurança: a sessão continua sendo a da pessoa logada.
//
// Funções sem estado próprio; `doc` é injetável para teste.

export const MODOS_EXIBICAO = Object.freeze({
  tv: Object.freeze({
    id: "tv",
    rotulo: "Modo Televisão",
    acao: "Iniciar Modo Televisão",
    descricao: "Para televisões e monitores na parede da loja. Números grandes, legíveis à distância, sem precisar tocar na tela.",
    destaques: ["Telas horizontais, de 1280 × 720 ao 4K", "Cards em grade, alertas visíveis de longe", "Atualiza sozinho, sem recarregar"],
    // Na parede ninguém rola a tela: lista longa vira páginas que alternam sozinhas (todas, em sequência).
    paginarListas: true,
  }),
  tablet: Object.freeze({
    id: "tablet",
    rotulo: "Modo Tablet",
    acao: "Iniciar Modo Tablet",
    descricao: "Para tablets no balcão ou na cozinha. Os mesmos indicadores da televisão, organizados para leitura de perto e toque.",
    destaques: ["Na horizontal e na vertical", "Botões no tamanho do toque", "Atualiza sozinho, sem recarregar"],
    // Perto da pessoa: lista completa, a tela rola na vertical.
    paginarListas: false,
  }),
});

export const modoValido = (modo) => Object.hasOwn(MODOS_EXIBICAO, modo ?? "");

/** O elemento está em tela cheia AGORA (segundo o navegador)? */
export function telaCheiaAtiva(elemento, doc = globalThis.document) {
  if (!elemento || !doc) return false;
  return (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) === elemento;
}

/** O navegador oferece a API de tela cheia para este elemento? */
export function telaCheiaSuportada(elemento, doc = globalThis.document) {
  if (!elemento || !doc) return false;
  const habilitada = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? true;
  return habilitada !== false && typeof (elemento.requestFullscreen ?? elemento.webkitRequestFullscreen) === "function";
}

/**
 * Pede tela cheia para o elemento. Chamar DENTRO do clique (o navegador exige gesto do usuário).
 * Nunca lança: devolve `{ ok: true }` ou `{ ok: false, motivo }` e quem chama mantém o modo imersivo.
 * @returns {Promise<{ok: boolean, motivo?: "sem_suporte"|"recusado"}>}
 */
export async function pedirTelaCheia(elemento, doc = globalThis.document) {
  if (!telaCheiaSuportada(elemento, doc)) return { ok: false, motivo: "sem_suporte" };
  if (telaCheiaAtiva(elemento, doc)) return { ok: true };
  try {
    if (typeof elemento.requestFullscreen === "function") await elemento.requestFullscreen({ navigationUI: "hide" });
    else await elemento.webkitRequestFullscreen();
  } catch {
    return { ok: false, motivo: "recusado" };
  }
  // Alguns navegadores resolvem a promessa sem entrar (ou nem devolvem promessa): confere o estado real.
  return telaCheiaAtiva(elemento, doc) ? { ok: true } : { ok: false, motivo: "recusado" };
}

/** Sai da tela cheia se ESTE documento estiver nela. Nunca lança. */
export async function sairDaTelaCheia(doc = globalThis.document) {
  if (!doc || !(doc.fullscreenElement ?? doc.webkitFullscreenElement)) return;
  try {
    if (typeof doc.exitFullscreen === "function") await doc.exitFullscreen();
    else await doc.webkitExitFullscreen?.();
  } catch { /* já saiu (Esc) ou o navegador recusou — a tela volta à seleção mesmo assim */ }
}

/** Texto curto do estado da tela cheia, para o aviso discreto do cabeçalho (vazio quando está tudo certo). */
export function avisoTelaCheia({ ativa, ultimaTentativa }) {
  if (ativa) return "";
  if (ultimaTentativa === "sem_suporte") return "Este navegador não oferece tela cheia. A visualização continua nesta janela.";
  if (ultimaTentativa === "recusado") return "O navegador não permitiu a tela cheia. Toque em \"Tela cheia\" para tentar de novo.";
  return "";
}

// ---------------------------------------------------------------------------
// Paginação das listas no Modo Televisão (funções puras; o controlador mede e aplica)
// ---------------------------------------------------------------------------

/** Cada página fica na tela por este tempo antes de dar lugar à próxima. */
export const INTERVALO_PAGINA_MS = 10_000;

/**
 * Divide a lista em páginas que CABEM inteiras na altura disponível, na ordem, sem pular nenhum item.
 * Item mais alto que o espaço inteiro ganha uma página só para ele (nunca é omitido).
 * @param {number[]} alturas altura de cada item, na ordem da lista
 * @param {number} disponivel altura útil da lista
 * @param {number} [espaco] espaço entre itens
 * @returns {Array<[number, number]>} páginas como intervalos [início, fim)
 */
export function montarPaginas(alturas, disponivel, espaco = 0) {
  const paginas = [];
  let ini = 0;
  while (ini < alturas.length) {
    let fim = ini;
    let usado = 0;
    while (fim < alturas.length) {
      const h = alturas[fim] + (fim > ini ? espaco : 0);
      if (fim > ini && usado + h > disponivel) break;
      usado += h;
      fim += 1;
    }
    paginas.push([ini, fim]);
    ini = fim;
  }
  return paginas;
}

/** Índice de página válido: lista que diminuiu leva à última página que ainda existe. */
export const paginaValida = (pagina, total) => (total <= 0 ? 0 : Math.min(Math.max(0, Number(pagina) || 0), total - 1));

/** Avança (passo +1) ou volta (-1) em ciclo: depois da última vem a primeira. */
export const girarPagina = (pagina, total, passo = 1) => (total <= 0 ? 0 : (((paginaValida(pagina, total) + passo) % total) + total) % total);

/** "Página 2 de 3 · 7 pedidos em andamento" — o total é o da lista inteira, não o da página. */
export function textoPagina({ pagina, paginas, total, singular, plural }) {
  return `Página ${pagina + 1} de ${paginas} · ${total} ${total === 1 ? singular : plural}`;
}

// ---------------------------------------------------------------------------
// Foco: com um modo aberto, o resto da Central fica `inert` (sem foco, sem clique, fora da árvore de
// acessibilidade). Marca só o que não estava inerte e devolve a função que desfaz exatamente isso.
// Camadas que a Central criar DEPOIS (painel, overlay, toast) nos mesmos níveis também são marcadas: um
// MutationObserver olha só a lista de filhos desses níveis (sem subárvore) e é desligado ao restaurar.
// Isto é apresentação/acessibilidade — quem autoriza dado é sempre o backend.
// ---------------------------------------------------------------------------

const NAO_MARCAR = new Set(["SCRIPT", "STYLE", "LINK", "TEMPLATE", "META", "NOSCRIPT"]);

/**
 * Torna inertes todos os "irmãos" do caminho entre `raiz` e o `body` (menu, topo, outras camadas da página),
 * agora e enquanto o modo estiver aberto. O próprio caminho (ancestrais da raiz) continua ativo, senão a raiz
 * também ficaria inerte; o que acontece DENTRO da raiz (ex.: diálogo de metas) não é tocado.
 * @param {Element} raiz
 * @param {Document} [doc]
 * @param {typeof MutationObserver} [Observador] injetável para teste; ausente = só o estado do momento
 * @returns {() => void} restaura o estado anterior e desliga o observador (idempotente)
 */
export function isolarFoco(raiz, doc = globalThis.document, Observador = globalThis.MutationObserver) {
  const marcados = new Set();
  const caminho = new Set();
  const niveis = [];
  for (let no = raiz; no && doc && no !== doc.body && no.parentElement; no = no.parentElement) {
    caminho.add(no);
    niveis.push(no.parentElement);
  }
  const marcar = (el) => {
    if (!el || (el.nodeType !== undefined && el.nodeType !== 1)) return; // só elementos (texto/comentário não)
    if (caminho.has(el) || marcados.has(el) || el.inert === true || NAO_MARCAR.has(el.tagName)) return;
    el.inert = true;
    marcados.add(el);
  };
  for (const nivel of niveis) for (const filho of nivel.children) marcar(filho);

  let observador = null;
  if (typeof Observador === "function") {
    observador = new Observador((mudancas) => {
      for (const m of mudancas) for (const el of m.addedNodes ?? []) marcar(el);
    });
    for (const nivel of niveis) observador.observe(nivel, { childList: true });
  }

  let feito = false;
  return () => {
    if (feito) return;
    feito = true;
    observador?.disconnect();
    for (const n of marcados) n.inert = false;
    marcados.clear();
  };
}
