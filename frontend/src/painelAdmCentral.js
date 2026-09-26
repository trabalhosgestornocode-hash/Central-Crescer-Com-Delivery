// CENTRAL DE COMUNICAÇÃO (H.4-B.5) — construtores PUROS (dados -> string HTML; sem DOM, sem rede) da aba "Comunicação" do Painel Administrativo.
// A ligação com a página (eventos, chamadas de API, polling do teste) fica em painelAdmViews.js.
//
// REGRAS DE LINGUAGEM (vocabulário de NEGÓCIO, nunca de engenharia):
//   * SENT aparece como "Enviado ao provedor" — NUNCA como "Entregue". "Entregue" só existe para DELIVERED; "Lido" só para READ.
//   * Telefone só mascarado (`********88`) — o backend nem manda o número completo.
//   * Nada de segredo, token, HMAC, auth-state, lease/epoch, ids completos.

import { escapeHtml } from "./utils.js";
import { icon } from "./icons.js";
import { card, cards, secao, chip, vazio, carregando, busca, fmtData, fmtDataCurta } from "./painelAdmUi.js";

// ---------------------------------------------------------------------------
// Vocabulário
// ---------------------------------------------------------------------------

export const TOOLTIP_ENVIADO = "O WhatsApp recebeu a solicitação de envio, mas a entrega ao destinatário ainda não foi confirmada.";

export const ROTULO_STATUS_MENSAGEM = Object.freeze({
  SCHEDULED: "Agendado", PROCESSING: "Preparando envio", SENDING: "Enviando", SENT: "Enviado ao provedor", DELIVERED: "Entregue", READ: "Lido",
  FAILED: "Falhou", DELIVERY_UNKNOWN: "Entrega não confirmada", CANCELLED: "Cancelado", BLOCKED: "Bloqueado",
});
const CLASSE_STATUS = Object.freeze({
  SCHEDULED: "muted", PROCESSING: "muted", SENDING: "atencao", SENT: "muted", DELIVERED: "ok", READ: "ok",
  FAILED: "critico", DELIVERY_UNKNOWN: "atencao", CANCELLED: "muted", BLOCKED: "muted",
});
export const ROTULO_ORIGEM = Object.freeze({ automacao: "Automação", reforco: "Reforço", aviso_tardio: "Aviso tardio", teste_controlado: "Teste controlado" });
export const ROTULO_MODO_CENTRAL = Object.freeze({ NORMAL: "Ativada", REACTIVE_ONLY: "Somente reativa", DISABLED: "Desativada" });
const ROTULO_GATEWAY = Object.freeze({ conectado: "Conectado", desconectado: "Desconectado", instavel: "Instável", desconhecido: "Desconhecido" });

/** Chip do status de uma mensagem (com o tooltip explicativo do "Enviado ao provedor"). */
export function chipStatusMensagem(status) {
  const rotulo = ROTULO_STATUS_MENSAGEM[status] ?? String(status ?? "—");
  const dica = status === "SENT" ? ` title="${escapeHtml(TOOLTIP_ENVIADO)}"` : "";
  return `<span class="padm-chip padm-chip--${CLASSE_STATUS[status] ?? "muted"}"${dica}>${escapeHtml(rotulo)}</span>`;
}

const badge = (classe, rotulo) => `<span class="padm-chip padm-chip--${classe}">${escapeHtml(rotulo)}</span>`;
const dt = (iso) => (iso ? escapeHtml(fmtData(iso)) : "—");

// ---------------------------------------------------------------------------
// Cabeçalho + cards de saúde
// ---------------------------------------------------------------------------

export function htmlCabecalhoCentral() {
  return `<header class="padm-central-cab">
    <h1>Central de Comunicação</h1>
    <p>Acompanhe a automação do WhatsApp, entregas, destinatários e alertas do Crescer com Delivery.</p>
  </header>`;
}

/** Estado do worker para a UI: Saudável / Atenção / Desativado (nunca "online" sem evidência do último ciclo). */
export function estadoWorkerCentral(w) {
  if (!w) return { rotulo: "—", classe: "muted" };
  if (w.estado === "desabilitado") return { rotulo: "Desativado", classe: "muted" };
  if (w.resultadoUltimoCiclo === "failed") return { rotulo: "Atenção", classe: "atencao" };
  if (w.rodandoNestaInstancia && w.ultimoCicloEm) return { rotulo: "Saudável", classe: "ok" };
  return { rotulo: "Atenção", classe: "atencao" };
}

/** Os 5 cards de saúde do topo. `r` = GET /comunicacao/resumo. */
export function htmlCardsSaude(r) {
  if (!r) return "";
  const modo = r.comunicacao?.modo;
  const gw = r.gateway?.estado;
  const w = estadoWorkerCentral(r.worker);
  const piloto = r.piloto ?? {};
  const orgsHab = r.empresas?.habilitadas ?? 0;
  const badgeGw = gw === "conectado" ? "ok" : gw === "instavel" ? "atencao" : "critico";
  return cards([
    card({ label: "Automação", valor: ROTULO_MODO_CENTRAL[modo] ?? "—", icone: "bell", tom: modo === "NORMAL" ? "ok" : "", nota: modo === "NORMAL" ? "Alertas automáticos em andamento." : "Nenhum alerta automático é enviado." }),
    card({ label: "Gateway WhatsApp", valor: ROTULO_GATEWAY[gw] ?? "—", icone: "smartphone", tom: badgeGw === "ok" ? "ok" : badgeGw === "atencao" ? "atencao" : "critico" }),
    card({ label: "Worker", valor: w.rotulo, icone: "send", tom: w.classe === "ok" ? "ok" : w.classe === "atencao" ? "atencao" : "" }),
    card({
      label: "Piloto", valor: piloto.ativo ? `Ativo — ${Number(piloto.quantidadeDestinos ?? 0)} destino${Number(piloto.quantidadeDestinos ?? 0) === 1 ? "" : "s"} autorizado${Number(piloto.quantidadeDestinos ?? 0) === 1 ? "" : "s"}` : "Inativo",
      icone: "lock", tom: piloto.ativo ? "ok" : "",
    }),
    card({ label: "Organizações", valor: `${orgsHab} habilitada${orgsHab === 1 ? "" : "s"}`, icone: "building", tom: orgsHab > 0 ? "ok" : "" }),
  ].join(""));
}

