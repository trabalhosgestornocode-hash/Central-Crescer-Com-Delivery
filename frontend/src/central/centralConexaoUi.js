// CENTRAL DE COMUNICAÇÃO — aba CONEXÃO: construtores PUROS (dados → HTML). Uma área oficial de gestão da identidade WhatsApp do Crescer com Delivery, não uma tela de desenvolvedor:
// o estado da conta vem primeiro; o técnico fica recolhido. Sem emoji, sem handler inline (CSP): tudo é `data-cc-*` com delegação no controlador.
//
// SEGURANÇA DE TELA: o QR chega só como imagem SVG e é exibido em <img> (data URL: SVG em <img> não executa script). O telefone é sempre mascarado. Nenhuma credencial existe aqui.

import { escapeHtml as e } from "../utils.js";
import { icon } from "../icons.js";
import { avatar, skeletonPainel } from "./centralUi.js";
import { ROTULO_ESTADO_CONEXAO, TOM_ESTADO_CONEXAO, passosDoAssistente, progressoQr, dataHoraCurta, FASES_EM_ANDAMENTO } from "./centralModelo.js";

const pill = (tom, texto) => `<span class="cc-pill cc-pill--${tom}"><i class="cc-dot"></i>${e(texto)}</span>`;
const linha = (rot, val, nota = "") => `<div class="cc-cfg-linha"><dt>${e(rot)}</dt><dd>${val}${nota ? `<span class="cc-nota">${e(nota)}</span>` : ""}</dd></div>`;
const vazioTxt = (t) => `<span class="cc-nota">${e(t)}</span>`;

/** Ilustração da conta desconectada: aparelho com sinal e cantos de leitura (SVG próprio, sem emoji). */
export function ilustracaoDesconectado() {
  return `<svg class="cc-ilus" viewBox="0 0 160 160" width="160" height="160" fill="none" role="img" aria-label="Nenhum WhatsApp conectado">
    <rect x="46" y="18" width="68" height="124" rx="14" class="cc-ilus-corpo"/>
    <rect x="54" y="32" width="52" height="86" rx="6" class="cc-ilus-tela"/>
    <path d="M70 126h20" class="cc-ilus-traco"/>
    <path d="M62 44h10v10M98 44H88v10M62 106h10V96M98 106H88V96" class="cc-ilus-cantos"/>
    <path d="M70 75a14 14 0 0 1 20 0M74.5 80.5a8 8 0 0 1 11 0" class="cc-ilus-sinal"/>
    <circle cx="80" cy="87" r="1.9" class="cc-ilus-ponto"/>
    <path d="M22 60c-9 7-9 27 0 34M138 60c9 7 9 27 0 34" class="cc-ilus-onda"/>
  </svg>`;
}

const ICONE_ESTADO = { CONNECTING: "refresh", WAITING_QR: "smartphone", RECONNECTING: "refresh", AUTH_ERROR: "alert-triangle" };

function textoDoEstado(c) {
  switch (c.estado) {
    case "CONNECTED": return { titulo: c.conta?.nome ?? "WhatsApp conectado", texto: "Esta é a conta que envia e recebe as mensagens do Crescer com Delivery." };
    case "CONNECTING": return { titulo: "Conectando ao WhatsApp", texto: "Estamos abrindo a sessão. Isso costuma levar alguns segundos." };
    case "WAITING_QR": return { titulo: "Aguardando a leitura do QR Code", texto: c.permissoes?.gerenciar && c.operacao ? "Uma conexão foi iniciada e está esperando o QR Code ser lido no celular." : "Uma pessoa da equipe está conectando o WhatsApp agora." };
    case "RECONNECTING": return { titulo: "Reconectando ao WhatsApp", texto: `A conexão caiu e está sendo restabelecida sozinha. Nenhuma ação é necessária${c.tecnico?.tentativasReconexao ? ` (tentativa ${c.tecnico.tentativasReconexao})` : ""}.` };
    case "AUTH_ERROR": return { titulo: "Sessão inválida", texto: "O WhatsApp encerrou a sessão deste número. Conecte novamente para voltar a enviar e receber mensagens." };
    default: return { titulo: "Nenhum WhatsApp conectado", texto: "Conecte um número para enviar os avisos automáticos e conversar com os responsáveis pelo painel. O histórico existente continua preservado." };
  }
}

