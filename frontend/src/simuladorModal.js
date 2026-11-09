// Simulador de preço: mexe no preço e vê CMV, deduções, lucro líquido e margem ao vivo.
// A comissão vem das condições comerciais DA EMPRESA (GET /cmv/condicoes-comerciais) — nenhum
// percentual é assumido. Sem comissão configurada para o canal, o resultado é marcado como PARCIAL.
import { fmtMoeda, fmtPct, escapeHtml, statusCmv } from "./utils.js";
import { simularPreco, precoParaMargem, precoParaCmv, compararCenarios, comissaoDoCanal, COMPONENTES } from "./simulacaoPreco.js";

const CANAL_LABEL = { balcao: "Balcão", ifood: "iFood", uber: "Uber", app: "App", outro: "Outro" };
const CANAIS = ["balcao", "ifood", "uber"];

let overlay = null;
function fechar() {
  overlay?.remove();
  overlay = null;
  document.removeEventListener("keydown", onKey);
}
function onKey(e) { if (e.key === "Escape") fechar(); }

const rotuloComp = (chave) => COMPONENTES.find((c) => c.chave === chave)?.rotulo ?? chave;
const lerPct = (v) => { const n = Number(String(v).replace(",", ".")); return String(v).trim() === "" || !Number.isFinite(n) ? null : n / 100; };
const lerNum = (v) => { const n = Number(String(v).replace(",", ".")); return String(v).trim() === "" || !Number.isFinite(n) ? null : n; };

/**
 * @param {object} row linha do CMV (nome, custo, preco, canal)
 * @param {{configurado: boolean, canais: Array<{canal: string, comissao: number}>}|null} condicoes
 */
