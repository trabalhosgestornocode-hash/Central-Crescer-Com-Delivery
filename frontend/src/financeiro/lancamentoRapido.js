// LANÇAMENTO RÁPIDO: "O que aconteceu?" → três botões grandes → três informações (o quê, quanto, quando). Categoria, conta e competência vêm
// SUGERIDAS (visíveis e trocáveis); um resumo em frase simples mostra exatamente o que será registrado e onde vai aparecer.
// Usa os endpoints que já existem (lançamentos, transferências, contas a pagar), com as mesmas regras, permissões e trilha.
import { fin } from "./api.js";
import { esc, aviso } from "./ui.js";
import { moeda } from "./modelo.js";
import { icon } from "../icons.js";
import * as M from "./lancamentoRapidoModelo.js";

const hojeMenos = (dias) => { const d = new Date(); d.setDate(d.getDate() - dias); return M.hojeIso(d); };

/**
 * @param {{ permissoes: string[], aposSalvar: () => void, aoEscolherOutros?: () => void }} o
 */
export function abrirLancamentoRapido({ permissoes = [], aposSalvar, aoEscolherOutros }) {
  const pode = permissoes.includes("gestao_financeira.lancar");
  const dlg = document.createElement("dialog");
  dlg.className = "fin-dialogo fin-lr";
  dlg.setAttribute("aria-labelledby", "fin-lr-t");
  document.body.appendChild(dlg);
  const fechar = () => { try { dlg.close(); } catch { /* já fechado */ } dlg.remove(); };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); fechar(); });
  const dados = { carregado: false, contas: [], categorias: [], historico: [] };

  // ---------------------------------------------------------------- passo 1: o que aconteceu?
  function passo1() {
    dlg.innerHTML = `<div class="fin-form fin-lr-corpo"><header class="fin-lr-cab"><h3 id="fin-lr-t">O que aconteceu?</h3><p class="fin-lr-sub">Escolha uma opção. Leva menos de um minuto.</p></header>
      <ul class="fin-lr-acoes">${Object.values(M.ACOES).map((a) => `<li><button type="button" class="fin-lr-acao" data-acao="${a.id}"${pode ? "" : ' disabled title="Seu perfil não registra lançamentos"'}>
        <span class="fin-lr-ic fin-lr-ic--${a.tom}" aria-hidden="true">${icon(a.icone, { size: 22 })}</span><span class="fin-lr-tx"><strong>${esc(a.titulo)}</strong><small>${esc(a.desc)}</small></span><span class="fin-lr-seta" aria-hidden="true">${icon("chevron-right", { size: 18 })}</span></button></li>`).join("")}</ul>
      ${pode ? "" : '<p class="fin-lr-aviso" role="note">Seu perfil não registra lançamentos.</p>'}
      <div class="fin-form-acoes fin-lr-rodape"><button type="button" class="btn btn-ghost btn-sm" data-outros>Outros tipos de registro…</button><button type="button" class="btn btn-ghost btn-sm" data-fechar>Cancelar</button></div></div>`;
    dlg.querySelector("[data-acao]:not([disabled])")?.focus();
  }

  async function carregarDados() {
    if (dados.carregado) return;
    const de = hojeMenos(120), ate = M.hojeIso();
    const [contas, categorias, lanc] = await Promise.all([fin.get("/contas"), fin.get("/plano-contas"), fin.get("/lancamentos", { de, ate, limite: 500 }).catch(() => ({ itens: [] }))]);
    // Pernas de transferência não dizem qual é a conta "de costume" nem a categoria de um gasto: ficam fora do histórico usado nas sugestões.
    const transf = new Set(categorias.filter((c) => c.papel === "transferencia").map((c) => c.id));
    Object.assign(dados, { contas: contas.filter((c) => c.ativo), categorias, historico: (lanc?.itens ?? []).filter((l) => !transf.has(l.categoria_id)), carregado: true });
  }

  // ---------------------------------------------------------------- passo 2: o formulário
  let st = null;
  async function abrirForm(acao) {
    dlg.innerHTML = `<div class="fin-form fin-lr-corpo"><p class="fin-sub" role="status">Carregando…</p></div>`;
    try { await carregarDados(); } catch (e) { dlg.innerHTML = `<div class="fin-form fin-lr-corpo"><h3 id="fin-lr-t">Não foi possível começar</h3><p class="fin-form-erro" role="alert">${esc(e?.message ?? "Tente novamente.")}</p><div class="fin-form-acoes"><button type="button" class="btn btn-ghost btn-sm" data-voltar>Voltar</button></div></div>`; return; }
    st = { acao, quando: "agora", descricao: "", valor: "", data: M.hojeIso(), contaId: M.sugerirConta(dados.historico, dados.contas, acao) ?? "", categoriaId: "", categoriaManual: false, fornecedor: "", contaDestinoId: "", competencia: "", competenciaManual: false };
    pintarForm();
  }

  const cats = () => M.categoriasPara(st.acao, dados.categorias, { aPagar: st.quando === "depois" });
  const opcoes = (lista, atual, vazio) => `${vazio !== null ? `<option value="">${esc(vazio)}</option>` : ""}${lista.map((o) => `<option value="${esc(o.id)}"${o.id === atual ? " selected" : ""}>${esc(o.nome)}</option>`).join("")}`;
  const agrupadas = (lista, atual) => {
    const porPapel = new Map(); for (const c of lista) { const k = c.papel ?? "outro"; (porPapel.get(k) ?? porPapel.set(k, []).get(k)).push(c); }
    return [...porPapel.values()].map((cs) => cs.map((c) => `<option value="${esc(c.id)}"${c.id === atual ? " selected" : ""}>${esc(c.nome)}</option>`).join("")).join("");
  };

  function pintarForm() {
    const a = M.ACOES[st.acao], transf = st.acao === "transferi", saiu = st.acao === "saiu", depois = saiu && st.quando === "depois";
    const rotuloData = depois ? "Vence em" : "Quando";
    const sem = !dados.contas.length;
    const contaVisivel = !st.contaId || transf;   // a conta sugerida fica recolhida; sem sugestão (ou transferência) a pessoa escolhe aqui
    dlg.innerHTML = `<form class="fin-form fin-lr-corpo" novalidate>
      <header class="fin-lr-cab fin-lr-cab--form"><button type="button" class="fin-lr-volta" data-voltar aria-label="Voltar para as opções">${icon("chevron-left", { size: 18 })}</button>
        <span class="fin-lr-ic fin-lr-ic--${a.tom} fin-lr-ic--p" aria-hidden="true">${icon(a.icone, { size: 18 })}</span><h3 id="fin-lr-t">${esc(a.titulo)}</h3></header>
      ${sem ? '<p class="fin-form-erro" role="alert">Nenhuma conta financeira cadastrada. Cadastre uma em Contas Financeiras antes de lançar.</p>' : ""}
      ${saiu ? `<div class="fin-lr-seg" role="radiogroup" aria-label="Situação do pagamento"><label><input type="radio" name="quando" value="agora"${depois ? "" : " checked"}><span>${icon("check-circle", { size: 16 })} Já paguei</span></label><label><input type="radio" name="quando" value="depois"${depois ? " checked" : ""}><span>${icon("clock", { size: 16 })} Vou pagar depois</span></label></div>` : ""}
      <label class="fin-campo"><span>${transf ? "Observação (opcional)" : st.acao === "entrou" ? "O que entrou? *" : "O que foi? *"}</span><input name="descricao" value="${esc(st.descricao)}" maxlength="300" autocomplete="off" ${transf ? "" : 'placeholder="ex.: Polpa de açaí, Aluguel, Venda do dia"'} data-erro="descricao"><small class="fin-lr-erro" data-msg="descricao" role="alert"></small></label>
      ${depois ? `<label class="fin-campo"><span>Para quem? *</span><input name="fornecedor" value="${esc(st.fornecedor)}" maxlength="120" autocomplete="off" placeholder="nome do fornecedor" data-erro="fornecedor"><small class="fin-lr-erro" data-msg="fornecedor" role="alert"></small></label>` : ""}
      <label class="fin-campo"><span>Quanto? (R$) *</span><input name="valor" value="${esc(st.valor)}" inputmode="decimal" autocomplete="off" placeholder="0,00" data-erro="valor"><small class="fin-lr-erro" data-msg="valor" role="alert"></small></label>
      <div class="fin-campo"><span id="fin-lr-qd">${rotuloData} *</span>
        <div class="fin-lr-datas" role="group" aria-labelledby="fin-lr-qd">
          ${depois ? "" : `<button type="button" class="btn btn-ghost btn-sm" data-dia="0" aria-pressed="${st.data === hojeMenos(0)}">Hoje</button><button type="button" class="btn btn-ghost btn-sm" data-dia="1" aria-pressed="${st.data === hojeMenos(1)}">Ontem</button>`}
          <input type="date" name="data" value="${esc(st.data)}" aria-label="${rotuloData} (data)" data-erro="data"></div><small class="fin-lr-erro" data-msg="data" role="alert"></small></div>
      ${transf ? `<label class="fin-campo"><span>De qual conta saiu? *</span><select name="contaId" data-erro="contaId">${opcoes(dados.contas, st.contaId, "Escolha…")}</select><small class="fin-lr-erro" data-msg="contaId" role="alert"></small></label>
        <label class="fin-campo"><span>Para qual conta foi? *</span><select name="contaDestinoId" data-erro="contaDestinoId">${opcoes(dados.contas.filter((c) => c.id !== st.contaId), st.contaDestinoId, "Escolha…")}</select><small class="fin-lr-erro" data-msg="contaDestinoId" role="alert"></small></label>`
        : `<label class="fin-campo"><span>Categoria${depois ? " *" : ""}</span><select name="categoriaId" data-erro="categoriaId">${depois ? '<option value="">Escolha…</option>' : '<option value="">Não sei — classificar depois</option>'}${agrupadas(cats(), st.categoriaId)}</select>
          <small class="fin-lr-sug" data-sug role="status"></small><small class="fin-lr-erro" data-msg="categoriaId" role="alert"></small></label>
        ${contaVisivel ? `<label class="fin-campo"><span>${depois ? "Conta de pagamento (opcional agora)" : "Conta *"}</span><select name="contaId" data-erro="contaId">${opcoes(dados.contas, st.contaId, "Escolha…")}</select><small class="fin-lr-erro" data-msg="contaId" role="alert"></small></label>` : ""}`}
      ${!transf ? `<details class="fin-lr-mais"${st.competenciaManual ? " open" : ""}><summary>Mais detalhes</summary>
        ${!contaVisivel ? `<label class="fin-campo"><span>Conta</span><select name="contaId">${opcoes(dados.contas, st.contaId, null)}</select></label>` : ""}
        ${depois ? `<label class="fin-campo"><span>Mês a que a conta pertence</span><input type="month" name="competencia" value="${esc(st.competencia || String(st.data).slice(0, 7))}"><small>Por padrão é o mês do vencimento. Troque se a compra foi de outro mês.</small></label>` : ""}</details>` : ""}
      <p class="fin-lr-resumo" data-resumo role="status" aria-live="polite"></p>
      <p class="fin-form-erro" role="alert" hidden data-erro-geral></p>
      <div class="fin-form-acoes fin-lr-rodape"><button type="submit" class="btn btn-ghost btn-sm" data-salvar="outro"${sem ? " disabled" : ""}>Registrar e lançar outro</button>
        <button type="submit" class="btn btn-primary" data-salvar="fechar"${sem ? " disabled" : ""}>Registrar</button></div></form>`;
    atualizarSugestao(); atualizarResumo();
    (st.descricao ? dlg.querySelector("[name=valor]") : dlg.querySelector("[name=descricao]"))?.focus();
  }

  const ler = () => {
    const f = dlg.querySelector("form"); if (!f) return;
    const v = (n) => f.elements[n]?.value;
    if (f.elements.quando) st.quando = [...f.querySelectorAll("[name=quando]")].find((r) => r.checked)?.value ?? st.quando;
    for (const n of ["descricao", "valor", "data", "contaId", "fornecedor", "contaDestinoId"]) if (f.elements[n]) st[n] = v(n);
    if (f.elements.categoriaId) { const novo = v("categoriaId"); if (novo !== st.categoriaId) st.categoriaManual = true; st.categoriaId = novo; }
    if (f.elements.competencia) { const novo = v("competencia"); if (novo !== (st.competencia || String(st.data).slice(0, 7))) st.competenciaManual = true; st.competencia = novo; }
  };
  function atualizarSugestao() {
    if (st.acao === "transferi") return;
    const alvo = dlg.querySelector("[data-sug]"), sel = dlg.querySelector("[name=categoriaId]");
    if (!alvo || !sel) return;
    const s = st.categoriaManual ? null : M.sugerirCategoria(st.descricao, dados.historico, cats(), st.acao);
    if (s) { st.categoriaId = s.categoriaId; sel.value = s.categoriaId; alvo.innerHTML = `${icon("zap", { size: 13 })}<span>Sugerida: ${esc(s.motivo)} Troque se não for essa.</span>`; }
    else if (!st.categoriaManual) { st.categoriaId = ""; sel.value = ""; alvo.textContent = ""; }
    else alvo.textContent = "";
  }
  function atualizarResumo() {
    const r = dlg.querySelector("[data-resumo]"); if (!r) return;
    const p = M.montarPedido({ ...st, competencia: st.competenciaManual ? st.competencia : "" }, { contas: dados.contas, categorias: dados.categorias });
    const mostrar = M.valorEmCentavos(st.valor) != null;
    r.classList.toggle("fin-lr-resumo--pronto", mostrar && !p.erros);
    r.innerHTML = !mostrar ? "" : p.erros ? `<span class="fin-lr-faltam">Falta preencher para registrar.</span>` : `<span class="fin-lr-resumo-ic" aria-hidden="true">${icon("check-circle", { size: 18 })}</span><span><strong>Vai registrar:</strong> ${esc(p.resumo)}<br><small>Aparece em: ${esc(p.ondeAparece.replace(/\.$/, ""))}.</small></span>`;
  }
  const marcarErros = (erros) => {
    dlg.querySelectorAll("[data-msg]").forEach((n) => { n.textContent = erros?.[n.dataset.msg] ?? ""; });
    dlg.querySelectorAll("[data-erro]").forEach((n) => n.setAttribute("aria-invalid", erros?.[n.dataset.erro] ? "true" : "false"));
    if (erros) dlg.querySelector(`[data-erro="${Object.keys(erros)[0]}"]`)?.focus();
  };

  // ---------------------------------------------------------------- eventos
  dlg.addEventListener("click", (e) => {
    if (e.target.closest("[data-fechar]")) { fechar(); return; }
    if (e.target.closest("[data-outros]")) { fechar(); aoEscolherOutros?.(); return; }
    if (e.target.closest("[data-voltar]")) { passo1(); return; }
    const ac = e.target.closest("[data-acao]"); if (ac) { abrirForm(ac.dataset.acao); return; }
    const dia = e.target.closest("[data-dia]");
    if (dia) { ler(); st.data = hojeMenos(Number(dia.dataset.dia)); pintarForm(); }
  });
  const limparErro = (alvo) => { const n = alvo?.dataset?.erro; if (!n) return; const m = dlg.querySelector(`[data-msg="${n}"]`); if (m) m.textContent = ""; alvo.setAttribute("aria-invalid", "false"); };
  dlg.addEventListener("input", (e) => {
    if (!st || !e.target.closest("form") || e.target.name === "quando") return;   // "Já paguei/Vou pagar depois" é tratado no evento change (redesenha o formulário)
    limparErro(e.target);
    ler();
    if (e.target.name === "descricao") atualizarSugestao();
    atualizarResumo();
  });
  dlg.addEventListener("change", (e) => {
    if (!st || !e.target.closest("form")) return;
    limparErro(e.target);
    const antes = st.quando; ler();
    if (e.target.name === "quando" && antes !== st.quando) { st.categoriaManual = false; st.data = st.quando === "depois" ? hojeMenos(0) : st.data; pintarForm(); return; }
    if (e.target.name === "contaId" && st.acao === "transferi") { pintarForm(); return; }
    atualizarSugestao(); atualizarResumo();
  });
  dlg.addEventListener("submit", async (e) => {
    e.preventDefault();
    ler();
    const botao = e.submitter ?? dlg.querySelector("[data-salvar=fechar]"), outro = botao?.dataset.salvar === "outro";
    const p = M.montarPedido({ ...st, competencia: st.competenciaManual ? st.competencia : "" }, { contas: dados.contas, categorias: dados.categorias });
    const geral = dlg.querySelector("[data-erro-geral]"); geral.hidden = true;
    if (p.erros) { marcarErros(p.erros); return; }
    marcarErros(null);
    dlg.querySelectorAll("button[type=submit]").forEach((b) => { b.disabled = true; });
    try {
      await fin.post(p.rota, p.corpo);
      aviso(`Registrado: ${moeda(M.valorEmCentavos(st.valor))}. ${p.ondeAparece.replace(/\.$/, "")}.`);
      if (outro) {   // mantém conta, categoria e data para a próxima; limpa só o que muda a cada lançamento
        const { acao, quando, data, contaId, contaDestinoId } = st;
        st = { acao, quando, descricao: "", valor: "", data, contaId, categoriaId: "", categoriaManual: false, fornecedor: "", contaDestinoId, competencia: "", competenciaManual: false };
        pintarForm(); aposSalvar?.(); return;
      }
      fechar(); aposSalvar?.();
    } catch (err) {
      dlg.querySelectorAll("button[type=submit]").forEach((b) => { b.disabled = false; });
      geral.textContent = err?.message || "Não foi possível registrar. Tente novamente."; geral.hidden = false;
    }
  });

  passo1();
  dlg.showModal();
  return { fechar };
}
