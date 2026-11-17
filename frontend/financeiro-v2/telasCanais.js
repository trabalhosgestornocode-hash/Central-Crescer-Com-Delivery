// Fases 04–06 (docs 42–44) — "Canais de faturamento": SAIPOS (Resumo, Presencial, Anota Aí, Importações, Fechamento
// Manual, Conferências), iFood e 99Food (fontes oficiais) e Operadoras e Taxas. Só apresentação: os números vêm prontos do
// núcleo (nenhum cálculo de dinheiro aqui). Taxa pendente nunca aparece como zero; estimativa nunca aparece como recebido.
import { dataBR, esc, moeda, percentual } from "./formatar.js";
import { calendarioCanal } from "./telasCalendarioCanais.js";

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
  if (aba === "importacoes") {
    const pode = tem(ctx.permissoes, "financeiro_v2.importar");
    return `${topo}<section class="card"><div class="card-topo"><h2>Relatórios importados</h2>${pode ? '<button type="button" class="botao" data-detalhe="importar:saipos">Importar relatório</button>' : ""}</div>
<p class="nota">Use "SAIPOS — Vendas por período (XLSX)". Reimportar o mesmo arquivo ou um período sobreposto não duplica vendas.</p>
${d.importacoes?.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Importações SAIPOS do período</caption><thead><tr><th scope="col">Relatório</th><th scope="col">Período</th><th scope="col">Situação</th><th scope="col"><span class="sr">Ações</span></th></tr></thead><tbody>
${d.importacoes.map((i) => `<tr>${td("Relatório", esc(i.tipoRelatorio === "SAIPOS_VENDAS" ? "Vendas por período" : i.tipoRelatorio === "SAIPOS_FORMAS_PAGAMENTO" ? "Formas de pagamento" : i.tipoRelatorio), "esquerda")}${td("Período", `${esc(dataBR(i.periodoInicio))} a ${esc(dataBR(i.periodoFim))}`)}${td("Situação", esc(i.estado.replaceAll("_", " ").toLowerCase()))}${td("Ações", `<button type="button" class="botao-link" data-detalhe="documento:${esc(i.id)}">Ver prévia e propostas</button>`)}</tr>`).join("")}
</tbody></table></div>` : nenhum("Nenhum relatório SAIPOS importado que cubra o período.")}</section>`;
  }
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
});
const REPASSE = Object.freeze({ RECEBIDO: ["Recebido", "ok"], PARCIAL: ["Parcial", "alerta"], PREVISTO: ["Previsto", "info"], ATRASADO: ["Atrasado", "erro"], SEM_RECEBIVEL: ["Sem recebível", "neutro"] });
const depende = (texto = "Depende do relatório oficial") => `<span class="valor valor--desconhecido">${esc(texto)}</span>`;

/** iFood e 99Food: SÓ fontes oficiais. Totais vêm prontos do servidor; ausência aparece como ausência (nunca zero). */
export function plataforma(d, ctx = {}) {
  const ifood = d.canal === "IFOOD";
  const nome = ifood ? "iFood" : "99Food";
  const [rs, cs] = SITUACAO_PLATAFORMA[d.situacao] ?? [d.situacao, "neutro"];
  const t = d.totais;
  const v = (k) => (t ? valor(t[k]) : depende());
  const cards = [
    ["Faturamento bruto", v("brutoCentavos"), "Vendas do período pelo relatório oficial da plataforma."],
    ["Pedidos e cancelamentos", t && t.pedidos !== null ? `${t.pedidos} · ${t.cancelamentos}` : depende("Depende do relatório de pedidos"), t?.observacaoPedidos ?? "O relatório oficial de pedidos ainda não é importado."],
    ["Descontos e promoções", v("descontosEPromocoesCentavos"), "Serviços e promoções sem decomposição no demonstrativo: dedução a classificar."],
    ["Comissões", v("comissoesCentavos"), "Comissão do marketplace (não é taxa de maquininha)."],
    ["Taxas", v("taxasCentavos"), "Taxa de transação do pagamento online."],
    ["Mensalidade", v("mensalidadesCentavos"), "Mensalidade da plataforma no período."],
    ["Ajustes", v("ajustesCentavos"), "Ajustes informados pela plataforma."],
    ["Repasse previsto", v("repassePrevistoCentavos"), "Líquido a receber da plataforma (recebível). Não é depósito."],
    ["Repasse recebido", t ? (t.repasseRecebidoCentavos ? valor(t.repasseRecebidoCentavos) : '<span class="nota">Nenhum repasse confirmado</span>') : depende(), "Só o que já foi liquidado com a entrada no banco."],
  ].map(([titulo, conteudo, exp]) => `<article class="card card--sec"><div class="card-topo"><h3>${esc(titulo)}</h3>${explicar(titulo, exp)}</div><p>${conteudo}</p></article>`).join("");
  const historico = d.historico?.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Demonstrativos oficiais registrados</caption><thead><tr><th scope="col">Período</th><th scope="col">Bruto</th><th scope="col">Repasse previsto</th><th scope="col">Recebido</th><th scope="col">Repasse</th></tr></thead><tbody>
${d.historico.map((x) => { const [r, c] = REPASSE[x.situacaoRepasse] ?? [x.situacaoRepasse, "neutro"]; return `<tr>${td("Período", `${esc(dataBR(x.periodoInicio))} a ${esc(dataBR(x.periodoFim))}`, "esquerda")}${td("Bruto", valor(x.brutoCentavos))}${td("Repasse previsto", valor(x.repassePrevistoCentavos))}${td("Recebido", valor(x.repasseRecebidoCentavos))}${td("Repasse", selo(r, c))}</tr>`; }).join("")}
</tbody></table></div>` : nenhum(ifood ? "Nenhum demonstrativo oficial registrado." : "Nenhum relatório oficial importado.");
  const cs2 = d.conferenciaSaipos;
  return `${cabecalho(nome, `Faturamento pela fonte oficial · ${esc(d.competencia ?? "")}`)}
<p>${selo(rs, cs)}${d.fonteOficial ? ` <span class="nota">Fonte: ${esc(d.fonteOficial)}</span>` : ""}</p>
${d.dependeDeRelatorioOficial ? '<p class="aviso">Os relatórios oficiais da 99Food ainda não foram fornecidos: a área está pronta, mas nenhum número é presumido. Os valores aparecerão quando o leitor do arquivo real for implementado.</p>' : ""}
${calendarioCanal(ctx.calendario, { selecionado: ctx.calDia ?? null, erro: ctx.calendarioErro ?? null })}
<section class="resumo" aria-label="Números do canal ${esc(nome)}">${cards}</section>
${d.pendencias?.length ? `<section class="card card--alertas"><h2>Pendências de conciliação</h2><ul class="lista-simples">${d.pendencias.map((p) => `<li><span>${esc(p.mensagem)}</span>${p.valorCentavos ? valor(p.valorCentavos) : ""}</li>`).join("")}</ul></section>` : ""}
<section class="card"><div class="card-topo"><h2>Histórico de importações</h2>${ifood && tem(ctx.permissoes, "financeiro_v2.registrar") ? '<a class="botao-link" href="#/configuracoes">Registrar demonstrativo (Configurações → Taxas Stone)</a>' : ""}</div>${historico}</section>
<section class="card"><h2>Pedidos no relatório SAIPOS — só conferência</h2><p class="nota">${cs2 ? `${cs2.pedidos} pedido(s) · ${cs2.cancelados} cancelado(s) · ${esc(moeda(cs2.totalCentavos))}` : "—"}. Não entram no faturamento: a SAIPOS não é fonte oficial ${ifood ? "do iFood" : "da 99Food"}.</p></section>`;
}

