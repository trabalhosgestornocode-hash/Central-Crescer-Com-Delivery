// Página INTEGRAÇÃO IFOOD — Fase 1: conexão da unidade, fluxo OAuth
// distribuído (2 etapas), descoberta de merchant e status. Fase 2: área de
// Homologação Financeira (só leitura — ver `financeiro` mais abaixo).
//
// Não usa iframe (diferente da aba Martin Brower). Não guarda NADA em
// localStorage — o sessionId do fluxo OAuth vive só em `estado.wizard` (memória
// do módulo) e some ao trocar de contexto. Nenhum token/secret/verifier chega
// aqui: o backend só devolve userCode + URLs + prazo, e status sanitizado.
//
// As DECISÕES (estado visual, seleção de merchant, contador, confirmação de
// troca) ficam em ifoodEstado.js (puro, testado). Aqui é só DOM + orquestração.

import { el, els, fmtDataHora, fmtMoeda, toast, escapeHtml as esc } from "./utils.js";
import * as api from "./api.js";
import { registrarResetDeContexto } from "./contextoEscopo.js";
import {
  APP_ROTULO, derivarEstadoIntegracao, acoesDoPainel, prepararSelecaoMerchant, contadorExpiracao,
  precisaConfirmarTrocaMerchant, textoConfirmacaoTroca, mensagemErroAutorizacao, avisoDesconexao,
  derivarFontesConciliacao, derivarPendenciasHomologacao,
  saudeSalesVsEvents, saudeEventsVsSettlements, saudeSettlementsVsReconciliation,
  montarEvidenciaHomologacao, montarExportacaoJson, montarExportacaoHtml, rotuloImpactoRepasse,
} from "./ifoodEstado.js";

const IFOOD_LOGO = "/assets/menu-dashboard-ifood.png";

const estado = {
  status: null,
  statusErro: null, // mensagem quando GET /status FALHOU (estado real desconhecido — nunca vira "Não conectado")
  carregando: false,
  wizard: null,   // { etapa, appType, sessionId, userCode, verificationUrlComplete, expiraEm, timer, feito:{analytics,financial}, selecao }
  financeiro: null, // { inicio, fim, page, carregando, resultado, erro } — Homologação Financeira (Sales)
};

// Fase F (auditoria de troca de contexto): trocar de unidade pelo seletor
// global não passa por renderIfood() se o usuário está em outra tela. Sem
// isto, um contador (setInterval) da unidade A seguiria rodando sobre o
// contexto da unidade B.
registrarResetDeContexto(() => {
  pararContador();
  estado.status = null;
  estado.statusErro = null;
  estado.wizard = null;
  estado.financeiro = null; // nunca deixa dado financeiro de uma unidade vazar pra outra
});

// ---------------------------------------------------------------------------
// Contador de expiração do userCode
// ---------------------------------------------------------------------------
function pararContador() {
  if (estado.wizard?.timer) { clearInterval(estado.wizard.timer); estado.wizard.timer = null; }
}

function armarContador() {
  pararContador();
  atualizarContador();
  estado.wizard.timer = setInterval(atualizarContador, 1000);
}

function atualizarContador() {
  const w = estado.wizard;
  if (!w?.expiraEm) return;
  const c = contadorExpiracao(w.expiraEm);
  const alvo = el("#ifood-contador");
  if (alvo) { alvo.textContent = c.rotulo; alvo.classList.toggle("ifood-expirado", c.expirado); }
  const concluir = el("#ifood-concluir");
  if (concluir) concluir.disabled = c.expirado;
  const regen = el("#ifood-regenerar");
  if (regen) regen.hidden = !c.expirado;
  if (c.expirado) pararContador();
}

// ---------------------------------------------------------------------------
// Carga de status
// ---------------------------------------------------------------------------
async function carregarStatus() {
  estado.carregando = true;
  try {
    const { data } = await api.ifoodStatus();
    estado.status = data;
    estado.statusErro = null;
  } catch (e) {
    // Falha de status NÃO é "não conectado": guarda o erro e a tela mostra
    // indisponibilidade + "Tentar novamente" (sem oferecer Conectar).
    estado.status = null;
    estado.statusErro = e?.message || "erro";
  } finally {
    estado.carregando = false;
  }
  pintarPainel();
}

// ---------------------------------------------------------------------------
// Painel de status
// ---------------------------------------------------------------------------
function linhaApp(rotulo, appEstado) {
  return `
    <div class="ifood-app-linha">
      <span class="ifood-app-nome">${esc(rotulo)}</span>
      <span class="pill ${appEstado.classe}">${esc(appEstado.rotulo)}</span>
    </div>`;
}

function blocoMerchant(merchant) {
  if (!merchant) return `<div class="ifood-merchant vazio">Nenhuma loja iFood vinculada</div>`;
  return `
    <div class="ifood-merchant">
      <div class="ifood-merchant-nome">${esc(merchant.nome || "—")}</div>
      <div class="ifood-merchant-meta">Razão social: ${esc(merchant.razaoSocial || "—")}</div>
      <div class="ifood-merchant-meta">Merchant: <span class="mono">${esc(merchant.idMascarado || "—")}</span></div>
    </div>`;
}

function pintarPainel() {
  const view = el("#view");
  if (!view) return;
  pararContador();
  estado.wizard = null;

  const e = derivarEstadoIntegracao(estado.status, { erro: !!estado.statusErro });
  // Ações vêm de UMA função pura (ifoodEstado.js#acoesDoPainel): nunca há
  // comandos duplicados/conflitantes e "Conectar" não aparece se o status falhou.
  const acoes = acoesDoPainel(e).map((a) =>
    `<button class="btn ${a.primaria ? "btn-primary" : "btn-ghost"}" id="ifood-acao-${a.id}" data-acao="${a.id}">${esc(a.rotulo)}</button>`);

  if (e.chave === "erro_status") {
    view.innerHTML = `
    <div class="ifood-page">
      <div class="vd-head ifood-head">
        <div class="ifood-head-id">
          <img src="${IFOOD_LOGO}" alt="iFood" class="ifood-head-logo" />
          <div class="vd-head-txt">
            <h2>Integração iFood <span class="pill ${e.classe}" id="ifood-status-pill">${esc(e.rotulo)}</span></h2>
          </div>
        </div>
      </div>
      <div class="ifood-card">
        <div class="ifood-aviso bad" id="ifood-erro-status">${esc(e.aviso)}</div>
        ${estado.statusErro && estado.statusErro !== "erro" ? `<p class="ifood-instrucao">${esc(estado.statusErro)}</p>` : ""}
        <div class="ifood-acoes">${acoes.join("")}</div>
      </div>
    </div>`;
    ligarAcoesDoPainel();
    return;
  }

  view.innerHTML = `
    <div class="ifood-page">
      <div class="vd-head ifood-head">
        <div class="ifood-head-id">
          <img src="${IFOOD_LOGO}" alt="iFood" class="ifood-head-logo" />
          <div class="vd-head-txt">
            <h2>Integração iFood <span class="pill ${e.classe}" id="ifood-status-pill">${esc(e.rotulo)}</span>${badgeHomologacao()}</h2>
            <p>Conecte esta unidade ao iFood para, no futuro, sincronizar dados de desempenho e financeiro. Nesta fase só a conexão e a identificação da loja são feitas.</p>
          </div>
        </div>
      </div>

      <div class="ifood-card">
        <div class="ifood-apps">
          ${linhaApp(APP_ROTULO.analytics, e.apps.analytics)}
          ${linhaApp(APP_ROTULO.financial, e.apps.financial)}
        </div>
        <div class="ifood-secao-rotulo">Loja iFood vinculada</div>
        ${blocoMerchant(e.merchant)}
        ${e.aviso ? `<div class="ifood-aviso warn" id="ifood-aviso-estado">${esc(e.aviso)}</div>` : ""}
        ${estado.status?.ultimoErro ? `<div class="ifood-aviso bad">${esc(estado.status.ultimoErro)}</div>` : ""}
        <div class="ifood-info-linha">
          <span>Conectada em</span><strong>${e.conectadaEm ? fmtDataHora(e.conectadaEm) : "—"}</strong>
        </div>
        <div class="ifood-info-linha">
          <span>Última atualização</span><strong>Ainda não sincronizado</strong>
        </div>
        <div class="ifood-acoes">${acoes.join("") || '<span class="ifood-tudo-ok">Integração conectada. Sincronização de dados chega em uma próxima fase.</span>'}</div>
      </div>

      ${e.apps.financial.conectado && e.merchant ? `
        <div class="ifood-card">
          <div class="ifood-secao-rotulo">Homologação Financeira</div>
          <p class="ifood-instrucao">Consulta de dados financeiros do ambiente de teste (API Sales) para gerar evidência junto ao iFood. Nesta fase, só leitura — nenhum dado alimenta o Dashboard iFood ou o lançamento diário.</p>
          <button class="btn btn-ghost" id="ifood-abrir-financeiro">Abrir Homologação Financeira</button>
        </div>
      ` : ""}
    </div>`;

  ligarAcoesDoPainel();
  el("#ifood-abrir-financeiro")?.addEventListener("click", abrirFinanceiro);
}

// Cada `id` de acoesDoPainel() -> um handler. Um só lugar para o mapeamento.
function ligarAcoesDoPainel() {
  const handlers = {
    tentar_novamente: () => { pintarCarregando(); carregarStatus(); },
    conectar: () => abrirWizard("auto"),
    continuar: () => abrirWizard("auto"),
    autorizar_analytics: () => abrirWizard("analytics"),
    reconectar: () => abrirWizard("reauth"),
    // Loja pendente: vai DIRETO para a seleção de loja (GET /merchants ->
    // escolher -> POST /merchants/link). Não refaz OAuth.
    vincular: () => abrirWizard("merchant"),
    desconectar,
  };
  for (const b of els("#view [data-acao]")) {
    b.addEventListener("click", () => handlers[b.dataset.acao]?.());
  }
}

function pintarCarregando() {
  const view = el("#view");
  if (view) view.innerHTML = `<div class="ifood-page"><div class="ifood-card"><div class="ifood-msg">Consultando o status da integração iFood…</div></div></div>`;
}

// ---------------------------------------------------------------------------
// Assistente (wizard) de conexão
// ---------------------------------------------------------------------------
function primeiraEtapaPendente(modo) {
  const e = derivarEstadoIntegracao(estado.status);
  if (modo === "merchant") return "merchant";
  if (modo === "analytics") return "analytics";
  if (modo === "reauth") {
    return e.apps.financial.classe === "bad" ? "financial" : "analytics";
  }
  if (e.podeConectarAnalytics) return "analytics";
  if (e.podeConectarFinancial) return "financial";
  return "financial";
}

function abrirWizard(modo) {
  estado.wizard = { etapa: primeiraEtapaPendente(modo), appType: null, sessionId: null, feito: {}, selecao: null };
  pintarWizard();
}

function sairDoWizard() {
  pararContador();
  estado.wizard = null;
  carregarStatus();
}

// Badge discreta — só aparece com IFOOD_HOMOLOGATION_MODE=true no backend.
// Nunca exibe clientId/clientSecret/token: só sinaliza que o ambiente é de
// teste (aplicativo distribuído de teste do iFood, não os apps reais).
function badgeHomologacao() {
  if (!estado.status?.homologacao) return "";
  return ` <span class="pill info" id="ifood-badge-homologacao" title="Conexão usando o aplicativo de teste do iFood — não representa produção.">Ambiente de homologação iFood</span>`;
}

function cabecalhoWizard(tituloEtapa, passo) {
  return `
    <div class="vd-head ifood-head">
      <div class="vd-head-txt">
        <h2>Conectar iFood <span class="ifood-passo">Etapa ${passo} de 2</span>${badgeHomologacao()}</h2>
        <p>${esc(tituloEtapa)}</p>
      </div>
      <button class="btn btn-ghost" id="ifood-wizard-sair">Voltar ao status</button>
    </div>`;
}

function pintarWizard() {
  const view = el("#view");
  const w = estado.wizard;
  if (!view || !w) return;
  pararContador();

  if (w.etapa === "analytics") return pintarEtapaOAuth("analytics", 1, "Dados de desempenho — autorize o aplicativo de Analytics.");
  if (w.etapa === "financial") return pintarEtapaOAuth("financial", 2, "Dados financeiros — autorize o aplicativo Financial + Merchant.");
  if (w.etapa === "merchant") return pintarEtapaMerchant();
}

