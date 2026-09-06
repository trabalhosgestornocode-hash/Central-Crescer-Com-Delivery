// Sem .env, sem rede: regras + serviço real com persistência em memória.
// node --experimental-vm-modules --test test/bonificacao-importacao-diaria.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import { extrairPeriodoDiario, resolverPeriodoDiario, validarVinculoImportacao, localizarImportacao } from '../src/modules/bonificacao-mensal/bonificacaoMensal.importacao.js';
import { mixMensalPonderado } from '../src/modules/bonificacao-mensal/bonificacaoMensal.calc.js';

// Configuração necessária apenas ao parser; Supabase permanece inteiramente simulado.
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'teste-sem-rede';
process.env.SUPABASE_ANON_KEY = 'teste-sem-rede';

const org='org', unidade='unidade', data='2026-09-04';
const alvo={organizacaoId:org,unidadeId:unidade,tipo:'loja',data};
const imp={id:'i4',organizacao_id:org,unidade_id:unidade,tipo_relatorio:'loja',data_lancamento:data,status:'concluida'};
test('C/D: ID de 04 em 03 é recusado; vínculo legado duplicado também',()=>{
  assert.throws(()=>validarVinculoImportacao(imp,{...alvo,data:'2026-09-03'}),/não pode ser reutilizada/);
  assert.throws(()=>validarVinculoImportacao(imp,alvo,[{organizacao_id:org,unidade_id:unidade,data:'2026-09-03',importacao_loja_id:'i4'}]),/outro dia/);
});
test('H: organização, unidade, tipo e competência incompatíveis são recusados',()=>{
  for(const mod of [{organizacaoId:'outra'},{unidadeId:'outra'},{tipo:'geral'},{data:'2026-10-04'}]) assert.throws(()=>validarVinculoImportacao(imp,{...alvo,...mod}));
});
test('período: conteúdo explícito, declaração obrigatória, nome auxiliar e datas inválidas',()=>{
  assert.deepEqual(extrairPeriodoDiario('Período: 04/09/2026 a 04/09/2026'),{inicio:data,fim:data});
  assert.equal(extrairPeriodoDiario('Gerado em 04/09/2026\n31/08'),null);
  assert.throws(()=>resolverPeriodoDiario({data,nomeArquivo:'0409.pdf'}),/confirme/);
  assert.throws(()=>resolverPeriodoDiario({data,extraido:{inicio:'2026-09-03',fim:'2026-09-03'}}),/não pode alimentar/);
  assert.throws(()=>resolverPeriodoDiario({data:'2026-09-03',nomeArquivo:'Visio 0409.pdf',declarado:{inicio:'2026-09-03',fim:'2026-09-03',confirmado:true}}),/nome do arquivo/);
  assert.throws(()=>extrairPeriodoDiario('Período: 31/02/2026'),/inválida/);
  assert.throws(()=>extrairPeriodoDiario('Período: 03/09/2026\nPeríodo: 04/09/2026'),/conflitantes/);
  assert.throws(()=>resolverPeriodoDiario({data,extraido:{inicio:data,fim:'2026-09-05'}}),/não pode alimentar/);
  assert.equal(resolverPeriodoDiario({data,extraido:{inicio:data,fim:data},nomeArquivo:'Visio 0309.pdf'}).fonte,'conteudo');
});
test('falha de consulta nunca é tratada como importação órfã',async()=>{
  const chain={select(){return this;},eq(){return this;},then(resolve){return Promise.resolve({error:{message:'offline'},data:null}).then(resolve);}};
  await assert.rejects(()=>localizarImportacao({from:()=>chain},alvo,'hash'),/verificar o histórico/);
});
test('I/J: fórmula inalterada e referência completa',()=>{
  const result=mixMensalPonderado([[108,49,20,21],[120,49,24,18],[114,50,36,23],[133,51,19,15]].map(([s,b,a,d])=>({qtdSanduichesLoja:s,qtdBebidasLoja:b,qtdAdicionaisLoja:a,qtdDiversosLoja:d})));
  assert.deepEqual([result.somaSanduiches,result.somaBebidas,result.somaAdicionais,result.somaDiversos],[475,199,99,77]);
  assert.deepEqual(['bebidas','adicionais','diversos'].map(k=>result[k].toFixed(1)),['41.9','20.8','16.2']);
});

