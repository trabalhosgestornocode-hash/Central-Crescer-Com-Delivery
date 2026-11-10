// Foody Delivery (Configurações → Integrações → Foody Delivery): conexão da conta, compartilhamento entre empresas, triagem
// de pedidos não identificados e auditoria.
//
// O que esta tela NÃO faz: coletar pedidos. Ativar a conexão só a deixa pronta; a coleta depende da sincronização, que é outra
// chave no servidor (a tela apenas mostra se ela está ligada). Com a administração desligada no servidor (404) ou sem
// permissão (403), a seção some — nada da integração aparece.
// O token: campo de senha, sem autocompletar, enviado só no corpo do POST, apagado do campo logo depois; nunca é exibido de volta.
// Quem fez cada ação aparece só como "Você" / "Outro administrador" (o servidor não envia ids de pessoas).
import { escapeHtml, toast } from "./utils.js";
import { icon } from "./icons.js";
import {
  foodyEstado, foodyCadastrar, foodySubstituirToken, foodyAtivar, foodyPausar, foodyRevogar, foodyPontoColeta, foodyDestinosPossiveis,
  foodyPropor, foodyAprovar, foodyRevogarCompartilhamento, foodyTriagemDias, foodyTriagem, foodyTriagemDecisoes, foodyDecidir,
  foodySincronizacoes, foodySincronizar,
} from "./api.js";
import {
  STATUS_CONEXAO, ESTADO_VINCULO, OPERACOES, rotuloOperacao, rotuloEvento, rotuloMotivoTriagem, rotuloAtor, mensagemDeErro,
  validarToken, validarMotivo, acoesDaConexao, conexoesDaTriagem, opcoesDeDestino, dataHora, dataCurta,
  planejarIntervalo, ontemBrasilia, rotuloFechamento, STATUS_EXECUCAO, ORIGEM_EXECUCAO, rotuloErroSync, resumoDoDia, MAX_DIAS_SYNC,
  saudeDaIntegracao, SAUDE,
} from "./configuracoesFoodyModelo.js";

