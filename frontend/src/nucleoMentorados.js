// NÚCLEO MENTORADOS — controlador da aba no Painel Administrativo (DOM + chamadas à API).
// O HTML vem dos construtores puros de nucleoMentoradosViews.js; aqui só há estado de tela e eventos.

import { escapeHtml as esc, toast } from "./utils.js";
import * as V from "./nucleoMentoradosViews.js";
import { abrirApresentacao } from "./nucleoApresentacao.js";
import { ligarDicas } from "./nucleoMentoradosDicas.js";

const estado = { filtros: V.filtrosPadrao(), lista: null, perfil: null, aba: "visao", org: null };
let host = null, api = null, revogado = null, desligarDicas = null, liveAnterior = null;

export function resetNucleo() { estado.filtros = V.filtrosPadrao(); estado.perfil = null; estado.org = null; estado.aba = "visao"; }

/** Ponto de entrada: renderiza a listagem (ou o perfil aberto) dentro de `alvo`. */
export async function renderNucleoMentorados(alvo, apiPainel, aoAcessoRevogado) {
  host = alvo; api = apiPainel; revogado = aoAcessoRevogado;
  // O #padm-view do Painel é aria-live: aqui a tela é repintada a cada tecla da busca, o que faria o leitor de tela
  // anunciar a tabela inteira. Os avisos do Núcleo usam regiões próprias (role=status/alert).
  if (liveAnterior == null) { liveAnterior = host.getAttribute("aria-live") ?? ""; host.setAttribute("aria-live", "off"); }
  desligarDicas?.(); desligarDicas = ligarDicas(host);
  host.onclick = aoClicar; host.oninput = aoDigitar; host.onchange = aoMudar; host.onkeydown = aoTeclar;
  return estado.org ? abrirPerfil(estado.org, estado.aba) : carregarLista();
}

/** Desliga os ouvintes ao sair da aba (o #padm-view é reutilizado pelas outras telas). */
export function sairNucleo() {
  if (!host) return;
  desligarDicas?.(); desligarDicas = null;
  host.onclick = host.oninput = host.onchange = host.onkeydown = null;
  if (liveAnterior != null) { if (liveAnterior) host.setAttribute("aria-live", liveAnterior); else host.removeAttribute("aria-live"); liveAnterior = null; }
  host = null;
}

async function chamar(fn) {
  try { return await fn(); }
  catch (e) { if (e?.status === 403) revogado?.(e.message); throw e; }
}

async function carregarLista() {
  host.innerHTML = V.carregandoNucleo("Carregando mentorados…");
  try { estado.lista = await chamar(() => api.nucleoListar()); pintarLista(); }
  catch (e) { if (e?.status !== 403 && host) host.innerHTML = V.erroNucleo(e); }
}

function pintarLista() { host.innerHTML = V.htmlLista(estado.lista, estado.filtros); }

async function abrirPerfil(org, aba = "visao") {
  estado.org = org; estado.aba = aba;
  host.innerHTML = V.carregandoNucleo("Carregando perfil…");
  try { estado.perfil = await chamar(() => api.nucleoPerfil(org)); pintarPerfil(); host.querySelector(".nm-h1")?.focus?.(); }
  catch (e) { if (e?.status !== 403 && host) host.innerHTML = V.erroNucleo(e); }
}

