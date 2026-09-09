// PostgreSQL WASM em memória. Nenhum endpoint, .env ou conexão externa.
// Instale PGlite fora do projeto e configure PERFORMANCE_PGLITE_PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
let PGlite;
try { ({PGlite}=createRequire(import.meta.url)(process.env.PERFORMANCE_PGLITE_PATH || '@electric-sql/pglite')); } catch {}
test('migration 078: PostgreSQL real em memória, FK composta, unicidade, checks, CAS, RLS e auditoria', {skip:!PGlite && 'Configure PERFORMANCE_PGLITE_PATH'}, async()=>{
  const db=new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE organizacoes(id uuid PRIMARY KEY); CREATE TABLE unidades(id uuid PRIMARY KEY, organizacao_id uuid REFERENCES organizacoes);
      CREATE TABLE perfis(id uuid PRIMARY KEY);
      INSERT INTO organizacoes VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      INSERT INTO unidades VALUES ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      INSERT INTO perfis VALUES ('33333333-3333-4333-8333-333333333333');`);
    await db.exec(await readFile(new URL('../../database/migrations/078_performance_mensal_complemento.sql',import.meta.url),'utf8'));
    const insert=`INSERT INTO performance_mensal_complemento(organizacao_id,unidade_id,competencia,criado_por,atualizado_por) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','2026-04-01','33333333-3333-4333-8333-333333333333','33333333-3333-4333-8333-333333333333')`;
    await db.exec(insert);
    await assert.rejects(db.exec(insert),e=>e.code==='23505');
    await assert.rejects(db.exec(insert.replace('2026-04-01','2026-05-01').replace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')),e=>e.code==='23503');
    await assert.rejects(db.exec(insert.replace('2026-04-01','2026-05-02')),e=>e.code==='23514');
    for(const sql of ["conversao_manual=101","pedidos_manual=-1","faturamento_ifood_manual='NaN'","status='fechado'"])
      await assert.rejects(db.exec(`UPDATE performance_mensal_complemento SET ${sql}`),e=>e.code==='23514');
    await assert.rejects(db.exec("UPDATE performance_mensal_complemento SET competencia='2026-05-01'"),/imutável/);
    await db.exec('UPDATE performance_mensal_complemento SET pedidos_manual=5 WHERE versao=1');
    const r=await db.query('SELECT versao,pedidos_manual,criado_por,atualizado_por FROM performance_mensal_complemento');assert.equal(r.rows[0].versao,2);assert.equal(r.rows[0].pedidos_manual,5);
    assert.equal((await db.query('UPDATE performance_mensal_complemento SET pedidos_manual=99 WHERE versao=1 RETURNING id')).rows.length,0);
    for(const role of ['anon','authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(db.exec('SELECT * FROM performance_mensal_complemento'),e=>e.code==='42501');
      await assert.rejects(db.exec(insert),e=>e.code==='42501');
      await db.exec('RESET ROLE');
    }
    await db.exec('SET ROLE service_role');assert.equal((await db.query('SELECT * FROM performance_mensal_complemento')).rows.length,1);await db.exec('RESET ROLE');
    assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE relname='performance_mensal_complemento'")).rows[0].relrowsecurity,true);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename='performance_mensal_complemento'")).rows[0].n,0);
  } finally {await db.close();}
});
