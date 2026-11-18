// Fases 04–06 (docs 42–44) — "Canais de faturamento": SAIPOS (Resumo, Presencial, Anota Aí, Importações, Fechamento
// Manual, Conferências), iFood e 99Food (fontes oficiais) e Operadoras e Taxas. Só apresentação: os números vêm prontos do
// núcleo (nenhum cálculo de dinheiro aqui). Taxa pendente nunca aparece como zero; estimativa nunca aparece como recebido.
import { dataBR, esc, moeda, percentual } from "./formatar.js";
import { calendarioCanal } from "./telasCalendarioCanais.js";
import { conferenciaDoDinheiro, movimentosDoDia } from "./telasMovimentosCaixa.js";
import { importacoesDoCanal } from "./telasImportacoesCanais.js";

const valor = (c) => `<span class="${c === null || c === undefined ? "valor valor--desconhecido" : c < 0 ? "valor valor--negativo" : "valor"}">${esc(moeda(c))}</span>`;
const selo = (rotulo, classe, titulo = "") => `<span class="selo selo--${classe}"${titulo ? ` title="${esc(titulo)}"` : ""}>${esc(rotulo)}</span>`;
const td = (rotulo, conteudo, classe = "") => `<td data-rotulo="${esc(rotulo)}"${classe ? ` class="${classe}"` : ""}><span class="cel">${conteudo}</span></td>`;
const nenhum = (t) => `<p class="nota vazio-lista">${esc(t)}</p>`;
const cabecalho = (titulo, subtitulo) => `<header class="cabecalho"><div><h1>${esc(titulo)}</h1><p class="subtitulo">${subtitulo}</p></div></header>`;
const explicar = (titulo, texto) => `<details class="explica"><summary aria-label="Explicação: ${esc(titulo)}"><span aria-hidden="true">i</span></summary><p>${esc(texto)}</p></details>`;
const fechar = (titulo) => `<div class="painel-cabeca"><h2 id="painel-titulo">${esc(titulo)}</h2><button type="button" class="botao-fechar" data-fechar-painel aria-label="Fechar detalhe">×</button></div>`;
const tem = (perm, acao) => (perm ?? []).includes(acao);
let seq = 0;

/** Formulário de AÇÃO (mesmo contrato das demais telas: confirmação obrigatória; resultado anunciado). */
const formAcao = ({ url, titulo, campos, aviso, rotulo, recarregar = "lista", classe = "" }) => {
  const k = (seq += 1);
  return `<section class="card ${classe}" aria-labelledby="t-acao-c${k}"><h3 id="t-acao-c${k}">${esc(titulo)}</h3><form class="acao" data-acao="${esc(url)}" data-recarregar="${esc(recarregar)}">${campos}
<label class="caixa-marcar"><input type="checkbox" name="confirmar" required> ${esc(aviso)}</label>
<button type="submit" class="botao botao--primario">${esc(rotulo)}</button><p class="resultado-acao" role="status" aria-live="polite"></p></form></section>`;
};

export const ABAS_SAIPOS = Object.freeze([["resumo", "Resumo"], ["presencial", "Presencial"], ["anota", "Anota Aí"], ["importacoes", "Importações"], ["fechamento", "Fechamento manual"], ["conferencias", "Conferências"]]);
const MODALIDADES = Object.freeze({ CREDITO_A_VISTA: "Crédito (1x à vista)", DEBITO: "Débito", PIX: "Pix", DINHEIRO: "Dinheiro", VOUCHER: "Voucher / vale", OUTRA: "Outras formas" });
const ORDEM = ["CREDITO_A_VISTA", "DEBITO", "PIX", "DINHEIRO", "VOUCHER", "OUTRA"];
const OPERADORAS = Object.freeze({ STONE: "Stone", PAGBANK: "PagBank", MAQUININHA_IFOOD: "Maquininha do iFood", DIRETO: "Pix direto na conta", NAO_INFORMADA: "Operadora não informada", ANOTA_AI: "Anota AI (repasse)", OPERADORA_BENEFICIOS: "Operadora de benefícios" });
const BANDEIRAS = Object.freeze({ MASTERCARD: "Mastercard", VISA: "Visa", ELO: "Elo", AMEX: "American Express", HIPERCARD: "Hipercard", PLUXEE: "Pluxee", OUTRA: "Outra bandeira", NAO_INFORMADA: "Bandeira não informada", TODAS: "Todas as bandeiras", "—": "Sem bandeira" });
const nomeChave = (modalidade, k) => (modalidade === "PIX" ? OPERADORAS[k] ?? k : BANDEIRAS[k] ?? k);
const CONFERENCIA = Object.freeze({
  PENDENTE: ["Pendente", "alerta", "Há taxa não configurada ou recebimento sem confirmação: nada é presumido."],
  CALCULADO: ["Calculado", "info", "Taxa estimada pela tabela vigente na data da venda."],
  AGUARDANDO_EXTRATO: ["Aguardando extrato", "info", "Taxa calculada; o recebimento ainda não foi confirmado."],
  PARCIAL: ["Parcial", "alerta", "Só parte do valor tem recebimento confirmado."],
  CONCILIADO: ["Conciliado", "ok", "Recebido confirmado igual ao líquido esperado."],
  DIVERGENTE: ["Divergente", "erro", "Recebido confirmado diferente do líquido esperado."],
  NAO_SE_APLICA: ["Sem taxa de operadora", "neutro", "Forma sem operadora (ex.: dinheiro)."],
});
const seloConf = (k) => { const [r, c, t] = CONFERENCIA[k] ?? [k, "neutro", ""]; return selo(r, c, t); };
const pct = (m) => (m === null || m === undefined ? "—" : percentual(m));

/** Filtro de período (data única = início e fim iguais). */
export function filtroPeriodo(rota, f, extra = "") {
  return `<form class="filtros-locais" data-filtro-local="${esc(rota)}" aria-label="Período">
${extra}<label>De <input type="date" name="inicio" value="${esc(f.inicio ?? "")}" required></label>
<label>Até <input type="date" name="fim" value="${esc(f.fim ?? "")}" required></label>
<button type="submit" class="botao">Aplicar</button></form>`;
}
const abas = (atual) => `<nav class="abas abas--botoes" aria-label="Seções da SAIPOS">${ABAS_SAIPOS.map(([k, t]) => `<button type="button" data-aba-saipos="${k}"${k === atual ? ' aria-current="page"' : ""}>${esc(t)}</button>`).join("")}</nav>`;

