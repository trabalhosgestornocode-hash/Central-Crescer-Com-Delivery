// Rateios por competência (Financeiro 2.0, migration 152): distribui o CUSTO de uma conta a pagar entre meses no DRE de referência.
// Não altera pagamentos nem o extrato. "Proposto" é referência provisória; aprovar é decisão da contadora (permissão classificar).
import { fin } from "./api.js";
import { moeda, rotuloMes } from "./modelo.js";
import { garantirCss, cabecalho, seletorMes, tabela, badge, carregarEm, lerMes, gravarMes, ativarTooltips, esc, dialogo, campo, selecao, aviso, kpi } from "./ui.js";

const CRIT = [{ valor: "dias_consumo", rotulo: "Dias de consumo" }, { valor: "producao", rotulo: "Produção" }, { valor: "outro", rotulo: "Outro (justificar)" }];
const rotCrit = (v) => CRIT.find((c) => c.valor === v)?.rotulo ?? v;
const STATUS = { proposto: ["Proposto — a aprovar", "warn"], aprovado: ["Aprovado", "ok"], cancelado: ["Cancelado", "muted"] };
const paraCentavos = (t) => { const s = String(t ?? "").trim().replace(/\./g, "").replace(",", "."); return /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : NaN; };

export async function render(container) {
  garantirCss();
  container.innerHTML = "";
  const raiz = document.createElement("section");
  raiz.className = "fin-pg";
  container.appendChild(raiz);
  ativarTooltips(raiz);
  const topo = document.createElement("div"), corpo = document.createElement("div");
  corpo.className = "fin-pg";
  raiz.append(topo, corpo);
  let mes = lerMes();
  const atualizar = () => carregarEm(corpo, () => fin.get("/rateios", { mes }), (d) => pintar(corpo, d, atualizar));
  topo.innerHTML = cabecalho({ titulo: "Rateios por competência", sub: "Distribui o custo de uma conta entre os meses de consumo ou produção. O pagamento e o extrato não mudam; só o DRE de referência.",
    extra: `${seletorMes(mes)} <button type="button" class="btn btn-primary btn-sm" data-novo>Novo rateio</button>` });
  topo.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); atualizar(); } });
  topo.querySelector("[data-novo]").addEventListener("click", async () => { try { abrirNovo(await fin.get("/rateios"), atualizar); } catch (e) { aviso(e.message, "bad"); } });
  atualizar();
}

function pintar(alvo, d, atualizar) {
  alvo.innerHTML = `
    <div class="fin-kpis">
      ${kpi({ rotulo: "Rateios do mês", valor: String(d.itens.length) })}
      ${kpi({ rotulo: "Propostos (a aprovar)", valor: String(d.resumo.propostos), sub: d.resumo.propostos ? badge("Decisão da contadora", "warn") : "" })}
      ${kpi({ rotulo: "Aprovados", valor: String(d.resumo.aprovados) })}
    </div>
    <section class="fin-cartao"><h3>Rateios ${d.mes ? `que afetam ${esc(rotuloMes(d.mes))}` : ""}</h3>
    ${tabela({ vazio: "Nenhum rateio neste mês.", linhas: d.itens, colunas: [
      { rotulo: "Conta a pagar", render: (r) => `${esc(r.obrigacao?.descricao ?? "—")}<br><span class="fin-kpi-nota">${esc(r.obrigacao?.fornecedor ?? "")} · ${esc(r.obrigacao?.categoria ?? "")} · competência ${esc(rotuloMes(r.competenciaOrigem))}</span>` },
      { rotulo: "Original", num: true, render: (r) => moeda(r.obrigacao?.valorOriginalCentavos ?? 0) },
      { rotulo: "Elegível", num: true, render: (r) => moeda(r.valorElegivelCentavos) },
      { rotulo: "Distribuição", render: (r) => r.parcelas.map((p) => `${esc(rotuloMes(p.competencia))}: ${moeda(p.valorCentavos)}`).join("<br>") },
      { rotulo: "Critério", render: (r) => `${esc(rotCrit(r.criterio))}<br><span class="fin-kpi-nota">${esc(r.justificativa)}</span>` },
      { rotulo: "Situação", render: (r) => badge(...(STATUS[r.status] ?? [r.status, "muted"])) },
      { rotulo: "", render: (r) => r.status === "cancelado" ? "" : `${r.status === "proposto" ? `<button type="button" class="btn btn-ghost btn-sm" data-aprovar="${r.id}">Aprovar</button>` : ""} <button type="button" class="btn btn-ghost btn-sm" data-cancelar="${r.id}">Cancelar</button>` },
    ] })}</section>`;
  alvo.querySelectorAll("[data-aprovar]").forEach((b) => b.addEventListener("click", () => dialogo({ titulo: "Aprovar rateio", enviar: "Aprovar", corpo: "<p>Confirma que este critério de rateio foi validado pela contadora? A aprovação fica registrada com o seu usuário.</p>",
    aoEnviar: async () => { await fin.post(`/rateios/${b.dataset.aprovar}/aprovar`, {}); aviso("Rateio aprovado."); atualizar(); } })));
  alvo.querySelectorAll("[data-cancelar]").forEach((b) => b.addEventListener("click", () => dialogo({ titulo: "Cancelar rateio", enviar: "Cancelar rateio", perigo: true,
    corpo: `<p>A conta volta a entrar inteira na competência original. Nada é apagado.</p>${campo("Motivo", "motivo", { obrig: true, extra: 'minlength="5"' })}`,
    aoEnviar: async (f) => { await fin.post(`/rateios/${b.dataset.cancelar}/cancelar`, { motivo: f.get("motivo") }); aviso("Rateio cancelado."); atualizar(); } })));
}

