import { escapeHtml as esc } from './utils.js';

const estado = { aba:'visao', unidade:'', meses:3 };
const STATUS = { em_andamento:'Em andamento', incompleto:'Incompleto', completo:'Completo', fechado:'Fechado', revisao_necessaria:'Revisão necessária' };
const PRINCIPAIS = ['faturamento','despesasIfood','aposDespesas','pedidos','ticketMedio','novosClientes','conversao','entregadores'];
const NOMES = { faturamento:'Faturamento iFood', despesasIfood:'Despesas iFood', aposDespesas:'Faturamento após iFood', pedidos:'Pedidos', ticketMedio:'Ticket médio', novosClientes:'Novos clientes', conversao:'Conversão', entregadores:'Taxas de entregadores iFood', retencaoAposIfoodPct:'Retenção após iFood', custoIfoodPct:'Custo iFood %', custoEntregadoresPct:'Taxas de entregadores iFood %', custoPorPedido:'Taxa iFood por pedido', entregadoresExternos:'Entregadores externos (opcional)' };
const TIPO = k => ['pedidos','novosClientes'].includes(k) ? 'inteiro' : ['conversao','custoIfoodPct','custoEntregadoresPct','retencaoAposIfoodPct'].includes(k) ? 'percentual' : 'moeda';
const DIM_NOME = { FATURAMENTO:'Faturamento', CUSTOS_IFOOD:'Custos iFood', MARGEM_APOS_IFOOD:'Margem após iFood', CLIENTES:'Novos clientes', CONVERSAO:'Conversão', ENTREGADORES:'Entregadores' };
const STATUS_CLASSE = { 'SAUDÁVEL':'perf-ok', 'ATENÇÃO':'perf-warn', 'CRÍTICO':'perf-crit', 'SEM DADOS':'perf-none' };
const TEND_CLASSE = c => ['CRESCIMENTO','CRESCENDO','MELHORANDO','MANUTENÇÃO','DENTRO DA META'].includes(c) ? 'perf-ok' : ['ESTÁVEL'].includes(c) ? '' : ['QUEDA','CAINDO','DETERIORANDO','ACOMPANHAR','ABAIXO DA META'].includes(c) ? 'perf-warn' : ['QUEDA FORTE','CORREÇÃO'].includes(c) ? 'perf-crit' : 'perf-none';
const fmtVar = v => v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toLocaleString('pt-BR',{maximumFractionDigits:1})}%`;
const fmtPp = v => v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toLocaleString('pt-BR',{maximumFractionDigits:1})} p.p.`;
export function formatarPerformance(v,tipo) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return tipo === 'moeda' ? Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}) : `${Number(v).toLocaleString('pt-BR',{maximumFractionDigits:tipo === 'inteiro' ? 0:2})}${tipo === 'percentual' ? '%':''}`;
}
function deslocar(m,n) { const [a,b] = m.split('-').map(Number); return new Date(Date.UTC(a,b-1+n,1)).toISOString().slice(0,7); }
function delta(v,k) {
  if (v == null) return '<small>Sem base anterior</small>';
  const custo = ['despesasIfood','entregadores','custoIfoodPct','custoEntregadoresPct','custoPorPedido'].includes(k);
  return `<small class="${v === 0 ? '' : (custo ? v < 0:v > 0) ? 'perf-positivo':'perf-atencao'}">${v > 0 ? '+':''}${formatarPerformance(v,'percentual')} vs período anterior</small>`;
}
export function htmlFechamento(c) {
  const fechado = c.status === 'fechado' || c.status === 'revisao_necessaria';
  return `<section class="perf-resumo"><div><span class="perf-eyebrow">Competência ${esc(c.competencia)}</span><h2>Fechamento Mensal de Performance</h2><p>${esc(c.unidade.unidadeNome)}</p></div><div class="perf-completude"><strong>${formatarPerformance(c.completudePct,'percentual')}</strong><span>dos indicadores obrigatórios disponíveis</span><progress value="${c.completudePct}" max="100"></progress><b>${esc(STATUS[c.status] ?? c.status)}</b></div></section>
    ${c.avisos.map(a => `<p class="perf-aviso">${esc(a)}</p>`).join('')}
    ${c.faltantes.length ? `<p>Faltam: ${c.faltantes.map(k => esc(c.campos.find(f => f.chave === k)?.nome ?? k)).join(', ')}.</p>` : '<p>Todos os indicadores obrigatórios estão disponíveis. A cobertura do período também é verificada antes do fechamento.</p>'}
    <form data-perf-form><div class="perf-tabela"><table><thead><tr><th>Indicador</th><th>Valor</th><th>Origem</th><th>Status do dado</th></tr></thead><tbody>${c.campos.map(f => `<tr><td><strong>${esc(f.nome)}</strong><small>${esc(f.fonte)}${f.complementoIgnorado ? ' · Complemento anterior ignorado: fonte oficial prevalece.':''}</small></td><td>${f.editavel && !fechado ? `<input type="number" data-campo="${esc(f.chave)}" aria-label="${esc(f.nome)}" min="0" ${f.tipo === 'percentual' ? 'max="100"':''} step="${f.tipo === 'inteiro' ? '1':f.tipo === 'percentual' ? '0.0001':'0.01'}" value="${f.valor ?? ''}" placeholder="Sem dados">` : `<span>${formatarPerformance(f.valor,f.tipo)}</span>`}</td><td><span class="perf-origem">${esc(f.origem)}</span></td><td>${esc(f.status)}</td></tr>`).join('')}</tbody></table></div>
    <p class="perf-aviso">Custo externo de entregadores é opcional. Sua ausência não reduz a completude. Valores automáticos e calculados são protegidos; preencher zero significa confirmar um valor zero.</p>
    <div class="perf-acoes">${fechado ? '<button type="button" data-acao="reabrir">Reabrir para edição</button>' : '<button type="submit">Salvar complementos</button>'}<button type="button" data-acao="fechar" ${!c.podeFechar || fechado ? 'disabled':''}>Fechar competência</button><span data-perf-feedback role="status" aria-live="polite"></span></div></form>
    ${c.auditoria ? `<p class="perf-auditoria">Versão ${c.versao} · Última atualização: ${esc(c.auditoria.atualizadoEm ?? '—')}${c.fechadoEm ? ` · Fechado em ${esc(c.fechadoEm)}`:''}</p>`:''}`;
}
function chip(rotulo, valor) { return `<span class="perf-chip ${STATUS_CLASSE[valor] ?? TEND_CLASSE(valor)}">${esc(rotulo)}: ${esc(valor ?? '—')}</span>`; }

