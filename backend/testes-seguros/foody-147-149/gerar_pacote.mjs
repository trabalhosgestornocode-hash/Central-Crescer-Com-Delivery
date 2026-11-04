// Gera o KIT de implantação da camada Foody (147 → 148 → 149) a partir dos PRÓPRIOS arquivos de database/migrations.
//
//   node backend/testes-seguros/foody-147-149/gerar_pacote.mjs <pasta-de-saída>
//
// Saída (mesmo commit = mesmos bytes; sem data no conteúdo):
//   pacote_aplicar.sql    UMA transação: travas (histórico por NOME EXATO, nenhum objeto foody existente, dependências) →
//                         147 + 148 + 149 (sem os begin/commit de cada arquivo) → registro em supabase_migrations.schema_migrations
//                         → autoverificação (objetos, RLS, privilégios). Qualquer falha = nada entra.
//   pacote_recuperar.sql  UMA transação, SÓ com -v assinatura=<valor da pós-verificação>: confere histórico, objetos, tabelas
//                         VAZIAS e a assinatura estrutural; só então remove a camada (147_rollback) e o registro. Senão recusa.
//   prevoo.sql · diagnostico.sql · posverificacao.sql   SOMENTE LEITURA (um JSON cada).
// Este script só LÊ arquivos e escreve na pasta indicada; não fala com nenhum banco.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./sql_comum.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATIONS = resolve(RAIZ, "database/migrations");
const TAG = "$foody_registro$";

export const ler = (nome) => readFileSync(resolve(MIGRATIONS, nome), "utf8").replace(/\r\n/g, "\n");
const sha256 = (t) => createHash("sha256").update(t).digest("hex");

function semTransacao(nome) {
  const linhas = ler(nome).split("\n");
  const n = linhas.filter((l) => /^\s*(begin|commit)\s*;\s*$/i.test(l)).length;
  if (n !== 2) throw new Error(`${nome}: esperava exatamente 1 begin; e 1 commit; (achei ${n})`);
  return `-- ===== ${nome} =====\n` + linhas.filter((l) => !/^\s*(begin|commit)\s*;\s*$/i.test(l)).join("\n");
}

const CABECALHO = (titulo) => `-- ${titulo} — camada Foody 147/148/149. GERADO por backend/testes-seguros/foody-147-149/gerar_pacote.mjs; não edite à mão.
-- Rode SOMENTE pelo implantar.mjs (travas de alvo, SHA-256, pré-voo e evidências). psql -X -v ON_ERROR_STOP=1 -f <arquivo>.
`;

const TRAVA_APLICAR = `-- ===== travas (nada foi alterado até aqui; qualquer exceção desfaz a transação inteira) =====
do $trava$
declare n int; objs text;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception 'PACOTE_FOODY: SEM_HISTORICO — supabase_migrations.schema_migrations ausente; nada foi aplicado' using errcode = '55000';
  end if;
  select count(*) into n from supabase_migrations.schema_migrations where name in (${C.SQL_NOMES});
  if n > 0 then
    raise exception 'PACOTE_FOODY: JA_REGISTRADA — % de 3 migrations Foody já estão no histórico; nada foi aplicado (rode o diagnóstico)', n using errcode = '55000';
  end if;
  select string_agg(o, ', ' order by o) into objs from ${C.SQL_OBJETOS_FOODY} z(o);
  if objs is not null then
    raise exception 'PACOTE_FOODY: OBJETO_EXISTENTE — estado parcial/divergente (%); nada foi aplicado. NÃO reaplique: rode o diagnóstico', left(objs, 300) using errcode = '55000';
  end if;
  if to_regclass('public.organizacoes') is null or to_regclass('public.unidades') is null or to_regclass('public.usuarios_organizacoes') is null
     or not exists (select 1 from pg_roles where rolname = 'service_role')
     or to_regprocedure('public.remapear_organizacao_em_tabelas_de_unidade(uuid, uuid, uuid)') is null then
    raise exception 'PACOTE_FOODY: DEPENDENCIA_AUSENTE — organizacoes/unidades/usuarios_organizacoes/service_role/remapear; nada foi aplicado' using errcode = '55000';
  end if;
end $trava$;
set local lock_timeout = '5s';
set local statement_timeout = '120s';`;

