// Relatórios — tabelas e exportações (CSV/XLSX) sobre o MESMO motor do dashboard. Sem segundo motor de indicadores; sem dados fictícios.
// Unidade: só a do contexto autorizado (o servidor recusa outra). Filtros: período, conta, categoria, tipo (e, conforme o relatório, situação,
// agrupamento e transferências). Valores parciais e o regime de caixa ficam sempre à vista.
import { fin } from "./api.js";
import { moeda, pct, dataBr, periodoDoMes } from "./modelo.js";
import { garantirCss, cabecalho, badge, carregarEm, lerMes, aviso, esc, estado } from "./ui.js";

const celula = (tipo, v) => {
  if (v === null || v === undefined || v === "") return tipo === "moeda" || tipo === "pct" ? "—" : "";
  switch (tipo) {
    case "moeda": return moeda(v);
    case "pct": return pct(v);
    case "data": return esc(dataBr(v));
    case "booleano": return v ? "Sim" : "Não";
    case "inteiro": return String(v);
    default: return esc(String(v));
  }
};

export async function render(container, ctx) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  const un = ctx?.sessao?.unidade;
  const nomeUnidade = (typeof un === "object" ? un?.nome : null) ?? "unidade do contexto atual";
  const p0 = periodoDoMes(lerMes());
  const est = { id: "movimentacoes", filtros: { de: p0.de, ate: p0.ate, contaId: "", categoriaId: "", tipo: "", status: "", agrupar: "dia", transferencias: false }, ultimo: null };
  let catalogo = [], contas = [], cats = [];

  raiz.innerHTML = `<div data-topo></div><div data-corpo class="fin-pg"></div>`;
  raiz.querySelector("[data-topo]").innerHTML = cabecalho({
    titulo: "Relatórios", sub: "Tabelas e exportações no regime de caixa, com os mesmos cálculos do dashboard. Cada arquivo traz período, filtros, situação dos dados, data de geração e código de verificação.",
    extra: `<span class="fin-badge fin-badge--info" title="Os relatórios cobrem apenas a unidade autorizada no contexto">Unidade: ${esc(nomeUnidade)}</span>`,
  });
  const corpo = raiz.querySelector("[data-corpo]");

  const consulta = () => {
    const f = est.filtros, def = catalogo.find((x) => x.id === est.id)?.filtros ?? [];
    const q = {};
    if (def.includes("periodo")) { q.de = f.de; q.ate = f.ate; }
    if (def.includes("conta")) q.contaId = f.contaId;
    if (def.includes("categoria")) q.categoriaId = f.categoriaId;
    if (def.includes("tipo")) q.tipo = f.tipo;
    if (def.includes("status")) q.status = f.status;
    if (def.includes("agrupar")) q.agrupar = f.agrupar;
    if (def.includes("transferencias") && f.transferencias) q.transferencias = "true";
    return q;
  };

  function pintarFiltros(def) {
    const f = est.filtros;
    const sel = (nome, rotulo, opcoes, valor) => `<label class="fin-campo"><span>${rotulo}</span><select name="${nome}">${opcoes.map((o) => `<option value="${esc(o.v)}"${o.v === valor ? " selected" : ""}>${esc(o.r)}</option>`).join("")}</select></label>`;
    return `<form class="fin-filtros" data-filtros>
      ${def.includes("periodo") ? `<label class="fin-campo"><span>De</span><input type="date" name="de" value="${esc(f.de)}"></label><label class="fin-campo"><span>Até</span><input type="date" name="ate" value="${esc(f.ate)}"></label>` : ""}
      ${def.includes("conta") ? sel("contaId", "Conta", [{ v: "", r: "Todas" }, ...contas.map((c) => ({ v: c.id, r: c.nome }))], f.contaId) : ""}
      ${def.includes("categoria") ? sel("categoriaId", "Categoria", [{ v: "", r: "Todas" }, ...cats.map((c) => ({ v: c.id, r: c.nome }))], f.categoriaId) : ""}
      ${def.includes("tipo") ? sel("tipo", "Tipo de movimentação", [{ v: "", r: "Entradas e saídas" }, { v: "entrada", r: "Entradas" }, { v: "saida", r: "Saídas" }], f.tipo) : ""}
      ${def.includes("status") ? sel("status", "Situação", [{ v: "", r: "Todas" }, { v: "realizado", r: "Realizados" }, { v: "previsto", r: "Previstos" }, { v: "cancelado", r: "Cancelados" }], f.status) : ""}
      ${def.includes("agrupar") ? sel("agrupar", "Agrupar por", [{ v: "dia", r: "Dia" }, { v: "mes", r: "Mês" }], f.agrupar) : ""}
      ${def.includes("transferencias") ? `<label class="fin-campo"><span>Transferências internas</span><select name="transferencias"><option value="">Excluir (padrão)</option><option value="true"${f.transferencias ? " selected" : ""}>Incluir</option></select></label>` : ""}
      <button class="btn btn-primary btn-sm" type="submit">Gerar relatório</button>
      <button class="btn btn-ghost btn-sm" type="button" data-exportar="csv">Exportar CSV</button>
      <button class="btn btn-ghost btn-sm" type="button" data-exportar="xlsx">Exportar XLSX</button>
    </form>`;
  }

  function pintarResultado(r) {
    const m = r.meta;
    const periodo = m.periodo?.de || m.periodo?.ate ? `${dataBr(m.periodo.de) || "início"} a ${dataBr(m.periodo.ate) || "hoje"}` : "Todo o período";
    const filtros = m.filtros.filter((x) => x.valor).map((x) => `${x.rotulo}: ${x.valor}`).join(" · ");
    const th = r.colunas.map((c) => `<th scope="col"${["moeda", "pct", "inteiro"].includes(c.tipo) ? ' class="fin-num"' : ""}>${esc(c.rotulo)}</th>`).join("");
    const tr = r.linhas.map((l) => `<tr>${r.colunas.map((c) => `<td${["moeda", "pct", "inteiro"].includes(c.tipo) ? ' class="fin-num"' : ""} data-rot="${esc(c.rotulo)}">${celula(c.tipo, l[c.id])}</td>`).join("")}</tr>`).join("");
    const tot = r.totais ? `<tfoot><tr class="fin-tot">${r.colunas.map((c, i) => `<td${["moeda", "pct", "inteiro"].includes(c.tipo) ? ' class="fin-num"' : ""}>${i === 0 ? "TOTAL" : celula(c.tipo, r.totais[c.id])}</td>`).join("")}</tr></tfoot>` : "";
    return `<div class="fin-card"><h3>${esc(r.titulo)}</h3>
      <p class="fin-regime">Regime de caixa · período ${esc(periodo)}${filtros ? ` · ${esc(filtros)}` : ""} · ${r.total} linha(s) · gerado em ${esc(new Date(m.geradoEm).toLocaleString("pt-BR"))}</p>
      <p>${m.parcial ? badge("Dados parciais", "warn") : badge("Dados completos para os filtros", "ok")}</p>
      ${m.avisos.map((a) => `<div class="fin-alerta fin-alerta--warn" role="status">${esc(a)}</div>`).join("")}
      ${r.linhas.length
        ? `<div class="fin-tabela-wrap"><table class="fin-tabela fin-tabela--cartao" data-relatorio="${esc(r.id)}"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody>${tot}</table></div>`
        : estado.vazio("Nada neste recorte", "Não há registros para o período e os filtros escolhidos. Nenhum valor é inventado.")}
      ${r.truncado ? `<p class="fin-sub">Mostrando as primeiras ${r.linhas.length} de ${r.total} linhas. A exportação traz o relatório completo.</p>` : ""}</div>`;
  }

  async function gerar() {
    const alvo = raiz.querySelector("[data-resultado]");
    await carregarEm(alvo, () => fin.get(`/relatorios/tabelas/${est.id}`, consulta()), (r) => { est.ultimo = r; alvo.innerHTML = pintarResultado(r); });
  }

  function lerForm(form) {
    const d = new FormData(form);
    const f = est.filtros;
    for (const k of ["de", "ate", "contaId", "categoriaId", "tipo", "status", "agrupar"]) if (d.has(k)) f[k] = String(d.get(k) ?? "");
    f.transferencias = d.get("transferencias") === "true";
  }

  function desenhar() {
    const def = catalogo.find((x) => x.id === est.id);
    corpo.innerHTML = `<nav class="fin-passos" aria-label="Relatórios">${catalogo.map((x) => `<li><button type="button" class="btn ${x.id === est.id ? "btn-primary" : "btn-ghost"} btn-sm" data-rel="${x.id}" aria-pressed="${x.id === est.id}">${esc(x.titulo)}</button></li>`).join("")}</nav>
      <p class="fin-sub">${esc(def.descricao)}</p>${pintarFiltros(def.filtros)}<div data-resultado></div>`;
    corpo.querySelectorAll("[data-rel]").forEach((b) => b.addEventListener("click", () => { est.id = b.dataset.rel; desenhar(); gerar(); }));
    const form = corpo.querySelector("[data-filtros]");
    form.addEventListener("submit", (e) => { e.preventDefault(); lerForm(form); gerar(); });
    form.querySelectorAll("[data-exportar]").forEach((b) => b.addEventListener("click", async () => {
      lerForm(form);
      const original = b.textContent; b.disabled = true; b.textContent = "Gerando…";
      try {
        const { blob, nome } = await fin.baixar(`/relatorios/tabelas/${est.id}/exportar`, { ...consulta(), formato: b.dataset.exportar });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), { href: url, download: nome });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        aviso(`Arquivo ${nome} gerado.`);
      } catch (e) { aviso(e.message, "bad"); } finally { b.disabled = false; b.textContent = original; }
    }));
  }

  await carregarEm(corpo, async () => {
    [catalogo, contas, cats] = await Promise.all([fin.get("/relatorios/tabelas/catalogo"), fin.get("/contas"), fin.get("/plano-contas")]);
    return null;
  }, () => { desenhar(); gerar(); });
}
