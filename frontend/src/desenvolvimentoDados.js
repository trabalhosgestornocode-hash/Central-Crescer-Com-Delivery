// Regras puras da Agenda de Demandas (sem DOM): leitura da descrição estruturada, áreas, períodos, filtros, indicadores,
// faixas do calendário e relatório. Tudo é calculado a partir dos registros que a API devolve.

export const AREAS = ['Inteligência Artificial — MOVA', 'Gestão Financeira', 'Logística e Entregadores', 'Gestão Administrativa', 'Núcleo Mentorados', 'CMV e Produtos', 'Integrações', 'Comunicação', 'Infraestrutura e Segurança', 'Pesquisa e Inovação'];
export const SEM_AREA = 'Sem área definida';
const IA = AREAS[0], FIN = AREAS[1], LOG = AREAS[2], ADM = AREAS[3], MEN = AREAS[4], CMV = AREAS[5], INT = AREAS[6], COM = AREAS[7], INF = AREAS[8], PES = AREAS[9];

// Projetos nomeados na descrição estruturada → área de atuação. Tabela exata; projeto fora dela cai no mapa por categoria.
const PROJETO_AREA = {
  'Central Crescer com Delivery': ADM, 'Visão Geral da Rede': ADM, 'Núcleo Mentorados': MEN,
  'Controle de Entregas (Foody)': LOG, 'Relatórios de Pedidos e Entregas': LOG, 'Gestão Automatizada dos Entregadores': LOG,
  'Gestão Financeira (Financeiro 2.0)': FIN, 'Nova Plataforma Financeira': FIN, 'Gestão Financeira da Subway Saci': FIN, 'Operação Financeira (Subway e Açaí)': FIN,
  'Custos, Catálogo e Fichas Técnicas': CMV, 'Caramelle': CMV,
  'Integração SAIPOS (vendas e caixa)': INT, 'Integração iFood': INT, 'Integração 99Food': INT, 'Integração SWF (Subway)': INT,
  'Comunicação por WhatsApp': COM, 'MOVA — Assistente Financeiro Inteligente': IA, 'Estabilidade, Segurança e Desempenho': INF
};
// Categorias do sistema (lista fechada no banco) → área, para demandas sem descrição estruturada.
const CATEGORIA_AREA = {
  'Operação': ADM, 'Dashboard iFood': INT, 'Financeiro': FIN, 'Bonificação': FIN, 'Parser Food Delivery': LOG, 'Plano de Ação': ADM,
  'Agente Crescer': IA, 'Painel Administrativo': ADM, 'Usuários e Acessos': INF, 'Segurança': INF, 'Integrações': INT, 'Infraestrutura': INF,
  'Banco de Dados': INF, 'UX/UI': ADM, 'Correções': SEM_AREA, 'Outros': SEM_AREA
};
export const EMPRESAS = ['Açaí no Grau Saci', 'Subway Saci', 'Caramelle', 'Jah Açaí', 'Mentorados'];
export const TODAS = 'Todas as empresas e unidades';
export const STATUS_ORDEM = ['IN_PROGRESS', 'VALIDATION', 'BLOCKED', 'PLANNED', 'BACKLOG', 'COMPLETED', 'ARCHIVED'];
const ENCERRADO = new Set(['COMPLETED', 'ARCHIVED']);

const CABECALHO = /^([^\n]*?)\. Área de atuação: (.*?)\. Projeto: (.*?)\.\n\n([\s\S]*?)\n\nEmpresas beneficiadas: ([\s\S]*?)\.$/;
/** Lê a descrição no formato padrão da importação de novembro. Sem esse formato nada é deduzido. */
export function lerDescricao(d) {
  const m = CABECALHO.exec(String(d?.descricao || ''));
  if (!m) return { estruturado: false, natureza: null, area: null, projeto: null, texto: String(d?.descricao || ''), empresas: null };
  return { estruturado: true, natureza: m[1], area: m[2], projeto: m[3], texto: m[4], empresas: m[5] };
}
export function areaDe(d) {
  const p = lerDescricao(d);
  if (p.estruturado && /^Pesquisa/i.test(p.area)) return PES;
  if (p.estruturado && PROJETO_AREA[p.projeto]) return PROJETO_AREA[p.projeto];
  return CATEGORIA_AREA[d.categoria] || SEM_AREA;
}
export const projetoDe = d => lerDescricao(d).projeto || null;
export function empresasDe(d) {
  const e = lerDescricao(d).empresas; if (!e) return [];
  if (/^Todas as/.test(e)) return [TODAS];
  const achadas = EMPRESAS.filter(x => e.includes(x));
  return achadas.length ? achadas : [e];
}