function pintarPerfil() {
  host.innerHTML = V.htmlPerfil(estado.perfil, estado.aba);
  host.querySelector(".nm-h1")?.setAttribute("tabindex", "-1");
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
function aoDigitar(e) {
  if (e.target.id !== "nm-busca") return;
  estado.filtros.termo = e.target.value;
  const pos = e.target.selectionStart;
  pintarLista();
  const novo = host.querySelector("#nm-busca"); novo.focus(); novo.setSelectionRange(pos, pos);
}
function aoMudar(e) {
  const f = e.target.dataset?.nmFiltro;
  if (f) { estado.filtros[f] = e.target.value; pintarLista(); host.querySelector(`[data-nm-filtro="${f}"]`)?.focus(); }
}
function aoTeclar(e) {
  // Abas com setas (padrão WAI-ARIA tabs).
  const aba = e.target.closest?.("[role=tab]");
  if (!aba || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  const ids = V.ABAS.map(([id]) => id);
  let i = ids.indexOf(aba.dataset.nmAba);
  i = e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length;
  e.preventDefault();
  estado.aba = ids[i]; pintarPerfil(); host.querySelector(`[data-nm-aba="${ids[i]}"]`)?.focus();
}

async function aoClicar(e) {
  const b = e.target.closest("button"); if (!b) return;
  const d = b.dataset;
  if (d.nmAbrir) return abrirPerfil(d.nmAbrir);
  if (d.nmVoltar != null) { estado.org = null; estado.perfil = null; return carregarLista(); }
  if (d.nmAba) { estado.aba = d.nmAba; pintarPerfil(); return host.querySelector(`[data-nm-aba="${d.nmAba}"]`)?.focus(); }
  if (d.nmLimpar != null) { estado.filtros = V.filtrosPadrao(); return pintarLista(); }
  if (d.nmRecarregar != null) return estado.org ? abrirPerfil(estado.org, estado.aba) : carregarLista();
  if (d.nmCadastrar != null) return dialogoCadastro(null);
  if (d.nmEditar != null) return dialogoCadastro(estado.perfil);
  if (d.nmImportar != null) return dialogoImportacao();
  if (d.nmNovoRegistro != null) return dialogoRegistro(null);
  if (d.nmEditarRegistro) return dialogoRegistro(estado.perfil.registros.find((r) => r.id === d.nmEditarRegistro));
  if (d.nmRemoverRegistro) return removerRegistro(d.nmRemoverRegistro);
  if (d.nmDivergencia) return dialogoDivergencia(d.nmDivergencia);
  if (d.nmNovaApresentacao != null) return dialogoApresentacao();
  if (d.nmApresentar) return apresentarUltima(d.nmApresentar);
  if (d.nmAbrirApresentacao) return abrirVersao(d.nmAbrirApresentacao);
  if (d.nmPdf) return abrirVersao(d.nmPdf, { imprimir: true });
}

// ---------------------------------------------------------------------------
// Diálogos (<dialog> nativo: Esc fecha, foco preso, volta ao botão de origem).
// Cada envio chama `aoConfirmar(ctx)` de novo: um erro mantém o diálogo aberto para corrigir e reenviar.
// A promessa resolve com o valor passado a ctx.fim (null = cancelado).
// ---------------------------------------------------------------------------
function dialogo(titulo, corpo, { rotuloOk = "Salvar", largo = false, somenteLeitura = false, aoConfirmar = null } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = `nm-dialogo${largo ? " nm-dialogo--largo" : ""}`;
    dlg.setAttribute("aria-labelledby", "nm-dlg-titulo");
    dlg.innerHTML = `<form method="dialog" novalidate><header><h2 id="nm-dlg-titulo">${esc(titulo)}</h2>
      <button type="button" class="nm-fechar" data-cancelar aria-label="Fechar">×</button></header>
      <div class="nm-dialogo__corpo">${corpo}</div><p class="nm-dialogo__erro" role="alert" hidden></p>
      <footer>${somenteLeitura ? `<button type="button" class="nm-btn" data-cancelar>Fechar</button>` : `<button type="button" class="nm-btn nm-btn--quieto" data-cancelar>Cancelar</button><button type="submit" class="nm-btn nm-btn--primario">${esc(rotuloOk)}</button>`}</footer></form>`;
    document.body.appendChild(dlg);
    const origem = document.activeElement;
    const form = dlg.querySelector("form");
    let encerrado = false;
    const fim = (v) => { if (encerrado) return; encerrado = true; dlg.close(); dlg.remove(); origem?.focus?.(); resolve(v); };
    const ctx = { form, dlg, fim, erro: (m) => { const p = dlg.querySelector(".nm-dialogo__erro"); p.textContent = m ?? ""; p.hidden = !m; } };
    dlg.querySelectorAll("[data-cancelar]").forEach((b) => b.addEventListener("click", () => fim(null)));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); fim(null); });
    form.addEventListener("submit", (e) => { e.preventDefault(); if (aoConfirmar) aoConfirmar(ctx); else fim(true); });
    dlg.showModal();
    dlg.querySelector("input:not([type=hidden]), select, textarea, [type=submit]")?.focus();
  });
}

