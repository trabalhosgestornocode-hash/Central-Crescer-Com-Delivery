// Formulário de lançamento diário do Dashboard Executivo — 5 etapas:
// Situação -> Desempenho -> Financeiro -> Conferência -> Finalização.
// Prévias client-side espelham as fórmulas do backend (dashboardExecutivo.calc.js)
// só para exibição; o valor autoritativo é sempre o que o servidor recalcula.
import { el, escapeHtml, toast, fmtMoeda, fmtPct } from "./utils.js";
import { pode } from "./sessao.js";
import {
  dashExecLancamento, dashExecCriarLancamento, dashExecAtualizarLancamento,
  dashExecPreviewResetTeste, dashExecConfirmarResetTeste, dashExecExcluirLancamento,
} from "./api.js";
import { icon } from "./icons.js";
import { aplicarMascaraMoeda, formatarMoedaBRL, numeroDecimal, numeroDecimalOuIndefinido } from "./numeroDecimal.js";

const MOTIVOS_SEM_OPERACAO = ["Folga", "Feriado", "Manutenção", "Problema operacional", "Falta de insumos", "Fechamento temporário", "Outro"];

// Situações em que a unidade OPEROU e teve vendas: "normal" e "parcial"
// ("Funcionou, parcialmente" — horário reduzido, cardápio limitado, etc.).
// Ambas percorrem exatamente o mesmo fluxo do formulário (etapas Desempenho +
// Financeiro, mesmas validações, mesmos totais). Só "sem_operacao"/"zero_vendas"
// zeram os campos e encurtam as etapas. Espelha situacaoOperou() em
// dashboardExecutivo.calc.js.
const SITUACOES_OPERACIONAIS = ["normal", "parcial"];
const situacaoOperou = (situacao) => SITUACOES_OPERACIONAIS.includes(situacao);
const valorMoedaInput = (valor) => escapeHtml(formatarMoedaBRL(valor));

let ov = null;
let fm = null;

function fecharOverlay() { ov?.remove(); ov = null; fm = null; document.removeEventListener("keydown", onEsc); }
function onEsc(e) { if (e.key === "Escape") fecharOverlay(); }
function abrirOverlay(html) {
  fecharOverlay();
  ov = document.createElement("div"); ov.className = "modal-overlay";
  ov.innerHTML = `<div class="modal dex-modal">${html}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) fecharOverlay(); });
  document.body.appendChild(ov); document.addEventListener("keydown", onEsc);
  return ov.querySelector(".modal");
}

function camposPadrao() {
  return {
    situacao: "normal", motivoSemOperacao: "", observacao: "",
    qtdVendas: "", valorVendasBruto: "", novosClientes: "",
    valorVendasIfood: "", taxasComissoes: "", servicosPromocoes: "", taxasEntregadores: "",
    ajustesFavorLoja: "", ajustesContraLoja: "",
  };
}

function camposDoLancamento(l) {
  return {
    situacao: l.situacao, motivoSemOperacao: l.motivoSemOperacao ?? "", observacao: l.observacao ?? "",
    // Desempenho é opcional: um valor null (não informado) vira campo VAZIO
    // no input, nunca "null" literal nem 0 — ver dashboardExecutivo.calc.js.
    qtdVendas: l.qtdVendas ?? "", valorVendasBruto: l.valorVendasBruto ?? "", novosClientes: l.novosClientes ?? "",
    // Financeiro TAMBÉM pode vir null agora — um rascunho de dia ≠ ontem
    // ainda não tem esse dado (ver dashboardExecutivo.service.js#normalizarDadosLancamento).
    valorVendasIfood: l.valorVendasIfood ?? "", taxasComissoes: l.taxasComissoes ?? "", servicosPromocoes: l.servicosPromocoes ?? "",
    taxasEntregadores: l.taxasEntregadores ?? "",
    ajustesFavorLoja: l.ajustesFavorLoja ?? "", ajustesContraLoja: l.ajustesContraLoja ?? "",
  };
}

// Full Service: a entrega é sempre feita pelo parceiro do iFood — não existe
// "taxas de entregadores da loja" nesse modelo (mesma regra de negócio de
// dashboardExecutivo.calc.js#INDICADORES_POR_MODELO, espelhada aqui só para
// exibição/validação do formulário).
function mostraEntregadores() {
  return fm.modeloLogistico !== "full_service";
}

export async function abrirLancamentoModal({ data, unidadeId, modeloLogistico, ehTeste, onSalvo }) {
  // abrirOverlay() fecha qualquer modal anterior (fecharOverlay zera `fm`) —
  // por isso o estado só é atribuído DEPOIS de abrir o overlay novo, nunca antes.
  const m = abrirOverlay(`<div class="estado"><div class="spinner"></div>Carregando…</div>`);
  fm = {
    data, unidadeId, modeloLogistico, ehTeste: !!ehTeste, onSalvo, passo: 1,
    modoCorrecao: false, lancamentoId: null, statusOriginal: null, atualizadoEm: null,
    // Etapa 2 (Realtime) — true quando ESTE MESMO lançamento foi alterado em
    // outro dispositivo/sessão enquanto o formulário estava aberto aqui
    // (ver avisarAlteracaoExterna, chamado pelo registro em dashboardExecutivo.js).
    conflitoExterno: false,
    motivoCorrecao: "", campos: camposPadrao(), avisos: [], confirmarAvisos: false, salvando: false,
    // Autoridade é sempre o servidor (ver obterLancamentoPorData/financeiroDisponivelNaData
    // no backend) — valores por omissão aqui só cobrem o instante antes da
    // resposta chegar, nunca usados pra decidir nada sozinhos.
    mostrarFinanceiro: true, periodoFinanceiroInicio: data, periodoFinanceiroFim: data,
  };
  try {
    const resp = await carregarLancamentoNoFormulario();
    if (!resp.lancamento && !resp.disponibilidade.disponivel) {
      renderIndisponivel(m, resp.disponibilidade.motivo);
      return;
    }
    // Reabrir um rascunho (item novo): pula direto pra primeira etapa que
    // ainda falta algo obrigatório, sem obrigar reconferir o que já foi
    // preenchido — mas o usuário sempre pode "Voltar" pra revisar antes.
    if (fm.statusOriginal === "rascunho") fm.passo = primeiroPassoIncompletoIndex();
    renderPasso(m);
  } catch (e) {
    renderIndisponivel(m, e.message);
  }
}

/**
 * Busca o lançamento (ou a disponibilidade do dia) e aplica em `fm` — usado
 * na abertura do formulário e, de novo, quando o usuário pede pra recarregar
 * depois de um conflito (dados alterados em outro dispositivo/sessão, ver
 * avisoConflitoExterno/recarregarDadosDoServidor). Nunca decide layout aqui
 * (isso fica com quem chamou) — só aplica o que o servidor respondeu.
 */
async function carregarLancamentoNoFormulario() {
  const { data: resp } = await dashExecLancamento(fm.data, { unidadeId: fm.unidadeId || undefined });
  fm.mostrarFinanceiro = resp.mostrarFinanceiro;
  fm.periodoFinanceiroInicio = resp.periodoFinanceiroInicio;
  fm.periodoFinanceiroFim = resp.periodoFinanceiroFim;
  if (resp.lancamento) {
    fm.lancamentoId = resp.lancamento.id;
    fm.statusOriginal = resp.lancamento.status;
    fm.atualizadoEm = resp.lancamento.updatedAt ?? null;
    fm.modoCorrecao = resp.lancamento.status === "finalizado";
    fm.campos = camposDoLancamento(resp.lancamento);
  }
  return resp;
}

/**
 * Primeira etapa ainda incompleta de um rascunho reaberto (item novo do
 * pedido). Só considera o que é de fato OBRIGATÓRIO pra finalizar — Desempenho
 * é sempre opcional (nunca "trava" a navegação, mesmo parcialmente
 * preenchido), então nunca é o alvo. Sem nada pendente, abre na Conferência
 * (o lançamento já está pronto pra revisar e finalizar).
 */
function primeiroPassoIncompletoIndex() {
  const passos = passosAtivos();
  const c = fm.campos;
  if (c.situacao === "sem_operacao" && !c.motivoSemOperacao) return passos.indexOf("situacao") + 1;
  if (passos.includes("financeiro") && situacaoOperou(c.situacao) && c.valorVendasIfood === "") return passos.indexOf("financeiro") + 1;
  return passos.length;
}

function renderIndisponivel(m, motivo) {
  m.innerHTML = `<button class="modal-close" aria-label="Fechar">×</button>
    <div class="estado erro"><span class="estado-ic">${icon("lock", { size: 22 })}</span><h3>Dia indisponível</h3><p>${escapeHtml(motivo)}</p></div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
}