// ---- datas (America/Sao_Paulo; tudo em 'AAAA-MM-DD') ----
export const hojeBR = (agora = Date.now()) => new Date(agora - 3 * 3600e3).toISOString().slice(0, 10);
const utc = s => new Date(s + 'T12:00:00Z');
export const somarDias = (s, n) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const diasEntre = (a, b) => Math.round((utc(b) - utc(a)) / 86400e3);
export const inicioDaSemana = s => somarDias(s, -((utc(s).getUTCDay() + 6) % 7)); // segunda-feira
export const inicioDoMes = s => s.slice(0, 7) + '-01';
export const mesSeguinte = (s, n) => { const d = utc(inicioDoMes(s)); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
export const fimDoMes = s => somarDias(mesSeguinte(s, 1), -1);
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const nomeMes = s => MESES[+s.slice(5, 7) - 1] + ' de ' + s.slice(0, 4);
export const nomeMesTitulo = s => { const t = nomeMes(s); return t[0].toUpperCase() + t.slice(1); };
export const dataBR = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '';
export const dataCurta = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) : '';

/** Intervalo em que a demanda aparece no calendário. Sem início nem fim, a demanda não tem posição. */
export function intervalo(d) {
  const ini = d.inicio_real || d.inicio_previsto || null;
  const fim = d.conclusao_real || d.previsao_entrega || null;
  if (!ini && !fim) return null;
  const a = ini || fim, b = fim || ini;
  return a <= b ? { ini: a, fim: b } : { ini: b, fim: a };
}
export const atrasada = (d, hoje) => !ENCERRADO.has(d.status) && !!d.previsao_entrega && d.previsao_entrega < hoje;
export const noPeriodo = (d, de, ate) => { const i = intervalo(d); return !!i && i.ini <= ate && i.fim >= de; };

export function periodoDe(modo, ref) {
  if (modo === 'semana') { const de = inicioDaSemana(ref); return { de, ate: somarDias(de, 6), rotulo: dataCurta(de) + ' a ' + dataCurta(somarDias(de, 6)) + '/' + ref.slice(0, 4) }; }
  if (modo === 'tudo') return { de: '0000-01-01', ate: '9999-12-31', rotulo: 'Todo o histórico' };
  return { de: inicioDoMes(ref), ate: fimDoMes(ref), rotulo: nomeMesTitulo(ref) };
}

// ---- filtros ----
export function filtrar(itens, f = {}, hoje = hojeBR()) {
  const q = (f.busca || '').trim().toLowerCase();
  return itens.filter(d => {
    if (f.status && d.status !== f.status) return false;
    if (f.categoria && d.categoria !== f.categoria) return false;
    if (f.area && areaDe(d) !== f.area) return false;
    if (f.projeto && projetoDe(d) !== f.projeto) return false;
    if (f.empresa && !empresasDe(d).includes(f.empresa)) return false;
    if (f.prioridade && d.prioridade !== f.prioridade) return false;
    if (f.atrasadas && !atrasada(d, hoje)) return false;
    if (f.sem_responsavel && d.responsavel_usuario_id) return false;
    if (q && !(d.codigo + ' ' + d.titulo + ' ' + lerDescricao(d).texto).toLowerCase().includes(q)) return false;
    return true;
  });
}
export const filtrosAtivos = f => Object.entries(f || {}).filter(([k, v]) => v && k !== 'busca').length + (f?.busca ? 1 : 0);

