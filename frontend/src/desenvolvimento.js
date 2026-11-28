import { escapeHtml as e } from './utils.js';
import * as ui from './desenvolvimentoUi.js';
import * as D from './desenvolvimentoDados.js';

const CHAVE = 'dev-agenda-estado-v1';
const ESTADO_PADRAO = { aba: 'geral', modo: 'mes', ref: null, f: {}, visao: 'lista', agrupar: 'projeto', ordem: 'inicio', refRel: null };
const lerEstado = () => { try { return { ...ESTADO_PADRAO, ...JSON.parse(localStorage.getItem(CHAVE) || '{}') }; } catch { return { ...ESTADO_PADRAO }; } };
const gravarEstado = s => { try { localStorage.setItem(CHAVE, JSON.stringify(s)); } catch { /* armazenamento indisponível: segue sem persistir */ } };

/** Cartão resumido do Dashboard principal. */
export async function montarCardDesenvolvimento(root, api, abrir) {
  if (!api.desenvolvimento) return;
  const node = document.createElement('section'); node.className = 'dev-panel'; root.prepend(node);
  node.innerHTML = '<h2>Desenvolvimento da Plataforma</h2><p>Carregando agenda…</p>';
  const dt = v => v ? e(D.dataBR(v.slice(0, 10))) : 'Sem previsão';
  try {
    const r = await api.desenvolvimento('/resumo');
    if (!node.isConnected) return;
    node.innerHTML = `<div class="dev-heading"><div><h2>Desenvolvimento da Plataforma</h2><p>${r.andamento} em andamento · ${r.entregues_mes} entregas neste mês · Próxima previsão: ${dt(r.proxima_entrega?.previsao_entrega)}</p><p class="dev-muted">Foco atual: ${e(r.foco?.titulo || 'A definir')}</p></div><button class="btn" data-dev-dashboard>Ver agenda de desenvolvimento</button></div>`;
    node.querySelector('button').onclick = abrir;
  } catch { node.innerHTML = '<h2>Desenvolvimento da Plataforma</h2><p>Agenda temporariamente indisponível.</p><button class="btn">Ver agenda de desenvolvimento</button>'; node.querySelector('button').onclick = abrir; }
}