const ABAS = [
  ["conexao", "Conexão", "link"],
  ["compartilhamento", "Compartilhamento", "users"],
  ["triagem", "Triagem", "list-checks"],
  ["sincronizacao", "Sincronização", "refresh"],
  ["auditoria", "Auditoria", "file-text"],
];
/** A aba de sincronização só existe para quem administra a unidade TITULAR (dona da conta). */
const abasVisiveis = (s) => ABAS.filter(([id]) => id !== "sincronizacao" || Boolean(s?.conexao && s?.podeAdministrar && !s?.impersonando));
const novaChave = () => `fdy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const e = (v) => escapeHtml(v ?? "");
const pill = ([tom, txt]) => `<span class="pill ${tom}">${e(txt)}</span>`;
const painel = (titulo, corpo, sub = "") =>
  `<section class="cfg-panel"><div class="cfg-panel-head"><h3>${e(titulo)}</h3>${sub ? `<p>${e(sub)}</p>` : ""}</div><div class="cfg-panel-body">${corpo}</div></section>`;
const vazio = (txt) => `<div class="estado-mini">${e(txt)}</div>`;
const carregando = (txt = "Carregando…") => `<div class="estado" role="status"><div class="spinner"></div>${e(txt)}</div>`;
const aviso = (tom, txt) => `<p class="ntf-aviso ntf-aviso--${tom}">${icon(tom === "warn" ? "alert-triangle" : "info", { size: 14 })} ${e(txt)}</p>`;

/**
 * Pede um motivo num diálogo acessível (rótulo, contador implícito pelo limite, erro anunciado). Resolve com o texto ou null.
 * @param {{titulo: string, texto: string, confirmar?: string, perigo?: boolean, obrigatorio?: boolean}} o
 */
export function pedirMotivo({ titulo, texto, confirmar = "Confirmar", perigo = false, obrigatorio = true }) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    if (typeof d.showModal !== "function" || !document.body?.appendChild) { resolve(null); return; }
    const anterior = document.activeElement;
    d.className = "cfg-dialogo";
    d.setAttribute("aria-labelledby", "fdy-motivo-t");
    d.setAttribute("aria-describedby", "fdy-motivo-d");
    d.innerHTML = `<form method="dialog" class="cfg-dialogo-corpo">
        <h2 id="fdy-motivo-t">${e(titulo)}</h2><p id="fdy-motivo-d">${e(texto)}</p>
        <label class="cfg-campo" for="fdy-motivo"><span>Motivo${obrigatorio ? "" : " (opcional)"}</span>
          <textarea id="fdy-motivo" name="motivo" rows="3" maxlength="300" aria-describedby="fdy-motivo-erro" ${obrigatorio ? "required" : ""}></textarea>
          <small class="cfg-erro" id="fdy-motivo-erro" role="alert"></small></label>
        <div class="cfg-acoes"><button value="nao" class="btn btn-ghost" formnovalidate>Cancelar</button>
          <button value="sim" class="btn ${perigo ? "btn-perigo" : "btn-primary"}" data-ok>${e(confirmar)}</button></div></form>`;
    document.body.appendChild(d);
    const campo = d.querySelector("#fdy-motivo");
    let valor = null;
    d.querySelector("[data-ok]").addEventListener("click", (ev) => {
      const erro = validarMotivo(campo.value, { obrigatorio });
      if (erro) { ev.preventDefault(); d.querySelector("#fdy-motivo-erro").textContent = erro; campo.setAttribute("aria-invalid", "true"); campo.focus(); return; }
      valor = campo.value.trim();
    });
    d.addEventListener("close", () => { const r = d.returnValue === "sim" ? valor ?? "" : null; d.remove(); anterior?.focus?.(); resolve(r); }, { once: true });
    d.showModal();
    campo.focus();
  });
}

/**
 * Monta a seção em `root`. `ctx.confirmarDialogo` e `ctx.carregarProtegido` vêm de configuracoes.js.
 * @param {HTMLElement} root
 * @param {{confirmarDialogo: Function, carregarProtegido: Function}} ctx
 */
export function montarFoody(root, ctx) {
  const { confirmarDialogo, carregarProtegido } = ctx;
  const st = { estado: null, aba: "conexao", possiveis: null, tri: { conexaoId: null, dias: null, dia: null, pedidos: null, decisoes: null }, ocupado: false,
    sync: { dados: null, resultado: null, chave: null, erro: null } };
  const secao = () => root.closest?.(".cfg2-secao") ?? null;

  root.innerHTML = `<div class="cfg-panel"><div class="cfg-panel-body">${carregando("Carregando a integração Foody…")}</div></div>`;
  root.addEventListener("click", aoClicar);
  root.addEventListener("submit", aoEnviar);
  root.addEventListener("change", aoMudar);
  root.addEventListener("keydown", aoTeclar);
  recarregar();

  async function recarregar({ focarAba = false } = {}) {
    try {
      const r = await carregarProtegido(foodyEstado);
      if (r === null) return;
      st.estado = r.data;
      desenhar();
      if (focarAba) root.querySelector(`#fdy-aba-${st.aba}`)?.focus();
    } catch (err) {
      if (err?.status === 404 || err?.status === 403) {
        // Desligada no servidor ou sem permissão: a seção inteira some (dentro da categoria) ou vira um aviso (link direto).
        const s = secao();
        if (s) { s.hidden = true; root.innerHTML = ""; } else root.innerHTML = painel("Foody Delivery", vazio("A integração Foody não está disponível para você nesta empresa."));
        return;
      }
      root.innerHTML = painel("Foody Delivery", `<div class="estado-mini bad" role="alert">Não foi possível carregar: ${e(mensagemDeErro(err))}</div>`);
    }
  }

  // ---------- moldura ----------
  function avisos() {
    const s = st.estado;
    const itens = [];
    if (s.impersonando) itens.push(["warn", "Você está em impersonação: esta tela é só consulta."]);
    else if (!s.podeAdministrar) itens.push(["info", "Somente leitura — quem altera a integração Foody: um Administrador da empresa."]);
    if (!s.segredoConfigurado) itens.push(["warn", "A chave de proteção da integração não está configurada no servidor: não dá para cadastrar nem trocar o token."]);
    const sync = s.sincronizacao ?? {};
    itens.push(["info", sync.coletaHabilitada
      ? "A coleta automática de pedidos está habilitada no servidor para as unidades liberadas."
      : "A coleta de pedidos está desligada: cadastrar ou ativar a conexão não busca nenhum pedido."]);
    return `<div class="ntf-avisos">${itens.map(([t, x]) => aviso(t, x)).join("")}</div>`;
  }

  function desenhar() {
    const abas = abasVisiveis(st.estado);
    if (!abas.some(([id]) => id === st.aba)) st.aba = "conexao";
    const corpo = { conexao: abaConexao, compartilhamento: abaCompartilhamento, triagem: abaTriagem, sincronizacao: abaSincronizacao, auditoria: abaAuditoria }[st.aba]();
    root.innerHTML = `<div class="fdy">${avisos()}
      <div class="ntf-abas" role="tablist" aria-label="Seções da integração Foody">${abas.map(([id, rot, ic]) =>
        `<button type="button" role="tab" id="fdy-aba-${id}" aria-controls="fdy-painel" aria-selected="${st.aba === id}" tabindex="${st.aba === id ? 0 : -1}"
          class="ntf-aba${st.aba === id ? " ativo" : ""}" data-aba="${id}">${icon(ic, { size: 14 })} ${rot}</button>`).join("")}</div>
      <div class="ntf-painel" id="fdy-painel" role="tabpanel" aria-labelledby="fdy-aba-${st.aba}" tabindex="-1">${corpo}</div>
      <p class="sr-only" id="fdy-anuncio" role="status" aria-live="polite"></p></div>`;
  }
  const anunciar = (txt) => { const a = root.querySelector("#fdy-anuncio"); if (a) a.textContent = txt; toast(txt); };

  // ---------- Conexão ----------
  function abaConexao() {
    const s = st.estado;
    if (!s.unidade) return painel("Conexão da unidade", vazio("A conexão Foody é por unidade. Escolha uma unidade no seletor do topo."));
    const c = s.conexao;
    const a = acoesDaConexao(s);
    const resumo = c ? `<dl class="fdy-dados">
        <div><dt>Situação</dt><dd>${pill(STATUS_CONEXAO[c.status] ?? ["muted", c.status])}</dd></div>
        <div><dt>Conta (final da impressão)</dt><dd><code>…${e(c.impressaoFinal ?? "????")}</code></dd></div>
        <div><dt>Ponto de coleta esperado</dt><dd>${e(c.pontoColetaEsperado ?? "Não informado")}</dd></div>
        <div><dt>Última sincronização</dt><dd>${e(c.ultimaSyncEm ? dataHora(c.ultimaSyncEm) : "Nunca")}</dd></div>
        ${c.ultimoErroCodigo ? `<div><dt>Último erro</dt><dd><span class="pill bad">${e(c.ultimoErroCodigo)}</span></dd></div>` : ""}
      </dl>` : vazio("Esta unidade ainda não tem conta Foody conectada.");
    const formToken = (id, rotuloBotao, comMotivo) => `
      <form class="ntf-form" data-form="${id}" novalidate>
        <label class="cfg-campo" for="fdy-${id}-token"><span>Token da conta Foody</span>
          <input id="fdy-${id}-token" name="token" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="512"
            aria-describedby="fdy-${id}-token-ajuda fdy-${id}-token-erro" required />
          <small class="cfg-ajuda" id="fdy-${id}-token-ajuda">Fica guardado cifrado; depois de salvo, ninguém consegue vê-lo de novo nesta tela.</small>
          <small class="cfg-erro" id="fdy-${id}-token-erro" role="alert"></small></label>
        ${comMotivo ? `<label class="cfg-campo" for="fdy-${id}-motivo"><span>Motivo (opcional)</span>
          <input id="fdy-${id}-motivo" name="motivo" maxlength="300" autocomplete="off" /></label>`
        : `<label class="cfg-campo" for="fdy-${id}-ponto"><span>Ponto de coleta esperado (opcional)</span>
          <input id="fdy-${id}-ponto" name="ponto" maxlength="120" autocomplete="off" aria-describedby="fdy-${id}-ponto-ajuda" />
          <small class="cfg-ajuda" id="fdy-${id}-ponto-ajuda">Nome da loja como aparece na Foody, para conferência.</small></label>`}
        <div class="cfg-acoes"><button type="submit" class="btn btn-primary" ${s.segredoConfigurado ? "" : "disabled"}>${e(rotuloBotao)}</button></div>
      </form>`;
    const acoes = [];
    if (a.ativar) acoes.push(`<button type="button" class="btn btn-primary btn-sm" data-acao="ativar">${icon("zap", { size: 14 })} Ativar</button>`);
    if (a.pausar) acoes.push(`<button type="button" class="btn btn-ghost btn-sm" data-acao="pausar">${icon("pause", { size: 14 })} Pausar</button>`);
    if (a.revogar) acoes.push(`<button type="button" class="btn btn-ghost btn-sm fdy-perigo" data-acao="revogar">${icon("x-circle", { size: 14 })} Revogar conexão</button>`);
    return painel("Conexão da unidade", `${resumo}
        ${acoes.length ? `<div class="cfg-acoes fdy-acoes">${acoes.join("")}</div>` : ""}
        ${a.cadastrar ? `<h4 class="fdy-sub">${c ? "Reconectar com um token novo" : "Conectar a conta Foody"}</h4>${formToken("cadastro", c ? "Reconectar" : "Conectar", false)}` : ""}
        ${a.bloqueioCadastro ? aviso("warn", a.bloqueioCadastro) : ""}
        ${a.pontoColeta ? `<details class="fdy-detalhe"><summary>Alterar o ponto de coleta</summary>
          <form class="ntf-form" data-form="ponto" novalidate><label class="cfg-campo" for="fdy-ponto"><span>Ponto de coleta esperado</span>
            <input id="fdy-ponto" name="ponto" maxlength="120" value="${e(c?.pontoColetaEsperado ?? "")}" autocomplete="off" /></label>
            <div class="cfg-acoes"><button type="submit" class="btn btn-primary btn-sm">Salvar ponto de coleta</button></div></form></details>` : ""}
        ${a.substituir ? `<details class="fdy-detalhe"><summary>Substituir o token</summary>
          <p class="fdy-nota">A conexão volta para <b>Pausada</b> até alguém ativá-la de novo.</p>${formToken("token", "Substituir token", true)}</details>` : ""}
        ${a.substituirBloqueado ? aviso("info", a.substituirBloqueado) : ""}`,
    `${s.empresa?.nome ?? ""}${s.unidade?.nome ? ` · ${s.unidade.nome}` : ""}`);
  }

  // ---------- Compartilhamento ----------
  function abaCompartilhamento() {
    const s = st.estado;
    const lista = s.compartilhamentos ?? [];
    const itens = lista.map((v) => {
      const lado = v.papel === "titular" ? "Esta unidade compartilha" : "Esta unidade recebe";
      const espera = v.estado === "PENDENTE"
        ? (v.papel === "titular" ? "Aguardando um Administrador da empresa destino aprovar, no contexto da empresa dele." : "A empresa titular propôs. Aprove para começar a receber os pedidos desta operação.")
        : "";
      return `<li class="ntf-registro fdy-vinculo">
        <span><b>${e(lado)} ${e(v.operacaoRotulo ?? rotuloOperacao(v.operacao))}</b>
          <small>${e(v.titular.organizacao)} — ${e(v.titular.unidade)} → ${e(v.destino.organizacao)} — ${e(v.destino.unidade)}</small>
          <small>Proposto em ${e(dataHora(v.propostoEm))}${v.aprovadoDestinoEm ? ` · aprovado em ${e(dataHora(v.aprovadoDestinoEm))}` : ""}${v.revogadoEm ? ` · revogado em ${e(dataHora(v.revogadoEm))} (${e(rotuloAtor(v.revogadoPor))}): ${e(v.revogadoMotivo)}` : ""}</small>
          ${espera ? `<small>${e(espera)}</small>` : ""}
          ${v.mesmaPessoa ? `<small class="fdy-mesma">${icon("info", { size: 12 })} A mesma pessoa aprovou pelas duas empresas (em atos separados, como Administradora das duas).</small>` : ""}
          ${v.estado === "PENDENTE" && v.papel === "destino" && v.propostoPorVoce ? `<small class="fdy-mesma">${icon("info", { size: 12 })} Foi você quem propôs, pela empresa titular.</small>` : ""}</span>
        ${pill(ESTADO_VINCULO[v.estado] ?? ["muted", v.estado])}
        <span class="ntf-vinculo-acoes">
          ${v.podeAprovar && !s.impersonando ? `<button type="button" class="btn btn-primary btn-sm" data-acao="aprovar" data-id="${e(v.id)}">Aprovar</button>` : ""}
          ${v.podeRevogar && !s.impersonando ? `<button type="button" class="btn btn-perigo btn-sm" data-acao="revogar-vinculo" data-id="${e(v.id)}" data-pendente="${v.estado === "PENDENTE" ? "1" : ""}">${v.estado === "PENDENTE" && v.papel === "destino" ? "Recusar" : "Revogar"}</button>` : ""}
        </span></li>`;
    }).join("");
    const c = s.conexao;
    const vivo = lista.some((v) => v.papel === "titular" && v.estado !== "REVOGADO");
    let propor = "";
    if (s.podeAdministrar && !s.impersonando && c && !vivo) {
      if (c.status !== "ATIVA") propor = aviso("info", "Para compartilhar, a conexão desta unidade precisa estar ativa.");
      else if (st.possiveis === null) propor = `<div class="cfg-acoes"><button type="button" class="btn btn-ghost btn-sm" data-acao="carregar-destinos">${icon("plus", { size: 14 })} Propor compartilhamento</button></div>`;
      else {
        const ops = opcoesDeDestino(st.possiveis);
        propor = ops.length ? `<form class="ntf-form" data-form="propor" novalidate><h4>Propor compartilhamento</h4>
          <p class="fdy-nota">Os pedidos da operação escolhida passam a contar na empresa destino. Vale só depois que um Administrador
            da empresa destino aprovar, no contexto dela. Pedidos sem identificação clara vão para a triagem.</p>
          <label class="cfg-campo" for="fdy-destino"><span>Empresa e unidade destino</span>
            <select id="fdy-destino" name="destino" required aria-describedby="fdy-destino-ajuda"><option value="">Escolha…</option>
              ${ops.map((o) => `<option value="${e(o.valor)}">${e(o.rotulo)}</option>`).join("")}</select>
            <small class="cfg-ajuda" id="fdy-destino-ajuda">Aparecem só empresas em que você também tem acesso.</small>
            <small class="cfg-erro" id="fdy-destino-erro" role="alert"></small></label>
          <label class="cfg-campo" for="fdy-operacao"><span>Operação</span>
            <select id="fdy-operacao" name="operacao">${(s.operacoesCompartilhaveis ?? []).map((o) => `<option value="${e(o.id)}">${e(o.rotulo)}</option>`).join("")}</select></label>
          <div class="cfg-acoes"><button type="submit" class="btn btn-primary">Propor</button></div></form>`
          : vazio("Nenhuma empresa disponível: nesta fase, só dá para propor para empresas em que você também tem acesso. Peça ao Administrador da plataforma para incluir você na empresa destino (ou peça a quem já está nas duas para propor).");
      }
    }
    return painel("Compartilhamento entre empresas", `${itens ? `<ul class="ntf-lista" role="list">${itens}</ul>` : vazio("Nenhum compartilhamento nesta unidade.")}${propor}`,
      "Uma conta Foody, indicadores separados por empresa. Exige aprovação de um Administrador de cada empresa.");
  }

  // ---------- Triagem ----------
  function abaTriagem() {
    const conexoes = conexoesDaTriagem(st.estado);
    if (!conexoes.length) return painel("Triagem de pedidos", vazio("Não há conexão ativa ou compartilhamento aprovado nesta unidade."));
    if (!st.tri.conexaoId || !conexoes.some((c) => c.conexaoId === st.tri.conexaoId)) { st.tri = { conexaoId: conexoes[0].conexaoId, dias: null, dia: null, pedidos: null, decisoes: null }; }
    if (st.tri.dias === null) queueMicrotask(carregarDias);
    const escolha = conexoes.length > 1 ? `<label class="cfg-campo" for="fdy-tri-conexao"><span>Conta</span>
      <select id="fdy-tri-conexao" data-campo="tri-conexao">${conexoes.map((c) => `<option value="${e(c.conexaoId)}" ${c.conexaoId === st.tri.conexaoId ? "selected" : ""}>${e(c.rotulo)}</option>`).join("")}</select></label>` : "";
    const dias = st.tri.dias === null ? carregando("Carregando dias…")
      : st.tri.dias.length ? `<ul class="fdy-dias" role="list" aria-label="Dias com pedidos para conferir">${st.tri.dias.map((d) =>
        `<li><button type="button" class="btn btn-sm ${d.competencia === st.tri.dia ? "btn-primary" : "btn-ghost"}" data-acao="dia" data-dia="${e(d.competencia)}" aria-pressed="${d.competencia === st.tri.dia}">
          ${e(dataCurta(d.competencia))} <span class="fdy-qtd">· ${e(d.quantidade)} ${d.quantidade === 1 ? "pedido" : "pedidos"}</span></button></li>`).join("")}</ul>`
        : vazio("Nenhum pedido aguardando conferência nos últimos 35 dias.");
    const pode = st.estado.podeAdministrar && !st.estado.impersonando;
    let pedidos = "";
    if (st.tri.dia) {
      pedidos = st.tri.pedidos === null ? carregando("Carregando pedidos…") : st.tri.pedidos.length ? `<ul class="ntf-lista" role="list">${st.tri.pedidos.map((p, i) => `
        <li class="ntf-dest fdy-pedido"><div class="ntf-dest-cab"><span class="cfg-user-info"><b>Pedido ${e(p.numeroPedido ?? p.foodyUid)}</b>
            <small>${e(dataHora(p.dataHora))} · ${e(p.situacao ?? "")} · ${e(rotuloMotivoTriagem(p.motivo))}</small>
            <small>Unidade da conta: ${e(conexoes.find((c) => c.conexaoId === st.tri.conexaoId)?.rotulo ?? "—")} · Origem: Foody Delivery (API, sincronização)</small></span>
          ${p.decisaoPendente ? `<span class="pill ok">Decidido: ${e(rotuloOperacao(p.decisaoPendente.operacao))} (${e(p.decisaoPendente.porVoce ? "você" : "outro administrador")})</span>` : `<span class="pill warn">Aguardando decisão</span>`}</div>
          <div class="ntf-dest-corpo">
            ${p.linhasSemEvidencia?.length ? `<p class="fdy-nota">Itens não reconhecidos:</p><ul class="fdy-itens">${p.linhasSemEvidencia.map((l) => `<li>${e(l)}</li>`).join("")}</ul>` : `<p class="fdy-nota">${e(p.resumo ?? "Sem itens para mostrar.")}</p>`}
            ${pode ? `<form class="ntf-form" data-form="decisao" data-uid="${e(p.foodyUid)}" novalidate>
              <fieldset class="ntf-escolha"><legend>A qual operação o pedido pertence?</legend>
                ${Object.entries(OPERACOES).map(([op, rot]) => `<label class="cfg-check"><input type="radio" name="operacao" value="${op}" ${p.decisaoPendente?.operacao === op ? "checked" : ""} /> <span>${e(rot)}</span></label>`).join("")}
              </fieldset>
              <label class="cfg-campo" for="fdy-dec-motivo-${i}"><span>Justificativa</span>
                <input id="fdy-dec-motivo-${i}" name="motivo" maxlength="300" autocomplete="off" aria-describedby="fdy-dec-erro-${i}" required /></label>
              <small class="cfg-erro" id="fdy-dec-erro-${i}" role="alert"></small>
              <div class="cfg-acoes"><button type="submit" class="btn btn-primary btn-sm">${p.decisaoPendente ? "Registrar nova decisão" : "Registrar decisão"}</button></div>
            </form>` : ""}
          </div></li>`).join("")}</ul>` : vazio("Nenhum pedido pendente neste dia.");
    }
    const hist = st.tri.decisoes === null ? "" : st.tri.decisoes.length ? `<div class="ntf-tabela-wrap"><table class="ntf-tabela"><caption class="sr-only">Histórico de decisões de triagem</caption>
      <thead><tr><th scope="col">Quando</th><th scope="col">Pedido</th><th scope="col">Operação</th><th scope="col">Quem</th><th scope="col">Justificativa</th></tr></thead>
      <tbody>${st.tri.decisoes.map((d) => `<tr><td>${e(dataHora(d.decididoEm))}</td><td>${e(d.foodyUid)}</td><td>${e(rotuloOperacao(d.operacao))}</td>
        <td>${e(d.porVoce ? "Você" : "Outro administrador")}</td><td>${e(d.motivo)}</td></tr>`).join("")}</tbody></table></div>` : vazio("Nenhuma decisão registrada ainda.");
    return painel("Triagem de pedidos", `${escolha}${aviso("info", "A decisão vale a partir da próxima sincronização. O pedido nunca conta nas duas empresas ao mesmo tempo.")}
      ${dias}${pedidos}<h4 class="fdy-sub">Histórico de decisões</h4>${hist}`,
    "Pedidos que o catálogo não conseguiu atribuir com segurança. Mostramos só o necessário para decidir.");
  }

  // ---------- Sincronização manual (piloto em sombra) ----------
  function abaSincronizacao() {
    const sy = st.sync;
    if (sy.dados === null) { queueMicrotask(carregarSync); return painel("Sincronização", carregando("Carregando sincronizações…")); }
    const d = sy.dados;
    const ontem = ontemBrasilia();
    const form = !d.habilitada
      ? aviso("info", "A coleta está desligada no servidor para esta unidade. Quando o piloto for liberado, a sincronização manual aparece aqui.")
      : d.conexaoStatus !== "ATIVA" ? aviso("warn", "Ative a conexão para sincronizar.")
      : `<form class="ntf-form" data-form="sincronizar" novalidate>
        <p class="fdy-nota">Busca na Foody (somente leitura) os pedidos dos dias escolhidos, distribui por empresa e gera os fechamentos
          logísticos. O Parser só usa esses pedidos nas unidades liberadas na configuração do servidor (e só nos dias sem planilha importada).</p>
        <div class="fdy-datas">
          <label class="cfg-campo" for="fdy-sync-de"><span>Primeiro dia</span><input id="fdy-sync-de" name="de" type="date" max="${e(ontem)}" value="${e(ontem)}" required /></label>
          <label class="cfg-campo" for="fdy-sync-ate"><span>Último dia</span><input id="fdy-sync-ate" name="ate" type="date" max="${e(ontem)}" value="${e(ontem)}" required /></label>
        </div>
        <label class="cfg-campo" for="fdy-sync-motivo"><span>Motivo (obrigatório para dias antes dos últimos 3)</span>
          <input id="fdy-sync-motivo" name="motivo" maxlength="300" autocomplete="off" aria-describedby="fdy-sync-erro" /></label>
        <small class="cfg-ajuda">Até ${MAX_DIAS_SYNC} dias por vez; hoje não entra (o dia ainda não terminou).</small>
        <small class="cfg-erro" id="fdy-sync-erro" role="alert">${e(sy.erro ?? "")}</small>
        <div class="cfg-acoes"><button type="submit" class="btn btn-primary">${icon("refresh", { size: 14 })} Sincronizar</button></div></form>`;
    const r = sy.resultado;
    const fech = (f, rot) => `<small>${e(rot)}: ${e(f.erro ? rotuloErroSync(f.erro) : rotuloFechamento(f))}</small>`;
    const resultado = r ? `<h4 class="fdy-sub">Resultado${r.repetida ? " (já processado — mesma solicitação)" : ""}</h4>
      <ul class="ntf-lista" role="list">${r.dias.map((x) => `<li class="ntf-registro"><span><b>${e(dataCurta(x.competencia))}</b>
        <small>${e(resumoDoDia(x))}</small>
        ${x.fechamento ? fech(x.fechamento, "Fechamento desta empresa") : ""}
        ${(x.fechamentosDestino ?? []).map((f) => fech(f, `Fechamento ${rotuloOperacao(f.operacao)}`)).join("")}</span>
        ${pill(x.erro ? ["bad", "Falhou"] : x.concluido ? ["ok", "Concluído"] : ["warn", "Com pendência"])}</li>`).join("")}</ul>` : "";
    const hist = d.execucoes?.length ? `<div class="ntf-tabela-wrap"><table class="ntf-tabela"><caption class="sr-only">Execuções de sincronização desta unidade</caption>
      <thead><tr><th scope="col">Início</th><th scope="col">Dia</th><th scope="col">Origem</th><th scope="col">Situação</th><th scope="col">Pedidos</th><th scope="col">Novos / atualizados</th></tr></thead>
      <tbody>${d.execucoes.map((x) => `<tr><td>${e(dataHora(x.iniciadoEm))}</td><td>${e(dataCurta(x.competencia))}</td><td>${e(ORIGEM_EXECUCAO[x.origem] ?? x.origem)}</td>
        <td>${pill(STATUS_EXECUCAO[x.status] ?? ["muted", x.status])}${x.erroCodigo ? ` <small>${e(rotuloErroSync(x.erroCodigo))}</small>` : ""}</td>
        <td>${e(x.unicos)}</td><td>${e(x.inseridos)} / ${e(x.atualizados)}</td></tr>`).join("")}</tbody></table></div>` : vazio("Nenhuma sincronização registrada nesta unidade.");
    const sa = saudeDaIntegracao(d);
    const item = (rot, val) => `<div class="vd-pv-item"><span>${e(rot)}</span><b>${e(val)}</b></div>`;
    const saude = `<h4 class="fdy-sub">Saúde da sincronização</h4>
      <p>${pill(SAUDE[sa.estado] ?? ["muted", sa.estado])}${sa.ultimoErro && sa.estado === "COM_ERRO" ? ` <small>${e(rotuloErroSync(sa.ultimoErro))}</small>` : ""}</p>
      <div class="vd-pv-grid">
        ${item("Última execução", sa.ultimaExecucao ? dataHora(sa.ultimaExecucao.iniciadoEm) : "—")}
        ${item("Último sucesso", sa.ultimoSucesso ? dataHora(sa.ultimoSucesso.concluidoEm ?? sa.ultimoSucesso.iniciadoEm) : "—")}
        ${item("Atraso", sa.atrasoHoras == null ? "—" : `${String(sa.atrasoHoras).replace(".", ",")} h`)}
        ${item("Pedidos capturados (último sucesso)", sa.capturados ?? "—")}
        ${item("Pedidos persistidos (último sucesso)", sa.persistidos ?? "—")}
        ${item("Pendências (3 últimas)", sa.pendencias)}
        ${item("Falhas (últimas 30)", sa.falhasRecentes)}
      </div>
      <small class="cfg-ajuda">"Atualizado" exige uma execução concluída nas últimas 7 h com pedidos recebidos. Credencial válida sozinha não conta.</small>`;
    return painel("Sincronização", `${saude}${form}${resultado}<h4 class="fdy-sub">Histórico</h4>${hist}`, "Coleta manual da conta Foody desta unidade (titular).");
  }
  async function carregarSync() {
    try {
      const r = await carregarProtegido(foodySincronizacoes);
      if (r === null) return;
      st.sync.dados = r.data;
    } catch (err) { st.sync.dados = { habilitada: false, execucoes: [] }; toast(mensagemDeErro(err)); }
    if (st.aba === "sincronizacao") desenhar();
  }

  // ---------- Auditoria ----------
  function abaAuditoria() {
    const ev = st.estado.eventos ?? [];
    if (!st.estado.unidade) return painel("Auditoria", vazio("Escolha uma unidade para ver o histórico."));
    return painel("Auditoria", ev.length ? `<div class="ntf-tabela-wrap"><table class="ntf-tabela"><caption class="sr-only">Histórico da integração Foody</caption>
      <thead><tr><th scope="col">Quando</th><th scope="col">O quê</th><th scope="col">Quem</th><th scope="col">Detalhe</th></tr></thead>
      <tbody>${ev.map((x) => {
        const det = [x.statusAnterior && x.statusNovo && x.statusAnterior !== x.statusNovo ? String(x.statusAnterior) + " → " + String(x.statusNovo) : "",
          x.impressaoFinal ? "conta …" + String(x.impressaoFinal) : "", x.motivo ?? ""].filter(Boolean).join(" · ");
        return `<tr><td>${e(dataHora(x.quando))}</td><td>${e(rotuloEvento(x))}</td><td>${e(rotuloAtor(x.ator, x.emNomeDe))}</td><td>${e(det || "—")}</td></tr>`;
      }).join("")}</tbody></table></div>` : vazio("Nenhum evento registrado nesta unidade."), "Registro imutável: ninguém edita nem apaga.");
  }

  // ---------- carregamentos da triagem ----------
  async function carregarDias() {
    const id = st.tri.conexaoId;
    try {
      const [d, h] = await Promise.all([carregarProtegido(() => foodyTriagemDias(id)), carregarProtegido(() => foodyTriagemDecisoes(id))]);
      if (d === null || h === null || st.tri.conexaoId !== id) return;
      st.tri.dias = d.data ?? []; st.tri.decisoes = h.data ?? [];
      // Mantém o dia escolhido enquanto ele ainda tiver pedidos; senão abre o mais recente.
      if (!st.tri.dias.some((x) => x.competencia === st.tri.dia)) st.tri.dia = st.tri.dias[0]?.competencia ?? null;
      if (st.tri.dia) { st.tri.pedidos = null; carregarPedidos(); }
    } catch (err) { st.tri.dias = []; st.tri.decisoes = []; toast(mensagemDeErro(err)); }
    if (st.aba === "triagem") desenhar();
  }
  async function carregarPedidos() {
    const { conexaoId: id, dia } = st.tri;
    try {
      const r = await carregarProtegido(() => foodyTriagem(id, dia));
      if (r === null || st.tri.conexaoId !== id || st.tri.dia !== dia) return;
      st.tri.pedidos = r.data ?? [];
    } catch (err) { st.tri.pedidos = []; toast(mensagemDeErro(err)); }
    if (st.aba === "triagem") desenhar();
  }

  // ---------- ações ----------
  async function executar(fn, sucesso, { aba = st.aba } = {}) {
    if (st.ocupado) return false;
    st.ocupado = true;
    root.querySelectorAll("button").forEach((b) => { b.dataset.estavaDesligado = b.disabled ? "1" : ""; b.disabled = true; });
    try {
      await fn();
      st.aba = aba;
      await recarregar();
      anunciar(sucesso);
      return true;
    } catch (err) {
      const msg = mensagemDeErro(err);
      root.querySelectorAll("button").forEach((b) => { b.disabled = b.dataset.estavaDesligado === "1"; });
      anunciar(msg);
      return msg;
    } finally { st.ocupado = false; }
  }

  async function aoClicar(ev) {
    const aba = ev.target.closest("[data-aba]");
    if (aba) { trocarAba(aba.dataset.aba); return; }
    const b = ev.target.closest("[data-acao]");
    if (!b || st.ocupado) return;
    const acao = b.dataset.acao;
    if (acao === "ativar") {
      const ok = await confirmarDialogo({ titulo: "Ativar a conexão Foody?", confirmar: "Ativar",
        texto: st.estado.sincronizacao?.coletaHabilitada
          ? "Com a conexão ativa, a coleta automática passa a buscar os pedidos desta conta."
          : "A conexão fica pronta, mas nenhum pedido é coletado enquanto a sincronização estiver desligada no servidor." });
      if (ok) await executar(foodyAtivar, "Conexão ativada.");
    } else if (acao === "pausar") {
      const m = await pedirMotivo({ titulo: "Pausar a conexão?", texto: "Enquanto pausada, nenhum pedido desta conta é coletado.", confirmar: "Pausar", obrigatorio: false });
      if (m !== null) await executar(() => foodyPausar(m || null), "Conexão pausada.");
    } else if (acao === "revogar") {
      const m = await pedirMotivo({ titulo: "Revogar a conexão Foody?", perigo: true, confirmar: "Revogar",
        texto: "O token deixa de ser usado e os compartilhamentos desta conta são revogados. O histórico é preservado. Para voltar, será preciso cadastrar um token." });
      if (m) await executar(() => foodyRevogar(m), "Conexão revogada.");
    } else if (acao === "carregar-destinos") {
      try {
        const r = await carregarProtegido(foodyDestinosPossiveis);
        if (r === null) return;
        st.possiveis = r.data ?? [];
        desenhar();
        root.querySelector("#fdy-destino")?.focus();
      } catch (err) { anunciar(mensagemDeErro(err)); }
    } else if (acao === "aprovar") {
      const v = st.estado.compartilhamentos.find((x) => x.id === b.dataset.id);
      const ok = await confirmarDialogo({ titulo: "Aprovar o compartilhamento?", confirmar: "Aprovar",
        texto: `Os pedidos de ${v?.operacaoRotulo ?? "a operação"} da conta de ${v?.titular.organizacao ?? "a titular"} passam a contar em ${v?.destino.unidade ?? "esta unidade"}. Pedidos sem identificação clara vão para a triagem.` });
      if (ok) await executar(() => foodyAprovar(b.dataset.id), "Compartilhamento aprovado.");
    } else if (acao === "revogar-vinculo") {
      const m = await pedirMotivo({ titulo: b.dataset.pendente ? "Encerrar esta proposta?" : "Revogar o compartilhamento?", perigo: true, confirmar: "Revogar",
        texto: "A distribuição para a empresa destino para na próxima sincronização. O histórico já registrado é preservado." });
      if (m) await executar(() => foodyRevogarCompartilhamento(b.dataset.id, m), "Compartilhamento revogado.");
    } else if (acao === "dia") {
      st.tri.dia = b.dataset.dia; st.tri.pedidos = null;
      desenhar(); carregarPedidos();
    }
  }

  function aoMudar(ev) {
    if (ev.target.dataset?.campo === "tri-conexao") {
      st.tri = { conexaoId: ev.target.value, dias: null, dia: null, pedidos: null, decisoes: null };
      desenhar();
    }
  }

  async function aoEnviar(ev) {
    const f = ev.target.closest("form[data-form]");
    if (!f) return;
    ev.preventDefault();
    const tipo = f.dataset.form;
    const erroEm = (id, msg) => { const alvo = f.querySelector(`#${id}`); if (alvo) alvo.textContent = msg ?? ""; };
    if (tipo === "cadastro" || tipo === "token") {
      const campo = f.querySelector('[name="token"]');
      const err = validarToken(campo.value);
      const idErro = `fdy-${tipo}-token-erro`;
      if (err) { erroEm(idErro, err); campo.setAttribute("aria-invalid", "true"); campo.focus(); return; }
      erroEm(idErro, ""); campo.removeAttribute("aria-invalid");
      const token = campo.value.trim();
      campo.value = "";   // nunca fica no DOM depois do envio
      const r = tipo === "cadastro"
        ? await executar(() => foodyCadastrar(token, f.querySelector('[name="ponto"]')?.value.trim() || null), "Conta Foody conectada. A conexão está pausada até alguém ativá-la.")
        : await executar(() => foodySubstituirToken(token, f.querySelector('[name="motivo"]')?.value.trim() || null), "Token substituído. A conexão está pausada até alguém ativá-la.");
      if (typeof r === "string") { erroEm(idErro, r); campo.focus(); }
    } else if (tipo === "ponto") {
      await executar(() => foodyPontoColeta(f.querySelector('[name="ponto"]').value.trim() || null), "Ponto de coleta salvo.");
    } else if (tipo === "propor") {
      const sel = f.querySelector('[name="destino"]');
      if (!sel.value) { erroEm("fdy-destino-erro", "Escolha a empresa e a unidade destino."); sel.focus(); return; }
      const [organizacaoId, unidadeId] = sel.value.split("|");
      const operacao = f.querySelector('[name="operacao"]').value;
      const r = await executar(() => foodyPropor({ organizacaoId, unidadeId, operacao }), "Proposta registrada. Falta a aprovação da empresa destino.");
      if (r === true) st.possiveis = null;
      else if (typeof r === "string") erroEm("fdy-destino-erro", r);
    } else if (tipo === "sincronizar") {
      const motivo = f.querySelector('[name="motivo"]').value.trim();
      const plano = planejarIntervalo(f.querySelector('[name="de"]').value, f.querySelector('[name="ate"]').value, { motivo });
      if (plano.erro) { erroEm("fdy-sync-erro", plano.erro); return; }
      const ok = await confirmarDialogo({ titulo: `Sincronizar ${plano.dias.length} ${plano.dias.length === 1 ? "dia" : "dias"}?`, confirmar: "Sincronizar",
        texto: "A Foody é consultada só para leitura. Repetir o mesmo dia não duplica pedidos nem fechamentos." });
      if (!ok) return;
      st.sync.chave ??= novaChave();
      let resposta = null;
      const r = await executar(async () => { resposta = (await foodySincronizar({ competencias: plano.dias, motivo: motivo || null }, st.sync.chave)).data; },
        "Sincronização concluída.", { aba: "sincronizacao" });
      if (r === true) { st.sync = { dados: null, resultado: resposta, chave: null, erro: null }; desenhar(); }
      else if (typeof r === "string") { st.sync.erro = r; erroEm("fdy-sync-erro", r); }
    } else if (tipo === "decisao") {
      const op = f.querySelector('[name="operacao"]:checked')?.value;
      const campo = f.querySelector('[name="motivo"]');
      const erroId = campo.getAttribute("aria-describedby");
      const err = !op ? "Escolha a operação." : validarMotivo(campo.value);
      if (err) { erroEm(erroId, err); (op ? campo : f.querySelector('[name="operacao"]'))?.focus(); return; }
      const uid = f.dataset.uid;
      const r = await executar(() => foodyDecidir(st.tri.conexaoId, uid, op, campo.value.trim()), "Decisão registrada. Vale a partir da próxima sincronização.", { aba: "triagem" });
      if (r === true) { st.tri.dias = null; st.tri.pedidos = null; desenhar(); }
      else if (typeof r === "string") erroEm(erroId, r);
    }
  }

  function aoTeclar(ev) {
    if (!ev.target.closest?.('[role="tablist"]') || (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft" && ev.key !== "Home" && ev.key !== "End")) return;
    ev.preventDefault();
    const ids = abasVisiveis(st.estado).map(([id]) => id);
    const i = ids.indexOf(st.aba);
    const prox = ev.key === "Home" ? 0 : ev.key === "End" ? ids.length - 1 : (i + (ev.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length;
    trocarAba(ids[prox], true);
  }

  function trocarAba(aba, focar = false) {
    if (aba !== st.aba) { st.aba = aba; desenhar(); }
    if (focar) root.querySelector(`#fdy-aba-${aba}`)?.focus();
  }
}
