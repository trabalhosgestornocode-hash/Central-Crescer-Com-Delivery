// DRE Gerencial de Referência (Financeiro 2.0): metodologia gerencial da contadora (critério misto por categoria).
// Visão SEPARADA do DRE de caixa. Mostra a regra aplicada a cada categoria e as pendências — para validação contábil.
import { fin } from "./api.js";
import { moeda, pct, rotuloMes } from "./modelo.js";
import { garantirCss, cabecalho, seletorMes, kpi, tabela, badge, carregarEm, lerMes, gravarMes, ativarTooltips, esc } from "./ui.js";

const CRIT = { caixa: "Caixa (pagamento no mês)", competencia: "Competência (valor original)", fora: "Fora do resultado", fonte: "Vendas registradas" };

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
  const atualizar = () => carregarEm(corpo, () => fin.get("/dre-referencia", { mes }), (d) => pintar(corpo, d));
  topo.innerHTML = cabecalho({ titulo: "DRE Gerencial de Referência", sub: "Metodologia gerencial: CMV e entregas por competência; deduções e despesas pelo pagamento. Separado do DRE de caixa.", extra: seletorMes(mes) });
  topo.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); atualizar(); } });
  atualizar();
}

function pintar(alvo, d) {
  const I = d.indicadores;
  const linhaDre = (rot, v, forte = false) => `<tr class="${forte ? "fin-dre-total" : ""}"><td>${esc(rot)}</td><td class="num">${v == null ? "—" : moeda(v)}</td></tr>`;
  const grupos = d.grupos.map((g) => `
    <tr class="fin-dre-grupo"><td colspan="2"><strong>${esc(g.rotulo)}</strong></td></tr>
    ${g.linhas.filter((l) => l.centavos !== 0).map((l) => `<tr><td>&nbsp;&nbsp;${esc(l.descricao)} <span class="fin-kpi-nota">${esc(CRIT[l.criterio] ?? l.criterio)} · ${l.parcelas} lançamento(s)</span></td><td class="num">${moeda(l.centavos)}</td></tr>`).join("")}`).join("");
  alvo.innerHTML = `
    ${d.regrasAprovadas ? "" : `<p class="fin-alerta fin-alerta--warn" role="note">Regras na versão <strong>${esc(d.versaoRegras)}</strong>: proposta, <strong>não aprovada</strong> pela contadora. Os valores são calculados dos registros; nada é ajustado.</p>`}
    ${d.semContasAPagar ? `<p class="fin-alerta" role="note">Não há contas a pagar registradas: CMV e despesas por competência ficam incompletos.</p>` : ""}
    <div class="fin-kpis">
      ${kpi({ rotulo: "Faturamento líquido", valor: moeda(I.faturamentoLiquido), formula: "bruto − deduções", origem: "vendas registradas + contas a pagar" })}
      ${kpi({ rotulo: "Margem de contribuição", valor: moeda(I.margemContribuicao), sub: I.margemContribuicaoBps == null ? "" : `${pct(I.margemContribuicaoBps)} do bruto`, formula: "líquido − custos totais − despesas variáveis" })}
      ${kpi({ rotulo: "Resultado gerencial", valor: moeda(I.resultadoGerencial), sub: I.margemLiquidaBps == null ? "" : `margem ${pct(I.margemLiquidaBps)}`, formula: "margem de contribuição − despesas fixas", destaque: true })}
      ${kpi({ rotulo: "Ponto de equilíbrio", valor: I.pontoEquilibrio == null ? "—" : moeda(I.pontoEquilibrio), formula: "despesas fixas ÷ (margem de contribuição ÷ bruto)" })}
      ${kpi({ rotulo: "PE financeiro", valor: "—", status: "indisponivel", formula: "(fixas + parcelas de dívida) ÷ MC%", origem: "requer cadastro de dívidas" })}
    </div>
    <section class="fin-cartao"><h3>Demonstrativo — ${esc(rotuloMes(d.mes))}</h3>
      <table class="fin-tabela fin-dre"><tbody>
        ${grupos}
        ${linhaDre("Faturamento líquido", I.faturamentoLiquido, true)}
        ${linhaDre("Custos totais (CMV + entregas)", I.custosTotais, true)}
        ${linhaDre("Margem de contribuição", I.margemContribuicao, true)}
        ${linhaDre("Resultado gerencial", I.resultadoGerencial, true)}
      </tbody></table></section>
    <section class="fin-cartao"><h3>Pendências da metodologia</h3><ul class="fin-lista">
      <li>${esc(d.pendencias.rateios)}</li><li>${esc(d.pendencias.dividas)}</li>
      ${(d.pendencias.categoriasSemRegraNoPlano ?? []).length ? `<li>Categorias sem regra: ${esc(d.pendencias.categoriasSemRegraNoPlano.join(", "))}</li>` : ""}
    </ul></section>
    <details class="fin-cartao"><summary><strong>Regra aplicada a cada categoria</strong> ${badge(`${d.regras.length} categorias`, "muted")}</summary>
      ${tabela({ colunas: [{ rotulo: "Categoria", render: (r) => esc(r.categoria) }, { rotulo: "Grupo", render: (r) => esc(r.grupo) }, { rotulo: "Critério", render: (r) => esc(CRIT[r.criterio] ?? r.criterio) }, { rotulo: "Motivo", render: (r) => esc(r.motivo) }], linhas: d.regras })}</details>`;
}
