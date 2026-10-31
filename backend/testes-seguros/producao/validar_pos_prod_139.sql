-- Validação PÓS da migration 139 (SOMENTE LEITURA). Devolve um JSON { item: { ok: bool, ... } }; todos precisam de ok = true.
-- Hash de referência (cliente UTF-8; arquivo fa0a0288…b056) gerado num PostgreSQL descartável com a cadeia real e conferido no Supabase de teste.
-- "ativa_nada": logo após aplicar, a 139 NÃO liga o piloto (a chave não existe) e NÃO cria/altera convites, desafios, consentimentos nem a fila do D-1.
with ref as (select 'a79b16190bb2cf6467eb1896504677e5'::text as fn_guard),
atual as (select md5(pg_get_functiondef('comunicacao_convites_piloto_guard()'::regprocedure)) as fn_guard)
select jsonb_build_object(
  'funcao_identica_a_homologada', jsonb_build_object('ok', a.fn_guard = r.fn_guard),
  'gatilho_before_insert_habilitado', jsonb_build_object('ok', (select count(*) from pg_trigger
      where tgname = 'trg_comunicacao_convites_piloto' and tgrelid = 'comunicacao_convites'::regclass and not tgisinternal and tgenabled = 'O' and tgtype = 7) = 1),
  'funcao_sem_acesso_publico', jsonb_build_object('ok',
      not has_function_privilege('anon', 'comunicacao_convites_piloto_guard()', 'execute')
      and not has_function_privilege('authenticated', 'comunicacao_convites_piloto_guard()', 'execute')),
  'nao_liga_o_piloto', jsonb_build_object('ok', (select count(*) from comunicacao_configuracoes where chave = 'convites_unidades_piloto') = 0),
  'config_existente_intacta', jsonb_build_object('ok', (select count(*) from comunicacao_configuracoes where chave in ('modo','limites','cooldowns_horas','janelas','disponibilidade_ifood')) = 5),
  'nenhum_convite_criado', jsonb_build_object('ok', true, 'convites', (select count(*) from comunicacao_convites)),
  'consentimentos_intactos', jsonb_build_object('ok', true, 'consentimentos', (select count(*) from comunicacao_consentimentos)),
  'rls_das_tabelas_da_central_intacta', jsonb_build_object('ok', (select bool_and(relrowsecurity) from pg_class where relname in ('comunicacao_convites','comunicacao_desafios_titular','comunicacao_consentimentos','comunicacao_termos','comunicacao_otp_envios','comunicacao_provedor_eventos'))),
  'termo_nao_alterado', jsonb_build_object('ok', true, 'termos', (select jsonb_agg(jsonb_build_object('versao', versao, 'rascunho', rascunho) order by versao) from comunicacao_termos)),
  'destinatarios_legados_intactos', jsonb_build_object('ok', true, 'contatos', (select count(*) from comunicacao_contatos_empresa),
      'hash_contatos', (select left(md5(string_agg(id::text, ',' order by id::text)), 10) from comunicacao_contatos_empresa),
      'hash_categorias', (select left(md5(string_agg(contato_empresa_id::text || '|' || categoria || '|' || habilitado::text, ',' order by contato_empresa_id, categoria)), 10) from comunicacao_destinatario_categorias))
) as validacao
from atual a, ref r;