const linhaSaude = (rotulo, valorHtml, dica = "") => `<li><span class="padm-saude-rot">${escapeHtml(rotulo)}</span><span class="padm-saude-val">${valorHtml}</span>${dica ? `<small>${escapeHtml(dica)}</small>` : ""}</li>`;

/** "Saúde da Comunicação" — só rótulos/estados/horários (nunca segredo, HMAC, token, telefone). */
export function htmlSaudeComunicacao(r) {
  if (!r) return "";
  const w = r.worker ?? {};
  const we = estadoWorkerCentral(w);
  const gw = r.gateway ?? {};
  const cicloRot = w.resultadoUltimoCiclo === "skipped" ? "Ciclo ignorado — automação desativada" : w.resultadoUltimoCiclo === "completed" ? "Ciclo concluído" : w.resultadoUltimoCiclo === "failed" ? "Ciclo com falha" : "Sem ciclo registrado nesta instância";
  const entrega = r.entrega ?? {};
  const itens = [
    linhaSaude("Backend", r.backend?.online ? `${badge("ok", "Online")}${r.backend?.versao ? ` <small>versão ${escapeHtml(r.backend.versao)}</small>` : ""}` : badge("atencao", "Sem informação")),
    linhaSaude("Worker", `${badge(we.classe, we.rotulo)}`, w.ultimoCicloEm ? `Último ciclo: ${fmtData(w.ultimoCicloEm)} · ${cicloRot}` : cicloRot),
    linhaSaude("Gateway WhatsApp", `${badge(gw.estado === "conectado" ? "ok" : gw.estado === "instavel" ? "atencao" : "critico", ROTULO_GATEWAY[gw.estado] ?? "—")}`,
      `${gw.ultimoContatoEm ? `Último sinal: ${fmtData(gw.ultimoContatoEm)}` : "Sem sinal registrado"} · Sessão: ${gw.leaseValida === true ? "válida" : gw.leaseValida === false ? "expirada" : "desconhecida"}`),
    linhaSaude("Recuperação de fila offline", badge("muted", "Desativado"), "Política do projeto — não é lida do servidor do WhatsApp."),
    linhaSaude("Pipeline de entrega", badge(entrega.estado === "operacional" ? "ok" : "atencao", entrega.estado === "operacional" ? "Operacional" : "Atenção"), entrega.motivo ?? "Confirmações de entrega e leitura são registradas."),
  ];
  return secao({ titulo: "Saúde da Comunicação", icone: "lock", sub: "Estado real dos componentes. Nenhum dado sensível é exibido.", corpo: `<ul class="padm-saude-lista">${itens.join("")}</ul>` });
}

// ---------------------------------------------------------------------------
// Fluxo visual
// ---------------------------------------------------------------------------

export const ETAPAS_FLUXO = Object.freeze([
  { titulo: "Pendência detectada", texto: "O monitoramento identifica lançamentos atrasados da unidade." },
  { titulo: "Elegibilidade", texto: "Empresa habilitada, contato consentido e verificado, dentro das regras." },
  { titulo: "Agendamento", texto: "A mensagem é programada para o horário permitido." },
  { titulo: "Fila", texto: "O worker reserva a mensagem e confere os limites de envio." },
  { titulo: "Enviado", texto: "O WhatsApp recebeu a solicitação de envio — ainda não é entrega." },
  { titulo: "Entregue", texto: "O WhatsApp confirmou a entrega no aparelho do destinatário." },
  { titulo: "Lido", texto: "O destinatário abriu a mensagem." },
]);

export function htmlFluxoComunicacao() {
  const passos = ETAPAS_FLUXO.map((e, i) => `<li class="padm-fluxo-passo">
      <span class="padm-fluxo-num">${i + 1}</span>
      <strong>${escapeHtml(e.titulo)}</strong>
      <small>${escapeHtml(e.texto)}</small>
    </li>`).join("");
  return secao({ titulo: "Como uma mensagem nasce", icone: "list-checks", sub: "Do alerta até a leitura. \"Enviado\" ainda não significa \"Entregue\".", corpo: `<ol class="padm-fluxo">${passos}</ol>` });
}

// ---------------------------------------------------------------------------
// Empresas / destinatários
// ---------------------------------------------------------------------------

const simNao = (v, sim, nao, classeNao = "muted") => (v ? badge("ok", sim) : badge(classeNao, nao));

