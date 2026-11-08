// Construtores PUROS de HTML da composição dos números (sem DOM, testáveis em Node): ícone (i), árvore expansível, lançamentos de origem,
// conteúdo do popover e do painel lateral. Todo texto vindo do servidor passa por `esc`.
import { moeda, pct, dataBr, rotuloMes } from "./modelo.js";
import { explicacaoDe, SITUACOES, CRITERIOS, chaveCategoria } from "./explicacoes.js";

const MAPA = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => MAPA[c]);

export const selo = (situacao, rotulo = null) => { const s = SITUACOES[situacao] ?? SITUACOES.parcial; return `<span class="fin-badge fin-badge--${s.tom}" title="${esc(s.texto)}">${esc(rotulo ?? s.rotulo)}</span>`; };
export const valorDe = (v, unidade = "moeda") => (v == null ? "—" : unidade === "bps" ? pct(v) : moeda(v));

/** Botão (i): acessível por teclado e toque. `alvo` identifica a composição (id do indicador) ou, na árvore, a chave da explicação. */
export const botaoInfo = (alvo, rotulo, { dado = "info" } = {}) =>
  `<button type="button" class="fin-i" data-fin-${dado}="${esc(alvo)}" aria-label="Entender: ${esc(rotulo)}" aria-haspopup="dialog" aria-expanded="false">i</button>`;

/** Lançamentos de origem de um nó (obrigação/pagamento/rateio/lançamento). */
export function htmlLancamentos(ls, { total = null } = {}) {
  if (!ls?.length) return `<p class="fin-vazio-linha">Sem lançamentos individuais para este item.</p>`;
  const linhas = ls.map((l) => `<tr><td data-rot="Data">${esc(dataBr(l.data))}</td><td data-rot="Descrição">${esc(l.descricao ?? "—")}${l.fornecedor ? `<br><small>${esc(l.fornecedor)}</small>` : ""}</td>
    <td data-rot="Origem"><small>${esc(ROTULO_TIPO[l.tipo] ?? l.tipo)}${l.criterio ? ` · ${esc(CRITERIOS[l.criterio] ?? l.criterio)}` : ""}${l.competencia ? ` · comp. ${esc(l.competencia)}` : ""}</small></td>
    <td class="fin-num" data-rot="Valor">${moeda(l.centavos)}</td></tr>`).join("");
  const resto = total != null && total > ls.length ? `<p class="fin-sub">Mostrando ${ls.length} de ${total} lançamentos. Veja todos na tela de origem.</p>` : "";
  return `<div class="fin-tabela-wrap"><table class="fin-tabela fin-tabela--compacta"><thead><tr><th scope="col">Data</th><th scope="col">Descrição</th><th scope="col">Origem</th><th scope="col" class="fin-num">Valor</th></tr></thead><tbody>${linhas}</tbody></table></div>${resto}`;
}
const ROTULO_TIPO = { obrigacao: "Conta a pagar", pagamento: "Pagamento", rateio: "Rateio", fonte: "Vendas registradas", lancamento: "Livro-caixa" };