const valor = (form, n) => { const x = form.elements.namedItem(n); return x ? (x.type === "checkbox" ? x.checked : x.value.trim()) : undefined; };
const campo = (rotulo, html, ajuda = "") => `<label class="nm-campo"><span class="nm-rotulo">${esc(rotulo)}</span>${html}${ajuda ? `<span class="nm-ajuda">${esc(ajuda)}</span>` : ""}</label>`;
const input = (name, v = "", attrs = "") => `<input name="${name}" value="${esc(v ?? "")}" ${attrs} />`;
const select = (name, ops, atual) => `<select name="${name}">${ops.map(([v, r]) => `<option value="${esc(v)}"${v === (atual ?? "") ? " selected" : ""}>${esc(r)}</option>`).join("")}</select>`;

/** Envia; no sucesso fecha o diálogo com o resultado e roda `ok`; no erro mostra a mensagem e deixa reenviar. */
async function enviar(ctx, fn, ok) {
  const btn = ctx.form.querySelector("[type=submit]");
  if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
  ctx.erro("");
  try { const res = await chamar(fn); ctx.fim(res); await ok?.(res); return res; }
  catch (e) { if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); } ctx.erro(e?.message ?? "Falha ao salvar."); return null; }
}

async function dialogoCadastro(p) {
  const part = p?.participante ?? {};
  let opcoesEmpresas = "";
  if (!p) {
    try {
      const { empresas } = await chamar(() => api.nucleoCandidatas());
      opcoesEmpresas = campo("Empresa", `<select name="org" required><option value="">Escolha a empresa…</option>${empresas.map((o) => `<option value="${esc(o.id)}">${esc(o.nome)}${o.status !== "ativa" ? ` (${esc(o.status)})` : ""}</option>`).join("")}</select>`, "Só entram no Núcleo as empresas cadastradas aqui.");
    } catch (e) { return toast(e.message); }
  }
  const corpo = `${opcoesEmpresas}<div class="nm-grade2">
    ${campo("Data de entrada na mentoria", input("dataEntrada", part.data_entrada, 'type="date" required'))}
    ${campo("Data de renovação contratual", input("dataRenovacao", part.data_renovacao, 'type="date"'), "Deixe vazio se não houver data definida.")}
    ${campo("Mentor responsável", input("mentor", part.mentor_nome, 'maxlength="120" autocomplete="off"'))}
    ${campo("Responsável na empresa", input("responsavel", part.responsavel_nome ?? p?.empresa?.responsavel_nome, 'maxlength="120" autocomplete="off"'))}
    ${campo("Cidade", input("cidade", part.cidade, 'maxlength="80"'))}
    ${campo("UF", input("uf", part.uf, 'maxlength="2" pattern="[A-Za-z]{2}" autocapitalize="characters"'))}
    ${campo("Status", select("status", [["ativa", "Ativa"], ["pausada", "Pausada"], ["encerrada", "Encerrada"]], part.status ?? "ativa"))}
    ${campo("Modelo de operação", select("modeloOperacao", [["", "Não informado"], ["marketplace", "Marketplace"], ["full_service", "Full Service"], ["misto", "Misto"]], part.modelo_operacao ?? ""))}
    </div>
    ${campo("Fonte preferencial quando planilha e Dashboard iFood têm o mesmo mês", select("fontePreferencial", [["importacao", "Planilha do mentor"], ["dashboard_ifood", "Dashboard iFood"]], part.fonte_preferencial ?? "importacao"), "A outra fonte aparece como divergência e nunca é somada.")}
    ${campo("Observações", `<textarea name="observacoes" rows="3" maxlength="2000">${esc(part.observacoes ?? "")}</textarea>`)}`;
  await dialogo(p ? "Editar cadastro do mentorado" : "Cadastrar mentorado", corpo, { largo: true, aoConfirmar: (r) => {
    const org = p ? p.empresa.id : valor(r.form, "org");
    if (!org) return r.erro("Escolha a empresa.");
    if (!valor(r.form, "dataEntrada")) return r.erro("Informe a data de entrada na mentoria.");
    const corpoApi = Object.fromEntries(["dataEntrada", "dataRenovacao", "mentor", "responsavel", "cidade", "uf", "status", "modeloOperacao", "fontePreferencial", "observacoes"].map((n) => [n, valor(r.form, n) || null]));
    return enviar(r, () => api.nucleoSalvar(org, corpoApi), async () => { toast("Cadastro salvo."); await abrirPerfil(org); });
  } });
}