// ------------------------------------------------------------------------------------------------- cards por modalidade
function cardModalidade(m, { canal, inicio, fim }) {
  const id = `card-${canal}-${m.modalidade}`;
  // Dinheiro/outras formas sem bandeira: nada a expandir — o link leva direto aos lançamentos que compõem o total.
  const semSubdivisao = m.bandeiras.length === 1 && m.bandeiras[0].bandeira === "—";
  const taxa = m.situacao === "PENDENTE" ? '<span class="valor valor--desconhecido">Taxa não configurada</span>' : m.situacao === "NAO_SE_APLICA" ? '<span class="nota">Sem taxa de operadora</span>' : valor(m.taxaCentavos);
  const linhas = m.bandeiras.map((b) => {
    const chave = `card:${canal}|${m.modalidade}|${b.bandeira}|${inicio}|${fim}`;
    const taxaB = b.situacao === "PENDENTE" ? "<span class=\"valor valor--desconhecido\">Não configurada</span>" : b.situacao === "NAO_SE_APLICA" ? "—" : valor(b.taxaCentavos);
    return `<tr>${td(m.modalidade === "PIX" ? "Operadora" : "Bandeira", `<strong>${esc(nomeChave(m.modalidade, b.bandeira))}</strong><br><span class="nota">${b.quantidade} pagamento(s)</span>`, "esquerda")}
${td("Bruto", valor(b.brutoCentavos))}${td("Taxa %", esc(pct(b.percentualEfetivoCentesimos)))}${td("Desconto R$", taxaB)}${td("Líquido esperado", b.brutoCalculadoCentavos ? valor(b.liquidoEsperadoCentavos) : "—")}
${td("Recebido", b.recebidoCentavos === null ? '<span class="nota">Não confirmado</span>' : valor(b.recebidoCentavos))}${td("Situação", seloConf(b.situacaoConferencia))}
${td("Ações", `<button type="button" class="botao-link" data-detalhe="${esc(chave)}">Ver lançamentos</button>`)}</tr>`;
  }).join("");
  return `<article class="card card--canal" data-modalidade="${esc(m.modalidade)}">
<div class="card-topo"><h3>${esc(MODALIDADES[m.modalidade] ?? m.modalidade)}</h3>${seloConf(m.situacaoConferencia)}</div>
<dl class="ficha ficha--compacta canal-numeros">
<dt>Bruto</dt><dd>${valor(m.brutoCentavos)}</dd>
<dt>Taxas estimadas</dt><dd>${taxa}</dd>
<dt>% efetivo</dt><dd>${esc(pct(m.percentualEfetivoCentesimos))}</dd>
<dt>Líquido esperado</dt><dd>${m.brutoCalculadoCentavos ? valor(m.liquidoEsperadoCentavos) : '<span class="nota">—</span>'}</dd>
<dt>Recebido</dt><dd>${m.recebidoCentavos === null ? '<span class="nota">Não confirmado</span>' : valor(m.recebidoCentavos)}</dd>
${m.diferencaCentavos !== null && m.diferencaCentavos !== undefined ? `<dt>Diferença</dt><dd>${valor(m.diferencaCentavos)}</dd>` : ""}
</dl>
${m.brutoSemCalculoCentavos ? `<p class="nota aviso--alerta">${esc(moeda(m.brutoSemCalculoCentavos))} sem taxa configurada: fora do líquido esperado (nunca considerado zero).</p>` : ""}
${semSubdivisao ? `<button type="button" class="botao-link" data-detalhe="${esc(`card:${canal}|${m.modalidade}|${m.bandeiras[0]?.bandeira ?? "—"}|${inicio}|${fim}`)}">Ver lançamentos (${m.quantidade})</button>` : m.bandeiras.length ? `<button type="button" class="no-alternar canal-expandir" aria-expanded="false" aria-controls="${esc(id)}" data-alternar>${m.modalidade === "PIX" ? "Ver por operadora" : "Ver por bandeira"} (${m.bandeiras.length})</button>
<div id="${esc(id)}" hidden><div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">${esc(MODALIDADES[m.modalidade] ?? m.modalidade)} por ${m.modalidade === "PIX" ? "operadora" : "bandeira"}</caption>
<thead><tr><th scope="col">${m.modalidade === "PIX" ? "Operadora" : "Bandeira"}</th><th scope="col">Bruto</th><th scope="col">Taxa %</th><th scope="col">Desconto R$</th><th scope="col">Líquido</th><th scope="col">Recebido</th><th scope="col">Situação</th><th scope="col"><span class="sr">Ações</span></th></tr></thead>
<tbody>${linhas}</tbody></table></div></div>` : ""}
</article>`;
}

function cardsDoCanal(dadosCanal, ctx) {
  const lista = dadosCanal?.modalidades;
  const t = dadosCanal?.total;
  if (!lista?.length || !t) return nenhum("Nenhuma venda no período. Sem relatório importado não há faturamento — ausência de dados não é zero confirmado.");
  const ordenadas = [...lista].sort((a, b) => (ORDEM.indexOf(a.modalidade) + 99 * (ORDEM.indexOf(a.modalidade) < 0)) - (ORDEM.indexOf(b.modalidade) + 99 * (ORDEM.indexOf(b.modalidade) < 0)));
  return `<section class="resumo" aria-label="Totais do canal">
<article class="card card--sec"><div class="card-topo"><h3>Bruto das formas de pagamento</h3>${explicar("Bruto", "Soma dos pagamentos das vendas do período (data da venda). Vendas sem pagamento identificado ficam fora: ver Conferências.")}</div><p>${valor(t.brutoCentavos)}</p></article>
<article class="card card--sec"><div class="card-topo"><h3>Taxas estimadas</h3>${explicar("Taxas estimadas", "Calculadas pela tabela da operadora vigente na data da venda. Estimativa: não é despesa lançada na DRE nem valor recebido.")}</div><p>${valor(t.taxaCentavos)}</p>${t.brutoSemCalculoCentavos ? `<p class="nota">${esc(moeda(t.brutoSemCalculoCentavos))} sem taxa configurada</p>` : ""}</article>
<article class="card card--sec"><div class="card-topo"><h3>Líquido esperado</h3>${explicar("Líquido esperado", "Bruto com taxa calculada menos a taxa estimada. Não inclui o que está sem taxa configurada e não é valor recebido.")}</div><p>${valor(t.liquidoEsperadoCentavos)}</p><p class="nota">% efetivo ${esc(pct(t.percentualEfetivoCentesimos))}</p></article>
</section>
<div class="canal-cards">${ordenadas.map((m) => cardModalidade(m, ctx)).join("")}</div>`;
}

// ------------------------------------------------------------------------------------------------------------ SAIPOS
export function saipos(d, f, ctx = {}) {
  const aba = ABAS_SAIPOS.some(([k]) => k === f.aba) ? f.aba : "resumo";
  const periodo = { inicio: f.inicio, fim: f.fim };
  const sub = `Presencial e Anota Aí · ${esc(dataBR(f.inicio))} a ${esc(dataBR(f.fim))}`;
  const topo = `${cabecalho("SAIPOS", sub)}${abas(aba)}${filtroPeriodo("saipos", { ...f, ...periodo }, `<input type="hidden" name="aba" value="${esc(aba)}">`)}`;
  if (aba === "fechamento") return topo + fechamentoManual(d, ctx);
  const c = d.canais ?? {};
  const calendario = () => calendarioCanal(ctx.calendario, { selecionado: ctx.calDia ?? null, erro: ctx.calendarioErro ?? null });
  if (aba === "presencial") return `${topo}<p class="aviso">Vendas presenciais (fichas) do relatório SAIPOS. Pix da maquininha do iFood é presencial — não é o canal iFood.</p>${calendario()}${cardsDoCanal(d.cards?.BALCAO, { canal: "BALCAO", ...periodo })}`;
  if (aba === "anota") return `${topo}<p class="aviso">Pedidos do Anota Aí: faturamento separado do Presencial.</p>${calendario()}${cardsDoCanal(d.cards?.ANOTA_AI, { canal: "ANOTA_AI", ...periodo })}`;
  if (aba === "importacoes") return `${topo}${importacoesDoCanal(ctx.importacoes, { erro: ctx.importacoesErro ?? null, periodoPadrao: { inicio: f.inicio, fim: f.fim } })}`;
  if (aba === "conferencias") {
    return `${topo}<section class="card"><h2>Pendências das importações</h2>
${d.divergencias?.length ? `<ul class="lista-simples">${d.divergencias.map((x) => `<li><span><strong>${esc(x.codigo.replaceAll("_", " ").toLowerCase())}</strong><br><span class="nota">${esc(x.exemplo)}</span></span><span>${x.quantidade} · ${valor(x.valorCentavos)}</span></li>`).join("")}</ul>` : nenhum("Nenhuma pendência nas importações do período.")}
<p class="nota">${d.propostas?.abertas ? `${d.propostas.abertas} proposta(s) ainda não aplicada(s).` : "Nenhuma proposta pendente."} <a class="botao-link" href="#/conferencias">Abrir a Central de Conferências</a></p></section>
<section class="card"><h2>Pedidos de plataformas no relatório SAIPOS</h2><p class="nota">Ficam SÓ para conferência: o faturamento do iFood e da 99Food vem das fontes oficiais.</p>
<ul class="lista-simples"><li><span>iFood</span><span>${d.soConferencia?.IFOOD?.pedidos ?? 0} pedido(s) · ${valor(d.soConferencia?.IFOOD?.totalCentavos ?? 0)}</span></li><li><span>99Food</span><span>${d.soConferencia?.NOVENTA_E_NOVE_FOOD?.pedidos ?? 0} pedido(s) · ${valor(d.soConferencia?.NOVENTA_E_NOVE_FOOD?.totalCentavos ?? 0)}</span></li></ul></section>`;
  }
  // resumo
  const canalCard = (titulo, x, aba2) => `<article class="card card--sec"><div class="card-topo"><h3>${esc(titulo)}</h3></div><p>${x?.brutoCentavos === null || x?.brutoCentavos === undefined ? '<span class="valor valor--desconhecido">Sem vendas no período</span>' : valor(x.brutoCentavos)}</p>
<p class="nota">${x?.vendas ?? 0} venda(s) em ${x?.dias ?? 0} dia(s)${x?.semPagamento?.vendas ? ` · ${x.semPagamento.vendas} sem pagamento identificado` : ""}${x?.provisorias?.vendas ? ` · <strong>${x.provisorias.vendas} provisória(s) manual(is): ${esc(moeda(x.provisorias.valorCentavos))}</strong>` : ""}</p><button type="button" class="botao-link" data-aba-saipos="${aba2}">Ver detalhes</button></article>`;
  return `${topo}<section class="resumo" aria-label="Faturamento SAIPOS">
${canalCard("Presencial", c.BALCAO, "presencial")}${canalCard("Anota Aí", c.ANOTA_AI, "anota")}
<article class="card card--sec"><div class="card-topo"><h3>Só conferência (não é faturamento SAIPOS)</h3>${explicar("Só conferência", "Pedidos iFood e 99Food que aparecem no relatório SAIPOS. O faturamento deles vem das fontes oficiais de cada plataforma.")}</div>
<p class="nota">iFood: ${d.soConferencia?.IFOOD?.pedidos ?? 0} pedido(s) · 99Food: ${d.soConferencia?.NOVENTA_E_NOVE_FOOD?.pedidos ?? 0} pedido(s)</p></article>
<article class="card card--sec"><div class="card-topo"><h3>Importações e pendências</h3></div><p class="nota">${d.importacoes?.length ?? 0} relatório(s) · ${d.diasComImportacao ?? 0} dia(s) com vendas importadas · ${d.propostas?.abertas ?? 0} proposta(s) pendente(s)</p><button type="button" class="botao-link" data-aba-saipos="conferencias">Ver conferências</button></article>
</section><p class="nota">${esc(d.observacao ?? "")}</p>`;
}

