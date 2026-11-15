// ABERTURA FINANCEIRA (doc 29) — formulários para receber os primeiros dados reais: plano de contas, contas financeiras,
// saldos de abertura, títulos ANTERIORES à abertura (contas a pagar e a receber) e o roteiro de conferência.
// Funções PURAS: dados das consultas → HTML escapado. Nenhum valor é preenchido ou presumido aqui; o servidor confere tudo
// de novo (permissão, escopo da sessão, idempotência, transação, histórico). Componente isolado do visual (o agente de
// design reaproveita as mesmas classes e o contrato dos campos, documentado em docs/financeiro-v2/30-*).
import { competencia, esc } from "./formatar.js";

/** Proposta inicial (doc 29 §2.1), SEMPRE editável e sujeita à confirmação do proprietário. */
export const COMPETENCIA_DE_ABERTURA_PROPOSTA = "2026-11";
export const MODELOS_DE_PLANO = Object.freeze([["ACAITERIA", "Açaiteria (base + categorias da açaiteria)"], ["BASE", "Base (qualquer empresa)"]]);
export const PROCESSADORES = Object.freeze([["STONE", "Stone"], ["IFOOD", "iFood"], ["ANOTA_AI", "Anota AI"], ["OPERADORA_BENEFICIOS", "Operadora de vale"], ["MAQUINA_TERCEIROS", "Máquina de terceiros"], ["OUTRO", "Outro processador"]]);
const NOTA_SEM_ANEXO = "O cofre de documentos está desligado: informe a referência do documento (extrato, nota, demonstrativo). O sistema guarda a referência como texto e não afirma que conferiu um anexo.";

/** "2026-11" → "2026-10-31" (véspera do 1º dia). Só apresentação; o servidor calcula de novo. */
export function vespera(comp) {
  const [a, m] = String(comp ?? "").split("-").map(Number);
  if (!a || !m) return "";
  return new Date(Date.UTC(a, m - 1, 0)).toISOString().slice(0, 10);
}
const dataCurta = (iso) => (iso ? iso.split("-").reverse().join("/") : "—");
const novaChave = () => esc(globalThis.crypto?.randomUUID?.() ?? "");
const opcao = (v, t, atual = "") => `<option value="${esc(v)}"${v === atual ? " selected" : ""}>${esc(t)}</option>`;
const VALOR = 'inputmode="decimal" pattern="[0-9.]{1,13}(,[0-9]{1,2})?" placeholder="0,00"';
const VALOR_COM_SINAL = 'inputmode="decimal" pattern="-?[0-9.]{1,13}(,[0-9]{1,2})?" placeholder="0,00"';
let seq = 0;

/** Formulário de ação (mesmo contrato das demais telas: `data-acao`, confirmação obrigatória, resultado anunciado). */
export function formulario({ url, titulo, campos, aviso, rotulo, explicacao = "", recarregar = "lista" }) {
  const k = (seq += 1);
  return `<section class="card" aria-labelledby="t-ab-${k}"><h3 id="t-ab-${k}">${esc(titulo)}</h3>${explicacao ? `<p class="nota">${esc(explicacao)}</p>` : ""}
<form class="acao" data-acao="${esc(url)}" data-recarregar="${esc(recarregar)}">${campos}
<label class="caixa-marcar"><input type="checkbox" name="confirmar" required> ${esc(aviso)}</label>
<button type="submit" class="botao botao--primario">${esc(rotulo)}</button><p class="resultado-acao" role="status" aria-live="polite"></p></form></section>`;
}

const campoCompetencia = (comp) => `<label>Competência de início <input type="month" name="competencia" value="${esc(comp)}" required></label>`;
const campoOrigem = (exemplo) => `<label>Origem do valor (obrigatória) <input name="origem" minlength="5" maxlength="160" required placeholder="${esc(exemplo)}"></label>`;
const contasAtivas = (contas) => contas.filter((c) => c.ativa !== false);

// ------------------------------------------------------------------------------------------- formulários (contratos)
export function formImplantarPlano() {
  return formulario({ url: "/api/fv2/acoes/configuracoes/implantar-plano", titulo: "1. Implantar o plano de contas", rotulo: "Implantar plano",
    explicacao: "Cria só as categorias que faltam; nunca altera nem duplica as existentes. A hierarquia e as regras da DRE vêm do modelo.",
    aviso: "Confirmo a implantação do modelo escolhido (fica no histórico).",
    campos: `<label>Modelo <select name="modelo">${MODELOS_DE_PLANO.map(([k, t]) => opcao(k, t, "ACAITERIA")).join("")}</select></label>
<label>Para confirmar, digite o nome do modelo (ex.: ACAITERIA) <input name="modeloConfirmado" required autocomplete="off" pattern="[A-Z]+"></label>` });
}

