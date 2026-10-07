// WHATSAPP POR EMPRESA (fim do piloto, migration 104) — construtores PUROS (dados -> string HTML; sem DOM, sem rede) da tela de configuração definitiva:
// status operacional, envio automático, VÁRIOS destinatários (com categorias de aviso), limites e resultado da simulação (dry-run).
// A ligação com a página (eventos e chamadas de API) fica em painelAdmViews.js.
//
// REGRAS: telefone SEMPRE mascarado (o backend nem manda o número completo; só o operador digita um número novo num campo de formulário).
// Nada de "piloto" nem "allowlist": as variáveis antigas, se existirem, aparecem só como "LEGACY — sem efeito" no diagnóstico técnico.

import { escapeHtml } from "./utils.js";
import { icon } from "./icons.js";
import { secao, chip, fmtData } from "./painelAdmUi.js";

const ROTULO_GATEWAY = Object.freeze({ conectado: "Conectado", desconectado: "Desconectado", instavel: "Instável", desconhecido: "Desconhecido" });
const dt = (iso) => (iso ? escapeHtml(fmtData(iso)) : "—");
export const TIPOS_DESTINATARIO = Object.freeze([
  ["secundario", "Secundário"], ["operacional", "Operacional"], ["financeiro", "Financeiro"], ["principal", "Principal"],
]);
const ROTULO_TIPO = Object.fromEntries(TIPOS_DESTINATARIO);

const TOM_STATUS = Object.freeze({
  ATIVO: "ok", DESATIVADO_PARA_EMPRESA: "muted", CONFIGURACAO_INCOMPLETA: "atencao", SEM_DESTINATARIOS_ATIVOS: "atencao",
  ENVIO_AUTOMATICO_DESLIGADO: "atencao", EMPRESA_PAUSADA: "muted", ENVIO_GLOBAL_DESATIVADO: "atencao",
});

const ROTULO_WA = Object.freeze({ VALIDADO: ["ok", "WhatsApp validado"], AGUARDANDO_VALIDACAO: ["atencao", "Aguardando autorização"], NAO_VALIDADO: ["atencao", "Não autorizado"], ERRO: ["critico", "Erro"] });

/** Motivos de bloqueio (dry-run) em português para o operador. */
export const ROTULO_MOTIVO = Object.freeze({
  EMPRESA_DESABILITADA: "WhatsApp desativado para esta empresa", TIPO_NAO_PERMITIDO: "Tipo de alerta não permitido", ENVIO_AUTOMATICO_DESLIGADO: "Envio automático desligado",
  CONFIG_HORARIO_INVALIDA: "Fuso horário/janelas inválidos", EMPRESA_PAUSADA: "Empresa pausada", SEM_DESTINATARIOS: "Sem destinatários cadastrados",
  SEM_DESTINATARIOS_ELEGIVEIS: "Nenhum destinatário elegível", SEM_DATA_DE_REFERENCIA: "Sem data de referência",
  DESTINATARIO_INATIVO: "Destinatário inativo", WHATSAPP_NAO_VALIDADO: "WhatsApp não autorizado", SEM_CONTATO: "Sem telefone registrado", TELEFONE_DIVERGENTE: "Telefone divergente",
  OPT_OUT: "Pediu para não receber (opt-out)", SEM_CONSENTIMENTO: "Sem consentimento", TELEFONE_NAO_VERIFICADO: "Telefone não verificado", CATEGORIA_NAO_HABILITADA: "Categoria de aviso não habilitada",
});
export const rotuloMotivo = (m) => ROTULO_MOTIVO[m] ?? String(m ?? "—");

/**
 * Grupo recolhível do drawer: o que é consulta ou ajuste eventual fica fechado por padrão, para o operador ver
 * primeiro só o essencial (situação, interruptores e destinatários). `resumo` aparece ao lado do título mesmo fechado.
 */
export function grupo({ titulo, icone = "", resumo = "", corpo, aberto = false, attrs = "" }) {
  return `
    <details class="padm-wa-grupo"${aberto ? " open" : ""}${attrs ? ` ${attrs}` : ""}>
      <summary>
        ${icone ? `<span class="padm-wa-grupo-ic">${icon(icone, { size: 15 })}</span>` : ""}
        <span class="padm-wa-grupo-tit">${escapeHtml(titulo)}</span>
        ${resumo ? `<span class="padm-wa-grupo-resumo">${resumo}</span>` : ""}
        <span class="padm-wa-grupo-seta" aria-hidden="true">${icon("chevron-right", { size: 14 })}</span>
      </summary>
      <div class="padm-wa-grupo-corpo">${corpo}</div>
    </details>`;
}

