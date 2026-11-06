// Dívidas e Empréstimos (Financeiro 2.0, migration 152): natureza separada (própria, sócio, entre empresas, terceiros, tributária),
// eventos com principal, juros e encargos; saldo devedor informado é opcional e marcado como documentado ou não (nunca inventado).
import { fin } from "./api.js";
import { moeda, rotuloMes } from "./modelo.js";
import { garantirCss, cabecalho, seletorMes, tabela, badge, carregarEm, lerMes, gravarMes, ativarTooltips, esc, dialogo, campo, selecao, aviso, kpi } from "./ui.js";

const NAT = [{ valor: "propria", rotulo: "Dívida própria" }, { valor: "socio", rotulo: "Empréstimo de sócio" }, { valor: "entre_empresas", rotulo: "Entre empresas" }, { valor: "terceiros", rotulo: "Obrigação de terceiros" }, { valor: "tributaria", rotulo: "Parcelamento tributário" }];
const TIPOS = [["amortizacao", "Pagamento de parcela / amortização"], ["juros", "Juros"], ["encargo", "Encargos"], ["captacao", "Captação (novo valor recebido)"], ["retencao", "Retenção"], ["reembolso", "Reembolso"], ["envio", "Envio"], ["recebimento", "Recebimento"], ["outro", "Outro"]].map(([valor, rotulo]) => ({ valor, rotulo }));
const val = (c) => (c == null ? "—" : moeda(c));

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
  const atualizar = () => carregarEm(corpo, () => fin.get("/dividas", { mes }), (d) => pintar(corpo, d, atualizar));
  topo.innerHTML = cabecalho({ titulo: "Dívidas e Empréstimos", sub: "Dívidas próprias, de sócios, entre empresas, de terceiros e parcelamentos — separadas. Saldo desconhecido aparece como desconhecido, nunca como zero.",
    extra: `${seletorMes(mes)} <button type="button" class="btn btn-primary btn-sm" data-novo>Nova dívida</button>` });
  topo.querySelector("#fin-mes").addEventListener("change", (e) => { if (e.target.value) { mes = e.target.value; gravarMes(mes); atualizar(); } });
  topo.querySelector("[data-novo]").addEventListener("click", () => nova(atualizar));
  atualizar();
}

function pintar(alvo, d, atualizar) {
  const grupos = NAT.map((n) => ({ ...n, itens: d.itens.filter((i) => i.natureza === n.valor) })).filter((g) => g.itens.length);
  alvo.innerHTML = `
    <div class="fin-kpis">
      ${kpi({ rotulo: "Saldo devedor informado", valor: moeda(d.resumo.saldoInformadoCentavos), sub: d.resumo.saldoDesconhecido ? `${d.resumo.saldoDesconhecido} dívida(s) com saldo desconhecido` : "", formula: "Σ saldos informados das dívidas ativas", origem: "Dívidas e Empréstimos" })}
      ${kpi({ rotulo: `Parcelas do PE financeiro${d.mes ? ` — ${rotuloMes(d.mes)}` : ""}`, valor: val(d.resumo.parcelasPeFinanceiroNoMesCentavos), formula: "Σ principal + juros pagos no mês das dívidas marcadas para o PE financeiro (encargos já estão nas despesas fixas)" })}
      ${kpi({ rotulo: "Sem documentação", valor: String(d.resumo.semDocumentacao), sub: d.resumo.semDocumentacao ? badge("Pendência documental", "warn") : "" })}
    </div>
    ${grupos.map((g) => `<section class="fin-cartao"><h3>${esc(g.rotulo)}</h3>${tabela({ linhas: g.itens, colunas: [
      { rotulo: "Credor", render: (i) => `${esc(i.credor)}${i.pendenciaDocumental ? `<br><span class="fin-kpi-nota">${esc(i.pendenciaDocumental)}</span>` : ""}` },
      { rotulo: "Original", num: true, render: (i) => val(i.valorOriginalCentavos) },
      { rotulo: "Parcelas", render: (i) => (i.parcelasTotal ? `${i.parcelasPagas} de ${i.parcelasTotal}` : "—") },
      { rotulo: "No mês (principal · juros · encargos)", num: true, render: (i) => `${moeda(i.noMes.principalCentavos)} · ${moeda(i.noMes.jurosCentavos)} · ${moeda(i.noMes.encargosCentavos)}` },
      { rotulo: "Saldo informado", num: true, render: (i) => `${val(i.saldoInformadoCentavos)}${i.saldoInformadoEm ? `<br><span class="fin-kpi-nota">em ${esc(i.saldoInformadoEm.split("-").reverse().join("/"))}</span>` : ""}` },
      { rotulo: "Documento", render: (i) => badge(i.documentada ? "Documentada" : "A documentar", i.documentada ? "ok" : "warn") },
      { rotulo: "PE fin.", render: (i) => (i.entraPeFinanceiro ? "Sim" : "Não") },
      { rotulo: "", render: (i) => `<button type="button" class="btn btn-ghost btn-sm" data-evento="${i.id}">Registrar evento</button> <button type="button" class="btn btn-ghost btn-sm" data-saldo="${i.id}">Saldo/documento</button>` },
    ] })}</section>`).join("") || '<p class="fin-vazio-linha">Nenhuma dívida registrada.</p>'}`;
  alvo.querySelectorAll("[data-evento]").forEach((b) => b.addEventListener("click", () => evento(d.itens.find((i) => i.id === b.dataset.evento), atualizar)));
  alvo.querySelectorAll("[data-saldo]").forEach((b) => b.addEventListener("click", () => saldo(d.itens.find((i) => i.id === b.dataset.saldo), atualizar)));
}