function registro() {
  const valores = C.ARQUIVOS.map((f, i) => {
    const sql = ler(f);
    if (sql.includes(TAG)) throw new Error(`${f}: contém ${TAG}`);
    return `  (to_char((now() at time zone 'utc') + make_interval(secs => ${i}), 'YYYYMMDDHH24MISS'), '${C.NOMES[i]}', array[${TAG}${sql}${TAG}], 'pacote-foody-147-149')`;
  });
  return `-- ===== registro no histórico (mesma transação; statements = conteúdo ORIGINAL de cada arquivo) =====
insert into supabase_migrations.schema_migrations (version, name, statements, created_by) values
${valores.join(",\n")};`;
}

const AUTOVERIFICACAO = `-- ===== autoverificação (ainda dentro da transação: qualquer divergência desfaz tudo) =====
do $auto$
declare falhas text[] := '{}'; t text; f record; n int;
begin
  foreach t in array array[${C.SQL_TABELAS}] loop
    if to_regclass('public.' || t) is null then falhas := falhas || ('tabela ausente ' || t);
    else
      if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then falhas := falhas || ('RLS desligado ' || t); end if;
      if has_table_privilege('anon', 'public.' || t, 'select,insert,update,delete') or has_table_privilege('authenticated', 'public.' || t, 'select,insert,update,delete') then
        falhas := falhas || ('anon/authenticated com acesso a ' || t); end if;
      if has_table_privilege('service_role', 'public.' || t, 'delete') then falhas := falhas || ('service_role com DELETE em ' || t); end if;
    end if;
  end loop;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename like 'foody\\_%';
  if n > 0 then falhas := falhas || ('policies em foody_*: ' || n); end if;
  for f in select p.oid, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like 'foody\\_%' loop
    if has_function_privilege('anon', f.oid, 'execute') or has_function_privilege('authenticated', f.oid, 'execute') then
      falhas := falhas || ('anon/authenticated executa ' || f.proname); end if;
  end loop;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname in (${C.SQL_FUNCOES});
  if n <> ${C.FUNCOES.length} then falhas := falhas || ('funções foody: ' || n || ' (esperado ${C.FUNCOES.length})'); end if;
  select count(*) into n from supabase_migrations.schema_migrations where name in (${C.SQL_NOMES});
  if n <> 3 then falhas := falhas || ('registros no histórico: ' || n); end if;
  if array_length(falhas, 1) > 0 then
    raise exception 'PACOTE_FOODY: AUTOVERIFICACAO — %; nada foi aplicado', array_to_string(falhas, '; ') using errcode = '55000';
  end if;
end $auto$;`;

const TRAVA_RECUPERAR = `-- ===== travas da RECUPERAÇÃO: só remove o que esta aplicação criou, vazio e idêntico ao verificado =====
-- Exige psql -v assinatura=<assinatura da pós-verificação>. Sem a variável o psql não substitui e o comando falha (fail-closed).
select set_config('foody_recuperacao.assinatura', :'assinatura', true);
do $trava$
declare n int; total bigint; t text; atual text; esperada text := current_setting('foody_recuperacao.assinatura', true);
begin
  select count(*) into n from supabase_migrations.schema_migrations where name in (${C.SQL_NOMES});
  if n <> 3 then raise exception 'RECUPERACAO_FOODY: HISTORICO_DIVERGENTE — % de 3 registros; nada foi removido (análise manual)', n using errcode = '55000'; end if;
  foreach t in array array[${C.SQL_TABELAS}] loop
    if to_regclass('public.' || t) is null then raise exception 'RECUPERACAO_FOODY: ESTADO_PARCIAL — tabela % ausente; nada foi removido', t using errcode = '55000'; end if;
  end loop;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like '%foody%';
  if n <> ${C.FUNCOES.length} then raise exception 'RECUPERACAO_FOODY: ESTADO_PARCIAL — % funções foody (esperado ${C.FUNCOES.length}); nada foi removido', n using errcode = '55000'; end if;
  total := 0;
  foreach t in array array[${C.SQL_TABELAS}] loop
    execute format('select count(*) from public.%I', t) into n; total := total + n;
  end loop;
  if total > 0 then
    raise exception 'RECUPERACAO_FOODY: COM_DADOS — % linha(s) nas tabelas foody_*; nada foi removido. Exporte e decida (recuperação manual)', total using errcode = '55000';
  end if;
  atual := ${C.SQL_ASSINATURA_FOODY};
  if esperada is null or esperada !~ '^[0-9a-f]{32}$' or atual is distinct from esperada then
    raise exception 'RECUPERACAO_FOODY: ASSINATURA_DIVERGENTE — estrutura atual % ≠ verificada %; nada foi removido', atual, coalesce(esperada, '(vazia)') using errcode = '55000';
  end if;
end $trava$;
set local lock_timeout = '5s';
set local statement_timeout = '120s';`;