export function abrirSimulador(row, condicoes = null) {
  fechar();
  const custo = Number(row.custo) || 0;
  // Sem preço atual cadastrado o sistema NÃO inventa um: "Hoje" fica indisponível e o ponto de partida do slider é o preço
  // que daria CMV de 30% (sugestão explícita, não preço da loja).
  const precoAtual = Number(row.preco) > 0 ? Number(row.preco) : null;
  const pontoDePartida = custo > 0 ? Math.ceil(((custo * 100) / 30) * 2) / 2 : 10;
  let canal = CANAIS.includes(row.canal) ? row.canal : "balcao";
  let preco = precoAtual ?? pontoDePartida;
  const maxPreco = Math.max(Math.ceil((precoAtual ?? pontoDePartida) * 2), Math.ceil(custo * 3), 10);

  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal modal-sim"></div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) fechar(); });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKey);

  const opcoesCanal = CANAIS.map((c) => {
    const com = comissaoDoCanal(condicoes, c);
    const rot = com == null ? "comissão não configurada" : `${(com * 100).toFixed(1).replace(/\.0$/, "")}%`;
    return `<option value="${c}" ${c === canal ? "selected" : ""}>${CANAL_LABEL[c]} · ${rot}</option>`;
  }).join("");

  const m = overlay.querySelector(".modal");
  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head">
      <h2>🧮 Simular preço</h2>
      <div class="modal-tags"><span class="chip">${escapeHtml(row.nome)}</span></div>
    </div>

    <div class="sim-topo">
      <div class="sim-info" title="Custo técnico da ficha: ingredientes e embalagens por unidade vendida. Não inclui mão de obra."><span>Custo (ficha técnica)</span><strong>${fmtMoeda(custo)}</strong></div>
      <div class="sim-info" ${precoAtual == null ? 'title="Este produto ainda não tem preço de venda cadastrado. O simulador começa no preço que daria CMV de 30%."' : ""}><span>Preço atual</span><strong>${precoAtual == null ? "não cadastrado" : fmtMoeda(precoAtual)}</strong></div>
      <div class="sim-info">
        <span>Canal</span>
        <select id="sim-canal">${opcoesCanal}</select>
      </div>
    </div>

    <div class="sim-aviso" id="sim-aviso" role="status"></div>

    <div class="sim-preco-box">
      <label>Preço de venda simulado <strong id="sim-preco-lbl"></strong></label>
      <input id="sim-slider" type="range" min="0" max="${maxPreco}" step="0.5" value="${preco}" />
      <div class="sim-preco-num">R$ <input id="sim-preco" type="number" min="0" step="0.5" value="${preco}" /></div>
    </div>

    <details class="sim-extras">
      <summary>Outras condições (opcional — deixe vazio para não considerar)</summary>
      <div class="sim-extras-grid">
        <label title="Taxas de pagamento ou de serviço cobradas sobre a venda.">Taxas (%) <input id="sim-taxas" type="number" min="0" max="99" step="0.1" /></label>
        <label title="Parte das promoções/cupons que a loja custeia, como % do preço.">Promoções da loja (%) <input id="sim-promo" type="number" min="0" max="99" step="0.1" /></label>
        <label title="Tributos sobre a venda (ex.: Simples Nacional), como % do preço.">Tributos (%) <input id="sim-trib" type="number" min="0" max="99" step="0.1" /></label>
        <label title="Custo de entrega que a loja paga por pedido, em reais.">Entrega por pedido (R$) <input id="sim-entrega" type="number" min="0" step="0.5" /></label>
      </div>
    </details>

    <div class="sim-resultados" id="sim-out"></div>
    <div class="sim-comparacao" id="sim-comp"></div>

    <div class="sim-alvo">
      <label title="Margem de contribuição = o que sobra do preço depois do custo e de todas as deduções.">Margem de contribuição desejada (%)
        <input id="sim-margem-alvo" type="number" min="0" max="99" step="1" placeholder="ex.: 35" /></label>
      <span id="sim-alvo-out"></span>
    </div>
    <div class="sim-ref" id="sim-ref"></div>
  `;
  m.querySelector(".modal-close").addEventListener("click", fechar);

  const $ = (s) => m.querySelector(s);
  const condicaoAtual = () => ({
    comissao: comissaoDoCanal(condicoes, canal),
    taxas: lerPct($("#sim-taxas").value), promocao: lerPct($("#sim-promo").value),
    tributos: lerPct($("#sim-trib").value), entrega: lerNum($("#sim-entrega").value),
  });

  function calc() {
    const cond = condicaoAtual();
    const r = simularPreco({ custo, preco, ...cond });
    const st = statusCmv(r.cmvPct);
    const parcialTxt = r.parcial ? ` <span class="pill warn" title="Falta a comissão deste canal">parcial</span>` : "";

    $("#sim-preco-lbl").textContent = fmtMoeda(preco);
    $("#sim-aviso").innerHTML = r.parcial
      ? `⚠ <b>Cálculo parcial.</b> A comissão do canal <b>${CANAL_LABEL[canal]}</b> não está configurada para esta empresa — o lucro abaixo <b>não desconta comissão</b>. Peça a configuração das condições comerciais ou use o canal Balcão.`
      : (r.naoConsiderados.length ? `Não considerado${r.naoConsiderados.length > 1 ? "s" : ""}: ${r.naoConsiderados.map(rotuloComp).join(", ").toLowerCase()}.` : "");
    $("#sim-aviso").className = `sim-aviso ${r.parcial ? "sim-aviso-parcial" : "sim-aviso-info"}`;
    $("#sim-aviso").hidden = !$("#sim-aviso").innerHTML;

    const linhas = [];
    for (const k of ["comissao", "taxas", "promocao", "tributos"]) {
      const v = r.deducoesPct[k];
      if (v != null) linhas.push(`<div class="sim-card"><span>${rotuloComp(k)} (${(cond[k] * 100).toFixed(1).replace(/\.0$/, "")}%)</span><b class="neg">- ${fmtMoeda(v)}</b></div>`);
    }
    if (r.entrega != null) linhas.push(`<div class="sim-card"><span>Entrega</span><b class="neg">- ${fmtMoeda(r.entrega)}</b></div>`);
    $("#sim-out").innerHTML = `
      <div class="sim-card" title="CMV = custo dos ingredientes ÷ preço de venda."><span>CMV</span><b><span class="pill ${st.classe}">${fmtPct(r.cmvPct)}</span></b></div>
      ${linhas.join("")}
      <div class="sim-card ${r.lucro != null && r.lucro < 0 ? "ruim" : "bom"}"><span>Lucro líquido${parcialTxt}</span><b>${r.lucro == null ? "—" : fmtMoeda(r.lucro)}</b></div>
      <div class="sim-card"><span>Margem${parcialTxt}</span><b>${fmtPct(r.margemPct)}</b></div>`;

    const cmp = compararCenarios({ custo, precoAtual, precoProposto: preco, ...cond });
    const celula = (x) => `${fmtMoeda(x.preco)} · lucro ${x.lucro == null ? "—" : fmtMoeda(x.lucro)} · margem ${fmtPct(x.margemPct)}`;
    $("#sim-comp").innerHTML = `
      <div class="sim-comp-linha"><span>Hoje</span><b>${celula(cmp.atual)}</b></div>
      <div class="sim-comp-linha"><span>Simulado</span><b>${celula(cmp.proposto)}</b></div>
      ${cmp.deltaLucro == null ? "" : `<div class="sim-comp-linha"><span>Diferença</span><b class="${cmp.deltaLucro < 0 ? "neg" : ""}">${cmp.deltaLucro >= 0 ? "+" : ""}${fmtMoeda(cmp.deltaLucro)} por venda</b></div>`}`;

    const alvoPct = lerNum($("#sim-margem-alvo").value);
    const necessario = alvoPct == null ? null : precoParaMargem({ custo, margemAlvoPct: alvoPct, ...cond });
    $("#sim-alvo-out").innerHTML = alvoPct == null ? ""
      : necessario == null ? `<b class="neg">Impossível: deduções + margem passam de 100%.</b>`
      : `Preço necessário: <b>${fmtMoeda(necessario)}</b>${r.parcial ? " <span class='pill warn'>parcial</span>" : ""}`;

    const alvo = (x) => { const p = precoParaCmv(custo, x); return p == null ? "—" : fmtMoeda(p); };
    $("#sim-ref").innerHTML = `<span class="sim-ref-t">🎯 Preço para CMV alvo:</span> <b>30%</b> ${alvo(30)} &nbsp;·&nbsp; <b>28%</b> ${alvo(28)} &nbsp;·&nbsp; <b>25%</b> ${alvo(25)}`;
  }

  $("#sim-slider").addEventListener("input", (e) => { preco = Number(e.target.value); $("#sim-preco").value = preco; calc(); });
  $("#sim-preco").addEventListener("input", (e) => { preco = Number(e.target.value) || 0; $("#sim-slider").value = Math.min(preco, maxPreco); calc(); });
  $("#sim-canal").addEventListener("change", (e) => { canal = e.target.value; calc(); });
  for (const id of ["#sim-taxas", "#sim-promo", "#sim-trib", "#sim-entrega", "#sim-margem-alvo"]) $(id).addEventListener("input", calc);
  calc();
}