function acoesDoEstado(c) {
  if (!c.permissoes?.gerenciar) return `<p class="cc-nota cc-id-aviso">${icon("lock", { size: 13 })} Você pode acompanhar o estado da conexão. Conectar, trocar ou desconectar exige a permissão de gerenciar a conexão.</p>`;
  const b = (acao, rotulo, cls, ic) => `<button type="button" class="btn ${cls} btn-sm" data-cc-conexao="${acao}">${ic ? icon(ic, { size: 14 }) : ""} ${e(rotulo)}</button>`;
  if (c.estado === "CONNECTED") {
    const revisar = c.identidade?.status === "PENDENTE_CONFIRMACAO" ? b("revisar", "Revisar e confirmar conta", "btn-primary", "check-circle") : "";
    return `${revisar}${b("trocar", "Trocar número conectado", "btn-ghost", "refresh")}${b("desconectar", "Desconectar WhatsApp", "btn-ghost cc-btn-perigo", "ban")}`;
  }
  if (c.estado === "WAITING_QR" && c.operacao) return `${b("retomar", "Continuar conexão", "btn-primary", "smartphone")}${b("cancelar-operacao", "Cancelar conexão", "btn-ghost", "x")}`;
  if (c.estado === "CONNECTING" || c.estado === "RECONNECTING" || c.estado === "WAITING_QR") return c.operacao ? b("cancelar-operacao", "Cancelar conexão", "btn-ghost", "x") : "";
  return b("conectar", "Conectar WhatsApp", "btn-primary", "smartphone");
}

/** Cartão principal: um único bloco forte, o estado da identidade do WhatsApp. */
export function htmlCartaoConexao(c) {
  const t = textoDoEstado(c);
  const tom = TOM_ESTADO_CONEXAO[c.estado] ?? "neutro";
  const visual = c.estado === "CONNECTED"
    ? `<div class="cc-id-avatar">${avatar({ contatoId: c.conta?.telefoneMascarado ?? "wa", nome: c.conta?.nome ?? "WhatsApp", iniciais: c.conta?.iniciais ?? "WA", fotoUrl: c.conta?.fotoUrl, tamanho: "x" })}<i class="cc-id-anel" aria-hidden="true"></i></div>`
    : c.estado === "DISCONNECTED" ? ilustracaoDesconectado()
      : `<div class="cc-id-estado-ic cc-id-estado-ic--${tom}">${icon(ICONE_ESTADO[c.estado] ?? "smartphone", { size: 40 })}</div>`;
  const chips = c.estado === "CONNECTED" ? `<div class="cc-id-chips">
      ${c.conta?.telefoneMascarado ? `<span class="cc-tel">${e(c.conta.telefoneMascarado)}</span>` : ""}
      <span class="cc-tag">${e(c.conta?.tipoContaRotulo ?? "")}</span>
      <span class="cc-tag ${c.identidade.ambiente === "PRODUCAO" ? "cc-tag--ok" : "cc-tag--neutro"}">${e(c.identidade.ambienteRotulo)}</span>
      ${c.identidade.agenteCrescer ? `<span class="cc-tag cc-tag--marca">Agente Crescer</span>` : ""}
    </div>` : "";
  return `<section class="cc-id-card cc-id-card--${tom}" data-cc-estado-conexao="${e(c.estado)}">
    <div class="cc-id-visual">${visual}</div>
    <div class="cc-id-corpo">
      <p class="cc-id-estado">${pill(tom, ROTULO_ESTADO_CONEXAO[c.estado] ?? c.rotulo ?? "")}${c.semSinal ? `<span class="cc-nota">Sem resposta do Gateway. Mostrando o último estado conhecido.</span>` : ""}</p>
      <h2 class="cc-id-titulo">${e(t.titulo)}</h2>
      <p class="cc-id-texto">${e(t.texto)}</p>${chips}
      <div class="cc-id-acoes">${acoesDoEstado(c)}</div>
    </div>
  </section>`;
}