function htmlResumoUnidade(u) {
  const a = u.analise ?? {};
  const st = a.status ?? {};
  return `<article class="perf-resumo-card">
    <h3>${esc(u.unidade.unidadeNome)}</h3>
    <p class="perf-resumo-texto">${esc(a.resumo?.texto ?? 'Sem base suficiente para um resumo gerencial.')}</p>
    <div class="perf-chips">${Object.keys(DIM_NOME).map(k => chip(DIM_NOME[k], st[k])).join('')}</div>
    ${(a.prioridades ?? []).length ? `<ol class="perf-prioridades">${a.prioridades.map(p => `<li>${esc(p.texto)}</li>`).join('')}</ol>` : ''}
  </article>`;
}

function htmlMetasUnidade(u) {
  const m = u.analise?.metas;
  if (!m) return `<article><h3>${esc(u.unidade.unidadeNome)}</h3><p>Sem base suficiente para projetar metas nesta seleção.</p></article>`;
  const conv = m.conversao?.ultima;
  const fat = m.faturamento;
  const nc = m.novosClientes;
  return `<article><h3>${esc(u.unidade.unidadeNome)}</h3>
    <div class="perf-meta-bloco"><span>Conversão</span>${conv
      ? `<strong>${formatarPerformance(conv.atual,'percentual')}</strong><small>Meta ${formatarPerformance(conv.meta,'percentual')} · Gap ${fmtPp(conv.gapPp)} · <b class="${TEND_CLASSE(conv.status)}">${esc(conv.status)}</b></small>`
      : `<strong>—</strong><small>Sem competência com conversão informada no período.</small>`}</div>
    ${fat ? `<div class="perf-meta-bloco"><span>Faturamento do próximo mês</span><strong>${formatarPerformance(fat.atual,'moeda')}</strong>
      <small>Meta +${esc(String(fat.percentualNecessarioMinimo))}%: ${formatarPerformance(fat.metaMinima,'moeda')} (${formatarPerformance(fat.faltaMinima,'moeda')})<br>Meta +${esc(String(fat.percentualNecessarioDesejado))}%: ${formatarPerformance(fat.metaDesejada,'moeda')} (${formatarPerformance(fat.faltaDesejada,'moeda')})</small></div>`
      : '<div class="perf-meta-bloco"><span>Faturamento do próximo mês</span><strong>—</strong><small>Sem faturamento base para projetar a meta.</small></div>'}
    <div class="perf-meta-bloco"><span>Novos clientes</span><strong>${formatarPerformance(nc?.atual,'inteiro')}</strong><small>Tendência: <b class="${TEND_CLASSE(nc?.tendencia)}">${esc(nc?.tendencia ?? 'SEM DADOS')}</b>${nc?.variacao != null ? ` · ${fmtVar(nc.variacao)} vs mês anterior` : ''}</small></div>
    ${(u.analise.prioridades ?? [])[0]?.texto ? `<p class="perf-meta-prioridade">Prioridade: ${esc(u.analise.prioridades[0].texto)}</p>` : ''}
  </article>`;
}

