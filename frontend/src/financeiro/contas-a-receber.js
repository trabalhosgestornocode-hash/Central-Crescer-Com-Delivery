// Contas a Receber (Financeiro 2.0, migration 152): controle de recebíveis. O recebimento NÃO cria lançamento de caixa:
// pode apontar a entrada do extrato que já existe (conciliação), para não duplicar vendas ou repasses.
import { fin } from "./api.js";
import { moeda, rotuloMes } from "./modelo.js";
import { garantirCss, cabecalho, seletorMes, tabela, badge, carregarEm, lerMes, gravarMes, ativarTooltips, esc, dialogo, campo, selecao, aviso, kpi } from "./ui.js";

const ORIGENS = [{ valor: "venda", rotulo: "Venda" }, { valor: "repasse", rotulo: "Repasse de plataforma" }, { valor: "reembolso", rotulo: "Reembolso" }, { valor: "emprestimo_concedido", rotulo: "Empréstimo concedido" }, { valor: "outro", rotulo: "Outro" }];
const SIT = { a_receber: ["A receber", "muted"], atrasado: ["Atrasado", "warn"], parcial: ["Parcialmente recebido", "warn"], recebido: ["Recebido", "ok"], cancelado: ["Cancelado", "muted"] };

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
  const atualizar = () => carregarEm(corpo, async () => { const [r, contas] = await Promise.all([fin.get("/recebiveis", { mes }), fin.get("/contas")]); return { r, contas }; }, ({ r, contas }) => pintar(corpo, r, contas, mes, atualizar));
  topo.innerHTML = cabecalho({ titulo: "Contas a Receber", sub: "Valores que a empresa tem a receber (repasses, reembolsos, vendas a prazo). Receber não cria caixa: vincule a entrada que já está no extrato.",
    extra: `${seletorMes(mes)} <button type="button" class="btn btn-primary btn-sm" data-novo>Novo recebível</button>` });
  topo.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); atualizar(); } });
  topo.querySelector("[data-novo]").addEventListener("click", async () => { try { novo(await fin.get("/contas"), mes, atualizar); } catch (e) { aviso(e.message, "bad"); } });
  atualizar();
}

function pintar(alvo, d, contas, mes, atualizar) {
  alvo.innerHTML = `
    <div class="fin-kpis">
      ${kpi({ rotulo: "Pendente de recebimento", valor: moeda(d.resumo.pendenteCentavos), destaque: true, formula: "Σ (valor original − recebido) dos recebíveis em aberto", origem: "Contas a Receber" })}
      ${kpi({ rotulo: "Já recebido", valor: moeda(d.resumo.recebidoCentavos) })}
      ${kpi({ rotulo: "Atrasados", valor: String(d.resumo.atrasados) })}
    </div>
    <section class="fin-cartao">${tabela({ vazio: "Nenhum recebível.", linhas: d.itens, colunas: [
      { rotulo: "Contraparte", render: (r) => `${esc(r.contraparte)}<br><span class="fin-kpi-nota">${esc(r.descricao ?? "")}</span>` },
      { rotulo: "Origem", render: (r) => esc(ORIGENS.find((o) => o.valor === r.origem)?.rotulo ?? r.origem) },
      { rotulo: "Competência", render: (r) => esc(rotuloMes(r.competencia)) },
      { rotulo: "Previsão", render: (r) => esc(r.previsao ? r.previsao.split("-").reverse().join("/") : "—") },
      { rotulo: "Original", num: true, render: (r) => moeda(r.valorOriginalCentavos) },
      { rotulo: "Recebido", num: true, render: (r) => `${moeda(r.recebidoCentavos)}${r.recebimentos.length ? `<br><span class="fin-kpi-nota">${r.recebimentos.filter((x) => x.status === "ativo").map((x) => `${esc(x.data.split("-").reverse().join("/"))} ${x.conciliado ? "· conciliado" : "· sem vínculo"}`).join("<br>")}</span>` : ""}` },
      { rotulo: "Pendente", num: true, render: (r) => moeda(r.pendenteCentavos) },
      { rotulo: "Situação", render: (r) => badge(...(SIT[r.situacao] ?? [r.situacao, "muted"])) },
      { rotulo: "", render: (r) => r.status === "cancelado" || r.pendenteCentavos === 0 ? "" : `<button type="button" class="btn btn-ghost btn-sm" data-receber="${r.id}">Registrar recebimento</button> <button type="button" class="btn btn-ghost btn-sm" data-cancelar="${r.id}">Cancelar</button>` },
    ] })}</section>`;
  alvo.querySelectorAll("[data-receber]").forEach((b) => b.addEventListener("click", () => receber(d.itens.find((i) => i.id === b.dataset.receber), contas, mes, atualizar)));
  alvo.querySelectorAll("[data-cancelar]").forEach((b) => b.addEventListener("click", () => dialogo({ titulo: "Cancelar recebível", enviar: "Cancelar", perigo: true, corpo: campo("Motivo", "motivo", { obrig: true, extra: 'minlength="5"' }),
    aoEnviar: async (f) => { await fin.post(`/recebiveis/${b.dataset.cancelar}/cancelar`, { motivo: f.get("motivo") }); aviso("Recebível cancelado."); atualizar(); } })));
}