function aviso(c) {
  if (c.estado !== "CONNECTED" || c.identidade?.status !== "PENDENTE_CONFIRMACAO") return "";
  return `<div class="cc-bloqueio cc-bloqueio--destaque" role="status">${icon("info", { size: 16 })}<div><strong>Esta conta ainda não foi confirmada.</strong><p>Enquanto isso, o envio de mensagens pelo painel fica bloqueado. Confirme que este é o número que o Crescer com Delivery deve usar.</p></div></div>`;
}

/** Bloco "Conta conectada": o que o WhatsApp informa e a saúde da sessão. Só o que existe; nada inventado. */
export function htmlContaConectada(c, { agora = new Date() } = {}) {
  if (c.estado !== "CONNECTED" || !c.conta) return "";
  const s = c.saude ?? {};
  const tomSaude = s.id === "saudavel" ? "ok" : s.id === "atencao" ? "atencao" : "neutro";
  return `<section class="cc-bloco"><header class="cc-bloco-cab"><h2>Conta conectada</h2></header><dl class="cc-cfg">
    ${linha("Nome do perfil", c.conta.nome ? e(c.conta.nome) : vazioTxt("O WhatsApp não informou"))}
    ${linha("Número", `<span class="cc-tel">${e(c.conta.telefoneMascarado ?? "")}</span>`)}
    ${linha("Tipo da conta", e(c.conta.tipoContaRotulo))}
    ${c.conta.descricao ? linha("Recado", e(c.conta.descricao)) : ""}
    ${linha("Conectado desde", c.saude?.conectadoEm ? e(dataHoraCurta(c.saude.conectadoEm, agora)) : vazioTxt("Sem registro"))}
    ${linha("Último sinal", s.ultimoSinalEm ? e(dataHoraCurta(s.ultimoSinalEm, agora)) : vazioTxt("Sem registro"))}
    ${linha("Saúde da sessão", pill(tomSaude, s.rotulo ?? "Sem sinal"))}
    ${linha("Gateway", e(c.tecnico?.gateway ?? "Sem resposta"))}
  </dl></section>`;
}

/** Bloco "Identidade no Crescer": nome operacional e ambiente, SEPARADOS do número. */
export function htmlIdentidade(c) {
  const conf = c.identidade?.status === "CONFIRMADA";
  const pode = c.permissoes?.gerenciar === true;
  const nome = c.identidade?.nomeOperacional;
  const alternar = conf && pode
    ? `<button type="button" class="cc-alternar${c.identidade.agenteCrescer ? " is-ligado" : ""}" role="switch" aria-checked="${c.identidade.agenteCrescer}" data-cc-conexao="agente" aria-label="Utilizar como Agente Crescer"><i></i></button>` : "";
  const ambiente = pode
    ? `<div class="cc-seg" role="radiogroup" aria-label="Ambiente">${[["TESTE", "Teste"], ["PRODUCAO", "Produção"]].map(([v, r]) => `<button type="button" role="radio" aria-checked="${c.identidade.ambiente === v}" class="cc-seg-op${c.identidade.ambiente === v ? " is-ativo" : ""}" data-cc-conexao="ambiente" data-cc-valor="${v}">${r}</button>`).join("")}</div>`
    : e(c.identidade?.ambienteRotulo ?? "");
  return `<section class="cc-bloco"><header class="cc-bloco-cab"><h2>Identidade no Crescer com Delivery</h2></header><dl class="cc-cfg">
    ${linha("Nome operacional", `<span class="cc-linha-ctl"><strong>${nome ? e(nome) : "Sem nome operacional"}</strong>${alternar}</span>`,
      conf ? "Ligue “Utilizar como Agente Crescer” quando este for o número oficial." : "Disponível depois que a conta for confirmada.")}
    ${linha("Ambiente", ambiente, "Só descreve o uso deste número. Não altera nenhuma regra de envio.")}
  </dl><p class="cc-nota cc-id-rodape">O nome operacional pertence à conta confirmada. Se o número mudar, ele precisa ser definido de novo.</p></section>`;
}

const ROT_SOCKET = { Aberto: "Aberto", Fechado: "Fechado", Desconhecido: "Desconhecido" };