/** Painel: pagamentos (e vendas) que compõem um total de card. */
export function detalheDoCard(d) {
  const titulo = `${MODALIDADES[d.modalidade] ?? d.modalidade}${d.chave ? ` · ${nomeChave(d.modalidade, d.chave)}` : ""}`;
  return `${fechar(titulo)}<p class="nota">${esc(dataBR(d.periodoInicio))} a ${esc(dataBR(d.periodoFim))} · ${d.total} pagamento(s)${d.total > d.itens.length ? ` (mostrando ${d.itens.length})` : ""}. Taxa e líquido são estimativas.</p>
${d.itens.length ? `<ul class="lista-simples">${d.itens.map((x) => `<li><span><strong>${esc(dataBR(x.venda.data))}</strong> · ${esc(x.venda.descricao ?? "Venda")}${x.descricaoOriginal ? `<br><span class="nota">Na fonte: ${esc(x.descricaoOriginal)}</span>` : ""}<br><button type="button" class="botao-link" data-detalhe="venda:${esc(x.venda.id)}">Ver venda</button></span>
<span>${valor(x.brutoCentavos)}<br><span class="nota">${x.situacao === "CALCULADA" ? `taxa ${esc(moeda(x.taxaCentavos))} · líquido ${esc(moeda(x.liquidoEsperadoCentavos))}` : x.situacao === "NAO_SE_APLICA" ? "sem taxa de operadora" : "taxa não configurada"}</span></span></li>`).join("")}</ul>` : nenhum("Nada no período.")}`;
}

// ----------------------------------------------------------------------------------------------- fechamento manual
/** Grade FIXA do formulário — a mesma do servidor (fv2-integracao/escritas.js, GRADE_FECHAMENTO). */
export const GRADE_FECHAMENTO = Object.freeze([
  ["CREDITO", "Crédito (1x à vista)", ["MASTERCARD", "VISA", "ELO", "AMEX", "HIPERCARD", "OUTRA"]],
  ["DEBITO", "Débito", ["MASTERCARD", "VISA", "ELO", "OUTRA"]],
  ["PIX", "Pix (por operadora)", ["MAQUININHA_IFOOD", "STONE", "PAGBANK", "DIRETO"]],
  ["VOUCHER", "Voucher / vale", ["ALELO", "PLUXEE", "VR", "TICKET", "OUTRA"]],
  ["ANOTA_AI", "Anota Aí (separado do presencial)", [""]],
  ["OUTRA", "Outras formas", [""]],
  ["IFOOD_CONFERENCIA", "iFood — só conferência do caixa", [""]],
  ["NOVENTA_E_NOVE_FOOD_CONFERENCIA", "99Food — só conferência do caixa", [""]],
]);
const campo = (g, s, k) => `f_${g}${s ? `_${s}` : ""}_${k}`;
const reais = (nome, rotulo, extra = "") => `<label>${esc(rotulo)} <input type="text" name="${esc(nome)}" inputmode="decimal" pattern="[0-9.]{1,13}(,[0-9]{1,2})?" placeholder="0,00"${extra}></label>`;
const ROTULO_LINHA = Object.freeze({ DINHEIRO: "Dinheiro (vendas)", A_CONFERIR: "Vendas sem pagamento identificado", ANOTA_AI: "Anota Aí", OUTRA: "Outras formas", CREDITO: "Crédito", DEBITO: "Débito", PIX: "Pix", VOUCHER: "Voucher" });
const SITUACAO_LINHA = Object.freeze({ CONFERE: ["Confere", "ok"], DIVERGENTE: ["Divergente", "erro"], SO_MANUAL: ["Só no fechamento", "alerta"], SO_IMPORTADO: ["Só nas vendas", "alerta"] });
const SITUACAO_DIA = Object.freeze({
  CONFERE: ["Confere com a importação", "ok"], DIVERGENTE: ["Divergências com a importação", "erro"], SO_FECHAMENTO_MANUAL: ["Sem relatório importado", "alerta"],
  SEM_FECHAMENTO_MANUAL: ["Sem fechamento manual", "neutro"], SEM_MOVIMENTO: ["Sem movimento", "neutro"],
});

function formularioFechamento(d) {
  const hoje = d.periodoFim ?? "";
  const linhas = GRADE_FECHAMENTO.map(([g, titulo, subs]) => `<fieldset class="grade-fechamento"><legend>${esc(titulo)}</legend>
${subs.map((s) => `<div class="linha-fechamento"><span class="linha-fechamento__nome">${esc(s ? (g === "PIX" ? OPERADORAS[s] ?? s : BANDEIRAS[s] ?? s) : "Valor")}</span>${reais(campo(g, s, "esp"), "Esperado")}${reais(campo(g, s, "inf"), "Informado")}</div>`).join("")}</fieldset>`).join("");
  return formAcao({
    url: "/api/fv2/acoes/fechamento-manual/registrar", titulo: "Registrar fechamento de caixa", rotulo: "Registrar fechamento", classe: "card--fechamento",
    aviso: "Confirmo os valores informados pela equipe. O fechamento é conferência: não cria receita (o faturamento vem das importações).",
    campos: `<div class="grade-2">
<label>Data do movimento <input type="date" name="data" value="${esc(hoje)}" required></label>
<label>Caixa <input type="text" name="caixa" maxlength="40" placeholder="1" required></label>
<label>Responsável pela abertura <input type="text" name="responsavelAbertura" maxlength="80"></label>
<label>Responsável pelo fechamento <input type="text" name="responsavelFechamento" maxlength="80"></label>
<label>Abertura (hora) <input type="time" name="horaAbertura"></label>
<label>Fechamento (hora) <input type="time" name="horaFechamento"></label></div>
<fieldset class="grade-fechamento"><legend>Dinheiro</legend><div class="grade-3">
${reais("din_abertura", "Abertura do caixa")}${reais("din_vendas", "Vendas em dinheiro")}${reais("din_reforcos", "Reforços")}${reais("din_retiradas", "Retiradas")}${reais("din_transferencias", "Transferências")}${reais("din_informado", "Valor contado (informado)")}
</div><p class="nota">Esperado = abertura + vendas + reforços − retiradas − transferências. A diferença é calculada ao registrar.</p></fieldset>
${linhas}
<label>Observações <input type="text" name="observacao" maxlength="500"></label>
<label>Justificativa (só para corrigir um fechamento já registrado) <input type="text" name="justificativa" maxlength="500"></label>`,
  });
}

