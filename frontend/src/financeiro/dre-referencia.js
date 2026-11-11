// DRE GERENCIAL — demonstrativo principal único do Financeiro 2.0 (metodologia gerencial, critério misto por categoria).
// Leitura em três camadas: (1) resumo executivo, (2) gráfico de composição do faturamento bruto, (3) árvore expansível até o lançamento.
// Tudo vem de GET /dre-referencia e os três blocos usam os MESMOS números (resumo/arvore do servidor): nada é recalculado aqui.
// Avisos gerais ficam num aviso compacto (painel de pendências); a linha só carrega selo quando a pendência é específica dela.
import { blocoAjuda } from "./ajuda.js";
import { fin } from "./api.js";
import { moeda, pct, rotuloMes } from "./modelo.js";
import { garantirCss, seletorMes, tabela, carregarEm, lerMes, gravarMes, ativarTooltips, esc } from "./ui.js";
import { ativarComposicao, abrirPainelHtml } from "./detalhe.js";
import { htmlArvore, botaoInfo, selo } from "./detalheHtml.js";
import { CRITERIOS } from "./explicacoes.js";
import { state } from "../state.js";
import { abrirCentral, contarPendencias } from "./conferencias.js";

const SEG = [
  { id: "deducoes", rotulo: "Deduções", classe: "ded" },
  { id: "custos", rotulo: "Custos", classe: "cus" },
  { id: "despesas", rotulo: "Despesas", classe: "des" },
  { id: "resultado", rotulo: "Resultado gerencial", classe: "res" },
];

export async function render(container) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg dre";
  container.appendChild(raiz);
  ativarTooltips(raiz);
  let dados = null, mes = lerMes();
  ativarComposicao(raiz, () => ({ composicao: {}, mes, conciliacao: dados?.conciliacaoEntregadores }));
  raiz.innerHTML = `<div data-cab></div><div data-corpo class="dre-corpo"></div>`;
  const cab = raiz.querySelector("[data-cab]"), corpo = raiz.querySelector("[data-corpo]");
  const atualizar = () => carregarEm(corpo, () => fin.get("/dre-referencia", { mes }), (d) => { dados = d; pintarCabecalho(cab, d, mes); pintar(corpo, d); });
  cab.innerHTML = cabecalho(mes) + blocoAjuda("dre");
  ligarCabecalho(cab, () => dados, (m) => { mes = m; gravarMes(mes); atualizar(); });
  atualizar();
  raiz.addEventListener("click", (e) => {
    const f = e.target.closest("[data-dre-foco]");
    if (f) irPara(raiz, f.dataset.dreFoco);
    if (e.target.closest("[data-dre-pendencias]")) abrirCentral({ mes, aoAlterar: atualizar });
    if (e.target.closest("[data-dre-regras]")) abrirRegras(dados);
    if (e.target.closest("[data-dre-ir-caixa-link]")) import("../router.js").then(({ irPara: ir }) => ir("fin-dre"));
  });
}

// ------------------------------------------------------------------ cabeçalho
const statusChip = (d) => !d ? "" : d.semContasAPagar ? `<button type="button" class="dre-chip dre-chip--warn" data-dre-pendencias>Dados parciais</button>`
  : d.regrasAprovadas ? `<span class="dre-chip dre-chip--ok">Metodologia aprovada</span>` : `<button type="button" class="dre-chip dre-chip--warn" data-dre-pendencias>Pendente da contadora</button>`;
function cabecalho(mes) {
  const empresa = state?.sessao?.empresa?.nome, unidade = state?.sessao?.unidade?.nome;
  const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\(.*?\)/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const mesmo = unidade && empresa && (norm(unidade) === norm(empresa) || norm(unidade).includes(norm(empresa)) || norm(empresa).includes(norm(unidade)));
  const quem = [mesmo ? (unidade || empresa) : empresa, mesmo ? null : unidade].filter(Boolean).map(esc).join(" · ");
  return `<header class="dre-cab"><div class="dre-tit"><h2>DRE Gerencial ${botaoInfo("dreGerencial", "DRE Gerencial", { dado: "glossario" })}</h2>
    <p class="dre-sub">${quem ? `${quem} · ` : ""}<span data-dre-comp>${esc(rotuloMes(mes))}</span></p></div>
    <div class="dre-ctl">${seletorMes(mes)}<span data-dre-status></span></div></header>`;
}
function pintarCabecalho(cab, d, mes) { cab.querySelector("[data-dre-status]").innerHTML = statusChip(d); cab.querySelector("[data-dre-comp]").textContent = rotuloMes(mes); }
function ligarCabecalho(cab, obter, aoMudar) {
  cab.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) aoMudar(e.target.value); });
}

