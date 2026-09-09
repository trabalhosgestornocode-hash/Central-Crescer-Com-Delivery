// Ambiente totalmente em memória. Não aceita URL de banco, não lê .env.
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
export const pastaMigrations = new URL('../../../database/migrations/',import.meta.url);
export async function inventario() {
  const arquivos = (await readdir(pastaMigrations)).filter(n => n.endsWith('.sql')).sort();
  const incrementais = arquivos.filter(n => /^\d{3}_/.test(n) && !n.startsWith('000_') && !/rollback|VERIFICACAO/i.test(n));
  const numeros = incrementais.map(n => n.slice(0,3));
  return { arquivos, incrementais, excluidos:arquivos.filter(n => !incrementais.includes(n)), duplicados:numeros.filter((n,i) => numeros.indexOf(n)!==i),
    hashes:Object.fromEntries(await Promise.all(incrementais.map(async n => [n,createHash('sha256').update(await readFile(new URL(n,pastaMigrations))).digest('hex')])))};
}
// Psql executa por statement; respeitamos transações explícitas dos arquivos.
export function statements(sql) {
  let start=0, quote=null, dollar=null, line=false, block=0;
  const out=[];
  for(let i=0;i<sql.length;i++) {
    const c=sql[i],n=sql[i+1];
    if(line){if(c==='\n')line=false;continue;}
    if(block){if(c==='/'&&n==='*'){block++;i++;}else if(c==='*'&&n==='/'){block--;i++;}continue;}
    if(dollar){if(sql.startsWith(dollar,i)){i+=dollar.length-1;dollar=null;}continue;}
    if(quote){if(c===quote){if(n===quote)i++;else quote=null;}else if(c==='\\'&&quote==="'")i++;continue;}
    if(c==='-'&&n==='-'){line=true;i++;continue;}
    if(c==='/'&&n==='*'){block++;i++;continue;}
    if(c==="'"||c==='"'){quote=c;continue;}
    if(c==='$'){const d=/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i));if(d){dollar=d[0];i+=dollar.length-1;}continue;}
    if(c===';'){out.push(sql.slice(start,i+1));start=i+1;}
  }
  if(sql.slice(start).trim())out.push(sql.slice(start));
  return out;
}
export async function ambiente() {
  const path=process.env.PERFORMANCE_PGLITE_PATH;
  if(!path)throw new Error('Defina PERFORMANCE_PGLITE_PATH. Não há fallback para banco remoto.');
  const {PGlite}=require(path);
  const {pgcrypto}=require(path+'/dist/contrib/pgcrypto.cjs');
  const db=new PGlite({extensions:{pgcrypto}});
  // Apenas dependências geridas pelo Supabase; todas as tabelas públicas vêm do SQL real.
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb,created_at timestamptz DEFAULT now());
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean DEFAULT false);
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;`);
  return db;
}
export async function aplicar(db,nome,sql) {
  const partes=statements(sql ?? await readFile(new URL(nome,pastaMigrations),'utf8'));
  for(let i=0;i<partes.length;i++){
    try {await db.exec(partes[i]);}
    catch(e){try{await db.exec('ROLLBACK');}catch{};throw Object.assign(new Error(`${nome}, statement ${i+1}: ${e.message}`),{migration:nome,statement:i+1,sqlState:e.code,trecho:partes[i].slice(-700)});}
  }
}
export async function catalogo(db) {
  const query=async q=>(await db.query(q)).rows;
  return {
    tabelas:await query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1`),
    colunas:await query(`SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`),
    constraints:await query(`SELECT c.relname AS tabela,k.conname,k.contype,pg_get_constraintdef(k.oid) AS definicao FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY 1,2`),
    indices:await query(`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`),
    policies:await query(`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname`),
    grants:await query(`SELECT table_name,grantee,privilege_type,is_grantable FROM information_schema.role_table_grants WHERE table_schema='public' ORDER BY table_name,grantee,privilege_type`),
    funcoes:await query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args,p.prosecdef,p.proacl::text AS acl,pg_get_functiondef(p.oid) AS definicao FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' ORDER BY 1,2`),
    triggers:await query(`SELECT c.relname AS tabela,t.tgname,pg_get_triggerdef(t.oid) AS definicao FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY 1,2`),
  };
}
