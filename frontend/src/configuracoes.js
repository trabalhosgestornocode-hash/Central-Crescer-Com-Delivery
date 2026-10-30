// Configurações 2.0 — navegação por categorias (lateral no computador, lista → detalhe no celular) e painéis por seção.
//
// MULTI-TENANT DE VERDADE: toda seção parte da EMPRESA e da UNIDADE do
// contexto atual (state.sessao.empresa / state.sessao.unidade), nunca de
// nome, id fixo ou fallback de um tenant específico. As seções que gravam
// dados falam com o backend, que resolve o tenant pelo Context Token
// (req.tenant) — o frontend nunca envia organizacao_id/unidade_id.
//
// O que continua sendo LOCAL, e por quê:
//   * Aparência (tema claro/escuro) — preferência do dispositivo/usuário,
//     não faz sentido gravar como config da loja.
//   * "Exportar configurações locais" — dump do que está no navegador,
//     rotulado honestamente como tal.
//   * A última categoria aberta (sessionStorage) — só conveniência de navegação.
// Nada mais é salvo localmente.
//
// PERMISSÃO: a tela mostra só as ações que o usuário pode fazer; o servidor e o
// banco revalidam tudo. Ações críticas usam diálogo próprio (nunca confirm()).
import { el, escapeHtml, toast } from "./utils.js";
import { state } from "./state.js";
import { icon } from "./icons.js";
import { definirLimitesCmv } from "./cmvConfig.js";
import {
  obterUsuarios, criarUsuario, atualizarUsuario, excluirUsuario, listarConvitesUsuario, revogarConviteUsuario,
  obterTabelasComerciaisUnidade, alterarTabelaComercialUnidade,
  obterDadosUnidade, atualizarDadosUnidade,
  obterMetasCmvUnidade, salvarMetasCmvUnidade,
  obterCatalogoIntegracoes, notificacoesResumo,
} from "./api.js";
import { pode, definirNovaSenha } from "./sessao.js";
import { registrarResetDeContexto, geracaoContexto, contextoMudou } from "./contextoEscopo.js";
import { estadoMfa, iniciarCadastro, confirmarCadastro, removerFator } from "./mfa.js";
import { montarCentralNotificacoes } from "./configuracoesNotificacoes.js";

// Perfis da UI <-> enum papel_acesso do banco (migration 015). O cargo
// pertence ao VÍNCULO usuário<->empresa, não ao usuário: o mesmo login pode
// ser Administrador aqui e Financeiro em outra unidade do grupo.
const PAPEL_LABEL = {
  organization_admin: "Administrador",
  unit_manager: "Gestor de Unidade",
  finance: "Financeiro",
  operations: "Operação",
  viewer: "Consulta",
};
const PAPEL_ENUM = Object.fromEntries(Object.entries(PAPEL_LABEL).map(([k, v]) => [v, k]));
const PERFIS = Object.values(PAPEL_LABEL);

// ---------- contexto atual (empresa + unidade) ----------
const empresaAtual = () => state.sessao.empresa || null;
const unidadeAtual = () => state.sessao.unidade || null;
const nomeEmpresa = () => empresaAtual()?.nome || "—";
const nomeUnidade = () => unidadeAtual()?.nome || null;
const temUnidade = () => !!unidadeAtual()?.id;

const slug = (s) => String(s || "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "config";

// ---------- tema (individual, por dispositivo) ----------
// Chave nova; lê a antiga uma vez para não perder a preferência de quem já
// tinha escolhido tema antes desta mudança.
const LS_TEMA = "cd.tema";
const LS_TEMA_LEGADO = "saci-tema"; // chave antiga; lida uma vez p/ migrar a preferência de tema
function lerTema() {
  const t = localStorage.getItem(LS_TEMA) ?? localStorage.getItem(LS_TEMA_LEGADO);
  return t === "dark" ? "dark" : "light";
}
export function aplicarTemaSalvo() {
  const t = lerTema();
  document.documentElement.setAttribute("data-theme", t);
  return t;
}
function definirTema(t) {
  localStorage.setItem(LS_TEMA, t);
  localStorage.removeItem(LS_TEMA_LEGADO);
  document.documentElement.setAttribute("data-theme", t);
}
const temaAtual = () => lerTema();

// ---------- helpers de UI ----------
// Todo campo tem <small class="cfg-erro"> ligado por aria-describedby: a validação escreve ali (e o leitor de tela anuncia).
const campo = (label, id, valor = "", { tipo = "text", ph = "", extra = "", ajuda = "" } = {}) => `
  <label class="cfg-campo" for="${id}">
    <span>${label}</span>
    <input id="${id}" name="${id}" type="${tipo}" value="${escapeHtml(valor)}" placeholder="${escapeHtml(ph)}" aria-describedby="${id}-erro${ajuda ? ` ${id}-ajuda` : ""}" ${extra} />
    ${ajuda ? `<small class="cfg-ajuda" id="${id}-ajuda">${ajuda}</small>` : ""}
    <small class="cfg-erro" id="${id}-erro" role="alert"></small>
  </label>`;

const campoFixo = (label, valor) => `
  <div class="cfg-campo">
    <span>${label}</span>
    <b class="cfg-campo-fixo">${escapeHtml(valor ?? "—")}</b>
  </div>`;

const select = (label, id, opcoes, valorAtual = "", extra = "") => `
  <label class="cfg-campo" for="${id}">
    <span>${label}</span>
    <select id="${id}" name="${id}" ${extra}>${opcoes.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${escapeHtml(v)}" ${v === valorAtual ? "selected" : ""}>${escapeHtml(l)}</option>`;
    }).join("")}</select>
  </label>`;

const painel = (titulo, corpo, sub = "") =>
  `<section class="cfg-panel"><div class="cfg-panel-head"><h3>${escapeHtml(titulo)}</h3>${sub ? `<p>${escapeHtml(sub)}</p>` : ""}</div><div class="cfg-panel-body">${corpo}</div></section>`;

// Barra de salvar com estado visível: sem alterações → alterações não salvas → salvando → salvo às HH:MM | erro.
const barraSalvar = () => `
  <div class="cfg-salvar" data-salvar-barra>
    <span class="cfg-salvar-estado" data-estado aria-live="polite">Sem alterações</span>
    <span class="cfg-salvar-acoes">
      <button type="button" class="btn btn-ghost btn-sm" data-descartar hidden>Descartar</button>
      <button type="button" class="btn btn-primary" data-salvar disabled>Salvar alterações</button>
    </span>
  </div>`;

const somenteLeitura = (quem = "um Administrador da empresa") =>
  `<p class="cfg-somente-leitura">${icon("lock", { size: 14 })} Somente leitura — quem altera: ${escapeHtml(quem)}.</p>`;

const val = (root, id) => root.querySelector("#" + id)?.value ?? "";

const estadoCarregando = (txt = "Carregando…") =>
  `<div class="cfg-panel"><div class="cfg-panel-body"><div class="estado" role="status"><div class="spinner"></div>${escapeHtml(txt)}</div></div></div>`;

const estadoErro = (titulo, e) =>
  painel(titulo, `<div class="estado-mini bad" role="alert">Não foi possível carregar: ${escapeHtml(e?.message ?? "erro")}</div>`);

const avisoSemUnidade = () => painel(
  "Selecione uma unidade",
  `<div class="estado-mini">Esta configuração é por unidade. Você está na visão consolidada
   (<b>todas as unidades</b> de ${escapeHtml(nomeEmpresa())}). Escolha uma unidade no seletor do topo para ver e editar.</div>`,
);

// Chama fn() só se o contexto não mudou no meio do await (evita render de
// dado da unidade anterior — mesmo mecanismo das outras views).
async function carregarProtegido(fn) {
  const g = geracaoContexto();
  try {
    const dados = await fn();
    if (contextoMudou(g)) return null;
    return dados;
  } catch (e) {
    if (contextoMudou(g)) return null;
    throw e;
  }
}

/** Diálogo acessível (substitui confirm()). `exigirTexto`: o usuário digita a frase para liberar ações de alto impacto. */
export function confirmarDialogo({ titulo, texto, confirmar = "Confirmar", perigo = false, exigirTexto = null }) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    if (typeof d.showModal !== "function" || !document.body?.appendChild) { resolve(false); return; }
    const anterior = document.activeElement;
    d.className = "cfg-dialogo";
    d.setAttribute("aria-labelledby", "cfg-dialogo-t");
    d.innerHTML = `<form method="dialog" class="cfg-dialogo-corpo">
        <h2 id="cfg-dialogo-t">${escapeHtml(titulo)}</h2><p>${escapeHtml(texto)}</p>
        ${exigirTexto ? `<label class="cfg-campo"><span>Digite <b>${escapeHtml(exigirTexto)}</b> para confirmar</span><input name="conf" autocomplete="off" /></label>` : ""}
        <div class="cfg-acoes"><button value="nao" class="btn btn-ghost">Cancelar</button>
          <button value="sim" class="btn ${perigo ? "btn-perigo" : "btn-primary"}" data-ok ${exigirTexto ? "disabled" : ""}>${escapeHtml(confirmar)}</button></div></form>`;
    document.body.appendChild(d);
    const ok = d.querySelector("[data-ok]");
    d.querySelector('input[name="conf"]')?.addEventListener("input", (ev) => { ok.disabled = ev.target.value.trim() !== exigirTexto; });
    d.addEventListener("close", () => { const r = d.returnValue === "sim"; d.remove(); anterior?.focus?.(); resolve(r); }, { once: true });
    d.showModal();
    (d.querySelector('input[name="conf"]') ?? d.querySelector("button"))?.focus();
  });
}

/** Liga a barra de salvar de `root`: marca alterações, valida (erro de campo vai para o campo) e mostra o resultado. */
function ligarFormulario(root, { aoSalvar, aoDescartar }) {
  const barra = root.querySelector("[data-salvar-barra]");
  if (!barra) return;
  const estado = barra.querySelector("[data-estado]");
  const btn = barra.querySelector("[data-salvar]");
  const descartar = barra.querySelector("[data-descartar]");
  const marcar = (texto, alterado) => {
    estado.textContent = texto; btn.disabled = !alterado; descartar.hidden = !alterado;
    root.dataset.alterado = alterado ? "1" : "";
    barra.classList.toggle("cfg-salvar--alterado", alterado);
  };
  const aoMudar = (ev) => { if (!ev.target.closest("[data-salvar-barra]")) marcar("Alterações não salvas", true); };
  root.addEventListener("input", aoMudar);
  root.addEventListener("change", aoMudar);
  descartar.addEventListener("click", () => aoDescartar());
  btn.addEventListener("click", async () => {
    for (const e of root.querySelectorAll(".cfg-erro")) e.textContent = "";
    btn.disabled = true; estado.textContent = "Salvando…";
    try {
      await aoSalvar();
      marcar(`Salvo às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`, false);
    } catch (e) {
      marcar("Não foi salvo — confira os campos", true);
      const alvo = e?.campo ? root.querySelector(`#${e.campo}-erro`) : null;
      if (alvo) { alvo.textContent = e.message; root.querySelector(`#${e.campo}`)?.focus?.(); }
      else toast("Erro ao salvar: " + (e?.message ?? "erro"));
    }
  });
}
const erroCampo = (campoId, mensagem) => Object.assign(new Error(mensagem), { campo: campoId });