function htmlDiagnosticoUnidade(u) {
  const a = u.analise ?? {};
  const ev = (a.diagnosticos ?? []).filter(x => x.tipo === 'evidencia');
  const hip = (a.diagnosticos ?? []).filter(x => x.tipo === 'hipotese');
  const leg = (a.diagnosticos ?? []).length || (u.diagnosticos ?? []).length;
  return `<article><h3>${esc(u.unidade.unidadeNome)}</h3>
    ${ev.length ? `<h4>Evidências nos dados</h4>${ev.map(x => `<p class="perf-diag perf-evid">${esc(x.texto)}</p>`).join('')}` : ''}
    ${hip.length ? `<h4>Hipóteses (a confirmar)</h4>${hip.map(x => `<p class="perf-diag perf-hip">${esc(x.texto)}</p>`).join('')}` : ''}
    ${(a.investigacao ?? []).length ? `<h4>Possíveis pontos para investigação</h4><p class="perf-aviso">Hipóteses, não causas comprovadas pelos dados atuais.</p><ul class="perf-investigacao">${a.investigacao.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    ${!leg ? '<p>Nenhum alerta identificado pelas regras determinísticas no período.</p>' : ''}</article>`;
}

function htmlEntregadoresUnidade(u) {
  const e = u.analise?.tendencias?.entregadores ?? {};
  const linha = (rot, f, obs) => f && f.classificacao !== 'SEM DADOS'
    ? `<div class="perf-meta-bloco"><span>${rot}</span><strong class="${TEND_CLASSE(f.classificacao)}">${esc(f.classificacao)}</strong><small>${esc(obs)} · ${fmtPp(f.deltaPp)} sobre faturamento${f.variacaoCustoPorPedido != null ? ` · custo por pedido ${fmtVar(f.variacaoCustoPorPedido)}` : ''}</small></div>`
    : `<div class="perf-meta-bloco"><span>${rot}</span><strong>—</strong><small>Sem histórico suficiente.</small></div>`;
  return `<article><h3>${esc(u.unidade.unidadeNome)}</h3>
    ${linha('Taxas de entregadores iFood', e.ifood, 'Já inclusas nas despesas iFood')}
    ${linha('Custo externo de entregadores', e.externos, 'Métrica separada, não somada às taxas iFood')}
    <p class="perf-aviso">Classificação de eficiência de custo (MANUTENÇÃO / ACOMPANHAR / CORREÇÃO), sempre por tendência histórica. A Central não recomenda decisão operacional automaticamente.</p>
  </article>`;
}

export function htmlVisaoPerformance(d) {
  if (!d.competencias.length) return '<p>Nenhuma unidade elegível foi configurada para a Central de Performance.</p>';
  const unitaria = d.competencias.length === 1 ? d.competencias[0] : null;
  const q = d.qualidadeDados ?? {};
  const parcial = q.cobertura && q.cobertura !== 'completa';
  const comp = d.comparativo ?? { disponivel:false };
  return `${parcial ? `<p class="perf-aviso">${esc((q.avisos ?? [])[0] ?? 'Há competências incompletas ou parciais no período. Leia totais e tendências com essa limitação.')}</p>` : ''}

    <section class="perf-secao"><h2>Resumo da Performance</h2><div class="perf-resumo-grid">${d.competencias.map(htmlResumoUnidade).join('')}</div>
      <p class="perf-aviso">Retenção/margem após iFood = faturamento − despesas iFood. Não é lucro real: não contempla CMV, folha, aluguel, impostos, energia e demais despesas operacionais.</p></section>

    <section class="perf-secao"><h2>Indicadores do período</h2><div class="perf-cards">${PRINCIPAIS.map(k => `<article><span>${NOMES[k]}</span><strong>${formatarPerformance(d.consolidado[k],TIPO(k))}</strong>${delta((unitaria?.variacoes ?? d.variacoes ?? {})[k],k)}</article>`).join('')}</div>
      <p class="perf-aviso">Conversão é exibida por unidade e competência. Sem dados de visitas, não há média de conversão entre meses ou unidades.</p></section>

    <section class="perf-secao"><h2>Metas e Oportunidades</h2><div class="perf-comparativo">${d.competencias.map(htmlMetasUnidade).join('')}</div></section>

    <section class="perf-secao"><h2>Evolução do faturamento</h2><div class="perf-grafico"><canvas data-perf-chart role="img" aria-label="Evolução mensal de faturamento por unidade"></canvas></div></section>

    <section class="perf-secao"><h2>Comparativo das unidades</h2>
      ${comp.disponivel ? `<ul class="perf-observacoes">${comp.observacoes.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : `<p class="perf-aviso">${esc(comp.motivo ?? 'Comparativo indisponível.')}</p>`}
      <div class="perf-comparativo">${d.competencias.map(u => `<article><h3>${esc(u.unidade.unidadeNome)}</h3>${['faturamento','pedidos','ticketMedio','novosClientes','conversao','retencaoAposIfoodPct','custoIfoodPct','custoEntregadoresPct','custoPorPedido','entregadoresExternos'].map(k => `<div><span>${NOMES[k]}</span><strong>${formatarPerformance(u.indicadores[k],TIPO(k))}</strong></div>`).join('')}${delta(u.variacoes.faturamento,'faturamento')}</article>`).join('')}</div></section>

    <section class="perf-secao"><h2>Diagnóstico gerencial</h2><div class="perf-comparativo">${d.competencias.map(htmlDiagnosticoUnidade).join('')}</div></section>

    <section class="perf-secao"><h2>Entregadores</h2><div class="perf-comparativo">${d.competencias.map(htmlEntregadoresUnidade).join('')}</div></section>

    <section class="perf-secao"><h2>Qualidade e completude dos dados</h2>
      <p>Cobertura: <b class="${q.cobertura === 'completa' ? 'perf-ok' : q.cobertura === 'parcial' ? 'perf-warn' : 'perf-none'}">${esc(q.cobertura ?? '—')}</b> · Confiança: ${esc({ alta:'alta', media:'média', baixa:'baixa' }[q.confianca] ?? q.confianca ?? '—')} · ${esc(String(q.competenciasComDados ?? 0))} de ${esc(String(q.competenciasNoPeriodo ?? d.competencias[0]?.evolucao.length ?? 0))} competências com dados.</p>
      ${(q.avisos ?? []).map(a => `<p class="perf-aviso">${esc(a)}</p>`).join('')}
      <div class="perf-meses">${d.competencias.flatMap(u => u.evolucao.map(c => `<button data-abrir-unidade="${esc(u.unidade.unidadeId)}" data-competencia="${c.competencia}"><strong>${esc(u.unidade.unidadeNome)}</strong><span>${c.competencia} · ${esc(STATUS[c.status] ?? c.status)}</span><span>${formatarPerformance(c.completudePct,'percentual')} disponível · ${formatarPerformance(c.indicadores.faturamento,'moeda')}</span></button>`)).join('')}</div>
      <p class="perf-aviso">Abra qualquer competência acima para o Fechamento Mensal de Performance (complementos, fechamento e reabertura).</p></section>`;
}
export async function renderPerformance(host,api,mes,revogado) {
  let competencia = mes ?? new Date().toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'}).slice(0,7);
  const token = Symbol('performance'); host._performance = token;
  const vigente = () => host._performance === token && !!host.querySelector('[data-performance-root]');
  host.innerHTML = '<div class="perf" data-performance-root><p role="status">Carregando Central de Performance…</p></div>';
  let unidades;
  try { unidades = await api.performanceUnidades(); }
  catch(e) { if (vigente()) { host.textContent = e.message; if(e.status === 403) revogado?.(e.message); } return; }
  if (!vigente()) return;
  if (estado.unidade && !unidades.some(u => u.unidadeId === estado.unidade)) estado.unidade = '';
  let chart;
  async function pintar() {
    if (!vigente()) return;
    chart?.destroy();
    const root = host.querySelector('[data-performance-root]');
    if (estado.aba === 'fechamento' && !estado.unidade) estado.unidade = unidades[0]?.unidadeId ?? '';
    root.innerHTML = `<header class="perf-titulo"><span class="perf-eyebrow">Painel Administrativo</span><h1>Central de Performance</h1><p>Análise comparativa e evolução dos principais indicadores das unidades.</p></header><nav class="perf-abas" aria-label="Central de Performance"><button data-aba="visao" aria-pressed="${estado.aba === 'visao'}">Visão gerencial</button><button data-aba="fechamento" aria-pressed="${estado.aba === 'fechamento'}">Fechamento Mensal</button></nav><div class="perf-filtros"><label>Unidade<select data-perf-unidade>${estado.aba === 'visao' ? '<option value="">Todas as unidades</option>':''}${unidades.map(u => `<option value="${esc(u.unidadeId)}" ${u.unidadeId === estado.unidade ? 'selected':''}>${esc(u.unidadeNome)}</option>`).join('')}</select></label><label>Competência<input type="month" data-perf-mes value="${competencia}" max="${new Date().toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'}).slice(0,7)}"></label>${estado.aba === 'visao' ? `<label>Período<select data-perf-periodo>${[[1,'Mês selecionado'],[3,'Últimos 3 meses'],[6,'Últimos 6 meses']].map(([n,label]) => `<option value="${n}" ${estado.meses === n ? 'selected':''}>${label}</option>`).join('')}</select></label>`:''}</div><div data-perf-conteudo><p role="status">Carregando indicadores…</p></div>`;
    const conteudo = root.querySelector('[data-perf-conteudo]');
    const atual = () => vigente() && root.querySelector('[data-perf-conteudo]') === conteudo;
    root.querySelectorAll('[data-aba]').forEach(b => b.onclick = () => { estado.aba=b.dataset.aba; pintar(); });
    root.querySelector('[data-perf-unidade]').onchange = e => { estado.unidade=e.target.value; pintar(); };
    root.querySelector('[data-perf-mes]').onchange = e => { if(e.target.value) { competencia=e.target.value; pintar(); } };
    const p = root.querySelector('[data-perf-periodo]'); if(p) p.onchange = e => { estado.meses=Number(e.target.value); pintar(); };
    if (!unidades.length) { conteudo.textContent='Nenhuma unidade elegível foi configurada para a Central de Performance.';return; }
    try {
      if (estado.aba === 'fechamento') {
        const c = await api.performanceCompetencia(estado.unidade,competencia);
        if (!atual()) return;
        conteudo.innerHTML=htmlFechamento(c);
        const form = conteudo.querySelector('form');
        let salvando=false;
        async function salvar(acao) {
          if(salvando || !form.reportValidity()) return;
          const campos={};
          form.querySelectorAll('[data-campo]').forEach(input => { const chave=input.dataset.campo;const valor=input.value === '' ? null:Number(input.value); if(valor !== c.campos.find(f => f.chave === chave).valor) campos[chave]=valor; });
          salvando=true;form.querySelectorAll('button').forEach(b => b.disabled=true);
          const feedback=form.querySelector('[data-perf-feedback]');feedback.textContent='Salvando…';
          try { await api.performanceSalvar(c.unidade.unidadeId,c.competencia,{versao:c.versao,campos,acao}); if(atual()) await pintar(); }
          catch(e) { if(atual()) { feedback.textContent=e.message; form.querySelectorAll('button').forEach(b => b.disabled=b.dataset.acao === 'fechar' && !c.podeFechar); if(e.status===403) revogado?.(e.message); } }
          finally { salvando=false; }
        }
        form.onsubmit=e => { e.preventDefault();salvar('salvar'); };
        form.querySelectorAll('[data-acao]').forEach(b => b.onclick=() => salvar(b.dataset.acao));
      } else {
        const d = await api.performance({inicio:deslocar(competencia,1-estado.meses),fim:competencia,unidade_id:estado.unidade});
        if(!atual()) return;
        conteudo.innerHTML=htmlVisaoPerformance(d);
        conteudo.querySelectorAll('[data-abrir-unidade]').forEach(b => b.onclick=() => { estado.unidade=b.dataset.abrirUnidade;competencia=b.dataset.competencia;estado.aba='fechamento';pintar(); });
        if(globalThis.Chart && d.competencias.length) chart=new globalThis.Chart(conteudo.querySelector('canvas'),{type:'line',data:{labels:d.competencias[0].evolucao.map(c => c.competencia),datasets:d.competencias.map((u,i) => ({label:u.unidade.unidadeNome,data:u.evolucao.map(c => c.indicadores.faturamento),borderColor:['#991b35','#297a7b'][i%2],backgroundColor:'transparent',spanGaps:false,tension:0.15,pointRadius:4}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:true,ticks:{callback:v => formatarPerformance(v,'moeda')}}}}});
      }
    } catch(e) { if(atual()) { conteudo.textContent=e.message; if(e.status===403) revogado?.(e.message); } }
  }
  await pintar();
}
