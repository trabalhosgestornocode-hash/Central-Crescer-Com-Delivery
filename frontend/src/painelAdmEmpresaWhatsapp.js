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

/** Status operacional da empresa (etapa 10): WhatsApp, envio automático, empresa, destinatários, último envio, próximo envio possível. */
export function htmlStatusWhatsappEmpresa(p) {
  if (!p?.status) return "";
  const s = p.status;
  const n = Number(s.destinatariosAtivos ?? 0);
  const linhas = [
    ["WhatsApp", escapeHtml(ROTULO_GATEWAY[s.whatsapp] ?? "—")],
    ["Envio automático", s.envioAutomatico ? "Ativo" : "Desligado"],
    ["Empresa", s.empresaHabilitada ? "Habilitada" : "Desativada"],
    ["Destinatários", `${n} ativo${n === 1 ? "" : "s"}${s.destinatariosTotal > n ? ` (de ${Number(s.destinatariosTotal)})` : ""}`],
    ["Último envio", s.ultimoEnvioEm ? dt(s.ultimoEnvioEm) : "Nenhum envio ainda"],
    ["Próximo envio possível", s.proximoEnvioPossivelEm ? dt(s.proximoEnvioPossivelEm) : "—"],
    ["Envio global (kill switch)", s.envioRealPermitido ? "Permitido" : "Bloqueado — modo DISABLED"],
  ];
  return `
    <p>${chip({ classe: TOM_STATUS[s.codigo] ?? "muted", rotulo: s.rotulo })}${s.motivo ? ` <small>${escapeHtml(s.motivo)}</small>` : ""}</p>
    <dl class="padm-detalhe" data-padm-status-whatsapp>${linhas.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
}

/** Ativar/desativar os avisos da empresa + envio automático (decisões SEPARADAS; ligar exige confirmação). */
export function htmlAlavancasEmpresa(p) {
  if (!p?.status) return "";
  const s = p.status;
  const habilitada = s.empresaHabilitada === true;
  const habil = habilitada
    ? `<p>${chip({ classe: "ok", rotulo: "Avisos pelo WhatsApp ativados" })}</p>
       <button type="button" class="btn btn-ghost btn-sm" data-padm-acao="desabilitar-comunicacao-org">Desativar avisos pelo WhatsApp</button>`
    : `<div class="padm-habilitacao-acao">
         <button type="button" class="btn btn-primary btn-sm" data-padm-acao="pedir-habilitar-comunicacao">Ativar avisos pelo WhatsApp</button>
         <div class="padm-habilitacao-confirmar" hidden>
           <p>Você vai ativar os avisos pelo WhatsApp para esta empresa. Isso <strong>não</strong> liga o envio automático — é uma decisão separada, logo abaixo.</p>
           <div>
             <button type="button" class="btn btn-ghost btn-sm" data-padm-acao="cancelar-habilitar-comunicacao">Cancelar</button>
             <button type="button" class="btn btn-primary btn-sm" data-padm-acao="confirmar-habilitar-comunicacao">Ativar avisos</button>
           </div>
         </div>
       </div>`;
  const auto = !habilitada
    ? `<p class="padm-vazio">Ative os avisos da empresa antes de ligar o envio automático.</p>`
    : s.envioAutomatico
      ? `<p>${chip({ classe: "ok", rotulo: "Envio automático ativado" })}</p>
         <button type="button" class="btn btn-ghost btn-sm" data-padm-acao="desligar-envio-automatico">Desligar envio automático</button>`
      : `<p>${chip({ classe: "muted", rotulo: "Envio automático desligado" })}</p>
         <div class="padm-habilitacao-acao">
           <button type="button" class="btn btn-primary btn-sm" data-padm-acao="pedir-ligar-envio-automatico">Ligar envio automático</button>
           <div class="padm-habilitacao-confirmar" hidden>
             <p>As mensagens desta empresa passarão a ser enviadas automaticamente, dentro do horário comercial, para os destinatários ativos e autorizados, respeitando limites e cooldown. Com o modo global em DISABLED nada é enviado.</p>
             <div>
               <button type="button" class="btn btn-ghost btn-sm" data-padm-acao="cancelar-ligar-envio-automatico">Cancelar</button>
               <button type="button" class="btn btn-primary btn-sm" data-padm-acao="confirmar-ligar-envio-automatico">Ligar envio automático</button>
             </div>
           </div>
         </div>`;
  return `${secao({ titulo: "Avisos pelo WhatsApp", icone: "bell", sub: "Ativar é uma ação do operador, registrada na auditoria. Desativar é sempre permitido.", corpo: habil })}
    ${secao({ titulo: "Envio automático", icone: "send", sub: "Precisa de ação explícita: habilitar a empresa não liga o envio automático.", corpo: auto })}`;
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
  return `
    <li class="padm-dest" data-padm-dest="${id}">
      <div class="padm-dest-topo">
        <strong>${escapeHtml(d.nome)}</strong> <span class="padm-mono">${escapeHtml(d.telefoneMascarado ?? "—")}</span>
        ${chip({ classe: d.ativo ? "ok" : "muted", rotulo: d.ativo ? "Ativo" : "Inativo" })}
        ${chip({ classe: tomWa, rotulo: rotWa })}
        ${d.optOut ? chip({ classe: "critico", rotulo: "Opt-out" }) : ""}
      </div>
      <div class="padm-dest-meta">
        ${escapeHtml(ROTULO_TIPO[d.tipo] ?? d.tipo ?? "")} · Avisos: ${cats.length ? escapeHtml(cats.join(", ")) : "nenhum"}
        · Autorizado em: ${d.autorizadoEm ? dt(d.autorizadoEm) : "—"} · Ativado em: ${d.ativadoEm ? dt(d.ativadoEm) : "—"} · Último envio: ${d.ultimoEnvioEm ? dt(d.ultimoEnvioEm) : "—"}
      </div>
      <div class="padm-dest-acoes">
        <button type="button" class="btn btn-ghost btn-sm" data-padm-dest-acao="ativo" data-padm-dest-id="${id}" data-padm-ativo="${d.ativo ? "0" : "1"}">${d.ativo ? "Desativar" : "Reativar"}</button>
        ${autorizado ? "" : `<button type="button" class="btn btn-ghost btn-sm" data-padm-dest-acao="autorizar" data-padm-dest-id="${id}">Registrar autorização</button>`}
        <button type="button" class="btn btn-ghost btn-sm" data-padm-dest-acao="editar" data-padm-dest-id="${id}">Editar</button>
        ${d.optOut ? "" : `<button type="button" class="btn btn-ghost btn-sm" data-padm-dest-acao="optout" data-padm-dest-id="${id}">Registrar opt-out</button>`}
      </div>
      <form class="padm-form padm-dest-editar" data-padm-dest-form="editar" data-padm-dest-id="${id}" hidden>
        <label>Nome<input type="text" name="nome" value="${escapeHtml(d.nome)}" required /></label>
        <label>Tipo<select name="tipo">${optionsTipo(d.tipo)}</select></label>
        <label>Novo telefone (DDD + número) — só para trocar; a autorização será refeita
          <input type="text" name="telefone" inputmode="tel" placeholder="11 99999-8888" /></label>
        <fieldset><legend>Tipos de aviso</legend>${checksCategorias(categorias, d.categorias, "categorias")}</fieldset>
        <button type="submit" class="btn btn-primary btn-sm">Salvar destinatário</button>
      </form>
    </li>`;
}

/** Destinatários (VÁRIOS por empresa) + formulário de novo destinatário. */
export function htmlDestinatarios(p) {
  if (!p) return "";
  const lista = p.destinatarios ?? [];
  const teto = p.configuracao?.tetoDestinatariosAtivos ?? null;
  const ativos = lista.filter((d) => d.ativo).length;
  const cheio = teto != null && ativos >= teto;
  const cats = p.categoriasDisponiveis ?? [];
  return secao({
    titulo: "Destinatários", icone: "users",
    sub: `Quem recebe os avisos desta empresa — cada um é tratado individualmente (limites, cooldown e idempotência próprios).${teto != null ? ` Até ${teto} ativos por empresa.` : ""}`,
    corpo: `
      ${lista.length ? `<ul class="padm-dest-lista">${lista.map((d) => linhaDestinatario(d, cats)).join("")}</ul>` : `<p class="padm-vazio">Nenhum destinatário cadastrado.</p>`}
      <form class="padm-form" data-padm-dest-form="novo">
        <h4>Adicionar destinatário</h4>
        <label>Nome<input type="text" name="nome" required /></label>
        <label>Código do país<input type="text" name="ddi" value="55" inputmode="numeric" pattern="[0-9]{1,3}" /></label>
        <label>Telefone (DDD + número)<input type="text" name="telefone" inputmode="tel" placeholder="11 99999-8888" required /></label>
        <label>Tipo<select name="tipo">${optionsTipo("secundario")}</select></label>
        <fieldset><legend>Tipos de aviso</legend>${checksCategorias(cats, cats.map((c) => c.codigo), "categorias")}</fieldset>
        <label>Observações<input type="text" name="observacoes" /></label>
        <button type="submit" class="btn btn-primary btn-sm" ${cheio ? "disabled" : ""}>Adicionar destinatário</button>
        <p class="padm-form-nota">${cheio ? "Limite de destinatários ativos atingido — desative um antes de adicionar." : "O destinatário só recebe depois de a autorização (consentimento) ser registrada. Nada é enviado ao salvar."}</p>
      </form>`,
  });
}

/** Alertas recentes com a ENTREGA por destinatário: uma entrega parcial nunca fica escondida atrás do status "enviado" do alerta. */
export function htmlAlertasRecentes(p) {
  const lista = p?.alertasRecentes ?? [];
  if (!p) return "";
  const cont = (e) => [
    ["previstos", e.previstos], ["enviados", e.enviados], ["pendentes", e.pendentes], ["entrega incerta", e.entregaIncerta],
    ["falha permanente", e.falhaPermanente], ["opt-out", e.optOut], ["bloqueados", e.bloqueados], ["expirados", e.expirados],
  ].filter(([r, n]) => n > 0 || r === "previstos" || r === "enviados").map(([r, n]) => `${n} ${r}`).join(" · ");
  const alerta = (e) => e.situacao === "PARCIAL" || e.situacao === "PARCIAL_EM_ANDAMENTO" || e.situacao === "SEM_ENTREGA" || e.situacao === "INCERTA";
  return secao({
    titulo: "Alertas recentes", icone: "bell",
    sub: "Entrega por destinatário. O status do alerta não muda por uma falha individual; aqui aparece o que cada pessoa recebeu.",
    corpo: lista.length ? `<ul class="padm-alertas-recentes">${lista.map((a) => `
      <li data-situacao="${escapeHtml(a.entrega.situacao)}">
        <strong>${escapeHtml(a.tipo)} · ${escapeHtml(a.dataReferencia)}</strong>
        <span class="padm-chip${alerta(a.entrega) ? " padm-chip-alerta" : ""}">${escapeHtml(a.entrega.rotulo)}</span>
        <small>${escapeHtml(cont(a.entrega))}</small>
      </li>`).join("")}</ul>` : `<p class="padm-vazio">Nenhum alerta ainda.</p>`,
  });
}

/** Limites por empresa: por destinatário × por empresa (em branco = padrão global). */
export function htmlLimitesEmpresa(p) {
  const l = p?.configuracao?.limites;
  if (!l) return "";
  const g = l.padraoGlobal ?? {};
  return secao({
    titulo: "Limites", icone: "settings",
    sub: "Dois limites distintos: por destinatário (cota diária e cooldown) e por empresa (todos os destinatários somados). Em branco = padrão global.",
    corpo: `
      <p class="padm-form-nota">Padrão global: até ${g.maxPorDestinatarioPorDia ?? "—"} mensagens por destinatário/dia · até ${g.maxPorOrganizacaoPorDia ?? "—"} por empresa/dia.</p>
      <form id="padm-com-limites-form" class="padm-form">
        <label>Limite diário da EMPRESA (mensagens)<input type="number" min="1" name="limiteDiarioOrg" value="${l.limiteDiarioOrg ?? ""}" placeholder="padrão" /></label>
        <label>Cooldown por DESTINATÁRIO (minutos)<input type="number" min="1" name="cooldownMinutos" value="${l.cooldownMinutos ?? ""}" placeholder="padrão" /></label>
        <button type="submit" class="btn btn-primary btn-sm">Salvar limites</button>
      </form>`,
  });
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

/** Simulação + diagnóstico técnico (variáveis LEGACY do piloto, se ainda existirem). */
export function htmlSimulacaoEDiagnostico(p) {
  const leg = p?.diagnostico?.pilotoLegado;
  return `
    ${secao({
      titulo: "Simulação (dry-run)", icone: "eye",
      sub: "Roda o motor completo — alerta, empresa, destinatários, horário, cooldown, limites, idempotência e mensagem — SEM criar nada e SEM chamar o WhatsApp. Funciona mesmo com o modo global em DISABLED.",
      corpo: `<button type="button" class="btn btn-ghost btn-sm" data-padm-acao="dry-run">Simular envio (dry-run)</button>
              <div id="padm-com-dryrun" class="padm-dryrun"></div>`,
    })}
    ${leg?.configurado ? secao({
      titulo: "Diagnóstico técnico", icone: "settings",
      corpo: `<p>${chip({ classe: "muted", rotulo: leg.rotulo })} As variáveis <code>COMUNICACAO_PILOTO_*</code> ainda existem neste ambiente, mas <strong>não têm efeito</strong> e podem ser removidas em um checkpoint separado.</p>`,
    }) : ""}`;
}
