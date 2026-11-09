// Dashboard iFood › CMV teórico: o custo das fichas técnicas aplicado ao que foi EFETIVAMENTE vendido no mês.
// Tudo é ESTIMATIVA (nunca resultado conciliado). Carrega só ao expandir; recolhido por padrão; sem localStorage.
import { escapeHtml, fmtMoeda, fmtPct } from "./utils.js";
import { dashExecCmvTeorico, obterCondicoesComerciais } from "./api.js";
import { abrirSimulador } from "./simuladorModal.js";
import { contextoMudou, geracaoContexto } from "./contextoEscopo.js";
import {
  periodoDoMes, situacaoIndicador, seloFichaProduto, cartoes, agruparProdutos, rotuloMotivoVinculo, rotuloSinal, AVISO_ESTIMATIVA,
} from "./cmvTeoricoModelo.js";

const montagens = new WeakMap();
let expandido = false;

const card = (rot, val, sub = "", dica = "") => `<div class="card" ${dica ? `title="${escapeHtml(dica)}"` : ""}><div class="card-label">${rot}</div><div class="card-valor">${val}</div>${sub ? `<div class="card-sub">${sub}</div>` : ""}</div>`;
const pct = (v) => (v == null ? "—" : fmtPct(v));

export function montarCmvTeorico(containerId, unidadeId, mes, ano, deps = {}) {
  const buscar = deps.dashExecCmvTeorico ?? dashExecCmvTeorico;
  const buscarCondicoes = deps.obterCondicoesComerciais ?? obterCondicoesComerciais;
  const abrirSim = deps.abrirSimulador ?? abrirSimulador;
  const container = document.getElementById(containerId);
  if (!container || !unidadeId) return;
  const montagem = {};
  montagens.set(container, montagem);
  const contexto = geracaoContexto();
  let estado = "idle"; let dados = null; let erro = null; let sequencia = 0;
  const obsoleto = (n) => n !== sequencia || contextoMudou(contexto) || !container.isConnected || montagens.get(container) !== montagem;
  const { de, ate } = periodoDoMes(mes, ano);

  const corpo = () => {
    if (estado === "carregando") return '<div class="estado-mini">Calculando o CMV teórico…</div>';
    if (estado === "erro") return `<p class="dex-sim-indisp">Não foi possível calcular: ${escapeHtml(erro)}</p><button class="btn btn-ghost btn-sm" data-retry type="button">Tentar novamente</button>`;
    if (estado !== "ok") return "";
    const sit = situacaoIndicador(dados);
    const c = cartoes(dados);
    const g = agruparProdutos(dados);
    const aviso = `<p class="ct-aviso ${sit.classe}"><b>${sit.texto}.</b> ${escapeHtml(sit.detalhe)}</p>`;
    if (dados.indisponivel) return aviso + semCorrespondenciaHtml();
    return aviso + `
      <div class="cards ct-cards">
        ${card("CMV teórico", pct(c.cmv), "sobre itens vinculados", "Custo das fichas técnicas ÷ receita dos itens vendidos que foram vinculados a produtos.")}
        ${card("CMV com ficha homologada", pct(c.cmvHomologado), !c.homologadoPct ? "nenhuma ficha homologada" : `${Math.round(c.homologadoPct)}% da receita`, "Considera só produtos cuja ficha foi homologada por um administrador.")}
        ${card("Receita vinculada", c.coberturaPct == null ? "—" : `${Math.round(c.coberturaPct)}%`, `${c.produtosVinculados} produto(s)`, "Parte da receita dos itens vendidos que foi vinculada a produtos do catálogo.")}
        ${card("Sem correspondência", String(c.semCorrespondencia), `${c.fichasIncompletas} com ficha incompleta`, "Itens vendidos que não foram vinculados a um produto, e produtos vinculados cuja ficha está incompleta.")}
      </div>
      ${g.desfavoraveis.length ? `<p class="ct-aviso bad"><b>Atenção:</b> ${g.desfavoraveis.length} produto(s) com precificação desfavorável: ${g.desfavoraveis.slice(0, 5).map((p) => `${escapeHtml(p.nome)} (${p.sinais.map(rotuloSinal).join(", ")})`).join("; ")}${g.desfavoraveis.length > 5 ? "…" : ""}.</p>` : ""}
      ${produtosHtml()}${semCorrespondenciaHtml()}
      <p class="ct-rodape">${escapeHtml(AVISO_ESTIMATIVA)} ${c.comissaoConsiderada == null ? "A margem após comissão não é exibida porque a comissão do iFood não está configurada (Configurações › Condições comerciais)." : `Margem após comissão considera a comissão configurada de ${(c.comissaoConsiderada * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%.`}</p>`;
  };

  const produtosHtml = () => {
    const lista = dados.produtos ?? [];
    if (!lista.length) return "";
    return `<h4 class="ct-h">Produtos vendidos (${lista.length})</h4><div class="tabela-wrap"><table class="grid ct-grid"><thead><tr>
      <th>Produto</th><th class="num">Qtd</th><th class="num">Receita</th><th class="num">Preço médio</th><th class="num">Custo un.</th><th class="num">CMV</th><th class="num" title="Preço menos custo, sem comissão">Margem bruta</th><th class="num">Margem após comissão</th><th>Ficha</th><th></th>
    </tr></thead><tbody>${lista.map((p, i) => { const s = seloFichaProduto(p); return `<tr class="${p.desfavoravel ? "ct-ruim" : ""}">
      <td><b>${escapeHtml(p.nome)}</b>${p.sinais?.length ? `<br><small class="bad">${p.sinais.map(rotuloSinal).join(" · ")}</small>` : ""}</td>
      <td class="num">${p.quantidade.toLocaleString("pt-BR")}</td><td class="num">${fmtMoeda(p.receita)}</td><td class="num">${fmtMoeda(p.preco_medio_praticado)}</td>
      <td class="num">${p.custo_unitario == null ? "—" : fmtMoeda(p.custo_unitario)}</td><td class="num">${pct(p.cmv_pct)}</td><td class="num">${pct(p.margem_bruta_pct)}</td><td class="num">${pct(p.margem_apos_comissao_pct)}</td>
      <td><span class="pill ${s.classe}">${s.texto}</span></td>
      <td>${p.custo_unitario == null ? "" : `<button class="btn btn-ghost btn-sm" data-sim="${i}" type="button">Simular preço</button>`}</td></tr>`; }).join("")}</tbody></table></div>`;
  };

  const semCorrespondenciaHtml = () => {
    const l = dados?.sem_correspondencia ?? [];
    if (!l.length) return "";
    return `<h4 class="ct-h">Itens vendidos sem correspondência no catálogo (${l.length})</h4>
      <p class="muted">Para vincular: cadastre no produto o <b>código do PDV</b> igual ao código do item no iFood, ou use exatamente o mesmo nome.</p>
      <div class="tabela-wrap"><table class="grid"><thead><tr><th>Item no iFood</th><th>Código</th><th class="num">Qtd</th><th class="num">Receita</th><th>Motivo</th></tr></thead><tbody>
      ${l.slice(0, 50).map((s) => `<tr><td>${escapeHtml(s.nome)}</td><td>${escapeHtml(s.codigo ?? "—")}</td><td class="num">${s.quantidade.toLocaleString("pt-BR")}</td><td class="num">${fmtMoeda(s.receita)}</td><td>${escapeHtml(rotuloMotivoVinculo(s.motivo))}</td></tr>`).join("")}
      </tbody></table></div>${l.length > 50 ? `<p class="muted">Mostrando os 50 de maior receita.</p>` : ""}`;
  };

  const render = () => {
    container.innerHTML = `<section class="dex-painel ct-painel"><button type="button" class="dex-sim-faixa" data-toggle aria-expanded="${expandido}" aria-controls="ct-corpo">
      <span class="dex-sim-faixa-info"><strong>CMV teórico (estimativa)</strong><span class="dex-sim-faixa-meta">itens vendidos no iFood × fichas técnicas · ${escapeHtml(de.slice(5, 7))}/${escapeHtml(de.slice(0, 4))}</span></span>
      <span class="dex-sim-faixa-acao"><span class="dex-sim-faixa-label">${expandido ? "Recolher" : "Expandir"}</span><span class="dex-sim-faixa-chevron" aria-hidden="true"></span></span></button>
      <div id="ct-corpo" class="dex-sim-corpo" ${expandido ? "" : "hidden"}>${corpo()}</div></section>`;
    container.querySelector("[data-toggle]").addEventListener("click", () => {
      expandido = !expandido;
      if (expandido && estado === "idle") carregar(); else render();
    });
    container.querySelector("[data-retry]")?.addEventListener("click", carregar);
    container.querySelectorAll("[data-sim]").forEach((b) => b.addEventListener("click", async () => {
      const p = dados.produtos[Number(b.dataset.sim)];
      const condicoes = await buscarCondicoes().then((r) => r.data ?? null).catch(() => null);
      abrirSim({ nome: p.nome, custo: p.custo_unitario, preco: p.preco_medio_praticado, canal: "ifood" }, condicoes);
    }));
  };

  async function carregar() {
    const n = ++sequencia; estado = "carregando"; render();
    try {
      const r = await buscar({ unidadeId, de, ate });
      if (obsoleto(n)) return;
      dados = r.data; estado = "ok";
    } catch (e) {
      if (obsoleto(n)) return;
      erro = e.message; estado = "erro";
    }
    render();
  }

  render();
  if (expandido) carregar();
}
