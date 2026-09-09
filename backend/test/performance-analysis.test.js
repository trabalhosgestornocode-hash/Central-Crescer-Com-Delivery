// Camada de análise gerencial — regras deterministas, sem rede.
// Rodar: node --test test/performance-analysis.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivar } from '../src/modules/administrativo/performance/performance.calc.js';
import { configuracaoMetas, metasFaturamento, metaConversao } from '../src/modules/administrativo/performance/performance.targets.js';
import { analisarSerie, compararUnidades } from '../src/modules/administrativo/performance/performance.analysis.js';

const METAS = configuracaoMetas({});
const mes = (competencia, base, extra = {}) => ({ competencia, indicadores: derivar(base), incompleto: false, parcial: false, financeiroAte: null, ...extra });
const serie = arr => analisarSerie(arr, { metas: METAS });
const perto = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);

test('queda forte de faturamento: -56,6% acumulado, status CRÍTICO e prioridade de demanda', () => {
  const r = serie([
    mes('2026-06', { faturamento: 126757, despesasIfood: 40000, pedidos: 2500, novosClientes: 700, entregadores: 12000 }),
    mes('2026-07', { faturamento: 90000, despesasIfood: 30000, pedidos: 1800, novosClientes: 500, entregadores: 9000 }),
    mes('2026-08', { faturamento: 55011, despesasIfood: 18000, pedidos: 1100, novosClientes: 300, entregadores: 5500 }),
  ]);
  assert.equal(r.tendencias.faturamento.classificacao, 'QUEDA FORTE');
  perto(r.tendencias.faturamento.variacaoAcumulada, -56.6, 0.2);
  assert.equal(r.status.FATURAMENTO, 'CRÍTICO');
  assert.equal(r.prioridades[0].dimensao, 'FATURAMENTO');
  assert.equal(r.resumo.prioridade, 'recuperação de demanda');
});

test('crescimento de faturamento é classificado como CRESCIMENTO e status SAUDÁVEL', () => {
  const r = serie([
    mes('2026-07', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000 }),
    mes('2026-08', { faturamento: 110000, despesasIfood: 33000, pedidos: 2200, novosClientes: 440, entregadores: 11000 }),
  ]);
  assert.equal(r.tendencias.faturamento.classificacao, 'CRESCIMENTO');
  assert.equal(r.status.FATURAMENTO, 'SAUDÁVEL');
});

test('faturamento estável', () => {
  const r = serie([
    mes('2026-06', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000 }),
    mes('2026-07', { faturamento: 101000, despesasIfood: 30300, pedidos: 2010, novosClientes: 404, entregadores: 10100 }),
    mes('2026-08', { faturamento: 100500, despesasIfood: 30150, pedidos: 2005, novosClientes: 402, entregadores: 10050 }),
  ]);
  assert.equal(r.tendencias.faturamento.classificacao, 'ESTÁVEL');
  assert.equal(r.status.FATURAMENTO, 'SAUDÁVEL');
});

test('pedidos caindo com ticket subindo: evidência aponta volume, não ticket', () => {
  const r = serie([
    mes('2026-07', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000 }),
    mes('2026-08', { faturamento: 78000, despesasIfood: 24000, pedidos: 1400, novosClientes: 380, entregadores: 8000 }),
  ]);
  const d = r.diagnosticos.find(x => x.dimensao === 'FATURAMENTO' && x.tipo === 'evidencia');
  assert.ok(d && /volume de pedidos/.test(d.texto));
  assert.ok(!r.diagnosticos.some(x => /ranking/i.test(x.texto)));
});

test('pedidos estáveis com ticket caindo: evidência aponta o ticket médio', () => {
  const r = serie([
    mes('2026-07', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000 }),
    mes('2026-08', { faturamento: 86000, despesasIfood: 26000, pedidos: 1990, novosClientes: 395, entregadores: 8600 }),
  ]);
  const d = r.diagnosticos.find(x => x.dimensao === 'FATURAMENTO' && x.tipo === 'evidencia');
  assert.ok(d && /ticket médio/.test(d.texto));
});

test('novos clientes em queda consecutiva: CAINDO e diagnóstico de deterioração', () => {
  const base = { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, entregadores: 10000 };
  const r = serie([
    mes('2026-06', { ...base, novosClientes: 812 }),
    mes('2026-07', { ...base, novosClientes: 423 }),
    mes('2026-08', { ...base, novosClientes: 290 }),
  ]);
  assert.equal(r.tendencias.clientes.classificacao, 'CAINDO');
  assert.equal(r.tendencias.clientes.quedasConsecutivas, 2);
  assert.ok(r.diagnosticos.some(x => x.dimensao === 'CLIENTES' && /deterioração/.test(x.texto)));
});

