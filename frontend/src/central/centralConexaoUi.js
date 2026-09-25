// CENTRAL DE COMUNICAÇÃO — aba CONEXÃO: construtores PUROS (dados → HTML). É a área oficial de gestão da identidade WhatsApp do Crescer com Delivery, pensada como produto:
// o QUE está conectado e se JÁ PODE SER USADO vem primeiro; o técnico fica recolhido. Sem emoji, sem handler inline (CSP): tudo é `data-cc-*` com delegação no controlador.
//
// LINGUAGEM: o selo de identidade (avatar + anel + marca) é o elemento-assinatura. Ele muda de forma conforme a situação (confirmada / pendente / sem conta / erro),
// e o mesmo selo aparece no hero, no assistente e nos modais — a pessoa aprende uma vez.
// SEGURANÇA DE TELA: o QR chega só como imagem SVG e é exibido em <img> (data URL: SVG em <img> não executa script). O telefone é sempre mascarado. Nenhuma credencial existe aqui.

import { escapeHtml as e } from "../utils.js";
import { icon } from "../icons.js";
import { avatar, skeletonPainel } from "./centralUi.js";
import { badge, seloIdentidade, situacaoDoSelo, STATUS_DO_ESTADO_CONEXAO } from "./centralStatus.js";
import { ROTULO_ESTADO_CONEXAO, passosDoAssistente, progressoQr, dataHoraCurta, FASES_EM_ANDAMENTO, haQuanto, saudeDaConexao } from "./centralModelo.js";

const linha = (rot, val, nota = "") => `<div class="cc-cfg-linha"><dt>${e(rot)}</dt><dd>${val}${nota ? `<span class="cc-nota">${e(nota)}</span>` : ""}</dd></div>`;
const vazioTxt = (t) => `<span class="cc-nota">${e(t)}</span>`;
const contaAvatar = (c, tam = "x") => avatar({ contatoId: c?.telefoneMascarado ?? "wa", nome: c?.nome ?? "WhatsApp", iniciais: c?.iniciais ?? "WA", fotoUrl: c?.fotoUrl, tamanho: tam });

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

// ---------------------------------------------------------------------------
// Texto de cada estado
// ---------------------------------------------------------------------------

const pendente = (c) => c.estado === "CONNECTED" && c.identidade?.status !== "CONFIRMADA";
const confirmada = (c) => c.estado === "CONNECTED" && c.identidade?.status === "CONFIRMADA";
const podeGerenciar = (c) => c.permissoes?.gerenciar === true;

/** Título e texto do hero. Nunca promete o que ainda não é verdade (conta pendente NÃO "envia e recebe"). */
function textoDoEstado(c) {
  if (confirmada(c)) {
    const agente = c.identidade?.agenteCrescer === true;
    return {
      titulo: c.identidade?.nomeOperacional ?? c.conta?.nome ?? "WhatsApp conectado",
      texto: `Conta conectada e confirmada${agente ? ", vinculada ao Agente Crescer" : ""}. Os envios seguem as regras e habilitações da Central.`,
    };
  }
  if (pendente(c)) return { titulo: c.conta?.nome ?? "WhatsApp conectado", texto: "O WhatsApp está funcionando e a conta foi identificada. Falta um administrador autorizado confirmar que este é o número que o Crescer com Delivery deve usar." };
  switch (c.estado) {
    case "CONNECTING": return { titulo: "Conectando ao WhatsApp", texto: "Estamos abrindo a sessão. Isso costuma levar alguns segundos." };
    case "WAITING_QR": return { titulo: "Aguardando a leitura do QR Code", texto: podeGerenciar(c) && c.operacao ? "Uma conexão foi iniciada e está esperando o QR Code ser lido no celular." : "Uma pessoa da equipe está conectando o WhatsApp agora." };
    case "RECONNECTING": return { titulo: "Reconectando ao WhatsApp", texto: `A conexão caiu e está sendo restabelecida sozinha. Nenhuma ação é necessária${c.tecnico?.tentativasReconexao ? ` (tentativa ${c.tecnico.tentativasReconexao})` : ""}.` };
    case "AUTH_ERROR": return { titulo: "A sessão do WhatsApp foi encerrada", texto: "O WhatsApp desconectou este número. Conecte novamente para voltar a enviar e receber mensagens." };
    default: return { titulo: "Nenhum WhatsApp conectado", texto: "Conecte um número para enviar os avisos automáticos e conversar com os responsáveis pelo painel. O histórico existente continua preservado." };
  }
}

