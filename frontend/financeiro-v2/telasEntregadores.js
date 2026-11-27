// Entregadores Próprios: acompanhamento da semana, fechamento, notas fiscais e pagamentos. Funções PURAS: dados já calculados pelo
// servidor → HTML escapado. Nenhuma conta de dinheiro acontece aqui.
import { dataBR, esc, moeda } from "./formatar.js";

const ABAS = [["resumo", "Resumo"], ["entregadores", "Entregadores"], ["informacoes", "Informações dos entregadores"], ["fechamento", "Fechamento semanal"], ["extras", "Serviços extras"], ["notas", "Notas fiscais"], ["pagamentos", "Pagamentos"], ["historico", "Histórico e conferências"]];
const DOC = Object.freeze({
  AGUARDANDO_NF: ["Aguardando nota fiscal", "alerta"], NF_RECEBIDA: ["Nota fiscal recebida", "info"], NF_EM_CONFERENCIA: ["Nota fiscal em conferência", "info"],
  NF_APROVADA: ["Nota fiscal aprovada", "ok"], NF_REJEITADA: ["Nota fiscal rejeitada", "erro"], LIBERADO_PAGAMENTO: ["Liberado para pagamento", "ok"],
});
const PAG = Object.freeze({ SEM_CONTA: ["Sem conta a pagar", "alerta"], A_PAGAR: ["A pagar", "neutro"], VENCIDO: ["Vencido", "erro"], PARCIAL: ["Pago em parte", "info"], PAGO: ["Pago", "ok"], CANCELADO: ["Cancelado", "neutro"] });
const SEMANA = Object.freeze({ EM_ANDAMENTO: ["Semana em andamento: valores provisórios", "info"], AGUARDANDO_FECHAMENTO: ["Semana encerrada: aguardando fechamento", "alerta"], PENDENTE: ["Fechamento pendente", "alerta"], CONSOLIDADA: ["Semana encerrada: valores consolidados", "ok"] });
const TIPO_ITEM = Object.freeze({ ENTREGA: "Entrega", ENTREGA_MANUAL: "Entrega manual", TAXA_ADICIONAL: "Taxa adicional", MOVIMENTACAO_OPERACIONAL: "Movimentação operacional", AJUSTE: "Ajuste" });
const DECISAO = Object.freeze({ MANTER: "Manter o valor fechado", AJUSTAR_CONTA: "Ajustar a conta em aberto", CONTA_COMPLEMENTAR: "Gerar conta complementar", COMPENSAR_FUTURO: "Compensar em fechamento futuro" });
// 23/11: o seletor mostra também a semana encerrada SEM fechamento (antes ela sumia). "Aguardando fechamento" ≠ fechada.
// Situação da semana no seletor (texto completo; também no title da opção e na linha "Semana escolhida" logo abaixo).
const SITUACAO_NO_SELETOR = Object.freeze({ EM_ANDAMENTO: "Em andamento", CONSOLIDADA: "Fechada", PENDENTE: "Fechamento pendente", AGUARDANDO_FECHAMENTO: "Aguardando fechamento" });
const textoDaSemana = (rotulo, situacao) => (SITUACAO_NO_SELETOR[situacao] ? `${rotulo} — ${SITUACAO_NO_SELETOR[situacao]}` : rotulo);
const selo = (mapa, k) => { const [t, c] = mapa[k] ?? [k, "neutro"]; return `<span class="selo selo--${c}">${esc(t)}</span>`; };
const valor = (c) => `<span class="valor">${esc(moeda(c))}</span>`;
const tem = (p, a) => (p ?? []).includes(`financeiro_v2.${a}`);
const curta = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const nada = (t) => `<p class="nota vazio-lista">${esc(t)}</p>`;
const ref = (f) => `${f.semanaInicio}|${f.entregador.chave}`;
const ocultos = (inicio, chave) => `<input type="hidden" name="inicio" value="${esc(inicio)}">${chave ? `<input type="hidden" name="entregador" value="${esc(chave)}">` : ""}`;

function acao({ url, titulo, campos = "", aviso, rotulo, recarregar = "lista", arquivo = false, aberto = false }) {
  return `<details class="card ent-acao"${aberto ? " open" : ""}><summary><h3 class="inline">${esc(titulo)}</h3></summary>
<form class="acao" data-acao="${esc(url)}" data-recarregar="${esc(recarregar)}"${arquivo ? " data-envio-evidencia" : ""}>${campos}
<label class="caixa-marcar"><input type="checkbox" name="confirmar"> ${esc(aviso)}</label>
<button type="submit" class="botao botao--primario">${esc(rotulo)}</button><p class="resultado-acao" role="status"></p></form></details>`;
}
const justificativa = (obrigatoria = true) => `<label>Justificativa <input name="justificativa" maxlength="500" ${obrigatoria ? "required" : ""}></label>`;


function filtros(r, f) {
  const atual = r.semanaAtual;
  const semanas = [{ inicio: atual.inicio, rotulo: textoDaSemana(`${atual.inicio.slice(5, 7) === atual.fim.slice(5, 7) ? atual.inicio.slice(8, 10) : curta(atual.inicio)} a ${curta(atual.fim)}/${atual.fim.slice(0, 4)}`, "EM_ANDAMENTO") },
    ...r.semanas.filter((s) => s.inicio !== atual.inicio).map((s) => ({ inicio: s.inicio, rotulo: textoDaSemana(s.rotulo, s.situacao) }))];
  if (!semanas.some((s) => s.inicio === r.semana.inicio)) semanas.push({ inicio: r.semana.inicio, rotulo: textoDaSemana(r.semana.rotulo, r.semana.situacao) });
  const op = (v, t, a) => `<option value="${esc(v)}" title="${esc(t)}"${v === (a ?? "") ? " selected" : ""}>${esc(t)}</option>`;
  const escolhida = semanas.find((s) => s.inicio === r.semana.inicio)?.rotulo ?? r.semana.rotulo;
  return `<form class="filtros-locais" data-filtro-local="entregadores-proprios" aria-label="Filtros de entregadores">
<input type="hidden" name="aba" value="${esc(f.aba ?? "resumo")}">
<label class="ent-filtro-semana">Semana <select name="semana" aria-describedby="ent-semana-escolhida">${semanas.map((s) => op(s.inicio, s.rotulo, r.semana.inicio)).join("")}</select></label>
<label>Outra semana <input type="date" name="semanaLivre" value="" aria-describedby="ajuda-semana"></label>
<label>Mês do vencimento <input type="month" name="mes" value="${esc(f.mes ?? "")}"></label>
<label>Entregador <select name="entregador">${op("", "Todos", f.entregador)}${r.entregadores.map((e) => op(e.chave, e.nome, f.entregador)).join("")}</select></label>
<label>Situação <select name="situacao">${op("", "Todas", f.situacao)}${Object.entries(DOC).map(([k, [t]]) => op(k, t, f.situacao)).join("")}${["VENCIDO", "PAGO"].map((k) => op(k, PAG[k][0], f.situacao)).join("")}</select></label>
<span class="sr" id="ajuda-semana">Escolha qualquer dia da semana desejada.</span>
<p class="ent-semana-escolhida" id="ent-semana-escolhida">Semana escolhida: <strong>${esc(escolhida)}</strong></p></form>`;
}

function faixaDaSemana(r) {
  const s = r.semana;
  return `<section class="card ent-semana" aria-label="Situação da semana"><div class="card-topo"><h2>Semana ${esc(s.rotulo)}</h2>${selo(SEMANA, s.situacao)}</div>
<ol class="ent-ciclo">${[["Fim da semana", s.fim], ["Demonstrativo", s.demonstrativo], ["Prazo da nota", s.prazoDaNota], ["Vencimento", s.vencimento]].map(([t, d]) => `<li><span class="nota">${esc(t)}</span><strong>${esc(dataBR(d))}</strong></li>`).join("")}</ol>
${s.fonteDisponivel ? "" : '<p class="aviso aviso--alerta">Os dados do parser Foody não estão disponíveis agora. Nenhum valor definitivo é gerado sem eles.</p>'}
${s.pendencias.length ? `<ul class="mini ent-pendencias">${s.pendencias.map((p) => `<li>${esc(p.mensagem)}</li>`).join("")}</ul>` : ""}</section>`;
}

