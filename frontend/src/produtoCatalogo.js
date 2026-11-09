// Seções de CATÁLOGO dentro do detalhe do Produto (o mesmo modal das Subways): homologação e pendências, formação de custo
// (ingredientes, preparações, embalagens, rendimento, mão de obra à parte), vínculo com o iFood e margem de contribuição por canal.
// Só é usado quando `p.controlado` (produtos importados/independentes). Produtos sem controle (Subways) não passam por aqui.
import { escapeHtml, fmtMoeda, fmtPct, fmtDataHora, toast } from "./utils.js";
import { atualizarProduto, definirHomologacaoFicha } from "./api.js";
import { abrirHistoricoModal } from "./historicoModal.js";
import { abrirSimulador } from "./simuladorModal.js";
import { pode } from "./sessao.js";
import { seloHomologacao, rotuloMotivo, pendenciasDoItem } from "./fichasModelo.js";
import { itemDoProduto, podeHomologarProduto, margemPorPreco, linhasFormacao, rotuloNaoConsiderado } from "./produtoCatalogoModelo.js";

const CANAL = { balcao: "Balcão", ifood: "iFood", uber: "Uber", app: "App", outro: "Outro" };
const fmtN = (n) => Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 3 });
const moeda = (v) => (v == null ? '<span class="pill muted">indisponível</span>' : fmtMoeda(v));
const podeHomologar = () => pode("configuracoes.gerenciar");
const podeEditar = () => pode("produtos.editar");

/** Faixa do topo: homologação (quem/quando/por quê) e pendências com causa e ação. */
export function topoCatalogoHtml(p) {
  const item = itemDoProduto(p);
  const s = seloHomologacao(item, fmtDataHora);
  const motivo = item.homologacao === "pendente" && item.homologacao_motivo ? rotuloMotivo(item.homologacao_motivo) : "";
  const { bloqueantes, avisos } = pendenciasDoItem({ pendencias: p.catalogo?.pendencias ?? [] });
  return `<section class="pc-bloco" id="pc-topo">
    <div class="pc-linha"><b>Homologação</b> <span class="pill ${s.classe}">${s.texto}</span>
      <span class="muted">${escapeHtml(s.detalhe)}</span></div>
    ${motivo ? `<p class="ft-aviso">${escapeHtml(motivo)}</p>` : ""}
    <div class="ft-acoes">
      ${podeHomologar() && podeHomologarProduto(p) ? '<button id="pc-homologar" class="btn btn-primary btn-sm">Homologar esta ficha</button>' : ""}
      ${podeHomologar() && item.homologacao === "homologada" ? '<button id="pc-reabrir" class="btn btn-ghost btn-sm">Reabrir homologação</button>' : ""}
      ${!podeHomologar() && podeHomologarProduto(p) ? '<small class="muted">Somente um administrador pode homologar.</small>' : ""}
      <button id="pc-historico" class="btn btn-ghost btn-sm">Histórico de alterações</button>
    </div>
    ${bloqueantes.length || avisos.length ? `<details class="pc-pend" ${bloqueantes.length ? "open" : ""}><summary>Pendências (${bloqueantes.length + avisos.length}) — ${bloqueantes.length} a corrigir, ${avisos.length} para conferir</summary>
      <ul class="ft-pend">
        ${bloqueantes.map((x) => `<li class="bad"><b>${escapeHtml(x.texto)}</b>${x.detalhe ? `<small>${escapeHtml(x.detalhe)}</small>` : ""}<em>${escapeHtml(x.acao)}</em></li>`).join("")}
        ${avisos.map((x) => `<li class="warn">${escapeHtml(x.texto)}${x.detalhe ? `<small>${escapeHtml(x.detalhe)}</small>` : ""}<em>${escapeHtml(x.acao)}</em></li>`).join("")}
      </ul></details>` : ""}
  </section>`;
}