const INDICADORES_META = [["taxasComissoes", "Taxas e comissões (%)"], ["servicosPromocoes", "Serviços e promoções (%)"], ["taxasMaisServicos", "Taxas + serviços (%)"], ["taxasEntregadores", "Entregadores (%)"], ["custosIfoodTotal", "Total com entregadores (%)"], ["valorVendas", "Vendas (R$)"], ["ticketMedio", "Ticket médio (R$)"], ["qtdPedidos", "Pedidos"], ["novosClientes", "Novos clientes"]];

async function dialogoRegistro(reg) {
  const corpo = `<div class="nm-grade2">
    ${campo("Tipo", select("tipo", [["diagnostico", "Diagnóstico inicial"], ["estrategia", "Estratégia / intervenção"], ["meta", "Meta"], ["evidencia", "Evidência"], ["observacao", "Observação do mentor"]], reg?.tipo ?? "estrategia"))}
    ${campo("Data", input("data", reg?.data_registro ?? new Date().toISOString().slice(0, 10), 'type="date" required'))}</div>
    ${campo("Título", input("titulo", reg?.titulo, 'maxlength="160" required autocomplete="off"'))}
    ${campo("Descrição", `<textarea name="descricao" rows="4" maxlength="4000">${esc(reg?.descricao ?? "")}</textarea>`)}
    <fieldset class="nm-meta-campos"><legend>Se for meta</legend><div class="nm-grade2">
      ${campo("Indicador", select("metaIndicador", [["", "—"], ...INDICADORES_META], reg?.meta_indicador ?? ""))}
      ${campo("Valor-alvo", input("metaValor", reg?.meta_valor, 'type="number" step="0.01" inputmode="decimal"'), "Percentual: 5 = 5%.")}
      ${campo("Unidade", select("metaUnidade", [["percentual", "Percentual (máximo)"], ["reais", "Reais"], ["quantidade", "Quantidade"]], reg?.meta_unidade ?? "percentual"))}</div></fieldset>
    <label class="nm-check"><input type="checkbox" name="privado"${reg?.privado ? " checked" : ""} /> Privado (não aparece nos slides; só nas notas do mentor)</label>`;
  const org = estado.org;
  await dialogo(reg ? "Editar registro" : "Novo registro da mentoria", corpo, { largo: true, aoConfirmar: (r) => {
    if (!valor(r.form, "titulo")) return r.erro("Informe o título.");
    const c = { tipo: valor(r.form, "tipo"), data: valor(r.form, "data"), titulo: valor(r.form, "titulo"), descricao: valor(r.form, "descricao") || null, privado: valor(r.form, "privado") };
    if (c.tipo === "meta") Object.assign(c, { metaIndicador: valor(r.form, "metaIndicador") || null, metaValor: valor(r.form, "metaValor") || null, metaUnidade: valor(r.form, "metaUnidade") });
    return enviar(r, () => (reg ? api.nucleoAlterarRegistro(org, reg.id, c) : api.nucleoCriarRegistro(org, c)), async () => { toast("Registro salvo."); await abrirPerfil(org, "evolucao"); });
  } });
}

