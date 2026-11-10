// CENTRAL DE CONFERÊNCIAS (painel lateral largo): gestão das pendências financeiras em três abas — Pendências, Sugestões documentais e
// Referências e competências. A organização (grupos, nomes simples, prioridade, filtros) vem de conferenciasModelo.js; os dados vêm de
// GET /conferencias e GET /pendencias-documentais (somente leitura: abrir a Central não altera nada).
// Cada ação usa o endpoint PRÓPRIO do registro, com a permissão, a evidência e a trilha dele. Nada vira "confirmado" sozinho, não há
// aprovação em massa e nenhuma decisão é presumida (origem bancária, natureza de acréscimo, classificação de lançamento).
import { fin } from "./api.js";
import { moeda, rotuloMes, dataBr } from "./modelo.js";
import { abrirPainelHtml } from "./detalhe.js";
import { esc } from "./detalheHtml.js";
import { aviso, dialogo, campo, selecao } from "./ui.js";
import { state } from "../state.js";
import { http } from "../sessao.js";
import * as M from "./conferenciasModelo.js";

const P = Object.freeze({ LANCAR: "gestao_financeira.lancar", EDITAR: "gestao_financeira.editar", CONCILIAR: "gestao_financeira.conciliar", CLASSIFICAR: "gestao_financeira.classificar" });
const R = (c) => (c == null ? "—" : moeda(c));
const badge = (t, tom) => `<span class="fin-badge fin-badge--${tom}">${esc(t)}</span>`;
const badgeStatus = (s) => { const x = M.STATUS[s] ?? M.STATUS.pendente; return badge(x.rotulo, x.tom); };
const CARREGANDO = `<div class="fin-estado" role="status"><span class="fin-spin" aria-hidden="true"></span>Carregando a Central…</div>`;
const ESTADOS_DOC = [{ valor: "pendente", rotulo: "Pendente" }, { valor: "estimado", rotulo: "Estimado" }, { valor: "aguardando_comprovacao", rotulo: "Aguardando comprovação" }];
const paraReais = (c) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));
const ROTULO_CRITERIO = { producao: "período de produção", dias_consumo: "dias de consumo" };

/** Carrega e conta as pendências (usado pelo aviso compacto das telas). */
export async function contarPendencias(mes) {
  try { const d = await fin.get("/conferencias", { mes }); return { total: d.total, geral: d.geral.length, dados: d }; } catch { return null; }
}

// ------------------------------------------------------------------ formulário de pendência documental (cadastro manual / edição)
function corpoFormDoc(v = {}) {
  return `${campo("Descrição da pendência", "descricao", { obrig: true, valor: v.descricao ?? "", extra: 'maxlength="300"' })}
    ${campo("Valor envolvido (se conhecido)", "valor", { valor: paraReais(v.valorCentavos), extra: 'inputmode="decimal" placeholder="ex.: 190,53"' })}
    ${campo("Competência", "competencia", { tipo: "month", obrig: true, valor: v.competencia ?? "" })}
    ${campo("Data de referência (opcional)", "dataReferencia", { tipo: "date", valor: v.dataReferencia ?? "" })}
    ${campo("Motivo da conferência", "motivo", { obrig: true, valor: v.motivo ?? "", extra: 'maxlength="500"' })}
    ${campo("Evidência necessária", "evidenciaNecessaria", { obrig: true, valor: v.evidenciaNecessaria ?? "", extra: 'maxlength="500"' })}
    ${campo("Responsável pela conferência", "responsavel", { obrig: true, valor: v.responsavel ?? "", extra: 'maxlength="120"' })}
    ${selecao("Status", "estado", ESTADOS_DOC, { valor: v.estado ?? "pendente", obrig: true })}
    ${campo("Documento (nome ou local)", "documentoReferencia", { valor: v.documentoReferencia ?? "", extra: 'maxlength="300"' })}
    ${campo("Observações", "observacoes", { valor: v.observacoes ?? "", extra: 'maxlength="1000"' })}
    <p class="fin-sub">Registrar uma pendência não cria movimentação financeira. Para marcar como Confirmado, use “Confirmar” na própria pendência, com evidência.</p>`;
}
const corpoDoc = (f) => ({ descricao: f.get("descricao"), valor: String(f.get("valor") ?? "").trim() || null, competencia: f.get("competencia"), dataReferencia: f.get("dataReferencia") || null, motivo: f.get("motivo"),
  evidenciaNecessaria: f.get("evidenciaNecessaria"), responsavel: f.get("responsavel"), estado: f.get("estado"), documentoReferencia: String(f.get("documentoReferencia") ?? "").trim() || null, observacoes: String(f.get("observacoes") ?? "").trim() || null });
const txt = (f, k) => String(f.get(k) ?? "").trim();

// ------------------------------------------------------------------ referências (não exigem ação imediata)
function htmlComparacao(d) {
  const t = M.textoComparacao(d.resumoComparacao);
  if (t.vazio) return `<p class="cf2-vazio">${esc(t.texto)}</p>`;
  return `<p class="fin-sub">${esc(t.texto)} A apresentação é a referência documental; o sistema não é ajustado para coincidir com ela.</p>
    <div class="fin-tabela-wrap"><table class="fin-tabela fin-tabela--compacta"><thead><tr><th>Indicador</th><th class="fin-num">Sistema</th><th class="fin-num">Apresentação</th><th class="fin-num">Diferença</th></tr></thead><tbody>${d.comparacao.map((x) => `<tr class="${x.confere ? "" : "cf-dif"}"><td data-rot="Indicador">${esc(x.rotulo)}${x.explicacao ? `<br><small>${esc(x.explicacao)}</small>` : ""}</td><td class="fin-num" data-rot="Sistema">${R(x.sistemaCentavos)}</td><td class="fin-num" data-rot="Apresentação">${R(x.apresentacaoCentavos)}</td><td class="fin-num" data-rot="Diferença">${x.confere ? "confere" : x.diferencaCentavos == null ? "—" : moeda(x.diferencaCentavos, { sinal: true })}</td></tr>`).join("")}</tbody></table></div>`;
}
function htmlPeriodos(p) {
  if (!p) return "";
  const a = p.anteriorPagaNoMes, d = p.mesPagoDepois;
  const tab = (cols, linhas) => (linhas.length ? `<div class="fin-tabela-wrap"><table class="fin-tabela fin-tabela--compacta"><thead><tr>${cols.map((c) => `<th${c.num ? ' class="fin-num"' : ""}>${esc(c.t)}</th>`).join("")}</tr></thead><tbody>${linhas.join("")}</tbody></table></div>` : `<p class="cf2-vazio">Nenhuma conta neste caso.</p>`);
  return `<section class="cf2-ref"><h4>Compras de ${esc(rotuloMes(p.mesAnterior))} pagas em ${esc(rotuloMes(p.mes))}</h4>
      <p class="fin-sub">Compras e entregas, por competência: entram no resultado de ${esc(rotuloMes(p.mesAnterior))}, mas o dinheiro saiu em ${esc(rotuloMes(p.mes))}. O que a sócia pagou não saiu do caixa da empresa. Total: <strong>${R(a.totalCentavos)}</strong>.</p>
      ${tab([{ t: "Conta" }, { t: "Tipo" }, { t: "Valor", num: true }], a.itens.map((i) => `<tr><td data-rot="Conta">${esc(i.descricao)}</td><td data-rot="Tipo"><small>${esc(i.tipo)}</small></td><td class="fin-num" data-rot="Valor">${R(i.valorCentavos)}</td></tr>`))}</section>
    <section class="cf2-ref"><h4>Contas de ${esc(rotuloMes(p.mes))} pagas em ${esc(rotuloMes(p.mesSeguinte))}</h4>
      <p class="fin-sub">Entram no resultado de ${esc(rotuloMes(p.mes))}, mas o pagamento acontece no mês seguinte. Pago: <strong>${R(d.totalPagoCentavos)}</strong>; parte no resultado de ${esc(rotuloMes(p.mes))}: <strong>${R(d.totalNoResultadoCentavos)}</strong>.</p>
      ${tab([{ t: "Conta" }, { t: "Pago", num: true }, { t: "No resultado", num: true }], d.itens.map((i) => `<tr><td data-rot="Conta">${esc(i.descricao)}${i.tipo !== "integral" ? ` <small>(${esc(i.tipo)})</small>` : ""}</td><td class="fin-num" data-rot="Pago">${R(i.valorPagoCentavos)}</td><td class="fin-num" data-rot="No resultado">${R(i.noResultadoCentavos)}</td></tr>`))}</section>`;
}
const EXPLICACAO_COMPETENCIA = `<section class="cf2-ref"><h4>Competência e caixa: por que os números de um mês diferem</h4>
  <ul class="cf2-explica"><li><strong>Competência</strong> é o mês a que a despesa pertence (quando a compra foi usada). <strong>Caixa</strong> é o mês em que o dinheiro saiu.</li>
  <li>Compras e entregas seguem a competência; impostos e folha seguem a data do pagamento.</li>
  <li>Por isso uma conta de agosto paga em setembro aparece no caixa de setembro, mas no resultado de agosto — e vice-versa.</li>
  <li>Nada nesta aba altera o faturamento, a DRE ou as Vendas Diárias: são explicações e referências.</li></ul></section>`;