// ------------------------------------------------------------------------------------------------ Operadoras e Taxas
const fmtMilesimos = (m) => { const t = String(m).padStart(4, "0"); return `${t.slice(0, -3)},${t.slice(-3).replace(/0$/, "")}%`; };
const MOD_TAXA = Object.freeze({ DEBITO: "Débito", CREDITO_A_VISTA: "Crédito 1x", PIX: "Pix", VOUCHER: "Voucher" });
const PROCESSADORES = Object.freeze({ STONE: "Stone", PAGBANK: "PagBank", MAQUININHA_IFOOD: "Maquininha do iFood (presencial)", MAQUINA_TERCEIROS: "Máquina de terceiros", OPERADORA_BENEFICIOS: "Operadora de benefícios" });

export function operadorasTaxas(d, ctx = {}) {
  const pode = tem(ctx.permissoes, "financeiro_v2.configurar");
  const ops = d.operadoras ?? [];
  const cards = ops.length ? ops.map((o) => {
    const ativa = o.situacao !== "INATIVA";
    return `<article class="card" aria-label="Operadora ${esc(o.nome)}"><div class="card-topo"><h2>${esc(o.nome)}</h2>${selo(ativa ? "Ativa" : "Inativa", ativa ? "ok" : "neutro")}${o.implicita ? selo("Sem cadastro (tabela antiga)", "info") : ""}</div>
<dl class="ficha ficha--compacta"><dt>Código</dt><dd>${esc(o.codigo)}</dd><dt>Tipo</dt><dd>${esc(PROCESSADORES[o.processador] ?? o.processador)}</dd>
<dt>Vigência</dt><dd>${o.implicita ? "sem datas" : `${esc(dataBR(o.inicio))} a ${o.encerramento ? esc(dataBR(o.encerramento)) : "em aberto"}`}</dd><dt>Modalidades</dt><dd>${esc(o.modalidades.map((m) => MOD_TAXA[m] ?? m).join(", "))}</dd></dl>
<h3>Tabelas de taxas (versões)</h3>
${o.tabelas.length ? o.tabelas.map((t) => `<details class="versao-taxas"><summary>${esc(dataBR(t.vigenciaInicio))} a ${t.vigenciaFim ? esc(dataBR(t.vigenciaFim)) : "em aberto"} · ${t.taxas.length} taxa(s)</summary>
<div class="tabela-rolavel"><table class="tabela"><thead><tr><th scope="col">Modalidade</th><th scope="col">Bandeira</th><th scope="col">Percentual</th><th scope="col">Tarifa fixa</th></tr></thead><tbody>${t.taxas.map((x) => `<tr><td>${esc(MOD_TAXA[x.modalidade] ?? x.modalidade)}</td><td>${esc(x.modalidade === "PIX" ? "—" : BANDEIRAS[x.bandeira] ?? x.bandeira)}</td><td>${esc(fmtMilesimos(x.milesimos))}</td><td>${x.tarifaFixaCentavos ? valor(x.tarifaFixaCentavos) : "—"}</td></tr>`).join("")}</tbody></table></div>
<p class="nota">Fonte: ${esc(t.fonte)}${t.registradaEm ? ` · registrada em ${esc(dataBR(t.registradaEm))}` : ""}</p></details>`).join("") : '<p class="nota">Nenhuma taxa cadastrada: as vendas desta operadora mostram "Taxa não configurada" (nunca zero).</p>'}
${o.historico?.length ? `<details><summary>Histórico (${o.historico.length})</summary><ul class="lista-simples">${o.historico.map((h) => `<li><span>${esc(h.evento === "CADASTRO" ? "Cadastro" : "Alteração")}${h.situacao ? ` · ${esc(h.situacao.toLowerCase())}` : ""}${h.encerramento !== undefined ? ` · encerramento ${h.encerramento ? esc(dataBR(h.encerramento)) : "removido"}` : ""}${h.nome ? ` · nome "${esc(h.nome)}"` : ""}<br><span class="nota">${esc(h.justificativa ?? "")}</span></span><span class="nota">${esc(dataBR(h.em))}</span></li>`).join("")}</ul></details>` : ""}
${pode && !o.implicita ? `<form class="acao acao--embutida" data-acao="/api/fv2/acoes/configuracoes/operadoras/situacao" data-recarregar="lista"><input type="hidden" name="codigo" value="${esc(o.codigo)}">
<div class="grade-3"><label>Nome <input type="text" name="nome" maxlength="80" value="${esc(o.nome)}"></label><label>Situação <select name="situacao"><option value="">(manter)</option><option value="ATIVA">Ativa</option><option value="INATIVA">Inativa</option></select></label>
<label>Encerrar vigência em <input type="date" name="encerramento" value="${esc(o.encerramento ?? "")}"></label></div><label>Justificativa <input type="text" name="justificativa" maxlength="500" required></label>
<label class="caixa-marcar"><input type="checkbox" name="confirmar" required> Confirmo a alteração (nada é apagado; vendas já registradas guardam a taxa usada).</label><button type="submit" class="botao">Salvar alteração</button><p class="resultado-acao" role="status" aria-live="polite"></p></form>` : ""}
</article>`;
  }).join("") : nenhum("Nenhuma operadora cadastrada nesta unidade.");
  const opcoes = ops.filter((o) => !o.implicita || true).map((o) => `<option value="${esc(o.codigo)}">${esc(o.nome)}</option>`).join("");
  const formOperadora = pode ? formAcao({ url: "/api/fv2/acoes/configuracoes/operadoras", titulo: "Cadastrar operadora", rotulo: "Cadastrar operadora", aviso: "Confirmo o cadastro. Taxas entram depois, em tabela com vigência.",
    campos: `<div class="grade-3"><label>Código <input type="text" name="codigo" pattern="[A-Za-z][A-Za-z0-9_]{1,29}" placeholder="PAGBANK" required></label><label>Nome <input type="text" name="nome" maxlength="80" required></label>
<label>Tipo <select name="processador" required>${Object.entries(PROCESSADORES).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select></label>
<label>Início da vigência <input type="date" name="inicio" required></label><label>Encerramento (opcional) <input type="date" name="encerramento"></label>
<label>Modalidades <input type="text" name="modalidades" value="DEBITO, CREDITO_A_VISTA, PIX" required></label></div>
<label>Justificativa <input type="text" name="justificativa" maxlength="500" required></label>` }) : "";
  const formTabela = pode && ops.length ? formAcao({ url: "/api/fv2/acoes/configuracoes/taxas-contratadas", titulo: "Nova tabela de taxas (versão)", rotulo: "Registrar tabela", aviso: "Confirmo as taxas contratadas. Vigências não se sobrepõem; para trocar, encerre a anterior. Vendas já registradas não mudam.",
    campos: `<div class="grade-3"><label>Operadora <select name="operadora" required>${opcoes}</select></label><label>Início da vigência <input type="date" name="vigenciaInicio" required></label><label>Fim (opcional) <input type="date" name="vigenciaFim"></label></div>
<label>Taxas (uma por linha: MODALIDADE;BANDEIRA;PERCENTUAL[;TARIFA FIXA]) <textarea name="taxas" rows="5" required placeholder="DEBITO;MASTERCARD;1,10&#10;CREDITO_A_VISTA;VISA;2,90&#10;PIX;PIX;0,80&#10;VOUCHER;ALELO;5,00"></textarea></label>
<p class="nota">Modalidades: DEBITO, CREDITO_A_VISTA (sempre 1x), PIX, VOUCHER. Percentual 0 só com tarifa fixa. Taxa não cadastrada aparece como "não configurada".</p>
<div class="grade-2"><label>Fonte (contrato, print do app…) <input type="text" name="fonte" maxlength="300" required></label><label>Justificativa <input type="text" name="justificativa" maxlength="500" required></label></div>` }) : "";
  return `${cabecalho("Operadoras e Taxas", "Adquirentes e maquininhas da unidade, com vigência e histórico")}
<p class="aviso">Taxas são versionadas por vigência: cada venda guarda a taxa da data em que ocorreu. Com duas operadoras ativas para a mesma forma no mesmo dia, a venda vai para conferência.</p>
<div class="canal-operadoras">${cards}</div>${formOperadora}${formTabela}`;
}
