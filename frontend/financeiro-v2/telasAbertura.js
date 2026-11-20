// ABERTURA FINANCEIRA (docs 29, 30 e 32) — no visual Crescer Com Delivery Financeiro.
// Funções PURAS: dados das consultas → HTML escapado. Nenhum valor é preenchido ou presumido; o servidor confere tudo de
// novo (permissão, escopo da sessão, abertura persistida, idempotência, transação, histórico).
//
// Fluxo: configurar a abertura (competência de início + data de corte, GRAVADAS por unidade) → plano e contas → saldos de
// abertura → títulos anteriores → conferência por outra pessoa → concluir. Os formulários de posição NÃO pedem
// competência: usam a abertura gravada.
import { competencia, esc, moeda, usaAnotaAi } from "./formatar.js";

/** Proposta inicial (doc 29 §2.1), SEMPRE editável e sujeita à confirmação do proprietário. */
export const COMPETENCIA_DE_ABERTURA_PROPOSTA = "2026-11";
export const MODELOS_DE_PLANO = Object.freeze([["ACAITERIA", "Açaiteria (base + categorias da açaiteria)"], ["BASE", "Base (qualquer empresa)"], ["SUBWAY", "Subway (franquia: royalties, AFSB, benefícios, distribuição de lucros)"]]);
export const PROCESSADORES = Object.freeze([["STONE", "Stone"], ["IFOOD", "iFood"], ["ANOTA_AI", "Anota AI"], ["OPERADORA_BENEFICIOS", "Operadora de vale"], ["MAQUINA_TERCEIROS", "Máquina de terceiros"], ["OUTRO", "Outro processador"]]);
const NOTA_SEM_ANEXO = "O cofre de documentos está desligado: informe a referência do documento. O sistema guarda a referência como texto e não afirma que conferiu um anexo.";

/** "2026-11" → "2026-10-31" (véspera do 1º dia). Só apresentação; o servidor calcula e grava. */
export function vespera(comp) {
  const [a, m] = String(comp ?? "").split("-").map(Number);
  if (!a || !m) return "";
  return new Date(Date.UTC(a, m - 1, 0)).toISOString().slice(0, 10);
}
const dataCurta = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "—");
const novaChave = () => esc(globalThis.crypto?.randomUUID?.() ?? "");
const opcao = (v, t, atual = "") => `<option value="${esc(v)}"${v === atual ? " selected" : ""}>${esc(t)}</option>`;
const VALOR = 'inputmode="decimal" pattern="[0-9.]{1,13}(,[0-9]{1,2})?" placeholder="0,00"';
const VALOR_COM_SINAL = 'inputmode="decimal" pattern="-?[0-9.]{1,13}(,[0-9]{1,2})?" placeholder="0,00"';
const selo = (texto, classe) => `<span class="selo selo--${classe}">${esc(texto)}</span>`;
let seq = 0;

/** Formulário de ação (contrato comum: `data-acao`, confirmação obrigatória, resultado anunciado). */
/** `recolhivel`: o formulário abre sob demanda (telas de consulta mantêm os dados na primeira dobra). */
export function formulario({ url, titulo, campos, aviso, rotulo, explicacao = "", recarregar = "lista", perigo = false, recolhivel = false }) {
  const k = (seq += 1);
  const [abre, titulo_, fecha] = recolhivel
    ? [`<details class="card card--formulario card--recolhivel"><summary><h3 id="t-ab-${k}">${esc(titulo)}</h3></summary>`, "", "</details>"]
    : [`<section class="card card--formulario" aria-labelledby="t-ab-${k}">`, `<div class="card-topo"><h3 id="t-ab-${k}">${esc(titulo)}</h3></div>`, "</section>"];
  return `${abre}${titulo_}${explicacao ? `<p class="nota">${esc(explicacao)}</p>` : ""}
<form class="acao acao--formulario${perigo ? " acao--perigo" : ""}" data-acao="${esc(url)}" data-recarregar="${esc(recarregar)}"><div class="campos-form">${campos}</div>
<label class="caixa-marcar"><input type="checkbox" name="confirmar" required> ${esc(aviso)}</label>
<div class="acoes-form"><button type="submit" class="botao${perigo ? "" : " botao--primario"}">${esc(rotulo)}</button></div><p class="resultado-acao" role="status" aria-live="polite"></p></form>${fecha}`;
}
const campoOrigem = (exemplo) => `<label class="campo--largo">Origem do valor (obrigatória) <input type="text" name="origem" minlength="5" maxlength="160" required placeholder="${esc(exemplo)}"></label>`;
const campoIdentificador = (exemplo) => `<label>Identificador do título (recomendado) <input type="text" name="identificador" maxlength="80" placeholder="${esc(exemplo)}"></label>`;
const justificativa = (obrigatoria = true) => `<label class="campo--largo">Justificativa${obrigatoria ? " (obrigatória)" : ""} <input type="text" name="justificativa" maxlength="500"${obrigatoria ? " required" : ""}></label>`;
const contasAtivas = (contas) => contas.filter((c) => c.ativa !== false);

