// Card "Simulação de preço" da Visão Geral do Dashboard iFood.
//
// CONCEITO: os DOIS canais ao mesmo tempo, lado a lado — não mais um seletor
// "Canal" que alterna entre eles. O objetivo é comparar: o mesmo produto,
// vendido no balcão e no iFood, com tabelas de preço diferentes, rende
// margens diferentes — e isso só fica óbvio vendo os dois juntos.
//
// Cada lado tem seu PRÓPRIO seletor de tabela, independente: o balcão pode
// estar na tabela B e o iFood na Z4 ao mesmo tempo. Trocar um não mexe no
// outro (são duas requisições separadas, cada uma com sua tabela).
//
// Fonte dos números — nada é hardcoded, tudo vem do backend
// (dashboardExecutivo.simulador.service.js):
//   * preço     -> produto_precos da tabela escolhida naquele canal;
//   * custo     -> ficha técnica real do produto (mesmo grafo do CMV);
//   * deduções  -> % real de Taxas e Comissões e de Serviços e Promoções
//                  apurados no mês/unidade (iFood) — mesmos indicadores da
//                  Visão Geral, com meta/limite/status reaproveitados dali;
//   * referência -> soma das metas ideais das duas deduções acima, pro
//                  modelo logístico (Marketplace/Full Service) da unidade.
// Trocar de unidade, de mês ou mexer no custo dos insumos muda os dois lados,
// porque os dois lados são recalculados no servidor a cada render.
import { escapeHtml, fmtMoeda, fmtPct, statusCmv } from "./utils.js";
import { state } from "./state.js";
import { dashExecSimuladorPreco } from "./api.js";
import { registrarResetDeContexto, geracaoContexto, contextoMudou } from "./contextoEscopo.js";
import { icon } from "./icons.js";

// Diferença entre percentuais (ex.: CMV iFood − CMV Balcão) usa "p.p.", nunca
// "%" — "%" leria como variação relativa, não diferença de pontos.
const fmtPp = (v) => (v == null || Number.isNaN(Number(v)) ? "—" : `${Number(v).toFixed(1)} p.p.`);

// Status "dentro da meta / atenção / fora da meta" vem PRONTO do backend
// (statusIndicador em dashboardExecutivo.calc.js — a MESMA função que a
// Visão Geral usa) — aqui só traduz a chave pra classe de CSS do pill. Fonte
// única, sem regra duplicada.
const CLASSE_STATUS = { dentro_da_meta: "ok", atencao: "warn", fora_da_meta: "bad", sem_dados: "muted" };

/** Tabela escolhida em cada lado (independentes por design — ver cabeçalho) +
 * se o card está expandido. Recolhido é o padrão (item 1 do pedido de UX):
 * o simulador é uma ferramenta complementar, não pode competir em espaço com
 * os indicadores financeiros logo abaixo dele na Visão Geral. */
const estado = { balcao: "A", ifood: "A", expandido: false };

const PAINEIS = [
  { canal: "balcao", rotulo: "Balcão", icone: "store" },
  { canal: "ifood", rotulo: "iFood", icone: "smartphone" },
];

// A tabela escolhida é preferência de leitura de UMA unidade — ao trocar de
// unidade a tabela pode nem existir no catálogo da nova. Volta ao padrão.
registrarResetDeContexto(() => {
  estado.balcao = "A";
  estado.ifood = "A";
});

/**
 * Monta (ou remonta) o card dentro do elemento `containerId`. Chame de novo
 * sempre que a unidade OU o mês/ano do Dashboard iFood mudarem — a taxa do
 * iFood é apurada por mês, então o simulador precisa olhar exatamente o mesmo
 * período que a Visão Geral está mostrando.
 * @param {string} containerId @param {string|null} unidadeId @param {number} mes @param {number} ano
 */
export function montarSimuladorPreco(containerId, unidadeId, mes, ano) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!unidadeId) {
    container.innerHTML = "";
    return;
  }
  render(container, unidadeId, mes, ano);
}

