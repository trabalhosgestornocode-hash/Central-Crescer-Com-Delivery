-- Validação SÓ LEITURA depois de aplicar o pacote 132–136 em PRODUÇÃO. Uma linha, um JSON: cada item traz `ok` e o valor medido.
-- Estrutural e D-1 aqui; DADOS: rodar de novo prevoo_prod_132_136.sql e comparar com o pré-voo capturado logo antes da aplicação
-- (unidades sem as colunas novas, destinatários, contatos, configurações sem a chave nova, categorias ativas, fila).
with novas(t) as (values ('usuarios_convites'), ('comunicacao_legado_snapshot'), ('comunicacao_destinatario_escopos'), ('comunicacao_termos'),
                        ('comunicacao_convites'), ('comunicacao_desafios_titular'), ('comunicacao_consentimentos')),
fn as (select p.oid, p.proname, md5(pg_get_functiondef(p.oid)) h, pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
fn_novas as (select oid, d from fn
  where proname ~ '^(comunicacao_(ativar|desativar|escopo|legado|desafio|titular|revogar|resolver_destinatarios_(unidade|por_escopo)|cota|selecao|faixa|registro_imutavel|consentimento|bloquear|convites)|usuarios_convite|unidades_validar)'),
pares as (select u.organizacao_id org, u.id un from unidades u where u.ativo and not coalesce(u.eh_teste, false)),
d1 as (select count(*) filter (where comunicacao_resolver_destinatarios_unidade(org, un, 'dashboard_ifood_d1')
                                      is distinct from comunicacao_resolver_destinatarios(org, 'dashboard_ifood_d1')) divergentes, count(*) total from pares)
select jsonb_build_object(
  'registro_5_migrations', (select jsonb_build_object('ok', count(*) = 5, 'nomes', jsonb_agg(name order by version)) from supabase_migrations.schema_migrations where name ~ '^13[2-6]_'),
  'f136_md5', (select jsonb_build_object('ok', h = '10a2368ac4a867a3362e28271216560b', 'md5', h) from fn where proname = 'unidades_validar_fuso_horario'),
  'f136_exec_so_dono', (select jsonb_build_object('ok', not has_function_privilege('anon', oid, 'EXECUTE') and not has_function_privilege('authenticated', oid, 'EXECUTE')
                                                     and not has_function_privilege('service_role', oid, 'EXECUTE')) from fn where proname = 'unidades_validar_fuso_horario'),
  'funcoes_novas_sem_cr', (select jsonb_build_object('ok', count(*) filter (where position(chr(13) in d) > 0) = 0, 'n', count(*)) from fn_novas),
  'agendar_uma_linha', (select jsonb_build_object('ok', h = '7b7c0a59654ab29890187c5727c91419', 'md5', h) from fn where proname = 'comunicacao_agendar_mensagens_alerta'),
  'resolver_intacto', (select jsonb_build_object('ok', h = 'accc3bc647599c6a7f6cd99b3afd2a90', 'md5', h) from fn where proname = 'comunicacao_resolver_destinatarios'),
  'cota_d1_intacta', (select jsonb_build_object('ok', h = '0b6386a2369f1f9f3caebfb27c581378', 'md5', h) from fn where proname = 'comunicacao_reservar_envio'),
  'transferencia_intacta', (select jsonb_build_object('ok', h = '31426ffd7848e8455944399caf021075', 'md5', h) from fn where proname = 'remapear_organizacao_em_tabelas_de_unidade'),
  'transferir_intacta', (select jsonb_build_object('ok', h = '9c522caa1940ae6e3f622cf6a24721b2', 'md5', h) from fn where proname = 'transferir_unidade_organizacao'),
  'tabelas_novas_com_rls', (select jsonb_build_object('ok', count(*) filter (where c.relrowsecurity) = 7, 'n', count(*) filter (where c.relrowsecurity))
                            from novas join pg_class c on c.relname = novas.t join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'),
  'anon_auth_sem_tabela', (select jsonb_build_object('ok', count(*) = 0, 'com_privilegio', coalesce(jsonb_agg(t), '[]'))
                           from novas where has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE')
                                         or has_table_privilege('authenticated', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE')),
  'anon_auth_sem_funcao', (select jsonb_build_object('ok', count(*) = 0, 'n', count(*)) from fn_novas
                           where has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE')),
  'imutaveis_sem_update_delete', jsonb_build_object('ok', not has_table_privilege('service_role', 'public.comunicacao_legado_snapshot', 'UPDATE,DELETE')
                                                      and not has_table_privilege('service_role', 'public.comunicacao_consentimentos', 'UPDATE,DELETE')),
  'm3_desligada', jsonb_build_object('ok', not exists (select 1 from comunicacao_configuracoes where chave = 'selecao_por_escopo' and (valor->>'ligada')::boolean)),
  'snapshot_e_escopos_vazios', jsonb_build_object('ok', (select count(*) from comunicacao_legado_snapshot) = 0 and (select count(*) from comunicacao_destinatario_escopos) = 0),
  'categorias_novas_inativas', jsonb_build_object('ok', (select count(*) from comunicacao_categorias where ativo and codigo <> 'pendencia_d1') = 0),
  'nenhuma_unidade_com_fuso', jsonb_build_object('ok', (select count(*) from unidades where timezone is not null or horario_funcionamento is not null) = 0),
  'd1_equivalente_todas_unidades', (select jsonb_build_object('ok', divergentes = 0, 'divergentes', divergentes, 'unidades', total) from d1)
) as validacao_producao;
