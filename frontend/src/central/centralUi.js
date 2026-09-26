// CENTRAL DE COMUNICAÇÃO — construtores PUROS (dados → string HTML; sem DOM, sem rede). A ligação com a página (eventos, chamadas, polling) é do controlador.
//
// LINGUAGEM: vocabulário de NEGÓCIO. "Enviada ao WhatsApp" nunca é "Entregue". Telefone só mascarado (o backend nem manda o número). Nada de segredo, HMAC, token,
// auth-state, lease/epoch ou id completo. Sem emoji: ícones SVG do projeto. Nenhum handler inline (a CSP bloqueia): tudo é `data-cc-*` + delegação no controlador.

import { escapeHtml as e } from "../utils.js";
import { icon } from "../icons.js";
import { badge } from "./centralStatus.js";
import { htmlEmpresasUnidades } from "./centralAtividade.js";
import {
  ABAS, FILTROS_CONVERSA, ROTULO_CATEGORIA, ROTULO_ORIGEM, ROTULO_STATUS, trilhaDe, rotuloStatus, dicaStatus,
  horaLocal, horarioCurto, dataHoraCurta, blocosDaConversa, matizDe, resumirLista, resumoAssociacoes, rotuloEntrega, situacaoDoContato, caracteres, TEXTO_MAX,
} from "./centralModelo.js";

const https = (u) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : null);
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;

// ---------------------------------------------------------------------------
// Peças pequenas
// ---------------------------------------------------------------------------

