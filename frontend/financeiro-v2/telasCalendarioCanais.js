// Fase 10 (doc 47) — CALENDÁRIO DE CONTROLE DE FATURAMENTO dos canais (SAIPOS Presencial, SAIPOS Anota Aí, iFood, 99Food).
// Só apresentação: cada dia, cada estado, cada total e cada contagem vêm PRONTOS do servidor (consulta mensal consolidada).
// Nenhuma soma, nenhum percentual e nenhuma regra de dinheiro acontecem aqui. Estado nunca depende só de cor: todo estado
// tem ícone e texto, e o botão de cada dia descreve os estados por extenso para leitor de tela.
import { competencia as nomeDoMes, dataBR, esc, moeda } from "./formatar.js";
import { movimentosDoDia } from "./telasMovimentosCaixa.js";

const NOME_DO_CANAL = Object.freeze({ BALCAO: "SAIPOS — Presencial", ANOTA_AI: "SAIPOS — Anota Aí", IFOOD: "iFood", NOVENTA_E_NOVE_FOOD: "99Food" });
export const SEMANA = Object.freeze(["seg", "ter", "qua", "qui", "sex", "sáb", "dom"]);
const DIA_POR_EXTENSO = Object.freeze(["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"]);

/** Cada estado: ícone, nome, o que significa e a cor (reforço visual, nunca a única pista). */
export const ESTADOS = Object.freeze({
  SEM_REGISTRO: { glifo: "○", rotulo: "Sem registro", classe: "neutro", texto: "Nenhuma informação registrada neste dia." },
  PROVISORIO: { glifo: "✎", rotulo: "Faturamento provisório", classe: "alerta", texto: "Lançado à mão. Precisa ser substituído pelo relatório oficial." },
  FECHAMENTO_MANUAL: { glifo: "▤", rotulo: "Fechamento manual registrado", classe: "info", texto: "Fechamento de caixa da equipe. É conferência: não vira faturamento." },
  IMPORTADO: { glifo: "⇩", rotulo: "Relatório importado", classe: "info", texto: "Há dados vindos do relatório da fonte." },
  CONFERENCIA_PENDENTE: { glifo: "◔", rotulo: "Conferência pendente", classe: "alerta", texto: "Há algo a conferir, preencher ou confirmar neste dia." },
  DIVERGENCIA: { glifo: "⚠", rotulo: "Divergência encontrada", classe: "erro", texto: "Duas fontes discordam. Veja os detalhes do dia." },
  CONCILIADO: { glifo: "✓", rotulo: "Conciliado", classe: "ok", texto: "O que foi recebido confere com o esperado." },
  SEM_MOVIMENTO_CONFIRMADO: { glifo: "⊘", rotulo: "Sem movimento confirmado", classe: "neutro", texto: "Há evidência de que não houve movimento: dia marcado sem operação ou relatório que cobre o dia sem vendas." },
});
/** Qual estado dá a cor da borda do dia (a ordem é de gravidade; o dia mostra TODOS os ícones). */
const PRIORIDADE = Object.freeze(["DIVERGENCIA", "CONFERENCIA_PENDENTE", "CONCILIADO", "IMPORTADO", "PROVISORIO", "FECHAMENTO_MANUAL", "SEM_MOVIMENTO_CONFIRMADO", "SEM_REGISTRO"]);
const CONFERENCIA = Object.freeze({
  CONCILIADO: "Conciliado: recebido igual ao esperado", DIVERGENTE: "Divergente: recebido diferente do esperado", PENDENTE: "Pendente: há taxa ou recebimento sem confirmação",
  AGUARDANDO_EXTRATO: "Aguardando extrato: recebimento ainda não confirmado", PARCIAL: "Parcial: só parte foi recebida",
});
const RELATORIO = Object.freeze({ SAIPOS_VENDAS: "Vendas por período (por pedido)", SAIPOS_FORMAS_PAGAMENTO: "Formas de pagamento (por dia)", SAIPOS_MOVIMENTOS_CAIXA: "Movimentações de Frente de Caixa", IFOOD_CONCILIACAO: "Conciliação Financeira do iFood", NOVENTA_E_NOVE_FOOD_RELATORIO: "Relatório oficial da 99Food" });
const REPASSE = Object.freeze({ RECEBIDO: "Recebido", PARCIAL: "Recebido em parte", PREVISTO: "Previsto", ATRASADO: "Atrasado", SEM_RECEBIVEL: "Sem recebível", SEM_SALDO: "Sem saldo a receber", DIVERGENTE: "Crédito com diferença" });
const ORIGEM_DA_MARCACAO = Object.freeze({ DATA: "Marcado para esta data", DIA_DA_SEMANA: "Marcado para este dia da semana" });

