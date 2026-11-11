// Visão Geral do Financeiro 2.0 — o painel EXPLICA os números. Cada indicador tem ícone (i) (explicação, fórmula, componentes, origem) e o valor
// abre um painel lateral com a composição até a origem. O faturamento aparece dividido por canal, em duas leituras que não se misturam:
// o total do painel SAIPOS e a base que alimenta a DRE gerencial, com a ponte (ajustes) entre os dois.
// Nada é constante da tela: valores e composições vêm de GET /gestao-financeira/painel (composicao[id]).
import { fin } from "./api.js";
import { moeda, pct, rotuloMes } from "./modelo.js";
import { graficoEntradasSaidas, graficoBarrasHorizontais } from "./graficos.js";
import { garantirCss, cabecalho, seletorMes, tabela, badge, carregarEm, lerMes, gravarMes, ativarTooltips, esc } from "./ui.js";
import { ativarComposicao, htmlConciliacao } from "./detalhe.js";
import { botaoInfo, selo, valorDe } from "./detalheHtml.js";
import { explicacaoDe } from "./explicacoes.js";
import { montarBusca } from "./busca.js";
import { abrirCentral, contarPendencias } from "./conferencias.js";

// indicadores cuja pendência é só a regra geral da metodologia (vai no aviso único, não em selos repetidos)
const PENDENCIA_GERAL = new Set(["faturamentoLiquido", "deducoes", "cmv", "custos", "despesas", "margemContribuicao", "resultadoGerencial", "margemLiquida", "pontoEquilibrio"]);
const ROTULOS = { faturamentoBruto: "Faturamento bruto", deducoes: "Deduções", faturamentoLiquido: "Faturamento líquido", cmv: "CMV", entregadores: "Entregadores Próprios", custos: "Custos totais",
  despesas: "Despesas", margemContribuicao: "Margem de contribuição", resultadoGerencial: "Lucro gerencial", margemLiquida: "Margem líquida", pontoEquilibrio: "Ponto de equilíbrio", saldoDisponivel: "Saldo financeiro", contasAPagar: "Contas a pagar em aberto",
  contasAReceber: "Contas a receber", jurosEncargos: "Juros e encargos (pagos no mês)", dividas: "Dívidas", recebimentos: "Recebimentos (banco e caixa)" };

const listaCanais = (comp, extra = "") => `<ul class="kpi-canais" aria-label="${esc(extra)}">${comp.componentes.map((c) => `<li><span>${esc(c.rotulo)}${c.situacao === "pendente_contadora" ? ' <abbr title="inclui ajuste estimado, a confirmar">*</abbr>' : ""}</span><span>${valorDe(c.centavos)} <small>${c.pctBrutoBps == null ? "" : pct(c.pctBrutoBps)}</small></span></li>`).join("")}</ul>`;

/** Cartão de indicador. Exportado para teste. `opcoes.geralPendente`: a regra geral está pendente (selo só no aviso único). */
export function cartao(id, rotulo, comp, { destaque = false, geralPendente = false } = {}) {
  if (!comp) return "";
  const un = comp.unidade ?? "moeda";
  const valor = valorDe(comp.valorCentavos, un);
  const nome = comp.rotulo ?? rotulo;
  const pb = un === "moeda" && comp.pctBrutoBps != null && id !== "faturamentoBruto" ? `<span class="kpi-pct">${pct(comp.pctBrutoBps)} do faturamento</span>` : "";
  let corpo = "";
  if (id === "faturamentoBruto" && comp.componentes?.some((c) => c.origemTecnica?.length)) {
    // Um único faturamento: a base gerencial por canal. O total do painel (SAIPOS) e os ajustes ficam só na composição completa.
    const cc = comp.canalConferencia;
    corpo = `${listaCanais(comp, "Faturamento bruto por canal")}
      ${cc && cc.confere === false ? `<span class="kpi-div" role="alert">Divergência: a base por canal difere do bruto oficial em ${valorDe(Math.abs(cc.diferencaCentavos ?? 0))}</span>` : ""}
      ${(comp.pendencias ?? []).length ? `<span class="kpi-pend">${esc(comp.pendencias[0])}</span>` : ""}
      <button type="button" class="fin-link" data-fin-valor="faturamentoBruto">Ver composição completa</button>`;
  } else {
    const faltam = comp.faltam?.length ? comp.faltam[0] : "";
    const nota = faltam || comp.notas?.[0] || "";
    corpo = `${pb}${nota ? `<span class="kpi-nota">${esc(nota)}</span>` : ""}`;
  }
  const clic = comp.valorCentavos != null || comp.componentes?.length || comp.faltam?.length;
  const val = clic ? `<button type="button" class="fin-kpi-val fin-valor-link" data-fin-valor="${esc(id)}" aria-label="${esc(nome)}: ${esc(valor)}. Abrir composição">${valor}</button>` : `<strong class="fin-kpi-val">${valor}</strong>`;
  const mostrarSelo = comp.situacao && comp.situacao !== "confirmado" && !(geralPendente && comp.situacao === "pendente_contadora" && PENDENCIA_GERAL.has(id));
  return `<article class="fin-kpi${destaque ? " fin-kpi--destaque" : ""}" data-indicador="${esc(id)}">
    <span class="fin-kpi-rot">${esc(nome)} ${botaoInfo(id, nome)} ${mostrarSelo ? selo(comp.situacao) : ""}</span>${val}${corpo}</article>`;
}