// ---------------------------------------------------------------------------
// RESET DE DIA (SÓ EM UNIDADE DE TESTE) — troca o corpo do modal pra uma tela
// de confirmação separada do fluxo normal de edição/correção. O botão que
// leva aqui (renderPasso) só aparece quando fm.ehTeste — mas quem garante de
// verdade é o backend (revalida eh_teste a cada chamada).
// ---------------------------------------------------------------------------
async function renderResetPreview(m) {
  m.innerHTML = `<button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>${icon("flask", { size: 17 })} Resetar dia para teste</h2></div>
    <div class="estado"><div class="spinner"></div>Verificando lançamentos…</div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  try {
    const { data } = await dashExecPreviewResetTeste(fm.unidadeId, fm.data);
    renderResetConfirmacao(m, data);
  } catch (e) {
    m.innerHTML = `<button class="modal-close" aria-label="Fechar">×</button>
      <div class="estado erro"><span class="estado-ic">${icon("alert-triangle", { size: 22 })}</span><h3>Não foi possível resetar</h3><p>${escapeHtml(e.message)}</p></div>`;
    m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  }
}

function renderResetConfirmacao(m, preview) {
  const datas = preview.lancamentos.map((l) => l.data);
  const multiplos = datas.length > 1;
  const corpo = multiplos
    ? `<p><b>RESETAR LANÇAMENTOS DE TESTE</b></p>
       <p>Ao resetar ${fmtDataBr(preview.dataAlvo)}, os seguintes lançamentos posteriores também precisarão ser removidos — isso é necessário para preservar a ordem sequencial:</p>
       <ul class="dex-reset-lista">${datas.map((d) => `<li>${fmtDataBr(d)}</li>`).join("")}</ul>`
    : `<p><b>RESETAR DIA PARA TESTE</b></p>
       <p>Você está prestes a remover o lançamento de ${fmtDataBr(preview.dataAlvo)}. Após o reset, essa data volta a aparecer como pendente.</p>`;

  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>${icon("flask", { size: 17 })} Resetar dia para teste</h2></div>
    <div class="dex-avisos dex-avisos-perigo">${corpo}</div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="dex-reset-cancelar">Cancelar</button>
      <button class="btn btn-perigo" id="dex-reset-confirmar">${multiplos ? "Resetar a partir desta data" : "Resetar dia"}</button>
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#dex-reset-cancelar").addEventListener("click", fecharOverlay);
  m.querySelector("#dex-reset-confirmar").addEventListener("click", () => confirmarReset(m, preview.dataAlvo));
}

async function confirmarReset(m, dataAlvo) {
  const btn = m.querySelector("#dex-reset-confirmar");
  const unidadeId = fm.unidadeId; // captura antes: fecharOverlay() zera `fm`
  const onSalvo = fm.onSalvo;
  btn.disabled = true; btn.textContent = "Resetando…";
  try {
    await dashExecConfirmarResetTeste(unidadeId, dataAlvo);
    toast("Lançamento(s) resetado(s) para teste.");
    fecharOverlay();
    onSalvo?.();
  } catch (e) {
    toast("Erro: " + e.message);
    btn.disabled = false; btn.textContent = "Resetar dia";
  }
}

const TITULOS_PASSO = {
  situacao: "Situação da operação", desempenho: "Desempenho (opcional)",
  financeiro: "Financeiro", conferencia: "Conferência",
};
const CORPO_PASSO = {
  situacao: passoSituacao, desempenho: passoDesempenho, financeiro: passoFinanceiro, conferencia: passoConferencia,
};

// Lista de etapas ATIVAS pra este lançamento — muda com a situação (radio da
// etapa 1) e com `fm.mostrarFinanceiro` (decidido pelo servidor, ver
// abrirLancamentoModal). Financeiro só entra pras situações operacionais
// ("normal"/"parcial") quando a data lançada é ontem (ou já tem snapshot
// salvo); pras demais situações (sem_operacao/zero_vendas) continua sempre
// presente — comportamento inalterado, fora do escopo deste ajuste.
function passosAtivos() {
  const passos = ["situacao", "desempenho"];
  if (!situacaoOperou(fm.campos.situacao) || fm.mostrarFinanceiro) passos.push("financeiro");
  passos.push("conferencia");
  return passos;
}

function renderPasso(m) {
  const passos = passosAtivos();
  // Nunca deixa `fm.passo` apontar além do fim (pode acontecer se o usuário
  // trocou a situação numa sessão em que financeiro ainda contava como etapa).
  if (fm.passo > passos.length) fm.passo = passos.length;
  const chave = passos[fm.passo - 1];
  const corpo = CORPO_PASSO[chave];

  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head">
      <h2>${icon("calendar", { size: 17 })} Lançamento diário — ${fmtDataBr(fm.data)}</h2>
      <div class="modal-tags">
        <span class="chip">Etapa ${fm.passo}/${passos.length} · ${TITULOS_PASSO[chave]}</span>
        ${fm.modoCorrecao ? `<span class="chip chip-unidade">Correção de lançamento finalizado</span>` : ""}
      </div>
      ${fm.ehTeste && fm.lancamentoId ? `<button class="btn btn-ghost btn-sm dex-btn-reset-teste" id="dex-abrir-reset-teste" type="button">${icon("flask", { size: 13 })} Resetar dia para teste</button>` : ""}
      ${podeExcluir() && fm.lancamentoId ? `<button class="btn btn-ghost btn-sm dex-btn-excluir" id="dex-abrir-exclusao" type="button">${icon("trash", { size: 13 })} Excluir lançamento</button>` : ""}
    </div>
    ${avisoConflitoExterno()}
    ${fm.statusOriginal === "rascunho" ? avisoRascunhoAnterior() : ""}
    <div class="dex-stepper">${passos.map((_, i) => `<span class="dex-step ${i + 1 === fm.passo ? "ativo" : i + 1 < fm.passo ? "feito" : ""}">${i + 1}</span>`).join("")}</div>
    <div class="dex-form-corpo">${corpo()}</div>
    <div class="ed-acoes dex-form-acoes">
      ${fm.passo > 1 ? `<button class="btn btn-ghost" id="dex-f-voltar">Voltar</button>` : `<button class="btn btn-ghost" id="dex-f-cancelar">Cancelar</button>`}
      ${!fm.modoCorrecao ? `<button class="btn btn-ghost" id="dex-f-rascunho">Salvar como rascunho</button>` : ""}
      ${fm.passo < passos.length ? `<button class="btn btn-primary" id="dex-f-avancar">Avançar</button>` : botaoUltimoPasso()}
    </div>`;

  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#dex-f-cancelar")?.addEventListener("click", fecharOverlay);
  m.querySelector("#dex-f-voltar")?.addEventListener("click", () => { fm.passo--; renderPasso(m); });
  m.querySelector("#dex-f-avancar")?.addEventListener("click", () => { if (validarPassoAtual(m)) { fm.passo++; renderPasso(m); } });
  m.querySelector("#dex-abrir-reset-teste")?.addEventListener("click", () => renderResetPreview(m));
  m.querySelector("#dex-abrir-exclusao")?.addEventListener("click", () => renderExclusaoConfirmacao(m));
  m.querySelector("#dex-recarregar-conflito")?.addEventListener("click", () => recarregarDadosDoServidor(m));
  wirePasso(m, chave);
  // Sempre wireia (não só na Conferência): "Salvar como rascunho" agora
  // aparece em toda etapa (item novo do pedido) — os handlers usam `?.`,
  // então não fazem nada nas etapas onde o botão correspondente não existe.
  wireFinalizacao(m);
}