/** Árvore expansível (DRE e painel). Cada linha: botão de expandir · nome · (i) · valor · % do bruto · situação. */
export function htmlArvore(nos, { nivel = 0, comPct = true } = {}) {
  if (!nos?.length) return "";
  return `<ul class="fin-arv" role="${nivel === 0 ? "tree" : "group"}">${nos.map((n, i) => htmlNo(n, nivel, i, comPct)).join("")}</ul>`;
}
function htmlNo(n, nivel, i, comPct) {
  const filhos = n.filhos?.length ? n.filhos : null, lancs = !filhos && n.lancamentos?.length ? n.lancamentos : null;
  const origem = n.origemTecnica?.length ? htmlOrigemCanal(n) : "";
  const botaoConc = n.acao === "conciliacao" ? `<div class="dre-acao"><button type="button" class="btn btn-ghost btn-sm" data-fin-conciliacao>Entender a diferença com o livro-caixa</button></div>` : "";
  const expansivel = Boolean(filhos || lancs || origem || botaoConc);
  const chaveExp = n.explicacaoId && explicacaoDe(n.explicacaoId) ? n.explicacaoId : chaveCategoria(n.nomeOriginal ?? n.rotulo);
  const exp = chaveExp ? botaoInfo(chaveExp, n.rotulo, { dado: "glossario" }) : "";
  const orig = n.nomeOriginal ? `<small class="fin-nome-orig" title="Nome gravado no plano de contas">categoria no plano: ${esc(n.nomeOriginal)}</small>` : "";
  const crit = n.criterio ? `<small class="fin-crit">${esc(CRITERIOS[n.criterio] ?? n.criterio)}</small>` : "";
  const sub = expansivel ? `<div class="fin-arv-sub" hidden>${botaoConc}${origem}${filhos ? htmlArvore(filhos, { nivel: nivel + 1, comPct }) : lancs ? htmlLancamentos(lancs) : ""}</div>` : "";
  const conf = n.conferencia?.confere === false ? `<p class="fin-alerta fin-alerta--bad" role="status">A soma das partes (${moeda(n.conferencia.somaCentavos)}) difere do total (${moeda(Math.abs(n.centavos))}) em ${moeda(n.conferencia.diferencaCentavos)}.</p>` : "";
  const id = `${nivel}-${i}-${String(n.id).replace(/[^a-z0-9]/gi, "")}`;
  return `<li class="fin-arv-no${n.destaque ? " fin-arv-no--destaque" : ""}" data-no="${esc(n.id)}" role="treeitem" ${expansivel ? 'aria-expanded="false"' : ""} data-nivel="${nivel}">
    <div class="fin-arv-linha">
      ${expansivel ? `<button type="button" class="fin-arv-tog" data-fin-toggle aria-expanded="false" aria-controls="arv-${esc(id)}" aria-label="Expandir ${esc(n.rotulo)}"><span aria-hidden="true">▸</span></button>` : '<span class="fin-arv-tog fin-arv-tog--vazio" aria-hidden="true"></span>'}
      <span class="fin-arv-nome"><span>${esc(n.rotulo)}</span> ${exp}${orig}${crit}${n.detalhe ? `<small class="fin-detalhe-no">${esc(n.detalhe)}</small>` : ""}</span>
      <span class="fin-arv-val">${valorDe(n.centavos)}</span>
      ${comPct ? `<span class="fin-arv-pct" title="Porcentagem do faturamento bruto">${n.pctBrutoBps == null ? "—" : pct(n.pctBrutoBps)}</span>` : ""}
      <span class="fin-arv-sit">${n.situacao && n.situacao !== "confirmado" ? selo(n.situacao, n.rotuloSituacao) : ""}</span>
    </div>${conf}<div id="arv-${esc(id)}" class="fin-arv-corpo">${sub}</div></li>`;
}

/** Origem técnica de um canal de venda (área secundária): nome técnico, o que é e o que NÃO está disponível. */
export function htmlOrigemCanal(n) {
  return `<dl class="dre-origem"><dt>Origem técnica</dt><dd>${n.origemTecnica.map((o) => `<code>${esc(o)}</code>`).join(" ")}</dd>
    ${n.explicacao ? `<dt>O que é</dt><dd>${esc(n.explicacao)}</dd>` : ""}${n.pedidos ? `<dt>Pedidos</dt><dd>${esc(n.pedidos)}</dd>` : ""}${n.pedidos && n.centavos ? `<dt>Ticket médio</dt><dd>${esc(moeda(Math.round(n.centavos / n.pedidos)))} <small>(faturamento ÷ pedidos)</small></dd>` : ""}
    <dt>Registros</dt><dd>Total do canal vindo do relatório de vendas por canal. Os pedidos individuais não estão disponíveis.</dd></dl>`;
}

/** Conferência da soma dos canais contra o faturamento bruto oficial (sempre exibida quando há composição por canal). */
export function htmlConferenciaCanais(cc) {
  if (!cc) return "";
  const ok = cc.confere === true, dif = cc.diferencaCentavos;
  return `<div class="dre-canais-conf${ok ? "" : " dre-canais-conf--div"}"><div><span>Soma dos canais</span><strong>${valorDe(cc.somaCentavos)}</strong></div>
    <div><span>Faturamento bruto oficial</span><strong>${valorDe(cc.brutoOficialCentavos)}</strong></div>
    <div><span>Diferença</span><strong>${ok ? "R$ 0,00" : dif == null ? "—" : `${dif > 0 ? "+" : "−"}${valorDe(Math.abs(dif))}`}</strong></div></div>`;
}

const ROTULO_AJUSTE = { estimativa: "estimativa", taxa_entrega: "taxa de entrega", desconto: "desconto", outro: "outro" };
/** Ponte painel → base da DRE: total do painel, cada ajuste (com estado) e a base gerencial. */
export function htmlPonte(ponte) {
  if (!ponte?.length) return "";
  const neg = (c) => `${c < 0 ? "−" : "+"}${valorDe(Math.abs(c))}`;
  return `<ul class="dre-ponte" aria-label="Ponte entre o total do painel e a base da DRE">${ponte.map((p) => p.tipo === "ajuste"
    ? `<li class="dre-ponte-aj"><span>${esc(p.canal)} · ${esc(p.rotulo)} ${p.estado === "estimado" ? '<span class="fin-badge fin-badge--warn">Estimado</span>' : '<span class="fin-badge fin-badge--ok">Confirmado</span>'}</span><strong>${neg(p.centavos)}</strong></li>`
    : `<li class="dre-ponte-${p.tipo}"><span>${esc(p.rotulo)}</span><strong>${valorDe(p.centavos)}</strong></li>`).join("")}</ul>`;
}
/** Visões alternativas de um mesmo indicador (ex.: painel × base da DRE; juros pagos no mês × da competência). */
export function htmlVisoes(visoes) {
  if (!visoes) return "";
  return Object.values(visoes).map((v) => `<section class="dre-visao"><h5>${esc(v.rotulo)} — ${valorDe(v.totalCentavos)}</h5>${v.componentes?.length ? htmlArvore(v.componentes) : '<p class="fin-vazio-linha">Sem itens.</p>'}</section>`).join("");
}

