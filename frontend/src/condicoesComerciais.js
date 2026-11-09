// Configurações › Condições comerciais: comissão, taxas, promoções, tributos, entrega e outras deduções POR CANAL
// da empresa do contexto. Nada é herdado de outra organização; canal sem configuração aparece como tal (e deixa
// o Simulador e o Dashboard em modo parcial). Gravar exige administrador (configuracoes.gerenciar).
import { escapeHtml, toast, fmtDataHora } from "./utils.js";
import { obterCondicoesComerciais, salvarCondicaoComercial, obterHistoricoCondicoes } from "./api.js";
import { pode } from "./sessao.js";
import {
  CANAIS_CONDICOES, RESPONSAVEIS, rotuloCanal, condicaoParaForm, formParaPayload, situacaoCondicao, resumoCondicao,
} from "./condicoesComerciaisModelo.js";

const campoPct = (nome, rotulo, valor, dica, erro) => `
  <label class="cc-campo ${erro ? "cc-erro" : ""}">${rotulo}
    <span class="cc-input"><input name="${nome}" inputmode="decimal" value="${escapeHtml(valor)}" placeholder="não configurado" /><i>%</i></span>
    <small>${dica}</small>${erro ? `<small class="cc-msg">${escapeHtml(erro)}</small>` : ""}</label>`;

function formHtml(canal, f, erros = {}) {
  const loja = f.entrega_responsavel === "loja";
  return `<form class="cc-form" data-canal="${canal}" novalidate>
    <div class="cc-grade">
      ${campoPct("comissao", "Comissão do canal", f.comissao, "Obrigatória. Use 0 se o canal não cobra comissão.", erros.comissao)}
      ${campoPct("taxas", "Taxas adicionais", f.taxas, "Taxas de pagamento ou de serviço. Use 0 se não houver.", erros.taxas)}
      ${campoPct("promocao", "Promoções custeadas pela loja", f.promocao, "Parte de cupons/promoções paga pela loja, em % do preço. Use 0 se não houver.", erros.promocao)}
      ${campoPct("tributos", "Tributos", f.tributos, "Ex.: Simples Nacional, em % do preço. Opcional.", erros.tributos)}
    </div>
    <div class="cc-grade">
      <label class="cc-campo">Responsabilidade pela entrega
        <select name="entrega_responsavel">${RESPONSAVEIS.map((r) => `<option value="${r.id}" ${r.id === f.entrega_responsavel ? "selected" : ""}>${r.rotulo}</option>`).join("")}</select>
        <small>Quem arca com o custo do entregador neste canal.</small></label>
      <label class="cc-campo ${erros.entrega_custo ? "cc-erro" : ""}" ${loja ? "" : "hidden"} data-entrega-custo>Custo de entrega por pedido (R$)
        <span class="cc-input"><input name="entrega_custo" inputmode="decimal" value="${escapeHtml(f.entrega_custo)}" placeholder="ex.: 6,50" /></span>
        <small>Só quando a loja é a responsável.</small>${erros.entrega_custo ? `<small class="cc-msg">${escapeHtml(erros.entrega_custo)}</small>` : ""}</label>
    </div>
    <fieldset class="cc-outras"><legend>Outras deduções (opcional)</legend>
      <div data-outras>${f.outras.map((o, i) => `<div class="cc-outra"><input name="outra_nome_${i}" value="${escapeHtml(o.nome)}" placeholder="Nome (ex.: Embalagem delivery)" maxlength="60" />
        <span class="cc-input"><input name="outra_pct_${i}" inputmode="decimal" value="${escapeHtml(o.pct)}" placeholder="0" /><i>%</i></span>
        <button type="button" class="btn btn-ghost btn-sm" data-rem-outra="${i}" aria-label="Remover dedução">×</button>
        ${erros[`outras_${i}`] ? `<small class="cc-msg">${escapeHtml(erros[`outras_${i}`])}</small>` : ""}</div>`).join("")}</div>
      <button type="button" class="btn btn-ghost btn-sm" data-add-outra ${f.outras.length >= 10 ? "disabled" : ""}>+ Adicionar dedução</button></fieldset>
    <label class="cc-campo">Observação <input name="observacao" value="${escapeHtml(f.observacao)}" maxlength="300" placeholder="ex.: tabela vigente em nov/2026" /></label>
    <div class="cc-acoes"><button type="submit" class="btn btn-primary btn-sm">Salvar condições do ${escapeHtml(rotuloCanal(canal))}</button>
      <button type="button" class="btn btn-ghost btn-sm" data-cancelar>Cancelar</button></div>
  </form>`;
}

function lerForm(form) {
  const v = (n) => form.elements[n]?.value ?? "";
  const outras = [];
  for (let i = 0; form.elements[`outra_nome_${i}`]; i++) outras.push({ nome: v(`outra_nome_${i}`), pct: v(`outra_pct_${i}`) });
  return { comissao: v("comissao"), taxas: v("taxas"), promocao: v("promocao"), tributos: v("tributos"), entrega_responsavel: v("entrega_responsavel"), entrega_custo: v("entrega_custo"), outras, observacao: v("observacao") };
}

