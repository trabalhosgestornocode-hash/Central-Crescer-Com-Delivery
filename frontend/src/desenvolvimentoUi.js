import { escapeHtml as e } from './utils.js';
import { icon } from './icons.js';
import * as D from './desenvolvimentoDados.js';

export const STATUS = { BACKLOG:'Backlog', PLANNED:'Planejada', IN_PROGRESS:'Em desenvolvimento', VALIDATION:'Em validação', BLOCKED:'Bloqueada', COMPLETED:'Concluída', ARCHIVED:'Arquivada' };
export const PRIORIDADES = { CRITICAL:'Crítica', HIGH:'Alta', MEDIUM:'Média', LOW:'Baixa' };
export const data = v => v ? e(D.dataBR(v.slice(0, 10))) : 'Sem data';
export const vazio = (titulo, texto = '', acao = '') => `<div class="dev-empty"><strong>${e(titulo)}</strong>${texto ? `<p>${e(texto)}</p>` : ''}${acao}</div>`;
export const opcoes = (values, selected = '', placeholder = 'Todos') => `<option value="">${e(placeholder)}</option>` + (Array.isArray(values) ? values.map(v => [v, v]) : Object.entries(values)).map(([v, label]) => `<option value="${e(v)}" ${v === selected ? 'selected' : ''}>${e(label)}</option>`).join('');
/** Nome humano do responsável. O UUID nunca chega à interface. */
export const responsavel = d => d.responsavel_nome || (d.responsavel_usuario_id ? 'Responsável definido' : 'Sem responsável');
const ic = (n, s = 16) => icon(n, { size: s });
const CHEV_E = '<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
const CHEV_D = '<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const LISTA = '<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>';
const KANBAN = '<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1.2"/><rect x="10" y="4" width="5" height="10" rx="1.2"/><rect x="17" y="4" width="4" height="13" rx="1.2"/></svg>';
const pill = s => `<span class="dev-pill st-${e(s)}"><i></i>${e(STATUS[s] || s)}</span>`;
const dias = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const periodoTxt = d => { const i = D.intervalo(d); if (!i) return 'Sem data'; return i.ini === i.fim ? D.dataCurta(i.ini) : D.dataCurta(i.ini) + ' → ' + D.dataCurta(i.fim); };