// ------------------------------------------------------------------ pendências (um aviso compacto + painel)
function pendencias(d) {
  const lista = [];
  if (d.semContasAPagar) lista.push({ t: "Sem contas a pagar no mês", x: "Não há contas a pagar registradas: CMV e despesas ficam incompletos. Importe ou registre as contas do mês." });
  if (!d.regrasAprovadas) lista.push({ t: "Metodologia ainda não aprovada pela contadora", x: `Todos os valores seguem a regra proposta (versão ${d.versaoRegras}). Eles são calculados dos registros; nada foi ajustado para coincidir com a apresentação.` });
  const comRateio = []; const varre = (ns) => ns.forEach((n) => { if (n.situacao === "pendente_contadora" && !n.filhos?.length) comRateio.push(n.rotulo); if (n.filhos) varre(n.filhos); }); varre(d.arvore);
  if (/PROPOSTA/.test(d.pendencias.rateios ?? "")) lista.push({ t: "Rateios por competência propostos", x: `${d.pendencias.rateios}.${comRateio.length ? ` Categorias afetadas: ${comRateio.join(", ")}.` : ""}` });
  if (/indispon/.test(d.pendencias.dividas ?? "")) lista.push({ t: "Dívidas fora do ponto de equilíbrio financeiro", x: d.pendencias.dividas });
  if ((d.pendencias.categoriasSemRegraNoPlano ?? []).length) lista.push({ t: "Categorias sem regra", x: d.pendencias.categoriasSemRegraNoPlano.join(", ") });
  return lista;
}
function abrirRegras(d) {
  if (!d) return;
  const regras = tabela({ colunas: [{ rotulo: "Categoria", render: (r) => esc(r.categoria) + (r.nomeOriginal ? ` <small>(no plano: ${esc(r.nomeOriginal)})</small>` : "") }, { rotulo: "Grupo", render: (r) => esc(r.grupo) }, { rotulo: "Critério", render: (r) => esc(CRITERIOS[r.criterio] ?? r.criterio) }, { rotulo: "Motivo", render: (r) => esc(r.motivo) }], linhas: d.regras });
  abrirPainelHtml({ titulo: "Regra aplicada a cada categoria", html: `<section><p class="fin-sub">Critério usado para decidir em que mês cada valor entra no demonstrativo. Versão das regras: ${esc(d.versaoRegras)} (${d.regrasAprovadas ? "aprovada" : "proposta, ainda não aprovada pela contadora"}).</p>${regras}</section>` });
}

// ------------------------------------------------------------------ corpo
const cartaoResumo = (rotulo, id, r, { forte = false, pctTexto = null } = {}) => `<article class="dre-card${forte ? " dre-card--forte" : ""}">
  <span class="dre-card-rot">${esc(rotulo)} ${botaoInfo(id, rotulo, { dado: "glossario" })}</span>
  <strong class="dre-card-val">${r?.centavos == null ? "—" : moeda(r.centavos)}</strong>
  <span class="dre-card-pct">${pctTexto ?? (r?.pctBrutoBps == null ? "&nbsp;" : `${pct(r.pctBrutoBps)} do bruto`)}</span></article>`;