function render(container, unidadeId, mes, ano) {
  // Garante que a tabela guardada existe na lista do canal (a lista do balcão
  // e a do iFood são diferentes). Catálogo real da empresa (state), nunca
  // uma lista global hardcoded.
  for (const { canal } of PAINEIS) {
    const lista = state.tabelasDisponiveis?.[canal] ?? [];
    if (lista.length && !lista.includes(estado[canal])) estado[canal] = lista[0];
  }

  container.innerHTML = `
    <section class="dex-painel dex-simulador">
      <div class="dex-sim-cabecalho">
        <div class="dex-sim-titulo-wrap">
          <h3>${icon("calculator", { size: 15 })} Simulação de preço — Churrasco 15cm</h3>
          <p class="dex-sim-desc" ${estado.expandido ? "" : "hidden"}>Balcão e iFood lado a lado — preço e custo reais, cada canal com sua tabela.</p>
        </div>
        <button class="btn btn-ghost btn-sm dex-sim-toggle" id="dex-sim-toggle" type="button" aria-expanded="${estado.expandido}">
          ${estado.expandido ? "Recolher" : "Expandir simulador"}
        </button>
      </div>

      <div id="dex-sim-resumo" class="dex-sim-resumo" ${estado.expandido ? "hidden" : ""}>
        <div class="estado-mini"><div class="spinner"></div>Calculando…</div>
      </div>

      <div id="dex-sim-corpo" class="dex-sim-corpo" ${estado.expandido ? "" : "hidden"}>
        <div class="dex-sim-duplo">
          ${PAINEIS.map((p) => painelHtml(p)).join("")}
        </div>
        <div id="dex-sim-comparacao" class="dex-sim-comparacao" hidden></div>
      </div>
    </section>`;

  container.querySelector("#dex-sim-toggle").addEventListener("click", () => {
    estado.expandido = !estado.expandido;
    aplicarEstadoExpandido(container);
  });

  for (const { canal } of PAINEIS) {
    container.querySelector(`#dex-sim-tabela-${canal}`).addEventListener("change", (e) => {
      estado[canal] = e.target.value;
      // Recarrega SÓ o lado alterado — o outro canal não é afetado por esta
      // troca (é justamente a independência que o card promete). A comparação
      // e o resumo compacto são recalculados quando o lado novo chega.
      carregarLado(container, canal, unidadeId, mes, ano);
    });
  }

  carregarTudo(container, unidadeId, mes, ano);
}

/**
 * Alterna entre o resumo compacto (padrão) e os dois painéis completos — só
 * troca a visibilidade (`hidden`), nunca reconstrói o DOM. Os selects de
 * tabela de cada canal e os dados já carregados continuam exatamente onde
 * estavam (item 1 do pedido: não perder o estado das tabelas ao recolher).
 */
function aplicarEstadoExpandido(container) {
  const resumo = container.querySelector("#dex-sim-resumo");
  const corpo = container.querySelector("#dex-sim-corpo");
  const desc = container.querySelector(".dex-sim-desc");
  const btn = container.querySelector("#dex-sim-toggle");
  if (resumo) resumo.hidden = estado.expandido;
  if (corpo) corpo.hidden = !estado.expandido;
  if (desc) desc.hidden = !estado.expandido;
  if (btn) {
    btn.textContent = estado.expandido ? "Recolher" : "Expandir simulador";
    btn.setAttribute("aria-expanded", String(estado.expandido));
  }
}

