// Tutorial "Como lançar Sanduíches + Saladas" do Dashboard iFood.
//
// Só existe para unidade com a opção "Considerar Sanduíches + Saladas"
// ATIVA HOJE — sinal: `composicaoCanais.estruturaUnidade === "multicanal"`
// no GET /dashboard-executivo/mes (campo que nem aparece numa unidade
// padrão). Unidade padrão: nenhum botão, nenhum modal, markup intacto.
//
// Exibição: abre sozinho na PRIMEIRA vez que o usuário entra no Dashboard
// daquela unidade; fechar (X, Esc, clique fora ou "Começar lançamento")
// marca como visto. "Como preencher" reabre a qualquer momento.
// Estado "já viu" = localStorage por usuário + unidade (preferência de
// interface, sem backend). Storage indisponível (modo privado, bloqueio)
// nunca quebra a tela: cai num controle em memória só desta sessão.
//
// Puramente informativo — não lê nem grava nada do lançamento.
import { escapeHtml } from "./utils.js";
import { icon } from "./icons.js";

const PREFIXO_CHAVE = "crescer:dex-tutorial-sanduiches-saladas:v1";
const vistosNestaSessao = new Set();

/** A unidade do mês carregado usa Sanduíches + Saladas hoje? */
export function unidadeUsaSanduichesSaladas(dadosMes) {
  return !!dadosMes && !dadosMes.agregado && dadosMes.composicaoCanais?.estruturaUnidade === "multicanal";
}

export const chaveTutorial = (usuarioId, unidadeId) => `${PREFIXO_CHAVE}:${usuarioId ?? "anonimo"}:${unidadeId}`;

function storage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function tutorialJaVisto(usuarioId, unidadeId) {
  const chave = chaveTutorial(usuarioId, unidadeId);
  if (vistosNestaSessao.has(chave)) return true;
  try { return storage()?.getItem(chave) === "1"; } catch { return false; }
}

/** Só para testes: zera o controle em memória desta sessão. */
export const _reiniciarTutorialParaTeste = () => vistosNestaSessao.clear();

export function marcarTutorialVisto(usuarioId, unidadeId) {
  const chave = chaveTutorial(usuarioId, unidadeId);
  vistosNestaSessao.add(chave);
  try { storage()?.setItem(chave, "1"); } catch { /* sem storage: vale só nesta sessão */ }
}

// ---------------------------------------------------------------------------
// Conteúdo — mini-ilustrações em HTML/CSS (sem imagem externa)
// ---------------------------------------------------------------------------
const fonte = (nome, extra = "") => `<div class="dex-tut-fonte">${escapeHtml(nome)}${extra}</div>`;
const mais = `<span class="dex-tut-op" aria-hidden="true">+</span>`;
const igual = `<span class="dex-tut-op" aria-hidden="true">=</span>`;
const campo = (rotulo, valor = "") => `<div class="dex-tut-campo"><span>${escapeHtml(rotulo)}</span><b>${escapeHtml(valor)}</b></div>`;
const chip = (texto, classe = "") => `<span class="dex-tut-chip ${classe}">${escapeHtml(texto)}</span>`;