/** Discreto — item novo: "Rascunho salvo anteriormente" + última atualização, se houver. */
function avisoRascunhoAnterior() {
  const quando = fm.atualizadoEm ? fmtDataHoraBr(fm.atualizadoEm) : null;
  return `<p class="dex-form-info dex-rascunho-aviso">${icon("pencil", { size: 13 })} Rascunho salvo anteriormente.${quando ? ` Última atualização: ${quando}.` : ""}</p>`;
}

// ---------------------------------------------------------------------------
// CONFLITO EXTERNO (Etapa 2 — Realtime) — este MESMO lançamento foi alterado
// em outro dispositivo/sessão enquanto o formulário estava aberto aqui.
// Nunca sobrescreve o que o usuário está digitando: só avisa, com uma ação
// explícita pra recarregar antes de continuar.
// ---------------------------------------------------------------------------

/**
 * Chamado pelo registro Realtime do Dashboard (dashboardExecutivo.js) —
 * nunca por conta própria. Não faz nada se não há formulário aberto para
 * ESTA entidade (a maioria das chamadas: outro lançamento, outra unidade).
 * @param {string|undefined} entidadeId — o `entidadeId` do evento recebido.
 */
export function avisarAlteracaoExterna(entidadeId) {
  if (!fm || !entidadeId || fm.lancamentoId !== entidadeId || fm.conflitoExterno) return;
  fm.conflitoExterno = true;
  const m = ov?.querySelector(".modal");
  // Re-render normal: usa fm.campos (os valores que o usuário já digitou),
  // só acrescenta o aviso — nada do que ele estava preenchendo se perde.
  if (m) renderPasso(m);
}

function avisoConflitoExterno() {
  if (!fm.conflitoExterno) return "";
  return `<div class="dex-form-conflito" role="alert">
    ${icon("alert-triangle", { size: 14 })}
    <span>Este lançamento foi atualizado em outro dispositivo ou sessão. Os dados exibidos podem estar desatualizados. Atualize o lançamento antes de salvar novamente.</span>
    <button class="btn btn-ghost btn-sm" id="dex-recarregar-conflito" type="button">Atualizar dados</button>
  </div>`;
}