// ---------- cabeçalho, indicadores, filtros ----------
export function cabecalho({ aba, rotuloPeriodo, podeEditar, mostrarPeriodo, modo }) {
  const abas = { geral: 'Visão Geral', demandas: 'Demandas', relatorios: 'Relatórios' };
  return `<header class="dev-top"><div class="dev-title-block"><h1>Agenda de Demandas</h1><p>Atividades da Gestão de Inteligência Artificial e Tecnologia: o que está em andamento, o que foi entregue e o que vem a seguir.</p></div>
  <div class="dev-top-actions">${mostrarPeriodo ? `<div class="dev-period" role="group" aria-label="Período"><button class="dev-icon-btn" data-dev-nav="-1" aria-label="Período anterior">${CHEV_E}</button><strong aria-live="polite">${e(rotuloPeriodo)}</strong><button class="dev-icon-btn" data-dev-nav="1" aria-label="Próximo período">${CHEV_D}</button><button class="dev-btn" data-dev-hoje>Hoje</button></div>` : ''}
  ${podeEditar ? `<button class="dev-btn dev-btn-primary" data-dev-new>${ic('plus')} Nova demanda</button>` : '<span class="dev-tag">Somente leitura</span>'}</div>
  <nav class="dev-tabs" aria-label="Seções da agenda">${Object.entries(abas).map(([k, l]) => `<button class="${aba === k ? 'on' : ''}" data-dev-tab="${k}" ${aba === k ? 'aria-current="page"' : ''}>${l}</button>`).join('')}</nav></header>`;
}
export function indicadoresHtml(ind, semData) {
  const itens = [['Total', ind.total, ''], ['Concluídas', ind.concluidas, 'COMPLETED'], ['Em validação', ind.validacao, 'VALIDATION'], ['Em desenvolvimento', ind.desenvolvimento, 'IN_PROGRESS'], ['Atrasadas', ind.atrasadas, ind.atrasadas ? 'LATE' : ''], ['Conclusão', ind.pct + '%', '']];
  return `<section class="dev-kpis" aria-label="Indicadores do período">${itens.map(([l, v, s]) => `<div class="dev-kpi ${s ? 'k-' + s : ''}"><span>${l}</span><b>${v}</b></div>`).join('')}</section>${semData ? `<p class="dev-note">${semData} demanda${semData > 1 ? 's' : ''} sem data não aparece${semData > 1 ? 'm' : ''} no período. Consulte a aba Demandas.</p>` : ''}`;
}
export function filtrosHtml(f, op, { completo = false } = {}) {
  const sel = (k, l, vals, ph) => `<label class="dev-f"><select data-dev-f="${k}" aria-label="${l}" class="${f[k] ? 'ativo' : ''}">${opcoes(vals, f[k] || '', l + ': ' + ph.toLowerCase())}</select></label>`;
  return `<section class="dev-filters" aria-label="Filtros"><label class="dev-search">${ic('search')}<input type="search" data-dev-f="busca" value="${e(f.busca || '')}" placeholder="Buscar por título, código ou descrição" aria-label="Buscar demandas"></label>
  ${sel('area', 'Área', op.areas, 'Todas')}${sel('projeto', 'Projeto', op.projetos, 'Todos')}${sel('empresa', 'Empresa', op.empresas, 'Todas')}${sel('status', 'Status', STATUS, 'Todos')}${sel('categoria', 'Categoria', op.categorias, 'Todas')}${completo ? sel('prioridade', 'Prioridade', PRIORIDADES, 'Todas') : ''}
  <label class="dev-check"><input type="checkbox" data-dev-f="atrasadas" ${f.atrasadas ? 'checked' : ''}> Atrasadas</label>
  ${D.filtrosAtivos(f) ? `<button class="dev-btn dev-btn-ghost" data-dev-limpar>${ic('x', 14)} Limpar filtros (${D.filtrosAtivos(f)})</button>` : ''}</section>`;
}

