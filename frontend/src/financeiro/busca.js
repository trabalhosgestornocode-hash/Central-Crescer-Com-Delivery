// Busca financeira: indicadores, funcionalidades e relatórios (catálogo local) + categorias, fornecedores, obrigações, pagamentos e movimentos
// (servidor, já filtrados pela empresa/unidade da sessão — a UI não escolhe empresa). Ao escolher, vai direto à tela com mês e texto aplicados.
import { fin } from "./api.js";
import { moeda, rotuloMes } from "./modelo.js";
import { esc } from "./detalheHtml.js";
import { EXPLICACOES } from "./explicacoes.js";
import { MENU_FINANCEIRO } from "../financeiroMenu.js";

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const CHAVE = "fin:foco";

/** Foco entregue à tela de destino (lido UMA vez): { busca, mes }. */
export function consumirFoco() {
  try { const v = sessionStorage.getItem(CHAVE); if (v) sessionStorage.removeItem(CHAVE); return v ? JSON.parse(v) : null; } catch { return null; }
}
function gravarFoco(f) { try { sessionStorage.setItem(CHAVE, JSON.stringify(f)); } catch { /* sem storage: abre a tela sem filtro */ } }

const ROTULO_GRUPO = { categorias: "Categorias", fornecedores: "Fornecedores", obrigacoes: "Contas a pagar", pagamentos: "Pagamentos", movimentos: "Movimentos do livro-caixa" };

/** Catálogo local (não são dados do cliente): indicadores, telas e relatórios. */
export function buscarCatalogo(termo) {
  const t = norm(termo);
  const indicadores = Object.entries(EXPLICACOES).filter(([, e]) => norm(`${e.nome} ${e.simples}`).includes(t)).slice(0, 6)
    .map(([id, e]) => ({ tipo: "indicador", id, titulo: e.nome, subtitulo: e.simples, rota: "fin-painel", ancora: id }));
  const telas = MENU_FINANCEIRO.filter((m) => norm(m.label).includes(t)).slice(0, 6).map((m) => ({ tipo: "tela", id: m.id, titulo: m.label, subtitulo: "Funcionalidade financeira", rota: m.id }));
  return { indicadores, telas };
}

export function montarBusca(alvo, { mesAtual }) {
  alvo.innerHTML = `<div class="fin-busca" role="search"><label class="fin-campo fin-campo--inline" for="fin-busca-q"><span>Buscar no financeiro</span>
    <input type="search" id="fin-busca-q" placeholder="indicador, categoria, fornecedor, conta…" maxlength="80" autocomplete="off" aria-controls="fin-busca-res" aria-expanded="false"></label>
    <div id="fin-busca-res" class="fin-busca-res" hidden role="region" aria-label="Resultados da busca" aria-live="polite"></div></div>`;
  const q = alvo.querySelector("input"), res = alvo.querySelector("#fin-busca-res");
  let timer = null, seq = 0;
  const fechar = () => { res.hidden = true; q.setAttribute("aria-expanded", "false"); };
  const ir = async (item) => {
    const mes = item.mes ?? mesAtual();
    if (item.tipo === "indicador") { fechar(); const btn = document.querySelector(`[data-fin-info="${CSS.escape(item.ancora)}"], [data-fin-valor="${CSS.escape(item.ancora)}"]`); if (btn) { btn.scrollIntoView({ block: "center" }); btn.focus(); setTimeout(() => btn.click?.(), 60); /* depois do clique original: o ouvinte global de fora-do-popover não o fecha */ } return; }
    if (item.busca || item.mes) { gravarFoco({ busca: item.busca ?? "", mes }); try { sessionStorage.setItem("fin:mes", mes); } catch { /* ok */ } }
    const { irPara } = await import("../router.js");
    fechar(); irPara(item.rota);
  };
  const pintar = (cat, srv, erro) => {
    const bloco = (titulo, itens, total) => itens.length ? `<section><h4>${esc(titulo)}${total > itens.length ? ` <small>(${itens.length} de ${total})</small>` : ""}</h4><ul>${itens.map((i, k) => `<li><button type="button" data-k="${esc(i.tipo)}:${esc(i.id)}"><span class="t">${esc(i.titulo)}</span><span class="s">${esc(i.subtitulo ?? "")}${i.mes ? ` · ${esc(rotuloMes(i.mes))}` : ""}${i.valorCentavos != null ? ` · ${moeda(i.valorCentavos)}` : ""}</span></button></li>`).join("")}</ul></section>` : "";
    const todos = [...cat.indicadores, ...cat.telas, ...Object.values(srv?.grupos ?? {}).flatMap((g) => g.itens)];
    const html = [bloco("Indicadores", cat.indicadores, cat.indicadores.length), bloco("Funcionalidades", cat.telas, cat.telas.length), ...Object.entries(srv?.grupos ?? {}).map(([k, g]) => bloco(ROTULO_GRUPO[k] ?? k, g.itens, g.total))].join("");
    res.innerHTML = (html || `<p class="fin-vazio-linha">Nada encontrado para “${esc(q.value)}”.</p>`) + (erro ? `<p class="fin-sub">${esc(erro)}</p>` : "");
    res.hidden = false; q.setAttribute("aria-expanded", "true");
    res.onclick = (e) => { const b = e.target.closest("button[data-k]"); if (!b) return; const item = todos.find((i) => `${i.tipo}:${i.id}` === b.dataset.k); if (item) ir(item); };
  };
  q.addEventListener("input", () => {
    clearTimeout(timer);
    const termo = q.value.trim();
    if (termo.length < 2) { fechar(); return; }
    timer = setTimeout(async () => {
      const minha = ++seq, cat = buscarCatalogo(termo);
      let srv = null, erro = "";
      try { srv = await fin.get("/busca", { q: termo }); } catch (e) { erro = "Não foi possível buscar nos lançamentos agora."; }
      if (minha === seq) pintar(cat, srv, erro);
    }, 250);
  });
  q.addEventListener("keydown", (e) => { if (e.key === "Escape") { fechar(); q.blur(); } if (e.key === "ArrowDown") res.querySelector("button")?.focus(); });
  res.addEventListener("keydown", (e) => { if (e.key === "Escape") { fechar(); q.focus(); } });
}