function abrirNovo(d, atualizar) {
  const opcoes = d.obrigacoesSemRateio.map((o) => ({ valor: o.id, rotulo: `${o.descricao} · ${o.fornecedor ?? "—"} · ${rotuloMes(o.competencia)} · ${moeda(o.valorOriginalCentavos)}` }));
  const linhaParcela = () => `<div class="fin-linha-parcela">${campo("Competência", "competencia", { tipo: "month", obrig: true })}${campo("Valor (R$)", "valorParcela", { obrig: true, dica: "ex.: 1.234,56" })}</div>`;
  const dlg = dialogo({ titulo: "Novo rateio", enviar: "Salvar como proposto", corpo: `
    ${selecao("Conta a pagar", "obrigacaoId", opcoes, { obrig: true, vazio: "Selecione…" })}
    ${campo("Valor elegível (R$)", "valorElegivel", { obrig: true, dica: "parte do custo que será distribuída (≤ valor original)" })}
    ${selecao("Critério", "criterio", CRIT, { obrig: true, valor: "dias_consumo" })}
    ${campo("Justificativa", "justificativa", { obrig: true, extra: 'minlength="5"' })}
    ${campo("Origem documental", "origemDocumental", { dica: "nota fiscal, planilha, e-mail…" })}
    <fieldset class="fin-parcelas"><legend>Distribuição por competência</legend><div data-parcelas>${linhaParcela()}${linhaParcela()}</div>
      <button type="button" class="btn btn-ghost btn-sm" data-mais>+ competência</button> <span class="fin-kpi-nota" data-soma></span></fieldset>`,
    aoEnviar: async (f) => {
      const comps = f.getAll("competencia"), vals = f.getAll("valorParcela").map(paraCentavos);
      if (vals.some((v) => !Number.isFinite(v) || v <= 0)) throw new Error("Valores das competências inválidos.");
      const eleg = paraCentavos(f.get("valorElegivel"));
      if (vals.reduce((a, b) => a + b, 0) !== eleg) throw new Error("A soma das competências precisa ser igual ao valor elegível.");
      await fin.post("/rateios", { obrigacaoId: f.get("obrigacaoId"), valorElegivel: f.get("valorElegivel"), criterio: f.get("criterio"), justificativa: f.get("justificativa"), origemDocumental: f.get("origemDocumental") || null,
        parcelas: comps.map((c, i) => ({ competencia: c, valor: (vals[i] / 100).toFixed(2) })) });
      aviso("Rateio salvo como proposto."); atualizar();
    } });
  const caixa = dlg.querySelector("[data-parcelas]"), somaEl = dlg.querySelector("[data-soma]");
  const recalcular = () => { const vs = [...dlg.querySelectorAll('[name="valorParcela"]')].map((i) => paraCentavos(i.value)).filter(Number.isFinite); const e = paraCentavos(dlg.querySelector('[name="valorElegivel"]').value);
    const s = vs.reduce((a, b) => a + b, 0); somaEl.textContent = `Soma: ${moeda(s)}${Number.isFinite(e) ? (s === e ? " ✓ confere" : ` · falta ${moeda(e - s)}`) : ""}`; };
  dlg.querySelector("[data-mais]").addEventListener("click", () => { caixa.insertAdjacentHTML("beforeend", linhaParcela()); });
  dlg.addEventListener("input", recalcular);
}