/** Avatar: as iniciais SEMPRE existem por baixo; a foto (quando há) cobre — se ela falhar, o controlador remove a <img> e as iniciais aparecem. */
export function avatar({ contatoId, nome, iniciais, fotoUrl, tamanho = "m" }) {
  const foto = https(fotoUrl);
  return `<span class="cc-avatar cc-avatar--${tamanho}" style="--h:${matizDe(contatoId ?? nome)}" role="img" aria-label="${e(nome ?? "Responsável")}">
    <span class="cc-avatar-ini" aria-hidden="true">${e(iniciais ?? "?")}</span>${foto ? `<img class="cc-avatar-img" src="${e(foto)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-cc-foto>` : ""}
  </span>`;
}

/**
 * Trilha de entrega: 3 marcas (enviada, entregue, lida). Cada marca só acende com o próprio fato. Tooltip por foco/hover (`data-dica`) e rótulo acessível.
 * @param {string} status
 * @param {{texto?: boolean, rotulo?: string}} [o] `texto`: mostra o rótulo ao lado (estados que pedem atenção); `rotulo`: texto já pronto do último estado comprovado ("Entregue 10:32")
 */
export function trilha(status, { texto = false, rotulo = "" } = {}) {
  const marcas = trilhaDe(status);
  const resumo = `${rotuloStatus(status)}. ${dicaStatus(status)}`.trim();
  const ponto = marcas.map((m) => `<i class="cc-marca cc-marca--${m.estado}" data-dica="${e(`${m.rotulo}: ${m.dica}`)}"></i>`).join("");
  return `<span class="cc-trilha" role="img" tabindex="0" aria-label="${e(resumo)}" data-dica="${e(resumo)}">${ponto}</span>${texto ? `<span class="cc-status-txt cc-status-txt--${e(String(status).toLowerCase())}">${e(rotuloStatus(status))}</span>` : rotulo ? `<span class="cc-status-txt cc-status-txt--${e(String(status).toLowerCase())}">${e(rotulo)}</span>` : ""}`;
}

/** Estados que merecem o rótulo por extenso ao lado da trilha (o resto a trilha já conta). */
const COM_TEXTO = new Set(["SCHEDULED", "FAILED", "DELIVERY_UNKNOWN", "CANCELLED", "BLOCKED", "SENDING", "PROCESSING"]);

const pill = (tom, texto, extra = "") => `<span class="cc-pill cc-pill--${tom}"${extra}><i class="cc-dot"></i>${e(texto)}</span>`;

export function vazio({ titulo, texto = "", icone = "message-circle", acao = "" }) {
  return `<div class="cc-vazio">${icon(icone, { size: 26 })}<strong>${e(titulo)}</strong>${texto ? `<p>${e(texto)}</p>` : ""}${acao}</div>`;
}

export const skeletonLista = (n = 7) => `<div class="cc-skel-lista" aria-hidden="true">${Array.from({ length: n }, () => `<div class="cc-skel-item"><i class="cc-skel cc-skel--av"></i><div><i class="cc-skel cc-skel--l1"></i><i class="cc-skel cc-skel--l2"></i></div></div>`).join("")}</div>`;
export const skeletonChat = () => `<div class="cc-skel-chat" aria-hidden="true"><i class="cc-skel cc-skel--b1"></i><i class="cc-skel cc-skel--b2"></i><i class="cc-skel cc-skel--b3"></i><i class="cc-skel cc-skel--b4"></i></div>`;
export const skeletonPainel = () => `<div class="cc-skel-painel" aria-hidden="true"><i class="cc-skel cc-skel--medida"></i><i class="cc-skel cc-skel--medida"></i><i class="cc-skel cc-skel--medida"></i><i class="cc-skel cc-skel--medida"></i><i class="cc-skel cc-skel--medida"></i><i class="cc-skel cc-skel--medida"></i></div><div class="cc-skel-blocos" aria-hidden="true"><i class="cc-skel cc-skel--bloco"></i><i class="cc-skel cc-skel--bloco"></i></div>`;
export const skeletonTabela = () => `<div class="cc-skel-tabela" aria-hidden="true">${Array.from({ length: 8 }, () => `<i class="cc-skel cc-skel--linha"></i>`).join("")}</div>`;

export const erroCentral = (msg) => `<div class="cc-erro" role="alert">${icon("alert-triangle", { size: 18 })}<div><strong>Não foi possível carregar.</strong><p>${e(msg || "Tente novamente em instantes.")}</p></div><button type="button" class="btn btn-ghost btn-sm" data-cc-acao="recarregar">Tentar de novo</button></div>`;

// ---------------------------------------------------------------------------
// Cabeçalho e abas
// ---------------------------------------------------------------------------

/** Estado vivo do topo: WhatsApp e automação, sempre visíveis. `estado` pode ser null enquanto carrega. */
export function htmlPillsEstado(estado) {
  if (!estado) return `<span class="cc-pill cc-pill--carregando"><i class="cc-dot"></i>Verificando…</span>`;
  const gw = estado.gateway;
  const zap = { conectado: badge("conectado", { texto: "WhatsApp conectado" }), desconectado: badge("desconectado", { texto: "WhatsApp desconectado" }), instavel: badge("atencao", { texto: "WhatsApp instável" }) }[gw] ?? badge("desconectado", { texto: "WhatsApp sem sinal" });
  const auto = estado.modo === "NORMAL" ? badge("ativo", { texto: "Automação ativa" }) : badge("pausado", { texto: estado.modo === "REACTIVE_ONLY" ? "Automação somente reativa" : "Automação desativada" });
  // identidade INTERNA da conta conectada (nome operacional / ambiente): só aparece quando há conta e o backend a informou
  const id = estado.identidade;
  const ident = gw === "conectado" && id ? (id.status === "PENDENTE_CONFIRMACAO" ? badge("pendente", { texto: "Conta a confirmar" }) : id.nomeOperacional ? badge("confirmado", { texto: id.nomeOperacional }) : id.ambiente === "TESTE" ? pill("neutro", "Ambiente de teste") : "") : "";
  return `${zap}${ident}${estado.modo ? auto : ""}`;
}

export function htmlTopo({ aba, estado, naoLidas = 0 }) {
  const abas = ABAS.map(([id, rotulo]) => {
    const badge = id === "conversas" && naoLidas > 0 ? `<span class="cc-badge" aria-label="${plural(naoLidas, "conversa não lida", "conversas não lidas")}">${naoLidas > 99 ? "99+" : naoLidas}</span>` : "";
    return `<button type="button" class="cc-aba" role="tab" id="cc-aba-${id}" aria-selected="${aba === id}" tabindex="${aba === id ? 0 : -1}" data-cc-aba="${id}">${e(rotulo)}${badge}</button>`;
  }).join("");
  return `<header class="cc-topo">
      <div class="cc-topo-id"><h1 class="cc-titulo">Central de Comunicação</h1><p class="cc-sub">Conversas e automação do WhatsApp com os responsáveis das empresas.</p></div>
      <div class="cc-topo-estado" data-cc-pills aria-live="polite">${htmlPillsEstado(estado)}</div>
    </header>
    <nav class="cc-abas" role="tablist" aria-label="Seções da Central">${abas}<i class="cc-aba-marca" aria-hidden="true"></i></nav>`;
}

// ---------------------------------------------------------------------------
// Lista de conversas
// ---------------------------------------------------------------------------

/** Empresa (ou unidade) principal + resumo do resto, para uma linha só. */
function linhaEmpresa(c) {
  const emp = c.empresas?.[0]?.nome ?? "";
  const un = c.unidades ?? [];
  const extraEmp = Math.max(0, (c.empresas?.length ?? 0) - 1);
  const rotuloUn = un.length === 1 ? un[0].nome : un.length > 1 ? plural(un.length, "unidade", "unidades") : "";
  return { emp, extraEmp, rotuloUn };
}

export function htmlItemConversa(c, { ativo = false, agora = new Date(), compacto = false } = {}) {
  const { emp, extraEmp, rotuloUn } = linhaEmpresa(c);
  const ult = c.ultimaMensagem;
  const naoLida = (c.naoLidas ?? 0) > 0;
  const previa = ult ? e(ult.previa || (ult.direcao === "entrada" ? "Mensagem recebida" : "")) : `<span class="cc-item-sem">Sem mensagens recentes</span>`;
  const marca = ult?.direcao === "saida" && ult.status ? `<span class="cc-item-trilha">${trilha(ult.status)}</span>` : "";
  const cat = ult?.direcao === "saida" ? `<span class="cc-item-cat cc-item-cat--${e(ult.categoria)}" title="${e(ROTULO_CATEGORIA[ult.categoria] ?? "")}">${icon(ult.categoria === "manual" ? "user" : ult.categoria === "teste" ? "flask" : "bot", { size: 12 })}</span>` : "";
  const pend = (c.pendenciasAtuais ?? 0) > 0 ? `<span class="cc-item-pend" title="${e(plural(c.pendenciasAtuais, "pendência atual", "pendências atuais"))}">${icon("alert-triangle", { size: 12 })}</span>` : "";
  return `<div class="cc-item${ativo ? " is-ativo" : ""}${naoLida ? " is-nao-lida" : ""}" ${compacto ? 'role="listitem"' : `role="option" aria-selected="${ativo}"`} data-cc-conversa="${e(c.contatoId)}" tabindex="0">
    ${avatar({ contatoId: c.contatoId, nome: c.nome, iniciais: c.iniciais, fotoUrl: c.fotoUrl })}
    <div class="cc-item-corpo">
      <div class="cc-item-linha"><strong class="cc-item-nome">${e(c.nome)}</strong><time class="cc-item-hora" datetime="${e(ult?.em ?? "")}">${e(ult ? horarioCurto(ult.em, agora) : "")}</time></div>
      <div class="cc-item-linha cc-item-empresa"><span class="cc-item-emp">${e(emp)}${extraEmp ? ` <em>mais ${extraEmp}</em>` : ""}</span>${rotuloUn ? `<span class="cc-item-un">${e(rotuloUn)}</span>` : ""}${pend}</div>
      <div class="cc-item-linha"><span class="cc-item-previa">${cat}${marca}<span class="cc-item-texto">${previa}</span></span>${naoLida ? `<span class="cc-contador" aria-label="${plural(c.naoLidas, "mensagem não lida", "mensagens não lidas")}">${c.naoLidas > 99 ? "99+" : c.naoLidas}</span>` : ""}</div>
    </div>
    <button type="button" class="cc-item-mais" data-cc-menu="conversa:${e(c.contatoId)}" aria-label="Opções da conversa de ${e(c.nome)}" aria-haspopup="menu">${icon("more", { size: 16 })}</button>
  </div>`;
}

export function htmlFiltros({ filtro, totais = {} }) {
  const cont = { todas: totais.todas, nao_lidas: totais.naoLidas, pendencias: totais.pendencias, automacao: totais.automacao, humano: totais.humano };
  return `<div class="cc-filtros" role="tablist" aria-label="Filtrar conversas">${FILTROS_CONVERSA.map(([id, rot]) =>
    `<button type="button" class="cc-filtro" role="tab" aria-selected="${filtro === id}" data-cc-filtro="${id}">${e(rot)}${cont[id] ? `<em>${cont[id]}</em>` : ""}</button>`).join("")}</div>`;
}

/** Coluna esquerda inteira. `carregando`: skeleton; `busca`: termo atual (preserva o texto digitado). */
export function htmlListaConversas({ itens, totais, filtro, busca, selecionada, carregando = false, agora = new Date() }) {
  const corpo = carregando ? skeletonLista()
    : !itens?.length ? (busca ? vazio({ titulo: "Nenhum responsável encontrado", texto: "Confira o nome do responsável, da empresa ou da unidade. O telefone não é pesquisável.", icone: "search" })
      : filtro !== "todas" ? vazio({ titulo: "Nada neste filtro", texto: "Nenhuma conversa corresponde a este filtro agora.", icone: "filter" })
        : vazio({ titulo: "Nenhuma conversa ainda", texto: "Quando um responsável escrever ou você enviar uma mensagem, a conversa aparece aqui. Para começar, abra um responsável em Destinatários.", icone: "message-circle" }))
      : `<div class="cc-itens" role="listbox" aria-label="Conversas">${itens.map((c) => htmlItemConversa(c, { ativo: c.contatoId === selecionada, agora })).join("")}</div>`;
  return `<div class="cc-lista-cab">
      <h2 class="cc-lista-titulo">Conversas</h2>
      <label class="cc-busca">${icon("search", { size: 15 })}<input type="search" id="cc-busca" placeholder="Buscar por nome, empresa ou unidade" value="${e(busca ?? "")}" autocomplete="off" aria-label="Buscar por nome, empresa ou unidade" /></label>
      ${htmlFiltros({ filtro, totais })}
    </div>${corpo}`;
}

// ---------------------------------------------------------------------------
// Conversa
// ---------------------------------------------------------------------------

/** Chips das unidades do responsável (até `max`; o resto vira "+N"). */
export function chipsUnidades(unidades, max = 4) {
  const { visiveis, resto } = resumirLista(unidades, max);
  return `${visiveis.map((u) => `<span class="cc-chip">${e(u.nome)}</span>`).join("")}${resto ? `<span class="cc-chip cc-chip--mais">+${resto}</span>` : ""}`;
}

export function htmlChatCabecalho(contato, envio, { detalhesAberto = false } = {}) {
  // Altura CONTROLADA: só a quantidade e até 3 unidades; o resto é "+N" e abre a lista completa no painel de detalhes.
  const assoc = resumoAssociacoes(contato, { max: 3 });
  const chips = assoc.unidades.map((u) => `<span class="cc-chip" title="${e(u.nome)}">${e(u.nome)}</span>`).join("");
  const mais = `${assoc.resto ? `<button type="button" class="cc-chip cc-chip--mais cc-chip--acao" data-cc-ver-associacoes aria-label="${e(`+${assoc.resto} · Ver todas as ${assoc.total} associações nos detalhes`)}" title="Ver todas nos detalhes"><span class="cc-mais-n">+${assoc.resto}</span><span class="cc-mais-todas">Ver todas</span></button>` : ""}`;
  const apto = envio?.podeEnviar !== false;
  const status = apto ? pill("ok", "Pode receber mensagens") : pill("atencao", "Envio indisponível", ` title="${e((envio?.bloqueios ?? []).map((b) => b.mensagem).join(" "))}"`);
  return `<header class="cc-chat-cab">
    <button type="button" class="cc-icone-btn cc-voltar" data-cc-voltar aria-label="Voltar para as conversas">${icon("arrow-left", { size: 18 })}</button>
    ${avatar({ contatoId: contato.contatoId, nome: contato.nome, iniciais: contato.iniciais, fotoUrl: contato.fotoUrl })}
    <div class="cc-chat-topo">
      <h2 class="cc-chat-nome">${e(contato.nome)}</h2>
      <div class="cc-chat-meta"><span class="cc-tel" title="Telefone (parcialmente oculto)">${e(contato.telefoneMascarado ?? "")}</span>${status}</div>
    </div>
    <p class="cc-chat-empresa${assoc.resto ? " tem-mais" : ""}"><span class="cc-chat-assoc" title="${e(assoc.rotulo)}">${e(assoc.rotulo)}</span>${chips ? `<span class="cc-chips cc-chips--cab">${chips}</span>` : ""}${mais}</p>
    <button type="button" class="cc-icone-btn cc-btn-detalhes${detalhesAberto ? " is-ativo" : ""}" data-cc-detalhes aria-label="Detalhes do responsável" aria-pressed="${detalhesAberto}">${icon("panel-right", { size: 18 })}</button>
  </header>`;
}

/** Uma bolha. A "voz" (equipe, automática, teste) vem da classe — sem etiqueta dentro da bolha. */
export function htmlMensagem(m) {
  const falhou = m.status === "FAILED" && m.direcao === "saida";
  const rodape = m.direcao === "saida"
    ? `<span class="cc-msg-rodape"><time datetime="${e(m.em)}">${e(horaLocal(m.em))}</time>${trilha(m.status, { texto: COM_TEXTO.has(m.status), rotulo: rotuloEntrega(m) })}</span>`
    : `<span class="cc-msg-rodape"><time datetime="${e(m.em)}">${e(horaLocal(m.em))}</time></span>`;
  const corpo = m.tipo === "midia" ? `<p class="cc-msg-texto cc-msg-texto--midia">${icon("paperclip", { size: 14 })} Mídia recebida. Ainda não é exibida aqui.</p>` : `<p class="cc-msg-texto">${e(m.texto ?? "")}</p>`;
  const reenviar = falhou && m.falhaLocal ? `<button type="button" class="cc-reenviar" data-cc-reenviar="${e(m.envioId ?? "")}">Tentar de novo</button>` : "";
  const erro = falhou && m.erro ? `<span class="cc-msg-erro">${e(m.erro)}</span>` : "";
  return `<div class="cc-msg cc-msg--${e(m.categoria)}${m.local ? " is-local" : ""}${falhou ? " is-falha" : ""}" data-cc-msg="${e(m.id)}">
    ${corpo}${rodape}${erro}${reenviar}
    <button type="button" class="cc-msg-mais" data-cc-menu="msg:${e(m.id)}" aria-label="Opções da mensagem" aria-haspopup="menu">${icon("more", { size: 14 })}</button>
  </div>`;
}

const ICONE_VOZ = { manual: "user", automatica: "bot", teste: "flask" };

function htmlGrupo(g) {
  const saida = g.direcao === "saida";
  const legenda = saida ? `<p class="cc-grupo-voz cc-grupo-voz--${e(g.categoria)}">${icon(ICONE_VOZ[g.categoria] ?? "bot", { size: 12 })}<span>${e(ROTULO_CATEGORIA[g.categoria] ?? "")}</span>${g.operador ? `<span class="cc-operador">${e(g.operador)}</span>` : ""}</p>` : "";
  return `<div class="cc-grupo cc-grupo--${saida ? "saida" : "entrada"}">${g.itens.map(htmlMensagem).join("")}${legenda}</div>`;
}

/** O fluxo de mensagens (sem cabeçalho nem composer, que preservam foco e rascunho). */
export function htmlFluxo({ mensagens, janelaHoras = 24, temMaisAntigas = false, agora = new Date() }) {
  if (!mensagens?.length) {
    return `<div class="cc-fluxo-vazio">${vazio({ titulo: `Nenhuma mensagem nas últimas ${janelaHoras} horas`, texto: "Escreva abaixo para começar. Só a atividade registrada pelo sistema aparece aqui.", icone: "message-circle" })}${temMaisAntigas ? `<button type="button" class="btn btn-ghost btn-sm" data-cc-acao="mais-antigas">Ver mensagens mais antigas</button>` : ""}</div>`;
  }
  const blocos = blocosDaConversa(mensagens, agora).map((b) => (b.tipo === "dia" ? `<div class="cc-dia" role="separator"><span>${e(b.rotulo)}</span></div>` : htmlGrupo(b))).join("");
  const topo = temMaisAntigas ? `<div class="cc-mais-antigas"><button type="button" class="btn btn-ghost btn-sm" data-cc-acao="mais-antigas">Ver mensagens mais antigas</button></div>` : `<p class="cc-janela">Mostrando as últimas ${janelaHoras} horas.</p>`;
  return `${topo}${blocos}`;
}

/** Composer. `texto`: rascunho preservado. `bloqueios`: motivos do servidor (o composer desabilita e explica). */
export function htmlComposer({ podeEnviar = true, bloqueios = [], texto = "", enviando = false, erro = "" }) {
  const n = caracteres(texto);
  // Bloqueio por causa da CONEXÃO (WhatsApp fora do ar ou conta ainda não confirmada): leva o operador direto para a aba certa. O histórico da conversa continua visível.
  const porConexao = bloqueios.some((b) => b.codigo === "GATEWAY_INDISPONIVEL" || b.codigo === "CONEXAO_NAO_CONFIRMADA");
  const aviso = !podeEnviar ? `<div class="cc-bloqueio" role="status">${icon("info", { size: 16 })}<div><strong>Não é possível enviar agora.</strong><ul>${bloqueios.map((b) => `<li>${e(b.mensagem)}</li>`).join("")}</ul>${porConexao ? `<button type="button" class="cc-link" data-cc-ir="conexao">Abrir Conexão</button>` : ""}</div></div>` : "";
  const contador = n > TEXTO_MAX * 0.8 ? `<span class="cc-contador-txt${n > TEXTO_MAX ? " is-excedeu" : ""}">${n}/${TEXTO_MAX}</span>` : "";
  return `<form class="cc-composer" data-cc-composer novalidate>
    ${aviso}${erro ? `<p class="cc-composer-erro" role="alert">${e(erro)}</p>` : ""}
    <div class="cc-composer-linha">
      <textarea class="cc-input" id="cc-texto" rows="1" placeholder="Digite uma mensagem..." aria-label="Mensagem" data-cc-texto ${podeEnviar ? "" : "disabled"}>${e(texto)}</textarea>
      <button type="submit" class="cc-enviar" aria-label="Enviar mensagem" data-cc-enviar ${podeEnviar && !enviando && texto.trim() && n <= TEXTO_MAX ? "" : "disabled"}>${icon("send", { size: 18 })}</button>
    </div>
    <p class="cc-composer-dica"><span>Enter envia. Shift + Enter quebra a linha.</span>${contador}</p>
  </form>`;
}

export function htmlChatVazio() {
  return `<div class="cc-chat-vazio">${vazio({ titulo: "Selecione uma conversa", texto: "Escolha um responsável na lista para ver a conversa e responder. Só os responsáveis cadastrados nas empresas aparecem aqui.", icone: "message-circle" })}</div>`;
}

// ---------------------------------------------------------------------------
// Contexto do responsável (coluna direita)
// ---------------------------------------------------------------------------

function blocoMensagemResumo(titulo, item, vazioTxt) {
  if (!item) return `<div class="cc-ctx-bloco"><h4>${e(titulo)}</h4><p class="cc-ctx-vazio">${e(vazioTxt)}</p></div>`;
  return `<div class="cc-ctx-bloco"><h4>${e(titulo)}</h4>
    <p class="cc-ctx-msg">${e(item.previa)}</p>
    <p class="cc-ctx-meta"><time>${e(dataHoraCurta(item.em))}</time>${item.status ? trilha(item.status) : ""}${item.operador ? `<span>${e(item.operador)}</span>` : ""}${item.direcao === "entrada" ? `<span>Recebida</span>` : ""}</p>
  </div>`;
}

export function htmlContexto(c) {
  const sit = situacaoDoContato(c);
  const porEmpresa = (c.empresas ?? []).map((emp) => {
    const un = (c.unidades ?? []).filter((u) => u.organizacaoId === emp.organizacaoId);
    return `<li class="cc-ctx-emp"><div class="cc-ctx-emp-linha"><strong>${e(emp.nome)}</strong>${emp.pendenciasAtuais ? `<span class="cc-tag cc-tag--atencao">${e(plural(emp.pendenciasAtuais, "pendência", "pendências"))}</span>` : ""}</div>
      ${un.length ? `<div class="cc-chips">${chipsUnidades(un, 6)}</div>` : ""}
      <button type="button" class="cc-link" data-cc-acao="ver-empresa" data-cc-org="${e(emp.organizacaoId)}">Ver empresa</button></li>`;
  }).join("");
  const pend = c.pendenciasAtuais ?? 0;
  return `<div class="cc-ctx">
    <div class="cc-ctx-topo">
      <button type="button" class="cc-icone-btn cc-fechar-ctx" data-cc-detalhes aria-label="Fechar detalhes">${icon("x", { size: 18 })}</button>
      ${avatar({ contatoId: c.contatoId, nome: c.nome, iniciais: c.iniciais, fotoUrl: c.fotoUrl, tamanho: "g" })}
      <h3 class="cc-ctx-nome">${e(c.nome)}</h3>
      ${c.cargo ? `<p class="cc-ctx-cargo">${e(c.cargo)}</p>` : ""}
      <p class="cc-tel">${e(c.telefoneMascarado ?? "")}</p>
    </div>
    <section class="cc-ctx-sec" data-cc-ctx-associacoes><h4 tabindex="-1">Empresas e unidades${(c.empresas?.length ?? 0) > 1 ? ` (${c.empresas.length})` : ""}</h4><ul class="cc-ctx-empresas">${porEmpresa || `<li class="cc-ctx-vazio">Sem empresa vinculada.</li>`}</ul></section>
    <section class="cc-ctx-sec"><h4>Situação do contato</h4><ul class="cc-ctx-situacao">${sit.map((s) => `<li class="${s.ok ? "is-ok" : "is-pend"}"><span>${e(s.rotulo)}</span><strong>${icon(s.ok ? "check-circle" : "minus-circle", { size: 14 })}${e(s.texto)}</strong></li>`).join("")}</ul></section>
    <section class="cc-ctx-sec"><h4>Pendências atuais</h4><p class="cc-ctx-pend ${pend ? "is-atencao" : ""}">${pend ? e(`${plural(pend, "unidade com pendência", "unidades com pendência")} nas empresas deste responsável.`) : "Nenhuma pendência agora."}</p></section>
    <section class="cc-ctx-sec">${blocoMensagemResumo("Última mensagem automática", c.ultimaAutomatica, "Nenhuma mensagem automática ainda.")}${blocoMensagemResumo("Última mensagem humana", c.ultimaHumana, "Nenhuma mensagem humana ainda.")}</section>
    <div class="cc-ctx-acoes">
      <button type="button" class="btn btn-ghost btn-sm" data-cc-acao="ver-pendencias">${icon("clipboard-list", { size: 14 })} Ver pendências</button>
      <button type="button" class="btn btn-ghost btn-sm" data-cc-acao="ver-historico">${icon("history", { size: 14 })} Ver histórico</button>
    </div>
  </div>`;
}

/** Menu contextual (popover). `itens`: [{id, rotulo, icone, desabilitado}]. */
export function htmlMenu(itens) {
  return `<ul class="cc-menu" role="menu">${itens.map((i) => `<li role="none"><button type="button" role="menuitem" class="cc-menu-item" data-cc-menu-acao="${e(i.id)}" ${i.desabilitado ? "disabled" : ""}>${icon(i.icone, { size: 14 })}<span>${e(i.rotulo)}</span></button></li>`).join("")}</ul>`;
}

// ---------------------------------------------------------------------------
// Automações
// ---------------------------------------------------------------------------

export function htmlAutomacoes(d, { ativacaoHtml = "", agora = new Date() } = {}) {
  const t = d.dashboardIfoodD1;
  const passos = t.linhaDoTempo.map((p) => `<li class="cc-passo cc-passo--${e(p.id)}">
      <time class="cc-passo-hora">${p.horario ? e(p.horario) : ""}</time><i class="cc-passo-no" aria-hidden="true"></i>
      <div class="cc-passo-corpo"><strong>${e(p.titulo)}</strong><p>${e(p.texto)}</p></div></li>`).join("");
  const fato = (rot, val) => `<div><dt>${e(rot)}</dt><dd>${e(val)}</dd></div>`;
  const empresas = d.empresasHabilitadas.itens.length
    ? htmlEmpresasUnidades(d.empresasHabilitadas.itens.map((o) => ({ organizacaoId: o.organizacaoId, nome: o.nome, pendencias: o.pendenciasAtuais ?? 0, unidades: o.unidades, situacao: o.pausada ? "pausado" : (o.pendenciasAtuais ?? 0) > 0 ? "atencao" : "ativo" })), { limite: 12 })
    : vazio({ titulo: "Nenhuma empresa habilitada", texto: "Habilite a comunicação de uma empresa em Configurações para que os avisos automáticos possam sair.", icone: "building" });
  const proximos = d.proximosEnvios.length
    ? `<ul class="cc-proximos">${d.proximosEnvios.map((p) => `<li><time>${e(dataHoraCurta(p.em, agora))}</time><span>${e(p.empresa ?? "Empresa")}</span><em>${e(ROTULO_ORIGEM[p.origem] ?? "Automática")}</em></li>`).join("")}</ul>`
    : vazio({ titulo: "Nenhum envio agendado", texto: "Nada está na fila agora.", icone: "clock" });
  const semWhatsapp = d.whatsapp && d.whatsapp.conectado === false
    ? `<div class="cc-bloqueio cc-bloqueio--destaque" role="status">${icon("alert-triangle", { size: 16 })}<div><strong>WhatsApp desconectado</strong><p>Nenhuma automação consegue enviar enquanto não houver uma sessão válida. As regras e o histórico continuam preservados.</p><button type="button" class="cc-link" data-cc-ir="conexao">Abrir Conexão</button></div></div>` : "";
  return `${semWhatsapp}<section class="cc-bloco cc-auto-cab">
      <div><h2>${e(t.titulo)}</h2><p class="cc-auto-resumo">${e(t.resumo)}</p></div>
      <div class="cc-auto-estado">${d.ativa ? badge("ativo", { texto: "Automação ativa" }) : badge("pausado", { texto: d.rotuloModo === "Somente reativa" ? "Somente reativa" : "Automação desativada" })}</div>
    </section>
    <div class="cc-grade cc-grade--auto">
      <section class="cc-bloco"><header class="cc-bloco-cab"><h2>Como funciona, passo a passo</h2></header><ol class="cc-linha-tempo">${passos}</ol></section>
      <div class="cc-coluna">
        <section class="cc-bloco"><header class="cc-bloco-cab"><h2>Regras aplicadas hoje</h2></header><dl class="cc-fatos">${fato("Quando detecta", t.quandoDetecta)}${fato("Quando envia", t.quandoEnvia)}${fato("Quando reforça", t.quandoReforca)}${fato("Horário limite", t.horarioLimite)}${fato("Empresas habilitadas", String(d.empresasHabilitadas.total))}</dl></section>
        <section class="cc-bloco"><header class="cc-bloco-cab"><h2>Empresas habilitadas</h2></header>${empresas}</section>
        <section class="cc-bloco"><header class="cc-bloco-cab"><h2>Próximos envios</h2></header>${proximos}</section>
      </div>
    </div>${ativacaoHtml ? `<section class="cc-bloco cc-bloco--ativacao">${ativacaoHtml}</section>` : ""}`;
}

// ---------------------------------------------------------------------------
// Histórico
// ---------------------------------------------------------------------------

const optionsDe = (lista, atual, rotuloTodos) => `<option value="">${e(rotuloTodos)}</option>${lista.map(([v, r]) => `<option value="${e(v)}" ${String(atual ?? "") === String(v) ? "selected" : ""}>${e(r)}</option>`).join("")}`;

/** `opcoes`: {empresas: [{organizacaoId, nome}], unidades: [{unidadeId, nome, organizacaoId}]} (vem dos destinatários). */
export function htmlFiltrosHistorico(f = {}, opcoes = {}) {
  const empresas = (opcoes.empresas ?? []).map((o) => [o.organizacaoId, o.nome]);
  const unidades = (opcoes.unidades ?? []).filter((u) => !f.organizacaoId || u.organizacaoId === f.organizacaoId).map((u) => [u.unidadeId, u.nome]);
  return `<form class="cc-filtros-hist" id="cc-hist-filtros" autocomplete="off">
    <label>Empresa<select name="organizacaoId">${optionsDe(empresas, f.organizacaoId, "Todas")}</select></label>
    <label>Unidade<select name="unidadeId">${optionsDe(unidades, f.unidadeId, "Todas")}</select></label>
    <label>Origem<select name="origem">${optionsDe(Object.entries(ROTULO_ORIGEM), f.origem, "Todas")}</select></label>
    <label>Situação<select name="status">${optionsDe(Object.entries(ROTULO_STATUS), f.status, "Todas")}</select></label>
    <label>De<input type="date" name="desde" value="${e(f.desde ?? "")}" /></label>
    <label>Até<input type="date" name="ate" value="${e(f.ate ?? "")}" /></label>
    <label>Operador<input type="search" name="operador" value="${e(f.operador ?? "")}" placeholder="Nome de quem enviou" /></label>
    <label class="cc-filtro-largo">Responsável, empresa ou unidade<input type="search" name="busca" value="${e(f.busca ?? "")}" placeholder="Buscar pelo nome" /></label>
    <span class="cc-filtros-acoes"><button type="submit" class="btn btn-primary btn-sm">Filtrar</button><button type="button" class="btn btn-ghost btn-sm" data-cc-acao="limpar-filtros">Limpar</button></span>
  </form>`;
}

function linhaHistorico(m, agora) {
  const saida = m.direcao === "saida";
  const detalhe = saida ? `<button type="button" class="cc-link" data-cc-acao="detalhe-mensagem" data-cc-id="${e(m.id)}">Detalhes</button>` : "";
  return `<tr>
    <td class="cc-td-data"><time datetime="${e(m.em)}">${e(dataHoraCurta(m.em, agora))}</time></td>
    <td><strong>${e(m.responsavel)}</strong></td>
    <td>${e((m.empresas ?? []).join(", "))}</td>
    <td>${e((m.unidades ?? []).join(", "))}</td>
    <td><span class="cc-origem cc-origem--${e(m.categoria)}">${icon(m.categoria === "manual" ? "user" : m.categoria === "teste" ? "flask" : m.categoria === "recebida" ? "message-circle" : "bot", { size: 13 })}${e(ROTULO_ORIGEM[m.origem] ?? m.origem)}</span></td>
    <td class="cc-td-previa">${e(m.previa)}</td>
    <td>${saida ? trilha(m.status, { texto: true }) : `<span class="cc-nota">Recebida</span>`}</td>
    <td>${m.entregueEm ? `<time>${e(dataHoraCurta(m.entregueEm, agora))}</time>` : `<span class="cc-nota">—</span>`}</td>
    <td>${m.lidoEm ? `<time>${e(dataHoraCurta(m.lidoEm, agora))}</time>` : `<span class="cc-nota">—</span>`}</td>
    <td>${m.operador ? e(m.operador) : `<span class="cc-nota">—</span>`}</td>
    <td class="cc-td-acoes"><button type="button" class="cc-link" data-cc-acao="abrir-conversa" data-cc-id="${e(m.contatoId)}">Abrir conversa</button>${detalhe}</td>
  </tr>`;
}

export function htmlPaginacao(pacote, prefixo) {
  if (!pacote || pacote.total <= pacote.porPagina) return "";
  const total = Math.ceil(pacote.total / pacote.porPagina);
  return `<div class="cc-paginacao"><button type="button" class="btn btn-ghost btn-sm" data-cc-pag="${prefixo}:anterior" ${pacote.pagina <= 1 ? "disabled" : ""}>Anterior</button><span>Página ${pacote.pagina} de ${total}, ${pacote.total} no total</span><button type="button" class="btn btn-ghost btn-sm" data-cc-pag="${prefixo}:proximo" ${pacote.pagina >= total ? "disabled" : ""}>Próxima</button></div>`;
}

export function htmlHistorico(pacote, filtros, opcoes, { agora = new Date() } = {}) {
  const cab = htmlFiltrosHistorico(filtros, opcoes);
  if (!pacote) return `${cab}${skeletonTabela()}`;
  if (!pacote.itens.length) return `${cab}${vazio({ titulo: "Nenhuma mensagem encontrada", texto: "Ajuste os filtros ou o período. O histórico traz as mensagens de responsáveis cadastrados, recebidas e enviadas.", icone: "history" })}`;
  return `${cab}<div class="cc-tabela-wrap"><table class="cc-tabela"><thead><tr>
      <th>Data e hora</th><th>Responsável</th><th>Empresa</th><th>Unidade</th><th>Origem</th><th>Mensagem</th><th>Situação</th><th>Entrega</th><th>Leitura</th><th>Operador</th><th><span class="cc-sr">Ações</span></th>
    </tr></thead><tbody>${pacote.itens.map((m) => linhaHistorico(m, agora)).join("")}</tbody></table></div>${htmlPaginacao(pacote, "historico")}`;
}

// ---------------------------------------------------------------------------
// Destinatários
// ---------------------------------------------------------------------------

const marcaSimNao = (ok, sim, nao, tomNao = "neutro") => `<span class="cc-tag cc-tag--${ok ? "ok" : tomNao}">${e(ok ? sim : nao)}</span>`;

export function htmlDestinatarios(d, { busca = "", agora = new Date() } = {}) {
  const cab = `<div class="cc-barra"><label class="cc-busca cc-busca--larga">${icon("search", { size: 15 })}<input type="search" id="cc-dest-busca" placeholder="Buscar por nome, empresa ou unidade" value="${e(busca)}" autocomplete="off" aria-label="Buscar responsável" /></label><span class="cc-nota">${d ? plural(d.total, "responsável", "responsáveis") : ""}</span></div>`;
  if (!d) return `${cab}${skeletonTabela()}`;
  if (!d.itens.length) return `${cab}${vazio({ titulo: busca ? "Nenhum responsável encontrado" : "Nenhum responsável cadastrado", texto: busca ? "Confira o nome. O telefone não é pesquisável." : "Os responsáveis vêm do cadastro de empresas e unidades. Vincule um contato de WhatsApp a um perfil para ele aparecer aqui.", icone: "users" })}`;
  const linhas = d.itens.map((x) => `<tr>
    <td><div class="cc-pessoa">${avatar({ contatoId: x.contatoId, nome: x.nome, iniciais: x.iniciais, fotoUrl: x.fotoUrl, tamanho: "s" })}<div><strong>${e(x.nome)}</strong>${x.cargo ? `<span class="cc-nota">${e(x.cargo)}</span>` : ""}</div></div></td>
    <td>${x.empresas.map((o) => e(o.nome)).join(", ")}</td>
    <td><div class="cc-chips">${chipsUnidades(x.unidades, 3)}</div></td>
    <td><span class="cc-tel">${e(x.telefoneMascarado ?? "")}</span></td>
    <td>${marcaSimNao(x.consentimento, "Confirmado", "Pendente", "atencao")}</td>
    <td>${marcaSimNao(x.verificado, "Verificado", "Não verificado", "atencao")}</td>
    <td>${x.optOut ? `<span class="cc-tag cc-tag--critico">Pediu para parar</span>` : marcaSimNao(x.whatsappConfirmado, "Registrada", "Ainda não registrada")}</td>
    <td>${marcaSimNao(x.comunicacaoHabilitada, "Habilitada", "Desabilitada")}</td>
    <td>${x.ultimaInteracaoEm ? `<time>${e(dataHoraCurta(x.ultimaInteracaoEm, agora))}</time>` : `<span class="cc-nota">Sem interação</span>`}</td>
    <td class="cc-td-acoes"><button type="button" class="btn btn-ghost btn-sm" data-cc-acao="abrir-conversa" data-cc-id="${e(x.contatoId)}">${icon("message-circle", { size: 14 })} Abrir conversa</button></td>
  </tr>`).join("");
  return `${cab}<div class="cc-tabela-wrap"><table class="cc-tabela cc-tabela--dest"><thead><tr>
      <th>Responsável</th><th>Empresa</th><th>Unidade</th><th>Contato</th><th>Consentimento</th><th>Verificado</th><th>Interação</th><th>Comunicação</th><th>Última interação</th><th><span class="cc-sr">Ações</span></th>
    </tr></thead><tbody>${linhas}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------

const fmtJanela = (j) => (j && typeof j === "object" ? Object.entries(j).map(([k, v]) => `${{ seg_sex: "Segunda a sexta", sab: "Sábado", dom: "Domingo" }[k] ?? k}: ${v ? `${v.inicio} às ${v.fim}` : "sem envio"}`).join("; ") : "Não informado");
const fmtMapa = (m, un) => (m && typeof m === "object" ? Object.entries(m).map(([k, v]) => `${k}: ${v}${un}`).join("; ") : "Não informado");

export function htmlConfigFuncional(c) {
  if (!c) return skeletonTabela();
  const linha = (rot, val, nota = "") => `<div class="cc-cfg-linha"><dt>${e(rot)}</dt><dd>${e(val)}${nota ? `<span class="cc-nota">${e(nota)}</span>` : ""}</dd></div>`;
  return `<dl class="cc-cfg">
    ${linha("Horários de envio", fmtJanela(c.janelaComercial))}
    ${c.disponibilidadeIfood ? linha("Lembretes do D-1 do iFood", `A partir das ${c.disponibilidadeIfood.enviosPermitidosApos}`, `Os dados do iFood ficam disponíveis a partir das ${c.disponibilidadeIfood.dadosDisponiveisApos}; antes disso a empresa não é cobrada pelo dia anterior. Vale dentro dos horários de envio acima.`) : ""}
    ${linha("Reforço do prazo final", `Entre ${c.reforcoD1?.janela ?? "—"}, limite às ${c.reforcoD1?.cutoff ?? "—"}`, `${c.reforcoD1?.diasUteis ?? ""}. Mínimo de ${Number(c.reforcoD1?.espacamentoMinimoHoras ?? 0)} h depois do primeiro aviso.`)}
    ${linha("Tipos de alerta", (c.tiposDeAlerta ?? []).join(", ") || "Não informado", "Definido por empresa.")}
    ${linha("Intervalo entre avisos", fmtMapa(c.cooldownsHoras, " h"))}
    ${linha("Limites de envio", fmtMapa(c.limites, ""))}
    ${linha("Validade da mensagem", `${Number(c.validadeDaMensagemHoras ?? 0)} h`)}
    ${linha("Espalhamento máximo", `${Number(c.espalhamentoMaximoMinutos ?? 0)} min`)}
  </dl>${c.observacao ? `<p class="cc-nota">${e(c.observacao)}</p>` : ""}`;
}

const ROTULO_GATEWAY = { conectado: "Conectado", desconectado: "Desconectado", instavel: "Instável", desconhecido: "Sem sinal" };

/** Diagnóstico técnico — só rótulos, estados e horários. Nunca segredo, HMAC, token, auth-state nem telefone. */
export function htmlDiagnostico(r, erros = []) {
  if (!r) return skeletonTabela();
  const w = r.worker ?? {}; const gw = r.gateway ?? {};
  const linha = (rot, val, nota = "") => `<div class="cc-cfg-linha"><dt>${e(rot)}</dt><dd>${val}${nota ? `<span class="cc-nota">${e(nota)}</span>` : ""}</dd></div>`;
  const ciclo = w.resultadoUltimoCiclo === "skipped" ? "Ciclo ignorado, automação desativada" : w.resultadoUltimoCiclo === "completed" ? "Ciclo concluído" : w.resultadoUltimoCiclo === "failed" ? "Ciclo com falha" : "Sem ciclo registrado nesta instância";
  const workerRot = w.estado === "desabilitado" ? "Desativado" : w.resultadoUltimoCiclo === "failed" ? "Atenção" : (w.rodandoNestaInstancia && w.ultimoCicloEm) ? "Saudável" : "Atenção";
  const ign = r.inbox?.ignorados ?? {};
  const totalIgn = Object.values(ign).reduce((s, n) => s + n, 0);
  const listaErros = erros.length ? `<ul class="cc-lista-simples">${erros.map((x) => `<li><div><strong>${e(x.status === "DELIVERY_UNKNOWN" ? "Entrega não confirmada" : "Falhou")}</strong><span class="cc-nota">${e(x.erro ?? "Sem detalhe")}</span></div><time class="cc-nota">${e(dataHoraCurta(x.em))}</time></li>`).join("")}</ul>` : `<span class="cc-nota">Nenhum erro recente.</span>`;
  return `<dl class="cc-cfg">
    ${linha("Conexão com o WhatsApp", e(ROTULO_GATEWAY[gw.estado] ?? "Sem sinal"), gw.ultimoContatoEm ? `Último sinal: ${dataHoraCurta(gw.ultimoContatoEm)}` : "Sem sinal registrado")}
    ${linha("Sessão do gateway", e(gw.leaseValida === true ? "Válida" : gw.leaseValida === false ? "Expirada" : "Desconhecida"))}
    ${linha("Processamento em segundo plano", e(workerRot), w.ultimoCicloEm ? `Último ciclo: ${dataHoraCurta(w.ultimoCicloEm)}. ${ciclo}` : ciclo)}
    ${linha("Recuperação de fila offline", "Desativada", "Política do projeto. Não é lida do servidor do WhatsApp.")}
    ${linha("Confirmações de entrega", e(r.entrega?.estado === "operacional" ? "Operacional" : "Atenção"), r.entrega?.motivo ?? "Confirmações de entrega e leitura são registradas.")}
    ${linha("Versão do backend", e(r.backend?.versao ? r.backend.versao : "Não informada"))}
    ${linha("Mensagens ignoradas (privacidade)", e(String(totalIgn)), `Contatos fora do cadastro, grupos e status. Só contagem, sem conteúdo nem telefone. Texto recebido guardado por ${r.inbox?.retencaoDias ?? 30} dias.`)}
    ${linha("Últimos erros", listaErros)}
  </dl>`;
}

export function htmlConfiguracoes({ config, diagnostico, erros, testeHtml = "", ativacaoHtml = "", empresasHabilitadas = [] }) {
  const empresas = empresasHabilitadas.length
    ? `<ul class="cc-lista-simples">${empresasHabilitadas.map((o) => `<li><div><strong>${e(o.nome)}</strong><span class="cc-nota">${e(o.proximaAcao ?? "")}</span></div><button type="button" class="cc-link" data-cc-acao="configurar-empresa" data-cc-org="${e(o.organizacaoId)}">Configurar</button></li>`).join("")}</ul>`
    : `<p class="cc-nota">Nenhuma empresa habilitada. A habilitação de cada empresa é feita na configuração dela.</p>`;
  return `<div class="cc-config">
    <section class="cc-bloco"><header class="cc-bloco-cab"><h2>Configuração funcional</h2></header>${htmlConfigFuncional(config)}
      <h3 class="cc-sub-h">Empresas habilitadas</h3>${empresas}</section>
    ${ativacaoHtml ? `<section class="cc-bloco cc-bloco--ativacao">${ativacaoHtml}</section>` : ""}
    ${testeHtml ? `<section class="cc-bloco">${testeHtml}</section>` : ""}
    <details class="cc-bloco cc-tecnico" data-cc-tecnico><summary><span>Diagnóstico técnico</span><em>Para quem precisa investigar um problema. Fica recolhido por padrão.</em></summary>${diagnostico === undefined ? "" : htmlDiagnostico(diagnostico, erros)}</details>
  </div>`;
}

/** Corpo completo por aba (usado quando a aba não é Conversas, que tem painéis próprios). */
export function htmlCasca({ aba, estado, naoLidas, corpo }) {
  return `<section class="cc" data-cc-raiz data-cc-aba-ativa="${e(aba)}">${htmlTopo({ aba, estado, naoLidas })}<div class="cc-corpo" data-cc-corpo role="tabpanel" aria-labelledby="cc-aba-${e(aba)}">${corpo}</div></section>`;
}

/** Esqueleto do espaço de conversas (3 regiões pintadas separadamente pelo controlador para preservar foco e rascunho). */
export function htmlEspacoConversas({ tela = "lista", detalhes = false } = {}) {
  return `<div class="cc-espaco" data-cc-espaco data-cc-tela="${e(tela)}" data-cc-detalhes-aberto="${detalhes}">
    <aside class="cc-lista" data-cc-lista aria-label="Lista de conversas"></aside>
    <section class="cc-chat" data-cc-chat aria-label="Conversa"><div data-cc-chat-cab></div><div class="cc-fluxo" data-cc-fluxo role="log" aria-live="polite" aria-label="Mensagens da conversa" tabindex="0"></div><div data-cc-composer-area></div></section>
    <aside class="cc-contexto" data-cc-contexto aria-label="Detalhes do responsável"></aside>
    <div class="cc-veu" data-cc-veu hidden></div>
  </div>`;
}
