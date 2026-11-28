import test from 'node:test';
import assert from 'node:assert/strict';
import * as ui from '../src/desenvolvimentoUi.js';

test('responsável aparece por nome — nunca o identificador', () => {
  assert.equal(ui.responsavel({ responsavel_nome: 'Maria Silva', responsavel_usuario_id: 'uuid-123' }), 'Maria Silva');
  assert.ok(!ui.responsavel({ responsavel_usuario_id: 'uuid-123' }).includes('uuid'));
  assert.equal(ui.responsavel({}), 'Sem responsável');
});
test('histórico mostra o autor por nome e escapa o texto', () => {
  const h = ui.historico([{ created_at: '2026-11-10T12:00:00Z', texto: '<b>x</b>', autor_nome: 'João', autor: 'uuid-9', visibilidade: 'PUBLIC' }]);
  assert.ok(h.includes('João')); assert.ok(!h.includes('uuid-9')); assert.ok(!h.includes('<b>x</b>'));
  assert.ok(ui.historico([]).includes('Ainda não há'));
});
test('opções escapam valores e marcam o selecionado', () => {
  const o = ui.opcoes({ A: '<i>', B: 'b' }, 'B');
  assert.ok(!o.includes('<i>')); assert.ok(o.includes('value="B" selected'));
});
test('estado vazio explica o que fazer', () => {
  assert.ok(ui.vazio('Nada', 'Cadastre').includes('Cadastre'));
});