function caixaRegistrado(f) {
  const din = f.dados.dinheiro;
  const formas = f.dados.formas;
  return `<details class="caixa-fechado"><summary><strong>Caixa ${esc(f.caixa)}</strong> · ${esc(f.dados.responsavelFechamento ?? f.dados.responsavelAbertura ?? "responsável não informado")}${f.dados.horaAbertura ? ` · ${esc(f.dados.horaAbertura)}–${esc(f.dados.horaFechamento ?? "?")}` : ""} · presencial ${esc(moeda(f.dados.totais.presencialCentavos))}${f.versao > 1 ? ` ${selo(`corrigido (versão ${f.versao})`, "info")}` : ""}</summary>
<dl class="ficha ficha--compacta"><dt>Dinheiro esperado</dt><dd>${valor(din.esperadoCentavos)}</dd><dt>Dinheiro contado</dt><dd>${din.informadoCentavos === null ? "—" : valor(din.informadoCentavos)}</dd>
<dt>Diferença no dinheiro</dt><dd>${din.diferencaCentavos === null ? "—" : valor(din.diferencaCentavos)}</dd><dt>Anota Aí</dt><dd>${valor(f.dados.totais.anotaAiCentavos)}</dd><dt>Só conferência (iFood/99Food)</dt><dd>${valor(f.dados.totais.soConferenciaCentavos)}</dd></dl>
${formas.length ? `<ul class="lista-simples">${formas.map((x) => `<li><span>${esc(ROTULO_LINHA[x.grupo] ?? x.grupo.replaceAll("_", " ").toLowerCase())}${x.bandeira ? ` · ${esc(BANDEIRAS[x.bandeira] ?? x.bandeira)}` : ""}${x.operadora ? ` · ${esc(OPERADORAS[x.operadora] ?? x.operadora)}` : ""}</span><span>${valor(x.informadoCentavos)}${x.diferencaCentavos !== null ? ` <span class="nota">(dif. ${esc(moeda(x.diferencaCentavos))})</span>` : ""}</span></li>`).join("")}</ul>` : ""}
${f.observacao ? `<p class="nota">${esc(f.observacao)}</p>` : ""}</details>`;
}

function formulariosFaturamento(d, ctx) {
  if (!tem(ctx.permissoes, "financeiro_v2.registrar")) return "";
  const linhas = GRADE_FECHAMENTO.filter(([g]) => !g.endsWith("_CONFERENCIA")).map(([g, titulo, subs]) => `<fieldset class="grade-fechamento"><legend>${esc(titulo)}</legend><div class="grade-3">
${subs.map((x) => reais(campo(g, x, "inf"), x ? (g === "PIX" ? OPERADORAS[x] ?? x : BANDEIRAS[x] ?? x) : "Valor")).join("")}</div></fieldset>`).join("");
  const registrar = formAcao({
    url: "/api/fv2/acoes/faturamento-manual/registrar", titulo: "Registrar faturamento manualmente (provisório)", rotulo: "Registrar faturamento provisório", classe: "card--fechamento",
    aviso: "Confirmo: este faturamento é PROVISÓRIO, de origem manual, sujeito a conferência. Quando o relatório SAIPOS do dia chegar, ele precisa ser substituído (operação auditada) antes da importação entrar.",
    campos: `<p class="aviso">Use só quando não houver relatório SAIPOS importado do dia. Preencher o fechamento de caixa NÃO cria faturamento — esta é uma ação separada.</p>
<div class="grade-3"><label>Data <input type="date" name="data" value="${esc(d.periodoFim ?? "")}" required></label><label>Caixa <input type="text" name="caixa" maxlength="40" required></label>
<label>Canal <select name="canal" required><option value="BALCAO">Presencial</option><option value="ANOTA_AI">Anota Aí</option></select></label></div>
${reais("din_vendas", "Vendas em dinheiro")}
${linhas}
<label>Justificativa (origem do valor) <input type="text" name="justificativa" maxlength="300" required placeholder="Fechamento enviado pela equipe; relatório SAIPOS ainda não importado"></label>`,
  });
  const substituir = tem(ctx.permissoes, "financeiro_v2.cancelar") ? formAcao({
    url: "/api/fv2/acoes/faturamento-manual/substituir", titulo: "Substituir faturamento provisório pela importação oficial", rotulo: "Substituir provisório",
    aviso: "Confirmo: o faturamento provisório do dia e canal será cancelado (com histórico; nada é apagado) para a venda importada entrar no lugar.",
    campos: `<div class="grade-3"><label>Data <input type="date" name="data" required></label><label>Canal <select name="canal"><option value="BALCAO">Presencial</option><option value="ANOTA_AI">Anota Aí</option></select></label>
<label>Justificativa <input type="text" name="justificativa" maxlength="400" required></label></div>`,
  }) : "";
  return `<details class="card"${ctx.abrirProvisorio ? " open" : ""}><summary><strong>Faturamento manual provisório</strong> — quando ainda não há relatório SAIPOS do dia</summary>${registrar}${substituir}</details>`;
}