/** Ação do botão do aviso acima — descarta o que estava no formulário e
 * recarrega do servidor (mesmo caminho de abrir o formulário). Item do
 * pedido: "ofereça uma ação para atualizar/recarregar os dados". */
async function recarregarDadosDoServidor(m) {
  try {
    await carregarLancamentoNoFormulario();
    fm.conflitoExterno = false;
    if (fm.statusOriginal === "rascunho") fm.passo = primeiroPassoIncompletoIndex();
    toast("Dados atualizados.");
    renderPasso(m);
  } catch (e) {
    toast("Erro ao atualizar: " + e.message);
  }
}

const podeExcluir = () => pode("dashboard_executivo.excluir");

// ---------------------------------------------------------------------------
// EXCLUSÃO UNIVERSAL (real ou teste) — só administrador. Sempre pede motivo,
// sempre confirma antes de apagar de verdade.
// ---------------------------------------------------------------------------
function renderExclusaoConfirmacao(m) {
  const c = fm.campos;
  const resumo = situacaoOperou(c.situacao)
    ? `Valor das vendas (iFood): ${fmtMoeda(numeroDecimal(c.valorVendasIfood))}`
    : c.situacao === "sem_operacao" ? "Sem operação" : "Zero vendas";
  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>${icon("trash", { size: 17 })} Excluir lançamento — ${fmtDataBr(fm.data)}</h2></div>
    <div class="dex-avisos dex-avisos-perigo">
      <p><b>Esta ação apaga o lançamento deste dia definitivamente.</b></p>
      <div class="dex-conf-grid">
        <div class="dex-conf-item"><span>Data</span><b>${fmtDataBr(fm.data)}</b></div>
        <div class="dex-conf-item"><span>Situação</span><b>${escapeHtml(resumo)}</b></div>
      </div>
      <p>O registro completo fica guardado no log de exclusões (com seu usuário e o motivo abaixo) — mas o lançamento em si sai da grade e dos totais do mês.</p>
    </div>
    <label class="cfg-campo ed-campo-full"><span>Motivo da exclusão (obrigatório) *</span>
      <input type="text" id="dex-excl-motivo" placeholder="Explique por que este lançamento está sendo apagado"></label>
    <div class="ed-acoes dex-form-acoes">
      <button class="btn btn-ghost" id="dex-excl-cancelar">Cancelar</button>
      <button class="btn btn-perigo" id="dex-excl-confirmar">Excluir definitivamente</button>
    </div>`;
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#dex-excl-cancelar").addEventListener("click", () => renderPasso(m));
  m.querySelector("#dex-excl-confirmar").addEventListener("click", () => confirmarExclusao(m));
}

async function confirmarExclusao(m) {
  const motivo = m.querySelector("#dex-excl-motivo")?.value.trim() || "";
  if (motivo.length < 3) { toast("Informe o motivo da exclusão (mínimo 3 caracteres)."); return; }
  const btn = m.querySelector("#dex-excl-confirmar");
  const lancamentoId = fm.lancamentoId;
  const unidadeId = fm.unidadeId; // captura antes: fecharOverlay() zera `fm`
  const onSalvo = fm.onSalvo;
  btn.disabled = true; btn.textContent = "Excluindo…";
  try {
    await dashExecExcluirLancamento(lancamentoId, { unidadeId: unidadeId || undefined, motivo });
    toast("Lançamento excluído.");
    fecharOverlay();
    onSalvo?.();
  } catch (e) {
    toast("Erro: " + e.message);
    btn.disabled = false; btn.textContent = "Excluir definitivamente";
  }
}

// "Salvar como rascunho" mudou de lugar — vive direto no template de
// `renderPasso` agora (aparece em TODA etapa, item novo do pedido). Esta
// função cuida só do botão da ÚLTIMA etapa (Finalizar/Salvar correção).
function botaoUltimoPasso() {
  // Financeiro só é OBRIGATÓRIO pra finalizar quando a etapa está disponível
  // (`fm.mostrarFinanceiro` — dia elegível ou já com snapshot salvo, ver
  // financeiroDisponivelNaData no backend). Nos demais dias, Situação (+
  // Desempenho opcional) já é suficiente pra finalizar — bug real corrigido:
  // antes o botão "Finalizar" nem aparecia fora do dia elegível, então TODO
  // dia normal virava rascunho e travava a sequência em cascata (o backend
  // já aceitava finalizar sem financeiro nesse caso; só o frontend nunca
  // oferecia o botão). Quando o Financeiro é elegível, ainda exige o campo
  // principal preenchido antes de habilitar — evita um round-trip óbvio; os
  // demais campos ficam a cargo da validação do servidor (autoridade final).
  const financeiroExigidoEPreenchido = !fm.mostrarFinanceiro || fm.campos.valorVendasIfood !== "";
  const podeFinalizar = !situacaoOperou(fm.campos.situacao) || financeiroExigidoEPreenchido;
  return podeFinalizar
    ? `<button class="btn btn-primary" id="dex-f-finalizar">${fm.modoCorrecao ? "Salvar correção" : "Finalizar lançamento"}</button>`
    : "";
}

// ---------------------------------------------------------------------------
// ETAPA 1 — SITUAÇÃO
// ---------------------------------------------------------------------------
function passoSituacao() {
  const c = fm.campos;
  return `
    <p class="dex-form-pergunta">A unidade funcionou normalmente neste dia?</p>
    <div class="dex-radios">
      <label class="dex-radio"><input type="radio" name="situacao" value="normal" ${c.situacao === "normal" ? "checked" : ""}> Sim, funcionou normalmente</label>
      <label class="dex-radio"><input type="radio" name="situacao" value="sem_operacao" ${c.situacao === "sem_operacao" ? "checked" : ""}> Não funcionou</label>
      <label class="dex-radio"><input type="radio" name="situacao" value="zero_vendas" ${c.situacao === "zero_vendas" ? "checked" : ""}> Funcionou, mas não teve vendas</label>
      <label class="dex-radio"><input type="radio" name="situacao" value="parcial" ${c.situacao === "parcial" ? "checked" : ""}> Funcionou, parcialmente</label>
    </div>
    <div id="dex-sem-op" ${c.situacao === "sem_operacao" ? "" : "hidden"}>
      <label class="cfg-campo"><span>Motivo *</span>
        <select id="dex-motivo">${MOTIVOS_SEM_OPERACAO.map((mo) => `<option ${c.motivoSemOperacao === mo ? "selected" : ""}>${mo}</option>`).join("")}</select>
      </label>
    </div>
    <label class="cfg-campo"><span>Observação (opcional)</span><input type="text" id="dex-obs" value="${escapeHtml(c.observacao)}"></label>`;
}

// ---------------------------------------------------------------------------
// ETAPA 2 — DESEMPENHO
// ---------------------------------------------------------------------------
function passoDesempenho() {
  const c = fm.campos;
  if (!situacaoOperou(c.situacao)) {
    return `<p class="dex-form-info">Situação "${c.situacao === "sem_operacao" ? "Sem operação" : "Zero vendas"}" — os campos de desempenho e financeiro ficam zerados automaticamente.</p>`;
  }
  const ticket = ticketMedioPreview(c);
  const inicioMes = `${fm.data.slice(0, 8)}01`;
  return `
    <p class="dex-form-info">${icon("bar-chart", { size: 13 })} Desempenho acumulado do mês até aqui — informe o TOTAL desde ${fmtDataBr(inicioMes)} até ${fmtDataBr(fm.data)} (não só o que esse dia fez sozinho). O sistema calcula automaticamente quanto cada dia rendeu por conta própria, pela diferença com o acumulado do dia anterior. Preencha caso tenha acesso às informações — nada aqui é obrigatório: o que ficar em branco fica registrado como "não informado", nunca como zero.</p>
    <div class="cfg-form-grid">
      <label class="cfg-campo"><span>Quantidade de vendas acumulada no mês</span><input type="number" min="0" step="1" id="dex-qtd" value="${c.qtdVendas}" placeholder="Não informado"></label>
      <label class="cfg-campo"><span>Valor bruto acumulado no mês (R$)</span><input type="text" inputmode="decimal" data-moeda id="dex-valorbruto" value="${valorMoedaInput(c.valorVendasBruto)}" placeholder="R$ 0,00"></label>
      <label class="cfg-campo"><span>Novos clientes acumulados no mês</span><input type="number" min="0" step="1" id="dex-novos" value="${c.novosClientes}" placeholder="Não informado"></label>
      <label class="cfg-campo"><span>Ticket médio (mês até aqui, calculado)</span><input type="text" value="${ticket == null ? "—" : fmtMoeda(ticket)}" disabled></label>
    </div>`;
}

/** Ticket médio só existe quando os DOIS lados são conhecidos — nunca finge
 * "R$ 0,00" quando falta um dos dois (ver dashboardExecutivo.calc.js#ticketMedio). */
function ticketMedioPreview(c) {
  if (c.qtdVendas === "" || c.valorVendasBruto === "") return null;
  const q = Number(c.qtdVendas);
  const v = numeroDecimal(c.valorVendasBruto);
  return q > 0 ? v / q : null;
}

// ---------------------------------------------------------------------------
// ETAPA 3 — FINANCEIRO
// ---------------------------------------------------------------------------
function passoFinanceiro() {
  const c = fm.campos;
  if (!situacaoOperou(c.situacao)) return `<p class="dex-form-info">Sem valores financeiros para esta situação.</p>`;
  const calc = calculoPreview(c);
  const mostrarEntreg = mostraEntregadores();
  return `
    <p class="dex-form-info">${icon("calendar", { size: 13 })} Financeiro acumulado do mês até aqui — dados consolidados de ${fmtDataBr(fm.periodoFinanceiroInicio)} até ${fmtDataBr(fm.periodoFinanceiroFim)}, o extrato que o iFood libera hoje. Digite o valor normalmente. Use vírgula para centavos.</p>
    <div class="cfg-form-grid">
      <label class="cfg-campo"><span>Valor das vendas no financeiro do iFood (R$) *</span><input type="text" inputmode="decimal" data-moeda id="dex-vifood" value="${valorMoedaInput(c.valorVendasIfood)}" placeholder="R$ 0,00"></label>
      <label class="cfg-campo"><span>Taxas e comissões (R$) *</span><input type="text" inputmode="decimal" data-moeda id="dex-taxas" value="${valorMoedaInput(c.taxasComissoes)}" placeholder="R$ 0,00"></label>
      <label class="cfg-campo"><span>Serviços e promoções (R$) *</span><input type="text" inputmode="decimal" data-moeda id="dex-servicos" value="${valorMoedaInput(c.servicosPromocoes)}" placeholder="R$ 0,00"></label>
      ${mostrarEntreg
        ? `<label class="cfg-campo"><span>Taxas de entregadores da loja (R$) *</span><input type="text" inputmode="decimal" data-moeda id="dex-entregadores" value="${valorMoedaInput(c.taxasEntregadores)}" placeholder="R$ 0,00"></label>`
        : `<p class="dex-form-info dex-form-na">${icon("truck", { size: 13 })} Este modelo (Full Service) não usa entregador próprio — a entrega é feita pelo parceiro do iFood, então não há "taxas de entregadores da loja" a lançar.</p>`}
      <label class="cfg-campo"><span>Ajustes a favor da loja (R$)</span>
        <input type="text" inputmode="decimal" data-moeda id="dex-aj-favor" value="${valorMoedaInput(c.ajustesFavorLoja)}" placeholder="R$ 0,00">
        <small class="cfg-campo-ajuda">Créditos, reembolsos ou correções que aumentam o valor recebido pela loja.</small></label>
      <label class="cfg-campo"><span>Ajustes contra a loja (R$)</span>
        <input type="text" inputmode="decimal" data-moeda id="dex-aj-contra" value="${valorMoedaInput(c.ajustesContraLoja)}" placeholder="R$ 0,00">
        <small class="cfg-campo-ajuda">Débitos, descontos ou correções que reduzem o valor recebido pela loja.</small></label>
    </div>
    <div class="dex-calc-preview">
      <div><span>% Taxas e comissões</span><b data-prev="taxas">${fmtPct(calc.pctTaxas)}</b></div>
      <div><span>% Serviços e promoções</span><b data-prev="servicos">${fmtPct(calc.pctServicos)}</b></div>
      ${mostrarEntreg ? `<div><span>% Taxas de entregadores</span><b data-prev="entregadores">${fmtPct(calc.pctEntregadores)}</b></div>` : ""}
      <div><span>Total de deduções</span><b data-prev="total">${fmtMoeda(calc.totalDed)}</b></div>
      <div><span>% Total de deduções</span><b data-prev="pctTotal">${fmtPct(calc.pctTotal)}</b></div>
      <div class="destaque"><span>Receita líquida</span><b data-prev="receita">${fmtMoeda(calc.receita)}</b></div>
    </div>`;
}

function calculoPreview(c) {
  const base = numeroDecimal(c.valorVendasIfood) || 0;
  const taxas = numeroDecimal(c.taxasComissoes) || 0;
  const servicos = numeroDecimal(c.servicosPromocoes) || 0;
  const entreg = numeroDecimal(c.taxasEntregadores) || 0;
  const ajFavor = numeroDecimal(c.ajustesFavorLoja) || 0;
  const ajContra = numeroDecimal(c.ajustesContraLoja) || 0;
  // Só o ajuste CONTRA entra no total de deduções; o a favor soma de volta na receita.
  const totalDed = taxas + servicos + entreg + ajContra;
  const pct = (v) => (base > 0 ? (v / base) * 100 : null);
  return {
    pctTaxas: pct(taxas), pctServicos: pct(servicos), pctEntregadores: pct(entreg),
    totalDed, pctTotal: pct(totalDed), receita: base - totalDed + ajFavor,
  };
}

// ---------------------------------------------------------------------------
// ETAPA 4 — CONFERÊNCIA
// ---------------------------------------------------------------------------
function passoConferencia() {
  const c = fm.campos;
  const linha = (l, v) => `<div class="dex-conf-item"><span>${l}</span><b>${v}</b></div>`;
  if (!situacaoOperou(c.situacao)) {
    fm.avisos = [];
    return `
      <div class="dex-conf-grid">
        ${linha("Situação", c.situacao === "sem_operacao" ? "Sem operação" : "Zero vendas")}
        ${c.situacao === "sem_operacao" ? linha("Motivo", escapeHtml(c.motivoSemOperacao)) : ""}
        ${linha("Observação", escapeHtml(c.observacao || "—"))}
      </div>
      ${fm.modoCorrecao ? campoMotivoCorrecao() : ""}`;
  }

  // Financeiro não fez parte deste lançamento (dia ≠ ontem, sem snapshot
  // salvo) — nunca mostra os campos financeiros vazios/zerados. Isso NÃO
  // impede finalizar: o Financeiro do iFood é um snapshot acumulado do mês,
  // não uma pendência de cada dia (ver migration 036) — Situação + Desempenho
  // já bastam pra este dia virar "Preenchido" e liberar o próximo.
  if (!fm.mostrarFinanceiro) {
    fm.avisos = [];
    return `
      <div class="dex-conf-grid">
        ${linha("Quantidade de vendas (acumulado no mês)", c.qtdVendas === "" ? "—" : c.qtdVendas)}
        ${linha("Novos clientes (acumulado no mês)", c.novosClientes === "" ? "—" : c.novosClientes)}
        ${linha("Vendas brutas (acumulado no mês)", fmtMoeda(numeroDecimal(c.valorVendasBruto)))}
        ${linha("Ticket médio (mês até aqui)", fmtMoeda(ticketMedioPreview(c)))}
      </div>
      <p class="dex-form-info">${icon("banknote", { size: 13 })} Financeiro ainda não disponível para esta data — o iFood só consolida com 1 dia
      de atraso. Você pode finalizar este dia normalmente com os dados acima; quando esta data virar "ontem", volte
      aqui para completar o Financeiro (o registro atual não precisa ser desfeito).</p>
      ${fm.modoCorrecao ? campoMotivoCorrecao() : ""}`;
  }

  const avisos = calcularAvisos(c);
  fm.avisos = avisos;
  const calc = calculoPreview(c);
  return `
    <div class="dex-conf-grid">
      ${linha("Quantidade de vendas", c.qtdVendas === "" ? "—" : c.qtdVendas)}
      ${linha("Novos clientes", c.novosClientes === "" ? "—" : c.novosClientes)}
      ${linha("Vendas brutas", fmtMoeda(numeroDecimal(c.valorVendasBruto)))}
      ${linha("Ticket médio", fmtMoeda(ticketMedioPreview(c)))}
      ${linha("Valor das vendas (iFood)", fmtMoeda(numeroDecimal(c.valorVendasIfood)))}
      ${linha("Taxas e comissões", `${fmtMoeda(numeroDecimal(c.taxasComissoes))} (${fmtPct(calc.pctTaxas)})`)}
      ${linha("Serviços e promoções", `${fmtMoeda(numeroDecimal(c.servicosPromocoes))} (${fmtPct(calc.pctServicos)})`)}
      ${mostraEntregadores() ? linha("Taxas de entregadores", `${fmtMoeda(numeroDecimal(c.taxasEntregadores))} (${fmtPct(calc.pctEntregadores)})`) : ""}
      ${linha("Ajustes a favor da loja", fmtMoeda(numeroDecimal(c.ajustesFavorLoja)))}
      ${linha("Ajustes contra a loja", fmtMoeda(numeroDecimal(c.ajustesContraLoja)))}
      ${linha("Total de deduções", `${fmtMoeda(calc.totalDed)} (${fmtPct(calc.pctTotal)})`)}
      ${linha("Receita líquida", fmtMoeda(calc.receita))}
    </div>
    ${avisos.length ? `
      <div class="dex-avisos">
        <b>${icon("alert-triangle", { size: 13 })} Inconsistências encontradas:</b>
        <ul>${avisos.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>
        <label class="dex-radio"><input type="checkbox" id="dex-confirmar-avisos" ${fm.confirmarAvisos ? "checked" : ""}> Estou ciente e confirmo os valores mesmo assim.</label>
      </div>` : ""}
    ${fm.modoCorrecao ? campoMotivoCorrecao() : ""}`;
}

function campoMotivoCorrecao() {
  return `<label class="cfg-campo ed-campo-full dex-motivo-correcao"><span>Motivo da correção (obrigatório) *</span>
    <input type="text" id="dex-motivo-correcao" value="${escapeHtml(fm.motivoCorrecao)}" placeholder="Explique por que este lançamento finalizado está sendo alterado"></label>`;
}

function calcularAvisos(c) {
  if (!situacaoOperou(c.situacao)) return [];
  const avisos = [];
  const q = Number(c.qtdVendas) || 0;
  const v = numeroDecimal(c.valorVendasBruto) || 0;
  if (v > 0 && q === 0) avisos.push("Há valor de vendas informado, mas a quantidade de vendas está zerada.");
  if (q > 0 && v === 0) avisos.push("Há quantidade de vendas informada, mas o valor bruto está zerado.");
  const calc = calculoPreview(c);
  if (calc.totalDed > (numeroDecimal(c.valorVendasIfood) || 0)) avisos.push("O total de deduções ultrapassa o valor das vendas do iFood.");
  return avisos;
}

// ---------------------------------------------------------------------------
// LEITURA DOS CAMPOS DO DOM -> fm.campos
// ---------------------------------------------------------------------------
function wirePasso(m, chave) {
  if (chave === "situacao") {
    m.querySelectorAll('input[name="situacao"]').forEach((r) => r.addEventListener("change", (e) => {
      fm.campos.situacao = e.target.value;
      m.querySelector("#dex-sem-op").hidden = e.target.value !== "sem_operacao";
    }));
    m.querySelector("#dex-motivo")?.addEventListener("change", (e) => { fm.campos.motivoSemOperacao = e.target.value; });
    m.querySelector("#dex-obs")?.addEventListener("input", (e) => { fm.campos.observacao = e.target.value; });
  }
  if (chave === "desempenho" && situacaoOperou(fm.campos.situacao)) {
    const bind = (id, campo) => m.querySelector(id)?.addEventListener("input", (e) => { fm.campos[campo] = e.target.value; atualizarPreviewTicket(m); });
    bind("#dex-qtd", "qtdVendas"); bind("#dex-novos", "novosClientes");
    aplicarMascaraMoeda(m.querySelector("#dex-valorbruto"), { aoAlterar: (valor) => { fm.campos.valorVendasBruto = valor; atualizarPreviewTicket(m); } });
  }
  if (chave === "financeiro" && situacaoOperou(fm.campos.situacao)) {
    const campos = [
      "dex-vifood:valorVendasIfood", "dex-taxas:taxasComissoes", "dex-servicos:servicosPromocoes",
      "dex-entregadores:taxasEntregadores", "dex-aj-favor:ajustesFavorLoja", "dex-aj-contra:ajustesContraLoja",
    ];
    campos.forEach((par) => {
      const [id, campo] = par.split(":");
      aplicarMascaraMoeda(m.querySelector(`#${id}`), {
        aoAlterar: (valor) => { fm.campos[campo] = valor; atualizarPreviewFinanceiro(m); },
      });
    });
  }
  if (chave === "conferencia") {
    m.querySelector("#dex-confirmar-avisos")?.addEventListener("change", (e) => { fm.confirmarAvisos = e.target.checked; });
    m.querySelector("#dex-motivo-correcao")?.addEventListener("input", (e) => { fm.motivoCorrecao = e.target.value; });
  }
}

