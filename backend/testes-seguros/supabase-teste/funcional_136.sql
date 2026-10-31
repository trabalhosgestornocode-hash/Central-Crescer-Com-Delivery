-- 136 · TESTES FUNCIONAIS no Supabase de TESTE. Um bloco que TERMINA EM ERRO PROPOSITAL: nada fica gravado.
-- O resultado vem na mensagem do erro "RESULTADO_136 {...}". Sessão do PostgREST simulada como ele faz: SET ROLE + request.jwt.claims.
do $$
declare
  r jsonb := '{}'; oa uuid; ua uuid; ma uuid; ob uuid; ub uuid; n int; v text; tz_ub text;
begin
  select u.organizacao_id, u.id into oa, ua from unidades u
   where u.ativo and exists (select 1 from usuarios_organizacoes x where x.organizacao_id = u.organizacao_id and x.ativo)
   order by u.id limit 1;
  select x.usuario_id into ma from usuarios_organizacoes x where x.organizacao_id = oa and x.ativo order by x.usuario_id limit 1;
  select u.organizacao_id, u.id into ob, ub from unidades u
   where u.organizacao_id not in (select organizacao_id from usuarios_organizacoes where usuario_id = ma and ativo)
   order by u.ativo desc, u.id limit 1;
  if ua is null or ma is null or ub is null then
    raise exception 'MASSA_INSUFICIENTE org_a=% unidade_a=% membro_a=% unidade_b=%', oa, ua, ma, ub;
  end if;
  select timezone into tz_ub from unidades where id = ub;
  r := jsonb_build_object('massa', jsonb_build_object('org_a', oa, 'unidade_a', ua, 'membro_a', ma, 'org_b', ob, 'unidade_b', ub));

  -- ===== authenticated (membro da empresa A), como o PostgREST =====
  perform set_config('request.jwt.claims', json_build_object('sub', ma, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', ma::text, true);
  execute 'set local role authenticated';
  r := r || jsonb_build_object('t00_superadmin', is_platform_superadmin(),
                               't00_ve_unidade_a', (select count(*) from unidades where id = ua),
                               't00_ve_unidade_b', (select count(*) from unidades where id = ub));
  begin update unidades set timezone = 'America/Manaus' where id = ua; get diagnostics n = row_count; r := r || jsonb_build_object('t01_auth_fuso_propria', 'FALHA: gravou ' || n);
  exception when others then r := r || jsonb_build_object('t01_auth_fuso_propria', sqlstate || ' ' || sqlerrm); end;
  begin update unidades set horario_funcionamento = '{"seg":[{"inicio":"10:00","fim":"22:00"}]}' where id = ua; get diagnostics n = row_count; r := r || jsonb_build_object('t02_auth_horario_propria', 'FALHA: gravou ' || n);
  exception when others then r := r || jsonb_build_object('t02_auth_horario_propria', sqlstate || ' ' || sqlerrm); end;
  begin update unidades set timezone = 'America/Sao_Paulo', nome = nome where id = ua; get diagnostics n = row_count; r := r || jsonb_build_object('t03_auth_fuso_junto_outra_coluna', 'FALHA: gravou ' || n);
  exception when others then r := r || jsonb_build_object('t03_auth_fuso_junto_outra_coluna', sqlstate || ' ' || sqlerrm); end;
  begin insert into unidades (organizacao_id, nome, timezone) values (oa, 'zz-136-teste', 'America/Sao_Paulo'); r := r || jsonb_build_object('t04_auth_insert_com_fuso', 'FALHA: inseriu');
  exception when others then r := r || jsonb_build_object('t04_auth_insert_com_fuso', sqlstate || ' ' || sqlerrm); end;
  begin update unidades set nome = nome where id = ua; get diagnostics n = row_count; r := r || jsonb_build_object('t05_auth_outra_coluna_propria', 'linhas ' || n);
  exception when others then r := r || jsonb_build_object('t05_auth_outra_coluna_propria', sqlstate || ' ' || sqlerrm); end;
  begin update unidades set timezone = timezone, horario_funcionamento = horario_funcionamento where id = ua; get diagnostics n = row_count; r := r || jsonb_build_object('t06_auth_fuso_sem_mudanca', 'linhas ' || n);
  exception when others then r := r || jsonb_build_object('t06_auth_fuso_sem_mudanca', sqlstate || ' ' || sqlerrm); end;
  begin update unidades set nome = nome where id = ub; get diagnostics n = row_count; r := r || jsonb_build_object('t07_auth_outra_empresa_nome', 'linhas ' || n);
  exception when others then r := r || jsonb_build_object('t07_auth_outra_empresa_nome', sqlstate || ' ' || sqlerrm); end;
  begin update unidades set timezone = 'America/Manaus' where id = ub; get diagnostics n = row_count; r := r || jsonb_build_object('t08_auth_outra_empresa_fuso', 'linhas ' || n);
  exception when others then r := r || jsonb_build_object('t08_auth_outra_empresa_fuso', sqlstate || ' ' || sqlerrm); end;
  execute 'reset role';

  -- ===== anon =====
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
  begin update unidades set timezone = 'America/Manaus' where id = ua; get diagnostics n = row_count; r := r || jsonb_build_object('t09_anon_fuso', 'linhas ' || n);
  exception when others then r := r || jsonb_build_object('t09_anon_fuso', sqlstate || ' ' || sqlerrm); end;
  execute 'reset role';

  -- ===== service_role (backend autorizado) =====
  execute 'set local role service_role';
  begin update unidades set timezone = 'America/Manaus', horario_funcionamento = '{"seg":[{"inicio":"10:00","fim":"22:00"}]}' where id = ua returning timezone into v;
        r := r || jsonb_build_object('t10_backend_grava_fuso_horario', coalesce(v, 'nulo'));
  exception when others then r := r || jsonb_build_object('t10_backend_grava_fuso_horario', 'FALHA ' || sqlstate || ' ' || sqlerrm); end;
  begin update unidades set timezone = 'Marte/Base' where id = ua; r := r || jsonb_build_object('t11_backend_fuso_invalido', 'FALHA: aceitou');
  exception when others then r := r || jsonb_build_object('t11_backend_fuso_invalido', sqlstate || ' ' || sqlerrm); end;
  begin update unidades set horario_funcionamento = '{"xyz":[]}' where id = ua; r := r || jsonb_build_object('t12_backend_horario_invalido', 'FALHA: aceitou');
  exception when others then r := r || jsonb_build_object('t12_backend_horario_invalido', sqlstate || ' ' || sqlerrm); end;
  begin
    r := r || jsonb_build_object('t13_transferencia', transferir_unidade_organizacao(ua, ob, ma, 'homologacao-136@teste', null, 'homologacao-136'));
    r := r || jsonb_build_object('t14_pos_transferencia', (select jsonb_build_object('org_nova_ok', organizacao_id = ob, 'fuso_preservado', timezone, 'horario_preservado', horario_funcionamento is not null) from unidades where id = ua));
  exception when others then r := r || jsonb_build_object('t13_transferencia', 'ERRO ' || sqlstate || ' ' || sqlerrm); end;
  execute 'reset role';

  -- ===== dono/migration (postgres) =====
  begin update unidades set timezone = 'America/Sao_Paulo' where id = ub returning timezone into v; r := r || jsonb_build_object('t15_migration_grava', v);
  exception when others then r := r || jsonb_build_object('t15_migration_grava', 'FALHA ' || sqlstate || ' ' || sqlerrm); end;

  raise exception 'RESULTADO_136 %', r;
end $$;
