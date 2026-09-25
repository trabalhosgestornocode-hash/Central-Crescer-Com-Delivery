// CENTRAL DE COMUNICAÇÃO — VISÃO GERAL. Responde, de relance: o WhatsApp está conectado? Qual conta? A identidade está confirmada? A conexão está saudável?
// Quantos avisos foram enviados, quantos estão programados, o que precisa de atenção. Construtores PUROS (dados → HTML).
//
// DADOS: contrato atual de `GET /comunicacao/central/visao-geral` + (opcional, buscado pelo controlador) `d.conexao` = estado da aba Conexão. Sem `conexao`, o cartão usa só
// `cards.whatsapp` (nome operacional/ambiente/pendência). Campos OPCIONAIS futuros (`cards.alertasHoje`, `atividade`, `empresas[].unidades`) são usados quando existirem.
// ORDEM DO DOM = prioridade no celular: 1 situação do WhatsApp (e a ação principal) → 2 o que precisa de atenção → 3 números → 4 atividade recente → 5 empresas e conversas.

import { escapeHtml as e } from "../utils.js";
import { icon } from "../icons.js";
import { avatar, htmlItemConversa } from "./centralUi.js";
import { badge, seloIdentidade, situacaoDoSelo, STATUS_DO_ESTADO_CONEXAO } from "./centralStatus.js";
import { htmlLinhaDoTempoAtividade, htmlEmpresasUnidades, empresasDaVisao } from "./centralAtividade.js";
import { saudeDaConexao, dataHoraCurta, ROTULO_ESTADO_CONEXAO } from "./centralModelo.js";

/** Modelo do cartão do WhatsApp a partir do que houver (estado da Conexão, se buscado, senão só os cards). Puro e testável. */
export function modeloWhatsapp(d, agora = new Date()) {
  const w = d?.cards?.whatsapp ?? {}; const cx = d?.conexao ?? null;
  const conectado = cx ? cx.estado === "CONNECTED" : w.estado === "conectado";
  const estado = cx?.estado ?? (conectado ? "CONNECTED" : w.estado === "instavel" ? "RECONNECTING" : "DISCONNECTED");
  const identStatus = cx?.identidade?.status ?? w.conta?.status ?? null;
  const ambiente = cx?.identidade?.ambiente ?? w.conta?.ambiente ?? null;
  const nomeOperacional = (identStatus === "CONFIRMADA" ? (cx?.identidade?.nomeOperacional ?? w.conta?.nomeOperacional) : null) ?? null;
  return {
    estado, conectado, identStatus, ambiente, nomeOperacional,
    confirmada: conectado && identStatus === "CONFIRMADA",
    pendente: conectado && identStatus === "PENDENTE_CONFIRMACAO",
    conta: cx?.conta ?? null, agente: cx?.identidade?.agenteCrescer === true,
    saude: cx ? saudeDaConexao(cx, agora) : null, permissao: cx?.permissoes?.gerenciar,
  };
}