const chip = (e) => { const x = ESTADOS[e]; return `<span class="est est--${x.classe}" title="${esc(x.rotulo)}"><span aria-hidden="true">${x.glifo}</span><span class="sr">${esc(x.rotulo)}</span></span>`; };
const seloEstado = (e) => { const x = ESTADOS[e]; return `<span class="selo selo--${x.classe}"><span aria-hidden="true">${x.glifo}</span> ${esc(x.rotulo)}</span>`; };
const valor = (c) => `<span class="${c === null || c === undefined ? "valor valor--desconhecido" : c < 0 ? "valor valor--negativo" : "valor"}">${c === null || c === undefined ? "—" : esc(moeda(c))}</span>`;
const diaDoMes = (data) => Number(data.slice(8));
const dataPorExtenso = (d) => `${DIA_POR_EXTENSO[d.diaDaSemana]}, ${dataBR(d.data)}`;

// ---------------------------------------------------------------------------------------------------------------- grade
function celula(d, canal, selecionado, focavel) {
  const principal = PRIORIDADE.find((e) => d.estados.includes(e)) ?? "";
  const falas = d.estados.map((e) => ESTADOS[e].rotulo);
  if (d.hoje) falas.push("hoje, ainda em andamento");
  if (d.futuro) falas.push("dia futuro, ainda não cobrado");
  if (d.antesDoControle && !d.estados.length) falas.push("antes do início do controle");
  if (d.semOperacao) falas.push("sem operação");
  const bruto = d.registro?.brutoCentavos;
  const rotulo = `${diaDoMes(d.data)} de ${nomeDoMes(d.data.slice(0, 7))}, ${DIA_POR_EXTENSO[d.diaDaSemana]}: ${falas.join(", ") || "sem informação"}${bruto !== undefined && bruto !== null ? `; faturamento ${moeda(bruto)}` : ""}`;
  const classes = ["cal-dia", "cal-dia--canal", d.hoje && "cal-dia--hoje", d.futuro && "cal-dia--futuro", !d.elegivel && !d.estados.length && "cal-dia--livre", d.data === selecionado && "cal-dia--sel"].filter(Boolean).join(" ");
  return `<button type="button" role="gridcell" class="${classes}" data-cal-dia="${esc(d.data)}" data-principal="${esc(principal)}" aria-pressed="${d.data === selecionado}" aria-label="${esc(rotulo)}" tabindex="${focavel ? 0 : -1}">
  <span class="cal-num">${diaDoMes(d.data)}</span>
  <span class="cal-estados">${d.estados.map(chip).join("")}</span>
  ${bruto !== undefined && bruto !== null ? `<span class="cal-valor">${esc(moeda(bruto))}</span>` : ""}
</button>`;
}

/** Resumo do mês: todas as contagens vêm do servidor. */
function resumo(r, controle) {
  const cartao = (titulo, n, nota = "") => `<article class="card card--sec"><div class="card-topo"><h3>${esc(titulo)}</h3></div><p class="valor-grande">${n}</p>${nota ? `<p class="nota">${esc(nota)}</p>` : ""}</article>`;
  return `<section class="resumo resumo--calendario" aria-label="Resumo do mês">
${cartao("Dias com informação", r.comInformacao, "Com algum registro ou evidência.")}
${cartao("Faturamento confirmado", r.confirmados, "Dias com dado da fonte oficial.")}
${cartao("Dados provisórios", r.provisorios, "Lançados à mão.")}
${cartao("Com pendências", r.comPendencias)}
${cartao("Com divergências", r.comDivergencias)}
${cartao("Sem registro", r.semRegistro, `${r.diasElegiveis} dia(s) cobrados${r.semOperacao ? ` · ${r.semOperacao} sem operação` : ""}${r.futuros ? ` · ${r.futuros} futuro(s) não cobrado(s)` : ""}.`)}
</section>
<p class="nota">Cobrança a partir de ${esc(dataBR(controle.inicio))} (${controle.origem === "ABERTURA" ? "início da abertura da unidade" : "mês corrente: a unidade ainda não tem abertura"}). Hoje e dias futuros nunca são considerados atrasados.</p>`;
}

