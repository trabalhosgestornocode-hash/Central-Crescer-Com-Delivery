import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SourceTextModule, SyntheticModule } from 'node:vm';
const dir = new URL('../src/modules/dashboard-executivo/',import.meta.url);
// Metas LOGÍSTICAS (mock de resolverMetas) — Full Service seria outro conjunto.
const metas={taxas_comissoes:{metaIdeal:13,limite:13},servicos_promocoes:{metaIdeal:5,limite:7},taxas_entregadores:{metaIdeal:12,limite:15},total_deducoes:{metaIdeal:30,limite:35}};
async function carregar(nome, mocks) {
 const url=new URL(nome,dir);const m=new SourceTextModule(readFileSync(url,'utf8'),{identifier:url.href});
 await m.link(async spec=>{const ns=mocks[spec] ?? await import(new URL(spec,url));return new SyntheticModule(Object.keys(ns),function(){for(const [k,v] of Object.entries(ns))this.setExport(k,v);});});
 await m.evaluate();return m.namespace;
}
function banco() {
 return {from(tabela){const filtros={};let unico=false;
  const resposta=()=>{
   if(tabela==='unidades')return {data:{id:filtros.id,organizacao_id:filtros.id==='estranha'?'outra':'org'}};
   if(tabela!=='lancamentos_financeiros_diarios'||unico)return {data:unico?null:[]};
   const mes=filtros.inicio?.slice(5,7);if(!['08','09'].includes(mes))return {data:[]};
   const ticket=mes==='09'?55.36:70;
   return {data:[{id:'lanc',unidade_id:filtros.unidade_id,data_lancamento:'2026-'+mes+'-05',situacao:'normal',status:'finalizado',qtd_vendas:100,valor_vendas_bruto:ticket*100,valor_vendas_ifood:10000,taxas_comissoes:1150,servicos_promocoes:1260,taxas_entregadores:800}]};
  };
  const q={select(){return q},eq(k,v){filtros[k]=v;return q},gte(k,v){filtros.inicio=v;return q},lte(){return q},order(){return q},limit(){return q},maybeSingle(){unico=true;return Promise.resolve(resposta())},then(a,b){return Promise.resolve(resposta()).then(a,b)}};return q;
 }};
}
test('mês e simulador: proteção da precificação separada das metas logísticas',async()=>{
 const precosCalls=[];
 const svc=await carregar('dashboardExecutivo.service.js',{
  '../../config/supabase.js':{supabase:banco()},
  '../../shared/desbloqueiosIfood.js':{carregarDatasLiberadas:async()=>new Set()},
  './dashboardExecutivo.metas.service.js':{resolverMetas:async()=>metas,obterModeloLogistico:async()=>({modeloLogistico:'marketplace'}),definirModeloLogistico(){},historicoModeloLogistico(){}},
  './dashboardExecutivo.precos.service.js':{carregarPrecosRentabilidade:async p=>{precosCalls.push(p);const b=p.tabelaBalcao??(p.unidadeId==='b'?'D':'E');const i=p.tabelaIfood??'Z4';return {oficiais:{tabelaBalcao:p.unidadeId==='b'?'D':'E',tabelaIfood:'Z4'},tabelas:{balcao:b,ifood:i},produto:{id:'p1',nome:'Churrasco 15cm'},balcao:{preco:b==='E'?24:23.5,custo:6},ifood:{preco:i==='Z4'?35:null,custo:6}};}},
 });
 const pedido={organizacaoId:'org',unidadeIdSessao:null,unidadeIdSolicitado:'a',mes:9,ano:2026};

 const a=await svc.obterMes(pedido);
 // Proteção da precificação: só preços, fora da tabela de indicadores.
 assert.equal(a.protecaoPrecificacao.protecaoPrecificacaoPct.toFixed(2),'31.43');
 assert.equal(a.protecaoPrecificacao.diferencaPrecoReais,11);
 assert.equal(a.protecaoPrecificacao.ticketMedioIfood,55.36);
 assert.equal(a.rentabilidade,undefined);
 assert.equal(a.cards.deducoesMarketplace,undefined);
 // Os 4 indicadores logísticos vêm de resolverMetas — nunca da proteção.
 assert.deepEqual(Object.keys(a.indicadoresRentabilidade).sort(),['servicos_promocoes','taxas_comissoes','taxas_entregadores','total_deducoes']);
 // LIMITES continuam logísticos (metas_indicadores); META IDEAL de Serviços e
 // Total acompanha a proteção (Marketplace: reserva = Taxas 13 + Entregadores 12).
 assert.equal(a.indicadoresRentabilidade.taxas_comissoes.limite,13);
 assert.equal(a.indicadoresRentabilidade.servicos_promocoes.limite,7);
 assert.equal(a.indicadoresRentabilidade.taxas_comissoes.metaIdeal,13); // fixa
 assert.equal(a.indicadoresRentabilidade.taxas_entregadores.metaIdeal,12); // fixa
 assert.equal(a.indicadoresRentabilidade.servicos_promocoes.metaIdeal.toFixed(2),'6.43'); // 31,43 − 13 − 12
 assert.equal(a.indicadoresRentabilidade.total_deducoes.metaIdeal.toFixed(2),'31.43'); // = protecao
 // Tabela: sem estado "Crítico" — acima do limite é sempre "Atenção".
 assert.equal(a.indicadoresRentabilidade.servicos_promocoes.status.chave,'atencao'); // 12,6% > limite 7%
 assert.equal(a.indicadoresRentabilidade.servicos_promocoes.status.label,'Atenção');
 assert.equal(a.indicadoresRentabilidade.taxas_comissoes.status.chave,'dentro_da_meta'); // 11,5% <= meta 13
 assert.equal(a.protecaoPrecificacao.protecaoInsuficiente,false);
 assert.equal(a.protecaoPrecificacao.metaServicosAcimaDoLimite,false); // 6,43 <= limite 7

 // NÃO CONTAMINAÇÃO: trocar a tabela muda a proteção, não as metas logísticas.
 const d=await svc.obterMes({...pedido,tabelaBalcao:'D'});
 assert.equal(d.protecaoPrecificacao.protecaoPrecificacaoPct.toFixed(2),'32.86');
 assert.equal(d.indicadoresRentabilidade.servicos_promocoes.limite,7);
 assert.equal(d.indicadoresRentabilidade.taxas_comissoes.limite,13);
 // D×Z4: bruto Serviços 7,86 > limite 7 → meta fica em 7,00 + flag interna.
 assert.equal(d.indicadoresRentabilidade.servicos_promocoes.metaIdeal,7);
 assert.equal(d.protecaoPrecificacao.metaServicosAcimaDoLimite,true);
 assert.equal(d.indicadoresRentabilidade.total_deducoes.metaIdeal.toFixed(2),'32.86');

 const b=await svc.obterMes({...pedido,unidadeIdSolicitado:'b'});
 assert.equal(b.protecaoPrecificacao.precos.tabelas.balcao,'D');
 const agosto=await svc.obterMes({...pedido,mes:8});assert.equal(agosto.protecaoPrecificacao.ticketMedioIfood,70);
 const vazio=await svc.obterMes({...pedido,mes:7});
 assert.equal(vazio.protecaoPrecificacao.ticketMedioIfood,null);
 assert.equal(vazio.protecaoPrecificacao.protecaoPrecificacaoPct.toFixed(2),'31.43'); // preço não depende do mês
 const semPreco=await svc.obterMes({...pedido,tabelaIfood:'inexistente'});
 assert.equal(semPreco.protecaoPrecificacao.protecaoPrecificacaoPct,null);

 // Isolamento de tenant: unidade de outra organização é recusada antes de carregar preços.
 const qtd=precosCalls.length;await assert.rejects(svc.obterMes({...pedido,unidadeIdSolicitado:'estranha'}));assert.equal(precosCalls.length,qtd);

 // Adaptador do endpoint legado: mesma proteção, sem meta/limite logístico.
 const sim=await carregar('dashboardExecutivo.simulador.service.js',{'./dashboardExecutivo.service.js':svc});
 const r=await sim.simularPrecoProduto({...pedido,canal:'ifood',tabelaBalcao:'D',tabelaIfood:'Z4'});
 assert.equal(r.protecaoPrecificacao.protecaoPrecificacaoPct.toFixed(2),'32.86');
 assert.equal(r.servicosPromocoesLimite,undefined);
 assert.equal((await svc.obterMes(pedido)).protecaoPrecificacao.precos.tabelas.balcao,'E');
});
