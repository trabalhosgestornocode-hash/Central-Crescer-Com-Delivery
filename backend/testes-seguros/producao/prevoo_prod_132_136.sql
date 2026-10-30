-- PRÉ-VOO de PRODUÇÃO (uqybgauuxcrqzquultfu) para 132–136 — SOMENTE LEITURA (sessão com default_transaction_read_only=on).
-- Não referencia nenhuma coluna/tabela/função criada por 132–136 (podem não existir): só catálogos e objetos da main.
-- Uma linha, um JSON. Sem dado pessoal: telefones, nomes e conteúdos entram só como hash.
with fn as (select p.oid, p.proname, md5(pg_get_functiondef(p.oid)) h, pg_get_functiondef(p.oid) d
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f'),
novas_tabelas(t) as (values ('usuarios_convites'), ('comunicacao_legado_snapshot'), ('comunicacao_destinatario_escopos'), ('comunicacao_termos'),
                            ('comunicacao_convites'), ('comunicacao_desafios_titular'), ('comunicacao_consentimentos')),
novas_funcoes(f) as (values ('unidades_validar_fuso_horario'), ('usuarios_convite_consumir'), ('usuarios_convites_coerencia'),
  ('comunicacao_ativar_selecao_por_escopo'), ('comunicacao_desativar_selecao_por_escopo'), ('comunicacao_escopo_gestor_permitido'),
  ('comunicacao_escopo_preferencias'), ('comunicacao_escopo_suspender'), ('comunicacao_escopos_coerencia'), ('comunicacao_faixa_horaria_valida'),
  ('comunicacao_legado_vincular_unidade'), ('comunicacao_registro_imutavel'), ('comunicacao_resolver_destinatarios_por_escopo'),
  ('comunicacao_resolver_destinatarios_unidade'), ('comunicacao_selecao_por_escopo_ligada'), ('comunicacao_bloquear_reativacao_revogada'),
  ('comunicacao_consentimento_vigente'), ('comunicacao_convites_coerencia'), ('comunicacao_desafio_criar'), ('comunicacao_desafio_verificar'),
  ('comunicacao_revogar'), ('comunicacao_titular_consentir'), ('comunicacao_cota_categoria_disponivel'), ('comunicacao_cota_valida')),
novos_gatilhos(g) as (values ('trg_unidades_validar_fuso_horario'), ('trg_usuarios_convites_coerencia'), ('trg_comunicacao_escopos_coerencia'),
  ('trg_comunicacao_legado_snapshot_imutavel'), ('trg_comunicacao_consentimentos_imutavel'), ('trg_comunicacao_convites_coerencia'),
  ('trg_comunicacao_dest_cat_revogada'), ('trg_comunicacao_escopo_revogada'), ('trg_comunicacao_termos_imutavel')),
novas_colunas(t, c) as (values ('unidades','timezone'), ('unidades','horario_funcionamento'), ('comunicacao_categorias','estado'),
  ('comunicacao_categorias','exige_consentimento'), ('comunicacao_categorias','grupo'), ('comunicacao_categorias','ordem'),
  ('comunicacao_categorias','prioridade'), ('comunicacao_categorias','transporte'), ('comunicacao_categorias','cota'))
select jsonb_build_object(
  'identidade', jsonb_build_object('db', current_database(), 'usuario', current_user, 'versao', current_setting('server_version'),
     'sistema_id', (select system_identifier from pg_control_system()), 'agora_utc', now() at time zone 'utc',
     'replica', pg_is_in_recovery(), 'somente_leitura', current_setting('default_transaction_read_only'),
     'tamanho_banco', pg_size_pretty(pg_database_size(current_database()))),
  'migrations', jsonb_build_object(
     'registradas', (select count(*) from supabase_migrations.schema_migrations),
     'ultimas', (select jsonb_agg(v || ' ' || coalesce(n, '')) from (select version v, name n from supabase_migrations.schema_migrations order by version desc limit 8) x),
     'ja_registradas_132_136', (select count(*) from supabase_migrations.schema_migrations where name ~ '^13[2-6]_')),
  'ausencia_132_136', jsonb_build_object(
     'tabelas', (select coalesce(jsonb_agg(t), '[]') from novas_tabelas where to_regclass('public.' || t) is not null),
     'funcoes', (select coalesce(jsonb_agg(f), '[]') from novas_funcoes where exists (select 1 from fn where proname = f)),
     'gatilhos', (select coalesce(jsonb_agg(g), '[]') from novos_gatilhos where exists (select 1 from pg_trigger where tgname = g)),
     'colunas', (select coalesce(jsonb_agg(t || '.' || c), '[]') from novas_colunas where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = c)),
     'chave_selecao_por_escopo', (select count(*) from comunicacao_configuracoes where chave = 'selecao_por_escopo')),
  'dependencias', jsonb_build_object(
     'tabelas_base', (select jsonb_object_agg(t, to_regclass('public.' || t) is not null) from (values ('unidades'), ('comunicacao_categorias'), ('comunicacao_configuracoes'),
        ('comunicacao_destinatario_categorias'), ('comunicacao_contatos_empresa'), ('contatos_whatsapp'), ('comunicacao_mensagens'), ('comunicacao_alertas'),
        ('usuarios_organizacoes'), ('perfis_operacionais'), ('organizacoes'), ('plataforma_auditoria')) b(t)),
     'agendar_md5', (select h from fn where proname = 'comunicacao_agendar_mensagens_alerta'),
     'agendar_igual_main_104', (select h = 'f37bf6e1e459864ffa61a39a1712df64' from fn where proname = 'comunicacao_agendar_mensagens_alerta'),
     'resolver_md5', (select h from fn where proname = 'comunicacao_resolver_destinatarios'),
     'resolver_igual_ref', (select h = 'accc3bc647599c6a7f6cd99b3afd2a90' from fn where proname = 'comunicacao_resolver_destinatarios'),
     'cota_md5', (select h from fn where proname = 'comunicacao_reservar_envio'),
     'cota_igual_ref', (select h = '0b6386a2369f1f9f3caebfb27c581378' from fn where proname = 'comunicacao_reservar_envio'),
     'remapear_md5', (select h from fn where proname = 'remapear_organizacao_em_tabelas_de_unidade'),
     'remapear_igual_ref', (select h = '31426ffd7848e8455944399caf021075' from fn where proname = 'remapear_organizacao_em_tabelas_de_unidade'),
     'transferir_md5', (select h from fn where proname = 'transferir_unidade_organizacao'),
     'funcoes_com_cr', (select count(*) from fn where position(chr(13) in d) > 0)),
  'impressao', jsonb_build_object(
     'colunas', (select md5(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || coalesce(column_default, '') || ':' || is_nullable, ';' order by table_name, column_name)) from information_schema.columns where table_schema = 'public'),
     'funcoes', (select md5(string_agg(proname || ':' || h, ';' order by proname, h)) from fn),
     'acl_funcoes', (select md5(string_agg(p.proname || ':' || coalesce(p.proacl::text, ''), ';' order by p.proname, p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
     'gatilhos', (select md5(string_agg(pg_get_triggerdef(t.oid), ';' order by pg_get_triggerdef(t.oid))) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal),
     'politicas', (select md5(string_agg(tablename || ':' || policyname || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ';' order by tablename, policyname)) from pg_policies where schemaname = 'public'),
     'acl_rls', (select md5(string_agg(c.relname || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity, ';' order by c.relname)) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v','m','p')),
     'n_tabelas', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p')),
     'n_funcoes', (select count(*) from fn)),
  'unidades', jsonb_build_object(
     'gatilhos', (select jsonb_agg(tgname order by tgname) from pg_trigger where tgrelid = 'public.unidades'::regclass and not tgisinternal),
     'politicas', (select jsonb_agg(policyname || ':' || cmd || ':' || roles::text order by policyname) from pg_policies where schemaname = 'public' and tablename = 'unidades'),
     'guarda_financeiro_md5', (select md5(pg_get_triggerdef(oid)) from pg_trigger where tgrelid = 'public.unidades'::regclass and tgname = 'trg_unidades_guarda_financeiro'),
     'linhas', (select count(*) from unidades), 'ativas', (select count(*) from unidades where ativo),
     'hash_sem_colunas_novas', (select md5(coalesce(string_agg((to_jsonb(u) - 'timezone' - 'horario_funcionamento')::text, ';' order by u.id), '')) from unidades u)),
  'financeiro', jsonb_build_object(
     'tabelas', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and (c.relname like 'gestao_financeira%' or c.relname like 'fin\_%')),
     'migrations_120_131', (select coalesce(jsonb_agg(name order by version), '[]') from supabase_migrations.schema_migrations where name ~ '^1(2[0-9]|3[01])_'),
     'gfc_validar_126', (select position('plataforma_admins' in d) > 0 from fn where proname = 'gfc_validar')),
  'd1_linha_de_base', jsonb_build_object(
     'configuracoes', (select jsonb_object_agg(chave, valor) from comunicacao_configuracoes where chave in ('modo', 'janelas', 'cooldowns_horas', 'limites', 'ttl_horas', 'disponibilidade_ifood', 'jitter_max_minutos', 'destinatarios')),
     'configuracoes_chaves', (select jsonb_agg(chave order by chave) from comunicacao_configuracoes),
     'configuracoes_hash_sem_chave_nova', (select md5(coalesce(string_agg(chave || '=' || valor::text, ';' order by chave), '')) from comunicacao_configuracoes where chave <> 'selecao_por_escopo'),
     'categorias_ativas', (select jsonb_agg(jsonb_build_object('codigo', codigo, 'tipo', tipo_alerta) order by codigo) from comunicacao_categorias where ativo),
     'dest_categorias', (select md5(coalesce(string_agg(to_jsonb(d)::text, ';' order by to_jsonb(d)::text), '')) || ':' || count(*) from comunicacao_destinatario_categorias d),
     'contatos_empresa', (select md5(coalesce(string_agg(to_jsonb(ce)::text, ';' order by ce.id), '')) || ':' || count(*) from comunicacao_contatos_empresa ce),
     'contatos_whatsapp', (select md5(coalesce(string_agg(to_jsonb(w)::text, ';' order by w.id), '')) || ':' || count(*) from contatos_whatsapp w),
     'mensagens_por_status', (select jsonb_object_agg(status, n) from (select status, count(*) n from comunicacao_mensagens group by status) s),
     'mensagens_tipo_d1_7d', (select count(*) from comunicacao_mensagens m join comunicacao_alertas a on a.id = m.alerta_id where a.tipo_alerta = 'dashboard_ifood_d1' and m.disponivel_em > now() - interval '7 days'),
     'mensagens_ultimas_2h', (select count(*) from comunicacao_mensagens where coalesce(enviado_em, disponivel_em) > now() - interval '2 hours'),
     'pendentes_proximas_24h', (select count(*) from comunicacao_mensagens where status in ('SCHEDULED', 'PROCESSING', 'SENDING') and disponivel_em < now() + interval '24 hours'),
     'proxima_disponivel_utc', (select min(disponivel_em) at time zone 'utc' from comunicacao_mensagens where status in ('SCHEDULED', 'PROCESSING')),
     'ultima_enviada_utc', (select max(enviado_em) at time zone 'utc' from comunicacao_mensagens),
     'envios_d1_por_hora_utc_14d', (select jsonb_object_agg(h, n) from (select extract(hour from enviado_em at time zone 'utc')::int h, count(*) n from comunicacao_mensagens m join comunicacao_alertas a on a.id = m.alerta_id
                                     where a.tipo_alerta = 'dashboard_ifood_d1' and m.enviado_em > now() - interval '14 days' group by 1) x),
     'indice_idempotencia', (select jsonb_agg(indexname) from pg_indexes where schemaname = 'public' and tablename = 'comunicacao_mensagens' and indexdef ilike '%unique%idempotency_key%'),
     'agendar_contem_d1', (select position('dashboard_ifood_d1' in d) > 0 or position('tipo_alerta' in d) > 0 from fn where proname = 'comunicacao_agendar_mensagens_alerta')),
  'sessoes', jsonb_build_object(
     'por_estado', (select jsonb_object_agg(coalesce(state, 'nulo'), n) from (select state, count(*) n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() group by state) s),
     'por_aplicacao', (select jsonb_object_agg(coalesce(nullif(application_name, ''), '(vazio)'), n) from (select application_name, count(*) n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() group by 1) s),
     'transacao_mais_longa_s', (select coalesce(max(extract(epoch from now() - xact_start))::int, 0) from pg_stat_activity where datname = current_database() and xact_start is not null and pid <> pg_backend_pid()),
     'idle_in_transaction', (select count(*) from pg_stat_activity where state like 'idle in transaction%'),
     'locks_nas_tabelas_alvo', (select coalesce(jsonb_agg(distinct c.relname || ':' || l.mode), '[]') from pg_locks l join pg_class c on c.oid = l.relation
         where c.relname in ('unidades', 'comunicacao_categorias', 'comunicacao_configuracoes', 'comunicacao_destinatario_categorias', 'comunicacao_contatos_empresa', 'comunicacao_mensagens')
           and l.pid <> pg_backend_pid()),
     'aguardando_lock', (select count(*) from pg_stat_activity where wait_event_type = 'Lock')),
  'recuperacao', jsonb_build_object(
     'wal_level', current_setting('wal_level'),
     'archive_mode', current_setting('archive_mode'),
     'arquivamento', (select jsonb_build_object('arquivados', archived_count, 'ultimo_utc', last_archived_time at time zone 'utc', 'falhas', failed_count,
                       'ultima_falha_utc', last_failed_time at time zone 'utc') from pg_stat_archiver))
) as prevoo_producao;
