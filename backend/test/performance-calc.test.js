import { test } from 'node:test';
import assert from 'node:assert/strict';
import { variacao, razao, derivar, calcularMes, consolidar, comparar, diagnosticar } from '../src/modules/administrativo/performance/performance.calc.js';
import { configuracaoPerformance } from '../src/modules/administrativo/performance/performance.config.js';

test('variação mensal: aumento, queda, zero real e base ausente', () => {
  assert.equal(variacao(120,100),20); assert.equal(variacao(75,100),-25);
  assert.equal(variacao(0,100),-100);
  for (const v of [0,null,undefined,Infinity,NaN]) assert.equal(variacao(100,v),null);
  assert.equal(variacao(null,100),null);
});
test('custos, ticket financeiro e retenção após iFood', () => {
  const r = derivar({ faturamento:1000, despesasIfood:200, entregadores:100, pedidos:20, valorBruto:1200 });
  assert.equal(r.aposDespesas,800); assert.equal(r.ticketMedio,50);
  assert.equal(r.retencaoAposIfoodPct,80); assert.equal(r.custoIfoodPct,20);
  assert.equal(r.custoEntregadoresPct,10); assert.equal(r.custoPorPedido,5);
  assert.equal(razao(0,10),0); assert.equal(razao(10,0),null);
  assert.equal(razao(Infinity,10),null);
});
const row = (dia, valor, extras = {}) => ({ data_lancamento:`2026-08-${dia}`,status:'finalizado',situacao:'normal',valor_vendas_ifood:valor,qtd_vendas:20,valor_vendas_bruto:1000,novos_clientes:5,taxas_comissoes:100,...extras });
test('mês ausente não vira zero nem mês completo', () => {
  const r=calcularMes([], '2026-08','2026-09-09');
  assert.equal(r.semDados,true); assert.equal(r.incompleto,true);
  assert.ok(Object.values(r.indicadores).every(v => v === null));
});
test('snapshot acumulado não soma dias; diário prevalece sobre distribuição', () => {
  const r=calcularMes([row('10',500),row('20',900),row('31',2000,{origem_lancamento:'distribuicao_mensal'})], '2026-08','2026-09-09');
  assert.equal(r.indicadores.faturamento,900); assert.equal(r.indicadores.pedidos,20);
  assert.equal(r.indicadores.novosClientes,5); assert.equal(r.incompleto,true);
});
test('distribuições recompõem mês sem diário e novos clientes seguem regra oficial', () => {
  const r=calcularMes([row('10',500,{origem_lancamento:'distribuicao_mensal'}),row('20',500,{origem_lancamento:'distribuicao_mensal'})], '2026-08','2026-09-09');
  assert.equal(r.indicadores.faturamento,1000); assert.equal(r.indicadores.pedidos,40);
  assert.equal(r.indicadores.novosClientes,null);
});
test('consolidado de duas unidades calcula razões pelos totais e preserva ausências', () => {
  const a={indicadores:derivar({faturamento:1000,despesasIfood:200,entregadores:100,pedidos:10,valorBruto:1000,novosClientes:3})};
  const b={indicadores:derivar({faturamento:3000,despesasIfood:300,entregadores:200,pedidos:50,valorBruto:3000,novosClientes:7})};
  const r=consolidar([a,b]); assert.equal(r.faturamento,4000);assert.equal(r.ticketMedio,4000/60);assert.equal(r.custoIfoodPct,12.5);
  assert.equal(comparar(b.indicadores,a.indicadores).faturamento,200);
  assert.equal(consolidar([a,calcularMes([],'2026-08','2026-09-09')]).faturamento,null);
});
test('diagnóstico evita conclusões com competência incompleta', () => {
  const cfg=configuracaoPerformance({});
  assert.match(diagnosticar({}, {}, [{incompleto:true}], cfg)[0],/provisórias/);
  assert.equal(diagnosticar({conversao:19},{},[],cfg).length,1);
});
