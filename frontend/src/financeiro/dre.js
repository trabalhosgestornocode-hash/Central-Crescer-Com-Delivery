// DRE Gerencial — regime de CAIXA. Linhas de detalhe não são somadas de novo; margem líquida é percentual (não moeda).
import { fin } from "./api.js";
import { moeda, pct, periodoDoMes, rotuloMes, mesAnterior } from "./modelo.js";
import { garantirCss, cabecalho, seletorMes, badge, carregarEm, lerMes, gravarMes, esc, estado } from "./ui.js";

export async function render(container) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  let mes = lerMes();
  let comparar = true;
  raiz.innerHTML = `<div data-topo></div><div data-corpo class="fin-pg"></div>`;
  const topo = raiz.querySelector("[data-topo]"), corpo = raiz.querySelector("[data-corpo]");
  topo.innerHTML = cabecalho({
    titulo: "DRE Gerencial", sub: "Regime de caixa: receita = recebimentos líquidos; custos = compras e fretes pagos. Não é DRE contábil de competência.",
    extra: `${seletorMes(mes)}<label class="fin-campo"><span>Comparar</span><select id="fin-comp"><option value="1">Com o mês anterior</option><option value="0">Sem comparação</option></select></label>`,
  });
  topo.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); carregar(); } });
  topo.querySelector("#fin-comp").addEventListener("change", (e) => { comparar = e.target.value === "1"; carregar(); });

  function carregar() {
    const p = periodoDoMes(mes);
    const pa = periodoDoMes(mesAnterior(mes));
    carregarEm(corpo, () => fin.get("/relatorios/dre", comparar ? { ...p, compararDe: pa.de, compararAte: pa.ate } : p), (d) => pintar(d, comparar));
  }

  function pintar(d, comp) {
    if (d.vazio) { corpo.innerHTML = estado.vazio(`Sem lançamentos em ${rotuloMes(mes)}`, "A DRE só é apresentada com dados reais registrados."); return; }
    const cmp = new Map((d.comparacao?.linhas ?? []).map((l) => [l.id, l]));
    const rec = d.linhas.find((l) => l.id === "receita").centavos;
    const linhas = d.linhas.map((l) => {
      const c = cmp.get(l.id);
      if (l.tipo === "percentual") {
        return `<tr class="fin-tot"><th scope="row">${esc(l.rotulo)}</th><td class="fin-num">${pct(l.bps)}</td><td class="fin-num">—</td>${comp ? `<td class="fin-num">${pct(c?.anteriorBps)}</td><td class="fin-num">${c?.deltaPontosBps != null ? `${c.deltaPontosBps > 0 ? "+" : ""}${pct(c.deltaPontosBps).replace("%", " p.p.")}` : "—"}</td>` : ""}<td><small>${esc(l.formula)}</small></td></tr>`;
      }
      const principal = `<tr class="${l.destaque ? "fin-tot" : ""}"><th scope="row">${esc(l.rotulo)}</th><td class="fin-num">${moeda(l.centavos)}</td><td class="fin-num">${pct(l.percentualReceitaBps)}</td>${comp ? `<td class="fin-num">${moeda(c?.anterior)}</td><td class="fin-num">${c?.delta != null ? moeda(c.delta, { sinal: true }) : "—"}${c?.deltaBps != null ? `<br><small>${c.deltaBps > 0 ? "+" : ""}${pct(c.deltaBps)}</small>` : ""}</td>` : ""}<td><small>${esc(l.formula)}</small></td></tr>`;
      const det = (l.detalhes ?? []).map((x) => `<tr class="fin-det"><th scope="row">${esc(x.nome)}</th><td class="fin-num">${moeda(x.centavos)}</td><td class="fin-num">${rec > 0 ? pct(Math.round((x.centavos * 10000) / rec)) : "—"}</td>${comp ? "<td></td><td></td>" : ""}<td><small>detalhe — já incluído na linha acima</small></td></tr>`).join("");
      return principal + det;
    }).join("");
    corpo.innerHTML = `
      <div class="fin-regime">${esc(d.regime.rotulo)} · ${esc(rotuloMes(mes))}${comp && d.comparacao ? ` vs ${esc(rotuloMes(mesAnterior(mes)))}` : ""} ${d.resumo.parcial ? badge("Parcial: há lançamentos sem classificação", "warn") : badge("Todos os lançamentos classificados", "ok")}</div>
      ${d.avisos.map((a) => `<div class="fin-alerta fin-alerta--warn" role="status">${esc(a)}</div>`).join("")}
      <div class="fin-tabela-wrap"><table class="fin-tabela"><caption class="fin-sub" style="text-align:left;padding:8px 12px">DRE gerencial — ${esc(rotuloMes(mes))}</caption>
        <thead><tr><th>Linha</th><th class="fin-num">Valor</th><th class="fin-num">% receita</th>${comp ? '<th class="fin-num">Mês anterior</th><th class="fin-num">Variação</th>' : ""}<th>Como é calculada</th></tr></thead><tbody>${linhas}</tbody></table></div>`;
  }
  carregar();
}