export async function montarCondicoesComerciais(root) {
  const editar = pode("configuracoes.gerenciar");
  let dados = null; let editando = null; let formAtual = null; let erros = {};

  const desenhar = () => {
    const por = new Map((dados?.canais ?? []).map((c) => [c.canal, c]));
    const ausentes = CANAIS_CONDICOES.filter((c) => !por.has(c.id)).map((c) => c.rotulo);
    root.innerHTML = `<div class="cfg-panel">
      <div class="cfg-panel-head"><h3>Condições comerciais</h3></div>
      <p class="cfg-tabela-explicacao">Informe como cada canal cobra <b>esta empresa</b>. O Simulador de Preço e o Dashboard iFood usam estes valores para calcular a margem.
        <b>Nenhum percentual é copiado de outra empresa</b>: canal sem configuração faz o cálculo ser exibido como <b>parcial</b>.</p>
      ${ausentes.length ? `<div class="cc-aviso" role="status"><b>Ainda sem condições:</b> ${ausentes.join(", ")}. ${editar ? "Clique em Configurar para preencher." : "Peça a um administrador para configurar."}</div>` : ""}
      ${!editar ? '<p class="muted">Somente administradores podem alterar estas condições.</p>' : ""}
      <div class="cc-lista">${CANAIS_CONDICOES.map((c) => {
        const cond = por.get(c.id) ?? null; const sit = situacaoCondicao(cond);
        return `<section class="cc-canal" data-canal="${c.id}">
          <header><div><b>${c.rotulo}</b><small>${c.dica}</small></div><span class="pill ${sit.classe}" title="${escapeHtml(sit.ajuda)}">${sit.texto}</span></header>
          ${editando === c.id ? formHtml(c.id, formAtual ?? condicaoParaForm(cond), erros)
            : `<p class="cc-resumo">${escapeHtml(resumoCondicao(cond))}</p>${sit.ajuda ? `<p class="cc-ajuda">${escapeHtml(sit.ajuda)}</p>` : ""}
               ${editar ? `<button type="button" class="btn btn-ghost btn-sm" data-editar="${c.id}">${cond ? "Editar" : "Configurar"}</button>` : ""}`}
        </section>`; }).join("")}</div>
      <div id="cc-hist"></div></div>`;
    ligar();
  };

  const ligar = () => {
    root.querySelectorAll("[data-editar]").forEach((b) => b.addEventListener("click", () => {
      editando = b.dataset.editar; formAtual = null; erros = {}; desenhar();
      root.querySelector(`[data-canal="${editando}"] input[name="comissao"]`)?.focus();
    }));
    const form = root.querySelector(".cc-form");
    if (!form) return;
    form.querySelector("[name=entrega_responsavel]").addEventListener("change", (e) => {
      form.querySelector("[data-entrega-custo]").hidden = e.target.value !== "loja";
    });
    form.querySelector("[data-cancelar]").addEventListener("click", () => { editando = null; formAtual = null; erros = {}; desenhar(); });
    form.querySelector("[data-add-outra]").addEventListener("click", () => { formAtual = lerForm(form); formAtual.outras.push({ nome: "", pct: "" }); desenhar(); });
    form.querySelectorAll("[data-rem-outra]").forEach((b) => b.addEventListener("click", () => { formAtual = lerForm(form); formAtual.outras.splice(Number(b.dataset.remOutra), 1); desenhar(); }));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      formAtual = lerForm(form);
      const r = formParaPayload(form.dataset.canal, formAtual);
      if (r.erros) { erros = r.erros; desenhar(); return; }
      const btn = form.querySelector("[type=submit]"); btn.disabled = true;
      try {
        dados = (await salvarCondicaoComercial(r.payload)).data;
        toast("Condições comerciais salvas.");
        editando = null; formAtual = null; erros = {}; desenhar(); carregarHistorico();
      } catch (e) { btn.disabled = false; toast(`Não foi possível salvar: ${e.message}`); }
    });
  };

  const carregarHistorico = async () => {
    const alvo = root.querySelector("#cc-hist"); if (!alvo) return;
    try {
      const h = (await obterHistoricoCondicoes()).data ?? [];
      alvo.innerHTML = h.length ? `<details class="cc-hist"><summary>Histórico de alterações (${h.length})</summary><ul>${h.slice(0, 15).map((x) =>
        `<li><b>${escapeHtml(rotuloCanal(x.canal))}</b> · ${fmtDataHora(x.created_at)}${x.usuario_nome ? ` · ${escapeHtml(x.usuario_nome)}` : ""}<br><small>${escapeHtml(x.antes ? resumoCondicao(x.antes) : "novo")} → ${escapeHtml(resumoCondicao(x.depois))}</small></li>`).join("")}</ul></details>` : "";
    } catch { /* histórico é complementar */ }
  };

  root.innerHTML = '<div class="estado-mini">Carregando condições comerciais…</div>';
  try { dados = (await obterCondicoesComerciais()).data; desenhar(); carregarHistorico(); }
  catch (e) { root.innerHTML = `<div class="estado-mini erro">Não foi possível carregar as condições comerciais: ${escapeHtml(e.message)}</div>`; }
}