// ------------------------------------------------------------------ Central
export async function abrirCentral(ctx) {
  const st = { mes: ctx.mes, aba: "pendencias", filtros: { status: "todas", responsavel: "", categoria: "", busca: "" }, ordem: "prioridade",
    detalhe: null, d: null, pd: null, pdErro: null, erro: null, carregando: true, perms: ctx.permissoes ?? null, alterou: false };
  let raiz = null;
  const painel = abrirPainelHtml({ titulo: "Central de Conferências", html: `<div class="cf2" data-cf2>${CARREGANDO}</div>`, largo: true,
    aoEscape: () => { if (st.detalhe) { voltar(); return true; } return false; },
    aoFechar: () => { if (st.alterou) ctx.aoAlterar?.(); } });
  raiz = document.querySelector(".fin-pn [data-cf2]");
  if (!raiz) return;

  const pode = (acao) => st.perms == null || st.perms.includes(acao);   // desconhecido: o servidor decide (e recusa com mensagem)
  const semPerm = (acao) => (pode(acao) ? "" : ' disabled title="Seu perfil não permite esta ação"');
  const itens = () => M.linhas(st.d);
  const sug = () => M.sugestoes(st.pd);

  async function carregar() {
    st.carregando = true; if (!st.d) render();
    const [r1, r2, r3] = await Promise.allSettled([fin.get("/conferencias", { mes: st.mes }), fin.get("/pendencias-documentais", { mes: st.mes }),
      st.perms ? Promise.resolve(null) : http.get("/api/v1/gestao-financeira/status")]);
    if (r1.status === "rejected") { st.erro = r1.reason ?? new Error("falha"); st.d = null; } else { st.erro = null; st.d = r1.value; }
    st.pd = r2.status === "fulfilled" ? r2.value : null; st.pdErro = r2.status === "rejected" ? r2.reason : null;
    if (r3.status === "fulfilled" && Array.isArray(r3.value?.data?.permissoes)) st.perms = r3.value.data.permissoes;
    st.carregando = false;
    if (st.detalhe && !itemDoDetalhe()) st.detalhe = null;   // resolvido: o item saiu da lista
    render();
  }
  const depoisDeAcao = async (msg) => { aviso(msg); st.alterou = true; await carregar(); };

  // ------------------------------------------------ render
  function render() {
    if (st.carregando && !st.d && !st.erro) { raiz.innerHTML = CARREGANDO; return; }
    if (st.erro) {
      const negado = st.erro?.status === 403;
      raiz.innerHTML = `<div class="fin-estado fin-estado--erro" role="alert"><h3>${negado ? "Sem permissão para a Central de Conferências" : "Não foi possível carregar a Central agora"}</h3>
        <p>${negado ? "Seu perfil não tem acesso às conferências financeiras desta unidade." : esc(st.erro?.message ?? "Tente novamente em instantes.")}</p>${negado ? "" : '<button type="button" class="btn btn-primary btn-sm" data-cf2-tentar>Tentar novamente</button>'}</div>`;
      return;
    }
    if (st.detalhe) { raiz.innerHTML = htmlDetalhe(); raiz.querySelector("[data-cf2-det-titulo]")?.focus(); if (itemDoDetalhe()?.tipo === "transferencias_internas") carregarMultiplas(); return; }
    raiz.innerHTML = htmlCabecalho() + htmlAbas() + `<div class="cf2-aba" role="tabpanel" id="cf2-painel-${st.aba}" aria-labelledby="cf2-aba-${st.aba}" tabindex="0">${conteudoAba()}</div>`;
  }

  function htmlCabecalho() {
    const cab = M.cabecalho(st.d, st.pd), s = state.sessao ?? {};
    const contexto = [s.empresa?.nome, s.unidade?.nome].filter(Boolean).join(" · ") || "—";
    return `<header class="cf2-cab">
      <div class="cf2-cab-linha"><p class="cf2-contexto"><span class="sr-only">Organização e unidade: </span>${esc(contexto)}</p>
        <label class="cf2-mes"><span>Competência</span><input type="month" value="${esc(st.mes)}" data-cf2-mes></label></div>
      <dl class="cf2-resumo">
        <div><dt>Grupos de pendências em aberto</dt><dd>${cab.grupos}</dd></div>
        <div><dt>Sugestões documentais não cadastradas</dt><dd>${st.pd ? cab.sugestoes : "—"}</dd></div>
        <div><dt>Metodologia gerencial</dt><dd>${badge(cab.metodologia.rotulo, cab.metodologia.aprovada ? "ok" : "warn")}</dd></div>
      </dl></header>`;
  }
  function htmlAbas() {
    const cab = M.cabecalho(st.d, st.pd);
    const abas = [["pendencias", `Pendências (${cab.grupos})`], ["sugestoes", `Sugestões documentais (${st.pd ? cab.sugestoes : "—"})`], ["referencias", "Referências e competências"]];
    return `<div class="cf2-abas" role="tablist" aria-label="Seções da Central">${abas.map(([id, rot]) => `<button type="button" role="tab" id="cf2-aba-${id}" aria-controls="cf2-painel-${id}" aria-selected="${st.aba === id}" tabindex="${st.aba === id ? 0 : -1}" data-cf2-aba="${id}">${esc(rot)}</button>`).join("")}</div>`;
  }
  const conteudoAba = () => (st.aba === "sugestoes" ? htmlSugestoes() : st.aba === "referencias" ? htmlReferencias() : htmlPendencias());

  // ------------------------------------------------ aba 1: pendências
  function htmlPendencias() {
    const todos = itens(), f = st.filtros;
    const opt = (lista, valor) => lista.map((o) => `<option value="${esc(o.valor)}"${o.valor === valor ? " selected" : ""}>${esc(o.rotulo)}</option>`).join("");
    return `<div class="cf2-filtros" role="search">
        <label class="cf2-busca"><span class="sr-only">Buscar</span><input type="search" data-cf2-f="busca" value="${esc(f.busca)}" placeholder="Buscar por nome, valor, fornecedor ou referência" autocomplete="off"></label>
        <label><span>Situação</span><select data-cf2-f="status">${opt(M.FILTROS_STATUS, f.status)}</select></label>
        <label><span>Responsável</span><select data-cf2-f="responsavel"><option value="">Todos</option>${opt(M.responsaveis(todos).map((r) => ({ valor: r, rotulo: r })), f.responsavel)}</select></label>
        <label><span>Categoria</span><select data-cf2-f="categoria"><option value="">Todas</option>${opt(M.CATEGORIAS.map((c) => ({ valor: c.id, rotulo: c.rotulo })), f.categoria)}</select></label>
        <label><span>Ordenar por</span><select data-cf2-f="ordem">${opt(M.ORDENS, st.ordem)}</select></label>
      </div>
      <div class="cf2-barra"><p class="cf2-contagem" role="status" data-cf2-contagem></p>
        <button type="button" class="btn btn-ghost btn-sm" data-cf2-doc-novo${semPerm(P.LANCAR)}>+ Registrar pendência documental</button></div>
      <div data-cf2-lista>${htmlLista()}</div>`;
  }
  function htmlLista() {
    const todos = itens(), f = st.filtros;
    const vis = M.ordenar(M.filtrar(todos, f), st.ordem);
    const grupos = M.agrupar(vis).filter((g) => g.itens.length);
    const filtrado = f.busca || f.status !== "todas" || f.responsavel || f.categoria;
    queueMicrotask(() => { const c = raiz.querySelector("[data-cf2-contagem]"); if (!c) return; const conc = todos.filter((p) => p.status === "confirmado").length, abertos = todos.length - conc;
      c.textContent = filtrado ? `Mostrando ${vis.length} de ${todos.length}` : `${abertos} em aberto${conc ? ` · ${conc} concluída${conc === 1 ? "" : "s"}` : ""}`; });
    if (!todos.length) return `<div class="cf2-vazio-bloco"><h4>Nenhuma pendência registrada para ${esc(rotuloMes(st.mes))}</h4><p>Tudo o que dependia de decisão ou evidência neste mês foi tratado.</p></div>`;
    if (!vis.length) return `<div class="cf2-vazio-bloco"><h4>Nenhum item corresponde aos filtros</h4><button type="button" class="btn btn-ghost btn-sm" data-cf2-limpar>Limpar filtros</button></div>`;
    return grupos.map((g) => `<section class="cf2-grupo" aria-labelledby="cf2-g-${g.id}"><h4 id="cf2-g-${g.id}">${esc(g.rotulo)} <span class="cf2-qtd">${g.itens.length}</span></h4>
      <ul class="cf2-lista">${g.itens.map(htmlLinha).join("")}</ul></section>`).join("");
  }
  function htmlLinha(p) {
    const r = p.resumo, pr = p.prioridade;
    const valor = r.valorRotulo ? `<span class="cf2-valor-rot">${esc(r.valorRotulo)}</span>` : r.valor != null ? `<strong class="cf2-valor">${R(r.valor)}</strong>` : "";
    return `<li class="cf2-item" data-cf2-item="${esc(p.id)}">
      <div class="cf2-item-texto"><h5 class="cf2-nome">${esc(r.nome)}</h5><p class="cf2-motivo">${esc(r.motivo)}</p></div>
      <div class="cf2-item-valor">${valor}</div>
      <div class="cf2-item-meta">${badgeStatus(p.status)}<span class="cf2-resp" title="Responsável pela conferência">${esc(M.responsavelCurto(p.responsavel))}</span>${pr.nivel !== "normal" ? `<span class="cf2-prio cf2-prio--${pr.nivel}" title="${esc(pr.criterio)}">Prioridade ${esc(M.ROTULO_PRIORIDADE[pr.nivel])}</span>` : ""}</div>
      <button type="button" class="btn btn-ghost btn-sm cf2-revisar" data-cf2-revisar="${esc(p.id)}" aria-label="Revisar: ${esc(r.nome)}">Revisar</button></li>`;
  }

  // ------------------------------------------------ aba 2: sugestões documentais
  function htmlSugestoes() {
    if (!st.pd) return `<div class="cf2-vazio-bloco" role="alert"><h4>Não foi possível carregar as sugestões documentais</h4><p>${esc(st.pdErro?.message ?? "Tente novamente.")}</p></div>`;
    const s = sug();
    const rel = s.relacoes.map((x) => `<aside class="cf2-relacao" aria-label="Valores relacionados"><h5>Valores relacionados: ${R(x.maior.valorCentavos)} e ${R(x.menor.valorCentavos)}</h5>
      <p><strong>${esc(x.conta)}</strong>.</p><p>${esc(x.texto)}</p>${x.origemDiferenca ? `<p class="fin-sub">${esc(x.origemDiferenca)}</p>` : ""}</aside>`).join("");
    const linha = (m) => `<li class="cf2-item">
      <div class="cf2-item-texto"><h5 class="cf2-nome">${esc(m.descricao)}</h5><p class="cf2-motivo">${esc(M.primeiraFrase(m.motivo))}</p></div>
      <div class="cf2-item-valor">${m.valorCentavos != null ? `<strong class="cf2-valor">${R(m.valorCentavos)}</strong>` : `<span class="cf2-valor-rot">valor a apurar</span>`}</div>
      <div class="cf2-item-meta">${badge("Sugestão", "muted")}<span class="cf2-resp">${esc(M.responsavelCurto(m.responsavel))}</span>${m.relacionadaChave ? '<span class="cf2-prio cf2-prio--rel">Relacionada</span>' : ""}</div>
      <button type="button" class="btn btn-ghost btn-sm cf2-revisar" data-cf2-sug="${esc(m.chave)}" aria-label="Revisar e cadastrar: ${esc(m.descricao)}">Revisar e cadastrar</button></li>`;
    return `<p class="fin-sub">Sugestões preparadas a partir da documentação do mês. <strong>Nenhuma é cadastrada sozinha</strong>: revise cada uma e cadastre ou dispense com justificativa.</p>
      ${rel}
      ${s.abertas.length ? `<ul class="cf2-lista">${s.abertas.map(linha).join("")}</ul>` : `<div class="cf2-vazio-bloco"><h4>Nenhuma sugestão documental pendente para ${esc(rotuloMes(st.mes))}</h4></div>`}
      ${s.dispensadas.length ? `<details class="cf2-dispensadas"><summary>Dispensadas (${s.dispensadas.length})</summary><ul class="cf2-lista">${s.dispensadas.map((m) => `<li class="cf2-item cf2-item--dispensada">
        <div class="cf2-item-texto"><h5 class="cf2-nome">${esc(m.descricao)}</h5><p class="cf2-motivo">Dispensada em ${esc(dataBr(String(m.dispensada.em ?? "").slice(0, 10)))}: ${esc(m.dispensada.justificativa)}</p></div>
        <div class="cf2-item-valor">${m.valorCentavos != null ? R(m.valorCentavos) : ""}</div><div class="cf2-item-meta">${badge("Dispensada", "muted")}</div>
        <button type="button" class="btn btn-ghost btn-sm cf2-revisar" data-cf2-sug="${esc(m.chave)}" aria-label="Revisar: ${esc(m.descricao)}">Revisar</button></li>`).join("")}</ul></details>` : ""}`;
  }

  // ------------------------------------------------ aba 3: referências e competências
  function htmlReferencias() {
    const cab = M.cabecalho(st.d, st.pd);
    return `<p class="fin-sub">Explicações e referências do mês. Nada aqui exige ação imediata, e nada aqui altera o faturamento, a DRE ou as Vendas Diárias.</p>
      <section class="cf2-ref"><h4>Metodologia gerencial ${badge(cab.metodologia.rotulo, cab.metodologia.aprovada ? "ok" : "warn")}</h4><p class="fin-sub">${esc(cab.metodologia.texto)}</p></section>
      <section class="cf2-ref"><h4>Sistema × apresentação oficial</h4>${htmlComparacao(st.d)}</section>
      ${htmlPeriodos(st.d.periodos)}
      ${EXPLICACAO_COMPETENCIA}
      <section class="cf2-ref"><details data-cf2-hist-geral><summary><strong>Histórico de decisões</strong></summary><div data-cf2-hist-geral-corpo><p class="fin-sub">Carregando…</p></div></details></section>`;
  }

  // ------------------------------------------------ detalhe (Revisar)
  function itemDoDetalhe() {
    if (!st.detalhe) return null;
    if (st.detalhe.tipo === "sugestao") return (st.pd?.modelos ?? []).find((m) => m.chave === st.detalhe.chave && !m.cadastrada) ?? null;
    return itens().find((p) => p.id === st.detalhe.id) ?? null;
  }
  function abrirDetalhe(det) { st.detalhe = det; render(); }
  function voltar() {
    const det = st.detalhe; st.detalhe = null; render();
    const alvo = det && raiz.querySelector(det.tipo === "sugestao" ? `[data-cf2-sug="${CSS.escape(det.chave)}"]` : `[data-cf2-revisar="${CSS.escape(det.id)}"]`);
    alvo?.focus();
  }

  const secao = (n, titulo, html) => (html ? `<li class="cf2-secao"><h5><span class="cf2-num" aria-hidden="true">${n}</span>${esc(titulo)}</h5><div>${html}</div></li>` : "");
  const par = (t) => (t ? `<p>${esc(t)}</p>` : "");
  const lista = (xs) => (xs?.length ? `<ul class="cf2-ul">${xs.map((x) => `<li>${x}</li>`).join("")}</ul>` : "");
  const navegar = (rota, rotulo) => `<button type="button" class="btn btn-ghost btn-sm" data-cf2-ir="${esc(rota)}">${esc(rotulo)}</button>`;
  const botaoHist = `<button type="button" class="btn btn-ghost btn-sm" data-cf2-hist>Ver histórico</button><div data-cf2-hist-corpo></div>`;

  function htmlDetalhe() {
    const x = itemDoDetalhe();
    if (!x) return `<button type="button" class="btn btn-ghost btn-sm" data-cf2-voltar>← Voltar para a lista</button><p class="cf2-vazio">Este item não está mais pendente.</p>`;
    const c = st.detalhe.tipo === "sugestao" ? detalheSugestao(x) : detalhePendencia(x);
    return `<div class="cf2-det">
      <button type="button" class="btn btn-ghost btn-sm" data-cf2-voltar>← Voltar para a lista</button>
      <header class="cf2-det-cab"><p class="cf2-det-cat">${esc(c.categoria)}</p><h4 tabindex="-1" data-cf2-det-titulo>${esc(c.nome)}</h4>
        <div class="cf2-det-meta">${c.valorHtml ?? ""}${c.statusHtml ?? ""}${c.responsavel ? `<span class="cf2-resp">Responsável: ${esc(c.responsavel)}</span>` : ""}${c.prioridadeHtml ?? ""}</div></header>
      ${c.destaque ?? ""}
      <ol class="cf2-secoes">
        ${secao(1, "O que aconteceu", c.aconteceu)}
        ${secao(2, "Por que está pendente", c.pendente)}
        ${secao(3, "O documento que falta", c.documento)}
        ${secao(4, "O que precisa ser conferido", c.conferir)}
        ${secao(5, "Valores e registros relacionados", c.relacionados)}
        ${secao(6, "Evidências disponíveis", c.evidencias || '<p class="cf2-vazio">Nenhuma evidência registrada ainda.</p>')}
        ${secao(7, "Histórico", c.historico ?? botaoHist)}
        ${secao(8, "Próxima ação permitida", c.acoes || '<p class="cf2-vazio">Nenhuma ação no sistema: depende de documento ou decisão externa.</p>')}
      </ol>
      ${c.tecnico ? `<details class="cf2-tec"><summary>Detalhes técnicos</summary>${c.tecnico}</details>` : ""}
      <p class="fin-sub" data-cf2-resultado role="status"></p></div>`;
  }

  function detalhePendencia(p) {
    const r = p.resumo, cat = M.CATEGORIAS.find((c) => c.id === p.categoria)?.rotulo ?? "";
    const base = { categoria: cat, nome: r.nome, responsavel: M.responsavelCurto(p.responsavel), statusHtml: badgeStatus(p.status),
      valorHtml: r.valorRotulo ? `<span class="cf2-valor-rot">${esc(r.valorRotulo)}</span>` : r.valor != null ? `<strong class="cf2-valor">${R(r.valor)}</strong>` : "",
      prioridadeHtml: `<span class="cf2-prio cf2-prio--${p.prioridade.nivel}" title="${esc(p.prioridade.criterio)}">Prioridade ${esc(M.ROTULO_PRIORIDADE[p.prioridade.nivel])}: ${esc(p.prioridade.criterio)}</span>`,
      documento: par(p.evidenciaNecessaria), evidencias: lista((p.evidencias ?? []).map(esc)),
      tecnico: `<p>${esc(p.descricao ?? "")}</p><p class="fin-sub">Tipo: <code>${esc(p.tipo)}</code> · referência: <code>${esc(p.id)}</code></p>` };
    const t = TIPOS[p.tipo];
    return t ? { ...base, ...t(p, base) } : { ...base, aconteceu: par(p.descricao), pendente: par(p.motivo) };
  }

  // Conteúdo por natureza do registro: cada um com as SUAS ações (nunca um botão genérico de aprovação).
  const TIPOS = {
    ajuste_vendas: (p) => {
      const v = Math.abs(p.valorCentavos ?? 0), ck = p.checklist;
      return {
        aconteceu: par(`O painel do ${p.canal} mostra um valor maior do que a base usada no faturamento gerencial. A diferença de ${moeda(v)} foi registrada como ajuste ESTIMADO (taxas de entrega e descontos).`),
        pendente: par("O valor ainda não foi comprovado por um relatório do canal. Enquanto isso, continua estimado — e o faturamento gerencial oficial não é alterado por esta tela."),
        conferir: ck ? `<p><strong>Onde:</strong> ${esc(ck.onde)}</p><ol class="cf2-ul">${ck.precisaInformar.map((t) => `<li>${esc(t)}</li>`).join("")}</ol><p><strong>A conta:</strong> ${esc(ck.conta)}</p>` : par("Relatório do canal com taxa de entrega e descontos do mesmo período."),
        relacionados: lista([`Ajuste estimado: <strong>${R(v)}</strong>`, `Canal: ${esc(p.canal ?? "—")}`]),
        acoes: `<form class="cf2-form" data-cf2-acao="confirmar_ajuste" novalidate>
          <p class="cf2-aviso">Só confirme se o relatório compatível do Portal do Parceiro fechar <strong>exatamente</strong> com ${R(v)}. Se não fechar, não confirme: registre a diferença.</p>
          <label class="cf2-check"><input type="checkbox" name="compativel" required><span>O relatório do Portal do Parceiro, para os mesmos pedidos e período, soma exatamente ${R(v)}</span></label>
          <label class="fin-campo"><span>Evidência (nome do relatório, período e valores) *</span><textarea name="evidencia" rows="2" maxlength="500" required minlength="5"></textarea></label>
          <button type="submit" class="btn btn-primary btn-sm"${semPerm(P.CLASSIFICAR)}>Confirmar, quando autorizado</button></form>`,
        tecnico: `<p>${esc(p.descricao)}</p>${ck ? `<p>${esc(ck.comoConfirmar)}</p><p class="fin-sub">Situação: ${esc(ck.situacao)}</p>` : ""}<p class="fin-sub">Endpoint: <code>${esc(p.acao?.caminho ?? "")}</code></p>`,
      };
    },
    rateios: (p) => ({
      aconteceu: par(`Algumas compras e entregas beneficiam mais de um mês. Foram propostos ${p.itens.length} rateios que dividem esse custo entre competências.`),
      pendente: par("Um rateio proposto só vale depois que a contadora aprova — um de cada vez, conferindo o documento. Não existe aprovação em massa."),
      conferir: par("Em cada rateio: o valor, as competências, o critério e a evidência."),
      relacionados: `<ul class="cf2-cards">${p.itens.map((x) => `<li class="cf2-card" data-cf2-rateio="${esc(x.id)}">
          <h6>${esc(x.obrigacao)} <strong>${R(x.valorElegivelCentavos)}</strong></h6>
          <p class="fin-sub">${esc([x.fornecedor, x.categoria].filter(Boolean).join(" · "))}${x.competenciaObrigacao ? ` · competência da conta ${esc(rotuloMes(String(x.competenciaObrigacao).slice(0, 7)))}` : ""}</p>
          <p><strong>Competências:</strong> ${x.parcelas.map((q) => `${esc(rotuloMes(String(q.competencia).slice(0, 7)))} ${R(q.valorCentavos)}`).join(" · ")}</p>
          <p><strong>Critério:</strong> ${esc(ROTULO_CRITERIO[x.criterio] ?? x.criterio)} — ${esc(x.justificativa ?? "")}</p>
          <p><strong>Evidência:</strong> ${x.evidencia ? esc(x.evidencia) : "sem documento anexado; a evidência é o critério acima."}</p>
          <label class="cf2-check"><input type="checkbox" data-cf2-conferi><span>Conferi o documento deste rateio</span></label>
          <button type="button" class="btn btn-primary btn-sm" data-cf2-aprovar="${esc(x.id)}"${semPerm(P.CLASSIFICAR)} aria-label="Aprovar o rateio ${esc(x.obrigacao)}">Confirmar este rateio</button></li>`).join("")}</ul>`,
      acoes: par("Confirme cada rateio no próprio cartão acima. A aprovação fica registrada com o seu usuário e o horário."),
    }),
    juros_presumido: (p) => {
      const e = p.etapas ?? {}, sug = p.sugestao;
      return {
        aconteceu: par(M.primeiraFrase(p.descricao)),
        pendente: par("O sistema não decide se a diferença é juros, multa ou tarifa. São duas decisões separadas: quitar a conta e, depois, classificar o acréscimo."),
        conferir: par("Boleto, extrato ou nota com o vencimento, a data do pagamento e o valor dos encargos."),
        relacionados: lista([`Acréscimo: <strong>${R(p.valorCentavos)}</strong>`, p.vencimento ? `Vencimento: ${esc(dataBr(p.vencimento))}` : null, p.data ? `Primeiro pagamento: ${esc(dataBr(p.data))}` : null,
          sug ? `Sugestão da apresentação: ${esc(sug.natureza)} — ${esc(sug.evidencia)}` : null].filter(Boolean)),
        acoes: `<div class="cf2-etapa"><h6>Decisão 1 — Quitar ou conciliar a obrigação</h6>${p.quitada ? '<p>✓ A conta já está quitada. As datas dos pagamentos foram preservadas.</p>'
            : `<p class="fin-sub">Quitar marca a conta como paga com base nos pagamentos já registrados; as datas e valores originais são mantidos.</p><button type="button" class="btn btn-ghost btn-sm" data-cf2-quitar${semPerm(P.CONCILIAR)}>Quitar a conta</button>`}</div>
          <form class="cf2-etapa cf2-form" data-cf2-acao="classificar_acrescimo" novalidate><h6>Decisão 2 — Classificar a natureza do acréscimo</h6>
            ${p.quitada ? "" : '<p class="fin-sub">Disponível depois da quitação (a classificação vale para a diferença final da conta).</p>'}
            <label class="fin-campo"><span>Natureza *</span><select name="classificacao" required>${["juros", "multa", "tarifa", "outro"].map((n) => `<option value="${n}"${sug?.natureza === n ? " selected" : ""}>${n[0].toUpperCase()}${n.slice(1)}</option>`).join("")}</select></label>
            <button type="submit" class="btn btn-primary btn-sm"${p.quitada ? semPerm(P.CLASSIFICAR) : " disabled"}>Classificar o acréscimo</button></form>`,
        tecnico: `<p>${esc(p.descricao)}</p>${sug ? `<p class="fin-sub">${esc(sug.motivo)}</p>` : ""}`,
      };
    },
    conta_sem_pagamento: (p) => ({
      aconteceu: par(`A conta “${M.resumir(p).nome.replace(/^Conta vencida — /, "")}” venceu em ${dataBr(p.vencimento)} e não há pagamento registrado.`),
      pendente: par("Se foi paga, falta registrar o pagamento com a conta de onde o dinheiro saiu. O sistema não presume a origem."),
      relacionados: lista([`Valor: <strong>${R(p.valorCentavos)}</strong>`, p.fornecedor ? `Fornecedor: ${esc(p.fornecedor)}` : null, p.categoria ? `Categoria: ${esc(p.categoria)}` : null].filter(Boolean)),
      acoes: pode(P.LANCAR) ? navegar("fin-contas-a-pagar", "Registrar pagamento em Contas a Pagar") : par("Seu perfil não registra pagamentos."),
    }),
    origem_pendente: (p) => ({
      aconteceu: par(`Um pagamento de ${moeda(p.valorCentavos)} foi feito em ${dataBr(p.data)} e já entra como despesa, mas não se sabe de qual conta o dinheiro saiu.`),
      pendente: par("Sem o comprovante bancário, a origem continua pendente. Nenhuma conta bancária é presumida; até lá não há saída bancária registrada nem conciliação."),
      relacionados: lista([`Pagamento: <strong>${R(p.valorCentavos)}</strong> em ${esc(dataBr(p.data))}`]),
      acoes: `<form class="cf2-form" data-cf2-acao="resolver_origem" novalidate>
          <label class="cf2-check"><input type="checkbox" name="comprovante" required><span>Tenho o comprovante bancário que mostra a conta de saída</span></label>
          <label class="fin-campo"><span>Conta de onde o dinheiro saiu *</span><select name="contaId" required><option value="">Escolha…</option>${(p.contas ?? []).map((c) => `<option value="${esc(c.id)}">${esc(c.nome)}</option>`).join("")}</select></label>
          <button type="submit" class="btn btn-primary btn-sm"${semPerm(P.CONCILIAR)}>Informar a conta de saída</button></form>`,
    }),
    pagamento_terceiro: (p) => {
      const nome = p.terceiroNome ?? "um terceiro";
      return {
        destaque: `<p class="cf2-destaque" role="note"><strong>${esc(nome)} pagou com recursos pessoais.</strong> Não houve saída de conta bancária da empresa: <strong>não registre saída bancária</strong> para este pagamento. O valor fica como dívida da empresa com ${esc(nome)}.</p>`,
        aconteceu: par(`${nome} pagou ${moeda(p.valorCentavos)} em ${dataBr(p.data)}${p.obrigacao ? ` a conta “${p.obrigacao.descricao}”` : ""}, com dinheiro próprio.`),
        pendente: par("Falta o comprovante do pagamento e o combinado de reembolso. A despesa já está reconhecida; o caixa da empresa não foi afetado."),
        relacionados: lista([`Pagamento: <strong>${R(p.valorCentavos)}</strong> em ${esc(dataBr(p.data))}`,
          p.obrigacao ? `Conta a pagar: ${esc(p.obrigacao.descricao)} (${R(p.obrigacao.valorOriginalCentavos)})` : null,
          p.divida ? `Dívida de reembolso: ${esc(p.divida.descricao ?? "vinculada")}` : "Dívida de reembolso: vínculo não informado"].filter(Boolean)),
        acoes: `${navegar("fin-contas-a-pagar", "Revisar a conta em Contas a Pagar")} ${navegar("fin-dividas", "Revisar a dívida em Dívidas e Empréstimos")}
          <p class="fin-sub">As alterações do pagamento e do vínculo seguem as permissões e as travas dessas telas.</p>`,
      };
    },
    transferencias_internas: (p) => {
      const um = p.linhas.filter((l) => l.status === "um_para_um"), varios = p.linhas.filter((l) => l.status === "um_para_varios"), amb = p.linhas.filter((l) => l.status === "ambiguo");
      const c = (x) => `${esc(dataBr(x.data))} · ${esc(x.conta)} · <strong>${R(x.valorCentavos)}</strong>`;
      const idx = (l) => p.linhas.indexOf(l);
      const det = (l, corpo) => `<li><details class="cf2-par"><summary>${c(l.saida)} <small>${esc(l.saida.descricao ?? "")}</small></summary><div class="cf2-par-corpo">${corpo}</div></details></li>`;
      return {
        aconteceu: par(`Foram encontradas ${p.linhas.length} saídas que parecem transferências entre contas da própria empresa, com entradas correspondentes propostas.`),
        pendente: par("Nenhum vínculo é feito sozinho: cada par precisa ser conferido no extrato das duas contas."),
        conferir: par(`${um.length} com correspondência 1:1 (uma saída, uma entrada de mesmo valor) · ${varios.length} com uma saída e várias entradas${amb.length ? ` · ${amb.length} ambíguas` : ""}.`),
        relacionados: `<h6>Correspondência 1:1 (${um.length})</h6>${um.length ? `<ul class="cf2-pares">${um.map((l) => det(l, `<p><strong>Saída:</strong> ${c(l.saida)}</p><p><strong>Entrada proposta:</strong> ${c(l.contrapartidas[0])}</p>
              <button type="button" class="btn btn-primary btn-sm" data-cf2-vincular="${idx(l)}"${semPerm(P.CONCILIAR)}>Vincular este par</button>`)).join("")}</ul>` : '<p class="cf2-vazio">Nenhuma.</p>'}
          <h6>Uma saída × várias entradas (${varios.length})</h6>${varios.length ? `<ul class="cf2-pares">${varios.map((l) => { const soma = l.contrapartidas.reduce((a, x) => a + x.valorCentavos, 0); return det(l, `<p><strong>Saída:</strong> ${c(l.saida)}</p>
              <p><strong>Entradas propostas:</strong></p><ul class="cf2-ul">${l.contrapartidas.map((x) => `<li>${c(x)}</li>`).join("")}</ul><p>Soma das entradas ${R(soma)} ${soma === l.saida.valorCentavos ? "= saída" : "≠ saída — não fecha"}</p>
              <button type="button" class="btn btn-primary btn-sm" data-cf2-multipla="${idx(l)}"${semPerm(P.CONCILIAR)}>Conciliar com justificativa</button>`); }).join("")}</ul>` : '<p class="cf2-vazio">Nenhuma.</p>'}
          ${amb.length ? `<h6>Ambíguas (${amb.length})</h6><ul class="cf2-pares">${amb.map((l) => det(l, `<p>${l.alternativas.length} combinações possíveis: conferir no extrato antes de qualquer vínculo.</p>`)).join("")}</ul>` : ""}
          ${p.outras?.length ? `<details><summary>${p.outras.length} outras saídas parecidas com transferência, sem contrapartida de mesmo valor</summary><ul class="cf2-ul">${p.outras.map((l) => `<li>${c(l.saida)} <small>${esc(l.saida.descricao ?? "")}</small></li>`).join("")}</ul></details>` : ""}
          <div data-cf2-multiplas></div>`,
        acoes: par("Abra cada par acima e vincule individualmente. Vincular exige a permissão de conciliar e pode ser desfeito com motivo; os lançamentos não são alterados."),
        tecnico: `<p>${esc(p.descricao)}</p>`,
      };
    },
    classificacao_pendente: (p) => ({
      aconteceu: par(`${p.itens.length} movimentações do mês ainda não têm classificação (natureza e categoria).`),
      pendente: par("Falta o documento que identifique cada uma. Nenhum lançamento é reclassificado por aproximação."),
      relacionados: `<div class="fin-tabela-wrap"><table class="fin-tabela fin-tabela--compacta cf2-tabela"><thead><tr><th>Data</th><th>Conta</th><th class="fin-num">Valor</th><th>Descrição</th><th><span class="sr-only">Ação</span></th></tr></thead><tbody>
        ${p.itens.map((x, i) => `<tr><td data-rot="Data">${esc(dataBr(x.data))}</td><td data-rot="Conta">${esc(x.conta)}</td><td class="fin-num" data-rot="Valor">${x.sentido === "entrada" ? "+" : "−"}${R(x.valorCentavos)}</td><td data-rot="Descrição">${esc(x.descricao ?? "")}</td>
          <td><button type="button" class="btn btn-ghost btn-sm" data-cf2-lanc="${i}" aria-expanded="false" aria-controls="cf2-lanc-${i}">Revisar</button></td></tr>
          <tr class="cf2-lanc-det" id="cf2-lanc-${i}" hidden><td colspan="5"><p><strong>Evidência necessária:</strong> ${esc(p.evidenciaNecessaria ?? "documento que identifique a natureza e a categoria.")}</p>${x.nota ? `<p><strong>Nota da revisão:</strong> ${esc(x.nota)}</p>` : ""}</td></tr>`).join("")}</tbody></table></div>`,
      acoes: `${navegar("fin-fluxo-de-caixa", "Classificar no Fluxo de Caixa")}<p class="fin-sub">A classificação é feita lançamento a lançamento, com o documento.</p>`,
    }),
    categoria_sem_regra: (p) => ({
      aconteceu: par("Algumas categorias do plano de contas ainda não têm regra gerencial (em qual grupo da DRE entram)."),
      pendente: par("Sem a regra, os valores dessas categorias não são distribuídos na DRE gerencial."),
      relacionados: lista(String(p.descricao ?? "").split(/,\s*/).filter(Boolean).map(esc)),
      acoes: navegar("fin-configuracoes", "Definir regras em Configurações Financeiras"),
    }),
    divergencia_canais: (p) => ({
      aconteceu: par("A soma das vendas por canal (Balcão, Anota Aí, iFood) não bate com o faturamento bruto oficial do mês."),
      pendente: par("É preciso localizar a diferença nos relatórios de vendas; o faturamento oficial não é alterado."),
      relacionados: lista([`Diferença: <strong>${R(p.valorCentavos)}</strong>`]),
      acoes: navegar("fin-receitas", "Abrir Receitas e Vendas"),
    }),
    pendencia_documental: (p) => {
      if (p.concluida) return {
        aconteceu: par(p.titulo), pendente: par("Concluída com evidência."),
        evidencias: lista([`Evidência: ${esc(p.confirmacao?.evidencia ?? "—")}`, p.documentoReferencia ? `Documento: ${esc(p.documentoReferencia)}` : null, p.confirmacao?.em ? `Confirmada em ${esc(dataBr(String(p.confirmacao.em).slice(0, 10)))}` : null].filter(Boolean)),
        acoes: "",
      };
      return {
        aconteceu: par(`${p.titulo}${p.dataReferencia ? ` (referência: ${dataBr(p.dataReferencia)})` : ""}.`),
        pendente: par(p.motivo),
        conferir: p.observacoes ? par(p.observacoes) : "",
        relacionados: lista([p.valorCentavos != null ? `Valor envolvido: <strong>${R(p.valorCentavos)}</strong>` : "Valor a apurar",
          p.relacionadaChave ? "Possivelmente relacionada a outra pendência documental: validar antes de tratar como itens independentes." : null, p.aviso ? esc(p.aviso) : null].filter(Boolean)),
        evidencias: p.documentoReferencia ? lista([`Documento: ${esc(p.documentoReferencia)}`]) : "",
        historico: botaoHist,
        acoes: `<div class="cf2-acoes">
            <button type="button" class="btn btn-ghost btn-sm" data-cf2-doc="evidencia"${semPerm(P.EDITAR)}>Adicionar evidência</button>
            <button type="button" class="btn btn-ghost btn-sm" data-cf2-doc="encaminhar"${semPerm(P.EDITAR)}>Encaminhar para conferência</button>
            <button type="button" class="btn btn-primary btn-sm" data-cf2-doc="confirmar"${semPerm(P.CLASSIFICAR)}>Confirmar, quando autorizado</button>
            <button type="button" class="btn btn-ghost btn-sm" data-cf2-doc="editar"${semPerm(P.EDITAR)}>Editar</button>
            <button type="button" class="btn btn-ghost btn-sm" data-cf2-doc="cancelar"${semPerm(P.EDITAR)}>Cancelar registro</button></div>
          <p class="fin-sub">Nenhuma destas ações cria lançamento, pagamento ou conciliação.</p>`,
      };
    },
  };

  function detalheSugestao(m) {
    const rel = sug().relacoes.find((x) => x.chaves.includes(m.chave));
    return {
      categoria: "Sugestão documental", nome: m.descricao, responsavel: M.responsavelCurto(m.responsavel),
      valorHtml: m.valorCentavos != null ? `<strong class="cf2-valor">${R(m.valorCentavos)}</strong>` : '<span class="cf2-valor-rot">valor a apurar</span>',
      statusHtml: m.dispensada ? badge("Dispensada", "muted") : badge("Sugestão — não cadastrada", "muted"),
      destaque: rel ? `<aside class="cf2-relacao"><h5>Relacionada a outra sugestão</h5><p><strong>${esc(rel.conta)}</strong>.</p><p>${esc(rel.texto)}</p></aside>` : "",
      aconteceu: par(m.motivo), pendente: par("Ainda não está cadastrada. Cadastrar cria uma pendência documental para acompanhamento — sem lançamento, pagamento ou conciliação."),
      documento: par(m.evidenciaNecessaria), conferir: par(m.observacoes),
      relacionados: lista([m.valorCentavos != null ? `Valor: <strong>${R(m.valorCentavos)}</strong>` : "Valor a apurar", m.dataReferencia ? `Data de referência: ${esc(dataBr(m.dataReferencia))}` : null, `Status sugerido: ${esc(M.STATUS[m.estado]?.rotulo ?? m.estado)}`].filter(Boolean)),
      evidencias: m.dispensada ? lista([`Dispensada em ${esc(dataBr(String(m.dispensada.em ?? "").slice(0, 10)))}: ${esc(m.dispensada.justificativa)}`]) : "",
      historico: '<p class="cf2-vazio">Sugestão ainda não cadastrada: sem histórico próprio.</p>',
      acoes: `<div class="cf2-acoes"><button type="button" class="btn btn-primary btn-sm" data-cf2-sug-cadastrar="${esc(m.chave)}"${semPerm(P.LANCAR)}>Cadastrar como pendência</button>
        ${m.dispensada ? "" : `<button type="button" class="btn btn-ghost btn-sm" data-cf2-sug-dispensar="${esc(m.chave)}"${semPerm(P.EDITAR)}>Dispensar com justificativa</button>`}</div>`,
    };
  }

  // ------------------------------------------------ histórico
  async function carregarHistorico(alvo, p) {
    alvo.innerHTML = '<p class="fin-sub">Carregando…</p>';
    try {
      let itensH;
      if (p.tipo === "pendencia_documental") itensH = (await fin.get(`/pendencias-documentais/${p.docId}/historico`, {})).itens;
      else { const refs = new Set(p.refs ?? []); itensH = (await fin.get("/conferencias/historico", {})).itens.filter((i) => refs.has(i.entidadeId)); }
      alvo.innerHTML = itensH.length ? `<ul class="cf2-ul">${itensH.map((i) => `<li>${esc(dataBr(String(i.em).slice(0, 10)))} · ${esc(i.acao)}${i.entidade ? ` · ${esc(i.entidade.replace("fin_", "").replace(/_/g, " "))}` : ""}</li>`).join("")}</ul>` : '<p class="cf2-vazio">Sem registros para este item.</p>';
    } catch (err) { alvo.innerHTML = `<p class="fin-sub">${esc(err?.status === 403 ? "Seu perfil não pode ver o histórico." : err?.message ?? "Não foi possível carregar o histórico.")}</p>`; }
  }

  async function carregarMultiplas() {
    const alvo = raiz.querySelector("[data-cf2-multiplas]"); if (!alvo) return;
    try {
      const lista = await fin.get("/transferencias/multiplas");
      alvo.innerHTML = lista.length ? `<h6>Já conciliadas com várias entradas (${lista.length})</h6><ul class="cf2-ul">${lista.map((m) => `<li><strong>${R(m.valorCentavos)}</strong> · saída ${esc(dataBr(m.saida.data))} ${esc(m.saida.conta)} ⇄ ${m.entradas.map((y) => `${esc(dataBr(y.data))} ${esc(y.conta)} ${R(y.valorCentavos)}`).join(" + ")}<br><small>Justificativa: ${esc(m.justificativa)} · aprovada em ${esc(dataBr(String(m.aprovadoEm).slice(0, 10)))}</small> <button type="button" class="btn btn-ghost btn-sm" data-cf2-desfazer="${esc(m.id)}"${semPerm(P.CONCILIAR)}>Desfazer</button></li>`).join("")}</ul>` : "";
    } catch { alvo.innerHTML = ""; }
  }

  // ------------------------------------------------ eventos (delegados)
  const saida = (t) => { const s = raiz.querySelector("[data-cf2-resultado]"); if (s) s.textContent = t; };
  const ir = async (rota) => { painel.fechar(); const { irPara } = await import("../router.js"); irPara(rota); };

  raiz.addEventListener("input", (e) => {
    const f = e.target.closest("[data-cf2-f='busca']");
    if (!f) return;
    st.filtros.busca = f.value;
    raiz.querySelector("[data-cf2-lista]").innerHTML = htmlLista();
  });
  raiz.addEventListener("change", (e) => {
    const f = e.target.closest("[data-cf2-f]");
    if (f && f.dataset.cf2F !== "busca") {
      if (f.dataset.cf2F === "ordem") st.ordem = f.value; else st.filtros[f.dataset.cf2F] = f.value;
      raiz.querySelector("[data-cf2-lista]").innerHTML = htmlLista();
      return;
    }
    const mes = e.target.closest("[data-cf2-mes]");
    if (mes && /^\d{4}-\d{2}$/.test(mes.value) && mes.value !== st.mes) { st.mes = mes.value; st.d = null; carregar(); }
  });
  raiz.addEventListener("keydown", (e) => {
    const aba = e.target.closest("[role=tab]");
    if (!aba) return;
    const abas = [...raiz.querySelectorAll("[role=tab]")], i = abas.indexOf(aba);
    const alvo = { ArrowRight: abas[(i + 1) % abas.length], ArrowLeft: abas[(i - 1 + abas.length) % abas.length], Home: abas[0], End: abas[abas.length - 1] }[e.key];
    if (!alvo) return;
    e.preventDefault(); st.aba = alvo.dataset.cf2Aba; render(); raiz.querySelector(`#cf2-aba-${st.aba}`)?.focus();
  });
  raiz.addEventListener("toggle", async (e) => {
    if (!e.target.matches?.("[data-cf2-hist-geral]") || !e.target.open) return;
    const alvo = raiz.querySelector("[data-cf2-hist-geral-corpo]");
    try { const h = await fin.get("/conferencias/historico", {}); alvo.innerHTML = h.itens.length ? `<ul class="cf2-ul">${h.itens.map((i) => `<li>${esc(dataBr(String(i.em).slice(0, 10)))} · ${esc(i.entidade.replace("fin_", "").replace(/_/g, " "))} · ${esc(i.acao)}</li>`).join("")}</ul>` : '<p class="cf2-vazio">Sem registros.</p>'; }
    catch (err) { alvo.innerHTML = `<p class="fin-sub">${esc(err?.status === 403 ? "Seu perfil não pode ver o histórico." : err?.message ?? "Não foi possível carregar.")}</p>`; }
  }, true);

  raiz.addEventListener("click", async (e) => {
    const t = (sel) => e.target.closest(sel);
    let b;
    if (t("[data-cf2-tentar]")) { st.erro = null; carregar(); return; }
    if ((b = t("[data-cf2-aba]"))) { st.aba = b.dataset.cf2Aba; render(); raiz.querySelector(`#cf2-aba-${st.aba}`)?.focus(); return; }
    if (t("[data-cf2-limpar]")) { st.filtros = { status: "todas", responsavel: "", categoria: "", busca: "" }; render(); return; }
    if ((b = t("[data-cf2-revisar]"))) { abrirDetalhe({ tipo: "pendencia", id: b.dataset.cf2Revisar }); return; }
    if ((b = t("[data-cf2-sug]"))) { abrirDetalhe({ tipo: "sugestao", chave: b.dataset.cf2Sug }); return; }
    if (t("[data-cf2-voltar]")) { voltar(); return; }
    if ((b = t("[data-cf2-ir]"))) { ir(b.dataset.cf2Ir); return; }
    if ((b = t("[data-cf2-lanc]"))) { const linha = raiz.querySelector(`#cf2-lanc-${b.dataset.cf2Lanc}`); linha.hidden = !linha.hidden; b.setAttribute("aria-expanded", String(!linha.hidden)); return; }
    const x = itemDoDetalhe();
    if (t("[data-cf2-hist]") && x) { carregarHistorico(raiz.querySelector("[data-cf2-hist-corpo]"), x); return; }
    if (t("[data-cf2-doc-novo]")) {
      dialogo({ titulo: "Registrar pendência documental", enviar: "Registrar", corpo: corpoFormDoc({ competencia: st.mes }), aoEnviar: async (f) => { await fin.post("/pendencias-documentais", corpoDoc(f)); await depoisDeAcao("Pendência registrada (sem movimentação financeira)."); } });
      return;
    }
    // ---- rateios: um por vez
    if ((b = t("[data-cf2-aprovar]")) && x) {
      const card = b.closest("[data-cf2-rateio]"), r = x.itens.find((i) => i.id === b.dataset.cf2Aprovar);
      if (!card.querySelector("[data-cf2-conferi]").checked) { saida(`Marque “Conferi o documento deste rateio” antes de confirmar ${r.obrigacao}.`); card.querySelector("[data-cf2-conferi]").focus(); return; }
      b.disabled = true;
      try { await fin.post(r.caminhoAprovar, {}); await depoisDeAcao(`Rateio aprovado: ${r.obrigacao}.`); } catch (err) { b.disabled = false; saida(`${r.obrigacao}: ${err?.message ?? "não foi possível aprovar"}`); }
      return;
    }
    // ---- juros: decisão 1 (quitar)
    if (t("[data-cf2-quitar]") && x?.etapas?.quitar) {
      dialogo({ titulo: "Quitar a conta", enviar: "Quitar", corpo: `<p class="fin-sub">A conta passa a quitada com base nos pagamentos já registrados. As datas e os valores dos pagamentos originais são preservados. A natureza do acréscimo é uma decisão separada, feita depois.</p>`,
        aoEnviar: async () => { await fin.post(x.etapas.quitar.caminho, {}); await depoisDeAcao("Conta quitada. Agora a natureza do acréscimo pode ser classificada."); } });
      return;
    }
    // ---- transferências: um par por vez
    if ((b = t("[data-cf2-vincular]")) && x) {
      const l = x.linhas[Number(b.dataset.cf2Vincular)]; b.disabled = true;
      try { await fin.post(l.vincular.caminho, l.vincular.corpo); await depoisDeAcao("Transferência vinculada."); } catch (err) { b.disabled = false; saida(err?.message ?? "Não foi possível vincular."); }
      return;
    }
    if ((b = t("[data-cf2-multipla]")) && x) {
      const l = x.linhas[Number(b.dataset.cf2Multipla)], soma = l.contrapartidas.reduce((a, y) => a + y.valorCentavos, 0);
      dialogo({ titulo: "Conciliar 1 saída com várias entradas", enviar: "Confirmar conciliação", corpo: `<p class="fin-sub">Saída: ${esc(dataBr(l.saida.data))} · ${esc(l.saida.conta)} · ${R(l.saida.valorCentavos)}</p>
          <ul class="fin-lista">${l.contrapartidas.map((y) => `<li>${esc(dataBr(y.data))} · ${esc(y.conta)} · ${R(y.valorCentavos)}</li>`).join("")}</ul>
          <p><strong>Soma das entradas ${R(soma)} ${soma === l.saida.valorCentavos ? "=" : "≠"} saída ${R(l.saida.valorCentavos)}</strong></p>
          <p class="fin-sub">Os lançamentos continuam como estão. Fica registrado quem aprovou e quando; pode ser desfeito, com motivo.</p>
          ${campo("Justificativa", "justificativa", { obrig: true, extra: 'maxlength="1000"' })}`,
        aoEnviar: async (f) => { await fin.post(l.vincularMultipla.caminho, { ...l.vincularMultipla.corpo, justificativa: txt(f, "justificativa") }); await depoisDeAcao(`Conciliação registrada: 1 saída com ${l.contrapartidas.length} entradas.`); } });
      return;
    }
    if ((b = t("[data-cf2-desfazer]"))) {
      const id = b.dataset.cf2Desfazer;
      dialogo({ titulo: "Desfazer conciliação com várias entradas", enviar: "Desfazer", perigo: true, corpo: `<p class="fin-sub">Os lançamentos não são apagados: voltam a ficar pendentes e o motivo fica na trilha.</p>${campo("Motivo", "motivo", { obrig: true, extra: 'maxlength="1000"' })}`,
        aoEnviar: async (f) => { await fin.post(`/transferencias/multiplas/${id}/desvincular`, { motivo: txt(f, "motivo") }); await depoisDeAcao("Conciliação desfeita."); } });
      return;
    }
    // ---- pendência documental
    if ((b = t("[data-cf2-doc]")) && x?.docId) {
      const doc = (st.pd?.itens ?? []).find((i) => i.id === x.docId) ?? { ...x, descricao: x.titulo, estado: x.status, competencia: st.mes };
      const op = b.dataset.cf2Doc;
      if (op === "evidencia") dialogo({ titulo: "Adicionar evidência", enviar: "Salvar evidência", corpo: `${campo("Documento (nome ou local)", "documentoReferencia", { obrig: true, valor: doc.documentoReferencia ?? "", extra: 'maxlength="300"' })}
          ${campo("Observações", "observacoes", { valor: doc.observacoes ?? "", extra: 'maxlength="1000"' })}<p class="fin-sub">Registrar a evidência não confirma a pendência.</p>`,
        aoEnviar: async (f) => { await fin.patch(`/pendencias-documentais/${x.docId}`, { documentoReferencia: txt(f, "documentoReferencia"), observacoes: txt(f, "observacoes") || null }); await depoisDeAcao("Evidência registrada."); } });
      else if (op === "encaminhar") dialogo({ titulo: "Encaminhar para conferência", enviar: "Encaminhar", corpo: `${campo("Responsável pela conferência", "responsavel", { obrig: true, valor: doc.responsavel ?? "", extra: 'maxlength="120"' })}
          ${selecao("Status", "estado", ESTADOS_DOC, { valor: "aguardando_comprovacao", obrig: true })}`,
        aoEnviar: async (f) => { await fin.patch(`/pendencias-documentais/${x.docId}`, { responsavel: txt(f, "responsavel"), estado: txt(f, "estado") }); await depoisDeAcao("Pendência encaminhada."); } });
      else if (op === "confirmar") dialogo({ titulo: "Confirmar pendência com evidência", enviar: "Confirmar", corpo: `<p class="fin-sub">Confirmar registra seu usuário, a data e o documento. Uma pendência confirmada não pode ser editada.</p>
          <label class="fin-campo"><span>Evidência da confirmação *</span><textarea name="evidencia" rows="2" maxlength="500" required minlength="5"></textarea></label>
          ${campo("Documento (nome ou local)", "documentoReferencia", { valor: doc.documentoReferencia ?? "", extra: 'maxlength="300"' })}`,
        aoEnviar: async (f) => { await fin.post(`/pendencias-documentais/${x.docId}/confirmar`, { evidencia: txt(f, "evidencia"), documentoReferencia: txt(f, "documentoReferencia") || null }); await depoisDeAcao("Pendência confirmada."); } });
      else if (op === "editar") dialogo({ titulo: "Editar pendência documental", enviar: "Salvar", corpo: corpoFormDoc(doc), aoEnviar: async (f) => { await fin.patch(`/pendencias-documentais/${x.docId}`, corpoDoc(f)); await depoisDeAcao("Pendência atualizada."); } });
      else if (op === "cancelar") dialogo({ titulo: "Cancelar registro da pendência", enviar: "Cancelar registro", perigo: true, corpo: `<p class="fin-sub">O registro não é apagado: sai da lista e o motivo fica na trilha.</p>${campo("Motivo", "motivo", { obrig: true, extra: 'maxlength="500"' })}`,
        aoEnviar: async (f) => { await fin.post(`/pendencias-documentais/${x.docId}/cancelar`, { motivo: txt(f, "motivo") }); await depoisDeAcao("Registro cancelado."); } });
      return;
    }
    // ---- sugestões
    if ((b = t("[data-cf2-sug-cadastrar]"))) {
      b.disabled = true;
      try { await fin.post(`/pendencias-documentais/modelos/${encodeURIComponent(b.dataset.cf2SugCadastrar)}`, {}); st.detalhe = null; await depoisDeAcao("Pendência cadastrada (sem movimentação financeira)."); }
      catch (err) { b.disabled = false; saida(err?.message ?? "Não foi possível cadastrar."); }
      return;
    }
    if ((b = t("[data-cf2-sug-dispensar]"))) {
      const chave = b.dataset.cf2SugDispensar;
      dialogo({ titulo: "Dispensar sugestão", enviar: "Dispensar", corpo: `<p class="fin-sub">A sugestão sai da lista, mas nada é apagado: a justificativa, o seu usuário e a data ficam registrados, e ela pode ser cadastrada depois.</p>
          <label class="fin-campo"><span>Justificativa *</span><textarea name="justificativa" rows="3" maxlength="400" minlength="10" required></textarea></label>`,
        aoEnviar: async (f) => { await fin.post(`/pendencias-documentais/modelos/${encodeURIComponent(chave)}/dispensar`, { justificativa: txt(f, "justificativa") }); st.detalhe = null; await depoisDeAcao("Sugestão dispensada com justificativa."); } });
    }
  });

  raiz.addEventListener("submit", async (e) => {
    const f = e.target.closest("[data-cf2-acao]"); if (!f) return;
    e.preventDefault();
    if (!f.checkValidity()) { f.reportValidity(); return; }
    const x = itemDoDetalhe(); if (!x) return;
    const fd = new FormData(f), botao = f.querySelector("button[type=submit]"); botao.disabled = true;
    try {
      const tipo = f.dataset.cf2Acao;
      if (tipo === "confirmar_ajuste") await fin.post(x.acao.caminho, { evidencia: txt(fd, "evidencia") });
      else if (tipo === "classificar_acrescimo") await fin.post(x.etapas.classificar.caminho, { classificacao: fd.get("classificacao") });
      else if (tipo === "resolver_origem") await fin.post(x.acao.caminho, { contaId: fd.get("contaId") });
      await depoisDeAcao("Decisão registrada.");
    } catch (err) { botao.disabled = false; saida(err?.message ?? "Não foi possível registrar."); }
  });

  carregar();
}
