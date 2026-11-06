// QA em loopback: frontend e serviços reais, sessão local fictícia, banco estritamente somente leitura.
// Iniciar de backend/: node --env-file=.env.test-integracao testes-seguros/visao-rede/servidor.mjs
import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarCenario } from './cenarios.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const frontend=path.join(root,'frontend');
const realUrl=process.env.SUPABASE_URL;
if (!realUrl || !process.env.INTEGRACAO_SUPABASE_DESCARTAVEL || new URL(realUrl).hostname !== 'wiqqsxnysbzhcrzrrean.supabase.co') throw Error('Exige projeto de homologação descartável conhecido');
const originalFetch=globalThis.fetch;
let modo='real'; const dados=criarCenario(); const acessos=[]; let escritasBloqueadas=0;
const comparar=(v,s)=>s==='null'?v==null:String(v)===s;
function respostaLocal(url,opts) {
 const tabela=url.pathname.split('/').pop(); let rows=structuredClone(dados[tabela]??[]);
 for(const [campo,exp] of url.searchParams) {
  if(['select','order','offset','limit','or'].includes(campo))continue;
  const k=exp.indexOf('.'),op=exp.slice(0,k),val=exp.slice(k+1);
  if(op==='eq')rows=rows.filter(r=>comparar(r[campo],val));
  else if(op==='gte')rows=rows.filter(r=>r[campo]>=val);
  else if(op==='lte')rows=rows.filter(r=>r[campo]<=val);
  else if(op==='is')rows=rows.filter(r=>comparar(r[campo],val));
  else if(op==='in'){const vals=val.slice(1,-1).split(',').map(x=>x.replaceAll('"',''));rows=rows.filter(r=>vals.includes(String(r[campo])));}
  else if(op==='ilike'){const busca=val.replaceAll('*','').replaceAll('%','').toLowerCase();rows=rows.filter(r=>String(r[campo]).toLowerCase().includes(busca));}
  else if(op==='not' && val==='is.null')rows=rows.filter(r=>r[campo]!=null);
  else throw Error(`Operador não implementado no QA: ${op}`);
 }
 const ou=url.searchParams.get('or');
 if(ou){ const unidade=ou.match(/unidade_id.eq.([^,)]+)/)?.[1],org=ou.match(/organizacao_id.eq.([^,)]+)/)?.[1]; if(!unidade)throw Error('OR não previsto'); rows=rows.filter(r=>r.unidade_id===unidade || (r.unidade_id==null&&(r.organizacao_id==null||r.organizacao_id===org))); }
 const order=url.searchParams.get('order'); if(order){const cols=order.split(',');rows.sort((a,b)=>{for(const col of cols){const[c,d]=col.split('.'); const cmp=String(a[c]??'').localeCompare(String(b[c]??''));if(cmp)return d==='desc'?-cmp:cmp;}return 0;});}
 const total=rows.length,offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??total);rows=rows.slice(offset,offset+limit);
 const single=new Headers(opts.headers).get('accept')?.includes('vnd.pgrst.object');
 return new Response(JSON.stringify(single?rows[0]??null:rows),{status:200,headers:{'content-type':'application/json','content-range':`${offset}-${offset+rows.length-1}/${total}`}});
}
globalThis.fetch=(input,opts={})=>{
 const url=new URL(typeof input==='string'?input:input.url??input);const method=(opts.method??'GET').toUpperCase();
 if(!['GET','HEAD'].includes(method)){escritasBloqueadas++;throw Error('QA bloqueou escrita');}
 if(url.origin!==new URL(realUrl).origin||!url.pathname.startsWith('/rest/v1/'))throw Error('QA bloqueou destino externo');
 acessos.push({modo,method,tabela:url.pathname.split('/').pop()});
 return modo==='controlado'?Promise.resolve(respostaLocal(url,opts)):originalFetch(input,{...opts,signal:AbortSignal.timeout(15000)});
};
const service=await import('../../src/modules/administrativo/administrativo.service.js');
const app=express();app.disable('x-powered-by');
app.use((req,res,next)=>{if(!['GET','HEAD'].includes(req.method))return res.status(405).json({error:'Somente leitura'});next();});
app.get('/qa/modo',(req,res)=>{if(!['real','controlado'].includes(req.query.valor))return res.status(400).end();modo=req.query.valor;res.json({modo});});
app.get('/qa/seguranca',(_q,res)=>res.json({modo,escritasBloqueadas,acessos,producaoAcessada:false}));
app.get('/api/config',(_q,res)=>res.json({supabaseUrl:'http://127.0.0.1:9',supabaseAnonKey:'sessao-local-ficticia'}));
app.get('/api/v1/administrativo/ping',(_q,res)=>res.json({data:{ok:true}}));
const route=(rota,fn)=>app.get('/api/v1/administrativo'+rota,async(req,res)=>{try{res.json({data:await fn(req)});}catch(e){console.error(e.stack);res.status(e.statusCode??500).json({error:e.message});}});
route('/visao-geral-rede',r=>service.visaoGeralRede(r.query));
route('/visao-geral',r=>service.visaoGeral(r.query));
route('/monitoramento-diario',r=>service.monitoramentoDiario(r.query));
route('/empresas',r=>service.empresas(r.query));
route('/empresas/:organizacaoId',r=>service.detalheEmpresa({...r.query,...r.params}));
route('/unidades/:unidadeId/dashboard',r=>service.detalheOperacaoUnidade({...r.query,...r.params}));
route('/unidades/:unidadeId/calendario',r=>service.calendarioUnidade({...r.query,...r.params}));
app.get('/',(_q,res)=>{
 let html=readFileSync(path.join(frontend,'index.html'),'utf8').replace(/<script[^>]*src="https:[^"]*"[^>]*><\/script>/g,'').replace('<script type="module" src="/src/app.js"></script>',`<script>window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'qa-local'}}})}})};</script><script type="module">
import {abrirPainelAdministrativo} from '/src/painelAdm.js';
import {state} from '/src/state.js';state.painelAdm={periodo:{ano:2026,mes:10,ym:'2026-10'}};
document.getElementById('boot-loading')?.remove();
await abrirPainelAdministrativo({usuario:{nome:'QA local — somente leitura',email:'qa@exemplo.invalid'},mostrarTela:()=>{document.getElementById('painel-adm-screen').hidden=false;},aoTrocarAmbiente:()=>{},aoAcessoRevogado:console.error});
const faixa=document.createElement('div');faixa.id='qa-origem';faixa.style='position:fixed;bottom:0;left:0;z-index:10000;padding:6px 16px;background:#172554;color:white;font-size:12px';faixa.textContent=${JSON.stringify(modo==='real'?'HOMOLOGAÇÃO REAL — somente leitura':'CENÁRIOS CONTROLADOS EM MEMÓRIA — sem gravações')};document.body.append(faixa);window.qaReady=true;
</script>`);
 res.type('html').send(html);
});
app.use(express.static(frontend));
app.listen(4188,'127.0.0.1',()=>console.log('QA disponível em http://127.0.0.1:4188 — GET somente; iniciar modo real'));