// ---------------------------------------------------------------------------------------- abertura (configuração)
export function formConfigurarAbertura(atual = null) {
  return formulario({ url: "/api/fv2/acoes/abertura/configurar", titulo: atual ? "Mudar a competência de início" : "1. Configurar a abertura", rotulo: atual ? "Mudar competência" : "Gravar abertura",
    explicacao: atual
      ? "Só enquanto nenhum saldo ou título de abertura foi registrado. A mudança fica no histórico."
      : `Grava, para esta unidade, a competência de início e a data de corte (véspera). Proposta: ${competencia(COMPETENCIA_DE_ABERTURA_PROPOSTA)}, sujeita à sua confirmação. A abertura é recusada se já houver resultado lançado até o corte.`,
    aviso: atual ? "Confirmo a mudança da competência de início." : "Confirmo a competência de início e a data de corte.",
    campos: `<label>Competência de início <input type="month" name="competencia" value="${esc(atual ? "" : COMPETENCIA_DE_ABERTURA_PROPOSTA)}" required></label>
<label class="campo--largo">Observação (opcional) <input type="text" name="observacao" maxlength="300"></label>${atual ? justificativa() : ""}` });
}
export function formConcluirAbertura() {
  return formulario({ url: "/api/fv2/acoes/abertura/concluir", titulo: "Concluir a abertura", rotulo: "Concluir abertura",
    explicacao: "Depois da conferência por outra pessoa (saldos = extratos e contagem; totais = listas). Concluída, nenhuma posição de abertura entra sem reabrir — e reabrir exige o código do autenticador.",
    aviso: "Confirmo que a abertura foi conferida.", campos: justificativa() });
}
export function formReabrirAbertura() {
  return formulario({ url: "/api/fv2/acoes/abertura/reabrir", titulo: "Reabrir a abertura", rotulo: "Reabrir", perigo: true,
    explicacao: "Ação sensível: exige o código do autenticador nos últimos 10 minutos e fica no histórico.",
    aviso: "Confirmo a reabertura da abertura financeira.", campos: justificativa() });
}

// ------------------------------------------------------------------------------------ plano, contas e posições
export function formImplantarPlano() {
  return formulario({ url: "/api/fv2/acoes/configuracoes/implantar-plano", titulo: "Implantar o plano de contas", rotulo: "Implantar plano",
    explicacao: "Cria só as categorias que faltam; nunca altera nem duplica as existentes. A hierarquia e as regras da DRE vêm do modelo.",
    aviso: "Confirmo a implantação do modelo escolhido (fica no histórico).",
    campos: `<label>Modelo <select name="modelo">${MODELOS_DE_PLANO.map(([k, t]) => opcao(k, t, "ACAITERIA")).join("")}</select></label>
<label>Para confirmar, digite o nome do modelo <input type="text" name="modeloConfirmado" required autocomplete="off" pattern="[A-Z]+" placeholder="ACAITERIA"></label>` });
}

export function formNovaConta() {
  return formulario({ url: "/api/fv2/acoes/configuracoes/conta/criar", titulo: "Cadastrar conta financeira", rotulo: "Cadastrar conta",
    explicacao: "Unicred, caixa físico e outras contas com extrato. O cadastro NÃO tem saldo: o saldo de abertura é informado à parte, com a origem. Um nome já cadastrado não cria outra conta.",
    aviso: "Confirmo o cadastro da conta (fica no histórico).",
    campos: `<label>Tipo <select name="tipo">${opcao("BANCARIA", "Conta bancária", "BANCARIA")}${opcao("CAIXA_FISICO", "Caixa físico (dinheiro na loja)")}</select></label>
<label>Nome <input type="text" name="nome" maxlength="80" required placeholder="Ex.: Unicred"></label>
<label>Instituição (opcional) <input type="text" name="instituicao" maxlength="80"></label>` });
}

