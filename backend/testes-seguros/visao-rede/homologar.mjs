// Homologação real de navegador. Exige servidor local somente leitura em 4188.
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {id} from './cenarios.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const {chromium}=createRequire(import.meta.url)(path.join(root,'worker-martinbrower/node_modules/playwright'));
const fase=process.env.QA_FASE==='antes'?'antes':'final';
const out=path.join(root,'docs/homologacao-visao-rede/evidencias',fase);mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'America/Sao_Paulo'});
await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'&&route.request().method()==='GET'?route.continue():route.abort());
const page=await context.newPage();const erros=[];page.on('pageerror',e=>erros.push(e.message));
const base='http://127.0.0.1:4188';const matriz=[],comparacoes=[];
const api=async(path)=>{const r=await context.request.get(base+'/api/v1/administrativo'+path);assert.equal(r.status(),200,await r.text());return(await r.json()).data;};
const check=async(nome,origem,fn)=>{try{const detalhe=await fn();matriz.push({nome,origem,status:'PASS',detalhe});console.log('PASS',nome);}catch(e){matriz.push({nome,origem,status:'FAIL',erro:e.message});console.log('FAIL',nome,e.message);}};
const shot=async(name)=>{await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});return `evidencias/${fase}/${name}.png`;};
const abrir=async()=>{await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>window.qaReady);await page.locator('tr[data-padm-nav="unidade"]').first().waitFor();};
const selecionar=async(selector,value)=>{const response=page.waitForResponse(r=>r.url().includes('/api/v1/administrativo/visao-geral-rede?')&&r.status()===200);await page.locator(selector).selectOption(value);await response;await page.waitForLoadState('networkidle');};
const numero=s=>s.includes('%')?Number(s.replace('%','').replace(',','.').trim()):null;
const perto=(a,b)=>a==null||b==null?assert.equal(a,b):assert.ok(Math.abs(a-b)<0.011,`${a} != ${b}`);
const sitIndicador={dentro_da_meta:'em_dia',dentro_do_limite:'atencao',atencao:'critica',sem_dados:'sem_dados'};
await context.request.get(base+'/qa/modo?valor=real');await abrir();
await check('Rede com dados reais de homologação: Sem dados','homologação real',async()=>{
 const r=await api('/visao-geral-rede?mes=2026-10');assert.equal(r.unidades.length,1);assert.equal(r.unidades[0].situacaoFinanceira.chave,'sem_dados');assert.match(await page.locator('tr[data-padm-nav="unidade"]').innerText(),/Sem dados/);return {distribuicao:r.distribuicaoSituacoes,evidencia:await shot('01-homologacao-real-sem-dados')};
});
await check('Detalhe real da mesma unidade/competência','homologação real',async()=>{
 const r=await api('/visao-geral-rede?mes=2026-10');const u=r.unidades[0];await page.locator(`tr[data-padm-nav="unidade"][data-id="${u.unidadeId}"]`).click();await page.locator('#padm-unidade-indicadores').waitFor();await page.waitForLoadState('networkidle');const d=await api(`/unidades/${u.unidadeId}/dashboard?mes=2026-10`);assert.equal(d.situacaoFinanceira.chave,u.situacaoFinanceira.chave);return {indicador:d.dashboard.indicadoresRentabilidade.total_deducoes,evidencia:await shot('02-homologacao-real-detalhe')};
});
await context.request.get(base+'/qa/modo?valor=controlado');await abrir();
let rede=await api('/visao-geral-rede?mes=2026-10');
await check('Cards e distribuição: quatro estados financeiros','controlado',async()=>{
 assert.deepEqual(rede.distribuicaoSituacoes,{sem_dados:1,em_dia:4,atencao:4,critica:2});
 assert.equal(rede.rede.unidadesEmAtencao,4);assert.equal(rede.rede.unidadesCriticas,2);
 const text=await page.locator('.padm-rede-graficos').innerText();assert.match(text,/4\s*em dia/);assert.match(text,/4\s*em atenção/);assert.match(text,/2\s*críticas/);assert.match(text,/1\s*sem dados/);
 return {distribuicao:rede.distribuicaoSituacoes,evidencia:await shot('03-rede-completa')};
});
await check('Rankings, ordenação e badges','controlado',async()=>{
 const ordem={em_dia:0,atencao:1,critica:2};
 for(const bloco of Object.values(rede.rankingPorModalidade)){
  assert.ok(bloco.melhores.every((u,i,a)=>!i||ordem[a[i-1].situacaoFinanceira.chave]<=ordem[u.situacaoFinanceira.chave]));
  for(const u of [...bloco.melhores,...bloco.atencao]){const chips=await page.locator(`li.padm-rank[data-id="${u.unidadeId}"] .padm-chip`).allTextContents();assert.ok(chips.length>0);assert.ok(chips.every(c=>c===u.situacaoFinanceira.rotulo));}
 }
 return {evidencia:await shot('04-rankings')};
});
await check('Mudança de modalidade tem identificação e ranking próprios','controlado',async()=>{
 const row=page.locator(`tr[data-padm-nav="unidade"][data-id="${id(25)}"]`);assert.match(await row.innerText(),/Misto/);
 assert.ok(rede.rankingPorModalidade.misto?.melhores.some(u=>u.unidadeId===id(25)));
 assert.ok(await page.locator(`li.padm-rank[data-id="${id(25)}"]`).count());return {evidencia:await shot('05-ranking-misto')};
});
for(const chave of ['em_dia','atencao','critica','sem_dados'])await check(`Filtro financeiro ${chave}`,'controlado',async()=>{
 await selecionar('[data-vr-filtro="situacao"]',chave);
 const filtrado=await api('/visao-geral-rede?mes=2026-10&situacao='+chave);assert.ok(filtrado.unidades.length);assert.ok(filtrado.unidades.every(u=>u.situacaoFinanceira.chave===chave));
 assert.equal(await page.locator('tr[data-padm-nav="unidade"]').count(),filtrado.unidades.length);
 for(const chip of await page.locator('tr[data-padm-nav="unidade"] .padm-chip').allTextContents())assert.equal(chip,filtrado.unidades[0].situacaoFinanceira.rotulo);
 assert.deepEqual(filtrado.distribuicaoSituacoes,rede.distribuicaoSituacoes);
 const evidence=await shot('06-filtro-'+chave);await selecionar('[data-vr-filtro="situacao"]','');return {quantidade:filtrado.unidades.length,evidencia:evidence};
});
await check('Filtros por empresa, unidade e modalidade','controlado',async()=>{
 await selecionar('[data-vr-filtro="organizacaoId"]',id(1));assert.equal(await page.locator('tr[data-padm-nav="unidade"]').count(),6);
 await selecionar('[data-vr-filtro="unidadeId"]',id(15));assert.equal(await page.locator('tr[data-padm-nav="unidade"]').count(),1);
 await selecionar('[data-vr-filtro="organizacaoId"]','');await selecionar('[data-vr-filtro="modalidade"]','full_service');assert.equal(await page.locator('tr[data-padm-nav="unidade"]').count(),4);
 const evidencia=await shot('07-filtro-modalidade');await selecionar('[data-vr-filtro="modalidade"]','');return {evidencia};
});
for(const u of rede.unidades)await check(`Comparação rede × Indicadores: ${u.nome}`,'controlado',async()=>{
 await abrir();const d=await api(`/unidades/${u.unidadeId}/dashboard?mes=2026-10`);const ind=d.dashboard.indicadoresRentabilidade.total_deducoes;
 await page.locator(`tr[data-padm-nav="unidade"][data-id="${u.unidadeId}"]`).click();await page.locator('#padm-unidade-indicadores table').waitFor();
 const row=page.locator('#padm-unidade-indicadores tbody tr').filter({hasText:'Total de deduções'}).first();
 const cells=await row.locator('td').allTextContents();
 comparacoes.push({unidade:u.nome,competencia:'2026-10',modelo:u.modeloLogistico,percentualRede:u.totalDeducoesIndicadorPct,percentualIndicador:ind.atual,metaRede:u.meta,metaIndicador:{metaIdeal:ind.metaIdeal,limite:ind.limite},statusRede:u.situacaoFinanceira.chave,statusIndicador:ind.status.chave,linhaVisivel:cells});
 const evidencia=await shot('08-unidade-'+u.unidadeId.slice(-2));
 perto(u.totalDeducoesIndicadorPct,ind.atual);perto(u.meta?.metaIdeal,ind.metaIdeal);perto(u.meta?.limite,ind.limite);
 assert.equal(u.situacaoFinanceira.chave,sitIndicador[ind.status.chave]);assert.equal(d.situacaoFinanceira.chave,u.situacaoFinanceira.chave);
 perto(numero(cells[1]),ind.atual);perto(numero(cells[2]),ind.metaIdeal);perto(numero(cells[3]),ind.limite);
 assert.equal(cells[5].trim(),ind.status.label);assert.match(await page.locator('#padm-view').innerText(),new RegExp(`Classificação financeira da unidade: ${u.situacaoFinanceira.rotulo}`));return {indicador:ind,evidencia};
});
await abrir();
await check('Empresa com múltiplas unidades usa pior classificação financeira','controlado',async()=>{
 for(const e of rede.empresas){const units=rede.unidades.filter(u=>u.organizacaoId===e.organizacaoId&&u.modeloLogistico===e.modeloLogistico);const ordem={sem_dados:0,em_dia:1,atencao:2,critica:3};const worst=units.reduce((a,b)=>ordem[a.situacaoFinanceira.chave]>ordem[b.situacaoFinanceira.chave]?a:b);assert.equal(e.situacaoFinanceira.chave,worst.situacaoFinanceira.chave);}
 await page.locator(`tr[data-padm-nav="empresa"][data-id="${id(1)}"]`).first().click();await page.waitForLoadState('networkidle');
 const fin=await api(`/empresas/${id(1)}?mes=2026-10`);assert.equal(fin.financeiro.unidades.length,6);assert.match(await page.locator('#padm-view').innerText(),/Situação financeira baseada em Total de deduções/);return {empresas:rede.empresas.map(e=>({nome:e.empresaNome,modelo:e.modeloLogistico,situacao:e.situacaoFinanceira})),evidencia:await shot('09-empresa-consolidada')};
});
await abrir();
await check('Troca de mês recalcula situação e mantém competência no detalhe','controlado',async()=>{
 await selecionar('#padm-per-mes','9');const r=await api('/visao-geral-rede?mes=2026-09');const u=r.unidades.find(u=>u.unidadeId===id(11));assert.equal(u.situacaoFinanceira.chave,'critica');
 assert.match(await page.locator(`tr[data-padm-nav="unidade"][data-id="${id(11)}"]`).innerText(),/Crítica/);
 await page.locator(`tr[data-padm-nav="unidade"][data-id="${id(11)}"]`).click();await page.locator('#padm-unidade-indicadores table').waitFor();assert.match(await page.locator('#padm-view').innerText(),/Setembro 2026/);assert.match(await page.locator('#padm-view').innerText(),/Classificação financeira da unidade: Crítica/);return {evidencia:await shot('10-troca-mes-setembro')};
});
await abrir();
await check('Troca de ano recalcula os dados do período','controlado',async()=>{
 await selecionar('#padm-per-ano','2025');const r=await api('/visao-geral-rede?mes=2025-10');assert.equal(r.unidades.find(u=>u.unidadeId===id(11)).situacaoFinanceira.chave,'atencao');assert.match(await page.locator(`tr[data-padm-nav="unidade"][data-id="${id(11)}"]`).innerText(),/Atenção/);return {evidencia:await shot('11-troca-ano-2025')};
});
await abrir();
await check('Modalidade histórica: setembro Marketplace, outubro misto','controlado',async()=>{
 const set=await api('/visao-geral-rede?mes=2026-09');const u=set.unidades.find(u=>u.unidadeId===id(25));assert.equal(u.modeloLogistico,'marketplace');assert.equal(u.situacaoFinanceira.chave,'critica');assert.equal(rede.unidades.find(u=>u.unidadeId===id(25)).modeloLogistico,'misto');const d=await api(`/unidades/${id(25)}/dashboard?mes=2026-09`);assert.equal(d.dashboard.modeloLogistico,'marketplace');assert.equal(d.situacaoFinanceira.chave,'critica');return {setembro:u.meta,outubro:rede.unidades.find(u=>u.unidadeId===id(25)).meta};
});
await check('Monitoramento Dashboard iFood mantém exclusivamente critérios operacionais','controlado',async()=>{
 await page.locator('#padm-menu li[data-tela="visao-geral"]').click();await page.waitForLoadState('networkidle');const r=await api('/visao-geral?mes=2026-10');const fs=r.empresas.find(e=>e.organizacaoId===id(2));assert.ok(fs.emDiaLista.some(u=>u.unidadeId===id(23)));const mp=r.empresas.find(e=>e.organizacaoId===id(1));assert.ok(mp.pendentes.some(u=>u.unidadeId===id(11)));assert.match(await page.locator('#padm-view').innerText(),/D-1|preenchimento|conformidade/i);assert.ok(!(await page.locator('#padm-view').innerText()).includes('Situação baseada em Total de deduções'));return {financeiroCriticoOperacionalEmDia:id(23),financeiroEmDiaOperacionalPendente:id(11),evidencia:await shot('12-monitoramento-operacional')};
});
await abrir();
await check('Tabela mantém badges acessíveis ao rolar horizontalmente','controlado',async()=>{
 const wrap=page.locator('.padm-tabela-wrap').last();await wrap.evaluate(e=>e.scrollLeft=e.scrollWidth);await wrap.scrollIntoViewIfNeeded();assert.ok(await wrap.locator('tr[data-padm-nav="unidade"] .padm-chip').count()===11);return {evidencia:await shot('13-tabela-badges')};
});
await check('Layout móvel e badges','controlado',async()=>{
 await page.setViewportSize({width:390,height:844});await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>window.qaReady);const width=await page.evaluate(()=>document.documentElement.scrollWidth);assert.ok(width<=392,`Largura total ${width}`);return {largura:width,evidencia:await shot('14-mobile')};
});
await check('Sem erros JavaScript na navegação','navegador',async()=>assert.deepEqual(erros,[]));
await check('Nenhuma escrita ou acesso à produção','segurança',async()=>{const s=await(await context.request.get(base+'/qa/seguranca')).json();assert.equal(s.escritasBloqueadas,0);assert.equal(s.producaoAcessada,false);assert.ok(s.acessos.every(a=>a.method==='GET'));return {leiturasReais:s.acessos.filter(a=>a.modo==='real').length,leiturasEmMemoria:s.acessos.filter(a=>a.modo==='controlado').length,escritas:0};});
const result={fase,data:'2026-11-05',navegador:await browser.version(),total:matriz.length,pass:matriz.filter(x=>x.status==='PASS').length,fail:matriz.filter(x=>x.status==='FAIL').length,matriz,comparacoes};
writeFileSync(path.join(out,'matriz.json'),JSON.stringify(result,null,2));await browser.close();console.log(JSON.stringify({total:result.total,pass:result.pass,fail:result.fail}));process.exitCode=result.fail?1:0;