function painelHtml({ canal, rotulo, icone }) {
  const tabelas = state.tabelasDisponiveis?.[canal] ?? [];
  return `
    <div class="dex-sim-lado" data-canal="${canal}">
      <div class="dex-sim-lado-topo">
        <span class="dex-sim-lado-titulo">${icon(icone, { size: 14 })} ${rotulo}</span>
        <label class="dex-sim-lado-tabela">
          <span>Tabela</span>
          <select id="dex-sim-tabela-${canal}" aria-label="Tabela de preço do ${rotulo}">
            ${tabelas.map((t) => `<option value="${escapeHtml(t)}" ${t === estado[canal] ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}
          </select>
        </label>
      </div>
      <div id="dex-sim-res-${canal}" class="dex-sim-lado-corpo">
        <div class="estado-mini"><div class="spinner"></div>Calculando…</div>
      </div>
    </div>`;
}

// Resultado mais recente de cada lado — é o que alimenta a comparação do
// rodapé. `null` enquanto o lado não respondeu (ou respondeu sem preço):
// comparar com dado ausente produziria uma "diferença" inventada.
const ultimo = { balcao: null, ifood: null };

async function carregarTudo(container, unidadeId, mes, ano) {
  await Promise.all(PAINEIS.map(({ canal }) => carregarLado(container, canal, unidadeId, mes, ano)));
}

async function carregarLado(container, canal, unidadeId, mes, ano) {
  const box = container.querySelector(`#dex-sim-res-${canal}`);
  if (!box) return;
  box.innerHTML = `<div class="estado-mini"><div class="spinner"></div>Calculando…</div>`;
  const g = geracaoContexto();
  try {
    const { data } = await dashExecSimuladorPreco({ unidadeId, canal, tabela: estado[canal], mes, ano });
    if (contextoMudou(g)) return; // resposta da unidade anterior — descarta
    ultimo[canal] = data;
    box.innerHTML = ladoHtml(data);
  } catch (e) {
    if (contextoMudou(g)) return;
    ultimo[canal] = null;
    box.innerHTML = `<div class="estado-mini">${icon("alert-triangle", { size: 15 })}<p>${escapeHtml(e.message)}</p></div>`;
  }
  renderComparacao(container);
  atualizarResumo(container);
}

/**
 * Resumo compacto (estado padrão, recolhido) — só os 5 números que mais
 * importam pra uma decisão rápida: os dois preços, a diferença entre eles e
 * as duas margens. Mesmos dados de `ultimo` que já alimentam o rodapé de
 * comparação do modo expandido — não recalcula nada, só reapresenta.
 */
function resumoHtml() {
  const b = ultimo.balcao, i = ultimo.ifood;
  const item = (label, valorHtml) => `<div class="dex-sim-resumo-item"><span>${label}</span><b>${valorHtml}</b></div>`;
  const itens = [
    item("Balcão", b?.preco != null ? fmtMoeda(b.preco) : "—"),
    item("iFood", i?.preco != null ? fmtMoeda(i.preco) : "—"),
  ];
  if (b?.preco != null && i?.preco != null) {
    const diff = i.preco - b.preco;
    const sinal = Math.abs(diff) < 0.005 ? "" : diff > 0 ? "+" : "−";
    itens.push(item("Diferença", `${sinal}${fmtMoeda(Math.abs(diff))}`));
  }
  itens.push(item("Margem Balcão", b?.margemEstimada != null ? fmtMoeda(b.margemEstimada) : "—"));
  itens.push(item("Margem iFood", i?.margemEstimada != null ? fmtMoeda(i.margemEstimada) : "—"));
  return itens.join("");
}

function atualizarResumo(container) {
  const box = container.querySelector("#dex-sim-resumo");
  if (box) box.innerHTML = resumoHtml();
}

function linha(label, valorHtml, cls = "") {
  return `<div class="dex-sim-linha ${cls}"><span>${label}</span><b>${valorHtml}</b></div>`;
}

/**
 * Segunda linha, discreta, embaixo de uma dedução (Taxas e Comissões /
 * Serviços e Promoções): meta ideal, limite e o selo de status — reaproveita
 * `status` já calculado no backend (mesma regra da Visão Geral). Some quando
 * não há meta configurada para o modelo (nunca inventa "0%").
 */
function metaLinha(status, metaIdeal, limite) {
  if (!status || status.chave === "sem_dados") return "";
  const classe = CLASSE_STATUS[status.chave] ?? "muted";
  return `<div class="dex-sim-meta"><span>Meta ${fmtPct(metaIdeal)} · Limite ${fmtPct(limite)}</span><span class="pill ${classe}">${escapeHtml(status.label)}</span></div>`;
}

