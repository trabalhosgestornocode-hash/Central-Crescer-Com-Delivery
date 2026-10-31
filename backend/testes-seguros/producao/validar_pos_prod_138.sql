-- Validação PÓS da migration 138 (SOMENTE LEITURA). Devolve um JSON { item: { ok: bool, ... } }; tudo precisa de ok = true.
-- Hashes de referência (UTF-8, blob versionado 96c54654…): gerados num PostgreSQL descartável com a cadeia real e conferidos no Supabase de teste.
with ref as (select
    '62dcba428f776637d4a4405de047dff0'::text as fn_reservar, 'ed17f9aa52fe6c603bc88533c152b6bf'::text as fn_resultado,
    '5a4b0d50b73ac4874a1cc39adc3ebdb6'::text as colunas, 'e3cb198dc3d85b709209d7ae3b571a18'::text as restricoes),
atual as (select
    md5(pg_get_functiondef('comunicacao_otp_reservar(uuid,integer,integer,integer)'::regprocedure)) as fn_reservar,
    md5(pg_get_functiondef('comunicacao_otp_registrar_resultado(uuid,text,text)'::regprocedure)) as fn_resultado,
    (select md5(string_agg(column_name||data_type||coalesce(column_default,''),',' order by column_name)) from information_schema.columns where table_name = 'comunicacao_otp_envios') as colunas,
    (select md5(string_agg(pg_get_constraintdef(oid),',' order by conname)) from pg_constraint where conrelid = 'comunicacao_otp_envios'::regclass) as restricoes)
select jsonb_build_object(
  'funcao_reservar_identica', jsonb_build_object('ok', a.fn_reservar = r.fn_reservar),
  'funcao_resultado_identica', jsonb_build_object('ok', a.fn_resultado = r.fn_resultado),
  'colunas_identicas', jsonb_build_object('ok', a.colunas = r.colunas),
  'restricoes_identicas', jsonb_build_object('ok', a.restricoes = r.restricoes),
  'rls_ligada_sem_politica', jsonb_build_object('ok', (select relrowsecurity from pg_class where relname = 'comunicacao_otp_envios') and not exists (select 1 from pg_policies where tablename = 'comunicacao_otp_envios')),
  'anon_authenticated_sem_acesso', jsonb_build_object('ok',
      not has_table_privilege('anon', 'comunicacao_otp_envios', 'select') and not has_table_privilege('authenticated', 'comunicacao_otp_envios', 'select')
      and not has_table_privilege('anon', 'comunicacao_otp_envios', 'insert') and not has_table_privilege('authenticated', 'comunicacao_otp_envios', 'insert')
      and not has_function_privilege('anon', 'comunicacao_otp_reservar(uuid,integer,integer,integer)', 'execute')
      and not has_function_privilege('authenticated', 'comunicacao_otp_reservar(uuid,integer,integer,integer)', 'execute')
      and not has_function_privilege('anon', 'comunicacao_otp_registrar_resultado(uuid,text,text)', 'execute')
      and not has_function_privilege('authenticated', 'comunicacao_otp_registrar_resultado(uuid,text,text)', 'execute')),
  'service_role_minimo', jsonb_build_object('ok',
      has_function_privilege('service_role', 'comunicacao_otp_reservar(uuid,integer,integer,integer)', 'execute')
      and has_function_privilege('service_role', 'comunicacao_otp_registrar_resultado(uuid,text,text)', 'execute')
      and has_table_privilege('service_role', 'comunicacao_otp_envios', 'select') and has_table_privilege('service_role', 'comunicacao_otp_envios', 'insert')
      and not has_table_privilege('service_role', 'comunicacao_otp_envios', 'delete') and not has_table_privilege('service_role', 'comunicacao_otp_envios', 'truncate')),
  'sem_dado_sensivel', jsonb_build_object('ok', not exists (select 1 from information_schema.columns where table_name = 'comunicacao_otp_envios' and column_name ~ '(telefone|codigo|texto|conteudo|numero)')),
  'reservas_informativo', jsonb_build_object('ok', true, 'linhas', (select count(*) from comunicacao_otp_envios)),
  'desafios_informativo', jsonb_build_object('ok', true, 'desafios', (select count(*) from comunicacao_desafios_titular)),
  'fila_d1_intacta_tabela', jsonb_build_object('ok', to_regclass('public.comunicacao_mensagens') is not null and not exists (select 1 from pg_trigger where tgrelid = 'comunicacao_otp_envios'::regclass and not tgisinternal))
) as validacao
from atual a, ref r;
