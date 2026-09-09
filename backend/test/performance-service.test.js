import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { administrativoRouter } from '../src/modules/administrativo/administrativo.routes.js';
import { errorHandler } from '../src/middlewares/errorHandler.js';
import { criarService } from '../src/modules/administrativo/performance/performance.service.js';
import { montarCompetencia } from '../src/modules/administrativo/performance/performance.competencia.js';
import { criarRepositorio } from '../src/modules/administrativo/performance/performance.repo.js';
import { configuracaoPerformance } from '../src/modules/administrativo/performance/performance.config.js';
const A = { unidadeId:'11111111-1111-4111-8111-111111111111',organizacaoId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',unidadeNome:'Unidade A' };
const B = { unidadeId:'22222222-2222-4222-8222-222222222222',organizacaoId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',unidadeNome:'Unidade B' };
const ATOR='33333333-3333-4333-8333-333333333333';
const campos = {faturamento:1000,despesasIfood:200,pedidos:20,novosClientes:3,conversao:18,entregadores:50};
const linha = (u=A,extra={}) => ({unidade_id:u.unidadeId,organizacao_id:u.organizacaoId,data_lancamento:'2026-08-31',status:'finalizado',situacao:'normal',valor_vendas_ifood:1000,taxas_comissoes:100,servicos_promocoes:50,taxas_entregadores:50,qtd_vendas:20,valor_vendas_bruto:900,novos_clientes:3,...extra});
function fixture() {
  const dados={linhas:[],complementos:[],importacoes:[]};
  const chamadas=[];
  const repo={
    carregar:async (...args) => { chamadas.push(args);return structuredClone(dados); },
    salvar:async (u,mes,atual,patch,ator) => {
      const idx=dados.complementos.findIndex(r => r.unidade_id===u.unidadeId && r.competencia===`${mes}-01`);
      if(idx>=0 && (!atual || dados.complementos[idx].versao!==atual.versao)) throw Object.assign(new Error('conflito'),{statusCode:409});
      const r={...atual,...patch,unidade_id:u.unidadeId,organizacao_id:u.organizacaoId,competencia:`${mes}-01`,versao:(atual?.versao??0)+1,criado_por:atual?.criado_por??ator,atualizado_por:ator};
      if(idx<0) dados.complementos.push(r);else dados.complementos[idx]=r;
      return r;
    },
  };
  const deps={repo,hoje:'2026-09-09',config:{...configuracaoPerformance({}),unidadeIds:[A.unidadeId,B.unidadeId]},listarUnidadesElegiveis:async () => [A,B]};
  return {dados,repo,deps,chamadas,s:criarService(deps)};
}
test('cria abril sem dados, salva complementos e calcula sem guardar derivados',async () => {
  const {s,dados}=fixture();
  let r=await s.abrir(A.unidadeId,'2026-04'); assert.equal(r.completudePct,0);assert.equal(r.status,'incompleto');
  r=await s.salvar(A.unidadeId,'2026-04',{versao:0,campos},ATOR);
  assert.equal(r.completudePct,100);assert.equal(r.status,'completo');assert.equal(r.indicadores.ticketMedio,50);
  assert.equal(r.indicadores.retencaoAposIfoodPct,80);assert.equal(r.indicadores.entregadoresExternos,null);
  assert.equal(r.campos.find(c=>c.chave==='conversao').origem,'MANUAL');assert.equal(r.campos.find(c=>c.chave==='ticketMedio').origem,'CALCULADO');
  assert.equal(dados.complementos[0].ticketMedio,undefined);assert.equal(dados.complementos[0].criado_por,ATOR);
});
test('edição exige versão; unidade e competência têm registros independentes',async () => {
  const {s,dados}=fixture();
  await s.salvar(A.unidadeId,'2026-04',{versao:0,campos},ATOR);
  await assert.rejects(s.salvar(A.unidadeId,'2026-04',{versao:0,campos},ATOR),e=>e.statusCode===409);
  await s.salvar(A.unidadeId,'2026-04',{versao:1,campos:{pedidos:25}},ATOR);
  await s.salvar(A.unidadeId,'2026-05',{versao:0,campos:{pedidos:30}},ATOR);
  await s.salvar(B.unidadeId,'2026-04',{versao:0,campos:{pedidos:40}},ATOR);
  assert.equal(dados.complementos.length,3);assert.equal((await s.abrir(A.unidadeId,'2026-04')).indicadores.pedidos,25);
  assert.equal((await s.abrir(B.unidadeId,'2026-04')).indicadores.pedidos,40);
});
test('fonte oficial prevalece inclusive zero e bloqueia sobrescrita',async () => {
  const {s,dados}=fixture();await s.salvar(A.unidadeId,'2026-08',{versao:0,campos},ATOR);
  dados.linhas.push(linha(A,{valor_vendas_ifood:0}));
  const r=await s.abrir(A.unidadeId,'2026-08');assert.equal(r.indicadores.faturamento,0);assert.equal(r.indicadores.ticketMedio,0);
  assert.equal(r.campos.find(c=>c.chave==='faturamento').origem,'AUTOMÁTICO');assert.equal(r.campos.find(c=>c.chave==='faturamento').complementoIgnorado,true);
  await assert.rejects(s.salvar(A.unidadeId,'2026-08',{versao:1,campos:{faturamento:999}},ATOR),e=>e.statusCode===409);
});
test('agosto parcial não fecha mesmo com 100% de campos disponíveis',async () => {
  const {s,dados}=fixture();dados.linhas.push(linha(A,{data_lancamento:'2026-08-29'}));
  const r=await s.salvar(A.unidadeId,'2026-08',{versao:0,campos:{conversao:18}},ATOR);
  assert.equal(r.completudePct,100);assert.equal(r.parcial,true);assert.equal(r.status,'incompleto');
  await assert.rejects(s.salvar(A.unidadeId,'2026-08',{versao:1,acao:'fechar'},ATOR),e=>e.statusCode===409);
});
test('fechar, reabrir e detectar mudança posterior na fonte',async () => {
  const {s,dados}=fixture();let r=await s.salvar(A.unidadeId,'2026-08',{versao:0,campos,acao:'fechar'},ATOR);
  assert.equal(r.status,'fechado');assert.ok(r.fechadoEm);
  await assert.rejects(s.salvar(A.unidadeId,'2026-08',{versao:1,campos:{pedidos:1}},ATOR),e=>e.statusCode===409);
  dados.linhas.push(linha(A,{valor_vendas_ifood:2000}));
  assert.equal((await s.abrir(A.unidadeId,'2026-08')).status,'revisao_necessaria');
  r=await s.salvar(A.unidadeId,'2026-08',{versao:1,acao:'reabrir'},ATOR);assert.equal(r.status,'completo');assert.equal(r.fechadoEm,null);
});
test('campos inválidos, derivados, payload de escopo e divisões por zero',async () => {
  const {s}=fixture();
  for(const patch of [{ticketMedio:2},{conversao:101},{pedidos:1.5},{pedidos:'2'},{faturamento:-1},{entregadores:Infinity}]) await assert.rejects(s.salvar(A.unidadeId,'2026-04',{versao:0,campos:patch},ATOR),e=>e.statusCode===400);
  await assert.rejects(s.salvar(A.unidadeId,'2026-04',{versao:0,campos,organizacao_id:B.organizacaoId},ATOR),e=>e.statusCode===400);
  const r=await s.salvar(A.unidadeId,'2026-04',{versao:0,campos:{...campos,faturamento:0,pedidos:0}},ATOR);
  assert.equal(r.indicadores.ticketMedio,null);assert.equal(r.indicadores.custoIfoodPct,null);assert.equal(r.completudePct,100);
});
test('linhas de outra organização/unidade jamais entram no resultado',async () => {
  const {s,dados,chamadas}=fixture();dados.linhas.push(linha(B),linha(A,{organizacao_id:B.organizacaoId}));
  const r=await s.abrir(A.unidadeId,'2026-08');assert.equal(r.indicadores.faturamento,null);
  assert.equal(chamadas[0][0].organizacaoId,A.organizacaoId);
  await assert.rejects(s.abrir(ATOR,'2026-08'),e=>e.statusCode===403);
  await assert.rejects(s.abrir(A.unidadeId,'2026-13'),e=>e.statusCode===400);
});
test('Centro/Avenida não consultam parser nem dependem dele; custo externo só manual',async () => {
  const {s,dados}=fixture();dados.importacoes.push({unidade_id:A.unidadeId,organizacao_id:A.organizacaoId,status:'concluida',periodo_inicio:'2026-04-01',periodo_fim:'2026-04-30',taxas_validas:999});
  let r=await s.salvar(A.unidadeId,'2026-04',{versao:0,campos},ATOR);assert.equal(r.completudePct,100);assert.equal(r.indicadores.entregadoresExternos,null);
  r=await s.salvar(A.unidadeId,'2026-04',{versao:1,campos:{entregadoresExternos:100}},ATOR);
  assert.equal(r.indicadores.entregadoresExternos,100);assert.equal(r.indicadores.entregadores,50);assert.equal(r.indicadores.aposDespesas,800);assert.equal(r.indicadores.custoExternoPorPedido,5);
});
test('repo aplica dois filtros de escopo e não acessa Parser desabilitado',async () => {
  const tabelas=[],filtros=[];
  const db={from(t){tabelas.push(t);const q={select:()=>q,eq:(k,v)=>{filtros.push([t,k,v]);return q;},gte:()=>q,lt:()=>q,lte:()=>q,order:()=>q,range:async()=>({data:[]})};return q;}};
  await criarRepositorio({supabase:db}).carregar(A,'2026-04','2026-08');
  assert.ok(!tabelas.includes('parser_fd_importacoes'));
  for(const t of tabelas) {assert.ok(filtros.some(f=>f[0]===t&&f[1]==='organizacao_id'&&f[2]===A.organizacaoId));assert.ok(filtros.some(f=>f[0]===t&&f[1]==='unidade_id'&&f[2]===A.unidadeId));}
});
test('Parser futuro é opt-in e condicionado ao módulo elegível',async () => {
  const f=fixture(); f.deps.config.parserUnidadeIds=[A.unidadeId];
  f.deps.listarUnidadesElegiveis=async ({moduloId}) => moduloId==='parser_food_delivery' ? []:[A,B];
  assert.equal((await criarService(f.deps).unidades())[0].usaParser,false);
  f.deps.listarUnidadesElegiveis=async () => [A,B];assert.equal((await criarService(f.deps).unidades())[0].usaParser,true);
});
test('julho recompõe financeiro mensal e permite somente pedidos/clientes/conversão ausentes',async () => {
  const {s,dados}=fixture();dados.linhas.push(linha(A,{data_lancamento:'2026-07-31',origem_lancamento:'distribuicao_mensal',qtd_vendas:null,valor_vendas_bruto:null,novos_clientes:null}));
  const r=await s.salvar(A.unidadeId,'2026-07',{versao:0,campos:{pedidos:20,novosClientes:4,conversao:21}},ATOR);
  assert.equal(r.status,'completo');assert.equal(r.completudePct,100);assert.equal(r.indicadores.faturamento,1000);
  assert.equal(r.campos.find(c=>c.chave==='faturamento').origem,'AUTOMÁTICO');assert.equal(dados.complementos[0].faturamento_ifood_manual,undefined);
});
test('fonte que aparece durante a edição é detectada antes da escrita',async () => {
  const f=fixture();let leituras=0;
  f.repo.carregar=async()=>{leituras++;if(leituras===2)f.dados.linhas.push(linha());return structuredClone(f.dados);};
  await assert.rejects(f.s.salvar(A.unidadeId,'2026-08',{versao:0,campos:{faturamento:50}},ATOR),e=>e.statusCode===409);
  assert.equal(f.dados.complementos.length,0);
});
test('listagem mantém meses ausentes e seleciona a unidade exata',async () => {
  const {s}=fixture();await s.salvar(A.unidadeId,'2026-04',{versao:0,campos},ATOR);
  const r=await s.listar({inicio:'2026-04',fim:'2026-08',unidade_id:A.unidadeId});
  assert.equal(r.competencias.length,1);assert.equal(r.competencias[0].evolucao.length,5);
  assert.equal(r.competencias[0].evolucao[0].indicadores.faturamento,1000);assert.equal(r.consolidado.faturamento,null);
  const mes=await s.listar({inicio:'2026-04',fim:'2026-04',unidade_id:A.unidadeId});assert.equal(mes.consolidado.conversao,18);
});
test('listar expõe a camada de análise sem quebrar o contrato existente',async () => {
  const {s,dados}=fixture();
  for(const [i,fat] of [126757,90000,55011].entries()) dados.complementos.push({unidade_id:A.unidadeId,organizacao_id:A.organizacaoId,competencia:`2026-0${6+i}-01`,status:'rascunho',versao:1,
    faturamento_ifood_manual:fat,despesas_ifood_manual:fat*0.32,pedidos_manual:Math.round(fat/50),novos_clientes_manual:Math.round(fat/150),conversao_manual:16.49,taxas_entregadores_ifood_manual:fat*0.12});
  const r=await s.listar({inicio:'2026-06',fim:'2026-08',unidade_id:A.unidadeId});
  const u=r.competencias[0];
  assert.ok(Array.isArray(u.evolucao)&&u.consolidado===undefined); // contrato antigo preservado
  assert.equal(u.analise.tendencias.faturamento.classificacao,'QUEDA FORTE');
  assert.equal(u.status.FATURAMENTO,'CRÍTICO');
  assert.equal(u.prioridades[0].dimensao,'FATURAMENTO');
  assert.ok(u.metas.faturamento.metaMinima>u.metas.faturamento.atual);
  assert.equal(r.metas.conversaoMinima,20);
  assert.ok(r.qualidadeDados && r.diagnosticoGeral && r.comparativo);
  assert.ok(!JSON.stringify(r).match(/NaN|Infinity/));
});
test('comparativo gerencial entre as duas unidades, sem depender do nome',async () => {
  const {s,dados}=fixture();
  const linhaMes=(u,mes,fat)=>({unidade_id:u.unidadeId,organizacao_id:u.organizacaoId,data_lancamento:`${mes}-28`,status:'finalizado',situacao:'normal',
    valor_vendas_ifood:fat,taxas_comissoes:fat*0.2,servicos_promocoes:fat*0.05,taxas_entregadores:fat*0.1,qtd_vendas:Math.round(fat/50),valor_vendas_bruto:fat*1.1,novos_clientes:Math.round(fat/150)});
  dados.linhas.push(linhaMes(A,'2026-07',100000),linhaMes(A,'2026-08',60000),linhaMes(B,'2026-07',100000),linhaMes(B,'2026-08',115000));
  const r=await s.listar({inicio:'2026-07',fim:'2026-08'});
  assert.equal(r.comparativo.disponivel,true);
  assert.equal(r.comparativo.destaques.maiorQueda.nome,'Unidade A');
  assert.equal(r.comparativo.destaques.maiorCrescimento.nome,'Unidade B');
});
test('mês atual não fecha; remover complemento volta a SEM DADOS',async () => {
  const {s}=fixture();await assert.rejects(s.salvar(A.unidadeId,'2026-09',{versao:0,campos,acao:'fechar'},ATOR),e=>e.statusCode===409);
  await s.salvar(A.unidadeId,'2026-04',{versao:0,campos},ATOR);
  const r=await s.salvar(A.unidadeId,'2026-04',{versao:1,campos:{conversao:null}},ATOR);
  assert.equal(r.campos.find(c=>c.chave==='conversao').origem,'SEM DADOS');assert.equal(r.status,'incompleto');
});
test('HTTP: gate administrativo protege leitura e escrita; SuperAdmin e admin acessam',async () => {
  const f=fixture();const app=express();app.use(express.json());app.locals.adminDeps=f.deps;app.locals.adminHoje=f.deps.hoje;
  app.use((req,res,next)=>{req.user={id:ATOR,painelAdministrativo:req.headers['x-test-role']==='admin',superadmin:req.headers['x-test-role']==='super'};next();});
  app.use('/administrativo',administrativoRouter);app.use(errorHandler);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/administrativo/performance`;
  try {
    for(const role of ['tenant','admin','super']) {
      const r=await fetch(`${url}/unidades`,{headers:{'x-test-role':role}});assert.equal(r.status,role==='tenant'?403:200);
    }
    const path=`${url}/unidades/${A.unidadeId}/competencias/2026-04`;
    let r=await fetch(path,{method:'PATCH',headers:{'Content-Type':'application/json','x-test-role':'tenant'},body:JSON.stringify({versao:0,campos})});assert.equal(r.status,403);
    r=await fetch(path,{method:'PATCH',headers:{'Content-Type':'application/json','x-test-role':'admin'},body:JSON.stringify({versao:0,campos})});assert.equal(r.status,200);assert.equal((await r.json()).data.completudePct,100);
    r=await fetch(`${url}/unidades/${ATOR}/competencias/2026-04`,{headers:{'x-test-role':'admin'}});assert.equal(r.status,403);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