const FIM_RECUPERAR = `-- ===== remove o registro e confere que nada do escopo Foody ficou =====
delete from supabase_migrations.schema_migrations where name in (${C.SQL_NOMES});
do $fim$
declare objs text;
begin
  select string_agg(o, ', ' order by o) into objs from ${C.SQL_OBJETOS_FOODY} z(o);
  if objs is not null then raise exception 'RECUPERACAO_FOODY: SOBRA — %; nada foi removido', left(objs, 300) using errcode = '55000'; end if;
end $fim$;`;

const PREVOO = `${CABECALHO("PRÉ-VOO (SOMENTE LEITURA)")}select jsonb_pretty(jsonb_build_object(
  'identidade', jsonb_build_object('db', current_database(), 'usuario', current_user, 'versao', current_setting('server_version'), 'agora_utc', now() at time zone 'utc',
     'replica', pg_is_in_recovery(), 'somente_leitura', current_setting('transaction_read_only'), 'tamanho_banco', pg_size_pretty(pg_database_size(current_database()))),
  'historico', jsonb_build_object('existe', to_regclass('supabase_migrations.schema_migrations') is not null,
     'registradas', (select count(*) from supabase_migrations.schema_migrations),
     'ultimas', (select jsonb_agg(n order by v desc) from (select version v, name n from supabase_migrations.schema_migrations order by version desc limit 6) x),
     'foody_registradas', (select coalesce(jsonb_agg(name order by name), '[]') from supabase_migrations.schema_migrations where name in (${C.SQL_NOMES})),
     'numeros_147_149_ocupados', (select coalesce(jsonb_agg(name order by name), '[]') from supabase_migrations.schema_migrations where name ~ '^14[7-9]_'),
     'termo_v3_registrado', (select count(*) from supabase_migrations.schema_migrations where name = '${C.REGISTRO_TERMO_V3}')),
  'objetos_foody', (select coalesce(jsonb_agg(o order by o), '[]') from ${C.SQL_OBJETOS_FOODY} z(o)),
  'dependencias', jsonb_build_object(
     'tabelas', (select jsonb_object_agg(t, to_regclass('public.' || t) is not null) from unnest(array['organizacoes', 'unidades', 'usuarios_organizacoes']) t),
     'colunas_usuarios_organizacoes', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'usuarios_organizacoes' and column_name in ('perfil_id', 'organizacao_id', 'papel', 'ativo')),
     'papeis', (select jsonb_object_agg(r, exists (select 1 from pg_roles where rolname = r)) from unnest(array['service_role', 'anon', 'authenticated']) r),
     'gen_random_uuid', to_regprocedure('gen_random_uuid()') is not null,
     'hashtextextended', to_regprocedure('hashtextextended(text, bigint)') is not null,
     'remapear_md5', (select md5(pg_get_functiondef(p.oid)) from pg_proc p where p.oid = to_regprocedure('public.remapear_organizacao_em_tabelas_de_unidade(uuid, uuid, uuid)')),
     'remapear_descobre_por_colunas', (select pg_get_functiondef(p.oid) ~ 'information_schema\\.columns' and pg_get_functiondef(p.oid) ~ '''unidade_id''' and pg_get_functiondef(p.oid) !~ 'foody'
                                         from pg_proc p where p.oid = to_regprocedure('public.remapear_organizacao_em_tabelas_de_unidade(uuid, uuid, uuid)'))),
  'unidades_piloto', (select jsonb_object_agg(k, (select jsonb_build_object('existe', true, 'organizacao_id', u.organizacao_id, 'ativa', u.ativo) from unidades u where u.id = v::uuid))
                        from (values ('subway_saci', '00000000-0000-0000-0000-0000000000a1'), ('acai_no_grau_saci', '4d3b75bd-79b5-4335-ae5b-a183580c3555')) x(k, v)),
  'concorrencia', jsonb_build_object(
     'locks_aguardando', (select count(*) from pg_locks l where not l.granted and l.database = (select oid from pg_database where datname = current_database())),
     'locks_fortes_unidades_organizacoes', (select count(*) from pg_locks l where l.pid <> pg_backend_pid() and l.database = (select oid from pg_database where datname = current_database())
                                              and l.relation in (to_regclass('public.unidades'), to_regclass('public.organizacoes')) and l.mode not in ('AccessShareLock')),
     'idle_in_transaction', (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()),
     'transacao_mais_longa_s', (select coalesce(max(extract(epoch from now() - xact_start))::int, 0) from pg_stat_activity where datname = current_database() and xact_start is not null
                                  and pid <> pg_backend_pid() and backend_type = 'client backend')),
  'arquivamento_wal', (select jsonb_build_object('modo', current_setting('archive_mode'), 'arquivados', archived_count, 'falhas', failed_count,
     'segundos_desde_ultimo', extract(epoch from now() - last_archived_time)::int, 'ultima_falha_depois_do_ultimo_ok', coalesce(last_failed_time > last_archived_time, false)) from pg_stat_archiver),
  'impressao_fora_do_escopo', ${C.SQL_IMPRESSAO_FORA}
));
`;