const cardEntregador = (e) => `<article class="card ent-card"><div class="card-topo"><h3>${esc(e.nome)}</h3>${e.aguardandoNota ? `<span class="selo selo--alerta">${e.aguardandoNota} sem nota</span>` : ""}</div>
<p class="ent-card__valor">${valor(e.valorSemanaCentavos)}</p><p class="nota">${e.entregasSemana} entrega(s) na semana${e.aPagarCentavos ? ` · ${esc(moeda(e.aPagarCentavos))} a pagar` : ""}</p>
${e.porDia.length ? `<ul class="ent-dias" aria-label="Acumulado por dia">${e.porDia.map((d) => `<li><span>${esc(curta(d.data))}</span><span>${d.entregas} · ${esc(moeda(d.valorCentavos))}</span></li>`).join("")}</ul>` : ""}
<button type="button" class="botao-link" data-detalhe="entregador-pessoa:${esc(e.chave)}">Ver histórico</button></article>`;

function linhaFechamento(f) {
  return `<tr><td data-rotulo="Entregador" class="esquerda"><strong>${esc(f.entregador.nome)}</strong><br><span class="nota">Semana ${esc(f.rotuloSemana)} · ${f.entregas} entrega(s)</span></td>
<td data-rotulo="Vencimento">${esc(dataBR(f.vencimento))}</td><td data-rotulo="Total devido">${valor(f.valorCentavos)}</td>
<td data-rotulo="Documentação">${selo(DOC, f.situacaoDocumental)}${f.impedimentoDocumental ? '<br><span class="selo selo--erro">Impedimento documental</span>' : ""}${f.duplicidade?.situacao === "ABERTA" ? '<br><span class="selo selo--alerta">Possível duplicidade</span>' : ""}</td>
<td data-rotulo="Pagamento">${f.contaManual ? '<span class="selo selo--info">Conta manual vinculada</span>' : selo(PAG, f.situacaoPagamento)}</td>
<td data-rotulo="Ações"><button type="button" class="botao-link" data-detalhe="entregador:${esc(ref(f))}">Abrir</button></td></tr>`;
}
const tabela = (lista, vazio) => (lista.length ? `<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Fechamentos semanais</caption><thead><tr><th scope="col" class="esquerda">Entregador</th><th scope="col">Vencimento</th><th scope="col">Total devido</th><th scope="col">Documentação</th><th scope="col">Pagamento</th><th scope="col">Ações</th></tr></thead><tbody>${lista.map(linhaFechamento).join("")}</tbody></table></div>` : nada(vazio));

function abaFechamento(r, ctx) {
  const s = r.semana;
  const fechavel = s.situacao !== "CONSOLIDADA" && s.situacao !== "EM_ANDAMENTO" && tem(ctx.permissoes, "registrar");
  const semDados = s.pendencias.some((p) => p.codigo === "DIA_SEM_DADOS");
  const triagem = s.pendencias.some((p) => ["DIA_EM_TRIAGEM", "DIA_PROVISORIO"].includes(p.codigo));
  const contasManuais = s.pendencias.some((p) => p.codigo === "CONTA_MANUAL_SEM_ENTREGADOR");
  const form = fechavel ? acao({ url: "/api/fv2/acoes/entregadores/fechar", titulo: s.historica ? "Reconciliar e fechar semana histórica" : "Fechar esta semana agora", rotulo: "Fechar semana", aberto: true,
    aviso: "Confirmo: serão criadas as contas a pagar desta semana. Nenhum pagamento é feito.",
    campos: `${ocultos(s.inicio)}${s.historica ? '<input type="hidden" name="reconciliacao" value="true"><p class="aviso aviso--alerta">Semana anterior ao fechamento automático: confira os pagamentos antigos antes de continuar.</p>' : ""}${semDados ? '<label class="caixa-marcar"><input type="checkbox" name="aceitarDiasSemDados"> A unidade não operou nos dias sem dados</label>' : ""}<div class="grade-2"><label>Pedidos a pagar em outra quarta (opcional) <input name="pedidosAdiados" placeholder="Ex.: 4186, 4193"></label><label>Pagar em <input type="date" name="pagarEm"></label></div>${triagem ? '<label class="caixa-marcar"><input type="checkbox" name="aceitarTriagem"> Fechar mesmo com triagem pendente (pedido classificado depois vira divergência para decisão)</label>' : ""}${contasManuais ? '<label class="caixa-marcar"><input type="checkbox" name="aceitarContasManuais"> A conta manual já lançada em Entregadores Próprios é de OUTRO serviço (não é esta semana)</label>' : ""}${justificativa(s.historica || semDados || triagem || contasManuais)}` }) : "";
  const verificar = s.situacao === "CONSOLIDADA" && tem(ctx.permissoes, "registrar") ? acao({ url: "/api/fv2/acoes/entregadores/verificar", titulo: "Procurar alterações do parser depois do fechamento", rotulo: "Procurar alterações", aviso: "Confirmo a verificação. Os valores fechados não mudam.", campos: ocultos(s.inicio) }) : "";
  const abertas = s.divergencias.filter((d) => d.situacao === "ABERTA");
  const divergencias = abertas.length ? `<section class="card card--alertas"><h2>Alterações depois do fechamento</h2>${abertas.map((d) => `<article class="ent-divergencia"><p><strong>${esc(d.entregadorNome)}</strong>: fechado ${esc(moeda(d.valorFechadoCentavos))}, parser agora ${esc(moeda(d.valorAtualCentavos))} (diferença ${esc(moeda(d.diferencaCentavos))}).</p>
${tem(ctx.permissoes, "corrigir") ? acao({ url: "/api/fv2/acoes/entregadores/divergencia", titulo: "Decidir", rotulo: "Registrar decisão", aviso: "Confirmo a decisão. O valor original fica preservado.", campos: `${ocultos(s.inicio)}<input type="hidden" name="divergencia" value="${esc(d.id)}"><label>Decisão <select name="decisao">${Object.entries(DECISAO).map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join("")}</select></label>${justificativa()}` }) : ""}</article>`).join("")}</section>` : "";
  return `${faixaDaSemana(r)}${divergencias}${form}${verificar}<section class="card"><h2>Fechamentos</h2>${tabela(r.fechamentos.filter((f) => f.semanaInicio === s.inicio), s.situacao === "EM_ANDAMENTO" ? "A semana ainda está em andamento: as contas só nascem depois do domingo." : "Nenhum fechamento gerado nesta semana.")}</section>`;
}

const EXTRA = Object.freeze({ PENDENTE: ["Pendente", "alerta"], PAGO: ["Pago", "ok"], PAGO_AGUARDANDO_VINCULO: ["Pago, aguardando vínculo com o caixa", "info"] });
const opcoesDeOrigem = (o) => `<option value="">Sem vínculo informado</option>${o.contas.map((c) => `<option value="conta:${esc(c.id)}">Conta: ${esc(dataBR(c.data))} · ${esc(c.fornecedor ?? "")} · ${esc(c.descricao ?? "")} · ${esc(moeda(c.valorCentavos))}</option>`).join("")}${o.saidas.map((m) => `<option value="saida:${esc(m.id)}">Saída: ${esc(dataBR(m.data))} · ${esc(m.descricao.slice(0, 60))} · ${esc(moeda(m.livreCentavos))} livres</option>`).join("")}`;
function resumoFinanceiro(r) {
  const s = r.resumoSemana;
  return `<section class="card" aria-label="Taxas, extras e saldo da semana"><h2>Resumo financeiro da semana</h2><dl class="ficha ficha--compacta"><dt>Taxas Foody Delivery</dt><dd>${valor(s.taxasFoodyCentavos)}</dd><dt>Serviços extras</dt><dd>${valor(s.extrasCentavos)}</dd><dt>Total devido</dt><dd><strong>${valor(s.totalDevidoCentavos)}</strong></dd><dt>Total pago</dt><dd>${valor(s.totalPagoCentavos)}</dd><dt>Saldo em aberto</dt><dd><strong>${valor(s.saldoAbertoCentavos)}</strong></dd><dt>Pagos aguardando vínculo com o caixa</dt><dd>${valor(s.aguardandoVinculoCentavos)}</dd><dt>Pendências documentais</dt><dd>${s.pendenciasDocumentais}</dd></dl></section>`;
}
function abaExtras(r, ctx) {
  const s = r.semana;
  const form = tem(ctx.permissoes, "registrar") ? acao({ url: "/api/fv2/acoes/entregadores/extra", titulo: "Registrar serviço extra", rotulo: "Registrar extra", aberto: true, aviso: "Confirmo o registro. Extra já pago não gera nova cobrança e não reduz as taxas do Foody.",
    campos: `<div class="grade-2"><label>Entregador <select name="entregador" required>${r.entregadores.map((e) => `<option value="${esc(`${e.chave}|${e.nome}`)}">${esc(e.nome)}</option>`).join("")}</select></label><label>Data do serviço <input type="date" name="data" min="${esc(s.inicio)}" max="${esc(s.fim < r.dataBase ? s.fim : r.dataBase)}" required></label><label>Valor (R$) <input name="valor" inputmode="decimal" pattern="[0-9.]{1,13}(,[0-9]{1,2})?" required></label><label>Situação <select name="situacao"><option value="PAGO">Já pago</option><option value="PENDENTE">Pendente</option></select></label><label>Meio de pagamento <select name="meioPagamento"><option value="DINHEIRO">Dinheiro</option><option value="PIX">Pix</option><option value="OUTRO">Outro</option></select></label><label>Conta ou saída já registrada <select name="origem">${opcoesDeOrigem(r.origensDeExtra)}</select></label></div><label>Descrição <input name="descricao" maxlength="300" required></label>${justificativa()}<label class="caixa-marcar"><input type="checkbox" name="confirmarSemDuplicidade"> Conferi: é outro serviço, mesmo com valor e data parecidos</label>` }) : "";
  const lista = r.extras.filter((x) => x.semanaInicio === s.inicio);
  return `${faixaDaSemana(r)}${resumoFinanceiro(r)}${form}<section class="card"><h2>Extras da semana</h2>${lista.length ? `<ul class="lista-simples">${lista.map((x) => `<li><span><strong>${esc(x.entregador.nome)}</strong> · ${esc(dataBR(x.data))} · ${esc(x.descricao)}<br>${selo(EXTRA, x.situacao)}</span>${valor(x.valorCentavos)}</li>`).join("")}</ul>` : nada("Nenhum serviço extra nesta semana.")}</section>`;
}