/** Resumo curto (popover): nome, explicação, fórmula, componentes (até 6) com valor e %, situação e origem. */
export function htmlPopover(alvo, comp) {
  const e = explicacaoDe(alvo) ?? explicacaoDe(comp?.id) ?? null;
  if (!e && !comp) return `<p>Sem explicação disponível.</p>`;
  const un = comp?.unidade ?? "moeda";
  const partes = (comp?.componentes ?? []).slice(0, 6).map((c) => `<li><span>${esc(c.rotulo)}</span><span>${valorDe(c.centavos)}${c.pctBrutoBps != null ? ` <small>(${pct(c.pctBrutoBps)})</small>` : ""}</span></li>`).join("");
  const mais = (comp?.componentes?.length ?? 0) > 6 ? `<li class="fin-pop-mais">e mais ${comp.componentes.length - 6} componente(s)…</li>` : "";
  return `<div class="fin-pop-cab"><strong>${esc(e?.nome ?? comp?.id)}</strong>${comp ? ` ${selo(comp.situacao)}` : ""}</div>
    ${comp?.valorCentavos !== undefined && comp ? `<p class="fin-pop-valor">${valorDe(comp.valorCentavos, un)}</p>` : ""}
    <p>${esc(e?.simples ?? "")}</p>
    ${e?.cuidado ? `<p class="fin-sub"><strong>Atenção:</strong> ${esc(e.cuidado)}</p>` : ""}
    <p class="fin-pop-formula"><strong>Fórmula:</strong> ${esc(comp?.formula ?? e?.formula ?? "—")}</p>
    ${partes ? `<ul class="fin-pop-lista">${partes}${mais}</ul>` : ""}
    ${comp?.faltam?.length ? `<p class="fin-sub"><strong>O que falta:</strong> ${esc(comp.faltam[0])}</p>` : ""}
    ${comp?.origem ? `<p class="fin-sub"><strong>Origem:</strong> ${esc(comp.origem)}</p>` : ""}
    ${comp ? `<button type="button" class="btn btn-ghost btn-sm" data-fin-abrir-painel="${esc(comp.id)}">Ver composição completa</button>` : ""}`;
}