export const SLIDES = [
  {
    id: "visao",
    titulo: "Uma única unidade, duas fontes de venda",
    texto: "Esta unidade possui duas operações no iFood: Sanduíches e Saladas. O Dashboard considera as duas para calcular o resultado total da unidade.",
    chave: "Sanduíches + Saladas = resultado final da unidade",
    ilustracao: `<div class="dex-tut-fluxo">
        ${fonte("Sanduíches")}${mais}${fonte("Saladas")}${igual}
        <div class="dex-tut-fonte dex-tut-total">${icon("store", { size: 15 })} Unidade</div>
      </div>`,
  },
  {
    id: "situacao",
    titulo: "1. Informe a situação da operação",
    texto: "Primeiro, informe se a unidade funcionou normalmente no dia. Depois, indique a situação de cada fonte: Sanduíches e Saladas.",
    itens: [
      ["Com vendas", "a fonte vendeu no dia — você vai informar os números dela."],
      ["Sem vendas", "a fonte não vendeu — o acumulado do mês dela se repete."],
      ["Não informado", "ainda não sabe — dá para salvar rascunho, mas não finalizar o Financeiro."],
    ],
    chave: "Cada fonte pode ter um comportamento diferente no mesmo dia.",
    ilustracao: `<div class="dex-tut-mock">
        <div class="dex-tut-linha"><b>Sanduíches</b>${chip("Com vendas", "ativo")}${chip("Sem vendas")}${chip("Não informado")}</div>
        <div class="dex-tut-linha"><b>Saladas</b>${chip("Com vendas")}${chip("Sem vendas", "ativo")}${chip("Não informado")}</div>
      </div>`,
  },
  {
    id: "desempenho",
    titulo: "2. Preencha o desempenho acumulado",
    texto: "Na etapa de Desempenho, preencha separadamente, na aba de cada fonte, os dados ACUMULADOS do mês de Sanduíches e de Saladas.",
    itens: [
      ["Quantidade de pedidos", "total do mês até o dia."],
      ["Valor bruto", "total vendido no mês até o dia."],
      ["Novos clientes", "total do mês até o dia."],
    ],
    chave: "Os valores são acumulados do mês, não apenas do dia.",
    nota: "Se uma fonte estiver sem vendas, o acumulado dela se repete automaticamente.",
    ilustracao: `<div class="dex-tut-mock">
        <div class="dex-tut-abas">${chip("Sanduíches", "ativo")}${chip("Saladas")}</div>
        ${campo("Pedidos no mês", "400")}${campo("Valor bruto no mês", "R$ 20.000,00")}${campo("Novos clientes no mês", "50")}
      </div>`,
  },
  {
    id: "financeiro",
    titulo: "3. Preencha o financeiro",
    texto: "Na etapa Financeiro, informe separadamente, na aba de cada fonte, os dados do extrato do iFood de Sanduíches e de Saladas.",
    itens: [
      ["Financeiro Oficial", ""], ["Taxas e Comissões", ""], ["Serviços e Promoções", ""],
      ["Ajustes a Favor", ""], ["Ajustes Contra", ""],
    ],
    chave: "Sanduíches e Saladas têm financeiros separados, mas os entregadores são da operação da unidade.",
    nota: "A taxa de entregadores é informada apenas uma vez, no bloco da unidade — nunca dentro de Sanduíches ou Saladas.",
    ilustracao: `<div class="dex-tut-mock">
        <div class="dex-tut-abas">${chip("Sanduíches")}${chip("Saladas", "ativo")}</div>
        ${campo("Financeiro Oficial", "R$ 5.000,00")}${campo("Taxas e Comissões", "R$ 550,00")}
        <div class="dex-tut-unidade"><span class="dex-tut-unidade-rotulo">${icon("truck", { size: 14 })} Operação da unidade</span>${campo("Taxa de entregadores", "R$ 3.000,00")}</div>
      </div>`,
  },
  {
    id: "conferencia",
    titulo: "4. Confira o consolidado",
    texto: "Na conferência final, o sistema soma Sanduíches + Saladas e mostra o resultado total da unidade: total de pedidos, total bruto, total financeiro, ticket médio, percentuais e receita líquida.",
    chave: "Antes de finalizar, confirme se o total da unidade está correto.",
    nota: "O consolidado é somente leitura — para corrigir, volte à etapa da fonte.",
    ilustracao: `<div class="dex-tut-mock">
        <div class="dex-tut-sub">Consolidado da unidade</div>
        ${campo("Pedidos", "500")}${campo("Valor bruto", "R$ 25.000,00")}${campo("Ticket médio", "R$ 50,00")}${campo("Receita líquida", "R$ 16.800,00")}
      </div>`,
  },
  {
    id: "interpretacao",
    titulo: "Como o Dashboard interpreta os dados",
    texto: "Depois do lançamento, a Visão Geral usa o consolidado da unidade para calcular metas, limites, status e indicadores.",
    chave: "O Dashboard sempre avalia o resultado total da unidade.",
    ilustracao: `<div class="dex-tut-fluxo">
        ${fonte("Sanduíches", "<small>R$ 20.000</small>")}${mais}${fonte("Saladas", "<small>R$ 5.000</small>")}${igual}
        <div class="dex-tut-fonte dex-tut-total">Unidade<small>R$ 25.000</small></div>
      </div>`,
  },
  {
    id: "final",
    titulo: "Pronto para começar",
    texto: "Agora você já sabe como preencher Sanduíches e Saladas corretamente.",
    nota: "Se precisar, você pode abrir este tutorial novamente a qualquer momento em “Como preencher”.",
    ilustracao: `<div class="dex-tut-fluxo"><span class="dex-tut-ok">${icon("check-circle", { size: 34 })}</span></div>`,
  },
];