// ======================= ESTRUTURA (7 categorias) =======================
const CATEGORIAS = [
  { id: "unidade-empresa", icone: "store", titulo: "Unidade e empresa", desc: "Dados da loja, fuso e horário de funcionamento.", secoes: ["unidade", "fuso"] },
  { id: "metas-operacao", icone: "target", titulo: "Metas e operação", desc: "CMV, metas, Tabelas Comerciais e atalhos dos módulos.", secoes: ["cmv", "precos", "atalhos"] },
  { id: "notificacoes", icone: "bell", titulo: "Notificações", desc: "Quem recebe os avisos, consentimentos e histórico.", secoes: ["notificacoes"] },
  { id: "usuarios-acesso", icone: "users", titulo: "Usuários e acesso", desc: "Equipe, cargos e convites.", secoes: ["usuarios"] },
  { id: "integracoes", icone: "link", titulo: "Integrações", desc: "Estado das conexões.", secoes: ["integracoes"] },
  { id: "seguranca-privacidade", icone: "shield-check", titulo: "Segurança e privacidade", desc: "Sua senha, 2FA e privacidade.", secoes: ["seguranca", "privacidade"] },
  { id: "preferencias", icone: "sliders-horizontal", titulo: "Preferências", desc: "Aparência e dados deste dispositivo.", secoes: ["aparencia", "backup"] },
];
const SECAO_TITULO = {
  unidade: "Dados da Unidade", fuso: "Fuso e horário de funcionamento", cmv: "Metas e Limites de CMV", precos: "Tabelas Comerciais",
  atalhos: "Configurações dos módulos", notificacoes: "Central de Notificações", usuarios: "Usuários e Permissões",
  integracoes: "Integrações", seguranca: "Segurança", privacidade: "Privacidade", aparencia: "Aparência",
  backup: "Configurações deste dispositivo",
};
const categoriaDaSecao = (secao) => CATEGORIAS.find((c) => c.secoes.includes(secao)) ?? null;
const SS_CATEGORIA = "cd.configuracoes.categoria";
let pendenciasNotificacoes = 0;

export function renderConfiguracoes() {
  let salva = null;
  try { salva = sessionStorage.getItem(SS_CATEGORIA); } catch { /* sem storage: abre a primeira */ }
  abrirCategoria(CATEGORIAS.some((c) => c.id === salva) ? salva : CATEGORIAS[0].id, { detalhe: false });
}

/** Abre direto uma seção (ex.: "precos" = Tabelas Comerciais) — usado pelo
 * CTA "Selecionar tabelas oficiais" do Dashboard iFood (via app.js). A seção
 * aparece sozinha em #cfg-detalhe, com o caminho de volta para a categoria. */
export function abrirSecaoConfiguracoes(id) {
  const c = categoriaDaSecao(id);
  if (!c) return renderConfiguracoes();
  abrirCategoria(c.id, { foco: id, detalhe: true });
}

function cabecalho() {
  const empresa = nomeEmpresa();
  const unidade = nomeUnidade();
  const subtitulo = unidade ? `${empresa} · ${unidade}` : `${empresa} · todas as unidades`;
  return `<p class="secao-titulo">${icon("settings", { size: 18 })} Configurações <small>${escapeHtml(subtitulo)}</small></p>`;
}

const selo = (n) => (n ? `<span class="cfg2-badge" aria-label="${n} pendência(s)">${n}</span>` : "");

function navegacao(atual) {
  return `<nav class="cfg2-nav" aria-label="Categorias de configurações"><ul role="list">${CATEGORIAS.map((c) => `
    <li><button type="button" class="cfg2-nav-item${c.id === atual ? " ativo" : ""}" data-cat="${c.id}"${c.id === atual ? ' aria-current="true"' : ""}>
      ${icon(c.icone, { size: 18 })}<span class="cfg2-nav-txt"><b>${escapeHtml(c.titulo)}</b><small>${escapeHtml(c.desc)}</small></span>
      ${c.id === "notificacoes" ? selo(pendenciasNotificacoes) : ""}${icon("arrow-right", { size: 14 })}</button></li>`).join("")}</ul></nav>`;
}

