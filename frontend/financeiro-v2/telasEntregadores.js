// Entregadores Próprios: acompanhamento da semana, fechamento, notas fiscais e pagamentos. Funções PURAS: dados já calculados pelo
// servidor → HTML escapado. Nenhuma conta de dinheiro acontece aqui.
import { dataBR, esc, moeda } from "./formatar.js";

const ABAS = [["resumo", "Resumo"], ["entregadores", "Entregadores"], ["fechamento", "Fechamento semanal"], ["extras", "Serviços extras"], ["notas", "Notas fiscais"], ["pagamentos", "Pagamentos"], ["historico", "Histórico e conferências"]];
const DOC = Object.freeze({
  AGUARDANDO_NF: ["Aguardando nota fiscal", "alerta"], NF_RECEBIDA: ["Nota fiscal recebida", "info"], NF_EM_CONFERENCIA: ["Nota fiscal em conferência", "info"],
  NF_APROVADA: ["Nota fiscal aprovada", "ok"], NF_REJEITADA: ["Nota fiscal rejeitada", "erro"], LIBERADO_PAGAMENTO: ["Liberado para pagamento", "ok"],
});
const PAG = Object.freeze({ SEM_CONTA: ["Sem conta a pagar", "alerta"], A_PAGAR: ["A pagar", "neutro"], VENCIDO: ["Vencido", "erro"], PARCIAL: ["Pago em parte", "info"], PAGO: ["Pago", "ok"], CANCELADO: ["Cancelado", "neutro"] });
const SEMANA = Object.freeze({ EM_ANDAMENTO: ["Semana em andamento: valores provisórios", "info"], AGUARDANDO_FECHAMENTO: ["Semana encerrada: aguardando fechamento", "alerta"], PENDENTE: ["Fechamento pendente", "alerta"], CONSOLIDADA: ["Semana encerrada: valores consolidados", "ok"] });
const TIPO_ITEM = Object.freeze({ ENTREGA: "Entrega", ENTREGA_MANUAL: "Entrega manual", TAXA_ADICIONAL: "Taxa adicional", MOVIMENTACAO_OPERACIONAL: "Movimentação operacional", AJUSTE: "Ajuste" });
const DECISAO = Object.freeze({ MANTER: "Manter o valor fechado", AJUSTAR_CONTA: "Ajustar a conta em aberto", CONTA_COMPLEMENTAR: "Gerar conta complementar", COMPENSAR_FUTURO: "Compensar em fechamento futuro" });
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

const indicador = (titulo, conteudo, nota) => `<div class="card card--sec"><h3>${esc(titulo)}</h3><p>${conteudo}</p><p class="nota">${esc(nota)}</p></div>`;