const legenda = () => `<ul class="legenda legenda--cal legenda--estados" aria-label="Legenda dos estados do dia">${Object.keys(ESTADOS).map((e) => `<li>${chip(e)} <span>${esc(ESTADOS[e].rotulo)}</span></li>`).join("")}</ul>`;

/** O calendário de um canal: navegação, resumo, legenda, grade, painel do dia e configuração de dias sem operação. */
export function calendarioCanal(cal, { selecionado = null, erro = null } = {}) {
  if (erro) return `<section class="card cal-canal" aria-label="Calendário de faturamento"><h2>Calendário de faturamento</h2><p class="aviso aviso--alerta" role="alert">${esc(erro)}</p></section>`;
  if (!cal) return "";
  const dia1 = cal.dias[0];
  const deslocamento = (dia1.diaDaSemana + 6) % 7;
  const alvoFocavel = (selecionado && cal.dias.some((d) => d.data === selecionado) ? selecionado : (cal.dias.find((d) => d.hoje) ?? dia1).data);
  const sel = selecionado && cal.dias.find((d) => d.data === selecionado);
  return `<section class="cal-canal" aria-label="Calendário de faturamento — ${esc(NOME_DO_CANAL[cal.canal])}" data-cal-canal="${esc(cal.canal)}">
<h2>Calendário de faturamento</h2>
<p class="nota">${esc(cal.observacoes.join(" "))}</p>
${resumo(cal.resumo, cal.controle)}
<div class="cal-nav"><button type="button" class="botao" data-mes="-1" aria-label="Mês anterior">‹ Anterior</button><strong aria-live="polite">${esc(nomeDoMes(cal.mes))}</strong><button type="button" class="botao" data-mes="1" aria-label="Próximo mês">Próximo ›</button><button type="button" class="botao" data-cal-hoje>Hoje</button></div>
${legenda()}
<div class="calendario calendario--canal" role="grid" aria-label="Dias de ${esc(nomeDoMes(cal.mes))} — ${esc(NOME_DO_CANAL[cal.canal])}">
  ${SEMANA.map((s) => `<div class="cal-cab" role="columnheader">${s}</div>`).join("")}
  ${'<div class="cal-vazio" aria-hidden="true"></div>'.repeat(deslocamento)}
  ${cal.dias.map((d) => celula(d, cal.canal, selecionado, d.data === alvoFocavel)).join("")}
</div>
<p class="nota">Use as setas do teclado para andar pelos dias e Enter para abrir o dia.</p>
<section id="cal-dia-detalhe" class="card" aria-live="polite" aria-label="Detalhe do dia">${sel ? diaDoCanal(sel, cal) : '<p class="nota">Escolha um dia para ver o que foi registrado, as pendências e as ações disponíveis.</p>'}</section>
${configuracaoDeDiasSemOperacao(cal)}
</section>`;
}

// ------------------------------------------------------------------------------------------------------ painel do dia
const lista = (itens) => (itens.length ? `<ul class="lista-simples">${itens.join("")}</ul>` : "");
const formulario = ({ url, titulo, campos, rotulo, aviso }) => `<form class="acao acao--embutida" data-acao="${esc(url)}" data-recarregar="lista" aria-label="${esc(titulo)}">${campos}
<label class="caixa-marcar"><input type="checkbox" name="confirmar" required> ${esc(aviso)}</label>
<button type="submit" class="botao">${esc(rotulo)}</button><p class="resultado-acao" role="status" aria-live="polite"></p></form>`;

