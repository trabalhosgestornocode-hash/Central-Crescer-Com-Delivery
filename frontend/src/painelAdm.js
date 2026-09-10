// Shell do PAINEL ADMINISTRATIVO da Crescer — cabeçalho gerencial, período
// ativo (mês/ano), menu e pilha de navegação interna.
//
// Vive no mesmo SPA que o app do tenant e que o Painel SuperAdmin, mas num
// shell IRMÃO (#painel-adm-screen), nunca visível ao mesmo tempo. Nenhuma view
// daqui lê `state.sessao.empresa` nem depende do Context Token — é o que
// garante, no código, que o Painel Administrativo não opera sob o contexto de
// um cliente (mesma disciplina de admin.js).
//
// PERÍODO ATIVO: o painel inteiro olha UM mês por vez. O período mora aqui
// (`state.painelAdm.periodo`), vai em `mes=AAAA-MM` para todos os endpoints e
// ATRAVESSA a navegação interna — abrir uma empresa ou o calendário de uma
// unidade não perde o mês que o gestor estava analisando.

import { state } from "./state.js";
import { el, els, toast } from "./utils.js";
import { icon } from "./icons.js";
import { painelAdmApi } from "./painelAdmApi.js";
import {
  TELAS_PADM, renderViewPadm, ligarNavegacao,
  resetFiltrosDiario, resetFiltrosIdentificacao, deslocarMes,
} from "./painelAdmViews.js";
import { MESES } from "./painelAdmUi.js";

/** @type {{mostrarTela: Function, aoTrocarAmbiente: Function, aoAcessoRevogado: Function, usuario: object}|null} */
let ganchos = null;
let eventosLigados = false;
let apiAtual = painelAdmApi;

/** Quantos anos para trás o seletor oferece. */
const ANOS_PARA_TRAS = 3;

/**
 * Pilha de navegação interna do painel. O topo é o que está na tela.
 * `[{tipo:"tela", id}]` para as abas; empurra `{tipo:"empresa"...}` /
 * `{tipo:"calendario"...}` ao abrir detalhes. NÃO é histórico de rotas do
 * browser — é só a navegação para trás dentro do painel.
 * @type {Array<object>}
 */
let pilha = [];
const topo = () => pilha[pilha.length - 1] ?? { tipo: "tela", id: TELAS_PADM[0].id };

// ---------------------------------------------------------------------------
// Período ativo
// ---------------------------------------------------------------------------

/** Mês corrente no fuso do negócio (aproximação local — o backend é a autoridade). */
function mesDeHoje() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Normaliza "AAAA-MM" -> `{ano, mes, ym}`. */
export function periodoDe(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym ?? "")) ?? /^(\d{4})-(\d{2})$/.exec(mesDeHoje());
  return { ano: Number(m[1]), mes: Number(m[2]), ym: `${m[1]}-${m[2]}` };
}

/** Período ativo do painel. Exposto em `state.painelAdm.periodo`. */
function periodo() {
  state.painelAdm ??= {};
  state.painelAdm.periodo ??= periodoDe(mesDeHoje());
  return state.painelAdm.periodo;
}

/** Define o período e re-renderiza cabeçalho + tela atual. Recusa mês futuro. */
export function definirPeriodo(ym) {
  const novo = periodoDe(ym);
  if (novo.ym > mesDeHoje()) return Promise.resolve();      // nunca navega para o futuro
  if (novo.ym === periodo().ym) return Promise.resolve();
  state.painelAdm.periodo = novo;
  renderCabecalho();
  return renderPadmAtual();
}

/** Avança/retrocede `delta` meses no período ativo. */
export const mudarPeriodo = (delta) => definirPeriodo(deslocarMes(periodo().ym, delta));

/** Volta para o mês corrente. */
export const irParaMesAtual = () => definirPeriodo(mesDeHoje());

// ---------------------------------------------------------------------------
// Abertura do ambiente
// ---------------------------------------------------------------------------

/**
 * Abre o Painel Administrativo. Injeta as dependências do app.js.
 *
 * VALIDAÇÃO REAL: antes de trocar de shell, chama `GET /administrativo/ping`.
 * Se 403 (acesso revogado), NÃO abre — devolve o controle ao app.js via
 * `aoAcessoRevogado`.
 *
 * @param {{mostrarTela: (t: string) => void, aoTrocarAmbiente: () => void, aoAcessoRevogado: (msg: string) => void, usuario: object, api?: typeof painelAdmApi}} opcoes
 * @returns {Promise<boolean>} true se abriu.
 */