// ------------------------------------------------------------------ 23/11: Resumo reformulado (hierarquia: semana → indicadores → tabela)
const dica = (t) => `<span class="ent-dica" tabindex="0" role="note" aria-label="${esc(t)}" title="${esc(t)}">?</span>`;
/** Indicador compacto: título, valor, período de referência e a origem do número (também no balão de ajuda). */
const kpi = (titulo, conteudo, periodo, origem, tom = "") => `<div class="ent-kpi${tom ? ` ent-kpi--${tom}` : ""}" title="${esc(origem)}"><p class="ent-kpi__titulo">${esc(titulo)} ${dica(origem)}</p><p class="ent-kpi__valor">${conteudo}</p><p class="ent-kpi__periodo">${esc(periodo)}</p></div>`;
const qtdValor = (x) => (x ? `${valor(x.valorCentavos)}<span class="ent-kpi__qtd">${x.quantidade} ${x.quantidade === 1 ? "entregador" : "entregadores"}</span>` : "—");

function cabecalhoOperacional(r, ctx) {
  const s = r.semana;
  const fechavel = s.situacao !== "CONSOLIDADA" && s.situacao !== "EM_ANDAMENTO" && tem(ctx.permissoes, "registrar");
  const w = r.indicadoresDaSemana;
  const acoes = [
    fechavel ? '<button type="button" class="botao botao--primario" data-aba-canal="fechamento">Fechar semana</button>' : "",
    w?.aguardandoNota?.quantidade || w?.emAnalise?.quantidade ? '<button type="button" class="botao" data-aba-canal="notas">Notas fiscais</button>' : "",
    '<button type="button" class="botao" data-aba-canal="informacoes">Informações dos entregadores</button>',
  ].join("");
  const aviso = s.situacao === "AGUARDANDO_FECHAMENTO"
    ? `<p class="aviso aviso--alerta">Semana encerrada <strong>sem fechamento oficial</strong>. Os valores abaixo são da apuração do Foody e ainda podem mudar; nenhuma conta foi criada.${fechavel ? " Use “Fechar semana” para gerar as contas a pagar." : " Peça a quem tem permissão de registrar para fechar a semana."}</p>`
    : s.situacao === "EM_ANDAMENTO" ? '<p class="nota">Semana em andamento: valores provisórios, atualizados conforme o Foody sincroniza.</p>' : "";
  return `<section class="card ent-cabeca" aria-label="Semana selecionada">
<div class="ent-cabeca__topo"><div><p class="ent-cabeca__unidade">${esc(ctx.unidadeNome || "Unidade")}</p><h2>Semana ${esc(s.rotulo)}</h2></div>${selo(SEMANA, s.situacao)}</div>
<dl class="ent-cabeca__datas">${[["Demonstrativo", s.demonstrativo, "Segunda-feira seguinte: o entregador recebe o demonstrativo."], ["Prazo da nota", s.prazoDaNota, "Terça-feira: prazo para o entregador enviar a nota fiscal."], ["Vencimento", s.vencimento, "Quarta-feira: pagamento, só com a nota conferida e liberada."]]
    .map(([t, d, x]) => `<div><dt>${esc(t)} ${dica(x)}</dt><dd>${esc(dataBR(d))}</dd></div>`).join("")}</dl>
${aviso}${s.fonteDisponivel ? "" : '<p class="aviso aviso--alerta">Os dados do Foody não estão disponíveis agora. Nenhum valor definitivo é gerado sem eles.</p>'}
${s.pendencias.length ? `<ul class="mini ent-pendencias">${s.pendencias.map((p) => `<li>${esc(p.mensagem)}</li>`).join("")}</ul>` : ""}
<div class="ent-cabeca__acoes">${acoes}</div></section>`;
}

function indicadoresDoResumo(r) {
  const w = r.indicadoresDaSemana;
  const i = r.indicadores;
  const periodo = `Semana ${r.semana.rotulo}${w?.provisoria ? " · provisório" : ""}`;
  const daSemana = w ? `<section class="ent-kpis" aria-label="Indicadores da semana selecionada"><h2 class="ent-secao">Semana selecionada</h2><div class="ent-kpis__grade">
${kpi("Total devido", valor(w.devidoCentavos), periodo, "Taxas do Foody mais serviços extras da semana.")}
${kpi("Total pago", valor(w.pagoCentavos), periodo, "Baixas pelo extrato bancário das contas desta semana.", "ok")}
${kpi("Saldo em aberto", valor(w.saldoCentavos), periodo, "Total devido menos o que já foi pago nesta semana.")}
${kpi("Entregadores", `<span class="valor">${w.entregadores}</span>`, periodo, "Entregadores com entrega elegível ou serviço extra na semana.")}
${kpi("Aguardando nota fiscal", qtdValor(w.aguardandoNota), periodo, "Contas desta semana sem nota (ou com nota rejeitada).", w.aguardandoNota.quantidade ? "alerta" : "")}
${kpi("Documentos em análise", qtdValor(w.emAnalise), periodo, "Nota recebida, em conferência ou aprovada, ainda não liberada.", w.emAnalise.quantidade ? "info" : "")}
${kpi("Liberado para pagamento", qtdValor(w.liberado), periodo, "Nota conferida e pagamento liberado, ainda sem baixa no extrato. Só desta semana.", w.liberado.quantidade ? "ok" : "")}
${kpi("Vencido", qtdValor(w.vencido), periodo, "Passou da quarta-feira com saldo em aberto.", w.vencido.quantidade ? "erro" : "")}</div></section>` : "";
  const acumulado = `<section class="ent-kpis ent-kpis--acumulado" aria-label="Acumulado em aberto de todas as semanas"><h2 class="ent-secao">Acumulado em aberto <span class="nota">todas as semanas da unidade</span></h2><div class="ent-kpis__grade">
${kpi(`Próxima quarta (${curta(i.proximaQuarta.data)})`, valor(i.proximaQuarta.valorCentavos), `${i.proximaQuarta.quantidade} conta(s) a vencer`, "Contas de entregadores que vencem na próxima quarta-feira, de qualquer semana.")}
${kpi("Aguardando nota fiscal", valor(i.aguardandoNotaCentavos), "Todas as semanas em aberto", "Saldo das contas ainda sem liberação documental, de todas as semanas.")}
${kpi("Liberado para pagamento", valor(i.liberadoCentavos), "Todas as semanas em aberto", "Saldo já liberado e ainda não baixado pelo extrato, de todas as semanas.")}
${kpi("Vencido", valor(i.vencidoCentavos), "Todas as semanas em aberto", "Saldo vencido de todas as semanas.")}</div></section>`;
  return daSemana + acumulado;
}