/** Formação do custo: do lote ao custo unitário, com a mão de obra SEPARADA do CMV; rendimento e PDV editáveis. */
export function formacaoCatalogoHtml(p) {
  const f = p.catalogo?.formacao_custo ?? {};
  const mod = p.catalogo?.mao_de_obra ?? {};
  const ehPrep = p.catalogo?.natureza === "preparacao";
  const un = f.unidade_rendimento ? ` ${escapeHtml(f.unidade_rendimento)}` : "";
  const linhas = linhasFormacao(p.catalogo);
  const sufixo = ehPrep ? `por ${f.unidade_rendimento ? escapeHtml(f.unidade_rendimento) : "unidade de rendimento"}` : "por porção";
  return `<section class="pc-bloco" id="pc-formacao">
    <div class="modal-sec-titulo">Formação do custo</div>
    <table class="grid grid-modal pc-form"><tbody>
      ${linhas.map((l) => `<tr><td>${l.rotulo} <small class="muted">(${l.itens} ${l.itens === 1 ? "item" : "itens"})</small></td><td class="num">${moeda(l.total)}</td></tr>`).join("")}
      <tr class="pc-sub"><td>Custo do lote inteiro (sem mão de obra)</td><td class="num">${moeda(f.lote?.total)}</td></tr>
      <tr><td>Rendimento da receita</td><td class="num"><b>${fmtN(f.rendimento ?? 1)}${un}</b></td></tr>
      <tr class="pc-total"><td>Custo unitário do produto (${sufixo}) — base do CMV</td><td class="num"><b>${f.custo_unitario_materiais == null ? '<span class="pill muted">indisponível</span>' : fmtMoeda(f.custo_unitario_materiais)}</b></td></tr>
    </tbody></table>
    <table class="grid grid-modal pc-form pc-mod"><tbody>
      <tr><td title="A mão de obra é acompanhada à parte e NUNCA entra no CMV.">Mão de obra (separada do CMV) — ${sufixo}</td><td class="num">${mod.custo_unitario == null ? (mod.linhas?.length || mod.herdado_lote ? '<span class="pill muted">sem custo por minuto</span>' : "—") : fmtMoeda(mod.custo_unitario)}</td></tr>
      ${(mod.linhas ?? []).map((l) => `<tr class="pc-modl"><td>${escapeHtml(l.funcao)} · ${fmtN(l.minutos)} min por receita</td><td class="num">${l.custo_minuto == null ? "—" : fmtMoeda(Number(l.minutos) * Number(l.custo_minuto))}</td></tr>`).join("")}
      ${mod.herdado_lote ? `<tr class="pc-modl"><td>Herdada das preparações usadas</td><td class="num">${fmtMoeda(mod.herdado_lote)}</td></tr>` : ""}
    </tbody></table>
    ${podeEditar() ? `<div class="ft-rend"><label>Corrigir rendimento <input id="pc-rend" type="number" min="0.001" step="any" value="${f.rendimento ?? 1}" /></label>
      ${ehPrep ? `<label>Unidade <select id="pc-rend-un">${["", "g", "ml", "un", "kg", "l"].map((u) => `<option value="${u}" ${u === (f.unidade_rendimento ?? "") ? "selected" : ""}>${u || "—"}</option>`).join("")}</select></label>` : ""}
      <button id="pc-rend-salvar" class="btn btn-ghost btn-sm">Salvar rendimento</button>
      <small class="muted">Muda o custo unitário e invalida a homologação.</small></div>` : ""}
    ${p.catalogo?.natureza === "produto_final" ? `<div class="ft-rend"><label>Código do PDV (código do item no iFood) <input id="pc-pdv" maxlength="60" value="${escapeHtml(p.codigo_pdv ?? "")}" placeholder="ex.: CAP-001" ${podeEditar() ? "" : "disabled"} /></label>
      ${podeEditar() ? '<button id="pc-pdv-salvar" class="btn btn-ghost btn-sm">Salvar código</button>' : ""}
      <small class="muted">${p.codigo_pdv ? "Vinculado ao iFood pelo código." : "Sem código: o vínculo só ocorre se o nome do item no iFood for idêntico e único."}</small></div>` : ""}
  </section>`;
}

