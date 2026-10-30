// Dashboard Operacional 2.0 — componentes das abas novas (funções puras: payload → HTML).
//
// Abas: Visão Geral e Desempenho · Pedidos e Ficha 360° · Ocorrências e Diagnóstico · Fechamentos e Relatórios.
// Todo número vem pronto do backend (lista de pedidos, ficha, fechamento armazenado e prévia de WhatsApp); nada é recalculado
// aqui. Ausência aparece como "—"/"não disponível" com o motivo, nunca como zero. Texto de dado passa por escapeHtml.
// Não existe dado pessoal nos payloads (o servidor já não envia); a tela também não pede.

import { escapeHtml } from "./utils.js";
import { icon } from "./icons.js";
import { num, dataBr } from "./checklistOperacionalDashboardVisual.js";
import { cssRelatorio } from "./checklistOperacionalRelatorio.js";

export const ABAS_DASHBOARD = Object.freeze([
  { id: "visao", rotulo: "Visão Geral e Desempenho", icone: "bar-chart" },
  { id: "pedidos", rotulo: "Pedidos e Ficha 360°", icone: "receipt" },
  { id: "ocorrencias", rotulo: "Ocorrências e Diagnóstico", icone: "alert-triangle" },
  { id: "fechamentos", rotulo: "Fechamentos e Relatórios", icone: "file-text" },
]);

