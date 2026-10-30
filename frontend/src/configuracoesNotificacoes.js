// Central de Notificações (Configurações 2.0 → Notificações).
//
// O gestor CONVIDA, suspende, restringe preferências e registra pedidos de revogação — nunca consente nem reativa uma
// revogação pelo titular (D-3): isso só acontece na página pública do titular, com código de verificação.
// Os destinatários que já recebiam o D-1 aparecem como "configuração anterior" (LEGACY_ACTIVE): nada é exigido deles.
// O recorte (empresa inteira ou só a unidade do gestor) vem do servidor; esta tela só esconde o que ele recusaria.
// Números aparecem sempre mascarados. Nesta versão o envio de códigos é SIMULADO — a tela diz isso explicitamente.
import { escapeHtml, toast } from "./utils.js";
import { icon } from "./icons.js";
import { pode } from "./sessao.js";
import {
  notificacoesResumo, notificacoesCategorias, notificacoesDestinatarios, notificacoesHistorico, notificacoesConsentimentos,
  notificacoesAuditoria, notificacoesConvidar, notificacoesCancelarConvite, notificacoesSuspender, notificacoesVincularLegado,
  notificacoesPedidoRevogacao, notificacoesPreferencias,
} from "./api.js";

const CATEGORIA_D1 = "pendencia_d1";

const ESTADO_DEST = {
  LEGACY_ACTIVE: ["ok", "Ativo — configuração anterior"],
  ATIVO: ["ok", "Ativo"],
  VERIFICADO_SEM_CONSENTIMENTO: ["warn", "Verificado, sem consentimento"],
  SUSPENSO: ["muted", "Suspenso"],
  REVOGADO: ["bad", "Revogado pelo titular"],
};
const ESTADO_CONVITE = {
  PENDENTE_VERIFICACAO: ["warn", "Aguardando verificação"],
  VERIFICADO_SEM_CONSENTIMENTO: ["warn", "Verificado, sem consentimento"],
  EXPIRADO: ["muted", "Expirado"],
  CONCLUIDO: ["ok", "Concluído"],
  CANCELADO: ["muted", "Cancelado"],
};
const TIPOS = [["operacional", "Operacional"], ["principal", "Principal"], ["secundario", "Secundário"], ["financeiro", "Financeiro"]];
const STATUS_ENVIO = { SCHEDULED: "Agendada", PROCESSING: "Enviando", SENT: "Enviada", DELIVERED: "Entregue", READ: "Lida", FAILED: "Falhou",
  CANCELLED: "Cancelada", BLOCKED: "Bloqueada", SIMULADA: "Simulada", SIMULADO: "Simulada" };
const ACAO_AUDITORIA = {
  "notificacao.convite_criado": "Convite criado", "notificacao.convite_cancelado": "Convite cancelado",
  "notificacao.escopo_suspenso": "Recebimento suspenso", "notificacao.escopo_reativado": "Recebimento reativado",
  "notificacao.escopo_alterado": "Preferências alteradas", "notificacao.vinculo_legado_incluido": "Unidade vinculada (D-1)",
  "notificacao.revogacao_registrada": "Pedido de revogação registrado", "notificacao.titular_verificou_numero": "Titular verificou o número",
  "notificacao.titular_consentiu": "Consentimento do titular", "notificacao.titular_revogou": "Revogação pelo titular",
  "notificacao.selecao_por_escopo_ativada": "Seleção por unidade ativada", "notificacao.selecao_por_escopo_desativada": "Seleção por unidade desativada",
};

const pill = ([tom, txt]) => `<span class="pill ${tom}">${escapeHtml(txt)}</span>`;
const dataHora = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const painel = (titulo, corpo, sub = "") =>
  `<section class="cfg-panel"><div class="cfg-panel-head"><h3>${escapeHtml(titulo)}</h3>${sub ? `<p>${escapeHtml(sub)}</p>` : ""}</div><div class="cfg-panel-body">${corpo}</div></section>`;
const vazio = (txt) => `<div class="estado-mini">${escapeHtml(txt)}</div>`;

const ABAS = [
  ["destinatarios", "Destinatários", "users"],
  ["convites", "Convites", "send"],
  ["historico", "Histórico", "history"],
  ["consentimentos", "Consentimentos", "shield-check"],
  ["auditoria", "Auditoria", "file-text"],
];

/**
 * Monta a Central em `root`. `ctx.confirmarDialogo` e `ctx.carregarProtegido` vêm de configuracoes.js (mesmo diálogo e
 * mesma proteção contra troca de contexto no meio do carregamento).
 */
