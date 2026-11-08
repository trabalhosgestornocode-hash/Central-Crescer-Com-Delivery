// Barra global do Financeiro 2.0: "+ Novo lançamento" (central simplificada de registros) e acesso à Central de conferências.
// Cada tipo abre UM formulário simples, com só os campos necessários, e diz em linguagem simples onde o registro vai aparecer.
// Faturamento e ajuste usam os formulários desta central; os demais abrem o formulário que já existe na tela certa (sem duplicar regra).
import { fin } from "./api.js";
import { dialogo, campo, selecao, aviso, lerMes, esc } from "./ui.js";
import { mesDe, rotuloMes } from "./modelo.js";
import { abrirCentral, contarPendencias } from "./conferencias.js";

const TIPOS = [
  { id: "faturamento", icone: "📈", titulo: "Faturamento / vendas", desc: "Total vendido por canal (balcão, iFood, Anota Aí) em um mês.", onde: "Visão Geral e DRE Gerencial (composição do faturamento)", perm: "lancar" },
  { id: "recebimento", icone: "💵", titulo: "Recebimento", desc: "Dinheiro que entrou na conta ou no caixa.", onde: "Fluxo de Caixa e saldos das contas", perm: "lancar", ir: { rota: "fin-fluxo-de-caixa", seletor: "[data-novo]" } },
  { id: "conta", icone: "🧾", titulo: "Conta a pagar", desc: "Uma obrigação com fornecedor, valor, vencimento e competência.", onde: "Contas a Pagar; entra na DRE conforme a categoria", perm: "lancar", ir: { rota: "fin-contas-a-pagar", seletor: "[data-nova]" } },
  { id: "pagamento", icone: "✅", titulo: "Pagamento", desc: "Registrar o pagamento de uma conta: valor, data e conta de saída.", onde: "Contas a Pagar, Juros e Conciliação de Saídas", perm: "lancar", ir: { rota: "fin-contas-a-pagar", seletor: "[data-nova]" } },
  { id: "compra", icone: "🛒", titulo: "Compra / custo", desc: "Compra de insumos ou despesa: é uma conta a pagar com categoria de custo.", onde: "Contas a Pagar; entra no CMV da DRE pela competência", perm: "lancar", ir: { rota: "fin-contas-a-pagar", seletor: "[data-nova]" } },
  { id: "transferencia", icone: "🔁", titulo: "Transferência", desc: "Dinheiro que muda de uma conta sua para outra. Não é despesa nem receita.", onde: "Fluxo de Caixa (não entra na DRE)", perm: "lancar", ir: { rota: "fin-fluxo-de-caixa", seletor: "[data-transf]" } },
  { id: "emprestimo", icone: "🏦", titulo: "Empréstimo", desc: "Dívida ou financiamento, com credor, parcelas e saldo.", onde: "Dívidas e Empréstimos (fora do resultado gerencial)", perm: "lancar", ir: { rota: "fin-dividas", seletor: "[data-novo]" } },
  { id: "ajuste", icone: "🧮", titulo: "Ajuste documentado", desc: "Diferença entre o total do painel de vendas e a base da DRE, com evidência.", onde: "Visão Geral (ponte do faturamento) e Central de conferências", perm: "lancar" },
];

const CANAIS = ["Balcão", "iFood", "Anota Aí"];
const reais = (v) => String(v ?? "").trim().replace(/\./g, "").replace(",", ".");
const podeFazer = (perms, p) => perms.includes(`gestao_financeira.${p}`);

async function irEAbrir({ rota, seletor }) {
  const { irPara } = await import("../router.js");
  irPara(rota);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const b = document.querySelector(`#view ${seletor}`);
    if (b && b.offsetParent !== null) { b.click(); return; }
  }
}