function atualizarPreviewTicket(m) {
  const val = ticketMedioPreview(fm.campos);
  const alvo = m.querySelector(".dex-form-corpo input[disabled]");
  if (alvo) alvo.value = val == null ? "—" : fmtMoeda(val);
}

function atualizarPreviewFinanceiro(m) {
  const calc = calculoPreview(fm.campos);
  const box = m.querySelector(".dex-calc-preview");
  if (!box) return;
  const set = (chave, texto) => { const el = box.querySelector(`[data-prev="${chave}"]`); if (el) el.textContent = texto; };
  set("taxas", fmtPct(calc.pctTaxas));
  set("servicos", fmtPct(calc.pctServicos));
  set("entregadores", fmtPct(calc.pctEntregadores));
  set("total", fmtMoeda(calc.totalDed));
  set("pctTotal", fmtPct(calc.pctTotal));
  set("receita", fmtMoeda(calc.receita));
}

// ---------------------------------------------------------------------------
// VALIDAÇÃO CLIENT-SIDE MÍNIMA (a autoritativa é sempre o backend)
// ---------------------------------------------------------------------------
function validarPassoAtual(m) {
  const c = fm.campos;
  const chave = passosAtivos()[fm.passo - 1];
  if (chave === "situacao") {
    if (c.situacao === "sem_operacao" && !c.motivoSemOperacao) {
      c.motivoSemOperacao = m.querySelector("#dex-motivo")?.value || "";
    }
    if (c.situacao === "sem_operacao" && !c.motivoSemOperacao) { toast("Informe o motivo de não operação."); return false; }
    return true;
  }
  if (chave === "desempenho" && situacaoOperou(c.situacao)) {
    // Desempenho é opcional — nada aqui bloqueia o avanço. Só valida o que
    // foi de fato preenchido (não pode ser negativo).
    if (c.qtdVendas !== "" && Number(c.qtdVendas) < 0) { toast("A quantidade de vendas não pode ser negativa."); return false; }
    if (c.valorVendasBruto !== "" && !Number.isFinite(numeroDecimal(c.valorVendasBruto))) { toast("Informe um valor bruto válido."); return false; }
    if (c.valorVendasBruto !== "" && numeroDecimal(c.valorVendasBruto) < 0) { toast("O valor bruto não pode ser negativo."); return false; }
    return true;
  }
  // Financeiro só aparece nas etapas ativas quando fm.mostrarFinanceiro é
  // true (ver passosAtivos) — chegar aqui já implica que os campos existem
  // no DOM e são esperados preenchidos, exatamente como antes.
  if (chave === "financeiro" && situacaoOperou(c.situacao)) {
    const obrigatorios = [c.valorVendasIfood, c.taxasComissoes, c.servicosPromocoes];
    if (mostraEntregadores()) obrigatorios.push(c.taxasEntregadores);
    else c.taxasEntregadores = c.taxasEntregadores || 0; // Full Service: campo nem aparece, garante 0 no cálculo/envio
    if (obrigatorios.some((v) => v === "")) {
      toast("Preencha todos os campos financeiros obrigatórios."); return false;
    }
    const ajustes = [["ajustesFavorLoja", c.ajustesFavorLoja], ["ajustesContraLoja", c.ajustesContraLoja]];
    if (obrigatorios.some((valor) => !Number.isFinite(numeroDecimal(valor)))
      || ajustes.some(([, valor]) => valor !== "" && !Number.isFinite(numeroDecimal(valor)))) {
      toast("Informe valores financeiros válidos."); return false;
    }
    if (obrigatorios.some((valor) => numeroDecimal(valor) < 0)
      || ajustes.some(([, valor]) => valor !== "" && numeroDecimal(valor) < 0)) {
      toast("Os valores financeiros não podem ser negativos."); return false;
    }
    return true;
  }
  return true;
}