function ladoHtml(d) {
  if (d.preco == null) {
    return `<div class="estado-mini"><p>${escapeHtml(d.indisponivel ?? "Preço não cadastrado para esta tabela.")}</p></div>`;
  }
  const st = statusCmv(d.cmvPct);
  const linhas = [
    linha("Preço", `${fmtMoeda(d.preco)}${d.precoDesatualizado ? ' <span class="dex-sim-badge">2024</span>' : ""}`),
    linha("Custo", fmtMoeda(d.custo)),
    linha("CMV", `<span class="pill ${st.classe}">${fmtPct(d.cmvPct)}</span>`),
  ];

  // Só o iFood tem dedução de canal — o balcão não carrega uma dedução que
  // não existe (é o que torna a comparação das duas margens honesta).
  if (d.canal === "ifood") {
    linhas.push(linha("Taxas e Comissões", d.taxaEstimadaPct == null ? "—" : `${fmtPct(d.taxaEstimadaPct)} <small>${fmtMoeda(d.taxaEstimadaReais)}</small>`));
    linhas.push(metaLinha(d.taxaEstimadaStatus, d.taxaEstimadaMetaIdeal, d.taxaEstimadaLimite));
    linhas.push(linha("Serviços e Promoções", d.servicosPromocoesPct == null ? "—" : `${fmtPct(d.servicosPromocoesPct)} <small>${fmtMoeda(d.servicosPromocoesReais)}</small>`));
    linhas.push(metaLinha(d.servicosPromocoesStatus, d.servicosPromocoesMetaIdeal, d.servicosPromocoesLimite));
    linhas.push(linha("Receita após Taxas e Comissões + Serviços e Promoções", d.receitaAposDeducoesConsideradas == null ? "—" : fmtMoeda(d.receitaAposDeducoesConsideradas)));
  }

  linhas.push(linha(
    "Margem estimada",
    d.margemEstimada == null ? "—" : `${fmtMoeda(d.margemEstimada)} <small>${fmtPct(d.margemEstimadaPct)}</small>`,
    "dex-sim-linha-destaque",
  ));

  const notaTexto = [d.taxaEstimadaFonte, d.margemNota].filter(Boolean).join(" ");
  const notaTip = notaTexto ? `<span class="vd-tip" data-tip="${escapeHtml(notaTexto)}" tabindex="0">i</span>` : "";

  return `
    <div class="dex-sim-linhas">${linhas.join("")}</div>
    ${d.indisponivel ? `<p class="dex-sim-aviso">ℹ️ ${escapeHtml(d.indisponivel)}</p>`
      : notaTip ? `<p class="dex-sim-aviso">${notaTip} Sobre este cálculo — não é lucro líquido</p>` : ""}`;
}

/**
 * Rodapé de comparação — DOIS blocos separados de propósito (pedido de
 * clareza de 19/08: a comparação de preço e a comparação de deduções são
 * perguntas diferentes e misturadas no mesmo rodapé confundiam leitura):
 *
 *   1. "Preço iFood × Balcão"   — quanto o preço do iFood está acima do
 *      Balcão, e se isso está perto do que o canal cobra de volta.
 *   2. "Deduções reais do mês"  — o que o canal está cobrando de verdade
 *      este mês, contra a meta combinada do modelo logístico.
 *
 * As duas comparam contra a MESMA referência (`referenciaModeloPct`), mas
 * contra números diferentes (diferença de preço % vs. deduções reais %) —
 * por isso duas seções, nunca um número só. Nenhuma fórmula nova aqui: só
 * reorganização de layout/rótulo por cima dos mesmos campos de sempre.
 */
