// Juros e Encargos (Financeiro 2.0): acréscimos de CONTAS A PAGAR (pagamento acima do original em conta quitada).
// Presumidos (não classificados) ficam separados dos confirmados. Juros de EMPRÉSTIMOS têm outra natureza e não entram aqui.
import { fin } from "./api.js";
import { moeda, pct, dataBr, rotuloMes, mesAnterior } from "./modelo.js";
import { NATUREZA } from "./modeloContasPagar.js";
import { graficoBarrasHorizontais } from "./graficos.js";
import { garantirCss, cabecalho, kpi, tabela, badge, carregarEm, lerMes, esc, estado } from "./ui.js";
import { tabelaCartao } from "./tabelaCartao.js";

export async function render(container) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  let ate = lerMes(), de = mesAnterior(mesAnterior(ate));
  raiz.innerHTML = `<div data-topo></div><div data-corpo class="fin-pg"></div>`;
  const corpo = raiz.querySelector("[data-corpo]");
  raiz.querySelector("[data-topo]").innerHTML = cabecalho({
    ajuda: "juros", titulo: "Juros e Encargos",
    sub: "Acréscimos pagos em contas a pagar (atraso, multa, tarifa), calculados sobre o total pago de cada conta quitada. Juros de empréstimos são outra natureza e não entram aqui.",
    extra: `<label class="fin-campo fin-campo--inline" for="fin-de"><span>De</span><input type="month" id="fin-de" value="${esc(de)}"></label><label class="fin-campo fin-campo--inline" for="fin-ate"><span>Até</span><input type="month" id="fin-ate" value="${esc(ate)}"></label>`,
  });
  const mudou = () => { const a = raiz.querySelector("#fin-de").value, b = raiz.querySelector("#fin-ate").value; if (a && b) { de = a; ate = b; carregar(); } };
  raiz.querySelector("#fin-de").addEventListener("change", mudou);
  raiz.querySelector("#fin-ate").addEventListener("change", mudou);

  const carregar = () => carregarEm(corpo, () => fin.get("/contas-pagar/juros", { de, ate }), pintar);

  function pintar(p) {
    const t = p.totais;
    if (!p.linhas.length) { corpo.innerHTML = estado.vazio(`Nenhum acréscimo entre ${rotuloMes(de)} e ${rotuloMes(ate)}`, "Acréscimos aparecem quando uma conta quitada teve total pago maior que o valor original."); return; }
    const kpis = [
      kpi({ rotulo: "Juros presumidos", valor: moeda(t.presumidoCentavos), sub: t.presumidoCentavos ? "Aguardando classificação da contadora/administrador" : "Nada pendente de classificação", formula: "Σ (total pago − original) das contas quitadas ainda não classificadas" }),
      kpi({ rotulo: "Juros confirmados", valor: moeda(t.jurosCentavos) }),
      kpi({ rotulo: "Multas", valor: moeda(t.multaCentavos) }),
      kpi({ rotulo: "Taxas e tarifas", valor: moeda(t.tarifaCentavos), sub: t.outroCentavos ? `+ ${moeda(t.outroCentavos)} em outros acréscimos` : "" }),
      kpi({ rotulo: "Total de acréscimos", valor: moeda(t.totalCentavos), sub: `${p.contasPagasComAtraso} conta(s) paga(s) com atraso`, destaque: true, formula: "presumidos + juros + multas + tarifas + outros", origem: "Contas a pagar quitadas no período (mês da quitação)" }),
    ].join("");
    const barras = (lista, titulo) => graficoBarrasHorizontais(lista.map((x) => ({ rotulo: x.chave, centavos: x.centavos, participacaoBps: t.totalCentavos ? Math.round((x.centavos * 10000) / t.totalCentavos) : 0 })), { titulo }) || estado.vazio("Sem dados");
    const porMes = tabelaCartao({ colunas: [{ rotulo: "Mês", render: (x) => esc(rotuloMes(x.chave)) }, { rotulo: "Acréscimos", num: true, render: (x) => moeda(x.centavos) }], linhas: p.porMes });
    const lista = tabelaCartao({
      colunas: [
        { rotulo: "Fornecedor", render: (l) => `${esc(l.fornecedor ?? "—")}<br><small>${esc(l.categoria ?? "")}</small>` },
        { rotulo: "Vencimento", render: (l) => dataBr(l.vencimento) }, { rotulo: "Quitação", render: (l) => `${dataBr(l.dataQuitacao)}${l.diasAtraso ? `<br><small>${l.diasAtraso} dia(s) de atraso</small>` : ""}` },
        { rotulo: "Original", num: true, render: (l) => moeda(l.valorOriginalCentavos) }, { rotulo: "Pago", num: true, render: (l) => moeda(l.pagoCentavos) },
        { rotulo: "Acréscimo", num: true, render: (l) => `${moeda(l.acrescimoCentavos)}<br><small>${pct(l.percentualBps)}</small>` },
        { rotulo: "Natureza", render: (l) => badge(NATUREZA[l.natureza]?.rotulo ?? l.natureza, NATUREZA[l.natureza]?.tom ?? "muted") },
      ],
      linhas: p.linhas,
    }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
    corpo.innerHTML = `<div class="fin-kpis">${kpis}</div>
      <div class="fin-alerta fin-alerta--info" role="note">${esc(p.observacao)}</div>
      <div class="fin-grade2"><div class="fin-card">${barras(p.porFornecedor, "Acréscimos por fornecedor")}</div><div class="fin-card">${barras(p.porCategoria, "Acréscimos por categoria")}</div></div>
      <div class="fin-grade2 fin-grade2--5-7"><div class="fin-card"><h3>Evolução por mês</h3>${porMes}</div><div class="fin-card"><h3>Contas com acréscimo</h3>${lista}</div></div>`;
  }
  carregar();
}