/** Tabela operacional da semana: uma linha por entregador, expansível com a composição (dias, extras e o fechamento). */
function tabelaOperacional(r) {
  const s = r.semana;
  const linhas = r.resumoSemana?.porEntregador ?? [];
  if (!linhas.length) {
    const t = s.situacao === "EM_ANDAMENTO" ? "Ainda não há entrega elegível nesta semana. Os valores aparecem conforme o Foody sincroniza os pedidos."
      : s.fonteDisponivel === false ? "Sem dados do Foody para esta semana: nada pode ser apurado agora."
        : "Nenhuma entrega elegível nem serviço extra nesta semana.";
    return `<section class="card"><h2>Entregadores da semana</h2>${nada(t)}</section>`;
  }
  const fech = new Map(r.fechamentos.filter((f) => f.semanaInicio === s.inicio).map((f) => [f.entregador.chave, f]));
  const card = new Map(r.entregadores.map((e) => [e.chave, e]));
  const extras = r.extras.filter((x) => x.semanaInicio === s.inicio);
  const nf = (f) => !f ? '<span class="selo selo--neutro">Sem fechamento</span>'
    : ["AGUARDANDO_NF", "NF_REJEITADA"].includes(f.situacaoDocumental) ? selo(DOC, f.situacaoDocumental) : '<span class="selo selo--ok">Recebida</span>';
  const conf = (f) => !f ? "—" : ({ NF_RECEBIDA: selo(DOC, "NF_RECEBIDA"), NF_EM_CONFERENCIA: selo(DOC, "NF_EM_CONFERENCIA"), NF_APROVADA: selo(DOC, "NF_APROVADA"), LIBERADO_PAGAMENTO: '<span class="selo selo--ok">Conferida</span>', NF_REJEITADA: selo(DOC, "NF_REJEITADA") }[f.situacaoDocumental] ?? "—");
  const lib = (f) => !f ? "—" : f.situacaoDocumental === "LIBERADO_PAGAMENTO" ? '<span class="selo selo--ok">Liberado</span>' : f.situacaoDocumental === "NF_REJEITADA" ? '<span class="selo selo--erro">Bloqueado</span>' : `<span class="selo selo--neutro"${f.impedimentoDocumental ? ` title="${esc(f.impedimentoDocumental)}"` : ""}>Aguardando</span>`;
  const corpo = linhas.map((p) => {
    const f = fech.get(p.chave);
    const c = card.get(p.chave);
    const ex = extras.filter((x) => x.entregador.chave === p.chave);
    const composicao = `<details class="ent-comp"><summary>${esc(p.nome)}</summary><div class="ent-comp__corpo">
${c?.porDia?.length ? `<h4>Taxas por dia (Foody)</h4><ul class="ent-dias">${c.porDia.map((d) => `<li><span>${esc(curta(d.data))}</span><span>${d.entregas} entrega(s) · ${esc(moeda(d.valorCentavos))}</span></li>`).join("")}</ul>` : '<p class="nota">Sem taxa do Foody nesta semana.</p>'}
${ex.length ? `<h4>Serviços extras</h4><ul class="ent-dias">${ex.map((x) => `<li><span>${esc(curta(x.data))} · ${esc(x.descricao)}</span><span>${esc(moeda(x.valorCentavos))}</span></li>`).join("")}</ul>` : ""}
${f ? `<button type="button" class="botao-link" data-detalhe="entregador:${esc(ref(f))}">Abrir fechamento, demonstrativo e documentos</button>` : '<p class="nota">A conta a pagar nasce no fechamento oficial da semana.</p>'}</div></details>`;
    return `<tr><td data-rotulo="Entregador" class="esquerda">${composicao}</td>
<td data-rotulo="Entregas">${c?.entregasSemana ?? f?.entregas ?? 0}</td><td data-rotulo="Taxas">${valor(p.taxasCentavos)}</td><td data-rotulo="Extras">${valor(p.extrasCentavos)}</td>
<td data-rotulo="Total devido"><strong>${valor(p.totalDevidoCentavos)}</strong></td><td data-rotulo="Nota fiscal">${nf(f)}</td><td data-rotulo="Conferência">${conf(f)}</td>
<td data-rotulo="Liberação">${lib(f)}</td><td data-rotulo="Pagamento">${f ? (f.contaManual ? '<span class="selo selo--info">Conta manual</span>' : selo(PAG, f.situacaoPagamento)) : "—"}</td>
<td data-rotulo="Ações">${f ? `<button type="button" class="botao-link" data-detalhe="entregador:${esc(ref(f))}">Abrir</button>` : `<button type="button" class="botao-link" data-detalhe="entregador-pessoa:${esc(p.chave)}">Histórico</button>`}</td></tr>`;
  }).join("");
  return `<section class="card ent-operacional"><div class="card-topo"><h2>Entregadores da semana</h2><span class="nota">${linhas.length} entregador(es) · clique no nome para ver a composição</span></div>
<div class="tabela-rolavel"><table class="tabela tabela--cartoes ent-tabela"><caption class="sr">Entregadores da semana ${esc(s.rotulo)}</caption><thead><tr><th scope="col" class="esquerda">Entregador</th><th scope="col">Entregas</th><th scope="col">Taxas</th><th scope="col">Extras</th><th scope="col">Total devido</th><th scope="col">Nota fiscal</th><th scope="col">Conferência</th><th scope="col">Liberação</th><th scope="col">Pagamento</th><th scope="col">Ações</th></tr></thead><tbody>${corpo}</tbody></table></div></section>`;
}

// ------------------------------------------------------------------ 23/11: Informações dos entregadores (sem cadastro paralelo)
// Os entregadores JÁ EXISTEM no Financeiro (Foody + fechamentos): aqui só se organizam e atualizam as informações deles.
// O WhatsApp é um atributo do entregador (fonte única com o MOVA); notas, fechamentos e pagamentos abrem o painel oficial.
const ENVIO = Object.freeze({ APTO: ["Apto a receber", "ok"], AGUARDANDO_ATUALIZACAO: ["Atualizando no MOVA", "info"], NUMERO_DA_EQUIPE: ["Número da equipe", "erro"], INATIVO: ["Contato desativado", "neutro"], SEM_CADASTRO: ["Sem WhatsApp", "alerta"], MOVA_INDISPONIVEL: ["MOVA indisponível", "neutro"] });
const MOTIVO = Object.freeze({ TROCA_DE_NUMERO: "número trocado", EDICAO: "dados editados", DESATIVADO: "contato desativado" });
const quando = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");

