// Indicadores — cada um com fórmula, origem e estado (calculado / parcial / indisponível). Inclui a ponte resultado → caixa.
import { fin } from "./api.js";
import { moeda, periodoDoMes, rotuloMes, ROTULO_STATUS_IND } from "./modelo.js";
import { garantirCss, cabecalho, seletorMes, badge, tabela, carregarEm, lerMes, gravarMes, esc, estado } from "./ui.js";

const ROTULO = {
  receitaOperacional: "Receita operacional recebida", custosVariaveis: "Custos variáveis (compras e fretes)", margemContribuicao: "Margem de contribuição",
  margemContribuicaoPct: "Margem de contribuição (%)", resultadoGerencial: "Resultado gerencial", margemLiquidaPct: "Margem líquida (%)",
  pontoEquilibrio: "Ponto de equilíbrio", geracaoCaixaOperacional: "Geração de caixa operacional", variacaoCaixa: "Variação financeira do período", saldoFinal: "Saldo final calculado",
};

export async function render(container) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  let mes = lerMes();
  raiz.innerHTML = `<div data-topo></div><div data-corpo class="fin-pg"></div>`;
  const topo = raiz.querySelector("[data-topo]"), corpo = raiz.querySelector("[data-corpo]");
  topo.innerHTML = cabecalho({ titulo: "Indicadores", sub: "Todo número é recalculado dos lançamentos. A fórmula e a origem estão sempre à vista.", extra: seletorMes(mes) });
  topo.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); carregar(); } });

  function carregar() {
    carregarEm(corpo, () => fin.get("/relatorios/indicadores", periodoDoMes(mes)), (d) => {
      if (d.vazio) { corpo.innerHTML = estado.vazio(`Sem lançamentos em ${rotuloMes(mes)}`); return; }
      const cartoes = d.itens.map((i) => {
        const valor = i.texto ?? "—";
        const tipo = i.status === "ok" ? "ok" : i.status === "parcial" ? "warn" : "muted";
        return `<article class="fin-kpi"><span class="fin-kpi-rot">${esc(ROTULO[i.id] ?? i.id)} ${badge(ROTULO_STATUS_IND[i.status], tipo)}</span>
          <strong class="fin-kpi-val">${esc(valor)}</strong>
          <span class="fin-kpi-sub"><strong>Fórmula:</strong> ${esc(i.formula)}</span><span class="fin-kpi-sub"><strong>Origem:</strong> ${esc(i.origem)}</span>
          ${i.aliasDe ? `<span class="fin-kpi-sub">Equivale a “${esc(ROTULO[i.aliasDe])}” (mesma fórmula; não é um segundo indicador).</span>` : ""}</article>`;
      }).join("");
      const p = d.ponteResultadoCaixa;
      const ponte = tabela({
        colunas: [{ rotulo: "Etapa", render: (l) => esc(l.rotulo) }, { rotulo: "Valor", num: true, render: (l) => moeda(l.centavos, { sinal: true }) }],
        linhas: [...p.linhas, { rotulo: "= Variação de caixa", centavos: p.variacaoCaixa }, { rotulo: "+ Saldo anterior informado", centavos: p.saldoAnterior }, { rotulo: "= Saldo final calculado", centavos: p.saldoFinal }],
      });
      corpo.innerHTML = `<div class="fin-kpis">${cartoes}</div>
        <div class="fin-card"><h3>Ponte resultado → caixa ${p.fecha ? badge("Fecha ao centavo", "ok") : badge(`Diferença ${moeda(p.diferenca)}: lançamentos sem classificação`, "bad")}</h3>${ponte}
        <p class="fin-sub">Saldo final é o saldo calculado dos lançamentos; só é saldo conciliado após conferência com extratos externos.</p></div>`;
    });
  }
  carregar();
}
