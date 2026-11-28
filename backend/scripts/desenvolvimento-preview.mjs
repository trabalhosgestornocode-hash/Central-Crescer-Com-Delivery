// Preview manual isolado da Agenda de Demandas. Sem autenticação e sem banco: a API é simulada em memória.
//   node backend/scripts/desenvolvimento-preview.mjs  ->  http://127.0.0.1:55470
// Dados: PREVIEW_FIXTURE aponta para um JSON com a lista de demandas (formato da API). Sem ele, usa um exemplo mínimo.
// Os dados reais NÃO ficam no repositório.
// Papéis: /?papel=gestor (edita, sem exclusão e sem notas internas) ou /?papel=superadmin (padrão; PREVIEW_PAPEL muda o padrão).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../../frontend/', import.meta.url);
const padraoSuperadmin = process.env.PREVIEW_PAPEL !== 'gestor';
const STATUS = { BACKLOG:'Backlog', PLANNED:'Planejada', IN_PROGRESS:'Em desenvolvimento', VALIDATION:'Em validação', BLOCKED:'Bloqueada', COMPLETED:'Concluída', ARCHIVED:'Arquivada' };
const CATEGORIAS = ['Operação','Dashboard iFood','Financeiro','Bonificação','Parser Food Delivery','Plano de Ação','Agente Crescer','Painel Administrativo','Usuários e Acessos','Segurança','Integrações','Infraestrutura','Banco de Dados','UX/UI','Correções','Outros'];
const TIPOS = ['Feature','Melhoria','Correção','Segurança','Infraestrutura','Refatoração','Integração','Manutenção'];
const pessoas = [{ id:'u-joao', nome:'João Pedro', email:'joao@crescer.test', superadmin:true }, { id:'u-maria', nome:'Maria Silva', email:'maria@crescer.test', superadmin:false }, { id:'u-resp', nome:'Responsável cadastrado', email:'resp@crescer.test', superadmin:false }];
const nomeDe = id => pessoas.find(p => p.id === id)?.nome || null;
const exemplo = [{ id:'x1', codigo:'DEV-001', titulo:'Exemplo de demanda concluída', categoria:'Financeiro', tipo:'Feature', prioridade:'MEDIUM', status:'COMPLETED', progresso:100, escopo:'PLATFORM', inicio_real:'2026-11-03', conclusao_real:'2026-11-06', versao:1, descricao:'', created_at:'2026-11-03T12:00:00Z', updated_at:'2026-11-06T12:00:00Z' }];
const fx = process.env.PREVIEW_FIXTURE;
const rows = (fx && existsSync(fx) ? JSON.parse(readFileSync(fx, 'utf8')) : exemplo).map(d => ({ ordem:0, foco_atual:false, versao:1, nota_interna:'', link_tecnico:'', ...d }));
const historico = {}; const recent = [];
const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const indicador = d => d.status === 'COMPLETED' ? 'Concluída' : d.status === 'ARCHIVED' ? 'Arquivada' : !d.previsao_entrega ? 'Sem previsão' : d.previsao_entrega < hoje() ? 'Atrasada' : 'No prazo';
const nomear = (d, adm) => ({ ...d, indicador_prazo: indicador(d), responsavel_nome: nomeDe(d.responsavel_usuario_id), criado_por_nome: nomeDe(d.criado_por) || 'Sistema', atualizado_por_nome: nomeDe(d.atualizado_por) || 'Sistema', pode_editar: true, pode_administrar: adm, nota_interna: adm ? d.nota_interna : undefined, link_tecnico: adm ? d.link_tecnico : undefined });
const paginaDe = superadmin => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agenda de Demandas — validação local</title><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/desenvolvimento.css"><body><main id="preview" style="padding:24px;max-width:1700px;margin:auto"></main><script type="module">
import { renderDesenvolvimento } from '/src/desenvolvimento.js';
const SUPERADMIN = ${superadmin};
const call = (p, b) => fetch('/__api/' + p, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ superadmin:SUPERADMIN, ...b }) }).then(async r => { const j = await r.json(); if (!r.ok) { const e = new Error(j.message || 'Falha'); e.status = r.status; throw e; } return j; });
const api = { desenvolvimento:(path, q = {}) => call('get', { path, q }), salvarDemanda:(id, data) => call('salvar', { id, data }), excluirDemanda:(id, versao) => call('excluir', { id, versao }), atualizarDemanda:(id, data) => call('atualizar', { id, data }) };
window.__api = api;
renderDesenvolvimento(document.querySelector('#preview'), api);
</script></body></html>`;
function rota(body) {
  const adm = !!body.superadmin; const { path, q = {} } = body;
  if (path === '/catalogos') return { status: STATUS, prioridades:{ CRITICAL:'Crítica', HIGH:'Alta', MEDIUM:'Média', LOW:'Baixa' }, categorias: CATEGORIAS, tipos: TIPOS, organizacoes: [], unidades: [], responsaveis: pessoas, usuario_atual:{ id:'u-joao', nome:'João Pedro', pode_ser_responsavel:true }, pode_editar:true, pode_administrar:adm };
  if (path === '/resumo') { const mes = hoje().slice(0, 7); return { andamento: rows.filter(x => x.status === 'IN_PROGRESS').length, planejadas: rows.filter(x => x.status === 'PLANNED').length, validacao: rows.filter(x => x.status === 'VALIDATION').length, bloqueadas: rows.filter(x => x.status === 'BLOCKED').length, entregues_mes: rows.filter(x => (x.conclusao_real || '').startsWith(mes)).length, minhas: 0, foco: null, proximas: [], proxima_entrega: null, recentes: recent.slice(0, 8), pode_editar:true, pode_administrar:adm }; }
  if (path === '/atualizacoes') { const itens = q.demanda_id ? (historico[q.demanda_id] || []) : recent; return { itens, total: itens.length }; }
  if (path === '/demandas') {
    let it = rows.filter(x => (!q.status || x.status === q.status) && (!q.categoria || x.categoria === q.categoria) && (!q.prioridade || x.prioridade === q.prioridade) && (!q.tipo || x.tipo === q.tipo) && (!q.busca || (x.titulo + x.codigo + x.descricao).toLowerCase().includes(String(q.busca).toLowerCase())) && (!q.minhas || x.responsavel_usuario_id === 'u-joao') && (!q.sem_responsavel || !x.responsavel_usuario_id) && (!q.atrasadas || indicador(x) === 'Atrasada'));
    if (q.de || q.ate) { const campos = q.campo_periodo === 'marcos' ? ['inicio_previsto', 'previsao_entrega', 'conclusao_real'] : [q.campo_periodo || 'previsao_entrega']; it = it.filter(x => campos.some(c => x[c] && (!q.de || x[c] >= q.de) && (!q.ate || x[c] <= q.ate))); }
    it.sort((a, b) => (a.codigo > b.codigo ? 1 : -1)); const lim = Math.min(Number(q.limite) || 60, 100), pg = Number(q.pagina) || 1;
    return { itens: it.slice((pg - 1) * lim, pg * lim).map(d => nomear(d, adm)), total: it.length };
  }
  const d = rows.find(x => path.endsWith('/' + x.id)); if (!d) throw Object.assign(new Error('Demanda não encontrada'), { status: 404 });
  return nomear(d, adm);
}
const ler = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b ? JSON.parse(b) : {})); });
const JSONr = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
http.createServer(async (req, res) => {
  try {
    const alvo = new URL(req.url, 'http://localhost');
    if (alvo.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(paginaDe(alvo.searchParams.has('papel') ? alvo.searchParams.get('papel') !== 'gestor' : padraoSuperadmin)); return; }
    if (alvo.pathname.startsWith('/__api/')) {
      const b = await ler(req); const acao = alvo.pathname.slice(7);
      try {
        if (acao === 'get') return JSONr(res, rota(b));
        if (acao === 'salvar') {
          if (b.id) { const d = rows.find(x => x.id === b.id); if (!d) return JSONr(res, { message: 'Demanda não encontrada' }, 404); if (b.data.versao && b.data.versao !== d.versao) return JSONr(res, { message: 'A demanda foi alterada por outra pessoa. Recarregue.' }, 409); const antes = d.status; Object.assign(d, b.data, { versao: d.versao + 1, atualizado_por: 'u-joao', updated_at: new Date().toISOString() }); if (d.status === 'COMPLETED') { d.progresso = 100; d.conclusao_real ||= hoje(); } if (antes !== d.status) { const ev = { id: 'h' + Date.now(), demanda_id: d.id, texto: `Status alterado de ${antes} para ${d.status}.`, tipo: 'STATUS', visibilidade: 'PUBLIC', autor: 'u-joao', autor_nome: 'João Pedro', created_at: new Date().toISOString() }; (historico[d.id] ??= []).unshift(ev); recent.unshift({ ...ev, demanda: d }); } return JSONr(res, nomear(d, !!b.superadmin)); }
          const n = rows.length + 10; const nova = { ordem: 0, versao: 1, criado_por: 'u-joao', atualizado_por: 'u-joao', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...b.data, id: 'n' + Date.now(), codigo: 'DEV-' + String(n).padStart(3, '0') }; rows.push(nova); return JSONr(res, nomear(nova, !!b.superadmin), 201);
        }
        if (acao === 'excluir') { rows.splice(rows.findIndex(x => x.id === b.id), 1); return JSONr(res, { ok: true }); }
        if (acao === 'atualizar') { const ev = { ...b.data, id: 'b' + Date.now(), demanda_id: b.id, autor: 'u-joao', autor_nome: 'João Pedro', created_at: new Date().toISOString() }; (historico[b.id] ??= []).unshift(ev); recent.unshift(ev); return JSONr(res, ev, 201); }
      } catch (e) { return JSONr(res, { message: e.message }, e.status || 500); }
    }
    const path = alvo.pathname;
    if (!/^\/src\/[a-zA-Z0-9._-]+\.(js|css)$/.test(path)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); res.setHeader('Cache-Control', 'no-store');
    res.end(await readFile(fileURLToPath(new URL('.' + path, root))));
  } catch { res.writeHead(404).end(); }
}).listen(55470, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:55470 (' + rows.length + ' demandas; padrão ' + (padraoSuperadmin ? 'superadmin' : 'gestor') + ')'));
