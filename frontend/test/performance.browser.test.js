// Browser real e fonte controlada em memória. Nunca lê credenciais/produção.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
let chromium;
try { ({chromium}=createRequire(import.meta.url)(process.env.PERFORMANCE_PLAYWRIGHT_PATH || 'playwright')); } catch {}
test('navegador: seleção, origem, salvar só complemento, fechamento e responsividade', {skip:!chromium && 'Configure PERFORMANCE_PLAYWRIGHT_PATH'}, async()=>{
  const unidade={unidadeId:'11111111-1111-4111-8111-111111111111',unidadeNome:'Centro · unidade de teste'};
  const c={unidade,competencia:'2026-08',versao:0,status:'incompleto',completudePct:83.33,faltantes:['conversao'],parcial:true,podeFechar:false,financeiroAte:'2026-08-29',avisos:['Dados ilustrativos de teste. Financeiro parcial até 29/08/2026.'],campos:[
    {chave:'faturamento',nome:'Faturamento iFood',valor:49411.54,tipo:'moeda',origem:'AUTOMÁTICO',fonte:'Financeiro iFood',status:'Disponível',editavel:false},
    {chave:'pedidos',nome:'Pedidos iFood',valor:968,tipo:'inteiro',origem:'AUTOMÁTICO',fonte:'Desempenho iFood',status:'Disponível',editavel:false},
    {chave:'conversao',nome:'Conversão em vendas',valor:null,tipo:'percentual',origem:'SEM DADOS',fonte:'Complemento mensal',status:'Pendente',editavel:true},
    {chave:'entregadoresExternos',nome:'Custo externo de entregadores (opcional)',valor:null,tipo:'moeda',origem:'SEM DADOS',fonte:'Complemento específico opcional',status:'Pendente',editavel:true},
    {chave:'ticketMedio',nome:'Ticket médio',valor:51.04,tipo:'moeda',origem:'CALCULADO',fonte:'Faturamento iFood / pedidos',status:'Disponível',editavel:false},
  ]};
  const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
  const server=createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/performance.css"><body style="margin:0;background:#faf8fa"><main id="view" style="padding:20px"></main></body>');return;}
    const path=resolve(root,'.'+pathname);if(!path.startsWith(root+sep)){res.writeHead(403).end();return;}
    try{res.setHeader('Content-Type',path.endsWith('.css')?'text/css':'text/javascript');res.end(readFileSync(path));}catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.PERFORMANCE_BROWSER_CHANNEL?{channel:process.env.PERFORMANCE_BROWSER_CHANNEL}:{})});
    const page=await browser.newPage({viewport:{width:1440,height:1100}});
    const erros=[];page.on('pageerror',e=>erros.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async ({c,unidade})=>{
      window.salvos=[];window.competencia=c;
      const api={performanceUnidades:async()=>[unidade],performance:async()=>({competencias:[]}),performanceCompetencia:async()=>window.competencia,performanceSalvar:async(id,mes,payload)=>{
        window.salvos.push({id,mes,payload});const r=structuredClone(window.competencia);r.versao++;
        for(const [chave,valor]of Object.entries(payload.campos)){const f=r.campos.find(f=>f.chave===chave);f.valor=valor;f.origem=valor==null?'SEM DADOS':'MANUAL';f.status=valor==null?'Pendente':'Disponível';if(valor!=null)r.faltantes=r.faltantes.filter(k=>k!==chave);}
        r.completudePct=r.faltantes.length?83.33:100;
        window.competencia=r;return r;
      }};
      await (await import('/src/performance.js')).renderPerformance(document.querySelector('#view'),api,'2026-08');
    },{c,unidade});
    await page.getByRole('button',{name:'Fechamento Mensal',exact:true}).click();
    await page.getByLabel('Conversão em vendas',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-campo="faturamento"]').count(),0);
    assert.equal(await page.getByRole('button',{name:'Fechar competência',exact:true}).isDisabled(),true);
    await page.getByLabel('Conversão em vendas',{exact:true}).fill('16.49');
    await page.getByRole('button',{name:'Salvar complementos'}).click();
    await page.waitForFunction(()=>window.salvos.length===1 && document.body.textContent.includes('MANUAL'));
    const payload=await page.evaluate(()=>window.salvos[0].payload);
    assert.deepEqual(payload,{versao:0,campos:{conversao:16.49},acao:'salvar'});
    assert.deepEqual(erros,[]);
    if(process.env.PERFORMANCE_SCREENSHOTS){mkdirSync(process.env.PERFORMANCE_SCREENSHOTS,{recursive:true});await page.screenshot({path:resolve(process.env.PERFORMANCE_SCREENSHOTS,'performance-fechamento-desktop.png'),fullPage:true});}
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    if(process.env.PERFORMANCE_SCREENSHOTS)await page.screenshot({path:resolve(process.env.PERFORMANCE_SCREENSHOTS,'performance-fechamento-mobile.png'),fullPage:true});
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