function nova(atualizar) {
  dialogo({ titulo: "Nova dívida", enviar: "Salvar", corpo: `
    ${selecao("Natureza", "natureza", NAT, { obrig: true, valor: "propria" })}
    ${campo("Credor", "credor", { obrig: true })}
    ${campo("Descrição", "descricao")}
    ${campo("Valor original (R$)", "valorOriginal", { dica: "deixe em branco se não for conhecido" })}
    ${campo("Data da contratação", "dataContratacao", { tipo: "date" })}
    ${campo("Total de parcelas", "parcelasTotal", { tipo: "number", extra: 'min="1"' })}
    ${campo("Valor da parcela (R$)", "valorParcela")}
    <label class="fin-campo fin-campo--inline"><input type="checkbox" name="entraPeFinanceiro" value="1"> <span>Entra no ponto de equilíbrio financeiro</span></label>
    ${campo("Pendência documental", "pendenciaDocumental", { dica: "o que falta comprovar" })}`,
    aoEnviar: async (f) => { const b = Object.fromEntries([...f.entries()].filter(([, v]) => v !== "")); b.entraPeFinanceiro = f.get("entraPeFinanceiro") === "1"; await fin.post("/dividas", b); aviso("Dívida registrada."); atualizar(); } });
}

function evento(div, atualizar) {
  dialogo({ titulo: `Evento — ${div.credor}`, enviar: "Registrar", corpo: `
    ${selecao("Tipo", "tipo", TIPOS, { obrig: true, valor: "amortizacao" })}
    ${campo("Data", "data", { tipo: "date", obrig: true })}
    ${campo("Principal (R$)", "principal")}${campo("Juros (R$)", "juros")}${campo("Encargos (R$)", "encargos")}
    ${campo("Nº da parcela", "parcela", { tipo: "number", extra: 'min="1"' })}
    ${campo("Observação", "observacao")}`,
    aoEnviar: async (f) => { await fin.post(`/dividas/${div.id}/eventos`, Object.fromEntries([...f.entries()].filter(([, v]) => v !== ""))); aviso("Evento registrado."); atualizar(); } });
}

function saldo(div, atualizar) {
  dialogo({ titulo: `Saldo devedor — ${div.credor}`, enviar: "Salvar", corpo: `
    ${campo("Saldo informado (R$)", "saldoInformado", { valor: div.saldoInformadoCentavos == null ? "" : (div.saldoInformadoCentavos / 100).toFixed(2).replace(".", ","), dica: "em branco = desconhecido" })}
    ${campo("Data do saldo", "saldoInformadoEm", { tipo: "date", valor: div.saldoInformadoEm ?? "" })}
    <label class="fin-campo fin-campo--inline"><input type="checkbox" name="documentada" value="1"${div.documentada ? " checked" : ""}> <span>Saldo comprovado por documento (contrato/extrato)</span></label>
    ${campo("Pendência documental", "pendenciaDocumental", { valor: div.pendenciaDocumental ?? "" })}`,
    aoEnviar: async (f) => { const b = Object.fromEntries([...f.entries()].filter(([, v]) => v !== "")); b.documentada = f.get("documentada") === "1"; await fin.patch(`/dividas/${div.id}`, b); aviso("Saldo atualizado."); atualizar(); } });
}