export function formNovaConta() {
  return formulario({ url: "/api/fv2/acoes/configuracoes/conta/criar", titulo: "2. Cadastrar conta financeira", rotulo: "Cadastrar conta",
    explicacao: "Unicred, caixa físico e outras contas com extrato. O cadastro NÃO tem saldo: o saldo de abertura é informado à parte, com a origem. Um nome já cadastrado não cria outra conta.",
    aviso: "Confirmo o cadastro da conta (fica no histórico).",
    campos: `<label>Tipo <select name="tipo">${opcao("BANCARIA", "Conta bancária", "BANCARIA")}${opcao("CAIXA_FISICO", "Caixa físico (dinheiro na loja)")}</select></label>
<label>Nome <input name="nome" maxlength="80" required placeholder="Ex.: Unicred"></label>
<label>Instituição (opcional) <input name="instituicao" maxlength="80"></label>` });
}

export function formSaldoDeAbertura(contas, comp) {
  const lista = contasAtivas(contas);
  if (!lista.length) return `<p class="nota">3. Saldos de abertura: cadastre as contas primeiro.</p>`;
  return formulario({ url: "/api/fv2/acoes/abertura/saldo", titulo: "3. Saldo de abertura de cada conta", rotulo: "Registrar saldo de abertura",
    explicacao: `Posição comprovada no ENCERRAMENTO do dia anterior ao início (para ${competencia(comp)}: fim do dia ${dataCurta(vespera(comp))}). Banco: saldo final do extrato. Caixa: contagem física. Saldo não é receita. ${NOTA_SEM_ANEXO}`,
    aviso: "Confirmo que o valor é o do documento indicado (um segundo valor diferente para o mesmo dia é recusado).",
    campos: `<label>Conta <select name="conta" required>${lista.map((c) => opcao(c.id, c.nome)).join("")}</select></label>${campoCompetencia(comp)}
<label>Saldo no fim da véspera (R$) <input name="valor" ${VALOR_COM_SINAL} required></label>${campoOrigem("Ex.: extrato Unicred de 31/10, saldo final do dia")}` });
}

export function formObrigacaoAnterior(comp) {
  return formulario({ url: "/api/fv2/acoes/abertura/obrigacao-anterior", titulo: "4. Contas a pagar anteriores à abertura", rotulo: "Registrar conta anterior",
    explicacao: "Uma por documento, pelo saldo ainda em aberto. Entra como posição patrimonial de abertura (passivo), FORA da DRE: não é despesa da competência de início, e o pagamento depois também não vira despesa.",
    aviso: "Confirmo o registro da conta anterior (reenviar o mesmo formulário não duplica).",
    campos: `<input type="hidden" name="chave" value="${novaChave()}">
<label>Fornecedor <input name="fornecedorNovo" maxlength="120" required placeholder="O mesmo nome reaproveita o cadastro"></label>
<label>Documento e descrição <input name="descricao" maxlength="200" required placeholder="Ex.: NF 1234 — insumos"></label>
<label>Saldo em aberto (R$) <input name="valor" ${VALOR} required></label>${campoCompetencia(comp)}
<label>Emissão (antes do início) <input type="date" name="dataEmissao" max="${esc(vespera(comp))}" required></label>
<label>Vencimento <input type="date" name="vencimento" required></label>${campoOrigem("Ex.: lista de contas a pagar em 31/10")}` });
}

export function formRecebivelAnterior(comp) {
  return formulario({ url: "/api/fv2/acoes/abertura/recebivel-anterior", titulo: "5. Contas a receber anteriores à abertura", rotulo: "Registrar valor a receber anterior",
    explicacao: "Repasses e créditos de vendas ANTERIORES ao início (iFood, Stone, outros) ainda não recebidos. Pelo valor a receber do demonstrativo, sem taxas presumidas: não é faturamento da competência de início e o recebimento depois não vira receita. Não importe as vendas desse período anterior, para não contar duas vezes.",
    aviso: "Confirmo o registro do valor a receber anterior (reenviar o mesmo formulário não duplica).",
    campos: `<input type="hidden" name="chave" value="${novaChave()}">
<label>Processador <select name="processador">${opcao("", "— não é processador (cliente) —")}${PROCESSADORES.map(([k, t]) => opcao(k, t)).join("")}</select></label>
<label>Ou cliente <input name="clienteNovo" maxlength="120" placeholder="Nome do cliente (se não for processador)"></label>
<label>Identificação <input name="descricao" maxlength="200" required placeholder="Ex.: repasse da semana de 27/10"></label>
<label>Valor a receber (R$) <input name="valor" ${VALOR} required></label>${campoCompetencia(comp)}
<label>Data de origem (antes do início) <input type="date" name="dataOrigem" max="${esc(vespera(comp))}" required></label>
<label>Previsão de recebimento (se o documento informar) <input type="date" name="vencimento"></label>${campoOrigem("Ex.: demonstrativo iFood de 27/10 a 02/11")}` });
}