function formFaturamento(mes, aposSalvar) {
  dialogo({ titulo: "Registrar faturamento por canal", enviar: "Registrar", corpo: `
    <p class="fin-sub">Registra o <strong>total do canal no mês</strong> (consolidação mensal). Não cria recebimento bancário e não muda as vendas diárias oficiais.</p>
    ${campo("Competência", "mes", { tipo: "month", valor: mes, obrig: true })}
    ${selecao("Canal de venda", "canal", [...CANAIS.map((c) => ({ valor: c, rotulo: c })), { valor: "__outro", rotulo: "Outro canal…" }], { obrig: true, vazio: null })}
    ${campo("Outro canal (nome)", "canalOutro", { dica: "Preencha só se escolheu “Outro canal”." })}
    ${campo("Total no painel de origem (R$)", "valorPainel", { obrig: true, extra: 'inputmode="decimal" autocomplete="off"', dica: "O que o painel/relatório de vendas mostra para o canal." })}
    ${campo("Base usada na DRE (R$)", "valorGerencial", { extra: 'inputmode="decimal" autocomplete="off"', dica: "Deixe vazio se for igual ao painel. Se for menor, registre depois o ajuste que explica a diferença." })}
    ${campo("Quantidade de vendas", "vendasQtd", { tipo: "number", extra: 'min="0" step="1"' })}
    ${selecao("Fonte", "fonte", [{ valor: "SAIPOS (relatório)", rotulo: "SAIPOS (relatório)" }, { valor: "Registro manual", rotulo: "Registro manual" }], { obrig: true, vazio: null })}
    ${campo("Observação", "observacao", { extra: 'maxlength="500"' })}`,
    aoEnviar: async (d) => {
      const canal = d.get("canal") === "__outro" ? String(d.get("canalOutro") ?? "").trim() : d.get("canal");
      if (!canal) throw new Error("Informe o nome do canal.");
      const corpo = { mes: d.get("mes"), canal, granularidade: "mensal", valorPainel: reais(d.get("valorPainel")), fonte: d.get("fonte"), observacao: d.get("observacao") || undefined };
      if (String(d.get("valorGerencial") ?? "").trim()) corpo.valorGerencial = reais(d.get("valorGerencial"));
      if (String(d.get("vendasQtd") ?? "").trim()) corpo.vendasQtd = Number(d.get("vendasQtd"));
      const r = await fin.post("/vendas-canal", corpo);
      aviso(`Registrado. Aparece em: ${r.mostrarEm.join(" e ")}. Nenhum recebimento bancário foi criado.`);
      aposSalvar();
    } });
}

function formAjuste(mes, aposSalvar) {
  dialogo({ titulo: "Registrar ajuste documentado do faturamento", enviar: "Registrar", corpo: `
    <p class="fin-sub">Explica a diferença entre o total do painel e a base da DRE (ex.: taxa de entrega, desconto). <strong>Não é taxa financeira nem dedução</strong>. Nasce como <em>estimado</em> e só vira confirmado na Central de conferências, com evidência.</p>
    ${campo("Competência", "mes", { tipo: "month", valor: mes, obrig: true })}
    ${selecao("Canal", "canal", CANAIS.map((c) => ({ valor: c, rotulo: c })), { obrig: true, vazio: null })}
    ${selecao("Tipo", "tipo", [{ valor: "taxa_entrega", rotulo: "Taxa de entrega" }, { valor: "desconto", rotulo: "Desconto" }, { valor: "estimativa", rotulo: "Estimativa" }, { valor: "outro", rotulo: "Outro" }], { obrig: true, vazio: null })}
    ${selecao("Efeito no painel", "sinal", [{ valor: "-", rotulo: "Reduz o total do painel" }, { valor: "+", rotulo: "Aumenta o total do painel" }], { obrig: true, vazio: null })}
    ${campo("Valor (R$)", "valor", { obrig: true, extra: 'inputmode="decimal" autocomplete="off"' })}
    ${campo("Descrição", "descricao", { obrig: true, extra: 'maxlength="300"' })}
    ${campo("Evidência (opcional agora)", "evidencia", { extra: 'maxlength="500"', dica: "Ex.: relatório do Portal do Parceiro. Será exigida para confirmar." })}`,
    aoEnviar: async (d) => {
      await fin.post("/vendas-ajustes", { mes: d.get("mes"), canal: d.get("canal"), tipo: d.get("tipo"), valor: `${d.get("sinal") === "-" ? "-" : ""}${reais(d.get("valor"))}`, descricao: d.get("descricao"), evidencia: d.get("evidencia") || undefined });
      aviso("Ajuste registrado como estimado. Aparece na ponte do faturamento e na Central de conferências.");
      aposSalvar();
    } });
}

