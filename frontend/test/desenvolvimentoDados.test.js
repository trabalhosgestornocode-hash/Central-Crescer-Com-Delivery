import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../src/desenvolvimentoDados.js';
import * as ui from '../src/desenvolvimentoUi.js';

const mk = (o = {}) => ({ id: 'i' + Math.random(), codigo: 'DEV-001', titulo: 'T', categoria: 'Financeiro', status: 'COMPLETED', descricao: '', ...o });
const cab = 'Nova funcionalidade. Área de atuação: Gestão Financeira. Projeto: Nova Plataforma Financeira.\n\nTexto executivo.\n\nEmpresas beneficiadas: Açaí Saci e Subway Saci.';

test('lerDescricao extrai projeto e área do cabeçalho estrito, sem inventar', () => {
  const p = D.lerDescricao(mk({ descricao: cab }));
  assert.equal(p.projeto, 'Nova Plataforma Financeira');
  assert.equal(D.areaDe(mk({ descricao: cab })), 'Gestão Financeira');
  assert.equal(D.projetoDe(mk({ descricao: 'texto livre' })) || null, null);
});
test('intervalo e período: demanda de vários dias aparece em todo o intervalo', () => {
  const d = mk({ inicio_real: '2026-11-03', conclusao_real: '2026-11-10' });
  assert.deepEqual(D.intervalo(d), { ini: '2026-11-03', fim: '2026-11-10' });
  assert.ok(D.noPeriodo(d, '2026-11-08', '2026-11-30'));
  assert.ok(!D.noPeriodo(d, '2026-11-11', '2026-11-30'));
  assert.equal(D.intervalo(mk()), null);
});
test('indicadores batem com a lista filtrada', () => {
  const itens = [mk({ inicio_real: '2026-11-01', conclusao_real: '2026-11-02' }), mk({ status: 'VALIDATION', inicio_real: '2026-11-05' }), mk({ status: 'IN_PROGRESS', inicio_real: '2026-11-06', previsao_entrega: '2026-11-07' })];
  const i = D.indicadores(itens, '2026-11-20');
  assert.equal(i.total, 3); assert.equal(i.concluidas, 1); assert.equal(i.validacao, 1); assert.equal(i.desenvolvimento, 1); assert.equal(i.atrasadas, 1); assert.equal(i.pct, 33);
  assert.equal(D.filtrar(itens, { status: 'VALIDATION' }, '2026-11-20').length, i.validacao);
});
test('faixasDaSemana limita linhas e resume o excedente em +N', () => {
  const dias = D.diasDoCalendario('semana', '2026-11-04');
  const itens = Array.from({ length: 6 }, (_, k) => mk({ id: 'k' + k, inicio_real: '2026-11-02', conclusao_real: '2026-11-08' }));
  const r = D.faixasDaSemana(dias, itens, 3);
  assert.equal(r.faixas.length, 3); assert.ok(r.extras.every(x => x === 3));
});
test('relatorio: concluídas do período e projeto ausente contado à parte', () => {
  const itens = [mk({ descricao: cab, inicio_real: '2026-11-01', conclusao_real: '2026-11-05' }), mk({ inicio_real: '2026-11-02', conclusao_real: '2026-11-06' })];
  const r = D.relatorio(itens, '2026-11-01', '2026-11-30', '2026-11-28');
  assert.equal(r.ind.total, 2); assert.equal(r.concluidasNoPeriodo.length, 2); assert.equal(r.semProjeto, 1);
});
test('interface escapa HTML e não expõe nota técnica fora do perfil autorizado', () => {
  const d = mk({ titulo: '<img src=x onerror=1>', nota_interna: 'SEGREDO', status: 'COMPLETED' });
  const h = ui.gaveta(d, { itens: [], total: 0 }, { editar: true, administrar: false });
  assert.ok(!h.includes('<img src=x')); assert.ok(!h.includes('SEGREDO'));
  assert.ok(ui.gaveta(d, { itens: [], total: 0 }, { editar: true, administrar: true }).includes('SEGREDO'));
});
test('coluna lateral não repete a mesma demanda em blocos diferentes', () => {
  const itens = Array.from({ length: 12 }, (_, k) => mk({ id: 'r' + k, codigo: 'DEV-' + k, titulo: 'Titulo ' + k, status: 'COMPLETED', inicio_real: '2026-11-01', conclusao_real: '2026-11-0' + (1 + k % 8), updated_at: '2026-11-2' + (k % 9) + 'T10:00:00Z' }));
  const h = ui.atividadesHtml(D.atividades(itens, '2026-11-28'), '2026-11-28');
  const titulos = [...h.matchAll(/dev-line-t">([^<]+)</g)].map(m => m[1]);
  assert.equal(titulos.length, new Set(titulos).size);
});
