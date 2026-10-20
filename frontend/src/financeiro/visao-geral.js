// Visão Geral — dashboard executivo financeiro. Tudo vem do backend (recalculado dos lançamentos); nada é constante da tela.
import { fin } from "./api.js";
import { moeda, pct, periodoDoMes, rotuloMes, descreverSaldo, variacaoTexto, mesAnterior, nivelAlerta } from "./modelo.js";
import { graficoEntradasSaidas, graficoBarrasHorizontais } from "./graficos.js";
import { garantirCss, cabecalho, seletorMes, kpi, tabela, badge, carregarEm, lerMes, gravarMes, ativarTooltips, estado, esc } from "./ui.js";

export async function render(container) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  ativarTooltips(raiz);
  const topo = document.createElement("div");
  const corpo = document.createElement("div");
  corpo.className = "fin-pg";
  raiz.append(topo, corpo);
  let mes = lerMes();

  const pintarTopo = () => {
    topo.innerHTML = cabecalho({ titulo: "Visão Geral", sub: "Regime de caixa: recebimentos líquidos e pagamentos efetivos. Não é uma DRE de competência.", extra: seletorMes(mes) });
    topo.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); atualizar(); } });
  };

  const atualizar = () => {
    const p = periodoDoMes(mes);
    const ant = periodoDoMes(mesAnterior(mes));
    carregarEm(corpo, async () => {
      const [geral, ind, cats, anterior] = await Promise.all([
        fin.get("/relatorios/visao-geral", p), fin.get("/relatorios/indicadores", p), fin.get("/relatorios/categorias", p),
        fin.get("/relatorios/visao-geral", ant).catch(() => null),
      ]);
      return { geral, ind, cats, anterior };
    }, ({ geral, ind, cats, anterior }) => pintar(corpo, mes, geral, ind, cats, anterior));
  };
  pintarTopo();
  atualizar();
}