export function formSaldoDeAbertura(contas, ab) {
  const lista = contasAtivas(contas);
  if (!lista.length) return `<p class="nota">Saldos de abertura: cadastre as contas primeiro.</p>`;
  return formulario({ url: "/api/fv2/acoes/abertura/saldo", titulo: "Saldo de abertura de cada conta", rotulo: "Registrar saldo de abertura",
    explicacao: `Posição comprovada no FIM do dia ${dataCurta(ab.dataDeCorte)} (data de corte gravada). Banco: saldo final do extrato. Caixa: contagem física. Saldo não é receita. ${NOTA_SEM_ANEXO}`,
    aviso: "Confirmo que o valor é o do documento indicado (um segundo valor diferente para o mesmo dia é recusado).",
    campos: `<label>Conta <select name="conta" required>${lista.map((c) => opcao(c.id, c.nome)).join("")}</select></label>
<label>Saldo no fim de ${esc(dataCurta(ab.dataDeCorte))} (R$) <input type="text" name="valor" ${VALOR_COM_SINAL} required></label>${campoOrigem("Ex.: extrato Unicred, saldo final do dia")}` });
}

export function formObrigacaoAnterior(ab) {
  return formulario({ url: "/api/fv2/acoes/abertura/obrigacao-anterior", titulo: "Contas a pagar anteriores à abertura", rotulo: "Registrar conta anterior",
    explicacao: `Uma por documento, pelo saldo ainda em aberto em ${dataCurta(ab.dataDeCorte)}. Entra como posição patrimonial de abertura (passivo), FORA da DRE: não é despesa de ${competencia(ab.competenciaInicio)}, e o pagamento depois também não vira despesa.`,
    aviso: "Confirmo o registro da conta anterior (reenviar o mesmo formulário não duplica).",
    campos: `<input type="hidden" name="chave" value="${novaChave()}">
<label>Fornecedor <input type="text" name="fornecedorNovo" maxlength="120" required placeholder="O mesmo nome reaproveita o cadastro"></label>
<label>Documento e descrição <input type="text" name="descricao" maxlength="200" required placeholder="Ex.: NF 1234 — insumos"></label>
${campoIdentificador("Ex.: NF 1234")}<label>Saldo em aberto (R$) <input type="text" name="valor" ${VALOR} required></label>
<label>Emissão (até o corte) <input type="date" name="dataEmissao" max="${esc(ab.dataDeCorte)}" required></label>
<label>Vencimento <input type="date" name="vencimento" required></label>${campoOrigem("Ex.: lista de contas a pagar no corte")}` });
}

export function formRecebivelAnterior(ab) {
  return formulario({ url: "/api/fv2/acoes/abertura/recebivel-anterior", titulo: "Valores a receber anteriores à abertura", rotulo: "Registrar valor a receber anterior",
    explicacao: `Repasses e créditos de vendas até ${dataCurta(ab.dataDeCorte)} ainda não recebidos, pelo valor a receber do demonstrativo (sem taxas presumidas). Não é faturamento e o recebimento depois não vira receita. Informe o identificador (pedido, ID do repasse, Stone ID): importações posteriores do mesmo título vão à conferência e nunca são aplicadas de novo.`,
    aviso: "Confirmo o registro do valor a receber anterior (reenviar o mesmo formulário não duplica).",
    campos: `<input type="hidden" name="chave" value="${novaChave()}">
<label>Processador <select name="processador">${opcao("", "— não é processador (cliente) —")}${PROCESSADORES.filter(([k]) => k !== "ANOTA_AI" || usaAnotaAi()).map(([k, t]) => opcao(k, t)).join("")}</select></label>
<label>Ou cliente <input type="text" name="clienteNovo" maxlength="120" placeholder="Nome do cliente (se não for processador)"></label>
<label>Identificação <input type="text" name="descricao" maxlength="200" required placeholder="Ex.: repasse da semana de 27/10"></label>
${campoIdentificador("Ex.: ID do repasse ou do pedido")}<label>Valor a receber (R$) <input type="text" name="valor" ${VALOR} required></label>
<label>Data de origem (até o corte) <input type="date" name="dataOrigem" max="${esc(ab.dataDeCorte)}" required></label>
<label>Previsão de recebimento (se informada) <input type="date" name="vencimento"></label>${campoOrigem("Ex.: demonstrativo iFood de 27/10 a 02/11")}` });
}