function abrirCategoria(catId, { foco = null, detalhe = true } = {}) {
  const view = el("#view");
  if (!view) return;
  const c = CATEGORIAS.find((x) => x.id === catId) ?? CATEGORIAS[0];
  try { sessionStorage.setItem(SS_CATEGORIA, c.id); } catch { /* conveniência */ }
  const secoes = foco ? [foco] : c.secoes;
  const caminho = foco
    ? `<button type="button" class="cfg2-trilha" id="cfg-ver-categoria">${escapeHtml(c.titulo)}</button> <span aria-hidden="true">›</span> ${escapeHtml(SECAO_TITULO[foco])}`
    : "";
  view.innerHTML = `
    ${cabecalho()}
    <div class="cfg2${detalhe ? " cfg2--detalhe" : ""}" data-cfg2>
      ${navegacao(c.id)}
      <div class="cfg2-conteudo">
        <div class="cfg-detalhe-head">
          <button type="button" class="btn btn-ghost btn-sm cfg2-voltar" id="cfg-voltar">${icon("arrow-left", { size: 14 })} Configurações</button>
          <h2 class="cfg-detalhe-titulo" tabindex="-1">${icon(c.icone, { size: 20 })} ${escapeHtml(c.titulo)}</h2>
          ${caminho ? `<p class="cfg2-caminho">${caminho}</p>` : ""}
        </div>
        <div class="cfg-detalhe" id="cfg-detalhe">${foco ? "" : secoes.map((s) => `
          <div class="cfg2-secao" id="cfg-secao-${s}"><h3 class="cfg2-secao-titulo">${escapeHtml(SECAO_TITULO[s])}</h3><div id="cfg-corpo-${s}"></div></div>`).join("")}</div>
      </div>
    </div>`;

  // Cada seção desenha no próprio contêiner (a deep-link usa o #cfg-detalhe inteiro).
  for (const s of secoes) {
    const corpo = foco ? el("#cfg-detalhe") : el(`#cfg-corpo-${s}`);
    if (corpo) DETALHES[s]?.(corpo);
  }
  ligarNavegacao(view, c.id);
  atualizarPendencias();
}

function ligarNavegacao(view, catId) {
  const raiz = view.querySelector("[data-cfg2]");
  if (!raiz) return;   // DOM mínimo (testes de unidade): só o conteúdo importa
  raiz.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => trocarCategoria(b.dataset.cat)));
  // Setas ↑/↓ percorrem a lista de categorias.
  raiz.querySelector(".cfg2-nav")?.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    const itens = [...raiz.querySelectorAll("[data-cat]")];
    const i = itens.indexOf(document.activeElement);
    if (i < 0) return;
    ev.preventDefault();
    itens[(i + (ev.key === "ArrowDown" ? 1 : itens.length - 1)) % itens.length].focus();
  });
  raiz.querySelector("#cfg-voltar")?.addEventListener("click", async () => {
    if (!(await podeSairDaCategoria())) return;
    raiz.classList.remove("cfg2--detalhe");
    raiz.querySelector(".cfg2-nav-item.ativo")?.focus();
  });
  raiz.querySelector("#cfg-ver-categoria")?.addEventListener("click", () => abrirCategoria(catId));
}

async function podeSairDaCategoria() {
  if (!el("#view")?.querySelector?.('[data-alterado="1"]')) return true;
  return confirmarDialogo({
    titulo: "Sair sem salvar?", texto: "Há alterações não salvas nesta categoria. Se sair agora, elas serão descartadas.",
    confirmar: "Sair sem salvar", perigo: true,
  });
}

async function trocarCategoria(catId) {
  if (!(await podeSairDaCategoria())) return;
  abrirCategoria(catId);
  el("#view")?.querySelector?.(".cfg-detalhe-titulo")?.focus?.();
}

// Selo de pendências na categoria Notificações (ex.: unidade sem destinatário do D-1). Conveniência: nunca derruba a tela.
async function atualizarPendencias() {
  if (!pode("notificacoes.ver")) return;
  try {
    const r = await carregarProtegido(notificacoesResumo);
    const n = r?.data?.pendencias?.length ?? 0;
    pendenciasNotificacoes = n;
    const item = el("#view")?.querySelector?.('[data-cat="notificacoes"]');
    if (!item) return;
    item.querySelector(".cfg2-badge")?.remove();
    if (n) item.querySelector(".cfg2-nav-txt")?.insertAdjacentHTML("afterend", selo(n));
  } catch { /* sem selo */ }
}

