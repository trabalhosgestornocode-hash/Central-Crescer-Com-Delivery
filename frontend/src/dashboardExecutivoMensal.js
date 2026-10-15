// Lançamento de Faturamento Mensal — para meses históricos onde o
// franqueado só sabe o total do mês, não o valor de cada dia. Distribui o
// total pelos dias sem lançamento (nunca sobrescreve dia já lançado).
//
// Paridade de conteúdo com o lançamento diário: as mesmas categorias de
// informação (Período, Desempenho, Financeiro, Conferência), sempre que
// fizerem sentido pra um consolidado do mês. "Situação" (normal/sem
// operação/zero vendas) do diário NÃO tem equivalente aqui de propósito —
// a distribuição mensal sempre representa dias operando normalmente; não
// existe "o mês inteiro sem operação" com um faturamento lançado.
//
// Fluxo de criação em 4 passos (Período -> Desempenho -> Financeiro ->
// Conferência), reaproveitando o MESMO componente de stepper
// (.dex-stepper/.dex-step) que dashboardExecutivoForm.js já usa — nenhum
// componente novo. O valor autoritativo é sempre o que o backend recalcula
// (distribuirValorMensal em dashboardExecutivo.calc.js), inclusive a
// exatidão em centavos.
//
// Desempenho e Financeiro NUNCA se misturam: cada campo extra pertence a um
// grupo (`grupo: "desempenho" | "financeiro"`) só usado pra organizar a
// tela — o valor bruto de vendas do mês (Desempenho) é um total
// independente do franqueado, nunca derivado do faturamento (Financeiro);
// ver dashboardExecutivo.service.js#lancamentoMensal.
//
// GERENCIAMENTO (visualizar/editar/excluir): quando o mês JÁ TEM um
// lançamento mensal, este modal nunca mais tenta criar um segundo — abre
// direto a tela de gerenciamento (ver dashboardExecutivo.service.js#lancamentoMensal,
// que agora bloqueia a criação duplicada com uma mensagem acionável). Editar
// só substitui o que o usuário de fato mexeu — campo intocado preserva o
// valor salvo, nunca vira zero nem some (ver atualizarLancamentoMensal).
import { el, escapeHtml, toast, fmtMoeda, fmtDataHora } from "./utils.js";
import { pode } from "./sessao.js";
import {
  dashExecPreviewLancamentoMensal, dashExecConfirmarLancamentoMensal,
  dashExecLancamentoMensal, dashExecAtualizarLancamentoMensal, dashExecExcluirLancamentoMensal,
} from "./api.js";
import { icon } from "./icons.js";
import { aplicarMascaraMoeda, formatarMoedaBRL, numeroDecimal } from "./numeroDecimal.js";
import { SINAL_CUSTO, sinalDoArmazenado, paraArmazenado, campoServicosHtml, ligarSeletorSinal, fmtServicosPromocoes } from "./sinalServicos.js";

const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const PASSOS = ["periodo", "desempenho", "financeiro", "conferencia"];
const TITULOS_PASSO = { periodo: "Período", desempenho: "Desempenho", financeiro: "Financeiro", conferencia: "Conferência" };

let ov = null;
let lm = null;