// --------------------------------------------------------------------------------------------- seção de configurações
/**
 * @param {object} c resposta de /configuracoes (contas, planoDeContas, competencias, voce)
 * @param {{ permissoes?: string[], competenciaAbertura?: string }} ctx
 */
export function abertura(c = {}, ctx = {}) {
  const comp = ctx.competenciaAbertura ?? COMPETENCIA_DE_ABERTURA_PROPOSTA;
  const perm = ctx.permissoes ?? [];
  const configura = perm.includes("financeiro_v2.configurar");
  const registra = perm.includes("financeiro_v2.registrar");
  const contas = c.contas ?? [];
  const categorias = c.planoDeContas?.categorias ?? 0;
  const passo = (feito, texto, detalhe) => `<li><span class="selo selo--${feito === true ? "ok" : feito === false ? "alerta" : "neutro"}">${feito === true ? "feito" : feito === false ? "falta" : "conferir"}</span> <strong>${esc(texto)}</strong>${detalhe ? ` — ${detalhe}` : ""}</li>`;
  return `<section class="card" aria-labelledby="t-abertura"><h2 id="t-abertura">Abertura financeira</h2>
<p class="aviso">Competência de início proposta: <strong>${esc(competencia(comp))}</strong> (sujeita à confirmação do proprietário). Os saldos iniciais são a posição comprovada no fim do dia <strong>${esc(dataCurta(vespera(comp)))}</strong>. Nenhum valor é preenchido automaticamente.</p>
<ol class="lista-simples roteiro-abertura">
  ${passo(categorias > 0, "Plano de contas", categorias > 0 ? `${categorias} categoria(s) implantada(s)` : "ainda não implantado")}
  ${passo(contas.length > 0, "Contas financeiras", contas.length ? contas.map((x) => esc(x.nome)).join(", ") : "nenhuma cadastrada")}
  ${passo(null, "Saldos de abertura", `cada conta com o saldo do fim de ${esc(dataCurta(vespera(comp)))}; confira em <a href="#/caixa-e-bancos">Caixa e Bancos</a>`)}
  ${passo(null, "Contas a pagar anteriores", `uma por documento; confira o total em <a href="#/contas-a-pagar">Contas a Pagar</a>`)}
  ${passo(null, "Valores a receber anteriores", `pelos demonstrativos; confira em <a href="#/contas-a-receber">Contas a Receber</a>`)}
  ${passo(null, "Caixa físico", `abra a sessão com o dinheiro contado em <a href="#/caixa-e-bancos">Caixa e Bancos</a>`)}
  ${passo(null, "Conferência por outra pessoa", `saldos = extratos/contagem; totais = listas; DRE de ${esc(competencia(comp))} sem efeitos da abertura; registre em <a href="#/conferencias">Conferências</a>`)}
</ol>
<details><summary>Documentos para reunir (fora do sistema, sem enviar pelo chat)</summary><ul class="mini">
  <li>Extrato Unicred com o saldo final de ${esc(dataCurta(vespera(comp)))} e o do primeiro dia.</li>
  <li>Contagem física do caixa no fechamento de ${esc(dataCurta(vespera(comp)))}, assinada por quem contou.</li>
  <li>Lista das contas a pagar em aberto: fornecedor, documento, emissão, vencimento e saldo.</li>
  <li>Demonstrativos dos valores a receber (iFood, Stone e outros) ainda não recebidos.</li>
</ul></details>
<details><summary>Por que os títulos anteriores ficam fora da DRE</summary><p class="nota">A despesa ou a venda que originou o título pertence a um período que este financeiro não apura. Na abertura ela é só a posição inicial: o que a empresa devia (passivo) ou tinha a receber (ativo). Registrá-la como despesa ou receita da competência de início distorceria a DRE. Pagar ou receber depois é liquidação do título, nunca um novo resultado. CMV não é calculado sem dados de itens vendidos e de estoque.</p></details>
</section>
${configura ? formImplantarPlano() + formNovaConta() : `<p class="nota">Implantar o plano e cadastrar contas exige a permissão "configurar".</p>`}
${registra ? formSaldoDeAbertura(contas, comp) + formObrigacaoAnterior(comp) + formRecebivelAnterior(comp) : `<p class="nota">Registrar saldos e títulos exige a permissão "registrar".</p>`}`;
}