export function fechamentoManual(d, ctx = {}) {
  const dias = d.dias ?? [];
  const lista = dias.length ? dias.map((dia) => {
    const [r, c] = SITUACAO_DIA[dia.situacao] ?? [dia.situacao, "neutro"];
    return `<section class="card" aria-label="Dia ${esc(dataBR(dia.data))}"><div class="card-topo"><h2>${esc(dataBR(dia.data))}</h2>${selo(r, c)}</div><p class="nota">${esc(dia.observacao)}</p>
${dia.fechamentos.map(caixaRegistrado).join("")}
${movimentosDoDia(dia.movimentosDeCaixa)}${dia.movimentosDeCaixa ? conferenciaDoDinheiro(dia.dinheiroDoDia) : ""}
${dia.provisorias?.length ? `<p class="aviso aviso--alerta">${dia.provisorias.length} faturamento(s) manual(is) PROVISÓRIO(S) neste dia: ${dia.provisorias.map((x) => `${esc(x.canal === "ANOTA_AI" ? "Anota Aí" : "Presencial")} · caixa ${esc(x.caixa)} · ${esc(moeda(x.brutoCentavos))}`).join("; ")}. A importação SAIPOS do dia só entra depois da substituição.</p>` : ""}
${dia.comparacao.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Fechamento manual × importação em ${esc(dataBR(dia.data))}</caption><thead><tr><th scope="col">Forma</th><th scope="col">Fechamento</th><th scope="col">Vendas registradas</th><th scope="col">Diferença</th><th scope="col">Situação</th></tr></thead><tbody>
${dia.comparacao.map((l) => { const [rr, cc] = SITUACAO_LINHA[l.situacao] ?? [l.situacao, "neutro"]; return `<tr>${td("Forma", `${esc(ROTULO_LINHA[l.grupo] ?? l.grupo)}${l.sub ? ` · ${esc(l.grupo === "PIX" ? OPERADORAS[l.sub] ?? l.sub : BANDEIRAS[l.sub] ?? l.sub)}` : ""}`, "esquerda")}${td("Fechamento", l.manualCentavos === null ? "—" : valor(l.manualCentavos))}${td("Vendas registradas", l.importadoCentavos === null ? "—" : valor(l.importadoCentavos))}${td("Diferença", l.diferencaCentavos === null ? "—" : valor(l.diferencaCentavos))}${td("Situação", selo(rr, cc))}</tr>`; }).join("")}
</tbody></table></div>` : ""}</section>`;
  }).join("") : nenhum("Nenhum fechamento nem venda no período.");
  return `<p class="aviso">O fechamento manual registra o que a equipe informou, por caixa. Ele <strong>confere</strong> o faturamento importado e nunca soma receita. Sem relatório importado, o dia fica como "sem relatório importado".</p>
${tem(ctx.permissoes, "financeiro_v2.registrar") ? formularioFechamento(d) : '<p class="nota">Você não tem permissão para registrar fechamentos nesta unidade.</p>'}
${formulariosFaturamento(d, ctx)}
${lista}`;
}

// -------------------------------------------------------------------------------------------- iFood e 99Food (oficiais)
const SITUACAO_PLATAFORMA = Object.freeze({
  PRELIMINAR: ["Preliminar — sem demonstrativo oficial", "alerta"], CONFIRMADO: ["Confirmado pela fonte oficial", "ok"],
  CONFIRMADO_COM_REPASSE_PENDENTE: ["Confirmado · repasse pendente", "info"], SEM_FONTE_OFICIAL: ["Sem relatório oficial", "neutro"],
  IMPORTADO: ["Importado · ainda não aplicado", "alerta"], AGUARDANDO_CONFERENCIA: ["Aguardando conferência", "info"], DIVERGENTE: ["Divergente", "erro"], CONCILIADO: ["Conciliado", "ok"],
});
const REPASSE = Object.freeze({ SEM_CICLO: ["Aguardando identificação", "alerta"], RECEBIDO: ["Recebido", "ok"], PARCIAL: ["Parcial", "alerta"], PREVISTO: ["Previsto", "info"], ATRASADO: ["Atrasado", "erro"], SEM_RECEBIVEL: ["Sem recebível", "neutro"] });
const depende = (texto = "Depende do relatório oficial") => `<span class="valor valor--desconhecido">${esc(texto)}</span>`;

/** iFood e 99Food: SÓ fontes oficiais. Totais vêm prontos do servidor; ausência aparece como ausência (nunca zero). */
export function plataforma(d, ctx = {}) {
  const ifood = d.canal === "IFOOD";
  const nome = ifood ? "iFood" : "99Food";
  const [rs, cs] = SITUACAO_PLATAFORMA[d.situacao] ?? [d.situacao, "neutro"];
  const t = d.totais;
  const v = (k) => (!t ? depende() : t[k] === null ? '<span class="nota">Não informado no relatório</span>' : valor(t[k]));
  const cards = [
    ["Faturamento bruto", v("brutoCentavos"), "Vendas do período pelo relatório oficial da plataforma."],
    ["Pedidos e cancelamentos", t && t.pedidos !== null ? `${t.pedidos}${t.cancelamentos === null ? "" : ` · ${t.cancelamentos}`}` : depende("Depende do relatório de pedidos"), t?.observacaoPedidos ?? "O relatório oficial de pedidos ainda não é importado."],
    ["Descontos e promoções", v("descontosEPromocoesCentavos"), "Serviços e promoções sem decomposição no demonstrativo: dedução a classificar."],
    ["Comissões", v("comissoesCentavos"), "Comissão do marketplace (não é taxa de maquininha)."],
    ["Taxas", v("taxasCentavos"), "Taxa de transação do pagamento online."],
    ["Mensalidade", v("mensalidadesCentavos"), "Mensalidade da plataforma no período."],
    ["Ajustes", v("ajustesCentavos"), "Ajustes informados pela plataforma."],
    ...(t?.marketingCentavos !== undefined ? [["Marketing", v("marketingCentavos"), "Despesas de marketing informadas pela 99Food."], ["Resultado gerencial preliminar", v("resultadoPreliminarCentavos"), "Vendas de itens − taxas − comissões − marketing. Pode mudar quando a diferença para o repasse for explicada."], ["Diferença em conferência", v("diferencaRepasseCentavos"), `Resultado preliminar − repasse informado. ${t?.diasDivergentes ?? 0} dia(s) divergente(s). Não é receita nem despesa.`], ["Recompensas (em conferência)", v("recompensasCentavos"), "Valor informado pela plataforma. Não entra na DRE até confirmar como compõe as vendas ou o repasse."]] : []),
    [t?.marketingCentavos !== undefined ? "Repasse informado" : "Repasse previsto", v("repassePrevistoCentavos"), t?.marketingCentavos !== undefined ? "Valor informado pela 99Food, sem data de pagamento. Não é recebível nem depósito." : "Líquido a receber da plataforma (recebível). Não é depósito."],
    ["Repasse recebido", t ? (t.repasseRecebidoCentavos ? valor(t.repasseRecebidoCentavos) : '<span class="nota">Nenhum repasse confirmado</span>') : depende(), "Só o que já foi liquidado com a entrada no banco."],
  ].map(([titulo, conteudo, exp]) => `<article class="card card--sec"><div class="card-topo"><h3>${esc(titulo)}</h3>${explicar(titulo, exp)}</div><p>${conteudo}</p></article>`).join("");
  const historico = d.historico?.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Demonstrativos oficiais registrados</caption><thead><tr><th scope="col">Período</th><th scope="col">Bruto</th><th scope="col">Repasse previsto</th><th scope="col">Recebido</th><th scope="col">Repasse</th></tr></thead><tbody>
${d.historico.map((x) => { const [r, c] = REPASSE[x.situacaoRepasse] ?? [x.situacaoRepasse, "neutro"]; return `<tr>${td("Período", `${esc(dataBR(x.periodoInicio))} a ${esc(dataBR(x.periodoFim))}`, "esquerda")}${td("Bruto", valor(x.brutoCentavos))}${td("Repasse previsto", valor(x.repassePrevistoCentavos))}${td("Recebido", valor(x.repasseRecebidoCentavos))}${td("Repasse", selo(r, c))}</tr>`; }).join("")}
</tbody></table></div>` : nenhum(ifood ? "Nenhum demonstrativo oficial registrado." : "Nenhum relatório oficial importado.");
  const cs2 = d.conferenciaSaipos;
  const aba = ctx.aba === "importacoes" ? "importacoes" : "resumo";
  const abasDoCanal = `<nav class="abas abas--botoes" aria-label="Seções de ${esc(nome)}">${[["resumo", "Resumo"], ["importacoes", "Importações"]].map(([k, t]) => `<button type="button" data-aba-canal="${k}"${k === aba ? ' aria-current="page"' : ""}>${t}</button>`).join("")}</nav>`;
  if (aba === "importacoes") return `${cabecalho(nome, `Importações pela fonte oficial · ${esc(d.competencia ?? "")}`)}${abasDoCanal}${importacoesDoCanal(ctx.importacoes, { erro: ctx.importacoesErro ?? null })}`;
  return `${cabecalho(nome, `Faturamento pela fonte oficial · ${esc(d.competencia ?? "")}`)}${abasDoCanal}
<p>${selo(rs, cs)}${d.fonteOficial ? ` <span class="nota">Fonte: ${esc(d.fonteOficial)}</span>` : ""}</p>
${d.dependeDeRelatorioOficial ? '<p class="aviso">Ainda não há relatório oficial da 99Food nesta competência, e nenhum número é presumido. Para ver os valores, envie o arquivo Dados da loja na aba Importações.</p>' : ""}
${calendarioCanal(ctx.calendario, { selecionado: ctx.calDia ?? null, erro: ctx.calendarioErro ?? null })}
<section class="resumo" aria-label="Números do canal ${esc(nome)}">${cards}</section>
${d.pendencias?.length ? `<section class="card card--alertas"><h2>Pendências de conciliação</h2><ul class="lista-simples">${d.pendencias.map((p) => `<li><span>${esc(p.mensagem)}</span>${p.valorCentavos ? valor(p.valorCentavos) : ""}</li>`).join("")}</ul></section>` : ""}
${ifood && d.conciliacao && tem(ctx.permissoes, "financeiro_v2.conciliar") ? `<section class="card"><h2>Repasses × extrato</h2><p class="nota">Procura, nos créditos que já estão na conta, os que podem ser estes repasses. Nada é baixado aqui: a confirmação é feita em Importações e Conferências.</p>
<form class="acao" data-acao="/api/fv2/acoes/conciliacoes/gerar-repasses-ifood" data-recarregar="lista"><label class="caixa-marcar"><input type="checkbox" name="confirmar" required> Quero procurar os créditos no extrato.</label><button type="submit" class="botao">Procurar créditos no extrato</button><p class="resultado-acao" role="status" aria-live="polite"></p></form></section>` : ""}
<section class="card"><div class="card-topo"><h2>Histórico de importações</h2>${ifood && tem(ctx.permissoes, "financeiro_v2.registrar") ? '<button type="button" class="botao-link" data-aba-canal="importacoes">Registrar demonstrativo (aba Importações)</button>' : ""}</div>${historico}</section>
<section class="card"><h2>Pedidos no relatório SAIPOS — só conferência</h2><p class="nota">${cs2 ? `${cs2.pedidos} pedido(s) · ${cs2.cancelados} cancelado(s) · ${esc(moeda(cs2.totalCentavos))}` : "—"}. Não entram no faturamento: a SAIPOS não é fonte oficial ${ifood ? "do iFood" : "da 99Food"}.</p></section>`;
}

// ------------------------------------------------------------------------------------------------ Operadoras e Taxas
// 18/11/2026: taxas informadas numa GRADE (bandeira × modalidade da operadora), dentro do card de cada operadora; a grade é
// convertida no MESMO formato que o servidor já valida ("MODALIDADE;BANDEIRA;PERCENTUAL[;TARIFA]"). Campo vazio = taxa não
// configurada (nunca zero). Modalidades da operadora em caixas de marcar.
const fmtMilesimos = (m) => { const t = String(m).padStart(4, "0"); return `${t.slice(0, -3)},${t.slice(-3).replace(/0+$/, "").padEnd(2, "0")}%`; };
const milesimosParaCampo = (m) => { const t = String(m).padStart(4, "0"); return `${t.slice(0, -3)},${t.slice(-3).replace(/0+$/, "").padEnd(2, "0")}`; };
const centavosParaCampo = (c) => `${Math.trunc(c / 100)},${String(c % 100).padStart(2, "0")}`;
const MOD_TAXA = Object.freeze({ DEBITO: "Débito", CREDITO_A_VISTA: "Crédito 1x", PIX: "Pix", VOUCHER: "Voucher / vale" });
const ORDEM_MOD = ["DEBITO", "CREDITO_A_VISTA", "PIX", "VOUCHER"];
const AJUDA_MOD = Object.freeze({
  DEBITO: "Cartão de débito na maquininha.",
  CREDITO_A_VISTA: "Cartão de crédito à vista (1x). Parcelado não é usado na loja.",
  PIX: "Pix recebido pela maquininha (QR da operadora).",
  VOUCHER: "Vale-refeição/alimentação passado na maquininha.",
});
/** Bandeiras oferecidas na grade (as que a SAIPOS reconhece primeiro). */
export const BANDEIRAS_CARTAO = Object.freeze([["MASTERCARD", "Mastercard"], ["VISA", "Visa"], ["ELO", "Elo"], ["HIPERCARD", "Hipercard"], ["AMEX", "American Express"], ["DINERS", "Diners"], ["CABAL", "Cabal"], ["BANESCARD", "Banescard"], ["UNIONPAY", "UnionPay"]]);
export const BANDEIRAS_VOUCHER = Object.freeze([["ALELO", "Alelo"], ["PLUXEE", "Pluxee (Sodexo)"], ["TICKET", "Ticket"], ["VR", "VR"]]);
const nomeBandeira = (k) => [...BANDEIRAS_CARTAO, ...BANDEIRAS_VOUCHER].find(([c]) => c === k)?.[1] ?? BANDEIRAS[k] ?? k;
const PROCESSADORES = Object.freeze({ STONE: "Stone", PAGBANK: "PagBank", MAQUININHA_IFOOD: "Maquininha do iFood (presencial)", MAQUINA_TERCEIROS: "Máquina de terceiros", OPERADORA_BENEFICIOS: "Operadora de benefícios" });
const hojeISO = () => new Date().toISOString().slice(0, 10);
/** Linhas (bandeiras) de uma modalidade. */
const linhasDa = (mod) => (mod === "PIX" ? [["PIX", "Pix"]] : mod === "VOUCHER" ? BANDEIRAS_VOUCHER : BANDEIRAS_CARTAO);

/** Tabela vigente HOJE (ou a mais recente) de uma operadora. */
function tabelaAtual(o) {
  const hoje = hojeISO();
  const vig = o.tabelas.filter((t) => t.vigenciaInicio <= hoje && (!t.vigenciaFim || hoje <= t.vigenciaFim));
  return [...(vig.length ? vig : o.tabelas)].sort((a, b) => b.vigenciaInicio.localeCompare(a.vigenciaInicio))[0] ?? null;
}

/** Quadro de LEITURA: bandeira × modalidade, com "não configurada" onde não há taxa. */
function quadroTaxas(o, t) {
  const mods = ORDEM_MOD.filter((m) => o.modalidades.includes(m) || t.taxas.some((x) => x.modalidade === m));
  const achar = (m, b) => t.taxas.find((x) => x.modalidade === m && (m === "PIX" || x.bandeira === b));
  const partes = mods.map((m) => {
    const linhas = linhasDa(m).filter(([b]) => m === "PIX" || achar(m, b) || BANDEIRAS_CARTAO.slice(0, 3).some(([c]) => c === b) || m === "VOUCHER");
    const extras = t.taxas.filter((x) => x.modalidade === m && m !== "PIX" && !linhasDa(m).some(([b]) => b === x.bandeira)).map((x) => [x.bandeira, nomeBandeira(x.bandeira)]);
    return `<div class="taxas-mod"><h4>${esc(MOD_TAXA[m] ?? m)}</h4><ul class="taxas-lista">${[...linhas, ...extras].map(([b, nome]) => {
      const x = achar(m, b);
      return `<li><span>${esc(m === "PIX" ? "Pix" : nome)}</span>${x ? `<strong>${esc(fmtMilesimos(x.milesimos))}${x.tarifaFixaCentavos ? ` + ${esc(moeda(x.tarifaFixaCentavos))}` : ""}</strong>` : '<span class="valor valor--desconhecido">não configurada</span>'}</li>`;
    }).join("")}</ul></div>`;
  });
  return `<div class="taxas-quadro">${partes.join("")}</div>`;
}

/** Formulário de taxas em GRADE para UMA operadora (pré-preenchido com a tabela atual, se houver). */
function formGradeTaxas(o, atual) {
  const k = (seq += 1);
  const mods = ORDEM_MOD.filter((m) => o.modalidades.includes(m));
  const valorDe = (m, b, campo) => {
    const x = atual?.taxas.find((y) => y.modalidade === m && (m === "PIX" || y.bandeira === b));
    if (!x) return "";
    return campo === "pct" ? milesimosParaCampo(x.milesimos) : x.tarifaFixaCentavos ? centavosParaCampo(x.tarifaFixaCentavos) : "";
  };
  const inicioSugerido = atual ? hojeISO() : o.inicio ?? hojeISO();
  const secoes = mods.map((m) => `<fieldset class="grade-taxas-mod"><legend>${esc(MOD_TAXA[m])} <span class="nota">${esc(AJUDA_MOD[m])}</span></legend>
${m === "PIX" ? "" : `<div class="grade-taxas-replicar"><label>Mesma taxa para todas as bandeiras <input type="text" inputmode="decimal" placeholder="ex.: 1,42" data-replicar-valor="${m}" aria-label="Taxa para todas as bandeiras de ${esc(MOD_TAXA[m])}"></label><button type="button" class="botao" data-replicar-taxa="${m}">Aplicar a todas</button></div>`}
<table class="tabela grade-taxas"><thead><tr><th scope="col">${m === "PIX" ? "Modalidade" : "Bandeira"}</th><th scope="col">Taxa (%)</th><th scope="col">Tarifa fixa (R$) <span class="nota">opcional</span></th></tr></thead><tbody>
${linhasDa(m).map(([b, nome]) => `<tr><th scope="row">${esc(m === "PIX" ? "Pix" : nome)}</th>
<td data-rotulo="Taxa (%)"><input type="text" inputmode="decimal" class="campo-taxa" name="tx|${m}|${b}" value="${esc(valorDe(m, b, "pct"))}" placeholder="não configurada" pattern="\\d{1,2}([,.]\\d{1,3})?" aria-label="Taxa ${esc(MOD_TAXA[m])} ${esc(nome)} em %"></td>
<td data-rotulo="Tarifa fixa (R$)"><input type="text" inputmode="decimal" class="campo-tarifa" name="tf|${m}|${b}" value="${esc(valorDe(m, b, "tf"))}" placeholder="—" pattern="\\d{1,4}([,.]\\d{1,2})?" aria-label="Tarifa fixa ${esc(MOD_TAXA[m])} ${esc(nome)} em reais"></td></tr>`).join("")}
</tbody></table></fieldset>`).join("");
  return `<details class="grade-taxas-bloco"${atual ? "" : " open"}><summary class="botao botao--primario">${atual ? "Nova versão das taxas" : "Informar taxas"}</summary>
<form class="acao acao--embutida" data-acao="/api/fv2/acoes/configuracoes/taxas-contratadas" data-recarregar="lista" data-grade-taxas aria-labelledby="t-grade-${k}">
<h3 id="t-grade-${k}">Taxas da ${esc(o.nome)}</h3><input type="hidden" name="operadora" value="${esc(o.codigo)}"><input type="hidden" name="taxas" value="">
<p class="nota">Preencha só o que a operadora cobra. Campo vazio fica como <strong>não configurada</strong> (nunca zero). Use vírgula: 1,42.${atual ? " Os campos já vêm com a tabela atual: altere o que mudou." : ""}</p>
<div class="grade-3"><label>Valem a partir de <input type="date" name="vigenciaInicio" value="${esc(inicioSugerido)}" required></label><label>Até (opcional) <input type="date" name="vigenciaFim"></label><label>Prazo de recebimento (opcional) <input type="text" name="prazoDeRecebimento" maxlength="60" placeholder="ex.: mesmo dia, D+1, 30 dias"></label></div>
${secoes}
<div class="grade-2"><label>De onde vieram as taxas <input type="text" name="fonte" maxlength="300" placeholder="ex.: app da operadora, tela Taxas e Tarifas" required></label><label>Justificativa <input type="text" name="justificativa" maxlength="500" placeholder="ex.: taxas da maquininha nova" required></label></div>
${atual ? `<p class="nota">Se a tabela atual não tiver fim, informe "Até" nela antes (alterando a operadora) ou use um início depois do fim dela: vigências não podem se sobrepor.</p>` : ""}
<label class="caixa-marcar"><input type="checkbox" name="confirmar" required> Confirmo as taxas. Vendas já registradas não mudam; as novas usam a taxa da data da venda.</label>
<button type="submit" class="botao botao--primario">Salvar taxas</button><p class="resultado-acao" role="status" aria-live="polite"></p></form></details>`;
}

const NOME_OPERADORA_PAINEL = Object.freeze({ SEM_OPERADORA: "Sem operadora no dia da venda", AMBIGUA: "Duas operadoras ativas (em conferência)" });
/** 18/11/2026 — painel do período: bruto, taxa estimada e líquido esperado por modalidade e por operadora (números do servidor). */
function painelTaxas(p, ops, f) {
  const nomeOp = (k) => ops.find((o) => o.codigo === k)?.nome ?? NOME_OPERADORA_PAINEL[k] ?? OPERADORAS[k] ?? k;
  const t = p.total;
  const linhaMod = (m, rotulo) => `<tr>${td("Modalidade", `<strong>${esc(rotulo)}</strong>`, "esquerda")}${td("Vendas", String(m.quantidade))}${td("Bruto", valor(m.brutoCentavos))}${td("Taxa", m.brutoCalculadoCentavos ? valor(m.taxaCentavos) : '<span class="valor valor--desconhecido">não configurada</span>')}${td("Taxa efetiva", esc(pct(m.percentualEfetivoCentesimos)))}${td("Líquido esperado", m.brutoCalculadoCentavos ? valor(m.liquidoEsperadoCentavos) : "—")}${td("Sem taxa", m.brutoSemCalculoCentavos ? valor(m.brutoSemCalculoCentavos) : "—")}</tr>`;
  const cabecaTabela = `<thead><tr><th scope="col">Modalidade</th><th scope="col">Vendas</th><th scope="col">Bruto</th><th scope="col">Taxa estimada</th><th scope="col">Taxa efetiva</th><th scope="col">Líquido esperado</th><th scope="col">Sem taxa configurada</th></tr></thead>`;
  const ordenar = (lista) => [...lista].sort((a, b) => ORDEM.indexOf(a.modalidade) - ORDEM.indexOf(b.modalidade));
  const kpis = t ? `<div class="painel-taxas-kpis">
<article class="card card--sec"><h3>Bruto nas maquininhas</h3><p>${valor(t.brutoCentavos)}</p><p class="nota">${t.quantidade} pagamento(s)</p></article>
<article class="card card--sec"><div class="card-topo"><h3>Taxas estimadas</h3>${explicar("Taxas estimadas", "Calculadas pela tabela de cada operadora vigente na data da venda. É estimativa: o valor cobrado de fato vem do relatório da operadora.")}</div><p>${valor(t.taxaCentavos)}</p><p class="nota">taxa efetiva ${esc(pct(t.percentualEfetivoCentesimos))}</p></article>
<article class="card card--sec"><h3>Líquido esperado</h3><p>${valor(t.liquidoEsperadoCentavos)}</p><p class="nota">${t.brutoSemCalculoCentavos ? "da parte com taxa configurada" : "o que deve cair na conta"}</p></article>
${t.brutoSemCalculoCentavos ? `<article class="card card--sec card--alerta"><h3>Sem taxa configurada</h3><p>${valor(t.brutoSemCalculoCentavos)}</p><p class="nota">informe a taxa da operadora para calcular</p></article>` : ""}</div>` : "";
  const porOperadora = p.operadoras.map((o) => `<details class="painel-operadora"><summary><strong>${esc(nomeOp(o.operadora))}</strong> · bruto ${esc(moeda(o.total.brutoCentavos))} · taxa ${o.total.brutoCalculadoCentavos ? esc(moeda(o.total.taxaCentavos)) : "não configurada"} · líquido ${o.total.brutoCalculadoCentavos ? esc(moeda(o.total.liquidoEsperadoCentavos)) : "—"}</summary>
${ordenar(o.modalidades).map((m) => `<h4>${esc(MODALIDADES[m.modalidade] ?? m.modalidade)}</h4><div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">${esc(nomeOp(o.operadora))} — ${esc(MODALIDADES[m.modalidade] ?? m.modalidade)} por ${m.modalidade === "PIX" ? "operadora" : "bandeira"}</caption><thead><tr><th scope="col">${m.modalidade === "PIX" ? "Pix" : "Bandeira"}</th><th scope="col">Vendas</th><th scope="col">Bruto</th><th scope="col">Taxa estimada</th><th scope="col">Taxa efetiva</th><th scope="col">Líquido esperado</th><th scope="col">Sem taxa configurada</th></tr></thead><tbody>${m.bandeiras.map((b) => linhaMod({ ...b }, m.modalidade === "PIX" ? "Pix" : nomeBandeira(b.bandeira))).join("")}</tbody></table></div>`).join("")}</details>`).join("");
  return `<section class="card painel-taxas" aria-labelledby="t-painel-taxas"><div class="card-topo"><h2 id="t-painel-taxas">Painel do período</h2>${selo("Estimativa", "info", p.observacao)}</div>
${filtroPeriodo("operadoras-taxas", f)}
${t ? `${kpis}<h3>Por modalidade</h3><div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Totais por modalidade</caption>${cabecaTabela}<tbody>${ordenar(p.porModalidade).map((m) => linhaMod(m, MODALIDADES[m.modalidade] ?? m.modalidade)).join("")}</tbody></table></div>
<h3>Por operadora</h3>${porOperadora}` : nenhum("Nenhuma venda em maquininha no período.")}
<p class="nota">Estimativa: não é despesa lançada na DRE nem valor recebido. A taxa cobrada de fato entra pelo relatório da operadora.</p></section>`;
}

export function operadorasTaxas(d, ctx = {}) {
  const pode = tem(ctx.permissoes, "financeiro_v2.configurar");
  const ops = [...(d.operadoras ?? [])].sort((a, b) => Number(a.situacao === "INATIVA") - Number(b.situacao === "INATIVA"));
  const cards = ops.length ? ops.map((o) => {
    const ativa = o.situacao !== "INATIVA";
    const atual = tabelaAtual(o);
    const antigas = o.tabelas.filter((t) => t !== atual).sort((a, b) => b.vigenciaInicio.localeCompare(a.vigenciaInicio));
    const faltam = atual ? null : "Sem taxas: as vendas desta operadora aparecem como “Taxa não configurada” (nunca zero).";
    return `<article class="card card-operadora${ativa ? "" : " card-operadora--inativa"}" aria-label="Operadora ${esc(o.nome)}"><div class="card-topo"><h2>${esc(o.nome)}</h2>${selo(ativa ? "Ativa" : "Inativa", ativa ? "ok" : "neutro")}${o.implicita ? selo("Sem cadastro (tabela antiga)", "info") : ""}${ativa && !atual ? selo("Taxas pendentes", "alerta") : ""}</div>
<p class="operadora-resumo">${esc(PROCESSADORES[o.processador] ?? o.processador)} · ${o.implicita ? "sem datas" : `${esc(dataBR(o.inicio))} a ${o.encerramento ? esc(dataBR(o.encerramento)) : "em aberto"}`} · ${o.modalidades.map((m) => `<span class="selo selo--neutro">${esc(MOD_TAXA[m] ?? m)}</span>`).join(" ")}</p>
${atual ? `<h3>Taxas ${atual.vigenciaFim ? "" : "vigentes "}<span class="nota">(${esc(dataBR(atual.vigenciaInicio))} a ${atual.vigenciaFim ? esc(dataBR(atual.vigenciaFim)) : "em aberto"}${atual.prazoDeRecebimento ? ` · recebimento: ${esc(atual.prazoDeRecebimento)}` : ""})</span></h3>${quadroTaxas(o, atual)}<p class="nota">Fonte: ${esc(atual.fonte)}${atual.registradaEm ? ` · registrada em ${esc(dataBR(atual.registradaEm))}` : ""}</p>` : `<p class="aviso">${esc(faltam)}</p>`}
${antigas.length ? `<details class="versao-taxas"><summary>Versões anteriores (${antigas.length})</summary>${antigas.map((t) => `<h4>${esc(dataBR(t.vigenciaInicio))} a ${t.vigenciaFim ? esc(dataBR(t.vigenciaFim)) : "em aberto"}</h4>${quadroTaxas(o, t)}<p class="nota">Fonte: ${esc(t.fonte)}</p>`).join("")}</details>` : ""}
${pode && ativa ? formGradeTaxas(o, atual) : ""}
${o.historico?.length ? `<details><summary>Histórico (${o.historico.length})</summary><ul class="lista-simples">${o.historico.map((h) => `<li><span>${esc(h.evento === "CADASTRO" ? "Cadastro" : "Alteração")}${h.situacao ? ` · ${esc(h.situacao.toLowerCase())}` : ""}${h.encerramento !== undefined ? ` · encerramento ${h.encerramento ? esc(dataBR(h.encerramento)) : "removido"}` : ""}${h.nome ? ` · nome "${esc(h.nome)}"` : ""}<br><span class="nota">${esc(h.justificativa ?? "")}</span></span><span class="nota">${esc(dataBR(h.em))}</span></li>`).join("")}</ul></details>` : ""}
${pode && !o.implicita ? `<details><summary>Alterar operadora (nome, situação, encerramento)</summary><form class="acao acao--embutida" data-acao="/api/fv2/acoes/configuracoes/operadoras/situacao" data-recarregar="lista"><input type="hidden" name="codigo" value="${esc(o.codigo)}">
<div class="grade-3"><label>Nome <input type="text" name="nome" maxlength="80" value="${esc(o.nome)}"></label><label>Situação <select name="situacao"><option value="">(manter)</option><option value="ATIVA">Ativa</option><option value="INATIVA">Inativa</option></select></label>
<label>Encerrar vigência em <input type="date" name="encerramento" value="${esc(o.encerramento ?? "")}"></label></div><label>Justificativa <input type="text" name="justificativa" maxlength="500" required></label>
<label class="caixa-marcar"><input type="checkbox" name="confirmar" required> Confirmo a alteração (nada é apagado; vendas já registradas guardam a taxa usada).</label><button type="submit" class="botao">Salvar alteração</button><p class="resultado-acao" role="status" aria-live="polite"></p></form></details>` : ""}
</article>`;
  }).join("") : nenhum("Nenhuma operadora cadastrada nesta unidade.");
  const marcarMod = (m, marcado) => `<label class="caixa-marcar"><input type="checkbox" name="modalidades" value="${m}"${marcado ? " checked" : ""} data-multiplo> ${esc(MOD_TAXA[m])} <span class="nota">${esc(AJUDA_MOD[m])}</span></label>`;
  const formOperadora = pode ? formAcao({ url: "/api/fv2/acoes/configuracoes/operadoras", titulo: "Cadastrar operadora (maquininha)", rotulo: "Cadastrar operadora", aviso: "Confirmo o cadastro. As taxas são informadas em seguida, no card da operadora.",
    campos: `<div class="grade-3"><label>Tipo <select name="processador" required>${Object.entries(PROCESSADORES).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select></label><label>Nome <input type="text" name="nome" maxlength="80" placeholder="ex.: PagBank Moderninha" required></label>
<label>Código <input type="text" name="codigo" pattern="[A-Za-z][A-Za-z0-9_]{1,29}" placeholder="ex.: PAGBANK" required></label>
<label>Começou a operar em <input type="date" name="inicio" required></label><label>Deixou de operar em (opcional) <input type="date" name="encerramento"></label></div>
<fieldset class="grade-modalidades"><legend>O que esta maquininha recebe</legend>${ORDEM_MOD.map((m) => marcarMod(m, m !== "VOUCHER")).join("")}</fieldset>
<p class="nota">Duas operadoras ativas na mesma modalidade e no mesmo dia deixam as vendas em conferência (a SAIPOS não diz qual maquininha foi usada). Ao trocar de maquininha, encerre a anterior no dia anterior.</p>
<label>Justificativa <input type="text" name="justificativa" maxlength="500" required></label>` }) : "";
  return `${cabecalho("Operadoras e Taxas", "Maquininhas da unidade, o que cada uma recebe e quanto cobra")}
${d.painel ? painelTaxas(d.painel, ops, ctx.filtro ?? { inicio: d.painel.periodoInicio, fim: d.painel.periodoFim }) : ""}
<p class="aviso">Cada venda guarda a taxa vigente na data em que ocorreu: mudar as taxas não altera vendas já registradas. Com duas operadoras ativas para a mesma forma no mesmo dia, a venda vai para conferência.</p>
<div class="canal-operadoras">${cards}</div>${formOperadora}`;
}

/**
 * Converte a grade de taxas do formulário no texto que o servidor valida ("MODALIDADE;BANDEIRA;PERCENTUAL[;TARIFA]").
 * Devolve { texto, erros }: percentual inválido, tarifa sem percentual ou grade vazia viram erro (nada é enviado).
 */
export function textoDaGradeDeTaxas(entradas) {
  const linhas = []; const erros = [];
  const pct = new Map(); const tarifa = new Map();
  for (const [nome, bruto] of entradas) {
    const v = String(bruto ?? "").trim();
    if (!v) continue;
    const [tipo, mod, band] = String(nome).split("|");
    if (tipo === "tx") pct.set(`${mod}|${band}`, v); else if (tipo === "tf") tarifa.set(`${mod}|${band}`, v);
  }
  for (const [chave, v] of pct) {
    const [mod, band] = chave.split("|");
    if (!/^\d{1,2}([,.]\d{1,3})?$/.test(v)) { erros.push(`${MOD_TAXA[mod] ?? mod} ${mod === "PIX" ? "" : nomeBandeira(band)}: taxa "${v}" inválida (use ex.: 1,42).`); continue; }
    const tf = tarifa.get(chave);
    if (/^0+([,.]0+)?$/.test(v) && !tf) { erros.push(`${MOD_TAXA[mod] ?? mod} ${mod === "PIX" ? "" : nomeBandeira(band)}: taxa 0 só com tarifa fixa — deixe vazio se a operadora não cobra nada aqui.`); continue; }
    if (tf && !/^\d{1,4}([,.]\d{1,2})?$/.test(tf)) { erros.push(`${MOD_TAXA[mod] ?? mod} ${nomeBandeira(band)}: tarifa "${tf}" inválida (use ex.: 0,10).`); continue; }
    linhas.push([mod, band, v.replace(".", ","), ...(tf ? [tf.replace(".", ",")] : [])].join(";"));
  }
  for (const chave of tarifa.keys()) if (!pct.has(chave)) { const [mod, band] = chave.split("|"); erros.push(`${MOD_TAXA[mod] ?? mod} ${nomeBandeira(band)}: tarifa fixa sem taxa (%) — informe a taxa também (0 se só houver tarifa).`); }
  if (!linhas.length && !erros.length) erros.push("Informe ao menos uma taxa.");
  return { texto: linhas.join("\n"), erros };
}
