import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlFechamento, formatarPerformance, htmlVisaoPerformance } from '../src/performance.js';
test('formatação distingue moeda, pedidos, percentual e ausência',()=>{
  assert.match(formatarPerformance(968,'inteiro'),/^968$/);
  assert.equal(formatarPerformance(16.49,'percentual'),'16,49%');
  assert.match(formatarPerformance(50,'moeda'),/R\$/);assert.equal(formatarPerformance(null,'moeda'),'—');
});
test('somente campos complementares editáveis; dados do servidor escapados',()=>{
  const c={competencia:'2026-08',unidade:{unidadeNome:'<script>teste</script>'},status:'incompleto',completudePct:50,faltantes:['conversao'],avisos:[],podeFechar:false,campos:[
    {chave:'faturamento',nome:'Faturamento',tipo:'moeda',valor:10,origem:'AUTOMÁTICO',fonte:'Financeiro',editavel:false,status:'Disponível'},
    {chave:'conversao',nome:'Conversão',tipo:'percentual',valor:null,origem:'SEM DADOS',fonte:'Complemento',editavel:true,status:'Pendente'},
    {chave:'ticketMedio',nome:'Ticket',tipo:'moeda',valor:2,origem:'CALCULADO',fonte:'Cálculo',editavel:false,status:'Disponível'},
  ]};
  const html=htmlFechamento(c);assert.ok(!html.includes('data-campo="faturamento"'));assert.ok(!html.includes('data-campo="ticketMedio"'));assert.ok(html.includes('data-campo="conversao"'));
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('Custo externo de entregadores é opcional'));
  assert.ok(htmlFechamento({...c,status:'fechado'}).includes('Reabrir para edição'));
  assert.ok(!htmlFechamento({...c,status:'fechado'}).includes('data-campo='));
});
test('visão vazia não fabrica dados',()=>assert.match(htmlVisaoPerformance({competencias:[]}),/Nenhuma unidade elegível/));

const visaoMock = (over={}) => ({
  metas:{ conversaoMinima:20, crescimentoMinimo:7, crescimentoDesejado:10 },
  consolidado:{ faturamento:55011, despesasIfood:18000, aposDespesas:37011, pedidos:1100, ticketMedio:50, novosClientes:290, conversao:null, entregadores:5500 },
  variacoes:{ faturamento:-56.6 },
  qualidadeDados:{ cobertura:'parcial', confianca:'media', competenciasComDados:2, competenciasNoPeriodo:3, avisos:['Análise parcial: o financeiro oficial da competência mais recente cobre somente até 2026-08-29.'] },
  comparativo:{ disponivel:false, motivo:'Selecione "Todas as unidades" para o comparativo gerencial.', observacoes:[] },
  competencias:[{
    unidade:{ unidadeId:'u1', unidadeNome:'<b>Unidade X</b>' },
    indicadores:{ faturamento:55011, pedidos:1100, ticketMedio:50, novosClientes:290, conversao:16.49, retencaoAposIfoodPct:72, custoIfoodPct:33, custoEntregadoresPct:10, custoPorPedido:5, entregadoresExternos:null },
    variacoes:{ faturamento:-56.6 },
    evolucao:[{ competencia:'2026-08', status:'incompleto', completudePct:83.33, indicadores:{ faturamento:55011 } }],
    diagnosticos:[],
    analise:{
      status:{ FATURAMENTO:'CRÍTICO', CUSTOS_IFOOD:'ATENÇÃO', MARGEM_APOS_IFOOD:'ATENÇÃO', CLIENTES:'CRÍTICO', CONVERSAO:'ATENÇÃO', ENTREGADORES:'SEM DADOS' },
      resumo:{ prioridade:'recuperação de demanda', texto:'Prioridade: recuperação de demanda. O faturamento apresenta forte retração.' },
      prioridades:[{ ordem:1, dimensao:'FATURAMENTO', severidade:'CRÍTICO', texto:'Recuperar volume de pedidos e faturamento' }],
      metas:{ conversao:{ meta:20, ultima:{ competencia:'2026-08', atual:16.49, meta:20, gapPp:-3.51, status:'ABAIXO DA META' } },
        faturamento:{ atual:55011, metaMinima:58862, metaDesejada:60512, faltaMinima:3851, faltaDesejada:5501, percentualNecessarioMinimo:7, percentualNecessarioDesejado:10 },
        novosClientes:{ atual:290, variacao:-31.4, tendencia:'CAINDO' } },
      diagnosticos:[{ dimensao:'FATURAMENTO', tipo:'evidencia', texto:'A queda de faturamento está associada ao volume de pedidos.' },{ dimensao:'FATURAMENTO', tipo:'hipotese', texto:'Os indicadores não explicam sozinhos a queda.' }],
      investigacao:['Exposição e ranqueamento da loja no iFood'],
      tendencias:{ entregadores:{ ifood:{ classificacao:'SEM DADOS' }, externos:{ classificacao:'SEM DADOS' } } },
      qualidade:{},
    },
  }],
  ...over,
});

test('visão gerencial: seções, resumo, metas, diagnóstico com evidência x hipótese e escape',()=>{
  const html=htmlVisaoPerformance(visaoMock());
  for(const s of ['Resumo da Performance','Metas e Oportunidades','Diagnóstico gerencial','Entregadores','Qualidade e completude dos dados']) assert.ok(html.includes(s),s);
  assert.ok(html.includes('&lt;b&gt;Unidade X&lt;/b&gt;'));
  assert.ok(!html.includes('<b>Unidade X</b>'));
  assert.ok(html.includes('Recuperar volume de pedidos e faturamento'));
  assert.ok(html.includes('ABAIXO DA META'));
  assert.ok(html.includes('Evidências nos dados') && html.includes('Hipóteses'));
  assert.ok(html.includes('Possíveis pontos para investigação') && html.includes('Exposição e ranqueamento'));
  assert.ok(/Não é lucro real/.test(html));
  assert.ok(html.includes('Faturamento: CRÍTICO'));
});

test('visão gerencial: sem base de metas não inventa projeção',()=>{
  const mock=visaoMock();
  mock.competencias[0].analise.metas=null;
  const html=htmlVisaoPerformance(mock);
  assert.ok(/Sem base suficiente para projetar metas/.test(html));
});

test('visão gerencial: comparativo aparece só com observações disponíveis',()=>{
  const mock=visaoMock({ comparativo:{ disponivel:true, observacoes:['Lorem teve a melhor evolução de faturamento.'] } });
  assert.ok(htmlVisaoPerformance(mock).includes('Lorem teve a melhor evolução'));
});