const ROTULO_WHATSAPP = {
  NAO_CADASTRADO: ["muted", "Não cadastrado"], AGUARDANDO_VALIDACAO: ["atencao", "Aguardando validação"], VALIDADO: ["ok", "Validado"],
  ERRO: ["critico", "Erro"], DESATIVADO: ["muted", "Desativado"],
};
export const chipWhatsappEmpresa = (s) => { const [classe, rotulo] = ROTULO_WHATSAPP[s] ?? ["muted", s ?? "—"]; return badge(classe, rotulo); };

/** Ações por empresa — todas por ID de empresa/responsável (nada por unidade/usuário). */
function botoesEmpresa(o) {
  const id = escapeHtml(o.organizacaoId);
  const acao = (a, rotulo) => `<button type="button" class="btn btn-ghost btn-sm" data-padm-com-acao="${a}" data-padm-com-org="${id}">${rotulo}</button>`;
  const r = o.responsavel;
  return `<div class="padm-com-acoes">
    ${acao("gerenciar", "Gerenciar")}
    ${acao("editar", r ? "Editar responsável" : "Cadastrar responsável")}
    ${r && o.whatsappStatus !== "VALIDADO" ? acao("validar", "Validar número") : ""}
    ${r ? `<button type="button" class="btn btn-ghost btn-sm" data-padm-com-acao="alternar-ativo" data-padm-com-org="${id}" data-padm-com-contato="${escapeHtml(r.id)}" data-padm-com-ativo="${r.ativo ? "1" : "0"}">${r.ativo ? "Desativar avisos" : "Ativar avisos"}</button>` : ""}
    ${acao("historico", "Ver histórico")}
  </div>`;
}

function linhaEmpresa(o) {
  const c = o.contato;
  const r = o.responsavel;
  const un = (o.unidades ?? []).map((u) => u.nome).filter(Boolean);
  const ultima = o.ultimaMensagem;
  return `<tr data-padm-com-linha="${escapeHtml(o.organizacaoId)}">
    <td><strong>${escapeHtml(o.nome)}</strong><small>${o.unidadesMonitoradas ?? un.length} unidade${(o.unidadesMonitoradas ?? un.length) === 1 ? "" : "s"} monitorada${(o.unidadesMonitoradas ?? un.length) === 1 ? "" : "s"}${un.length ? ` — ${escapeHtml(un.slice(0, 2).join(", "))}${un.length > 2 ? "…" : ""}` : ""}</small></td>
    <td>${o.habilitada ? badge("ok", "Habilitada") : badge("muted", "Desabilitada")}</td>
    <td>${r ? escapeHtml(r.nome) : `<span class="padm-vazio">Sem responsável</span>`}</td>
    <td>${chipWhatsappEmpresa(o.whatsappStatus)}</td>
    <td>${c ? `<span class="padm-mono">${escapeHtml(c.telefoneMascarado ?? "—")}</span>` : (r ? `<span class="padm-mono">${escapeHtml(r.telefoneMascarado ?? "—")}</span>` : "—")}</td>
    <td>${c ? simNao(c.consentimento, "Confirmado", "Pendente", "atencao") : "—"}</td>
    <td>${c ? simNao(c.verificado, "Verificado", "Não verificado", "atencao") : "—"}</td>
    <td>${c ? (c.optOut ? badge("critico", "Sim") : "Não") : "—"}</td>
    <td class="padm-td-num">${Number(o.pendenciasAtuais ?? 0)}</td>
    <td>${ultima?.em ? escapeHtml(fmtDataCurta(ultima.em)) : "—"}</td>
    <td>${ultima?.status ? chipStatusMensagem(ultima.status) : "—"}</td>
    <td>${escapeHtml(o.proximaAcao ?? "—")}</td>
    <td>${botoesEmpresa(o)}</td>
  </tr>`;
}

const FILTROS_EMPRESAS = [
  ["todos", "Todos"], ["configurados", "Configurados"], ["sem_responsavel", "Sem responsável"],
  ["aguardando_validacao", "Aguardando validação"], ["validados", "Validados"], ["desativada", "Comunicação desativada"],
];

/** Resumo do topo da aba Empresas — números do backend (camada de comunicação), nunca de usuários/unidades. */
export function htmlResumoEmpresas(r) {
  if (!r?.empresas) return "";
  const e = r.empresas;
  return cards([
    card({ label: "Empresas cadastradas", valor: String(e.total ?? 0), icone: "building" }),
    card({ label: "Responsáveis configurados", valor: String(e.configuradas ?? 0), icone: "check-circle" }),
    card({ label: "WhatsApps validados", valor: String(e.validados ?? 0), icone: "check-circle", tom: (e.validados ?? 0) > 0 ? "ok" : "" }),
    card({ label: "Empresas sem responsável", valor: String(e.semResponsavel ?? 0), icone: "alert-triangle", tom: (e.semResponsavel ?? 0) > 0 ? "atencao" : "" }),
  ].join(""));
}

/**
 * Aba EMPRESAS — UMA linha por EMPRESA (nunca por unidade). O responsável vem só do vínculo explícito empresa -> responsável de comunicação;
 * nada aqui olha usuário, unidade ou perfil. Busca (empresa/responsável/telefone) e filtro são resolvidos no SERVIDOR (o telefone completo
 * nunca chega ao navegador); a lista recebida já vem filtrada.
 */