/** Detalhes técnicos: recolhido por padrão. Só rótulos, estados e horários. */
export function htmlDetalhesTecnicos(c, { agora = new Date() } = {}) {
  const t = c.tecnico ?? {};
  const h = (iso) => (iso ? e(dataHoraCurta(iso, agora)) : vazioTxt("Sem registro"));
  return `<details class="cc-bloco cc-tecnico" data-cc-tecnico-conexao><summary><span>Detalhes técnicos</span><em>Para quem precisa investigar um problema. Fica recolhido por padrão.</em></summary><dl class="cc-cfg">
    ${linha("Gateway", e(t.gateway ?? "Sem resposta"))}
    ${linha("Heartbeat", h(t.heartbeatEm), "Último sinal de vida enviado pelo Gateway.")}
    ${linha("Sessão do Gateway", e(t.sessaoValida === true ? "Válida" : t.sessaoValida === false ? "Expirada" : "Desconhecida"))}
    ${linha("Socket", e(ROT_SOCKET[t.socket] ?? "Desconhecido"))}
    ${linha("Última conexão", h(t.ultimaConexaoEm))}
    ${linha("Última desconexão", h(t.ultimaDesconexaoEm))}
    ${linha("Motivo da última desconexão", t.motivoUltimaDesconexao ? e(t.motivoUltimaDesconexao) : vazioTxt("Sem registro"))}
    ${linha("Tentativas de reconexão", e(String(t.tentativasReconexao ?? 0)))}
    ${linha("Versão do Gateway", t.versao ? e(t.versao) : vazioTxt("Não informada"))}
  </dl></details>`;
}

/** Corpo completo da aba. `c` null ⇒ skeleton do perfil. */
export function htmlConexao(c, { agora = new Date() } = {}) {
  if (!c) return `<div class="cc-conexao">${skeletonPainel()}</div>`;
  return `<div class="cc-conexao">
    ${htmlCartaoConexao(c)}${aviso(c)}
    ${c.estado === "CONNECTED" ? `<div class="cc-conexao-grade">${htmlContaConectada(c, { agora })}${htmlIdentidade(c)}</div>` : ""}
    ${htmlDetalhesTecnicos(c, { agora })}
  </div>`;
}

// ---------------------------------------------------------------------------
// Assistente de conexão (modal)
// ---------------------------------------------------------------------------

const TITULO_MODO = { conectar: "Conectar WhatsApp", trocar: "Trocar número conectado", revisar: "Confirmar conta do WhatsApp", retomar: "Continuar conexão" };

function stepper(w) {
  const ps = passosDoAssistente(w.fase, { falhouEm: w.falhouEm });
  return `<ol class="cc-stepper" aria-label="Etapas da conexão">${ps.map((p, i) => `<li class="cc-step cc-step--${p.estado}"${p.estado === "ativo" ? ' aria-current="step"' : ""}>
      <span class="cc-step-no">${p.estado === "feito" ? icon("check-circle", { size: 16 }) : p.estado === "erro" ? icon("alert-triangle", { size: 16 }) : `<b>${i + 1}</b>`}</span><span class="cc-step-rot">${e(p.rotulo)}</span></li>`).join("")}</ol>`;
}

/** Quadro do QR: a imagem (SVG em data URL) + anel de expiração. Some (src vazio) quando não há QR. */
export function htmlQuadroQr(w, agora = Date.now()) {
  const r = w.resp ?? {};
  const { restante, fracao } = progressoQr(r.expiraEm, r.ordem, agora);
  const expirado = w.fase === "expirado";
  const img = r.svg && !expirado
    ? `<img class="cc-qr-img" src="data:image/svg+xml;utf8,${encodeURIComponent(r.svg)}" alt="QR Code de conexão do WhatsApp" width="264" height="264" draggable="false" />`
    : `<div class="cc-qr-vazio">${expirado ? icon("clock", { size: 30 }) : `<i class="cc-skel cc-skel--qr"></i>`}</div>`;
  const anel = !expirado && r.expiraEm ? `<svg class="cc-qr-anel" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="16" class="cc-anel-fundo"/><circle cx="18" cy="18" r="16" class="cc-anel-prog${restante <= 8 ? " is-fim" : ""}" style="stroke-dasharray:${(fracao * 100.5).toFixed(1)} 100.5"/></svg>` : "";
  return `<div class="cc-qr${expirado ? " is-expirado" : ""}" data-cc-qr>
    <div class="cc-qr-moldura">${img}<i class="cc-qr-canto cc-qr-canto--a"></i><i class="cc-qr-canto cc-qr-canto--b"></i><i class="cc-qr-canto cc-qr-canto--c"></i><i class="cc-qr-canto cc-qr-canto--d"></i>
      ${expirado ? `<div class="cc-qr-sobre"><strong>QR Code expirado</strong><button type="button" class="btn btn-primary btn-sm" data-cc-conexao="novo-qr">${icon("refresh", { size: 14 })} Gerar novo QR Code</button></div>` : ""}</div>
    <div class="cc-qr-tempo" data-cc-qr-tempo>${anel}<span>${expirado ? "Expirou" : r.expiraEm ? `Expira em <b>${restante} s</b>` : "Gerando…"}</span></div>
  </div>`;
}

