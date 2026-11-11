// VENDAS DIÁRIAS (SAIPOS) — Financeiro → Receitas e Vendas → Vendas Diárias.
// Uma linha por dia: venda bruta, recebido em espécie e sangria. Mesma fonte do faturamento: registrar aqui NÃO cria recebimento bancário nem despesa.
// Tudo vem de /vendas-diarias; a tela não calcula nada (totais, média e conferência com o caixa físico são do servidor).
import { fin } from "./api.js";
import { moeda, rotuloMes, dataBr, podeAcao, ACAO, arquivoParaBase64 } from "./modelo.js";
import { garantirCss, cabecalho, seletorMes, tabela, badge, carregarEm, lerMes, gravarMes, ativarTooltips, dialogo, campo, selecao, aviso, esc } from "./ui.js";
import { ativarComposicao, abrirPainelHtml } from "./detalhe.js";
import { botaoInfo } from "./detalheHtml.js";

const EDITAR = "gestao_financeira.editar";
const SITUACAO = { divergente: ["Divergente", "bad"], conferido: ["Conferido com o caixa", "ok"], registrado: ["Registrado", "muted"] };
const R = (c) => (c == null ? "—" : moeda(c));
const diaSemana = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
const reais = (v) => String(v ?? "").trim();
const DESTINOS = ["Depósito no banco", "Pagamento em espécie a fornecedor", "Reposição de troco", "Retirada do sócio", "Cofre da loja"];

export async function render(container, ctx) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg vd";
  container.appendChild(raiz);
  ativarTooltips(raiz);
  const pode = (a) => podeAcao(ctx, a);
  let mes = lerMes(), dados = null;
  const filtros = { busca: "", situacao: "" };
  ativarComposicao(raiz, () => ({ composicao: {}, mes }));
  raiz.innerHTML = `<div data-topo></div><div data-corpo class="fin-pg"></div>`;
  const topo = raiz.querySelector("[data-topo]"), corpo = raiz.querySelector("[data-corpo]");
  topo.innerHTML = cabecalho({ ajuda: "vendas-diarias", titulo: "Vendas Diárias", sub: "Registre, importe e confira as vendas de cada dia. A venda bruta é o faturamento; o dinheiro e as sangrias são conferidos com o caixa físico.",
    extra: `${seletorMes(mes)}${pode(ACAO.LANCAR) ? `<button type="button" class="btn btn-primary btn-sm" data-registrar>+ Registrar venda</button><button type="button" class="btn btn-ghost btn-sm" data-importar>Importar SAIPOS</button>` : ""}` });
  const atualizar = () => carregarEm(corpo, () => fin.get("/vendas-diarias", { mes, ...(filtros.busca ? { busca: filtros.busca } : {}), ...(filtros.situacao ? { situacao: filtros.situacao } : {}) }), (d) => { dados = d; pintar(corpo, d, filtros); });
  topo.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); atualizar(); } });
  topo.querySelector("[data-registrar]")?.addEventListener("click", () => formVenda({ mes, aoSalvar: atualizar }));
  topo.querySelector("[data-importar]")?.addEventListener("click", () => importar({ mes, podeEditar: pode(EDITAR), aoSalvar: atualizar }));
  raiz.addEventListener("click", (e) => {
    const d = e.target.closest("[data-detalhe]"), ed = e.target.closest("[data-editar]");
    if (d) detalhe(d.dataset.detalhe, { podeEditar: pode(EDITAR), aoSalvar: atualizar });
    if (ed) { const l = dados?.linhas.find((x) => x.data === ed.dataset.editar); if (l) formEditar(l, { aoSalvar: atualizar }); }
    if (e.target.closest("[data-sem-registro]")) semRegistro(dados);
    if (e.target.closest("[data-so-divergentes]")) { filtros.situacao = filtros.situacao === "divergente" ? "" : "divergente"; atualizar(); }
    if (e.target.closest("[data-historico]")) historico(mes);
    if (e.target.closest("[data-registrar-vazio]")) formVenda({ mes, aoSalvar: atualizar });
  });
  raiz.addEventListener("input", (e) => { if (e.target.matches("[data-busca]")) { clearTimeout(raiz._t); raiz._t = setTimeout(() => { filtros.busca = e.target.value.trim(); atualizar(); }, 300); } });
  raiz.addEventListener("change", (e) => { if (e.target.matches("[data-situacao]")) { filtros.situacao = e.target.value; atualizar(); } });
  atualizar();
}