function pintar(alvo, mes, g, ind, cats, anterior) {
  if (g.vazio) {
    alvo.innerHTML = estado.vazio(`Sem lançamentos em ${rotuloMes(mes)}`, "Registre lançamentos no Fluxo de Caixa ou importe o livro-caixa. Nenhum número é exibido sem dados reais.");
    return;
  }
  const it = Object.fromEntries(ind.itens.map((i) => [i.id, i]));
  const x = g.indicadores;
  const despesas = x.despesasVariaveis + x.despesasFixas + x.despesasPessoal + x.despesasFinanceiras;
  const k = (id, extra) => ({ formula: it[id]?.formula, origem: it[id]?.origem, status: it[id]?.status ?? "ok", ...extra });
  const varCaixa = anterior ? variacaoTexto(x.variacaoCaixa, anterior.indicadores.variacaoCaixa) : null;

  const alertas = g.alertas.length
    ? `<div class="fin-alertas">${g.alertas.map((a) => `<div class="fin-alerta fin-alerta--${nivelAlerta(a)}" role="${a.nivel === "erro" ? "alert" : "status"}">${esc(a.texto)}</div>`).join("")}</div>` : "";

  const kpis = [
    kpi(k("receitaOperacional", { rotulo: "Receita recebida", valor: moeda(x.receitaOperacional), sub: "Recebimentos líquidos, não vendas brutas" })),
    kpi(k("custosVariaveis", { rotulo: "Custos variáveis", valor: moeda(x.custosVariaveis), sub: "Compras e fretes pagos (não é CMV consumido)" })),
    kpi({ rotulo: "Despesas", valor: moeda(despesas), sub: "Variáveis + fixas + pessoal + financeiras", formula: "despesas variáveis + fixas + pessoal + financeiras (Σ saídas − Σ entradas por categoria)", origem: "Lançamentos realizados" }),
    kpi(k("margemContribuicao", { rotulo: "Margem de contribuição", valor: moeda(x.margemContribuicao), sub: `${pct(x.margemContribuicaoBps)} da receita` })),
    kpi(k("resultadoGerencial", { rotulo: "Resultado gerencial", valor: moeda(x.resultadoGerencial), sub: `Margem líquida ${pct(x.margemLiquidaBps)}`, destaque: true })),
    kpi(k("pontoEquilibrio", { rotulo: "Ponto de equilíbrio", valor: moeda(x.pontoEquilibrio), sub: x.pontoEquilibrio == null ? "Indisponível: margem de contribuição não positiva" : "Receita necessária para cobrir a estrutura" })),
    kpi(k("variacaoCaixa", { rotulo: "Variação do caixa", valor: moeda(x.variacaoCaixa, { sinal: true }), sub: varCaixa ? `vs. mês anterior: ${varCaixa.texto}` : "Entradas − saídas, sem saldo anterior" })),
    kpi(k("saldoFinal", { rotulo: "Saldo final calculado", valor: g.saldoFinalParcial ? "Parcial" : moeda(x.saldoFinal), sub: g.saldoFinalParcial ? `Há contas sem abertura. Calculado sem elas: ${moeda(x.saldoFinal)}` : "Calculado dos lançamentos; não conciliado com extrato" })),
  ].join("");

  const saldos = tabela({
    colunas: [
      { rotulo: "Conta", render: (c) => esc(c.nome) },
      { rotulo: "Saldo", num: true, render: (c) => { const d = descreverSaldo(c); return d.parcial ? badge("Parcial", "warn") : esc(d.principal); } },
      { rotulo: "Detalhe", render: (c) => `<small>${esc(descreverSaldo(c).detalhe)}</small>` },
    ],
    linhas: g.saldosPorConta.contas, vazio: "Nenhuma conta cadastrada.",
  }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
  const mov = tabela({
    colunas: [
      { rotulo: "Conta", render: (c) => esc(c.nome) },
      { rotulo: "Entradas", num: true, render: (c) => moeda(c.entradas) },
      { rotulo: "Saídas", num: true, render: (c) => moeda(c.saidas) },
      { rotulo: "Transf. líq.", num: true, render: (c) => moeda(c.transferenciasEntrada - c.transferenciasSaida, { sinal: true }) },
      { rotulo: "Variação", num: true, render: (c) => moeda(c.variacao, { sinal: true }) },
    ],
    linhas: g.movimentoPorConta, vazio: "Sem movimento.",
  }).replace('class="fin-tabela"', 'class="fin-tabela fin-tabela--cartao"');
  const pend = g.pendencias;

  alvo.innerHTML = `
    <p class="fin-regime">${esc(g.regime.rotulo)} · período ${esc(rotuloMes(mes))} · ${g.indicadores.contagem.considerados} lançamento(s) considerados</p>
    ${alertas}
    <div class="fin-kpis">${kpis}</div>
    <div class="fin-card" data-grafico-es>${graficoEs(g.serie, alvo.clientWidth - 42)}</div>
    <div class="fin-grade2 fin-grade2--5-7">
      <div class="fin-card"><h3>Saldo por conta</h3>${saldos}<p class="fin-sub">${esc(g.saldosPorConta.rotulo)}</p></div>
      <div class="fin-card"><h3>Movimentação por conta</h3>${mov}</div>
    </div>
    <div class="fin-grade2">
      <div class="fin-card">${graficoBarrasHorizontais(cats.itens.map((i) => ({ rotulo: i.nome, centavos: i.centavos, participacaoBps: i.participacaoBps })), { titulo: "Maiores custos e despesas" }) || estado.vazio("Sem custos ou despesas no período")}</div>
      <div class="fin-card"><h3>Pendências de classificação</h3>
        <p><strong>${pend.pendentes}</strong> lançamento(s) pendente(s) · ${moeda(pend.valorPendenteCentavos)}</p>
        <p class="fin-sub">${pend.semCategoria} sem categoria. Sem categoria ficam fora dos indicadores; pendentes já classificados entram nos números, mas aguardam confirmação. Resolva em Fluxo de Caixa (filtro “Pendentes”).</p>
        ${pend.semCategoria ? badge("Indicadores parciais", "warn") : pend.pendentes ? badge("Aguardando confirmação", "info") : badge("Tudo classificado", "ok")}
      </div>
    </div>`;
  redesenharAoRedimensionar(alvo, g.serie);
}

const graficoEs = (serie, largura) =>
  graficoEntradasSaidas(serie.map((s) => ({ ...s })), { titulo: "Entradas e saídas por dia (sem transferências internas)", largura }) || estado.vazio("Sem movimento operacional no período");

// O SVG é desenhado na largura real do cartão; ao redimensionar a janela (ou girar o celular) ele é redesenhado na nova largura.
function redesenharAoRedimensionar(alvo, serie) {
  alvo._finRo?.disconnect();
  const card = alvo.querySelector("[data-grafico-es]");
  if (!card || !serie.length || typeof ResizeObserver === "undefined") return;
  const util = () => { const cs = getComputedStyle(card); return card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); };
  let ultima = util();
  const ro = new ResizeObserver(() => {
    if (!card.isConnected) { ro.disconnect(); return; }
    const w = util();
    if (Math.abs(w - ultima) < 16) return;
    ultima = w;
    card.innerHTML = graficoEs(serie, w);
  });
  ro.observe(card);
  alvo._finRo = ro;
}
