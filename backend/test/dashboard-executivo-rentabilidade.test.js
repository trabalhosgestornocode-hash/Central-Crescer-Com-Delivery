import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularProtecaoPrecificacao, calcularComparacaoProduto } from '../src/modules/dashboard-executivo/dashboardExecutivo.rentabilidade.js';
// PROTEÇÃO DA PRECIFICAÇÃO — só preços. Sem meta, sem limite, sem status.
const perto = (a,b) => assert.ok(Math.abs(a-b)<1e-9, a + ' != ' + b);
const calc = (o={}) => calcularProtecaoPrecificacao({ precoBalcao:24, precoIfood:35, ticketMedioIfood:55.36, ...o });

test('E × Z4: diferença 11 e proteção 31,43%', () => {
  const r=calc();
  assert.equal(r.diferencaPrecoReais,11);
  perto(r.protecaoPrecificacaoPct, 11/35*100);
  assert.equal(r.protecaoPrecificacaoPct.toFixed(2),'31.43');
});
test('F × Z4: diferença 10,50 e proteção 30,00%', () => {
  const r=calc({precoBalcao:24.5});
  assert.equal(r.diferencaPrecoReais,10.5);
  assert.equal(r.protecaoPrecificacaoPct.toFixed(2),'30.00');
});
test('D × Z4: diferença 11,50 e proteção 32,86%', () => {
  const r=calc({precoBalcao:23.5});
  assert.equal(r.diferencaPrecoReais,11.5);
  assert.equal(r.protecaoPrecificacaoPct.toFixed(2),'32.86');
});
test('denominador é o preço do iFood', () => {
  // 20 Balcão / 50 iFood → (50-20)/50 = 60%
  assert.equal(calc({precoBalcao:20,precoIfood:50}).protecaoPrecificacaoPct.toFixed(2),'60.00');
});
test('Ticket equivalente Balcão é projeção proporcional; proteção financeira = real − equivalente', () => {
  const r=calc({ticketMedioIfood:47.33});
  perto(r.ticketMedioEquivalenteBalcao, 47.33*24/35);
  assert.equal(r.ticketMedioEquivalenteBalcao.toFixed(2),'32.45'); // arredondamento só na exibição
  assert.equal(r.protecaoFinanceiraReais.toFixed(2),'14.88');
});
test('Ticket ausente não apaga a proteção percentual', () => {
  const r=calc({ticketMedioIfood:null});
  assert.equal(r.ticketMedioEquivalenteBalcao,null);
  assert.equal(r.protecaoFinanceiraReais,null);
  assert.equal(r.protecaoPrecificacaoPct.toFixed(2),'31.43');
});
for (const v of [null,undefined,0,-1,NaN,Infinity]) test('preço iFood inválido: '+v,()=>{
  const r=calc({precoIfood:v});
  assert.equal(r.protecaoPrecificacaoPct,null);
  assert.equal(r.diferencaPrecoReais,null);
});
for (const v of [null,undefined,-1,NaN,Infinity]) test('preço Balcão inválido: '+v,()=>{
  assert.equal(calc({precoBalcao:v}).protecaoPrecificacaoPct,null);
});
test('Balcão acima do iFood → proteção negativa (não mascara)', () => {
  assert.ok(calc({precoBalcao:40}).protecaoPrecificacaoPct < 0);
});
test('o motor de proteção NÃO devolve meta, limite, status nem deduções marketplace', () => {
  const r=calc();
  for (const chave of ['limiteTotalDeducoes','limiteTaxasComissoes','limiteServicosPromocoes','metaServicosPromocoes','deducoesMarketplaceAtual','indicadores','metas','status','politicaPrecificacao']) {
    assert.equal(r[chave],undefined, 'não deve existir: '+chave);
  }
});
test('calcularComparacaoProduto: margem do iFood usa deduções reais (Taxas + Serviços), não metas', () => {
  const precos={balcao:{preco:24,custo:6},ifood:{preco:35,custo:6}};
  const c=calcularComparacaoProduto(precos,{taxasComissoesPct:11.5,servicosPromocoesPct:12.6});
  perto(c.balcao.margemEstimada,18);
  perto(c.ifood.deducoesConsideradasPct,24.1);
  perto(c.ifood.margemEstimada,35*(1-.241)-6);
  assert.equal(calcularComparacaoProduto({...precos,ifood:{preco:35,custo:null}},{taxasComissoesPct:11.5,servicosPromocoesPct:12.6}).ifood.margemEstimada,null);
});