// Exercita o corpo real do service, trocando apenas o módulo Supabase por um fake.
async function servico() {
  const tables={unidades:[{id:unidade,organizacao_id:org,nome:'Subway Saci'}],bonificacao_lancamentos_diarios:[],bonificacao_importacoes:[]};
  let writes=0,uploads=0;
  const db={from(table){
    let filters=[],op='select',value;
    const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},or(expr){const parts=expr.split(',').map(s=>s.split('.eq.'));filters.push(r=>parts.some(([k,v])=>r[k]===v));return q;},
      insert(v){op='insert';value=v;return q;},upsert(v){op='upsert';value=v;return q;},
      then(resolve,reject){try {let rows=(tables[table]||[]).filter(r=>filters.every(f=>f(r)));
        if(op!=='select'){writes++;const list=tables[table] ||= [];let row=op==='upsert'&&list.find(r=>r.data===value.data&&r.unidade_id===value.unidade_id);if(row)Object.assign(row,value);else{row={id:`id-${writes}`,...value};list.push(row);}rows=[row];}
        return Promise.resolve({data:rows,error:null}).then(resolve,reject);
      }catch(e){return Promise.reject(e).then(resolve,reject);}},
      async maybeSingle(){const r=await q;return {...r,data:r.data[0]||null};},async single(){return q.maybeSingle();}};return q;
  },storage:{from(){return {async upload(){uploads++;return {error:null};}};}}};
  const url=new URL('../src/modules/bonificacao-mensal/bonificacaoMensal.service.js',import.meta.url);
  const mod=new SourceTextModule(readFileSync(url,'utf8'),{identifier:url.href});
  await mod.link(async spec=>{
    let ns;
    if(spec.endsWith('/config/supabase.js'))ns={supabase:db};
    else if(spec.endsWith('/shared/auditoria.js'))ns={auditar:async()=>{},ACOES:{}};
    else ns=await import(new URL(spec,url));
    return new SyntheticModule(Object.keys(ns),function(){for(const [k,v] of Object.entries(ns))this.setExport(k,v);});
  });
  await mod.evaluate();
  return {run:mod.namespace.processarImportacaoVisio,tables,get writes(){return writes;},get uploads(){return uploads;}};
}
function pedido(d,nome='relatorio.pdf') {
  return {organizacaoId:org,unidadeId:unidade,usuario:{id:null,nome:'teste'},confirmar:true,
    payload:{data:d,loja:{nomeArquivo:nome,conteudoBase64:readFileSync(new URL('fixtures/visio-loja.pdf',import.meta.url)).toString('base64'),periodo:{inicio:d,fim:d,confirmado:true}}}};
}
test('serviço: mesmo dia é idempotente; E: hash em outro dia bloqueia antes de upload',async()=>{
  const s=await servico();const req=pedido(data);
  const primeiro=await s.run(req);assert.equal(primeiro.persistido,true);
  req.payload.substituir=true;
  assert.equal((await s.run(req)).lancamento.importacaoLojaId,primeiro.lancamento.importacaoLojaId);
  assert.equal(s.tables.bonificacao_importacoes.length,1);assert.equal(s.uploads,1);
  const writes=s.writes;
  await assert.rejects(()=>s.run(pedido('2026-09-03')),/não pode ser reutilizada/);
  assert.equal(s.writes,writes);assert.equal(s.uploads,1);
});
test('serviço C: arquivo 0409 em 03 bloqueado antes de qualquer escrita',async()=>{
  const s=await servico();await assert.rejects(()=>s.run(pedido('2026-09-03','Visio 0409.pdf')),/nome do arquivo/);
  assert.equal(s.writes,0);assert.equal(s.uploads,0);
});
test('serviço A/B: documentos novos com período confirmado em 03 e 04',async()=>{
  for(const dia of ['03','04']){const s=await servico();assert.equal((await s.run(pedido(`2026-09-${dia}`,`Visio ${dia}09.pdf`))).persistido,true);}
});