// ------------------------------------------------------------------------------------ caixa físico (Caixa e Bancos)
const OPERACOES = Object.freeze([["ENTRADA", "Entrada de dinheiro"], ["SAIDA", "Saída de dinheiro"], ["SANGRIA", "Sangria (retirada; para o banco, informe a conta)"], ["SUPRIMENTO", "Suprimento (reforço de troco)"]]);
/** Formulários do caixa físico a partir de Caixa e Bancos (contas com as sessões do período). */
export function formulariosDeCaixa(contas = [], ctx = {}) {
  if (!(ctx.permissoes ?? []).includes("financeiro_v2.registrar")) return "";
  const caixas = contas.filter((c) => c.tipo === "CAIXA_FISICO");
  if (!caixas.length) return `<p class="nota">Nenhuma conta de caixa físico cadastrada: cadastre em Configurações → Abertura financeira.</p>`;
  const abertas = caixas.flatMap((c) => (c.sessoesDeCaixa ?? []).filter((s) => s.situacao === "ABERTA").map((s) => ({ ...s, contaNome: c.nome })));
  const semSessao = caixas.filter((c) => !(c.sessoesDeCaixa ?? []).some((s) => s.situacao === "ABERTA"));
  const bancos = contas.filter((c) => c.tipo !== "CAIXA_FISICO");
  const sessoes = abertas.map((s) => opcao(s.id, `${s.contaNome} · aberta em ${dataCurta(s.dataAbertura)}`)).join("");
  return `${semSessao.length ? formulario({ url: "/api/fv2/acoes/caixa/abrir", titulo: "Abrir caixa", rotulo: "Abrir caixa",
    explicacao: "Informe o dinheiro CONTADO na gaveta. A abertura não é faturamento nem receita: é o ponto de partida da sessão.",
    aviso: "Confirmo a abertura com o valor contado.",
    campos: `<label>Caixa <select name="conta" required>${semSessao.map((c) => opcao(c.id, c.nome)).join("")}</select></label>
<label>Data <input type="date" name="data" required></label><label>Dinheiro contado (R$) <input name="contado" ${VALOR} required></label>
<label>Observação <input name="observacao" maxlength="300"></label>` }) : ""}
${abertas.length ? formulario({ url: "/api/fv2/acoes/caixa/operacao", titulo: "Entrada, saída, sangria ou suprimento", rotulo: "Registrar operação",
    explicacao: "Não classifica como receita nem despesa: saída sem destino identificado fica pendente de classificação. Sangria para o banco vira transferência interna.",
    aviso: "Confirmo a operação (reenviar o mesmo formulário não duplica).",
    campos: `<input type="hidden" name="chave" value="${novaChave()}"><label>Sessão <select name="sessao" required>${sessoes}</select></label>
<label>Operação <select name="operacao">${OPERACOES.map(([k, t]) => opcao(k, t)).join("")}</select></label>
<label>Valor (R$) <input name="valor" ${VALOR} required></label><label>Data <input type="date" name="data" required></label>
<label>Descrição <input name="descricao" maxlength="200" required></label>
${bancos.length ? `<label>Conta de destino/origem (só sangria/suprimento) <select name="contraConta">${opcao("", "— nenhuma (dinheiro de fora) —")}${bancos.map((c) => opcao(c.id, c.nome)).join("")}</select></label>` : ""}` })
  + formulario({ url: "/api/fv2/acoes/caixa/fechar", titulo: "Fechar caixa", rotulo: "Fechar caixa",
    explicacao: "Compara o teórico (abertura + entradas − saídas) com o contado. Diferença exige justificativa e NÃO gera ajuste automático.",
    aviso: "Confirmo o fechamento com o valor contado.",
    campos: `<label>Sessão <select name="sessao" required>${sessoes}</select></label><label>Data <input type="date" name="data" required></label>
<label>Dinheiro contado (R$) <input name="contado" ${VALOR} required></label><label>Justificativa (se houver diferença) <input name="justificativa" maxlength="500"></label>` }) : ""}`;
}

// ------------------------------------------------------------------------------------------- contas a receber (período)
export function formRecebivelDoPeriodo(ctx = {}) {
  if (!(ctx.permissoes ?? []).includes("financeiro_v2.registrar")) return "";
  return formulario({ url: "/api/fv2/acoes/recebiveis/registrar", titulo: "Registrar valor a receber de cliente", rotulo: "Registrar a receber",
    explicacao: "Para créditos com clientes (ex.: encomenda faturada). Repasses de Stone, iFood e outros processadores nascem das vendas e dos demonstrativos e não entram por aqui, para não contar duas vezes. Título a receber não é faturamento.",
    aviso: "Confirmo o registro (reenviar o mesmo formulário não duplica).",
    campos: `<input type="hidden" name="chave" value="${novaChave()}"><label>Cliente <input name="clienteNovo" maxlength="120" required placeholder="O mesmo nome reaproveita o cadastro"></label>
<label>Identificação <input name="descricao" maxlength="200" required></label><label>Valor (R$) <input name="valor" ${VALOR} required></label>
<label>Competência <input type="month" name="competencia" value="${esc(ctx.competencia ?? "")}" required></label><label>Vencimento <input type="date" name="vencimento"></label>` });
}