export async function renderDesenvolvimento(root, api, acessoRevogado) {
  // O estado pertence a esta montagem; respostas antigas nunca sobrescrevem outra tela.
  const host = document.createElement('div'); host.className = 'dev-shell'; root.replaceChildren(host);
  const page = document.createElement('div'); page.className = 'dev-page';
  const layer = document.createElement('div'); layer.className = 'dev-layer';
  const live = document.createElement('div'); live.className = 'dev-toast'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
  host.append(page, layer, live);
  const hoje = D.hojeBR();
  const S = lerEstado(); S.ref ||= hoje; S.refRel ||= hoje;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(S.ref)) S.ref = hoje; if (!/^\d{4}-\d{2}-\d{2}$/.test(S.refRel)) S.refRel = hoje;
  let catalogo, todos = [], aberta = null, dia = null, seq = 0, ultimoFoco = null, toastTimer = 0;
  const vivo = () => root.contains(host);
  const podeEditar = () => !!catalogo?.pode_editar, podeAdministrar = () => !!catalogo?.pode_administrar;
  const eu = () => catalogo?.usuario_atual;
  const responsaveis = () => Object.fromEntries((catalogo?.responsaveis || []).map(x => [x.id, x.nome]));
  const salvarEstado = () => gravarEstado({ aba: S.aba, modo: S.modo, ref: S.ref, f: S.f, visao: S.visao, agrupar: S.agrupar, ordem: S.ordem, refRel: S.refRel });
  const erro = err => { if (err.status === 403) acessoRevogado?.(err.message); return `<div role="alert" class="dev-error">${e(err.message)}</div>`; };
  function aviso(texto, falha = false) { live.textContent = texto; live.className = 'dev-toast on' + (falha ? ' bad' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(() => { live.className = 'dev-toast'; }, 3800); }

  async function buscarTudo() {
    const itens = []; let pagina = 1, total = Infinity;
    while (itens.length < total && pagina <= 30) { const r = await api.desenvolvimento('/demandas', { limite: 100, pagina }); itens.push(...r.itens); total = r.total; if (!r.itens.length) break; pagina++; }
    return itens;
  }
  async function carregar() {
    const ticket = ++seq;
    if (!catalogo) page.innerHTML = '<p class="dev-loading" role="status">Carregando a agenda…</p>';
    else host.setAttribute('aria-busy', 'true');
    try {
      catalogo ||= await api.desenvolvimento('/catalogos');
      const itens = await buscarTudo(); if (!vivo() || ticket !== seq) return;
      todos = itens; desenhar();
    } catch (err) { if (vivo() && ticket === seq) { page.innerHTML = erro(err) + '<button class="dev-btn" data-dev-retry>Tentar novamente</button>'; page.querySelector('[data-dev-retry]').onclick = carregar; } }
    finally { host.removeAttribute('aria-busy'); }
  }
  const opcoesFiltro = () => ({
    areas: [...D.AREAS, D.SEM_AREA].filter(a => todos.some(d => D.areaDe(d) === a)),
    projetos: [...new Set(todos.map(D.projetoDe).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    empresas: [...D.EMPRESAS, D.TODAS].filter(x => todos.some(d => D.empresasDe(d).includes(x))),
    categorias: [...new Set(todos.map(d => d.categoria))].sort((a, b) => a.localeCompare(b, 'pt-BR'))
  });
  const periodoAtual = () => D.periodoDe(S.modo === 'semana' ? 'semana' : 'mes', S.ref);

  function desenhar() {
    const foco = document.activeElement?.dataset?.devF; const pos = document.activeElement?.selectionStart;
    const per = periodoAtual();
    const filtrados = D.filtrar(todos, S.f, hoje);
    let corpo = '';
    if (S.aba === 'geral') corpo = geral(filtrados, per);
    else if (S.aba === 'demandas') corpo = demandas(filtrados);
    else corpo = relatorios();
    const rotulo = S.aba === 'relatorios' ? D.nomeMesTitulo(S.refRel) : per.rotulo;
    page.innerHTML = ui.cabecalho({ aba: S.aba, rotuloPeriodo: S.aba === 'relatorios' ? '' : rotulo, podeEditar: podeEditar(), mostrarPeriodo: S.aba === 'geral', modo: S.modo }) + corpo;
    if (foco) { const el = page.querySelector(`[data-dev-f="${foco}"]`); if (el) { el.focus(); if (pos != null && el.setSelectionRange) try { el.setSelectionRange(pos, pos); } catch { /* campo sem seleção */ } } }
  }
  function geral(filtrados, per) {
    const noPer = filtrados.filter(d => D.noPeriodo(d, per.de, per.ate));
    const semData = filtrados.filter(d => !D.intervalo(d)).length;
    const a = D.atividades(filtrados, hoje); a.concluidas = a.concluidas.filter(d => d.conclusao_real >= per.de && d.conclusao_real <= per.ate); a.recentes = D.atividades(noPer, hoje).recentes;
    const ctx = { modo: S.modo === 'lista' ? 'mes' : S.modo, ref: S.ref, hoje, dia, rotulo: per.rotulo, aberta, de: per.de, ate: per.ate };
    const seg = `<div class="dev-seg" role="group" aria-label="Tipo de visualização">${[['mes', 'Mês'], ['semana', 'Semana'], ['lista', 'Lista']].map(([k, l]) => `<button class="${S.modo === k ? 'on' : ''}" data-dev-modo="${k}" aria-pressed="${S.modo === k}">${l}</button>`).join('')}</div>`;
    const cal = S.modo === 'lista' ? ui.listaPeriodo(filtrados, ctx) : ui.calendario(filtrados, ctx);
    return `${ui.filtrosHtml(S.f, opcoesFiltro())}${ui.indicadoresHtml(D.indicadores(noPer, hoje), semData)}
    <div class="dev-main"><section class="dev-calwrap" aria-label="Calendário"><div class="dev-cal-bar"><h2>${e(per.rotulo)}</h2>${seg}</div>${todos.length ? cal : ui.vazio('Nenhuma demanda cadastrada', 'Cadastre a primeira demanda para montar o calendário.', podeEditar() ? '<button class="dev-btn dev-btn-primary" data-dev-new>Nova demanda</button>' : '')}</section>
    <aside class="dev-side" aria-label="Atividades do período">${dia ? ui.painelDia(dia, filtrados) : ''}${ui.atividadesHtml(a, hoje)}</aside></div>${ui.distribuicaoHtml(noPer)}`;
  }
  function demandas(filtrados) {
    const lista = D.ordenar(filtrados, S.ordem);
    const vazio = !lista.length ? (todos.length ? ui.vazio('Nenhuma demanda com esses filtros', 'Remova algum filtro ou amplie a busca.', '<button class="dev-btn" data-dev-limpar>Limpar filtros</button>') : ui.vazio('Nenhuma demanda cadastrada', 'Cadastre a primeira demanda para acompanhar o trabalho.', podeEditar() ? '<button class="dev-btn dev-btn-primary" data-dev-new>Nova demanda</button>' : '')) : '';
    return `${ui.filtrosHtml(S.f, opcoesFiltro(), { completo: true })}${ui.controlesLista({ visao: S.visao, agrupar: S.agrupar, ordem: S.ordem, total: lista.length })}${vazio || (S.visao === 'kanban' ? ui.kanban(lista, podeEditar()) : ui.listaDemandas(lista, S.agrupar, podeEditar()))}`;
  }
  function relatorios() {
    const p = D.periodoDe('mes', S.refRel);
    return ui.relatorioHtml(D.relatorio(todos, p.de, p.ate, hoje), { rotulo: p.rotulo });
  }

  // ---------- painel lateral ----------
  async function abrirDetalhe(id, origem) {
    aberta = id; ultimoFoco = origem || ultimoFoco; desenhar();
    layer.innerHTML = '<aside class="dev-drawer" role="dialog" aria-label="Detalhes da demanda"><div class="dev-drawer-body"><p class="dev-loading" role="status">Carregando…</p></div></aside>';
    try {
      const [d, h] = await Promise.all([api.desenvolvimento('/demandas/' + encodeURIComponent(id)), api.desenvolvimento('/atualizacoes', { demanda_id: id, limite: 30 })]);
      if (!vivo() || aberta !== id) return;
      layer.innerHTML = ui.gaveta(d, h, { editar: !!d.pode_editar, administrar: !!d.pode_administrar });
      const g = layer.querySelector('.dev-drawer'); g.focus();
      ligarGaveta(g, d);
    } catch (err) { if (aberta === id) layer.querySelector('.dev-drawer-body').innerHTML = erro(err); }
  }
  function fechar() { if (!aberta) return; const id = aberta; aberta = null; layer.innerHTML = ''; desenhar(); const alvo = [...host.querySelectorAll('[data-dev-open]')].find(x => x.dataset.devOpen === id); alvo?.focus(); }
  function ligarGaveta(g, d) {
    const id = d.id; const falha = err => { aviso(err.message || 'Falha ao salvar.', true); };
    g.querySelector('[data-dev-edit]')?.addEventListener('click', () => editar(d));
    g.querySelector('[data-dev-focus]')?.addEventListener('click', async ev => { ev.target.disabled = true; try { await api.salvarDemanda(id, { foco_atual: !d.foco_atual, versao: d.versao }); aviso('Foco atualizado.'); await carregar(); await abrirDetalhe(id); } catch (err) { falha(err); ev.target.disabled = false; } });
    g.querySelector('[data-dev-delete]')?.addEventListener('click', () => { const c = modal('Excluir demanda', `<p>Excluir <strong>${e(d.titulo)}</strong> e o histórico dela? A auditoria é preservada e o código não é reutilizado.</p><div class="dev-form-actions"><button class="dev-btn" data-dev-cancel>Cancelar</button><button class="dev-btn dev-btn-danger" data-dev-confirm>Excluir definitivamente</button></div>`); c.querySelector('[data-dev-cancel]').onclick = () => c.close(); c.querySelector('[data-dev-confirm]').onclick = async ev => { ev.target.disabled = true; try { await api.excluirDemanda(id, d.versao); c.close(); aberta = null; layer.innerHTML = ''; aviso('Demanda excluída.'); await carregar(); } catch (err) { c.querySelector('[data-dev-modal-error]').innerHTML = erro(err); ev.target.disabled = false; } }; });
    let hp = 1;
    g.querySelector('[data-dev-more]')?.addEventListener('click', async ev => { ev.target.disabled = true; try { const r = await api.desenvolvimento('/atualizacoes', { demanda_id: id, pagina: hp + 1, limite: 30 }); hp++; g.querySelector('[data-dev-history]').insertAdjacentHTML('beforeend', ui.historico(r.itens)); ev.target.hidden = hp * 30 >= r.total; } catch (err) { falha(err); } finally { ev.target.disabled = false; } });
    g.querySelector('[data-dev-update]')?.addEventListener('submit', async ev => { ev.preventDefault(); const btn = ev.currentTarget.querySelector('button'); btn.disabled = true; try { await api.atualizarDemanda(id, Object.fromEntries(new FormData(ev.currentTarget))); aviso('Atualização publicada.'); await carregar(); await abrirDetalhe(id); } catch (err) { falha(err); btn.disabled = false; } });
  }

  // ---------- formulário ----------
  function modal(titulo, html) {
    const dialog = document.createElement('dialog'); dialog.className = 'dev-dialog'; dialog.innerHTML = `<header><h2>${e(titulo)}</h2><button class="dev-icon-btn" data-dev-close aria-label="Fechar">×</button></header><div data-dev-modal-error role="alert"></div>${html}`;
    host.append(dialog); dialog.querySelector('[data-dev-close]').onclick = () => dialog.close(); dialog.addEventListener('close', () => dialog.remove()); dialog.showModal(); return dialog;
  }
  function editar(d = {}) {
    const adm = podeAdministrar();
    const padraoResp = d.id ? '' : (eu()?.pode_ser_responsavel ? eu().id : '');
    const txt = (k, l, linhas = 3) => `<label class="dev-f dev-span"><span>${l}</span><textarea name="${k}" rows="${linhas}" maxlength="${k === 'nota_interna' || k === 'descricao' ? 10000 : 5000}">${e(d[k] || '')}</textarea></label>`;
    const sel = (k, l, v, def, ph = 'Selecionar') => `<label class="dev-f"><span>${l}</span><select name="${k}">${ui.opcoes(v, d[k] || def, ph)}</select></label>`;
    const dt = (k, l) => `<label class="dev-f"><span>${l}</span><input type="date" name="${k}" value="${e(d[k] || '')}"></label>`;
    const n = modal(d.id ? 'Editar demanda' : 'Nova demanda', `<form data-dev-form><div class="dev-form-grid"><label class="dev-f dev-span"><span>Título</span><input name="titulo" required maxlength="180" value="${e(d.titulo || '')}"></label>${sel('status', 'Status', catalogo.status, 'BACKLOG')}${sel('categoria', 'Categoria', catalogo.categorias, 'Outros')}${sel('prioridade', 'Prioridade', catalogo.prioridades, 'MEDIUM')}<label class="dev-f"><span>Responsável</span><select name="responsavel_usuario_id">${ui.opcoes(responsaveis(), d.responsavel_usuario_id || padraoResp, 'Sem responsável')}</select></label>${dt('inicio_real', 'Data inicial')}${dt('conclusao_real', 'Data de conclusão')}${dt('previsao_entrega', 'Previsão de entrega')}${txt('descricao', 'Descrição', 4)}${txt('objetivo', 'Objetivo empresarial', 2)}${txt('impacto', 'Benefício esperado ou resultado', 2)}</div>
    <details class="dev-fold"><summary>Mais campos</summary><div class="dev-form-grid">${sel('tipo', 'Tipo', catalogo.tipos, 'Feature')}${sel('escopo', 'Escopo', { PLATFORM: 'Plataforma inteira', ORGANIZATION: 'Organização específica', UNIT: 'Unidade específica' }, 'PLATFORM')}${sel('organizacao_id', 'Organização', Object.fromEntries(catalogo.organizacoes.map(x => [x.id, x.nome])))}${sel('unidade_id', 'Unidade', Object.fromEntries(catalogo.unidades.filter(x => x.organizacao_id === d.organizacao_id).map(x => [x.id, x.nome])))}<label class="dev-f"><span>Progresso (%)</span><input name="progresso" type="number" min="0" max="100" required value="${d.progresso || 0}"></label><label class="dev-f"><span>Ordem na prioridade</span><input name="ordem" type="number" min="0" max="2147483646" required value="${d.ordem || 0}"></label>${dt('inicio_previsto', 'Início previsto')}${txt('resumo_entrega', 'Resumo da entrega', 2)}${txt('proximo_passo', 'Próximo passo', 2)}${txt('bloqueio', 'Bloqueio atual', 2)}${txt('atualizacao_publica', 'Atualização pública', 2)}${adm ? txt('nota_interna', 'Nota interna (apenas SuperAdmin)', 3) + `<label class="dev-f dev-span"><span>Link técnico (HTTP/HTTPS)</span><input name="link_tecnico" value="${e(d.link_tecnico || '')}"></label>` : ''}<div class="dev-span"><label class="dev-f"><span>Buscar dependência</span><input data-dev-dep-q placeholder="Código ou título"></label><button type="button" class="dev-btn" data-dev-dep-find>Pesquisar</button><label class="dev-f"><span>Depende da demanda</span><select name="dependencia_id"><option value="">Nenhuma</option>${d.dependencia_id ? `<option value="${e(d.dependencia_id)}" selected>Dependência atual</option>` : ''}</select></label></div><label class="dev-check"><input type="checkbox" name="foco_atual" ${d.foco_atual ? 'checked' : ''}> Foco atual (um por vez)</label></div></details>
    <p class="dev-muted">Concluir ajusta o progresso para 100%. Para reabrir, escolha um status ativo.</p><div class="dev-form-actions"><button type="button" class="dev-btn" data-dev-cancel>Cancelar</button><button class="dev-btn dev-btn-primary" type="submit">Salvar demanda</button></div></form>`);
    const form = n.querySelector('form'); const org = form.elements.organizacao_id, un = form.elements.unidade_id, esc = form.elements.escopo;
    n.querySelector('[data-dev-cancel]').onclick = () => n.close();
    const ajustar = () => { org.disabled = esc.value === 'PLATFORM'; un.disabled = esc.value !== 'UNIT'; if (org.disabled) org.value = ''; if (un.disabled) un.value = ''; }; esc.onchange = ajustar; ajustar();
    org.onchange = () => { un.innerHTML = ui.opcoes(Object.fromEntries(catalogo.unidades.filter(x => x.organizacao_id === org.value).map(x => [x.id, x.nome])), null, 'Selecionar'); };
    n.querySelector('[data-dev-dep-find]').onclick = async ev => { ev.target.disabled = true; try { const r = await api.desenvolvimento('/demandas', { busca: n.querySelector('[data-dev-dep-q]').value, limite: 100 }); form.elements.dependencia_id.innerHTML = ui.opcoes(Object.fromEntries(r.itens.filter(x => x.id !== d.id).map(x => [x.id, x.codigo + ' — ' + x.titulo])), d.dependencia_id, 'Nenhuma'); } catch (err) { n.querySelector('[data-dev-modal-error]').innerHTML = erro(err); } finally { ev.target.disabled = false; } };
    form.onsubmit = async ev => { ev.preventDefault(); const btn = form.querySelector('[type=submit]'); btn.disabled = true; const body = Object.fromEntries(new FormData(form));
      body.progresso = Number(body.progresso); body.ordem = Number(body.ordem); body.foco_atual = form.elements.foco_atual.checked;
      for (const k of ['organizacao_id', 'unidade_id', 'dependencia_id', 'responsavel_usuario_id', 'inicio_previsto', 'inicio_real', 'previsao_entrega', 'conclusao_real']) body[k] ||= null;
      if (d.id) body.versao = d.versao;
      try { await api.salvarDemanda(d.id, body); n.close(); aviso(d.id ? 'Demanda salva.' : 'Demanda criada.'); await carregar(); if (aberta && d.id) await abrirDetalhe(d.id); } catch (err) { n.querySelector('[data-dev-modal-error]').innerHTML = erro(err); btn.disabled = false; }
    };
    n.querySelector('input[name=titulo]').focus();
  }

  // ---------- eventos (delegação: a página inteira é redesenhada a cada mudança) ----------
  const nav = n => { if (S.aba === 'relatorios') S.refRel = D.mesSeguinte(S.refRel, n); else if (S.modo === 'semana') S.ref = D.somarDias(S.ref, 7 * n); else S.ref = D.mesSeguinte(S.ref, n); dia = null; salvarEstado(); desenhar(); };
  host.addEventListener('click', ev => {
    const t = ev.target.closest('button, a'); if (!t) return; const q = k => t.hasAttribute('data-dev-' + k), v = k => t.getAttribute('data-dev-' + k);
    if (q('open')) return void abrirDetalhe(v('open'), t);
    if (q('fechar')) return void fechar();
    if (q('tab')) { S.aba = v('tab'); dia = null; salvarEstado(); return void desenhar(); }
    if (q('nav')) return void nav(Number(v('nav')));
    if (q('hoje')) { S.ref = hoje; dia = hoje; salvarEstado(); return void desenhar(); }
    if (q('modo')) { S.modo = v('modo'); salvarEstado(); return void desenhar(); }
    if (q('dia')) { dia = dia === v('dia') ? null : v('dia'); return void desenhar(); }
    if (q('dia-fechar')) { dia = null; return void desenhar(); }
    if (q('visao')) { S.visao = v('visao'); salvarEstado(); return void desenhar(); }
    if (q('limpar')) { S.f = {}; salvarEstado(); return void desenhar(); }
    if (q('filtrar')) { S.f = { ...S.f, [v('filtrar')]: t.dataset.v }; salvarEstado(); return void desenhar(); }
    if (q('new')) return void editar();
    if (q('pdf')) return void window.print();
  });
  const mudou = ev => {
    const t = ev.target;
    if (t.dataset.devF) { const k = t.dataset.devF; const val = t.type === 'checkbox' ? t.checked : t.value; if (val) S.f = { ...S.f, [k]: val }; else { S.f = { ...S.f }; delete S.f[k]; } salvarEstado(); return void desenhar(); }
    if (t.dataset.devAgrupar !== undefined) { S.agrupar = t.value; salvarEstado(); return void desenhar(); }
    if (t.dataset.devOrdem !== undefined) { S.ordem = t.value; salvarEstado(); return void desenhar(); }
    if (t.dataset.devMove) {
      const d = todos.find(x => x.id === t.dataset.devMove); const status = t.value; if (!d || !status || status === d.status) return;
      if (status === 'BLOCKED' && !d.bloqueio) { editar({ ...d, status }); t.value = d.status; return; }
      t.disabled = true; api.salvarDemanda(d.id, { status, versao: d.versao }).then(async () => { aviso('Status atualizado para ' + ui.STATUS[status] + '.'); await carregar(); if (aberta === d.id) await abrirDetalhe(d.id); }).catch(err => { t.value = d.status; t.disabled = false; aviso(err.message || 'Não foi possível alterar o status.', true); });
    }
  };
  let espera = 0;
  host.addEventListener('input', ev => { if (ev.target.dataset.devF === 'busca') { clearTimeout(espera); espera = setTimeout(() => mudou(ev), 220); } });
  host.addEventListener('change', ev => { if (ev.target.dataset.devF !== 'busca') mudou(ev); });
  host.addEventListener('keydown', ev => {
    const dBtn = ev.target.closest?.('.dev-day'); if (!dBtn) return;
    const passo = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[ev.key]; if (!passo) return;
    const alvo = host.querySelector(`.dev-day[data-dev-dia="${D.somarDias(dBtn.dataset.devDia, passo)}"]`); if (alvo) { ev.preventDefault(); alvo.focus(); }
  });
  const aoTeclar = ev => { if (!vivo()) return document.removeEventListener('keydown', aoTeclar); if (ev.key === 'Escape' && aberta && !host.querySelector('dialog[open]')) fechar(); };
  document.addEventListener('keydown', aoTeclar);

  await carregar();
}