// ------------------------------------------------------------------ página
const card = (rotulo, chave, valor, sub = "") => `<article class="vd-card"><span class="vd-card-rot">${esc(rotulo)} ${botaoInfo(chave, rotulo, { dado: "glossario" })}</span><strong class="vd-card-val">${valor}</strong><span class="vd-card-sub">${sub || "&nbsp;"}</span></article>`;

function pintar(alvo, d, f) {
  const I = d.indicadores, Cf = d.conferencia;
  const faltam = I.diasSemRegistro.length;
  const alerta = I.divergentes ? `<div class="fin-alerta fin-alerta--warn" role="status"><strong>${I.divergentes} dia(s) divergente(s)</strong> entre o que foi informado e o caixa físico. <button type="button" class="btn btn-ghost btn-sm" data-so-divergentes>${f.situacao === "divergente" ? "Mostrar todos" : "Ver só os divergentes"}</button></div>`
    : d.totalDias ? `<div class="fin-alerta" role="status">Espécie e sangrias de todos os dias registrados conferem com o caixa físico.</div>` : "";
  alvo.innerHTML = `
    <div class="vd-cards">
      ${card("Total de vendas brutas", "vendaBruta", R(I.totalVendaBrutaCentavos), `${I.diasComVenda} dia(s) com venda`)}
      ${card("Recebido em espécie", "especie", R(I.totalEspecieCentavos), "dinheiro que entrou no caixa físico")}
      ${card("Sangrias", "sangria", R(I.totalSangriaCentavos), I.destinosPendentes ? `${I.destinosPendentes} sem destino informado` : "retiradas de dinheiro do caixa")}
      ${card("Média diária de vendas", "mediaDiaria", R(I.mediaDiariaCentavos), "total ÷ dias com venda")}
      ${card("Dias registrados", "diasRegistrados", `${I.diasRegistrados} de ${I.diasNoMes}`, faltam ? `<button type="button" class="fin-link" data-sem-registro>${faltam} dia(s) sem registro</button>` : "todos os dias até hoje")}
    </div>
    ${alerta}
    <details class="vd-integra"><summary>Como as vendas alimentam o financeiro</summary><ul class="fin-lista">${d.integracao.regras.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      <p class="fin-sub">Aparece em: ${d.integracao.onde.map(esc).join(" · ")}.</p></details>
    <div class="fin-filtros vd-filtros" role="search">
      <label class="fin-campo"><span>Pesquisar</span><input type="search" data-busca value="${esc(f.busca)}" placeholder="data (05/09), fonte, destino…" maxlength="60"></label>
      <label class="fin-campo"><span>Situação</span><select data-situacao><option value="">Todas</option>${Object.entries(SITUACAO).map(([k, [r]]) => `<option value="${k}"${f.situacao === k ? " selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
      <button type="button" class="btn btn-ghost btn-sm" data-historico>Histórico do mês</button>
    </div>
    ${d.linhas.length ? tabela({ colunas: [
      { rotulo: "Dia", render: (l) => `<strong>${esc(dataBr(l.data).slice(0, 5))}</strong> <small>${esc(diaSemana(l.data))}</small>` },
      { rotulo: "Venda bruta", num: true, render: (l) => R(l.venda?.valorCentavos) },
      { rotulo: "Espécie", num: true, render: (l) => R(l.especie?.valorCentavos) },
      { rotulo: "Sangria", num: true, render: (l) => l.sangria ? `${R(l.sangria.valorCentavos)}${l.sangria.valorCentavos > 0 ? `<br><small>${l.sangria.destino ? `→ ${esc(l.sangria.destino)}` : '<span class="vd-pend">destino a informar</span>'}</small>` : ""}` : "—" },
      { rotulo: "Fonte", render: (l) => `<small>${l.fontes.map(esc).join("<br>")}</small>` },
      { rotulo: "Situação", render: (l) => `${badge(SITUACAO[l.situacao][0], SITUACAO[l.situacao][1])}${l.divergencias.map((x) => `<br><small class="vd-dif">${esc(x.campo)}: informado ${R(x.informadoCentavos)} × caixa ${R(x.caixaCentavos)}${x.diferencaCentavos != null ? ` (${moeda(x.diferencaCentavos, { sinal: true })})` : ""}</small>`).join("")}` },
      { rotulo: "Registrado por", render: (l) => `<small>${esc(l.responsavel)}${l.registradoEm ? `<br>${esc(dataBr(String(l.registradoEm).slice(0, 10)))}` : ""}</small>` },
      { rotulo: "", render: (l) => `<button type="button" class="btn btn-ghost btn-sm" data-detalhe="${esc(l.data)}" aria-label="Detalhes de ${esc(dataBr(l.data))}">Detalhes</button> <button type="button" class="btn btn-ghost btn-sm" data-editar="${esc(l.data)}" aria-label="Editar ${esc(dataBr(l.data))}">Editar</button>` },
    ], linhas: d.linhas }) : `<div class="fin-estado fin-estado--vazio"><h3>${f.busca || f.situacao ? "Nenhum dia com esses filtros" : `Sem vendas registradas em ${esc(rotuloMes(d.mes))}`}</h3><p>${f.busca || f.situacao ? "Limpe a pesquisa ou o filtro." : "Registre o primeiro dia ou importe o relatório da SAIPOS."}</p>${f.busca || f.situacao ? "" : '<button type="button" class="btn btn-primary btn-sm" data-registrar-vazio>+ Registrar venda</button>'}</div>`}
    <p class="fin-sub vd-conf">Conferência com o caixa físico (dias com informação): espécie informada ${R(Cf.especie.informadoCentavos)} × entradas no caixa ${R(Cf.especie.caixaFisicoCentavos)} · sangrias informadas ${R(Cf.sangria.informadoCentavos)} × saídas do caixa ${R(Cf.sangria.caixaFisicoCentavos)}.</p>`;
}

// ------------------------------------------------------------------ painéis
function semRegistro(d) {
  abrirPainelHtml({ titulo: "Dias sem registro", html: `<section><p class="fin-sub">Dias do mês, até hoje, sem nenhuma venda registrada. Se a loja fechou, não precisa registrar.</p><ul class="fin-lista">${d.indicadores.diasSemRegistro.map((x) => `<li>${esc(dataBr(x))} <small>${esc(diaSemana(x))}</small></li>`).join("")}</ul></section>` });
}

async function historico(mes) {
  let h; try { h = await fin.get("/vendas-diarias/historico", { mes }); } catch (e) { aviso(e.message, "bad"); return; }
  abrirPainelHtml({ titulo: `Histórico de ${rotuloMes(mes)}`, html: `<section><p class="fin-sub">${h.total} evento(s): tudo o que foi registrado e cancelado, do mais recente ao mais antigo. Nada é apagado.</p>
    ${h.eventos.length ? tabela({ colunas: [{ rotulo: "Quando", render: (e) => `<small>${esc(dataBr(String(e.em).slice(0, 10)))} ${esc(String(e.em).slice(11, 16))}</small>` }, { rotulo: "Dia", render: (e) => esc(dataBr(e.data).slice(0, 5)) }, { rotulo: "Campo", render: (e) => esc(e.campo) },
      { rotulo: "Valor", num: true, render: (e) => R(e.valorCentavos) }, { rotulo: "Evento", render: (e) => `${e.evento === "cancelado" ? badge("Cancelado", "warn") : badge("Registrado", "ok")}<br><small>${esc(e.evento === "cancelado" ? (e.motivo ?? "") : (e.referenciaOrigem ?? e.fonte))}</small>` }, { rotulo: "Por", render: (e) => `<small>${esc(e.responsavel)}</small>` }], linhas: h.eventos }) : "<p class=\"fin-vazio-linha\">Sem eventos.</p>"}</section>` });
}

async function detalhe(dia, { podeEditar, aoSalvar }) {
  let d; try { d = await fin.get("/vendas-diarias/dia", { data: dia }); } catch (e) { aviso(e.message, "bad"); return; }
  const cx = d.conferencia;
  const bloco = (c) => c ? `${c.estado === "conciliado" ? "confere" : c.estado === "resolvido" ? "diferença classificada" : c.diferencaCentavos == null ? "sem referência" : `diferença ${moeda(c.diferencaCentavos, { sinal: true })}`}: informado ${R(c.referenciaCentavos)} × caixa ${R(c.fluxoCentavos)}` : "sem dado";
  const html = `
    <section><h4>1. Valores vigentes e origem</h4>${tabela({ colunas: [{ rotulo: "Campo", render: (x) => esc(x.campo) }, { rotulo: "Valor", num: true, render: (x) => R(x.valorCentavos) }, { rotulo: "Fonte", render: (x) => esc(x.fonte) },
      { rotulo: "Origem", render: (x) => `<small>${esc(x.referenciaOrigem ?? "—")}${x.nota ? `<br>${esc(x.nota)}` : ""}</small>` }, { rotulo: "Registrado", render: (x) => `<small>${esc(dataBr(String(x.registradoEm).slice(0, 10)))} · ${esc(x.responsavel)}</small>` }], linhas: d.atuais })}
      <p class="fin-sub">Identificadores: ${d.atuais.map((x) => `<code>${esc(x.id.slice(0, 8))}</code>`).join(" ")} (preservados nas edições: a linha antiga fica no histórico).</p></section>
    <section><h4>2. Conferência com o caixa físico</h4><ul class="fin-lista"><li>Recebido em espécie — ${esc(bloco(cx.especie))}</li><li>Sangria — ${esc(bloco(cx.sangria))}</li></ul>
      ${d.caixaFisico.length ? `<p class="fin-sub">Movimentos do caixa físico neste dia (só consulta):</p><ul class="fin-lista">${d.caixaFisico.map((m) => `<li>${m.sentido === "entrada" ? "entrada" : "saída"} ${R(m.valorCentavos)} — ${esc(m.descricao ?? "")}</li>`).join("")}</ul>` : '<p class="fin-sub">Sem movimentos do caixa físico neste dia.</p>'}</section>
    <section><h4>3. Versões anteriores</h4>${d.anteriores.length ? tabela({ colunas: [{ rotulo: "Campo", render: (x) => esc(x.campo) }, { rotulo: "Valor", num: true, render: (x) => R(x.valorCentavos) }, { rotulo: "Origem", render: (x) => `<small>${esc(x.referenciaOrigem ?? "—")}</small>` }, { rotulo: "Cancelada", render: (x) => `<small>${esc(dataBr(String(x.canceladaEm).slice(0, 10)))}<br>${esc(x.motivoCancelamento ?? "")}</small>` }], linhas: d.anteriores }) : '<p class="fin-sub">Este dia nunca foi alterado.</p>'}</section>
    <section><h4>4. Trilha de auditoria</h4>${d.auditoria.length ? `<ul class="fin-lista">${d.auditoria.map((a) => `<li>${esc(dataBr(String(a.em).slice(0, 10)))} ${esc(String(a.em).slice(11, 16))} · ${esc(a.acao)}</li>`).join("")}</ul>` : '<p class="fin-sub">Sem registros de auditoria acessíveis.</p>'}</section>
    ${podeEditar ? `<p><button type="button" class="btn btn-primary btn-sm" data-editar-painel>Editar este dia</button></p>` : ""}`;
  const painel = abrirPainelHtml({ titulo: `Dia ${dataBr(dia)}`, html });
  document.querySelector(".fin-pn [data-editar-painel]")?.addEventListener("click", async () => { painel.fechar(); const m = await fin.get("/vendas-diarias", { mes: dia.slice(0, 7) }); const l = m.linhas.find((x) => x.data === dia); if (l) formEditar(l, { aoSalvar }); });
}

// ------------------------------------------------------------------ formulários
const explicacao = (t) => `<small>${esc(t)}</small>`;
function camposVenda(v = {}) {
  return `${campo("Venda bruta (R$)", "venda", { obrig: true, valor: v.venda ?? "", extra: 'inputmode="decimal" autocomplete="off"', dica: "Total vendido no dia, antes de taxas e descontos (é o faturamento). Zero é permitido." })}
    ${campo("Recebido em espécie (R$)", "especie", { valor: v.especie ?? "", extra: 'inputmode="decimal" autocomplete="off"', dica: "Parte da venda recebida em dinheiro. Vazio = não informado; 0 = zero informado." })}
    ${campo("Sangria (R$)", "sangria", { valor: v.sangria ?? "", extra: 'inputmode="decimal" autocomplete="off"', dica: "Dinheiro retirado do caixa no dia. Não é despesa por si só." })}
    <label class="fin-campo"><span>Destino da sangria</span><input name="destinoSangria" list="vd-destinos" maxlength="120" value="${esc(v.destino ?? "")}" autocomplete="off"><datalist id="vd-destinos">${DESTINOS.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>${explicacao("Para onde o dinheiro foi (obrigatório quando há sangria).")}</label>`;
}
const num = (c) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));

function formVenda({ mes, aoSalvar }) {
  dialogo({ titulo: "Registrar venda do dia", enviar: "Registrar", corpo: `
    <p class="fin-sub">Cada dia é registrado uma vez. Registrar a venda <strong>não cria recebimento bancário</strong> nem despesa.</p>
    ${campo("Data", "data", { tipo: "date", obrig: true, valor: `${mes}-01` })}${camposVenda()}
    ${selecao("Fonte", "fonte", [{ valor: "manual", rotulo: "Registro manual" }, { valor: "saipos", rotulo: "SAIPOS (digitado do relatório)" }], { obrig: true, vazio: null })}
    ${campo("Observação", "observacao", { extra: 'maxlength="300"' })}
    <p class="fin-sub">Vai aparecer em: Visão Geral (faturamento do mês), DRE Gerencial (faturamento bruto) e na conferência com o caixa físico.</p>`,
    aoEnviar: async (f) => {
      const r = await fin.post("/vendas-diarias", { data: f.get("data"), venda: reais(f.get("venda")), especie: reais(f.get("especie")) || undefined, sangria: reais(f.get("sangria")) || undefined, destinoSangria: reais(f.get("destinoSangria")) || undefined, fonte: f.get("fonte"), observacao: reais(f.get("observacao")) || undefined });
      aviso(`Venda registrada (${r.registros.length} campo(s)). Aparece no faturamento do mês; nenhum recebimento bancário foi criado.`); aoSalvar();
    } });
}

function formEditar(l, { aoSalvar }) {
  dialogo({ titulo: `Editar ${dataBr(l.data)}`, enviar: "Salvar alteração", corpo: `
    <p class="fin-sub">A linha anterior não é apagada: fica <strong>cancelada com o motivo</strong> no histórico do dia.</p>
    ${camposVenda({ venda: num(l.venda?.valorCentavos), especie: num(l.especie?.valorCentavos), sangria: num(l.sangria?.valorCentavos), destino: l.sangria?.destino })}
    ${campo("Observação", "observacao", { valor: l.observacao ?? "", extra: 'maxlength="300"' })}
    ${campo("Motivo da alteração *", "motivo", { obrig: true, extra: 'maxlength="500" placeholder="ex.: conferido com o relatório do dia"' })}`,
    aoEnviar: async (f) => {
      const corpo = { motivo: reais(f.get("motivo")), venda: reais(f.get("venda")), observacao: reais(f.get("observacao")) };
      if (reais(f.get("especie"))) corpo.especie = reais(f.get("especie"));
      if (reais(f.get("sangria"))) corpo.sangria = reais(f.get("sangria"));
      corpo.destinoSangria = reais(f.get("destinoSangria"));
      const r = await fin.patch(`/vendas-diarias/${l.data}`, corpo);
      aviso(`Alterado: ${r.alterados.map((a) => a.campo).join(", ")}. A versão anterior ficou no histórico.`); aoSalvar();
    } });
}

// ------------------------------------------------------------------ importação do relatório SAIPOS (prévia → confirmação)
function importar({ mes, podeEditar, aoSalvar }) {
  const dlg = document.createElement("dialog");
  dlg.className = "fin-dialogo vd-import";
  dlg.innerHTML = `<div class="fin-form"><h3>Importar relatório da SAIPOS</h3>
    <p class="fin-sub">Arquivo CSV ou Excel com uma linha por dia e as colunas <strong>Data</strong>, <strong>Venda bruta</strong>, <strong>Recebido em espécie</strong> e/ou <strong>Sangria</strong>. Você vê a prévia antes de gravar; o que já existe igual é rejeitado como duplicidade.</p>
    <label class="fin-campo"><span>Arquivo</span><input type="file" accept=".csv,.xlsx,.xls" data-arq></label>
    <p><button type="button" class="btn btn-ghost btn-sm" data-previa disabled>Pré-visualizar</button></p>
    <div data-resultado role="status" aria-live="polite"></div>
    <div class="fin-form-acoes"><button type="button" class="btn btn-ghost btn-sm" data-fechar>Fechar</button><button type="button" class="btn btn-primary btn-sm" data-confirmar hidden>Importar</button></div></div>`;
  document.body.appendChild(dlg);
  const fechar = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); fechar(); });
  dlg.querySelector("[data-fechar]").addEventListener("click", fechar);
  const arq = dlg.querySelector("[data-arq]"), bPrevia = dlg.querySelector("[data-previa]"), bOk = dlg.querySelector("[data-confirmar]"), saida = dlg.querySelector("[data-resultado]");
  let corpo = null, previa = null;
  arq.addEventListener("change", () => { bPrevia.disabled = !arq.files?.length; bOk.hidden = true; saida.innerHTML = ""; });
  const ESTADO = { novo: ["Novo", "ok"], igual: ["Igual (duplicidade)", "muted"], atualizar: ["Difere do registrado", "warn"], completar: ["Completa campo", "info"] };
  bPrevia.addEventListener("click", async () => {
    bPrevia.disabled = true; saida.textContent = "Lendo o arquivo…";
    try {
      corpo = { conteudoBase64: await arquivoParaBase64(arq.files[0]), arquivoNome: arq.files[0].name };
      previa = await fin.post("/vendas-diarias/importar/previa", corpo);
      const r = previa.resumo, erros = previa.erros.length;
      const diff = previa.dias.filter((d) => d.estado === "atualizar" || d.estado === "completar");
      saida.innerHTML = `<p><strong>${r.dias} dia(s) no arquivo:</strong> ${r.novos} novo(s) · ${r.iguais} já registrado(s) igual (rejeitados como duplicidade) · ${r.atualizar} que difere(m) · ${r.completar} a completar${erros ? ` · <span class="vd-dif">${erros} com erro</span>` : ""}</p>
        ${erros ? `<div class="fin-alerta fin-alerta--bad" role="alert"><strong>Corrija o arquivo: nada será importado.</strong><ul>${previa.erros.slice(0, 8).map((e) => `<li>linha ${e.linha}: ${esc(e.motivo)}</li>`).join("")}</ul></div>` : ""}
        ${diff.length ? `<p class="fin-sub">Dias que diferem do que está registrado (dia · campo · registrado × arquivo):</p><ul class="fin-lista">${diff.slice(0, 12).map((d) => d.campos.filter((c) => c.estado !== "igual").map((c) => `<li>${esc(dataBr(d.data).slice(0, 5))} · ${esc(c.rotulo)} · ${R(c.atualCentavos)} × <strong>${R(c.arquivoCentavos)}</strong></li>`).join("")).join("")}</ul>` : ""}
        <div class="vd-previa">${tabela({ colunas: [{ rotulo: "Dia", render: (d) => esc(dataBr(d.data).slice(0, 5)) }, { rotulo: "Venda", num: true, render: (d) => R(d.vendaCentavos) }, { rotulo: "Espécie", num: true, render: (d) => R(d.especieCentavos) }, { rotulo: "Sangria", num: true, render: (d) => R(d.sangriaCentavos) }, { rotulo: "Situação", render: (d) => badge(...ESTADO[d.estado]) }], linhas: previa.dias.slice(0, 45) })}</div>
        ${previa.dias.length > 45 ? `<p class="fin-sub">Mostrando 45 de ${previa.dias.length} dias.</p>` : ""}
        ${r.atualizar && podeEditar ? `<label class="fin-campo fin-campo--inline"><span><input type="checkbox" data-atualizar> Atualizar também os ${r.atualizar} dia(s) que diferem (a linha antiga fica cancelada no histórico)</span></label><label class="fin-campo" data-motivo hidden><span>Motivo da atualização *</span><input data-motivo-in maxlength="500" placeholder="ex.: relatório SAIPOS reemitido"></label>` : r.atualizar ? '<p class="fin-sub">Atualizar valores existentes exige permissão de edição; sem ela, os dias que diferem ficam como estão.</p>' : ""}`;
      const aFazer = r.novos + r.completar;
      bOk.hidden = erros > 0 || (aFazer === 0 && !r.atualizar);
      bOk.textContent = aFazer === 0 && r.atualizar ? "Atualizar divergentes" : `Importar ${aFazer} dia(s)`;
      if (!erros && aFazer === 0 && !r.atualizar) saida.insertAdjacentHTML("beforeend", '<div class="fin-alerta" role="status"><strong>Nada a importar:</strong> tudo o que está no arquivo já está registrado igual. Nenhuma venda será somada de novo.</div>');
      saida.querySelector("[data-atualizar]")?.addEventListener("change", (e) => { saida.querySelector("[data-motivo]").hidden = !e.target.checked; });
    } catch (e) { saida.innerHTML = `<div class="fin-alerta fin-alerta--bad" role="alert">${esc(e.message ?? "Não foi possível ler o arquivo.")}</div>`; }
    finally { bPrevia.disabled = false; }
  });
  bOk.addEventListener("click", async () => {
    const atualizar = saida.querySelector("[data-atualizar]")?.checked === true;
    bOk.disabled = true;
    try {
      const r = await fin.post("/vendas-diarias/importar", { ...corpo, atualizar, motivo: atualizar ? reais(saida.querySelector("[data-motivo-in]")?.value) : undefined });
      saida.innerHTML = `<div class="fin-alerta" role="status"><strong>Importação concluída.</strong> ${r.registrosCriados} registro(s) criado(s), ${r.registrosAtualizados} atualizado(s), ${r.duplicidadesRejeitadas} duplicidade(s) rejeitada(s)${r.divergentesNaoAtualizados ? `, ${r.divergentesNaoAtualizados} divergente(s) mantido(s) como estavam` : ""}. ${esc(r.observacao)}</div>`;
      bOk.hidden = true; aviso("Importação concluída."); aoSalvar();
    } catch (e) { bOk.disabled = false; saida.insertAdjacentHTML("afterbegin", `<div class="fin-alerta fin-alerta--bad" role="alert">${esc(e.message ?? "Não foi possível importar.")}</div>`); }
  });
  dlg.showModal();
  arq.focus();
}