// ---------------------------------------------------------------------------
// FINALIZAÇÃO — salvar rascunho / finalizar / corrigir
// ---------------------------------------------------------------------------
function wireFinalizacao(m) {
  m.querySelector("#dex-f-rascunho")?.addEventListener("click", () => salvar(m, "rascunho"));
  m.querySelector("#dex-f-finalizar")?.addEventListener("click", () => salvar(m, "finalizado"));
}

/** "" (campo vazio) vira `undefined` (omitido do corpo) — nunca 0. O backend
 * trata ausência como "não informado" (null), nunca como zero digitado. */
const numOuIndefinido = (s) => (s === "" || s == null ? undefined : Number(s));

function payloadBase(status) {
  const c = fm.campos;
  const base = {
    unidadeId: fm.unidadeId || undefined, data: fm.data, situacao: c.situacao,
    observacao: c.observacao || undefined, status,
    // Concorrência otimista (Etapa 2): a versão que LEMOS quando o formulário
    // abriu (ou na última recarga) — o backend recusa com 409 se a linha já
    // mudou desde então. Só existe pra edição (lançamento já tinha id);
    // criação nunca tem versão anterior pra conferir.
    seVersao: fm.lancamentoId ? fm.atualizadoEm || undefined : undefined,
  };
  if (c.situacao === "sem_operacao") return { ...base, motivoSemOperacao: c.motivoSemOperacao };
  if (c.situacao === "zero_vendas") return { ...base, novosClientes: numOuIndefinido(c.novosClientes) };
  const desempenho = {
    // Desempenho: opcional, nunca vira 0 por conta própria.
    qtdVendas: numOuIndefinido(c.qtdVendas), valorVendasBruto: numeroDecimalOuIndefinido(c.valorVendasBruto), novosClientes: numOuIndefinido(c.novosClientes),
  };
  if (!fm.mostrarFinanceiro) {
    // Etapa Financeiro nem fez parte deste lançamento (dia ≠ ontem, sem
    // snapshot salvo) — não manda nada dela, nunca 0 (backend mantém null e
    // só deixa o dia virar rascunho, ver normalizarDadosLancamento).
    return { ...base, ...desempenho };
  }
  // Financeiro: também nunca vira 0 por conta própria — mesmo quando a etapa
  // é elegível, "Salvar como rascunho" agora existe em toda etapa (item novo
  // do pedido) e pode ser clicado ANTES de o usuário sequer abrir esta etapa,
  // com os campos ainda vazios. `numOuIndefinido` omite o que não foi
  // preenchido; ao Finalizar, o backend já garante que tudo chegue preenchido
  // (validarPassoAtual barra o avanço antes disso), então usar a mesma função
  // aqui não muda nada pra quem finaliza — só corrige quem salva rascunho cedo.
  return {
    ...base, ...desempenho,
    valorVendasIfood: numeroDecimalOuIndefinido(c.valorVendasIfood), taxasComissoes: numeroDecimalOuIndefinido(c.taxasComissoes),
    servicosPromocoes: numeroDecimalOuIndefinido(c.servicosPromocoes), taxasEntregadores: numeroDecimalOuIndefinido(c.taxasEntregadores),
    ajustesFavorLoja: numeroDecimalOuIndefinido(c.ajustesFavorLoja), ajustesContraLoja: numeroDecimalOuIndefinido(c.ajustesContraLoja),
    confirmarAvisos: fm.confirmarAvisos,
  };
}