// ---------- calendário ----------
function celulaDia(dia, ctx, n) {
  const fora = ctx.modo === 'mes' && dia.slice(0, 7) !== ctx.ref.slice(0, 7);
  const cls = ['dev-day', fora && 'fora', dia === ctx.hoje && 'hoje', dia === ctx.dia && 'sel', (dia === ctx.hoje) && 'is-hoje'].filter(Boolean).join(' ');
  const rot = `${+dia.slice(8)} de ${D.nomeMes(dia).split(' de ')[0]}, ${n} demanda${n === 1 ? '' : 's'}`;
  return `<button class="${cls}" data-dev-dia="${dia}" aria-label="${e(rot)}" aria-pressed="${dia === ctx.dia}"><span class="dev-n">${ctx.modo === 'semana' ? `<small>${dias[(new Date(dia + 'T12:00:00Z').getUTCDay() + 6) % 7]}</small>` : ''}${+dia.slice(8)}</span>${n ? `<span class="dev-cnt" aria-hidden="true">${n}</span>` : ''}</button>`;
}
export function calendario(itens, ctx) {
  const lista = D.diasDoCalendario(ctx.modo, ctx.ref); const max = ctx.modo === 'semana' ? 9 : 3;
  const semanas = []; for (let i = 0; i < lista.length; i += 7) semanas.push(lista.slice(i, i + 7));
  return `<div class="dev-cal ${ctx.modo === 'semana' ? 'is-semana' : ''}" role="group" aria-label="Calendário de ${e(ctx.rotulo)}"><div class="dev-cal-head" aria-hidden="true">${dias.map(x => `<span>${x}</span>`).join('')}</div>${semanas.map(sem => {
    const { faixas, extras, porDia } = D.faixasDaSemana(sem, itens, max);
    const lanesUsadas = faixas.length ? 1 + Math.max(...faixas.map(f => f.lane)) : 0; const temExtra = extras.some(Boolean); const usadas = Math.max(ctx.modo === 'semana' ? 3 : 1, lanesUsadas); const total = usadas + (temExtra ? 1 : 0);
    return `<div class="dev-week" style="--lanes:${total}"><div class="dev-days">${sem.map((dia, i) => celulaDia(dia, ctx, porDia[i].length)).join('')}</div><div class="dev-bars">${faixas.map(f => `<button class="dev-bar st-${e(f.d.status)} ${f.cortaEsq ? 'cl' : ''} ${f.cortaDir ? 'cr' : ''} ${ctx.aberta === f.d.id ? 'on' : ''}" style="grid-column:${f.c0 + 1}/${f.c1 + 2};grid-row:${f.lane + 1}" data-dev-open="${e(f.d.id)}" title="${e(f.d.titulo)}" aria-label="${e(f.d.titulo + ', ' + (STATUS[f.d.status] || f.d.status))}"><span>${e(f.d.titulo)}</span></button>`).join('')}${extras.map((x, c) => x ? `<button class="dev-more" style="grid-column:${c + 1};grid-row:${usadas + 1}" data-dev-dia="${sem[c]}" aria-label="Mais ${x} atividades em ${D.dataBR(sem[c])}">+${x} mais</button>` : '').join('')}</div></div>`;
  }).join('')}</div>`;
}
export function listaPeriodo(itens, ctx) {
  const noPer = itens.filter(d => D.noPeriodo(d, ctx.de, ctx.ate)).sort((a, b) => D.intervalo(a).ini.localeCompare(D.intervalo(b).ini) || a.codigo.localeCompare(b.codigo));
  if (!noPer.length) return vazio('Nenhuma atividade neste período', 'Mude o mês, ajuste os filtros ou cadastre uma nova demanda.');
  let ultimo = '';
  return `<div class="dev-agenda-lista">${noPer.map(d => { const i = D.intervalo(d); const marca = i.ini < ctx.de ? ctx.de : i.ini; const cab = marca !== ultimo ? (ultimo = marca, `<h3 class="dev-dia-h">${e(D.dataBR(marca))}</h3>`) : ''; return cab + linhaCompacta(d); }).join('')}</div>`;
}
export function linhaCompacta(d, extra = '') {
  return `<button class="dev-line" data-dev-open="${e(d.id)}"><span class="dev-dot st-${e(d.status)}"></span><span class="dev-line-t">${e(d.titulo)}</span><span class="dev-line-m">${e(periodoTxt(d))}${extra}</span></button>`;
}
export function painelDia(dia, itens) {
  const lst = D.demandasDoDia(itens, dia);
  return `<section class="dev-side-block dev-dia-panel"><header><h2>${e(D.dataBR(dia))}</h2><button class="dev-icon-btn" data-dev-dia-fechar aria-label="Fechar dia">${ic('x', 14)}</button></header>${lst.length ? lst.map(d => linhaCompacta(d)).join('') : '<p class="dev-muted">Nenhuma atividade neste dia.</p>'}</section>`;
}