/** Situação da empresa: um chip com o motivo + os fatos do envio em grade compacta (os interruptores mostram empresa/automático). */
export function htmlStatusWhatsappEmpresa(p) {
  if (!p?.status) return "";
  const s = p.status;
  const n = Number(s.destinatariosAtivos ?? 0);
  const fatos = [
    ["WhatsApp", escapeHtml(ROTULO_GATEWAY[s.whatsapp] ?? "—")],
    ["Envio global", s.envioRealPermitido ? "Permitido" : "Bloqueado (DISABLED)"],
    ["Destinatários", `${n} ativo${n === 1 ? "" : "s"}${s.destinatariosTotal > n ? ` (de ${Number(s.destinatariosTotal)})` : ""}`],
    ["Último envio", s.ultimoEnvioEm ? dt(s.ultimoEnvioEm) : "Nenhum envio ainda"],
    ...(s.proximoEnvioPossivelEm ? [["Próximo envio possível", dt(s.proximoEnvioPossivelEm)]] : []),
  ];
  return `
    <div class="padm-wa-situacao">${chip({ classe: TOM_STATUS[s.codigo] ?? "muted", rotulo: s.rotulo })}${s.motivo ? `<small>${escapeHtml(s.motivo)}</small>` : ""}</div>
    <dl class="padm-wa-fatos" data-padm-status-whatsapp>${fatos.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
}

/** Interruptor visual (role=switch). Sem `acao` fica desabilitado. */
const interruptor = ({ ligado, acao = "", rotulo }) =>
  `<button type="button" class="padm-switch" role="switch" aria-checked="${ligado ? "true" : "false"}" aria-label="${escapeHtml(rotulo)}" title="${escapeHtml(rotulo)}"${acao ? ` data-padm-acao="${acao}"` : " disabled"}><i></i></button>`;

/** Uma linha de alavanca: ícone, título, estado em uma frase e o interruptor; a confirmação (quando houver) abre logo abaixo. */
const alavanca = ({ icone, titulo, estado, ligado, controle, confirmar = "" }) => `
  <div class="padm-alavanca padm-habilitacao-acao" data-ligado="${ligado ? "1" : "0"}">
    <span class="padm-alavanca-ic">${icon(icone, { size: 15 })}</span>
    <div class="padm-alavanca-txt"><strong>${escapeHtml(titulo)}</strong><small>${escapeHtml(estado)}</small></div>
    ${controle}
    ${confirmar}
  </div>`;

const confirmacao = (texto, cancelar, confirmar, rotulo) => `
  <div class="padm-habilitacao-confirmar" hidden>
    <p>${texto}</p>
    <div>
      <button type="button" class="btn btn-ghost btn-sm" data-padm-acao="${cancelar}">Cancelar</button>
      <button type="button" class="btn btn-primary btn-sm" data-padm-acao="${confirmar}">${escapeHtml(rotulo)}</button>
    </div>
  </div>`;

/** Ativar/desativar os avisos da empresa + envio automático (decisões SEPARADAS; ligar exige confirmação, desligar é direto). */
export function htmlAlavancasEmpresa(p) {
  if (!p?.status) return "";
  const s = p.status;
  const habilitada = s.empresaHabilitada === true;
  const automatico = habilitada && s.envioAutomatico === true;
  const avisos = alavanca({
    icone: "bell", titulo: "Avisos pelo WhatsApp", ligado: habilitada,
    estado: habilitada ? "Ativados — a empresa pode receber avisos." : "Desativados — nenhum aviso é gerado para esta empresa.",
    controle: habilitada
      ? interruptor({ ligado: true, acao: "desabilitar-comunicacao-org", rotulo: "Desativar avisos pelo WhatsApp" })
      : interruptor({ ligado: false, acao: "pedir-habilitar-comunicacao", rotulo: "Ativar avisos pelo WhatsApp" }),
    confirmar: habilitada ? "" : confirmacao(
      "Ativar os avisos pelo WhatsApp para esta empresa? Fica registrado na auditoria. Isso <strong>não</strong> liga o envio automático.",
      "cancelar-habilitar-comunicacao", "confirmar-habilitar-comunicacao", "Ativar avisos"),
  });
  const auto = alavanca({
    icone: "send", titulo: "Envio automático", ligado: automatico,
    estado: !habilitada ? "Ative os avisos primeiro." : automatico ? "Ligado — envia no horário comercial, com limites e cooldown." : "Desligado — nada é enviado sozinho.",
    controle: !habilitada
      ? interruptor({ ligado: false, rotulo: "Ative os avisos da empresa antes de ligar o envio automático" })
      : automatico
        ? interruptor({ ligado: true, acao: "desligar-envio-automatico", rotulo: "Desligar envio automático" })
        : interruptor({ ligado: false, acao: "pedir-ligar-envio-automatico", rotulo: "Ligar envio automático" }),
    confirmar: habilitada && !automatico ? confirmacao(
      "Ligar o envio automático? As mensagens passam a sair sozinhas, no horário comercial, para os destinatários ativos e autorizados. Com o modo global em DISABLED nada é enviado.",
      "cancelar-ligar-envio-automatico", "confirmar-ligar-envio-automatico", "Ligar envio automático") : "",
  });
  return `<div class="padm-alavancas">${avisos}${auto}</div>`;
}

function checksCategorias(disponiveis, marcadas, nome) {
  const set = new Set(marcadas ?? []);
  return (disponiveis ?? []).map((c) =>
    `<label class="padm-check"><input type="checkbox" name="${nome}" value="${escapeHtml(c.codigo)}" ${set.has(c.codigo) ? "checked" : ""} /> ${escapeHtml(c.rotulo)}</label>`).join("");
}

function optionsTipo(atual) {
  return TIPOS_DESTINATARIO.map(([v, r]) => `<option value="${v}" ${v === atual ? "selected" : ""}>${escapeHtml(r)}</option>`).join("");
}

function linhaDestinatario(d, categorias) {
  const rot = new Map((categorias ?? []).map((c) => [c.codigo, c.rotulo]));
  const [tomWa, rotWa] = ROTULO_WA[d.whatsappStatus] ?? ["muted", String(d.whatsappStatus ?? "—")];
  const cats = (d.categorias ?? []).map((c) => rot.get(c) ?? c);
  const id = escapeHtml(d.id);
  const autorizado = d.whatsappStatus === "VALIDADO" && d.consentimento && d.verificado;
  // Um chip só quando está tudo certo; os problemas aparecem um a um (menos ruído na linha saudável).
  const chips = d.optOut ? chip({ classe: "critico", rotulo: "Opt-out" })
    : !d.ativo ? chip({ classe: "muted", rotulo: "Inativo" })
      : autorizado ? chip({ classe: "ok", rotulo: "Recebendo" })
        : chip({ classe: tomWa === "ok" ? "atencao" : tomWa, rotulo: tomWa === "ok" ? "Autorização incompleta" : rotWa });
  const datas = [["Autorizado em", d.autorizadoEm], ["Ativado em", d.ativadoEm]].filter(([, v]) => v).map(([k, v]) => `${k} ${dt(v)}`).join(" · ");
  return `
    <li class="padm-dest${d.ativo ? "" : " padm-dest--inativo"}" data-padm-dest="${id}">
      <div class="padm-dest-topo">
        <div class="padm-dest-id"><strong>${escapeHtml(d.nome)}</strong><span class="padm-mono">${escapeHtml(d.telefoneMascarado ?? "—")}</span></div>
        ${chips}
      </div>
      <div class="padm-dest-meta">
        ${escapeHtml(ROTULO_TIPO[d.tipo] ?? d.tipo ?? "")} · ${cats.length ? escapeHtml(cats.join(", ")) : "nenhum aviso"} · Último envio: ${d.ultimoEnvioEm ? dt(d.ultimoEnvioEm) : "—"}
      </div>
      <div class="padm-dest-acoes">
        ${autorizado || d.optOut ? "" : `<button type="button" class="btn btn-primary btn-sm" data-padm-dest-acao="autorizar" data-padm-dest-id="${id}">Registrar autorização</button>`}
        <button type="button" class="btn btn-ghost btn-sm" data-padm-dest-acao="editar" data-padm-dest-id="${id}">Editar</button>
        <button type="button" class="btn btn-ghost btn-sm" data-padm-dest-acao="ativo" data-padm-dest-id="${id}" data-padm-ativo="${d.ativo ? "0" : "1"}">${d.ativo ? "Desativar" : "Reativar"}</button>
      </div>
      <form class="padm-form padm-dest-editar" data-padm-dest-form="editar" data-padm-dest-id="${id}" hidden>
        <div class="padm-form-linha">
          <label>Nome<input type="text" name="nome" value="${escapeHtml(d.nome)}" required /></label>
          <label>Tipo<select name="tipo">${optionsTipo(d.tipo)}</select></label>
        </div>
        <label>Novo telefone <small>(só para trocar — a autorização será refeita)</small>
          <input type="text" name="telefone" inputmode="tel" placeholder="11 99999-8888" /></label>
        <fieldset class="padm-checks"><legend>Avisos que recebe</legend>${checksCategorias(categorias, d.categorias, "categorias")}</fieldset>
        ${datas ? `<p class="padm-form-nota">${datas}</p>` : ""}
        <div class="padm-form-rodape">
          <button type="submit" class="btn btn-primary btn-sm">Salvar</button>
          ${d.optOut ? "" : `<button type="button" class="btn btn-ghost btn-sm padm-btn-discreto" data-padm-dest-acao="optout" data-padm-dest-id="${id}">Registrar opt-out</button>`}
        </div>
      </form>
    </li>`;
}

/** Destinatários (VÁRIOS por empresa) + formulário de novo destinatário (recolhido quando já existe alguém). */
export function htmlDestinatarios(p) {
  if (!p) return "";
  const lista = p.destinatarios ?? [];
  const teto = p.configuracao?.tetoDestinatariosAtivos ?? null;
  const ativos = lista.filter((d) => d.ativo).length;
  const cheio = teto != null && ativos >= teto;
  const cats = p.categoriasDisponiveis ?? [];
  return secao({
    titulo: "Destinatários", icone: "users",
    sub: `${ativos} ativo${ativos === 1 ? "" : "s"}${teto != null ? ` de até ${teto}` : ""} · cada um com limites e cooldown próprios`,
    corpo: `
      ${lista.length ? `<ul class="padm-dest-lista">${lista.map((d) => linhaDestinatario(d, cats)).join("")}</ul>` : `<p class="padm-vazio">Nenhum destinatário cadastrado.</p>`}
      <details class="padm-dest-novo"${lista.length ? "" : " open"}>
        <summary>${icon("plus", { size: 14 })} Novo destinatário</summary>
        <form class="padm-form" data-padm-dest-form="novo">
          <div class="padm-form-linha">
            <label>Nome<input type="text" name="nome" required /></label>
            <label>Tipo<select name="tipo">${optionsTipo("secundario")}</select></label>
          </div>
          <div class="padm-form-linha padm-form-linha--tel">
            <label>DDI<input type="text" name="ddi" value="55" inputmode="numeric" pattern="[0-9]{1,3}" /></label>
            <label>Telefone (DDD + número)<input type="text" name="telefone" inputmode="tel" placeholder="11 99999-8888" required /></label>
          </div>
          <fieldset class="padm-checks"><legend>Avisos que recebe</legend>${checksCategorias(cats, cats.map((c) => c.codigo), "categorias")}</fieldset>
          <label>Observações <small>(opcional)</small><input type="text" name="observacoes" /></label>
          <div class="padm-form-rodape">
            <button type="submit" class="btn btn-primary btn-sm" ${cheio ? "disabled" : ""}>Adicionar destinatário</button>
          </div>
          <p class="padm-form-nota">${cheio ? "Limite de destinatários ativos atingido — desative um antes de adicionar." : "Só recebe depois de a autorização ser registrada. Nada é enviado ao salvar."}</p>
        </form>
      </details>`,
  });
}

const ALERTA_SITUACOES = new Set(["PARCIAL", "PARCIAL_EM_ANDAMENTO", "SEM_ENTREGA", "INCERTA"]);

/** Alertas recentes com a ENTREGA por destinatário: uma entrega parcial nunca fica escondida atrás do status "enviado" do alerta. */
export function htmlAlertasRecentes(p) {
  const lista = p?.alertasRecentes ?? [];
  if (!p) return "";
  const cont = (e) => [
    ["previstos", e.previstos], ["enviados", e.enviados], ["pendentes", e.pendentes], ["entrega incerta", e.entregaIncerta],
    ["falha permanente", e.falhaPermanente], ["opt-out", e.optOut], ["bloqueados", e.bloqueados], ["expirados", e.expirados],
  ].filter(([r, n]) => n > 0 || r === "previstos" || r === "enviados").map(([r, n]) => `${n} ${r}`).join(" · ");
  const problemas = lista.filter((a) => ALERTA_SITUACOES.has(a.entrega?.situacao)).length;
  const resumo = !lista.length ? "nenhum"
    : problemas ? chip({ classe: "atencao", rotulo: `${problemas} com entrega incompleta` })
      : `${lista.length}`;
  return grupo({
    titulo: "Alertas recentes", icone: "bell", resumo, aberto: problemas > 0,
    corpo: lista.length ? `<ul class="padm-alertas-recentes">${lista.map((a) => `
      <li data-situacao="${escapeHtml(a.entrega.situacao)}">
        <strong>${escapeHtml(a.tipo)} · ${escapeHtml(a.dataReferencia)}</strong>
        <span class="padm-chip${ALERTA_SITUACOES.has(a.entrega.situacao) ? " padm-chip-alerta" : ""}">${escapeHtml(a.entrega.rotulo)}</span>
        <small>${escapeHtml(cont(a.entrega))}</small>
      </li>`).join("")}</ul>` : `<p class="padm-vazio">Nenhum alerta ainda.</p>`,
  });
}

/** Limites por empresa: por destinatário × por empresa (em branco = padrão global). Bloco interno do grupo "Configuração". */
export function htmlLimitesEmpresa(p) {
  const l = p?.configuracao?.limites;
  if (!l) return "";
  const g = l.padraoGlobal ?? {};
  return `
    <form id="padm-com-limites-form" class="padm-form">
      <h4>Limites de envio</h4>
      <div class="padm-form-linha">
        <label>Máx. por dia (empresa)<input type="number" min="1" name="limiteDiarioOrg" value="${l.limiteDiarioOrg ?? ""}" placeholder="padrão" /></label>
        <label>Cooldown por destinatário (min)<input type="number" min="1" name="cooldownMinutos" value="${l.cooldownMinutos ?? ""}" placeholder="padrão" /></label>
      </div>
      <p class="padm-form-nota">Em branco = padrão global: até ${g.maxPorDestinatarioPorDia ?? "—"} mensagens por destinatário/dia · até ${g.maxPorOrganizacaoPorDia ?? "—"} por empresa/dia.</p>
      <div class="padm-form-rodape"><button type="submit" class="btn btn-ghost btn-sm">Salvar limites</button></div>
    </form>`;
}

const OK_ICONE = (ok) => icon(ok ? "check-circle" : "minus-circle", { size: 13 });
const ROTULO_ETAPA = Object.freeze({
  ALERTA_DETECTADO: "Alerta detectado", EMPRESA_ELEGIVEL: "Empresa elegível", DESTINATARIO_ELEGIVEL: "Destinatário elegível", HORARIO: "Horário", COOLDOWN: "Cooldown",
  LIMITE_DESTINATARIO_DIA: "Limite do destinatário (dia)", LIMITE_ORGANIZACAO_DIA: "Limite da empresa (dia)", IDEMPOTENCIA: "Idempotência", MENSAGEM_GERADA: "Mensagem gerada",
  ENVIO_BLOQUEADO_PELO_DRY_RUN: "Envio bloqueado pelo dry-run",
});

/** Resultado do DRY-RUN: o motor inteiro, sem efeito (nada criado, provider = 0). */
export function htmlResultadoDryRun(r) {
  if (!r) return "";
  const resumo = r.resumo ?? {};
  const cab = `
    <p>${chip({ classe: "muted", rotulo: "Simulação (dry-run)" })} ${chip({ classe: r.envioRealPermitido ? "ok" : "atencao", rotulo: r.envioRealPermitido ? "Envio real permitido pelo modo global" : "Modo DISABLED: envio real bloqueado" })}</p>
    <p class="padm-form-nota">Nenhum alerta ou mensagem foi criado e o provider não foi chamado. Alertas: ${Number(resumo.alertasDetectados ?? 0)} · destinatários avaliados: ${Number(resumo.destinatariosAvaliados ?? 0)} · elegíveis: ${Number(resumo.destinatariosElegiveis ?? 0)} · mensagens que seriam geradas: <strong>${Number(resumo.mensagensQueSeriamGeradas ?? 0)}</strong> · mensagens realmente enviadas: <strong>0</strong>.</p>`;
  if (!(r.alertas ?? []).length) return `${cab}<p class="padm-vazio">Nenhum alerta detectado agora para esta empresa.</p>`;
  const blocos = r.alertas.map((a) => {
    const d = a.alerta_detectado ?? {};
    const motivos = (a.motivos_empresa ?? []).map((m) => `<li>${OK_ICONE(false)} ${escapeHtml(rotuloMotivo(m))}</li>`).join("");
    const bloqueados = (a.destinatarios_bloqueados ?? []).map((b) => `<li>${OK_ICONE(false)} ${escapeHtml(b.nome)} <span class="padm-mono">${escapeHtml(b.telefone ?? "")}</span> — ${escapeHtml(rotuloMotivo(b.motivo))}</li>`).join("");
    const dests = (a.destinatarios ?? []).filter((x) => x.elegivel).map((x) => `
      <li><strong>${escapeHtml(x.nome)}</strong> <span class="padm-mono">${escapeHtml(x.telefone ?? "")}</span>
        <ol class="padm-etapas">${x.passos.map((p) => `<li class="padm-etapa padm-etapa--${p.ok ? "ok" : "erro"}">${OK_ICONE(p.ok)} <span>${escapeHtml(ROTULO_ETAPA[p.etapa] ?? p.etapa)}${p.detalhe && p.etapa !== "MENSAGEM_GERADA" ? ` — ${escapeHtml(String(p.detalhe))}` : ""}</span></li>`).join("")}</ol>
      </li>`).join("");
    const msgs = (a.mensagens_que_seriam_geradas ?? []).map((m) => `<li>${escapeHtml(m.nome)} · ${dt(m.horarioEstimado)}<p class="padm-preview-texto">${escapeHtml(m.texto)}</p></li>`).join("");
    return `<div class="padm-dryrun-alerta">
      <h4>${escapeHtml(d.unidade ?? "Unidade")} — ${escapeHtml(d.severidade ?? "")} · ref. ${escapeHtml(d.dataReferencia ?? "—")}</h4>
      <p>Empresa elegível: <strong>${a.empresa_elegivel ? "sim" : "não"}</strong> · destinatários: ${Number(a.destinatarios_avaliados)} avaliados, ${Number(a.destinatarios_elegiveis)} elegíveis, ${(a.destinatarios_bloqueados ?? []).length} bloqueados</p>
      ${motivos ? `<ul class="padm-dryrun-motivos">${motivos}</ul>` : ""}
      ${bloqueados ? `<ul class="padm-dryrun-motivos">${bloqueados}</ul>` : ""}
      ${dests ? `<ul class="padm-dryrun-dest">${dests}</ul>` : ""}
      ${msgs ? `<h5>Mensagens que seriam geradas</h5><ul>${msgs}</ul>` : ""}
    </div>`;
  }).join("");
  return `${cab}${blocos}`;
}

/** "Testar sem enviar" (pré-visualização + dry-run, ambos sem efeito) + diagnóstico técnico (variáveis LEGACY do piloto, se ainda existirem). */
export function htmlSimulacaoEDiagnostico(p) {
  const leg = p?.diagnostico?.pilotoLegado;
  return `
    ${grupo({
      titulo: "Testar sem enviar", icone: "eye", resumo: "nada sai pelo WhatsApp",
      corpo: `
        <p class="padm-form-nota">Pré-visualizar mensagem monta o texto exato com dados reais. A simulação roda o motor completo (alerta, destinatários, horário, cooldown, limites e idempotência) sem criar nada. Funciona mesmo com o modo global em DISABLED.</p>
        <div class="padm-form-rodape">
          <button type="button" class="btn btn-ghost btn-sm" data-padm-acao="preview-comunicacao">Pré-visualizar mensagem</button>
          <button type="button" class="btn btn-ghost btn-sm" data-padm-acao="dry-run">Simular envio (dry-run)</button>
        </div>
        <div id="padm-com-preview" class="padm-preview-mensagem"></div>
        <div id="padm-com-dryrun" class="padm-dryrun"></div>`,
    })}
    ${leg?.configurado ? grupo({
      titulo: "Diagnóstico técnico", icone: "settings", resumo: chip({ classe: "muted", rotulo: leg.rotulo }),
      corpo: `<p class="padm-form-nota">As variáveis <code>COMUNICACAO_PILOTO_*</code> ainda existem neste ambiente, mas <strong>não têm efeito</strong> e podem ser removidas em um checkpoint separado.</p>`,
    }) : ""}`;
}