/** Entregadores conhecidos: a lista do servidor (fechamentos + Foody em aberto) ou, sem ela, os que já estão na tela. */
function conhecidosDaTela(c, r) {
  if (c?.oficiais?.itens) return c.oficiais.itens;
  const por = new Map();
  for (const f of r?.fechamentos ?? []) if (!por.has(f.entregador.chave)) por.set(f.entregador.chave, { chave: f.entregador.chave, nome: f.entregador.nome, ultimaSemana: f.semanaInicio, ultimaAtividade: f.semanaInicio, semanas: [f.semanaInicio], semanasFechadas: 1, listaFechadas: [f.semanaInicio], origem: "FECHAMENTO" });
  for (const e of r?.entregadores ?? []) if (!por.has(e.chave)) por.set(e.chave, { chave: e.chave, nome: e.nome, ultimaSemana: null, ultimaAtividade: r.semana?.inicio ?? null, semanas: [], semanasFechadas: 0, origem: "FOODY_SEM_FECHAMENTO" });
  return [...por.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

/**
 * Aba "Informações dos entregadores". `c` = { dados: GET /mova/entregadores, oficiais: GET /mova/entregadores-oficiais } ou
 * { erro } (MOVA fora: a lista continua, só o WhatsApp fica indisponível). Números sempre mascarados (…1234).
 */
export function abaInformacoes(c, ctx = {}, r = null) {
  if (!c) return `<section class="card">${nada("Carregando as informações dos entregadores…")}</section>`;
  const d = c.dados ?? {};
  const movaOk = !c.erro;
  const pode = movaOk && tem(ctx.permissoes, "configurar") && d.unidadeAtendida !== false;
  const porChave = new Map();
  for (const x of d.cadastros ?? []) porChave.set(x.chave, [...(porChave.get(x.chave) ?? []), x]);
  const conhecidos = conhecidosDaTela(c, r);
  const pessoas = [...conhecidos, ...[...porChave.keys()].filter((k) => !conhecidos.some((o) => o.chave === k))
    .map((k) => ({ chave: k, nome: porChave.get(k)[0].nome ?? k, semanas: [], semanasFechadas: 0, origem: "SO_CONTATO" }))];
  const unidade = esc(ctx.unidadeNome || "esta unidade");
  const linhas = pessoas.map((p) => {
    const h = porChave.get(p.chave) ?? [];
    const vig = h.find((x) => x.ativo) ?? null;
    const ultimo = h[0] ?? null;
    const sit = !movaOk ? "MOVA_INDISPONIVEL" : vig ? vig.envio ?? "AGUARDANDO_ATUALIZACAO" : ultimo ? "INATIVO" : "SEM_CADASTRO";
    const campos = (x) => `<input type="hidden" name="entregador" value="${esc(p.chave)}">
<label>WhatsApp ${vig ? '<span class="nota">(em branco mantém o atual)</span>' : ""}<input name="telefone" type="tel" inputmode="tel" autocomplete="off" placeholder="(85) 9XXXX-XXXX" ${vig ? "" : "required"}></label>
<label>Nome de exibição <input name="nome" maxlength="60" value="${esc(x?.nome ?? p.nome ?? "")}"></label>
<label class="ent-cad__obs">Observações operacionais <textarea name="observacoes" maxlength="500" rows="2">${esc(x?.observacoes ?? "")}</textarea></label>`;
    const formulario = !pode ? "" : vig
      ? `<form class="ent-cad__form" data-acao-mova="/api/fv2/acoes/mova/entregador-alterar">${campos(vig)}<div class="ent-cad__botoes"><button type="submit" class="botao botao--primario">Salvar</button><button type="reset" class="botao">Cancelar</button><button type="button" class="botao botao--perigo" data-acao-mova-botao="/api/fv2/acoes/mova/entregador-revogar" data-entregador="${esc(p.chave)}">Desativar contato para mensagens</button></div><p class="nota">Desativar o contato não desativa o entregador no Financeiro.</p><p class="resultado-acao" role="status"></p></form>`
      : ultimo
        ? `<form class="ent-cad__form" data-acao-mova="/api/fv2/acoes/mova/entregador-reativar"><input type="hidden" name="entregador" value="${esc(p.chave)}"><p class="nota">Contato desativado (último número ${esc(ultimo.telefone)}). Reativar usa o mesmo número; para outro, reative e edite.</p><div class="ent-cad__botoes"><button type="submit" class="botao botao--primario">Reativar contato</button></div><p class="resultado-acao" role="status"></p></form>`
        : `<form class="ent-cad__form" data-acao-mova="/api/fv2/acoes/mova/entregador">${campos(null)}<div class="ent-cad__botoes"><button type="submit" class="botao botao--primario">Adicionar WhatsApp</button><button type="reset" class="botao">Cancelar</button></div><p class="resultado-acao" role="status"></p></form>`;
    const semanas = (p.semanas ?? []).slice(0, 6);
    const historico = h.length ? `<ol class="ent-info__hist">${h.map((x) => `<li><span>${esc(x.telefone)}${x.nome ? ` · ${esc(x.nome)}` : ""}</span><span class="nota">${x.ativo ? `vigente desde ${esc(quando(x.criadoEm))}` : `${esc(quando(x.criadoEm))} → ${esc(quando(x.revogadoEm))} · ${esc(MOTIVO[x.motivoRevogacao] ?? "encerrado")}`}</span></li>`).join("")}</ol>` : '<p class="nota">Nenhuma alteração de contato registrada.</p>';
    const origem = p.origem === "FOODY_SEM_FECHAMENTO" ? '<span class="selo selo--info">Identificado no Foody · sem fechamento</span>' : p.origem === "SO_CONTATO" ? '<span class="selo selo--alerta">Sem atividade recente</span>' : "";
    return `<li class="ent-info" data-cad-linha data-nome="${esc(`${p.nome ?? ""} ${vig?.nome ?? ""}`.toLowerCase())}" data-situacao="${esc(sit)}">
<details class="ent-info__item"><summary class="ent-info__resumo"><span class="ent-info__nome"><strong>${esc(p.nome ?? p.chave)}</strong>${vig?.nome && vig.nome !== p.nome ? `<span class="nota">exibido como ${esc(vig.nome)}</span>` : ""}${p.nomeRepetido ? '<span class="selo selo--alerta" title="Outro entregador tem o mesmo nome; confira antes de editar">Nome repetido</span>' : ""}</span>
<span class="ent-info__contato">${vig ? `<code>${esc(vig.telefone)}</code>` : '<span class="nota">sem número</span>'}</span>${selo(ENVIO, sit)}${origem}</summary>
<div class="ent-info__corpo">
<section class="ent-info__secao"><h3>Dados e contato</h3><dl class="ent-info__dados"><div><dt>Unidade</dt><dd>${unidade}</dd></div><div><dt>Nome no Financeiro/Foody</dt><dd>${esc(p.nome ?? p.chave)}</dd></div><div><dt>Nome de exibição</dt><dd>${esc(vig?.nome ?? "—")}</dd></div><div><dt>WhatsApp</dt><dd>${vig ? esc(vig.telefone) : "—"}</dd></div><div><dt>Observações</dt><dd>${esc(vig?.observacoes ?? "—")}</dd></div><div><dt>Atualizado em</dt><dd>${esc(quando(vig?.criadoEm ?? ultimo?.revogadoEm))}</dd></div></dl>${formulario}</section>
<section class="ent-info__secao"><h3>Semanas e fechamentos</h3>${semanas.length ? `<ul class="ent-info__semanas">${semanas.map((s) => (p.listaFechadas ?? []).includes(s) ? `<li class="ent-info__semana--fechada">${esc(dataBR(s))} · fechada</li>` : `<li>${esc(dataBR(s))} · sem fechamento</li>`).join("")}</ul>` : '<p class="nota">Ainda sem semana registrada.</p>'}<p class="nota">${p.semanasFechadas ? `${p.semanasFechadas} semana(s) com fechamento oficial.` : "Nenhum fechamento oficial ainda: nenhuma conta foi criada."}</p></section>
<section class="ent-info__secao"><h3>Notas fiscais e pagamentos</h3><p class="nota">Situação das notas, valores fechados e pagos e o histórico financeiro ficam no painel oficial do entregador.</p>${p.semanasFechadas ? `<button type="button" class="botao" data-detalhe="entregador-pessoa:${esc(p.chave)}">Abrir notas, fechamentos e pagamentos</button>` : ""}</section>
<section class="ent-info__secao"><h3>Histórico de alterações</h3>${historico}</section>
</div></details></li>`;
  }).join("");
  const aptos = (d.cadastros ?? []).filter((x) => x.ativo && x.envio === "APTO").length;
  const avisos = [
    !movaOk ? `<p class="aviso aviso--alerta">${esc(c.erro)} Os entregadores continuam listados; só o WhatsApp fica indisponível.</p>` : "",
    movaOk && d.unidadeAtendida === false ? '<p class="aviso aviso--alerta">Esta unidade ainda não é atendida pelo MOVA: o WhatsApp só pode ser informado depois que a unidade for configurada no MOVA (com autorização do proprietário).</p>' : "",
    movaOk && !tem(ctx.permissoes, "configurar") ? '<p class="nota">Você pode consultar. Alterar o WhatsApp exige a permissão de configurar.</p>' : "",
  ].join("");
  return `${quadroNotificacoes(c.notificacoes, ctx)}<section class="card ent-cad"><div class="card-topo"><h2>Informações dos entregadores</h2><span class="nota">${pessoas.length} entregador(es) · ${aptos} apto(s) a receber mensagens</span></div>
<p class="nota">Os entregadores vêm do próprio Financeiro (Foody e fechamentos semanais): nada é cadastrado à mão. Aqui você mantém o WhatsApp, o nome de exibição e as observações. Um número alterado vale para o MOVA em até 1 minuto e o antigo deixa de receber. Não pedimos CPF, Pix nem outros dados sensíveis.</p>
${avisos}
<div class="ent-cad__filtros" role="search"><label>Pesquisar <input type="search" data-cad-busca placeholder="Nome do entregador"></label>
<label>Contato <select data-cad-situacao><option value="">Todos</option>${Object.entries(ENVIO).filter(([k]) => k !== "MOVA_INDISPONIVEL").map(([k, [t]]) => `<option value="${k}">${esc(t)}</option>`).join("")}</select></label>
<span class="nota">Unidade: use o seletor de unidade no topo.</span></div>
${linhas ? `<ul class="ent-info__lista" aria-label="Entregadores da unidade">${linhas}</ul><p class="nota" data-cad-vazio hidden>Nenhum entregador com esse filtro.</p>`
    : nada("Nenhum entregador identificado ainda nesta unidade. Eles aparecem assim que o Foody registrar entregas (antes mesmo do fechamento semanal).")}</section>`;
}

const ESTADO_NOTIF = { PENDENTE: "Na fila", AGUARDANDO_ENTREGADOR: "Aguardando envio ao entregador", ENFILEIRADO: "Enviando", ENVIADO: "Enviada", FALHOU: "Falhou", SEM_TELEFONE: "Entregador sem WhatsApp", SEM_GRUPO: "Unidade sem grupo financeiro", CANCELADO: "Cancelada" };
const TIPO_NOTIF = { PAGAMENTO: "Pagamento", PAGAMENTO_PARCIAL: "Pagamento parcial", ESTORNO: "Estorno", AVISO_GRUPO: "Aviso ao grupo" };
const dataHora = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 16)}` : "—");
/** 27/11 — Notificações automáticas de pagamento: indicadores, histórico e reenvio controlado. Sem telefone nem texto da mensagem. */
export function quadroNotificacoes(n, ctx = {}) {
  if (!n) return "";
  if (n.ligado === false) return '<section class="card"><h2>Notificações de pagamento</h2><p class="nota">As notificações automáticas ainda não estão ativas nesta unidade.</p></section>';
  const ind = n.indicadores ?? { total: 0, porEstado: {}, falhas: 0, entregadoresNotificados: 0 };
  const at = n.atendimentoResumo ?? { respostas: 0, deterministicas: 0, ia: 0, bloqueadas: 0, tokens: 0 };
  const pode = tem(ctx.permissoes, "configurar");
  const linhas = (n.itens ?? []).slice(0, 60).map((i) => `<tr><td>${esc(dataHora(i.criadoEm))}</td><td>${esc(i.destino === "GRUPO" ? "Grupo financeiro" : i.entregador ?? "—")}</td><td>${esc(TIPO_NOTIF[i.tipo] ?? i.tipo)}</td><td>${i.valorCentavos == null ? "—" : esc(moeda(i.valorCentavos))}</td><td><strong>${esc(ESTADO_NOTIF[i.estado] ?? i.estado)}</strong>${i.erro ? ` <span class="nota">(${esc(i.erro)})</span>` : ""}${i.reenvios ? ` <span class="nota">· ${i.reenvios} reenvio(s)</span>` : ""}</td><td>${esc(dataHora(i.enviadoEm))}</td><td>${i.podeReenviar && pode ? `<form data-acao-mova="/api/fv2/acoes/mova/notificacao-reenviar"><input type="hidden" name="eventoId" value="${esc(i.id)}"><button type="submit" class="botao">Reenviar</button><span class="resultado-acao" role="status"></span></form>` : ""}</td></tr>`).join("");
  return `<section class="card ent-notif"><div class="card-topo"><h2>Notificações de pagamento</h2><span class="nota">desde ${esc(n.desde ?? "")}</span></div>