function valoresSaipos(d) {
  const r = d.registro;
  if (!r) return '<p class="nota">Nenhuma venda deste canal neste dia.</p>';
  return `<dl class="ficha ficha--compacta">
<dt>Faturamento bruto</dt><dd>${valor(r.brutoCentavos)}</dd>
<dt>Vendas</dt><dd>${r.vendas} (${r.origem.SAIPOS} da SAIPOS${r.origem.MANUAL ? `, ${r.origem.MANUAL} manual(is)` : ""})</dd>
<dt>Taxa estimada</dt><dd>${r.taxaEstimadaCentavos === null ? '<span class="valor valor--desconhecido">Não calculada</span>' : valor(r.taxaEstimadaCentavos)}</dd>
<dt>Líquido esperado</dt><dd>${valor(r.liquidoEsperadoCentavos)}</dd>
<dt>Recebido confirmado</dt><dd>${r.recebidoCentavos === null ? '<span class="nota">Não confirmado</span>' : valor(r.recebidoCentavos)}</dd>
${r.brutoSemCalculoCentavos ? `<dt>Sem taxa configurada</dt><dd>${valor(r.brutoSemCalculoCentavos)} <span class="nota">fora do líquido esperado, nunca considerado zero</span></dd>` : ""}
${r.semPagamento.vendas ? `<dt>Sem pagamento identificado</dt><dd>${r.semPagamento.vendas} venda(s) · ${valor(r.semPagamento.valorCentavos)}</dd>` : ""}
<dt>Conferência</dt><dd>${esc(CONFERENCIA[r.conferencia] ?? "Sem pagamento para conferir")}</dd></dl>`;
}

const CONFERENCIA_IFOOD = Object.freeze({ IMPORTADO: "Importado, ainda não aplicado", AGUARDANDO_CONFERENCIA: "Aguardando conferência", DIVERGENTE: "Divergente: diferença pendente", CONCILIADO: "Conciliado" });
function oficialDoIfood(o) {
  const repasses = o.repasses.map((r) => `${esc(dataBR(r.dataPrevista))} (${esc(REPASSE[r.situacao] ?? r.situacao)})`).join(", ");
  return `<dl class="ficha ficha--compacta">
<dt>Pedidos</dt><dd>${o.pedidos}${o.pedidosCancelados ? `, sendo ${o.pedidosCancelados} ${o.pedidosCancelados === 1 ? "cancelado" : "cancelados"}` : ""}</dd>
<dt>Faturamento</dt><dd>${valor(o.faturamentoCentavos)}</dd><dt>Produtos</dt><dd>${valor(o.produtosCentavos)}</dd><dt>Entregas da loja</dt><dd>${valor(o.entregasCentavos)}</dd>
<dt>Descontos da loja</dt><dd>${valor(o.descontosCentavos)}</dd><dt>Comissões</dt><dd>${valor(o.comissoesCentavos)}</dd><dt>Taxas</dt><dd>${valor(o.taxasCentavos)}</dd>
<dt>Ajustes (anúncios e entrega sob demanda)</dt><dd>${valor(o.ajustesCentavos)}</dd><dt>Valor líquido</dt><dd>${valor(o.liquidoCentavos)}</dd>
<dt>Conferência</dt><dd>${esc(CONFERENCIA_IFOOD[o.situacaoConferencia] ?? o.situacaoConferencia)}</dd><dt>Repasse previsto</dt><dd>${repasses || "—"}</dd></dl>`;
}

const CONFERENCIA_99FOOD = Object.freeze({ IMPORTADO: "Importado, ainda não aplicado", AGUARDANDO_CONFERENCIA: "Pendente de conferência", DIVERGENTE: "Divergente: diferença pendente", CONCILIADO: "Conciliado" });
function oficialDa99Food(o) {
  return `<dl class="ficha ficha--compacta">
<dt>Vendas</dt><dd>${o.quantidade}</dd><dt>Vendas de itens</dt><dd>${valor(o.itensCentavos)}</dd><dt>Comissões</dt><dd>${valor(o.comissaoCentavos)}</dd><dt>Taxas de processamento</dt><dd>${valor(o.processamentoCentavos)}</dd>
<dt>Marketing</dt><dd>${valor(o.marketingCentavos)}</dd><dt>Recompensas (em conferência)</dt><dd>${valor(o.recompensasCentavos)}</dd><dt>Repasse informado</dt><dd>${valor(o.repasseCentavos)} <span class="nota">sem data de pagamento</span></dd>
<dt>Importação</dt><dd>${esc(o.aplicado ? "Aplicada ao Financeiro" : "Importada")}</dd><dt>Conferência</dt><dd>${esc(CONFERENCIA_99FOOD[o.situacaoConferencia] ?? o.situacaoConferencia)}</dd></dl>`;
}

