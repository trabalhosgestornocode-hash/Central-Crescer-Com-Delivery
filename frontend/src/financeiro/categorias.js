// Análise de Categorias — ranking de custos, despesas e tributos (regime de caixa).
import { fin } from "./api.js";
import { moeda, pct, periodoDoMes, rotuloMes, ROTULO_PAPEL } from "./modelo.js";
import { graficoBarrasHorizontais } from "./graficos.js";
import { garantirCss, cabecalho, seletorMes, tabela, carregarEm, lerMes, gravarMes, ativarTooltips, esc, estado } from "./ui.js";

export async function render(container) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  ativarTooltips(raiz);
  let mes = lerMes();
  raiz.innerHTML = `<div data-topo></div><div data-corpo class="fin-pg"></div>`;
  const topo = raiz.querySelector("[data-topo]"), corpo = raiz.querySelector("[data-corpo]");
  topo.innerHTML = cabecalho({ titulo: "Análise de Categorias", sub: "O que mais pesa nas saídas operacionais. Fora desta análise: transferências, saldo anterior e principal de financiamentos.", extra: seletorMes(mes) });
  topo.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); carregar(); } });

  function carregar() {
    carregarEm(corpo, () => fin.get("/relatorios/categorias", periodoDoMes(mes)), (d) => {
      if (d.vazio || !d.itens.length) { corpo.innerHTML = estado.vazio(`Sem custos ou despesas em ${rotuloMes(mes)}`); return; }
      corpo.innerHTML = `<div class="fin-card">${graficoBarrasHorizontais(d.itens.map((i) => ({ rotulo: i.nome, centavos: i.centavos, participacaoBps: i.participacaoBps })), { titulo: "Maiores categorias", limite: 12 })}</div>
        <div class="fin-card"><h3>Ranking completo — total ${esc(moeda(d.totalCentavos))}</h3>${tabela({
          colunas: [
            { rotulo: "Categoria", render: (i) => esc(i.nome) }, { rotulo: "Grupo", render: (i) => esc(ROTULO_PAPEL[i.papel] ?? i.papel) },
            { rotulo: "Valor", num: true, render: (i) => moeda(i.centavos) }, { rotulo: "% do total", num: true, render: (i) => pct(i.participacaoBps) }, { rotulo: "% acumulado", num: true, render: (i) => pct(i.acumuladaBps) },
          ],
          linhas: d.itens,
        })}</div>`;
    });
  }
  carregar();
}