export function htmlEmpresasCentral(orgs, termo = "", filtro = "todos", resumo = null) {
  const semFiltro = !termo && (!filtro || filtro === "todos");
  const filtros = `<div class="padm-segm" role="tablist">${FILTROS_EMPRESAS.map(([v, r]) => `
    <button type="button" class="padm-segm-btn ${v === filtro ? "ativo" : ""}" data-padm-com-filtro="${v}" role="tab" aria-selected="${v === filtro}">${escapeHtml(r)}</button>`).join("")}</div>`;
  const tabela = !orgs.length
    ? (semFiltro
      ? vazio("Nenhuma empresa encontrada.", "Cadastre empresas para acompanhar a comunicação.", { tom: "neutro", icone: "message-circle" })
      : `<p class="padm-vazio"><em>Nenhuma empresa encontrada para este filtro/busca.</em></p>`)
    : `<div class="padm-tabela-wrap">
      <table class="padm-tabela padm-tabela--larga">
        <thead><tr><th>Empresa</th><th>Comunicação</th><th>Responsável pelos avisos</th><th>Status do número</th><th>WhatsApp</th><th>Consentimento</th><th>Número</th><th>Opt-out</th><th>Pendências</th><th>Última mensagem</th><th>Último status</th><th>Próxima ação</th><th>Ações</th></tr></thead>
        <tbody>${orgs.map(linhaEmpresa).join("")}</tbody>
      </table>
    </div>`;
  return `
    ${htmlResumoEmpresas(resumo)}
    ${busca("padm-com-busca", "Buscar por empresa, responsável ou telefone…", termo)}
    ${filtros}
    ${tabela}`;
}

// ---------------------------------------------------------------------------
// Histórico de mensagens
// ---------------------------------------------------------------------------

const opcoes = (lista, atual, vazioRot) => `<option value="">${escapeHtml(vazioRot)}</option>${lista.map(([v, r]) => `<option value="${escapeHtml(v)}" ${String(atual ?? "") === String(v) ? "selected" : ""}>${escapeHtml(r)}</option>`).join("")}`;

/** Filtros: empresa, unidade, status, origem, período e busca por nome (nunca por telefone). */
export function htmlFiltrosHistorico(f = {}, orgs = []) {
  const unidades = orgs.filter((o) => !f.organizacaoId || o.organizacaoId === f.organizacaoId).flatMap((o) => (o.unidades ?? []).map((u) => [u.unidadeId, `${u.nome}`]));
  return `<form class="padm-filtros" id="padm-com-filtros" autocomplete="off">
    <label>Empresa<select name="organizacaoId">${opcoes(orgs.map((o) => [o.organizacaoId, o.nome]), f.organizacaoId, "Todas")}</select></label>
    <label>Unidade<select name="unidadeId">${opcoes(unidades, f.unidadeId, "Todas")}</select></label>
    <label>Status<select name="status">${opcoes(Object.entries(ROTULO_STATUS_MENSAGEM), f.status, "Todos")}</select></label>
    <label>Origem<select name="origem">${opcoes(Object.entries(ROTULO_ORIGEM), f.origem, "Todas")}</select></label>
    <label>De<input type="date" name="desde" value="${escapeHtml(f.desde ?? "")}" /></label>
    <label>Até<input type="date" name="ate" value="${escapeHtml(f.ate ?? "")}" /></label>
    <label class="padm-filtro-busca">Empresa ou unidade<input type="search" name="busca" value="${escapeHtml(f.busca ?? "")}" placeholder="Buscar pelo nome…" /></label>
    <span class="padm-filtros-acoes">
      <button type="submit" class="btn btn-primary btn-sm">Filtrar</button>
      <button type="button" class="btn btn-ghost btn-sm" data-padm-acao="limpar-filtros-historico">Limpar</button>
    </span>
  </form>`;
}

function linhaMensagem(m) {
  return `<tr>
    <td>${dt(m.criadoEm)}</td>
    <td>${escapeHtml(m.empresa ?? "—")}</td>
    <td>${escapeHtml(m.unidade ?? "—")}</td>
    <td>${escapeHtml(m.tipo === "teste_comunicacao" ? "Teste de comunicação" : (m.tipo ?? "—"))}</td>
    <td>${escapeHtml(ROTULO_ORIGEM[m.origem] ?? m.origem ?? "—")}</td>
    <td><span class="padm-mono">${escapeHtml(m.destinatario ?? "—")}</span></td>
    <td>${chipStatusMensagem(m.status)}</td>
    <td class="padm-td-num">${Number(m.tentativas ?? 0)}/${Number(m.maxTentativas ?? 0)}</td>
    <td>${dt(m.entregueEm)}</td>
    <td>${dt(m.lidoEm)}</td>
    <td><button type="button" class="btn btn-ghost btn-sm" data-padm-com-msg="${escapeHtml(m.id)}">Detalhes</button></td>
  </tr>`;
}

export function htmlPaginacaoCentral(pacote, prefixo) {
  if (!pacote || pacote.total <= pacote.porPagina) return "";
  const total = Math.ceil(pacote.total / pacote.porPagina);
  return `<div class="padm-paginacao">
    <button type="button" class="btn btn-ghost btn-sm" data-padm-com-pag="${prefixo}:anterior" ${pacote.pagina <= 1 ? "disabled" : ""}>‹ Anterior</button>
    <span>Página ${pacote.pagina} de ${total} · ${pacote.total} no total</span>
    <button type="button" class="btn btn-ghost btn-sm" data-padm-com-pag="${prefixo}:proximo" ${pacote.pagina >= total ? "disabled" : ""}>Próxima ›</button>
  </div>`;
}