export async function abrirPainelAdministrativo(opcoes) {
  ganchos = opcoes;
  apiAtual = opcoes.api ?? painelAdmApi;

  try {
    await apiAtual.ping();
  } catch (e) {
    if (e.status === 403) {
      opcoes.aoAcessoRevogado?.(
        e.message || "Seu acesso ao Painel Administrativo não está mais disponível.",
      );
      return false;
    }
    toast("Não foi possível abrir o Painel Administrativo: " + e.message);
    return false;
  }

  ligarNavegacao({
    abrirEmpresa: abrirDetalheEmpresa,
    abrirUnidade: abrirCalendarioUnidade,
    voltar: voltarPadm,
    irParaTela: irParaPadm,
    mudarPeriodo,
    // Repinta a tela atual sem mexer na pilha nem no período — usado depois
    // de liberar/revogar um dia, para o calendário refletir o novo estado
    // vindo do backend (nunca um estado remendado no cliente).
    recarregar: renderPadmAtual,
    aoAcessoRevogado: (msg) => {
      state.telaPainelAdm = null;
      opcoes.aoAcessoRevogado?.(msg);
    },
  });

  montarMenu();
  preencherUsuario(opcoes.usuario ?? state.sessao.usuario);
  opcoes.mostrarTela("painelAdm");
  ligarEventos();
  renderCabecalho();
  await irParaPadm(state.telaPainelAdm || TELAS_PADM[0].id);
  return true;
}

/** Sai do Painel Administrativo e volta para a seleção de ambientes. */
export function sairDoPainelAdministrativo() {
  el("#painel-adm-screen")?.classList.remove("menu-aberto");
  state.telaPainelAdm = null;
  pilha = [];
  ganchos?.aoTrocarAmbiente?.();
}

// ---------------------------------------------------------------------------
// Cabeçalho gerencial + seletor de período
// ---------------------------------------------------------------------------

function renderCabecalho() {
  const cab = el("#padm-cabecalho");
  if (!cab) return;
  const p = periodo();
  const hojeYm = mesDeHoje();
  const anoAtual = Number(hojeYm.slice(0, 4));
  const noMesAtual = p.ym === hojeYm;

  const opcoesMes = MESES.map((nome, i) => {
    const num = i + 1;
    const futuro = p.ano === anoAtual && num > Number(hojeYm.slice(5, 7));
    return `<option value="${num}" ${num === p.mes ? "selected" : ""} ${futuro ? "disabled" : ""}>${nome}</option>`;
  }).join("");

  const anos = Array.from({ length: ANOS_PARA_TRAS + 1 }, (_, i) => anoAtual - i);
  const opcoesAno = anos.map((a) => `<option value="${a}" ${a === p.ano ? "selected" : ""}>${a}</option>`).join("");

  cab.innerHTML = `
    <div class="padm-cab-inner">
      <div class="padm-cab-marca">
        <h1 class="padm-cab-tit">Painel Administrativo</h1>
        <p class="padm-cab-sub">Monitoramento das operações da <b>Crescer com Delivery</b></p>
      </div>

      <div class="padm-periodo" role="group" aria-label="Período analisado">
        <span class="padm-periodo-rot">Período analisado</span>
        <div class="padm-periodo-ctrl">
          <button class="padm-per-seta" data-padm-per="anterior" aria-label="Mês anterior">‹</button>
          <div class="padm-periodo-campos">
            <span class="padm-periodo-ic">${icon("calendar", { size: 15 })}</span>
            <select id="padm-per-mes" aria-label="Mês">${opcoesMes}</select>
            <select id="padm-per-ano" aria-label="Ano">${opcoesAno}</select>
          </div>
          <button class="padm-per-seta" data-padm-per="proximo" aria-label="Próximo mês" ${noMesAtual ? "disabled" : ""}>›</button>
        </div>
        <button class="padm-per-atual" data-padm-per="atual" ${noMesAtual ? "hidden" : ""}>Voltar ao mês atual</button>
      </div>
    </div>`;

  ligarPeriodo();
}

function ligarPeriodo() {
  const cab = el("#padm-cabecalho");
  if (!cab) return;
  const mesSel = el("#padm-per-mes");
  const anoSel = el("#padm-per-ano");
  const aplicarSelects = () => {
    const ano = Number(anoSel?.value ?? periodo().ano);
    const mes = Number(mesSel?.value ?? periodo().mes);
    definirPeriodo(`${ano}-${String(mes).padStart(2, "0")}`);
  };
  mesSel?.addEventListener("change", aplicarSelects);
  anoSel?.addEventListener("change", aplicarSelects);

  els("[data-padm-per]").forEach((b) => b.addEventListener("click", () => {
    const acao = b.dataset.padmPer;
    if (acao === "anterior") mudarPeriodo(-1);
    else if (acao === "proximo") mudarPeriodo(+1);
    else if (acao === "atual") irParaMesAtual();
  }));
}