const ETAPAS_LEITURA = ["Abra o WhatsApp no celular.", "Toque em Aparelhos conectados.", "Toque em Conectar um aparelho.", "Aponte a câmera para este QR Code."];

function corpoDaFase(w, agora) {
  switch (w.fase) {
    case "iniciando": return `<div class="cc-fase cc-fase--carregando"><i class="cc-spinner" aria-hidden="true"></i><strong>Preparando a sessão</strong><p>Abrindo uma conexão segura com o WhatsApp.</p></div>`;
    case "gerando": return `<div class="cc-fase cc-fase--carregando">${htmlQuadroQr({ ...w, resp: {} }, agora)}<strong>Gerando o QR Code</strong><p>Só um instante.</p></div>`;
    case "aguardando": case "expirado": return `<div class="cc-fase cc-fase--qr">${htmlQuadroQr(w, agora)}
        <div class="cc-fase-texto"><strong>${w.fase === "expirado" ? "Este QR Code expirou" : "Escaneie com o celular"}</strong>
          <ol class="cc-leitura">${ETAPAS_LEITURA.map((t) => `<li>${e(t)}</li>`).join("")}</ol>
          ${w.svgIndisponivel ? `<p class="cc-composer-erro" role="alert">O Gateway não enviou a imagem do QR Code. Atualize o Gateway e tente de novo.</p>` : ""}
          <p class="cc-nota">Use o número que o Crescer com Delivery vai utilizar. Nada é enviado durante a conexão.</p></div></div>`;
    case "validando": return `<div class="cc-fase cc-fase--carregando"><span class="cc-check-anim" aria-hidden="true">${icon("check-circle", { size: 44 })}</span><strong>Validando a conta</strong><p>Conferindo a sessão que acabou de ser criada.</p></div>`;
    case "perfil": return `<div class="cc-fase cc-fase--carregando"><div class="cc-perfil-skel" aria-hidden="true"><i class="cc-skel cc-skel--av-g"></i><i class="cc-skel cc-skel--l1"></i><i class="cc-skel cc-skel--l2"></i></div><strong>Obtendo o perfil</strong><p>Buscando foto e nome da conta.</p></div>`;
    case "identificado": {
      const c = w.conta ?? {};
      return `<div class="cc-fase cc-fase--identificado">
        <p class="cc-id-estado">${pill("ok", "WhatsApp identificado")}</p>
        <div class="cc-ident">${avatar({ contatoId: c.telefoneMascarado ?? "wa", nome: c.nome ?? "WhatsApp", iniciais: c.iniciais ?? "WA", fotoUrl: c.fotoUrl, tamanho: "g" })}
          <div><h3>${e(c.nome ?? "Conta sem nome de perfil")}</h3><p class="cc-tel">${e(c.telefoneMascarado ?? "")}</p><p class="cc-nota">${e(c.tipoContaRotulo ?? "")}${c.descricao ? `. ${e(c.descricao)}` : ""}</p></div></div>
        <p class="cc-pergunta">Deseja utilizar esta conta no Crescer com Delivery?</p>
        <label class="cc-check"><input type="checkbox" data-cc-agente ${w.agente ? "checked" : ""} /> <span>Utilizar como <strong>Agente Crescer</strong> <em>(marque só se este for o número oficial)</em></span></label>
        <div class="cc-seg" role="radiogroup" aria-label="Ambiente deste número">${[["TESTE", "Ambiente de teste"], ["PRODUCAO", "Produção"]].map(([v, r]) => `<button type="button" role="radio" aria-checked="${w.ambiente === v}" class="cc-seg-op${w.ambiente === v ? " is-ativo" : ""}" data-cc-conexao="ambiente-assistente" data-cc-valor="${v}">${r}</button>`).join("")}</div>
        ${w.erro ? `<p class="cc-composer-erro" role="alert">${e(w.erro)}</p>` : ""}</div>`;
    }
    case "concluida": {
      const c = w.conta ?? {};
      return `<div class="cc-fase cc-fase--sucesso"><span class="cc-sucesso-ic" aria-hidden="true">${icon("check-circle", { size: 54 })}</span><strong>Conexão concluída</strong>
        <p>${e(c.nome ?? "A conta")} ${c.telefoneMascarado ? `<span class="cc-tel">${e(c.telefoneMascarado)}</span>` : ""} já pode enviar e receber mensagens${w.agente ? ", identificada como Agente Crescer" : ""}.</p></div>`;
    }
    default: return `<div class="cc-fase cc-fase--erro" role="alert">${icon("alert-triangle", { size: 34 })}<strong>Não foi possível concluir</strong><p>${e(w.erro ?? "Tente novamente em instantes.")}</p></div>`;
  }
}