async function salvar(m, status) {
  if (fm.modoCorrecao && !fm.motivoCorrecao.trim()) { toast("Informe o motivo da correção."); return; }
  const btn = m.querySelector(status === "finalizado" ? "#dex-f-finalizar" : "#dex-f-rascunho");
  if (!btn || fm.salvando) return;
  fm.salvando = true;
  const txt = btn.textContent; btn.disabled = true; btn.textContent = "Salvando…";
  try {
    const payload = payloadBase(status);
    if (fm.lancamentoId) {
      await dashExecAtualizarLancamento(fm.lancamentoId, { ...payload, motivo: fm.modoCorrecao ? fm.motivoCorrecao : undefined });
    } else {
      await dashExecCriarLancamento(payload);
    }
    toast(status === "finalizado" ? "Lançamento finalizado." : "Rascunho salvo com sucesso.");
    const onSalvo = fm?.onSalvo; // capturado ANTES de fechar: fecharOverlay() zera `fm`
    fecharOverlay();
    onSalvo?.();
  } catch (e) {
    btn.disabled = false; btn.textContent = txt;
    fm.salvando = false;
    // Concorrência otimista (Etapa 2): outro dispositivo/sessão salvou este
    // MESMO lançamento primeiro. Nunca sobrescreve em silêncio — mostra o
    // mesmo aviso de conflito externo, com a ação de recarregar, em vez de
    // deixar o usuário tentar salvar de novo por cima de dado velho.
    if (e.codigo === "LANCAMENTO_DESATUALIZADO") {
      fm.conflitoExterno = true;
      toast(e.message);
      renderPasso(m);
      return;
    }
    toast("Erro: " + e.message);
  }
}

function fmtDataBr(iso) {
  if (!iso) return "—";
  const [a, mes, d] = iso.split("-");
  return `${d}/${mes}/${a}`;
}

/** "DD/MM/AAAA às HH:MM" — usado só no aviso de rascunho (item novo do pedido). */
function fmtDataHoraBr(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const data = d.toLocaleDateString("pt-BR");
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${data} às ${hora}`;
}
