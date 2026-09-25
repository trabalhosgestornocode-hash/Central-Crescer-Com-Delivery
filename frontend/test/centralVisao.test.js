import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlVisaoGeral, htmlKpis, modeloWhatsapp } from '../src/central/centralVisao.js';
import { atividadeDaVisao, empresasDaVisao, htmlEmpresasUnidades } from '../src/central/centralAtividade.js';
import { htmlConexao, progressoDoAssistente } from '../src/central/centralConexaoUi.js';

const agora = new Date('2026-09-24T15:00:00Z');
const base = () => ({
  cards: { whatsapp: { estado: 'conectado', conta: { status: 'CONFIRMADA' } }, automacao: { ativa: false, modo: 'DISABLED', rotulo: 'Automação desativada' }, mensagensHoje: { enviadas: 2, recebidas: 1 }, falhasHoje: 0, conversasNaoLidas: 1 },
  alertas: [], conversasRecentes: [], proximosEnvios: [],
});

test('confirmação pendente aparece uma vez e nunca recebe Tudo em ordem', () => {
  const d = base(); d.cards.whatsapp.conta.status = 'PENDENTE_CONFIRMACAO';
  d.alertas = [{ id: 'conta_pendente', severidade: 'atencao', titulo: 'ALERTA DUPLICADO' }];
  const h = htmlVisaoGeral(d, { agora });
  assert.match(h, /Identidade ainda não confirmada/);
  assert.doesNotMatch(h, /ALERTA DUPLICADO|Tudo em ordem/);
  assert.match(h, /Precisam de atenção<\/span><strong class="cc-kpi-val">1</);
});

test('leitura somente preserva conta e explica quem confirma, sem CTA de gestão', () => {
  const d = base(); d.conexao = { estado: 'CONNECTED', conta: { nome: 'Conta QA', telefoneMascarado: '******21' }, identidade: { status: 'PENDENTE_CONFIRMACAO' }, permissoes: { gerenciar: false } };
  const h = htmlVisaoGeral(d, { agora });
  assert.match(h, /Conta QA/); assert.match(h, /administrador autorizado/); assert.match(h, /Ver conexão/);
  assert.doesNotMatch(h, /Revisar e confirmar conta|Gerenciar conexão/);
  assert.doesNotMatch(htmlConexao(d.conexao), /data-cc-conexao=/);
});

test('estado detalhado prevalece e preserva erros, conexão em andamento e QR', () => {
  for (const [estado, texto] of [['AUTH_ERROR', 'Sessão inválida'], ['CONNECTING', 'Conectando'], ['WAITING_QR', 'Aguardando QR Code'], ['RECONNECTING', 'Reconectando']]) {
    const d = base(); d.conexao = { estado };
    assert.equal(modeloWhatsapp(d).estado, estado);
    assert.match(htmlVisaoGeral(d), new RegExp(texto));
  }
});

test('KPIs distinguem fila sem horário, amostra de próximos envios e mensagens não lidas', () => {
  const d = base(); d.cards.programadas = 5;
  const h = htmlKpis(d);
  assert.match(h, /Horário não informado/); assert.doesNotMatch(h, /Nada na fila|Aguardando resposta/);
  delete d.cards.programadas;
  assert.match(htmlKpis(d), /Próximos envios/);
  assert.doesNotMatch(htmlKpis(d), /Alertas hoje/);
});

test('saúde usa o relógio recebido e nome não inventa vínculo com agente', () => {
  const d = base(); d.conexao = { estado: 'CONNECTED', identidade: { status: 'CONFIRMADA', nomeOperacional: 'Agente Crescer' }, saude: { id: 'saudavel', ultimoSinalEm: '2026-09-24T14:57:00Z' } };
  const m = modeloWhatsapp(d, agora);
  assert.equal(m.agente, false); assert.match(m.saude.detalhe, /há 3 min/);
});

test('timeline não transforma pendente, cancelada, bloqueada ou incerta em enviada', () => {
  for (const status of ['SCHEDULED', 'PROCESSING', 'SENDING', 'FAILED', 'BLOCKED', 'CANCELLED', 'DELIVERY_UNKNOWN', null]) {
    const d = { conversasRecentes: [{ ultimaMensagem: { em: '2026-09-24T14:00:00Z', direcao: 'saida', categoria: 'manual', status } }] };
    const [i] = atividadeDaVisao(d, agora).recentes;
    assert.notEqual(i.tipo, 'enviado', status); assert.doesNotMatch(i.titulo, /enviada/, status ?? 'sem status');
  }
});

test('timeline descarta datas inválidas, ordena e usa apenas eventos informados', () => {
  const r = atividadeDaVisao({ atividade: [{ em: 'inválida' }, { em: '2026-09-24T14:00:00Z', titulo: 'A' }, { em: '2026-09-24T14:30:00Z', titulo: 'B' }] }, agora);
  assert.deepEqual(r.recentes.map(i => i.titulo), ['B', 'A']);
  assert.deepEqual(atividadeDaVisao({}, agora), { recentes: [], programadas: [] });
});

test('empresas sem dados de pendências não ganham situação inventada', () => {
  const d = { conversasRecentes: [{ empresas: [{ organizacaoId: '1', nome: 'Empresa' }], unidades: [{ organizacaoId: '1', unidadeId: 'u', nome: 'Unidade' }] }] };
  const empresas = empresasDaVisao(d);
  assert.equal(empresas[0].situacao, null); assert.equal(empresas[0].unidades[0].situacao, null);
  const h = htmlEmpresasUnidades(empresas);
  assert.match(h, /Situação não informada/); assert.doesNotMatch(h, /Sem pendência|Recebendo automações/);
});

test('wizard mantém progresso das cinco etapas e erro na etapa correta', () => {
  assert.deepEqual(['iniciando', 'aguardando', 'validando', 'identificado', 'concluida'].map(fase => progressoDoAssistente({ fase })), [0, 25, 50, 75, 100]);
  assert.equal(progressoDoAssistente({ fase: 'erro', falhouEm: 3 }), 75);
});