function cartaoWhatsapp(d, agora) {
  const m = modeloWhatsapp(d, agora);
  const auto = d.cards.automacao;
  const sit = situacaoDoSelo(m.estado === "RECONNECTING" ? "CONNECTING" : m.estado, m.identStatus);
  const conteudo = m.conectado
    ? avatar({ contatoId: m.conta?.telefoneMascarado ?? "wa", nome: m.conta?.nome ?? "WhatsApp", iniciais: m.conta?.iniciais ?? "WA", fotoUrl: m.conta?.fotoUrl, tamanho: "g" })
    : `<span class="cc-vg-ic">${icon(m.estado === "RECONNECTING" ? "refresh" : "wifi-off", { size: 30 })}</span>`;
  const distintivos = m.conectado
    ? `${badge("conectado")}${m.confirmada ? badge("confirmado", { texto: "Conta confirmada" }) : m.pendente ? badge("pendente", { texto: "Identidade ainda não confirmada" }) : ""}`
    : badge(STATUS_DO_ESTADO_CONEXAO[m.estado] ?? "desconectado");
  const titulo = m.conectado ? (m.nomeOperacional ?? m.conta?.nome ?? "WhatsApp conectado") : `WhatsApp: ${ROTULO_ESTADO_CONEXAO[m.estado] ?? "estado não informado"}`;
  const chips = m.conectado ? `<div class="cc-id-chips">
      ${m.conta?.telefoneMascarado ? `<span class="cc-tel cc-chip-num">${icon("smartphone", { size: 13 })}${e(m.conta.telefoneMascarado)}</span>` : ""}
      ${m.ambiente ? `<span class="cc-tag ${m.ambiente === "PRODUCAO" ? "cc-tag--ok" : "cc-tag--neutro"}">${icon(m.ambiente === "PRODUCAO" ? "check-circle" : "flask", { size: 12 })}${e(m.ambiente === "PRODUCAO" ? "Produção" : "Ambiente de teste")}</span>` : ""}
      ${m.agente && m.confirmada ? `<span class="cc-tag cc-tag--agente">${icon("bot", { size: 12 })}Agente Crescer</span>` : ""}</div>` : "";
  const saude = m.conectado && m.saude ? `<p class="cc-vg-saude cc-vg-saude--${e(m.saude.tom)}"><i class="cc-dot"></i><strong>${e(m.saude.texto)}</strong>${m.saude.detalhe ? `<span>${e(m.saude.detalhe)}</span>` : ""}</p>` : "";
  const nota = m.pendente ? `<p class="cc-vg-nota">A conexão está funcionando. Falta a confirmação do operador; as ações automáticas continuam protegidas.${m.permissao === false ? " Apenas um administrador autorizado pode confirmar esta conta." : ""}</p>`
    : !m.conectado ? `<p class="cc-vg-nota">Nenhuma mensagem pode ser enviada ou recebida até a conexão voltar. O histórico continua preservado.</p>` : "";
  const cta = m.permissao === false ? `<button type="button" class="btn btn-ghost btn-sm" data-cc-ir="conexao">${icon("eye", { size: 14 })} Ver conexão</button>`
    : m.pendente ? `<button type="button" class="btn btn-primary btn-sm cc-btn-grande" data-cc-ir="conexao">${icon("shield-check", { size: 14 })} Revisar e confirmar conta</button>`
    : !m.conectado ? `<button type="button" class="btn btn-primary btn-sm cc-btn-grande" data-cc-ir="conexao">${icon("qr-code", { size: 14 })} Abrir Conexão</button>`
      : `<button type="button" class="btn btn-ghost btn-sm" data-cc-ir="conexao">${icon("settings", { size: 14 })} Gerenciar conexão</button>`;
  const clima = m.confirmada ? "ok" : m.estado === "AUTH_ERROR" ? "critico" : m.pendente || ["CONNECTING", "WAITING_QR", "RECONNECTING"].includes(m.estado) ? "atencao" : "neutro";
  return `<section class="cc-vg-zap cc-id-card cc-id-card--${clima}" data-cc-estado-conexao="${e(m.estado)}" aria-label="WhatsApp">
    <div class="cc-id-visual">${seloIdentidade({ situacao: sit, tam: "g", conteudo })}</div>
    <div class="cc-id-corpo">
      <p class="cc-id-estado">${distintivos}${auto.ativa ? badge("ativo", { tam: "p", texto: "Automação ativa" }) : badge("pausado", { tam: "p", texto: auto.rotulo ?? "Automação desativada" })}</p>
      <h2 class="cc-vg-titulo">${e(titulo)}</h2>${chips}${saude}${nota}
      <div class="cc-id-acoes">${cta}</div>
    </div>
  </section>`;
}

function kpi({ ic, rotulo, valor, nota = "", tom = "neutro", alvo = "" }) {
  const corpo = `<span class="cc-kpi-ic">${icon(ic, { size: 17 })}</span><span class="cc-kpi-rot">${e(rotulo)}</span><strong class="cc-kpi-val">${e(String(valor))}</strong><span class="cc-kpi-nota">${e(nota)}</span>`;
  return alvo ? `<button type="button" class="cc-kpi cc-kpi--${tom}" data-cc-ir="${e(alvo)}">${corpo}</button>` : `<div class="cc-kpi cc-kpi--${tom}">${corpo}</div>`;
}

/** Números do dia. Só mostra o que o backend informa; "Alertas hoje" aparece quando `cards.alertasHoje` existir. */
export function htmlKpis(d, { agora = new Date() } = {}) {
  const c = d.cards;
  const prox = d.proximosEnvios ?? [];
  const programadas = Number.isFinite(c.programadas) ? c.programadas : prox.length;
  const proximo = prox.length ? [...prox].sort((a, b) => Date.parse(a.em) - Date.parse(b.em))[0] : null;
  const atencao = (d.alertas ?? []).filter((a) => a.severidade === "critico" || a.severidade === "atencao").length;
  const tiles = [
    Number.isFinite(c.alertasHoje) ? kpi({ ic: "bell", rotulo: "Alertas hoje", valor: c.alertasHoje, nota: c.alertasHoje ? "Pendências identificadas" : "Nenhum hoje", alvo: "automacoes" }) : "",
    kpi({ ic: "calendar", rotulo: Number.isFinite(c.programadas) ? "Programadas" : "Próximos envios", valor: programadas, nota: proximo ? `Próxima: ${dataHoraCurta(proximo.em, agora).replace(/^Hoje, /, "")}` : programadas ? "Horário não informado" : "Nenhum envio programado", tom: "info", alvo: "automacoes" }),
    kpi({ ic: "send", rotulo: "Enviadas hoje", valor: c.mensagensHoje.enviadas, nota: c.entreguesHojePct == null ? `${c.mensagensHoje.recebidas} recebidas` : `${c.entreguesHojePct}% entregues`, tom: "ok", alvo: "historico" }),
    kpi({ ic: "message-circle", rotulo: "Conversas não lidas", valor: c.conversasNaoLidas, nota: c.conversasNaoLidas ? "Com mensagens não lidas" : "Tudo lido", tom: c.conversasNaoLidas ? "marca" : "neutro", alvo: "conversas:nao_lidas" }),
    kpi({ ic: "alert-octagon", rotulo: "Falhas hoje", valor: c.falhasHoje, nota: c.falhasHoje ? "Veja o motivo no histórico" : "Nenhuma", tom: c.falhasHoje ? "critico" : "neutro", alvo: c.falhasHoje ? "historico:FAILED" : "" }),
    kpi({ ic: "alert-triangle", rotulo: "Precisam de atenção", valor: atencao, nota: atencao ? "Sinalizados nesta visão" : "Nenhum alerta registrado", tom: atencao ? "atencao" : "neutro" }),
  ].filter(Boolean).join("");
  return `<div class="cc-kpis" role="group" aria-label="Números de hoje">${tiles}</div>`;
}