// ======================= 1. DADOS DA UNIDADE (real) =======================
const RE_UF = /^[A-Za-z]{2}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function cnpjValido(c) {
  const d = String(c).replace(/\D/g, "");
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const dv = (n) => {
    let soma = 0; let peso = n - 7;
    for (let i = 0; i < n; i++) { soma += Number(d[i]) * peso--; if (peso < 2) peso = 9; }
    const r = soma % 11; return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}

async function carregarDadosUnidade(root) {
  if (!temUnidade()) { root.innerHTML = avisoSemUnidade(); return; }
  root.innerHTML = estadoCarregando("Carregando dados da unidade…");
  try {
    const resp = await carregarProtegido(obterDadosUnidade);
    if (resp === null) return; // contexto mudou
    desenharDadosUnidade(root, resp.data);
  } catch (e) { root.innerHTML = estadoErro("Dados da Unidade", e); }
}

function desenharDadosUnidade(root, d) {
  const podeEditar = pode("configuracoes.gerenciar");
  const ro = podeEditar ? "" : "disabled";
  root.innerHTML = painel("Identificação da loja", `
    <div class="cfg-form-grid">
      ${campo("Nome da unidade", "u-nome", d.nome ?? "", { extra: `required maxlength="160" ${ro}` })}
      ${campo("CNPJ", "u-cnpj", d.cnpj ?? "", { ph: "00.000.000/0000-00", extra: `inputmode="numeric" ${ro}` })}
      ${campo("Endereço", "u-end", d.endereco ?? "", { ph: "Rua, nº — bairro, cidade", extra: ro })}
      ${campo("Cidade", "u-cidade", d.cidade ?? "", { extra: ro })}
      ${campo("Estado (UF)", "u-uf", d.estado ?? "", { ph: "ex.: MG", extra: `maxlength="2" ${ro}` })}
      ${campo("Responsável", "u-resp", d.responsavel ?? "", { extra: ro })}
      ${campo("E-mail da loja", "u-email", d.email ?? "", { tipo: "email", ph: "contato@sualoja.com.br", extra: ro })}
      ${campo("Telefone", "u-tel", d.telefone ?? "", { ph: "(00) 00000-0000", extra: `inputmode="tel" ${ro}` })}
      ${campoFixo("Status da unidade", d.status === "ativa" ? "Ativa" : "Inativa")}
    </div>
    <p class="cfg-meta">O status (ativar/desativar a unidade) é alterado apenas por um Administrador da plataforma.</p>
  `) + (podeEditar ? barraSalvar() : somenteLeitura());

  ligarFormulario(root, {
    aoDescartar: () => desenharDadosUnidade(root, d),
    aoSalvar: async () => {
      const nome = val(root, "u-nome").trim();
      if (!nome) throw erroCampo("u-nome", "Informe o nome da unidade.");
      const cnpj = val(root, "u-cnpj").trim();
      if (cnpj && !cnpjValido(cnpj)) throw erroCampo("u-cnpj", "CNPJ inválido — confira os dígitos.");
      const uf = val(root, "u-uf").trim();
      if (uf && !RE_UF.test(uf)) throw erroCampo("u-uf", "Use a sigla do estado com 2 letras.");
      const email = val(root, "u-email").trim();
      if (email && !RE_EMAIL.test(email)) throw erroCampo("u-email", "E-mail inválido.");
      const { data } = await atualizarDadosUnidade({
        nome, cnpj, endereco: val(root, "u-end"), cidade: val(root, "u-cidade"), estado: uf,
        responsavel: val(root, "u-resp"), email, telefone: val(root, "u-tel"),
      });
      d = data;
      // O nome pode ter mudado — avisa o shell para repintar topbar/seletor
      // (sem novo login). Manda a unidade já atualizada no detalhe.
      document.dispatchEvent(new CustomEvent("app:contexto-atualizado", {
        detail: { unidade: { id: data.id, nome: data.nome } },
      }));
    },
  });
}

// ======================= 2. FUSO E HORÁRIO (D-15) =======================
// O fuso da unidade passa a valer para o Dashboard Operacional E para o fechamento diário a partir da data de corte da
// plataforma (OPERACIONAL_FUSO_UNIDADE_CORTE). Antes do corte, nada muda; dias já calculados não são reprocessados.
const FUSOS_BR = [
  ["", "Padrão da plataforma (Brasília)"],
  ["America/Sao_Paulo", "Brasília — SP, RJ, MG, ES, Sul, GO, DF"],
  ["America/Bahia", "Bahia"],
  ["America/Fortaleza", "Fortaleza — CE, RN, PB, PI, MA"],
  ["America/Recife", "Recife — PE"],
  ["America/Maceio", "Maceió — AL, SE"],
  ["America/Belem", "Belém — PA (leste), AP"],
  ["America/Santarem", "Santarém — PA (oeste)"],
  ["America/Araguaina", "Tocantins"],
  ["America/Cuiaba", "Cuiabá — MT"],
  ["America/Campo_Grande", "Campo Grande — MS"],
  ["America/Porto_Velho", "Porto Velho — RO"],
  ["America/Manaus", "Manaus — AM"],
  ["America/Boa_Vista", "Boa Vista — RR"],
  ["America/Rio_Branco", "Rio Branco — AC"],
  ["America/Noronha", "Fernando de Noronha"],
];
const DIAS = [["seg", "Segunda"], ["ter", "Terça"], ["qua", "Quarta"], ["qui", "Quinta"], ["sex", "Sexta"], ["sab", "Sábado"], ["dom", "Domingo"]];

async function carregarFuso(root) {
  if (!temUnidade()) { root.innerHTML = avisoSemUnidade(); return; }
  root.innerHTML = estadoCarregando("Carregando fuso e horário…");
  try {
    const resp = await carregarProtegido(obterDadosUnidade);
    if (resp === null) return;
    desenharFuso(root, resp.data);
  } catch (e) { root.innerHTML = estadoErro("Fuso e horário", e); }
}

function desenharFuso(root, d) {
  if (d.fusoDisponivel === false) {
    root.innerHTML = painel("Fuso e horário de funcionamento", `<div class="estado-mini">Ainda não disponível neste ambiente.</div>`);
    return;
  }
  const podeEditar = pode("configuracoes.gerenciar");
  const ro = podeEditar ? "" : "disabled";
  const h = d.horarioFuncionamento ?? {};
  const corte = d.fusoCorte
    ? `Vale para o Dashboard Operacional e os fechamentos a partir de <b>${escapeHtml(d.fusoCorte.split("-").reverse().join("/"))}</b>. Dias anteriores continuam como foram calculados.`
    : "O uso do fuso por unidade ainda não foi ligado pela plataforma: até lá, Dashboard e fechamentos usam o fuso padrão. Você já pode deixá-lo configurado.";
  root.innerHTML = painel("Fuso horário", `
    <div class="cfg-form-grid">${select("Fuso da unidade", "u-fuso", FUSOS_BR, d.timezone ?? "", ro)}</div>
    <p class="cfg-meta">${corte} O Checklist ao vivo não muda.</p>`)
    + painel("Horário de funcionamento", `
    <fieldset class="cfg-horario" ${ro}>
      <legend class="sr-only">Dias e horários</legend>
      ${DIAS.map(([k, rot]) => {
        const f = (h[k] ?? [])[0];
        return `<div class="cfg-horario-dia">
          <label class="cfg-check"><input type="checkbox" data-aberto="${k}" ${f ? "checked" : ""}/> <b>${rot}</b></label>
          <label class="cfg-campo-inline">de <input type="time" data-inicio="${k}" value="${escapeHtml(f?.inicio ?? "")}" aria-label="${rot}: abre às" ${f ? "" : "disabled"}/></label>
          <label class="cfg-campo-inline">até <input type="time" data-fim="${k}" value="${escapeHtml(f?.fim ?? "")}" aria-label="${rot}: fecha às" ${f ? "" : "disabled"}/></label>
        </div>`;
      }).join("")}
      <small class="cfg-erro" id="u-horario-erro" role="alert"></small>
    </fieldset>`, "Informativo nesta versão: registra quando a loja abre. Fechar depois da meia-noite é aceito (ex.: 18:00 até 01:00).")
    + (podeEditar ? barraSalvar() : somenteLeitura());

  root.querySelectorAll("[data-aberto]").forEach((c) => c.addEventListener("change", () => {
    for (const s of ["inicio", "fim"]) root.querySelector(`[data-${s}="${c.dataset.aberto}"]`).disabled = !c.checked;
  }));
  ligarFormulario(root, {
    aoDescartar: () => desenharFuso(root, d),
    aoSalvar: async () => {
      const horario = {};
      for (const [k, rot] of DIAS) {
        if (!root.querySelector(`[data-aberto="${k}"]`).checked) { horario[k] = []; continue; }
        const inicio = root.querySelector(`[data-inicio="${k}"]`).value;
        const fim = root.querySelector(`[data-fim="${k}"]`).value;
        if (!inicio || !fim || inicio === fim) throw erroCampo("u-horario", `${rot}: informe a abertura e o fechamento (diferentes).`);
        horario[k] = [{ inicio, fim }];
      }
      const { data } = await atualizarDadosUnidade({ timezone: val(root, "u-fuso") || null, horarioFuncionamento: horario });
      d = data;
    },
  });
}

// ======================= 3. METAS E LIMITES DE CMV (real) =======================
async function carregarMetasCmv(root) {
  if (!temUnidade()) { root.innerHTML = avisoSemUnidade(); return; }
  root.innerHTML = estadoCarregando("Carregando metas…");
  try {
    const resp = await carregarProtegido(obterMetasCmvUnidade);
    if (resp === null) return;
    desenharMetasCmv(root, resp.data);
  } catch (e) { root.innerHTML = estadoErro("Metas e Limites de CMV", e); }
}

function desenharMetasCmv(root, m) {
  const podeEditar = pode("configuracoes.gerenciar");
  const ro = podeEditar ? "" : "disabled";
  const origem = m.persistido
    ? "Valores configurados para esta unidade."
    : "Ainda usando os valores padrão do sistema — ao salvar, eles passam a valer só para esta unidade.";
  root.innerHTML = painel("Faixas de CMV (%)", `
    <div class="cfg-form-grid">
      ${campo("CMV saudável (até)", "c-sau", m.cmvSaudavel ?? "", { tipo: "number", extra: `min="0" max="100" step="0.5" inputmode="decimal" ${ro}` })}
      ${campo("CMV de atenção (até)", "c-ate", m.cmvAtencao ?? "", { tipo: "number", extra: `min="0" max="100" step="0.5" inputmode="decimal" ${ro}` })}
    </div>
    <p class="cfg-meta">Classificam cada produto como saudável, atenção ou crítico. Acima do limite de atenção = crítico.</p>`, origem)
    + painel("Metas da operação", `
    <div class="cfg-form-grid">
      ${campo("Meta de faturamento diário (R$)", "c-fatd", m.metaFatDia ?? "", { tipo: "number", extra: `min="0" step="1" inputmode="decimal" ${ro}` })}
      ${campo("Meta de faturamento mensal (R$)", "c-fatm", m.metaFatMes ?? "", { tipo: "number", extra: `min="0" step="1" inputmode="decimal" ${ro}` })}
      ${campo("Margem mínima desejada (%)", "c-mar", m.margemMinima ?? "", { tipo: "number", extra: `min="0" max="100" step="0.5" inputmode="decimal" ${ro}` })}
    </div>`)
    + (podeEditar ? barraSalvar() : somenteLeitura());

  const num = (id) => { const s = val(root, id).trim(); return s === "" ? null : Number(s); };
  const pct = (id, rotulo) => {
    const v = num(id);
    if (v != null && (!Number.isFinite(v) || v < 0 || v > 100)) throw erroCampo(id, `${rotulo}: use um percentual entre 0 e 100.`);
    return v;
  };
  const reais = (id) => {
    const v = num(id);
    if (v != null && (!Number.isFinite(v) || v < 0)) throw erroCampo(id, "Use um valor igual ou maior que zero.");
    return v;
  };
  ligarFormulario(root, {
    aoDescartar: () => desenharMetasCmv(root, m),
    aoSalvar: async () => {
      const sau = pct("c-sau", "CMV saudável");
      const ate = pct("c-ate", "CMV de atenção");
      if (sau != null && ate != null && ate < sau) throw erroCampo("c-ate", "O limite de atenção deve ser maior ou igual ao saudável.");
      const { data } = await salvarMetasCmvUnidade({
        cmvSaudavel: sau, cmvAtencao: ate,
        metaFatDia: reais("c-fatd"), metaFatMes: reais("c-fatm"), margemMinima: pct("c-mar", "Margem mínima"),
      });
      // Reflete na hora na classificação de produto (Dashboard/Produtos-CMV)
      // sem esperar a próxima entrada na unidade.
      definirLimitesCmv(data);
      m = data;
    },
  });
}

// ======================= 4. TABELAS COMERCIAIS (real) =======================
const CANAL_LABEL_TC = { balcao: "Balcão", ifood: "iFood" };

async function carregarTabelasComerciais(root) {
  if (!temUnidade()) { root.innerHTML = avisoSemUnidade(); return; }
  root.innerHTML = estadoCarregando("Carregando tabelas comerciais…");
  try {
    const resp = await carregarProtegido(obterTabelasComerciaisUnidade);
    if (resp === null) return;
    desenharTabelasComerciais(root, resp.data);
  } catch (e) { root.innerHTML = estadoErro("Tabelas Comerciais", e); }
}

function linhaTabelaComercial(canalKey, tabelaAtual) {
  const podeAlterar = pode("configuracoes.gerenciar");
  return `
    <div class="cfg-user cfg-tabela-linha">
      <div class="cfg-user-info">
        <b>${CANAL_LABEL_TC[canalKey]}</b>
        <small>${tabelaAtual ? `Tabela atual: ${escapeHtml(tabelaAtual)}` : "Não configurada"}</small>
      </div>
      ${tabelaAtual
        ? `<span class="pill ok">Tabela atual: ${escapeHtml(tabelaAtual)}</span>`
        : `<span class="pill warn">Precisa configurar</span>`}
      ${podeAlterar ? `<button type="button" class="btn btn-ghost btn-sm" data-alterar-canal="${canalKey}">Alterar</button>` : ""}
    </div>`;
}

function desenharTabelasComerciais(root, data) {
  root.innerHTML = painel(
    "Tabelas comerciais da unidade",
    `<p class="cfg-tabela-explicacao">
      Define qual preço/CMV o Dashboard e Produtos/CMV usam por padrão para esta unidade. Trocar aqui muda a
      configuração real, para todo mundo, imediatamente. Só para <b>comparar</b> outra tabela sem alterar nada,
      use o seletor no topo do Dashboard/Produtos-CMV ("Comparar: X") — isso nunca grava aqui.
    </p>`
    + linhaTabelaComercial("balcao", data.tabelaBalcao)
    + linhaTabelaComercial("ifood", data.tabelaIfood)
    + (pode("configuracoes.gerenciar") ? "" : somenteLeitura()),
  );
  root.querySelectorAll("[data-alterar-canal]").forEach((b) =>
    b.addEventListener("click", () => abrirAlteracaoTabelaComercial(root, b.dataset.alterarCanal, data)));
}

function abrirAlteracaoTabelaComercial(root, canalKey, dadosAtuais) {
  const tabelaAtual = canalKey === "ifood" ? dadosAtuais.tabelaIfood : dadosAtuais.tabelaBalcao;
  // Opções = catálogo REAL da empresa (o que ela tem preço cadastrado), nunca
  // uma lista global. A tabela atual entra na lista mesmo se não estiver no
  // catálogo (ex.: preço removido depois) pra não sumir do seletor.
  const catalogo = dadosAtuais.catalogo?.[canalKey] ?? [];
  const opcoes = [...new Set([...catalogo, ...(tabelaAtual ? [tabelaAtual] : [])])]
    .sort((a, b) => String(a).localeCompare(String(b), "pt-BR"));

  if (!opcoes.length) {
    root.innerHTML = painel(`Alterar tabela — ${CANAL_LABEL_TC[canalKey]}`,
      `<div class="estado-mini">Esta empresa ainda não tem nenhuma tabela de preço de ${CANAL_LABEL_TC[canalKey]} cadastrada em Produtos/CMV. Cadastre os preços primeiro — as tabelas aparecem aqui automaticamente.</div>`)
      + `<div class="cfg-acoes"><button type="button" class="btn btn-ghost" id="tc-cancelar">Voltar</button></div>`;
    root.querySelector("#tc-cancelar").addEventListener("click", () => carregarTabelasComerciais(root));
    return;
  }

  root.innerHTML = painel(`Alterar tabela — ${CANAL_LABEL_TC[canalKey]}`, `
    <div class="cfg-form-grid">
      ${campoFixo("Canal", CANAL_LABEL_TC[canalKey])}
      ${campoFixo("Tabela atual", tabelaAtual ? tabelaAtual : "não configurada")}
      ${select("Nova tabela", "tc-nova", opcoes, tabelaAtual ?? opcoes[0] ?? "")}
      ${campo("Motivo (opcional)", "tc-motivo", "", { ph: "ex.: renegociação com a marca" })}
    </div>
    <p class="cfg-aviso-alteracao">${icon("alert-triangle", { size: 14 })} Essa alteração modifica a tabela OFICIAL da unidade — Dashboard e Produtos/CMV passam a usar a nova tabela por padrão, para todo mundo, imediatamente. Fica registrada com seu usuário e horário.</p>
  `) + `
    <div class="cfg-acoes">
      <button type="button" class="btn btn-ghost" id="tc-cancelar">Cancelar</button>
      <button type="button" class="btn btn-primary" id="tc-confirmar">Confirmar alteração</button>
    </div>`;

  root.querySelector("#tc-cancelar").addEventListener("click", () => carregarTabelasComerciais(root));
  root.querySelector("#tc-confirmar").addEventListener("click", async () => {
    const novaTabela = val(root, "tc-nova");
    const motivo = val(root, "tc-motivo");
    const btn = root.querySelector("#tc-confirmar");
    btn.disabled = true;
    try {
      await alterarTabelaComercialUnidade({ canal: canalKey, novaTabela, motivo });
      toast(`Tabela ${CANAL_LABEL_TC[canalKey]} alterada para ${novaTabela}.`);
      carregarTabelasComerciais(root);
    } catch (e) {
      toast("Erro ao alterar: " + e.message);
      btn.disabled = false;
    }
  });
}

// ======================= 5. ATALHOS (configurações que vivem nos módulos) =======================
// Só atalhos: a tela continua no módulo (sem duplicar). A navegação é pedida ao shell por evento (app.js → irPara).
const ATALHOS = [
  { rota: "checklist-operacional", icone: "activity", titulo: "Metas do Checklist Operacional", desc: "Metas de preparo, entrega e vida do pedido.", modulo: "checklist_operacional" },
  { rota: "dashboard-executivo", icone: "trending-up", titulo: "Dashboard iFood", desc: "Modelo logístico e metas de rentabilidade.", modulo: "ifood_dashboard" },
  { rota: "bonificacao-mensal", icone: "award", titulo: "Bonificação Mensal", desc: "Metas e faixas da régua mensal.", modulo: null },
  { rota: "ifood", icone: "truck", titulo: "Conexão iFood", desc: "Lojas conectadas e autorização.", modulo: null },
];
function desenharAtalhos(root) {
  root.innerHTML = painel("Configurações dos módulos", `<ul class="cfg-atalhos" role="list">${ATALHOS.map((a) => `
      <li><button type="button" class="cfg-atalho" data-rota="${a.rota}">${icon(a.icone, { size: 18 })}
        <span><b>${escapeHtml(a.titulo)}</b><small>${escapeHtml(a.desc)}</small></span>${icon("arrow-right", { size: 14 })}</button></li>`).join("")}</ul>`,
  "Essas configurações ficam no próprio módulo — aqui é o atalho.");
  root.querySelectorAll("[data-rota]").forEach((b) => b.addEventListener("click", () =>
    document.dispatchEvent(new CustomEvent("app:navegar", { detail: { rota: b.dataset.rota } }))));
}

// ======================= 6. USUÁRIOS E ACESSO (D-14) =======================
// Supabase Auth via backend, escopo por req.tenant.organizacaoId. O cargo
// pertence ao vínculo usuário<->empresa. "Conceder acesso": conta existente =
// vínculo na hora; conta nova = convite por e-mail (72 h, uso único) e a
// PRÓPRIA pessoa define a senha. Ninguém escolhe senha por outra pessoa.
function montarUsuarios(root) {
  const gerencia = pode("usuarios.gerenciar");
  root.innerHTML = estadoCarregando("Carregando usuários…");
  carregar();

  async function carregar() {
    try {
      const [resp, conv] = await Promise.all([
        carregarProtegido(obterUsuarios),
        gerencia ? carregarProtegido(listarConvitesUsuario).catch(() => null) : null,
      ]);
      if (resp === null) return;
      desenhar(resp.data || [], conv?.data ?? []);
    } catch (e) {
      root.innerHTML = painel("Usuários e Permissões",
        `<div class="estado-mini">Não foi possível carregar os usuários: ${escapeHtml(e.message)}<br>Apenas quem gerencia usuários da empresa tem acesso a esta seção.</div>`);
    }
  }

  function linhaUsuario(u) {
    const label = PAPEL_LABEL[u.papel] || u.papel || "—";
    const nome = u.nome || u.email || "—";
    // gerenciavelAqui = tem vínculo de EMPRESA (o <select> e o remover desta tela
    // mexem só nisso). Quem entra só por unidade aparece, mas read-only.
    const soUnidade = u.gerenciavelAqui === false;
    const unidadesTxt = (u.unidades || [])
      .map((x) => `${x.unidadeNome}${x.papel ? ` (${PAPEL_LABEL[x.papel] || x.papel})` : " (herda)"}`)
      .join(", ");
    const origemBadge = soUnidade
      ? `<span class="pill warn" title="${escapeHtml(unidadesTxt)}">Só por unidade</span>`
      : (u.origem === "empresa+unidade"
        ? `<span class="pill" title="${escapeHtml(unidadesTxt)}">Empresa + unidade</span>` : "");
    const selCargo = soUnidade
      ? `<span class="cfg-user-perfil-ro">${escapeHtml(unidadesTxt || "acesso por unidade")}</span>`
      : (gerencia
        ? `<select class="cfg-user-perfil" data-id="${escapeHtml(u.id)}" aria-label="Cargo de ${escapeHtml(nome)}">${PERFIS.map((p) => `<option ${p === label ? "selected" : ""}>${p}</option>`).join("")}</select>`
        : `<span class="cfg-user-perfil-ro">${escapeHtml(label)}</span>`);
    const remover = !gerencia ? "" : (soUnidade
      ? `<span class="cfg-user-del cfg-user-del--off" title="Gerenciado pelo Administrador da plataforma (vínculo de unidade)">${icon("lock", { size: 14 })}</span>`
      : `<button type="button" class="cfg-user-del" data-del="${escapeHtml(u.id)}" title="Remover acesso" aria-label="Remover acesso de ${escapeHtml(nome)}">${icon("trash", { size: 14 })}</button>`);
    return `
      <div class="cfg-user" data-id="${escapeHtml(u.id)}">
        <span class="cfg-user-av" aria-hidden="true">${escapeHtml((nome[0] || "?").toUpperCase())}</span>
        <div class="cfg-user-info"><b>${escapeHtml(nome)}</b><small>${escapeHtml(u.email || "")}</small></div>
        ${origemBadge}
        ${selCargo}
        <span class="pill ${u.ativo ? "ok" : "muted"}">${u.ativo ? "Ativo" : "Inativo"}</span>
        ${remover}
      </div>`;
  }

  const rotuloEnvio = (c) => (c.expirado ? ["muted", "Expirado"]
    : c.envio === "ENVIADO" ? ["ok", "E-mail enviado"]
      : c.envio === "FALHOU" ? ["bad", "Falha no envio"] : ["warn", "Envio de e-mail desativado"]);

  function desenhar(lista, convites) {
    const convitesHtml = convites.length
      ? `<div class="cfg-users">${convites.map((c) => {
        const [tom, txt] = rotuloEnvio(c);
        return `<div class="cfg-user">
            <span class="cfg-user-av" aria-hidden="true">${icon("mail-open", { size: 14 })}</span>
            <div class="cfg-user-info"><b>${escapeHtml(c.nome || c.emailMascarado)}</b><small>${escapeHtml(c.emailMascarado)} · ${escapeHtml(PAPEL_LABEL[c.papel] || c.papel)}</small></div>
            <span class="pill ${tom}">${txt}</span>
            <button type="button" class="btn btn-ghost btn-sm" data-revogar="${escapeHtml(c.id)}">Cancelar convite</button>
          </div>`;
      }).join("")}</div>`
      : `<div class="estado-mini">Nenhum convite pendente.</div>`;

    root.innerHTML = painel("Equipe desta empresa", `
        <div class="cfg-users">
          ${lista.length ? lista.map(linhaUsuario).join("") : `<div class="estado-mini">Nenhum usuário com acesso a esta empresa ainda.</div>`}
        </div>
        <div class="cfg-legenda">Cargos: ${PERFIS.map((p) => `<span class="cfg-chip">${p}</span>`).join("")}</div>
      `, "O cargo vale apenas nesta empresa. O mesmo usuário pode ter outro cargo em outra unidade do grupo.")
      + (gerencia
        ? painel("Conceder acesso a esta empresa", `
          <div class="cfg-form-grid">
            ${campo("Nome", "nu-nome", "", { extra: 'maxlength="160" autocomplete="off"' })}
            ${campo("E-mail", "nu-email", "", { tipo: "email", ph: "nome@empresa.com", extra: 'required autocomplete="off"' })}
            ${select("Cargo", "nu-perfil", PERFIS, "Operação")}
          </div>
          <div class="cfg-acoes cfg-acoes--start"><button type="button" class="btn btn-primary" id="nu-add">${icon("send", { size: 14 })} Conceder acesso</button></div>
        `, "Se o e-mail já tiver conta na plataforma, o acesso é concedido na hora (a senha dela não muda). Se não tiver, criamos um convite por e-mail válido por 72 horas: a própria pessoa define a senha.")
          + painel("Convites pendentes", convitesHtml)
        : somenteLeitura());

    if (!gerencia) return;
    root.querySelector("#nu-add")?.addEventListener("click", criar);
    root.querySelectorAll("button.cfg-user-del[data-del]").forEach((b) => b.addEventListener("click", () => excluir(b.dataset.del, lista)));
    root.querySelectorAll("select.cfg-user-perfil").forEach((s) => s.addEventListener("change", () => trocarPerfil(s.dataset.id, PAPEL_ENUM[s.value])));
    root.querySelectorAll("[data-revogar]").forEach((b) => b.addEventListener("click", () => revogar(b.dataset.revogar)));
  }

  async function criar() {
    const erro = root.querySelector("#nu-email-erro");
    if (erro) erro.textContent = "";
    const nome = val(root, "nu-nome").trim();
    const email = val(root, "nu-email").trim();
    const papel = PAPEL_ENUM[val(root, "nu-perfil")];
    if (!RE_EMAIL.test(email)) {
      if (erro) erro.textContent = "Informe um e-mail válido.";
      root.querySelector("#nu-email")?.focus();
      return;
    }
    const btn = root.querySelector("#nu-add");
    btn.disabled = true;
    try {
      const { data } = await criarUsuario({ nome, email, papel });
      toast(data?.tipo === "CONVITE_CRIADO"
        ? (data.convite?.envio === "ENVIADO" ? "Convite enviado por e-mail." : "Convite criado. O envio de e-mail ainda está desativado neste ambiente.")
        : "Acesso concedido — o usuário já pode entrar nesta empresa.");
      carregar();
    } catch (e) {
      toast("Erro: " + e.message);
      btn.disabled = false;
    }
  }

  async function revogar(id) {
    if (!(await confirmarDialogo({ titulo: "Cancelar convite?", texto: "O link do convite deixa de funcionar na hora.", confirmar: "Cancelar convite", perigo: true }))) return;
    try { await revogarConviteUsuario(id); toast("Convite cancelado."); carregar(); }
    catch (e) { toast("Erro: " + e.message); }
  }

  async function excluir(id, lista) {
    const u = (lista || []).find((x) => x.id === id);
    const quem = u?.nome || u?.email || "este usuário";
    const ok = await confirmarDialogo({
      titulo: "Remover acesso a esta empresa?",
      texto: `${quem} perde o acesso a esta empresa agora. A conta continua existindo e mantém o acesso às outras empresas em que estiver vinculada.`,
      confirmar: "Remover acesso", perigo: true,
    });
    if (!ok) return;
    try { await excluirUsuario(id); toast("Acesso removido desta empresa."); carregar(); }
    catch (e) { toast("Erro: " + e.message); }
  }

  async function trocarPerfil(id, papel) {
    try { await atualizarUsuario(id, { papel }); toast("Cargo atualizado."); }
    catch (e) { toast("Erro: " + e.message); carregar(); }
  }
}

// ======================= 7. INTEGRAÇÕES =======================
async function carregarIntegracoes(root) {
  root.innerHTML = estadoCarregando("Carregando integrações…");
  try {
    const resp = await carregarProtegido(obterCatalogoIntegracoes);
    if (resp === null) return;
    const lista = Array.isArray(resp.data) ? resp.data : (resp.data?.integracoes ?? []);
    root.innerHTML = painel("Serviços conectados", lista.length
      ? `<ul class="cfg-integracoes" role="list">${lista.map((i) => {
        const ativo = i.conectado === true || i.status === "conectado" || i.status === "ativo";
        return `<li class="cfg-integracao"><span><b>${escapeHtml(i.nome ?? i.id ?? "Integração")}</b>${i.descricao ? `<small>${escapeHtml(i.descricao)}</small>` : ""}</span>
          <span class="pill ${ativo ? "ok" : "muted"}">${escapeHtml(i.statusRotulo ?? (ativo ? "Conectado" : (i.status ?? "Não conectado")))}</span></li>`;
      }).join("")}</ul>`
      : `<div class="estado-mini">Nenhuma integração disponível para esta empresa.</div>`,
    "Para conectar ou ajustar, abra a página da integração no menu Integrações.");
  } catch {
    root.innerHTML = painel("Serviços conectados", `<div class="estado-mini">Você não tem acesso ao estado das integrações.</div>`);
  }
}

// ======================= 8. SEGURANÇA E PRIVACIDADE =======================
// Proteções da plataforma + a PRÓPRIA conta: troca de senha e 2º fator (MFA,
// via Supabase Auth — ver mfa.js). Não há TOTP próprio.
function montarSeguranca(root) {
  root.innerHTML = painel("Proteções de acesso (aplicadas pela plataforma)", `
      <ul class="cfg-lista-check">
        <li>${icon("check-circle", { size: 14 })} <b>Senha mínima de 8 caracteres</b> — exigida na criação e na redefinição de qualquer conta.</li>
        <li>${icon("check-circle", { size: 14 })} <b>Novos acessos por convite</b> — a própria pessoa define a senha; ninguém escolhe senha por outra pessoa.</li>
        <li>${icon("check-circle", { size: 14 })} <b>Troca de senha no primeiro acesso</b> — contas antigas com senha provisória só operam o sistema depois de definir uma senha própria.</li>
        <li>${icon("check-circle", { size: 14 })} <b>Sessão com expiração e revogação imediata</b> — trocar o cargo ou remover o acesso encerra as sessões abertas daquele usuário nesta empresa na hora.</li>
        <li>${icon("check-circle", { size: 14 })} <b>Registro de acessos e ações</b> — logins e operações sensíveis ficam na auditoria da plataforma (imutável).</li>
        <li>${icon("check-circle", { size: 14 })} <b>Isolamento por empresa/unidade</b> — cada requisição é validada contra o contexto assinado; uma empresa nunca lê dado de outra.</li>
        <li>${icon("check-circle", { size: 14 })} <b>Limites de uso</b> — tentativas de PIN, códigos de verificação, importações e o Agente Crescer têm freios contra abuso.</li>
      </ul>
    `, "Estas proteções estão sempre ativas e não são desligáveis pela loja.")
    + painel("Minha senha", `
      <div class="cfg-form-grid">
        ${campo("Nova senha", "ms-senha", "", { tipo: "password", extra: 'autocomplete="new-password" minlength="8"', ajuda: "Mínimo de 8 caracteres." })}
        ${campo("Repita a nova senha", "ms-senha2", "", { tipo: "password", extra: 'autocomplete="new-password"' })}
      </div>
      <div class="cfg-acoes cfg-acoes--start"><button type="button" class="btn btn-primary" id="ms-salvar">Trocar minha senha</button></div>`,
    "Vale para o seu login em todas as empresas.");

  root.querySelector("#ms-salvar")?.addEventListener("click", async () => {
    for (const e of root.querySelectorAll(".cfg-erro")) e.textContent = "";
    const s1 = val(root, "ms-senha");
    const s2 = val(root, "ms-senha2");
    if (s1.length < 8) { root.querySelector("#ms-senha-erro").textContent = "A senha precisa de ao menos 8 caracteres."; return; }
    if (s1 !== s2) { root.querySelector("#ms-senha2-erro").textContent = "As senhas não conferem."; return; }
    const btn = root.querySelector("#ms-salvar");
    btn.disabled = true;
    try {
      await definirNovaSenha(s1);
      root.querySelector("#ms-senha").value = "";
      root.querySelector("#ms-senha2").value = "";
      toast("Senha trocada.");
    } catch (e) { toast("Erro: " + e.message); }
    finally { btn.disabled = false; }
  });
  const mfaBox = document.createElement("div");
  root.appendChild?.(mfaBox);
  montarMfa(mfaBox);
}

function montarPrivacidade(root) {
  root.innerHTML = painel("Como a plataforma trata dados pessoais", `
    <ul class="cfg-lista-check">
      <li>${icon("info", { size: 14 })} <b>Avisos por WhatsApp</b> — quem recebe, com que autorização e desde quando fica em <b>Notificações</b>. Quem recebe pode sair a qualquer momento pela página de gestão das inscrições.</li>
      <li>${icon("info", { size: 14 })} <b>Números de telefone e e-mails de convite</b> — aparecem mascarados nas telas; os novos ficam cifrados no banco.</li>
      <li>${icon("info", { size: 14 })} <b>Dados de clientes do iFood</b> — o Dashboard Operacional não mostra dados pessoais de clientes. A política de retenção e anonimização está em definição e ainda não é executada.</li>
    </ul>`);
}

// ======================= 9. PREFERÊNCIAS =======================
// Aparência — preferência do dispositivo/usuário (localStorage).
function montarAparencia(root) {
  const desenhar = () => {
    const atual = temaAtual();
    root.innerHTML = painel("Tema desta conta neste dispositivo", `
      <div class="cfg-tema-grid" role="radiogroup" aria-label="Tema">
        <button type="button" role="radio" aria-checked="${atual === "light"}" class="cfg-tema-op ${atual === "light" ? "ativo" : ""}" data-tema="light">
          <span class="cfg-tema-prev cfg-tema-prev--light"><i></i><i></i><i></i></span>
          <b>Claro</b>
        </button>
        <button type="button" role="radio" aria-checked="${atual === "dark"}" class="cfg-tema-op ${atual === "dark" ? "ativo" : ""}" data-tema="dark">
          <span class="cfg-tema-prev cfg-tema-prev--dark"><i></i><i></i><i></i></span>
          <b>Escuro</b>
        </button>
      </div>
      <div class="cfg-meta">${icon("lock", { size: 12 })} Esta escolha é <b>individual</b>: fica salva só neste navegador/dispositivo e não muda o tema dos outros usuários.</div>
    `);
    root.querySelectorAll(".cfg-tema-op").forEach((b) => b.addEventListener("click", () => {
      definirTema(b.dataset.tema);
      toast(`Tema ${b.dataset.tema === "dark" ? "escuro" : "claro"} aplicado neste dispositivo.`);
      desenhar();
    }));
  };
  desenhar();
}

// Exportação HONESTA: só o que está no navegador. Backup real dos dados do
// tenant é do backend, não desta tela.
function montarBackup(root) {
  const empresa = nomeEmpresa();
  const unidade = nomeUnidade() ?? "todas-as-unidades";
  root.innerHTML = painel("Configurações locais deste navegador", `
    <p class="cfg-meta">
      Estas ações só afetam o que está salvo <b>neste navegador</b> (hoje: o tema). Não exportam nem apagam
      nada do banco de dados — os dados da empresa ${escapeHtml(empresa)} ficam sempre no servidor.
    </p>
    <div class="cfg-botoes">
      <button type="button" class="btn btn-ghost" id="b-export">${icon("upload", { size: 14 })} Exportar configurações locais (JSON)</button>
      <button type="button" class="btn btn-ghost cfg-btn-perigo" id="b-limpar">${icon("trash", { size: 14 })} Limpar configurações locais</button>
    </div>`);

  root.querySelector("#b-export")?.addEventListener("click", () => {
    const dump = {
      exportadoEm: new Date().toISOString(),
      empresa, unidade,
      local: { tema: temaAtual() },
    };
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${slug(empresa)}-${slug(unidade)}-config-local-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    toast("Exportação local gerada.");
  });
  root.querySelector("#b-limpar")?.addEventListener("click", async () => {
    const ok = await confirmarDialogo({
      titulo: "Limpar configurações locais?", texto: "O tema deste dispositivo volta ao padrão. Nada do servidor é apagado.", confirmar: "Limpar",
    });
    if (!ok) return;
    localStorage.removeItem(LS_TEMA);
    localStorage.removeItem(LS_TEMA_LEGADO);
    aplicarTemaSalvo();
    toast("Configurações locais limpas.");
    montarBackup(root);
  });
}

// ======================= DETALHES DE CADA SEÇÃO =======================
const DETALHES = {
  unidade: (root) => carregarDadosUnidade(root),
  fuso: (root) => carregarFuso(root),
  cmv: (root) => carregarMetasCmv(root),
  precos: (root) => carregarTabelasComerciais(root),
  atalhos: (root) => desenharAtalhos(root),
  notificacoes: (root) => montarCentralNotificacoes(root, { confirmarDialogo, carregarProtegido }),
  usuarios: (root) => montarUsuarios(root),
  integracoes: (root) => carregarIntegracoes(root),
  seguranca: (root) => montarSeguranca(root),
  privacidade: (root) => montarPrivacidade(root),
  aparencia: (root) => montarAparencia(root),
  backup: (root) => montarBackup(root),
};

// ======================= MFA (2º fator) — via Supabase Auth =======================
// Cadastro/remoção do 2º fator da PRÓPRIA conta. O enroll/challenge/verify é
// 100% Supabase (mfa.js). O backend só é avisado para auditar (estado real).
// O enforcement (MFA_ENFORCE_*) continua desligado — aqui é só a EXPERIÊNCIA.
async function montarMfa(box) {
  box.className = "cfg-panel";
  box.innerHTML = `<div class="cfg-panel-head"><h3>Verificação em duas etapas (2FA)</h3>
    <p>Um código do seu app autenticador, além da senha. Recomendado para todas as contas — obrigatório quando a plataforma ativar a exigência.</p></div>
    <div class="cfg-panel-body" id="mfa-corpo"><div class="estado-mini">Carregando…</div></div>`;
  const corpo = box.querySelector("#mfa-corpo");
  if (!corpo) return;

  const usuario = state.sessao?.usuario ?? {};
  const privilegiado = !!(usuario.superadmin || usuario.painelAdministrativo);

  const desenhar = async () => {
    let st;
    try { st = await estadoMfa(); }
    catch (e) { corpo.innerHTML = `<div class="estado-mini bad">Não foi possível carregar o estado do 2FA: ${escapeHtml(e.message)}</div>`; return; }

    if (st.estado === "aal2" || st.estado === "aal1_com_fator") {
      const nota = st.estado === "aal1_com_fator"
        ? `<p class="cfg-meta">Esta sessão está autenticada só com a senha. Ao acessar áreas que exijam 2FA, o código será solicitado.</p>` : "";
      corpo.innerHTML = `
        <ul class="cfg-lista-check"><li>${icon("shield-check", { size: 14 })} <b>2FA ativo</b> nesta conta (${st.fatores.filter((f) => f.status === "verified").length} autenticador(es)).</li></ul>
        ${nota}
        <div class="cfg-acoes"><button type="button" class="btn btn-ghost btn-sm" id="mfa-remover">Remover 2FA</button></div>`;
      corpo.querySelector("#mfa-remover")?.addEventListener("click", async () => {
        const ok = await confirmarDialogo({
          titulo: "Remover a verificação em duas etapas?",
          texto: "Sem o 2º fator a conta fica só com a senha. Se a plataforma exigir 2FA, você precisará cadastrar de novo antes de acessar áreas protegidas.",
          confirmar: "Remover 2FA", perigo: true,
        });
        if (!ok) return;
        try {
          for (const f of st.fatores) await removerFator(f.id);
          toast("2FA removido desta conta.");
          desenhar();
        } catch (e) { toast("Erro ao remover: " + e.message); }
      });
      return;
    }

    // sem_fator
    const aviso = privilegiado
      ? `<div class="estado-mini warn">${icon("alert-triangle", { size: 14 })} Sua conta tem acesso administrativo. <b>Ative o 2FA</b> — quando a exigência for ligada, o acesso administrativo fica bloqueado sem ele.</div>` : "";
    corpo.innerHTML = `${aviso}
      <p>Você ainda não tem um 2º fator cadastrado.</p>
      <div class="cfg-acoes"><button type="button" class="btn btn-primary" id="mfa-ativar">Ativar verificação em duas etapas</button></div>`;
    corpo.querySelector("#mfa-ativar")?.addEventListener("click", () => fluxoCadastro(corpo, desenhar));
  };

  await desenhar();
}

async function fluxoCadastro(corpo, aoConcluir) {
  corpo.innerHTML = `<div class="estado-mini">Gerando o código…</div>`;
  let dados;
  try { dados = await iniciarCadastro("Autenticador"); }
  catch (e) { corpo.innerHTML = `<div class="estado-mini bad">${escapeHtml(e.message)}</div>`; return; }

  // O Supabase entrega o QR como data URI (SVG) — <img> é CSP-safe.
  corpo.innerHTML = `
    <ol class="cfg-passos">
      <li>Abra seu app autenticador (Google Authenticator, Authy, 1Password…).</li>
      <li>Escaneie o QR abaixo <b>ou</b> digite a chave manualmente.</li>
      <li>Informe o código de 6 dígitos que o app mostrar.</li>
    </ol>
    ${dados.qrSvg ? `<div class="mfa-qr"><img alt="QR do 2FA" src="${escapeHtml(dados.qrSvg)}" width="180" height="180" /></div>` : ""}
    ${dados.segredo ? `<p class="cfg-meta">Chave: <code>${escapeHtml(dados.segredo)}</code></p>` : ""}
    <label class="adm-campo"><span>Código do app</span>
      <input id="mfa-codigo" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" /></label>
    <div class="cfg-acoes">
      <button type="button" class="btn btn-primary" id="mfa-confirmar">Confirmar</button>
      <button type="button" class="btn btn-ghost btn-sm" id="mfa-cancelar">Cancelar</button>
    </div>
    <p class="mfa-erro bad" id="mfa-erro" hidden></p>`;

  corpo.querySelector("#mfa-cancelar")?.addEventListener("click", aoConcluir);
  corpo.querySelector("#mfa-confirmar")?.addEventListener("click", async () => {
    const codigo = corpo.querySelector("#mfa-codigo")?.value?.trim() ?? "";
    const err = corpo.querySelector("#mfa-erro");
    err.hidden = true;
    if (!/^\d{6}$/.test(codigo)) { err.textContent = "Digite os 6 dígitos do app."; err.hidden = false; return; }
    try {
      await confirmarCadastro(dados.factorId, codigo);
      toast("Verificação em duas etapas ativada.");
      aoConcluir();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
}

// Trocar de empresa/unidade com a tela de Configurações aberta: o próprio
// funil de troca (app.js#mostrarApp) já re-renderiza a rota. Este reset é a
// defesa a mais — garante que nada de módulo sobrevive à troca.
registrarResetDeContexto(() => {
  pendenciasNotificacoes = 0;
  const view = el("#view");
  if (view && state.rota === "configuracoes") {
    // Deixa app.js#mostrarApp decidir a rota; só evita manter um painel
    // antigo pintado durante a transição.
    view.innerHTML = "";
  }
});