function corpoSlide(s) {
  const itens = s.itens?.length
    ? `<ul class="dex-tut-itens">${s.itens.map(([t, d]) => `<li><b>${escapeHtml(t)}</b>${d ? ` — ${escapeHtml(d)}` : ""}</li>`).join("")}</ul>`
    : "";
  return `<div class="dex-tut-ilustracao" aria-hidden="true">${s.ilustracao}</div>
    <h3 class="dex-tut-titulo" id="dex-tut-titulo-slide">${escapeHtml(s.titulo)}</h3>
    <p class="dex-tut-texto">${escapeHtml(s.texto)}</p>
    ${itens}
    ${s.nota ? `<p class="dex-tut-nota">${icon("info", { size: 14 })} ${escapeHtml(s.nota)}</p>` : ""}
    ${s.chave ? `<p class="dex-tut-chave">${escapeHtml(s.chave)}</p>` : ""}`;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
let aberto = null;
export const tutorialAberto = () => !!aberto;

/**
 * Abre o tutorial. `aoFechar` roda uma vez, qualquer que seja a forma de
 * fechar (X, Esc, clique fora, "Começar lançamento").
 * @param {{aoFechar?: () => void}} [opts]
 */
export function abrirTutorialSanduichesSaladas({ aoFechar } = {}) {
  if (aberto) return aberto;
  const doc = globalThis.document;
  const focoAnterior = doc.activeElement ?? null;
  const ov = doc.createElement("div");
  ov.className = "modal-overlay dex-tut-overlay";
  doc.body.appendChild(ov);
  let i = 0;

  // A moldura (título, X) é montada uma vez; trocar de slide só refaz o
  // corpo e o rodapé — sem repetir a animação de entrada do modal.
  ov.innerHTML = `<div class="modal dex-tut" role="dialog" aria-modal="true" aria-labelledby="dex-tut-titulo" aria-describedby="dex-tut-titulo-slide">
    <button class="modal-close" type="button" id="dex-tut-fechar" aria-label="Fechar tutorial">×</button>
    <header class="dex-tut-head">
      <h2 id="dex-tut-titulo">Como lançar Sanduíches + Saladas no Dashboard iFood</h2>
      <p>Entenda como preencher corretamente os dados da unidade.</p>
    </header>
    <section class="dex-tut-slide" aria-live="polite"></section>
    <footer class="dex-tut-rodape"></footer>
  </div>`;
  ov.querySelector("#dex-tut-fechar").addEventListener("click", () => fechar());
  const slide = ov.querySelector(".dex-tut-slide");
  const rodape = ov.querySelector(".dex-tut-rodape");

  const render = () => {
    const ultimo = i === SLIDES.length - 1;
    slide.setAttribute("data-slide", SLIDES[i].id);
    slide.innerHTML = corpoSlide(SLIDES[i]);
    rodape.innerHTML = `
      <span class="dex-tut-progresso" id="dex-tut-progresso">${i + 1} de ${SLIDES.length}</span>
      <span class="dex-tut-pontos" aria-hidden="true">${SLIDES.map((_, k) => `<i class="${k === i ? "ativo" : ""}"></i>`).join("")}</span>
      <span class="dex-tut-acoes">
        <button class="btn btn-ghost" type="button" id="dex-tut-anterior" ${i === 0 ? "disabled" : ""}>${icon("chevron-left", { size: 15 })} Anterior</button>
        ${ultimo
          ? `<button class="btn btn-primary" type="button" id="dex-tut-comecar">Começar lançamento</button>`
          : `<button class="btn btn-primary" type="button" id="dex-tut-proximo">Próximo ${icon("chevron-right", { size: 15 })}</button>`}
      </span>`;
    ov.querySelector("#dex-tut-anterior").addEventListener("click", () => ir(i - 1));
    ov.querySelector("#dex-tut-proximo")?.addEventListener("click", () => ir(i + 1));
    ov.querySelector("#dex-tut-comecar")?.addEventListener("click", () => fechar());
    (ov.querySelector("#dex-tut-comecar") ?? ov.querySelector("#dex-tut-proximo"))?.focus();
  };
  const ir = (n) => { if (n < 0 || n >= SLIDES.length) return; i = n; render(); };

  const focaveis = () => [...ov.querySelectorAll("button")].filter((b) => !b.disabled);
  const onTecla = (e) => {
    if (e.key === "Escape") { e.preventDefault?.(); fechar(); return; }
    if (e.key === "ArrowRight") { ir(i + 1); return; }
    if (e.key === "ArrowLeft") { ir(i - 1); return; }
    if (e.key === "Tab") {
      // Foco preso no modal enquanto ele está aberto.
      const lista = focaveis();
      if (!lista.length) return;
      const atual = lista.indexOf(doc.activeElement);
      const proximo = e.shiftKey ? (atual <= 0 ? lista.length - 1 : atual - 1) : (atual === lista.length - 1 ? 0 : atual + 1);
      e.preventDefault?.();
      lista[proximo].focus();
    }
  };
  const onCliqueFora = (e) => { if (e.target === ov) fechar(); };

  function fechar() {
    if (!aberto) return;
    aberto = null;
    doc.removeEventListener("keydown", onTecla);
    ov.remove();
    try { focoAnterior?.focus?.(); } catch { /* elemento já saiu da tela */ }
    aoFechar?.();
  }

  doc.addEventListener("keydown", onTecla);
  ov.addEventListener("click", onCliqueFora);
  aberto = { overlay: ov, fechar, ir, slideAtual: () => i };
  render();
  return aberto;
}

// ---------------------------------------------------------------------------
// Integração com a tela do Dashboard iFood
// ---------------------------------------------------------------------------
const ID_BOTAO = "dex-tutorial-abrir";

/**
 * Chamado a cada carregamento do mês. Unidade padrão: remove qualquer
 * vestígio (unidade trocada) e não faz mais nada. Sanduíches + Saladas:
 * garante o botão "Como preencher" no cabeçalho e abre sozinho na primeira
 * vez deste usuário nesta unidade — nunca por cima de outro modal aberto.
 * @param {{dadosMes: object, unidadeId: string|null, usuarioId: string|null, cabecalho: Element|null}} p
 */
export function atualizarTutorialDashboard({ dadosMes, unidadeId, usuarioId, cabecalho }) {
  const doc = globalThis.document;
  const elegivel = !!unidadeId && unidadeUsaSanduichesSaladas(dadosMes);
  // Sempre recriado: o botão guarda usuário/unidade no clique, e a unidade pode ter mudado.
  doc.querySelector(`#${ID_BOTAO}`)?.remove();
  if (!elegivel) return { elegivel, abriu: false };

  if (cabecalho) {
    cabecalho.insertAdjacentHTML("beforeend",
      `<button class="btn btn-ghost btn-sm dex-tut-botao" type="button" id="${ID_BOTAO}">${icon("info", { size: 14 })} Como preencher</button>`);
    doc.querySelector(`#${ID_BOTAO}`)?.addEventListener("click", () => {
      abrirTutorialSanduichesSaladas({ aoFechar: () => marcarTutorialVisto(usuarioId, unidadeId) });
    });
  }

  const outroModalAberto = [...doc.querySelectorAll(".modal-overlay")].some((o) => !o.classList.contains("dex-tut-overlay"));
  if (tutorialAberto() || outroModalAberto || tutorialJaVisto(usuarioId, unidadeId)) return { elegivel, abriu: false };
  abrirTutorialSanduichesSaladas({ aoFechar: () => marcarTutorialVisto(usuarioId, unidadeId) });
  return { elegivel, abriu: true };
}