function novo(contas, mes, atualizar) {
  dialogo({ titulo: "Novo recebível", enviar: "Salvar", corpo: `
    ${selecao("Origem", "origem", ORIGENS, { obrig: true, valor: "repasse" })}
    ${campo("Cliente ou plataforma", "contraparte", { obrig: true })}
    ${campo("Descrição", "descricao")}
    ${campo("Competência", "competencia", { tipo: "month", obrig: true, valor: mes })}
    ${campo("Valor original (R$)", "valor", { obrig: true, dica: "ex.: 1.234,56" })}
    ${campo("Previsão de recebimento", "previsao", { tipo: "date" })}
    ${selecao("Conta de destino prevista", "contaId", contas.map((c) => ({ valor: c.id, rotulo: c.nome })), { vazio: "—" })}`,
    aoEnviar: async (f) => { await fin.post("/recebiveis", Object.fromEntries([...f.entries()].filter(([, v]) => v !== ""))); aviso("Recebível registrado."); atualizar(); } });
}

async function receber(r, contas, mes, atualizar) {
  const dlg = dialogo({ titulo: `Recebimento — ${r.contraparte}`, enviar: "Registrar", corpo: `
    <p>Pendente: <strong>${moeda(r.pendenteCentavos)}</strong></p>
    ${campo("Data", "data", { tipo: "date", obrig: true })}
    ${campo("Valor (R$)", "valor", { obrig: true, valor: (r.pendenteCentavos / 100).toFixed(2).replace(".", ",") })}
    ${selecao("Conta", "contaId", contas.map((c) => ({ valor: c.id, rotulo: c.nome })), { obrig: true, valor: r.contaId ?? "", vazio: "Selecione…" })}
    <label class="fin-campo"><span>Entrada do extrato (conciliação)</span><select name="lancamentoId"><option value="">Sem vínculo por enquanto</option></select><small>Mostra as entradas da conta escolhida no mês.</small></label>`,
    aoEnviar: async (f) => { await fin.post(`/recebiveis/${r.id}/recebimentos`, Object.fromEntries([...f.entries()].filter(([, v]) => v !== ""))); aviso("Recebimento registrado."); atualizar(); } });
  const selConta = dlg.querySelector('[name="contaId"]'), selLanc = dlg.querySelector('[name="lancamentoId"]');
  const carregar = async () => {
    selLanc.innerHTML = '<option value="">Sem vínculo por enquanto</option>';
    if (!selConta.value) return;
    const [a, m] = mes.split("-").map(Number), fim = new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
    const ls = await fin.get("/lancamentos", { contaId: selConta.value, sentido: "entrada", de: `${mes}-01`, ate: fim, limite: 200 }).catch(() => ({ itens: [] }));
    for (const l of ls.itens ?? ls ?? []) selLanc.insertAdjacentHTML("beforeend", `<option value="${esc(l.id)}">${esc(String(l.data_movimento ?? l.dataMovimento).split("-").reverse().join("/"))} · ${esc(l.descricao)} · ${moeda(Number(l.valor_centavos ?? l.valorCentavos))}</option>`);
  };
  selConta.addEventListener("change", carregar); carregar();
}