function pintarEtapaOAuth(appType, passo, subtitulo) {
  const view = el("#view");
  const w = estado.wizard;
  const temCodigo = w.appType === appType && w.sessionId;

  view.innerHTML = `
    <div class="ifood-page">
      ${cabecalhoWizard(subtitulo, passo)}
      <div class="ifood-card">
        ${w.feito.analytics && appType === "financial" ? `<div class="ifood-aviso ok">Desempenho / Analytics autorizado ✓</div>` : ""}
        ${!temCodigo ? `
          <p>Gere um código de vínculo e autorize o aplicativo no Portal do Parceiro iFood.</p>
          <button class="btn btn-primary" id="ifood-gerar">Gerar código</button>
          ${appType === "analytics" ? `<button class="btn btn-ghost" id="ifood-pular">Pular por enquanto</button>` : ""}
        ` : `
          <div class="ifood-codigo-box">
            <div class="ifood-codigo-rotulo">Código de vínculo</div>
            <div class="ifood-codigo">${esc(w.userCode)}</div>
            <div class="ifood-codigo-exp">Expira em <span id="ifood-contador">--:--</span></div>
          </div>
          <a class="btn btn-primary" id="ifood-abrir-portal" href="${esc(w.verificationUrlComplete || "#")}" target="_blank" rel="noopener">Abrir Portal do iFood ↗</a>
          <p class="ifood-instrucao">Autorize o aplicativo no Portal do Parceiro e depois cole aqui o <strong>código de autorização</strong> que o iFood fornecer.</p>
          <label class="ifood-label" for="ifood-authcode">Código de autorização</label>
          <input type="text" id="ifood-authcode" class="ifood-input" autocomplete="off" spellcheck="false" placeholder="Cole o código do iFood" />
          <div class="ifood-acoes">
            <button class="btn btn-primary" id="ifood-concluir">Concluir autorização</button>
            <button class="btn btn-ghost" id="ifood-regenerar" hidden>Gerar novo código</button>
            ${appType === "analytics" ? `<button class="btn btn-ghost" id="ifood-pular">Pular por enquanto</button>` : ""}
          </div>
        `}
        <div class="ifood-msg" id="ifood-msg"></div>
      </div>
    </div>`;

  el("#ifood-wizard-sair")?.addEventListener("click", sairDoWizard);
  el("#ifood-gerar")?.addEventListener("click", () => gerarCodigo(appType));
  el("#ifood-regenerar")?.addEventListener("click", () => gerarCodigo(appType));
  el("#ifood-concluir")?.addEventListener("click", () => concluirAutorizacao(appType));
  el("#ifood-pular")?.addEventListener("click", () => { estado.wizard.etapa = "financial"; estado.wizard.appType = null; estado.wizard.sessionId = null; pintarWizard(); });
  if (temCodigo) armarContador();
}

async function gerarCodigo(appType) {
  const btn = el("#ifood-gerar") || el("#ifood-regenerar");
  if (btn) btn.disabled = true;
  try {
    const { data } = await api.ifoodOauthStart(appType);
    estado.wizard.appType = appType;
    estado.wizard.sessionId = data.sessionId;
    estado.wizard.userCode = data.userCode;
    estado.wizard.verificationUrlComplete = data.verificationUrlComplete || data.verificationUrl || null;
    estado.wizard.expiraEm = data.expiraEm;
    pintarWizard();
  } catch (e) {
    if (btn) btn.disabled = false;
    mostrarMsg(mensagemErroAutorizacao(e), "bad");
  }
}

async function concluirAutorizacao(appType) {
  const code = (el("#ifood-authcode")?.value || "").trim();
  if (!code) return mostrarMsg("Cole o código de autorização fornecido pelo iFood.", "bad");
  const btn = el("#ifood-concluir");
  if (btn) btn.disabled = true;
  try {
    await api.ifoodOauthComplete(appType, estado.wizard.sessionId, code);
    estado.wizard.feito[appType] = true;
    pararContador();
    if (appType === "analytics" && derivarEstadoIntegracao(estado.status).apps.financial.conectado) {
      // Analytics autorizado depois do Financial (caminho "Autorizar Analytics"):
      // nada mais a autorizar — volta ao status.
      sairDoWizard();
    } else if (appType === "analytics") {
      estado.wizard.etapa = "financial";
      estado.wizard.appType = null; estado.wizard.sessionId = null;
      pintarWizard();
    } else {
      estado.wizard.etapa = "merchant";
      await carregarStatusSilencioso();
      pintarWizard();
    }
  } catch (e) {
    if (btn) btn.disabled = false;
    mostrarMsg(mensagemErroAutorizacao(e), "bad");
    if (e?.codigo === "IFOOD_OAUTH_SESSAO_EXPIRADA") { const r = el("#ifood-regenerar"); if (r) r.hidden = false; }
  }
}

// ---------------------------------------------------------------------------
// Etapa de seleção de merchant
// ---------------------------------------------------------------------------
async function pintarEtapaMerchant() {
  const view = el("#view");
  view.innerHTML = `
    <div class="ifood-page">
      ${cabecalhoWizard("Loja do iFood — identifique a loja desta unidade.", 2)}
      <div class="ifood-card"><div class="ifood-msg">Buscando lojas autorizadas…</div></div>
    </div>`;
  el("#ifood-wizard-sair")?.addEventListener("click", sairDoWizard);

  let sel;
  try {
    const { data } = await api.ifoodMerchants();
    sel = prepararSelecaoMerchant(data?.merchants);
    if (data?.truncado) sel.mensagem += " (lista muito grande — mostrando as primeiras lojas encontradas)";
  } catch (e) {
    return renderMerchantErro(e.message || "Não foi possível listar as lojas do iFood.");
  }
  estado.wizard.selecao = sel;

  const card = el(".ifood-card");
  if (!card) return;

  if (sel.modo === "vazio") {
    card.innerHTML = `
      <div class="ifood-aviso warn">${esc(sel.mensagem)}</div>
      <div class="ifood-acoes">
        <button class="btn btn-ghost" id="ifood-merchant-retry">Tentar de novo</button>
        <button class="btn btn-primary" id="ifood-merchant-depois">Concluir sem vincular loja</button>
      </div>`;
    el("#ifood-merchant-retry")?.addEventListener("click", pintarEtapaMerchant);
    el("#ifood-merchant-depois")?.addEventListener("click", sairDoWizard);
    return;
  }

  const itens = sel.merchants.map((m, i) => `
    <label class="ifood-merchant-opcao">
      <input type="radio" name="ifood-merchant" value="${i}" ${sel.modo === "unico" || i === 0 ? "checked" : ""} />
      <span>
        <strong>${esc(m.nome || "(sem nome)")}</strong>
        <span class="ifood-merchant-meta">Razão social: ${esc(m.razaoSocial || "—")}</span>
        <span class="ifood-merchant-meta">Merchant: <span class="mono">${esc(m.idMascarado || "—")}</span></span>
      </span>
    </label>`).join("");

  card.innerHTML = `
    <p>${esc(sel.mensagem)}</p>
    <div class="ifood-merchant-lista">${itens}</div>
    <div class="ifood-acoes">
      <button class="btn btn-primary" id="ifood-vincular">${sel.modo === "unico" ? "Vincular a esta unidade" : "Vincular loja selecionada"}</button>
      <button class="btn btn-ghost" id="ifood-merchant-depois">Vincular depois</button>
    </div>
    <div class="ifood-msg" id="ifood-msg"></div>`;
  el("#ifood-vincular")?.addEventListener("click", vincularSelecionado);
  el("#ifood-merchant-depois")?.addEventListener("click", sairDoWizard);
}

function renderMerchantErro(msg) {
  const card = el(".ifood-card");
  if (!card) return;
  card.innerHTML = `
    <div class="ifood-aviso bad">${esc(msg)}</div>
    <div class="ifood-acoes">
      <button class="btn btn-ghost" id="ifood-merchant-retry">Tentar de novo</button>
      <button class="btn btn-primary" id="ifood-merchant-depois">Concluir sem vincular loja</button>
    </div>`;
  el("#ifood-merchant-retry")?.addEventListener("click", pintarEtapaMerchant);
  el("#ifood-merchant-depois")?.addEventListener("click", sairDoWizard);
}

async function vincularSelecionado() {
  const sel = estado.wizard?.selecao;
  if (!sel?.merchants?.length) return;
  const idx = Number(el('input[name="ifood-merchant"]:checked')?.value ?? 0);
  const escolhido = sel.merchants[idx];
  if (!escolhido) return;

  // Troca de merchant na mesma unidade: confirmação EXPLÍCITA. Mesmo merchant
  // (idempotente) ou nenhum vinculado -> segue direto.
  if (precisaConfirmarTrocaMerchant(estado.status, escolhido)
      && !window.confirm(textoConfirmacaoTroca(estado.status, escolhido))) {
    return;
  }

  const btn = el("#ifood-vincular");
  if (btn) btn.disabled = true;
  mostrarMsg("Validando a loja no iFood…");
  try {
    const { data } = await api.ifoodVincularMerchant(escolhido.id);
    estado.status = data;
    toast("Loja vinculada à unidade.");
    sairDoWizard();
  } catch (e) {
    if (btn) btn.disabled = false;
    mostrarMsg(e.message || "Não foi possível vincular a loja.", "bad");
  }
}

// ---------------------------------------------------------------------------
// Desconexão local
// ---------------------------------------------------------------------------
async function desconectar() {
  if (!window.confirm(`${avisoDesconexao()}\n\nDesconectar agora?`)) return;
  const btn = el("#ifood-desconectar");
  if (btn) btn.disabled = true;
  try {
    await api.ifoodDesconectar();
    toast("Integração iFood desconectada localmente. Para revogação total, remova o acesso também no Portal do Parceiro iFood.");
  } catch (e) {
    toast(e.message || "Não foi possível desconectar.");
  }
  carregarStatus();
}

// ---------------------------------------------------------------------------
// Homologação Financeira (Fase 2) — Sales + Financial Events, só leitura.
//
// Visível só com conexão financial ativa + merchant vinculado (ver botão em
// pintarPainel). merchantId NUNCA sai daqui — o backend resolve sempre da
// conexão da unidade (ifoodFinancial.service.js#resolverConexaoComMerchant).
// Nada aqui grava no banco nem alimenta Dashboard iFood/lançamento diário.
//
// Abas: só existem as que já têm API implementada (Settlements/Reconciliation/
// Anticipation/Conciliação chegam em incrementos futuros, um de cada vez).
// ---------------------------------------------------------------------------
const ABAS_FINANCEIRO = [
  { id: "overview", rotulo: "Visão Geral" },
  { id: "sales", rotulo: "Sales" },
  { id: "events", rotulo: "Financial Events" },
  { id: "settlements", rotulo: "Settlements" },
  { id: "reconciliation", rotulo: "Reconciliation" },
  { id: "anticipation", rotulo: "Anticipation" },
  { id: "conciliation", rotulo: "Conciliação" },
  { id: "evidencia", rotulo: "Evidências" },
];