function periodosDoIfood(d) {
  if (d.ifoodOficial) return oficialDoIfood(d.ifoodOficial);
  const c = d.cobertura;
  if (!c) return '<p class="nota">Nenhum demonstrativo oficial cobre este dia.</p>';
  return `<p class="aviso">${esc(c.mensagem)}</p>${lista(c.periodos.map((p) => `<li><span><strong>${esc(dataBR(p.periodoInicio))} a ${esc(dataBR(p.periodoFim))}</strong><br><span class="nota">Valores do PERÍODO inteiro, não deste dia</span></span>
<span>Bruto ${valor(p.brutoCentavos)}<br><span class="nota">Comissões ${esc(moeda(p.comissoesCentavos))} · Taxas ${esc(moeda(p.taxasCentavos))}<br>Repasse: ${esc(REPASSE[p.situacaoRepasse] ?? p.situacaoRepasse)}${p.dataPrevista ? ` (previsto ${esc(dataBR(p.dataPrevista))})` : ""}</span></span></li>`))}`;
}

function acoesDoDia(d, cal) {
  const a = cal.acoes;
  const saipos = cal.canal === "BALCAO" || cal.canal === "ANOTA_AI";
  const botoes = [];
  if (saipos) {
    if (d.registro) botoes.push(`<button type="button" class="botao" data-cal-acao="vendas" data-cal-data="${esc(d.data)}">Ver faturamento e pagamentos</button>`);
    if (a.abrirImportacoes) botoes.push(`<button type="button" class="botao" data-cal-acao="importacoes" data-cal-data="${esc(d.data)}">Abrir importações do dia</button>`);
    if (d.fechamento || a.registrarFechamento) botoes.push(`<button type="button" class="botao" data-cal-acao="fechamentos" data-cal-data="${esc(d.data)}">${d.fechamento ? "Ver fechamentos" : "Registrar fechamento de caixa"}</button>`);
    if (a.registrarFaturamentoProvisorio && !d.futuro && !d.registro?.origem?.SAIPOS) botoes.push(`<button type="button" class="botao" data-cal-acao="provisorio" data-cal-data="${esc(d.data)}">Registrar faturamento provisório</button>`);
    if (a.abrirConferencias) botoes.push(`<button type="button" class="botao" data-cal-acao="conferencias" data-cal-data="${esc(d.data)}">Abrir conferências</button>`);
  } else {
    if (cal.canal === "IFOOD") botoes.push('<a class="botao" href="#/contas-a-receber">Ver contas a receber (repasses)</a>');
    if (a.abrirConferencias) botoes.push('<a class="botao" href="#/conferencias">Abrir conferências</a>');
    botoes.push('<a class="botao" href="#/documentos">Ver documentos</a>');
  }
  return botoes.length ? `<div class="cal-acoes">${botoes.join("")}</div>` : "";
}

function marcarSemOperacao(d, cal) {
  if (!cal.acoes.configurarDiasSemOperacao) return "";
  const url = "/api/fv2/acoes/calendario-faturamento/sem-operacao";
  const oculto = `<input type="hidden" name="canal" value="${esc(cal.canal)}"><input type="hidden" name="data" value="${esc(d.data)}">`;
  if (d.semOperacao?.origem === "DATA") {
    return `<h3>Dia sem operação</h3><p class="nota">${esc(ORIGEM_DA_MARCACAO.DATA)}${d.semOperacao.justificativa ? `: ${esc(d.semOperacao.justificativa)}` : ""}.</p>${formulario({
      url, titulo: "Voltar a operar neste dia", rotulo: "Voltar a operar", aviso: "Confirmo: este dia volta a ser cobrado (o histórico fica guardado).",
      campos: `${oculto}<input type="hidden" name="situacao" value="OPERA"><label>Justificativa <input type="text" name="justificativa" maxlength="300" required></label>` })}`;
  }
  if (d.semOperacao?.origem === "DIA_DA_SEMANA") return `<h3>Dia sem operação</h3><p class="nota">${esc(ORIGEM_DA_MARCACAO.DIA_DA_SEMANA)} (${esc(DIA_POR_EXTENSO[d.diaDaSemana])}). Para mudar, use "Dias sem operação" abaixo do calendário.</p>`;
  if (d.registro || d.cobertura || d.ifoodOficial || d.noventaOficial || d.antesDoControle) return "";
  return `<h3>Este dia não teve operação?</h3>${formulario({
    url, titulo: "Marcar este dia como sem operação", rotulo: "Marcar sem operação", aviso: "Confirmo: neste dia a empresa não operou neste canal (fica registrado com a justificativa).",
    campos: `${oculto}<input type="hidden" name="situacao" value="SEM_OPERACAO"><label>Justificativa <input type="text" name="justificativa" maxlength="300" required placeholder="Ex.: loja fechada por feriado"></label>` })}`;
}

