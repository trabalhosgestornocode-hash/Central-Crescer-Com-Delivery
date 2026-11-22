-- MOVA — INVENTÁRIO SOMENTE LEITURA (gerado por backend/scripts/mova/pacoteProducao.mjs). Rodar ANTES e DEPOIS da instalação.
-- Não altera nada. Não lê conteúdo de mensagens: só existência, contagens, permissões e marcadores.
select 'banco' as item, current_database() as valor, shobj_description(d.oid, 'pg_database') as detalhe from pg_database d where d.datname = current_database()
union all select 'versao', current_setting('server_version'), null
union all select 'executor', current_user, (select case when rolsuper then 'superusuario' else 'comum' end from pg_roles where rolname = current_user)
union all select 'schema_mova', coalesce((select 'EXISTE' from pg_namespace where nspname = 'mova'), 'AUSENTE'), (select obj_description(oid, 'pg_namespace') from pg_namespace where nspname = 'mova')
union all select 'papel_mova_app', coalesce((select case when rolcanlogin then 'COM_LOGIN' else 'SEM_LOGIN' end from pg_roles where rolname = 'mova_app'), 'AUSENTE'), null
union all select 'logins_membros_de_mova_app', coalesce((select string_agg(r.rolname, ', ') from pg_auth_members m join pg_roles r on r.oid = m.member join pg_roles g on g.oid = m.roleid where g.rolname = 'mova_app'), '(nenhum)'), null
union all select 'publicacoes_for_all_tables', coalesce((select string_agg(pubname, ', ') from pg_publication where puballtables), '(nenhuma)'), null
union all select 'tabelas_mova', (select count(*)::text from pg_tables where schemaname = 'mova'), null
union all select 'conexoes_ativas_no_banco', (select count(*)::text from pg_stat_activity where datname = current_database()), null
union all select 'migracao_em_curso', coalesce((select string_agg(left(query, 60), ' | ') from pg_stat_activity where datname = current_database() and state = 'active' and query ~* '(create|alter|drop) (table|schema|role)' and pid <> pg_backend_pid()), '(nenhuma)'), null;
-- Depois da instalação: select nome, sha256, aplicada_em from mova.mova_migracao order by nome;