async function removerRegistro(id) {
  const reg = estado.perfil.registros.find((r) => r.id === id);
  const org = estado.org;
  await dialogo("Remover registro?", `<p>“${esc(reg?.titulo ?? "")}” será removido do histórico da mentoria. Apresentações já geradas mantêm o retrato antigo.</p>`, { rotuloOk: "Remover",
    aoConfirmar: (r) => enviar(r, () => api.nucleoRemoverRegistro(org, id), async () => { toast("Registro removido."); await abrirPerfil(org, "evolucao"); }) });
}

function dialogoDivergencia(mes) {
  const lista = (estado.perfil.divergencias ?? []).filter((d) => d.mes === mes);
  dialogo(`Divergências em ${V.mesLongo(mes)}`, `<p class="nm-muted">O mês tem dados na planilha e no Dashboard iFood. Os números usam a fonte preferencial; a outra fica só para conferência. Nenhum registro oficial foi alterado.</p>${V.htmlDivergencias(lista)}`, { somenteLeitura: true, largo: true });
}

// ---------------------------------------------------------------------------
// Importação: escolher arquivo -> prévia (nada gravado) -> confirmar
// ---------------------------------------------------------------------------
const lerBase64 = (arquivo) => new Promise((ok, falha) => {
  const fr = new FileReader();
  fr.onload = () => ok(String(fr.result).split(",")[1] ?? "");
  fr.onerror = () => falha(new Error("Não foi possível ler o arquivo."));
  fr.readAsDataURL(arquivo);
});