/** Painel de detalhes de UM dia. */
export function diaDoCanal(d, cal) {
  if (!d) return '<p class="nota">Dia não encontrado neste mês.</p>';
  const estados = d.estados.length ? d.estados.map((e) => `<li>${seloEstado(e)} <span class="nota">${esc(ESTADOS[e].texto)}</span></li>`).join("")
    : `<li><span class="nota">${esc(d.futuro ? "Dia futuro: ainda não é cobrado." : d.hoje ? "Hoje: o dia ainda está em andamento e não é cobrado." : d.antesDoControle ? "Antes do início do controle: não é cobrado." : "Sem informação.")}</span></li>`;
  const importacoes = d.importacoes.length ? lista(d.importacoes.map((i) => `<li><span><strong>${esc(RELATORIO[i.tipoRelatorio] ?? i.tipoRelatorio)}</strong><br><span class="nota">${esc(dataBR(i.periodoInicio))} a ${esc(dataBR(i.periodoFim))} · ${esc(String(i.estado).replaceAll("_", " ").toLowerCase())}</span></span><button type="button" class="botao-link" data-detalhe="documento:${esc(i.id)}">Ver prévia e documento</button></li>`)) : "";
  const fech = d.fechamento ? `<p>${d.fechamento.caixas} caixa(s) com fechamento manual${d.fechamento.linhasDivergentes ? ` · ${d.fechamento.linhasDivergentes} forma(s) divergente(s)` : ""}.</p>` : "";
  const pend = d.pendencias.length ? `<h3>Pendências</h3>${lista(d.pendencias.map((p) => `<li><span>${esc(p.mensagem)}</span>${p.quantidade > 1 ? `<span>${p.quantidade}</span>` : ""}</li>`))}` : "";
  const dive = d.divergencias.length ? `<h3>Divergências</h3>${lista(d.divergencias.map((p) => `<li><span>${esc(p.mensagem)}</span>${typeof p.diferencaCentavos === "number" ? valor(p.diferencaCentavos) : ""}</li>`))}` : "";
  const obs = d.observacoes.length ? `<p class="nota">${esc(d.observacoes.join(" "))}</p>` : "";
  const sped = d.conferenciaSaipos ? `<p class="nota">${d.conferenciaSaipos.pedidos} pedido(s) iFood no relatório SAIPOS: só conferência, não é faturamento.</p>` : "";
  const valores = cal.canal === "IFOOD" ? periodosDoIfood(d) : cal.canal === "NOVENTA_E_NOVE_FOOD" && d.noventaOficial ? oficialDa99Food(d.noventaOficial) : cal.canal === "NOVENTA_E_NOVE_FOOD" ? (d.registro ? `<dl class="ficha ficha--compacta"><dt>Faturamento registrado</dt><dd>${valor(d.registro.brutoCentavos)}</dd><dt>Vendas</dt><dd>${d.registro.vendas}</dd></dl><p class="nota">Não vem de relatório oficial da 99Food.</p>` : '<p class="nota">Sem dados da 99Food neste dia. Sem relatório oficial importado, isso não é zero confirmado.</p>') : valoresSaipos(d);
  const origem = cal.canal === "IFOOD" ? (d.ifoodOficial ? "Relatório de Conciliação Financeira do iFood" : "Demonstrativo oficial do iFood") : cal.canal === "NOVENTA_E_NOVE_FOOD" ? (d.noventaOficial ? "Relatório oficial da 99Food" : "Relatório oficial da 99Food (ainda não importado)") : d.registro ? [d.registro.origem.SAIPOS ? "Relatório SAIPOS" : null, d.registro.origem.MANUAL ? "Registro manual (equipe)" : null].filter(Boolean).join(" e ") : d.fechamento ? "Fechamento manual (equipe)" : "—";
  return `<header class="cal-detalhe-cab"><h3>${esc(NOME_DO_CANAL[cal.canal])} · ${esc(dataPorExtenso(d))}</h3></header>
<ul class="lista-estados">${estados}</ul>
<dl class="ficha ficha--compacta"><dt>Canal</dt><dd>${esc(NOME_DO_CANAL[cal.canal])}</dd><dt>Data</dt><dd>${esc(dataPorExtenso(d))}</dd><dt>Origem da informação</dt><dd>${esc(origem)}</dd></dl>
<h3>Valores</h3>${valores}${fech}${sped}
${movimentosDoDia(d.movimentosDeCaixa)}
${importacoes ? `<h3>Importações que cobrem o dia</h3>${importacoes}` : ""}
${pend}${dive}${obs}
${marcarSemOperacao(d, cal)}
<h3>Ações</h3>${acoesDoDia(d, cal) || '<p class="nota">Seu perfil não tem ações para este dia.</p>'}`;
}