/** Painel lateral: 1 resumo · 2 fórmula · 3-5 componentes/valores/% · 6 competência · 7 origem · 8 lançamentos · 9 conferência. */
export function htmlPainel(comp, { mes, extra = "" } = {}) {
  const e = explicacaoDe(comp.id), un = comp.unidade ?? "moeda";
  const conf = comp.conferencia;
  const confTxt = conf?.confere === true ? `<p class="fin-alerta" role="status">Conferido: a soma dos componentes (${valorDe(conf.somaCentavos)}) é igual ao total.</p>`
    : conf?.confere === false ? `<p class="fin-alerta fin-alerta--bad" role="status">Divergente: componentes somam ${valorDe(conf.somaCentavos)}; total ${valorDe(comp.valorCentavos)}; diferença ${valorDe(conf.diferencaCentavos)}.</p>`
    : `<p class="fin-sub">Conferência de soma não se aplica (ou há componente sem dado).</p>`;
  return `<section aria-labelledby="fin-pn-resumo"><h4 id="fin-pn-resumo">1. Resumo</h4>
      <p class="fin-pn-valor">${valorDe(comp.valorCentavos, un)} ${selo(comp.situacao)}</p>
      <p>${esc(e?.simples ?? "")}</p>${e?.cuidado ? `<p class="fin-sub"><strong>Atenção:</strong> ${esc(e.cuidado)}</p>` : ""}</section>
    <section><h4>2. Fórmula</h4><p>${esc(comp.formula ?? e?.formula ?? "—")}</p></section>
    <section><h4>3. Componentes, valores e porcentagens</h4>
      ${comp.componentes?.length ? `<p class="fin-sub">Porcentagens em relação ao faturamento bruto${mes ? ` de ${esc(rotuloMes(mes))}` : ""}. Use ▸ para abrir até os lançamentos.</p>${htmlArvore(comp.componentes)}` : `<p class="fin-vazio-linha">Sem componentes para exibir.</p>`}
      ${htmlConferenciaCanais(comp.canalConferencia)}
      ${(comp.pendencias ?? []).map((t) => `<p class="fin-alerta fin-alerta--warn" role="note">${esc(t)}</p>`).join("")}
      ${(comp.alertas ?? []).map((t) => `<p class="fin-alerta fin-alerta--bad" role="alert">${esc(t)}</p>`).join("")}
      ${(comp.faltam ?? []).map((t) => `<p class="fin-alerta fin-alerta--warn" role="note">${esc(t)}</p>`).join("")}
      ${(comp.notas ?? []).map((t) => `<p class="fin-sub">${esc(t)}</p>`).join("")}</section>
    ${comp.ponte?.length ? `<section><h4>Ponte até a base da DRE</h4><p class="fin-sub">O total do painel e a base usada na DRE são números diferentes. Esta é a diferença, item a item.</p>${htmlPonte(comp.ponte)}</section>` : comp.visoes?.ponte?.length ? `<section><h4>Ponte: painel (SAIPOS) → base da DRE</h4>${htmlPonte(comp.visoes.ponte)}</section>` : ""}
    ${comp.visoes ? `<section><h4>Outras leituras</h4>${htmlVisoes(Object.fromEntries(Object.entries(comp.visoes).filter(([k]) => k !== "ponte")))}</section>` : ""}
    <section><h4>4. Competência</h4><p>${mes ? esc(rotuloMes(mes)) : "—"}</p></section>
    <section><h4>5. Origem dos dados</h4><p>${esc(comp.origem ?? "—")}</p></section>
    <section><h4>6. Situação de conferência</h4><p>${selo(comp.situacao)} <span class="fin-sub">${esc(SITUACOES[comp.situacao]?.texto ?? "")}</span></p>${confTxt}</section>${extra}`;
}

/** Conciliação de uma categoria: livro-caixa → … → DRE gerencial, degrau a degrau. */
export function htmlConciliacao(c) {
  if (!c) return "";
  const dif = (v) => moeda(v, { sinal: true });
  const degraus = c.degraus.map((d) => `<li><div class="fin-conc-linha"><span>${esc(d.rotulo)}</span><strong>${dif(d.centavos)}</strong></div>
    ${d.itens?.length ? `<details><summary>Ver ${d.itens.length} item(ns)</summary><ul class="fin-lista">${d.itens.map((i) => `<li>${esc(i.descricao)} <small>(comp. ${esc(i.competencia)})</small> — ${dif(i.centavos)}${i.pagoNoMesCentavos != null ? ` <small>pago ${moeda(i.pagoNoMesCentavos)}, parcela do mês ${moeda(i.parcelaDoMesCentavos)}</small>` : ""}</li>`).join("")}</ul></details>` : ""}</li>`).join("");
  return `<section class="fin-cartao fin-conc" aria-labelledby="fin-conc-t"><h3 id="fin-conc-t">Por que os valores de “${esc(c.categoria)}” são diferentes?</h3>
    <p class="fin-sub">${esc(c.explicacao ?? "")}</p>
    <p>O mesmo gasto aparece com valores diferentes porque cada demonstrativo conta em um momento: o <strong>livro-caixa</strong> conta quando o dinheiro saiu; o <strong>DRE gerencial</strong> conta a que mês o serviço pertence (competência), com rateio quando o período atravessa dois meses. Nada foi alterado: a ponte abaixo mostra a diferença, degrau a degrau.</p>
    <ul class="fin-conc-ponte"><li><div class="fin-conc-linha"><span>${esc(c.partidaRotulo)} — ${c.lancamentosLivroCaixa} lançamento(s)</span><strong>${moeda(c.partidaCentavos)}</strong></div></li>${degraus}
    <li class="fin-conc-total"><div class="fin-conc-linha"><span>= DRE gerencial (competência + rateio)</span><strong>${moeda(c.chegadaCentavos)}</strong></div></li></ul>
    ${c.confere ? `<p class="fin-alerta" role="status">A ponte fecha com o valor do DRE gerencial (${moeda(c.gerencialCentavos)}).</p>` : `<p class="fin-alerta fin-alerta--bad" role="status">Sobrou diferença não explicada de ${moeda(c.diferencaCentavos)}. Revise os lançamentos antes de confiar no número.</p>`}
    <p class="fin-sub">Pagamentos de Contas a Pagar no mês: ${moeda(c.pagamentosContasAPagarCentavos)}. Os rateios ainda propostos dependem da aprovação da contadora.</p>
    <ul class="fin-lista">${(c.distincoes ?? []).map((t) => `<li>${esc(t)}</li>`).join("")}</ul></section>`;
}