// ---------- atividades do período e distribuição ----------
export function atividadesHtml(a, hoje) {
  // Cada demanda aparece em um único bloco, na ordem de importância.
  const usados = new Set();
  const bloco = (t, lista, vazioTxt, extra = () => '') => {
    const ds = lista.filter(d => !usados.has(d.id)); const mostrar = ds.slice(0, 5); mostrar.forEach(d => usados.add(d.id));
    return `<section class="dev-side-block"><h2>${t}${lista.length ? ` <span>${lista.length}</span>` : ''}</h2>${mostrar.length ? mostrar.map(d => linhaCompacta(d, extra(d))).join('') : `<p class="dev-muted">${vazioTxt}</p>`}</section>`;
  };
  return bloco('Precisam de atenção', a.atencao, 'Nada atrasado ou bloqueado.', d => d.status === 'BLOCKED' ? ' · bloqueada' : ' · atrasada')
    + bloco('Próximas atividades', a.proximas, 'Nenhuma atividade com data futura.')
    + bloco('Entregas concluídas', a.concluidas, 'Nenhuma entrega concluída no período.')
    + bloco('Atualizadas recentemente', a.recentes, 'Sem outras atualizações.');
}
export function barras(rows, total, { acao = '' } = {}) {
  const max = Math.max(1, ...rows.map(r => r[1]));
  return rows.length ? `<ul class="dev-bars-list">${rows.map(([k, v]) => `<li><span class="dev-bl" title="${e(k)}">${acao ? `<button class="dev-link" data-dev-filtrar="${acao}" data-v="${e(k)}">${e(k)}</button>` : e(k)}</span><span class="dev-bt"><i style="width:${Math.max(3, Math.round(v / max * 100))}%"></i></span><b>${v}</b></li>`).join('')}</ul>` : '<p class="dev-muted">Sem dados no período.</p>';
}
export function distribuicaoHtml(itens) {
  const st = D.STATUS_ORDEM.map(s => [STATUS[s], itens.filter(d => d.status === s).length]).filter(r => r[1]);
  return `<section class="dev-dist" aria-label="Distribuição das atividades"><div><h2>Por área</h2>${barras(D.distribuicao(itens, D.areaDe), itens.length, { acao: 'area' })}</div><div><h2>Por projeto</h2>${barras(D.distribuicao(itens, D.projetoDe).filter(([k]) => k !== 'Não informado').slice(0, 8), itens.length, { acao: 'projeto' })}</div><div><h2>Por categoria</h2>${barras(D.distribuicao(itens, d => d.categoria).slice(0, 8), itens.length, { acao: 'categoria' })}</div><div><h2>Por status</h2>${barras(st, itens.length)}</div></section>`;
}