const DIAGNOSTICO = `${CABECALHO("DIAGNÓSTICO DO ESTADO REAL (SOMENTE LEITURA)")}with r as (select coalesce(jsonb_agg(name order by name), '[]') nomes, count(*) n from supabase_migrations.schema_migrations where name in (${C.SQL_NOMES})),
     o as (select coalesce(jsonb_agg(x order by x), '[]') lista, count(*) n from ${C.SQL_OBJETOS_FOODY} z(x)),
     tb as (select count(*) n from unnest(array[${C.SQL_TABELAS}]) t where to_regclass('public.' || t) is not null),
     tbx as (select count(*) n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r' and c.relname like '%foody%'),
     fn as (select count(*) filter (where p.proname in (${C.SQL_FUNCOES})) esperadas, count(*) todas from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like '%foody%'),
     ct as (select ${C.SQL_CONTAGENS} c),
     tot as (select coalesce(sum(v::bigint), 0) n from ct, jsonb_each_text(coalesce(ct.c, '{}')) e(k, v)),
     est as (select case
       when o.n = 0 and r.n = 0 then 'AUSENTE'
       when r.n = 3 and tb.n = ${C.TABELAS.length} and tbx.n = ${C.TABELAS.length} and fn.esperadas = ${C.FUNCOES.length} and fn.todas = ${C.FUNCOES.length}
         then case when tot.n = 0 then 'COMPLETO_VAZIO' else 'COMPLETO_COM_DADOS' end
       else 'PARCIAL' end e from r, o, tb, tbx, fn, tot)
select jsonb_pretty(jsonb_build_object(
  'estado', est.e,
  'acao', case est.e
     when 'AUSENTE' then 'Pode aplicar o pacote (depois do pré-voo).'
     when 'COMPLETO_VAZIO' then 'Instalado e vazio. Recuperação pelo pacote só com a assinatura da pós-verificação.'
     when 'COMPLETO_COM_DADOS' then 'Instalado COM dados: NÃO há recuperação automática. Exportar, revogar conexões e decidir manualmente.'
     else 'Estado PARCIAL/DIVERGENTE: PARAR. Não reaplicar nem rodar rollback às cegas; análise manual com este diagnóstico.' end,
  'registros', r.nomes, 'objetos', o.lista, 'tabelas_esperadas_presentes', tb.n, 'tabelas_foody_total', tbx.n,
  'funcoes_esperadas_presentes', fn.esperadas, 'funcoes_foody_total', fn.todas, 'linhas', coalesce(ct.c, '{}'), 'linhas_total', tot.n,
  'assinatura', case when tb.n > 0 then ${C.SQL_ASSINATURA_FOODY} end,
  'termo_v3_registrado', (select count(*) from supabase_migrations.schema_migrations where name = '${C.REGISTRO_TERMO_V3}')
)) from est, r, o, tb, tbx, fn, ct, tot;
`;