export function htmlHistoricoCentral(pacote, filtros, orgs) {
  const cabecalho = htmlFiltrosHistorico(filtros, orgs);
  if (!pacote) return `${cabecalho}${carregando("lista")}`;
  if (!pacote.itens.length) return `${cabecalho}${vazio("Nenhuma mensagem encontrada.", "Ajuste os filtros ou aguarde novos envios. Mensagens de teste também aparecem aqui.", { tom: "neutro", icone: "message-circle" })}`;
  return `${cabecalho}
    <div class="padm-tabela-wrap">
      <table class="padm-tabela padm-tabela--larga">
        <thead><tr><th>Data/Hora</th><th>Empresa</th><th>Unidade</th><th>Tipo</th><th>Origem</th><th>Destinatário</th><th>Status</th><th>Tentativas</th><th>Entrega</th><th>Leitura</th><th>Ações</th></tr></thead>
        <tbody>${pacote.itens.map(linhaMensagem).join("")}</tbody>
      </table>
    </div>
    ${pacote.limitadoA500 ? `<p class="padm-form-nota">Exibindo as 500 mensagens mais recentes deste filtro.</p>` : ""}
    ${htmlPaginacaoCentral(pacote, "historico")}`;
}

/** Detalhe de uma mensagem (modal). Ids abreviados; nenhum telefone completo, nenhum conteúdo. */
export function htmlDetalheMensagem(d) {
  if (!d) return carregando("lista");
  const linhas = [
    ["Mensagem", `<span class="padm-mono">${escapeHtml(d.idAbreviado ?? "—")}</span>`], ["Provedor", `<span class="padm-mono">${escapeHtml(d.providerMessageIdAbreviado ?? "—")}</span>`],
    ["Empresa / Unidade", `${escapeHtml(d.empresa ?? "—")} · ${escapeHtml(d.unidade ?? "—")}`], ["Origem", escapeHtml(ROTULO_ORIGEM[d.origem] ?? d.origem ?? "—")],
    ["Destinatário", `<span class="padm-mono">${escapeHtml(d.destinatario ?? "—")}</span>`], ["Status", chipStatusMensagem(d.status)],
    ["Criada", dt(d.criadoEm)], ["Agendada para", dt(d.agendadoPara)], ["Enviada ao provedor", dt(d.enviadoEm)], ["Aceita pelo WhatsApp", dt(d.servidorAceitouEm)],
    ["Entregue", dt(d.entregueEm)], ["Lida", dt(d.lidoEm)], ["Falhou", dt(d.falhouEm)],
    ["Tentativas", `${Number(d.tentativas ?? 0)}/${Number(d.maxTentativas ?? 0)}`],
    ["Erro", escapeHtml(d.erro ?? d.erroProvider ?? "—")], ["Motivo do cancelamento", escapeHtml(d.motivoCancelamento ?? "—")],
  ];
  const tent = (d.tentativasDetalhe ?? []).map((t) => `<li>Tentativa ${Number(t.numero)} · ${dt(t.iniciadoEm)} → ${dt(t.finalizadoEm)} · ${escapeHtml(t.resultado ?? "—")}${t.classificacao ? ` (${escapeHtml(t.classificacao)})` : ""}</li>`).join("");
  return `<div class="padm-drawer">
    <header class="padm-drawer-head"><h2>Detalhes da mensagem</h2><button type="button" class="btn btn-ghost btn-sm" data-padm-acao="fechar-detalhe-mensagem">Fechar</button></header>
    <div class="padm-drawer-corpo">
      <dl class="padm-detalhe">${linhas.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
      ${tent ? `<h3 class="padm-detalhe-sub">Tentativas</h3><ul class="padm-ativacao-lista">${tent}</ul>` : ""}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Configurações (SOMENTE LEITURA)
// ---------------------------------------------------------------------------

const fmtJanela = (j) => (j && typeof j === "object" ? Object.entries(j).map(([k, v]) => `${k.replace("seg_sex", "Segunda a sexta").replace("sab", "Sábado").replace("dom", "Domingo")}: ${v ? `${v.inicio}–${v.fim}` : "sem envio"}`).join(" · ") : "—");
const fmtMapa = (m, un) => (m && typeof m === "object" ? Object.entries(m).map(([k, v]) => `${k}: ${v}${un}`).join(" · ") : "—");

/** Horários de disponibilidade dos dados do iFood (D-1) — editáveis; nada de 10:00 fixo no código. */
export function htmlDisponibilidadeIfood(d) {
  if (!d) return "";
  return secao({
    titulo: "Disponibilidade dos dados do iFood", icone: "clock",
    sub: "Antes deste horário, empresas não serão cobradas pelo preenchimento dos dados referentes ao dia anterior.",
    corpo: `<form id="padm-com-disp-form" class="padm-form">
      <label>Dados do iFood disponíveis a partir de
        <input type="time" name="dadosDisponiveisApos" value="${escapeHtml(d.dadosDisponiveisApos ?? "")}" required />
      </label>
      <label>Início permitido para lembretes
        <input type="time" name="enviosPermitidosApos" value="${escapeHtml(d.enviosPermitidosApos ?? "")}" required />
      </label>
      <p class="padm-form-nota">O horário dos lembretes não pode ser anterior ao de disponibilidade dos dados. Vale para o horário local de cada empresa; o fim das comunicações segue a janela comercial.</p>
      <button type="submit" class="btn btn-primary btn-sm">Salvar horários</button>
    </form>`,
  });
}

export function htmlConfiguracoesCentral(c, disponibilidade = null) {
  if (!c) return carregando("lista");
  const linha = (rot, val, nota = "") => `<li><span class="padm-saude-rot">${escapeHtml(rot)}</span><span class="padm-saude-val">${val}</span>${nota ? `<small>${escapeHtml(nota)}</small>` : ""}</li>`;
  const ativacao = secao({
    titulo: "Ativação da comunicação", icone: "bell",
    sub: "Ligar ou desligar o envio é uma ação separada, com confirmação e auditoria. Salvar uma configuração nunca altera a ativação.",
    corpo: `<p class="padm-form-nota">A ativação global está na Visão geral; a habilitação de cada empresa está em Empresas → Ver detalhes.</p>`,
  });
  const operacional = secao({
    titulo: "Configuração operacional", icone: "settings", sub: "Somente leitura — valores aplicados hoje pelo sistema.",
    corpo: `<ul class="padm-saude-lista">
      ${linha("Tipos de alerta", escapeHtml((c.tiposDeAlerta ?? []).join(", ") || "—"), "Definido por empresa.")}
      ${linha("Janela comercial", escapeHtml(fmtJanela(c.janelaComercial)))}
      ${linha("Reforço D-1", `Janela ${escapeHtml(c.reforcoD1?.janela ?? "—")} · cutoff ${escapeHtml(c.reforcoD1?.cutoff ?? "—")} · ${escapeHtml(c.reforcoD1?.diasUteis ?? "")}`, `Espaçamento mínimo de ${Number(c.reforcoD1?.espacamentoMinimoHoras ?? 0)}h desde o primeiro aviso.`)}
      ${linha("Intervalo entre avisos (cooldown)", escapeHtml(fmtMapa(c.cooldownsHoras, " h")))}
      ${linha("Limites de mensagens", escapeHtml(fmtMapa(c.limites, "")))}
      ${linha("Validade da mensagem", `${Number(c.validadeDaMensagemHoras ?? 0)} h`)}
      ${linha("Espalhamento máximo", `${Number(c.espalhamentoMaximoMinutos ?? 0)} min`)}
    </ul>
    <p class="padm-form-nota">${escapeHtml(c.observacao ?? "")}</p>`,
  });
  return `${ativacao}${htmlDisponibilidadeIfood(disponibilidade)}${operacional}`;
}

// ---------------------------------------------------------------------------
// Teste controlado
// ---------------------------------------------------------------------------

/** Depois de ~2,5 min sem DELIVERED a tela NÃO chama de falha: mostra "Entrega ainda não confirmada". */
export const TIMEOUT_ENTREGA_SEGUNDOS = 150;
const SITUACOES_TERMINAIS = new Set(["LIDO", "FALHOU", "CANCELADO", "ENTREGA_NAO_CONFIRMADA"]);
export const testeTerminou = (s) => !!s && SITUACOES_TERMINAIS.has(s.situacao);

/**
 * Etapas do acompanhamento. NUNCA marca "Entregue" enquanto o status é SENT: só um DELIVERED/READ persistido acende essa etapa.
 * @returns {Array<{rotulo: string, estado: 'ok'|'andamento'|'pendente'|'erro'|'atencao'}>}
 */
export function etapasDoTeste(s, { segundosAguardando = 0 } = {}) {
  const situ = s?.situacao;
  const enviado = ["ENVIADO_AO_PROVEDOR", "ENTREGUE", "LIDO", "ENTREGA_NAO_CONFIRMADA"].includes(situ);
  const entregue = situ === "ENTREGUE" || situ === "LIDO";
  const lido = situ === "LIDO";
  const falhou = situ === "FALHOU" || situ === "CANCELADO";
  const passo = (rotulo, estado) => ({ rotulo, estado });
  const aguardando = situ === "ENVIADO_AO_PROVEDOR";
  const atrasou = aguardando && segundosAguardando >= TIMEOUT_ENTREGA_SEGUNDOS;
  return [
    passo("Preparando destinatário", "ok"),
    passo("Enviando", falhou ? "erro" : (situ === "PREPARANDO" || situ === "ENVIANDO" ? "andamento" : "ok")),
    passo("Enviado ao provedor", enviado ? "ok" : (falhou ? "pendente" : "pendente")),
    ...(situ === "ENTREGA_NAO_CONFIRMADA" ? [passo("Entrega não confirmada", "atencao")]
      : entregue ? [passo("Entregue", "ok")]
        : atrasou ? [passo("Entrega ainda não confirmada", "atencao")]
          : [passo(aguardando ? "Aguardando confirmação de entrega" : "Entregue", aguardando ? "andamento" : "pendente")]),
    passo("Lido", lido ? "ok" : "pendente"),
  ];
}

const ICONE_ETAPA = { ok: "check-circle", andamento: "clock", pendente: "minus-circle", erro: "alert-triangle", atencao: "alert-triangle" };

export function htmlAcompanhamentoTeste(s, opts = {}) {
  const etapas = etapasDoTeste(s, opts);
  const lista = etapas.map((e) => `<li class="padm-etapa padm-etapa--${e.estado}">${icon(ICONE_ETAPA[e.estado], { size: 15 })}<span>${escapeHtml(e.rotulo)}</span></li>`).join("");
  const atrasou = s?.situacao === "ENVIADO_AO_PROVEDOR" && (opts.segundosAguardando ?? 0) >= TIMEOUT_ENTREGA_SEGUNDOS;
  let aviso = "";
  if (s?.situacao === "FALHOU") aviso = `<p class="padm-teste-aviso padm-teste-aviso--erro">O envio de teste falhou${s.erro ? `: ${escapeHtml(s.erro)}` : ""}. Nenhuma nova tentativa foi feita.</p>`;
  else if (s?.situacao === "ENTREGA_NAO_CONFIRMADA") aviso = `<p class="padm-teste-aviso">Não foi possível confirmar se a mensagem saiu. Nenhum reenvio foi feito.</p>`;
  else if (atrasou) aviso = `<p class="padm-teste-aviso">Entrega ainda não confirmada. Isso não significa falha — a confirmação pode chegar a qualquer momento. Nenhum reenvio será feito.</p>`;
  else if (s?.situacao === "LIDO") aviso = `<p class="padm-teste-aviso padm-teste-aviso--ok">Mensagem entregue e lida.</p>`;
  else if (s?.situacao === "ENTREGUE") aviso = `<p class="padm-teste-aviso padm-teste-aviso--ok">Mensagem entregue. A leitura é opcional.</p>`;
  const tempos = s ? `<ul class="padm-teste-tempos"><li>Enviado ao provedor: ${dt(s.enviadoEm)}</li><li>Entregue: ${dt(s.entregueEm)}</li><li>Lido: ${dt(s.lidoEm)}</li></ul>` : "";
  return `<ol class="padm-etapas">${lista}</ol>${aviso}${tempos}
    ${s?.mensagemId ? `<button type="button" class="btn btn-ghost btn-sm" data-padm-com-msg="${escapeHtml(s.mensagemId)}">Abrir diagnóstico</button>` : ""}`;
}

const linhaPreparo = (rot, ok, textoOk, textoNao) => `<li class="${ok ? "padm-check-ok" : "padm-check-pendente"}">${icon(ok ? "check-circle" : "minus-circle", { size: 13 })} ${escapeHtml(rot)}: <strong>${escapeHtml(ok ? textoOk : textoNao)}</strong></li>`;

export const TEXTO_CONFIRMACAO_TESTE = "Confirmo o envio de uma mensagem de teste para este destinatário.";

/**
 * Conteúdo do modal do teste. `fase`: 'confirmar' | 'enviando' | 'acompanhando' | 'erro'.
 * @param {object} preparo GET /comunicacao/teste/preparo
 */
export function htmlModalTeste(preparo, { fase = "confirmar", status = null, erro = null, segundosAguardando = 0 } = {}) {
  if (!preparo) return `<div class="padm-drawer padm-modal-teste">${carregando("lista")}</div>`;
  const cab = `<header class="padm-drawer-head"><h2>Enviar teste de comunicação</h2><button type="button" class="btn btn-ghost btn-sm" data-padm-acao="fechar-teste">Fechar</button></header>`;
  if (fase === "enviando" || fase === "acompanhando") {
    return `<div class="padm-drawer padm-modal-teste">${cab}<div class="padm-drawer-corpo">
      <p class="padm-teste-alvo">${escapeHtml(preparo.organizacao?.nome ?? "")} · ${escapeHtml(preparo.unidade?.nome ?? "")} · <span class="padm-mono">${escapeHtml(preparo.contato?.telefoneMascarado ?? "—")}</span></p>
      ${fase === "enviando" ? `<ol class="padm-etapas"><li class="padm-etapa padm-etapa--ok">${icon("check-circle", { size: 15 })}<span>Preparando destinatário</span></li><li class="padm-etapa padm-etapa--andamento">${icon("clock", { size: 15 })}<span>Enviando</span></li></ol>` : htmlAcompanhamentoTeste(status, { segundosAguardando })}
    </div></div>`;
  }
  if (fase === "erro") {
    return `<div class="padm-drawer padm-modal-teste">${cab}<div class="padm-drawer-corpo">
      <p class="padm-teste-aviso padm-teste-aviso--erro">${escapeHtml(erro ?? "Não foi possível enviar o teste.")}</p>
      <p class="padm-form-nota">Nenhuma mensagem foi enviada.</p>
    </div></div>`;
  }
  const bloqueios = preparo.bloqueios ?? [];
  const c = preparo.contato;
  const checagens = `<ul class="padm-checklist-piloto">
      ${linhaPreparo("WhatsApp", preparo.whatsapp === "conectado", "conectado", "não conectado")}
      ${linhaPreparo("Consentimento", c?.consentimento === true, "confirmado", "pendente")}
      ${linhaPreparo("Número", c?.verificado === true, "verificado", "não verificado")}
      ${linhaPreparo("Automação", preparo.modo === "DISABLED", "desativada (necessário para o teste)", "ativada — desative antes de testar")}
      ${linhaPreparo("Piloto", preparo.piloto?.destinatarioPermitido === true, "destinatário autorizado", "destinatário não autorizado")}
      ${linhaPreparo("Limite de testes", (preparo.limite?.usados ?? 0) < (preparo.limite?.maximo ?? 1), `${preparo.limite?.usados ?? 0} de ${preparo.limite?.maximo ?? 1} usado(s)`, `limite atingido (${preparo.limite?.usados ?? 0} de ${preparo.limite?.maximo ?? 1})`)}
    </ul>`;
  const unidades = (preparo.unidadesDisponiveis ?? []);
  return `<div class="padm-drawer padm-modal-teste">${cab}<div class="padm-drawer-corpo">
    <dl class="padm-detalhe">
      <div><dt>Empresa</dt><dd>${escapeHtml(preparo.organizacao?.nome ?? "—")}</dd></div>
      <div><dt>Unidade</dt><dd>${unidades.length > 1
        ? `<select id="padm-teste-unidade">${unidades.map((u) => `<option value="${escapeHtml(u.unidadeId)}" ${u.unidadeId === preparo.unidade?.unidadeId ? "selected" : ""}>${escapeHtml(u.nome)}</option>`).join("")}</select>`
        : escapeHtml(preparo.unidade?.nome ?? "—")}</dd></div>
      <div><dt>Contato</dt><dd><span class="padm-mono">${escapeHtml(c?.telefoneMascarado ?? "—")}</span></dd></div>
      <div><dt>Gateway</dt><dd>${escapeHtml(ROTULO_GATEWAY[preparo.whatsapp] ?? "—")}</dd></div>
    </dl>
    ${checagens}
    <h3 class="padm-detalhe-sub">Mensagem</h3>
    <p class="padm-preview-texto">${escapeHtml(preparo.previewTexto ?? "")}</p>
    ${bloqueios.length ? `<div class="padm-teste-aviso padm-teste-aviso--erro"><strong>Não é possível enviar agora:</strong><ul>${bloqueios.map((b) => `<li>${escapeHtml(b.mensagem)}</li>`).join("")}</ul></div>` : ""}
    <label class="padm-check padm-teste-confirma"><input type="checkbox" id="padm-teste-confirma" ${bloqueios.length ? "disabled" : ""} /> ${escapeHtml(TEXTO_CONFIRMACAO_TESTE)}</label>
    <div class="padm-teste-acoes">
      <button type="button" class="btn btn-ghost btn-sm" data-padm-acao="fechar-teste">Cancelar</button>
      <button type="button" class="btn btn-primary btn-sm" data-padm-acao="confirmar-teste" disabled>Enviar mensagem de teste</button>
    </div>
  </div></div>`;
}

/** Aba "Teste": explica o objetivo, mostra o estado e o botão que abre o modal. */
export function htmlAbaTeste({ resumo, orgs = [], testes = null } = {}) {
  const desativada = resumo?.comunicacao?.modo === "DISABLED";
  const candidatas = orgs.filter((o) => o.contato);
  const motivo = !desativada ? "O teste só pode ser feito com a automação desativada." : !candidatas.length ? "Nenhuma empresa tem destinatário configurado." : "";
  const seletor = candidatas.length > 1
    ? `<label class="padm-teste-empresa">Empresa<select id="padm-teste-org">${candidatas.map((o) => `<option value="${escapeHtml(o.organizacaoId)}">${escapeHtml(o.nome)}</option>`).join("")}</select></label>`
    : (candidatas[0] ? `<input type="hidden" id="padm-teste-org" value="${escapeHtml(candidatas[0].organizacaoId)}" /><p class="padm-teste-alvo">${escapeHtml(candidatas[0].nome)}</p>` : "");
  const lista = testes && testes.itens?.length
    ? `<div class="padm-tabela-wrap"><table class="padm-tabela"><thead><tr><th>Data/Hora</th><th>Empresa</th><th>Status</th><th>Entrega</th><th>Leitura</th><th></th></tr></thead><tbody>${testes.itens.map((m) => `<tr><td>${dt(m.criadoEm)}</td><td>${escapeHtml(m.empresa ?? "—")}</td><td>${chipStatusMensagem(m.status)}</td><td>${dt(m.entregueEm)}</td><td>${dt(m.lidoEm)}</td><td><button type="button" class="btn btn-ghost btn-sm" data-padm-com-msg="${escapeHtml(m.id)}">Detalhes</button></td></tr>`).join("")}</tbody></table></div>`
    : `<p class="padm-vazio">Nenhum teste realizado ainda.</p>`;
  return `${secao({
    titulo: "Teste de Comunicação", icone: "send",
    sub: "Valida a infraestrutura do WhatsApp com UMA mensagem controlada — sem alerta, sem worker, sem automação.",
    corpo: `
      <p>Use para confirmar que o WhatsApp está enviando, entregando e registrando a leitura. A mensagem não é uma pendência e nenhuma ação é necessária de quem a recebe.</p>
      ${seletor}
      <div class="padm-teste-acoes"><button type="button" class="btn btn-primary btn-sm" data-padm-acao="abrir-teste" ${motivo ? "disabled" : ""}>Enviar teste</button></div>
      ${motivo ? `<p class="padm-form-nota">${escapeHtml(motivo)}</p>` : ""}`,
  })}${secao({ titulo: "Testes realizados", icone: "clock", corpo: lista })}`;
}

// ---------------------------------------------------------------------------
// Abas
// ---------------------------------------------------------------------------

export const ABAS_CENTRAL = Object.freeze([
  ["visao-geral", "Visão geral"], ["empresas", "Empresas"], ["historico", "Histórico"], ["fila", "Fila"], ["configuracoes", "Configurações"], ["teste", "Teste"],
]);

export function htmlAbasCentral(ativa) {
  return `<div class="padm-abas" role="tablist">${ABAS_CENTRAL.map(([id, label]) =>
    `<button type="button" class="padm-aba ${ativa === id ? "ativo" : ""}" data-padm-com-aba="${id}" role="tab" aria-selected="${ativa === id}">${escapeHtml(label)}</button>`).join("")}</div>`;
}