function rodapeDaFase(w) {
  const b = (acao, rotulo, cls = "btn-ghost", extra = "") => `<button type="button" class="btn ${cls} btn-sm" data-cc-conexao="${acao}" ${extra}>${e(rotulo)}</button>`;
  if (w.fase === "identificado") return `${b("assistente-cancelar", "Cancelar")}${b("assistente-confirmar", w.enviando ? "Confirmando…" : "Confirmar conexão", "btn-primary", w.enviando ? "disabled" : "")}`;
  if (w.fase === "concluida") return b("assistente-fechar", "Concluir", "btn-primary");
  if (w.fase === "erro") return `${b("assistente-fechar", "Fechar")}${b("assistente-tentar", "Tentar de novo", "btn-primary")}`;
  if (w.fase === "expirado") return `${b("assistente-cancelar", "Cancelar")}${b("novo-qr", "Gerar novo QR Code", "btn-primary")}`;
  return b("assistente-cancelar", "Cancelar");
}

/** Modal do assistente. `w`: {modo, fase, resp, conta, agente, ambiente, erro, enviando, falhouEm}. */
export function htmlAssistente(w, agora = Date.now()) {
  return `<div class="cc-modal-wrap" data-cc-modal-wrap>
    <div class="cc-modal cc-modal--assistente" role="dialog" aria-modal="true" aria-labelledby="cc-modal-t" data-cc-fase="${e(w.fase)}">
      <header class="cc-modal-cab"><h2 id="cc-modal-t">${e(TITULO_MODO[w.modo] ?? "Conectar WhatsApp")}</h2></header>
      ${stepper(w)}
      <div class="cc-modal-corpo" data-cc-assist-corpo aria-live="polite">${corpoDaFase(w, agora)}</div>
      <footer class="cc-modal-rodape" data-cc-assist-rodape>${rodapeDaFase(w)}</footer>
    </div></div>`;
}

export const assistenteEmAndamento = (w) => !!w && FASES_EM_ANDAMENTO.includes(w.fase);

// ---------------------------------------------------------------------------
// Modais de alto impacto
// ---------------------------------------------------------------------------

function conta(c) {
  return `<div class="cc-modal-conta">${avatar({ contatoId: c?.telefoneMascarado ?? "wa", nome: c?.nome ?? "WhatsApp", iniciais: c?.iniciais ?? "WA", fotoUrl: c?.fotoUrl, tamanho: "s" })}<div><strong>${e(c?.nome ?? "Conta conectada")}</strong><span class="cc-tel">${e(c?.telefoneMascarado ?? "")}</span></div></div>`;
}