function abrirChooser(perms, aposSalvar) {
  const mes = lerMes() || mesDe();
  const dlg = document.createElement("dialog");
  dlg.className = "fin-dialogo fin-novo";
  dlg.setAttribute("aria-labelledby", "fin-novo-t");
  dlg.innerHTML = `<div class="fin-form"><h3 id="fin-novo-t">O que você quer registrar?</h3>
    <p class="fin-sub">Escolha uma opção. Cada uma abre um formulário simples e mostra onde o registro vai aparecer.</p>
    <ul class="fn-grade">${TIPOS.map((t) => `<li><button type="button" data-tipo="${t.id}" ${podeFazer(perms, t.perm) ? "" : "disabled"}><span class="fn-ic" aria-hidden="true">${t.icone}</span><span class="fn-tx"><strong>${esc(t.titulo)}</strong><small>${esc(t.desc)}</small><small class="fn-onde">Aparece em: ${esc(t.onde)}</small></span></button></li>`).join("")}</ul>
    <div class="fin-form-acoes"><button type="button" class="btn btn-ghost btn-sm" data-fechar>Cancelar</button></div></div>`;
  document.body.appendChild(dlg);
  const fechar = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); fechar(); });
  dlg.querySelector("[data-fechar]").addEventListener("click", fechar);
  dlg.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-tipo]"); if (!b) return;
    const t = TIPOS.find((x) => x.id === b.dataset.tipo); fechar();
    if (t.id === "faturamento") formFaturamento(mes, aposSalvar);
    else if (t.id === "ajuste") formAjuste(mes, aposSalvar);
    else if (t.ir) await irEAbrir(t.ir);
  });
  dlg.showModal();
  dlg.querySelector("button[data-tipo]:not([disabled])")?.focus();
}

/** Insere a barra no topo da página financeira. `perms` = permissões do usuário no módulo. */
export async function montarAcoesGlobais(alvo, { permissoes, rotaId }) {
  alvo.querySelector(":scope > .fin-globais")?.remove();
  const perms = permissoes ?? [];
  const barra = document.createElement("div");
  barra.className = "fin-globais";
  barra.innerHTML = `<button type="button" class="btn btn-primary btn-sm" data-novo-lancamento ${podeFazer(perms, "lancar") ? "" : "disabled title=\"Seu perfil não registra lançamentos\""}>+ Novo lançamento</button>
    <button type="button" class="btn btn-ghost btn-sm" data-central>Conferências <span class="fin-contagem" data-contagem hidden></span></button>`;
  alvo.prepend(barra);
  const recarregar = async () => { const { irPara } = await import("../router.js"); irPara(rotaId); };
  barra.querySelector("[data-novo-lancamento]").addEventListener("click", () => abrirChooser(perms, recarregar));
  barra.querySelector("[data-central]").addEventListener("click", () => abrirCentral({ mes: lerMes(), aoAlterar: recarregar }));
  const r = await contarPendencias(lerMes());
  const c = barra.querySelector("[data-contagem]");
  if (r?.total && c) { c.textContent = String(r.total); c.hidden = false; c.setAttribute("aria-label", `${r.total} pendências`); }
}
void rotuloMes;