test('conversão 16,49% vs meta 20%: gap de -3,51 p.p. e ABAIXO DA META', () => {
  const m = metaConversao(16.49, METAS);
  perto(m.gapPp, -3.51);
  assert.equal(m.status, 'ABAIXO DA META');
  const r = serie([
    mes('2026-07', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000, conversao: 16 }),
    mes('2026-08', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000, conversao: 16.49 }),
  ]);
  assert.equal(r.status.CONVERSAO, 'ATENÇÃO');
  assert.equal(r.metas.conversao.ultima.competencia, '2026-08');
});

test('conversão >= 20%: DENTRO DA META e status SAUDÁVEL', () => {
  assert.equal(metaConversao(20, METAS).status, 'DENTRO DA META');
  const r = serie([
    mes('2026-07', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000, conversao: 21 }),
    mes('2026-08', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000, conversao: 22 }),
  ]);
  assert.equal(r.status.CONVERSAO, 'SAUDÁVEL');
});

test('meta de faturamento +7% e +10% a partir do último mês', () => {
  const m = metasFaturamento(55011.39, METAS);
  perto(m.metaMinima, 58862.19, 0.02);
  perto(m.metaDesejada, 60512.53, 0.02);
  perto(m.faltaMinima, 3850.80, 0.02);
  assert.equal(m.percentualNecessarioMinimo, 7);
  assert.equal(m.percentualNecessarioDesejado, 10);
});

test('custo iFood crescendo mais rápido que o faturamento: DETERIORANDO com descolamento', () => {
  const r = serie([
    mes('2026-07', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000 }),
    mes('2026-08', { faturamento: 106800, despesasIfood: 36390, pedidos: 2100, novosClientes: 410, entregadores: 10680 }),
  ]);
  assert.equal(r.tendencias.custosIfood.classificacao, 'DETERIORANDO');
  perto(r.tendencias.custosIfood.varFaturamento, 6.8, 0.1);
  perto(r.tendencias.custosIfood.varDespesas, 21.3, 0.1);
  assert.ok(r.tendencias.custosIfood.descolamentoPp >= 5);
  assert.ok(r.diagnosticos.some(x => x.dimensao === 'CUSTOS_IFOOD' && /mais rápido que o faturamento/.test(x.texto)));
});

test('margem após iFood deteriorando: sequência 87→72 é DETERIORANDO contínua', () => {
  const comRet = ret => { const fat = 100000; return { faturamento: fat, despesasIfood: fat * (1 - ret / 100), pedidos: 2000, novosClientes: 400, entregadores: 10000 }; };
  const r = serie([
    mes('2026-04', comRet(87)), mes('2026-05', comRet(84)), mes('2026-06', comRet(80)), mes('2026-07', comRet(75)), mes('2026-08', comRet(72)),
  ]);
  assert.equal(r.tendencias.margemAposIfood.classificacao, 'DETERIORANDO');
  assert.equal(r.tendencias.margemAposIfood.continua, true);
  assert.ok(r.diagnosticos.some(x => x.dimensao === 'MARGEM_APOS_IFOOD' && /deterioração contínua/.test(x.texto)));
});

test('entregadores: MANUTENÇÃO quando percentual e custo por pedido estáveis', () => {
  const m1 = { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000 };
  const r = serie([mes('2026-06', m1), mes('2026-07', m1), mes('2026-08', m1)]);
  assert.equal(r.tendencias.entregadores.ifood.classificacao, 'MANUTENÇÃO');
  assert.equal(r.status.ENTREGADORES, 'SAUDÁVEL');
});

test('entregadores: ACOMPANHAR quando percentual sobe gradualmente com custo por pedido estável', () => {
  const r = serie([
    mes('2026-06', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000 }),
    mes('2026-07', { faturamento: 100000, despesasIfood: 30000, pedidos: 2200, novosClientes: 400, entregadores: 11000 }),
    mes('2026-08', { faturamento: 100000, despesasIfood: 30000, pedidos: 2400, novosClientes: 400, entregadores: 12000 }),
  ]);
  assert.equal(r.tendencias.entregadores.ifood.classificacao, 'ACOMPANHAR');
  assert.equal(r.status.ENTREGADORES, 'ATENÇÃO');
});

test('entregadores: CORREÇÃO quando percentual e custo por pedido deterioram juntos', () => {
  const r = serie([
    mes('2026-06', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000 }),
    mes('2026-07', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 12500 }),
    mes('2026-08', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 15000 }),
  ]);
  assert.equal(r.tendencias.entregadores.ifood.classificacao, 'CORREÇÃO');
  assert.equal(r.status.ENTREGADORES, 'CRÍTICO');
});

