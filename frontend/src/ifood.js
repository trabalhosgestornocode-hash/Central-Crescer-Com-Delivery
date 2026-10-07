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
  rotuloStatusPedido, rotuloTipoPedido, ORDER_ROTULO, EVENTS_ROTULO, derivarEstadoOrder, derivarEstadoEvents, textoAtencao,
  resumirPagamentosVenda, rotuloMetodoPagamento, rotuloResponsavelPagamento, rotuloTipoPagamento, classificarLancamentosVenda,
  FASE_ON_DEMAND_ROTULO, MENSAGEM_ERRO_OD_SEM_MOTIVO, mascararRequestId, TEXTO_FONTE_ON_DEMAND, TEXTO_AMOSTRA_HOMOLOGACAO,
  itemParaJsonTecnico, derivarHistoricoOnDemand,
} from "./ifoodEstado.js";
import { criarAcompanhamentoReconciliacao } from "./ifoodReconciliacaoPolling.js";

const IFOOD_LOGO = "/assets/menu-dashboard-ifood.png";

const estado = {
  status: null,
  statusErro: null, // mensagem quando GET /status FALHOU (estado real desconhecido — nunca vira "Não conectado")
  carregando: false,
  wizard: null,   // { etapa, appType, sessionId, userCode, verificationUrlComplete, expiraEm, timer, feito:{analytics,financial}, selecao }
  financeiro: null, // { inicio, fim, page, carregando, resultado, erro } — Homologação Financeira (Sales)
  pedidos: null,    // { carregando, lista, erro, consultadoEm } — tela Pedidos iFood (leitura do banco local)
};