export function montarCentralNotificacoes(root, ctx) {
  const { confirmarDialogo, carregarProtegido } = ctx;
  const st = { aba: "destinatarios", resumo: null, categorias: [], dados: null, aberto: null, linkUnico: null };
  const gerencia = () => pode("notificacoes.gerenciar") && st.resumo?.podeGerenciar !== false;
  const nomeUnidade = (id) => st.resumo?.unidades?.find((u) => u.id === id)?.nome ?? "Unidade";

  if (!pode("notificacoes.ver")) {
    root.innerHTML = painel("Central de Notificações", vazio("Você não tem acesso às notificações desta empresa."));
    return;
  }
  root.innerHTML = `<div class="cfg-panel"><div class="cfg-panel-body"><div class="estado" role="status"><div class="spinner"></div>Carregando a Central…</div></div></div>`;
  iniciar();

  async function iniciar() {
    try {
      const [r, c] = await Promise.all([carregarProtegido(notificacoesResumo), carregarProtegido(notificacoesCategorias)]);
      if (r === null || c === null) return;
      st.resumo = r.data; st.categorias = c.data ?? [];
      await carregarAba();
    } catch (e) {
      root.innerHTML = painel("Central de Notificações", `<div class="estado-mini bad" role="alert">Não foi possível carregar: ${escapeHtml(e.message)}</div>`);
    }
  }

  async function carregarAba() {
    const fonte = { destinatarios: notificacoesDestinatarios, convites: notificacoesDestinatarios, historico: () => notificacoesHistorico(),
      consentimentos: notificacoesConsentimentos, auditoria: notificacoesAuditoria }[st.aba];
    desenhar(`<div class="estado" role="status"><div class="spinner"></div>Carregando…</div>`);
    try {
      const r = await carregarProtegido(fonte);
      if (r === null) return;
      st.dados = r.data;
      desenhar(conteudoDaAba());
    } catch (e) {
      desenhar(`<div class="estado-mini bad" role="alert">Não foi possível carregar: ${escapeHtml(e.message)}</div>`);
    }
  }

  // ---------- moldura: avisos + abas ----------
  function avisos() {
    const r = st.resumo ?? {};
    const itens = [];
    if (r.disponivel === false) itens.push(["warn", "A Central ainda não está habilitada neste ambiente: dá para consultar, mas convites e revogações registradas ficam indisponíveis."]);
    if (r.transporte?.simulado) itens.push(["info", "Modo de simulação: os códigos de verificação NÃO são enviados por WhatsApp. Nenhum número convidado aqui está verificado de verdade."]);
    else if (r.transporte && !r.transporte.envioReal) itens.push(["info", "O envio de códigos de verificação ainda está desligado: convites podem ser criados, mas o titular não recebe o código."]);
    itens.push(["info", r.selecaoPorEscopo
      ? "Seleção por unidade ATIVA: cada destinatário recebe o D-1 só das unidades vinculadas."
      : "Até a ativação da seleção por unidade, quem já recebia o Dashboard iFood D-1 continua recebendo de todas as unidades da empresa, como antes."]);
    const pend = (r.pendencias ?? []).map((p) => `<li>${icon("alert-triangle", { size: 14 })} <b>${escapeHtml(p.unidadeNome)}</b>: ${escapeHtml(p.texto)}</li>`).join("");
    return `<div class="ntf-avisos">${itens.map(([tom, txt]) => `<p class="ntf-aviso ntf-aviso--${tom}">${icon(tom === "warn" ? "alert-triangle" : "info", { size: 14 })} ${escapeHtml(txt)}</p>`).join("")}
      ${pend ? `<ul class="ntf-pendencias" role="list" aria-label="Pendências">${pend}</ul>` : ""}</div>`;
  }

  function desenhar(corpo) {
    root.innerHTML = `${avisos()}
      <div class="ntf-abas" role="tablist" aria-label="Seções da Central">${ABAS
        .filter(([id]) => id !== "auditoria" || gerencia())
        .map(([id, rot, ic]) => `<button type="button" role="tab" id="ntf-aba-${id}" aria-controls="ntf-painel" aria-selected="${st.aba === id}" tabindex="${st.aba === id ? 0 : -1}" class="ntf-aba${st.aba === id ? " ativo" : ""}" data-aba="${id}">${icon(ic, { size: 14 })} ${rot}</button>`).join("")}</div>
      <div class="ntf-painel" id="ntf-painel" role="tabpanel" aria-labelledby="ntf-aba-${st.aba}">${corpo}</div>`;
    const abas = [...root.querySelectorAll("[data-aba]")];
    abas.forEach((b) => b.addEventListener("click", () => trocarAba(b.dataset.aba)));
    root.querySelector(".ntf-abas")?.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
      const i = abas.findIndex((b) => b.dataset.aba === st.aba);
      const prox = abas[(i + (ev.key === "ArrowRight" ? 1 : abas.length - 1)) % abas.length];
      trocarAba(prox.dataset.aba, true);
    });
    ligarAcoes();
  }

  function trocarAba(aba, focar = false) {
    if (aba === st.aba) return;
    st.aba = aba; st.aberto = null; st.linkUnico = null;
    carregarAba().then(() => { if (focar) root.querySelector(`#ntf-aba-${aba}`)?.focus(); });
  }

  function conteudoDaAba() {
    switch (st.aba) {
      case "destinatarios": return abaDestinatarios();
      case "convites": return abaConvites();
      case "historico": return abaHistorico();
      case "consentimentos": return abaConsentimentos();
      default: return abaAuditoria();
    }
  }

  // ---------- Destinatários ----------
  function abaDestinatarios() {
    const lista = st.dados?.destinatarios ?? [];
    const cab = gerencia() ? `<div class="cfg-acoes cfg-acoes--start"><button type="button" class="btn btn-primary" data-novo-convite>${icon("send", { size: 14 })} Convidar destinatário</button></div>` : "";
    return painel("Quem recebe os avisos", cab + (lista.length ? `<ul class="ntf-lista" role="list">${lista.map(itemDestinatario).join("")}</ul>`
      : vazio("Nenhum destinatário nesta visão.")),
    "Cada pessoa autoriza o próprio número; você escolhe as unidades e os avisos que ela pode receber.");
  }

  function itemDestinatario(d) {
    const aberto = st.aberto === d.id;
    const origem = d.origem === "LEGACY_ACTIVE"
      ? `<span class="pill" title="Já recebia o D-1 antes da Central. Autorização anterior${d.autorizacaoAnteriorEm ? ` registrada em ${dataHora(d.autorizacaoAnteriorEm)}` : ""}.">Configuração anterior</span>`
      : d.origem === "CONVITE_OTP" ? `<span class="pill">Convite verificado</span>` : "";
    const vinculos = d.configuracaoAnteriorTodasUnidades && !d.vinculos.length
      ? `<p class="cfg-meta">Recebe o Dashboard iFood D-1 de todas as unidades da empresa (configuração anterior).</p>`
      : (d.vinculos.length ? `<ul class="ntf-vinculos" role="list">${d.vinculos.map((v) => linhaVinculo(d, v)).join("")}</ul>` : `<p class="cfg-meta">Sem unidades vinculadas.</p>`);
    return `<li class="ntf-dest${aberto ? " aberto" : ""}">
      <div class="ntf-dest-cab">
        <span class="cfg-user-av" aria-hidden="true">${escapeHtml((d.nome?.[0] ?? "?").toUpperCase())}</span>
        <div class="cfg-user-info"><b>${escapeHtml(d.nome ?? "—")}</b><small>${escapeHtml(d.telefoneMascarado ?? "")} · ${escapeHtml(TIPOS.find(([k]) => k === d.tipo)?.[1] ?? d.tipo ?? "")}</small></div>
        ${origem}${pill(ESTADO_DEST[d.estado] ?? ["muted", d.estado])}
        ${d.compartilhadoComOutrasUnidades ? `<span class="pill" title="Também recebe avisos de outras unidades; você vê e altera só o vínculo da sua unidade.">Compartilhado</span>` : ""}
        <button type="button" class="btn btn-ghost btn-sm" data-abrir="${escapeHtml(d.id)}" aria-expanded="${aberto}">${aberto ? "Fechar" : "Detalhes"}</button>
      </div>
      ${aberto ? `<div class="ntf-dest-corpo">${vinculos}${acoesDestinatario(d)}</div>` : ""}
    </li>`;
  }

  function linhaVinculo(d, v) {
    const pode = gerencia();
    const estado = v.suspenso ? ["muted", "Suspenso"] : !v.habilitado ? ["muted", "Desligado"] : v.consentimento === "REVOGADO" ? ["bad", "Revogado"] : ["ok", "Recebendo"];
    const pref = [v.janela ? `envio ${v.janela.inicio}–${v.janela.fim}` : null, v.silencio ? `silêncio ${v.silencio.inicio}–${v.silencio.fim}` : null,
      v.categoria !== CATEGORIA_D1 ? (v.notificarCorrecao ? "avisa correções" : "sem aviso de correção") : null].filter(Boolean).join(" · ");
    const chave = `${escapeHtml(d.id)}|${escapeHtml(v.unidadeId)}|${escapeHtml(v.categoria)}`;
    return `<li class="ntf-vinculo">
      <span><b>${escapeHtml(v.unidadeNome)}</b>${v.transferida ? " (unidade transferida)" : ""} · ${escapeHtml(v.categoriaRotulo)}${v.simulado ? ` <span class="pill warn" title="Verificado em simulação: não vale como verificação real">Simulado</span>` : ""}
        ${pref ? `<small>${escapeHtml(pref)}</small>` : ""}${v.suspensoMotivo ? `<small>Motivo: ${escapeHtml(v.suspensoMotivo)}</small>` : ""}</span>
      ${pill(estado)}
      ${pode && v.consentimento !== "REVOGADO" ? `<span class="ntf-vinculo-acoes">
        <button type="button" class="btn btn-ghost btn-sm" data-suspender="${chave}" data-suspenso="${v.suspenso ? 1 : 0}">${v.suspenso ? "Reativar" : "Suspender"}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-preferencias="${chave}">Preferências</button></span>` : ""}
    </li>`;
  }

  function acoesDestinatario(d) {
    if (!gerencia()) return "";
    const botoes = [];
    if (d.estado !== "REVOGADO") botoes.push(`<button type="button" class="btn btn-ghost btn-sm" data-aderir="${escapeHtml(d.id)}">${icon("send", { size: 14 })} Convidar para novos avisos</button>`);
    if (d.origem === "LEGACY_ACTIVE" && st.resumo?.selecaoPorEscopo) botoes.push(`<button type="button" class="btn btn-ghost btn-sm" data-vincular="${escapeHtml(d.id)}">${icon("link", { size: 14 })} Vincular a uma unidade (D-1)</button>`);
    if (d.estado !== "REVOGADO") botoes.push(`<button type="button" class="btn btn-ghost btn-sm cfg-btn-perigo" data-revogacao="${escapeHtml(d.id)}">Registrar pedido de revogação</button>`);
    return `<div class="cfg-acoes cfg-acoes--start ntf-dest-acoes">${botoes.join("")}</div><div data-form-dest="${escapeHtml(d.id)}"></div>`;
  }

  // ---------- Convites ----------
  function abaConvites() {
    const lista = st.dados?.convites ?? [];
    const form = gerencia() ? painel("Novo convite", formularioConvite(),
      "A pessoa recebe um link (válido por 72 horas), confirma o número com um código e escolhe o que aceita receber.") : "";
    const link = st.linkUnico ? painel("Link do convite", `
      <p class="cfg-meta">${icon("alert-triangle", { size: 14 })} Este link aparece <b>só agora</b>. Copie e envie à pessoa por um canal seu. Quem tiver o link consegue iniciar a verificação do número convidado.</p>
      <div class="ntf-link"><input id="ntf-link-unico" readonly value="${escapeHtml(st.linkUnico.link)}" aria-label="Link do convite" />
        <button type="button" class="btn btn-primary btn-sm" data-copiar>${icon("copy", { size: 14 })} Copiar</button></div>
      <p class="cfg-meta">Para ${escapeHtml(st.linkUnico.telefoneMascarado)} · expira em ${dataHora(st.linkUnico.expiraEm)}</p>`) : "";
    return link + form + painel("Convites enviados", lista.length ? `<ul class="ntf-lista" role="list">${lista.map((c) => `
      <li class="ntf-convite"><div class="cfg-user-info"><b>${escapeHtml(c.nome)}</b><small>${escapeHtml(c.telefoneMascarado)} · ${escapeHtml(c.unidades.join(", "))} · ${escapeHtml(c.categorias.join(", "))}</small>
        <small>Criado em ${dataHora(c.criadoEm)} · expira em ${dataHora(c.expiraEm)}</small></div>
        ${c.simulado ? `<span class="pill warn">Simulação</span>` : ""}${pill(ESTADO_CONVITE[c.estado] ?? ["muted", c.estado])}
        ${gerencia() && (c.estado === "PENDENTE_VERIFICACAO" || c.estado === "VERIFICADO_SEM_CONSENTIMENTO") ? `<button type="button" class="btn btn-ghost btn-sm" data-cancelar-convite="${escapeHtml(c.id)}">Cancelar</button>` : ""}
      </li>`).join("")}</ul>` : vazio("Nenhum convite ainda."));
  }

  function formularioConvite(destinatario = null) {
    const unidades = st.resumo?.unidades ?? [];
    const cats = st.categorias.filter((c) => c.selecionavel);
    const emBreve = st.categorias.filter((c) => !c.selecionavel);
    const unicaUnidade = st.resumo?.recorte === "unidade" || unidades.length === 1;
    return `<form class="ntf-form" data-form-convite="${destinatario ? escapeHtml(destinatario.id) : ""}" novalidate>
      <div class="cfg-form-grid">
        ${destinatario ? `<div class="cfg-campo"><span>Destinatário</span><b class="cfg-campo-fixo">${escapeHtml(destinatario.nome)} · ${escapeHtml(destinatario.telefoneMascarado)}</b></div>` : `
        <label class="cfg-campo" for="ntf-nome"><span>Nome</span><input id="ntf-nome" maxlength="120" autocomplete="off" required aria-describedby="ntf-nome-erro"/><small class="cfg-erro" id="ntf-nome-erro" role="alert"></small></label>
        <label class="cfg-campo" for="ntf-tel"><span>WhatsApp</span><input id="ntf-tel" inputmode="tel" autocomplete="off" placeholder="(00) 00000-0000" required aria-describedby="ntf-tel-ajuda ntf-tel-erro"/>
          <small class="cfg-ajuda" id="ntf-tel-ajuda">Com DDD. De fora do Brasil, comece com +DDI.</small><small class="cfg-erro" id="ntf-tel-erro" role="alert"></small></label>
        <label class="cfg-campo" for="ntf-tipo"><span>Papel</span><select id="ntf-tipo">${TIPOS.map(([k, r]) => `<option value="${k}">${r}</option>`).join("")}</select></label>`}
      </div>
      <fieldset class="ntf-escolha"><legend>Unidades</legend>${unidades.map((u) => `
        <label class="cfg-check"><input type="checkbox" name="ntf-un" value="${escapeHtml(u.id)}" ${unicaUnidade ? "checked disabled" : ""}/> ${escapeHtml(u.nome)}</label>`).join("") || vazio("Nenhuma unidade disponível.")}
        <small class="cfg-erro" id="ntf-un-erro" role="alert"></small></fieldset>
      <fieldset class="ntf-escolha"><legend>Avisos</legend>${cats.map((c) => `
        <label class="cfg-check"><input type="checkbox" name="ntf-cat" value="${escapeHtml(c.codigo)}"/> <span><b>${escapeHtml(c.rotulo)}</b>${c.simulacao ? ` <span class="pill warn">Simulação</span>` : ""}${c.descricao ? `<small>${escapeHtml(c.descricao)}</small>` : ""}</span></label>`).join("")}
        ${emBreve.length ? `<p class="cfg-meta">Em breve: ${emBreve.map((c) => escapeHtml(c.rotulo)).join(", ")}.</p>` : ""}
        <small class="cfg-erro" id="ntf-cat-erro" role="alert"></small></fieldset>
      <div class="cfg-acoes cfg-acoes--start">
        ${destinatario ? `<button type="button" class="btn btn-ghost" data-fechar-form>Cancelar</button>` : ""}
        <button type="submit" class="btn btn-primary" ${st.resumo?.disponivel === false ? "disabled" : ""}>Gerar convite</button></div>
    </form>`;
  }

  async function enviarConvite(form) {
    for (const e of form.querySelectorAll(".cfg-erro")) e.textContent = "";
    const destinatarioId = form.dataset.formConvite || null;
    const marcados = (nome) => [...form.querySelectorAll(`input[name="${nome}"]:checked`)].map((i) => i.value);
    const corpo = { unidades: marcados("ntf-un"), categorias: marcados("ntf-cat") };
    if (destinatarioId) {
      const d = st.dados?.destinatarios?.find((x) => x.id === destinatarioId);
      Object.assign(corpo, { destinatarioId, nome: d?.nome ?? "Destinatário", tipo: d?.tipo ?? "operacional" });
    } else {
      Object.assign(corpo, { nome: form.querySelector("#ntf-nome").value.trim(), telefone: form.querySelector("#ntf-tel").value.trim(), tipo: form.querySelector("#ntf-tipo").value });
      if (!corpo.nome) return erro(form, "ntf-nome", "Informe o nome.");
      if (corpo.telefone.replace(/\D/g, "").length < 10) return erro(form, "ntf-tel", "Informe o WhatsApp com DDD.");
    }
    if (!corpo.unidades.length) return erro(form, "ntf-un", "Escolha ao menos uma unidade.");
    if (!corpo.categorias.length) return erro(form, "ntf-cat", "Escolha ao menos um aviso.");
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const { data } = await notificacoesConvidar(corpo);
      st.linkUnico = data;
      st.aba = "convites";
      await carregarAba();
      root.querySelector("#ntf-link-unico")?.focus();
    } catch (e) {
      if (e?.codigo === "TELEFONE_INVALIDO" || /WhatsApp/.test(e.message)) erro(form, "ntf-tel", e.message);
      else toast("Erro: " + e.message);
      btn.disabled = false;
    }
  }

  function erro(form, id, msg) {
    const alvo = form.querySelector(`#${id}-erro`);
    if (alvo) alvo.textContent = msg;
    form.querySelector(`#${id}`)?.focus();
    form.querySelector(`input[name="${id}"]`)?.focus();
  }

  // ---------- Histórico / Consentimentos / Auditoria ----------
  function abaHistorico() {
    const nomes = new Map((st.dados?.destinatarios ?? []).map((d) => [d.id, d.nome]));
    const reais = st.dados?.reais ?? [];
    const sim = st.dados?.simuladas ?? [];
    const tabela = (linhas, cols) => `<div class="ntf-tabela-wrap"><table class="ntf-tabela"><thead><tr>${cols.map((c) => `<th scope="col">${c}</th>`).join("")}</tr></thead><tbody>${linhas}</tbody></table></div>`;
    return painel("Mensagens enviadas (Dashboard iFood D-1)", reais.length ? tabela(reais.map((m) => `<tr>
        <td>${dataHora(m.criadoEm)}</td><td>${escapeHtml(nomeUnidade(m.unidadeId))}</td><td>${escapeHtml(m.proposito === "correcao" ? "Correção" : "Aviso")}</td>
        <td>${escapeHtml(STATUS_ENVIO[m.status] ?? m.status)}${m.erro ? `<small>${escapeHtml(m.erro)}</small>` : ""}</td></tr>`).join(""), ["Quando", "Unidade", "Tipo", "Situação"])
      : vazio("Nenhuma mensagem no período."), "Sem conteúdo das mensagens nem números completos.")
      + painel("Avisos simulados (fechamento diário)", sim.length ? tabela(sim.map((s) => `<tr>
        <td>${dataHora(s.criadoEm)}</td><td>${escapeHtml(nomeUnidade(s.unidadeId))}</td><td>${s.proposito === "correcao" ? "Correção" : "Fechamento"} · v${escapeHtml(String(s.versao ?? 1))}</td>
        <td>${escapeHtml(STATUS_ENVIO[s.status] ?? s.status)}</td></tr>`).join(""), ["Quando", "Unidade", "Fechamento", "Situação"])
        : vazio("Nenhum aviso simulado."), "Simulação: nada foi enviado por WhatsApp e nenhuma cota foi consumida.");
  }

  function abaConsentimentos() {
    const lista = Array.isArray(st.dados) ? st.dados : [];
    const rot = new Map(st.categorias.map((c) => [c.codigo, c.rotulo]));
    return painel("Registro de consentimentos", lista.length ? `<ul class="ntf-lista" role="list">${lista.map((l) => `
      <li class="ntf-registro">${pill(l.acao === "CONCEDIDO" ? ["ok", "Concedido"] : l.acao === "REVOGADO" ? ["bad", "Revogado"] : ["muted", l.acao])}
        <span><b>${escapeHtml(rot.get(l.categoria) ?? l.categoria)}</b><small>${dataHora(l.em)} · ${escapeHtml(origemTxt(l.origem))}${l.termoVersao ? ` · termo v${escapeHtml(String(l.termoVersao))}` : ""}</small></span>
        ${l.simulado ? `<span class="pill warn">Simulado</span>` : ""}</li>`).join("")}</ul>` : vazio("Nenhum consentimento registrado."),
    "Registro imutável: só o titular concede; a revogação vale na hora.");
  }
  const origemTxt = (o) => ({ link_convite_otp: "pelo titular, com código", pagina_gestao_otp: "pelo titular, na página de gestão", palavra_chave_inbound: "pelo titular, por palavra-chave",
    pedido_registrado_gestor: "pedido do titular registrado pelo gestor" }[o] ?? o ?? "—");

  function abaAuditoria() {
    const lista = Array.isArray(st.dados) ? st.dados : [];
    return painel("Auditoria da Central", lista.length ? `<ul class="ntf-lista" role="list">${lista.map((l) => `
      <li class="ntf-registro"><span><b>${escapeHtml(ACAO_AUDITORIA[l.acao] ?? l.acao)}</b><small>${dataHora(l.em)}${l.detalhes?.motivo ? ` · ${escapeHtml(l.detalhes.motivo)}` : ""}${l.detalhes?.telefone_mascarado ? ` · ${escapeHtml(l.detalhes.telefone_mascarado)}` : ""}${l.detalhes?.mensagens_canceladas ? ` · ${l.detalhes.mensagens_canceladas} mensagem(ns) cancelada(s)` : ""}</small></span></li>`).join("")}</ul>`
      : vazio("Nenhuma ação registrada."));
  }

  // ---------- ações ----------
  function ligarAcoes() {
    root.querySelectorAll("[data-abrir]").forEach((b) => b.addEventListener("click", () => {
      st.aberto = st.aberto === b.dataset.abrir ? null : b.dataset.abrir;
      desenhar(conteudoDaAba());
      root.querySelector(`[data-abrir="${b.dataset.abrir}"]`)?.focus();
    }));
    root.querySelector("[data-novo-convite]")?.addEventListener("click", () => trocarAba("convites"));
    root.querySelectorAll("form[data-form-convite]").forEach((f) => f.addEventListener("submit", (ev) => { ev.preventDefault(); enviarConvite(f); }));
    root.querySelector("[data-copiar]")?.addEventListener("click", async () => {
      const campo = root.querySelector("#ntf-link-unico");
      try { await navigator.clipboard.writeText(campo.value); toast("Link copiado."); }
      catch { campo.select(); toast("Selecione e copie o link."); }
    });
    root.querySelectorAll("[data-cancelar-convite]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await confirmarDialogo({ titulo: "Cancelar convite?", texto: "O link deixa de funcionar na hora. Nada muda para quem já recebe avisos.", confirmar: "Cancelar convite", perigo: true }))) return;
      try { await notificacoesCancelarConvite(b.dataset.cancelarConvite); toast("Convite cancelado."); carregarAba(); } catch (e) { toast("Erro: " + e.message); }
    }));
    root.querySelectorAll("[data-suspender]").forEach((b) => b.addEventListener("click", () => alternarSuspensao(b)));
    root.querySelectorAll("[data-preferencias]").forEach((b) => b.addEventListener("click", () => abrirPreferencias(b.dataset.preferencias)));
    root.querySelectorAll("[data-aderir]").forEach((b) => b.addEventListener("click", () => {
      const d = st.dados.destinatarios.find((x) => x.id === b.dataset.aderir);
      const alvo = root.querySelector(`[data-form-dest="${b.dataset.aderir}"]`);
      alvo.innerHTML = formularioConvite(d);
      const f = alvo.querySelector("form");
      f.addEventListener("submit", (ev) => { ev.preventDefault(); enviarConvite(f); });
      f.querySelector("[data-fechar-form]")?.addEventListener("click", () => { alvo.innerHTML = ""; b.focus(); });
      f.querySelector("input")?.focus();
    }));
    root.querySelectorAll("[data-vincular]").forEach((b) => b.addEventListener("click", () => abrirVinculo(b.dataset.vincular)));
    root.querySelectorAll("[data-revogacao]").forEach((b) => b.addEventListener("click", () => abrirRevogacao(b.dataset.revogacao)));
  }

  const separar = (chave) => { const [id, unidadeId, categoria] = chave.split("|"); return { id, unidadeId, categoria }; };

  async function alternarSuspensao(b) {
    const { id, unidadeId, categoria } = separar(b.dataset.suspender);
    const suspender = b.dataset.suspenso !== "1";
    let motivo = null;
    if (suspender) {
      const ok = await confirmarDialogo({ titulo: "Suspender o recebimento?",
        texto: `Os avisos desta categoria para ${nomeUnidade(unidadeId)} param agora, e as mensagens ainda na fila são canceladas. O consentimento do titular continua válido; dá para reativar depois.`,
        confirmar: "Suspender", perigo: true });
      if (!ok) return;
      motivo = "Suspenso pelo gestor";
    }
    try {
      const { data } = await notificacoesSuspender(id, { unidadeId, categoria, suspender, motivo });
      toast(suspender ? `Suspenso.${data?.mensagens_canceladas ? ` ${data.mensagens_canceladas} mensagem(ns) da fila cancelada(s).` : ""}` : "Reativado.");
      carregarAba();
    } catch (e) { toast("Erro: " + e.message); }
  }

  function abrirPreferencias(chave) {
    const { id, unidadeId, categoria } = separar(chave);
    const d = st.dados.destinatarios.find((x) => x.id === id);
    const v = d?.vinculos.find((x) => x.unidadeId === unidadeId && x.categoria === categoria);
    const alvo = root.querySelector(`[data-form-dest="${id}"]`);
    if (!alvo || !v) return;
    alvo.innerHTML = `<form class="ntf-form" novalidate>
      <h4>Preferências — ${escapeHtml(v.unidadeNome)} · ${escapeHtml(v.categoriaRotulo)}</h4>
      <p class="cfg-meta">Você só pode restringir: limitar horários ou desligar este aviso. Ligar algo que o titular não autorizou não é possível.</p>
      <div class="cfg-form-grid">
        <label class="cfg-campo-inline">Enviar a partir de <input type="time" name="ji" value="${escapeHtml(v.janela?.inicio ?? "")}"/></label>
        <label class="cfg-campo-inline">até <input type="time" name="jf" value="${escapeHtml(v.janela?.fim ?? "")}"/></label>
        <label class="cfg-campo-inline">Silêncio de <input type="time" name="si" value="${escapeHtml(v.silencio?.inicio ?? "")}"/></label>
        <label class="cfg-campo-inline">até <input type="time" name="sf" value="${escapeHtml(v.silencio?.fim ?? "")}"/></label>
      </div>
      ${v.categoria !== CATEGORIA_D1 ? `<label class="cfg-check"><input type="checkbox" name="corr" ${v.notificarCorrecao ? "checked" : ""}/> Avisar quando um fechamento for corrigido</label>` : ""}
      <label class="cfg-check"><input type="checkbox" name="desligar"/> Desligar este aviso para esta unidade</label>
      <small class="cfg-erro" role="alert" data-erro></small>
      <div class="cfg-acoes cfg-acoes--start"><button type="button" class="btn btn-ghost" data-fechar-form>Cancelar</button><button type="submit" class="btn btn-primary">Salvar preferências</button></div>
    </form>`;
    const f = alvo.querySelector("form");
    f.querySelector("[data-fechar-form]").addEventListener("click", () => { alvo.innerHTML = ""; });
    f.querySelector("input")?.focus();
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const faixa = (a, b) => {
        const i = f.elements[a].value; const j = f.elements[b].value;
        if (!i && !j) return null;
        if (!i || !j || i === j) throw new Error("Informe início e fim diferentes (ou deixe os dois vazios).");
        return { inicio: i, fim: j };
      };
      try {
        const corpo = { unidadeId, categoria, janela: faixa("ji", "jf"), silencio: faixa("si", "sf") };
        if (f.elements.corr) corpo.notificarCorrecao = f.elements.corr.checked;
        if (f.elements.desligar.checked) {
          if (!(await confirmarDialogo({ titulo: "Desligar este aviso?", texto: "Só o titular pode voltar a autorizar este aviso, por um novo convite.", confirmar: "Desligar", perigo: true }))) return;
          corpo.habilitado = false;
        }
        await notificacoesPreferencias(id, corpo);
        toast("Preferências salvas.");
        carregarAba();
      } catch (e) { f.querySelector("[data-erro]").textContent = e.message; }
    });
  }

  function abrirVinculo(id) {
    const alvo = root.querySelector(`[data-form-dest="${id}"]`);
    const unidades = st.resumo?.unidades ?? [];
    alvo.innerHTML = `<form class="ntf-form" novalidate>
      <h4>Vincular a uma unidade (só Dashboard iFood D-1)</h4>
      <p class="cfg-meta">Para destinatários da configuração anterior. Fica registrado na auditoria com o motivo. Outros avisos exigem convite.</p>
      <div class="cfg-form-grid">
        <label class="cfg-campo" for="ntf-vu"><span>Unidade</span><select id="ntf-vu">${unidades.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.nome)}</option>`).join("")}</select></label>
        <label class="cfg-campo" for="ntf-vm"><span>Motivo</span><input id="ntf-vm" maxlength="300" required/></label>
      </div><small class="cfg-erro" role="alert" data-erro></small>
      <div class="cfg-acoes cfg-acoes--start"><button type="button" class="btn btn-ghost" data-fechar-form>Cancelar</button><button type="submit" class="btn btn-primary">Vincular</button></div></form>`;
    const f = alvo.querySelector("form");
    f.querySelector("[data-fechar-form]").addEventListener("click", () => { alvo.innerHTML = ""; });
    f.querySelector("select")?.focus();
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const motivo = f.querySelector("#ntf-vm").value.trim();
      if (motivo.length < 3) { f.querySelector("[data-erro]").textContent = "Descreva o motivo."; return; }
      try { await notificacoesVincularLegado(id, { unidadeId: f.querySelector("#ntf-vu").value, motivo }); toast("Unidade vinculada."); carregarAba(); }
      catch (e) { f.querySelector("[data-erro]").textContent = e.message; }
    });
  }

  function abrirRevogacao(id) {
    const d = st.dados.destinatarios.find((x) => x.id === id);
    const alvo = root.querySelector(`[data-form-dest="${id}"]`);
    alvo.innerHTML = `<form class="ntf-form" novalidate>
      <h4>Registrar pedido de revogação</h4>
      <p class="cfg-meta">Use quando ${escapeHtml(d?.nome ?? "o titular")} pediu, por outro canal, para não receber mais.
        ${st.resumo?.recorte === "unidade" ? "O efeito vale só para a sua unidade." : "O efeito vale para todas as unidades desta empresa."}
        Os avisos param na hora e a fila é cancelada. Só o próprio titular pode voltar a autorizar, por um novo convite.</p>
      <label class="cfg-campo" for="ntf-rm"><span>Como o titular pediu</span><input id="ntf-rm" maxlength="300" placeholder="ex.: pediu por telefone em 30/10" required/></label>
      <small class="cfg-erro" role="alert" data-erro></small>
      <div class="cfg-acoes cfg-acoes--start"><button type="button" class="btn btn-ghost" data-fechar-form>Cancelar</button><button type="submit" class="btn btn-perigo">Registrar revogação</button></div></form>`;
    const f = alvo.querySelector("form");
    f.querySelector("[data-fechar-form]").addEventListener("click", () => { alvo.innerHTML = ""; });
    f.querySelector("input")?.focus();
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const motivo = f.querySelector("#ntf-rm").value.trim();
      if (motivo.length < 3) { f.querySelector("[data-erro]").textContent = "Descreva como o pedido foi feito."; return; }
      if (!(await confirmarDialogo({ titulo: "Registrar a revogação?", texto: "Não dá para desfazer pela Central: só o titular volta a autorizar.", confirmar: "Registrar revogação", perigo: true }))) return;
      try {
        const { data } = await notificacoesPedidoRevogacao(id, { motivo });
        toast(`Revogação registrada.${data?.mensagens_canceladas ? ` ${data.mensagens_canceladas} mensagem(ns) cancelada(s).` : ""}`);
        st.aberto = null;
        carregarAba();
      } catch (e) { f.querySelector("[data-erro]").textContent = e.message; }
    });
  }
}
