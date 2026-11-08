// Receitas e Vendas (Financeiro 2.0): vendas registradas (faturamento) × recebimentos no banco/caixa (regime de caixa).
import { fin } from "./api.js";
import { moeda, rotuloMes } from "./modelo.js";
import { graficoEntradasSaidas } from "./graficos.js";
import { garantirCss, cabecalho, seletorMes, tabela, carregarEm, lerMes, gravarMes, ativarTooltips, esc } from "./ui.js";
import { cartao } from "./painel.js";

export async function render(container) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  ativarTooltips(raiz);
  const topo = document.createElement("div"), corpo = document.createElement("div");
  corpo.className = "fin-pg";
  raiz.append(topo, corpo);
  let mes = lerMes();
  const atualizar = () => carregarEm(corpo, () => fin.get("/receitas", { mes }), (d) => pintar(corpo, d));
  topo.innerHTML = cabecalho({ titulo: "Receitas e Vendas", sub: "Faturamento é o que foi vendido (Saci); recebimento é o que entrou no banco ou no caixa. A diferença vem de taxas retidas, prazos de repasse e vendas em espécie.", extra: `${seletorMes(mes)}<button type="button" class="btn btn-primary btn-sm" data-ir-vendas>Vendas Diárias</button>` });
  topo.querySelector("[data-ir-vendas]")?.addEventListener("click", async () => { const { irPara } = await import("../router.js"); irPara("fin-vendas-diarias"); });
  topo.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); atualizar(); } });
  atualizar();
}

function pintar(alvo, d) {
  const R = d.resumo, v = d.vendas;
  const taxas = Object.entries(v.taxasPorCanal).map(([canal, c]) => ({ canal, c }));
  alvo.innerHTML = `
    <div class="fin-kpis">
      ${cartao("Faturamento bruto", R.faturamentoBruto, { destaque: true })}
      ${cartao("Recebimentos operacionais", R.recebimentos)}
      ${cartao("Vendas em espécie", R.dinheiro)}
      ${cartao("Taxas retidas (plataformas)", R.taxasRetidas)}
    </div>
    <section class="fin-cartao">${graficoEntradasSaidas(v.porDia.map((x) => ({ periodo: x.data.slice(8, 10), entradas: x.vendaCentavos, saidas: x.sangriaCentavos })), { titulo: "Vendas (barra) e sangrias por dia", largura: alvo.clientWidth || 720 }) || '<p class="fin-vazio-linha">Sem vendas registradas.</p>'}</section>
    <div class="fin-grade-2">
      <section class="fin-cartao"><h3>Recebimentos por conta — ${esc(rotuloMes(d.mes))}</h3>
        ${tabela({ colunas: [{ rotulo: "Conta", render: (x) => esc(x.conta) }, { rotulo: "Recebido", num: true, render: (x) => moeda(x.entradasCentavos) }, { rotulo: "Transferências recebidas (não são receita)", num: true, render: (x) => moeda(x.transferenciasCentavos) }], linhas: d.recebimentosPorConta, vazio: "Sem contas." })}</section>
      <section class="fin-cartao"><h3>Taxas por canal</h3>
        ${tabela({ colunas: [{ rotulo: "Canal", render: (x) => esc(x.canal) }, { rotulo: "Taxa", num: true, render: (x) => moeda(x.c) }], linhas: taxas, vazio: "Sem taxas registradas." })}</section>
    </div>
    <section class="fin-cartao"><h3>Vendas diárias (${v.diasComVenda} dias com venda)</h3>
      ${tabela({ colunas: [{ rotulo: "Dia", render: (x) => esc(x.data.split("-").reverse().join("/")) }, { rotulo: "Venda bruta", num: true, render: (x) => moeda(x.vendaCentavos) }, { rotulo: "Em espécie", num: true, render: (x) => moeda(x.dinheiroCentavos) }, { rotulo: "Sangria", num: true, render: (x) => moeda(x.sangriaCentavos) }], linhas: v.porDia, vazio: "Sem vendas registradas no mês." })}</section>`;
}