// Fase F (auditoria de troca de contexto): trocar de unidade pelo seletor
// global não passa por renderIfood() se o usuário está em outra tela. Sem
// isto, um contador (setInterval) da unidade A seguiria rodando sobre o
// contexto da unidade B.
registrarResetDeContexto(() => {
  pararContador();
  pararAcompanhamentoOnDemand(); // o polling da unidade A nunca segue rodando na unidade B
  estado.status = null;
  estado.statusErro = null;
  estado.wizard = null;
  estado.financeiro = null; // nunca deixa dado financeiro de uma unidade vazar pra outra
  estado.pedidos = null;    // idem para os pedidos
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

const valorLinha = ([, v, tipo]) => (v == null || v === "" ? "—" : tipo === "data" ? fmtDataHora(v) : v);
const linhasInfo = (linhas) => linhas.map((l) => `<div class="ifood-info-linha"><span>${esc(l[0])}</span><strong>${esc(valorLinha(l))}</strong></div>`).join("");

// OPERAÇÃO — Pedidos (app Order) e Eventos, cada um com o SEU estado (separado de analytics/financial).
// Pedidos: fora do piloto (`order` null) é "Ainda não disponível para esta unidade" — informativo, sem
// ação e sem cara de erro. Só leitura: nenhuma ação de pedido sai desta tela. O botão de conectar só
// aparece para a unidade piloto e exige a loja já vinculada (o recebimento de eventos usa o merchant).
function blocoOperacao(statusApi, merchant) {
  const o = derivarEstadoOrder(statusApi?.order);
  const ev = derivarEstadoEvents(statusApi?.eventosRecebimento, statusApi?.order);
  const botaoOrder = o.podeConectar
    ? (merchant
      ? `<button class="btn btn-ghost" id="ifood-acao-conectar_order" data-acao="conectar_order">${o.chave === "reauth" ? "Reconectar pedidos" : "Conectar pedidos"}</button>`
      : `<p class="ifood-instrucao" id="ifood-order-sem-loja">Vincule a loja iFood desta unidade para conectar os pedidos.</p>`)
    : "";
  return `
    <div class="ifood-card" id="ifood-operacao">
      <div class="ifood-secao-rotulo">Operação</div>
      <div class="ifood-apps">
        <div class="ifood-app-linha" id="ifood-order-status">
          <span class="ifood-app-nome">${esc(ORDER_ROTULO)}</span>
          <span class="pill ${o.classe}" id="ifood-order-pill">${esc(o.rotulo)}</span>
        </div>
        ${o.erro ? `<div class="ifood-aviso ${o.classe === "bad" ? "bad" : "warn"}" id="ifood-order-erro">${esc(o.erro.mensagem)}</div>` : ""}
        ${linhasInfo(o.linhas)}
        ${botaoOrder}
        <div class="ifood-app-linha" id="ifood-events-status">
          <span class="ifood-app-nome">${esc(EVENTS_ROTULO)}</span>
          <span class="pill ${ev.classe}" id="ifood-events-pill">${esc(ev.rotulo)}</span>
        </div>
        ${ev.aviso ? `<div class="ifood-aviso warn" id="ifood-events-aviso">${esc(ev.aviso)}</div>` : ""}
        ${linhasInfo(ev.linhas)}
      </div>
    </div>`;
}

// DADOS — Desempenho (Analytics) e Financeiro, como antes (assistente próprio).
function blocoDados(e) {
  return `
    <div class="ifood-card" id="ifood-dados">
      <div class="ifood-secao-rotulo">Dados</div>
      <div class="ifood-apps">
        ${linhaApp(APP_ROTULO.analytics, e.apps.analytics)}
        ${linhaApp(APP_ROTULO.financial, e.apps.financial)}
      </div>
    </div>`;
}

// LOJA IFOOD VINCULADA — só dados que já existem (nada de métrica inventada).
function blocoLoja(e, statusApi) {
  const m = e.merchant;
  const ultimoEvento = statusApi?.order?.ultimoEvento ?? null;
  return `
    <div class="ifood-card" id="ifood-loja">
      <div class="ifood-secao-rotulo">Loja iFood vinculada</div>
      ${m ? `
        <div class="ifood-merchant">
          <div class="ifood-merchant-nome">${esc(m.nome || "—")}</div>
          <div class="ifood-merchant-meta">Razão social: ${esc(m.razaoSocial || "—")}</div>
          <div class="ifood-merchant-meta">Merchant: <span class="mono">${esc(m.idMascarado || "—")}</span></div>
        </div>` : `<div class="ifood-merchant vazio">Nenhuma loja iFood vinculada</div>`}
      <div class="ifood-info-linha"><span>Conectada em</span><strong>${e.conectadaEm ? fmtDataHora(e.conectadaEm) : "—"}</strong></div>
      <div class="ifood-info-linha"><span>Última atualização</span><strong>${statusApi?.ultimaSincronizacao ? fmtDataHora(statusApi.ultimaSincronizacao) : "—"}</strong></div>
      ${ultimoEvento ? `<div class="ifood-info-linha"><span>Último evento recebido</span><strong>${fmtDataHora(ultimoEvento)}</strong></div>` : ""}
    </div>`;
}

/**
 * HTML do painel de status (estado já carregado, sem erro de status). PURO: só lê `statusApi` — sem DOM,
 * sem rede. Usado por pintarPainel() e pelos testes/preview da tela.
 * Hierarquia: status geral -> OPERAÇÃO (Pedidos, Eventos) -> DADOS (Analytics, Financeiro) -> LOJA VINCULADA.
 * "Ver pedidos iFood" só aparece com o Order CONECTADO na unidade.
 */
export function montarHtmlPainel(statusApi) {
  const e = derivarEstadoIntegracao(statusApi);
  const acoes = acoesDoPainel(e).map((a) =>
    `<button class="btn ${a.primaria ? "btn-primary" : "btn-ghost"}" id="ifood-acao-${a.id}" data-acao="${a.id}">${esc(a.rotulo)}</button>`);
  return `
    <div class="ifood-page">
      <div class="vd-head ifood-head">
        <div class="ifood-head-id">
          <img src="${IFOOD_LOGO}" alt="iFood" class="ifood-head-logo" />
          <div class="vd-head-txt">
            <h2>Integração iFood <span class="pill ${e.classe}" id="ifood-status-pill">${esc(e.rotulo)}</span>${badgeHomologacao(statusApi)}</h2>
            <p>Conecte esta unidade ao iFood para centralizar pedidos, eventos e dados da operação. Cada módulo é ativado de forma controlada, conforme a configuração da loja.</p>
          </div>
        </div>
      </div>

      <div class="ifood-card" id="ifood-geral">
        ${e.aviso ? `<div class="ifood-aviso warn" id="ifood-aviso-estado">${esc(e.aviso)}</div>` : ""}
        ${statusApi?.ultimoErro ? `<div class="ifood-aviso bad">${esc(statusApi.ultimoErro)}</div>` : ""}
        ${textoAtencao(statusApi?.atencao) ? `<div class="ifood-aviso warn" id="ifood-atencao">${esc(textoAtencao(statusApi.atencao))}</div>` : ""}
        <div class="ifood-acoes">${acoes.join("") || '<span class="ifood-tudo-ok">Integração conectada.</span>'}</div>
      </div>

      ${blocoOperacao(statusApi, e.merchant)}
      ${blocoDados(e)}
      ${blocoLoja(e, statusApi)}

      ${e.merchant && statusApi?.order?.conectado ? `
        <div class="ifood-card">
          <div class="ifood-secao-rotulo">Pedidos iFood</div>
          <p class="ifood-instrucao">Pedidos recebidos da loja vinculada, com o status oficial informado pelo iFood.</p>
          <button class="btn btn-ghost" id="ifood-abrir-pedidos">Ver pedidos iFood</button>
        </div>
      ` : ""}

      ${e.apps.financial.conectado && e.merchant ? `
        <div class="ifood-card">
          <div class="ifood-secao-rotulo">Homologação Financeira</div>
          <p class="ifood-instrucao">Consulta de dados financeiros do ambiente de teste (API Sales) para gerar evidência junto ao iFood. Nesta fase, só leitura — nenhum dado alimenta o Dashboard iFood ou o lançamento diário.</p>
          <button class="btn btn-ghost" id="ifood-abrir-financeiro">Abrir Homologação Financeira</button>
        </div>
      ` : ""}
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

  view.innerHTML = montarHtmlPainel(estado.status);

  ligarAcoesDoPainel();
  el("#ifood-abrir-financeiro")?.addEventListener("click", abrirFinanceiro);
  el("#ifood-abrir-pedidos")?.addEventListener("click", abrirPedidos);
}

// ---------------------------------------------------------------------------
// Pedidos iFood — só leitura. O status exibido é o OFICIAL (muda só por evento do iFood);
// nenhuma ação (confirmar/despachar/cancelar) é disparada desta tela.
// ---------------------------------------------------------------------------
function abrirPedidos() {
  estado.pedidos = { carregando: false, lista: null, erro: null, consultadoEm: null };
  carregarPedidos();
}

function fecharPedidos() {
  estado.pedidos = null;
  pintarPainel();
}

async function carregarPedidos() {
  const p = estado.pedidos;
  if (!p) return;
  p.carregando = true;
  p.erro = null;
  pintarPedidos();
  try {
    const { data } = await api.ifoodPedidos();
    if (estado.pedidos !== p) return;               // saiu da tela / trocou de unidade no meio
    p.lista = data?.pedidos ?? [];
    p.consultadoEm = new Date().toISOString();
  } catch (e) {
    if (estado.pedidos !== p) return;
    p.erro = e?.message || "Não foi possível carregar os pedidos iFood.";
  } finally {
    p.carregando = false;
  }
  pintarPedidos();
}

function linhaPedido(p) {
  const st = rotuloStatusPedido(p.status);
  return `
    <tr data-order-id="${esc(p.orderId)}">
      <td><strong>#${esc(p.displayId ?? "—")}</strong>${p.isTest ? ' <span class="pill muted">Teste</span>' : ""}</td>
      <td class="ifood-pedido-id">${esc(p.orderId)}</td>
      <td>${esc(rotuloTipoPedido(p.tipo, p.entregaPor))}</td>
      <td><span class="pill ${st.classe}" data-status="${esc(p.status ?? "")}">${esc(st.rotulo)}</span>${p.acaoIncerta ? ' <span class="pill warn">Aguardando confirmação do iFood</span>' : ""}</td>
      <td>${p.statusEm ? fmtDataHora(p.statusEm) : "—"}</td>
      <td>${p.criadoEm ? fmtDataHora(p.criadoEm) : "—"}</td>
      <td class="num">${p.total != null ? fmtMoeda(p.total) : "—"}</td>
    </tr>`;
}

function pintarPedidos() {
  const view = el("#view");
  const p = estado.pedidos;
  if (!view || !p) return;
  const linhas = p.lista?.length
    ? p.lista.map(linhaPedido).join("")
    : `<tr><td colspan="7" class="ifood-vazio">${p.carregando ? "Carregando pedidos…" : "Nenhum pedido iFood recebido nesta loja."}</td></tr>`;

  view.innerHTML = `
    <div class="ifood-page">
      <div class="vd-head ifood-head">
        <div class="ifood-head-id">
          <img src="${IFOOD_LOGO}" alt="iFood" class="ifood-head-logo" />
          <div class="vd-head-txt">
            <h2>Pedidos iFood${badgeHomologacao()}</h2>
            <p>Status oficial de cada pedido, atualizado pelos eventos do iFood.</p>
          </div>
        </div>
        <div class="ifood-acoes">
          <button class="btn btn-ghost" id="ifped-atualizar" ${p.carregando ? "disabled" : ""}>${p.carregando ? "Atualizando…" : "Atualizar"}</button>
          <button class="btn btn-ghost" id="ifped-voltar">Voltar ao status</button>
        </div>
      </div>
      <div class="ifood-card">
        ${p.erro ? `<div class="ifood-aviso bad">${esc(p.erro)}</div>` : ""}
        ${p.consultadoEm ? `<div class="ifood-info-linha"><span>Atualizado em</span><strong>${fmtDataHora(p.consultadoEm)}</strong></div>` : ""}
        <div class="tabela-wrap">
          <table class="grid" id="ifood-pedidos-tabela">
            <thead><tr><th>Pedido</th><th>ID do pedido</th><th>Tipo</th><th>Status</th><th>Status desde</th><th>Criado em</th><th class="num">Total</th></tr></thead>
            <tbody>${linhas}</tbody>
          </table>
        </div>
      </div>
    </div>`;

  el("#ifped-voltar")?.addEventListener("click", fecharPedidos);
  el("#ifped-atualizar")?.addEventListener("click", carregarPedidos);
}

// Cada `id` de acoesDoPainel() -> um handler. Um só lugar para o mapeamento.
function ligarAcoesDoPainel() {
  const handlers = {
    tentar_novamente: () => { pintarCarregando(); carregarStatus(); },
    conectar: () => abrirWizard("auto"),
    continuar: () => abrirWizard("auto"),
    autorizar_analytics: () => abrirWizard("analytics"),
    reconectar: () => abrirWizard("reauth"),
    // Pedidos (app Order): só existe o botão para a unidade piloto; o backend recusa as demais (403).
    conectar_order: () => abrirWizard("order"),
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
  if (modo === "order") return "order";
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
function badgeHomologacao(statusApi = estado.status) {
  if (!statusApi?.homologacao) return "";
  return ` <span class="pill info" id="ifood-badge-homologacao" title="Conexão usando o aplicativo de teste do iFood — não representa produção.">Ambiente de homologação iFood</span>`;
}

// Só na área Financial: ESTA unidade está na allowlist de homologação Financial do
// backend (IFOOD_FINANCIAL_HOMOLOGATION_UNITS) — as consultas usam o ambiente de
// teste do iFood. Decisão 100% do backend (só um booleano em /status).
function badgeHomologacaoFinancial(statusApi = estado.status) {
  if (!statusApi?.financialHomologacao || statusApi?.homologacao) return ""; // o selo geral já cobre
  return ` <span class="pill info" id="ifood-badge-homologacao-financial" title="Esta unidade consulta o ambiente de homologação do iFood nas APIs Financial — os dados não são da loja real.">Ambiente de homologação iFood</span>`;
}

function cabecalhoWizard(tituloEtapa, passo) {
  return `
    <div class="vd-head ifood-head">
      <div class="vd-head-txt">
        <h2>Conectar iFood ${passo ? `<span class="ifood-passo">Etapa ${passo} de 2</span>` : ""}${badgeHomologacao()}</h2>
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
  if (w.etapa === "order") return pintarEtapaOAuth("order", null, "Pedidos e eventos — autorize o aplicativo de pedidos (Order) do iFood.");
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
    if (appType === "order") {
      // Pedidos autorizados: nada mais neste assistente (o recebimento de eventos tem flag própria no servidor).
      sairDoWizard();
    } else if (appType === "analytics" && derivarEstadoIntegracao(estado.status).apps.financial.conectado) {
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
      // `fase`: null | solicitando | processando | instavel | concluido | falhou | erro | tempo_esgotado | cancelado
      // (ver FASE_ON_DEMAND_ROTULO). `retomadaVerificada`: já procurou a solicitação vigente
      // desta competência no backend (retoma o acompanhamento após reload).
      onDemand: {
        competencia: mesFechadoAnterior(), carregando: false, requestId: null, reutilizado: false,
        fase: null, proximaEmMs: null, resultado: null, erro: null,
        baixando: false, erroDownload: null, retomadaVerificada: false,
        // Solicitação HISTÓRICA (expirada, > 24h) lida do banco —
        // só exibição/evidência, nunca vira acompanhamento (requestId vem só mascarado).
        historico: null,
      },
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
  pararAcompanhamentoOnDemand();
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

// --- Reconciliation On Demand (assíncrona) — solicitar -> acompanhar
// automaticamente (polling + backoff, ifoodReconciliacaoPolling.js) ->
// baixar o CSV pelo backend. O requestId fica registrado no backend por
// unidade/competência: o 409 do iFood reaproveita o mesmo id e um reload
// retoma o acompanhamento. -------------------------------------------------
const acompanhamentoOnDemand = criarAcompanhamentoReconciliacao({
  consultar: async (requestId) => (await api.ifoodFinancialReconciliationOnDemandStatus(requestId)).data,
  aoAtualizar: ({ fase, resultado, erro, proximaEmMs }) => {
    const od = estado.financeiro?.reconciliation?.onDemand;
    if (!od) return;
    od.fase = fase;
    od.proximaEmMs = proximaEmMs ?? null;
    if (resultado) od.resultado = resultado;
    od.erro = fase === "instavel" ? (erro?.message || "Falha temporária ao consultar o iFood.") : null;
    pintarFinanceiro();
  },
});

function pararAcompanhamentoOnDemand() {
  acompanhamentoOnDemand.cancelar();
}

/** Acompanha `requestId` até o estado final (sobrescreve um acompanhamento anterior). */
async function acompanharReconciliationOnDemand(requestId) {
  const od = estado.financeiro?.reconciliation?.onDemand;
  if (!od || !requestId) return;
  od.requestId = requestId;
  od.fase = "processando";
  od.erro = null;
  od.erroDownload = null;
  pintarFinanceiro();
  const fim = await acompanhamentoOnDemand.iniciar(requestId);
  const atual = estado.financeiro?.reconciliation?.onDemand;
  // Cancelado (saiu da tela, trocou de unidade, nova solicitação) ou o estado mudou por baixo: não pinta nada.
  if (fim.estado === "cancelado" || atual !== od || od.requestId !== requestId) return;
  od.fase = fim.estado;
  od.proximaEmMs = null;
  if (fim.resultado) od.resultado = fim.resultado;
  od.erro = fim.estado === "erro" ? (fim.erro?.message || "Não foi possível acompanhar a solicitação.") : null;
  if (fim.estado === "concluido") toast("Arquivo de conciliação pronto.");
  pintarFinanceiro();
}

async function solicitarReconciliationOnDemand() {
  const od = estado.financeiro?.reconciliation?.onDemand;
  if (!od || od.carregando) return; // duplo clique: uma solicitação por vez
  pararAcompanhamentoOnDemand();
  od.competencia = el("#ifrec-od-competencia")?.value || od.competencia;
  od.carregando = true;
  od.fase = "solicitando";
  od.erro = null;
  od.erroDownload = null;
  od.resultado = null;
  od.requestId = null;
  od.reutilizado = false;
  od.retomadaVerificada = true;
  od.historico = null;
  pintarFinanceiro();
  let requestId = null;
  try {
    const { data } = await api.ifoodFinancialReconciliationOnDemandSolicitar(od.competencia);
    requestId = data.requestId;
    od.reutilizado = data.reutilizado === true;
    if (od.reutilizado) toast("Já existia uma solicitação recente para esta competência — acompanhando a mesma.");
  } catch (e) {
    od.fase = "erro";
    od.erro = e.message || "Não foi possível solicitar a conciliação sob demanda.";
  }
  od.carregando = false;
  pintarFinanceiro();
  if (requestId) acompanharReconciliationOnDemand(requestId);
}

/** "Verificar agora": consulta imediata + reinicia o backoff (útil após "tempo esgotado"). */
function verificarStatusReconciliationOnDemand() {
  const od = estado.financeiro?.reconciliation?.onDemand;
  if (!od?.requestId) return;
  acompanharReconciliationOnDemand(od.requestId);
}

/**
 * Ao abrir a aba: lê do BANCO a solicitação desta competência (nunca chama o iFood aqui).
 * Vigente (qualquer status) -> retoma o acompanhamento de sempre. Histórica (expirada) ->
 * só exibe o estado gravado, sem GET de status e sem nova solicitação.
 */
async function retomarReconciliationOnDemand() {
  const od = estado.financeiro?.reconciliation?.onDemand;
  if (!od || od.retomadaVerificada || od.requestId) return;
  od.retomadaVerificada = true;
  try {
    const { data } = await api.ifoodFinancialReconciliationOnDemandAtual(od.competencia);
    const atual = estado.financeiro?.reconciliation?.onDemand;
    if (atual !== od || od.requestId) return;
    if (data?.historico === true) { od.historico = data; pintarFinanceiro(); return; }
    if (data?.requestId) acompanharReconciliationOnDemand(data.requestId);
  } catch { /* sem solicitação retomável: a tela segue no estado inicial */ }
}

async function baixarCsvReconciliationOnDemand() {
  const od = estado.financeiro?.reconciliation?.onDemand;
  if (!od?.requestId || od.baixando) return;
  od.baixando = true;
  od.erroDownload = null;
  pintarFinanceiro();
  try {
    const { blob, nomeArquivo } = await api.ifoodFinancialReconciliationOnDemandArquivo(od.requestId);
    // Só para a evidência do On Demand (nome sanitizado pelo backend + tamanho).
    od.arquivoBaixado = { requestId: od.requestId, nome: nomeArquivo || null, bytes: typeof blob?.size === "number" ? blob.size : null };
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nomeArquivo || `conciliacao-ifood-${od.resultado?.competencia ?? od.competencia}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    od.erroDownload = e.message || "Não foi possível baixar o arquivo de conciliação.";
  }
  od.baixando = false;
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

// Comissões + taxas da venda (soma dos lançamentos oficiais) — "—" quando o iFood não informou nenhum.
function totalComissoesTaxas(c) {
  if (c.totalComissoes === null && c.totalTaxas === null) return null;
  return Math.round(((c.totalComissoes ?? 0) + (c.totalTaxas ?? 0)) * 100) / 100;
}

function linhaVenda(v) {
  const pg = resumirPagamentosVenda(v.pagamentos);
  const ct = totalComissoesTaxas(classificarLancamentosVenda(v.resumoFinanceiro));
  return `
    <tr>
      <td>${esc(String(v.shortId ?? v.id ?? "—"))}</td>
      <td>${v.criadoEm ? fmtDataHora(v.criadoEm) : "—"}</td>
      <td><span class="pill ${statusVendaClasse(v.status)}">${esc(v.status ?? "—")}</span></td>
      <td><span class="ifin-celula-2l">${esc(pg.metodo)}<small>Responsável: ${esc(pg.responsavel)}</small></span></td>
      <td class="num">${fmtMoeda(v.valorBruto?.total)}</td>
      <td class="num">${ct === null ? "—" : `<span class="${ct < 0 ? "ifin-debito" : ""}">${fmtMoeda(ct)}</span>`}</td>
      <td class="num">${v.resumoFinanceiro ? fmtMoeda(v.resumoFinanceiro.saldo) : "—"}</td>
      <td><button class="btn btn-ghost btn-sm" data-tipo="venda" data-id="${esc(v.id ?? "")}">Ver detalhes</button></td>
    </tr>`;
}

/** Seções do detalhe da venda: venda, pagamento, comissões/taxas e demais lançamentos oficiais. */
function secoesDetalheVenda(venda) {
  const c = classificarLancamentosVenda(venda.resumoFinanceiro);
  const linhasLanc = (lista, vazio) => (lista.length ? lista.map((l) => [l.rotulo, l.valor === null ? "Não informado" : fmtMoeda(l.valor)]) : [[vazio, "—"]]);
  const pagamentos = Array.isArray(venda.pagamentos) ? venda.pagamentos : [];
  return [
    { titulo: "Venda", campos: [
      ["Status", venda.status ?? "—"],
      ["Criado em", venda.criadoEm ? fmtDataHora(venda.criadoEm) : "—"],
      ["Canal", venda.canal ?? "—"],
      ["Valor bruto", fmtMoeda(venda.valorBruto?.total)],
      ["Saldo líquido (após comissões e taxas)", venda.resumoFinanceiro ? fmtMoeda(venda.resumoFinanceiro.saldo) : "Não informado"],
    ] },
    { titulo: "Pagamento", campos: pagamentos.length
      ? pagamentos.flatMap((p, i) => [
        [`${pagamentos.length > 1 ? `${i + 1}. ` : ""}Forma`, `${rotuloMetodoPagamento(p.metodo)}${p.bandeira ? ` (${p.bandeira})` : ""}`],
        ["Responsável pelo pagamento", rotuloResponsavelPagamento(p.responsavel)],
        ["Tipo", rotuloTipoPagamento(p.tipo)],
        ["Valor", fmtMoeda(p.valor)],
      ])
      : [["Forma de pagamento", "Não informado pelo iFood"]] },
    { titulo: "Comissões", campos: [...linhasLanc(c.comissoes, "Nenhuma comissão informada"), ...(c.totalComissoes !== null && c.comissoes.length > 1 ? [["Total de comissões", fmtMoeda(c.totalComissoes)]] : [])] },
    { titulo: "Taxas", campos: [...linhasLanc(c.taxas, "Nenhuma taxa informada"), ...(c.totalTaxas !== null && c.taxas.length > 1 ? [["Total de taxas", fmtMoeda(c.totalTaxas)]] : [])] },
    ...(c.outros.length ? [{ titulo: "Demais lançamentos", campos: linhasLanc(c.outros, "") }] : []),
  ];
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

// Homologação Financial: o iFood devolve a FIXTURE oficial (loja e período de exemplo),
// não dados da loja vinculada. O backend marca `fonte: "fixture"` / `amostraHomologacao`
// — o frontend só exibe o aviso (nunca decide o modo). Loja da fixture só mascarada.
function avisoAmostraHomologacao(r) {
  if (!r || (r.fonte !== "fixture" && r.amostraHomologacao !== true)) return "";
  const lojas = r.amostra?.merchants?.length ? r.amostra.merchants.join(", ") : null;
  const p = r.amostra?.periodo;
  const periodo = p && (p.inicio || p.fim) ? `${fmtDataSimples(p.inicio)} a ${fmtDataSimples(p.fim)}` : null;
  return `
    <div class="ifood-aviso warn" id="ifin-aviso-amostra">
      <strong>Dados de exemplo do ambiente de homologação do iFood</strong><br/>
      Os registros exibidos são fornecidos pelo ambiente de homologação do iFood e podem representar uma loja de exemplo diferente da loja vinculada.
      ${lojas ? `<br/><span class="ifin-tecnico">Loja de exemplo: <span class="mono">${esc(lojas)}</span>${periodo ? ` · período da amostra: ${esc(periodo)}` : ""}</span>` : ""}
    </div>`;
}

function conteudoAbaSales(f) {
  const s = f.sales;
  const r = s.resultado;
  const linhas = r?.vendas?.length
    ? r.vendas.map(linhaVenda).join("")
    : `<tr><td colspan="8" class="ifood-vazio">${s.carregando ? "Consultando…" : "Nenhuma venda encontrada para este período."}</td></tr>`;
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
    ${avisoAmostraHomologacao(r)}
    ${r ? `
      <div class="ifood-info-linha"><span>Total de vendas ${r.amostraHomologacao ? "na amostra" : "no período"}</span><strong>${r.pagina.total}</strong></div>
      <div class="tabela-wrap">
        <table class="grid">
          <thead><tr><th>Pedido</th><th>Criado em</th><th>Status</th><th>Pagamento</th><th class="num">Valor bruto</th><th class="num">Comissões e taxas</th><th class="num">Saldo líquido</th><th>Detalhes</th></tr></thead>
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
    ${avisoAmostraHomologacao(r)}
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
    <p class="ifood-instrucao">Sem paginação nesta API. Sem limite de dias imposto pelo iFood, mas a documentação recomenda períodos de até 90 dias. O saldo (<code>balance</code>) deve se aproximar da soma dos eventos financeiros com impacto no repasse (<code>hasTransferImpact=true</code>) do mesmo período — a comparação automática fica na aba Conciliação.</p>
    ${st.erro ? `<div class="ifood-aviso bad">${esc(st.erro)}</div>` : ""}
    ${r ? `
      <div class="ifood-info-linha"><span>Saldo do período (líquido)</span><strong>${fmtMoeda(r.saldo)}</strong></div>
      ${r.titulos.length ? "" : `<div class="ifood-aviso ok" id="ifin-settlements-vazio">Consulta concluída — o iFood não retornou registros para o período.</div>`}
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
  return "info"; // created, enqueue/enqueued
}
// "enqueued" é o valor real da API (o backend já normaliza para "enqueue"; mantido por segurança).
const STATUS_OD_ROTULO = { created: "Criada", enqueue: "Na fila", enqueued: "Na fila", processed: "Concluída", error: "Erro" };

function conteudoAbaReconciliation(f) {
  const rec = f.reconciliation;
  const od = rec.onDemand;
  const r = rec.resultado;
  const rOd = od.resultado;

  return `
    <div class="ifood-card">
      <div class="ifood-secao-rotulo">Reconciliation — mês fechado (síncrona)</div>
      <p class="ifood-instrucao">Arquivo mensal oficial de conciliação. Só aceita meses já fechados (o mês atual e futuros são inválidos), até 24 meses no passado.</p>
      ${avisoAmostraReconciliation()}
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
          ${blocoImpactoRepasse(r.arquivo.resumoRepasse)}
          <div class="ifood-info-linha"><span>Registros no arquivo</span><strong>${r.arquivo.totalLinhas}${r.arquivo.truncado ? " (tabela mostra os 2000 primeiros)" : ""}</strong></div>
          ${tabelaArquivo(r.arquivo, 10)}
          <div class="ifood-acoes"><button class="btn btn-ghost btn-sm" id="ifrec-detalhe">Ver todos os registros</button></div>
        ` : `<p class="ifood-instrucao">Esta competência não tem arquivo de conciliação disponível.</p>`}
      ` : ""}
    </div>

    <div class="ifood-card">
      <div class="ifood-secao-rotulo">Reconciliation On Demand — arquivo sob demanda</div>
      <p class="ifood-instrucao">Solicite a geração do arquivo do mês: a Central acompanha o processamento automaticamente e libera o download do CSV quando ficar pronto. Se já houver uma solicitação recente para a mesma competência, ela é reaproveitada.</p>
      ${blocoHistoricoOnDemand(od.historico)}
      ${od.historico ? `<div class="ifood-secao-rotulo">Nova solicitação</div>` : ""}
      <div class="ifin-filtro">
        <label class="ifood-label">Competência (mês)<input type="month" id="ifrec-od-competencia" class="ifood-input" value="${esc(od.competencia)}" /></label>
        <button class="btn btn-primary" id="ifrec-od-solicitar" ${od.carregando ? "disabled" : ""}>${od.carregando ? "Solicitando…" : "Solicitar geração"}</button>
        ${od.requestId && !["processando", "instavel", "solicitando"].includes(od.fase)
          ? `<button class="btn btn-ghost" id="ifrec-od-verificar">Verificar agora</button>` : ""}
      </div>
      ${blocoFaseOnDemand(od)}
      ${od.erro ? `<div class="ifood-aviso ${od.fase === "instavel" ? "warn" : "bad"}">${esc(od.erro)}</div>` : ""}
      ${rOd?.status === "error" ? `<div class="ifood-aviso bad">${esc(rOd.mensagemErro || MENSAGEM_ERRO_OD_SEM_MOTIVO)}</div>` : ""}
      ${rOd?.arquivoDisponivel ? `
        <div class="ifood-acoes">
          <button class="btn btn-primary" id="ifrec-od-baixar" ${od.baixando ? "disabled" : ""}>${od.baixando ? "Preparando o CSV…" : "Baixar CSV"}</button>
        </div>
        ${od.erroDownload ? `<div class="ifood-aviso bad">${esc(od.erroDownload)}</div>` : ""}
      ` : ""}
      ${rOd?.arquivo ? `
        ${blocoImpactoRepasse(rOd.arquivo.resumoRepasse)}
        <div class="ifood-info-linha"><span>Registros no arquivo</span><strong>${rOd.arquivo.totalLinhas}${rOd.arquivo.truncado ? " (tabela mostra os 2000 primeiros — o CSV tem todos)" : ""}</strong></div>
        ${tabelaArquivo(rOd.arquivo, 10)}
        <div class="ifood-acoes"><button class="btn btn-ghost btn-sm" id="ifrec-od-detalhe">Ver todos os registros</button></div>
      ` : ""}
      ${od.requestId ? `<p class="ifin-tecnico">Identificador da solicitação no iFood: <span class="mono">${esc(mascararRequestId(od.requestId))}</span>${od.reutilizado ? " (solicitação reaproveitada)" : ""}</p>` : ""}
    </div>`;
}

// Reconciliation mensal em homologação: o iFood devolve a FIXTURE de teste,
// não a movimentação da loja. Decisão do backend (/status.financialHomologacao).
function avisoAmostraReconciliation(statusApi = estado.status) {
  if (statusApi?.financialHomologacao !== true) return "";
  return `
    <div class="ifood-aviso warn" id="ifrec-aviso-amostra">
      <strong>Dados de exemplo do ambiente de homologação do iFood</strong><br/>
      O arquivo de conciliação desta competência é fornecido pelo ambiente de homologação do iFood (dados de teste). Os valores exibidos não representam movimentação financeira real da loja.
    </div>`;
}

/** Solicitação On Demand HISTÓRICA (do banco) — só exibição/evidência, sem ações. */
function blocoHistoricoOnDemand(h) {
  const d = derivarHistoricoOnDemand(h);
  if (!d) return "";
  const linha = (rotulo, valor) => `<div class="ifood-info-linha"><span>${esc(rotulo)}</span><strong>${valor}</strong></div>`;
  return `
    <div class="ifcon-fonte" id="ifrec-od-historico">
      <div class="ifood-secao-rotulo">Última solicitação registrada <span class="pill muted">Histórico / evidência</span></div>
      <p class="ifood-instrucao">Esta solicitação já foi concluída e está sendo exibida apenas como evidência/histórico — dados gravados pela Central, sem nova consulta ao iFood e sem acompanhamento em tempo real.</p>
      ${linha("Competência", esc(h.competencia ?? "—"))}
      ${linha("Situação", `<span class="pill ${d.situacao.classe}">${esc(d.situacao.rotulo)}</span>`)}
      ${linha("Status no iFood", esc(d.statusRotulo))}
      ${linha("Solicitada em", h.solicitadoEm ? esc(fmtDataHora(h.solicitadoEm)) : "—")}
      ${linha("Validade do identificador", esc(d.validade))}
      ${d.erro ? `<div class="ifood-aviso bad"><strong>Mensagem oficial do iFood:</strong> ${esc(d.erro)}</div>` : ""}
      <p class="ifin-tecnico">Identificador da solicitação no iFood: <span class="mono">${esc(h.requestIdMascarado ?? "—")}</span></p>
    </div>`;
}

/** Fase do acompanhamento automático — o que o usuário precisa saber agora. */
function blocoFaseOnDemand(od) {
  if (!od.fase) return "";
  const classe = { concluido: "ok", falhou: "bad", erro: "bad", tempo_esgotado: "warn", instavel: "warn", cancelado: "muted" }[od.fase] ?? "info";
  const statusIfood = od.resultado?.status ? ` · status no iFood: ${STATUS_OD_ROTULO[od.resultado.status] ?? od.resultado.status}` : "";
  const proxima = ["processando", "instavel"].includes(od.fase) && od.proximaEmMs
    ? ` · próxima verificação em ${Math.round(od.proximaEmMs / 1000)}s` : "";
  return `<div class="ifood-info-linha"><span>Situação</span><strong><span class="pill ${classe}">${esc(FASE_ON_DEMAND_ROTULO[od.fase] ?? od.fase)}</span></strong></div>
    ${statusIfood || proxima ? `<p class="ifin-tecnico">${esc((statusIfood + proxima).replace(/^ · /, ""))}</p>` : ""}
    ${od.fase === "tempo_esgotado" ? `<p class="ifood-instrucao">O iFood ainda não terminou. Use "Verificar agora" em alguns minutos.</p>` : ""}`;
}

/**
 * Critério de homologação: só `impacto_no_repasse = SIM` compõe o valor
 * líquido a receber. Mostra os dois totais lado a lado — nada é escondido.
 */
function blocoImpactoRepasse(resumo) {
  if (!resumo || !resumo.totalLinhas) return "";
  if (!resumo.colunaImpactoEncontrada || !resumo.colunaValorEncontrada) {
    return `<div class="ifood-aviso warn">O arquivo não trouxe ${!resumo.colunaImpactoEncontrada ? "a coluna de impacto no repasse" : "a coluna de valor"} — não é possível separar o valor que compõe o repasse.</div>`;
  }
  return `
    <div class="ifin-resumo-grid">
      <div class="ifin-resumo-item destaque">
        <span>Valor que compõe o repasse</span>
        <strong>${fmtMoeda(resumo.totalComImpacto)}</strong>
        <small>${resumo.linhasComImpacto} de ${resumo.totalLinhas} lançamentos (impacto no repasse = SIM)</small>
      </div>
      <div class="ifin-resumo-item">
        <span>Total bruto do arquivo</span>
        <strong>${fmtMoeda(resumo.totalBruto)}</strong>
        <small>todos os ${resumo.totalLinhas} lançamentos</small>
      </div>
      <div class="ifin-resumo-item">
        <span>Lançamentos só informativos</span>
        <strong>${fmtMoeda(resumo.totalSemImpacto)}</strong>
        <small>${resumo.linhasSemImpacto} sem impacto no repasse</small>
      </div>
    </div>
    <p class="ifood-instrucao">Só os lançamentos com impacto no repasse entram no valor líquido a receber do iFood. Os demais aparecem apenas para informação (ex.: pagamentos recebidos direto pela loja, promoções bancadas pela loja).</p>
    ${resumo.linhasImpactoNaoInformado ? `<div class="ifood-aviso warn">${resumo.linhasImpactoNaoInformado} lançamento(s) sem a indicação de impacto no repasse — ficaram fora do valor do repasse.</div>` : ""}
    ${resumo.linhasValorInvalido ? `<div class="ifood-aviso warn">${resumo.linhasValorInvalido} lançamento(s) com valor ilegível — fora dos totais.</div>` : ""}`;
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
      ${r.antecipacoes.length ? "" : `<div class="ifood-aviso ok" id="ifant-vazio">Consulta concluída — o iFood não retornou registros para o período.</div>`}
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
  const homologacao = !!status?.homologacao || !!status?.financialHomologacao;
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

/** Evidência da Conciliação sob demanda — bloco próprio, nunca misturado com o mensal. */
function blocoEvidenciaOnDemand(od) {
  if (!od) return "";
  const linha = (rotulo, valor) => `<div class="ifood-info-linha"><span>${esc(rotulo)}</span><strong>${valor}</strong></div>`;
  return `
    <div class="ifcon-fonte ${od.csvProcessado ? "" : "ifcon-fonte-ausente"}">
      <div class="ifood-secao-rotulo">Conciliação sob demanda</div>
      <p class="ifood-instrucao">${esc(TEXTO_FONTE_ON_DEMAND)}</p>
      ${od.amostraHomologacao ? `<div class="ifood-aviso warn">${esc(TEXTO_AMOSTRA_HOMOLOGACAO)}</div>` : ""}
      ${!od.solicitado ? linha("Solicitação", "Não utilizada nesta sessão") : `
        ${linha("Competência", esc(od.competencia ?? "—"))}
        ${linha("Identificador (requestId)", `<span class="mono">${esc(od.requestId ?? "—")}</span>`)}
        ${linha("Status", esc(od.status ?? "—"))}
        ${od.historico ? linha("Origem", "Histórico registrado na Central (sem nova consulta ao iFood)") : linha("Solicitação reaproveitada", od.reutilizado ? "Sim" : "Não")}
        ${linha("Linhas do CSV", od.csvProcessado ? esc(od.quantidadeLinhas ?? "—") : "Não processado")}
        ${linha("Total bruto", fmtMoeda(od.totalBruto))}
        ${linha("Impacto no repasse = SIM", fmtMoeda(od.impactoRepasseSim))}
        ${linha("Impacto no repasse = NÃO", fmtMoeda(od.impactoRepasseNao))}
        ${linha("Valor líquido considerado", fmtMoeda(od.valorLiquidoConsiderado))}
        ${od.arquivo ? linha("Arquivo", `${esc(od.arquivo)}${od.tamanhoArquivo != null ? ` (${esc(od.tamanhoArquivo)} bytes)` : ""}`) : ""}
        ${od.erro ? `<p class="ifood-instrucao">Erro: ${esc(od.erro)}</p>` : ""}`}
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
      `)}
      ${blocoEvidenciaOnDemand(evidencia.reconciliationOnDemand)}
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
          <h2>Homologação Financeira${badgeHomologacao()}${badgeHomologacaoFinancial()}</h2>
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
      if (venda) abrirDetalheItem(`Venda ${venda.shortId ?? venda.id ?? ""}`, [], venda, secoesDetalheVenda(venda));
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
    el("#ifrec-od-baixar")?.addEventListener("click", baixarCsvReconciliationOnDemand);
    // Reabriu a aba (ou recarregou a página): retoma a solicitação vigente da competência — uma vez só.
    if (!rec.onDemand.retomadaVerificada) retomarReconciliationOnDemand();
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
// `secoes` (opcional): [{ titulo, campos: [[rotulo, valor]] }] — detalhe organizado por assunto.
function abrirDetalheItem(titulo, camposDestaque, itemBruto, secoes = []) {
  fecharDetalheItem();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "ifin-detalhe-overlay";
  const linhas = (campos) => campos.map(([rotulo, valor]) =>
    `<div class="ifood-info-linha"><span>${esc(rotulo)}</span><strong>${esc(String(valor))}</strong></div>`).join("");
  const destaque = linhas(camposDestaque);
  const blocos = secoes.map((s) => `<div class="ifin-detalhe-secao"><h4>${esc(s.titulo)}</h4>${linhas(s.campos)}</div>`).join("");
  overlay.innerHTML = `
    <div class="modal">
      <button class="modal-close" aria-label="Fechar" id="ifin-detalhe-fechar">×</button>
      <h3>${esc(titulo)}</h3>
      ${destaque}
      ${blocos}
      <div class="ifood-secao-rotulo">Detalhe técnico (JSON sanitizado — sem token/secret)</div>
      <pre class="ifin-json">${esc(JSON.stringify(itemParaJsonTecnico(itemBruto), null, 2))}</pre>
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
  pararAcompanhamentoOnDemand();
  estado.wizard = null;
  const view = el("#view");
  if (view) view.innerHTML = `<div class="ifood-page"><div class="ifood-card"><div class="ifood-msg">Carregando integração iFood…</div></div></div>`;
  carregarStatus();
}