/** Preço de venda, canal, CMV e margem de contribuição — nada é calculado sem custo ou sem as condições do canal. */
export function margensCatalogoHtml(p, condicoes) {
  const custoOk = p.catalogo?.formacao_custo?.custo_unitario_materiais != null && !["insumo_sem_custo", "sem_componentes", "insumo_inativo"].includes(p.status_ficha?.chave);
  const linhas = margemPorPreco({ precos: p.precos, custo: p.custo, custoDisponivel: custoOk, condicoes });
  const dica = (r) => ({
    ficha_incompleta: "Ficha incompleta: sem custo confiável.",
    canal_sem_condicoes: "As condições comerciais deste canal não foram configuradas (Configurações › Condições comerciais).",
    condicoes_incompletas: `Parcial: não considera ${r.naoConsiderados.map(rotuloNaoConsiderado).join(", ")}.`,
  })[r.motivo] ?? "";
  return `<section class="pc-bloco" id="pc-margens">
    <div class="modal-sec-titulo">Preço de venda · CMV · margem de contribuição</div>
    ${linhas.length ? `<div class="tabela-wrap"><table class="grid grid-modal"><thead><tr><th>Canal</th><th>Tabela</th><th class="num">Preço de venda</th><th class="num">CMV</th><th class="num">Lucro após deduções</th><th class="num">Margem de contribuição</th><th></th></tr></thead><tbody>
      ${linhas.map((r, i) => `<tr><td>${CANAL[r.canal] ?? escapeHtml(r.canal)}</td><td>${escapeHtml(r.tabela ?? "—")}</td><td class="num">${fmtMoeda(r.preco)}</td>
        <td class="num">${r.cmvPct == null ? "—" : fmtPct(r.cmvPct)}</td>
        <td class="num">${r.lucro == null ? "—" : fmtMoeda(r.lucro)}</td>
        <td class="num">${r.margemPct == null ? "—" : fmtPct(r.margemPct)}${r.parcial && r.margemPct != null ? ' <span class="pill warn">parcial</span>' : ""}</td>
        <td>${r.motivo ? `<small class="muted" title="${escapeHtml(dica(r))}">${escapeHtml(dica(r))}</small>` : ""}</td></tr>`).join("")}
    </tbody></table></div>` : '<p class="muted">Nenhum preço de venda cadastrado para este produto. O sistema não inventa preço: cadastre em Editar produto.</p>'}
    <p class="rodape">A margem de contribuição usa as condições comerciais cadastradas por esta empresa para cada canal (comissão, taxas, promoções, tributos, entrega). Sem elas, a margem não é calculada.</p>
    ${custoOk ? '<div class="ft-acoes"><button id="pc-simular" class="btn btn-primary btn-sm">Simular preço</button></div>' : ""}
  </section>`;
}

/** Liga os eventos das seções. `recarregar()` busca o produto de novo e redesenha o modal. */
export function ligarCatalogo(m, p, { condicoes, recarregar }) {
  const rodar = async (fn, ok) => {
    try { await fn(); toast(ok); await recarregar(); document.dispatchEvent(new CustomEvent("app:reload")); }
    catch (e) { toast(`Não foi possível concluir: ${e.message}`); }
  };
  m.querySelector("#pc-homologar")?.addEventListener("click", () => {
    if (!confirm(`Homologar "${p.nome}"?\n\nVocê confirma que conferiu ingredientes, quantidades e rendimento. A homologação deixa de valer se a receita ou o custo mudarem.`)) return;
    rodar(() => definirHomologacaoFicha(p.id, "homologar"), "Ficha homologada.");
  });
  m.querySelector("#pc-reabrir")?.addEventListener("click", () => {
    if (!confirm(`Reabrir a homologação de "${p.nome}"? O CMV desta ficha deixa de ser considerado homologado.`)) return;
    rodar(() => definirHomologacaoFicha(p.id, "reabrir"), "Homologação reaberta.");
  });
  m.querySelector("#pc-historico")?.addEventListener("click", () => abrirHistoricoModal(p.id, p.nome));
  m.querySelector("#pc-rend-salvar")?.addEventListener("click", () => {
    const rend = Number(m.querySelector("#pc-rend").value);
    if (!(rend > 0)) { toast("Informe um rendimento maior que zero."); return; }
    const un = m.querySelector("#pc-rend-un")?.value;
    if (itemDoProduto(p).homologacao === "homologada" && !confirm("Esta ficha está homologada. Alterar o rendimento muda o custo e a homologação será invalidada. Continuar?")) return;
    rodar(() => atualizarProduto(p.id, { rendimento: rend, ...(un !== undefined ? { unidade_rendimento: un || null } : {}) }), "Rendimento atualizado.");
  });
  m.querySelector("#pc-pdv-salvar")?.addEventListener("click", () => {
    const c = m.querySelector("#pc-pdv").value.trim();
    rodar(() => atualizarProduto(p.id, { codigo_pdv: c || null }), c ? "Código do PDV salvo." : "Vínculo removido.");
  });
  m.querySelector("#pc-simular")?.addEventListener("click", () => {
    const menor = (p.precos ?? []).map((x) => ({ canal: x.canal, preco: Number(x.preco) })).filter((x) => x.preco > 0).sort((a, b) => a.preco - b.preco)[0];
    abrirSimulador({ nome: p.nome, custo: p.custo, preco: menor?.preco ?? null, canal: menor?.canal ?? "balcao" }, condicoes);
  });
}