// ---------- gestão de demandas ----------
export function controlesLista({ visao, agrupar, ordem, total }) {
  const g = { '': 'Sem agrupamento', projeto: 'Projeto', area: 'Área', categoria: 'Categoria', status: 'Status', mes: 'Mês de início' };
  const o = { codigo: 'Código', titulo: 'Título', inicio: 'Data inicial', fim: 'Data final', atualizacao: 'Última atualização' };
  return `<div class="dev-listbar"><div class="dev-seg" role="group" aria-label="Visualização"><button class="${visao === 'lista' ? 'on' : ''}" data-dev-visao="lista" aria-pressed="${visao === 'lista'}">${LISTA} Lista</button><button class="${visao === 'kanban' ? 'on' : ''}" data-dev-visao="kanban" aria-pressed="${visao === 'kanban'}">${KANBAN} Kanban</button></div>
  <label class="dev-f inline"><span>Agrupar por</span><select data-dev-agrupar>${Object.entries(g).map(([k, l]) => `<option value="${k}" ${k === agrupar ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  <label class="dev-f inline"><span>Ordenar por</span><select data-dev-ordem>${Object.entries(o).map(([k, l]) => `<option value="${k}" ${k === ordem ? 'selected' : ''}>${l}</option>`).join('')}</select></label><span class="dev-total">${total} demanda${total === 1 ? '' : 's'}</span></div>`;
}
export function linhaDemanda(d, podeEditar) {
  return `<div class="dev-row"><button class="dev-row-t" data-dev-open="${e(d.id)}"><b>${e(d.titulo)}</b><small>${e(D.projetoDe(d) || d.categoria)} · ${e(D.areaDe(d))}</small></button><span class="dev-row-s">${pill(d.status)}</span><span class="dev-row-p">${e(periodoTxt(d))}</span><span class="dev-row-r">${e(responsavel(d))}</span>${podeEditar ? `<select class="dev-quick" data-dev-move="${e(d.id)}" aria-label="Alterar status de ${e(d.titulo)}">${opcoes(STATUS, d.status, 'Mover para…')}</select>` : '<span></span>'}</div>`;
}
export function listaDemandas(itens, agrupar, podeEditar) {
  if (!itens.length) return '';
  const grupos = D.agrupar(itens, agrupar);
  const rotulo = k => agrupar === 'status' ? STATUS[k] : agrupar === 'mes' && k !== 'Sem data' ? D.nomeMes(k + '-01') : k;
  return `<div class="dev-rows"><div class="dev-row dev-row-h" aria-hidden="true"><span>Demanda</span><span>Status</span><span>Período</span><span>Responsável</span><span></span></div>${grupos.map(([k, ds]) => (agrupar ? `<h3 class="dev-grp">${e(rotulo(k))} <span>${ds.length}</span></h3>` : '') + ds.map(d => linhaDemanda(d, podeEditar)).join('')).join('')}</div>`;
}
export function kanban(itens, podeEditar) {
  const col = ['IN_PROGRESS', 'VALIDATION', 'BLOCKED', 'PLANNED', 'BACKLOG', 'COMPLETED'];
  return `<div class="dev-kanban">${col.map(s => { const ds = itens.filter(d => d.status === s); return `<section class="dev-col ${ds.length ? "" : "vazia"}" aria-label="${STATUS[s]}"><h3><i class="dev-dot st-${s}"></i>${STATUS[s]} <span>${ds.length}</span></h3><div class="dev-col-body">${ds.map(d => `<article class="dev-kcard"><button data-dev-open="${e(d.id)}">${e(d.titulo)}</button><small>${e(D.projetoDe(d) || d.categoria)}</small><footer><span>${e(periodoTxt(d))}</span>${podeEditar ? `<select class="dev-quick" data-dev-move="${e(d.id)}" aria-label="Mover ${e(d.titulo)}">${opcoes(STATUS, d.status, 'Mover…')}</select>` : ''}</footer></article>`).join('') || '<p class="dev-muted">Nada aqui.</p>'}</div></section>`; }).join('')}</div>`;
}

// ---------- painel lateral ----------
export function historico(itens) {
  return itens.length ? `<ol class="dev-timeline">${itens.map(a => `<li><time>${data(a.created_at)} ${e(new Date(a.created_at).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }))}</time>${a.visibilidade === 'INTERNAL' ? '<span class="dev-tag">Interna</span>' : ''}<p>${e(a.texto)}</p><small>${e(a.autor_nome || 'Sistema')}</small></li>`).join('')}</ol>` : '<p class="dev-muted">Ainda não há alterações registradas.</p>';
}
export function gaveta(d, h, perm) {
  const p = D.lerDescricao(d);
  const fato = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  const sec = (t, v) => v ? `<section><h3>${t}</h3><p>${e(v)}</p></section>` : '';
  const emp = D.empresasDe(d).join(', ') || null;
  return `<aside class="dev-drawer" role="dialog" aria-modal="false" aria-labelledby="dev-drawer-t" tabindex="-1"><header><span class="dev-code">${e(d.codigo)}</span><div>${perm.editar ? `<button class="dev-btn" data-dev-edit>${ic('pencil', 14)} Editar</button>` : ''}<button class="dev-icon-btn" data-dev-fechar aria-label="Fechar detalhes">${ic('x')}</button></div></header>
  <div class="dev-drawer-body"><h2 id="dev-drawer-t">${e(d.titulo)}</h2><div class="dev-chips">${pill(d.status)}<span class="dev-tag">${e(D.areaDe(d))}</span>${D.atrasada(d, D.hojeBR()) ? '<span class="dev-tag late">Atrasada</span>' : ''}</div>
  <dl class="dev-facts">${fato('Projeto', e(p.projeto || 'Não informado'))}${fato('Categoria', e(d.categoria))}${fato('Empresas beneficiadas', e(emp || 'Não informado'))}${fato('Data inicial', d.inicio_real || d.inicio_previsto ? data(d.inicio_real || d.inicio_previsto) : 'Sem data')}${fato('Data de conclusão', d.conclusao_real ? data(d.conclusao_real) : (d.previsao_entrega ? data(d.previsao_entrega) + ' (previsão)' : 'Sem data'))}${fato('Responsável', e(responsavel(d)))}${p.natureza ? fato('Natureza', e(p.natureza)) : ''}</dl>
  ${sec('Descrição', p.texto)}${sec('Objetivo empresarial', d.objetivo)}${sec(d.status === 'COMPLETED' ? 'Benefício' : 'Benefício esperado', d.impacto)}${sec('Situação', d.resumo_entrega || d.atualizacao_publica)}${sec('Próximo passo', d.proximo_passo)}${d.bloqueio ? sec('Bloqueio', d.bloqueio) : ''}
  <section><h3>Histórico de alterações</h3><div data-dev-history>${historico(h.itens)}</div><button class="dev-btn dev-btn-ghost" data-dev-more ${h.total <= 30 ? 'hidden' : ''}>Carregar mais</button></section>
  ${perm.editar ? `<details class="dev-fold"><summary>Registrar atualização</summary><form data-dev-update><label class="dev-f"><span>Texto</span><textarea name="texto" required maxlength="10000" rows="3"></textarea></label><label class="dev-f"><span>Tipo</span><select name="tipo"><option value="UPDATE">Atualização</option><option value="COMMENT">Comentário</option><option value="BLOCK">Bloqueio</option><option value="UNBLOCK">Desbloqueio</option></select></label>${perm.administrar ? '<label class="dev-f"><span>Visibilidade</span><select name="visibilidade"><option value="PUBLIC">Pública</option><option value="INTERNAL">Interna (apenas SuperAdmin)</option></select></label>' : '<input type="hidden" name="visibilidade" value="PUBLIC">'}<button class="dev-btn dev-btn-primary">Publicar atualização</button></form></details>` : ''}
  ${perm.editar ? `<details class="dev-fold"><summary>Mais ações</summary><div class="dev-actions"><button class="dev-btn" data-dev-focus>${d.foco_atual ? 'Remover foco' : 'Definir como foco atual'}</button>${perm.administrar ? '<button class="dev-btn dev-btn-danger" data-dev-delete>Excluir demanda</button>' : '<p class="dev-muted">A exclusão definitiva é do SuperAdmin. Para tirar a demanda das listas, mude o status para Arquivada.</p>'}</div></details>` : ''}
  ${perm.administrar ? `<details class="dev-fold dev-tech"><summary>Informações técnicas · restrito</summary><p class="dev-muted">Evidências de programação, publicações e conferências. Visível apenas para o SuperAdmin.</p><pre>${e(d.nota_interna || 'Nenhuma nota interna.')}</pre>${/^https?:\/\//i.test(d.link_tecnico || '') ? `<a href="${e(d.link_tecnico)}" target="_blank" rel="noopener noreferrer">Abrir link técnico</a>` : ''}</details>` : ''}</div></aside>`;
}

// ---------- relatório executivo ----------
export function relatorioHtml(r, ctx) {
  const i = r.ind; const concl = r.concluidasNoPeriodo;
  const resumo = i.total ? `Em ${ctx.rotulo.toLowerCase()}, a Gestão de Inteligência Artificial e Tecnologia atuou em ${i.total} demanda${i.total > 1 ? 's' : ''}: ${i.concluidas} concluída${i.concluidas === 1 ? '' : 's'} (${i.pct}%), ${i.validacao} em validação e ${i.desenvolvimento} em desenvolvimento${i.atrasadas ? `; ${i.atrasadas} com prazo vencido` : ''}.` : `Não há demandas registradas em ${ctx.rotulo.toLowerCase()}.`;
  const maxEv = Math.max(1, ...r.evolucao.map(([, v]) => Math.max(v.iniciadas, v.concluidas)));
  const beneficios = D.AREAS.map(a => [a, concl.filter(d => D.areaDe(d) === a && d.impacto).slice(0, 2)]).filter(([, l]) => l.length);
  return `<article class="dev-report" id="dev-report"><header class="dev-report-head"><div><small>Crescer com Delivery · Gestão de Inteligência Artificial e Tecnologia</small><h2>Prestação de contas — ${e(ctx.rotulo)}</h2></div><div class="dev-report-actions"><button class="dev-icon-btn" data-dev-nav="-1" aria-label="Mês anterior">${CHEV_E}</button><button class="dev-icon-btn" data-dev-nav="1" aria-label="Próximo mês">${CHEV_D}</button><button class="dev-btn dev-btn-primary" data-dev-pdf>Exportar PDF</button></div></header>
  <section><h3>Resumo executivo</h3><p class="dev-lead">${e(resumo)}</p>${r.semProjeto ? `<p class="dev-note">${r.semProjeto === 1 ? '1 demanda do período não tem projeto informado e fica' : r.semProjeto + ' demandas do período não têm projeto informado e ficam'} fora do recorte por projeto.</p>` : ''}</section>
  ${indicadoresHtml(i, 0)}
  <section class="dev-two"><div><h3>Principais entregas</h3>${concl.length ? `<ol class="dev-deliv">${concl.slice(0, 10).map(d => `<li><button data-dev-open="${e(d.id)}">${e(d.titulo)}</button><small>${e(D.dataBR(d.conclusao_real))} · ${e(D.areaDe(d))}</small></li>`).join('')}</ol>${concl.length > 10 ? `<p class="dev-muted">e mais ${concl.length - 10} entrega${concl.length - 10 > 1 ? 's' : ''} concluída${concl.length - 10 > 1 ? 's' : ''} no período.</p>` : ''}` : '<p class="dev-muted">Nenhuma entrega concluída no período.</p>'}</div>
  <div><h3>Atividades pendentes</h3>${r.pendentes.length ? `<ul class="dev-pend">${r.pendentes.slice(0, 10).map(d => `<li><button data-dev-open="${e(d.id)}">${e(d.titulo)}</button><small>${e(STATUS[d.status])}</small></li>`).join('')}</ul>${r.pendentes.length > 10 ? `<p class="dev-muted">e mais ${r.pendentes.length - 10}.</p>` : ''}` : '<p class="dev-muted">Nenhuma atividade pendente.</p>'}</div></section>
  <section class="dev-dist"><div><h3>Demandas por área</h3>${barras(r.porArea, i.total)}</div><div><h3>Demandas por projeto</h3>${barras(r.porProjeto.slice(0, 10), i.total)}</div><div><h3>Demandas por categoria</h3>${barras(r.porCategoria, i.total)}</div><div><h3>Empresas beneficiadas</h3>${barras(r.empresas, i.total)}</div></section>
  <section><h3>Evolução mensal</h3>${r.evolucao.length ? `<div class="dev-evo" role="img" aria-label="Demandas iniciadas e concluídas por mês">${r.evolucao.map(([m, v]) => `<div><div class="dev-evo-bars"><i class="a" style="height:${Math.max(4, v.iniciadas / maxEv * 100)}%" title="${v.iniciadas} iniciadas"></i><i class="b" style="height:${Math.max(4, v.concluidas / maxEv * 100)}%" title="${v.concluidas} concluídas"></i></div><small>${e(D.nomeMes(m + '-01').split(' de ')[0].slice(0, 3))}/${m.slice(2, 4)}</small><b>${v.iniciadas} · ${v.concluidas}</b></div>`).join('')}</div><p class="dev-muted"><i class="dev-lg a"></i>Iniciadas <i class="dev-lg b"></i>Concluídas</p>` : '<p class="dev-muted">Sem histórico.</p>'}</section>
  <section><h3>Benefícios operacionais e estratégicos</h3>${beneficios.length ? beneficios.map(([a, l]) => `<div class="dev-ben"><strong>${e(a)}</strong>${l.map(d => `<p>${e(d.impacto)}</p>`).join('')}</div>`).join('') + '<p class="dev-muted">Texto conforme cadastrado em cada demanda. Benefícios marcados como esperados ainda não foram medidos.</p>' : '<p class="dev-muted">Nenhuma demanda concluída no período tem benefício descrito.</p>'}</section></article>`;
}