export async function render(container) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  ativarTooltips(raiz);
  raiz.addEventListener("click", async (e) => { if (e.target.closest("[data-ir-vendas]")) { const { irPara } = await import("../router.js"); irPara("fin-vendas-diarias"); } });   // a competência escolhida segue (sessionStorage fin:mes)
  const topo = document.createElement("div"), corpo = document.createElement("div");
  corpo.className = "fin-pg";
  raiz.append(topo, corpo);
  let mes = lerMes();
  let dados = null;
  ativarComposicao(raiz, () => ({ composicao: dados?.composicao ?? {}, mes, conciliacao: dados?.conciliacaoEntregadores, extraPainel: (c) => (c.id === "custos" || c.id === "cmv" || c.id === "entregadores") && dados?.conciliacaoEntregadores ? htmlConciliacao(dados.conciliacaoEntregadores) : "" }));
  const atualizar = () => carregarEm(corpo, () => fin.get("/painel", { mes }), (d) => { dados = d; pintar(corpo, d); atualizarAviso(corpo, mes, atualizar); });
  topo.innerHTML = cabecalho({ ajuda: "painel", titulo: "Painel do Mês", sub: "Cada número tem um ícone (i) que explica o que é e como é calculado. Clique no valor para ver de onde ele vem.", extra: `${seletorMes(mes)}<div data-busca></div>` });
  montarBusca(topo.querySelector("[data-busca]"), { mesAtual: () => mes });
  topo.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); atualizar(); } });
  atualizar();
}

async function atualizarAviso(alvo, mes, recarregar) {
  const el = alvo.querySelector("[data-central-aviso]");
  if (!el) return;
  const r = await contarPendencias(mes);
  if (!r || !alvo.isConnected) return;
  el.innerHTML = r.total || r.geral ? `<div class="dre-aviso" role="status"><span class="dre-aviso-txt"><span class="dre-pt" aria-hidden="true"></span>${r.total ? `${r.total} conferência(s) pendente(s)` : "Sem conferências individuais pendentes"}${r.geral ? " · metodologia aguardando aprovação da contadora" : ""}</span><button type="button" class="btn btn-ghost btn-sm" data-abrir-central>Abrir central de conferências</button></div>` : "";
  el.querySelector("[data-abrir-central]")?.addEventListener("click", () => abrirCentral({ mes, aoAlterar: recarregar }));
}

function pintar(alvo, d) {
  const C = d.composicao, geral = !d.regrasAprovadas;
  const c = (id, o) => cartao(id, ROTULOS[id] ?? id, C[id], { ...o, geralPendente: geral });
  const rc = d.indicadores.resultadoCaixa;
  alvo.innerHTML = `
    <div data-central-aviso></div>
    <h3 class="fin-secao">Faturamento — ${esc(rotuloMes(d.mes))}</h3>
    <div class="fin-kpis">
      ${c("faturamentoBruto", { destaque: true })}
    </div>
    <h3 class="fin-secao">Resultado do mês</h3>
    <div class="fin-kpis">
      ${c("faturamentoLiquido")}${c("custos")}${c("despesas")}${c("resultadoGerencial", { destaque: true })}${c("margemLiquida")}
    </div>
    <h3 class="fin-secao">Caixa e obrigações</h3>
    <div class="fin-kpis">
      ${c("saldoDisponivel")}${c("contasAPagar")}${c("contasAReceber")}${c("jurosEncargos")}
    </div>
    <details class="fin-mais"><summary>Mais indicadores <small>(deduções, CMV, entregadores, margem de contribuição, ponto de equilíbrio, dívidas, recebimentos)</small></summary>
      <div class="fin-kpis">
        ${c("deducoes")}${c("cmv")}${c("entregadores")}${c("margemContribuicao")}${c("pontoEquilibrio")}${c("dividas")}${c("recebimentos")}
        ${rc ? cartao("resultadoCaixa", "Resultado de caixa", { id: "resultadoCaixa", unidade: "moeda", valorCentavos: rc.valorCentavos, situacao: rc.estado === "ok" ? "confirmado" : rc.estado === "indisponivel" ? "sem_dados" : "parcial", formula: rc.formula, origem: rc.origem, componentes: [], faltam: [], notas: [rc.nota].filter(Boolean) }) : ""}
      </div></details>
    <details class="fin-mais"><summary>Gráficos do mês</summary>
      <div class="fin-grade-2">
        <section class="fin-cartao"><h3>Composição gerencial do mês</h3>${graficoBarrasHorizontais(d.composicaoGrafico.map((x) => ({ rotulo: x.grupo, centavos: x.centavos })), { titulo: "Composição", limite: 8 }) || '<p class="fin-vazio-linha">Sem dados.</p>'}</section>
        <section class="fin-cartao"><h3>Saldos por conta</h3>${tabela({ colunas: [{ rotulo: "Conta", render: (x) => esc(x.nome) }, { rotulo: "Saldo calculado", num: true, render: (x) => x.saldoCentavos == null ? `${badge("abertura desconhecida", "muted")}` : moeda(x.saldoCentavos) }], linhas: d.saldosPorConta, vazio: "Nenhuma conta." })}</section>
      </div>
      <section class="fin-cartao" data-largura>${graficoEntradasSaidas(d.serieVendas.map((v) => ({ periodo: v.data.slice(8, 10), entradas: v.vendaCentavos, saidas: 0 })), { titulo: "Vendas registradas por dia", largura: alvo.clientWidth || 720 }) || '<p class="fin-vazio-linha">Sem vendas registradas no mês.</p>'}</section>
    </details>
    <p class="fin-sub">Glossário rápido: ${["faturamentoBruto", "ajusteVendas", "recebimentos", "cmv", "jurosPresumidos", "conciliacao"].map((k) => `${esc(explicacaoDe(k).nome)} ${botaoInfo(k, explicacaoDe(k).nome, { dado: "glossario" })}`).join(" · ")}</p>`;
}