// ---------------------------------------------------------------------------
// Menu e navegação
// ---------------------------------------------------------------------------
function montarMenu() {
  const menu = el("#padm-menu");
  if (!menu) return;
  menu.innerHTML = `<li class="menu-secao">Monitoramento</li>` + TELAS_PADM.map((t) => `${t.id === 'desenvolvimento' ? '<li class="menu-secao">Desenvolvimento</li>' : ''}
    <li data-tela="${t.id}">
      <span class="m-icon">${icon(t.icone, { size: 15 })}</span>
      <span class="m-label">${t.label}</span>
    </li>`).join("");
  els("#padm-menu li[data-tela]").forEach((li) =>
    li.addEventListener("click", () => irParaPadm(li.dataset.tela)));
}

/** Aba de topo — zera a pilha e os filtros do Diário. O período NÃO é zerado. */
export function irParaPadm(telaId) {
  const tela = TELAS_PADM.find((t) => t.id === telaId) ?? TELAS_PADM[0];
  state.telaPainelAdm = tela.id;
  resetFiltrosDiario();
  resetFiltrosIdentificacao();
  pilha = [{ tipo: "tela", id: tela.id }];
  els("#padm-menu li[data-tela]").forEach((li) =>
    li.classList.toggle("ativo", li.dataset.tela === tela.id));
  el("#painel-adm-screen")?.classList.remove("menu-aberto");
  return renderPadmAtual();
}

/** Empurra o detalhe de uma empresa — mantendo o período ativo. */
export function abrirDetalheEmpresa(empresaId, empresaNome) {
  if (!empresaId) return;
  pilha.push({ tipo: "empresa", empresaId, empresaNome });
  return renderPadmAtual();
}

/** Empurra o calendário de uma unidade — abre no mês do período ativo. */
export function abrirCalendarioUnidade(unidadeId, unidadeNome) {
  if (!unidadeId) return;
  const t = topo();
  const entrada = { tipo: "calendario", unidadeId, unidadeNome };
  if (t.tipo === "calendario" && t.unidadeId === unidadeId) pilha[pilha.length - 1] = entrada;
  else pilha.push(entrada);
  return renderPadmAtual();
}

/** Volta um nível na pilha (calendário → empresa → aba). */
export function voltarPadm() {
  if (pilha.length > 1) pilha.pop();
  return renderPadmAtual();
}

function tituloDoTopo() {
  const t = topo();
  if (t.tipo === "empresa") return t.empresaNome || "Empresa";
  if (t.tipo === "calendario") return t.unidadeNome || "Calendário";
  return TELAS_PADM.find((x) => x.id === t.id)?.label ?? "Painel Administrativo";
}

function renderPadmAtual() {
  const seletor = el('#padm-cabecalho .padm-periodo');
  // Telas sem recorte de período (não olham "um mês por vez").
  if (seletor) seletor.hidden = ['desenvolvimento', 'mentorados'].includes(topo().id);
  const titulo = el("#padm-titulo");
  if (titulo) titulo.textContent = tituloDoTopo();
  return renderViewPadm(topo(), { api: apiAtual, mes: periodo().ym });
}

function preencherUsuario(usuario) {
  const nome = usuario?.nome || usuario?.email || "—";
  const setar = (sel, txt) => { const n = el(sel); if (n) n.textContent = txt; };
  setar("#padm-nome", nome);
  setar("#padm-email", usuario?.email ?? "—");
  const avatar = el("#padm-avatar");
  if (avatar) avatar.textContent = (nome[0] || "C").toUpperCase();
}

function ligarEventos() {
  if (eventosLigados) return;
  eventosLigados = true;
  el("#padm-trocar")?.addEventListener("click", sairDoPainelAdministrativo);
  el("#padm-btn-menu")?.addEventListener("click", () => el("#painel-adm-screen")?.classList.toggle("menu-aberto"));
  el("#padm-backdrop")?.addEventListener("click", () => el("#painel-adm-screen")?.classList.remove("menu-aberto"));
  // "Tentar de novo" dos estados de erro.
  el("#padm-view")?.addEventListener("click", (e) => {
    if (e.target.closest('[data-padm-acao="recarregar"]')) renderPadmAtual();
  });
}
