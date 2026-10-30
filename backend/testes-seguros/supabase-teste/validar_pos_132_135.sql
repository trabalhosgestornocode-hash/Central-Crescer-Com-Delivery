-- Validação SÓ LEITURA depois de aplicar 132–135 no Supabase de TESTE. Uma linha, um JSON: cada item traz `ok` e o valor medido.
-- Referências (antes da aplicação, 30/10/2026): ver docs/configuracoes-2-notificacoes/14-preflight-implantacao-recuperacao.md §4.
with novas(t) as (values ('usuarios_convites'), ('comunicacao_legado_snapshot'), ('comunicacao_destinatario_escopos'), ('comunicacao_termos'),
                        ('comunicacao_convites'), ('comunicacao_desafios_titular'), ('comunicacao_consentimentos')),
fn as (select p.proname, md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
fn_novas as (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  and p.proname ~ '^(comunicacao_(ativar|desativar|escopo|legado|desafio|titular|revogar|resolver_destinatarios_(unidade|por_escopo)|cota|selecao|faixa|registro_imutavel|consentimento|bloquear|convites)|usuarios_convite|unidades_validar)'),
pares as (select u.organizacao_id org, u.id un from unidades u where u.ativo and not coalesce(u.eh_teste, false)),
d1 as (select count(*) filter (where comunicacao_resolver_destinatarios_unidade(org, un, 'dashboard_ifood_d1')
                                      is distinct from comunicacao_resolver_destinatarios(org, 'dashboard_ifood_d1')) divergentes, count(*) total from pares)
select jsonb_build_object(
  'agendar_uma_linha', (select jsonb_build_object('ok', h = '7b7c0a59654ab29890187c5727c91419', 'md5', h) from fn where proname = 'comunicacao_agendar_mensagens_alerta'),
  'resolver_intacto', (select jsonb_build_object('ok', h = 'accc3bc647599c6a7f6cd99b3afd2a90', 'md5', h) from fn where proname = 'comunicacao_resolver_destinatarios'),
  'cota_d1_intacta', (select jsonb_build_object('ok', h = '0b6386a2369f1f9f3caebfb27c581378', 'md5', h) from fn where proname = 'comunicacao_reservar_envio'),
  'transferencia_intacta', (select jsonb_build_object('ok', h = '31426ffd7848e8455944399caf021075', 'md5', h) from fn where proname = 'remapear_organizacao_em_tabelas_de_unidade'),
  'tabelas_novas_com_rls', (select jsonb_build_object('ok', count(*) filter (where c.relrowsecurity) = 7, 'n', count(*) filter (where c.relrowsecurity))
                            from novas join pg_class c on c.relname = novas.t join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'),
  'anon_auth_sem_tabela', (select jsonb_build_object('ok', count(*) = 0, 'com_privilegio', coalesce(jsonb_agg(t), '[]'))
                           from novas where has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE')
                                         or has_table_privilege('authenticated', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE')),
  'anon_auth_sem_funcao', (select jsonb_build_object('ok', count(*) = 0, 'n', count(*)) from fn_novas
                           where has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE')),
  'imutaveis_sem_update_delete', jsonb_build_object('ok', not has_table_privilege('service_role', 'public.comunicacao_legado_snapshot', 'UPDATE,DELETE')
                                                      and not has_table_privilege('service_role', 'public.comunicacao_consentimentos', 'UPDATE,DELETE')),
  'selecao_por_unidade_desligada', jsonb_build_object('ok', not exists (select 1 from comunicacao_configuracoes where chave = 'selecao_por_escopo' and (valor->>'ligada')::boolean)),
  'snapshot_vazio', jsonb_build_object('ok', (select count(*) from comunicacao_legado_snapshot) = 0),
  'd1_equivalente_todas_unidades', (select jsonb_build_object('ok', divergentes = 0, 'divergentes', divergentes, 'unidades', total) from d1),
  'legados_intocados', jsonb_build_object('ok',
     (select md5(coalesce(string_agg(to_jsonb(d)::text, ';' order by to_jsonb(d)::text), '')) || ':' || count(*) from comunicacao_destinatario_categorias d) = 'da42b07d9473fc7ed64203626b154f3e:2'
     and (select md5(coalesce(string_agg(to_jsonb(ce)::text, ';' order by ce.id), '')) || ':' || count(*) from comunicacao_contatos_empresa ce) = '0aae55a5d35cfad5bafe302ee55fbba8:3'
     and (select md5(coalesce(string_agg(to_jsonb(w)::text, ';' order by w.id), '')) || ':' || count(*) from contatos_whatsapp w) = '806f6d693ebe6091606e37e88dd40416:50'),
  'unidades_intocadas_fora_colunas_novas', jsonb_build_object('ok',
     (select md5(coalesce(string_agg((to_jsonb(u) - 'timezone' - 'horario_funcionamento')::text, ';' order by u.id), '')) || ':' || count(*) from unidades u) = '9d39449f33bacb82212719222a1f2e38:30'),
  'fila_d1_intocada', jsonb_build_object('ok', (select count(*) from comunicacao_mensagens) = 3)
) as validacao;