async function dialogoImportacao() {
  const org = estado.org;
  let corpo = null;
  const prev = await dialogo("Importar planilha de histórico", campo("Planilha (.xlsx)", '<input name="arquivo" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />', "Primeiro é gerada uma prévia. Nada é gravado até você confirmar."), { rotuloOk: "Gerar prévia",
    aoConfirmar: async (r) => {
      const arq = r.form.elements.namedItem("arquivo").files?.[0];
      if (!arq) return r.erro("Escolha o arquivo.");
      try { corpo = { arquivoNome: arq.name, conteudoBase64: await lerBase64(arq) }; } catch (e) { return r.erro(e.message); }
      return enviar(r, () => api.nucleoPreviaImportacao(org, corpo));
    } });
  if (!prev) return;
  const div = prev.divergenciasDashboard ?? [];
  const html = `
    <dl class="nm-dl"><div><dt>Período</dt><dd>${V.intervalo(prev.intervalo.inicio, prev.intervalo.fim)} · ${prev.intervalo.meses} meses</dd></div>
      <div><dt>Duplicidade</dt><dd>${prev.jaImportada ? `Este arquivo já foi importado em ${V.dataBr(prev.jaImportada.em)} — confirmar não grava nada de novo.` : "Arquivo novo (hash inédito)."}</dd></div>
      <div><dt>Meses</dt><dd>${prev.mesesNovos} novos · ${prev.mesesSubstituidos.length} substituídos · ${prev.mesesIguais} iguais</dd></div>
      <div><dt>Cobertura</dt><dd>Vendas ${prev.cobertura.valorVendas} · Taxas ${prev.cobertura.taxasComissoes} · Serviços ${prev.cobertura.servicosPromocoes} · Entregadores ${prev.cobertura.taxasEntregadores} · Pedidos ${prev.cobertura.qtdPedidos} · Novos clientes ${prev.cobertura.novosClientes} (de ${prev.intervalo.meses})</dd></div>
      <div><dt>Sobreposição com o Dashboard iFood</dt><dd>${prev.sobreposicaoDashboard.length ? prev.sobreposicaoDashboard.map(V.mesCurto).join(", ") : "nenhuma"}</dd></div></dl>
    ${prev.mesesSubstituidos.length ? `<p><strong>Substituições:</strong> ${prev.mesesSubstituidos.map((s) => `${V.mesCurto(s.mes)} (${s.campos.join(", ")})`).join("; ")}</p>` : ""}
    ${div.length ? `<h3>Divergências com o Dashboard iFood (${div.length})</h3>${V.htmlDivergencias(div)}` : ""}
    ${prev.avisos.length ? `<h3>Avisos do leitor</h3><ul class="nm-avisos">${prev.avisos.map((a) => `<li>${esc(a.texto ?? `${a.codigo} · ${a.mes ?? ""} · ${a.campo ?? ""}`)}</li>`).join("")}</ul>` : ""}
    ${prev.notas.length ? `<h3>Notas da planilha</h3><ul class="nm-avisos">${prev.notas.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
    <p class="nm-ajuda">${esc(prev.regra)}</p>`;
  await dialogo("Prévia da importação", html, { rotuloOk: prev.jaImportada ? "Entendi" : "Confirmar importação", largo: true,
    aoConfirmar: (c) => (prev.jaImportada ? c.fim(null) : enviar(c, () => api.nucleoConfirmarImportacao(org, { ...corpo, arquivoSha256: prev.arquivoSha256 }),
      async (res) => { toast(res.jaExistia ? "Arquivo já importado — nada mudou." : `Importação concluída: ${res.mesesGravados} meses.`); await abrirPerfil(org, "historico"); })) });
}

// ---------------------------------------------------------------------------
// Apresentações
// ---------------------------------------------------------------------------
async function dialogoApresentacao() {
  const corpo = `${campo("Título", input("titulo", `Resultados da mentoria — ${estado.perfil.empresa.nome ?? ""}`, 'maxlength="160"'))}
    <fieldset><legend>Slides</legend><div class="nm-checks">${V.SLIDES.map(([id, r]) => `<label class="nm-check"><input type="checkbox" name="slide_${id}" checked /> ${esc(r)}</label>`).join("")}</div></fieldset>
    <label class="nm-check"><input type="checkbox" name="ocultarIndisponiveis" checked /> Ocultar slides e indicadores sem dados</label>
    ${campo("Oportunidades de melhoria (texto do mentor)", '<textarea name="oportunidades" rows="3" maxlength="3000"></textarea>')}
    ${campo("Plano recomendado para o próximo ciclo", '<textarea name="plano" rows="3" maxlength="3000"></textarea>')}
    ${campo("Nota privada para a capa", '<textarea name="nota_capa" rows="2" maxlength="2000" placeholder="Só aparece no painel de notas do apresentador…"></textarea>')}`;
  const org = estado.org;
  await dialogo("Gerar nova versão da apresentação", corpo, { rotuloOk: "Gerar e abrir", largo: true, aoConfirmar: (r) => {
    const configuracao = {
      slidesOcultos: V.SLIDES.map(([id]) => id).filter((id) => !valor(r.form, `slide_${id}`)),
      ocultarIndisponiveis: valor(r.form, "ocultarIndisponiveis"),
      oportunidades: valor(r.form, "oportunidades") || null, plano: valor(r.form, "plano") || null,
      notas: valor(r.form, "nota_capa") ? { capa: valor(r.form, "nota_capa") } : {},
    };
    return enviar(r, () => api.nucleoGerarApresentacao(org, { titulo: valor(r.form, "titulo"), configuracao }), async (res) => {
      await abrirPerfil(org, "apresentacoes");
      await abrirVersao(res.apresentacao.id);
    });
  } });
}

async function abrirVersao(id, { imprimir = false } = {}) {
  const org = estado.org;
  try {
    const { apresentacao } = await chamar(() => api.nucleoApresentacao(org, id));
    abrirApresentacao({ apresentacao, imprimir, aoExportar: (aid) => api.nucleoRegistrarExportacao(org, aid, "pdf") });
  } catch (e) { if (e?.status !== 403) toast(e.message); }
}

/** "Apresentar" na listagem: abre a versão mais recente; sem nenhuma, leva à aba Apresentações. */
async function apresentarUltima(org) {
  if (estado.org !== org || !estado.perfil) await abrirPerfil(org, "apresentacoes");
  const ultima = estado.perfil?.apresentacoes?.[0];
  if (ultima) return abrirVersao(ultima.id);
  estado.aba = "apresentacoes"; pintarPerfil();
  toast("Gere a primeira versão da apresentação.");
}
