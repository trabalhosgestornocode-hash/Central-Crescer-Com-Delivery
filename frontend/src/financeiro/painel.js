// Visão Geral do Financeiro 2.0 — painel com os indicadores gerenciais e de caixa, cada um com metodologia, origem e ESTADO.
// Faturamento (vendas registradas) e Recebimentos (entradas no banco/caixa) são SEMPRE indicadores separados.
// Nada é constante da tela: tudo vem de GET /gestao-financeira/painel.
import { fin } from "./api.js";
import { moeda, pct, rotuloMes } from "./modelo.js";
import { graficoEntradasSaidas, graficoBarrasHorizontais } from "./graficos.js";
import { garantirCss, cabecalho, seletorMes, kpi, tabela, badge, carregarEm, lerMes, gravarMes, ativarTooltips, esc } from "./ui.js";

const ESTADO = {
  ok: null,
  proposta: ["Metodologia a aprovar", "warn"],
  parcial: ["Parcial", "warn"],
  indisponivel: ["Indisponível", "muted"],
};

export function cartao(rotulo, i, { destaque = false } = {}) {
  const valor = i.valorCentavos == null ? "—" : i.unidade === "bps" ? pct(i.valorCentavos) : moeda(i.valorCentavos);
  const e = ESTADO[i.estado];
  const sub = [e && i.estado === "proposta" ? badge(e[0], e[1]) : "", i.nota ? `<span class="fin-kpi-nota">${esc(i.nota)}</span>` : ""].filter(Boolean).join(" ");
  return kpi({ rotulo, valor, sub, status: i.estado === "proposta" ? "ok" : i.estado, formula: i.formula, origem: i.origem, destaque });
}

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
  const atualizar = () => carregarEm(corpo, () => fin.get("/painel", { mes }), (d) => pintar(corpo, d));
  topo.innerHTML = cabecalho({ titulo: "Visão Geral", sub: "Indicadores gerenciais e de caixa do mês. Passe pelo ícone de fórmula para ver a metodologia e a origem de cada número.", extra: seletorMes(mes) });
  topo.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); atualizar(); } });
  atualizar();
}

function pintar(alvo, d) {
  const I = d.indicadores;
  const aviso = d.regrasAprovadas ? "" : `<p class="fin-alerta fin-alerta--warn" role="note">Os indicadores marcados com <strong>Metodologia a aprovar</strong> usam a metodologia gerencial proposta (versão ${esc(d.versaoRegras)}), ainda não validada pela contadora. Nenhum número foi ajustado para coincidir com a apresentação.</p>`;
  const bloqueios = (d.bloqueiosFechamento ?? []).length;
  alvo.innerHTML = `
    ${aviso}
    <h3 class="fin-secao">Vendas e receitas — ${esc(rotuloMes(d.mes))}</h3>
    <div class="fin-kpis">
      ${cartao("Faturamento bruto", I.faturamentoBruto, { destaque: true })}
      ${cartao("Faturamento líquido", I.faturamentoLiquido)}
      ${cartao("Recebimentos (banco e caixa)", I.recebimentos)}
      ${cartao("Contas a receber", I.contasAReceber)}
    </div>
    <h3 class="fin-secao">Custos, despesas e resultado (gerencial)</h3>
    <div class="fin-kpis">
      ${cartao("CMV", I.cmv)}
      ${cartao("Custos totais", I.custos)}
      ${cartao("Despesas", I.despesas)}
      ${cartao("Resultado gerencial", I.resultadoGerencial, { destaque: true })}
      ${cartao("Margem líquida", I.margemLiquida)}
    </div>
    <h3 class="fin-secao">Caixa e obrigações</h3>
    <div class="fin-kpis">
      ${cartao("Saldo disponível", I.saldoDisponivel)}
      ${cartao("Resultado de caixa", I.resultadoCaixa)}
      ${cartao("Contas a pagar em aberto", I.contasAPagar)}
      ${cartao("Juros e encargos", I.jurosEncargos)}
    </div>
    ${bloqueios ? `<p class="fin-alerta fin-alerta--warn" role="note">Fechamento do mês bloqueado: ${bloqueios} pendência(s) (ver Períodos).</p>` : ""}
    <div class="fin-grade-2">
      <section class="fin-cartao"><h3>Composição gerencial do mês</h3>${graficoBarrasHorizontais(d.composicao.map((c) => ({ rotulo: c.grupo, centavos: c.centavos })), { titulo: "Composição", limite: 8 }) || '<p class="fin-vazio-linha">Sem dados.</p>'}</section>
      <section class="fin-cartao"><h3>Saldos por conta</h3>${tabela({ colunas: [{ rotulo: "Conta", render: (c) => esc(c.nome) }, { rotulo: "Saldo calculado", num: true, render: (c) => c.saldoCentavos == null ? `${badge("abertura desconhecida", "muted")}` : moeda(c.saldoCentavos) }], linhas: d.saldosPorConta, vazio: "Nenhuma conta." })}</section>
    </div>
    <section class="fin-cartao" data-largura>${graficoEntradasSaidas(d.serieVendas.map((v) => ({ periodo: v.data.slice(8, 10), entradas: v.vendaCentavos, saidas: 0 })), { titulo: "Vendas registradas por dia", largura: alvo.clientWidth || 720 }) || '<p class="fin-vazio-linha">Sem vendas registradas no mês.</p>'}</section>`;
}