<p class="nota">Enviadas pelo MOVA depois que o pagamento é confirmado no Financeiro, qualquer que seja a origem (sistema, comprovante, conciliação). "Enviada" significa aceita pelo WhatsApp; a confirmação de leitura não é medida.</p>
<ul class="ent-notif__indicadores"><li><strong>${ind.total}</strong> notificações</li><li><strong>${ind.entregadoresNotificados}</strong> entregadores avisados</li><li><strong>${ind.falhas}</strong> com falha</li><li><strong>${at.respostas}</strong> respostas no privado (${at.deterministicas} sem IA, ${at.ia} com IA, ${at.bloqueadas} recusadas) · ${at.tokens} tokens</li></ul>
${linhas ? `<div class="tabela-rolavel"><table class="tabela"><thead><tr><th>Quando</th><th>Para</th><th>Tipo</th><th>Valor</th><th>Situação</th><th>Enviada em</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>` : nada("Nenhuma notificação no período.")}</section>`;
}

/** Tela principal. `f.aba` escolhe a seção; os dados vêm prontos do servidor. */
/**
 * QUADRO DA CONFERÊNCIA mostrado logo depois de anexar a nota (resposta do servidor: o fechamento + `leituraDaNota`).
 * Só apresenta o que o servidor já decidiu: liberado no ato ou para conferência, item a item. Puro (HTML).
 */
export function quadroDaConferencia(f) {
  const l = f?.leituraDaNota;
  if (!l) return "";
  const nota = l.leitura ?? null;
  const motivos = l.motivos ?? [];
  const tem = (re) => motivos.some((m) => re.test(m));
  const devido = f.valorCentavos;
  const periodo = nota?.periodo ? `${dataBR(nota.periodo.inicio)} a ${dataBR(nota.periodo.fim)}` : null;
  const itens = l.lida ? [
    ["Valor", l.valorCentavos !== null && l.valorCentavos !== undefined ? `${moeda(l.valorCentavos)} na nota · ${moeda(devido)} devido` : "não encontrado na nota", l.valorCentavos === devido],
    ["Empresa (tomador)", nota?.tomador?.naoIdentificado ? "a nota não identifica a empresa" : (l.tomador ?? "—"), !tem(/tomador/i)],
    ["Emitente", l.emitente ?? "—", !tem(/emitente/i)],
    ["Data", [periodo ? `período ${periodo}` : null, nota?.competencia ? `competência ${dataBR(nota.competencia)}` : null, nota?.emissao ? `emitida em ${dataBR(nota.emissao)}` : null].filter(Boolean).join(" · ") || "—", !tem(/período|competência/i)],
    ["Nota", `nº ${l.numero ?? "—"}${nota?.chaveAcesso ? " · chave única" : ""}`, true],
  ] : [];
  const liberada = l.liberadaAutomaticamente === true;
  const cabeca = liberada
    ? `<div class="conf-nota__selo conf-nota__selo--ok" aria-hidden="true">✓</div><h2 id="conf-nota-titulo">Pagamento liberado</h2><p class="conf-nota__sub">A nota confere com a semana. Nada mais a fazer: a baixa sai pelo extrato.</p>`
    : `<div class="conf-nota__selo conf-nota__selo--alerta" aria-hidden="true">!</div><h2 id="conf-nota-titulo">Nota recebida — falta conferir</h2><p class="conf-nota__sub">${l.lida ? "Algum item não bateu. Confira e aprove na ficha do entregador." : "Não foi possível ler os dados deste arquivo (não é o PDF do emissor nacional ou é uma imagem). Confira e aprove na ficha do entregador."}</p>`;
  return `<button type="button" class="botao-fechar conf-nota__x" data-fechar-quadro aria-label="Fechar">×</button>
<div class="conf-nota__topo">${cabeca}</div>
<p class="conf-nota__quem">${esc(f.entregadorNome ?? "")} · semana ${esc(rotuloCurto(f.semanaInicio, f.semanaFim))}</p>
${itens.length ? `<ul class="conf-nota__itens">${itens.map(([t, v, ok]) => `<li class="conf-nota__item conf-nota__item--${ok ? "ok" : "alerta"}"><span class="conf-nota__marca" aria-hidden="true">${ok ? "✓" : "!"}</span><span><strong>${esc(t)}</strong><br><span class="conf-nota__valor">${esc(v)}</span></span><span class="sr">${ok ? "confere" : "não confere"}</span></li>`).join("")}</ul>` : ""}
${!liberada && motivos.length ? `<ul class="conf-nota__motivos">${motivos.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
<div class="conf-nota__rodape"><button type="button" class="botao botao--primario" data-fechar-quadro>${liberada ? "Ok" : "Entendi"}</button></div>`;
}
const rotuloCurto = (ini, fim) => (ini && fim ? `${dataBR(ini).slice(0, 5)} a ${dataBR(fim)}` : "");

/**
 * Dados da nota vigente (digitados ou lidos do PDF da NFS-e) e o que não bate com a semana — só para a conferência humana.
 * Nada aqui aprova: a pessoa continua marcando cada item e decidindo.
 */
export function dadosDaNota(d) {
  const n = d.notaVigente;
  if (!n || !["NF_RECEBIDA", "NF_EM_CONFERENCIA", "NF_APROVADA"].includes(d.situacaoDocumental)) return "";
  const l = n.leitura ?? null;
  const avisos = [];
  if (n.valorCentavos === null || n.valorCentavos === undefined) avisos.push("A nota foi anexada sem valor: reenvie a nota (o PDF do emissor nacional é lido sozinho) ou informe o valor.");
  else if (n.valorCentavos !== d.valorCentavos) avisos.push(`Valor da nota ${moeda(n.valorCentavos)} diferente do total devido ${moeda(d.valorCentavos)}.`);
  if (l?.tomador?.naoIdentificado) avisos.push("A nota não identifica o tomador (a empresa que contratou o serviço).");
  if (l?.periodo && (l.periodo.inicio !== d.semanaInicio || l.periodo.fim !== d.semanaFim)) avisos.push(`Período escrito na nota (${dataBR(l.periodo.inicio)} a ${dataBR(l.periodo.fim)}) diferente da semana ${d.rotuloSemana}.`);
  const motivos = n.automatica && !n.automatica.liberada ? n.automatica.motivos ?? [] : [];
  const linha = (t, v) => (v ? `<dt>${esc(t)}</dt><dd>${esc(v)}</dd>` : "");
  return `<section class="card"><div class="card-topo"><h3>Dados da nota</h3>${l ? '<span class="selo selo--info">lidos do PDF da NFS-e</span>' : ""}</div>
<dl class="ficha ficha--compacta">${linha("Número", n.numero)}${linha("Emitente", n.emitente)}${linha("Tomador", n.tomador)}${linha("Valor", n.valorCentavos !== null && n.valorCentavos !== undefined ? moeda(n.valorCentavos) : "não informado")}${linha("Competência da nota", l?.competencia ? dataBR(l.competencia) : null)}${linha("Emissão", l?.emissao ? dataBR(l.emissao) : null)}${linha("Período escrito", l?.periodo ? `${dataBR(l.periodo.inicio)} a ${dataBR(l.periodo.fim)}` : null)}${linha("Chave de acesso", l?.chaveAcesso)}</dl>
${motivos.length ? `<p class="aviso aviso--alerta"><strong>Não foi liberada automaticamente:</strong> ${esc(motivos.join(" "))} Confira e aprove abaixo.</p>` : ""}
${avisos.length ? `<ul class="lista-simples">${avisos.map((a) => `<li class="aviso aviso--alerta">${esc(a)}</li>`).join("")}</ul>` : '<p class="nota">Número, valor e período conferem com a semana. Confira emitente e tomador antes de aprovar.</p>'}</section>`;
}