function renderComparacao(container) {
  const box = container.querySelector("#dex-sim-comparacao");
  if (!box) return;
  const b = ultimo.balcao, i = ultimo.ifood;

  const blocos = [blocoPrecoHtml(b, i), blocoDeducoesHtml(i)].filter(Boolean).join("");

  const extra = [];
  if (b?.cmvPct != null && i?.cmvPct != null) {
    // CMV: menor é melhor, então a seta verde/vermelha se inverte. "p.p.",
    // nunca "%" — é diferença entre dois percentuais, não variação relativa.
    extra.push(itemComparacao("Diferença de CMV", i.cmvPct - b.cmvPct, fmtPp, { menorMelhor: true, cru: true }));
  }
  if (b?.margemEstimada != null && i?.margemEstimada != null) {
    extra.push(itemComparacao("Diferença de margem", i.margemEstimada - b.margemEstimada, fmtMoeda));
  }

  if (!blocos && !extra.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = `
    <span class="dex-sim-comp-rotulo">iFood × Balcão</span>
    ${blocos ? `<div class="dex-sim-comp-blocos">${blocos}</div>` : ""}
    ${extra.length ? `<div class="dex-sim-comp-extra">${extra.join("")}</div>` : ""}`;
}

/**
 * Bloco 1 — Preço iFood × Balcão. Só aparece quando os DOIS lados têm preço
 * (comparar contra um lado indisponível daria uma diferença falsa).
 */
function blocoPrecoHtml(b, i) {
  if (b?.preco == null || i?.preco == null) return "";
  const delta = i.preco - b.preco;
  // % que a diferença representa SOBRE O PREÇO DO IFOOD (nunca sobre o do
  // Balcão) — responde "que fatia do preço final do iFood é o acréscimo
  // sobre o Balcão" (11/35, não 11/24).
  const pctDelta = i.preco ? (delta / i.preco) * 100 : null;

  const itens = [
    itemComparacao("Diferença de preço", delta, fmtMoeda),
    itemSimples("Acréscimo representado no preço iFood", pctDelta != null ? fmtPct(pctDelta) : "—"),
  ];
  if (i.referenciaModeloPct != null) {
    // Rótulo nomeia o modelo dinamicamente ("...do Marketplace" / "...do Full
    // Service") — nunca hardcoded, vem de modeloLogisticoRotulo (a unidade).
    const rotuloReferencia = i.modeloLogisticoRotulo
      ? `Referência de precificação do ${escapeHtml(i.modeloLogisticoRotulo)}`
      : "Referência de precificação do modelo";
    itens.push(itemSimples(rotuloReferencia, fmtPct(i.referenciaModeloPct), "neutro"));
    const situacao = situacaoTexto(pctDelta, i.referenciaModeloPct, { na: "Na referência", da: "da referência" });
    if (situacao) itens.push(itemSimples("Situação", situacao, "neutro"));
  }
  return blocoHtml("Preço iFood × Balcão", itens.join(""), modeloBadge(i));
}

/** Badge "Marketplace"/"Full Service" no cabeçalho de um bloco — mesma
 * apresentação nos dois blocos (item 1 do pedido de 19/08: "Modelo atual"
 * deve aparecer no bloco de Preço do mesmo jeito que já aparece no de
 * Deduções). Some se a unidade não tiver modelo resolvido. */
function modeloBadge(i) {
  return i?.modeloLogisticoRotulo ? `<span class="dex-sim-comp-modelo">${escapeHtml(i.modeloLogisticoRotulo)}</span>` : "";
}

/**
 * Bloco 2 — Deduções reais do mês. Depende só do lado iFood (Taxas e
 * Comissões + Serviços e Promoções não existem no Balcão) — por isso
 * aparece mesmo que o painel Balcão ainda não tenha carregado.
 */
function blocoDeducoesHtml(i) {
  if (i?.taxaEstimadaPct == null && i?.servicosPromocoesPct == null) return "";
  const itens = [];
  if (i.taxaEstimadaPct != null) itens.push(itemSimples("Taxas e Comissões", fmtPct(i.taxaEstimadaPct)));
  if (i.servicosPromocoesPct != null) itens.push(itemSimples("Serviços e Promoções", fmtPct(i.servicosPromocoesPct)));
  if (i.deducoesConsideradasPct != null) itens.push(itemSimples("Total atual", fmtPct(i.deducoesConsideradasPct)));
  if (i.referenciaModeloPct != null) {
    itens.push(itemSimples("Meta combinada de deduções", fmtPct(i.referenciaModeloPct), "neutro"));
  }
  if (i.limiteCombinadoPct != null) {
    // Soma dos LIMITES reais (teto), não das metas ideais — ver
    // limiteCombinadoPct() em dashboardExecutivo.calc.js. Costuma ser maior
    // que a meta combinada acima (Serviços e Promoções normalmente tem
    // limite > meta), então as duas situações abaixo podem divergir.
    itens.push(itemSimples("Limite combinado de deduções", fmtPct(i.limiteCombinadoPct), "neutro"));
  }
  if (i.referenciaModeloPct != null) {
    const situacaoMeta = situacaoTexto(i.deducoesConsideradasPct, i.referenciaModeloPct, { na: "Na meta", da: "da meta" });
    if (situacaoMeta) itens.push(itemSimples("Situação", situacaoMeta, "neutro"));
  }
  if (i.limiteCombinadoPct != null) {
    const situacaoLimite = situacaoTexto(i.deducoesConsideradasPct, i.limiteCombinadoPct, { na: "No limite", da: "do limite" });
    if (situacaoLimite) itens.push(itemSimples("Situação (limite)", situacaoLimite, "neutro"));
  }
  return blocoHtml("Deduções reais do mês", itens.join(""), modeloBadge(i));
}

function blocoHtml(titulo, itensHtml, extraTitulo = "") {
  return `<div class="dex-sim-comp-bloco">
    <h4>${titulo}${extraTitulo}</h4>
    ${itensHtml}
  </div>`;
}

/**
 * Situação NEUTRA de `atual` frente a `referencia` — mesmo cálculo/semântica
 * de `situacaoDiferencaPreco` em dashboardExecutivo.calc.js (espelhado aqui
 * porque front e back não compartilham módulo). Nunca usa "dentro/fora":
 * pro bloco de Preço a referência é régua de compensação de custo, e mesmo
 * pro Limite combinado (que É um teto) a linguagem fica neutra por
 * consistência com a Situação da Meta logo acima.
 *
 * `rotulos.na`/`rotulos.da` já vêm com o artigo certo do chamador — "meta" é
 * feminino ("Na meta"/"da meta"), "limite" é masculino ("No limite"/"do
 * limite") — pra nunca gerar concordância errada compondo aqui dentro.
 * @param {number|null} atual @param {number|null} referencia
 * @param {{na: string, da: string}} rotulos
 * @returns {string|null}
 */
function situacaoTexto(atual, referencia, { na, da }) {
  if (atual == null || referencia == null) return null;
  const diferencaPp = atual - referencia;
  if (Math.abs(diferencaPp) < 0.05) return na;
  return `${fmtPp(Math.abs(diferencaPp))} ${diferencaPp > 0 ? "acima" : "abaixo"} ${da}`;
}

/** Linha simples label:valor, sem seta/cor de delta (usada dentro dos blocos
 * — não é uma comparação "bom/ruim", é a restituição de um número real). */
function itemSimples(label, valorHtml, cls = "") {
  return `<div class="dex-sim-comp-item ${cls}"><span>${label}</span><b>${valorHtml}</b></div>`;
}

function itemComparacao(label, delta, fmt, { menorMelhor = false, cru = false } = {}) {
  const zero = Math.abs(delta) < 0.005;
  const bom = menorMelhor ? delta < 0 : delta > 0;
  const classe = zero ? "neutro" : bom ? "positivo" : "negativo";
  const sinal = zero ? "" : delta > 0 ? "+" : "−";
  // `cru`: o formatador já devolve o texto pronto (ex.: "8,0 p.p."), sem
  // sinal/abs aplicado de novo por cima (usado pela Diferença de CMV).
  const valor = `${sinal}${fmt(Math.abs(delta))}`;
  return `<div class="dex-sim-comp-item ${classe}"><span>${label}</span><b>${valor}</b></div>`;
}