function pintar(alvo, d) {
  const R = d.resumo, parcial = d.semContasAPagar, pend = pendencias(d);
  const aviso = pend.length ? `<div class="dre-aviso" role="status"><span class="dre-aviso-txt"><span class="dre-pt" aria-hidden="true"></span>${esc(pend[0].t)}${pend.length > 1 ? ` · +${pend.length - 1} pendência(s)` : ""}</span><button type="button" class="btn btn-ghost btn-sm" data-dre-pendencias>Ver pendências</button></div>` : "";
  const v = (x) => (parcial ? { centavos: null, pctBrutoBps: null } : x);
  alvo.innerHTML = `${aviso}
    <div class="dre-cards">
      ${cartaoResumo("Faturamento bruto", "faturamentoBruto", R.bruto, { pctTexto: "base de cálculo" })}
      ${cartaoResumo("Faturamento líquido", "faturamentoLiquido", v(R.liquido))}
      ${cartaoResumo("Custos totais", "custos", v(R.custos))}
      ${cartaoResumo("Despesas totais", "despesas", v(R.despesas))}
      ${cartaoResumo("Resultado gerencial", "resultadoGerencial", v(R.resultado), { forte: true })}
      ${cartaoResumo("Margem líquida", "margemLiquida", null, { pctTexto: "do faturamento bruto" }).replace("<strong class=\"dre-card-val\">—</strong>", `<strong class="dre-card-val">${parcial || R.margemLiquidaBps == null ? "—" : pct(R.margemLiquidaBps)}</strong>`)}
    </div>
    ${parcial ? `<p class="fin-vazio-linha">Sem contas a pagar registradas, só o faturamento é apresentado. Custos, despesas e resultado aparecem quando as contas do mês forem registradas.</p>` : grafico(R)}
    <section class="dre-arvore" aria-label="Demonstrativo detalhado">
      <div class="dre-arv-cab" aria-hidden="true"><span>Demonstrativo</span><span>Valor</span><span>% do bruto</span></div>
      ${htmlArvore(d.arvore)}
    </section>
    <p class="dre-rodape"><button type="button" class="btn btn-ghost btn-sm" data-dre-regras>Regra aplicada a cada categoria</button><button type="button" class="btn btn-ghost btn-sm" data-dre-ir-caixa-link>DRE de caixa (relatório técnico)</button></p>`;
  void contarPendencias;
}

// ------------------------------------------------------------------ gráfico (mesmos valores do resumo)
function grafico(R) {
  const bruto = R.bruto.centavos;
  if (!bruto) return "";
  const v = { deducoes: R.deducoes, custos: R.custos, despesas: R.despesas, resultado: R.resultado };
  const negativo = (R.resultado.centavos ?? 0) < 0;
  const segs = SEG.map((s) => ({ ...s, ...v[s.id], valor: s.id === "resultado" && negativo ? 0 : Math.abs(v[s.id].centavos ?? 0) })).filter((s) => s.valor > 0);
  const resumo = SEG.map((s) => `${s.rotulo} ${moeda(v[s.id].centavos)} (${pct(v[s.id].pctBrutoBps)})`).join("; ");
  return `<section class="dre-graf" aria-label="Composição do faturamento bruto">
    <h3>Para onde vai cada R$ 100 do faturamento bruto</h3>
    <div class="dre-barra" role="img" aria-label="Composição do faturamento bruto de ${moeda(bruto)}: ${esc(resumo)}">${segs.map((s) => `<span class="dre-seg dre-seg--${s.classe}" style="flex:${s.valor} 1 0" tabindex="0" data-tip="${esc(s.rotulo)}: ${moeda(v[s.id].centavos)} (${pct(s.pctBrutoBps)})"></span>`).join("")}</div>
    <ul class="dre-legenda">${SEG.map((s) => `<li><button type="button" data-dre-foco="${s.id === "resultado" ? "resultado" : s.id === "despesas" ? "variaveis" : s.id}"><span class="dre-dot dre-dot--${s.classe}" aria-hidden="true"></span><span class="dre-leg-nome">${esc(s.id === "resultado" ? "Resultado" : s.rotulo)}</span><span class="dre-leg-val">${moeda(v[s.id].centavos)}</span><span class="dre-leg-pct">${pct(v[s.id].pctBrutoBps)}</span></button></li>`).join("")}</ul>
    ${negativo ? `<p class="fin-sub">Resultado negativo: os gastos superam o faturamento em ${moeda(Math.abs(R.resultado.centavos))}. Por isso o resultado não aparece como faixa na barra.</p>` : ""}
  </section>`;
}

/** Clique na legenda: rola até o grupo na árvore e o abre (o gráfico aponta para a mesma linha do demonstrativo). */
function irPara(raiz, id) {
  const li = raiz.querySelector(`.dre-arvore .fin-arv-no[data-no="${CSS.escape(id)}"]`);
  if (!li) return;
  const b = li.querySelector(":scope > .fin-arv-linha [data-fin-toggle]");
  if (b?.getAttribute("aria-expanded") === "false") b.click();
  li.scrollIntoView({ block: "center", behavior: "smooth" });
  (b ?? li.querySelector(".fin-arv-linha"))?.focus?.();
}
void selo;