const NOTA_SEM_PERMISSAO = "Esta ação exige permissão de gerenciamento da conexão.";
const ROT_OPERACAO = { CONECTAR: "conexão do WhatsApp", TROCAR: "troca do número conectado", DESCONECTAR: "desconexão do WhatsApp" };

/** Ações do hero. Sem permissão: NENHUM botão morto — só uma nota discreta onde haveria ação (o estado continua inteiro na tela). */
function acoesDoEstado(c) {
  const botoes = botoesDoEstado(c);
  if (podeGerenciar(c)) return botoes;
  return botoes ? `<p class="cc-nota" data-cc-sem-permissao>${e(NOTA_SEM_PERMISSAO)}</p>` : "";
}

/** Quem só lê VÊ a operação em andamento (o backend não manda o id dela); a reconciliação tem bloco próprio. */
function notaOperacaoLeitura(c) {
  if (podeGerenciar(c) || !c.operacao || precisaReconciliar(c)) return "";
  const t = ROT_OPERACAO[c.operacao.tipo];
  return t ? `<p class="cc-nota" data-cc-operacao-andamento>Operação em andamento: ${e(t)}.</p>` : "";
}

function botoesDoEstado(c) {
  const b = (acao, rotulo, cls, ic) => `<button type="button" class="btn ${cls} btn-sm" data-cc-conexao="${acao}">${ic ? icon(ic, { size: 14 }) : ""} ${e(rotulo)}</button>`;
  if (c.estado === "CONNECTED") {
    const revisar = pendente(c) ? b("revisar", "Revisar e confirmar conta", "btn-primary cc-btn-grande", "shield-check") : "";
    return `${revisar}${b("trocar", "Trocar número conectado", "btn-ghost", "refresh")}${b("desconectar", "Desconectar WhatsApp", "btn-ghost cc-btn-perigo", "ban")}`;
  }
  if (c.estado === "WAITING_QR" && c.operacao) return `${b("retomar", "Continuar conexão", "btn-primary cc-btn-grande", "qr-code")}${b("cancelar-operacao", "Cancelar conexão", "btn-ghost", "x")}`;
  if (c.estado === "CONNECTING" || c.estado === "RECONNECTING" || c.estado === "WAITING_QR") return c.operacao ? b("cancelar-operacao", "Cancelar conexão", "btn-ghost", "x") : "";
  return b("conectar", c.estado === "AUTH_ERROR" ? "Conectar novamente" : "Conectar WhatsApp", "btn-primary cc-btn-grande", "qr-code");
}

