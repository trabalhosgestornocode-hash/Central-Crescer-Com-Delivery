// Shell do Painel SuperAdmin: menu, roteamento e as dez views.
//
// Vive no mesmo SPA que o app do tenant, mas em um shell IRMÃO (#admin), nunca
// visível ao mesmo tempo. Nenhuma view daqui lê `state.sessao.empresa` nem
// depende do Context Token — é o que garante, no código, que o painel da
// plataforma não opera sob o contexto de um cliente.
//
// A única ponte para dentro de um cliente é "Entrar como empresa", que pede um
// contexto de impersonação ao backend e entrega para o app.js trocar de shell.

import { state } from "./state.js";
import { el, els, toast } from "./utils.js";
import { adminApi } from "./adminApi.js";
import { renderView, TELAS_ADMIN } from "./adminViews.js";
import { instalarMenuRetratil } from "./menuLateral.js";

/** @type {{mostrarTela: Function, aoEntrarEmEmpresa: Function, aoSair: Function}|null} */
let ganchos = null;

/** Injeta as dependências do app.js e mostra o painel. */
export function abrirPainelAdmin(opcoes) {
  ganchos = opcoes;
  montarMenu();
  preencherUsuario(opcoes.usuario ?? state.sessao.usuario);
  opcoes.mostrarTela("admin");
  ligarEventos();
  irParaAdmin(state.telaAdmin || "dashboard");
  carregarVersao();
}

export function fecharPainelAdmin() {
  el("#admin")?.classList.remove("menu-aberto");
}

/** Handler exposto para as views chamarem "Entrar como empresa". */
export async function entrarComoEmpresa(id, nome) {
  try {
    const contexto = await adminApi.entrarComoEmpresa(id);
    ganchos?.aoEntrarEmEmpresa(contexto);
  } catch (e) {
    toast(`Não foi possível entrar em ${nome ?? "a empresa"}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Menu e navegação
// ---------------------------------------------------------------------------

function montarMenu() {
  const menu = el("#adm-menu");
  if (!menu) return;
  const secoes = [...new Set(TELAS_ADMIN.map((t) => t.secao))];
  menu.innerHTML = secoes.map((secao) => {
    const itens = TELAS_ADMIN.filter((t) => t.secao === secao);
    return `<li class="menu-secao">${secao}</li>` + itens.map((t) => `
      <li data-tela="${t.id}">
        <span class="m-icon">${t.icone}</span>
        <span class="m-label">${t.label}</span>
      </li>`).join("");
  }).join("");
  els("#adm-menu li[data-tela]").forEach((li) =>
    li.addEventListener("click", () => irParaAdmin(li.dataset.tela)));
}

/** @param {string} telaId */
export function irParaAdmin(telaId) {
  const tela = TELAS_ADMIN.find((t) => t.id === telaId) ?? TELAS_ADMIN[0];
  state.telaAdmin = tela.id;
  el("#adm-titulo").textContent = tela.label;
  els("#adm-menu li[data-tela]").forEach((li) =>
    li.classList.toggle("ativo", li.dataset.tela === tela.id));
  el("#admin").classList.remove("menu-aberto");   // fecha a sidebar no mobile
  renderView(tela.id);
}

/** Recarrega a view atual — usado pelo botão de atualizar e após cada ação. */
export function recarregarAdmin() {
  renderView(state.telaAdmin || "dashboard");
}

function preencherUsuario(usuario) {
  const nome = usuario?.nome || usuario?.email || "superadmin";
  el("#adm-nome").textContent = nome;
  el("#adm-avatar").textContent = (nome[0] || "S").toUpperCase();
  el("#adm-um-nome").textContent = nome;
  el("#adm-um-email").textContent = usuario?.email ?? "—";
}

async function carregarVersao() {
  try {
    const d = await adminApi.atualizacoes();
    el("#adm-versao").textContent = d.versaoAtual ? `v${d.versaoAtual} · ${d.ambiente}` : d.ambiente;
  } catch {
    el("#adm-versao").textContent = "—";
  }
}

let eventosLigados = false;
function ligarEventos() {
  if (eventosLigados) return;
  eventosLigados = true;

  el("#adm-refresh")?.addEventListener("click", recarregarAdmin);
  el("#adm-btn-menu")?.addEventListener("click", () => el("#admin").classList.toggle("menu-aberto"));
  el("#adm-backdrop")?.addEventListener("click", () => el("#admin").classList.remove("menu-aberto"));
  instalarMenuRetratil({ shell: el("#admin"), sidebar: el("#adm-sidebar"), menu: el("#adm-menu"), ancora: el("#adm-sidebar .adm-sidebar-foot"), desktopMin: 981 });

  // Delegação única para TODAS as ações das views — INCLUSIVE as de dentro do
  // modal. `#adm-modal` é irmão de `#adm-view` no HTML (não filho), então
  // escutar só `#adm-view` nunca capturaria um clique em algo como "Excluir
  // empresa" dentro do modal "⋯" — o clique nem borbulhava até o listener.
  // `document` cobre os dois; o filtro por `[data-adm-acao]` já isola isto do
  // resto do app (o shell do tenant usa outro mecanismo de ação).
  //
  // `<select data-adm-acao>` (ex.: trocar o cargo de um vínculo) é tratado à
  // parte: o clique que ABRE o dropdown não carrega o valor novo (o SO ainda
  // não deixou escolher nada), só o "change" tem o valor certo. Um único
  // listener de "click" pra tudo disparava a ação com o valor VELHO a cada
  // abertura do dropdown — por isso os dois tipos de elemento têm listener
  // próprio, cada um no evento em que o valor de fato está pronto.
  document.addEventListener("click", (e) => {
    const alvo = e.target.closest("[data-adm-acao]");
    if (!alvo || alvo.tagName === "SELECT") return;
    dispararAcaoAdmin(alvo);
  });
  document.addEventListener("change", (e) => {
    const alvo = e.target.closest("select[data-adm-acao]");
    if (!alvo) return;
    dispararAcaoAdmin(alvo);
  });
}

function dispararAcaoAdmin(alvo) {
  const { admAcao, ...dados } = alvo.dataset;
  document.dispatchEvent(new CustomEvent("admin:acao", { detail: { acao: admAcao, dados, alvo } }));
}