const privEsperado = Object.entries(C.PRIVILEGIOS_SERVICE_ROLE).map(([t, p]) => `('${t}', '${p}')`).join(", ");
const colunasEsperadas = Object.entries(C.UPDATE_DE_COLUNA).flatMap(([t, cs]) => cs.map((c) => `('${t}', '${c}')`)).join(", ");
const POSVERIFICACAO = `${CABECALHO("PÓS-VERIFICAÇÃO (SOMENTE LEITURA)")}with tab(t) as (select unnest(array[${C.SQL_TABELAS}])),
     priv(t, p) as (values ${privEsperado}),
     col(t, c) as (values ${colunasEsperadas}),
     fn as (select p.oid, p.proname, p.prosecdef from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like 'foody\\_%')
select jsonb_pretty(jsonb_build_object(
  'tabelas', jsonb_build_object('ok', (select count(*) from tab where to_regclass('public.' || t) is not null) = ${C.TABELAS.length},
     'ausentes', (select coalesce(jsonb_agg(t), '[]') from tab where to_regclass('public.' || t) is null)),
  'rls', jsonb_build_object('ok', not exists (select 1 from tab join pg_class c on c.oid = to_regclass('public.' || t) where not c.relrowsecurity),
     'policies', (select count(*) from pg_policies where schemaname = 'public' and tablename like 'foody\\_%')),
  'anon_authenticated', jsonb_build_object(
     'tabelas_com_acesso', (select coalesce(jsonb_agg(r || ':' || t), '[]') from tab, unnest(array['anon', 'authenticated']) r
                             where to_regclass('public.' || t) is not null and has_table_privilege(r, 'public.' || t, 'select,insert,update,delete,truncate,references,trigger')),
     'colunas_com_acesso', (select count(*) from tab join pg_attribute a on a.attrelid = to_regclass('public.' || t) and a.attnum > 0 and not a.attisdropped, unnest(array['anon', 'authenticated']) r
                             where has_column_privilege(r, to_regclass('public.' || t), a.attnum, 'select,insert,update,references')),
     'funcoes_executaveis', (select coalesce(jsonb_agg(r || ':' || proname), '[]') from fn, unnest(array['anon', 'authenticated']) r where has_function_privilege(r, fn.oid, 'execute')),
     'public_executa', (select coalesce(jsonb_agg(proname), '[]') from fn where exists (select 1 from aclexplode(coalesce((select proacl from pg_proc where oid = fn.oid), acldefault('f', (select proowner from pg_proc where oid = fn.oid)))) a where a.grantee = 0))),
  'service_role', jsonb_build_object(
     'privilegios_divergentes', (select coalesce(jsonb_agg(priv.t || ':' || priv.p || '≠' || atual), '[]') from priv, lateral (select
         (case when has_table_privilege('service_role', 'public.' || priv.t, 'select') then 'S' else '' end) || (case when has_table_privilege('service_role', 'public.' || priv.t, 'insert') then 'I' else '' end)
         || (case when has_table_privilege('service_role', 'public.' || priv.t, 'update') then 'U' else '' end) || (case when has_table_privilege('service_role', 'public.' || priv.t, 'delete') then 'D' else '' end)
         || (case when has_table_privilege('service_role', 'public.' || priv.t, 'truncate') then 'T' else '' end) atual) z where to_regclass('public.' || priv.t) is not null and atual <> priv.p),
     'update_de_coluna_faltando', (select coalesce(jsonb_agg(col.t || '.' || col.c), '[]') from col where to_regclass('public.' || col.t) is not null and not has_column_privilege('service_role', 'public.' || col.t, col.c, 'update')),
     'executa', (select coalesce(jsonb_agg(proname order by proname), '[]') from fn where has_function_privilege('service_role', fn.oid, 'execute') and proname in (${C.FUNCOES_SERVICE_ROLE.map((f) => `'${f}'`).join(", ")}))),
  'security_definer', (select coalesce(jsonb_agg(proname order by proname), '[]') from fn where prosecdef),
  'multi_tenant', jsonb_build_object(
     'tabelas_sem_gatilho_de_tenant', (select coalesce(jsonb_agg(t), '[]') from tab where to_regclass('public.' || t) is not null and not exists (
         select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || t) and g.tgfoid = to_regprocedure('public.foody_validar_tenant()') and g.tgdeferrable and g.tginitdeferred)),
     'tabelas_fora_do_remapeamento', (select coalesce(jsonb_agg(t), '[]') from tab where not (
         exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'organizacao_id')
         and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'unidade_id'))),
     'remapear_descobre_por_colunas', (select pg_get_functiondef(p.oid) ~ 'information_schema\\.columns' and pg_get_functiondef(p.oid) !~ 'foody'
         from pg_proc p where p.oid = to_regprocedure('public.remapear_organizacao_em_tabelas_de_unidade(uuid, uuid, uuid)'))),
  'integridade', jsonb_build_object(
     'fks_para_unidades', (select count(*) from pg_constraint x join pg_class c on c.oid = x.conrelid where x.contype = 'f' and c.relname like 'foody\\_%' and x.confrelid = 'public.unidades'::regclass),
     'fks_para_organizacoes', (select count(*) from pg_constraint x join pg_class c on c.oid = x.conrelid where x.contype = 'f' and c.relname like 'foody\\_%' and x.confrelid = 'public.organizacoes'::regclass),
     'restricoes_invalidas', (select count(*) from pg_constraint x join pg_class c on c.oid = x.conrelid where c.relname like 'foody\\_%' and not x.convalidated),
     'gatilhos_desligados', (select count(*) from pg_trigger g join pg_class c on c.oid = g.tgrelid where c.relname like 'foody\\_%' and not g.tgisinternal and g.tgenabled = 'D'),
     'linhas', ${C.SQL_CONTAGENS}),
  'historico', jsonb_build_object(
     'registros', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'version', version, 'md5', md5(statements[1])) order by name), '[]') from supabase_migrations.schema_migrations where name in (${C.SQL_NOMES})),
     'termo_v3_registrado', (select count(*) from supabase_migrations.schema_migrations where name = '${C.REGISTRO_TERMO_V3}')),
  'assinatura', ${C.SQL_ASSINATURA_FOODY},
  'impressao_fora_do_escopo', ${C.SQL_IMPRESSAO_FORA}
));
`;