const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }) : "—");
const dataHora = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "—");
const brl = (v) => (v == null ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const min = (v) => (v == null ? "—" : `${num(v)} min`);
const STATUS = { PLACED: "Recebido", CONFIRMED: "Confirmado", READY_TO_PICKUP: "Pronto", DISPATCHED: "Despachado", CONCLUDED: "Concluído", CANCELLED: "Cancelado" };
const MODALIDADE = { DELIVERY: "Entrega", TAKEOUT: "Retirada", DINE_IN: "Consumo no local", INDOOR: "Consumo no local" };
const LOGISTICA = { IFOOD: "iFood", MERCHANT: "Própria" };
const SITUACAO_FECHAMENTO = { PRELIMINAR: "Preliminar", CONSOLIDADO: "Consolidado", REVISADO: "Revisado", INCOMPLETO: "Incompleto" };
const SIM = { SIMULATED: "Simulada (nada foi enviado)", READY_FOR_REVIEW: "Pronta para revisão", BLOCKED: "Bloqueada pela validação", ERROR: "Erro na geração" };

/** Navegação por abas (WAI-ARIA tabs). */
export function navegacaoAbas(atual) {
  return `<nav class="ckd-abas" role="tablist" aria-label="Seções do Dashboard Operacional">${ABAS_DASHBOARD.map((a) => `
    <button type="button" role="tab" id="ckd-aba-${a.id}" aria-controls="ckd-painel-${a.id}" aria-selected="${a.id === atual}" tabindex="${a.id === atual ? 0 : -1}" data-acao="aba" data-aba="${a.id}" class="ckd-aba${a.id === atual ? " ckd-aba--ativa" : ""}">${icon(a.icone, { size: 16 })}<span>${a.rotulo}</span></button>`).join("")}</nav>`;
}

const estadoCarga = ({ carregando, erro }, texto) => (erro ? `<p class="ckd-erro" role="alert">${escapeHtml(erro)}</p>` : carregando ? `<p class="ckd-carregando" role="status">${escapeHtml(texto)}</p>` : "");

// ---------------------------------------------------------------------------------------------------------------------------
// Pedidos e Ficha 360°
// ---------------------------------------------------------------------------------------------------------------------------

export function painelPedidos({ lista, carregando, erro, busca = "" }) {
  const cab = `<h2 id="ckd-t-ped">Pedidos do período</h2><p class="ckd-nota">Toque em um pedido para abrir a Ficha 360°: linha do tempo oficial, itens, valores operacionais, tempos e ocorrências. Nenhum dado do cliente é exibido.</p>`;
  if (!lista) return `<section class="ckd-bloco" aria-labelledby="ckd-t-ped">${cab}${estadoCarga({ carregando, erro }, "Carregando os pedidos do período…")}</section>`;
  const termo = busca.trim();
  const itens = termo ? lista.itens.filter((i) => String(i.numero ?? "").includes(termo)) : lista.itens;
  const linhas = itens.map((i) => `
    <tr${i.teste ? ' class="ckd-linha-teste"' : ""}>
      <th scope="row"><button type="button" class="ckd-link" data-acao="ficha" data-chave="${escapeHtml(i.chave)}" aria-label="Abrir a ficha do pedido ${escapeHtml(i.numero ?? "sem número")}">#${escapeHtml(i.numero ?? "—")}</button>${i.teste ? ' <small class="ckd-etiqueta">teste</small>' : ""}</th>
      <td>${hora(i.recebidoEm)}</td><td>${STATUS[i.status] ?? escapeHtml(i.status ?? "—")}</td><td>${MODALIDADE[i.modalidade] ?? "—"}${i.logistica ? ` · ${LOGISTICA[i.logistica] ?? escapeHtml(i.logistica)}` : ""}</td>
      <td>${min(i.preparoMin)}</td><td>${min(i.entregaMin)}</td><td>${min(i.vidaMin)}</td>
      <td>${i.atrasado ? `<span class="ckd-selo ckd-selo--ruim">${icon("alert-triangle", { size: 13 })}atrasado</span>` : i.cancelado ? '<span class="ckd-selo">cancelado</span>' : "—"}</td>
      <td>${brl(i.total)}</td><td>${i.problemas ? `<span class="ckd-selo ckd-selo--aviso" title="Problemas de dado neste pedido">${i.problemas}</span>` : "—"}${i.alterado ? ' <span class="ckd-selo" title="Pedido alterado pelo cliente">alterado</span>' : ""}</td>
    </tr>`).join("");
  return `
    <section class="ckd-bloco" aria-labelledby="ckd-t-ped" aria-busy="${carregando ? "true" : "false"}">
      ${cab}
      ${estadoCarga({ carregando, erro }, "Atualizando…")}
      <div class="ckd-busca"><label class="ckd-campo"><span>Número do pedido</span><input type="search" inputmode="numeric" name="busca-pedido" value="${escapeHtml(busca)}" placeholder="ex.: 1234" autocomplete="off"/></label>
        <p class="ckd-nota">${lista.total} ${lista.total === 1 ? "pedido" : "pedidos"} recebidos no período${termo ? ` · ${itens.length} encontrados` : ""}.</p></div>
      ${itens.length ? `<div class="ckd-tabela-wrap"><table class="ckd-tabela ckd-tabela--pedidos"><thead><tr><th scope="col">Pedido</th><th scope="col">Recebido</th><th scope="col">Status</th><th scope="col">Modalidade</th><th scope="col">Preparo</th><th scope="col">Entrega</th><th scope="col">Vida</th><th scope="col">Meta</th><th scope="col">Total (operacional)</th><th scope="col">Dados</th></tr></thead><tbody>${linhas}</tbody></table></div>`
        : `<p class="ckd-vazio">${termo ? "Nenhum pedido com esse número no período." : "Nenhum pedido recebido no período."}</p>`}
    </section>`;
}

function linhaIndicador(x) {
  if (!x) return "";
  const valor = x.estado === "calculado" ? `<b>${min(x.min)}</b>` : `<span class="ckd-indisp">não medido — ${escapeHtml(x.motivo ?? "sem dado")}</span>`;
  const meta = x.meta != null ? ` · meta ${min(x.meta)}${x.atraso ? ` <span class="ckd-selo ckd-selo--ruim">+${num(x.excedenteMin)} min</span>` : x.atraso === false ? ' <span class="ckd-selo ckd-selo--bom">dentro</span>' : ""}` : "";
  return `<tr><th scope="row">${escapeHtml(x.nome)}</th><td>${valor}${meta}</td><td>${escapeHtml(x.inicio ?? "")} → ${escapeHtml(x.fim ?? "")}${x.nota ? `<br><small>${escapeHtml(x.nota)}</small>` : ""}</td></tr>`;
}

/** Conteúdo da Ficha 360° (dentro de um <dialog>). */
export function fichaPedido({ ficha: f, carregando, erro }) {
  if (!f) return `<div class="ckd-ficha">${estadoCarga({ carregando, erro: erro ?? (carregando ? null : "Ficha indisponível.") }, "Carregando a ficha do pedido…")}<footer><button type="button" class="btn btn-ghost" data-acao="fechar-ficha">Fechar</button></footer></div>`;
  const id = f.identificacao;
  const ind = f.indicadores;
  const oc = f.ocorrencias;
  const fin = f.financeiro;
  const itens = f.produtos.itens.map((it) => `<li><b>${num(it.quantidade, 3)}× ${escapeHtml(it.nome)}</b>${it.codigo ? ` <small>código ${escapeHtml(it.codigo)}</small>` : ""} — ${brl(it.valorTotal)}${it.temObservacao ? ' <small class="ckd-etiqueta">com observação</small>' : ""}
    ${it.adicionais.length ? `<ul>${it.adicionais.map((a) => `<li>${num(a.quantidade, 3)}× ${escapeHtml(a.nome)}${a.grupo ? ` <small>(${escapeHtml(a.grupo)})</small>` : ""} — ${brl(a.valor)}</li>`).join("")}</ul>` : ""}</li>`).join("");
  const linha = f.historico.linhaDoTempo.map((e) => `<li><time datetime="${escapeHtml(e.em)}">${hora(e.em)}</time> ${escapeHtml(e.rotulo)} <small>(${escapeHtml(e.codigo)})</small></li>`).join("");
  return `
    <div class="ckd-ficha">
      <header class="ckd-ficha-cab">
        <div><p class="ckd-sobre">Ficha 360° do pedido</p><h2 id="ckd-t-ficha">#${escapeHtml(id.numero ?? "sem número")} <small>${escapeHtml(id.idParcial ?? "")}</small></h2>
          <p>${STATUS[id.status] ?? escapeHtml(id.status ?? "—")} · ${MODALIDADE[id.modalidade] ?? "modalidade desconhecida"}${id.logistica ? ` · logística ${LOGISTICA[id.logistica] ?? escapeHtml(id.logistica)}` : ""} · recebido ${dataHora(id.recebidoEm)}${id.teste ? ' · <span class="ckd-etiqueta">pedido de teste</span>' : ""}</p>
          <p class="ckd-nota">${escapeHtml(id.unidade ?? "")} · origem ${escapeHtml(id.origem ?? "—")} · horário de recebimento pelo ${escapeHtml(id.recebidoFonte ?? "—")}</p></div>
        <button type="button" class="btn btn-ghost" data-acao="fechar-ficha" aria-label="Fechar a ficha">${icon("x", { size: 16 })}</button>
      </header>
      ${oc.integridade.length ? `<ul class="ckd-avisos ckd-avisos--ficha" aria-label="Problemas de dado">${oc.integridade.map((p) => `<li>${icon("alert-triangle", { size: 14 })}<span>${escapeHtml(p.mensagem)}</span></li>`).join("")}</ul>` : ""}
      <section aria-labelledby="ckd-f-ind"><h3 id="ckd-f-ind">Tempos</h3><p class="ckd-nota">${escapeHtml(ind.metaNota)} ${escapeHtml(ind.nota)}</p>
        <div class="ckd-tabela-wrap"><table class="ckd-tabela"><tbody>${[ind.confirmacao, ind.preparo, ind.ateOPronto, ind.esperaEntregador, ind.prontoAteColeta, ind.entrega, ind.vida].map(linhaIndicador).join("")}</tbody></table></div></section>
      <section aria-labelledby="ckd-f-hist"><h3 id="ckd-f-hist">Linha do tempo oficial</h3>
        ${linha ? `<ol class="ckd-linha-tempo">${linha}</ol>` : '<p class="ckd-vazio">Nenhum evento com horário registrado.</p>'}
        ${f.historico.etapasSemRegistro.length ? `<p class="ckd-nota">Etapas sem registro do iFood: ${f.historico.etapasSemRegistro.map((e) => escapeHtml(e.rotulo)).join(", ")} (não medidas; nada é estimado).</p>` : ""}
        ${f.historico.alteracoes.quantidade ? `<p class="ckd-nota">Pedido alterado ${f.historico.alteracoes.quantidade}× (última às ${hora(f.historico.alteracoes.ultimaEm)}).</p>` : ""}</section>
      <section aria-labelledby="ckd-f-prod"><h3 id="ckd-f-prod">Produtos</h3>
        ${f.produtos.disponivel ? `<ul class="ckd-itens">${itens || "<li>Sem itens.</li>"}</ul>` : '<p class="ckd-vazio">Detalhes do pedido indisponíveis.</p>'}
        ${f.produtos.desatualizado ? '<p class="ckd-nota">Atenção: o pedido foi alterado depois da leitura dos itens.</p>' : ""}<p class="ckd-nota">${escapeHtml(f.produtos.observacoes)}</p></section>
      <section aria-labelledby="ckd-f-fin"><h3 id="ckd-f-fin">Financeiro operacional</h3><p class="ckd-nota"><b>${escapeHtml(fin.natureza)}</b></p>
        ${fin.disponivel ? `<dl class="ckd-qualidade"><div><dt>Itens</dt><dd>${brl(fin.itens)}</dd></div><div><dt>Taxa de entrega</dt><dd>${brl(fin.taxaEntrega)}</dd></div><div><dt>Taxas do iFood</dt><dd>${brl(fin.taxasAdicionais)}</dd></div>
          <div><dt>Descontos</dt><dd>${brl(fin.descontos)}</dd></div><div><dt>Total pago pelo cliente</dt><dd>${brl(fin.total)}</dd></div>
          <div><dt>Desconto pago pela loja</dt><dd>${brl(fin.patrocinioDescontos.loja)}</dd></div><div><dt>Desconto pago pelo iFood</dt><dd>${brl(fin.patrocinioDescontos.ifood)}</dd></div>
          <div><dt>Rede / terceiros</dt><dd>${brl(fin.patrocinioDescontos.rede)} / ${brl(fin.patrocinioDescontos.externo)}</dd></div>
          <div><dt>Pagamento</dt><dd>${escapeHtml(fin.pagamento.metodos.join(", ") || "—")}${fin.pagamento.naEntrega ? " (na entrega)" : ""}</dd></div></dl>` : '<p class="ckd-vazio">Valores indisponíveis (sem detalhes do iFood).</p>'}</section>
      <section aria-labelledby="ckd-f-oc"><h3 id="ckd-f-oc">Ocorrências</h3><ul class="ckd-lista-oc">
        ${oc.cancelamento ? `<li>Cancelado ${oc.cancelamento.em ? `às ${hora(oc.cancelamento.em)}` : ""}: ${escapeHtml(oc.cancelamento.descricao ?? "motivo não informado pelo iFood")}${oc.cancelamento.codigo ? ` (código ${escapeHtml(oc.cancelamento.codigo)})` : ""} · origem ${escapeHtml(oc.cancelamento.origem ?? "—")} · estágio ${escapeHtml(oc.cancelamento.estagio ?? "—")}</li>` : ""}
        ${oc.disputas.map((d) => `<li>Disputa ${escapeHtml(d.tipo ?? "")}: ${escapeHtml(d.desfecho ?? "sem desfecho")}${d.venceEm ? ` · prazo ${hora(d.venceEm)}` : ""}</li>`).join("")}
        ${oc.devolucao ? `<li>Devolução: ${oc.devolucao.devolvido ? "pedido devolvido à loja" : "entregador retornando"}</li>` : ""}
        ${oc.atrasos ? `<li>${oc.atrasos} ${oc.atrasos === 1 ? "etapa acima da meta" : "etapas acima da meta"}</li>` : ""}
        ${!oc.cancelamento && !oc.disputas.length && !oc.devolucao && !oc.atrasos ? "<li>Nenhuma ocorrência registrada.</li>" : ""}</ul></section>
      <footer class="ckd-ficha-rodape"><small>Fonte: ${escapeHtml(f.rastreabilidade.fonte)} · regra v${escapeHtml(String(f.rastreabilidade.regraVersao ?? "—"))} · atualizado ${dataHora(f.rastreabilidade.projetadoEm)} · último evento recebido ${dataHora(f.rastreabilidade.ultimoEventoRecebidoEm)}</small>
        <button type="button" class="btn btn-ghost" data-acao="fechar-ficha">Fechar</button></footer>
    </div>`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Fechamentos e Relatórios
// ---------------------------------------------------------------------------------------------------------------------------

function cartao(rotulo, valor, sub = "") {
  return `<article class="ckd-kpi"><h3>${escapeHtml(rotulo)}</h3><p class="ckd-kpi-valor">${valor}</p>${sub ? `<p class="ckd-kpi-sub">${sub}</p>` : ""}</article>`;
}

/** Desvio da meta em palavras ("4 min abaixo", "2,5 min acima", "na meta") — o sinal sozinho é fácil de ler errado. */
const desvio = (d) => (d == null ? "" : Math.abs(d) < 0.05 ? " · na meta" : ` · ${num(Math.abs(d))} min ${d > 0 ? "acima" : "abaixo"}`);

function tempoCartao(t, n) {
  if (!t || t.estado !== "calculado") return cartao(`${n} · ${t?.nome ?? "Etapa"} — tempo médio`, "—", escapeHtml(t?.motivo ? `não disponível: ${t.motivo}` : "não disponível"));
  return cartao(`${n} · ${t.nome} — tempo médio`, `${num(t.media)}<small>min</small>`,
    `${t.meta == null ? "sem meta" : `meta ${num(t.meta)} min${desvio(t.desvioDaMetaMin)}`} · ${t.amostras} ${t.amostras === 1 ? "pedido" : "pedidos"}`);
}

/** Os 11 indicadores do fechamento armazenado (mesmos números do Excel, do PDF e da prévia de WhatsApp). */
export function indicadoresFechamento(f) {
  const i = f.indicadores;
  const p = i.pedidos;
  const c = i.cancelamentos;
  const ds = i.disputas;
  const de = i.descontos;
  const cl = i.clientes;
  const d = f.diagnostico ?? {};
  return `
    <section class="ckd-kpis" aria-label="Indicadores do fechamento">
      ${cartao("1 · Pedidos", `${num(p.recebidos, 0)}<small>recebidos</small>`, `${num(p.concluidosNoDia, 0)} concluídos e ${num(p.canceladosNoDia, 0)} cancelados no dia · dos recebidos: ${num(p.coorte.emAberto, 0)} em aberto`)}
      ${tempoCartao(i.preparo, 2)}${tempoCartao(i.entrega, 3)}${tempoCartao(i.vida, 4)}
      ${cartao("5 · Pedidos atrasados", i.atrasos.pedidosAvaliados ? `${num(i.atrasos.pedidosAtrasados, 0)}<small>de ${num(i.atrasos.pedidosAvaliados, 0)}</small>` : "—", i.atrasos.pct == null ? "sem pedidos avaliados" : `${num(i.atrasos.pct)}%${i.atrasos.principalEtapa ? ` · mais atrasos em ${escapeHtml(i.atrasos.principalEtapa.nome.toLowerCase())}` : ""}`)}
      ${cartao("6 · Cancelamentos", num(c.total, 0), c.motivos.length ? escapeHtml(c.motivos.slice(0, 2).map((m) => `${m.descricao ?? m.codigo ?? "sem motivo"} (${m.quantidade})`).join("; ")) : "nenhum no dia")}
      ${cartao("7 · Maior movimento", i.movimento.picos[0] ? `${String(i.movimento.picos[0].hora).padStart(2, "0")}h` : "—", i.movimento.picos.map((h) => `${String(h.hora).padStart(2, "0")}h: ${h.pedidos}`).join(" · ") || "sem pedidos")}
      ${cartao("8 · Disputas", `${num(ds.abertasNoDia, 0)}<small>abertas</small>`, `${num(ds.expiradasNoDia, 0)} ${ds.expiradasNoDia === 1 ? "expirada" : "expiradas"}${ds.pendentesAgora ? ` · ${ds.pendentesAgora} aguardando resposta` : ""}`)}
      ${cartao("9 · Descontos pagos pela loja", brl(de.loja), `${de.pedidosComDescontoLoja} pedidos · valor operacional (o cobrado está no Financial)`)}
      ${cartao("10 · Clientes", `${num(cl.novos, 0)}<small>novos</small>`, `${num(cl.recorrentes, 0)} recorrentes${cl.semInformacao ? ` · ${cl.semInformacao} sem informação` : ""} · contagem por pedido`)}
    </section>
    <section class="ckd-bloco" aria-labelledby="ckd-t-diag">
      <h2 id="ckd-t-diag">11 · Diagnóstico e ação sugerida</h2>
      <p><b>${escapeHtml(d.texto?.diagnostico ?? d.principal?.fato ?? "—")}</b></p>
      <p>Ação: ${escapeHtml(d.texto?.acao ?? d.principal?.acao ?? "—")}</p>
      <p class="ckd-nota">Redação: ${d.texto?.origem === "ia" ? "assistida por IA sobre os achados comprovados" : "determinística"} · os achados dizem o QUE os dados mostram, não a causa.</p>
      ${(d.achados ?? []).length ? `<details class="ckd-evidencia"><summary>${d.achados.length} ${d.achados.length === 1 ? "achado" : "achados"} com evidências</summary><ul>${d.achados.map((a) => `<li><b>${escapeHtml(a.titulo)}</b> — ${escapeHtml(a.fato)} <small>(referência: ${escapeHtml(a.referencia)}; amostra ${escapeHtml(String(a.amostra ?? "—"))})</small></li>`).join("")}</ul></details>` : ""}
    </section>
    ${(f.pendencias ?? []).length ? `<section class="ckd-bloco" aria-labelledby="ckd-t-pend"><h2 id="ckd-t-pend">Pendências e qualidade dos dados</h2><ul class="ckd-avisos">${f.pendencias.map((p2) => `<li>${icon("info", { size: 14 })}<span>${escapeHtml(p2.mensagem)}</span></li>`).join("")}</ul></section>` : ""}`;
}

export function painelFechamentos({ competencia, hoje, lista, atual, previa, carregando, erro, aviso, podeGerar, motivo = "" }) {
  const versoes = (lista ?? []).filter((x) => x.competencia === competencia);
  const situacao = atual ? `<span class="ckd-selo ckd-selo--${atual.status === "INCOMPLETO" ? "ruim" : atual.status === "PRELIMINAR" ? "aviso" : "bom"}">${SITUACAO_FECHAMENTO[atual.status]}</span>` : "";
  return `
    <section class="ckd-bloco" aria-labelledby="ckd-t-fech" aria-busy="${carregando ? "true" : "false"}">
      <h2 id="ckd-t-fech">Fechamento operacional diário</h2>
      <p class="ckd-nota">Um fechamento por dia e unidade, versionado: uma correção cria nova versão sem apagar a anterior. Preliminar = dia em andamento ou aguardando eventos atrasados (6 h); Consolidado = dados com cobertura; Revisado = corrigido depois de consolidado; Incompleto = dados insuficientes.</p>
      <form class="ckd-filtros" data-ckd-fechamento aria-label="Competência do fechamento">
        <label class="ckd-campo"><span>Dia</span><input type="date" name="competencia" value="${escapeHtml(competencia)}" max="${escapeHtml(hoje)}" required/></label>
        ${podeGerar ? `<label class="ckd-campo ckd-campo--largo"><span>Motivo (obrigatório para revisar dia já consolidado)</span><input type="text" name="motivo" maxlength="500" value="${escapeHtml(motivo)}" placeholder="ex.: cancelamento registrado depois do fechamento"/></label>
          <button type="submit" class="btn btn-primary"${carregando ? ' disabled aria-busy="true"' : ""}>${icon("refresh", { size: 16 })}<span>${carregando ? "Gerando…" : "Gerar / atualizar"}</span></button>` : '<p class="ckd-nota">Somente gestores geram ou revisam fechamentos.</p>'}
      </form>
      ${estadoCarga({ carregando, erro }, "Carregando…")}
      ${aviso ? `<p class="ckd-ok" role="status">${escapeHtml(aviso)}</p>` : ""}
      ${versoes.length ? `<div class="ckd-versoes" role="list" aria-label="Versões do dia">${versoes.map((v) => `<button type="button" role="listitem" class="ckd-versao${atual?.id === v.id ? " ckd-versao--atual" : ""}" data-acao="versao" data-id="${escapeHtml(v.id)}">v${v.versao} · ${SITUACAO_FECHAMENTO[v.status]} · ${dataHora(v.gerado_em)}</button>`).join("")}</div>`
        : `<p class="ckd-vazio">Nenhum fechamento registrado para ${dataBr(competencia)}.${podeGerar ? " Use “Gerar / atualizar”." : ""}</p>`}
    </section>
    ${atual ? `
      <section class="ckd-bloco ckd-fechamento" aria-labelledby="ckd-t-fech-atual">
        <header class="ckd-cab"><div><h2 id="ckd-t-fech-atual">${dataBr(atual.competencia)} · versão ${atual.versao} ${situacao}</h2>
          <p class="ckd-nota">${escapeHtml(atual.fonte?.statusMotivo ?? "")} Gerado ${dataHora(atual.gerado_em)} (${escapeHtml(atual.origem)}) · fuso ${escapeHtml(atual.fuso)}${atual.motivo ? ` · motivo: ${escapeHtml(atual.motivo)}` : ""}</p></div>
          <div class="ckd-acoes"><button type="button" class="btn btn-ghost" data-acao="fech-pdf">${icon("file-text", { size: 16 })}<span>PDF</span></button>
            <button type="button" class="btn btn-ghost" data-acao="fech-excel">${icon("grid", { size: 16 })}<span>Excel</span></button></div></header>
        ${indicadoresFechamento(atual)}
      </section>
      ${painelWhatsapp({ previa, podeGerar })}` : ""}`;
}

export function painelWhatsapp({ previa, podeGerar }) {
  if (!previa) return `<section class="ckd-bloco" aria-labelledby="ckd-t-wa"><h2 id="ckd-t-wa">Prévia do WhatsApp (simulação)</h2><p class="ckd-carregando" role="status">Montando a prévia…</p></section>`;
  const problemas = previa.validacao?.problemas ?? [];
  return `
    <section class="ckd-bloco" aria-labelledby="ckd-t-wa">
      <h2 id="ckd-t-wa">Prévia do WhatsApp <span class="ckd-selo ckd-selo--aviso">SIMULAÇÃO</span></h2>
      <p class="ckd-nota"><b>Nenhuma mensagem é enviada.</b> O envio automático ainda não foi homologado (provedor, consentimentos e destinatários). Esta prévia usa a versão ${previa.fechamento.versao} do fechamento.</p>
      <p>Situação da prévia: <b>${SIM[previa.status] ?? escapeHtml(previa.status)}</b> · ${previa.mensagem ? `${previa.mensagem.length} caracteres` : ""}</p>
      ${problemas.length ? `<ul class="ckd-avisos">${problemas.map((p) => `<li>${icon("alert-triangle", { size: 14 })}<span>${escapeHtml(p.mensagem)}</span></li>`).join("")}</ul>` : ""}
      ${previa.mensagem ? `<pre class="ckd-whatsapp" data-ckd-mensagem aria-label="Texto da mensagem">${escapeHtml(previa.mensagem)}</pre>` : ""}
      <div class="ckd-acoes">
        <button type="button" class="btn btn-ghost" data-acao="wa-copiar"${previa.mensagem ? "" : " disabled"}>${icon("copy", { size: 16 })}<span>Copiar mensagem</span></button>
        <button type="button" class="btn btn-ghost" data-acao="wa-regenerar">${icon("refresh", { size: 16 })}<span>Regenerar prévia</span></button>
        ${podeGerar ? `<button type="button" class="btn btn-primary" data-acao="wa-simular"${previa.status === "READY_FOR_REVIEW" ? "" : " disabled"}>${icon("send", { size: 16 })}<span>Registrar simulação</span></button>` : ""}
      </div>
      ${(previa.historico ?? []).length ? `<details class="ckd-evidencia"><summary>${previa.historico.length} ${previa.historico.length === 1 ? "simulação registrada" : "simulações registradas"} (histórico separado dos envios reais)</summary><ul>${previa.historico.map((h) => `<li>${dataHora(h.criado_em)} · v${h.fechamento_versao} · ${SIM[h.status] ?? escapeHtml(h.status)} · transporte ${escapeHtml(h.transporte)}</li>`).join("")}</ul></details>` : ""}
    </section>`;
}

/** Documento do PDF do fechamento: os MESMOS blocos da tela, impressos pelo navegador. */
export function documentoFechamento(f, { unidadeNome }) {
  const titulo = `Fechamento-Operacional_${f.competencia}_v${f.versao}`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(titulo)}</title><style>${cssRelatorio()} .ckd-selo{font-weight:700} .ckd-nota{color:#5b606b}</style></head>
<body><header class="pdf-capa"><div><p class="pdf-marca">Crescer com Delivery · Fechamento operacional</p><h1>${escapeHtml(unidadeNome ?? "Unidade")} — ${dataBr(f.competencia)}</h1>
<p>Versão ${f.versao} · <b>${SITUACAO_FECHAMENTO[f.status]}</b> · gerado ${dataHora(f.gerado_em)} · fuso ${escapeHtml(f.fuso)}</p></div></header>
${indicadoresFechamento(f).replace(/<details class="ckd-evidencia">/g, '<details class="ckd-evidencia" open>')}
<footer class="pdf-rodape"><span>Crescer com Delivery · ${escapeHtml(unidadeNome ?? "")}</span><span>Valores operacionais (não são repasse). Execução ${escapeHtml(String(f.execucao_id ?? "").slice(0, 8))} · hash ${escapeHtml(String(f.hash_conteudo ?? "").slice(0, 10))}</span></footer></body></html>`;
}