// ------------------------------------------------------------------------------------------ dias sem operação (configuração)
function configuracaoDeDiasSemOperacao(cal) {
  const cfg = cal.diasSemOperacao;
  const marcados = [...cfg.diasDaSemana.map((x) => `<li><span><strong>Todo(a) ${esc(DIA_POR_EXTENSO[x.dia])}</strong><br><span class="nota">${esc(x.justificativa ?? "")}</span></span></li>`),
    ...cfg.datas.map((x) => `<li><span><strong>${esc(dataBR(x.data))}</strong><br><span class="nota">${esc(x.justificativa ?? "")}</span></span></li>`)];
  const pode = cal.acoes.configurarDiasSemOperacao;
  if (!marcados.length && !pode) return "";
  const opcoes = DIA_POR_EXTENSO.map((n, i) => `<option value="${i}">${esc(n)}</option>`).join("");
  return `<details class="card cal-config"><summary><strong>Dias sem operação</strong> — ${marcados.length ? `${marcados.length} marcação(ões) neste canal` : "nenhuma marcação neste canal"}</summary>
<p class="nota">A empresa não é presumida como aberta todos os dias. Marque só o que for verdade; dias marcados saem da cobrança e a justificativa fica registrada.</p>
${marcados.length ? lista(marcados) : ""}
${pode ? formulario({ url: "/api/fv2/acoes/calendario-faturamento/sem-operacao", titulo: "Marcar um dia da semana", rotulo: "Salvar dia da semana", aviso: "Confirmo a alteração (o histórico fica guardado).",
    campos: `<input type="hidden" name="canal" value="${esc(cal.canal)}"><div class="grade-3"><label>Dia da semana <select name="diaDaSemana" required>${opcoes}</select></label><label>Situação <select name="situacao"><option value="SEM_OPERACAO">Não opera</option><option value="OPERA">Voltou a operar</option></select></label><label>Justificativa <input type="text" name="justificativa" maxlength="300" required></label></div>` }) : ""}
</details>`;
}

// ---------------------------------------------------------------------------------- painel "Vendas e pagamentos do dia"
/** Lista das vendas do dia (vem da consulta de vendas, já filtrada por canal e data). Cada uma abre o detalhe com pagamentos e lançamento. */
export function vendasDoDia(resposta, { canal, data }) {
  const itens = resposta?.itens ?? [];
  return `<div class="painel-cabeca"><h2 id="painel-titulo">${esc(NOME_DO_CANAL[canal] ?? canal)} · ${esc(dataBR(data))}</h2><button type="button" class="botao-fechar" data-fechar-painel aria-label="Fechar detalhe">×</button></div>
<p class="nota">Vendas deste canal no dia. Abra uma venda para ver os pagamentos, as taxas estimadas e o lançamento de receita.</p>
${itens.length ? `<ul class="lista-simples">${itens.map((v) => `<li><span><strong>${esc(v.titulo)}</strong><br><button type="button" class="botao-link" data-detalhe="venda:${esc(v.id)}">Ver venda e pagamentos</button></span><span>${valor(v.valores?.brutoProprioCentavos ?? null)}<br><span class="nota">Pago ${esc(moeda(v.valores?.pagoCentavos ?? 0))}</span></span></li>`).join("")}</ul>` : '<p class="nota vazio-lista">Nenhuma venda deste canal neste dia.</p>'}
${resposta?.paginacao?.total > itens.length ? `<p class="nota">Mostrando ${itens.length} de ${resposta.paginacao.total}.</p>` : ""}`;
}