export function entregadoresProprios(r, f = {}, ctx = {}) {
  const aba = ABAS.some(([k]) => k === f.aba) ? f.aba : "resumo";
  const i = r.indicadores;
  const nav = `<nav class="abas abas--botoes" aria-label="Seções de Entregadores Próprios">${ABAS.map(([k, t]) => `<button type="button" data-aba-canal="${k}"${k === aba ? ' aria-current="page"' : ""}>${esc(t)}</button>`).join("")}</nav>`;
  const notas = r.fechamentos.filter((x) => x.situacaoDocumental !== "LIBERADO_PAGAMENTO" && x.obrigacaoId);
  const corpo = {
    resumo: () => `${cabecalhoOperacional(r, ctx)}${indicadoresDoResumo(r)}${tabelaOperacional(r)}`,
    entregadores: () => `<section class="ent-cards" aria-label="Entregadores">${r.entregadores.length ? r.entregadores.map(cardEntregador).join("") : nada("Nenhum entregador com entregas nesta unidade.")}</section>`,
    informacoes: () => abaInformacoes(ctx.cadastro, ctx, r),
    fechamento: () => abaFechamento(r, ctx),
    extras: () => abaExtras(r, ctx),
    notas: () => `${r.cofreDisponivel ? "" : '<p class="aviso aviso--alerta">O envio de arquivos está desligado até o cofre privado ser ativado. A obrigação continua visível e bloqueada para pagamento.</p>'}<section class="card"><h2>Notas fiscais pendentes</h2>${tabela(notas, "Nenhuma nota pendente neste filtro.")}</section>`,
    pagamentos: () => `<section class="card"><h2>Pagamentos</h2><p class="nota">A baixa acontece em Contas a Pagar, pela saída identificada no extrato bancário. Chegar a quarta-feira nunca marca a conta como paga.</p>${tabela(r.fechamentos, "Nenhuma obrigação neste filtro.")}</section>`,
    historico: () => `<section class="card"><h2>Semanas processadas</h2>${r.semanas.some((s) => !s.semRegistro) ? `<ul class="lista-simples">${r.semanas.filter((s) => !s.semRegistro).map((s) => `<li><span>Semana ${esc(s.rotulo)}${s.origem ? ` · ${s.origem === "AUTOMATICA" ? "fechamento automático" : "fechamento manual"}` : ""}${s.pendencias ? ` · ${s.pendencias} pendência(s)` : ""}${s.divergenciasAbertas ? ` · ${s.divergenciasAbertas} alteração(ões) sem decisão` : ""}</span>${selo(SEMANA, s.situacao)}</li>`).join("")}</ul>` : nada("Nenhuma semana processada ainda.")}</section><section class="card"><h2>Todos os fechamentos</h2>${tabela(r.fechamentos, "Nenhum fechamento neste filtro.")}</section>`,
  }[aba]();
  return `<header class="cabecalho"><div><h1>Entregadores Próprios</h1><p class="subtitulo">${ctx.unidadeNome ? `${esc(ctx.unidadeNome)} · ` : ""}Acompanhe a semana, confira as notas e libere o pagamento de quarta-feira.</p></div></header>${nav}${aba === "informacoes" ? "" : filtros(r, f)}${corpo}`;
}

const fechar = (t) => `<div class="painel-cabeca"><h2 id="painel-titulo">${esc(t)}</h2><button type="button" class="botao-fechar" data-fechar-painel aria-label="Fechar">×</button></div>`;

/** Texto simples do demonstrativo, pronto para enviar ao entregador. */
export function textoDoDemonstrativo(d, unidade) {
  return [`Demonstrativo semanal — ${d.entregador.nome}`, `Unidade: ${unidade}`, `Período: ${d.rotuloSemana}`, `Entregas: ${d.entregas}`, ...d.itens.map((i) => `${curta(i.data)} · ${TIPO_ITEM[i.tipo] ?? i.tipo}${i.numeroPedido ? ` ${i.numeroPedido}` : ""} · ${moeda(i.valorCentavos)}`), `Ajustes: ${moeda(d.ajustesCentavos)}`, `Total devido: ${moeda(d.valorCentavos)}`, `Nota fiscal até ${dataBR(d.prazoDaNota)} · Vencimento ${dataBR(d.vencimento)}`].join("\n");
}