export function gerarPacote() {
  const aplicar = `${CABECALHO("APLICAR 147 → 148 → 149 (UMA transação)")}\nbegin;\n\n${TRAVA_APLICAR}\n\n${C.ARQUIVOS.map(semTransacao).join("\n")}\n\n${registro()}\n\n${AUTOVERIFICACAO}\n\ncommit;\n`;
  const recuperar = `${CABECALHO("RECUPERAR (remover a camada recém-instalada, VAZIA e verificada)")}\nbegin;\n\n${TRAVA_RECUPERAR}\n\n${semTransacao(C.ROLLBACK_CAMADA)}\n\n${FIM_RECUPERAR}\n\ncommit;\n`;
  const arquivos = { "pacote_aplicar.sql": aplicar, "pacote_recuperar.sql": recuperar, "prevoo.sql": PREVOO, "diagnostico.sql": DIAGNOSTICO, "posverificacao.sql": POSVERIFICACAO };
  for (const [nome, t] of Object.entries(arquivos)) if (t.includes("\r")) throw new Error(`${nome}: contém \\r`);
  const sha = Object.fromEntries(Object.entries(arquivos).map(([n, t]) => [n, sha256(t)]));
  const md5Arquivos = Object.fromEntries(C.ARQUIVOS.map((f) => [f.replace(/\.sql$/, ""), createHash("md5").update(ler(f)).digest("hex")]));
  return { arquivos, sha, md5Arquivos };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const saida = resolve(process.argv[2] ?? "pacote-foody-147-149");
  mkdirSync(saida, { recursive: true });
  const { arquivos, sha } = gerarPacote();
  for (const [nome, t] of Object.entries(arquivos)) writeFileSync(resolve(saida, nome), t);
  for (const [nome, s] of Object.entries(sha)) console.log(`${s}  ${nome}`);
}