// --------------------------------------------------------------------------------------------- seção de configurações
/**
 * @param {object} d resposta de /abertura: { abertura, posicoes, configuracoes: { contas, planoDeContas, voce } }
 * @param {{ permissoes?: string[] }} ctx
 */
export function abertura(d = {}, ctx = {}) {
  const perm = ctx.permissoes ?? [];
  const configura = perm.includes("financeiro_v2.configurar");
  const registra = perm.includes("financeiro_v2.registrar");
  const cfg = d.configuracoes ?? d;
  const contas = cfg.contas ?? [];
  const categorias = cfg.planoDeContas?.categorias ?? 0;
  const ab = d.abertura ?? null;
  const p = d.posicoes ?? null;
  const emAndamento = ab?.situacao === "CONFIGURADA";
  const temPosicoes = Boolean(p && (p.saldos.length || p.obrigacoesAnteriores.quantidade || p.recebiveisAnteriores.quantidade));
  const passo = (feito, texto, detalhe) => `<li class="passo"><span class="passo-situacao">${feito === true ? selo("feito", "ok") : feito === false ? selo("falta", "alerta") : selo("conferir", "neutro")}</span><span class="passo-texto"><strong>${esc(texto)}</strong>${detalhe ? `<span class="nota">${detalhe}</span>` : ""}</span></li>`;
  const comSaldo = new Set((p?.saldos ?? []).map((s) => s.contaId));
  const estado = ab
    ? `<dl class="ficha"><dt>Competência de início</dt><dd>${esc(competencia(ab.competenciaInicio))}</dd><dt>Data de corte</dt><dd>${esc(dataCurta(ab.dataDeCorte))} (fim do dia)</dd>
<dt>Situação</dt><dd>${ab.situacao === "CONCLUIDA" ? selo("Concluída", "ok") : selo("Em andamento", "info")}</dd><dt>Versão</dt><dd>${esc(ab.versao)} · alterada em ${esc(dataCurta(ab.atualizadoEm))}</dd>${ab.observacao ? `<dt>Observação</dt><dd>${esc(ab.observacao)}</dd>` : ""}</dl>`
    : `<p class="aviso aviso--alerta">Abertura ainda não configurada. Proposta: início em ${esc(competencia(COMPETENCIA_DE_ABERTURA_PROPOSTA))}, saldos do fim de ${esc(dataCurta(vespera(COMPETENCIA_DE_ABERTURA_PROPOSTA)))}. Nada foi registrado e nenhum valor é preenchido automaticamente.</p>`;
  return `<section class="card card--destaque" aria-labelledby="t-abertura"><div class="card-topo"><h2 id="t-abertura">Abertura financeira</h2>${ab ? selo(ab.situacao === "CONCLUIDA" ? "concluída" : "em andamento", ab.situacao === "CONCLUIDA" ? "ok" : "info") : selo("não configurada", "alerta")}</div>
${estado}
<ol class="roteiro-abertura">
  ${passo(Boolean(ab), "Competência de início e data de corte", ab ? `${esc(competencia(ab.competenciaInicio))} · corte ${esc(dataCurta(ab.dataDeCorte))}` : "grave a abertura (proposta 11/2026)")}
  ${passo(categorias > 0, "Plano de contas", categorias > 0 ? `${categorias} categoria(s) implantada(s)` : "ainda não implantado")}
  ${passo(contas.length > 0, "Contas financeiras", contas.length ? contas.map((x) => esc(x.nome)).join(", ") : "nenhuma cadastrada")}
  ${passo(p ? contas.length > 0 && contas.every((x) => comSaldo.has(x.id)) : false, "Saldos de abertura", p ? `${p.saldos.length} de ${contas.length} conta(s) com saldo no corte` : "depois de configurar a abertura")}
  ${passo(p ? null : false, "Contas a pagar anteriores", p ? `${p.obrigacoesAnteriores.quantidade} título(s) · ${esc(moeda(p.obrigacoesAnteriores.totalCentavos))} — confira com a lista` : "depois de configurar a abertura")}
  ${passo(p ? null : false, "Valores a receber anteriores", p ? `${p.recebiveisAnteriores.quantidade} título(s) · ${esc(moeda(p.recebiveisAnteriores.totalCentavos))} — confira com os demonstrativos` : "depois de configurar a abertura")}
  ${passo(ab?.situacao === "CONCLUIDA" ? true : null, "Conferência por outra pessoa e conclusão", "saldos = extratos/contagem; totais = listas; DRE do início sem efeitos da abertura")}
</ol>
<details><summary>Documentos para reunir (fora do sistema, sem enviar pelo chat)</summary><ul class="mini">
  <li>Extrato Unicred com o saldo final do dia de corte e o do primeiro dia.</li>
  <li>Contagem física do caixa no fechamento do dia de corte, assinada por quem contou.</li>
  <li>Lista das contas a pagar em aberto: fornecedor, documento, emissão, vencimento e saldo.</li>
  <li>Demonstrativos dos valores a receber (iFood, Stone e outros) ainda não recebidos, com os identificadores.</li>
</ul></details>
<details><summary>Por que os títulos anteriores ficam fora da DRE</summary><p class="nota">A despesa ou a venda que originou o título pertence a um período que este financeiro não apura. Na abertura ela é só a posição inicial: o que a empresa devia (passivo) ou tinha a receber (ativo). Pagar ou receber depois é liquidação do título, nunca um novo resultado. Importações com data até o corte vão à conferência e nunca são aplicadas. CMV não é calculado sem dados de itens vendidos e de estoque.</p></details>
</section>
${configura ? (!ab ? formConfigurarAbertura() : emAndamento && !temPosicoes ? formConfigurarAbertura(ab) : "") : `<p class="nota">Configurar a abertura, o plano e as contas exige a permissão "configurar".</p>`}
${configura ? formImplantarPlano() + formNovaConta() : ""}
${emAndamento && registra ? formSaldoDeAbertura(contas, ab) + formObrigacaoAnterior(ab) + formRecebivelAnterior(ab) : ab && !emAndamento ? '<p class="nota">Abertura concluída: novas posições de abertura exigem reabri-la.</p>' : !registra ? '<p class="nota">Registrar saldos e títulos exige a permissão "registrar".</p>' : ""}
${configura && emAndamento && temPosicoes ? formConcluirAbertura() : ""}
${ab?.situacao === "CONCLUIDA" && perm.includes("financeiro_v2.reabrir") ? formReabrirAbertura() : ""}`;
}