/** O cartão do WhatsApp já conta estas duas situações (fora do ar / conta a confirmar): repetir seria ruído. */
export const ALERTAS_DO_CARTAO = Object.freeze(["gateway", "conta_pendente"]);
export const alertasDaLista = (alertas) => (alertas ?? []).filter((a) => !ALERTAS_DO_CARTAO.includes(a.id));

const ICONE_ALERTA = { critico: "alert-octagon", atencao: "alert-triangle", info: "info" };

/** Alertas que precisam de ação. `info` (ex.: automação desativada) não vira alerta vermelho: entra como aviso neutro. */
export function htmlAlertasDaVisao(alertas) {
  const lista = (alertas ?? []);
  if (!lista.length) return `<div class="cc-tudo-certo" role="status">${icon("shield-check", { size: 18 })}<div><strong>Tudo em ordem</strong><span>Nenhum alerta importante agora.</span></div></div>`;
  return `<section class="cc-bloco cc-vg-atencao" aria-label="Precisa de atenção"><header class="cc-bloco-cab"><h2>Precisa de atenção</h2><span class="cc-contagem">${lista.length}</span></header>
    <ul class="cc-alertas-v2">${lista.map((a) => `<li class="cc-alerta-v2 cc-alerta-v2--${e(a.severidade)}"><span class="cc-alerta-v2-ic">${icon(ICONE_ALERTA[a.severidade] ?? "info", { size: 18 })}</span>
      <div><strong>${e(a.titulo)}</strong><p>${e(a.texto)}</p></div>
      ${a.destino ? `<button type="button" class="btn btn-ghost btn-sm" data-cc-ir="${e([a.destino.aba, a.destino.filtro ?? a.destino.status].filter(Boolean).join(":"))}">Ver</button>` : ""}</li>`).join("")}</ul></section>`;
}

export function htmlVisaoGeral(d, { agora = new Date() } = {}) {
  const alertas = alertasDaLista(d.alertas);
  const m = modeloWhatsapp(d, agora);
  const atencao = !alertas.length && (!m.conectado || m.pendente || (d.alertas ?? []).length) ? "" : htmlAlertasDaVisao(alertas);
  const recentes = (d.conversasRecentes ?? []).slice(0, 3);
  const conversas = recentes.length
    ? `<div class="cc-itens cc-itens--compacto" role="list">${recentes.map((x) => htmlItemConversa(x, { agora, compacto: true })).join("")}</div>`
    : `<div class="cc-vazio cc-vazio--leve">${icon("message-circle", { size: 22 })}<strong>Nenhuma conversa ainda</strong><p>Quando um responsável escrever ou você enviar uma mensagem, ela aparece aqui.</p></div>`;
  return `<div class="cc-visao">
    <div class="cc-visao-area cc-visao-area--zap">${cartaoWhatsapp(d, agora)}</div>
    <div class="cc-visao-area cc-visao-area--alertas">${atencao}</div>
    <div class="cc-visao-area cc-visao-area--kpis">${htmlKpis(d, { agora })}</div>
    <section class="cc-bloco cc-visao-area cc-visao-area--ativ"><header class="cc-bloco-cab"><h2>Atividade recente</h2><button type="button" class="cc-link" data-cc-ir="historico">Ver histórico</button></header>${htmlLinhaDoTempoAtividade(d, { agora })}</section>
    <div class="cc-visao-area cc-visao-area--lado">
      <section class="cc-bloco"><header class="cc-bloco-cab"><h2>Empresas e unidades</h2><button type="button" class="cc-link" data-cc-ir="automacoes">Ver automações</button></header>${htmlEmpresasUnidades(empresasDaVisao(d), { verTodas: "automacoes" })}</section>
      <section class="cc-bloco"><header class="cc-bloco-cab"><h2>Conversas recentes</h2><button type="button" class="cc-link" data-cc-ir="conversas">Abrir conversas</button></header>${conversas}</section>
    </div>
  </div>`;
}
