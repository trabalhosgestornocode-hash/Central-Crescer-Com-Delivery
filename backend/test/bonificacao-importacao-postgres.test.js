// PostgreSQL descartável em loopback. Não lê .env nem aceita URL de servidor remoto.
// BM_IMPORT_PG_TEST=1 node --test test/bonificacao-importacao-postgres.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
// Postgres DESCARTÁVEL. Aceita BM_IMPORT_PG_URL (postgres://user:pass@host:port/db)
// — nunca produção — ou, sem ela, o cluster loopback :55476 do autor. Também
// habilitado por BM_IMPORT_PG_TEST=1 (compat).
const PG_URL=process.env.BM_IMPORT_PG_URL||'';
const enabled=process.env.BM_IMPORT_PG_TEST==='1'||!!PG_URL;
const db=`bm_import_076_${process.pid}`;
const bin=process.platform==='win32'?'C:/Program Files/PostgreSQL/17/bin/psql.exe':'psql';
const U=PG_URL?new URL(PG_URL):null;
const host=U?.hostname||'127.0.0.1', port=U?.port||'55476', user=U?.username||'postgres', pass=U?U.password:'';
const baseArgs=['-X','-h',host,'-p',port,'-U',user,'-v','ON_ERROR_STOP=1','-At'];
const args=(database=db)=>[...(pass?[]:['-w']),...baseArgs,'-d',database];
function sql(text,database=db){const file=join(tmpdir(),`bm076-${randomUUID()}.sql`);writeFileSync(file,text);try{return execFileSync(bin,[...args(database),'-f',file],{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe'],env:pass?{...process.env,PGPASSWORD:pass}:process.env}).trim();}finally{unlinkSync(file);}}
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const org=id(1),unit=id(11),unit2=id(12),org2=id(2),unit3=id(13);
function documento(n,d,hash=String(n).padStart(64,'0'),extra=''){
 return `insert into bonificacao_importacoes(id,organizacao_id,unidade_id,tipo_relatorio,data_lancamento,status,hash_arquivo,periodo_inicio,periodo_fim,periodo_fonte${extra?',substituiu_importacao_id':''}) values('${id(n)}','${org}','${unit}','loja','${d}','concluida','${hash}','${d}','${d}','confirmacao_usuario'${extra?`, '${extra}'`:''});`;
}
function lancar(n,d,imp,un=unit,organization=org){return `insert into bonificacao_lancamentos_diarios(id,organizacao_id,unidade_id,data,importacao_loja_id,qtd_adicionais_loja,usuario_nome) values('${id(n)}','${organization}','${un}','${d}','${id(imp)}',36,'Operador de teste');`;}
before(()=>{
 if(!enabled)return;
 sql(`create database ${db} template template0;`,'postgres');
 sql(`create table unidades(id uuid primary key,organizacao_id uuid);
 create table bonificacao_importacoes(id uuid primary key default gen_random_uuid(),organizacao_id uuid,unidade_id uuid,tipo_relatorio text,data_lancamento date,status text,hash_arquivo text,substituiu_importacao_id uuid,usuario_id uuid,usuario_nome text,arquivo_storage text);
 create unique index uq_bimp_hash on bonificacao_importacoes(unidade_id,tipo_relatorio,hash_arquivo) where hash_arquivo is not null and status='concluida';
 create table bonificacao_lancamentos_diarios(id uuid primary key default gen_random_uuid(),organizacao_id uuid,unidade_id uuid,data date,importacao_loja_id uuid references bonificacao_importacoes,importacao_geral_id uuid references bonificacao_importacoes,qtd_adicionais_loja int,usuario_id uuid,usuario_nome text,unique(unidade_id,data));
 create table plataforma_auditoria(id uuid primary key default gen_random_uuid(),ator_id uuid,ator_tipo text,acao text,entidade text,entidade_id text,organizacao_id uuid,detalhes jsonb);
 insert into unidades values('${unit}','${org}'),('${unit2}','${org}'),('${unit3}','${org2}');
 -- Anomalia legada preservada, para comprovar que a migration não corrige dados.
 insert into bonificacao_importacoes(id,organizacao_id,unidade_id,tipo_relatorio,data_lancamento,status,hash_arquivo) values('${id(90)}','${org}','${unit}','loja','2026-08-03','concluida',repeat('a',64));
 insert into bonificacao_lancamentos_diarios(id,organizacao_id,unidade_id,data,importacao_loja_id) values('${id(91)}','${org}','${unit}','2026-08-03','${id(90)}'),('${id(92)}','${org}','${unit}','2026-08-04','${id(90)}');`);
 const migration=readFileSync(new URL('../../database/migrations/076_bonificacao_importacao_diaria_integridade.sql',import.meta.url),'utf8');sql(migration);sql(migration);
});
after(()=>{if(enabled)sql(`drop database ${db};`,'postgres');});
const pgtest=(name,fn)=>test(name,{skip:enabled?false:'Ative BM_IMPORT_PG_TEST=1 para cluster local descartável na porta 55476.'},fn);
pgtest('migration idempotente preserva dados legados',()=>assert.equal(sql(`select count(*) from bonificacao_lancamentos_diarios where data<'2026-09-01';`),'2'));
pgtest('A/B: 0309 em 03 e 0409 em 04 são aceitos com auditoria',()=>{
 sql(documento(103,'2026-09-03')+documento(104,'2026-09-04')+lancar(203,'2026-09-03',103)+lancar(204,'2026-09-04',104));
 assert.equal(sql(`select count(*) from plataforma_auditoria;`),'2');
});
pgtest('C/D: ID de outro dia recusado, preservando o registro anterior',()=>{
 assert.throws(()=>sql(`update bonificacao_lancamentos_diarios set importacao_loja_id='${id(104)}' where id='${id(203)}';`),/outro dia/);
 assert.equal(sql(`select importacao_loja_id from bonificacao_lancamentos_diarios where id='${id(203)}';`),id(103));
 assert.equal(sql(`select count(*) from plataforma_auditoria;`),'2');
});
pgtest('E: mesmo hash em outro dia e mesmo hash com outro tipo são recusados',()=>{
 assert.throws(()=>sql(documento(105,'2026-09-05',String(104).padStart(64,'0'))),/já foi importado/);
 assert.throws(()=>sql(documento(106,'2026-09-04',String(104).padStart(64,'0')).replace("'loja'","'geral'")),/já foi importado/);
});
pgtest('F/G: substituir no mesmo dia preserva histórico e audita reupload idêntico',()=>{
 sql(documento(107,'2026-09-03',undefined,id(103)));
 sql(`update bonificacao_lancamentos_diarios set importacao_loja_id='${id(107)}',qtd_adicionais_loja=37 where id='${id(203)}';`);
 assert.equal(sql(`select count(*) from plataforma_auditoria where detalhes->'antes'->>'importacao_loja_id'='${id(103)}' and detalhes->'depois'->>'importacao_loja_id'='${id(107)}';`),'1');
 assert.equal(sql(`select substituiu_importacao_id from bonificacao_importacoes where id='${id(107)}';`),id(103));
 sql(`update bonificacao_lancamentos_diarios set importacao_loja_id=importacao_loja_id where id='${id(203)}';`);
 assert.equal(sql(`select count(*) from plataforma_auditoria;`),'4');
});
pgtest('H: unidade, organização e tipo incompatíveis são recusados pelo banco',()=>{
 assert.throws(()=>sql(lancar(205,'2026-09-04',104,unit2)),/organiza/);
 assert.throws(()=>sql(lancar(206,'2026-09-04',104,unit3,org2)),/organiza/);
 assert.throws(()=>sql(lancar(207,'2026-09-04',104).replace('importacao_loja_id','importacao_geral_id')),/tipo/);
});
pgtest('período divergente e alteração da identidade são recusados',()=>{
 assert.throws(()=>sql(documento(108,'2026-09-06').replace("'2026-09-06','2026-09-06','confirmacao_usuario'","'2026-09-04','2026-09-04','confirmacao_usuario'")),/período/);
 assert.throws(()=>sql(`update bonificacao_importacoes set data_lancamento='2026-09-03' where id='${id(104)}';`),/imut/);
});
pgtest('falha de auditoria reverte o lançamento e seus valores',()=>{
 sql(`alter table plataforma_auditoria add constraint teste_falha check (acao <> 'bonificacao_mensal.importacao_diaria_gravada') not valid;`);
 assert.throws(()=>sql(`update bonificacao_lancamentos_diarios set importacao_loja_id=importacao_loja_id,qtd_adicionais_loja=999 where id='${id(203)}';`));
 assert.equal(sql(`select qtd_adicionais_loja from bonificacao_lancamentos_diarios where id='${id(203)}';`),'37');
 sql('alter table plataforma_auditoria drop constraint teste_falha;');
});
pgtest('concorrência: apenas um registro para o mesmo hash em datas diferentes',async()=>{
 const tasks=[109,110].map(n=>new Promise(resolve=>{
  const file=join(tmpdir(),`bm076-${randomUUID()}.sql`);
  writeFileSync(file,`begin; ${documento(n,`2026-09-${n===109?'09':'10'}`,'b'.repeat(64))} select pg_sleep(0.2); commit;`);
  execFile(bin,[...args(),'-f',file],{timeout:20000,env:pass?{...process.env,PGPASSWORD:pass}:process.env},err=>{unlinkSync(file);resolve(!err);});
 }));
 assert.equal((await Promise.all(tasks)).filter(Boolean).length,1);
 assert.equal(sql(`select count(*) from bonificacao_importacoes where hash_arquivo=repeat('b',64);`),'1');
});