function filtros(r, f) {
  const semanas = [{ inicio: r.semanaAtual.inicio, rotulo: `Semana atual (${curta(r.semanaAtual.inicio)} a ${curta(r.semanaAtual.fim)})` }, ...r.semanas.filter((s) => s.inicio !== r.semanaAtual.inicio).map((s) => ({ inicio: s.inicio, rotulo: s.rotulo }))];
  if (!semanas.some((s) => s.inicio === r.semana.inicio)) semanas.push({ inicio: r.semana.inicio, rotulo: r.semana.rotulo });
  const op = (v, t, a) => `<option value="${esc(v)}"${v === (a ?? "") ? " selected" : ""}>${esc(t)}</option>`;
  return `<form class="filtros-locais" data-filtro-local="entregadores-proprios" aria-label="Filtros de entregadores">
<input type="hidden" name="aba" value="${esc(f.aba ?? "resumo")}">
<label>Semana <select name="semana">${semanas.map((s) => op(s.inicio, s.rotulo, r.semana.inicio)).join("")}</select></label>
<label>Outra semana <input type="date" name="semanaLivre" value="" aria-describedby="ajuda-semana"></label>
<label>Mês do vencimento <input type="month" name="mes" value="${esc(f.mes ?? "")}"></label>
<label>Entregador <select name="entregador">${op("", "Todos", f.entregador)}${r.entregadores.map((e) => op(e.chave, e.nome, f.entregador)).join("")}</select></label>
<label>Situação <select name="situacao">${op("", "Todas", f.situacao)}${Object.entries(DOC).map(([k, [t]]) => op(k, t, f.situacao)).join("")}${["VENCIDO", "PAGO"].map((k) => op(k, PAG[k][0], f.situacao)).join("")}</select></label>
<span class="sr" id="ajuda-semana">Escolha qualquer dia da semana desejada.</span></form>`;
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

/** Tela principal. `f.aba` escolhe a seção; os dados vêm prontos do servidor. */
export function entregadoresProprios(r, f = {}, ctx = {}) {
  const aba = ABAS.some(([k]) => k === f.aba) ? f.aba : "resumo";
  const i = r.indicadores;
  const nav = `<nav class="abas abas--botoes" aria-label="Seções de Entregadores Próprios">${ABAS.map(([k, t]) => `<button type="button" data-aba-canal="${k}"${k === aba ? ' aria-current="page"' : ""}>${esc(t)}</button>`).join("")}</nav>`;
  const notas = r.fechamentos.filter((x) => x.situacaoDocumental !== "LIBERADO_PAGAMENTO" && x.obrigacaoId);
  const corpo = {
    resumo: () => `${faixaDaSemana(r)}${resumoFinanceiro(r)}<section class="indicadores ent-indicadores" aria-label="Indicadores">
${indicador(r.semana.provisoria ? "Acumulado da semana (provisório)" : "Total da semana", valor(i.acumuladoSemanaCentavos), `${i.entregas} entrega(s) elegíveis`)}
${indicador("Entregadores ativos", `<span class="valor">${i.entregadoresAtivos}</span>`, "Com entrega elegível na semana")}
${indicador(`Próxima quarta (${curta(i.proximaQuarta.data)})`, valor(i.proximaQuarta.valorCentavos), `${i.proximaQuarta.quantidade} conta(s)`)}
${indicador("Aguardando nota fiscal", valor(i.aguardandoNotaCentavos), "Ainda sem liberação documental")}
${indicador("Liberado para pagamento", valor(i.liberadoCentavos), "Nota e demonstrativo conferidos")}
${indicador("Vencido", valor(i.vencidoCentavos), "Passou da quarta com saldo em aberto")}
${indicador("Pago", valor(i.pagoCentavos), "Baixado pelo extrato bancário")}</section>
<section class="ent-cards" aria-label="Entregadores da semana">${r.entregadores.length ? r.entregadores.map(cardEntregador).join("") : nada("Nenhuma entrega elegível nesta semana.")}</section>`,
    entregadores: () => `<section class="ent-cards" aria-label="Entregadores">${r.entregadores.length ? r.entregadores.map(cardEntregador).join("") : nada("Nenhum entregador com entregas nesta unidade.")}</section>`,
    fechamento: () => abaFechamento(r, ctx),
    extras: () => abaExtras(r, ctx),
    notas: () => `${r.cofreDisponivel ? "" : '<p class="aviso aviso--alerta">O envio de arquivos está desligado até o cofre privado ser ativado. A obrigação continua visível e bloqueada para pagamento.</p>'}<section class="card"><h2>Notas fiscais pendentes</h2>${tabela(notas, "Nenhuma nota pendente neste filtro.")}</section>`,
    pagamentos: () => `<section class="card"><h2>Pagamentos</h2><p class="nota">A baixa acontece em Contas a Pagar, pela saída identificada no extrato bancário. Chegar a quarta-feira nunca marca a conta como paga.</p>${tabela(r.fechamentos, "Nenhuma obrigação neste filtro.")}</section>`,
    historico: () => `<section class="card"><h2>Semanas processadas</h2>${r.semanas.length ? `<ul class="lista-simples">${r.semanas.map((s) => `<li><span>Semana ${esc(s.rotulo)}${s.origem ? ` · ${s.origem === "AUTOMATICA" ? "fechamento automático" : "fechamento manual"}` : ""}${s.pendencias ? ` · ${s.pendencias} pendência(s)` : ""}${s.divergenciasAbertas ? ` · ${s.divergenciasAbertas} alteração(ões) sem decisão` : ""}</span>${selo(SEMANA, s.situacao)}</li>`).join("")}</ul>` : nada("Nenhuma semana processada ainda.")}</section><section class="card"><h2>Todos os fechamentos</h2>${tabela(r.fechamentos, "Nenhum fechamento neste filtro.")}</section>`,
  }[aba]();
  return `<header class="cabecalho"><div><h1>Entregadores Próprios</h1><p class="subtitulo">Acompanhe a semana, confira as notas e libere o pagamento de quarta-feira.</p></div></header>${nav}${filtros(r, f)}${corpo}`;
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
    campos: `${k}<label>Tipo <select name="tipoAnexo"><option value="NOTA_FISCAL">Nota fiscal</option><option value="DEMONSTRATIVO">Demonstrativo semanal</option><option value="COMPROVANTE">Comprovante de pagamento</option><option value="OUTRO">Outro documento</option></select></label><label>Arquivo (PDF, PNG ou JPEG, até 5 MiB) <input type="file" accept="application/pdf,image/png,image/jpeg" required></label><p class="nota" data-arquivo-escolhido>Nenhum arquivo escolhido.</p><div class="grade-2"><label>Número da nota <input name="numero" maxlength="60"></label><label>Valor da nota (R$) <input name="valor" inputmode="decimal" pattern="[0-9.]{1,13}(,[0-9]{1,2})?"></label><label>Emitente <input name="emitente" maxlength="160"></label><label>Tomador <input name="tomador" maxlength="160"></label></div><label>Período ou referência <input name="referencia" maxlength="160" value="Semana ${esc(d.rotuloSemana)}"></label>` }) : "";
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
${dup}${pagoAntes}${conferir}${decidir}${liberar}${anexar}
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