/** Faixa de permissão limitada: fica no topo, calma, sem esconder nada do estado. */
export function htmlAvisoPermissao(c) {
  if (podeGerenciar(c)) return "";
  return `<aside class="cc-permissao" role="note">${icon("lock", { size: 18 })}<div><strong>Você pode acompanhar esta conexão.</strong><p>Apenas administradores autorizados podem conectar, trocar ou desconectar o WhatsApp.${pendente(c) ? " A confirmação desta conta também é feita por eles." : ""}</p></div></aside>`;
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function visualDoHero(c) {
  const sit = situacaoDoSelo(c.estado, c.identidade?.status);
  if (c.estado === "CONNECTED") return seloIdentidade({ situacao: sit, tam: "x", conteudo: contaAvatar(c.conta, "x") });
  if (c.estado === "DISCONNECTED") return `<div class="cc-hero-ilus">${ilustracaoDesconectado()}</div>`;
  const ic = { CONNECTING: "refresh", WAITING_QR: "qr-code", RECONNECTING: "refresh", AUTH_ERROR: "alert-octagon" }[c.estado] ?? "smartphone";
  const tom = { AUTH_ERROR: "critico" }[c.estado] ?? "atencao";
  return `<div class="cc-hero-estado cc-hero-estado--${tom}${c.estado === "RECONNECTING" || c.estado === "CONNECTING" ? " is-vivo" : ""}"><i class="cc-hero-estado-anel" aria-hidden="true"></i>${icon(ic, { size: 44 })}</div>`;
}

function distintivos(c) {
  const st = STATUS_DO_ESTADO_CONEXAO[c.estado] ?? "desconectado";
  const partes = [badge(st, { texto: ROTULO_ESTADO_CONEXAO[c.estado] ?? c.rotulo })];
  if (c.estado === "CONNECTED") partes.push(confirmada(c) ? badge("confirmado", { texto: "Conta confirmada" }) : badge("pendente", { texto: "Identidade ainda não confirmada" }));
  return partes.join("");
}

function chipsDaConta(c) {
  if (c.estado !== "CONNECTED") return "";
  const prod = c.identidade?.ambiente === "PRODUCAO";
  return `<div class="cc-id-chips">
    ${c.conta?.telefoneMascarado ? `<span class="cc-tel cc-chip-num">${icon("smartphone", { size: 13 })}${e(c.conta.telefoneMascarado)}</span>` : ""}
    ${c.conta?.tipoContaRotulo ? `<span class="cc-tag">${e(c.conta.tipoContaRotulo)}</span>` : ""}
    ${c.identidade?.ambiente ? `<span class="cc-tag ${prod ? "cc-tag--ok" : "cc-tag--neutro"}">${icon(prod ? "check-circle" : "flask", { size: 12 })}${e(prod ? "Produção" : "Ambiente de teste")}</span>` : ""}
    ${confirmada(c) && c.identidade?.agenteCrescer ? `<span class="cc-tag cc-tag--agente">${icon("bot", { size: 12 })}Agente Crescer</span>` : ""}
  </div>`;
}

/** Cartão principal (hero): um único bloco forte, o estado da identidade do WhatsApp. */
export function htmlCartaoConexao(c) {
  const t = textoDoEstado(c);
  const clima = confirmada(c) ? "ok" : pendente(c) ? "atencao" : c.estado === "AUTH_ERROR" ? "critico" : (c.estado === "DISCONNECTED" ? "neutro" : "atencao");
  const acoes = acoesDoEstado(c);
  return `<section class="cc-id-card cc-id-card--${clima}" data-cc-estado-conexao="${e(c.estado)}" data-cc-identidade="${e(c.identidade?.status ?? "")}">
    <div class="cc-id-visual">${visualDoHero(c)}</div>
    <div class="cc-id-corpo">
      <p class="cc-id-estado">${distintivos(c)}${c.semSinal ? `<span class="cc-nota">Sem resposta do Gateway. Mostrando o último estado conhecido.</span>` : ""}</p>
      <h2 class="cc-id-titulo">${e(t.titulo)}</h2>
      <p class="cc-id-texto">${e(t.texto)}</p>${notaOperacaoLeitura(c)}${chipsDaConta(c)}
      ${acoes ? `<div class="cc-id-acoes">${acoes}</div>` : ""}
    </div>
  </section>`;
}

/** Cartão de atenção do estado PENDENTE: conectado, identificado, falta a confirmação. Não é erro — é o próximo passo. */
export function htmlCartaoPendente(c) {
  if (!pendente(c)) return "";
  const item = (estado, ic, titulo, texto) => `<li class="cc-check-item cc-check-item--${estado}"><span class="cc-check-ic">${icon(ic, { size: 16 })}</span><div><strong>${e(titulo)}</strong><span>${e(texto)}</span></div></li>`;
  return `<section class="cc-atencao" role="status" data-cc-pendente>
    <header><span class="cc-atencao-selo">${icon("hourglass", { size: 20 })}</span><div><h2>Falta só a confirmação do operador</h2><p>Enquanto isso, o envio de mensagens pelo painel e as ações automáticas continuam protegidos.</p></div></header>
    <ul class="cc-checklist">
      ${item("feito", "check-circle", "A conexão está funcionando", c.tecnico?.gateway === "Respondendo" ? "O Gateway está respondendo normalmente." : "O WhatsApp está conectado.")}
      ${item("feito", "check-circle", "A conta foi identificada", `${c.conta?.nome ?? "Conta sem nome de perfil"}${c.conta?.telefoneMascarado ? `, ${c.conta.telefoneMascarado}` : ""}`)}
      ${item("pendente", "hourglass", "Confirmação do operador", podeGerenciar(c) ? "Pendente. Use “Revisar e confirmar conta”." : "Pendente. Um administrador autorizado precisa confirmar.")}
      ${item("protegido", "lock", "Envios protegidos até a confirmação", "Nada sai por esta conta antes disso.")}
    </ul>
  </section>`;
}

// ---------------------------------------------------------------------------
// Indicadores (conta conectada) — o que importa, de relance
// ---------------------------------------------------------------------------

function tile({ ic, rotulo, valor, nota = "", tom = "neutro" }) {
  return `<div class="cc-ind cc-ind--${tom}"><span class="cc-ind-ic">${icon(ic, { size: 18 })}</span><div><span class="cc-ind-rot">${e(rotulo)}</span><strong class="cc-ind-val">${e(valor)}</strong>${nota ? `<span class="cc-ind-nota">${e(nota)}</span>` : ""}</div></div>`;
}

export function htmlIndicadores(c, { agora = new Date() } = {}) {
  if (c.estado !== "CONNECTED") return "";
  const saude = saudeDaConexao(c, agora);
  const prod = c.identidade?.ambiente === "PRODUCAO";
  const s = c.saude ?? {};
  return `<div class="cc-indicadores" role="group" aria-label="Situação da conexão">
    ${tile({ ic: "activity", rotulo: "Conexão", valor: saude.texto, nota: c.tecnico?.gateway === "Respondendo" ? "Gateway respondendo" : saude.id === "estavel" ? "" : saude.detalhe, tom: saude.tom })}
    ${tile({ ic: prod ? "check-circle" : "flask", rotulo: "Ambiente", valor: c.identidade?.ambiente ? (prod ? "Produção" : "Teste") : "Não informado", nota: "Descreve o uso deste número", tom: prod ? "ok" : "neutro" })}
    ${tile({ ic: "clock", rotulo: "Última comunicação", valor: s.ultimoSinalEm ? haQuanto(s.ultimoSinalEm, agora) : "Sem registro", nota: s.ultimoSinalEm ? dataHoraCurta(s.ultimoSinalEm, agora) : "" })}
    ${tile({ ic: "calendar", rotulo: "Conectada desde", valor: s.conectadoEm ? dataHoraCurta(s.conectadoEm, agora) : "Sem registro", nota: s.conectadoEm ? haQuanto(s.conectadoEm, agora) : "" })}
  </div>`;
}

/** Bloco "Conta conectada": o que o WhatsApp informa. Só o que existe; nada inventado. */
export function htmlContaConectada(c) {
  if (c.estado !== "CONNECTED" || !c.conta) return "";
  return `<section class="cc-bloco"><header class="cc-bloco-cab"><h2>Conta conectada</h2></header><dl class="cc-cfg">
    ${linha("Nome do perfil", c.conta.nome ? e(c.conta.nome) : vazioTxt("O WhatsApp não informou"))}
    ${linha("Número", `<span class="cc-tel">${e(c.conta.telefoneMascarado ?? "")}</span>`)}
    ${linha("Tipo da conta", e(c.conta.tipoContaRotulo))}
    ${c.conta.descricao ? linha("Recado", e(c.conta.descricao)) : ""}
  </dl></section>`;
}

/** Bloco "Identidade no Crescer": nome operacional e ambiente, SEPARADOS do número. */
export function htmlIdentidade(c) {
  const conf = c.identidade?.status === "CONFIRMADA";
  const pode = podeGerenciar(c);
  const nome = c.identidade?.nomeOperacional;
  const alternar = conf && pode
    ? `<button type="button" class="cc-alternar${c.identidade.agenteCrescer ? " is-ligado" : ""}" role="switch" aria-checked="${c.identidade.agenteCrescer}" data-cc-conexao="agente" aria-label="Utilizar como Agente Crescer"><i></i></button>` : "";
  const ambiente = pode
    ? `<div class="cc-seg" role="radiogroup" aria-label="Ambiente">${[["TESTE", "Teste"], ["PRODUCAO", "Produção"]].map(([v, r]) => `<button type="button" role="radio" aria-checked="${c.identidade?.ambiente === v}" class="cc-seg-op${c.identidade?.ambiente === v ? " is-ativo" : ""}" data-cc-conexao="ambiente" data-cc-valor="${v}">${r}</button>`).join("")}</div>`
    : e(c.identidade?.ambienteRotulo ?? "");
  return `<section class="cc-bloco"><header class="cc-bloco-cab"><h2>Identidade no Crescer com Delivery</h2>${conf ? badge("confirmado", { tam: "p", texto: c.identidade?.confirmadoEm ? `Confirmada ${haQuanto(c.identidade.confirmadoEm)}` : "Confirmada" }) : badge("pendente", { tam: "p", texto: "Aguardando confirmação" })}</header><dl class="cc-cfg">
    ${linha("Nome operacional", `<span class="cc-linha-ctl"><strong>${nome ? e(nome) : "Sem nome operacional"}</strong>${alternar}</span>`,
      conf ? (pode ? "Ligue “Agente Crescer” quando este for o número oficial." : "Definido por um administrador.") : "Disponível depois que a conta for confirmada.")}
    ${linha("Ambiente", ambiente, "Só descreve o uso deste número. Não altera nenhuma regra de envio.")}
  </dl><p class="cc-nota cc-id-rodape">O nome operacional pertence à conta confirmada. Se o número mudar, ele precisa ser definido de novo.</p></section>`;
}

// ---------------------------------------------------------------------------
// Estados sem conta conectada: contexto útil no lugar de espaço vazio
// ---------------------------------------------------------------------------

/** "Como funciona": 3 passos, para quem vai conectar pela primeira vez (ou de novo). */
export function htmlComoConectar(c) {
  if (c.estado !== "DISCONNECTED" && c.estado !== "AUTH_ERROR") return "";
  const passo = (ic, t, x) => `<li><span class="cc-como-ic">${icon(ic, { size: 20 })}</span><div><strong>${e(t)}</strong><p>${e(x)}</p></div></li>`;
  return `<section class="cc-bloco cc-como"><header class="cc-bloco-cab"><h2>Como conectar</h2></header><ol class="cc-como-lista">
    ${passo("qr-code", "Inicie a conexão", "O painel gera um QR Code seguro, válido por poucos segundos.")}
    ${passo("smartphone", "Leia com o celular", "No WhatsApp, abra Aparelhos conectados e aponte a câmera.")}
    ${passo("shield-check", "Confirme a identidade", "Você confere a conta e libera o uso no Crescer com Delivery.")}
  </ol></section>`;
}

/** Último registro conhecido (some quando não há nada a dizer). */
export function htmlUltimoRegistro(c, { agora = new Date() } = {}) {
  if (c.estado === "CONNECTED") return "";
  const t = c.tecnico ?? {};
  if (!t.ultimaConexaoEm && !t.ultimaDesconexaoEm && !t.motivoUltimaDesconexao) return "";
  return `<section class="cc-bloco cc-registro"><header class="cc-bloco-cab"><h2>Último registro</h2></header><dl class="cc-cfg">
    ${t.ultimaConexaoEm ? linha("Última conexão", e(dataHoraCurta(t.ultimaConexaoEm, agora))) : ""}
    ${t.ultimaDesconexaoEm ? linha("Última desconexão", e(dataHoraCurta(t.ultimaDesconexaoEm, agora))) : ""}
    ${t.motivoUltimaDesconexao ? linha("O que aconteceu", e(t.motivoUltimaDesconexao)) : ""}
  </dl>${c.estado === "AUTH_ERROR" ? `<p class="cc-nota cc-id-rodape">O histórico de conversas e mensagens continua preservado. Só a sessão do WhatsApp precisa ser refeita.</p>` : ""}</section>`;
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
// ---------------------------------------------------------------------------
// Reconciliação: a última operação externa não teve o resultado confirmado. O operador só DISPARA a verificação; quem decide é o backend.
// ---------------------------------------------------------------------------
const ROT_ACAO_EFEITO = { DESCONECTAR: "Desconectar a conta", RESET: "Reiniciar a sessão", CONECTAR: "Conectar o WhatsApp", ENCERRAR: "Encerrar a conexão" };
const ROT_RESULTADO = {
  janela_de_estabilizacao: "Operação muito recente: aguardando estabilizar", gateway_indisponivel: "Gateway sem resposta", evidencia_contraditoria: "Evidências contraditórias",
  estado_gateway_indeterminado: "Estado do Gateway indeterminado", aguardando_consumo: "Aguardando o Gateway", sessao_original_ativa: "Sessão original ainda ativa", sessao_encerrada: "Sessão encerrada",
  sessao_substituida: "Sessão substituída", sessao_diferente: "Sessão diferente da original", pareamento_ativo: "Pareamento ativo", gateway_desconectado: "Gateway desconectado", gateway_ainda_ativo: "Gateway ainda ativo",
  token_nunca_consumido: "Operação nunca chegou a executar",
};
const ROT_DECISAO = { AINDA_INCERTO: "Ainda incerto", CONCLUIDO: "Confirmada como executada", ABORTADO: "Confirmada como não executada", JA_RESOLVIDO: "Já resolvida" };
/** "DECISAO:motivo" -> texto amigável (só valores conhecidos; qualquer outra coisa é ignorada, nunca renderizada crua). */
function rotuloResultado(txt) {
  const [d, m] = String(txt ?? "").split(":");
  if (!ROT_DECISAO[d]) return "";
  return m && ROT_RESULTADO[m] ? `${ROT_DECISAO[d]} · ${ROT_RESULTADO[m]}` : ROT_DECISAO[d];
}
const MSG_VERIFICACAO = {
  CONCLUIDO: ["ok", "Verificação concluída", "A última operação foi confirmada como executada. O estado da conexão foi atualizado."],
  ABORTADO: ["ok", "Verificação concluída", "A última operação foi confirmada como não executada. A conexão continua como estava."],
  JA_RESOLVIDO: ["ok", "Nada pendente", "Esta situação já foi resolvida."],
  AINDA_INCERTO: ["neutro", "Ainda não há evidência suficiente", "Ainda não foi possível confirmar o resultado. Você poderá verificar novamente mais tarde."],
  erro: ["erro", "Não foi possível verificar agora", "Tente novamente em instantes."],
};
export const precisaReconciliar = (c) => c?.reconciliacao?.reconciliacaoNecessaria === true || c?.operacao?.reconciliacaoNecessaria === true;

/** Bloco de atenção. `verificacao`: { fase: "verificando" | "resultado" | "erro", decisao? } (estado local do controlador; nunca vem do servidor). */
export function htmlBlocoReconciliacao(c, { agora = new Date(), verificacao = null } = {}) {
  const necessaria = precisaReconciliar(c);
  const resultado = verificacao?.fase === "resultado" ? (MSG_VERIFICACAO[verificacao.decisao] ?? null) : verificacao?.fase === "erro" ? MSG_VERIFICACAO.erro : null;
  if (!necessaria && !resultado) return "";
  const r = c.reconciliacao ?? c.operacao ?? {};
  const verificando = verificacao?.fase === "verificando";
  const acao = ROT_ACAO_EFEITO[r.acao ?? r.efeitoAcao];
  const desde = r.incertoDesde ? `${dataHoraCurta(r.incertoDesde, agora)} (${haQuanto(r.incertoDesde, agora)})` : "";
  const ultimo = rotuloResultado(r.ultimoResultado);
  const verif = r.ultimaVerificacaoEm ? `${dataHoraCurta(r.ultimaVerificacaoEm, agora)} (${haQuanto(r.ultimaVerificacaoEm, agora)})` : "";
  const detalhes = necessaria ? `<dl class="cc-cfg">${acao ? linha("Operação", e(acao)) : ""}${desde ? linha("Sem confirmação desde", e(desde)) : ""}${ultimo ? linha("Último resultado", e(ultimo)) : ""}${verif ? linha("Última verificação", e(verif)) : ""}</dl>` : "";
  const nota = resultado ? `<p class="cc-recon-resultado cc-recon-resultado--${resultado[0]}" role="status" data-cc-recon-resultado="${e(verificacao.decisao ?? "erro")}"><strong>${e(resultado[1])}.</strong> ${e(resultado[2])}</p>` : "";
  const acaoHtml = !necessaria ? "" : podeGerenciar(c)
    ? `<div class="cc-id-acoes"><button type="button" class="btn btn-primary btn-sm" data-cc-conexao="reconciliar" ${verificando ? 'disabled aria-busy="true"' : ""}>${verificando ? "Verificando…" : "Verificar estado da conexão"}</button></div>`
    : `<p class="cc-nota">Um administrador autorizado precisa verificar o estado da conexão.</p>`;
  return `<section class="cc-atencao" role="status" data-cc-reconciliacao>
    <header><span class="cc-atencao-selo">${icon("hourglass", { size: 20 })}</span><div><h2>${necessaria ? "Resultado da última operação não confirmado" : e(resultado[1])}</h2>${necessaria ? "<p>Não foi possível confirmar automaticamente o resultado da última operação. Por segurança, novas operações de conexão ficam bloqueadas até a verificação.</p>" : ""}</div></header>
    ${detalhes}${nota}${acaoHtml}
  </section>`;
}

export function htmlConexao(c, { agora = new Date(), verificacao = null } = {}) {
  if (!c) return `<div class="cc-conexao">${skeletonPainel()}</div>`;
  const conectado = c.estado === "CONNECTED";
  return `<div class="cc-conexao">
    ${htmlAvisoPermissao(c)}${htmlCartaoConexao(c)}${htmlBlocoReconciliacao(c, { agora, verificacao })}${htmlCartaoPendente(c)}
    ${conectado ? `${htmlIndicadores(c, { agora })}<div class="cc-conexao-grade">${htmlContaConectada(c)}${htmlIdentidade(c)}</div>` : `<div class="cc-conexao-grade">${htmlComoConectar(c)}${htmlUltimoRegistro(c, { agora })}</div>`}
    ${htmlDetalhesTecnicos(c, { agora })}
  </div>`;
}

// ---------------------------------------------------------------------------
// Assistente de conexão (modal) — 5 etapas
// ---------------------------------------------------------------------------

const TITULO_MODO = { conectar: "Conectar WhatsApp", trocar: "Trocar número conectado", revisar: "Confirmar conta do WhatsApp", retomar: "Continuar conexão" };

/** Progresso (0..100, número puro) do trilho do stepper: etapas concluídas sobre o intervalo entre a 1ª e a última. */
export function progressoDoAssistente(w) {
  const ps = passosDoAssistente(w.fase, { falhouEm: w.falhouEm });
  if (w.fase === "concluida") return 100;
  const i = ps.findIndex((p) => p.estado === "ativo" || p.estado === "erro");
  return Math.round(((i < 0 ? ps.filter((p) => p.estado === "feito").length : i) / (ps.length - 1)) * 100);
}

function stepper(w) {
  const ps = passosDoAssistente(w.fase, { falhouEm: w.falhouEm });
  const prog = progressoDoAssistente(w);
  const de = Number.isFinite(w.progDe) ? w.progDe : prog;
  return `<ol class="cc-stepper" aria-label="Etapas da conexão" style="--prog:${prog};--prog-de:${de}">${ps.map((p, i) => `<li class="cc-step cc-step--${p.estado}"${p.estado === "ativo" ? ' aria-current="step"' : ""}>
      <span class="cc-step-no">${p.estado === "feito" ? icon("check-circle", { size: 18 }) : p.estado === "erro" ? icon("alert-triangle", { size: 16 }) : `<b>${i + 1}</b>`}</span><span class="cc-step-rot">${e(p.rotulo)}</span></li>`).join("")}</ol>`;
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

const ETAPAS_LEITURA = [["smartphone", "Abra o WhatsApp no celular."], ["settings", "Toque em Aparelhos conectados."], ["link", "Toque em Conectar um aparelho."], ["qr-code", "Aponte a câmera para este QR Code."]];

const carregando = (titulo, texto, miolo = `<i class="cc-spinner" aria-hidden="true"></i>`) => `<div class="cc-fase cc-fase--carregando">${miolo}<strong>${e(titulo)}</strong><p>${e(texto)}</p></div>`;

function corpoDaFase(w, agora) {
  switch (w.fase) {
    case "iniciando": return carregando("Iniciando a conexão", "Abrindo uma sessão segura com o WhatsApp.");
    case "gerando": return `<div class="cc-fase cc-fase--carregando">${htmlQuadroQr({ ...w, resp: {} }, agora)}<strong>Gerando o QR Code</strong><p>Só um instante.</p></div>`;
    case "aguardando": case "expirado": return `<div class="cc-fase cc-fase--qr">${htmlQuadroQr(w, agora)}
        <div class="cc-fase-texto"><strong>${w.fase === "expirado" ? "Este QR Code expirou" : "Escaneie com o celular"}</strong>
          <ol class="cc-leitura">${ETAPAS_LEITURA.map(([ic, t]) => `<li><span>${icon(ic, { size: 15 })}</span>${e(t)}</li>`).join("")}</ol>
          ${w.svgIndisponivel ? `<p class="cc-composer-erro" role="alert">O Gateway não enviou a imagem do QR Code. Atualize o Gateway e tente de novo.</p>` : ""}
          <p class="cc-nota">Use o número que o Crescer com Delivery vai utilizar. Nada é enviado durante a conexão.</p></div></div>`;
    case "validando": return `<div class="cc-fase cc-fase--carregando"><span class="cc-check-anim" aria-hidden="true">${icon("check-circle", { size: 44 })}</span><strong>QR Code lido</strong><p>Validando a sessão que acabou de ser criada.</p></div>`;
    case "perfil": return `<div class="cc-fase cc-fase--carregando"><div class="cc-perfil-skel" aria-hidden="true"><i class="cc-skel cc-skel--av-g"></i><i class="cc-skel cc-skel--l1"></i><i class="cc-skel cc-skel--l2"></i></div><strong>Identificando a conta</strong><p>Buscando foto e nome do perfil.</p></div>`;
    case "identificado": {
      const c = w.conta ?? {};
      const opcao = (v, t, x) => `<button type="button" role="radio" aria-checked="${w.ambiente === v}" class="cc-opcao${w.ambiente === v ? " is-ativa" : ""}" data-cc-conexao="ambiente-assistente" data-cc-valor="${v}"><span class="cc-opcao-ic">${icon(v === "PRODUCAO" ? "check-circle" : "flask", { size: 16 })}</span><span><strong>${t}</strong><em>${x}</em></span></button>`;
      return `<div class="cc-fase cc-fase--identificado">
        <div class="cc-ident">${seloIdentidade({ situacao: "pendente", tam: "g", conteudo: avatar({ contatoId: c.telefoneMascarado ?? "wa", nome: c.nome ?? "WhatsApp", iniciais: c.iniciais ?? "WA", fotoUrl: c.fotoUrl, tamanho: "g" }) })}
          <div><p class="cc-id-estado">${badge("conectado", { tam: "p", texto: "WhatsApp identificado" })}</p><h3>${e(c.nome ?? "Conta sem nome de perfil")}</h3><p class="cc-tel">${e(c.telefoneMascarado ?? "")}</p><p class="cc-nota">${e(c.tipoContaRotulo ?? "")}${c.descricao ? `. ${e(c.descricao)}` : ""}</p></div></div>
        <p class="cc-pergunta">Esta é a conta que o Crescer com Delivery deve usar?</p>
        <label class="cc-check cc-check--cartao"><input type="checkbox" data-cc-agente ${w.agente ? "checked" : ""} /> <span><strong>Vincular ao Agente Crescer</strong><em>Marque só se este for o número oficial do agente.</em></span></label>
        <div class="cc-opcoes" role="radiogroup" aria-label="Ambiente deste número">${opcao("TESTE", "Ambiente de teste", "Para validar o funcionamento")}${opcao("PRODUCAO", "Produção", "Uso oficial no dia a dia")}</div>
        ${w.erro ? `<p class="cc-composer-erro" role="alert">${e(w.erro)}</p>` : ""}</div>`;
    }
    case "concluida": {
      const c = w.conta ?? {};
      return `<div class="cc-fase cc-fase--sucesso">${seloIdentidade({ situacao: "confirmada", tam: "g", conteudo: avatar({ contatoId: c.telefoneMascarado ?? "wa", nome: c.nome ?? "WhatsApp", iniciais: c.iniciais ?? "WA", fotoUrl: c.fotoUrl, tamanho: "g" }) })}<strong>Conexão concluída</strong>
        <p>${e(c.nome ?? "A conta")} ${c.telefoneMascarado ? `<span class="cc-tel">${e(c.telefoneMascarado)}</span>` : ""} está confirmada${w.agente ? ", vinculada ao Agente Crescer" : ""}. Os envios seguem as regras e habilitações da Central.</p></div>`;
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