function fecharOverlay() { ov?.remove(); ov = null; lm = null; document.removeEventListener("keydown", onEsc); }
function onEsc(e) { if (e.key === "Escape") fecharOverlay(); }
function abrirOverlay(html) {
  fecharOverlay();
  ov = document.createElement("div"); ov.className = "modal-overlay";
  ov.innerHTML = `<div class="modal dex-modal">${html}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) fecharOverlay(); });
  document.body.appendChild(ov); document.addEventListener("keydown", onEsc);
  return ov.querySelector(".modal");
}

const podeEditarLote = () => pode("dashboard_executivo.corrigir");
const podeExcluirLote = () => pode("dashboard_executivo.excluir");

// Campos extras — TODOS opcionais. Preenchidos, viram totais do mês que o
// backend distribui do mesmo jeito exato do faturamento (contagem inteira
// pra pedidos/clientes, centavo exato pra valores). Vazios, o dia gerado
// continua sem essa informação (null, nunca 0) — ver dashboardExecutivo.calc.js.
// `grupo` só organiza a tela (Desempenho x Financeiro) — mesmo vocabulário
// do lançamento diário, sem duplicar conceito nenhum no banco.
const CAMPOS_EXTRAS = [
  { campo: "qtdVendasTotal", label: "Quantidade de pedidos do mês", tipo: "int", grupo: "desempenho" },
  { campo: "valorVendasBrutoTotal", label: "Valor bruto de vendas do mês (R$)", tipo: "money", grupo: "desempenho" },
  { campo: "novosClientesTotal", label: "Novos clientes do mês", tipo: "int", grupo: "desempenho" },
  { campo: "taxasComissoesTotal", label: "Taxas e comissões do mês (R$)", tipo: "money", grupo: "financeiro" },
  { campo: "servicosPromocoesTotal", label: "Serviços e promoções do mês (R$)", tipo: "money", grupo: "financeiro" },
  { campo: "taxasEntregadoresTotal", label: "Taxas de entregadores do mês (R$)", tipo: "money", grupo: "financeiro", ocultoSeFullService: true },
  { campo: "ajustesFavorLojaTotal", label: "Ajustes a favor da loja no mês (R$)", tipo: "money", grupo: "financeiro" },
  { campo: "ajustesContraLojaTotal", label: "Ajustes contra a loja no mês (R$)", tipo: "money", grupo: "financeiro" },
];
const ROTULO_EXTRA = Object.fromEntries(CAMPOS_EXTRAS.map((c) => [c.campo, c.label.replace(" do mês", "").replace(" (R$)", "")]));
const campoExtra = (campo) => CAMPOS_EXTRAS.find((c) => c.campo === campo);
const valorMoedaInput = (valor) => escapeHtml(formatarMoedaBRL(valor));
const camposVisiveis = () => CAMPOS_EXTRAS.filter((c) => !(c.ocultoSeFullService && lm.modeloLogistico === "full_service"));
const camposDoGrupo = (grupo) => camposVisiveis().filter((c) => c.grupo === grupo);
// Serviços e promoções do mês é o único extra com sinal: `extras[...]` guarda
// o valor GRAVADO (negativo = crédito) e o sinal da tela fica em `sinalServicos`
// do estado — conversão só em sinalServicos.js.
const CAMPO_SERVICOS = "servicosPromocoesTotal";

/** Input de um campo extra (criação e edição). */
function inputExtraHtml(c, extras, sinalServicos) {
  if (c.campo === CAMPO_SERVICOS) {
    return campoServicosHtml({ rotulo: c.label, valorArmazenado: extras[c.campo], sinal: sinalServicos, atributosInput: `data-extra="${CAMPO_SERVICOS}"` });
  }
  return `
    <label class="cfg-campo"><span>${c.label}</span>
      <input type="${c.tipo === "int" ? "number" : "text"}" inputmode="${c.tipo === "int" ? "numeric" : "decimal"}" min="0" step="${c.tipo === "int" ? "1" : "0.01"}" data-extra="${c.campo}" ${c.tipo === "money" ? "data-moeda" : ""} value="${c.tipo === "money" ? valorMoedaInput(extras[c.campo]) : (extras[c.campo] ?? "")}" placeholder="${c.tipo === "int" ? "Não informado" : "R$ 0,00"}"></label>`;
}

/** Liga os inputs extras de `estado` (`lm` na criação, `lm.edicao` na edição). */
function ligarInputsExtras(m, estado) {
  const extras = estado.extras;
  m.querySelectorAll("[data-extra]").forEach((input) => {
    const campo = input.dataset.extra;
    if (campo === CAMPO_SERVICOS) {
      const gravar = () => { extras[campo] = paraArmazenado(input.value, estado.sinalServicos); };
      aplicarMascaraMoeda(input, { aoAlterar: gravar });
      ligarSeletorSinal(input.closest(".dex-sinal-campo"), { aoAlterarSinal: (sinal) => { estado.sinalServicos = sinal; gravar(); } });
    } else if (campoExtra(campo)?.tipo === "money") {
      aplicarMascaraMoeda(input, { aoAlterar: (valor) => { extras[campo] = valor; atualizarTicketMedioPreview(m, extras); } });
    } else {
      input.addEventListener("input", (e) => { extras[campo] = e.target.value; atualizarTicketMedioPreview(m, extras); });
    }
  });
}

/**
 * @param {{unidadeId: string|null, mes: number, ano: number, modeloLogistico?: string, onSalvo: () => void, modoInicial?: 'ver'|'editar'|'excluir'}} p
 */
export async function abrirLancamentoMensalModal({ unidadeId, mes, ano, modeloLogistico, onSalvo, modoInicial }) {
  // abrirOverlay() fecha qualquer modal anterior (fecharOverlay zera `lm`) —
  // por isso o estado só é atribuído DEPOIS de abrir o overlay novo, nunca
  // antes (mesma pegadinha documentada em dashboardExecutivoForm.js).
  const m = abrirOverlay(`<div class="estado"><div class="spinner"></div>Carregando…</div>`);
  lm = { unidadeId, mes, ano, modeloLogistico, valor: "", extras: {}, sinalServicos: SINAL_CUSTO, passo: 1, onSalvo, lote: null, edicao: null };
  try {
    const { data } = await dashExecLancamentoMensal({ unidadeId: unidadeId || undefined, mes, ano });
    if (data.existe) {
      lm.lote = data;
      if (modoInicial === "editar") renderEdicao(m);
      else if (modoInicial === "excluir") renderConfirmarExclusao(m);
      else renderGerenciamento(m);
    } else {
      renderPeriodo(m);
    }
  } catch (e) {
    m.innerHTML = `<button class="modal-close" aria-label="Fechar">×</button>
      <div class="estado erro"><span class="estado-ic">${icon("alert-triangle", { size: 22 })}</span><h3>Erro ao carregar</h3><p>${escapeHtml(e.message)}</p></div>`;
    m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  }
}

// ---------------------------------------------------------------------------
// CRIAÇÃO — só aparece quando o mês AINDA NÃO tem lançamento mensal (item 8:
// nunca mais bloqueia dizendo "já foi lançado" sem saída — quando já existe,
// abrirLancamentoMensalModal acima nem chega aqui, vai direto pro gerenciamento).
//
// 4 passos: Período -> Desempenho -> Financeiro -> Conferência. Cada
// render* é dono do próprio HTML/listeners (mesmo padrão do resto do
// arquivo) — só a barrinha de progresso (.dex-stepper) é compartilhada.
// ---------------------------------------------------------------------------
function stepperHtml() {
  return `<div class="dex-stepper">${PASSOS.map((_, i) => `<span class="dex-step ${i + 1 === lm.passo ? "ativo" : i + 1 < lm.passo ? "feito" : ""}">${i + 1}</span>`).join("")}</div>`;
}

function cabecalhoPasso(titulo) {
  return `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>${icon("calendar", { size: 17 })} Lançar faturamento mensal</h2></div>
    ${stepperHtml()}
    <div class="dex-form-pergunta">${titulo}</div>`;
}

function anosDisponiveis() {
  const atual = new Date().getFullYear();
  const lista = [];
  for (let a = atual; a >= atual - 4; a--) lista.push(a);
  return lista;
}

function extrasInputsHtml(grupo) {
  return camposDoGrupo(grupo).map((c) => inputExtraHtml(c, lm.extras, lm.sinalServicos)).join("");
}

// Ticket médio do mês = valor bruto de vendas ÷ quantidade de pedidos —
// MESMA fórmula central do diário e do backend (ver
// dashboardExecutivo.calc.js#ticketMedio); aqui só uma prévia responsiva
// durante a digitação, sem round-trip por tecla (mesmo espírito de
// ticketMedioPreview em dashboardExecutivoForm.js). O valor salvo é sempre
// o que o backend recalcula (ver montarResumoLoteMensal -> lote.ticketMedio).
// Nunca assume zero: falta um dos dois lados -> null.
function ticketMedioPreview(valorBruto, qtd) {
  const v = valorBruto === "" || valorBruto == null ? null : numeroDecimal(valorBruto);
  const q = qtd === "" || qtd == null ? null : Number(qtd);
  if (v == null || q == null || !(q > 0)) return null;
  return v / q;
}
/** Campo somente-leitura do Ticket Médio, dentro do mesmo grid dos outros campos de Desempenho (item 8 do pedido). */
function campoTicketMedioHtml(valor) {
  return `<label class="cfg-campo"><span>Ticket médio do mês (calculado)</span><input type="text" id="lm-ticket-medio" value="${valor == null ? "—" : fmtMoeda(valor)}" disabled></label>`;
}
/** Atualiza o campo somente-leitura do Ticket Médio ao vivo — vira no-op fora do passo Desempenho/Edição, onde o campo não existe no DOM. */
function atualizarTicketMedioPreview(m, extras) {
  const campo = m.querySelector("#lm-ticket-medio");
  if (!campo) return;
  const valor = ticketMedioPreview(extras.valorVendasBrutoTotal, extras.qtdVendasTotal);
  campo.value = valor == null ? "—" : fmtMoeda(valor);
}
function wireExtrasInputs(m) {
  ligarInputsExtras(m, lm);
}

// PASSO 1 — Período (mês/ano, igual já era antes do stepper existir)
function renderPeriodo(m) {
  m.innerHTML = `
    ${cabecalhoPasso("Período")}
    <p class="dex-form-info">Para meses históricos onde você só sabe o total faturado, não o valor de cada dia. O sistema distribui os valores proporcionalmente entre os dias do mês que ainda não têm lançamento.</p>
    <div class="cfg-form-grid">
      <label class="cfg-campo"><span>Mês</span>
        <select id="lm-mes">${MESES.map((n, i) => `<option value="${i + 1}" ${i + 1 === lm.mes ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="cfg-campo"><span>Ano</span>
        <select id="lm-ano">${anosDisponiveis().map((a) => `<option value="${a}" ${a === lm.ano ? "selected" : ""}>${a}</option>`).join("")}</select></label>
    </div>
    <div class="ed-acoes dex-form-acoes">
      <button class="btn btn-ghost" id="lm-cancelar">Cancelar</button>
      <button class="btn btn-primary" id="lm-avancar">Continuar</button>
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-cancelar").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-mes").addEventListener("change", (e) => { lm.mes = Number(e.target.value); });
  m.querySelector("#lm-ano").addEventListener("change", (e) => { lm.ano = Number(e.target.value); });
  m.querySelector("#lm-avancar").addEventListener("click", () => { lm.passo = 2; renderDesempenho(m); });
}

// PASSO 2 — Desempenho do mês (dados operacionais, tudo opcional — mesmos
// campos/nomenclatura do Desempenho diário, só que consolidados no total do
// período: qtd_vendas, valor_vendas_bruto, novos_clientes).
function renderDesempenho(m) {
  const ticket = ticketMedioPreview(lm.extras.valorVendasBrutoTotal, lm.extras.qtdVendasTotal);
  m.innerHTML = `
    ${cabecalhoPasso(`Desempenho — ${MESES[lm.mes - 1]}/${lm.ano}`)}
    <p class="dex-form-info">Dados operacionais do mês. Preencha caso tenha acesso a esses totais — nada aqui é obrigatório: o que ficar em branco fica registrado como "não informado", nunca como zero.</p>
    <div class="cfg-form-grid">${extrasInputsHtml("desempenho")}${campoTicketMedioHtml(ticket)}</div>
    <div class="ed-acoes dex-form-acoes">
      <button class="btn btn-ghost" id="lm-voltar">Voltar</button>
      <button class="btn btn-primary" id="lm-avancar">Continuar</button>
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-voltar").addEventListener("click", () => { lm.passo = 1; renderPeriodo(m); });
  wireExtrasInputs(m);
  m.querySelector("#lm-avancar").addEventListener("click", () => { lm.passo = 3; renderFinanceiro(m); });
}

// PASSO 3 — Financeiro (dados oficiais). Faturamento total é o único campo
// obrigatório de todo o fluxo — é ele que vira `valor_vendas_ifood`, a fonte
// oficial dos indicadores financeiros do Dashboard iFood.
function renderFinanceiro(m) {
  m.innerHTML = `
    ${cabecalhoPasso("Financeiro")}
    <p class="dex-form-info">Dados oficiais do mês. O faturamento total é obrigatório; o detalhamento das deduções é opcional. Digite o valor normalmente. Use vírgula para centavos.</p>
    <div class="cfg-form-grid">
      <label class="cfg-campo ed-campo-full"><span>Faturamento total do mês (R$) *</span>
        <input type="text" inputmode="decimal" data-moeda id="lm-valor" value="${valorMoedaInput(lm.valor)}" placeholder="R$ 0,00"></label>
      ${extrasInputsHtml("financeiro")}
    </div>
    <div class="ed-acoes dex-form-acoes">
      <button class="btn btn-ghost" id="lm-voltar">Voltar</button>
      <button class="btn btn-primary" id="lm-avancar">Ver conferência</button>
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-voltar").addEventListener("click", () => { lm.passo = 2; renderDesempenho(m); });
  aplicarMascaraMoeda(m.querySelector("#lm-valor"), { aoAlterar: (valor) => { lm.valor = valor; } });
  wireExtrasInputs(m);
  m.querySelector("#lm-avancar").addEventListener("click", () => avancarParaConferencia(m));
}

/** Monta o corpo do pedido: extras vazios viram `undefined` (omitidos), nunca 0. */
function payloadExtras() {
  const p = {};
  for (const { campo } of CAMPOS_EXTRAS) {
    const v = lm.extras[campo];
    p[campo] = v === "" || v == null ? undefined : (campoExtra(campo)?.tipo === "money" ? numeroDecimal(v) : Number(v));
  }
  return p;
}

function extrasSaoValidos(extras) {
  return CAMPOS_EXTRAS.every(({ campo, tipo }) => {
    const valor = extras[campo];
    if (valor === "" || valor == null) return true;
    const numero = tipo === "money" ? numeroDecimal(valor) : Number(valor);
    // Serviços e promoções aceita crédito (negativo, seletor "+").
    return Number.isFinite(numero) && (numero >= 0 || campo === CAMPO_SERVICOS) && (tipo !== "int" || Number.isInteger(numero));
  });
}

async function avancarParaConferencia(m) {
  if (!lm.valor || !Number.isFinite(numeroDecimal(lm.valor)) || numeroDecimal(lm.valor) <= 0) { toast("Informe um faturamento total válido."); return; }
  if (!extrasSaoValidos(lm.extras)) { toast("Revise os valores de desempenho e financeiro informados."); return; }
  const btn = m.querySelector("#lm-avancar");
  btn.disabled = true; btn.textContent = "Calculando…";
  try {
    const { data } = await dashExecPreviewLancamentoMensal({
      unidadeId: lm.unidadeId || undefined, mes: lm.mes, ano: lm.ano, valorTotalMensal: numeroDecimal(lm.valor),
      ...payloadExtras(),
    });
    lm.passo = 4;
    renderConferencia(m, data);
  } catch (e) {
    toast("Erro: " + e.message);
    btn.disabled = false; btn.textContent = "Ver conferência";
  }
}

/** Uma linha "rótulo -> valor formatado (ou 'Não informado')" pra um campo extra — usada na Conferência e no Gerenciamento, único formatador pros dois. */
function linhaExtraResumo(c, valorBruto) {
  const vazio = valorBruto === "" || valorBruto == null;
  const fmt = c.campo === CAMPO_SERVICOS ? fmtServicosPromocoes : fmtMoeda;
  const html = vazio ? `<span class="dex-lm-nao-informado">Não informado</span>` : (c.tipo === "money" ? fmt(numeroDecimal(valorBruto)) : String(Number(valorBruto)));
  return linhaResumo(ROTULO_EXTRA[c.campo], html);
}
/** Mesmo formatador "valor ou Não informado" acima, mas pro Ticket Médio (item 1/7 do pedido: nunca R$ 0,00 quando falta um dos dois lados). */
function ticketMedioResumoHtml(valor) {
  return valor == null ? `<span class="dex-lm-nao-informado">Não informado</span>` : fmtMoeda(valor);
}

// PASSO 4 — Conferência: mesma prévia que o backend já calculava
// (dashExecPreviewLancamentoMensal), só que agora em dois blocos separados
// e claramente rotulados — nunca uma lista só misturando os dois.
function renderConferencia(m, preview) {
  const temLancamentosExistentes = preview.diasComLancamento > 0;
  const extrasDesempenho = camposDoGrupo("desempenho");
  const extrasFinanceiro = camposDoGrupo("financeiro");
  m.innerHTML = `
    ${cabecalhoPasso(`Conferência — ${MESES[preview.mes - 1]}/${preview.ano}`)}
    ${temLancamentosExistentes ? `
      <div class="dex-avisos">
        <b>${icon("alert-triangle", { size: 13 })} Este mês já possui ${preview.diasComLancamento} lançamento(s) individual(is).</b>
        <p>Esses dias NÃO serão alterados. A distribuição vai preencher só os ${preview.diasParaDistribuir} dia(s) que ainda estão sem lançamento.</p>
      </div>` : ""}
    <div class="modal-sec-titulo">${icon("banknote", { size: 14 })} Financeiro <small>dados oficiais</small></div>
    <div class="dex-conf-grid">
      ${linhaResumo("Faturamento mensal informado", fmtMoeda(preview.valorTotalMensal))}
      ${linhaResumo("Dias que receberão distribuição", String(preview.diasParaDistribuir))}
      ${linhaResumo("Valor médio aproximado por dia", fmtMoeda(preview.valorMedioAproximado))}
      ${extrasFinanceiro.map((c) => linhaExtraResumo(c, lm.extras[c.campo])).join("")}
    </div>
    <div class="modal-sec-titulo">${icon("bar-chart", { size: 14 })} Desempenho <small>dados operacionais</small></div>
    <div class="dex-conf-grid">
      ${extrasDesempenho.length ? extrasDesempenho.map((c) => linhaExtraResumo(c, lm.extras[c.campo])).join("") : `<p class="dex-diag-vazio">Nenhum dado de Desempenho informado.</p>`}
      ${linhaResumo("Ticket médio do mês (calculado)", ticketMedioResumoHtml(ticketMedioPreview(lm.extras.valorVendasBrutoTotal, lm.extras.qtdVendasTotal)))}
    </div>
    <div class="dex-form-info">
      Esses valores serão registrados como <b>distribuição estimada de faturamento mensal</b> — não como faturamento diário real. A grade de lançamentos vai marcar esses dias como "Estimado".
    </div>
    <div class="ed-acoes dex-form-acoes">
      <button class="btn btn-ghost" id="lm-voltar">Voltar</button>
      <button class="btn btn-primary" id="lm-confirmar">Confirmar lançamento</button>
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-voltar").addEventListener("click", () => { lm.passo = 3; renderFinanceiro(m); });
  m.querySelector("#lm-confirmar").addEventListener("click", () => confirmar(m, preview));
}

async function confirmar(m, preview) {
  const btn = m.querySelector("#lm-confirmar");
  btn.disabled = true; btn.textContent = "Distribuindo…";
  // captura antes: fecharOverlay() zera `lm`
  const onSalvo = lm.onSalvo;
  const unidadeId = lm.unidadeId;
  const extras = payloadExtras();
  try {
    await dashExecConfirmarLancamentoMensal({ unidadeId: unidadeId || undefined, mes: preview.mes, ano: preview.ano, valorTotalMensal: preview.valorTotalMensal, ...extras });
    toast(`Faturamento de ${MESES[preview.mes - 1]}/${preview.ano} distribuído em ${preview.diasParaDistribuir} dia(s).`);
    fecharOverlay();
    onSalvo?.();
  } catch (e) {
    toast("Erro: " + e.message);
    btn.disabled = false; btn.textContent = "Confirmar lançamento";
  }
}

// ---------------------------------------------------------------------------
// GERENCIAMENTO — item 1/6/7 do pedido: ver o lançamento mensal ORIGINAL
// (não os dias distribuídos), com acesso a Editar e Excluir. Financeiro e
// Desempenho aparecem em blocos separados, mesma organização da Conferência.
// ---------------------------------------------------------------------------
function linhaResumo(rotulo, valorHtml) {
  return `<div class="dex-conf-item"><span>${escapeHtml(rotulo)}</span><b>${valorHtml}</b></div>`;
}

function renderGerenciamento(m) {
  const lote = lm.lote;
  const extrasDesempenho = camposDoGrupo("desempenho");
  const extrasFinanceiro = camposDoGrupo("financeiro");
  const rodape = [
    `Criado em ${fmtDataHora(lote.criadoEm)}${lote.criadoPor?.nome ? ` por ${escapeHtml(lote.criadoPor.nome)}` : ""}.`,
    lote.atualizadoPor ? `Última atualização em ${fmtDataHora(lote.atualizadoEm)} por ${escapeHtml(lote.atualizadoPor.nome ?? lote.atualizadoPor.email ?? "—")}.` : "",
  ].filter(Boolean).join(" ");

  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>${icon("calendar", { size: 17 })} Lançamento mensal — ${MESES[lote.mes - 1]}/${lote.ano}</h2></div>
    <p class="dex-form-info">Origem: <b>distribuição mensal</b> (<code>monthly_distribution</code>) — este é o lançamento original que gerou os ${lote.diasDistribuidos} dia(s) estimados na grade, não os valores diários em si.</p>
    <div class="modal-sec-titulo">${icon("banknote", { size: 14 })} Financeiro <small>dados oficiais</small></div>
    <div class="dex-conf-grid">
      ${linhaResumo("Faturamento mensal informado", fmtMoeda(lote.valorTotalMensal))}
      ${linhaResumo("Dias distribuídos", String(lote.diasDistribuidos))}
      ${linhaResumo("Valor médio por dia", fmtMoeda(lote.valorMedioAproximado))}
      ${extrasFinanceiro.map((c) => linhaExtraResumo(c, lote.extras[c.campo])).join("")}
    </div>
    <div class="modal-sec-titulo">${icon("bar-chart", { size: 14 })} Desempenho <small>dados operacionais</small></div>
    <div class="dex-conf-grid">
      ${extrasDesempenho.length ? extrasDesempenho.map((c) => linhaExtraResumo(c, lote.extras[c.campo])).join("") : `<p class="dex-diag-vazio">Nenhum dado de Desempenho informado.</p>`}
      ${linhaResumo("Ticket médio do mês (calculado)", ticketMedioResumoHtml(lote.ticketMedio))}
    </div>
    ${lote.camposPendentes.length ? `<div class="dex-avisos"><b>${icon("paperclip", { size: 13 })} Dados complementares pendentes:</b> ${lote.camposPendentes.map((c) => escapeHtml(ROTULO_EXTRA[c])).join(", ")}. Use "Editar" para completar sem refazer o lançamento.</div>` : ""}
    <p class="dex-form-info">${rodape}</p>
    <div class="ed-acoes dex-form-acoes">
      <button class="btn btn-ghost" id="lm-fechar">Fechar</button>
      ${podeEditarLote() ? `<button class="btn btn-ghost" id="lm-ir-editar">${icon("pencil", { size: 13 })} Editar / Atualizar lançamento</button>` : ""}
      ${podeExcluirLote() ? `<button class="btn btn-perigo" id="lm-ir-excluir">${icon("trash", { size: 13 })} Excluir lançamento mensal</button>` : ""}
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-fechar").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-ir-editar")?.addEventListener("click", () => renderEdicao(m));
  m.querySelector("#lm-ir-excluir")?.addEventListener("click", () => renderConfirmarExclusao(m));
}

// ---------------------------------------------------------------------------
// EDIÇÃO — item 2/3 do pedido: só substitui o que o usuário de fato editar.
// Campo deixado como estava (igual ao valor pré-preenchido) não é enviado —
// preserva o que já estava salvo, nunca vira zero nem some em silêncio.
// Mesma separação Financeiro/Desempenho das outras telas.
// ---------------------------------------------------------------------------
function renderEdicao(m) {
  const lote = lm.lote;
  if (!lm.edicao) {
    lm.edicao = {
      valorTotalMensal: lote.valorTotalMensal,
      extras: Object.fromEntries(CAMPOS_EXTRAS.map((c) => [c.campo, lote.extras[c.campo] ?? ""])),
      sinalServicos: sinalDoArmazenado(lote.extras[CAMPO_SERVICOS]),
    };
  }
  const ed = lm.edicao;
  const inputsExtras = (grupo) => camposDoGrupo(grupo).map((c) => inputExtraHtml(c, ed.extras, ed.sinalServicos)).join("");
  const ticket = ticketMedioPreview(ed.extras.valorVendasBrutoTotal, ed.extras.qtdVendasTotal);
  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>${icon("pencil", { size: 13 })} Editar lançamento mensal — ${MESES[lote.mes - 1]}/${lote.ano}</h2></div>
    <p class="dex-form-info">Só o que você alterar aqui é substituído — o resto continua exatamente como estava salvo. Deixar um campo como está (sem mexer) não apaga o valor dele.</p>
    <div class="modal-sec-titulo">${icon("banknote", { size: 14 })} Financeiro <small>dados oficiais</small></div>
    <div class="cfg-form-grid">
      <label class="cfg-campo ed-campo-full"><span>Faturamento total do mês (R$)</span>
        <input type="text" inputmode="decimal" data-moeda id="lm-ed-valor" value="${valorMoedaInput(ed.valorTotalMensal)}" placeholder="R$ 0,00"></label>
      ${inputsExtras("financeiro")}
    </div>
    <p class="dex-form-info">${icon("alert-triangle", { size: 13 })} Alterar o faturamento recalcula a distribuição pelos mesmos ${lote.diasDistribuidos} dia(s) já lançados — a soma continua batendo exatamente com o novo valor.</p>
    <div class="modal-sec-titulo">${icon("bar-chart", { size: 14 })} Desempenho <small>dados operacionais</small></div>
    <div class="cfg-form-grid">${inputsExtras("desempenho")}${campoTicketMedioHtml(ticket)}</div>
    <div class="ed-acoes dex-form-acoes">
      <button class="btn btn-ghost" id="lm-ed-cancelar">Cancelar</button>
      <button class="btn btn-primary" id="lm-ed-salvar">Salvar alterações</button>
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-ed-cancelar").addEventListener("click", () => { lm.edicao = null; renderGerenciamento(m); });
  aplicarMascaraMoeda(m.querySelector("#lm-ed-valor"), { aoAlterar: (valor) => { ed.valorTotalMensal = valor; } });
  wireExtrasInputsEdicao(m, ed);
  m.querySelector("#lm-ed-salvar").addEventListener("click", () => salvarEdicao(m));
}

function wireExtrasInputsEdicao(m, ed) {
  ligarInputsExtras(m, ed);
}

/** Só entra no patch o que MUDOU em relação ao valor salvo (`lm.lote`) — chave ausente = "não editei", preserva o que já estava lá. */
function payloadPatchExtras() {
  const lote = lm.lote;
  const p = {};
  for (const { campo } of CAMPOS_EXTRAS) {
    const valorForm = lm.edicao.extras[campo];
    const valorOriginal = lote.extras[campo];
    const tipo = campoExtra(campo)?.tipo;
    const formVazio = valorForm === "" || valorForm == null;
    const originalVazio = valorOriginal == null;
    const valorNormalizado = formVazio ? null : (tipo === "money" ? numeroDecimal(valorForm) : Number(valorForm));
    if ((formVazio && originalVazio) || (!formVazio && !originalVazio && valorNormalizado === Number(valorOriginal))) continue;
    p[campo] = valorForm === "" ? null : (tipo === "money" ? numeroDecimal(valorForm) : Number(valorForm)); // limpou de propósito -> null explícito; senão, novo valor
  }
  return p;
}

async function salvarEdicao(m) {
  const valorForm = lm.edicao.valorTotalMensal;
  if (!valorForm || !Number.isFinite(numeroDecimal(valorForm)) || numeroDecimal(valorForm) <= 0) { toast("Informe um faturamento total válido."); return; }
  if (!extrasSaoValidos(lm.edicao.extras)) { toast("Revise os valores de desempenho e financeiro informados."); return; }
  const patch = { valorTotalMensal: numeroDecimal(valorForm), ...payloadPatchExtras() };
  const btn = m.querySelector("#lm-ed-salvar");
  btn.disabled = true; btn.textContent = "Salvando…";
  const loteId = lm.lote.id;
  const onSalvo = lm.onSalvo;
  try {
    const { data } = await dashExecAtualizarLancamentoMensal(loteId, patch);
    lm.lote = data; lm.edicao = null;
    toast(`Lançamento mensal de ${MESES[data.mes - 1]}/${data.ano} atualizado.`);
    renderGerenciamento(m);
    onSalvo?.();
  } catch (e) {
    toast("Erro: " + e.message);
    btn.disabled = false; btn.textContent = "Salvar alterações";
  }
}

// ---------------------------------------------------------------------------
// EXCLUSÃO — item 4 do pedido: remove SÓ os dias gerados por este lote;
// lançamentos manuais no mesmo mês nunca são tocados (garantido no backend
// pelo vínculo distribuicao_mensal_id, não por comparação de valores).
// ---------------------------------------------------------------------------
function renderConfirmarExclusao(m) {
  const lote = lm.lote;
  const rotuloMes = `${MESES[lote.mes - 1]}/${lote.ano}`;
  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>${icon("trash", { size: 13 })} Excluir lançamento mensal — ${rotuloMes}</h2></div>
    <div class="dex-avisos dex-avisos-perigo">
      <p><b>Você está prestes a excluir o lançamento mensal de ${rotuloMes} e os valores diários estimados gerados por ele.</b></p>
      <div class="dex-conf-grid">
        ${linhaResumo("Faturamento lançado", fmtMoeda(lote.valorTotalMensal))}
        ${linhaResumo("Dias afetados", String(lote.diasDistribuidos))}
      </div>
      <p>Lançamentos manuais (reais) no mesmo mês <b>não são afetados</b> — só os dias criados por esta distribuição. O registro completo fica guardado no log de exclusões.</p>
    </div>
    <label class="cfg-campo ed-campo-full"><span>Motivo da exclusão (obrigatório) *</span>
      <input type="text" id="lm-excl-motivo" placeholder="Explique por que este lançamento está sendo apagado"></label>
    <div class="ed-acoes dex-form-acoes">
      <button class="btn btn-ghost" id="lm-excl-cancelar">Cancelar</button>
      <button class="btn btn-perigo" id="lm-excl-confirmar">Excluir lançamento</button>
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#lm-excl-cancelar").addEventListener("click", () => renderGerenciamento(m));
  m.querySelector("#lm-excl-confirmar").addEventListener("click", () => confirmarExclusaoLote(m));
}

async function confirmarExclusaoLote(m) {
  const motivo = m.querySelector("#lm-excl-motivo")?.value.trim() || "";
  if (motivo.length < 3) { toast("Informe o motivo da exclusão (mínimo 3 caracteres)."); return; }
  const btn = m.querySelector("#lm-excl-confirmar");
  const loteId = lm.lote.id;
  const unidadeId = lm.unidadeId; // captura antes: fecharOverlay() zera `lm`
  const onSalvo = lm.onSalvo;
  btn.disabled = true; btn.textContent = "Excluindo…";
  try {
    await dashExecExcluirLancamentoMensal(loteId, { unidadeId: unidadeId || undefined, motivo });
    toast("Lançamento mensal excluído.");
    fecharOverlay();
    onSalvo?.();
  } catch (e) {
    toast("Erro: " + e.message);
    btn.disabled = false; btn.textContent = "Excluir lançamento";
  }
}