// ------------------------------------------------------------------------------------ caixa físico (Caixa e Bancos)
const OPERACOES = Object.freeze([["ENTRADA", "Entrada de dinheiro"], ["SAIDA", "Saída de dinheiro"], ["SANGRIA", "Sangria (retirada; para o banco, informe a conta)"], ["SUPRIMENTO", "Suprimento (reforço de troco)"]]);
/** Formulários do caixa físico a partir de Caixa e Bancos (contas com as sessões do período). */
export function formulariosDeCaixa(contas = [], ctx = {}) {
  if (!(ctx.permissoes ?? []).includes("financeiro_v2.registrar")) return "";
  const caixas = contas.filter((c) => c.tipo === "CAIXA_FISICO");
  if (!caixas.length) return `<p class="nota">Nenhuma conta de caixa físico cadastrada: cadastre em Configurações → Abertura financeira.</p>`;
  // A sessão aberta vem da conta (independe do período exibido); sessoesDeCaixa só cobre o período.
  const abertaDe = (c) => c.sessaoAberta ?? (c.sessoesDeCaixa ?? []).find((s) => s.situacao === "ABERTA") ?? null;
  const abertas = caixas.filter(abertaDe).map((c) => ({ ...abertaDe(c), contaNome: c.nome }));
  const semSessao = caixas.filter((c) => !abertaDe(c));
  const bancos = contas.filter((c) => c.tipo !== "CAIXA_FISICO");
  const sessoes = abertas.map((s) => opcao(s.id, `${s.contaNome} · aberta em ${dataCurta(s.dataAbertura)}`)).join("");
  return `<div class="formularios-caixa">${semSessao.length ? formulario({ recolhivel: true, url: "/api/fv2/acoes/caixa/abrir", titulo: "Abrir caixa", rotulo: "Abrir caixa",
    explicacao: "Informe o dinheiro CONTADO na gaveta. A abertura não é faturamento nem receita: é o ponto de partida da sessão.",
    aviso: "Confirmo a abertura com o valor contado.",
    campos: `<label>Caixa <select name="conta" required>${semSessao.map((c) => opcao(c.id, c.nome)).join("")}</select></label>
<label>Data <input type="date" name="data" required></label><label>Dinheiro contado (R$) <input type="text" name="contado" ${VALOR} required></label>
<label class="campo--largo">Observação <input type="text" name="observacao" maxlength="300"></label>` }) : ""}
${abertas.length ? formulario({ recolhivel: true, url: "/api/fv2/acoes/caixa/operacao", titulo: "Entrada, saída, sangria ou suprimento", rotulo: "Registrar operação",
    explicacao: "Não classifica como receita nem despesa: saída sem destino identificado fica pendente de classificação. Sangria para o banco vira transferência interna.",
    aviso: "Confirmo a operação (reenviar o mesmo formulário não duplica).",
    campos: `<input type="hidden" name="chave" value="${novaChave()}"><label>Sessão <select name="sessao" required>${sessoes}</select></label>
<label>Operação <select name="operacao">${OPERACOES.map(([k, t]) => opcao(k, t)).join("")}</select></label>
<label>Valor (R$) <input type="text" name="valor" ${VALOR} required></label><label>Data <input type="date" name="data" required></label>
<label class="campo--largo">Descrição <input type="text" name="descricao" maxlength="200" required></label>
${bancos.length ? `<label>Conta de destino/origem (só sangria/suprimento) <select name="contraConta">${opcao("", "— nenhuma (dinheiro de fora) —")}${bancos.map((c) => opcao(c.id, c.nome)).join("")}</select></label>` : ""}` })
  + formulario({ recolhivel: true, url: "/api/fv2/acoes/caixa/fechar", titulo: "Fechar caixa", rotulo: "Fechar caixa",
    explicacao: "Compara o teórico (abertura + entradas − saídas) com o contado. Diferença exige justificativa e NÃO gera ajuste automático.",
    aviso: "Confirmo o fechamento com o valor contado.",
    campos: `<label>Sessão <select name="sessao" required>${sessoes}</select></label><label>Data <input type="date" name="data" required></label>
<label>Dinheiro contado (R$) <input type="text" name="contado" ${VALOR} required></label><label class="campo--largo">Justificativa (se houver diferença) <input type="text" name="justificativa" maxlength="500"></label>` }) : ""}</div>`;
}

// ------------------------------------------------------------------------------------------- contas a receber (período)
export function formRecebivelDoPeriodo(ctx = {}) {
  if (!(ctx.permissoes ?? []).includes("financeiro_v2.registrar")) return "";
  return formulario({ recolhivel: true, url: "/api/fv2/acoes/recebiveis/registrar", titulo: "Registrar valor a receber de cliente", rotulo: "Registrar a receber",
    explicacao: "Para créditos com clientes (ex.: encomenda faturada). Repasses de Stone, iFood e outros processadores nascem das vendas e dos demonstrativos e não entram por aqui, para não contar duas vezes. Título a receber não é faturamento.",
    aviso: "Confirmo o registro (reenviar o mesmo formulário não duplica).",
    campos: `<input type="hidden" name="chave" value="${novaChave()}"><label>Cliente <input type="text" name="clienteNovo" maxlength="120" required placeholder="O mesmo nome reaproveita o cadastro"></label>
<label>Identificação <input type="text" name="descricao" maxlength="200" required></label><label>Valor (R$) <input type="text" name="valor" ${VALOR} required></label>
<label>Competência <input type="month" name="competencia" value="${esc(ctx.competencia ?? "")}" required></label><label>Vencimento <input type="date" name="vencimento"></label>` });
}