// ---- indicadores ----
export function indicadores(itens, hoje = hojeBR()) {
  const c = s => itens.filter(d => d.status === s).length;
  const total = itens.length, concluidas = c('COMPLETED');
  return { total, concluidas, validacao: c('VALIDATION'), desenvolvimento: c('IN_PROGRESS'), atrasadas: itens.filter(d => atrasada(d, hoje)).length, pct: total ? Math.round(concluidas / total * 100) : 0 };
}
export function distribuicao(itens, chave) {
  const m = new Map();
  for (const d of itens) { const k = chave(d) || 'Não informado'; m.set(k, (m.get(k) || 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'));
}
export function agrupar(itens, como) {
  const chave = { projeto: d => projetoDe(d) || 'Sem projeto informado', categoria: d => d.categoria, area: areaDe, status: d => d.status, mes: d => (intervalo(d)?.ini || '').slice(0, 7) || 'Sem data' }[como];
  if (!chave) return [['', itens]];
  const m = new Map();
  for (const d of itens) { const k = chave(d); if (!m.has(k)) m.set(k, []); m.get(k).push(d); }
  const ordem = como === 'status' ? ([a], [b]) => STATUS_ORDEM.indexOf(a) - STATUS_ORDEM.indexOf(b) : como === 'mes' ? ([a], [b]) => a.localeCompare(b) : ([a], [b]) => a.localeCompare(b, 'pt-BR');
  return [...m].sort(ordem);
}
export const ordenar = (itens, como) => {
  const k = { codigo: (a, b) => a.codigo.localeCompare(b.codigo), titulo: (a, b) => a.titulo.localeCompare(b.titulo, 'pt-BR'), inicio: (a, b) => (intervalo(a)?.ini || '9').localeCompare(intervalo(b)?.ini || '9'), fim: (a, b) => (intervalo(b)?.fim || '').localeCompare(intervalo(a)?.fim || ''), atualizacao: (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) }[como] || ((a, b) => a.codigo.localeCompare(b.codigo));
  return [...itens].sort(k);
};

// ---- calendário ----
/** Dias exibidos: mês = semanas completas que cobrem o mês; semana = 7 dias. */
export function diasDoCalendario(modo, ref) {
  const ini = modo === 'semana' ? inicioDaSemana(ref) : inicioDaSemana(inicioDoMes(ref));
  const fimAlvo = modo === 'semana' ? somarDias(ini, 6) : somarDias(inicioDaSemana(fimDoMes(ref)), 6);
  return Array.from({ length: diasEntre(ini, fimAlvo) + 1 }, (_, i) => somarDias(ini, i));
}
/** Para cada semana: faixas posicionadas (coluna inicial/final, faixa) e o que não coube em cada dia. */
export function faixasDaSemana(dias7, itens, maxFaixas) {
  const a = dias7[0], z = dias7[6];
  const naSemana = itens.map(d => ({ d, i: intervalo(d) })).filter(x => x.i && x.i.ini <= z && x.i.fim >= a)
    .sort((p, q) => p.i.ini.localeCompare(q.i.ini) || diasEntre(q.i.ini, q.i.fim) - diasEntre(p.i.ini, p.i.fim) || p.d.codigo.localeCompare(q.d.codigo));
  const ocupado = []; const faixas = []; const extras = Array(7).fill(0); const porDia = Array.from({ length: 7 }, () => []);
  for (const { d, i } of naSemana) {
    const c0 = Math.max(0, diasEntre(a, i.ini)), c1 = Math.min(6, diasEntre(a, i.fim));
    for (let c = c0; c <= c1; c++) porDia[c].push(d);
    let lane = 0; while (lane < maxFaixas && ocupado[lane] && ocupado[lane].some(([x, y]) => !(c1 < x || c0 > y))) lane++;
    if (lane >= maxFaixas) { for (let c = c0; c <= c1; c++) extras[c]++; continue; }
    (ocupado[lane] ||= []).push([c0, c1]);
    faixas.push({ d, lane, c0, c1, cortaEsq: i.ini < a, cortaDir: i.fim > z });
  }
  return { faixas, extras, porDia };
}
export const demandasDoDia = (itens, dia) => itens.filter(d => { const i = intervalo(d); return i && i.ini <= dia && i.fim >= dia; })
  .sort((p, q) => p.codigo.localeCompare(q.codigo));

// ---- listas de atividades ----
export function atividades(itens, hoje = hojeBR()) {
  const abertas = itens.filter(d => !ENCERRADO.has(d.status));
  return {
    atencao: abertas.filter(d => atrasada(d, hoje) || d.status === 'BLOCKED').sort((a, b) => (a.previsao_entrega || '').localeCompare(b.previsao_entrega || '')),
    proximas: abertas.filter(d => { const i = intervalo(d); return i && i.fim >= hoje; }).sort((a, b) => intervalo(a).fim.localeCompare(intervalo(b).fim)),
    concluidas: itens.filter(d => d.status === 'COMPLETED' && d.conclusao_real).sort((a, b) => b.conclusao_real.localeCompare(a.conclusao_real)),
    recentes: [...itens].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
  };
}

// ---- relatório executivo ----
export function relatorio(todos, de, ate, hoje = hojeBR()) {
  const noMes = todos.filter(d => noPeriodo(d, de, ate));
  const ind = indicadores(noMes, hoje);
  const concluidasNoPeriodo = todos.filter(d => d.status === 'COMPLETED' && d.conclusao_real && d.conclusao_real >= de && d.conclusao_real <= ate);
  const meses = new Map();
  for (const d of todos) { const i = intervalo(d); if (!i) continue; const m = i.ini.slice(0, 7); const r = meses.get(m) || { iniciadas: 0, concluidas: 0 }; r.iniciadas++; meses.set(m, r); }
  for (const d of todos) if (d.status === 'COMPLETED' && d.conclusao_real) { const m = d.conclusao_real.slice(0, 7); const r = meses.get(m) || { iniciadas: 0, concluidas: 0 }; r.concluidas++; meses.set(m, r); }
  const emp = new Map();
  for (const d of noMes) for (const e of empresasDe(d)) emp.set(e, (emp.get(e) || 0) + 1);
  return {
    ind, noMes, concluidasNoPeriodo,
    porArea: distribuicao(noMes, areaDe), porCategoria: distribuicao(noMes, d => d.categoria), porProjeto: distribuicao(noMes, d => projetoDe(d)).filter(([k]) => k !== 'Não informado'),
    empresas: [...emp].sort((a, b) => b[1] - a[1]), evolucao: [...meses].sort(([a], [b]) => a.localeCompare(b)),
    pendentes: noMes.filter(d => !ENCERRADO.has(d.status)), semProjeto: noMes.filter(d => !projetoDe(d)).length
  };
}
