import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { inventario,ambiente,aplicar,catalogo } from '../test/helpers/performance-schema-completo.js';
const saida=new URL('../../docs/performance-validacao-banco/',import.meta.url);
await mkdir(saida,{recursive:true});
const inv=await inventario();
const relatorio={somenteMemoria:true,producaoAcessada:false,inventario:inv,caminhos:[]};
for(const modo of ['incremental','consolidado']) {
  const db=await ambiente();const resultado={modo,aplicadas:[]};relatorio.caminhos.push(resultado);
  try {
    if(modo==='incremental')await aplicar(db,'schema.sql',await readFile(new URL('../../database/schema.sql',import.meta.url),'utf8'));
    else await aplicar(db,'000_base_migration.sql');
    const lista=inv.incrementais.filter(n=>modo==='incremental'||Number(n.slice(0,3))>67);
    for(const n of lista) {
      if(n.startsWith('078_')) {
        resultado.antes=await catalogo(db);
        await writeFile(new URL(`${modo}-antes.json`,saida),JSON.stringify(resultado.antes,null,2));
      }
      await aplicar(db,n);resultado.aplicadas.push(n);console.log(`${modo}: ${n} OK`);
    }
    resultado.depois=await catalogo(db);
    await writeFile(new URL(`${modo}-depois.json`,saida),JSON.stringify(resultado.depois,null,2));
    resultado.contagens=Object.fromEntries(Object.entries(resultado.depois).map(([k,v])=>[k,v.length]));
    delete resultado.antes;delete resultado.depois;resultado.ok=true;
  } catch(e) {resultado.ok=false;resultado.erro={mensagem:e.message,migration:e.migration,statement:e.statement,sqlState:e.sqlState,trecho:e.trecho};console.log(JSON.stringify(resultado.erro));}
  finally {await db.close();}
}
await writeFile(new URL('aplicacao.json',saida),JSON.stringify(relatorio,null,2));
console.log(JSON.stringify(relatorio.caminhos.map(c=>({modo:c.modo,ok:c.ok,aplicadas:c.aplicadas.length,erro:c.erro})),null,2));
if(relatorio.caminhos.some(c=>!c.ok))process.exitCode=1;