function hojeISO() { return new Date().toISOString().slice(0, 10); }
// Datas "só data" (AAAA-MM-DD, sem hora) da API — settlement.expectedDate,
// paymentDate, startDateCalculation... NUNCA passam por fmtDataHora/`new
// Date()`: interpretar "2024-01-22" como UTC meia-noite e converter pro
// fuso local pode voltar um dia (ex. UTC-3 mostraria 21/01). Reformata a
// string diretamente, sem passar por objeto Date nenhum.
function fmtDataSimples(dataIso) {
  if (!dataIso) return "—";
  const m = String(dataIso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(dataIso);
}
function diasAtrasISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
// Competência (AAAA-MM) do mês FECHADO mais recente — o mês atual nunca é
// válido pra Reconciliation (ver ifoodFinancial.service.js#validarCompetencia).
function mesFechadoAnterior() {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function abrirFinanceiro() {
  pararContador();
  estado.wizard = null;
  estado.financeiro = {
    aba: "overview",
    // Visão Geral — camada de apresentação sobre obterConciliacaoFinanceira()
    // (mesmo endpoint da aba Conciliação, período próprio). Não recalcula
    // nada: só lê os campos que o backend já devolve prontos.
    overview: { inicio: diasAtrasISO(13), fim: diasAtrasISO(7), carregando: false, resultado: null, erro: null },
    sales: { inicio: diasAtrasISO(6), fim: hojeISO(), page: 1, carregando: false, resultado: null, erro: null },
    events: { inicio: hojeISO(), fim: hojeISO(), page: 1, carregando: false, resultado: null, erro: null },
    // Settlements não tem valor padrão óbvio (a API exige as duas datas,
    // sem default) — parte de uma semana de liquidação recente (seg-dom).
    settlements: { modo: "calculo", inicio: diasAtrasISO(13), fim: diasAtrasISO(7), carregando: false, resultado: null, erro: null },
    // Reconciliation (mês fechado, síncrona) x On Demand (assíncrona) são
    // CONTRATOS DIFERENTES no backend — mantidos em sub-estados separados
    // aqui também, nunca misturados.
    reconciliation: {
      competencia: mesFechadoAnterior(), carregando: false, resultado: null, erro: null,
      onDemand: { competencia: mesFechadoAnterior(), carregando: false, requestId: null, resultado: null, erro: null },
    },
    // Somente leitura — sem valor padrão óbvio, mesma regra de Settlements.
    anticipation: { modo: "calculo", inicio: diasAtrasISO(13), fim: diasAtrasISO(7), carregando: false, resultado: null, erro: null },
    // Bloco H — Conciliação consolidada. Reaproveita a mesma janela de
    // Settlements/Anticipation (período de cálculo/liquidação recente).
    conciliation: { inicio: diasAtrasISO(13), fim: diasAtrasISO(7), carregando: false, resultado: null, erro: null },
    // Evidências — NÃO busca nada sozinha: só lê o que as abas acima já
    // consultaram nesta sessão (sales/events/settlements/reconciliation/
    // anticipation/conciliation) e monta um retrato pra auditoria (Bloco Q).
    // `geradoEm` só é preenchido quando "Gerar evidência" é clicado — é o
    // timestamp da EVIDÊNCIA, não da última consulta de cada aba.
    evidencia: { geradoEm: null, modoTecnico: false },
  };
  pintarFinanceiro();
}

function fecharFinanceiro() {
  estado.financeiro = null;
  pintarPainel();
}

async function buscarSales({ resetarPagina }) {
  const f = estado.financeiro?.sales;
  if (!f) return;
  if (resetarPagina) {
    f.inicio = el("#ifin-inicio")?.value || f.inicio;
    f.fim = el("#ifin-fim")?.value || f.fim;
    f.page = 1;
  }
  f.carregando = true;
  f.erro = null;
  pintarFinanceiro();
  try {
    const { data } = await api.ifoodFinancialSales(f.inicio, f.fim, f.page);
    f.resultado = data;
  } catch (e) {
    f.erro = e.message || "Não foi possível consultar as vendas.";
    f.resultado = null;
  }
  f.carregando = false;
  pintarFinanceiro();
}

async function buscarEvents({ resetarPagina }) {
  const f = estado.financeiro?.events;
  if (!f) return;
  if (resetarPagina) {
    f.inicio = el("#ifin-inicio")?.value || f.inicio;
    f.fim = el("#ifin-fim")?.value || f.fim;
    f.page = 1;
  }
  f.carregando = true;
  f.erro = null;
  pintarFinanceiro();
  try {
    const { data } = await api.ifoodFinancialEvents(f.inicio, f.fim, f.page);
    f.resultado = data;
    f.inicio = data.periodo?.inicio || f.inicio; // o backend resolve "hoje" quando vazio
    f.fim = data.periodo?.fim || f.fim;
  } catch (e) {
    f.erro = e.message || "Não foi possível consultar os eventos financeiros.";
    f.resultado = null;
  }
  f.carregando = false;
  pintarFinanceiro();
}

async function buscarSettlements() {
  const f = estado.financeiro?.settlements;
  if (!f) return;
  f.modo = el("#ifin-modo")?.value || f.modo;
  f.inicio = el("#ifin-inicio")?.value || f.inicio;
  f.fim = el("#ifin-fim")?.value || f.fim;
  f.carregando = true;
  f.erro = null;
  pintarFinanceiro();
  try {
    const { data } = await api.ifoodFinancialSettlements(f.modo, f.inicio, f.fim);
    f.resultado = data;
  } catch (e) {
    f.erro = e.message || "Não foi possível consultar os settlements.";
    f.resultado = null;
  }
  f.carregando = false;
  pintarFinanceiro();
}

// --- Reconciliation (mês fechado, síncrona) --------------------------------
async function buscarReconciliation() {
  const f = estado.financeiro?.reconciliation;
  if (!f) return;
  f.competencia = el("#ifrec-competencia")?.value || f.competencia;
  f.carregando = true;
  f.erro = null;
  pintarFinanceiro();
  try {
    const { data } = await api.ifoodFinancialReconciliation(f.competencia);
    f.resultado = data;
  } catch (e) {
    f.erro = e.message || "Não foi possível consultar a conciliação.";
    f.resultado = null;
  }
  f.carregando = false;
  pintarFinanceiro();
}

// --- Reconciliation On Demand (assíncrona) — solicitar + consultar status,
// os dois disparados só por clique do usuário (nunca polling automático). --
async function solicitarReconciliationOnDemand() {
  const od = estado.financeiro?.reconciliation?.onDemand;
  if (!od) return;
  od.competencia = el("#ifrec-od-competencia")?.value || od.competencia;
  od.carregando = true;
  od.erro = null;
  od.resultado = null;
  pintarFinanceiro();
  try {
    const { data } = await api.ifoodFinancialReconciliationOnDemandSolicitar(od.competencia);
    od.requestId = data.requestId;
    toast("Solicitação enviada. Clique em \"Verificar status\" em alguns instantes.");
  } catch (e) {
    od.erro = e.message || "Não foi possível solicitar a conciliação sob demanda.";
  }
  od.carregando = false;
  pintarFinanceiro();
}

async function verificarStatusReconciliationOnDemand() {
  const od = estado.financeiro?.reconciliation?.onDemand;
  if (!od || !od.requestId) return;
  od.carregando = true;
  od.erro = null;
  pintarFinanceiro();
  try {
    const { data } = await api.ifoodFinancialReconciliationOnDemandStatus(od.requestId);
    od.resultado = data;
  } catch (e) {
    od.erro = e.message || "Não foi possível verificar o status.";
  }
  od.carregando = false;
  pintarFinanceiro();
}

// --- Anticipation — somente leitura --------------------------------------
async function buscarAnticipation() {
  const f = estado.financeiro?.anticipation;
  if (!f) return;
  f.modo = el("#ifant-modo")?.value || f.modo;
  f.inicio = el("#ifant-inicio")?.value || f.inicio;
  f.fim = el("#ifant-fim")?.value || f.fim;
  f.carregando = true;
  f.erro = null;
  pintarFinanceiro();
  try {
    const { data } = await api.ifoodFinancialAnticipations(f.modo, f.inicio, f.fim);
    f.resultado = data;
  } catch (e) {
    f.erro = e.message || "Não foi possível consultar as antecipações.";
    f.resultado = null;
  }
  f.carregando = false;
  pintarFinanceiro();
}

// --- Bloco H — Conciliação Financeira consolidada --------------------------
async function buscarConciliation() {
  const f = estado.financeiro?.conciliation;
  if (!f) return;
  f.inicio = el("#ifcon-inicio")?.value || f.inicio;
  f.fim = el("#ifcon-fim")?.value || f.fim;
  f.carregando = true;
  f.erro = null;
  pintarFinanceiro();
  try {
    const { data } = await api.ifoodFinancialConciliation(f.inicio, f.fim);
    f.resultado = data;
  } catch (e) {
    f.erro = e.message || "Não foi possível gerar a conciliação.";
    f.resultado = null;
  }
  f.carregando = false;
  pintarFinanceiro();
}

// Visão Geral — mesmo endpoint da Conciliação (obterConciliacaoFinanceira),
// período independente. Nenhuma lógica nova: só reaproveita a leitura já
// implementada e validada no Bloco H.
async function buscarOverview() {
  const f = estado.financeiro?.overview;
  if (!f) return;
  f.inicio = el("#ifov-inicio")?.value || f.inicio;
  f.fim = el("#ifov-fim")?.value || f.fim;
  f.carregando = true;
  f.erro = null;
  pintarFinanceiro();
  try {
    const { data } = await api.ifoodFinancialConciliation(f.inicio, f.fim);
    f.resultado = data;
  } catch (e) {
    f.erro = e.message || "Não foi possível carregar a visão geral.";
    f.resultado = null;
  }
  f.carregando = false;
  pintarFinanceiro();
}

// --- Evidências — NÃO busca nada: só stampa o momento da geração e
// re-renderiza (o conteúdo é sempre lido ao vivo de estado.financeiro pelas
// funções puras de ifoodEstado.js). Ver conteudoAbaEvidencia().
function gerarEvidencia() {
  const f = estado.financeiro?.evidencia;
  if (!f) return;
  f.geradoEm = new Date().toISOString();
  pintarFinanceiro();
}

function alternarModoTecnico() {
  const f = estado.financeiro?.evidencia;
  if (!f) return;
  f.modoTecnico = !f.modoTecnico;
  pintarFinanceiro();
}

/** Baixa `conteudo` como arquivo local — Blob + link temporário, sem
 * request nenhuma (a evidência nunca sai do navegador por aqui). */
function baixarArquivoLocal(nomeArquivo, conteudo, tipoMime) {
  const blob = new Blob([conteudo], { type: tipoMime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function nomeArquivoEvidencia(extensao) {
  const carimbo = (estado.financeiro?.evidencia?.geradoEm || new Date().toISOString()).replace(/[:.]/g, "-");
  return `evidencia-homologacao-ifood-${carimbo}.${extensao}`;
}

function exportarEvidenciaJson() {
  const evidencia = montarEvidenciaHomologacao({
    geradoEm: estado.financeiro.evidencia.geradoEm, status: estado.status, financeiro: estado.financeiro,
  });
  baixarArquivoLocal(nomeArquivoEvidencia("json"), montarExportacaoJson(evidencia), "application/json;charset=utf-8");
}

function exportarEvidenciaHtml() {
  const evidencia = montarEvidenciaHomologacao({
    geradoEm: estado.financeiro.evidencia.geradoEm, status: estado.status, financeiro: estado.financeiro,
  });
  baixarArquivoLocal(nomeArquivoEvidencia("html"), montarExportacaoHtml(evidencia), "text/html;charset=utf-8");
}

function statusVendaClasse(status) {
  if (status === "CONCLUDED" || status === "DELIVERED") return "ok";
  if (status === "CANCELLED") return "bad";
  if (["PLACED", "CONFIRMED", "READY", "DISPATCH"].includes(status)) return "info";
  return "muted";
}

function linhaVenda(v) {
  return `
    <tr>
      <td>${esc(String(v.shortId ?? v.id ?? "—"))}</td>
      <td>${v.criadoEm ? fmtDataHora(v.criadoEm) : "—"}</td>
      <td><span class="pill ${statusVendaClasse(v.status)}">${esc(v.status ?? "—")}</span></td>
      <td>${esc(v.canal ?? "—")}</td>
      <td class="num">${fmtMoeda(v.valorBruto?.total)}</td>
      <td class="num">${v.resumoFinanceiro ? fmtMoeda(v.resumoFinanceiro.saldo) : "—"}</td>
      <td><button class="btn btn-ghost btn-sm" data-tipo="venda" data-id="${esc(v.id ?? "")}">Ver detalhes</button></td>
    </tr>`;
}

function linhaEvento(ev, idx) {
  return `
    <tr>
      <td>${esc(ev.nome ?? "—")}</td>
      <td>${esc(ev.descricao ?? "—")}</td>
      <td>${ev.dataHora ? fmtDataHora(ev.dataHora) : "—"}</td>
      <td class="num"><span class="${ev.tipoValor === "debito" ? "ifin-debito" : "ifin-credito"}">${fmtMoeda(ev.valor)}</span></td>
      <td><span class="pill ${ev.temImpactoRepasse === true ? "ok" : "muted"}">${rotuloImpactoRepasse(ev.temImpactoRepasse)}</span></td>
      <td>${fmtDataSimples(ev.dataRepasseEsperada)}</td>
      <td><button class="btn btn-ghost btn-sm" data-tipo="evento" data-idx="${idx}">Ver detalhes</button></td>
    </tr>`;
}

function abasHtml(f) {
  return `<div class="vd-nav">${ABAS_FINANCEIRO.map((a) => `
    <button class="vd-tab ${f.aba === a.id ? "ativo" : ""}" data-aba="${a.id}">${esc(a.rotulo)}</button>
  `).join("")}</div>`;
}

function conteudoAbaSales(f) {
  const s = f.sales;
  const r = s.resultado;
  const linhas = r?.vendas?.length
    ? r.vendas.map(linhaVenda).join("")
    : `<tr><td colspan="7" class="ifood-vazio">${s.carregando ? "Consultando…" : "Nenhuma venda encontrada para este período."}</td></tr>`;
  const totalPaginas = r?.pagina?.totalPaginas ?? 0;
  const paginacao = totalPaginas > 1 ? `
    <div class="ifin-paginacao">
      <button class="btn btn-ghost btn-sm" id="ifin-anterior" ${s.page <= 1 ? "disabled" : ""}>&larr; Anterior</button>
      <span>Página ${r.pagina.atual} de ${totalPaginas}</span>
      <button class="btn btn-ghost btn-sm" id="ifin-proxima" ${s.page >= totalPaginas ? "disabled" : ""}>Próxima &rarr;</button>
    </div>` : "";

  return `
    <div class="ifin-filtro">
      <label class="ifood-label">Data inicial<input type="date" id="ifin-inicio" class="ifood-input" value="${esc(s.inicio)}" /></label>
      <label class="ifood-label">Data final<input type="date" id="ifin-fim" class="ifood-input" value="${esc(s.fim)}" /></label>
      <button class="btn btn-primary" id="ifin-consultar" ${s.carregando ? "disabled" : ""}>${s.carregando ? "Consultando…" : "Consultar"}</button>
    </div>
    <p class="ifood-instrucao">Período máximo permitido pela API Sales: 90 dias.</p>
    ${s.erro ? `<div class="ifood-aviso bad">${esc(s.erro)}</div>` : ""}
    ${r ? `
      <div class="ifood-info-linha"><span>Total de vendas no período</span><strong>${r.pagina.total}</strong></div>
      <div class="tabela-wrap">
        <table class="grid">
          <thead><tr><th>Pedido</th><th>Criado em</th><th>Status</th><th>Canal</th><th class="num">Valor bruto</th><th class="num">Saldo líquido</th><th>Detalhes</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
      ${paginacao}
    ` : ""}`;
}

function conteudoAbaEvents(f) {
  const ev = f.events;
  const r = ev.resultado;
  const linhas = r?.eventos?.length
    ? r.eventos.map(linhaEvento).join("")
    : `<tr><td colspan="7" class="ifood-vazio">${ev.carregando ? "Consultando…" : "Nenhum evento financeiro encontrado para este período."}</td></tr>`;
  const temProxima = r?.pagina?.temProximaPagina === true;
  const paginacao = (temProxima || ev.page > 1) ? `
    <div class="ifin-paginacao">
      <button class="btn btn-ghost btn-sm" id="ifin-anterior" ${ev.page <= 1 ? "disabled" : ""}>&larr; Anterior</button>
      <span>Página ${ev.page}</span>
      <button class="btn btn-ghost btn-sm" id="ifin-proxima" ${!temProxima ? "disabled" : ""}>Próxima &rarr;</button>
    </div>` : "";

  return `
    <div class="ifin-filtro">
      <label class="ifood-label">Data inicial<input type="date" id="ifin-inicio" class="ifood-input" value="${esc(ev.inicio)}" /></label>
      <label class="ifood-label">Data final<input type="date" id="ifin-fim" class="ifood-input" value="${esc(ev.fim)}" /></label>
      <button class="btn btn-primary" id="ifin-consultar" ${ev.carregando ? "disabled" : ""}>${ev.carregando ? "Consultando…" : "Consultar"}</button>
    </div>
    <p class="ifood-instrucao">Período máximo permitido pela API Financial Events: 33 dias. Sem datas, a consulta usa só o dia de hoje.</p>
    ${ev.erro ? `<div class="ifood-aviso bad">${esc(ev.erro)}</div>` : ""}
    ${r ? `
      <div class="ifood-info-linha"><span>Eventos retornados nesta página</span><strong>${r.eventos.length}</strong></div>
      <div class="tabela-wrap">
        <table class="grid">
          <thead><tr><th>Evento</th><th>Descrição</th><th>Data/hora</th><th class="num">Valor</th><th>Impacta repasse</th><th>Repasse esperado</th><th>Detalhes</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
      ${paginacao}
    ` : ""}`;
}

function statusSettlementClasse(status) {
  if (status === "SUCCEED") return "ok";
  if (status === "FAILED") return "bad";
  return "muted"; // PENDING, TRANSFER_RENEGOTIATED, etc.
}

function linhaSettlement(t, idx) {
  const periodo = t.periodoApuracao ? `${fmtDataSimples(t.periodoApuracao.inicio)} – ${fmtDataSimples(t.periodoApuracao.fim)}` : "—";
  return `
    <tr>
      <td>${esc(t.tipo ?? "—")}</td>
      <td class="num"><span class="${(t.valor ?? 0) < 0 ? "ifin-debito" : "ifin-credito"}">${fmtMoeda(t.valor)}</span></td>
      <td><span class="pill ${statusSettlementClasse(t.status)}">${esc(t.status ?? "—")}</span></td>
      <td>${fmtDataSimples(t.dataPagamento)}</td>
      <td>${esc(periodo)}</td>
      <td>${t.contaBancaria ? esc(t.contaBancaria.banco || "—") : "—"}</td>
      <td><button class="btn btn-ghost btn-sm" data-tipo="settlement" data-idx="${idx}">Ver detalhes</button></td>
    </tr>`;
}

function conteudoAbaSettlements(f) {
  const st = f.settlements;
  const r = st.resultado;
  const linhas = r?.titulos?.length
    ? r.titulos.map(linhaSettlement).join("")
    : `<tr><td colspan="7" class="ifood-vazio">${st.carregando ? "Consultando…" : "Nenhum título de liquidação encontrado para este período."}</td></tr>`;

  return `
    <div class="ifin-filtro">
      <label class="ifood-label">Filtrar por
        <select id="ifin-modo" class="ifood-input">
          <option value="calculo" ${st.modo === "calculo" ? "selected" : ""}>Período de liquidação</option>
          <option value="pagamento" ${st.modo === "pagamento" ? "selected" : ""}>Data de pagamento</option>
        </select>
      </label>
      <label class="ifood-label">Data inicial<input type="date" id="ifin-inicio" class="ifood-input" value="${esc(st.inicio)}" /></label>
      <label class="ifood-label">Data final<input type="date" id="ifin-fim" class="ifood-input" value="${esc(st.fim)}" /></label>
      <button class="btn btn-primary" id="ifin-consultar" ${st.carregando ? "disabled" : ""}>${st.carregando ? "Consultando…" : "Consultar"}</button>
    </div>
    <p class="ifood-instrucao">Sem paginação nesta API. Sem limite de dias imposto pelo iFood, mas a documentação recomenda períodos de até 90 dias. O saldo (<code>balance</code>) deve se aproximar da soma dos eventos financeiros com impacto no repasse (<code>hasTransferImpact=true</code>) do mesmo período — comparação automática chega em um incremento futuro (Conciliação).</p>
    ${st.erro ? `<div class="ifood-aviso bad">${esc(st.erro)}</div>` : ""}
    ${r ? `
      <div class="ifood-info-linha"><span>Saldo do período (líquido)</span><strong>${fmtMoeda(r.saldo)}</strong></div>
      <div class="ifood-info-linha"><span>Títulos no período</span><strong>${r.titulos.length}</strong></div>
      <div class="tabela-wrap">
        <table class="grid">
          <thead><tr><th>Tipo</th><th class="num">Valor</th><th>Status</th><th>Data de pagamento</th><th>Período de apuração</th><th>Banco</th><th>Detalhes</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
    ` : ""}`;
}

// Tabela genérica pro arquivo de conciliação — colunas DINÂMICAS (o iFood
// não documenta os nomes reais das colunas do CSV em lugar nenhum que eu
// tenha encontrado — ver ifoodFinancial.mapper.js#parsearArquivoConciliacao).
function tabelaArquivo(arquivo, maxLinhas) {
  if (!arquivo || !arquivo.colunas?.length) return `<p class="ifood-instrucao">Nenhum arquivo disponível ainda.</p>`;
  const linhasExibidas = maxLinhas ? arquivo.linhas.slice(0, maxLinhas) : arquivo.linhas;
  const corpo = linhasExibidas.length
    ? linhasExibidas.map((linha) => `<tr>${arquivo.colunas.map((c) => `<td>${esc(linha[c] ?? "")}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${arquivo.colunas.length}" class="ifood-vazio">Arquivo sem linhas de dado.</td></tr>`;
  return `
    <div class="tabela-wrap">
      <table class="grid">
        <thead><tr>${arquivo.colunas.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>${corpo}</tbody>
      </table>
    </div>`;
}

function statusOnDemandClasse(status) {
  if (status === "processed") return "ok";
  if (status === "error") return "bad";
  return "info"; // created, enqueue
}
const STATUS_OD_ROTULO = { created: "Criada", enqueue: "Na fila", processed: "Pronta", error: "Erro" };

function conteudoAbaReconciliation(f) {
  const rec = f.reconciliation;
  const od = rec.onDemand;
  const r = rec.resultado;
  const rOd = od.resultado;

  return `
    <div class="ifood-card">
      <div class="ifood-secao-rotulo">Reconciliation — mês fechado (síncrona)</div>
      <p class="ifood-instrucao">Arquivo mensal oficial de conciliação. Só aceita meses já fechados (o mês atual e futuros são inválidos), até 24 meses no passado.</p>
      <div class="ifin-filtro">
        <label class="ifood-label">Competência (mês)<input type="month" id="ifrec-competencia" class="ifood-input" value="${esc(rec.competencia)}" /></label>
        <button class="btn btn-primary" id="ifrec-consultar" ${rec.carregando ? "disabled" : ""}>${rec.carregando ? "Consultando…" : "Consultar"}</button>
      </div>
      ${rec.erro ? `<div class="ifood-aviso bad">${esc(rec.erro)}</div>` : ""}
      ${r ? `
        <div class="ifood-info-linha"><span>Gerado em</span><strong>${r.criadoEm ? fmtDataHora(r.criadoEm) : "—"}</strong></div>
        ${r.metadados ? `
          <div class="ifood-info-linha"><span>Total de linhas (informado pelo iFood)</span><strong>${r.metadados.totalLinhas ?? "—"}</strong></div>
          <div class="ifood-info-linha"><span>Integridade do arquivo (SHA-256)</span><strong>${r.arquivo?.integridadeVerificada === true ? "Confere" : r.arquivo?.integridadeVerificada === false ? "Não confere" : "Não verificável"}</strong></div>
        ` : ""}
        ${r.arquivo ? `
          <div class="ifood-info-linha"><span>Registros parseados</span><strong>${r.arquivo.totalLinhas}${r.arquivo.truncado ? " (exibindo os 2000 primeiros)" : ""}</strong></div>
          ${tabelaArquivo(r.arquivo, 10)}
          <div class="ifood-acoes"><button class="btn btn-ghost btn-sm" id="ifrec-detalhe">Ver todos os registros</button></div>
        ` : `<p class="ifood-instrucao">Esta competência não tem arquivo de conciliação disponível.</p>`}
      ` : ""}
    </div>

    <div class="ifood-card">
      <div class="ifood-secao-rotulo">Reconciliation On Demand — sob demanda (assíncrona)</div>
      <p class="ifood-instrucao">Solicite a geração, depois clique em "Verificar status" — sem atualização automática. O status <code>enqueue</code>/<code>created</code> significa que ainda está processando; tente de novo em alguns instantes.</p>
      <div class="ifin-filtro">
        <label class="ifood-label">Competência (mês)<input type="month" id="ifrec-od-competencia" class="ifood-input" value="${esc(od.competencia)}" /></label>
        <button class="btn btn-primary" id="ifrec-od-solicitar" ${od.carregando ? "disabled" : ""}>${od.carregando ? "Solicitando…" : "Solicitar geração"}</button>
        <button class="btn btn-ghost" id="ifrec-od-verificar" ${!od.requestId || od.carregando ? "disabled" : ""}>Verificar status</button>
      </div>
      ${od.erro ? `<div class="ifood-aviso bad">${esc(od.erro)}</div>` : ""}
      ${od.requestId ? `<div class="ifood-info-linha"><span>requestId</span><strong class="mono">${esc(od.requestId)}</strong></div>` : ""}
      ${rOd ? `
        <div class="ifood-info-linha"><span>Status</span><strong><span class="pill ${statusOnDemandClasse(rOd.status)}">${esc(STATUS_OD_ROTULO[rOd.status] ?? rOd.status ?? "—")}</span></strong></div>
        ${rOd.status === "error" ? `<div class="ifood-aviso bad">${esc(rOd.mensagemErro || "A geração falhou.")}</div>` : ""}
        ${rOd.arquivo ? `
          <div class="ifood-info-linha"><span>Registros parseados</span><strong>${rOd.arquivo.totalLinhas}${rOd.arquivo.truncado ? " (exibindo os 2000 primeiros)" : ""}</strong></div>
          ${tabelaArquivo(rOd.arquivo, 10)}
          <div class="ifood-acoes"><button class="btn btn-ghost btn-sm" id="ifrec-od-detalhe">Ver todos os registros</button></div>
        ` : ""}
      ` : ""}
    </div>`;
}

// "Ver todos os registros" — tabela completa (até o teto de linhas exibidas
// pelo backend), não JSON bruto: o que importa aqui é ler os dados, não
// auditar o payload técnico (esse já foi mostrado nas outras abas).
function fecharDetalheArquivo() {
  el("#ifrec-arquivo-overlay")?.remove();
  document.removeEventListener("keydown", onKeyDetalheArquivo);
}
function onKeyDetalheArquivo(e) { if (e.key === "Escape") fecharDetalheArquivo(); }
function abrirDetalheArquivoConciliacao(titulo, resultado) {
  fecharDetalheArquivo();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "ifrec-arquivo-overlay";
  overlay.innerHTML = `
    <div class="modal modal-lg">
      <button class="modal-close" aria-label="Fechar" id="ifrec-arquivo-fechar">×</button>
      <h3>${esc(titulo)}</h3>
      <p class="ifood-instrucao">${resultado.arquivo.totalLinhas} registro(s)${resultado.arquivo.truncado ? " — exibindo os primeiros 2000" : ""}.</p>
      ${tabelaArquivo(resultado.arquivo)}
    </div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) fecharDetalheArquivo(); });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKeyDetalheArquivo);
  el("#ifrec-arquivo-fechar")?.addEventListener("click", fecharDetalheArquivo);
}

function statusAntecipacaoClasse(status) {
  if (status === "SUCCEED") return "ok";
  if (status === "FAILED") return "bad";
  return "muted"; // PENDING
}
const TIPO_ANTECIPACAO_ROTULO = { REPASSE_ANTECIPADO_DIARIO: "Diária (D+1)", REPASSE_ANTECIPADO_SEMANAL: "Semanal (D+7)" };

function linhaAntecipacao(a, idx) {
  return `
    <tr>
      <td>${esc(TIPO_ANTECIPACAO_ROTULO[a.tipo] ?? a.tipo ?? "—")}</td>
      <td class="num">${fmtMoeda(a.valorOriginal)}</td>
      <td class="num">${fmtMoeda(a.valorAntecipado)}</td>
      <td class="num">${fmtMoeda(a.taxa?.valor)} (${a.taxa?.percentual != null ? a.taxa.percentual + "%" : "—"})</td>
      <td><span class="pill ${statusAntecipacaoClasse(a.status)}">${esc(a.status ?? "—")}</span></td>
      <td>${fmtDataSimples(a.dataPagamentoOriginal)} → ${fmtDataSimples(a.dataPagamentoAntecipado)}</td>
      <td><button class="btn btn-ghost btn-sm" data-tipo="antecipacao" data-idx="${idx}">Ver detalhes</button></td>
    </tr>`;
}

function conteudoAbaAnticipation(f) {
  const an = f.anticipation;
  const r = an.resultado;
  const linhas = r?.antecipacoes?.length
    ? r.antecipacoes.map(linhaAntecipacao).join("")
    : `<tr><td colspan="7" class="ifood-vazio">${an.carregando ? "Consultando…" : "Nenhuma antecipação encontrada para este período."}</td></tr>`;

  return `
    <div class="ifin-filtro">
      <label class="ifood-label">Filtrar por
        <select id="ifant-modo" class="ifood-input">
          <option value="calculo" ${an.modo === "calculo" ? "selected" : ""}>Período de cálculo</option>
          <option value="pagamento" ${an.modo === "pagamento" ? "selected" : ""}>Data do pagamento antecipado</option>
        </select>
      </label>
      <label class="ifood-label">Data inicial<input type="date" id="ifant-inicio" class="ifood-input" value="${esc(an.inicio)}" /></label>
      <label class="ifood-label">Data final<input type="date" id="ifant-fim" class="ifood-input" value="${esc(an.fim)}" /></label>
      <button class="btn btn-primary" id="ifant-consultar" ${an.carregando ? "disabled" : ""}>${an.carregando ? "Consultando…" : "Consultar"}</button>
    </div>
    <p class="ifood-instrucao">Somente leitura — esta área não solicita antecipação, só mostra as que já existem. Sem paginação nesta API. O tipo (diária/semanal) reflete o plano já contratado pela loja, não uma opção que se escolhe aqui.</p>
    ${an.erro ? `<div class="ifood-aviso bad">${esc(an.erro)}</div>` : ""}
    ${r ? `
      <div class="ifood-info-linha"><span>Total antecipado no período (líquido)</span><strong>${fmtMoeda(r.saldo)}</strong></div>
      <div class="ifood-info-linha"><span>Antecipações no período</span><strong>${r.antecipacoes.length}</strong></div>
      <div class="tabela-wrap">
        <table class="grid">
          <thead><tr><th>Tipo</th><th class="num">Valor original</th><th class="num">Valor antecipado</th><th class="num">Taxa</th><th>Status</th><th>Data original → antecipada</th><th>Detalhes</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
    ` : ""}`;
}

// --- Visão Geral — camada de apresentação sobre o Bloco H -------------------
// PRIMEIRA aba do painel Financial. Mesmo endpoint da aba Conciliação
// (obterConciliacaoFinanceira, ifoodFinancial.service.js) — nenhuma conta
// nova aqui nem no backend, só leitura dos campos que o resultado já traz.
// As decisões de quais fontes estão disponíveis e quais pendências existem
// vêm de ifoodEstado.js#derivarFontesConciliacao/derivarPendenciasHomologacao
// (puras, testadas) — este arquivo só monta o HTML em cima delas.
function pillDisponibilidade(disponivel) {
  return `<span class="pill ${disponivel ? "ok" : "muted"}">${disponivel ? "Disponível" : "Indisponível"}</span>`;
}

// Os 4 transformadores "saude*" (Sales×Events/Events×Settlements/
// Settlements×Reconciliation/Anticipation) vêm de ifoodEstado.js — puros,
// testados, e reaproveitados também pela aba Evidências. Aqui só o HTML.
function blocoSaude(rotulo, info) {
  return `
    <div class="ifcon-fonte">
      <div><strong>${esc(rotulo)}</strong> ${pillStatusConciliacao(info.status)}</div>
      <div class="ifood-info-linha"><span>Esperado</span><strong>${esc(String(info.esperado))}</strong></div>
      <div class="ifood-info-linha"><span>Encontrado</span><strong>${esc(String(info.encontrado))}</strong></div>
      <div class="ifood-info-linha"><span>Diferença</span><strong>${esc(String(info.diferenca))}</strong></div>
      <p class="ifood-instrucao">${esc(info.explicacao)}</p>
    </div>`;
}

// DIVERGENTE em vermelho (é sempre um problema real); as demais pendências
// em amber — inclui NAO_COMPARAVEL, que o pedido é explícito em não tratar
// como erro.
const CLASSE_PENDENCIA = Object.freeze({ DIVERGENCIA_ENCONTRADA: "bad" });

// `status` tem default `estado.status` (comportamento real, inalterado) —
// parâmetro exposto só para permitir preview/testes injetarem um status
// sem precisar de login real (ver scratchpad/ifood-overview-preview.mjs).
export function conteudoAbaOverview(f, status = estado.status) {
  const r = f.resultado;
  const rc = r?.conciliacao;
  const merchant = status?.merchant;
  const homologacao = !!status?.homologacao;
  const fontes = derivarFontesConciliacao(r);
  const pendencias = derivarPendenciasHomologacao(r);

  const corpo = r ? `
    <div class="ifood-secao-rotulo">Resumo</div>
    <div class="ifcon-grid">
      <div class="ifcon-fonte">
        <div class="ifood-info-linha"><span>Merchant vinculado</span><strong>${merchant ? esc(merchant.nome || merchant.idMascarado || "—") : "Nenhuma loja vinculada"}</strong></div>
        <div class="ifood-info-linha"><span>Ambiente</span><strong>${homologacao ? "Homologação" : "Produção"}</strong></div>
        <div class="ifood-info-linha"><span>Período consultado</span><strong>${esc(r.periodo.inicio ?? "—")} a ${esc(r.periodo.fim ?? "—")}</strong></div>
        <div class="ifood-info-linha"><span>Status geral da conciliação</span><strong>${pillStatusConciliacao(rc.statusGeral)}</strong></div>
      </div>
      <div class="ifcon-fonte">
        <div class="ifood-secao-rotulo">Fontes</div>
        ${fontes.map((ft) => `
          <div class="ifood-info-linha"><span>${esc(ft.rotulo)}</span><strong>${pillDisponibilidade(ft.disponivel)}</strong></div>
          ${!ft.disponivel && ft.motivo ? `<p class="ifood-instrucao">${esc(ft.motivo)}</p>` : ""}
        `).join("")}
      </div>
      <div class="ifcon-fonte">
        <div class="ifood-secao-rotulo">Vendas</div>
        <div class="ifood-info-linha"><span>Total de vendas</span><strong>${r.vendas?.quantidade ?? "—"}</strong></div>
        <div class="ifood-info-linha"><span>Valor bruto de vendas</span><strong>${fmtMoeda(r.vendas?.bruto)}</strong></div>
        <div class="ifood-info-linha"><span>Saldo de vendas</span><strong>${fmtMoeda(r.vendas?.saldoVendas)}</strong></div>
      </div>
      <div class="ifcon-fonte">
        <div class="ifood-secao-rotulo">Eventos financeiros</div>
        <div class="ifood-info-linha"><span>Créditos financeiros</span><strong>${fmtMoeda(r.eventos?.creditos)}</strong></div>
        <div class="ifood-info-linha"><span>Débitos financeiros</span><strong>${fmtMoeda(r.eventos?.debitos)}</strong></div>
        <div class="ifood-info-linha"><span>Com impacto no repasse</span><strong>${r.eventos?.comImpactoTransferencia ?? "—"}</strong></div>
        <div class="ifood-info-linha"><span>Sem impacto no repasse</span><strong>${r.eventos?.semImpactoTransferencia ?? "—"}</strong></div>
        ${r.eventos?.impactoNaoInformado ? `<div class="ifood-info-linha"><span>Impacto no repasse não informado</span><strong>${r.eventos.impactoNaoInformado}</strong></div>` : ""}
        <div class="ifood-info-linha"><span>Saldo impactante</span><strong>${fmtMoeda(r.eventos?.saldoImpactante)}</strong></div>
      </div>
      <div class="ifcon-fonte">
        <div class="ifood-secao-rotulo">Settlements</div>
        <div class="ifood-info-linha"><span>Settlement balance</span><strong>${fmtMoeda(r.settlements?.balance)}</strong></div>
        <div class="ifood-info-linha"><span>Total de closingItems</span><strong>${fmtMoeda(r.settlements?.closingItemsTotal)}</strong></div>
      </div>
      <div class="ifcon-fonte">
        <div class="ifood-secao-rotulo">Reconciliation</div>
        <div class="ifood-info-linha"><span>Disponível</span><strong>${pillDisponibilidade(!!r.reconciliation?.disponivel)}</strong></div>
        <div class="ifood-info-linha"><span>Registros</span><strong>${r.reconciliation?.quantidadeRegistros ?? "—"}</strong></div>
      </div>
      <div class="ifcon-fonte">
        <div class="ifood-secao-rotulo">Anticipation</div>
        <div class="ifood-info-linha"><span>Antecipações encontradas</span><strong>${r.anticipation?.quantidade ?? "—"}</strong></div>
        <div class="ifood-info-linha"><span>Valor original antecipado</span><strong>${fmtMoeda(r.anticipation?.valorOriginal)}</strong></div>
        <div class="ifood-info-linha"><span>Taxas de antecipação</span><strong>${fmtMoeda(r.anticipation?.taxas)}</strong></div>
        <div class="ifood-info-linha"><span>Valor efetivamente antecipado</span><strong>${fmtMoeda(r.anticipation?.valorAntecipado)}</strong></div>
      </div>
      <div class="ifcon-fonte">
        <div class="ifood-secao-rotulo">Divergências</div>
        <div class="ifood-info-linha"><span>Quantidade</span><strong>${rc.divergencias?.length ?? 0}</strong></div>
      </div>
    </div>

    <div class="ifood-secao-rotulo">Saúde da Conciliação</div>
    <div class="ifcon-grid">
      ${blocoSaude("Sales × Events", saudeSalesVsEvents(rc.salesVsEvents))}
      ${blocoSaude("Events × Settlements", saudeEventsVsSettlements(rc.eventsVsSettlements))}
      ${blocoSaude("Settlements × Reconciliation", saudeSettlementsVsReconciliation(rc.settlementsVsReconciliation))}
    </div>

    <div class="ifood-secao-rotulo">Pendências de Homologação</div>
    ${pendencias.length
      ? pendencias.map((p) => `<div class="ifood-aviso ${CLASSE_PENDENCIA[p.codigo] ?? "warn"}">${esc(p.mensagem)}</div>`).join("")
      : `<div class="ifood-aviso ok">Nenhuma pendência identificada para este período.</div>`}
  ` : "";

  return `
    <div class="ifin-filtro">
      <label class="ifood-label">Data inicial<input type="date" id="ifov-inicio" class="ifood-input" value="${esc(f.inicio)}" /></label>
      <label class="ifood-label">Data final<input type="date" id="ifov-fim" class="ifood-input" value="${esc(f.fim)}" /></label>
      <button class="btn btn-primary" id="ifov-consultar" ${f.carregando ? "disabled" : ""}>${f.carregando ? "Carregando…" : "Atualizar"}</button>
    </div>
    <p class="ifood-instrucao">Visão consolidada da Homologação Financeira — mesma leitura do Bloco H (Sales → Events → Settlements → Reconciliation → Anticipation) usada na aba Conciliação, sem novo cálculo.</p>
    ${f.erro ? `<div class="ifood-aviso bad">${esc(f.erro)}</div>` : ""}
    ${corpo}`;
}

// --- Bloco H — Conciliação Financeira consolidada --------------------------
const STATUS_CONCILIACAO_CLASSE = {
  CONCILIADO: "ok", DIVERGENTE: "bad", INCOMPLETO: "warn", SEM_DADOS: "muted", NAO_COMPARAVEL: "info",
};
function pillStatusConciliacao(status) {
  return `<span class="pill ${STATUS_CONCILIACAO_CLASSE[status] ?? "muted"}">${esc(status ?? "—")}</span>`;
}

const FONTE_ROTULO = { sales: "Sales", events: "Financial Events", settlements: "Settlements", reconciliation: "Reconciliation", anticipations: "Anticipation" };

function linhaDivergencia(d) {
  return `
    <tr>
      <td><span class="mono">${esc(d.codigo)}</span></td>
      <td>${esc(d.origem ?? "—")}</td>
      <td class="num">${fmtMoeda(d.esperado)}</td>
      <td class="num">${fmtMoeda(d.encontrado)}</td>
      <td class="num">${fmtMoeda(d.diferenca)}</td>
      <td>${esc(d.explicacao ?? "—")}</td>
    </tr>`;
}

// Trilha Financeira: só Venda -> Eventos é rastreável por PEDIDO individual.
// Settlement/Reconciliation/Anticipation são calculados por PERÍODO (Bloco
// 2/3/4 do pedido — "não assumir que todo settlement pertence a uma venda
// específica") — por isso aparecem como camadas do período, não penduradas
// em cada venda.
function trilhaVenda(v) {
  const eventosHtml = v.eventos.length
    ? v.eventos.map((e) => `<div class="iftr-evento ${e.temImpactoRepasse === true ? "" : "iftr-sem-impacto"}"><span>${esc(e.nome ?? "—")}</span><strong>${fmtMoeda(e.valor)}</strong>${e.temImpactoRepasse === false ? '<span class="iftr-tag">sem impacto no repasse</span>' : e.temImpactoRepasse === true ? "" : '<span class="iftr-tag">impacto no repasse não informado</span>'}</div>`).join("")
    : `<div class="iftr-evento iftr-vazio">Nenhum evento encontrado para esta venda no período</div>`;

  return `
    <div class="iftr-item">
      <div class="iftr-no iftr-venda">
        <div><strong>Venda ${esc(v.saleShortId ?? v.saleId ?? "")}</strong> ${pillStatusConciliacao(v.status)}</div>
        <div class="ifood-instrucao">Saldo informado (Sales): ${fmtMoeda(v.saleBalance)}</div>
      </div>
      <div class="iftr-seta">↓</div>
      <div class="iftr-no iftr-eventos">
        <div class="ifood-secao-rotulo">Eventos financeiros (soma com impacto: ${fmtMoeda(v.somaEventosImpactantes)})</div>
        ${eventosHtml}
      </div>
    </div>`;
}

function conteudoAbaConciliation(f) {
  const c = f;
  const r = c.resultado;
  const rc = r?.conciliacao;

  const resumoFonte = (rotulo, disponivel, conteudoHtml) => `
    <div class="ifcon-fonte ${disponivel ? "" : "ifcon-fonte-ausente"}">
      <div class="ifood-secao-rotulo">${esc(rotulo)}</div>
      ${disponivel ? conteudoHtml : '<p class="ifood-instrucao">Não disponível para este período.</p>'}
    </div>`;

  const corpo = r ? `
    ${r.fontesComErro?.length ? `<div class="ifood-aviso warn">Não foi possível consultar: ${r.fontesComErro.map((e) => `${esc(FONTE_ROTULO[e.fonte] ?? e.fonte)} (${esc(e.mensagem)})`).join("; ")}.</div>` : ""}

    <div class="ifood-info-linha"><span>Status geral da conciliação</span><strong>${pillStatusConciliacao(rc.statusGeral)}</strong></div>
    <div class="ifood-info-linha"><span>Período</span><strong>${esc(r.periodo.inicio ?? "—")} a ${esc(r.periodo.fim ?? "—")}</strong></div>

    <div class="ifcon-grid">
      ${resumoFonte("Vendas (Sales)", !!r.vendas, r.vendas ? `
        <div class="ifood-info-linha"><span>Quantidade</span><strong>${r.vendas.quantidade}</strong></div>
        <div class="ifood-info-linha"><span>Valor bruto</span><strong>${fmtMoeda(r.vendas.bruto)}</strong></div>
        <div class="ifood-info-linha"><span>Saldo (líquido)</span><strong>${fmtMoeda(r.vendas.saldoVendas)}</strong></div>
      ` : "")}
      ${resumoFonte("Eventos financeiros", !!r.eventos, r.eventos ? `
        <div class="ifood-info-linha"><span>Quantidade</span><strong>${r.eventos.quantidade}</strong></div>
        <div class="ifood-info-linha"><span>Com impacto no repasse</span><strong>${r.eventos.comImpactoTransferencia}</strong></div>
        <div class="ifood-info-linha"><span>Sem impacto</span><strong>${r.eventos.semImpactoTransferencia}</strong></div>
        ${r.eventos.impactoNaoInformado ? `<div class="ifood-info-linha"><span>Impacto não informado</span><strong>${r.eventos.impactoNaoInformado}</strong></div>` : ""}
        <div class="ifood-info-linha"><span>Saldo impactante</span><strong>${fmtMoeda(r.eventos.saldoImpactante)}</strong></div>
      ` : "")}
      ${resumoFonte("Settlements", !!r.settlements, r.settlements ? `
        <div class="ifood-info-linha"><span>Títulos</span><strong>${r.settlements.quantidade}</strong></div>
        <div class="ifood-info-linha"><span>Balance</span><strong>${fmtMoeda(r.settlements.balance)}</strong></div>
      ` : "")}
      ${resumoFonte("Reconciliation", r.reconciliation?.disponivel, `
        <div class="ifood-info-linha"><span>Registros</span><strong>${r.reconciliation.quantidadeRegistros}</strong></div>
        <div class="ifood-info-linha"><span>Total identificado</span><strong>${fmtMoeda(r.reconciliation.totalIdentificado)}</strong></div>
        ${!r.reconciliation.colunaValorDetectada ? '<p class="ifood-instrucao">Coluna de valor não identificada automaticamente.</p>' : ""}
      `)}
      ${resumoFonte("Anticipation", (r.anticipation?.quantidade ?? 0) > 0, r.anticipation ? `
        <div class="ifood-info-linha"><span>Quantidade</span><strong>${r.anticipation.quantidade}</strong></div>
        <div class="ifood-info-linha"><span>Valor original</span><strong>${fmtMoeda(r.anticipation.valorOriginal)}</strong></div>
        <div class="ifood-info-linha"><span>Valor antecipado</span><strong>${fmtMoeda(r.anticipation.valorAntecipado)}</strong></div>
      ` : "")}
    </div>

    <div class="ifood-secao-rotulo">Comparações</div>
    <div class="ifcon-grid">
      <div class="ifcon-fonte"><div><strong>Sales × Events</strong> ${pillStatusConciliacao(rc.salesVsEvents.status)}</div>
        <p class="ifood-instrucao">${rc.salesVsEvents.quantidadeConciliadas} conciliada(s), ${rc.salesVsEvents.quantidadeDivergentes} divergente(s), ${rc.salesVsEvents.quantidadeIncompletas} incompleta(s) de ${rc.salesVsEvents.quantidadeVendas} venda(s).</p></div>
      <div class="ifcon-fonte"><div><strong>Events × Settlements</strong> ${pillStatusConciliacao(rc.eventsVsSettlements.status)}</div>
        <p class="ifood-instrucao">Eventos: ${fmtMoeda(rc.eventsVsSettlements.somaEventosImpactantes)} · Settlement: ${fmtMoeda(rc.eventsVsSettlements.settlementBalance)}${rc.eventsVsSettlements.divergencia != null ? ` · Diferença: ${fmtMoeda(rc.eventsVsSettlements.divergencia)}` : ""}</p></div>
      <div class="ifcon-fonte"><div><strong>Settlements × Reconciliation</strong> ${pillStatusConciliacao(rc.settlementsVsReconciliation.status)}</div>
        <p class="ifood-instrucao">${rc.settlementsVsReconciliation.motivo ? esc(rc.settlementsVsReconciliation.motivo) : `Settlement: ${fmtMoeda(rc.settlementsVsReconciliation.settlementBalance)} · Reconciliation: ${fmtMoeda(rc.settlementsVsReconciliation.totalReconciliationIdentificado)}`}</p></div>
    </div>

    ${rc.divergencias.length ? `
      <div class="ifood-secao-rotulo">Divergências (${rc.divergencias.length})</div>
      <div class="tabela-wrap">
        <table class="grid">
          <thead><tr><th>Código</th><th>Origem</th><th class="num">Esperado</th><th class="num">Encontrado</th><th class="num">Diferença</th><th>Explicação</th></tr></thead>
          <tbody>${rc.divergencias.map(linhaDivergencia).join("")}</tbody>
        </table>
      </div>
    ` : `<div class="ifood-aviso ok">Nenhuma divergência encontrada.</div>`}

    <div class="ifood-secao-rotulo">Trilha Financeira</div>
    <p class="ifood-instrucao">Venda → Eventos é rastreável por pedido. Settlement, Reconciliation e Antecipação são calculados por período (nunca presumimos que um settlement pertence a uma venda específica) — por isso aparecem no resumo acima, não pendurados em cada venda.</p>
    ${r.trilhaPorVenda?.length ? `<div class="iftr-lista">${r.trilhaPorVenda.slice(0, 15).map(trilhaVenda).join("")}</div>${r.trilhaPorVenda.length > 15 ? `<p class="ifood-instrucao">Exibindo as primeiras 15 de ${r.trilhaPorVenda.length} vendas.</p>` : ""}` : '<p class="ifood-instrucao">Nenhuma venda no período para montar a trilha.</p>'}
  ` : "";

  return `
    <div class="ifin-filtro">
      <label class="ifood-label">Data inicial<input type="date" id="ifcon-inicio" class="ifood-input" value="${esc(c.inicio)}" /></label>
      <label class="ifood-label">Data final<input type="date" id="ifcon-fim" class="ifood-input" value="${esc(c.fim)}" /></label>
      <button class="btn btn-primary" id="ifcon-consultar" ${c.carregando ? "disabled" : ""}>${c.carregando ? "Conciliando…" : "Conciliar"}</button>
    </div>
    <p class="ifood-instrucao">Cada API individual mantém seus próprios limites de período. A competência da Reconciliation é derivada automaticamente do mês da data inicial.</p>
    ${c.erro ? `<div class="ifood-aviso bad">${esc(c.erro)}</div>` : ""}
    ${corpo}`;
}

// --- Evidências — última aba. Camada de AUDITORIA, não de cálculo: só lê o
// que as outras abas já consultaram nesta sessão (via
// ifoodEstado.js#montarEvidenciaHomologacao) e apresenta de forma
// profissional, pronta pra uma chamada de homologação com o iFood. Nenhum
// dado novo é buscado aqui — "Gerar evidência" só stampa o momento e
// re-renderiza; os NÚMEROS vêm do Bloco H (aba Conciliação), os EXEMPLOS
// crus vêm de cada aba individual (Sales/Events/Settlements/Reconciliation/
// Anticipation), se já tiverem sido consultadas.
function exemploSanitizadoHtml(exemplo) {
  return exemplo
    ? `<details class="ifev-exemplo"><summary>Ver exemplo sanitizado</summary><pre class="ifin-json">${esc(JSON.stringify(exemplo, null, 2))}</pre></details>`
    : `<p class="ifood-instrucao">Nenhum exemplo consultado nesta sessão — abra a aba correspondente, consulte, e gere a evidência de novo.</p>`;
}

function blocoEvidenciaApi(rotulo, bloco, linhasEspecificas) {
  return `
    <div class="ifcon-fonte ${bloco.disponivel ? "" : "ifcon-fonte-ausente"}">
      <div class="ifood-secao-rotulo">${esc(rotulo)}</div>
      <div class="ifood-info-linha"><span>Consultada nesta sessão</span><strong>${bloco.consultada ? "Sim" : "Não"}</strong></div>
      <div class="ifood-info-linha"><span>Disponível (Bloco H)</span><strong>${pillDisponibilidade(bloco.disponivel)}</strong></div>
      ${linhasEspecificas}
      <div class="ifood-info-linha"><span>Período consultado</span><strong>${bloco.periodo ? `${esc(bloco.periodo.inicio ?? "—")} a ${esc(bloco.periodo.fim ?? "—")}` : "—"}</strong></div>
      ${bloco.erro ? `<p class="ifood-instrucao">Erro nesta sessão: ${esc(bloco.erro)}</p>` : ""}
      ${exemploSanitizadoHtml(bloco.exemplo)}
    </div>`;
}

const FORMATO_ARQUIVO_ROTULO = { csv: "CSV (sem compressão)", csv_gzip: "CSV comprimido (gzip)" };
const DELIMITADOR_ROTULO = { ",": "vírgula ( , )", ";": "ponto e vírgula ( ; )" };

// `status`/`financeiro` têm default `estado.status`/`estado.financeiro`
// (comportamento real, inalterado) — expostos só pra permitir preview/testes
// injetarem um retrato sem precisar de login real (mesmo padrão de
// conteudoAbaOverview — ver scratchpad/ifood-overview-preview.mjs).
export function conteudoAbaEvidencia(f, status = estado.status, financeiro = estado.financeiro) {
  if (!f.geradoEm) {
    return `
      <p class="ifood-instrucao">Esta aba não consulta nada sozinha: ela lê o que as abas Sales, Financial Events, Settlements, Reconciliation, Anticipation e Conciliação já buscaram nesta sessão e monta um retrato para auditoria. Consulte o que fizer sentido nas outras abas (ou gere direto, para ver o que ainda falta) e clique em "Gerar evidência".</p>
      <div class="ifin-filtro">
        <button class="btn btn-primary" id="ifev-gerar">Gerar evidência</button>
      </div>`;
  }

  const evidencia = montarEvidenciaHomologacao({ geradoEm: f.geradoEm, status, financeiro });
  const r = evidencia.resumo;
  const v = evidencia.validacoes;
  const a = evidencia.apis;

  const rotuloFontes = (lista) => lista.length ? lista.map((fonte) => esc(FONTE_ROTULO[fonte] ?? fonte)).join(", ") : "—";

  return `
    <div class="ifin-filtro">
      <button class="btn btn-primary" id="ifev-gerar">${f.geradoEm ? "Atualizar evidência" : "Gerar evidência"}</button>
      <button class="btn btn-ghost" id="ifev-modo-tecnico">${f.modoTecnico ? "Ocultar evidência técnica" : "Ver evidência técnica"}</button>
      <button class="btn btn-ghost" id="ifev-exportar-json">Exportar JSON</button>
      <button class="btn btn-ghost" id="ifev-exportar-html">Exportar HTML</button>
    </div>
    <p class="ifood-instrucao">Gerada em ${esc(fmtDataHora(evidencia.geradoEm))}. Reflete só o que já foi consultado nesta sessão — nenhum número aqui é recalculado, tudo vem do resultado já validado da Conciliação (Bloco H) e das abas individuais.</p>

    <div class="ifood-secao-rotulo">Resumo da Consulta</div>
    <div class="ifcon-grid">
      <div class="ifcon-fonte">
        <div class="ifood-info-linha"><span>Ambiente</span><strong>${evidencia.ambiente === "homologacao" ? "Homologação" : "Produção"}</strong></div>
        <div class="ifood-info-linha"><span>Merchant</span><strong>${esc(evidencia.merchant?.nome || evidencia.merchant?.idMascarado || "Nenhuma loja vinculada")}</strong></div>
        <div class="ifood-info-linha"><span>Período consultado</span><strong>${r.periodoConsultado ? `${esc(r.periodoConsultado.inicio ?? "—")} a ${esc(r.periodoConsultado.fim ?? "—")}` : "—"}</strong></div>
        <div class="ifood-info-linha"><span>Competência</span><strong>${esc(r.competencia ?? "—")}</strong></div>
        <div class="ifood-info-linha"><span>Status geral da conciliação</span><strong>${pillStatusConciliacao(r.statusGeralConciliacao)}</strong></div>
      </div>
      <div class="ifcon-fonte">
        <div class="ifood-secao-rotulo">Fontes</div>
        <div class="ifood-info-linha"><span>Consultadas</span><strong>${rotuloFontes(r.fontesConsultadas)}</strong></div>
        <div class="ifood-info-linha"><span>Disponíveis</span><strong>${rotuloFontes(r.fontesDisponiveis)}</strong></div>
        ${r.fontesComErro.length
          ? r.fontesComErro.map((e) => `<p class="ifood-instrucao">${esc(FONTE_ROTULO[e.fonte] ?? e.fonte)}: ${esc(e.mensagem)}</p>`).join("")
          : `<div class="ifood-info-linha"><span>Com erro</span><strong>Nenhuma</strong></div>`}
      </div>
    </div>
    ${!v.disponivel ? `<div class="ifood-aviso warn">A aba Conciliação ainda não foi consultada nesta sessão — os números por API e as validações abaixo ficam vazios até rodar "Conciliar" lá.</div>` : ""}

    <div class="ifood-secao-rotulo">Evidências por API</div>
    <div class="ifcon-grid">
      ${blocoEvidenciaApi(FONTE_ROTULO.sales, a.sales, `
        <div class="ifood-info-linha"><span>Quantidade de vendas</span><strong>${a.sales.quantidade ?? "—"}</strong></div>
        <div class="ifood-info-linha"><span>Valor bruto</span><strong>${fmtMoeda(a.sales.valorBruto)}</strong></div>
        <div class="ifood-info-linha"><span>Saldo</span><strong>${fmtMoeda(a.sales.saldo)}</strong></div>
      `)}
      ${blocoEvidenciaApi(FONTE_ROTULO.events, a.events, `
        <div class="ifood-info-linha"><span>Quantidade de eventos</span><strong>${a.events.quantidade ?? "—"}</strong></div>
        <div class="ifood-info-linha"><span>Créditos</span><strong>${fmtMoeda(a.events.creditos)}</strong></div>
        <div class="ifood-info-linha"><span>Débitos</span><strong>${fmtMoeda(a.events.debitos)}</strong></div>
        <div class="ifood-info-linha"><span>hasTransferImpact=true</span><strong>${a.events.comImpactoTransferencia ?? "—"}</strong></div>
        <div class="ifood-info-linha"><span>hasTransferImpact=false</span><strong>${a.events.semImpactoTransferencia ?? "—"}</strong></div>
        <div class="ifood-info-linha"><span>Saldo impactante</span><strong>${fmtMoeda(a.events.saldoImpactante)}</strong></div>
      `)}
      ${blocoEvidenciaApi(FONTE_ROTULO.settlements, a.settlements, `
        <div class="ifood-info-linha"><span>Quantidade</span><strong>${a.settlements.quantidade ?? "—"}</strong></div>
        <div class="ifood-info-linha"><span>Balance</span><strong>${fmtMoeda(a.settlements.balance)}</strong></div>
        <div class="ifood-info-linha"><span>closingItemsTotal</span><strong>${fmtMoeda(a.settlements.closingItemsTotal)}</strong></div>
      `)}
      ${blocoEvidenciaApi(FONTE_ROTULO.reconciliation, a.reconciliation, `
        <div class="ifood-info-linha"><span>Competência</span><strong>${esc(a.reconciliation.competencia ?? "—")}</strong></div>
        <div class="ifood-info-linha"><span>Registros</span><strong>${a.reconciliation.quantidadeRegistros ?? "—"}</strong></div>
        <div class="ifood-info-linha"><span>Hash verificado</span><strong>${a.reconciliation.hashVerificado === null ? "Não informado pelo iFood" : a.reconciliation.hashVerificado ? "Sim" : "Não confere"}</strong></div>
        <div class="ifood-info-linha"><span>Formato detectado</span><strong>${esc(FORMATO_ARQUIVO_ROTULO[a.reconciliation.formatoDetectado] ?? "—")}</strong></div>
        <div class="ifood-info-linha"><span>Delimitador detectado</span><strong>${esc(DELIMITADOR_ROTULO[a.reconciliation.delimitadorDetectado] ?? "—")}</strong></div>
        <div class="ifood-info-linha"><span>On Demand</span><strong>${a.reconciliation.onDemand.consultado ? esc(a.reconciliation.onDemand.status ?? "—") : "Não utilizado nesta sessão"}</strong></div>
        ${a.reconciliation.onDemand.mensagemErro ? `<p class="ifood-instrucao">On Demand: ${esc(a.reconciliation.onDemand.mensagemErro)}</p>` : ""}
      `)}
      ${blocoEvidenciaApi(FONTE_ROTULO.anticipations, a.anticipation, `
        <div class="ifood-info-linha"><span>Quantidade</span><strong>${a.anticipation.quantidade ?? "—"}</strong></div>
        <div class="ifood-info-linha"><span>Valor original</span><strong>${fmtMoeda(a.anticipation.valorOriginal)}</strong></div>
        <div class="ifood-info-linha"><span>Taxas</span><strong>${fmtMoeda(a.anticipation.taxas)}</strong></div>
        <div class="ifood-info-linha"><span>Valor antecipado</span><strong>${fmtMoeda(a.anticipation.valorAntecipado)}</strong></div>
      `)}
    </div>

    <div class="ifood-secao-rotulo">Validações Financeiras</div>
    ${v.disponivel ? `
      <div class="ifcon-grid">
        ${blocoSaude("Sales × Events", v.salesVsEvents)}
        ${blocoSaude("Events × Settlements", v.eventsVsSettlements)}
        ${blocoSaude("Settlements × Reconciliation", v.settlementsVsReconciliation)}
        ${blocoSaude("Anticipation (matemática)", v.anticipation)}
      </div>
      ${v.divergencias.length ? `
        <div class="ifood-secao-rotulo">Divergências (${v.divergencias.length})</div>
        <div class="tabela-wrap">
          <table class="grid">
            <thead><tr><th>Código</th><th>Origem</th><th class="num">Esperado</th><th class="num">Encontrado</th><th class="num">Diferença</th><th>Explicação</th></tr></thead>
            <tbody>${v.divergencias.map(linhaDivergencia).join("")}</tbody>
          </table>
        </div>
      ` : `<div class="ifood-aviso ok">Nenhuma divergência encontrada.</div>`}
    ` : ""}

    ${f.modoTecnico ? `
      <div class="ifood-secao-rotulo">Evidência técnica (JSON sanitizado)</div>
      <p class="ifood-instrucao">Mesmo conteúdo do arquivo exportado — toda chave sensível (token, secret, authorization, URL assinada) já sai como "[REDACTED]".</p>
      <pre class="ifin-json">${esc(montarExportacaoJson(evidencia))}</pre>
    ` : ""}`;
}

function pintarFinanceiro() {
  const view = el("#view");
  const f = estado.financeiro;
  if (!view || !f) return;

  view.innerHTML = `
    <div class="ifood-page">
      <div class="vd-head ifood-head">
        <div class="vd-head-txt">
          <h2>Homologação Financeira${badgeHomologacao()}</h2>
          <p>Dados do ambiente de teste iFood, somente leitura — evidência para a homologação do módulo Financial.</p>
        </div>
        <button class="btn btn-ghost" id="ifin-voltar">Voltar ao status</button>
      </div>
      ${abasHtml(f)}
      ${f.aba === "reconciliation" ? conteudoAbaReconciliation(f) : `<div class="ifood-card">
        ${f.aba === "overview" ? conteudoAbaOverview(f.overview)
          : f.aba === "sales" ? conteudoAbaSales(f)
          : f.aba === "events" ? conteudoAbaEvents(f)
          : f.aba === "settlements" ? conteudoAbaSettlements(f)
          : f.aba === "anticipation" ? conteudoAbaAnticipation(f)
          : f.aba === "evidencia" ? conteudoAbaEvidencia(f.evidencia)
          : conteudoAbaConciliation(f.conciliation)}
      </div>`}
    </div>`;

  el("#ifin-voltar")?.addEventListener("click", fecharFinanceiro);
  els("[data-aba]", view).forEach((btn) => btn.addEventListener("click", () => { f.aba = btn.dataset.aba; pintarFinanceiro(); }));

  if (f.aba === "overview") {
    el("#ifov-consultar")?.addEventListener("click", buscarOverview);
  } else if (f.aba === "sales") {
    const s = f.sales;
    el("#ifin-consultar")?.addEventListener("click", () => buscarSales({ resetarPagina: true }));
    el("#ifin-anterior")?.addEventListener("click", () => { s.page -= 1; buscarSales({ resetarPagina: false }); });
    el("#ifin-proxima")?.addEventListener("click", () => { s.page += 1; buscarSales({ resetarPagina: false }); });
    els("[data-tipo='venda']", view).forEach((btn) => btn.addEventListener("click", () => {
      const venda = s.resultado?.vendas?.find((v) => String(v.id) === btn.dataset.id);
      if (venda) abrirDetalheItem(`Venda ${venda.shortId ?? venda.id ?? ""}`, [
        ["Status", venda.status ?? "—"],
        ["Criado em", venda.criadoEm ? fmtDataHora(venda.criadoEm) : "—"],
        ["Valor bruto", fmtMoeda(venda.valorBruto?.total)],
        ["Saldo líquido", venda.resumoFinanceiro ? fmtMoeda(venda.resumoFinanceiro.saldo) : "—"],
      ], venda);
    }));
  } else if (f.aba === "events") {
    const ev = f.events;
    el("#ifin-consultar")?.addEventListener("click", () => buscarEvents({ resetarPagina: true }));
    el("#ifin-anterior")?.addEventListener("click", () => { ev.page -= 1; buscarEvents({ resetarPagina: false }); });
    el("#ifin-proxima")?.addEventListener("click", () => { ev.page += 1; buscarEvents({ resetarPagina: false }); });
    els("[data-tipo='evento']", view).forEach((btn) => btn.addEventListener("click", () => {
      const evento = ev.resultado?.eventos?.[Number(btn.dataset.idx)];
      if (evento) abrirDetalheItem(evento.nome || "Evento financeiro", [
        ["Descrição", evento.descricao ?? "—"],
        ["Gatilho", evento.gatilho ?? "—"],
        ["Data/hora", evento.dataHora ? fmtDataHora(evento.dataHora) : "—"],
        ["Valor", fmtMoeda(evento.valor)],
        ["Impacta repasse", rotuloImpactoRepasse(evento.temImpactoRepasse)],
        ["Repasse esperado", fmtDataSimples(evento.dataRepasseEsperada)],
      ], evento);
    }));
  } else if (f.aba === "settlements") {
    const st = f.settlements;
    el("#ifin-consultar")?.addEventListener("click", buscarSettlements);
    els("[data-tipo='settlement']", view).forEach((btn) => btn.addEventListener("click", () => {
      const titulo = st.resultado?.titulos?.[Number(btn.dataset.idx)];
      if (!titulo) return;
      const campos = [
        ["Tipo", titulo.tipo ?? "—"],
        ["Valor", fmtMoeda(titulo.valor)],
        ["Status", titulo.status ?? "—"],
        ["Data de pagamento", fmtDataSimples(titulo.dataPagamento)],
        ["Período de apuração", titulo.periodoApuracao ? `${fmtDataSimples(titulo.periodoApuracao.inicio)} – ${fmtDataSimples(titulo.periodoApuracao.fim)}` : "Não aplicável (título avulso)"],
      ];
      if (titulo.contaBancaria) campos.push(["Banco", `${titulo.contaBancaria.banco ?? "—"} (ag. ${titulo.contaBancaria.agencia ?? "—"}, conta ${titulo.contaBancaria.conta ?? "—"})`]);
      abrirDetalheItem(`Título ${titulo.id ?? ""}`, campos, titulo);
    }));
  } else if (f.aba === "reconciliation") {
    const rec = f.reconciliation;
    el("#ifrec-consultar")?.addEventListener("click", buscarReconciliation);
    el("#ifrec-od-solicitar")?.addEventListener("click", solicitarReconciliationOnDemand);
    el("#ifrec-od-verificar")?.addEventListener("click", verificarStatusReconciliationOnDemand);
    el("#ifrec-detalhe")?.addEventListener("click", () => {
      if (rec.resultado?.arquivo) abrirDetalheArquivoConciliacao(`Conciliação — ${rec.competencia}`, rec.resultado);
    });
    el("#ifrec-od-detalhe")?.addEventListener("click", () => {
      if (rec.onDemand.resultado?.arquivo) abrirDetalheArquivoConciliacao(`Conciliação sob demanda — ${rec.onDemand.competencia}`, rec.onDemand.resultado);
    });
  } else if (f.aba === "anticipation") {
    const an = f.anticipation;
    el("#ifant-consultar")?.addEventListener("click", buscarAnticipation);
    els("[data-tipo='antecipacao']", view).forEach((btn) => btn.addEventListener("click", () => {
      const a = an.resultado?.antecipacoes?.[Number(btn.dataset.idx)];
      if (!a) return;
      const campos = [
        ["Tipo", TIPO_ANTECIPACAO_ROTULO[a.tipo] ?? a.tipo ?? "—"],
        ["Valor original", fmtMoeda(a.valorOriginal)],
        ["Valor antecipado", fmtMoeda(a.valorAntecipado)],
        ["Taxa", `${fmtMoeda(a.taxa?.valor)} (${a.taxa?.percentual != null ? a.taxa.percentual + "%" : "—"})`],
        ["Status", a.status ?? "—"],
        ["Data de pagamento original", fmtDataSimples(a.dataPagamentoOriginal)],
        ["Data de pagamento antecipado", fmtDataSimples(a.dataPagamentoAntecipado)],
        ["Período de apuração", a.periodoApuracao ? `${fmtDataSimples(a.periodoApuracao.inicio)} – ${fmtDataSimples(a.periodoApuracao.fim)}` : "—"],
      ];
      if (a.contaBancaria) campos.push(["Banco", `${a.contaBancaria.banco ?? "—"} (ag. ${a.contaBancaria.agencia ?? "—"}, conta ${a.contaBancaria.conta ?? "—"})`]);
      abrirDetalheItem(TIPO_ANTECIPACAO_ROTULO[a.tipo] ?? a.tipo ?? "Antecipação", campos, a);
    }));
  } else if (f.aba === "evidencia") {
    el("#ifev-gerar")?.addEventListener("click", gerarEvidencia);
    el("#ifev-modo-tecnico")?.addEventListener("click", alternarModoTecnico);
    el("#ifev-exportar-json")?.addEventListener("click", exportarEvidenciaJson);
    el("#ifev-exportar-html")?.addEventListener("click", exportarEvidenciaHtml);
  } else {
    el("#ifcon-consultar")?.addEventListener("click", buscarConciliation);
  }
}

// --- "Ver detalhes" — JSON sanitizado (Bloco L). Nunca há token/secret aqui:
// vem de ifoodFinancial.mapper.js, que só devolve campos de negócio. Genérico
// pra qualquer item (venda ou evento) — reaproveitado pelas duas abas. -------
function onKeyDetalheItem(e) { if (e.key === "Escape") fecharDetalheItem(); }
function fecharDetalheItem() {
  el("#ifin-detalhe-overlay")?.remove();
  document.removeEventListener("keydown", onKeyDetalheItem);
}
function abrirDetalheItem(titulo, camposDestaque, itemBruto) {
  fecharDetalheItem();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "ifin-detalhe-overlay";
  const destaque = camposDestaque.map(([rotulo, valor]) =>
    `<div class="ifood-info-linha"><span>${esc(rotulo)}</span><strong>${esc(String(valor))}</strong></div>`).join("");
  overlay.innerHTML = `
    <div class="modal">
      <button class="modal-close" aria-label="Fechar" id="ifin-detalhe-fechar">×</button>
      <h3>${esc(titulo)}</h3>
      ${destaque}
      <div class="ifood-secao-rotulo">Detalhe técnico (JSON sanitizado — sem token/secret)</div>
      <pre class="ifin-json">${esc(JSON.stringify(itemBruto, null, 2))}</pre>
    </div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) fecharDetalheItem(); });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKeyDetalheItem);
  el("#ifin-detalhe-fechar")?.addEventListener("click", fecharDetalheItem);
}

// ---------------------------------------------------------------------------
// helpers de UI
// ---------------------------------------------------------------------------
function mostrarMsg(texto, classe = "") {
  const alvo = el("#ifood-msg");
  if (alvo) { alvo.textContent = texto; alvo.className = `ifood-msg ${classe}`; }
}

async function carregarStatusSilencioso() {
  try { const { data } = await api.ifoodStatus(); estado.status = data; } catch { /* mantém o anterior */ }
}

// ---------------------------------------------------------------------------
export function renderIfood() {
  pararContador();
  estado.wizard = null;
  const view = el("#view");
  if (view) view.innerHTML = `<div class="ifood-page"><div class="ifood-card"><div class="ifood-msg">Carregando integração iFood…</div></div></div>`;
  carregarStatus();
}