const CONSEQUENCIAS = [
  "As mensagens deixarão de ser enviadas.", "As mensagens deixarão de ser recebidas.", "As automações de WhatsApp ficarão indisponíveis.",
];

/** Modal de DESCONEXÃO (alto impacto): consequências explícitas, histórico preservado e confirmação obrigatória. */
export function htmlModalDesconectar({ conta: c, marcado = false, enviando = false, erro = "" } = {}) {
  return `<div class="cc-modal-wrap" data-cc-modal-wrap>
    <div class="cc-modal cc-modal--perigo" role="alertdialog" aria-modal="true" aria-labelledby="cc-modal-t" aria-describedby="cc-modal-d">
      <header class="cc-modal-cab"><span class="cc-modal-ic cc-modal-ic--perigo">${icon("alert-triangle", { size: 22 })}</span><h2 id="cc-modal-t">Desconectar o WhatsApp?</h2></header>
      <div class="cc-modal-corpo" id="cc-modal-d">
        ${conta(c)}
        <p>Ao desconectar:</p>
        <ul class="cc-consequencias">${CONSEQUENCIAS.map((t) => `<li>${icon("x", { size: 14 })}<span>${e(t)}</span></li>`).join("")}</ul>
        <p class="cc-preserva">${icon("check-circle", { size: 16 })}<span>O histórico de conversas e mensagens do Crescer com Delivery <strong>será preservado</strong>. Só a sessão do WhatsApp neste sistema é removida.</span></p>
        <label class="cc-check cc-check--perigo"><input type="checkbox" data-cc-confirma ${marcado ? "checked" : ""} /> <span>Entendo o impacto e quero desconectar o WhatsApp.</span></label>
        ${erro ? `<p class="cc-composer-erro" role="alert">${e(erro)}</p>` : ""}
      </div>
      <footer class="cc-modal-rodape"><button type="button" class="btn btn-ghost btn-sm" data-cc-conexao="modal-fechar">Cancelar</button>
        <button type="button" class="btn btn-perigo btn-sm" data-cc-conexao="desconectar-confirmar" ${marcado && !enviando ? "" : "disabled"}>${enviando ? "Desconectando…" : "Desconectar WhatsApp"}</button></footer>
    </div></div>`;
}

const PASSOS_TROCA = ["Confirmar a troca", "Desconectar a conta atual", "Gerar um QR Code", "Escanear a nova conta", "Identificar a nova conta", "Confirmar a identidade"];

/** Modal de TROCA de número: mostra a sequência segura e exige confirmação. */
export function htmlModalTrocar({ conta: c, marcado = false, enviando = false, erro = "" } = {}) {
  return `<div class="cc-modal-wrap" data-cc-modal-wrap>
    <div class="cc-modal cc-modal--perigo" role="alertdialog" aria-modal="true" aria-labelledby="cc-modal-t">
      <header class="cc-modal-cab"><span class="cc-modal-ic cc-modal-ic--atencao">${icon("refresh", { size: 22 })}</span><h2 id="cc-modal-t">Trocar o número conectado?</h2></header>
      <div class="cc-modal-corpo">
        ${conta(c)}
        <p>A troca segue esta sequência, sem duas sessões ao mesmo tempo:</p>
        <ol class="cc-sequencia">${PASSOS_TROCA.map((t) => `<li>${e(t)}</li>`).join("")}</ol>
        <p class="cc-nota">Enquanto a troca não termina, nenhuma mensagem é enviada ou recebida. O histórico do Crescer com Delivery é preservado.</p>
        <label class="cc-check cc-check--perigo"><input type="checkbox" data-cc-confirma ${marcado ? "checked" : ""} /> <span>Entendo e quero trocar o número.</span></label>
        ${erro ? `<p class="cc-composer-erro" role="alert">${e(erro)}</p>` : ""}
      </div>
      <footer class="cc-modal-rodape"><button type="button" class="btn btn-ghost btn-sm" data-cc-conexao="modal-fechar">Cancelar</button>
        <button type="button" class="btn btn-primary btn-sm" data-cc-conexao="trocar-confirmar" ${marcado && !enviando ? "" : "disabled"}>${enviando ? "Preparando…" : "Continuar e desconectar a conta atual"}</button></footer>
    </div></div>`;
}