/** Painel do fechamento: demonstrativo, documentos, conferência e situação do pagamento. */
export function detalheDoFechamento(d, ctx = {}) {
  const p = d.permissoes;
  const k = ocultos(d.semanaInicio, d.entregador.chave);
  const recarregar = `entregador:${d.semanaInicio}|${d.entregador.chave}`;
  const nota = d.notaVigente;
  const pode = (a) => tem(p, a);
  const dup = d.duplicidade?.situacao === "ABERTA" && pode("registrar") ? `<section class="card card--alertas"><h3>Possível duplicidade com conta manual</h3><ul class="lista-simples">${d.duplicidade.candidatas.map((c) => `<li><span>${esc(c.descricao)} · vence ${esc(dataBR(c.vencimento))}</span>${valor(c.valorCentavos)}</li>`).join("")}</ul>
${acao({ url: "/api/fv2/acoes/entregadores/duplicidade", titulo: "Decidir", rotulo: "Registrar decisão", recarregar, aberto: true, aviso: "Confirmo a decisão sobre a duplicidade.", campos: `${k}<label>Decisão <select name="decisao"><option value="VINCULAR_MANUAL">É o mesmo pagamento: vincular à conta manual</option><option value="GERAR_DIFERENCA">A conta manual cobre parte: gerar só a diferença</option><option value="GERAR_NOVA">São serviços diferentes: gerar a conta da semana</option></select></label><label>Conta manual <select name="obrigacaoManual">${d.duplicidade.candidatas.map((c) => `<option value="${esc(c.obrigacaoId)}">${esc(c.descricao)} · ${esc(moeda(c.valorCentavos))}</option>`).join("")}</select></label>${justificativa()}` })}</section>` : "";
  const podeAnexar = d.obrigacaoId && d.cofreDisponivel && pode("enviar_documento") && d.situacaoDocumental !== "LIBERADO_PAGAMENTO";
  const anexar = podeAnexar ? acao({ url: "/api/fv2/acoes/entregadores/documento", titulo: "Anexar documento", rotulo: "Enviar documento", arquivo: true, recarregar, aberto: ["AGUARDANDO_NF", "NF_REJEITADA"].includes(d.situacaoDocumental), aviso: "Confirmo o envio. Um arquivo anterior nunca é apagado.",
    campos: `${k}<label>Tipo <select name="tipoAnexo"><option value="NOTA_FISCAL">Nota fiscal</option><option value="DEMONSTRATIVO">Demonstrativo semanal</option><option value="COMPROVANTE">Comprovante de pagamento</option><option value="OUTRO">Outro documento</option></select></label><label>Arquivo (PDF, PNG ou JPEG, até 5 MiB) <input type="file" accept="application/pdf,image/png,image/jpeg" required></label><p class="nota" data-arquivo-escolhido>Nenhum arquivo escolhido.</p><p class="nota">Nota em PDF do emissor nacional (DANFSe): deixe os campos abaixo em branco — número, emitente, tomador e valor são lidos do arquivo. Se tudo conferir com a semana, a nota é aprovada e o pagamento é liberado no mesmo ato; se algo não bater, ela fica para conferência com o motivo.</p><div class="grade-2"><label>Número da nota <input name="numero" maxlength="60"></label><label>Valor da nota (R$) <input name="valor" inputmode="decimal" pattern="[0-9.]{1,13}(,[0-9]{1,2})?"></label><label>Emitente <input name="emitente" maxlength="160"></label><label>Tomador <input name="tomador" maxlength="160"></label></div><label>Período ou referência <input name="referencia" maxlength="160" value="Semana ${esc(d.rotuloSemana)}"></label>` }) : "";
  const conferir = d.situacaoDocumental === "NF_RECEBIDA" && pode("conciliar") ? acao({ url: "/api/fv2/acoes/entregadores/conferir", titulo: "Iniciar conferência", rotulo: "Iniciar conferência", recarregar, aberto: true, aviso: "Confirmo o início da conferência.", campos: k }) : "";
  const itens = [["emitente", "Emitente"], ["tomador", "Tomador"], ["periodo", "Período ou referência"], ["valor", `Valor igual a ${moeda(d.valorCentavos)}`], ["numero", "Número da nota"], ["duplicidade", "Nota não usada em outra semana"]];
  const decidir = d.situacaoDocumental === "NF_EM_CONFERENCIA" && pode("conciliar") ? acao({ url: "/api/fv2/acoes/entregadores/decidir-nota", titulo: "Registrar conferência", rotulo: "Registrar decisão", recarregar, aberto: true, aviso: "Confirmo que conferi o documento. Um PDF enviado não comprova validade fiscal sozinho.",
    campos: `${k}<fieldset><legend>Itens conferidos</legend>${itens.map(([n, t]) => `<label class="caixa-marcar"><input type="checkbox" name="${n}"> ${esc(t)}</label>`).join("")}</fieldset><label>Decisão <select name="decisao"><option value="APROVAR">Aprovar nota</option><option value="REJEITAR">Rejeitar nota</option></select></label>${justificativa()}` }) : "";
  const liberar = d.situacaoDocumental === "NF_APROVADA" && pode("conciliar") ? acao({ url: "/api/fv2/acoes/entregadores/liberar", titulo: "Liberar para pagamento", rotulo: "Liberar pagamento", recarregar, aberto: true, aviso: "Confirmo a liberação. O pagamento continua sendo feito pela empresa e baixado pelo extrato.", campos: `${k}<label class="caixa-marcar"><input type="checkbox" name="demonstrativoConferido"> Conferi o demonstrativo desta semana</label>${justificativa()}` }) : "";
  const pagoAntes = d.semanaHistorica && d.saidasDoExtrato?.length && pode("conciliar") ? acao({ url: "/api/fv2/acoes/entregadores/pagamento-historico", titulo: "Esta semana já foi paga antes do sistema", rotulo: "Reconhecer pagamento", recarregar, aviso: "Confirmo que esta saída do extrato pagou esta semana e dispenso a nota desta semana histórica. A baixa continua em Contas a Pagar.",
    campos: `${k}<label>Saída do extrato <select name="movimentacao" required>${d.saidasDoExtrato.map((m) => `<option value="${esc(m.id)}">${esc(dataBR(m.data))} · ${esc(moeda(m.livreCentavos))} livres · ${esc(m.descricao.slice(0, 70))}</option>`).join("")}</select></label>${justificativa()}` }) : "";
  return `${fechar(d.entregador.nome)}
<p>${selo(DOC, d.situacaoDocumental)} ${d.contaManual ? '<span class="selo selo--info">Conta manual vinculada</span>' : selo(PAG, d.situacaoPagamento)}</p>
${d.impedimentoDocumental ? '<p class="aviso aviso--erro">Impedimento documental: a conta venceu ou vence hoje sem liberação da nota fiscal. O pagamento está bloqueado.</p>' : ""}
<dl class="ficha ficha--compacta"><dt>Semana</dt><dd>${esc(d.rotuloSemana)}</dd><dt>Entregas</dt><dd>${d.entregas}</dd><dt>Entregas (valor)</dt><dd>${valor(d.entregasCentavos)}</dd><dt>Ajustes</dt><dd>${valor(d.ajustesCentavos)}</dd><dt>Total das taxas Foody</dt><dd><strong>${valor(d.valorCentavos)}</strong></dd><dt>Prazo da nota</dt><dd>${esc(dataBR(d.prazoDaNota))}</dd><dt>Vencimento</dt><dd>${esc(dataBR(d.vencimento))}</dd></dl>
${dup}${pagoAntes}${dadosDaNota(d)}${conferir}${decidir}${liberar}${anexar}
${d.extras?.length ? `<section class="card"><h3>Serviços extras (fora das taxas Foody)</h3><ul class="lista-simples">${d.extras.map((x) => `<li><span>${esc(dataBR(x.data))} · ${esc(x.descricao)}<br>${selo(EXTRA, x.situacao)}</span>${valor(x.valorCentavos)}</li>`).join("")}</ul></section>` : ""}
<section class="card ent-demonstrativo" id="demonstrativo"><div class="card-topo"><h3>Demonstrativo</h3><button type="button" class="botao-link" data-copiar-demonstrativo>Copiar texto</button><button type="button" class="botao-link" data-imprimir-demonstrativo>Imprimir ou salvar PDF</button></div>
<div class="tabela-rolavel"><table class="tabela tabela--cartoes"><caption class="sr">Entregas da semana</caption><thead><tr><th scope="col">Data</th><th scope="col" class="esquerda">Item</th><th scope="col">Valor</th></tr></thead><tbody>${d.itens.map((i) => `<tr><td data-rotulo="Data">${esc(curta(i.data))}</td><td data-rotulo="Item" class="esquerda">${esc(TIPO_ITEM[i.tipo] ?? i.tipo)}${i.numeroPedido ? ` · pedido ${esc(i.numeroPedido)}` : ""}${i.motivo ? `<br><span class="nota">${esc(i.motivo)}</span>` : ""}</td><td data-rotulo="Valor">${valor(i.valorCentavos)}</td></tr>`).join("")}</tbody></table></div></section>
<section class="card"><h3>Documentos</h3><p class="nota">${esc(d.pasta.join(" › "))}</p>${d.documentos.length ? `<ul class="lista-simples">${d.documentos.map((x) => `<li><span>${esc(x.tipo)} · recebido em ${esc(dataBR(x.recebidoEm))} · ${esc(x.enviadoPor)}</span>${pode("documentos") ? `<button type="button" class="botao-link" data-entregador-doc="${esc(x.id)}" data-inicio="${esc(d.semanaInicio)}" data-entregador="${esc(d.entregador.chave)}">Baixar</button>` : ""}</li>`).join("")}</ul>` : nada("Nenhum documento anexado.")}${nota ? `<p class="nota">Nota vigente: nº ${esc(nota.numero ?? "não informado")} · ${esc(nota.emitente ?? "emitente não informado")}</p>` : ""}</section>
<details class="card"><summary><h3 class="inline">Histórico de conferência</h3></summary><ul class="lista-simples">${d.historico.map((h) => `<li><span>${esc(h.justificativa ?? h.evento)}</span><span class="nota">${esc(new Date(h.em).toLocaleString("pt-BR"))}</span></li>`).join("")}</ul></details>`;
}

export function detalheDoEntregador(d) {
  return `${fechar(d.nome)}<dl class="ficha ficha--compacta"><dt>Identificador operacional</dt><dd>${esc(d.referencia ?? d.chave)}</dd><dt>Entregas fechadas</dt><dd>${d.entregas}</dd><dt>Total fechado</dt><dd>${valor(d.totalCentavos)}</dd><dt>Total pago</dt><dd>${valor(d.pagoCentavos)}</dd></dl>
<p class="nota">Valores desta unidade. Dados fiscais só aparecem quando cadastrados.</p><ul class="lista-simples">${d.fechamentos.map((f) => `<li><span>Semana ${esc(f.rotuloSemana)}<br>${selo(DOC, f.situacaoDocumental)} ${selo(PAG, f.situacaoPagamento)}</span><button type="button" class="botao-link" data-detalhe="entregador:${esc(ref(f))}">${esc(moeda(f.valorCentavos))}</button></li>`).join("")}</ul>`;
}

/** Bloco do detalhe da conta a pagar e do calendário. */
export function blocoNaConta(e) {
  if (!e) return "";
  return `<section class="card card--alertas"><div class="card-topo"><h3>Entregador próprio</h3>${selo(DOC, e.situacaoDocumental)}</div><p>${esc(e.entregador.nome)} · semana ${esc(e.rotuloSemana)} · ${e.entregas} entrega(s) · ${valor(e.valorCentavos)}</p>${e.situacaoDocumental === "LIBERADO_PAGAMENTO" ? "" : '<p class="aviso aviso--alerta">A baixa fica bloqueada até a nota e o demonstrativo serem conferidos.</p>'}<button type="button" class="botao-link" data-detalhe="entregador:${esc(ref(e))}">Abrir demonstrativo e nota fiscal</button></section>`;
}