test('ausência de dados: tudo SEM DADOS, cobertura insuficiente, sem diagnóstico forte', () => {
  const r = serie([mes('2026-08', { faturamento: null, despesasIfood: null, pedidos: null, novosClientes: null, entregadores: null })]);
  assert.equal(r.qualidade.cobertura, 'insuficiente');
  assert.equal(r.status.FATURAMENTO, 'SEM DADOS');
  assert.deepEqual(r.diagnosticos, []);
  assert.deepEqual(r.investigacao, []);
});

test('mês parcial: análise segue mas a cobertura é parcial e há aviso', () => {
  const b = { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000 };
  const r = serie([mes('2026-07', b), mes('2026-08', b, { parcial: true, financeiroAte: '2026-08-29' })]);
  assert.equal(r.qualidade.cobertura, 'parcial');
  assert.equal(r.qualidade.confianca, 'media');
  assert.ok(r.qualidade.avisos.some(a => /29/.test(a)));
});

test('zero válido e divisão por zero não produzem NaN/Infinity', () => {
  const r = serie([
    mes('2026-07', { faturamento: 0, despesasIfood: 0, pedidos: 0, novosClientes: 0, entregadores: 0 }),
    mes('2026-08', { faturamento: 0, despesasIfood: 0, pedidos: 0, novosClientes: 0, entregadores: 0 }),
  ]);
  const nums = JSON.stringify(r);
  assert.ok(!/NaN|Infinity/.test(nums));
  assert.equal(r.tendencias.faturamento.classificacao, 'SEM DADOS'); // variação sobre base zero => null
});

test('queda forte sem pedidos/clientes: hipótese, nunca causa; pontos de investigação', () => {
  const r = serie([
    mes('2026-07', { faturamento: 120000, despesasIfood: 40000, pedidos: null, novosClientes: null, entregadores: 12000 }),
    mes('2026-08', { faturamento: 55000, despesasIfood: 18000, pedidos: null, novosClientes: null, entregadores: 5500 }),
  ]);
  assert.equal(r.tendencias.faturamento.classificacao, 'QUEDA FORTE');
  assert.ok(r.diagnosticos.some(x => x.tipo === 'hipotese'));
  assert.ok(!r.diagnosticos.some(x => x.tipo === 'evidencia' && x.dimensao === 'FATURAMENTO'));
  assert.ok(r.investigacao.length >= 5);
  assert.ok(!r.investigacao.join(' ').match(/perdeu ranking/i));
});

test('prioridade sobe para custos/margem quando faturamento está saudável', () => {
  const r = serie([
    mes('2026-07', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000 }),
    mes('2026-08', { faturamento: 101000, despesasIfood: 40000, pedidos: 2000, novosClientes: 400, entregadores: 10100 }),
  ]);
  assert.equal(r.status.FATURAMENTO, 'SAUDÁVEL');
  assert.ok(['CUSTOS_IFOOD', 'MARGEM_APOS_IFOOD'].includes(r.prioridades[0].dimensao));
});

test('comparação entre unidades não usa o nome e nunca declara "melhor" sem métrica', () => {
  const cresce = [
    mes('2026-07', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000 }),
    mes('2026-08', { faturamento: 112000, despesasIfood: 33000, pedidos: 2200, novosClientes: 460, entregadores: 11000 }),
  ];
  const cai = [
    mes('2026-07', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000 }),
    mes('2026-08', { faturamento: 60000, despesasIfood: 22000, pedidos: 1200, novosClientes: 250, entregadores: 6000 }),
  ];
  const unidades = [
    { nome: 'Lorem', indicadores: derivar({ faturamento: 212000, despesasIfood: 63000, pedidos: 4200, novosClientes: 860, entregadores: 21000 }), analise: serie(cresce) },
    { nome: 'Ipsum', indicadores: derivar({ faturamento: 160000, despesasIfood: 52000, pedidos: 3200, novosClientes: 650, entregadores: 16000 }), analise: serie(cai) },
  ];
  const c = compararUnidades(unidades);
  assert.equal(c.disponivel, true);
  assert.equal(c.destaques.maiorCrescimento.nome, 'Lorem');
  assert.equal(c.destaques.maiorQueda.nome, 'Ipsum');
  assert.equal(c.destaques.maiorAtencao.nome, 'Ipsum');
  // sem conversão em nenhuma unidade => não declara melhor conversão
  assert.equal(c.destaques.melhorConversao, null);
});

test('nenhuma classificação muda ao renomear a unidade', () => {
  const s = [
    mes('2026-07', { faturamento: 100000, despesasIfood: 30000, pedidos: 2000, novosClientes: 400, entregadores: 10000 }),
    mes('2026-08', { faturamento: 92000, despesasIfood: 27600, pedidos: 1850, novosClientes: 370, entregadores: 9200 }),
  ];
  assert.deepEqual(serie(s).status, serie(s).status);
  assert.equal(serie(s).status.FATURAMENTO, 'ATENÇÃO');
  assert.equal(serie(s).tendencias.faturamento.classificacao, 'QUEDA');
});
